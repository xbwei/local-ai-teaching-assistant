#!/usr/bin/env bash
set -euo pipefail

repository_root="${REPOSITORY_ROOT:-$(git rev-parse --show-toplevel)}"
temporary_root="$(mktemp -d)"

cleanup() {
  local target="${temporary_root:-}"
  if [[ -z "$target" || "$target" != /* || "$target" =~ ^/+$ ]]; then
    printf 'Refusing unsafe lockfile-fixture cleanup target: %s\n' \
      "${target:-<empty>}" >&2
    return 2
  fi
  rm -rf -- "$target"
}
trap cleanup EXIT

expect_failure() {
  local description="$1"
  local expected_text="$2"
  shift 2
  local output

  if output="$("$@" 2>&1)"; then
    printf 'Expected lockfile drift failure: %s\n' "$description" >&2
    exit 1
  fi
  if [[ "$output" != *"$expected_text"* ]]; then
    printf 'Unexpected lockfile drift diagnostic for %s:\n%s\n' \
      "$description" "$output" >&2
    exit 1
  fi
}

root_fixture="$temporary_root/root-npm"
mkdir -p "$root_fixture/apps/api" "$root_fixture/apps/web" \
  "$root_fixture/packages/contracts" "$root_fixture/packages/runtime" \
  "$root_fixture/packages/persistence"
cp "$repository_root/package.json" "$repository_root/package-lock.json" \
  "$root_fixture/"
for manifest in \
  apps/api/package.json \
  apps/web/package.json \
  packages/contracts/package.json \
  packages/runtime/package.json \
  packages/persistence/package.json; do
  cp "$repository_root/$manifest" "$root_fixture/$manifest"
done
node --input-type=module - "$root_fixture/package.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const manifest = JSON.parse(readFileSync(path, "utf8"));
const current = manifest.devDependencies.prettier;
if (!/^\d+\.\d+\.\d+$/.test(current)) {
  throw new Error("Expected an exact Prettier version pin");
}
manifest.devDependencies.prettier = `<${current}`;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure \
  "root npm workspace manifest" \
  "package.json and package-lock.json" \
  npm ci --ignore-scripts --prefix "$root_fixture"

policy_fixture="$temporary_root/policy-npm"
mkdir -p "$policy_fixture"
cp "$repository_root/policy-contracts/package.json" \
  "$repository_root/policy-contracts/package-lock.json" \
  "$policy_fixture/"
node --input-type=module - "$policy_fixture/package.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const manifest = JSON.parse(readFileSync(path, "utf8"));
const current = manifest.devDependencies.ajv;
if (!/^\d+\.\d+\.\d+$/.test(current)) {
  throw new Error("Expected an exact Ajv version pin");
}
manifest.devDependencies.ajv = `<${current}`;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
expect_failure \
  "policy-contracts npm manifest" \
  "package.json and package-lock.json" \
  npm ci --ignore-scripts --prefix "$policy_fixture"

python_fixture="$temporary_root/python"
mkdir -p "$python_fixture"
cp "$repository_root/python/pyproject.toml" "$repository_root/python/uv.lock" \
  "$repository_root/python/.python-version" "$python_fixture/"
node --input-type=module - "$python_fixture/pyproject.toml" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const path = process.argv[2];
const source = readFileSync(path, "utf8");
const pattern = /^dev = \["ruff==(\d+\.\d+\.\d+)"\]$/m;
const match = source.match(pattern);
if (!match || source.match(new RegExp(pattern.source, "gm"))?.length !== 1) {
  throw new Error("Expected one exact Ruff version pin");
}
writeFileSync(path, source.replace(pattern, `dev = ["ruff!=${match[1]}"]`));
NODE
expect_failure \
  "Python uv manifest" \
  "needs to be updated" \
  uv sync --project "$python_fixture" --locked

printf 'Manifest and lockfile drift negative fixtures passed.\n'
