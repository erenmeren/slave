# Adding a provider

What it costs to put a third CLI runtime behind this product, and where every one of those costs
lives. Written in M56a, from the migration that reduced it: before that milestone a third provider
had to be threaded through **twenty-six** sites in six packages, most of which failed silently rather
than loudly when they were missed. It is **six** now: eighteen of the twenty-six collapsed onto the
manifest and the registry, one derives, one is optional and one is conditional, and the five that
survived are joined by the manifest itself, which did not exist before. What keeps the collapsed ones
collapsed is a build error or a gate stage, and not a convention somebody has to remember.

This is a contract for the two milestones after it — M56b (the Codex CLI) and M56c (the Gemini CLI),
each blocked on its binary being installed and measurable — and for whatever comes after those. Both
binaries were installed on the development machine while M56a was in flight (`codex-cli 0.154.0`,
`gemini 0.59.0`) and neither has an account behind it, so neither is measurable yet and neither has a
manifest: an installed binary is half of the precondition, and the half that produces a measurement
is the other one.

## The rule that governs all six

**Every axis of a manifest is a MEASUREMENT.** `packages/providers/src/capabilities.ts`'s
widen-never-narrow rule states it and this milestone did not soften it: a capability may only ever be
WIDENED by proof, never narrowed, and never assumed true because a vendor's documentation says so. A
first measurement is held to the same standard as a widening — which is why a provider's spec is
written after somebody installs the binary and reads `--help` and `--version` on the machine, and why
every row records the version it was measured against.

The methodology is M13's Series C
(`docs/superpowers/specs/2026-08-29-m13-runtime-hardening-design.md:184-205`): outcome branches
written down in advance, two runs in a fresh `git worktree add` root, and the measured value recorded
with the binary version beside it.

## The six sites

1. **The manifest** — one module in `packages/domain/src/provider/`, plus one line in that
   directory's `index.ts`. Fourteen axes, and this is the measurement written down. A row with an
   empty `differences` is a row nobody measured, and the schema refuses one.
2. **The registration** — one entry in `PROVIDER_ADAPTERS` (`packages/providers/src/registry.ts`): a
   constructor, and for a provider whose models are LISTED, a parser. `PROVIDER_ADAPTERS` and
   `PROVIDER_MANIFESTS` are both `Record<ProviderKind, …>`, so a registration without a manifest is a
   build error rather than an adapter nobody measured.
3. **The adapter** — one directory under `packages/providers/src/` implementing
   `SlaveRuntimeAdapter` (`packages/providers/src/contract/adapter.ts`). This is the work itself.
4. **The rehearsal fake** — one script under `scripts/gate-fakes/`, named `fake-<binary>.sh`, and the
   one CI `env:` line that arms it. The name is the convention `scripts/lib/child-env.mjs` looks for,
   so a provider with no fake fails LOUDLY when a gate starts rather than quietly running against a
   real binary. A fixture-replay `.mjs` fake is OPTIONAL: Cursor ships without one and reads
   checked-in NDJSON fixtures instead.
5. **The word** — one key in `PROVIDER_LABEL` (`packages/domain/src/provider/kind.ts`) and the README
   sentence naming the vendor's binary. A product's word for a vendor is not derivable from that
   vendor's binary name, and prose is not derivable at all.
6. **The Postgres enum** — one value in `enum ProviderKind` (`packages/db/prisma/schema.prisma`) and
   an additive migration. No TypeScript derivation writes a migration. It is also the LOUDEST of the
   six: `packages/db/test/integration/enum-parity.test.ts` fails by name if the enum and
   `PROVIDER_KINDS` disagree in either direction, so it is the one site that cannot be forgotten.

Everything else derives: the capability table, the model listing, the permission vocabulary, the
enforcement axis, the registry's parameter shape, the wiring loop, the Settings cards, the spend net,
the simulation guard and the pause branch. `gate:m56a-provider-contract` keeps them derived — stage 1
greps for a second copy of the union and stage 8 for a `case` or an `if` keyed on a provider's name
outside a checked-in allow-list.

## What a provider with no hook plane can still do

M52's broker channel is provider-agnostic by construction: `SLAVEOFAI_BROKER_CHANNEL` and
`SLAVEOFAI_BROKER_CLI` need only a writable file and a way to invoke the orchestrator CLI, which is
true of any CLI-shaped runtime. So `read_secret` and `deploy_release` are answered for a hookless
vendor on day one. The other four permission kinds — `read_repo`, `write_repo`, `run_commands`,
`network_fetch` — need a real pre-tool-call interception a vendor may or may not expose, and
`toolRestrictions.mechanism: 'none'` is how a manifest says so out loud instead of letting somebody
discover it at dispatch.

Pause degrades down [ADR 0001's ladder](../decisions/0001-pause-semantics.md#degradation-path-if-a-provider-lacks-hooks-spec-7):
`hook` stops a run between tool calls, `signal` cancels and resumes the session, and `none` is
declarable and **unregistrable** — `admitAdapter` refuses an adapter with neither capability, and the
recap-based continuation the ADR describes for that rung exists in prose and in no code.

## The two providers this product ships

<!-- generated: provider-ledger -->
| Axis | Claude Code | Cursor |
|---|---|---|
| Binary | `claude` | `cursor-agent` |
| Binary override | `SLAVEOFAI_CLAUDE_BIN` `SLAVEOFAI_CLAUDE_ARGS` | `SLAVEOFAI_CURSOR_BIN` `SLAVEOFAI_CURSOR_ARGS` |
| Headless flags | `--output-format` `stream-json` `--verbose` `--permission-mode` `bypassPermissions` `--include-hook-events` `--setting-sources` `project,local` | `--print` `--output-format` `stream-json` `--trust` `--force` |
| Prompt | `flag` | `positional` |
| Never pass | `--no-session-persistence` `--fork-session` | `-w` `--worktree` `--stream-partial-output` `--yolo` `--plan` `--mode` |
| Model discovery | `configured` (11 entries) | `listed` (`models`) |
| Resume | `session_id` on `--resume`, never `--fork-session` | `session_id` on `--resume`, never `--continue` |
| Pause rung | `hook` ([ADR 0001](../decisions/0001-pause-semantics.md#providercapabilities-for-the-claude-code-adapter-spec-7)) | `signal` ([ADR 0001](../decisions/0001-pause-semantics.md#degradation-path-if-a-provider-lacks-hooks-spec-7)) |
| Events | `stream_json`: `session_started` `tool_call` `tool_result` `usage` `text` `hook_started` `hook_denied` `hook_crashed` `hook_failed_open` `permission_denied` `terminated` | `stream_json`: `session_started` `tool_call` `tool_result` `text` `permission_denied` `terminated` |
| Structured output | `prompted` | `prompted` |
| Tool restrictions | `hook_gate` / `all-tools` | `hook_gate` / `known-tools` |
| Tool vocabulary | `read_repo`: `Read` `Glob` `Grep` `NotebookRead` `TodoWrite` `ToolSearch` `TaskOutput` `ListAgents` `Monitor` `LSP` `ListMcpResourcesTool` `ReadMcpResourceTool` `ReadMcpResourceDirTool`; `write_repo`: `Write` `Edit` `NotebookEdit`; `run_commands`: `Bash` `BashOutput` `KillShell` `Task` `TaskStop` `Skill` `Workflow` `SendMessage` `EnterWorktree` `ExitWorktree` `EnterPlanMode` `ExitPlanMode` `CronCreate` `CronDelete` `CronList` `ScheduleWakeup` `RemoteTrigger` `PushNotification` `ReportFindings` `DesignSync`; `network_fetch`: `WebFetch` `WebSearch` | `read_repo`: `read`; `write_repo`: `edit`; `run_commands`: `shell` |
| Usage and cost | `reported` | `unmeasured` |
| Hooks | `pre_tool_use` `post_tool_use` | `pre_tool_use` `before_shell_execution` |
| Run files | `settings` `hook` | `settings` `hook` |
| Measured against | `claude 2.1.269` (2026-09-12) | `cursor-agent 2026.08.25-3e8eec8` (2026-08-29) |

**Claude Code — stated limitations**

- `--settings` must be an ABSOLUTE path: a settings file the CLI cannot find never registers the PreToolUse hook, and there is no error anywhere in the event stream -- the run spawns cleanly, every tool call goes through, and the terminal result reports a clean success. `claudeFlags` refuses a relative path before a process exists.
- No `--allowedTools` is passed at all, so every one of the ~68 tools the `system`/`init` line advertises is live; the permission matrix restricts through the PreToolUse hook verdict, never through a CLI flag.
- Per-turn `usage` events are a documented FLOOR and not a total: a streamed message's per-turn usage is not what the turn was billed, and the terminal `result` line REPLACES both halves with the authoritative figures.
- The PostToolUse tap is an optional GAP FILLER: it never writes stdout, always exits 0, and the stream wins whenever both produce a result for the same tool call. A deployment without it runs exactly as it did before M51.
- Hook exit codes were measured, not assumed (M3 Task 1): allow is exit 0 with empty stdout, deny is exit 0 with a JSON body, exit 2 fails CLOSED, and exits 1/126/127 fail OPEN.
- The `default` model id is deliberately unpriced -- the CLI’s current choice is not knowable from inside this repository -- so a run on `default` reports the cost the CLI reports and can never be estimated.
- `CHILD_ENV_ALLOW` was measured against `claude 2.1.269` and the binary installed at M56a was `2.1.270`. One patch of drift on a twelve-name allowlist, re-measured by the next milestone that changes the list rather than by one that does not touch it.

**Cursor — stated limitations**

- `--trust`'s absence is INVISIBLE: in a directory the user has not already trusted, `cursor-agent` exits 1 with a completely empty stdout -- no `system`/`init` line, no `result` line -- and prints “Workspace Trust Required” to stderr only. Every fresh worktree this system creates is exactly such a directory.
- `--force` is this vendor's `bypassPermissions`, and its help text's trailing clause -- “unless explicitly denied” -- is load-bearing: it is what keeps the gate's own deny effective under it.
- `--resume [chatId]` takes an OPTIONAL argument, so a bare `--resume` swallows the positional prompt as a chat id and leaves the run with no prompt at all. `cursorFlags` structurally cannot emit one: the flag and its id are pushed in the same statement.
- The `preToolUse` registration carries NO matcher, and that is measured rather than cautious: this vendor’s edit tool reads its target before writing it, and both steps are gated under the edit call’s own id, so a write was stopped at a `preToolUse` invocation whose `tool_name` was `"Read"`. A matcher scoped to `^(Write\|Shell)$` would have let that write through.
- `numTurns` has no equivalent in this stream at all: the adapter DERIVES it by counting `assistant` lines while consuming, and overwrites the parser’s `0` before the event leaves `events()`. The parser’s zero must never reach an operator as a figure this vendor reported.
- `deniedToolUseIds` is populated from `tool_call`/`completed` lines whose `result.rejected` is set, and NEVER from `result.error`: an ordinary tool error is indistinguishable from a fail-closed gate block, so a fail-closed stop is silently not counted there, though its text still reaches the operator on the terminal line.
- The stream does not end at readline close. A real run left a detached worker-server family holding a DUP of this binary’s own stdout write end, so the pipe never closed even after the process itself exited; the adapter ends on the child’s `exit` event plus a 300 ms quiesce window re-armed per chunk.
- A run that wrote NOTHING to stdout is diagnosed as the workspace-trust refusal, with the captured stderr included verbatim rather than guessed -- and deliberately not synthesised for a cancelled or signalled run, which is an ordinary reason to write nothing.
- The `preToolUse` payload arrives with Claude-shaped casing (`"Read"`/`"Shell"`/`"Write"`) that never matches this vendor’s own lowercase vocabulary, so the gate is told to enforce only the names it can trust (`toolRestrictions.enforce: known-tools`). Under an allow list, matching them naively would deny every call this runtime makes.
- It reports no cost at all: the `result` line carries no cost figure, no model in this table is priced, and `estimateCostUsd` therefore answers `null` rather than `0`. This is why an llm-decision simulation refuses this provider -- "it reports no cost, so a cap cannot be enforced" -- which is a BUDGET refusal and not a statement about its output shape.
- Only a shell call and an edit call were ever exercised: no MCP call and no subagent call has been measured on this runtime.
<!-- /generated: provider-ledger -->

> Generated from `packages/domain/src/provider/`'s manifests by `renderProviderLedger()`
> (`packages/domain/src/provider/ledger.ts`). Do not edit the block above by hand:
> `packages/domain/test/provider/ledger.test.ts` compares it against what the manifests render, and a
> manifest edit that does not regenerate it is a red test. To regenerate it: `npx tsc --build`, then
> write `renderProviderLedger()`'s output between the two markers, both markers left in place.
>
> Sixteen rows over twelve of a manifest's fourteen fields. `invocation` is five separate decisions
> and gets five rows; `kind` IS the column header; and `differences` is the list under the table,
> because a table cell is the wrong shape for a paragraph.
