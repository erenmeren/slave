# Recorded evidence: Claude invokes a skill as a `tool_use` named `Skill`

Claude recordings that are read by parser tests rather than replayed by the fake CLI. See
`../README.md` for why this is a subdirectory and not part of the flat replay-mode namespace.

## `skill-tool-use.ndjson`

The raw stdout of **one** `claude` run made on **2026-08-30** for M14 Task 4 (spec §4.1). It is the
milestone's single real Claude invocation, and it exists because §4.1's whole mapping —
`AgentRun.skillCalls`, the agent card's skill chip, the Skills page's per-skill run counts — rests
on one claim about the CLI's output shape, and that claim had to be **measured** rather than
assumed.

### The binary

```
$ claude --version
2.1.251 (Claude Code)
```

Path: `~/.local/bin/claude`.

### The command

Run in a throwaway git repo so no worktree of this repository was touched. The repo was a real git
root (`git rev-parse --show-toplevel` → itself), the shape a production run gets:

```bash
rm -rf /tmp/m14-skill-fixture && mkdir -p /tmp/m14-skill-fixture && cd /tmp/m14-skill-fixture
git init -q -b main
git config user.name Fixture && git config user.email fixture@example.com
echo '# fixture' > README.md && git add README.md && git commit -q -m initial

claude --print --output-format stream-json --verbose \
  'Use the superpowers:writing-plans skill to tell me, in one sentence, where plans are saved. Do nothing else.' \
  > /tmp/m14-skill-fixture/raw.ndjson 2> /tmp/m14-skill-fixture/stderr.txt
```

Exit 0, **8 s** wall (`duration_ms` 5340, `duration_api_ms` 4736), empty stderr, 15 lines.

### The recorded outcome

**Exactly one** `Skill` tool_use, on line 9. Its `input` has one key:

```json
{"type":"tool_use","id":"toolu_0141qy4Mzfyun9aKSB8iMncy","name":"Skill","input":{"skill":"superpowers:writing-plans"},"caller":{"type":"direct"}}
```

That is the whole finding, and it confirms what §4.1 assumed:

- the tool is named **`Skill`** — a plain entry in the assistant message's `content` array, the same
  shape as `Write` or `Bash`. It is not a distinct top-level `type`, and needs **no new
  `RuntimeEvent` variant**: `parseStreamLine` already turns it into a `tool_call`.
- `input.skill` is the **only** argument, and it carries the fully-qualified `<plugin>:<name>`.
  There is no `description`, no `args`, no nested object. This is why `'skill'` is now the **first**
  entry of `CLAUDE_SUMMARY_ARG_KEYS` in `packages/providers/src/runtime/summary.ts`: without it
  `summaryFor` falls through every key and every skill call in the product reads identically as the
  bare word `Skill`. First rather than merely present, so that a future CLI adding a `description`
  beside it cannot shadow the one argument that names the skill.
- `id` is a normal `toolu_`-prefixed tool use id, so the pump's existing `toolCalls` accounting and
  checkpoint correlation apply to it unchanged.

The mapping in `stream.ts` and the key list in `summary.ts` were written **from this recording**,
not from documentation.

Rest of the transcript, for completeness: 3 `SessionStart` hook pairs, one `init`, an assistant
text line, the `Skill` tool_use, the `user` `tool_result` carrying the skill body, a closing
assistant text line, two `rate_limit_event` lines, and the `result`
(`is_error: false`, `terminal_reason: "completed"`, `num_turns: 3`, `stop_reason: "end_turn"`,
`permission_denials: []`). `parseStreamLine` returns no `unparsable` for any of the 15 lines; the
parser test asserts that.

### It does not end with a `Stop` hook line — deliberately not fixed

Every fixture in the parent directory ends with a `hook_name: "Stop"`, `exit_code: 1`,
`outcome: "cancelled"` line, and `fake-claude.test.ts` enforces that for the replay namespace. This
recording has no such line: a `Stop` hook **is** configured on the recording machine, but the CLI
exited before its response reached stdout. Appending one would be fabrication, and truncating or
reordering to fit a test is exactly what a recorded fixture must never do. So the file lives here
instead, out of the namespace that invariant governs. The recording is right; only its placement
was in question.

### Redaction

The stream is byte for byte the CLI's stdout except for **one** mechanical substitution:

```bash
sed -e 's#/home/meren#/home/fixture-user#g' /tmp/m14-skill-fixture/raw.ndjson \
  > packages/providers/test/fixtures/claude/skill-tool-use.ndjson
```

Ten occurrences, all in the `init` line: the `plugins[].path` entries, `memory_paths.auto`, and
`messaging_socket_path`. Nothing else was altered — line count, ordering and every other byte are
the capture's own.

The capture contains **no email address** (verified by grep for `@`-shaped tokens: zero matches),
so the `user_email` substitution the Cursor gate README applies had nothing to act on here. No
transcript path is present either. `session_id` and `uuid` values are kept: they are random UUIDs,
they identify nothing outside the run, and the parser reads `session_id` off the `init` line — the
`session_started` event this fixture also exercises.

### Spend

**One** `claude` invocation, **$0.422696** (`total_cost_usd` on the `result` line). The task's spare
run was not needed: the first run produced the `Skill` tool_use on the first attempt.
