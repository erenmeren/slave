# scripts/lib/pause-flag.sh
# Shared by scripts/pause-gate.sh (Claude's PreToolUse hook) and scripts/cursor-shell-gate.sh
# (Cursor's beforeShellExecution hook). SOURCED, never executed: it defines two functions and sets
# no traps, no options and no exit status of its own. It is deliberately not chmod +x.
#
# The caller must set PAUSE_GATE_NAME to its own script name before calling read_pause_reason --
# every message this file writes to stderr is prefixed with it, so an operator reading stderr knows
# which gate spoke.
#
# WHAT LIVES HERE AND WHAT DOES NOT. The two gates' OUTPUT contracts differ and stay in their own
# files: Claude allows by staying silent and carries its deny reason in
# hookSpecificOutput.permissionDecisionReason; Cursor must emit {"permission":"allow"} out loud
# (it classifies exit 0 with empty stdout as a hook FAILURE) and its operator-message key is
# user_message. That is also why read_pause_reason REPORTS the unset-variable case rather than
# answering it: the answer is a deny payload, and only the caller knows how to spell one.
# What is shared is the part that had drifted: how a string becomes JSON, and how the pause flag
# is interrogated.

# JSON-encodes a single string the way node's JSON.stringify does: escapes quotes, backslashes and
# control characters, passes valid UTF-8 through unchanged, and never emits a raw newline (control
# characters come back as their two-character escapes). `node` is a hard runtime requirement of this
# monorepo (root package.json: "engines": { "node": ">=26" }) and is therefore present on any host
# able to run the orchestrator that spawns this hook, so this adds no dependency the way reaching
# for `jq` would.
#
# THE STRING IS PASSED ON STDIN, NOT AS A node ARGV WORD, and that is the whole reason this
# function is shared rather than copied. An operator-chosen reason beginning with `-` (say,
# `--version` or `-e x`) is otherwise parsed by node ITSELF as an option rather than reaching
# process.argv. Measured against the argv form: `--version` printed node's own version string with
# exit 0 -- a MALFORMED DENY indistinguishable from a well-formed one at the exit-code/stdout-shape
# level -- and `-e x` failed with `bad option`. Piping instead of a `node -- "$1"` end-of-options
# separator also means this never depends on every future call site remembering to add one.
#
# The leading-`"` guard is the second half. A well-formed JSON.stringify of a string always starts
# with `"`; checking that, not just "nonempty", is what catches a future encoder regression (an
# option misparse, a stray diagnostic on stdout) that produces innocuous-looking but non-JSON text
# with node's own exit 0. A malformed deny is an allow (ADR 0001 section 7).
#
# Writes nothing at all on failure, and returns 1: a caller that forgets to check the status still
# cannot build a half-formed deny body out of a partial encoding.
json_string() {
  local encoded
  encoded=$(printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", (c) => { s += c; });
    process.stdin.on("end", () => { process.stdout.write(JSON.stringify(s)); });
  ')
  local status=$?
  if [[ $status -ne 0 || -z "$encoded" || "${encoded:0:1}" != '"' ]]; then
    return 1
  fi
  printf '%s' "$encoded"
  return 0
}

# The operator-facing message, when there is one.
#
# Set by read_pause_reason rather than written to stdout, deliberately: a command substitution
# strips trailing newlines, and the reason must survive byte-for-byte -- neither gaining nor losing
# trailing whitespace depending on how the caller wrote the flag file (`printf '%s'` vs `echo`).
PAUSE_REASON=''

# The message both gates deny with when the flag path was never supplied. UNCHANGED wording, and
# unchanged handling: the caller denies with it at exit 0.
#
# There is deliberately no shared-default fallback path. In an autonomous system running several
# agents concurrently, pause is the operator's only intervention lever: silently falling back to one
# hardcoded path would let pausing one agent inadvertently freeze an unrelated one sharing that
# default, and silently allowing would disable the lever without anyone noticing. Denying loudly,
# naming the misconfiguration, is the least harmful of the three -- it surfaces at the first tool
# call instead of during an incident, and it surfaces IN THE DENY BODY, where the operator watching
# the run is already looking.
PAUSE_FLAG_UNSET_MESSAGE='AITEAMOS_PAUSE_FLAG is unset or empty -- refusing to fall back to a shared default path. Set AITEAMOS_PAUSE_FLAG explicitly for this run before retrying.'

# Interrogates the pause flag. The contract both gates share (M13 section 4.2):
#
#   AITEAMOS_PAUSE_FLAG unset or empty        -> return 2, PAUSE_REASON = PAUSE_FLAG_UNSET_MESSAGE.
#                                                The caller DENIES with it, exit 0. Unchanged from
#                                                M12 on both gates.
#   the path does not exist                   -> return 1. No pause. The ordinary case.
#   the path exists but is not a regular file -> exit 2. NEW in M13: closes M12's deferred "a
#                                                directory is an allow". A gate that allows the
#                                                moment someone mkdirs the flag path has stopped
#                                                gating, and unlike the unset case there is no
#                                                reason to trust that a deny body would even be
#                                                readable -- nothing here can produce one.
#   the path cannot be read                   -> exit 2. Same class as a write failure: we cannot
#                                                produce a well-formed answer, so we must not fall
#                                                through to one that reads as allow. Unchanged from
#                                                M12 on both gates.
#   otherwise                                 -> return 0 with PAUSE_REASON set.
#
# Every exit here is exactly 2 and never any other nonzero status, on BOTH runtimes, and both were
# measured: a Claude PreToolUse hook that exits 2 fails CLOSED while 1, 126 and 127 all fail OPEN;
# a Cursor hook that exits 2 stops the command outright while one that exits 1 with garbage on
# stdout lets it through.
read_pause_reason() {
  local name="${PAUSE_GATE_NAME:-pause gate}"

  if [[ -z "${AITEAMOS_PAUSE_FLAG:-}" ]]; then
    PAUSE_REASON="$PAUSE_FLAG_UNSET_MESSAGE"
    return 2
  fi

  if [[ ! -e "$AITEAMOS_PAUSE_FLAG" ]]; then
    return 1
  fi

  if [[ ! -f "$AITEAMOS_PAUSE_FLAG" ]]; then
    printf '%s: the pause flag path %s exists but is not a regular file. A gate cannot read a pause reason out of it, and allowing on it would silently disarm this run.\n' \
      "$name" "$AITEAMOS_PAUSE_FLAG" >&2
    exit 2
  fi

  # Read byte-for-byte, not stripped: a bare `$(cat ...)` would silently drop every trailing
  # newline the file contains. The `&& printf x` / `${var%x}` pair is the standard shell sentinel
  # trick for defeating that stripping -- append one literal byte after the file's content inside
  # the same command substitution, so whatever trailing newlines the file had are no longer
  # trailing, then peel off exactly that one sentinel byte with a parameter expansion (not a second
  # command substitution, which would reintroduce the same stripping one layer up).
  local raw
  raw=$(cat "$AITEAMOS_PAUSE_FLAG" && printf x)
  local status=$?
  if [[ $status -ne 0 ]]; then
    printf '%s: failed to read the pause flag file at %s (exit %s)\n' "$name" "$AITEAMOS_PAUSE_FLAG" "$status" >&2
    exit 2
  fi
  raw=${raw%x}

  # An empty flag file keeps the static message: that is what every caller wrote before the reason
  # channel existed, and what the pre-flight probe's own `writeFile(flagPath, '')` leaves behind.
  PAUSE_REASON="${raw:-Paused by AI Team OS. Stop and wait.}"
  return 0
}
