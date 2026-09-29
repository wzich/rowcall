# Rowcall

Rowcall is a canvas-based computational notebook prototype. The current repo has
a Python runtime for parsing, validating, planning, and executing graph-shaped
Python notebooks, plus a Deno/Hono API and Vite/React canvas UI for editing and
managing those documents.

## Beta Tester Start

Beta testers will install a single `rowcall` launcher. Python 3.10 or newer must
already be installed. Opening or running a document prefers its project-local
`.venv`, then an active virtualenv or Conda environment. If neither exists,
Rowcall creates `.venv`, installs the project requirements once, and temporarily
adds Rowcall's own runtime package to the process.

This is an invited beta, not a hardened public release. The macOS launcher is
currently unsigned and not notarized, and Rowcall executes Python with the
permissions of the user who started it. Open only documents whose code you
trust. The installer verifies published SHA-256 checksums to detect corruption;
checksums are not a substitute for publisher code signing.

Invited-beta limitations are intentionally explicit:

- Runs always execute fresh through the requested node's upstream dependencies;
  there is no execution cache.
- Unsaved browser edits are held only in memory and are lost if the browser or
  app crashes.
- If a save response is interrupted or otherwise uncertain, reload the document
  before editing again. Rowcall does not guess whether to replay the save.
- Run only one Rowcall launcher/process at a time. Concurrent launcher updates
  and managed-environment setup are not supported in this beta.
- Publishing is manual.

Close every running Rowcall process before reinstalling or updating the
launcher.

```sh
curl -fsSL https://rowcall.io/install.sh | sh
```

To upgrade, run the same installer command again. It replaces only the `rowcall`
launcher in `~/.local/bin`; the launcher refreshes its managed Python runtime
the next time it runs if the bundled Rowcall version changed.

To run the complete release check without uploading anything:

```sh
deno task release:prepare
```

This checks and tests the repository, builds both macOS artifacts, exercises the
artifact native to the current Mac outside the checkout, and stages the
Cloudflare upload. The other architecture is cross-built but not executed.

If the installer reports that `~/.local/bin` is not on `PATH`, add the printed
`export PATH=...` line to your shell profile.

To create your first project, run:

```sh
rowcall
```

In an interactive terminal outside a project, this guides you through a name,
location (defaulting to the current directory plus the project name), and a
package checklist. Polars is selected by default; pandas, matplotlib, and
seaborn are optional choices. Additional packages can be comma-separated,
including constraints such as `duckdb>=1.2,<2, scipy`. Confirm before any files
are created; answering `n` cancels without changes. The wizard creates a
dedicated `.venv`, even with Conda or another environment active, installs your
selections, and opens the browser. Its single **Start** node demonstrates
`display()` with sample data you can replace with your own. If installation
fails, the project is preserved; open its path to retry.

Inside a directory containing `graph.py`, `rowcall` behaves like `rowcall .`. It
does not search parent directories. Without an interactive terminal, bare
`rowcall` prints help. Explicit commands never launch the wizard.

To explore a branching example:

```sh
rowcall example my-example --open
```

One CSV feeds two branches: revenue by category and orders of at least $50. Run
the graph, inspect both tables, then change the `50` threshold in
`find_large_orders` and run that branch again. Its input still comes from the
same source; the category comparison stays separate. Each run currently
re-executes its upstream dependencies.

The example needs only Polars. Its generated `requirements.txt` contains
`polars`; Rowcall installs it when creating the project environment on first
open or run. Existing requirements files and user environments are preserved.

For the same workflow in a terminal:

```sh
rowcall validate my-example
rowcall run my-example --to find_large_orders --json=summary
```

Use `rowcall --help` for commands, or create a project directly with the default
packages:

Create and open a new Rowcall folder:

```sh
rowcall new my-work --open
```

This creates:

```text
my-work/
  .gitignore
  AGENTS.md
  data/
  graph.py
  graph.rowcall.json
  requirements.txt
```

`AGENTS.md` gives coding agents a short project-specific workflow.
`requirements.txt` lists the starter data packages. The `new` command does not
install them; the first `open` or `run` that creates a project environment does.

Opening uses `my-work/.venv` when it exists. Without one, Rowcall uses a
compatible active environment if available, or creates `my-work/.venv` and
installs `requirements.txt`. Rowcall records the file's hash and refreshes that
environment whenever the requirements change. To create and open with a specific
interpreter instead, run:

```sh
rowcall new my-work --open --python /path/to/python
```

Open an existing Rowcall folder or Python document:

```sh
rowcall open my-work
rowcall open path/to/graph.py
```

For convenience, `rowcall my-work` is an alias for `rowcall open my-work` when
the path already exists. Folder paths resolve to `graph.py` inside the folder.
To create a standalone Python document instead of a folder, pass a `.py` path:

```sh
rowcall new graph.py
```

The app is served at `http://127.0.0.1:8000/` and is bound to the local machine
only.

Drop one local file at a time onto the canvas to copy it into the project's
`data/` folder and create a source Node at the drop position. CSV, TSV, and
Parquet files receive editable Polars reader code. Other file types receive an
editable file-path Node. Rowcall never overwrites an existing data file and adds
a numeric suffix when needed.

### Python Environments

Opening and running use this interpreter order: explicit `--python`, an existing
`.venv` beside the document, an active virtualenv, an active Conda environment,
then a newly created project `.venv`. Rowcall installs `requirements.txt` only
in project environments it created, and refreshes dependencies whenever the file
changes. It never auto-installs into a pre-existing or active environment.

Share `requirements.txt`, not `.venv`; virtual environments contain
machine-specific paths and the generated `.gitignore` excludes them.

Pass a specific interpreter to override automatic selection:

```sh
rowcall open --python "$CONDA_PREFIX/bin/python" my-work
```

If you do not want to configure packages yourself, use Rowcall's managed starter
environment:

```sh
rowcall open --managed-env my-work
rowcall run --managed-env my-work --json
rowcall run --managed-env my-work --json=summary --trace=summary
rowcall run --managed-env my-work --outputs-only
```

The beta launcher stores its managed files under:

```text
~/.rowcall
~/.rowcall/venvs/default
~/.rowcall/logs/rowcall.log
```

On first managed-env use, or after `rowcall reset-env`, the launcher uses
`python3` then `python` to find Python 3.10 or newer, creates the managed venv,
installs the bundled `rowcall` Python package, and installs
`requirements-alpha.txt` dependencies: pandas, polars, and matplotlib.

Inspect the default user Python runtime:

```sh
rowcall doctor
rowcall doctor --json
```

Inspect the managed starter environment:

```sh
rowcall doctor --managed-env
```

Doctor is read-only: it reports missing or unchecked capabilities without
creating launcher assets, environments, or log files.

Recreate only the managed venv:

```sh
rowcall reset-env
```

### Headless CLI

Validate and run a Rowcall Python document without opening the canvas:

```sh
rowcall validate my-work
rowcall run my-work
rowcall run my-work --to node_id_or_function_name
```

Running without `--to` executes the full graph. Targets must be exact node IDs
or exact Python function names.

Pass `--json` for structured output and `--trace` to include per-step input
previews:

```sh
rowcall run my-work --json --trace
```

The launcher delegates headless commands to the selected Python runtime. `run`
uses the same environment policy as `open`. `validate` prefers an explicit
interpreter, existing project `.venv`, or active environment, then falls back to
system Python; it never creates `.venv` or installs packages. During
development, `uv run rowcall`, `python3 -m rowcall`, and `deno task cli` are
still useful local wrappers. Opening commands invoked through the Python CLI
delegate to the full launcher in the source checkout or installed on `PATH`:

```sh
uv run rowcall open my-work
python3 -m rowcall run my-work --json --trace
deno task cli run my-work --json --trace
```

The beta CLI intentionally does not accept external input values. Data and
configuration should enter through Python code in the document so runs remain
reproducible from the file itself.

See [docs/03-headless-cli.md](docs/03-headless-cli.md) for the CLI contract.

## Browser Regression Tests

The browser journey exercises the built UI, API, and Python runtime together:
edit, save, reload, run, recover from invalid Python, and handle external edits
without overwriting a conflicting draft. Additional cases protect edits during
pending saves/reloads and recovery when a committed save loses its response. CI
and release preparation run the suite.

With Node.js 22+ and the development Python environment installed:

```sh
deno task browser:install
ROWCALL_TEST_PYTHON="$PWD/.venv/bin/python" deno task test:browser
```

Install the browser once and after changing the pinned Playwright version. The
test uses a temporary project under `tmp/`, not your open graph. Failures save a
screenshot and trace under `output/playwright/`; CI uploads them as an artifact.
From `e2e/`, use `npx playwright show-trace <trace.zip>` to inspect the steps.
This is development tooling and is not bundled into the beta CLI.

## Run Locally For Development

Install Deno and Python 3.10 or newer, then prepare the repo-local development
environment:

```sh
deno task setup
```

This creates a repo-local `.venv`, installs the local `rowcall` Python package,
and installs `requirements-alpha.txt`. This is separate from the beta launcher's
`~/.rowcall/venvs/default`.

Start the full development environment:

```sh
deno task dev
```

This starts the watched Deno API and the Vite development server, then opens the
app at `http://127.0.0.1:5173/`. Vite hot-reloads UI changes and proxies API
requests. The browser receives the development-session authorization token in
the launch URL and sends it through the same client code used by a compiled
launcher.

By default Rowcall edits `examples/ecommerce/analysis.py`. To edit another local
document during development, pass either a project folder containing `graph.py`
or a `.py` path through the task:

```sh
deno task dev path/to/project
deno task dev path/to/analysis.py
```

Pass `--managed-env` to exercise the launcher's managed Python environment
instead of the document project's environment:

```sh
deno task dev --managed-env path/to/project
```

To create a new document and start the API against it, pass `--create` with the
new `.py` path:

```sh
deno task dev --create path/to/analysis.py
```

Pass `--no-open` to start both development processes without opening a browser:

```sh
deno task dev --no-open path/to/analysis.py
```

If port 5173 is already occupied, choose another Vite port explicitly:

```sh
deno task dev --ui-port 5174 path/to/analysis.py
```

Rowcall Python documents import a tiny local `rowcall` package:

```python
from rowcall import node


@node(id="n_load", outputs=["message"])
def read_message():
    message = "hello"
    return {"message": message}
```

Nodes can record ordered human-facing displays separately from values that flow
downstream. `display()` is available bare inside node code:

```python
@node(id="n_plot", outputs=["summary"])
def make_plot(data):
    summary = data.describe()
    chart = build_plot(summary)
    display(summary, label="Summary")
    display(chart, label="Chart")
    return {"summary": summary}
```

Displays use Rowcall's existing dataframe/value previews. Static image displays
accept PNG `bytes`/`bytearray`, objects with a callable `_repr_png_()` method,
and common plotting objects from Matplotlib, Seaborn, and Pillow. Plotly figures
are also supported when Plotly's optional Kaleido and Chrome/Chromium static
export dependencies are installed. Pass the plotting object to `display()`; do
not call `plt.show()` or export the image yourself. Interactive JavaScript plots
are not supported yet. See [ADR 0006](docs/adr/0006-execution-scoped-display.md)
for the full contract.

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

Document parsing and execution go through the Python runtime worker.
Selected-node runs execute that node's complete upstream dependency plan afresh;
no prior execution outputs are reused.

## Build And Serve The UI

```sh
deno task build
```

The build output is written to `app/ui/dist/`. After building, the Deno/Hono
server serves the React app from `http://127.0.0.1:8000/` while continuing to
handle document and execution API routes.

For a production-style local smoke test, build and start that single server:

```sh
deno task serve
```

`serve` builds the current UI before starting and opens the tokenized local app.
Pass `--no-open` to suppress the browser. Use `dev` for normal development and
hot reloading.

## Build The Beta Launcher

Compile the macOS beta launcher:

```sh
deno task launcher:compile
```

The task builds the UI first. The compiled binary is written to `dist/rowcall`
and embeds the built UI, the Python package, and `requirements-alpha.txt`.

Run the compiled-binary smoke test before a release or after changing launcher,
runtime, authentication, or asset-packaging behavior:

```sh
deno task smoke:binary
```

The smoke task rebuilds the binary, launches it against an isolated folder and
home directory, verifies the production UI assets and authenticated document
API, and then shuts it down.

For release hosting, publish platform-specific binaries such as:

```text
rowcall-darwin-arm64
rowcall-darwin-x64
```

The installer template in `packaging/install.sh` defaults to the release asset
host at `https://releases.rowcall.io`. It can also be configured with either a
direct binary URL or a release base URL:

```sh
ROWCALL_DOWNLOAD_URL=https://releases.rowcall.io/v0.1.0/rowcall-darwin-arm64 sh packaging/install.sh
ROWCALL_RELEASE_BASE=https://releases.rowcall.io ROWCALL_VERSION=v0.1.0 sh packaging/install.sh
```

## Release To rowcall.io

The release host is a Cloudflare Pages project named `rowcall-io`. The committed
`site/` directory contains the editable landing page source. The deployable site
is generated into `dist/site/` and is not committed.

Compiled release binaries are too large for Cloudflare Pages static assets, so
the large downloads are generated into `dist/r2/` and uploaded to a Cloudflare
R2 bucket. The default bucket name is `rowcall-io-releases`, and the expected
public custom domain is `https://releases.rowcall.io`.

Publishing is intentionally local and manual during the invited beta. Start from
a clean checkout and stage the release:

```sh
deno task release:prepare
```

This checks and tests the repository, builds both macOS binaries, natively
installs and exercises the binary for the current Mac, and assembles the site
and download directory. Inspect the staged output if desired, then authenticate
Wrangler with the Cloudflare account that owns the Pages project and R2 bucket
and publish those exact artifacts:

```sh
deno task release:publish
```

Publishing revalidates the clean source commit, native smoke receipt, binary
architectures, staged hashes, release manifest, installer, and site files before
contacting Cloudflare. It does not rebuild, so a retry publishes the same
artifacts.

The binary for the other macOS architecture is cross-built but not run. That is
an explicit friends-only beta tradeoff. Restore a native Intel/ARM build job,
code signing, and notarization before treating this as a hardened public
release.

This writes:

```text
dist/site/
  _headers
  favicon.svg
  index.html
  install.sh
  latest.json
  llms.txt

dist/r2/
  latest/rowcall-darwin-arm64
  latest/rowcall-darwin-arm64.sha256
  latest/rowcall-darwin-x64
  latest/rowcall-darwin-x64.sha256
  v0.1.0/rowcall-darwin-arm64
  v0.1.0/rowcall-darwin-arm64.sha256
  v0.1.0/rowcall-darwin-x64
  v0.1.0/rowcall-darwin-x64.sha256
```

Keep the Cloudflare Pages Git integration disabled during the invited beta.
Publish the generated `dist/site/` explicitly with Wrangler so a push to `main`
cannot change what testers receive.

Override the R2 bucket name or public download base if needed:

```sh
ROWCALL_RELEASE_DOWNLOAD_BASE=https://downloads.example.com \
  deno task release:prepare
ROWCALL_R2_BUCKET=my-bucket deno task release:publish
```
