#!/usr/bin/env bash
# Run Buck2 tests that need PostgreSQL against a disposable local container.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
postgres_image="postgres:18.4@sha256:65f70a152846cf504dff86e807007e9aeac98c3aeb7b62541b2c55ab9d264e56"
container_name="mnt-buck-postgres-${USER:-user}-$$"
buck_bin="${MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK:-${repo_root}/tools/buck2}"
safe_user="${USER:-user}"
safe_user="${safe_user//[^[:alnum:]_.-]/_}"
repo_hash="$(printf '%s' "${repo_root}" | cksum | awk '{print $1}')"
isolation_name="${MNT_BUCK_NEEDS_POSTGRES_ISOLATION_DIR:-mnt-buck-postgres-${safe_user}-${repo_hash}}"
if [[ ! "${isolation_name}" =~ ^[[:alnum:]_.-]+$ ]]; then
  echo "buck-postgres: isolation name must contain only letters, digits, dot, underscore, or dash" >&2
  exit 1
fi
database="mnt_buck_test_$$_contract"
container_env_file=""
test_env_file=""

cleanup() {
  local status=$?
  docker rm -f "${container_name}" >/dev/null 2>&1 || true
  [[ -z "${container_env_file}" ]] || rm -f "${container_env_file}"
  [[ -z "${test_env_file}" ]] || rm -f "${test_env_file}"
  return "${status}"
}
trap cleanup EXIT HUP INT TERM

secret() { openssl rand -hex 32; }
admin_password="$(secret)"
app_password="$(secret)"
runtime_password="$(secret)"
leave_command_password="$(secret)"
ontology_command_password="$(secret)"
platform_force_command_password="$(secret)"
passwords=("${admin_password}" "${app_password}" "${runtime_password}" "${leave_command_password}" "${ontology_command_password}" "${platform_force_command_password}")
for ((i = 0; i < ${#passwords[@]}; i++)); do
  for ((j = i + 1; j < ${#passwords[@]}; j++)); do
    if [[ "${passwords[i]}" == "${passwords[j]}" ]]; then
      echo "buck-postgres: generated passwords must be pairwise distinct" >&2
      exit 1
    fi
  done
done

umask 077
container_env_file="$(mktemp "${TMPDIR:-/tmp}/mnt-buck-postgres-container.XXXXXX")"
chmod 600 "${container_env_file}"
{
  printf 'POSTGRES_DB=%s\nPOSTGRES_USER=mnt_buck_admin\nPOSTGRES_PASSWORD=%s\n' "${database}" "${admin_password}"
  printf 'POSTGRES_HOST=127.0.0.1\nPOSTGRES_PORT=5432\nPOSTGRES_ADMIN_USER=mnt_buck_admin\nPOSTGRES_ADMIN_PASSWORD=%s\n' "${admin_password}"
  printf 'MNT_APP_POSTGRES_PASSWORD=%s\nMNT_RT_POSTGRES_PASSWORD=%s\n' "${app_password}" "${runtime_password}"
  printf 'MNT_LEAVE_COMMAND_POSTGRES_PASSWORD=%s\nMNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD=%s\nMNT_PLATFORM_FORCE_COMMAND_PASSWORD=%s\n' "${leave_command_password}" "${ontology_command_password}" "${platform_force_command_password}"
} >"${container_env_file}"

docker run -d --rm --name "${container_name}" -p 127.0.0.1::5432 \
  --env-file "${container_env_file}" "${postgres_image}" >/dev/null
docker cp "${repo_root}/ops/postgres-reconcile-topology.sh" "${container_name}:/topology.sh"
docker cp "${container_env_file}" "${container_name}:/topology.env"

for attempt in {1..30}; do
  if docker exec "${container_name}" pg_isready -U mnt_buck_admin -d "${database}" >/dev/null 2>&1; then break; fi
  if [[ "${attempt}" == 30 ]]; then echo "buck-postgres: disposable PostgreSQL did not become healthy" >&2; exit 1; fi
  sleep 1
done
# The protected file path, not any value, is in Docker's host argv.
docker exec "${container_name}" sh -ceu 'set -a; . /topology.env; exec bash /topology.sh'

port_mapping="$(docker port "${container_name}" 5432/tcp)"
port="${port_mapping##*:}"
if [[ ! "${port}" =~ ^[0-9]+$ ]]; then echo "buck-postgres: could not resolve disposable PostgreSQL loopback port" >&2; exit 1; fi
database_url="postgres://mnt_buck_admin:${admin_password}@127.0.0.1:${port}/${database}?options%5Bmnt.sqlx_test_bootstrap%5D=buck-sqlx-superuser-v1"
apalis_owner_database_url="postgres://mnt_app:${app_password}@127.0.0.1:${port}/${database}"
apalis_runtime_database_url="postgres://mnt_rt:${runtime_password}@127.0.0.1:${port}/${database}"
test_env_file="$(mktemp "${TMPDIR:-/tmp}/mnt-buck-postgres-env.XXXXXX")"
chmod 600 "${test_env_file}"
{
  printf 'DATABASE_URL=%s\n' "${database_url}"
  printf 'MNT_APALIS_OWNER_DATABASE_URL=%s\n' "${apalis_owner_database_url}"
  printf 'MNT_APALIS_RUNTIME_DATABASE_URL=%s\n' "${apalis_runtime_database_url}"
  printf 'MNT_APALIS_ADMIN_DATABASE_URL=%s\n' "${database_url}"
} >"${test_env_file}"

# Only a mode-0600 path crosses Buck's test-executor argv. The wrapper parses
# this fixed data file inside the test process without evaluating its contents.
BUCK_ISOLATION_DIR="${isolation_name}" "${buck_bin}" test --local-only "$@" \
  -- --env "MNT_BUCK_POSTGRES_ENV_FILE=${test_env_file}" --env RUST_TEST_THREADS=1
