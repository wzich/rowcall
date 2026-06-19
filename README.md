# Nodebook

Nodebook is a canvas-based computational notebook prototype. The current repo
has a Deno/Hono API for editing and running graph-shaped Python notebooks, plus
a Vite/React UI for editing graphs on a canvas.

## Alpha Tester Start

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

Nodebook uses the first `python3` or `python` on `PATH`, so activate your conda
or virtual environment before starting it. To choose an interpreter explicitly:

```sh
deno task start --python "$CONDA_PREFIX/bin/python" path/to/analysis.py
```

The app is served at `http://127.0.0.1:8000/` and is bound to the local machine
only.

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
For local alpha testing from outside the repository, install the stub package
into the active Python environment:

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
