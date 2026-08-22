/**
 * Document naming and the access decision — the two pure-ish pieces of the collab service that decide
 * which object a socket is asking for and whether it may have it.
 */
import { ANONYMOUS, type MembershipSummary, type Principal } from '@kernhq/contracts'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { formatDocumentName, parseDocumentName } from '../documents.js'
import { extractText } from '../text.js'

const WS = '01920000-0000-7000-8000-000000000001'
const OBJ = '01920000-0000-7000-8000-000000000002'

describe('document names', () => {
  it('round-trips a well-formed name', () => {
    const name = formatDocumentName({ workspaceId: WS, module: 'docs', type: 'page', objectId: OBJ })
    expect(name).toBe(`ws:${WS}:docs:page:${OBJ}`)
    expect(parseDocumentName(name)).toEqual({
      workspaceId: WS,
      module: 'docs',
      type: 'page',
      objectId: OBJ,
    })
  })

  it('rejects anything that is not a five-part ws-prefixed name', () => {
    for (const bad of [
      '',
      'page',
      `ws:${WS}:docs:page`,
      `ws:${WS}:docs:page:${OBJ}:extra`,
      `nope:${WS}:docs:page:${OBJ}`,
      `ws::docs:page:${OBJ}`,
      `ws:${WS}::page:${OBJ}`,
      `ws:${WS}:docs::${OBJ}`,
      `ws:${WS}:docs:page:`,
    ])
      expect(parseDocumentName(bad), bad).toBeNull()
  })

  it('rejects a module id that is not a plain lowercase identifier', () => {
    for (const module of ['Docs', 'my-module', '1docs', 'docs/../secrets', 'docs.page'])
      expect(parseDocumentName(`ws:${WS}:${module}:page:${OBJ}`), module).toBeNull()
    expect(parseDocumentName(`ws:${WS}:my_module:page:${OBJ}`)).not.toBeNull()
  })
})

describe('extracting a text snapshot', () => {
  it('reads the text of a shared XML fragment', () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('default')
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText('hello ')])
    const second = new Y.XmlElement('paragraph')
    second.insert(0, [new Y.XmlText('world')])
    fragment.insert(0, [paragraph, second])

    const text = extractText(doc)
    expect(text).toContain('hello')
    expect(text).toContain('world')
  })

  it('reads a plain shared text and returns nothing for an empty document', () => {
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'just some prose')
    expect(extractText(doc)).toContain('just some prose')
    expect(extractText(new Y.Doc())).toBe('')
  })

  it('honours the length limit', () => {
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'x'.repeat(5_000))
    expect(extractText(doc, 100)).toHaveLength(100)
  })
})

describe('the principal shape the access check depends on', () => {
  const member = (workspaceId: string, role: MembershipSummary['role'] = 'member'): Principal => ({
    ...ANONYMOUS,
    kind: 'user',
    userId: '01920000-0000-7000-8000-00000000000a' as Principal['userId'],
    memberships: [{ workspaceId: workspaceId as never, role, roleIds: [], groupIds: [], status: 'active' }],
  })

  it('treats an anonymous principal as having no access at all', async () => {
    const { resolveAccess } = await import('../documents.js')
    const kernel = { call: async () => ({ canRead: true, canWrite: true }), log: { debug() {} } } as never
    expect(
      await resolveAccess(kernel, ANONYMOUS, {
        workspaceId: WS,
        module: 'docs',
        type: 'page',
        objectId: OBJ,
      }),
    ).toEqual({ canRead: false, canWrite: false })
  })

  it('refuses a member of another workspace before asking the module', async () => {
    const { resolveAccess } = await import('../documents.js')
    let asked = false
    const kernel = {
      call: async () => {
        asked = true
        return { canRead: true, canWrite: true }
      },
      log: { debug() {} },
    } as never

    expect(
      await resolveAccess(kernel, member('01920000-0000-7000-8000-0000000000ff'), {
        workspaceId: WS,
        module: 'docs',
        type: 'page',
        objectId: OBJ,
      }),
    ).toEqual({ canRead: false, canWrite: false })
    expect(asked, 'a non-member must never reach the owning module').toBe(false)
  })
})
