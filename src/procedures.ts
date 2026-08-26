/**
 * What a module can ask the collab service to do with a document it owns.
 *
 * The gateway is otherwise write-only from the outside: clients push updates over the socket and
 * nothing else can see them. A module that keeps version history, renders a page nobody has open,
 * restores a version or imports a document needs the state itself, so those five operations are
 * exposed on the procedure broker — in-process here, a NATS request from anywhere else.
 *
 * Yjs state is binary and the broker speaks JSON, so states and snapshots cross this boundary
 * base64-encoded. That is declared once, in `@kernhq/contracts`, and both sides use it.
 */

import { randomUUID } from 'node:crypto'
import type { Server } from '@hocuspocus/server'
import { collabProcedures, type Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type ProcedureDef } from '@kernhq/kernel'
import * as Y from 'yjs'
import { deleteDocument, isEmptyState, loadDocument, parseDocumentName, readDocument } from './documents.js'

/** These procedures hand out document contents, so only another Kern service may call them. */
function requireService(principal: Principal): void {
  if (principal.kind !== 'service' && !principal.instanceAdmin) throw KernError.forbidden()
}

function requireName(name: string) {
  const doc = parseDocumentName(name)
  if (!doc) throw KernError.badRequest(`Malformed document name: ${name}`)
  return doc
}

export interface ProcedureOptions {
  /**
   * True when documents are relayed through Valkey. The instance that answers an RPC is whichever
   * one NATS picked, which is very often not the one holding the document, so a read has to go and
   * ask rather than trusting what is in this process.
   */
  clustered: boolean
}

/**
 * Read a document that this instance does not have open, without writing anything anywhere.
 *
 * Loading it here runs the load hooks, and with the Redis extension configured that load blocks
 * until a peer holding the document replies with its state — so this returns the freshest copy
 * wherever it lives, instead of a row that is up to `COLLAB_DEBOUNCE_MS` behind. When nobody else
 * has the document open the wait is skipped outright, so a lone instance pays a Postgres read and
 * nothing more. Updates that arrive from a peer carry the extension's own transaction origin, which
 * Hocuspocus excludes from the store hooks: the instance that owns those edits is the one that
 * writes them down.
 *
 * Deliberately not `openDirectConnection`. **Every** `DirectConnection.disconnect()` schedules
 * `onStoreDocument` — that is what it is for, since a direct connection exists to write — and
 * `unloadImmediately: false` only postpones it by the debounce. The store hook is what publishes
 * `collab.document.updated`, quire's subscriber for that event calls `collab.document.state`
 * straight back to flatten the prose itself, and a pure read therefore announced itself as an edit
 * and fed itself for as long as the instance ran. `createDocument` is the same load path with no
 * store attached to the way out.
 *
 * The direct-connection counter is what keeps the document from being unloaded underneath the read.
 * It is released before the unload, and `unloadDocument` refuses while anyone is connected, while a
 * store is pending and while the save mutex is held — so this can never take a document away from
 * the people editing it. The unload is not awaited because the extension delays every one of them
 * by `disconnectDelay`, about a second, and quire calls `document.snapshot` from inside an open
 * Postgres transaction.
 */
async function readLoadedDocument<T>(
  kernel: Kernel,
  server: Server,
  name: string,
  read: (doc: Y.Doc) => T,
): Promise<T> {
  const document = await server.hocuspocus.createDocument(
    name,
    new Request('http://localhost'),
    randomUUID(),
    {
      isAuthenticated: true,
      readOnly: true,
    },
  )
  document.addDirectConnection()
  try {
    return read(document)
  } finally {
    document.removeDirectConnection()
    void server.hocuspocus
      .unloadDocument(document)
      .catch((err) =>
        kernel.log.warn({ err, documentName: name }, 'failed to unload a document after a read'),
      )
  }
}

/**
 * The live document if anyone has it open, otherwise the stored state loaded into a detached one.
 * Preferring the live copy matters: persistence is debounced, so the stored state is up to two
 * seconds behind whatever the people currently typing can see — and across instances "anyone" means
 * anyone anywhere, not anyone here.
 */
async function resolveDoc(
  kernel: Kernel,
  server: Server,
  opts: ProcedureOptions,
  name: string,
): Promise<Y.Doc | null> {
  const live = server.hocuspocus.documents.get(name)
  if (live) return live
  if (opts.clustered) {
    // The load hook reads storage too, so this one path covers both a peer's copy and the row.
    const state = await readLoadedDocument(kernel, server, name, (d) => Y.encodeStateAsUpdate(d))
    if (isEmptyState(state)) return null
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    return doc
  }
  const state = await loadDocument(kernel, name)
  if (!state) return null
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc
}

export function createProcedures(
  kernel: Kernel,
  server: Server,
  opts: ProcedureOptions,
): Record<string, ProcedureDef> {
  return {
    'document.state': {
      ...collabProcedures['document.state'],
      handler: async (input: { name: string }, { principal }) => {
        requireService(principal)
        requireName(input.name)
        const stored = await readDocument(kernel, input.name)
        const live = server.hocuspocus.documents.get(input.name)
        if (!live && !opts.clustered) {
          return {
            name: input.name,
            state: stored.state ? Buffer.from(stored.state).toString('base64') : null,
            size: stored.size,
            updatedAt: stored.updatedAt,
          }
        }
        // The live copy wins because persistence is debounced and storage is up to two seconds
        // behind. Across instances the live copy is very often on a peer — this RPC lands wherever
        // NATS put it — so ask for it rather than reading the row. `updatedAt` stays the stored one
        // all the same: it says when this document was last written down, and answering "now"
        // because somebody has the tab open would be a lie a caller deciding whether it already has
        // this version would act on.
        const state = live
          ? Buffer.from(Y.encodeStateAsUpdate(live))
          : Buffer.from(await readLoadedDocument(kernel, server, input.name, (d) => Y.encodeStateAsUpdate(d)))
        if (isEmptyState(state) && !stored.state) {
          return { name: input.name, state: null, size: 0, updatedAt: null }
        }
        return {
          name: input.name,
          state: state.toString('base64'),
          size: state.length,
          updatedAt: stored.updatedAt,
        }
      },
    },

    'document.apply': {
      ...collabProcedures['document.apply'],
      handler: async (input: { name: string; update: string }, { principal }) => {
        requireService(principal)
        requireName(input.name)
        const update = Buffer.from(input.update, 'base64')
        // A direct connection runs the same load and store hooks a browser would, so the update is
        // merged into whatever the people currently editing have, broadcast to them, and persisted.
        // Writing to storage behind their backs would be overwritten by their next keystroke.
        const connection = await server.hocuspocus.openDirectConnection(input.name)
        try {
          await connection.transact((doc) => Y.applyUpdate(doc, new Uint8Array(update), 'kern:apply'))
          const doc = server.hocuspocus.documents.get(input.name)
          return { ok: true as const, size: doc ? Y.encodeStateAsUpdate(doc).byteLength : update.length }
        } finally {
          await connection.disconnect()
        }
      },
    },

    'document.replace': {
      ...collabProcedures['document.replace'],
      handler: async (input: { name: string; state: string }, { principal }) => {
        requireService(principal)
        requireName(input.name)
        const source = new Y.Doc()
        Y.applyUpdate(source, new Uint8Array(Buffer.from(input.state, 'base64')))

        const connection = await server.hocuspocus.openDirectConnection(input.name)
        try {
          await connection.transact((live) => {
            /**
             * Replace each top-level shared type rather than applying an update over the top.
             * `Y.applyUpdate` merges, so feeding an old version back would produce the union of old
             * and new — every deleted paragraph coming back alongside the ones that replaced it.
             *
             * Only the shapes an editor actually uses are handled. Anything else would be replaced
             * wrongly and silently, which is worse than refusing.
             */
            for (const key of source.share.keys()) {
              /**
               * Detect map-like content structurally.
               *
               * Neither obvious check works. A shared type that arrived through `applyUpdate` is an
               * untyped placeholder, so `Doc.get(key, Y.XmlFragment)` *converts* it rather than
               * throwing, and `instanceof` is false for everything. Its fields do not lie, though:
               * keyed content lives in `_map` and sequence content in `_start`.
               */
              const raw = source.share.get(key) as { _map?: Map<string, unknown> } | undefined
              if (raw?._map && raw._map.size > 0) {
                throw KernError.badRequest(
                  `Cannot replace shared type "${key}": only XML fragments are supported`,
                )
              }
              const from = source.get(key, Y.XmlFragment) as Y.XmlFragment
              const to = live.get(key, Y.XmlFragment) as Y.XmlFragment
              to.delete(0, to.length)
              to.insert(0, from.toArray().map((n) => (typeof n === 'string' ? n : n.clone())) as never[])
            }
          })
          const doc = server.hocuspocus.documents.get(input.name)
          return { ok: true as const, size: doc ? Y.encodeStateAsUpdate(doc).byteLength : 0 }
        } finally {
          await connection.disconnect()
        }
      },
    },

    'document.snapshot': {
      ...collabProcedures['document.snapshot'],
      handler: async (input: { name: string }, { principal }) => {
        requireService(principal)
        requireName(input.name)
        const doc = await resolveDoc(kernel, server, opts, input.name)
        if (!doc) throw KernError.notFound(`No collaborative document ${input.name}`)
        return {
          snapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString('base64'),
          state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
        }
      },
    },

    'document.delete': {
      ...collabProcedures['document.delete'],
      handler: async (input: { name: string }, { principal }) => {
        requireService(principal)
        requireName(input.name)
        // Close and unload first. Unloading runs the store hook, so deleting the row before that
        // would let the document write itself straight back. Another instance may still hold the
        // document and cannot be reached from here — `deleteDocument` leaves a tombstone so its
        // next store is refused instead.
        const live = server.hocuspocus.documents.get(input.name)
        if (live) {
          server.hocuspocus.closeConnections(input.name)
          await server.hocuspocus.unloadDocument(live)
        }
        await deleteDocument(kernel, input.name)
        return { ok: true as const }
      },
    },

    'document.presence': {
      ...collabProcedures['document.presence'],
      handler: async (input: { name: string }, { principal }) => {
        requireService(principal)
        requireName(input.name)
        // Deliberately per-instance: this reports the connections on whichever instance NATS
        // routed the call to, which across a cluster is an arbitrary subset. Aggregating properly
        // needs a request/response fan-out over Valkey with a timeout, and nothing calls this
        // procedure yet — so it is a known hole rather than something the callers rely on.
        const live = server.hocuspocus.documents.get(input.name)
        if (!live) return { users: [], connections: 0 }
        // One person with two tabs is one person, and the read-only flag is per connection: a user
        // who has the page open twice is only read-only if every one of those connections is.
        const byUser = new Map<string, { userId: string; name: string; readOnly: boolean }>()
        for (const c of live.getConnections()) {
          const ctx = c.context as { userId?: string; name?: string } | undefined
          if (!ctx?.userId) continue
          const seen = byUser.get(ctx.userId)
          byUser.set(ctx.userId, {
            userId: ctx.userId,
            name: ctx.name ?? '',
            readOnly: (seen?.readOnly ?? true) && c.readOnly,
          })
        }
        return { users: [...byUser.values()], connections: live.getConnectionsCount() }
      },
    },
  }
}
