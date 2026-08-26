/** Loads `.env` (repo-local, then the umbrella workspace) outside production and validates collab settings. */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

if (process.env.NODE_ENV !== 'production') {
  const here = dirname(fileURLToPath(import.meta.url))
  loadDotenv({ path: resolve(here, '../.env'), quiet: true })
  loadDotenv({ path: resolve(here, '../../../.env'), quiet: true })
}

export const CollabEnv = z.object({
  /** how long to wait after the last edit before writing the document back to Postgres */
  COLLAB_DEBOUNCE_MS: z.coerce.number().int().default(2_000),
  /** upper bound on how long a busy document may go unsaved */
  COLLAB_MAX_DEBOUNCE_MS: z.coerce.number().int().default(15_000),
  /** refuse updates once a document exceeds this size (bytes) */
  COLLAB_MAX_DOCUMENT_BYTES: z.coerce
    .number()
    .int()
    .default(8 * 1024 * 1024),
  /** how often a loaded document publishes a plain-text snapshot for search */
  COLLAB_SNAPSHOT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .default(5 * 60_000),
  /**
   * Namespace for this deployment's Hocuspocus channels and locks in Valkey. Every key is
   * `<prefix>:<documentName>`, so two Kern instances that share one Valkey need two prefixes or
   * they will relay each other's documents.
   */
  COLLAB_REDIS_PREFIX: z.string().default('kern:collab'),
})
export type CollabEnv = z.infer<typeof CollabEnv>

export function loadCollabEnv(extra: Record<string, string | undefined> = {}): CollabEnv {
  const parsed = CollabEnv.safeParse({ ...process.env, ...extra })
  if (!parsed.success) {
    throw new Error(
      `Invalid collab environment:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    )
  }
  return parsed.data
}
