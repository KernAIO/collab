/**
 * Awareness for a participant who cannot write.
 *
 * A read-only participant belongs in the presence list — they are reading the page and the people
 * writing it should see that — but a caret means "somebody is typing here", and theirs never will
 * be. The gateway strips the cursor fields on the way through, because read-only is decided here
 * and the browser only ever learns it as a hint it is free to ignore.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { peerState, startCollab, type TestCollab } from '../testing/harness.js'

let collab: TestCollab

beforeAll(async () => {
  collab = await startCollab()
  // `viewer` may read but not write; `writer` may do both.
  collab.setAccess('quire', ({ type }) => ({ canRead: true, canWrite: type !== 'readonly' }))
}, 60_000)

afterAll(async () => {
  await collab?.stop()
})

describe('a read-only participant', () => {
  it('is visible to the others, but broadcasts no caret', async () => {
    const name = collab.documentName({ module: 'quire', type: 'readonly' })
    const writer = collab.connect(name, collab.user('Writer'))
    const viewer = collab.connect(name, collab.user('Viewer'))
    await Promise.all([writer.synced, viewer.synced])
    expect(viewer.provider.authorizedScope).toBe('readonly')

    viewer.provider.setAwarenessField('user', { name: 'Viewer', colour: '#f00' })
    viewer.provider.setAwarenessField('cursor', { anchor: 3, head: 7 })
    viewer.provider.setAwarenessField('selection', { anchor: 3, head: 7 })

    const seen = await peerState(writer, 'Viewer')
    expect(seen.user, 'a reader should still appear in the presence list').toMatchObject({ name: 'Viewer' })
    expect(seen.cursor, 'a reader must not appear to be typing').toBeUndefined()
    expect(seen.selection).toBeUndefined()
    expect(seen.readOnly, 'peers need to know why there is no caret').toBe(true)
  })

  it('does not strip the caret of somebody who may write', async () => {
    const name = collab.documentName({ module: 'quire', type: 'page' })
    const a = collab.connect(name, collab.user('Alice'))
    const b = collab.connect(name, collab.user('Bob'))
    await Promise.all([a.synced, b.synced])
    expect(b.provider.authorizedScope).toBe('read-write')

    b.provider.setAwarenessField('user', { name: 'Bob', colour: '#00f' })
    b.provider.setAwarenessField('cursor', { anchor: 1, head: 1 })

    const seen = await peerState(a, 'Bob')
    expect(seen.cursor).toEqual({ anchor: 1, head: 1 })
    expect(seen.readOnly).toBeUndefined()
  })
})
