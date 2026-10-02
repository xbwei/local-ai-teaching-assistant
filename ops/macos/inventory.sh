#!/bin/bash
set -euo pipefail

# This output is private deployment evidence. It deliberately omits identities,
# network addresses, serial/device identifiers, and literal filesystem paths.
checkout=${1:-}
disk_target=${2:-/}

if [[ -n "$checkout" && ! -d "$checkout/.git" && ! -f "$checkout/.git" ]]; then
  echo "INVENTORY_ERROR=INVALID_CHECKOUT" >&2
  exit 1
fi

echo "INVENTORY_CONTRACT=laita-macos-inventory.v1"
echo "OS_VERSION=$(/usr/bin/sw_vers -productVersion)"
echo "OS_BUILD=$(/usr/bin/sw_vers -buildVersion)"
echo "ARCHITECTURE=$(/usr/bin/uname -m)"
echo "MEMORY_BYTES=$(/usr/sbin/sysctl -n hw.memsize)"
/bin/df -Pk "$disk_target" | /usr/bin/awk 'NR == 2 { print "DISK_CAPACITY_KIB=" $2; print "DISK_AVAILABLE_KIB=" $4 }'

version_or_unavailable() {
  local command_name=$1
  shift
  if command -v "$command_name" >/dev/null 2>&1; then
    "$@" 2>/dev/null | /usr/bin/head -n 1
  else
    echo "UNAVAILABLE"
  fi
}

echo "NODE_VERSION=$(version_or_unavailable node node --version)"
echo "NPM_VERSION=$(version_or_unavailable npm npm --version)"
echo "PYTHON_VERSION=$(version_or_unavailable python3 python3 --version)"
echo "UV_VERSION=$(version_or_unavailable uv uv --version)"
echo "GIT_VERSION=$(version_or_unavailable git git --version)"

if command -v fdesetup >/dev/null 2>&1; then
  filevault=$(/usr/bin/fdesetup status 2>/dev/null || true)
  case "$filevault" in
    *"FileVault is On."*) echo "FILEVAULT=ON" ;;
    *"FileVault is Off."*) echo "FILEVAULT=OFF" ;;
    *) echo "FILEVAULT=UNAVAILABLE" ;;
  esac
else
  echo "FILEVAULT=UNAVAILABLE"
fi

if [[ -n "$checkout" ]]; then
  echo "CHECKOUT_COMMIT=$(git -C "$checkout" rev-parse HEAD 2>/dev/null || echo UNAVAILABLE)"
  if git -C "$checkout" diff --quiet --ignore-submodules -- &&
    git -C "$checkout" diff --cached --quiet --ignore-submodules -- &&
    [[ -z "$(git -C "$checkout" status --porcelain --untracked-files=all)" ]]; then
    echo "CHECKOUT_STATE=CLEAN"
  else
    echo "CHECKOUT_STATE=DIRTY"
  fi
  if git -C "$checkout" symbolic-ref -q HEAD >/dev/null 2>&1; then
    echo "CHECKOUT_MODE=BRANCH"
  else
    echo "CHECKOUT_MODE=DETACHED"
  fi
else
  echo "CHECKOUT_COMMIT=ABSENT"
  echo "CHECKOUT_STATE=ABSENT"
  echo "CHECKOUT_MODE=ABSENT"
fi
