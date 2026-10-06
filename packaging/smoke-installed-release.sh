#!/bin/sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
. "$project_root/packaging/release-smoke-helpers.sh"

if [ "${1:-}" = "--" ]; then
  shift
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Release artifacts must be smoke-tested on macOS." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64 | aarch64)
    default_asset="rowcall-darwin-arm64"
    expected_architecture=arm64
    ;;
  x86_64 | amd64)
    default_asset="rowcall-darwin-x64"
    expected_architecture=x64
    ;;
  *)
    echo "Unsupported smoke-test architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || true)" = "1" ]; then
  echo "Rosetta-translated execution cannot produce a native-smoke attestation." >&2
  exit 1
fi

artifact="${1:-$project_root/dist/release/$default_asset}"
case "$artifact" in
  /*) ;;
  *) artifact="$PWD/$artifact" ;;
esac
test -x "$artifact"
original_hash_start=$(sha256_file "$artifact")

version=$(tr -d '\r\n' < "$project_root/VERSION")
source_commit_start=$(git -C "$project_root" rev-parse HEAD)
source_status_start=$(git -C "$project_root" status --porcelain=v1 --untracked-files=normal)

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/rowcall-release-smoke.XXXXXX")
cleanup() {
  rm -rf "$temporary_root"
}
trap cleanup EXIT

asset=$(basename "$artifact")
if [ "$asset" != "$default_asset" ]; then
  echo "Cannot natively smoke $asset on $(uname -m); expected $default_asset." >&2
  exit 1
fi
fixture_dir="$temporary_root/artifact"
install_dir="$temporary_root/bin"
smoke_home="$temporary_root/home"
document_dir="$temporary_root/document"
runtime_dir="$temporary_root/outside-checkout"
clean_venv="$temporary_root/clean-python"
clean_python="$clean_venv/bin/python"
launcher="$install_dir/rowcall"
mkdir -p "$fixture_dir" "$smoke_home" "$runtime_dir"
cp "$artifact" "$fixture_dir/$asset"
fixture="$fixture_dir/$asset"
fixture_hash_before=$(sha256_file "$fixture")
if [ "$fixture_hash_before" != "$original_hash_start" ]; then
  echo "Copied smoke fixture does not match the original artifact." >&2
  exit 1
fi
verify_macho_architecture "$fixture" "$expected_architecture"
printf '%s  %s\n' "$fixture_hash_before" "$asset" > "$fixture.sha256"

# Keep the release smoke independent from any editable Rowcall package used
# to build or test the checkout.
python3 -m venv "$clean_venv"
cd "$runtime_dir"
PYTHONPATH= "$clean_python" -c \
  'import importlib.util; assert importlib.util.find_spec("rowcall") is None'

HOME="$smoke_home" \
  ROWCALL_INSTALL_DIR="$install_dir" \
  ROWCALL_DOWNLOAD_URL="file://$fixture_dir/$asset" \
  sh "$project_root/packaging/install.sh"

installed_hash_before=$(sha256_file "$launcher")
if [ "$installed_hash_before" != "$original_hash_start" ]; then
  echo "Installed launcher does not match the tested smoke fixture." >&2
  exit 1
fi
verify_macho_architecture "$launcher" "$expected_architecture"

# Run outside the checkout with an otherwise empty Python environment. The
# launcher must materialize and use the Python package embedded in the asset.
cd "$runtime_dir"
# Exercise the dependency-free starter in the deliberately empty Python venv.
mkdir -p "$document_dir"
: > "$document_dir/requirements.txt"
HOME="$smoke_home" PYTHONPATH= "$launcher" new "$document_dir"
HOME="$smoke_home" PYTHONPATH= "$launcher" validate "$document_dir" \
  --python "$clean_python" --json \
  > "$temporary_root/validate.json"
HOME="$smoke_home" PYTHONPATH= "$launcher" run "$document_dir" \
  --python "$clean_python" --to n_start --json \
  > "$temporary_root/run.json"

reported_version=$(HOME="$smoke_home" PYTHONPATH= "$launcher" --version)
if [ "$reported_version" != "$version" ]; then
  echo "Artifact reports version $reported_version; checkout VERSION is $version." >&2
  exit 1
fi

PYTHONPATH="$smoke_home/.rowcall/bundled/python-package" \
  "$clean_python" -c \
  'import pathlib,rowcall,sys; root=pathlib.Path(sys.argv[1]).resolve(); imported=pathlib.Path(rowcall.__file__).resolve(); assert imported.is_relative_to(root), (imported, root)' \
  "$smoke_home/.rowcall/bundled/python-package"

python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); assert p["ok"] and p["command"] == "validate"' \
  "$temporary_root/validate.json"
python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); assert p["ok"] and p["command"] == "run"; assert p["response"]["executedNodeIds"] == ["n_start"]; assert p["response"]["resultsByNode"]["n_start"]["displays"][0]["jsonValue"] == "Welcome to Rowcall"' \
  "$temporary_root/run.json"

fixture_hash_after=$(sha256_file "$fixture")
original_hash_end=$(sha256_file "$artifact")
installed_hash_after=$(sha256_file "$launcher")
verify_stable_smoke_hashes \
  "$original_hash_start" "$fixture_hash_before" \
  "$fixture_hash_after" "$original_hash_end" \
  "$installed_hash_before" "$installed_hash_after"
source_commit=$(git -C "$project_root" rev-parse HEAD)
source_status_end=$(git -C "$project_root" status --porcelain=v1 --untracked-files=normal)
if [ "$source_commit" != "$source_commit_start" ]; then
  echo "Source commit changed during the smoke test; refusing to attest the artifact." >&2
  exit 1
fi
if [ -n "$source_status_start" ] || [ -n "$source_status_end" ]; then
  source_dirty=true
else
  source_dirty=false
fi

attestation="$artifact.smoke-attestation.json"
python3 -c 'import json,sys
path,asset,digest,version,commit,dirty,architecture=sys.argv[1:]
record={
    "schemaVersion": 1,
    "asset": asset,
    "sha256": digest,
    "version": version,
    "sourceCommit": commit,
    "sourceDirty": dirty == "true",
    "nativeArchitecture": architecture,
}
with open(path, "w", encoding="utf-8") as output:
    json.dump(record, output, indent=2, separators=(",", ": "))
    output.write("\n")' \
  "$attestation" "$asset" "$original_hash_start" "$version" "$source_commit" \
  "$source_dirty" "$expected_architecture"

echo "Installed-artifact smoke test passed: $asset"
echo "Wrote smoke attestation: $attestation"
