/**
 * `collab.document.*` — what a module can ask the gateway to do with a document it owns.
 *
 * A module keeping version history, rendering a page nobody has open, restoring a version or
 * importing one needs the state itself, and the socket does not give it to anybody but a browser.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { sleep, startCollab, type TestCollab, waitFor } from '../testing/harness.js'

let collab: TestCollab

beforeAll(async () => {
  collab = await startCollab()
  collab.setAccess('quire', () => ({ canRead: true, canWrite: true }))
}, 60_000)

afterAll(async () => {
  await collab?.stop()
})

const call = <T>(proc: string, input: unknown) => collab.kernel.call<T>(`collab.${proc}`, input)

type State = { name: string; state: string | null; size: number; updatedAt: string | null }

/**
 * An edit reaches the server over the socket, so it is not there the instant `insert` returns. Every
 * assertion about server-side content waits for the text to arrive rather than assuming it has.
 */
async function stateSaying(name: string, expected: string): Promise<State> {
  return waitFor(async () => {
    const res = await call<State>('document.state', { name })
    return res.state && textOf(res.state) === expected ? res : null
  }, `the server to hold "${expected}" for ${name}`)
}

/** Decode a returned state into a detached document so a test can read its text. */
function textOf(state: string, field = 'content'): string {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(Buffer.from(state, 'base64')))
  return doc.getText(field).toString()
}

describe('document.state', () => {
  it('returns nothing for a document that has never been written', async () => {
    const res = await call<State>('document.state', { name: collab.documentName({ module: 'quire' }) })
    expect(res.state).toBeNull()
    expect(res.size).toBe(0)
    expect(res.updatedAt).toBeNull()
  })

  it('reads a live document, including edits that are not persisted yet', async () => {
    const name = collab.documentName({ module: 'quire' })
    const client = collab.connect(name, collab.user('Author'))
    await client.synced
    client.text.insert(0, 'not yet on disk')

    // The live copy has it before storage does: persistence is debounced, and `updatedAt` stays
    // null until the first write lands.
    const res = await stateSaying(name, 'not yet on disk')
    expect(res.size).toBeGreaterThan(0)
  })

  it('reads a document nobody has open, from storage', async () => {
    const name = collab.documentName({ module: 'quire' })
    const client = collab.connect(name, collab.user('Author'))
    await client.synced
    client.text.insert(0, 'closed the tab')
    await waitFor(async () => {
      const r = await call<State>('document.state', { name })
      return r.updatedAt ? r : null
    }, 'the document to persist')
    client.destroy()

    const res = await call<State>('document.state', { name })
    expect(textOf(res.state!)).toBe('closed the tab')
    expect(res.size).toBeGreaterThan(0)
    expect(res.updatedAt, 'a stored document knows when it was written').not.toBeNull()
  })

  it('refuses a malformed name rather than returning an empty document', async () => {
    await expect(call('document.state', { name: 'not-a-document' })).rejects.toThrow()
  })
})

describe('document.apply', () => {
  it('merges an update into a document nobody has open', async () => {
    const name = collab.documentName({ module: 'quire' })
    const source = new Y.Doc()
    source.getText('content').insert(0, 'restored from a version')

    await call('document.apply', {
      name,
      update: Buffer.from(Y.encodeStateAsUpdate(source)).toString('base64'),
    })

    const res = await call<State>('document.state', { name })
    expect(textOf(res.state!)).toBe('restored from a version')
  })

  it('reaches the people currently editing instead of writing behind their backs', async () => {
    const name = collab.documentName({ module: 'quire' })
    const client = collab.connect(name, collab.user('Author'))
    await client.synced
    client.text.insert(0, 'typed by hand')
    const seen = await stateSaying(name, 'typed by hand')

    const source = new Y.Doc()
    Y.applyUpdate(source, new Uint8Array(Buffer.from(seen.state!, 'base64')))
    source.getText('content').insert(0, 'inserted by the server: ')

    await call('document.apply', {
      name,
      update: Buffer.from(Y.encodeStateAsUpdate(source)).toString('base64'),
    })

    await waitFor(
      () => client.text.toString() === 'inserted by the server: typed by hand',
      'the open client to receive the applied update',
    )
  })
})

describe('document.replace', () => {
  /** A page's prose is an XML fragment, which is what Tiptap binds to. */
  const fragmentDoc = (paragraphs: string[]) => {
    const d = new Y.Doc()
    const frag = d.getXmlFragment('default')
    for (const p of paragraphs) {
      const el = new Y.XmlElement('paragraph')
      el.insert(0, [new Y.XmlText(p)])
      frag.push([el])
    }
    return d
  }
  const textOfFragment = (state: string) => {
    const d = new Y.Doc()
    Y.applyUpdate(d, new Uint8Array(Buffer.from(state, 'base64')))
    return d.getXmlFragment('default').toJSON()
  }

  it('replaces the content instead of merging it', async () => {
    const name = collab.documentName({ module: 'quire' })
    const original = fragmentDoc(['the original paragraph'])
    await call('document.apply', {
      name,
      update: Buffer.from(Y.encodeStateAsUpdate(original)).toString('base64'),
    })

    // Then the page is rewritten, as somebody editing would.
    const rewritten = fragmentDoc(['a completely different paragraph'])
    await call('document.replace', {
      name,
      state: Buffer.from(Y.encodeStateAsUpdate(rewritten)).toString('base64'),
    })

    const after = await call<State>('document.state', { name })
    const html = textOfFragment(after.state!)
    expect(html).toContain('a completely different paragraph')
    expect(
      html,
      'the old paragraph came back — this is apply, not replace, and restoring a version would union the two',
    ).not.toContain('the original paragraph')
  })

  it('reaches the people currently editing', async () => {
    const name = collab.documentName({ module: 'quire' })
    const client = collab.connect(name, collab.user('Author'))
    await client.synced
    const frag = client.doc.getXmlFragment('default')
    const el = new Y.XmlElement('paragraph')
    el.insert(0, [new Y.XmlText('draft')])
    frag.push([el])

    await waitFor(async () => {
      const r = await call<State>('document.state', { name })
      return r.state && textOfFragment(r.state).includes('draft') ? r : null
    }, 'the draft to reach the server')

    const restored = fragmentDoc(['the published version'])
    await call('document.replace', {
      name,
      state: Buffer.from(Y.encodeStateAsUpdate(restored)).toString('base64'),
    })

    await waitFor(
      () => frag.toJSON().includes('the published version') && !frag.toJSON().includes('draft'),
      'the open client to see the replacement',
    )
  })

  it('refuses a shared type it would replace wrongly', async () => {
    const name = collab.documentName({ module: 'quire' })
    const odd = new Y.Doc()
    odd.getMap('settings').set('theme', 'dark')
    await expect(
      call('document.replace', {
        name,
        state: Buffer.from(Y.encodeStateAsUpdate(odd)).toString('base64'),
      }),
    ).rejects.toThrow()
  })
})

describe('document.snapshot', () => {
  it('returns a snapshot and the state it was taken from', async () => {
    const name = collab.documentName({ module: 'quire' })
    const client = collab.connect(name, collab.user('Author'))
    await client.synced
    client.text.insert(0, 'version one')
    await stateSaying(name, 'version one')

    const res = await call<{ snapshot: string; state: string }>('document.snapshot', { name })
    expect(res.snapshot.length).toBeGreaterThan(0)
    expect(textOf(res.state)).toBe('version one')
  })

  it('refuses a document that does not exist', async () => {
    await expect(
      call('document.snapshot', { name: collab.documentName({ module: 'quire' }) }),
    ).rejects.toThrow()
  })
})

describe('document.presence', () => {
  it('is empty for a document nobody has open', async () => {
    const res = await call<{ users: unknown[]; connections: number }>('document.presence', {
      name: collab.documentName({ module: 'quire' }),
    })
    expect(res).toEqual({ users: [], connections: 0 })
  })

  it('names who is in the document, and whether they can write', async () => {
    const name = collab.documentName({ module: 'quire' })
    const writer = collab.user('Writer')
    const client = collab.connect(name, writer)
    await client.synced

    const res = await call<{
      users: Array<{ userId: string; name: string; readOnly: boolean }>
      connections: number
    }>('document.presence', { name })
    expect(res.connections).toBe(1)
    expect(res.users).toEqual([{ userId: writer.id, name: 'Writer', readOnly: false }])
  })

  it('counts one person with two tabs once', async () => {
    const name = collab.documentName({ module: 'quire' })
    const writer = collab.user('Writer')
    const a = collab.connect(name, writer)
    const b = collab.connect(name, writer)
    await Promise.all([a.synced, b.synced])

    const res = await call<{ users: unknown[]; connections: number }>('document.presence', { name })
    expect(res.connections).toBe(2)
    expect(res.users).toHaveLength(1)
  })
})

describe('document.delete', () => {
  it('forgets the state and disconnects whoever still has it open', async () => {
    const name = collab.documentName({ module: 'quire' })
    const client = collab.connect(name, collab.user('Author'))
    await client.synced
    client.text.insert(0, 'about to be deleted')
    await stateSaying(name, 'about to be deleted')
    await waitFor(async () => {
      const r = await call<State>('document.state', { name })
      return r.updatedAt ? r : null
    }, 'the document to persist')

    await call('document.delete', { name })

    const res = await call<State>('document.state', { name })
    expect(res.state, 'the row survived, so a deleted page keeps its prose for ever').toBeNull()
  })

  it('does not let a straggler write the prose back', async () => {
    const name = collab.documentName({ module: 'quire' })
    const author = collab.connect(name, collab.user('Author'))
    await author.synced
    author.text.insert(0, 'about to be deleted')
    await stateSaying(name, 'about to be deleted')
    await waitFor(async () => (await call<State>('document.state', { name })).updatedAt, 'the first write')

    await call('document.delete', { name })

    // Somebody was still typing when the page was deleted, and the provider reconnects the moment it
    // is disconnected. Across two instances the same thing is the copy the other process is holding,
    // which nothing here can reach. The tombstone refuses both: the live document may say whatever
    // the people still in it say, but the row does not come back.
    await author.synced
    author.text.insert(author.text.length, ', and typed afterwards')
    await sleep(400) // longer than the harness debounce, so a store has certainly been attempted

    expect(
      (await collab.stored(name)).state,
      'a deleted page wrote itself back the moment somebody who still had it open typed',
    ).toBeNull()

    // And once everybody has gone, nothing is left to serve it either.
    author.destroy()
    await waitFor(async () => {
      const res = await call<State>('document.state', { name })
      return res.state === null ? true : null
    }, 'the deleted document to be gone once the last client leaves')
  })
})
