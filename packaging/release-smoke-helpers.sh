#!/bin/sh

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

is_positive_decimal() {
  case "$1" in
    [1-9] | [1-9][0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

verify_architecture_outputs() {
  expected_architecture=$1
  lipo_architectures=$2
  file_description=$3

  case "$expected_architecture" in
    arm64)
      expected_lipo=arm64
      expected_file_fragment="Mach-O 64-bit executable arm64"
      ;;
    x64)
      expected_lipo=x86_64
      expected_file_fragment="Mach-O 64-bit executable x86_64"
      ;;
    *)
      echo "Unsupported expected Mach-O architecture: $expected_architecture" >&2
      return 1
      ;;
  esac

  if [ "$lipo_architectures" != "$expected_lipo" ]; then
    echo "Artifact architecture is '$lipo_architectures'; expected '$expected_lipo'." >&2
    return 1
  fi
  case "$file_description" in
    *"$expected_file_fragment"*) ;;
    *)
      echo "Unexpected Mach-O description: $file_description" >&2
      return 1
      ;;
  esac
}

verify_macho_architecture() {
  macho_path=$1
  expected_architecture=$2

  if [ ! -x /usr/bin/lipo ] || [ ! -x /usr/bin/file ]; then
    echo "System lipo and file tools are required for release smoke tests." >&2
    return 1
  fi
  lipo_architectures=$(/usr/bin/lipo -archs "$macho_path") || return 1
  file_description=$(/usr/bin/file -b "$macho_path") || return 1
  verify_architecture_outputs \
    "$expected_architecture" "$lipo_architectures" "$file_description"
}

verify_stable_smoke_hashes() {
  expected_hash=$1
  fixture_before_hash=$2
  fixture_after_hash=$3
  original_after_hash=$4
  installed_before_hash=${5:-$expected_hash}
  installed_after_hash=${6:-$expected_hash}

  if [ "$fixture_before_hash" != "$expected_hash" ]; then
    echo "Copied smoke fixture does not match the original artifact." >&2
    return 1
  fi
  if [ "$fixture_after_hash" != "$expected_hash" ]; then
    echo "Smoke fixture changed while it was being tested." >&2
    return 1
  fi
  if [ "$original_after_hash" != "$expected_hash" ]; then
    echo "Original artifact changed while its copy was being tested." >&2
    return 1
  fi
  if [ "$installed_before_hash" != "$expected_hash" ]; then
    echo "Installed launcher does not match the tested smoke fixture." >&2
    return 1
  fi
  if [ "$installed_after_hash" != "$expected_hash" ]; then
    echo "Installed launcher changed while it was being tested." >&2
    return 1
  fi
}
