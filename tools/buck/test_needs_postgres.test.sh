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
case "$1" in
  run) echo fake-container ;;
  cp)
    if [[ "$3" == *:/topology.env ]]; then
      cut -d= -f1 "$2" | sort >"${HARNESS_LOG}.topology-env-keys"
      printf '%s\n' "$2" >"${HARNESS_LOG}.topology-env-file"
    fi
    exit 0 ;;
  exec)
    if [[ " $* " == *" /proc/1/comm "* ]]; then
      if [[ -n "${FAKE_DOCKER_PID1_COMM_SEQUENCE:-}" ]]; then
        attempt_file="${HARNESS_LOG}.pid1-attempt"
        attempt=0; [[ -f "${attempt_file}" ]] && attempt="$(cat "${attempt_file}")"
        attempt=$((attempt + 1)); printf '%s' "${attempt}" >"${attempt_file}"
        IFS=, read -r -a pid1_comms <<<"${FAKE_DOCKER_PID1_COMM_SEQUENCE}"
        index=$((attempt - 1)); (( index < ${#pid1_comms[@]} )) || index=$((${#pid1_comms[@]} - 1))
        printf '%s\n' "${pid1_comms[index]}"
      else
        printf '%s\n' "${FAKE_DOCKER_PID1_COMM:-postgres}"
      fi
      exit 0
    fi
    if [[ " $* " == *" pg_isready "* ]]; then
      exit "${FAKE_DOCKER_READINESS_STATUS:-0}"
    fi
    if [[ " $* " == *" /topology.sh "* ]]; then
      printf 'topology\n' >>"${HARNESS_LOG}"
      exit "${FAKE_DOCKER_EXEC_STATUS:-0}"
    fi
    exit 0 ;;
  port) echo 127.0.0.1:49123 ;;
  rm) exit 0 ;;
  *) exit 1 ;;
esac
DOCKER
cat >"${fake_bin}/openssl" <<'OPENSSL'
#!/usr/bin/env bash
count_file="${HARNESS_LOG}.secrets"; count=0; [[ -f "${count_file}" ]] && count="$(cat "${count_file}")"; count=$((count+1)); printf '%s' "${count}" >"${count_file}"; printf 'secret-%s\n' "${count}"
OPENSSL
cat >"${scratch}/buck" <<'BUCK'
#!/usr/bin/env bash
{ printf 'buck'; printf ' %q' "$@"; printf '\n'; } >>"${HARNESS_LOG}"
printf 'buck-isolation %s\n' "${BUCK_ISOLATION_DIR-<unset>}" >>"${HARNESS_LOG}"
env_file=""; for arg in "$@"; do case "${arg}" in MNT_BUCK_POSTGRES_ENV_FILE=*) env_file="${arg#*=}";; esac; done
[[ -f "${env_file}" && "$(stat -f '%Lp' "${env_file}")" == 600 ]]
grep -Fq 'DATABASE_URL=postgres://mnt_buck_admin:' "${env_file}"
grep -Fq 'MNT_APALIS_OWNER_DATABASE_URL=postgres://mnt_app:' "${env_file}"
grep -Fq 'MNT_APALIS_RUNTIME_DATABASE_URL=postgres://mnt_rt:' "${env_file}"
grep -Fq 'MNT_APALIS_ADMIN_DATABASE_URL=postgres://mnt_buck_admin:' "${env_file}"
printf '%s\n' "${env_file}" >>"${HARNESS_LOG}.envfiles"
if [[ "${FAKE_BUCK_SLEEP:-0}" == 1 ]]; then printf "%s\n" "$$" >"${HARNESS_LOG}.childpid"; exec sleep 30; fi
exit "${FAKE_BUCK_STATUS:-0}"
BUCK
cat >"${fake_bin}/sleep" <<'SLEEP'
#!/usr/bin/env bash
if [[ "${FAKE_SLEEP_INSTANT:-0}" == 1 ]]; then exit 0; fi
exec /bin/sleep "$@"
SLEEP
chmod +x "${fake_bin}/docker" "${fake_bin}/openssl" "${fake_bin}/sleep" "${scratch}/buck"
raw_target_log="${scratch}/raw-target.log"
if PATH="${fake_bin}:${PATH}" HARNESS_LOG="${raw_target_log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" "${harness}" //backend/app:mnt-app-itest-org_change_api; then exit 1; fi
! grep -q '^docker' "${raw_target_log}" 2>/dev/null
! grep -q '^buck' "${raw_target_log}" 2>/dev/null
entrypoint_ready_log="${scratch}/entrypoint-ready.log"
PATH="${fake_bin}:${PATH}" HARNESS_LOG="${entrypoint_ready_log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" FAKE_DOCKER_PID1_COMM_SEQUENCE=docker-entrypoint.sh,postgres FAKE_DOCKER_READINESS_STATUS=0 FAKE_SLEEP_INSTANT=1 "${harness}" //tools/buck:pr473-ontology-key-revision-postgres
[[ "$(grep -c 'cat /proc/1/comm' "${entrypoint_ready_log}")" == 2 ]]
[[ "$(grep -c 'pg_isready -h 127.0.0.1 -U mnt_buck_admin -d ' "${entrypoint_ready_log}")" == 1 ]]
topology_line="$(grep -n '^topology$' "${entrypoint_ready_log}" | cut -d: -f1)"
readiness_line="$(grep -n 'pg_isready -h 127.0.0.1 -U mnt_buck_admin -d ' "${entrypoint_ready_log}" | cut -d: -f1)"
[[ "${topology_line}" -gt "${readiness_line}" ]]
PATH="${fake_bin}:${PATH}" HARNESS_LOG="${log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" "${harness}" //tools/buck:pr473-ontology-key-revision-postgres
calls="$(cat "${log}")"; buck_calls="$(grep '^buck' "${log}")"
grep -Fxq 'buck-isolation <unset>' "${log}"
grep -Fq -- '--env-file ' <<<"${calls}"
grep -Fq -- ':/topology.env' <<<"${calls}"
grep -Fq -- 'sh -ceu set\ -a\;\ .\ /topology.env\;\ exec\ bash\ /topology.sh' <<<"${calls}"
grep -Fq -- 'MNT_BUCK_POSTGRES_ENV_FILE=' <<<"${buck_calls}"
! grep -Fq -- 'secret-' <<<"${calls}"
! grep -Fq -- 'postgres://' <<<"${calls}"
expected_topology_env_keys='MNT_APP_POSTGRES_PASSWORD
MNT_LEAVE_COMMAND_POSTGRES_PASSWORD
MNT_ONTOLOGY_COMMAND_POSTGRES_PASSWORD
MNT_PLATFORM_FORCE_COMMAND_POSTGRES_PASSWORD
MNT_RT_POSTGRES_PASSWORD
POSTGRES_ADMIN_PASSWORD
POSTGRES_ADMIN_USER
POSTGRES_DB
POSTGRES_HOST
POSTGRES_PASSWORD
POSTGRES_PORT
POSTGRES_USER'
[[ "$(cat "${log}.topology-env-keys")" == "${expected_topology_env_keys}" ]]
! grep -Fq 'MNT_PLATFORM_FORCE_COMMAND_PASSWORD' "${log}.topology-env-keys"
while IFS= read -r envfile; do [[ ! -e "${envfile}" ]]; done <"${log}.envfiles"
exact_log="${scratch}/exact.log"
PATH="${fake_bin}:${PATH}" HARNESS_LOG="${exact_log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" MNT_BUCK_NEEDS_POSTGRES_TEST_EXACT=one_exact_test "${harness}" //tools/buck:pr473-ontology-key-revision-postgres
grep -Fq 'MNT_BUCK_RUST_TEST_EXACT=one_exact_test' "${exact_log}"
! grep -Fq -- 'secret-' "${exact_log}"
isolation_log="${scratch}/isolation.log"
PATH="${fake_bin}:${PATH}" HARNESS_LOG="${isolation_log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" MNT_BUCK_NEEDS_POSTGRES_ISOLATION_DIR=postgres-proof "${harness}" //tools/buck:pr473-ontology-key-revision-postgres
grep -Fxq 'buck-isolation postgres-proof' "${isolation_log}"
inherited_isolation_log="${scratch}/inherited-isolation.log"
PATH="${fake_bin}:${PATH}" HARNESS_LOG="${inherited_isolation_log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" BUCK_ISOLATION_DIR=caller-proof "${harness}" //tools/buck:pr473-ontology-key-revision-postgres
grep -Fxq 'buck-isolation caller-proof' "${inherited_isolation_log}"
invalid_isolation_log="${scratch}/invalid-isolation.log"
if PATH="${fake_bin}:${PATH}" HARNESS_LOG="${invalid_isolation_log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" MNT_BUCK_NEEDS_POSTGRES_ISOLATION_DIR='bad isolation' "${harness}" //tools/buck:pr473-ontology-key-revision-postgres; then exit 1; fi
! grep -q '^buck' "${invalid_isolation_log}" 2>/dev/null
if PATH="${fake_bin}:${PATH}" HARNESS_LOG="${exact_log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" MNT_BUCK_NEEDS_POSTGRES_TEST_EXACT='bad test' "${harness}" //tools/buck:pr473-ontology-key-revision-postgres; then exit 1; fi
setup_failure_log="${scratch}/setup-failure.log"
if PATH="${fake_bin}:${PATH}" HARNESS_LOG="${setup_failure_log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" FAKE_DOCKER_EXEC_STATUS=23 "${harness}" //tools/buck:pr473-ontology-key-revision-postgres; then exit 1; fi
grep -Fq 'docker rm -f' "${setup_failure_log}"
! grep -q '^buck' "${setup_failure_log}"
! grep -Fq -- 'secret-' "${setup_failure_log}"
[[ ! -e "$(cat "${setup_failure_log}.topology-env-file")" ]]
if PATH="${fake_bin}:${PATH}" HARNESS_LOG="${log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" FAKE_BUCK_STATUS=17 "${harness}" //tools/buck:pr473-ontology-key-revision-postgres; then exit 1; fi
while IFS= read -r envfile; do [[ ! -e "${envfile}" ]]; done <"${log}.envfiles"
signal_log="${scratch}/signal.log"
PATH="${fake_bin}:${PATH}" HARNESS_LOG="${signal_log}" MNT_BUCK_NEEDS_POSTGRES_TEST_BUCK="${scratch}/buck" FAKE_BUCK_SLEEP=1 "${harness}" //tools/buck:pr473-ontology-key-revision-postgres &
harness_pid=$!
for _ in {1..50}; do [[ -s "${signal_log}.childpid" && -s "${signal_log}.envfiles" ]] && break; sleep 0.1; done
[[ -s "${signal_log}.childpid" && -s "${signal_log}.envfiles" ]]
child_pid="$(cat "${signal_log}.childpid")"
kill -TERM "${harness_pid}"
set +e
wait "${harness_pid}"
signal_status=$?
set -e
[[ "${signal_status}" == 143 ]]
! kill -0 "${child_pid}" 2>/dev/null
while IFS= read -r envfile; do [[ ! -e "${envfile}" ]]; done <"${signal_log}.envfiles"
! grep -Fq -- 'secret-' "${signal_log}"
! grep -Fq -- 'postgres://' "${signal_log}"
echo 'test_needs_postgres: PASS'
