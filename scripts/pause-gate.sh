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

# JSON-encodes a single string the same way `node`'s `JSON.stringify` does:
# escapes quotes, backslashes and control characters, passes valid UTF-8
# through unchanged, and never emits a raw newline (control characters come
# back as their two-character escapes, e.g. \n and \t). `node` is a hard
# runtime requirement of this monorepo (root package.json: "engines":
# { "node": ">=26" }) and is therefore guaranteed present on any host able to
# run the orchestrator that spawns this hook -- this adds no dependency the
# way reaching for `jq` would. Piping the reason through a real encoder here,
# rather than hand-rolling `sed`/`printf` escapes for quotes, backslashes,
# newlines, tabs and arbitrary control characters, is the fix: a hand-rolled
# bash escaper is exactly the kind of code that looks right until the one
# input nobody tried breaks it, and a malformed deny is an allow (ADR 0001
# section 7, docs/decisions/0001-pause-semantics.md).
json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

deny() {
  local reason="$1"
  local encoded_reason
  encoded_reason=$(json_string "$reason")
  local encode_status=$?
  if [[ $encode_status -ne 0 || -z "$encoded_reason" ]]; then
    # Cannot encode the reason, so cannot produce a well-formed deny body --
    # refuse to fall through to a bare `exit 0` (which would read as allow)
    # and fail loudly on stderr with exit 2 instead, same as a write failure.
    printf 'pause-gate.sh: failed to JSON-encode the deny reason (node exit %s; reason was: %s)\n' \
      "$encode_status" "$reason" >&2
    exit 2
  fi

  local payload
  payload=$(printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":%s}}' "$encoded_reason")
  # Single printf call, one line, well under PIPE_BUF (4096 bytes on Linux) --
  # writes at this size are atomic to a pipe, so this either delivers the
  # complete deny JSON or none of it; there is no truncated-write case for a
  # payload this short. json_string never introduces a raw newline, so this
  # stays one line regardless of what the reason contains.
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
  # The pause flag's own contents carry the operator-facing deny message --
  # the dynamic reason (a task key, an operator's name, the operator's own
  # free-text message) that ADR 0001 section 7 anticipates a caller will want
  # to supply. This adds no new channel: the flag file already exists per
  # run, is already created at exactly the moment the reason is known (an
  # environment variable fixed at process spawn time cannot carry a reason
  # that is only chosen later, when the operator actually pauses), and the
  # hook already `stat`s it. An empty flag file -- what every caller writes
  # today, and what the pre-flight check's `touch`-equivalent leaves behind
  # -- keeps the original static message, so this is backward compatible
  # with every existing caller.
  #
  # Read byte-for-byte, not stripped: `raw_reason=$(cat "$AITEAMOS_PAUSE_FLAG")`
  # alone would silently drop every trailing newline the file contains, which
  # would mean the operator's message could gain or lose trailing whitespace
  # on the way through depending on how it was written (`printf '%s'` vs.
  # `echo`). The `&& printf x` / `${var%x}` pair is the standard shell
  # sentinel trick for defeating that stripping: append one literal byte
  # after the file's content inside the same command substitution, so
  # whatever trailing newlines the file had are no longer *trailing* (the
  # sentinel is), then peel off exactly that one sentinel byte with a
  # parameter expansion -- not a second command substitution, which would
  # reintroduce the same stripping one layer up.
  raw_reason=$(cat "$AITEAMOS_PAUSE_FLAG" && printf x)
  read_status=$?
  if [[ $read_status -ne 0 ]]; then
    # Cannot read the reason, so cannot produce a well-formed deny body --
    # same class of failure as a write failure, and it gets the same
    # response: fail loudly on stderr, exit 2, never fall through to an
    # exit 0 with no body that would read as allow.
    printf 'pause-gate.sh: failed to read the pause flag file at %s (exit %s)\n' \
      "$AITEAMOS_PAUSE_FLAG" "$read_status" >&2
    exit 2
  fi
  raw_reason=${raw_reason%x}
  deny "${raw_reason:-Paused by AI Team OS. Stop and wait.}"
fi

exit 0
