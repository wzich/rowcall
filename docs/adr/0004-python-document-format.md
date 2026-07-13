# ADR 0004: Use Python Files As The Canonical Nodebook Document

## Status

Accepted and implemented for the beta runtime split.

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

Python files are the canonical computational document format for Nodebook. A
normal `.py` file can be opened by the editor without any sidecar file. If no
sidecar metadata exists, the editor may choose an automatic layout.

For first-run CLI UX, Nodebook recommends folder-backed projects:
`nodebook new my-work` creates `my-work/graph.py`, and public CLI folder paths
resolve to `graph.py` inside the folder. This keeps generated canvas metadata
and future `data/` files close to the document without making users manage a
loose sidecar on the Desktop. Passing a `.py` path remains supported for users
who want a standalone Python document or multiple documents in one folder.

Nodebook may store optional canvas metadata in a sibling `.nodebook.json` file
named after the Python source file. The sidecar is not the source of truth for
computation. It stores UI-only data such as node positions and future visual
preferences. Deleting the sidecar must not destroy or invalidate the
computational document. For example, `graph.py` uses `graph.nodebook.json`, and
`explore.py` uses `explore.nodebook.json`.

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
definitions. Function parameters declare which input names a node consumes;
explicit edges declare which upstream nodes may provide values. At runtime,
Nodebook gathers outputs from directly connected upstream nodes and passes
matching values into the downstream function. For standard editor-authored
nodes, UI graph/output edits may normalize downstream function signatures to
match direct upstream outputs. Custom-return nodes are left as authored; graph
operations that would change their input dependency surface are rejected.

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
Nodebook validates the file on load and either accepts the custom shape or
produces actionable validation errors. The beta implementation detects and
preserves custom returns, but it does not offer full UI editing for them. Nodes
with custom return control flow are custom-managed nodes: they remain visible
and runnable, but UI actions that would require safely regenerating return
statements or changing input dependencies are disabled.

Top-level imports, constants, helper functions, and classes are allowed. The UI
should eventually expose code outside node functions through a "Globals" section
in the graph inspector. Top-level mutable state is outside the isolated
data-flow guarantee and should be documented as advanced behavior.

`from nodebook import ...` is intentionally strict because those imports are
removed from globals before execution. It may only import `node` and `display`,
without aliases. Other Nodebook package symbols should be referenced through a
module import such as `import nodebook` or `import nodebook as nb`, which is
preserved in document globals.

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
  sidecar metadata is absent, while the CLI can recommend folder-backed
  `graph.py` projects for first-time users.
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

The implemented split uses these boundaries:

1. A small Python `nodebook` authoring API declares node functions and explicit
   `depends_on` edges.
2. The Python document package parses a `.py` file into an executable document
   with source, globals, nodes, edges, validation issues, and planning metadata.
3. The Python runtime owns source-backed validation, graph planning, execution,
   value previews, stdout/stderr capture, display events, and CLI behavior.
4. The Deno/Hono app server owns editing APIs, startup configuration, and the
   browser-facing API. Document operations and execution call the Python runtime
   worker. Selected-node runs freshly execute the complete upstream plan through
   that node; the invited beta has no execution cache.
5. Normal UI-authored edits are sent as operation batches. The Python document
   package owns source rewrites for node bodies, output declarations, function
   names, node additions/deletions, graph edges, and globals. Custom returns are
   preserved or flagged with specific validation errors.
6. `.nodebook.json` sidecars remain UI-only metadata. They are not required to
   validate or run a Python document, but the app-facing revision includes
   normalized sidecar metadata so position/title/description edits participate
   in stale-write detection.
7. The app polls document status while the editor is open. The status response
   includes the app-visible revision, source revision, sidecar revision, and
   validation issues when the file is temporarily unreadable. If the on-disk
   document changes and there are no unsaved canvas edits, the app reloads it
   automatically. If there are unsaved canvas edits, the app warns before
   discarding them. Full filesystem watching, operation replay, and merge
   reconciliation remain future work.

## Follow-On Decisions

- Consider concrete-syntax editing for future operations that need broader
  comment and formatting preservation. The beta implementation uses constrained
  Python-owned source rewrites for supported editor operations.
- Create the `<document-name>.nodebook.json` sidecar on first canvas save. A
  bare `.py` file remains sufficient to open and run the document.
- Treat external file writes as authoritative. Nodebook should reload cleanly
  when there are no unsaved canvas edits and should avoid overwriting newer
  external file contents with stale canvas state.
- Keep proactive external-change detection independent from save-conflict
  protection. Status polling improves the local collaboration UX, but
  `POST /document/operations` still rejects stale base revisions before writing.

## Open Questions

- Should custom-managed nodes get a one-way "normalize this node" action that
  rewrites custom returns into the standard generated return dictionary shape?
