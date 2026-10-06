# Releasing Rowcall

## GitHub Actions

`VERSION` is the authoritative version. The launcher reads it and setuptools
uses it for Python package metadata. During beta, use patch bumps for compatible
fixes and small additions; use minor bumps for substantial features or changes
to the project format, CLI, or setup.

1. Merge changes into `main`.
2. Open **Actions → Release → Run workflow** on `main`. Choose patch or minor.
3. The workflow commits the version bump, runs checks and browser tests on
   native Apple Silicon, Intel Mac, and Windows x64 runners, and tests each
   installed binary in a clean environment. It stages the exact binaries,
   checksums, and native receipts.
4. Review the run summary and staged artifacts. Select **Review deployments →
   release → Approve and deploy**. Will Zich is the required reviewer and can
   approve a run he started.
5. Publication uploads the verified artifacts to Cloudflare R2, updates the
   website download manifest, and creates a GitHub Release with generated notes.

The approval gate must be configured before a release starts; the workflow fails
closed if required reviewers are missing. Build jobs have no Cloudflare secrets.
Artifacts expire after 14 days; approve within that period or start a new
release. A rejected or failed release may leave an unused version commit; gaps
are fine. Use **Re-run failed jobs** to retry the same candidate. Do not start a
new version just to retry an upload. Never rerun an older publication after a
newer release.

### One-time account setup

- GitHub environment `release`: required reviewer `wzich`, allow self-review,
  deployment branch `main` only. Required reviewers need a public repository on
  the current GitHub plan.
- GitHub environment `website`: no approval, deployment branch `main` only.
- Repository variable `CLOUDFLARE_ACCOUNT_ID`: the owning Cloudflare account.
- Each environment has a secret named `CLOUDFLARE_API_TOKEN`. Use a dedicated
  token scoped to the owning account: **Cloudflare Pages Edit** plus **Workers
  R2 Storage Write** for `release`; **Cloudflare Pages Edit** only for
  `website`.
- Repository Actions settings must allow the workflow token to push version
  commits. Branch protections may require a narrowly scoped automation
  exception.

### Website-only deployments

Changes under `site/` on `main` automatically deploy through **Website**. It
reads and preserves the current public `latest.json` and installers before
deploying; missing or invalid metadata stops deployment. This avoids publishing
unreleased installer changes or resetting the download version. Website and
release publication share a concurrency group, so they cannot deploy
simultaneously. A release deploy uses current `main` website files with its
verified installers and manifest. Keep Pages' separate Git integration disabled.

### Recovery

Versioned downloads remain available. For a product regression, prefer a new
patch release containing a revert. For a broken website, revert the site change
on `main`; the Website workflow redeploys it without changing binaries. Failed
publication can be partial (some R2 objects may already be uploaded); retry the
same run to finish. Do not overwrite an already released version with new code.

## Local release tooling

The manual commands below remain available for recovery. They do not replace the
normal GitHub approval process.

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
rowcall-windows-x64.exe
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

For local recovery, start from a clean macOS checkout. Download the Windows CI
artifact for that exact commit (use a branch/manual run, not a temporary PR
merge commit), then stage the release:

```sh
ROWCALL_WINDOWS_ARTIFACT_DIR="$PWD/tmp/windows-artifact/dist/release" deno task release:prepare
```

This checks and tests the repository, builds both macOS binaries, natively
installs and exercises the binary for the current Mac, and assembles the site
and download directory. It imports the Windows executable and requires its
native receipt to match the binary hash, version, and checkout commit. Inspect
the staged output if desired, then authenticate Wrangler with the Cloudflare
account that owns the Pages project and R2 bucket and publish those exact
artifacts:

```sh
deno task release:publish
```

Publishing revalidates the clean source commit, native smoke receipt, binary
architectures, staged hashes, release manifest, installer, and site files before
contacting Cloudflare. It does not rebuild, so a retry publishes the same
artifacts.

The binary for the other macOS architecture is cross-built but not run. That is
an explicit friends-only beta tradeoff. The normal GitHub workflow instead
requires native receipts for all three platforms. Code signing and notarization
remain outside this beta.

This writes:

```text
dist/site/
  _headers
  ecommerce.png
  style.css
  site.js
  index.html
  install.sh
  install.ps1
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

Keep the Cloudflare Pages Git integration disabled. Use the coordinated GitHub
workflows described above for normal publication.

Override the R2 bucket name or public download base if needed:

```sh
ROWCALL_RELEASE_DOWNLOAD_BASE=https://downloads.example.com \
  deno task release:prepare
ROWCALL_R2_BUCKET=my-bucket deno task release:publish
```
