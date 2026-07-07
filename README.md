# Nodebook

Nodebook is a canvas-based computational notebook prototype. The current repo
has a Python runtime for parsing, validating, planning, and executing
graph-shaped Python notebooks, plus a Deno/Hono API and Vite/React canvas UI for
editing and managing those documents.

## Beta Tester Start

Beta testers will install a single `nodebook` launcher. Python 3.10 or newer
must already be installed. By default Nodebook uses your active Python
environment and temporarily adds its own runtime package for the Nodebook
process.

```sh
curl -fsSL https://nodebook.rodeo/install.sh | sh
```

To upgrade, run the same installer command again. It replaces only the
`nodebook` launcher in `~/.local/bin`; the launcher refreshes its managed Python
runtime the next time it runs if the bundled Nodebook version changed.

For local release testing, build and assemble the release site, then install
from the generated file URL:

```sh
deno task release:build
deno task release:site
NODEBOOK_RELEASE_BASE=file://$PWD/dist/r2 sh dist/site/install.sh
```

If the installer reports that `~/.local/bin` is not on `PATH`, add the printed
`export PATH=...` line to your shell profile.

Show command help:

```sh
nodebook --help
```

Create and open a new Nodebook folder:

```sh
nodebook new my-work --open
```

This creates:

```text
my-work/
  graph.py
```

Open an existing Nodebook folder or Python document:

```sh
nodebook open my-work
nodebook open path/to/graph.py
```

For convenience, `nodebook my-work` is an alias for `nodebook open my-work` when
the path already exists. Folder paths resolve to `graph.py` inside the folder.
To create a standalone Python document instead of a folder, pass a `.py` path:

```sh
nodebook new graph.py
```

The app is served at `http://127.0.0.1:8000/` and is bound to the local machine
only.

### Python Environments

By default, Nodebook uses the Python environment you launch it from. Activate
Conda or a virtualenv before running `nodebook`, or pass a specific interpreter:

```sh
nodebook open --python "$CONDA_PREFIX/bin/python" my-work
```

If you do not want to configure packages yourself, use Nodebook's managed
starter environment:

```sh
nodebook open --managed-env my-work
nodebook run --managed-env my-work --json
```

The beta launcher stores its managed files under:

```text
~/.nodebook
~/.nodebook/venvs/default
~/.nodebook/logs/nodebook.log
```

On first managed-env use, or after `nodebook reset-env`, the launcher uses
`python3` then `python` to find Python 3.10 or newer, creates the managed venv,
installs the bundled `nodebook` Python package, and installs
`requirements-alpha.txt` dependencies such as pandas and polars.

Inspect the default user Python runtime:

```sh
nodebook doctor
```

Inspect the managed starter environment:

```sh
nodebook doctor --managed-env
```

Recreate only the managed venv:

```sh
nodebook reset-env
```

### Headless CLI

Validate and run a Nodebook Python document without opening the canvas:

```sh
nodebook validate my-work
nodebook run my-work
nodebook run my-work --to node_id_or_function_name
```

Running without `--to` executes the full graph. Targets must be exact node IDs
or exact Python function names.

Pass `--json` for structured output and `--trace` to include per-step input
previews:

```sh
nodebook run my-work --json --trace
```

The launcher delegates headless commands to the selected Python runtime. During
development, `python3 -m nodebook` and `deno task cli` are still useful local
wrappers:

```sh
python3 -m nodebook run my-work --json --trace
deno task cli run my-work --json --trace
```

The beta CLI intentionally does not accept external input values. Data and
configuration should enter through Python code in the document so runs remain
reproducible from the file itself.

See [docs/03-headless-cli.md](docs/03-headless-cli.md) for the CLI contract.

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

The UI is served by Vite at `http://127.0.0.1:5173/` and proxies document and
execution requests to the API at `http://127.0.0.1:8000/`. Document parsing and
execution go through the Python runtime worker, including cache-aware
single-node iterative runs.

## Build And Serve The UI

```sh
deno task ui:build
```

The build output is written to `app/ui/dist/`. After building, the Deno/Hono
server serves the React app from `http://127.0.0.1:8000/` while continuing to
handle document and execution API routes.

Use Vite for active UI development. Use the Hono-served build when you want a
single local server or a production-style static app host.

## Build The Beta Launcher

Build the UI, then compile the macOS beta launcher:

```sh
deno task ui:build
deno task beta:compile
```

The compiled binary is written to `dist/nodebook`. It embeds the built UI, the
Python package, and `requirements-alpha.txt`.

For release hosting, publish platform-specific binaries such as:

```text
nodebook-darwin-arm64
nodebook-darwin-x64
```

The installer template in `packaging/install.sh` defaults to the release asset
host at `https://releases.nodebook.rodeo`. It can also be configured with either
a direct binary URL or a release base URL:

```sh
NODEBOOK_DOWNLOAD_URL=https://releases.nodebook.rodeo/v0.1.0/nodebook-darwin-arm64 sh packaging/install.sh
NODEBOOK_RELEASE_BASE=https://releases.nodebook.rodeo NODEBOOK_VERSION=v0.1.0 sh packaging/install.sh
```

## Release To nodebook.rodeo

The release host is a Cloudflare Pages project named `nodebook-rodeo`. The
committed `site/` directory contains the editable landing page source. The
deployable site is generated into `dist/site/` and is not committed.

Compiled release binaries are too large for Cloudflare Pages static assets, so
the large downloads are generated into `dist/r2/` and uploaded to a Cloudflare
R2 bucket. The default bucket name is `nodebook-rodeo-releases`, and the
expected public custom domain is `https://releases.nodebook.rodeo`.

Build both macOS binaries:

```sh
deno task release:build
```

Assemble the deployable static site and R2 asset directory:

```sh
deno task release:site
```

This writes:

```text
dist/site/
  index.html
  install.sh
  latest.json

dist/r2/
  latest/nodebook-darwin-arm64
  latest/nodebook-darwin-arm64.sha256
  latest/nodebook-darwin-x64
  latest/nodebook-darwin-x64.sha256
  v0.1.0/nodebook-darwin-arm64
  v0.1.0/nodebook-darwin-arm64.sha256
  v0.1.0/nodebook-darwin-x64
  v0.1.0/nodebook-darwin-x64.sha256
```

Upload the generated R2 assets and deploy the generated site to Cloudflare Pages
with Wrangler:

```sh
deno task release:deploy
```

Deploy just one side when testing:

```sh
deno task release:deploy:assets
deno task release:deploy:site
```

Run the complete local release flow:

```sh
deno task release
```

If the Cloudflare Pages Git integration is enabled for `site/`, automatic Git
deployments can publish the source-only site over the generated release site.
For real alpha releases, deploy `dist/site/` with Wrangler or disable automatic
deployments for the Pages project.

Override the R2 bucket name or public download base if needed:

```sh
NODEBOOK_R2_BUCKET=my-bucket deno task release:deploy:assets
NODEBOOK_RELEASE_DOWNLOAD_BASE=https://downloads.example.com deno task release:site
```
