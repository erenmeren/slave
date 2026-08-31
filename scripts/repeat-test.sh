#!/usr/bin/env bash
# scripts/repeat-test.sh — run one vitest file (optionally one test) N times, serially,
# stopping at the first failure. One tsc --build up front; the loop itself is pure vitest.
# The serial loop is deliberate: the shared test database allows ONE vitest run at a time.
set -euo pipefail

usage() { echo "usage: repeat-test.sh <N> <test-file> [test-name-pattern]" >&2; exit 2; }
[[ $# -ge 2 ]] || usage
N="$1"; FILE="$2"; NAME="${3-}"

if pgrep -f 'cli.js daemon' > /dev/null 2>&1; then
  echo "refusing to run: an orchestrator daemon is up (it skews the cluster-wide LISTEN count)" >&2
  exit 2
fi

npx tsc --build

for ((i = 1; i <= N; i++)); do
  echo "--- run ${i}/${N}: ${FILE}${NAME:+ -t \"${NAME}\"}"
  start=$(date +%s%3N)
  if [[ -n "${NAME}" ]]; then
    npx vitest run "${FILE}" -t "${NAME}" || { echo "RED on run ${i}/${N}" >&2; exit 1; }
  else
    npx vitest run "${FILE}" || { echo "RED on run ${i}/${N}" >&2; exit 1; }
  fi
  end=$(date +%s%3N)
  echo "--- run ${i}/${N}: GREEN in $((end - start)) ms"
done
echo "GREEN ${N}x"
