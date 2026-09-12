# scripts/lib/permissions.sh
# Shared by scripts/pause-gate.sh (Claude's PreToolUse hook) and scripts/cursor-shell-gate.sh
# (Cursor's beforeShellExecution / preToolUse hooks). SOURCED, never executed, mirroring
# scripts/lib/pause-flag.sh's own conventions exactly: it defines one function, sets no traps, no
# options and no exit status of its own, and is deliberately not chmod +x (mode 0644).
#
# THE FILE IS THE WHOLE VERDICT (M52 R2). SLAVEOFAI_PERMISSIONS_FILE points at `permissions.json`
# v2, written once per start/resume by the orchestrator (packages/control's writePermissionsFile)
# into the run's own scratch directory, OUTSIDE the repository the worker edits:
#
#   {"version":2,
#    "runId":"<uuid>",
#    "tokenHash":"<sha256 hex of this spawn's SLAVEOFAI_RUN_TOKEN>",
#    "enforce":"all-tools"|"known-tools",
#    "grants":["read_repo","write_repo","run_commands"],
#    "allow":[{"tool":"Read","kind":"read_repo"}, ...],
#    "vocabulary":{"Read":"read_repo","Bash":"run_commands", ...},
#    "prefixes":[{"prefix":"mcp__","kind":"network_fetch"}]}
#
# It says five things and this library needs all five: what this run may call (`allow`), which
# operation governs each tool (`vocabulary`, and `prefixes` for the name families nobody can
# enumerate), which operations were granted (`grants` -- the decision is the KIND's, so ONE
# `network_fetch` grant opens every `mcp__*` tool rather than the two the allow list can name),
# how much of it this provider can enforce (`enforce`), and WHICH RUN the verdict is about
# (`tokenHash`). This library stays a dumb membership test with no table of its own: every word it
# compares against comes out of the file (spec section 2, plan decisions D10/D11).
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
# below reads that key directly. That same fixture's `preToolUse` lines are ALSO what
# `cursor-shell-gate.sh` receives, unmodified -- Cursor's tool_name there is "Read"/"Shell"/
# "Write" (Claude-shaped casing), which never matches the resolved Cursor vocabulary of lowercase
# `read`/`edit`/`shell`. Under M18's denylist that mismatch was inert. Under an ALLOW list it
# would deny every tool call Cursor makes, so M52 states the measurement in DATA instead of
# leaving it to a casing accident: the file's `enforce` word is `known-tools` for Cursor, and a
# name its vocabulary does not know is allowed there (plan erratum E3). Cursor's `preToolUse` tool
# identity is still untrustworthy for enforcement -- a stated v1 limitation, now stated in the
# matrix copy and in the file rather than only in this comment.
#
# Cursor's `beforeShellExecution` payload (the OTHER hook `cursor-shell-gate.sh` gates on) carries
# NO `tool_name` key at all -- confirmed against the same fixture's line 5: only `command`, `cwd`,
# `sandbox`, `session_id`, `hook_event_name` and workspace/user fields, no tool identity of any
# kind. `read_permission_verdict`'s optional second argument, `default_tool`, is Task 4's
# accommodation for exactly that shape: the caller (a gate) may pass a fallback tool name, used
# ONLY when the payload has no `tool_name` string AND does carry a `command` string of its own --
# the shape unique to `beforeShellExecution`. `cursor-shell-gate.sh` passes `'shell'` on every
# call, unconditionally; the shape guard below is what keeps that inert for every OTHER
# tool_name-less payload (Claude's own Stop/SessionStart hooks, a malformed payload) so those are
# never silently reattributed to a fabricated tool identity. That rule is UNCHANGED by M52 -- only
# the verdict on the other side of it inverted. This is the one place Cursor's key/shape differs
# enough to need a second key at all -- still one helper, never a fork.
#
# NODE FED ON STDIN, NEVER ARGV -- pause-flag.sh's json_string rationale applies identically here:
# an operator-influenced payload string beginning with `-` would otherwise be parsed by node ITSELF
# as an option rather than reaching the script. One node invocation reads BOTH the captured hook
# payload (stdin) and the permissions file (read from disk inside the same process, path via
# SLAVEOFAI_PERMISSIONS_FILE) so this stays a single subprocess spawn per tool call -- and that ONE
# process now also answers "is this verdict about this child" (M52 R4), which needs no database and
# no second spawn because the hash is in the file and the plaintext is in this process's
# environment.
#
# IDENTITY, NOT A PATH (M52 R4). SLAVEOFAI_RUN_TOKEN is 32 random bytes minted at spawn, put in
# exactly one child's environment and written down nowhere: the row and the file hold only its
# sha256. Pointing SLAVEOFAI_PERMISSIONS_FILE at a SIBLING run's verdict therefore buys nothing --
# the sibling's `tokenHash` will not match this child's token, and the mismatch fails closed. In
# the same milestone the run directory left the repository the worker edits, so no repo-scoped
# delete, `git clean` or branch switch can reach a verdict any more. The two locks are independent
# on purpose, and neither is a sandbox: see the exit-2 arm below for what a worker CAN still do.

PERMISSION_DENY_TOOL=''
PERMISSION_DENY_CAPABILITY=''

# read_permission_verdict "$payload" ["$default_tool"]
#   Contract (M52 R2 -- the INVERSE of M18's, arm for arm):
#     return 0 -> DENY. PERMISSION_DENY_TOOL and PERMISSION_DENY_CAPABILITY are set; the caller
#                 spells the deny body. Covers: a tool whose governing kind is not among the file's
#                 `grants` (the capability is that kind); a tool no kind governs, under
#                 `enforce: all-tools` (capability `ungoverned_tool`); and a payload that names no
#                 tool at all under the same enforcement (tool `unknown`). All three are refused
#                 CALLS on a run that keeps going -- exit 0 with a deny body -- because a PreToolUse
#                 payload this gate cannot read is not a broken gate (M52 erratum E8).
#     return 1 -> ALLOW. Covers exactly four things: the tool is on the `allow` list; the kind that
#                 governs the tool (by name, or by one of the file's `prefixes`) is among `grants`;
#                 SLAVEOFAI_PERMISSIONS_FILE is UNSET, which means this process is not a governed
#                 run at all (an operator running the gate by hand, and `preflightGate`, which
#                 spawns this script twice on every spawn and requires the disarmed direction to
#                 allow -- erratum E1); and, under `enforce: known-tools`, a tool name the file's
#                 vocabulary does not know, which is Cursor's measured limitation (the header
#                 above) stated in data rather than left to a casing accident.
#     exit 2    -> FAIL CLOSED, i.e. the run stops. The file is armed and cannot be read as a
#                 verdict: missing, unreadable, malformed, not version 2, no `allow` array, no
#                 `grants` array, no `tokenHash`; the payload is not JSON at all; or the identity
#                 does not match -- SLAVEOFAI_RUN_TOKEN's sha256 is not the file's `tokenHash`. A
#                 run that deletes its own permissions file no longer disarms itself: it stops, and
#                 M52 R4 moved the directory out of the worktree so that no repo-scoped delete can
#                 do it by accident.
#
#   WHAT THIS FILE DOES NOT PROTECT AGAINST, stated plainly because this comment is the threat
#   model of record. A worker granted `run_commands` holds the absolute path (its own
#   SLAVEOFAI_PERMISSIONS_FILE) and the plaintext token (its own SLAVEOFAI_RUN_TOKEN) and runs
#   under the uid that owns the 0700 directory, so it can WRITE a fresh v2 body granting itself
#   all six kinds with a `tokenHash` it computes from its own token, and this gate will read that
#   as a valid verdict about itself. Only a boundary the child does not hold can close that -- a
#   separate uid or sandbox, which this milestone does not build. So: THE FILE GATE IS A GUARD
#   AGAINST ACCIDENT AND AGAINST A SIBLING, NOT AGAINST A DETERMINED WORKER. The thing that is
#   authoritative is the database: the broker (M52 Task 3) authorises every brokered operation
#   against `SlaveRun.runTokenHash` on the row, never against this file, and the worker's OWN
#   PROCESS has no DATABASE_URL to reach that row with (`CHILD_ENV_ALLOW`, M52 R3). Said exactly,
#   because the shorter sentence was false (M52 final review, Important 3): the verify and setup
#   commands a project defines still run with the DAEMON's whole environment, and they run scripts
#   out of the worktree the worker just wrote -- so a worker that edits `package.json` reaches a
#   process that does hold `DATABASE_URL`. An allow-listed verify/setup environment is the next
#   boundary and it is backlogged, not built.
read_permission_verdict() {
  PERMISSION_DENY_TOOL=''
  PERMISSION_DENY_CAPABILITY=''
  local default_tool="${2:-}"
  if [[ -z "${SLAVEOFAI_PERMISSIONS_FILE:-}" ]]; then
    return 1  # not a governed run at all (an operator, a pre-flight): allow
  fi
  local verdict
  verdict=$(printf '%s' "$1" | SLAVEOFAI_PERMISSIONS_FILE="$SLAVEOFAI_PERMISSIONS_FILE" SLAVEOFAI_DEFAULT_TOOL="$default_tool" node -e '
    const crypto = require("node:crypto");
    let raw = "";
    process.stdin.on("data", (c) => { raw += c; });
    process.stdin.on("end", () => {
      let payload, file;
      try { payload = JSON.parse(raw); } catch { process.stdout.write("BADPAYLOAD"); return; }
      try { file = JSON.parse(require("node:fs").readFileSync(process.env.SLAVEOFAI_PERMISSIONS_FILE, "utf8")); }
      catch { process.stdout.write("BADFILE"); return; }

      // 1. IS THIS A VERDICT AT ALL. A version-1 file is a pre-M52 snapshot, i.e. a stale verdict,
      // and a stale verdict is not believed. Everything this arm rejects used to ALLOW.
      if (file === null || typeof file !== "object") { process.stdout.write("BADFILE"); return; }
      if (file.version !== 2) { process.stdout.write("BADFILE"); return; }
      const allow = Array.isArray(file.allow) ? file.allow : null;
      if (allow === null) { process.stdout.write("BADFILE"); return; }
      // The granted KIND set. Required, not defaulted to empty: a file with no `grants` key is a
      // writer this gate does not recognise, and guessing "nothing is granted" for it would turn a
      // shape disagreement into a run that is silently refused everything.
      const grants = Array.isArray(file.grants) ? file.grants : null;
      if (grants === null) { process.stdout.write("BADFILE"); return; }
      const vocabulary = file.vocabulary !== null && typeof file.vocabulary === "object" ? file.vocabulary : {};
      const prefixes = Array.isArray(file.prefixes) ? file.prefixes : [];
      const enforce = file.enforce === "known-tools" ? "known-tools" : "all-tools";

      // 2. IS THIS VERDICT ABOUT THIS CHILD (M52 R4). The hash is on the file and the plaintext is
      // in the environment of this process, so pointing SLAVEOFAI_PERMISSIONS_FILE at the verdict
      // of a sibling run buys nothing: that hash will not match the token this child holds.
      // `timingSafeEqual` over equal-length buffers, with the length guard first -- it THROWS on a
      // length mismatch, and a thrown comparison would exit nonzero with no message.
      const expected = typeof file.tokenHash === "string" ? file.tokenHash : "";
      const token = process.env.SLAVEOFAI_RUN_TOKEN || "";
      const actual = token === "" ? "" : crypto.createHash("sha256").update(token).digest("hex");
      if (expected.length !== 64 || actual.length !== 64 ||
          !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) {
        process.stdout.write("BADIDENTITY"); return;
      }

      // 3. WHAT IS THIS CALL. Unchanged from M18, including the non-object guard and the
      // `default_tool` shape rule -- see the paragraphs above, which still describe it exactly.
      const isObject = payload !== null && typeof payload === "object";
      let tool = isObject && typeof payload.tool_name === "string" ? payload.tool_name : null;
      const defaultTool = process.env.SLAVEOFAI_DEFAULT_TOOL || "";
      if (tool === null && defaultTool !== "" && isObject && typeof payload.command === "string") {
        tool = defaultTool;
      }

      if (tool !== null && allow.some((entry) => entry && entry.tool === tool)) {
        process.stdout.write("ALLOW"); return;
      }
      // 4. WHICH OPERATION GOVERNS IT. The table first, then the prefix families the table cannot
      // enumerate (`mcp__*` -- one server an operator installs tomorrow is governed with no table
      // edit, M52 erratum E16), then nothing.
      let kind = null;
      if (tool !== null) {
        if (Object.prototype.hasOwnProperty.call(vocabulary, tool)) {
          kind = String(vocabulary[tool]);
        } else {
          for (const entry of prefixes) {
            if (entry && typeof entry.prefix === "string" && entry.prefix !== "" && tool.startsWith(entry.prefix)) {
              kind = String(entry.kind); break;
            }
          }
        }
      }
      // THE VERDICT LINE IS TAB-DELIMITED AND ONE OF ITS FIELDS COMES FROM THE PAYLOAD (M52 final
      // review, Important 2 -- MEASURED). The caller splits this line with `cut -f2`/`cut -f3`, so
      // a `tool_name` carrying a TAB shifts the fields and lets the caller choose the CAPABILITY
      // recorded against it: `{"tool_name":"Bash\tdeploy_release"}` yielded
      // PERMISSION_DENY_CAPABILITY=deploy_release -- a kind no vendor tool can ever produce, which
      // is how a worker would manufacture the denial evidence a `request_permission` proposal is
      // built on. A newline would end the line entirely. Every field is stripped of the three
      // characters that mean something to the format, including `kind`: the vocabulary it comes
      // from is read out of a file the worker can write (erratum E17), so it is no more trusted
      // than the payload. Stripped rather than escaped, because nothing downstream unescapes.
      const field = (value) => String(value).replace(/[\t\n\r]/g, "");
      if (kind !== null) {
        // The decision belongs to the KIND, which is what makes ONE `network_fetch` grant open
        // every `mcp__*` tool rather than only the two an enumerable allow list can name.
        if (grants.includes(kind)) { process.stdout.write("ALLOW"); return; }
        process.stdout.write("DENY\t" + field(tool) + "\t" + field(kind)); return;
      }
      // Ungoverned, or unnamed. On Cursor (`known-tools`) that is the measured limitation and it
      // allows; on Claude it is the class an allow list exists to close.
      if (enforce === "known-tools") { process.stdout.write("ALLOW"); return; }
      process.stdout.write("DENY\t" + (tool === null ? "unknown" : field(tool)) + "\tungoverned_tool");
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
    BADIDENTITY)
      printf '%s: this run'"'"'s identity does not match the permissions file it was given\n' "$PAUSE_GATE_NAME" >&2
      exit 2 ;;
    BADFILE)
      printf '%s: permissions file unreadable, malformed, or not a version-2 verdict: %s\n' "$PAUSE_GATE_NAME" "$SLAVEOFAI_PERMISSIONS_FILE" >&2
      exit 2 ;;
    *)
      printf '%s: permission verdict helper produced an unrecognized answer\n' "$PAUSE_GATE_NAME" >&2
      exit 2 ;;
  esac
}
