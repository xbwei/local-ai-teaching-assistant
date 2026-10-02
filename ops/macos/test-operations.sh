#!/bin/bash
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd -P)
fixture_created=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/laita-ops-test.XXXXXX")
fixture=$(cd "$fixture_created" && pwd -P)
port_holder_pid=
cleanup() {
  if [[ -n "$port_holder_pid" ]]; then
    /bin/kill "$port_holder_pid" >/dev/null 2>&1 || true
    wait "$port_holder_pid" 2>/dev/null || true
  fi
  /bin/rm -rf "$fixture"
}
trap cleanup EXIT

fail() {
  echo "ops test failed: $1" >&2
  exit 1
}

expect_equal() {
  [[ "$1" == "$2" ]] || fail "expected '$2', got '$1'"
}

file_mode() {
  case "$(/usr/bin/uname -s)" in
    Darwin) /usr/bin/stat -f '%Lp' "$1" ;;
    Linux) /usr/bin/stat -c '%a' "$1" ;;
    *) fail "unsupported test platform" ;;
  esac
}

file_identity() {
  case "$(/usr/bin/uname -s)" in
    Darwin) /usr/bin/stat -f '%d:%i:%m' "$1" ;;
    Linux) /usr/bin/stat -c '%d:%i:%Y' "$1" ;;
    *) fail "unsupported test platform" ;;
  esac
}

sqlite_version() {
  node --input-type=module - "$1" <<'JS'
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[2], { readOnly: true });
console.log(database.prepare("PRAGMA user_version").get().user_version);
database.close();
JS
}

mkdir -p "$fixture/bin" "$fixture/deploy/private" "$fixture/deploy/bin" \
  "$fixture/deploy/releases" "$fixture/deploy/backups" "$fixture/runtime"

cat > "$fixture/bin/launchctl" <<'MOCK'
#!/bin/bash
set -euo pipefail
case "$1" in
  print)
    if [[ "${MOCK_ASSERT_NO_SNAPSHOT:-0}" == "1" ]]; then
      [[ -z "$(find "$LAITA_DEPLOY_ROOT/backups" -name sqlite-pre-migration.sqlite -print)" ]] || exit 70
    fi
    [[ "${MOCK_PRINT_UNKNOWN:-0}" != "1" ]] || exit 70
    if [[ -f "$MOCK_LAUNCH_STATE.pending" ]]; then
      remaining=$(<"$MOCK_LAUNCH_STATE.pending")
      if (( remaining == 0 )); then
        rm -f "$MOCK_LAUNCH_STATE" "$MOCK_LAUNCH_STATE.pending"
      else
        printf '%s\n' "$((remaining - 1))" > "$MOCK_LAUNCH_STATE.pending"
      fi
    fi
    if [[ ! -f "$MOCK_LAUNCH_STATE" ]]; then
      printf 'Bad request.\nCould not find service "%s" in domain for user gui: %s\n' "${2##*/}" "$(id -u)" >&2
      exit 113
    fi
    echo '    state = running'
    echo '    pid = 12345'
    echo '    last exit code = 0'
    ;;
  bootstrap|kickstart) touch "$MOCK_LAUNCH_STATE"; echo "$1" >> "$MOCK_LAUNCH_STATE.starts" ;;
  bootout)
    printf 'bootout\n' >> "$MOCK_LAUNCH_STATE.calls"
    [[ "${MOCK_BOOTOUT_FAILURE:-0}" != "1" ]] || exit 70
    if [[ -n "${MOCK_UNLOAD_OBSERVATIONS:-}" ]]; then
      printf '%s\n' "$MOCK_UNLOAD_OBSERVATIONS" > "$MOCK_LAUNCH_STATE.pending"
    else
      rm -f "$MOCK_LAUNCH_STATE"
    fi
    ;;
  *) exit 64 ;;
esac
MOCK
cat > "$fixture/bin/curl" <<'MOCK'
#!/bin/bash
case "${!#}" in
  */health) echo '{"contractVersion":"health.v1","status":"ok"}' ;;
  */ready) echo '{"contractVersion":"readiness.v1","status":"ready"}' ;;
  *) exit 22 ;;
esac
MOCK
cat > "$fixture/bin/plutil" <<'MOCK'
#!/bin/bash
set -euo pipefail
[[ "$1" == "-lint" && -s "$2" ]]
grep -q '<plist version="1.0">' "$2"
grep -q '</plist>' "$2"
MOCK
cat > "$fixture/bin/node-ok" <<'MOCK'
#!/bin/bash
if [[ "${1##*/}" == "quiesce-service.mjs" ]]; then
  exec "$MOCK_REAL_NODE" "$@"
fi
printf 'LOCAL_ONLY'
exit 0
MOCK
chmod 700 "$fixture/bin/launchctl" "$fixture/bin/curl" "$fixture/bin/plutil" "$fixture/bin/node-ok"

export LAITA_OPERATIONS_TESTING=1
export LAITA_TEST_LAUNCHCTL="$fixture/bin/launchctl"
export LAITA_TEST_PLUTIL="$fixture/bin/plutil"
export LAITA_TEST_CURL="$fixture/bin/curl"
export MOCK_LAUNCH_STATE="$fixture/launch-state"
export LAITA_DEPLOY_ROOT="$fixture/deploy"
export LAITA_SERVICE_PLIST="$fixture/service.plist"
export LAITA_SERVICE_PORT=43100
export LAITA_SERVICE_LABEL=org.example.synthetic-test
printf '%s\n' deployment-root.v1 > "$LAITA_DEPLOY_ROOT/.laita-deployment-root"
chmod 400 "$LAITA_DEPLOY_ROOT/.laita-deployment-root"

LAITA_NODE_BIN="$(command -v node)"
export LAITA_NODE_BIN
export MOCK_REAL_NODE="$LAITA_NODE_BIN"

candidate="$fixture/candidate"
mkdir "$candidate"
git -C "$candidate" init -q
git -C "$candidate" config user.name synthetic-test
git -C "$candidate" config user.email synthetic@example.invalid
printf 'synthetic\n' > "$candidate/README"
printf 'node_modules/\n' > "$candidate/.gitignore"
mkdir -p "$candidate/synthetic-runtime/dist" "$candidate/synthetic-persistence/dist"
cat > "$candidate/package.json" <<'JSON'
{
  "name": "synthetic-operations-candidate",
  "private": true,
  "type": "module",
  "scripts": {
    "validate": "node validate.mjs",
    "build": "node -e \"process.exit(0)\""
  },
  "dependencies": {
    "@laita/persistence": "file:synthetic-persistence",
    "@laita/runtime": "file:synthetic-runtime"
  }
}
JSON
cat > "$candidate/validate.mjs" <<'JS'
import { accessSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

if (process.argv[2] !== "deployment-runtime-compatibility") {
  throw new Error("deployment did not select the runtime compatibility gate");
}

if (process.env.EXPECT_RUNNING_SERVICE_DURING_VALIDATE === "1") {
  accessSync(process.env.MOCK_LAUNCH_STATE);
  const port = Number(process.env.LAITA_SERVICE_PORT);
  const result = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => resolve(error.code));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => reject(new Error("production port was not occupied")));
    });
  });
  if (result !== "EADDRINUSE") throw new Error("unexpected port probe result");
  writeFileSync(process.env.VALIDATION_SENTINEL, "validated-while-running\n");
}
JS
cat > "$candidate/synthetic-runtime/package.json" <<'JSON'
{
  "name": "@laita/runtime",
  "version": "0.0.0",
  "type": "module",
  "exports": "./dist/index.js"
}
JSON
cat > "$candidate/synthetic-runtime/dist/index.js" <<'JS'
export function parseConfiguration(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
JS
cat > "$candidate/synthetic-persistence/package.json" <<'JSON'
{
  "name": "@laita/persistence",
  "version": "0.0.0",
  "type": "module",
  "exports": "./dist/index.js"
}
JSON
cat > "$candidate/synthetic-persistence/dist/index.js" <<'JS'
import { DatabaseSync } from "node:sqlite";

export function initializePersistence(paths) {
  try {
    const database = new DatabaseSync(paths.prepareDatabaseFile());
    const version = database.prepare("PRAGMA user_version").get().user_version;
    if (version !== 1) {
      database.close();
      return { ok: false, code: "SERVICE_UNAVAILABLE" };
    }
    return {
      ok: true,
      value: {
        close() {
          database.close();
          return { ok: true, value: undefined };
        },
      },
    };
  } catch {
    return { ok: false, code: "SERVICE_UNAVAILABLE" };
  }
}
JS
npm install --package-lock-only --ignore-scripts --prefix "$candidate" >/dev/null
git -C "$candidate" add README .gitignore package.json package-lock.json synthetic-persistence synthetic-runtime validate.mjs
git -C "$candidate" commit -qm synthetic
candidate_commit=$(git -C "$candidate" rev-parse HEAD)
git -C "$candidate" update-ref refs/remotes/origin/main "$candidate_commit"
cat > "$fixture/private-config.json" <<JSON
{
  "contractVersion": "application-configuration.v2",
  "provenance": {
    "demoProfileVersion": "demo-profile.v2",
    "policyVersion": "demo-policy.v2"
  },
  "mode": "operator",
  "server": { "bind": "loopback", "port": 43100 },
  "runtime": { "maxConcurrentOperations": 1, "operationTimeoutMs": 30000 },
  "runtimeRoot": "$fixture/runtime",
  "access": { "mode": "single-operator" },
  "features": {
    "local": true,
    "openai": false,
    "compare": false,
    "speech": false
  },
  "providers": {
    "local": {
      "provider": "LOCAL",
      "model": "gemma4:12b-mlx",
      "candidates": ["gemma4:12b-mlx", "llama3.1:8b"]
    },
    "openai": {
      "provider": "OPENAI",
      "model": "gpt-5.6-luna",
      "secretReference": null
    }
  }
}
JSON
chmod 600 "$fixture/private-config.json"
export LAITA_CHECKOUT="$candidate"
export LAITA_EXPECTED_COMMIT="$candidate_commit"
export LAITA_RUNTIME_ROOT="$fixture/runtime"
export LAITA_CONFIG_FILE="$fixture/private-config.json"
mkdir "$fixture/aliases"
ln -s "$fixture" "$fixture/aliases/root"
overlap_error=$(LAITA_RUNTIME_ROOT="$fixture/aliases/root/deploy/private-runtime" \
  "$root/ops/macos/service.sh" install 2>&1 || true)
expect_equal "$overlap_error" "SERVICE_ERROR=OVERLAPPING_ROOTS"
branch_error=$("$root/ops/macos/service.sh" install 2>&1 || true)
expect_equal "$branch_error" "SERVICE_ERROR=BRANCH_DEPLOYMENT_PROHIBITED"
git -C "$candidate" checkout -q --detach "$candidate_commit"
printf 'dirty\n' > "$candidate/untracked"
dirty_error=$("$root/ops/macos/service.sh" install 2>&1 || true)
expect_equal "$dirty_error" "SERVICE_ERROR=DIRTY_CHECKOUT"
rm "$candidate/untracked"
npm ci --ignore-scripts --prefix "$candidate" >/dev/null

export LAITA_OPENAI_KEYCHAIN_MAPPING_FILE="$fixture/initial-keychain-mapping.json"
LAITA_OPENAI_KEYCHAIN_SERVICE=synthetic-keychain-service \
  LAITA_OPENAI_KEYCHAIN_ACCOUNT=synthetic-keychain-account \
  node "$root/ops/macos/prepare-provider-config.mjs" mapping \
  "$LAITA_OPENAI_KEYCHAIN_MAPPING_FILE" >/dev/null
local_only_candidate_error=$("$root/ops/macos/service.sh" install 2>&1 || true)
[[ "$local_only_candidate_error" == *"SERVICE_ERROR=INVALID_PRODUCTION_CONFIGURATION"* ]] ||
  fail "Local-only candidate configuration was accepted"
[[ ! -e "$LAITA_DEPLOY_ROOT/current" ]] || fail "Local-only candidate changed deployment"

providerConfig_config="$fixture/private-config-providerConfig.json"
LAITA_OPENAI_SECRET_REFERENCE_ID=synthetic-keychain-reference \
  node "$root/ops/macos/prepare-provider-config.mjs" config "$candidate" \
  "$fixture/private-config.json" "$providerConfig_config" "$fixture/runtime" 43100 >/dev/null
unset LAITA_OPENAI_KEYCHAIN_MAPPING_FILE
missing_keychain_error=$(LAITA_CONFIG_FILE="$providerConfig_config" \
  "$root/ops/macos/service.sh" install 2>&1 || true)
[[ "$missing_keychain_error" == *"SERVICE_ERROR=INVALID_KEYCHAIN_MAPPING_FILE"* ]] ||
  fail "missing Keychain reference was accepted"
[[ ! -e "$LAITA_DEPLOY_ROOT/current" ]] || fail "invalid Keychain reference changed deployment"
invalid_mapping="$fixture/invalid-keychain-mapping.json"
printf '%s\n' '{"contractVersion":"openai-keychain-mapping.v1","service":"sk-proj-DISTINCTIVE_PRIVATE_SECRET_123456789","account":"distinctive-private-account"}' > "$invalid_mapping"
chmod 600 "$invalid_mapping"
invalid_mapping_error=$(LAITA_CONFIG_FILE="$providerConfig_config" \
  LAITA_OPENAI_KEYCHAIN_MAPPING_FILE="$invalid_mapping" \
  "$root/ops/macos/service.sh" install 2>&1 || true)
expect_equal "$invalid_mapping_error" "SERVICE_ERROR=INVALID_KEYCHAIN_MAPPING"
[[ "$invalid_mapping_error" != *"DISTINCTIVE_PRIVATE"* &&
  "$invalid_mapping_error" != *"$invalid_mapping"* ]] ||
  fail "invalid Keychain mapping leaked private input"
[[ ! -e "$LAITA_DEPLOY_ROOT/current" ]] || fail "invalid Keychain mapping changed deployment"

update_fixture="$fixture/update"
update_deploy="$update_fixture/deploy"
update_runtime="$update_fixture/runtime"
update_plist="$update_fixture/service.plist"
update_config_initial="$update_fixture/private-config-initial.json"
update_config_next="$update_fixture/private-config-next.json"
mkdir -p "$update_runtime"
mkdir -p "$update_runtime/data"
chmod 700 "$update_fixture" "$update_runtime"
sed "s|$fixture/runtime|$update_runtime|" "$fixture/private-config.json" > "$update_config_initial"
chmod 600 "$update_config_initial"
LAITA_OPENAI_SECRET_REFERENCE_ID=synthetic-keychain-reference \
  node "$root/ops/macos/prepare-provider-config.mjs" config "$candidate" \
  "$update_config_initial" "$update_config_next" "$update_runtime" 43100 >/dev/null
node --input-type=module - "$update_runtime/data/foundation.sqlite" <<'JS'
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const sql = "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL) STRICT";
const database = new DatabaseSync(process.argv[2]);
database.exec(`${sql}; PRAGMA user_version = 1`);
database.prepare("INSERT INTO schema_migrations VALUES (1, ?)").run(
  createHash("sha256").update(sql).digest("hex"),
);
database.close();
JS
chmod 600 "$update_runtime/data/foundation.sqlite"

export LAITA_DEPLOY_ROOT="$update_deploy"
export LAITA_RUNTIME_ROOT="$update_runtime"
export LAITA_SERVICE_PLIST="$update_plist"
export LAITA_CONFIG_FILE="$update_config_next"
export LAITA_OPENAI_KEYCHAIN_MAPPING_FILE="$update_fixture/keychain-mapping.json"
LAITA_OPENAI_KEYCHAIN_SERVICE=synthetic-keychain-service \
  LAITA_OPENAI_KEYCHAIN_ACCOUNT=synthetic-keychain-account \
  node "$root/ops/macos/prepare-provider-config.mjs" mapping \
  "$LAITA_OPENAI_KEYCHAIN_MAPPING_FILE" >/dev/null
first_install=$("$root/ops/macos/service.sh" install)
[[ "$first_install" == *"DEPLOYED_COMMIT=$candidate_commit"* &&
  "$first_install" == *"SERVICE_STATE=DISABLED"* ]] || fail "first install result"
# Recreate the explicit Local-only protected state of a legacy deployment.
cp "$update_config_initial" "$update_deploy/private/application-config.json"
chmod 600 "$update_deploy/private/application-config.json"
LAITA_SERVICE_LABEL="org.example.test" LAITA_DEPLOY_ROOT="$update_deploy" \
  LAITA_NODE_BIN="$LAITA_NODE_BIN" \
  LAITA_NODE_PATH="$(dirname "$LAITA_NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin" \
  LAITA_OPENAI_KEYCHAIN_ENABLED=0 LAITA_OPENAI_KEYCHAIN_MAPPING_FILE= \
  node "$root/ops/macos/render-plist.mjs" \
    "$root/ops/macos/org.example.laita-api.plist.template" "$update_plist"
chmod 600 "$update_plist"
# A reviewed pre-upgrade plist is Background; update must replace it with
# Standard and preserve the original plist in rollback evidence.
grep -q '<string>Standard</string>' "$update_plist" || fail "prepared scheduling"
sed 's/<string>Standard<\/string>/<string>Background<\/string>/' \
  "$update_plist" > "$update_fixture/background.plist"
cp "$update_fixture/background.plist" "$update_plist"
initial_service_plist="$update_fixture/initial-service.plist"
cp "$update_plist" "$initial_service_plist"
marker="$update_deploy/.laita-deployment-root"
[[ -f "$marker" && ! -L "$marker" ]] || fail "first install marker identity"
expect_equal "$(<"$marker")" "deployment-root.v1"
expect_equal "$(file_mode "$marker")" "400"
/usr/bin/touch -t 200001010000 "$marker"
marker_identity=$(file_identity "$marker")

cat > "$update_fixture/port-holder.mjs" <<'JS'
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";

const server = createServer((socket) => socket.destroy());
server.listen(
  { host: "127.0.0.1", port: Number(process.env.TEST_PORT), exclusive: true },
  () => writeFileSync(process.env.READY_FILE, "ready\n"),
);
process.once("SIGTERM", () => server.close(() => process.exit(0)));
JS
validation_sentinel="$update_fixture/validation-complete"
listener_ready="$update_fixture/listener-ready"
TEST_PORT="$LAITA_SERVICE_PORT" READY_FILE="$listener_ready" \
  node "$update_fixture/port-holder.mjs" &
port_holder_pid=$!
for _attempt in 1 2 3 4 5; do
  [[ -f "$listener_ready" ]] && break
  /bin/sleep 1
done
[[ -f "$listener_ready" ]] || fail "production-port listener did not start"
"$root/ops/macos/service.sh" start
[[ -f "$MOCK_LAUNCH_STATE" ]] || fail "old service was not running before update"

export LAITA_CONFIG_FILE="$update_config_next"
export EXPECT_RUNNING_SERVICE_DURING_VALIDATE=1
export VALIDATION_SENTINEL="$validation_sentinel"
# Failures must stop before snapshot, config/release activation or runner replacement.
cp "$update_deploy/private/application-config.json" "$update_fixture/config-before"
chmod 700 "$update_deploy/bin/run-service.sh"
printf 'synthetic-old-runner\n' > "$update_deploy/bin/run-service.sh"
cp "$update_deploy/bin/run-service.sh" "$update_fixture/runner-before"
current_identity=$(file_identity "$update_deploy/current")
for failure in stuck bootout unknown; do
  rm -f "$MOCK_LAUNCH_STATE.pending" "$MOCK_LAUNCH_STATE.calls"
  rm -f "$MOCK_LAUNCH_STATE.starts"
  export MOCK_ASSERT_NO_SNAPSHOT=1
  case "$failure" in
    stuck) export MOCK_UNLOAD_OBSERVATIONS=100 ;;
    bootout) export MOCK_BOOTOUT_FAILURE=1 ;;
    unknown) export MOCK_PRINT_UNKNOWN=1 ;;
  esac
  if "$root/ops/macos/service.sh" update > "$update_fixture/failed-output" 2>&1; then
    fail "quiescence failure accepted: $failure"
  fi
  grep -q '^SERVICE_ERROR=SERVICE_NOT_QUIESCENT$' "$update_fixture/failed-output" || fail "wrong quiescence error"
  [[ -f "$MOCK_LAUNCH_STATE" ]] || fail "failure stopped service unexpectedly"
  [[ ! -e "$MOCK_LAUNCH_STATE.starts" ]] || fail "failure started service"
  [[ -z "$(find "$update_deploy/backups" -name sqlite-pre-migration.sqlite -print)" ]] || fail "snapshot before quiescence"
  cmp "$update_fixture/config-before" "$update_deploy/private/application-config.json" || fail "config changed before quiescence"
  cmp "$update_fixture/runner-before" "$update_deploy/bin/run-service.sh" || fail "runner changed before quiescence"
  cmp "$initial_service_plist" "$update_plist" || fail "plist changed before quiescence"
  expect_equal "$(file_identity "$update_deploy/current")" "$current_identity"
  if [[ "$failure" == unknown ]]; then
    [[ ! -e "$MOCK_LAUNCH_STATE.calls" ]] || fail "bootout on unknown state"
  else
    expect_equal "$(wc -l < "$MOCK_LAUNCH_STATE.calls" | tr -d ' ')" "1"
  fi
  # Only synthetic incomplete backup fixtures; keep the successful case isolated.
  find "$update_deploy/backups" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +
  unset MOCK_UNLOAD_OBSERVATIONS MOCK_BOOTOUT_FAILURE MOCK_PRINT_UNKNOWN MOCK_ASSERT_NO_SNAPSHOT
done
rm -f "$MOCK_LAUNCH_STATE.pending" "$MOCK_LAUNCH_STATE.calls"
second_update=$(MOCK_ASSERT_NO_SNAPSHOT=1 MOCK_UNLOAD_OBSERVATIONS=3 "$root/ops/macos/service.sh" update)
expect_equal "$(wc -l < "$MOCK_LAUNCH_STATE.calls" | tr -d ' ')" "1"

unset EXPECT_RUNNING_SERVICE_DURING_VALIDATE VALIDATION_SENTINEL
[[ "$second_update" == *"DEPLOYED_COMMIT=$candidate_commit"* &&
  "$second_update" == *"SERVICE_STATE=DISABLED"* ]] || fail "second update result"
grep -q '<string>Standard</string>' "$update_plist" || fail "updated scheduling"
[[ -f "$validation_sentinel" ]] || fail "candidate validation did not observe running old service"
[[ ! -f "$MOCK_LAUNCH_STATE" ]] || fail "old service was not disabled after validation"
/bin/kill "$port_holder_pid"
wait "$port_holder_pid"
port_holder_pid=
expect_equal "$(<"$marker")" "deployment-root.v1"
expect_equal "$(file_mode "$marker")" "400"
expect_equal "$(file_identity "$marker")" "$marker_identity"
expect_equal "$(readlink "$update_deploy/current")" \
  "$update_deploy/releases/$candidate_commit"
cmp "$update_config_next" "$update_deploy/private/application-config.json" >/dev/null ||
  fail "updated configuration not selected"
grep -q 'LAITA_OPENAI_KEYCHAIN_SERVICE' "$update_plist" ||
  fail "Cloud-enabled Keychain service reference not rendered"
grep -q 'LAITA_OPENAI_KEYCHAIN_ACCOUNT' "$update_plist" ||
  fail "Cloud-enabled Keychain account reference not rendered"
cmp "$root/ops/macos/run-service.sh" "$update_deploy/bin/run-service.sh" >/dev/null ||
  fail "runner not installed after update"
expect_equal "$(file_mode "$update_deploy/bin/run-service.sh")" "500"
update_backup=$(find "$update_deploy/backups" -mindepth 1 -maxdepth 1 -type d -print)
expect_equal "$(printf '%s\n' "$update_backup" | sed '/^$/d' | wc -l | tr -d ' ')" "1"
expect_equal "$(<"$update_backup/previous-commit")" "$candidate_commit"
cmp "$update_config_initial" "$update_backup/application-config.json" >/dev/null ||
  fail "previous configuration not backed up"
cmp "$initial_service_plist" "$update_backup/service.plist" >/dev/null ||
  fail "previous plist not backed up"
expect_equal "$(sqlite_version "$update_runtime/data/foundation.sqlite")" "1"
[[ -f "$update_backup/sqlite-pre-migration.sqlite" &&
  -f "$update_backup/sqlite-pre-migration.json" ]] ||
  fail "pre-migration SQLite snapshot missing"
expect_equal "$(sqlite_version "$update_backup/sqlite-pre-migration.sqlite")" "1"
expect_equal "$(file_mode "$update_backup/sqlite-pre-migration.sqlite")" "600"
expect_equal "$(file_mode "$update_backup/sqlite-pre-migration.json")" "600"

# Same-schema rollback has a real target initializer and post-snapshot data.
# Keep a private synthetic v1 fixture so the cross-schema scenario stays independent.
cp "$update_runtime/data/foundation.sqlite" "$update_fixture/v1-before-same-schema.sqlite"
same_target=3333333333333333333333333333333333333333
same_release="$update_deploy/releases/$same_target"
cp -R "$update_deploy/releases/$candidate_commit" "$same_release"
chmod -R u+w "$same_release"
printf '%s\n' "$same_target" > "$same_release/DEPLOYED_COMMIT"
sed 's/version !== 1/version !== 4/' \
  "$candidate/synthetic-persistence/dist/index.js" > "$same_release/synthetic-persistence/dist/index.js"
same_backup="$update_deploy/backups/same-schema"
mkdir -m 700 "$same_backup"
printf '%s\n' "$same_target" > "$same_backup/previous-commit"
cp "$update_config_initial" "$same_backup/application-config.json"
cp "$initial_service_plist" "$same_backup/service.plist"
chmod 600 "$same_backup"/*
node --input-type=module - "$update_runtime/data/foundation.sqlite" <<'JS'
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./packages/persistence/dist/migrations.js";
const database = new DatabaseSync(process.argv[2]);
migrate(database);
database.close();
JS
node "$root/ops/macos/sqlite-rollback.mjs" snapshot \
  "$update_runtime/data/foundation.sqlite" "$same_backup" >/dev/null
node --input-type=module - "$update_runtime/data/foundation.sqlite" <<'JS'
import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[2]);
database.prepare(
  "INSERT INTO policy_versions (version, policy_json, digest, activated_at) VALUES (1, '{}', 'synthetic-after-snapshot', '2026-09-05T00:00:00.000Z')",
).run();
database.close();
JS

assert_recovery_metadata() {
  node --input-type=module - "$1" <<'JS'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const root = process.argv[2];
const bytes = readFileSync(`${root}/sqlite-failed-upgrade.sqlite`);
const metadata = JSON.parse(readFileSync(`${root}/sqlite-failed-upgrade.json`, "utf8"));
assert.equal(metadata.contractVersion, "sqlite-rollback-artifact.v1");
assert.equal(metadata.kind, "FAILED_UPGRADE");
assert.equal(metadata.schemaVersion, 4);
assert.equal(metadata.sizeBytes, bytes.length);
assert.equal(metadata.databaseSha256, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
JS
}

capture_rollback_state() {
  cp "$update_runtime/data/foundation.sqlite" "$update_fixture/db-before-rollback"
  cp "$update_deploy/private/application-config.json" "$update_fixture/config-before-rollback"
  cp "$update_plist" "$update_fixture/plist-before-rollback"
  rollback_pointer_before=$(readlink "$update_deploy/current")
  rollback_identity_before=$(file_identity "$update_deploy/current")
}
assert_rollback_state_unchanged() {
  cmp "$update_fixture/db-before-rollback" "$update_runtime/data/foundation.sqlite" || fail "rollback failure changed DB"
  cmp "$update_fixture/config-before-rollback" "$update_deploy/private/application-config.json" || fail "rollback failure changed config"
  cmp "$update_fixture/plist-before-rollback" "$update_plist" || fail "rollback failure changed plist"
  expect_equal "$(readlink "$update_deploy/current")" "$rollback_pointer_before"
  expect_equal "$(file_identity "$update_deploy/current")" "$rollback_identity_before"
}
capture_rollback_state

# A compatible current DB must never bypass corrupt or partial snapshot validation.
for corruption in snapshot metadata missing-snapshot missing-metadata; do
  corrupt_backup="$update_deploy/backups/corrupt-$corruption"
  cp -R "$same_backup" "$corrupt_backup"
  case "$corruption" in
    snapshot) printf 'corrupt' > "$corrupt_backup/sqlite-pre-migration.sqlite" ;;
    metadata) printf '{}' > "$corrupt_backup/sqlite-pre-migration.json" ;;
    missing-snapshot) rm "$corrupt_backup/sqlite-pre-migration.sqlite" ;;
    missing-metadata) rm "$corrupt_backup/sqlite-pre-migration.json" ;;
  esac
  if LAITA_ROLLBACK_BACKUP="$corrupt_backup" "$root/ops/macos/service.sh" rollback > "$update_fixture/rollback-error" 2>&1; then
    fail "compatible current DB bypassed corrupt snapshot: $corruption"
  fi
  expect_equal "$(cat "$update_fixture/rollback-error")" "SERVICE_ERROR=INVALID_SQLITE_SNAPSHOT"
  assert_rollback_state_unchanged
  [[ ! -e "$corrupt_backup/sqlite-failed-upgrade.sqlite" ]] || fail "corruption created recovery"
done

# Failure to create/validate a compatibility copy is not schema incompatibility.
if LAITA_ROLLBACK_BACKUP="$same_backup" LAITA_TEST_FAIL_COMPATIBILITY_COPY=1 \
  "$root/ops/macos/service.sh" rollback > "$update_fixture/rollback-error" 2>&1; then
  fail "compatibility copy failure accepted"
fi
expect_equal "$(cat "$update_fixture/rollback-error")" "SERVICE_ERROR=INVALID_SQLITE_ROLLBACK_STATE"
assert_rollback_state_unchanged

same_database_identity=$(file_identity "$update_runtime/data/foundation.sqlite")
same_rollback=$(LAITA_ROLLBACK_BACKUP="$same_backup" "$root/ops/macos/service.sh" rollback)
[[ "$same_rollback" == *"ROLLED_BACK_COMMIT=$same_target"* &&
  "$same_rollback" == *"RUNTIME_DATA_ACTION=PRESERVED_COMPATIBLE_CURRENT"* &&
  "$same_rollback" != *"SQLITE_RESTORED"* ]] || fail "same-schema runtime action"
expect_equal "$(readlink "$update_deploy/current")" "$same_release"
cmp "$update_config_initial" "$update_deploy/private/application-config.json" || fail "same-schema config rollback"
cmp "$initial_service_plist" "$update_plist" || fail "same-schema plist rollback"
cmp "$update_fixture/db-before-rollback" "$update_runtime/data/foundation.sqlite" || fail "same-schema replaced current data"
expect_equal "$(file_identity "$update_runtime/data/foundation.sqlite")" "$same_database_identity"
[[ ! -e "$same_backup/sqlite-failed-upgrade.sqlite" &&
  ! -e "$same_backup/sqlite-failed-upgrade.json" ]] || fail "same-schema created unnecessary recovery"
node --input-type=module - "$update_runtime/data/foundation.sqlite" "$same_backup/sqlite-pre-migration.sqlite" <<'JS'
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
for (const [file, count] of [[process.argv[2], 1], [process.argv[3], 0]]) {
  const database = new DatabaseSync(file, { readOnly: true });
  assert.equal(database.prepare("SELECT count(*) AS n FROM policy_versions WHERE digest = 'synthetic-after-snapshot'").get().n, count);
  database.close();
}
JS

# A legitimate historical backup with no snapshot uses the same compatibility proof.
legacy_compatible="$update_deploy/backups/legacy-compatible"
mkdir -m 700 "$legacy_compatible"
cp "$same_backup/previous-commit" "$same_backup/application-config.json" "$same_backup/service.plist" "$legacy_compatible/"
rm "$update_deploy/current"
ln -s "$update_deploy/releases/$candidate_commit" "$update_deploy/current"
cp "$update_config_next" "$update_deploy/private/application-config.json"
cp "$update_fixture/plist-before-rollback" "$update_plist"
legacy_preserved=$(LAITA_ROLLBACK_BACKUP="$legacy_compatible" "$root/ops/macos/service.sh" rollback)
[[ "$legacy_preserved" == *"RUNTIME_DATA_ACTION=PRESERVED_COMPATIBLE_CURRENT"* ]] || fail "legacy compatible preserve"
expect_equal "$(readlink "$update_deploy/current")" "$same_release"
cmp "$update_config_initial" "$update_deploy/private/application-config.json" || fail "legacy compatible config"
cmp "$initial_service_plist" "$update_plist" || fail "legacy compatible plist"
cmp "$update_fixture/db-before-rollback" "$update_runtime/data/foundation.sqlite" || fail "legacy compatible data loss"
[[ ! -e "$legacy_compatible/sqlite-failed-upgrade.sqlite" ]] || fail "legacy compatible recovery"

# Reset only synthetic test fixtures for the independent cross-schema scenario.
cp "$update_fixture/v1-before-same-schema.sqlite" "$update_runtime/data/foundation.sqlite"
cp "$update_config_next" "$update_deploy/private/application-config.json"
cp "$update_fixture/plist-before-rollback" "$update_plist"
# Keep a different selected release so negative tests detect premature selection.

# Simulate candidate startup migrating v1 to v4 and then failing acceptance.
node --input-type=module - "$update_runtime/data/foundation.sqlite" <<'JS'
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./packages/persistence/dist/migrations.js";
const database = new DatabaseSync(process.argv[2]);
migrate(database);
database.prepare(
  "INSERT INTO policy_versions (version, policy_json, digest, activated_at) VALUES (1, '{}', 'synthetic-failed-upgrade', '2026-09-05T00:00:00.000Z')",
).run();
database.close();
JS
expect_equal "$(sqlite_version "$update_runtime/data/foundation.sqlite")" "4"
export LAITA_ROLLBACK_BACKUP="$update_backup"
capture_rollback_state
incompatible_snapshot="$update_deploy/backups/incompatible-snapshot"
cp -R "$same_backup" "$incompatible_snapshot"
printf '%s\n' "$candidate_commit" > "$incompatible_snapshot/previous-commit"
if LAITA_ROLLBACK_BACKUP="$incompatible_snapshot" "$root/ops/macos/service.sh" rollback > "$update_fixture/rollback-error" 2>&1; then
  fail "incompatible snapshot accepted"
fi
expect_equal "$(cat "$update_fixture/rollback-error")" "SERVICE_ERROR=INCOMPATIBLE_SQLITE_ROLLBACK_RELEASE"
assert_rollback_state_unchanged
[[ ! -e "$incompatible_snapshot/sqlite-failed-upgrade.sqlite" ]] || fail "incompatible snapshot created recovery"
for failure in recovery restore; do
  failed_backup="$update_deploy/backups/failed-$failure"
  cp -R "$update_backup" "$failed_backup"
  if [[ "$failure" == recovery ]]; then
    export LAITA_TEST_FAIL_RECOVERY_BEFORE_RENAME=1
  else
    export LAITA_TEST_FAIL_RESTORE_BEFORE_RENAME=1
  fi
  if LAITA_ROLLBACK_BACKUP="$failed_backup" "$root/ops/macos/service.sh" rollback > "$update_fixture/rollback-error" 2>&1; then
    fail "failed restore accepted: $failure"
  fi
  unset LAITA_TEST_FAIL_RECOVERY_BEFORE_RENAME LAITA_TEST_FAIL_RESTORE_BEFORE_RENAME
  expect_equal "$(cat "$update_fixture/rollback-error")" "SERVICE_ERROR=SQLITE_RESTORE_FAILED"
  assert_rollback_state_unchanged
  if [[ "$failure" == restore ]]; then
    cmp "$update_fixture/db-before-rollback" "$failed_backup/sqlite-failed-upgrade.sqlite" || fail "failed restore recovery data"
    assert_recovery_metadata "$failed_backup"
  else
    [[ ! -e "$failed_backup/sqlite-failed-upgrade.sqlite" ]] || fail "partial recovery published"
  fi
done
"$root/ops/macos/service.sh" start
rollback_across_schema=$(
  MOCK_UNLOAD_OBSERVATIONS=2 "$root/ops/macos/service.sh" rollback
)
[[ "$rollback_across_schema" == *"ROLLED_BACK_COMMIT=$candidate_commit"* &&
  "$rollback_across_schema" == *"SQLITE_RESTORED_SCHEMA_VERSION=1"* &&
  "$rollback_across_schema" == *"SQLITE_RECOVERY_SCHEMA_VERSION=4"* &&
  "$rollback_across_schema" == *"RUNTIME_DATA_ACTION=RESTORED_FROM_SNAPSHOT"* ]] ||
  fail "cross-schema rollback result"
expect_equal "$(sqlite_version "$update_runtime/data/foundation.sqlite")" "1"
expect_equal "$(sqlite_version "$update_backup/sqlite-failed-upgrade.sqlite")" "4"
[[ -f "$update_backup/sqlite-failed-upgrade.json" ]] ||
  fail "failed-upgrade SQLite metadata missing"
assert_recovery_metadata "$update_backup"
cmp "$update_fixture/db-before-rollback" "$update_backup/sqlite-failed-upgrade.sqlite" || fail "cross-schema recovery lost data"
cmp "$update_backup/sqlite-pre-migration.sqlite" "$update_runtime/data/foundation.sqlite" || fail "cross-schema snapshot not restored"
(cd "$update_deploy/current" && ROLLBACK_COMPATIBILITY_DATABASE="$update_runtime/data/foundation.sqlite" \
  node --input-type=module -e '
    import { initializePersistence } from "@laita/persistence";
    const result = initializePersistence({ prepareDatabaseFile: () => process.env.ROLLBACK_COMPATIBILITY_DATABASE });
    if (!result.ok || !result.value.close().ok) process.exit(1);
  ') || fail "old target cannot initialize restored database"
"$root/ops/macos/service.sh" start
[[ -f "$MOCK_LAUNCH_STATE" ]] || fail "v1 rollback release did not start"
"$root/ops/macos/service.sh" stop

legacy_incompatible="$update_deploy/backups/legacy-without-snapshot"
mkdir "$legacy_incompatible"
chmod 700 "$legacy_incompatible"
printf '%s\n' "$candidate_commit" > "$legacy_incompatible/previous-commit"
cp "$update_config_initial" "$legacy_incompatible/application-config.json"
cp "$initial_service_plist" "$legacy_incompatible/service.plist"
chmod 600 "$legacy_incompatible"/*
node --input-type=module - "$update_runtime/data/foundation.sqlite" <<'JS'
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./packages/persistence/dist/migrations.js";
const database = new DatabaseSync(process.argv[2]);
migrate(database);
database.close();
JS
rm "$update_deploy/current"
ln -s "$same_release" "$update_deploy/current"
cp "$update_config_next" "$update_deploy/private/application-config.json"
cp "$update_fixture/plist-before-rollback" "$update_plist"
capture_rollback_state
legacy_incompatible_error=$(LAITA_ROLLBACK_BACKUP="$legacy_incompatible" \
  "$root/ops/macos/service.sh" rollback 2>&1 || true)
expect_equal "$legacy_incompatible_error" \
  "SERVICE_ERROR=INCOMPATIBLE_SQLITE_ROLLBACK_RELEASE"
expect_equal "$(sqlite_version "$update_runtime/data/foundation.sqlite")" "4"
assert_rollback_state_unchanged

chmod 600 "$marker"
printf 'wrong-marker\n' > "$marker"
chmod 400 "$marker"
wrong_marker_error=$("$root/ops/macos/service.sh" update 2>&1 || true)
expect_equal "$wrong_marker_error" "SERVICE_ERROR=UNMANAGED_DEPLOY_ROOT"
expect_equal "$(<"$marker")" "wrong-marker"

chmod 600 "$marker"
printf 'deployment-root.v1\n' > "$marker"
chmod 400 "$marker"
/bin/rm -f "$marker"
printf 'deployment-root.v1\n' > "$update_fixture/outside-marker"
ln -s "$update_fixture/outside-marker" "$marker"
symlink_marker_error=$("$root/ops/macos/service.sh" update 2>&1 || true)
expect_equal "$symlink_marker_error" "SERVICE_ERROR=SYMLINKED_DEPLOYMENT_MARKER"
[[ -L "$marker" ]] || fail "symlink marker was silently repaired"

/bin/rm -f "$marker"
printf 'deployment-root.v1\n' > "$marker"
chmod 600 "$marker"
marker_mode_error=$("$root/ops/macos/service.sh" update 2>&1 || true)
expect_equal "$marker_mode_error" "SERVICE_ERROR=INVALID_DEPLOYMENT_MARKER_PERMISSIONS"
expect_equal "$(file_mode "$marker")" "600"

chmod 000 "$marker"
unreadable_marker_error=$("$root/ops/macos/service.sh" update 2>&1 || true)
expect_equal "$unreadable_marker_error" "SERVICE_ERROR=UNMANAGED_DEPLOY_ROOT"
expect_equal "$(file_mode "$marker")" "0"

/bin/rm -f "$marker"
missing_marker_error=$("$root/ops/macos/service.sh" update 2>&1 || true)
expect_equal "$missing_marker_error" "SERVICE_ERROR=UNMANAGED_DEPLOY_ROOT"
[[ ! -e "$marker" ]] || fail "missing marker was silently recreated"

export LAITA_DEPLOY_ROOT="$fixture/deploy"
export LAITA_RUNTIME_ROOT="$fixture/runtime"
export LAITA_SERVICE_PLIST="$fixture/service.plist"
export LAITA_CONFIG_FILE="$fixture/private-config.json"

LAITA_SERVICE_LABEL="$LAITA_SERVICE_LABEL" LAITA_DEPLOY_ROOT="$LAITA_DEPLOY_ROOT" \
  LAITA_NODE_PATH="$(dirname "$LAITA_NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin" \
  LAITA_OPENAI_KEYCHAIN_MAPPING_FILE= \
  node "$root/ops/macos/render-plist.mjs" \
    "$root/ops/macos/org.example.laita-api.plist.template" "$LAITA_SERVICE_PLIST"
if [[ -x /usr/bin/plutil ]]; then /usr/bin/plutil -lint "$LAITA_SERVICE_PLIST" >/dev/null; fi
grep -q '<integer>60</integer>' "$LAITA_SERVICE_PLIST" || fail "missing throttle"
grep -q '<key>SuccessfulExit</key>' "$LAITA_SERVICE_PLIST" || fail "missing failed-exit keepalive"
grep -A1 '<key>SuccessfulExit</key>' "$LAITA_SERVICE_PLIST" | grep -q '<false/>' || fail "successful exit restarts"
expect_equal "$(grep -c '<string>/dev/null</string>' "$LAITA_SERVICE_PLIST")" "2"
! grep -Eq '__[A-Z_]+__' "$LAITA_SERVICE_PLIST" || fail "unresolved plist marker"
! grep -q 'LAITA_OPENAI_KEYCHAIN_' "$LAITA_SERVICE_PLIST" ||
  fail "Local-only plist retained Keychain identifiers"

providerConfig_plist="$fixture/providerConfig-service.plist"
plist_mapping="$fixture/plist-keychain-mapping.json"
LAITA_OPENAI_KEYCHAIN_SERVICE='synthetic-service-&-escaped' \
  LAITA_OPENAI_KEYCHAIN_ACCOUNT='synthetic-account-escaped' \
  node "$root/ops/macos/prepare-provider-config.mjs" mapping "$plist_mapping" >/dev/null
LAITA_SERVICE_LABEL="$LAITA_SERVICE_LABEL" LAITA_DEPLOY_ROOT="$LAITA_DEPLOY_ROOT" \
  LAITA_NODE_BIN="$LAITA_NODE_BIN" \
  LAITA_NODE_PATH="$(dirname "$LAITA_NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin" \
  LAITA_OPENAI_KEYCHAIN_ENABLED=1 \
  LAITA_OPENAI_KEYCHAIN_MAPPING_FILE="$plist_mapping" \
  node "$root/ops/macos/render-plist.mjs" \
    "$root/ops/macos/org.example.laita-api.plist.template" "$providerConfig_plist"
expect_equal "$(file_mode "$providerConfig_plist")" "600"
expect_equal "$(grep -c 'LAITA_OPENAI_KEYCHAIN_' "$providerConfig_plist")" "2"
grep -q 'synthetic-service-&amp;-escaped' "$providerConfig_plist" || fail "Keychain service XML escaping"
invalid_keychain_plist=$(LAITA_SERVICE_LABEL="$LAITA_SERVICE_LABEL" \
  LAITA_DEPLOY_ROOT="$LAITA_DEPLOY_ROOT" LAITA_NODE_BIN="$LAITA_NODE_BIN" \
  LAITA_NODE_PATH="$(dirname "$LAITA_NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin" \
  LAITA_OPENAI_KEYCHAIN_ENABLED=1 LAITA_OPENAI_KEYCHAIN_MAPPING_FILE= \
  node "$root/ops/macos/render-plist.mjs" \
    "$root/ops/macos/org.example.laita-api.plist.template" \
    "$fixture/invalid-keychain.plist" 2>&1 || true)
expect_equal "$invalid_keychain_plist" ""
[[ ! -e "$fixture/invalid-keychain.plist" ]] || fail "invalid Keychain plist written"
invalid_keychain_mode=$(LAITA_SERVICE_LABEL="$LAITA_SERVICE_LABEL" \
  LAITA_DEPLOY_ROOT="$LAITA_DEPLOY_ROOT" LAITA_NODE_BIN="$LAITA_NODE_BIN" \
  LAITA_NODE_PATH="$(dirname "$LAITA_NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin" \
  LAITA_OPENAI_KEYCHAIN_ENABLED=unexpected node "$root/ops/macos/render-plist.mjs" \
    "$root/ops/macos/org.example.laita-api.plist.template" \
    "$fixture/invalid-keychain-mode.plist" 2>&1 || true)
expect_equal "$invalid_keychain_mode" ""
[[ ! -e "$fixture/invalid-keychain-mode.plist" ]] || fail "invalid Keychain mode plist written"

"$root/ops/macos/service.sh" start
status=$("$root/ops/macos/service.sh" status)
[[ "$status" == *"SERVICE_STATE=running"* && "$status" == *"SERVICE_PID=12345"* ]] || fail "unsafe or incomplete status"
[[ "$("$root/ops/macos/service.sh" health)" == *'"status":"ok"'* ]] || fail "health"
[[ "$("$root/ops/macos/service.sh" readiness)" == *'"status":"ready"'* ]] || fail "readiness"
"$root/ops/macos/service.sh" restart
[[ -f "$MOCK_LAUNCH_STATE" ]] || fail "restart did not reload"
"$root/ops/macos/service.sh" stop
[[ ! -f "$MOCK_LAUNCH_STATE" ]] || fail "stop did not disable"

old=1111111111111111111111111111111111111111
new=2222222222222222222222222222222222222222
mkdir -p "$LAITA_DEPLOY_ROOT/releases/$old" "$LAITA_DEPLOY_ROOT/releases/$new"
printf '%s\n' "$old" > "$LAITA_DEPLOY_ROOT/releases/$old/DEPLOYED_COMMIT"
printf '%s\n' "$new" > "$LAITA_DEPLOY_ROOT/releases/$new/DEPLOYED_COMMIT"
ln -s "$LAITA_DEPLOY_ROOT/releases/$new" "$LAITA_DEPLOY_ROOT/current"
printf '%s\n' '{"synthetic":"new"}' > "$LAITA_DEPLOY_ROOT/private/application-config.json"
chmod 600 "$LAITA_DEPLOY_ROOT/private/application-config.json"
backup="$LAITA_DEPLOY_ROOT/backups/synthetic-$old"
mkdir "$backup"
printf '%s\n' "$old" > "$backup/previous-commit"
cp "$fixture/private-config.json" "$backup/application-config.json"
cp "$LAITA_SERVICE_PLIST" "$backup/service.plist"
chmod 600 "$backup/application-config.json" "$backup/service.plist"
mkdir -p "$fixture/runtime/data"
node --input-type=module - "$fixture/runtime/data/foundation.sqlite" <<'JS'
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
const sql = "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL) STRICT";
const database = new DatabaseSync(process.argv[2]);
database.exec(`${sql}; PRAGMA user_version = 1`);
database.prepare("INSERT INTO schema_migrations VALUES (1, ?)").run(
  createHash("sha256").update(sql).digest("hex"),
);
database.close();
JS
chmod 600 "$fixture/runtime/data/foundation.sqlite"
export LAITA_ROLLBACK_BACKUP="$backup"
export LAITA_NODE_BIN="$fixture/bin/node-ok"
mkdir -p "$fixture/outside/backup"
ln -s "$fixture/outside" "$LAITA_DEPLOY_ROOT/backups/escape"
escaped_backup_error=$(LAITA_ROLLBACK_BACKUP="$LAITA_DEPLOY_ROOT/backups/escape/backup" \
  "$root/ops/macos/service.sh" rollback 2>&1 || true)
expect_equal "$escaped_backup_error" "SERVICE_ERROR=INVALID_ROLLBACK_BACKUP"
export LAITA_DEPLOY_ROOT="$fixture/aliases/root/deploy"
export LAITA_RUNTIME_ROOT="$fixture/aliases/root/runtime"
export LAITA_ROLLBACK_BACKUP="$fixture/aliases/root/deploy/backups/synthetic-$old"
rollback=$("$root/ops/macos/service.sh" rollback)
[[ "$rollback" == *"ROLLED_BACK_COMMIT=$old"* && "$rollback" == *"RUNTIME_DATA_ACTION=PRESERVED"* ]] || fail "rollback result"
expect_equal "$(readlink "$LAITA_DEPLOY_ROOT/current")" "$fixture/deploy/releases/$old"
cmp "$fixture/private-config.json" "$LAITA_DEPLOY_ROOT/private/application-config.json" >/dev/null ||
  fail "configuration rollback"
! grep -q 'LAITA_OPENAI_KEYCHAIN_' "$LAITA_SERVICE_PLIST" ||
  fail "Local-only rollback retained Keychain identifiers"
expect_equal "$(sqlite_version "$fixture/runtime/data/foundation.sqlite")" "1"

cp "$root/ops/macos/run-service.sh" "$LAITA_DEPLOY_ROOT/bin/run-service.sh"
chmod 700 "$LAITA_DEPLOY_ROOT/bin/run-service.sh"
export LAITA_NODE_BIN=/usr/bin/false
export LAITA_MAX_CRASH_RESTARTS=3
export LAITA_CRASH_WINDOW_SECONDS=300
for _attempt in 1 2 3; do
  if "$LAITA_DEPLOY_ROOT/bin/run-service.sh" >/dev/null 2>&1; then fail "crash budget ended early"; fi
done
budget_output=$("$LAITA_DEPLOY_ROOT/bin/run-service.sh" 2>&1)
expect_equal "$budget_output" "SERVICE_RESTART_BUDGET_EXHAUSTED"
failure_status=$("$root/ops/macos/service.sh" status 2>/dev/null || true)
[[ "$failure_status" == *"SERVICE_FAILURE=RESTART_BUDGET_EXHAUSTED"* ]] || fail "hidden crash budget failure"

LAITA_NODE_BIN="$MOCK_REAL_NODE" "$root/ops/macos/service.sh" remove >/dev/null
[[ ! -e "$LAITA_SERVICE_PLIST" && ! -e "$LAITA_DEPLOY_ROOT/current" ]] || fail "service removal"
[[ -d "$LAITA_DEPLOY_ROOT/releases/$old" && -d "$backup" ]] || fail "removal deleted rollback state"
expect_equal "$(sqlite_version "$fixture/runtime/data/foundation.sqlite")" "1"

# Full Public V1 Local-only release succeeds without any Keychain mapping.
local_only_config="$fixture/public-local-only.json"
node --input-type=module - "$fixture/private-config.json" "$local_only_config" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const c = JSON.parse(readFileSync(process.argv[2]));
c.provenance = { demoProfileVersion:'demo-profile.v4', policyVersion:'demo-policy.v4' };
writeFileSync(process.argv[3], JSON.stringify(c), {mode:0o600});
JS
unset LAITA_OPENAI_KEYCHAIN_MAPPING_FILE
export LAITA_DEPLOY_ROOT="$fixture/public-deploy"
export LAITA_RUNTIME_ROOT="$fixture/runtime"
export LAITA_CONFIG_FILE="$local_only_config"
export LAITA_SERVICE_PLIST="$fixture/public-service.plist"
export LAITA_NODE_BIN="$MOCK_REAL_NODE"
local_install=$("$root/ops/macos/service.sh" install)
[[ "$local_install" == *"SERVICE_STATE=DISABLED"* ]] || fail "Local-only public install failed"
! grep -q 'LAITA_OPENAI_KEYCHAIN_' "$LAITA_SERVICE_PLIST" || fail "Local-only public install emitted Keychain mapping"
[[ ! -e "$LAITA_DEPLOY_ROOT/private/keychain-mapping.json" ]] || fail "Local-only install created Keychain mapping"

echo "macOS operations tests passed"
