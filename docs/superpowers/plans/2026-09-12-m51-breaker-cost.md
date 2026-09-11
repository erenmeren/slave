# M51 Behavioural Circuit Breaker + Actual Cost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run that is not getting anywhere is stopped in three rungs, each louder than the last — the Supervisor STEERS it with a fixed system sentence, the system CONSTRAINS what is left of its tool budget, the backend STOPS it and lets the existing failure streak count the stop. What the detector reads is persisted, so the verdict is reproducible from the event log months later: every tool call carries its id and a hash of its arguments, every tool result carries `ok`/`error` and nothing else, and the arguments themselves are never written down. A quiet twenty-minute build is not a loop — progress is the disjunction of three cheap clocks, debounced over two beats, and a tool call with no result yet suppresses every arm. And money stops being one number: **Actual** is what a provider reported, **Estimated** is tokens × a fallback-only price table, **Upper bound** is the safe figure the budget guardrail has always used — three answers to three different questions, exactly one of which any guardrail believes.

**Architecture:** One pure domain module per idea and no more. `packages/domain/src/breaker/{constants,detect}.ts` holds the ladder's numbers and `detectBehaviour`, a total function over a window the CALLER measured — no clock, no Prisma, no git. `packages/domain/src/guardrails/{kinds,pricing}.ts` close the two "labels never keys" holes: the sixteen guardrail spellings become a union with a label table, and the price table becomes data. One Prisma enum (`BreakerLevel`) and seven `SlaveRun` columns carry the ladder's state; two new `ExecutionEvent` types (`run.tool_result`, `run.breaker`) and two new fields on `run.tool_call` carry its evidence. Enforcement splits three ways on purpose — the SUPERVISOR steers (situation `run_looping` → action `steer_run`, `applied`, whose text is a system constant and never a model's words), CONTROL constrains (`packages/control/src/breaker.ts`), the ORCHESTRATOR stops (the sweep's own claim/cancel shape plus one new `guardrail.tripped` name). `workspaceSpend`, `stats.spentUsd` and `evaluateGuardrails`'s budget arm are untouched; the three cost figures are a DISPLAY projection built in `apps/web/src/server/brief.ts`.

**Tech Stack:** TypeScript monorepo, Next.js 15 App Router + React 19, Tailwind v4 (configured by `@theme inline` inside `apps/web/src/app/globals.css` — there is no `tailwind.config.*`), zod, vitest (two projects: `unit`, `integration`), Prisma 7 + Postgres (:5433), plain-`node` `.mjs` gates driving `playwright-core`.

**Spec:** `docs/superpowers/specs/2026-09-12-m51-breaker-cost-design.md` (rulings R1–R8; §4 errata). Its parents are `docs/superpowers/specs/2026-09-10-roadmap-m44-m56.md` (row M51, and line 28: "**Circuit breaker and capability broker are extensions** of existing guardrails and `SlavePermission`, named as such; the hook event plane is a bounded spike inside M51"), `docs/decisions/0001-pause-semantics.md` (the hook contract the tap must not break), `docs/superpowers/specs/2026-09-09-m38-supervisor-design.md` (situations → candidates → tiers → decide → apply, and §8's "no per-workspace thresholds") and `docs/ia.md` (rule 3, labels never keys). **M52 owns permissions and the capability broker; M53 owns evidence-based ranking. Nothing in this plan reads a `SlavePermission` and nothing ranks anything.**

Plan-time errata, every one read out of the code and baked into the tasks below. The long form, with file and line evidence, is in the session notes (`m51-plan-notes.md`); each is also to be appended to the spec's §4 during execution.

- **E1 (amends R5) — `pricing.ts` cannot live in `packages/providers`.** `apps/web/package.json` lists `@slave-of-ai/control`, `@slave-of-ai/db`, `@slave-of-ai/domain`, `@slave-of-ai/events` and `@slave-of-ai/simulation` — **not** `@slave-of-ai/providers**, and `apps/web/src/lib/providerLabel.ts:13-41` records why that barrel must not be reached from a client component (it re-exports `claude/adapter.ts`, which imports `node:child_process`). The brief, the drawer and Analytics all need the estimate. The table and `estimateCostUsd` therefore live in **`packages/domain/src/guardrails/pricing.ts`** — pure data and one pure function, importable by web, control, orchestrator and providers alike. `packages/providers/src/models.ts` keeps the id/label listing it already owns.
- **E2 (amends R1) — the vendor-neutral `tool_call` must carry `argsHash` too.** The pump only ever sees a `RuntimeEvent` (`apps/orchestrator/src/pump.ts:642-663`); `run.tool_call`'s payload cannot gain a field the event it is built from does not have. `RuntimeEvent`'s `tool_call` member gains `argsHash: string`, computed by BOTH parsers (`packages/providers/src/claude/stream.ts:411-416` from the `tool_use` block's `input`, `packages/providers/src/cursor/stream.ts:357-363` from the tool object's `args`), and `hashToolInput` is a providers-side pure function because that is where both parsers are.
- **E3 (amends R1) — Cursor's `completed` line carries no `is_error`.** The measured shape (`packages/providers/test/fixtures/cursor/cursor-run.ndjson` line 7) is `{"readToolCall":{"args":{...},"result":{"success":{...}}}}`, and the one other measured result shape is `result.rejected` (`fixtures/cursor/gate/run-2-flag-present.ndjson`). So `outcome` is `'ok'` when `result` has a `success` key and `'error'` otherwise; `rejected` is checked FIRST and still returns `permission_denied` (`cursor/stream.ts:320-337`), which keeps one line to one event.
- **E4 (amends R5) — assistant-line usage does not sum to the `result` line's figure, and the terminal write must stop erasing it.** Measured on `packages/providers/test/fixtures/complete.ndjson`: the four assistant lines report `output_tokens` 2 + 2 + 20 + 3 = **27** while the `result` line reports **741**; input is 8 against 4. The mid-run figure is therefore an explicit **floor**, said so in the column's docstring and pinned by a test that asserts the two disagree. And `writeStreamUsage` (`apps/orchestrator/src/pump.ts:220-233`) currently writes `tokensIn: outcome.tokens?.input ?? null` — with a mid-run writer in place that ERASES a real measurement on every degraded `result` line. It returns early instead when `outcome.tokens === null`.
- **E5 (amends R2) — the beat and the debounce need two columns the spec did not name.** `SlaveRun` has no `updatedAt` (`packages/db/prisma/schema.prisma:696-766`), so "at most once per `BREAKER_BEAT_MS` per run" has no clock to read; and `no_progress` is "all three clocks false for `NO_PROGRESS_BEATS = 2` **consecutive beats**", which a pure detector cannot remember. The migration adds `breakerBeatAt DateTime?` and `breakerQuietBeats Int @default(0)` beside the five R2 names.
- **E6 (amends R2) — the sweep `continue`s before the breaker could ever run.** `apps/orchestrator/src/sweep.ts:410` is `if (!timedOutNow && !overCapNow) continue`, so a healthy run leaves the loop body before line 412. The breaker pass goes INSIDE that branch (`{ await beatBreaker(...); continue }`), which is also exactly what R2's "after them" means: a run past a hard limit is stopped for that reason and never reaches the breaker.
- **E7 (amends R1) — `GitProbe` is a two-method interface with a live injection seam.** `packages/control/src/git-probe.ts:10-13` is `{ isRepository, branchExists }`, injected by `useGitProbe` (`packages/control/src/workspace.ts:132`); a third REQUIRED method breaks every fake. A separate `WorktreeProbe { fingerprint(path): Promise<string | null> }` and `realWorktreeProbe` land beside it in the same file, injected on `SweepDeps` — the shape R1 wanted, with none of the breakage.
- **E8 (amends R3) — a steer is two phases, because `requestPause` does not produce a `paused` run.** `requestPause` claims `pause_requested` (`packages/control/src/pause.ts:53-58`); only the pump reaches `paused`, after the gate denies a call. `requestResume` refuses anything but `paused` (`packages/control/src/resume.ts:126`). And `paused` is not in `SWEEPABLE` (`apps/orchestrator/src/sweep.ts:41,50`), nor would it survive `run.pid === null` at `:398`. So `steerRun` does phase A only — claim the pause and queue the text in one call — and a NEW per-tick pass, `deliverBreakerSteers`, does phase B on whichever tick finds the run `paused`. Its predicate is derivable and needs no column: `breakerLevel != none` AND `status = paused` AND `pauseReason = guardrail` AND `queuedMessage != null` AND `resumeRequestedAt = null`. Nothing else in the tree pauses with a queued message (`tick.ts:253` is the only other `'guardrail'` pause and it queues nothing).
- **E9 (amends R3) — `SupervisorWorld` has no runs at all.** There is no `SupervisorRun` type (`packages/domain/src/supervisor/world.ts:271-316` lists eleven collections and none of them is runs); `SupervisorSlave.busy` is `row.runs.length > 0` (`packages/control/src/supervisorWorld.ts:764`) and is the only run-derived fact in the world. `run_looping` cannot be raised from rows the loader "already reads". `SupervisorWorld` gains `runs: readonly SupervisorRun[]`, and the loader gains one `slaveRun.findMany` over non-terminal runs plus — only when some loaded run is at a level above `none` — one `DISTINCT ON (e."runId")` read of the newest `run.breaker` per run, modelled line for line on `loadLatestGuardrails` (`supervisorWorld.ts:271-285`).
- **E10 (amends R5) — `SlaveRun.model` is not written at `runs.ts:44`.** `createRunUnlessArchived` (`apps/orchestrator/src/runs.ts:31-47`) is a generic archive-guarded insert that names no provider. `provider` is written STRICTLY AFTER `adapter.start()` returns, at three `slaveRun.update` sites — `apps/orchestrator/src/tick.ts:696-712`, `planning.ts:574`, `review.ts:520` — which is the rule `packages/domain/src/guardrails/spend.ts:54-64` is built on. `model: resolved.model ?? null` joins those three, and `resume.ts:117` carries `checkpoint.model` the way it already carries `checkpoint.provider`.
- **E11 (amends R6) — `preflightGate` cannot pre-flight a tap.** It arms and disarms a pause flag and asserts BOTH directions (`packages/providers/src/runtime/gate-preflight.ts:98-141`); a PostToolUse tap never denies, so the armed direction fails by construction. The tap gets `preflightTap({ tapPath })` in the same file: one spawn, a synthetic PostToolUse payload on stdin, `SLAVEOFAI_TOOL_RESULTS` pointed at a temporary file, and three assertions — exit 0, EMPTY stdout (a tap that speaks would be read by the CLI as a hook response), and exactly one line written that parses to the four fields.
- **E12 (amends R2) — 53 event types today, so the two new ones are the 54th and 55th.** `packages/domain/src/events/schema.ts` has 53 `z.literal` arms and `packages/domain/test/supervisor/timeline.test.ts:18-19` asserts `LANE_BY_TYPE` has 53 keys. `run.tool_result` is the 54th (lane `null`, like `run.tool_call` beside it) and `run.breaker` the 55th (lane `work`); the count moves 53 → 55.
- **E13 (amends R7) — `actual` REPLACES the `measured $X` line, it does not join it.** `ProjectBrief.cost.measuredUsd` is `spend.runsMeasuredUsd + spend.supervisorMeasuredUsd` (`apps/web/src/server/brief.ts:295`) — which is exactly R5's Actual, to the cent. Printing both would be two labels on one number. The tile therefore grows by TWO lines, not three, which matters because `gate:m45` stage 1 fails any tile whose bottom edge falls below the 900px fold (`scripts/gate-m45-project-experience.mjs:750-757`). Its stage-1 cost expectations at `:766-767` (`'$25'`, `'unmeasured calls charged at $1.00 each'`) do NOT move: both lines survive verbatim.
- **E14 (amends R5/R7) — `SpendRow` cannot answer "estimated".** It is `{ costUsd, provider, status }` (`packages/domain/src/guardrails/spend.ts:24-33`) and the shared read selects exactly those three columns (`apps/web/src/server/overview.ts:481-484`). The domain gains `CostRow` (a `SpendRow` plus `tokensIn`, `tokensOut`, `model`), the select grows three columns, and `ProjectBriefReads.spendRows` is typed `readonly CostRow[]`. `sumSpend`/`sumSpendFromGroups` and `packages/domain/test/spend-groups.test.ts` are untouched — a `CostRow` IS a `SpendRow`.
- **E15 (amends R4) — adding `GUARDRAIL_KINDS` to `gate:m44`'s blocklist makes the existing guardrail card a leak.** Sixteen of the seventeen spellings contain `_`, so the derived filter (`scripts/gate-m44-ux-foundation.mjs:141-175`) really does take them, and `GuardrailTrippedCard` prints `label={payload.guardrail}` raw today (`apps/web/src/components/activity/cards.tsx:385`). The label fix is not cosmetic and it is not optional; Task 5 ships it and Task 6 adds the tokens, in that order, with a grep step that proves no OTHER surface prints a guardrail key.
- **E16 (amends R8) — there is no per-run WORK fixture knob, so one daemon cannot plan normally and loop on work.** `m8-flow`'s work arm is the `m8a-flow` body verbatim (`packages/providers/test/fake-claude.mjs:31-44`) — it writes a file and COMMITS it, which would move the worktree clock and suppress every trip. `fake-claude.mjs` gains `--work-fixture <name>`, the exact shape of `--plan-fixture` (`:243-258`) and `--review-fixture` (`:260-273`), and that arm REPLAYS ONLY — no write, no commit — so the quiet-worktree clock says what it means.
- **E17 (amends R1) — `errorClass` is a closed PRODUCER union and a forgiving string on the wire.** R4's own reasoning (`packages/events/src/read.ts:23-26` throws on a row the domain cannot parse) applies to the new payload too: `z.string().max(40).nullable()` in the schema, `ToolErrorClass` (`'api_error' | 'timeout' | 'not_found' | 'permission' | 'other'`) in `packages/providers/src/tool-result.ts` where a mistake is a build error.
- **E18 (amends R8) — both new fixtures must end with the routine `Stop` hook line.** `packages/providers/test/fake-claude.test.ts:76-96` enumerates every `*.ndjson` directly under `test/fixtures/` and asserts its last parseable line is `{ type: 'system', subtype: 'hook_response', hook_event: 'Stop' }`. `loop.ndjson` and `error-storm.ndjson` are in that namespace (that is how `--fixture` finds them) and both carry one.

## Global Constraints

- **Never a real model call.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and the fake CLI `packages/providers/test/fake-claude.mjs`; the browser gates need `SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh"`. **The steer text is a CONSTANT, not a draft**: `steer_run` is the first `applied` action that puts words in front of a running worker, and it is defensible only because no model ever sees the sentence. Nothing in this milestone calls a model to decide anything.
- One vitest process at a time (the shared test database truncates), and **never a gate beside vitest**.
- **`npm run web:build` never while `next dev` is running.** Before any `web:build`, run `pgrep -af "next dev"`; if one is up, `kill <pid>` it and **say so in the task report**. Restarting dev afterwards needs `rm -rf apps/web/.next` first. Only Task 5 and Task 6 run `web:build`.
- **No prettier.** There is no prettier config in this repository; match the surrounding file's style by hand.
- Inside `apps/web`, import siblings **without** a `.js` suffix (`../server/brief`, not `../server/brief.js`); `packages/*` keep the `.js` suffix.
- Read an exit code with `${PIPESTATUS[0]}`; never `cmd | tail; echo $?` — that reports `tail`'s status.
- After `npm run db:generate`, run `npx tsc --build` **before** any integration test: the generated client's types are what the test files compile against.
- The vocabulary word is **slave**, fixtures included. `npm run gate:m26-vocabulary` after every task.
- Refusals are `ok()` / `err()`; **a refusal after a write inside `$transaction` must throw**, or Prisma commits that write. Every refusal in this milestone is returned BEFORE the first write in its transaction, so all of them are values.
- **A refusal kind reaches three homes:** the union + `refusalText` (`packages/control/src/refusal.ts`), the CLI (`throw new Error(refusalText(result.error))`), and the web (`apps/web/test/refusal-status.test.ts`'s `ALL_KINDS` record, which is `Record<ControlRefusal['kind'], true>` and fails the build when a kind is missing).
- **`decide()` is unchanged.** `packages/domain/src/scheduler/decide.ts` and `packages/domain/test/scheduler/decide.test.ts` are in no task's file list. A constrained run is not undispatchable — it is a RUNNING run with a lower ceiling, and the ceiling is read by the sweep, never by the scheduler.
- **`workspaceSpend`, `stats.spentUsd` and `evaluateGuardrails`'s budget arm do not move.** `packages/control/src/spend.ts` and `packages/control/src/stats.ts` appear in NO task's file list. The `budget_exhausted`/`budget_warning` branches of `packages/domain/src/guardrails/evaluate.ts:96-111` keep every character. `gate:m38-supervisor` stage 3 (`scripts/gate-m38-supervisor.mjs:545-588`) is asserted unchanged in Task 6 and re-run in its ladder.
- **A new event type touches NINE sites, and both new events pay it:** the Zod union (`packages/domain/src/events/schema.ts`); `EventType` in `packages/db/prisma/schema.prisma` **plus the migration's `ALTER TYPE … ADD VALUE IF NOT EXISTS`**; `EVENT_TYPE_BY_DOMAIN_TYPE` (`packages/db/src/enums.ts`); `LANE_BY_TYPE` (`packages/domain/src/supervisor/timeline.ts:52`); the card component + the `ACTIVITY_CARDS` registry (`apps/web/src/components/activity/cards.tsx`); `TYPES_BY_KIND` (`apps/web/src/lib/activityFilters.ts`, RUNTIME-checked for exhaustiveness); the sentence in `apps/web/src/server/timeline.ts`; `PAYLOAD_BY_TYPE` in `apps/web/test/activity-cards.test.tsx`; and the count in `packages/domain/test/supervisor/timeline.test.ts:19` (53 → 55).
- **Migrations are additive and applied to both databases** (`npm run db:migrate` and `npm run db:migrate:test`) with the Prisma 7 diff proof: `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` → "No difference detected". The migration directory for this milestone is **`packages/db/prisma/migrations/20260912150000_m51_breaker`**, and it carries **no data statement at all**: every column has a default or is nullable, and no existing row means anything different under the new schema.
- **Labels never keys.** `docs/ia.md` rule 3: no surface prints `behavioural_loop`, `repeated_call` or `constrained` as its visible text. `GUARDRAIL_LABEL`, `BREAKER_TRIP_LABEL` and `USER_CARD_LABEL` supply the words; the raw value stays in `title` / a `data-` attribute.
- **Determinism everywhere.** `detectBehaviour` is total and clock-free; `hashToolInput` sorts keys; the ladder moves at most one rung per beat; the same window produces the same verdict whatever order a query returned rows in.
- **Nothing the breaker does may throw out of a tick.** `beatBreaker` and `deliverBreakerSteers` run inside `sweep()`, which runs inside the daemon's tick; every probe is `try`/`catch` returning `null`, every control call's refusal is logged and skipped, and a `null` fingerprint reads as "no evidence either way", which SUPPRESSES the arm rather than tripping it.
- **Test baseline: ≥ 316 test files / ≥ 4930 tests** (the whole suite at `7c1d08a`, the M50 final ladder's `npm test`). Every task's ladder ends at or above that, never below. If the M50 ladder's own numbers differ when this plan is executed, take THEM as the baseline and say so in the first task report.
- **25 CI gates become 26.** `gate:m50-ephemeral` is the 25th (`.github/workflows/ci.yml:78`); the new `gate:m51-breaker` step goes immediately after it, and README's roster sentence says 26.
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
  ```
- Every task ends with focused tests, `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck` and a commit. Web tasks also run `npm run web:build` (subject to the `next dev` rule above) and `npm run gate:m44-ux-foundation` as the browser check.
- Anything touching the database goes under `test/integration/` and is named `*.test.ts` — `vitest.config.ts`'s `integration` project includes `**/test/integration/**/*.test.ts` only (no `.tsx`), and only that project loads `test-setup/require-database.ts`. Component tests are `*.test.tsx` under `apps/web/test/` with a `// @vitest-environment jsdom` first line.
- **The implementer never dispatches subagents.**

---

## File structure

```
packages/domain/src/guardrails/kinds.ts        R4: GUARDRAIL_KINDS, GuardrailKind, GUARDRAIL_LABEL (new)
packages/domain/src/guardrails/pricing.ts      R5/E1: MODEL_PRICES, PRICE_ALIASES, estimateCostUsd,
                                               normaliseModelId (new)
packages/domain/src/guardrails/evaluate.ts     R4: GuardrailBreach.guardrail becomes GuardrailKind
packages/domain/src/guardrails/spend.ts        R5/E14: CostRow, CostProvenance, costProvenanceOf,
                                               RUN_UNMEASURED_CAP_USD
packages/domain/src/breaker/constants.ts       R1/R2/R3: the ten numbers and BREAKER_STEER_TEXT (new)
packages/domain/src/breaker/detect.ts          R1: BreakerLevel, BREAKER_LEVELS, BreakerTrip,
                                               BreakerWindow, BreakerVerdict, detectBehaviour (new)
packages/domain/src/breaker/index.ts           (new) -- ./constants.js, ./detect.js
packages/domain/src/index.ts                   + ./breaker/index.js, + ./guardrails/{kinds,pricing}.js
packages/domain/src/status/user.ts             R7: UserCardState +2, UserCardFacts, userRunStatus's
                                               optional second argument
packages/domain/src/events/schema.ts           R1/R2/E12: run.tool_call +2 fields, run.tool_result (54th),
                                               run.breaker (55th)
packages/domain/src/supervisor/situations.ts   R3: run_looping (16th) + its SITUATION_LABEL
packages/domain/src/supervisor/constants.ts    R3: COOLDOWN_BY_KIND
packages/domain/src/supervisor/observe.ts      R3: the run_looping predicate; filterFresh's per-kind cooldown
packages/domain/src/supervisor/actions.ts      R3: steer_run (16th) + its schema arm
packages/domain/src/supervisor/candidates.ts   R3: the run_looping arm
packages/domain/src/supervisor/policy.ts       R3: tierOf(steer_run) = applied, and WHY
packages/domain/src/supervisor/world.ts        R3/E9: SupervisorRun, SupervisorWorld.runs
packages/domain/src/supervisor/timeline.ts     R2/E12: LANE_BY_TYPE gains two
packages/domain/test/breaker/{constants,detect}.test.ts                 (new)
packages/domain/test/guardrails/{kinds,pricing,spend}.test.ts           (new/extended)
packages/domain/test/{events/schema,status/user}.test.ts                extended
packages/domain/test/supervisor/{fixtures,observe,candidates,policy,labels,timeline}.test.ts  extended

packages/db/prisma/schema.prisma               R2/R5: enum BreakerLevel, seven SlaveRun columns,
                                               two EventType members, one SupervisorSituationKind member
packages/db/prisma/migrations/20260912150000_m51_breaker/migration.sql  (new)
packages/db/src/enums.ts                       R2: EVENT_TYPE_BY_DOMAIN_TYPE gains two
packages/db/test/integration/enum-parity.test.ts                        + one assertion (BreakerLevel)

packages/providers/src/hash.ts                 R1/E2: hashToolInput + the three caps (new)
packages/providers/src/tool-result.ts          R1/E17: TOOL_ERROR_CLASSES, classifyToolError (new)
packages/providers/src/types.ts                R1/R5/E2: tool_call.argsHash, tool_result, usage
packages/providers/src/capabilities.ts         R6: reportsToolResults on both rows
packages/providers/src/claude/adapter.ts       R6: ProviderCapabilities.reportsToolResults, tapPath,
                                               the tail producer and the toolUseId dedupe
packages/providers/src/claude/settings.ts      R6: ClaudeSettings.PostToolUse, buildSettings's tapPath
packages/providers/src/claude/stream.ts        R1/R5/E2: argsHash, the user/tool_result arm, parseStreamUsage
packages/providers/src/cursor/stream.ts        R1/E2/E3: argsHash, the completed arm
packages/providers/src/runtime/process.ts      R6: buildChildEnv's SLAVEOFAI_TOOL_RESULTS
packages/providers/src/runtime/gate-preflight.ts  R6/E11: preflightTap (new export)
packages/providers/src/index.ts                + ./hash.js, ./tool-result.js
scripts/tool-result-tap.sh                     R6 (new)
packages/providers/test/{hash,tool-result,stream,cursor-stream,claude-settings,tool-result-tap}.test.ts

packages/control/src/breaker.ts                R3 (new): steerRun, constrainRun, deliverBreakerSteer
packages/control/src/git-probe.ts              R1/E7: WorktreeProbe, realWorktreeProbe
packages/control/src/refusal.ts                R3: two kinds -- run_not_steerable, breaker_not_armed
packages/control/src/supervisor.ts             R3: carryOut's steer_run arm
packages/control/src/supervisorWorld.ts        R3/E9: the runs read and the breaker-event read
packages/control/src/index.ts                  + ./breaker.js
packages/control/test/integration/{breaker,supervisor,supervisorWorld}.test.ts
apps/web/test/refusal-status.test.ts           the two kinds

apps/orchestrator/src/pump.ts                  R1/R5/E4: the widened tool_call emit, the tool_result and
                                               usage arms, the mid-run token write, the checkpoint estimate
apps/orchestrator/src/sweep.ts                 R2/R3/E6/E8: beatBreaker, deliverBreakerSteers, the
                                               per-run cap, behavioural_loop
apps/orchestrator/src/{tick,planning,review,resume}.ts   R5/E10: model beside provider
apps/orchestrator/src/cli.ts                   R3: `breaker --run <id>` (read-only)
apps/orchestrator/test/integration/{sweep,pump,cli}.test.ts

apps/web/src/lib/realMoney.ts                  R5 (new): formatUsd
apps/web/src/lib/tones.ts                      R7: two members in TONE_AND_PULSE
apps/web/src/server/brief.ts                   R7/E13/E14: cost +3, CostRow
apps/web/src/server/overview.ts                R7/E14: the three extra columns
apps/web/src/server/tasks.ts                   R7: TaskRunSummary +4
apps/web/src/server/analytics.ts               R7: the upper-bound note
apps/web/src/server/timeline.ts                R2: two sentences
apps/web/src/lib/activityFilters.ts            R1/R2: two types
apps/web/src/components/activity/cards.tsx     R2/R4: BreakerCard, ToolResultCard, the guardrail LABEL
apps/web/src/components/project/ProjectBrief.tsx  R7/E13: the three cost lines
apps/web/src/components/TaskDetailPanel.tsx    R7: provenance per run and `retried work`
apps/web/src/components/SlaveCard.tsx / OverviewClient.tsx  R7: the STEERED/CONSTRAINED word
apps/web/src/components/SupervisorPanel.tsx    R3: actionText's steer_run arm
apps/web/test/{project-brief,task-detail-panel,activity-cards,activityFilters,real-money}.test.tsx

packages/providers/test/fixtures/loop.ndjson            R8 (new)
packages/providers/test/fixtures/error-storm.ndjson     R8 (new)
packages/providers/test/fake-claude.mjs                 R8/E16: --work-fixture
scripts/gate-m51-breaker.mjs                            R8 (new)
scripts/gate-m44-ux-foundation.mjs                      R7: RAW_TOKENS gains GUARDRAIL_KINDS + BREAKER_LEVELS
package.json, .github/workflows/ci.yml, README.md       R8
docs/superpowers/fidelity/m14/overview.png              regenerated in its own commit
docs/superpowers/specs/2026-09-12-m51-breaker-cost-design.md   the spec, committed verbatim + §4
```

---

### Task 1: The guardrail vocabulary, the breaker's pure core, the price table and the two new card words (R1, R2, R4, R5, R7, E1, E13, E14, E17, D1–D6)

Pure `packages/domain` only. No Prisma, no `node:`, no event schema, no situation — this task is the set of total functions every later task calls, and it ends green on `npx vitest run packages/domain` alone.

**Files:**
- Create: `packages/domain/src/guardrails/kinds.ts`, `packages/domain/src/guardrails/pricing.ts`, `packages/domain/src/breaker/constants.ts`, `packages/domain/src/breaker/detect.ts`, `packages/domain/src/breaker/index.ts`, `packages/domain/test/guardrails/kinds.test.ts`, `packages/domain/test/guardrails/pricing.test.ts`, `packages/domain/test/breaker/constants.test.ts`, `packages/domain/test/breaker/detect.test.ts`
- Modify: `packages/domain/src/index.ts`, `packages/domain/src/guardrails/evaluate.ts`, `packages/domain/src/guardrails/spend.ts`, `packages/domain/src/status/user.ts`, `apps/web/src/lib/tones.ts`
- Test: the four new domain test files, plus `packages/domain/test/guardrails/{evaluate,spend}.test.ts` and `packages/domain/test/status/user.test.ts`

**Interfaces:**
- Consumes: `NON_TERMINAL_RUN_STATUSES`, `RunStatus` (`packages/domain/src/run/state.js`); `RunStatus`/`SlaveStatus` in `status/user.ts` as today. Nothing else.
- Produces, for Tasks 2–6:
  - `GUARDRAIL_KINDS` (17 members) `as const`, `type GuardrailKind`, `GUARDRAIL_LABEL: Record<GuardrailKind, string>`
  - `GuardrailBreach.guardrail: GuardrailKind` (was `string`)
  - `BREAKER_LEVELS = ['none', 'steered', 'constrained'] as const`, `type BreakerLevel`, `BREAKER_LEVEL_LABEL`
  - `BREAKER_TRIP_KINDS = ['repeated_call', 'error_storm', 'no_progress'] as const`, `type BreakerTripKind`, `BREAKER_TRIP_LABEL`
  - `interface BreakerTrip { kind: BreakerTripKind; count: number; detail: string }`
  - `interface BreakerWindow { level, trips, steers, quietBeats, rows: readonly BreakerRow[], progress: { distinctKey, worktreeChanged, output } }` and `type BreakerRow`
  - `interface BreakerVerdict { level: BreakerLevel | 'stop'; trip: BreakerTrip | null }`
  - `detectBehaviour(window: BreakerWindow): BreakerVerdict`
  - `BREAKER_WINDOW`, `REPEAT_TRIP_COUNT`, `ERROR_STORM_COUNT`, `NO_PROGRESS_BEATS`, `BREAKER_BEAT_MS`, `BREAKER_COOLDOWN_MS`, `CONSTRAIN_GRACE_CALLS`, `STEERS_PER_RUN_MAX`, `BREAKER_STEER_TEXT`, `steerTextFor(trip)`
  - `MODEL_PRICES`, `PRICE_ALIASES`, `normaliseModelId(model)`, `estimateCostUsd(model, tokens)`
  - `RUN_UNMEASURED_CAP_USD = 1`, `interface CostRow`, `type CostProvenance`, `costProvenanceOf(row)`
  - `UserCardState` +`'steered'` +`'constrained'`, `interface UserCardFacts { breakerLevel?: BreakerLevel }`, `userRunStatus(status, facts?)`

- [ ] **Step 1: Write the failing test for the guardrail vocabulary**

`packages/domain/test/guardrails/kinds.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { GUARDRAIL_KINDS, GUARDRAIL_LABEL, type GuardrailKind } from '../../src/guardrails/kinds.js'
import { DEFAULT_GUARDRAIL_LIMITS, evaluateGuardrails } from '../../src/guardrails/evaluate.js'

describe('GUARDRAIL_KINDS', () => {
  it('is the closed list of every spelling this codebase writes, plus M51 behavioural_loop', () => {
    expect(GUARDRAIL_KINDS).toEqual([
      'emergency_stop',
      'concurrency',
      'global_concurrency',
      'budget_exhausted',
      'budget_warning',
      'circuit_breaker',
      'behavioural_loop',
      'run_timeout',
      'tool_call_ceiling',
      'pause_gate',
      'permission_mode',
      'no_planner',
      'no_reviewer',
      'review_retry_cap_exhausted',
      'merge_failure',
      'verify_could_not_run',
      'verify_failed',
    ])
  })

  it('has no duplicates -- the list is the union, so a repeat would type-check and lie', () => {
    expect(new Set(GUARDRAIL_KINDS).size).toBe(GUARDRAIL_KINDS.length)
  })

  it('gives every member a word, so no surface ever prints the key', () => {
    for (const kind of GUARDRAIL_KINDS) {
      expect(GUARDRAIL_LABEL[kind], kind).toMatch(/^[A-Z]/u)
      expect(GUARDRAIL_LABEL[kind], kind).not.toContain('_')
    }
  })

  it('names the behavioural breaker apart from the failure-streak one -- two breakers, two words', () => {
    expect(GUARDRAIL_LABEL.circuit_breaker).toBe('Too many failed runs')
    expect(GUARDRAIL_LABEL.behavioural_loop).toBe('Going in circles')
  })
})

describe('evaluateGuardrails after the union', () => {
  it('still emits exactly the six breaches it always did, and every one of them is a GuardrailKind', () => {
    const breaches = evaluateGuardrails(
      { ...DEFAULT_GUARDRAIL_LIMITS, budgetUsd: 10 },
      { activeRuns: 9, globalActiveRuns: 9, spentUsd: 99, consecutiveFailures: 9, emergencyStopped: true },
    )
    const names: readonly GuardrailKind[] = breaches.map((breach) => breach.guardrail)
    expect(names).toEqual([
      'emergency_stop',
      'concurrency',
      'global_concurrency',
      'budget_exhausted',
      'circuit_breaker',
    ])
    for (const name of names) expect(GUARDRAIL_KINDS).toContain(name)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/guardrails/kinds.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/guardrails/kinds.js"`.

- [ ] **Step 3: Write the vocabulary and narrow the breach**

`packages/domain/src/guardrails/kinds.ts`:

```ts
/**
 * Every guardrail this codebase can trip, as data (M51 R4).
 *
 * Until this milestone `GuardrailBreach.guardrail` was a bare `string` and sixteen spellings lived
 * as literals across nine production files -- `evaluate.ts` (six), `apps/orchestrator/src/sweep.ts`
 * (`run_timeout`, `tool_call_ceiling`), `pump.ts` (`pause_gate`, `permission_mode`), `planning.ts`
 * (`no_planner`), `review.ts` (`no_reviewer`, `review_retry_cap_exhausted`), `merge.ts`
 * (`merge_failure`), `tick.ts` (`budget_warning`), `packages/control/src/emergency.ts`
 * (`emergency_stop`) and `scripts/gate-m38-supervisor.mjs` (`verify_could_not_run`,
 * `verify_failed`). One typo among them produced a breach nobody could filter for and nobody could
 * label, and `REVIEW_CAP_GUARDRAIL` (`../supervisor/constants.ts`) was the only one of the sixteen
 * that had ever been given a name.
 *
 * The order is the one a reader meets them in: the workspace-wide stops first, then the two
 * breakers, then the per-run ceilings, then the gate and the staffing holes, then verify.
 *
 * THE LIST TYPES PRODUCERS, NOT THE LOG. `guardrail.tripped`'s payload stays `z.string()`
 * deliberately (R4): `packages/events/src/read.ts:23-26` THROWS on a row the domain cannot parse,
 * so a `z.enum` here would make the entire forward read of any database holding a spelling this
 * list forgot unreadable -- the whole activity stream down, for a name. A closed union types the
 * WRITERS, where a mistake is a build error; the log stays forgiving.
 */
export const GUARDRAIL_KINDS = [
  'emergency_stop',
  'concurrency',
  'global_concurrency',
  'budget_exhausted',
  'budget_warning',
  /** The FAILURE-STREAK breaker (M12): `consecutiveFailures >= consecutiveFailureLimit`, per
   *  workspace. Nothing behavioural -- it counts terminal `failed` runs in a row. */
  'circuit_breaker',
  /** M51 R3: the BEHAVIOURAL breaker's top rung -- this one run is going in circles and the
   *  backend stopped it. Its stop becomes a `failed` run, so it then counts toward
   *  `circuit_breaker` above, which is how the two compose. */
  'behavioural_loop',
  'run_timeout',
  'tool_call_ceiling',
  'pause_gate',
  'permission_mode',
  'no_planner',
  'no_reviewer',
  'review_retry_cap_exhausted',
  'merge_failure',
  'verify_could_not_run',
  'verify_failed',
] as const

export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number]

/**
 * What each guardrail is called when a person reads it (`docs/ia.md` rule 3).
 *
 * `Record<GuardrailKind, string>` is load-bearing: an eighteenth kind fails the build here rather
 * than turning up on the activity feed as an identifier. Every label is a SENTENCE FRAGMENT about
 * what happened, not a restatement of the key -- the breach's own `detail` carries the numbers.
 */
export const GUARDRAIL_LABEL: Record<GuardrailKind, string> = {
  emergency_stop: 'Emergency stop',
  concurrency: 'Too many runs at once',
  global_concurrency: 'Too many runs everywhere',
  budget_exhausted: 'Budget spent',
  budget_warning: 'Budget nearly spent',
  circuit_breaker: 'Too many failed runs',
  behavioural_loop: 'Going in circles',
  run_timeout: 'Run took too long',
  tool_call_ceiling: 'Too many tool calls',
  pause_gate: 'Pause gate broken',
  permission_mode: 'Permission mode wrong',
  no_planner: 'Nobody can plan',
  no_reviewer: 'Nobody can review',
  review_retry_cap_exhausted: 'Review attempts used up',
  merge_failure: 'Merge failed',
  verify_could_not_run: 'Verify could not run',
  verify_failed: 'Verify failed',
}
```

`packages/domain/src/guardrails/evaluate.ts` — one import and one field:

```ts
import type { GuardrailKind } from './kinds.js'
```

```ts
export interface GuardrailBreach {
  /**
   * M51 R4: the closed union, not a bare string. Every producer of a breach or of a
   * `guardrail.tripped` payload now imports a member of {@link GUARDRAIL_KINDS}, so a seventeenth
   * spelling is a build error here rather than a value nobody can filter for or label. The stored
   * payload's own schema stays `z.string()` -- see `kinds.ts` for why.
   */
  readonly guardrail: GuardrailKind
  readonly detail: string
  readonly haltsScheduling: boolean
}
```

Nothing else in that file changes: the six `breaches.push` calls already spell six members of the list, so the narrowing is checked by the compiler and by Step 1's last case.

`packages/domain/src/index.ts` gains `export * from './guardrails/kinds.js'` beside the existing guardrails exports.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/domain/test/guardrails packages/domain/test/spend-groups.test.ts`
Expected: PASS — the new file's five cases plus every case `evaluate.test.ts` and `spend.test.ts` already had, unchanged.

- [ ] **Step 5: Write the failing tests for the price table and the three cost figures**

`packages/domain/test/guardrails/pricing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { MODEL_PRICES, PRICE_ALIASES, estimateCostUsd, normaliseModelId } from '../../src/guardrails/pricing.js'

describe('normaliseModelId', () => {
  it('strips a context-window suffix -- the CLI reports `claude-opus-5[1m]` and prices the family', () => {
    // MEASURED: `packages/providers/test/fixtures/complete.ndjson`'s result line carries
    // `modelUsage: { "claude-opus-5[1m]": { canonicalModel: "claude-opus-5", ... } }`.
    expect(normaliseModelId('claude-opus-5[1m]')).toBe('claude-opus-5')
  })

  it('resolves the CLI aliases a person may have typed into a model column', () => {
    expect(normaliseModelId('opus')).toBe('claude-opus-5')
    expect(normaliseModelId('sonnet')).toBe('claude-sonnet-5')
    expect(normaliseModelId('haiku')).toBe('claude-haiku-4-5')
    expect(normaliseModelId('fable')).toBe('claude-fable-5-1')
  })

  it('leaves `default` alone -- which family the CLI picks is not knowable from here', () => {
    expect(normaliseModelId('default')).toBe('default')
    expect(MODEL_PRICES['default']).toBeUndefined()
  })

  it('is null for a null or empty model', () => {
    expect(normaliseModelId(null)).toBeNull()
    expect(normaliseModelId('')).toBeNull()
  })
})

describe('estimateCostUsd', () => {
  it('prices a million in and a million out at the table rate', () => {
    expect(estimateCostUsd('claude-opus-5', { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(30, 10)
  })

  it('prices each family differently -- one rate for every model was munder-difflin cost bug #1', () => {
    const million = { input: 1_000_000, output: 0 }
    expect(estimateCostUsd('claude-opus-5', million)).toBeCloseTo(5, 10)
    expect(estimateCostUsd('claude-sonnet-5', million)).toBeCloseTo(2, 10)
    expect(estimateCostUsd('claude-haiku-4-5', million)).toBeCloseTo(1, 10)
    expect(estimateCostUsd('claude-fable-5-1', million)).toBeCloseTo(10, 10)
  })

  it('is null for an unpriced id, a null model and a null token reading -- never 0', () => {
    expect(estimateCostUsd('default', { input: 10, output: 10 })).toBeNull()
    expect(estimateCostUsd('gpt-does-not-exist', { input: 10, output: 10 })).toBeNull()
    expect(estimateCostUsd(null, { input: 10, output: 10 })).toBeNull()
    expect(estimateCostUsd('claude-opus-5', null)).toBeNull()
  })

  it('is a measured zero for a priced model that used no tokens', () => {
    expect(estimateCostUsd('claude-opus-5', { input: 0, output: 0 })).toBe(0)
  })

  it('every alias resolves to a priced id, so an alias can never be silently unpriced', () => {
    for (const [alias, id] of Object.entries(PRICE_ALIASES)) {
      expect(MODEL_PRICES[id], `${alias} -> ${id}`).toBeDefined()
    }
  })
})
```

and, appended to `packages/domain/test/guardrails/spend.test.ts`:

```ts
import { RUN_UNMEASURED_CAP_USD, costProvenanceOf, type CostRow } from '../../src/guardrails/spend.js'

const ROW: CostRow = {
  costUsd: null,
  provider: 'claude_code',
  status: 'succeeded',
  tokensIn: null,
  tokensOut: null,
  model: null,
}

describe('RUN_UNMEASURED_CAP_USD', () => {
  it('is one dollar, the same cap an unmeasured Supervisor call is charged at', () => {
    expect(RUN_UNMEASURED_CAP_USD).toBe(1)
  })
})

describe('costProvenanceOf', () => {
  it('is `reported` whenever a figure came back, tokens or no tokens', () => {
    expect(costProvenanceOf({ ...ROW, costUsd: 3.5 })).toBe('reported')
    // A measured ZERO is still a measurement (`sumSpend`'s own `=== null` rule).
    expect(costProvenanceOf({ ...ROW, costUsd: 0 })).toBe('reported')
  })

  it('is `estimated` when nothing was reported but a priced model left tokens behind', () => {
    expect(costProvenanceOf({ ...ROW, tokensIn: 10, tokensOut: 10, model: 'claude-opus-5' })).toBe('estimated')
  })

  it('is `unmeasured` when the model is unpriced, whatever the tokens say', () => {
    expect(costProvenanceOf({ ...ROW, tokensIn: 10, tokensOut: 10, model: 'default' })).toBe('unmeasured')
    expect(costProvenanceOf({ ...ROW, tokensIn: 10, tokensOut: 10, model: null })).toBe('unmeasured')
  })

  it('is `unmeasured` when a priced model reported no tokens either', () => {
    expect(costProvenanceOf({ ...ROW, model: 'claude-opus-5' })).toBe('unmeasured')
  })

  it('never lets the estimate overwrite a reported figure -- the reported branch is checked first', () => {
    expect(costProvenanceOf({ ...ROW, costUsd: 0.01, tokensIn: 9e6, tokensOut: 9e6, model: 'claude-fable-5-1' })).toBe(
      'reported',
    )
  })
})
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npx vitest run packages/domain/test/guardrails`
Expected: FAIL — `Failed to resolve import "../../src/guardrails/pricing.js"`, and `spend.test.ts` fails with `costProvenanceOf is not a function`.

- [ ] **Step 7: Write the price table and the provenance rule**

`packages/domain/src/guardrails/pricing.ts`:

```ts
/**
 * A FALLBACK-ONLY per-model price table (M51 R5).
 *
 * ## What this is for, and the one rule that governs it
 *
 * `SlaveRun.costUsd` is what a provider REPORTED, and it is the only figure any guardrail believes
 * (`../../control/src/spend.ts`'s `workspaceSpend`, unchanged by this milestone). This table exists
 * for the OTHER case: a run that left tokens behind and no cost -- a Cursor run, a degraded Claude
 * `result` line, a run still in flight -- where a person looking at the project deserves an
 * order-of-magnitude answer rather than a dash.
 *
 * **The estimate may never overwrite a reported figure.** Every caller checks `costUsd !== null`
 * first ({@link costProvenanceOf} in `./spend.ts` is that check, written once). The cost of getting
 * this wrong is the failure mode this table is copied from: one harness priced every model at its
 * Sonnet rate, which undercosted Opus work by roughly five times, and because the wrong number
 * overwrote the right one nobody could tell.
 *
 * ## Provenance of the numbers
 *
 * List prices per MILLION tokens for the Anthropic first-party API, as published at the pin date
 * 2026-06-24. They are pinned BY HAND, the way `packages/providers/src/models.ts`'s
 * `CLAUDE_CODE_MODELS` is pinned by hand, and they are updated with it -- `source: 'static'` is the
 * honest word for both. Cache-tier rates are deliberately NOT modelled: see the billed-input note
 * below.
 *
 * ## Which token figure this multiplies, said out loud
 *
 * `RunOutcome.tokens.input` folds `input_tokens + cache_creation_input_tokens +
 * cache_read_input_tokens` together, deliberately, FOR COST
 * (`packages/providers/src/types.ts:53-63`) -- and that is the figure this function is fed. A token
 * BUDGET would want the opposite: cache READ re-bills a fixed context on every request, so counting
 * it turns a token cap into a session-length timer. Both readings are right and they answer
 * different questions; M51 estimates COST, so it uses the folded figure, and applying one blended
 * rate to it slightly OVER-states a heavily-cached run (cache reads bill at a fraction of fresh
 * input). Over-stating an estimate that no guardrail reads is the safe direction, and it is named
 * here rather than left for a reader to discover.
 */
export interface ModelPrice {
  readonly inputPerMTok: number
  readonly outputPerMTok: number
}

/** Keyed by the FULL model id the CLI accepts. Aliases resolve through {@link PRICE_ALIASES}. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
}

/**
 * The CLI's family aliases (`claude --help`, mirrored by `CLAUDE_CODE_MODELS`), resolved to the
 * model each one currently names.
 *
 * `default` is deliberately ABSENT. Which model the CLI picks when no `--model` is passed is the
 * CLI's own current choice and is not knowable from inside this repository; guessing it here would
 * put a confident wrong price on the majority of runs, since `default` is exactly what a workspace
 * that never chose a model records. An unpriced id estimates `null`, which is the true answer.
 */
export const PRICE_ALIASES: Readonly<Record<string, string>> = {
  fable: 'claude-fable-5-1',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
}

/**
 * The id {@link MODEL_PRICES} is keyed by, from whatever was stored on the run.
 *
 * Two normalisations, both measured rather than assumed. A trailing bracketed suffix is a CONTEXT
 * WINDOW variant, not a different model: the fixture's own `result` line reports
 * `modelUsage: { "claude-opus-5[1m]": { canonicalModel: "claude-opus-5", ... } }`, so the family
 * price is the right price for it. An alias is resolved after the suffix is stripped, so
 * `opus[1m]` works too.
 */
export function normaliseModelId(model: string | null): string | null {
  if (model === null) return null
  const trimmed = model.trim()
  if (trimmed === '') return null
  const bracket = trimmed.indexOf('[')
  const base = bracket === -1 ? trimmed : trimmed.slice(0, bracket)
  return PRICE_ALIASES[base] ?? base
}

/**
 * What this many tokens would have cost on this model, or `null` when that cannot be said.
 *
 * `null` in three cases and never `0` for any of them, for `SlaveRun.costUsd`'s own reason: a zero
 * is a figure a reader believes. Unknown model, unpriced model, unmeasured tokens -- all `null`. A
 * PRICED model that really used no tokens estimates `0`, which is a measurement.
 */
export function estimateCostUsd(
  model: string | null,
  tokens: { readonly input: number; readonly output: number } | null,
): number | null {
  if (tokens === null) return null
  const id = normaliseModelId(model)
  if (id === null) return null
  const price = MODEL_PRICES[id]
  if (price === undefined) return null
  if (!Number.isFinite(tokens.input) || !Number.isFinite(tokens.output)) return null
  return (tokens.input * price.inputPerMTok + tokens.output * price.outputPerMTok) / 1_000_000
}
```

`packages/domain/src/guardrails/spend.ts` — appended below `sumSpendFromGroups`, and importing the price table:

```ts
import { estimateCostUsd } from './pricing.js'
```

```ts
/**
 * A {@link SpendRow} plus what it takes to ESTIMATE the rows that reported nothing (M51 R5).
 *
 * Deliberately an extension rather than a widening of `SpendRow`: `sumSpend` and
 * `sumSpendFromGroups` are pinned against each other over the whole product of providers, statuses
 * and costs (`test/spend-groups.test.ts`), and a `CostRow` IS a `SpendRow`, so both functions keep
 * taking exactly what they took. The three extra columns are read by nothing in this file except
 * {@link costProvenanceOf}.
 */
export interface CostRow extends SpendRow {
  readonly tokensIn: number | null
  readonly tokensOut: number | null
  /** `SlaveRun.model` (M51 R5) -- the model half of the pair `resolveRuntime` dispatched with,
   *  written beside `provider` and null on every run recorded before M51. */
  readonly model: string | null
}

/**
 * WHERE one run's cost figure came from. Derived per run, never stored: the three columns already
 * say it, and a fourth column claiming it is a fourth thing to keep in step.
 */
export type CostProvenance = 'reported' | 'estimated' | 'unmeasured'

/**
 * The one place the Actual / Estimated / Unmeasured split is decided (M51 R5).
 *
 * Order is the whole rule: a REPORTED figure wins, always and first. Only when nothing was reported
 * is the price table consulted, and only when the price table has an answer is the run called
 * estimated. This is the function that makes "the estimate is fallback-only and never overwrites a
 * reported figure" a property of the code rather than a sentence in a docstring.
 *
 * Note what it does NOT do: it says nothing about whether the run is finished. `sumSpend`'s
 * `unknownRuns` is the finished-and-unmeasured count the budget surfaces use and it keeps its own
 * rule; this one answers "what kind of number can I show for THIS row", which a live run has an
 * honest answer to (`estimated`, from tokens that are now written mid-run).
 */
export function costProvenanceOf(row: CostRow): CostProvenance {
  if (row.costUsd !== null) return 'reported'
  const tokens =
    row.tokensIn === null || row.tokensOut === null ? null : { input: row.tokensIn, output: row.tokensOut }
  return estimateCostUsd(row.model, tokens) === null ? 'unmeasured' : 'estimated'
}

/**
 * What a CONCLUDED run nobody measured is worth as an UPPER BOUND, in USD (M51 R5).
 *
 * The same one dollar `SUPERVISOR_PER_CALL_CAP_USD` charges an unmeasured Supervisor call, and
 * deliberately the same number: both are "something finished, it spent real money, and nobody can
 * name how much".
 *
 * **It is a DISPLAY figure and nothing charges it.** `workspaceSpend` does not read it,
 * `stats.spentUsd` does not include it, and `evaluateGuardrails`'s budget arm never sees it. The
 * asymmetry with the Supervisor's cap is the ruling, not an oversight: an unmeasured CALL is
 * charged because it is finished and nothing will ever report it, while charging an unmeasured RUN
 * would let a budget halt fire on spending nobody measured -- which `evaluate.ts:86-95` and
 * `packages/control/src/stats.ts:183-187` both refused in writing, and which would move
 * `gate:m38-supervisor` stage 3, whose whole purpose is asserting that a halt's reason is
 * `budget_exhausted` and not something else. Showing a bound and charging for it are different
 * acts; M51 does the first only.
 */
export const RUN_UNMEASURED_CAP_USD = 1
```

`packages/domain/src/index.ts` gains `export * from './guardrails/pricing.js'`.

- [ ] **Step 8: Run them and watch them pass**

Run: `npx vitest run packages/domain/test/guardrails packages/domain/test/spend-groups.test.ts`
Expected: PASS — 11 new pricing cases, 6 new provenance cases, and every existing `spend.test.ts` and `spend-groups.test.ts` case unchanged (a `CostRow` is structurally a `SpendRow`, so nothing there recompiles differently).

- [ ] **Step 9: Write the failing tests for the constants and the detector**

`packages/domain/test/breaker/constants.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  BREAKER_BEAT_MS,
  BREAKER_COOLDOWN_MS,
  BREAKER_STEER_TEXT,
  BREAKER_WINDOW,
  CONSTRAIN_GRACE_CALLS,
  ERROR_STORM_COUNT,
  NO_PROGRESS_BEATS,
  REPEAT_TRIP_COUNT,
  STEERS_PER_RUN_MAX,
  steerTextFor,
} from '../../src/breaker/constants.js'
import { BREAKER_TRIP_KINDS } from '../../src/breaker/detect.js'
import { COOLDOWN_MS } from '../../src/supervisor/constants.js'

// Pinned the way `SUPERVISOR_PER_CALL_CAP_USD` is pinned by
// `packages/domain/test/supervisor/constants.test.ts`: these are DOMAIN constants, not workspace
// settings (M38 section 8), so the only thing standing between a number and a silent edit is a test
// that says what it is.
describe('the breaker constants', () => {
  it('reads sixty rows of the run and no more', () => {
    expect(BREAKER_WINDOW).toBe(60)
  })

  it('trips a repeat at eight, an error storm at five, and no-progress after two beats', () => {
    expect(REPEAT_TRIP_COUNT).toBe(8)
    expect(ERROR_STORM_COUNT).toBe(5)
    expect(NO_PROGRESS_BEATS).toBe(2)
  })

  it('beats once a minute, so a one-second tick loop cannot climb the ladder in three seconds', () => {
    expect(BREAKER_BEAT_MS).toBe(60_000)
  })

  it('gives a constrained run thirty more calls and a run at most two steers', () => {
    expect(CONSTRAIN_GRACE_CALLS).toBe(30)
    expect(STEERS_PER_RUN_MAX).toBe(2)
  })

  it('cools this situation down in two minutes, not the Supervisor’s fifteen', () => {
    expect(BREAKER_COOLDOWN_MS).toBe(120_000)
    // The reason the override exists, asserted rather than described: fifteen minutes is far too
    // coarse for a loop that burns five dollars in three.
    expect(BREAKER_COOLDOWN_MS).toBeLessThan(COOLDOWN_MS)
  })
})

describe('the steer text', () => {
  it('has a sentence for every trip kind -- a kind with no words could never be steered', () => {
    for (const kind of BREAKER_TRIP_KINDS) {
      expect(typeof BREAKER_STEER_TEXT[kind], kind).toBe('function')
    }
  })

  it('interpolates the trip’s own integer and says the same three things every time', () => {
    const text = steerTextFor({ kind: 'repeated_call', count: 8, detail: 'Bash:abc' })
    expect(text).toContain('8 times')
    expect(text).toContain('one paragraph')
    expect(text).toContain('change approach')
  })

  it('never carries the trip’s detail -- a hash is not a sentence a worker can read', () => {
    expect(steerTextFor({ kind: 'repeated_call', count: 8, detail: 'Bash:deadbeef' })).not.toContain('deadbeef')
  })

  it('is the same sentence for the same trip, so a re-sent steer is byte-identical', () => {
    const trip = { kind: 'error_storm', count: 5, detail: 'api_error' } as const
    expect(steerTextFor(trip)).toBe(steerTextFor(trip))
  })
})
```

`packages/domain/test/breaker/detect.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  BREAKER_LEVELS,
  BREAKER_LEVEL_LABEL,
  BREAKER_TRIP_KINDS,
  BREAKER_TRIP_LABEL,
  type BreakerRow,
  type BreakerWindow,
  detectBehaviour,
} from '../../src/breaker/detect.js'
import { ERROR_STORM_COUNT, REPEAT_TRIP_COUNT } from '../../src/breaker/constants.js'

let seq = 0
const call = (key: string, toolUseId: string): BreakerRow => ({
  kind: 'call',
  seq: (seq += 1),
  toolUseId,
  key,
})
const result = (toolUseId: string, outcome: 'ok' | 'error'): BreakerRow => ({
  kind: 'result',
  seq: (seq += 1),
  toolUseId,
  outcome,
})
const output = (): BreakerRow => ({ kind: 'output', seq: (seq += 1) })

/** A run that has done nothing interesting: healthy level, no trips, every clock live. */
const WINDOW = (rows: readonly BreakerRow[], over: Partial<BreakerWindow> = {}): BreakerWindow => ({
  level: 'none',
  trips: 0,
  steers: 0,
  quietBeats: 0,
  rows,
  progress: { distinctKey: true, worktreeChanged: true, output: true },
  ...over,
})

/** N complete repeats of one key: call, result, call, result... */
const repeats = (n: number, key = 'Bash:aaaa'): readonly BreakerRow[] =>
  Array.from({ length: n }).flatMap((_, i) => [call(key, `t${String(i)}`), result(`t${String(i)}`, 'ok')])

describe('the breaker vocabulary', () => {
  it('is three levels, never four -- `stopped` is a run status, not a breaker level', () => {
    expect(BREAKER_LEVELS).toEqual(['none', 'steered', 'constrained'])
    expect(BREAKER_LEVELS).not.toContain('stopped')
  })

  it('gives every level and every trip a word', () => {
    for (const level of BREAKER_LEVELS) expect(BREAKER_LEVEL_LABEL[level], level).toMatch(/^[A-Z]/u)
    for (const kind of BREAKER_TRIP_KINDS) expect(BREAKER_TRIP_LABEL[kind], kind).toMatch(/^[A-Z]/u)
  })
})

describe('detectBehaviour: a healthy run', () => {
  it('is healthy with nothing in the window at all', () => {
    expect(detectBehaviour(WINDOW([]))).toEqual({ level: 'none', trip: null })
  })

  it('is healthy with seven repeats -- the trip is at eight', () => {
    expect(detectBehaviour(WINDOW(repeats(REPEAT_TRIP_COUNT - 1))).trip).toBeNull()
  })

  it('is healthy when a different key interrupted the run of repeats', () => {
    const rows = [...repeats(REPEAT_TRIP_COUNT), call('Read:bbbb', 'x'), result('x', 'ok'), ...repeats(3)]
    expect(detectBehaviour(WINDOW(rows)).trip).toBeNull()
  })
})

describe('detectBehaviour: repeated_call', () => {
  it('trips at the eighth consecutive identical key and names the key in `detail`', () => {
    const verdict = detectBehaviour(WINDOW(repeats(REPEAT_TRIP_COUNT)))
    expect(verdict.level).toBe('steered')
    expect(verdict.trip).toEqual({ kind: 'repeated_call', count: REPEAT_TRIP_COUNT, detail: 'Bash:aaaa' })
  })

  it('counts only the TRAILING run -- a run of eight ended by a distinct key is over', () => {
    const rows = [...repeats(REPEAT_TRIP_COUNT), call('Read:bbbb', 'z'), result('z', 'ok')]
    expect(detectBehaviour(WINDOW(rows)).trip).toBeNull()
  })
})

describe('detectBehaviour: error_storm', () => {
  it('trips at five consecutive errors whatever the tool was', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].flatMap((id, i) => [
      call(`Tool${String(i)}:x`, id),
      result(id, 'error'),
    ])
    const verdict = detectBehaviour(WINDOW(rows))
    expect(verdict.level).toBe('steered')
    expect(verdict.trip?.kind).toBe('error_storm')
    expect(verdict.trip?.count).toBe(ERROR_STORM_COUNT)
  })

  it('does not trip when one of the five succeeded', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].flatMap((id, i) => [
      call(`Tool${String(i)}:x`, id),
      result(id, id === 'c' ? 'ok' : 'error'),
    ])
    expect(detectBehaviour(WINDOW(rows)).trip).toBeNull()
  })
})

describe('detectBehaviour: no_progress', () => {
  const quiet = { distinctKey: false, worktreeChanged: false, output: false }

  it('needs two consecutive quiet beats -- one is a pause, not a loop', () => {
    expect(detectBehaviour(WINDOW([], { progress: quiet, quietBeats: 0 })).trip).toBeNull()
    const verdict = detectBehaviour(WINDOW([], { progress: quiet, quietBeats: 1 }))
    expect(verdict.trip?.kind).toBe('no_progress')
  })

  it('is suppressed by ANY of the three clocks -- progress is a disjunction, not a signal', () => {
    for (const live of ['distinctKey', 'worktreeChanged', 'output'] as const) {
      const progress = { ...quiet, [live]: true }
      expect(detectBehaviour(WINDOW([], { progress, quietBeats: 9 })).trip, live).toBeNull()
    }
  })
})

describe('detectBehaviour: a tool call with no result yet suppresses EVERY arm', () => {
  // The quiet-long-build case, and the reason the whole design persists tool RESULTS.
  const building: readonly BreakerRow[] = [...repeats(REPEAT_TRIP_COUNT), call('Bash:aaaa', 'pending')]

  it('does not trip repeated_call while the last call is still running', () => {
    expect(detectBehaviour(WINDOW(building)).trip).toBeNull()
  })

  it('does not trip error_storm while the last call is still running', () => {
    const rows = [
      ...['a', 'b', 'c', 'd', 'e'].flatMap((id) => [call('Bash:x', id), result(id, 'error')]),
      call('Bash:x', 'pending'),
    ]
    expect(detectBehaviour(WINDOW(rows)).trip).toBeNull()
  })

  it('does not trip no_progress while the last call is still running, however quiet it is', () => {
    expect(
      detectBehaviour(
        WINDOW(building, { progress: { distinctKey: false, worktreeChanged: false, output: false }, quietBeats: 9 }),
      ).trip,
    ).toBeNull()
  })

  it('trips again the moment that call reports', () => {
    expect(detectBehaviour(WINDOW([...building, result('pending', 'ok')])).trip?.kind).toBe('repeated_call')
  })
})

describe('detectBehaviour: the ladder', () => {
  const tripping = repeats(REPEAT_TRIP_COUNT)

  it('asks for one rung above the stored level, never two', () => {
    expect(detectBehaviour(WINDOW(tripping, { level: 'none' })).level).toBe('steered')
    expect(detectBehaviour(WINDOW(tripping, { level: 'steered' })).level).toBe('constrained')
    expect(detectBehaviour(WINDOW(tripping, { level: 'constrained' })).level).toBe('stop')
  })

  it('skips the steer rung once a run has had its two, and never proposes a third', () => {
    expect(detectBehaviour(WINDOW(tripping, { level: 'none', steers: 2 })).level).toBe('constrained')
  })

  it('steps DOWN exactly one rung on a healthy beat, and carries no trip with it', () => {
    expect(detectBehaviour(WINDOW([], { level: 'constrained' }))).toEqual({ level: 'steered', trip: null })
    expect(detectBehaviour(WINDOW([], { level: 'steered' }))).toEqual({ level: 'none', trip: null })
    expect(detectBehaviour(WINDOW([], { level: 'none' }))).toEqual({ level: 'none', trip: null })
  })

  it('prefers repeated_call over error_storm when both fire, so one beat names one trip', () => {
    const rows = [
      ...Array.from({ length: REPEAT_TRIP_COUNT }).flatMap((_, i) => [
        call('Bash:aaaa', `t${String(i)}`),
        result(`t${String(i)}`, 'error'),
      ]),
    ]
    expect(detectBehaviour(WINDOW(rows)).trip?.kind).toBe('repeated_call')
  })
})
```

- [ ] **Step 10: Run them and watch them fail**

Run: `npx vitest run packages/domain/test/breaker`
Expected: FAIL — `Failed to resolve import "../../src/breaker/constants.js"`.

- [ ] **Step 11: Write the constants**

`packages/domain/src/breaker/constants.ts`:

```ts
import type { BreakerTrip, BreakerTripKind } from './detect.js'

/**
 * The behavioural breaker's numbers (M51 R1/R2/R3).
 *
 * DOMAIN CONSTANTS, NOT WORKSPACE SETTINGS -- the rule `../supervisor/constants.ts` opens with, and
 * M38 section 8's deliberate scope line. A per-workspace threshold turns one rule into as many rules
 * as there are projects, and the first support question about it is unanswerable.
 *
 * Every one of them is pinned by `test/breaker/constants.test.ts`, which is what stands between a
 * number and a silent edit.
 */

/**
 * How many of the run's most recent `run.tool_call` / `run.tool_result` / `run.output` rows the
 * detector reads. Sixty is roughly a quarter of the default 200-call ceiling -- long enough to hold
 * an eight-deep repeat with its results and some output around it, short enough that the read is
 * one indexed page rather than the run's whole history.
 */
export const BREAKER_WINDOW = 60

/**
 * The same `toolName:argsHash` key this many times in a row, with no intervening distinct key.
 *
 * Eight, not three: a worker reading eight files in a loop is working, and the key includes the
 * ARGUMENTS, so eight identical keys means eight byte-identical calls. Borrowed as a finding from a
 * harness that ran this arm at the same default in production.
 */
export const REPEAT_TRIP_COUNT = 8

/** This many consecutive `outcome: 'error'` results, whatever the tools were. */
export const ERROR_STORM_COUNT = 5

/**
 * How many CONSECUTIVE beats every progress clock must read false before `no_progress` trips.
 *
 * Two, because one is a pause. A single quiet beat is what a compile, a test run or a slow network
 * call looks like from outside; two in a row, with a finished tool call at the end of the window,
 * is a worker that has stopped.
 */
export const NO_PROGRESS_BEATS = 2

/**
 * The minimum gap between two breaker evaluations OF ONE RUN.
 *
 * The daemon ticks about once a second. Without this, a tripping run would climb steer -> constrain
 * -> stop in three seconds, which is not a ladder -- it is a kill with two extra events. One minute
 * gives a steered worker a real chance to read the sentence and change course before the next rung.
 */
export const BREAKER_BEAT_MS = 60_000

/**
 * `run_looping`'s own cooldown, replacing `COOLDOWN_MS` for that kind alone (M51 R3).
 *
 * The Supervisor's standing cooldown is fifteen minutes, which is right for "nobody can review" and
 * far too coarse for a loop that burns five dollars in three minutes. Two minutes is twice the beat,
 * so a run that keeps tripping gets one steer offered per two rungs at most.
 */
export const BREAKER_COOLDOWN_MS = 120_000

/**
 * What a CONSTRAIN rung leaves the run: its current `toolCalls` plus this many.
 *
 * A relative grace, never an absolute cap, because the run has already spent an unknown amount of
 * its budget and an absolute number would either refund a long run or kill a short one instantly.
 * Thirty calls is enough to write a report and stop, and not enough to start again.
 */
export const CONSTRAIN_GRACE_CALLS = 30

/**
 * How many times one run may be STEERED, ever.
 *
 * De-escalation is what makes this cap necessary rather than decorative: a run that trips, is
 * steered, recovers for a beat and trips again is back at level `none` with a fresh rung available.
 * `SlaveRun.breakerSteers` does not reset on the way down, so the third trip skips the sentence it
 * has already been told twice and constrains instead.
 */
export const STEERS_PER_RUN_MAX = 2

/**
 * The steer sentence, per trip kind (M51 R3).
 *
 * **System-authored, never a model's words.** This is the whole reason `steer_run` can be an
 * `applied` action at all: `../supervisor/policy.ts`'s rule is that anything putting a MODEL's text
 * in front of a running worker is a proposal, and these sentences are constants in a source file
 * that no model has ever seen. The only thing interpolated is an integer the detector counted.
 *
 * All three say the same three things, in the same order, because the worker is being interrupted
 * and the instruction has to survive being skim-read: what we observed, stop, and then either change
 * approach or say why you cannot. The third clause is what keeps a steer from being a dead end --
 * a worker that genuinely cannot proceed should say so and conclude, which is a `failed` run a
 * person can read rather than a run that loops until the ceiling.
 */
export const BREAKER_STEER_TEXT: Record<BreakerTripKind, (count: number) => string> = {
  repeated_call: (count) =>
    `You have made the same tool call ${String(count)} times with no new result. Stop, say in one ` +
    'paragraph what you are stuck on, and either change approach or report why you cannot.',
  error_storm: (count) =>
    `Your last ${String(count)} tool calls all failed. Stop, say in one paragraph what is failing ` +
    'and why, and either change approach or report why you cannot.',
  no_progress: (count) =>
    `Nothing has changed in your worktree, your tool calls or your output for ${String(count)} ` +
    'checks. Stop, say in one paragraph what you are stuck on, and either change approach or ' +
    'report why you cannot.',
}

/**
 * The sentence for one trip.
 *
 * `trip.detail` is deliberately NOT interpolated: it is a `toolName:argsHash` or an error class --
 * an identifier, not a sentence, and `docs/ia.md` rule 3 applies to a worker's prompt as much as to
 * a page. The detail is on the `run.breaker` event for a person to read.
 */
export function steerTextFor(trip: BreakerTrip): string {
  return BREAKER_STEER_TEXT[trip.kind](trip.count)
}
```

- [ ] **Step 12: Write the detector**

`packages/domain/src/breaker/detect.ts`:

```ts
import { ERROR_STORM_COUNT, NO_PROGRESS_BEATS, REPEAT_TRIP_COUNT, STEERS_PER_RUN_MAX } from './constants.js'

/**
 * How loudly the breaker is currently speaking to one run (M51 R2).
 *
 * THREE members, and `stopped` is deliberately not one of them: a stopped run has a terminal
 * `RunStatus`, and a level that duplicated it would be a second place to ask whether a run is over.
 * The ladder's top rung is an ACT -- the sweep cancels the run and writes `guardrail.tripped` --
 * not a state the row sits in.
 */
export const BREAKER_LEVELS = ['none', 'steered', 'constrained'] as const

export type BreakerLevel = (typeof BREAKER_LEVELS)[number]

/** `docs/ia.md` rule 3. The run card's own word comes from `USER_CARD_LABEL`; this table is for
 *  anywhere a level is shown as itself (the drawer, the activity card's chip title). */
export const BREAKER_LEVEL_LABEL: Record<BreakerLevel, string> = {
  none: 'Healthy',
  steered: 'Steered',
  constrained: 'Constrained',
}

/** What the detector SAW. Three arms and no more -- each is a different kind of stuck. */
export const BREAKER_TRIP_KINDS = ['repeated_call', 'error_storm', 'no_progress'] as const

export type BreakerTripKind = (typeof BREAKER_TRIP_KINDS)[number]

export const BREAKER_TRIP_LABEL: Record<BreakerTripKind, string> = {
  repeated_call: 'Same call over and over',
  error_storm: 'Everything is failing',
  no_progress: 'Nothing is changing',
}

/**
 * One trip: which arm fired, the integer it fired on, and the one identifier a person would want.
 *
 * `count` exists because the steer sentence interpolates it and because the `run.breaker` event
 * should say eight rather than "several". `detail` is a `toolName:argsHash`, an error class, or a
 * beat count -- an identifier, never prose, and never the arguments themselves.
 */
export interface BreakerTrip {
  readonly kind: BreakerTripKind
  readonly count: number
  readonly detail: string
}

/**
 * One row of the run's persisted stream, flattened to what the detector reads.
 *
 * `key` is `toolName:argsHash` -- the ONLY thing the repeat arm compares, and the reason
 * `run.tool_call` gained two fields. The arguments are not here and are not anywhere: the event log
 * is not a transcript (`RunContext.prompt` remains the only place a prompt is stored).
 */
export type BreakerRow =
  | { readonly kind: 'call'; readonly seq: number; readonly toolUseId: string; readonly key: string }
  | {
      readonly kind: 'result'
      readonly seq: number
      readonly toolUseId: string
      readonly outcome: 'ok' | 'error'
    }
  | { readonly kind: 'output'; readonly seq: number }

/**
 * Everything {@link detectBehaviour} decides on -- and the whole of it.
 *
 * `rows` are the run's last `BREAKER_WINDOW` call/result/output rows, OLDEST FIRST (the order
 * `ExecutionEvent.seq` gives). `progress` is measured by the CALLER, because two of its three
 * clocks are not in the event log: `worktreeChanged` costs a subprocess and `distinctKey`/`output`
 * are windows over rows the caller already holds. Passing the triple in is what keeps this function
 * pure, clock-free and testable from three booleans.
 *
 * `quietBeats` is the caller's count of CONSECUTIVE beats whose progress triple was all-false,
 * NOT INCLUDING this one -- the debounce `no_progress` needs and a pure function cannot remember.
 */
export interface BreakerWindow {
  readonly level: BreakerLevel
  /** `SlaveRun.breakerTrips` -- every rung this run has ever climbed. Read for the event's own
   *  bookkeeping, never by a trip rule. */
  readonly trips: number
  /** `SlaveRun.breakerSteers`. Never reset by de-escalation, which is why the cap works. */
  readonly steers: number
  readonly quietBeats: number
  readonly rows: readonly BreakerRow[]
  readonly progress: {
    /** A tool call in this window whose key differs from the trailing one. */
    readonly distinctKey: boolean
    /** `git status --porcelain` + `rev-parse HEAD`, hashed, differs from the previous beat's.
     *  FALSE means "measured, and nothing moved"; the caller passes TRUE when it could not measure,
     *  because no evidence must never be evidence of a loop. */
    readonly worktreeChanged: boolean
    /** A `run.output` row arrived in this window. */
    readonly output: boolean
  }
}

/**
 * What the breaker wants to happen next.
 *
 * `level` is the level the run should be AT after this beat -- one rung up on an escalation, one
 * rung down on a healthy beat, or the pseudo-level `'stop'`, which is not a `BreakerLevel` because
 * it is not a state: it is the sweep's instruction to cancel the run.
 *
 * `trip` is non-null exactly when this verdict is an ESCALATION. A de-escalation and a steady
 * healthy beat both carry null, which is what lets the caller write "if the trip is null, write the
 * level and nothing else".
 */
export interface BreakerVerdict {
  readonly level: BreakerLevel | 'stop'
  readonly trip: BreakerTrip | null
}

const HEALTHY: BreakerVerdict = { level: 'none', trip: null }

/**
 * Is this run going in circles (M51 R1)? Pure, total, and with no clock of its own.
 *
 * ## The suppression that comes first
 *
 * A trailing `call` row whose `toolUseId` has no `result` row means a tool is STILL RUNNING, and
 * every arm is suppressed while it is. This is the quiet-long-build rule and it is the reason the
 * milestone persists tool results at all: a twenty-minute `npm run build` produces no new tool
 * calls, no output and no worktree change, and is indistinguishable from a wedged worker by every
 * signal EXCEPT the fact that its last call has not come back. Checked before anything else so no
 * arm can reach past it.
 *
 * ## The three arms, in the order they are consulted
 *
 * 1. **repeated_call** -- the TRAILING run of identical `toolName:argsHash` keys is at least
 *    {@link REPEAT_TRIP_COUNT} long. Trailing, not "anywhere in the window": eight repeats followed
 *    by a different call is a worker that already moved on.
 * 2. **error_storm** -- the trailing run of `outcome: 'error'` results is at least
 *    {@link ERROR_STORM_COUNT} long.
 * 3. **no_progress** -- all three clocks read false AND this makes {@link NO_PROGRESS_BEATS}
 *    consecutive quiet beats.
 *
 * One beat names ONE trip, in that order, because one rung gets one event and an event with two
 * reasons is an event a person has to choose between.
 *
 * ## The ladder
 *
 * A trip asks for ONE rung above the stored level -- never two, and the top rung is `'stop'`. A
 * run that has used its {@link STEERS_PER_RUN_MAX} steers skips the steer rung, because it has
 * already been told the sentence twice. No trip steps the stored level DOWN one rung and carries no
 * trip, so a run that recovers is not left constrained for the rest of its life.
 */
export function detectBehaviour(window: BreakerWindow): BreakerVerdict {
  if (hasRunningCall(window.rows)) return deEscalate(window.level)
  const trip = tripOf(window)
  if (trip === null) return deEscalate(window.level)
  return { level: escalate(window.level, window.steers), trip }
}

/** A `call` with no `result` carrying the same `toolUseId` anywhere after it. Scanned over the
 *  whole window rather than the last row alone: a worker may issue several calls in one turn, and
 *  any one of them still outstanding means a tool is running. */
function hasRunningCall(rows: readonly BreakerRow[]): boolean {
  const answered = new Set<string>()
  for (const row of rows) if (row.kind === 'result') answered.add(row.toolUseId)
  for (const row of rows) if (row.kind === 'call' && !answered.has(row.toolUseId)) return true
  return false
}

function tripOf(window: BreakerWindow): BreakerTrip | null {
  const calls = window.rows.filter((row): row is Extract<BreakerRow, { kind: 'call' }> => row.kind === 'call')
  const lastKey = calls.at(-1)?.key
  if (lastKey !== undefined) {
    let repeats = 0
    for (let i = calls.length - 1; i >= 0 && calls[i]?.key === lastKey; i -= 1) repeats += 1
    if (repeats >= REPEAT_TRIP_COUNT) return { kind: 'repeated_call', count: repeats, detail: lastKey }
  }

  const results = window.rows.filter((row): row is Extract<BreakerRow, { kind: 'result' }> => row.kind === 'result')
  let errors = 0
  for (let i = results.length - 1; i >= 0 && results[i]?.outcome === 'error'; i -= 1) errors += 1
  if (errors >= ERROR_STORM_COUNT) return { kind: 'error_storm', count: errors, detail: 'error' }

  const quiet = !window.progress.distinctKey && !window.progress.worktreeChanged && !window.progress.output
  // `+ 1` is THIS beat: `quietBeats` is what the caller counted BEFORE it, so two consecutive quiet
  // beats is one stored beat plus this one.
  if (quiet && window.quietBeats + 1 >= NO_PROGRESS_BEATS) {
    const beats = window.quietBeats + 1
    return { kind: 'no_progress', count: beats, detail: `${String(beats)} quiet beats` }
  }
  return null
}

function escalate(level: BreakerLevel, steers: number): BreakerLevel | 'stop' {
  if (level === 'constrained') return 'stop'
  if (level === 'steered') return 'constrained'
  // The skip: a run that has had its steers is not told the sentence a third time.
  return steers >= STEERS_PER_RUN_MAX ? 'constrained' : 'steered'
}

function deEscalate(level: BreakerLevel): BreakerVerdict {
  if (level === 'constrained') return { level: 'steered', trip: null }
  if (level === 'steered') return HEALTHY
  return HEALTHY
}
```

`packages/domain/src/breaker/index.ts`:

```ts
export * from './constants.js'
export * from './detect.js'
```

and `packages/domain/src/index.ts` gains `export * from './breaker/index.js'`.

- [ ] **Step 13: Run them and watch them pass**

Run: `npx vitest run packages/domain/test/breaker`
Expected: PASS — 9 constants cases and 21 detector cases, 30 in two files.

- [ ] **Step 14: Write the failing test for the two new card words**

Appended to `packages/domain/test/status/user.test.ts`:

```ts
import { USER_CARD_LABEL, userRunStatus, type UserCardFacts } from '../../src/status/user.js'

describe('userRunStatus with breaker facts (M51 R7)', () => {
  it('reads exactly as it always did when called with one argument', () => {
    // The ~20 existing call sites, unchanged: `apps/web/src/lib/tones.ts`'s `cardStateForRun` is
    // the adapter they all go through and it passes no facts.
    expect(userRunStatus('working')).toEqual({ state: 'working', label: 'WORKING', needsYou: false })
    expect(userRunStatus(null).state).toBe('idle')
  })

  it('says STEERED and CONSTRAINED for a working run the breaker has spoken to', () => {
    expect(userRunStatus('working', { breakerLevel: 'steered' })).toEqual({
      state: 'steered',
      label: 'STEERED',
      needsYou: false,
    })
    expect(userRunStatus('working', { breakerLevel: 'constrained' }).label).toBe('CONSTRAINED')
  })

  it('says nothing new at level `none`, or with an empty facts object', () => {
    expect(userRunStatus('working', { breakerLevel: 'none' }).state).toBe('working')
    expect(userRunStatus('working', {}).state).toBe('working')
  })

  it('never lets a breaker level speak over a status a person acted on', () => {
    // A paused run reads PAUSED even at level `constrained`: somebody (or the breaker itself) has
    // stopped it, and "constrained" would describe a budget nobody is spending.
    const facts: UserCardFacts = { breakerLevel: 'constrained' }
    expect(userRunStatus('paused', facts).state).toBe('paused')
    expect(userRunStatus('pause_requested', facts).state).toBe('pause_requested')
    expect(userRunStatus('failed', facts).state).toBe('blocked')
    expect(userRunStatus('succeeded', facts).state).toBe('completed')
    expect(userRunStatus(null, facts).state).toBe('idle')
  })

  it('gives both new states a word', () => {
    expect(USER_CARD_LABEL.steered).toBe('STEERED')
    expect(USER_CARD_LABEL.constrained).toBe('CONSTRAINED')
  })
})
```

- [ ] **Step 15: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/status/user.test.ts`
Expected: FAIL — `Property 'steered' does not exist on type 'Record<UserCardState, string>'` at the `USER_CARD_LABEL.steered` line, and `Expected 1 arguments, but got 2` on every two-argument `userRunStatus`.

- [ ] **Step 16: Widen the card vocabulary**

`packages/domain/src/status/user.ts`:

```ts
import type { BreakerLevel } from '../breaker/detect.js'
```

```ts
export type UserCardState =
  | 'working'
  | 'planning'
  | 'waiting'
  | 'review'
  | 'paused'
  | 'pause_requested'
  | 'resuming'
  | 'blocked'
  | 'cancelled'
  | 'idle'
  | 'completed'
  // M51 R7: a run the behavioural breaker has spoken to. Not a `RunStatus` -- the run is still
  // WORKING, and that is the point of the word: something is being done about it and nobody has to
  // press anything.
  | 'steered'
  | 'constrained'

export const USER_CARD_LABEL: Record<UserCardState, string> = {
  // ... the eleven existing entries, unchanged ...
  steered: 'STEERED',
  constrained: 'CONSTRAINED',
}

/**
 * Everything the run projection needs that a `RunStatus` alone cannot say (M51 R7).
 *
 * The `UserTaskFacts` shape, for its reason: a status is a projection over a column, and the
 * breaker's level is a second column. OPTIONAL as a whole and optional in every field, so the ~20
 * one-argument call sites that reach this through `apps/web/src/lib/tones.ts`'s `cardStateForRun`
 * keep reading exactly as they always did, and every default is the one that says nothing new.
 */
export interface UserCardFacts {
  readonly breakerLevel?: BreakerLevel
}

export function userRunStatus(status: RunStatus | null, facts: UserCardFacts = {}): UserStatus<UserCardState> {
  const state = runCardState(status, facts)
  return { state, label: USER_CARD_LABEL[state], needsYou: false }
}

function runCardState(status: RunStatus | null, facts: UserCardFacts): UserCardState {
  if (status === null) return 'idle'
  // The breaker's word speaks ONLY over `working`. A paused, pausing, resuming, stopping or
  // terminal run has a status somebody (or something) acted to produce, and overwriting it with
  // `CONSTRAINED` would describe a tool budget nobody is spending.
  if (status === 'working' && facts.breakerLevel !== undefined && facts.breakerLevel !== 'none') {
    return facts.breakerLevel
  }
  switch (status) {
    // ... the nine existing arms, unchanged ...
  }
}
```

`apps/web/src/lib/tones.ts` — `TONE_AND_PULSE` is `Record<CardState, …>` and is a BUILD ERROR without the two entries, which is why this web file is in Task 1 (the M49/M50 precedent for a web file exhaustive over a domain union):

```ts
  // M51 R7: the breaker is speaking to this run and it is still working. `waiting` amber rather
  // than `blocked` red -- nothing needs a person, the system is handling it -- and it PULSES,
  // because the run is live. `constrained` is the louder of the two and shares the tone, the way
  // `pause_requested` and `waiting` already do: the WORD is the difference, not the colour.
  steered: { tone: 'waiting', pulse: true },
  constrained: { tone: 'waiting', pulse: true },
```

`cardStateForRun` gains the optional pass-through, so a caller that has the level can use it:

```ts
export function cardStateForRun(status: RunStatus | null, facts?: UserCardFacts): CardState {
  return userRunStatus(status, facts).state
}
```

- [ ] **Step 17: Run the whole domain suite and watch it pass**

```bash
npx vitest run packages/domain
```
Expected: every domain test green, including `status/user.test.ts`'s existing table cases (nothing a one-argument caller sees has moved) and `supervisor/labels.test.ts`.

- [ ] **Step 18: Run the whole ladder for this task**

```bash
npx vitest run packages/domain
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: domain green; the vocabulary gate prints its PASSED line; `typecheck` is silent — which is what proves `TONE_AND_PULSE`, `USER_CARD_LABEL` and `GuardrailBreach.guardrail`'s narrowing were all closed. **Do NOT run `npm run web:build` in this task**: the only `apps/web` edit is `tones.ts`, which `typecheck` covers, and the M50 ladder may still own the machine.

- [ ] **Step 19: Commit**

```bash
git add packages/domain apps/web/src/lib/tones.ts
git commit -m "$(cat <<'EOF'
feat(domain): m51 t1 — the breaker is a pure function, and money is three questions

`GUARDRAIL_KINDS` closes the sixteen spellings that lived as literals in nine production files and
gives every one of them a word, so `GuardrailBreach.guardrail` is a union the compiler checks while
the stored payload stays the forgiving string a forward read needs. `detectBehaviour` is the whole
of the ladder's judgement in one total function: a trailing tool call with no result suppresses
every arm, three arms are consulted in a fixed order so one beat names one trip, a trip asks for one
rung and never two, and a healthy beat steps back down. The steer sentence is a constant in a source
file no model has seen, which is the only reason the action that sends it can be routine. And the
price table is fallback-only by construction -- `costProvenanceOf` checks the reported figure first,
every time, in the one place the question is asked.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

---

### Task 2: The 54th and 55th events, the sixteenth situation and action, the world's runs, and the migration (R1, R2, R3, R4, E5, E9, E12, E17, D7–D10)

**Files:**
- Create: `packages/db/prisma/migrations/20260912150000_m51_breaker/migration.sql`
- Modify: `packages/domain/src/events/schema.ts`, `packages/domain/src/supervisor/{situations,constants,observe,actions,candidates,policy,world,timeline}.ts`, `packages/db/prisma/schema.prisma`, `packages/db/src/enums.ts`, `apps/web/src/lib/activityFilters.ts`, `apps/web/src/components/activity/cards.tsx`, `apps/web/src/server/timeline.ts`, `apps/web/src/components/SupervisorPanel.tsx`
- Test: `packages/domain/test/events/schema.test.ts`, `packages/domain/test/supervisor/{fixtures.ts,observe,candidates,policy,labels,timeline}.test.ts`, `packages/db/test/integration/enum-parity.test.ts`, `apps/web/test/activity-cards.test.tsx`, `apps/web/test/activityFilters.test.ts`

**Interfaces:**
- Consumes from Task 1: `BreakerLevel`, `BREAKER_LEVELS`, `BreakerTripKind`, `BREAKER_TRIP_KINDS`, `BREAKER_COOLDOWN_MS`, `STEERS_PER_RUN_MAX`.
- Produces, for Tasks 3–6:
  - Event `run.tool_call` payload `{ name, summary, toolUseId?, argsHash? }` (both new fields optional ON READ, required on write)
  - Event `run.tool_result` payload `{ toolUseId, toolName, outcome: 'ok' | 'error', errorClass: string | null }` (`.strict()`)
  - Event `run.breaker` payload `{ level: 'steered' | 'constrained', trip, count, detail }` (`.strict()`)
  - `SITUATION_KINDS` gains `'run_looping'` (16 members); `SITUATION_LABEL.run_looping = 'Going in circles'`
  - `ACTION_KINDS` gains `'steer_run'` (16 members); `Action` arm `{ kind: 'steer_run'; runId: string; slaveId: string; text: string }`; `tierOf(steer_run) = 'applied'`
  - `COOLDOWN_BY_KIND: Partial<Record<SituationKind, number>>` and `filterFresh`'s per-kind lookup
  - `SupervisorRun { id, taskId, slaveId, status, toolCalls, toolCallCap, breakerLevel, breakerTrips, breakerSteers, trip, detail, count }` and `SupervisorWorld.runs`
  - Prisma: `enum BreakerLevel`; `SlaveRun.breakerLevel/breakerTrips/breakerSteers/breakerBeatAt/breakerQuietBeats/toolCallCap/model`; two `EventType` members; one `SupervisorSituationKind` member

- [ ] **Step 1: Write the failing tests for the two events and the widened tool call**

Appended to `packages/domain/test/events/schema.test.ts`:

```ts
describe('run.tool_call after M51 R1', () => {
  const base = {
    type: 'run.tool_call' as const,
    workspaceId: 'w1',
    taskId: 't1',
    slaveId: 's1',
    runId: 'r1',
    actor: 'slave' as const,
    ts: new Date().toISOString(),
    seq: 1,
  }

  it('accepts the two new fields', () => {
    const parsed = parseExecutionEvent({
      ...base,
      payload: { name: 'Bash', summary: 'Bash npm test', toolUseId: 'toolu_1', argsHash: 'a'.repeat(64) },
    })
    expect(parsed.ok).toBe(true)
  })

  it('still accepts a pre-M51 row that has neither -- the run.tool_denied.toolUseId precedent', () => {
    // `packages/events/src/read.ts` THROWS on a row the domain cannot parse, so a required field
    // here would make every tool call written before this milestone unreadable and take the whole
    // activity stream down with it.
    expect(parseExecutionEvent({ ...base, payload: { name: 'Bash', summary: 'Bash npm test' } }).ok).toBe(true)
  })

  it('refuses an argsHash that is not a sha256 hex digest', () => {
    expect(
      parseExecutionEvent({ ...base, payload: { name: 'Bash', summary: 's', toolUseId: 'x', argsHash: 'nope' } }).ok,
    ).toBe(false)
  })
})

describe('run.tool_result (the 54th type)', () => {
  const base = {
    type: 'run.tool_result' as const,
    workspaceId: 'w1',
    taskId: 't1',
    slaveId: 's1',
    runId: 'r1',
    actor: 'slave' as const,
    ts: new Date().toISOString(),
    seq: 1,
  }

  it('carries the four bounded fields and nothing else', () => {
    expect(
      parseExecutionEvent({
        ...base,
        payload: { toolUseId: 'toolu_1', toolName: 'Bash', outcome: 'error', errorClass: 'timeout' },
      }).ok,
    ).toBe(true)
  })

  it('carries a null errorClass for a call that worked', () => {
    expect(
      parseExecutionEvent({
        ...base,
        payload: { toolUseId: 'toolu_1', toolName: 'Bash', outcome: 'ok', errorClass: null },
      }).ok,
    ).toBe(true)
  })

  it('is strict -- the result TEXT must never find a way in', () => {
    expect(
      parseExecutionEvent({
        ...base,
        payload: { toolUseId: 't', toolName: 'Bash', outcome: 'ok', errorClass: null, content: 'the whole file' },
      }).ok,
    ).toBe(false)
  })

  it('caps errorClass at forty characters and refuses an unknown outcome', () => {
    const payload = { toolUseId: 't', toolName: 'Bash', outcome: 'error' as const, errorClass: 'x'.repeat(41) }
    expect(parseExecutionEvent({ ...base, payload }).ok).toBe(false)
    expect(parseExecutionEvent({ ...base, payload: { ...payload, outcome: 'maybe', errorClass: null } }).ok).toBe(false)
  })

  it('takes a class this version has never heard of -- the union types WRITERS, not the log', () => {
    expect(
      parseExecutionEvent({
        ...base,
        payload: { toolUseId: 't', toolName: 'Bash', outcome: 'error', errorClass: 'quota_exhausted' },
      }).ok,
    ).toBe(true)
  })
})

describe('run.breaker (the 55th type)', () => {
  const base = {
    type: 'run.breaker' as const,
    workspaceId: 'w1',
    taskId: 't1',
    slaveId: 's1',
    runId: 'r1',
    actor: 'system' as const,
    ts: new Date().toISOString(),
    seq: 1,
  }

  it('announces an escalation with its rung, its trip and the integer it fired on', () => {
    expect(
      parseExecutionEvent({
        ...base,
        payload: { level: 'steered', trip: 'repeated_call', count: 8, detail: 'Bash:aaaa' },
      }).ok,
    ).toBe(true)
  })

  it('never announces the top rung -- a STOP is a guardrail.tripped and nothing else', () => {
    expect(
      parseExecutionEvent({ ...base, payload: { level: 'stop', trip: 'repeated_call', count: 8, detail: 'x' } }).ok,
    ).toBe(false)
  })

  it('never announces a de-escalation -- stepping back down is silent', () => {
    expect(
      parseExecutionEvent({ ...base, payload: { level: 'none', trip: 'repeated_call', count: 8, detail: 'x' } }).ok,
    ).toBe(false)
  })

  it('refuses a trip kind the detector cannot produce', () => {
    expect(
      parseExecutionEvent({ ...base, payload: { level: 'steered', trip: 'vibes', count: 8, detail: 'x' } }).ok,
    ).toBe(false)
  })
})
```

and, in `packages/domain/test/supervisor/timeline.test.ts`:

```ts
  it('carries the 55 members the schema has today -- a fifty-sixth is a deliberate decision', () => {
    expect(Object.keys(LANE_BY_TYPE)).toHaveLength(55)
  })

  it('puts a breaker rung on the WORK lane and a tool result on none', () => {
    expect(LANE_BY_TYPE['run.breaker']).toBe('work')
    // Beside `run.tool_call`, for its reason: the per-call stream is the activity feed's business,
    // not the Supervisor's timeline, which would otherwise be one line per tool call.
    expect(LANE_BY_TYPE['run.tool_result']).toBeNull()
  })
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/domain/test/events/schema.test.ts packages/domain/test/supervisor/timeline.test.ts`
Expected: FAIL — the `run.tool_result` and `run.breaker` cases fail with `ok: false` (the discriminated union has no arm for those types), and the lane count asserts 53 received / 55 expected.

- [ ] **Step 3: Add the two events and widen the tool call**

`packages/domain/src/events/schema.ts` — the `run.tool_call` arm (`:55-59`) becomes:

```ts
  z.object({
    ...envelope,
    type: z.literal('run.tool_call'),
    payload: z.object({
      name: z.string(),
      summary: z.string(),
      // M51 R1: the two fields the behavioural detector reads, and the whole of what it reads.
      //
      // OPTIONAL ON READ, REQUIRED ON WRITE -- the `run.tool_denied.toolUseId` precedent four lines
      // below, for its exact reason: `packages/events/src/read.ts:23-26` throws on a row this schema
      // cannot parse, and every `run.tool_call` written before this milestone has neither field.
      // `apps/orchestrator/src/pump.ts` always sets both as of M51.
      //
      // `argsHash` is `sha256(canonical(input))` -- `packages/providers/src/hash.ts`. **The
      // arguments themselves are never persisted**: the event log is not a transcript, and
      // `RunContext.prompt` remains the only place a prompt is stored. `summary` stays because it
      // is what a person reads; it is not what the detector compares, because two `Bash` calls with
      // different commands summarise identically (the collision that constrained a working agent in
      // the harness this finding comes from).
      toolUseId: z.string().min(1).optional(),
      argsHash: z
        .string()
        .regex(/^[0-9a-f]{64}$/u)
        .optional(),
    }),
  }),
```

and, at the foot of the union beside `slave.released`:

```ts
  // M51 R1: what came BACK from one tool call -- `ok` or `error`, a normalised class, and nothing
  // else. Bounded by construction: no result text, no stdout, no stack trace, no arguments. This is
  // the row that makes "a tool call with no result yet is never a trip" decidable from the log, and
  // it is the row that makes an api-error storm visible at all.
  //
  // `errorClass` is a STRING, not an enum, for `guardrail.tripped`'s own reason (M51 R4): the closed
  // list lives in `packages/providers/src/tool-result.ts` where a mistake is a build error, and the
  // log stays able to read a class a later version invents. `.strict()` because the payload is
  // newborn and nothing has ever written another key into it -- and because the ONE thing that must
  // never reach this row is the result body, which a permissive object would happily carry.
  z.object({
    ...envelope,
    type: z.literal('run.tool_result'),
    payload: z
      .object({
        toolUseId: z.string().min(1),
        toolName: z.string().min(1),
        outcome: z.enum(['ok', 'error']),
        errorClass: z.string().min(1).max(40).nullable(),
      })
      .strict(),
  }),
  // M51 R2: the breaker climbed a rung. ONE event per escalation and no event for anything else --
  // a de-escalation is silent, and the top rung announces itself as `guardrail.tripped
  // { guardrail: 'behavioural_loop' }` alone, because one rung gets one name.
  //
  // `level` is therefore `steered | constrained` and never `none` or `stop`: those are not rungs
  // this event can describe.
  z.object({
    ...envelope,
    type: z.literal('run.breaker'),
    payload: z
      .object({
        level: z.enum(['steered', 'constrained']),
        trip: z.enum(BREAKER_TRIP_KINDS),
        count: z.number().int().positive(),
        detail: z.string().min(1).max(200),
      })
      .strict(),
  }),
```

with `import { BREAKER_TRIP_KINDS } from '../breaker/detect.js'` at the top (the events schema already imports `MEMORY_STATUSES` from a sibling domain module the same way).

`packages/domain/src/supervisor/timeline.ts` — two entries in `LANE_BY_TYPE`:

```ts
  // M51 R1: beside `run.tool_call` above, for its reason -- the per-call stream belongs to the
  // activity feed, and one timeline line per tool result would be the Supervisor's report drowned
  // in its own workers' typing.
  'run.tool_result': null,
  // M51 R2: a rung the system climbed about one run's behaviour. The WORK lane, beside
  // `run.paused`/`run.resumed`: it is a thing that happened TO a run, and it is exactly what a
  // person reading "what happened here" needs between a run starting and a run failing.
  'run.breaker': 'work',
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run packages/domain/test/events packages/domain/test/supervisor/timeline.test.ts`
Expected: PASS — 12 new schema cases and the lane count at 55. `npx tsc --build` will still be RED until Step 8 closes `EVENT_TYPE_BY_DOMAIN_TYPE` and the web's exhaustive sites; that is expected and is why they are in this task.

- [ ] **Step 5: Write the failing tests for the sixteenth situation, the sixteenth action and the tier**

`packages/domain/test/supervisor/fixtures.ts` — the world factory gains `runs: []` so every existing supervisor test compiles unchanged (the M49/M50 fixture rule), and a `run()` helper is added beside the existing `slave()`/`task()` ones:

```ts
export function supervisorRun(over: Partial<SupervisorRun> = {}): SupervisorRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    slaveId: 'slave-1',
    status: 'working',
    toolCalls: 12,
    toolCallCap: null,
    breakerLevel: 'none',
    breakerTrips: 0,
    breakerSteers: 0,
    trip: null,
    detail: null,
    count: null,
    ...over,
  }
}
```

Appended to `packages/domain/test/supervisor/observe.test.ts`:

```ts
describe('run_looping (M51 R3)', () => {
  const looping = supervisorRun({
    breakerLevel: 'steered',
    breakerTrips: 1,
    trip: 'repeated_call',
    detail: 'Bash:aaaa',
    count: 8,
  })

  it('raises one situation per LOOPING RUN, subject = the run id', () => {
    const situations = observe(world({ runs: [looping] }))
    const found = situations.filter((s) => s.kind === 'run_looping')
    expect(found).toHaveLength(1)
    expect(found[0]?.subjectId).toBe('run-1')
  })

  it('carries the trip, the identifier and the integers as flat facts', () => {
    const [found] = observe(world({ runs: [looping] })).filter((s) => s.kind === 'run_looping')
    expect(found?.facts).toEqual({
      runId: 'run-1',
      slaveId: 'slave-1',
      taskId: 'task-1',
      trip: 'repeated_call',
      detail: 'Bash:aaaa',
      count: 8,
      level: 'steered',
      steers: 0,
    })
  })

  it('never raises for a healthy run, however busy it is', () => {
    expect(observe(world({ runs: [supervisorRun({ toolCalls: 199 })] })).some((s) => s.kind === 'run_looping')).toBe(
      false,
    )
  })

  it('never raises for a CONSTRAINED run -- that rung is the system’s, not the Supervisor’s', () => {
    const runs = [supervisorRun({ breakerLevel: 'constrained', trip: 'repeated_call', detail: 'x', count: 8 })]
    expect(observe(world({ runs })).some((s) => s.kind === 'run_looping')).toBe(false)
  })

  it('never raises for a run whose level says steered but whose trip the log has lost', () => {
    const runs = [supervisorRun({ breakerLevel: 'steered', trip: null })]
    expect(observe(world({ runs })).some((s) => s.kind === 'run_looping')).toBe(false)
  })

  it('never raises for a run that has already used its steers', () => {
    expect(observe(world({ runs: [{ ...looping, breakerSteers: 2 }] })).some((s) => s.kind === 'run_looping')).toBe(
      false,
    )
  })

  it('never raises for a run that is no longer working', () => {
    for (const status of ['paused', 'pause_requested', 'stopping', 'failed'] as const) {
      expect(observe(world({ runs: [{ ...looping, status }] })).some((s) => s.kind === 'run_looping'), status).toBe(
        false,
      )
    }
  })
})

describe('filterFresh with a per-kind cooldown (M51 R3)', () => {
  const decisionAt = (kind: SituationKind, subjectId: string, agoMs: number): SupervisorDecisionRecord => ({
    situationKind: kind,
    subjectId,
    status: 'applied',
    createdAt: NOW - agoMs,
    resolvedAt: NOW - agoMs,
  })

  it('lets a looping run be raised again after two minutes, not fifteen', () => {
    const situations = [{ kind: 'run_looping' as const, subjectId: 'run-1', summary: 's', facts: {} }]
    const recent = world({ decisions: [decisionAt('run_looping', 'run-1', 3 * 60_000)] })
    expect(filterFresh(situations, recent)).toHaveLength(1)
    const fresher = world({ decisions: [decisionAt('run_looping', 'run-1', 60_000)] })
    expect(filterFresh(situations, fresher)).toHaveLength(0)
  })

  it('leaves every other kind on the standing fifteen minutes', () => {
    const situations = [{ kind: 'waiting_stale' as const, subjectId: 'task-1', summary: 's', facts: {} }]
    const w = world({ decisions: [decisionAt('waiting_stale', 'task-1', 3 * 60_000)] })
    expect(filterFresh(situations, w)).toHaveLength(0)
  })

  it('still blocks a PENDING decision whatever the cooldown says', () => {
    const situations = [{ kind: 'run_looping' as const, subjectId: 'run-1', summary: 's', facts: {} }]
    const w = world({ decisions: [{ ...decisionAt('run_looping', 'run-1', 99 * 60_000), status: 'pending' }] })
    expect(filterFresh(situations, w)).toHaveLength(0)
  })
})
```

Appended to `packages/domain/test/supervisor/candidates.test.ts`:

```ts
describe('the run_looping offer (M51 R3)', () => {
  const looping = supervisorRun({ breakerLevel: 'steered', trip: 'repeated_call', detail: 'Bash:aaaa', count: 8 })
  const w = world({ runs: [looping] })
  const situation = observe(w).find((s) => s.kind === 'run_looping')

  it('offers exactly one thing: steer this run, with the SYSTEM’s own sentence', () => {
    const offers = candidatesFor(situation!, w)
    expect(offers).toHaveLength(1)
    expect(offers[0]?.action).toEqual({
      kind: 'steer_run',
      runId: 'run-1',
      slaveId: 'slave-1',
      text: steerTextFor({ kind: 'repeated_call', count: 8, detail: 'Bash:aaaa' }),
    })
  })

  it('is ROUTINE -- the text is a constant, so nobody is being asked to approve a model’s words', () => {
    expect(candidatesFor(situation!, w)[0]?.tier).toBe('applied')
  })

  it('is PROPOSED under a halt, like everything else', () => {
    const halted = world({ runs: [looping], halted: { reason: 'budget_exhausted' } })
    const s = observe(halted).find((one) => one.kind === 'run_looping')
    expect(candidatesFor(s!, halted)[0]?.tier).toBe('proposed')
  })

  it('never carries the trip’s detail into the worker’s prompt', () => {
    expect(candidatesFor(situation!, w)[0]?.action).not.toMatchObject({ text: expect.stringContaining('Bash:aaaa') })
  })
})
```

and, in `packages/domain/test/supervisor/labels.test.ts`, one case asserting `SITUATION_LABEL.run_looping` and one asserting `ACTION_KINDS` has 16 members with `steer_run` among them.

- [ ] **Step 6: Run them and watch them fail**

Run: `npx vitest run packages/domain/test/supervisor`
Expected: FAIL — `world({ runs })` is a type error (`Object literal may only specify known properties`), `supervisorRun` is not exported from `fixtures.ts`, and `SITUATION_LABEL.run_looping` is undefined.

- [ ] **Step 7: Declare the situation, the action, the tier, the cooldown, the world's runs and the predicate**

`packages/domain/src/supervisor/situations.ts` — the sixteenth kind, placed directly after `capability_unstaffed` and before `ready_unstaffed`:

```ts
  /**
   * M51 R3: a RUN the behavioural breaker has steered, whose trip the Supervisor is being asked to
   * put words in front of. `subjectId` is the RUN id -- the first kind whose subject is a run, the
   * way `engagement_over` was the first whose subject is a worker.
   *
   * It sits among the "what is stuck" group rather than the housekeeping one at the foot, and
   * directly after `capability_unstaffed`, because it is the most URGENT thing on this list: every
   * other situation is something that has stopped, and this one is something that is still
   * spending money while it goes nowhere.
   *
   * Raised only for a run at level `steered` -- the rung the sweep already climbed. CONSTRAIN and
   * STOP are the system's own rungs and the Supervisor is never asked about them: three actors,
   * three packages, and this is the Supervisor's one.
   */
  'run_looping',
```

with `SITUATION_LABEL.run_looping = 'Going in circles'` (the same words `GUARDRAIL_LABEL.behavioural_loop` uses — one phenomenon, one phrase, wherever a person meets it) and the `Situation.subjectId` docstring gaining "the RUN id for `run_looping`".

`packages/domain/src/supervisor/actions.ts` — the sixteenth action, its `ACTION_KINDS` entry directly after `release_worker`, and its schema arm:

```ts
  /**
   * M51 R3: put ONE fixed, system-authored sentence in front of a running worker that is going in
   * circles, through the pause -> `queuedMessage` -> resume round trip that already exists.
   *
   * `text` is on the ACTION, not re-derived at apply time, for the reason every other action's
   * fields are: a decision a human reads months later has to say what was actually sent. It is
   * filled by `candidates.ts` from `steerTextFor(trip)` -- a constant interpolated with one integer
   * -- and `carryOut` sends exactly it. **No model ever produces this string**, which is the whole
   * of why `tierOf` may stamp it `applied`.
   */
  | { readonly kind: 'steer_run'; readonly runId: string; readonly slaveId: string; readonly text: string }
```

```ts
  z.object({
    kind: z.literal('steer_run'),
    runId: z.string().min(1),
    slaveId: z.string().min(1),
    // Capped where the action is VALIDATED as well as where it is built: a stored row is read back
    // by `applyDecision` and sent verbatim, so the bound belongs on the boundary too.
    text: z.string().min(1).max(1000),
  }),
```

`packages/domain/src/supervisor/policy.ts` — one arm, and the docstring sentence it contradicts made precise:

```ts
    // ROUTINE (M51 R3), and it is the ONE exception to the sentence above about a model's words --
    // which is why that sentence now says "a MODEL's words". `steer_run.text` is
    // `steerTextFor(trip)`: a constant in `../breaker/constants.ts` with one integer interpolated
    // into it, from a source file no model has seen and no prompt can reach. Nobody is being asked
    // to approve a draft, because there is no draft; the only judgement in the whole path is
    // `detectBehaviour`'s, which is a pure function over rows a person can read.
    //
    // What a human WOULD be approving, if this were `proposed`, is the ladder stalling: the steer
    // rung is the gentlest one, and a proposal that waits for somebody to click is a loop that
    // keeps spending until it hits the constrain rung anyway. `halted` still demotes it above,
    // exactly like everything else.
    case 'steer_run':
      return 'applied'
```

and line 37's list gains `steers a running worker with the system's own sentence` nowhere — instead the existing clause "puts a model's words in front of a worker" is left EXACTLY as written, because it is still true and it is now the sentence this arm's comment points at.

`packages/domain/src/supervisor/constants.ts` — the per-kind override table, beside `COOLDOWN_MS`:

```ts
/**
 * Situations whose cooldown is NOT {@link COOLDOWN_MS} (M51 R3).
 *
 * Fifteen minutes is the right silence for "nobody can review this project" and the wrong silence
 * for a run burning five dollars in three minutes. A table rather than a branch inside
 * `filterFresh`, so the exception is data a reader can enumerate and a seventeenth kind inherits the
 * default by saying nothing.
 */
export const COOLDOWN_BY_KIND: Partial<Record<SituationKind, number>> = {
  run_looping: BREAKER_COOLDOWN_MS,
}
```

`packages/domain/src/supervisor/observe.ts` — `filterFresh` reads the table:

```ts
export function filterFresh(situations: readonly Situation[], world: SupervisorWorld): readonly Situation[] {
  const key = (kind: SituationKind, subjectId: string): string => `${kind} ${subjectId}`
  const blocked = new Set<string>()
  for (const decision of world.decisions) {
    const anchor = decision.resolvedAt ?? decision.createdAt
    // M51 R3: the per-kind override, defaulting to the standing fifteen minutes. The `pending`
    // clause is unchanged and is checked first: an OPEN decision blocks its key however long it has
    // been open, whatever the cooldown says, because a second proposal about a question a human is
    // still looking at is the thing the cooldown exists to stop.
    const cooldownMs = COOLDOWN_BY_KIND[decision.situationKind] ?? COOLDOWN_MS
    const cooling = decision.status === 'pending' || world.now - anchor <= cooldownMs
    if (cooling) blocked.add(key(decision.situationKind, decision.subjectId))
  }
  return situations.filter((situation) => !blocked.has(key(situation.kind, situation.subjectId)))
}
```

and the predicate, placed in `observe` directly after the `capability_unstaffed` block:

```ts
  // run_looping (M51 R3): a run the sweep has already STEERED, whose sentence somebody has to
  // actually deliver. Five clauses, and each one is a way of being wrong about it:
  //   - level is exactly `steered`. `none` is healthy; `constrained` is a rung the system owns and
  //     the Supervisor is not consulted about.
  //   - the run is still `working`. A paused, stopping or terminal run cannot be steered, and the
  //     control verb would refuse it -- which would be a `failed` decision row for a race nobody
  //     can act on.
  //   - the trip is known. `trip`/`detail`/`count` come off the newest `run.breaker` row; a run
  //     whose event the log has lost has no sentence to send, and inventing one would be the
  //     Supervisor guessing.
  //   - the run has steers left. `STEERS_PER_RUN_MAX` is enforced HERE as well as in the detector,
  //     because a de-escalated run comes back round and the situation is what a person reads.
  for (const run of world.runs) {
    if (run.breakerLevel !== 'steered') continue
    if (run.status !== 'working') continue
    if (run.trip === null || run.detail === null || run.count === null) continue
    if (run.breakerSteers >= STEERS_PER_RUN_MAX) continue
    add({
      kind: 'run_looping',
      subjectId: run.id,
      summary:
        `This run has been going in circles (${BREAKER_TRIP_LABEL[run.trip].toLowerCase()}, ` +
        `${String(run.count)}x) and has not been told so yet.`,
      facts: {
        runId: run.id,
        slaveId: run.slaveId,
        taskId: run.taskId,
        trip: run.trip,
        detail: run.detail,
        count: run.count,
        level: run.breakerLevel,
        steers: run.breakerSteers,
      },
    })
  }
```

`packages/domain/src/supervisor/candidates.ts` — the one offer:

```ts
    case 'run_looping': {
      const run = world.runs.find((one) => one.id === situation.subjectId)
      // The world moved between `observe` and here (the run concluded, another tick stopped it).
      // `no_action` rather than an offer against a row that is gone -- the same shape every other
      // arm uses when its subject has vanished.
      if (run === undefined || run.trip === null || run.count === null || run.detail === null) {
        return [{ action: { kind: 'no_action' }, tier: 'noop', why: 'that run is no longer looping' }]
      }
      const action: Action = {
        kind: 'steer_run',
        runId: run.id,
        slaveId: run.slaveId,
        text: steerTextFor({ kind: run.trip, count: run.count, detail: run.detail }),
      }
      return [
        {
          action,
          tier: tierOf(action, world, situation.kind),
          why:
            'tell it, once, in the system’s own words, that it is repeating itself -- the next rung ' +
            'takes its remaining tool budget away',
        },
      ]
    }
```

`packages/domain/src/supervisor/world.ts` — the new collection:

```ts
/**
 * One LIVE run, as the Supervisor sees it (M51 R3, plan erratum E9).
 *
 * Until this milestone the world held no runs at all: `SupervisorSlave.busy` was
 * `row.runs.length > 0` and was the only run-derived fact anywhere in it. `run_looping` is about a
 * run, so the run has to be in the world -- and the alternative, deriving it in `apps/orchestrator`
 * and passing a situation in, is exactly the shape `stale_task` is the one deliberate exception to.
 *
 * `trip`/`detail`/`count` are the newest `run.breaker` row's, loaded only when some run is at a
 * level above `none` (the loader pays for nothing a healthy board does not need). All three are
 * null together or non-null together; the predicate checks all three anyway, because a log the
 * loader could not read is a real state and a half-read trip is not a sentence.
 */
export interface SupervisorRun {
  readonly id: string
  readonly taskId: string | null
  readonly slaveId: string
  readonly status: RunStatus
  readonly toolCalls: number
  /** `SlaveRun.toolCallCap` -- null until a CONSTRAIN rung wrote one. */
  readonly toolCallCap: number | null
  readonly breakerLevel: BreakerLevel
  readonly breakerTrips: number
  readonly breakerSteers: number
  readonly trip: BreakerTripKind | null
  readonly detail: string | null
  readonly count: number | null
}
```

```ts
  /** Non-terminal runs of this workspace (M51 R3). Bounded by the concurrency guardrail: a
   *  workspace may have `maxConcurrentRuns` of them, three by default. */
  readonly runs: readonly SupervisorRun[]
```

- [ ] **Step 8: Run the supervisor domain tests and watch them pass**

Run: `npx vitest run packages/domain`
Expected: PASS — every existing supervisor case (the fixture defaults `runs: []`, so no predicate fires anywhere it did not before) plus 16 new cases across `observe`, `candidates` and `labels`.

- [ ] **Step 9: Add the Prisma enum, the seven columns and the migration**

`packages/db/prisma/schema.prisma` — the enum, beside `SlaveLifecycle`:

```prisma
/// M51 R2: how loudly the behavioural circuit breaker is currently speaking to one run. Mirrors
/// `BREAKER_LEVELS` in `packages/domain/src/breaker/detect.ts`, member for member
/// (`enum-parity.test.ts`). Three members and never a fourth: `stopped` is a `RunStatus`, and the
/// ladder's top rung is an ACT (cancel + `guardrail.tripped`), not a state a row sits in.
enum BreakerLevel {
  none
  steered
  constrained
}
```

`model SlaveRun` gains seven columns, after `skillCalls` and before `provider`:

```prisma
  /// M51 R2: the breaker's current rung for this run. `none` for every run recorded before M51 and
  /// for every run that is behaving.
  breakerLevel      BreakerLevel  @default(none)
  /// Every rung this run has ever climbed, up and never down. Bookkeeping a person reads; no rule
  /// keys on it.
  breakerTrips      Int           @default(0)
  /// How many times this run has been STEERED. Deliberately NOT reset when the ladder
  /// de-escalates: a run that trips, recovers and trips again is back at level `none` with a fresh
  /// rung available, and without a counter the ladder does not reset it, `STEERS_PER_RUN_MAX` would
  /// be a cap on nothing.
  breakerSteers     Int           @default(0)
  /// When the breaker last EVALUATED this run (plan erratum E5). The daemon ticks about once a
  /// second and the ladder moves at most once per `BREAKER_BEAT_MS`, so the beat needs a clock --
  /// and `SlaveRun` has no `updatedAt` to borrow. Null means "never evaluated", which beats on the
  /// first tick that sees the run.
  breakerBeatAt     DateTime?
  /// Consecutive beats on which every progress clock read false (plan erratum E5). `no_progress`
  /// is a DEBOUNCE over beats and `detectBehaviour` is pure, so the memory has to live on the row.
  /// Reset to 0 by any beat with progress on it.
  breakerQuietBeats Int           @default(0)
  /// M51 R3: this run's OWN tool-call ceiling, written by a CONSTRAIN rung as
  /// `toolCalls + CONSTRAIN_GRACE_CALLS`. Null means "use the workspace's `maxToolCallsPerRun`",
  /// which is every run that has not been constrained. The sweep's existing ceiling check reads
  /// `run.toolCallCap ?? workspace.maxToolCallsPerRun` -- one comparison, and the breach that then
  /// fires is the existing `tool_call_ceiling`, not a new name for the same fact.
  toolCallCap       Int?
  /// M51 R5: the MODEL half of the pair `resolveRuntime` dispatched this run with, written in the
  /// same statement as `provider` and for the same M12 Task 6 reason -- the profile chain can
  /// change under a live run, so the pair the run actually started with has to be recorded rather
  /// than re-resolved. Null on every run recorded before M51, and on any run whose chain named no
  /// model. It is what `estimateCostUsd` is keyed on; an unpriced or null model estimates `null`,
  /// never a guess.
  model             String?
```

and the two `EventType` members at the foot of that enum:

```prisma
  /// M51 R1: what came back from one tool call -- `ok`/`error`, a normalised class, and nothing
  /// else. Never the result text.
  run_tool_result             @map("run.tool_result")
  /// M51 R2: the behavioural breaker climbed a rung (steered, then constrained). The top rung is a
  /// `guardrail.tripped { guardrail: 'behavioural_loop' }` instead -- one rung, one event.
  run_breaker                 @map("run.breaker")
```

and `enum SupervisorSituationKind` gains `run_looping`.

`packages/db/prisma/migrations/20260912150000_m51_breaker/migration.sql`:

```sql
-- M51: the behavioural circuit breaker's state, and the model half of a run's runtime pair.
--
-- Additive throughout, and with NO DATA STATEMENT: every column is nullable or carries a default,
-- and no existing row means anything different under the new schema. A run recorded before M51 is
-- `breakerLevel = 'none'` with zero trips, which is exactly what it was.

CREATE TYPE "BreakerLevel" AS ENUM ('none', 'steered', 'constrained');

ALTER TABLE "SlaveRun" ADD COLUMN "breakerLevel" "BreakerLevel" NOT NULL DEFAULT 'none';
ALTER TABLE "SlaveRun" ADD COLUMN "breakerTrips" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SlaveRun" ADD COLUMN "breakerSteers" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SlaveRun" ADD COLUMN "breakerBeatAt" TIMESTAMP(3);
ALTER TABLE "SlaveRun" ADD COLUMN "breakerQuietBeats" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SlaveRun" ADD COLUMN "toolCallCap" INTEGER;
ALTER TABLE "SlaveRun" ADD COLUMN "model" TEXT;

-- `IF NOT EXISTS`, and each on its own statement: Postgres refuses `ALTER TYPE ... ADD VALUE`
-- inside a transaction block that then uses the new value, and Prisma runs a migration file as one
-- transaction -- the idiom every earlier migration in this directory uses for the same reason.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'run.tool_result';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'run.breaker';
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'run_looping';
```

`packages/db/src/enums.ts` — two entries at the foot of `EVENT_TYPE_BY_DOMAIN_TYPE`:

```ts
  'run.tool_result': 'run_tool_result',
  'run.breaker': 'run_breaker',
```

`packages/db/test/integration/enum-parity.test.ts` — the import list gains `BREAKER_LEVELS` and one assertion joins the block:

```ts
  // M51 R2: the breaker's own enum. Same reason as the Supervisor's four and the memory four --
  // nothing in TypeScript ties a Prisma enum to the domain union it mirrors, and a missing member
  // fails at the first `slaveRun.update` rather than at build.
  it('BreakerLevel matches BREAKER_LEVELS, member for member', async () => {
    expect(await enumValues('BreakerLevel')).toEqual([...BREAKER_LEVELS].sort())
  })
```

- [ ] **Step 10: Apply the migration to both databases and prove the schema and the migrations agree**

```bash
npm run db:generate
npm run db:migrate
npm run db:migrate:test
npx tsc --build
npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
```
Expected: the last command prints **"No difference detected"**. If it names a column or the enum, the SQL and `schema.prisma` disagree — fix the SQL, never the schema.

Then prove the additive claim against the dev database — no row changed meaning:

```bash
node -e "const {prisma}=require('./packages/db/dist/client.js');prisma.slaveRun.groupBy({by:['breakerLevel'],_count:{_all:true}}).then(r=>{console.log(r);return prisma.slaveRun.count({where:{OR:[{breakerLevel:{not:'none'}},{breakerTrips:{gt:0}},{toolCallCap:{not:null}}]}})}).then(n=>{console.log('rows the migration moved:',n);process.exit(n===0?0:1)})"
```
Expected: every existing run groups under `none`, and the last line is `rows the migration moved: 0`.

- [ ] **Step 11: Close the four exhaustive web sites the two new types widen**

These are `apps/web` files and they are in THIS task because `npm run --silent typecheck` is red without them.

`apps/web/src/lib/activityFilters.ts` — `TYPES_BY_KIND.tool_calls` gains one and `runs` gains one:

```ts
  // M51 R1: a tool RESULT sits beside the call it answers, under the same chip an operator filters
  // to when they want per-call activity. Not under `runs`: it is not a run lifecycle event, and one
  // per call would swamp that chip.
  tool_calls: ['run.tool_call', 'run.output', 'run.tool_denied', 'run.tool_result'],
```

```ts
  // M51 R2: a breaker rung is something that happened to the RUN, beside `run.paused`/`run.resumed`
  // -- the chip somebody filters to when asking "what happened to this run". Deliberately not
  // `guardrails`: that chip is `guardrail.tripped` alone, which is where the STOP rung announces
  // itself, and a person filtering for "what stopped work" must not also receive the two quieter
  // rungs that did not stop anything.
  runs: ['run.started', 'run.succeeded', 'run.failed', 'run.paused', 'run.resumed', 'run.breaker'],
```

`apps/web/src/components/activity/cards.tsx` — two cards and two registry entries:

```tsx
/** M51 R1: what one tool call came back with. `idle` tone for an ok and `warn` for an error -- an
 *  error here is one call failing, not a run in trouble, and red would make an ordinary retry look
 *  like an outage. The class is a KEY, so it rides `title`/`data-error-class` and the LABEL is what
 *  is printed (`docs/ia.md` rule 3). No result text exists to show: the payload does not carry any. */
function ToolResultCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    toolUseId: string
    toolName: string
    outcome: 'ok' | 'error'
    errorClass: string | null
  }
  const failed = payload.outcome === 'error'
  return (
    <ActivityCard {...props}>
      <Transition tone={failed ? 'warn' : 'idle'} label={failed ? 'failed' : 'ok'}>
        <span data-testid="tool-result-name">{payload.toolName}</span>
        {payload.errorClass !== null && (
          <>
            {' · '}
            <span data-testid="tool-result-class" title={payload.errorClass} data-error-class={payload.errorClass}>
              {TOOL_ERROR_LABEL[payload.errorClass] ?? payload.errorClass}
            </span>
          </>
        )}
      </Transition>
    </ActivityCard>
  )
}

/** M51 R2: the breaker climbed a rung. `warn`, because something is going wrong and the system is
 *  handling it -- the STOP rung is a `guardrail.tripped` and wears that card's own warn instead.
 *  The trip and the level are both KEYS: the labels print, the raw values ride `data-` attributes,
 *  which is also what `gate:m51-breaker` reads. */
function BreakerCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    level: 'steered' | 'constrained'
    trip: BreakerTripKind
    count: number
    detail: string
  }
  return (
    <ActivityCard {...props}>
      <Transition tone="warn" label={BREAKER_LEVEL_LABEL[payload.level].toLowerCase()}>
        <span data-testid="breaker-trip" title={payload.trip} data-breaker-trip={payload.trip}>
          {BREAKER_TRIP_LABEL[payload.trip]}
        </span>
        {' · '}
        <span data-testid="breaker-count">{plural(payload.count, 'time')}</span>
        {' · '}
        <span data-testid="breaker-detail" data-breaker-level={payload.level}>
          {payload.detail}
        </span>
      </Transition>
    </ActivityCard>
  )
}
```

with `TOOL_ERROR_LABEL: Readonly<Record<string, string>>` beside them (`api_error: 'the API errored'`, `timeout: 'it timed out'`, `not_found: 'not found'`, `permission: 'not permitted'`, `other: 'something else'`) — a `Record<string, string>` and not `Record<ToolErrorClass, string>` deliberately, because the wire type is a forgiving string (E17) and a class a later version invents must print itself rather than crash the card. The registry gains `'run.tool_result': ToolResultCard,` and `'run.breaker': BreakerCard,`.

`apps/web/src/server/timeline.ts` — one sentence (the tool result is on the null lane and never reaches this function, so it gets none):

```ts
    // M51 R2: the payload carries no `title`, so without a case of its own this would read as its
    // own type name on the WORK lane.
    case 'run.breaker': {
      const level = payload['level']
      const trip = payload['trip']
      const word = level === 'constrained' ? 'took its remaining tool budget away' : 'told it to stop and rethink'
      const because =
        typeof trip === 'string' && trip in BREAKER_TRIP_LABEL
          ? BREAKER_TRIP_LABEL[trip as BreakerTripKind].toLowerCase()
          : 'going in circles'
      return `${word} (${because})`
    }
```

`apps/web/src/components/SupervisorPanel.tsx` — `actionText`'s sixteenth arm, before `escalate_to_human`:

```ts
    // M51 R3: the SENTENCE is on the action, so this reads what was actually sent rather than
    // re-deriving it -- this function runs in the browser and has no breaker constants to consult.
    case 'steer_run':
      return `tell that run to stop and rethink: “${action.text}”`
```

`apps/web/test/activity-cards.test.tsx` — `PAYLOAD_BY_TYPE` gains two entries and the file two cases:

```ts
  'run.tool_result': { toolUseId: 'toolu_1', toolName: 'Bash', outcome: 'error', errorClass: 'timeout' },
  'run.breaker': { level: 'steered', trip: 'repeated_call', count: 8, detail: 'Bash:aaaa' },
```

```tsx
  it('prints the tool error’s LABEL and keeps the key on the element', () => {
    const Card = ACTIVITY_CARDS['run.tool_result']
    render(<Card event={fixtureFor('run.tool_result')} {...CARD_PROPS} />)
    expect(screen.getByTestId('tool-result-class').textContent).toBe('it timed out')
    expect(screen.getByTestId('tool-result-class').getAttribute('data-error-class')).toBe('timeout')
  })

  it('prints the breaker trip’s LABEL, its count and the rung as a data attribute', () => {
    const Card = ACTIVITY_CARDS['run.breaker']
    render(<Card event={fixtureFor('run.breaker')} {...CARD_PROPS} />)
    expect(screen.getByTestId('breaker-trip').textContent).toBe('Same call over and over')
    expect(screen.getByTestId('breaker-trip').getAttribute('data-breaker-trip')).toBe('repeated_call')
    expect(screen.getByTestId('breaker-count').textContent).toBe('8 times')
    expect(screen.getByTestId('breaker-detail').getAttribute('data-breaker-level')).toBe('steered')
  })
```

- [ ] **Step 12: Run the whole ladder for this task**

```bash
npx vitest run packages/domain packages/db
npx vitest run apps/web/test/activity-cards.test.tsx apps/web/test/activityFilters.test.ts
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: every domain and db test green (`enum-parity.test.ts` included — that is what Step 10's `db:migrate:test` was for, and it is now asserting five enums plus `BreakerLevel`); the two web tests green (`activityFilters.test.ts`'s runtime exhaustiveness check over `TYPES_BY_KIND` is what proves both new types were assigned exactly one chip); `typecheck` silent.

- [ ] **Step 13: Commit**

```bash
git add packages/domain packages/db apps/web/src/lib/activityFilters.ts apps/web/src/components apps/web/src/server/timeline.ts apps/web/test
git commit -m "$(cat <<'EOF'
feat(domain,db,web): m51 t2 — the log can answer what the detector saw, months later

`run.tool_call` gains a tool-use id and a hash of its arguments -- optional on read so every row
written before this milestone still parses, required on write so every row written after it can be
re-judged -- and `run.tool_result` is the 54th type: `ok` or `error`, a normalised class, and
nothing else that could turn the event log into a transcript. `run.breaker` is the 55th and it fires
only on an ESCALATION, because a durable steer re-sent every tick is a second bug and a
de-escalation is nobody's news. The sixteenth situation is the first whose subject is a run, its one
offer carries the sentence it will send so a reader months later can see what was said, and it is
the first routine action that speaks to a running worker -- defensible only because the words are a
constant. Seven columns, one enum, and a migration with no data statement in it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

---

### Task 3: The two new `RuntimeEvent` members, the args hash, the usage reading and the PostToolUse tap (R1, R5, R6, E2, E3, E4, E11, E17, D11–D13)

**Files:**
- Create: `packages/providers/src/hash.ts`, `packages/providers/src/tool-result.ts`, `scripts/tool-result-tap.sh`, `packages/providers/test/hash.test.ts`, `packages/providers/test/tool-result.test.ts`, `packages/providers/test/tool-result-tap.test.ts`
- Modify: `packages/providers/src/types.ts`, `packages/providers/src/capabilities.ts`, `packages/providers/src/claude/{adapter,settings,stream}.ts`, `packages/providers/src/cursor/stream.ts`, `packages/providers/src/runtime/{process,gate-preflight}.ts`, `packages/providers/src/index.ts`
- Test: `packages/providers/test/{hash,tool-result,tool-result-tap,stream,cursor-stream,claude-adapter,claude-settings,runtime-process,gate-preflight}.test.ts`

**Interfaces:**
- Consumes from Task 1: nothing (this package does not import the breaker). It stays independent of `packages/domain`'s new modules on purpose: the parsers produce evidence, the domain judges it.
- Produces, for Tasks 4–6:
  - `hashToolInput(input: unknown): string` (64-char lowercase hex), `HASH_STRING_CAP`, `HASH_ARRAY_MAX`, `HASH_DEPTH_MAX`
  - `TOOL_ERROR_CLASSES`, `type ToolErrorClass`, `classifyToolError(text: string | null): ToolErrorClass`
  - `RuntimeEvent` arm `tool_call` gains `argsHash: string`
  - `RuntimeEvent` arm `{ kind: 'tool_result'; toolUseId; toolName; outcome: 'ok' | 'error'; errorClass: ToolErrorClass | null }`
  - `RuntimeEvent` arm `{ kind: 'usage'; input: number; output: number }`
  - `parseStreamUsage(line: string): { input: number; output: number } | null`
  - `ProviderCapabilities.reportsToolResults: boolean`
  - `ClaudeCodeAdapterOptions.tapPath?: string`; `buildSettings({ hookPath, tapPath? })`
  - `buildChildEnv({ …, toolResultsPath? })` → `SLAVEOFAI_TOOL_RESULTS`
  - `preflightTap({ tapPath }): Promise<void>`
  - `scripts/tool-result-tap.sh`

- [ ] **Step 1: Write the failing tests for the hash and the error classifier**

`packages/providers/test/hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { HASH_ARRAY_MAX, HASH_DEPTH_MAX, HASH_STRING_CAP, hashToolInput } from '../src/hash.js'

describe('hashToolInput', () => {
  it('is a sha256 hex digest', () => {
    expect(hashToolInput({ a: 1 })).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('is stable across key order -- two calls that differ only in JSON layout are ONE call', () => {
    expect(hashToolInput({ a: 1, b: 2 })).toBe(hashToolInput({ b: 2, a: 1 }))
  })

  it('separates two Bash commands that share a long path preamble', () => {
    // THE bug this function exists to avoid: a prefix slice (`JSON.stringify(input).slice(0, 200)`)
    // collided nine different commands that shared a long `cd /very/long/path && ...` preamble, and
    // the breaker constrained a working agent. A per-STRING cap cannot do that -- the cap is on
    // each string, not on the whole serialisation.
    const preamble = `cd ${'/deep/nested/path'.repeat(20)} && `
    expect(hashToolInput({ command: `${preamble}npm test` })).not.toBe(
      hashToolInput({ command: `${preamble}npm run build` }),
    )
  })

  it('caps each string at HASH_STRING_CAP CODE POINTS, so two long tails collide deliberately', () => {
    const head = 'x'.repeat(HASH_STRING_CAP)
    expect(hashToolInput({ content: `${head}aaa` })).toBe(hashToolInput({ content: `${head}bbb` }))
    // And the cap counts code points, not UTF-16 units: an emoji is one character.
    expect(() => hashToolInput({ content: '🙂'.repeat(HASH_STRING_CAP + 10) })).not.toThrow()
  })

  it('caps arrays and depth, and says how many it dropped rather than dropping them silently', () => {
    const long = Array.from({ length: HASH_ARRAY_MAX + 5 }, (_, i) => i)
    const longer = Array.from({ length: HASH_ARRAY_MAX + 6 }, (_, i) => i)
    // Different LENGTHS still differ -- the count is part of the canonical form.
    expect(hashToolInput({ xs: long })).not.toBe(hashToolInput({ xs: longer }))
    let deep: unknown = 'leaf'
    for (let i = 0; i < HASH_DEPTH_MAX + 4; i += 1) deep = { deep }
    expect(hashToolInput(deep)).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('drops what cannot be canonicalised instead of throwing', () => {
    expect(hashToolInput({ n: Number.NaN, i: Infinity, f: () => 1, u: undefined })).toBe(hashToolInput({}))
  })

  it('never throws on a cyclic input -- a parser must not die on a shape the CLI sent', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic['self'] = cyclic
    expect(() => hashToolInput(cyclic)).not.toThrow()
  })

  it('distinguishes the empty cases from each other', () => {
    const hashes = new Set([hashToolInput(undefined), hashToolInput(null), hashToolInput({}), hashToolInput([])])
    expect(hashes.size).toBe(4)
  })
})
```

`packages/providers/test/tool-result.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { TOOL_ERROR_CLASSES, classifyToolError } from '../src/tool-result.js'

describe('classifyToolError', () => {
  it('only ever answers with a member of the closed list', () => {
    for (const text of ['API Error: 500', 'timed out after 120s', 'ENOENT', 'permission denied', 'weird', '', null]) {
      expect(TOOL_ERROR_CLASSES, String(text)).toContain(classifyToolError(text))
    }
  })

  it('names the four kinds a breaker reader would want to tell apart', () => {
    expect(classifyToolError('API Error: 529 overloaded')).toBe('api_error')
    expect(classifyToolError('Command timed out after 120000ms')).toBe('timeout')
    expect(classifyToolError('ENOENT: no such file or directory')).toBe('not_found')
    expect(classifyToolError('EACCES: permission denied, open ...')).toBe('permission')
  })

  it('is `other` for anything it does not recognise, and for nothing at all', () => {
    expect(classifyToolError('the tests failed')).toBe('other')
    expect(classifyToolError(null)).toBe('other')
  })

  it('never returns anything longer than the event schema’s forty-character cap', () => {
    for (const kind of TOOL_ERROR_CLASSES) expect(kind.length).toBeLessThanOrEqual(40)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/providers/test/hash.test.ts packages/providers/test/tool-result.test.ts`
Expected: FAIL — `Failed to resolve import "../src/hash.js"`.

- [ ] **Step 3: Write the hash and the classifier**

`packages/providers/src/hash.ts`:

```ts
import { createHash } from 'node:crypto'

/**
 * How long any one string may be before it is cut, in CODE POINTS (M51 R1).
 *
 * A cap PER STRING, never a slice of the whole serialisation -- and that distinction is the whole
 * point of this module. A prefix slice of the serialised input collides two calls whose difference
 * sits past the cut, which in the harness this finding comes from meant nine different `Bash`
 * commands sharing a long path preamble all hashed the same and a working agent was constrained for
 * repeating itself. A per-string cap collides only two strings that are identical for their first
 * 512 characters, which is a real collision and a rare one, and never mixes one argument's length
 * with another's.
 *
 * Code points rather than UTF-16 units so a cut never lands inside a surrogate pair and produces a
 * lone half that hashes differently from run to run.
 */
export const HASH_STRING_CAP = 512

/** How many entries of any one array are read. The COUNT is canonicalised alongside them, so two
 *  arrays that differ only past the cap still differ. */
export const HASH_ARRAY_MAX = 32

/** How deep the walk goes before it stops descending. A tool input is a flat-ish options object;
 *  six levels is far past any measured one and bounds the walk against a pathological payload. */
export const HASH_DEPTH_MAX = 6

/**
 * `sha256(canonical(input))`, hex, for one tool call's arguments (M51 R1).
 *
 * **The arguments are never persisted anywhere.** This function's whole purpose is to let the
 * detector ask "is this the same call again?" without the event log becoming a transcript:
 * `RunContext.prompt` remains the only place in this system where a prompt or a body of text a
 * worker produced is stored, and `run.tool_call` carries this digest instead.
 *
 * Canonicalisation, in one pass, and every rule is a way two calls could look different while being
 * the same call (or the reverse):
 *   - object keys are SORTED, so `{a,b}` and `{b,a}` are one call;
 *   - each string is capped at {@link HASH_STRING_CAP} code points;
 *   - each array is capped at {@link HASH_ARRAY_MAX} entries, with its true LENGTH kept beside them;
 *   - the walk stops at {@link HASH_DEPTH_MAX} and writes a sentinel;
 *   - non-finite numbers, functions, symbols and `undefined` are DROPPED (they cannot round-trip
 *     through JSON anyway, so keeping them would make the digest depend on how the CLI happened to
 *     serialise the line);
 *   - a value already on the walk's own stack is a CYCLE and writes a sentinel, because a parser
 *     must not die on a shape the CLI sent.
 *
 * The four empty cases -- `undefined`, `null`, `{}`, `[]` -- canonicalise differently on purpose: a
 * tool called with no arguments and a tool called with an empty options object are different calls,
 * and folding them together would be the first collision anybody hit.
 */
export function hashToolInput(input: unknown): string {
  return createHash('sha256').update(canonical(input, 0, new Set())).digest('hex')
}

function canonical(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > HASH_DEPTH_MAX) return '#deep'
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string': {
      const points = [...value]
      return points.length <= HASH_STRING_CAP
        ? `s:${value}`
        : `s:${points.slice(0, HASH_STRING_CAP).join('')}#cut`
    }
    case 'number':
      return Number.isFinite(value) ? `n:${String(value)}` : '#drop'
    case 'boolean':
      return `b:${String(value)}`
    case 'bigint':
      return `n:${value.toString()}`
    case 'undefined':
    case 'function':
    case 'symbol':
      return '#drop'
    default:
      break
  }
  const object = value as object
  if (seen.has(object)) return '#cycle'
  seen.add(object)
  try {
    if (Array.isArray(value)) {
      const head = value.slice(0, HASH_ARRAY_MAX).map((entry) => canonical(entry, depth + 1, seen))
      return `a:${String(value.length)}:[${head.join(',')}]`
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, canonical(entry, depth + 1, seen)] as const)
      // Dropped values take their KEY with them: a key whose value cannot be canonicalised is not a
      // fact about the call, and keeping the bare key would make `{f: () => 1}` differ from `{}`
      // for a reason nobody could see.
      .filter(([, entry]) => entry !== '#drop')
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `o:{${entries.map(([key, entry]) => `${key}=${entry}`).join(',')}}`
  } finally {
    seen.delete(object)
  }
}
```

`packages/providers/src/tool-result.ts`:

```ts
/**
 * What KIND of failure one tool call reported (M51 R1), as a closed list.
 *
 * A normalised token and never the error text: a breaker asking "is everything failing the same
 * way" needs a class, and the text of a failure is exactly the unbounded, sometimes-secret-bearing
 * thing the event log must not hold.
 *
 * The list types the PRODUCERS -- `run.tool_result.errorClass` is `z.string().max(40).nullable()` on
 * the wire for `guardrail.tripped`'s own reason (M51 R4): a closed enum in the schema would make a
 * log holding a class a later version invented unreadable, and `packages/events/src/read.ts` throws
 * on a row it cannot parse.
 */
export const TOOL_ERROR_CLASSES = ['api_error', 'timeout', 'not_found', 'permission', 'other'] as const

export type ToolErrorClass = (typeof TOOL_ERROR_CLASSES)[number]

/**
 * The class of one failure, from whatever the runtime said about it. Total, and `other` for
 * everything it does not recognise.
 *
 * Matched on the error text case-insensitively, and deliberately on BOTH the human wording and the
 * errno the runtimes actually emit -- `ENOENT`/`ENOTDIR` for not-found, `EACCES`/`EPERM` for
 * permission. The order matters where two could match: a timeout inside an API call is a timeout,
 * because that is what a person would do something about.
 *
 * Nothing here is measured against every possible tool, and nothing needs to be: an unrecognised
 * failure is `other`, `other` still counts toward an error storm, and the class only ever decorates
 * the trip's `detail`. Being wrong about a class costs a word on a card; being wrong about the
 * OUTCOME would cost a trip, and the outcome is read from the runtime's own boolean.
 */
export function classifyToolError(text: string | null): ToolErrorClass {
  if (text === null) return 'other'
  const lower = text.toLowerCase()
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) return 'timeout'
  if (lower.includes('api error') || lower.includes('api_error') || lower.includes('rate limit')) return 'api_error'
  if (lower.includes('enoent') || lower.includes('enotdir') || lower.includes('no such file')) return 'not_found'
  if (lower.includes('eacces') || lower.includes('eperm') || lower.includes('permission denied')) return 'permission'
  return 'other'
}
```

`packages/providers/src/index.ts` gains `export * from './hash.js'` and `export * from './tool-result.js'`.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run packages/providers/test/hash.test.ts packages/providers/test/tool-result.test.ts`
Expected: PASS — 8 hash cases, 4 classifier cases.

- [ ] **Step 5: Write the failing tests for the three `RuntimeEvent` changes**

Appended to `packages/providers/test/stream.test.ts`:

```ts
describe('tool_call carries an args hash (M51 R1)', () => {
  const toolUse = (input: unknown): string =>
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input }] },
    })

  it('hashes the tool_use block’s own input', () => {
    const event = parseStreamLine(toolUse({ command: 'npm test' }))
    expect(event).toMatchObject({ kind: 'tool_call', toolUseId: 'toolu_1', toolName: 'Bash' })
    expect((event as { argsHash: string }).argsHash).toBe(hashToolInput({ command: 'npm test' }))
  })

  it('gives two byte-identical calls one hash and two different calls two', () => {
    const a = parseStreamLine(toolUse({ command: 'npm test' })) as { argsHash: string }
    const b = parseStreamLine(toolUse({ command: 'npm test' })) as { argsHash: string }
    const c = parseStreamLine(toolUse({ command: 'npm test -- --watch' })) as { argsHash: string }
    expect(a.argsHash).toBe(b.argsHash)
    expect(a.argsHash).not.toBe(c.argsHash)
  })

  it('still produces a hash for a tool_use with no input at all', () => {
    expect(parseStreamLine(toolUse(undefined))).toMatchObject({ argsHash: hashToolInput(undefined) })
  })
})

describe('the user/tool_result line (M51 R1)', () => {
  const line = (over: Record<string, unknown>): string =>
    JSON.stringify({
      type: 'user',
      message: { content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'ok', ...over }] },
    })

  it('is a tool_result event now, not `ignored`', () => {
    expect(parseStreamLine(line({ is_error: false }))).toEqual({
      kind: 'tool_result',
      toolUseId: 'toolu_1',
      toolName: '',
      outcome: 'ok',
      errorClass: null,
    })
  })

  it('reads the runtime’s own boolean for the outcome and classifies the text', () => {
    expect(parseStreamLine(line({ is_error: true, content: 'API Error: 529' }))).toMatchObject({
      outcome: 'error',
      errorClass: 'api_error',
    })
  })

  it('treats a missing is_error as OK -- the measured fixtures carry it on every result line', () => {
    // `packages/providers/test/fixtures/complete.ndjson` lines 3 and 7 both carry `is_error: false`.
    // A line without one is a degraded shape, and calling it an error would manufacture storms.
    expect(parseStreamLine(line({}))).toMatchObject({ outcome: 'ok' })
  })

  it('carries NO result text under any key', () => {
    const event = parseStreamLine(line({ is_error: false, content: 'the whole file'.repeat(1000) }))
    expect(JSON.stringify(event)).not.toContain('the whole file')
  })

  it('stays `ignored` for a user line that is the prompt echo rather than a tool result', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'user', message: { content: 'do the thing' } })).kind).toBe('ignored')
  })
})

describe('parseStreamUsage (M51 R5)', () => {
  it('reads an assistant line’s per-turn usage under the same billed-input rule the result uses', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 7 },
      },
    })
    expect(parseStreamUsage(raw)).toEqual({ input: 1002, output: 7 })
  })

  it('is null for every line that is not an assistant line with usage on it', () => {
    expect(parseStreamUsage(JSON.stringify({ type: 'result', usage: { input_tokens: 1, output_tokens: 1 } }))).toBeNull()
    expect(parseStreamUsage(JSON.stringify({ type: 'assistant', message: { content: [] } }))).toBeNull()
    expect(parseStreamUsage('{bad')).toBeNull()
  })

  it('is null when only half the pair is present -- a half figure is a lie a token sum believes', () => {
    const raw = JSON.stringify({ type: 'assistant', message: { content: [], usage: { input_tokens: 5 } } })
    expect(parseStreamUsage(raw)).toBeNull()
  })

  it('does NOT sum to the run’s own result line, and that is a measured fact not a bug', async () => {
    // MEASURED against `fixtures/complete.ndjson`: the four assistant lines report 27 output tokens
    // between them, the `result` line reports 741. The mid-run figure is a FLOOR, and this test is
    // what stops a later reader believing it is the total.
    const lines = (await readFile(FIXTURE('complete'), 'utf8')).split('\n').filter((one) => one !== '')
    let output = 0
    let terminal = 0
    for (const line of lines) {
      const usage = parseStreamUsage(line)
      if (usage !== null) output += usage.output
      const event = parseStreamLine(line)
      if (event.kind === 'terminated') terminal = event.outcome.tokens?.output ?? 0
    }
    expect(output).toBe(27)
    expect(terminal).toBe(741)
    expect(output).toBeLessThan(terminal)
  })

  it('never changes what parseStreamLine returns for the same line', () => {
    const raw = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1, output_tokens: 1 } },
    })
    // One line, one `RuntimeEvent` -- the contract `parseStreamLine`'s exhaustiveness tests rest on.
    // The usage rides a SECOND pure function the adapter calls beside it, which is exactly why this
    // member did not have to change one parser's signature into an array.
    expect(parseStreamLine(raw)).toEqual({ kind: 'text', text: 'hi' })
  })
})
```

Appended to `packages/providers/test/cursor-stream.test.ts` — and the exhaustiveness allow-list at `:640` becomes seven:

```ts
describe('the completed tool_call line (M51 R1/E3)', () => {
  it('is a tool_result now, not folded away', () => {
    const line = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'c1',
      tool_call: { readToolCall: { args: { path: '/x' }, result: { success: { content: 'hi' } } } },
    })
    expect(parseCursorLine(line)).toEqual({
      kind: 'tool_result',
      toolUseId: 'c1',
      toolName: 'read',
      outcome: 'ok',
      errorClass: null,
    })
  })

  it('reads `result.success` as the OK discriminator -- there is no is_error on this line', () => {
    const failed = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'c2',
      tool_call: { shellToolCall: { args: {}, result: { failure: { message: 'ENOENT' } } } },
    })
    expect(parseCursorLine(failed)).toMatchObject({ outcome: 'error', errorClass: 'other' })
  })

  it('still reports a REJECTED call as permission_denied -- that arm is checked first', () => {
    const rejected = JSON.stringify({
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'c3',
      tool_call: { shellToolCall: { args: {}, result: { rejected: { command: 'rm', reason: 'paused' } } } },
    })
    expect(parseCursorLine(rejected)).toMatchObject({ kind: 'permission_denied', toolUseId: 'c3' })
  })

  it('gives a started tool_call an args hash of its own args', () => {
    const started = JSON.stringify({
      type: 'tool_call',
      subtype: 'started',
      call_id: 'c4',
      tool_call: { readToolCall: { args: { path: '/x' } } },
    })
    expect(parseCursorLine(started)).toMatchObject({ kind: 'tool_call', argsHash: hashToolInput({ path: '/x' }) })
  })
})
```

```ts
      expect(['session_started', 'text', 'tool_call', 'tool_result', 'terminated', 'ignored', 'unparsable']).toContain(
        kind,
      )
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npx vitest run packages/providers/test/stream.test.ts packages/providers/test/cursor-stream.test.ts`
Expected: FAIL — `parseStreamUsage` is not exported; the `tool_result` cases receive `{ kind: 'ignored' }`; and **the exhaustiveness test at `cursor-stream.test.ts:631` fails first**, which is the tripwire firing exactly as designed — a new `RuntimeEvent` member that only one vendor produced would stop there and stay stopped.

- [ ] **Step 7: Widen `RuntimeEvent` and both parsers**

`packages/providers/src/types.ts`:

```ts
  | {
      readonly kind: 'tool_call'
      readonly toolUseId: string
      readonly toolName: string
      readonly summary: string
      /**
       * M51 R1: `hashToolInput` of the call's own arguments. On the EVENT and not only on the
       * persisted row (plan erratum E2), because `apps/orchestrator/src/pump.ts` -- the one consumer
       * of this stream -- has nothing else to build `run.tool_call` from.
       *
       * Not `summary`, which is a best-effort human string and collides: two `Bash` calls with
       * different commands summarise identically when neither carries a known argument key.
       * `summary` is what a person reads; this is what the detector compares.
       */
      readonly argsHash: string
    }
  /**
   * M51 R1: what came BACK from one tool call. Vendor-neutral by construction and produced by BOTH
   * runtimes -- Claude's `user`/`tool_result` lines (previously `ignored`) and Cursor's `completed`
   * tool_call line (previously folded away for want of a variant, `cursor/stream.ts`). The fact that
   * both could produce it is what earned it a place in this union at all (`types.ts`'s own rule
   * against widening for a narrow need), and moving `cursor-stream.test.ts`'s allow-list from six
   * kinds to seven is the proof.
   *
   * FOUR fields and no fifth. There is no result text, no stdout, no diff and no stack trace: this
   * event exists so a detector can count failures and tell a finished call from a running one, and
   * everything beyond that would make the stream a transcript.
   *
   * `toolName` is the empty string when the line does not carry one -- Claude's `tool_result`
   * blocks name the id, not the tool, and the pump pairs it back to the call it answers. Empty
   * rather than optional so every producer and consumer reads one shape.
   */
  | {
      readonly kind: 'tool_result'
      readonly toolUseId: string
      readonly toolName: string
      readonly outcome: 'ok' | 'error'
      readonly errorClass: ToolErrorClass | null
    }
  /**
   * M51 R5: one turn's token usage, mid-run.
   *
   * `RunOutcome.tokens` is the run's CUMULATIVE figure and arrives only on the terminal `result`
   * line, so a live runaway is invisible until it stops. This member is what makes it visible --
   * and it is an explicit FLOOR, not a total: measured on `test/fixtures/complete.ndjson`, the
   * assistant lines' own `output_tokens` sum to 27 against the result line's 741, because a
   * streamed message's per-turn usage is not the whole of what the run was billed. The pump
   * accumulates it while the run is live and the terminal write REPLACES it with the authoritative
   * figure.
   *
   * Claude only: Cursor's stream carries no per-turn usage at all (`reportsCost: false`, and its
   * `result` line's `usage` is the only figure it has).
   */
  | { readonly kind: 'usage'; readonly input: number; readonly output: number }
```

`packages/providers/src/claude/stream.ts`:

```ts
    case 'user':
      // M51 R1: a `tool_result` echo, which is where a `tool_use_id` and the call's own success
      // boolean live. Read now, where before this parser recognised the line and acted on nothing:
      // a detector that cannot tell a finished call from a running one has no way to say that a
      // quiet twenty-minute build is not a loop.
      return parseUserLine(raw, line)
```

```ts
const toolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  // `z.unknown()` and never read for its VALUE: the content is the result body, and the only thing
  // taken from it is a CLASS, via `classifyToolError`. Typed loosely for `toolUseContentSchema`'s
  // own reason -- a malformed body must not make the line unparsable.
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
})

function parseUserLine(raw: unknown, line: string): RuntimeEvent {
  const envelope = userEnvelopeSchema.safeParse(raw)
  // A `user` line whose content is a bare prompt string (the echo, and the resumed conversation) is
  // recognised and carries no decision, exactly as it always did.
  if (!envelope.success) return { kind: 'ignored', line }
  const block = envelope.data.message.content.find(isToolResultBlock)
  if (block === undefined) return { kind: 'ignored', line }
  const result = toolResultContentSchema.safeParse(block)
  if (!result.success) return { kind: 'unparsable', line }
  // The runtime's OWN boolean, never an inference from the text: a result whose body happens to
  // contain the word "error" is not a failed call, and a storm built on that reading would trip on
  // a worker grepping its own logs. Absent reads as OK -- every measured fixture line carries it,
  // so an absent one is a degraded shape, and calling a degraded shape a failure manufactures
  // storms out of nothing.
  const failed = result.data.is_error === true
  return {
    kind: 'tool_result',
    toolUseId: result.data.tool_use_id,
    // Claude's `tool_result` block names the id, not the tool. The pump has the pairing.
    toolName: '',
    outcome: failed ? 'error' : 'ok',
    errorClass: failed ? classifyToolError(typeof result.data.content === 'string' ? result.data.content : null) : null,
  }
}
```

```ts
/**
 * One assistant line's token usage, or null (M51 R5).
 *
 * A SECOND pure function beside {@link parseStreamLine} rather than a second event out of it, and
 * the reason is the contract: `parseStreamLine` returns exactly ONE `RuntimeEvent` per line, which
 * is what its exhaustiveness tests and every caller rest on -- and a turn's `usage` rides the SAME
 * assistant line as its `tool_use` block. Folding usage into that function would mean either
 * dropping it on every tool-calling turn (the majority of them) or changing the signature to an
 * array. The adapter calls both, in one pass over one line, and pushes whichever events came back
 * into the same queue.
 *
 * The billed-input rule is `parseResultLine`'s, verbatim and for its reason: `input_tokens +
 * cache_creation_input_tokens + cache_read_input_tokens`, each 0 when absent. Both halves or
 * neither -- a `usage` carrying only one is a measurement that did not complete, and a fabricated
 * zero would land in a token sum.
 */
export function parseStreamUsage(line: string): { readonly input: number; readonly output: number } | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const parsed = assistantUsageSchema.safeParse(raw)
  if (!parsed.success) return null
  const usage = parsed.data.message.usage
  if (usage === undefined) return null
  if (typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null
  return {
    input: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    output: usage.output_tokens,
  }
}
```

and `parseAssistantLine`'s `tool_use` return gains `argsHash: hashToolInput(result.data.input)`.

`packages/providers/src/cursor/stream.ts` — the `completed` arm, after the existing `rejected` check and replacing the bare `return { kind: 'ignored', line }`:

```ts
    // M51 R1/E3: the completed half carries the call's RESULT, and `RuntimeEvent` now has a variant
    // for exactly that. It is still ONE event about one call -- `tool_result`, not a second
    // `tool_call` -- so nothing doubles.
    //
    // The discriminator is `result.success`, because this line has no `is_error` (measured:
    // `fixtures/cursor/cursor-run.ndjson` line 7 is `{"result":{"success":{...}}}`, and
    // `fixtures/cursor/gate/run-2-flag-present.ndjson` is `{"result":{"rejected":{...}}}`). Anything
    // that is not a `success` and not a `rejected` is a failure of some shape this parser has not
    // been shown, which is `other` rather than a guess -- and a `completed` line with no readable
    // result at all is `ignored`, because "the call finished" with no evidence either way must not
    // count toward an error storm.
    if (toolKey === undefined || !isRecord(result)) return { kind: 'ignored', line }
    const ok = 'success' in result
    return {
      kind: 'tool_result',
      toolUseId: data.call_id,
      toolName: toolKey.endsWith('ToolCall') ? toolKey.slice(0, -'ToolCall'.length) : toolKey,
      outcome: ok ? 'ok' : 'error',
      errorClass: ok ? null : classifyToolError(JSON.stringify(result).slice(0, 400)),
    }
```

and `parseToolCallLine`'s `started` return gains `argsHash: hashToolInput(args)`.

- [ ] **Step 8: Run the parser tests and watch them pass**

Run: `npx vitest run packages/providers/test/stream.test.ts packages/providers/test/cursor-stream.test.ts packages/providers/test/fake-claude.test.ts`
Expected: PASS — including the exhaustiveness test at its new seven kinds, and including the measured 27-vs-741 case, which is the whole evidence for E4.

- [ ] **Step 9: Write the failing tests for the tap, its settings registration and its pre-flight**

`packages/providers/test/tool-result-tap.test.ts` (a script test, the shape `packages/providers/test/cursor-shell-gate.test.ts` already has — spawn the real `.sh` with a temp file and a stdin payload):

```ts
describe('scripts/tool-result-tap.sh', () => {
  it('writes ONE bounded NDJSON line per call and says nothing on stdout', async () => {
    const { stdout, exitCode, lines } = await runTap({
      tool_use_id: 'toolu_1',
      tool_name: 'Bash',
      tool_response: { is_error: false },
    })
    expect(exitCode).toBe(0)
    // A PostToolUse hook that speaks is a hook whose stdout the CLI parses. This one has nothing to
    // say -- it is a tap, not a gate.
    expect(stdout).toBe('')
    expect(lines).toEqual([{ toolUseId: 'toolu_1', toolName: 'Bash', outcome: 'ok', errorClass: null }])
  })

  it('reports a failed call with a class and never the response body', async () => {
    const { lines } = await runTap({
      tool_use_id: 'toolu_2',
      tool_name: 'Bash',
      tool_response: { is_error: true, content: 'API Error: 529 and here is the whole log' },
    })
    expect(lines[0]).toMatchObject({ outcome: 'error', errorClass: 'api_error' })
    expect(JSON.stringify(lines)).not.toContain('here is the whole log')
  })

  it('appends, so a run’s calls accumulate in order', async () => {
    const { lines } = await runTap(
      { tool_use_id: 'a', tool_name: 'Read', tool_response: {} },
      { tool_use_id: 'b', tool_name: 'Write', tool_response: {} },
    )
    expect(lines.map((line) => line.toolUseId)).toEqual(['a', 'b'])
  })

  it('caps its own line and stays exit 0 on a payload it cannot read', async () => {
    const { exitCode, stdout, lines } = await runTapRaw('{not json')
    // FAIL OPEN, loudly on stderr and silently on stdout. A PostToolUse hook that exits non-zero
    // would interfere with a run for the sake of a diagnostic -- the opposite of the ruling that
    // the STREAM wins and the tap only fills a gap.
    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
    expect(lines).toEqual([])
  })

  it('writes nothing at all when SLAVEOFAI_TOOL_RESULTS is unset', async () => {
    const { exitCode, stdout } = await runTapWithoutEnv({ tool_use_id: 'x', tool_name: 'Read', tool_response: {} })
    expect(exitCode).toBe(0)
    expect(stdout).toBe('')
  })
})
```

Appended to `packages/providers/test/claude-settings.test.ts`:

```ts
  it('registers the tap as PostToolUse beside the gate, when there is one', () => {
    const settings = buildSettings({ hookPath: '/abs/pause-gate.sh', tapPath: '/abs/tool-result-tap.sh' })
    expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toBe('/abs/pause-gate.sh')
    expect(settings.hooks.PostToolUse?.[0]).toEqual({
      matcher: '*',
      hooks: [{ type: 'command', command: '/abs/tool-result-tap.sh' }],
    })
  })

  it('omits PostToolUse entirely when no tap was configured -- the key, not an empty array', () => {
    expect(buildSettings({ hookPath: '/abs/pause-gate.sh' }).hooks.PostToolUse).toBeUndefined()
  })

  it('refuses a relative tap path for the same reason it refuses a relative hook path', () => {
    expect(() => buildSettings({ hookPath: '/abs/a.sh', tapPath: './b.sh' })).toThrow(/absolute/u)
  })
```

Appended to `packages/providers/test/runtime-process.test.ts`: `buildChildEnv` sets `SLAVEOFAI_TOOL_RESULTS` when given a path and leaves the key absent when not.

Appended to `packages/providers/test/gate-preflight.test.ts`:

```ts
describe('preflightTap (M51 R6, plan erratum E11)', () => {
  it('passes for a tap that writes one line and says nothing', async () => {
    await expect(preflightTap({ tapPath: REAL_TAP })).resolves.toBeUndefined()
  })

  it('fails a tap that writes to stdout -- the CLI would read that as a hook response', async () => {
    await expect(preflightTap({ tapPath: await chatty() })).rejects.toThrow(/stdout/u)
  })

  it('fails a tap that writes no line -- a tap that records nothing is not installed', async () => {
    await expect(preflightTap({ tapPath: await silent() })).rejects.toThrow(/wrote no line/u)
  })

  it('fails a relative path before it spawns anything', async () => {
    await expect(preflightTap({ tapPath: './x.sh' })).rejects.toThrow(/absolute/u)
  })
})
```

- [ ] **Step 10: Run them and watch them fail**

```bash
npx vitest run packages/providers/test/tool-result-tap.test.ts packages/providers/test/claude-settings.test.ts packages/providers/test/gate-preflight.test.ts packages/providers/test/runtime-process.test.ts
```
Expected: FAIL — `ENOENT scripts/tool-result-tap.sh`, `Object literal may only specify known properties, 'tapPath'`, and `preflightTap is not exported`.

- [ ] **Step 11: Write the tap, register it, and give it its own pre-flight**

`scripts/tool-result-tap.sh` — a sibling of `scripts/pause-gate.sh`, and deliberately much smaller:

```bash
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
set -uo pipefail
```
followed by: read stdin whole; if `SLAVEOFAI_TOOL_RESULTS` is unset or empty, `exit 0`; parse `tool_use_id`, `tool_name` and `tool_response.is_error` with `node -e` when `node` is on PATH and with a bounded `sed`/`grep` fallback otherwise — **written the way `scripts/lib/pause-flag.sh`'s encoder is: one helper, tested by the script test above, never a second JSON parser inlined at a call site**; classify the error text with the same five tokens `classifyToolError` uses; refuse to write a line longer than `TAP_LINE_MAX_BYTES=4096`; append one line with `>>` and `exit 0` on every path.

> **The implementer writes this script against `packages/providers/test/tool-result-tap.test.ts`, which is the contract.** The five cases above are the whole of it: one line per call, empty stdout, append order, exit 0 on a payload it cannot read, and silence with no env var. Match `scripts/pause-gate.sh`'s house style — the explicit-exit discipline, the sourced helper, the `set -uo pipefail` without `-e`, and the comment block that says what was measured.

`packages/providers/src/claude/settings.ts`:

```ts
export interface ClaudeSettings {
  readonly hooks: {
    readonly PreToolUse: readonly [
      { readonly matcher: '*'; readonly hooks: readonly [{ readonly type: 'command'; readonly command: string }] },
    ]
    /**
     * M51 R6: the tool-result tap, matcher `"*"`, registered exactly the way the gate above is.
     *
     * OPTIONAL, and the key is ABSENT rather than an empty array when there is no tap: a settings
     * file with an empty `PostToolUse` array is a registration of nothing, and this file is the ONE
     * place Claude's hook JSON shape is spelled -- keeping it honest about what is actually
     * installed is the whole reason it is one place.
     */
    readonly PostToolUse?: readonly [
      { readonly matcher: '*'; readonly hooks: readonly [{ readonly type: 'command'; readonly command: string }] },
    ]
  }
}
```

`buildSettings` gains `tapPath?: string`, enforces `isAbsolute` on it with the same message shape, and spreads the key in only when present. `writeSettingsFile` passes it through. `ClaudeCodeAdapterOptions` gains:

```ts
  /**
   * M51 R6: the `PostToolUse` tap script this adapter registers, and pre-flights on `start()`.
   *
   * `hookPath`'s exact shape and for its reason: a fact about this RUNTIME (the orchestrator's own
   * `scripts/tool-result-tap.sh`), never something that varies run to run. OPTIONAL, unlike
   * `hookPath`: a deployment that has not installed the tap runs perfectly well without it -- the
   * stream carries the same facts and the tap only fills a gap -- and making it required would turn
   * an optional measurement into a spawn failure.
   */
  readonly tapPath?: string
```

`packages/providers/src/runtime/process.ts` — `buildChildEnv` gains `toolResultsPath?: string` and spreads `SLAVEOFAI_TOOL_RESULTS` only when it is given (Cursor's spawn passes nothing and is unaffected, which is `reportsToolResults`'s own story: Cursor's results come from its stream).

`packages/providers/src/runtime/gate-preflight.ts` — `preflightTap`:

```ts
/**
 * The tap's own pre-flight (M51 R6, plan erratum E11).
 *
 * {@link preflightGate} cannot do this job: it arms and disarms a pause flag and asserts BOTH
 * directions, and a tap has no directions -- it never denies, so the armed half fails by
 * construction. What CAN be asserted about a tap is exactly three things, and all three are
 * necessary conditions a broken install fails:
 *
 *   - **exit 0.** A PostToolUse hook that exits non-zero interferes with the run it is watching.
 *   - **empty stdout.** The CLI parses a hook's stdout as a hook response. A tap that speaks can
 *     change a run, which is the one thing a tap must never do.
 *   - **exactly one parseable line, with the four fields.** A tap that records nothing is not
 *     installed, and this is the half that a path typo, a missing `node` and a non-executable bit
 *     all fail at.
 *
 * What this does NOT prove, said out loud the way `preflightGate`'s docstring says its own: that the
 * CLI will actually invoke the script. A correct tap registered under a matcher that never matches
 * passes this and records nothing. That is what R6's MEASUREMENT is for.
 */
export async function preflightTap(input: { readonly tapPath: string }): Promise<void>
```

Implemented with `mkdtemp` + a synthetic `{ tool_use_id: 'preflight', tool_name: 'Preflight', tool_response: { is_error: false } }` on stdin, `SLAVEOFAI_TOOL_RESULTS` pointed inside the temp directory, and `rm(dir, { recursive: true, force: true })` in a `finally` — `preflightGate`'s own isolation discipline, for its reason.

`packages/providers/src/claude/adapter.ts` — three changes, and the second is the whole spike:

1. `ProviderCapabilities` gains `reportsToolResults: boolean`, and `capabilities.ts` sets it `true` on BOTH rows. Cursor's is `true` because its `completed` line IS a measured tool result (`fixtures/cursor/cursor-run.ndjson` line 7) — the table's standing rule is that a capability may only be WIDENED by proof, and that fixture is the proof.
2. `start()`/`resume()` call `preflightTap` when `tapPath` is set, beside the existing `preflightGate`, and pass `toolResultsPath: join(runDir, 'tool-results.ndjson')` to `buildChildEnv`. After the child is spawned, a tailer reads that file line by line and pushes `tool_result` events into the SAME `AsyncEventQueue<RuntimeEvent>` the stream parser feeds (`:335`) — a second producer, invisible to `pump.ts`.
3. **The dedupe, and it is the ruling: the STREAM wins.** `RunState` gains `seenToolResults: Set<string>`; both producers check-and-add the `toolUseId` before pushing, first arrival kept. The tap therefore only ever fills a gap. Torn down with the run in the same place the child's listeners are.

```ts
    /**
     * M51 R6: `toolUseId`s a `tool_result` has already been pushed for, whichever producer got
     * there first.
     *
     * TWO producers feed one queue -- the stream parser and the PostToolUse tap's tailer -- and
     * `pump.ts` must see exactly one result per call. **The stream wins**, not by priority but by
     * arrival: whichever writes the id first owns it, and in practice that is the stream, because
     * the tap's line has to reach the filesystem and be tailed back. The tap is therefore a GAP
     * FILLER, which is what keeps this spike from changing any behaviour that already works.
     *
     * Bounded by the run's own tool-call count, like `hookBindings` in the pump, and dropped with
     * the run.
     */
    readonly seenToolResults: Set<string>
```

- [ ] **Step 12: Run the whole providers suite and watch it pass**

```bash
npx vitest run packages/providers
```
Expected: PASS, and **at least four numbers to record in the task report, because R6's deliverable is the MEASUREMENT**: how many `tool_result` events came from the stream, how many from the tap, how many `toolUseId`s were seen by both, and how many by the tap alone. Take them from a one-off run of the adapter against `fixtures/complete.ndjson` with the tap armed, print them, and put them in the report. **If the tap fills no gap at all, the honest outcome is the erratum saying so and the tap staying unregistered** — `tapPath` is optional precisely so that outcome costs one line in `apps/orchestrator`.

- [ ] **Step 13: Run the whole ladder for this task**

```bash
npx vitest run packages/providers
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: green. `typecheck` failing here would name `apps/orchestrator/src/pump.ts`'s `switch (event.kind)` — the pump has no arm for `tool_result` or `usage` yet. **That is expected and it is Task 4's first job**; if `typecheck` is red for that reason and no other, record it in the report and proceed. (`tsconfig.base` sets `strict` without `noImplicitReturns`, so a `switch` over a widened union is only an error where an exhaustiveness check demands it — check `packages/providers/src/gate.ts:113`'s `classifyGateEvent` first, which DOES exhaust the union and must gain two `default`-side arms here rather than in Task 4.)

- [ ] **Step 14: Commit**

```bash
git add packages/providers scripts/tool-result-tap.sh
git commit -m "$(cat <<'EOF'
feat(providers): m51 t3 — a tool call says which call it was, and a tool result says only whether it worked

`hashToolInput` is a per-STRING cap and never a prefix slice, which is the difference between
telling two Bash commands apart and constraining a working agent for sharing a path preamble. Both
parsers now produce `tool_result`: Claude's `user` line, which this parser has recognised and
ignored since M4, and Cursor's `completed` line, which was folded away for want of a variant -- and
moving the Cursor exhaustiveness allow-list from six kinds to seven is the proof the member is
vendor-neutral rather than a Claude field wearing a neutral name. `parseStreamUsage` is a second
pure function beside `parseStreamLine` rather than a change to its one-line-one-event contract, and
its own test pins the measured fact that per-turn usage is a FLOOR: 27 output tokens against the
result line's 741. The PostToolUse tap writes four fields and never speaks on stdout, and the stream
wins every race by arrival.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

---

### Task 4: Three actors, three packages — control steers and constrains, the orchestrator persists and stops (R1, R2, R3, R5, E4, E5, E6, E7, E8, E9, E10, D14–D18)

**Files:**
- Create: `packages/control/src/breaker.ts`, `packages/control/test/integration/breaker.test.ts`
- Modify: `packages/control/src/{git-probe,refusal,supervisor,supervisorWorld,index}.ts`, `apps/orchestrator/src/{pump,sweep,tick,planning,review,resume,cli}.ts`, `apps/web/test/refusal-status.test.ts`
- Test: `packages/control/test/integration/{breaker,supervisor,supervisorWorld}.test.ts`, `apps/orchestrator/test/integration/{sweep,pump,cli}.test.ts`, `apps/web/test/refusal-status.test.ts`

**Interfaces:**
- Consumes from Tasks 1–3: `detectBehaviour`, `BreakerWindow`, `BreakerRow`, `BreakerVerdict`, `steerTextFor`, every constant, `estimateCostUsd`, the two events, the seven columns, `RuntimeEvent`'s `tool_result`/`usage`/`argsHash`, `ProviderCapabilities.reportsToolResults`.
- Produces, for Tasks 5–6:
  - `steerRun(runId, text, principal?)`, `constrainRun(runId, grace?)`, `deliverBreakerSteer(runId)` — all `Promise<Result<…, ControlRefusal>>`
  - refusal kinds `run_not_steerable`, `breaker_not_armed`
  - `WorktreeProbe`, `realWorktreeProbe`, `SweepDeps.worktreeProbe?`
  - `SweepReport.breakerSteered/breakerConstrained/breakerStopped: readonly RunId[]`
  - `SupervisorWorld.runs`, filled
  - `carryOut`'s `steer_run` arm
  - `SlaveRun.model` written; `tokensIn`/`tokensOut` written mid-run; `run.tool_call` with both new fields; `run.tool_result` rows
  - `breaker --run <id>` CLI verb (read-only)

- [ ] **Step 1: Write the failing tests for the two control verbs and the delivery pass**

`packages/control/test/integration/breaker.test.ts` (the `afterAll` teardown in FK order copied from `packages/control/test/integration/resume-intent.test.ts`, which is this file's nearest relative — it already builds a workspace, a team, a slave, a task and a run, and its pause/resume assertions are what these verbs ride on):

```ts
describe('steerRun (M51 R3, phase A)', () => {
  it('claims the pause and queues the sentence in one call', async () => {
    const run = await workingRun()
    const result = await steerRun(run.id, 'stop and rethink')
    expect(result.ok).toBe(true)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.status).toBe('pause_requested')
    expect(after.pauseReason).toBe('guardrail')
    expect(after.queuedMessage).toBe('stop and rethink')
  })

  it('counts the steer on the run, so STEERS_PER_RUN_MAX survives a de-escalation', async () => {
    const run = await workingRun({ breakerSteers: 1 })
    await steerRun(run.id, 'x')
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).breakerSteers).toBe(2)
  })

  it('refuses a run that is not working, and writes NOTHING when it does', async () => {
    const run = await workingRun({ status: 'paused' })
    const result = await steerRun(run.id, 'x')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('run_not_steerable')
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.queuedMessage).toBeNull()
    expect(after.breakerSteers).toBe(0)
  })

  it('refuses a run that does not exist', async () => {
    expect((await steerRun('nope', 'x')).ok).toBe(false)
  })

  it('is the SYSTEM asking -- the pause event names the breaker, not a person', async () => {
    const run = await workingRun()
    await steerRun(run.id, 'x')
    const [event] = await prisma.executionEvent.findMany({
      where: { runId: run.id, type: 'run_pause_requested' },
      orderBy: { seq: 'desc' },
      take: 1,
    })
    expect(event?.actor).toBe('system')
  })
})

describe('deliverBreakerSteer (M51 R3, phase B -- plan erratum E8)', () => {
  it('asks for the resume once the pump has actually parked the run', async () => {
    const run = await steeredAndParked()
    expect((await deliverBreakerSteer(run.id)).ok).toBe(true)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.resumeRequestedAt).not.toBeNull()
    // The message survives the resume REQUEST -- `requestResume(id, null, ...)` must not erase what
    // phase A queued (`packages/control/src/resume.ts:121-127`). `claimResume` is what consumes it.
    expect(after.queuedMessage).toBe(BREAKER_TEXT)
  })

  it('records the resume as the SYSTEM’s, so it never lands in the web’s interventions filter', async () => {
    const run = await steeredAndParked()
    await deliverBreakerSteer(run.id)
    const [event] = await prisma.executionEvent.findMany({
      where: { runId: run.id, type: 'run_resume_requested' },
      orderBy: { seq: 'desc' },
      take: 1,
    })
    expect(event?.actor).toBe('system')
    expect((event?.payload as { requestedBy: string }).requestedBy).toBe('circuit breaker')
  })

  it('refuses a run the breaker never armed -- a human’s paused run is not the breaker’s to resume', async () => {
    const run = await pausedByAPerson()
    const result = await deliverBreakerSteer(run.id)
    expect(result.ok ? null : (result.error as { kind: string }).kind).toBe('breaker_not_armed')
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).resumeRequestedAt).toBeNull()
  })

  it('is idempotent -- a second call on a run already asked to resume changes nothing', async () => {
    const run = await steeredAndParked()
    await deliverBreakerSteer(run.id)
    const first = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect((await deliverBreakerSteer(run.id)).ok).toBe(false)
    const second = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(second.resumeRequestedAt?.getTime()).toBe(first.resumeRequestedAt?.getTime())
  })
})

describe('constrainRun (M51 R3)', () => {
  it('leaves the run exactly CONSTRAIN_GRACE_CALLS more calls, counted from where it is now', async () => {
    const run = await workingRun({ toolCalls: 140 })
    expect((await constrainRun(run.id)).ok).toBe(true)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.toolCallCap).toBe(140 + CONSTRAIN_GRACE_CALLS)
  })

  it('re-reads the count under the row lock -- a call that landed mid-verb is not refunded', async () => {
    // The cap is relative, so reading `toolCalls` before the lock would let a busy run gain calls
    // between the read and the write. One statement, `toolCalls + 30` computed by Postgres.
    const run = await workingRun({ toolCalls: 10 })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { toolCalls: { increment: 5 } } })
    await constrainRun(run.id)
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).toolCallCap).toBe(
      15 + CONSTRAIN_GRACE_CALLS,
    )
  })

  it('never raises a cap it already wrote -- a second constrain is a no-op, not a refund', async () => {
    const run = await workingRun({ toolCalls: 10 })
    await constrainRun(run.id)
    await prisma.slaveRun.update({ where: { id: run.id }, data: { toolCalls: { increment: 20 } } })
    await constrainRun(run.id)
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).toolCallCap).toBe(
      10 + CONSTRAIN_GRACE_CALLS,
    )
  })

  it('refuses a run that is not working', async () => {
    const run = await workingRun({ status: 'succeeded' })
    expect((await constrainRun(run.id)).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/control/test/integration/breaker.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/breaker.js"`.

- [ ] **Step 3: Add the two refusal kinds, in all three homes**

`packages/control/src/refusal.ts`:

```ts
  /** M51 R3: `steerRun`/`constrainRun` were asked about a run that is not `working`. Steering a
   *  paused, stopping or concluded run would queue a sentence nobody will ever read, and the
   *  ladder would then believe it had spoken. */
  | { readonly kind: 'run_not_steerable'; readonly runId: string; readonly status: string }
  /** M51 R3: `deliverBreakerSteer` was asked to resume a run the breaker never armed -- one the
   *  breaker has not touched, one a person paused, or one whose steer has already been asked for.
   *  A per-tick pass calls this speculatively, so this is an ordinary answer, not a fault. */
  | { readonly kind: 'breaker_not_armed'; readonly runId: string }
```

```ts
    case 'run_not_steerable':
      return `run ${refusal.runId} is ${refusal.status}; only a working run can be steered or constrained`
    case 'breaker_not_armed':
      return `run ${refusal.runId} has no breaker steer waiting to be delivered`
```

`apps/web/test/refusal-status.test.ts`'s `ALL_KINDS` gains both (`Record<ControlRefusal['kind'], true>` is a build error without them), each mapped to the status the neighbouring run refusals use.

- [ ] **Step 4: Write the three verbs**

`packages/control/src/breaker.ts`:

```ts
/**
 * The CONTROL half of the behavioural circuit breaker (M51 R3).
 *
 * Three actors, three packages, and this file is one of them: the Supervisor decides to STEER (a
 * `steer_run` decision, carried out through {@link steerRun}), the system CONSTRAINS
 * ({@link constrainRun}, called by the sweep), and the orchestrator STOPS (the sweep's own
 * claim/cancel shape). Nothing here decides anything -- `detectBehaviour` did that, purely, in
 * `packages/domain`.
 *
 * ## Why a steer is TWO phases (plan erratum E8)
 *
 * `requestPause` claims `pause_requested`, not `paused`: the pause is a cross-process SIGNAL, and
 * the run only reaches `paused` when the gate denies its next tool call and the PUMP observes that
 * deny (`packages/control/src/pause.ts`'s own docstring). `requestResume` refuses anything but
 * `paused`. So a steer cannot be one call:
 *
 *   - {@link steerRun} claims the pause AND queues the sentence, in one conditioned statement.
 *   - {@link deliverBreakerSteer} asks for the resume, on whichever later tick finds the run
 *     actually parked. `apps/orchestrator/src/sweep.ts` calls it once per tick over the runs that
 *     qualify; the tick's existing resume-intent pass then claims `paused -> resuming` and hands
 *     the message to the child, exactly as it does for an operator's own resume.
 *
 * The queued message is the marker, and no column was added for it: a run at a breaker level above
 * `none`, `paused`, with `pauseReason: 'guardrail'` and a `queuedMessage` still sitting on it, is a
 * steer waiting to be delivered and can be nothing else. Nothing else in this tree pauses with a
 * message queued -- `apps/orchestrator/src/tick.ts:253`'s budget fan-out is the only other
 * `'guardrail'` pause and it queues nothing -- and `claimResume` clears the column, so the marker
 * clears itself.
 */
export async function steerRun(runId: string, text: string, principal?: Principal): Promise<Result<void, ControlRefusal>>
```

Body: read the run; `err({ kind: 'run_not_found' })` when absent; `err({ kind: 'run_not_steerable' })` when `status !== 'working'` (**both refusals returned BEFORE any write, so neither has to throw**); then `requestPause(run.id, 'circuit breaker', 'guardrail', principal)` and, on its `ok`, one conditioned `updateMany` writing `queuedMessage: text` and `breakerSteers: { increment: 1 }` where `{ id, status: 'pause_requested', endedAt: null }`. A lost claim is a refusal, not a throw. The pause's own `run.pause_requested` event is already `actor: 'system'` for a non-human `by`, which the test above pins.

```ts
export async function deliverBreakerSteer(runId: string): Promise<Result<void, ControlRefusal>>
```

Body: one `findUnique` selecting the five marker columns; `err({ kind: 'breaker_not_armed' })` unless every clause holds; then `requestResume(runId, null, 'circuit breaker', undefined, 'system')`. **`null` as the message, deliberately** — `requestResume` documents that a resume asked for with no message must not erase what is already queued (`resume.ts:121-127`), and phase A queued exactly the sentence that must be delivered. `'system'` as the actor, for `deliverAnswers`' own reason: nobody pressed anything, and recording it as a human intervention would put it in the web's "interventions" filter under a person who was never there.

```ts
export async function constrainRun(runId: string, grace = CONSTRAIN_GRACE_CALLS): Promise<Result<void, ControlRefusal>>
```

Body: refusals first, as above; then **one raw statement** so the count is read under the row's own lock and a call that lands mid-verb is not refunded:

```sql
UPDATE "SlaveRun" AS r
SET "toolCallCap" = prev."toolCalls" + ${grace}, "breakerLevel" = 'constrained'::"BreakerLevel"
FROM (SELECT id, "toolCalls" FROM "SlaveRun" WHERE id = ${runId} FOR UPDATE) AS prev
WHERE r.id = prev.id AND r."endedAt" IS NULL AND r."toolCallCap" IS NULL
```

`AND r."toolCallCap" IS NULL` is the no-second-refund clause: a run already constrained keeps the cap it was given, so a de-escalation followed by a re-escalation cannot hand a wedged run thirty more calls every minute. `constrainRun` also re-delivers the steer text through the same pause/resume round trip (the caller passes it), by calling `steerRun` FIRST and then this statement — a constrained worker that was never told why would simply hit the ceiling in silence.

- [ ] **Step 5: Add the worktree probe**

`packages/control/src/git-probe.ts` — a SECOND interface beside `GitProbe`, never a third method on it (plan erratum E7):

```ts
/**
 * "Has anything changed in this worktree since last time?" (M51 R1), as an injectable probe.
 *
 * Deliberately NOT a third method on {@link GitProbe}: that interface answers the two questions
 * `createWorkspace` asks a path, it has a live injection seam (`useGitProbe`), and a third REQUIRED
 * method would break every fake that implements it. Two interfaces in one file, sharing the same
 * `git()` helper and the same {@link PROBE_TIMEOUT_MS}, is the honest shape.
 */
export interface WorktreeProbe {
  fingerprint(path: string): Promise<string | null>
}

/**
 * `git status --porcelain` + `git rev-parse HEAD`, hashed.
 *
 * THE EXACT PAIR `apps/orchestrator/src/pump.ts:266-270` already takes when it writes a checkpoint,
 * for the same reason: between them they are the only "did the code change" evidence this system
 * has, and they catch both halves of it -- a commit moves HEAD, an uncommitted edit moves the
 * porcelain.
 *
 * **`null` means "no evidence either way", and a null SUPPRESSES the no-progress arm rather than
 * tripping it.** A probe that timed out, a worktree that was collected, a run with no worktree at
 * all (a planning run): none of those is a worker going in circles, and a breaker that read a
 * failed measurement as a loop would stop healthy runs on a slow disk.
 */
export const realWorktreeProbe: WorktreeProbe = { ... }
```

Implemented with the existing `git()` helper (which already swallows a failure to `null` and carries `PROBE_TIMEOUT_MS`), returning `null` if either half is null and `sha256(head + '\n' + porcelain).digest('hex').slice(0, 32)` otherwise — a fingerprint rather than the porcelain itself, because the porcelain of a big dirty tree is unbounded and the only question asked of it is "is it the same string as last time".

- [ ] **Step 6: Run the control tests and watch them pass**

Run: `npx vitest run packages/control/test/integration/breaker.test.ts`
Expected: PASS — 13 cases.

- [ ] **Step 7: Write the failing tests for the pump's four new writes**

Appended to `apps/orchestrator/test/integration/pump.test.ts`:

```ts
it('records the tool-use id and the args hash on every tool call it writes', async () => {
  await pumpEvents(runId, [
    { kind: 'tool_call', toolUseId: 'toolu_1', toolName: 'Bash', summary: 'Bash npm test', argsHash: HASH_A },
  ])
  const [row] = await eventsOfType(runId, 'run_tool_call')
  expect(row?.payload).toEqual({ name: 'Bash', summary: 'Bash npm test', toolUseId: 'toolu_1', argsHash: HASH_A })
})

it('writes a tool RESULT row carrying four fields and no result text', async () => {
  await pumpEvents(runId, [
    { kind: 'tool_result', toolUseId: 'toolu_1', toolName: 'Bash', outcome: 'error', errorClass: 'timeout' },
  ])
  const [row] = await eventsOfType(runId, 'run_tool_result')
  expect(row?.payload).toEqual({ toolUseId: 'toolu_1', toolName: 'Bash', outcome: 'error', errorClass: 'timeout' })
})

it('names the tool on a result that arrived without one, from the call it answers', async () => {
  // Claude's `tool_result` block carries the id, not the tool. The pump already binds
  // `lastToolUse`; M51 keeps a small id -> name map for the same reason `hookBindings` exists.
  await pumpEvents(runId, [
    { kind: 'tool_call', toolUseId: 'toolu_1', toolName: 'Bash', summary: 's', argsHash: HASH_A },
    { kind: 'tool_result', toolUseId: 'toolu_1', toolName: '', outcome: 'ok', errorClass: null },
  ])
  const [row] = await eventsOfType(runId, 'run_tool_result')
  expect((row?.payload as { toolName: string }).toolName).toBe('Bash')
})

it('writes tokens MID-RUN, while the run is still working', async () => {
  await pumpEvents(runId, [{ kind: 'usage', input: 1000, output: 40 }], { keepOpen: true })
  const row = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
  expect(row.status).toBe('working')
  expect(row.tokensIn).toBe(1000)
  expect(row.tokensOut).toBe(40)
})

it('accumulates usage across turns and lets the terminal figure REPLACE it', async () => {
  await pumpEvents(runId, [
    { kind: 'usage', input: 1000, output: 40 },
    { kind: 'usage', input: 2000, output: 60 },
    { kind: 'terminated', outcome: outcomeWith({ tokens: { input: 9000, output: 741 } }) },
  ])
  const row = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
  // The mid-run figure was a FLOOR (3000/100); the `result` line is what the run was billed.
  expect(row.tokensIn).toBe(9000)
  expect(row.tokensOut).toBe(741)
})

it('does NOT erase the mid-run figure when the result line carried no usage', async () => {
  // Plan erratum E4: `writeStreamUsage` used to write `?? null` unconditionally, which with a
  // mid-run writer in place destroys a real measurement on every degraded result line.
  await pumpEvents(runId, [
    { kind: 'usage', input: 1000, output: 40 },
    { kind: 'terminated', outcome: outcomeWith({ tokens: null }) },
  ])
  const row = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })
  expect(row.tokensIn).toBe(1000)
  expect(row.tokensOut).toBe(40)
})

it('writes a real cumulative ESTIMATE onto the checkpoint at a pause', async () => {
  // The M12 Task 9 R4 ruling is kept intact and is why this is allowed: `cumulativeCostUsd` stays
  // NOT NULL and its only reader is a DISPLAY line -- no sum, no comparison, no guardrail.
  await prisma.slaveRun.update({ where: { id: runId }, data: { model: 'claude-opus-5' } })
  await pumpEvents(runId, [{ kind: 'usage', input: 1_000_000, output: 0 }, ...pauseSequence()])
  const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId } })
  expect(checkpoint.cumulativeCostUsd).toBeCloseTo(5, 6)
  expect(checkpoint.cumulativeTokens).toBe(1_000_000)
})

it('falls back to the reported cost, then to zero, when there is nothing to estimate from', async () => {
  await pumpEvents(runId, pauseSequence())
  const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId } })
  expect(checkpoint.cumulativeCostUsd).toBe(0)
})
```

- [ ] **Step 8: Run them and watch them fail**

Run: `npx vitest run apps/orchestrator/test/integration/pump.test.ts`
Expected: FAIL — the `run.tool_call` payload lacks both new keys, `run_tool_result` returns zero rows, `tokensIn` is null mid-run, and the checkpoint's cumulative cost is 0 where 5 was expected.

- [ ] **Step 9: Teach the pump the four writes**

`apps/orchestrator/src/pump.ts`:

- the `tool_call` arm's emit becomes `await emit('run.tool_call', 'slave', { name: event.toolName, summary: event.summary, toolUseId: event.toolUseId, argsHash: event.argsHash })`, and `toolNames.set(event.toolUseId, event.toolName)` is recorded beside the existing `lastToolUse` assignment — a bounded `Map<string, string>` with the same lifetime and the same bound as `hookBindings` (at most one entry per tool call of this run), whose sole purpose is naming a `tool_result` that arrived without a tool name;
- a new `tool_result` arm, directly after `tool_call`:

```ts
      case 'tool_result': {
        // M51 R1. One row per completed call, and the four fields are the whole of it -- no
        // content, no stdout, no diff. This is what makes "a tool call with no result yet is never
        // a trip" decidable from the log months later, and what makes an api-error storm visible at
        // all.
        //
        // Unconditioned on the run's own status, like `run.output` beside it: a result that arrived
        // is a fact of the stream, and a row already concluded by another writer does not make it
        // untrue.
        await emit('run.tool_result', 'slave', {
          toolUseId: event.toolUseId,
          // The parser names the tool when its line carried one (Cursor's does); Claude's
          // `tool_result` block names only the id, so it is paired back to the call it answers.
          // `'unknown'` and never `''`: the payload's own schema requires a non-empty name, and a
          // result whose call this pump never saw (a resumed run's first result) is still a fact.
          toolName: event.toolName !== '' ? event.toolName : (toolNames.get(event.toolUseId) ?? 'unknown'),
          outcome: event.outcome,
          errorClass: event.errorClass,
        })
        break
      }
```

- a new `usage` arm:

```ts
      case 'usage': {
        // M51 R5: tokens MID-RUN, so a live runaway is visible before it concludes.
        //
        // An ACCUMULATION and explicitly a FLOOR, not a total -- measured on
        // `packages/providers/test/fixtures/complete.ndjson`, the assistant lines' own output
        // tokens sum to 27 against the `result` line's 741, because a streamed message's per-turn
        // usage is not the whole of what the run was billed. `writeStreamUsage` REPLACES both
        // columns with the authoritative figure when a `result` line arrives, which is what makes
        // the floor safe to write.
        //
        // Local accumulation, one write: a resumed run is a SECOND pump on this row and starts its
        // own accumulator at what the row already holds, the way the skills tally does.
        usageIn += event.input
        usageOut += event.output
        await prisma.slaveRun.updateMany({
          where: { id: runId, endedAt: null },
          data: { tokensIn: usageIn, tokensOut: usageOut },
        })
        break
      }
```

- `writeStreamUsage` stops erasing (plan erratum E4):

```ts
  // M51 plan erratum E4: RETURN, do not write nulls. Before the mid-run writer existed, writing
  // `?? null` here was harmless because nothing else had written the columns; now it would destroy
  // a real measurement every time a `result` line came back degraded. A terminal figure REPLACES
  // the floor; the absence of a terminal figure leaves the floor standing.
  if (input.outcome === null || input.outcome.tokens === null) return
  await prisma.slaveRun.updateMany({
    where: { id: input.runId },
    data: { tokensIn: input.outcome.tokens.input, tokensOut: input.outcome.tokens.output },
  })
```

- `writeCheckpoint`'s two `cumulativeCostUsd` lines become, identically in `create` and `update`:

```ts
      // M51 R5. The M12 Task 9 R4 ruling is KEPT, not overturned: `cumulativeCostUsd` stays NOT
      // NULL and `?? 0` stays, because its only reader is `resume.ts` carrying it into the resumed
      // run's checkpoint, and nothing anywhere sums or compares it. What changes is that the figure
      // is no longer always literally zero: `run.costUsd` is still null mid-run, but `tokensIn`/
      // `tokensOut` are now real by the time a pause happens, and a priced model turns them into a
      // number a person can read. Order is the rule the whole milestone runs on -- the ESTIMATE is
      // consulted only because nothing was reported, and it can never overwrite a reported figure,
      // because a run with a reported figure is a run that already concluded.
      cumulativeCostUsd: estimateCostUsd(spawnModel, tokensOf(run)) ?? run.costUsd ?? 0,
      cumulativeTokens: (run.tokensIn ?? 0) + (run.tokensOut ?? 0),
```

with `spawnModel = input.spawn?.model ?? run.model` — the spawn's own model first, because that is the pair this process actually started the child with.

- [ ] **Step 10: Write the failing tests for the sweep's breaker pass**

Appended to `apps/orchestrator/test/integration/sweep.test.ts`:

```ts
describe('the breaker beat (M51 R2)', () => {
  it('does nothing to a healthy run, and stamps the beat so the next tick waits', async () => {
    const run = await liveRun()
    await sweep({ ...deps, worktreeProbe: probeReturning('same') })
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.breakerLevel).toBe('none')
    expect(after.breakerBeatAt).not.toBeNull()
  })

  it('beats at most once per BREAKER_BEAT_MS, so a one-second tick loop cannot climb in three', async () => {
    const run = await loopingRun()
    await sweep(deps)
    await sweep(deps)
    await sweep(deps)
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect(after.breakerLevel).toBe('steered')
    expect(after.breakerTrips).toBe(1)
  })

  it('climbs one rung per beat: steered, then constrained, then stopped', async () => {
    const run = await loopingRun()
    await sweep(deps)
    expect((await reload(run)).breakerLevel).toBe('steered')
    await ageTheBeat(run.id)
    await sweep(deps)
    const constrained = await reload(run)
    expect(constrained.breakerLevel).toBe('constrained')
    expect(constrained.toolCallCap).toBe(constrained.toolCalls + CONSTRAIN_GRACE_CALLS)
    await ageTheBeat(run.id)
    const report = await sweep(deps)
    expect(report.breakerStopped).toEqual([run.id])
    expect((await reload(run)).status).toBe('stopping')
  })

  it('announces each of the two quiet rungs once, and the loud one as a guardrail', async () => {
    const run = await loopingRun()
    await sweep(deps)
    await ageTheBeat(run.id)
    await sweep(deps)
    const breaker = await eventsOfType(run.id, 'run_breaker')
    expect(breaker.map((row) => (row.payload as { level: string }).level)).toEqual(['steered', 'constrained'])
    await ageTheBeat(run.id)
    await sweep(deps)
    // One rung, one name: the STOP rung writes `guardrail.tripped` and no third `run.breaker`.
    expect(await eventsOfType(run.id, 'run_breaker')).toHaveLength(2)
    const [tripped] = await eventsOfType(run.id, 'guardrail_tripped')
    expect((tripped?.payload as { guardrail: string }).guardrail).toBe('behavioural_loop')
  })

  it('writes NO terminal row for a behavioural stop -- the pump concludes it `failed`', async () => {
    // The laundering bug `pump.ts:1039-1049` spells out: a `stopped` row here is
    // `terminal_uncounted`, so the behavioural stop would never reach the failure streak and the
    // two breakers would not compose.
    const run = await stoppedByBreaker()
    expect((await reload(run)).status).toBe('stopping')
    expect((await reload(run)).terminalAt).toBeNull()
  })

  it('steps DOWN one rung on a healthy beat and writes no event at all', async () => {
    const run = await loopingRun()
    await sweep(deps)
    await ageTheBeat(run.id)
    await makeItBehave(run.id)
    await sweep(deps)
    expect((await reload(run)).breakerLevel).toBe('none')
    expect(await eventsOfType(run.id, 'run_breaker')).toHaveLength(1)
  })

  it('honours the run’s OWN cap once one is written, and trips the existing ceiling breach', async () => {
    const run = await liveRun({ toolCalls: 40, toolCallCap: 30 })
    await sweep(deps)
    const [tripped] = await eventsOfType(run.id, 'guardrail_tripped')
    // The existing name, never a new one: the run really is past its tool-call ceiling, and giving
    // the same fact two names is how a filter comes to miss half of it.
    expect((tripped?.payload as { guardrail: string }).guardrail).toBe('tool_call_ceiling')
  })

  it('is checked AFTER the hard limits -- a timed-out looping run is stopped for the timeout', async () => {
    const run = await loopingRun({ startedAt: longAgo })
    const report = await sweep(deps)
    expect(report.timedOut).toEqual([run.id])
    expect(report.breakerStopped).toEqual([])
    expect((await reload(run)).breakerLevel).toBe('none')
  })

  it('never trips while a tool call is still outstanding, however quiet the run is', async () => {
    const run = await quietRunWithOneOutstandingCall()
    await sweep({ ...deps, worktreeProbe: probeReturning('same') })
    await ageTheBeat(run.id)
    await sweep({ ...deps, worktreeProbe: probeReturning('same') })
    await ageTheBeat(run.id)
    await sweep({ ...deps, worktreeProbe: probeReturning('same') })
    expect((await reload(run)).breakerLevel).toBe('none')
  })

  it('treats an UNREADABLE worktree as evidence of nothing, and does not trip on it', async () => {
    const run = await quietRun()
    await sweep({ ...deps, worktreeProbe: probeReturning(null) })
    await ageTheBeat(run.id)
    await sweep({ ...deps, worktreeProbe: probeReturning(null) })
    expect((await reload(run)).breakerLevel).toBe('none')
  })

  it('delivers a steer on the tick that finds the run actually paused', async () => {
    const run = await steeredRun()
    await sweep(deps)
    expect((await reload(run)).resumeRequestedAt).toBeNull()
    await parkIt(run.id)
    await sweep(deps)
    expect((await reload(run)).resumeRequestedAt).not.toBeNull()
  })
})
```

- [ ] **Step 11: Run them and watch them fail**

Run: `npx vitest run apps/orchestrator/test/integration/sweep.test.ts`
Expected: FAIL — `worktreeProbe` is not a `SweepDeps` key and `report.breakerStopped` is undefined.

- [ ] **Step 12: Give the sweep its beat, its ladder and its delivery pass**

`apps/orchestrator/src/sweep.ts`:

- `SweepDeps` gains `readonly worktreeProbe?: WorktreeProbe` (optional, defaulting to `realWorktreeProbe`, so every existing direct caller and test compiles unchanged — the `livePumpRunIds` precedent directly above it);
- `SweepReport` gains three `readonly RunId[]` fields;
- **erratum E6**: the guard at `:410` becomes

```ts
    // M51 R2/E6. The breaker is evaluated here, INSIDE the branch that used to `continue`, which is
    // also exactly what "after the hard limits" means: a run past its timeout or its ceiling is
    // stopped for THAT reason and never reaches the breaker, so one run is never stopped twice
    // under two names. Everything below this line is the hard-limit path, untouched.
    if (!timedOutNow && !overCapNow) {
      const beat = await beatBreaker(deps, run, workspace)
      if (beat !== null) breakerMoves[beat.kind].push(brandRunId(run.id))
      continue
    }
```

- the ceiling check at `:409` becomes `const overCapNow = run.toolCalls > (run.toolCallCap ?? workspace.maxToolCallsPerRun)` — **one comparison and one new column**, and the breach it produces is the existing `tool_call_ceiling`;
- `beatBreaker(deps, run, workspace)` is a new function in this file, and it is the only place the ladder is spelled:

```ts
/**
 * One beat of the behavioural breaker for one run (M51 R2).
 *
 * Returns what it did, or `null` for "nothing, not yet" -- which is the common case by a wide
 * margin: the daemon ticks about once a second and this beats once a minute per run.
 *
 * ## The order, and why each step is where it is
 *
 * 1. **The beat gate.** `breakerBeatAt` within `BREAKER_BEAT_MS` returns immediately, before any
 *    query and before any probe. Without it a tripping run would climb steer -> constrain -> stop
 *    in three seconds, which is a kill with two extra events rather than a ladder.
 * 2. **The window**, one indexed read of this run's last `BREAKER_WINDOW` call/result/output rows.
 * 3. **The worktree clock**, and only now: a subprocess per run per minute is cheap, a subprocess
 *    per run per tick is not. Skipped entirely when no other arm is close -- a run with no repeats
 *    and no errors in its window cannot trip anything but `no_progress`, and `no_progress` needs
 *    two consecutive quiet beats, so the FIRST quiet beat can be recorded without ever spawning
 *    git.
 * 4. **The verdict**, from `detectBehaviour`, which is pure.
 * 5. **The act**, and exactly one of them.
 *
 * ## What is written, in every case
 *
 * `breakerBeatAt` and `breakerQuietBeats` are written on EVERY beat, including the ones that do
 * nothing: the beat clock is what paces the ladder and the quiet count is what debounces it, and a
 * beat that measured and wrote nothing would leave both stale.
 *
 * ## Nothing here may throw
 *
 * This runs inside `sweep()`, inside a tick. Every probe returns `null` on failure, every control
 * refusal is logged and skipped, and a refusal is an ordinary outcome -- the run concluded between
 * the read and the act, which is a race this pass must lose gracefully rather than a fault.
 */
```

with the three acts:

- **steer** — write `breakerLevel: 'steered'`, `breakerTrips: { increment: 1 }`, append `run.breaker`, and stop. **The sweep does NOT call `steerRun`**: the STEER rung is the Supervisor's, and the sweep's job is to raise the level so `observe` can see it (D15). The Supervisor's next pass raises `run_looping`, `carryOut` calls `steerRun`, and `deliverBreakerSteers` finishes the round trip.
- **constrain** — `await constrainRun(run.id)`; on `ok`, append `run.breaker { level: 'constrained' }` and `breakerTrips: { increment: 1 }`. `constrainRun` writes the level itself, under the lock, so the sweep does not write it twice.
- **stop** — the sweep's own claim/cancel shape, VERBATIM from the block below it: `updateMany` to `stopping` conditioned on `SWEEPABLE`, `resolveAdapter(...).cancel` inside its own `try`, then `guardrail.tripped { guardrail: 'behavioural_loop', detail }` — and **no terminal row**, for `run_timeout`'s exact reason (`pump.ts:1039-1049`): the pump concludes it `failed`, `verify.ts:295-360` releases the task to `rework` and charges an attempt, and the existing `circuit_breaker` streak counts it. `breakerLevel` is left at `constrained` on the concluded row, which is the record of how the run ended.

and a new pass called from `sweep()` before the per-run loop:

```ts
/**
 * Deliver whatever steers are waiting (M51 R3, plan erratum E8).
 *
 * A pass of its own rather than part of the per-run loop above, for two reasons the loop makes
 * unavoidable: `paused` is not in `SWEEPABLE`, and the loop skips a run with no pid -- which a
 * paused run never has, because pausing IS killing the child. And on every TICK rather than on the
 * beat: a steer that has been queued should land as soon as the run is actually parked, not up to a
 * minute later.
 *
 * One indexed query over four columns, returning nothing on the overwhelming majority of ticks.
 */
async function deliverBreakerSteers(deps: SweepDeps): Promise<number>
```

`apps/orchestrator/src/tick.ts`, `planning.ts`, `review.ts` — `model: resolved.model ?? null` joins `provider: resolved.provider` in each of the three `slaveRun.update` statements (plan erratum E10), and `apps/orchestrator/src/resume.ts:117` gains `...(checkpoint.model !== null ? { model: checkpoint.model } : {})` beside its existing provider spread.

`apps/orchestrator/src/cli.ts` — one READ-ONLY verb, for a person standing in front of a stuck run:

```
breaker --run <id>     print the run's breaker level, trips, steers, cap and its last trip
```

**No `steer` or `constrain` CLI verb, deliberately** (D18): the ladder is the system's, and a hand-typed rung would be a fourth actor in a design whose whole shape is three. A person who wants to intervene has `pause`, `stop` and the resume message box, all of which already exist.

- [ ] **Step 13: Fill the Supervisor's world and wire `carryOut`**

`packages/control/src/supervisorWorld.ts` — one `findMany` over `SlaveRun` where `status IN NON_TERMINAL_RUN_STATUSES` and `slave.team.workspaceId`, selecting the eleven columns `SupervisorRun` needs; then, **only when some loaded run has `breakerLevel !== 'none'`**, one raw read of the newest `run.breaker` per run, copied line for line from `loadLatestGuardrails` (`:271-285`):

```ts
/** The newest `run.breaker` per run (M51 R3) -- the trip the Supervisor's sentence is built from.
 *  Bounded to the caller's run ids for `loadStatusSince`'s reason, and NOT CALLED AT ALL when every
 *  loaded run is at level `none`, which is every tick of a healthy project. */
async function loadLatestBreakerTrips(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  runIds: readonly string[],
): Promise<ReadonlyMap<string, { trip: string; detail: string; count: number }>> {
  const rows = await tx.$queryRaw<{ runId: string; trip: string | null; detail: string | null; count: number | null }[]>`
    SELECT DISTINCT ON (e."runId") e."runId" AS "runId",
           e.payload->>'trip' AS trip,
           e.payload->>'detail' AS detail,
           (e.payload->>'count')::int AS count
    FROM "ExecutionEvent" e
    WHERE e."workspaceId" = ${workspaceId}
      AND e."runId" = ANY(${[...runIds]}::text[])
      AND e.type::text = 'run.breaker'
    ORDER BY e."runId", e.seq DESC
  `
  return new Map(
    rows.flatMap((row) =>
      row.trip === null || row.detail === null || row.count === null
        ? []
        : [[row.runId, { trip: row.trip, detail: row.detail, count: row.count }] as const],
    ),
  )
}
```

`packages/control/src/supervisor.ts` — `carryOut`'s sixteenth arm, before `escalate_to_human`:

```ts
    case 'steer_run':
      // M51 R3. `tierOf` makes this `applied` on an unhalted project, so this arm runs inside a
      // TICK -- which is why `steerRun` returns a refusal for a run that moved under it rather than
      // throwing, and why that refusal is an ordinary `failed` decision a person can read rather
      // than a crashed pass.
      //
      // `action.text` verbatim: it was built by `candidates.ts` from `steerTextFor(trip)`, a
      // constant with one integer in it, and it is stored on the decision so a reader months later
      // can see what was actually said. Nothing re-derives it here -- re-deriving would mean a row
      // could claim one sentence and the worker receive another.
      return reached(await steerRun(action.runId, action.text, principal))
```

- [ ] **Step 14: Run every suite this task touched**

Strictly one at a time:

```bash
npx vitest run packages/control
npx vitest run apps/orchestrator
```
Expected: PASS — `packages/control`'s new 13 breaker cases plus the extended `supervisorWorld.test.ts` (assert `world.runs` is filled, that a healthy board makes NO breaker-event query, and that a steered run's trip reaches the world) and `supervisor.test.ts` (one `steer_run` carry-out case); `apps/orchestrator`'s 8 new pump cases and 11 new sweep cases. **`gate:m38-supervisor`'s stage-3 shape is not exercised by these suites — Task 6 re-runs the gate itself.**

- [ ] **Step 15: Run the whole ladder for this task**

```bash
npx vitest run packages/control
npx vitest run apps/orchestrator
npx vitest run apps/web/test/refusal-status.test.ts
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: all green. Do NOT run `web:build` here — the only `apps/web` edit is a test file.

- [ ] **Step 16: Commit**

```bash
git add packages/control apps/orchestrator apps/web/test/refusal-status.test.ts
git commit -m "$(cat <<'EOF'
feat(control,orchestrator): m51 t4 — the sweep climbs the ladder, and three packages do three things

The beat is once a minute per run and the ladder moves one rung on it, which is the difference
between a ladder and a kill with two extra events. The sweep raises the LEVEL and the Supervisor
sends the words, because putting a sentence in front of a running worker is the Supervisor's act
even when the sentence is a constant -- and a steer is two phases, because `requestPause` produces
`pause_requested` and `requestResume` will only take `paused`, so the delivery pass runs on whichever
tick finds the run actually parked. The stop is the sweep's own claim/cancel shape verbatim and
writes no terminal row, so the pump concludes it `failed` and the failure streak sees it: the two
breakers compose. The pump now writes what the detector reads, tokens land mid-run as an explicit
floor, and the terminal write stops erasing them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

---

### Task 5: Three cost figures, the retried work, the run card's new word and the guardrail's label (R4, R5, R7, E1, E13, E14, E15, D19–D21)

**Files:**
- Create: `apps/web/src/lib/realMoney.ts`, `apps/web/test/real-money.test.tsx`
- Modify: `apps/web/src/server/{brief,overview,tasks,analytics}.ts`, `apps/web/src/components/project/ProjectBrief.tsx`, `apps/web/src/components/TaskDetailPanel.tsx`, `apps/web/src/components/activity/cards.tsx`, `apps/web/src/components/SlaveCard.tsx`, `apps/web/src/components/OverviewClient.tsx`, `apps/web/src/components/AllSlavesTable.tsx`
- Test: `apps/web/test/{real-money,project-brief,task-detail-panel,activity-cards}.test.tsx`, `apps/web/test/integration/activity-history.test.ts`

**Interfaces:**
- Consumes from Tasks 1–4: `estimateCostUsd`, `costProvenanceOf`, `CostRow`, `RUN_UNMEASURED_CAP_USD`, `GUARDRAIL_LABEL`, `GuardrailKind`, `BreakerLevel`, `USER_CARD_LABEL`, `userRunStatus(status, facts)`, `SlaveRun.{model,tokensIn,tokensOut,breakerLevel}`.
- Produces, for Task 6: `formatUsd`; `ProjectBrief.cost.{actualUsd,estimatedUsd,upperBoundUsd}`; testids `brief-cost-actual`, `brief-cost-estimated`, `brief-cost-upper-bound`, `run-cost-provenance`, `task-cost-retried`; the guardrail card's `data-guardrail` attribute; the run card's `STEERED`/`CONSTRAINED` word.

- [ ] **Step 1: Write the failing test for the real-money formatter and the three brief figures**

`apps/web/test/real-money.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { formatUsd } from '../src/lib/realMoney'

describe('formatUsd', () => {
  it('is two decimal places with a leading dollar', () => {
    expect(formatUsd(3.5)).toBe('$3.50')
    expect(formatUsd(0)).toBe('$0.00')
  })

  it('is an em dash for a figure nobody has, never $0.00', () => {
    // The whole reason this file exists: `.toFixed(2)` on a null yields "$NaN" and `?? 0` yields
    // "$0.00", which is a measurement nobody made -- the lie `SlaveRun.costUsd`'s nullability was
    // introduced to stop (M12 Task 6).
    expect(formatUsd(null)).toBe('—')
  })

  it('says `<$0.01` rather than `$0.00` for a real figure that rounds to nothing', () => {
    expect(formatUsd(0.004)).toBe('<$0.01')
  })
})
```

Appended to `apps/web/test/project-brief.test.tsx`:

```tsx
describe('the cost tile after M51 R7', () => {
  const cost = {
    spentUsd: 4.5,
    measuredUsd: 3.5,
    actualUsd: 3.5,
    estimatedUsd: 6.25,
    upperBoundUsd: 5.5,
    unmeasuredCalls: 1,
    unmeasuredRuns: 1,
    budgetUsd: 25,
  }

  it('is still ONE tile among the eight, and the big figure is still the guardrail’s number', () => {
    render(<ProjectBrief brief={briefWith({ cost })} {...PROPS} />)
    expect(screen.getAllByTestId('brief-fact')).toHaveLength(8)
    expect(screen.getByTestId('brief-tile-cost').textContent).toContain('$4.50 / $25')
  })

  it('labels all three figures, so no number has to be guessed at', () => {
    render(<ProjectBrief brief={briefWith({ cost })} {...PROPS} />)
    expect(screen.getByTestId('brief-cost-actual').textContent).toBe('actual $3.50')
    expect(screen.getByTestId('brief-cost-estimated').textContent).toBe('estimated $6.25')
    expect(screen.getByTestId('brief-cost-upper-bound').textContent).toBe('upper bound $5.50')
  })

  it('keeps both hole sentences exactly as they were', () => {
    render(<ProjectBrief brief={briefWith({ cost })} {...PROPS} />)
    expect(screen.getByTestId('brief-cost-unmeasured-calls').textContent).toBe(
      '1 unmeasured calls charged at $1.00 each',
    )
    expect(screen.getByTestId('brief-cost-unmeasured-runs').textContent).toBe('1 unmeasured runs (not in the total)')
  })

  it('replaces the old `measured` line rather than sitting beside it -- one number, one label', () => {
    render(<ProjectBrief brief={briefWith({ cost })} {...PROPS} />)
    expect(screen.getByTestId('brief-tile-cost').textContent).not.toContain('measured $')
  })

  it('hides the estimate when it is no different from the actual -- a repeated number is noise', () => {
    const same = { ...cost, estimatedUsd: 3.5 }
    render(<ProjectBrief brief={briefWith({ cost: same })} {...PROPS} />)
    expect(screen.queryByTestId('brief-cost-estimated')).toBeNull()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run apps/web/test/real-money.test.tsx apps/web/test/project-brief.test.tsx
```
Expected: FAIL — `Failed to resolve import "../src/lib/realMoney"`, and the three testids are not in the document.

- [ ] **Step 3: Write the formatter and the three figures**

`apps/web/src/lib/realMoney.ts`:

```ts
/**
 * REAL money, formatted once (M51 R5).
 *
 * The sibling of `./money.ts`, whose `formatMinor` is for SIMULATED money and whose own first line
 * says "real model spend is a separate figure". That note has been true and unenforced since M29:
 * every real-money surface in this app does `.toFixed(2)` inline, which is eleven copies of one
 * decision and eleven chances to render a null as `$NaN` or an unmeasured run as `$0.00`.
 *
 * `null` is `—` and never `$0.00`, which is the whole point: a zero is a figure a reader believes,
 * and `SlaveRun.costUsd` was made nullable precisely so "we did not measure this" could be said
 * (`packages/db/prisma/schema.prisma`'s own column comment). `<$0.01` rather than `$0.00` for a real
 * figure that rounds away, for the same reason in the other direction: money that was spent must
 * not print as money that was not.
 */
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  if (value > 0 && value < 0.005) return '<$0.01'
  return `$${value.toFixed(2)}`
}
```

`apps/web/src/server/brief.ts` — the shared read type and three fields:

```ts
  readonly cost: {
    /**
     * THE GUARDRAIL'S NUMBER, unchanged: `workspaceSpend()`'s total. Every other figure on this
     * tile is a different question, and exactly one of them -- this one -- is what
     * `evaluateGuardrails` compares against the budget.
     */
    readonly spentUsd: number
    readonly measuredUsd: number
    /**
     * M51 R5, **Actual**: what a provider actually reported, summed. Identical to `measuredUsd` to
     * the cent -- it IS `runsMeasuredUsd + supervisorMeasuredUsd` -- and it is kept as its own field
     * rather than reusing the old name because the tile now names three figures and a field called
     * `measured` beside `estimated` and `upperBound` reads as a fourth (plan erratum E13: the LINE
     * `measured $X` is replaced, not joined).
     */
    readonly actualUsd: number
    /**
     * M51 R5, **Estimated**: the same total with the price table filling in wherever nothing was
     * reported. Reported runs contribute their reported figure, never their estimate -- the rule
     * `costProvenanceOf` enforces in one place. Equal to `actualUsd` on a project where everything
     * reported, which is when the tile hides the line.
     */
    readonly estimatedUsd: number
    /**
     * M51 R5, **Upper bound**: `spentUsd` plus every concluded unmeasured RUN at
     * `RUN_UNMEASURED_CAP_USD`. A DISPLAY figure and nothing charges it -- see
     * `RUN_UNMEASURED_CAP_USD`'s own docstring for why charging it would move the budget guardrail
     * and `gate:m38-supervisor` stage 3 with it.
     */
    readonly upperBoundUsd: number
    readonly unmeasuredCalls: number
    readonly unmeasuredRuns: number
    readonly budgetUsd: number | null
  }
```

filled from the rows the Overview already hands down:

```ts
    cost: {
      spentUsd: spend.spentUsd,
      measuredUsd: spend.runsMeasuredUsd + spend.supervisorMeasuredUsd,
      actualUsd: spend.runsMeasuredUsd + spend.supervisorMeasuredUsd,
      // Σ over runs of (reported ?? estimated ?? 0), plus the Supervisor's own measured spend and
      // its capped unmeasured calls -- i.e. `spentUsd` with the holes filled in wherever they can
      // be. A run that reported nothing and cannot be priced contributes 0 here and shows up in
      // `unmeasuredRuns` instead, which is the honest split.
      estimatedUsd:
        costRows.reduce((total, row) => total + (row.costUsd ?? estimateCostUsd(row.model, tokensOf(row)) ?? 0), 0) +
        spend.supervisorMeasuredUsd +
        spend.supervisorUnmeasuredCalls * SUPERVISOR_PER_CALL_CAP_USD,
      upperBoundUsd: spend.spentUsd + runSpend.unknownRuns * RUN_UNMEASURED_CAP_USD,
      unmeasuredCalls: spend.supervisorUnmeasuredCalls,
      unmeasuredRuns: runSpend.unknownRuns,
      budgetUsd: workspace.budgetUsd,
    },
```

`ProjectBriefReads.spendRows` is retyped `readonly CostRow[]` (erratum E14) and `apps/web/src/server/overview.ts:483`'s select grows three columns:

```ts
      // M51 R5: `tokensIn`/`tokensOut`/`model` join the three `sumSpend` reads, so the brief's
      // ESTIMATE can be computed from the same rows rather than from a second scan. `sumSpend`
      // itself is untouched and still reads only the three it always did -- a `CostRow` IS a
      // `SpendRow`.
      select: { costUsd: true, provider: true, status: true, tokensIn: true, tokensOut: true, model: true },
```

`apps/web/src/components/project/ProjectBrief.tsx` — the tile, `measured $X` replaced by three:

```tsx
        {/* M51 R5: three answers to three different questions, and the tile says which is which.
          * The big mono figure above is still `spentUsd`, the ONE number the budget guardrail
          * compares -- which is how this stays inside the one-figure rule rather than breaking it:
          * a page showing two totals for one project teaches its reader to trust neither, and a page
          * showing three LABELLED answers to three questions teaches them which to ask. */}
        <span data-testid="brief-cost-actual" className="text-[11px] text-text-2">
          actual {formatUsd(cost.actualUsd)}
        </span>
        {cost.estimatedUsd !== cost.actualUsd && (
          <span data-testid="brief-cost-estimated" className="text-[11px] text-text-2">
            estimated {formatUsd(cost.estimatedUsd)}
          </span>
        )}
        {cost.upperBoundUsd !== cost.spentUsd && (
          <span data-testid="brief-cost-upper-bound" className="text-[11px] text-tone-waiting">
            upper bound {formatUsd(cost.upperBoundUsd)}
          </span>
        )}
```

Both extra lines are CONDITIONAL, which is what keeps the tile's height honest on a healthy project and is also what keeps `gate:m45` stage 1's below-the-fold check comfortable: a project where everything reported shows exactly the lines it showed before M51, with `measured` renamed `actual`.

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run apps/web/test/real-money.test.tsx apps/web/test/project-brief.test.tsx
```
Expected: PASS — 3 formatter cases, 5 tile cases, and every existing `project-brief.test.tsx` case (the eight-fact count is untouched).

- [ ] **Step 5: Write the failing tests for the drawer, the run card and the guardrail label**

Appended to `apps/web/test/task-detail-panel.test.tsx`:

```tsx
describe('the Cost group after M51 R7', () => {
  const runs = [
    run({ id: 'r3', kind: 'implementation', costUsd: null, tokensIn: 1_000_000, tokensOut: 0, model: 'claude-opus-5' }),
    run({ id: 'r2', kind: 'implementation', costUsd: 2, tokensIn: null, tokensOut: null, model: null }),
    run({ id: 'r1', kind: 'implementation', costUsd: 1.5, tokensIn: null, tokensOut: null, model: null }),
  ]

  it('names each run’s provenance beside its figure', () => {
    render(<TaskDetailPanel task={taskWith({ runs })} {...PROPS} />)
    const words = screen.getAllByTestId('run-cost-provenance').map((node) => node.textContent)
    expect(words).toEqual(['estimated', 'reported', 'reported'])
  })

  it('shows a run’s ESTIMATE where nothing was reported, and never overwrites a reported figure', () => {
    render(<TaskDetailPanel task={taskWith({ runs })} {...PROPS} />)
    const figures = screen.getAllByTestId('run-cost-row').map((node) => node.textContent)
    expect(figures[0]).toContain('$5.00')
    expect(figures[1]).toContain('$2.00')
  })

  it('says what the RETRIED work cost -- every implementation run but the newest', () => {
    // `task.runs` is newest-first (`apps/web/src/server/tasks.ts`'s `orderBy: { startedAt: 'desc' }`),
    // so the retried work is everything after index 0. There is no `SlaveRun.attempt` column and
    // M51 adds none: "which attempt" is the run's ordinal among the task's implementation runs,
    // which this panel already lists in order.
    render(<TaskDetailPanel task={taskWith({ runs, attempt: 3 })} {...PROPS} />)
    expect(screen.getByTestId('task-cost-retried').textContent).toBe('retried work $3.50')
  })

  it('says nothing about retried work on a task that has only ever had one run', () => {
    render(<TaskDetailPanel task={taskWith({ runs: [runs[1]!] })} {...PROPS} />)
    expect(screen.queryByTestId('task-cost-retried')).toBeNull()
  })

  it('counts only IMPLEMENTATION runs as retried work -- a review run is not a retry', () => {
    const withReview = [runs[0]!, run({ id: 'rev', kind: 'review', costUsd: 9, model: null }), runs[1]!, runs[2]!]
    render(<TaskDetailPanel task={taskWith({ runs: withReview })} {...PROPS} />)
    expect(screen.getByTestId('task-cost-retried').textContent).toBe('retried work $3.50')
  })
})
```

Appended to `apps/web/test/activity-cards.test.tsx`:

```tsx
  it('prints the guardrail’s LABEL and keeps the key on the element (M51 R4)', () => {
    const Card = ACTIVITY_CARDS['guardrail.tripped']
    const event = { ...fixtureFor('guardrail.tripped'), payload: { guardrail: 'behavioural_loop', detail: 'x' } }
    render(<Card event={event} {...CARD_PROPS} />)
    expect(screen.getByTestId('guardrail-label').textContent).toBe('Going in circles')
    expect(screen.getByTestId('guardrail-label').getAttribute('data-guardrail')).toBe('behavioural_loop')
  })

  it('prints an unknown guardrail as itself rather than crashing -- the log is forgiving', () => {
    const Card = ACTIVITY_CARDS['guardrail.tripped']
    const event = { ...fixtureFor('guardrail.tripped'), payload: { guardrail: 'from_the_future', detail: 'x' } }
    render(<Card event={event} {...CARD_PROPS} />)
    expect(screen.getByTestId('guardrail-label').textContent).toBe('from_the_future')
  })
```

and, in `apps/web/test/integration/activity-history.test.ts:154`, the fixture `{ guardrail: 'budget', detail: 'over budget' }` becomes `{ guardrail: 'budget_exhausted', detail: 'over budget' }` — `budget` was never a spelling any producer wrote, and with `GUARDRAIL_KINDS` in `gate:m44`'s blocklist a fixture that is not a real kind is a fixture whose label lookup falls through to the key.

- [ ] **Step 6: Run them and watch them fail**

```bash
npx vitest run apps/web/test/task-detail-panel.test.tsx apps/web/test/activity-cards.test.tsx
```
Expected: FAIL — `run-cost-provenance` and `task-cost-retried` are not in the document; `guardrail-label` is not a testid (the card renders the raw key inside `Transition`'s `label`).

- [ ] **Step 7: Carry the provenance, the retried work, the card word and the label**

`apps/web/src/server/tasks.ts` — `TaskRunSummary` gains four fields (`kind`, `tokensIn`, `tokensOut`, `model`) and `breakerLevel`; the mapping at `:225` grows five lines. The whole run row is already `include`d, so this is a projection change and nothing more.

`apps/web/src/components/TaskDetailPanel.tsx`:

```tsx
  // M51 R7. THE RULE, in one place: a reported figure wins, always. `costOf` is what the rows and
  // the two totals below all read, so the panel cannot show one run an estimate and count it as a
  // reported figure a line later.
  const costOf = (run: TaskRunSummary): number | null =>
    run.costUsd ?? estimateCostUsd(run.model, run.tokensIn === null || run.tokensOut === null ? null : { input: run.tokensIn, output: run.tokensOut })
  // `retried work` is every IMPLEMENTATION run of this task but its newest -- `task.runs` is
  // newest-first. A review run is not a retry of the implementation, and folding one in would make
  // "what did getting this wrong cost" answer a different question. There is no `SlaveRun.attempt`
  // column and M51 adds none: the ordinal IS the order this list is already in.
  const implRuns = task.runs.filter((run) => run.kind === 'implementation')
  const retriedUsd = implRuns.slice(1).reduce((sum, run) => sum + (costOf(run) ?? 0), 0)
```

```tsx
              <li key={run.id} data-testid="run-cost-row" ...>
                <span className="text-text-3">{run.id.slice(0, 8)}</span>
                <span className="flex items-baseline gap-1.5">
                  <span data-testid="run-cost-provenance" className="text-[9.5px] uppercase text-text-3">
                    {COST_PROVENANCE_WORD[costProvenanceOf(run)]}
                  </span>
                  <span>{formatUsd(costOf(run))}</span>
                </span>
              </li>
```

```tsx
        {implRuns.length > 1 && (
          <p data-testid="task-cost-retried" className="text-xs text-tone-waiting">
            retried work {formatUsd(retriedUsd)}
          </p>
        )}
```

`apps/web/src/components/activity/cards.tsx` — `GuardrailTrippedCard` prints the label and keeps the key (erratum E15; this is the change that makes Task 6's `RAW_TOKENS` addition safe, and without it that addition turns a passing gate red):

```tsx
function GuardrailTrippedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { guardrail: string; detail: string }
  // M51 R4: the LABEL is what a person reads and the KEY is what a machine reads (`docs/ia.md`
  // rule 3). `?? payload.guardrail` is not defensive -- the stored payload is deliberately a
  // forgiving `z.string()` (see `guardrails/kinds.ts`), so a row carrying a spelling this build has
  // never heard of must print as itself rather than as `undefined`.
  const label = GUARDRAIL_LABEL[payload.guardrail as GuardrailKind] ?? payload.guardrail
  return (
    <ActivityCard {...props}>
      <Transition
        tone="warn"
        label={
          <span data-testid="guardrail-label" title={payload.guardrail} data-guardrail={payload.guardrail}>
            {label}
          </span>
        }
      >
        <span data-testid="guardrail-detail">{payload.detail}</span>
      </Transition>
    </ActivityCard>
  )
}
```

*(If `Transition`'s `label` prop is typed `string`, widen it to `ReactNode` — check first with `grep -n "label" apps/web/src/components/activity/Transition.tsx`, and if it is `string`, prefer rendering the chip as the card's first child rather than widening a shared prop for one caller.)*

`apps/web/src/components/SlaveCard.tsx` and `apps/web/src/components/OverviewClient.tsx` — wherever `cardStateForRun(run.status)` is called with a run whose `breakerLevel` is on the DTO, it becomes `cardStateForRun(run.status, { breakerLevel: run.breakerLevel })`. `apps/web/src/server/overview.ts`'s `SlaveCardData` gains `breakerLevel: BreakerLevel` (defaulting to `'none'` for a slave with no live run) and `AllSlavesTable`'s polled row gains it too, so a steered run shows the word within one five-second tick rather than at the next full reload.

`apps/web/src/server/analytics.ts` — the Spend KPI's note gains the bound, beside the count it already carries:

```ts
      // M51 R7: the existing `note` convention, one clause wider. `knownUsd` above is unchanged and
      // is still the measured figure; the bound is named beside it rather than folded into it, for
      // the reason the count is: a total that silently absorbs unmeasured runs presents the measured
      // part of a bill as the whole of it.
      note:
        unknownRuns === 0
          ? null
          : `${unknownRuns} run${unknownRuns === 1 ? '' : 's'} unmeasured — upper bound ` +
            `${formatUsd(knownUsd + unknownRuns * RUN_UNMEASURED_CAP_USD)}`,
```

- [ ] **Step 8: Run them and watch them pass**

```bash
npx vitest run apps/web
```
Expected: PASS — the whole `apps/web` unit/component suite, including `activity-history.test.ts`'s moved fixture.

- [ ] **Step 9: Replace the inline `.toFixed(2)` calls, and prove none is left**

```bash
grep -rn "toFixed(2)" apps/web/src | grep -v "money.ts"
```
Every hit that formats REAL money (the brief tile's big figure, `ProjectHeader`'s budget bar, `OverviewClient`'s strip, `AllSlavesTable`, `graph.ts`, `AnalyticsClient`, `TopStrip`) becomes `formatUsd(...)`. Hits inside `apps/web/src/lib/money.ts` and under `components/sim/` are SIMULATED money and are left exactly alone — that boundary is M29's and this milestone does not touch it. Re-run the grep afterwards and record the remaining hits (they must all be simulated-money ones) in the task report.

- [ ] **Step 10: Run the whole ladder for this task**

```bash
pgrep -af "next dev"     # if one is up, kill it and SAY SO in the report
npx vitest run apps/web
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
npm run web:build
CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
  SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
  npm run gate:m44-ux-foundation
```
Expected: `web:build` green (it is the only thing that catches a bundler-only breakage — tsc and vitest both miss it), and `gate:m44-ux-foundation` green with the SAME token count it printed before this task: `RAW_TOKENS` does not grow until Task 6, and the label fix here is what makes that growth safe.

- [ ] **Step 11: Commit**

```bash
git add apps/web
git commit -m "$(cat <<'EOF'
feat(web): m51 t5 — three figures, three labels, and the only one a guardrail believes says so

The cost tile answers three different questions instead of pretending one number answers all of
them: actual is what somebody reported, estimated fills the holes from a fallback-only price table
that can never overwrite a reported figure, and upper bound is what it would be if every unmeasured
run cost its cap -- a figure shown and never charged, because charging it would let a budget halt
fire on spending nobody measured. The big mono figure is still `workspaceSpend()`'s total, which is
how three answers stay inside the one-figure rule. The drawer names each run's provenance beside its
number and says what the retried work cost. `formatUsd` replaces eleven inline `.toFixed(2)` calls
and turns a null into an em dash rather than a zero somebody would believe. And the guardrail card
prints a sentence with the key on `data-guardrail`, which is what lets the next task put the whole
union in the raw-token blocklist.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

---

### Task 6: `gate:m51-breaker`, its two fixtures, CI, the README, the screenshot — and the full verification ladder (R6, R8, E15, E16, E18, D22–D24)

**Files:**
- Create: `packages/providers/test/fixtures/loop.ndjson`, `packages/providers/test/fixtures/error-storm.ndjson`, `scripts/gate-m51-breaker.mjs`, `docs/superpowers/specs/2026-09-12-m51-breaker-cost-design.md`, `docs/superpowers/plans/2026-09-12-m51-breaker-cost.md`
- Modify: `packages/providers/test/fake-claude.mjs`, `scripts/gate-m44-ux-foundation.mjs`, `package.json`, `.github/workflows/ci.yml`, `README.md`, `docs/superpowers/fidelity/m14/overview.png`
- Test: the gate itself; then the whole suite and every gate this milestone could have moved.

**Interfaces:**
- Consumes from Tasks 1–5: every column, event, verb, testid and label named in those tasks' **Produces** blocks.
- Produces: `npm run gate:m51-breaker`, the 26th CI step, and `--work-fixture` on the fake CLI.

- [ ] **Step 1: Commit the spec and this plan**

Copy the session's `m51-spec.md` verbatim to `docs/superpowers/specs/2026-09-12-m51-breaker-cost-design.md` and append the eighteen errata from this plan's header to its `## 4. Errata` section, in the M49/M50 house format (`**E1 (amends R5)** — …`, one paragraph each, with the file:line evidence from `m51-plan-notes.md`). Copy this plan to `docs/superpowers/plans/2026-09-12-m51-breaker-cost.md`.

```bash
git add docs/superpowers/specs/2026-09-12-m51-breaker-cost-design.md docs/superpowers/plans/2026-09-12-m51-breaker-cost.md
git commit -m "$(cat <<'EOF'
docs(m51): the breaker-and-cost spec and its plan, with the eighteen plan-time errata

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

- [ ] **Step 2: Give the fake CLI a work-fixture knob**

`packages/providers/test/fake-claude.mjs` — `workFixtureName()`, the exact shape of `planFixtureName()` (`:254-258`) and `reviewFixtureName()` (`:269-273`), and one arm in every prompt-sniffing mode's WORK fall-through:

```js
/**
 * M51 (plan erratum E16): which fixture a WORK run replays -- `--work-fixture <name>` from ARGV, or
 * `null` for "do the ordinary work body".
 *
 * `--plan-fixture`/`--review-fixture`'s shape, for their reason: `SLAVEOFAI_CLAUDE_ARGS` rides
 * through as `extraArgs` on every spawn and is the one per-daemon channel a gate can count on.
 *
 * When it IS given, the arm REPLAYS ONLY -- no file written, no commit. That is not an oversight:
 * M51's breaker reads a worktree clock, and the ordinary work body's commit would move it on every
 * single run, which would suppress the very `no_progress` arm the gate exists to measure. A gate
 * that wants both a loop and a commit runs two projects.
 */
function workFixtureName() {
  const index = args.indexOf('--work-fixture')
  const named = index === -1 ? undefined : args[index + 1]
  return named === undefined || named.startsWith('-') ? null : named
}
```

and, at the head of the m8a-flow work body shared by `m8a-flow`/`m8-flow`/`m36-flow`/`m41-flow`:

```js
  const work = workFixtureName()
  if (work !== null) {
    await replayFixture(work)
    process.exit(0)
  }
```

One `fake-claude.test.ts` case is added: `--work-fixture loop` replays `loop.ndjson` and writes no file into the cwd.

- [ ] **Step 3: Write the two fixtures**

Both are SYNTHETIC and both say so in `packages/providers/test/fixtures/README.md`, in the shape that file already uses for `permission-matrix-deny.ndjson`'s provenance section: *"synthetic by necessity — no real capture contains a worker repeating one byte-identical tool call twelve times, because a real worker that did that is the failure this milestone exists to stop. Derived from `complete.ndjson`'s own line shapes (the `system/init` envelope, the `assistant`/`tool_use` block, the `user`/`tool_result` block, the `result` line and the routine `Stop` hook line), with only the repeated payload authored by hand."*

`loop.ndjson`, written by a script so the twelve repeats cannot drift from each other:

```bash
node -e '
const {writeFileSync,readFileSync}=require("node:fs")
const src=readFileSync("packages/providers/test/fixtures/complete.ndjson","utf8").split("\n").filter(Boolean).map(JSON.parse)
const init=src.find(r=>r.type==="system"&&r.subtype==="init")
const stop=src.at(-1)
const SESSION="fake-session-loop"
const INPUT={command:"npm run build --workspace=@fixture/app",description:"build the app"}
const lines=[{...init,session_id:SESSION}]
for(let i=0;i<12;i+=1){
  const id=`toolu_loop_${String(i).padStart(2,"0")}`
  lines.push({type:"assistant",message:{model:"claude-opus-5",content:[{type:"tool_use",id,name:"Bash",input:INPUT}],usage:{input_tokens:2,cache_creation_input_tokens:100,cache_read_input_tokens:900,output_tokens:5}},session_id:SESSION})
  lines.push({type:"user",message:{content:[{tool_use_id:id,type:"tool_result",content:"still failing",is_error:false}]},session_id:SESSION})
}
// The #377 NEGATIVE, in the fixture itself: ONE changed argument, so stage 1 can assert the hash
// moves. Placed AFTER the twelve so the trailing run of identical keys is what the detector reads.
const id13="toolu_loop_12"
lines.push({type:"assistant",message:{model:"claude-opus-5",content:[{type:"tool_use",id:id13,name:"Bash",input:{...INPUT,command:INPUT.command+" --verbose"}}],usage:{input_tokens:2,cache_creation_input_tokens:100,cache_read_input_tokens:900,output_tokens:5}},session_id:SESSION})
lines.push({type:"user",message:{content:[{tool_use_id:id13,type:"tool_result",content:"still failing",is_error:false}]},session_id:SESSION})
lines.push({type:"result",subtype:"success",is_error:false,terminal_reason:"completed",stop_reason:"end_turn",num_turns:13,total_cost_usd:0.42,session_id:SESSION,usage:{input_tokens:26,cache_creation_input_tokens:1300,cache_read_input_tokens:11700,output_tokens:65}})
lines.push({...stop,session_id:SESSION})
writeFileSync("packages/providers/test/fixtures/loop.ndjson",lines.map(r=>JSON.stringify(r)).join("\n")+"\n")
console.log("wrote loop.ndjson",lines.length,"lines")
'
```
Expected: `wrote loop.ndjson 29 lines`.

`error-storm.ndjson` is the same script with six calls whose `tool_result` blocks carry `is_error: true` and `content: "API Error: 529 overloaded"`, six DIFFERENT commands (so it can only ever trip `error_storm`, never `repeated_call` — which is what makes stage 5 an independent measurement rather than a second reading of stage 1), and the same terminal pair.

A third fixture is NOT needed for the negative: stage 6 uses `loop.ndjson` truncated at the first `assistant` line by a gate-side copy, which is a tool call with no result and nothing after it. **Erratum E18**: both new files end with the routine `Stop` hook line, which `packages/providers/test/fake-claude.test.ts:76-96` enumerates and asserts over every `*.ndjson` directly in that directory — run `npx vitest run packages/providers/test/fake-claude.test.ts` immediately after writing them.

- [ ] **Step 4: Write the gate**

`scripts/gate-m51-breaker.mjs`. Borrow the scaffolding file by file from `scripts/gate-m45-project-experience.mjs`, which is this gate's nearest relative (it is the other gate that seeds runs with costs by hand and then photographs a brief): `findFreePort`, `makeRepo`, `preflightCleanup`, `dumpGateRows`, `fail`, `waitUntil`, `waitVisible`, `gotoReliably`, `loopbackChildEnv()`, the real `next dev` on a free port with the ready-wait on next's own bound-port line, the browser preflight refusal, `exitCode` starting at 1, and teardown in FK order inside a `finally`. Daemon first, browser last, for m45's own reason.

Header constants:

```js
const WORKSPACE_NAME = 'M51 Gate Project'
const WORKER_NAME = 'Dev'
const LOOP_TASK_TITLE = 'M51 Gate Looping Task'
const STORM_TASK_TITLE = 'M51 Gate Error Storm Task'
const QUIET_TASK_TITLE = 'M51 Gate Quiet Build Task'
/** `BREAKER_BEAT_MS`. The gate does not wait sixty seconds three times -- it back-dates
 *  `breakerBeatAt` between rungs, exactly as `gate:m50-ephemeral` back-dates a decision to clear a
 *  cooldown, and PRINTS each move so the log says what it did. */
const BEAT_BACKDATE_MS = 2 * 60 * 1000
/** The three cost rows stage 7 seeds, by hand: measured, unmeasured, estimable. */
const MEASURED_USD = 3.5
const ESTIMATE_MODEL = 'claude-opus-5'
const ESTIMATE_TOKENS_IN = 1_000_000
```

Spawn env:

```js
SLAVEOFAI_CLAUDE_BIN=node
SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8-flow --work-fixture loop"
SLAVEOFAI_REQUIRE_FAKE_CLI=1
```

**Nine measuring stages and a teardown, each measuring one thing the milestone claims.**

1. **The evidence is persisted, and the hash discriminates.** The loop task is dispatched, the run works, and the daemon is stopped. Assert: thirteen `run.tool_call` rows, every one carrying a `toolUseId` and a 64-hex `argsHash`; the first TWELVE `argsHash` values are byte-equal to each other; **the thirteenth differs** — the #377 negative, asserted, because a detector keyed on `summary` would have called all thirteen the same call. Assert thirteen `run.tool_result` rows and that **no row's payload contains the string `npm run build`** — the arguments are nowhere in the log.
2. **STEER.** One `run.breaker { level: 'steered', trip: 'repeated_call' }` row; `SlaveRun.breakerLevel = 'steered'`, `breakerTrips = 1`. Then `supervise`: a `SupervisorDecision` with `situationKind: 'run_looping'`, `subjectId` the run id, `tier: 'applied'`, `status: 'applied'`, and an action whose `kind` is `steer_run` and whose `text` is byte-equal to `BREAKER_STEER_TEXT.repeated_call(12)`. Then assert the run is `pause_requested` with `pauseReason: 'guardrail'` and `queuedMessage` byte-equal to that same text; park it (the pump's own deny path, or by hand with a printed note), tick, and assert the `run.resume_requested` row's **`actor` is `system`** and its `payload.requestedBy` is `circuit breaker`.
3. **CONSTRAIN.** Back-date `breakerBeatAt` by `BEAT_BACKDATE_MS` (printed), tick. Assert `breakerLevel = 'constrained'`, `toolCallCap = toolCalls + 30` read from the row itself rather than from a constant the gate re-derives, `breakerTrips = 2`, and a second `run.breaker { level: 'constrained' }`.
4. **STOP.** Back-date again, tick. Assert `guardrail.tripped { guardrail: 'behavioural_loop' }` exists for this run; that there are still exactly TWO `run.breaker` rows (one rung, one name); that the run reaches `failed` — **not `stopped`** — once its pump concludes; that its task is `rework`; and that `Task.attempt` incremented. Print `describeRun` on every failure.
5. **The error storm trips on its own.** A second project, a second daemon, `--work-fixture error-storm`. Assert a `run.breaker { trip: 'error_storm' }` with `count >= 5`, and that its `detail` is not `repeated_call`'s — the six commands differ, so this arm fired by itself.
6. **THE NEGATIVE THAT MATTERS.** A third project whose fixture is one `tool_use` line and then nothing (the fake CLI's `hang` mode with a single tool call written first, or a truncated copy of `loop.ndjson` — whichever the implementer can make deterministic; PRINT which). Run three beats, back-dating between each, with the worktree left untouched. Assert `breakerLevel` is still `none`, `breakerTrips` is 0, and **zero `run.breaker` rows exist** — a quiet twenty-minute build is not a loop, and this is the stage that would catch a detector that forgot the outstanding-call suppression.
7. **Three cost figures on the brief.** Seed three concluded runs by hand on a fourth project: one `costUsd: MEASURED_USD`; one `costUsd: null` with no tokens and no model; one `costUsd: null` with `tokensIn: ESTIMATE_TOKENS_IN`, `tokensOut: 0` and `model: ESTIMATE_MODEL`. **Read `stats.spentUsd` through the real `workspaceStats` BEFORE any M51 column is written and again after, and assert the two are byte-equal** — that is R5's load-bearing claim and the one thing this gate exists to protect. Then, in the browser, assert the cost tile reads `actual $3.50`, `estimated $8.50` and `upper bound $5.50`, and that the big mono figure is still `$3.50 / $<budget>`.
8. **Tokens mid-run.** Back on the loop project, while a run is still `working`, assert `SlaveRun.tokensIn` is non-null and `> 0`. (Stage 1's own run, sampled before it concludes — `waitUntil` on `tokensIn IS NOT NULL AND status = 'working'`.)
9. **In a real browser.** The daemon is stopped and its absence re-checked before `next dev` is spawned. On the activity page: the `guardrail.tripped` card's visible text contains `Going in circles` and **not** `behavioural_loop`, while its `data-guardrail` attribute IS `behavioural_loop`; a `run.breaker` card is present and its `data-breaker-trip` is `repeated_call` while its visible text reads `Same call over and over`. On the project Overview, a run at level `constrained` shows the word `CONSTRAINED` on its card.
10. **Teardown**, in FK order, in a `finally`: `executionEvent`, `supervisorDecision`, `memory`, `runContext`, `checkpoint`, `slaveRun`, `taskDependency`, `task`, `slave`, `team`, `workspace`, then the temp repositories. Scoped by the exact names in the constants above.

Three notes the implementer must not improvise past:

- **The gate never waits out a beat.** Sixty seconds × three rungs × two projects is five minutes of a gate doing nothing, and CI is where that cost lands. Back-dating `breakerBeatAt` is the M50/E12 move (that gate back-dates a decision to clear a cooldown) and every back-date is PRINTED, so the log says what the gate did rather than leaving a reader to infer it.
- **Stage 7 asserts `spentUsd` did not move, and that assertion is the milestone.** If it fails, something reached into `workspaceSpend` or `stats.ts` — neither of which is in any task's file list — and the fix is to take it back out, never to move the assertion.
- **Never edit a file in this repository.** Every fixture is read, never written; the gate's own `git status` after a green run must be empty.

- [ ] **Step 5: Register the gate and run it**

`package.json`, after `gate:m50-ephemeral`:

```json
    "gate:m51-breaker": "tsc --build && node --env-file=.env scripts/gate-m51-breaker.mjs"
```

```bash
pgrep -af "next dev"     # must print nothing
CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
  SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
  npm run gate:m51-breaker
```
Expected: every stage prints its `stage N complete` line and the script exits 0. Then `git status --porcelain` must print nothing.

- [ ] **Step 6: Add the two unions to `gate:m44`'s blocklist and re-run it**

`scripts/gate-m44-ux-foundation.mjs` — `RAW_TOKENS` gains two spreads, with the comment that says what each contributes:

```js
  ...SLAVE_LIFECYCLES,
  // M51 R4: the seventeen guardrail spellings. UNLIKE the three lifecycles above, this line
  // contributes REAL tokens today -- sixteen of the seventeen carry a `_` and survive the filter
  // below (`behavioural_loop`, `budget_exhausted`, `tool_call_ceiling`, ...) -- and one of them was
  // visible text on the activity feed until this milestone, printed raw by `GuardrailTrippedCard`.
  // `GUARDRAIL_LABEL` is what stands between them and a page now.
  ...GUARDRAIL_KINDS,
  // The three breaker levels. Bare English words, so the filter drops all three and this adds
  // nothing today -- the M49/E10 shape: a fourth member a later milestone spells `hard_stopped`
  // joins the blocklist with no edit here, and `BREAKER_LEVEL_LABEL`/`USER_CARD_LABEL` are the real
  // protection.
  ...BREAKER_LEVELS,
```

with both added to the script's `packages/domain/dist` import list. Confirm each line's contribution is what the comment claims:

```bash
node -e "const {GUARDRAIL_KINDS,BREAKER_LEVELS}=require('./packages/domain/dist/index.js');const f=t=>t.includes('_')||t.includes('.');console.log('guardrails contributing:',GUARDRAIL_KINDS.filter(f).length,'of',GUARDRAIL_KINDS.length);console.log('levels contributing:',BREAKER_LEVELS.filter(f))"
```
Expected: `guardrails contributing: 16 of 17` and `levels contributing: []`.

```bash
CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
  SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
  npm run gate:m44-ux-foundation
```
Expected: PASS, with a token count sixteen higher than the one it printed in Task 5. **If it FAILS, a surface is printing a guardrail key** — find it before doing anything else:

```bash
grep -rn "latestGuardrail\|payload.guardrail\|\.guardrail\b" apps/web/src | grep -v "data-guardrail\|GUARDRAIL_LABEL"
```
Every hit that reaches visible text gets the label treatment; a hit that only reaches a `title`, a `data-` attribute or a server-side predicate is correct as it is.

- [ ] **Step 7: CI and the README**

`.github/workflows/ci.yml`, immediately after the `gate:m50-ephemeral` step (`:78`):

```yaml
      - run: npm run gate:m51-breaker
```

`README.md` — the roster sentence (`:828-835`) gains the gate by name after `gate:m50-ephemeral`, the trailing count moves from `25 gates` to `26 gates`, and the paragraph gains one clause in the voice of the `m38`/`m48`/`m50` clauses beside it:

```
and `m51` drives one until a worker repeating the same byte-identical command is told so in the
system's own words, then has its remaining tool budget taken away, then is stopped — with the
thirteenth call, one argument different, hashing differently from the twelve before it, and a run
whose one tool call has simply not come back yet trips nothing at all, because a quiet twenty-minute
build is not a loop.
```

- [ ] **Step 8: Regenerate the one screenshot**

```bash
pgrep -af "next dev"     # must print nothing
CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
  SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
  npm run gate:m14-fidelity
git status --porcelain docs/superpowers/fidelity/m14
```
`gate:m14-fidelity` rewrites all twelve PNGs and several differ run to run (the known m14 nondeterminism in the carried backlog). Only the one this milestone actually changed is kept — the cost tile is on the Overview and the run card word is too, and NO route moved, so the other eleven are untouched:

```bash
git add docs/superpowers/fidelity/m14/overview.png
git checkout -- docs/superpowers/fidelity/m14
git status --porcelain docs/superpowers/fidelity/m14
```
Expected: the last command prints only the one staged file. Open it and confirm by eye that the cost tile reads `actual $…` — a PNG nobody looked at is not evidence.

- [ ] **Step 9: The full verification ladder**

Strictly one vitest at a time, nothing else touching the database:

```bash
npm run --silent typecheck
npx tsc --build
npm run gate:m26-vocabulary
npm test
```
Expected: `npm test` reports **at least 316 test files and at least 4930 tests, all passing**. A lower file count means a test file was deleted; a lower test count means a case was. **If `apps/orchestrator/test/integration/cli.test.ts`'s llm-decision row-count case fails, re-run that file alone before believing it** — it doubles when anything else touches the database, and a pre-push failure there is usually load, not a regression.

Then the gates this milestone could have moved, one at a time, each with `CHROMIUM_PATH`/`SLAVEOFAI_CLAUDE_BIN`/`SLAVEOFAI_REQUIRE_FAKE_CLI` set as above and `pgrep -af "next dev"` empty before each:

```bash
npm run gate:m37-run-context
npm run gate:m38-supervisor
npm run gate:m44-ux-foundation
npm run gate:m45-project-experience
npm run gate:m47-team-formation
npm run gate:m48-runbooks
npm run gate:m49-memory
npm run gate:m50-ephemeral
npm run gate:m51-breaker
```
Expected: all nine green. Three to watch, and what to do rather than edit them:

- **`gate:m38-supervisor` stage 3** asserts `facts.reason === 'budget_exhausted'` precisely so another halt cannot pass that stage. It must pass UNCHANGED. If it does not, `stats.spentUsd` moved, which means something reached into `workspaceSpend` — report it and take the change out.
- **`gate:m45-project-experience` stage 1** measures every brief tile's bottom edge against a 900px fold and asserts the cost tile's text. Its expectations at `:766-767` should not need to move (erratum E13). If the fold check fails, the cost tile grew too tall: make the estimate and upper-bound lines share one line rather than deleting an assertion.
- **`gate:m37-run-context`** asserts a `guardrail_tripped` row by JSON path. Unaffected by the union (the payload is still a string) and re-run to prove it.

- [ ] **Step 10: Commit**

Two commits — the code, then the picture, so a screenshot diff never hides a code change:

```bash
git add scripts packages/providers/test/fixtures packages/providers/test/fake-claude.mjs package.json .github/workflows/ci.yml README.md
git commit -m "$(cat <<'EOF'
test(gate): m51 t6 — twelve identical calls, one different, and a build that is not a loop

`gate:m51-breaker` drives a real daemon and the fake CLI up all three rungs: the twelve repeats hash
identically and the thirteenth, one argument different, does not -- which is the whole of why the
detector reads a hash and not the human summary. The Supervisor's steer is a decision a person can
read months later carrying the exact sentence that was sent, the resume that delivers it is recorded
as the system's so it never appears under a person who was never there, the constrain leaves thirty
calls, and the stop is a `failed` run the existing failure streak counts. Stage 6 is the one that
matters most: a run whose single tool call has not come back trips nothing across three beats. And
stage 7 asserts `stats.spentUsd` is byte-equal on both sides of the milestone, because showing an
upper bound and charging for it are different acts. CI's 26th gate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"

git add docs/superpowers/fidelity/m14/overview.png
git commit -m "$(cat <<'EOF'
chore(fidelity): m51 — regenerate the overview screenshot (three cost figures)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YFp6pQgRhhVm5c1qtDTwos
EOF
)"
```

---

## Self-review

**1. Spec coverage.**

| Spec | Where it lands |
|---|---|
| R1 the detector is a pure function over a PERSISTED per-run stream (`toolUseId` + `argsHash` on `run.tool_call`, `hashToolInput`'s three caps, `run.tool_result`, the vendor-neutral `tool_result` member from BOTH parsers, `detectBehaviour`'s three arms and its outstanding-call suppression, the three progress clocks, the constants) | Task 1 Steps 11–13 (`constants.ts`, `detect.ts`, 30 cases); Task 2 Step 3 (both event arms, the widened `run.tool_call`); Task 3 Steps 3 and 7 (`hashToolInput`, `classifyToolError`, both parsers, the moved Cursor allow-list); Task 4 Steps 5 and 12 (`WorktreeProbe`, `beatBreaker`'s window + clocks) and Step 9 (the pump's two new writes) |
| R2 STEER → CONSTRAIN → STOP, one rung per beat, one healthy beat steps down, action only on ESCALATION, `run.breaker` at nine sites | Task 1 Step 12 (`escalate`/`deEscalate`, and the ladder's six cases); Task 2 Steps 3, 9 and 11 (the event at all nine sites, the enum, seven columns); Task 4 Step 12 (`beatBreaker`, the beat gate, the three acts, the 11 sweep cases) |
| R3 three actors three packages (situation 16, action 16, tier `applied`, the fixed text, `STEERS_PER_RUN_MAX`, `BREAKER_COOLDOWN_MS`, `constrainRun` + the per-run cap, the STOP's claim/cancel with no terminal row, `behavioural_loop`, no `breakerStopEnabled`) | Task 1 Step 11 (`BREAKER_STEER_TEXT`, `steerTextFor`); Task 2 Step 7 (the situation, the action, `tierOf`, `COOLDOWN_BY_KIND`, `SupervisorRun`); Task 4 Steps 4 (the three verbs), 12 (the ladder and the ceiling) and 13 (the loader, `carryOut`). **`Workspace.breakerStopEnabled` appears in no task's file list**, which is how it stays unadded |
| R4 labels never keys for guardrails (`GUARDRAIL_KINDS`/`GUARDRAIL_LABEL`, the breach narrowed, the payload left a string, the card's label + `data-guardrail`, the moved fixture) | Task 1 Steps 1–4; Task 5 Step 7 (the card) and Step 5 (the `activity-history.test.ts` fixture); Task 6 Step 6 (`RAW_TOKENS`, and the grep that proves no other surface leaks) |
| R5 three cost figures, the guardrail's number does not move (`pricing.ts`, `costProvenanceOf`, `SlaveRun.model`, the `usage` member and the mid-run write, the checkpoint's real cumulative, `RUN_UNMEASURED_CAP_USD`, `realMoney.ts`) | Task 1 Steps 5–8; Task 3 Step 7 (`parseStreamUsage`); Task 4 Steps 9 (mid-run tokens, the checkpoint, the E4 fix) and 12 (`model` at the three dispatch sites); Task 5 Steps 3, 7 and 9. **`packages/control/src/{spend,stats}.ts` and `evaluate.ts`'s budget arm are in no file list**, and Task 6 stage 7 asserts the number byte-equal |
| R6 the hook spike, bounded to one measurement (`ClaudeSettings.PostToolUse`, `tapPath`, the tap script, the tailer, the dedupe, `reportsToolResults`, the pre-flight, no transcript reading) | Task 3 Steps 9–12, with Step 12 requiring the FOUR numbers in the task report and naming the honest null outcome. **`~/.claude` appears nowhere in any task** |
| R7 surfaces (the brief's three lines, the drawer's provenance + retried work, the run card word, the Analytics note, the two activity cards, `gate:m44` RAW_TOKENS) | Task 1 Step 16 (`UserCardState`, `UserCardFacts`, `tones.ts`); Task 2 Step 11 (both cards); Task 5 Steps 3, 7 and 9; Task 6 Step 6. **`apps/web/src/components/office/FocusCard.tsx` is in no file list** |
| R8 the gate, README 25→26, CI after m50, the one PNG | Task 6 Steps 2–8, with ten stages enumerated and their assertions named |
| §2 surfaces (every module, column, kind, verb and file listed there) | Each appears in a task's **Interfaces → Produces**: the domain modules, the price table, the provenance rule and the card words in Task 1; the two events, the situation, the action, the world's runs, the enum and the columns in Task 2; the hash, the classifier, both parsers, the capability, the settings, the tap and its pre-flight in Task 3; the three control verbs, the probe, the loader, `carryOut`, the sweep and the pump in Task 4; the six web surfaces and `realMoney.ts` in Task 5; the gate, the fixtures and `--work-fixture` in Task 6 |
| §3 out of scope | No per-workspace threshold (every number is in `breaker/constants.ts`, pinned by a test that says so); no `breakerStopEnabled`; no Cursor hook (`packages/providers/src/cursor/hooks.ts` is in no file list); no transcript reading; `workspaceSpend`/`stats.spentUsd`/the budget arm untouched and asserted so; no token-velocity or floor-wide trip (`detectBehaviour` has exactly three arms and a test that counts them); no `SlaveRun.attempt` (Task 5 Step 5's retried-work case says why in its comment); no permission read (M52) and nothing ranked (M53); the Office FocusCard untouched |

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Five places name the exact file to copy a shape from instead of reprinting it, and each states what it must produce: Task 3 Step 11's `tool-result-tap.sh` (the five test cases ARE the contract, and `scripts/pause-gate.sh` is named as the style source with its three disciplines listed), Task 4 Step 1's `afterAll` teardown (`resume-intent.test.ts` named, FK order spelled out in Task 6 stage 10), Task 4 Step 5's `realWorktreeProbe` (the exact two git commands and the null rule given), Task 6 Step 4's gate script (ten stages with their assertions, the constants given, the borrowed scaffolding named function by function, and three things the implementer may not improvise past), and Task 6 Step 3's second fixture (the first is given as a runnable script and the second is "the same script with six differing commands and `is_error: true`", which is one parameter change). Four steps deliberately end in a CHECK rather than an edit — Task 3 Step 12's tap measurement, Task 5 Step 9's `toFixed` grep, Task 6 Step 6's token-contribution count and its failure grep, Task 6 Step 8's "open the PNG and look" — because each is a fact about the current code that a plan should verify rather than assert. One step (Task 5 Step 7) carries a parenthetical instruction to GREP a shared prop's type before widening it, and says what to do in each case.

**3. Type consistency.** `BreakerLevel`, `BREAKER_LEVELS`, `BreakerTripKind`, `BreakerTrip`, `BreakerRow`, `BreakerWindow`, `BreakerVerdict` and `detectBehaviour` are spelt once (Task 1 Step 12) and consumed under those names in Task 2 (the event enum, `SupervisorRun`, the Prisma enum), Task 4 (`beatBreaker`'s window construction) and Task 5 (`UserCardFacts`, `SlaveCardData`). `BreakerTrip` is `{ kind, count, detail }` at all four sites that build one — the detector, `steerTextFor`, the `run.breaker` payload and `observe`'s facts — and the payload's three keys (`trip`, `count`, `detail`) are the same three, flattened, in the schema (Task 2 Step 3), the card (Task 2 Step 11), the loader's raw read (Task 4 Step 13) and the gate (Task 6 stage 2). `GuardrailKind` is the type of `GuardrailBreach.guardrail` and of `GUARDRAIL_LABEL`'s key, and is NEVER the type of a stored payload — `guardrail.tripped.payload.guardrail` is `z.string()` in the schema and `string` in the card, which is the asymmetry R4 rules and which the card's `?? payload.guardrail` fallback is the visible consequence of. `CostRow` is produced by exactly one query (Task 5 Step 3's widened select) and consumed by `costProvenanceOf` and the brief's `estimatedUsd` reduce; `SpendRow` keeps its three fields and `sumSpend`/`sumSpendFromGroups` keep taking it. `estimateCostUsd(model, tokens)` has the same two parameters at all five call sites — the provenance rule, the brief, the drawer, the checkpoint and Analytics — and every one of them reaches it through a `?? ` whose LEFT side is a reported figure. `ToolErrorClass` is the producer type in `packages/providers` and `string` everywhere downstream (the event payload, the card's `Record<string, string>` label table), which is E17 made visible in the types. `steerRun(runId, text, principal?)` has the same three parameters at its two call sites (`carryOut`, `constrainRun`) and its tests; `deliverBreakerSteer(runId)` has one, at its one caller (the sweep's per-tick pass) and its tests.
