# Rowcall — Product Scope

## What is Rowcall?

Rowcall is a computational notebook where code lives in nodes on a visual canvas
instead of a linear sequence of cells. Each node declares explicit named
outputs, while its inputs are derived from upstream graph connections, so data
flow is visible in the graph rather than hidden in shared state. This eliminates
the class of bugs Jupyter users know well — re-run order mattering, variables
silently persisting — and makes branching and exploration a first-class feature
instead of an awkward workaround.

It feels like working in Figma. You open a URL, see a canvas, and start
building.

---

## The Problem

Jupyter notebooks have a hidden state problem. When you re-run a cell, modify
something out of order, or hand a notebook to a colleague, variables from
earlier executions persist invisibly in the kernel. The notebook that "works" on
your machine may not work when run top-to-bottom on someone else's. This is not
a niche complaint — it is a fundamental property of the linear, stateful cell
model.

The deeper problem is **exploratory divergence**: you have a working analysis up
to some point, and you want to try two different approaches from there. In
Jupyter, your options are to duplicate the entire notebook, comment out code, or
overwrite and hope. None of these are good. Rowcall solves this with branching —
you fork the graph from any node, and both approaches live side by side without
interference.

---

## Core Concepts

### Nodes

A node is a small code editor containing a self-contained script. It declares
explicit **outputs** — named values it produces. It receives derived **inputs**
— named values made available from upstream nodes it is connected to. Root nodes
usually introduce data by reading files, defining constants, or calling ordinary
Python library APIs inside the document. A node executes in its own namespace,
so normal variables do not persist outside declared inputs and outputs. This
makes execution order unambiguous and re-runs safe while still allowing rich
Python objects to move through the graph in memory during a run.

Nodes nudge users toward writing smaller, meaningful steps. The act of naming
outputs forces intentionality: what does this node _do_? The canvas becomes
self-documenting.

### The Graph

Nodes connect by routing a particular stable named output to a downstream node.
The selected value becomes a same-named downstream input by default. The
resulting directed graph is the program. Execution order is determined by the
graph structure, not by the order nodes were created or where they sit on the
canvas.

### Branching

Any node can have multiple downstream nodes connected to it. This is how you
explore two approaches from the same starting point — fork the graph. Both
branches receive the explicitly routed upstream values as inputs. Neither branch
affects the other.

### Routed Outputs

Creating an outgoing route promotes its named source variable to an output.
Removing its final route demotes it again. The generated Python decorator and
return dictionary materialize that graph contract for execution; they are not a
second independently authored output declaration. During a run, downstream nodes
receive copies of those Python objects rather than JSON-serialized values.
Runtime responses expose JSON-safe previews such as name, Python type, `repr`,
and an optional small `jsonValue` for plain JSON-compatible values.

### Human-Facing Displays

A node may call bare `display(value, label="...")` to record ordered values for
a person to inspect rather than for downstream computation. Displays can use the
existing table, JSON, text, and value previews. Static PNGs are supported when
the displayed value is PNG bytes, supplies `_repr_png_()`, or is a supported
Matplotlib, Seaborn, Pillow, or Plotly object. Plotly rendering requires its
optional Kaleido and Chrome/Chromium export stack. Interactive JavaScript
visualizations and broader library adapters are intentionally deferred.

### Manual Execution

Nodes run when you ask them to. The invited beta supports freshly running the
complete dependency plan through a selected node or running a whole graph. The
public headless CLI validates and runs Python documents directly, with
full-graph runs as the default and targeted upstream runs available through an
exact node ID or Python function name. There is no automatic reactive
re-execution in the initial version.

---

## Target Users

Data scientists and engineers who spend significant time in Jupyter notebooks
and have experienced the pain of hidden state, re-run bugs, or wanting to try
two approaches side by side without duplicating their work.

---

## What Rowcall Is Not

- Not a replacement for production pipelines (Airflow, Prefect, etc.)
- Not a collaborative document editor (no rich text, no prose between cells)
- Not a fully managed cloud notebook (no persistent compute in v1)
- Not trying to eliminate Jupyter — it is trying to solve the specific problems
  Jupyter creates for exploratory work

---

## Future Directions

These are not in scope for the POC but inform design decisions made today.

**Multiplayer** — multiple users can work on the same graph simultaneously,
branching from shared nodes into their own exploration paths. Like Figma for
computation.

**Caching** — a future version may cache node outputs using the node's code and
upstream cache keys. A carefully designed cache could reuse valid upstream
Python objects while still only exposing routed values to downstream Nodes. The
invited beta does not implement this; all runs recompute their complete plans
afresh.

**AI features** — nodes can collapse into AI-generated one-line descriptions of
what they do (easy given explicit inputs/outputs). Code inside a node can be
edited via natural language.

**Language support** — Python and TypeScript to start, other runtimes over time.

**Electron app** — for users who want local execution with full package support.
