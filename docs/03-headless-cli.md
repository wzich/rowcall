# Headless CLI

Rowcall documents can be validated and run without opening the canvas editor.
The `rowcall` launcher is the beta automation surface for humans, agents, and
scripts. `run` prefers an existing project `.venv`, then an active virtualenv or
Conda environment; if none exists, it creates the project environment and
installs `requirements.txt`. Rowcall-created project environments refresh their
dependencies when that file changes. `validate` uses the same
existing-environment order but never creates an environment or installs
packages. Pass `--managed-env` to use Rowcall's starter environment under
`~/.rowcall/venvs/default`.

The Python module CLI remains the underlying runtime contract for headless
commands. In a source checkout, `uv run rowcall` and `python3 -m rowcall`
delegate opening and project-creation commands to the full Deno launcher.

## Commands

Create a new Rowcall project:

```sh
rowcall new path/to/project
```

This creates `path/to/project/graph.py`, `.gitignore`, `AGENTS.md`, and
`requirements.txt`. The agent instructions describe the edit/validate/run
workflow, while the requirements file lists the starter data packages. `new`
does not install them. To create and immediately open the canvas editor, pass
`--open`:

```sh
rowcall new path/to/project --open
```

Opening uses `path/to/project/.venv` when it exists, otherwise an active
environment when available. With neither, it creates the project `.venv` and
installs `requirements.txt`; later changes to that file refresh its
dependencies. To use a specific interpreter directly instead:

```sh
rowcall new path/to/project --open --python /path/to/python
```

Create a sample project with data:

```sh
rowcall example path/to/sample-project
```

Validate a document:

```sh
rowcall validate path/to/project
```

Run the full graph:

```sh
rowcall run path/to/project
```

Run upstream to a target node:

```sh
rowcall run path/to/project --to node_id_or_function_name
```

Targets must exactly match either a stable node ID or a Python function name. If
a target matches more than one node reference, the CLI fails instead of
guessing.

Folder paths resolve to `graph.py` inside the folder. Passing a `.py` path uses
that exact file:

```sh
rowcall run path/to/project/graph.py
```

Opening follows the same path rule:

```sh
rowcall open path/to/project
rowcall open path/to/project/explore.py
```

For convenience, `rowcall path/to/project` is an alias for
`rowcall open path/to/project` when the path already exists. Missing paths are
not created implicitly; use `rowcall new <path>` instead.

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
rowcall run examples/ecommerce/analysis.py --to build_customer_facts --json --trace
```

For agent and CI workflows, prefer a compact projection:

```sh
rowcall run examples/ecommerce/analysis.py --to build_customer_facts --json=summary --trace=summary
rowcall run examples/ecommerce/analysis.py --to build_customer_facts --outputs-only
```

For developer workflows, the Python module CLI is equivalent when the package is
installed into the active environment:

```sh
python3 -m rowcall run examples/ecommerce/analysis.py --to build_customer_facts --json --trace
```

When using Deno tasks, `deno task cli` delegates to `python3 -m rowcall` or the
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

For `run`, `response` uses the runtime execution shape: executed node IDs,
per-node results, final outputs, ordered displays, optional trace details,
stdout, stderr, warnings, and value previews. Dataframe previews include column
names, dtypes, rows, row counts, column counts, and truncation state.

The CLI never emits PNG base64, including with full `--json` and `--trace`.
Image previews instead contain MIME type, width, height, byte size, and
`dataOmitted: true`. The CLI does not write image files in this version.

`--trace` can produce large JSON because it includes previews for intermediate
inputs, outputs, and displays. Prefer untraced `--json` for normal automation
and add `--trace` when debugging data flow into a specific node.

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

When `--json`, `--json=summary`, or `--outputs-only` is set, failures still
print structured JSON before exiting nonzero. Launcher-level Python selection,
environment creation, and dependency installation failures use an
`environment_error` object in the same top-level envelope; setup progress and
package-manager diagnostics remain on stderr.

## Inputs

The beta CLI does not accept external input values. Data and configuration
should enter through Python code in the document, usually in root nodes that
read files or define constants. This keeps the Python document as the complete
source of truth for a run.

Source-backed document runs reject non-empty explicit inputs so the Python
document remains the complete source of truth for a run.

## Python Environment Troubleshooting

The beta launcher uses this order for `open` and `run`:

1. Explicit `--python`.
2. A compatible project `.venv`.
3. A compatible active `VIRTUAL_ENV`.
4. A compatible active `CONDA_PREFIX`.
5. A new project `.venv` created with compatible `python3` or `python`.

Only a project environment created by Rowcall receives the current
`requirements.txt`. Rowcall records the file's hash and runs pip again whenever
it changes. Pre-existing project and active environments are never
auto-installed into. If installation fails or is interrupted, Rowcall preserves
the environment and retries setup on the next `open` or `run`. Share
`requirements.txt`, not `.venv`; virtual environments contain machine-specific
paths and the generated `.gitignore` excludes them.

`validate` stops before the creation step and falls back to compatible system
Python instead. It never creates `.venv` or installs packages. Pass a specific
interpreter to override automatic selection:

```sh
rowcall run --python "$CONDA_PREFIX/bin/python" my-work --json
```

Rowcall temporarily adds its bundled runtime package to that Python process so
documents can import `rowcall` without installing Rowcall into your environment.

If you do not want to configure packages yourself, use the managed starter env:

```sh
rowcall run --managed-env my-work --json
```

The managed venv lives at:

```text
~/.rowcall/venvs/default
```

On first managed-env use, or after `rowcall reset-env`, it selects `python3`
then `python` and requires Python 3.10 or newer.

Use `rowcall doctor` to inspect the selected user Python runtime. Use
`rowcall doctor --managed-env` to inspect the managed venv, installed package
status, pandas/polars/matplotlib availability, and log path. Doctor is read-only
and does not materialize launcher assets, create environments, or append to the
log. Pass `--json` for a structured report; checks that cannot run are reported
as `not_checked` rather than as missing packages.

The lower-level Python module CLI runs with the interpreter used to launch it.
It does not auto-detect Conda, virtualenv, or other interpreters.

If a top-level import or node-body import fails, non-JSON CLI output prints the
missing package and the Python executable that was used. For example:

```text
FAILED run document
Missing Python package while loading document globals: polars
Python used: /path/to/python
Document: /path/to/document.py

Run Rowcall with a Python environment that has this package installed.
```

When `--json` is set, the same information is available in structured error
fields such as `kind`, `phase`, `missingModule`, and `pythonExecutable`.
