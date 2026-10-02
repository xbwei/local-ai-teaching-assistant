#!/usr/bin/env bash
set -euo pipefail
export GIT_LITERAL_PATHSPECS=1

repository_root="${REPOSITORY_ROOT:-$(git rev-parse --show-toplevel)}"
max_tracked_file_bytes="${MAX_TRACKED_FILE_BYTES:-5242880}"
policy_revision="${POLICY_REVISION:-HEAD}"
policy_base_revision="${POLICY_BASE_REVISION:-}"
policy_base_is_configured=0

if [[ ! "$max_tracked_file_bytes" =~ ^(0|[1-9][0-9]*)$ ]]; then
  printf '::error::MAX_TRACKED_FILE_BYTES must be a non-negative integer.\n' >&2
  exit 2
fi

if [[ ${POLICY_BASE_REVISION+x} ]]; then
  policy_base_is_configured=1
fi

if [[ "$policy_base_revision" =~ ^0+$ ]]; then
  policy_base_revision=""
fi

cd "$repository_root"

case "$policy_revision" in
  -*)
    printf '::error::POLICY_REVISION must not start with a hyphen.\n' >&2
    exit 2
    ;;
esac

if ! resolved_revision="$(git rev-parse --verify "${policy_revision}^{tree}")"; then
  printf '::error::POLICY_REVISION does not resolve to a Git tree.\n' >&2
  exit 2
fi

if [[ "$policy_base_revision" == -* ]]; then
  printf '::error::POLICY_BASE_REVISION must not start with a hyphen.\n' >&2
  exit 2
fi

failed=0

report_error() {
  local path="$1"
  local message="$2"
  printf '::error file=%s::%s\n' "$path" "$message" >&2
  failed=1
}

empty_tree="$(git hash-object -t tree /dev/null)"

is_prohibited_path() {
  local path="$1"

  # Keep this list aligned with the repository-wide exclusions in .gitignore.
  case "$path" in
    .env.example | */.env.example | \
    secrets.example | */secrets.example | \
    secrets.sample | */secrets.sample | \
    credentials.example | */credentials.example | \
    credentials.sample | */credentials.sample | \
    private.example | */private.example | \
    private.sample | */private.sample)
      return 1
      ;;
    .env | .env.* | */.env | */.env.* | \
    *.pem | *.key | *.p12 | *.pfx | *.jks | *.keystore | \
    .npmrc | */.npmrc | .pypirc | */.pypirc | \
    secrets | secrets.* | secrets/* | \
    */secrets | */secrets.* | */secrets/* | \
    credentials | credentials.* | credentials/* | \
    */credentials | */credentials.* | */credentials/* | \
    private | private.* | private/* | \
    */private | */private.* | */private/* | \
    local/* | */local/* | \
    config/local.* | */config/local.* | config/local/* | */config/local/* | \
    config/production.* | */config/production.* | \
    config/production/* | */config/production/* | \
    course-content/* | */course-content/* | \
    restricted-content/* | */restricted-content/* | \
    answer-keys/* | */answer-keys/* | hidden-tests/* | */hidden-tests/* | \
    student-data/* | */student-data/* | submissions/* | */submissions/* | \
    grades/* | */grades/* | research-data/* | */research-data/* | \
    recordings/* | */recordings/* | exports/* | */exports/* | \
    backups/* | */backups/* | node_modules/* | */node_modules/* | \
    dist/* | */dist/* | build/* | */build/* | \
    coverage/* | */coverage/* | __pycache__/* | */__pycache__/* | \
    .pytest_cache/* | */.pytest_cache/* | .mypy_cache/* | */.mypy_cache/* | \
    .ruff_cache/* | */.ruff_cache/* | .venv/* | */.venv/* | \
    venv/* | */venv/* | logs/* | */logs/* | tmp/* | */tmp/* | \
    temp/* | */temp/* | data/* | */data/* | uploads/* | */uploads/* | \
    generated-audio/* | */generated-audio/* | \
    *.sqlite | *.sqlite3 | *.db | \
    *.sqlite-journal | *.sqlite-wal | *.sqlite-shm | \
    *.sqlite3-journal | *.sqlite3-wal | *.sqlite3-shm | \
    *.db-journal | *.db-wal | *.db-shm | \
    *.gguf | *.safetensors | \
    *.onnx | *.bin | *.pt | .DS_Store | */.DS_Store | \
    .vscode/* | */.vscode/* | .idea/* | */.idea/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

scan_tree() {
  local tree_revision="$1"
  local entry

  if ! git diff --check "$empty_tree" "$tree_revision"; then
    printf '::error::Full-tree whitespace check failed for %s.\n' \
      "$tree_revision" >&2
    failed=1
  fi

  while IFS= read -r -d '' entry; do
    scan_tree_entry "$entry"
  done < <(git ls-tree -r -l -z "$tree_revision")
}

scan_tree_entry() {
  local entry="$1"
  local metadata="${entry%%$'\t'*}"
  local path="${entry#*$'\t'}"
  local metadata_without_mode="${metadata#* }"
  local object_type
  local size

  object_type="${metadata_without_mode%% *}"
  size="${metadata##* }"

  if is_prohibited_path "$path"; then
    report_error "$path" "Tracked path is prohibited by repository policy."
  fi

  if [[ "$object_type" == "blob" ]] && ((size > max_tracked_file_bytes)); then
    report_error "$path" \
      "Tracked file is ${size} bytes; limit is ${max_tracked_file_bytes} bytes."
  fi
}

scan_commit_diff() {
  local commit="$1"
  local parent="${commit}^"
  local path
  local entry

  if ! git rev-parse --verify "$parent" >/dev/null 2>&1; then
    parent="$empty_tree"
  fi

  if ! git diff --check --no-renames "$parent" "$commit"; then
    printf '::error::Commit whitespace check failed for %s.\n' "$commit" >&2
    failed=1
  fi

  while IFS= read -r -d '' path; do
    while IFS= read -r -d '' entry; do
      scan_tree_entry "$entry"
    done < <(git ls-tree -r -l -z "$commit" -- "$path")
  done < <(git diff --name-only --diff-filter=ACMRT --no-renames -z \
    "$parent" "$commit")
}

scan_tree "$resolved_revision"

if ((policy_base_is_configured != 0)) && [[ -n "$policy_base_revision" ]]; then
  if resolved_policy_commit="$(git rev-parse --verify \
    "${policy_revision}^{commit}" 2>/dev/null)" && \
    resolved_base_commit="$(git rev-parse --verify \
      "${policy_base_revision}^{commit}" 2>/dev/null)" && \
    range_base_commit="$(git merge-base \
      "$resolved_base_commit" "$resolved_policy_commit" 2>/dev/null)"; then
    while IFS= read -r commit; do
      scan_commit_diff "$commit"
    done < <(git rev-list --reverse \
      "${range_base_commit}..${resolved_policy_commit}")
  else
    printf '::warning::Base commit unavailable; scanned final tree only.\n' >&2
  fi
fi

if ((failed != 0)); then
  exit 1
fi

printf 'Repository policy checks passed.\n'
