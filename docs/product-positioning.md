# Nodebook product positioning
This document is an internal source of truth for describing Nodebook. It is not marketing copy. The language in here should be plain, specific, and anchored in the current product while explaining the larger product direction.

## Summary
Nodebook is a workspace for exploring and building with data.

Nodebook bridges exploration and production. A one-off analysis is structured so that it can be inspected, extended, and rerun instead of being rebuilt for production.

Data sources and transformations are organized as an executable graph in an ordinary Python file. Each step can be inspected and changed, and the graph can be run like a pipeline from the editor or the CLI.

## User and job
The initial user is a generalist data scientist, especially one working as a data science team of one or on a small team without engineers dedicated to productionizing their work. Their work spans data cleaning, ad hoc analyses, analytics engineering, reporting, modeling, and delivery.

Data scientists are often given an ambiguous question or vague problem to solve. They don't always know whether the work they produce will be one-off, repeated next week, extended with another data source, shared with a teammate, or turned into an operational workflow.

Their job is to take an ambiguous business problem and create something useful—an analysis, report, dashboard, pipeline, or API—that addresses the problem.

## Problem
Data science is inherently iterative because the problem, available data, and useful approach are often discovered through the work itself.

Some existing tools, like Jupyter Notebooks, support this kind of exploration very well, but these tools often don't lend themselves to production. Exploratory work and production work are usually broken into staged, separate workflows. Often, as soon as an analysis becomes useful, it needs to be reconstructed in another form: a pipeline, report, dashboard, model service, or other maintained artifact.

**This creates a continuity problem.**

Logic is rewritten, context is lost, results become separated from the transformations that produced them, and later changes must be carried across different artifacts. The central problem Nodebook is intended to solve is having to **start over** when exploratory work becomes important.

Coding agents do not solve this problem; they magnify it. They can produce and change analytical code faster than a person can review it line by line, increasing both the amount of exploratory work that may need to be carried forward and the need to inspect, trace, and verify it. This is an extension of the same continuity problem, not a separate agent-specific problem.

## Current product
A user opens a Nodebook project as a visual graph of an analysis. Selecting a step opens an inspector where they can change its code, run the analysis through that step, and examine its inputs, outputs, logs, and errors. They can also run the complete graph, return later to extend it, or share the project with another technical user.

Underneath the workspace, the graph is stored as an ordinary Python file.
Functions represent steps in the analysis, connections determine execution order, and the file can also be edited directly in an IDE or by a coding agent.
The CLI can validate the project and run the complete graph or run fresh through a selected step.
Optional sidecar metadata controls the canvas presentation without becoming part of the computation.

Data does not have to be stored inside the project. A source step may read a local file, run a SQL query, call an API, or generate data. A project may include a `data/` directory when portability or exact input preservation is useful, but external sources are a normal part of the model.

## Product hypothesis
Nodebook is designed so that ordinary exploration leaves behind a structured, runnable graph. The user should not have to adopt a production workflow before they know whether the work will be reused.

Nodebook introduces a small amount of structure during exploration: separate steps, explicit data flow, and a runnable graph. The resulting work should be easier to inspect, extend, and operate later. The product succeeds if this structure feels natural during exploration rather than like premature production work.
A user should be able to return to an existing project with fresh data, add another source or line of analysis, and continue from the existing work rather than reconstructing it elsewhere.

The graph is architecturally central because it defines execution and makes the computation inspectable. It may be experientially secondary: a user may spend most of their time examining results or editing one step and only open the wider graph when they need to understand or change how the work fits together.

The current product supports the beginning of the exploration-to-production path. It does not yet provide every capability required to operate a production system. The hypothesis is that preserving the computation in an inspectable, runnable project reduces the amount of work that must later be discarded or rewritten.

## Ways of working
Nodebook supports direct and delegated work. A person can edit code and graph structure in the workspace, or a coding agent can edit the same Python file and use the CLI to validate and run it. These modes can be mixed within one project.

Agent support is intended to be first-class, but it is not a prerequisite for using or understanding Nodebook. Both modes operate on the same computation, and the human can review the work at the level appropriate to the situation: results first, graph structure when useful, and code when necessary.

## Data products
A data product is a computational artifact that uses data to address a problem or support a decision and can continue to be used as its data or requirements change. It has identifiable inputs and produces an output someone can use. Its user may be the creator's future self, a technical teammate, or eventually a non-technical consumer.

The current version of Nodebook primarily supports reusable technical analyses. An analysis, derived dataset, model, report, dashboard, scheduled workflow, or API can all be forms of data products at different levels of maturity. Nodebook does not require a reader to understand this term in order to understand the basic product: it is a workspace for exploring and building with data.

## Present capabilities and possible extensions
| Area | Present | Possible extension |
| --- | --- | --- |
| Authoring | Edit graph-shaped Python directly or through the workspace | Richer direct and agent-assisted ways to change a project |
| Inspection | Inspect step inputs, outputs, tables, logs, and errors | Plots, profiling, run history, and deeper provenance such as column lineage |
| Reuse | Reopen, extend, validate, and rerun a local project | Parameters, tests, environment locking, caching, and stronger run records |
| Delivery | Share a project folder with another technical user | Reports, dashboards, and role-specific views tied to the same computation |
| Operation | Run a complete graph or through a selected step from the CLI | Scheduling, managed execution, hosted APIs, and cloud publishing |

These extensions should strengthen continuity rather than introduce separate representations of the work. Tests should harden existing transformations; dashboards should present existing outputs; scheduling should operate the same graph; and richer agent tools should expose the same execution state a person can inspect.

## Claim boundaries
- Nodebook currently provides a path toward production; it is not yet a complete
  production orchestration or hosting system.
- "Repeatable" means that the same computation can be run again against
  available inputs. Exact reproducibility also depends on preserving or pinning
  data, configuration, dependencies, and the execution environment.
- A project can be self-describing without being self-contained. External data
  sources do not have to be copied into the project folder.
- Agent-assisted authoring is a supported way of working, not the premise of the
  product.
- The graph is the computational structure, not the user's end goal.
- Future capabilities should be described as directions until they exist in the
  product.
