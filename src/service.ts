import { randomUUID } from 'node:crypto'
import { Server } from '@hocuspocus/server'
import { createKernel, type Kernel } from '@kernalo/kernel'
import * as Y from 'yjs'
import { ensureStorage, loadDocument, parseDocumentName, resolveAccess, storeDocument } from './documents.js'
import { type CollabEnv, loadCollabEnv } from './env.js'
import { createPrincipals, type Principals } from './principal.js'
import { extractText } from './text.js'

export const COLLAB_VERSION = '0.1.0'

export interface CollabServiceOptions {
  env?: Record<string, string | undefined>
}

export interface CollabService {
  kernel: Kernel
  env: CollabEnv
  server: Server
  principals: Principals
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
    version: COLLAB_VERSION,
    modules: [],
    role: 'api',
    env: { PORT: process.env.PORT ?? '4300', ...opts.env },
  })
  await kernel.start()
  await ensureStorage(kernel)

  const principals = createPrincipals(kernel)
  const lastSnapshot = new Map<string, number>()

  const server = new Server({
    name: 'kern-collab',
    port: kernel.env.PORT,
    address: kernel.env.HOST,
    debounce: env.COLLAB_DEBOUNCE_MS,
    maxDebounce: env.COLLAB_MAX_DEBOUNCE_MS,
    quiet: true,
    stopOnSignals: false, // main.ts owns shutdown so the kernel closes too
    websocketOptions: { maxPayload: env.COLLAB_MAX_DOCUMENT_BYTES },

    async onAuthenticate({ documentName, token, connectionConfig }) {
      const doc = parseDocumentName(documentName)
      if (!doc) throw new Error('Malformed document name')
      const principal = await principals.fromToken(token)
      const access = await resolveAccess(kernel, principal, doc)
      if (!access.canRead) throw new Error('Not authorised for this document')
      // Read-only participants still see live edits and presence, they just cannot change anything.
      connectionConfig.readOnly = !access.canWrite
      return { userId: principal.userId, name: principal.name, workspaceId: doc.workspaceId }
    },

    async onLoadDocument({ documentName, document }) {
      const state = await loadDocument(kernel, documentName)
      if (state) Y.applyUpdate(document, state)
      return document
    },

    async onStoreDocument({ documentName, document }) {
      const state = Y.encodeStateAsUpdate(document)
      if (state.byteLength > env.COLLAB_MAX_DOCUMENT_BYTES) {
        kernel.log.warn(
          { documentName, bytes: state.byteLength },
          'document exceeds the size limit and was not stored',
        )
        return
      }
      await storeDocument(kernel, documentName, state)

      // Periodically publish a plain-text snapshot so modules can index the document for search
      // without having to understand the CRDT encoding.
      const doc = parseDocumentName(documentName)
      const now = Date.now()
      if (doc && now - (lastSnapshot.get(documentName) ?? 0) > env.COLLAB_SNAPSHOT_INTERVAL_MS) {
        lastSnapshot.set(documentName, now)
        await kernel.events
          .publishRaw({
            id: randomUUID(),
            name: 'collab.document.updated',
            version: 1,
            module: 'collab',
            workspaceId: doc.workspaceId as never,
            actorId: null,
            occurredAt: new Date().toISOString(),
            payload: {
              workspaceId: doc.workspaceId,
              module: doc.module,
              type: doc.type,
              objectId: doc.objectId,
              text: extractText(document),
            },
          })
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
        version: COLLAB_VERSION,
        documents: instance.getDocumentsCount(),
        connections: instance.getConnectionsCount(),
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
      return Promise.reject()
    },
  })

  return {
    kernel,
    env,
    server,
    principals,
    stats: () => ({
      documents: server.hocuspocus.getDocumentsCount(),
      connections: server.hocuspocus.getConnectionsCount(),
    }),
    async listen() {
      await server.listen()
      kernel.log.info({ port: kernel.env.PORT, path: '/collab' }, 'collab service listening')
    },
    async stop() {
      await server.destroy()
      await kernel.stop()
    },
  }
}
