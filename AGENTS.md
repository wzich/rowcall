# Agent Notes

Nodebook documents are normal Python files.

Use the CLI to validate and run documents:

- `python -m nodebook validate path/to/document.py`
- `python -m nodebook run path/to/document.py --json`
- `python -m nodebook run path/to/document.py --to node_id_or_function_name --json`
- `deno task cli ...` is a thin wrapper around the Python CLI.

An installed `nodebook` binary should expose the same `validate` and `run`
commands. Edit Python directly. After changing a node, run the document or run
to the changed node and inspect the JSON output.
