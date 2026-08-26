import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Redis as RedisExtension } from '@hocuspocus/extension-redis'
import { Server } from '@hocuspocus/server'
import { ANONYMOUS, collabEvents } from '@kernhq/contracts'
import { createKernel, type Kernel } from '@kernhq/kernel'
import { Redis as IORedis } from 'ioredis'
import * as Y from 'yjs'
import {
  isEmptyState,
  loadDocument,
  parseDocumentName,
  resolveAccess,
  SCHEMA,
  storeDocument,
} from './documents.js'
import { type CollabEnv, loadCollabEnv } from './env.js'
import { createPrincipals, type Principals } from './principal.js'
import { createProcedures } from './procedures.js'
import { extractText } from './text.js'

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../migrations')

export interface CollabServiceOptions {
  env?: Record<string, string | undefined>
}

export interface CollabService {
  kernel: Kernel
  env: CollabEnv
  server: Server
  principals: Principals
  /** true when this process relays documents through Valkey, so more than one of it may run */
  clustered: boolean
  stats(): { documents: number; connections: number }
  listen(): Promise<void>
  stop(): Promise<void>
}

/**
 * Collaborative editing for Kern documents.
 *
 * Every rich-text surface (wiki pages, long issue descriptions) is a Yjs document synchronised through
 * Hocuspocus. This service owns no domain data: it authenticates against core, asks the module that
 * owns the object whether the user may read or write, and persists the merged state so a document
 * survives the last editor closing their tab.
 */
export async function createCollabService(opts: CollabServiceOptions = {}): Promise<CollabService> {
  const env = loadCollabEnv(opts.env ?? {})
  const kernel = await createKernel({
    service: 'collab',
    modules: [],
    role: 'api',
    env: { PORT: process.env.PORT ?? '4300', ...opts.env },
  })
  await kernel.start()
  await kernel.database.migrateSchema(SCHEMA, MIGRATIONS)

  const principals = createPrincipals(kernel)
  const lastSnapshot = new Map<string, number>()

  /**
   * Without this every Y.Doc lives in one process's memory, so two instances behind a load balancer
   * are two different documents and whoever lands on the wrong one loses their edits. With it the
   * instances relay sync and awareness through Valkey and take a lock before writing, so a plain
   * round-robin proxy is enough and no session affinity is needed.
   *
   * Configured only when `VALKEY_URL` is set. A dev run and the test harness pass it as undefined on
   * purpose and must stay one honest process — `src/tests/cluster.test.ts` asserts both halves, and
   * its control is what fails if this is ever wired unconditionally.
   */
  const clustered = Boolean(kernel.env.VALKEY_URL)
  const extensions = clustered
    ? [
        new RedisExtension({
          prefix: env.COLLAB_REDIS_PREFIX,
          /**
           * Unique per process, never a stable name. The extension drops any message whose
           * identifier equals its own, so two instances sharing one identifier ignore each other
           * completely — every single-instance test still passes and nothing is logged. It is
           * length-prefixed with one byte on the wire, so it also has to stay under 255 bytes.
           */
          identifier: `collab-${randomUUID()}`,
          createClient: () => {
            const client = new IORedis(kernel.env.VALKEY_URL as string)
            // An ioredis client with no `error` listener turns a momentary Valkey blip into an
            // unhandled 'error' event, which takes the process down. The extension builds its own
            // clients in its constructor, so this factory is the only point guaranteed to be
            // earlier than the first connection attempt.
            client.on('error', (err: Error) => kernel.log.warn({ err: err.message }, 'valkey error'))
            return client
          },
        }),
      ]
    : []

  const server = new Server({
    name: 'kern-collab',
    port: kernel.env.PORT,
    address: kernel.env.HOST,
    debounce: env.COLLAB_DEBOUNCE_MS,
    maxDebounce: env.COLLAB_MAX_DEBOUNCE_MS,
    quiet: true,
    stopOnSignals: false, // main.ts owns shutdown so the kernel closes too
    websocketOptions: { maxPayload: env.COLLAB_MAX_DOCUMENT_BYTES },
    extensions,

    async onAuthenticate({ documentName, token, connectionConfig, requestHeaders }) {
      const doc = parseDocumentName(documentName)
      if (!doc) throw new Error('Malformed document name')
      // A browser cannot present a token — the session cookie is HttpOnly, so the page cannot read
      // it to hand to the provider — but the cookie is attached to the upgrade request. API clients
      // and native apps send a bearer token instead. Same order as the chat gateway.
      const cookie = requestHeaders.get('cookie')
      const principal = token
        ? await principals.fromToken(token)
        : cookie
          ? await principals.fromCookie(cookie)
          : ANONYMOUS
      const access = await resolveAccess(kernel, principal, doc)
      if (!access.canRead) throw new Error('Not authorised for this document')
      // Read-only participants still see live edits and presence, they just cannot change anything.
      connectionConfig.readOnly = !access.canWrite
      return { userId: principal.userId, name: principal.name, workspaceId: doc.workspaceId }
    },

    /**
     * A read-only participant sees live edits and belongs in the presence list, but a caret says
     * "somebody is typing here" and theirs never will be. Dropping the cursor fields rather than the
     * whole state keeps them visible as a reader — the client cannot be trusted to do this, because
     * read-only is decided here and the browser only learns it as a hint.
     */
    async beforeHandleAwareness({ connection, states }) {
      if (!connection?.readOnly) return
      for (const [clientId, state] of states) {
        if (!state) continue
        const { cursor: _cursor, selection: _selection, ...rest } = state
        states.set(clientId, { ...rest, readOnly: true })
      }
    },

    async onLoadDocument({ documentName, document }) {
      const state = await loadDocument(kernel, documentName)
      if (state) Y.applyUpdate(document, state)
      return document
    },

    async onStoreDocument({ documentName, document }) {
      const state = Y.encodeStateAsUpdate(document)
      // `document.apply` and `document.replace` open a direct connection, which stores on the way
      // out whether or not the update they carried added anything. Storing an empty document would
      // leave a row behind saying a page nobody ever wrote exists.
      if (isEmptyState(state)) return
      if (state.byteLength > env.COLLAB_MAX_DOCUMENT_BYTES) {
        kernel.log.warn(
          { documentName, bytes: state.byteLength },
          'document exceeds the size limit and was not stored',
        )
        return
      }
      const changed = await storeDocument(kernel, documentName, state)
      /**
       * Nothing is announced unless the document actually moved.
       *
       * This is what makes a read-and-announce loop impossible rather than merely absent.
       * `collab.document.updated` has exactly one trigger — Postgres reporting that the row's bytes
       * changed — and a reader cannot change them, so no read on any path can produce the event
       * that would send a subscriber back to read again. Sustaining a cycle would need every hop to
       * contribute new content, and a subscriber that only reads contributes none.
       *
       * It also keeps a deleted document quiet: the tombstone refuses the write, so a straggler
       * still holding the document cannot announce updates to a page that no longer exists.
       */
      if (!changed) return

      // Periodically publish a plain-text snapshot so modules can index the document for search
      // without having to understand the CRDT encoding.
      const doc = parseDocumentName(documentName)
      const now = Date.now()
      if (doc && now - (lastSnapshot.get(documentName) ?? 0) > env.COLLAB_SNAPSHOT_INTERVAL_MS) {
        lastSnapshot.set(documentName, now)
        await kernel
          .emit(
            collabEvents.documentUpdated,
            {
              name: documentName,
              workspaceId: doc.workspaceId,
              module: doc.module,
              type: doc.type,
              objectId: doc.objectId,
              text: extractText(document),
              updatedAt: new Date().toISOString(),
            },
            { workspaceId: doc.workspaceId },
          )
          .catch((err) => kernel.log.warn({ err }, 'failed to publish document snapshot'))
      }
    },

    async onDisconnect({ documentName, clientsCount }) {
      if (clientsCount === 0) lastSnapshot.delete(documentName)
    },

    /**
     * Hocuspocus owns the HTTP server, so health and metrics are served from its request hook.
     * Rejecting tells Hocuspocus the request is already handled; resolving passes it on.
     */
    onRequest({ request, response, instance }) {
      const path = (request.url ?? '/').split('?')[0]
      if (path !== '/api/health' && path !== '/api/collab/metrics') return Promise.resolve()
      const body = JSON.stringify({
        ok: true,
        service: 'collab',
        version: kernel.version,
        modules: kernel.registry.all().map((m) => ({ id: m.definition.id, version: m.definition.version })),
        documents: instance.getDocumentsCount(),
        connections: instance.getConnectionsCount(),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
      return Promise.reject()
    },
  })

  // Registered after the server exists, because every one of them acts on a live document.
  // `register` also subscribes `kern.rpc.collab.document.*` when NATS is configured, which is how
  // core — where the modules that own these documents are hosted — reaches them.
  kernel.broker.register('collab', createProcedures(kernel, server, { clustered }))

  return {
    kernel,
    env,
    server,
    principals,
    clustered,
    stats: () => ({
      documents: server.hocuspocus.getDocumentsCount(),
      connections: server.hocuspocus.getConnectionsCount(),
    }),
    async listen() {
      await server.listen()
      kernel.log.info({ port: kernel.env.PORT, path: '/collab', clustered }, 'collab service listening')
    },
    async stop() {
      await server.destroy()
      await kernel.stop()
    },
  }
}
