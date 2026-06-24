# Headless CLI

Nodebook documents can be validated and run without opening the canvas editor.
The CLI is the beta automation surface for humans, agents, and scripts.

## Commands

Validate a document:

```sh
deno task cli validate path/to/analysis.py
```

Run the full graph:

```sh
deno task cli run path/to/analysis.py
```

Run upstream to a target node:

```sh
deno task cli run path/to/analysis.py --to node_id_or_function_name
```

Targets must exactly match either a stable node ID or a Python function name. If
a target matches more than one node reference, the CLI fails instead of
guessing.

## Options

- `--json` prints structured machine-readable output.
- `--trace` includes ordered per-step execution details, including input
  previews for each executed node.
- `--python /path/to/python` chooses the Python interpreter used by document
  loading and execution.

Example:

```sh
deno task cli run examples/ecommerce/analysis.py --to build_customer_facts --json --trace --python "$CONDA_PREFIX/bin/python"
```

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

Lower-level runtime APIs may still accept explicit inputs for internal and UI
experiments, but those inputs are not part of the public headless CLI contract.
