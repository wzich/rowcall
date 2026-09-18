# Working on Rowcall

Rowcall's beta is a local CLI opening a Python graph in a browser canvas. Keep
changes small and preserve the current document format and fresh-run behavior.
The beta working document is `tmp/beta-readiness.html`; update its implemented
changes, verification, and decision log when beta preparation work changes them.

## Development

- Use Deno 2 and Python 3.10+. `deno task setup` prepares `.venv` with the data
  libraries. The Python test task prefers the checkout’s `.venv` (including
  `Scripts/python.exe` on Windows), then Python from PATH. Explicitly prepend
  the current `.venv/bin` as shown below for other tools. An activation script
  can retain an old absolute path if the checkout was renamed.
- Create disposable projects inside ignored `tmp/`:
  `deno task launcher example tmp/my-review`.
- Start both API and UI with
  `deno task dev --document tmp/my-review --no-open --python "$PWD/.venv/bin/python"`.
  Use the authenticated URL printed by that process. Alternate ports are
  `--port 8013 --ui-port 5178`. Do not restart after every graph edit; disk
  changes reload automatically.
- The installed binary is the beta user's entry point. `deno task launcher`
  exercises its source; `python -m rowcall` exercises the headless Python CLI.
  They have different environment/bootstrap responsibilities.

## Ownership and invariants

- `rowcall/document/`: Python parsing, validation, planning, and source
  rewriting.
- `rowcall/runtime/`: graph execution, displays, previews, and table inspection.
- `python_document.ts`: revision checks and transactional source/sidecar saves.
- `main.ts`, `executor.ts`, `python_worker_client.ts`: HTTP and worker
  orchestration.
- `launcher.ts`: launch and environment creation/recovery.
- `project_environment.ts`: shared dependency sync for launcher and UI; owns
  environment ownership checks, pip invocation, hashes, and setup markers. Mark
  incomplete before pip and record the starting requirements hash only after
  success. Keep installer output out of structured CLI stdout.
- `app/ui/src/`: canvas, editor, run presentation, and document editing.
- `app/ui/src/useDocumentSession.ts` owns draft/edit/save/reload state. Graph
  actions submit `editDocument(nextDocument, operations, impact)` atomically;
  asynchronous work reads `getSnapshot()` after awaits. Keep revision and save
  refs private to this hook. Execution and UI navigation remain in App.
- Preserve stable node IDs, unknown/custom source, revision conflict detection,
  and save recovery. Transaction and import-freshness complexity protects data;
  do not remove it merely to reduce line count.
- Runs execute ancestors fresh. The latest-result store serves table inspection;
  it is not an execution cache. UI in-memory state is not durable storage.
- There is no beta compatibility obligation for unused commands, routes, or
  worker verbs. Trace callers and remove obsolete paths through the stack;
  preserve active app/CLI behavior and the document safety invariants above.
- Keep project dependencies in the project's requirements. Never auto-install
  into an existing user environment. Preserve structured stdout for JSON CLI
  runs.

## Verification

Run the narrow tests relevant to a change first. Before handing off code:

```sh
deno task check
PATH="$PWD/.venv/bin:$PATH" deno task test
deno task build
git diff --check
```

Check for skipped Python tests: pandas/polars worker tests require those
packages. UI unit tests mostly cover helpers; the browser suite exercises the
real built UI, API, and Python worker. For UI or save/run changes, use a
disposable graph to verify: open, edit, save, run, inspect a result, edit on
disk, observe reload, and rerun. Exercise a syntax error and recovery when
editing/execution behavior changes. Do not use real user projects for
destructive tests.

For UI/save/run changes, also run the automated browser journey (Node.js 22+
needed for this development-only tool):

```sh
deno task browser:install
ROWCALL_TEST_PYTHON="$PWD/.venv/bin/python" deno task test:browser
```

The install command is needed once and after Playwright version changes. Tests
use an isolated project under `tmp/`, preserve failures under
`output/playwright/`, and never attach to your open app. Use
`cd e2e && npx playwright show-trace <path>` to inspect a saved trace. CI
uploads the failure artifacts. The suite covers the main journey plus edits
during saves/reloads and recovery from an uncertain save outcome. A browser
failure blocks CI and release preparation; do not bypass it to get a green
release.

For release artifacts, `deno task release:prepare` performs the repository and
native installed-artifact checks and stages uploads; it does not publish. It is
expensive and is separate from the normal patch loop. Do not claim the opposite
Mac architecture ran merely because it cross-compiled. Publishing is a separate,
explicit action. See `tools/release.ts` and the README for the release workflow.
