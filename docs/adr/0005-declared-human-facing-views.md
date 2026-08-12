# ADR 0005: Use Declared Views For Human-Facing Results

## Status

Accepted and implemented.

## Context

Rowcall already distinguishes local variables from declared outputs. Outputs are
a data-flow contract: they are copied into downstream nodes and retained by the
runtime session. The earlier `display(...)` API introduced a second, imperative
result channel plus ordered `displays` and `outputEvents` telemetry. That made
the source contract and runtime response harder to understand, and it did not
provide a simple path to library-agnostic plots.

The product needs human-facing tables, values, and static visualizations, but it
does not yet need interactive JavaScript plots. At this stage, predictable
behavior and a small contract are more important than broad rendering support.

## Decision

Nodes declare ordered human-facing values with the optional `views` argument:

```python
from rowcall import node

@node(id="n_summary", outputs=["summary"], views=["summary", "chart"])
def summarize(data):
    summary = data.describe()
    chart = make_chart(summary)
    return {"summary": summary, "chart": chart}
```

`outputs` and `views` have different meanings:

- Outputs are available to directly connected downstream nodes.
- Views are rendered for a human and never enter downstream data flow.
- A name may appear in both lists. It is returned only once and is used for both
  purposes.
- The generated return dictionary contains the union in this order: outputs
  first, then views that are not already outputs.

The inspector manages both declarations. This keeps rich rendering explicit in
the document without requiring an imperative `display(...)` call in node code.
"View" is intentionally broader than "visualization": existing dataframe, JSON,
text, and `repr` previews remain valid views.

For static images, the runtime supports only PNG:

- Raw `bytes` or `bytearray` declared as a view are interpreted as PNG data.
- For any other declared view, the runtime calls `_repr_png_()` when that method
  exists and is callable.
- `_repr_png_()` is inspected and called only for declared views. Rowcall does
  not scan ordinary outputs or guess library-specific save/export methods.
- Invalid PNG data, an unsupported return value, or a rendering exception
  produces a warning and fallback value preview; it does not fail the node.
- PNGs are limited to 5 MiB per view, 20 MiB of raw PNG data per run, and 10
  declared views per node.

The app transports image bytes as base64 inside its runtime response and renders
them with a data URL. The public CLI never prints that base64. Console, full
JSON, summary JSON, and trace JSON retain image MIME type, dimensions, and byte
size and add `dataOmitted: true`.

The public `display(...)` function and the `displays` and `outputEvents`
response fields are removed rather than deprecated. There are no users to
migrate, and keeping both result models would add product and implementation
ambiguity.

## Consequences

- A node has one explicit returned-value model: the ordered union of outputs and
  views.
- Human-facing intent is visible to the editor, CLI, agents, and source review
  without executing code.
- Plotting-library integration stays library agnostic as long as the object can
  provide `_repr_png_()` or the node produces PNG bytes itself.
- Libraries that cannot already produce PNG bytes are not specially supported.
  Rowcall reports a bounded fallback preview/warning instead of adding image
  conversion dependencies.
- Static images have no tooltips, zoom protocol, selection callbacks, or
  JavaScript execution. Interactive/JS visualization support is deferred to a
  separate future decision.
- The CLI does not currently persist PNG artifacts to the filesystem. Agent
  image inspection can be revisited when there is a concrete workflow for it.
