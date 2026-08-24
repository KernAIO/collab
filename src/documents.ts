/**
 * Document naming, access control and persistence for collaborative editing.
 *
 * A document name identifies an object in a module: `ws:<workspaceId>:<module>:<type>:<id>` — for
 * example `ws:0190…:quire:page:0191…`. The gateway never decides on its own whether someone may edit
 * a page: it checks workspace membership and then asks the owning module through
 * `<module>.collab.access`, so permissions stay with the module that owns the data.
 *
 * The name shapes and the access shapes live in `@kernhq/contracts` rather than here, because both
 * sides of that call have to agree on them and once they did not: the first module to implement
 * `collab.access` declared a different input and a different output, so the call threw on every
 * request and this file quietly fell back to plain workspace membership instead.
 */
import {
  type CollabAccess,
  type CollabDocument,
  formatCollabDocument,
  type Principal,
  parseCollabDocument,
} from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'
import { sql } from 'drizzle-orm'

export type DocumentName = CollabDocument
export type DocumentAccess = CollabAccess
export const parseDocumentName = parseCollabDocument
export const formatDocumentName = formatCollabDocument

export const SCHEMA = 'kern_collab'

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

/**
 * Row-level security is forced on this table, so every statement below runs inside
 * `withWorkspace` — outside it the policy matches nothing and a query returns no rows rather than
 * failing, which is the failure mode worth being explicit about.
 */
export async function loadDocument(kernel: Kernel, name: string): Promise<Uint8Array | null> {
  const doc = parseDocumentName(name)
  if (!doc) return null
  return kernel.database.withWorkspace(doc.workspaceId, async (tx) => {
    const res = await tx.execute<{ state: Buffer }>(
      sql`select state from kern_collab.documents where name = ${name}`,
    )
    const row = res.rows[0]
    return row ? new Uint8Array(row.state) : null
  })
}

export interface StoredDocument {
  state: Uint8Array | null
  size: number
  updatedAt: string | null
}

/** The same read, with the metadata a module needs to decide whether it already has this version. */
export async function readDocument(kernel: Kernel, name: string): Promise<StoredDocument> {
  const doc = parseDocumentName(name)
  if (!doc) return { state: null, size: 0, updatedAt: null }
  return kernel.database.withWorkspace(doc.workspaceId, async (tx) => {
    const res = await tx.execute<{ state: Buffer; size: number; updated_at: Date | string }>(
      sql`select state, size, updated_at from kern_collab.documents where name = ${name}`,
    )
    const row = res.rows[0]
    if (!row) return { state: null, size: 0, updatedAt: null }
    // `execute` returns driver rows, and whether a timestamptz arrives as a Date or a string depends
    // on which type parsers are installed. It is a string here — `2026-08-24 13:06:20.12+00`, which
    // is not ISO 8601 and fails the contract's `Timestamp` on the way out — so normalise both shapes
    // through `Date` rather than trusting either.
    const updatedAt = new Date(row.updated_at).toISOString()
    return { state: new Uint8Array(row.state), size: row.size, updatedAt }
  })
}

export async function storeDocument(kernel: Kernel, name: string, state: Uint8Array): Promise<void> {
  const doc = parseDocumentName(name)
  if (!doc) return
  const buf = Buffer.from(state)
  await kernel.database.withWorkspace(doc.workspaceId, (tx) =>
    tx.execute(sql`
      insert into kern_collab.documents (name, workspace_id, module, type, object_id, state, size, updated_at)
      values (${name}, ${doc.workspaceId}::uuid, ${doc.module}, ${doc.type}, ${doc.objectId}::uuid, ${buf}, ${buf.length}, now())
      on conflict (name) do update set state = excluded.state, size = excluded.size, updated_at = now()
    `),
  )
}

/**
 * Nothing else removes these rows. A module that deletes the object behind a document calls this,
 * or the state outlives the page for ever.
 */
export async function deleteDocument(kernel: Kernel, name: string): Promise<void> {
  const doc = parseDocumentName(name)
  if (!doc) return
  await kernel.database.withWorkspace(doc.workspaceId, (tx) =>
    tx.execute(sql`delete from kern_collab.documents where name = ${name}`),
  )
}
