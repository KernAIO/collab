<p align="center">
<img src="https://raw.githubusercontent.com/KernAIO/app/main/assets/kern-mark.svg" width="56" alt="">
</p>

# collab

**Documents that several people edit at the same time.**

[![CI](https://img.shields.io/github/actions/workflow/status/KernAIO/collab/ci.yml?branch=main&label=CI&style=flat-square)](https://github.com/KernAIO/collab/actions/workflows/ci.yml)
[![Licence](https://img.shields.io/badge/licence-AGPL--3.0-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-pre--1.0-orange?style=flat-square)](https://github.com/KernAIO/app#what-works-today)
[![Last commit](https://img.shields.io/github/last-commit/KernAIO/collab?style=flat-square)](https://github.com/KernAIO/collab/commits/main)
[![Website](https://img.shields.io/badge/kernaio.com-1f2328?style=flat-square)](https://kernaio.com)

Two people typing in the same paragraph should both keep their words. This service is what makes
that true in [Kern](https://github.com/KernAIO/app): it merges everyone's edits, keeps the result,
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
[umbrella repository](https://github.com/KernAIO/app) instead. There, `pnpm setup && pnpm infra &&
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

## Run more than one

Goal: serve collaborative documents from more than one process, behind an ordinary load balancer.

Set `VALKEY_URL` on every instance. The self-host, Coolify and cloud compose files already do.

**Expected result:** each instance logs `collab service listening` with `clustered: true`.

The instances then relay edits and presence to each other through Valkey, and take a lock before
writing a document down. A plain round-robin proxy is enough — you do not need session affinity,
sticky sessions, or a consistent hash on the document name.

Without `VALKEY_URL` the service is one honest process. Two of those are two different documents,
and whoever lands on the wrong one loses their edits.

If two Kern deployments share one Valkey, give each of them its own `COLLAB_REDIS_PREFIX`. Every
channel and lock is `<prefix>:<documentName>`, so one prefix means one set of documents.

One thing stays per-instance: `collab.document.presence` reports the connections on whichever
instance answered the call, not on all of them. Nothing in Kern calls it yet.

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
- **A deleted document leaves a tombstone.** The prose goes at once; the row stays, holding only the
  name and timestamps. Another instance may still have the document open, and without the tombstone
  its next write would put the prose straight back.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md).

## Licence

[AGPL-3.0-only](LICENSE). This repository is part of the Kern product.
The Kern framework you build modules against is Apache-2.0 — see
[LICENSING.md](https://github.com/KernAIO/app/blob/main/LICENSING.md).

---

**Kern** — one place for your team's work: issues, conversations, documents and people.
Open source, self-hosted. [kernaio.com](https://kernaio.com) · [github.com/KernAIO](https://github.com/KernAIO)
