#!/usr/bin/env bash
# scripts/census-runtime.sh — proves each block consolidated by M13 Series B still has exactly
# one definition site. A re-export (`export { x } from`) is not a definition and will not match.
# Known intentional non-entry: each gate's ~10-line library-bootstrap block
# (pause-gate.sh / cursor-shell-gate.sh) is the code that FINDS the shared library and is
# intrinsically unsharable; it defines no function and so needs no exception below.
set -euo pipefail
cd "$(dirname -- "$0")/.."
fail=0

check_one() { # regex, expected-single-file
  local pattern="$1" expected="$2" hits
  hits=$(grep -rln --include='*.ts' -E "$pattern" packages/providers/src packages/control/src packages/events/src apps/orchestrator/src 2>/dev/null | sort | tr '\n' ' ' | sed 's/ $//')
  if [[ "$hits" != "$expected" ]]; then
    echo "CENSUS FAIL: pattern '$pattern'" >&2
    echo "  defined in: ${hits:-<nowhere>}" >&2
    echo "  expected  : $expected" >&2
    fail=1
  fi
}

check_one '^export class AsyncEventQueue'                          'packages/providers/src/runtime/event-queue.ts'
check_one '^export (async )?function terminateChild'               'packages/providers/src/runtime/process.ts'
check_one '^export (async )?function killWithEscalation'           'packages/providers/src/runtime/process.ts'
check_one '^export (async )?function clearAndVerifyPauseFlagAbsent' 'packages/providers/src/runtime/pause-flag.ts'
check_one '^export function isRecord'                              'packages/providers/src/runtime/summary.ts'
# `claude/flags.ts` also defines a `preflightGate` — a deliberate Claude-shaped wrapper (M13) that
# calls the runtime one below with Claude's own preflight inputs, not a second implementation of it.
check_one '^export (async )?function preflightGate'                'packages/providers/src/claude/flags.ts packages/providers/src/runtime/gate-preflight.ts'
check_one '^export (async )?function runGateScript'                'packages/providers/src/runtime/gate-preflight.ts'
check_one '^export function buildChildEnv'                         'packages/providers/src/runtime/process.ts'
check_one '^export function summaryFor'                            'packages/providers/src/runtime/summary.ts'
check_one 'const KILL_GRACE_MS = '                                 'packages/providers/src/runtime/process.ts'

json_defs=$(grep -rln '^json_string()' scripts | sort | tr '\n' ' ' | sed 's/ $//')
if [[ "$json_defs" != "scripts/lib/pause-flag.sh" ]]; then
  echo "CENSUS FAIL: json_string() defined in: ${json_defs:-<nowhere>} (expected only scripts/lib/pause-flag.sh)" >&2
  fail=1
fi

if [[ $fail -eq 0 ]]; then echo "census clean: one definition site per consolidated block"; fi
exit $fail
