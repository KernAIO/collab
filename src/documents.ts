/**
 * Document naming, access control and persistence for collaborative editing.
 *
 * A document name identifies an object in a module: `ws:<workspaceId>:<module>:<type>:<id>` — for
 * example `ws:0190…:docs:page:0191…`. The gateway never decides on its own whether someone may edit a
 * page: it checks workspace membership and then asks the owning module through
 * `<module>.collab.access`, so permissions stay with the module that owns the data.
 */
import type { Principal } from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'
import { sql } from 'drizzle-orm'

export interface DocumentName {
  workspaceId: string
  module: string
  type: string
  objectId: string
}

export interface DocumentAccess {
  canRead: boolean
  canWrite: boolean
}

export function parseDocumentName(name: string): DocumentName | null {
  const parts = name.split(':')
  if (parts.length !== 5 || parts[0] !== 'ws') return null
  const [, workspaceId, module, type, objectId] = parts
  if (!workspaceId || !module || !type || !objectId) return null
  if (!/^[a-z][a-z0-9_]*$/.test(module)) return null
  return { workspaceId, module, type, objectId }
}

export function formatDocumentName(d: DocumentName): string {
  return `ws:${d.workspaceId}:${d.module}:${d.type}:${d.objectId}`
}

/**
 * Membership is necessary but not sufficient: the owning module has the final say. A module that does
 * not answer (not installed, or no `collab.access` procedure) falls back to workspace membership,
 * which keeps documents usable while a module is still being built.
 */
export async function resolveAccess(
  kernel: Kernel,
  principal: Principal,
  doc: DocumentName,
): Promise<DocumentAccess> {
  if (principal.kind === 'anonymous' || !principal.userId) return { canRead: false, canWrite: false }
  const member = principal.memberships.find((m) => m.workspaceId === doc.workspaceId && m.status === 'active')
  if (!member && !principal.instanceAdmin) return { canRead: false, canWrite: false }

  try {
    const answer = await kernel.call<DocumentAccess>(`${doc.module}.collab.access`, {
      workspaceId: doc.workspaceId,
      type: doc.type,
      id: doc.objectId,
      userId: principal.userId,
    })
    return { canRead: Boolean(answer?.canRead), canWrite: Boolean(answer?.canWrite) }
  } catch (err) {
    kernel.log.debug(
      { module: doc.module, err: err instanceof Error ? err.message : String(err) },
      'module did not answer collab.access; falling back to workspace membership',
    )
    return { canRead: true, canWrite: member?.role !== 'guest' }
  }
}

const TABLE = sql`kern_collab.documents`

/** Creates the table this service owns. It is not tied to a module, so it lives in its own schema. */
export async function ensureStorage(kernel: Kernel): Promise<void> {
  await kernel.database.db.execute(sql`create schema if not exists kern_collab`)
  await kernel.database.db.execute(sql`
    create table if not exists ${TABLE} (
      name text primary key,
      workspace_id uuid not null,
      module text not null,
      type text not null,
      object_id uuid not null,
      state bytea not null,
      size integer not null default 0,
      updated_at timestamptz not null default now()
    )
  `)
  await kernel.database.db.execute(
    sql`create index if not exists documents_workspace_idx on ${TABLE} (workspace_id, module, updated_at desc)`,
  )
}

export async function loadDocument(kernel: Kernel, name: string): Promise<Uint8Array | null> {
  const res = await kernel.database.db.execute<{ state: Buffer }>(
    sql`select state from ${TABLE} where name = ${name}`,
  )
  const row = res.rows[0]
  return row ? new Uint8Array(row.state) : null
}

export async function storeDocument(kernel: Kernel, name: string, state: Uint8Array): Promise<void> {
  const doc = parseDocumentName(name)
  if (!doc) return
  const buf = Buffer.from(state)
  await kernel.database.db.execute(sql`
    insert into ${TABLE} (name, workspace_id, module, type, object_id, state, size, updated_at)
    values (${name}, ${doc.workspaceId}::uuid, ${doc.module}, ${doc.type}, ${doc.objectId}::uuid, ${buf}, ${buf.length}, now())
    on conflict (name) do update set state = excluded.state, size = excluded.size, updated_at = now()
  `)
}
