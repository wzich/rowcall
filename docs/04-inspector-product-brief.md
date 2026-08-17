# Inspector Product Brief

## Status

Working product alignment for the invited-beta inspector. This document is
intentionally narrower than a complete UI specification. It defines the jobs the
inspector must support, their priority, and the interaction model we want to
test with early users.

## Product decision

The node inspector is a contextual workspace for one selected step. Its
information architecture separates two questions:

1. **Code** -- what is this step supposed to do?
2. **Results** -- what is the latest data and execution state associated with
   this step?

Code owns the authored definition. Results owns runtime observations. This
boundary is more important than reproducing a notebook cell's simultaneous
input, code, and output layout in the first beta.

Results is deliberately a latest-state view, not immutable run history. A step's
currently available upstream inputs and its most recent outputs may come from
different executions. Every value therefore carries its own provenance and
freshness; the tab must not imply that all visible values belong to one
execution snapshot.

## Graph routing model

The graph owns data flow. Each edge routes one stable named source variable to
one downstream input. Dragging from a variable's handle creates that route.
Removing its final route stops exporting it.

The generated Python decorator and return dictionary materialize the routes for
execution. They are not a second, independently authored declared-output
contract. Consequently:

- the inspector does not offer output-selection or output-contract controls
- route creation, removal, and repair happen on the graph
- routed-variable previews remain useful runtime data in Results
- a route whose source variable no longer exists is shown and repaired on the
  graph, not reconfigured in the inspector

## Jobs and user stories

### P0: Author and run a step

**Job to be done**

When I am changing a step, I want to edit its Python, run through it, and know
whether it succeeded so that I can keep developing without losing my place.

**Core user stories**

- As an author, I can edit the selected step's code in a focused editor.
- As an author, I can run through the selected step from the keyboard and keep
  my editor focus.
- As an author, I can immediately tell whether the step is queued, running,
  successful, stale, or failed.
- As an author, I can see a syntax or execution error caused by this step and
  return to the relevant code location.
- As an author, running through a step does not automatically move me away from
  Code.

The node's name and description are authored information. They may remain near
the editor or in a secondary disclosure while beta usage clarifies their ideal
placement. Rename, delete, trace capture, and other low-frequency controls must
not compete with the editor.

### P0: Inspect the latest result state

**Job to be done**

When a step has run, I want to know whether it worked and inspect the data or
visuals it produced so that I can decide whether it did what I intended.

**Core user stories**

- As an author, I can distinguish a failure in this step from a step that did
  not run because something upstream failed.
- As an author, I can inspect displays explicitly produced for human review.
- As an author, I can inspect previews of routed variables produced by the step.
- As an author, I can inspect the latest available upstream input values.
- As an author, I can inspect stdout, stderr, warnings, and an optional trace
  when I need diagnostics.
- As an author, I can tell whether each visible value is fresh, stale, running,
  failed, or unavailable.
- As an author, I can keep a previous successful value as clearly labeled
  historical context after an edit or failed execution.

Displays receive high priority because `display()` is an explicit request from
the author to inspect a value. Routed variables support data flow and may also
be useful to inspect, but they should not displace an explicit display.

An upstream failure does not make the selected step look failed. The global run
notification identifies the actual failing step, and selecting that notification
navigates there. A downstream step that never executed is shown as not run or
retains stale prior data without adopting the upstream error.

### P1: Understand an unfamiliar step

**Job to be done**

When I select a step I did not write, I want to understand its intent and
inspect its latest data without reverse-engineering the entire graph.

**Core user stories**

- As a reader, I can see the step's name and human-authored description.
- As a reader, I can inspect its code when the description is insufficient.
- As a reader, I can inspect its latest displays and value previews.
- As a reader, I can navigate the graph to understand routing and neighboring
  steps.

The graph is the primary topology and routing surface. The inspector should not
reproduce a miniature graph or maintain a second routing configuration.

### P2: Configure and manage a step

Low-frequency actions include renaming, editing the description, viewing
function identity, enabling trace capture, and deleting the step. These may live
in contextual controls, an overflow menu, or a secondary disclosure. They do not
justify another top-level tab.

## Information architecture

### Persistent chrome

Keep only information and actions needed across both tabs:

- selected step identity
- close or back-to-graph action
- compact execution state
- primary Run Through Step action
- Code / Results tabs

### Code tab

Code is the default authoring surface. The Python editor receives most of the
available space. Name, description, and function identity belong to the step
definition, but their final visual treatment can remain lightweight during the
beta.

Code does not permanently show input and output previews in this pass. A future
iteration may add an optional collapsed data drawer, temporary result peek, or
split view if testing demonstrates that simultaneous code and data materially
improves the workflow. Deferring that enhancement does not change the two-tab
information architecture.

Starting Run Through Step from Code keeps Code selected. Success or failure is
communicated through persistent status and the run notification. The user opens
Results deliberately when they want to inspect data.

### Results tab

Results answers two questions in order:

1. Could this step run successfully?
2. Did it produce what the author wanted?

A reasonable information priority is:

1. selected-step execution state or selected-step error
2. ordered displays
3. routed-variable previews
4. latest available input previews
5. stdout, warnings, and stderr
6. optional advanced trace

Tables, images, JSON values, and plain Python representations use the richest
available preview. Large tables may use the interactive paginated result store
when it is available.

Clicking a variable row on a canvas node should select that node, open Results,
and focus the corresponding variable. This makes the graph's variable list the
entry point for both routing and inspection without turning runtime values into
graph nodes.

## Important interaction rules

1. **Freshness is part of each value.** Do not imply that independently retained
   inputs, outputs, and displays form one coherent run snapshot.
2. **Preserve authored context.** Running through a selected step does not move
   the user away from Code.
3. **Show the actual failure owner.** A step is failed only when its own
   execution failed. Upstream failures navigate to the upstream step through the
   global notification.
4. **Preserve useful history.** Keep prior successful data visible when useful,
   but fade it and label it stale.
5. **Displays express intent.** Show explicit displays before incidental runtime
   diagnostics and ordinary routed values.
6. **The graph owns routing.** Do not add inspector controls that independently
   select, expose, rename, or remove routed outputs.
7. **Keyboard is a first-class path.** Running and moving between Code and
   Results must not require precise pointer interaction.

## Graph inspector alignment

The graph inspector continues to support shared setup and full-graph execution.
It has two tabs:

1. **Overview** -- edit Document Globals and see graph-level setup errors.
2. **Results** -- inspect the latest full-graph execution, displays, and sink
   values.

Starting Run Graph while the graph inspector is active opens graph Results.
Running through a selected step updates node state but does not replace the
graph result or force the node inspector away from Code.

Graph Results represent only a full graph execution. Any graph or Document
Globals edit makes the latest completed graph result stale. Keep that result
visible but clearly labeled until the next full graph run.

Failures take priority in graph Results. A node failure links directly to the
failed node; a Document Globals failure links directly to Overview. Trace and
other diagnostics remain secondary to status, failure location, displays, and
sink values.

## Beta success criteria

- A new tester can predict that Code changes the recipe step and Results shows
  its latest runtime state.
- Running through a step gives immediate success or failure feedback without
  disrupting the editor.
- Explicit displays are easy to find.
- Clicking a canvas variable opens its preview in Results.
- Fresh and stale values cannot be mistaken for each other.
- No inspector control suggests that routed outputs are authored separately from
  graph edges.

## Questions for beta testing

- Do users understand Results as latest node-associated state rather than an
  immutable run record?
- Is Results the right label, or would Data better match where users expect to
  find variable previews?
- Do users need exact inputs from a historical execution, rather than the latest
  currently available upstream values?
- How often do users want simultaneous code and result previews?
- Which low-frequency step controls deserve direct placement rather than an
  overflow or disclosure?
- When both displays and routed variables exist, do users consistently prefer
  displays first?
