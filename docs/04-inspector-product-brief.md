# Inspector Product Brief

## Status

Working product alignment for the invited-beta inspector. This document is
intentionally narrower than a complete UI specification. It defines the jobs the
inspector must support, their priority, and the interaction model we want to
test with early users.

## Product decision

The inspector is a **contextual workbench for the selected node**, not a generic
properties panel.

Its primary job is to make the transformation loop fast:

> observe inputs -> edit code -> run -> inspect outputs -> repeat

That loop should be possible without scrolling a long document, or reaching for
the mouse. Other inspector features should not compete with this loop for
permanent space.

The inspector has three user modes:

1. **Develop** -- change a transformation and compare its before and after.
2. **Overview** -- understand the node's purpose, contract, and place in the
   graph.
3. **Results** -- inspect the complete record of what a run produced.

These modes are good candidates for top-level tabs. Inputs, code, and outputs
are not top-level tabs because the Develop mode needs all three at the same
time.

## Jobs and user stories

### P0: Iteratively develop a transformation

**Job to be done**

When I am writing a node, I want to see representative inbound values, edit the
transformation, run through the node, and immediately see representative
outbound values so that I can tell whether the transformation is correct.

**Core user stories**

- As an author, I can see a compact preview of the selected input while I edit
  the node's code. For a dataframe, this preview includes actual cell values,
  not only schema metadata.
- As an author, I can see a compact preview of the selected declared output at
  the same time as the input and code. For a dataframe, this also includes
  actual cell values.
- As an author, I can switch among multiple inputs or outputs without leaving
  the development workspace.
- As an author, I can run through the node from the keyboard and keep my editor
  focus.
- As an author, I can immediately tell whether the visible previews are fresh,
  stale, missing, running, or failed.
- As an author, I can see the most useful error near the output area after a
  failed run, without losing my code or input context.
- As an author, I can correct the node's declared-output contract when the code
  and declaration disagree, but contract controls do not need permanent space
  when the contract is valid.

**MVP success criteria**

- After selecting a node, the common edit/run/inspect loop requires no mouse.
- One representative input preview, the code editor, and one representative
  output preview fit in a typical laptop viewport.
- Dataframe previews show representative rows and cell values. Shape, column
  names, and dtypes supplement the rows; they do not replace them.
- A completed run updates the output preview in place.
- Preview provenance and freshness are unambiguous. A prior-run preview must
  never look like the result of the current code.
- Source nodes and nodes with non-tabular values degrade gracefully rather than
  leaving confusing empty panes.

### P0: Diagnose a failed iteration

This is part of iterative development, but it deserves explicit treatment
because failures change the layout's information priority.

**Job to be done**

When a run fails, I want to understand whether the problem is in this node, an
upstream node, or document setup, and see the actionable Python error so that I
can return to editing quickly.

**Core user stories**

- As an author, I can distinguish a node failure from an upstream or Document
  Globals failure.
- As an author, I can see the exception message and relevant stderr without
  searching through several sections.
- As an author, I can navigate to the failing upstream node when this node did
  not execute.
- As an author, my last successful output remains identifiable as historical
  context rather than disappearing or masquerading as fresh output.

### P1: Understand an unfamiliar node

**Job to be done**

When I select a node I did not just write, I want a concise explanation of what
it receives, what it does, what it produces, and where those values go so that I
can understand the graph without reverse-engineering every line of code.

**Core user stories**

- As a reader, I can see the node's name and human-authored description.
- As a reader, I can see its upstream nodes, downstream nodes, inputs, and
  declared outputs as a compact contract.
- As a reader, I can inspect representative input and output shapes, column
  names, and types without opening the code editor.
- As a reader, I can navigate directly to a neighboring node.
- As a reader, I can open the code when the summary is insufficient.

A generated natural-language summary may eventually improve this mode, but it is
not required for the MVP. The explicit contract and representative previews
should carry the first version.

### P1: Inspect run results and artifacts

**Job to be done**

When a node produces something meant for human inspection, I want to find and
view it quickly so that tables, plots, printed diagnostics, warnings, and errors
are useful parts of the analysis rather than hidden runtime details.

**Core user stories**

- As an author, I can inspect all declared outputs from the latest run.
- As an author, I can inspect ordered displays and stdout/stderr.
- As an author, I can give a table or visualization most of the available panel
  space when I need to examine it closely.
- As an author, I can distinguish declared data-flow outputs from human-facing
  displays.
- As an author, I can tell which run produced an artifact and whether it is
  stale.

The runtime exposes output previews, ordered displays, stdout, stderr, warnings,
and errors. Displays can render static PNGs from raw bytes or `_repr_png_()`.
Rich interactive plots remain outside this inspector iteration.

### P2: Configure and manage a node

**Job to be done**

When the node's identity or contract needs maintenance, I want to change it
without those infrequent controls crowding the development workspace.

This includes renaming, editing the description, managing declared outputs,
viewing advanced trace information, and deleting the node. Invalid declared
outputs are elevated into the P0 development flow; the rest can live in an
overflow menu, drawer, or secondary surface.

## Proposed information architecture

### Develop tab: the default

Use a vertical three-pane layout within one viewport:

1. **Input peek** -- compact table/value preview with actual sampled values, an
   input selector, provenance, shape, schema, and freshness.
2. **Code editor** -- the largest pane and the flexible consumer of remaining
   height.
3. **Output peek** -- compact table/value/error preview with an output selector
   and run status.

The input and output panes should start small, not collapsed. Each can expand,
and expanding one may temporarily compress or cover the editor. Pane sizing can
be resizable later; the MVP can begin with deliberate fixed defaults.

A reasonable starting budget for a 900px-tall application viewport is:

- inspector header and tabs: 88-112px
- input peek: 120-160px
- code editor: at least 320px, then flex to fill available space
- output peek: 140-200px

The primary Run Through Step action belongs in the compact inspector header,
next to the close action. It should not consume a separate row beneath the
editor or output preview.

The preview panes are not intended to be full dataframe explorers, but actual
values are non-negotiable. They answer "what am I working with?" and "did this
transformation do the right thing?" with a small row sample plus column names,
types, shape, and a clear truncation affordance. Filters, joins, parsing, null
handling, and value transformations cannot be evaluated from schema alone. The
Results tab provides the larger inspection surface.

For multiple inbound nodes or values, keep the input pane at a fixed height and
show one preview at a time. Use variable tabs when there are a few inputs. Each
tab is the inbound variable name; provenance such as `from clean_orders` lives
inside the selected preview rather than consuming another tab level. If the tab
strip overflows, scroll it horizontally or collapse it into a compact selector
rather than wrapping and stealing vertical space. Do not stack every dataframe
vertically.

Remember the last selected input per node if that is cheap; otherwise choose the
first tabular value, then the first value. Apply the same model to multiple
declared outputs. Simultaneous side-by-side comparison of two inputs may be
useful later, but it is not required for the first friend release.

The Develop output strip includes a compact **Expose** action. It offers locals
assigned in the node first and pass-through inputs second. Choosing a value adds
it to the node's output contract and selects its new preview tab; it does not
require a trip to Overview. Full contract review and removal remain in Overview
for the MVP.

### Overview tab

Optimize for reading rather than editing:

- node name and description
- concise input -> transformation -> output contract
- upstream and downstream navigation
- input/output names, Python types, table shapes, and columns
- code hidden by default, with an explicit way to open it

This mode should answer "what role does this node play?" It should not become a
second graph overview or reproduce every run detail.

### Results tab

Show the complete latest run record:

- declared outputs
- ordered displays
- stdout and stderr
- warnings and errors
- optional execution trace under an advanced disclosure

Individual results should be expandable to use the full panel. This is the
natural home for future plots and richer media.

### Persistent chrome

Keep only information needed across modes:

- node name and compact identity
- close/back-to-graph action
- run state
- primary Run Through Step action
- Develop / Overview / Results tabs

Put rename, description editing, delete, trace, and other low-frequency actions
behind contextual or overflow controls unless an error makes one immediately
relevant.

## Important interaction rules

1. **Freshness is part of the data.** Every preview needs a visible state:
   fresh, stale, running, failed, or unavailable.
2. **Preserve context across runs and edits.** Running should not blank the
   panes or move the editor. When an edit invalidates an existing preview, keep
   it visible but faded and explicitly marked stale until the node is rerun.
3. **Errors replace priority, not context.** Elevate the error in the output
   pane while preserving input and code.
4. **Keyboard is a first-class path.** Run, move focus among input/code/output,
   and switch previewed values without requiring the mouse.
5. **One representative value beats every value at once.** Selectors and
   expansion are preferable to long stacks of cards.
6. **Differentiate contracts from displays.** Declared outputs flow to other
   nodes; `display()` results exist for the human. The interface should use
   those terms consistently.
7. **The graph owns topology.** The inspector provides compact neighbor context
   and navigation, not a miniature duplicate of the canvas.

## Graph inspector alignment

The graph inspector has a narrower job than the node inspector. It supports
shared setup and full-graph execution; it does not repeat topology that is
already legible and navigable on the canvas.

It has two tabs:

1. **Overview** -- edit Document Globals and see graph-level setup errors.
2. **Results** -- inspect the latest full-graph run, displays, and sink outputs.

The Overview tab begins with the Document Globals editor. Node, edge, source,
and sink counts are omitted, as are source/sink navigation lists and declared
sink-output summaries. The graph canvas is the primary navigation and topology
surface.

Starting **Run graph** automatically opens Results. Graph Results represent only
a full `run_graph` execution. A `run_to_node` execution updates the relevant
node inspectors and notification state, but never replaces graph Results.

Successful graph Results show displays from executed nodes followed by sink
outputs. They use flat result tabs and the richest preview currently available.
The selected preview identifies and links to its originating node. Duplicate
names are disambiguated with their node names.

Any graph or Document Globals edit makes the latest completed graph result
stale. Keep that result visible but faded and clearly labeled until the next
full graph run. Partial node runs do not make a stale graph result fresh.

Failures take priority in Results. A node failure links directly to the failed
node; a Document Globals failure links directly back to Overview. Trace and
other diagnostics remain secondary to status, failure location, displays, and
sink outputs.

## MVP recommendation

Build and test the **Develop tab first**. Retain current functionality through
simple secondary Overview and Results tabs, but do not spend the first design
cycle polishing every state equally.

The minimum useful slice is:

1. input peek + code editor + output peek in one viewport
2. actual sampled dataframe rows in both preview panes
3. fixed-height input/output tabs or selectors for multiple values
4. clear freshness and run status
5. keyboard run with stable focus
6. inline failure presentation
7. larger result inspection through the Results tab

Defer generated summaries, sophisticated pane resizing, persisted layout
preferences, rich trace visualization, and a full dataframe explorer until
friend testing demonstrates demand.

## Questions to answer through friend testing

- Can users correctly identify whether an input or output preview is fresh?
- Is 5-10 actual preview rows enough to judge common dataframe transformations,
  and is a head sample the right default?
- Do users need to compare more than one input or output simultaneously?
- Is the vertical sandwich usable at the inspector's current 520-640px width,
  especially with wide dataframes?
- Do users primarily expand outputs, or do they go directly to Results?
- Is a human-authored description enough for graph comprehension, or is a
  generated summary materially better?
- Do users understand that `display()` affects presentation but not data flow?
- How often do users edit declared outputs compared with code?
- Which plotting libraries already provide reliable `_repr_png_()` output in the
  environments beta testers use?

## Explicit non-goals for the first redesign

- A full spreadsheet or dataframe exploration environment
- Showing every input, output, artifact, log, and trace simultaneously
- Reproducing the graph canvas inside the inspector
- AI-generated explanations as a dependency for comprehension
- Perfect support for every viewport and data type before friend testing
