#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cleanliness_script="$script_dir/check-runtime-cleanliness.sh"
temporary_root="$(mktemp -d)"

cleanup() {
  local target="${temporary_root:-}"
  if [[ -z "$target" || "$target" != /* || "$target" =~ ^/+$ ]]; then
    printf 'Refusing unsafe cleanliness-fixture cleanup target: %s\n' \
      "${target:-<empty>}" >&2
    return 2
  fi
  rm -rf -- "$target"
}
trap cleanup EXIT

expect_failure() {
  local description="$1"
  local expected_path="$2"
  local output
  if output="$(REPOSITORY_ROOT="$temporary_root" \
    "$cleanliness_script" 2>&1)"; then
    printf 'Expected runtime-cleanliness failure: %s\n' "$description" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected_path"* ]]; then
    printf 'Runtime-cleanliness failure for %s did not identify %s:\n%s\n' \
      "$description" "$expected_path" "$output" >&2
    exit 1
  fi
}

git -C "$temporary_root" init -q
git -C "$temporary_root" config user.name "CI Cleanliness Test"
git -C "$temporary_root" config user.email "ci-cleanliness@example.invalid"
printf '%s\n' \
  'node_modules/' \
  'dist/' \
  '.venv/' \
  'data/' \
  'runtime-root/' \
  '*.sqlite-wal' > "$temporary_root/.gitignore"
printf '# Fixture\n' > "$temporary_root/README.md"
git -C "$temporary_root" add .gitignore README.md
git -C "$temporary_root" commit -q -m "test: initialize fixture"

mkdir -p "$temporary_root/node_modules/example/data" \
  "$temporary_root/python/dist" "$temporary_root/python/.venv"
printf 'expected generated cache\n' > \
  "$temporary_root/node_modules/example/data/cache.sqlite"
printf 'expected build output\n' > "$temporary_root/python/dist/package.whl"
printf 'expected environment\n' > "$temporary_root/python/.venv/marker"
REPOSITORY_ROOT="$temporary_root" "$cleanliness_script"

for exact_path in secrets nested/credentials private; do
  mkdir -p "$temporary_root/$(dirname "$exact_path")"
  printf 'synthetic private content\n' > "$temporary_root/$exact_path"
  expect_failure "exact prohibited file $exact_path" "$exact_path"
  rm "$temporary_root/$exact_path"
done

mkdir -p "$temporary_root/runtime-root"
printf 'synthetic runtime content\n' > \
  "$temporary_root/runtime-root/private-state.txt"
expect_failure "ignored runtime root" "runtime-root/private-state.txt"
rm -rf "$temporary_root/runtime-root"

printf 'synthetic SQLite sidecar\n' > "$temporary_root/foundation.sqlite-wal"
expect_failure "ignored SQLite sidecar" "foundation.sqlite-wal"
rm "$temporary_root/foundation.sqlite-wal"

mkdir -p "$temporary_root/temporary-work"
printf 'synthetic temporary work\n' > \
  "$temporary_root/temporary-work/operation.txt"
expect_failure "unignored temporary work" \
  "temporary-work/operation.txt"

printf 'Checkout runtime-cleanliness negative fixtures passed.\n'
