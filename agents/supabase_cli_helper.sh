#!/usr/bin/env bash

# Wrapper to ensure the Supabase CLI (or any postgres tooling) runs with the
# test credentials defined in .env.supabase.test.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SUPABASE_ENV_FILE:-${SCRIPT_DIR}/.env.supabase.test}"

if [[ ! -f "${ENV_FILE}" ]]; then
  cat <<EOF
Missing Supabase env file at ${ENV_FILE}.
Copy agents/.env.supabase.test.example to agents/.env.supabase.test,
fill it with non-production credentials, and re-run:

  cp agents/.env.supabase.test.example agents/.env.supabase.test
  \$EDITOR agents/.env.supabase.test
  SUPABASE_ENV_FILE=${ENV_FILE} $0 <supabase args>
EOF
  exit 1
fi

# Load env vars and export them for child processes.
set -o allexport
source "${ENV_FILE}"
set +o allexport

if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI is not installed or not on PATH."
  echo "Install via https://supabase.com/docs/guides/cli/getting-started before continuing."
  exit 1
fi

if [[ $# -eq 0 ]]; then
  echo "No Supabase CLI arguments supplied. Showing current status:"
  supabase status
else
  supabase "$@"
fi
