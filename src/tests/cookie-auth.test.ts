/**
 * Authenticating a browser's socket.
 *
 * A first-party client cannot present a token: the session cookie is HttpOnly, so the page cannot
 * read it to hand to the provider. It is attached to the upgrade request all the same. Until this
 * existed the gateway accepted only a bearer token, which meant no browser could open a document —
 * the service was reachable in principle and unusable in practice.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPrincipals } from '../principal.js'
import { startCollab, type TestCollab } from '../testing/harness.js'

let collab: TestCollab

beforeAll(async () => {
  collab = await startCollab()
  collab.setAccess('quire', () => ({ canRead: true, canWrite: true }))
}, 60_000)

afterAll(async () => {
  await collab?.stop()
})

describe('the session cookie on the upgrade request', () => {
  it('authenticates a client that presents no token', async () => {
    const user = collab.user('Browser')
    const name = collab.documentName({ module: 'quire' })
    const client = collab.connectWithCookie(name, `kern.session_token=${user.token}`)
    await client.synced
    expect(client.provider.authorizedScope).toBe('read-write')
  })

  it('is read by the same rule behind TLS, where the cookie is __Secure- prefixed', async () => {
    const user = collab.user('Secure browser')
    const name = collab.documentName({ module: 'quire' })
    const client = collab.connectWithCookie(name, `__Secure-kern.session_token=${user.token}`)
    await client.synced
    expect(client.provider.authorizedScope).toBe('read-write')
  })

  it('refuses a cookie that carries no session', async () => {
    const name = collab.documentName({ module: 'quire' })
    const client = collab.connectWithCookie(name, 'theme=dark; locale=fa')
    await expect(client.synced).rejects.toThrow()
  })

  it('refuses a session token that is not one', async () => {
    const name = collab.documentName({ module: 'quire' })
    const client = collab.connectWithCookie(name, 'kern.session_token=not-a-real-token')
    await expect(client.synced).rejects.toThrow()
  })
})

describe('cookie parsing', () => {
  const principals = () => createPrincipals({ call: async () => null, log: { warn() {} } } as never)

  it('ignores a cookie whose name merely ends in the session name', async () => {
    // `evil_kern.session_token=…` must not be read as the session cookie.
    const p = principals()
    const seen = await p.fromCookie('evil_kern.session_token=stolen')
    expect(seen.kind).toBe('anonymous')
  })

  it('finds the session among other cookies, in any position', async () => {
    const calls: string[] = []
    const p = createPrincipals({
      call: async (_name: string, input: { token: string }) => {
        calls.push(input.token)
        return null
      },
      log: { warn() {} },
    } as never)
    await p.fromCookie('theme=dark; kern.session_token=abc; locale=fa')
    await p.fromCookie('kern.session_token=first')
    expect(calls).toEqual(['abc', 'first'])
  })

  it('decodes a percent-encoded value', async () => {
    const calls: string[] = []
    const p = createPrincipals({
      call: async (_name: string, input: { token: string }) => {
        calls.push(input.token)
        return null
      },
      log: { warn() {} },
    } as never)
    await p.fromCookie('kern.session_token=a%2Bb%3Dc')
    expect(calls).toEqual(['a+b=c'])
  })
})
