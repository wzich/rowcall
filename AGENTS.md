# Agent Notes

Nodebook documents are normal Python files.

Node functions use a strict generated return shape. Every declared output must
exist as a same-named local variable (parameters already count). Assign computed
outputs before ending the function with exactly one return dictionary whose keys
and values match `outputs` in the declared order:

```python
@node(id="n_total", outputs=["total"])
def total_numbers(numbers):
    total = sum(numbers)
    return {"total": total}
```

Do not return expressions inline, use conditional or multiple returns, or build
the output dictionary dynamically. The installed CLI documents the complete
contract in `nodebook help format`.

Use the CLI to validate and run documents:

- `python -m nodebook validate path/to/document.py`
- `python -m nodebook run path/to/document.py --json`
- `python -m nodebook run path/to/document.py --to node_id_or_function_name --json`
- `deno task cli ...` is a thin wrapper around the Python CLI.

An installed `nodebook` binary should expose the same `validate` and `run`
commands. Edit Python directly. After changing a node, run the document or run
to the changed node and inspect the JSON output. Always validate after editing.
