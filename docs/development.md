# Developing Rowcall

Requires Deno 2, Python 3.10+, and Node.js 22+ for browser tests. Run these
commands from the repository root.

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
are not supported yet. See [ADR 0006](adr/0006-execution-scoped-display.md) for
the full contract.

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

## Verification

```sh
deno task check
PATH="$PWD/.venv/bin:$PATH" deno task test
deno task build
git diff --check
```

For UI, save, or run changes, also run the browser regression suite described
above. See [release instructions](releasing.md) for installed-artifact checks.
