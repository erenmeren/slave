# scripts/lib/permissions.sh
# Shared by scripts/pause-gate.sh (Claude's PreToolUse hook) and scripts/cursor-shell-gate.sh
# (Cursor's beforeShellExecution / preToolUse hooks). SOURCED, never executed, mirroring
# scripts/lib/pause-flag.sh's own conventions exactly: it defines one function, sets no traps, no
# options and no exit status of its own, and is deliberately not chmod +x (mode 0644).
#
# The permission matrix's resolved deny list lives in the file AITEAMOS_PERMISSIONS_FILE points at
# -- {"version":1,"deny":[{"tool":"Bash","capability":"run tests"}]} -- written once per
# start/resume by the orchestrator (Task 5) with the RESOLVED vendor-tool names for that run's
# provider (packages/control's permission.ts does the capability -> tool resolution
# orchestrator-side; this library stays a dumb membership test, spec section 2). This library
# answers "does this hook payload's tool appear on it".
#
# REPORT, DON'T PRINT -- pause-flag.sh's rule, inherited here on purpose. The two gates' output
# shapes differ (Claude allows by staying silent and denies via hookSpecificOutput.
# permissionDecisionReason; Cursor must emit {"permission":...} out loud and uses a different
# operator-message key), so read_permission_verdict only sets out-params and returns/exits a
# status; it never writes a deny body itself. Only the caller (the gate) knows how to spell one.
#
# Deny reasons the gates build from these out-params MUST begin with the exact prefix
# 'permission matrix denies' -- packages/providers/src/gate.ts's PERMISSION_DENY_REASON_PREFIX is
# the TS twin, and packages/control/test/permission-mapping.test.ts pins this file's spelling
# against that constant byte-equal, so neither can drift alone.
#
# PAYLOAD KEY, MEASURED, NOT ASSUMED. Claude's PreToolUse hook stdin payload carries the tool name
# under `tool_name` -- confirmed against packages/providers/test/fixtures/cursor/gate/
# run-1-hook.log's real captured hook stdin (`"tool_name":"Read"`, `"tool_name":"Shell"`) and
# against the M18 design doc's own measurement (docs/superpowers/specs/
# 2026-08-31-m18-skill-and-teeth-design.md section 2: "Claude: tool_name"). The node one-liner
# below reads that key directly. Cursor's `beforeShellExecution` payload (the shape
# cursor-shell-gate.sh actually gates on) carries NO `tool_name` key at all -- Task 4 extends this
# same one-liner with Cursor's own key/shape rather than forking a second helper, per this file's
# one-library discipline; until Task 4 lands, a Cursor beforeShellExecution payload falls into the
# "no tool_name" branch below and allows.
#
# NODE FED ON STDIN, NEVER ARGV -- pause-flag.sh's json_string rationale applies identically here:
# an operator-influenced payload string beginning with `-` would otherwise be parsed by node ITSELF
# as an option rather than reaching the script. One node invocation reads BOTH the captured hook
# payload (stdin) and the permissions file (read from disk inside the same process, path via
# AITEAMOS_PERMISSIONS_FILE) so this stays a single subprocess spawn per tool call.

PERMISSION_DENY_TOOL=''
PERMISSION_DENY_CAPABILITY=''

# read_permission_verdict "$payload"
#   Contract (mirrors pause-flag.sh's report-don't-print shape):
#     return 0 -> DENY. PERMISSION_DENY_TOOL and PERMISSION_DENY_CAPABILITY are set to the
#                 matched deny row; the caller spells the deny body.
#     return 1 -> ALLOW. Covers: AITEAMOS_PERMISSIONS_FILE unset or the file does not exist
#                 (pre-M18 runs, rehearsals -- no matrix in play at all); the payload has no
#                 `tool_name` (Claude Stop/SessionStart hooks, Cursor's beforeShellExecution
#                 pre-Task-4 -- only a payload that is not JSON at all fails closed, per this
#                 file's own design note above); the tool is present but not on the deny list;
#                 an empty deny list.
#     exit 2    -> FAIL CLOSED. The payload did not parse as JSON while a permissions file is
#                 armed, or the permissions file itself is missing-but-unreadable or malformed
#                 (not valid JSON, or its `deny` key is not an array). A gate cannot produce a
#                 well-formed answer in either case, so it must not fall through to one that
#                 reads as allow -- same doctrine as pause-flag.sh's own unreadable-file case.
read_permission_verdict() {
  PERMISSION_DENY_TOOL=''
  PERMISSION_DENY_CAPABILITY=''
  if [[ -z "${AITEAMOS_PERMISSIONS_FILE:-}" || ! -e "${AITEAMOS_PERMISSIONS_FILE:-/nonexistent}" ]]; then
    return 1  # no matrix in play (pre-M18 runs, rehearsals): allow
  fi
  local verdict
  verdict=$(printf '%s' "$1" | AITEAMOS_PERMISSIONS_FILE="$AITEAMOS_PERMISSIONS_FILE" node -e '
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      let payload, file;
      try { payload = JSON.parse(raw); } catch { process.stdout.write("BADPAYLOAD"); return; }
      try { file = JSON.parse(require("node:fs").readFileSync(process.env.AITEAMOS_PERMISSIONS_FILE, "utf8")); } catch { process.stdout.write("BADFILE"); return; }
      const tool = typeof payload.tool_name === "string" ? payload.tool_name : null;
      const deny = Array.isArray(file.deny) ? file.deny : null;
      if (deny === null) { process.stdout.write("BADFILE"); return; }
      if (tool === null) { process.stdout.write("ALLOW"); return; }
      const hit = deny.find((d) => d && d.tool === tool && typeof d.capability === "string");
      process.stdout.write(hit ? "DENY\t" + hit.tool + "\t" + hit.capability : "ALLOW");
    });
  ')
  local status=$?
  if [[ $status -ne 0 ]]; then
    printf '%s: permission verdict helper failed (node exit %s)\n' "$PAUSE_GATE_NAME" "$status" >&2
    exit 2
  fi
  case "$verdict" in
    ALLOW) return 1 ;;
    DENY$'\t'*)
      PERMISSION_DENY_TOOL=$(printf '%s' "$verdict" | cut -f2)
      PERMISSION_DENY_CAPABILITY=$(printf '%s' "$verdict" | cut -f3)
      return 0 ;;
    BADPAYLOAD)
      printf '%s: hook payload did not parse as JSON while a permissions file is armed\n' "$PAUSE_GATE_NAME" >&2
      exit 2 ;;
    BADFILE)
      printf '%s: permissions file unreadable or malformed: %s\n' "$PAUSE_GATE_NAME" "$AITEAMOS_PERMISSIONS_FILE" >&2
      exit 2 ;;
    *)
      printf '%s: permission verdict helper produced an unrecognized answer\n' "$PAUSE_GATE_NAME" >&2
      exit 2 ;;
  esac
}
