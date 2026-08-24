/**
 * The seam between the gateway and the module that owns a document.
 *
 * The rest of the suite registers `collab.access` as a bare handler, which is not what a module
 * does: a module declares Zod input and output schemas, and the broker validates against them. The
 * first module to implement this procedure declared `{ workspaceId, issueId, userId }` returning
 * `{ canView, canEdit }`, while the gateway sends `{ workspaceId, type, id, userId }` and reads
 * `{ canRead, canWrite }`. Every call failed validation, the broker threw, and the gateway silently
 * fell back to plain workspace membership — so the module's answer had never once been used, and no
 * test noticed because none of them went through the schemas.
 *
 * These tests register the procedure exactly as a module must: with the shapes from
 * `@kernhq/contracts`, which both sides now compile against.
 */
import { CollabAccess, CollabAccessInput, formatCollabDocument, WorkspaceId } from '@kernhq/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startCollab, type TestCollab, waitFor } from '../testing/harness.js'

let collab: TestCollab

beforeAll(async () => {
  collab = await startCollab()
}, 60_000)

afterAll(async () => {
  await collab?.stop()
})

/** Registers `collab.access` the way a real module does — through the declared schemas. */
function registerModuleAccess(
  module: string,
  answer: (input: CollabAccessInput) => CollabAccess,
): Array<CollabAccessInput> {
  const seen: CollabAccessInput[] = []
  collab.kernel.broker.register(module, {
    'collab.access': {
      input: CollabAccessInput,
      output: CollabAccess,
      handler: async (input: CollabAccessInput) => {
        seen.push(input)
        return answer(input)
      },
    },
  })
  return seen
}

describe('a module answering collab.access through the declared contract', () => {
  it('is called with an input its own schema accepts', async () => {
    const seen = registerModuleAccess('quire', () => ({ canRead: true, canWrite: true }))
    const user = collab.user('Writer')
    const objectId = '01920000-0000-7000-8000-0000000000a1'
    const name = collab.documentName({ module: 'quire', type: 'page', objectId })

    const client = collab.connect(name, user)
    await client.synced

    expect(seen, 'the module was never reached — the gateway fell back to membership').toHaveLength(1)
    expect(seen[0]).toEqual({
      workspaceId: collab.workspaceId,
      type: 'page',
      id: objectId,
      userId: user.id,
    })
    expect(client.provider.authorizedScope).toBe('read-write')
  })

  it('has its refusal honoured rather than swallowed into the membership fallback', async () => {
    registerModuleAccess('quire2', () => ({ canRead: false, canWrite: false }))
    const user = collab.user('Reader')
    const name = collab.documentName({ module: 'quire2', type: 'page' })

    const client = collab.connect(name, user)
    // A member of the workspace: if the module's answer were being dropped, the fallback would let
    // this connection straight through.
    await expect(client.synced).rejects.toThrow()
  })

  it('makes a member read-only when the module says so', async () => {
    registerModuleAccess('quire3', () => ({ canRead: true, canWrite: false }))
    const user = collab.user('Viewer')
    const name = collab.documentName({ module: 'quire3', type: 'page' })

    const client = collab.connect(name, user)
    await client.synced
    expect(client.provider.authorizedScope).toBe('readonly')
  })

  it('formats the document name the gateway parses', async () => {
    const objectId = '01920000-0000-7000-8000-0000000000b2'
    const name = formatCollabDocument({
      workspaceId: WorkspaceId.parse(collab.workspaceId),
      module: 'quire4',
      type: 'page',
      objectId,
    })
    const seen = registerModuleAccess('quire4', () => ({ canRead: true, canWrite: true }))
    const client = collab.connect(name, collab.user('Author'))
    await client.synced
    client.text.insert(0, 'hello')

    expect(seen[0]?.id).toBe(objectId)
    await waitFor(async () => {
      const res = await collab.kernel.database.db.execute<{ n: string }>(
        `select count(*)::text as n from kern_collab.documents where name = '${name}'`,
      )
      return res.rows[0]?.n === '1'
    }, 'the document to persist under the formatted name')
  })
})
