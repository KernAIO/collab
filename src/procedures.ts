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

import type { Server } from '@hocuspocus/server'
import { collabProcedures, type Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type ProcedureDef } from '@kernhq/kernel'
import * as Y from 'yjs'
import { deleteDocument, loadDocument, parseDocumentName, readDocument } from './documents.js'

/** These procedures hand out document contents, so only another Kern service may call them. */
function requireService(principal: Principal): void {
  if (principal.kind !== 'service' && !principal.instanceAdmin) throw KernError.forbidden()
}

function requireName(name: string) {
  const doc = parseDocumentName(name)
  if (!doc) throw KernError.badRequest(`Malformed document name: ${name}`)
  return doc
}

/**
 * The live document if anyone has it open, otherwise the stored state loaded into a detached one.
 * Preferring the live copy matters: persistence is debounced, so the stored state is up to two
 * seconds behind whatever the people currently typing can see.
 */
async function resolveDoc(kernel: Kernel, server: Server, name: string): Promise<Y.Doc | null> {
  const live = server.hocuspocus.documents.get(name)
  if (live) return live
  const state = await loadDocument(kernel, name)
  if (!state) return null
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  return doc
}

export function createProcedures(kernel: Kernel, server: Server): Record<string, ProcedureDef> {
  return {
    'document.state': {
      ...collabProcedures['document.state'],
      handler: async (input: { name: string }, { principal }) => {
        requireService(principal)
        requireName(input.name)
        const stored = await readDocument(kernel, input.name)
        const live = server.hocuspocus.documents.get(input.name)
        if (!live) {
          return {
            name: input.name,
            state: stored.state ? Buffer.from(stored.state).toString('base64') : null,
            size: stored.size,
            updatedAt: stored.updatedAt,
          }
        }
        // The live copy wins because persistence is debounced and storage is up to two seconds
        // behind. `updatedAt` stays the stored one all the same: it says when this document was last
        // written down, and answering "now" because somebody has the tab open would be a lie a
        // caller deciding whether it already has this version would act on.
        const state = Buffer.from(Y.encodeStateAsUpdate(live))
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

    'document.snapshot': {
      ...collabProcedures['document.snapshot'],
      handler: async (input: { name: string }, { principal }) => {
        requireService(principal)
        requireName(input.name)
        const doc = await resolveDoc(kernel, server, input.name)
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
        // would let the document write itself straight back.
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
