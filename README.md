# Kern collab service

Real-time collaborative editing for Kern documents, built on [Hocuspocus](https://tiptap.dev/hocuspocus)
and Yjs. Part of [Kern](https://github.com/KernAIO/kern).

This service owns no domain data. It authenticates the editor against core, asks the module that owns
the object whether the user may read or write, merges everyone's edits, and stores the result so a
document survives the last editor closing their tab.

## Document names

`ws:<workspaceId>:<module>:<type>:<id>` — for example `ws:0190…:docs:page:0191…`.

The name tells the service which workspace to check membership in and which module to consult.

## How a module grants access

Expose a `collab.access` procedure from the module that owns the object:

```ts
procedures: {
  'collab.access': {
    input: z.object({ workspaceId: z.string(), type: z.string(), id: z.string(), userId: z.string() }),
    handler: async (input, { kernel }) => ({ canRead: true, canWrite: false }),
  },
}
```

Workspace membership is checked first, so a module only decides object-level access. A module that
does not answer falls back to membership, which keeps documents usable while it is still being built.
Read-only participants stay connected and see live edits; they simply cannot change anything.

## Persistence and search

Merged state is written to `kern_collab.documents` after edits settle (2s debounce, 15s ceiling).
Every few minutes a loaded document also publishes `collab.document.updated` with a plain-text
snapshot, so modules can index prose for search without decoding the CRDT.

## Development

```bash
pnpm dev   # ws://localhost:4300/collab, health at /api/health
```

Requires Postgres and the core service; `pnpm infra` in the umbrella repo starts the dependencies.
