#!/usr/bin/env bash
# Load a strictly formatted, harness-owned PostgreSQL environment file and run
# the Buck-built integration-test binary. Values are treated as data, never code.
set -euo pipefail

env_file="${MNT_BUCK_POSTGRES_ENV_FILE:?Buck PostgreSQL environment file is required}"
if [[ ! -f "${env_file}" ]]; then
  echo "buck-postgres: environment file is not a regular file" >&2
  exit 1
fi

file_mode="$(stat -f '%Lp' "${env_file}" 2>/dev/null || stat -c '%a' "${env_file}")"
if [[ "${file_mode}" != "600" ]]; then
  echo "buck-postgres: environment file must be mode 0600" >&2
  exit 1
fi

safe_value_pattern='^[A-Za-z0-9:/?%._@+&=-]+$'
have_database_url=0
have_owner_url=0
have_runtime_url=0
have_admin_url=0
while IFS= read -r line || [[ -n "${line}" ]]; do
  case "${line}" in
    *=*) key="${line%%=*}"; value="${line#*=}" ;;
    *) echo "buck-postgres: malformed environment file" >&2; exit 1 ;;
  esac
  [[ "${value}" =~ ${safe_value_pattern} ]] || { echo "buck-postgres: malformed environment file" >&2; exit 1; }
  case "${key}" in
    DATABASE_URL)
      [[ "${have_database_url}" == 0 ]] || { echo "buck-postgres: duplicate environment key" >&2; exit 1; }
      have_database_url=1 ;;
    MNT_APALIS_OWNER_DATABASE_URL)
      [[ "${have_owner_url}" == 0 ]] || { echo "buck-postgres: duplicate environment key" >&2; exit 1; }
      have_owner_url=1 ;;
    MNT_APALIS_RUNTIME_DATABASE_URL)
      [[ "${have_runtime_url}" == 0 ]] || { echo "buck-postgres: duplicate environment key" >&2; exit 1; }
      have_runtime_url=1 ;;
    MNT_APALIS_ADMIN_DATABASE_URL)
      [[ "${have_admin_url}" == 0 ]] || { echo "buck-postgres: duplicate environment key" >&2; exit 1; }
      have_admin_url=1 ;;
    *) echo "buck-postgres: unexpected environment key" >&2; exit 1 ;;
  esac
  export "${key}=${value}"
done <"${env_file}"

if [[ "${have_database_url}${have_owner_url}${have_runtime_url}${have_admin_url}" != "1111" ]]; then
  echo "buck-postgres: incomplete environment file" >&2
  exit 1
fi
exec "$@"
