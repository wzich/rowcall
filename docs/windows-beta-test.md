# Windows beta testing

Target: Windows x64 with Python 3.10 or newer available as `python` or
`python3`. Windows ARM64 and a bundled Python installer are outside this beta's
scope.

Before publishing, the Windows GitHub Actions job must pass unit tests, the
browser journey, compilation, and the installed executable smoke test. Download
its `rowcall-windows-x64` artifact from the same commit being reviewed. Unzip
it; keep the executable and its `.sha256` file together under `dist/release`.
The artifact is a test download, not a published release. It includes the tested
installer and native smoke attestation.

After a Windows-enabled release is published, download
`https://rowcall.io/install.ps1` and run it with PowerShell to install the
published build. Before publication, in PowerShell, from the extracted CI
artifact folder:

```powershell
python --version
$download = ([Uri](Resolve-Path .\dist\release\rowcall-windows-x64.exe).Path).AbsoluteUri
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\install.ps1 -DownloadUrl $download
$rowcall = "$env:LOCALAPPDATA\Rowcall\bin\rowcall.exe"
& $rowcall --version
& $rowcall doctor --json
& $rowcall example "$env:USERPROFILE\rowcall beta test" --open
```

The beta executable is unsigned. Record any Windows download or launch prompt;
do not disable antivirus or change machine-wide security settings. If blocked,
report the prompt and stop that test.

Check these steps and report where the first unexpected result occurs:

1. Installation completes, and `--version` and `doctor` return useful output.
2. The example opens automatically in the default browser, with a graph visible.
3. Run the graph. Inspect a table and its columns and rows.
4. Edit a step, save, run again, and confirm its result changes.
5. Change `graph.py` in a text editor. Observe reload in the browser, then
   rerun.
6. Introduce a Python syntax error, save, and confirm it is reported. Fix it,
   save, and confirm running works again.
7. Start a slow step (for example `import time; time.sleep(60)` before its
   return), cancel it, then restore the code and run again.
8. Close the CLI with Ctrl+C. Reopen the same project and confirm saved edits
   persist. Try the install command again with Rowcall closed.

Send the commit/artifact name, Windows version, Python version, browser, failed
step, and relevant terminal output. Do not include the authenticated browser URL
or private project data. Use only the disposable example for these checks.

For development on Windows, `deno task setup` creates
`.venv\Scripts\python.exe`. The Python test task automatically uses the
checkout's virtualenv, with system Python as a fallback. Run `deno task check`,
`deno task test`, and `deno task
build`. For browser tests, set
`$env:ROWCALL_TEST_PYTHON` to the full path of `.venv\Scripts\python.exe`, then
run `deno task browser:install` and `deno task test:browser`.
