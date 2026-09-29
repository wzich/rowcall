# Releasing Rowcall

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
  ecommerce.png
  style.css
  site.js
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
