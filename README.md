# collab

**Documents that several people edit at the same time.**

Two people typing in the same paragraph should both keep their words. This service is what makes
that true in [Kern](https://github.com/KernAIO/kern): it merges everyone's edits, keeps the result,
and hands it to whoever opens the document next.

It owns no data of its own. It authenticates the editor against core. It asks whichever module owns
the document whether this person may read or write it. Then it merges the edits and stores the
result.

## Run it

Goal: start collab on your own machine and connect an editor to it.

You need:

- Node 24 and pnpm 10.
- A Postgres 18 database.

Most people should run the whole platform from the
[umbrella repository](https://github.com/KernAIO/kern) instead. There, `pnpm setup && pnpm infra &&
pnpm dev` starts collab with everything it talks to.

### 1. Install and configure

```bash
pnpm install
cp .env.example .env
```

Set `DATABASE_URL` in `.env` to your Postgres database.

### 2. Start collab

```bash
pnpm dev
```

The service creates its own database tables the first time it starts.

**Expected result:** `migrations applied`, then the service listens on port 4300 at path `/collab`.

## How a document is addressed

A document name says everything the service needs:

```
ws:<workspaceId>:<module>:<type>:<id>
```

The name tells the service which workspace to check, and which module to ask about access. A module
answers by exposing a `collab.access` procedure. A module that does not answer falls back to plain
workspace membership, which keeps documents usable while that module is still being built.

## Things worth knowing

- **Nothing is saved on every keystroke.** Merged state is written after edits settle: two seconds
  of quiet, or fifteen seconds at the latest.
- **Search does not read the merged document.** A plain-text snapshot is published periodically as
  `collab.document.updated`, so a module can index the prose without decoding the merge structure.
- There is **no editor yet**. This service runs and is tested, but no Kern screen opens a document
  in it so far.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md). Licence: [AGPL-3.0](LICENSE).

Website: [kernaio.com](https://kernaio.com).
