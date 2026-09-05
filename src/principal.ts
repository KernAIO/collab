import { ANONYMOUS, type Principal } from '@kernhq/contracts'
import type { Kernel } from '@kernhq/kernel'

/**
 * Resolves principals for a service that does not own the identity tables: the session token is handed
 * to core (`core.users.principal`), and the answer is cached briefly so that a burst of requests or a
 * WebSocket handshake storm does not amplify into core.
 */
export interface Principals {
  fromToken(token: string): Promise<Principal>
  /**
   * Resolve the session cookie a browser sends with the WebSocket upgrade.
   *
   * A first-party client cannot present a token: the session cookie is HttpOnly, so the page cannot
   * read it to hand to the provider. It is attached to the upgrade request all the same, which is
   * how the chat gateway authenticates its socket, and this is deliberately the same parsing so the
   * two agree about what a session looks like.
   */
  fromCookie(cookie: string): Promise<Principal>
  invalidate(token?: string): void
}

export function createPrincipals(kernel: Kernel, ttlMs = 60_000): Principals {
  const cache = new Map<string, { principal: Principal; expires: number }>()

  const fromToken = async (token: string): Promise<Principal> => {
    if (!token) return ANONYMOUS
    /**
     * An MCP token opens no document, ever.
     *
     * Core holds a `kmt_…` token to the `<module>:<read|write>` scopes its consent screen named,
     * and it can only do that when the caller says what the token is being used for. There is no
     * such thing here: a CRDT editing socket is not a module API call, it is not in the MCP tool
     * catalogue — that is built from `/api/<module>/openapi.json`, which this service does not
     * serve — and no consent screen has ever described it. So there is no need to state and nothing
     * to check it against, and the honest answer is that the credential does not authenticate.
     *
     * It is refused here rather than left to core so that the refusal does not depend on which
     * version of core answers. Until this existed, an MCP token handed to `onAuthenticate` came
     * back from `core.users.principal` as its owner's full principal and could edit every document
     * they could reach — and `/collab*` is routed here from the edge in every shipped Caddyfile.
     */
    if (token.startsWith('kmt_')) return ANONYMOUS
    const hit = cache.get(token)
    if (hit && hit.expires > Date.now()) return hit.principal
    const answer = await kernel
      .call<Principal | null>('core.users.principal', { token })
      .catch((err): null => {
        kernel.log.warn({ err }, 'principal lookup failed')
        return null
      })
    // `.catch` only covers a rejection. A resolved `null` — core answering "no such session" rather
    // than throwing — used to fall straight through to `principal.kind` and take down the handshake
    // with a TypeError instead of refusing the connection.
    const principal = answer ?? ANONYMOUS
    if (principal.kind !== 'anonymous') cache.set(token, { principal, expires: Date.now() + ttlMs })
    return principal
  }

  const fromCookie = (cookie: string): Promise<Principal> => {
    const match = /(?:^|;\s*)(?:__Secure-)?kern\.session_token=([^;]+)/.exec(cookie)
    return match?.[1] ? fromToken(decodeURIComponent(match[1])) : Promise.resolve(ANONYMOUS)
  }

  return {
    fromToken,
    fromCookie,
    invalidate(token) {
      if (token) cache.delete(token)
      else cache.clear()
    },
  }
}
