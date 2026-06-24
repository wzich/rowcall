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
Graph. The current runtime uses namespace isolation: each Node executes with a
fresh Python namespace, so normal variables do not persist across Nodes unless
they are declared outputs and flow through Edges. A Node can access:

- variables it defines in its own code
- variables made available from directly connected upstream Nodes
- explicit user-provided inputs when the Node is a root in the current run, for
  lower-level runtime callers that provide them

Namespace isolation is not process isolation. Nodes in the same Run currently
share one Python process, so deliberate process-global side effects such as
mutating imported modules or `builtins` may be visible to later Nodes. The
runtime contract treats that as outside the normal data-flow model: portable
Nodebook programs should communicate through Declared Outputs and Edges.

### Declared Outputs

Declared Outputs are the variable names a Node exports for downstream use. Not
all variables defined in a Node are exported. Only Declared Outputs are
available to downstream Nodes.

During a Run, Declared Output values may be arbitrary Python objects. Downstream
Nodes receive copied values from upstream Declared Outputs so rich objects such
as data frames do not need to be serialized between Nodes. Runtime responses do
not return those Python objects directly. They return JSON-serializable
`ValuePreview` records containing the output name, Python type, truncated
`repr`, and optionally `jsonValue` when the value is a small plain
JSON-compatible primitive or container.

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

The runtime keeps an in-memory Python session cache for the active server
process. `Run graph` and `Run upstream to node` recompute their planned Nodes
fresh and refresh cache entries for every successful Node. `Run single node` is
for iterative development: it executes only the selected Node, using copied
outputs from valid cached upstream Nodes. If any required upstream cache entry
is missing or transitively stale, `Run single node` fails with `cache_miss`
instead of silently recomputing upstream Nodes.

Cache entries are valid only when the Node code, declared output names, explicit
root inputs, and upstream cache keys still match. Failed executions are not
cached. Successful `Run single node` executions refresh the selected Node's
cache entry so downstream Nodes can use the latest successful iteration.

The session cache is process-local and in memory only. It is lost when the
server restarts, and it can be cleared explicitly with
`POST /runtime-session/clear-cache`.

The beta headless CLI does not expose explicit root inputs. Public CLI runs are
intended to be reproducible from the Python document itself, so root data
sources should be modeled as normal Python code inside root Nodes. The
lower-level runtime API keeps explicit inputs available for internal callers and
future experiments.

Future runtime configurations may expose explicit isolation modes:

- process isolation, where Nodes run in separate processes and values must cross
  a serialization boundary
- namespace isolation, where Nodes share a Python process but get fresh
  namespaces and copied Declared Outputs
- no isolation, where Nodes intentionally share the same execution namespace

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

The Python runner writes runtime telemetry to its process stdout as
newline-delimited JSON. User code `stdout` and `stderr` are redirected while
each Node executes and included in that Node's completion event. Runtime preview
and copy operations also capture stdout and stderr before telemetry resumes, so
user-defined hooks such as `__repr__` cannot corrupt the runtime event protocol.

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
- the Python process exits with an error

If an input value cannot be copied into a downstream Node's namespace, the
runtime falls back to passing that value by reference and emits a warning in the
Node result. This fallback is intentionally visible because reference sharing
can make in-place mutation observable within the same Run. Future copy handlers
should minimize how often the fallback is needed.
