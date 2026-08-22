/**
 * Collaborative editing end to end: two Yjs clients over real WebSockets, the merged state written to
 * Postgres and read back, and the access decision the owning module has the final say over.
 */
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sleep, startCollab, type TestCollab, waitFor } from '../testing/harness.js'

let collab: TestCollab

const storedRow = (name: string) =>
  collab.kernel.database.db
    .execute<{ name: string; size: number; module: string; workspace_id: string; object_id: string }>(
      sql`select name, size, module, workspace_id, object_id from kern_collab.documents where name = ${name}`,
    )
    .then((r) => r.rows[0] ?? null)

beforeAll(async () => {
  collab = await startCollab()
  // the `docs` module answers for its own pages; every other module stays silent
  collab.setAccess('docs', ({ type }) => ({ canRead: type !== 'forbidden', canWrite: type === 'page' }))
})
afterAll(async () => {
  await collab?.stop()
})

describe('two clients on one document', () => {
  it('converge on the same text whichever side typed', async () => {
    const name = collab.documentName()
    const alice = collab.connect(name, collab.user('Alice'))
    const bob = collab.connect(name, collab.user('Bob'))
    await Promise.all([alice.synced, bob.synced])

    alice.text.insert(0, 'Hello from Alice. ')
    await waitFor(() => bob.text.toString().includes('Alice'), 'Bob to see Alice’s edit')

    bob.text.insert(bob.text.length, 'And from Bob.')
    await waitFor(() => alice.text.toString().includes('Bob'), 'Alice to see Bob’s edit')

    expect(alice.text.toString()).toBe('Hello from Alice. And from Bob.')
    expect(bob.text.toString()).toBe(alice.text.toString())
  })

  it('merge concurrent edits without losing either', async () => {
    const name = collab.documentName()
    const alice = collab.connect(name, collab.user('Alice'))
    const bob = collab.connect(name, collab.user('Bob'))
    await Promise.all([alice.synced, bob.synced])

    // both type at the same position before either update has crossed the wire
    alice.text.insert(0, 'AAA')
    bob.text.insert(0, 'BBB')

    await waitFor(
      () => alice.text.toString().length === 6 && bob.text.toString().length === 6,
      'both edits to merge',
    )
    expect(alice.text.toString()).toBe(bob.text.toString())
    expect(alice.text.toString()).toContain('AAA')
    expect(alice.text.toString()).toContain('BBB')
  })

  it('give a late joiner the full history', async () => {
    const name = collab.documentName()
    const alice = collab.connect(name, collab.user('Alice'))
    await alice.synced
    alice.text.insert(0, 'written before anybody else arrived')
    await sleep(150)

    const carol = collab.connect(name, collab.user('Carol'))
    await carol.synced
    await waitFor(() => carol.text.toString().length > 0, 'Carol to receive the existing document')
    expect(carol.text.toString()).toBe('written before anybody else arrived')
  })
})

describe('persistence', () => {
  it('stores the merged state and serves it after every client has left', async () => {
    const name = collab.documentName()
    const first = collab.connect(name, collab.user('Author'))
    await first.synced
    first.text.insert(0, 'this must survive a restart of the editor')

    const row = await waitFor(() => storedRow(name), 'the document to be written to Postgres')
    expect(row.size).toBeGreaterThan(0)
    const parts = name.split(':')
    expect(row.workspace_id).toBe(parts[1])
    expect(row.module).toBe(parts[2])
    expect(row.object_id).toBe(parts[4])

    first.destroy()
    await sleep(200)

    // a brand-new client, brand-new Y.Doc: everything it sees came out of the database
    const later = collab.connect(name, collab.user('Reader'))
    await later.synced
    await waitFor(() => later.text.toString().length > 0, 'the reloaded document to arrive')
    expect(later.text.toString()).toBe('this must survive a restart of the editor')
  })

  it('keeps documents apart', async () => {
    const a = collab.documentName()
    const b = collab.documentName()
    const one = collab.connect(a, collab.user('One'))
    const two = collab.connect(b, collab.user('Two'))
    await Promise.all([one.synced, two.synced])

    one.text.insert(0, 'only in A')
    await waitFor(() => storedRow(a), 'document A to be stored')
    await sleep(150)
    expect(two.text.toString()).toBe('')
    expect(await storedRow(b)).toBeNull()
  })
})

describe('access control', () => {
  it('refuses a connection with no token', async () => {
    const name = collab.documentName()
    const anonymous = collab.connect(name, null)
    await expect(anonymous.synced).rejects.toThrow(/authentication failed/i)
  })

  it('refuses a member of a different workspace', async () => {
    const name = collab.documentName()
    const outsider = collab.connect(name, collab.outsider('Mallory'))
    await expect(outsider.synced).rejects.toThrow(/authentication failed/i)
  })

  it('refuses a malformed document name', async () => {
    const bad = collab.connect('not-a-document-name', collab.user('Alice'))
    await expect(bad.synced).rejects.toThrow(/authentication failed/i)
  })

  it('refuses when the owning module says the object is off limits', async () => {
    const name = collab.documentName({ type: 'forbidden' })
    const denied = collab.connect(name, collab.user('Alice'))
    await expect(denied.synced).rejects.toThrow(/authentication failed/i)

    const asked = collab.accessCalls.filter((c) => (c.input as { type: string }).type === 'forbidden')
    expect(asked.length).toBeGreaterThan(0)
  })

  it('asks the module that owns the object, with the workspace, type, id and user', async () => {
    const objectId = '01920000-0000-7000-8000-00000000ab01'
    const alice = collab.user('Alice')
    const name = collab.documentName({ module: 'docs', type: 'page', objectId })
    const client = collab.connect(name, alice)
    await client.synced

    const call = collab.accessCalls.find((c) => (c.input as { id: string }).id === objectId)
    expect(call?.name).toBe('docs.collab.access')
    expect(call?.input).toEqual({
      workspaceId: collab.workspaceId,
      type: 'page',
      id: objectId,
      userId: alice.id,
    })
  })

  it('rejects a read-only participant’s edits while still streaming them the document', async () => {
    // `docs` grants write only for `page`, so a `comment` document is readable but not writable
    const name = collab.documentName({ module: 'docs', type: 'comment' })
    const writerName = collab.documentName({ module: 'docs', type: 'page' })

    const reader = collab.connect(name, collab.user('Reader'))
    await reader.synced
    expect(reader.provider.authorizedScope).toBe('readonly')

    reader.text.insert(0, 'I should not be able to write this')
    await sleep(300)

    // nothing was persisted for the read-only document...
    expect(await storedRow(name)).toBeNull()

    // ...while a writable one goes through
    const writer = collab.connect(writerName, collab.user('Writer'))
    await writer.synced
    expect(writer.provider.authorizedScope).toBe('read-write')
    writer.text.insert(0, 'this one is allowed')
    expect(await waitFor(() => storedRow(writerName), 'the writable document to be stored')).toBeTruthy()
  })

  it('does not let a read-only participant’s edits reach the other clients', async () => {
    const name = collab.documentName({ module: 'docs', type: 'comment' })
    const readerA = collab.connect(name, collab.user('ReaderA'))
    const readerB = collab.connect(name, collab.user('ReaderB'))
    await Promise.all([readerA.synced, readerB.synced])

    readerA.text.insert(0, 'sneaky')
    await sleep(300)
    expect(readerB.text.toString()).toBe('')
  })
})

describe('falling back when a module does not answer', () => {
  it('grants a member read and write when the owning module has no collab.access', async () => {
    const name = collab.documentName({ module: 'unbuilt', type: 'thing' })
    const member = collab.user('Member')
    const client = collab.connect(name, member)
    await client.synced

    expect(client.provider.authorizedScope).toBe('read-write')
    client.text.insert(0, 'usable while the module is still being built')
    expect(await waitFor(() => storedRow(name), 'the fallback document to be stored')).toBeTruthy()
  })

  it('still refuses a non-member of the workspace', async () => {
    const name = collab.documentName({ module: 'unbuilt', type: 'thing' })
    const outsider = collab.connect(name, collab.outsider('Mallory'))
    await expect(outsider.synced).rejects.toThrow(/authentication failed/i)
  })

  it('gives a guest read-only access rather than nothing', async () => {
    const name = collab.documentName({ module: 'unbuilt', type: 'thing' })
    const guest = collab.connect(name, collab.user('Guest', { role: 'guest' }))
    await guest.synced
    expect(guest.provider.authorizedScope).toBe('readonly')
  })
})

describe('health endpoint', () => {
  it('reports the documents and connections it is holding', async () => {
    const name = collab.documentName()
    const client = collab.connect(name, collab.user('Watcher'))
    await client.synced

    const res = await fetch(`${collab.url.replace('ws://', 'http://')}/api/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      service: string
      documents: number
      connections: number
    }
    expect(body.ok).toBe(true)
    expect(body.service).toBe('collab')
    expect(body.documents).toBeGreaterThan(0)
    expect(body.connections).toBeGreaterThan(0)
  })
})
