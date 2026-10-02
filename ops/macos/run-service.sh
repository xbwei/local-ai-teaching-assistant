#!/bin/bash
set -euo pipefail

: "${LAITA_DEPLOY_ROOT:?}"
: "${LAITA_NODE_BIN:?}"
: "${LAITA_MAX_CRASH_RESTARTS:=3}"
: "${LAITA_CRASH_WINDOW_SECONDS:=300}"

case "$LAITA_DEPLOY_ROOT" in /*) ;; *) exit 64 ;; esac
case "$LAITA_NODE_BIN" in /*) ;; *) exit 64 ;; esac
case "$LAITA_MAX_CRASH_RESTARTS:$LAITA_CRASH_WINDOW_SECONDS" in
  *[!0-9:]*|0:*|*:0) exit 64 ;;
esac
(( ${#LAITA_MAX_CRASH_RESTARTS} <= 3 && ${#LAITA_CRASH_WINDOW_SECONDS} <= 10 )) || exit 64
LAITA_MAX_CRASH_RESTARTS=$((10#$LAITA_MAX_CRASH_RESTARTS))
LAITA_CRASH_WINDOW_SECONDS=$((10#$LAITA_CRASH_WINDOW_SECONDS))

private="$LAITA_DEPLOY_ROOT/private"
guard="$private/crash-guard"
config="$private/application-config.json"
current="$LAITA_DEPLOY_ROOT/current"
now=$(/bin/date +%s)
first=$now
count=0

if [[ -f "$guard" ]]; then
  read -r first count < "$guard" || exit 70
  case "$first:$count" in *[!0-9:]*|*:) exit 70 ;; esac
  (( ${#first} <= 10 && ${#count} <= 3 )) || exit 70
  first=$((10#$first))
  count=$((10#$count))
  if (( now - first >= LAITA_CRASH_WINDOW_SECONDS )); then
    first=$now
    count=0
  fi
fi

count=$((count + 1))
if (( count > LAITA_MAX_CRASH_RESTARTS )); then
  umask 077
  printf '%s\n' "RESTART_BUDGET_EXHAUSTED" > "$private/service-failure"
  chmod 600 "$private/service-failure"
  echo "SERVICE_RESTART_BUDGET_EXHAUSTED" >&2
  exit 0
fi
umask 077
printf '%s %s\n' "$first" "$count" > "$guard"
chmod 600 "$guard"

[[ -x "$LAITA_NODE_BIN" && -L "$current" && -r "$config" ]] || exit 70
case "$(/usr/bin/uname -s)" in
  Darwin) config_mode=$(/usr/bin/stat -f '%Lp' "$config") ;;
  Linux) config_mode=$(/usr/bin/stat -c '%a' "$config") ;;
  *) exit 70 ;;
esac
[[ "$config_mode" == "600" ]] || exit 70
APP_CONFIG_JSON=$(<"$config")
export APP_CONFIG_JSON
unset LAITA_STT_PROFILE
if [[ -e "$private/stt-profile.json" ]]; then
  LAITA_STT_PROFILE="$private/stt-profile.json"
  export LAITA_STT_PROFILE
fi
exec "$LAITA_NODE_BIN" "$current/apps/api/dist/main.js"
