#!/usr/bin/env bash
# A zero-spend stand-in for `cursor-agent`, for rehearsing `scripts/gate-m13-runtime.mjs`.
#
#   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
#   SLAVEOFAI_CURSOR_BIN="$PWD/scripts/gate-fakes/fake-cursor-agent.sh" \
#   npm run gate:m13-runtime
#
# See `fake-claude.sh`'s header for why this harness lives in the repository (Decision 12) and why
# the gate itself knows nothing about it. Every flag `cursorFlags` emits is ignored except
# `--resume` and `--version`: a fake that could not tell a first spawn from a continuation could not
# rehearse a resume at all, and one that ignored `--version` would replay a whole run into whatever
# cwd the gate's preflight happened to have.
#
# First spawn: a `system`/`init` line, one completed `tool_call` pair, then a poll on
# `SLAVEOFAI_PAUSE_FLAG`. The moment that file exists it emits a REJECTED `tool_call`/`completed`
# line -- the exact shape `scripts/cursor-shell-gate.sh` causes on the real binary
# (`result.rejected.reason`, read back by `cursor/adapter.ts:observeRawLine`) -- and then waits to be
# killed WITHOUT ever writing a `result` line. Both halves matter:
# `recordCursorPauseIfRequested` treats a clean terminal result with nothing denied as a run that
# finished ahead of the pause, so a fake that printed `result` before dying would rehearse the
# opposite of the thing under test.
#
# Resume: init, one tool_call pair, a terminal `result` line, exit 0 -- Cursor reports no cost, so no
# cost field is invented here either.
set -uo pipefail

for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    printf '0.0.0-fake-cursor-agent (M13 gate rehearsal)\n'
    exit 0
  fi
done

session_id=""
resuming=0
prev=""
for arg in "$@"; do
  if [ "$prev" = "--resume" ]; then
    resuming=1
    session_id="$arg"
  fi
  prev="$arg"
done
if [ -z "$session_id" ]; then
  session_id="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || printf 'fake-cursor-%s-%s' "$$" "$(date +%s)")"
fi

flag="${SLAVEOFAI_PAUSE_FLAG:-}"

here="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}" || printf '%s' "${BASH_SOURCE[0]}")")"
if [ "$resuming" = "0" ] && [ -x "${here}/fake-worker-server.sh" ]; then
  # The real binary leaves one of these behind too -- see fake-worker-server.sh.
  setsid "${here}/fake-worker-server.sh" >/dev/null 2>&1 < /dev/null &
fi

emit_init() {
  printf '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"%s","session_id":"%s","model":"fake-cursor","permissionMode":"default"}\n' \
    "$PWD" "$session_id"
}

emit_tool_pair() {
  printf '{"type":"tool_call","subtype":"started","call_id":"%s","tool_call":{"writeToolCall":{"args":{"path":"%s"}},"toolCallId":"%s"}}\n' \
    "$1" "$2" "$1"
  printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"writing %s"}]},"session_id":"%s"}\n' \
    "$2" "$session_id"
  printf '{"type":"tool_call","subtype":"completed","call_id":"%s","tool_call":{"writeToolCall":{"args":{"path":"%s"},"result":{"success":{"isEmpty":false}}},"toolCallId":"%s"}}\n' \
    "$1" "$2" "$1"
}

emit_rejected_shell_call() {
  printf '{"type":"tool_call","subtype":"started","call_id":"%s","tool_call":{"shellToolCall":{"args":{"command":"echo there > world.txt"}},"toolCallId":"%s"}}\n' \
    "$1" "$1"
  printf '{"type":"tool_call","subtype":"completed","call_id":"%s","tool_call":{"shellToolCall":{"args":{"command":"echo there > world.txt"},"result":{"rejected":{"reason":"Command execution was blocked by a hook"}}},"toolCallId":"%s"}}\n' \
    "$1" "$1"
}

emit_result() {
  printf '{"type":"result","subtype":"success","duration_ms":1200,"duration_api_ms":1200,"is_error":false,"result":"done","session_id":"%s"}\n' \
    "$session_id"
}

emit_init
emit_tool_pair "call-${session_id}-1" "hello.txt"
printf 'hi\n' > hello.txt 2>/dev/null || true

if [ "$resuming" = "1" ]; then
  emit_tool_pair "call-${session_id}-2" "world.txt"
  printf 'there\n' > world.txt 2>/dev/null || true
  emit_result
  exit 0
fi

# Wait to be paused, and model what a real slave does when it is: `signalPause('cursor')` writes the
# flag and THEN ends the process, so the flag is already on disk when SIGTERM lands, and whatever
# call the slave had in flight at that moment is what `scripts/cursor-shell-gate.sh` refuses. That
# is the sequence `pause-signal.ts` describes in as many words ("the slave can still start a shell
# command ... writing the flag first closes that window"), and reproducing it here is what makes the
# rehearsal exercise stage 3's "calls were attempted inside the pause window" branch rather than its
# "nothing landed" one.
#
# So: on SIGTERM, if the flag exists, emit one REJECTED tool call and exit -- WITHOUT a `result`
# line. `recordCursorPauseIfRequested` treats a clean terminal result with nothing denied as a run
# that finished ahead of the pause, so printing one here would rehearse the opposite of the thing
# under test.
on_term() {
  if [ -n "$flag" ] && [ -f "$flag" ]; then
    emit_rejected_shell_call "call-${session_id}-gated"
  fi
  exit 0
}
trap on_term TERM INT

# Also polled, for the pause that arrives without a signal reaching this shell first. Bounded, so a
# rehearsal whose pause never arrives ends as a failed wait rather than a hung gate.
i=0
while [ "$i" -lt 3000 ]; do
  sleep 0.02
  i=$(( i + 1 ))
done
exit 0
