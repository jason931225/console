#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
harness="${repo_root}/tools/buck/test_needs_postgres.sh"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/mnt-buck-postgres-test.XXXXXX")"
fake_bin="${scratch}/bin"; log="${scratch}/calls.log"; mkdir -p "${fake_bin}"
trap 'rm -rf "${scratch}"' EXIT
cat >"${fake_bin}/docker" <<'DOCKER'
#!/usr/bin/env bash
{ printf 'docker'; printf ' %q' "$@"; printf '\n'; } >>"${HARNESS_LOG}"
case "$1" in run) echo fake-container;; cp|exec) exit 0;; port) echo 127.0.0.1:49123;; rm) exit 0;; *) exit 1;; esac
DOCKER
cat >"${fake_bin}/openssl" <<'OPENSSL'
#!/usr/bin/env bash
count_file="${HARNESS_LOG}.secrets"; count=0; [[ -f "${count_file}" ]] && count="$(cat "${count_file}")"; count=$((count+1)); printf '%s' "${count}" >"${count_file}"; printf 'secret-%s\n' "${count}"
OPENSSL
cat >"${scratch}/buck" <<'BUCK'
#!/usr/bin/env bash
{ printf 'buck'; printf ' %q' "$@"; printf '\n'; } >>"${HARNESS_LOG}"
env_file=""; for arg in "$@"; do case "${arg}" in MNT_BUCK_POSTGRES_ENV_FILE=*) env_file="${arg#*=}";; esac; done
[[ -f "${env_file}" && "$(stat -f '%Lp' "${env_file}")" == 600 ]]
grep -Fq 'DATABASE_URL=postgres://mnt_buck_admin:' "${env_file}"
grep -Fq 'MNT_APALIS_OWNER_DATABASE_URL=postgres://mnt_app:' "${env_file}"
grep -Fq 'MNT_APALIS_RUNTIME_DATABASE_URL=postgres://mnt_rt:' "${env_file}"
grep -Fq 'MNT_APALIS_ADMIN_DATABASE_URL=postgres://mnt_buck_admin:' "${env_file}"
printf '%s\n' "${env_file}" >>"${HARNESS_LOG}.envfiles"
if [[ "${FAKE_BUCK_SLEEP:-0}" == 1 ]]; then sleep 30; fi
exit "${FAKE_BUCK_STATUS:-0}"
BUCK
chmod +x "${fake_bin}/docker" "${fake_bin}/openssl" "${scratch}/buck"
PATH="${fake_bin}:${PATH}" HARNESS_LOG="${log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" "${harness}" //tools/buck:pr473-ontology-key-revision-postgres
calls="$(cat "${log}")"; buck_calls="$(grep '^buck' "${log}")"
grep -Fq -- '--env-file ' <<<"${calls}"
grep -Fq -- ':/topology.env' <<<"${calls}"
grep -Fq -- 'sh -ceu set\ -a\;\ .\ /topology.env\;\ exec\ bash\ /topology.sh' <<<"${calls}"
grep -Fq -- 'MNT_BUCK_POSTGRES_ENV_FILE=' <<<"${buck_calls}"
! grep -Fq -- 'secret-' <<<"${calls}"
! grep -Fq -- 'postgres://' <<<"${calls}"
while IFS= read -r envfile; do [[ ! -e "${envfile}" ]]; done <"${log}.envfiles"
if PATH="${fake_bin}:${PATH}" HARNESS_LOG="${log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" FAKE_BUCK_STATUS=17 "${harness}" //tools/buck:pr473-ontology-key-revision-postgres; then exit 1; fi
while IFS= read -r envfile; do [[ ! -e "${envfile}" ]]; done <"${log}.envfiles"
# Signal cleanup is registered before any disposable resource is created.
grep -Fq 'trap cleanup EXIT HUP INT TERM' "${harness}"
echo 'test_needs_postgres: PASS'
