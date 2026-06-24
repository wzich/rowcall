# Agent Notes

Nodebook documents are normal Python files.

Use the CLI to validate and run documents:

- `deno task cli validate path/to/document.py`
- `deno task cli run path/to/document.py --json`
- `deno task cli run path/to/document.py --to node_id_or_function_name --json`

An installed `nodebook` binary should expose the same `validate` and `run`
commands. Edit Python directly. After changing a node, run the document or run
to the changed node and inspect the JSON output.
