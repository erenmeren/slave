#!/usr/bin/env bash
# A zero-spend stand-in for the real `claude` CLI, for rehearsing `scripts/gate-m13-runtime.mjs`.
#
#   AITEAMOS_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
#   AITEAMOS_CURSOR_BIN="$PWD/scripts/gate-fakes/fake-cursor-agent.sh" \
#   npm run gate:m13-runtime
#
# M13 Decision 12 makes "rehearses against fake CLIs before the first paid execution" a standing
# property of this gate, not a one-time act by whoever first wrote it -- so the harness lives in the
# repository next to the gate. It is reached ONLY through the `AITEAMOS_*_BIN` overrides the
# orchestrator already honours (`apps/orchestrator/src/cli.ts:162,178`): the gate itself has no
# fixture mode, no skip and no test-only flag, and does not know this file exists.
#
# NOT `packages/providers/test/fake-claude.mjs`, which replays a fixed fixture and needs a
# `--fixture` flag the adapter never passes. Rehearsing this gate needs something a recording cannot
# be: a child that reacts to the pause flag LIVE. Every stage here turns on the ordering between an
# operator's pause and the child's next tool call, and a pre-recorded stream has no such ordering to
# get right.
#
# What it does:
#   - answers `--version` and nothing else, because the gate's preflight records both binaries'
#     versions before it does anything;
#   - emits a real-shaped `system`/`init` line carrying a session id (a fresh uuid, or the one
#     `--resume` names, exactly as the real CLI reports the same id back on a resume);
#   - walks a few "tool calls", each an `assistant` tool_use line, a `PreToolUse` `hook_response`
#     and a `user` tool_result echo, writing a real file into cwd (the run's worktree);
#   - POLLS `AITEAMOS_PAUSE_FLAG` between calls. The moment that file exists it emits the
#     deny-shaped `hook_response` `scripts/pause-gate.sh` really emits, then goes silent and waits
#     to be killed -- which is what the real CLI does when its gate denies a call;
#   - IGNORES SIGTERM, as the real `claude` does (M5's live-gate finding, quoted in `pump.ts`), so
#     the rehearsal exercises `killWithEscalation`'s full grace window and its SIGKILL. Decision 1
#     says `paused` is published only once the child is dead; a fake that exited politely on SIGTERM
#     would make that window disappear and rehearse nothing;
#   - leaves a detached `fake-worker-server.sh` behind (see that file) so the gate's stray sweep is
#     exercised on every rehearsal;
#   - on a run that is never paused, emits a terminal `result` line carrying a cost, then exits 0.
set -uo pipefail

for arg in "$@"; do
  if [ "$arg" = "--version" ]; then
    printf '0.0.0-fake-claude (M13 gate rehearsal)\n'
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
  session_id="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || printf 'fake-claude-%s-%s' "$$" "$(date +%s)")"
fi

flag="${AITEAMOS_PAUSE_FLAG:-}"
# Fewer steps on a resume: the resumed run has to REACH `succeeded`, and every extra step is another
# window in which something could interrupt it.
if [ "$resuming" = "1" ]; then steps=2; else steps=8; fi
gap_ms="${FAKE_CLAUDE_STEP_GAP_MS:-700}"

trap '' TERM INT

here="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}" || printf '%s' "${BASH_SOURCE[0]}")")"
if [ "$resuming" = "0" ] && [ -x "${here}/fake-worker-server.sh" ]; then
  setsid "${here}/fake-worker-server.sh" >/dev/null 2>&1 < /dev/null &
fi

emit_init() {
  printf '{"type":"system","subtype":"init","cwd":"%s","session_id":"%s","model":"fake-claude","permissionMode":"bypassPermissions"}\n' \
    "$PWD" "$session_id"
}

emit_tool_use() {
  printf '{"type":"assistant","message":{"model":"fake-claude","id":"msg_%s","type":"message","role":"assistant","content":[{"type":"tool_use","id":"%s","name":"Write","input":{"file_path":"%s","content":"hi\\n"}}]},"session_id":"%s"}\n' \
    "$1" "$1" "$2" "$session_id"
}

emit_hook_allow() {
  printf '{"type":"system","subtype":"hook_response","hook_id":"hook-%s","hook_name":"PreToolUse:Write","hook_event":"PreToolUse","output":"","stdout":"","stderr":"","exit_code":0,"outcome":"success","session_id":"%s"}\n' \
    "$1" "$session_id"
}

# The deny payload `scripts/pause-gate.sh` writes, in the double-encoded shape the real CLI reports
# it in: `output` is a JSON-encoded STRING, needing a second parse to reach the decision (spec
# §5.3's first trap, and `packages/providers/src/claude/stream.ts:extractDenyReason` is what reads
# it back).
emit_hook_deny() {
  local encoded='{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"Paused by AI Team OS. Stop and wait.\"}}'
  printf '{"type":"system","subtype":"hook_response","hook_id":"hook-%s","hook_name":"PreToolUse:Write","hook_event":"PreToolUse","output":"%s","stdout":"%s","stderr":"","exit_code":0,"outcome":"success","session_id":"%s"}\n' \
    "$1" "$encoded" "$encoded" "$session_id"
}

emit_tool_result() {
  printf '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"%s","content":"%s","is_error":%s}]},"session_id":"%s"}\n' \
    "$1" "$2" "$3" "$session_id"
}

paused_now() {
  [ -n "$flag" ] && [ -f "$flag" ]
}

# Polls the flag for the whole inter-call gap rather than sleeping through it, so the pause is
# noticed within one poll interval instead of one whole step.
wait_gap_or_pause() {
  local slices=$(( gap_ms / 50 ))
  [ "$slices" -lt 1 ] && slices=1
  local i=0
  while [ "$i" -lt "$slices" ]; do
    if paused_now; then return 0; fi
    sleep 0.05
    i=$(( i + 1 ))
  done
  paused_now
}

emit_init

step=1
while [ "$step" -le "$steps" ]; do
  tool_use_id="toolu_fake_$(printf '%s' "$session_id" | cut -c1-8)_${step}"
  if wait_gap_or_pause; then
    emit_tool_use "$tool_use_id" "denied-${step}.txt"
    emit_hook_deny "$tool_use_id"
    emit_tool_result "$tool_use_id" "Paused by AI Team OS. Stop and wait." "true"
    # Silent from here, and still alive: the pump writes the checkpoint and kills the child.
    sleep 600
    exit 0
  fi
  file="fake-claude-${step}.txt"
  emit_tool_use "$tool_use_id" "$file"
  emit_hook_allow "$tool_use_id"
  printf 'hi\n' > "$file" 2>/dev/null || true
  emit_tool_result "$tool_use_id" "File created successfully at: ${file}" "false"
  step=$(( step + 1 ))
done

printf '{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","stop_reason":"end_turn","num_turns":%s,"total_cost_usd":0.0123,"permission_denials":[],"session_id":"%s"}\n' \
  "$steps" "$session_id"
printf '{"type":"system","subtype":"hook_response","hook_id":"stop-hook","hook_name":"Stop","hook_event":"Stop","output":"","stdout":"","stderr":"","exit_code":1,"outcome":"cancelled","session_id":"%s"}\n' \
  "$session_id"
exit 0
