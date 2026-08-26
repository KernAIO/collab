/**
 * More than one collab process, sharing one Valkey and one Postgres.
 *
 * A Y.Doc lives in the memory of the process that loaded it. Two instances behind a load balancer
 * are therefore two different documents unless something relays the edits between them, and whoever
 * lands on the wrong one watches their words disappear. The Hocuspocus Redis extension is that
 * something: this suite starts two real services on two ports and proves a client on each ends up
 * with one document.
 *
 * Every assertion here has to be one Postgres could not satisfy on its own, or it would pass with
 * the extension deleted. That is what the long debounce and the "nothing was written down" checks
 * are for, and it is why the control at the bottom exists.
 */
import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { peerState, sleep, startCollab, type TestCollab, waitFor } from '../testing/harness.js'

const VALKEY_URL = process.env.VALKEY_URL

/**
 * Persistence must not be able to stand in for the relay. Thirty seconds is far longer than any
 * assertion below takes, so nothing reaches Postgres while the clients are talking — and the last
 * client leaving an instance still flushes the store immediately, which is what the durability test
 * relies on.
 */
const NEVER_PERSIST_WHILE_WE_LOOK = { COLLAB_DEBOUNCE_MS: '30000', COLLAB_MAX_DEBOUNCE_MS: '60000' }

/** Is there really a Valkey behind `VALKEY_URL`? A URL in the environment is not an answer. */
async function reachable(url: string): Promise<boolean> {
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000 })
  client.on('error', () => {})
  try {
    await client.connect()
    return (await client.ping()) === 'PONG'
  } catch {
    return false
  } finally {
    client.disconnect()
  }
}

/**
 * Decided while the file is being collected, not in a hook: whether these tests run at all has to be
 * known before vitest asks for the list, or `skipIf` reads a value nothing has set yet.
 */
const unavailable: string | null = !VALKEY_URL
  ? 'VALKEY_URL is not set, so there is no Valkey to relay documents through.'
  : (await reachable(VALKEY_URL))
    ? null
    : `Valkey is not answering on ${VALKEY_URL}.`

if (unavailable) {
  const message = `${unavailable} Start it with \`pnpm infra\` from the umbrella repository.`
  // Skipping because the infrastructure is missing is fine on a laptop and dishonest in CI: there it
  // would report a green multi-instance service that nobody ever ran two of.
  if (process.env.CI) throw new Error(message)
  process.stderr.write(`\n  ⚠ ${message}\n    The multi-instance tests will be skipped.\n\n`)
}

const textOf = (state: string, field = 'content') => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(state, 'base64')))
  return doc.getText(field).toString()
}

describe.skipIf(unavailable !== null)('two instances sharing one Valkey', () => {
  let collab: TestCollab

  beforeAll(async () => {
    collab = await startCollab({
      instances: 2,
      env: {
        VALKEY_URL,
        // Unique per run, so two vitest workers and a developer's running `pnpm dev` cannot relay
        // each other's documents through the one Valkey on this machine.
        COLLAB_REDIS_PREFIX: `kern:test:${randomUUID()}`,
        ...NEVER_PERSIST_WHILE_WE_LOOK,
      },
    })
    collab.setAccess('quire', () => ({ canRead: true, canWrite: true }))
  }, 120_000)

  afterAll(async () => {
    await collab?.stop()
  })

  it('really are two processes', async () => {
    expect(collab.urls[0]).not.toBe(collab.urls[1])
    for (const svc of collab.services) {
      expect(svc.clustered, 'an instance that is not clustered keeps its documents to itself').toBe(true)
      const res = await fetch(`http://127.0.0.1:${svc.server.address.port}/api/health`)
      expect(await res.json()).toMatchObject({ ok: true, service: 'collab' })
    }
  })

  it('converge on one document, in both directions', async () => {
    const name = collab.documentName({ module: 'quire' })
    const alice = collab.connect(name, collab.user('Alice'), { instance: 0 })
    const bob = collab.connect(name, collab.user('Bob'), { instance: 1 })
    await Promise.all([alice.synced, bob.synced])

    alice.text.insert(0, 'typed on instance one')
    await waitFor(
      () => bob.text.toString() === 'typed on instance one',
      "Bob's instance to receive Alice's edit",
    )

    bob.text.insert(bob.text.length, ' and continued on instance two')
    await waitFor(
      () => alice.text.toString() === 'typed on instance one and continued on instance two',
      "Alice's instance to receive Bob's edit",
    )
    expect(bob.text.toString()).toBe(alice.text.toString())

    // The proof that this was the relay and not the database: with a thirty-second debounce the
    // document has not been written down yet, so there was nothing for the other instance to read.
    const stored = await collab.stored(name)
    expect(
      stored.state,
      'the edit crossed through Postgres, not Valkey — this test would pass with the extension deleted',
    ).toBeNull()
  })

  it('hand a late joiner state nobody has written down yet', async () => {
    const name = collab.documentName({ module: 'quire' })
    const alice = collab.connect(name, collab.user('Alice'), { instance: 0 })
    await alice.synced
    alice.text.insert(0, 'never persisted')
    await waitFor(
      () => collab.services[0]?.server.hocuspocus.documents.get(name)?.getText('content').toString(),
      'the edit to reach the first instance',
    )
    expect((await collab.stored(name)).state, 'the document must still be unwritten').toBeNull()

    // Carol opens the page on the other instance. The load hook finds nothing in storage, so the
    // only place this text can come from is Alice's instance.
    const carol = collab.connect(name, collab.user('Carol'), { instance: 1 })
    await carol.synced
    await waitFor(() => carol.text.toString() === 'never persisted', 'Carol to be handed the live state')
  })

  it('carry presence between instances', async () => {
    const name = collab.documentName({ module: 'quire' })
    const alice = collab.connect(name, collab.user('Alice'), { instance: 0 })
    const bob = collab.connect(name, collab.user('Bob'), { instance: 1 })
    await Promise.all([alice.synced, bob.synced])

    alice.provider.setAwarenessField('user', { name: 'Alice', colour: '#0a0' })
    alice.provider.setAwarenessField('cursor', { anchor: 0, head: 0 })

    const seen = await peerState(bob, 'Alice')
    expect(seen.cursor, 'a caret has to cross too, or the other instance shows a reader').toEqual({
      anchor: 0,
      head: 0,
    })
  })

  it('write down one merged document, not one instance half', async () => {
    const name = collab.documentName({ module: 'quire' })
    const alice = collab.connect(name, collab.user('Alice'), { instance: 0 })
    const bob = collab.connect(name, collab.user('Bob'), { instance: 1 })
    await Promise.all([alice.synced, bob.synced])

    alice.text.insert(0, 'alice')
    await waitFor(() => bob.text.toString() === 'alice', 'Bob to see it')
    bob.text.insert(bob.text.length, ' and bob')
    await waitFor(() => alice.text.toString() === 'alice and bob', 'Alice to see it')

    // The last client to leave an instance flushes that instance's store immediately, whatever the
    // debounce says.
    alice.destroy()
    bob.destroy()
    const stored = await waitFor(async () => {
      const row = await collab.stored(name)
      return row.state ? row : null
    }, 'the document to be written down')

    const doc = new Y.Doc()
    Y.applyUpdate(doc, stored.state as Uint8Array)
    expect(doc.getText('content').toString()).toBe('alice and bob')

    // And whoever opens it next gets the merged document, from either instance.
    const later = collab.connect(name, collab.user('Dana'), { instance: 0 })
    await later.synced
    await waitFor(() => later.text.toString() === 'alice and bob', 'the reopened document')
  })

  it('answer document.state from the instance that does not hold the document', async () => {
    const name = collab.documentName({ module: 'quire' })
    const alice = collab.connect(name, collab.user('Alice'), { instance: 0 })
    await alice.synced
    alice.text.insert(0, 'held by the other instance')
    await waitFor(
      () => collab.services[0]?.server.hocuspocus.documents.get(name)?.getText('content').toString(),
      'the edit to reach the first instance',
    )

    // A module's RPC lands on whichever instance the broker picked, which is very often not the one
    // holding the document. Answering from storage would hand quire an empty page version.
    const res = await collab.services[1]?.kernel.call<{ state: string | null; updatedAt: string | null }>(
      'collab.document.state',
      { name },
    )
    expect(res?.state, 'the instance without the document answered with nothing').not.toBeNull()
    expect(textOf(res?.state as string)).toBe('held by the other instance')
    expect(res?.updatedAt, 'nothing is written down, so this could only be the live copy').toBeNull()
  })
})

/**
 * The control. Without `VALKEY_URL` the service is one honest process, and two of them are two
 * different documents — which is the whole reason the extension exists, and the reason the
 * assertions above mean anything. If anybody ever wires the extension unconditionally, this is what
 * fails.
 *
 * It needs no Valkey, so it runs everywhere.
 */
describe('two instances without Valkey', () => {
  let control: TestCollab

  beforeAll(async () => {
    control = await startCollab({ instances: 2, env: NEVER_PERSIST_WHILE_WE_LOOK })
    control.setAccess('quire', () => ({ canRead: true, canWrite: true }))
  }, 120_000)

  afterAll(async () => {
    await control?.stop()
  })

  it('keep their documents to themselves', async () => {
    expect(control.services.map((s) => s.clustered)).toEqual([false, false])

    const name = control.documentName({ module: 'quire' })
    const alice = control.connect(name, control.user('Alice'), { instance: 0 })
    await alice.synced
    alice.text.insert(0, 'only on instance one')
    await waitFor(
      () =>
        control.services[0]?.server.hocuspocus.documents.get(name)?.getText('content').toString() ===
        'only on instance one',
      'the edit to reach the first instance',
    )

    const bob = control.connect(name, control.user('Bob'), { instance: 1 })
    await bob.synced
    await sleep(500)
    expect(bob.text.toString(), 'the two instances found each other with no Valkey configured').toBe('')
  })
})
