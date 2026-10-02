#!/usr/bin/env bash
set -euo pipefail

repository_root="${REPOSITORY_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$repository_root"

failed=0

report_error() {
  local path="$1"
  printf '::error file=%s::Prohibited private/runtime artifact remains in the checkout.\n' \
    "$path" >&2
  failed=1
}

is_expected_generated_path() {
  local path="$1"
  case "$path" in
    node_modules/* | */node_modules/* | \
    dist/* | */dist/* | build/* | */build/* | coverage/* | */coverage/* | \
    .venv/* | */.venv/* | venv/* | */venv/* | \
    __pycache__/* | */__pycache__/* | \
    .pytest_cache/* | */.pytest_cache/* | \
    .mypy_cache/* | */.mypy_cache/* | \
    .ruff_cache/* | */.ruff_cache/* | \
    *.tsbuildinfo | */*.tsbuildinfo)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_prohibited_runtime_path() {
  local path="$1"
  case "$path" in
    .env | .env.* | */.env | */.env.* | \
    secrets | secrets/* | */secrets | */secrets/* | \
    credentials | credentials/* | */credentials | */credentials/* | \
    private | private/* | */private | */private/* | \
    local/* | */local/* | \
    config/local.* | */config/local.* | config/local/* | */config/local/* | \
    config/production.* | */config/production.* | \
    config/production/* | */config/production/* | \
    course-content/* | */course-content/* | \
    restricted-content/* | */restricted-content/* | \
    student-data/* | */student-data/* | submissions/* | */submissions/* | \
    grades/* | */grades/* | research-data/* | */research-data/* | \
    recordings/* | */recordings/* | backups/* | */backups/* | \
    logs/* | */logs/* | tmp/* | */tmp/* | temp/* | */temp/* | \
    data/* | */data/* | runtime-root/* | */runtime-root/* | \
    temporary-work/* | */temporary-work/* | \
    *.sqlite | *.sqlite3 | *.db | \
    *.sqlite-journal | *.sqlite-wal | *.sqlite-shm | \
    *.sqlite3-journal | *.sqlite3-wal | *.sqlite3-shm | \
    *.db-journal | *.db-wal | *.db-shm)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

while IFS= read -r -d '' path; do
  if is_expected_generated_path "$path"; then
    continue
  fi
  if is_prohibited_runtime_path "$path"; then
    report_error "$path"
  fi
done < <(
  git ls-files --others --exclude-standard -z
  git ls-files --others --ignored --exclude-standard -z
)

if ((failed != 0)); then
  exit 1
fi

printf 'Checkout contains no prohibited private/runtime artifacts.\n'
