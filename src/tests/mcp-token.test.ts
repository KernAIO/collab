import type { Principal } from '@kernhq/contracts'
import { describe, expect, it } from 'vitest'
import { createPrincipals } from '../principal.js'

/**
 * An MCP token opens no document.
 *
 * Core holds a `kmt_…` token to the `<module>:<read|write>` scopes its consent screen named, and it
 * can only do that when the caller says what the token is being used for. A CRDT editing socket has
 * no such need to state: it is not a module API call, and it is not in the MCP tool catalogue,
 * which is built from the `/api/<module>/openapi.json` documents this service does not serve.
 *
 * Before this guard, `onAuthenticate` handed the bearer to `core.users.principal`, which answered
 * with its owner's *full* principal — so a token consented for read-only access to one module could
 * edit every document its owner could reach, over a `/collab*` route the shipped Caddyfiles expose
 * at the edge.
 *
 * The stub deliberately answers with a real principal: the refusal has to come from this service,
 * so that deleting the guard makes these fail rather than leaning on whatever core does.
 */

const principal = { kind: 'user', userId: 'u1', name: 'Ann', memberships: [] } as unknown as Principal

function stubKernel() {
  const calls: string[] = []
  const kernel = {
    call: async (_name: string, input: { token?: string }) => {
      calls.push(input.token ?? '')
      return principal
    },
    log: { warn() {} },
  }
  return { kernel: kernel as never, calls }
}

describe('an MCP access token presented to the document socket', () => {
  it('does not authenticate, even though core would answer with the full principal', async () => {
    const { kernel, calls } = stubKernel()
    const p = createPrincipals(kernel)
    expect((await p.fromToken('kmt_read_only')).kind).toBe('anonymous')
    // and core was never asked: there is no question to put to it
    expect(calls).toEqual([])
  })

  it('refuses it on the cookie path too', async () => {
    const { kernel } = stubKernel()
    const p = createPrincipals(kernel)
    expect((await p.fromCookie('kern.session_token=kmt_read_only')).kind).toBe('anonymous')
  })

  it('still authenticates an ordinary session token', async () => {
    const { kernel, calls } = stubKernel()
    const p = createPrincipals(kernel)
    expect((await p.fromToken('tok_ordinary')).kind).toBe('user')
    expect(calls).toEqual(['tok_ordinary'])
  })
})
