# ADR 0003: Separate Nodebook Documents From Runtime Graphs

## Status

Accepted

## Context

The editor now needs to save a user's local work, including graph-editing state
such as node positions. The runtime graph contract should remain focused on
execution and validation, and should not grow UI-only fields or persistence
concerns.

The local runtime edits one active document selected when the server starts. The
default development document is `examples/scratch.nodebook.json`, and callers
can provide another `.nodebook.json` path. General file picking, autosave, cloud
storage, collaboration, conflict detection, and execution-state persistence are
out of scope for this pass.

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

The browser loads and saves the active document through `/document`. The server
owns the active document path and disk I/O; the browser owns unsaved editing
state until the user saves. If the active document path does not exist at
startup, the server creates a new document with one blank node and no edges.

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
- Save overwrites the active document without conflict detection.
- Future storage options can reuse the same document format without changing the
  runtime contract.
