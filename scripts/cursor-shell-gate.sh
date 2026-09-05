#!/usr/bin/env bash
# `cursor-agent` gate hook, registered under BOTH `beforeShellExecution` and a
# matcher-less `preToolUse` (see `buildCursorHooks` in
# `packages/providers/src/cursor/hooks.ts`, which writes both entries pointing
# at this one script). Blocks the pending call when the pause flag file exists.
# The orchestrator sets the flag, then terminates the process; this gate is what
# stops the worker writing in the window between those two moments.
#
# THE `preToolUse` HALF IS THE LOAD-BEARING ONE. `beforeShellExecution` sees
# shell commands only; `preToolUse` fires for EVERY tool, and it is what carries
# this runtime's `gate: 'all-tools'` capability. Task 9's recording shows a file
# WRITE stopped at a `preToolUse` invocation arriving with `"tool_name":"Read"`
# under the edit call's `tool_use_id` -- so a `^(Write|Shell)$` matcher, which
# reads as an obviously safe narrowing, would have let that exact write through.
# Never add a matcher to the `preToolUse` registration. The
# `beforeShellExecution` entry is kept alongside it deliberately: two
# independent chances to refuse the one call class that can do the most damage.
#
# It is the Cursor half of the same mechanism `scripts/pause-gate.sh` is the
# Claude half of, and it reads the SAME file: one concept, one environment
# variable (`SLAVEOFAI_PAUSE_FLAG`), one pause-flag path per run, whichever
# runtime that run happens to be using.
#
# ---------------------------------------------------------------------------
# Exit-code / output contract. MEASURED against the installed binary
# (`cursor-agent` 2026.08.11-e8db854) in Task 11's R5 run 1, not taken from
# vendor documentation:
#
#   - Allow:  exit 0, stdout `{"permission":"allow"}`.
#   - Deny:   exit 0, stdout a single-line JSON object with
#             `permission == "deny"`. Deny is carried entirely in the JSON
#             body, not the exit code -- both allow and deny exit 0.
#   - Failure to produce either: exit 2, human-readable reason on stderr.
#   - Flag path present but not a readable regular file: exit 2, reason on
#     stderr. A directory (or an unreadable file) at the flag path is a broken
#     configuration, not "no pause requested"; M13 section 4.2 closes what M12
#     deferred, for both gates at once -- the same clause `pause-gate.sh`'s
#     header carries, because the read is now literally the same code
#     (`read_pause_reason` in `scripts/lib/pause-flag.sh`).
#
# Three of those clauses differ from Claude's, and each difference was measured:
#
# 1. AN ALLOW MUST SAY SO OUT LOUD. `pause-gate.sh` allows by staying silent;
#    doing that here would be a latent disaster. Cursor classifies a hook that
#    exits 0 with empty stdout as a hook FAILURE, not as an allow (it is the
#    `empty_stdout` error class in the binary, alongside `spawn_error`,
#    `timeout`, `exit_nonzero` and `invalid_json`). Under the `failClosed: true`
#    hooks.json entry this gate is meant to be registered with -- see below --
#    every one of those failure classes is converted into a BLOCK. A silent
#    allow would therefore block every tool call of every run while looking
#    like a correctly installed gate.
#
# 2. EXIT 2 IS CURSOR'S BLOCKING EXIT CODE TOO, and it blocks whether or not
#    `failClosed` is set. Measured directly: within one recorded run, a hook
#    that exited 2 stopped the command outright (the file it would have created
#    does not exist), while a hook that exited 1 with garbage on stdout let the
#    command through untouched (the file exists). So every failure path in this
#    script exits exactly 2 and never any other nonzero status -- the same rule
#    `pause-gate.sh` follows for the same measured reason. When a hook exits 2,
#    Cursor builds the operator-facing block reason from the hook's stdout if
#    there is any and from its stderr otherwise, which is why the failure paths
#    below write a reason to stderr and nothing at all to stdout.
#
# 3. THE OPERATOR MESSAGE KEY IS `user_message`, snake_case. The binary reads
#    `response.user_message`; its own response validator accepts exactly
#    `permission`, `user_message` and `agent_message`. A camelCase
#    `userMessage` is simply not read -- the command would still be denied, but
#    the operator's message would be dropped in silence.
#
# THIS SCRIPT IS ONLY HALF THE GATE. It must be registered in the run
# worktree's `.cursor/hooks.json` (which `cursor-agent` reads from the
# workspace -- measured) as:
#
#   {"version":1,"hooks":{
#     "beforeShellExecution":[
#       {"command":"/abs/path/cursor-shell-gate.sh","failClosed":true}],
#     "preToolUse":[
#       {"command":"/abs/path/cursor-shell-gate.sh","failClosed":true}]}}
#
# -- both entries, the same command, and NO `matcher` key on the `preToolUse`
# one, for the reason given at the top of this header.
#
# `failClosed: true` is not decoration. Without it, a hook that crashes, times
# out, produces no output or produces unparseable output FAILS OPEN -- Cursor
# runs the command as if no gate existed. That is the exact failure this
# milestone cannot tolerate: the system would believe a paused run is
# contained while it keeps writing. Writing that file is the adapter's job, not
# this script's.
# ---------------------------------------------------------------------------
set -uo pipefail
# NOTE: 'set -e' is deliberately NOT used, for the reason spelled out at length
# in scripts/pause-gate.sh: with -e, a failed printf (a broken stdout pipe,
# disk full on a redirected capture) would abort the script before its own exit
# statement ran, leaving the exit status to whatever printf happened to return
# -- neither a well-formed allow, nor a well-formed deny, nor the fail-closed
# exit 2. Every exit path below is explicit instead, and every one of them
# lands on exactly 0 or 2.

# The JSON encoder and the pause-flag read live in scripts/lib/pause-flag.sh, shared with
# scripts/pause-gate.sh: one encoder, one flag contract, two output shapes. Piping the reason
# through a real encoder, rather than hand-rolling `sed`/`printf` escapes for quotes, backslashes,
# newlines, tabs and arbitrary control characters, is the whole point: a hand-rolled bash escaper is
# exactly the kind of code that looks right until the one input nobody tried breaks it, and here a
# malformed deny is WORSE than in Claude's gate. Cursor's parser is lenient -- it retries a failed
# parse by scanning backwards for the last `{` that parses -- so a broken escape does not reliably
# produce a parse error that `failClosed` would convert into a block; it can just as easily produce
# a well-formed object that is missing the `permission` key, which reads as an allow. The shared
# encoder also carries M12's fix for the leading-`-` argv hole (the reason goes in on stdin, never
# as a `node` argv word) and the leading-`"` guard that catches an encoder regression.
#
# Sourced by a path derived from this script's own location, symlinks resolved: a hook is invoked
# by `cursor-agent` with no guarantee about cwd, and a failure to source it is fail-closed like
# every other failure.
PAUSE_GATE_NAME='cursor-shell-gate.sh'
# `readlink -f` first, so a gate DEPLOYED AS A SYMLINK into this repo still finds its sibling: the
# library lives next to the real script, not next to the link. Linux coreutils is the deployment
# target, and a `readlink` that fails falls back to the unresolved path rather than to nothing.
PAUSE_GATE_LIB_DIR="$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}" || printf '%s' "${BASH_SOURCE[0]}")")"
# shellcheck source=lib/pause-flag.sh
. "${PAUSE_GATE_LIB_DIR}/lib/pause-flag.sh" || {
  # A lone copy of this script -- an SLAVEOFAI_CURSOR_GATE_PATH override pointing at a deployment
  # that copied the gate without its library -- must refuse loudly and actionably rather than
  # silently gating nothing. Naming the exact path we looked for is what makes it fixable at a
  # glance, and stderr is where Cursor reads an exit-2 block reason from.
  printf 'cursor-shell-gate.sh: deployed without its library -- expected to find it at %s. Copy scripts/lib/pause-flag.sh alongside this script (in a lib/ directory beside it), or point SLAVEOFAI_CURSOR_GATE_PATH at the repository'"'"'s own scripts/cursor-shell-gate.sh.\n' \
    "${PAUSE_GATE_LIB_DIR}/lib/pause-flag.sh" >&2
  exit 2
}
# scripts/lib/permissions.sh -- M18's permission-matrix check, shared with scripts/pause-gate.sh
# (Task 3). Same bootstrap dir, same fail-loudly posture as the pause-flag source above: a
# deployment that copied this script without its second library must refuse rather than silently
# skip the matrix.
# shellcheck source=lib/permissions.sh
. "${PAUSE_GATE_LIB_DIR}/lib/permissions.sh" || {
  printf 'cursor-shell-gate.sh: deployed without its library -- expected to find it at %s. Copy scripts/lib/permissions.sh alongside this script (in a lib/ directory beside it), or point SLAVEOFAI_CURSOR_GATE_PATH at the repository'"'"'s own scripts/cursor-shell-gate.sh.\n' \
    "${PAUSE_GATE_LIB_DIR}/lib/permissions.sh" >&2
  exit 2
}

# Fails loudly on stderr and exits 2 -- Cursor's blocking exit code. Used for
# every case where this script cannot produce a well-formed answer, so that
# "the gate broke" can never be mistaken for "the gate allowed". Deliberately
# writes NOTHING to stdout: on exit 2 Cursor prefers stdout as the block reason
# and falls back to stderr, so leaving stdout empty is what puts this message
# in front of the operator.
fail_closed() {
  printf 'cursor-shell-gate.sh: %s\n' "$1" >&2
  exit 2
}

deny() {
  local reason="$1"
  local encoded_reason
  encoded_reason=$(json_string "$reason") || fail_closed "failed to JSON-encode the deny reason (reason was: ${reason})"

  local payload
  payload=$(printf '{"permission":"deny","user_message":%s}' "$encoded_reason")
  # Single printf call, one line, well under PIPE_BUF -- atomic to a pipe at this size, and
  # json_string never introduces a raw newline, so this stays one line whatever the reason holds.
  if printf '%s\n' "$payload"; then
    exit 0
  fi
  fail_closed "failed to write the deny payload (reason was: ${reason})"
}

allow() {
  # See clause 1 of the contract above: silence here would be read as a hook
  # failure, not as an allow.
  if printf '%s\n' '{"permission":"allow"}'; then
    exit 0
  fi
  fail_closed 'failed to write the allow payload'
}

# Captured, not drained: the permission matrix's verdict (below) needs the payload's tool
# identity. read_permission_verdict only parses it when SLAVEOFAI_PERMISSIONS_FILE is armed --
# it returns allow instantly otherwise -- so this costs nothing on the pre-M18 path.
hook_payload=$(cat)

read_pause_reason
pause_status=$?
case $pause_status in
  # An operator asked. The flag file's own contents carry the message.
  0) deny "$PAUSE_REASON" ;;
  # Unchanged from M12: no flag path is a deny with a body, at exit 0, not a hook failure.
  2) deny "$PAUSE_REASON" ;;
  # No pause requested. The ONLY status that reaches the permission-matrix check and the allow
  # below, and it says so explicitly rather than by falling out of the `esac`, so that the
  # catch-all beneath it cannot swallow it.
  1) ;;
  # Every other status is a gate that broke in a way this file does not enumerate, and it must fail
  # closed like every other failure here. The status that makes this arm load-bearing is 127: a
  # library that is PRESENT and parses but defines nothing (an empty file, a copy truncated at a
  # function boundary) sources cleanly, so the missing-library refusal above never fires, and
  # `read_pause_reason` is simply an unknown command. Without this arm that fell through to `allow`, emitting an explicit
  # {"permission":"allow"} -- a truncated library silently disarmed the run.
  *) fail_closed "read_pause_reason returned an unexpected status ${pause_status}" ;;
esac

# Only status 1 (no pause requested) reaches here. Pause always wins: an operator's pause is
# checked first, above, and this permission-matrix check never runs while a pause is armed --
# `deny` above already exited the whole script.
#
# 'shell' is passed as `default_tool` on EVERY call, whichever of this gate's two hook
# registrations fired. read_permission_verdict's own shape guard (scripts/lib/permissions.sh)
# is what makes that inert except for the one shape it is meant for: Cursor's
# `beforeShellExecution` payload, measured (fixtures/cursor/gate/run-1-hook.log line 5) to carry
# a top-level `command` string and NO tool-identity key at all. This gate's `preToolUse`
# registration -- the one that fires for every OTHER tool, per the header above -- always carries
# `tool_name` in the same fixture, so `default_tool` never substitutes there.
#
# CAVEAT (measured, header :11-14 of this file): Cursor's `preToolUse` `tool_name` is NOT
# trustworthy for write/read discrimination -- a file WRITE was captured arriving with
# `"tool_name":"Read"`. This gate does not attempt to correct that here; it is spec section 2's
# stated v1 limitation ("Cursor caveat"), not a bug this task fixes. Shell enforcement via
# `beforeShellExecution` (the `default_tool` fallback above) is the reliable half; non-shell
# enforcement on Cursor stays best-effort.
if read_permission_verdict "$hook_payload" 'shell'; then
  deny "permission matrix denies '${PERMISSION_DENY_CAPABILITY}' (${PERMISSION_DENY_TOOL}) for this agent"
fi

# No pause requested, and the tool is not matrix-denied. Cursor's allow must say so OUT LOUD --
# silence here is read as a hook failure, which `failClosed: true` converts into a block on every
# tool call of every run.
allow
