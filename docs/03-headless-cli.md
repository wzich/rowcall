# Headless CLI

Nodebook documents can be validated and run without opening the canvas editor.
The `nodebook` launcher is the beta automation surface for humans, agents, and
scripts. By default, it routes headless commands through your active Python
environment; pass `--managed-env` to use Nodebook's starter environment under
`~/.nodebook/venvs/default`.

The Python module CLI remains the underlying runtime contract:
`python3 -m nodebook` and `deno task cli` are useful for development and local
package testing.

## Commands

Create a new Nodebook project:

```sh
nodebook new path/to/project
```

This creates `path/to/project/graph.py`. To create and immediately open the
canvas editor, pass `--open`:

```sh
nodebook new path/to/project --open
```

Create a sample project with data:

```sh
nodebook example path/to/sample-project
```

Validate a document:

```sh
nodebook validate path/to/project
```

Run the full graph:

```sh
nodebook run path/to/project
```

Run upstream to a target node:

```sh
nodebook run path/to/project --to node_id_or_function_name
```

Targets must exactly match either a stable node ID or a Python function name. If
a target matches more than one node reference, the CLI fails instead of
guessing.

Folder paths resolve to `graph.py` inside the folder. Passing a `.py` path uses
that exact file:

```sh
nodebook run path/to/project/graph.py
```

Opening follows the same path rule:

```sh
nodebook open path/to/project
nodebook open path/to/project/explore.py
```

For convenience, `nodebook path/to/project` is an alias for
`nodebook open path/to/project` when the path already exists. Missing paths are
not created implicitly; use `nodebook new <path>` instead.

## Options

- `--json` prints the full structured machine-readable runtime response.
- `--json=summary` prints a bounded response with node statuses and compact
  final-output previews, omitting full intermediate results.
- `--outputs-only` prints only bounded final-output previews and any run error.
- `--trace` includes ordered per-step execution details, including input
  previews for each executed node.
- `--trace=summary` includes only trace order, dependencies, statuses, warnings,
  and errors. It requires `--json` or `--json=summary`.

Example:

```sh
nodebook run examples/ecommerce/analysis.py --to build_customer_facts --json --trace
```

For agent and CI workflows, prefer a compact projection:

```sh
nodebook run examples/ecommerce/analysis.py --to build_customer_facts --json=summary --trace=summary
nodebook run examples/ecommerce/analysis.py --to build_customer_facts --outputs-only
```

For developer workflows, the Python module CLI is equivalent when the package is
installed into the active environment:

```sh
python3 -m nodebook run examples/ecommerce/analysis.py --to build_customer_facts --json --trace
```

When using Deno tasks, `deno task cli` delegates to `python3 -m nodebook` or the
repo-local `.venv` selected by `runtime_config.ts`.

## JSON Output

JSON output is wrapped with command and document context:

```json
{
  "ok": true,
  "command": "run",
  "documentPath": "/absolute/path/to/analysis.py",
  "target": {
    "requested": "build_customer_facts",
    "nodeId": "n_build_customer_facts",
    "matchKind": "function_name"
  },
  "response": {}
}
```

For `run`, `response` uses the same execution response shape as the runtime:
executed node IDs, per-node results, final outputs, optional trace details,
stdout, stderr, warnings, display events, and value previews. Dataframe previews
include column names, dtypes, rows, row counts, column counts, and truncation
state.

`--trace` can produce large JSON because it includes previews for intermediate
inputs and outputs. Prefer untraced `--json` for normal automation and add
`--trace` when debugging data flow into a specific node.

Summary and outputs-only responses cap embedded plain JSON values at 16 KB,
table previews at 5 rows by 10 columns, and diagnostic text fields at bounded
lengths. Omitted or shortened values include explicit truncation metadata or
markers. These presentation limits do not change the Python values passed
between nodes.

## Exit Codes

- `0`: validation or execution succeeded.
- `1`: the document was invalid, the target could not be resolved, or execution
  failed.
- `2`: CLI usage failed before document validation or execution.

When `--json` is set, failures still print structured JSON before exiting
nonzero.

## Inputs

The beta CLI does not accept external input values. Data and configuration
should enter through Python code in the document, usually in root nodes that
read files or define constants. This keeps the Python document as the complete
source of truth for a run.

Source-backed document runs reject non-empty explicit inputs so the Python
document remains the complete source of truth for a run.

## Python Environment Troubleshooting

The beta launcher runs documents with your active Python environment by default.
Activate Conda or a virtualenv before running `nodebook`, or pass a specific
interpreter:

```sh
nodebook run --python "$CONDA_PREFIX/bin/python" my-work --json
```

Nodebook temporarily adds its bundled runtime package to that Python process so
documents can import `nodebook` without installing Nodebook into your
environment.

If you do not want to configure packages yourself, use the managed starter env:

```sh
nodebook run --managed-env my-work --json
```

The managed venv lives at:

```text
~/.nodebook/venvs/default
```

On first managed-env use, or after `nodebook reset-env`, it selects `python3`
then `python` and requires Python 3.10 or newer.

Use `nodebook doctor` to inspect the selected user Python runtime. Use
`nodebook doctor --managed-env` to inspect the managed venv, installed package
status, pandas/polars availability, and log path. Doctor is read-only and does
not materialize launcher assets, create environments, or append to the log. Pass
`--json` for a structured report; checks that cannot run are reported as
`not_checked` rather than as missing packages.

The lower-level Python module CLI runs with the interpreter used to launch it.
It does not auto-detect Conda, virtualenv, or other interpreters.

If a top-level import or node-body import fails, non-JSON CLI output prints the
missing package and the Python executable that was used. For example:

```text
FAILED run document
Missing Python package while loading document globals: polars
Python used: /path/to/python
Document: /path/to/document.py

Run Nodebook with a Python environment that has this package installed.
```

When `--json` is set, the same information is available in structured error
fields such as `kind`, `phase`, `missingModule`, and `pythonExecutable`.
