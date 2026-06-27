#!/bin/sh
set -eu

install_dir="${NODEBOOK_INSTALL_DIR:-$HOME/.local/bin}"
install_path="$install_dir/nodebook"
download_url="${NODEBOOK_DOWNLOAD_URL:-}"
release_base="${NODEBOOK_RELEASE_BASE:-}"
release_version="${NODEBOOK_VERSION:-latest}"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  *)
    echo "Nodebook beta installer currently supports macOS only." >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *)
    echo "Unsupported CPU architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

asset="nodebook-$os-$arch"

if [ -z "$download_url" ]; then
  if [ -z "$release_base" ]; then
    echo "Set NODEBOOK_RELEASE_BASE or NODEBOOK_DOWNLOAD_URL before running this installer." >&2
    echo "Example: NODEBOOK_RELEASE_BASE=https://beta.nodebook.dev sh install.sh" >&2
    exit 1
  fi
  download_url="${release_base%/}/$release_version/$asset"
fi

tmp_file="$(mktemp "${TMPDIR:-/tmp}/nodebook.XXXXXX")"
cleanup() {
  rm -f "$tmp_file"
}
trap cleanup EXIT

echo "Downloading $download_url"
curl -fsSL "$download_url" -o "$tmp_file"
chmod +x "$tmp_file"

echo "Verifying downloaded Nodebook..."
"$tmp_file" --version >/dev/null

mkdir -p "$install_dir"
mv "$tmp_file" "$install_path"
trap - EXIT

echo "Installed Nodebook to $install_path"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    echo ""
    echo "$install_dir is not on PATH."
    echo "Add this to your shell profile:"
    echo "  export PATH=\"$install_dir:\$PATH\""
    ;;
esac

