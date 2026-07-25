#!/usr/bin/env bash
# Execute a Buck-built integration-test binary after loading the disposable
# PostgreSQL credentials from the harness-owned mode-0600 environment file.
set -euo pipefail

env_file="${MNT_BUCK_POSTGRES_ENV_FILE:?Buck PostgreSQL environment file is required}"
if [[ ! -f "${env_file}" ]]; then
  echo "buck-postgres: environment file is not a regular file" >&2
  exit 1
fi
if [[ "$(stat -f '%Lp' "${env_file}")" != "600" ]]; then
  echo "buck-postgres: environment file must be mode 0600" >&2
  exit 1
fi
# The harness writes only fixed keys and generated hex credentials.  Keep the
# secrets out of Buck's argv and load them only inside this test process.
set -a
# shellcheck disable=SC1090
source "${env_file}"
set +a
exec "$@"
