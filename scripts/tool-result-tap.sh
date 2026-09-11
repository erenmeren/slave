#!/usr/bin/env bash
# PostToolUse hook (M51 R6). Records ONE bounded line per completed tool call into the run's own
# `tool-results.ndjson`, so the orchestrator can see a tool RESULT even when the stream's own
# `tool_result` line is missing or late.
#
# This is a TAP, not a gate, and every difference follows from that:
#   - It NEVER writes to stdout. A PostToolUse hook's stdout is parsed by the CLI as a hook
#     response; a tap that speaks would be a tap that can change a run.
#   - It ALWAYS exits 0, including on every failure path. `scripts/pause-gate.sh` exits 2 to fail
#     CLOSED because a broken gate must stop the run; a broken tap must not, because the stream
#     already carries the same facts and this only fills a gap (M51 R6: the stream wins).
#   - It records `toolUseId`, `toolName`, `outcome` and `errorClass` and NOTHING else. Never the
#     tool input, never the response body: the event log is not a transcript.
#
# Channel: SLAVEOFAI_TOOL_RESULTS, the absolute path of the run's NDJSON file, set on the child by
# `buildChildEnv` -- the same shape of channel SLAVEOFAI_PAUSE_FLAG and SLAVEOFAI_PERMISSIONS_FILE
# already are, and hooks inherit the child's environment (measured for both gates, M12 Task 11).
# Unset means "this run is not tapped", which is silence and exit 0.
#
# NO SOURCED LIBRARY, unlike both gates. `scripts/lib/pause-flag.sh` and `scripts/lib/permissions.sh`
# are shared BY TWO CALLERS EACH and both of their consumers refuse loudly when the library is
# missing -- a discipline that is exactly wrong here, because a tap that refuses is a tap that
# interferes. One consumer, fail-open, self-contained: the JSON read below is ONE helper
# (`tap_read_payload`) with two implementations inside it, never a second parser inlined at a call
# site, and the classifier is ONE function (`classify_tool_error`) used by both of them.
set -uo pipefail
# NOTE: 'set -e' is deliberately NOT used, for `scripts/pause-gate.sh`'s reason inverted: there,
# a failed printf must not skip an explicit fail-closed exit; here, no failure of any kind may
# produce anything but exit 0, and every exit path below is explicit.

# The C locale, for the whole script and on purpose. A hook is invoked by an external binary in an
# environment this system does not control, and two things below depend on the locale: `${#line}`
# counts CHARACTERS in a UTF-8 locale and BYTES here, which is what the cap below is denominated in
# (fix round 1, review Minor 4); and `${var,,}` lowercases per locale, where the classifier's tokens
# are ASCII and want nothing else. `grep` becomes byte-oriented too, which is both faster and one
# fewer thing that varies between deployments.
export LC_ALL=C

# The longest line this script will append, INCLUDING its newline, in bytes (see the LC_ALL note
# above). A tailer reads this file line by line, so an over-long line is DROPPED rather than cut: a
# cut line is invalid JSON the adapter's tailer would then have to be defensive about, and one
# missing result is a gap the stream already fills.
TAP_LINE_MAX_BYTES=4096

# How much of a failed call's response body is READ (never written) to decide its class. The body
# can be a whole file; the class is one of five tokens.
TAP_ERROR_TEXT_SCAN=2048

# Diagnostics go to stderr and nowhere else -- see the stdout rule above. The CLI shows a hook's
# stderr to nobody by default, which is the right volume for a tap: loud enough to find in a
# transcript, quiet enough never to change a run.
tap_warn() {
  printf 'tool-result-tap.sh: %s\n' "$1" >&2
}

# The SHELL twin of `classifyToolError` (`packages/providers/src/tool-result.ts`), token for token
# and in the same order -- a timeout inside an API call is a timeout. Pinned case by case against
# the TypeScript original by `packages/providers/test/tool-result-tap.test.ts`, the way
# `scripts/lib/permissions.sh` is pinned against `PERMISSION_DENY_REASON_PREFIX`, so neither can
# drift alone.
#
# Reads the JSON-ENCODED error text, not a decoded one: `\n` and `\"` are the only things encoding
# changes, and no token here spans either, so the substring test is the same test on either form
# and the payload never has to be decoded to be classified. ASCII-only lowercasing, which the
# LC_ALL=C above guarantees and which is all these five tokens need.
classify_tool_error() {
  local lower="${1,,}"
  case "$lower" in
    *"timed out"* | *timeout* | *etimedout*) printf 'timeout' ;;
    *"api error"* | *api_error* | *"rate limit"*) printf 'api_error' ;;
    *enoent* | *enotdir* | *"no such file"*) printf 'not_found' ;;
    *eacces* | *eperm* | *"permission denied"*) printf 'permission' ;;
    *) printf 'other' ;;
  esac
}

# The ONE reader of the hook payload, with two implementations and one contract:
#
#   return 0 -> TAP_ID_JSON, TAP_NAME_JSON (both JSON-ENCODED, quotes included), TAP_IS_ERROR
#               (`1`/`0`) and TAP_TEXT_JSON are set.
#   return 1 -> the payload could not be read. The caller warns and exits 0.
#
# The values stay JSON-ENCODED all the way to the output line, which is why this script needs no
# JSON encoder of its own: what came out of a JSON document as a string literal goes back into one
# unchanged. `scripts/lib/pause-flag.sh`'s `json_string` exists because a gate's deny reason is
# built from a FILE's raw bytes; nothing here is.
TAP_ID_JSON=''
TAP_NAME_JSON=''
TAP_IS_ERROR='0'
TAP_TEXT_JSON='""'

tap_read_payload() {
  local payload="$1"
  if command -v node > /dev/null 2>&1; then
    tap_read_payload_node "$payload"
    return $?
  fi
  tap_read_payload_grep "$payload"
  return $?
}

# NODE FED ON STDIN, NEVER ARGV -- `scripts/lib/permissions.sh`'s rationale verbatim: a payload
# beginning with `-` would otherwise be parsed by node itself as an option rather than reaching the
# program. Four lines out, each a JSON scalar and therefore newline-free, so `read` can take them.
tap_read_payload_node() {
  local out
  out=$(printf '%s' "$1" | SLAVEOFAI_TAP_SCAN="$TAP_ERROR_TEXT_SCAN" node -e '
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      let payload;
      try { payload = JSON.parse(raw); } catch { process.exit(3); }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) process.exit(3);
      const id = typeof payload.tool_use_id === "string" ? payload.tool_use_id : "";
      const name = typeof payload.tool_name === "string" ? payload.tool_name : "";
      const response = payload.tool_response;
      const isError =
        response !== null && typeof response === "object" && response.is_error === true;
      let text = "";
      if (isError) {
        const content = response.content;
        // A string body is read as itself; any other shape is serialised only so the classifier
        // has something to match on. Neither ever leaves this process as anything but a class.
        text = typeof content === "string" ? content : content === undefined ? "" : JSON.stringify(content);
      }
      text = text.slice(0, Number(process.env.SLAVEOFAI_TAP_SCAN));
      process.stdout.write(
        JSON.stringify(id) + "\n" + JSON.stringify(name) + "\n" + (isError ? "1" : "0") + "\n" + JSON.stringify(text) + "\n",
      );
    });
  ') || return 1
  { read -r TAP_ID_JSON; read -r TAP_NAME_JSON; read -r TAP_IS_ERROR; read -r TAP_TEXT_JSON; } <<< "$out" || return 1
  return 0
}

# The fallback for a PATH with no `node` on it. BEST-EFFORT and bounded, and said so out loud: it
# reads the first `"key": "value"` pair for each of the names it wants and stops at the first
# unescaped quote, so a tool name containing an escaped quote is read short. That is a degradation
# this script accepts rather than a correctness claim -- the stream carries the same facts, and a
# short name in a gap-filling line costs nothing a run notices.
#
# The CLASS is best-effort in the same way (fix round 1, review Minor 5). The error text is taken
# from the first `"content"` pair AFTER the literal `"tool_response"`, so a `Bash` call whose own
# COMMAND mentions a missing file is not classified `not_found` on the strength of its input -- the
# failure that classifies is the one the runtime reported. Without a parser that scoping is textual
# and can be wrong on a payload that nests `"tool_response"` somewhere unexpected; an unrecognised
# text is `other`, which is the same answer this function gives when it finds nothing at all.
tap_read_payload_grep() {
  local payload="${1:0:$TAP_ERROR_TEXT_SCAN}"
  local id name
  id=$(printf '%s' "$payload" | grep -o '"tool_use_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1)
  name=$(printf '%s' "$payload" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1)
  [[ -n "$id" && -n "$name" ]] || return 1
  # `${var#*:}` -- the FIRST colon, which is the key/value separator, never the last: a value that
  # itself contains a colon (`"tool_use_id":"a:b"`) would otherwise be cut in half. What is left may
  # carry whatever whitespace a pretty-printed payload put after that colon; the value itself is
  # quoted, so trimming to the first quote and putting one back is exact.
  TAP_ID_JSON="${id#*:}"
  TAP_NAME_JSON="${name#*:}"
  TAP_ID_JSON="\"${TAP_ID_JSON#*\"}"
  TAP_NAME_JSON="\"${TAP_NAME_JSON#*\"}"
  if printf '%s' "$payload" | grep -q '"is_error"[[:space:]]*:[[:space:]]*true'; then
    TAP_IS_ERROR='1'
    # Scoped to the RESPONSE half of the payload, never the whole of it -- see the note above. Read,
    # never written: the output line below carries a class and four fields, as always.
    local response="${payload#*\"tool_response\"}"
    local content
    content=$(printf '%s' "$response" | grep -o '"content"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1)
    TAP_TEXT_JSON="${content#*:}"
  else
    TAP_IS_ERROR='0'
    TAP_TEXT_JSON='""'
  fi
  return 0
}

results_path="${SLAVEOFAI_TOOL_RESULTS:-}"
# Unset or empty is "this run is not tapped". Silence, exit 0, and stdin left undrained is fine:
# the CLI closes the pipe.
if [[ -z "$results_path" ]]; then
  exit 0
fi

hook_payload=$(cat)

if ! tap_read_payload "$hook_payload"; then
  tap_warn 'could not read the PostToolUse payload -- no line recorded for this call'
  exit 0
fi

# Both are `z.string().min(1)` on the wire (`run.tool_result`, M51 Task 2), and a result nobody can
# pair back to a call is not a fact the detector can use. Dropped rather than written empty.
if [[ "$TAP_ID_JSON" == '""' || "$TAP_NAME_JSON" == '""' ]]; then
  tap_warn 'the PostToolUse payload named no tool_use_id or no tool_name -- no line recorded'
  exit 0
fi

if [[ "$TAP_IS_ERROR" == '1' ]]; then
  outcome='error'
  error_class="\"$(classify_tool_error "$TAP_TEXT_JSON")\""
else
  outcome='ok'
  error_class='null'
fi

line=$(printf '{"toolUseId":%s,"toolName":%s,"outcome":"%s","errorClass":%s}' \
  "$TAP_ID_JSON" "$TAP_NAME_JSON" "$outcome" "$error_class")

# Bytes, including the newline `printf` adds below -- LC_ALL=C above is what makes `${#line}` count
# them (fix round 1, review Minor 4).
if (( ${#line} + 1 > TAP_LINE_MAX_BYTES )); then
  tap_warn "the line for this call was $(( ${#line} + 1 )) bytes, past the ${TAP_LINE_MAX_BYTES}-byte cap -- dropped rather than truncated"
  exit 0
fi

# `>>`, which opens the file O_APPEND: every write starts at the current end of file, atomically,
# so two hooks firing at once cannot interleave half a line into the middle of the other's. (It is
# O_APPEND that gives that, not PIPE_BUF -- that constant governs pipes, and this is a regular
# file.) One `printf`, one line, bounded above. A failed append is a gap the stream fills, and
# still exit 0.
if ! printf '%s\n' "$line" >> "$results_path"; then
  tap_warn "could not append to ${results_path} -- no line recorded for this call"
fi

exit 0
