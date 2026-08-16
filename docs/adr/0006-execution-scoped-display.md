# ADR 0006: Use Execution-Scoped Display Results

## Status

Accepted and implemented.

## Context

Rowcall nodes provide a cell-like Python editing experience while hiding the
function decorator, signature, and generated return dictionary. ADR 0005 made
human-facing results into declared variable names selected in the inspector.
That forced presentation choices into document metadata and hidden return
plumbing, and it competed with the more direct notebook convention of displaying
a value at the point where it becomes meaningful.

Outputs remain a data-flow contract. Human-facing presentation must not publish
values downstream or broaden this decision into a redesign of graph inputs and
outputs.

## Decision

Node code may call a bare execution intrinsic:

```python
summary = data.describe()
display(summary)
display(make_chart(summary), label="Summary chart")
```

`display()` is available without an import in node code and in Document Globals
helpers called by a node. It is not exported as a general `rowcall` package API.
Each call accepts one value and an optional keyword-only string label. Empty
labels use the default `Display N` name. Labels need not be unique; array
position identifies the result.

Each call immediately creates a bounded preview. This snapshots mutable values
at call time and lets a failed node return displays recorded before its error.
Multiple calls are returned in call order. Every node execution produces a new
display array that replaces the prior execution's array. Stdout and stderr stay
separate; this decision does not add mid-node transport streaming or a combined
stdout/display event timeline.

Displays use the existing dataframe, JSON, text, `repr`, and static PNG preview
machinery. PNG support includes raw PNG bytes, `_repr_png_()`, Matplotlib,
Seaborn, Pillow, and Plotly when its optional export stack is installed.
Rendering failures become preview warnings rather than node failures. A node
execution records at most 10 displays. PNGs are limited to 5 MiB per display and
20 MiB per run.

Displays are response telemetry only. They are not included in the generated
return dictionary, copied to downstream nodes, or retained for interactive table
pagination. A displayed DataFrame receives the normal bounded initial table
preview. Rich pagination and sorting continue to require a retained output.

The `views` decorator argument, document field, rewrite operation, inspector
selection UI, and name-keyed runtime response are removed rather than
deprecated. There is no beta compatibility requirement.

## Consequences

- Presentation intent is colocated with the node code that produces the value.
- The document contract and hidden return plumbing contain only data-flow
  outputs.
- Snapshot and failure behavior match the cell-like execution model.
- Displayed outputs may appear twice in current result surfaces: once as an
  explicit display and once as an automatically inspected sink output. The UI
  may revisit that distinction alongside future output-routing work.
- Live mid-node output can be added later through the existing streamed run
  lifecycle, but it is not implied by the ordered final display array.
