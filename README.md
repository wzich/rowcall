# Nodebook

Nodebook is a canvas-based computational notebook prototype. The current repo
has a Deno/Hono API for editing and running graph-shaped Python notebooks, plus
a Vite/React UI for editing graphs on a canvas.

## Alpha Tester Start

Install Deno and Python 3.10 or newer, then prepare Nodebook's local Python
environment:

```sh
deno task setup
```

This creates a repo-local `.venv`, installs the tiny local `nodebook` Python
package, and installs the alpha example dependencies from
`requirements-alpha.txt`. The `.venv` uses your installed Python runtime; it is
not committed to the repo.

Start Nodebook with the built UI and the ecommerce example:

```sh
deno task start
```

Open another Python document:

```sh
deno task start path/to/analysis.py
```

Create a new Python document:

```sh
deno task start --create path/to/analysis.py
```

The app is served at `http://127.0.0.1:8000/` and is bound to the local machine
only.

### Headless CLI

Validate and run a Nodebook Python document without opening the canvas:

```sh
deno task cli validate path/to/analysis.py
deno task cli run path/to/analysis.py
deno task cli run path/to/analysis.py --to node_id_or_function_name
```

Running without `--to` executes the full graph. Targets must be exact node IDs
or exact Python function names.

Pass `--json` for structured output, `--trace` to include per-step input
previews, and `--python /path/to/python` to choose a Python interpreter:

```sh
deno task cli run path/to/analysis.py --json --trace --python "$CONDA_PREFIX/bin/python"
```

The beta CLI intentionally does not accept external input values. Data and
configuration should enter through Python code in the document so runs remain
reproducible from the file itself.

See [docs/03-headless-cli.md](docs/03-headless-cli.md) for the CLI contract.

### Python Environment

By default, Nodebook prefers `.venv/bin/python` or `.venv/Scripts/python.exe`
when a local `.venv` exists, then falls back to the first `python3` or `python`
on `PATH`.

To create `.venv` from a specific Python interpreter:

```sh
deno task setup --python /path/to/python
```

To bypass `.venv` and choose an interpreter explicitly at startup:

```sh
deno task start --python "$CONDA_PREFIX/bin/python" path/to/analysis.py
```

## Run Locally For Development

Start the Deno API:

```sh
deno task dev
```

By default this edits `examples/ecommerce/analysis.py`. To edit another local
document during development, pass a `.py` path through the task:

```sh
deno task dev path/to/analysis.py
```

To create a new document and start the API against it, pass `--create` with the
new `.py` path:

```sh
deno task dev --create path/to/analysis.py
```

Nodebook Python documents import a tiny local `nodebook` package:

```python
from nodebook import node


@node(id="n_load", outputs=["message"])
def read_message():
    message = "hello"
    return {"message": message}
```

The decorator records node metadata and returns the original function unchanged.
`deno task setup` installs this stub package into `.venv`. For local alpha
testing from outside the repository, install the stub package into the active
Python environment:

```sh
python -m pip install -e .
```

There is also a Polars-based data workflow example:

```sh
python -m pip install polars
deno task dev examples/polars_orders.py
```

Start the React canvas UI in another terminal:

```sh
deno task ui:dev
```

The UI is served by Vite at `http://127.0.0.1:5173/` and proxies document,
inspection, and execution requests to the API at `http://127.0.0.1:8000/`.

## Build And Serve The UI

```sh
deno task ui:build
```

The build output is written to `app/ui/dist/`. After building, the Deno/Hono
server serves the React app from `http://127.0.0.1:8000/` while continuing to
handle document, inspection, and execution API routes.

Use Vite for active UI development. Use the Hono-served build when you want a
single local server or a production-style static app host.
