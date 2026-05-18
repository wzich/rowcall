# ADR 0003: Separate Nodebook Documents From Runtime Graphs

## Status

Accepted

## Context

The editor now needs to save a user's local work, including graph-editing state
such as node positions. The runtime graph contract should remain focused on
execution and validation, and should not grow UI-only fields or persistence
concerns.

The first save target is intentionally narrow: a single local scratch document
at `examples/scratch.nodebook.json`. General file picking, autosave, cloud
storage, collaboration, and execution-state persistence are out of scope for
this pass.

## Decision

Nodebook files use a versioned document shape:

```ts
type NodebookDocumentV1 = {
  version: 1;
  nodes: Array<{
    id: string;
    code: string;
    outputs: string[];
    position?: { x: number; y: number };
  }>;
  edges: Array<{ fromNode: string; toNode: string }>;
};
```

Document decoding is separate from runtime graph validation. The document
decoder checks that the JSON has an editable shape and a supported version.
Runtime validation still happens immediately before execution through
`/inspect`.

The UI adapts a document into a runtime graph by stripping document-only fields:

```ts
{
  nodes: document.nodes.map(({ id, code, outputs }) => ({ id, code, outputs })),
  edges: document.edges,
}
```

## Consequences

- Invalid-but-editable graphs can be saved.
- Execution remains strict and continues to reject invalid runtime graphs.
- Node positions are preserved in the saved document.
- Execution state, stale state, cached outputs, errors, and run history are not
  saved.
- Future storage options can reuse the same document format without changing the
  runtime contract.
