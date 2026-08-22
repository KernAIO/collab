import { ANONYMOUS, type Principal } from '@kernaio/contracts'
import type { Kernel } from '@kernaio/kernel'

/**
 * Resolves principals for a service that does not own the identity tables: the session token is handed
 * to core (`core.users.principal`), and the answer is cached briefly so that a burst of requests or a
 * WebSocket handshake storm does not amplify into core.
 */
export interface Principals {
  fromToken(token: string): Promise<Principal>
  invalidate(token?: string): void
}

export function createPrincipals(kernel: Kernel, ttlMs = 60_000): Principals {
  const cache = new Map<string, { principal: Principal; expires: number }>()

  const fromToken = async (token: string): Promise<Principal> => {
    if (!token) return ANONYMOUS
    const hit = cache.get(token)
    if (hit && hit.expires > Date.now()) return hit.principal
    const principal = await kernel
      .call<Principal>('core.users.principal', { token })
      .catch((err): Principal => {
        kernel.log.warn({ err }, 'principal lookup failed')
        return ANONYMOUS
      })
    if (principal.kind !== 'anonymous') cache.set(token, { principal, expires: Date.now() + ttlMs })
    return principal
  }

  return {
    fromToken,
    invalidate(token) {
      if (token) cache.delete(token)
      else cache.clear()
    },
  }
}
