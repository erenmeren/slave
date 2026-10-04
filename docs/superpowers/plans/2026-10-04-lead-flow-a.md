# The lead flow, Plan A of 2: the lead builds, proof gates

> **For workers carrying this out:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project can be put into the lead flow (`set-flow --flow lead`). In it, setting a goal produces one work package and one task for a lead, with no conductor model call for the plan (the requirement extraction call still runs). One lead session builds the whole goal on the goal's work branch, may start subordinate sessions (the tool name `Agent` joins the permission vocabulary, the roster is passed as `--agents`), is bound by the goal's budget and time limit instead of per-run caps, is continued in the SAME session after a daemon restart, a stall, a rework or a provider refusal, and records its decisions in `docs/DECISIONS.md`. There is no per-task review, no ownership audit, no report block, no hand-off and no question to a person. Proof: the smoke check, then an independent verifier; a failure is re-checked by a second independent session (both fail: rework into the lead's session; they disagree: `disputed`, recorded, not reworked); `unverifiable` never stops the goal; a round after rework checks the smoke and what failed before; a full verification always runs on the final commit; the loop stops when everything is proven, the budget or the time is spent, or two rounds in a row fail the same set. Everything proven and automatic merge: merged. Otherwise the version is `awaiting_decision` and one card says what is unproven and why it stopped. A project not in the lead flow behaves exactly as before.

**Architecture:** One additive migration adds the switch (`Workspace.flow`), the goal's time limit and roster, the state word and the lead's progress on `GoalDelivery`, the lead-turn markers on `SlaveRun`, the `lead` decision source and two events. Pure rules live in a new `packages/domain/src/lead/` (state word, budget legs, the proof loop's step function, the brief, the roster definitions, the decisions parser, the stop text). Verbs live in `packages/control/src/lead/` (the switch and its system seats, spend and time of a goal version, the roster loader, the decisions writer, the status view, the card's two decisions). The orchestrator gains `apps/orchestrator/src/lead/` (open, turn, context, conclude, stop, pass, proofRun, base) and branches into it at the named points where the existing pipeline decides: `conduct` (goal set), `startRun` (dispatch), `verifyConcludedRun` (verify-advance), `pumpRun` (the ask hook), `executeResume` (a paused turn's cap), `sweep` (per-run limits), `dispatchVerification` and `concludeVerification` (proof), `applySmokeOutcome` (smoke), `advanceDelivery` and `runGoalPass` (goal pass), `supervise` (which situations reach a person), `workspaceStats` (no workspace halt for budget or streak), and the Supervisor's approve and reject of a `goal_needs_human` card. Every branch is one `if (… flow === 'lead')` (or `run.leadTurn !== null`) that calls into the new directories; nothing else in those functions changes. The Claude adapter learns three things, all absent unless asked for: `--resume <session>` at a first spawn, and `--agents` / `--max-budget-usd` / `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` read from a `spawn-extras.json` beside the run's other files.

**Tech Stack:** TypeScript monorepo (npm workspaces, ESM, `.js` import suffixes outside `apps/web`), Prisma 7 / Postgres, vitest, Next.js (`apps/web`), the fake CLI `packages/providers/test/fake-claude.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-04-lead-flow-design.md` (R-1..R-10, B1..B10, P1..P5, P7, D1, D2 in its smallest form, D3, §9). Map of the code: `.superpowers/notes/code-survey-2026-10-04.md`. **Requires** `feature/lead-flow` cut from main `5e165508`. **Plan B** (written after this plan is built) covers the spec stage S1..S8, quality levels and the hunt P6, the estimate S5, the delivery card's three decisions and the report D2..D5, their interface, and the end-to-end gate. Plan B depends on this plan's `Workspace.flow`, `GoalDelivery.leadState` / `stopReason` / `leadProgress`, `LeadProgress`, `afterRound` / `afterConfirm`, `stopLead`, `setLeadSettings`, `goalSpend`, `leadStatus`, `workspace.lead_state` and `workspace.lead_noted`.

## Decisions this plan makes (read before starting)

Numbered L1 to L18, so that none is mistaken for the spec's own D1 to D5.

- **L1. The switch is one enum column, `Workspace.flow` (`packages` | `lead`), default `packages`.** `setFlow(workspaceId, 'lead')` (CLI `set-flow`) also sets `delivery = conducted` and `autoMerge = true` (spec D1: the lead flow's default is automatic merge; `--auto-merge off` keeps it off), creates the three system seats (L2) and refuses while a goal version is open (a `GoalDelivery` neither merged nor abandoned) or a run is live. Switching back to `packages` is allowed under the same refusals and touches nothing else. A lead-flow workspace is a `conducted` workspace: every existing reader of `delivery` keeps working. *Cost if wrong:* a flow chosen per goal version rather than per project would need the column on `GoalVersion`; the readers all go through `workspace.flow` in eight places, so the move is mechanical.
- **L2. Identities without a team: three system seats, no catalogue persona.** `ensureLeadSeats` makes, once per workspace, a `Team` named `Lead flow` and three `Person` + `Slave` rows with no template: `Lead` (runtime role `implementer`), `Verifier` and `Confirmer` (runtime role `verifier`). Person names are `Lead <first 8 of workspace id>` and so on (`Person.name` is unique across the installation). A seat carries no model and no provider unless `setFlow`'s or `setLeadSettings`' `model` option names one, and then the pair `(model, provider = claude_code)` (C5: no default model; the CLI's own default is used, and `leadRuntime` resolves such a seat to Claude Code with no `--model`). The package row's required `templateId` is the sentinel `LEAD_TEMPLATE_ID = 'lead'` (it is a plain string column, and its two readers tolerate an unknown id). No hiring, no pool, no reviewer seat. Spec P1 holds as built (a fresh detached checkout, the tamper check, a verdict per requirement, no access to the lead's report: `workerLeads` reads `RunReport` rows and the lead files none). The verifier "implemented nothing in the version" (existing rule) because it is a different seat from the lead; the confirmer is a third seat so the report can say who said what. *Cost if wrong:* if the verifier must be a catalogue persona (spec P8, Plan B), `ensureLeadSeats` gains a template id per seat; nothing else reads how the seats were made.
- **L3. The lead's task is the conductor's `single` package, materialised without the size call.** `conduct()` extracts requirements as today, then, for `flow = lead`, calls `openLeadGoal`: `singlePlan(LEAD_TEMPLATE_ID, keys, …)` through the existing `materialise` (exported), with the lead seat pinned and the verifier seat recorded. So the version has its `GoalDelivery`, its integration branch (the goal's work branch), one `WorkPackage` `main` owning `**`, and one task. The `conduct` decision row is recorded `decidedBy: rules`, and `workspace.conducted` carries `fallback: true`, both as the existing rules-made single plan does. *Cost if wrong:* none known; this is the shape the conductor already produces at its retry cap.
- **L4. A lead turn is its own `SlaveRun` row that resumes the previous turn's session.** Every turn (build, rework, wrap-up, continue, answer, base) is an `implementation` run of the lead's task with `SlaveRun.leadTurn` set. Its first spawn passes `--resume <sessionId>` of the task's newest lead run that has a session (`StartRunInput.resumeSessionId`, new), and a short turn note as the prompt; only the first turn, or a turn after a lost transcript, gets the whole brief. This is how B6 (restart, crash), B5 (stall), B7 (provider refusal) and B8 (rework) all continue the same session: the existing paths already put the task back to `rework` (`reconcileOrphans`, `concludeDeadRun`, `verifyConcludedRun`, `concludeVerification`), and the next dispatch resumes instead of starting fresh. A paused lead run (a person's stop) is resumed by the existing `executeResume` on the same row. A resumed turn that fails before its session line (`leadResumed` true, `sessionId` null) is read as "the transcript is gone": no attempt is charged, and the next turn is a new session with a continuation note. Both kinds are recorded (`workspace.lead_noted { kind: 'turn' }`). *Settled by the measurement (M, C2):* a resumed session's `total_cost_usd` is the session's running total, so `goalSpend` takes the largest reported total per session and sums the sessions. *Cost if wrong:* if a later CLI reports per invocation again, spend is under-counted by every earlier turn of a session and the lead overspends its share by them.
- **L5. Nothing replaces review; the lead's turn is integrated by a fast-forward.** A concluded lead turn is handled by `concludeLeadTurn`, never by `advance`: leftover work is committed (`commitUncommittedWork`, no ownership filter), the goal's integration branch is fast-forwarded to the task branch tip (`git update-ref`, compare-and-swap; only the lead writes there, so it is always an ancestor), the task goes `running → done` with `integratedAt`, and the existing goal pass starts the smoke check and the verification. No workspace verify command, no ownership audit, no `<slave-report>`, no review, no merge pass, no hand-off. The product's own smoke script and the verifier are the gate (spec B1, P1, P2). *Cost if wrong:* a project whose verify commands catch what a smoke script does not loses that check in the lead flow; adding `runVerify` back into `concludeLeadTurn` is one call.
- **L6. Limits belong to the goal, and the vendor enforces the budget legs.** A live run's cost is unknown until its result line, so the orchestrator cannot stop a lead at a figure by watching. The lead is spawned with `--max-budget-usd` (new; it counts subordinate sessions, which share the process). The budget of a lead-flow workspace (`Workspace.budgetUsd`) is the goal version's; one fifth is reserved for proof (`PROOF_RESERVE_RATIO`). Leg 1 is capped at 80% of the lead's share less what its earlier turns spent. A leg that ends on the cap (`isBudgetCapReason`: the result's terminal reason is `budget_exhausted`, measured -- C3; `max_budget` is matched too) is not a failure: the next turn is `wrap_up` (the spec's "told to wrap up", delivered between turns by resuming the session, because a `-p` run has no channel into a running turn), capped at the rest of the share. When that leg ends on the cap too, or nothing is left, the lead is ended (`leadProgress.leadEnded = 'budget_spent'`) and proof starts on what is committed. A verification run is capped at whatever the goal has left, reserve included; with nothing left the version stops `budget_spent` and its text says the result is unproven. The workspace-level budget halt and warning do not apply to a lead-flow workspace (`workspaceStats` reports `budgetUsd: null` for it), because a halt would stop the goal pass before it could raise the delivery card. An unbudgeted workspace (`budgetUsd` null) gets no cap and no wrap-up. *Measured (M):* the cap counts from zero per process and ends with `terminal_reason: "budget_exhausted"`. *Cost if wrong:* if `--max-budget-usd` does not count subordinate sessions, the 80% and 100% marks are late.
- **L7. Time is working time of the goal's runs.** `Workspace.goalTimeLimitMs` (null: no limit; 10 minutes to 24 hours, set with `set-lead --time-limit-min`). Time spent is the sum over the version's lead turns and verification runs of `endedAt (or now) − startedAt − pausedMs`. A wait for a provider reset, a halt and daemon downtime are not charged; smoke checks are not counted (bounded by `smokeTimeoutMs`). Past the limit the lead is ended (`time_spent`): a live turn is cancelled, proof runs on what is committed, and no rework turn follows. The per-run timeout, the tool-call ceiling and the behavioural breaker do not apply to a lead turn. *Cost if wrong:* a person who meant wall-clock time sees a goal run past it across a limit wait; the sum is one function (`goalWorkedMs`).
- **L8. "No progress" (B5) is 30 minutes with no line on the lead's stream, tool call open or not.** `LEAD_STALL_MS`. The existing stall rule exempts a run with a tool call open; a lead with a subordinate running always has one open, so that rule could never fire. Subordinate activity arrives on the lead's stream, so a working subordinate keeps it alive. The stalled turn is cancelled through the sweep's existing claim (`run_stalled`), the pump concludes it `failed`, an attempt is charged as for any stall, and the next turn resumes the session with a continuation note. Three such failures in a row end the lead (`lead_failed`) through the task's attempt cap, which is the bound on a session that never recovers. *Cost if wrong:* a single command silent for more than 30 minutes with no subordinate running is restarted. Open point 3.
- **L9. Provider limit (B7) rides the existing platform path.** A turn refused by the provider (`isProviderRefusal`) is `platform`: no attempt, the task waits out `providerBackoffUntil`, and the next turn resumes the session. The circuit breaker cannot halt a lead-flow workspace over it or over anything else (`workspaceStats` reports `consecutiveFailures: 0` for it; the goal's own stop rules take its place, L12). The wait is one `workspace.lead_noted { kind: 'limit_wait' }` line; the Supervisor raises no card (L13). The reset time the provider names is not read. *Cost if wrong:* a subscription limit that the CLI reports as something other than `api_error` is charged as a worker failure and ends the lead after three. Open point 4.
- **L10. The ask protocol is not offered, and an ask is answered at once.** The lead's prompt carries no `ask_protocol` section, and the pump's ask hook is skipped for a lead turn, so a lead is never parked. A turn that ends with a `<slave-ask>` block anyway gets the next turn `answer`: "Nobody answers questions in this flow. Decide it yourself, record the decision and its reason in docs/DECISIONS.md, and continue." At most `LEAD_ASK_REPLIES_MAX = 2` per goal version; after that the block is ignored and proof starts.
- **L11. Proof is a pure step function over `LeadProgress`.** `GoalDelivery.leadProgress` (JSON, validated by `leadProgressSchema`) holds what the loop needs between rounds: the keys the next round checks (`recheckKeys`, empty: the whole set), the failures awaiting confirmation (`confirm`), the last confirmed failing set (`failing`), `disputed`, `unverifiable`, `nextTurn`, `leadEnded`, `wrapUpSent`, `askReplies`, `baseMerges`. `afterRound` and `afterConfirm` (domain) return the next step: `accept`, `confirm`, `verify_again`, `rework` or `stop`. A confirmation run is a `verification` run with `SlaveRun.confirmsRunId` and `verificationKeys` set, taken by the confirmer seat in the same round; a partial round is one with `verificationKeys` set. Every move happens under the existing delivery lock. *Cost if wrong:* JSON is not queryable; the two facts a list page needs (`leadState`, `stopReason`) are real columns.
- **L12. Stop rules (P7), and one stop path.** `proven`: a full round on the current tip with no fail, nothing disputed, nothing unverifiable: accepted through the existing `acceptInLock`. `not_all_proven`: a full round with no confirmed failure but something disputed or unverifiable. `no_progress`: a confirmed failing set equal to the previous round's (the smoke check counts as the set `['SMOKE']`). `budget_spent`, `time_spent`: the lead was ended and something still fails, or no verification can be paid. `nothing_built`: the lead's branch is still at the commit the goal was cut at. `lead_failed`: the lead's task ran out of attempts. `proof_unusable`: the existing cap on unusable verification runs. Every stop but `proven` goes through `stopLead`: the delivery moves to the existing `needs_human` with a text that says what is unproven and why it stopped, `leadState = awaiting_decision`, `stopReason` set. The round cap (`verificationRoundCap`) does not apply to a lead-flow version.
- **L13. One card, by the existing `goal_needs_human` situation, and nothing else while the lead works.** `stopLead` writes `needsHumanReason`; the Supervisor's existing rule raises one `goal_needs_human` card per stop. In a lead-flow workspace the Supervisor pass keeps only `goal_needs_human` and `workspace_halted` situations (`LEAD_SITUATION_KINDS`): no `task_failed`, no `verification_failed`, no stale-wait card. On that card, **Approve means accept as it is**: the version moves `needs_human → accepted` with `verifiedCommit` = the work branch's tip, the lead's unfinished task is cancelled, `stopReason` becomes `accepted_as_is`, and the goal pass merges it as any accepted version. **Reject means leave it**: the existing `abandonGoal` (the branch stays, the next goal version may start), `stopReason = left`. Plan B replaces the pair with the three decisions of spec D2. `retry-goal` still works and verifies again; with the lead ended it can only confirm the same stop. *Cost if wrong:* an Approve that a person meant as "seen" merges unproven work; the card's text says in its last sentence what each button does.
- **L14. The state word is derived and stored.** `leadStateOf(status, merged, everyPackageIntegrated, autoMerge, mergeError)`: `abandoned → stopped`; merged → `delivered`; `needs_human → awaiting_decision`; `accepted` with automatic merge on and no merge error → `proving` (merging on the next pass), otherwise `awaiting_decision` (a person merges by hand, as today); `verifying`, or `integrating` with the task integrated → `proving`; else `building`. `syncLeadStates` runs at the end of every goal pass, writes `GoalDelivery.leadState` when it changed and appends `workspace.lead_state`. `spec` and `hunting` arrive with Plan B.
- **L15. Base moved (spec D3).** Before the final merge of an accepted lead version, if the base branch moved since the cut, Slave merges it into the lead's branch in the lead's worktree. Clean: the work branch is fast-forwarded, `baseCommit` moves to the new base tip, and the existing `reopenIfMovedInLock` sends the version round again for a full verification. Conflict: the merge is aborted, the lead's task goes back to `rework` with the turn `base`, and the same reopening follows its commit. At most `LEAD_BASE_MERGES_MAX = 3` per version; past that the existing "base moved, merge by hand" wait stands. The spec names only the conflicting case; the clean case is merged without a lead turn because a merged tree nobody verified must be verified either way.
- **L16. The roster is person ids on the workspace, passed as `--agents`.** `Workspace.leadRoster` (at most 15 ids, `set-lead --roster a,b,c`; Plan B's spec stage fills it). Each member becomes one session definition: key = a slug of the person's name, `description` = the persona's one line, `prompt` = the person's effective profile followed by their skills' instructions, each bounded at 6 000 characters, the whole JSON at 100 000 bytes (one argv string; members that do not fit are dropped from the end and noted). Empty roster: no `--agents`. Which member a subordinate call used is recorded on the call's own event: `run.tool_call` gains the optional `subagent` (the tool input's `subagent_type`, on a top-level call only -- C1) and `parentToolUseId`, and `leadStatus` maps `subagent` back to the person through the same slug. *Cost if wrong:* a long persona is cut at 6 000 characters; `.claude/agents/` files in the worktree would lift the bound and are the fallback.
- **L17. The tool vocabulary is data; the hook plane does not change.** `scripts/lib/permissions.sh` reads the allowed tool names from the run's `permissions.json`, which `writePermissionsFile` writes from `CLAUDE_CODE_TOOLS` (`packages/domain/src/provider/claude-code.ts`). Adding the name `Agent` there (beside `Task`, under `run_commands`) is the whole change: the five hook-plane scripts stay byte-identical and their digests in `hook-plane-sha256.json` stand. It changes what every Claude run kind with `run_commands` may call, in both flows: today the installed CLI's subordinate tool is denied `ungoverned_tool` in every run, where the same tool under its old name was allowed. The nine goldens that carry the vocabulary are re-pinned in the same commit, the m56a count goes 38 → 39, and the vocabulary gate (`gate-m26`) learns the quoted tool name as a protected token.
- **L18. Decisions on record (B9).** At every concluded lead turn, `docs/DECISIONS.md` at the turn's tip is read (`git show`), bounded at 200 000 bytes, split at `## ` headings, and each one written through the existing `writeGoalDecisionIn` with source `lead` (sanitised, bounded at 80 / 600 characters, at most 40 per version, a title the version already has is skipped). A missing or unreadable file is one `workspace.lead_noted { kind: 'decisions_missing' }` and stops nothing.
- **Left out on purpose (Plan B):** the spec stage and `docs/spec.md`, moving requirement extraction out of the conductor, quality levels and the hunt, estimate records, the three card decisions and "add budget and continue", the report page, any new interface, the end-to-end gate script, verifier personas from the catalogue (P8), the lead's model as a project setting beyond `set-flow --model`, a subordinate model setting.

## Controller answers (C1 to C9) and the measurement

The open points at the end of this plan were answered by the controller on 2026-10-04, after one measured pair of paid calls. **Provenance:** the operator's own patched copy of this plan was not reachable from the cloud session that built it, so the answers below were rewritten there from the build prompt's account of them (the measurement, C1, C5 as the "no `--model` by default" test, C6, C7); C4, C8 and C9 had no account and are the builder's rulings, marked so. Where an answer and the text of a task differ, the answer wins; every task below has been brought in line with it.

- **M. The measurement (open points 1 and 2).** (a) A `claude -p --resume <session>` process reports in its result line's `total_cost_usd` the SESSION's running total -- every earlier invocation of that session included -- not what that process spent. (b) `--max-budget-usd` counts from zero in every process, whatever the session spent before it. (c) A process stopped by that cap ends with `terminal_reason: "budget_exhausted"`.
- **C1. Subordinate lines on the lead's stream (open point 3).** A subordinate's own lines arrive on the lead's stream with `parent_tool_use_id` set to the id of the subordinate call that started it, so the stall rule (L8) stands as written. The parser carries that field on a `tool_call` as `parentToolUseId` (absent when null), and the pump writes it on `run.tool_call`. `subagent` is recorded on a TOP-LEVEL subordinate call only (`parent_tool_use_id` null): a subordinate that starts a session of its own did not pick from the roster, and `leadStatus` counts top-level calls only.
- **C2. A turn's cost (open point 1, from M(a)).** `SlaveRun.costUsd` of a lead turn is the session's total at that turn's end, as the CLI reports it (the pump's replace stays right). What the lead spent is therefore, per session, the LARGEST reported total of that session's turns, summed over its sessions (a new session after a lost transcript is a second session); `goalSpend.leadUsd` is that sum. A turn that ended with no cost (cancelled, crashed) is unmeasured only until a later turn of the same session reports: that total includes it. `unmeasuredRuns` counts only runs no later total covers.
- **C3. The budget legs (open point 2, from M(b) and M(c)).** Because every process counts from zero, a leg's `--max-budget-usd` is what that ONE turn may spend from now -- the mark (or the share) less what the lead has spent -- which is the formula `nextLeadLeg` already has; a resumed paused turn needs `refreshLeadSpawn` (Task 7) for the same reason. `isBudgetCapReason` matches `budget_exhausted` (and still `max_budget`, the result line's older subtype spelling). A capped turn's reported total is the session's, so test fixtures for a second capped turn report the running total (19.20 then 24.00), not the leg alone. That the cap counts subordinate sessions is taken on the 2026-10-04 run's word (`modelUsage` carries every model's cost).
- **C4. A subscription limit's shape (open point 4) -- builder's ruling.** Unchanged: `isProviderRefusal` is the test, and a limit the CLI reports otherwise is charged as a worker failure. Measured when it first happens; the reset time is not read.
- **C5. The default model (open point 5).** No default: the system seats carry no model unless `set-flow --model` / `set-lead --model` names one, and a run of the lead, the verifier or the confirmer is spawned with NO `--model` flag -- the installed CLI's own default is "the most capable available" as the operator configured it. `LEAD_DEFAULT_MODEL` is not added. A seat with no model resolves its runtime by `leadRuntime` (Task 6), not through the workspace-default chain, so a second provider row on the workspace cannot refuse the lead.
- **C6. A permission-mode denial (open point 7).** A lead turn that the pump failed only because tool calls were refused by the permission mode is not charged an attempt: the lead continues in the SAME session (`continue`), and its turn note names the refused calls and tells it to do the work another way. At most `LEAD_DENIAL_CONTINUES_MAX` per version; past that such a turn is charged as any failure. Each is one `workspace.lead_noted { kind: 'denied' }` line.
- **C7. An unknown part of the spend (open point 9).** Wherever a figure of spend is written for a person or the lead while part of it is unmeasured (`unmeasuredRuns > 0`), it reads "at least $X".
- **C8. The web (open point 6) -- builder's ruling.** Not granted in plan A: the spec does not ask for it, and a grant is one `SlavePermission` row in `ensureLeadSeats` when it does.
- **C9. `retry-goal` on a stopped version and the sentinel template id (open points 8 and 10) -- builder's ruling.** As written: the card names only Approve and Reject; the readers of `WorkPackage.templateId` tolerate `lead`, and Task 11 runs `loadGoalReport` on a lead-flow version to prove it.

## Global Constraints

- Vocabulary: the product says "slave", never the old word (`node scripts/gate-m26-vocabulary.mjs`). The Claude tool is named only as a quoted or backticked literal (`'Agent'`, `` `Agent` ``), which Task 3 makes a protected token; `--agents` is protected already; `subagent` passes the gate's pattern. Never write the external persona catalogue's repository name anywhere tracked.
- Never run prettier. The repository has no prettier config. Match surrounding code: WHY doc comments, `readonly`, explicit return types, `.js` import suffixes (not in `apps/web`), `Result` / `ok` / `err`. `packages/control` does not depend on zod: validate with the domain's exported schemas.
- Tests: `set -a; . ./.env; set +a; export DATABASE_URL=$TEST_DATABASE_URL` in the shell first; the export also governs any scratch Prisma script. Run ONE vitest process at a time, and stop any daemon first. Iterate per file. Run `npx tsc --build` after changing a package another package's test imports. Run `npm run typecheck` before every commit (it also checks every `tsconfig.test.json` and `apps/web`). Run the whole suite once, at the end, in the background.
- Migrations: hand-written, purely additive, WHY header, dated name; `npm run db:generate && npm run db:migrate:test`. The schema must mirror the SQL exactly. The drift check is `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` with `DATABASE_URL` exported to the test DB (Prisma 7 has no `--from-url`); it prints `No difference detected`.
- `apps/web` changes gate on `npm run web:build`, with no `next dev` running, then `rm -rf apps/web/.next`. Tasks 1 and 5 change `apps/web`.
- Never touch the dev DB. Never `db:seed`. Gates run only on `DATABASE_URL="$GATE_DATABASE_URL"`, with the fake-CLI env exactly as `.github/workflows/ci.yml` sets it (`SLAVEOFAI_CLAUDE_BIN` / `SLAVEOFAI_CURSOR_BIN` from `scripts/gate-fakes`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`), the host daemon stopped, under `systemd-inhibit --what=sleep:idle`. Gates that read a page need `CHROMIUM_PATH=/home/meren/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`. Red on main today, not regressions: m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58.
- Inside a Prisma interactive transaction a refusal must THROW to roll back; a returned value commits what was written. A refusal returned before the first write is safe, and each such site says so.
- `vi.spyOn` on a Prisma delegate breaks later tests: assign a wrapper and restore it in `finally`.
- Never `TRUNCATE "SlaveTemplate" CASCADE` in a test; delete your own template rows by id.
- The hook plane (`scripts/pause-gate.sh`, `scripts/cursor-shell-gate.sh`, `scripts/tool-result-tap.sh`, `scripts/lib/pause-flag.sh`, `scripts/lib/permissions.sh`) does not change.
- Counts: this plan adds two event types (`LANE_BY_TYPE` 78 → 80) and no situation or action kind (25 / 25). Every place that pins the event list is updated in Task 1: `packages/db/prisma/schema.prisma` (`enum EventType`), the migration, `packages/db/src/enums.ts`, `packages/domain/src/events/schema.ts`, `packages/domain/src/supervisor/timeline.ts`, `apps/web/src/components/activity/cards.tsx` (registry), `apps/web/src/lib/activityFilters.ts`, `apps/web/src/server/timeline.ts`, `packages/domain/test/supervisor/timeline.test.ts`, `apps/web/test/activity-cards.test.tsx` (`PAYLOAD_BY_TYPE`), `apps/web/test/activityFilters.test.ts`, `scripts/gate-m56a-provider-contract.mjs` stage 12.
- A project not in the lead flow is unchanged. Every branch this plan adds is guarded by `workspace.flow === 'lead'` or `run.leadTurn !== null`, both false or null on every existing row. Each task's "Unchanged for `packages`" line says what protects it; Task 11 pins it with a test in which the old pipeline's review still runs.
- Every commit message ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec B4 verbatim: "The per-run limits (200 tool calls, 30 minutes) do not apply to the lead. A goal version has a budget (the sum of lead, subordinates, verifier, hunter) and a time limit. One fifth of the budget is reserved for proof and hunt; the lead is told its share. At 80% of its share it is told to wrap up (commit, write the report); at 100% it is stopped and proof starts on what is committed."
- Spec P3 verbatim: "Before a failed requirement goes back to the lead, a second independent session re-checks only the failed ones. Both say fail: rework. They disagree: the requirement is `disputed`, it is not sent to rework, and the report says so."
- Spec P5 verbatim: "A round after rework checks the smoke and what failed before. Before delivery a full verification always runs on the final commit; the reserved budget always covers it."
- Spec P7 verbatim: "Everything proven and no open defect above the threshold; or the budget or the time is spent; or two rounds in a row leave the same items failing."
- Spec §3 verbatim: "No card is raised while the lead builds."

## Review Focus

- A daemon restart while the lead is mid-build. The orphaned turn is failed `platform`, the task's attempt count does not move, and the next turn is spawned with `--resume` of the same session id and a continuation note, not the brief (Task 7 test "resumes the same session after an orphaned turn and charges no attempt").
- The lead's budget share reaches 100% while a subordinate is mid-work. The turn ends on the vendor's cap with nothing reported by the subordinate; it is not charged an attempt, the lead is ended `budget_spent`, what is committed is integrated, and proof starts (Task 8 test "ends the lead at 100% of its share and proves what is committed, with a subordinate still at work").
- A verification failure that the confirmer does not confirm. The key becomes `disputed`, no rework turn is started, the lead's task stays `done`, and the version ends `awaiting_decision` / `not_all_proven` with the key named in the card's text (Task 9 tests: "marks what the confirmer does not fail as disputed and does not rework it" in the domain, "does not rework a failure the confirmer does not confirm" through the tick).
- Two rounds in a row with the same failing set. The second confirmed failure of `{R1}` stops the version `no_progress` instead of starting a third rework turn, and exactly one `goal_needs_human` card exists (Task 9 test "stops after two rounds that fail the same set, with one card").
- A project NOT in the lead flow. With the same seed and no `set-flow`, the package task goes to `reviewing`, a review run is dispatched, no run carries `leadTurn`, and the spawned argv has no `--agents`, `--max-budget-usd` or `--resume` (Task 11 test "the packages flow still reviews", in `conductor-e2e.test.ts`).

---

## File Structure

**Created**

| File | Responsibility |
|---|---|
| `packages/db/prisma/migrations/20261004090000_lead_flow/migration.sql` | the additive migration |
| `packages/domain/src/lead/constants.ts` | the closed lists and bounds (leaf module, no imports) |
| `packages/domain/src/lead/progress.ts` | `LeadProgress`, its schema, `readLeadProgress` |
| `packages/domain/src/lead/state.ts` | `leadStateOf` |
| `packages/domain/src/lead/budget.ts` | `leadShareUsd`, `nextLeadLeg`, `proofCapUsd`, `isBudgetCapReason` |
| `packages/domain/src/lead/proof.ts` | `afterRound`, `afterConfirm`, `afterCheckFailure` |
| `packages/domain/src/lead/brief.ts` | `renderLeadBrief`, `LEAD_RULES`, `renderLeadTurnNote`, `renderLeadContinuation` |
| `packages/domain/src/lead/roster.ts` | `rosterSlug`, `buildRosterDefinitions` |
| `packages/domain/src/lead/decisions.ts` | `parseLeadDecisions` |
| `packages/domain/src/lead/stop.ts` | `renderLeadStop` |
| `packages/domain/src/lead/index.ts` | re-exports |
| `packages/control/src/lead/flow.ts` | `setFlow`, `ensureLeadSeats`, `setLeadSettings` |
| `packages/control/src/lead/spend.ts` | `goalSpend`, `goalWorkedMs` |
| `packages/control/src/lead/roster.ts` | `loadLeadRoster` |
| `packages/control/src/lead/decisions.ts` | `recordLeadDecisions` |
| `packages/control/src/lead/status.ts` | `leadStatus` |
| `packages/control/src/lead/card.ts` | `acceptLeadGoalAsIs`, `leaveLeadGoal` |
| `apps/orchestrator/src/lead/open.ts` | `openLeadGoal` (goal set) |
| `apps/orchestrator/src/lead/turn.ts` | `planLeadTurn`, `noteLeadTurnStarted`, `refreshLeadSpawn` (dispatch) |
| `apps/orchestrator/src/lead/context.ts` | `buildLeadContext` (the prompt, recorded) |
| `apps/orchestrator/src/lead/conclude.ts` | `concludeLeadTurn`, `settleLeadWork` (verify-advance) |
| `apps/orchestrator/src/lead/record.ts` | `noteLead`, `noteLeadOnce`, `updateLeadProgress`, `endLead`, `progressJson` |
| `apps/orchestrator/src/lead/stop.ts` | `stopLead`, `stopLeadInLock` (the one stop path) |
| `apps/orchestrator/src/lead/pass.ts` | `syncLeadStates`, `enforceLeadLimits` (goal pass) |
| `apps/orchestrator/src/lead/proofRun.ts` | `leadProofScope`, `concludeLeadVerification` (proof) |
| `apps/orchestrator/src/lead/base.ts` | `leadTakeBaseIn` (spec D3) |
| `apps/orchestrator/test/integration/lead-helpers.ts` | the lead-flow seed and routing adapter every lead integration test shares |
| tests | `packages/domain/test/lead/{state,events,roster,budget,brief,stop,decisions,proof}.test.ts`, `packages/control/test/integration/lead-flow.test.ts`, `lead-spend.test.ts`, `lead-card.test.ts`, `packages/providers/test/adapter-lead.test.ts`, `apps/orchestrator/test/lead-situations.test.ts`, `apps/orchestrator/test/integration/lead-context.test.ts`, `lead-open.test.ts`, `lead-turn.test.ts`, `lead-limits.test.ts`, `lead-proof.test.ts`, `lead-delivery.test.ts`, `lead-e2e.test.ts` |

**Modified** (one named branch or one additive field each)

| File | Change |
|---|---|
| `packages/db/prisma/schema.prisma`, `packages/db/src/enums.ts` | the columns, enums and two event types |
| `packages/domain/src/index.ts` | `export * from './lead/index.js'` |
| `packages/domain/src/events/schema.ts` | two variants; `run.tool_call.subagent` |
| `packages/domain/src/supervisor/timeline.ts` | two lanes |
| `packages/domain/src/goalReport/types.ts`, `goalReport/caveats.ts`, `supervisor/world.ts` | the `lead` decision source |
| `packages/domain/src/provider/claude-code.ts` | the tool name `Agent` |
| `packages/domain/src/run-context/sections.ts`, `render.ts` | the `lead` manifest kind, the `lead_brief` section, the `LEAD_RULES` trailer |
| `packages/control/src/index.ts`, `refusal.ts` | exports; three refusal kinds |
| `packages/control/src/stats.ts` | no workspace budget halt and no circuit breaker for a lead-flow workspace |
| `packages/control/src/conductorAnswer.ts` | `writeGoalDecisionIn` accepts the source `lead` |
| `packages/control/src/supervisor.ts` | Approve / Reject on a lead version's `goal_needs_human` card |
| `packages/providers/src/contract/adapter.ts`, `claude/adapter.ts`, `claude/stream.ts`, `runtime/process.ts`, `types.ts` | `resumeSessionId`; `spawn-extras.json`; `tool_call.subagent` |
| `packages/providers/test/fake-claude.mjs` | eight knobs on the `m8-flow` work arm, each a no-op without its flag |
| `apps/orchestrator/src/conductor.ts` | branch: goal set; `materialise` and `AlreadyConducted` exported |
| `apps/orchestrator/src/tick.ts` | branch: dispatch |
| `apps/orchestrator/src/verify.ts` | branch: verify-advance |
| `apps/orchestrator/src/pump.ts` | branch: the ask hook; `subagent` passed through |
| `apps/orchestrator/src/sweep.ts` | branch: per-run limits |
| `apps/orchestrator/src/verification.ts` | branches: proof dispatch and conclusion; three helpers exported |
| `apps/orchestrator/src/smoke.ts` | branch: smoke conclusion |
| `apps/orchestrator/src/goal.ts` | branch: goal pass |
| `apps/orchestrator/src/supervisor.ts` | the lead-flow situation filter |
| `apps/orchestrator/src/resume.ts` | a resumed lead turn refreshes its budget cap |
| `apps/orchestrator/src/cli.ts` | `set-flow`, `set-lead`, `lead-status` |
| `apps/web/src/components/activity/cards.tsx`, `lib/activityFilters.ts`, `lib/runContextSummary.ts`, `server/timeline.ts` | two cards, one chip list, one summary line, two titles |
| `scripts/gate-m26-vocabulary.mjs`, `scripts/rename-agent-to-slave.mjs` | the protected tool-name token |
| `scripts/gate-m56a-provider-contract.mjs`, `scripts/fixtures/m56a-goldens/*` | 78 → 80, 38 → 39, nine goldens re-pinned |

---
### Task 1: The migration, the switch column, the domain rules and the two events

**Files:**
- Create: `packages/db/prisma/migrations/20261004090000_lead_flow/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (`model Workspace`, after `questionTimeoutMs`; `model GoalDelivery`, after `reportNotedKey`; `model SlaveRun`, after `verificationBaseline`; `enum GoalDecisionSource`; three new enums after `enum Delivery`; `enum EventType`, after `workspace_package_noted`)
- Modify: `packages/db/src/enums.ts` (after `'workspace.package_noted'`)
- Create: `packages/domain/src/lead/constants.ts`, `progress.ts`, `state.ts`, `index.ts`
- Modify: `packages/domain/src/index.ts` (after `export * from './conduct/index.js'`)
- Modify: `packages/domain/src/events/schema.ts` (two variants after `workspace.package_noted`)
- Modify: `packages/domain/src/supervisor/timeline.ts` (after `'workspace.package_noted': 'work',`)
- Modify: `packages/domain/src/goalReport/types.ts` (`GoalReportSharedDecision.source`), `packages/domain/src/goalReport/caveats.ts` (`DECISION_SOURCE_LABEL`), `packages/domain/src/supervisor/world.ts` (`SupervisorConductorPlan.decisions[].source`)
- Modify: `apps/web/src/components/activity/cards.tsx` (two cards after `WorkspacePackageNotedCard`, two registry lines), `apps/web/src/lib/activityFilters.ts` (after `'workspace.package_noted',`), `apps/web/src/server/timeline.ts` (two `titleFor` cases after `workspace.package_noted`)
- Modify: `scripts/gate-m56a-provider-contract.mjs` (stage 12: 78 → 80 and the comment)
- Test: `packages/domain/test/lead/state.test.ts` (new), `packages/domain/test/lead/events.test.ts` (new), `packages/domain/test/supervisor/timeline.test.ts` (count), `packages/db/test/integration/enum-parity.test.ts` (three cases), `apps/web/test/activity-cards.test.tsx` (`PAYLOAD_BY_TYPE`), `apps/web/test/activityFilters.test.ts` (the workspace list)

**Interfaces:**
- Produces (Prisma): `enum WorkspaceFlow { packages lead }`; `enum LeadState { building proving delivered awaiting_decision stopped }`; `enum LeadTurn { build rework wrap_up continue answer base }`; `Workspace.flow WorkspaceFlow @default(packages)`, `Workspace.goalTimeLimitMs Int?`, `Workspace.leadRoster String[] @default([])`; `GoalDelivery.leadState LeadState?`, `GoalDelivery.stopReason String?`, `GoalDelivery.leadProgress Json?`; `SlaveRun.leadTurn LeadTurn?`, `SlaveRun.leadResumed Boolean @default(false)`, `SlaveRun.verificationKeys String[] @default([])`, `SlaveRun.confirmsRunId String?`; `GoalDecisionSource.lead`.
- Produces (domain, `lead/constants.ts`): `WORKSPACE_FLOWS`, `type WorkspaceFlow`, `LEAD_STATES`, `type LeadState`, `LEAD_TURNS`, `type LeadTurn`, `STOP_REASONS`, `type StopReason`, `LEAD_NOTE_KINDS`, `type LeadNoteKind`, and the bounds listed in Step 3.
- Produces (domain, `lead/progress.ts`): `interface LeadProgress`, `INITIAL_LEAD_PROGRESS`, `leadProgressSchema`, `readLeadProgress(value: unknown): LeadProgress`.
- Produces (domain, `lead/state.ts`): `interface LeadStateFacts`, `leadStateOf(facts: LeadStateFacts): LeadState`.
- Produces (events): `workspace.lead_state { version: number, state: LeadState, reason: StopReason | null }`; `workspace.lead_noted { version: number, kind: LeadNoteKind, detail: string(1..500), runId: string | null }`.
- Unchanged for `packages`: every column is nullable or defaulted, no existing row moves, and nothing reads the new columns yet.

- [ ] **Step 1: Migration.** Create `packages/db/prisma/migrations/20261004090000_lead_flow/migration.sql`:

```sql
-- Lead-flow spec (2026-10-04), plan A: one lead builds a goal version and Slave proves it.
--
-- `Workspace.flow` is the switch: `packages` is every project as it runs today, `lead` hands the
-- whole goal to one lead session. `goalTimeLimitMs` is the goal version's working-time limit
-- (null: none). `leadRoster` is the person ids the lead's subordinate sessions are defined from.
--
-- `GoalDelivery.leadState` is the one-word state of spec section 3 for a lead-flow version (null on
-- every other); `stopReason` is why its loop ended; `leadProgress` is what the proof loop carries
-- between rounds (validated at read by `leadProgressSchema`).
--
-- `SlaveRun.leadTurn` marks a run as one turn of a lead's session and says what the turn is for;
-- `leadResumed` says the turn was spawned onto the previous turn's session. `verificationKeys` are
-- the requirement keys a verification run checks (empty: the whole set); `confirmsRunId` is the
-- verification run whose failures a confirmation run re-checks.
--
-- `GoalDecisionSource.lead`: a decision the lead recorded in docs/DECISIONS.md.
--
-- PURELY ADDITIVE: three enum types, nullable or defaulted columns, three enum values unused
-- inside this transaction. No existing row changes.

CREATE TYPE "WorkspaceFlow" AS ENUM ('packages', 'lead');
CREATE TYPE "LeadState" AS ENUM ('building', 'proving', 'delivered', 'awaiting_decision', 'stopped');
CREATE TYPE "LeadTurn" AS ENUM ('build', 'rework', 'wrap_up', 'continue', 'answer', 'base');

ALTER TABLE "Workspace"
    ADD COLUMN "flow"            "WorkspaceFlow" NOT NULL DEFAULT 'packages',
    ADD COLUMN "goalTimeLimitMs" INTEGER,
    ADD COLUMN "leadRoster"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "GoalDelivery"
    ADD COLUMN "leadState"    "LeadState",
    ADD COLUMN "stopReason"   TEXT,
    ADD COLUMN "leadProgress" JSONB;

ALTER TABLE "SlaveRun"
    ADD COLUMN "leadTurn"         "LeadTurn",
    ADD COLUMN "leadResumed"      BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "verificationKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "confirmsRunId"    TEXT;

ALTER TYPE "GoalDecisionSource" ADD VALUE IF NOT EXISTS 'lead';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.lead_state';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.lead_noted';
```

- [ ] **Step 2: Schema.** In `model Workspace`, after `questionTimeoutMs`:

```prisma
  /// Lead-flow spec R-1 (plan A L1): how this project builds a goal version. `packages` is the
  /// planner or the conductor, as before; `lead` hands the whole goal to one lead session and lets
  /// Slave prove it. Switched with `set-flow`.
  flow WorkspaceFlow @default(packages)
  /// Lead-flow spec B4 (plan A L7): the working time one goal version may take, in milliseconds;
  /// null is no limit. Read only in the lead flow.
  goalTimeLimitMs Int?
  /// Lead-flow spec B2 (plan A L16): the person ids the lead's subordinate sessions are defined
  /// from, at most `LEAD_ROSTER_MAX`. Empty: the lead gets no session definitions.
  leadRoster String[] @default([])
```

After `enum Delivery { … }`:

```prisma
/// Lead-flow spec R-1 (plan A L1): mirrors `WORKSPACE_FLOWS`, member for member.
enum WorkspaceFlow {
  packages
  lead
}

/// Lead-flow spec section 3 (plan A L14): the state of a lead-flow goal version in one word.
/// `spec` and `hunting` arrive with plan B. Mirrors `LEAD_STATES`.
enum LeadState {
  building
  proving
  delivered
  awaiting_decision
  stopped
}

/// Lead-flow plan A L4: what one turn of the lead's session is for. Mirrors `LEAD_TURNS`.
enum LeadTurn {
  build
  rework
  wrap_up
  continue
  answer
  base
}
```

In `enum GoalDecisionSource`, after `person`:

```prisma
  /// Lead-flow spec B9: a decision the lead recorded in docs/DECISIONS.md.
  lead
```

In `model GoalDelivery`, after `reportNotedKey`:

```prisma
  /// Lead-flow spec section 3 (plan A L14): the state word, for a version built by a lead; null on
  /// every other. Derived by `leadStateOf` and stored by the goal pass when it changes.
  leadState         LeadState?
  /// Lead-flow spec P7 (plan A L12): why the lead flow's loop ended -- a `StopReason`.
  stopReason        String?
  /// Lead-flow plan A L11: what the proof loop carries between rounds (`LeadProgress`).
  leadProgress      Json?
```

In `model SlaveRun`, after `verificationBaseline`:

```prisma
  /// Lead-flow plan A L4: set on every turn of a lead's session, and what the turn is for. Null on
  /// every other run. The sweep reads it to exempt the run from the per-run limits (spec B4).
  leadTurn          LeadTurn?
  /// Lead-flow plan A L4: this turn was spawned onto the previous turn's session (`--resume`).
  leadResumed       Boolean       @default(false)
  /// Lead-flow spec P3/P5 (plan A L11): the requirement keys a verification run checks; empty is
  /// the whole set.
  verificationKeys  String[]      @default([])
  /// Lead-flow spec P3: the verification run whose failed requirements this run re-checks.
  confirmsRunId     String?
```

In `enum EventType`, after `workspace_package_noted`:

```prisma
  /// Lead-flow spec section 3: a lead-flow goal version's state word changed.
  workspace_lead_state           @map("workspace.lead_state")
  /// Lead-flow plan A: one line for the report about a lead-flow version -- a turn started, a
  /// decisions file read or missing, a disputed requirement, a limit wait. Never a card.
  workspace_lead_noted           @map("workspace.lead_noted")
```

`packages/db/src/enums.ts`, after `'workspace.package_noted': 'workspace_package_noted',`:

```ts
  'workspace.lead_state': 'workspace_lead_state',
  'workspace.lead_noted': 'workspace_lead_noted',
```

Run `npm run db:generate && npm run db:migrate:test`.

- [ ] **Step 3: Domain constants.** Create `packages/domain/src/lead/constants.ts`:

```ts
/**
 * Lead-flow spec (2026-10-04), plan A: the closed lists and bounds of the lead flow. A leaf module
 * (no imports): the event schema reads the lists and must not import anything that imports it.
 */

/** Plan A L1: how a project builds a goal version. */
export const WORKSPACE_FLOWS = ['packages', 'lead'] as const
export type WorkspaceFlow = (typeof WORKSPACE_FLOWS)[number]

/** Spec section 3: the state of a lead-flow goal version (`spec` and `hunting` arrive with plan B). */
export const LEAD_STATES = ['building', 'proving', 'delivered', 'awaiting_decision', 'stopped'] as const
export type LeadState = (typeof LEAD_STATES)[number]

/** Plan A L4: what one turn of the lead's session is for. */
export const LEAD_TURNS = ['build', 'rework', 'wrap_up', 'continue', 'answer', 'base'] as const
export type LeadTurn = (typeof LEAD_TURNS)[number]

/** Spec P7 (plan A L12/L13): why a lead-flow version's loop ended. */
export const STOP_REASONS = [
  'proven',
  'not_all_proven',
  'no_progress',
  'budget_spent',
  'time_spent',
  'nothing_built',
  'lead_failed',
  'proof_unusable',
  'accepted_as_is',
  'left',
] as const
export type StopReason = (typeof STOP_REASONS)[number]

/** What a `workspace.lead_noted` line is about. */
export const LEAD_NOTE_KINDS = [
  'turn',
  'decisions_read',
  'decisions_missing',
  'report_missing',
  'ask_refused',
  'disputed',
  'unverifiable',
  'limit_wait',
  'wrap_up',
  'lead_ended',
  'base_taken',
  'roster_dropped',
] as const
export type LeadNoteKind = (typeof LEAD_NOTE_KINDS)[number]

/** Bounds `workspace.lead_noted.detail`. */
export const LEAD_NOTE_DETAIL_MAX_CHARS = 500

/** Plan A L2: `WorkPackage.templateId` of a lead's package -- no catalogue persona stands behind it. */
export const LEAD_TEMPLATE_ID = 'lead'
/** Plan A L2: the team the three system seats sit in, and the seats' `Slave.role` titles. */
export const LEAD_TEAM_NAME = 'Lead flow'
export const LEAD_SEAT_ROLES = { lead: 'Lead', verifier: 'Verifier', confirmer: 'Confirmer' } as const
/** Spec B4: one fifth of the goal's budget is kept for proof. */
export const PROOF_RESERVE_RATIO = 0.2
/** Spec B4: at this part of its share the lead is told to wrap up. */
export const LEAD_WRAP_UP_RATIO = 0.8
/** A leg smaller than this is not worth a spawn: the share counts as spent. */
export const LEAD_MIN_LEG_USD = 0.05

/** Spec B5 (plan A L8): a lead turn whose stream said nothing for this long is restarted. */
export const LEAD_STALL_MS = 30 * 60_000
/** Plan A L10: how often a lead's question is answered "decide yourself" per goal version. */
export const LEAD_ASK_REPLIES_MAX = 2
/** Plan A L15: how often the base branch is taken into a version before a person merges by hand. */
export const LEAD_BASE_MERGES_MAX = 3

/** Spec S3 / plan A L16: the roster's size and the bounds of its session definitions. */
export const LEAD_ROSTER_MAX = 15
export const LEAD_ROSTER_MEMBER_PROMPT_MAX_CHARS = 6000
export const LEAD_ROSTER_JSON_MAX_BYTES = 100_000

/** Spec B9 (plan A L18): where the lead records its decisions, and how much of it is read. */
export const LEAD_DECISIONS_FILE = 'docs/DECISIONS.md'
export const LEAD_DECISIONS_FILE_MAX_BYTES = 200_000

/** Plan A L7: the goal's time limit, in milliseconds: ten minutes to a day, whole minutes. */
export const LEAD_TIME_LIMIT_BOUNDS_MS = { min: 10 * 60_000, max: 24 * 60 * 60_000 } as const

/** Plan A L12: the smoke check's place in a failing set -- it is not a requirement key. */
export const SMOKE_FAILING_KEY = 'SMOKE'

/** Plan A L13: the only situations the Supervisor raises in a lead-flow workspace. Spelled as
 *  strings so this module stays a leaf; `SITUATION_KINDS` holds both. */
export const LEAD_SITUATION_KINDS: readonly string[] = ['goal_needs_human', 'workspace_halted']
```

- [ ] **Step 4: Progress and state.** Create `packages/domain/src/lead/progress.ts`:

```ts
import { z } from 'zod'
import { LEAD_TURNS, STOP_REASONS, type LeadTurn, type StopReason } from './constants.js'

/**
 * Lead-flow plan A L11: what a lead-flow version carries between turns and proof rounds, stored on
 * `GoalDelivery.leadProgress` and moved only under the delivery's lock.
 */
export interface LeadProgress {
  /** What the lead's next turn is for and what it is told; null when nothing is queued. */
  readonly nextTurn: { readonly kind: LeadTurn; readonly note: string } | null
  /** Why the lead gets no further turn (its budget share or the time is spent); null while it may work. */
  readonly leadEnded: StopReason | null
  /** The requirement keys the next proof round checks; empty is the whole set (spec P5). */
  readonly recheckKeys: readonly string[]
  /** Failures of `runId` awaiting the confirmer (spec P3), and whether that round was full. */
  readonly confirm: { readonly runId: string; readonly keys: readonly string[]; readonly scope: 'full' | 'partial' } | null
  /** The last confirmed failing set, for "two rounds in a row" (spec P7). */
  readonly failing: readonly string[]
  /** Keys the two verifiers disagreed on (spec P3): never reworked, named in the report. */
  readonly disputed: readonly string[]
  /** Keys the latest round could not verify (spec P4): never a stop on their own. */
  readonly unverifiable: readonly string[]
  /** The wrap-up turn was dispatched (spec B4). */
  readonly wrapUpSent: boolean
  /** How often a lead's question was answered "decide yourself" (plan A L10). */
  readonly askReplies: number
  /** How often the base branch was taken in (plan A L15). */
  readonly baseMerges: number
}

export const INITIAL_LEAD_PROGRESS: LeadProgress = {
  nextTurn: null,
  leadEnded: null,
  recheckKeys: [],
  confirm: null,
  failing: [],
  disputed: [],
  unverifiable: [],
  wrapUpSent: false,
  askReplies: 0,
  baseMerges: 0,
}

const keyList = z.array(z.string().min(1).max(20)).max(400)

/** READ-tolerant: every field defaults, so a row written before a field existed still parses. */
export const leadProgressSchema = z.object({
  nextTurn: z.object({ kind: z.enum(LEAD_TURNS), note: z.string().max(20_000) }).nullable().default(null),
  leadEnded: z.enum(STOP_REASONS).nullable().default(null),
  recheckKeys: keyList.default([]),
  confirm: z.object({ runId: z.string().min(1), keys: keyList, scope: z.enum(['full', 'partial']) }).nullable().default(null),
  failing: keyList.default([]),
  disputed: keyList.default([]),
  unverifiable: keyList.default([]),
  wrapUpSent: z.boolean().default(false),
  askReplies: z.number().int().nonnegative().default(0),
  baseMerges: z.number().int().nonnegative().default(0),
})

/** The stored progress, or the initial one for a null column or a value that does not parse. */
export function readLeadProgress(value: unknown): LeadProgress {
  const parsed = leadProgressSchema.safeParse(value ?? {})
  return parsed.success ? parsed.data : INITIAL_LEAD_PROGRESS
}
```

Create `packages/domain/src/lead/state.ts`:

```ts
import type { LeadState } from './constants.js'

/** What {@link leadStateOf} reads off a goal delivery and its workspace. */
export interface LeadStateFacts {
  readonly status: 'integrating' | 'verifying' | 'accepted' | 'needs_human' | 'abandoned'
  readonly merged: boolean
  /** The lead's task is `done` and on the work branch. */
  readonly integrated: boolean
  readonly autoMerge: boolean
  readonly mergeFailed: boolean
}

/**
 * Lead-flow spec section 3 (plan A L14): a version's state in one word. An accepted version that
 * will be merged on the next pass still reads `proving`; one a person must merge by hand reads
 * `awaiting_decision`, as does every stop.
 */
export function leadStateOf(facts: LeadStateFacts): LeadState {
  if (facts.status === 'abandoned') return 'stopped'
  if (facts.merged) return 'delivered'
  if (facts.status === 'needs_human') return 'awaiting_decision'
  if (facts.status === 'accepted') return facts.autoMerge && !facts.mergeFailed ? 'proving' : 'awaiting_decision'
  if (facts.status === 'verifying') return 'proving'
  return facts.integrated ? 'proving' : 'building'
}
```

Create `packages/domain/src/lead/index.ts`:

```ts
export * from './constants.js'
export * from './progress.js'
export * from './state.js'
```

Add `export * from './lead/index.js'` to `packages/domain/src/index.ts` after `export * from './conduct/index.js'`.

- [ ] **Step 5: Failing tests.** Create `packages/domain/test/lead/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { INITIAL_LEAD_PROGRESS, leadStateOf, readLeadProgress, type LeadStateFacts } from '../../src/lead/index.js'

const facts = (over: Partial<LeadStateFacts>): LeadStateFacts => ({ status: 'integrating', merged: false, integrated: false, autoMerge: true, mergeFailed: false, ...over })

describe('leadStateOf (lead-flow spec section 3)', () => {
  it('reads building until the lead\'s work is on the branch, then proving', () => {
    expect(leadStateOf(facts({}))).toBe('building')
    expect(leadStateOf(facts({ integrated: true }))).toBe('proving')
    expect(leadStateOf(facts({ status: 'verifying', integrated: true }))).toBe('proving')
  })

  it('reads delivered once merged, whatever the status', () => {
    expect(leadStateOf(facts({ status: 'accepted', merged: true }))).toBe('delivered')
  })

  it('reads awaiting_decision for a stop, and for an accepted version a person must merge', () => {
    expect(leadStateOf(facts({ status: 'needs_human' }))).toBe('awaiting_decision')
    expect(leadStateOf(facts({ status: 'accepted', autoMerge: false }))).toBe('awaiting_decision')
    expect(leadStateOf(facts({ status: 'accepted', mergeFailed: true }))).toBe('awaiting_decision')
    expect(leadStateOf(facts({ status: 'accepted' }))).toBe('proving')
  })

  it('reads stopped for an abandoned version, merged or not', () => {
    expect(leadStateOf(facts({ status: 'abandoned', merged: true }))).toBe('stopped')
  })
})

describe('readLeadProgress', () => {
  it('reads a null column and a broken value as the initial progress', () => {
    expect(readLeadProgress(null)).toEqual(INITIAL_LEAD_PROGRESS)
    expect(readLeadProgress({ recheckKeys: 'R1' })).toEqual(INITIAL_LEAD_PROGRESS)
  })

  it('fills the fields a stored row lacks', () => {
    expect(readLeadProgress({ failing: ['R2'], wrapUpSent: true })).toEqual({ ...INITIAL_LEAD_PROGRESS, failing: ['R2'], wrapUpSent: true })
  })
})
```

Create `packages/domain/test/lead/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { executionEventSchema } from '../../src/events/schema.js'
import { LANE_BY_TYPE } from '../../src/supervisor/timeline.js'

const BASE = { seq: 1, ts: '2026-10-04T09:00:00.000Z', workspaceId: 'w1', actor: 'system' } as const
const parses = (type: string, payload: object): boolean => executionEventSchema.safeParse({ ...BASE, type, payload }).success

describe('lead-flow events', () => {
  it('reads a state change with a stop reason or none', () => {
    expect(parses('workspace.lead_state', { version: 1, state: 'building', reason: null })).toBe(true)
    expect(parses('workspace.lead_state', { version: 1, state: 'awaiting_decision', reason: 'no_progress' })).toBe(true)
    expect(parses('workspace.lead_state', { version: 1, state: 'hunting', reason: null })).toBe(false)
    expect(parses('workspace.lead_state', { version: 1, state: 'stopped', reason: 'because' })).toBe(false)
  })

  it('reads a note, and refuses an unknown kind, an empty detail and one over 500 characters', () => {
    expect(parses('workspace.lead_noted', { version: 2, kind: 'turn', detail: 'turn 2 (rework): the same session was resumed', runId: 'r1' })).toBe(true)
    expect(parses('workspace.lead_noted', { version: 2, kind: 'limit_wait', detail: 'the provider refused the turn', runId: null })).toBe(true)
    expect(parses('workspace.lead_noted', { version: 2, kind: 'gossip', detail: 'x', runId: null })).toBe(false)
    expect(parses('workspace.lead_noted', { version: 2, kind: 'turn', detail: '', runId: null })).toBe(false)
    expect(parses('workspace.lead_noted', { version: 2, kind: 'turn', detail: 'x'.repeat(501), runId: null })).toBe(false)
  })

  it('files both on the work lane', () => {
    expect(LANE_BY_TYPE['workspace.lead_state']).toBe('work')
    expect(LANE_BY_TYPE['workspace.lead_noted']).toBe('work')
  })
})
```

In `packages/domain/test/supervisor/timeline.test.ts` change the count case to `'lanes every event type -- 80 as of lead-flow Plan A Task 1'` and `toHaveLength(80)`. In `packages/db/test/integration/enum-parity.test.ts` import `LEAD_STATES`, `LEAD_TURNS`, `WORKSPACE_FLOWS` from `@slave-of-ai/domain` and add, after the `SmokeOutcome` case:

```ts
  it('WorkspaceFlow, LeadState and LeadTurn match their domain lists, member for member', async () => {
    expect(await enumValues('WorkspaceFlow')).toEqual([...WORKSPACE_FLOWS].sort())
    expect(await enumValues('LeadState')).toEqual([...LEAD_STATES].sort())
    expect(await enumValues('LeadTurn')).toEqual([...LEAD_TURNS].sort())
  })
```

In `apps/web/test/activity-cards.test.tsx`'s `PAYLOAD_BY_TYPE` add:

```ts
  'workspace.lead_state': { version: 1, state: 'awaiting_decision', reason: 'no_progress' },
  'workspace.lead_noted': { version: 1, kind: 'turn', detail: 'turn 2 (rework): the same session was resumed', runId: 'r1' },
```

In `apps/web/test/activityFilters.test.ts`, in the sorted workspace list, add `'workspace.lead_noted',` and `'workspace.lead_state',` between `'workspace.goal_waiting',` and `'workspace.package_handed_off',`.

Run `npx vitest run packages/domain/test/lead` → FAIL (`workspace.lead_state` is not a known event type; `LANE_BY_TYPE['workspace.lead_state']` is undefined).

- [ ] **Step 6: Event schema, lanes, decision source.** In `packages/domain/src/events/schema.ts` import `LEAD_NOTE_KINDS, LEAD_STATES, STOP_REASONS` from `'../lead/constants.js'`. After the `workspace.package_noted` variant:

```ts
  // Lead-flow spec section 3 (plan A L14): a lead-flow goal version's state word changed. `reason`
  // is why its loop ended, on the states a stop reaches.
  z.object({
    ...envelope,
    type: z.literal('workspace.lead_state'),
    payload: z.object({ version: z.number().int().positive(), state: z.enum(LEAD_STATES), reason: z.enum(STOP_REASONS).nullable() }),
  }),
  // Lead-flow plan A: one line for the report about a lead-flow version. Information, never a card.
  // `detail` is system text or sanitised, fitted text; `LEAD_NOTE_DETAIL_MAX_CHARS`, spelled here
  // the way this file spells every stored bound.
  z.object({
    ...envelope,
    type: z.literal('workspace.lead_noted'),
    payload: z.object({ version: z.number().int().positive(), kind: z.enum(LEAD_NOTE_KINDS), detail: z.string().min(1).max(500), runId: z.string().min(1).nullable() }),
  }),
```

`packages/domain/src/supervisor/timeline.ts`, after `'workspace.package_noted': 'work',`:

```ts
  'workspace.lead_state': 'work', // Lead flow: the version's state word moved.
  'workspace.lead_noted': 'work', // Lead flow: a line for the report, beside a worker's note.
```

Widen the three decision-source unions to `'conductor_plan' | 'conductor_answer' | 'person' | 'lead'`: `GoalReportSharedDecision.source` (`packages/domain/src/goalReport/types.ts`), `SupervisorConductorPlan.decisions[].source` (`packages/domain/src/supervisor/world.ts`). In `packages/domain/src/goalReport/caveats.ts` add `lead: 'the lead',` to `DECISION_SOURCE_LABEL`.

- [ ] **Step 7: Web.** In `apps/web/src/components/activity/cards.tsx`, after `WorkspacePackageNotedCard`:

```tsx
/** Lead flow: the version's state word moved. A stop is the one a person acts on. */
function WorkspaceLeadStateCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { version: number; state: string; reason: string | null }
  const state = payload.state.replaceAll('_', ' ')
  return (
    <ActivityCard {...props}>
      <Transition tone={payload.state === 'awaiting_decision' ? 'warn' : 'working'} label={`goal v${String(payload.version)}: ${state}`}>
        {payload.reason !== null && <span data-testid="lead-stop-reason">{payload.reason.replaceAll('_', ' ')}</span>}
      </Transition>
    </ActivityCard>
  )
}

/** Lead flow: a line for the report. Information, never a card to decide. */
function WorkspaceLeadNotedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { version: number; kind: string; detail: string }
  return (
    <ActivityCard {...props}>
      <Transition tone="working" label={`goal v${String(payload.version)}: ${payload.kind.replaceAll('_', ' ')}`}>
        <span data-testid="lead-note">{payload.detail}</span>
      </Transition>
    </ActivityCard>
  )
}
```

Add `'workspace.lead_state': WorkspaceLeadStateCard,` and `'workspace.lead_noted': WorkspaceLeadNotedCard,` to `ACTIVITY_CARDS` after `'workspace.package_noted'`. In `apps/web/src/lib/activityFilters.ts`, after `'workspace.package_noted',`:

```ts
    // Lead flow: the version's state word and its report lines, beside the delivery events.
    'workspace.lead_state',
    'workspace.lead_noted',
```

In `apps/web/src/server/timeline.ts`, after the `workspace.package_noted` case of `titleFor`:

```ts
    // Lead flow: the state word, and a report line (its words are the detail).
    case 'workspace.lead_state': {
      const version = payload['version']
      const state = payload['state']
      return `goal v${typeof version === 'number' ? String(version) : '?'}: ${typeof state === 'string' ? state.replaceAll('_', ' ') : 'state changed'}`
    }
    case 'workspace.lead_noted': {
      const version = payload['version']
      const kind = payload['kind']
      return `goal v${typeof version === 'number' ? String(version) : '?'}: ${typeof kind === 'string' ? kind.replaceAll('_', ' ') : 'noted'}`
    }
```

Beside the `workspace.package_noted` line of the detail function in the same file (`if (type === 'workspace.package_noted' && …) return payload['note']`), add:

```ts
  if (type === 'workspace.lead_noted' && typeof payload['detail'] === 'string' && payload['detail'] !== '') return payload['detail']
```

- [ ] **Step 8: m56a.** In `scripts/gate-m56a-provider-contract.mjs` stage 12, append to the comment "Lead-flow Plan A added two events, `workspace.lead_state` and `workspace.lead_noted`." and change `78` to `80` in both the condition and the message.

- [ ] **Step 9: Run.** `npx tsc --build`, then `npx vitest run packages/domain/test/lead packages/domain/test/supervisor/timeline.test.ts` → PASS. `npx vitest run packages/db/test/integration/enum-parity.test.ts` → PASS. `npx vitest run apps/web/test/activity-cards.test.tsx apps/web/test/activityFilters.test.ts` → PASS. `npm run typecheck` (it names any loader that maps a `GoalDecision.source` into the narrower union; widen it the same way). The drift check, with `DATABASE_URL` exported to the test DB: `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` prints `No difference detected`. `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 10: Commit**

```bash
git add packages/db/prisma packages/db/src/enums.ts packages/db/test/integration/enum-parity.test.ts packages/domain/src/lead packages/domain/src/index.ts packages/domain/src/events/schema.ts packages/domain/src/supervisor/timeline.ts packages/domain/src/supervisor/world.ts packages/domain/src/goalReport packages/domain/test apps/web/src/components/activity/cards.tsx apps/web/src/lib/activityFilters.ts apps/web/src/server/timeline.ts apps/web/test scripts/gate-m56a-provider-contract.mjs
git commit -m "feat(db): a project has a flow, a lead-flow goal version has a state word and a progress record, and two events say so

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: Opening a project in the lead flow: the switch, its system seats, its settings

**Files:**
- Create: `packages/control/src/lead/flow.ts`
- Modify: `packages/control/src/index.ts` (after `export * from './delivery.js'`: `export * from './lead/flow.js'`)
- Modify: `packages/control/src/refusal.ts` (three kinds in the `ControlRefusal` union after `goal_not_needs_human` at `:222`; three cases in `refusalText` after its case at `:785`)
- Modify: `packages/control/src/stats.ts` (`workspaceStats`, the returned `limits.budgetUsd` and `stats.consecutiveFailures`)
- Modify: `apps/orchestrator/src/supervisor.ts` (`supervise`, the line `const situations = filterFresh(observe(world), world)` at `:239`)
- Modify: `apps/orchestrator/src/cli.ts` (usage text after `set-delivery` at `:339`; two cases after `case 'set-delivery'` at `:2308`)
- Test: `packages/control/test/integration/lead-flow.test.ts` (new), `apps/orchestrator/test/lead-situations.test.ts` (new), `apps/orchestrator/test/integration/cli.test.ts` (two cases after the `set-delivery` ones)

**Interfaces:**
- Consumes: Task 1's columns and constants; `MODEL_ID_PATTERN`, `MODEL_SHAPE_DETAIL` (`packages/control/src/staffing.ts`); `NON_TERMINAL_RUN_STATUSES`, `PACKAGE_WORKER_ROLE`, `VERIFIER_ROLE` (domain).
- Produces (control, `lead/flow.ts`):
  - `interface LeadSeats { readonly lead: string; readonly verifier: string; readonly confirmer: string }` (seat ids)
  - `ensureLeadSeats(workspaceId: string, model?: string): Promise<Result<LeadSeats, ControlRefusal>>`
  - `setFlow(workspaceId: string, flow: WorkspaceFlow, options?: { readonly autoMerge?: boolean; readonly model?: string }): Promise<Result<{ readonly flow: WorkspaceFlow; readonly changed: boolean }, ControlRefusal>>`
  - `setLeadSettings(workspaceId: string, input: { readonly timeLimitMs?: number | null; readonly roster?: readonly string[]; readonly model?: string }): Promise<Result<{ readonly timeLimitMs: number | null; readonly roster: readonly string[] }, ControlRefusal>>`
  - `workspaceFlow(workspaceId: string): Promise<WorkspaceFlow | null>`
- Produces (refusals): `{ kind: 'flow_refused', workspaceId, reason }`, `{ kind: 'lead_setting_invalid', field, rule }`, `{ kind: 'not_lead_flow', workspaceId }`.
- Produces (orchestrator): `leadSituations<T extends { readonly kind: string }>(flow: WorkspaceFlow | null, situations: readonly T[]): readonly T[]` exported from `apps/orchestrator/src/supervisor.ts`.
- Produces (CLI): `set-flow --workspace <id> --flow <packages|lead> [--auto-merge <on|off>] [--model <id>]`; `set-lead --workspace <id> [--time-limit-min <n|none>] [--roster <id,id,…|none>] [--model <id>]`.
- Unchanged for `packages`: `workspaceStats` returns the same two figures unless `workspace.flow === 'lead'`; `leadSituations` returns its input for any other flow.

- [ ] **Step 1: Failing control test.** Create `packages/control/test/integration/lead-flow.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_TEAM_NAME } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureLeadSeats, setFlow, setLeadSettings } from '../../src/lead/flow.js'
import { workspaceStats } from '../../src/stats.js'

async function workspace(data: { readonly budgetUsd?: number; readonly provider?: boolean } = {}): Promise<string> {
  const row = await prisma.workspace.create({
    data: { name: `Lead ${String(Math.random()).slice(2)}`, repoPath: '/tmp/lead', verifyCommands: ['true'], setupCommands: [], ...(data.budgetUsd === undefined ? {} : { budgetUsd: data.budgetUsd }) },
  })
  if (data.provider !== false) await prisma.providerConfiguration.create({ data: { workspaceId: row.id, kind: 'claude_code', settings: {} } })
  return row.id
}

describe('the lead flow switch (plan A L1/L2)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "GoalDelivery", "SlaveRun", "Task", "ProviderConfiguration", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('switches a project to the lead flow: conducted, automatic merge, three system seats with no model of their own (C5)', async (): Promise<void> => {
    const id = await workspace()
    const result = await setFlow(id, 'lead')
    expect(result).toEqual({ ok: true, value: { flow: 'lead', changed: true } })
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id } })
    expect([row.flow, row.delivery, row.autoMerge]).toEqual(['lead', 'conducted', true])
    const seats = await prisma.slave.findMany({ where: { team: { workspaceId: id, name: LEAD_TEAM_NAME } }, orderBy: { role: 'asc' }, include: { person: true } })
    expect(seats.map((s) => [s.role, s.runtimeRoles, s.model, s.provider, s.person.templateId])).toEqual([
      ['Confirmer', ['verifier'], null, null, null],
      ['Lead', ['implementer'], null, null, null],
      ['Verifier', ['verifier'], null, null, null],
    ])
    expect(await setFlow(id, 'lead')).toEqual({ ok: true, value: { flow: 'lead', changed: false } })
  })

  it('makes the seats once: a second call returns the same three ids, and a named model moves them', async (): Promise<void> => {
    const id = await workspace()
    const first = await ensureLeadSeats(id)
    const second = await ensureLeadSeats(id, 'claude-opus-5')
    expect(first.ok && second.ok && second.value).toEqual(first.ok ? first.value : null)
    expect(await prisma.slave.count({ where: { team: { workspaceId: id } } })).toBe(3)
    expect((await prisma.slave.findMany({ where: { team: { workspaceId: id } } })).every((s) => s.model === 'claude-opus-5' && s.provider === 'claude_code')).toBe(true)
  })

  it('keeps automatic merge off when asked, and refuses without a Claude Code provider, with an open goal version or a live run', async (): Promise<void> => {
    const off = await workspace()
    await setFlow(off, 'lead', { autoMerge: false })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: off } })).autoMerge).toBe(false)

    const bare = await workspace({ provider: false })
    expect(await setFlow(bare, 'lead')).toMatchObject({ ok: false, error: { kind: 'flow_refused' } })

    const open = await workspace()
    await prisma.goalDelivery.create({ data: { workspaceId: open, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1', baseCommit: 'abc' } })
    expect(await setFlow(open, 'lead')).toMatchObject({ ok: false, error: { kind: 'flow_refused', reason: expect.stringContaining('goal v1') } })

    const live = await workspace()
    const team = await prisma.team.create({ data: { workspaceId: live, name: 'E' } })
    const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'backend', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: 'Ivo' } })).id } })
    await prisma.slaveRun.create({ data: { slaveId: seat.id, status: 'working', kind: 'planning' } })
    expect(await setFlow(live, 'lead')).toMatchObject({ ok: false, error: { kind: 'flow_refused', reason: expect.stringContaining('1 run') } })
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: live } })).flow).toBe('packages')
  })

  it('sets the time limit and the roster, and refuses a limit out of bounds, an unknown person and a project not in the lead flow', async (): Promise<void> => {
    const id = await workspace()
    expect(await setLeadSettings(id, { timeLimitMs: 3_600_000 })).toMatchObject({ ok: false, error: { kind: 'not_lead_flow' } })
    await setFlow(id, 'lead')
    const ada = await prisma.person.create({ data: { name: 'Ada' } })
    expect(await setLeadSettings(id, { timeLimitMs: 3_600_000, roster: [ada.id] })).toEqual({ ok: true, value: { timeLimitMs: 3_600_000, roster: [ada.id] } })
    expect(await setLeadSettings(id, { timeLimitMs: null })).toEqual({ ok: true, value: { timeLimitMs: null, roster: [ada.id] } })
    expect(await setLeadSettings(id, { timeLimitMs: 90_000 })).toMatchObject({ ok: false, error: { kind: 'lead_setting_invalid', field: 'timeLimitMs' } })
    expect(await setLeadSettings(id, { roster: [ada.id, 'nobody'] })).toMatchObject({ ok: false, error: { kind: 'lead_setting_invalid', field: 'roster', rule: expect.stringContaining('nobody') } })
    expect(await setLeadSettings(id, { roster: Array.from({ length: 16 }, () => ada.id) })).toMatchObject({ ok: false, error: { kind: 'lead_setting_invalid', field: 'roster' } })
  })

  it('reports no workspace budget and no failure streak for a lead-flow project, and both for any other (L6/L9)', async (): Promise<void> => {
    const lead = await workspace({ budgetUsd: 30 })
    await setFlow(lead, 'lead')
    const other = await workspace({ budgetUsd: 30 })
    for (const id of [lead, other]) {
      const seat = await prisma.slave.findFirst({ where: { team: { workspaceId: id } } }) ??
        (await prisma.slave.create({ data: { teamId: (await prisma.team.create({ data: { workspaceId: id, name: 'E' } })).id, role: 'backend', runtimeRoles: ['backend'], personId: (await prisma.person.create({ data: { name: `P ${id}` } })).id } }))
      for (let i = 0; i < 3; i += 1) await prisma.slaveRun.create({ data: { slaveId: seat.id, status: 'failed', kind: 'planning', failureClass: 'worker', terminalAt: new Date(), endedAt: new Date() } })
    }
    const a = await workspaceStats(lead)
    const b = await workspaceStats(other)
    expect([a.limits.budgetUsd, a.stats.consecutiveFailures]).toEqual([null, 0])
    expect([b.limits.budgetUsd, b.stats.consecutiveFailures]).toEqual([30, 3])
  })
})
```

Run `npx vitest run packages/control/test/integration/lead-flow.test.ts` → FAIL (`../../src/lead/flow.js` does not exist).

- [ ] **Step 2: Refusals.** In `packages/control/src/refusal.ts`, after the `goal_not_needs_human` member of the union:

```ts
  /** Lead flow (plan A L1): the flow cannot change now, and why. */
  | { readonly kind: 'flow_refused'; readonly workspaceId: string; readonly reason: string }
  /** Lead flow (plan A L7/L16): a lead setting is out of its rule. */
  | { readonly kind: 'lead_setting_invalid'; readonly field: string; readonly rule: string }
  /** Lead flow: the verb is for a project in the lead flow, and this one is not. */
  | { readonly kind: 'not_lead_flow'; readonly workspaceId: string }
```

In `refusalText`, after `case 'goal_not_needs_human':`'s return:

```ts
    case 'flow_refused':
      return `the flow of ${refusal.workspaceId} cannot change now: ${refusal.reason}`
    case 'lead_setting_invalid':
      return `${refusal.field}: ${refusal.rule}`
    case 'not_lead_flow':
      return `${refusal.workspaceId} is not in the lead flow; run set-flow --workspace ${refusal.workspaceId} --flow lead first`
```

- [ ] **Step 3: The verbs.** Create `packages/control/src/lead/flow.ts`:

```ts
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  LEAD_ROSTER_MAX,
  LEAD_SEAT_ROLES,
  LEAD_TEAM_NAME,
  LEAD_TIME_LIMIT_BOUNDS_MS,
  NON_TERMINAL_RUN_STATUSES,
  PACKAGE_WORKER_ROLE,
  VERIFIER_ROLE,
  err,
  ok,
  type Result,
  type WorkspaceFlow,
} from '@slave-of-ai/domain'
import type { ControlRefusal } from '../refusal.js'
import { MODEL_ID_PATTERN, MODEL_SHAPE_DETAIL } from '../staffing.js'

/** Plan A L2: the three system seats of a lead-flow project, by seat id. */
export interface LeadSeats {
  readonly lead: string
  readonly verifier: string
  readonly confirmer: string
}

/** The project's flow, or null for a project that does not exist. */
export async function workspaceFlow(workspaceId: string): Promise<WorkspaceFlow | null> {
  return (await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { flow: true } }))?.flow ?? null
}

/** `Person.name` is unique across the installation: the base name, or the first free ` 2`, ` 3`. */
async function freePersonName(tx: Prisma.TransactionClient, base: string): Promise<string> {
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base} ${String(n)}`
    if ((await tx.person.findUnique({ where: { name }, select: { id: true } })) === null) return name
  }
}

/**
 * Plan A L2: the lead, the verifier and the confirmer of a lead-flow project -- three seats with no
 * catalogue persona behind them, in a team of their own, made once. A seat that exists is returned
 * as it is; `model`, when given, is written on all three (the pair with `claude_code`); without
 * it a new seat has no model (C5) and `leadRuntime` runs it on Claude Code with the CLI's default. Serialised
 * on the workspace row, so two callers make one set. The one refusal is returned before the first
 * write, so returning it commits nothing.
 */
export async function ensureLeadSeats(workspaceId: string, model?: string): Promise<Result<LeadSeats, ControlRefusal>> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    if (locked.length === 0) return err({ kind: 'workspace_not_found', workspaceId })
    const team =
      (await tx.team.findUnique({ where: { workspaceId_name: { workspaceId, name: LEAD_TEAM_NAME } } })) ??
      (await tx.team.create({ data: { workspaceId, name: LEAD_TEAM_NAME } }))
    const seat = async (role: string, runtimeRole: string): Promise<string> => {
      const found = await tx.slave.findFirst({ where: { teamId: team.id, role, closedAt: null }, select: { id: true } })
      if (found !== null) {
        if (model !== undefined) await tx.slave.update({ where: { id: found.id }, data: { model, provider: 'claude_code' } })
        return found.id
      }
      const person = await tx.person.create({ data: { name: await freePersonName(tx, `${role} ${workspaceId.slice(0, 8)}`) } })
      const made = await tx.slave.create({
        // C5: no model unless one is named -- the run then carries no `--model` and the installed
        // CLI's own default is used. Never a provider without its model (M12 Task 7's half-pair).
        data: { teamId: team.id, personId: person.id, role, runtimeRoles: [runtimeRole], ...(model === undefined ? {} : { model, provider: 'claude_code' as const }) },
        select: { id: true },
      })
      return made.id
    }
    return ok({
      lead: await seat(LEAD_SEAT_ROLES.lead, PACKAGE_WORKER_ROLE),
      verifier: await seat(LEAD_SEAT_ROLES.verifier, VERIFIER_ROLE),
      confirmer: await seat(LEAD_SEAT_ROLES.confirmer, VERIFIER_ROLE),
    })
  })
}

/**
 * Plan A L1: puts a project into the lead flow, or back. Refused while a goal version is open or a
 * run is live: the two flows read the same tables differently, and a version must end in the flow
 * it started in. Into `lead`: the project becomes `conducted`, automatic merge goes on (spec D1's
 * default; `autoMerge: false` keeps it off), and its three system seats are made.
 */
export async function setFlow(
  workspaceId: string,
  flow: WorkspaceFlow,
  options: { readonly autoMerge?: boolean; readonly model?: string } = {},
): Promise<Result<{ readonly flow: WorkspaceFlow; readonly changed: boolean }, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { flow: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  if (workspace.flow === flow) return ok({ flow, changed: false })
  if (options.model !== undefined && !MODEL_ID_PATTERN.test(options.model)) return err({ kind: 'invalid_model', detail: MODEL_SHAPE_DETAIL })

  const open = await prisma.goalDelivery.findFirst({
    where: { workspaceId, status: { not: 'abandoned' }, mergedAt: null },
    orderBy: { goalVersion: 'asc' },
    select: { goalVersion: true },
  })
  if (open !== null) return err({ kind: 'flow_refused', workspaceId, reason: `goal v${String(open.goalVersion)} is still open; merge or abandon it first` })
  const live = await prisma.slaveRun.count({ where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] }, slave: { team: { workspaceId } } } })
  if (live > 0) return err({ kind: 'flow_refused', workspaceId, reason: `${String(live)} run(s) are live; wait for them or stop them first` })

  if (flow === 'lead') {
    const claude = await prisma.providerConfiguration.findFirst({ where: { workspaceId, kind: 'claude_code' }, select: { id: true } })
    if (claude === null) return err({ kind: 'flow_refused', workspaceId, reason: 'the lead flow runs on Claude Code, and this project has no claude_code provider configured' })
    const seats = await ensureLeadSeats(workspaceId, options.model)
    if (!seats.ok) return seats
    await prisma.workspace.update({ where: { id: workspaceId }, data: { flow: 'lead', delivery: 'conducted', autoMerge: options.autoMerge ?? true } })
  } else {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { flow } })
  }
  return ok({ flow, changed: true })
}

/**
 * Plan A L7/L16: the lead flow's own settings. `timeLimitMs` null clears the limit; `roster` is
 * person ids (unreleased, each once, at most `LEAD_ROSTER_MAX`); `model` moves the three system
 * seats. Everything is checked before anything is written.
 */
export async function setLeadSettings(
  workspaceId: string,
  input: { readonly timeLimitMs?: number | null; readonly roster?: readonly string[]; readonly model?: string },
): Promise<Result<{ readonly timeLimitMs: number | null; readonly roster: readonly string[] }, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { flow: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  if (workspace.flow !== 'lead') return err({ kind: 'not_lead_flow', workspaceId })

  const { min, max } = LEAD_TIME_LIMIT_BOUNDS_MS
  const limit = input.timeLimitMs
  if (limit !== undefined && limit !== null && !(Number.isInteger(limit) && limit >= min && limit <= max && limit % 60_000 === 0)) {
    return err({ kind: 'lead_setting_invalid', field: 'timeLimitMs', rule: `a goal's time limit must be a whole number of minutes from ${String(min / 60_000)} to ${String(max / 60_000)}` })
  }
  if (input.model !== undefined && !MODEL_ID_PATTERN.test(input.model)) return err({ kind: 'invalid_model', detail: MODEL_SHAPE_DETAIL })
  if (input.roster !== undefined) {
    if (input.roster.length > LEAD_ROSTER_MAX || new Set(input.roster).size !== input.roster.length) {
      return err({ kind: 'lead_setting_invalid', field: 'roster', rule: `a roster names at most ${String(LEAD_ROSTER_MAX)} persons, each once` })
    }
    const known = new Set((await prisma.person.findMany({ where: { id: { in: [...input.roster] }, releasedAt: null }, select: { id: true } })).map((p) => p.id))
    const unknown = input.roster.filter((id) => !known.has(id))
    if (unknown.length > 0) return err({ kind: 'lead_setting_invalid', field: 'roster', rule: `no such person in the catalogue: ${unknown.join(', ')}` })
  }

  if (input.model !== undefined) {
    const seats = await ensureLeadSeats(workspaceId, input.model)
    if (!seats.ok) return seats
  }
  const updated = await prisma.workspace.update({
    where: { id: workspaceId },
    data: { ...(limit === undefined ? {} : { goalTimeLimitMs: limit }), ...(input.roster === undefined ? {} : { leadRoster: [...input.roster] }) },
    select: { goalTimeLimitMs: true, leadRoster: true },
  })
  return ok({ timeLimitMs: updated.goalTimeLimitMs, roster: updated.leadRoster })
}
```

Add `export * from './lead/flow.js'` to `packages/control/src/index.ts`.

- [ ] **Step 4: The stats.** In `packages/control/src/stats.ts`, in `workspaceStats`, directly above `return {` at the end of the function:

```ts
  // Lead flow (plan A L6/L9): the budget and the stop rules belong to the goal version there. A
  // workspace halt for either would return from the tick before the goal pass, which is what ends a
  // lead-flow version and raises its one card -- so neither is reported for such a project.
  const leadFlow = workspace.flow === 'lead'
```

and change two lines of the returned object: `budgetUsd: leadFlow ? null : workspace.budgetUsd,` and `consecutiveFailures: leadFlow ? 0 : consecutiveFailures,`.

Run `npx tsc --build && npx vitest run packages/control/test/integration/lead-flow.test.ts` → PASS.

- [ ] **Step 5: The Supervisor's filter, failing test first.** Create `apps/orchestrator/test/lead-situations.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { leadSituations } from '../src/supervisor.js'

const seen = [{ kind: 'task_failed' }, { kind: 'goal_needs_human' }, { kind: 'verification_failed' }, { kind: 'workspace_halted' }, { kind: 'waiting_stale' }]

describe('leadSituations (plan A L13)', () => {
  it('keeps only a stopped goal version and a halt in the lead flow', () => {
    expect(leadSituations('lead', seen).map((s) => s.kind)).toEqual(['goal_needs_human', 'workspace_halted'])
  })

  it('returns what it was given for every other project', () => {
    expect(leadSituations('packages', seen)).toBe(seen)
    expect(leadSituations(null, seen)).toBe(seen)
  })
})
```

Run `npx vitest run apps/orchestrator/test/lead-situations.test.ts` → FAIL (`leadSituations` is not exported). In `apps/orchestrator/src/supervisor.ts` add `workspaceFlow` to the `@slave-of-ai/control` import and `LEAD_SITUATION_KINDS, type WorkspaceFlow` to the `@slave-of-ai/domain` import, add above `supervise`:

```ts
/**
 * Lead flow (plan A L13, spec section 3: "no card is raised while the lead builds"): in a lead-flow
 * project only a stopped goal version and a halt reach a person. Every other project's situations
 * pass through untouched -- the same array, not a copy.
 */
export function leadSituations<T extends { readonly kind: string }>(flow: WorkspaceFlow | null, situations: readonly T[]): readonly T[] {
  return flow === 'lead' ? situations.filter((situation) => LEAD_SITUATION_KINDS.includes(situation.kind)) : situations
}
```

and replace `const situations = filterFresh(observe(world), world)` with:

```ts
  const situations = filterFresh([...leadSituations(await workspaceFlow(deps.workspaceId), observe(world))], world)
```

Run the test → PASS, and `npx vitest run apps/orchestrator/test/integration/supervisor.test.ts` → PASS (unchanged).

- [ ] **Step 6: CLI.** In `apps/orchestrator/src/cli.ts` import `setFlow`, `setLeadSettings` from `@slave-of-ai/control`. Usage text, after the `set-delivery` entry:

```
  set-flow --workspace <id> --flow <packages|lead> [--auto-merge <on|off>] [--model <id>]
                                       put a project into the lead flow (one lead builds a goal
                                       version, Slave proves it) or back. Refused while a goal
                                       version is open or a run is live. Into lead: the project is
                                       conducted, automatic merge goes on unless --auto-merge off.
  set-lead --workspace <id> [--time-limit-min <n|none>] [--roster <id,id,...|none>] [--model <id>]
                                       a lead-flow project's settings: the goal's working-time
                                       limit, the persons its subordinate sessions are defined
                                       from, and the model of its lead, verifier and confirmer.
```

After `case 'set-delivery': { … }`:

```ts
    case 'set-flow': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const flow = oneOfFlag(flags, 'flow', ['packages', 'lead'] as const)
      if (flow === undefined) throw new Error('--flow is required')
      const autoMerge = oneOfFlag(flags, 'auto-merge', ['on', 'off'] as const)
      const model = flagText(flags, 'model')
      const result = await setFlow(workspaceId, flow, { ...(autoMerge === undefined ? {} : { autoMerge: autoMerge === 'on' }), ...(model === undefined ? {} : { model }) })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`${JSON.stringify(result.value)}\n`)
      return 0
    }

    case 'set-lead': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const limitText = flagText(flags, 'time-limit-min')
      const rosterText = flagText(flags, 'roster')
      const model = flagText(flags, 'model')
      if (limitText === undefined && rosterText === undefined && model === undefined) throw new Error('one of --time-limit-min, --roster or --model is required')
      // Handed on as a number and NOT checked here: `setLeadSettings` owns the bounds and the sentence.
      const result = await setLeadSettings(workspaceId, {
        ...(limitText === undefined ? {} : { timeLimitMs: limitText === 'none' ? null : Number(limitText) * 60_000 }),
        ...(rosterText === undefined ? {} : { roster: rosterText === 'none' ? [] : rosterText.split(',').map((id) => id.trim()).filter((id) => id !== '') }),
        ...(model === undefined ? {} : { model }),
      })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`${JSON.stringify(result.value)}\n`)
      return 0
    }
```

In `apps/orchestrator/test/integration/cli.test.ts`, after the two `set-delivery` cases:

```ts
  it('set-flow puts a workspace into the lead flow and set-lead sets its time limit', async (): Promise<void> => {
    await prisma.providerConfiguration.create({ data: { workspaceId: fixture.workspaceId, kind: 'claude_code', settings: {} } }).catch(() => undefined)
    const flow = await runCli(['set-flow', '--workspace', fixture.workspaceId, '--flow', 'lead'])
    expect(flow.code).toBe(0)
    expect(JSON.parse(flow.stdout)).toEqual({ flow: 'lead', changed: true })
    const limit = await runCli(['set-lead', '--workspace', fixture.workspaceId, '--time-limit-min', '90'])
    expect(JSON.parse(limit.stdout)).toEqual({ timeLimitMs: 5_400_000, roster: [] })
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect([ws.flow, ws.delivery, ws.autoMerge, ws.goalTimeLimitMs]).toEqual(['lead', 'conducted', true, 5_400_000])
  })

  it('exits non-zero for set-lead on a workspace that is not in the lead flow', async (): Promise<void> => {
    const result = await runCli(['set-lead', '--workspace', fixture.workspaceId, '--time-limit-min', '90'])
    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/is not in the lead flow/)
  })
```

(`fixture` is this file's own seed; if it already holds a live run or a provider row, seed a second bare workspace in the case with `prisma.workspace.create` and use its id. Read the file's `beforeEach` before writing the case.)

- [ ] **Step 7: Run.** `npx tsc --build && npx vitest run packages/control/test/integration/lead-flow.test.ts apps/orchestrator/test/lead-situations.test.ts`, then `npx vitest run apps/orchestrator/test/integration/cli.test.ts -t "set-flow|set-lead"`, then `npx vitest run packages/control/test/integration -t "workspaceStats"` (the existing stats cases, unchanged) → PASS. `npm run typecheck`.

- [ ] **Step 8: Commit**

```bash
git add packages/control/src/lead/flow.ts packages/control/src/index.ts packages/control/src/refusal.ts packages/control/src/stats.ts packages/control/test/integration/lead-flow.test.ts apps/orchestrator/src/supervisor.ts apps/orchestrator/src/cli.ts apps/orchestrator/test/lead-situations.test.ts apps/orchestrator/test/integration/cli.test.ts
git commit -m "feat(lead): a project can be put into the lead flow, with its three system seats, its time limit and its roster

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: The subordinate-session tool joins the permission vocabulary (B2, L17)

**Files:**
- Modify: `packages/domain/src/provider/claude-code.ts:67-73` (`CLAUDE_CODE_TOOLS.run_commands`)
- Modify: `scripts/gate-m26-vocabulary.mjs` (a second, case-sensitive protected pattern), `scripts/rename-agent-to-slave.mjs` (`PROTECTED_TOKENS` and one `selfTest` case)
- Modify: `scripts/gate-m56a-provider-contract.mjs:161` (`CLAUDE_VOCABULARY_NAMES` 38 → 39)
- Modify (regenerated, Step 4): `scripts/fixtures/m56a-goldens/permissions-claude_code-{implementation,review,planning,verification}-{baseline,granted}.json` (8 files); Modify by hand: `scripts/fixtures/m56a-goldens/tools-by-kind.json`, `scripts/fixtures/m56a-goldens/README.md`
- Test: `packages/domain/test/permission/kinds.test.ts:95-110` (the list; `'Task'` is at `:99`) plus one new case, `packages/domain/test/permission/resolve.test.ts:28`, `packages/control/test/permission-mapping.test.ts:49`, `apps/orchestrator/test/integration/resume-execution.test.ts:208`, `apps/orchestrator/test/integration/tick.test.ts:588`

**Interfaces:**
- Produces: `TOOL_VOCABULARY.claude_code['Agent'] === 'run_commands'`; every `permissions.json` written for a Claude run carries the name in its `vocabulary`, and in `allow` when `run_commands` is granted.
- Which is data and which is code (L17): the hook reads the names from the run's `permissions.json`; the names come from `CLAUDE_CODE_TOOLS`. `scripts/lib/permissions.sh` holds no tool name. The five hook-plane scripts and `hook-plane-sha256.json` do not change.
- Changed for `packages`, on purpose: a Claude run of any kind that holds `run_commands` may now call the tool the installed CLI names `Agent`, where it was denied `ungoverned_tool`. The same tool under its older name `Task` was always allowed. `IMPLEMENTATION_WORK_RULES` still tells a package worker not to hand work to helpers; that text does not change.

- [ ] **Step 1: Failing tests.** In `packages/domain/test/permission/kinds.test.ts`, in the `run_commands.claude_code` list of the `TOOLS_BY_KIND` case, insert `'Agent',` between `'Task',` and `'TaskStop',`. After the case "puts the two tools that SPAWN work under the shell grant, not under the read grant" add:

```ts
  it('governs the subordinate-session tool under both of its names, beside each other (lead flow B2)', () => {
    // The installed CLI names the tool `Agent`; its older name `Task` is what the recorded fixture
    // advertises. Ungoverned, the newer name is denied `ungoverned_tool` under `all-tools`.
    expect(TOOL_VOCABULARY.claude_code['Agent']).toBe('run_commands')
    expect(toolKindFor('claude_code', 'Agent')).toBe('run_commands')
    const shell = TOOLS_BY_KIND.run_commands.claude_code
    expect(shell.indexOf('Agent')).toBe(shell.indexOf('Task') + 1)
    expect(toolKindFor('cursor', 'Agent')).toBeNull()
  })
```

In `packages/domain/test/permission/resolve.test.ts` insert `{ tool: 'Agent', kind: 'run_commands' },` after `{ tool: 'Task', kind: 'run_commands' },`. In `packages/control/test/permission-mapping.test.ts:49`, `apps/orchestrator/test/integration/resume-execution.test.ts:208` and `apps/orchestrator/test/integration/tick.test.ts:588` insert `'Agent',` after `'Task',` in each list.

Run `npx vitest run packages/domain/test/permission` → FAIL (the list lacks the name; `TOOL_VOCABULARY.claude_code['Agent']` is undefined).

- [ ] **Step 2: The vocabulary.** In `packages/domain/src/provider/claude-code.ts`, in `run_commands`, after `'Task',`:

```ts
    // Lead-flow spec B2: the installed CLI names its subordinate-session tool `Agent`; `Task` is
    // the same tool's older name, kept for the CLI versions that still advertise it. Rule (b), as
    // for `Task`: it starts something that can run a command.
    'Agent',
```

Run `npx tsc --build && npx vitest run packages/domain/test/permission packages/control/test/permission-mapping.test.ts` → PASS.

- [ ] **Step 3: The vocabulary gate.** The gate's pattern matches the tool name as a word. It is the vendor's name and appears only as a quoted literal. In `scripts/gate-m26-vocabulary.mjs`, after `const PROTECTED = …`:

```js
// Lead-flow plan A L17: Claude Code names its subordinate-session tool `Agent`. The name is the
// vendor's, like `cursor-agent`, and it is protected only as a QUOTED literal and only in that
// exact case -- so a quoted lowercase word, or the bare word in prose, is still an offender.
const PROTECTED_EXACT = /(["'`])Agent\1/g
```

and change the offender filter's `line.replace(PROTECTED, '')` to `line.replace(PROTECTED, '').replace(PROTECTED_EXACT, '')`. In `scripts/rename-agent-to-slave.mjs` add `/(["'`])Agent\1/g,` to `PROTECTED_TOKENS` (with the same comment) and this case to `selfTest`'s `cases`, after the `agent_message_sent` one:

```js
    // Lead-flow plan A L17: Claude Code's tool name survives as a quoted literal, in that case only.
    ['words', "the 'Agent' tool, \"Agent\", `Agent` and an agent", "the 'Agent' tool, \"Agent\", `Agent` and a slave"],
```

Run `node scripts/rename-agent-to-slave.mjs --self-test` and `node scripts/gate-m26-vocabulary.mjs` → `PASS: the word is slave everywhere it is ours`.

- [ ] **Step 4: The goldens.** The eight Claude `permissions-*.json` goldens carry the vocabulary byte for byte. Regenerate them with the gate's own fixed inputs (`GOLDEN_RUN_ID`, `GOLDEN_RUN_TOKEN`, `GOLDEN_VERIFICATION_OWNERSHIP` at `scripts/gate-m56a-provider-contract.mjs:153-158`; copy them exactly):

```bash
npx tsc --build
node --input-type=module -e "
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePermissionsFile } from './packages/control/dist/index.js'
import { PERMISSION_KINDS, PERMISSION_RUN_KINDS } from './packages/domain/dist/index.js'
const grantSets = { baseline: [], granted: PERMISSION_KINDS.map((kind) => ({ kind, mode: 'allow' })) }
for (const runKind of PERMISSION_RUN_KINDS) {
  for (const [name, rows] of Object.entries(grantSets)) {
    const dir = mkdtempSync(join(tmpdir(), 'm56a-golden-'))
    const written = writePermissionsFile(dir, {
      rows, provider: 'claude_code', runKind,
      runId: '00000000-0000-4000-8000-000000000m56', runToken: 'm56a-golden-token-not-a-secret',
      ...(runKind === 'verification' ? { ownership: { worktreeRoot: '/m56a-golden/verify-worktree', owned: [], excluded: [] } } : {}),
    })
    copyFileSync(written, 'scripts/fixtures/m56a-goldens/permissions-claude_code-' + runKind + '-' + name + '.json')
  }
}
"
git diff --stat scripts/fixtures/m56a-goldens
```

Expected: exactly the eight `permissions-claude_code-*` files changed, each by insertions only (one `vocabulary` line everywhere; one `allow` entry of four lines where `run_commands` is granted); no `permissions-cursor-*` file changed. Read one diff (`git diff scripts/fixtures/m56a-goldens/permissions-claude_code-review-baseline.json`) and confirm nothing else moved. Then by hand: in `scripts/fixtures/m56a-goldens/tools-by-kind.json` add `"Agent",` after `"Task",` in `run_commands.claude_code`; in `scripts/gate-m56a-provider-contract.mjs` set `const CLAUDE_VOCABULARY_NAMES = 39`; and append to `scripts/fixtures/m56a-goldens/README.md`:

```markdown
Lead-flow Plan A (2026-10-04) re-pinned the eight Claude `permissions-*` files and `tools-by-kind.json`
on purpose: the subordinate-session tool's current name joined `run_commands` beside its older name
`Task` (spec B2). They were written by `writePermissionsFile` with the gate's fixed run id and token (the
command is in `docs/superpowers/plans/2026-10-04-lead-flow-a.md`, Task 3); the eight Cursor files and the
hook-plane digests did not change.
```

- [ ] **Step 5: Run.** `npx vitest run packages/domain/test/permission packages/control/test/permission-mapping.test.ts`, then `npx vitest run apps/orchestrator/test/integration/resume-execution.test.ts`, then `npx vitest run apps/orchestrator/test/integration/tick.test.ts` → PASS. `node scripts/gate-m26-vocabulary.mjs` → PASS. `npm run typecheck`. (The m56a gate itself runs in Task 12, on the gate database.)

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/provider/claude-code.ts packages/domain/test/permission packages/control/test/permission-mapping.test.ts apps/orchestrator/test/integration/resume-execution.test.ts apps/orchestrator/test/integration/tick.test.ts scripts/gate-m26-vocabulary.mjs scripts/rename-agent-to-slave.mjs scripts/gate-m56a-provider-contract.mjs scripts/fixtures/m56a-goldens
git commit -m "feat(permission): the subordinate-session tool is governed under its current name, beside the old one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The adapter resumes a session at spawn, reads its spawn extras, and names the subordinate; the roster's definitions

**Files:**
- Modify: `packages/domain/src/lead/constants.ts` (add `SUBORDINATE_TOOLS`), create `packages/domain/src/lead/roster.ts`, modify `packages/domain/src/lead/index.ts`
- Modify: `packages/domain/src/events/schema.ts` (`run.tool_call` payload gains `subagent` and `parentToolUseId`)
- Modify: `packages/providers/src/runtime/process.ts` (spawn extras; `buildChildEnv`'s `keepAliveForSubordinates`; the package index already re-exports this module whole)
- Modify: `packages/providers/src/contract/adapter.ts` (`StartRunInput.resumeSessionId`)
- Modify: `packages/providers/src/claude/adapter.ts` (`spawnRun` at `:263-303`, `resume` from `:521`)
- Modify: `packages/providers/src/types.ts` (`tool_call.subagent`, `tool_call.parentToolUseId`), `packages/providers/src/claude/stream.ts` (`assistantEnvelopeSchema` at `:383`, `parseAssistantLine` at `:407-435`)
- Modify: `apps/orchestrator/src/pump.ts:824-829` (the `run.tool_call` emit)
- Modify: `packages/providers/test/fake-claude.mjs` (eight knobs on the `m8-flow` work arm at `:1424-1450`)
- Test: `packages/domain/test/lead/roster.test.ts` (new), `packages/providers/test/adapter-lead.test.ts` (new), `packages/providers/test/stream.test.ts` (two cases), `packages/providers/test/runtime-process.test.ts` (one case), `apps/orchestrator/test/integration/pump.test.ts` (one case after "forwards the parser-derived readable summary…")

**Interfaces:**
- Produces (domain): `SUBORDINATE_TOOLS: readonly string[]`; `interface RosterMember { readonly personId: string; readonly name: string; readonly description: string; readonly instructions: string }`; `rosterSlug(name: string): string`; `buildRosterDefinitions(members: readonly RosterMember[]): { readonly json: string | null; readonly slugs: ReadonlyMap<string, string>; readonly dropped: readonly string[] }` (`slugs` maps a definition's key to its `personId`; `dropped` are the names that did not fit).
- Produces (providers): `interface SpawnExtras { readonly sessionDefinitions?: string; readonly maxBudgetUsd?: number; readonly keepAliveForSubordinates?: boolean }`; `spawnExtrasPathFor(runDir: string): string`; `writeSpawnExtras(runDir: string, extras: SpawnExtras): void`; `readSpawnExtras(runDir: string): SpawnExtras`; `StartRunInput.resumeSessionId?: string`; `RuntimeEvent` `tool_call` gains `readonly subagent?: string` (a TOP-LEVEL subordinate call only, C1) and `readonly parentToolUseId?: string` (the line's `parent_tool_use_id`, absent when null: the call was made inside the subordinate session that call started).
- Produces (event): `run.tool_call.payload.subagent?: string` (1..200); `run.tool_call.payload.parentToolUseId?: string` (1..200).
- Produces (fake CLI, `m8-flow` work arm only): `--no-work`, `--no-commit`, `--extra-file-base64 <path>:<base64>`, `--final-text-base64 <base64>`, `--result-patch-base64 <base64 JSON>`, `--subordinate <name>`, `--subordinate-unfinished`, `--fail-resume`.
- Unchanged for `packages`: with no `resumeSessionId` and no `spawn-extras.json` the argv and the environment are byte-identical to today's (`argv.json` golden and `CHILD_ENV_ALLOW` do not move); `subagent` is absent on every call whose tool is not a subordinate tool, whose input names none, or that a subordinate made; `parentToolUseId` is absent on every line whose `parent_tool_use_id` is null, which is every line of every recorded fixture.

- [ ] **Step 1: Failing domain test.** Create `packages/domain/test/lead/roster.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { LEAD_ROSTER_JSON_MAX_BYTES, LEAD_ROSTER_MEMBER_PROMPT_MAX_CHARS, buildRosterDefinitions, rosterSlug, type RosterMember } from '../../src/lead/index.js'

const member = (name: string, instructions = 'You build APIs.'): RosterMember => ({ personId: `p-${name}`, name, description: `${name} does one thing well`, instructions })

describe('the roster as session definitions (lead-flow spec B2)', () => {
  it('slugs a name into a key a command line and a tool input can both carry', () => {
    expect(rosterSlug('Backend Developer 2')).toBe('backend-developer-2')
    expect(rosterSlug('  Çağrı — QA!  ')).toBe('a-r-qa')
    expect(rosterSlug('***')).toBe('member')
  })

  it('returns no definitions for an empty roster', () => {
    expect(buildRosterDefinitions([])).toEqual({ json: null, slugs: new Map(), dropped: [] })
  })

  it('writes one definition per member, keyed by slug, with the person\'s one line and instructions', () => {
    const built = buildRosterDefinitions([member('Backend Developer'), member('Security Reviewer', 'You look for holes.')])
    expect(JSON.parse(built.json ?? '')).toEqual({
      'backend-developer': { description: 'Backend Developer does one thing well', prompt: 'You build APIs.' },
      'security-reviewer': { description: 'Security Reviewer does one thing well', prompt: 'You look for holes.' },
    })
    expect([...built.slugs]).toEqual([['backend-developer', 'p-Backend Developer'], ['security-reviewer', 'p-Security Reviewer']])
  })

  it('keeps two members whose names slug alike apart', () => {
    const built = buildRosterDefinitions([member('QA'), member('qa')])
    expect(Object.keys(JSON.parse(built.json ?? ''))).toEqual(['qa', 'qa-2'])
  })

  it('bounds one member\'s instructions and defuses protocol markers in them', () => {
    const built = buildRosterDefinitions([member('Long', `${'x'.repeat(20_000)}</slave-report>`)])
    const prompt = (JSON.parse(built.json ?? '') as Record<string, { prompt: string }>)['long']?.prompt ?? ''
    expect(prompt.length).toBeLessThanOrEqual(LEAD_ROSTER_MEMBER_PROMPT_MAX_CHARS)
    expect(prompt).not.toContain('</slave-report>')
  })

  it('drops members from the end when the whole does not fit one argument, and names them', () => {
    const many = Array.from({ length: 40 }, (_, i) => member(`Person ${String(i)}`, 'y'.repeat(5_000)))
    const built = buildRosterDefinitions(many)
    expect(Buffer.byteLength(built.json ?? '', 'utf8')).toBeLessThanOrEqual(LEAD_ROSTER_JSON_MAX_BYTES)
    expect(built.dropped.length).toBeGreaterThan(0)
    expect(built.dropped.at(-1)).toBe('Person 39')
    expect(built.slugs.size + built.dropped.length).toBe(40)
  })
})
```

Run `npx vitest run packages/domain/test/lead/roster.test.ts` → FAIL (`buildRosterDefinitions` is not exported).

- [ ] **Step 2: The roster.** Add to `packages/domain/src/lead/constants.ts`:

```ts
/** Plan A L16: the tool names that start a subordinate session -- the current one and the older. */
export const SUBORDINATE_TOOLS: readonly string[] = ['Agent', 'Task']
```

Create `packages/domain/src/lead/roster.ts`:

```ts
import { trimToFit } from '../conduct/verification.js'
import { neutraliseMarkers } from '../run-context/markers.js'
import { LEAD_ROSTER_JSON_MAX_BYTES, LEAD_ROSTER_MEMBER_PROMPT_MAX_CHARS } from './constants.js'

/** One person of the roster, as a subordinate-session definition is built from them. */
export interface RosterMember {
  readonly personId: string
  readonly name: string
  /** One line on when to use them. */
  readonly description: string
  /** The person's instructions with their skills, already gathered. */
  readonly instructions: string
}

/** A name as a definition key: lower-case ASCII letters, digits and hyphens, at most 40. */
export function rosterSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug === '' ? 'member' : slug
}

/**
 * Lead-flow spec B2 (plan A L16): the roster as the `--agents` value -- one definition per member,
 * `{ description, prompt }`, keyed by a slug of the name. The instructions are catalogue text: their
 * protocol markers are defused and each is bounded. The whole is ONE argv string, so members that
 * would take it past `LEAD_ROSTER_JSON_MAX_BYTES` are dropped from the end and named in `dropped`.
 * `json` is null for an empty roster: no flag is passed.
 */
export function buildRosterDefinitions(members: readonly RosterMember[]): {
  readonly json: string | null
  readonly slugs: ReadonlyMap<string, string>
  readonly dropped: readonly string[]
} {
  const definitions: Record<string, { description: string; prompt: string }> = {}
  const slugs = new Map<string, string>()
  const dropped: string[] = []
  for (const member of members) {
    if (dropped.length > 0) {
      dropped.push(member.name)
      continue
    }
    const base = rosterSlug(member.name)
    let key = base
    for (let n = 2; slugs.has(key); n += 1) key = `${base}-${String(n)}`
    const candidate = {
      description: trimToFit(neutraliseMarkers(member.description).replace(/\s+/g, ' ').trim(), 300),
      prompt: trimToFit(neutraliseMarkers(member.instructions), LEAD_ROSTER_MEMBER_PROMPT_MAX_CHARS),
    }
    if (Buffer.byteLength(JSON.stringify({ ...definitions, [key]: candidate }), 'utf8') > LEAD_ROSTER_JSON_MAX_BYTES) {
      dropped.push(member.name)
      continue
    }
    definitions[key] = candidate
    slugs.set(key, member.personId)
  }
  return { json: slugs.size === 0 ? null : JSON.stringify(definitions), slugs, dropped }
}
```

Add `export * from './roster.js'` to `packages/domain/src/lead/index.ts`. Run the test → PASS.

- [ ] **Step 3: Failing provider tests.** Create `packages/providers/test/adapter-lead.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runId, type RunId } from '@slave-of-ai/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ClaudeCodeAdapter, type StartRunInput } from '../src/claude/adapter.js'
import { readSpawnExtras, writeSpawnExtras } from '../src/runtime/process.js'
import { copyGateInto } from './helpers/gate-fixture.js'

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const spawned = z.object({ env: z.record(z.string()), argv: z.array(z.string()) })

/** Drains the run and returns what the `env-echo` fixture saw: its own argv and environment. */
async function echoOf(adapter: ClaudeCodeAdapter, id: RunId): Promise<z.infer<typeof spawned>> {
  for await (const event of adapter.events(id)) void event
  return spawned.parse(adapter.rawTerminalPayload(id))
}

const after = (argv: readonly string[], flag: string): string | undefined => {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

describe('ClaudeCodeAdapter and a lead turn (lead-flow plan A L4/L6/L16)', () => {
  let dir: string
  let input: StartRunInput
  let adapter: ClaudeCodeAdapter

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'slaveofai-adapter-lead-'))
    adapter = new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'env-echo'], hookPath: copyGateInto(dir, 'pause-gate.sh') })
    input = {
      runId: runId('run-lead'),
      prompt: 'continue',
      worktreePath: dir,
      pauseFlagPath: path.join(dir, 'pause.flag'),
      runDir: dir,
      permissionsFilePath: path.join(dir, 'permissions.json'),
      gitIdentity: { name: 'Lead', email: 'lead@example.com' },
    }
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('spawns exactly as before with no session to resume and no extras file', async (): Promise<void> => {
    await adapter.start(input)
    const { argv, env } = await echoOf(adapter, input.runId)
    for (const flag of ['--resume', '--agents', '--max-budget-usd']) expect(argv).not.toContain(flag)
    expect(env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS']).toBeUndefined()
    expect(readSpawnExtras(dir)).toEqual({})
  })

  it('resumes a named session at a first spawn', async (): Promise<void> => {
    await adapter.start({ ...input, resumeSessionId: 'sess-7' })
    const { argv } = await echoOf(adapter, input.runId)
    expect(after(argv, '--resume')).toBe('sess-7')
    expect(argv).not.toContain('--fork-session')
  })

  it('passes the roster, the budget cap and the keep-alive from the run directory\'s extras file', async (): Promise<void> => {
    const definitions = JSON.stringify({ 'backend-developer': { description: 'builds APIs', prompt: 'You build APIs.' } })
    writeSpawnExtras(dir, { sessionDefinitions: definitions, maxBudgetUsd: 12.5, keepAliveForSubordinates: true })
    await adapter.start(input)
    const { argv, env } = await echoOf(adapter, input.runId)
    expect(after(argv, '--agents')).toBe(definitions)
    expect(after(argv, '--max-budget-usd')).toBe('12.5')
    expect(env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS']).toBe('0')
  })

  it('reads an unreadable or wrongly shaped extras file as none', () => {
    writeSpawnExtras(dir, { maxBudgetUsd: -1, sessionDefinitions: '' })
    expect(readSpawnExtras(dir)).toEqual({})
  })

  it('carries the same extras into a resume of a paused turn', async (): Promise<void> => {
    writeSpawnExtras(dir, { maxBudgetUsd: 3, keepAliveForSubordinates: true })
    const hookPath = path.join(dir, 'pause-gate.sh')
    await adapter.resume(
      input.runId,
      {
        sessionId: 'sess-7', worktreePath: dir, pauseFlagPath: input.pauseFlagPath, settingsPath: path.join(dir, 'settings.json'), hookPath,
        gitAuthorName: 'Lead', gitAuthorEmail: 'lead@example.com', lastToolUseId: null, lastToolName: null, numTurns: 0,
        deniedToolUseIds: [], headCommit: '', dirtyFiles: [], cumulativeCostUsd: 0, cumulativeTokens: 0,
      },
      'go on',
    )
    const { argv, env } = await echoOf(adapter, input.runId)
    expect(after(argv, '--resume')).toBe('sess-7')
    expect(after(argv, '--max-budget-usd')).toBe('3')
    expect(env['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS']).toBe('0')
  })
})
```

In `packages/providers/test/stream.test.ts` add (use the file's own `parseStreamLine` import):

```ts
describe('a subordinate call names its session definition (lead flow L16, C1)', () => {
  const line = (name: string, input: unknown, parent: string | null = null): string =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name, input }] }, parent_tool_use_id: parent })

  it('carries subagent_type as `subagent` for the subordinate tool under either name', () => {
    expect(parseStreamLine(line('Agent', { subagent_type: 'backend-developer', description: 'build the API', prompt: 'x' }))).toMatchObject({ kind: 'tool_call', toolName: 'Agent', subagent: 'backend-developer' })
    expect(parseStreamLine(line('Task', { subagent_type: 'general-purpose', prompt: 'x' }))).toMatchObject({ kind: 'tool_call', subagent: 'general-purpose' })
  })

  it('carries no such field for any other tool, or when the input names none', () => {
    expect(parseStreamLine(line('Bash', { subagent_type: 'x', command: 'ls' }))).not.toHaveProperty('subagent')
    expect(parseStreamLine(line('Agent', { prompt: 'x' }))).not.toHaveProperty('subagent')
    expect(parseStreamLine(line('Agent', { subagent_type: '   ' }))).not.toHaveProperty('subagent')
  })

  it('carries the parent call on a line a subordinate session wrote, and names no subordinate there (C1)', () => {
    const inner = parseStreamLine(line('Agent', { subagent_type: 'qa', prompt: 'x' }, 'tu_parent'))
    expect(inner).toMatchObject({ kind: 'tool_call', toolName: 'Agent', parentToolUseId: 'tu_parent' })
    expect(inner).not.toHaveProperty('subagent')
    expect(parseStreamLine(line('Bash', { command: 'ls' }, 'tu_parent'))).toMatchObject({ parentToolUseId: 'tu_parent' })
    expect(parseStreamLine(line('Bash', { command: 'ls' }))).not.toHaveProperty('parentToolUseId')
  })
})
```

In `packages/providers/test/runtime-process.test.ts` add one case to the `buildChildEnv` describe (use the file's own input fixture for the required fields):

```ts
  it('sets the print-mode background wait ceiling to 0 only when asked (lead flow B6)', () => {
    const base = { gitIdentity: { name: 'a', email: 'a@b' }, pauseFlagPath: '/r/pause.flag', permissionsFilePath: '/r/permissions.json' }
    expect(buildChildEnv(base)['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS']).toBeUndefined()
    expect(buildChildEnv({ ...base, keepAliveForSubordinates: true })['CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS']).toBe('0')
  })
```

In `apps/orchestrator/test/integration/pump.test.ts`, after the case "forwards the parser-derived readable summary on run.tool_call…":

```ts
  it('carries the session definition a subordinate call named on run.tool_call, and the parent call on a subordinate\'s own call (lead flow L16, C1)', async (): Promise<void> => {
    await pumpRun({
      ...ids,
      events: fromArray([
        { kind: 'session_started', sessionId: 's-1' },
        { kind: 'tool_call', toolUseId: 'tu_1', toolName: 'Agent', summary: 'subordinate: build the API', argsHash: testArgsHash('a'), subagent: 'backend-developer' },
        { kind: 'tool_call', toolUseId: 'tu_2', toolName: 'Bash', summary: 'Bash ls', argsHash: testArgsHash('b'), parentToolUseId: 'tu_1' },
        { kind: 'terminated', outcome: okOutcome },
      ]),
    })
    const rows = await prisma.executionEvent.findMany({ where: { runId: ids.runId, type: 'run_tool_call' }, orderBy: { seq: 'asc' }, select: { payload: true } })
    expect(rows.map((row) => (row.payload as { subagent?: string }).subagent)).toEqual(['backend-developer', undefined])
    // C1: the subordinate's own call carries the call that started its session.
    expect(rows.map((row) => (row.payload as { parentToolUseId?: string }).parentToolUseId)).toEqual([undefined, 'tu_1'])
  })
```

Run `npx vitest run packages/providers/test/adapter-lead.test.ts` → FAIL (`readSpawnExtras` is not exported).

- [ ] **Step 4: Spawn extras and the environment.** In `packages/providers/src/runtime/process.ts` add `readFileSync, writeFileSync` to the `node:fs` import and, after `verifyDirIfPresent`:

```ts
/**
 * Lead-flow plan A (L4/L6/L16): what a spawn carries beyond the contract every run has -- the
 * roster as session definitions (`--agents`), the leg's budget cap (`--max-budget-usd`), and
 * whether the child must wait for its background subordinates before ending (spec B6: a session is
 * never ended while its subordinates work).
 */
export interface SpawnExtras {
  /** The `--agents` value: the roster as session definitions, one JSON object. */
  readonly sessionDefinitions?: string
  readonly maxBudgetUsd?: number
  readonly keepAliveForSubordinates?: boolean
}

/** `<runDir>/spawn-extras.json` -- the ONE definition of the name, for `permissionsFilePathFor`'s reason. */
export function spawnExtrasPathFor(runDir: string): string {
  return join(runDir, 'spawn-extras.json')
}

/** Written by the orchestrator before a spawn; 0600 like every file of a run directory. */
export function writeSpawnExtras(runDir: string, extras: SpawnExtras): void {
  writeFileSync(spawnExtrasPathFor(runDir), JSON.stringify(extras), { mode: 0o600 })
}

/**
 * The run's extras, or `{}`: the file's presence is the declaration (the `verifyDirIfPresent`
 * idiom), so a resume -- which has only the run directory -- spawns with what the start did. A
 * missing file, an unreadable one, and any field of the wrong shape all read as absent: an extras
 * file may never be the reason a run cannot spawn.
 */
export function readSpawnExtras(runDir: string): SpawnExtras {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(spawnExtrasPathFor(runDir), 'utf8'))
  } catch {
    return {}
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const { sessionDefinitions, maxBudgetUsd, keepAliveForSubordinates } = raw as Record<string, unknown>
  return {
    ...(typeof sessionDefinitions === 'string' && sessionDefinitions !== '' ? { sessionDefinitions } : {}),
    ...(typeof maxBudgetUsd === 'number' && Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0 ? { maxBudgetUsd } : {}),
    ...(keepAliveForSubordinates === true ? { keepAliveForSubordinates: true } : {}),
  }
}
```

In `buildChildEnv`'s input type add, after `verifyDir`:

```ts
  /**
   * Lead-flow spec B6: `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`. A print-mode session otherwise
   * ends 600 s after its turn while a background subordinate still works (measured 2026-10-04).
   * Set here by name, NOT added to `CHILD_ENV_ALLOW`: that list is what a child inherits from this
   * process, and this is a value this process chooses for one kind of run.
   */
  readonly keepAliveForSubordinates?: boolean
```

and in the returned object, after the `SLAVEOFAI_VERIFY_DIR` line:

```ts
    ...(input.keepAliveForSubordinates === true ? { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' } : {}),
```

- [ ] **Step 5: The adapter.** In `packages/providers/src/contract/adapter.ts`, in `StartRunInput` after `runToken`:

```ts
  /**
   * Lead-flow plan A L4: the session this FIRST spawn continues (`--resume <id>`). A turn of a
   * lead's session is a new run on an old session; `resume()` is for a paused run of the same row.
   * Absent on every other run, whose argv is unchanged.
   */
  readonly resumeSessionId?: string
```

In `packages/providers/src/claude/adapter.ts` import `readSpawnExtras, type SpawnExtras` from `'../runtime/process.js'`, and add above the class:

```ts
/** The argv a run's spawn extras add; nothing for a run without the file. */
function extrasArgs(extras: SpawnExtras): readonly string[] {
  return [
    ...(extras.sessionDefinitions === undefined ? [] : ['--agents', extras.sessionDefinitions]),
    ...(extras.maxBudgetUsd === undefined ? [] : ['--max-budget-usd', String(extras.maxBudgetUsd)]),
  ]
}
```

In `spawnRun`, before `const args = [`, add `const extras = readSpawnExtras(input.runDir)`; in the `args` array, after `input.prompt,` and before the `--model` spread, add:

```ts
      // Lead-flow plan A L4: a lead turn continues the previous turn's session. Never
      // `--fork-session` (ADR 0001 §3): the id must stay the same across turns.
      ...(input.resumeSessionId !== undefined ? ['--resume', input.resumeSessionId] : []),
      ...extrasArgs(extras),
```

and in its `buildChildEnv({ … })` call add `...(extras.keepAliveForSubordinates === true ? { keepAliveForSubordinates: true } : {}),` after the `verifyDirIfPresent` spread. In `resume`, after `const resumedInput: StartRunInput = { … }`, add `const extras = readSpawnExtras(resumedInput.runDir)`; in its `args`, after `checkpoint.sessionId,`, add `...extrasArgs(extras),`; and in its `buildChildEnv({ … })` call add the same `keepAliveForSubordinates` spread after `...verifyDirIfPresent(resumedInput.runDir),`.

- [ ] **Step 6: The subordinate's name and the parent call (L16, C1).** In `packages/providers/src/types.ts`, in the `tool_call` variant after `argsHash`:

```ts
      /** Lead-flow plan A L16 / C1: the session definition a TOP-LEVEL subordinate call named (`subagent_type`). */
      readonly subagent?: string
      /**
       * Lead-flow C1: the line's `parent_tool_use_id` -- the subordinate call whose session made
       * this call. Absent on the session's own calls (the field is null there, as on every line of
       * every recorded fixture).
       */
      readonly parentToolUseId?: string
```

In `packages/providers/src/claude/stream.ts` add `parent_tool_use_id: z.string().nullable().optional(),` to `assistantEnvelopeSchema` (beside `message`; a line without it parses as before), import `SUBORDINATE_TOOLS` from `@slave-of-ai/domain`, and add above `parseAssistantLine`:

```ts
/**
 * Lead-flow plan A L16 / C1: which session definition a subordinate call names, or null -- for the
 * subordinate tool only, only a non-blank string, and only on a call the session made itself
 * (`parent` null): a subordinate that starts a session of its own did not pick from the roster.
 * It is the one argument of that call the log keeps beside the summary: it says which roster
 * person did the work.
 */
function subordinateOf(toolName: string, input: unknown, parent: string | null): string | null {
  if (parent !== null || !SUBORDINATE_TOOLS.includes(toolName) || !isRecord(input)) return null
  const named = input['subagent_type']
  return typeof named === 'string' && named.trim() !== '' ? named.trim().slice(0, 200) : null
}
```

In `parseAssistantLine`, directly above the `return { kind: 'tool_call', … }`, add

```ts
    const parent = envelope.data.parent_tool_use_id ?? null
    const subagent = subordinateOf(result.data.name, result.data.input, parent)
```

and in the returned object, after `argsHash: hashToolInput(result.data.input),`:

```ts
      ...(subagent === null ? {} : { subagent }),
      ...(parent === null || parent === '' ? {} : { parentToolUseId: parent.slice(0, 200) }),
```

In `packages/domain/src/events/schema.ts`, in the `run.tool_call` payload after `argsHash`'s line, add:

```ts
      // Lead-flow plan A L16 / C1: the session definition a top-level subordinate call named, and
      // the subordinate call a nested call was made under. Optional: most calls carry neither.
      subagent: z.string().min(1).max(200).optional(),
      parentToolUseId: z.string().min(1).max(200).optional(),
```

In `apps/orchestrator/src/pump.ts`, in `case 'tool_call'`, the `emit('run.tool_call', 'slave', { … })` object gains, after `argsHash: event.argsHash,`:

```ts
          ...(event.subagent === undefined ? {} : { subagent: event.subagent }),
          ...(event.parentToolUseId === undefined ? {} : { parentToolUseId: event.parentToolUseId }),
```

- [ ] **Step 7: The fake's knobs.** In `packages/providers/test/fake-claude.mjs`, add to the header comment's `m8-flow` entry one paragraph listing the eight flags of this step, and add above `async function main()`:

```js
/**
 * Lead-flow plan A: `--extra-file-base64 <relative path>:<base64 content>` -- one more file a work
 * run writes before its commit (the lead's docs/DECISIONS.md).
 */
function extraFile() {
  const spec = flagValue('--extra-file-base64')
  if (spec === undefined) return undefined
  const at = spec.indexOf(':')
  return at === -1 ? undefined : { file: spec.slice(0, at), content: Buffer.from(spec.slice(at + 1), 'base64').toString('utf8') }
}

/**
 * Lead-flow plan A: patches the `complete` capture's lines in place, each knob a no-op unless its
 * flag is on ARGV. Returns whether any applied.
 *   --subordinate <name>          one `Agent` tool call naming that session definition, one
 *                                 `Bash` call the subordinate made under it (C1: its line carries
 *                                 `parent_tool_use_id`), and both results, right after the init
 *                                 line (`--subordinate-unfinished`: the two calls, no results)
 *   --final-text-base64 <b64>     appended to the final message and the result text
 *   --result-patch-base64 <b64>   a JSON object merged over the terminal `result` line (a budget
 *                                 cap's ending, a cost)
 */
function applyRunKnobs(lines) {
  let applied = false
  const subordinate = flagValue('--subordinate')
  if (subordinate !== undefined) {
    const session = JSON.parse(lines[0]).session_id
    const id = 'toolu_fake_subordinate'
    const innerId = 'toolu_fake_subordinate_inner'
    const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { subagent_type: subordinate, description: 'fake subordinate work', prompt: 'do it' } }] }, parent_tool_use_id: null, session_id: session }
    // C1: what the subordinate itself does arrives on this stream under its parent call's id.
    const inner = { type: 'assistant', message: { content: [{ type: 'tool_use', id: innerId, name: 'Bash', input: { command: 'true', description: 'subordinate check' } }] }, parent_tool_use_id: id, session_id: session }
    const innerResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: innerId, content: '' }] }, parent_tool_use_id: id, session_id: session }
    const result = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] }, parent_tool_use_id: null, session_id: session }
    // `--subordinate-unfinished`: no results -- the subordinate was still working when the turn ended.
    if (args.includes('--subordinate-unfinished')) lines.splice(1, 0, JSON.stringify(call), JSON.stringify(inner))
    else lines.splice(1, 0, JSON.stringify(call), JSON.stringify(inner), JSON.stringify(innerResult), JSON.stringify(result))
    applied = true
  }
  const finalText = flagValue('--final-text-base64')
  if (finalText !== undefined) {
    const suffix = `\n${Buffer.from(finalText, 'base64').toString('utf8')}`
    appendToLastAssistantText(lines, suffix)
    appendToResultText(lines, suffix)
    applied = true
  }
  const patch = flagValue('--result-patch-base64')
  if (patch !== undefined) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const parsed = JSON.parse(lines[i])
      if (parsed.type !== 'result') continue
      lines[i] = JSON.stringify({ ...parsed, ...JSON.parse(Buffer.from(patch, 'base64').toString('utf8')) })
      break
    }
    applied = true
  }
  return applied
}
```

In the `m8-flow` branch of `main`, replace the work body from `const workFile = …` through the end of the branch with:

```js
    // Lead-flow plan A: a resumed turn whose transcript is gone -- nothing on stdout, a non-zero exit.
    if (args.includes('--fail-resume') && args.includes('--resume')) {
      process.stderr.write('No conversation found with session ID\n')
      process.exit(1)
    }
    // Lead-flow plan A: `--no-work` writes and commits nothing (a lead that built nothing);
    // `--no-commit` writes its files and leaves them uncommitted (work the orchestrator commits).
    if (!args.includes('--no-work')) {
      const workFile = path.join(process.cwd(), flagValue('--work-file') ?? 'm8a-work.txt')
      mkdirSync(path.dirname(workFile), { recursive: true })
      writeFileSync(workFile, `${prompt.slice(0, 80)}\n`)
      const extra = extraFile()
      if (extra !== undefined) {
        mkdirSync(path.dirname(path.join(process.cwd(), extra.file)), { recursive: true })
        writeFileSync(path.join(process.cwd(), extra.file), extra.content)
      }
      if (!args.includes('--no-commit')) {
        execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'add', '-A'], { cwd: process.cwd() })
        // `--allow-empty`: a REWORK run adopts its previous attempt's worktree, where this same file
        // with the same first line is already committed -- without it the commit finds nothing, git
        // exits non-zero, and the run dies with no terminal result instead of doing its rework.
        execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@slaveofai.local', 'commit', '-q', '--allow-empty', '-m', 'fake work'], { cwd: process.cwd() })
      }
    }
    // Conductor Plan 2: a package worker ends with a `<slave-report>` block. Scripted on argv, and
    // patched into the same `complete` capture the ask legs patch, so the report reaches the pump
    // through the stream shape a real run produces.
    const report = reportEnvelope()
    const lines = readFixtureLines('complete')
    const knobbed = applyRunKnobs(lines)
    if (report === undefined && !knobbed) {
      await replayFixture('complete')
      return
    }
    if (report !== undefined) {
      const suffix = `\n<slave-report>${report}</slave-report>`
      if (!appendToLastAssistantText(lines, suffix)) {
        process.stderr.write('fake-claude: m8-flow could not find an assistant text block in the complete fixture\n')
        process.exit(2)
      }
      appendToResultText(lines, suffix)
    }
    await writeLines(lines)
    process.exit(0)
```

(The moved comment lines and the three git calls are the existing ones; with none of the new flags on argv the arm does exactly what it did.) The knobs are exercised by the integration tests of Tasks 6 to 11.

- [ ] **Step 8: Run.** `npx tsc --build`, then `npx vitest run packages/domain/test/lead/roster.test.ts packages/providers/test/adapter-lead.test.ts packages/providers/test/stream.test.ts packages/providers/test/runtime-process.test.ts packages/providers/test/adapter-start.test.ts packages/providers/test/adapter-resume.test.ts packages/providers/test/fake-claude.test.ts` → PASS. Then `npx vitest run apps/orchestrator/test/integration/pump.test.ts` → PASS, `npx vitest run apps/orchestrator/test/integration/conductor-e2e.test.ts` → PASS (the fake's work arm is unchanged without the flags). `node scripts/gate-m26-vocabulary.mjs` → PASS. `npm run typecheck`.

- [ ] **Step 9: Commit**

```bash
git add packages/domain/src/lead packages/domain/src/events/schema.ts packages/domain/test/lead/roster.test.ts packages/providers/src packages/providers/test apps/orchestrator/src/pump.ts apps/orchestrator/test/integration/pump.test.ts
git commit -m "feat(providers): a run can continue a session at its first spawn, carry a roster and a budget cap, and say which subordinate a call named

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 5: The lead's instructions (B3), its budget legs (B4), and what a goal version spent

**Files:**
- Create: `packages/domain/src/lead/budget.ts`, `packages/domain/src/lead/brief.ts`; modify `packages/domain/src/lead/index.ts`
- Modify: `packages/domain/src/run-context/sections.ts` (`SectionKind`, `SectionSource`, `Manifest['kind']`, a source schema, the union, `runContextManifestSchema`), `packages/domain/src/run-context/render.ts` (`SECTION_ORDER.lead`, the trailer)
- Modify: `apps/web/src/lib/runContextSummary.ts` (one case after `verification_protocol`)
- Create: `packages/control/src/lead/spend.ts`, `packages/control/src/lead/roster.ts`; modify `packages/control/src/index.ts`
- Create: `apps/orchestrator/src/lead/context.ts`
- Test: `packages/domain/test/lead/budget.test.ts`, `packages/domain/test/lead/brief.test.ts` (new), `packages/domain/test/run-context/render.test.ts:44-51` (the order map) plus one case, `packages/domain/test/run-context/sections.test.ts` (one case), `apps/web/test/runContextSummary.test.ts` (one case), `packages/control/test/integration/lead-spend.test.ts` (new), `apps/orchestrator/test/integration/lead-context.test.ts` (new)

**Interfaces:**
- Produces (domain, `lead/budget.ts`):
  - `leadShareUsd(budgetUsd: number): number`
  - `type LeadLeg = { readonly kind: 'run'; readonly capUsd: number | null; readonly wrapUp: boolean } | { readonly kind: 'spent' }`
  - `nextLeadLeg(input: { readonly budgetUsd: number | null; readonly leadSpentUsd: number; readonly wrapUpSent: boolean }): LeadLeg`
  - `proofCapUsd(budgetUsd: number | null, goalSpentUsd: number): number | null | 'spent'`
  - `isBudgetCapReason(reason: string): boolean`
- Produces (domain, `lead/brief.ts`): `interface LeadBriefInput`, `renderLeadBrief(input: LeadBriefInput): string`, `LEAD_RULES: string`, `renderLeadTurnNote(input: { readonly kind: LeadTurn; readonly note: string | null; readonly baseBranch: string; readonly budgetLeftUsd: number | null; readonly timeLeftMs: number | null }): string`, `renderLeadContinuation(input: { readonly lastCommits: string; readonly then: string }): string`.
- Produces (run context): `Manifest['kind']` gains `'lead'`; `SectionKind` gains `'lead_brief'`; source `{ kind: 'lead_brief', goalVersion: number, turn: string, resumed: boolean, requirements: number, roster: number }`.
- Produces (control): `interface GoalSpend { readonly totalUsd: number; readonly leadUsd: number; readonly proofUsd: number; readonly conductorUsd: number; readonly unmeasuredRuns: number }`; `goalSpend(workspaceId: string, goalVersion: number): Promise<GoalSpend>`; `goalWorkedMs(workspaceId: string, goalVersion: number, now?: Date): Promise<number>`; `loadLeadRoster(personIds: readonly string[], roots?: SkillRoots): Promise<readonly RosterMember[]>`.
- Produces (orchestrator, `lead/context.ts`): `interface LeadContextInput` (Step 7) and `buildLeadContext(input: LeadContextInput): Promise<{ readonly prompt: string }>`.
- Unchanged for `packages`: the four existing manifest kinds keep their order and trailer (the order map's test pins them); `buildRunContext` is not touched.

- [ ] **Step 1: Failing domain tests.** Create `packages/domain/test/lead/budget.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isBudgetCapReason, leadShareUsd, nextLeadLeg, proofCapUsd } from '../../src/lead/index.js'

describe('the lead\'s budget legs (lead-flow spec B4)', () => {
  it('reserves one fifth of the budget for proof', () => {
    expect(leadShareUsd(30)).toBe(24)
  })

  it('caps the first leg at four fifths of the share, less what earlier turns spent', () => {
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 0, wrapUpSent: false })).toEqual({ kind: 'run', capUsd: 19.2, wrapUp: false })
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 5.5, wrapUpSent: false })).toEqual({ kind: 'run', capUsd: 13.7, wrapUp: false })
  })

  it('makes the next leg the wrap-up once the mark is reached, capped at the rest of the share', () => {
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 19.2, wrapUpSent: false })).toEqual({ kind: 'run', capUsd: 4.8, wrapUp: true })
  })

  it('gives a later turn what is left of the share without a second wrap-up', () => {
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 20, wrapUpSent: true })).toEqual({ kind: 'run', capUsd: 4, wrapUp: false })
  })

  it('says spent when less than a spawn is worth is left, and never caps an unbudgeted goal', () => {
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 23.97, wrapUpSent: true })).toEqual({ kind: 'spent' })
    expect(nextLeadLeg({ budgetUsd: 30, leadSpentUsd: 40, wrapUpSent: false })).toEqual({ kind: 'spent' })
    expect(nextLeadLeg({ budgetUsd: null, leadSpentUsd: 99, wrapUpSent: false })).toEqual({ kind: 'run', capUsd: null, wrapUp: false })
  })

  it('caps a proof run at whatever the goal has left, reserve included', () => {
    expect(proofCapUsd(30, 24)).toBe(6)
    expect(proofCapUsd(30, 29.99)).toBe('spent')
    expect(proofCapUsd(null, 500)).toBeNull()
  })

  it('reads a budget cap out of a run\'s terminal reason', () => {
    expect(isBudgetCapReason('budget_exhausted')).toBe(true)
    expect(isBudgetCapReason('error_max_budget_usd.')).toBe(true)
    expect(isBudgetCapReason('error_during_execution.')).toBe(false)
  })
})
```

Create `packages/domain/test/lead/brief.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { LEAD_RULES, renderLeadBrief, renderLeadContinuation, renderLeadTurnNote } from '../../src/lead/index.js'

const ROUTING = ['"verdict"', '"task graph"', '"candidateIndex"', '"sources"', '"replan"', '"personas"', '"intakeAnswer"', '"supervisorReply"', '<slave-verification>', '<slave-ask>', '<slave-report>']

const brief = renderLeadBrief({
  goalVersion: 2,
  goal: 'Build the status page. It must say "verdict" nowhere.',
  requirements: [{ key: 'R1', text: 'GET /health answers 200' }, { key: 'RUN', text: 'The product starts as its README says' }],
  decisions: [{ title: 'Database', decision: 'SQLite, one file' }],
  budget: { totalUsd: 30, shareUsd: 24, spentUsd: 1.5 },
  timeLeftMs: 90 * 60_000,
  roster: [{ slug: 'backend-developer', description: 'builds APIs' }],
})

describe('the lead\'s brief (lead-flow spec B3)', () => {
  it('carries the goal, every requirement, the decisions, the share and the time left, and the roster', () => {
    expect(brief).toContain('THE GOAL (v2)')
    expect(brief).toContain('R1: GET /health answers 200')
    expect(brief).toContain('RUN: The product starts as its README says')
    expect(brief).toContain('- Database: SQLite, one file')
    expect(brief).toContain('Your share is $24.00; $6.00 is kept for proving the result. Spent of your share so far: $1.50.')
    expect(brief).toContain('about 90 minutes')
    expect(brief).toContain('- backend-developer: builds APIs')
  })

  it('treats the goal as data: a routing literal in it is defused', () => {
    expect(brief).not.toContain('"verdict"')
  })

  it('says so when there is no budget, no time limit and no roster', () => {
    const bare = renderLeadBrief({ goalVersion: 1, goal: 'g', requirements: [], decisions: [], budget: null, timeLeftMs: null, roster: [] })
    expect(bare).toContain('No budget is set for this goal.')
    expect(bare).toContain('No time limit is set.')
    expect(bare).not.toContain('YOUR ROSTER')
    expect(bare).not.toContain('DECISIONS ALREADY MADE')
  })

  it('states the rules of the flow and offers no way to ask', () => {
    expect(LEAD_RULES).toContain('docs/DECISIONS.md')
    expect(LEAD_RULES).toContain('Nobody answers questions')
    expect(LEAD_RULES).toContain('closing report')
    for (const literal of ROUTING) expect(LEAD_RULES).not.toContain(literal)
  })
})

describe('a later turn\'s note', () => {
  const base = { baseBranch: 'main', budgetLeftUsd: 4.8, timeLeftMs: 20 * 60_000 }

  it('hands a rework its evidence', () => {
    const note = renderLeadTurnNote({ ...base, kind: 'rework', note: 'R1: GET /health answers 200\ncheck: curl localhost:8080/health\noutput: 404' })
    expect(note).toContain('independent verification')
    expect(note).toContain('output: 404')
    expect(note).toContain('Left of your share: $4.80.')
    expect(note).toContain('about 20 minutes')
  })

  it('tells a wrap-up to commit and report, and an answer turn to decide and record', () => {
    expect(renderLeadTurnNote({ ...base, kind: 'wrap_up', note: null })).toContain('Wrap up now')
    expect(renderLeadTurnNote({ ...base, kind: 'answer', note: null })).toContain('Decide it yourself, record the decision and its reason in docs/DECISIONS.md')
  })

  it('names the base branch in a base turn and says a continued session was interrupted', () => {
    expect(renderLeadTurnNote({ ...base, kind: 'base', note: null })).toContain('git merge main')
    expect(renderLeadTurnNote({ ...base, kind: 'continue', note: 'the daemon restarted' })).toContain('the daemon restarted')
  })

  it('never carries a routing literal of its own', () => {
    for (const kind of ['rework', 'wrap_up', 'continue', 'answer', 'base'] as const) {
      const note = renderLeadTurnNote({ ...base, kind, note: null })
      for (const literal of ROUTING) expect(note).not.toContain(literal)
    }
  })

  it('tells a new session where the lost one stood', () => {
    const block = renderLeadContinuation({ lastCommits: 'abc1234 add the health route', then: 'carry on' })
    expect(block).toContain('its transcript is gone')
    expect(block).toContain('abc1234 add the health route')
    expect(block).toContain('carry on')
  })
})
```

Run `npx vitest run packages/domain/test/lead/budget.test.ts packages/domain/test/lead/brief.test.ts` → FAIL (not exported).

- [ ] **Step 2: Budget legs.** Create `packages/domain/src/lead/budget.ts`:

```ts
import { LEAD_MIN_LEG_USD, LEAD_WRAP_UP_RATIO, PROOF_RESERVE_RATIO } from './constants.js'

/** Dollars cut to whole cents, downwards: a cap is never rounded up past what is left. */
const cents = (usd: number): number => Math.floor(usd * 100 + 1e-6) / 100

/** Lead-flow spec B4: the lead's share of a goal's budget -- all but the fifth kept for proof. */
export function leadShareUsd(budgetUsd: number): number {
  return cents(budgetUsd * (1 - PROOF_RESERVE_RATIO))
}

/** What the lead's next turn may spend: a run with a cap (null: unbudgeted), or nothing left. */
export type LeadLeg = { readonly kind: 'run'; readonly capUsd: number | null; readonly wrapUp: boolean } | { readonly kind: 'spent' }

/**
 * Lead-flow spec B4 (plan A L6): the lead's next leg. Until the wrap-up was sent, a leg runs to four
 * fifths of the share; the leg after that mark is the wrap-up, capped at the rest of the share. A
 * turn after the wrap-up (a rework) gets what is left. Less than `LEAD_MIN_LEG_USD` left is `spent`.
 */
export function nextLeadLeg(input: { readonly budgetUsd: number | null; readonly leadSpentUsd: number; readonly wrapUpSent: boolean }): LeadLeg {
  if (input.budgetUsd === null) return { kind: 'run', capUsd: null, wrapUp: false }
  const share = leadShareUsd(input.budgetUsd)
  const left = cents(share - input.leadSpentUsd)
  if (left < LEAD_MIN_LEG_USD) return { kind: 'spent' }
  const toMark = cents(share * LEAD_WRAP_UP_RATIO - input.leadSpentUsd)
  if (!input.wrapUpSent && toMark >= LEAD_MIN_LEG_USD) return { kind: 'run', capUsd: toMark, wrapUp: false }
  return { kind: 'run', capUsd: left, wrapUp: !input.wrapUpSent }
}

/** Spec B4/§9: what a proof run may spend -- everything the goal has left, the reserve included. */
export function proofCapUsd(budgetUsd: number | null, goalSpentUsd: number): number | null | 'spent' {
  if (budgetUsd === null) return null
  const left = cents(budgetUsd - goalSpentUsd)
  return left < LEAD_MIN_LEG_USD ? 'spent' : left
}

/**
 * Whether a run's terminal reason is the vendor's budget cap. Measured 2026-10-04 (C3): the result
 * line reads `terminal_reason: "budget_exhausted"`; `max_budget` is the subtype's spelling, kept for
 * a line that names only that.
 */
export function isBudgetCapReason(reason: string): boolean {
  return /budget_exhausted|max_budget/i.test(reason)
}
```

- [ ] **Step 3: The brief.** Create `packages/domain/src/lead/brief.ts`:

```ts
import { trimToFit } from '../conduct/verification.js'
import { sanitisePersonText } from '../handoff/contract.js'
import { LEAD_DECISIONS_FILE, type LeadTurn } from './constants.js'

/** What {@link renderLeadBrief} is told about one goal version. */
export interface LeadBriefInput {
  readonly goalVersion: number
  readonly goal: string
  readonly requirements: readonly { readonly key: string; readonly text: string }[]
  readonly decisions: readonly { readonly title: string; readonly decision: string }[]
  /** Null for an unbudgeted goal. `spentUsd` is what the lead's own turns spent so far. */
  readonly budget: { readonly totalUsd: number; readonly shareUsd: number; readonly spentUsd: number } | null
  readonly timeLeftMs: number | null
  readonly roster: readonly { readonly slug: string; readonly description: string }[]
}

const usd = (amount: number): string => `$${amount.toFixed(2)}`
const minutes = (ms: number): string => `about ${String(Math.max(0, Math.round(ms / 60_000)))} minutes`

/**
 * Lead-flow spec B3: what the lead is told at the start of a session -- the goal, every requirement,
 * the decisions already made, its limits and its roster. The goal, the requirements and the
 * decisions are other parties' text and go through `sanitisePersonText`. The rules of the flow are
 * the trailer ({@link LEAD_RULES}), not part of this text.
 */
export function renderLeadBrief(input: LeadBriefInput): string {
  const { budget } = input
  return [
    `THE GOAL (v${String(input.goalVersion)})`,
    '',
    sanitisePersonText(input.goal),
    '',
    'THE REQUIREMENTS (an independent verifier checks each one on the running product):',
    ...input.requirements.map((r) => `${r.key}: ${sanitisePersonText(r.text)}`),
    ...(input.decisions.length === 0
      ? []
      : ['', 'DECISIONS ALREADY MADE (binding):', ...input.decisions.map((d) => `- ${sanitisePersonText(d.title)}: ${sanitisePersonText(d.decision)}`)]),
    '',
    'YOUR LIMITS',
    budget === null
      ? 'No budget is set for this goal.'
      : `The goal's budget is ${usd(budget.totalUsd)}. Your share is ${usd(budget.shareUsd)}; ${usd(budget.totalUsd - budget.shareUsd)} is kept for proving the result. ` +
        `Spent of your share so far: ${usd(budget.spentUsd)}. At four fifths of your share you are told to wrap up; at all of it you are stopped and what is committed is judged.`,
    input.timeLeftMs === null
      ? 'No time limit is set.'
      : `Time left for this goal: ${minutes(input.timeLeftMs)}. When it runs out you are stopped and what is committed is judged.`,
    ...(input.roster.length === 0
      ? []
      : [
          '',
          'YOUR ROSTER (subordinate sessions defined for this goal; start one by its name, or a general one):',
          ...input.roster.map((member) => `- ${member.slug}: ${sanitisePersonText(member.description)}`),
        ]),
    '',
    '---',
  ].join('\n')
}

/**
 * Lead-flow spec B3: the rules of the flow, the last thing a lead reads at the start of a session
 * (the `lead` manifest kind's trailer). No way to ask is offered (spec R-6).
 *
 * Must never contain the fake CLI's routing literals or a protocol marker: every lead prompt carries
 * it, and the fake routes a prompt by them.
 */
export const LEAD_RULES = [
  'How to work: you are the lead of this goal. Build all of it on this branch -- yourself, and through subordinate sessions you start, brief and check.',
  'Stay on this branch. Commit as you go: only what is committed is judged. Never push, never switch branches, never rewrite history.',
  'The README must say exactly how to install, start and use the product, and scripts/smoke.sh must start it and exercise it.',
  `Nobody answers questions while you build. Where the goal leaves something open, decide it yourself and record each decision with its reason in ${LEAD_DECISIONS_FILE}, one "## <title>" heading per decision.`,
  'How the result is judged: an independent verifier installs and starts the product from the README and checks every requirement on the running product. Passing tests are not enough. What it finds comes back to you in this same session.',
  'Finish with a closing report as your final message: what is built, what is not built, and what a person must do before release.',
].join('\n')

const TURN_OPENING: Readonly<Record<Exclude<LeadTurn, 'build'>, string>> = {
  rework: 'The independent verification of your work found what follows. Fix it on this same branch, commit, and finish with your closing report again.',
  wrap_up:
    `You have used four fifths of your share of the budget. Wrap up now: commit what works, make sure the README is exact, record every open decision in ${LEAD_DECISIONS_FILE}, and write your closing report. Say plainly what is not finished.`,
  continue: 'Your session was interrupted and is being continued. Check git status and git log first, then carry on with the goal from where you stood.',
  answer: `Nobody answers questions in this flow. Decide it yourself, record the decision and its reason in ${LEAD_DECISIONS_FILE}, and continue building.`,
  base: '',
}

/**
 * What a later turn of the lead's session is told (plan A L4): why the turn exists, what came back
 * (`note`: a verifier's evidence, a failure, already sanitised by whoever wrote it), and what is
 * left of its share and of the time.
 */
export function renderLeadTurnNote(input: {
  readonly kind: LeadTurn
  readonly note: string | null
  readonly baseBranch: string
  readonly budgetLeftUsd: number | null
  readonly timeLeftMs: number | null
}): string {
  const opening =
    input.kind === 'base'
      ? `The base branch ${input.baseBranch} moved while you worked and no longer merges cleanly. Merge it into this branch (git merge ${input.baseBranch}), resolve the conflicts, make sure the product still starts and works, and commit.`
      : input.kind === 'build'
        ? 'Continue building the goal.'
        : TURN_OPENING[input.kind]
  return [
    opening,
    ...(input.note === null || input.note.trim() === '' ? [] : ['', trimToFit(input.note, 12_000)]),
    '',
    ...(input.budgetLeftUsd === null ? [] : [`Left of your share: ${usd(input.budgetLeftUsd)}.`]),
    ...(input.timeLeftMs === null ? [] : [`Time left for this goal: ${minutes(input.timeLeftMs)}.`]),
  ]
    .join('\n')
    .trimEnd()
}

/** A new session after one whose transcript is gone (spec B6): where the last one stood, then what to do. */
export function renderLeadContinuation(input: { readonly lastCommits: string; readonly then: string }): string {
  return [
    'CONTINUATION',
    '',
    'An earlier session worked on this goal on this branch and its transcript is gone. The branch holds its work. Its last commits:',
    trimToFit(sanitisePersonText(input.lastCommits.trim() === '' ? '(none yet)' : input.lastCommits), 2_000),
    '',
    'Read the repository before you change anything. Then:',
    input.then,
    '',
    '---',
  ].join('\n')
}
```

Add `export * from './budget.js'` and `export * from './brief.js'` to `packages/domain/src/lead/index.ts`. Run the two tests → PASS.

- [ ] **Step 4: The `lead` manifest kind, failing test first.** In `packages/domain/test/run-context/render.test.ts`, add `lead: ['profile', 'lead_brief'],` to the expected `SECTION_ORDER` map (after `verification`) and add:

```ts
describe('the lead kind (lead-flow spec B3)', () => {
  it('ends a lead render with LEAD_RULES and records the brief\'s source', () => {
    const source = { kind: 'lead_brief', goalVersion: 1, turn: 'build', resumed: false, requirements: 2, roster: 0 } as const
    const { prompt, manifest } = renderRunContext('lead', [{ kind: 'lead_brief', text: 'THE GOAL (v1)', source }])
    expect(prompt).toBe(`THE GOAL (v1)\n\n${LEAD_RULES}`)
    expect(manifest).toEqual({ kind: 'lead', sections: [source] })
  })

  it('has no place for the ask protocol', () => {
    expect(() => renderRunContext('lead', [{ kind: 'ask_protocol', text: 'x', source: { kind: 'ask_protocol' } }])).toThrow(/unknown section ask_protocol for run kind lead/)
  })
})
```

(import `LEAD_RULES` from `'../../src/lead/brief.js'`). In `packages/domain/test/run-context/sections.test.ts` add:

```ts
describe('runContextManifestSchema -- the lead kind', () => {
  it('reads a lead manifest and refuses a brief source missing a field', () => {
    const source = { kind: 'lead_brief', goalVersion: 1, turn: 'rework', resumed: true, requirements: 3, roster: 2 }
    expect(runContextManifestSchema.safeParse({ kind: 'lead', sections: [source] }).success).toBe(true)
    expect(runContextManifestSchema.safeParse({ kind: 'lead', sections: [{ kind: 'lead_brief', goalVersion: 1 }] }).success).toBe(false)
  })
})
```

Run `npx vitest run packages/domain/test/run-context` → FAIL. Then, in `packages/domain/src/run-context/sections.ts`: add to `SectionKind`

```ts
  /** Lead-flow spec B3: what a lead is told -- the whole brief at the start of a session, or one
   *  turn's note when the session is continued. The only section of the `lead` kind beside `profile`. */
  | 'lead_brief'
```

to `SectionSource`

```ts
  /** Lead-flow spec B3: which goal version and turn the lead was briefed for, whether the prompt
   *  was a note into a continued session, and how many requirements and roster members it named. */
  | { readonly kind: 'lead_brief'; readonly goalVersion: number; readonly turn: string; readonly resumed: boolean; readonly requirements: number; readonly roster: number }
```

change `Manifest`'s `kind` to `'implementation' | 'review' | 'planning' | 'verification' | 'lead'`, add

```ts
// Lead-flow plan A: a NEW kind, so every field REQUIRED (the `verification_goal` rule).
const leadBriefSourceSchema = z.object({
  kind: z.literal('lead_brief'),
  goalVersion: z.number().int().positive(),
  turn: z.string().min(1),
  resumed: z.boolean(),
  requirements: z.number().int().nonnegative(),
  roster: z.number().int().nonnegative(),
})
```

add `leadBriefSourceSchema,` to `sectionSourceSchema`'s list, and `'lead'` to `runContextManifestSchema`'s `kind` enum. In `packages/domain/src/run-context/render.ts` import `LEAD_RULES` from `'../lead/brief.js'`, add to `SECTION_ORDER`

```ts
  // Lead-flow spec B3: the lead's brief and nothing else of the worker's order -- no roster of
  // seats, no inbox, no ask protocol (spec R-6), no package contract, no report protocol.
  // `LEAD_RULES` is the trailer.
  lead: ['profile', 'lead_brief'],
```

and in `renderRunContext`'s trailer change the last arm `: IMPLEMENTATION_WORK_RULES` to `: kind === 'lead' ? LEAD_RULES : IMPLEMENTATION_WORK_RULES`. In `apps/web/src/lib/runContextSummary.ts`, after the `verification_protocol` case:

```ts
    // Lead flow: which turn of which goal version the lead was briefed for.
    case 'lead_brief':
      return {
        kind: source.kind,
        detail: `Lead brief for goal v${String(source.goalVersion)} (${source.turn.replaceAll('_', ' ')}${source.resumed ? ', into the same session' : ', a new session'}): ${plural(source.requirements, 'requirement')}, ${plural(source.roster, 'roster member')}`,
        missing: [],
      }
```

and in `apps/web/test/runContextSummary.test.ts`:

```ts
describe('sectionLine — lead_brief', () => {
  it('says which turn it was and whether the session was continued', () => {
    expect(sectionLine({ kind: 'lead_brief', goalVersion: 2, turn: 'wrap_up', resumed: true, requirements: 3, roster: 1 }).detail).toBe(
      'Lead brief for goal v2 (wrap up, into the same session): 3 requirements, 1 roster member',
    )
  })
})
```

Run `npx tsc --build && npx vitest run packages/domain/test/run-context apps/web/test/runContextSummary.test.ts` → PASS. `npm run typecheck` names every `switch` over a manifest kind that is no longer exhaustive; a web switch over the run kind that only labels it gets a `'lead'` arm reading `lead`.

- [ ] **Step 5: Spend, time and the roster, failing test first.** Create `packages/control/test/integration/lead-spend.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { loadLeadRoster } from '../../src/lead/roster.js'
import { goalSpend, goalWorkedMs } from '../../src/lead/spend.js'

const T0 = new Date('2026-10-04T10:00:00.000Z')
const at = (minutes: number): Date => new Date(T0.getTime() + minutes * 60_000)

async function seed(): Promise<{ readonly workspaceId: string; readonly taskId: string; readonly deliveryId: string; readonly leadSeat: string; readonly verifierSeat: string }> {
  const ws = await prisma.workspace.create({ data: { name: `Spend ${String(Math.random()).slice(2)}`, repoPath: '/tmp/spend', verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted' } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Lead flow' } })
  const seat = async (name: string, role: string): Promise<string> =>
    (await prisma.slave.create({ data: { teamId: team.id, role, runtimeRoles: [role === 'Lead' ? 'implementer' : 'verifier'], personId: (await prisma.person.create({ data: { name } })).id } })).id
  const pkg = await prisma.workPackage.create({ data: { workspaceId: ws.id, goalVersion: 1, key: 'main', title: 'The whole goal', requirementKeys: ['R1'], ownedPaths: ['**'], interface: '', templateId: 'lead' } })
  const task = await prisma.task.create({ data: { workspaceId: ws.id, title: 'The whole goal', description: 'x', status: 'running', requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1, workPackageId: pkg.id } })
  const delivery = await prisma.goalDelivery.create({ data: { workspaceId: ws.id, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1', baseCommit: 'abc' } })
  return { workspaceId: ws.id, taskId: task.id, deliveryId: delivery.id, leadSeat: await seat('Lead s', 'Lead'), verifierSeat: await seat('Verifier s', 'Verifier') }
}

describe('what a goal version spent (lead-flow plan A L6/L7)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "ConductorCall", "WorkPackage", "GoalDelivery", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('takes each lead session\'s running total once, and sums the sessions, the proof runs and the conductor\'s calls of that version (C2)', async (): Promise<void> => {
    const f = await seed()
    await prisma.slaveRun.createMany({
      data: [
        // Session s1: the build reported 10; a continue crashed with no cost; the rework, resumed
        // on s1, reported the session's running total, 12.5 -- which covers the crashed turn too.
        { slaveId: f.leadSeat, taskId: f.taskId, kind: 'implementation', status: 'succeeded', leadTurn: 'build', sessionId: 's1', costUsd: 10, startedAt: at(0), endedAt: at(30) },
        { slaveId: f.leadSeat, taskId: f.taskId, kind: 'implementation', status: 'failed', leadTurn: 'continue', sessionId: 's1', costUsd: null, startedAt: at(31), endedAt: at(32) },
        { slaveId: f.leadSeat, taskId: f.taskId, kind: 'implementation', status: 'succeeded', leadTurn: 'rework', sessionId: 's1', costUsd: 12.5, startedAt: at(40), endedAt: at(50), pausedMs: 120_000 },
        // Session s2 (the transcript of s1 was lost): it reported 2, then a turn ended with no cost
        // and nothing after it on s2 says what it spent.
        { slaveId: f.leadSeat, taskId: f.taskId, kind: 'implementation', status: 'succeeded', leadTurn: 'continue', sessionId: 's2', costUsd: 2, startedAt: at(51), endedAt: at(53) },
        { slaveId: f.leadSeat, taskId: f.taskId, kind: 'implementation', status: 'failed', leadTurn: 'wrap_up', sessionId: 's2', costUsd: null, startedAt: at(54), endedAt: at(55) },
        { slaveId: f.verifierSeat, kind: 'verification', status: 'succeeded', goalDeliveryId: f.deliveryId, costUsd: 3, startedAt: at(33), endedAt: at(39) },
      ],
    })
    await prisma.conductorCall.create({ data: { workspaceId: f.workspaceId, goalVersion: 1, stage: 'requirements', outcome: 'ok', modelCostUsd: 0.02 } })
    await prisma.conductorCall.create({ data: { workspaceId: f.workspaceId, goalVersion: 2, stage: 'requirements', outcome: 'ok', modelCostUsd: 9 } })

    expect(await goalSpend(f.workspaceId, 1)).toEqual({ totalUsd: 17.52, leadUsd: 14.5, proofUsd: 3, conductorUsd: 0.02, unmeasuredRuns: 1 })
    // 30 + 1 + (10 - 2 paused) + 2 + 1 + 6 minutes of work; the gaps between runs are not charged.
    expect(await goalWorkedMs(f.workspaceId, 1, at(60))).toBe(48 * 60_000)
  })

  it('counts a live run up to now, less the span it has sat paused', async (): Promise<void> => {
    const f = await seed()
    await prisma.slaveRun.create({ data: { slaveId: f.leadSeat, taskId: f.taskId, kind: 'implementation', status: 'paused', leadTurn: 'build', startedAt: at(0), pausedAt: at(10) } })
    expect(await goalWorkedMs(f.workspaceId, 1, at(25))).toBe(10 * 60_000)
  })

  it('builds a roster member from the person\'s profile and their persona\'s one line, in the roster\'s order', async (): Promise<void> => {
    await prisma.slaveTemplate.deleteMany({ where: { id: 't-lead-roster' } })
    await prisma.slaveTemplate.create({ data: { id: 't-lead-roster', name: 'Lead Roster Backend', role: 'backend', description: 'Builds and tests HTTP APIs', profile: 'You are a backend developer.', active: true } })
    const ada = await prisma.person.create({ data: { name: 'Ada', templateId: 't-lead-roster' } })
    const bo = await prisma.person.create({ data: { name: 'Bo', profile: 'You review security.' } })
    const gone = await prisma.person.create({ data: { name: 'Cy', releasedAt: at(0) } })
    const roster = await loadLeadRoster([bo.id, gone.id, ada.id])
    expect(roster).toEqual([
      { personId: bo.id, name: 'Bo', description: 'a specialist of this organisation', instructions: 'You review security.' },
      { personId: ada.id, name: 'Ada', description: 'Builds and tests HTTP APIs', instructions: 'You are a backend developer.' },
    ])
    await prisma.person.deleteMany({ where: { templateId: 't-lead-roster' } })
    await prisma.slaveTemplate.deleteMany({ where: { id: 't-lead-roster' } })
  })
})
```

Run → FAIL (the modules do not exist). Create `packages/control/src/lead/spend.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'

/** What one goal version spent, by who spent it. */
export interface GoalSpend {
  readonly totalUsd: number
  /** The lead's sessions, each at its running total (C2); its subordinate sessions' cost is inside it. */
  readonly leadUsd: number
  /** The verification and confirmation runs. */
  readonly proofUsd: number
  /** The conductor's model calls for this version (the requirement extraction). */
  readonly conductorUsd: number
  /** Concluded runs that reported no cost (a cancelled or crashed turn): their spend is not in the sums. */
  readonly unmeasuredRuns: number
}

const sum = (rows: readonly { readonly costUsd: number | null }[]): number => rows.reduce((total, row) => total + (row.costUsd ?? 0), 0)
const round = (usd: number): number => Math.round(usd * 1e6) / 1e6

interface LeadTurnCost {
  readonly id: string
  readonly sessionId: string | null
  readonly costUsd: number | null
  readonly startedAt: Date
  readonly endedAt: Date | null
}

/**
 * Lead-flow C2 (measured 2026-10-04): a resumed session reports its RUNNING total, so a lead
 * turn's `costUsd` already holds every earlier turn of its session. What the lead spent is each
 * session's largest reported total, summed over its sessions; a turn with no session line is a
 * session of its own. A concluded turn with no cost is unmeasured only when no later turn of the
 * same session reported -- a later total includes it.
 */
function leadSpendOf(turns: readonly LeadTurnCost[]): { readonly usd: number; readonly unmeasured: number } {
  const bySession = new Map<string, LeadTurnCost[]>()
  for (const turn of turns) {
    const key = turn.sessionId ?? `run:${turn.id}`
    bySession.set(key, [...(bySession.get(key) ?? []), turn])
  }
  let usd = 0
  let unmeasured = 0
  for (const session of bySession.values()) {
    usd += Math.max(0, ...session.map((turn) => turn.costUsd ?? 0))
    unmeasured += session.filter(
      (turn) => turn.endedAt !== null && turn.costUsd === null && !session.some((later) => later.costUsd !== null && later.startedAt > turn.startedAt),
    ).length
  }
  return { usd, unmeasured }
}

const runsOf = (workspaceId: string, goalVersion: number) =>
  ({
    lead: { leadTurn: { not: null }, task: { workspaceId, workPackage: { goalVersion } } },
    proof: { kind: 'verification' as const, goalDelivery: { workspaceId, goalVersion } },
  }) as const

/**
 * Lead-flow spec B4 (plan A L6, C2): the goal version's spend -- the lead's sessions, the proof
 * runs and the conductor's calls for that version. A proof run is a session of its own, so its
 * cost is its own; a lead turn's is its session's running total ({@link leadSpendOf}). A run's
 * cost is known only once it concluded with a result line; one that ended without, and that no
 * later total covers, is counted in `unmeasuredRuns` and adds nothing.
 */
export async function goalSpend(workspaceId: string, goalVersion: number): Promise<GoalSpend> {
  const where = runsOf(workspaceId, goalVersion)
  const [lead, proof, calls] = await Promise.all([
    prisma.slaveRun.findMany({ where: where.lead, select: { id: true, sessionId: true, costUsd: true, startedAt: true, endedAt: true } }),
    prisma.slaveRun.findMany({ where: where.proof, select: { costUsd: true, endedAt: true } }),
    prisma.conductorCall.aggregate({ where: { workspaceId, goalVersion }, _sum: { modelCostUsd: true } }),
  ])
  const leadSpend = leadSpendOf(lead)
  const leadUsd = round(leadSpend.usd)
  const proofUsd = round(sum(proof))
  const conductorUsd = round(calls._sum.modelCostUsd ?? 0)
  return {
    totalUsd: round(leadUsd + proofUsd + conductorUsd),
    leadUsd,
    proofUsd,
    conductorUsd,
    unmeasuredRuns: leadSpend.unmeasured + proof.filter((run) => run.endedAt !== null && run.costUsd === null).length,
  }
}

/**
 * Lead-flow plan A L7: the working time a goal version has taken -- each of its lead turns and
 * proof runs from start to end (or to `now` while live), less the time it sat paused. The gaps
 * between runs (a wait for the provider, a halt, the daemon down) are not charged.
 */
export async function goalWorkedMs(workspaceId: string, goalVersion: number, now: Date = new Date()): Promise<number> {
  const where = runsOf(workspaceId, goalVersion)
  const runs = await prisma.slaveRun.findMany({
    where: { OR: [where.lead, where.proof] },
    select: { startedAt: true, endedAt: true, pausedMs: true, pausedAt: true },
  })
  return runs.reduce((total, run) => {
    const end = run.endedAt ?? now
    const openPause = run.endedAt === null && run.pausedAt !== null ? Math.max(0, now.getTime() - run.pausedAt.getTime()) : 0
    return total + Math.max(0, end.getTime() - run.startedAt.getTime() - run.pausedMs - openPause)
  }, 0)
}
```

Create `packages/control/src/lead/roster.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { effectiveProfileFor, effectiveSkills, type RosterMember } from '@slave-of-ai/domain'
import { readSkillBody, skillRoots, skillSourceDir, type SkillRoots } from '../skills.js'

/**
 * Lead-flow spec B2 (plan A L16): the roster's persons as `buildRosterDefinitions` takes them, in
 * the roster's own order. One line on when to use them (the persona's description, else its role),
 * and their instructions: the person's effective profile followed by each of their skills' body
 * (the persona's defaults plus their grants, minus their revokes; a skill whose files are missing
 * is left out). A released or unknown person is skipped.
 */
export async function loadLeadRoster(personIds: readonly string[], roots: SkillRoots = skillRoots()): Promise<readonly RosterMember[]> {
  if (personIds.length === 0) return []
  const persons = await prisma.person.findMany({
    where: { id: { in: [...personIds] }, releasedAt: null },
    include: {
      template: { select: { profile: true, description: true, role: true } },
      skills: { include: { skill: { include: { provider: true } } } },
    },
  })
  const members: RosterMember[] = []
  for (const id of personIds) {
    const person = persons.find((one) => one.id === id)
    if (person === undefined) continue
    const templateSkills =
      person.templateId === null
        ? []
        : await prisma.templateSkill.findMany({ where: { templateId: person.templateId }, include: { skill: { include: { provider: true } } } })
    const rowById = new Map([...templateSkills.map((row) => row.skill), ...person.skills.map((row) => row.skill)].map((skill) => [skill.id, skill] as const))
    const skills = effectiveSkills({
      templateSkillIds: templateSkills.map((row) => row.skillId),
      granted: person.skills.filter((row) => row.mode === 'granted').map((row) => row.skillId),
      revoked: person.skills.filter((row) => row.mode === 'revoked').map((row) => row.skillId),
    }).flatMap(({ skillId }) => {
      const skill = rowById.get(skillId)
      return skill === undefined || skill.missingSince !== null ? [] : [skill]
    })
    const profile = effectiveProfileFor({ seat: null, person: person.profile, template: person.template?.profile ?? null })
    const skillTexts = skills.map((skill) => {
      const dir = skillSourceDir(roots, skill.provider.name, skill.name)
      const body = dir === null ? null : readSkillBody(dir)
      return `## Skill: ${skill.name}\n${body ?? skill.description}`
    })
    const oneLine = (person.template?.description ?? '').trim()
    members.push({
      personId: person.id,
      name: person.name,
      description: oneLine !== '' ? oneLine : (person.template?.role ?? 'a specialist of this organisation'),
      instructions: [profile?.text ?? `You are ${person.name}.`, ...skillTexts].join('\n\n'),
    })
  }
  return members
}
```

Add `export * from './lead/spend.js'` and `export * from './lead/roster.js'` to `packages/control/src/index.ts`. Run `npx tsc --build && npx vitest run packages/control/test/integration/lead-spend.test.ts` → PASS. (If `effectiveProfileFor`'s parameter names differ from `{ seat, person, template }`, read `packages/domain/src/persons/overrides.ts:34` and match them; `runContext.ts:1080` is the one existing call.)

- [ ] **Step 6: The recorded prompt, failing test first.** Create `apps/orchestrator/test/integration/lead-context.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_RULES, runContextManifestSchema } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildLeadContext, type LeadContextInput } from '../../src/lead/context.js'

const dirs: string[] = []

async function seed(): Promise<Omit<LeadContextInput, 'turn' | 'resumed' | 'continuation' | 'note'>> {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-lead-context-'))
  dirs.push(dir)
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# x\n')
  git('add', '-A')
  git('-c', 'user.name=F', '-c', 'user.email=f@x', 'commit', '-q', '-m', 'add the health route')
  const ws = await prisma.workspace.create({ data: { name: `Ctx ${String(Math.random()).slice(2)}`, repoPath: dir, verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted', goal: 'Build the status page.', goalVersion: 1 } })
  await prisma.goalVersion.create({ data: { workspaceId: ws.id, version: 1, text: 'Build the status page.', sha256: 'x' } })
  await prisma.requirementSet.create({ data: { workspaceId: ws.id, goalVersion: 1, items: [{ key: 'R1', text: 'GET /health answers 200', source: 's' }, { key: 'RUN', text: 'It starts', source: '' }] } })
  await prisma.goalDecision.create({ data: { workspaceId: ws.id, goalVersion: 1, title: 'Database', titleKey: 'database', decision: 'SQLite', source: 'person' } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Lead flow' } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Lead', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: `Lead ${ws.id.slice(0, 8)}` } })).id } })
  const run = await prisma.slaveRun.create({ data: { slaveId: seat.id, kind: 'implementation', status: 'starting', leadTurn: 'build' } })
  return { runId: run.id, workspaceId: ws.id, goalVersion: 1, worktreePath: dir, roster: [{ slug: 'backend-developer', description: 'builds APIs' }], budget: { totalUsd: 30, shareUsd: 24, spentUsd: 0 }, timeLeftMs: null }
}

describe('buildLeadContext (lead-flow spec B3)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "RunContext", "GoalDecision", "RequirementSet", "GoalVersion", "SlaveRun", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  it('gives a new session the whole brief and the rules, and records it', async (): Promise<void> => {
    const base = await seed()
    const { prompt } = await buildLeadContext({ ...base, turn: 'build', resumed: false, continuation: false, note: null })
    expect(prompt).toContain('THE GOAL (v1)')
    expect(prompt).toContain('R1: GET /health answers 200')
    expect(prompt).toContain('- Database: SQLite')
    expect(prompt).toContain('- backend-developer: builds APIs')
    expect(prompt.endsWith(LEAD_RULES)).toBe(true)
    expect(prompt).not.toContain('<slave-ask>')
    const row = await prisma.runContext.findUniqueOrThrow({ where: { runId: base.runId } })
    expect(row.prompt).toBe(prompt)
    expect(runContextManifestSchema.parse(row.sections)).toEqual({ kind: 'lead', sections: [{ kind: 'lead_brief', goalVersion: 1, turn: 'build', resumed: false, requirements: 2, roster: 1 }] })
  })

  it('gives a continued session only the turn\'s note', async (): Promise<void> => {
    const base = await seed()
    const { prompt } = await buildLeadContext({ ...base, turn: 'rework', resumed: true, continuation: false, note: 'R1: output: 404' })
    expect(prompt).toContain('R1: output: 404')
    expect(prompt).not.toContain('THE GOAL')
    expect(prompt).not.toContain(LEAD_RULES)
    expect(runContextManifestSchema.parse((await prisma.runContext.findUniqueOrThrow({ where: { runId: base.runId } })).sections).sections[0]).toMatchObject({ turn: 'rework', resumed: true })
  })

  it('gives a new session after a lost transcript the brief, where the branch stands, and the note', async (): Promise<void> => {
    const base = await seed()
    const { prompt } = await buildLeadContext({ ...base, turn: 'continue', resumed: false, continuation: true, note: 'the earlier transcript is gone' })
    expect(prompt).toContain('THE GOAL (v1)')
    expect(prompt).toContain('CONTINUATION')
    expect(prompt).toContain('add the health route')
    expect(prompt).toContain('the earlier transcript is gone')
    expect(prompt.endsWith(LEAD_RULES)).toBe(true)
  })
})
```

Run → FAIL (`../../src/lead/context.js` does not exist).

- [ ] **Step 7: The builder.** Create `apps/orchestrator/src/lead/context.ts`:

```ts
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  RUN_PROMPT_MAX_BYTES,
  renderLeadBrief,
  renderLeadContinuation,
  renderLeadTurnNote,
  renderRunContext,
  requirementItemsSchema,
  type LeadTurn,
  type Manifest,
} from '@slave-of-ai/domain'
import { RunContextRefused } from '../runContext.js'
import { gitIn } from '../worktree.js'

/** What one lead turn's prompt is built from; gathered by the dispatch (`planLeadTurn`). */
export interface LeadContextInput {
  readonly runId: string
  readonly workspaceId: string
  readonly goalVersion: number
  readonly worktreePath: string
  readonly turn: LeadTurn
  /** The turn continues an existing session: the prompt is the turn's note alone. */
  readonly resumed: boolean
  /** A new session on a branch an earlier session already worked on (its transcript is gone). */
  readonly continuation: boolean
  /** What came back for this turn: a verifier's evidence, a failure, the reason it was interrupted. */
  readonly note: string | null
  readonly roster: readonly { readonly slug: string; readonly description: string }[]
  readonly budget: { readonly totalUsd: number; readonly shareUsd: number; readonly spentUsd: number } | null
  readonly timeLeftMs: number | null
}

/**
 * Lead-flow spec B3 (plan A L4): the one place a lead turn's prompt is assembled and RECORDED,
 * before the spawn -- `buildRunContext`'s contract, for the lead. A new session gets the whole
 * brief and the rules (`renderRunContext('lead', …)`); a continued session gets the turn's note,
 * because the session already holds the brief. No ask protocol in either (spec R-6). Refuses a
 * prompt past the one-argument byte budget, like every other kind.
 */
export async function buildLeadContext(input: LeadContextInput): Promise<{ readonly prompt: string }> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: input.workspaceId }, select: { baseBranch: true } })
  const set = await prisma.requirementSet.findUniqueOrThrow({ where: { workspaceId_goalVersion: { workspaceId: input.workspaceId, goalVersion: input.goalVersion } } })
  const requirements = requirementItemsSchema.parse(set.items)
  const source = {
    kind: 'lead_brief' as const,
    goalVersion: input.goalVersion,
    turn: input.turn,
    resumed: input.resumed,
    requirements: requirements.length,
    roster: input.roster.length,
  }
  const note = renderLeadTurnNote({
    kind: input.turn,
    note: input.note,
    baseBranch: workspace.baseBranch,
    budgetLeftUsd: input.budget === null ? null : Math.max(0, input.budget.shareUsd - input.budget.spentUsd),
    timeLeftMs: input.timeLeftMs,
  })

  let prompt: string
  let manifest: Manifest
  if (input.resumed) {
    prompt = note
    manifest = { kind: 'lead', sections: [source] }
  } else {
    const version = await prisma.goalVersion.findUniqueOrThrow({ where: { workspaceId_version: { workspaceId: input.workspaceId, version: input.goalVersion } }, select: { text: true } })
    const decisions = await prisma.goalDecision.findMany({ where: { workspaceId: input.workspaceId, goalVersion: input.goalVersion }, orderBy: { createdAt: 'asc' }, select: { title: true, decision: true } })
    const brief = renderLeadBrief({ goalVersion: input.goalVersion, goal: version.text, requirements, decisions, budget: input.budget, timeLeftMs: input.timeLeftMs, roster: input.roster })
    const text = input.continuation
      ? `${brief}\n\n${renderLeadContinuation({ lastCommits: await gitIn(input.worktreePath, 'log', '--oneline', '-15').catch(() => ''), then: note })}`
      : brief
    const rendered = renderRunContext('lead', [{ kind: 'lead_brief', text, source }])
    prompt = rendered.prompt
    manifest = rendered.manifest
  }

  const bytes = Buffer.byteLength(prompt, 'utf8')
  if (bytes > RUN_PROMPT_MAX_BYTES) throw new RunContextRefused('prompt_too_long', { limit: RUN_PROMPT_MAX_BYTES, length: bytes })
  const sections = manifest as unknown as Prisma.InputJsonValue
  await prisma.runContext.upsert({ where: { runId: input.runId }, create: { runId: input.runId, prompt, sections }, update: { prompt, sections } })
  return { prompt }
}
```

Run `npx vitest run apps/orchestrator/test/integration/lead-context.test.ts` → PASS.

- [ ] **Step 8: Run.** `npx vitest run packages/domain/test/lead packages/domain/test/run-context`, `npx vitest run packages/control/test/integration/lead-spend.test.ts`, `npx vitest run apps/orchestrator/test/integration/runContext.test.ts` (unchanged), `npx vitest run apps/web/test/runContextSummary.test.ts` → PASS. `npm run typecheck`. `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 9: Commit**

```bash
git add packages/domain/src/lead packages/domain/src/run-context packages/domain/test packages/control/src/lead packages/control/src/index.ts packages/control/test/integration/lead-spend.test.ts apps/orchestrator/src/lead/context.ts apps/orchestrator/test/integration/lead-context.test.ts apps/web/src/lib/runContextSummary.ts apps/web/test/runContextSummary.test.ts
git commit -m "feat(lead): the lead's brief, its budget legs, and what a goal version spent and took

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: A goal set in the lead flow is built by one lead turn and handed to proof, with no review (B1, L3, L5)

**Files:**
- Create: `packages/domain/src/lead/stop.ts`; modify `packages/domain/src/lead/index.ts`
- Create: `apps/orchestrator/src/lead/record.ts`, `open.ts`, `turn.ts`, `stop.ts`, `conclude.ts`
- Modify: `apps/orchestrator/src/conductor.ts` (`conduct` at `:57-96`: the `select` and one branch; `export` on `AlreadyConducted` at `:119` and on `materialise` at `:342`)
- Modify: `apps/orchestrator/src/tick.ts` (`startRun` at `:777-1093`: five insertions, Step 6)
- Modify: `apps/orchestrator/src/verify.ts` (`verifyConcludedRun` at `:329-337`: one branch)
- Modify: `packages/control/src/runtime.ts` (`leadRuntime`, after `resolveRuntime`; Step 7f), `apps/orchestrator/src/model.ts` (re-export `leadRuntime`)
- Create: `apps/orchestrator/test/integration/lead-helpers.ts`
- Test: `packages/domain/test/lead/stop.test.ts` (new), `apps/orchestrator/test/integration/lead-open.test.ts` (new), `packages/control/test/runtime.test.ts` (one case, Step 7f)

**Interfaces:**
- Produces (control, `runtime.ts`): `leadRuntime(seat: { readonly model: string | null }): ResolvedRuntime` (C5; Task 9 imports it through `apps/orchestrator/src/model.ts`).
- Consumes: `ensureLeadSeats`, `goalSpend`, `goalWorkedMs`, `loadLeadRoster`, `withDeliveryLock`, `refusalText` (control); `singlePlan`, `integrationBranchName`, `requirementItemsSchema`, `readLeadProgress`, `nextLeadLeg`, `leadShareUsd`, `buildRosterDefinitions`, `INITIAL_LEAD_PROGRESS`, `LEAD_TEMPLATE_ID` (domain); `buildLeadContext` (Task 5); `writeSpawnExtras`, `StartRunInput.resumeSessionId` (Task 4); `materialise(workspaceId, version, maxAttempts, plan, fallback, seats, items, delivery)`, `tripConductor`, `ensureIntegrationBranch`, `integrationTargetFor`, `commitUncommittedWork`, `releaseTaskAfterFailure`, `taskKeyFor`, `emailLocalPart`, `gitIn` (orchestrator, existing).
- Produces (domain): `renderLeadStop(input: { readonly version: number; readonly reason: StopReason; readonly failing: readonly string[]; readonly disputed: readonly string[]; readonly unverifiable: readonly string[]; readonly detail: string | null }): string` (at most 2 000 characters).
- Produces (orchestrator, `lead/record.ts`): `noteLead(input: { readonly workspaceId: string; readonly version: number; readonly kind: LeadNoteKind; readonly detail: string; readonly runId?: string | null }): Promise<void>`; `updateLeadProgress(deliveryId: string, change: (progress: LeadProgress) => LeadProgress): Promise<LeadProgress>` (under the delivery lock); `endLead(deliveryId: string, reason: StopReason, detail: string): Promise<boolean>` (sets `leadEnded` once; true when this call set it).
- Produces (`lead/open.ts`): `openLeadGoal(workspaceId: string, workspace: { readonly repoPath: string; readonly baseBranch: string; readonly maxAttempts: number }, version: number, storedItems: Prisma.JsonValue): Promise<ConductStep>`.
- Produces (`lead/turn.ts`): `type LeadTurnPlan = { readonly kind: 'hold' } | LeadTurnRun`; `interface LeadTurnRun` (Step 5); `planLeadTurn(input: { readonly task: { readonly id: string; readonly lastRejectionReason: string | null }; readonly deliveryId: string }): Promise<LeadTurnPlan>`; `noteLeadTurnStarted(plan: LeadTurnRun, runId: string): Promise<void>`.
- Produces (`lead/stop.ts`): `stopLeadInLock(tx: Prisma.TransactionClient, deliveryId: string, reason: StopReason, progress: LeadProgress, detail: string | null): Promise<boolean>`; `stopLead(deliveryId: string, reason: StopReason, detail: string | null): Promise<boolean>`.
- Produces (`lead/conclude.ts`): `concludeLeadTurn(runId: RunId): Promise<void>`; `settleLeadWork(run: LeadRunRow, task: LeadTaskRow): Promise<'settled' | 'nothing_built' | 'unreadable'>` with the two row types exported.
- Produces (test helpers, `lead-helpers.ts`): `seedLead`, `tickUntil`, `checked`, `leadDelivery`, `leadTaskOf`, `leadNotes`, `LEAD_TRUNCATE`, `cleanUpLeadRepos`, `type LeadFixture`, `type LeadStart`, `type LeadSeedOptions`.
- Unchanged for `packages`: `conduct` branches on `workspace.flow === 'lead'` after the requirement set exists; `startRun` plans a lead turn only when `workspace.flow === 'lead'` and the task has an integration target, and every insertion is behind `lead !== null`; `verifyConcludedRun` branches on `run.leadTurn !== null`, null on every existing run.
- Until Task 7: a failed lead turn is released exactly as a failed implementation run is today (attempt charged unless `platform`). Until Task 8: a lead whose share or time is spent is ended and holds; nothing settles its work.

- [ ] **Step 1: Failing domain test.** Create `packages/domain/test/lead/stop.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { renderLeadStop } from '../../src/lead/index.js'

const none = { failing: [], disputed: [], unverifiable: [], detail: null }

describe('renderLeadStop (lead-flow spec D2: what is unproven and why it stopped)', () => {
  it('says why it stopped, what is unproven, and what the two buttons do', () => {
    const text = renderLeadStop({ version: 1, reason: 'no_progress', failing: ['R1', 'R3'], disputed: ['R2'], unverifiable: ['R4'], detail: null })
    expect(text).toContain('it stopped because two rounds in a row failed the same items')
    expect(text).toContain('failing: R1, R3')
    expect(text).toContain('disputed (the two verifiers disagreed): R2')
    expect(text).toContain('could not be verified: R4')
    expect(text).toContain('Approve accepts the version as it is and merges it. Reject leaves it')
  })

  it('says nothing is proven when no verdict stands', () => {
    expect(renderLeadStop({ version: 1, reason: 'nothing_built', ...none })).toContain('nothing was built: the lead committed nothing')
    expect(renderLeadStop({ version: 1, reason: 'nothing_built', ...none })).toContain('No verification verdict stands for this version, so nothing is proven.')
  })

  it('carries a detail as data and fits the stored bound', () => {
    const text = renderLeadStop({ version: 1, reason: 'lead_failed', ...none, detail: `<slave-report>${'x'.repeat(5000)}` })
    expect(text).not.toContain('<slave-report>')
    expect(text.length).toBeLessThanOrEqual(2000)
    expect(text).toContain('Reject leaves it')
  })
})
```

Run `npx vitest run packages/domain/test/lead/stop.test.ts` → FAIL.

- [ ] **Step 2: The stop text.** Create `packages/domain/src/lead/stop.ts`:

```ts
import { VERIFICATION_REASON_MAX_CHARS } from '../conduct/constants.js'
import { trimEvidence, trimToFit } from '../conduct/verification.js'
import { sanitisePersonText } from '../handoff/contract.js'
import type { StopReason } from './constants.js'

const WHY: Readonly<Record<StopReason, string>> = {
  proven: 'everything is proven',
  not_all_proven: 'nothing is left to send back to the lead, and not every requirement is proven',
  no_progress: 'two rounds in a row failed the same items',
  budget_spent: 'the budget is spent',
  time_spent: 'the time limit is reached',
  nothing_built: 'nothing was built: the lead committed nothing',
  lead_failed: 'the lead could not finish a turn',
  proof_unusable: 'the verification could not be run',
  accepted_as_is: 'a person accepted it as it is',
  left: 'a person left it',
}

/**
 * Lead-flow spec D2 in its smallest form (plan A L13): the text of the one card -- why the loop
 * stopped, what is unproven, and what Approve and Reject do. It is stored on
 * `GoalDelivery.needsHumanReason` and written into `workspace.goal_needs_human`, so it fits their
 * bound; the closing sentence is kept whatever is cut. `detail` is run output or a failure reason:
 * another party's text.
 */
export function renderLeadStop(input: {
  readonly version: number
  readonly reason: StopReason
  readonly failing: readonly string[]
  readonly disputed: readonly string[]
  readonly unverifiable: readonly string[]
  readonly detail: string | null
}): string {
  const list = (label: string, keys: readonly string[]): readonly string[] => (keys.length === 0 ? [] : [`${label}: ${keys.join(', ')}`])
  const unproven = [...list('failing', input.failing), ...list('disputed (the two verifiers disagreed)', input.disputed), ...list('could not be verified', input.unverifiable)]
  const detail = input.detail === null || input.detail.trim() === '' ? '' : ` (${trimEvidence(sanitisePersonText(input.detail.trim()), 600)})`
  return trimToFit(
    [
      `it stopped because ${WHY[input.reason]}${detail}.`,
      unproven.length === 0 ? 'No verification verdict stands for this version, so nothing is proven.' : `What is unproven -- ${unproven.join('; ')}.`,
      'Approve accepts the version as it is and merges it. Reject leaves it: the work branch stays and the next goal version may start.',
    ].join(' '),
    VERIFICATION_REASON_MAX_CHARS,
  )
}
```

Add `export * from './stop.js'` to `packages/domain/src/lead/index.ts`. Run the test → PASS.

- [ ] **Step 3: The shared seed.** Create `apps/orchestrator/test/integration/lead-helpers.ts`:

```ts
/**
 * Lead-flow plan A: the seed every lead-flow integration test shares. A real repository with a
 * smoke script, a workspace switched to the lead flow (`setFlow`, which makes the three system
 * seats), its goal set, an injected decider that answers ONLY the requirement extraction, and a
 * routing adapter that gives every run its own `m8-flow` fake: a lead turn commits one file of its
 * own and takes the test's extra argv; a verification run answers the items the test scripts for
 * it, or passes every key it was asked. `starts` records what each run was spawned with.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setFlow, setGoal, setLeadSettings, type ModelDecider, type ModelOutcome } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { workspaceId as brandWorkspaceId } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter, readSpawnExtras, type SlaveRuntimeAdapter, type SpawnExtras } from '@slave-of-ai/providers'
import { drainPumps, tick, type TickDeps } from '../../src/tick.js'
import { worktreeRootFor } from '../../src/worktree.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')
const repos: string[] = []

export const LEAD_TRUNCATE =
  'TRUNCATE TABLE "ExecutionEvent", "SmokeAttempt", "PackageHandOff", "GoalDecision", "ConductorCall", "RequirementSet", "WorkPackage", "GoalDelivery", "RunReport", "SupervisorDecision", "SlaveMessage", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "GoalVersion", "ProviderConfiguration", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE'

export function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()
}

/** A smoke script that fails its first `failures` runs, then passes -- counted outside the repository. */
function smokeScript(stateFile: string, failures: number): string {
  return ['#!/usr/bin/env bash', `n=$(cat '${stateFile}' 2>/dev/null || echo 0)`, `echo $((n + 1)) > '${stateFile}'`, `if [ "$n" -lt ${String(failures)} ]; then echo 'the product did not start' >&2; exit 1; fi`, 'echo "flow ok"', ''].join('\n')
}

function makeRepo(smokeFailures: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-lead-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  writeFileSync(join(dir, 'scripts/smoke.sh'), smokeScript(join(mkdtempSync(join(tmpdir(), 'lead-smoke-')), 'count'), smokeFailures))
  chmodSync(join(dir, 'scripts/smoke.sh'), 0o755)
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  repos.push(dir)
  return dir
}

export function cleanUpLeadRepos(): void {
  for (const repo of repos) {
    rmSync(worktreeRootFor(repo), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
}

/** What one run was spawned with. */
export interface LeadStart {
  readonly runId: string
  readonly kind: string
  readonly leadTurn: string | null
  /** 1-based, per kind: the n-th lead turn, the n-th verification run. */
  readonly ordinal: number
  readonly prompt: string
  readonly resumeSessionId: string | null
  /** The model the run was spawned with; null: no `--model` flag (C5). */
  readonly model: string | null
  readonly extras: SpawnExtras
  readonly verificationKeys: readonly string[]
  readonly confirms: boolean
}

export interface LeadSeedOptions {
  readonly budgetUsd?: number | null
  readonly timeLimitMs?: number
  readonly autoMerge?: boolean
  readonly smokeFailures?: number
  readonly roster?: readonly string[]
  /** Extra fake argv for the n-th lead turn (1-based). */
  readonly leadArgs?: (ordinal: number, leadTurn: string | null) => readonly string[]
  /** The items the n-th verification run answers; undefined: every key it was asked passes. */
  readonly verify?: (ordinal: number, run: { readonly keys: readonly string[]; readonly confirms: boolean }) => readonly object[] | undefined
  /** Runs after a run was spawned, while it is running. */
  readonly onStart?: (start: LeadStart) => Promise<void>
  /** The fake argv a RESUMED run (a paused run continued on its own row) is spawned with. */
  readonly resumeArgs?: readonly string[]
}

export interface LeadFixture {
  readonly workspaceId: string
  readonly repoPath: string
  readonly initialTip: string
  readonly deps: TickDeps
  /** Every model prompt the decider was asked that was not the requirement extraction. */
  readonly others: readonly string[]
  readonly starts: readonly LeadStart[]
}

const REQUIREMENTS = JSON.stringify({
  requirementsAnswer: [
    { text: 'GET /health answers 200', source: 'A health route.' },
    { text: 'GET /version prints the version', source: 'A version route.' },
  ],
})
const b64 = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64')
export const base64 = b64

/** One verifier item, as a scripted run lists it. */
export function checked(key: string, status: 'pass' | 'fail' | 'unverifiable'): object {
  return {
    key,
    status,
    check: key === 'RUN' ? 'docker compose up -d && curl -fsS localhost:8080/health' : `curl -fsS localhost:8080/${key}`,
    output: status === 'pass' ? '200 OK' : status === 'fail' ? '404 Not Found' : '',
    reason: status === 'pass' ? '' : status === 'fail' ? `${key} answers 404` : `${key} needs a network this checkout lacks`,
  }
}

export async function seedLead(options: LeadSeedOptions = {}): Promise<LeadFixture> {
  const repoPath = makeRepo(options.smokeFailures ?? 0)
  const workspace = await prisma.workspace.create({
    data: { name: `Lead Flow ${String(Math.random()).slice(2)}`, repoPath, baseBranch: 'main', verifyCommands: ['true'], setupCommands: [], ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd }) },
  })
  await prisma.providerConfiguration.create({ data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} } })
  const flow = await setFlow(workspace.id, 'lead', { ...(options.autoMerge === undefined ? {} : { autoMerge: options.autoMerge }) })
  if (!flow.ok) throw new Error('the fixture could not enter the lead flow')
  if (options.timeLimitMs !== undefined || options.roster !== undefined) {
    const set = await setLeadSettings(workspace.id, { ...(options.timeLimitMs === undefined ? {} : { timeLimitMs: options.timeLimitMs }), ...(options.roster === undefined ? {} : { roster: options.roster }) })
    if (!set.ok) throw new Error('the fixture lead settings were refused')
  }
  const goal = await setGoal(workspace.id, 'Add a health route. Add a version route.')
  if (!goal.ok) throw new Error('the fixture goal was refused')

  const others: string[] = []
  const decider: ModelDecider = async (input) => {
    const answer = (text: string): ModelOutcome => ({ kind: 'answer', text, costUsd: 0.02, tokens: null, numTurns: 1 })
    if (input.prompt.includes('"requirementsAnswer"')) return answer(REQUIREMENTS)
    others.push(input.prompt)
    return { kind: 'failed', reason: 'not scripted in this test', costUsd: null, tokens: null }
  }

  const starts: LeadStart[] = []
  const make = (extra: readonly string[]): ClaudeCodeAdapter => new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'm8-flow', ...extra], hookPath: REAL_GATE })
  const plain = make([])
  const byRun = new Map<string, SlaveRuntimeAdapter>()
  const pick = (runId: string): SlaveRuntimeAdapter => byRun.get(runId) ?? plain
  const adapter: SlaveRuntimeAdapter = {
    kind: plain.kind,
    getCapabilities: () => plain.getCapabilities(),
    listModels: () => plain.listModels(),
    async start(input) {
      const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: input.runId }, select: { kind: true, leadTurn: true, verificationKeys: true, confirmsRunId: true } })
      const ordinal = starts.filter((s) => s.kind === run.kind).length + 1
      let extra: readonly string[] = []
      if (run.kind === 'implementation') extra = ['--work-file', `lead-work-${String(ordinal)}.txt`, ...(options.leadArgs?.(ordinal, run.leadTurn) ?? [])]
      if (run.kind === 'verification') {
        const items = options.verify?.(ordinal, { keys: run.verificationKeys, confirms: run.confirmsRunId !== null })
        if (items !== undefined) extra = ['--verification-json-base64', b64({ items })]
      }
      const chosen = make(extra)
      const start: LeadStart = {
        runId: input.runId,
        kind: run.kind,
        leadTurn: run.leadTurn,
        ordinal,
        prompt: input.prompt,
        resumeSessionId: input.resumeSessionId ?? null,
        model: input.model ?? null,
        extras: readSpawnExtras(input.runDir),
        verificationKeys: run.verificationKeys,
        confirms: run.confirmsRunId !== null,
      }
      starts.push(start)
      byRun.set(input.runId, chosen)
      const handle = await chosen.start(input)
      if (options.onStart !== undefined) await options.onStart(start)
      return handle
    },
    events: (runId) => pick(runId).events(runId),
    cancel: (runId) => pick(runId).cancel(runId),
    resume: (runId, checkpoint, queuedInstruction, runToken) => {
      // A fresh adapter, as after a daemon restart: it has no memory of the run's first spawn.
      const chosen = options.resumeArgs === undefined ? pick(runId) : make(options.resumeArgs)
      byRun.set(runId, chosen)
      return chosen.resume(runId, checkpoint, queuedInstruction, runToken)
    },
  }

  return {
    workspaceId: workspace.id,
    repoPath,
    initialTip: git(['rev-parse', 'main'], repoPath),
    others,
    starts,
    deps: { workspaceId: brandWorkspaceId(workspace.id), registry: { resolve: () => adapter }, supervisorDecider: decider, supervisorModel: 'claude-sonnet-5' },
  }
}

/** Ticks, letting every pump finish between ticks, until `done` holds -- bounded. */
export async function tickUntil(f: LeadFixture, done: () => Promise<boolean>, limit = 60): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    await tick(f.deps)
    await drainPumps()
    if (await done()) return
  }
  throw new Error('tickUntil: the condition never held')
}

export async function leadDelivery(f: LeadFixture, goalVersion = 1): Promise<NonNullable<Awaited<ReturnType<typeof prisma.goalDelivery.findUnique>>>> {
  return prisma.goalDelivery.findUniqueOrThrow({ where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion } } })
}

export async function leadTaskOf(f: LeadFixture): Promise<NonNullable<Awaited<ReturnType<typeof prisma.task.findFirst>>>> {
  return prisma.task.findFirstOrThrow({ where: { workspaceId: f.workspaceId, workPackageId: { not: null } } })
}

/** The version's `workspace.lead_noted` lines, oldest first, as `kind: detail`. */
export async function leadNotes(f: LeadFixture): Promise<string[]> {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_lead_noted' }, orderBy: { seq: 'asc' }, select: { payload: true } })
  return rows.map((row) => `${(row.payload as { kind: string }).kind}: ${(row.payload as { detail: string }).detail}`)
}

/** Whether the version reached `state`. */
export const leadStateIs = (f: LeadFixture, state: string) => async (): Promise<boolean> => (await leadDelivery(f)).leadState === state
export const merged = (f: LeadFixture) => async (): Promise<boolean> => (await leadDelivery(f)).mergedAt !== null
```

- [ ] **Step 4: Failing integration test.** Create `apps/orchestrator/test/integration/lead-open.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { INITIAL_LEAD_PROGRESS, LEAD_RULES, LEAD_TEMPLATE_ID, integrationBranchName } from '@slave-of-ai/domain'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { drainPumps, tick } from '../../src/tick.js'
import { LEAD_TRUNCATE, base64, cleanUpLeadRepos, git, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil } from './lead-helpers.js'

describe('the lead flow: a goal is built by one lead turn', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(LEAD_TRUNCATE)
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    cleanUpLeadRepos()
    await prisma.$disconnect()
  })

  it('makes one package and one task for the lead with no model call for the plan', async (): Promise<void> => {
    const f = await seedLead()
    await tick(f.deps) // the requirement extraction (the one model call)
    await tick(f.deps) // the plan, by rule
    await drainPumps()

    expect(f.others.filter((prompt) => prompt.includes('"conductAnswer"'))).toEqual([])
    expect(await prisma.conductorCall.findMany({ where: { workspaceId: f.workspaceId }, select: { stage: true } })).toEqual([{ stage: 'requirements' }])
    const packages = await prisma.workPackage.findMany({ where: { workspaceId: f.workspaceId } })
    expect(packages).toEqual([expect.objectContaining({ key: 'main', ownedPaths: ['**'], requirementKeys: ['R1', 'R2', 'RUN'], templateId: LEAD_TEMPLATE_ID })])
    const task = await leadTaskOf(f)
    const lead = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId }, role: 'Lead' } })
    const verifier = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId }, role: 'Verifier' } })
    expect(task.assigneeId).toBe(lead.id)
    const delivery = await leadDelivery(f)
    expect(delivery).toMatchObject({ integrationBranch: integrationBranchName(1, f.workspaceId), verifierSlaveId: verifier.id, leadState: 'building', smokeRequired: true })
    expect(delivery.leadProgress).toEqual(INITIAL_LEAD_PROGRESS)
    const decision = await prisma.supervisorDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId, situationKind: 'conduct' } })
    expect(decision.decidedBy).toBe('rules')
    const states = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_lead_state' }, select: { payload: true } })
    expect(states.map((row) => row.payload)).toEqual([{ version: 1, state: 'building', reason: null }])
  })

  it('starts the lead once with the whole brief, the roster and a capped first leg, and no session to resume', async (): Promise<void> => {
    const ada = await prisma.person.create({ data: { name: 'Ada Backend', profile: 'You build APIs.' } })
    const f = await seedLead({ budgetUsd: 30, roster: [ada.id] })
    await tickUntil(f, async () => f.starts.length > 0)

    const start = f.starts[0]
    expect(start).toMatchObject({ kind: 'implementation', leadTurn: 'build', resumeSessionId: null })
    expect(start?.prompt).toContain('THE GOAL (v1)')
    expect(start?.prompt).toContain('R1: GET /health answers 200')
    expect(start?.prompt).toContain('- ada-backend:')
    expect(start?.prompt.endsWith(LEAD_RULES)).toBe(true)
    expect(start?.prompt).not.toContain('<slave-ask>')
    expect(start?.prompt).not.toContain('<slave-report>')
    // 30 less one fifth is the share (24); the first leg runs to four fifths of it. The lead has spent nothing yet.
    expect(start?.extras).toEqual({ sessionDefinitions: JSON.stringify({ 'ada-backend': { description: 'a specialist of this organisation', prompt: 'You build APIs.' } }), maxBudgetUsd: 19.2, keepAliveForSubordinates: true })
    const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: start?.runId ?? '' } })
    expect([run.leadTurn, run.leadResumed, run.kind]).toEqual(['build', false, 'implementation'])
    // C5: no model named, so no `--model` flag -- the installed CLI's default runs the lead.
    expect(start?.model).toBeNull()
    expect([run.model, run.provider]).toEqual([null, 'claude_code'])
    expect((await leadNotes(f))[0]).toBe('turn: turn 1 (build): a new session was started')
  })

  it('integrates the turn by a fast-forward, with no review, no report and no merge pass, and proves and merges it', async (): Promise<void> => {
    const f = await seedLead()
    await tickUntil(f, merged(f))

    const task = await leadTaskOf(f)
    expect(task.status).toBe('done')
    expect(task.integratedAt).not.toBeNull()
    const delivery = await leadDelivery(f)
    expect(delivery.status).toBe('accepted')
    // The work branch is the lead's branch tip, not a merge commit on top of it.
    expect(git(['rev-parse', delivery.integrationBranch], f.repoPath)).toBe(git(['rev-parse', task.branch ?? ''], f.repoPath))
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(delivery.verifiedCommit)
    expect(git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')).toContain('lead-work-1.txt')

    const runs = await prisma.slaveRun.findMany({ where: { slave: { team: { workspaceId: f.workspaceId } } }, select: { kind: true } })
    expect(runs.map((run) => run.kind).sort()).toEqual(['implementation', 'verification'])
    const types = (await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId }, select: { type: true } })).map((row) => row.type)
    for (const absent of ['task_review_started', 'task_review_approved', 'task_verify_passed', 'task_ownership_violated', 'task_merge_failed', 'supervisor_proposed']) expect(types).not.toContain(absent)
    expect(types).toContain('task_done')
    expect(await prisma.runReport.count()).toBe(0)
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, situationKind: { not: 'conduct' } } })).toBe(0)
    expect(f.starts.filter((s) => s.kind === 'implementation')).toHaveLength(1)
  })

  it('stops with "nothing was built" when the lead commits nothing, and starts no proof', async (): Promise<void> => {
    const f = await seedLead({ leadArgs: () => ['--no-work'] })
    await tickUntil(f, async () => (await leadDelivery(f)).status === 'needs_human')

    const delivery = await leadDelivery(f)
    expect([delivery.stopReason, delivery.leadState]).toEqual(['nothing_built', 'awaiting_decision'])
    expect(delivery.needsHumanReason).toContain('nothing was built')
    expect(await prisma.smokeAttempt.count()).toBe(0)
    expect(f.starts.filter((s) => s.kind === 'verification')).toEqual([])
    // Held: more ticks start no further turn.
    for (let i = 0; i < 3; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }
    expect(f.starts.filter((s) => s.kind === 'implementation')).toHaveLength(1)
    // The one card, by the existing rule.
    const cards = await prisma.supervisorDecision.findMany({ where: { workspaceId: f.workspaceId, status: 'pending' }, select: { situationKind: true } })
    expect(cards).toEqual([{ situationKind: 'goal_needs_human' }])
  })

  it('commits what the lead left uncommitted, under the lead\'s name, before it is judged', async (): Promise<void> => {
    const f = await seedLead({ leadArgs: () => ['--no-commit', '--extra-file-base64', `notes/left.txt:${base64('left behind')}`] })
    await tickUntil(f, merged(f))
    const files = git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')
    expect(files).toContain('lead-work-1.txt')
    expect(files).toContain('notes/left.txt')
    const lead = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId }, role: 'Lead' }, include: { person: true } })
    expect(git(['log', '-1', '--format=%an', 'main'], f.repoPath)).toBe(lead.person.name)
  })
})
```

Run `npx vitest run apps/orchestrator/test/integration/lead-open.test.ts` → FAIL (the conductor asks the model for a plan: `f.others` holds a `"conductAnswer"` prompt and no package exists).

- [ ] **Step 5: Record, open, turn, stop.** Create `apps/orchestrator/src/lead/record.ts`:

```ts
import { withDeliveryLock } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { LEAD_NOTE_DETAIL_MAX_CHARS, readLeadProgress, storableText, trimToFit, type LeadNoteKind, type LeadProgress, type StopReason } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'

/** One line for the report about a lead-flow version (`workspace.lead_noted`). Never a card. */
export async function noteLead(input: { readonly workspaceId: string; readonly version: number; readonly kind: LeadNoteKind; readonly detail: string; readonly runId?: string | null }): Promise<void> {
  const detail = trimToFit(storableText(input.detail).trim(), LEAD_NOTE_DETAIL_MAX_CHARS)
  await appendEvent({
    type: 'workspace.lead_noted',
    workspaceId: input.workspaceId,
    actor: 'system',
    ...(input.runId == null ? {} : { runId: input.runId }),
    payload: { version: input.version, kind: input.kind, detail: detail === '' ? input.kind : detail, runId: input.runId ?? null },
  })
}

/** `LeadProgress` as the JSON column takes it. */
export const progressJson = (progress: LeadProgress): Prisma.InputJsonValue => progress as unknown as Prisma.InputJsonValue

/** Reads, changes and writes a version's progress under its delivery lock; returns what was written. */
export async function updateLeadProgress(deliveryId: string, change: (progress: LeadProgress) => LeadProgress): Promise<LeadProgress> {
  return withDeliveryLock(deliveryId, async (tx) => {
    const row = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { leadProgress: true } })
    const next = change(readLeadProgress(row.leadProgress))
    await tx.goalDelivery.update({ where: { id: deliveryId }, data: { leadProgress: progressJson(next) } })
    return next
  })
}

/**
 * Plan A L6/L7: the lead gets no further turn -- its share of the budget or the goal's time is
 * spent. Set once (the first reason stands) and said once. Returns whether this call ended it.
 */
export async function endLead(deliveryId: string, reason: StopReason, detail: string): Promise<boolean> {
  let ended = false
  await updateLeadProgress(deliveryId, (progress) => {
    if (progress.leadEnded !== null) return progress
    ended = true
    return { ...progress, leadEnded: reason, nextTurn: null }
  })
  if (ended) {
    const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { workspaceId: true, goalVersion: true } })
    await noteLead({ workspaceId: delivery.workspaceId, version: delivery.goalVersion, kind: 'lead_ended', detail })
  }
  return ended
}
```

Create `apps/orchestrator/src/lead/open.ts`:

```ts
import { ensureLeadSeats, refusalText } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { INITIAL_LEAD_PROGRESS, LEAD_TEMPLATE_ID, integrationBranchName, requirementItemsSchema, singlePlan } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { AlreadyConducted, materialise, tripConductor, type ConductStep } from '../conductor.js'
import { ensureIntegrationBranch } from '../goalBranch.js'
import { progressJson } from './record.js'

/**
 * Lead-flow spec B1 (plan A L3): a goal version's plan in the lead flow -- one package that owns
 * everything and one task for the lead, by rule, with no model call. The conductor's own
 * `materialise` writes it, so the version has its delivery row, its work branch and its recorded
 * decision exactly as a `single` plan does; the lead and the verifier are the project's system
 * seats. A problem a later tick may fix (a branch that cannot be cut) is said once and tried again.
 */
export async function openLeadGoal(
  workspaceId: string,
  workspace: { readonly repoPath: string; readonly baseBranch: string; readonly maxAttempts: number },
  version: number,
  storedItems: Prisma.JsonValue,
): Promise<ConductStep> {
  const items = requirementItemsSchema.parse(storedItems)
  const seats = await ensureLeadSeats(workspaceId)
  if (!seats.ok) {
    await tripConductor(workspaceId, `goal v${String(version)} could not be opened in the lead flow: ${refusalText(seats.error)}`)
    return 'conduct_failed'
  }
  const plan = singlePlan(LEAD_TEMPLATE_ID, items.map((item) => item.key), 'lead flow: one lead builds the whole goal')
  const integrationBranch = integrationBranchName(version, workspaceId)
  let cut: { readonly baseCommit: string }
  try {
    cut = await ensureIntegrationBranch(workspace.repoPath, workspace.baseBranch, integrationBranch)
  } catch (error) {
    const message = error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)
    await tripConductor(workspaceId, `goal v${String(version)} could not cut its work branch: ${message}`)
    return 'conduct_failed'
  }
  try {
    await materialise(workspaceId, version, workspace.maxAttempts, plan, true, new Map([['main', seats.value.lead]]), items, {
      integrationBranch,
      baseCommit: cut.baseCommit,
      verifierSlaveId: seats.value.verifier,
    })
  } catch (error) {
    if (error instanceof AlreadyConducted) return 'none'
    throw error
  }
  // After the plan's own transaction: a crash between the two leaves `leadState` null, and the goal
  // pass's `syncLeadStates` (Task 8) writes it.
  const marked = await prisma.goalDelivery.updateMany({
    where: { workspaceId, goalVersion: version, leadState: null },
    data: { leadState: 'building', leadProgress: progressJson(INITIAL_LEAD_PROGRESS) },
  })
  if (marked.count > 0) await appendEvent({ type: 'workspace.lead_state', workspaceId, actor: 'system', payload: { version, state: 'building', reason: null } })
  return 'conducted'
}
```

Create `apps/orchestrator/src/lead/turn.ts`:

```ts
import { goalSpend, goalWorkedMs, loadLeadRoster } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { buildRosterDefinitions, leadShareUsd, nextLeadLeg, readLeadProgress, type LeadTurn } from '@slave-of-ai/domain'
import { endLead, noteLead, updateLeadProgress } from './record.js'

/** One turn of the lead's session, as `startRun` spawns it. */
export interface LeadTurnRun {
  readonly kind: 'run'
  readonly deliveryId: string
  readonly workspaceId: string
  readonly goalVersion: number
  /** 1-based: the n-th turn of this task. */
  readonly ordinal: number
  readonly turn: LeadTurn
  /** The session this turn continues, or null for a new one. */
  readonly resumeSessionId: string | null
  /** A new session although earlier turns exist: the transcript is gone. */
  readonly continuation: boolean
  readonly note: string | null
  /** This leg's `--max-budget-usd`; null for an unbudgeted goal. */
  readonly capUsd: number | null
  /** This turn is the wrap-up (spec B4). */
  readonly wrapUp: boolean
  /** The `--agents` value; null for an empty roster. */
  readonly definitions: string | null
  readonly roster: readonly { readonly slug: string; readonly description: string }[]
  readonly rosterDropped: readonly string[]
  readonly budget: { readonly totalUsd: number; readonly shareUsd: number; readonly spentUsd: number } | null
  readonly timeLeftMs: number | null
}

export type LeadTurnPlan = { readonly kind: 'hold' } | LeadTurnRun

/**
 * Lead-flow plan A L4/L6: what the lead's next turn is, or `hold`. Held: the version is stopped,
 * abandoned or merged, or the lead is ended. A share or a time limit found spent here ends the lead
 * (`endLead`) and holds. Otherwise: the first turn is `build` with the whole brief; a later one is
 * what was queued for it (`leadProgress.nextTurn`), else `rework` when the task carries a
 * rejection, else `continue` -- and it resumes the newest session of the task, unless the newest
 * turn was a resume that never reached its session line (the transcript is gone).
 */
export async function planLeadTurn(input: {
  readonly task: { readonly id: string; readonly lastRejectionReason: string | null }
  readonly deliveryId: string
}): Promise<LeadTurnPlan> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({
    where: { id: input.deliveryId },
    include: { workspace: { select: { budgetUsd: true, goalTimeLimitMs: true, leadRoster: true } } },
  })
  const progress = readLeadProgress(delivery.leadProgress)
  if (delivery.status === 'needs_human' || delivery.status === 'abandoned' || delivery.mergedAt !== null || progress.leadEnded !== null) return { kind: 'hold' }

  const spend = await goalSpend(delivery.workspaceId, delivery.goalVersion)
  // A leg that ended on its cap queues the wrap-up itself (`concludeLeadTurn`): the vendor may stop
  // a few cents short of the mark, and the turn after a capped leg is the wrap-up whatever the sum says.
  const queuedWrapUp = progress.nextTurn?.kind === 'wrap_up' && !progress.wrapUpSent
  const leg = nextLeadLeg({ budgetUsd: delivery.workspace.budgetUsd, leadSpentUsd: spend.leadUsd, wrapUpSent: progress.wrapUpSent || queuedWrapUp })
  if (leg.kind === 'spent') {
    // C7: a turn that ended with no cost and no later total of its session is not in the sum.
    const spent = `${spend.unmeasuredRuns > 0 ? 'at least ' : ''}$${spend.leadUsd.toFixed(2)}`
    await endLead(delivery.id, 'budget_spent', `the lead's share of the budget is spent (${spent})`)
    return { kind: 'hold' }
  }
  const limit = delivery.workspace.goalTimeLimitMs
  const timeLeftMs = limit === null ? null : limit - (await goalWorkedMs(delivery.workspaceId, delivery.goalVersion))
  if (timeLeftMs !== null && timeLeftMs <= 0) {
    await endLead(delivery.id, 'time_spent', `the goal's time limit of ${String(Math.round((limit ?? 0) / 60_000))} minutes is reached`)
    return { kind: 'hold' }
  }

  const earlier = await prisma.slaveRun.findMany({
    where: { taskId: input.task.id, leadTurn: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { sessionId: true, leadResumed: true, status: true, pid: true },
  })
  const newest = earlier[0]
  // A resume that was spawned (it has a pid) and failed before its session line: no transcript.
  const lost = newest !== undefined && newest.leadResumed && newest.sessionId === null && newest.status === 'failed' && newest.pid !== null
  const session = lost ? null : (earlier.find((run) => run.sessionId !== null)?.sessionId ?? null)
  const first = earlier.length === 0
  const queued = progress.nextTurn
  const wrapUp = leg.wrapUp || queuedWrapUp
  const turn: LeadTurn = first ? 'build' : wrapUp ? 'wrap_up' : (queued?.kind ?? (input.task.lastRejectionReason !== null ? 'rework' : 'continue'))
  // What came back for this turn: what was queued, else the rejection the task carries (a
  // verifier's evidence survives a turn that crashed before it could act on it).
  const note = first ? null : queued !== null && queued.note !== '' ? queued.note : input.task.lastRejectionReason

  const built = buildRosterDefinitions(await loadLeadRoster(delivery.workspace.leadRoster))
  const definitions = built.json === null ? {} : (JSON.parse(built.json) as Record<string, { readonly description: string }>)
  const total = delivery.workspace.budgetUsd
  return {
    kind: 'run',
    deliveryId: delivery.id,
    workspaceId: delivery.workspaceId,
    goalVersion: delivery.goalVersion,
    ordinal: earlier.length + 1,
    turn,
    resumeSessionId: session,
    continuation: !first && session === null,
    note,
    capUsd: leg.capUsd,
    wrapUp,
    definitions: built.json,
    roster: [...built.slugs.keys()].map((slug) => ({ slug, description: definitions[slug]?.description ?? '' })),
    rosterDropped: built.dropped,
    budget: total === null ? null : { totalUsd: total, shareUsd: leadShareUsd(total), spentUsd: spend.leadUsd },
    timeLeftMs,
  }
}

/**
 * The turn was spawned: what was queued for it is consumed, a wrap-up is marked sent, and the turn
 * is recorded -- which session it runs on is the record spec B6 asks for.
 */
export async function noteLeadTurnStarted(plan: LeadTurnRun, runId: string): Promise<void> {
  await updateLeadProgress(plan.deliveryId, (progress) => ({ ...progress, nextTurn: null, wrapUpSent: progress.wrapUpSent || plan.wrapUp }))
  const session =
    plan.resumeSessionId !== null ? 'the same session was resumed' : plan.continuation ? 'a new session was started; the earlier transcript is gone' : 'a new session was started'
  const at = { workspaceId: plan.workspaceId, version: plan.goalVersion, runId }
  await noteLead({ ...at, kind: 'turn', detail: `turn ${String(plan.ordinal)} (${plan.turn}): ${session}` })
  if (plan.wrapUp) await noteLead({ ...at, kind: 'wrap_up', detail: 'the lead reached four fifths of its share of the budget and was told to wrap up' })
  if (plan.rosterDropped.length > 0) await noteLead({ ...at, kind: 'roster_dropped', detail: `not passed to the lead, the definitions did not fit: ${plan.rosterDropped.join(', ')}` })
}
```

Create `apps/orchestrator/src/lead/stop.ts`:

```ts
import { withDeliveryLock } from '@slave-of-ai/control'
import type { Prisma } from '@slave-of-ai/db/client'
import { readLeadProgress, renderLeadStop, type LeadProgress, type StopReason } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { progressJson } from './record.js'

/**
 * Lead-flow spec D2 / P7 (plan A L12/L13): a lead-flow version's loop ends without acceptance.
 * Inside the delivery's lock: from `integrating` or `verifying` to the existing `needs_human`, with
 * every claim released, the text of the one card (`renderLeadStop`), the state word and the stop
 * reason, in one guarded write. The two events follow the move: the card is raised from the ROW
 * (the Supervisor's existing `goal_needs_human` rule), so a crash between the two loses a timeline
 * line and never the card. Returns whether this call stopped it.
 */
export async function stopLeadInLock(tx: Prisma.TransactionClient, deliveryId: string, reason: StopReason, progress: LeadProgress, detail: string | null): Promise<boolean> {
  const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId } })
  if (delivery.status !== 'integrating' && delivery.status !== 'verifying') return false
  const text = renderLeadStop({ version: delivery.goalVersion, reason, failing: progress.failing, disputed: progress.disputed, unverifiable: progress.unverifiable, detail })
  const moved = await tx.goalDelivery.updateMany({
    where: { id: deliveryId, status: { in: ['integrating', 'verifying'] } },
    data: {
      status: 'needs_human',
      activeRunId: null,
      activeSmokeId: null,
      needsHumanReason: text,
      leadState: 'awaiting_decision',
      stopReason: reason,
      leadProgress: progressJson({ ...progress, nextTurn: null, confirm: null }),
    },
  })
  if (moved.count === 0) return false
  await appendEvent({ type: 'workspace.goal_needs_human', workspaceId: delivery.workspaceId, actor: 'system', payload: { version: delivery.goalVersion, reason: text } })
  await appendEvent({ type: 'workspace.lead_state', workspaceId: delivery.workspaceId, actor: 'system', payload: { version: delivery.goalVersion, state: 'awaiting_decision', reason } })
  return true
}

/** {@link stopLeadInLock} for a caller holding no lock, on the version's stored progress. */
export async function stopLead(deliveryId: string, reason: StopReason, detail: string | null): Promise<boolean> {
  return withDeliveryLock(deliveryId, async (tx) => {
    const row = await tx.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, select: { leadProgress: true } })
    return stopLeadInLock(tx, deliveryId, reason, readLeadProgress(row.leadProgress), detail)
  })
}
```

- [ ] **Step 6: Conclude.** Create `apps/orchestrator/src/lead/conclude.ts`:

```ts
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import type { RunId } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { integrationTargetFor } from '../goalBranch.js'
import { releaseTaskAfterFailure } from '../taskRelease.js'
import { emailLocalPart, taskKeyFor } from '../tick.js'
import { commitUncommittedWork } from '../wipCommit.js'
import { gitIn } from '../worktree.js'
import { updateLeadProgress } from './record.js'
import { stopLead } from './stop.js'

const runInclude = { task: { include: { workspace: true } }, slave: { select: { id: true, person: { select: { name: true } } } } } as const
export type LeadRunRow = Prisma.SlaveRunGetPayload<{ include: typeof runInclude }>
export type LeadTaskRow = NonNullable<LeadRunRow['task']>

/**
 * Lead-flow spec B1 (plan A L5): what a concluded lead turn means for its task. Never `advance`:
 * no workspace verify command, no ownership audit, no report block, no review. A succeeded turn's
 * work is integrated ({@link settleLeadWork}) and the goal pass proves it. A failed turn releases
 * the task as any failed implementation run does. Replay-safe: only the run holding the task's
 * claim concludes anything.
 */
export async function concludeLeadTurn(runId: RunId): Promise<void> {
  const run = await prisma.slaveRun.findUnique({ where: { id: runId }, include: runInclude })
  if (run === null || run.task === null || run.leadTurn === null) return
  const task = run.task
  if (task.activeRunId !== run.id) return

  if (run.status === 'failed') {
    const release = await releaseTaskAfterFailure(task, run.id, 'rework', { platform: run.failureClass === 'platform' })
    if (release.exhausted) {
      await appendEvent({ type: 'task.failed', workspaceId: task.workspaceId, taskId: task.id, actor: 'system', payload: { reason: `the lead's turn failed after ${String(release.attempt)} attempt(s)` } })
    }
    return
  }
  if (run.status !== 'succeeded') return
  await settleLeadWork(run, task)
}

/**
 * Integrates what the lead committed and hands the version to proof: leftover work is committed
 * under the lead's identity, the goal's work branch is fast-forwarded to the lead's branch (a
 * compare-and-swap on the ref; only the lead writes there, so the old tip is always an ancestor),
 * and the task is `done` and integrated -- which is what the goal pass waits for. A branch still at
 * the commit the goal was cut at is "nothing was built": the version stops and no proof starts.
 */
export async function settleLeadWork(run: LeadRunRow, task: LeadTaskRow): Promise<'settled' | 'nothing_built' | 'unreadable'> {
  const target = await integrationTargetFor(task.id)
  if (target === null || run.worktreePath === null || task.branch === null) {
    console.warn(`[lead] run ${run.id} has no ${target === null ? 'goal version' : run.worktreePath === null ? 'worktree' : 'branch'} recorded: not settling`)
    return 'unreadable'
  }
  const repoPath = task.workspace.repoPath
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: target.deliveryId } })

  const wip = await commitUncommittedWork({
    worktreePath: run.worktreePath,
    branch: task.branch,
    taskKey: taskKeyFor(task.id),
    identity: { name: run.slave.person.name, email: `${emailLocalPart({ id: run.slave.id, name: run.slave.person.name })}@slaveofai.local` },
  })
  if (wip.kind === 'committed') console.warn(`[lead] run ${run.id} left uncommitted work; committed it for the lead as ${wip.sha.slice(0, 12)}`)
  if (wip.kind === 'skipped' || wip.kind === 'failed') console.warn(`[lead] run ${run.id} left uncommitted work that could not be committed (${wip.kind}): ${wip.reason}`)

  const tip = await gitIn(repoPath, 'rev-parse', `refs/heads/${task.branch}`)
  if (tip === delivery.baseCommit) {
    // Spec section 9: the claim goes back first, so nothing holds the task while the version waits.
    await prisma.task.updateMany({ where: { id: task.id, activeRunId: run.id }, data: { status: 'rework', activeRunId: null } })
    await stopLead(delivery.id, 'nothing_built', null)
    return 'nothing_built'
  }
  const workTip = await gitIn(repoPath, 'rev-parse', `refs/heads/${target.branch}`)
  if (tip !== workTip) {
    await gitIn(repoPath, 'merge-base', '--is-ancestor', workTip, tip)
    await gitIn(repoPath, 'update-ref', `refs/heads/${target.branch}`, tip, workTip)
  }

  const done = await prisma.task.updateMany({
    where: { id: task.id, activeRunId: run.id },
    data: { status: 'done', integratedAt: new Date(), activeRunId: null, lastRejectionReason: null },
  })
  if (done.count === 0) return 'settled'
  await updateLeadProgress(delivery.id, (progress) => ({ ...progress, nextTurn: null }))
  await appendEvent({ type: 'task.done', workspaceId: task.workspaceId, taskId: task.id, actor: 'system', payload: { branch: task.branch } })
  return 'settled'
}
```

- [ ] **Step 7: The three branch points.**

`apps/orchestrator/src/conductor.ts`: add `flow: true,` to `conduct`'s `select`; write `export class AlreadyConducted extends Error {}` and `export async function materialise(`; import `openLeadGoal` from `'./lead/open.js'` (the two modules import each other, as `conductor.ts` and `verification.ts` already do: `open.ts` reads `AlreadyConducted` and `materialise` only inside `openLeadGoal`, at run time, never at module evaluation); and replace the last two lines of `conduct`

```ts
  if (set === null) return extractRequirements(deps.workspaceId, call, workspace.goal, version, workspace.haltClearedAt)
  return decideAndMaterialise(deps.workspaceId, call, { ...workspace, goal: workspace.goal }, version, set.items)
```

with

```ts
  if (set === null) return extractRequirements(deps.workspaceId, call, workspace.goal, version, workspace.haltClearedAt)
  // Lead flow (spec B1, plan A L3): one package and one task for the lead, by rule -- no model call
  // for the plan. The requirement extraction above is the conductor's still (spec S8 moves it in plan B).
  if (workspace.flow === 'lead') return openLeadGoal(deps.workspaceId, workspace, version, set.items)
  return decideAndMaterialise(deps.workspaceId, call, { ...workspace, goal: workspace.goal }, version, set.items)
```

`apps/orchestrator/src/verify.ts`: import `concludeLeadTurn` from `'./lead/conclude.js'`; in `verifyConcludedRun`, directly after `if (run === null) return`:

```ts
  // Lead flow (spec B1, plan A L5): a turn of a lead's session is concluded by its own path -- no
  // ownership audit, no report block, no verify command, no review. `leadTurn` is null on every
  // other run.
  if (run.leadTurn !== null) {
    await concludeLeadTurn(brandRunId(run.id))
    return
  }
```

`apps/orchestrator/src/tick.ts`, in `startRun`: import `writeSpawnExtras` from `@slave-of-ai/providers`, `buildLeadContext` from `'./lead/context.js'`, `noteLeadTurnStarted, planLeadTurn` from `'./lead/turn.js'`.

(a) After the block

```ts
  if (task.status === 'ready' || task.status === 'rework') {
    if (await cancelIfVersionAbandoned(task, target, task.status)) return null
  }
```

add

```ts
  // Lead flow (spec B1/B6/B8, plan A L4): the lead's task is dispatched as a TURN of its session.
  // `hold` is not a failure and writes nothing -- the version is stopped or the lead is ended --
  // so it returns before the run row, like the abandoned-version case above.
  const leadPlan = workspace.flow === 'lead' && target !== null ? await planLeadTurn({ task, deliveryId: target.deliveryId }) : null
  if (leadPlan?.kind === 'hold') return null
  const lead = leadPlan?.kind === 'run' ? leadPlan : null
```

(b) Change the run insert to

```ts
  const run = await createRunUnlessArchived(workspace.id, {
    taskId: task.id,
    slaveId: slave.id,
    status: 'starting',
    ...(lead === null ? {} : { leadTurn: lead.turn, leadResumed: lead.resumeSessionId !== null }),
  })
```

(c) Replace `const built = await buildRunContext({ … })` with

```ts
    const built =
      lead === null
        ? await buildRunContext({
            runId,
            kind: 'implementation',
            slaveId: slave.id,
            workspaceId: workspace.id,
            taskId: task.id,
            worktreePath: worktree.path,
            provider: resolved.provider,
          })
        : await buildLeadContext({
            runId,
            workspaceId: workspace.id,
            goalVersion: lead.goalVersion,
            worktreePath: worktree.path,
            turn: lead.turn,
            resumed: lead.resumeSessionId !== null,
            continuation: lead.continuation,
            note: lead.note,
            roster: lead.roster,
            budget: lead.budget,
            timeLeftMs: lead.timeLeftMs,
          })
    // Lead flow (plan A L6/L16): the roster, the leg's budget cap and the keep-alive ride in the
    // run directory, where a resume of this same row finds them again.
    if (lead !== null) {
      writeSpawnExtras(runDir, {
        ...(lead.definitions === null ? {} : { sessionDefinitions: lead.definitions }),
        ...(lead.capUsd === null ? {} : { maxBudgetUsd: lead.capUsd }),
        keepAliveForSubordinates: true,
      })
    }
```

(d) In `runAdapter.start({ … })`, after the `model` spread, add `...(lead === null || lead.resumeSessionId === null ? {} : { resumeSessionId: lead.resumeSessionId }),`.

(e) After the `await prisma.slaveRun.update({ where: { id: run.id }, data: { pid: handle.pid, … } })` statement, add `if (lead !== null) await noteLeadTurnStarted(lead, run.id)`.

(f) The lead's runtime (C5). In `packages/control/src/runtime.ts`, after `resolveRuntime`:

```ts
/**
 * Lead flow (C5): the runtime of a lead-flow system seat -- the lead, the verifier, the confirmer.
 * Always Claude Code (the flow runs on nothing else, `setFlow` checks it), with the seat's own model
 * when `set-flow --model` / `set-lead --model` named one and NONE otherwise: no `--model` flag, so
 * the installed CLI's own default -- "the most capable available" as the operator set it up -- is
 * used. Not through the chain above: a seat with no model would fall to the workspace default,
 * which a second `ProviderConfiguration` row turns into a refusal.
 */
export function leadRuntime(seat: { readonly model: string | null }): ResolvedRuntime {
  return { provider: 'claude_code', model: seat.model ?? undefined }
}
```

In `apps/orchestrator/src/model.ts` add `leadRuntime` to the re-export. In `startRun`, import it from `'./model.js'` and replace `const resolved = resolveRuntime(` … `)` with `const resolved = lead !== null ? leadRuntime(slave) : resolveRuntime(` … `)` (the arguments unchanged).

In `packages/control/test/runtime.test.ts` import `leadRuntime` beside `resolveRuntime` and add:

```ts
describe('leadRuntime (lead flow C5)', () => {
  it('runs a lead-flow seat on Claude Code, with its own model when it names one and none otherwise', () => {
    expect(leadRuntime({ model: null })).toEqual({ provider: 'claude_code', model: undefined })
    expect(leadRuntime({ model: 'claude-opus-5' })).toEqual({ provider: 'claude_code', model: 'claude-opus-5' })
  })
})
```

- [ ] **Step 8: Run.** `npx tsc --build && npx vitest run packages/control/test/runtime.test.ts apps/orchestrator/test/integration/lead-open.test.ts` → PASS. Then, one file at a time, the unchanged neighbours: `npx vitest run apps/orchestrator/test/integration/conductor.test.ts`, `…/conductor-e2e.test.ts`, `…/tick.test.ts`, `…/verify.test.ts` → PASS. `npm run typecheck`.

- [ ] **Step 9: Commit**

```bash
git add packages/domain/src/lead packages/domain/test/lead/stop.test.ts packages/control/src/runtime.ts packages/control/test/runtime.test.ts apps/orchestrator/src/lead apps/orchestrator/src/conductor.ts apps/orchestrator/src/model.ts apps/orchestrator/src/tick.ts apps/orchestrator/src/verify.ts apps/orchestrator/test/integration/lead-helpers.ts apps/orchestrator/test/integration/lead-open.test.ts
git commit -m "feat(lead): a goal set in the lead flow is planned by rule, built by one lead turn and handed to proof with no review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: The same session, whatever interrupts it; questions answered at once; decisions on record (B6, B7, B9, L4, L10, L18)

**Files:**
- Create: `packages/domain/src/lead/decisions.ts`; modify `packages/domain/src/lead/constants.ts` (`LEAD_DECISIONS_READ_MAX`, `LEAD_DENIAL_CONTINUES_MAX`, the note kind `denied`), `packages/domain/src/lead/progress.ts` (`denialContinues`, C6), `packages/domain/src/lead/index.ts`
- Create: `packages/control/src/lead/decisions.ts`; modify `packages/control/src/conductorAnswer.ts:60` (`writeGoalDecisionIn`'s `source` type), `packages/control/src/index.ts`
- Modify: `apps/orchestrator/src/lead/conclude.ts` (replace `concludeLeadTurn`; `settleLeadWork` gains two steps), `apps/orchestrator/src/lead/record.ts` (`noteLeadOnce`), `apps/orchestrator/src/lead/turn.ts` (`refreshLeadSpawn`)
- Modify: `apps/orchestrator/src/pump.ts:1429` (the ask hook's condition)
- Modify: `apps/orchestrator/src/resume.ts` (`executeResume`: one branch before `adapter.resume`)
- Test: `packages/domain/test/lead/decisions.test.ts` (new), `packages/domain/test/lead/state.test.ts` (one case: `denialContinues`), `apps/orchestrator/test/integration/lead-turn.test.ts` (new)

**Interfaces:**
- Consumes: Task 6's `settleLeadWork`, `stopLead`, `endLead`, `updateLeadProgress`, `noteLead`, `planLeadTurn`; `isBudgetCapReason`, `parseSlaveAsk`, `readLeadProgress`, `nextLeadLeg` (domain); `writeGoalDecisionIn`, `GoalDecisionRefused`, `goalSpend` (control); `joinRunOutput` (`apps/orchestrator/src/runOutput.ts`); `readSpawnExtras`, `writeSpawnExtras` (providers).
- Produces (domain): `LEAD_DECISIONS_READ_MAX = 40`; `LEAD_DENIAL_CONTINUES_MAX = 2`; `LEAD_NOTE_KINDS` gains `denied`; `LeadProgress.denialContinues: number` (default 0); `parseLeadDecisions(markdown: string): readonly { readonly title: string; readonly decision: string }[]`.
- Produces (control): `recordLeadDecisions(workspaceId: string, goalVersion: number, decisions: readonly { readonly title: string; readonly decision: string }[]): Promise<{ readonly written: number; readonly known: number; readonly refused: number }>`.
- Produces (orchestrator): `noteLeadOnce(input)` (same input as `noteLead`; skips a line the version already has); `refreshLeadSpawn(runId: string, runDir: string): Promise<void>`.
- What a failed lead turn means now (replaces Task 6's plain release):

  | The turn ended… | Attempt | Next |
  |---|---|---|
  | after the goal's limit ended the lead (`leadEnded` set, Task 8) | none | what is committed is settled and proved |
  | on the vendor's budget cap, wrap-up not yet sent | none | the `wrap_up` turn, same session |
  | on the vendor's budget cap, wrap-up sent | none | the lead is ended `budget_spent`; what is committed is settled and proved |
  | as a resume that never reached its session line | none | a new session with a continuation note |
  | `platform` (orphaned by a restart, provider refusal) | none | `continue` (or the queued turn), same session; a refusal waits out its backoff and is noted |
  | only because calls were refused by the permission mode (C6) | none, `LEAD_DENIAL_CONTINUES_MAX` times per version | `continue`, same session, told which calls were refused; past the bound, as the next row |
  | any other way (an error result, a stall, a crash) | one | `continue`, same session; at the attempt cap the version stops `lead_failed` |

- Unchanged for `packages`: the pump's hook is skipped only for a run with `leadTurn` set; `executeResume`'s branch runs only for such a run; `writeGoalDecisionIn` accepts one more source and writes exactly what it wrote.

- [ ] **Step 1: Failing domain test.** Create `packages/domain/test/lead/decisions.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { LEAD_DECISIONS_READ_MAX, parseLeadDecisions } from '../../src/lead/index.js'

describe('parseLeadDecisions (lead-flow spec B9)', () => {
  it('reads one decision per "## " heading, with everything under it as its text', () => {
    const file = ['# Decisions', '', 'Recorded while building.', '', '## Database', 'SQLite, one file.', '', 'Reason: no server to run.', '', '### Detail', 'WAL mode.', '', '## Port  ', '8080, as the README says.'].join('\n')
    expect(parseLeadDecisions(file)).toEqual([
      { title: 'Database', decision: 'SQLite, one file.\n\nReason: no server to run.\n\n### Detail\nWAL mode.' },
      { title: 'Port', decision: '8080, as the README says.' },
    ])
  })

  it('skips a heading with nothing under it, and reads nothing from a file with no such heading', () => {
    expect(parseLeadDecisions('## Empty\n\n## Kept\nyes')).toEqual([{ title: 'Kept', decision: 'yes' }])
    expect(parseLeadDecisions('we decided things\n')).toEqual([])
    expect(parseLeadDecisions('')).toEqual([])
  })

  it('reads at most the bound, and reads CRLF files', () => {
    const many = Array.from({ length: LEAD_DECISIONS_READ_MAX + 5 }, (_, i) => `## D${String(i)}\r\ntext ${String(i)}\r\n`).join('')
    const read = parseLeadDecisions(many)
    expect(read).toHaveLength(LEAD_DECISIONS_READ_MAX)
    expect(read[0]).toEqual({ title: 'D0', decision: 'text 0' })
  })
})
```

Run `npx vitest run packages/domain/test/lead/decisions.test.ts` → FAIL.

- [ ] **Step 2: The parser and the writer.** Add to `packages/domain/src/lead/constants.ts`:

```ts
/** Spec B9: how many decisions one read of the lead's file takes -- a version holds at most 40. */
export const LEAD_DECISIONS_READ_MAX = 40
/**
 * C6: how often per goal version a turn failed only by the permission mode's refusals continues
 * the lead without an attempt charged. Bounded: a lead that keeps calling what is refused is
 * charged after that, and its attempt cap ends it.
 */
export const LEAD_DENIAL_CONTINUES_MAX = 2
```

and `'denied',` to `LEAD_NOTE_KINDS` after `'ask_refused',` (C6: the permission mode refused calls and the lead was told). In `packages/domain/src/lead/progress.ts` add to `LeadProgress`, after `askReplies`:

```ts
  /** C6: how often a turn failed only by permission-mode refusals was continued without a charge. */
  readonly denialContinues: number
```

`denialContinues: 0,` to `INITIAL_LEAD_PROGRESS` after `askReplies: 0,`, and `denialContinues: z.number().int().nonnegative().default(0),` to `leadProgressSchema` after `askReplies`. In `packages/domain/test/lead/state.test.ts`, in `describe('readLeadProgress')`, add:

```ts
  it('reads a row written before denialContinues existed as none spent (C6)', () => {
    expect(readLeadProgress({ askReplies: 1 }).denialContinues).toBe(0)
    expect(readLeadProgress({ denialContinues: 2 }).denialContinues).toBe(2)
  })
```

Create `packages/domain/src/lead/decisions.ts`:

```ts
import { LEAD_DECISIONS_READ_MAX } from './constants.js'

/**
 * Lead-flow spec B9 (plan A L18): the decisions in the lead's docs/DECISIONS.md -- one per `## `
 * heading, the heading its title and everything up to the next `## ` or `# ` heading its text
 * (deeper headings stay in the text). A heading with nothing under it is not a decision. Pure
 * text handling: the writer bounds and sanitises what is stored.
 */
export function parseLeadDecisions(markdown: string): readonly { readonly title: string; readonly decision: string }[] {
  const decisions: { title: string; decision: string }[] = []
  let title: string | null = null
  let body: string[] = []
  const flush = (): void => {
    if (title === null) return
    const decision = body.join('\n').trim()
    if (decision !== '') decisions.push({ title, decision })
  }
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^##\s+(.*\S)\s*$/u.exec(line)
    if (heading !== null) {
      flush()
      title = heading[1] ?? ''
      body = []
    } else if (/^#\s/u.test(line)) {
      flush()
      title = null
      body = []
    } else if (title !== null) {
      body.push(line)
    }
  }
  flush()
  return decisions.slice(0, LEAD_DECISIONS_READ_MAX)
}
```

Add `export * from './decisions.js'` to the lead index; run the test → PASS. In `packages/control/src/conductorAnswer.ts` widen `writeGoalDecisionIn`'s `readonly source: 'conductor_answer' | 'person'` to `'conductor_answer' | 'person' | 'lead'`. Create `packages/control/src/lead/decisions.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { GoalDecisionRefused, writeGoalDecisionIn } from '../conductorAnswer.js'

/**
 * Lead-flow spec B9 (plan A L18): the lead's decisions as decision records with the source `lead`,
 * through the one writer every shared decision goes through -- sanitised, bounded, a title the
 * version already has left alone (the file is read again after every turn), nothing past the
 * version's cap. Each decision is its own transaction: one that is refused costs the others nothing.
 */
export async function recordLeadDecisions(
  workspaceId: string,
  goalVersion: number,
  decisions: readonly { readonly title: string; readonly decision: string }[],
): Promise<{ readonly written: number; readonly known: number; readonly refused: number }> {
  let written = 0
  let known = 0
  let refused = 0
  for (const [index, one] of decisions.entries()) {
    try {
      await prisma.$transaction((tx) => writeGoalDecisionIn(tx, { workspaceId, goalVersion, title: one.title, decision: one.decision, source: 'lead', questionId: null, decisionId: null }))
      written += 1
    } catch (error) {
      if (!(error instanceof GoalDecisionRefused)) throw error
      if (error.why === 'at_cap') {
        refused = decisions.length - index
        break
      }
      if (error.why === 'title_taken') known += 1
    }
  }
  return { written, known, refused }
}
```

Add `export * from './lead/decisions.js'` to `packages/control/src/index.ts`.

- [ ] **Step 3: Failing integration test.** Create `apps/orchestrator/test/integration/lead-turn.test.ts`:

```ts
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { requestResume } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_DENIAL_CONTINUES_MAX, readLeadProgress } from '@slave-of-ai/domain'
import { readSpawnExtras } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { reconcileOrphans, resetTickObservation } from '../../src/sweep.js'
import { drainPumps, tick } from '../../src/tick.js'
import { LEAD_TRUNCATE, base64, cleanUpLeadRepos, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil, type LeadFixture } from './lead-helpers.js'

let DEAD_PID = 0
const leadTurns = (f: LeadFixture) => f.starts.filter((s) => s.kind === 'implementation')
const errorResult = base64({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'error_during_execution', result: 'the tool crashed' })
const SESSION = /^fake-session/

describe('the lead flow: one session, whatever interrupts it', () => {
  beforeAll(async (): Promise<void> => {
    const child = spawn('/bin/sh', ['-c', 'exit 0'])
    DEAD_PID = child.pid ?? 0
    await new Promise<void>((res) => child.on('exit', () => res()))
  })

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(LEAD_TRUNCATE)
    resetTickObservation()
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    cleanUpLeadRepos()
    await prisma.$disconnect()
  })

  it('resumes the same session after an orphaned turn and charges no attempt', async (): Promise<void> => {
    const f = await seedLead()
    await tick(f.deps)
    await tick(f.deps)
    await drainPumps()
    // A daemon died mid-build: the turn's row says working, its process is gone.
    const task = await leadTaskOf(f)
    const lead = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId }, role: 'Lead' } })
    const orphan = await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: lead.id, kind: 'implementation', status: 'working', leadTurn: 'build', sessionId: 'sess-before-the-restart', pid: DEAD_PID } })
    await prisma.task.update({ where: { id: task.id }, data: { status: 'running', activeRunId: orphan.id } })

    resetTickObservation()
    expect(await reconcileOrphans({ workspaceId: f.deps.workspaceId, registry: f.deps.registry })).toBe(1)
    expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: orphan.id } })).toMatchObject({ status: 'failed', failureClass: 'platform' })
    expect(await leadTaskOf(f)).toMatchObject({ status: 'rework', attempt: 0, activeRunId: null })

    await tickUntil(f, async () => leadTurns(f).length > 0)
    const turn = leadTurns(f)[0]
    expect(turn).toMatchObject({ leadTurn: 'continue', resumeSessionId: 'sess-before-the-restart' })
    expect(turn?.prompt).toContain('Your session was interrupted and is being continued')
    expect(turn?.prompt).not.toContain('THE GOAL')
    expect(await leadNotes(f)).toContain('turn: turn 2 (continue): the same session was resumed')
    await tickUntil(f, merged(f))
    expect((await leadTaskOf(f)).attempt).toBe(0)
  })

  it('continues the same session after a failed turn, and stops the version when the lead runs out of attempts', async (): Promise<void> => {
    const f = await seedLead({ leadArgs: () => ['--result-patch-base64', errorResult] })
    await tickUntil(f, async () => (await leadDelivery(f)).status === 'needs_human')

    const turns = leadTurns(f)
    expect(turns.map((t) => t.leadTurn)).toEqual(['build', 'continue', 'continue'])
    expect(turns[0]?.resumeSessionId).toBeNull()
    expect(turns[1]?.resumeSessionId).toMatch(SESSION)
    expect(turns[2]?.resumeSessionId).toBe(turns[1]?.resumeSessionId)
    const delivery = await leadDelivery(f)
    expect([delivery.stopReason, delivery.leadState]).toEqual(['lead_failed', 'awaiting_decision'])
    expect(delivery.needsHumanReason).toContain('the lead could not finish a turn')
    expect((await leadTaskOf(f)).status).toBe('failed')
    for (let i = 0; i < 3; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }
    expect(leadTurns(f)).toHaveLength(3)
    // No workspace halt for three failures in a row, and exactly the one card.
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })).haltedReason).toBeNull()
    expect(await prisma.supervisorDecision.findMany({ where: { workspaceId: f.workspaceId, status: 'pending' }, select: { situationKind: true } })).toEqual([{ situationKind: 'goal_needs_human' }])
  })

  it('starts a new session with a continuation note when the transcript is gone, and charges nothing for finding out', async (): Promise<void> => {
    const f = await seedLead({ leadArgs: (ordinal) => (ordinal === 1 ? ['--result-patch-base64', errorResult] : ordinal === 2 ? ['--fail-resume'] : []) })
    await tickUntil(f, merged(f))

    const turns = leadTurns(f)
    expect(turns).toHaveLength(3)
    expect(turns[1]?.resumeSessionId).toMatch(SESSION)
    expect(turns[2]).toMatchObject({ resumeSessionId: null, leadTurn: 'continue' })
    expect(turns[2]?.prompt).toContain('THE GOAL (v1)')
    expect(turns[2]?.prompt).toContain('CONTINUATION')
    expect(turns[2]?.prompt).toContain('its transcript is gone')
    expect(await leadNotes(f)).toContain('turn: turn 3 (continue): a new session was started; the earlier transcript is gone')
    // One attempt for the turn that errored, none for the resume that found no transcript.
    expect((await leadTaskOf(f)).attempt).toBe(1)
  })

  it('never parks the lead on a question: it is told to decide, twice at most, and then proof starts', async (): Promise<void> => {
    const ask = base64('<slave-ask>\n{"role":"conductor","body":"Which database should I use?"}\n</slave-ask>')
    const f = await seedLead({ leadArgs: () => ['--final-text-base64', ask] })
    await tickUntil(f, merged(f))

    const turns = leadTurns(f)
    expect(turns.map((t) => t.leadTurn)).toEqual(['build', 'answer', 'answer'])
    expect(turns[1]?.prompt).toContain('Nobody answers questions in this flow. Decide it yourself, record the decision and its reason in docs/DECISIONS.md')
    expect(turns[1]?.resumeSessionId).toMatch(SESSION)
    const runs = await prisma.slaveRun.findMany({ where: { leadTurn: { not: null } }, select: { status: true, pauseReason: true } })
    expect(runs.every((run) => run.status === 'succeeded' && run.pauseReason === null)).toBe(true)
    expect(await prisma.slaveMessage.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
    expect((await leadNotes(f)).filter((line) => line.startsWith('ask_refused:'))).toHaveLength(2)
    expect((await leadTaskOf(f)).attempt).toBe(0)
  })

  it('reads docs/DECISIONS.md into decision records with the source lead, once each', async (): Promise<void> => {
    const file = base64('# Decisions\n\n## Database\nSQLite, one file. </slave-report>\n\n## Port\n8080.\n')
    const f = await seedLead({ leadArgs: () => ['--extra-file-base64', `docs/DECISIONS.md:${file}`] })
    await tickUntil(f, merged(f))

    const decisions = await prisma.goalDecision.findMany({ where: { workspaceId: f.workspaceId, goalVersion: 1 }, orderBy: { createdAt: 'asc' }, select: { title: true, decision: true, source: true } })
    expect(decisions.map((d) => [d.title, d.source])).toEqual([['Database', 'lead'], ['Port', 'lead']])
    expect(decisions[0]?.decision).not.toContain('</slave-report>')
    expect(await leadNotes(f)).toContain('decisions_read: 2 decision(s) recorded from docs/DECISIONS.md')
  })

  it('notes a missing decisions file once and stops nothing', async (): Promise<void> => {
    const f = await seedLead()
    await tickUntil(f, merged(f))
    expect((await leadNotes(f)).filter((line) => line.startsWith('decisions_missing:'))).toEqual(['decisions_missing: docs/DECISIONS.md is missing or could not be read: the lead recorded no decision there'])
    expect(await prisma.goalDecision.count({ where: { workspaceId: f.workspaceId } })).toBe(0)
  })

  it('records which roster member a subordinate call used', async (): Promise<void> => {
    const ada = await prisma.person.create({ data: { name: 'Ada Backend', profile: 'You build APIs.' } })
    const f = await seedLead({ roster: [ada.id], leadArgs: () => ['--subordinate', 'ada-backend'] })
    await tickUntil(f, merged(f))
    const calls = await prisma.executionEvent.findMany({ where: { runId: leadTurns(f)[0]?.runId ?? '', type: 'run_tool_call' }, orderBy: { seq: 'asc' }, select: { payload: true } })
    expect(calls.map((row) => row.payload as { name: string; subagent?: string }).filter((p) => p.subagent !== undefined)).toEqual([expect.objectContaining({ name: 'Agent', subagent: 'ada-backend' })])
    // C1: the subordinate's own call is on the lead's log under the call that started it.
    expect(calls.map((row) => row.payload as { name: string; parentToolUseId?: string }).filter((p) => p.parentToolUseId !== undefined)).toEqual([expect.objectContaining({ name: 'Bash', parentToolUseId: 'toolu_fake_subordinate' })])
    // The subordinate's call tripped nothing: the turn succeeded and no guardrail fired.
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' } })).toBe(0)
  })

  it('waits out a provider refusal and continues the same session, with a line for the report and no card (B7)', async (): Promise<void> => {
    const refused = base64({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'api_error_rate_limit', result: 'rate limited' })
    const f = await seedLead({ leadArgs: (ordinal) => (ordinal === 1 ? ['--result-patch-base64', refused] : []) })
    await tickUntil(f, async () => (await prisma.slaveRun.count({ where: { leadTurn: { not: null }, status: 'failed', providerError: true } })) === 1)
    await tick(f.deps)
    await drainPumps()
    expect(leadTurns(f)).toHaveLength(1) // held back by the provider backoff
    expect((await leadTaskOf(f)).attempt).toBe(0)
    expect((await leadNotes(f)).some((line) => line.startsWith('limit_wait:'))).toBe(true)

    // The backoff passes.
    await prisma.slaveRun.updateMany({ where: { leadTurn: { not: null } }, data: { terminalAt: new Date(Date.now() - 60 * 60_000) } })
    await tickUntil(f, merged(f))
    expect(leadTurns(f)[1]?.resumeSessionId).toMatch(SESSION)
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, situationKind: { not: 'conduct' } } })).toBe(0)
  })

  it('continues a turn the permission mode failed in the same session, tells the lead what was refused, and charges nothing (C6)', async (): Promise<void> => {
    // The recorded `permission-denied` capture: a clean result whose one Edit call the mode refused.
    const f = await seedLead({ leadArgs: (ordinal) => (ordinal === 1 ? ['--work-fixture', 'permission-denied'] : []) })
    await tickUntil(f, merged(f))

    const turns = leadTurns(f)
    expect(turns.map((t) => t.leadTurn)).toEqual(['build', 'continue'])
    expect(turns[1]?.resumeSessionId).toBe('fake-session-permission-denied')
    expect(turns[1]?.prompt).toContain('The permission mode refused these calls in your last turn: Edit (toolu_01Tz1SdA9gCmX7DXXkQwh6u3)')
    expect(turns[1]?.prompt).not.toContain('THE GOAL')
    expect((await leadTaskOf(f)).attempt).toBe(0)
    expect((await leadNotes(f)).filter((line) => line.startsWith('denied:'))).toEqual([
      'denied: the permission mode refused 1 call(s) (Edit (toolu_01Tz1SdA9gCmX7DXXkQwh6u3)); the lead continues in the same session, told what was refused',
    ])
    expect(readLeadProgress((await leadDelivery(f)).leadProgress).denialContinues).toBe(1)
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, situationKind: { not: 'conduct' } } })).toBe(0)
  })

  it('charges a denied turn once the uncharged continues are spent, and the attempt cap ends the lead (C6)', async (): Promise<void> => {
    const f = await seedLead({ leadArgs: () => ['--work-fixture', 'permission-denied'] })
    await tickUntil(f, async () => (await leadDelivery(f)).status === 'needs_human')

    // Two continues on the house, then three charged turns: the task's attempt cap.
    expect(leadTurns(f).map((t) => t.leadTurn)).toEqual(['build', 'continue', 'continue', 'continue', 'continue'])
    expect(leadTurns(f).slice(1).every((t) => t.resumeSessionId === 'fake-session-permission-denied')).toBe(true)
    expect((await leadNotes(f)).filter((line) => line.startsWith('denied:'))).toHaveLength(LEAD_DENIAL_CONTINUES_MAX)
    const delivery = await leadDelivery(f)
    expect([delivery.stopReason, readLeadProgress(delivery.leadProgress).denialContinues]).toEqual(['lead_failed', LEAD_DENIAL_CONTINUES_MAX])
    expect((await leadTaskOf(f)).attempt).toBe(3)
  })

  it('continues a paused lead turn on its own row, in its own session, under what is left of its leg (spec section 9)', async (): Promise<void> => {
    const f = await seedLead({ budgetUsd: 30, leadArgs: () => ['--work-fixture', 'hook-deny'], resumeArgs: ['--work-file', 'after-the-pause.txt'] })
    await tickUntil(f, async () => (await prisma.slaveRun.count({ where: { leadTurn: { not: null }, status: 'paused' } })) === 1)
    const run = await prisma.slaveRun.findFirstOrThrow({ where: { leadTurn: { not: null } } })
    const checkpoint = await prisma.checkpoint.findUniqueOrThrow({ where: { runId: run.id } })
    const runDir = dirname(checkpoint.pauseFlagPath)
    expect(readSpawnExtras(runDir).maxBudgetUsd).toBe(19.2)
    expect((await leadDelivery(f)).status).toBe('integrating')
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, status: 'pending' } })).toBe(0)

    // The person lowers the budget while it is parked, then continues.
    await prisma.workspace.update({ where: { id: f.workspaceId }, data: { budgetUsd: 20 } })
    expect((await requestResume(run.id, null, 'operator')).ok).toBe(true)
    await tickUntil(f, merged(f))

    expect(readSpawnExtras(runDir)).toMatchObject({ maxBudgetUsd: 12.8, keepAliveForSubordinates: true })
    expect(leadTurns(f)).toHaveLength(1) // the same run row, not a new turn
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('succeeded')
    expect(await prisma.executionEvent.count({ where: { runId: run.id, type: 'run_resumed' } })).toBe(1)
  })
})
```

Run `npx vitest run apps/orchestrator/test/integration/lead-turn.test.ts` → FAIL (the orphaned-turn case passes already on Task 6's code, and so does the subordinate case; the attempts-spent, lost-transcript, question, decisions, refusal, the two permission-mode (C6) and paused-turn cases fail).

- [ ] **Step 4: Notes said once, and the refreshed cap.** Add to `apps/orchestrator/src/lead/record.ts`:

```ts
/** {@link noteLead}, unless the version already has this very line: a standing fact is said once. */
export async function noteLeadOnce(input: Parameters<typeof noteLead>[0]): Promise<void> {
  const said = await prisma.executionEvent.findFirst({
    where: {
      workspaceId: input.workspaceId,
      type: 'workspace_lead_noted',
      AND: [{ payload: { path: ['version'], equals: input.version } }, { payload: { path: ['kind'], equals: input.kind } }, { payload: { path: ['detail'], equals: input.detail } }],
    },
    select: { seq: true },
  })
  if (said === null) await noteLead(input)
}
```

Add to `apps/orchestrator/src/lead/turn.ts` (imports: `LEAD_MIN_LEG_USD` from domain, `readSpawnExtras, writeSpawnExtras` from `@slave-of-ai/providers`, `integrationTargetFor` from `'../goalBranch.js'`):

```ts
/**
 * Plan A L6: a paused lead turn that is resumed on its own row (`executeResume`) continues under
 * what is LEFT of its leg, not under the cap it started with -- a `--max-budget-usd` counts per
 * process. With nothing left it gets the smallest leg: it ends on its cap at once, and its
 * conclusion ends the lead. The roster and the keep-alive are kept as they were written.
 */
export async function refreshLeadSpawn(runId: string, runDir: string): Promise<void> {
  const run = await prisma.slaveRun.findUnique({ where: { id: runId }, select: { taskId: true } })
  const target = run?.taskId == null ? null : await integrationTargetFor(run.taskId)
  if (target === null) return
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: target.deliveryId }, include: { workspace: { select: { budgetUsd: true } } } })
  const spend = await goalSpend(delivery.workspaceId, delivery.goalVersion)
  const leg = nextLeadLeg({ budgetUsd: delivery.workspace.budgetUsd, leadSpentUsd: spend.leadUsd, wrapUpSent: readLeadProgress(delivery.leadProgress).wrapUpSent })
  const capUsd = leg.kind === 'spent' ? LEAD_MIN_LEG_USD : leg.capUsd
  const extras = readSpawnExtras(runDir)
  writeSpawnExtras(runDir, {
    ...(extras.sessionDefinitions === undefined ? {} : { sessionDefinitions: extras.sessionDefinitions }),
    ...(capUsd === null ? {} : { maxBudgetUsd: capUsd }),
    keepAliveForSubordinates: true,
  })
}
```

In `apps/orchestrator/src/resume.ts`, import `refreshLeadSpawn` from `'./lead/turn.js'` and add, directly above `const handle = await adapter.resume(`:

```ts
  // Lead flow (plan A L6): a paused lead turn continues under what is left of its budget leg.
  // `leadTurn` is null on every other run.
  if (run.leadTurn !== null) await refreshLeadSpawn(run.id, runDir)
```

- [ ] **Step 5: The pump's ask hook.** In `apps/orchestrator/src/pump.ts`, change the condition of the block that begins

```ts
  if (!failed) {
    // M36 t3: any questions this run answered, written BEFORE the ask hook below -- a slave that
```

to

```ts
  // Lead flow (spec R-6, plan A L10): a lead is never parked on a question and answers nobody's --
  // its conclusion (`concludeLeadTurn`) reads the block and tells it to decide. `leadTurn` is null
  // on every other run, which takes the hook exactly as before.
  if (!failed && startingRow.leadTurn === null) {
```

- [ ] **Step 6: The conclusion.** In `apps/orchestrator/src/lead/conclude.ts`, add the imports `recordLeadDecisions` (control); `LEAD_ASK_REPLIES_MAX, LEAD_DECISIONS_FILE, LEAD_DECISIONS_FILE_MAX_BYTES, LEAD_DENIAL_CONTINUES_MAX, isBudgetCapReason, parseLeadDecisions, parseSlaveAsk, readLeadProgress` (domain); `joinRunOutput` from `'../runOutput.js'`; `endLead, noteLead, noteLeadOnce` from `'./record.js'`; and replace `concludeLeadTurn` with:

```ts
const firstLine = (text: string): string => (text.split('\n')[0] ?? '').slice(0, 300)

/** The newest `run.failed` reason a run recorded, or the empty string. */
async function failureReasonOf(runId: string): Promise<string> {
  const event = await prisma.executionEvent.findFirst({ where: { runId, type: 'run_failed' }, orderBy: { seq: 'desc' }, select: { payload: true } })
  const reason = (event?.payload as { readonly reason?: unknown } | undefined)?.reason
  return typeof reason === 'string' ? reason : ''
}

/**
 * C6: the calls the permission mode refused, as `Tool (id)`, when they are the whole of why the pump
 * failed the turn -- every id its `run.failed` reason names (`… tool call(s) were denied: a, b`) was
 * recorded as a `permission_mode` trip of this run. Empty when the reason names no denial, or names
 * one the mode did not refuse (a hook's deny is not this).
 */
async function permissionDenialsOf(runId: string, reason: string): Promise<readonly string[]> {
  const named = (/tool call\(s\) were denied: (.+)$/u.exec(reason)?.[1] ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '')
  if (named.length === 0) return []
  const trips = await prisma.executionEvent.findMany({
    where: { runId, type: 'guardrail_tripped', payload: { path: ['guardrail'], equals: 'permission_mode' } },
    select: { payload: true },
  })
  const toolOf = new Map<string, string>()
  for (const trip of trips) {
    const detail = (trip.payload as { readonly detail?: unknown }).detail
    const match = typeof detail === 'string' ? /^(\S+) was denied by the permission mode \((.+)\)$/u.exec(detail) : null
    if (match?.[1] !== undefined && match[2] !== undefined) toolOf.set(match[2], match[1])
  }
  return named.every((id) => toolOf.has(id)) ? named.map((id) => `${toolOf.get(id) ?? ''} (${id})`) : []
}

/** Everything a run said, as the log holds it. */
async function finalTextOf(runId: string): Promise<string> {
  const rows = await prisma.executionEvent.findMany({ where: { runId, type: 'run_output' }, orderBy: { seq: 'asc' }, select: { payload: true } })
  return joinRunOutput(rows.map((row) => row.payload))
}

/**
 * Lead-flow spec B1/B6/B8 (plan A L4/L5/L10): what a concluded lead turn means for its task. Never
 * `advance`: no workspace verify command, no ownership audit, no report block, no review.
 *
 * A succeeded turn that ended with a question is answered at once (twice at most per version);
 * otherwise its work is integrated and the goal pass proves it. A failed turn is read by WHY it
 * failed -- the table in plan A Task 7 -- and the next turn continues the same session unless the
 * transcript is gone. Replay-safe: only the run holding the task's claim concludes anything.
 */
export async function concludeLeadTurn(runId: RunId): Promise<void> {
  const run = await prisma.slaveRun.findUnique({ where: { id: runId }, include: runInclude })
  if (run === null || run.task === null || run.leadTurn === null) return
  const task = run.task
  if (task.activeRunId !== run.id) return
  if (run.status !== 'succeeded' && run.status !== 'failed') return
  const target = await integrationTargetFor(task.id)
  if (target === null) return
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: target.deliveryId } })
  const progress = readLeadProgress(delivery.leadProgress)
  const at = { workspaceId: task.workspaceId, version: delivery.goalVersion, runId: run.id }

  if (run.status === 'failed') {
    const reason = await failureReasonOf(run.id)
    // The goal's own limit ended the lead and cancelled this turn: what is committed is judged.
    if (progress.leadEnded !== null) {
      await settleLeadWork(run, task)
      return
    }
    if (isBudgetCapReason(reason)) {
      if (progress.wrapUpSent) {
        await endLead(delivery.id, 'budget_spent', "the lead's share of the budget is spent")
        await settleLeadWork(run, task)
        return
      }
      // Spec B4: the four-fifths leg ended on its cap. Not a failure; the next turn is the wrap-up.
      await updateLeadProgress(delivery.id, (p) => ({ ...p, nextTurn: { kind: 'wrap_up', note: p.nextTurn?.note ?? '' } }))
      await releaseTaskAfterFailure(task, run.id, 'rework', { platform: true })
      return
    }
    // Spec B6: a resume that was spawned and never reached its session line has no transcript to
    // continue. Nothing is charged; `planLeadTurn` reads the same fact and starts a new session.
    if (run.leadResumed && run.sessionId === null && run.pid !== null) {
      await releaseTaskAfterFailure(task, run.id, 'rework', { platform: true })
      return
    }
    // C6: the turn failed only because the permission mode refused calls -- the work it did stands.
    // The lead goes on in the same session, told what was refused; no attempt, at most
    // `LEAD_DENIAL_CONTINUES_MAX` times per version. Past that it is charged below like any failure.
    const refused = await permissionDenialsOf(run.id, reason)
    if (refused.length > 0 && progress.denialContinues < LEAD_DENIAL_CONTINUES_MAX) {
      const named = refused.join(', ')
      await updateLeadProgress(delivery.id, (p) => ({
        ...p,
        denialContinues: p.denialContinues + 1,
        nextTurn: { kind: 'continue', note: `The permission mode refused these calls in your last turn: ${named}. They will be refused again: do that work another way, and carry on with the goal.` },
      }))
      await releaseTaskAfterFailure(task, run.id, 'rework', { platform: true })
      await noteLead({ ...at, kind: 'denied', detail: `the permission mode refused ${String(refused.length)} call(s) (${named}); the lead continues in the same session, told what was refused` })
      return
    }
    const release = await releaseTaskAfterFailure(task, run.id, 'rework', { platform: run.failureClass === 'platform' })
    if (run.providerError) {
      // Spec B7: a line for the report, not a card. The scheduler holds the task for the backoff.
      await noteLead({ ...at, kind: 'limit_wait', detail: `the provider refused the turn (${firstLine(reason)}); the goal waits and continues in the same session` })
    }
    if (release.exhausted) {
      await appendEvent({ type: 'task.failed', workspaceId: task.workspaceId, taskId: task.id, actor: 'system', payload: { reason: `the lead's turn failed after ${String(release.attempt)} attempt(s): ${firstLine(reason)}` } })
      await stopLead(delivery.id, 'lead_failed', firstLine(reason))
    }
    return
  }

  // Spec R-6 (plan A L10): the lead asked a question although none is offered. Answered at once.
  if (progress.askReplies < LEAD_ASK_REPLIES_MAX && parseSlaveAsk(await finalTextOf(run.id)).kind !== 'absent') {
    const released = await prisma.task.updateMany({ where: { id: task.id, activeRunId: run.id }, data: { status: 'rework', activeRunId: null } })
    if (released.count === 0) return
    await updateLeadProgress(delivery.id, (p) => ({ ...p, askReplies: p.askReplies + 1, nextTurn: { kind: 'answer', note: '' } }))
    await noteLead({ ...at, kind: 'ask_refused', detail: 'the lead asked a question; nobody answers in this flow, so it was told to decide it and record the decision' })
    return
  }
  await settleLeadWork(run, task)
}
```

In `settleLeadWork`, between the fast-forward and the `done` write, add:

```ts
  await readDecisions(repoPath, tip, { workspaceId: task.workspaceId, version: delivery.goalVersion, runId: run.id })
  // Spec section 9: proof starts whether or not the lead reported.
  if (run.status !== 'succeeded') {
    await noteLead({ workspaceId: task.workspaceId, version: delivery.goalVersion, runId: run.id, kind: 'report_missing', detail: 'the lead was stopped before it could write its closing report' })
  } else if ((await finalTextOf(run.id)).trim() === '') {
    await noteLead({ workspaceId: task.workspaceId, version: delivery.goalVersion, runId: run.id, kind: 'report_missing', detail: 'the lead ended without a closing report' })
  }
```

and add below it:

```ts
/**
 * Lead-flow spec B9 (plan A L18): the lead's decisions file at the commit just integrated, read
 * into decision records. Bounded before it is read (`cat-file -s`); a file that is missing, too
 * large or unreadable is one line for the report, said once, and stops nothing.
 */
async function readDecisions(repoPath: string, tip: string, at: { readonly workspaceId: string; readonly version: number; readonly runId: string }): Promise<void> {
  const object = `${tip}:${LEAD_DECISIONS_FILE}`
  let markdown: string
  try {
    const size = Number(await gitIn(repoPath, 'cat-file', '-s', object))
    if (!Number.isFinite(size) || size > LEAD_DECISIONS_FILE_MAX_BYTES) throw new Error(`it is ${String(size)} bytes`)
    markdown = await gitIn(repoPath, 'show', object)
  } catch {
    await noteLeadOnce({ ...at, kind: 'decisions_missing', detail: `${LEAD_DECISIONS_FILE} is missing or could not be read: the lead recorded no decision there` })
    return
  }
  const outcome = await recordLeadDecisions(at.workspaceId, at.version, parseLeadDecisions(markdown))
  if (outcome.written > 0) await noteLead({ ...at, kind: 'decisions_read', detail: `${String(outcome.written)} decision(s) recorded from ${LEAD_DECISIONS_FILE}` })
  if (outcome.refused > 0) await noteLeadOnce({ ...at, kind: 'decisions_read', detail: `${String(outcome.refused)} decision(s) of ${LEAD_DECISIONS_FILE} were not recorded: the version already holds as many as it may` })
}
```

(`settleLeadWork` is also called for a FAILED turn now -- one the goal's limit or the budget cap ended. Its `done` write is guarded on the claim, which such a turn still holds.)

- [ ] **Step 7: Run.** `npx tsc --build && npx vitest run packages/domain/test/lead/decisions.test.ts packages/domain/test/lead/state.test.ts packages/domain/test/lead/events.test.ts`, then `npx vitest run apps/orchestrator/test/integration/lead-turn.test.ts` → PASS, then `npx vitest run apps/orchestrator/test/integration/lead-open.test.ts` → PASS (the missing-file note is new there and asserted nowhere). Unchanged neighbours, one file at a time: `…/pump.test.ts`, `…/ask.test.ts`, `…/resume-execution.test.ts`, `…/sweep.test.ts` → PASS. `npm run typecheck`.

- [ ] **Step 8: Commit**

```bash
git add packages/domain/src/lead packages/domain/test/lead/decisions.test.ts packages/domain/test/lead/state.test.ts packages/control/src/lead/decisions.ts packages/control/src/conductorAnswer.ts packages/control/src/index.ts apps/orchestrator/src/lead apps/orchestrator/src/pump.ts apps/orchestrator/src/resume.ts apps/orchestrator/test/integration/lead-turn.test.ts
git commit -m "feat(lead): the lead's session is continued after a restart, a failure, a refusal and a pause; a question is answered at once; its decisions are recorded

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: Limits belong to the goal; the state word; what the CLI shows (B4, B5, B10, L6, L7, L8, L14)

**Files:**
- Modify: `apps/orchestrator/src/sweep.ts` (`sweep`, the block at `:709-765` and the stall breach text at `:785-787`)
- Create: `apps/orchestrator/src/lead/pass.ts`
- Modify: `apps/orchestrator/src/lead/conclude.ts` (`settleLeadWork` takes `{ idle }`)
- Modify: `apps/orchestrator/src/goal.ts` (`runGoalPass`'s workspace `select` at `:30` and its last line; `advanceDelivery`'s parameter type and first statement)
- Create: `packages/control/src/lead/status.ts`; modify `packages/control/src/index.ts`
- Modify: `apps/orchestrator/src/cli.ts` (usage text and one case after `set-lead`)
- Test: `apps/orchestrator/test/integration/sweep.test.ts` (three cases after "cancels a run past the tool-call ceiling"), `apps/orchestrator/test/integration/lead-limits.test.ts` (new)

**Interfaces:**
- Consumes: `endLead`, `noteLead`, `stopLead`, `settleLeadWork`, `LeadRunRow` (Tasks 6/7); `goalWorkedMs`, `goalSpend`, `everyPackageIntegrated`, `loadLeadRoster`, `isAlive`, `signalRun` (control); `leadStateOf`, `LEAD_STALL_MS`, `STOP_REASONS`, `SUBORDINATE_TOOLS`, `buildRosterDefinitions` (domain); `resolveAdapter` (`apps/orchestrator/src/provider.ts`).
- Produces (`lead/pass.ts`): `syncLeadStates(workspaceId: string): Promise<void>`; `enforceLeadLimits(deps: TickDeps, deliveryId: string): Promise<void>`.
- Produces (`lead/conclude.ts`): `settleLeadWork(run: LeadRunRow, task: LeadTaskRow, options?: { readonly idle?: boolean }): Promise<'settled' | 'nothing_built' | 'unreadable'>` -- `idle`: the task holds no claim (it is `ready` or `rework`), and it is settled from its newest turn's worktree.
- Produces (control): `interface LeadStatusView` (Step 6); `leadStatus(workspaceId: string, goalVersion?: number): Promise<Result<LeadStatusView, ControlRefusal>>`.
- Produces (CLI): `lead-status --workspace <id> [--version <n>]` (JSON).
- Unchanged for `packages`: the sweep's three comparisons read exactly as before when `run.leadTurn === null`; the goal pass calls `enforceLeadLimits` only for `workspace.flow === 'lead'`, and `syncLeadStates` returns at once for any other flow.

- [ ] **Step 1: Failing sweep tests.** In `apps/orchestrator/test/integration/sweep.test.ts`, after "cancels a run past the tool-call ceiling" (it uses the file's own `givenRun`, `hoursAgo`, `secondsAgo`, `cancelled`, `deps`):

```ts
  it('applies neither the run timeout, nor the tool-call ceiling, nor the breaker to a lead turn (lead flow B4)', async (): Promise<void> => {
    const run = await givenRun({ status: 'working', pid: process.pid, toolCalls: 500, startedAt: hoursAgo(2) })
    await prisma.slaveRun.update({ where: { id: run.id }, data: { leadTurn: 'build', lastOutputAt: new Date() } })
    noteSweepAt(deps.workspaceId, secondsAgo(1).getTime())

    const report = await sweep(deps)

    expect([report.timedOut, report.overToolCap, report.stalled]).toEqual([[], [], []])
    expect(cancelled).toEqual([])
    const after = await prisma.slaveRun.findUniqueOrThrow({ where: { id: run.id } })
    expect([after.status, after.breakerBeatAt]).toEqual(['working', null])
  })

  it('restarts a lead turn whose stream said nothing for 30 minutes, tool call open or not (lead flow B5)', async (): Promise<void> => {
    const run = await givenRun({ status: 'working', pid: process.pid, startedAt: hoursAgo(2) })
    await prisma.slaveRun.update({
      where: { id: run.id },
      data: { leadTurn: 'build', lastOutputAt: new Date(Date.now() - 31 * 60_000), toolCallOpenSince: new Date(Date.now() - 40 * 60_000) },
    })
    noteSweepAt(deps.workspaceId, secondsAgo(1).getTime())

    const report = await sweep(deps)

    expect(report.stalled).toEqual([run.id])
    expect(cancelled).toEqual([run.id])
    const tripped = await prisma.executionEvent.findFirstOrThrow({ where: { runId: run.id, type: 'guardrail_tripped' } })
    expect(tripped.payload).toMatchObject({ guardrail: 'run_stalled' })
    expect((tripped.payload as { detail: string }).detail).toMatch(/silent for 31 min \(a lead turn/)
  })

  it('leaves a lead turn silent for 29 minutes alone, where any other run with no tool call open is stalled at 15', async (): Promise<void> => {
    const lead = await givenRun({ status: 'working', pid: process.pid })
    await prisma.slaveRun.update({ where: { id: lead.id }, data: { leadTurn: 'rework', lastOutputAt: new Date(Date.now() - 29 * 60_000) } })
    noteSweepAt(deps.workspaceId, secondsAgo(1).getTime())
    expect((await sweep(deps)).stalled).toEqual([])

    await prisma.slaveRun.update({ where: { id: lead.id }, data: { leadTurn: null } })
    expect((await sweep(deps)).stalled).toEqual([lead.id])
  })
```

Run `npx vitest run apps/orchestrator/test/integration/sweep.test.ts -t "lead"` → FAIL (the first case reports the run in `timedOut`).

- [ ] **Step 2: The sweep.** In `apps/orchestrator/src/sweep.ts` add `LEAD_STALL_MS` to the domain import. Replace

```ts
    const timedOutNow = workingMs > workspace.runTimeoutMs
```

with

```ts
    // Lead flow (spec B4/B5, plan A L7/L8): the per-run limits do not apply to a turn of a lead's
    // session. The goal's budget and time bound it (`enforceLeadLimits`, the vendor's budget cap),
    // and its stall rule is its own: a lead with a subordinate at work always has a tool call open.
    // `leadTurn` is null on every other run, which is judged exactly as before.
    const leadTurn = run.leadTurn !== null
    const timedOutNow = !leadTurn && workingMs > workspace.runTimeoutMs
```

Change `const overCapNow = run.toolCalls > (run.toolCallCap ?? workspace.maxToolCallsPerRun)` to `const overCapNow = !leadTurn && run.toolCalls > (run.toolCallCap ?? workspace.maxToolCallsPerRun)`. In `stalledNow`, replace its last two conjuncts

```ts
      run.toolCallOpenSince === null &&
      now - silentFrom > RUN_STALL_MS
```

with

```ts
      (leadTurn ? now - silentFrom > LEAD_STALL_MS : run.toolCallOpenSince === null && now - silentFrom > RUN_STALL_MS)
```

Inside `if (!timedOutNow && !overCapNow && !stalledNow) {`, as its first statement:

```ts
      // No behavioural breaker on a lead turn: its constrain rung is a per-run tool-call cap, and
      // subordinates repeating a call is not a loop.
      if (leadTurn) continue
```

And change the stall breach line to

```ts
      breaches.push(
        leadTurn
          ? `silent for ${Math.round((now - silentFrom) / 60_000)} min (a lead turn: it is restarted in its own session with a continuation note)`
          : `silent for ${Math.round((now - silentFrom) / 60_000)} min with no tool call open`,
      )
```

Run the three cases → PASS, then the whole file → PASS.

- [ ] **Step 3: Failing integration test.** Create `apps/orchestrator/test/integration/lead-limits.test.ts`:

```ts
import { spawn } from 'node:child_process'
import { leadStatus } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { readLeadProgress } from '@slave-of-ai/domain'
import type { SlaveRuntimeAdapter } from '@slave-of-ai/providers'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGoalPass } from '../../src/goal.js'
import { resetTickObservation } from '../../src/sweep.js'
import { drainPumps, tick } from '../../src/tick.js'
import { LEAD_TRUNCATE, base64, cleanUpLeadRepos, git, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil, type LeadFixture } from './lead-helpers.js'

const leadTurns = (f: LeadFixture) => f.starts.filter((s) => s.kind === 'implementation')
/**
 * A turn the vendor stopped at its budget cap (measured: `terminal_reason: "budget_exhausted"`, C3).
 * `usd` is the SESSION's running total at its end, as a resumed process reports it (C2).
 */
const capped = (usd: number): readonly string[] => ['--result-patch-base64', base64({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'budget_exhausted', total_cost_usd: usd })]
/** A turn that ended normally with the session's running total at `usd`. */
const cost = (usd: number): readonly string[] => ['--result-patch-base64', base64({ total_cost_usd: usd })]
const children: number[] = []

describe('the lead flow: limits belong to the goal', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(LEAD_TRUNCATE)
    resetTickObservation()
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    for (const pid of children) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    cleanUpLeadRepos()
    await prisma.$disconnect()
  })

  it('tells the lead to wrap up at four fifths of its share, in the same session, and charges no attempt', async (): Promise<void> => {
    // The wrap-up turn resumes the session and reports its running total: 19.20 + 1.00.
    const f = await seedLead({ budgetUsd: 30, leadArgs: (ordinal) => (ordinal === 1 ? capped(19.2) : cost(20.2)) })
    await tickUntil(f, merged(f))

    const turns = leadTurns(f)
    expect(turns.map((t) => [t.leadTurn, t.extras.maxBudgetUsd])).toEqual([['build', 19.2], ['wrap_up', 4.8]])
    expect(turns[1]?.resumeSessionId).toBe('fake-session-complete')
    expect(turns[1]?.prompt).toContain('Wrap up now')
    expect((await leadTaskOf(f)).attempt).toBe(0)
    expect(readLeadProgress((await leadDelivery(f)).leadProgress)).toMatchObject({ wrapUpSent: true, leadEnded: null })
    expect((await leadNotes(f)).some((line) => line.startsWith('wrap_up:'))).toBe(true)
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, situationKind: { not: 'conduct' } } })).toBe(0)
  })

  it('ends the lead at 100% of its share and proves what is committed, with a subordinate still at work', async (): Promise<void> => {
    const f = await seedLead({
      budgetUsd: 30,
      // The second leg spends its 4.80; the session's running total is then the whole share, 24.00.
      leadArgs: (ordinal) => (ordinal === 1 ? capped(19.2) : [...capped(24), '--subordinate', 'general-purpose', '--subordinate-unfinished']),
    })
    await tickUntil(f, merged(f))

    expect(leadTurns(f).map((t) => t.leadTurn)).toEqual(['build', 'wrap_up'])
    expect((await leadTaskOf(f)).attempt).toBe(0)
    expect(readLeadProgress((await leadDelivery(f)).leadProgress).leadEnded).toBe('budget_spent')
    // What both turns committed is on main: proof ran on it and passed.
    const files = git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')
    expect(files).toEqual(expect.arrayContaining(['lead-work-1.txt', 'lead-work-2.txt']))
    expect(await leadNotes(f)).toEqual(expect.arrayContaining([expect.stringMatching(/^lead_ended: the lead's share of the budget is spent/), 'report_missing: the lead was stopped before it could write its closing report']))
    // The subordinate's unfinished call tripped nothing.
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' } })).toBe(0)
    // More ticks start no further lead turn.
    await tick(f.deps)
    await drainPumps()
    expect(leadTurns(f)).toHaveLength(2)
  })

  it('ends the lead when the goal\'s time is spent and proves what is committed', async (): Promise<void> => {
    const failed = ['--result-patch-base64', base64({ is_error: true, subtype: 'error_during_execution', terminal_reason: 'error_during_execution' })]
    const f = await seedLead({ timeLimitMs: 10 * 60_000, leadArgs: () => failed })
    await tickUntil(f, async () => (await prisma.slaveRun.count({ where: { leadTurn: { not: null }, status: 'failed' } })) === 1)
    // That turn took eleven minutes of the goal's ten.
    const turn = await prisma.slaveRun.findFirstOrThrow({ where: { leadTurn: { not: null } } })
    await prisma.slaveRun.update({ where: { id: turn.id }, data: { startedAt: new Date((turn.endedAt ?? new Date()).getTime() - 11 * 60_000) } })

    await tickUntil(f, merged(f))
    expect(leadTurns(f)).toHaveLength(1)
    expect(readLeadProgress((await leadDelivery(f)).leadProgress).leadEnded).toBe('time_spent')
    expect((await leadNotes(f)).some((line) => line.startsWith('lead_ended: the goal\'s time limit of 10 minutes is reached'))).toBe(true)
    expect(git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')).toContain('lead-work-1.txt')
  })

  it('cancels a live turn when the time runs out', async (): Promise<void> => {
    const f = await seedLead({ timeLimitMs: 10 * 60_000 })
    await tick(f.deps)
    await tick(f.deps)
    await drainPumps()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' })
    children.push(child.pid ?? 0)
    const task = await leadTaskOf(f)
    const lead = await prisma.slave.findFirstOrThrow({ where: { team: { workspaceId: f.workspaceId }, role: 'Lead' } })
    const live = await prisma.slaveRun.create({
      data: { taskId: task.id, slaveId: lead.id, kind: 'implementation', status: 'working', leadTurn: 'build', pid: child.pid ?? 0, provider: 'claude_code', startedAt: new Date(Date.now() - 11 * 60_000) },
    })
    await prisma.task.update({ where: { id: task.id }, data: { status: 'running', activeRunId: live.id } })
    const cancelled: string[] = []
    const stub = { cancel: async (runId: string): Promise<void> => void cancelled.push(runId) } as unknown as SlaveRuntimeAdapter

    await runGoalPass({ ...f.deps, registry: { resolve: () => stub } }, { mayStartRuns: false })

    expect(cancelled).toEqual([live.id])
    expect((await prisma.slaveRun.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('stopping')
    expect(readLeadProgress((await leadDelivery(f)).leadProgress).leadEnded).toBe('time_spent')
  })

  it('keeps the state word in step with the version and says each change once', async (): Promise<void> => {
    const f = await seedLead()
    await tickUntil(f, merged(f))
    await tick(f.deps)
    await drainPumps()
    const states = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_lead_state' }, orderBy: { seq: 'asc' }, select: { payload: true } })
    expect(states.map((row) => (row.payload as { state: string }).state)).toEqual(['building', 'proving', 'delivered'])
    expect(await leadDelivery(f)).toMatchObject({ leadState: 'delivered', stopReason: 'proven' })
  })

  it('shows the state, the spend, the turns and the subordinates by person from the CLI\'s read', async (): Promise<void> => {
    const ada = await prisma.person.create({ data: { name: 'Ada Backend', profile: 'You build APIs.' } })
    const f = await seedLead({ budgetUsd: 30, roster: [ada.id], leadArgs: () => [...cost(2), '--subordinate', 'ada-backend'] })
    await tickUntil(f, merged(f))
    await tick(f.deps)
    await drainPumps()

    const view = await leadStatus(f.workspaceId)
    if (!view.ok) throw new Error('lead-status was refused')
    expect(view.value).toMatchObject({ goalVersion: 1, state: 'delivered', stopReason: 'proven', budgetUsd: 30 })
    expect(view.value.spend.leadUsd).toBe(2)
    expect(view.value.turns.map((t) => [t.turn, t.status, t.resumed, t.costUsd])).toEqual([['build', 'succeeded', false, 2]])
    expect(view.value.subordinates).toEqual([{ name: 'ada-backend', personId: ada.id, calls: 1, running: 0 }])
    expect(view.value.lastCommits.length).toBeGreaterThan(0)
    expect(view.value.notes.map((n) => n.kind)).toContain('turn')
  })
})
```

Run `npx vitest run apps/orchestrator/test/integration/lead-limits.test.ts` → FAIL (`leadStatus` and `runGoalPass`'s lead branch do not exist; an ended lead is never settled).

- [ ] **Step 4: Settling an idle task.** In `apps/orchestrator/src/lead/conclude.ts` change `settleLeadWork`'s signature to

```ts
export async function settleLeadWork(run: LeadRunRow, task: LeadTaskRow, options: { readonly idle?: boolean } = {}): Promise<'settled' | 'nothing_built' | 'unreadable'> {
```

add, as its first statement,

```ts
  // `idle` (plan A L6/L7): the lead was ended while its task held no claim. The task is settled from
  // its newest turn's worktree, and the guard is the task's own status instead of a run's claim.
  const claim = options.idle === true ? { id: task.id, activeRunId: null, status: { in: ['ready' as const, 'rework' as const] } } : { id: task.id, activeRunId: run.id }
```

and use it in the two task writes: the `nothing_built` branch's `where: { id: task.id, activeRunId: run.id }` becomes `where: claim`, and the `done` write's `where` becomes `where: claim`.

- [ ] **Step 5: The pass.** Create `apps/orchestrator/src/lead/pass.ts`:

```ts
import { everyPackageIntegrated, goalWorkedMs, isAlive, signalRun } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { STOP_REASONS, leadStateOf, readLeadProgress, runId as brandRunId, type StopReason } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { resolveAdapter } from '../provider.js'
import type { TickDeps } from '../tick.js'
import { settleLeadWork } from './conclude.js'
import { endLead } from './record.js'
import { stopLead } from './stop.js'

const asStopReason = (value: string | null): StopReason | null => ((STOP_REASONS as readonly string[]).includes(value ?? '') ? (value as StopReason) : null)

/**
 * Lead-flow spec section 3 (plan A L14): the state word of every lead-flow version of a project,
 * derived from its row (`leadStateOf`) and stored when it changed, with one `workspace.lead_state`
 * per change. Also where a stop reason is completed: a version that merged with none is `proven`, a
 * stop with none (the existing cap on unusable verification runs) is `proof_unusable`, an abandoned
 * one is `left`; a version sent round again loses its old reason. Nothing for a project that is not
 * in the lead flow: its finished lead versions were final when it left.
 */
export async function syncLeadStates(workspaceId: string): Promise<void> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { flow: true, autoMerge: true } })
  if (workspace?.flow !== 'lead') return
  const deliveries = await prisma.goalDelivery.findMany({
    where: {
      workspaceId,
      OR: [{ leadState: { notIn: ['delivered', 'stopped'] } }, { leadState: null, mergedAt: null, status: { not: 'abandoned' } }],
    },
    select: { id: true, goalVersion: true, status: true, mergedAt: true, mergeError: true, leadState: true, stopReason: true },
  })
  for (const delivery of deliveries) {
    const state = leadStateOf({
      status: delivery.status,
      merged: delivery.mergedAt !== null,
      integrated: await everyPackageIntegrated(workspaceId, delivery.goalVersion),
      autoMerge: workspace.autoMerge,
      mergeFailed: delivery.mergeError !== null,
    })
    const reason =
      state === 'building' || state === 'proving'
        ? delivery.status === 'accepted'
          ? delivery.stopReason
          : null
        : state === 'delivered'
          ? (delivery.stopReason ?? 'proven')
          : state === 'stopped'
            ? (delivery.stopReason ?? 'left')
            : delivery.status === 'needs_human'
              ? (delivery.stopReason ?? 'proof_unusable')
              : delivery.stopReason
    if (state === delivery.leadState && reason === delivery.stopReason) continue
    const moved = await prisma.goalDelivery.updateMany({ where: { id: delivery.id, leadState: delivery.leadState }, data: { leadState: state, stopReason: reason } })
    if (moved.count > 0 && state !== delivery.leadState) {
      await appendEvent({ type: 'workspace.lead_state', workspaceId, actor: 'system', payload: { version: delivery.goalVersion, state, reason: asStopReason(reason) } })
    }
  }
}

/** The run statuses a live process can be in (the sweep's own set, less `stopping`). */
const LIVE = ['starting', 'working', 'pause_requested', 'resuming'] as const

/**
 * Lead-flow spec B4 (plan A L6/L7): the goal's own limits, checked on every goal pass for a version
 * still `integrating` or `verifying`.
 *
 * - The lead's task ran out of attempts where no conclusion saw it (a spawn that never worked): the
 *   version stops `lead_failed`.
 * - The goal's working time is past its limit: the lead is ended (`time_spent`).
 * - An ended lead (time here, the budget share in `planLeadTurn` / `concludeLeadTurn`) gets no
 *   further turn: a live turn is cancelled, the sweep's way -- claimed `stopping`, then the
 *   adapter's cancel, the pid if that fails -- and its conclusion settles what is committed; a task
 *   holding no claim is settled here, from its newest turn's worktree; a lead that never ran built
 *   nothing, and the version stops with the reason it was ended for.
 *
 * A paused turn (a person's stop) is left alone: its claim stands until the person continues it.
 */
export async function enforceLeadLimits(deps: TickDeps, deliveryId: string): Promise<void> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { workspace: { select: { goalTimeLimitMs: true } } } })
  if (delivery.status !== 'integrating' && delivery.status !== 'verifying') return
  const task = await prisma.task.findFirst({ where: { workspaceId: delivery.workspaceId, workPackage: { goalVersion: delivery.goalVersion } } })
  if (task === null) return
  if (task.status === 'failed') {
    await stopLead(delivery.id, 'lead_failed', task.lastRejectionReason)
    return
  }

  let ended = readLeadProgress(delivery.leadProgress).leadEnded
  const limit = delivery.workspace.goalTimeLimitMs
  if (ended === null && limit !== null && (await goalWorkedMs(delivery.workspaceId, delivery.goalVersion)) >= limit) {
    await endLead(delivery.id, 'time_spent', `the goal's time limit of ${String(Math.round(limit / 60_000))} minutes is reached`)
    ended = 'time_spent'
  }
  if (ended === null) return

  if (task.activeRunId !== null) {
    const live = await prisma.slaveRun.findUnique({ where: { id: task.activeRunId }, select: { id: true, leadTurn: true, pid: true, provider: true } })
    if (live === null || live.leadTurn === null) return
    const claimed = await prisma.slaveRun.updateMany({ where: { id: live.id, status: { in: [...LIVE] } }, data: { status: 'stopping' } })
    if (claimed.count === 0) return
    try {
      await resolveAdapter(deps.registry, live.provider ?? 'claude_code').cancel(brandRunId(live.id))
    } catch {
      // Another process spawned it: the pid on the row is what is left to stop it by.
      if (live.pid !== null && live.pid !== process.pid && isAlive(live.pid)) signalRun(live.pid, 'SIGKILL')
    }
    return
  }
  if (task.status !== 'ready' && task.status !== 'rework') return

  const last = await prisma.slaveRun.findFirst({
    where: { taskId: task.id, leadTurn: { not: null }, worktreePath: { not: null } },
    orderBy: { startedAt: 'desc' },
    include: { task: { include: { workspace: true } }, slave: { select: { id: true, person: { select: { name: true } } } } },
  })
  if (last === null || last.task === null) {
    await stopLead(delivery.id, ended, 'the lead never started a turn')
    return
  }
  await settleLeadWork(last, last.task, { idle: true })
}
```

In `apps/orchestrator/src/goal.ts` import `enforceLeadLimits, syncLeadStates` from `'./lead/pass.js'`. In `runGoalPass`, add `flow: true` to the workspace `select`, and as the function's last statement:

```ts
  // Lead flow (plan A L14): the state word follows whatever this pass moved. Wrapped: a failure here
  // must not fail the pass.
  await syncLeadStates(workspaceId).catch((error: unknown) => {
    console.error(`[goal] the lead state of workspace ${workspaceId} could not be synced:`, error)
  })
```

In `advanceDelivery`, widen the `workspace` parameter's type with `readonly flow: 'packages' | 'lead'`, and add as the first statement after `const workspaceId = deps.workspaceId`:

```ts
  // Lead flow (spec B4, plan A L6/L7): the goal's own limits come first -- an ended lead is settled
  // or cancelled before anything below reads the version. Logged, not thrown, like the two steps below.
  if (workspace.flow === 'lead') {
    try {
      await enforceLeadLimits(deps, id)
    } catch (error) {
      console.error(`[goal] goal delivery ${id}: enforceLeadLimits failed on this pass --`, error)
    }
  }
```

- [ ] **Step 6: The CLI's read.** Create `packages/control/src/lead/status.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { SUBORDINATE_TOOLS, buildRosterDefinitions, err, ok, readLeadProgress, type LeadProgress, type LeadState, type Result } from '@slave-of-ai/domain'
import { gitIn } from '../git.js'
import type { ControlRefusal } from '../refusal.js'
import { loadLeadRoster } from './roster.js'
import { goalSpend, goalWorkedMs, type GoalSpend } from './spend.js'

/** Lead-flow spec B10: what a lead-flow goal version is doing, as the CLI prints it. */
export interface LeadStatusView {
  readonly goalVersion: number
  readonly state: LeadState | null
  readonly stopReason: string | null
  readonly status: string
  readonly round: number
  readonly workBranch: string
  /** The work branch's newest commits, `<sha> <subject>`; empty when the branch cannot be read. */
  readonly lastCommits: readonly string[]
  readonly progress: LeadProgress
  readonly budgetUsd: number | null
  readonly spend: GoalSpend
  readonly timeLimitMs: number | null
  readonly workedMs: number
  readonly turns: readonly { readonly runId: string; readonly turn: string; readonly status: string; readonly resumed: boolean; readonly costUsd: number | null; readonly startedAt: string; readonly endedAt: string | null }[]
  /** Subordinate calls of the lead's turns by session definition; `personId` is the roster person behind it, null for a general one. */
  readonly subordinates: readonly { readonly name: string; readonly personId: string | null; readonly calls: number; readonly running: number }[]
  readonly notes: readonly { readonly at: string; readonly kind: string; readonly detail: string }[]
}

/**
 * Lead-flow spec B10 (plan A): the live state of one lead-flow goal version (the newest when none
 * is named) -- its state word, what it spent and took, its turns, which subordinates worked and
 * which still do (a subordinate call with no result on a live turn), the last commits and the
 * report lines. A read: nothing here writes.
 */
export async function leadStatus(workspaceId: string, goalVersion?: number): Promise<Result<LeadStatusView, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { repoPath: true, budgetUsd: true, goalTimeLimitMs: true, leadRoster: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  const delivery = await prisma.goalDelivery.findFirst({
    where: { workspaceId, leadState: { not: null }, ...(goalVersion === undefined ? {} : { goalVersion }) },
    orderBy: { goalVersion: 'desc' },
  })
  if (delivery === null) return goalVersion === undefined ? err({ kind: 'not_lead_flow', workspaceId }) : err({ kind: 'goal_version_not_found', workspaceId, goalVersion })

  const turns = await prisma.slaveRun.findMany({
    where: { leadTurn: { not: null }, task: { workspaceId, workPackage: { goalVersion: delivery.goalVersion } } },
    orderBy: { startedAt: 'asc' },
    select: { id: true, leadTurn: true, status: true, leadResumed: true, costUsd: true, startedAt: true, endedAt: true },
  })
  const liveIds = new Set(turns.filter((turn) => turn.endedAt === null).map((turn) => turn.id))
  const events = await prisma.executionEvent.findMany({
    where: { runId: { in: turns.map((turn) => turn.id) }, type: { in: ['run_tool_call', 'run_tool_result'] } },
    orderBy: { seq: 'asc' },
    select: { type: true, runId: true, payload: true },
  })
  const finished = new Set(events.filter((event) => event.type === 'run_tool_result').map((event) => (event.payload as { readonly toolUseId?: string }).toolUseId))
  const slugs = buildRosterDefinitions(await loadLeadRoster(workspace.leadRoster)).slugs
  const byName = new Map<string, { calls: number; running: number }>()
  for (const event of events) {
    if (event.type !== 'run_tool_call') continue
    const payload = event.payload as { readonly name?: string; readonly subagent?: string; readonly toolUseId?: string; readonly parentToolUseId?: string }
    // C1: top-level calls only -- a subordinate starting a session of its own is its own business.
    if (payload.name === undefined || !SUBORDINATE_TOOLS.includes(payload.name) || payload.parentToolUseId !== undefined) continue
    const name = payload.subagent ?? 'general-purpose'
    const entry = byName.get(name) ?? { calls: 0, running: 0 }
    entry.calls += 1
    if (event.runId !== null && liveIds.has(event.runId) && !finished.has(payload.toolUseId)) entry.running += 1
    byName.set(name, entry)
  }
  const notes = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'workspace_lead_noted', payload: { path: ['version'], equals: delivery.goalVersion } },
    orderBy: { seq: 'desc' },
    take: 30,
    select: { ts: true, payload: true },
  })
  const lastCommits = await gitIn(workspace.repoPath, 'log', '--oneline', '-10', `refs/heads/${delivery.integrationBranch}`).then(
    (out) => out.split('\n').filter((line) => line !== ''),
    () => [],
  )

  return ok({
    goalVersion: delivery.goalVersion,
    state: delivery.leadState,
    stopReason: delivery.stopReason,
    status: delivery.status,
    round: delivery.round,
    workBranch: delivery.integrationBranch,
    lastCommits,
    progress: readLeadProgress(delivery.leadProgress),
    budgetUsd: workspace.budgetUsd,
    spend: await goalSpend(workspaceId, delivery.goalVersion),
    timeLimitMs: workspace.goalTimeLimitMs,
    workedMs: await goalWorkedMs(workspaceId, delivery.goalVersion),
    turns: turns.map((turn) => ({
      runId: turn.id,
      turn: turn.leadTurn ?? '',
      status: turn.status,
      resumed: turn.leadResumed,
      costUsd: turn.costUsd,
      startedAt: turn.startedAt.toISOString(),
      endedAt: turn.endedAt?.toISOString() ?? null,
    })),
    subordinates: [...byName].map(([name, entry]) => ({ name, personId: slugs.get(name) ?? null, calls: entry.calls, running: entry.running })).sort((a, b) => a.name.localeCompare(b.name)),
    notes: notes.reverse().map((row) => ({ at: row.ts.toISOString(), kind: (row.payload as { kind: string }).kind, detail: (row.payload as { detail: string }).detail })),
  })
}
```

Add `export * from './lead/status.js'` to `packages/control/src/index.ts`. In `apps/orchestrator/src/cli.ts` import `leadStatus`, add to the usage text after `set-lead`:

```
  lead-status --workspace <id> [--version <n>]
                                       a lead-flow goal version as JSON: its state word, why it
                                       stopped, spend and time against the limits, the lead's
                                       turns, the subordinates by person, the last commits and the
                                       report lines. The newest lead-flow version when none is named.
```

and after `case 'set-lead'`:

```ts
    case 'lead-status': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const versionText = flagText(flags, 'version')
      const result = await leadStatus(workspaceId, versionText === undefined ? undefined : goalVersionFlag(versionText))
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`)
      return 0
    }
```

- [ ] **Step 7: Run.** `npx tsc --build && npx vitest run apps/orchestrator/test/integration/lead-limits.test.ts` → PASS. Then one file at a time: `…/sweep.test.ts`, `…/lead-open.test.ts`, `…/lead-turn.test.ts`, `…/goal-pass.test.ts`, `…/conductor-e2e.test.ts` → PASS. `npm run typecheck`.

- [ ] **Step 8: Commit**

```bash
git add apps/orchestrator/src/sweep.ts apps/orchestrator/src/goal.ts apps/orchestrator/src/lead apps/orchestrator/src/cli.ts apps/orchestrator/test/integration/sweep.test.ts apps/orchestrator/test/integration/lead-limits.test.ts packages/control/src/lead/status.ts packages/control/src/index.ts
git commit -m "feat(lead): the goal's budget share, time limit and stall rule bound the lead; the state word follows the version; lead-status shows it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: The proof loop: confirmation, disputed, unverifiable, partial and full rounds, the stop rules (P2..P5, P7, B8, L11, L12)

**Files:**
- Create: `packages/domain/src/lead/proof.ts`; modify `packages/domain/src/lead/index.ts`
- Create: `apps/orchestrator/src/lead/proofRun.ts`
- Modify: `apps/orchestrator/src/verification.ts` (`dispatchVerification` at `:355-560`: four insertions; `concludeVerification` at `:783-795`: one branch; `export` on `releaseClaim` at `:624` and `tamperedReason` at `:726`)
- Modify: `apps/orchestrator/src/smoke.ts` (`applySmokeOutcome` at `:299-382`: the `include`, `capped`, one block)
- Test: `packages/domain/test/lead/proof.test.ts` (new), `apps/orchestrator/test/integration/lead-proof.test.ts` (new)

**Interfaces:**
- Consumes: `LeadProgress`, `SMOKE_FAILING_KEY`, `proofCapUsd`, `readLeadProgress` (domain); `goalSpend`, `ensureLeadSeats`, `withDeliveryLock`, `goalEventWith` (control); `stopLead`, `stopLeadInLock`, `progressJson`, `noteLead`, `noteLeadOnce` (Tasks 6/7); `acceptInLock` (`goal.ts`); `parseSlaveVerification`, `runCheckLeansOnSmoke`, `renderVerificationRework`, `requirementItemsSchema`; `removeVerificationWorktree`, `failConcludedRun`, `joinRunOutput`; `writeSpawnExtras`.
- Produces (domain, `lead/proof.ts`):
  - `interface ProofItem { readonly key: string; readonly status: 'pass' | 'fail' | 'unverifiable' }`
  - `type ProofStep = { kind: 'accept'; progress } | { kind: 'confirm'; progress } | { kind: 'verify_again'; progress } | { kind: 'rework'; progress; keys: readonly string[] } | { kind: 'stop'; progress; reason: StopReason }` (every member `readonly`, `progress: LeadProgress`)
  - `afterRound(input: { readonly scope: 'full' | 'partial'; readonly items: readonly ProofItem[]; readonly progress: LeadProgress; readonly runId: string; readonly tipMoved: boolean }): ProofStep`
  - `afterConfirm(input: { readonly items: readonly ProofItem[]; readonly progress: LeadProgress }): ProofStep`
  - `afterCheckFailure(progress: LeadProgress, key: string): ProofStep`
- Produces (orchestrator, `lead/proofRun.ts`): `type LeadProofScope = { readonly kind: 'hold' } | { readonly kind: 'run'; readonly keys: readonly string[]; readonly confirmsRunId: string | null; readonly seatId: string | null; readonly capUsd: number | null }`; `leadProofScope(delivery: { readonly id: string; readonly workspaceId: string; readonly goalVersion: number; readonly leadProgress: unknown }, budgetUsd: number | null): Promise<LeadProofScope>`; `concludeLeadVerification(runId: string): Promise<void>`.
- What already holds and is not touched (P1, P2): a fresh detached checkout per run, the tamper check and its baseline, the verdict per requirement with check, output and reason, the smoke check before the verifier on the exact commit, `VerificationResult` rows, `workspace.verified`. The verifier never sees the lead's closing report: its leads come from `RunReport` rows, and a lead files none.
- Unchanged for `packages`: `dispatchVerification` computes a scope only when `workspace.flow === 'lead'` and every insertion is behind `lead !== null`; `concludeVerification` branches on the same flag after its own replay guard; `applySmokeOutcome`'s `capped` and its new block read `leadFlow`, false for every other workspace.

- [ ] **Step 1: Failing domain test.** Create `packages/domain/test/lead/proof.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { INITIAL_LEAD_PROGRESS, afterCheckFailure, afterConfirm, afterRound, type LeadProgress, type ProofItem } from '../../src/lead/index.js'

const item = (key: string, status: ProofItem['status']): ProofItem => ({ key, status })
const allPass = [item('R1', 'pass'), item('R2', 'pass'), item('RUN', 'pass')]
const round = (items: readonly ProofItem[], progress: LeadProgress = INITIAL_LEAD_PROGRESS, scope: 'full' | 'partial' = 'full', tipMoved = false) =>
  afterRound({ scope, items, progress, runId: 'run-1', tipMoved })

describe('the proof loop\'s step (lead-flow spec P3-P5, P7)', () => {
  it('accepts a full round on the current tip with nothing failing, disputed or unverifiable', () => {
    expect(round(allPass)).toEqual({ kind: 'accept', progress: INITIAL_LEAD_PROGRESS })
  })

  it('sends a failure to the confirmer first, never straight to the lead (P3)', () => {
    const step = round([item('R1', 'fail'), item('R2', 'pass'), item('RUN', 'pass')])
    expect(step.kind).toBe('confirm')
    expect(step.progress.confirm).toEqual({ runId: 'run-1', keys: ['R1'], scope: 'full' })
  })

  it('reworks what both verifiers failed, and the next round checks only that (P3, P5)', () => {
    const waiting = round([item('R1', 'fail'), item('R2', 'fail'), item('RUN', 'pass')]).progress
    const step = afterConfirm({ items: [item('R1', 'fail'), item('R2', 'fail')], progress: waiting })
    expect(step).toMatchObject({ kind: 'rework', keys: ['R1', 'R2'] })
    expect(step.progress).toMatchObject({ confirm: null, failing: ['R1', 'R2'], recheckKeys: ['R1', 'R2'], disputed: [] })
  })

  it('marks what the confirmer does not fail as disputed and does not rework it (P3)', () => {
    const waiting = round([item('R1', 'fail'), item('R2', 'fail'), item('RUN', 'pass')]).progress
    const step = afterConfirm({ items: [item('R1', 'pass'), item('R2', 'fail')], progress: waiting })
    expect(step).toMatchObject({ kind: 'rework', keys: ['R2'] })
    expect(step.progress.disputed).toEqual(['R1'])
    const none = afterConfirm({ items: [item('R1', 'unverifiable'), item('R2', 'pass')], progress: waiting })
    expect(none).toMatchObject({ kind: 'stop', reason: 'not_all_proven' })
    expect(none.progress.disputed).toEqual(['R1', 'R2'])
  })

  it('never confirms or reworks a disputed key again, and clears it when a later round passes it', () => {
    const disputed: LeadProgress = { ...INITIAL_LEAD_PROGRESS, disputed: ['R1'] }
    expect(round([item('R1', 'fail'), item('R2', 'pass'), item('RUN', 'pass')], disputed)).toMatchObject({ kind: 'stop', reason: 'not_all_proven' })
    expect(round(allPass, disputed)).toEqual({ kind: 'accept', progress: INITIAL_LEAD_PROGRESS })
  })

  it('runs the full verification after a partial round that passed, and again when the tip moved under a full one (P5)', () => {
    const afterRework: LeadProgress = { ...INITIAL_LEAD_PROGRESS, failing: ['R1'], recheckKeys: ['R1'] }
    const partial = round([item('R1', 'pass')], afterRework, 'partial')
    expect(partial).toMatchObject({ kind: 'verify_again' })
    expect(partial.progress).toMatchObject({ recheckKeys: [], failing: [] })
    expect(round(allPass, INITIAL_LEAD_PROGRESS, 'full', true).kind).toBe('verify_again')
  })

  it('does not stop on unverifiable while something can still be reworked, and reports it at the end (P4)', () => {
    const first = round([item('R1', 'unverifiable'), item('R2', 'fail'), item('RUN', 'pass')])
    expect(first.kind).toBe('confirm')
    expect(first.progress.unverifiable).toEqual(['R1'])
    const end = round([item('R1', 'unverifiable'), item('R2', 'pass'), item('RUN', 'pass')], { ...INITIAL_LEAD_PROGRESS, unverifiable: ['R1'] })
    expect(end).toMatchObject({ kind: 'stop', reason: 'not_all_proven' })
    expect(end.progress.unverifiable).toEqual(['R1'])
    // A later round that can verify it after all clears it.
    expect(round(allPass, { ...INITIAL_LEAD_PROGRESS, unverifiable: ['R1'] }).kind).toBe('accept')
  })

  it('stops when two rounds in a row confirm the same failing set (P7)', () => {
    const second: LeadProgress = { ...INITIAL_LEAD_PROGRESS, failing: ['R1'], recheckKeys: ['R1'], confirm: { runId: 'run-3', keys: ['R1'], scope: 'partial' } }
    expect(afterConfirm({ items: [item('R1', 'fail')], progress: second })).toMatchObject({ kind: 'stop', reason: 'no_progress' })
    const other: LeadProgress = { ...second, failing: ['R2'] }
    expect(afterConfirm({ items: [item('R1', 'fail')], progress: other }).kind).toBe('rework')
  })

  it('stops with the lead\'s own reason when it is ended and something still fails (P7)', () => {
    const ended: LeadProgress = { ...INITIAL_LEAD_PROGRESS, leadEnded: 'budget_spent' }
    const step = round([item('R1', 'fail'), item('R2', 'pass'), item('RUN', 'pass')], ended)
    expect(step).toMatchObject({ kind: 'stop', reason: 'budget_spent' })
    expect(step.progress.failing).toEqual(['R1'])
    expect(round(allPass, ended).kind).toBe('accept')
    const waiting: LeadProgress = { ...ended, leadEnded: 'time_spent', confirm: { runId: 'r', keys: ['R1'], scope: 'full' } }
    expect(afterConfirm({ items: [item('R1', 'fail')], progress: waiting })).toMatchObject({ kind: 'stop', reason: 'time_spent' })
  })

  it('sends a failing smoke back once and stops when it fails twice in a row (P2, P7)', () => {
    const first = afterCheckFailure(INITIAL_LEAD_PROGRESS, 'SMOKE')
    expect(first).toMatchObject({ kind: 'rework', keys: ['SMOKE'] })
    expect(afterCheckFailure(first.progress, 'SMOKE')).toMatchObject({ kind: 'stop', reason: 'no_progress' })
    expect(afterCheckFailure({ ...INITIAL_LEAD_PROGRESS, leadEnded: 'time_spent' }, 'SMOKE')).toMatchObject({ kind: 'stop', reason: 'time_spent' })
  })
})
```

Run `npx vitest run packages/domain/test/lead/proof.test.ts` → FAIL.

- [ ] **Step 2: The step function.** Create `packages/domain/src/lead/proof.ts`:

```ts
import type { StopReason } from './constants.js'
import type { LeadProgress } from './progress.js'

/** One requirement's verdict, as the loop reads it. */
export interface ProofItem {
  readonly key: string
  readonly status: 'pass' | 'fail' | 'unverifiable'
}

/** What happens after a concluded round or check. `progress` is what to store with the move. */
export type ProofStep =
  | { readonly kind: 'accept'; readonly progress: LeadProgress }
  | { readonly kind: 'confirm'; readonly progress: LeadProgress }
  | { readonly kind: 'verify_again'; readonly progress: LeadProgress }
  | { readonly kind: 'rework'; readonly progress: LeadProgress; readonly keys: readonly string[] }
  | { readonly kind: 'stop'; readonly progress: LeadProgress; readonly reason: StopReason }

const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n')
const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])]

/**
 * Lead-flow spec P3-P5/P7 (plan A L11/L12): what a concluded verification round means. `scope` is
 * `partial` for a round that checked only what failed before.
 *
 * - What this round says about a key replaces what earlier rounds said: a key it passes is no longer
 *   disputed or unverifiable; one it cannot verify is.
 * - A failure goes to the confirmer first (P3). A key already disputed is not confirmed again: it
 *   stays disputed.
 * - No failure: a partial round, or a full one whose tip moved under it, is followed by the full
 *   verification (P5). A full round on the current tip accepts, unless something is disputed or
 *   unverifiable -- then nothing is left to rework and not everything is proven (P4, spec D2).
 * - With the lead ended, a failure cannot be reworked: the version stops with the lead's reason (P7).
 */
export function afterRound(input: {
  readonly scope: 'full' | 'partial'
  readonly items: readonly ProofItem[]
  readonly progress: LeadProgress
  readonly runId: string
  readonly tipMoved: boolean
}): ProofStep {
  const { items, progress } = input
  const checked = new Set(items.map((one) => one.key))
  const passed = items.filter((one) => one.status === 'pass').map((one) => one.key)
  const unverifiable = union(progress.unverifiable.filter((key) => !checked.has(key)), items.filter((one) => one.status === 'unverifiable').map((one) => one.key))
  const disputed = progress.disputed.filter((key) => !passed.includes(key))
  const failed = items.filter((one) => one.status === 'fail' && !disputed.includes(one.key)).map((one) => one.key)
  const base: LeadProgress = { ...progress, unverifiable, disputed, confirm: null }

  if (failed.length > 0) {
    if (progress.leadEnded !== null) return { kind: 'stop', reason: progress.leadEnded, progress: { ...base, failing: failed } }
    return { kind: 'confirm', progress: { ...base, confirm: { runId: input.runId, keys: failed, scope: input.scope } } }
  }
  const settled: LeadProgress = { ...base, failing: [], recheckKeys: [] }
  if (input.scope === 'partial' || input.tipMoved) return { kind: 'verify_again', progress: settled }
  if (unverifiable.length > 0 || disputed.length > 0) return { kind: 'stop', reason: 'not_all_proven', progress: settled }
  return { kind: 'accept', progress: settled }
}

/**
 * Lead-flow spec P3/P7: what the confirmer's re-check means. A key both failed is confirmed; any
 * other is disputed and never reworked. Nothing confirmed: after a partial round the full
 * verification follows; after a full one nothing is left to rework. A confirmed set equal to the
 * previous round's is two rounds in a row with no progress. Otherwise the confirmed keys go back to
 * the lead, and the next round checks exactly them (P5).
 */
export function afterConfirm(input: { readonly items: readonly ProofItem[]; readonly progress: LeadProgress }): ProofStep {
  const { progress } = input
  const pending = progress.confirm
  // A replay: nothing was awaiting confirmation. The next pass verifies what the progress says.
  if (pending === null) return { kind: 'verify_again', progress }
  const statusOf = new Map(input.items.map((one) => [one.key, one.status] as const))
  const confirmed = pending.keys.filter((key) => statusOf.get(key) === 'fail')
  const disputed = union(progress.disputed, pending.keys.filter((key) => !confirmed.includes(key)))
  const base: LeadProgress = { ...progress, confirm: null, disputed }

  if (confirmed.length === 0) {
    const settled: LeadProgress = { ...base, failing: [], recheckKeys: [] }
    return pending.scope === 'partial' ? { kind: 'verify_again', progress: settled } : { kind: 'stop', reason: 'not_all_proven', progress: settled }
  }
  if (progress.leadEnded !== null) return { kind: 'stop', reason: progress.leadEnded, progress: { ...base, failing: confirmed } }
  if (sameSet(confirmed, progress.failing)) return { kind: 'stop', reason: 'no_progress', progress: { ...base, failing: confirmed } }
  return { kind: 'rework', keys: confirmed, progress: { ...base, failing: confirmed, recheckKeys: confirmed } }
}

/**
 * Lead-flow spec P2/P7: a check that is not a requirement verdict failed (the smoke script, `key` =
 * `SMOKE`). It goes back to the lead as the failing set `[key]` -- the same set twice in a row
 * stops the version, as does an ended lead.
 */
export function afterCheckFailure(progress: LeadProgress, key: string): ProofStep {
  const failing = [key]
  if (progress.leadEnded !== null) return { kind: 'stop', reason: progress.leadEnded, progress: { ...progress, failing } }
  if (sameSet(failing, progress.failing)) return { kind: 'stop', reason: 'no_progress', progress }
  return { kind: 'rework', keys: failing, progress: { ...progress, failing } }
}
```

Add `export * from './proof.js'` to the lead index. Run the test → PASS.

- [ ] **Step 3: Failing integration test.** Create `apps/orchestrator/test/integration/lead-proof.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { readLeadProgress } from '@slave-of-ai/domain'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTickObservation } from '../../src/sweep.js'
import { drainPumps, tick } from '../../src/tick.js'
import { LEAD_TRUNCATE, base64, checked, cleanUpLeadRepos, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil, type LeadFixture, type LeadSeedOptions } from './lead-helpers.js'

const ALL = ['R1', 'R2', 'RUN']
const leadTurns = (f: LeadFixture) => f.starts.filter((s) => s.kind === 'implementation')
const proofRuns = (f: LeadFixture) => f.starts.filter((s) => s.kind === 'verification')
const stopped = (f: LeadFixture) => async (): Promise<boolean> => (await leadDelivery(f)).status === 'needs_human'
const cards = (f: LeadFixture) => prisma.supervisorDecision.findMany({ where: { workspaceId: f.workspaceId, status: 'pending' }, select: { situationKind: true } })

/** A verifier script: run n answers `failing[n - 1]` (keys that fail; `'?'` + key: unverifiable) among the keys it was asked; past the end, everything passes. */
function script(failing: readonly (readonly string[])[]): NonNullable<LeadSeedOptions['verify']> {
  return (ordinal, run) => {
    const marks = failing[ordinal - 1]
    if (marks === undefined) return undefined
    return (run.keys.length === 0 ? ALL : run.keys).map((key) => checked(key, marks.includes(key) ? 'fail' : marks.includes(`?${key}`) ? 'unverifiable' : 'pass'))
  }
}

describe('the lead flow: proof gates', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(LEAD_TRUNCATE)
    resetTickObservation()
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    cleanUpLeadRepos()
    await prisma.$disconnect()
  })

  it('confirms a failure, reworks it in the lead\'s own session with the evidence, re-checks only it, and ends on a full verification', async (): Promise<void> => {
    const f = await seedLead({ verify: script([['R1'], ['R1'], [], []]) })
    await tickUntil(f, merged(f))

    expect(proofRuns(f).map((run) => [run.confirms, run.verificationKeys])).toEqual([[false, []], [true, ['R1']], [false, ['R1']], [false, []]])
    const seats = await prisma.slaveRun.findMany({ where: { id: { in: proofRuns(f).map((run) => run.runId) } }, orderBy: { startedAt: 'asc' }, select: { slave: { select: { role: true } } } })
    expect(seats.map((run) => run.slave.role)).toEqual(['Verifier', 'Confirmer', 'Verifier', 'Verifier'])
    expect(proofRuns(f)[1]?.prompt).toContain('Requirement keys: R1\n')
    expect(proofRuns(f)[1]?.prompt).not.toContain('R2:')
    // C5: the verifier and the confirmer run on Claude Code with no `--model` either.
    expect(proofRuns(f).map((run) => run.model)).toEqual([null, null, null, null])
    expect(await prisma.slaveRun.count({ where: { kind: 'verification', model: { not: null } } })).toBe(0)

    expect(leadTurns(f).map((turn) => turn.leadTurn)).toEqual(['build', 'rework'])
    const rework = leadTurns(f)[1]
    expect(rework?.resumeSessionId).toBe('fake-session-complete')
    expect(rework?.prompt).toContain('independent verification')
    expect(rework?.prompt).toContain('R1: GET /health answers 200')
    expect(rework?.prompt).toContain('404 Not Found')
    expect(rework?.prompt).not.toContain('THE GOAL')
    expect((await leadTaskOf(f)).attempt).toBe(0)

    const delivery = await leadDelivery(f)
    expect([delivery.stopReason, delivery.round]).toEqual(['proven', 3])
    expect(readLeadProgress(delivery.leadProgress)).toMatchObject({ failing: [], recheckKeys: [], disputed: [], confirm: null })
    const confirmRows = await prisma.verificationResult.findMany({ where: { runId: proofRuns(f)[1]?.runId ?? '' }, select: { key: true, status: true, round: true } })
    expect(confirmRows).toEqual([{ key: 'R1', status: 'fail', round: 1 }])
    // Two smoke checks: the first tip and the reworked one (P5).
    expect(await prisma.smokeAttempt.count({ where: { status: 'passed' } })).toBe(2)
    expect(await cards(f)).toEqual([])
  })

  it('does not rework a failure the confirmer does not confirm: the key is disputed and the version waits for a decision', async (): Promise<void> => {
    const f = await seedLead({ verify: script([['R1'], []]) })
    await tickUntil(f, stopped(f))

    expect(leadTurns(f)).toHaveLength(1)
    expect((await leadTaskOf(f)).status).toBe('done')
    const delivery = await leadDelivery(f)
    expect([delivery.stopReason, delivery.leadState]).toEqual(['not_all_proven', 'awaiting_decision'])
    expect(delivery.needsHumanReason).toContain('disputed (the two verifiers disagreed): R1')
    expect(readLeadProgress(delivery.leadProgress).disputed).toEqual(['R1'])
    expect(await leadNotes(f)).toContain('disputed: R1: the first verifier said it fails and the second did not; it is not sent back to the lead')
    for (let i = 0; i < 3; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }
    expect(leadTurns(f)).toHaveLength(1)
    expect(await cards(f)).toEqual([{ situationKind: 'goal_needs_human' }])
  })

  it('stops after two rounds that fail the same set, with one card', async (): Promise<void> => {
    const f = await seedLead({ verify: script([['R1'], ['R1'], ['R1'], ['R1']]) })
    await tickUntil(f, stopped(f))

    expect(leadTurns(f).map((turn) => turn.leadTurn)).toEqual(['build', 'rework'])
    expect(proofRuns(f)).toHaveLength(4)
    const delivery = await leadDelivery(f)
    expect(delivery.stopReason).toBe('no_progress')
    expect(delivery.needsHumanReason).toContain('two rounds in a row failed the same items')
    expect(delivery.needsHumanReason).toContain('failing: R1')
    for (let i = 0; i < 3; i += 1) {
      await tick(f.deps)
      await drainPumps()
    }
    expect(leadTurns(f)).toHaveLength(2)
    expect(await cards(f)).toEqual([{ situationKind: 'goal_needs_human' }])
  })

  it('goes on past an unverifiable requirement and names it at the end (P4)', async (): Promise<void> => {
    const f = await seedLead({ verify: script([['?R1', 'R2'], ['R2'], [], ['?R1']]) })
    await tickUntil(f, stopped(f))

    expect(leadTurns(f).map((turn) => turn.leadTurn)).toEqual(['build', 'rework'])
    const delivery = await leadDelivery(f)
    expect(delivery.stopReason).toBe('not_all_proven')
    expect(delivery.needsHumanReason).toContain('could not be verified: R1')
    expect(delivery.needsHumanReason).not.toContain('failing:')
  })

  it('sends a failing smoke back to the lead and proves the fix; the same smoke failure twice stops the version (P2, P7)', async (): Promise<void> => {
    const fixed = await seedLead({ smokeFailures: 1 })
    await tickUntil(fixed, merged(fixed))
    expect(leadTurns(fixed).map((turn) => turn.leadTurn)).toEqual(['build', 'rework'])
    expect(leadTurns(fixed)[1]?.prompt).toContain('the product did not start')
    expect(proofRuns(fixed)).toHaveLength(1)

    const broken = await seedLead({ smokeFailures: 5 })
    await tickUntil(broken, stopped(broken))
    expect(leadTurns(broken)).toHaveLength(2)
    expect(proofRuns(broken)).toEqual([])
    const delivery = await leadDelivery(broken)
    expect(delivery.stopReason).toBe('no_progress')
    expect(delivery.needsHumanReason).toContain('the smoke check found')
    expect(delivery.needsHumanReason).toContain('failing: SMOKE')
  })

  it('caps a verification at what the goal has left, and stops unproven when nothing is left to pay one', async (): Promise<void> => {
    const cost = (usd: number): readonly string[] => ['--result-patch-base64', base64({ total_cost_usd: usd })]
    const paid = await seedLead({ budgetUsd: 30, leadArgs: () => cost(10) })
    await tickUntil(paid, merged(paid))
    expect(proofRuns(paid)[0]?.extras).toEqual({ maxBudgetUsd: 19.98 })

    const broke = await seedLead({ budgetUsd: 30, leadArgs: () => cost(29.99) })
    await tickUntil(broke, stopped(broke))
    expect(proofRuns(broke)).toEqual([])
    const delivery = await leadDelivery(broke)
    expect(delivery.stopReason).toBe('budget_spent')
    expect(delivery.needsHumanReason).toContain('the result is unproven')
  })
})
```

Run `npx vitest run apps/orchestrator/test/integration/lead-proof.test.ts` → FAIL (the first case reworks the lead with no confirmation run: the second proof run has `confirms: false`).

- [ ] **Step 4: The lead's proof run.** In `apps/orchestrator/src/verification.ts` write `export async function releaseClaim(` and `export async function tamperedReason(`. Create `apps/orchestrator/src/lead/proofRun.ts`:

```ts
import { ensureLeadSeats, goalEventWith, goalSpend, withDeliveryLock } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  afterConfirm,
  afterRound,
  err,
  parseSlaveVerification,
  proofCapUsd,
  readLeadProgress,
  renderVerificationRework,
  requirementItemsSchema,
  runCheckLeansOnSmoke,
  type LeadProgress,
  type ProofStep,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { acceptInLock } from '../goal.js'
import { joinRunOutput } from '../runOutput.js'
import { failConcludedRun } from '../runs.js'
import { releaseClaim, removeVerificationWorktree, tamperedReason } from '../verification.js'
import { gitIn } from '../worktree.js'
import { noteLead, noteLeadOnce, progressJson } from './record.js'
import { stopLead, stopLeadInLock } from './stop.js'

/** What a lead-flow version's next proof run checks, who takes it and what it may spend. */
export type LeadProofScope =
  | { readonly kind: 'hold' }
  | { readonly kind: 'run'; readonly keys: readonly string[]; readonly confirmsRunId: string | null; readonly seatId: string | null; readonly capUsd: number | null }

/**
 * Lead-flow spec P3/P5 and B4 (plan A L6/L11): the next proof run of a lead-flow version. Failures
 * awaiting confirmation: the confirmer seat re-checks exactly those keys. Otherwise the verifier
 * checks `recheckKeys` (what failed before), or the whole set when that is empty. The run is capped
 * at whatever the goal has left, the reserve included; with nothing left no verification can be
 * paid, and the version stops saying the result is unproven (spec section 9).
 */
export async function leadProofScope(
  delivery: { readonly id: string; readonly workspaceId: string; readonly goalVersion: number; readonly leadProgress: unknown },
  budgetUsd: number | null,
): Promise<LeadProofScope> {
  const capUsd = proofCapUsd(budgetUsd, (await goalSpend(delivery.workspaceId, delivery.goalVersion)).totalUsd)
  if (capUsd === 'spent') {
    await stopLead(delivery.id, 'budget_spent', 'nothing is left of the budget to pay a verification: the result is unproven')
    return { kind: 'hold' }
  }
  const progress = readLeadProgress(delivery.leadProgress)
  if (progress.confirm !== null) {
    const seats = await ensureLeadSeats(delivery.workspaceId)
    return { kind: 'run', keys: progress.confirm.keys, confirmsRunId: progress.confirm.runId, seatId: seats.ok ? seats.value.confirmer : null, capUsd }
  }
  return { kind: 'run', keys: progress.recheckKeys, confirmsRunId: null, seatId: null, capUsd }
}

/** Thrown inside the lock when the run no longer holds the claim (a refusal in a transaction throws). */
class NotTheClaim extends Error {}

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').slice(0, 200)

/**
 * Lead-flow spec P3-P5/P7 (plan A L11/L12): the conclusion of a `succeeded` verification run of a
 * lead-flow version. The reading is the existing gate's -- the tamper check, the verdict parsed for
 * exactly the keys the run was asked, the smoke-only RUN check refused, an unusable run released as
 * one run failure -- and the rows and `workspace.verified` are written as it writes them. What the
 * verdict MEANS is the lead flow's: `afterConfirm` for a confirmation run, `afterRound` otherwise,
 * carried out in the same locked write that releases the claim.
 */
export async function concludeLeadVerification(runId: string): Promise<void> {
  const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId }, include: { goalDelivery: { include: { workspace: true } } } })
  const delivery = run.goalDelivery
  if (delivery === null) return
  const workspace = delivery.workspace
  const set = await prisma.requirementSet.findUniqueOrThrow({ where: { workspaceId_goalVersion: { workspaceId: workspace.id, goalVersion: delivery.goalVersion } } })
  const requirements = requirementItemsSchema.parse(set.items)
  const allKeys = requirements.map((requirement) => requirement.key)
  const keys = run.verificationKeys.length === 0 ? allKeys : allKeys.filter((key) => run.verificationKeys.includes(key))
  const scope = keys.length < allKeys.length ? 'partial' : 'full'

  const tampered = await tamperedReason(run.worktreePath, run.verificationBaseline)
  const rows = await prisma.executionEvent.findMany({ where: { runId: run.id, type: 'run_output' }, orderBy: { seq: 'asc' }, select: { payload: true } })
  const read = tampered !== null ? err(tampered) : parseSlaveVerification(joinRunOutput(rows.map((row) => row.payload)), keys)
  const leaning = read.ok ? runCheckLeansOnSmoke(read.value) : null
  const parsed = leaning === null ? read : err(leaning)
  if (!parsed.ok) {
    if (await releaseClaim(delivery.id, run.id)) await failConcludedRun(run, workspace.id, `verification: ${parsed.error}`)
    await removeVerificationWorktree(workspace.repoPath, run.worktreePath)
    return
  }
  const items = parsed.value
  const tip = await gitIn(workspace.repoPath, 'rev-parse', delivery.integrationBranch)
  const textOf = new Map(requirements.map((requirement) => [requirement.key, requirement.text] as const))
  const outcome: { before: LeadProgress | null; step: ProofStep | null; round: number } = { before: null, step: null, round: delivery.round }

  try {
    await withDeliveryLock(delivery.id, async (tx) => {
      const now = await tx.goalDelivery.findUniqueOrThrow({ where: { id: delivery.id } })
      if (now.activeRunId !== run.id || now.status !== 'verifying') throw new NotTheClaim()
      await tx.verificationResult.createMany({
        data: items.map((item) => ({ workspaceId: workspace.id, goalDeliveryId: delivery.id, goalVersion: delivery.goalVersion, round: now.round, runId: run.id, key: item.key, status: item.status, check: item.check, output: item.output, reason: item.reason })),
        skipDuplicates: true,
      })
      if (!(await goalEventWith(tx, workspace.id, 'workspace_verified', { runId: run.id }))) {
        const failed = items.filter((item) => item.status === 'fail')
        await appendEvent({
          type: 'workspace.verified',
          workspaceId: workspace.id,
          runId: run.id,
          actor: 'system',
          payload: { version: delivery.goalVersion, round: now.round, runId: run.id, pass: items.filter((item) => item.status === 'pass').length, fail: failed.length, unverifiable: items.filter((item) => item.status === 'unverifiable').length, failedKeys: failed.map((item) => item.key).slice(0, 60) },
        })
      }

      const before = readLeadProgress(now.leadProgress)
      const step = run.confirmsRunId !== null ? afterConfirm({ items, progress: before }) : afterRound({ scope, items, progress: before, runId: run.id, tipMoved: run.verificationTip === null || run.verificationTip !== tip })
      outcome.before = before
      outcome.step = step
      outcome.round = now.round
      const held = { id: delivery.id, status: 'verifying' as const, activeRunId: run.id }

      if (step.kind === 'accept') {
        await tx.goalDelivery.update({ where: { id: delivery.id }, data: { leadProgress: progressJson(step.progress), stopReason: 'proven' } })
        if (!(await acceptInLock(tx, delivery.id, { runId: run.id, verifiedCommit: tip }))) throw new NotTheClaim()
        return
      }
      if (step.kind === 'stop') {
        if (!(await stopLeadInLock(tx, delivery.id, step.reason, step.progress, null))) throw new NotTheClaim()
        return
      }
      if (step.kind === 'confirm') {
        // The same round goes on: the claim is given back with no run failure counted, and the next
        // goal pass dispatches the confirmer on the same commit.
        const moved = await tx.goalDelivery.updateMany({ where: held, data: { activeRunId: null, leadProgress: progressJson(step.progress) } })
        if (moved.count === 0) throw new NotTheClaim()
        return
      }
      if (step.kind === 'rework') {
        // Spec B8: the evidence is the FIRST verifier's -- its check, output and reason for each key
        // both sessions failed -- and it goes into the lead's own session as its next turn.
        const firstRunId = before.confirm?.runId ?? run.id
        const evidence = await tx.verificationResult.findMany({ where: { runId: firstRunId, key: { in: [...step.keys] } }, orderBy: { key: 'asc' } })
        const reason = renderVerificationRework(now.round, evidence.map((row) => ({ key: row.key, status: 'fail' as const, check: row.check, output: row.output, reason: row.reason, text: textOf.get(row.key) ?? '' })))
        const task = await tx.task.findFirst({ where: { workspaceId: workspace.id, workPackage: { goalVersion: delivery.goalVersion } }, select: { id: true, status: true, attempt: true } })
        if (task === null || task.status !== 'done') {
          if (!(await stopLeadInLock(tx, delivery.id, 'lead_failed', step.progress, "the lead's task cannot be sent back"))) throw new NotTheClaim()
          return
        }
        if (!(await goalEventWith(tx, workspace.id, 'task_rework', { verificationRound: now.round }, { taskId: task.id }))) {
          await appendEvent({ type: 'task.rework', workspaceId: workspace.id, taskId: task.id, actor: 'system', payload: { reason, attempt: task.attempt, verificationRound: now.round } })
        }
        await tx.task.updateMany({ where: { id: task.id, status: 'done' }, data: { status: 'rework', integratedAt: null, activeRunId: null, lastRejectionReason: reason } })
        const moved = await tx.goalDelivery.updateMany({ where: held, data: { status: 'integrating', activeRunId: null, leadProgress: progressJson({ ...step.progress, nextTurn: { kind: 'rework', note: reason } }) } })
        if (moved.count === 0) throw new NotTheClaim()
        return
      }
      // `verify_again`: back to `integrating`; the next pass verifies what the progress now says
      // (the whole set) on the current tip, in a new round.
      const moved = await tx.goalDelivery.updateMany({ where: held, data: { status: 'integrating', activeRunId: null, leadProgress: progressJson(step.progress) } })
      if (moved.count === 0) throw new NotTheClaim()
    })
  } catch (error) {
    if (!(error instanceof NotTheClaim)) throw error
    outcome.step = null
  }

  if (outcome.step !== null && outcome.before !== null) {
    const at = { workspaceId: workspace.id, version: delivery.goalVersion, runId: run.id }
    const before = outcome.before
    for (const key of outcome.step.progress.disputed.filter((one) => !before.disputed.includes(one))) {
      await noteLead({ ...at, kind: 'disputed', detail: `${key}: the first verifier said it fails and the second did not; it is not sent back to the lead` })
    }
    for (const item of items.filter((one) => one.status === 'unverifiable')) {
      await noteLeadOnce({ ...at, kind: 'unverifiable', detail: `${item.key} could not be verified: ${firstLine(item.reason)}` })
    }
  }
  await removeVerificationWorktree(workspace.repoPath, run.worktreePath)
}
```

- [ ] **Step 5: The two branches in `verification.ts`.** Import `writeSpawnExtras` (providers) and `concludeLeadVerification, leadProofScope` from `'./lead/proofRun.js'`. Add above `dispatchVerification`:

```ts
/** Lead flow (spec P3): a named seat -- the confirmer -- or `'busy'` while it holds a live run. */
async function namedSeat(seatId: string): Promise<VerifierSeat | 'busy' | null> {
  const seat = await prisma.slave.findUnique({ where: { id: seatId }, include: seatInclude })
  if (seat === null) return null
  const live = await prisma.slaveRun.count({ where: { slaveId: seat.id, status: { in: [...NON_TERMINAL_RUN_STATUSES] } } })
  return live > 0 ? 'busy' : seat
}
```

In `dispatchVerification`:

(a) Replace

```ts
  const excluded = await implementersOf(workspace.id, delivery.goalVersion)
  const seat = await eligibleVerifier(workspace.id, delivery, excluded)
  if (seat === 'busy' || seat === null) return null
```

with

```ts
  // Lead flow (spec P3/P5, B4; plan A L6/L11): which keys this run checks, whose failures it
  // confirms, the seat that takes it and what it may spend. `hold`: no verification can be paid, and
  // the version has been stopped. Null for every other workspace, whose dispatch is unchanged.
  const scope = workspace.flow === 'lead' ? await leadProofScope(delivery, workspace.budgetUsd) : null
  if (scope?.kind === 'hold') return null
  const lead = scope?.kind === 'run' ? scope : null

  const excluded = await implementersOf(workspace.id, delivery.goalVersion)
  const seat = lead?.seatId != null ? await namedSeat(lead.seatId) : await eligibleVerifier(workspace.id, delivery, excluded)
  if (seat === 'busy' || seat === null) return null
```

(b) Add to the `createRunUnlessArchived` data: `...(lead === null ? {} : { verificationKeys: [...lead.keys], confirmsRunId: lead.confirmsRunId }),`.

(c) After `const requirements = requirementItemsSchema.parse(requirementSet.items)` add

```ts
    // Lead flow (spec P3/P5): a confirmation, or a round after rework, checks only the keys it was given.
    const asked = lead === null || lead.keys.length === 0 ? requirements : requirements.filter((requirement) => lead.keys.includes(requirement.key))
```

and pass `requirements: asked,` in `buildRunContext`'s `verification` object (in place of `requirements,`).

(d) Directly above `handle = await runAdapter.start({`, add

```ts
    // Lead flow (spec B4): the run may spend what the goal has left, and no more.
    if (lead !== null && lead.capUsd !== null) writeSpawnExtras(runDir, { maxBudgetUsd: lead.capUsd })
```

(e) The seat's runtime (C5): import `leadRuntime` from `'./model.js'` and replace `const resolved = resolveRuntime(` … `)` with `const resolved = lead !== null ? leadRuntime(seat) : resolveRuntime(` … `)` (the arguments unchanged). A lead-flow verifier and confirmer run on Claude Code with no `--model` unless their seat names one.

In `concludeVerification`, after the block

```ts
  if (delivery.activeRunId !== run.id) {
    // A replay, or the claim was released meanwhile: nothing to decide, and the checkout is spent.
    await removeVerificationWorktree(workspace.repoPath, run.worktreePath)
    return
  }
```

add

```ts
  // Lead flow (spec P3-P5/P7, plan A L11/L12): the lead flow's own loop decides what this verdict
  // means -- confirmation, disputed, a partial round, the stop rules. Every other workspace's
  // conclusion is below, unchanged.
  if (workspace.flow === 'lead') {
    await concludeLeadVerification(run.id)
    return
  }
```

- [ ] **Step 6: The smoke branch.** In `apps/orchestrator/src/smoke.ts` import `SMOKE_FAILING_KEY, afterCheckFailure, readLeadProgress` from `@slave-of-ai/domain`, `progressJson` from `'./lead/record.js'` and `stopLeadInLock` from `'./lead/stop.js'`. In `applySmokeOutcome`: change the delivery read's `include` to `{ workspace: { select: { verificationRoundCap: true, flow: true } } }`; replace `const capped = delivery.round - delivery.roundBase >= cap` with

```ts
    // Lead flow (plan A L12): the round cap does not apply; the lead flow's own stop rules do.
    const leadFlow = delivery.workspace.flow === 'lead'
    const capped = !leadFlow && delivery.round - delivery.roundBase >= cap
```

and directly after `const stop = smokeStopReason({ outcome: failure, output: attempt.output })` add

```ts
    // Lead flow (spec P2/P7): a failing smoke goes back to the lead like a failing requirement, as
    // the failing set `SMOKE` -- the same failure twice in a row, or an ended lead, stops the version.
    // Otherwise the rework below sends it back exactly as it sends a package's.
    if (leadFlow) {
      const step = afterCheckFailure(readLeadProgress(delivery.leadProgress), SMOKE_FAILING_KEY)
      if (step.kind === 'stop') {
        await stopLeadInLock(tx, delivery.id, step.reason, step.progress, `the smoke check found ${stop}`)
        return
      }
      await tx.goalDelivery.update({ where: { id: delivery.id }, data: { leadProgress: progressJson(step.progress) } })
    }
```

- [ ] **Step 7: Run.** `npx tsc --build && npx vitest run packages/domain/test/lead/proof.test.ts`, then `npx vitest run apps/orchestrator/test/integration/lead-proof.test.ts` → PASS. Then one file at a time: `…/lead-open.test.ts`, `…/lead-turn.test.ts`, `…/lead-limits.test.ts`, `…/verification.test.ts`, `…/smoke.test.ts`, `…/goal-pass.test.ts`, `…/conductor-e2e.test.ts` → PASS. `npm run typecheck`.

- [ ] **Step 8: Commit**

```bash
git add packages/domain/src/lead packages/domain/test/lead/proof.test.ts apps/orchestrator/src/lead/proofRun.ts apps/orchestrator/src/verification.ts apps/orchestrator/src/smoke.ts apps/orchestrator/test/integration/lead-proof.test.ts
git commit -m "feat(lead): a failure is confirmed before it is reworked, a disagreement is disputed, unverifiable never stops the loop, and two rounds with the same failures do

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: Delivery: the one card's two decisions, and a base branch that moved (spec D1, D2 in its smallest form, D3; L13, L15)

**Files:**
- Create: `packages/control/src/lead/card.ts`; modify `packages/control/src/index.ts`
- Modify: `packages/control/src/supervisor.ts` (`carryOut`, `case 'escalate_to_human'` at `:852-859`; `rejectDecision` at `:1151-1183`: one call after `afterCardClose`)
- Create: `apps/orchestrator/src/lead/base.ts`
- Modify: `apps/orchestrator/src/lead/conclude.ts` (`settleLeadWork`: `baseCommit` follows a base branch the lead took in)
- Modify: `apps/orchestrator/src/goal.ts` (`advanceDelivery`, the `if (workspace.autoMerge)` branch at `:173-175`)
- Test: `packages/control/test/integration/lead-card.test.ts` (new), `apps/orchestrator/test/integration/lead-delivery.test.ts` (new)

**Interfaces:**
- Consumes: `withDeliveryLock`, `abandonGoal`, `gitIn` (`packages/control/src/git.ts`), `Principal`; `readLeadProgress`, `LEAD_BASE_MERGES_MAX`; `updateLeadProgress`, `noteLead` (Task 6); `emailLocalPart` (`tick.ts`); `gitIn` (`apps/orchestrator/src/worktree.ts`).
- Produces (control, `lead/card.ts`):
  - `acceptLeadGoalAsIs(workspaceId: string, goalVersion: number, principal?: Principal): Promise<Result<'applied' | 'none', ControlRefusal>>` -- `'none'` for a version that is not a stopped lead-flow version (nothing is written).
  - `leaveLeadGoal(workspaceId: string, goalVersion: number, principal?: Principal): Promise<Result<'applied' | 'none', ControlRefusal>>`
- Produces (orchestrator, `lead/base.ts`): `leadTakeBaseIn(deliveryId: string): Promise<'unmoved' | 'taken' | 'turn' | 'waiting'>`.
- What each button on the card does (L13): **Approve** = accept as it is: `needs_human → accepted`, `verifiedCommit` = the work branch's tip, `stopReason = accepted_as_is`, the lead's unfinished task cancelled; the goal pass then merges it (automatic merge) or waits for the hand merge (automatic merge off), as for any accepted version. **Reject** = leave it: the existing `abandonGoal` (the branch stays; the next goal version may be conducted), `stopReason = left`.
- Spec D1 as built: `setFlow` turned automatic merge on (Task 2); an accepted version is merged by the existing `mergeGoalIntoBase`, fast-forward only, to the verified commit.
- Unchanged for `packages`: both card verbs return `'none'` before any write for a delivery whose `leadState` is null, so Approve and Reject on a `goal_needs_human` card do exactly what they did; the goal pass calls `leadTakeBaseIn` only for `workspace.flow === 'lead'`.
- Import cycle, stated: `supervisor.ts → lead/card.ts → goalDelivery.ts → supervisor.ts`. Every cross-module use on it is a function called at run time; nothing is read at module evaluation.

- [ ] **Step 1: Failing control test.** Create `packages/control/test/integration/lead-card.test.ts`:

```ts
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { acceptLeadGoalAsIs, leaveLeadGoal } from '../../src/lead/card.js'

const dirs: string[] = []

/** A repository with a work branch one commit ahead of main, and a delivery row on it. */
async function seed(data: { readonly leadState: 'awaiting_decision' | null; readonly status: 'needs_human' | 'integrating' }): Promise<{ readonly workspaceId: string; readonly tip: string; readonly taskId: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-lead-card-'))
  dirs.push(dir)
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@x', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# x\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'initial')
  const base = git('rev-parse', 'HEAD')
  git('checkout', '-q', '-b', 'slaveofai/goal-v1')
  writeFileSync(join(dir, 'work.txt'), 'work\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'work')
  const tip = git('rev-parse', 'HEAD')
  git('checkout', '-q', 'main')
  const ws = await prisma.workspace.create({ data: { name: `Card ${String(Math.random()).slice(2)}`, repoPath: dir, verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted', autoMerge: true } })
  const pkg = await prisma.workPackage.create({ data: { workspaceId: ws.id, goalVersion: 1, key: 'main', title: 'The whole goal', requirementKeys: ['R1'], ownedPaths: ['**'], interface: '', templateId: 'lead' } })
  const task = await prisma.task.create({ data: { workspaceId: ws.id, title: 'The whole goal', description: 'x', status: 'rework', requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1, workPackageId: pkg.id } })
  await prisma.goalDelivery.create({
    data: { workspaceId: ws.id, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1', baseCommit: base, status: data.status, leadState: data.leadState, stopReason: data.leadState === null ? null : 'no_progress', needsHumanReason: data.status === 'needs_human' ? 'it stopped' : null },
  })
  return { workspaceId: ws.id, tip, taskId: task.id }
}

describe('the delivery card\'s two decisions (lead-flow plan A L13)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "WorkPackage", "GoalDelivery", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  it('accepts a stopped lead-flow version as it is: accepted at the work branch\'s tip, its unfinished task cancelled', async (): Promise<void> => {
    const f = await seed({ leadState: 'awaiting_decision', status: 'needs_human' })
    expect(await acceptLeadGoalAsIs(f.workspaceId, 1)).toEqual({ ok: true, value: 'applied' })
    const delivery = await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })
    expect(delivery).toMatchObject({ status: 'accepted', verifiedCommit: f.tip, stopReason: 'accepted_as_is', needsHumanReason: null })
    expect(delivery.acceptedAt).not.toBeNull()
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).status).toBe('cancelled')
    expect(await prisma.executionEvent.count({ where: { taskId: f.taskId, type: 'task_cancelled' } })).toBe(1)
    // A second approval finds nothing to accept and writes nothing.
    expect(await acceptLeadGoalAsIs(f.workspaceId, 1)).toEqual({ ok: true, value: 'none' })
  })

  it('leaves a stopped lead-flow version: abandoned, the branch untouched', async (): Promise<void> => {
    const f = await seed({ leadState: 'awaiting_decision', status: 'needs_human' })
    expect(await leaveLeadGoal(f.workspaceId, 1)).toEqual({ ok: true, value: 'applied' })
    expect(await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: f.workspaceId } })).toMatchObject({ status: 'abandoned', stopReason: 'left' })
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'workspace_goal_abandoned' } })).toBe(1)
  })

  it('does nothing for a version that is not a stopped lead-flow version', async (): Promise<void> => {
    const other = await seed({ leadState: null, status: 'needs_human' })
    expect(await acceptLeadGoalAsIs(other.workspaceId, 1)).toEqual({ ok: true, value: 'none' })
    expect(await leaveLeadGoal(other.workspaceId, 1)).toEqual({ ok: true, value: 'none' })
    expect((await prisma.goalDelivery.findFirstOrThrow({ where: { workspaceId: other.workspaceId } })).status).toBe('needs_human')

    const running = await seed({ leadState: 'awaiting_decision', status: 'integrating' })
    expect(await acceptLeadGoalAsIs(running.workspaceId, 1)).toEqual({ ok: true, value: 'none' })
    expect(await acceptLeadGoalAsIs(running.workspaceId, 7)).toMatchObject({ ok: false, error: { kind: 'goal_version_not_found' } })
  })
})
```

Run `npx vitest run packages/control/test/integration/lead-card.test.ts` → FAIL (the module does not exist).

- [ ] **Step 2: The two verbs.** Create `packages/control/src/lead/card.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { type Result, err, ok } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { gitIn } from '../git.js'
import { abandonGoal, withDeliveryLock } from '../goalDelivery.js'
import type { Principal } from '../principal.js'
import type { ControlRefusal } from '../refusal.js'

/** The task statuses of a lead that will not work again: nothing runs them, so they are taken off the board. */
const UNFINISHED = ['ready', 'rework', 'blocked'] as const

/**
 * Lead-flow spec D2 in its smallest form (plan A L13): a person accepts a stopped lead-flow version
 * as it is. Under the delivery's lock: `needs_human → accepted` with `verifiedCommit` = the work
 * branch's tip (what the goal pass's merge lands), the stop's reason replaced by `accepted_as_is`,
 * and the lead's unfinished task cancelled -- the lead will not work on it again. The goal pass then
 * merges it or waits for the hand merge, as for any accepted version.
 *
 * `'none'`, with nothing written, for any other version: one not built by a lead (`leadState`
 * null), or one that is not stopped -- so the card's Approve keeps meaning what it meant.
 */
export async function acceptLeadGoalAsIs(workspaceId: string, goalVersion: number, principal?: Principal): Promise<Result<'applied' | 'none', ControlRefusal>> {
  const found = await prisma.goalDelivery.findUnique({
    where: { workspaceId_goalVersion: { workspaceId, goalVersion } },
    include: { workspace: { select: { repoPath: true } } },
  })
  if (found === null) return err({ kind: 'goal_version_not_found', workspaceId, goalVersion })
  if (found.leadState === null || found.status !== 'needs_human') return ok('none')
  const tip = await gitIn(found.workspace.repoPath, 'rev-parse', `refs/heads/${found.integrationBranch}`)

  const cancelled = await withDeliveryLock(found.id, async (tx): Promise<readonly string[] | null> => {
    // The guarded move is the first write: a version something else moved meanwhile is left alone.
    const moved = await tx.goalDelivery.updateMany({
      where: { id: found.id, status: 'needs_human' },
      data: { status: 'accepted', acceptedAt: new Date(), verifiedCommit: tip, needsHumanReason: null, stopReason: 'accepted_as_is' },
    })
    if (moved.count === 0) return null
    const tasks = await tx.task.findMany({ where: { workspaceId, workPackage: { goalVersion }, status: { in: [...UNFINISHED] }, activeRunId: null }, select: { id: true } })
    const ids = tasks.map((task) => task.id)
    await tx.task.updateMany({ where: { id: { in: ids } }, data: { status: 'cancelled', lastRejectionReason: `goal v${String(goalVersion)} was accepted as it is` } })
    return ids
  })
  if (cancelled === null) return ok('none')
  for (const taskId of cancelled) {
    await appendEvent({ type: 'task.cancelled', workspaceId, taskId, actor: 'human', payload: { reason: `goal v${String(goalVersion)} was accepted as it is`, goalVersion }, userId: principal?.userId ?? null })
  }
  return ok('applied')
}

/**
 * Plan A L13: a person leaves a stopped lead-flow version. The existing `abandonGoal` -- the work
 * branch stays, its unfinished task is cancelled, the next goal version may be conducted -- with
 * the stop's reason replaced by `left`. `'none'` for a version not built by a lead.
 */
export async function leaveLeadGoal(workspaceId: string, goalVersion: number, principal?: Principal): Promise<Result<'applied' | 'none', ControlRefusal>> {
  const found = await prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } }, select: { id: true, leadState: true, status: true } })
  if (found === null) return err({ kind: 'goal_version_not_found', workspaceId, goalVersion })
  if (found.leadState === null || found.status !== 'needs_human') return ok('none')
  const abandoned = await abandonGoal(workspaceId, goalVersion, principal)
  if (!abandoned.ok) return abandoned
  await prisma.goalDelivery.update({ where: { id: found.id }, data: { stopReason: 'left' } })
  return ok('applied')
}
```

Add `export * from './lead/card.js'` to `packages/control/src/index.ts`. Run the test → PASS.

- [ ] **Step 3: The card's buttons.** In `packages/control/src/supervisor.ts` import `acceptLeadGoalAsIs, leaveLeadGoal` from `'./lead/card.js'`. In `carryOut`, `case 'escalate_to_human':`, directly above its `return ok('none')`:

```ts
      // Lead flow (spec D2 in its smallest form, plan A L13): a person saying yes to a stopped
      // lead-flow version's card accepts it as it is. `'none'` for every other version, which
      // leaves this approval exactly what it was -- a question only the person can act on.
      if (origin === 'human' && decision.situation.kind === 'goal_needs_human') {
        const version = decision.situation.facts['goalVersion']
        if (typeof version === 'number') {
          const accepted = await acceptLeadGoalAsIs(decision.workspaceId, version, principal)
          if (!accepted.ok) return accepted
          if (accepted.value === 'applied') return ok('applied')
        }
      }
```

In `rejectDecision`, directly after `await afterCardClose(claim.value.workspaceId, decisionId, claim.value.close, new Date())`:

```ts
  // Lead flow (plan A L13): a person saying no to a stopped lead-flow version's card leaves it.
  await leaveLeadGoalOnReject(decisionId, principal)
```

and add below `rejectDecision`:

```ts
/**
 * Plan A L13: Reject on a lead-flow version's `goal_needs_human` card is "leave it". Nothing for
 * any other card. A version that cannot be left now (a run still holds it) is said and left for the
 * person's `abandon-goal`: the rejection itself stands.
 */
async function leaveLeadGoalOnReject(decisionId: string, principal?: Principal): Promise<void> {
  const row = await prisma.supervisorDecision.findUnique({ where: { id: decisionId }, select: { workspaceId: true, situationKind: true, situation: true } })
  if (row === null || row.situationKind !== 'goal_needs_human') return
  const version = (row.situation as { readonly facts?: { readonly goalVersion?: unknown } } | null)?.facts?.goalVersion
  if (typeof version !== 'number') return
  const left = await leaveLeadGoal(row.workspaceId, version, principal)
  if (!left.ok) console.warn(`[supervisor] decision ${decisionId} was rejected, but goal v${String(version)} could not be left: ${refusalText(left.error)}`)
}
```

- [ ] **Step 4: Failing integration test.** Create `apps/orchestrator/test/integration/lead-delivery.test.ts`:

```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { approveDecision, rejectDecision, setGoal } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_BASE_MERGES_MAX, readLeadProgress } from '@slave-of-ai/domain'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTickObservation } from '../../src/sweep.js'
import { drainPumps, tick } from '../../src/tick.js'
import { LEAD_TRUNCATE, checked, cleanUpLeadRepos, git, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil, type LeadFixture, type LeadStart } from './lead-helpers.js'

const ALL = ['R1', 'R2', 'RUN']
const leadTurns = (f: LeadFixture) => f.starts.filter((s) => s.kind === 'implementation')
const proofRuns = (f: LeadFixture) => f.starts.filter((s) => s.kind === 'verification')

/** A version stopped `not_all_proven`: the first round fails R1 and the confirmer passes it. */
async function stoppedWithACard(): Promise<{ readonly f: LeadFixture; readonly cardId: string }> {
  const f = await seedLead({
    verify: (ordinal, run) => (ordinal === 1 ? ALL.map((key) => checked(key, key === 'R1' ? 'fail' : 'pass')) : (run.keys.length === 0 ? ALL : run.keys).map((key) => checked(key, 'pass'))),
  })
  await tickUntil(f, async () => (await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, status: 'pending', situationKind: 'goal_needs_human' } })) === 1)
  const card = await prisma.supervisorDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId, status: 'pending' } })
  return { f, cardId: card.id }
}

/** Commits `file` on main in the primary checkout, once, when the first verification starts. */
function moveBaseOnce(repoPath: () => string, file: string, content: string): (start: LeadStart) => Promise<void> {
  let done = false
  return async (start) => {
    if (done || start.kind !== 'verification') return
    done = true
    writeFileSync(join(repoPath(), file), content)
    git(['add', '-A'], repoPath())
    git(['commit', '-q', '-m', 'somebody else moved main'], repoPath())
  }
}

describe('the lead flow: delivery', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(LEAD_TRUNCATE)
    resetTickObservation()
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    cleanUpLeadRepos()
    await prisma.$disconnect()
  })

  it('raises one card that says what is unproven and what each button does', async (): Promise<void> => {
    const { f, cardId } = await stoppedWithACard()
    const card = await prisma.supervisorDecision.findUniqueOrThrow({ where: { id: cardId } })
    const summary = (card.situation as { summary: string }).summary
    expect(summary).toContain('Goal v1 needs a person: it stopped because')
    expect(summary).toContain('disputed (the two verifiers disagreed): R1')
    expect(summary).toContain('Approve accepts the version as it is and merges it. Reject leaves it')
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(f.initialTip)
  })

  it('Approve accepts the version as it is and it is merged', async (): Promise<void> => {
    const { f, cardId } = await stoppedWithACard()
    expect((await approveDecision(cardId)).ok).toBe(true)
    await tickUntil(f, merged(f))
    const delivery = await leadDelivery(f)
    expect([delivery.status, delivery.stopReason, delivery.leadState]).toEqual(['accepted', 'accepted_as_is', 'delivered'])
    expect(git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')).toContain('lead-work-1.txt')
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, status: 'pending' } })).toBe(0)
  })

  it('Reject leaves the version: the branch stays, nothing is merged, and the next goal version starts', async (): Promise<void> => {
    const { f, cardId } = await stoppedWithACard()
    expect((await rejectDecision(cardId, undefined, 'not good enough')).ok).toBe(true)
    await tick(f.deps)
    await drainPumps()
    const delivery = await leadDelivery(f)
    expect([delivery.status, delivery.stopReason, delivery.leadState]).toEqual(['abandoned', 'left', 'stopped'])
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(f.initialTip)
    expect(git(['rev-parse', '--verify', `refs/heads/${delivery.integrationBranch}`], f.repoPath)).not.toBe('')
    expect((await setGoal(f.workspaceId, 'Add a health route. Add a version route. Add a status route.')).ok).toBe(true)
    await tickUntil(f, async () => (await prisma.goalDelivery.count({ where: { workspaceId: f.workspaceId, goalVersion: 2 } })) === 1)
    expect((await leadDelivery(f, 2)).leadState).toBe('building')
  })

  it('takes a base branch that moved into the work branch, verifies the merged tree in full, and merges (spec D3, clean)', async (): Promise<void> => {
    let repo = ''
    const f = await seedLead({ onStart: moveBaseOnce(() => repo, 'elsewhere.txt', 'not the lead\'s\n') })
    repo = f.repoPath
    await tickUntil(f, merged(f))

    const files = git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')
    expect(files).toEqual(expect.arrayContaining(['elsewhere.txt', 'lead-work-1.txt']))
    expect(leadTurns(f)).toHaveLength(1)
    expect(proofRuns(f).map((run) => run.verificationKeys)).toEqual([[], []])
    expect((await leadNotes(f)).some((line) => line.startsWith('base_taken: main moved; it was merged into the work branch cleanly'))).toBe(true)
    const delivery = await leadDelivery(f)
    expect(readLeadProgress(delivery.leadProgress).baseMerges).toBe(1)
    expect(git(['merge-base', '--is-ancestor', delivery.baseCommit, 'main'], f.repoPath)).toBe('')
    expect(delivery.baseCommit).not.toBe(f.initialTip)
  })

  it('gives the lead a turn when the moved base conflicts, and falls back to the hand merge when it never takes it in (spec D3, conflict)', async (): Promise<void> => {
    let repo = ''
    // The base gains the very file the lead's first turn wrote, with other content.
    const f = await seedLead({ onStart: moveBaseOnce(() => repo, 'lead-work-1.txt', 'somebody else\'s content\n') })
    repo = f.repoPath
    // The fake never merges the base, so after the bound the existing wait is what is left: a person merges by hand.
    const waitsForAHandMerge = async (): Promise<boolean> =>
      (await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'guardrail_tripped' }, select: { payload: true } })).some((row) =>
        (row.payload as { detail: string }).detail.includes('has moved since the goal was cut'),
      )
    await tickUntil(f, waitsForAHandMerge, 200)

    const baseTurns = leadTurns(f).filter((turn) => turn.leadTurn === 'base')
    expect(baseTurns).toHaveLength(LEAD_BASE_MERGES_MAX)
    expect(baseTurns[0]?.prompt).toContain('git merge main')
    expect(baseTurns[0]?.resumeSessionId).toBe('fake-session-complete')
    expect(readLeadProgress((await leadDelivery(f)).leadProgress).baseMerges).toBe(LEAD_BASE_MERGES_MAX)
    expect((await leadDelivery(f)).mergedAt).toBeNull()
    expect((await leadTaskOf(f)).status).toBe('done')
    expect(leadTurns(f)).toHaveLength(1 + LEAD_BASE_MERGES_MAX)
  })
})
```

Run `npx vitest run apps/orchestrator/test/integration/lead-delivery.test.ts` → FAIL (the two base-branch cases: the version waits for a hand merge at once, with no base turn and no clean merge).

- [ ] **Step 5: Taking the base in.** Create `apps/orchestrator/src/lead/base.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_BASE_MERGES_MAX, readLeadProgress } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { emailLocalPart } from '../tick.js'
import { gitIn } from '../worktree.js'
import { noteLead, updateLeadProgress } from './record.js'

const isAncestor = (repoPath: string, ancestor: string, of: string): Promise<boolean> =>
  gitIn(repoPath, 'merge-base', '--is-ancestor', ancestor, of).then(
    () => true,
    () => false,
  )

/**
 * Lead-flow spec D3 (plan A L15): an accepted lead-flow version whose base branch moved since the
 * cut. The final merge is a fast-forward of exactly the verified commit, so the base must be INSIDE
 * the work branch first -- and the merged tree must be verified in full.
 *
 * - `unmoved`: nothing to do here (the base did not move, the version is already in it, it was
 *   accepted as it is, or the bound is spent) -- the existing merge step decides, and for a moved
 *   base that is its "merge by hand" wait.
 * - `taken`: the base merged into the lead's branch cleanly, in the lead's worktree and under the
 *   lead's name; the work branch was fast-forwarded and `baseCommit` moved. The next pass finds the
 *   tip past the verified commit and sends the version round again (`reopenIfMovedInLock`).
 * - `turn`: the merge conflicted and was aborted; the lead's task went back with the turn `base`.
 * - `waiting`: that turn is pending or running.
 *
 * At most `LEAD_BASE_MERGES_MAX` per version, clean or not. An ended lead gets no base turn.
 */
export async function leadTakeBaseIn(deliveryId: string): Promise<'unmoved' | 'taken' | 'turn' | 'waiting'> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { workspace: { select: { repoPath: true, baseBranch: true } } } })
  if (delivery.status !== 'accepted' || delivery.mergedAt !== null || delivery.stopReason === 'accepted_as_is') return 'unmoved'
  const { repoPath, baseBranch } = delivery.workspace
  const baseTip = await gitIn(repoPath, 'rev-parse', `refs/heads/${baseBranch}`)
  if (baseTip === delivery.baseCommit) return 'unmoved'
  const workTip = await gitIn(repoPath, 'rev-parse', `refs/heads/${delivery.integrationBranch}`)
  // Already in the base branch: the merge step records it.
  if (await isAncestor(repoPath, workTip, baseTip)) return 'unmoved'

  const task = await prisma.task.findFirst({ where: { workspaceId: delivery.workspaceId, workPackage: { goalVersion: delivery.goalVersion } } })
  if (task === null || task.branch === null) return 'unmoved'
  const progress = readLeadProgress(delivery.leadProgress)
  if (task.status !== 'done') {
    if (task.activeRunId !== null || progress.leadEnded === null) return 'waiting'
    // The lead was ended before it could take the base in: its verified work stands, and a person merges by hand.
    await prisma.task.updateMany({ where: { id: task.id, activeRunId: null, status: { in: ['ready', 'rework'] } }, data: { status: 'done', integratedAt: new Date(), lastRejectionReason: null } })
    return 'unmoved'
  }
  if (progress.baseMerges >= LEAD_BASE_MERGES_MAX || progress.leadEnded !== null) return 'unmoved'

  const run = await prisma.slaveRun.findFirst({
    where: { taskId: task.id, leadTurn: { not: null }, worktreePath: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { worktreePath: true, slave: { select: { id: true, person: { select: { name: true } } } } },
  })
  if (run === null || run.worktreePath === null) return 'unmoved'
  const name = run.slave.person.name
  const email = `${emailLocalPart({ id: run.slave.id, name })}@slaveofai.local`
  const at = { workspaceId: delivery.workspaceId, version: delivery.goalVersion }

  let clean = true
  try {
    await gitIn(run.worktreePath, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'merge', '--no-stat', '--no-edit', '--no-verify', `refs/heads/${baseBranch}`)
  } catch {
    clean = false
    await gitIn(run.worktreePath, 'merge', '--abort').catch(() => {})
  }

  if (clean) {
    const tip = await gitIn(repoPath, 'rev-parse', `refs/heads/${task.branch}`)
    await gitIn(repoPath, 'update-ref', `refs/heads/${delivery.integrationBranch}`, tip, workTip)
    await prisma.goalDelivery.update({ where: { id: delivery.id }, data: { baseCommit: baseTip } })
    await updateLeadProgress(delivery.id, (p) => ({ ...p, baseMerges: p.baseMerges + 1, recheckKeys: [], failing: [] }))
    await noteLead({ ...at, kind: 'base_taken', detail: `${baseBranch} moved; it was merged into the work branch cleanly, and the merged tree is verified in full` })
    return 'taken'
  }

  const reason = `the base branch ${baseBranch} moved and no longer merges cleanly into the work branch`
  const sent = await prisma.task.updateMany({ where: { id: task.id, status: 'done' }, data: { status: 'rework', integratedAt: null, lastRejectionReason: reason } })
  if (sent.count === 0) return 'waiting'
  await updateLeadProgress(delivery.id, (p) => ({ ...p, baseMerges: p.baseMerges + 1, nextTurn: { kind: 'base', note: '' }, recheckKeys: [], failing: [] }))
  await appendEvent({ type: 'task.rework', workspaceId: delivery.workspaceId, taskId: task.id, actor: 'system', payload: { reason, attempt: task.attempt } })
  await noteLead({ ...at, kind: 'base_taken', detail: `${baseBranch} moved and conflicts with the work branch; the lead takes it in` })
  return 'turn'
}
```

In `apps/orchestrator/src/lead/conclude.ts`, in `settleLeadWork`, directly after the fast-forward block (`if (tip !== workTip) { … }`), add:

```ts
  // Plan A L15: a turn that took the base branch in puts the version on top of it -- `baseCommit`
  // follows, so the final merge is a fast-forward again and the verifier's diff is the goal's own.
  const baseTip = await gitIn(repoPath, 'rev-parse', `refs/heads/${task.workspace.baseBranch}`).catch(() => null)
  if (baseTip !== null && baseTip !== delivery.baseCommit) {
    const inside = await gitIn(repoPath, 'merge-base', '--is-ancestor', baseTip, tip).then(
      () => true,
      () => false,
    )
    if (inside) await prisma.goalDelivery.update({ where: { id: delivery.id }, data: { baseCommit: baseTip } })
  }
```

In `apps/orchestrator/src/goal.ts` import `leadTakeBaseIn` from `'./lead/base.js'` and change, in `advanceDelivery`,

```ts
  if (workspace.autoMerge) {
    await mergeGoalIntoBase(delivery.id)
  } else {
```

to

```ts
  if (workspace.autoMerge) {
    // Lead flow (spec D3, plan A L15): a base branch that moved is taken into the work branch first
    // -- by a clean merge, or by a turn for the lead -- and the merged tree is verified again.
    // `unmoved` leaves the merge step below to decide, as for every other workspace.
    if (workspace.flow === 'lead' && (await leadTakeBaseIn(delivery.id)) !== 'unmoved') return
    await mergeGoalIntoBase(delivery.id)
  } else {
```

- [ ] **Step 6: Run.** `npx tsc --build && npx vitest run packages/control/test/integration/lead-card.test.ts`, then `npx vitest run apps/orchestrator/test/integration/lead-delivery.test.ts` → PASS. Then one file at a time: `…/lead-proof.test.ts`, `…/lead-limits.test.ts`, `…/goal-pass.test.ts`, `…/supervisor.test.ts`, and `npx vitest run packages/control/test/integration -t "approveDecision|rejectDecision"` → PASS. `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add packages/control/src/lead/card.ts packages/control/src/index.ts packages/control/src/supervisor.ts packages/control/test/integration/lead-card.test.ts apps/orchestrator/src/lead apps/orchestrator/src/goal.ts apps/orchestrator/test/integration/lead-delivery.test.ts
git commit -m "feat(lead): one card for a version that is not all proven, with accept-as-is and leave; a moved base branch is taken in and verified again

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: A whole goal version through the lead flow, and the packages flow unchanged

**Files:**
- Create: `apps/orchestrator/test/integration/lead-e2e.test.ts`
- Modify: `apps/orchestrator/test/integration/conductor-e2e.test.ts` (one case, after "takes a conducted goal from requirements to a reported package…")

**Interfaces:**
- Consumes: everything Tasks 1 to 10 built, through `tick`, `reconcileOrphans`, `leadStatus`, `loadGoalReport` and the shared seed. No product code changes in this task; a failure here is a defect in an earlier task and is fixed there.

- [ ] **Step 1: The end-to-end test.** Create `apps/orchestrator/test/integration/lead-e2e.test.ts`:

```ts
/**
 * Lead-flow plan A, end to end through nothing but `tick`: a project in the lead flow takes a goal
 * from its requirements to the base branch. One lead session builds it with a subordinate from the
 * roster and records a decision; the first full verification fails one requirement and the
 * confirmer agrees; the evidence goes back into the lead's SAME session; the next round checks the
 * smoke and only what failed; a full verification on the final commit passes; the version is
 * merged. No review, no report block, no hand-off, no question, no card.
 */
import { leadStatus, loadGoalReport } from '@slave-of-ai/control'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE } from '@slave-of-ai/db'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTickObservation } from '../../src/sweep.js'
import { drainPumps } from '../../src/tick.js'
import { LEAD_TRUNCATE, base64, checked, cleanUpLeadRepos, git, leadDelivery, leadNotes, leadTaskOf, merged, seedLead, tickUntil } from './lead-helpers.js'

const ALL = ['R1', 'R2', 'RUN']

describe('the lead flow, end to end', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(LEAD_TRUNCATE)
    resetTickObservation()
  })

  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  afterAll(async (): Promise<void> => {
    cleanUpLeadRepos()
    await prisma.$disconnect()
  })

  it('builds, fails one requirement, confirms it, reworks it in the same session, verifies in full and merges', async (): Promise<void> => {
    const ada = await prisma.person.create({ data: { name: 'Ada Backend', profile: 'You build APIs.' } })
    const decisions = base64('## Database\nSQLite, one file: no server to run.\n')
    const f = await seedLead({
      budgetUsd: 40,
      timeLimitMs: 120 * 60_000,
      roster: [ada.id],
      // The rework resumes the session: its result line reports the running total, 6.00 + 1.50 (C2).
      leadArgs: (ordinal) => (ordinal === 1 ? ['--subordinate', 'ada-backend', '--extra-file-base64', `docs/DECISIONS.md:${decisions}`, '--result-patch-base64', base64({ total_cost_usd: 6 })] : ['--result-patch-base64', base64({ total_cost_usd: 7.5 })]),
      // Run 1 (full) fails R2; run 2 (the confirmer) fails it too; run 3 (partial) and run 4 (full) pass.
      verify: (ordinal, run) => (run.keys.length === 0 ? ALL : run.keys).map((key) => checked(key, ordinal <= 2 && key === 'R2' ? 'fail' : 'pass')),
    })
    await tickUntil(f, merged(f), 120)

    // One model call for the plan stage: the requirement extraction. No size decision was bought.
    expect(await prisma.conductorCall.findMany({ where: { workspaceId: f.workspaceId }, select: { stage: true, outcome: true } })).toEqual([{ stage: 'requirements', outcome: 'ok' }])
    expect(f.others).toEqual([])

    // One lead session, two turns; the rework went into the same session with the evidence.
    const turns = f.starts.filter((s) => s.kind === 'implementation')
    expect(turns.map((t) => [t.leadTurn, t.resumeSessionId])).toEqual([['build', null], ['rework', 'fake-session-complete']])
    expect(turns[1]?.prompt).toContain('R2: GET /version prints the version')
    expect(turns[1]?.prompt).toContain('404 Not Found')
    expect(turns[0]?.extras).toMatchObject({ maxBudgetUsd: 25.6, keepAliveForSubordinates: true })
    expect(typeof turns[0]?.extras.sessionDefinitions).toBe('string')
    expect((await leadTaskOf(f)).attempt).toBe(0)

    // Proof: full, confirm, partial, full -- by the verifier, the confirmer, the verifier, the verifier.
    const proof = f.starts.filter((s) => s.kind === 'verification')
    expect(proof.map((p) => [p.confirms, p.verificationKeys])).toEqual([[false, []], [true, ['R2']], [false, ['R2']], [false, []]])

    // Delivered: merged by a fast-forward to the verified commit.
    const delivery = await leadDelivery(f)
    expect([delivery.status, delivery.leadState, delivery.stopReason]).toEqual(['accepted', 'delivered', 'proven'])
    expect(git(['rev-parse', 'main'], f.repoPath)).toBe(delivery.verifiedCommit)
    expect(git(['ls-tree', '-r', '--name-only', 'main'], f.repoPath).split('\n')).toEqual(expect.arrayContaining(['lead-work-1.txt', 'lead-work-2.txt', 'docs/DECISIONS.md']))

    // On record: the lead's decision, the subordinate by person, the turns, the state word's path.
    expect(await prisma.goalDecision.findMany({ where: { workspaceId: f.workspaceId }, select: { title: true, source: true } })).toEqual([{ title: 'Database', source: 'lead' }])
    const status = await leadStatus(f.workspaceId)
    if (!status.ok) throw new Error('lead-status was refused')
    expect(status.value.subordinates).toEqual([{ name: 'ada-backend', personId: ada.id, calls: 1, running: 0 }])
    expect(status.value.spend).toMatchObject({ leadUsd: 7.5 })
    expect((await leadNotes(f)).filter((line) => line.startsWith('turn:'))).toEqual(['turn: turn 1 (build): a new session was started', 'turn: turn 2 (rework): the same session was resumed'])
    const states = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_lead_state' }, orderBy: { seq: 'asc' }, select: { payload: true } })
    expect(states.map((row) => (row.payload as { state: string }).state)).toEqual(['building', 'proving', 'building', 'proving', 'delivered'])

    // What the lead flow switched off never happened, and nobody was asked anything.
    const types = new Set((await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId }, select: { type: true } })).map((row) => DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type))
    for (const absent of ['task.review_started', 'task.review_approved', 'task.verifying', 'task.ownership_violated', 'workspace.package_handed_off', 'slave.message_sent', 'supervisor.proposed', 'guardrail.tripped']) {
      expect(types.has(absent), absent).toBe(false)
    }
    expect(await prisma.supervisorDecision.count({ where: { workspaceId: f.workspaceId, situationKind: { not: 'conduct' } } })).toBe(0)
    expect(await prisma.runReport.count()).toBe(0)
    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBe(0)

    // The existing goal report still reads a lead-flow version.
    const report = await loadGoalReport(f.workspaceId, 1)
    expect(report.ok).toBe(true)
  })
})
```

Run `npx vitest run apps/orchestrator/test/integration/lead-e2e.test.ts` → PASS. If an assertion fails, the defect is in the task that owns that behaviour (the comment above each block names it by what it checks); fix it there, with a test in that task's file, and re-run. One assertion to check against the code rather than adjust blindly: if `loadGoalReport` refuses a version whose package has no catalogue persona, make its persona lookup tolerant where it reads `templateName.get(pkg.templateId)` (`packages/control/src/goalReport.ts:259-282` already falls back to `null`) and record what was changed in the commit message.

- [ ] **Step 2: The packages flow, unchanged.** In `apps/orchestrator/test/integration/conductor-e2e.test.ts`, import `readSpawnExtras` from `@slave-of-ai/providers`, and add after the first case:

```ts
  it('the packages flow still reviews: a conducted goal in a project that is not in the lead flow takes none of the lead flow\'s paths', async (): Promise<void> => {
    const f = await seed()
    await tickUntil(f, merged(f, 1))

    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })
    expect(workspace.flow).toBe('packages')
    // The size decision was the model's, the package was reviewed, and its branch went through the merge pass.
    expect((await prisma.conductorCall.findMany({ where: { workspaceId: f.workspaceId }, orderBy: { createdAt: 'asc' }, select: { stage: true } })).map((c) => c.stage)).toEqual(['requirements', 'conduct'])
    expect(await prisma.slaveRun.count({ where: { kind: 'review' } })).toBeGreaterThan(0)
    const types = (await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId }, select: { type: true } })).map((row) => row.type)
    for (const present of ['task_verify_passed', 'task_review_started', 'task_review_approved']) expect(types).toContain(present)
    for (const absent of ['workspace_lead_state', 'workspace_lead_noted']) expect(types).not.toContain(absent)
    expect(await prisma.runReport.count()).toBe(1)

    // No run was a lead turn, a confirmation or a partial round, and none was spawned with the lead's extras.
    const runs = await prisma.slaveRun.findMany({ select: { leadTurn: true, leadResumed: true, confirmsRunId: true, verificationKeys: true } })
    expect(runs.every((run) => run.leadTurn === null && !run.leadResumed && run.confirmsRunId === null && run.verificationKeys.length === 0)).toBe(true)
    for (const start of f.starts) expect(readSpawnExtras(start.runDir)).toEqual({})
    for (const start of f.starts) expect(start.prompt).not.toContain('you are the lead of this goal')

    const row = await delivery(f, 1)
    expect([row?.leadState, row?.stopReason, row?.leadProgress]).toEqual([null, null, null])
  })
```

Run `npx vitest run apps/orchestrator/test/integration/conductor-e2e.test.ts` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/orchestrator/test/integration/lead-e2e.test.ts apps/orchestrator/test/integration/conductor-e2e.test.ts
git commit -m "test(lead): a goal version goes through the lead flow end to end, and the packages flow still reviews

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Verification

**Files:** none created. Fixes found here go into the task that owns the code, as their own commits.

- [ ] **Step 1: Typecheck and the vocabulary.** `npm run typecheck` → clean. `node scripts/gate-m26-vocabulary.mjs` → `PASS`. `git grep -nE "agency-agent[s]"` prints nothing.

- [ ] **Step 2: The whole suite, once, in the background.** With `set -a; . ./.env; set +a; export DATABASE_URL=$TEST_DATABASE_URL`, no daemon running and no other vitest process: `npx tsc --build && npx vitest run > /tmp/lead-flow-a-suite.log 2>&1` in the background with a 600 s budget; wait on the log's last line, not on the process name. Expected: every file passes. If `apps/orchestrator/test/integration/cli.test.ts`'s llm-decision row-count case fails, re-run that file alone before believing it (a known flake under load).

- [ ] **Step 3: The drift check and the web build.** With `DATABASE_URL` exported to the test DB: `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` prints `No difference detected`. `npm run web:build` (no `next dev` running) → succeeds; `rm -rf apps/web/.next`.

- [ ] **Step 4: The gates that matter.** Host daemon stopped; `systemd-inhibit --what=sleep:idle`; `DATABASE_URL="$GATE_DATABASE_URL"`; the fake-CLI env exactly as `.github/workflows/ci.yml` sets it (`SLAVEOFAI_CLAUDE_BIN` / `SLAVEOFAI_CURSOR_BIN` from `scripts/gate-fakes`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`); `CHROMIUM_PATH=/home/meren/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome` for the gates that read a page. Run, one at a time, by their `npm run gate:…` names in `package.json`:
  - `npm run gate:m26-vocabulary` and `npm run gate:m56a-provider-contract` (stage 2's sixteen goldens with the re-pinned eight and 39 names, stage 12's `LANE_BY_TYPE` 80 and 25 / 25, the hook-plane digests unchanged, the schema drift check);
  - `npm run gate:m18-skill-and-teeth` (the permission matrix: the vocabulary gained a name);
  - `npm run gate:m12-providers` and `npm run gate:m13-runtime` (start, pause and resume through the adapter: `spawnRun` and `resume` gained arguments that are absent without the extras file);
  - `npm run gate:m35-pipeline-honesty` (verify-advance), `npm run gate:m37-run-context` (the manifest kinds), `npm run gate:m38-supervisor` (the Supervisor pass and a card's approval);
  - `npm run gate:m51-breaker` and `npm run gate:h9-restart-chaos` (the sweep's comparisons and the orphan path were read or touched).
  No gate drives a conducted goal end to end today; Tasks 6 to 11's integration tests are that coverage for both flows, and Plan B adds the lead flow's own gate.
  Expected: all green. Known red on main and not regressions: m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58. m52 (the broker) reads the permission vocabulary this plan changed: run it too, on this branch and on a second worktree of `5e165508`, and report "same failure as main" or the difference.

- [ ] **Step 5: Read the branch as a reviewer would.** `git log --oneline 19c85b9e..HEAD` shows one commit per task and the plan's own. `git diff 19c85b9e..HEAD --stat -- scripts/pause-gate.sh scripts/cursor-shell-gate.sh scripts/tool-result-tap.sh scripts/lib` prints nothing. Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (`git log --format=%B 19c85b9e..HEAD | grep -c "Claude Opus 5.5"` equals the commit count of this build (the spec and plan commits carry the earlier trailer)).

- [ ] **Step 6: Report.** To the controller: the suite's file and test counts, each gate's result, any open point below that the build settled or sharpened, and what Plan B can now rely on (the list in this plan's header).

---

## Open points for the controller

1. **A resumed session's cost (L4).** *Answered: M and C2 -- the running total.* ADR 0001 Q3 is unresolved (`docs/decisions/0001-pause-semantics.md:169`): whether `total_cost_usd` of `claude -p --resume` is that invocation's or the session's running total. `pump.ts:1475` REPLACES `SlaveRun.costUsd`, and this plan gives each turn its own row and sums them (`goalSpend`). If the figure is cumulative, a goal's spend is over-counted by every earlier turn of the session; if it is per invocation, a PAUSED turn resumed on its own row loses its pre-pause cost. One measured pair of result lines settles both; until then the plan errs towards stopping early.
2. **`--max-budget-usd` (L6).** *Answered: M and C3 -- per process from zero; `budget_exhausted`.* Not passed anywhere today (`packages/providers/src/claude/flags.ts:38-56`), so nothing in the repository has measured: whether the cap counts subordinate sessions; what the result line's `subtype` / `terminal_reason` read when it is hit (`isBudgetCapReason` matches `max_budget`); whether `total_cost_usd` is on that line. One cheap paid call (`claude -p "count to three" --max-budget-usd 0.01 --output-format stream-json --verbose`) before Task 8 is built. The 2026-10-04 run is said to show `modelUsage` carrying every model's cost; the capture is not in `/home/meren/slaveofai-logs/solo-comparison-2026-10-04/`, so `total_cost_usd` including subordinates is taken on that word.
3. **The lead's stream while a subordinate works (L8).** *Answered: C1 -- `parent_tool_use_id` is set on the subordinate's lines.* The stall rule assumes the lead's stream carries the subordinate's lines (the recorded fixtures show `parent_tool_use_id` on every line, always null: `packages/providers/test/fixtures/complete.ndjson`). If a subordinate's work is silent on the parent stream, a subordinate working for more than 30 minutes restarts the lead. Also unmeasured: whether a background subordinate keeps the stream alive under `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`.
4. **A subscription limit's shape (L9).** *C4 (builder's ruling): unchanged.* `isProviderRefusal` is `terminalReason.startsWith('api_error')` (`packages/providers/src/types.ts`). A usage limit that ends a run some other way is charged as a worker failure, and three end the lead. `rate_limit_event` lines are ignored by the parser (`packages/providers/src/claude/stream.ts:53`); the reset time they may carry is not read.
5. **The default model (L2).** *Answered: C5 -- no default model; no `--model` flag.* (Was: `LEAD_DEFAULT_MODEL = 'opus'` as a guess at "the most capable available".)
6. **The lead cannot read the web.** *C8 (builder's ruling): not granted in plan A.* The implementation baseline grants `read_repo`, `write_repo`, `run_commands` (`packages/domain/src/permission/kinds.ts`, `BASELINE_GRANTS`); `WebFetch`, `WebSearch` and every `mcp__*` tool are denied to the lead and its subordinates. Granting `network_fetch` to the lead seat is one `SlavePermission` row in `ensureLeadSeats`; the plan leaves it out because the spec does not say.
7. **A permission-mode denial fails a whole turn.** *Answered: C6 -- the lead continues in the same session, told what was refused, uncharged up to `LEAD_DENIAL_CONTINUES_MAX`.* `pump.ts:1415` fails a run that finished cleanly with a denied call unless it was a matrix or question denial. For a 45-minute lead turn that is one attempt and a `continue` turn; the work is committed and nothing is lost, but it is a wasted spawn. Not changed here.
8. *C9 (builder's ruling): as written.* **`retry-goal` on a stopped lead-flow version** verifies again but cannot give an ended lead another turn (`leadEnded` stays set). "Add budget and continue" is Plan B's decision; until then the remedy text of the card names only Approve and Reject.
9. *Answered: C2 (a later total of the same session covers it) and C7 ("at least $X").* **A cancelled or crashed turn reports no cost** (`goalSpend.unmeasuredRuns`). The budget cannot see what such a turn spent; a lead that stalls repeatedly can overspend by the cost of the stalled turns, bounded by three attempts.
10. *C9 (builder's ruling): as written; Task 11 proves `loadGoalReport` reads it.* **`WorkPackage.templateId = 'lead'`** names no `SlaveTemplate`. The two readers found (`packages/control/src/goalReport.ts:259-282`, `apps/orchestrator/src/verification.ts:321-331`) tolerate it; a reader added since the survey may not.
