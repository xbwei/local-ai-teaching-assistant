#!/bin/bash
set -euo pipefail

command_name=${1:-}
script_directory=$(cd "$(dirname "$0")" && pwd -P)
service_label=${LAITA_SERVICE_LABEL:-org.example.laita.api}
launch_domain="gui/$(/usr/bin/id -u)"
launchctl=/bin/launchctl
plutil=/usr/bin/plutil
curl=/usr/bin/curl
sqlite_rollback="$script_directory/sqlite-rollback.mjs"
providerConfig_preparation="$script_directory/prepare-provider-config.mjs"
if [[ "${LAITA_OPERATIONS_TESTING:-0}" == "1" ]]; then
  launchctl=${LAITA_TEST_LAUNCHCTL:?}
  plutil=${LAITA_TEST_PLUTIL:?}
  curl=${LAITA_TEST_CURL:?}
fi

fail() {
  echo "SERVICE_ERROR=$1" >&2
  exit 1
}

file_mode() {
  case "$(/usr/bin/uname -s)" in
    Darwin) /usr/bin/stat -f '%Lp' "$1" ;;
    Linux) /usr/bin/stat -c '%a' "$1" ;;
    *) fail UNSUPPORTED_OPERATIONS_PLATFORM ;;
  esac
}

validate_deployment_marker() {
  local marker="$LAITA_DEPLOY_ROOT/.laita-deployment-root"
  [[ ! -L "$marker" ]] || fail SYMLINKED_DEPLOYMENT_MARKER
  [[ -f "$marker" && -r "$marker" && "$(<"$marker")" == "deployment-root.v1" ]] ||
    fail UNMANAGED_DEPLOY_ROOT
  [[ "$(file_mode "$marker")" == "400" ]] ||
    fail INVALID_DEPLOYMENT_MARKER_PERMISSIONS
}

require_absolute() {
  local name=$1 value=$2
  [[ -n "$value" && "$value" == /* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] ||
    fail "INVALID_${name}"
  case "/$value/" in */../*|*/./*) fail "INVALID_${name}" ;; esac
}

canonical_directory_path() {
  local name=$1 path=$2 cursor=$2 suffix= component physical
  require_absolute "$name" "$path"
  [[ ! -L "$path" ]] || fail "SYMLINKED_${name}"
  while [[ ! -e "$cursor" ]]; do
    [[ ! -L "$cursor" ]] || fail "SYMLINKED_${name}"
    component=${cursor##*/}
    [[ -n "$component" ]] || fail "INVALID_${name}"
    suffix="/$component$suffix"
    cursor=${cursor%/*}
    [[ -n "$cursor" ]] || cursor=/
  done
  [[ -d "$cursor" ]] || fail "INVALID_${name}"
  physical=$(cd "$cursor" && pwd -P) || fail "INVALID_${name}"
  printf '%s%s\n' "${physical%/}" "$suffix"
}

require_common() {
  local root_mode=${1:-existing}
  : "${LAITA_DEPLOY_ROOT:=}"
  : "${LAITA_SERVICE_PLIST:=}"
  : "${LAITA_SERVICE_PORT:=}"
  require_absolute DEPLOY_ROOT "$LAITA_DEPLOY_ROOT"
  require_absolute SERVICE_PLIST "$LAITA_SERVICE_PLIST"
  LAITA_DEPLOY_ROOT=$(canonical_directory_path DEPLOY_ROOT "$LAITA_DEPLOY_ROOT")
  if [[ "${LAITA_OPERATIONS_TESTING:-0}" != "1" ]]; then
    local physical_home
    physical_home=$(cd "$HOME" && pwd -P) || fail INVALID_HOME
    case "$LAITA_DEPLOY_ROOT" in "$physical_home"/*/*) ;; *) fail UNSAFE_DEPLOY_ROOT ;; esac
    [[ "$LAITA_SERVICE_PLIST" == "$HOME/Library/LaunchAgents/$service_label.plist" ]] ||
      fail UNSAFE_SERVICE_PLIST
  fi
  [[ ! -L "$LAITA_DEPLOY_ROOT" && ! -L "$LAITA_SERVICE_PLIST" ]] || fail SYMLINKED_OPERATIONS_PATH
  if [[ -e "$LAITA_DEPLOY_ROOT" ]]; then
    validate_deployment_marker
  elif [[ "$root_mode" == "existing" ]]; then
    fail UNMANAGED_DEPLOY_ROOT
  fi
  [[ "$service_label" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$ ]] || fail INVALID_SERVICE_LABEL
  [[ "$LAITA_SERVICE_PORT" =~ ^[0-9]+$ && ${#LAITA_SERVICE_PORT} -le 5 ]] || fail INVALID_SERVICE_PORT
  local port=$((10#$LAITA_SERVICE_PORT))
  (( port >= 1024 && port <= 65535 )) || fail INVALID_SERVICE_PORT
}

is_loaded() {
  "$launchctl" print "$launch_domain/$service_label" >/dev/null 2>&1
}

disable_service() {
  require_absolute NODE_BIN "${LAITA_NODE_BIN:-}"
  [[ -x "$LAITA_NODE_BIN" ]] || fail NODE_NOT_EXECUTABLE
  "$LAITA_NODE_BIN" "$script_directory/quiesce-service.mjs" \
    "$launchctl" "$launch_domain/$service_label" || fail SERVICE_NOT_QUIESCENT
}

reset_crash_budget() {
  /bin/rm -f "$LAITA_DEPLOY_ROOT/private/crash-guard" "$LAITA_DEPLOY_ROOT/private/service-failure"
}

install_runner() {
  local runner="$LAITA_DEPLOY_ROOT/bin/run-service.sh"
  local next="$LAITA_DEPLOY_ROOT/bin/run-service.sh.next"
  [[ ! -L "$runner" && (! -e "$runner" || -f "$runner") ]] || fail INVALID_RUNNER
  [[ ! -L "$next" && (! -e "$next" || -f "$next") ]] || fail INVALID_RUNNER_STAGING
  /bin/rm -f "$next"
  /bin/cp "$script_directory/run-service.sh" "$next" || fail RUNNER_INSTALL_FAILED
  /bin/chmod 500 "$next" || fail RUNNER_INSTALL_FAILED
  /bin/mv -f "$next" "$runner" || fail RUNNER_INSTALL_FAILED
}

failure_status() {
  local failure_file="$LAITA_DEPLOY_ROOT/private/service-failure" failure
  [[ -f "$failure_file" && ! -L "$failure_file" ]] || return 0
  failure=$(<"$failure_file")
  [[ "$failure" == "RESTART_BUDGET_EXHAUSTED" ]] && echo "SERVICE_FAILURE=$failure"
}

select_release() {
  local release=$1 current="$LAITA_DEPLOY_ROOT/current" next="$LAITA_DEPLOY_ROOT/current.next"
  [[ ! -e "$current" || -L "$current" ]] || fail INVALID_CURRENT_RELEASE
  /bin/rm -f "$next"
  /bin/ln -s "$release" "$next"
  /bin/rm -f "$current"
  /bin/mv "$next" "$current"
}

validate_release_config() {
  local release=$1 runtime_root=$2 config=$3 node_bin=$4
  local envelope
  envelope=$("$node_bin" "$script_directory/validate-production-config.mjs" \
    "$release" "$config" "$runtime_root" "$LAITA_SERVICE_PORT" 2>/dev/null) ||
    fail INVALID_PRODUCTION_CONFIGURATION
  [[ "$envelope" == "LOCAL_ONLY" || "$envelope" == "PROVIDER_ENABLED" ]] ||
    fail INVALID_PRODUCTION_CONFIGURATION
  printf '%s\n' "$envelope"
}

validate_keychain_mapping() {
  : "${LAITA_OPENAI_KEYCHAIN_MAPPING_FILE:=}"
  require_absolute KEYCHAIN_MAPPING_FILE "$LAITA_OPENAI_KEYCHAIN_MAPPING_FILE"
  validate_private_file "$LAITA_OPENAI_KEYCHAIN_MAPPING_FILE"
  local result
  result=$("$LAITA_NODE_BIN" "$providerConfig_preparation" verify-mapping \
    "$LAITA_OPENAI_KEYCHAIN_MAPPING_FILE" 2>/dev/null) ||
    fail INVALID_KEYCHAIN_MAPPING
  [[ "$result" == "KEYCHAIN_MAPPING_VALID" ]] || fail INVALID_KEYCHAIN_MAPPING
}

probe_release_database_compatibility() {
  local release=$1 database=$2 backup=$3 node_bin=$4
  local compatibility="$backup/.sqlite-compatibility-$$"
  local compatibility_journal="$compatibility-journal"
  local compatibility_wal="$compatibility-wal"
  local compatibility_shm="$compatibility-shm"
  "$node_bin" "$sqlite_rollback" compatibility-copy "$database" "$compatibility" >/dev/null 2>&1 ||
    fail INVALID_SQLITE_ROLLBACK_STATE
  if ! (cd "$release" && ROLLBACK_COMPATIBILITY_DATABASE="$compatibility" \
    "$node_bin" --input-type=module -e '
      import { initializePersistence } from "@laita/persistence";
      const result = initializePersistence({
        prepareDatabaseFile: () => process.env.ROLLBACK_COMPATIBILITY_DATABASE,
      });
      if (!result.ok || !result.value.close().ok) process.exit(1);
    ' >/dev/null 2>&1); then
    /bin/rm -f "$compatibility" "$compatibility_journal" "$compatibility_wal" "$compatibility_shm" ||
      fail INVALID_SQLITE_ROLLBACK_STATE
    # Only release initialization failure means incompatible.
    return 1
  fi
  /bin/rm -f "$compatibility" "$compatibility_journal" "$compatibility_wal" "$compatibility_shm" ||
    fail INVALID_SQLITE_ROLLBACK_STATE
  return 0
}

validate_release_database_compatibility() {
  probe_release_database_compatibility "$@" || fail INCOMPATIBLE_SQLITE_ROLLBACK_RELEASE
}

validate_private_file() {
  local file=$1
  [[ -f "$file" && ! -L "$file" ]] || fail INVALID_PRIVATE_FILE
  local mode
  mode=$(file_mode "$file")
  [[ "$mode" == "600" ]] || fail INVALID_PRIVATE_FILE_PERMISSIONS
}

install_release() {
  require_common initialize
  : "${LAITA_CHECKOUT:=}"
  : "${LAITA_EXPECTED_COMMIT:=}"
  : "${LAITA_RUNTIME_ROOT:=}"
  : "${LAITA_CONFIG_FILE:=}"
  : "${LAITA_NODE_BIN:=}"
  require_absolute CHECKOUT "$LAITA_CHECKOUT"
  require_absolute RUNTIME_ROOT "$LAITA_RUNTIME_ROOT"
  require_absolute CONFIG_FILE "$LAITA_CONFIG_FILE"
  require_absolute NODE_BIN "$LAITA_NODE_BIN"
  LAITA_CHECKOUT=$(canonical_directory_path CHECKOUT "$LAITA_CHECKOUT")
  LAITA_RUNTIME_ROOT=$(canonical_directory_path RUNTIME_ROOT "$LAITA_RUNTIME_ROOT")
  [[ "$LAITA_EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail INVALID_EXPECTED_COMMIT
  [[ -x "$LAITA_NODE_BIN" ]] || fail NODE_NOT_EXECUTABLE
  validate_private_file "$LAITA_CONFIG_FILE"
  [[ "$LAITA_DEPLOY_ROOT" != "$LAITA_RUNTIME_ROOT" ]] || fail OVERLAPPING_ROOTS
  case "$LAITA_DEPLOY_ROOT/" in "$LAITA_RUNTIME_ROOT/"*) fail OVERLAPPING_ROOTS ;; esac
  case "$LAITA_RUNTIME_ROOT/" in "$LAITA_DEPLOY_ROOT/"*) fail OVERLAPPING_ROOTS ;; esac
  case "$LAITA_DEPLOY_ROOT/" in "$LAITA_CHECKOUT/"*) fail DEPLOY_ROOT_INSIDE_CHECKOUT ;; esac
  case "$LAITA_CHECKOUT/" in "$LAITA_DEPLOY_ROOT/"*) fail CHECKOUT_INSIDE_DEPLOY_ROOT ;; esac

  local head remote_main
  head=$(git -C "$LAITA_CHECKOUT" rev-parse HEAD 2>/dev/null) || fail INVALID_CHECKOUT
  remote_main=$(git -C "$LAITA_CHECKOUT" rev-parse refs/remotes/origin/main 2>/dev/null) || fail MISSING_ORIGIN_MAIN
  [[ "$head" == "$LAITA_EXPECTED_COMMIT" && "$remote_main" == "$LAITA_EXPECTED_COMMIT" ]] ||
    fail COMMIT_MISMATCH
  if git -C "$LAITA_CHECKOUT" symbolic-ref -q HEAD >/dev/null 2>&1; then
    fail BRANCH_DEPLOYMENT_PROHIBITED
  fi
  [[ -z "$(git -C "$LAITA_CHECKOUT" status --porcelain --untracked-files=all)" ]] || fail DIRTY_CHECKOUT

  local production_envelope
  production_envelope=$(validate_release_config "$LAITA_CHECKOUT" "$LAITA_RUNTIME_ROOT" "$LAITA_CONFIG_FILE" "$LAITA_NODE_BIN")
  if [[ "$production_envelope" == "LOCAL_ONLY" ]]; then
    # Only the full operator profile is a deployable Local-only candidate.
    "$LAITA_NODE_BIN" -e 'const fs = require("node:fs"); const c = JSON.parse(fs.readFileSync(process.argv[1])); if (c.provenance.demoProfileVersion !== "demo-profile.v4") process.exit(1)' "$LAITA_CONFIG_FILE" || fail INVALID_PRODUCTION_CONFIGURATION
  else
    validate_keychain_mapping
  fi

  (cd "$LAITA_CHECKOUT" && npm run validate -- deployment-runtime-compatibility) ||
    fail CANDIDATE_VALIDATION_FAILED
  [[ -z "$(git -C "$LAITA_CHECKOUT" status --porcelain --untracked-files=all)" ]] || fail VALIDATION_DIRTIED_CHECKOUT

  umask 077
  /bin/mkdir -p "$LAITA_DEPLOY_ROOT/releases" "$LAITA_DEPLOY_ROOT/backups" "$LAITA_DEPLOY_ROOT/bin" "$LAITA_DEPLOY_ROOT/private"
  /bin/mkdir -p "$LAITA_RUNTIME_ROOT"
  for managed_directory in "$LAITA_DEPLOY_ROOT" "$LAITA_DEPLOY_ROOT/releases" \
    "$LAITA_DEPLOY_ROOT/backups" "$LAITA_DEPLOY_ROOT/bin" "$LAITA_DEPLOY_ROOT/private" "$LAITA_RUNTIME_ROOT"; do
    [[ -d "$managed_directory" && ! -L "$managed_directory" ]] || fail SYMLINKED_MANAGED_DIRECTORY
  done
  [[ "$(cd "$LAITA_DEPLOY_ROOT" && pwd -P)" == "$LAITA_DEPLOY_ROOT" ]] || fail NONCANONICAL_DEPLOY_ROOT
  /bin/chmod 700 "$LAITA_DEPLOY_ROOT" "$LAITA_DEPLOY_ROOT/releases" "$LAITA_DEPLOY_ROOT/backups" \
    "$LAITA_DEPLOY_ROOT/bin" "$LAITA_DEPLOY_ROOT/private" "$LAITA_RUNTIME_ROOT"
  local marker="$LAITA_DEPLOY_ROOT/.laita-deployment-root"
  if [[ ! -e "$marker" && ! -L "$marker" ]]; then
    (umask 077; set -C; printf '%s\n' "deployment-root.v1" > "$marker") 2>/dev/null ||
      fail DEPLOYMENT_MARKER_INITIALIZATION_FAILED
    /bin/chmod 400 "$marker" || fail DEPLOYMENT_MARKER_INITIALIZATION_FAILED
  fi
  validate_deployment_marker
  [[ ! -L "$LAITA_DEPLOY_ROOT/private/application-config.json" ]] || fail SYMLINKED_PRIVATE_CONFIG

  local release="$LAITA_DEPLOY_ROOT/releases/$LAITA_EXPECTED_COMMIT"
  [[ ! -L "$release" ]] || fail SYMLINKED_RELEASE
  if [[ ! -d "$release" ]]; then
    local staging="$LAITA_DEPLOY_ROOT/releases/.staging-$LAITA_EXPECTED_COMMIT-$$"
    [[ ! -e "$staging" ]] || fail STAGING_COLLISION
    /bin/mkdir "$staging"
    trap '/bin/rm -rf "$staging"' EXIT
    git -C "$LAITA_CHECKOUT" archive "$LAITA_EXPECTED_COMMIT" | /usr/bin/tar -x -C "$staging"
    (cd "$staging" && npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts) ||
      fail RELEASE_BUILD_FAILED
    printf '%s\n' "$LAITA_EXPECTED_COMMIT" > "$staging/DEPLOYED_COMMIT"
    /bin/chmod 400 "$staging/DEPLOYED_COMMIT"
    /bin/mv "$staging" "$release"
    trap - EXIT
  else
    [[ -f "$release/DEPLOYED_COMMIT" && ! -L "$release/DEPLOYED_COMMIT" &&
      "$(<"$release/DEPLOYED_COMMIT")" == "$LAITA_EXPECTED_COMMIT" ]] || fail RELEASE_IDENTITY_MISMATCH
  fi

  local backup=
  if [[ -L "$LAITA_DEPLOY_ROOT/current" ]]; then
    local previous
    previous=$(/usr/bin/basename "$(/usr/bin/readlink "$LAITA_DEPLOY_ROOT/current")")
    [[ "$previous" =~ ^[0-9a-f]{40}$ ]] || fail INVALID_CURRENT_RELEASE
    validate_private_file "$LAITA_DEPLOY_ROOT/private/application-config.json"
    validate_private_file "$LAITA_SERVICE_PLIST"
    "$plutil" -lint "$LAITA_SERVICE_PLIST" >/dev/null || fail INVALID_PLIST
    backup="$LAITA_DEPLOY_ROOT/backups/$(/bin/date -u +%Y%m%dT%H%M%SZ)-$previous-$$"
    /bin/mkdir "$backup"
    printf '%s\n' "$previous" > "$backup/previous-commit"
    /bin/cp -p "$LAITA_DEPLOY_ROOT/private/application-config.json" "$backup/application-config.json"
    /bin/cp -p "$LAITA_SERVICE_PLIST" "$backup/service.plist"
    /bin/chmod -R go-rwx "$backup"
  fi

  disable_service
  if [[ -n "$backup" ]]; then
    local runtime_database="$LAITA_RUNTIME_ROOT/data/foundation.sqlite"
    [[ -f "$runtime_database" && ! -L "$runtime_database" ]] || fail MISSING_RUNTIME_DATABASE
    "$LAITA_NODE_BIN" "$sqlite_rollback" snapshot "$runtime_database" "$backup" >/dev/null 2>&1 ||
      fail SQLITE_SNAPSHOT_FAILED
  fi
  install_runner
  /bin/cp "$LAITA_CONFIG_FILE" "$LAITA_DEPLOY_ROOT/private/application-config.json"
  /bin/chmod 600 "$LAITA_DEPLOY_ROOT/private/application-config.json"
  select_release "$release"

  local node_directory controlled_path
  node_directory=$(cd "$(dirname "$LAITA_NODE_BIN")" && pwd -P)
  controlled_path="$node_directory:/usr/bin:/bin:/usr/sbin:/sbin"
  LAITA_SERVICE_LABEL="$service_label" LAITA_DEPLOY_ROOT="$LAITA_DEPLOY_ROOT" \
    LAITA_NODE_BIN="$LAITA_NODE_BIN" LAITA_NODE_PATH="$controlled_path" \
    LAITA_OPENAI_KEYCHAIN_ENABLED="$([[ "$production_envelope" == "PROVIDER_ENABLED" ]] && echo 1 || echo 0)" \
    LAITA_OPENAI_KEYCHAIN_MAPPING_FILE="$([[ "$production_envelope" == "PROVIDER_ENABLED" ]] && printf '%s' "$LAITA_OPENAI_KEYCHAIN_MAPPING_FILE")" \
    "$LAITA_NODE_BIN" "$script_directory/render-plist.mjs" \
      "$script_directory/org.example.laita-api.plist.template" "$LAITA_SERVICE_PLIST" ||
    fail PLIST_RENDER_FAILED
  /bin/chmod 600 "$LAITA_SERVICE_PLIST"
  "$plutil" -lint "$LAITA_SERVICE_PLIST" >/dev/null || fail INVALID_PLIST
  reset_crash_budget
  echo "DEPLOYED_COMMIT=$LAITA_EXPECTED_COMMIT"
  echo "SERVICE_STATE=DISABLED"
}

rollback_release() {
  require_common
  : "${LAITA_ROLLBACK_BACKUP:=}"
  : "${LAITA_RUNTIME_ROOT:=}"
  : "${LAITA_NODE_BIN:=}"
  require_absolute ROLLBACK_BACKUP "$LAITA_ROLLBACK_BACKUP"
  require_absolute RUNTIME_ROOT "$LAITA_RUNTIME_ROOT"
  require_absolute NODE_BIN "$LAITA_NODE_BIN"
  LAITA_ROLLBACK_BACKUP=$(canonical_directory_path ROLLBACK_BACKUP "$LAITA_ROLLBACK_BACKUP")
  LAITA_RUNTIME_ROOT=$(canonical_directory_path RUNTIME_ROOT "$LAITA_RUNTIME_ROOT")
  [[ -x "$LAITA_NODE_BIN" ]] || fail NODE_NOT_EXECUTABLE
  case "$LAITA_ROLLBACK_BACKUP/" in "$LAITA_DEPLOY_ROOT/backups/"*) ;; *) fail INVALID_ROLLBACK_BACKUP ;; esac
  [[ -d "$LAITA_ROLLBACK_BACKUP" && ! -L "$LAITA_ROLLBACK_BACKUP" ]] || fail INVALID_ROLLBACK_BACKUP
  local commit
  commit=$(<"$LAITA_ROLLBACK_BACKUP/previous-commit")
  local release="$LAITA_DEPLOY_ROOT/releases/$commit"
  [[ "$commit" =~ ^[0-9a-f]{40}$ && -d "$release" && ! -L "$release" &&
    -f "$release/DEPLOYED_COMMIT" && ! -L "$release/DEPLOYED_COMMIT" &&
    "$(<"$release/DEPLOYED_COMMIT")" == "$commit" ]] || fail INVALID_ROLLBACK_RELEASE
  validate_private_file "$LAITA_ROLLBACK_BACKUP/application-config.json"
  "$plutil" -lint "$LAITA_ROLLBACK_BACKUP/service.plist" >/dev/null || fail INVALID_ROLLBACK_PLIST
  validate_release_config "$release" "$LAITA_RUNTIME_ROOT" \
    "$LAITA_ROLLBACK_BACKUP/application-config.json" "$LAITA_NODE_BIN" >/dev/null
  local runtime_database="$LAITA_RUNTIME_ROOT/data/foundation.sqlite"
  [[ -f "$runtime_database" && ! -L "$runtime_database" ]] || fail MISSING_RUNTIME_DATABASE
  local snapshot="$LAITA_ROLLBACK_BACKUP/sqlite-pre-migration.sqlite"
  local snapshot_metadata="$LAITA_ROLLBACK_BACKUP/sqlite-pre-migration.json"
  if [[ -e "$snapshot" || -L "$snapshot" || -e "$snapshot_metadata" || -L "$snapshot_metadata" ]]; then
    [[ -f "$snapshot" && ! -L "$snapshot" && -f "$snapshot_metadata" && ! -L "$snapshot_metadata" ]] ||
      fail INVALID_SQLITE_SNAPSHOT
    "$LAITA_NODE_BIN" "$sqlite_rollback" verify-snapshot "$runtime_database" "$LAITA_ROLLBACK_BACKUP" >/dev/null 2>&1 ||
      fail INVALID_SQLITE_SNAPSHOT
  fi
  disable_service
  local runtime_data_action=PRESERVED_COMPATIBLE_CURRENT
  if probe_release_database_compatibility "$release" "$runtime_database" "$LAITA_ROLLBACK_BACKUP" "$LAITA_NODE_BIN"; then
    : # Preserve the validated current database, even when a snapshot exists.
  else
    [[ -f "$snapshot" && -f "$snapshot_metadata" ]] || fail INCOMPATIBLE_SQLITE_ROLLBACK_RELEASE
    validate_release_database_compatibility "$release" "$snapshot" "$LAITA_ROLLBACK_BACKUP" "$LAITA_NODE_BIN"
    "$LAITA_NODE_BIN" "$sqlite_rollback" restore "$runtime_database" "$LAITA_ROLLBACK_BACKUP" ||
      fail SQLITE_RESTORE_FAILED
    runtime_data_action=RESTORED_FROM_SNAPSHOT
  fi
  [[ ! -L "$LAITA_DEPLOY_ROOT/private/application-config.json" ]] || fail SYMLINKED_PRIVATE_CONFIG
  /bin/cp "$LAITA_ROLLBACK_BACKUP/application-config.json" "$LAITA_DEPLOY_ROOT/private/application-config.json"
  /bin/cp "$LAITA_ROLLBACK_BACKUP/service.plist" "$LAITA_SERVICE_PLIST"
  /bin/chmod 600 "$LAITA_DEPLOY_ROOT/private/application-config.json" "$LAITA_SERVICE_PLIST"
  select_release "$release"
  reset_crash_budget
  echo "ROLLED_BACK_COMMIT=$commit"
  echo "RUNTIME_DATA_ACTION=$runtime_data_action"
  echo "SERVICE_STATE=DISABLED"
}

case "$command_name" in
  inventory)
    exec "$script_directory/inventory.sh" "${LAITA_CHECKOUT:-}" "${LAITA_DISK_TARGET:-/}"
    ;;
  install|update)
    install_release
    ;;
  start)
    require_common
    [[ -f "$LAITA_SERVICE_PLIST" ]] || fail SERVICE_NOT_INSTALLED
    "$plutil" -lint "$LAITA_SERVICE_PLIST" >/dev/null || fail INVALID_PLIST
    reset_crash_budget
    if is_loaded; then "$launchctl" kickstart -k "$launch_domain/$service_label"; else "$launchctl" bootstrap "$launch_domain" "$LAITA_SERVICE_PLIST"; fi
    ;;
  stop|disable)
    require_common
    disable_service
    ;;
  restart)
    require_common
    disable_service
    reset_crash_budget
    "$launchctl" bootstrap "$launch_domain" "$LAITA_SERVICE_PLIST"
    ;;
  status)
    require_common
    if ! is_loaded; then echo "SERVICE_STATE=DISABLED"; failure_status; exit 3; fi
    status_output=$("$launchctl" print "$launch_domain/$service_label" | /usr/bin/awk -F'= ' '
      /^[[:space:]]*state = / { print "SERVICE_STATE=" $2 }
      /^[[:space:]]*pid = / { print "SERVICE_PID=" $2 }
      /^[[:space:]]*last exit code = / { print "LAST_EXIT_CODE=" $2 }
    ') || fail STATUS_UNAVAILABLE
    [[ "$status_output" == *"SERVICE_STATE="* ]] || fail STATUS_UNAVAILABLE
    printf '%s\n' "$status_output"
    failure_status
    ;;
  health|readiness)
    require_common
    endpoint=health
    [[ "$command_name" == "readiness" ]] && endpoint=ready
    exec "$curl" --fail --silent --show-error --max-time 5 "http://127.0.0.1:$LAITA_SERVICE_PORT/$endpoint"
    ;;
  version)
    require_common
    [[ -L "$LAITA_DEPLOY_ROOT/current" ]] || fail SERVICE_NOT_INSTALLED
    commit=$(<"$LAITA_DEPLOY_ROOT/current/DEPLOYED_COMMIT")
    [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail INVALID_DEPLOYED_VERSION
    echo "DEPLOYED_COMMIT=$commit"
    ;;
  rollback)
    rollback_release
    ;;
  remove)
    require_common
    disable_service
    /bin/rm -f "$LAITA_SERVICE_PLIST" "$LAITA_DEPLOY_ROOT/current" \
      "$LAITA_DEPLOY_ROOT/bin/run-service.sh" "$LAITA_DEPLOY_ROOT/private/application-config.json" \
      "$LAITA_DEPLOY_ROOT/private/crash-guard" "$LAITA_DEPLOY_ROOT/private/service-failure"
    echo "SERVICE_STATE=REMOVED"
    echo "RELEASES_BACKUPS_RUNTIME_DATA=PRESERVED"
    ;;
  *)
    echo "usage: service.sh {inventory|install|update|start|stop|restart|status|health|readiness|version|disable|rollback|remove}" >&2
    exit 64
    ;;
esac
