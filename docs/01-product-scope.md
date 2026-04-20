# NodeBook — Product Scope

## What is NodeBook?

NodeBook is a computational notebook where code lives in nodes on a visual canvas instead of a linear sequence of cells. Each node has explicit named inputs and outputs, so data flow is visible in the graph rather than hidden in shared state. This eliminates the class of bugs Jupyter users know well — re-run order mattering, variables silently persisting — and makes branching and exploration a first-class feature instead of an awkward workaround.

It feels like working in Figma. You open a URL, see a canvas, and start building.

---

## The Problem

Jupyter notebooks have a hidden state problem. When you re-run a cell, modify something out of order, or hand a notebook to a colleague, variables from earlier executions persist invisibly in the kernel. The notebook that "works" on your machine may not work when run top-to-bottom on someone else's. This is not a niche complaint — it is a fundamental property of the linear, stateful cell model.

The deeper problem is **exploratory divergence**: you have a working analysis up to some point, and you want to try two different approaches from there. In Jupyter, your options are to duplicate the entire notebook, comment out code, or overwrite and hope. None of these are good. NodeBook solves this with branching — you fork the graph from any node, and both approaches live side by side without interference.

---

## Core Concepts

### Nodes
A node is a small code editor containing a self-contained script. It declares explicit **outputs** — named values it produces. It receives **inputs** — named values made available from upstream nodes it is connected to. A node cannot access any state outside of those provided inputs. This makes execution order unambiguous and re-runs safe.

Nodes nudge users toward writing smaller, meaningful steps. The act of naming outputs forces intentionality: what does this node *do*? The canvas becomes self-documenting.

### The Graph
Nodes connect to each other by wiring one node to another node. All declared outputs from an upstream node become available to the downstream node. The resulting directed graph is the program. Execution order is determined by the graph structure, not by the order nodes were created or where they sit on the canvas.

### Branching
Any node can have multiple downstream nodes connected to it. This is how you explore two approaches from the same starting point — fork the graph. Both branches receive the same upstream outputs as inputs. Neither branch affects the other.

### Explicit Outputs
When a node runs, its declared outputs are serialized and captured by the runtime. These serialized values are what get passed downstream. This is what makes caching, reproducibility, and isolation possible. The contract between nodes is explicit and inspectable.

### Manual Execution
Nodes run when you ask them to. The initial version supports running a single node, running upstream to a target node, and running a whole graph. Root nodes can also receive explicit user-provided inputs at execution time. There is no automatic reactive re-execution in the initial version.

---

## Target Users

Data scientists and engineers who spend significant time in Jupyter notebooks and have experienced the pain of hidden state, re-run bugs, or wanting to try two approaches side by side without duplicating their work.

---

## What NodeBook Is Not

- Not a replacement for production pipelines (Airflow, Prefect, etc.)
- Not a collaborative document editor (no rich text, no prose between cells)
- Not a fully managed cloud notebook (no persistent compute in v1)
- Not trying to eliminate Jupyter — it is trying to solve the specific problems Jupyter creates for exploratory work

---

## Future Directions

These are not in scope for the POC but inform design decisions made today.

**Multiplayer** — multiple users can work on the same graph simultaneously, branching from shared nodes into their own exploration paths. Like Figma for computation.

**Caching** — node outputs are cached by a hash of the node's code and its input values. Re-running an unchanged node with unchanged inputs returns the cached result instantly.

**AI features** — nodes can collapse into AI-generated one-line descriptions of what they do (easy given explicit inputs/outputs). Code inside a node can be edited via natural language.

**Language support** — Python and TypeScript to start, other runtimes over time.

**Electron app** — for users who want local execution with full package support.
