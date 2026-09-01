# Provider stream fixtures: what each one is, and where it came from

Every file here is a captured `stream-json` transcript, with no exceptions: the parsers under
`packages/providers/src` are written **from recordings**, never from documentation (the M12
discipline), and these files are the recordings. There is no hand-authored JSON in this directory.
There was exactly one — `permission-matrix-deny.ndjson`, written by hand in M18 because no build of
the CLI able to produce a matrix-denied `PreToolUse` response existed to record from yet — and M19
Task A1 replaced it with the genuine capture (its own section below carries the provenance).

## Layout, and why it is not flat

```
fixtures/
  *.ndjson          replay modes for the fake CLI  -- `fake-claude.mjs --fixture <basename>`
  claude/           Claude recordings that are NOT replay modes
  cursor/           Cursor recordings
```

**The top level is a namespace, not a folder.** `fake-claude.mjs` resolves `--fixture <name>` to
`fixtures/<name>.ndjson`, so every `*.ndjson` sitting directly in this directory is a selectable
mode of the fake CLI — and `fake-claude.test.ts`'s "every fixture file ends with the routine Stop
hook line" enumerates exactly that directory and holds all of them to the shape a replayable
transcript needs. A recording that is only ever read by a parser test does not belong to that
namespace and cannot always satisfy that invariant (see `claude/README.md` for the one that
cannot), so it goes in a subdirectory — the same reason `cursor/` is one.

`readdir` here is not recursive, so subdirectories are outside the invariant by construction.

## `claude/` — parser recordings

See `claude/README.md`. Currently one file: `skill-tool-use.ndjson`, the `Skill` tool_use
recording made for M14 §4.1.

## `cursor/` — Cursor recordings

- `cursor/cursor-run.ndjson` — the M12 `cursor-agent` capture that `cursor-stream.test.ts` and
  `cursor-adapter.test.ts` read.
- `cursor/gate/` — the M13 Task 9 pause-gate evidence, six files from two `cursor-agent` runs.
  Its own `README.md` carries the full provenance, the redaction, and the spend, and is the shape
  every README in this tree follows.

## The fake-CLI replay modes

These are the M3/M8 captures, plus one M19 capture made under this README's own rules (see its own
section below the table). Provenance for the twelve M3/M8 captures below is reconstructed from the
files themselves and from `git log` — they predate this README, and no contemporaneous recording
note was written for them, which is precisely the gap this file and `claude/README.md` exist to
close going forward. Everything stated here is checkable against the bytes on disk.

Facts common to the twelve M3/M8 recordings (`permission-matrix-deny.ndjson` is a separate,
later capture and shares none of them — see its own section):
`claude_code_version` **2.1.234**, `model` `claude-opus-5[1m]`, and a `cwd` of
`/fake/claude-workdir/<mode>` with a `session_id` of `fake-session-<mode>` — i.e. the workdir and
session identifiers were rewritten to fixture-scoped placeholders at capture time. Note that the
`init` line's `plugins[].path` and `memory_paths` were **not** rewritten and still carry the
recording operator's home directory; `claude/skill-tool-use.ndjson` redacts those, and these files
should be brought in line the next time they are touched.

| File | Introduced | What it records |
| --- | --- | --- |
| `complete.ndjson` | `b17561c` | The clean run: `Write` then `Bash`, both `PreToolUse` hooks allowing, `result` `is_error: false`, 3 turns, $0.209. The baseline every other mode is read against. |
| `crash.ndjson` | `b17561c` | Byte-identical in shape to `complete`; the *crash* is produced at replay time, by `fake-claude.mjs` writing only the first half of the lines and exiting 1. Truncating the file itself would have made the fixture a lie about what the CLI emitted. |
| `hook-deny.ndjson` | `b17561c` | The pause: `Read` allowed, then `Edit` met a `PreToolUse` hook whose `output` is a JSON-encoded deny payload (`"Paused by AI Team OS. Stop and wait."`), exit 0. The double-parse trap in `stream.ts` is measured here. `permission_denials` carries the denied `tool_use_id`. |
| `hook-crash.ndjson` | `b17561c` | Three `PreToolUse` hooks exiting **2** — the blocking crash. The tool never ran, and all three ids land in `permission_denials`. |
| `hook-fail-open.ndjson` | `b17561c` | `PreToolUse` hooks exiting 127, 126 and 1 — nonzero and not 2, so the tool **ran anyway**. Zero `permission_denials`, which is the observable difference from `hook-crash`. Also the only fixture carrying a `PostToolUse` response. |
| `hook-never-invoked.ndjson` | `7ce5abb` | `complete`'s transcript with every `PreToolUse` line removed: tool calls proceeding with no gate response of any shape. The adapter's runtime backstop (spec §5.5) reads this as "the hook was never installed", not as "the hook allowed". |
| `permission-denied.ndjson` | `b17561c` | A `system`/`permission_denied` line — the permission *mode* refusing an `Edit`. Deliberately kept distinct from `hook-deny`: conflating the two would report an operator pause where there was none. |
| `malformed.ndjson` | `b17561c` | Contains one line that is not JSON. The parser must return `unparsable` for it and keep going; a bad line must not kill a run. |
| `review-approve.ndjson`, `review-reject.ndjson`, `review-invalid.ndjson` | `a16add4` | `complete`'s transcript with the final `result.result` replaced by the reviewer's JSON verdict — approve, reject, and a malformed verdict. They drive the fake CLI's `m8a-flow` mode. |
| `plan-graph.ndjson` | `e8f2bb0` | Same base, with `result.result` carrying a planning task graph. Drives `m8-flow`'s planning arm. |
| `permission-matrix-deny.ndjson` | M18 Task 6 fix round 1; **re-recorded from the real CLI in M19 Task A1** | A real orchestrator-driven run against a real permission matrix — see the section below for its full provenance. `Read` allowed, then `Bash` (`npm test`) met this repo's own `PreToolUse` hook denying with the M18 grammar (`permission matrix denies 'run tests' (Bash) for this agent`), the agent adapted and reported instead of retrying, and the `result` line is honest about the denial: `is_error: false` but `permission_denials` carries the denied `toolu_01LiQfhzhqKJPfrr4pAD1Xjs`, exactly as `hook-deny.ndjson` measures the real CLI doing for a hook deny of any kind. |

The three review fixtures and `plan-graph` share `complete`'s `session_id`
(`fake-session-complete`) because they are edits of it, not separate captures.

## `permission-matrix-deny.ndjson` — the M19 capture that retired the hand-authored one

The raw stdout of **one** `claude` run made on **2026-09-01** for M19 Task A1. It replaces the
hand-authored file M18 Task 6 shipped in its place: that one was modeled on `hook-deny.ndjson`'s
narrative shape with the deny reason swapped for the M18 grammar, because no build of `claude` able
to produce a matrix-denied `PreToolUse` response existed to record from at the time — the capture
needs the shell gate's M18 Task 3/4 wiring already deployed, which was downstream of the very work
the fixture existed to test. That wiring shipped, so this is the recording, and the exception is
gone.

### The binary

```
$ claude --version
2.1.252 (Claude Code)
```

Path: `~/.local/bin/claude`. The version is recorded **before** the run by the capture script
itself: the CLIs on this machine self-update between runs, so a version read afterwards is not the
one that produced the bytes.

### The command

```bash
npx tsc --build
node --env-file=.env scripts/capture-matrix-deny.mjs
```

`scripts/capture-matrix-deny.mjs` is committed as this fixture's runnable provenance. It is not a
hand-built `claude` invocation: it drives **this repository's own orchestrator daemon**, so every
link of the enforcement chain in the recording is the product's, not the script's —

- a throwaway git repo (`git init`, one commit) carrying `target.txt` whose only line is
  `line one: alpha`, and a workspace/team/agent seeded in the dev database;
- the agent's model pinned to `sonnet`, its task `maxAttempts: 1`;
- one `AgentPermission` row, `{ tool: 'run tests', mode: 'deny' }`;
- `apps/orchestrator/src/tick.ts` resolving that row through `packages/control`'s `resolveDenyList`
  (`'run tests'` → `Bash` for `claude_code`) and writing the run's own `permissions.json` at
  dispatch;
- `scripts/pause-gate.sh` — the `PreToolUse` hook the Claude adapter registers — reading that file
  through `scripts/lib/permissions.sh` and spelling the deny;
- the task, verbatim: *"Read `target.txt`, then run the test suite with `npm test`, then report what
  target.txt contains."*

The **only** thing the script inserts is a stdout tee: `AITEAMOS_CLAUDE_BIN` points at a generated
bash wrapper whose whole body is `"$CLAUDE" "$@" | tee <out>` followed by `exit ${PIPESTATUS[0]}`
— it runs the real binary, copies its stdout to disk, and hands the adapter the CLI's own exit
status rather than `tee`'s. `AITEAMOS_CLAUDE_ARGS` is left untouched, so the adapter built
the same argv a production dispatch builds — recorded in the capture directory's `invocations.log`:

```
--output-format stream-json --verbose --permission-mode bypassPermissions \
  --settings <runDir>/settings.json --include-hook-events -p <task title + description> \
  --model sonnet
```

Exit 0, **6.3 s** (`duration_ms` 6301, `duration_api_ms` 5910), **29 lines**.

### The recorded outcome

`Read` allowed, `Bash` (`npm test`) matrix-denied, the agent reporting instead of retrying:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"permission matrix denies 'run tests' (Bash) for this agent"}}
```

on line 22 (`hook_name` `"PreToolUse:Bash"`, `hook_event` `"PreToolUse"`, `exit_code` 0, `outcome`
`"success"`) — the grammar `packages/providers/src/gate.ts`'s `PERMISSION_DENY_REASON_PREFIX` and
`parsePermissionDenyReason` are written against, byte for byte, out of the real hook. The terminal
`result` (line 28) is `is_error: false`, `subtype: "success"`, `num_turns: 3`,
`terminal_reason: "completed"`, and carries the denial anyway:

```json
"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_01LiQfhzhqKJPfrr4pAD1Xjs","tool_input":{"command":"npm test","description":"Run the test suite"}}]
```

Driven through the daemon, that run reached `succeeded`, was never `paused`, wrote no checkpoint,
and produced exactly one `run.tool_denied` event with payload `{"tool":"Bash","capability":"run
tests"}` and zero `guardrail.tripped` — the M18 Task 6 routing, confirmed against the real CLI
rather than against a file describing it.

Three things the hand-authored file did not have, all of them consequences of this being a real
recording rather than a sketch. The first two are read by nothing today and are the M19 findings
routed to B1/B2 (`docs/superpowers/specs/2026-09-01-m19-measure-and-harden-design.md`):

- **`hook_started` lines, and hook responses that are not adjacency-ordered.** Two `PreToolUse`
  hooks run per tool call here (this repo's gate plus a plugin's), and their responses come back out
  of order: the second `PreToolUse:Read` response is on **line 24**, *after* the `Bash` tool_use,
  after its deny response, and after the deny's `tool_result`. `hook_id` pairs each response to its
  `hook_started` (line 15 ↔ line 24) and is the only thing that does; `parseStreamLine` ignores it,
  and `pump.ts` associates a deny with a tool by "the last `tool_call` seen". In this recording that
  association is correct — but the recording shows it is a guess, not a guarantee.
- **`tool_result_meta`** on the denied `tool_result` (line 23):
  `[{"id":"toolu_01LiQ…","non_execution_kind":"permission-rule"}]`, alongside a
  `tool_use_result` of `"Error: permission matrix denies 'run tests' (Bash) for this agent"`. A
  structural denial signal, next to the string one everything currently matches on.
- **A full `init` line** (line 9): `claude_code_version` `2.1.252`, `model` `claude-sonnet-5`,
  `permissionMode` `bypassPermissions`, the real `cwd`, and a full environment catalog — the tool
  inventory, `mcp_servers`, `plugins[]`, `skills`, `agents`, `slash_commands`, `memory_paths`. The
  hand-authored file's `init` was schema-minimal on purpose: there was nothing honest to fill it
  from. That catalog is what forced **redaction rule 5** below — it published which third-party
  accounts the recording operator has connected, which rules 1–4 had no reason to anticipate. The
  committed line keeps every field a parser could read and carries a `fixture-*` stand-in for each
  inventory array.

`parseStreamLine` returns **no `unparsable`** for any of the 29 lines: 1 `session_started`, 2
`tool_call`, 1 `hook_denied`, 1 `text`, 1 `terminated`, and 23 `ignored`.

`session_id` is the run's own real UUID (`919ffb5a-…`), **not** the `fake-session-<mode>` convention
the M3/M8 replay modes share. That convention was a capture-time rewrite; nothing reads it, and
rewriting a real session id to look like a fake one would make this recording less checkable, not
more.

The file ends with the routine `Stop` hook line (`exit_code` 1, `outcome` `"cancelled"`), so it
satisfies the replay-namespace invariant `fake-claude.test.ts` enforces without anything being
appended to it.

### Redaction

The stream is byte for byte the CLI's stdout except for the mechanical substitutions below, applied
in two stages (`<operator>` was the recording operator's home-directory name).

**Stage 1 — rule 3**, paths carrying a home directory, a UID or a PID:

```bash
sed -e 's#/home/<operator>#/home/fixture-user#g' \
    -e 's#-home-<operator>-#-home-fixture-user-#g' \
    -e 's#"messaging_socket_path":"/run/user/1001/cc-socks/67456.sock"#"messaging_socket_path":"/run/user/UID/cc-socks/PID.sock"#' \
    /tmp/aiteamos-capture-matrix-deny-out-*/raw-*.ndjson \
  > stage-1.ndjson
```

**Stage 2 — rule 5**, the `init` line's environment catalog. Rule 3 does not touch these fields (no
paths, no emails, no UID/PID), yet `mcp_servers` published which third-party accounts the operator
has connected and their auth status, and `tools` repeated all 84 of their `mcp__*` tool names:

```bash
node -e '
const fs = require("node:fs")
const STANDIN = {
  tools: ["Read", "Bash"],
  mcp_servers: [{ name: "fixture-mcp-server", status: "connected" }],
  slash_commands: ["fixture-command"],
  agents: ["fixture-agent"],
  skills: ["fixture-skill"],
  plugins: [{ name: "fixture-plugin", path: "/home/fixture-user/.claude/plugins/cache/fixture/fixture-plugin/0.0.0", source: "fixture-plugin@fixture", version: "0.0.0" }],
}
const [inFile, outFile] = process.argv.slice(1)
fs.writeFileSync(outFile, fs.readFileSync(inFile, "utf8").split("\n").map((line) => {
  if (line.trim() === "") return line
  const parsed = JSON.parse(line)
  if (parsed.type !== "system" || parsed.subtype !== "init") return line
  for (const [key, value] of Object.entries(STANDIN)) if (key in parsed) parsed[key] = value
  return JSON.stringify(parsed)
}).join("\n"))
' stage-1.ndjson packages/providers/test/fixtures/permission-matrix-deny.ndjson
```

A `JSON.parse`/`JSON.stringify` round trip of this file with an **empty** `STANDIN` is byte-identical
to its input across all 29 lines (checked with `cmp`), so this pass changes only the six fields it
names — and it touched exactly one line, line 9.

**Where each one lands:**

| Rule | Substitution | Sites |
| --- | --- | --- |
| 3 | `/home/<operator>` → `/home/fixture-user` | **9 at stage 1**, all on line 9 — the `init` line: eight `plugins[].path` entries and `memory_paths.auto`. Stage 2 then collapses `plugins` to one stand-in element, so the **committed file carries 2**: the stand-in's own path and `memory_paths.auto`. |
| 3 | `-home-<operator>-` → `-home-fixture-user-` | **0**. The mangled form (M17's rule) is applied unconditionally and had nothing to act on: the CLI's project directory for this run mangles the *worktree* path, which is under `/tmp`, giving `-tmp-aiteamos-capture-matrix-deny-repo-jDFKLE`. Kept in the command so the recipe stays complete for the next capture, which may not be run from `/tmp`. |
| 3 | `messaging_socket_path` → `/run/user/UID/cc-socks/PID.sock` | **1**, on the `init` line. It carried the operator's UID and a PID. |
| 5 | `tools` (111 entries, 84 of them `mcp__*`) → `["Read","Bash"]` | **1**, the `init` line. The two tools this recording actually exercises, so the catalog stays consistent with the transcript instead of naming a tool that never appears in it. |
| 5 | `mcp_servers` (5 entries) → `[{"name":"fixture-mcp-server","status":"connected"}]` | **1**. This is the field the rule exists for: it named the operator's connected Gmail/Notion/Drive/Calendar accounts and their auth status. |
| 5 | `plugins` (8) → one `fixture-plugin` entry; `slash_commands` (115) → `["fixture-command"]`; `skills` (82) → `["fixture-skill"]`; `agents` (5) → `["fixture-agent"]` | **1 each**, all on the `init` line. Each keeps its real element schema. |

`terminal_slash_commands` (`["doctor","color"]`) and `capabilities` are **kept**: the first is the
CLI's own built-in list and the second is its wire-protocol feature set, neither of which says
anything about the operator. Every other `init` field a parser or test could read — `type`,
`subtype`, `cwd`, `session_id`, `model`, `permissionMode`, `claude_code_version`, `uuid`,
`memory_paths`, `apiKeySource`, `output_style`, the `fast_mode_*` pair — is the capture's own,
byte for byte, in the capture's own key order.

Nothing else was altered; line count and ordering are the capture's own. The byte accounting, end to
end:

| Stage | Bytes | Delta |
| --- | --- | --- |
| raw capture | 34875 | — |
| after stage 1 | 34935 | **+60** = `9 × 7 − 3` (nine `/home/<operator>` sites grow by 7 each; the socket path shrinks by 3) |
| after stage 2 (committed) | 25041 | **−9894**, entirely on line 9, whose `init` line goes from 11046 to 1152 bytes |

The capture contains **no email address** (grep for `@`-shaped tokens: zero matches) and no
transcript path. `session_id` and `uuid` values are kept: they are random UUIDs, they identify
nothing outside the run, and the parser reads `session_id` off the `init` line. The `cwd` and the
`Read` tool's `file_path` keep their `/tmp/aiteamos-capture-matrix-deny-repo-…` values — a throwaway
directory that identifies nobody, and leaving it makes the recording checkable against the command
above, the same call `claude/skill-tool-use.ndjson` made about `/tmp/m14-skill-fixture`.

### Spend

**One** `claude` invocation, **$0.0741884** (`total_cost_usd` on the `result` line), against an
approved cap of $1.00. The task's second permitted attempt was not needed: the first run produced
the matrix deny.

## Redaction rules for anything added here

1. Keep the stream **byte for byte** except for mechanical substitutions.
2. Name every substitution, as a runnable command, in the README beside the file.
3. Redact: the operator's email address, home directory paths, transcript/session **paths**, and
   any path carrying a UID or a PID (`messaging_socket_path` is the one the CLI emits — it was
   missed on the first pass of `claude/skill-tool-use.ndjson` and caught in review). Session *ids*
   stay — they are random UUIDs, and the parser reads them.
4. Never add, remove or reorder a line to make a fixture fit a test. If a real recording does not
   fit, the fixture is right and its placement is wrong.
5. Replace the **environment-catalog fields on an `init` line** — `tools`, `mcp_servers`,
   `plugins`, `slash_commands`, `skills`, `agents`, and any other inventory field a future CLI adds
   there — with a minimal generic stand-in. These fields are not about the run: they are a
   permanent, published catalog of which plugins, skills and **third-party accounts** the recording
   operator has connected (`mcp_servers` names them and their auth status; `tools` repeats every
   one of their `mcp__*` tools). Rules 1–4 do not catch this — the values are neither paths, nor
   emails, nor UID/PID-bearing — which is exactly why this rule exists. Keep everything the parser
   or a test could ever read byte for byte (`type`, `subtype`, `session_id`, `cwd`, `model`,
   `claude_code_version`, `permissionMode`, `uuid`, …); replace each inventory array with **one**
   element of the same schema, named `fixture-*`, so the line stays structurally honest rather than
   silently losing a field. Name the substitution as a runnable command beside the file, like any
   other, and apply it identically to every future capture.

These five govern every fixture here, with no declared exception left. `permission-matrix-deny.ndjson`
was the last one — exempt from rules 1 and 4 because it had no real recording to keep byte for byte
or to defer to — and M19 Task A1 recorded one, so the exemption is retired rather than merely
narrowed. Rule 4 in particular now binds it like everything else: its two out-of-order hook
responses and its `hook_started` lines stay exactly where the CLI put them, including the ones
nothing reads.
