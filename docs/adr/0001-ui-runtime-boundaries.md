# ADR 0001: Separate Graph Sources From Runtime Graphs

## Status

Accepted

## Context

Nodebook needs to support multiple ways of obtaining a graph over time: bundled
examples, local files, pasted JSON, local workspace documents, and hosted
documents associated with users. The canvas should not need to know which
storage mechanism produced the graph.

The runtime already has a contract for validating and interpreting graphs
through `/inspect`.

## Decision

The UI will model "where a graph comes from" as a graph source, then load that
source through an API boundary. Components should render inspected runtime graph
data, not local file paths, remote document IDs, or raw JSON import details.

For now, example sources map to server-local files in `examples/`. That mapping
is an implementation detail of the source-loading layer, not a canvas concern.

## Consequences

- Local and hosted graph storage can evolve behind the same UI-facing source
  abstraction.
- The canvas stays focused on rendering validated graph data.
- Arbitrary local paths should not become product UX until there is a workspace
  and permission model.
- Temporary source adapters should be marked with TODOs when they are expected
  to be replaced.
