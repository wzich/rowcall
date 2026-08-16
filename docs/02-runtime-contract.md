# Runtime Contract

## Terminology

### Canvas

The Rowcall Canvas is the 2D interface where a user builds a program by
arranging Nodes and connecting them with Edges.

### Document

A Rowcall document is a Python source file. The Python source is the canonical
executable artifact: it contains `@node(...)` declarations, node functions, and
top-level `depends_on(...)` graph edges. The launcher recommends folder-backed
projects created with `rowcall new my-work`, which produces `my-work/graph.py`;
folder paths in the public CLI resolve to `graph.py` inside that folder. Passing
a `.py` path uses that exact file.

Optional `.rowcall.json` sidecars store editor metadata such as canvas positions
and are ignored by the runtime. Sidecars are named after the Python document, so
`graph.py` uses `graph.rowcall.json`, while an alternate `explore.py` in the
same folder uses `explore.rowcall.json`.

### Graph

A Graph is a directed acyclic graph of Nodes connected by Edges. The app may
derive an in-memory graph from Python source for editing and visualization. The
runtime parses source into an executable graph before planning and execution.

### Node

A Node is a small block of Python code that can run on its own or as part of a
Graph. The current runtime uses namespace isolation: each Node executes with a
fresh Python namespace, so normal variables do not persist across Nodes unless
they are declared outputs and flow through Edges. A Node can access:

- variables it defines in its own code
- named values routed from directly connected upstream Nodes
- top-level document globals, imports, and helpers evaluated once for the run

In source-backed Rowcall documents, every node function parameter must match a
target input named by a direct incoming route. Root nodes cannot declare
parameters. Node functions may use only the `@node(...)` decorator; additional
Python decorators are rejected because the strict runtime owns node invocation.
`from rowcall import ...` declarations may only import `node`, and may not use
aliases. For other package symbols, use a module import such as
`import rowcall as nb`.

Namespace isolation is not process isolation. Nodes in the same Run currently
share one Python process, so deliberate process-global side effects such as
mutating imported modules or `builtins` may be visible to later Nodes. The
runtime contract treats that as outside the normal data-flow model: portable
Rowcall programs should communicate through Declared Outputs and Edges.

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

### Displays

Bare `display(value, label="...")` calls record ordered, human-facing results
for the currently executing Node. Displays are snapshot previews created at call
time. They are never added to the Node's returned outputs or provided to
downstream Nodes. Each execution replaces that Node's previous display list, and
displays recorded before a later execution error remain in the failed result.

Displays use the same dataframe, JSON, text, and `repr` preview machinery as
outputs. A displayed `bytes`/`bytearray` value, an object with a callable
`_repr_png_()` method, or a supported plotting object can additionally produce a
static PNG preview. Supported plotting objects include Matplotlib figures and
axes, Seaborn objects backed by Matplotlib, Pillow images, and Plotly figures
when Plotly's optional Kaleido and Chrome/Chromium static export stack is
available. Rowcall does not invoke rich rendering for ordinary outputs.
Rendering failures become preview warnings rather than node failures.

Rowcall workers force Matplotlib's non-interactive `Agg` backend. Consequently,
`plt.show()` cannot open a native GUI or block the worker; authors should pass
the figure or axes to `display()` instead.

Each Node execution records at most 10 displays. PNG data is limited to 5 MiB
per display and 20 MiB per Run. The app response carries accepted image bytes as
base64; the public CLI omits those bytes and exposes only image metadata.

### Edge

An Edge is a one-way route from one stable named output to one downstream input.
The document stores `fromNode`, `fromOutput`, `toNode`, and `toInput` for every
route. Creating the first route from a source variable promotes it into the
generated output contract; deleting its final route removes it from that
contract. Runtime values and dictionary members never become graph nodes.

The common same-name form binds the selected output to an input of the same
name:

```python
fit_model.depends_on(split_data.output("train"))
```

An optional keyword alias preserves a different stable downstream input name:

```python
fit_model.depends_on(training_data=split_data.output("train"))
```

Multiple routes may connect the same node pair, and one output may fan out to
multiple downstream nodes. A downstream input may have only one incoming route.

### Run

A Run executes Node code. There are two execution plans:

- Run selected node and its upstream dependencies
- Run graph

The selected-node plan includes the target Node itself and every transitive
upstream dependency required by that Node.

`Run graph` executes the full Graph by planning from every sink Node and running
the combined dependency subgraph once.

`stdout` and `stderr` are captured and shown as part of a Node's run result, but
are not passed through Edges as Outputs.

If an upstream Node fails during a Run, execution stops and downstream Nodes do
not execute.

App runs are source-backed. Before a run, the canvas flushes pending document
operations; the server then executes either explicit request `source` or the
active Python file on disk. The server does not render client-authoritative
editable document models for execution. The Python runtime worker parses,
validates, plans, and executes source with the active document path as file
context.

The invited beta has no execution cache. Every selected-node run parses the
current source and freshly executes the complete upstream dependency plan
through the selected Node. The legacy `POST /run-node` route is a compatibility
alias for that same plan and retains `run_node` response labeling, but it does
not execute a distinct single-node plan or reuse prior outputs.
`POST /runtime-session/clear-cache` likewise remains a compatibility endpoint
and reports that caching is disabled.

The beta headless CLI does not expose explicit root inputs. Public CLI runs are
intended to be reproducible from the Python document itself, so root data
sources should be modeled as normal Python code inside root Nodes.

Source-backed app and worker runs follow the same rule. App requests do not send
external inputs. Direct callers that send non-empty `inputs` to source-backed
run endpoints receive `invalid_request` instead of having those inputs ignored.

## Document Operations

The browser-facing write API applies operation batches rather than replacing a
whole document projection. `POST /document/operations` accepts a base revision
and ordered operations such as node body/output updates, node/function additions
and deletions, edge changes, globals edits, and sidecar metadata changes. The
request has no idempotency key and must not be replayed after an uncertain
response; reload the document first. The server rejects stale base revisions,
calls the Python runtime worker's `apply_operations` operation to rewrite
source, writes the returned Python source and `.rowcall.json` metadata, and
reloads the canonical document response. Graph and output operations normalize
standard editor-authored downstream function signatures to match routed target
input names. Documents with unsupported return structures fail validation before
an operation batch can be applied.

External `GET /document` and `GET /document/status` reads are ordered after all
document operations already accepted by the server. An explicit reload after an
uncertain save therefore waits for that save's terminal state instead of
returning an earlier snapshot that the save could subsequently replace.

The app-visible document revision includes both Python source and normalized
sidecar metadata so UI-only edits such as node position changes participate in
stale-write detection. The lower-level Python parser revision remains the source
hash used by CLI/runtime code.

## Document Status

The app polls `GET /document/status` while a document is open. The response
reports the active path, app-visible revision, source revision, sidecar
revision, whether the current source is valid, and any validation issues from
the latest status inspection. The server may cache status responses by
source/sidecar revision so unchanged polling does not repeatedly re-inspect the
Python document.

Status polling is a user-experience layer on top of optimistic concurrency. If
the status revision differs from the editor's loaded base revision and the
canvas has no unsaved edits, the app reloads from disk automatically and shows a
short "Updated from disk" notice. If local unsaved edits exist, the app keeps
the canvas state and shows a warning before the user chooses to reload and
discard those edits. If the external file is temporarily invalid, the app keeps
the current canvas visible and continues checking until the file becomes
readable.

Before save and run actions, the app performs a fresh status check. A stale or
unreadable on-disk document blocks the action until the editor reloads or the
file becomes valid. The server-side stale revision check on
`POST /document/operations` remains the authoritative write guard.

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

Disk-backed HTTP runs must include the `expectedRevision` returned by the loaded
document. The server reads and checks that same snapshot before starting
execution, and returns `stale_document` if the displayed revision no longer
matches. A caller that intentionally supplies an explicit `source` string does
not need `expectedRevision`.

The stream uses text frames with an event name and JSON payload:

```text
event: node_started
data: {"type":"node_started","runId":"...","nodeId":"a","index":0}
```

For worker-backed execution APIs, the event sequence is:

- `run_started`
- `run_plan`
- `node_started`
- `node_completed` or `node_failed`
- `run_completed` or `run_failed`

`run_plan` contains the authoritative server-generated run plan. The UI uses it
to mark planned Nodes as queued before individual Nodes start running.

The final `run_completed` or `run_failed` event contains the full
`ExecutionResponse`, matching the non-streaming JSON response shape.

In the current runtime, `stdout` and `stderr` are still node result artifacts.
They are included in node results, not streamed as live chunks while Python code
is still running inside a Node.

The Python runtime worker writes runtime telemetry to its process stdout as
newline-delimited JSON. User code `stdout` and `stderr` are redirected while
each Node executes and included in that Node's result. Runtime preview and copy
operations also capture stdout and stderr before telemetry resumes, so
user-defined hooks such as `__repr__` and `_repr_png_` cannot corrupt the worker
protocol.

The browser UI keeps one active run at a time. The API does not yet enforce
server-side concurrency or resource limits for direct callers; that should be
scoped to a future runtime/session/document model.

## Runtime Rules

### Validation Errors

These are errors that can be detected from the Graph structure before execution:

- duplicate Node IDs
- Edges that reference missing Nodes
- cycles in the Graph
- routes whose named source variable is unavailable
- multiple routes that claim the same downstream input

### Runtime Errors

These are errors that can only be detected while executing Node code:

- a routed output name does not exist after the Node finishes executing
- the Python process exits with an error

If an input value cannot be copied into a downstream Node's namespace, the
runtime falls back to passing that value by reference and emits a warning in the
Node result. This fallback is intentionally visible because reference sharing
can make in-place mutation observable within the same Run. Future copy handlers
should minimize how often the fallback is needed.
