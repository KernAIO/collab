/**
 * A read of a document is a read, and nothing else.
 *
 * `document.state` and `document.snapshot` hand a module the contents of a document it owns. In a
 * clustered instance the copy that matters is very often in another process, so the read loads the
 * document here to ask the peers for it — and in Hocuspocus, closing a loaded document is one hook
 * away from storing it. Every store publishes `collab.document.updated`; quire's subscriber for
 * that event calls `collab.document.state` straight back to flatten the prose properly. So a pure
 * read announced itself as an edit and the pair fed itself for as long as the instance ran.
 *
 * These assertions are about the clustered shape and only exist there: `VALKEY_URL` set, which is
 * what self-host, Coolify and Kern Cloud all run. One instance is enough — the loop needs no second
 * process, only a document this one does not have open.
 */
import { randomUUID } from 'node:crypto'
import { collabEvents, type EventEnvelope } from '@kernhq/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  clusteredSuiteUnavailable,
  sleep,
  startCollab,
  type TestCollab,
  waitFor,
  watchStores,
} from '../testing/harness.js'

const unavailable = await clusteredSuiteUnavailable('The read-is-not-an-edit tests')

describe.skipIf(unavailable !== null)('reading a document in a clustered instance', () => {
  let collab: TestCollab

  beforeAll(async () => {
    collab = await startCollab({
      env: {
        VALKEY_URL: process.env.VALKEY_URL,
        // Unique per run, so two vitest workers and a developer's running `pnpm dev` cannot relay
        // each other's documents through the one Valkey on this machine.
        COLLAB_REDIS_PREFIX: `kern:test:${randomUUID()}`,
      },
    })
    collab.setAccess('quire', () => ({ canRead: true, canWrite: true }))
  }, 120_000)

  afterAll(async () => {
    await collab?.stop()
  })

  const call = <T>(proc: string, input: unknown) => collab.kernel.call<T>(`collab.${proc}`, input)

  /**
   * A document with prose in it that this instance no longer holds — which is the only shape where
   * a read has to load anything. A read of a document somebody has open is answered from memory and
   * touches nothing.
   */
  async function writtenAndClosed(text: string): Promise<string> {
    const name = collab.documentName({ module: 'quire' })
    const client = collab.connect(name, collab.user('Author'))
    await client.synced
    client.text.insert(0, text)
    await waitFor(
      () => collab.service.server.hocuspocus.documents.get(name)?.getText('content').toString() === text,
      'the edit to reach the server',
    )
    // The last client leaving flushes the store immediately, whatever the debounce says.
    client.destroy()
    await waitFor(async () => (await collab.row(name))?.size, 'the document to be written down')
    await waitFor(
      () => !collab.service.server.hocuspocus.documents.has(name),
      'the document to be unloaded, so a read has to go and look for it',
    )
    return name
  }

  /** Every `collab.document.updated` published while `body` runs, plus a moment for the debounce. */
  async function emittedDuring(body: () => Promise<void>): Promise<EventEnvelope[]> {
    const seen: EventEnvelope[] = []
    const off = await collab.kernel.events.subscribe(collabEvents.documentUpdated.name, (e) => {
      seen.push(e)
    })
    try {
      await body()
      // Longer than the harness debounce, so a store scheduled by the read has certainly run.
      await sleep(600)
      return seen
    } finally {
      off()
    }
  }

  it('does not schedule a store', async () => {
    const name = await writtenAndClosed('read but never edited')
    const stores = watchStores(collab.service)
    try {
      await call('document.state', { name })
      await call('document.snapshot', { name })
      await sleep(600)
      expect(stores.names, 'a read scheduled a store of a document it did not change').toEqual([])
    } finally {
      stores.stop()
    }
  })

  it('does not announce document.state as an update', async () => {
    const name = await writtenAndClosed('state, not an edit')
    const emitted = await emittedDuring(async () => {
      await call('document.state', { name })
    })
    expect(
      emitted.map((e) => e.name),
      'a read announced itself as an edit',
    ).toEqual([])
  })

  it('does not announce document.snapshot as an update', async () => {
    const name = await writtenAndClosed('snapshot, not an edit')
    const emitted = await emittedDuring(async () => {
      await call('document.snapshot', { name })
    })
    expect(
      emitted.map((e) => e.name),
      'a snapshot announced itself as an edit',
    ).toEqual([])
  })

  /**
   * The control the three above depend on. "Nothing was emitted" is also what deleting the emit
   * altogether would produce, so a real edit has to still be announced or none of this means
   * anything.
   */
  it('still announces a real edit', async () => {
    const name = collab.documentName({ module: 'quire' })
    const emitted = await emittedDuring(async () => {
      const client = collab.connect(name, collab.user('Author'))
      await client.synced
      client.text.insert(0, 'genuinely typed')
      client.destroy()
    })
    expect(emitted.map((e) => e.name)).toContain(collabEvents.documentUpdated.name)
  })

  /**
   * Quire's subscriber, in miniature. It answers `collab.document.updated` by fetching the state and
   * flattening it itself, because the text the event carries renders marks as markup — so the read
   * is not incidental to the subscriber, it is the whole reason the subscriber exists.
   */
  it('cannot feed a subscriber that reads the document back', async () => {
    const name = await writtenAndClosed('the page a module keeps indexing')
    let readsByTheSubscriber = 0
    const off = await collab.kernel.events.subscribe(collabEvents.documentUpdated.name, async (e) => {
      if ((e.payload as { objectId?: string }).objectId !== name.split(':')[4]) return
      readsByTheSubscriber += 1
      // A runaway loop must not hang the suite; the assertion is that this never reaches its cap.
      if (readsByTheSubscriber > 10) return
      await call('document.state', { name })
    })
    try {
      await call('document.state', { name })
      await sleep(2_000)
      expect(
        readsByTheSubscriber,
        'the read was announced as an edit, so the subscriber read it again, and so on for ever',
      ).toBe(0)
    } finally {
      off()
    }
  })
})
