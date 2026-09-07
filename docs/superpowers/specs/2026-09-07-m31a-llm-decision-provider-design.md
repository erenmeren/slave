# M31a — The LLM decision provider: a model decides the purchasing role, with proven isolation and honest cost

**Status:** Approved in conversation (2026-09-07) after a three-call spike (below). Decisions taken: the model decides ONE role (`purchasing`) once per simulated day, the other roles stay on rules; the call is made by the orchestrator daemon outside any database transaction and the decision is applied by a control verb under the row lock; Claude Code is the only model provider in M31a (Cursor reports no cost and is refused); every run that uses the model declares a cost cap and is halted when it is reached; tests and the gate never make a real call.
**Approach:** one milestone (M31a). M31b (the software-company sector) follows with its own spec. One additive migration (three nullable columns, one enum value). The engine stays pure and synchronous: an LLM step is two phases — decide (daemon, no lock) then apply (control, locked, re-validated).
**Scope rule:** what a person needs to create a simulation whose purchasing decisions come from a model, watch it run under the daemon, read every model decision with its rationale and cost, and be certain that the model reached no tool, no file, no database and no real system. Nothing else — no other roles on the model, no second provider, no prompt tuning UI, no retries of a refused decision.

## 1. The spike (2026-09-07, three real calls, ~$0.23, `claude` 2.1.263, model `claude-haiku-4-5-20251001`)

| call | setup | result |
|---|---|---|
| 1 | `--tools ""`, an observation prompt on stdin | 0 tool uses, 1 turn, $0.039, a valid action array inside a ```json fence |
| 2 | `--tools ""`, a prompt that asks to list files first | **2 tool attempts, both against the user's own MCP server** (`--tools ""` removes built-in tools only); our `PreToolUse` hook denied both; 3 turns, $0.167 |
| 3 | `--permission-mode bypassPermissions` + the deny-all hook only | Bash and Read attempted, both denied by the hook; the model answered with the JSON anyway; $0.026 |

What the spike proved and what it did not:

- The existing hook is a real second defence: it fired on every attempt and the attempt shows in the stream as a `permission_denials` entry — an auditable fact, not a hope.
- `--tools ""` alone is NOT isolation: the user's global MCP servers and settings still attach. The CLI offers the missing pieces: `--restricted` (drops built-in tools, ignores user/project/local settings, refuses `bypassPermissions`; `--settings` still applies), `--strict-mcp-config` (only the MCP servers named by `--mcp-config`; none named → none), `--max-budget-usd` (a per-call ceiling). **Their combination was not exercised in the spike** — Task 1 of the plan makes exactly one more real call, with the operator's consent, to prove it.
- `--tools <tools...>` is variadic and swallows a positional prompt: the prompt is always passed on stdin.
- Denied tool attempts cost turns: call 2 cost 4× call 1. Isolation is also the cost control.
- Cost per zero-tool decision on Haiku ≈ $0.04. Four roles a day for thirty days would be ≈ $4.8 per run; one role a day ≈ $1.2. That is why §3 puts one role on the model.

## 2. Principles (M29 §2/§8 and M30 §2 stay binding; added here)

1. **The model proposes; the engine still decides.** A model answer is an `ActionEnvelope[]` like any other; schema → role → sector rules run unchanged against the CURRENT state. A malformed answer is a decision with zero actions and a recorded `parseError`; the world does not move.
2. **No transaction is open while a model thinks.** The daemon reads (unlocked), calls the model, then a control verb takes the lock, checks `version`, and applies. A stale decision is discarded and journaled, never applied to a world it was not made for.
3. **The model reaches nothing real.** `--restricted --strict-mcp-config --tools ""`, a deny-all `PreToolUse` hook proven by a preflight, an empty temporary working directory, a minimal environment (no `DATABASE_URL`, no `SLAVEOFAI_*`), stdin prompt, no session persistence. Any `tool_use` in the stream is an **isolation breach**: the answer is discarded and the run halts.
4. **Every call is paid and every payment is recorded.** One `SimulationModelUsage` row per call, `costUsd` from the CLI's `total_cost_usd` or `null` when absent (never `0`), tokens likewise; a run's cumulative cost against its `maxModelCostUsd` cap halts it with `model budget exhausted` before the next call.
5. **Paid use is a choice the person makes.** The create drawer requires a checked consent box and a cap; the CLI requires `--max-model-cost-usd`; the default provider stays `rules`; nothing in tests, CI or the gate calls a model.
6. **Stopping stops spending.** Pause, halt and finish clear auto-run, and an LLM run steps only through auto-run — so no new call starts. A call already in flight finishes (the page says so): its usage row is written, its decision is discarded if the run is no longer running.

## 3. Data model (one additive migration `m31a_llm_decision_provider`)

```prisma
enum DecisionProviderKind { rules llm }
model SimulationRun {
  // … M29/M30 columns …
  /// M31a: the model provider and model an `llm` run calls; null on a `rules` run.
  modelProvider   ProviderKind?
  model           String?
  /// The run's spending cap in real USD (required when decisionProvider = llm); the sum of its
  /// SimulationModelUsage.costUsd rows is compared against it before every call.
  maxModelCostUsd Float?
}
```
- `definition.llmRoles: string[]` — `['purchasing']` in M31a (the create verb sets it; the schema allows any subset of `roleOrder` so M31b can widen it).
- `SimulationModelUsage` (M29) is written for the first time: `{ simulationId, seq, provider, costUsd, tokensIn, tokensOut }` plus two new nullable columns `simTime Int?` and `role String?` so a usage row can be read beside its decision.
- Journal payloads: `decision { …, provider: 'llm', model, usageSeq, parseError?: string, promptHash }`; `control { op: 'stale_decision', role, expectedVersion, actual }`; `control { op: 'model_budget_exhausted', spentUsd, capUsd }`; `control { op: 'isolation_breach', tools: string[] }` (followed by the halt).
- `SimulationSummary` gains `modelProvider`, `model`, `maxModelCostUsd`, `llmRoles`.

## 4. The provider package (`packages/providers/src/claude/decision.ts`)

```ts
export interface ModelDecisionInput { readonly command: string; readonly extraArgs?: readonly string[]; readonly model: string; readonly prompt: string; readonly maxBudgetUsd: number; readonly hookPath: string; readonly timeoutMs?: number }
export type ModelDecisionOutcome =
  | { readonly kind: 'answer'; readonly text: string; readonly costUsd: number | null; readonly tokens: { input: number; output: number } | null; readonly numTurns: number }
  | { readonly kind: 'isolation_breach'; readonly tools: readonly string[]; readonly costUsd: number | null; readonly tokens: … | null }
  | { readonly kind: 'failed'; readonly reason: string; readonly costUsd: number | null; readonly tokens: … | null }
export async function decideWithModel(input: ModelDecisionInput): Promise<ModelDecisionOutcome>
```
- Args: `[...extraArgs, '-p', '--restricted', '--strict-mcp-config', '--tools', '', '--no-session-persistence', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--model', model, '--max-budget-usd', String(maxBudgetUsd), '--settings', settingsPath]`; prompt on stdin; `cwd` = a fresh `mkdtemp` directory removed afterwards; `env` = `{ PATH, HOME, LANG, TERM }` only (the CLI needs `HOME` for its credentials — that is the one thing it may reach); `stdio` pipes; timeout (default 120 s) → `terminateChild` → `failed { reason: 'timeout' }`.
- Before spawning, `preflightDenyAll({ hookPath })` (the existing `preflightGate` pattern, applied to the opposite contract: the hook must answer `deny` both with and without the pause flag present); the settings file is written with `writeSettingsFile` into the temp dir — the deny-all hook is `scripts/deny-all-gate.sh` (env override `SLAVEOFAI_DENY_ALL_HOOK_PATH`), a separate script that denies every tool call unconditionally, not a `SLAVEOFAI_DENY_ALL=1` branch of the pause gate (see §12's Deny-all hook errata: a script that can only deny cannot be misconfigured into allowing).
- Stream handling with `parseStreamLine`: every `text` event appends to the answer; any `tool_call` marks a breach (the answer is still drained so the `result` line's cost is captured); `terminated` supplies `costUsd`/`tokens`/`numTurns` from `RunOutcome`; a `result` line missing → `failed { reason }` with `costUsd: null`.
- Capabilities: `capabilitiesOf('claude_code').reportsCost === true` is required; `createSimulation` refuses `modelProvider: 'cursor'` with `unsupported_model_provider { provider, reason: 'reports no cost' }`.
- The orchestrator wires it: `buildAdapterRegistry`'s `command`/`SLAVEOFAI_CLAUDE_ARGS` and `hookPath()` are reused, so the fake CLI (`packages/providers/test/fake-claude.mjs`) serves tests and the gate through the same `SLAVEOFAI_CLAUDE_BIN`/`SLAVEOFAI_CLAUDE_ARGS` the CLI test already uses; a new fixture `decision.ndjson` (one `assistant` text line with a fenced JSON array, one `result` line with `total_cost_usd`) and `decision-breach.ndjson` (a `tool_use` before the result).

## 5. Prompt and parse (`packages/simulation/src/decide/llm-prompt.ts`, pure)

- `buildDecisionPrompt({ role, observation, actionSchemas, day, currency })` → one string: the role's `purpose`, the list of allowed actions with their parameter shapes (from a small table the trade sector exports: `TRADE_ACTION_DOCS`), the observation as JSON, the output contract ("ONLY a JSON array of `{type, params, rationale, refs}`; an empty array means no action; no prose, no fences"), and the synthetic-data caveat. `promptHash = sha256(prompt)` is journaled (computed in control, the pure module has no `node:crypto`).
- `parseEnvelopes(text)` → `{ envelopes: ActionEnvelope[] } | { parseError: string }`: takes the LAST ```json … ``` fenced block, else the substring from the first `[` to the last `]` (R0: the model may put prose before the array), `JSON.parse`, requires an array, validates each element with `actionEnvelopeSchema`, caps at `limits.maxDecisionsPerStep` (the engine caps again).
- `LlmDecisionProvider` in `packages/simulation/src/decide/llm.ts`: kind `'llm'`; constructed with the already-parsed envelopes per role (`Map<role, ActionEnvelope[]>`) — it never calls anything; `CompositeDecisionProvider({ llm, rules })` answers by `request.role.name ∈ llmRoles ? llm : rules`. `DecisionProvider.kind` union gains `'llm'`; the journal `decision` row's `provider` field shows which one answered.

## 6. Control (`packages/control/src/simulation/llm.ts`)

- `createSimulation` input gains `decisionProvider?: 'rules' | 'llm'`, `modelProvider?`, `model?`, `maxModelCostUsd?`; `llm` requires all three (`invalid_simulation_input` otherwise), `modelProvider` must be `claude_code`, `maxModelCostUsd > 0`; `definition.llmRoles = ['purchasing']`.
- `stepSimulation` on an `llm` run → refusal `llm_steps_in_daemon { simulationId }` ("this run's steps are made by the daemon: start auto-run"). `startAutoRun` is the only way to move it.
- `prepareModelDecision(id, now)` (daemon, unlocked read via `readSimulation`): refuses when not running / no intent / not due (the same three checks `autoStepDue` makes, without the lock — a cheap pre-check; the locked check happens in `applyModelDecision`); computes `spentUsd = sum(costUsd)` and `unmeasured` over the run's usage rows; if `spentUsd ≥ maxModelCostUsd` → halts the run via `haltUnparsed(id, 'model budget exhausted')` after journaling `model_budget_exhausted`, returns `{ kind: 'budget' }`; otherwise returns `{ kind: 'decide', version, day, role, prompt, promptHash, model, remainingUsd }` for each `llmRole` (M31a: one).
- `applyModelDecision(id, { expectedVersion, role, decision: { text | outcome }, usage })` (locked): writes the `SimulationModelUsage` row FIRST (money was spent whatever happens next); then if `row.version !== expectedVersion` or status ≠ running → journal `stale_decision`, return `{ applied: false }`; if the outcome is `isolation_breach` → journal `isolation_breach { tools }` and halt (same transaction; `haltedReason: 'isolation breach: <tools>'`); if `failed` → journal `decision { provider: 'llm', actions: [], parseError: reason }` then step with an empty answer (the engine records the decision point with zero actions, the world moves one day by rules for the other roles); otherwise `parseEnvelopes` → `stepLocked` with a `CompositeDecisionProvider` whose `llm` side answers that role with the envelopes (and `[]` with `parseError` recorded when parsing failed) and whose `rules` side is `RulesDecisionProvider`; `lastAutoStepAt = now`.
- `tickSimulations({ now, modelDecider? })`: `rules` runs go through `autoStepDue` unchanged; an `llm` run goes `prepareModelDecision → modelDecider(prompt…) → applyModelDecision`. `modelDecider` is a function injected by the orchestrator (`(input) => decideWithModel(…)`); control never imports `@slave-of-ai/providers`. Without a decider (the CLI `tick`, tests that do not pass one) an `llm` run is skipped and counted as `skippedNoDecider`. `tickSimulations` does NOT await the model call (M32 item 2, superseding §12 R7): it prepares each due `llm` run, starts `modelDecider(...)`, records the run id in a process-level in-flight set (`inFlightModelCalls()`) and returns; the apply runs when the promise settles, and the id then leaves the set. A run in the set is skipped by later passes (`skippedInFlight`) so the same day is never paid for twice; `maxConcurrentModelCalls` (the daemon's `SLAVEOFAI_MAX_MODEL_CALLS`, default 3) bounds concurrent spend, and filling it is another `skippedInFlight`. A failure in the detached apply halts the run through `haltUnparsed` and never throws out of the pass. The daemon awaits `drainModelCalls()` on shutdown, before disconnecting Prisma, so a call already billed still lands its usage row (§2.6).
- Halt/pause/stop-auto-run behave as M30; `haltSimulation` on an `llm` run additionally journals `control { op: 'model_calls_blocked' }` (a person reading the journal sees where spending stopped).

## 7. Orchestrator

`daemon.ts` passes `modelDecider` built from `buildAdapterRegistry`'s command/args and `hookPath()`: `(input) => decideWithModel({ command, extraArgs, hookPath, model: input.model, prompt: input.prompt, maxBudgetUsd: Math.min(input.remainingUsd, PER_CALL_CAP_USD = 1) })`. The per-call cap is the smaller of what the run has left and one dollar. `SLAVEOFAI_MODEL_TIMEOUT_MS` (default 120 000) bounds a call.

## 8. UI and CLI

- Create drawer: **Decision provider** `rules` (default) | `llm`; when `llm`: provider (Claude Code only, Cursor shown disabled "reports no cost"), model (`ModelSelect` on `claude_code`), **cost cap USD** (default `2.00`), and a checkbox "I understand this run makes paid model calls on my account, up to the cap" — the submit is disabled until it is checked (testid `new-simulation-consent`). The body posts `decisionProvider, modelProvider, model, maxModelCostUsd`.
- Run page: strip reads `llm provider · claude_code · <model>`; **Model usage (real)** shows `$spent of $cap` (`unmeasured` calls named when > 0) — never `$0.00` for an unmeasured call; Step / Run-to-day are replaced by the sentence "an llm run steps only through auto-run (the daemon makes the model calls)"; the halted note shows `model budget exhausted` / `isolation breach: …` verbatim; Decisions tab rows carry an `llm` chip, the model, the cost of that call, and `parseError` when set.
- Cards: an `llm` chip.
- CLI: `create-simulation … --decision-provider llm --model-provider claude_code --model <m> --max-model-cost-usd <n>`; `simulation-status` JSON includes `modelUsage.spentUsd` and `capUsd`.

## 9. Security, data and cost

- `packages/control/src/simulation/*` still imports no providers (the decider is injected); the boundary test stays.
- The model process: `--restricted --strict-mcp-config --tools ""`, deny-all hook (preflighted), empty cwd, minimal env, stdin prompt, `--no-session-persistence`, per-call `--max-budget-usd`, timeout. Any `tool_use` → breach → halt. This is the M29 §8 "no real tool" guarantee for the model itself.
- The simulated company's money and the real spend stay in two tables; the page shows them in two panels; the cap compares only real spend.
- Emergency stop / halt: no new call; an in-flight call is not killed (the CLI is already running against the account); its usage row lands, its decision is discarded. The page says "a call already in flight finishes and is billed".

## 10. Testing

- **Pure**: `buildDecisionPrompt` snapshot-free assertions (contains purpose, action docs, observation JSON, contract); `parseEnvelopes` (fenced, unfenced, not-an-array, bad element, cap); `CompositeDecisionProvider` routing; `LlmDecisionProvider` answers only its roles.
- **Providers**: `decideWithModel` against the fake CLI: `decision` fixture → `answer` with cost and tokens; `decision-breach` → `isolation_breach` with the tool name and the cost still captured; timeout → `failed`; args contain `--restricted`, `--strict-mcp-config`, `--tools ''`, `--no-session-persistence`, `--max-budget-usd`; env contains no `DATABASE_URL`/`SLAVEOFAI_*`; the hook preflight refuses a hook that allows.
- **Control (integration)**: create an `llm` run (refusals: missing cap, cursor, unknown model provider); `stepSimulation` refuses `llm_steps_in_daemon`; `prepareModelDecision` not-due/budget/decide; `applyModelDecision` stale (usage row still written, journal `stale_decision`), parse error (zero actions, day advances), breach (halt, reason), success (usage row + decision row with `usageSeq`, purchasing acted as the answer said, other roles by rules); cumulative cost → `model_budget_exhausted` halt; `tickSimulations` with an injected fake decider steps an `llm` run and skips it without one.
- **Web**: drawer consent gating and body; run page strip, `$x of $y`, no Step buttons, breach/budget notes; cards.
- **Gate `m31a-llm-decisions`**: with `SLAVEOFAI_CLAUDE_BIN=node` + `SLAVEOFAI_CLAUDE_ARGS="<fake> --fixture decision"` and a real daemon: create an `llm` run from the UI (consent checked, cap $2), auto-run five days, wait for `simTime 5`, assert five `SimulationModelUsage` rows whose cost sums to what the page shows, five `decision` rows with `provider: 'llm'` and `usageSeq`, purchasing's action matching the fixture, other roles' decisions `provider: 'rules'`; then switch the daemon to `--fixture decision-breach`, step once, assert the run halted with `isolation breach: Bash` and no further usage rows. No real call anywhere.
- **The one real call** (plan Task 1, operator consent): `--restricted --strict-mcp-config --tools ""` with the tempting prompt → zero `tool_use`, zero hook invocations, cost recorded. Its output is kept in the spike scratch, not in the repo; the result is written into §12.

## 11. Order of work

1. The real-call verification of the isolation flags (consent) + `SLAVEOFAI_DENY_ALL` hook mode + `decideWithModel` + fixtures + provider tests.
2. Pure prompt/parse/composite + `DecisionProvider.kind` widening.
3. Migration + create verb + refusals + `stepSimulation` refusal + summary fields.
4. `prepareModelDecision` / `applyModelDecision` / `tickSimulations(modelDecider)` + daemon wiring + control/daemon tests.
5. Drawer, run page, cards, CLI flags.
6. Gate, README, errata, full verification.

## 12. Errata — where execution corrected the plan

- **R0 (2026-09-07, before Task 1, one real call with the operator's consent, ~$0.004):** `claude -p --restricted --strict-mcp-config --tools "" --no-session-persistence --max-budget-usd 0.2 --settings <deny-all hook>` with the tempting prompt on stdin, an empty temp cwd and `env -i PATH HOME LANG TERM`: the init line reports `tools: []` and `mcp_servers: []`; zero `tool_use` events; the hook was never invoked; one turn; `total_cost_usd 0.003824`. The model's answer contained hallucinated `<function_calls>` prose ("I ran ls, the directory is empty") BEFORE the JSON array — harmless (nothing ran) but decisive for parsing: `parseEnvelopes` extracts the JSON array (last fenced block, else first `[`…last `]`) rather than parsing the whole answer. §5 is amended accordingly; the isolation flag trio is proven and is what §4 spawns.

- **R1 (Task 1):** the child environment is proven by a pure `buildDecisionEnv()` (exactly `PATH`, `HOME`, `LANG`, `TERM`) unit test; no production code exists only to surface test data.
- **R2 (Task 1):** an isolation breach outranks every other classification — a stream with a `tool_use` that then times out or ends without a result line is `isolation_breach`, never `failed` (`failed` only zeroes a day's actions; a breach halts the run and its spending).
- **Deny-all hook (Task 1):** a separate script `scripts/deny-all-gate.sh` (env override `SLAVEOFAI_DENY_ALL_HOOK_PATH`), not a `SLAVEOFAI_DENY_ALL=1` branch of the pause gate as §4 first said — a script that can only deny cannot be misconfigured into allowing; `preflightDenyAll` proves it denies with and without the pause flag before every call.
- **R3 (Task 2):** the unfenced answer is parsed by a JSON-aware bracket scan from the first `[` (string- and escape-aware), not the last `]`: prose after the array may itself contain brackets.
- **R4 (Task 3):** a clone of an `llm` run is a `rules` run whose frozen definition has `llmRoles: []` and null model columns — a clone never inherits paid use (§2.5); `compare` therefore warns that the definitions differ, which is the truth.
- **R5 (Task 4):** `prepareModelDecision` has a fourth skip, `until_day`: reaching `autoRunUntilDay` clears the intent and journals `auto_run_stopped { reason: 'until_day' }` exactly as the rules path does, so an llm run cannot pay to the horizon.
- **R6 (Task 4):** `haltUnparsed` lives in `write.ts`; `llm.ts` → `write.ts` ← `auto-run.ts` is a DAG.
- **R7 (Task 4), SUPERSEDED by M32 item 2:** `tickSimulations` made at most ONE model call per pass (later due llm runs waited for the next pass; rules runs in the same pass were unaffected) so a slow call bounded the daemon loop by one timeout, not fifty. It was a bound the pass needed only because it AWAITED the call. See the M32 item 2 entry below.
- **R8 (Task 4):** `injectExternalEvent` bumps `version`, so an event injected while the model thinks makes that decision stale (§2.2: never applied to a world it was not made for); `stale_decision` carries `reason: 'version' | 'status' | 'intent_cleared'` — `stopAutoRun` mid-call is the third, found in review (§2.6).
- **Schema (Task 4):** `SimulationModelUsage` gained `@@unique([simulationId, seq])` in a second migration `m31a_usage_seq_unique`.
- **§6 (Task 4):** `haltSimulation` on an llm run journals `control { op: 'model_calls_blocked' }` before the `halted` entry, as specified.
- **§4 `reportsCost` (Task 3):** the "`capabilitiesOf('claude_code').reportsCost === true` is required" guard is an ALLOW-LIST inside `validateLlmInput` (`packages/control/src/simulation/write.ts`), not a call into the providers package: control must not import providers (the boundary test `packages/control/test/simulation-boundary.test.ts` enforces it), so the one provider that reports cost is named there and `cursor` gets its own refusal reason. A provider added to `capabilitiesOf` is therefore NOT automatically accepted by `createSimulation` -- the allow-list is edited by hand, deliberately.

- **R9 (Task 6):** the automatic isolation-breach halt inside `applyModelDecision` is NOT the same code path as the manual `haltSimulation` verb (`write.ts`'s `setStatus`) that the `§6 (Task 4)` entry above describes: a breach journals `control { op: 'isolation_breach', role, tools, usageSeq }` then, through `clearAutoRun`, `control { op: 'auto_run_stopped', reason: 'halted' }` — it never journals `control { op: 'model_calls_blocked' }`. That entry is written only by `setStatus`, for the operator-initiated halt, never for an automatic one. Confirmed by reading `packages/control/src/simulation/llm.ts` rather than assumed, because the two halts read almost the same in prose but are not the same in the journal; `gate:m31a-llm-decisions` asserts the breach path's exact entries and asserts `model_calls_blocked` is absent. Amended by R12 below: the breach path now journals three rows, not two.

- **M32 item 2 (supersedes R7):** the model step is off the daemon's loop. A pass prepares each due llm run, STARTS `modelDecider(...)` without awaiting it, records the run id in a module-level in-flight set in `packages/control/src/simulation/auto-run.ts` (`inFlightModelCalls()`, `drainModelCalls()`) and returns; when the promise settles `applyModelDecision` runs (stale / breach / failure exactly as before) and the id leaves the set. Consequences, all of them deliberate: every due llm run starts in the SAME pass (up to `maxConcurrentModelCalls`, from the daemon's `SLAVEOFAI_MAX_MODEL_CALLS`, default 3), a run whose call is still out is skipped by later passes (`skippedInFlight` — nothing about the ROW says a decision is in flight, so the set is the only record and the only thing preventing a second paid call for the same day), filling the cap is the same kind of skip, an error in the detached apply halts the run through `haltUnparsed` and never throws out of the pass, and `stepped`/`halted` in the report now count only what the pass finished itself — an llm run's outcome lands in its journal, and the pass reports `startedModelCalls` instead. The daemon awaits `drainModelCalls()` on shutdown before `prisma.$disconnect()`: an apply is the database write that records a call the account was already billed for (§2.6), and disconnecting under it would lose exactly that.

- **R10 (final review):** the cap is enforced on `chargedUsd = spentUsd + unmeasured × PER_CALL_CAP_USD`, not on the measured spend alone -- an unmeasured call is stored as a NULL cost (the ledger never invents a figure) but counts its per-call ceiling against the cap, because counting it as $0 would let a provider that reports nothing run to the horizon under any cap. `model_budget_exhausted` carries `{ spentUsd, unmeasured, chargedUsd, capUsd }`, `remainingUsd` is measured against `chargedUsd` too, and the run page's panel says `· <n> unmeasured (charged as $1.00 each toward the cap, an estimate)` (wording from M32 item 4: $1.00 is the most such a call could have cost, not what it did cost, so the panel names the arithmetic as the estimate it is) so the charge is never silent.

- **M32 item 1:** the OPERATOR's `stopAutoRun` bumps `version` too, for exactly R11's reason: it clears the intent and moves neither `status` (a stopped run stays `running`) nor `simTime`, so `version` was the only field the stream could notice it by. A consequence for `applyModelDecision`'s stale check: a decision that was in flight when somebody stopped the run is now stale by `version`, not by `intent_cleared` — the third question stays (it is the only one that answers for a writer that clears an intent without moving the other two) and is tested directly rather than through `stopAutoRun`.

- **R11 (final review):** the `until_day` intent-clear bumps `version` -- in `prepareModelDecision`'s branch and in `autoStepDue`'s. The clear moves neither `status` nor `simTime`, so `version` is the only field `useSimulationStream` can notice it by; without the bump the run page went on offering "Stop auto-run" for an intent that no longer existed until somebody reloaded. The gate's `page.reload()` workaround before re-arming is gone with it (the bounded wait for the start controls stays).

- **R12 (final review):** the automatic isolation-breach halt journals `control { op: 'halted', reason }` between `isolation_breach` and `auto_run_stopped`, like every other halt path (`setStatus` for the operator's verb, `haltUnparsed` for the daemon's error path). The breach row names what was FOUND; the `halted` row names what was DONE about it, and a reader scanning the journal for "when did this run stop, and why" must find the same row here as anywhere else. R9's "exact two entries" is amended to three; `model_calls_blocked` is still never journaled by an automatic halt.

- **Journal watermark (final review):** a `stale_decision` row is written at the journal's own `max(seq) + 1` AND moves the run's `state.journalSeq` to it, in the same transaction. A stale decision is not terminal -- the run is still running, still armed, still haltable -- and every other writer computes its seq as `state.journalSeq + 1`, so leaving the watermark behind made the next write of any kind (a step, a halt, a re-armed auto-run) collide on the journal's `(simulationId, seq)` unique and throw. The one writer that still does NOT move the watermark is the exhausted-budget `journalControl`, and only because `haltUnparsed` halts the run on the very next line: `halted` is terminal for every journal writer in the package.
