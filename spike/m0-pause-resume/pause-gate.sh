#!/usr/bin/env bash
# PreToolUse hook. Blocks the pending tool call when the pause flag file exists.
# The orchestrator sets the flag, observes the block in the event stream, then
# terminates the process.
#
# Exit-code / output contract (see section 3 of the M0 pause/resume findings
# doc for the empirical evidence behind this and its limits):
#   - Allow:  exit 0, empty stdout.
#   - Deny:   exit 0, stdout is a single-line JSON object with
#             hookSpecificOutput.permissionDecision == "deny". Deny is carried
#             entirely in the JSON body, not the exit code -- both allow and
#             deny exit 0 in every capture gathered for this spike.
#   - Write failure / crash: exit 2, human-readable reason on stderr. This is
#     a deliberate fallback to Claude Code's documented general hook exit-code
#     convention (0 = success, 2 = blocking error read from stderr, other
#     nonzero = non-blocking warning). This spike never captured a real
#     crash/nonzero-exit hook_response, so this path is inferred from that
#     general convention, not empirically confirmed by this spike's runs --
#     flagged here and in the findings doc rather than asserted as tested.
set -uo pipefail
# NOTE: 'set -e' is deliberately NOT used. With -e, a failed printf (e.g. a
# broken stdout pipe, disk full on a redirected capture) would abort the
# script before its own exit statement ran, leaving the script's exit status
# to whatever printf happened to return -- neither a clean allow (exit 0,
# empty stdout) nor a well-formed deny (exit 0, deny JSON). Every exit path
# below is explicit instead, so a write failure cannot produce an undefined,
# half-delivered response.

deny() {
  local reason="$1"
  local payload
  payload=$(printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$reason")
  # Single printf call, one line, well under PIPE_BUF (4096 bytes on Linux) --
  # writes at this size are atomic to a pipe, so this either delivers the
  # complete deny JSON or none of it; there is no truncated-write case for a
  # payload this short.
  if printf '%s\n' "$payload"; then
    exit 0
  fi
  # The write itself failed. We cannot deliver the deny JSON body, so refuse
  # to exit 0 with no body (which would read as allow) -- fail loudly on
  # stderr and exit 2 instead.
  printf 'pause-gate.sh: failed to write deny payload (reason was: %s)\n' "$reason" >&2
  exit 2
}

cat > /dev/null   # drain the hook payload on stdin

# AITEAMOS_PAUSE_FLAG unset or empty is a configuration error, not "no pause
# requested" -- there is deliberately no shared-default fallback path. In an
# autonomous system running several agents concurrently, pause is the
# operator's only intervention lever: silently falling back to a single
# hardcoded path would let pausing one agent inadvertently freeze an
# unrelated one sharing that default, and silently allowing would disable the
# intervention lever without anyone noticing. Denying loudly, naming the
# misconfiguration, is the least harmful of the three -- it surfaces at the
# first tool call instead of during an incident.
if [[ -z "${AITEAMOS_PAUSE_FLAG:-}" ]]; then
  deny "AITEAMOS_PAUSE_FLAG is unset or empty -- refusing to fall back to a shared default path. Set AITEAMOS_PAUSE_FLAG explicitly for this run before retrying."
fi

if [[ -f "$AITEAMOS_PAUSE_FLAG" ]]; then
  deny "Paused by AI Team OS. Stop and wait."
fi

exit 0
