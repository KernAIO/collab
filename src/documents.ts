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
import * as Y from 'yjs'

export type DocumentName = CollabDocument
export type DocumentAccess = CollabAccess
export const parseDocumentName = parseCollabDocument
export const formatDocumentName = formatCollabDocument

export const SCHEMA = 'kern_collab'

/** What `Y.encodeStateAsUpdate` produces for a document nobody has ever touched. */
const EMPTY_STATE = Buffer.from(Y.encodeStateAsUpdate(new Y.Doc()))

/**
 * A state that carries nothing — no content, no deletions, no shared types.
 *
 * An empty document is indistinguishable from no document: loading either produces the same thing.
 * So nothing writes a row for one, and a read that finds one answers "there is no such document".
 * Deleting every paragraph of a real document does not produce this — the deletions are part of the
 * state.
 */
export function isEmptyState(state: Uint8Array): boolean {
  return Buffer.from(state).equals(EMPTY_STATE)
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
      sql`select state from kern_collab.documents where name = ${name} and deleted_at is null`,
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
      sql`select state, size, updated_at from kern_collab.documents where name = ${name} and deleted_at is null`,
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

/**
 * Write a document down, and say whether that changed anything.
 *
 * Two conditions guard the update, and they are separate ideas.
 *
 * `deleted_at is null` is the tombstone: another instance may still hold this document in memory,
 * and its next debounced store would otherwise put the prose straight back after a delete. The
 * straggler's write is refused rather than racing it. It refuses silently — the row keeps the empty
 * state and the `deleted_at` it already had — so nothing but the row itself can tell you it worked:
 * every read in this service filters deleted rows out, and so hides a resurrected one.
 *
 * `state is distinct from excluded.state` keeps `updated_at` meaning "when the content last
 * changed". Two instances holding one document both store the merged result, and a straggler
 * re-stores bytes that are already there; without this each of those would mark the document as
 * freshly written, and a module deciding whether it already has this version would act on it.
 *
 * The **return value** is what stops a read being announced as an edit. `collab.document.updated`
 * is published from the store hook, and the only honest trigger for it is Postgres reporting that
 * the row actually moved: `returning name` yields no row when either guard refused. A caller that
 * changed nothing therefore cannot produce an event, whatever brought it here.
 */
export async function storeDocument(kernel: Kernel, name: string, state: Uint8Array): Promise<boolean> {
  const doc = parseDocumentName(name)
  if (!doc) return false
  const buf = Buffer.from(state)
  return kernel.database.withWorkspace(doc.workspaceId, async (tx) => {
    const res = await tx.execute<{ name: string }>(sql`
      insert into kern_collab.documents (name, workspace_id, module, type, object_id, state, size, updated_at)
      values (${name}, ${doc.workspaceId}::uuid, ${doc.module}, ${doc.type}, ${doc.objectId}::uuid, ${buf}, ${buf.length}, now())
      on conflict (name) do update set state = excluded.state, size = excluded.size, updated_at = now()
      where kern_collab.documents.deleted_at is null
        and kern_collab.documents.state is distinct from excluded.state
      returning name
    `)
    return res.rows.length > 0
  })
}

/**
 * Nothing else removes these rows. A module that deletes the object behind a document calls this,
 * or the state outlives the page for ever.
 *
 * The prose goes immediately; the row stays as a tombstone holding only the name, workspace, module,
 * type, object id and timestamps. That is what stops an instance which still has the document open
 * from writing it back — there is no fan-out channel in this system that would let a delete reach
 * every instance, so the refusal has to live where every instance already writes.
 */
export async function deleteDocument(kernel: Kernel, name: string): Promise<void> {
  const doc = parseDocumentName(name)
  if (!doc) return
  await kernel.database.withWorkspace(doc.workspaceId, (tx) =>
    tx.execute(sql`
      update kern_collab.documents
      set state = ''::bytea, size = 0, deleted_at = now(), updated_at = now()
      where name = ${name}
    `),
  )
}
