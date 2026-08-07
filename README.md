# Nodebook

Nodebook is a canvas-based computational notebook prototype. The current repo
has a Python runtime for parsing, validating, planning, and executing
graph-shaped Python notebooks, plus a Deno/Hono API and Vite/React canvas UI for
editing and managing those documents.

## Beta Tester Start

Beta testers will install a single `nodebook` launcher. Python 3.10 or newer
must already be installed. Opening a document creates or reuses a project-local
`.venv` by default and temporarily adds Nodebook's own runtime package to the
Nodebook process.

This is an invited beta, not a hardened public release. The macOS launcher is
currently unsigned and not notarized, and Nodebook executes Python with the
permissions of the user who started it. Open only documents whose code you
trust. The installer verifies published SHA-256 checksums to detect corruption;
checksums are not a substitute for publisher code signing.

Invited-beta limitations are intentionally explicit:

- Runs always execute fresh through the requested node's upstream dependencies;
  there is no execution cache.
- Unsaved browser edits are held only in memory and are lost if the browser or
  app crashes.
- If a save response is interrupted or otherwise uncertain, reload the document
  before editing again. Nodebook does not guess whether to replay the save.
- Run only one Nodebook launcher/process at a time. Concurrent launcher updates
  and managed-environment setup are not supported in this beta.
- Publishing is manual.

Close every running Nodebook process before reinstalling or updating the
launcher.

```sh
curl -fsSL https://nodebook.rodeo/install.sh | sh
```

To upgrade, run the same installer command again. It replaces only the
`nodebook` launcher in `~/.local/bin`; the launcher refreshes its managed Python
runtime the next time it runs if the bundled Nodebook version changed.

To run the complete release check without uploading anything:

```sh
deno task release:prepare
```

This checks and tests the repository, builds both macOS artifacts, exercises the
artifact native to the current Mac outside the checkout, and stages the
Cloudflare upload. The other architecture is cross-built but not executed.

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
  .gitignore
  graph.py
```

Opening also creates `my-work/.venv` when the project does not already have one.
To create and open with a specific interpreter instead, run:

```sh
nodebook new my-work --open --python /path/to/python
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

Opening a document creates or reuses `.venv` beside the document by default.
Pass a specific interpreter to use it directly without creating the project
environment:

```sh
nodebook open --python "$CONDA_PREFIX/bin/python" my-work
```

If you do not want to configure packages yourself, use Nodebook's managed
starter environment:

```sh
nodebook open --managed-env my-work
nodebook run --managed-env my-work --json
nodebook run --managed-env my-work --json=summary --trace=summary
nodebook run --managed-env my-work --outputs-only
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
nodebook doctor --json
```

Inspect the managed starter environment:

```sh
nodebook doctor --managed-env
```

Doctor is read-only: it reports missing or unchecked capabilities without
creating launcher assets, environments, or log files.

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
development, `uv run nodebook`, `python3 -m nodebook`, and `deno task cli` are
still useful local wrappers. Opening commands invoked through the Python CLI
delegate to the full launcher in the source checkout or installed on `PATH`:

```sh
uv run nodebook open my-work
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

Start the full development environment:

```sh
deno task dev
```

This starts the watched Deno API and the Vite development server, then opens the
app at `http://127.0.0.1:5173/`. Vite hot-reloads UI changes and proxies API
requests with a development-session authorization token, so API restarts do not
require opening a new tokenized URL.

By default Nodebook edits `examples/ecommerce/analysis.py`. To edit another
local document during development, pass a `.py` path through the task:

```sh
deno task dev path/to/analysis.py
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
deno task beta:compile
```

The task builds the UI first. The compiled binary is written to `dist/nodebook`
and embeds the built UI, the Python package, and `requirements-alpha.txt`.

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

Keep the Cloudflare Pages Git integration disabled during the invited beta.
Publish the generated `dist/site/` explicitly with Wrangler so a push to `main`
cannot change what testers receive.

Override the R2 bucket name or public download base if needed:

```sh
NODEBOOK_RELEASE_DOWNLOAD_BASE=https://downloads.example.com \
  deno task release:prepare
NODEBOOK_R2_BUCKET=my-bucket deno task release:publish
```
