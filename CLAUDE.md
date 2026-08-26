# CLAUDE.md — Kern project rules

Rules for anyone (human or AI agent) working on Kern repositories. These apply to every repo in the KernAIO org.

## We build in the open
The repositories are **public**, so every commit is visible the moment it is pushed:
- Never commit secrets, tokens, personal data, or machine-specific paths. Use `.env` (gitignored) + `.env.example`.
- Write READMEs, docs, and issue/PR text for external contributors, not for ourselves.
- Keep commit history clean and meaningful — it is part of what people judge the project by.
- Every repo carries LICENSE, CLA.md, CODE_OF_CONDUCT.md, SECURITY.md, CONTRIBUTING.md.
- **Two licences, split at the framework boundary.** The `kernel` repo and `modules`'
  `_template` + `workflow` are **Apache-2.0** so anyone can write a closed module; the product —
  `shell`, `core`, `chat`, `mail`, `collab`, `docs`, this umbrella, the first-party modules — is
  **AGPL-3.0-only**. A new package inherits its repo's licence unless it is something a third-party
  module must import, and then it is Apache-2.0 with its own LICENSE file. Apache-2.0 packages take
  only permissive dependencies. If a module author has to import an AGPL package to get something
  done, move the API — never the licence. See `LICENSING.md` and
  `docs/adr/0005-licensing-and-the-module-boundary.md`.

## Git
- Author identity: `Navid Mirzaaghazadeh <mirzaaghazadeh@icloud.com>` (already set in each repo's local git config — plain `git commit` is correct; do not override with `-c`).
- **Do not add `Claude-Session:`, `Co-Authored-By: Claude`, "Generated with", or any AI trailer/branding to commit messages, PRs, or code comments.**
- Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, with optional scope). Imperative mood, ≤ 72-char subject.
- Push to `origin main`. Never force-push. If `git pull --rebase` complains about unstaged files that aren't yours (parallel agents share worktrees), use `git -c rebase.autoStash=true pull --rebase`.
- **Never `git add -A` or `git add .`. Stage the paths you changed, by name.** Several agents share
  these checkouts, and another one is very often part-way through a new package in the same repo.
  `git add -A` sweeps their half-finished files into your commit and pushes them — under your commit
  message, without their lockfile entry, so CI fails at install for everyone. It happened on
  2026-08-24: a contact-address fix carried two unfinished modules into `main`. Run
  `git status --porcelain` first and stage from it; if you cannot name every path you are about to
  commit, you are not ready to commit. When it does happen, do not revert the other agent's files —
  they are still working on them; tell them instead, and repair what you broke.

## Layout & workflow
- Umbrella dev workspace: `app/` with sibling repos cloned under `app/repos/<name>` (gitignored there). pnpm links all `@kernhq/*` packages via the umbrella workspace.
- Install dependencies ONLY via `app/scripts/pnpm-install-locked.sh` (serialises pnpm at the umbrella root).
- Node 24 (`nvm use 24`), pnpm 10, TypeScript ~5.9, ESM/NodeNext, Biome for lint+format (run `pnpm exec biome check --write <paths>` before committing), Vitest.
- Contracts first: changes to `@kernhq/contracts` / module contracts land (and build) before their consumers.
- Modules own their data: Postgres schema `mod_<id>`, `workspace_id` + RLS on every tenant table, cross-module access only via `kernel.call()` and events. See `modules` repo `packages/_template`.
- Ports: shell 5173 · core 4000 · chat 4100 · mail 4200 · collab 4300 · docs 4400.
- Dev DB on this machine: Homebrew Postgres 18 at `localhost:5432` (`kern`/`kern`); the compose Postgres listens on `${KERN_PG_PORT:-5432}` (5433 here).

## CI
Every service repository's CI runs the real suites, so the workflow starts the infrastructure they
need as service containers: Postgres (`pgvector/pgvector:pg18`) everywhere, Valkey for `chat` and
`collab`, Mailpit for `mail`. Things learned the hard way:
- Address a service container as **127.0.0.1**, never `localhost` — a runner resolves `localhost` to
  `::1` first, where the published port is not listening, and `fetch` does not retry over IPv4.
- Do not set `registry-url` on `actions/setup-node` in an install job. It writes an `.npmrc` with a
  placeholder token, and npm answers a bad token with **404**, so public packages appear to vanish.
- A repository is built **standalone** in CI. `workspace:*` only resolves inside the umbrella
  workspace; depend on the published version instead.
- **Each repository's own `pnpm-lock.yaml` is what CI installs from, and you cannot refresh it from
  inside the umbrella.** Add a dependency to a package and the umbrella install updates the *umbrella*
  lockfile, leaving the repo's committed one stale — CI then fails every job at
  `ERR_PNPM_OUTDATED_LOCKFILE`, install-time, before a single test runs. Plain `pnpm install` in
  `repos/<name>` walks up and attaches to the umbrella; `--ignore-workspace` skips `packages/*` and
  cheerfully reports nothing to do. Clone the repo somewhere outside the workspace and run
  `pnpm install --lockfile-only` there, then copy the lockfile back.
- Skipping a test because its infrastructure is missing is fine on a laptop and dishonest in CI.
  Fail when `process.env.CI` is set.

## Writing
Documentation — READMEs, guides, runbooks, `docs/`, and any procedure someone follows — uses the
`adhd-friendly-ste-technical-writer` skill in `.claude/skills/`: goal first, one action per step,
short sentences, conditions before commands, an observable result after every important action.
It is a house style inspired by ASD-STE100, not certified compliance — do not claim otherwise.
It governs documents for readers. Code comments and commit messages keep the voice they have.

## Quality bar
- `pnpm typecheck && pnpm lint && pnpm test && pnpm build` must pass before pushing.
- UI follows `shell/DESIGN.md` (Ink/paper design system) and must work in RTL (fa/ar) and dark mode.
- All user-facing strings go through i18n (Paraglide) — no hardcoded English in components.

## Keeping this file current
This file is how the next person — or the next agent — avoids repeating what we already worked out.
When you learn something durable, add it here **in the same commit as the change that taught you**:
- a trap that cost you time (a silent failure, a misleading error, a tool that lies about success)
- a convention you had to infer from reading several files
- a decision and the reason behind it, especially where the obvious choice is wrong
Keep it specific and short. Delete anything that stops being true — a stale note is worse than none.

---

# This repository: collab (real-time documents)

A Hocuspocus/Yjs server on **:4300**, path `/collab`. It owns no domain data: it authenticates the
editor against core, asks the module that owns the object whether they may read or write, merges the
edits and stores the result.

**Things worth knowing**
- Document names are `ws:<workspaceId>:<module>:<type>:<id>`. The name is what tells the service which
  workspace to check and which module to consult.
- A module grants access by exposing a `collab.access` procedure. A module that does not answer falls
  back to workspace membership, which keeps documents usable while that module is still being built.
- **The fallback is why a broken `collab.access` looks like a working one.** Its shapes live in
  `@kernhq/contracts` (`CollabAccessInput`, `CollabAccess`) precisely because the first module to
  implement it declared different ones: Zod rejected every call, the broker threw, and this service
  quietly granted plain membership instead. A test that registers the procedure without those schemas
  proves nothing — `src/tests/contract.test.ts` registers it the way a module does.
- **The database roles here are superusers, so RLS is invisible to an ordinary test.** A policy and no
  policy pass identically. Anything asserting isolation goes through `harness.restrictedPool()`, which
  connects as a `nosuperuser nobypassrls` role; `src/tests/isolation.test.ts` asserts that first.
- `kern_collab.documents` is migrated, not created on boot, and the runtime image has to **copy
  `migrations/`** — the folder is resolved relative to `dist/`, so an image without it starts and then
  dies on its first query.
- A timestamptz read through `db.execute` comes back as a *string* in Postgres' own format
  (`2026-08-24 13:06:20.12+00`), not a `Date` and not ISO 8601. It fails the contract's `Timestamp` on
  the way out of a procedure; normalise through `new Date(...)`.
- `collab.document.{state,apply,snapshot,delete,presence}` is how a module reaches a document from the
  server side — version history, export, restore, import. Yjs state is binary and the broker speaks
  JSON, so it crosses base64-encoded. `document.apply` goes through `openDirectConnection` so the
  update reaches whoever is editing rather than being overwritten by their next keystroke.
- **A browser authenticates with the session cookie, not a token.** The cookie is HttpOnly, so the
  page cannot read it to hand to `HocuspocusProvider`; it is attached to the upgrade request, and
  `onAuthenticate` reads it from `requestHeaders`. Bearer token first, cookie second — the same order
  and the same parsing as the chat gateway, deliberately, so the two agree about what a session is.
  Until this existed no browser could open a document at all.
- **`kernel.call` resolving `null` is not the same as rejecting.** `.catch` does not cover it, and
  `core.users.principal` answering "no such session" with `null` used to reach `principal.kind` and
  take down the handshake with a TypeError instead of refusing the connection.
- **To put a cookie on a test upgrade, subclass the global `WebSocket`.** Passing
  `HocuspocusProviderWebsocket` with a `WebSocketPolyfill` to the provider instead looks right, and
  the connection then never establishes — `src/testing/harness.ts` sets the global once and
  `connectWithCookie` varies the header through it.
- Hocuspocus 4 is `new Server(config)` — not `Server.configure()` — and it owns its own HTTP server, so
  health and metrics are served from the `onRequest` hook, where **rejecting** means "already handled".
- Merged state is written after edits settle (2s debounce, 15s ceiling). A plain-text snapshot is
  published periodically as `collab.document.updated` so modules can index prose without decoding the
  CRDT.
- `WebSocketPolyfill` belongs to `HocuspocusProviderWebsocket`, not `HocuspocusProvider`. Passing it to
  the provider is ignored (and rejected by the types); handing the provider a pre-built socket makes it
  stop managing the connection, so it never connects. Set the global `WebSocket` instead — that is what
  `src/testing/harness.ts` does.

**Running more than one**
- **`VALKEY_URL` is the whole switch.** Set, and `@hocuspocus/extension-redis` relays sync and
  awareness between instances and arbitrates persistence with a redlock, so a plain round-robin proxy
  is enough. Unset, and the service is one honest process — which is what `pnpm dev` and every
  single-instance suite is, deliberately: `src/testing/harness.ts` passes `VALKEY_URL: undefined` and
  that line must stay. `src/tests/cluster.test.ts` asserts both halves, and its
  control is what fails if anybody ever wires the extension unconditionally.
- **A stable `identifier` silently disables the whole thing, and every other test still passes.** The
  extension drops any message whose identifier equals its own, so two instances sharing one ignore
  each other completely and nothing is logged. It is `collab-${randomUUID()}` per process for that
  reason — do not tidy it into a readable constant. (It is length-prefixed with one byte on the wire,
  so it also has to stay under 255 bytes.)
- **Keep `@hocuspocus/server` and `@hocuspocus/extension-redis` on the same minor, and bump them
  together.** The extension declares the server and `@hocuspocus/common` as *dependencies*, not
  peers, so a range drift puts a second copy in the tree — and then `Hocuspocus`'s
  `error instanceof SkipFurtherHooksError` stops matching, so every store the redlock correctly
  skipped surfaces as a real failure.
- **A test that Postgres could satisfy proves nothing about the relay.** With the harness's normal
  50 ms debounce, the second instance would pick the text up from the database and the suite would
  pass with the extension deleted. `cluster.test.ts` sets a 30-second debounce and asserts the row is
  still empty at the moment the two clients agree. Do not "fix" a slow-looking cluster test by
  lowering that.
- **`[onStoreDocument] Another instance is already storing this document` on stderr is the lock
  working**, not a fault. Hocuspocus `console.error`s every hook rejection, including the expected
  `SkipFurtherHooksError`, so it bypasses the kernel logger and shows up in test output.
- **A read must never open a direct connection, because every direct connection stores.**
  `DirectConnection.disconnect()` schedules `onStoreDocument` unconditionally — that is what it is
  for, since a direct connection exists to write — and `unloadImmediately: false` only postpones it
  by the debounce rather than skipping it. The store hook is what publishes
  `collab.document.updated`, and quire's subscriber for that event calls `collab.document.state`
  straight back, so in a clustered instance a single read announced itself as an edit and the pair
  fed itself for as long as the process ran. `document.state` and `document.snapshot` now load
  through `hocuspocus.createDocument` and release through `unloadDocument`, which is the same load
  path — peers included — with no store attached to the way out. `document.apply` and
  `document.replace` keep the direct connection: they write, and they pay the extension's
  `disconnectDelay` to be durable by the time the call returns. A read does not await its unload,
  because quire calls `collab.document.snapshot` from inside an open Postgres transaction
  (`module-quire/src/server/services/versions.ts`).
- **`collab.document.updated` has exactly one trigger: Postgres reporting that the row moved.**
  `storeDocument` returns whether its upsert actually wrote — `returning name` yields nothing when
  either guard refuses — and the store hook publishes only then. That is what makes a
  read-and-announce loop *impossible* rather than merely absent: an event needs new bytes, a reader
  contributes none, so a subscriber that only reads cannot sustain a cycle whatever path a future
  read takes. It also keeps a deleted document quiet.
- **A client force-disconnected by `document.delete` reconnects its socket and never reopens the
  document.** `closeConnections` closes with `ResetConnection`; `HocuspocusProviderWebsocket`
  reconnects and reports `connected`, while the document-level provider stays `synced: false` and
  the server never re-creates the document. Harmless for a delete — the page is gone — but it means
  a browser client cannot stand in for the straggler in a test: nothing is stored at all, so the
  assertion never reaches the tombstone and passes with the tombstone deleted. Drive that store
  through `storeDocument`, which is what the other instance's store hook calls.
- **Three guards here are invisible to every reader in this service, so test them on the row.**
  `readDocument` and `loadDocument` both filter `deleted_at is null`, so a tombstone the straggler
  refilled looks exactly like one that stayed empty; and nothing a procedure returns exposes
  `updated_at` of a document that did not change. `harness.row()` reads the row itself, tombstones
  included, and is the only honest place to assert the upsert's `deleted_at is null` and
  `state is distinct from excluded.state`, or the `isEmptyState` early return. All three used to
  pass with the implementation deleted.
- **`harness.watchStores(service)` waits for the store itself.** Waiting for a *side effect* of a
  store cannot tell "the store has not happened yet" from "the store happened and the row refused
  it", which is the exact difference every guard on the upsert makes — so a test that only sleeps is
  green either way.
- **An ioredis client with no `error` listener takes the process down.** The extension attaches none
  to the clients it builds, and it builds them in its constructor — so the `createClient` factory is
  the only point guaranteed to be earlier than the first connection attempt.
- **A delete cannot be broadcast, so it is a tombstone.** `NatsEventBus.subscribe` shares one durable
  consumer across replicas of a service, so an event load-balances exactly the way an RPC does —
  there is no fan-out channel in this system. `deleteDocument` therefore blanks the prose and sets
  `deleted_at`, and `storeDocument`'s upsert carries `where deleted_at is null`, so an instance that
  still has the document open cannot write it back. The live copy keeps serving whoever is still in
  it until they leave; the row does not come back.
- **`document.presence` is per-instance on purpose.** It reports the connections on whichever
  instance the broker routed the call to. Aggregating properly needs a request/response fan-out over
  Valkey with a timeout, and nothing calls the procedure yet.
