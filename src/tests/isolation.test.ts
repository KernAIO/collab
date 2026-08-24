/**
 * Tenant isolation for `kern_collab.documents`.
 *
 * Until this table had a policy, the only thing between one workspace's prose and another's was the
 * gateway's access check. It now carries row-level security like every module table — and because the
 * dev and CI database roles are superusers, the policy is invisible to the rest of the suite. Every
 * assertion here goes through a role that can neither bypass RLS nor own the table, which is the
 * application role in a hardened deployment.
 */
import type pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startCollab, type TestCollab, waitFor } from '../testing/harness.js'

let collab: TestCollab
let restricted: pg.Pool
let otherWorkspace: string
let name: string

beforeAll(async () => {
  collab = await startCollab()
  restricted = await collab.restrictedPool()

  const author = collab.user('Author')
  name = collab.documentName({ module: 'quire', type: 'page' })
  const client = collab.connect(name, author)
  await client.synced
  client.text.insert(0, 'the handbook nobody else may read')
  await waitFor(async () => {
    const res = await collab.kernel.database.db.execute<{ n: string }>(
      `select count(*)::text as n from kern_collab.documents where name = '${name}'`,
    )
    return res.rows[0]?.n === '1'
  }, 'the document to be persisted')

  const outsider = collab.outsider('Outsider')
  otherWorkspace = outsider.principal.memberships[0]!.workspaceId
}, 60_000)

afterAll(async () => {
  await collab?.stop()
})

/** `withWorkspace` in one statement, on a connection that the policy actually applies to. */
async function asWorkspace<T>(workspaceId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await restricted.connect()
  try {
    await c.query('begin')
    await c.query('select set_config($1, $2, true)', ['app.workspace_id', workspaceId])
    const out = await fn(c)
    await c.query('commit')
    return out
  } finally {
    c.release()
  }
}

describe('kern_collab.documents row-level security', () => {
  it('is forced, so the table owner cannot read past the policy either', async () => {
    const res = await collab.kernel.database.db.execute<{
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(
      `select relrowsecurity, relforcerowsecurity from pg_class
       where oid = 'kern_collab.documents'::regclass`,
    )
    expect(res.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true })
  })

  it('proves the test role cannot bypass the policy', async () => {
    const c = await restricted.connect()
    try {
      const res = await c.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'select rolsuper, rolbypassrls from pg_roles where rolname = current_user',
      )
      expect(res.rows[0], 'a superuser would pass every assertion below with no policy at all').toEqual({
        rolsuper: false,
        rolbypassrls: false,
      })
    } finally {
      c.release()
    }
  })

  it('shows the row to its own workspace', async () => {
    const rows = await asWorkspace(
      collab.workspaceId,
      async (c) => (await c.query('select name from kern_collab.documents where name = $1', [name])).rows,
    )
    expect(rows).toHaveLength(1)
  })

  it('hides it from another workspace, by name and by a bare scan', async () => {
    const byName = await asWorkspace(
      otherWorkspace,
      async (c) => (await c.query('select name from kern_collab.documents where name = $1', [name])).rows,
    )
    expect(byName).toHaveLength(0)

    const all = await asWorkspace(
      otherWorkspace,
      async (c) => (await c.query('select name from kern_collab.documents')).rows,
    )
    expect(all).toHaveLength(0)
  })

  it('hides it from a connection that set no workspace at all', async () => {
    const c = await restricted.connect()
    try {
      const res = await c.query('select name from kern_collab.documents')
      expect(res.rows).toHaveLength(0)
    } finally {
      c.release()
    }
  })

  it('refuses to write a row into a workspace other than the current one', async () => {
    await expect(
      asWorkspace(otherWorkspace, (c) =>
        c.query(
          `insert into kern_collab.documents (name, workspace_id, module, type, object_id, state, size)
           values ($1, $2, 'quire', 'page', $3, '\\x00'::bytea, 1)`,
          [`ws:${collab.workspaceId}:quire:page:smuggled`, collab.workspaceId, collab.workspaceId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })
})
