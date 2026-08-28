#!/usr/bin/env bash
# `beforeShellExecution` hook for `cursor-agent`. Blocks the pending shell
# command when the pause flag file exists. The orchestrator sets the flag, then
# terminates the process; this gate is what stops the worker writing in the
# window between those two moments.
#
# It is the Cursor half of the same mechanism `scripts/pause-gate.sh` is the
# Claude half of, and it reads the SAME file: one concept, one environment
# variable (`AITEAMOS_PAUSE_FLAG`), one pause-flag path per run, whichever
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
#   {"version":1,"hooks":{"beforeShellExecution":[
#     {"command":"/abs/path/cursor-shell-gate.sh","failClosed":true}]}}
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

# JSON-encodes a single string the way `node`'s `JSON.stringify` does: escapes
# quotes, backslashes and control characters, passes valid UTF-8 through
# unchanged, and never emits a raw newline. `node` is a hard runtime
# requirement of this monorepo (root package.json: "engines": {"node": ">=26"})
# and is therefore present on any host able to run the orchestrator that spawns
# this hook, so this adds no dependency the way reaching for `jq` would.
#
# Piping the reason through a real encoder, rather than hand-rolling
# `sed`/`printf` escapes for quotes, backslashes, newlines, tabs and arbitrary
# control characters, is the whole point: a hand-rolled bash escaper is exactly
# the kind of code that looks right until the one input nobody tried breaks it,
# and here a malformed deny is WORSE than in Claude's gate. Cursor's parser is
# lenient -- it retries a failed parse by scanning backwards for the last `{`
# that parses -- so a broken escape does not reliably produce a parse error
# that `failClosed` would convert into a block; it can just as easily produce a
# well-formed object that is missing the `permission` key, which reads as an
# allow.
json_string() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
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
  encoded_reason=$(json_string "$reason")
  local encode_status=$?
  if [[ $encode_status -ne 0 || -z "$encoded_reason" ]]; then
    fail_closed "failed to JSON-encode the deny reason (node exit ${encode_status}; reason was: ${reason})"
  fi

  local payload
  payload=$(printf '{"permission":"deny","user_message":%s}' "$encoded_reason")
  # Single printf call, one line, well under PIPE_BUF (4096 bytes on Linux) --
  # writes at this size are atomic to a pipe, so this either delivers the
  # complete deny JSON or none of it. json_string never introduces a raw
  # newline, so this stays one line regardless of what the reason contains.
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

cat > /dev/null   # drain the hook payload on stdin

# AITEAMOS_PAUSE_FLAG unset or empty is a configuration error, not "no pause
# requested" -- there is deliberately no shared-default fallback path, exactly
# as in pause-gate.sh. In an autonomous system running several agents
# concurrently, pause is the operator's only intervention lever: silently
# falling back to a single hardcoded path would let pausing one agent
# inadvertently freeze an unrelated one sharing that default, and silently
# allowing would disable the intervention lever without anyone noticing.
# Denying loudly, naming the misconfiguration, is the least harmful of the
# three -- it surfaces at the first shell command instead of during an incident.
if [[ -z "${AITEAMOS_PAUSE_FLAG:-}" ]]; then
  deny "AITEAMOS_PAUSE_FLAG is unset or empty -- refusing to fall back to a shared default path. Set AITEAMOS_PAUSE_FLAG explicitly for this run before retrying."
fi

if [[ -f "$AITEAMOS_PAUSE_FLAG" ]]; then
  # The pause flag's own contents carry the operator-facing deny message, the
  # same channel pause-gate.sh uses: the flag file already exists per run, is
  # created at exactly the moment the reason is known (an environment variable
  # fixed at process spawn time cannot carry a reason chosen later, when the
  # operator actually pauses), and this hook already stats it. An empty flag
  # file keeps the static message below.
  #
  # Read byte-for-byte, not stripped: a bare `$(cat ...)` would silently drop
  # every trailing newline, so the operator's message could gain or lose
  # trailing whitespace depending on how it was written (`printf '%s'` vs
  # `echo`). The `&& printf x` / `${var%x}` pair is the standard shell sentinel
  # trick for defeating that stripping -- append one literal byte inside the
  # same command substitution so the file's own trailing newlines are no longer
  # trailing, then peel exactly that byte off with a parameter expansion.
  raw_reason=$(cat "$AITEAMOS_PAUSE_FLAG" && printf x)
  read_status=$?
  if [[ $read_status -ne 0 ]]; then
    # Cannot read the reason, so cannot produce a well-formed deny body -- same
    # class of failure as a write failure, and it gets the same response.
    fail_closed "failed to read the pause flag file at ${AITEAMOS_PAUSE_FLAG} (exit ${read_status})"
  fi
  raw_reason=${raw_reason%x}
  deny "${raw_reason:-Paused by AI Team OS. Stop and wait.}"
fi

allow
