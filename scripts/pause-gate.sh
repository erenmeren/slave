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
#   - Write failure / crash: exit 2, human-readable reason on stderr. M3 Task
#     1 (docs/superpowers/spikes/2026-08-18-m3-hook-failure-modes.md, "Q7"/
#     "Q9") measured this directly against a real `claude` run: a PreToolUse
#     hook that exits 2 fails CLOSED -- the tool call does not run -- while
#     exit codes 1, 126 and 127 all fail OPEN, letting the tool run as if
#     nothing had happened. Every failure path in this script must therefore
#     exit 2 and never any other nonzero status; see
#     docs/decisions/0001-pause-semantics.md.
#   - Flag path present but not a readable regular file: exit 2, reason on
#     stderr. A directory (or an unreadable file) at the flag path is a broken
#     configuration, not "no pause requested"; M13 section 4.2 closes what M12
#     deferred, for both gates at once.
set -uo pipefail
# NOTE: 'set -e' is deliberately NOT used. With -e, a failed printf (e.g. a
# broken stdout pipe, disk full on a redirected capture) would abort the
# script before its own exit statement ran, leaving the script's exit status
# to whatever printf happened to return -- neither a clean allow (exit 0,
# empty stdout) nor a well-formed deny (exit 0, deny JSON), and possibly not
# the fail-closed exit 2 either. Every exit path below is explicit instead,
# so a write failure cannot produce an undefined, half-delivered response,
# and every one of them lands on exactly exit 0 or exit 2 -- never exit 1
# and never anything else.

# The JSON encoder and the pause-flag read are shared with scripts/cursor-shell-gate.sh -- one
# encoder, one flag contract, two output shapes. See scripts/lib/pause-flag.sh. Sourced by a path
# derived from this script's own location (symlinks resolved), because a hook is invoked by an
# external binary with no guarantee about cwd, and a failure to source it is fail-closed like every
# other failure here.
PAUSE_GATE_NAME='pause-gate.sh'
# `readlink -f` first, so a hook DEPLOYED AS A SYMLINK into this repo still finds its sibling: the
# library lives next to the real script, not next to the link. Linux coreutils is the deployment
# target, and a `readlink` that fails falls back to the unresolved path rather than to nothing.
PAUSE_GATE_LIB_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}" || printf '%s' "${BASH_SOURCE[0]}")")"
# shellcheck source=lib/pause-flag.sh
. "${PAUSE_GATE_LIB_DIR}/lib/pause-flag.sh" || {
  # A lone copy of this script -- an AITEAMOS_HOOK_PATH override pointing at a deployment that
  # copied the gate without its library -- must refuse loudly and actionably rather than silently
  # gating nothing. Naming the exact path we looked for is what makes it fixable at a glance.
  printf 'pause-gate.sh: deployed without its library -- expected to find it at %s. Copy scripts/lib/pause-flag.sh alongside this script (in a lib/ directory beside it), or point AITEAMOS_HOOK_PATH at the repository'"'"'s own scripts/pause-gate.sh.\n' \
    "${PAUSE_GATE_LIB_DIR}/lib/pause-flag.sh" >&2
  exit 2
}

# Fails loudly on stderr and exits 2 -- the measured fail-closed exit code for a PreToolUse hook.
# Used for every case where this script cannot produce a well-formed answer, so that "the gate
# broke" can never be mistaken for "the gate allowed". Writes nothing to stdout: an exit 0 with no
# body is exactly what an allow looks like.
fail_closed() {
  printf 'pause-gate.sh: %s\n' "$1" >&2
  exit 2
}

deny() {
  local reason="$1"
  local encoded_reason
  encoded_reason=$(json_string "$reason") || fail_closed "failed to JSON-encode the deny reason (reason was: ${reason})"

  local payload
  payload=$(printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}' "$encoded_reason")
  # Single printf call, one line, well under PIPE_BUF (4096 bytes on Linux) -- writes at this size
  # are atomic to a pipe, so this either delivers the complete deny JSON or none of it. json_string
  # never introduces a raw newline, so this stays one line regardless of what the reason contains.
  if printf '%s\n' "$payload"; then
    exit 0
  fi
  fail_closed "failed to write the deny payload (reason was: ${reason})"
}

cat > /dev/null   # drain the hook payload on stdin

read_pause_reason
pause_status=$?
case $pause_status in
  # An operator asked. The flag file's own contents carry the message.
  0) deny "$PAUSE_REASON" ;;
  # No flag path was supplied. Denied loudly, in the deny BODY, at exit 0 -- unchanged from M12,
  # and the reason the shared helper reports this case rather than answering it: only this file
  # knows how Claude spells a deny.
  2) deny "$PAUSE_REASON" ;;
esac

# Status 1: no pause requested. Claude's allow is silence.
exit 0
