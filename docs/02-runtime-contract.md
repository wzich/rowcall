# Runtime Contract

## Terminology

### Canvas

The Nodebook Canvas is the 2D interface where a user builds a program by
arranging Nodes and connecting them with Edges.

### Graph

A Graph is a directed acyclic graph of Nodes connected by Edges. In the initial
version, one Canvas contains one Graph.

### Node

A Node is a small block of Python code that can run on its own or as part of a
Graph. Nodes run in complete isolation with no hidden cross-Node state. A Node
can only access:

- variables it defines in its own code
- variables made available from directly connected upstream Nodes
- explicit user-provided inputs when the Node is a root in the current run

### Declared Outputs

Declared Outputs are the variable names a Node exports for downstream use. Not
all variables defined in a Node are exported. Only Declared Outputs are
available to downstream Nodes.

In v1, output values must be JSON-serializable so they can be transported
between the TypeScript runtime and the Python runtime and stored as run
artifacts.

### Edge

An Edge is a one-way connection between two Nodes. An Edge does not connect one
variable to another variable. It connects one Node to another Node.

All Declared Outputs from the upstream Node are made available to the downstream
Node as variables in its execution scope.

If a Node receives inputs from multiple upstream Nodes, all Declared Outputs
from those upstream Nodes are flattened into the downstream Node's scope.

If two upstream Nodes would provide the same variable name to the same
downstream Node, that is a validation error.

### Run

A Run executes Node code. There are three kinds of Runs:

- Run single node
- Run upstream to node
- Run graph

`Run upstream to node` includes the target Node itself.

`Run graph` executes the full Graph by planning from every sink Node and running
the combined dependency subgraph once.

`stdout` and `stderr` are captured and shown as part of a Node's run result, but
are not passed through Edges as Outputs.

If an upstream Node fails during a Run, execution stops and downstream Nodes do
not execute.

## Streaming Execution

Execution endpoints return the normal JSON `ExecutionResponse` by default. If a
client sends `Accept: text/event-stream`, the same endpoint streams
SSE-formatted events while the run is executing.

Streaming is supported by:

- `POST /run-node`
- `POST /run-to-node`
- `POST /run-graph`

The stream uses text frames with an event name and JSON payload:

```text
event: node_started
data: {"type":"node_started","runId":"...","nodeId":"a","index":0}
```

The current event sequence is:

- `run_started`
- `run_plan`
- `node_started`
- `node_completed` or `node_failed`
- `run_completed` or `run_failed`

`run_plan` contains the authoritative server-generated run plan. The UI uses it
to mark planned Nodes as queued before individual Nodes start running.

The final `run_completed` or `run_failed` event contains the full
`ExecutionResponse`, matching the non-streaming JSON response shape.

In the current runtime, `stdout` and `stderr` are still node-completion
artifacts. They are streamed as part of `node_completed` or `node_failed`, not
as live chunks while Python code is still running inside a Node.

The browser UI keeps one active run at a time. The API does not yet enforce
server-side concurrency or resource limits for direct callers; that should be
scoped to a future runtime/session/document model.

## Runtime Rules

### Validation Errors

These are errors that can be detected from the Graph structure before execution:

- duplicate Node IDs
- Edges that reference missing Nodes
- cycles in the Graph
- conflicting variable names from multiple upstream Nodes into the same
  downstream Node

### Runtime Errors

These are errors that can only be detected while executing Node code:

- a Declared Output name does not exist after the Node finishes executing
- a Declared Output value is not JSON-serializable
- the Python process exits with an error
