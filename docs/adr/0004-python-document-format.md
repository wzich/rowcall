# ADR 0004: Use Python Files As The Canonical Nodebook Document

## Status

Proposed

## Context

The first Nodebook prototype stored node code as strings inside JSON files. That
made graph loading and canvas persistence simple, but it made user code harder
to review, search, refactor, lint, test, and edit outside the Nodebook UI.

Nodebook should feel like a visual editor for a real Python program, not like an
application-private document format that happens to contain Python snippets.
Users and agents should be able to work with the underlying Python file directly
while still benefiting from the graph editor.

The current runtime model remains valuable: nodes form an explicit directed
acyclic graph, nodes receive copied upstream outputs as inputs, nodes publish
declared outputs, and execution order is determined by graph structure rather
than notebook cell order.

## Decision

Python files will become the canonical computational document format for
Nodebook. A normal `.py` file can be opened by the editor without any sidecar
file. If no sidecar metadata exists, the editor may choose an automatic layout.

Nodebook may store optional canvas metadata in a sibling `.nodebook.json` file.
The sidecar is not the source of truth for computation. It stores UI-only data
such as node positions and future visual preferences. Deleting the sidecar must
not destroy or invalidate the computational document.

Nodebook nodes are persisted as Python functions decorated with `@node`.
Function names are human-readable and may change over time. Stable opaque node
IDs are stored separately in the decorator and are the durable identity used by
the editor, sidecar metadata, graph validation, and runtime references.

```python
from nodebook import node

@node(id="n_8x4k2p", outputs=["df"])
def read_data():
    df = pandas.read_csv("orders.csv")
    return {"df": df}

@node(id="n_91daw7", outputs=["df"])
def clean_data(df):
    df = df.dropna()
    return {"df": df}


# NodeBook graph
clean_data.depends_on(read_data)
```

Edges are explicit and should be declared in a graph block after node
definitions. Edges do not mutate downstream function signatures. Function
parameters declare which input names a node consumes; explicit edges declare
which upstream nodes may provide values. At runtime, Nodebook gathers outputs
from directly connected upstream nodes and passes matching values into the
downstream function.

Declared outputs are represented in the decorator and returned as a dictionary.
For normal Nodebook-authored nodes, the editor may generate the return
dictionary from the output declarations. Dictionary keys will usually match
local variable names, but the format leaves room for future output rename or
patching behavior.

```python
@node(id="n_ab12cd", outputs=["clean_df", "row_count"])
def clean_data(df):
    clean_df = df.dropna()
    row_count = len(clean_df)
    return {"clean_df": clean_df, "row_count": row_count}
```

The graph editor should let users write node bodies in a script-like style even
though the persisted document uses function-shaped nodes. The function wrapper,
parameters, decorator, and generated return block may be managed by Nodebook for
ordinary UI-authored nodes.

Nodebook-authored files remain normal Python files. Users and agents may edit
them directly. If raw edits change wrappers, signatures, or return statements,
Nodebook should validate the file on load and either accept the custom shape or
produce actionable validation errors. The first implementation should detect and
preserve custom returns, but it does not need to offer full UI editing for them.
Nodes with custom return control flow should be shown in the canvas as
custom-managed nodes: they remain visible and runnable, but UI actions that
would require safely regenerating return statements should be disabled or routed
through an explicit conversion flow.

Top-level imports, constants, helper functions, and classes are allowed. The UI
should eventually expose code outside node functions through a "Globals" section
in the graph inspector. Top-level mutable state is outside the isolated
data-flow guarantee and should be documented as advanced behavior.

Node functions should not call other node functions directly. Data dependencies
must flow through explicit graph edges so the canvas remains authoritative for
execution flow. Helper functions remain callable from node bodies.

If multiple upstream nodes connected to the same downstream node provide the
same output name, validation fails. This preserves the current explicit-input
contract and avoids ambiguous parameter binding.

## Consequences

- User code becomes reviewable and editable as ordinary Python.
- Agents can collaborate by editing Python directly instead of manipulating JSON
  strings.
- The editor can operate on a bare `.py` file and degrade gracefully when
  sidecar metadata is absent.
- Canvas layout and computation have separate ownership boundaries.
- The runtime graph contract can remain mostly stable while document loading
  evolves from JSON decoding to Python document discovery.
- File loading must distinguish graph definition from node execution: importing
  or parsing a document may execute top-level Python definitions, but node
  bodies should not run until requested by the runtime.
- Top-level Python code can be useful for imports and helpers, but mutable
  globals can undermine the data-flow model if users rely on them for shared
  state.
- Direct node-to-node function calls must be prevented or clearly rejected to
  keep the graph as the execution authority.
- Saving becomes more complex because Nodebook needs to preserve hand-written
  Python where possible while still managing generated wrappers and return
  blocks for UI-authored nodes.

## Implementation Notes

The migration should be staged.

1. Define a small Python `nodebook` authoring API that can register decorated
   node functions and explicit `depends_on` edges.
2. Build a Python document loader that turns a `.py` file into the existing
   runtime `Graph` shape plus document metadata.
3. Add optional sidecar loading for positions and UI-only state.
4. Update save behavior so normal UI-authored node edits regenerate the function
   body and return dictionary while custom returns are preserved or flagged with
   specific validation errors.
5. Remove persisted JSON document loading and saving once Python documents are
   the only canonical document format. Keep `.nodebook.json` sidecars because
   they store UI-only canvas metadata, not embedded node code.
6. Add file watching and reconciliation later so external `.py` edits can
   refresh the canvas without requiring a full restart. The Python file is the
   authority when it changes externally. If there are no unsaved canvas edits,
   the canvas should reload. If unsaved canvas edits exist, the first
   implementation may invalidate the draft and require the user to reload before
   saving again.

## Follow-On Decisions

- Use concrete-syntax editing rather than Python's built-in `ast` module for
  save operations that need to preserve comments and formatting. LibCST is the
  leading candidate for the first implementation because it supports
  format-preserving parsing and code generation.
- Create the `.nodebook.json` sidecar on first canvas save. A bare `.py` file
  remains sufficient to open and run the document.
- Treat external file writes as authoritative. Nodebook should reload cleanly
  when there are no unsaved canvas edits and should avoid overwriting newer
  external file contents with stale canvas state.

## Open Questions

- Should custom-managed nodes get a one-way "normalize this node" action that
  rewrites custom returns into the standard generated return dictionary shape?
- Should the first implementation depend on LibCST immediately, or should it
  start with a narrower parser/serializer and adopt LibCST when save behavior
  expands?
