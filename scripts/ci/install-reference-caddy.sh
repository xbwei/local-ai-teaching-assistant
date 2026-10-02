#!/usr/bin/env bash
set -euo pipefail

# Isolated test tooling only: no service or system trust installation.
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]]
: "${RUNNER_TEMP:?GitHub runner temporary directory required}"
: "${GITHUB_PATH:?GitHub runner PATH file required}"
tool_root="$(mktemp -d "$RUNNER_TEMP/laita-caddy.XXXXXX")"
archive="$tool_root/caddy.tar.gz"
curl --fail --silent --show-error --location \
  https://github.com/caddyserver/caddy/releases/download/v2.11.6/caddy_2.11.6_linux_amd64.tar.gz \
  --output "$archive"
# SHA-512 from the official v2.11.6 release checksum manifest.
printf '%s  %s\n' \
  422771007d505ea97efd1177a4905b2c1a471cd426668f2ace3bcda3d8e30b11f9b1610bfb02c6ad60f2a795f56124f2f5eec6409c17d5a0dd4c21a11375fb94 \
  "$archive" | sha512sum --check --status
mkdir "$tool_root/bin"
tar -xzf "$archive" -C "$tool_root/bin" caddy
"$tool_root/bin/caddy" version
printf '%s\n' "$tool_root/bin" >> "$GITHUB_PATH"
