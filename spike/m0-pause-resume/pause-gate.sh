#!/usr/bin/env bash
# PreToolUse hook. Blocks the pending tool call when the pause flag file exists.
# The orchestrator sets the flag, observes the block in the event stream, then
# terminates the process. Contract: exit 0 = allow, structured deny = pause.
set -euo pipefail

FLAG="${AITEAMOS_PAUSE_FLAG:-/tmp/aiteamos-pause.flag}"

cat > /dev/null   # drain the hook payload on stdin

if [[ -f "$FLAG" ]]; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Paused by AI Team OS. Stop and wait."}}'
  exit 0
fi

exit 0
