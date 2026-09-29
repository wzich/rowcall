#!/bin/sh
set -eu

install_dir="${ROWCALL_INSTALL_DIR:-$HOME/.local/bin}"
install_path="$install_dir/rowcall"
download_url="${ROWCALL_DOWNLOAD_URL:-}"
release_base="${ROWCALL_RELEASE_BASE:-https://releases.rowcall.io}"
release_version="${ROWCALL_VERSION:-latest}"
skip_checksum="${ROWCALL_SKIP_CHECKSUM:-}"

echo "Rowcall is an early beta. The macOS binary is unsigned and not notarized."
echo "Rowcall runs Python with your user permissions; open only documents you trust."
echo "Close any running Rowcall process before installing or updating."
echo ""

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  *)
    echo "Rowcall beta installer currently supports macOS only." >&2
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

asset="rowcall-$os-$arch"

if [ -z "$download_url" ]; then
  download_url="${release_base%/}/$release_version/$asset"
fi
checksum_url="${download_url}.sha256"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/rowcall.XXXXXX")"
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
  echo "Skipping checksum verification because ROWCALL_SKIP_CHECKSUM=1"
fi

chmod +x "$tmp_file"

echo "Verifying downloaded Rowcall..."
"$tmp_file" --version >/dev/null

mkdir -p "$install_dir"
mv "$tmp_file" "$install_path"
trap - EXIT

echo "Installed Rowcall to $install_path"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    echo ""
    echo "$install_dir is not on PATH."
    echo "Add this to your shell profile:"
    echo "  export PATH=\"$install_dir:\$PATH\""
    ;;
esac
