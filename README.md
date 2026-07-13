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

For local release testing, build both artifacts and natively smoke the artifact
for the current Mac:

```sh
deno task release:build
deno task release:smoke
```

The smoke writes a diagnostic receipt beside that one artifact. The normal local
smoke command marks its receipt diagnostic, even from a clean checkout, and
deliberately does not attest the cross-built artifact for the other
architecture. Assembling an installable release requires the two authorizing
receipts from the manual GitHub workflow described in
[Release To nodebook.rodeo](#release-to-nodebookrodeo).

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
execution go through the Python runtime worker. Selected-node runs execute that
node's complete upstream dependency plan afresh; no prior execution outputs are
reused.

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

Publishing is intentionally manual during the invited beta. The release gate
requires each binary to have been run natively on its matching architecture.
There is no all-in-one build-and-publish command because a cross-build on one
Mac cannot satisfy that gate.

First, manually run the `Invited beta smoke` workflow for the exact commit to
publish. Its two jobs each build from that commit, natively install and run only
the matching artifact, and upload an artifact archive containing the files
below. The attestations record the shared workflow run ID and attempt,
dispatched commit, runner architecture, exact tested binary hash, and version:

```text
nodebook-darwin-arm64
nodebook-darwin-arm64.smoke-attestation.json

nodebook-darwin-x64
nodebook-darwin-x64.smoke-attestation.json
```

Download both workflow artifacts from that same workflow run and place all four
files in `dist/release/`. Do not rebuild either binary locally: each attestation
is bound to the exact binary hash, source commit, and version.

Then assemble the deployable static site and R2 asset directory:

```sh
deno task release:site
```

Assembly fails unless both native attestations are authorizing receipts from the
same manual workflow run and attempt, match their exact binaries and native
runner architectures, identify the same source commit and version, and that
commit is the clean checkout running the assembly command.

These JSON receipts are an unsigned, local guard against accidental artifact
mix-ups; they are not cryptographic proof of GitHub provenance and can be forged
by someone who can modify the release inputs. The publisher must download them
from the `wzich/nodebook` workflow run shown in GitHub. The release itself is
also unsigned during this invited beta.

This writes:

```text
dist/site/
  index.html
  install.sh
  latest.json

dist/r2/
  latest/nodebook-darwin-arm64
  latest/nodebook-darwin-arm64.sha256
  latest/nodebook-darwin-arm64.smoke-attestation.json
  latest/nodebook-darwin-x64
  latest/nodebook-darwin-x64.sha256
  latest/nodebook-darwin-x64.smoke-attestation.json
  v0.1.0/nodebook-darwin-arm64
  v0.1.0/nodebook-darwin-arm64.sha256
  v0.1.0/nodebook-darwin-arm64.smoke-attestation.json
  v0.1.0/nodebook-darwin-x64
  v0.1.0/nodebook-darwin-x64.sha256
  v0.1.0/nodebook-darwin-x64.smoke-attestation.json
```

Upload the generated R2 assets and deploy the generated site to Cloudflare Pages
with Wrangler:

```sh
deno task release:deploy
```

Deploy just one side when needed:

```sh
deno task release:deploy:assets
deno task release:deploy:site
```

Every deploy command reassembles from `dist/release/` and revalidates both the
`latest` and versioned artifact sets, so neither an unattested local cross-build
nor a one-architecture smoke can be published accidentally. The workflow only
uploads the binaries and attestations; it never publishes them. Local native
smoke remains useful for diagnostics: `release:smoke` installs the native
artifact into a temporary home and runs outside this checkout, but its single
attestation is not enough to assemble or publish a two-architecture release. The
normal local smoke command emits only diagnostic receipts. Receipts matching the
manual workflow convention are accepted for assembly, subject to the
unsigned-receipt limitation above.

Keep the Cloudflare Pages Git integration disabled during the invited beta.
Publish the generated `dist/site/` explicitly with Wrangler so a push to `main`
cannot change what testers receive.

Override the R2 bucket name or public download base if needed:

```sh
NODEBOOK_R2_BUCKET=my-bucket deno task release:deploy:assets
NODEBOOK_RELEASE_DOWNLOAD_BASE=https://downloads.example.com deno task release:site
```
