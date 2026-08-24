/**
 * Integration harness for the collab service.
 *
 * The Hocuspocus server really listens, real Yjs providers connect over WebSocket, and documents are
 * persisted into a scratch database. Core is not started: `core.users.principal` (and any module's
 * `<module>.collab.access`) are registered as local broker procedures, which is exactly the seam the
 * service uses to decide who may read or write a document.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { ANONYMOUS, type MembershipSummary, type Principal, WorkspaceId } from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'
import { uuidv7 } from '@kernhq/kernel'
import { createScratchDatabase } from '@kernhq/testing'
import { config as loadDotenv } from 'dotenv'
import pg from 'pg'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { formatDocumentName } from '../documents.js'
import { type CollabService, createCollabService } from '../service.js'

/**
 * Hocuspocus' provider picks up the global WebSocket; give it the `ws` implementation once rather
 * than passing a polyfill per provider (that option belongs to the socket, not the provider, config).
 *
 * The subclass exists so a test can put a cookie on the upgrade request, which is the only way a
 * browser authenticates: `ws` takes headers in its constructor options, and a browser sets them for
 * you. `nextCookie` is read at construction, so connections made through `connectWithCookie` are
 * sequential by design — a reconnect picks up whatever is current, which is fine for a test and
 * would not be for anything else.
 */
let nextCookie: string | null = null
class KernTestSocket extends WebSocket {
  constructor(address: string | URL, protocols?: string | string[], options?: Record<string, unknown>) {
    super(address, protocols, nextCookie ? { ...options, headers: { cookie: nextCookie } } : options)
  }
}
globalThis.WebSocket = KernTestSocket as unknown as typeof globalThis.WebSocket

const here = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: resolve(here, '../../.env'), quiet: true })
loadDotenv({ path: resolve(here, '../../../../.env'), quiet: true })

export const BASE_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const TEST_SECRET = process.env.KERN_SECRET ?? 'kern-test-secret-value-at-least-32-chars'

export interface TestUser {
  id: string
  name: string
  token: string
  principal: Principal
}

/** A connected Yjs client: the shared document plus the provider driving it. */
export interface TestClient {
  doc: Y.Doc
  provider: HocuspocusProvider
  /** the collaborative text every test edits */
  text: Y.Text
  /** resolves once the server has authenticated and synced this client */
  synced: Promise<void>
  destroy(): void
}

export interface TestCollab {
  service: CollabService
  kernel: Kernel
  workspaceId: string
  url: string
  /** every `<module>.collab.access` question the service asked, in order */
  accessCalls: Array<{ name: string; input: unknown }>
  user(name: string, over?: Partial<Principal> & { role?: MembershipSummary['role'] }): TestUser
  /** a user who belongs to a different workspace */
  outsider(name: string): TestUser
  documentName(opts?: { module?: string; type?: string; objectId?: string; workspaceId?: string }): string
  connect(documentName: string, user: TestUser | null): TestClient
  /**
   * Connect the way a browser does: no token, and the session cookie attached to the upgrade
   * request. A page cannot read an HttpOnly cookie to hand to the provider, so this is the only path
   * a first-party client has.
   */
  connectWithCookie(documentName: string, cookie: string): TestClient
  /** register (or replace) a module's `collab.access` answer */
  setAccess(
    module: string,
    answer: (input: {
      workspaceId: string
      type: string
      id: string
      userId: string
    }) => { canRead: boolean; canWrite: boolean } | Promise<{ canRead: boolean; canWrite: boolean }>,
  ): void
  /**
   * A pool connected as a role that can neither bypass RLS nor act as the table owner. The dev and
   * CI database roles are superusers, so a policy is invisible to every other test in this suite —
   * they would pass identically with no policy at all. Anything asserting isolation has to go
   * through here.
   */
  restrictedPool(): Promise<pg.Pool>
  stop(): Promise<void>
}

const unique = () => `${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`

export interface StartCollabOptions {
  env?: Record<string, string | undefined>
}

export async function startCollab(opts: StartCollabOptions = {}): Promise<TestCollab> {
  const scratch = await createScratchDatabase(BASE_DATABASE_URL, `kern_test_collab_${unique()}`)
  const workspaceId = uuidv7()
  const restricted: pg.Pool[] = []
  let restrictedRole: string | null = null
  const service = await createCollabService({
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: scratch.url,
      DATABASE_POOL_MAX: '4',
      KERN_SECRET: TEST_SECRET,
      PORT: '0',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
      // write through quickly so the persistence assertions do not have to wait
      COLLAB_DEBOUNCE_MS: '50',
      COLLAB_MAX_DEBOUNCE_MS: '200',
      ...opts.env,
    },
  })
  const kernel = service.kernel
  const tokens = new Map<string, Principal>()
  const accessCalls: Array<{ name: string; input: unknown }> = []

  kernel.broker.register('core', {
    'users.principal': {
      handler: async (input: { token?: string; userId?: string }) =>
        (input.token ? tokens.get(input.token) : undefined) ?? ANONYMOUS,
    },
  })

  await service.listen()
  const url = `ws://127.0.0.1:${service.server.address.port}`
  const clients: TestClient[] = []

  const makeUser = (name: string, workspace: string, over: Partial<Principal> = {}): TestUser => {
    const id = uuidv7()
    const token = `tok_${randomUUID()}`
    const principal: Principal = {
      kind: 'user',
      userId: id as Principal['userId'],
      email: `${name.toLowerCase()}@example.test`,
      name,
      locale: 'en',
      instanceAdmin: false,
      service: null,
      memberships: [
        {
          workspaceId: workspace as MembershipSummary['workspaceId'],
          role: 'member',
          roleIds: [],
          groupIds: [],
          status: 'active',
        },
      ],
      permissionVersion: 0,
      ...over,
    }
    tokens.set(token, principal)
    return { id, name, token, principal }
  }

  return {
    service,
    kernel,
    workspaceId,
    url,
    accessCalls,
    user(name, over = {}) {
      const { role, ...rest } = over
      const user = makeUser(name, workspaceId, rest)
      if (role) user.principal.memberships[0]!.role = role
      return user
    },
    outsider(name) {
      return makeUser(name, uuidv7())
    },
    documentName(o = {}) {
      return formatDocumentName({
        workspaceId: WorkspaceId.parse(o.workspaceId ?? workspaceId),
        module: o.module ?? 'docs',
        type: o.type ?? 'page',
        objectId: o.objectId ?? uuidv7(),
      })
    },
    setAccess(module, answer) {
      kernel.broker.register(module, {
        'collab.access': {
          handler: async (input: { workspaceId: string; type: string; id: string; userId: string }) => {
            accessCalls.push({ name: `${module}.collab.access`, input })
            return answer(input)
          },
        },
      })
    },
    connect(documentName, user) {
      const doc = new Y.Doc()
      let resolveSynced!: () => void
      let rejectSynced!: (err: Error) => void
      const synced = new Promise<void>((res, rej) => {
        resolveSynced = res
        rejectSynced = rej
      })
      const provider = new HocuspocusProvider({
        url,
        name: documentName,
        document: doc,
        token: user?.token ?? '',
        onSynced: () => resolveSynced(),
        onAuthenticationFailed: ({ reason }) => rejectSynced(new Error(`authentication failed: ${reason}`)),
      })
      const client: TestClient = {
        doc,
        provider,
        text: doc.getText('content'),
        synced,
        destroy() {
          provider.destroy()
          doc.destroy()
        },
      }
      clients.push(client)
      return client
    },
    connectWithCookie(documentName, cookie) {
      nextCookie = cookie
      const doc = new Y.Doc()
      let resolveSynced!: () => void
      let rejectSynced!: (err: Error) => void
      const synced = new Promise<void>((res, rej) => {
        resolveSynced = res
        rejectSynced = rej
      })
      const provider = new HocuspocusProvider({
        url,
        name: documentName,
        document: doc,
        token: '',
        onSynced: () => resolveSynced(),
        onAuthenticationFailed: ({ reason }) => rejectSynced(new Error(`authentication failed: ${reason}`)),
      })
      const client: TestClient = {
        doc,
        provider,
        text: doc.getText('content'),
        synced,
        destroy() {
          provider.destroy()
          doc.destroy()
        },
      }
      clients.push(client)
      return client
    },
    async restrictedPool() {
      if (!restrictedRole) {
        restrictedRole = `kern_rls_${unique()}`
        const admin = new pg.Client({ connectionString: scratch.url })
        await admin.connect()
        await admin.query(`create role "${restrictedRole}" login password 'rls' nosuperuser nobypassrls`)
        await admin.query(`grant usage on schema kern_collab to "${restrictedRole}"`)
        await admin.query(
          `grant select, insert, update, delete on all tables in schema kern_collab to "${restrictedRole}"`,
        )
        await admin.end()
      }
      const url = new URL(scratch.url)
      url.username = restrictedRole
      url.password = 'rls'
      const pool = new pg.Pool({ connectionString: url.toString(), max: 2 })
      restricted.push(pool)
      return pool
    },
    async stop() {
      for (const pool of restricted) await pool.end().catch(() => {})
      for (const c of clients) {
        try {
          c.destroy()
        } catch {
          /* already gone */
        }
      }
      await service.stop()
      await scratch.drop()
      if (restrictedRole) {
        const admin = new pg.Client({ connectionString: BASE_DATABASE_URL })
        await admin.connect()
        await admin.query(`drop role if exists "${restrictedRole}"`).catch(() => {})
        await admin.end()
      }
    },
  }
}

/** Poll `check` until it returns a truthy value, or fail with `label`. */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  label: string,
  { timeoutMs = 10_000, intervalMs = 50 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value as T
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
