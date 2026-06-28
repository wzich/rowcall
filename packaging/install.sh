#!/bin/sh
set -eu

install_dir="${NODEBOOK_INSTALL_DIR:-$HOME/.local/bin}"
install_path="$install_dir/nodebook"
download_url="${NODEBOOK_DOWNLOAD_URL:-}"
release_base="${NODEBOOK_RELEASE_BASE:-https://releases.nodebook.rodeo}"
release_version="${NODEBOOK_VERSION:-latest}"
skip_checksum="${NODEBOOK_SKIP_CHECKSUM:-}"

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
  download_url="${release_base%/}/$release_version/$asset"
fi
checksum_url="${download_url}.sha256"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/nodebook.XXXXXX")"
tmp_file="$tmp_dir/$asset"
tmp_checksum="$tmp_dir/$asset.sha256"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

echo "Downloading $download_url"
curl -fsSL "$download_url" -o "$tmp_file"

if [ "$skip_checksum" != "1" ]; then
  echo "Downloading $checksum_url"
  curl -fsSL "$checksum_url" -o "$tmp_checksum"
  echo "Verifying checksum..."
  (cd "$tmp_dir" && shasum -a 256 -c "$asset.sha256")
else
  echo "Skipping checksum verification because NODEBOOK_SKIP_CHECKSUM=1"
fi

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
