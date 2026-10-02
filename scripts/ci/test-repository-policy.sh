#!/usr/bin/env bash
set -euo pipefail

# CI supplies revisions for the real repository policy check. Synthetic fixture
# repositories must start from their own HEAD unless a fixture sets a revision.
unset POLICY_REVISION POLICY_BASE_REVISION

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
policy_script="$script_dir/check-repository-policy.sh"
temporary_root="$(mktemp -d)"

cleanup_temporary_root() {
  local target="${1:-}"

  if [[ -z "$target" || "$target" =~ ^/+$ || "$target" != /* ]]; then
    printf 'Refusing unsafe temporary cleanup target: %s\n' \
      "${target:-<empty>}" >&2
    return 2
  fi

  rm -rf -- "$target"
}

cleanup() {
  cleanup_temporary_root "${temporary_root:-}"
}
trap cleanup EXIT

for unsafe_cleanup_target in "" "/" "//" "///" "." ".." "relative/path"; do
  if cleanup_output="$(cleanup_temporary_root \
    "$unsafe_cleanup_target" 2>&1)"; then
    printf 'Expected unsafe cleanup target rejection: %s\n' \
      "${unsafe_cleanup_target:-<empty>}" >&2
    exit 1
  fi
  if [[ "$cleanup_output" != *"Refusing unsafe temporary cleanup target"* ]]; then
    printf 'Cleanup rejection did not contain the expected diagnostic:\n%s\n' \
      "$cleanup_output" >&2
    exit 1
  fi
done

cleanup_fixture="$temporary_root/cleanup-fixture"
mkdir -p "$cleanup_fixture"
cleanup_temporary_root "$cleanup_fixture"
if [[ -e "$cleanup_fixture" ]]; then
  printf 'Safe temporary cleanup fixture still exists.\n' >&2
  exit 1
fi

new_fixture_repository() {
  local name="$1"
  local repository="$temporary_root/$name"

  mkdir -p "$repository"
  git -C "$repository" init -q
  git -C "$repository" config user.name "CI Policy Test"
  git -C "$repository" config user.email "ci-policy@example.invalid"
  printf '# Fixture\n' > "$repository/README.md"
  git -C "$repository" add README.md
  git -C "$repository" commit -q -m "test: initialize fixture"
  printf '%s\n' "$repository"
}

expect_failure() {
  local description="$1"
  local repository="$2"
  local expected_text="$3"
  local output

  if output="$(REPOSITORY_ROOT="$repository" "$policy_script" 2>&1)"; then
    printf 'Expected failure: %s\n' "$description" >&2
    exit 1
  fi

  if [[ "$output" != *"$expected_text"* ]]; then
    printf 'Failure for %s did not contain: %s\n%s\n' \
      "$description" "$expected_text" "$output" >&2
    exit 1
  fi
}

clean_repository="$(new_fixture_repository clean)"
printf 'synthetic template\n' > "$clean_repository/secrets.example"
git -C "$clean_repository" add secrets.example
git -C "$clean_repository" commit -q -m "test: add allowed template"
REPOSITORY_ROOT="$clean_repository" "$policy_script"

for invalid_limit in invalid -1 1.5 08 09; do
  if output="$(REPOSITORY_ROOT="$clean_repository" \
    MAX_TRACKED_FILE_BYTES="$invalid_limit" "$policy_script" 2>&1)"; then
    printf 'Expected invalid MAX_TRACKED_FILE_BYTES rejection: %s\n' \
      "$invalid_limit" >&2
    exit 1
  else
    status=$?
  fi
  if ((status != 2)); then
    printf 'Invalid MAX_TRACKED_FILE_BYTES returned %s instead of 2: %s\n' \
      "$status" "$invalid_limit" >&2
    exit 1
  fi
  if [[ "$output" != *"must be a non-negative integer"* ]]; then
    printf 'Invalid-limit failure did not contain expected diagnostic:\n%s\n' \
      "$output" >&2
    exit 1
  fi
done

clean_commit="$(git -C "$clean_repository" rev-parse HEAD)"
git -C "$clean_repository" update-index --add --cacheinfo \
  "160000,$clean_commit,vendor/example-submodule"
git -C "$clean_repository" commit -q -m "test: add gitlink"
REPOSITORY_ROOT="$clean_repository" "$policy_script"

if output="$(REPOSITORY_ROOT="$clean_repository" \
  POLICY_REVISION=--help "$policy_script" 2>&1)"; then
  printf 'Expected option-like POLICY_REVISION rejection.\n' >&2
  exit 1
fi
if [[ "$output" != *"must not start with a hyphen"* ]]; then
  printf 'Revision rejection did not contain the expected diagnostic:\n%s\n' \
    "$output" >&2
  exit 1
fi

prohibited_repository="$(new_fixture_repository prohibited)"
mkdir -p "$prohibited_repository/student-data"
printf 'synthetic fixture\n' > "$prohibited_repository/student-data/example.txt"
git -C "$prohibited_repository" add -f student-data/example.txt
git -C "$prohibited_repository" commit -q -m "test: add prohibited path"
expect_failure \
  "prohibited tracked path" \
  "$prohibited_repository" \
  "Tracked path is prohibited"

for prohibited_path in credentials private.txt; do
  exact_repository="$(new_fixture_repository \
    "exact-${prohibited_path//./-}")"
  printf 'synthetic fixture\n' > "$exact_repository/$prohibited_path"
  git -C "$exact_repository" add "$prohibited_path"
  git -C "$exact_repository" commit -q -m "test: add exact prohibited file"
  expect_failure \
    "exact prohibited file $prohibited_path" \
    "$exact_repository" \
    "Tracked path is prohibited"
done

for sqlite_artifact in \
  foundation.sqlite \
  foundation.sqlite-journal \
  foundation.sqlite-wal \
  foundation.sqlite-shm \
  foundation.sqlite3-journal \
  foundation.sqlite3-wal \
  foundation.sqlite3-shm \
  foundation.db-journal \
  foundation.db-wal \
  foundation.db-shm; do
  sqlite_repository="$(new_fixture_repository \
    "sqlite-${sqlite_artifact//./-}")"
  printf 'synthetic SQLite artifact marker\n' > \
    "$sqlite_repository/$sqlite_artifact"
  git -C "$sqlite_repository" add -f "$sqlite_artifact"
  git -C "$sqlite_repository" commit -q -m \
    "test: add synthetic SQLite artifact"
  expect_failure \
    "SQLite artifact $sqlite_artifact" \
    "$sqlite_repository" \
    "Tracked path is prohibited"
done

for runtime_path in \
  runtime-root/data/foundation.sqlite \
  runtime-root/tmp/operation-synthetic/work.txt \
  config/production/application.json; do
  runtime_repository="$(new_fixture_repository \
    "runtime-${runtime_path//\//-}")"
  mkdir -p "$runtime_repository/$(dirname "$runtime_path")"
  printf 'synthetic runtime artifact marker\n' > \
    "$runtime_repository/$runtime_path"
  git -C "$runtime_repository" add -f "$runtime_path"
  git -C "$runtime_repository" commit -q -m \
    "test: add synthetic runtime artifact"
  expect_failure \
    "runtime artifact $runtime_path" \
    "$runtime_repository" \
    "Tracked path is prohibited"
done

oversized_repository="$(new_fixture_repository oversized)"
printf '1234567890\n' > "$oversized_repository/large.txt"
git -C "$oversized_repository" add large.txt
git -C "$oversized_repository" commit -q -m "test: add oversized file"
if output="$(REPOSITORY_ROOT="$oversized_repository" \
  MAX_TRACKED_FILE_BYTES=8 "$policy_script" 2>&1)"; then
  printf 'Expected oversized tracked file failure.\n' >&2
  exit 1
fi
if [[ "$output" != *"Tracked file is"* ]]; then
  printf 'Oversized-file failure did not contain the expected diagnostic:\n%s\n' \
    "$output" >&2
  exit 1
fi

whitespace_repository="$(new_fixture_repository whitespace)"
printf 'trailing whitespace \n' > "$whitespace_repository/trailing.txt"
git -C "$whitespace_repository" add trailing.txt
git -C "$whitespace_repository" commit -q -m "test: add whitespace error"
expect_failure \
  "full-tree whitespace" \
  "$whitespace_repository" \
  "trailing whitespace"

combined_repository="$(new_fixture_repository combined)"
mkdir -p "$combined_repository/student-data"
printf 'combined violation \n' > "$combined_repository/student-data/example.txt"
git -C "$combined_repository" add -f student-data/example.txt
git -C "$combined_repository" commit -q -m "test: add combined violations"
if output="$(REPOSITORY_ROOT="$combined_repository" "$policy_script" 2>&1)"; then
  printf 'Expected combined policy failure.\n' >&2
  exit 1
fi
for expected_text in "trailing whitespace" "Tracked path is prohibited"; do
  if [[ "$output" != *"$expected_text"* ]]; then
    printf 'Combined failure did not contain %s:\n%s\n' \
      "$expected_text" "$output" >&2
    exit 1
  fi
done

history_repository="$(new_fixture_repository history)"
history_base="$(git -C "$history_repository" rev-parse HEAD)"
git -C "$history_repository" switch -q -c feature
mkdir -p "$history_repository/student-data"
printf 'transient prohibited content \n' > \
  "$history_repository/student-data/transient.txt"
git -C "$history_repository" add -f student-data/transient.txt
git -C "$history_repository" commit -q -m "test: add transient prohibited path"
git -C "$history_repository" rm -q student-data/transient.txt
git -C "$history_repository" commit -q -m "test: remove transient prohibited path"
history_head="$(git -C "$history_repository" rev-parse HEAD)"
git -C "$history_repository" switch -q --detach "$history_base"
printf 'base branch advanced\n' > "$history_repository/base-update.txt"
git -C "$history_repository" add base-update.txt
git -C "$history_repository" commit -q -m "test: advance base independently"
divergent_base="$(git -C "$history_repository" rev-parse HEAD)"
if output="$(REPOSITORY_ROOT="$history_repository" \
  POLICY_BASE_REVISION="$divergent_base" \
  POLICY_REVISION="$history_head" "$policy_script" 2>&1)"; then
  printf 'Expected transient history violation on divergent branch.\n' >&2
  exit 1
fi
if [[ "$output" != *"Tracked path is prohibited"* ]]; then
  printf 'History failure did not contain the expected diagnostic:\n%s\n' \
    "$output" >&2
  exit 1
fi
if [[ "$output" != *"trailing whitespace"* ]]; then
  printf 'History failure did not contain the whitespace diagnostic:\n%s\n' \
    "$output" >&2
  exit 1
fi

REPOSITORY_ROOT="$clean_repository" \
  POLICY_BASE_REVISION=0000000000000000000000000000000000000000 \
  "$policy_script"
REPOSITORY_ROOT="$clean_repository" \
  POLICY_BASE_REVISION=ffffffffffffffffffffffffffffffffffffffff \
  "$policy_script"

printf 'Repository policy negative fixtures passed.\n'
