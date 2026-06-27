# Nodebook

Nodebook is a canvas-based computational notebook prototype. The current repo
has a Python runtime for parsing, validating, planning, and executing
graph-shaped Python notebooks, plus a Deno/Hono API and Vite/React canvas UI for
editing and managing those documents.

## Beta Tester Start

Beta testers will install a single `nodebook` launcher. Python 3.10 or newer
must already be installed; Nodebook creates its own managed virtual environment
for the local runtime and example dependencies.

The hosted installer URL is a placeholder until a release host exists:

```sh
curl -fsSL https://beta.nodebook.dev/install.sh | sh
```

For now, build the launcher locally and install it with a direct file URL:

```sh
deno task ui:build
deno task beta:compile
NODEBOOK_DOWNLOAD_URL=file://$PWD/dist/nodebook sh packaging/install.sh
```

If the installer reports that `~/.local/bin` is not on `PATH`, add the printed
`export PATH=...` line to your shell profile.

Show command help:

```sh
nodebook
```

Open an existing Python document:

```sh
nodebook path/to/analysis.py
```

If `path/to/analysis.py` does not exist and its parent directory exists,
Nodebook creates a starter document there. Missing parent directories are
treated as errors so typos do not silently create nested paths.

The app is served at `http://127.0.0.1:8000/` and is bound to the local machine
only.

### Managed Environment

The beta launcher stores its managed files under:

```text
~/.nodebook
~/.nodebook/venvs/default
~/.nodebook/logs/nodebook.log
```

On first run, or after `nodebook reset-env`, the launcher uses `python3` then
`python` to find Python 3.10 or newer, creates the managed venv, installs the
bundled `nodebook` Python package, and installs `requirements-alpha.txt`
dependencies such as pandas and polars.

Inspect a local install:

```sh
nodebook doctor
```

Recreate only the managed venv:

```sh
nodebook reset-env
```

### Headless CLI

Validate and run a Nodebook Python document without opening the canvas:

```sh
nodebook validate path/to/analysis.py
nodebook run path/to/analysis.py
nodebook run path/to/analysis.py --to node_id_or_function_name
```

Running without `--to` executes the full graph. Targets must be exact node IDs
or exact Python function names.

Pass `--json` for structured output and `--trace` to include per-step input
previews:

```sh
nodebook run path/to/analysis.py --json --trace
```

The launcher delegates headless commands to the Python CLI inside the managed
venv. During development, `python3 -m nodebook` and `deno task cli` are still
useful local wrappers:

```sh
python3 -m nodebook run path/to/analysis.py --json --trace
deno task cli run path/to/analysis.py --json --trace
```

The beta CLI intentionally does not accept external input values. Data and
configuration should enter through Python code in the document so runs remain
reproducible from the file itself.

See [docs/03-headless-cli.md](docs/03-headless-cli.md) for the CLI contract.

To choose a specific Python interpreter for environment creation:

```sh
nodebook --python "$CONDA_PREFIX/bin/python" path/to/analysis.py
```

## Run Locally For Development

Install Deno and Python 3.10 or newer, then prepare the repo-local development
environment:

```sh
deno task setup
```

This creates a repo-local `.venv`, installs the local `nodebook` Python package,
and installs `requirements-alpha.txt`. This is separate from the beta launcher's
`~/.nodebook/venvs/default`.

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
`deno task setup` installs the local Python package into `.venv`. For local
alpha testing from outside the repository, install the package into the active
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
Full-graph and run-to-node execution go through the Python runtime worker.
Single-node iterative runs currently use the legacy session runner until the
Python worker grows cache-aware single-node execution.

## Build And Serve The UI

```sh
deno task ui:build
```

The build output is written to `app/ui/dist/`. After building, the Deno/Hono
server serves the React app from `http://127.0.0.1:8000/` while continuing to
handle document, inspection, and execution API routes.

Use Vite for active UI development. Use the Hono-served build when you want a
single local server or a production-style static app host.

## Build The Beta Launcher

Build the UI, then compile the macOS beta launcher:

```sh
deno task ui:build
deno task beta:compile
```

The compiled binary is written to `dist/nodebook`. It embeds the built UI, the
Python package, `runner.py`, `python_document_loader.py`, and
`requirements-alpha.txt`.

For release hosting, publish platform-specific binaries such as:

```text
nodebook-darwin-arm64
nodebook-darwin-x64
```

The installer template in `packaging/install.sh` is host-agnostic. Until the
hosted `https://beta.nodebook.dev/install.sh` URL exists, configure it with
either a direct binary URL or a release base URL:

```sh
NODEBOOK_DOWNLOAD_URL=https://beta.nodebook.dev/v0.0.0/nodebook-darwin-arm64 sh packaging/install.sh
NODEBOOK_RELEASE_BASE=https://beta.nodebook.dev NODEBOOK_VERSION=v0.0.0 sh packaging/install.sh
```
