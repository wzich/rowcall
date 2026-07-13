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
    default_asset="nodebook-darwin-arm64"
    expected_architecture=arm64
    expected_runner_architecture=ARM64
    ;;
  x86_64 | amd64)
    default_asset="nodebook-darwin-x64"
    expected_architecture=x64
    expected_runner_architecture=X64
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

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/nodebook-release-smoke.XXXXXX")
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
launcher="$install_dir/nodebook"
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

# Keep the release smoke independent from any editable Nodebook package used
# to build or test the checkout.
python3 -m venv "$clean_venv"
cd "$runtime_dir"
PYTHONPATH= "$clean_python" -c \
  'import importlib.util; assert importlib.util.find_spec("nodebook") is None'

HOME="$smoke_home" \
  NODEBOOK_INSTALL_DIR="$install_dir" \
  NODEBOOK_DOWNLOAD_URL="file://$fixture_dir/$asset" \
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
HOME="$smoke_home" PYTHONPATH= "$launcher" new "$document_dir"
HOME="$smoke_home" PYTHONPATH= "$launcher" validate "$document_dir" \
  --python "$clean_python" --json \
  > "$temporary_root/validate.json"
HOME="$smoke_home" PYTHONPATH= "$launcher" run "$document_dir" \
  --python "$clean_python" --to n_shout --json \
  > "$temporary_root/run.json"

reported_version=$(HOME="$smoke_home" PYTHONPATH= "$launcher" --version)
if [ "$reported_version" != "$version" ]; then
  echo "Artifact reports version $reported_version; checkout VERSION is $version." >&2
  exit 1
fi

PYTHONPATH="$smoke_home/.nodebook/bundled/python-package" \
  "$clean_python" -c \
  'import pathlib,nodebook,sys; root=pathlib.Path(sys.argv[1]).resolve(); imported=pathlib.Path(nodebook.__file__).resolve(); assert imported.is_relative_to(root), (imported, root)' \
  "$smoke_home/.nodebook/bundled/python-package"

python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); assert p["ok"] and p["command"] == "validate"' \
  "$temporary_root/validate.json"
python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); assert p["ok"] and p["command"] == "run"; assert p["response"]["executedNodeIds"] == ["n_load", "n_shout"]; assert p["response"]["finalOutputsByNode"]["n_shout"]["shouted"]["jsonValue"] == "HELLO FROM NODEBOOK"' \
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

authorization=diagnostic
workflow_run_id=
workflow_run_attempt=
workflow_name=
workflow_event=
workflow_job=
workflow_ref=
workflow_repository=
runner_architecture=
workflow_ref_valid=false
case "${GITHUB_WORKFLOW_REF:-}" in
  wzich/nodebook/.github/workflows/invited-beta-smoke.yml@*) workflow_ref_valid=true ;;
esac
if [ "${GITHUB_ACTIONS:-}" = true ] &&
  [ "${GITHUB_REPOSITORY:-}" = wzich/nodebook ] &&
  [ "${GITHUB_EVENT_NAME:-}" = workflow_dispatch ] &&
  [ "${GITHUB_WORKFLOW:-}" = "Invited beta smoke" ] &&
  [ "${GITHUB_JOB:-}" = build-and-smoke ] &&
  [ "$workflow_ref_valid" = true ] &&
  [ "${GITHUB_SHA:-}" = "$source_commit" ] &&
  [ "${RUNNER_OS:-}" = macOS ] &&
  [ "${RUNNER_ARCH:-}" = "$expected_runner_architecture" ] &&
  is_positive_decimal "${GITHUB_RUN_ID:-}" &&
  is_positive_decimal "${GITHUB_RUN_ATTEMPT:-}" &&
  [ "$source_dirty" = false ]; then
  authorization=github-actions-workflow
  workflow_run_id=$GITHUB_RUN_ID
  workflow_run_attempt=$GITHUB_RUN_ATTEMPT
  workflow_name=$GITHUB_WORKFLOW
  workflow_event=$GITHUB_EVENT_NAME
  workflow_job=$GITHUB_JOB
  workflow_ref=$GITHUB_WORKFLOW_REF
  workflow_repository=$GITHUB_REPOSITORY
  runner_architecture=$RUNNER_ARCH
fi

if [ "${NODEBOOK_RELEASE_REQUIRE_AUTHORIZING:-0}" = 1 ] &&
  [ "$authorization" != github-actions-workflow ]; then
  echo "This workflow job did not produce a valid authorizing release receipt." >&2
  exit 1
fi

attestation="$artifact.smoke-attestation.json"
python3 -c 'import json,sys
path,asset,digest,version,commit,dirty,architecture,authorization,run_id,run_attempt,workflow_name,workflow_event,workflow_job,workflow_ref,workflow_repository,runner_architecture=sys.argv[1:]
record={
    "schemaVersion": 2,
    "asset": asset,
    "sha256": digest,
    "version": version,
    "sourceCommit": commit,
    "sourceDirty": dirty == "true",
    "nativeArchitecture": architecture,
    "authorization": authorization,
    "workflowRunId": run_id or None,
    "workflowRunAttempt": run_attempt or None,
    "workflowName": workflow_name or None,
    "workflowEvent": workflow_event or None,
    "workflowJob": workflow_job or None,
    "workflowRef": workflow_ref or None,
    "workflowRepository": workflow_repository or None,
    "runnerArchitecture": runner_architecture or None,
}
with open(path, "w", encoding="utf-8") as output:
    json.dump(record, output, indent=2, separators=(",", ": "))
    output.write("\n")' \
  "$attestation" "$asset" "$original_hash_start" "$version" "$source_commit" \
  "$source_dirty" "$expected_architecture" "$authorization" \
  "$workflow_run_id" "$workflow_run_attempt" "$workflow_name" \
  "$workflow_event" "$workflow_job" "$workflow_ref" "$workflow_repository" \
  "$runner_architecture"

echo "Installed-artifact smoke test passed: $asset"
echo "Wrote smoke attestation: $attestation"
if [ "$authorization" = diagnostic ]; then
  echo "Note: local smoke attestations are diagnostic and cannot authorize publishing." >&2
fi
