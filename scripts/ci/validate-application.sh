#!/usr/bin/env bash
set -euo pipefail

repository_root="${REPOSITORY_ROOT:-$(git rev-parse --show-toplevel)}"
mode="${1:-full}"
cd "$repository_root"

run_step() {
  local description="$1"
  shift
  printf '\n==> %s\n' "$description"
  "$@"
}

require_version() {
  local name="$1"
  local actual="$2"
  local expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf '%s version mismatch: expected %s, found %s.\n' \
      "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

check_node_toolchain() {
  local expected_node="${EXPECTED_NODE_VERSION:-$(tr -d '[:space:]' < .node-version)}"
  local expected_npm="${EXPECTED_NPM_VERSION:-$(node -p \
    'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).packageManager.split("@").at(-1)')}"
  require_version Node "$(node -p 'process.versions.node')" "$expected_node"
  require_version npm "$(npm --version)" "$expected_npm"
}

check_uv_toolchain() {
  local expected_uv
  local actual_uv
  expected_uv="$(tr -d '\r' < python/pyproject.toml | \
    sed -n 's/^requires = \["uv_build==\([0-9.]*\)"\]$/\1/p')"
  actual_uv="$(uv --version | awk '{print $2}')"
  if [[ -z "$expected_uv" ]]; then
    printf 'Unable to derive the pinned uv version from python/pyproject.toml.\n' >&2
    exit 1
  fi
  require_version uv "$actual_uv" "$expected_uv"
}

check_deployment_runtime_toolchain() {
  node scripts/ci/check-runtime-engines.mjs "$(npm --version)"
}

run_application_gate() {
  check_node_toolchain
  check_uv_toolchain
  run_step "Install locked root Node dependencies" npm ci --ignore-scripts
  run_step "Synchronize locked Python dependencies" \
    uv sync --project python --locked
  run_step "Verify pinned Python runtime" \
    uv run --project python --locked python -c \
      'import pathlib, platform; expected = pathlib.Path("python/.python-version").read_text().strip(); actual = platform.python_version(); assert actual == expected, f"Python version mismatch: expected {expected}, found {actual}"'
  run_step "Build Node workspaces" npm run build
  run_step "Type-check Node workspaces" npm run typecheck
  run_step "Lint workspace boundaries" npm run lint
  run_step "Verify Node formatting" npm run format
  run_step "Run full Node and workspace-boundary tests" npm test
  run_step "Run process/workspace smoke tests" npm run test:smoke
  run_step "Run Python tests" npm run python:test
  run_step "Lint Python" npm run python:lint
  run_step "Verify Python formatting" npm run python:format
  run_step "Validate uv lock" uv lock --project python --check
  run_step "Audit root npm dependencies" npm audit --audit-level=high
  run_step "Audit Python dependencies" uv audit --project python --locked
  run_step "Test manifest/lockfile drift detection" \
    bash scripts/ci/test-lockfile-integrity.sh
  run_step "Test checkout runtime-artifact detection" \
    bash scripts/ci/test-runtime-cleanliness.sh
  run_step "Verify checkout runtime cleanliness" \
    bash scripts/ci/check-runtime-cleanliness.sh
  run_step "Check working-tree whitespace" git diff --check
}

run_policy_gate() {
  check_uv_toolchain
  run_step "Install locked policy-contract dependencies" \
    npm ci --prefix policy-contracts
  run_step "Audit policy-contract dependencies" \
    npm audit --prefix policy-contracts --audit-level=high
  run_step "Validate policy contracts" \
    npm run --prefix policy-contracts check
  run_step "Type-check policy contracts" \
    npm run --prefix policy-contracts typecheck
  run_step "Test policy contracts" npm test --prefix policy-contracts
  run_step "Check architecture contracts" \
    uv run --project python --locked python -B \
      scripts/ci/check-architecture-contracts.py
  run_step "Test architecture contract failures" \
    uv run --project python --locked python -B \
      scripts/ci/test-architecture-contracts.py
  run_step "Check public source boundary" node scripts/ci/check-public-boundary.mjs
  run_step "Check repository policy" \
    bash scripts/ci/check-repository-policy.sh
  run_step "Test repository policy failures" \
    bash scripts/ci/test-repository-policy.sh
  run_step "Check working-tree whitespace" git diff --check
}

run_node_runtime_gate() {
  run_step "Install locked root Node dependencies" npm ci --ignore-scripts
  run_step "Build Node workspaces" npm run build
  run_step "Type-check Node workspaces" npm run typecheck
  run_step "Test runtime foundation" npm test --workspace @laita/runtime
  run_step "Test SQLite persistence" npm test --workspace @laita/persistence
  run_step "Test API startup and runtime integration" \
    npm test --workspace @laita/api
  run_step "Test reference HTTPS edge and independent browser clients" \
    npm run test:reference-edge
  run_step "Run process/workspace smoke tests" npm run test:smoke
  run_step "Verify checkout runtime cleanliness" \
    bash scripts/ci/check-runtime-cleanliness.sh
  run_step "Check working-tree whitespace" git diff --check
}

run_runtime_compatibility_gate() {
  check_node_toolchain
  run_node_runtime_gate
}

run_deployment_runtime_compatibility_gate() {
  check_deployment_runtime_toolchain
  run_node_runtime_gate
}

case "$mode" in
  full)
    run_application_gate
    run_policy_gate
    ;;
  application)
    run_application_gate
    ;;
  policy)
    run_policy_gate
    ;;
  runtime-compatibility)
    run_runtime_compatibility_gate
    ;;
  deployment-runtime-compatibility)
    run_deployment_runtime_compatibility_gate
    ;;
  *)
    printf 'Usage: %s [full|application|policy|runtime-compatibility|deployment-runtime-compatibility]\n' \
      "$0" >&2
    exit 2
    ;;
esac

printf '\nDeterministic %s validation passed.\n' "$mode"
