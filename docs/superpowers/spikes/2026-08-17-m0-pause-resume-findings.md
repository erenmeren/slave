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

`--output-format stream-json` from the brief is a valid flag as-is; no substitution was needed:

```bash
cd "$SPIKE_REPO"
claude -p "Add a multiply(a, b) function to sum.js and a test for it in sum.test.js. Run npm test when done." \
  --output-format stream-json --verbose 2>&1 | tee /tmp/m0-run1.jsonl
```

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

<filled by Task 3>

## 3. Tool-call interception via PreToolUse hook

<filled by Task 4>

## 4. Resume after pause with instruction injection

<filled by Task 5>

## 5. Worktree isolation

<filled by Task 6>

## 6. Verdict and consequences for M3

<filled by Task 7>
