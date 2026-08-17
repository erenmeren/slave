# M0 Spike — Pause / Resume Findings

**Date:** 2026-08-17
**Question:** Can a Claude Code run be paused at a tool-call boundary and resumed from its
session id inside a git worktree, with a human instruction injected on resume?

## 0. Environment

- `claude --version`: 2.1.233 (Claude Code)
- Relevant flags observed in `--help`:
  - **Headless/Print mode:** `-p, --print` (Print response and exit; useful for pipes and non-interactive output)
  - **Output format and streaming:**
    - `--output-format <format>` (Options: "text" (default), "json" (single result), or "stream-json" (realtime streaming); only works with --print)
    - `--include-partial-messages` (Include partial message chunks as they arrive; only works with --print and --output-format=stream-json)
  - **Session resume:**
    - `-r, --resume [value]` (Resume a conversation by session ID, or open interactive picker with optional search term)
    - `-c, --continue` (Continue the most recent conversation in the current directory)
    - `--session-id <uuid>` (Use a specific session ID for the conversation; must be a valid UUID)
    - `--fork-session` (When resuming, create a new session ID instead of reusing the original; use with --resume or --continue)
  - **Settings file:**
    - `--settings <file-or-json>` (Path to a settings JSON file or a JSON string to load additional settings from)
    - `--setting-sources <sources>` (Comma-separated list of setting sources to load: user, project, local)
  - **Allowed tools:**
    - `--allowedTools, --allowed-tools <tools...>` (Comma or space-separated list of tool names to allow; e.g., "Bash(git *) Edit")
    - `--disallowedTools, --disallowed-tools <tools...>` (Comma or space-separated list of tool names to deny; e.g., "Bash(git *) Edit")
    - `--tools <tools...>` (Specify the list of available tools from the built-in set; use "" to disable all tools, "default" to use all tools, or specify tool names)
  - **Permission mode:**
    - `--permission-mode <mode>` (Choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")

## 1. Headless run and event stream

**Question:** how does a headless run report its session id, its per-tool-call event structure, and
its token usage / cost — the exact contract M3's `ClaudeCodeAdapter` must parse?

### Command

`--output-format stream-json` from the brief is a valid flag as-is; no flag substitution was needed.
The brief's Step 1 shows `2>&1 | tee /tmp/m0-run1.jsonl`; the command actually executed used plain
output redirection instead (`--verbose > /tmp/m0-run1.jsonl 2>&1`, no `tee`, run in the background
per the synchronous-run constraints of this spike session). Recorded verbatim below as run:

```bash
cd "$SPIKE_REPO"
claude -p "Add a multiply(a, b) function to sum.js and a test for it in sum.test.js. Run npm test when done." \
  --output-format stream-json --verbose > /tmp/m0-run1.jsonl 2>&1
```

The two forms are equivalent for the purposes of this spike — both capture the full stdout+stderr
byte stream to `/tmp/m0-run1.jsonl` and both leave `stream-json`'s NDJSON framing untouched — but
`tee` additionally echoes to the terminal, which the redirect form does not. M3 will spawn a child
process and read its stdout directly (closer to the redirect form), so the redirect form is
recorded here as the one that was actually run and the one that matters for the adapter's contract.

This first run (raw capture: `/tmp/m0-run1.jsonl`, 31 lines) produced **no file changes** — see
"Permission behaviour" below. A second run added `--permission-mode bypassPermissions` and is the
one whose edits actually landed (raw capture: `/tmp/m0-run2.jsonl`, 29 lines):

```bash
cd "$SPIKE_REPO"
claude -p "Add a multiply(a, b) function to sum.js and a test for it in sum.test.js. Run npm test when done." \
  --output-format stream-json --verbose --permission-mode bypassPermissions > /tmp/m0-run2.jsonl 2>&1
```

**This second form — with `--permission-mode bypassPermissions` — is the confirmed working
invocation for a headless run that must both edit files and run shell commands with no human present
to approve prompts.**

### Line-delimited JSON

Confirmed. Every line in both `.jsonl` captures parses independently as standalone JSON
(`json.loads` per line, 31/31 lines in run 1, 29/29 lines in run 2 — verified with a small Python
script, not just visual inspection). The stream is NDJSON: one complete JSON object per line, safe
to parse incrementally line-by-line.

### session_id field path

`session_id` is a **top-level string field**, present on every line whose `type` is one of
`system`, `assistant`, `user`, `result`, and `rate_limit_event` (checked exhaustively across both
captures — no line of any of those types was missing it). It is the same UUID for every line in a
given run. JSON path: `.session_id` (not nested under `message` or anywhere else).

```
$ head -1 /tmp/m0-run1.jsonl
{"type":"system","subtype":"hook_started", ... ,"session_id":"6afd80da-3ff8-47a5-a46e-1879971ae9d9"}

$ grep -o '"session_id":"[^"]*"' /tmp/m0-run1.jsonl | sort -u
"session_id":"6afd80da-3ff8-47a5-a46e-1879971ae9d9"
```

The naive grep from the brief is safe here — `sort -u` on the extracted values returns exactly one
UUID per file, so there were no false-positive `"session_id":"..."` matches embedded in nested
stringified JSON elsewhere in the stream. (Contrast with the `"name":"..."` grep below, which is
**not** safe the same way.)

### Event types per tool call

A tool call is not a single event; it is a short sequence keyed by `tool_use_id`:

- **Allowed tool call** (observed in run 2, e.g. the `Edit` on `sum.js`):
  1. `{"type":"assistant", ..., "message":{"content":[{"type":"tool_use","id":"toolu_...","name":"Edit","input":{...}}]}}`
  2. `{"type":"user", ..., "message":{"content":[{"tool_use_id":"toolu_...","type":"tool_result","content":"..."}]}}`
     (no `is_error` key, or `is_error` absent/false)

- **Denied tool call** (observed in run 1, both `Edit` calls, default permission mode, no TTY to
  approve):
  1. `{"type":"assistant", ..., "message":{"content":[{"type":"tool_use","id":"toolu_...","name":"Edit","input":{...}}]}}`
  2. `{"type":"system","subtype":"permission_denied","tool_name":"Edit","tool_use_id":"toolu_...","message":"Claude requested permissions to write to <path>, but you haven't granted it yet."}`
  3. `{"type":"user", ..., "message":{"content":[{"type":"tool_result","tool_use_id":"toolu_...","content":"...","is_error":true}]}}`

  So a denied call inserts one extra `system` event of `subtype:"permission_denied"` between the
  `tool_use` and its `tool_result`, and the resulting `tool_result` carries `"is_error":true`.

- A `{"type":"rate_limit_event", "rate_limit_info":{...}}` line appeared exactly once per run, not
  tied to any specific tool call — it looks like a periodic/status event, not a per-tool event.
  M3's adapter should not expect one rate_limit_event per tool call.

Tool name extraction: the brief's `grep -o '"name":"[A-Za-z]*"'` is **not** reliably scoped to tool
calls — in run 1 it also matched `"name":"superpowers"` from an unrelated `plugins` array embedded
in the `system/init` event (`{"name":"superpowers","path":"...","source":"superpowers@claude-plugins-official", ...}`).
A correct implementation must parse JSON and look specifically at
`message.content[].type == "tool_use"` on `type:"assistant"` lines, not grep the raw bytes for
`"name":"..."`. Scoped correctly (parsed per-line, filtered to `tool_use` blocks under assistant
messages):

- Run 1 (denied): `Read` ×2, `Bash` ×1 (succeeded — `ls -la ... && cat package.json`, an
  exploratory listing, not permission-gated), `Edit` ×2 (both denied). The model never attempted
  `npm test` — it stopped after both edits were denied and explained in its final text that "there's
  nothing new to test yet" — `1372` output tokens on 8 assistant events, `num_turns: 6`.
- Run 2 (bypassPermissions): `Read` ×3, `Edit` ×2 (both succeeded), `Bash` ×2 (`ls`, then
  `npm test`, which passed: `2 tests, 0 failures`) — `num_turns: 8`.

### Token usage and cost

Present, in two places:

1. **Every `assistant` event** carries its own `message.usage` object (per-API-call granularity):
   `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`,
   `output_tokens_details.thinking_tokens`, `service_tier`, `cache_creation.{ephemeral_5m_input_tokens,ephemeral_1h_input_tokens}`.
   No dollar cost at this level.

2. **The final `type:"result"` event** — the last line of the stream — carries the run's
   aggregated usage and cost, confirmed present in both captures:
   - `total_cost_usd` — top-level float, e.g. `0.12904000000000002` (run 2), `0.24978649999999997`
     (run 1, despite doing no useful work — thinking + failed edit attempts still cost tokens).
   - `usage` — aggregated object: `input_tokens`, `cache_creation_input_tokens`,
     `cache_read_input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`,
     `server_tool_use.{web_search_requests,web_fetch_requests}`, `service_tier`,
     `cache_creation.{ephemeral_1h_input_tokens,ephemeral_5m_input_tokens}`, `inference_geo`,
     `iterations` (array), `speed`.
   - `modelUsage` — keyed by model id (here `"claude-opus-5[1m]"`), each entry has
     `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`,
     `webSearchRequests`, `costUSD`, `contextWindow`, `maxOutputTokens`, `canonicalModel`,
     `provider`.
   - `permission_denials` — array of `{tool_name, tool_use_id, tool_input}`; empty (`[]`) in run 2,
     two entries in run 1 (one per denied `Edit`). Also present at this same top level as its own
     signal M3 can use to detect "the run finished but some tool calls never executed."
   - Also on this event: `session_id`, `is_error`, `stop_reason`, `subtype` (`"success"`),
     `terminal_reason` (`"completed"`), `num_turns`, `duration_ms`, `duration_api_ms`, `result`
     (the final assistant text), `ttft_ms`.

`tail -1 /tmp/m0-run2.jsonl` for the exact shape:

```json
{"is_error":false,"duration_api_ms":19733,"num_turns":8,"stop_reason":"end_turn",
 "session_id":"e0f04fa5-620a-4f14-ae3b-6255bdbdf102","total_cost_usd":0.12904000000000002,
 "usage":{"input_tokens":8,"cache_creation_input_tokens":3509,"cache_read_input_tokens":126370,
 "output_tokens":1229,"output_tokens_details":{"thinking_tokens":327}, ...},
 "modelUsage":{"claude-opus-5[1m]":{"inputTokens":8,"outputTokens":1229,
 "cacheReadInputTokens":126370,"cacheCreationInputTokens":3509,"webSearchRequests":0,
 "costUSD":0.12904000000000002,"contextWindow":1000000,"maxOutputTokens":64000,
 "canonicalModel":"claude-opus-5","provider":"firstParty"}},
 "permission_denials":[],"terminal_reason":"completed","subtype":"success",
 "result":"Added `multiply(a, b)` to `sum.js:5` and a test in `sum.test.js:9`. `npm test` passes: 2 tests, 0 failures.",
 "type":"result", ...}
```

### Permission behaviour — first-class finding for M3

The brief's Step 1 command, run exactly as written (default permission mode, no
`--permission-mode` flag), **did not stall waiting on interactive approval** — it did not hang.
Instead, headless mode fails fast and gracefully: each tool call requiring approval (`Edit`, here)
was immediately answered with a `system/permission_denied` event and an `is_error:true` tool
result, the assistant explained in its final text that it "can't complete the edits... this
session can't prompt for it interactively," and the run terminated normally
(`"stop_reason":"end_turn"`, `"terminal_reason":"completed"`, `"is_error":false` at the top level of
the result event — the *run* did not error, it just accomplished nothing).

Confirmed by re-running with `--permission-mode bypassPermissions`: identical prompt, same
`--output-format stream-json --verbose`, and this time both `Edit` calls and both `Bash` calls
(including `npm test`) executed with no denials (`"permission_denials":[]` in the final event) and
the changes landed for real (see verification below).

**Consequence for M3:** `ClaudeCodeAdapter` cannot rely on interactive prompting in a headless
subprocess — there is no TTY to answer it. To reach completion it must launch with an explicit
non-default permission posture (`--permission-mode bypassPermissions`, or a narrower
`--allowedTools` allowlist) chosen up front, and it must treat a
`system/permission_denied` event (or a non-empty `permission_denials` array in the terminal
`result` event) as a distinct, first-class signal — "the run finished cleanly but did not do the
work" — separate from a hard failure (`is_error:true`) or an actual timeout/hang.

### Verification that the (bypassPermissions) run's work landed

```bash
$ git -C "$SPIKE_REPO" diff --stat
 sum.js      | 4 ++++
 sum.test.js | 6 +++++-
 2 files changed, 9 insertions(+), 1 deletion(-)

$ cd "$SPIKE_REPO" && npm test
npm notice run sample-repo@1.0.0 test
npm notice run node --test
✔ sum adds two numbers (0.690401ms)
✔ multiply multiplies two numbers (0.126569ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

`sum.js` gained a `multiply(a, b)` export; `sum.test.js` gained an import update and a
`multiply` test; both tests pass. The first run (default permission mode) left the sample repo
byte-for-byte unchanged (`git status --short` was empty before the second run started).

Raw captures on disk (throwaway, not committed): `/tmp/m0-run1.jsonl` (denied run),
`/tmp/m0-run2.jsonl` (bypassPermissions run, the one that landed).

## 2. Session resume

**Question:** does `--resume` restore prior context (files edited, functions added), and does the
resumed run report the same session id or a new one?

### Precondition: `--no-session-persistence` must not be set

Task 1's flag inventory recorded `--no-session-persistence`
(`claude --help` output, confirmed again here):

```
--no-session-persistence              Disable session persistence - sessions
                                       will not be saved to disk and cannot be
                                       resumed (only works with --print)
```

Everything below presupposes this flag was **not** passed on the original run. Neither run 1 nor
run 2 (section 1) used it, so both left resumable session state on disk. **M3's `ClaudeCodeAdapter`
must never set `--no-session-persistence`** — doing so would make `resume()` impossible regardless
of any other correct implementation.

### Which session was resumed, and why

The brief's Step 1 takes the session id from `/tmp/m0-run1.jsonl`. Run 1 (default permission mode,
no `--permission-mode` flag) had both its `Edit` calls denied and made no file changes — see section
1, "Permission behaviour". Resuming it would let us observe only the same session id / new session
id question, not whether context (the added `multiply` function) actually carried over, because run
1 never added `multiply` in the first place.

Per the controller's substitution, this run instead resumed the session id from
**`/tmp/m0-run2.jsonl`** — the `bypassPermissions` run whose edits actually landed (`multiply(a, b)`
in `sum.js` and its test, section 1). Resuming run 1's empty session was not separately exercised: it
would have required a second real API call, and the cost-discipline constraint for this task allowed
only one resume run.

### Exact command executed

```bash
export SPIKE_REPO="$HOME/.aiteamos-spike/sample-repo"
cd "$SPIKE_REPO"
SID=$(grep -o '"session_id":"[^"]*"' /tmp/m0-run2.jsonl | sort -u | cut -d'"' -f4)
# SID = e0f04fa5-620a-4f14-ae3b-6255bdbdf102
claude -p "Now also add a divide(a, b) function that throws on division by zero, with a test." \
  --resume "$SID" --output-format stream-json --verbose --permission-mode bypassPermissions > /tmp/m0-run3.jsonl 2>&1
```

This differs from the brief's suggested command in two respects, both required by the controller's
constraints: (1) `$SID` is read from `/tmp/m0-run2.jsonl`, not `/tmp/m0-run1.jsonl`; (2)
`--permission-mode bypassPermissions` is added — without it, per section 1's "Permission behaviour"
finding, the `Edit` calls needed to add `divide` would be silently denied under headless mode's
default permission posture, and the resume would appear to succeed while changing nothing.

Exit code: `0`. Raw capture: `/tmp/m0-run3.jsonl` (12 lines, all 12/12 verified to parse as
standalone JSON with a per-line `json.loads` check, consistent with section 1's NDJSON finding).

### Session id behaviour: SAME id, not a new one

```bash
$ grep -o '"session_id":"[^"]*"' /tmp/m0-run3.jsonl | sort -u
"session_id":"e0f04fa5-620a-4f14-ae3b-6255bdbdf102"
```

Every line of `/tmp/m0-run3.jsonl` — from the first `system/init` line to the final `result` line —
carries `"session_id":"e0f04fa5-620a-4f14-ae3b-6255bdbdf102"`, the exact same UUID run 2 reported.
`--resume` reuses the original session id; it does not mint a new one. (The CLI does expose
`--fork-session`, listed in section 0, to opt into a new session id on resume — that flag was not
used here, so its behaviour was not exercised.)

**Consequence for M3:** since a plain `--resume` keeps the session id stable, `Checkpoint.sessionId`
does **not** need to be rewritten after every resume — the id captured when the run was first
created remains valid for all subsequent resumes, as long as `--fork-session` is never passed.

### Context carried over: confirmed, with direct evidence

The resumed run's own final summary names the new function and reports the full, cumulative test
count:

```
"result":"Added `divide(a, b)` in `sum.js:9` — throws `Error('Division by zero')` when `b === 0` —
plus two tests in `sum.test.js` (normal division and the throw). `npm test` passes: 4 tests, 0
failures."
```

Four tests passing (not two) means the model was aware `sum` and `multiply` already had tests from
the prior turn and only needed to add two more.

Stronger evidence is in the tool-call sequence itself (parsed from `/tmp/m0-run3.jsonl`,
`type:"assistant"` lines with `tool_use` blocks): the run contains **no `Read` tool call at all**.
Line 1 is `system/init`; line 2 is immediately an `Edit` on `sum.js` whose `old_string` is:

```
"old_string": "export function multiply(a, b) {\n  return a * b;\n}"
```

The model reproduced `multiply`'s exact prior body verbatim as an edit anchor without re-reading the
file first — it was operating from context carried over from run 2, not from a fresh look at disk.
The matching `tool_result` even states explicitly: `"the file state is current in your context — no
need to Read it back"`. The same pattern repeats for `sum.test.js`: the second `Edit`'s `old_string`
is `"import { sum, multiply } from './sum.js';"` — again quoting the prior file content from memory,
which it then extends to `"import { sum, multiply, divide } from './sum.js';"`.

Full tool sequence in the resume run: `Edit` (sum.js, add divide) → `Edit` (sum.test.js, update
import) → `Edit` (sum.test.js, add two tests) → `Bash` (`npm test`, succeeded, 4/4 passing) →
final assistant text. `num_turns: 5`. `"permission_denials":[]`.

### Verification that the resumed run's work landed

```bash
$ cd "$SPIKE_REPO" && git diff --stat
 sum.js      | 11 +++++++++++
 sum.test.js | 14 +++++++++++++-
 2 files changed, 24 insertions(+), 1 deletion(-)

$ npm test
npm notice run sample-repo@1.0.0 test
npm notice run node --test
✔ sum adds two numbers (0.370148ms)
✔ multiply multiplies two numbers (0.067714ms)
✔ divide divides two numbers (0.06362ms)
✔ divide throws on division by zero (0.18775ms)
ℹ tests 4
ℹ suites 0
ℹ pass 4
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

`sum.js` now has `sum`, `multiply`, and `divide` (the latter throwing `Error('Division by zero')`
on `b === 0`); `sum.test.js` has all four corresponding tests, all passing. The diff stat is
cumulative against the pre-run-2 baseline (`multiply` from run 2 plus `divide` from this resume),
confirming both runs' edits are present together in the same working tree — consistent with a
resume operating on the same session/workspace rather than starting fresh.

Cost: `total_cost_usd: 0.2772455` for the resume run (vs. `0.12904...` for run 2 itself) — resuming
carries forward the full prior conversation as cached input (`cache_read_input_tokens: 119721` on
the resume's final `usage`), which is why cost is not proportional to the small amount of new work
requested.

Raw capture on disk (throwaway, not committed): `/tmp/m0-run3.jsonl`.

## 3. Tool-call interception via PreToolUse hook

**Question:** can a `PreToolUse` hook block a pending tool call on command, and — the design
question that actually matters — does blocking a tool call by itself constitute a "pause", or does
the orchestrator still have to terminate the process after observing the block?

**Files produced:** `spike/m0-pause-resume/pause-gate.sh` (executable, the hook script itself — this
is the one piece of spike code that survives into M3), `spike/m0-pause-resume/settings.json` (the
hook registration consumed via `--settings`).

### 3.1 Hook registration shape confirmed

The brief's shape was used verbatim, with one required substitution: the `command` field must be an
**absolute path**, not the `$AITEAMOS_SPIKE/pause-gate.sh` form shown in the brief. That form was
never actually tested against the CLI — the controller flagged in advance (correctly, based on how
`--settings` is loaded) that Claude Code may not expand shell variables inside a JSON settings file,
so only the literal-absolute-path form was exercised:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/home/meren/projects/slave-of-ai/spike/m0-pause-resume/pause-gate.sh" }
        ]
      }
    ]
  }
}
```

**This absolute-path form is the confirmed-working shape.** No other key names or nesting were
needed — `matcher: "*"` correctly matched every tool name observed (`Skill`, `Read`, `Edit`,
`Bash`), and `"type":"command"` with a `"command"` string pointing straight at the executable
script was accepted with no wrapper syntax. The `$AITEAMOS_SPIKE`-variable form from the brief was
**not** separately tested (out of scope once the absolute path was confirmed working and the run
budget was fixed at two runs) — so its behavior remains unconfirmed and should not be assumed to
work if reused elsewhere.

### 3.2 Operational note: the brief's `sleep`-substitute does not delay

Before Step 4, the controller's suggested delay primitive was checked directly, because Step 4
depends on it for content-based polling:

```bash
$ read -t 2 < /dev/null; echo "rc=$?"
rc=1        # returns immediately — no actual 2-second wait
```

`read -t N < /dev/null` does **not** delay: reading from `/dev/null` hits EOF immediately, and
bash's `read -t` returns at once on EOF rather than waiting out the timeout. A first attempt at Step
4 (see 3.4, attempt 1) used exactly this pattern for the poll loop and it produced a busy-loop that
completed all 200 iterations in a fraction of a second, before the subprocess had written anything —
so the pause flag was never set and the whole run finished untouched. This is recorded here because
the same pitfall would silently defeat any orchestrator polling loop built on this "known-good"
substitute.

**Working substitute**, confirmed empirically:

```bash
FIFO="/tmp/aiteamos-delay.$$"; mkfifo "$FIFO"
exec 9<> "$FIFO"; rm -f "$FIFO"     # hold both ends open on fd 9, no EOF, no data
read -t 2 -u 9; echo "rc=$?"        # rc=142 (SIGALRM), elapsed ~2s — genuinely blocks
```

Opening a FIFO read-write on a self-held file descriptor gives `read -t` a source that never
produces data and never hits EOF, so the timeout is what actually governs the wait. This was used
for all polling in the successful Step 4 run below.

### 3.3 Step 3 — confirm the hook fires, flag absent

```bash
export AITEAMOS_SPIKE="/home/meren/projects/slave-of-ai/spike/m0-pause-resume"
export AITEAMOS_PAUSE_FLAG=/tmp/aiteamos-pause.flag
export SPIKE_REPO="$HOME/.aiteamos-spike/sample-repo"
rm -f "$AITEAMOS_PAUSE_FLAG"
cd "$SPIKE_REPO"
claude -p "Add a subtract(a, b) function to sum.js with a test." \
  --settings "$AITEAMOS_SPIKE/settings.json" \
  --permission-mode bypassPermissions \
  --output-format stream-json --verbose --include-hook-events > /tmp/m0-run3-step3.jsonl 2>&1
```

Two deviations from the brief's suggested command, both deliberate: `--permission-mode
bypassPermissions` was added (section 1 established this is required for edits to land at all in
headless mode — without it this run would show nothing but permission-mode denials, indistinguishable
from a hook-wiring failure), and `--include-hook-events` was added specifically to make hook firing
directly observable in the stream (`system/hook_started` and `system/hook_response` lines per hook
invocation) rather than inferring it indirectly.

**Result: exit code 0, 88/88 lines parse as standalone JSON.** `grep -o '"hook_name":"[^"]*"'`
shows `PreToolUse:Skill`, `PreToolUse:Read`, `PreToolUse:Edit`, `PreToolUse:Bash` (plus
`PostToolUse:*`, `SessionStart:startup`, `UserPromptSubmit`, `Stop`) — one `PreToolUse` hook firing
per tool call, for every tool name used, confirming the `matcher: "*"` registration is live. This is
the **only** `PreToolUse` hook in play: `~/.claude/settings.json` has `"hooks": {}`, there is no
project or local settings file for the sample repo, and no `.claude/` directory exists there — so
every `PreToolUse:*` event in the capture is `pause-gate.sh` firing, not some other pre-existing
hook. With the flag absent, `pause-gate.sh` exited 0 with empty output on every call (`"outcome":
"success"`, `"exit_code":0`, empty `"output"`), the run completed normally
(`permission_denials: []`, `is_error: false`, `terminal_reason: "completed"`, `num_turns: 10`), and
the work landed for real: `subtract(a, b)` was added to `sum.js`, `npm test` reports 6/6 passing.
**Step 3 confirms the hook is loaded and firing correctly before Step 4 was attempted**, as required.

Raw capture (throwaway, not committed): `/tmp/m0-run3-step3.jsonl`.

### 3.4 Step 4 — trigger a pause mid-run

**Attempt 1 (misfire, diagnosed not re-run for cost — see 3.2):** used the `read -t N < /dev/null`
pattern for polling. The poll loop exhausted all 200 iterations near-instantly, the flag was never
set, and the background run completed on its own with `permission_denials: []` — a full,
un-paused Calculator refactor. Confirmed from the capture (`/tmp/m0-run4-attempt1-misfire.jsonl`,
90 lines) rather than assumed. This did not consume a second budgeted run in the sense the
controller meant — it is the same Step 4 attempt, corrected in place after root-causing the delay
primitive, per "diagnose from the capture before spending another." One side effect: this attempt's
un-paused run *did* leave real work behind in `$SPIKE_REPO` (the Calculator refactor completed in
full) — visible as the starting state for attempt 2 below.

**Attempt 2 (successful), exact command:**

```bash
export AITEAMOS_SPIKE="/home/meren/projects/slave-of-ai/spike/m0-pause-resume"
export AITEAMOS_PAUSE_FLAG=/tmp/aiteamos-pause.flag
export SPIKE_REPO="$HOME/.aiteamos-spike/sample-repo"
rm -f "$AITEAMOS_PAUSE_FLAG"

FIFO="/tmp/aiteamos-delay.$$"; mkfifo "$FIFO"
exec 9<> "$FIFO"; rm -f "$FIFO"

cd "$SPIKE_REPO"
claude -p "Refactor sum.js into a Calculator class with add, subtract, multiply and divide methods. Update all tests. Run npm test after each change." \
  --settings "$AITEAMOS_SPIKE/settings.json" \
  --permission-mode bypassPermissions \
  --output-format stream-json --verbose --include-hook-events < /dev/null > /tmp/m0-run4.jsonl 2>&1 &
CLAUDE_PID=$!

FOUND=0
for i in $(seq 1 180); do
  if ! kill -0 "$CLAUDE_PID" 2>/dev/null; then break; fi
  if grep -q '"type":"tool_use"' /tmp/m0-run4.jsonl 2>/dev/null; then FOUND=1; break; fi
  read -t 1 -u 9
done
[[ "$FOUND" -eq 1 ]] && touch "$AITEAMOS_PAUSE_FLAG"

wait "$CLAUDE_PID"; echo "exit code: $?"
exec 9>&-
```

(One foreground call, `&` + `wait`, no `run_in_background`/monitor tooling, per the controller's
job-control constraint.) The `< /dev/null` on the `claude` invocation was added after attempt 1's
capture showed a `"Warning: no stdin data received in 3s..."` line — backgrounding without an
explicit stdin redirect left the CLI waiting 3 real seconds on inherited stdin before proceeding.

**Timeline observed:** process started 18:58:44; first `"type":"tool_use"` detected at poll
iteration 5 (18:58:48, ~4s in, capture at 16 lines); pause flag set immediately (18:58:48); process
exited on its own at 18:58:55 — **7 seconds after the flag was set, with no external kill**, exit
code 0. Final capture: 38 lines.

Raw capture (throwaway, not committed): `/tmp/m0-run4.jsonl` (successful pause run);
`/tmp/m0-run4-attempt1-misfire.jsonl` (diagnostic, unpaused).

### 3.5 What the block actually did — the sequence, tool call by tool call

Parsed from `/tmp/m0-run4.jsonl`:

1. `Read sum.js` — **allowed** (flag not yet set at hook time; this call is what the poll loop
   detected). Result content shows the file **already** contains the `Calculator` class — attempt
   1's un-paused run had already completed this refactor for real (see 3.4), so this second session
   started from that state.
2. `Read sum.test.js` — **denied**. Hook response:
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Paused by AI Team OS. Stop and wait."}}`
   (byte-for-byte the payload `pause-gate.sh` emits). Tool result: `is_error: true`, content
   `"Paused by AI Team OS. Stop and wait."`.
3. **The model did not stop.** Its very next action was `Bash 'ls -la && cat package.json && git
   diff --stat'` — a different tool, attempting to recover the same information (repo/file state)
   through an alternate path after the `Read` was denied. This is the exact failure mode the
   brief's design note predicted: **a denied tool call is not by itself a pause.**
4. That `Bash` call was also **denied**, same hook payload, same `is_error: true` shape.
5. Only after the **second** denial did the model stop trying and end its turn on its own,
   narrating explicitly: *"Two of my three calls came back with 'Paused by AI Team OS. Stop and
   wait.' — so I'm holding here rather than continuing. ... Let me know when to proceed and I'll
   pick up from there."* `stop_reason: "end_turn"`, `terminal_reason: "completed"`, `is_error:
   false`, `num_turns: 4`. The final `result` event's `permission_denials` array carries both
   denied calls (`Read sum.test.js`, the `Bash` command).

**This run's process exited on its own, without the orchestrator needing to send a kill signal** —
but only because this particular model, on this particular prompt, chose to stop narrating after
two denials rather than continuing to probe. Nothing in the observed contract *guarantees* that
self-limiting behavior; a more persistent retry pattern (more tool alternatives available, a
different prompt framing) could plausibly continue longer, burning turns and cost before hitting a
stop. **The safe, deterministic pause contract for M3 cannot rely on the model choosing to stop —
the orchestrator must still treat the first observed deny event as the pause signal and terminate
the process itself**, even though in this specific run that step turned out to be unnecessary.

### 3.6 `bypassPermissions` vs. hook deny — confirmed: the hook wins

This run was launched with `--permission-mode bypassPermissions` throughout, and the hook's
`deny` decision **still took effect** for both blocked calls — visible directly in the
`is_error: true` tool results, the verbatim deny payload in `hook_response`, and the two entries in
the terminal `permission_denials` array. **This is a load-bearing positive finding for M3, not a
critical failure**: a `PreToolUse` hook's structured deny is not overridden by
`--permission-mode bypassPermissions`. The two mechanisms operate at different layers —
`bypassPermissions` short-circuits the *interactive* permission prompt (section 1), while a hook's
`permissionDecision: "deny"` is evaluated independently and still blocks the call. M3 can safely run
headless with `bypassPermissions` (required for edits to work at all, per section 1) while still
relying on the pause hook to intervene.

### 3.7 Working tree coherence

```bash
$ cd "$SPIKE_REPO" && git status --short
 M sum.js
 M sum.test.js
$ npm test
... 6 tests, 6 pass, 0 fail ...
```

No half-written file. The paused run (attempt 2) never attempted an `Edit` at all — its two denied
calls were both read-only/informational (`Read`, `Bash`) — so there was no in-flight write for the
hook to interrupt mid-byte in this particular run. `sum.js` and `sum.test.js` reflect attempt 1's
completed Calculator refactor, unchanged by attempt 2, and all 6 tests pass. This run does not by
itself prove an `Edit` call can never be interrupted mid-write (a hook fires *before* the tool
executes, per the `PreToolUse` contract, so a denied `Edit` should never partially apply — the tool
call is refused before it runs, not aborted while running — but this run's actual tool sequence
happened not to include an `Edit`, so this is inferred from the hook's documented pre-execution
timing, not directly observed here).

### 3.8 Answers to the brief's three questions

1. **Did the process exit after the deny, or did the model keep trying other tools?** Both, in
   sequence: it tried **one** alternate tool (`Bash` after `Read` was denied) before stopping on its
   own. Blocking alone did not immediately halt the model — confirming the brief's design note — but
   this model self-limited to a single retry rather than looping indefinitely. See 3.5 for why this
   is not something the pause contract can depend on.
2. **Is the session id still recoverable from the stream?** Yes — `"session_id":
   "836bde75-4577-4e87-9218-613cbc455774"` is present on every line of `/tmp/m0-run4.jsonl`,
   consistent with section 1's finding that `session_id` is a stable top-level field.
3. **Is the working tree in a coherent state (no half-written file)?** Yes — `git status --short`
   shows only the two files attempt 1's completed refactor touched, no partial/corrupt file, and
   `npm test` passes 6/6. Caveat: this run's denied calls were both read-only (`Read`, `Bash`), not
   `Edit` — see 3.7 for why "no half-written file" is confirmed for what this run actually denied,
   but the stronger claim ("an `Edit` specifically can never be interrupted mid-write") is inferred
   from the hook's pre-execution timing, not directly observed.

### 3.9 Resulting pause-mechanism definition for M3

Pause is confirmed to be **two-part**, exactly as the brief's design note predicted, and both parts
are now independently validated:

1. **The hook blocks the side effect.** `pause-gate.sh`, registered as a `PreToolUse` hook with
   `matcher: "*"` via an absolute path in `--settings`, reliably returns a structured
   `permissionDecision: "deny"` for every tool call while `$AITEAMOS_PAUSE_FLAG` exists — confirmed
   firing for `Skill`, `Read`, `Edit`, and `Bash` tool names, and confirmed **not** overridden by
   `--permission-mode bypassPermissions`.
2. **The orchestrator must terminate the process on observing the first deny event; it must not
   wait for the model to stop on its own.** The model tried a different tool once after being
   denied, then happened to stop itself in this run — but that stopping behavior is not part of any
   documented contract and cannot be relied upon. M3's `ClaudeCodeAdapter` must watch the event
   stream for a `system/permission_denied`-shaped signal (or, in this hook-based path, the
   `is_error: true` tool result following a hook deny) and kill the subprocess itself the moment it
   sees one, rather than treating "the hook returned deny" as sufficient by itself.

Session id remains recoverable and the working tree remains coherent across a pause, which is what
makes resume (Task 5) viable on top of this mechanism.

### 3.10 Post-review hardening: fail-safe behavior and no shared-default fallback

Task review returned two Important findings against `pause-gate.sh` — the one artifact from this
spike that survives into M3 unmodified. Both are fixed in the committed script. No new `claude` run
was needed for either fix; all verification below is the script exercised directly in isolation.

**Exit-code / output contract, made explicit (was previously implicit):**

- **Allow:** exit 0, empty stdout.
- **Deny:** exit 0, stdout is a single-line JSON object with
  `hookSpecificOutput.permissionDecision == "deny"`. Deny is carried entirely in the JSON *body*,
  not the exit code — both allow and deny exit 0 in every capture gathered across sections 3.3-3.9.
- **Write failure / crash:** exit 2, human-readable reason on stderr. This maps to Claude Code's
  documented general hook exit-code convention (0 = success, 2 = blocking error read from stderr,
  other nonzero = non-blocking warning). **This path was never exercised by an actual `claude` run
  in this spike** — no capture in sections 3.3-3.9 shows a nonzero-exit hook_response — so mapping
  a script crash to "the tool call gets blocked" rests on that general convention, not on evidence
  gathered here. Stated plainly so M3 does not treat it as confirmed: if that convention turns out
  not to hold, a crash could fail *open* (tool proceeds) rather than closed, and only a dedicated
  hook-crash test against a real Claude Code run would confirm which.

**Finding 1 fix — write failure can no longer produce an undefined exit status.** The script
previously ran under `set -euo pipefail` with an unconditional `printf …; exit 0` for the deny path:
if `printf` failed (broken stdout pipe, disk full), `-e` would abort the script before its own
`exit 0` ran, leaving the exit status to whatever `printf` returned — neither a clean allow nor a
well-formed deny. Fixed by dropping `-e` (kept `-u` and `-o pipefail`) and replacing the two
inline `printf` sites with a single `deny()` helper that explicitly checks the write's own exit
status: on success it exits 0 as before; on failure it prints a reason to stderr and exits 2,
matching the documented crash convention above rather than an accidental leftover status. The deny
payload is built as one string and written with one `printf '%s\n'` call — at this message length
(well under Linux's 4096-byte `PIPE_BUF`) the write to a pipe is atomic, so there is no
partially-delivered-JSON case for a payload this short; the failure mode is strictly all-or-nothing.

Verified directly (script invoked standalone, hook stdin payload simulated with `echo '{}' |`):

```bash
$ SCRIPT=/home/meren/projects/slave-of-ai/spike/m0-pause-resume/pause-gate.sh
$ FLAGFILE=/tmp/pause-gate-test-full.flag; touch "$FLAGFILE"
$ echo '{}' | AITEAMOS_PAUSE_FLAG="$FLAGFILE" "$SCRIPT" > /dev/full
pause-gate.sh: line 37: printf: write error: No space left on device
pause-gate.sh: failed to write deny payload (reason was: Paused by AI Team OS. Stop and wait.)
$ echo "exit status: $?"
exit status: 2
```

`/dev/full` deterministically fails every write with `ENOSPC`, giving a reproducible crash case
(an earlier attempt using a closed pipe reader (`... | :`) was racy and did not reliably trigger
the failure — not included as evidence for that reason). Exit 2 with a clear stderr reason,
confirmed.

**Finding 2 fix — removed the shared-default fallback; unset or empty `AITEAMOS_PAUSE_FLAG` now
denies loudly.** Previously `FLAG="${AITEAMOS_PAUSE_FLAG:-/tmp/aiteamos-pause.flag}"` meant every
run that forgot to set the variable would share the same hardcoded path — pausing one agent could
inadvertently pause an unrelated concurrent one sharing that default. Per the controller's ruling,
implemented exactly as specified rather than as a judgment call: an unset **or empty**
`AITEAMOS_PAUSE_FLAG` is now a configuration error, and the hook denies with a reason that names the
misconfiguration explicitly, using the same `deny()` path (exit 0, JSON body) as a normal pause —
not the exit-2 crash path — because exit-0-with-JSON-body is the mechanism this spike has actually
confirmed blocks a tool call (section 3.6); routing a misconfiguration through the unconfirmed
exit-2 path would risk it being silently ignored instead of loudly blocking.

**Why loud-deny and not the other two options (recorded here so M3 inherits the reasoning, not just
the behavior):** in an autonomous system running several agents concurrently, pause is the
operator's only intervention lever. Silently falling back to a shared path means pausing one agent
can freeze unrelated agents — and running agents in parallel is this product's entire premise.
Silently allowing instead would disable the intervention lever without anyone noticing — worse, not
better. Denying loudly is the least harmful of the three: it surfaces the misconfiguration at the
very first tool call of the affected run, rather than during an incident where two unrelated agents
turn out to have been sharing a pause flag.

Verified directly, all four required cases plus the crash case above:

```bash
$ SCRIPT=/home/meren/projects/slave-of-ai/spike/m0-pause-resume/pause-gate.sh

# Case A: flag var set, file PRESENT
$ FLAGFILE=/tmp/pause-gate-test-present.flag; touch "$FLAGFILE"
$ echo '{}' | AITEAMOS_PAUSE_FLAG="$FLAGFILE" "$SCRIPT"; echo "exit: $?"
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Paused by AI Team OS. Stop and wait."}}
exit: 0

# Case B: flag var set, file ABSENT
$ FLAGFILE=/tmp/pause-gate-test-absent.flag; rm -f "$FLAGFILE"
$ echo '{}' | AITEAMOS_PAUSE_FLAG="$FLAGFILE" "$SCRIPT"; echo "exit: $?"
exit: 0            # (empty stdout -- allow)

# Case C: AITEAMOS_PAUSE_FLAG UNSET
$ echo '{}' | env -u AITEAMOS_PAUSE_FLAG "$SCRIPT"; echo "exit: $?"
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"AITEAMOS_PAUSE_FLAG is unset or empty -- refusing to fall back to a shared default path. Set AITEAMOS_PAUSE_FLAG explicitly for this run before retrying."}}
exit: 0

# Case D: AITEAMOS_PAUSE_FLAG EMPTY string
$ echo '{}' | AITEAMOS_PAUSE_FLAG="" "$SCRIPT"; echo "exit: $?"
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"AITEAMOS_PAUSE_FLAG is unset or empty -- refusing to fall back to a shared default path. Set AITEAMOS_PAUSE_FLAG explicitly for this run before retrying."}}
exit: 0
```

All four match the expected behavior exactly: real pause denies with the pause reason, no pause
allows silently, and both unset and empty configuration deny loudly with a distinct,
operator-actionable reason — with no case falling through to a shared default path.

Two Minor findings from the review were deliberately not addressed here, per the controller's
explicit deferral: the `:-` vs `:?` bash-idiom nuance is subsumed by the finding-2 fix above (there
is no `:-` default left in the script at all), and the un-captured OS-level exit code detail is
left as a note for a future spike rather than acted on now.

## 4. Resume after pause with instruction injection

**Question:** after a hook-originated pause (section 3), can the operator resume the same session
with an injected instruction and have it obeyed — the mechanism the entire agent-messaging feature
("stop working on X, prioritise Y") depends on?

### 4.1 Precondition check — what session 4 actually left behind

Before resuming, the controller's ruling required checking what run 4
(`session_id: 836bde75-4577-4e87-9218-613cbc455774`, section 3.4–3.5) had actually done, since the
brief's framing ("continues the Calculator refactor") assumes it made real progress. It did not, and
the file-state history is more tangled than "denied at its second call" alone suggests:

- Run 4's own tool sequence was: `Read sum.js` (**allowed** — the pause flag was not yet set), then
  `Read sum.test.js` (**denied**), then `Bash 'ls -la && cat package.json && git diff --stat'`
  (**denied**), then the model stopped itself. Run 4 made **zero** `Edit` calls. It never wrote
  anything.
- The `Calculator` class that `Read sum.js` observed on disk was **not written by this session at
  all**. It was written by a completely different, unrelated process: "attempt 1", the misfire run
  from section 3.4 that used the broken `read -t < /dev/null` delay primitive and ran to completion
  unpaused. That run's own capture (`/tmp/m0-run4-attempt1-misfire.jsonl`) carries
  `session_id: 24567253-d460-4335-b628-b13fae22564f` — a session with no relationship to
  `836bde75-...` whatsoever, sharing nothing but the same working directory.

So going into the resume: session `836bde75-...`'s entire pre-pause history consists of one
successful `Read` (of a file it did not write) and two denied calls. It has no edit history of its
own to "continue." Any claim that the resumed run "picked up the refactor where it left off" would
be false — there was no refactor in progress *in this session* to pick up. This is stated plainly
per the controller's ruling rather than smoothed over.

### 4.2 Exact command executed

```bash
export AITEAMOS_SPIKE="/home/meren/projects/slave-of-ai/spike/m0-pause-resume"
export AITEAMOS_PAUSE_FLAG=/tmp/aiteamos-pause-run5.flag
export SPIKE_REPO="$HOME/.aiteamos-spike/sample-repo"

# Verified absent immediately after export, before any tool call could run:
$ ls -la "$AITEAMOS_PAUSE_FLAG"
ls: cannot access '/tmp/aiteamos-pause-run5.flag': No such file or directory

rm -f "$AITEAMOS_PAUSE_FLAG"
cd "$SPIKE_REPO"
SID4=$(grep -o '"session_id":"[^"]*"' /tmp/m0-run4.jsonl | head -1 | cut -d'"' -f4)
# SID4 = 836bde75-4577-4e87-9218-613cbc455774

claude -p "You were paused by the operator. New instruction: name the class MathKit instead of Calculator, then continue and finish the refactor." \
  --resume "$SID4" --settings "$AITEAMOS_SPIKE/settings.json" \
  --permission-mode bypassPermissions \
  --output-format stream-json --verbose 2>&1 | tee /tmp/m0-run5.jsonl
```

This differs from the brief's suggested Step 1 command in one respect: `--permission-mode
bypassPermissions` was added, per the controller's explicit constraint 3 and consistent with
sections 1 and 3.6 — without it the `Edit` calls needed to perform the rename would be silently
denied under headless mode's default permission posture, and the run would appear to succeed while
changing nothing. `--include-hook-events` (used in run 4, section 3.3–3.4) was **not** included this
time — the brief's Step 1 command doesn't call for it and the controller's command did not add it —
so, unlike run 4, this run's raw capture has no `hook_started`/`hook_response` lines
(`grep -c hook_response /tmp/m0-run5.jsonl` → `0`). Whether `pause-gate.sh` fired an *allow* on each
of this run's tool calls is therefore **inferred** from the absence of denial signals (empty
`permission_denials`, no `is_error:true` tool results, no `AITEAMOS_PAUSE_FLAG` file ever created
during the run), not directly observed the way run 4's denials were.

Exit code: `0`. Raw capture: `/tmp/m0-run5.jsonl`, 34 lines, all 34/34 verified to parse as
standalone JSON (per-line `json.loads`, same method as prior sections). Not committed (throwaway,
consistent with this spike's other raw captures).

### 4.3 Session id: same as run 4, not a new one

```bash
$ grep -o '"session_id":"[^"]*"' /tmp/m0-run5.jsonl | sort -u
"session_id":"836bde75-4577-4e87-9218-613cbc455774"
```

Every line carries the same UUID run 4 reported — consistent with section 2's finding that `--resume`
reuses the session id.

### 4.4 Was the injected instruction obeyed? Observed: yes

The rename tool sequence, parsed from `/tmp/m0-run5.jsonl` (`type:"assistant"` lines with `tool_use`
blocks, in order):

1. Assistant text: *"Resuming with the new name."*
2. `Read sum.test.js` — the file run 4 was **denied** reading (section 3.5). Result: file content,
   showing `import { Calculator } from './sum.js';` etc.
3. `Bash 'ls -la && cat package.json && grep -rn "Calculator" ...'` — succeeded, confirms baseline
   state.
4. `Bash 'npm test'` — 6/6 pass, baseline confirmed green before touching anything.
5. `Edit sum.js`: `old_string: "export class Calculator {"` → `new_string: "export class MathKit {"`.
6. `Bash 'npm test'` — 1 failure (`sum.test.js` still imports `Calculator`) — an **expected**
   intermediate failure, not a bug; the assistant's own text calls it out as such before fixing it.
7. `Edit sum.test.js`: `import { Calculator } from './sum.js';\n\nconst calculator = new Calculator();`
   → `import { MathKit } ...` / `const mathKit = new MathKit();`.
8. `Edit sum.test.js` (`replace_all: true`): `calculator.` → `mathKit.` (updates all six call sites).
9. `Bash 'npm test && grep -rn "Calculator\|calculator" ...'` — 6/6 pass, no leftover references.

Final assistant text (verbatim, in part): *"Done. 6/6 tests pass, no leftover `Calculator`
references."* Final `result` event: `"is_error":false`, `"stop_reason":"end_turn"`,
`"terminal_reason":"completed"`, `"permission_denials":[]`, `"num_turns":9`,
`"total_cost_usd":0.22231250000000002`.

Verified independently against the working tree after the run (Step 2 of the brief, exact commands):

```bash
$ cd "$SPIKE_REPO" && grep -l "MathKit" *.js
sum.js
sum.test.js

$ grep -l "Calculator" *.js; echo "grep_exit=$?"
grep_exit=1        # no match in any .js file — Calculator is fully gone

$ git diff --stat
 sum.js      | 21 +++++++++++++++++++--
 sum.test.js | 28 +++++++++++++++++++++++++---
 2 files changed, 44 insertions(+), 5 deletions(-)

$ npm test
✔ add adds two numbers (0.455584ms)
✔ subtract subtracts the second number from the first (0.077188ms)
✔ subtract returns a negative result when the second number is larger (0.056932ms)
✔ multiply multiplies two numbers (0.542737ms)
✔ divide divides two numbers (0.10309ms)
✔ divide throws on division by zero (0.218695ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

`git diff sum.js sum.test.js` (against the pre-refactor `sum`-function baseline, since neither file
had been committed since the spike began) confirms `export class MathKit` with all four methods and
`sum.test.js` importing/instantiating `MathKit` as `mathKit` throughout. **The injected instruction
was obeyed: fully, correctly, and confirmed both in the stream and independently in the working
tree.**

### 4.5 Did the resumed agent show awareness of the interrupted intent, or start cold? Observed: awareness, at a granular level

Two independent pieces of directly observed evidence, not inference:

**(i) It read exactly what it didn't already know, and nothing more.** Run 5 opens by
re-`Read`-ing `sum.test.js` — the one file whose content run 4 was **denied** access to
(section 3.5, denial #1). It does **not** re-`Read` `sum.js` before editing it — the one file run 4
*had* successfully read before the pause. Its `Edit sum.js` call's `old_string` —
`"export class Calculator {"` — matches, character for character, the content run 4's earlier
successful `Read sum.js` returned (`/tmp/m0-run4.jsonl`, tool result: `"1\texport class Calculator {\n2\t  add(a, b) {..."`).
This is the same "edit without re-reading" signature section 2 documented for run 3's plain resume
(2.4, "Context carried over"), and it lines up exactly with what this session did and did not
actually see before being paused — not a coincidence, and not something a cold start (a fresh
session with no prior turns) could reproduce, since a cold session would have no `Calculator` text
in context to anchor an edit on without reading the file first.

**(ii) It re-attempted, verbatim in intent, both actions the hook had denied.** Run 4's two denials
were `Read sum.test.js` and `Bash 'ls -la && cat package.json && git diff --stat'` (section 3.5).
Run 5's first two tool calls after resuming are exactly those two actions, retried:
`Read sum.test.js` (step 2 above) and a near-identical `Bash 'ls -la && cat package.json && grep -rn
"Calculator" ...'` (step 3 above). The model picked up precisely the two threads that had been cut
off, in the same order it had originally attempted them.

**(iii) It recalled an instruction from the original prompt that was never repeated in the resume
prompt.** The resume prompt (section 4.2) says only "name the class MathKit instead of Calculator,
then continue and finish the refactor" — it does not mention testing cadence. Run 4's *original*
prompt (section 3.4) was "Refactor sum.js into a Calculator class ... **Run npm test after each
change**." Run 5's own final summary states: *"Test runs, per your after-each-change instruction:
1. Baseline before touching anything — 6/6 pass. 2. After renaming the class in `sum.js` — 1
failure... 3. After updating the test file — 6/6 pass."* — and its tool sequence (steps 4, 6, 9
above) does in fact run `npm test` after each edit, unprompted by the resume message itself. This
instruction could only have come from the pre-pause turn of the same session.

The assistant's own text also states this explicitly, unprompted: *"when I resumed, the class-based
refactor itself was already in place in the working tree (uncommitted) — `sum.js` had a `Calculator`
class with all four methods, and `sum.test.js` already exercised them through an instance. So the
work this turn was the rename, not the original refactor."* — which is also the correct, honest
framing per 4.1: it correctly attributes the pre-existing `Calculator` code to the state of the
working tree rather than claiming credit for having refactored it itself in a prior turn.

**Conclusion for (c): observed, not inferred.** The resumed agent did not start cold. Its choice of
what to re-check versus what to trust from memory matched, call for call, what this specific session
had and had not been able to observe before the pause, and it carried forward a testing-cadence
instruction from the original (pre-pause) prompt that was not restated in the resume prompt.

### 4.6 What, if anything, was lost across the pause boundary

Nothing was observed to be lost. The only things "missing" from run 5 relative to a hypothetical
uninterrupted run — the content of `sum.test.js` and the output of the `ls`/`cat`/`git diff` probe —
are exactly the two things run 4 was denied and therefore never actually obtained in the first
place; re-fetching them in run 5 is recovery of information genuinely absent from context, not lost
memory. Everything run 4 *did* successfully observe (the content of `sum.js`) and everything from
the original pre-pause prompt (the "run npm test after each change" instruction) both carried
forward intact into run 5, per 4.5. No evidence of session amnesia was observed in this run.

### 4.7 Answers to the three narrowed questions (per the controller's ruling)

1. **Does resume after a hook-pause work at all?** **Observed: yes.** `claude -p ... --resume
   "$SID4"` against the same session id run 4 reported, with the pause flag cleared and
   `AITEAMOS_PAUSE_FLAG` pointed at a verified-absent path, exited `0`, reported the same session id
   throughout, executed three `Edit` calls and four `Bash` calls (seven mutating-capable tool calls,
   matching 4.4's itemization) with no denials (`"permission_denials":[]`), and its file changes are
   independently confirmed on disk and by a passing test suite (4.4). A hook-originated pause does
   not brick the session — resume is a normal `--resume` call once the flag is cleared and the
   environment is configured correctly. Caveat, per 4.2: the *outcome* (completed run, no denials) is
   directly observed here; that the outcome reflects `pause-gate.sh` explicitly returning allow on
   each call, rather than the hook simply not firing, is inferred, not observed — this run did not
   use `--include-hook-events`.

2. **Is the injected instruction honoured (`MathKit`, not `Calculator`)?** **Observed: yes**, fully.
   `grep -l "MathKit" *.js` matches both files; `grep -l "Calculator" *.js` matches none; the actual
   diff (4.4) shows a clean rename with every call site updated; all 6 tests pass. This is the direct
   evidence the product's agent-messaging feature needs: an operator-injected instruction delivered
   via a resume prompt was followed exactly, not partially or approximately.

3. **Does the resumed agent show awareness of the interrupted intent rather than starting cold?**
   **Observed: yes**, at a level more granular than "it remembered the topic" — its choice of what
   to re-verify versus what to trust from memory tracked precisely what this session had and had not
   been allowed to see before the pause (4.5-i, ii), and it carried forward an instruction from the
   original prompt that was absent from the resume prompt (4.5-iii). What is **not** supported by
   this evidence — flagged explicitly per the controller's ruling — is any claim that the agent
   "continued the Calculator-to-MathKit refactor from where it left off": there was no refactor in
   this session's own history to continue (4.1). What the evidence supports instead is narrower and
   still significant: the *session's conversational context* (what it had read, what it had been
   told, what it had been denied) survived the pause boundary intact and shaped its behavior on
   resume, even though the *file-editing work product* did not originate from this session at all.

### 4.8 Verdict for M3

Pause → instruct → resume works as a mechanism: clear the flag, resume the session id, deliver the
new instruction as the resume prompt, and the CLI treats it as an ordinary next turn with full prior
context, no special resume-after-pause handling required on the CLI side. The one operational
requirement `ClaudeCodeAdapter` must get right is exactly what tripped up this spike's own two
earlier attempts (section 3.2, 3.4): the orchestrator, not the model, owns clearing the pause
condition and choosing what instruction to inject — the CLI does not know or care that a resume
follows a hook-originated pause rather than a plain conversational gap (section 2). Operator messages
queued during a pause can be delivered exactly this way: as the prompt text of a `--resume` call
issued after the pause flag is cleared.

## 5. Worktree isolation

**Question:** does a headless run confined to a git worktree leave `main` untouched, and do two
agents running at the same time in sibling worktrees genuinely not interfere with each other? This
is the parallelism premise the whole product rests on: one worktree per task, several agents
active at once against the same repository.

### 5.0 Settings file: not used

No `--settings` file was used for any of this section's three runs. Constraint 3 requires that
*if* a settings file (i.e. the pause hook) is installed, `AITEAMOS_PAUSE_FLAG` must be exported to a
verified-nonexistent path or every tool call is denied by design. This task does not exercise the
pause hook, so the simplest correct choice — no settings file at all — was taken. All three runs
below used only `-p`, `--output-format stream-json`, `--verbose`, and `--permission-mode
bypassPermissions`.

### 5.1 Step 1 — single worktree, exact commands executed

```bash
export SPIKE_REPO="$HOME/.aiteamos-spike/sample-repo"
cd "$SPIKE_REPO"
git worktree add -b aiteamos/TASK-001-greeting .aiteamos/worktrees/TASK-001
cd .aiteamos/worktrees/TASK-001
claude -p "Add a greet(name) function to a new file greet.js, with a test in greet.test.js. Then commit your work with message 'feat: add greet'." \
  --output-format stream-json --verbose --permission-mode bypassPermissions > /tmp/m0-run6.jsonl 2>&1
```

One deviation from the brief: `--permission-mode bypassPermissions` was added, and `tee` was
dropped in favor of a plain redirect (`>`) — same reasoning as section 1, and required by
constraint 2 for the edit/commit tools to work at all in headless mode. Exit code `0`. Raw capture:
`/tmp/m0-run6.jsonl`, 59 lines, all 59/59 verified to parse as standalone JSON (per-line
`json.loads`). `session_id`: `b8c4b4b3-8042-44fd-aab7-66feb03a4493`, top-level on every line,
consistent with section 1.

The agent worked red-green: `Read` on `sum.js`/`sum.test.js` first, wrote a failing
`greet.test.js`, ran `npm test` (observed failing, `ERR_MODULE_NOT_FOUND`), wrote `greet.js`, ran
`npm test` again (2/2 passing), then committed. Its first `git commit` attempt failed with `Exit
code 128 / Author identity unknown` (this worktree's repository has no `user.name`/`user.email`
configured anywhere — see 5.5); it then ran `git config user.name "spike" && git config
user.email "spike@local"` before committing successfully. Final `result` event:
`"is_error":false`, `"terminal_reason":"completed"`, `"permission_denials":[]`, `"num_turns":13`.

### 5.2 Step 2 — verify isolation, exact commands and output

```bash
$ git -C "$SPIKE_REPO/.aiteamos/worktrees/TASK-001" log --oneline -3
7f19319 feat: add greet
60370cd chore: sample repo

$ ls "$SPIKE_REPO/.aiteamos/worktrees/TASK-001"/greet.js "$SPIKE_REPO/.aiteamos/worktrees/TASK-001"/greet.test.js
greet.js
greet.test.js

$ git -C "$SPIKE_REPO/.aiteamos/worktrees/TASK-001" status --short
# (empty — clean working tree)

$ cd "$SPIKE_REPO" && git log --oneline -1
60370cd chore: sample repo

$ ls greet.js
ls: cannot access 'greet.js': No such file or directory

$ git status --short
 M sum.js
 M sum.test.js
?? .aiteamos/
```

**Confirmed exactly as expected, and matching the brief's prediction:** the commit (`7f19319 feat:
add greet`) and `greet.js`/`greet.test.js` exist only on branch `aiteamos/TASK-001-greeting`
inside the worktree. `main` is still at `60370cd chore: sample repo` — the pre-existing commit —
with no `greet.js`, and its only changes are the pre-existing uncommitted `sum.js`/`sum.test.js`
edits noted in the controller's constraint 4 (untouched, as instructed) plus the new `.aiteamos/`
directory itself showing as untracked (`?? .aiteamos/`) — expected, since the worktrees directory
was created inside the main working tree's path but nothing under it belongs to `main`'s branch.
`git worktree list` at this point showed both entries pointing at distinct commits:

```
/home/meren/.aiteamos-spike/sample-repo                              60370cd [main]
/home/meren/.aiteamos-spike/sample-repo/.aiteamos/worktrees/TASK-001 7f19319 [aiteamos/TASK-001-greeting]
```

### 5.3 Step 3 — two agents concurrently in separate worktrees, exact command executed

Per constraint 1, this ran as a single foreground `Bash` call (timeout raised to `600000` ms) using
shell job control (`&` / `wait`), with no `run_in_background`/monitor tooling:

```bash
export SPIKE_REPO="$HOME/.aiteamos-spike/sample-repo"
cd "$SPIKE_REPO"
git worktree add -b aiteamos/TASK-002-upper .aiteamos/worktrees/TASK-002

( cd "$SPIKE_REPO/.aiteamos/worktrees/TASK-001" && claude -p "Add a farewell(name) function with a test, then commit." \
    --output-format stream-json --verbose --permission-mode bypassPermissions > /tmp/m0-p1.jsonl 2>&1 ) &
PID1=$!
( cd "$SPIKE_REPO/.aiteamos/worktrees/TASK-002" && claude -p "Add an upper(text) function with a test, then commit." \
    --output-format stream-json --verbose --permission-mode bypassPermissions > /tmp/m0-p2.jsonl 2>&1 ) &
PID2=$!

wait $PID1; RC1=$?
wait $PID2; RC2=$?
```

Deviation from the brief: `--permission-mode bypassPermissions` added to both invocations (same
reasoning as 5.1). Result: `RC1=0`, `RC2=0`. Raw captures: `/tmp/m0-p1.jsonl` (51 lines, 51/51
parse), `/tmp/m0-p2.jsonl` (45 lines, 45/45 parse — both checked with the same per-line
`json.loads` method as prior sections). Distinct session ids observed:
`047bf13b-132c-4e44-ac19-d6bfddaf9e6a` (p1, TASK-001) and `0755a19f-ef6d-4b9c-9815-9d3a8606e519`
(p2, TASK-002) — each run's own new session, not a resume.

### 5.4 Evidence of independence: branches, files, and refs

```bash
$ git -C "$SPIKE_REPO/.aiteamos/worktrees/TASK-001" log --oneline -3
bd75aa1 feat: add farewell
7f19319 feat: add greet
60370cd chore: sample repo

$ git -C "$SPIKE_REPO/.aiteamos/worktrees/TASK-002" log --oneline -3
a152039 feat: add upper(text) function
60370cd chore: sample repo
```

TASK-001's branch advanced with exactly one new commit on top of its own prior history (the
`greet` commit from 5.1) — `farewell`, its own work, and nothing from TASK-002. TASK-002's branch
advanced with exactly one commit — `upper`, its own work — directly on the shared `60370cd` base,
with no `farewell`/`greet` commits and no `greet.js`/`farewell.js` files present:

```bash
$ ls "$SPIKE_REPO/.aiteamos/worktrees/TASK-001"
farewell.js  farewell.test.js  greet.js  greet.test.js  package.json  sum.js  sum.test.js

$ ls "$SPIKE_REPO/.aiteamos/worktrees/TASK-002"
package.json  sum.js  sum.test.js

$ ls "$SPIKE_REPO/.aiteamos/worktrees/TASK-001"/upper*
ls: cannot access '...': No such file or directory   # confirmed absent

$ ls "$SPIKE_REPO/.aiteamos/worktrees/TASK-002"/greet* "$SPIKE_REPO/.aiteamos/worktrees/TASK-002"/farewell*
ls: cannot access '...': No such file or directory   # confirmed absent, both
```

TASK-002's agent chose to add `upper()` directly into the existing `sum.js`/`sum.test.js` (its own
judgment call, since the prompt did not name a target file) rather than a new file — noted because
it means the two runs' outputs are structurally different (new files vs. edited existing files),
which makes the absence-of-cross-contamination check above meaningful rather than coincidental (a
shared new filename could not have collided by accident either way, but the file lists show no
trace of either run's specific content in the other's tree).

Refs after both runs, confirming two independent branch tips with no shared-ref writes:

```bash
$ git -C "$SPIKE_REPO" for-each-ref refs/heads --format='%(refname) %(objectname:short)'
refs/heads/aiteamos/TASK-001-greeting bd75aa1
refs/heads/aiteamos/TASK-002-upper a152039
refs/heads/main 60370cd
```

`main` after the concurrent step: still `60370cd`, still only the pre-existing `sum.js`/
`sum.test.js` uncommitted diff plus the untracked `.aiteamos/` directory — unchanged from 5.2.

### 5.5 Watch-item 1 — git lock contention: none observed

Both raw captures (`/tmp/m0-p1.jsonl`, `/tmp/m0-p2.jsonl`) and the single-worktree capture
(`/tmp/m0-run6.jsonl`) were searched directly:

```bash
$ grep -iE "index\.lock|unable to create|already exists|fatal: .*lock" /tmp/m0-p1.jsonl /tmp/m0-p2.jsonl /tmp/m0-run6.jsonl
# (no match, grep exit 1)
```

No index-lock, ref-lock, or "unable to create lock file" error appears anywhere in any of the
three captures. Both concurrent `git commit` operations succeeded (`RC1=0`, `RC2=0`) even though
they share the same `.git` directory (`git rev-parse --git-common-dir` returns
`.../sample-repo/.git` from both worktrees — confirmed directly). This is consistent with why no
contention occurred: each commit only needs to lock and update its own ref
(`refs/heads/aiteamos/TASK-001-greeting` vs. `refs/heads/aiteamos/TASK-002-upper`) — two distinct
files under `.git/refs/heads/`, not the same file — so there was no shared ref for the two
`git commit`s to race on. This spike ran exactly two concurrent commits; it does not establish
what happens if two agents ever commit to the *same* branch/ref concurrently (out of scope here —
M3's one-worktree-per-task design should not produce that case in the first place, but if it ever
does, this finding does not cover it).

**One genuine, evidence-backed non-isolation finding surfaced here, and it is first-class for
M3's orchestrator:** local git identity (`user.name`/`user.email`) is **not** per-worktree state —
it lives in the single shared `.git/config` file (`extensions.worktreeConfig` is unset in this
repo, confirmed with `git config --get extensions.worktreeConfig` returning exit 1/empty), which
every worktree of the same repository reads and writes by default. Direct evidence, both commit
attempts timestamped from the raw captures:

- `18:34:04.288Z` — TASK-001's agent (p1) attempts `git commit` with no identity set; fails, `Exit
  code 128`, `Author identity unknown`.
- `18:34:06.165Z` — TASK-002's agent (p2) attempts `git commit`, independently, ~2s later; fails
  the same way.
- `18:34:10.608Z` — TASK-001's agent runs `git config user.name "spike" && git config user.email
  "spike@local"` (a **persistent, shared** write — no `--local`/`--worktree` scoping, so it lands
  in the shared `.git/config`) and commits successfully.
- `18:34:14.016Z` — TASK-002's agent, instead of retrying a plain `git commit` against whatever
  shared config might now exist, commits with `git -c user.name="meren" -c
  user.email="erenaltan@gmail.com" commit ...` — a **per-invocation** override, not a persistent
  write, using an identity it apparently derived from this session's own context.

Both commits ended up correctly attributed to the identity each agent intended
(`bd75aa1` authored `spike <spike@local>`; `a152039` authored `meren <erenaltan@gmail.com>`,
confirmed via `git show --stat`), so **no functional collision occurred in this run** — but that
outcome depended on TASK-002 choosing a non-persistent `-c` override rather than also writing to
the shared config. Confirmed after the fact: `cat "$SPIKE_REPO/.git/config"` shows a single
`[user]` block with `name = spike` / `email = spike@local` — TASK-001's write, visible from
*both* worktrees, and the only surviving identity in shared config. Had two concurrent agents both
chosen to persist a `git config user.*` write with different values, the second write would
silently overwrite the first, and a build system replaying a divergent identity requirement per
task could get unpredictable attribution. **Recommendation for M3:** the orchestrator should pin
git identity for every worktree explicitly and non-persistently — either `git -c user.name=... -c
user.email=...` per invocation (what TASK-002's agent did on its own) or, if configuring it once is
preferred, `git config --worktree user.name ...` after first running `git config
extensions.worktreeConfig true`, so identity does not leak across sibling worktrees. This was not
tested directly (out of scope, discovered as a side effect of this section's runs, not a planned
Step), so it is reported as an observation plus a recommendation, not a verified fix.

### 5.6 Watch-item 2 — untracked state (`node_modules`) in fresh worktrees

Neither worktree ever had a `node_modules` directory at any point (`ls .../TASK-001/node_modules`
and `.../TASK-002/node_modules` both `No such file or directory`, checked after both runs
completed), and this caused **no problem** in this spike, for one specific reason established by
inspecting `package.json`:

```json
{
  "name": "sample-repo",
  "version": "1.0.0",
  "type": "module",
  "scripts": { "test": "node --test" }
}
```

The sample repo has **no dependency entries at all** — `npm test` runs `node --test`, Node's
built-in test runner, which needs nothing installed. `npm test` was run by name in all three
agent sessions (`grep`-confirmed tool calls: `npm test` appears in run6, p1, and p2's tool-call
sequences) and succeeded every time straight out of a fresh `git worktree add`, with no `npm
install` or `npm ci` ever attempted or needed (`grep -io "npm install\|npm ci" ...` across all
three captures: no match).

**This does not establish that a fresh worktree is safe for `npm test` in general** — it establishes
only that this specific fixture repo has zero npm dependencies, so the missing-`node_modules`
question never actually got exercised. **First-class caveat for M3's worktree setup step:** any
real target repository with actual dependencies (anything with a non-empty `dependencies`/
`devDependencies` in `package.json`) would need `npm install` (or a shared/symlinked
`node_modules`, or a package-manager cache) run as an explicit setup step after `git worktree add`
and before any test/build command — this spike's fixture happens to sidestep that requirement
entirely rather than proving it unnecessary. M0/M1 should not generalize "tests just worked" from
this repo to real target repos.

### 5.7 Watch-item 3 — were the concurrent runs genuinely independent?

**Yes, on every axis actually checked:**

- **Process-level:** two separate `claude` subprocesses, two separate PIDs, two separate exit
  codes (both `0`), two separate session ids (`047bf13b-...` / `0755a19f-...`).
- **Branch-level:** each worktree's branch advanced with exactly the commit that agent made and no
  other (5.4) — `farewell` only on TASK-001's branch, `upper` only on TASK-002's branch.
- **File-level:** neither run's output files appear in the other's tree — confirmed by direct `ls`
  checks for the other run's expected filenames in each worktree (5.4), not inferred from the
  commit log alone.
- **Ref-level:** the two commits landed on two distinct ref files under `.git/refs/heads/`, so
  there was no shared ref for the two `git commit`s to contend over, and no lock error was observed
  anywhere in either capture (5.5).
- **`main`-level:** `main` remained at `60370cd` throughout, with only its pre-existing (out of
  scope, per controller constraint 4) uncommitted diff and the new untracked `.aiteamos/` directory
  — untouched by either concurrent run.

**One qualification, not a contradiction:** git identity configuration (`.git/config`) is shared,
mutable, repo-wide state that both concurrent agents touched (5.5). In this run the two agents'
choices (a persistent write vs. a per-invocation override) happened not to collide, and both
commits ended up correctly attributed — but this is process independence with one shared-state
seam, not total filesystem isolation. Everything that actually constitutes "the work" (branches,
commits, tracked files) was fully independent; the one piece of shared state observed
(`user.name`/`user.email` in `.git/config`) did not affect either commit's *content* or which
*branch* it landed on, only which identity string it could have ended up attributed to had both
agents made the same scoping choice.

Raw captures on disk (throwaway, not committed, consistent with the rest of this spike):
`/tmp/m0-run6.jsonl` (Step 1, single worktree), `/tmp/m0-p1.jsonl` (Step 3, TASK-001/farewell),
`/tmp/m0-p2.jsonl` (Step 3, TASK-002/upper).

## 6. Verdict and consequences for M3

This section is synthesis only. It adds no new measurement — every claim below either cites a
section above or is explicitly labelled **Inferred**, **Recommendation**, or **Open question**.
The binding form of these consequences is `docs/decisions/0001-pause-semantics.md` (ADR 0001);
this section is the reasoning that produced it.

### 6.1 The verdict

**Yes — with one correction to the spec's mental model.** A Claude Code run can be paused at a
tool-call boundary and resumed from its session id, and a human instruction injected on resume is
obeyed: a `PreToolUse` hook returning `permissionDecision: "deny"` reliably blocks every tool call
while a per-run flag file exists (3.3–3.6), the session id survives unchanged (2.3, 4.3), and
`claude -p "<new instruction>" --resume <sessionId>` picks the session up with its pre-pause
context intact and follows the injected instruction exactly (4.4–4.5). The correction is that
**pause is not something the hook does — it is something the orchestrator does, using the hook.**
The hook removes the agent's ability to cause side effects; it does not stop the agent. In the one
run where a pause was actually triggered, the model responded to the first deny by trying a
*different* tool, and only stopped after the second deny (3.5). The pause therefore has two parts,
and M3 owns the second one.

Two halves of the spike's question were verified separately and never together, and honesty
requires saying so: **resume was only ever exercised in the main working tree, never inside a
worktree** (2.2, 4.2 both ran from `$SPIKE_REPO`; the three worktree runs in section 5 were all
fresh `-p` runs with no `--resume`). See open question **Q1**.

**Gate check (brief, Task 7):** the gate fires only if pause at tool-call boundaries turned out
*not* to be achievable. It is achievable. Part 2 proceeds unchanged and the `RunStatus` pause
branch keeps its intended meaning; no restatement is required.

### 6.2 The mechanism, as measured

1. **Launch posture is not optional.** A headless run must be launched with an explicit non-default
   permission posture or its edit tools do nothing: under the default mode with no TTY, every `Edit`
   was answered with a `system/permission_denied` event and an `is_error: true` tool result, and the
   run still terminated normally — `stop_reason: "end_turn"`, `terminal_reason: "completed"`,
   `is_error: false` on the terminal `result` event — a full event stream that landed nothing
   (1, "Permission behaviour"). Nothing in the run's terminal event distinguishes this from a
   successful run; only `permission_denials` being non-empty does.
2. **The hook's deny survives `bypassPermissions`** (3.6). This is the load-bearing finding: the
   permission posture in (1) is mandatory, so a pause mechanism that `bypassPermissions` overrode
   would be unusable. The two mechanisms are independent layers.
3. **The orchestrator sets a per-run flag file** (`AITEAMOS_PAUSE_FLAG`, unique per run — the
   script refuses to fall back to a shared default and denies loudly if the variable is unset or
   empty, 3.10).
4. **The hook denies the next tool call**, and every one after it, with a stable reason string that
   the model reads and quotes back (3.5).
5. **The orchestrator kills the process on the first observed deny.** See 6.5.
6. **A checkpoint is persisted, then resume is a plain `--resume`.** The CLI has no notion that a
   resume follows a pause; it treats the resume prompt as an ordinary next turn (4.8).

### 6.3 `ProviderCapabilities` for the Claude Code adapter

| Flag | Value | Evidence |
|---|---|---|
| `canPauseMidRun` | `true` | **Observed** (3.3–3.6). Qualified: the pause lands at the *next* tool-call boundary, not instantly, and it is the orchestrator's kill that makes it a pause. |
| `canResumeSession` | `true` | **Observed** (2.3–2.4, 4.3–4.5). **Provisional** in one respect: never exercised inside a worktree (Q1) and never after an orchestrator-initiated kill (Q2). |
| `supportsHooks` | `true` | **Observed** (3.3): a `PreToolUse` hook with `matcher: "*"` fired for `Skill`, `Read`, `Edit`, and `Bash`, registered by absolute path via `--settings`. |
| `streamsToolCalls` | `true` | **Observed** (1): NDJSON, one JSON object per line, `tool_use` blocks with `tool_use_id` on `assistant` events, paired with `tool_result` on `user` events. |
| `reportsTokenUsage` | `true` | **Observed** (1): `message.usage` per assistant event; aggregated `usage`, `modelUsage`, and `total_cost_usd` on the terminal `result` event. |
| `supportsCustomSystemPrompt` | `false` (for now) | **Not measured at all.** No run used a system-prompt flag and section 0's flag inventory does not record one. `false` is the fail-safe direction: it makes the orchestrator put standing instructions into the prompt rather than depend on an unverified surface. Flip it only after a measurement (Q4). |
| `enforcesToolPermissions` | `true` | **Observed but narrower than the name suggests** — see 6.6.1. Enforcement exists via `--permission-mode` (1) and via the `PreToolUse` hook (3.6). `--allowedTools` / `--disallowedTools` were **never exercised** — they appear only in section 0's `--help` inventory. |

### 6.4 What a `Checkpoint` must actually contain

Spec §8 proposes `{ sessionId, lastCompletedStep, worktreeCommit, filesTouched, ts }`. Measurement
supports the shape but sharpens three fields and adds two:

- **`sessionId` — required, written once, never rewritten.** **Observed** (2.3, 4.3): a plain
  `--resume` reports the *same* UUID, not a new one. The id captured from the run's first
  `system/init` line stays valid across every subsequent resume. This holds only while
  `--fork-session` is never passed (0, 2.3) — M3 must not pass it.
- **`worktreePath` — required, and new.** Resume must be spawned with its working directory set to
  the same path the run started in. This is a **Recommendation** driven by Q1: since resume inside a
  worktree was never exercised, the checkpoint must at minimum carry the exact path so the adapter
  can reproduce it rather than guess.
- **`pauseFlagPath` — required, and new.** `AITEAMOS_PAUSE_FLAG` is per-run and must be cleared and
  verified absent before resuming (4.2); an unset or empty value makes the hook deny every call
  (3.10). Without this field a resume cannot reliably un-pause itself. **Observed** requirement.
- **`lastCompletedStep` → `{ lastToolUseId, lastToolName, numTurns }`.** There is no "step" in the
  stream. What exists is `tool_use_id` per call and `num_turns` on the terminal event (1). Define
  the field in those terms or it cannot be populated.
- **`deniedToolUseIds` — new.** The terminal `result` event's `permission_denials` array carries
  every call the hook blocked, with `tool_name`, `tool_use_id`, and `tool_input` (3.5). Worth
  persisting: on resume the model re-attempted precisely those calls, in order (4.5-ii), so this is
  the operator's view of "what the agent was about to do when you stopped it."
- **`headCommit` + `dirtyFiles` (spec's `worktreeCommit` / `filesTouched`) — required.**
  **Recommendation**, motivated by a real observation: in 4.1 the code on disk was written by a
  *different, unrelated session* that merely shared the directory. A checkpoint recording only a
  session id cannot tell an operator what tree the session was looking at. Note that `HEAD` alone is
  insufficient — the interesting state throughout this spike was uncommitted, so record
  `git status --porcelain` alongside `git rev-parse HEAD`.
- **`cumulativeCostUsd` — required, but see Q3.** Each run segment emits its own `total_cost_usd`
  (1, 2.4). Whether a resumed run's figure is that segment's cost or the session's cumulative cost
  was **not determinable** from the captures. The budget guardrail (spec §9.2) depends on the
  answer.

### 6.5 Must the orchestrator kill the process after a deny? Yes.

**Observed** (3.5): after the first deny the model did not stop. It tried a different tool to obtain
the same information by another route, was denied again, and only then ended its turn on its own,
seven seconds later, with no external kill. That self-stop is a property of this model on this
prompt, not of any documented contract; a more persistent retry pattern would burn turns and cost
before stopping.

Precisely what the kill buys, and what it does not:

- It does **not** buy safety from side effects. While the flag exists the hook denies *every* tool
  call (3.3 confirms firing for every tool name observed), so no side effect can land regardless.
- It **does** buy a deterministic pause point and a bounded cost. Without it, "paused" would mean
  "the model is still running, still consuming turns, and will stop whenever it feels like it."

**Recommendation:** `SIGTERM` first, escalating to `SIGKILL` after a grace period, so the CLI has a
chance to flush session state to disk — but note Q2: no run in this spike was ever killed by the
orchestrator, so the interaction between a killed process and session resumability is unmeasured.

**Inferred, from the mechanism rather than a capture:** the hook is only consulted when a tool call
is pending. If pause is requested while the model is producing its final text, or after its last
tool call, no deny will ever appear and the run will simply complete. M3 must handle
"pause requested, run finished anyway" as a normal outcome — the run is `succeeded`/`failed`, not
`paused` — and clear the flag. A pause request therefore needs a deadline rather than an unbounded
wait for a deny that may never come.

### 6.6 Consequences beyond pause

#### 6.6.1 Permissions cannot be built on prompts

The CLI's interactive permission prompt is unusable as a control surface for an autonomous runtime:
there is no TTY to answer it, and the failure is quiet in the first place an orchestrator would
look — the run's terminal event, which reports a clean completion (1). Spec §9.2's "permissions enforced at the adapter level" must therefore
mean explicit configuration chosen before the process starts: `--allowedTools` /
`--disallowedTools` allow-lists, and/or a hook that denies by policy.

A judgement call, stated as a **Recommendation** so M3 knows it is not measurement: enforce the
per-agent allow/deny list in the **same `PreToolUse` hook** that implements pause, and treat
`--allowedTools` / `--disallowedTools` as defence in depth. The reason is asymmetric evidence — the
hook's deny is measured to work, including under `bypassPermissions` (3.6), while the allow-list
flags were never run at all. Building the product's permission model on the mechanism that was
measured, and adding the unmeasured one as a second layer, is the ordering the evidence supports.
This also gives one place to deny `Bash(git config ...)`, which 6.6.3 needs.

#### 6.6.2 The stream parser must distinguish two denial shapes

**Observed**, and easy to get wrong:

- **Permission-mode denial** (1): `{"type":"system","subtype":"permission_denied","tool_name":...,
  "tool_use_id":...,"message":"Claude requested permissions to ..."}`.
- **Hook denial** (3.5): **no `permission_denied` event at all.** The only live signal is
  `{"type":"system","subtype":"hook_response","hook_name":"PreToolUse:<Tool>", "output":"<JSON
  string>"}` whose `output` parses to `hookSpecificOutput.permissionDecision == "deny"`, followed by
  a `tool_result` with `is_error: true` whose content is the deny reason.

Conflating them is not cosmetic: a permission-mode denial means the run is misconfigured and will
accomplish nothing, while a hook denial means the run is pausing as instructed. An orchestrator that
read the former as the latter would sit waiting to resume a run that was never paused.

Three parser details that follow directly from the captures:

1. `hook_response.output` is a **JSON-encoded string**, not a nested object — it requires a second
   parse.
2. `hook_response` carries **no `tool_use_id`**; only `hook_name` (e.g. `PreToolUse:Read`).
   Correlation to a specific call must come from the `tool_result` that follows.
3. Hook events appear **only when `--include-hook-events` is passed**. Run 4 used it and has them;
   run 5 did not and has zero `hook_response` lines (4.2). **Recommendation:** M3 always passes
   `--include-hook-events`, because the alternative live signal — an `is_error: true` tool result —
   is indistinguishable from an ordinary tool failure without matching on the reason string.

The terminal `result` event's `permission_denials` array captures both kinds (1, 3.5), but only at
the end of the run, which is too late to drive a pause.

#### 6.6.3 `.git/config` is shared state that worktrees do not isolate

**Observed** (5.5): both concurrent agents hit `Author identity unknown`; one wrote
`git config user.name/user.email` persistently into the shared `.git/config`, the other used a
per-invocation `git -c` override. They did not collide, but only because the two agents happened to
make different scoping choices. Two agents both choosing the persistent write, with different
values, would silently overwrite each other. `.git/config` is one instance of a class: the git
common directory is shared by every worktree of a repository.

**Recommendation for M3** (not measured, and stated as a recommendation for that reason): the
orchestrator should make the agent's improvisation unnecessary and impossible.

1. Set `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` in the
   spawned process's environment. This is per-process, writes no file, and cannot leak to a sibling
   worktree. It also removes the `Author identity unknown` failure that provoked the config write in
   the first place.
2. Deny persistent git-config writes through the permission hook (6.6.1).
3. If a file-based identity is preferred instead, use `git config extensions.worktreeConfig true`
   once, then `git config --worktree user.*` per worktree (5.5).

Generalise the underlying rule: **N concurrent runs must never write to the git common directory.**

#### 6.6.4 A fresh worktree is not a ready workspace

**Observed** (5.6): neither worktree ever had `node_modules`, and `npm test` succeeded anyway — for
one specific reason, that the fixture's `package.json` has no dependencies at all and `npm test`
runs Node's built-in test runner. This says nothing about real repositories. M3's worktree
provisioning must include an explicit, workspace-configured **setup command list** (the counterpart
to spec §10's verify commands) that runs after `git worktree add` and before any verify command.
Whether a shared or symlinked `node_modules` is safe across concurrent worktrees was not tested.

#### 6.6.5 Worktree isolation is sound for the parallelism premise

**Observed** (5.2, 5.4, 5.7): a run confined to a worktree left `main` at its original commit with
no new files; two concurrent runs on sibling worktrees produced two independent branches, no
cross-contamination at file or ref level, no git lock contention, and both exited `0`. The
qualification is 6.6.3 and nothing else. Not covered: two agents committing to the *same* ref
concurrently (5.5) — M3's one-worktree-per-task design should not produce that case.

### 6.7 Known limitations and open questions

Recorded as limitations rather than smoothed over, because the point of this spike was to replace
guesses with measurements.

**Limitations of what was measured:**

- **The hook's exit-2 crash path was never exercised by a real `claude` run** (3.10). It was
  verified standalone against `/dev/full`, but no capture shows a nonzero-exit `hook_response`. That
  a script crash blocks the tool call rests on Claude Code's documented general hook convention, not
  on this spike's evidence. If the convention does not hold, a crashing hook could fail *open*.
- **The `$AITEAMOS_SPIKE` variable form in `settings.json` was never tested** (3.1); only the
  absolute-path form. M3 must generate absolute paths, or measure the variable form first.
- **Hook-*allow* during resume is inferred, not observed** (4.2): run 5 omitted
  `--include-hook-events`, so "the hook fired and allowed" is deduced from the absence of denial
  signals. 6.6.2's recommendation to always pass `--include-hook-events` closes this gap for M3.
- **The OS-level exit code was not captured to a durable file in several runs** (3.10). Exit codes
  were observed in-session but not persisted alongside the captures.
- **`pause-gate.sh`'s `deny()` interpolates its reason into JSON without escaping.** Safe for
  today's two static call sites; **not** safe for M3, which will want dynamic reasons (task key,
  operator name, the operator's own message). Any character requiring JSON escaping would produce a
  malformed payload, and a malformed deny is an *allow*. **Binding on M3:** build the payload with a
  real JSON encoder before using any dynamic reason.
- **The paused session had no edits of its own** (4.1). "Pause → instruct → resume" is observed, and
  conversational context demonstrably survived the boundary (4.5). What was *not* demonstrated is a
  session resuming its own in-flight editing work, because the session in question had made zero
  `Edit` calls before it was paused.
- **A denied `Edit` was never observed** (3.7). Both denied calls were read-only. That a denied
  `Edit` cannot partially apply follows from `PreToolUse` firing before the tool runs; it is
  inferred, not seen.

**Open questions, with what would settle each:**

- **Q1 — Does `--resume` work when the cwd is a git worktree rather than the repository root?**
  Session state is stored per project directory, and a worktree has a different path from the main
  tree. Every resume in this spike ran from `$SPIKE_REPO`; every worktree run was a fresh session.
  *Settles it:* one run inside `.aiteamos/worktrees/TASK-00X`, then a `--resume` of its session id
  from that same directory, checking that context carried over. This is the single most important
  unmeasured thing for M3, because the product resumes runs in worktrees by design.
- **Q2 — Does a session remain resumable after the orchestrator kills the process?** The one
  resume-after-pause measured (section 4) followed a process that exited cleanly on its own. 6.5
  requires M3 to kill. *Settles it:* pause a run, `SIGTERM` it on the first deny, then `--resume`
  its session id and check the prior context is present. Also worth measuring whether `SIGKILL`
  behaves differently from `SIGTERM`.
- **Q3 — Is a resumed run's `total_cost_usd` that segment's cost or the session's cumulative
  cost?** Run 2 reported `0.129` and its resume reported `0.277`; both readings are consistent with
  either interpretation. The budget guardrail either double-counts or under-counts depending on the
  answer. *Settles it:* a resume that does almost no work — if its `total_cost_usd` still exceeds
  the prior run's total, the figure is cumulative.
- **Q4 — Does the CLI accept a custom or appended system prompt in headless mode?** Never
  exercised, and not in section 0's flag inventory. `supportsCustomSystemPrompt` is set `false`
  until this is measured. *Settles it:* one run with the flag, checking the instruction is honoured.
- **Q5 — Do `--allowedTools` / `--disallowedTools` behave as an enforced allow-list in headless
  mode, and do they compose with `--permission-mode bypassPermissions` the way the hook does?**
  Never exercised (0 lists them from `--help` only). *Settles it:* a run under
  `bypassPermissions` with `--disallowedTools Edit`, checking whether an `Edit` is refused and which
  event shape the refusal takes.
- **Q6 — What happens when a pause is requested and the run has no further tool calls?** Inferred
  in 6.5 to complete normally. *Settles it:* set the flag after the last tool call of a short run
  and observe the terminal event.
