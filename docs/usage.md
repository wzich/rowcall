# Using Rowcall

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

See [Headless CLI](03-headless-cli.md) for the CLI contract.
