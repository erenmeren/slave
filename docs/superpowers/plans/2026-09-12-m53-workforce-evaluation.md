# M53 Workforce Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The organisation stops guessing which of its workers is any good. Every run that finishes leaves one row of raw fact behind — who, on what model, in which repository, in which domains; did it verify first try, was it sent back, was it rejected in review, did the work actually reach the base branch, how many times did a person have to step in, how long, how much, and where that money figure came from. Nothing is scored. A profile's record and a model's record are two different tables because they are two different questions, and a record thin enough to be luck says "Insufficient evidence" rather than a percentage. The Supervisor stops picking whoever sorts first: it ranks capability fit, then permission, then what a person asked for, then who is free, then the record, then cost and time — in that order, in one pure function, with a reason trail. A person's choice beats the system's opinion and never beats the system's wall.

**Architecture:** One FACT TABLE and no rollup. `EvidenceRecord` is one row per concluded `SlaveRun`, keyed on four dimensions (profile, model, repository, domain) with `workspaceId` riding beside them as a column, written by exactly one function — `recordRunEvidence` in `packages/control/src/evidence.ts` — at the run's terminal transition, and SETTLED by that same function from four verdict sites. Everything a surface shows is a `GROUP BY` over that table; nothing is stored twice. The PURE half lives in `packages/domain`: `evidence/derive.ts` turns counts into columns (attempt, first-pass, domains, recoveries, provenance) with no I/O at all, and `capability/rank.ts` holds `rankCandidates` — a comparator chain over six named steps plus one named tie-break, producing no number of any kind, which is what "no universal score" means when it is code rather than a promise. `formTeam` calls it WITHIN each `TeamSource` tier; the tier order is M47's and does not move. The Supervisor gains no situation and no action, `decide()` is not imported by anything in this milestone, and `/analytics`' raw `SUM(costUsd)` and its per-slave table are deleted in favour of a surface where money carries M51's three provenance words.

**Tech Stack:** TypeScript monorepo, Next.js 15 App Router + React 19, Tailwind v4 (configured by `@theme inline` inside `apps/web/src/app/globals.css` — there is no `tailwind.config.*`), zod, vitest (two projects: `unit`, `integration`), Prisma 7 + Postgres (:5433), plain-`node` `.mjs` gates driving `playwright-core`, bash 5 hook scripts fed on stdin.

**Spec:** `docs/superpowers/specs/2026-09-12-m53-workforce-evaluation-design.md` (rulings R1–R13; §2 surfaces; §3 gate; §4 out of scope; §5 errata; §6 carried backlog). Its parents are `docs/superpowers/specs/2026-09-10-roadmap-m44-m56.md` (row M53 at line 45, and lines 19-23: extensions named as such), `docs/superpowers/specs/2026-09-12-m52-capability-broker-design.md` (`grantsFor`, `BASELINE_GRANTS`, the nine event sites, the run-directory rule), `docs/decisions/0003-*` (the one event write gate) and `docs/ia.md` (rule 2, nothing is removed only moved; rule 3, labels never keys; rule 4, real is not simulated). **This is the milestone that discharges the line every predecessor carries: nothing in M47, M48, M49, M50, M51 or M52 ranked by evidence, and after this one something does.**

Plan-time errata, every one read out of the code and baked into the tasks below. The long form, with file and line evidence, is in the session notes (`m53-plan-notes.md`); each is also to be appended to the spec's §5 during execution.

- **E1 (amends R3 and R4) — "written once and SETTLED once" means each JUDGEMENT COLUMN settles once, and `settledAt` records the first of them.** Three columns settle from three different moments — `verifiedFirstPass` at the verify verdict, `reviewRejected` at the review verdict, `integrated` at the merge or the confirmation, which may be days later (`confirmIntegration`, `packages/control/src/integration.ts:20`) — so one `settledAt` cannot mean "the settle". The property R3 actually asks for is enforced in SQL rather than by convention: each judgement column is written by an `updateMany` conditioned on THAT COLUMN being `null`, and `settledAt` by one conditioned on `settledAt: null`. A verdict therefore moves a column from null exactly once and can never move it back, and a replayed conclusion (which `concludeReview` legitimately allows, `review.ts:46-60`) writes nothing.
- **E2 (amends R4) — `implementerOf` returns a `slaveId` and an `EvidenceRecord` is keyed on a `runId`, so the settle sites need a resolver.** `implementerOf(taskId, hint)` (`apps/orchestrator/src/verify.ts:106-118`) answers "who did the work", not "which run". `packages/control/src/evidence.ts` therefore exports `settleTaskEvidence(taskId, settle)`, which resolves the task's newest TERMINAL `implementation` run — the same `findFirst({ where: { taskId, kind: 'implementation' }, orderBy: { startedAt: 'desc' } })` that `merge.ts:264-268`'s `latestImpl` and `implementerOf`'s own fallback already make — and calls `recordRunEvidence` with it. One derivation, two entry points. `verify.ts`'s `advance` is the exception and calls `recordRunEvidence` directly: it already holds the implementation run's id in `runId = task.activeRunId` (`verify.ts:527`), read before the claim is cleared.
- **E3 (amends R13 and R9) — the boundary refusal is `run_not_found`, and `invalid_staffing_preference` stays the ONE new kind.** R9 says its refusal is "the one new `ControlRefusal` kind"; R13 asks `recordRunEvidence` to return "the `simulation` refusal", which does not exist in the union and would be a second. The schema makes them one fact: `Slave.teamId` and `Team.workspaceId` are both NOT NULL with foreign keys, so "this run's `Workspace` cannot be resolved" is exactly "there is no such `SlaveRun`". `run_not_found { runId }` is that sentence, it is already in all three homes, and it answers 404 by `refusalStatus`'s suffix rule. The gate REACHES it by handing `recordRunEvidence` a real `SimulationRun.id` — which proves the boundary instead of describing it, and is a stronger stage than the unreachable arm would have been.
- **E4 (amends R3) — `EvidenceRecord` carries ONE relation, to `Workspace`, and none to `SlaveRun`, `Slave` or `Task`.** Evidence must OUTLIVE the run, the worker and the task — `profileName` is a snapshot for exactly that reason (R1) — so a foreign key to any of them would cascade the history away the first time an operator ran `delete-slave`. The `Workspace` relation is not a lifecycle rule: nothing in this product deletes a `Workspace` (no `workspace.delete` or `workspace.deleteMany` anywhere in `packages/control/src`, `apps/orchestrator/src` or `apps/web/src`). It is what makes `db:seed`'s `TRUNCATE … RESTART IDENTITY CASCADE` (`packages/db/src/seed.ts:45`) reach the two new tables without adding two names to a list that has never carried `Credential` or `BrokerBinding` either.
- **E5 (amends R3) — the GIN index must be expressible in `schema.prisma` or it must not exist.** The spec's fallback ("the migration writes `CREATE INDEX … USING GIN` by hand and the model carries no `@@index` for it") breaks this milestone's own diff proof: `npx prisma migrate diff --from-config-datasource --to-schema` computes the DATABASE-to-schema delta, so an index in the database that the schema does not name comes back as a `DROP INDEX` and "No difference detected" fails. Task 1 writes `@@index([domains(ops: ArrayOps)], type: Gin)`, runs `npx prisma validate` BEFORE generating the migration, and if Prisma 7 rejects the form the index is not created at all and becomes carried backlog. The containment predicate then runs over rows the `workspaceId` and composite indexes already narrow — one row per run, which is the same volume `perSlaveRunAggregates` scans unindexed today (`apps/web/src/server/analytics.ts:92-115`).
- **E6 (amends R3 and R12) — ONE aggregation, in `packages/control/src/evidence.ts`; `apps/web/src/server/evidence.ts` is the VIEW over it.** R3 puts "the aggregation read" in two modules, which is the exact shape M52 erratum E12 refused for `resolveGrants`: two `GROUP BY`s over one table would eventually disagree in front of a person about how many runs a profile has attempted, and the disagreement would surface on the page. `evidenceByProfile` / `evidenceByModel` / `evidenceForProfiles` live in control (Prisma, `$queryRaw`, server-only) and the page builder calls them exactly as `buildOrganization` calls `loadSupervisorWorld` (`apps/web/src/server/organization.ts:84-95`). The web module owns the LABELS, the sort, the `Insufficient evidence` substitution and the testids, and contains no SQL.
- **E7 (amends R8, R9, R10 and §2) — the world needs THREE new fields, and only one of them is `deniedKinds`.** R1's profile key is `template:<SlaveTemplate.id>` or `slave:<Slave.id>` and R9's preference names a `templateId` and a `model`, so `SupervisorSlave` gains `hiredFromTemplateId: string | null` and `model: string | null` beside `deniedKinds`, and `SupervisorCompanyWorker` gains `templateId: string` (`CompanySlave.templateId` is NOT NULL, `schema.prisma:508`, so every company worker has one). Without them `teamPlanOf` cannot say which candidate a preference names nor which record belongs to which candidate, and `rankCandidates` would be handed a world that cannot answer its own questions. All three ride on `findMany`s the loader already makes, through nested `select`s.
- **E8 (amends R3) — the evidence loader's gate is `asksForCapabilities`, not "the world has a missing capability".** "Missing" is `formTeam`'s OUTPUT, and `formTeam` runs on the world the loader is still building — the gate the ruling asks for cannot be evaluated where it would have to be. The bound the ruling actually wanted is the CANDIDATE SET, and that is what `WHERE "profileKey" = ANY($1)` over roster ∪ company ∪ catalog gives: one grouped read, an index probe on `(profileKey, model, repositoryKey)`, and no read at all on a project whose board asks for no capability — the same `asksForCapabilities` predicate `company` and `catalog` already wait on (`packages/control/src/supervisorWorld.ts:757-759`).
- **E9 (amends R8 and R11) — `RankedCandidate` names the STEP that separated it from the next candidate, and the total order needs a seventh named step.** R8 gives six steps and a final tie-break on the candidate id; R11 forbids any `score`, `rating` or `rank` VALUE on the result. A result that names which step decided each adjacent pair therefore needs a word for "nothing separated them but their identities": `identity`. `RANK_STEPS` is the seven, a test pins the first six as the roadmap's own order and pins `identity` last, and a second test asserts that no property of `RankedCandidate` or `RankCandidate` is a number that combines two dimensions.
- **E10 (amends R8) — the cost step's rationale names the COMPARISON and never the figures.** `formatUsd` (`apps/web/src/lib/realMoney.ts:26`) owns every rendering of real money in this product — `—` for null, `<$0.01` for a figure that rounds away — `packages/domain` may not import `apps/web`, and a second `$${n.toFixed(2)}` inside the ranker would be the second money formatter M51 R5 spent a milestone removing. The sentence reads "…'s median run has cost less"; the figures live on the Evidence tab, where `formatUsd` renders them with their provenance word beside them.
- **E11 (amends R12 and §3 stage 12) — `gate:m16-chrome` check 5 is a moved pin the spec does not name, and it is load-bearing.** It asserts that a `—` success cell on `/analytics`'s per-slave table pairs with a `progress-bar` carrying no `aria-valuenow` (`scripts/gate-m16-chrome.mjs:388-410`), and R12 deletes that table out from under it. The wiring moves with the surface it measured: check 5 re-points at `/workforce?tab=evidence` and asserts the same thing in the stronger form M53 makes true — a rate at or above `EVIDENCE_MIN_SAMPLE` renders a `progress-bar` WITH `aria-valuenow`, and a rate below it renders the words `Insufficient evidence` and NO bar at all. R11's "not a greyed percentage" is satisfied by the bar's ABSENCE, which is a thing a browser can measure.
- **E12 (amends R12) — `apps/web/test/integration/analytics.test.ts` retires with the computation too.** The spec names `analytics-page.test.tsx` and `analytics-aggregates.test.ts`; the third file has ten cases reading `snapshot.perSlave` (`:130-182`) and would fail the BUILD the moment `SlavePerformanceRow` is deleted, because its expressions are typed. Named here so the task that deletes the field deletes its pins in the same commit rather than discovering them in the ladder.
- **E13 (amends R9) — the 59th event pays all NINE sites in Task 1, the card included.** `ACTIVITY_CARDS` is `satisfies Record<DomainEventType, …>` (`apps/web/src/components/activity/cards.tsx:1337-1396`) and `TYPES_BY_KIND` is `satisfies Record<ActivityKind, readonly DomainEventType[]>` with a runtime completeness case (`apps/web/test/activityFilters.test.ts:9-11`), so an event type added in Task 1 and carded in Task 5 would leave four tasks unable to typecheck. M52 split it — its Task 1 registered three cards and its Task 5 wrote their copy — because three cards is a page of copy. M53 does not split it: one card with four words in it is not worth a task boundary, and Task 1 already runs `web:build`.
- **E14 (amends R6 and R3) — the moved `COST_PROVENANCE_WORD` is what pins the new enum, so the move is load-bearing twice.** R3 wants `EvidenceCostProvenance` "pinned by a test asserting its members equal `CostProvenance`'s three", and `CostProvenance` is a TYPE — there is no value list of it anywhere in the tree. The one total `Record` over it is `COST_PROVENANCE_WORD`, which R6 moves into `packages/domain/src/guardrails/spend.ts` beside the type. `packages/db/test/integration/enum-parity.test.ts` therefore asserts `enumValues('EvidenceCostProvenance')` equals `Object.keys(COST_PROVENANCE_WORD).sort()`, which is where every other enum parity assertion in this repository lives. `provenanceWordFor` stays in `TaskDetailPanel.tsx` and imports the table.
- **E15 (amends R7) — idempotence is a property of the WRITER, and the backfill adds nothing to guarantee it.** Stage 5 asks for byte-equal rows across two passes, `recordedAt` included. That holds because `recordRunEvidence`'s write half is an `upsert` whose `update` branch touches only the dimension keys and the run-local measurements — every one of them a pure function of stored rows and stored events — and never `recordedAt`, never `settledAt`, and never a judgement column. The script is then a bounded cursor walk that calls it. Said here so the script does not grow a "skip rows that exist" branch, which would make the second pass prove nothing.
- **E16 (amends §3's fixture) — `--review-fixture` reaches a run through the DAEMON's environment, so the two profiles are two daemon PHASES over one workspace.** `SLAVEOFAI_CLAUDE_ARGS` is set once per spawned orchestrator (`scripts/gate-m37-run-context.mjs:417`, `gate-m31b-software-sector.mjs:252`) and rides through as `extraArgs` on every spawn, so two workers under one daemon cannot have different review verdicts. `gate:m36-messaging`'s own "stops the orchestrator and starts it again mid-scenario" (`README.md:860`) is the precedent. Each phase leaves exactly one worker dispatchable (`set-runtime-roles` empties the other's), carries its own `--review-fixture`, and seeds `fake-verify.sh`'s state file for the runs it is about to produce. The workspace, the tasks, the templates and every `EvidenceRecord` are one set throughout, which is what stages 7, 8 and 9 need.
- **E17 (amends §2 and the spec's global constraints) — the migration directory is `20260913090000_m53_evidence`.** The spec names `20260912210000_m53_evidence` in two places. Prisma applies migrations in directory-name order, so the stamp IS the ordering and not a label, and the later one sorts after every migration M52 left on this branch (`20260912180000_m52_broker`) and after any fix-round migration M52 still adds on the day it lands.
- **E18 (amends R12) — "exactly six KPI tiles" is four sentences and two tests, not one array.** `AnalyticsSnapshot.kpis`' own contract (`apps/web/src/server/analytics.ts:62`), `buildAnalytics`' module docstring (`:19`), `KpiStrip`'s docstring and its `xl:grid-cols-6` class (`apps/web/src/components/analytics/KpiStrip.tsx:3,15`), `AnalyticsClient`'s page docstring (`:19`) and the comment at `:75` all say six, `apps/web/test/analytics-page.test.tsx:63-67` asserts six and reads `kpi-note-Spend`, and `ProjectsClient.tsx:305` renders the same array on the Projects home. Removing the Spend tile moves all of them together, in one commit, and `scripts/gate-m44-ux-foundation.mjs:666-668` PRINTS the tile count rather than asserting it — so a stale copy would not fail, which is exactly why it is named here.
- **E19 (amends R8 and R11) — the spec's `RankReason` type is never defined, and `RankedCandidate.reason` is a `string`.** R8's result shape names a `RankReason` that appears nowhere in the spec, in the roadmap, or in the tree: it has no members, no label table and no parity pin, so a `Record<RankReason, string>` could not be written and a test could not assert one. The plan's own shape stands — `RankedCandidate` is `{ candidate, decidedBy: RankStep | null, reason: string }`, where `decidedBy` is the closed, labelled step name (erratum E9) and `reason` is the sentence DERIVED from that step and from facts both candidates carry. The closed vocabulary R8 wanted is therefore `RANK_STEPS` / `RANK_STEP_LABEL`, which is pinned; the sentence is prose built from it, never a key a surface has to translate, and `rank.test.ts` holds it to naming both candidates and to carrying no currency figure (erratum E10).
- **E20 (amends R8 and R11) — within step 5 and step 6, a MEASURED figure beats an unmeasured or insufficient one, and unmeasured ties only with unmeasured.** The plan's comparator SKIPPED a dimension whenever either side was `null` (a denominator below `EVIDENCE_MIN_SAMPLE`, a record that does not exist, an unmeasured median). That makes "these two tie" non-transitive — a thin record ties with everything while the records it sits between do not tie with each other — so `toSorted` over it is undefined behaviour and the function is not the total order R8 and R11 both rest on. Measured: three otherwise-identical candidates with medians $5, unmeasured and $1 sorted to [$5, unmeasured, $1] from one input order and to two different orders from the other two, and at step 5 a 10 % first-pass candidate could rank above a 90 % one. The rule is therefore TWO CLASSES per dimension: measured first, ordered among themselves by the value (`higherWins` picks the direction, and it orders only that class); unmeasured after, tied with each other. Each dimension is then a total preorder, the lexicographic chain over them is transitive, and `identity` breaks the last tie on a unique id — so the same world yields the same order from every input permutation, which `rank.test.ts` asserts by walking all 24 of a four-candidate world. **This introduces no score:** nothing is added, weighted or combined across dimensions and no number reaches the result. Steps 1–4 are untouched — a candidate with no record at all still wins on fit, permission, preference and availability, which is what keeps a new hire staffable. Two claims the plan's own text made are only now true: `rankCandidates` is "pure, total, deterministic", and "unmeasured is not cheap" — the latter used to be a TIE, which let an unmeasured candidate be sorted anywhere, including above a cheaper measured one.
- **E21 (amends R8, R9 and the labels-never-keys constraint) — `RankContext` carries `capabilityLabel` beside `capability`, and the preference rationale says the word.** The plan's `reasonFor` rendered `somebody chose ${above.name} for ${context.capability}`, putting a raw taxonomy key (`backend.services`) into prose a person reads on the Workforce tab — the one rule this milestone repeats most, and the one every other surface in Task 1 obeys (the card prints `capabilityLabel`, `server/timeline.ts` lowercases it). `packages/domain` cannot resolve the label itself: `capabilityLabel(key, taxonomy)` needs the taxonomy table, and this package does no I/O. So the CALLER supplies it — `RankContext` gains `capabilityLabel: string`, and **Task 3 passes it** from the capability label source `teamPlanOf` already holds, exactly as the `staffing.preference_changed` payload carries `capabilityLabel` beside `capability` for the same reason. `rank.test.ts` asserts the label appears in the sentence, that the key does not, and — in the shape of the existing "never a currency figure" case — that no `reason` from any step contains a `<domain>.<name>` key at all.
- **E22 (amends R3) — there are SEVEN write sites, and the seventh is `requestStop`'s, in control.** R3 and the plan both say six: `pump.ts`'s four terminal arms and `sweep.ts`'s two. `packages/control/src/stop.ts:55-58` is a seventh terminal transition — it writes `status: 'stopped', terminalAt, endedAt` inside its own `concluded.count > 0` guard — and the plan gave it no call. That is not a redundant site: `pump.ts:1178-1184` says in as many words that this is the side that usually WINS the race ("In the CLI, `requestStop` owns this pump and always reaches its own `stopped` write first, so this branch rarely observes the intent record there either"), so the pump's own stop arm covers the RARE half of an operator stop and the common half wrote nothing at all. The same operator action therefore left a fact or left none depending on which process got there first — and R5(b)'s `humanInterventions`, whose whole subject is a person reaching in, was the column most often missing. `requestStop` calls `recordRunEvidence(run.id)` inside that guard and after its own `run.stopped` append, exactly like the other six; control calls its own verb rather than exporting the transition, because a fact derived anywhere else would be a second derivation of it. The verb is idempotent on `runId @unique`, so the pump winning or losing the race is harmless either way: one row, `outcome: 'stopped'`, one intervention counted. Task 6's gate reaches this site with the operator CLI's own `stop`, which is the path an operator actually takes.
- **E23 (amends R7 and R3) — the backfill RECORDS history and never JUDGES it; judging historical runs from their events is carried backlog.** R7 says the three judgement columns "stay null" for a run whose events are incomplete, and says nothing about a run whose events are INTACT — which leaves open whether `scripts/backfill-evidence.mjs` should derive a verdict from a stored `task.verify_passed` / `task.review_rejected` / `task.integrated` and settle it. It does not, and deliberately: erratum E1 makes a judgement column move off null exactly once and never back, so a verdict derived after the fact by a script is a permanent, uncorrectable write made by something that was not there — and it feeds `EVIDENCE_RATES` (`rank.ts:219`), which is a staffing decision. A settle is the LIVE site's act at the moment somebody reached the verdict (R4's four sites), and `settleTaskEvidence` is therefore not called from the script at all. The consequence is stated rather than hidden: a run backfilled from history carries its facts — dimension keys, outcome, attempt, the three counters, duration and money — and its `verifiedFirstPass`, `reviewRejected` and `integrated` read "not judged yet" forever unless a live verdict later settles them. The script's header, its usage text and every summary line it prints say so, and its `alreadyJudged` counter is named for what it is: a READING of rows the pipeline had already settled before the pass ran, never a write. Deriving verdicts for historical runs from the event log — which would need R4's attribution rules re-applied offline, and a rule for a run whose verdict events are partial — is CARRIED BACKLOG, not this milestone.
- **E24 (amends R4) — `integrated: false` is settled only where the INTEGRATION ENDS; a retryable merge failure leaves it null, and a later successful merge settles `true` over that null.** R4 says "`false` on `task.merge_failed`", and `merge.ts`'s `failMerge` did exactly that. The defect is in the rule rather than in the code: `verifiedFirstPass` and `reviewRejected` are one-per-run verdicts, and integration is not. Every merge failure sends the task back to `rework` with its attempts still on it — a rebase that conflicted because the base branch moved, a post-rebase gate that was flaky this once, a merge git refused — and the work is then re-done and merged again; but erratum E1 makes a judgement column move off null exactly once, so the `false` written at the first failure could never be corrected, and `integrated` feeds `EVIDENCE_RATES` (`rank.ts:230-235`), which is a staffing decision. So the settle now needs BOTH halves: `judged` (somebody looked at the branch and the branch is what is wrong — a verify that could not run and a dirty shared checkout are still neither) AND `rejectTask`'s own `exhausted` (this failure spent the task's last attempt, the task is `failed`, and nothing will merge this work). Everything else leaves the column null, which every surface reads as "not judged yet" and which a later `settleTaskEvidence(..., integrated: true)` may move as a FIRST settle — permitted under E1, and the one column where that matters. The repeated-failure workspace halt is deliberately NOT one of the two conditions: a halt can be cleared and the task keeps its attempts. The consequence, stated: `integrated: false` is rarer than R4 implies, and the ranker's third rate is a smaller, honest denominator instead of a larger one containing false negatives.
- **E25 (amends R3 and R7) — a run with no `run.started` event NEVER RAN and has no fact, live or backfilled; a run that started has exactly one, so `concludeFailedResume` is the EIGHTH write site.** R3 says the spawn-failure arms write no fact ("nothing was attempted"), while R7's backfill walked every concluded `SlaveRun` and recorded those same rows the first time an operator ran the repair script — so a profile's `attempted` count, the by-model table and the step-6 duration median all changed depending on whether the script had been run, with each spawn-failure row contributing a sub-second duration nobody worked. One rule now answers both: the discriminator is the `run.started` event (`pump.ts:715`), the backfill skips a run without one and counts it as `skippedNeverStarted` (a number in `--dry-run` too, because it is a read and not a refusal), and the live spawn-failure arms stay silent as R3 asks. The other half of the same rule: `tick.ts`'s `concludeFailedResume` is conditioned on `status: 'resuming'` — a run that started, produced output, paused, and has a real duration and a real cost — so "nothing was attempted" was never true there and it now writes its fact like the other seven sites (E22's seven become eight). The cost, stated: a run whose `run.started` was later deleted is indistinguishable from one that never started and the backfill will not record it — which overturns R7's "a run whose `run.started` is gone is still recorded" case and the gate sub-stage that asserted it. That is the right way round: inventing history for a dispatch that never happened is worse than declining to re-create history somebody deleted.
- **E26 (amends R3 and R4) — the outcome follows the run's FINAL status; a walk-back amends it, through a control verb that touches no judgement column.** Three sites rewrite a run `succeeded → failed` AFTER the pump has already concluded it and written its fact: `replan.ts`'s `failRun`, `planning.ts`'s `failPlanningRun` and `review.ts`'s unparsable-verdict arm, all three inside `verifyConcludedRun`. The stored row then said `Finished` about a run the `SlaveRun` table said failed, and a later backfill silently corrected it — which is the real defect, because the same row's outcome then depended on whether a repair script had been run. Control gains `amendRunOutcome(runId)`: it re-derives ONLY the `outcome` column from the run's current status, never a judgement column (E1 owns those), never `recordedAt` or `settledAt`, never creates a row, refuses an unknown run id before any write exactly as `recordRunEvidence` does (the same simulation tripwire), and is idempotent. It is called at each of the three walk-backs and nowhere else.

---

## Global Constraints

- **Never a real model call.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and the fake CLI `packages/providers/test/fake-claude.mjs`; the browser gates need `SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh"`. Nothing in this milestone calls a model to decide anything: every evidence column is derived from a stored row or a stored event, and every rationale sentence is built from named facts by `rankCandidates`, which is pure.
- One vitest process at a time (the shared test database truncates), and **never a gate beside vitest**. A running daemon breaks `subscribe.test.ts`.
- **`npm run web:build` never while `next dev` is running.** Before any `web:build`, run `pgrep -af "next dev"`; if one is up, `kill <pid>` it and **say so in the task report**. Restarting dev afterwards needs `rm -rf apps/web/.next` first. Tasks 1, 5 and 6 run `web:build`.
- **No prettier.** There is no prettier config and no prettier dependency in this repository; `prettier --write` would reformat against the house style. Match the surrounding file by hand.
- Inside `apps/web`, import siblings **without** a `.js` suffix (`../server/evidence`, not `../server/evidence.js`); `packages/*` keep the `.js` suffix.
- Read an exit code with `${PIPESTATUS[0]}`; never `cmd | tail; echo $?` — that reports `tail`'s status.
- After `npm run db:generate`, run `npx tsc --build` **before** any integration test: the generated client's types are what the test files compile against.
- The vocabulary word is **slave**, fixtures included. `npm run gate:m26-vocabulary` after every task.
- **Labels never keys** (`docs/ia.md` rule 3). No surface prints `template:<uuid>`, `slave:<uuid>`, `succeeded`, `reported`, `backend` or `general` as visible text. `EVIDENCE_OUTCOME_LABEL`, `COST_PROVENANCE_WORD`, `domainLabel`, `MODEL_NOT_RECORDED_LABEL`, `BESPOKE_PROFILE_LABEL`, `RANK_STEP_LABEL` and `profileName` supply the words; the raw value stays in `title`, on `data-profile-key` / `data-domain` / `data-model`, or in the expanded view.
- **Real is not simulated** (`docs/ia.md` rule 4), and money words come from M51's provenance. `formatUsd` (`apps/web/src/lib/realMoney.ts`) renders every figure on the Evidence tab; `formatMinor` (`apps/web/src/lib/money.ts`, simulated money) is imported by nothing in this milestone. `SimulationRun`, `SimulationJournalEntry` and `SimulationModelUsage` feed `EvidenceRecord` nowhere, and `packages/control/test/simulation-boundary.test.ts` gains a fourth pattern that names the three new nouns.
- Refusals are `ok()` / `err()`; **a refusal after a write inside `$transaction` must throw**, or Prisma commits that write. `recordRunEvidence` refuses BEFORE it opens anything (E3), `setStaffingPreference` refuses before its upsert, and `clearStaffingPreference` refuses before its delete — so every refusal in this milestone is a returned value, and Task 2 Step 13 asserts that by construction.
- **A refusal kind reaches three homes:** the union + `refusalText` (`packages/control/src/refusal.ts`), the CLI (`throw new Error(refusalText(result.error))`), and the web (`apps/web/test/refusal-status.test.ts`'s `ALL_KINDS`, which is `Record<ControlRefusal['kind'], true>` and fails the BUILD when a kind is missing). **Exactly one kind lands in this milestone** — `invalid_staffing_preference` (R9), in Task 2 — because the boundary refusal reuses `run_not_found` (erratum E3).
- **`decide()` is unchanged and unread.** `packages/domain/src/scheduler/decide.ts` and its test are in no task's file list, and `grep -rn "scheduler/decide" ` over every file this milestone touches must come back empty. Evidence ranks a PROPOSAL; the scheduler has never read a permission, a cost or a record and does not start now.
- **`evaluateGuardrails`, `workspaceSpend` and `stats.spentUsd` do not move.** `packages/domain/src/guardrails/evaluate.ts`, `packages/control/src/spend.ts` and `packages/control/src/stats.ts` appear in NO task's file list. `RUN_UNMEASURED_CAP_USD`'s charging rule is untouched: an evidence table is a display surface, and showing a figure and charging for it are different acts (`spend.ts:172-189`).
- **The Supervisor gains no situation and no action.** `packages/domain/src/supervisor/{situations,actions,policy,observe}.ts` are in no task's file list; `situations.ts`'s "an EIGHTEENTH kind fails the build" comment is untouched, and `ACTION_KINDS` keeps its seventeen.
- **A new event type touches NINE sites, and `staffing.preference_changed` pays every one of them in Task 1** (erratum E13): the Zod union (`packages/domain/src/events/schema.ts`); `EventType` in `packages/db/prisma/schema.prisma` **plus the migration's `ALTER TYPE … ADD VALUE IF NOT EXISTS`**; `EVENT_TYPE_BY_DOMAIN_TYPE` (`packages/db/src/enums.ts`); `LANE_BY_TYPE` (`packages/domain/src/supervisor/timeline.ts:52`, lane `null`); the card component + the `ACTIVITY_CARDS` registry (`apps/web/src/components/activity/cards.tsx`); `TYPES_BY_KIND` (`apps/web/src/lib/activityFilters.ts`, under `workspace`); the sentence in `apps/web/src/server/timeline.ts`; `PAYLOAD_BY_TYPE` in `apps/web/test/activity-cards.test.tsx`; and the count in `packages/domain/test/supervisor/timeline.test.ts:19` (**58 → 59**).
- **Migrations are additive and deterministic, applied to both databases** (`npm run db:migrate` and `npm run db:migrate:test`) with the Prisma 7 diff proof: `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` → "No difference detected". The directory is **`packages/db/prisma/migrations/20260913090000_m53_evidence`** (erratum E17) and it carries **NO data statement at all** — two enums, two tables, three indexes and one `EventType` member. The data arrives from `scripts/backfill-evidence.mjs`, run once by an operator (R7), which is ADR 0003's discipline and not a stylistic choice.
- **Run directories live under `SLAVEOFAI_STATE_DIR` in tests and gates** (M52 C1). The shared setup already exists and is loaded by both vitest projects (`test-setup/state-dir.ts`) and by every gate that builds a child environment (`scripts/lib/state-dir.mjs`); `scripts/gate-m53-evidence.mjs` gets its root from `gateStateDir()` through `scripts/lib/child-env.mjs` and adds nothing of its own.
- **Test baseline: ≥ 338 test files / ≥ 5642 tests** (the whole suite at the M52 final ladder). Every task's ladder ends at or above that, never below — with one named exception this milestone creates deliberately: Task 5 DELETES `apps/web/test/integration/analytics-aggregates.test.ts` (11 cases) and 11 cases from `apps/web/test/integration/analytics.test.ts` with the computation they pin (R12, erratum E12), and adds more than it removes in the same commit. If the file count or the test count would go DOWN at the end of Task 5, the task is not finished. If the M52 ladder's own numbers differ when this plan is executed, take THEM as the baseline and say so in the first task report.
- **27 CI gates become 28.** `gate:m52-broker` is the 27th (`.github/workflows/ci.yml:80`); the new `gate:m53-evidence` step goes immediately after it, and README's roster sentence (`README.md:853-860`) and its count (`README.md:936`, "27 gates.") say 28.
- **Every gate script pin a task moves is named in that task**, never deferred to Task 6: Task 5 moves `scripts/gate-m16-chrome.mjs`'s check 5 (erratum E11) and the three analytics test files; Task 6 moves nothing else and regenerates exactly two screenshots.
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
  ```
- Every task ends with focused tests, `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck` and a commit. Web-touching tasks also run `npm run web:build` (subject to the `next dev` rule above) and `npm run gate:m44-ux-foundation` as the browser check.
- Anything touching the database goes under `test/integration/` and is named `*.test.ts` — `vitest.config.ts`'s `integration` project includes `**/test/integration/**/*.test.ts` only (no `.tsx`), and only that project loads `test-setup/require-database.ts`. Component tests are `*.test.tsx` under `apps/web/test/` with a `// @vitest-environment jsdom` first line.
- **The implementer never dispatches subagents.**

---

## File structure

```
packages/domain/src/evidence/outcome.ts        R3/R11/R12: EVIDENCE_OUTCOMES, EvidenceOutcome,
                                               EVIDENCE_OUTCOME_LABEL, evidenceOutcomeOf,
                                               INSUFFICIENT_EVIDENCE, MODEL_NOT_RECORDED_LABEL,
                                               BESPOKE_PROFILE_LABEL (new)
packages/domain/src/evidence/derive.ts         R1/R2/R4/R5/R6: profileKeyOf, isBespokeProfileKey,
                                               normaliseRepositoryKey, attemptFrom,
                                               verifiedFirstPassFrom, reviewRejectedFrom,
                                               reworkCyclesFrom, humanInterventionsFrom,
                                               recoveriesFrom, durationMsFrom, actualCostFrom,
                                               domainsFor (new)
packages/domain/src/evidence/index.ts          (new) -- ./outcome.js, ./derive.js
packages/domain/src/capability/rank.ts         R8/R9/R10/R11: EVIDENCE_MIN_SAMPLE, RANK_STEPS,
                                               RankStep, RANK_STEP_LABEL, RankEvidence,
                                               RankCandidate, RankPreference, RankContext,
                                               RankedCandidate, rankCandidates (new)
packages/domain/src/capability/taxonomy.ts     R2/R12: GENERAL_DOMAIN, DOMAIN_LABEL, domainLabel
packages/domain/src/capability/team.ts         R8: formTeam takes `ranking` and calls rankCandidates
packages/domain/src/capability/index.ts        + ./rank.js
packages/domain/src/guardrails/spend.ts        R6: COST_PROVENANCE_WORD moves in
packages/domain/src/events/schema.ts           R9: staffing.preference_changed (the 59th)
packages/domain/src/supervisor/timeline.ts     R9: LANE_BY_TYPE gains one, lane null
packages/domain/src/supervisor/world.ts        R8/R9/R10/E7: SupervisorStaffingPreference,
                                               SupervisorProfileEvidence, SupervisorWorld.
                                               {staffingPreferences,evidence},
                                               SupervisorSlave.{deniedKinds,hiredFromTemplateId,model},
                                               SupervisorCompanyWorker.templateId
packages/domain/src/supervisor/candidates.ts   R8: teamPlanOf builds the ranking context
packages/domain/src/index.ts                   + ./evidence/index.js
packages/domain/test/evidence/{outcome,derive}.test.ts                       (new)
packages/domain/test/capability/rank.test.ts                                 (new)
packages/domain/test/capability/{taxonomy,team}.test.ts                       extended
packages/domain/test/events/schema.test.ts                                    extended
packages/domain/test/supervisor/{fixtures,timeline,candidates}.test.ts        extended
packages/domain/test/guardrails/spend.test.ts                                 extended

packages/db/prisma/schema.prisma               R3/R9: enum EvidenceOutcome, enum
                                               EvidenceCostProvenance, model EvidenceRecord,
                                               model StaffingPreference, one EventType member,
                                               two Workspace back-relations
packages/db/prisma/migrations/20260913090000_m53_evidence/migration.sql      (new)
packages/db/src/enums.ts                       R9: EVENT_TYPE_BY_DOMAIN_TYPE gains one
packages/db/test/integration/enum-parity.test.ts                             + two assertions

packages/control/src/evidence.ts               R3/R4/R5/R6/R13 (new): recordRunEvidence,
                                               settleTaskEvidence, evidenceByProfile,
                                               evidenceByModel, evidenceForProfiles, listEvidence
packages/control/src/staffing.ts               R9 (new): setStaffingPreference,
                                               clearStaffingPreference, listStaffingPreferences
packages/control/src/refusal.ts                R9: invalid_staffing_preference
packages/control/src/supervisorWorld.ts        R8/R9/R10/E7/E8: three bounded loads
packages/control/src/integration.ts            R4: confirmIntegration settles `integrated`
packages/control/src/index.ts                  + ./evidence.js, + ./staffing.js
packages/control/test/simulation-boundary.test.ts                            R13: the fourth pattern
packages/control/test/integration/{evidence,staffing,supervisorWorld,integration}.test.ts
apps/web/test/refusal-status.test.ts                                         the one kind

apps/orchestrator/src/pump.ts                  R3: recordRunEvidence at the four terminal arms
apps/orchestrator/src/sweep.ts                 R3/R5: the two arms, with recoveredBySweep
apps/orchestrator/src/verify.ts                R4: the verify settle
apps/orchestrator/src/review.ts                R4: the review settle
apps/orchestrator/src/merge.ts                 R4: the merge settle, both directions
apps/orchestrator/src/cli.ts                   R9/R12: `evidence list`, `staffing prefer|clear|list`
apps/orchestrator/test/integration/{pump,sweep,verify,review,merge,cli}.test.ts
scripts/backfill-evidence.mjs                  R7 (new)

apps/web/src/server/evidence.ts                R12 (new): buildEvidencePage, the two tables
apps/web/src/server/analytics.ts               R6/R12: perSlaveRunAggregates, SlavePerformanceRow
                                               and the Spend tile deleted
apps/web/src/server/organization.ts            R12: the preference on each need row
apps/web/src/server/timeline.ts                R9: one sentence
apps/web/src/lib/activityFilters.ts            R9: one type, under `workspace`
apps/web/src/components/activity/cards.tsx     R9: StaffingPreferenceChangedCard + the registry
apps/web/src/components/workforce/EvidenceTab.tsx                            R12 (new)
apps/web/src/components/workforce/WorkforceClient.tsx                        R12: the sixth tab
apps/web/src/app/workforce/page.tsx            R12: TAB_IDS + the page read
apps/web/src/components/AnalyticsClient.tsx    R12: the panel and the tile go, the link arrives
apps/web/src/components/analytics/KpiStrip.tsx R12/E18: six becomes five
apps/web/src/components/organization/OrganizationClient.tsx                  R9: the preference UI
apps/web/src/components/TaskDetailPanel.tsx    R6: COST_PROVENANCE_WORD becomes an import
apps/web/src/app/api/w/[workspaceId]/staffing/[capability]/route.ts          R9 (new: PUT + DELETE)
apps/web/test/{evidence-tab,analytics-page,activity-cards,activityFilters,organization-page}.test.tsx
apps/web/test/integration/{evidence-page,staffing-routes}.test.ts            (new)
apps/web/test/integration/analytics-aggregates.test.ts                       DELETED with R12
apps/web/test/integration/analytics.test.ts                                  the perSlave cases go
docs/ia.md                                     R12: four cells

scripts/gate-fakes/fake-verify.sh              §3 (new, the FIFTH fake)
scripts/gate-m53-evidence.mjs                  §3 (new)
scripts/gate-m16-chrome.mjs                    E11: check 5 moves with the table
package.json, .github/workflows/ci.yml, README.md                            §3
docs/superpowers/fidelity/m14/{workforce,analytics}.png                      regenerated, own commit
docs/superpowers/specs/2026-09-12-m53-workforce-evaluation-design.md          the spec + §5
docs/superpowers/plans/2026-09-12-m53-workforce-evaluation.md                 this plan
```

---

### Task 1: The fact's vocabulary, the pure derivations, the comparator chain that is not a score, the fifty-ninth event and the two tables (R1, R2, R3, R4, R5, R6, R8, R9, R10, R11, E4, E5, E9, E10, E13, E14, E17, D1–D12)

`packages/domain` and `packages/db`, plus the four one-line web edits the fifty-ninth event FORCES (erratum E13) and the one-line import the `COST_PROVENANCE_WORD` move forces. This task changes no behaviour: after it there are two empty tables, one event type nothing writes, a ranker nothing calls and a set of pure functions nothing reads. That is deliberate — a migration that adds a fact table and a pipeline that starts writing into it are two things a reviewer should be able to read one at a time, and it is the split M52's own Task 1 made for the same reason.

**Files:**
- Create: `packages/domain/src/evidence/outcome.ts`, `packages/domain/src/evidence/derive.ts`, `packages/domain/src/evidence/index.ts`, `packages/domain/src/capability/rank.ts`, `packages/domain/test/evidence/outcome.test.ts`, `packages/domain/test/evidence/derive.test.ts`, `packages/domain/test/capability/rank.test.ts`, `packages/db/prisma/migrations/20260913090000_m53_evidence/migration.sql`
- Modify: `packages/domain/src/index.ts`, `packages/domain/src/capability/index.ts`, `packages/domain/src/capability/taxonomy.ts`, `packages/domain/src/guardrails/spend.ts`, `packages/domain/src/events/schema.ts`, `packages/domain/src/supervisor/timeline.ts`, `packages/db/prisma/schema.prisma`, `packages/db/src/enums.ts`, `apps/web/src/components/TaskDetailPanel.tsx`, `apps/web/src/components/activity/cards.tsx`, `apps/web/src/lib/activityFilters.ts`, `apps/web/src/server/timeline.ts`
- Test: the three new domain test files, plus `packages/domain/test/capability/taxonomy.test.ts`, `packages/domain/test/events/schema.test.ts`, `packages/domain/test/supervisor/timeline.test.ts`, `packages/domain/test/guardrails/spend.test.ts`, `packages/db/test/integration/enum-parity.test.ts`, `apps/web/test/activity-cards.test.tsx`, `apps/web/test/activityFilters.test.ts`

**Interfaces:**
- Consumes: `RunStatus` and `NON_TERMINAL_RUN_STATUSES` (`packages/domain/src/run/state.ts:3,44` — verified present), `CostProvenance` / `costProvenanceOf` / `CostRow` (`packages/domain/src/guardrails/spend.ts:148,165`), `estimateCostUsd` (`packages/domain/src/guardrails/pricing.ts:106`), `CapabilityRecord` / `capabilityIndex` / `CapabilityKey` (`packages/domain/src/capability/taxonomy.ts`), `BASELINE_GRANTS` / `PermissionKind` / `PermissionRunKind` (`packages/domain/src/permission/kinds.ts:229,53-54` — verified present), `zod`. No Prisma, no `node:`, no I/O anywhere in `packages/domain`.
- Produces, for Tasks 2–6:
  - `EVIDENCE_OUTCOMES = ['succeeded','failed','stopped'] as const`, `type EvidenceOutcome`, `EVIDENCE_OUTCOME_LABEL: Record<EvidenceOutcome, string>`, `evidenceOutcomeOf(status: RunStatus): EvidenceOutcome | null`
  - `INSUFFICIENT_EVIDENCE = 'Insufficient evidence'`, `MODEL_NOT_RECORDED_LABEL = 'Model not recorded'`, `BESPOKE_PROFILE_LABEL = 'Bespoke'`
  - `profileKeyOf({ slaveId, hiredFromTemplateId }): string`, `isBespokeProfileKey(key: string): boolean`, `normaliseRepositoryKey(repoPath: string): string`
  - `attemptFrom(reworkSeqs: readonly bigint[], runStartedSeq: bigint | null): number`, `verifiedFirstPassFrom(verdict: 'passed'|'failed', attempt: number): boolean`, `reviewRejectedFrom(verdict: 'approved'|'rejected', payloadAttempt: number | null, attempt: number): boolean`, `reworkCyclesFrom(reworkSeqs, runStartedSeq): number`, `humanInterventionsFrom(input): number`, `recoveriesFrom(input): number`, `durationMsFrom(startedAt: Date | null, endedAt: Date | null): number | null`, `actualCostFrom(row: CostRow): { actualCostUsd: number | null; costProvenance: CostProvenance }`, `domainsFor(requiredCapabilities, taxonomy): readonly string[]`
  - `GENERAL_DOMAIN = 'general'`, `DOMAIN_LABEL: Readonly<Record<string, string>>`, `domainLabel(domain: string): string`
  - `EVIDENCE_MIN_SAMPLE = 5`, `RANK_STEPS` (7), `type RankStep`, `RANK_STEP_LABEL`, `RankEvidence`, `RankCandidate`, `RankPreference`, `RankContext`, `RankedCandidate`, `rankCandidates(candidates, context)`
  - `COST_PROVENANCE_WORD: Record<CostProvenance, string>` in `packages/domain/src/guardrails/spend.ts`
  - one `ExecutionEvent` arm: `staffing.preference_changed`
  - Prisma: `EvidenceOutcome`, `EvidenceCostProvenance`, `EvidenceRecord`, `StaffingPreference`, one `EventType` member

- [ ] **Step 1: Write the failing test for the evidence vocabulary**

`packages/domain/test/evidence/outcome.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { NON_TERMINAL_RUN_STATUSES, type RunStatus } from '../../src/run/state.js'
import {
  BESPOKE_PROFILE_LABEL,
  EVIDENCE_OUTCOMES,
  EVIDENCE_OUTCOME_LABEL,
  INSUFFICIENT_EVIDENCE,
  MODEL_NOT_RECORDED_LABEL,
  evidenceOutcomeOf,
} from '../../src/evidence/outcome.js'

const EVERY_RUN_STATUS: readonly RunStatus[] = [
  'starting',
  'working',
  'pause_requested',
  'paused',
  'resuming',
  'stopping',
  'stopped',
  'succeeded',
  'failed',
]

describe('EVIDENCE_OUTCOMES', () => {
  it('is exactly the three TERMINAL members of RunStatus, closed (R3)', () => {
    expect(EVIDENCE_OUTCOMES).toEqual(['succeeded', 'failed', 'stopped'])
  })

  it('is RunStatus minus every non-terminal status -- derived here, pinned against Postgres in enum-parity', () => {
    const terminal = EVERY_RUN_STATUS.filter(
      (status) => !(NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(status),
    )
    expect([...EVIDENCE_OUTCOMES].toSorted()).toEqual(terminal.toSorted())
  })

  it('gives every member a word, so no table cell ever prints the key (docs/ia.md rule 3)', () => {
    for (const outcome of EVIDENCE_OUTCOMES) {
      expect(EVIDENCE_OUTCOME_LABEL[outcome], outcome).toMatch(/^[A-Z]/u)
      expect(EVIDENCE_OUTCOME_LABEL[outcome], outcome).not.toBe(outcome)
    }
  })

  it('says what each outcome IS rather than what its key spells', () => {
    expect(EVIDENCE_OUTCOME_LABEL).toEqual({
      succeeded: 'Finished',
      failed: 'Failed',
      stopped: 'Stopped by somebody',
    })
  })
})

describe('evidenceOutcomeOf', () => {
  it('maps each terminal status to itself', () => {
    expect(evidenceOutcomeOf('succeeded')).toBe('succeeded')
    expect(evidenceOutcomeOf('failed')).toBe('failed')
    expect(evidenceOutcomeOf('stopped')).toBe('stopped')
  })

  it('answers null for every non-terminal status -- a live run is not evidence about anything (R3)', () => {
    for (const status of NON_TERMINAL_RUN_STATUSES) {
      expect(evidenceOutcomeOf(status), status).toBeNull()
    }
  })
})

describe('the three words a surface says instead of a number or a key (R11, R12)', () => {
  it('spells "Insufficient evidence" once, so the page and the gate cannot disagree about it', () => {
    expect(INSUFFICIENT_EVIDENCE).toBe('Insufficient evidence')
  })

  it('names the null model group in words -- the ranker skips it, and a reader still sees it (R1)', () => {
    expect(MODEL_NOT_RECORDED_LABEL).toBe('Model not recorded')
  })

  it('has a chip word for a profile that is one worker rather than a catalog persona (R1)', () => {
    expect(BESPOKE_PROFILE_LABEL).toBe('Bespoke')
  })

  it('none of the three is a dash, a zero or an empty string -- R11 rejected all three', () => {
    for (const word of [INSUFFICIENT_EVIDENCE, MODEL_NOT_RECORDED_LABEL, BESPOKE_PROFILE_LABEL]) {
      expect(word.trim().length).toBeGreaterThan(2)
      expect(word).not.toMatch(/^[—\-0]/u)
    }
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/evidence/outcome.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/evidence/outcome.js"`.

- [ ] **Step 3: Write the vocabulary**

`packages/domain/src/evidence/outcome.ts`:

```ts
import { NON_TERMINAL_RUN_STATUSES, type RunStatus } from '../run/state.js'

/**
 * How a run ENDED, as evidence sees it (M53 R3).
 *
 * Exactly the three terminal members of {@link RunStatus} and closed: a run that has not finished
 * is not evidence about anything, and {@link evidenceOutcomeOf} answers `null` for every status
 * that can still move. The Postgres enum of the same name is pinned against this list in
 * `packages/db/test/integration/enum-parity.test.ts`, which is where every other enum parity
 * assertion in this repository lives.
 *
 * `stopped` is kept apart from `failed` deliberately, and it is the same distinction
 * `apps/web/src/server/analytics.ts`'s seven-day series already makes: an operator's cancel is not
 * the system failing, and folding it into the failure count would charge a worker's record for a
 * person's decision.
 */
export const EVIDENCE_OUTCOMES = ['succeeded', 'failed', 'stopped'] as const

export type EvidenceOutcome = (typeof EVIDENCE_OUTCOMES)[number]

/** What each outcome is CALLED when a person reads a row (`docs/ia.md` rule 3). A `Record` over the
 *  union, so a fourth outcome fails the build here rather than turning up in a table cell as an
 *  identifier. */
export const EVIDENCE_OUTCOME_LABEL: Record<EvidenceOutcome, string> = {
  succeeded: 'Finished',
  failed: 'Failed',
  // Not "Stopped": the word that matters is that somebody DID it, which is what keeps this column
  // from reading as a third kind of failure.
  stopped: 'Stopped by somebody',
}

/** The outcome for a run's status, or `null` while the run can still move. Total over `RunStatus`,
 *  by construction rather than by a second list: everything not in
 *  {@link NON_TERMINAL_RUN_STATUSES} is one of the three. */
export function evidenceOutcomeOf(status: RunStatus): EvidenceOutcome | null {
  if ((NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(status)) return null
  return status as EvidenceOutcome
}

/**
 * What a row says INSTEAD of a rate when its own denominator is below `EVIDENCE_MIN_SAMPLE`
 * (M53 R11).
 *
 * Spelled once, here, because three things read it: the table cell, the `evidence-insufficient-*`
 * testid's own row, and `scripts/gate-m53-evidence.mjs` stage 9, which asserts the words in the
 * browser. Not a dash, not a zero and not a greyed percentage -- all three were considered and all
 * three are a claim about a record nobody has enough of. `MappingQuality`'s `full|partial|none` and
 * `CostProvenance`'s `reported|estimated|unmeasured` are the precedents: an honest small state,
 * never a fabricated number.
 */
export const INSUFFICIENT_EVIDENCE = 'Insufficient evidence'

/** What the by-model table calls the group of runs whose `SlaveRun.model` was never written
 *  (M53 R1) -- every pre-M51 run, and any run whose profile chain named no model. A real group
 *  with real counts; the RANKER skips it, because a model nobody recorded cannot be preferred. */
export const MODEL_NOT_RECORDED_LABEL = 'Model not recorded'

/** The chip beside a profile that is one hand-made worker rather than a catalog persona (M53 R1) --
 *  a `Slave` with `hiredFromTemplateId` null, which every pre-M46 row and every "New slave" row is.
 *  The chip is what stops a reader taking a bespoke row for a template's record. */
export const BESPOKE_PROFILE_LABEL = 'Bespoke'
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/domain/test/evidence/outcome.test.ts`
Expected: PASS — 9 cases.

- [ ] **Step 5: Write the failing test for the derivations**

`packages/domain/test/evidence/derive.test.ts`. Every one of these is a pure function over counts a caller has already read — no Prisma type appears anywhere in this file, which is the property that makes each case a literal.

```ts
import { describe, expect, it } from 'vitest'
import type { CapabilityRecord } from '../../src/capability/taxonomy.js'
import {
  actualCostFrom,
  attemptFrom,
  domainsFor,
  durationMsFrom,
  humanInterventionsFrom,
  isBespokeProfileKey,
  normaliseRepositoryKey,
  profileKeyOf,
  recoveriesFrom,
  reviewRejectedFrom,
  reworkCyclesFrom,
  verifiedFirstPassFrom,
} from '../../src/evidence/derive.js'

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'backend.services', label: 'Services', domain: 'backend', role: 'developer', synonyms: [] },
  { key: 'qa.test-automation', label: 'Test automation', domain: 'qa', role: 'reviewer', synonyms: [] },
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'developer', synonyms: [] },
]

describe('profileKeyOf (R1)', () => {
  it('keys a hired worker on the TEMPLATE it came from, so one persona has one record', () => {
    expect(profileKeyOf({ slaveId: 's1', hiredFromTemplateId: 't7' })).toBe('template:t7')
  })

  it('keys a hand-made worker on ITSELF -- there is always a profile and the tuple is never null', () => {
    expect(profileKeyOf({ slaveId: 's1', hiredFromTemplateId: null })).toBe('slave:s1')
  })

  it('tells the two apart, which is what the Bespoke chip renders from', () => {
    expect(isBespokeProfileKey('slave:s1')).toBe(true)
    expect(isBespokeProfileKey('template:t7')).toBe(false)
  })
})

describe('normaliseRepositoryKey (R1)', () => {
  it('strips trailing separators, so two projects on one checkout share a record', () => {
    expect(normaliseRepositoryKey('/home/meren/projects/app/')).toBe('/home/meren/projects/app')
    expect(normaliseRepositoryKey('/home/meren/projects/app///')).toBe('/home/meren/projects/app')
    expect(normaliseRepositoryKey('/home/meren/projects/app')).toBe('/home/meren/projects/app')
  })

  it('never strips the root itself to nothing', () => {
    expect(normaliseRepositoryKey('/')).toBe('/')
  })

  it('is idempotent -- the snapshot written at conclusion and the one written by the backfill agree', () => {
    const once = normaliseRepositoryKey('/srv/repo/')
    expect(normaliseRepositoryKey(once)).toBe(once)
  })
})

describe('attemptFrom (R4)', () => {
  it('is one when nothing has been reworked before this run started', () => {
    expect(attemptFrom([], 100n)).toBe(1)
  })

  it('counts only the reworks BELOW this run own `run.started`, never the ones after it', () => {
    expect(attemptFrom([10n, 20n, 300n], 100n)).toBe(3)
  })

  it('is one for a run with no `run.started` at all -- a count over nothing IS zero (R7)', () => {
    expect(attemptFrom([10n, 20n], null)).toBe(1)
  })

  it('is one for a run with no task, which is every planning run (M8b)', () => {
    expect(attemptFrom([], 1n)).toBe(1)
  })
})

describe('verifiedFirstPassFrom (R4)', () => {
  it('is true only for a PASS on the first attempt', () => {
    expect(verifiedFirstPassFrom('passed', 1)).toBe(true)
  })

  it('is false for a pass on the third attempt, which is the whole point of the column', () => {
    expect(verifiedFirstPassFrom('passed', 3)).toBe(false)
  })

  it('is false for a failed verify, whatever the attempt', () => {
    expect(verifiedFirstPassFrom('failed', 1)).toBe(false)
    expect(verifiedFirstPassFrom('failed', 2)).toBe(false)
  })
})

describe('reviewRejectedFrom (R4)', () => {
  it('is true when the rejection names THIS run attempt', () => {
    expect(reviewRejectedFrom('rejected', 2, 2)).toBe(true)
  })

  it('is false when the rejection names an older attempt -- somebody else own row carries it', () => {
    expect(reviewRejectedFrom('rejected', 1, 2)).toBe(false)
  })

  it('is false on an approval', () => {
    expect(reviewRejectedFrom('approved', null, 1)).toBe(false)
  })

  it('is false when the rejection carries no attempt at all, rather than guessing it is this one', () => {
    expect(reviewRejectedFrom('rejected', null, 1)).toBe(false)
  })
})

describe('reworkCyclesFrom (R4)', () => {
  it('counts the reworks appended AFTER this run started', () => {
    expect(reworkCyclesFrom([10n, 300n, 400n], 100n)).toBe(2)
  })

  it('is zero for a run whose stream carries none -- an Int, not a Boolean, so a 2 can say so', () => {
    expect(reworkCyclesFrom([10n], 100n)).toBe(0)
  })

  it('is zero when the run has no `run.started` (R7) rather than counting the whole task history', () => {
    expect(reworkCyclesFrom([10n, 300n], null)).toBe(0)
  })
})

describe('humanInterventionsFrom (R5)', () => {
  it('counts a pause request, a resume request and an OPERATOR stop, and nothing else', () => {
    expect(
      humanInterventionsFrom({ pauseRequested: 2, resumeRequested: 1, operatorStopped: true }),
    ).toBe(4)
  })

  it('does not count a sweep own stop -- `stopRequestedBy` null is the discriminator', () => {
    expect(
      humanInterventionsFrom({ pauseRequested: 0, resumeRequested: 0, operatorStopped: false }),
    ).toBe(0)
  })
})

describe('recoveriesFrom (R5)', () => {
  it('counts ONE for a run the sweep concluded -- known from the caller, never from reason text', () => {
    expect(recoveriesFrom({ recoveredBySweep: true, unblockedAfterStart: 0 })).toBe(1)
  })

  it('counts every `task.unblocked` appended after this run started', () => {
    expect(recoveriesFrom({ recoveredBySweep: false, unblockedAfterStart: 2 })).toBe(2)
  })

  it('adds the two rather than picking one', () => {
    expect(recoveriesFrom({ recoveredBySweep: true, unblockedAfterStart: 2 })).toBe(3)
  })

  it('is zero for an ordinary run -- a breaker de-escalation is SILENT and is not one of these (M51 R2)', () => {
    expect(recoveriesFrom({ recoveredBySweep: false, unblockedAfterStart: 0 })).toBe(0)
  })
})

describe('durationMsFrom', () => {
  it('is the span between the two stamps', () => {
    expect(durationMsFrom(new Date(1_000), new Date(4_500))).toBe(3_500)
  })

  it('is null when either stamp is missing -- never a zero standing in for a gap', () => {
    expect(durationMsFrom(null, new Date(4_500))).toBeNull()
    expect(durationMsFrom(new Date(1_000), null)).toBeNull()
  })

  it('is null for a negative span, the same guard `perSlaveRunAggregates` already applies', () => {
    expect(durationMsFrom(new Date(4_500), new Date(1_000))).toBeNull()
  })
})

describe('actualCostFrom (R6)', () => {
  it('takes the REPORTED figure, always and first', () => {
    expect(
      actualCostFrom({ costUsd: 0.42, provider: 'claude_code', status: 'succeeded', tokensIn: 10, tokensOut: 20, model: 'claude-opus-4-20250514' }),
    ).toEqual({ actualCostUsd: 0.42, costProvenance: 'reported' })
  })

  it('estimates from tokens under a priced model when nothing was reported', () => {
    const derived = actualCostFrom({
      costUsd: null,
      provider: 'claude_code',
      status: 'succeeded',
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      model: 'claude-sonnet-4-20250514',
    })
    expect(derived.costProvenance).toBe('estimated')
    expect(derived.actualCostUsd).not.toBeNull()
    expect(derived.actualCostUsd).toBeGreaterThan(0)
  })

  it('is NULL and never 0 when nothing can be measured -- a zero is a figure a reader believes', () => {
    expect(
      actualCostFrom({ costUsd: null, provider: 'cursor', status: 'succeeded', tokensIn: null, tokensOut: null, model: null }),
    ).toEqual({ actualCostUsd: null, costProvenance: 'unmeasured' })
  })

  it('is unmeasured under an UNPRICED model, which is the carried-backlog item M53 makes load-bearing', () => {
    expect(
      actualCostFrom({ costUsd: null, provider: 'claude_code', status: 'succeeded', tokensIn: 10, tokensOut: 20, model: 'a-model-nobody-priced' }),
    ).toEqual({ actualCostUsd: null, costProvenance: 'unmeasured' })
  })
})

describe('domainsFor (R2)', () => {
  it('resolves each required capability to its taxonomy domain, deduplicated and sorted', () => {
    expect(domainsFor(['backend.services', 'qa.test-automation'], TAXONOMY)).toEqual(['backend', 'qa'])
  })

  it('collapses two capabilities of one domain into one entry -- ONE row, never one per pair', () => {
    expect(domainsFor(['backend.services', 'backend.api-design'], TAXONOMY)).toEqual(['backend'])
  })

  it('answers the reserved `general` domain for a task that asked for nothing', () => {
    expect(domainsFor([], TAXONOMY)).toEqual(['general'])
  })

  it('answers `general` for a key the taxonomy does not have, rather than inventing a domain', () => {
    expect(domainsFor(['nowhere.at-all'], TAXONOMY)).toEqual(['general'])
  })

  it('drops the unresolvable key and keeps the resolvable one, without falling back to general', () => {
    expect(domainsFor(['backend.services', 'nowhere.at-all'], TAXONOMY)).toEqual(['backend'])
  })

  it('is never empty, which is what lets the column be NOT NULL', () => {
    for (const input of [[], ['nowhere.at-all'], ['backend.services']]) {
      expect(domainsFor(input, TAXONOMY).length, JSON.stringify(input)).toBeGreaterThan(0)
    }
  })

  it('answers `general` against an empty taxonomy -- a database whose taxonomy was never synced', () => {
    expect(domainsFor(['backend.services'], [])).toEqual(['general'])
  })
})
```

And the taxonomy half, appended to `packages/domain/test/capability/taxonomy.test.ts`:

```ts
describe('domainLabel (M53 R2/R12)', () => {
  it('title-cases a plain domain segment', () => {
    expect(domainLabel('backend')).toBe('Backend')
    expect(domainLabel('frontend')).toBe('Frontend')
    expect(domainLabel('security')).toBe('Security')
  })

  it('carries the small exception table, because "Qa" is not a word anybody writes', () => {
    expect(domainLabel('qa')).toBe('QA')
    expect(domainLabel('docs')).toBe('Docs')
  })

  it('names the reserved domain in words too -- a chip never reads `general`', () => {
    expect(GENERAL_DOMAIN).toBe('general')
    expect(domainLabel(GENERAL_DOMAIN)).toBe('General')
  })

  it('labels every domain the seeded taxonomy carries, so no chip on the page is a bare key', () => {
    for (const domain of ['backend', 'data', 'database', 'design', 'docs', 'frontend', 'mobile', 'operations', 'planning', 'product', 'qa', 'review', 'security']) {
      expect(domainLabel(domain), domain).toMatch(/^[A-Z]/u)
    }
  })

  it('falls back to the raw segment for a domain this bundle has never heard of (the SITUATION_LABEL idiom)', () => {
    expect(domainLabel('quantum')).toBe('Quantum')
    expect(domainLabel('')).toBe('')
  })
})
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npx vitest run packages/domain/test/evidence/derive.test.ts packages/domain/test/capability/taxonomy.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/evidence/derive.js"`, and `domainLabel is not exported`.

- [ ] **Step 7: Write the derivations, and the two domain words**

First the taxonomy half. `packages/domain/src/capability/taxonomy.ts`, appended at the end beside `capabilityLabel`:

```ts
/**
 * The ONE domain that is not a `Capability.domain` value (M53 R2).
 *
 * A run whose task required no capability, required only keys the taxonomy does not have, or had no
 * task at all (a `planning` run, M8b) counts toward this. Declared as a constant beside the label
 * table rather than spelled as a string in five places, so nothing has to guess whether the word is
 * `general`, `other` or `unknown` -- and so a taxonomy that one day seeds a real `general` domain
 * is a collision somebody can see rather than a silent merge.
 */
export const GENERAL_DOMAIN = 'general'

/**
 * The words for a domain, where title-casing the segment is not enough (M53 R12, `docs/ia.md`
 * rule 3).
 *
 * Deliberately SMALL: only the segments whose ordinary English spelling is not their title case.
 * Every other domain falls through to `segment[0].toUpperCase() + rest`, which is what keeps this
 * table from becoming a second taxonomy that has to be kept in step with `packages/db/src/
 * capabilities.ts`. A domain this bundle has never heard of is title-cased and shown, the
 * `SITUATION_LABEL` fallback idiom (M44 R5): the honest thing to show is the word itself.
 */
export const DOMAIN_LABEL: Readonly<Record<string, string>> = {
  qa: 'QA',
  docs: 'Docs',
}

/** What a person reads instead of a domain key. Never empty unless the input is. */
export function domainLabel(domain: string): string {
  const exception = DOMAIN_LABEL[domain]
  if (exception !== undefined) return exception
  if (domain === '') return ''
  return domain.charAt(0).toUpperCase() + domain.slice(1)
}
```

Then `packages/domain/src/evidence/derive.ts`:

```ts
import { capabilityIndex, GENERAL_DOMAIN, type CapabilityKey, type CapabilityRecord } from '../capability/taxonomy.js'
import { estimateCostUsd } from '../guardrails/pricing.js'
import { costProvenanceOf, type CostProvenance, type CostRow } from '../guardrails/spend.js'

/**
 * Every column of an `EvidenceRecord` that can be computed without touching a database (M53 R1-R6).
 *
 * The rule this file exists to keep: `packages/control/src/evidence.ts` READS -- one `SlaveRun`
 * row and a handful of bounded event counts -- and this module DECIDES. Nothing here takes a Prisma
 * type, nothing here is async, and every case in `derive.test.ts` is a literal. It is also what
 * makes R7's backfill honest: the script and the pipeline call the same reader, which calls these
 * same functions, so a row derived from history and a row derived at conclusion cannot disagree.
 */

/**
 * The PROFILE half of the fact's identity (R1): the catalog persona a worker was hired from, or the
 * worker itself when nobody hired it from anything.
 *
 * `template:<id>` and `slave:<id>` are two namespaces on purpose -- a bespoke worker is its OWN
 * profile and is never unified with the template it resembles. `CompanySlave` is deliberately not
 * the key: its own comment (`schema.prisma:508-511`) claims statistics accrue to the durable name
 * across projects, nothing has ever implemented that, and choosing it would key a company-wide
 * record on a row a project hire does not have.
 */
export function profileKeyOf(input: {
  readonly slaveId: string
  readonly hiredFromTemplateId: string | null
}): string {
  return input.hiredFromTemplateId === null ? `slave:${input.slaveId}` : `template:${input.hiredFromTemplateId}`
}

/** True for a profile key that names one worker rather than a catalog persona -- what the `Bespoke`
 *  chip renders from. */
export function isBespokeProfileKey(key: string): boolean {
  return key.startsWith('slave:')
}

/**
 * The REPOSITORY half (R1): `Workspace.repoPath`, normalised and snapshotted at write time.
 *
 * Trailing separators only. Nothing else is touched -- no `realpath`, no case folding, no symlink
 * resolution -- because every one of those is I/O or a guess, and this function runs inside a
 * derivation that must be a pure function of stored values. The residual is R1's own and is stated
 * rather than hidden: a checkout moved to a new path splits its own history.
 */
export function normaliseRepositoryKey(repoPath: string): string {
  const trimmed = repoPath.replace(/\/+$/u, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * Which ATTEMPT this run is (R4): the `task.rework` events for this run's task whose `seq` is below
 * this run's own `run.started`, plus one.
 *
 * `bigint` because `ExecutionEvent.seq` is one, and comparing it as a `Number` would start lying at
 * 2^53. A run with no `run.started` event -- R7's incomplete history -- counts nothing and is
 * attempt 1, which is the honest floor: a count over nothing IS zero, and the first attempt is the
 * one nobody can be wrong about.
 */
export function attemptFrom(reworkSeqs: readonly bigint[], runStartedSeq: bigint | null): number {
  if (runStartedSeq === null) return 1
  return reworkSeqs.filter((seq) => seq < runStartedSeq).length + 1
}

/** R4: a run verified on its FIRST try. A run whose verify failed settles `false`, and so does one
 *  that passed on its third attempt -- which is the whole point of the column. */
export function verifiedFirstPassFrom(verdict: 'passed' | 'failed', attempt: number): boolean {
  return verdict === 'passed' && attempt === 1
}

/**
 * R4: the reviewer sent THIS run's work back.
 *
 * `task.review_rejected` is the only verify/review event carrying an attempt number
 * (`packages/domain/src/events/schema.ts:239-243`), and the comparison is what stops an older run's
 * row being charged for a rejection of newer work. A rejection carrying no attempt at all settles
 * `false` rather than guessing it is this one -- inventing an attribution is worse than recording
 * that nobody judged this run.
 */
export function reviewRejectedFrom(
  verdict: 'approved' | 'rejected',
  payloadAttempt: number | null,
  attempt: number,
): boolean {
  return verdict === 'rejected' && payloadAttempt !== null && payloadAttempt === attempt
}

/** R4: how many `task.rework` events were appended for this task AFTER this run started. 0 or 1 in
 *  today's pipeline; an `Int` and not a `Boolean` because nothing guarantees one, and a column that
 *  could silently be 2 must be able to say so. */
export function reworkCyclesFrom(reworkSeqs: readonly bigint[], runStartedSeq: bigint | null): number {
  if (runStartedSeq === null) return 0
  return reworkSeqs.filter((seq) => seq > runStartedSeq).length
}

/**
 * R5: how many times a PERSON stepped into this run. Closed, and bounded to the run's own stream.
 *
 * `run.pause_requested` + `run.resume_requested` + a `run.stopped` whose `SlaveRun.stopRequestedBy`
 * is non-null -- the operator-versus-sweep discriminator the column was added for
 * (`schema.prisma:809-816`). `supervisor.resolved` is deliberately excluded: it is a decision about
 * the WORKSPACE, carries no `runId` to be bounded by, and would make the count unbounded in exactly
 * the way the Supervisor-world loaders refuse.
 */
export function humanInterventionsFrom(input: {
  readonly pauseRequested: number
  readonly resumeRequested: number
  readonly operatorStopped: boolean
}): number {
  return input.pauseRequested + input.resumeRequested + (input.operatorStopped ? 1 : 0)
}

/**
 * R5: a recovery is exactly two things, and a breaker de-escalation is NOT one of them.
 *
 * (a) one, when this run's terminal row was written by the sweep's orphan or dead-pid arm -- known
 * because the SWEEP is the caller, never by matching the reason text of a `run.failed`, which is
 * our own prose and may be reworded; (b) every `task.unblocked` appended for this run's task after
 * this run started -- a parked task a person or the Supervisor brought back.
 *
 * Nothing else. M51 R2 made a de-escalation SILENT on purpose (`events/schema.ts:617-619`), so
 * there is no event to count and inventing one would be an M51 change wearing an M53 label. A
 * `run.resumed` after a pause is not counted either: the pause is already one
 * {@link humanInterventionsFrom} tick, and counting the resume would count one person's single act
 * twice.
 */
export function recoveriesFrom(input: {
  readonly recoveredBySweep: boolean
  readonly unblockedAfterStart: number
}): number {
  return (input.recoveredBySweep ? 1 : 0) + input.unblockedAfterStart
}

/** How long the run took, or null. Guarded on `endedAt >= startedAt`, the same guard
 *  `perSlaveRunAggregates` already applies in SQL (`apps/web/src/server/analytics.ts:101-103`): a
 *  negative span is a clock that moved, not a measurement. */
export function durationMsFrom(startedAt: Date | null, endedAt: Date | null): number | null {
  if (startedAt === null || endedAt === null) return null
  const span = endedAt.getTime() - startedAt.getTime()
  return Number.isFinite(span) && span >= 0 ? span : null
}

/**
 * R6: the money figure and the word beside it, from M51's own machinery and nothing new.
 *
 * `costProvenanceOf` decides the word; the figure is the reported `costUsd` when reported,
 * `estimateCostUsd(model, tokens)` when estimated, and `null` when unmeasured -- NEVER a zero
 * standing in for a gap, which is the reason `SlaveRun.costUsd` was made nullable in the first
 * place (`schema.prisma`'s own column comment).
 *
 * This is also where M52's carried `MODEL_PRICES` item stops being cosmetic: an unpriced model
 * makes every one of its runs read `unmeasured`, and R8's cost step then ties on it rather than
 * preferring it.
 */
export function actualCostFrom(row: CostRow): {
  readonly actualCostUsd: number | null
  readonly costProvenance: CostProvenance
} {
  const costProvenance = costProvenanceOf(row)
  if (costProvenance === 'reported') return { actualCostUsd: row.costUsd, costProvenance }
  if (costProvenance === 'unmeasured') return { actualCostUsd: null, costProvenance }
  const tokens =
    row.tokensIn === null || row.tokensOut === null ? null : { input: row.tokensIn, output: row.tokensOut }
  return { actualCostUsd: estimateCostUsd(row.model, tokens), costProvenance }
}

/**
 * R2: the domains one run's evidence counts toward -- every domain its task asked for, or the
 * reserved `general`.
 *
 * ONE row with a `domains` array, never one row per (run, domain) pair: that would double-count
 * money in the one place money must not be double-counted. Deduplicated and SORTED, so the column
 * is byte-equal whatever order the capabilities were written in -- which is what R7's "running it
 * twice writes the same rows" rests on.
 *
 * Never empty, which is what lets the column be NOT NULL: a key the taxonomy cannot resolve
 * contributes nothing, and a list that resolves to nothing at all falls back to
 * {@link GENERAL_DOMAIN}.
 */
export function domainsFor(
  requiredCapabilities: readonly CapabilityKey[],
  taxonomy: readonly CapabilityRecord[],
): readonly string[] {
  const index = capabilityIndex(taxonomy)
  const domains = new Set<string>()
  for (const key of requiredCapabilities) {
    const record = index.get(key)
    if (record !== undefined && record.domain !== '') domains.add(record.domain)
  }
  return domains.size === 0 ? [GENERAL_DOMAIN] : [...domains].toSorted()
}
```

`packages/domain/src/evidence/index.ts`:

```ts
export * from './outcome.js'
export * from './derive.js'
```

`packages/domain/src/index.ts` gains `export * from './evidence/index.js'` beside the other twenty-odd barrels.

- [ ] **Step 8: Run them and watch them pass**

Run: `npx vitest run packages/domain/test/evidence packages/domain/test/capability/taxonomy.test.ts`
Expected: PASS — 9 + 34 + the taxonomy file's existing cases.

- [ ] **Step 9: Write the failing test for the comparator chain**

`packages/domain/test/capability/rank.test.ts`. This is the file R11 is asserted from, so it carries both the ORDER cases and the two structural cases that say the result is not a score.

```ts
import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_MIN_SAMPLE,
  RANK_STEPS,
  RANK_STEP_LABEL,
  rankCandidates,
  type RankCandidate,
  type RankContext,
  type RankEvidence,
} from '../../src/capability/rank.js'

const NO_EVIDENCE: RankEvidence = {
  attempted: 0,
  firstPassJudged: 0,
  firstPassPassed: 0,
  reviewJudged: 0,
  reviewRejected: 0,
  integrationJudged: 0,
  integrated: 0,
  medianCostUsd: null,
  medianDurationMs: null,
}

function candidate(overrides: Partial<RankCandidate> & { readonly id: string }): RankCandidate {
  return {
    kind: 'slave',
    name: overrides.id,
    profileKey: `slave:${overrides.id}`,
    templateId: null,
    model: null,
    covers: ['backend.services'],
    busy: false,
    deniedKinds: [],
    evidence: null,
    ...overrides,
  }
}

const CONTEXT: RankContext = { capability: 'backend.services', preference: null, runKind: 'implementation' }

const order = (ranked: ReturnType<typeof rankCandidates>): readonly string[] =>
  ranked.map((one) => one.candidate.id)

describe('RANK_STEPS', () => {
  it('is the roadmap six, IN ORDER, plus the one tie-break that makes the function total (E9)', () => {
    expect(RANK_STEPS).toEqual([
      'capability_fit',
      'permission',
      'preference',
      'availability',
      'evidence',
      'cost_time',
      'identity',
    ])
  })

  it('gives every step a word, so a rationale sentence never prints the key', () => {
    for (const step of RANK_STEPS) {
      expect(RANK_STEP_LABEL[step], step).toMatch(/^[A-Z]/u)
      expect(RANK_STEP_LABEL[step], step).not.toContain('_')
    }
  })
})

describe('EVIDENCE_MIN_SAMPLE', () => {
  it('is five -- the smallest sample this project is willing to call evidence (R11)', () => {
    expect(EVIDENCE_MIN_SAMPLE).toBe(5)
  })
})

describe('rankCandidates: step 1, capability fit', () => {
  it('puts a candidate covering more still-missing capabilities first', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'a', covers: ['backend.services'] }), candidate({ id: 'b', covers: ['backend.services', 'qa.test-automation'] })],
      CONTEXT,
    )
    expect(order(ranked)).toEqual(['b', 'a'])
    expect(ranked[0]?.decidedBy).toBe('capability_fit')
  })

  it('puts a candidate that provides the capability above one that provides none of them', () => {
    const ranked = rankCandidates([candidate({ id: 'a', covers: [] }), candidate({ id: 'b' })], CONTEXT)
    expect(order(ranked)).toEqual(['b', 'a'])
  })
})

describe('rankCandidates: step 2, permission (R10)', () => {
  it('ranks a worker with an explicit deny on a BASELINE kind below one without', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'a', deniedKinds: ['run_commands'] }), candidate({ id: 'b' })],
      CONTEXT,
    )
    expect(order(ranked)).toEqual(['b', 'a'])
    expect(ranked[0]?.decidedBy).toBe('permission')
  })

  it('ignores a deny on a kind the run kind baseline does not include -- a wall nobody walks into', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'b', deniedKinds: ['deploy_release'] }), candidate({ id: 'a' })],
      CONTEXT,
    )
    // Nothing separated them but their identities.
    expect(order(ranked)).toEqual(['a', 'b'])
    expect(ranked[0]?.decidedBy).toBe('identity')
  })

  it('reads the RUN KIND baseline, so `write_repo` walls an implementation and not a planning run', () => {
    const walled = candidate({ id: 'a', deniedKinds: ['write_repo'] })
    expect(order(rankCandidates([walled, candidate({ id: 'b' })], CONTEXT))).toEqual(['b', 'a'])
    expect(
      order(rankCandidates([walled, candidate({ id: 'b' })], { ...CONTEXT, runKind: 'planning' })),
    ).toEqual(['a', 'b'])
  })

  it('does not EXCLUDE a denied candidate -- a wall is a ranking fact, not a disqualification', () => {
    const ranked = rankCandidates([candidate({ id: 'a', deniedKinds: ['run_commands'] })], CONTEXT)
    expect(order(ranked)).toEqual(['a'])
  })

  it('leaves a template and a company worker unaffected: they carry no permission rows at all', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'a', kind: 'template', templateId: 'a' }), candidate({ id: 'b', kind: 'company_slave' })],
      CONTEXT,
    )
    expect(ranked[0]?.decidedBy).toBe('identity')
  })
})

describe('rankCandidates: step 3, preference (R9)', () => {
  const preferring = (templateId: string | null, model: string | null): RankContext => ({
    ...CONTEXT,
    preference: { templateId, model },
  })

  it('puts the preferred candidate first, above one with a better record', () => {
    const strong: RankEvidence = { ...NO_EVIDENCE, attempted: 20, firstPassJudged: 20, firstPassPassed: 20 }
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', templateId: 't-a', evidence: strong }),
        candidate({ id: 'b', templateId: 't-b', evidence: NO_EVIDENCE }),
      ],
      preferring('t-b', null),
    )
    expect(order(ranked)).toEqual(['b', 'a'])
    expect(ranked[0]?.decidedBy).toBe('preference')
  })

  it('never beats the WALL: a preferred candidate with a baseline deny still ranks below', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', templateId: 't-a' }),
        candidate({ id: 'b', templateId: 't-b', deniedKinds: ['run_commands'] }),
      ],
      preferring('t-b', null),
    )
    expect(order(ranked)).toEqual(['a', 'b'])
    expect(ranked[0]?.decidedBy).toBe('permission')
  })

  it('carries NO weight for a BUSY candidate -- a preference for somebody who cannot start is not one', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'a', templateId: 't-a' }), candidate({ id: 'b', templateId: 't-b', busy: true })],
      preferring('t-b', null),
    )
    expect(order(ranked)).toEqual(['a', 'b'])
    expect(ranked[0]?.decidedBy).toBe('availability')
  })

  it('matches on the MODEL alone when the preference names only a model', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'a', model: 'sonnet' }), candidate({ id: 'b', model: 'opus' })],
      preferring(null, 'opus'),
    )
    expect(order(ranked)).toEqual(['b', 'a'])
  })

  it('requires BOTH halves when both are named -- "Atlas, and on opus" is one decision', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', templateId: 't-a', model: 'opus' }),
        candidate({ id: 'b', templateId: 't-b', model: 'sonnet' }),
      ],
      preferring('t-b', 'opus'),
    )
    expect(order(ranked)).toEqual(['a', 'b'])
    expect(ranked[0]?.decidedBy).toBe('identity')
  })
})

describe('rankCandidates: step 4, availability', () => {
  it('puts an idle candidate above a busy one', () => {
    const ranked = rankCandidates([candidate({ id: 'a', busy: true }), candidate({ id: 'b' })], CONTEXT)
    expect(order(ranked)).toEqual(['b', 'a'])
    expect(ranked[0]?.decidedBy).toBe('availability')
  })
})

describe('rankCandidates: step 5, evidence (R8, R11)', () => {
  const withRates = (id: string, passed: number, rejected: number, integrated: number): RankCandidate =>
    candidate({
      id,
      evidence: {
        ...NO_EVIDENCE,
        attempted: 10,
        firstPassJudged: 10,
        firstPassPassed: passed,
        reviewJudged: 10,
        reviewRejected: rejected,
        integrationJudged: 10,
        integrated,
      },
    })

  it('prefers the higher first-pass verify rate, before either of the other two', () => {
    const ranked = rankCandidates([withRates('a', 4, 0, 10), withRates('b', 9, 9, 0)], CONTEXT)
    expect(order(ranked)).toEqual(['b', 'a'])
    expect(ranked[0]?.decidedBy).toBe('evidence')
  })

  it('falls to the LOWER review-rejection rate when the first-pass rates tie', () => {
    const ranked = rankCandidates([withRates('a', 5, 8, 0), withRates('b', 5, 1, 0)], CONTEXT)
    expect(order(ranked)).toEqual(['b', 'a'])
  })

  it('falls to the HIGHER integration rate when the first two tie', () => {
    const ranked = rankCandidates([withRates('a', 5, 5, 2), withRates('b', 5, 5, 9)], CONTEXT)
    expect(order(ranked)).toEqual(['b', 'a'])
  })

  it('SKIPS a rate whose own denominator is thin, so a thin record ties instead of deciding', () => {
    const thin = candidate({
      id: 'a',
      evidence: { ...NO_EVIDENCE, attempted: 2, firstPassJudged: 2, firstPassPassed: 2 },
    })
    const fat = candidate({
      id: 'b',
      evidence: { ...NO_EVIDENCE, attempted: 10, firstPassJudged: 10, firstPassPassed: 1 },
    })
    const ranked = rankCandidates([thin, fat], CONTEXT)
    expect(order(ranked)).toEqual(['a', 'b'])
    expect(ranked[0]?.decidedBy).toBe('identity')
  })

  it('reads a denominator of exactly EVIDENCE_MIN_SAMPLE as enough', () => {
    const five = candidate({
      id: 'a',
      evidence: { ...NO_EVIDENCE, attempted: 5, firstPassJudged: EVIDENCE_MIN_SAMPLE, firstPassPassed: 5 },
    })
    const worse = candidate({
      id: 'b',
      evidence: { ...NO_EVIDENCE, attempted: 5, firstPassJudged: EVIDENCE_MIN_SAMPLE, firstPassPassed: 0 },
    })
    expect(order(rankCandidates([worse, five], CONTEXT))).toEqual(['a', 'b'])
  })

  it('skips every rate for a candidate with NO record at all rather than reading it as zero', () => {
    const none = candidate({ id: 'a', evidence: null })
    const some = candidate({
      id: 'b',
      evidence: { ...NO_EVIDENCE, attempted: 10, firstPassJudged: 10, firstPassPassed: 10 },
    })
    expect(rankCandidates([none, some], CONTEXT)[0]?.decidedBy).toBe('identity')
  })
})

describe('rankCandidates: step 6, cost and time (R8)', () => {
  it('prefers the lower median cost', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', evidence: { ...NO_EVIDENCE, medianCostUsd: 2 } }),
        candidate({ id: 'b', evidence: { ...NO_EVIDENCE, medianCostUsd: 1 } }),
      ],
      CONTEXT,
    )
    expect(order(ranked)).toEqual(['b', 'a'])
    expect(ranked[0]?.decidedBy).toBe('cost_time')
  })

  it('falls to the lower median duration when the costs tie', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', evidence: { ...NO_EVIDENCE, medianCostUsd: 1, medianDurationMs: 9_000 } }),
        candidate({ id: 'b', evidence: { ...NO_EVIDENCE, medianCostUsd: 1, medianDurationMs: 1_000 } }),
      ],
      CONTEXT,
    )
    expect(order(ranked)).toEqual(['b', 'a'])
  })

  it('TIES on an unmeasured candidate rather than letting it win -- unmeasured is not cheap', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', evidence: { ...NO_EVIDENCE, medianCostUsd: null } }),
        candidate({ id: 'b', evidence: { ...NO_EVIDENCE, medianCostUsd: 5 } }),
      ],
      CONTEXT,
    )
    expect(order(ranked)).toEqual(['a', 'b'])
    expect(ranked[0]?.decidedBy).toBe('identity')
  })
})

describe('rankCandidates: the shape of the answer (R11, E9, E10)', () => {
  it('is total and deterministic: the same world always yields the same order', () => {
    const world = [candidate({ id: 'c' }), candidate({ id: 'a' }), candidate({ id: 'b' })]
    expect(order(rankCandidates(world, CONTEXT))).toEqual(['a', 'b', 'c'])
    expect(order(rankCandidates([...world].toReversed(), CONTEXT))).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate its input', () => {
    const world = [candidate({ id: 'c' }), candidate({ id: 'a' })]
    rankCandidates(world, CONTEXT)
    expect(world.map((one) => one.id)).toEqual(['c', 'a'])
  })

  it('answers an empty list for an empty world', () => {
    expect(rankCandidates([], CONTEXT)).toEqual([])
  })

  it('names the step that separated each candidate from the NEXT, and null for the last', () => {
    const ranked = rankCandidates([candidate({ id: 'a' }), candidate({ id: 'b', busy: true })], CONTEXT)
    expect(ranked[0]?.decidedBy).toBe('availability')
    expect(ranked[1]?.decidedBy).toBeNull()
  })

  it('carries a rationale sentence naming both candidates, derived and never invented', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'a', name: 'Atlas' }), candidate({ id: 'b', name: 'Bea', busy: true })],
      CONTEXT,
    )
    expect(ranked[0]?.reason).toContain('Atlas')
    expect(ranked[0]?.reason).toContain('Bea')
    expect(ranked[0]?.reason).toMatch(/free/u)
  })

  it('NEVER puts a currency figure in a rationale -- `formatUsd` owns money (erratum E10)', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', evidence: { ...NO_EVIDENCE, medianCostUsd: 2.5 } }),
        candidate({ id: 'b', evidence: { ...NO_EVIDENCE, medianCostUsd: 1.25 } }),
      ],
      CONTEXT,
    )
    for (const one of ranked) expect(one.reason).not.toMatch(/\$|\d+\.\d{2}/u)
  })

  it('carries NO score, rating, rank, weight, index or total on any result property (R11)', () => {
    const ranked = rankCandidates([candidate({ id: 'a' }), candidate({ id: 'b' })], CONTEXT)
    for (const one of ranked) {
      for (const key of Object.keys(one)) {
        expect(key, key).not.toMatch(/score|rating|^rank$|weight|index|total/iu)
      }
      // The only numbers anywhere in the answer are the candidate's own measured counts.
      expect(typeof one.decidedBy === 'string' || one.decidedBy === null).toBe(true)
      expect(typeof one.reason).toBe('string')
    }
  })
})
```

- [ ] **Step 10: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/capability/rank.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/capability/rank.js"`.

- [ ] **Step 11: Write the comparator chain**

`packages/domain/src/capability/rank.ts`:

```ts
import { BASELINE_GRANTS, type PermissionKind, type PermissionRunKind } from '../permission/kinds.js'
import type { CapabilityKey } from './taxonomy.js'

/**
 * The smallest sample this project is willing to call evidence (M53 R11).
 *
 * FIVE, and the number is deliberate rather than conventional: four runs is a coin landing the same
 * way twice, and a rate over four denominators is a sentence a person would act on. Below it a
 * comparison is SKIPPED here and the words `Insufficient evidence` render on the page -- the same
 * threshold decides both, so the ranking and the surface can never disagree about which records are
 * thick enough to mean anything.
 *
 * It is the ONLY threshold this milestone owns. There is no per-workspace override and no settings
 * control for it (spec §4, M38 §8's rule): a configurable honesty threshold is a way of turning
 * honesty off.
 */
export const EVIDENCE_MIN_SAMPLE = 5

/**
 * The roadmap's six steps, in order, plus the one tie-break that makes the comparison TOTAL
 * (plan erratum E9).
 *
 * The order is the whole ruling and it is not a weighting: no two steps are ever traded off against
 * each other, which is precisely why this is a comparator chain and not a score. A candidate that
 * wins step 2 wins, whatever steps 3-6 would have said -- and a person's explicit refusal therefore
 * cannot be outvoted by a good record.
 *
 * `identity` is not one of the roadmap's six. It is the final `id` comparison R8 asks for, given a
 * NAME so {@link RankedCandidate.decidedBy} can be total: "nothing separated them but their names"
 * is a real answer, and a null there would be indistinguishable from "this is the last row".
 */
export const RANK_STEPS = [
  'capability_fit',
  'permission',
  'preference',
  'availability',
  'evidence',
  'cost_time',
  'identity',
] as const

export type RankStep = (typeof RANK_STEPS)[number]

/** What each step is CALLED when a person reads a rationale (`docs/ia.md` rule 3). */
export const RANK_STEP_LABEL: Record<RankStep, string> = {
  capability_fit: 'What they can do',
  permission: 'What they are allowed to do',
  preference: 'What somebody asked for',
  availability: 'Who is free',
  evidence: 'What their record says',
  cost_time: 'What it costs and how long it takes',
  identity: 'Nothing but their names',
}

/**
 * One profile's record as the RANKER reads it (M53 R3/R8) -- counts and two medians, never a rate.
 *
 * The rates are computed HERE rather than carried, so a denominator below {@link
 * EVIDENCE_MIN_SAMPLE} is a fact the comparator can see rather than a number somebody upstream
 * already rounded. The three denominators are independent because the three judgement columns
 * settle independently (R3): a profile can have twenty attempts, twenty verify verdicts and two
 * integrations, and the integration rate is thin while the other two are not.
 */
export interface RankEvidence {
  readonly attempted: number
  readonly firstPassJudged: number
  readonly firstPassPassed: number
  readonly reviewJudged: number
  readonly reviewRejected: number
  readonly integrationJudged: number
  readonly integrated: number
  /** Median `actualCostUsd` over the profile's `reported` and `estimated` rows. Null when none of
   *  them was measured -- which ties at step 6 rather than winning it. */
  readonly medianCostUsd: number | null
  readonly medianDurationMs: number | null
}

/** One candidate for one capability, with every fact the six steps read. Built by `teamPlanOf` from
 *  `SupervisorWorld` and by nothing else. */
export interface RankCandidate {
  /** The tie-break of last resort, and the id the caller will act on: a `Slave.id`, a
   *  `CompanySlave.id` or a `SlaveTemplate.id`, matching {@link RankCandidate.kind}. */
  readonly id: string
  readonly kind: 'slave' | 'company_slave' | 'template'
  readonly name: string
  /** R1: `template:<id>` or `slave:<id>` -- what {@link RankCandidate.evidence} was looked up by. */
  readonly profileKey: string
  /** The catalog template behind this candidate, or null for a bespoke worker. R9's preference
   *  names a template, so this is the half a preference matches on. */
  readonly templateId: string | null
  /** The model this candidate would run on -- the resolved chain, not a wish. Null when the chain
   *  names none, in which case a preference naming a model cannot match it. */
  readonly model: string | null
  /** Every still-missing capability this candidate would cover. Step 1 reads its LENGTH. */
  readonly covers: readonly CapabilityKey[]
  readonly busy: boolean
  /** R10: the `deny` rows this candidate carries. EMPTY for a template and for a company worker not
   *  yet materialised -- neither has a `SlavePermission` row, and neither is favoured nor penalised
   *  for it. There is no "would this profile be granted X" oracle in this milestone. */
  readonly deniedKinds: readonly PermissionKind[]
  /** This profile's record, or null when nothing has ever been recorded about it. */
  readonly evidence: RankEvidence | null
}

/** R9: what a person asked for, for one capability. At least one half is non-null -- a row naming
 *  neither is refused by `setStaffingPreference` and never reaches here. */
export interface RankPreference {
  readonly templateId: string | null
  readonly model: string | null
}

export interface RankContext {
  readonly capability: CapabilityKey
  readonly preference: RankPreference | null
  /** Whose baseline the permission step reads (R10). `implementation` for every staffing decision
   *  the Supervisor makes today; a parameter because the baseline differs and both answers are
   *  true. */
  readonly runKind: PermissionRunKind
}

/**
 * One ranked candidate. **No number of any kind** (M53 R11): `decidedBy` is a step NAME and
 * `reason` is a sentence built from it.
 */
export interface RankedCandidate {
  readonly candidate: RankCandidate
  /** Which step put this candidate above the NEXT one in the order, or `null` when it is last. */
  readonly decidedBy: RankStep | null
  readonly reason: string
}

/** R10: this candidate carries an explicit `deny` on a kind its run kind would otherwise have. A
 *  deny on a kind outside the baseline walls nothing off this work, and does not rank. */
function isWalled(candidate: RankCandidate, runKind: PermissionRunKind): boolean {
  const baseline: readonly PermissionKind[] = BASELINE_GRANTS[runKind]
  return candidate.deniedKinds.some((kind) => baseline.includes(kind))
}

/**
 * R9: a preference names this candidate AND this candidate can take the job.
 *
 * The `!busy` clause is the rule the ruling spends a paragraph on: position gives the preference
 * half its power (it is step 3, below permission, so it can never beat a person's explicit
 * refusal), and this gives the other half -- availability is step 4, which position does NOT
 * protect, so a preference for a busy candidate would park the work. Availability is not an
 * opinion; it is a fact about the world.
 *
 * Both halves must match when both are named: "Atlas, and on opus" is one decision and not two.
 */
function isPreferred(candidate: RankCandidate, context: RankContext): boolean {
  const preference = context.preference
  if (preference === null || candidate.busy) return false
  if (preference.templateId !== null && preference.templateId !== candidate.templateId) return false
  if (preference.model !== null && preference.model !== candidate.model) return false
  return preference.templateId !== null || preference.model !== null
}

/** A rate, or null when its own denominator is thin (R11) or absent. Null NEVER compares, which is
 *  what makes a thin record tie rather than decide. */
function rateOf(numerator: number | undefined, denominator: number | undefined): number | null {
  if (numerator === undefined || denominator === undefined) return null
  if (denominator < EVIDENCE_MIN_SAMPLE) return null
  return numerator / denominator
}

/** The three named rates of step 5, in R8's fixed order. `higherWins` is the half that differs: a
 *  review REJECTION is the one figure where less is better. */
const EVIDENCE_RATES: readonly {
  readonly clause: string
  readonly higherWins: boolean
  readonly of: (evidence: RankEvidence | null) => number | null
}[] = [
  {
    clause: 'passes verification first time more often',
    higherWins: true,
    of: (e) => rateOf(e?.firstPassPassed, e?.firstPassJudged),
  },
  {
    clause: 'is sent back in review less often',
    higherWins: false,
    of: (e) => rateOf(e?.reviewRejected, e?.reviewJudged),
  },
  {
    clause: 'gets work onto the base branch more often',
    higherWins: true,
    of: (e) => rateOf(e?.integrated, e?.integrationJudged),
  },
]

/** Step 6's two measures, in order. No sample floor: a MEDIAN is not a rate, and R11's threshold is
 *  about claims made from a denominator. A null ties. */
const COST_MEASURES: readonly {
  readonly clause: string
  readonly of: (evidence: RankEvidence | null) => number | null
}[] = [
  { clause: 'median run has cost less', of: (e) => e?.medianCostUsd ?? null },
  { clause: 'median run has finished sooner', of: (e) => e?.medianDurationMs ?? null },
]

/** The whole chain, as one comparison. Returns the sign AND the step that produced it, which is
 *  what lets the rationale be derived rather than invented. */
function compareStep(
  a: RankCandidate,
  b: RankCandidate,
  context: RankContext,
): { readonly order: number; readonly step: RankStep } {
  if (a.covers.length !== b.covers.length) {
    return { order: b.covers.length - a.covers.length, step: 'capability_fit' }
  }
  const walledA = isWalled(a, context.runKind)
  const walledB = isWalled(b, context.runKind)
  if (walledA !== walledB) return { order: walledA ? 1 : -1, step: 'permission' }

  const preferredA = isPreferred(a, context)
  const preferredB = isPreferred(b, context)
  if (preferredA !== preferredB) return { order: preferredA ? -1 : 1, step: 'preference' }

  if (a.busy !== b.busy) return { order: a.busy ? 1 : -1, step: 'availability' }

  for (const rate of EVIDENCE_RATES) {
    const left = rate.of(a.evidence)
    const right = rate.of(b.evidence)
    if (left === null || right === null || left === right) continue
    return { order: rate.higherWins ? right - left : left - right, step: 'evidence' }
  }

  for (const measure of COST_MEASURES) {
    const left = measure.of(a.evidence)
    const right = measure.of(b.evidence)
    if (left === null || right === null || left === right) continue
    return { order: left - right, step: 'cost_time' }
  }

  return { order: a.id.localeCompare(b.id), step: 'identity' }
}

/** The sentence for one adjacent pair. Every clause names a fact both candidates carry; nothing here
 *  is a judgement the function made up, and no clause contains a currency figure (erratum E10). */
function reasonFor(step: RankStep, above: RankCandidate, below: RankCandidate, context: RankContext): string {
  switch (step) {
    case 'capability_fit':
      return (
        `${above.name} covers ${String(above.covers.length)} of the capabilities still missing and ` +
        `${below.name} covers ${String(below.covers.length)}.`
      )
    case 'permission':
      return `${below.name} has been refused an operation this work needs, and ${above.name} has not.`
    case 'preference':
      return `somebody chose ${above.name} for ${context.capability}, and a person's choice comes before the record.`
    case 'availability':
      return `${above.name} is free and ${below.name} is busy.`
    case 'evidence': {
      const rate = EVIDENCE_RATES.find((one) => {
        const left = one.of(above.evidence)
        const right = one.of(below.evidence)
        return left !== null && right !== null && left !== right
      })
      return `${above.name} ${rate?.clause ?? 'has the stronger record'} than ${below.name}.`
    }
    case 'cost_time': {
      const measure = COST_MEASURES.find((one) => {
        const left = one.of(above.evidence)
        const right = one.of(below.evidence)
        return left !== null && right !== null && left !== right
      })
      return `${above.name}'s ${measure?.clause ?? 'record is cheaper'} than ${below.name}'s.`
    }
    case 'identity':
      return `nothing separates ${above.name} and ${below.name} but their names.`
  }
}

/**
 * The order the rules would staff this capability in (M53 R8) -- pure, total, deterministic, and
 * carrying no number anybody could sort by (R11).
 *
 * Six steps in the roadmap's order, and each one is a GATE rather than a weight: once a step has
 * separated two candidates the steps below it never run between them. That is what "user choices
 * win" means here and what bounds it -- a preference is step 3, so it beats the system's opinions
 * at 5 and 6 and never the person's own refusal at 2 nor the world's own fact at 4.
 *
 * `decide()` is not imported by this file, not read by it, and not changed by this milestone: this
 * function ranks a PROPOSAL a person will answer, and the scheduler goes on matching runtime roles.
 */
export function rankCandidates(
  candidates: readonly RankCandidate[],
  context: RankContext,
): readonly RankedCandidate[] {
  const ordered = [...candidates].toSorted((a, b) => compareStep(a, b, context).order)
  return ordered.map((candidate, index): RankedCandidate => {
    const next = ordered[index + 1]
    if (next === undefined) {
      return { candidate, decidedBy: null, reason: `${candidate.name} ranks last; nothing here ranks below them.` }
    }
    const { step } = compareStep(candidate, next, context)
    return { candidate, decidedBy: step, reason: reasonFor(step, candidate, next, context) }
  })
}
```

`packages/domain/src/capability/index.ts` gains `export * from './rank.js'` after `./team.js`.

- [ ] **Step 12: Run it and watch it pass**

Run: `npx vitest run packages/domain/test/capability/rank.test.ts`
Expected: PASS — 29 cases.

- [ ] **Step 13: Move `COST_PROVENANCE_WORD` into the domain (R6, erratum E14)**

Append to `packages/domain/src/guardrails/spend.ts`, immediately after `costProvenanceOf`:

```ts
/**
 * WHERE one run's figure came from, for a person (M51 R5, `docs/ia.md` rule 3).
 *
 * MOVED here from `apps/web/src/components/TaskDetailPanel.tsx:48` by M53 R6: the Evidence tab and
 * the task panel now read one table, and two homes for one label is the exact shape M52 erratum E12
 * refused for `resolveGrants`. A `Record<CostProvenance, string>` so a fourth provenance is a build
 * error here rather than a table cell printing a raw member; the three words happen to read the
 * same as the three keys -- they are English, not identifiers -- and the table exists so that stays
 * a choice rather than an accident.
 *
 * It is also the only total value over {@link CostProvenance} in the tree, which is why
 * `packages/db/test/integration/enum-parity.test.ts` pins the `EvidenceCostProvenance` Postgres
 * enum against its keys (M53 plan erratum E14).
 *
 * `provenanceWordFor` does NOT move: "estimated so far" is a fact about a LIVE run, and the
 * Evidence tab has none -- every row on it is a concluded run.
 */
export const COST_PROVENANCE_WORD: Record<CostProvenance, string> = {
  reported: 'reported',
  estimated: 'estimated',
  unmeasured: 'unmeasured',
}
```

`apps/web/src/components/TaskDetailPanel.tsx` deletes its local const (`:41-52`) and adds `COST_PROVENANCE_WORD` to the existing `@slave-of-ai/domain` import; `provenanceWordFor` (`:64-68`) is otherwise untouched.

Two assertions land in `packages/domain/test/guardrails/spend.test.ts`:

```ts
describe('COST_PROVENANCE_WORD (M53 R6)', () => {
  it('gives every provenance a word, so no money surface prints the key', () => {
    expect(COST_PROVENANCE_WORD).toEqual({
      reported: 'reported',
      estimated: 'estimated',
      unmeasured: 'unmeasured',
    })
  })

  it('is total over what `costProvenanceOf` can answer -- the only value list of that type there is', () => {
    const measured = costProvenanceOf({ costUsd: 1, provider: 'claude_code', status: 'succeeded', tokensIn: null, tokensOut: null, model: null })
    const unmeasured = costProvenanceOf({ costUsd: null, provider: 'cursor', status: 'succeeded', tokensIn: null, tokensOut: null, model: null })
    for (const provenance of [measured, unmeasured]) {
      expect(COST_PROVENANCE_WORD[provenance], provenance).toBeTruthy()
    }
  })
})
```

Run: `npx vitest run packages/domain/test/guardrails/spend.test.ts`
Expected: PASS.

- [ ] **Step 14: Write the failing tests for the fifty-ninth event and its lane**

`packages/domain/test/events/schema.test.ts` gains:

```ts
describe('staffing.preference_changed (M53 R9)', () => {
  const base = { seq: 1, ts: new Date().toISOString(), workspaceId: 'w1', actor: 'human' as const }

  it('accepts a preference set from nothing to a template and a model', () => {
    const parsed = parseExecutionEvent({
      ...base,
      type: 'staffing.preference_changed',
      payload: {
        capability: 'backend.services',
        capabilityLabel: 'Services',
        from: null,
        to: { templateId: 't1', templateName: 'Backend Developer', model: 'opus' },
        by: 'u1',
      },
    })
    expect(parsed.ok).toBe(true)
  })

  it('accepts a CLEAR -- `to: null` is back to "nobody has asked for anybody"', () => {
    const parsed = parseExecutionEvent({
      ...base,
      type: 'staffing.preference_changed',
      payload: {
        capability: 'backend.services',
        capabilityLabel: 'Services',
        from: { templateId: 't1', templateName: 'Backend Developer', model: null },
        to: null,
        by: null,
      },
    })
    expect(parsed.ok).toBe(true)
  })

  it('carries the LABEL beside the key, so a card prints a word without a join', () => {
    const parsed = parseExecutionEvent({
      ...base,
      type: 'staffing.preference_changed',
      payload: { capability: 'backend.services', from: null, to: { templateId: 't1', templateName: 'X', model: null }, by: null },
    })
    expect(parsed.ok).toBe(false)
  })

  it('refuses an unknown key -- `.strict()`, so a debug field can never reach this row', () => {
    const parsed = parseExecutionEvent({
      ...base,
      type: 'staffing.preference_changed',
      payload: {
        capability: 'backend.services',
        capabilityLabel: 'Services',
        from: null,
        to: null,
        by: null,
        why: 'because',
      },
    })
    expect(parsed.ok).toBe(false)
  })

  it('allows a side that names a MODEL and no template -- "on opus, whoever it is"', () => {
    const parsed = parseExecutionEvent({
      ...base,
      type: 'staffing.preference_changed',
      payload: {
        capability: 'backend.services',
        capabilityLabel: 'Services',
        from: null,
        to: { templateId: null, templateName: null, model: 'opus' },
        by: 'u1',
      },
    })
    expect(parsed.ok).toBe(true)
  })
})
```

`packages/domain/test/supervisor/timeline.test.ts` moves its count and gains one case:

```ts
  it('lanes every event type -- 59 as of M53', () => {
    expect(Object.keys(LANE_BY_TYPE)).toHaveLength(59)
  })

  it('puts a staffing preference on NO lane -- project configuration is not the organisation story', () => {
    // The `org.changed` precedent (`timeline.ts:132`): an operator changed how this project will be
    // staffed, which belongs on the Activity page and not in the six-lane narrative of what the
    // project decided and verified.
    expect(LANE_BY_TYPE['staffing.preference_changed']).toBeNull()
  })
```

- [ ] **Step 15: Run them and watch them fail**

Run: `npx vitest run packages/domain/test/events/schema.test.ts packages/domain/test/supervisor/timeline.test.ts`
Expected: FAIL — the five parse cases fail (the union has no such arm, so every parse is `ok: false`, which flips three of them), and the lane file fails on `toHaveLength(59)` (58) plus the `LANE_BY_TYPE` key completeness case.

- [ ] **Step 16: Write the event arm, the lane and the enum map**

`packages/domain/src/events/schema.ts`, appended as the last arm of the union, after `permission.changed`:

```ts
  z.object({
    ...envelope,
    type: z.literal('staffing.preference_changed'),
    /**
     * M53 R9: a person said who -- or what model -- should take one capability on this project, or
     * took that decision back.
     *
     * A new type rather than `org.changed { entity: 'staffing' }`, for `permission.changed`'s own
     * reason (M52 R5): `org.changed`'s `field` union is spelled in four places (M50 erratum E11)
     * and its payload has no room for the from/to/by triple this card has to print. And a staffing
     * preference is not a roster change: nobody was hired, nobody was renamed, and nothing about
     * who is here moved.
     *
     * `from` and `to` are each a `{ templateId, templateName, model }` triple or `null`, and `null`
     * on `to` is a CLEAR: back to "nobody has asked for anybody", the state the table expresses by
     * having no row. `templateName` and `capabilityLabel` ride along for `permission.changed`'s
     * reason: a card must print words without a join, and a renamed or deleted template must not
     * rewrite history.
     *
     * `.strict()` on both the payload and the two sides: this row is newborn, nothing has ever
     * written another key into it, and a permissive object is how a debug field becomes a column.
     */
    payload: z
      .object({
        capability: z.string().min(1),
        capabilityLabel: z.string().min(1),
        from: staffingPreferenceSide,
        to: staffingPreferenceSide,
        by: z.string().min(1).nullable(),
      })
      .strict(),
  }),
```

with, immediately above the union (beside the other shared shapes):

```ts
/** One side of a staffing preference change (M53 R9). Null is "nobody has asked for anybody". */
const staffingPreferenceSide = z
  .object({
    templateId: z.string().min(1).nullable(),
    templateName: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
  })
  .strict()
  .nullable()
```

`packages/domain/src/supervisor/timeline.ts`'s `LANE_BY_TYPE` gains, in the `null` block beside `'org.changed'`:

```ts
  // M53 R9: what a person asked for about STAFFING is project configuration, beside `org.changed`
  // -- the Activity page keeps it, and the six-lane timeline is the story of what the project
  // decided and verified, which a preference is not part of.
  'staffing.preference_changed': null,
```

`packages/db/src/enums.ts`'s `EVENT_TYPE_BY_DOMAIN_TYPE` gains, last:

```ts
  'staffing.preference_changed': 'staffing_preference_changed',
```

- [ ] **Step 17: Run them and watch them pass**

Run: `npx vitest run packages/domain/test/events/schema.test.ts packages/domain/test/supervisor/timeline.test.ts`
Expected: PASS. The `LANE_BY_TYPE` completeness case (`Object.keys(LANE_BY_TYPE).sort()` vs `Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE).sort()`) is what proves all three of those edits agree.

- [ ] **Step 18: Write the failing enum-parity assertions**

`packages/db/test/integration/enum-parity.test.ts` gains, beside the others:

```ts
  // M53 R3: the two enums the fact table is typed on. The first is derived rather than spelled --
  // `EVIDENCE_OUTCOMES` is RunStatus minus the non-terminal statuses, and asserting that against
  // Postgres is what stops a tenth `RunStatus` member quietly becoming an outcome nobody decided on.
  it('EvidenceOutcome matches EVIDENCE_OUTCOMES, member for member', async () => {
    expect(await enumValues('EvidenceOutcome')).toEqual([...EVIDENCE_OUTCOMES].sort())
  })

  // M53 plan erratum E14: `CostProvenance` is a TYPE, so the only total value over it in the tree
  // is `COST_PROVENANCE_WORD` -- which R6 moved into the domain beside the type for exactly this.
  it('EvidenceCostProvenance matches CostProvenance member for member, via the one label table', async () => {
    expect(await enumValues('EvidenceCostProvenance')).toEqual(Object.keys(COST_PROVENANCE_WORD).sort())
  })
```

with `COST_PROVENANCE_WORD` and `EVIDENCE_OUTCOMES` added to the `@slave-of-ai/domain` import at the top of the file.

- [ ] **Step 19: Run them and watch them fail**

Run: `npx vitest run packages/db/test/integration/enum-parity.test.ts`
Expected: FAIL — `type "EvidenceOutcome" does not exist`. (The `EventType` case fails too, for the same reason: `EVENT_TYPE_BY_DOMAIN_TYPE` now has 59 keys and the database's enum has 58.)

- [ ] **Step 20: Write the schema**

`packages/db/prisma/schema.prisma`. Two enums, beside `PermissionKind` / `CredentialKind`:

```prisma
/// M53 R3: how a run ENDED, as evidence sees it -- exactly the three terminal members of
/// `RunStatus`, closed. The TypeScript twin is `EVIDENCE_OUTCOMES`
/// (`packages/domain/src/evidence/outcome.ts`) and `enum-parity.test.ts` proves they are the same
/// list. `stopped` is kept apart from `failed` on purpose: an operator's cancel is not the system
/// failing, and folding the two would charge a worker's record for a person's decision.
enum EvidenceOutcome {
  succeeded
  failed
  stopped
}

/// M53 R6: where an evidence row's money figure came from -- M51's own three-way split, stored
/// beside the figure so a table can print the word without re-deriving it per row. The TypeScript
/// twin is `CostProvenance`, pinned through `COST_PROVENANCE_WORD` (plan erratum E14).
enum EvidenceCostProvenance {
  reported
  estimated
  unmeasured
}
```

The fact table, after `SlaveRun`:

```prisma
/// M53 R3: ONE ROW PER CONCLUDED RUN, and the whole of what this organisation knows about how its
/// workers actually perform.
///
/// A FACT TABLE and never a rollup: every rate any surface shows is a `GROUP BY` over this, because
/// a rollup is a second copy of a derived number and something eventually has to keep the two in
/// step. The identity is four dimensions -- (`profileKey`, `model`, `repositoryKey`, `domains`) --
/// and `workspaceId` rides beside them as a COLUMN rather than a dimension, so every fact can be
/// traced back to the project that produced it without the project becoming part of the question.
///
/// APPEND-ONLY, in three separate senses, each enforced by `recordRunEvidence` and none by a
/// trigger: a row is never deleted, its dimension keys and run-local measurements are never
/// rewritten to a different value, and a judgement column moves from null to a verdict exactly once
/// and never back.
///
/// ONE RELATION, and it is to `Workspace` (plan erratum E4). There is deliberately no foreign key
/// to `SlaveRun`, `Slave` or `Task`: evidence must OUTLIVE all three -- `profileName` is a snapshot
/// for exactly that reason -- and a cascade from any of them would destroy the record the first
/// time an operator deleted a worker. The workspace relation is not a lifecycle rule (nothing in
/// this product deletes a `Workspace`); it is what makes `db:seed`'s `TRUNCATE ... CASCADE` reach
/// this table.
model EvidenceRecord {
  id          String @id @default(uuid())
  /// The run this fact is ABOUT. `@unique` is the whole idempotence story: a sweep racing a pump to
  /// conclude one run cannot make two rows, and R7's backfill upserts on it.
  runId       String @unique
  workspaceId String
  slaveId     String
  /// Null for a `planning` run (M8b), which has no task and counts toward `general`.
  taskId      String?
  /// R1: `template:<SlaveTemplate.id>` for a hired worker, `slave:<Slave.id>` for a hand-made one.
  /// Never null -- there is always a profile.
  profileKey  String
  /// The template's or the worker's NAME as it read at write time. One column beyond the four
  /// dimensions, and the price of "labels never keys": `hiredFromTemplateId` is `onDelete: SetNull`,
  /// so a deleted template would otherwise strand a key pointing at nothing, and a surface must
  /// print a word without a join.
  profileName String
  /// `SlaveRun.model` -- the SPAWN-TIME snapshot, never re-derived from the profile chain, because a
  /// resume replays `checkpoint.model` verbatim and the question is what this run actually used.
  /// NULLABLE, and that is the one asymmetry with the profile: a pre-M51 run recorded none, and
  /// inventing a name for it would invent a fact. The by-model table prints the null group as
  /// `Model not recorded`; the ranker skips it entirely.
  model       String?
  /// `Workspace.repoPath`, normalised and snapshotted, so two projects on one checkout share a
  /// record and a later `repoPath` edit does not rewrite the past.
  repositoryKey String
  /// R2: every domain this run's task asked for, or the single reserved `general`. NEVER EMPTY, and
  /// never one row per pair: a domain is a FILTER on the tables, never a group key -- a count under
  /// a domain chip is "runs that touched this domain", and no total is ever computed by adding the
  /// domains up.
  domains     String[]
  runKind     RunKind
  /// R4: the number of `task.rework` events for this task below this run's own `run.started`, plus
  /// one. DERIVED and never carried on an event -- no event gained an `attempt` field and `SlaveRun`
  /// gained no `attempt` column, which M51 §3 already refused once.
  attempt     Int
  outcome     EvidenceOutcome
  /// R4: the three JUDGEMENT columns. Null is "nobody has judged this yet" -- the `SlaveRun.costUsd`
  /// nullability precedent, never a false `false`. A REVIEW run's row and a PLANNING run's row keep
  /// all three null forever: a reviewer receives no verdict.
  verifiedFirstPass Boolean?
  reviewRejected    Boolean?
  integrated        Boolean?
  /// The `task.rework` events appended after this run started. 0 or 1 in today's pipeline; an Int
  /// and not a Boolean because nothing guarantees one and a column that could silently be 2 must be
  /// able to say so.
  reworkCycles      Int @default(0)
  /// R5: `run.pause_requested` + `run.resume_requested` + an OPERATOR's stop. Closed and bounded to
  /// this run's own stream.
  humanInterventions Int @default(0)
  /// R5: the sweep concluded this run (one), plus every `task.unblocked` after it started. A breaker
  /// de-escalation is NOT one of these -- M51 R2 made it silent on purpose.
  recoveries        Int @default(0)
  durationMs        Int?
  /// R6: the reported figure when reported, the estimate when estimable, and NULL when neither --
  /// never a zero standing in for a gap.
  actualCostUsd     Float?
  costProvenance    EvidenceCostProvenance
  /// Set once, on INSERT, and never rewritten -- which is what makes the backfill's second pass
  /// byte-equal to its first.
  recordedAt        DateTime @default(now())
  /// When the FIRST of the three judgement columns settled (plan erratum E1). Three columns settle
  /// from three different moments, so one stamp cannot mean "the settle"; this one means "somebody
  /// has judged this run at least once", and each column carries its own null-or-verdict.
  settledAt         DateTime?

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  /// The ranker's read: `WHERE profileKey = ANY(...)`, grouped by the first three dimensions.
  @@index([profileKey, model, repositoryKey])
  @@index([workspaceId])
  /// The domain facet's only possible index: a btree cannot answer an array containment predicate,
  /// and containment is the only way `domains` is ever read. The FIRST `type:` index in this schema
  /// (plan erratum E5) -- if Prisma rejects this form the index is not created at all, because an
  /// index the schema cannot name breaks the milestone's own `migrate diff` proof.
  @@index([domains(ops: ArrayOps)], type: Gin)
}

/// M53 R9: ONE decision per capability per project -- who should take this work, or on what model,
/// or both ("Atlas, and on opus").
///
/// At least one of `templateId` / `model` is non-null; a row naming neither is refused by
/// `setStaffingPreference` as `invalid_staffing_preference` rather than stored as a preference for
/// nothing. `templateId` is a plain column and NOT a relation, the `CollaborationHint.capability`
/// precedent: a preference must survive the deletion of a template it happens to name, and
/// `rankCandidates` matching on an id nothing answers is simply a preference nobody satisfies.
///
/// `setBy` holds a `User.id`, exactly as `SlavePermission.grantedBy` does, and every visible surface
/// resolves it to a username at its own boundary (M52 erratum E18).
model StaffingPreference {
  id          String   @id @default(uuid())
  workspaceId String
  /// A taxonomy key. A plain column for `CollaborationHint.capability`'s reason -- a preference must
  /// survive a taxonomy row being renamed out from under it.
  capability  String
  templateId  String?
  model       String?
  setBy       String?
  setAt       DateTime @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  /// One decision per capability per project. Its leading column is `workspaceId`, so the loader's
  /// `WHERE "workspaceId" = $1` is served from this index and a second one would be a second write
  /// on every preference change for no read.
  @@unique([workspaceId, capability])
}
```

`Workspace` gains two back-relations beside its others:

```prisma
  /// M53 R3/R9: the facts this project's runs produced, and the staffing decisions taken about it.
  evidence            EvidenceRecord[]
  staffingPreferences StaffingPreference[]
```

and `EventType` gains, last:

```prisma
  /// M53 R9: a person said who -- or what model -- should take one capability on this project, or
  /// took that decision back. `to: null` is the clear.
  staffing_preference_changed @map("staffing.preference_changed")
```

- [ ] **Step 21: Validate the schema, write the migration, apply it to BOTH databases, and prove the diff**

The order matters and the first command is erratum E5's whole point — the GIN form is validated BEFORE a migration is generated from it:

```bash
npx prisma validate --config packages/db/prisma.config.ts
```

Expected: "The schema at packages/db/prisma/schema.prisma is valid". **If it instead rejects `@@index([domains(ops: ArrayOps)], type: Gin)`**, delete that one `@@index` line, re-run `prisma validate`, carry the GIN index as backlog, say so in the task report, and drop the corresponding `CREATE INDEX` from the SQL below. Do NOT hand-write the index into the migration: an index in the database that the schema does not name comes back from `migrate diff` as a `DROP INDEX`, and the milestone's "No difference detected" proof fails from then on.

`packages/db/prisma/migrations/20260913090000_m53_evidence/migration.sql`:

```sql
-- M53: the fact table, the staffing decision, and one event type.
--
-- ADDITIVE ONLY, and with NO DATA STATEMENT AT ALL -- the one difference from M52's migration in
-- this directory. Two enums, two tables, three indexes and one `EventType` member; every existing
-- row, column, index and constraint is untouched. The HISTORY arrives from
-- `scripts/backfill-evidence.mjs` (R7), run once by an operator, which calls the same
-- `recordRunEvidence` the pipeline calls -- so there is one derivation rather than a second one
-- written in SQL that could disagree with it. That is ADR 0003's discipline and not a style choice.

CREATE TYPE "EvidenceOutcome" AS ENUM ('succeeded', 'failed', 'stopped');
CREATE TYPE "EvidenceCostProvenance" AS ENUM ('reported', 'estimated', 'unmeasured');

CREATE TABLE "EvidenceRecord" (
  "id"                 TEXT NOT NULL,
  "runId"              TEXT NOT NULL,
  "workspaceId"        TEXT NOT NULL,
  "slaveId"            TEXT NOT NULL,
  "taskId"             TEXT,
  "profileKey"         TEXT NOT NULL,
  "profileName"        TEXT NOT NULL,
  "model"              TEXT,
  "repositoryKey"      TEXT NOT NULL,
  "domains"            TEXT[],
  "runKind"            "RunKind" NOT NULL,
  "attempt"            INTEGER NOT NULL,
  "outcome"            "EvidenceOutcome" NOT NULL,
  "verifiedFirstPass"  BOOLEAN,
  "reviewRejected"     BOOLEAN,
  "integrated"         BOOLEAN,
  "reworkCycles"       INTEGER NOT NULL DEFAULT 0,
  "humanInterventions" INTEGER NOT NULL DEFAULT 0,
  "recoveries"         INTEGER NOT NULL DEFAULT 0,
  "durationMs"         INTEGER,
  "actualCostUsd"      DOUBLE PRECISION,
  "costProvenance"     "EvidenceCostProvenance" NOT NULL,
  "recordedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt"          TIMESTAMP(3),
  CONSTRAINT "EvidenceRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EvidenceRecord_runId_key" ON "EvidenceRecord"("runId");
CREATE INDEX "EvidenceRecord_profileKey_model_repositoryKey_idx" ON "EvidenceRecord"("profileKey", "model", "repositoryKey");
CREATE INDEX "EvidenceRecord_workspaceId_idx" ON "EvidenceRecord"("workspaceId");
-- The first GIN index in this schema. A btree cannot answer `domains && ARRAY[...]`, which is the
-- only way the domain facet is ever read.
CREATE INDEX "EvidenceRecord_domains_idx" ON "EvidenceRecord" USING GIN ("domains" array_ops);
ALTER TABLE "EvidenceRecord" ADD CONSTRAINT "EvidenceRecord_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StaffingPreference" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "capability"  TEXT NOT NULL,
  "templateId"  TEXT,
  "model"       TEXT,
  "setBy"       TEXT,
  "setAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StaffingPreference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StaffingPreference_workspaceId_capability_key" ON "StaffingPreference"("workspaceId", "capability");
ALTER TABLE "StaffingPreference" ADD CONSTRAINT "StaffingPreference_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `IF NOT EXISTS`, and on its own statement: Postgres refuses `ALTER TYPE ... ADD VALUE` inside a
-- transaction block that then uses the new value, and Prisma runs a migration file as one
-- transaction -- the idiom every earlier migration in this directory uses for the same reason.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'staffing.preference_changed';
```

Then, in this order:

```bash
npm run db:migrate
npm run db:migrate:test
npm run db:generate
npx tsc --build
npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
```

Expected on the last: **"No difference detected"**. If it reports a `DROP INDEX "EvidenceRecord_domains_idx"`, Prisma did not round-trip the GIN form after all — take erratum E5's fallback (drop both the `@@index` line and the `CREATE INDEX`, re-run `db:migrate`, carry it as backlog) rather than leaving the proof broken.

- [ ] **Step 22: Run the parity tests and watch them pass**

Run: `npx vitest run packages/db/test/integration/enum-parity.test.ts`
Expected: PASS, including the `EventType` case, which is what proves `schema.prisma`, the migration and `EVENT_TYPE_BY_DOMAIN_TYPE` agree about all fifty-nine.

- [ ] **Step 23: The card, the filter and the sentence — all nine sites, in this task (erratum E13)**

`apps/web/src/components/activity/cards.tsx`, beside `PermissionChangedCard`:

```tsx
/**
 * M53 R9: a person decided who -- or what model -- should take one capability on this project.
 *
 * Registered HERE rather than in the web task, because `ACTIVITY_CARDS`' `satisfies` is exhaustive
 * over `DomainEventType` and a type with no card fails the BUILD (plan erratum E13).
 *
 * The card prints the capability's LABEL and the template's NAME, both off the payload -- a row read
 * a year from now says what it was about in the vocabulary of the day it was written, and neither
 * needs a join. The keys stay in `title` and on `data-capability` (`docs/ia.md` rule 3).
 */
function StaffingPreferenceChangedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    capability: string
    capabilityLabel: string
    from: { templateId: string | null; templateName: string | null; model: string | null } | null
    to: { templateId: string | null; templateName: string | null; model: string | null } | null
    by: string | null
  }
  // "Atlas", "opus", "Atlas on opus", or the word for a side that is not there at all.
  const sideOf = (side: typeof payload.to): string => {
    if (side === null) return 'nobody in particular'
    if (side.templateName !== null && side.model !== null) return `${side.templateName} on ${side.model}`
    return side.templateName ?? side.model ?? 'nobody in particular'
  }
  return (
    <ActivityCard {...props}>
      <Transition tone={payload.to === null ? 'idle' : 'working'} label="staffing preference">
        <span
          data-testid="staffing-preference-text"
          title={payload.capability}
          data-capability={payload.capability}
        >
          {`${payload.capabilityLabel} · ${sideOf(payload.from)} → ${sideOf(payload.to)}`}
        </span>
        {payload.by !== null && (
          <span data-testid="staffing-preference-by" title={payload.by}>
            {` · by ${props.userName ?? 'a person no longer on record'}`}
          </span>
        )}
      </Transition>
    </ActivityCard>
  )
}
```

and the registry gains `'staffing.preference_changed': StaffingPreferenceChangedCard,`.

`apps/web/src/lib/activityFilters.ts`'s `TYPES_BY_KIND.workspace` gains, after `'permission.changed'`:

```ts
    // M53 R9: who should take a capability is project CONFIGURATION, beside `org.changed` and
    // `permission.changed` -- it carries no taskId, it is not a run outcome, and an operator asking
    // "what changed about this project" is who reads it.
    'staffing.preference_changed',
```

`apps/web/src/server/timeline.ts` gains a case beside `permission.changed`'s:

```ts
    case 'staffing.preference_changed': {
      const capabilityLabel = payload['capabilityLabel']
      const what = typeof capabilityLabel === 'string' && capabilityLabel !== '' ? capabilityLabel.toLowerCase() : 'a capability'
      const to = payload['to']
      if (to === null) return `stopped asking for anybody in particular on ${what}`
      const named = typeof to === 'object' && to !== null ? (to as { templateName?: unknown; model?: unknown }) : {}
      const who =
        typeof named.templateName === 'string' && named.templateName !== ''
          ? named.templateName
          : typeof named.model === 'string' && named.model !== ''
            ? named.model
            : 'somebody'
      return `asked for ${who} on ${what}`
    }
```

`apps/web/test/activity-cards.test.tsx`'s `PAYLOAD_BY_TYPE` gains:

```ts
  'staffing.preference_changed': {
    capability: 'backend.services',
    capabilityLabel: 'Services',
    from: null,
    to: { templateId: 't1', templateName: 'Backend Developer', model: 'opus' },
    by: 'u1',
  },
```

and one case of its own:

```tsx
  it('prints the capability label and the template name, never their keys (M53 R9)', () => {
    render(cardFor('staffing.preference_changed'))
    const text = screen.getByTestId('staffing-preference-text')
    expect(text.textContent).toContain('Services')
    expect(text.textContent).toContain('Backend Developer on opus')
    expect(text.textContent).not.toContain('backend.services')
    expect(text.getAttribute('data-capability')).toBe('backend.services')
  })
```

- [ ] **Step 24: Run the two web suites and watch them pass**

Run: `npx vitest run apps/web/test/activity-cards.test.tsx apps/web/test/activityFilters.test.ts`
Expected: PASS, including `activityFilters.test.ts`'s runtime completeness case — which is the assertion that would have caught this edit being deferred.

- [ ] **Step 25: Run the whole suite**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: ≥ 338 files / ≥ 5642 tests, zero failures. Two things to look for specifically, both of which only the full suite can see: `packages/domain/test/supervisor/fixtures.test.ts` and every `SupervisorWorld` fixture still compile (this task added no world field, so they must be untouched), and no test anywhere asserts a 58 that this task moved.

- [ ] **Step 26: Ladder and commit**

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
pgrep -af "next dev"   # must be empty
npm run web:build
```

Then:

```bash
git add packages/domain packages/db apps/web/src/components/activity/cards.tsx apps/web/src/lib/activityFilters.ts apps/web/src/server/timeline.ts apps/web/src/components/TaskDetailPanel.tsx apps/web/test
git commit -m "$(cat <<'EOF'
feat(domain): m53 t1 — a fact with four dimensions, six steps that are not a score, and two empty tables

`EvidenceRecord` is one row per concluded run and the whole of what this organisation will know
about how its workers actually perform: who, on what model, in which repository, in which domains,
which attempt, how it ended, and three judgement columns that carry "nobody has judged this yet" as
null rather than as a false `false`. Nothing writes into it yet -- the pipeline is the next task,
deliberately, because a migration that adds a fact table and a pump that starts filling it are two
things a reviewer should read one at a time.

The pure half is the milestone's claim made into code. `packages/domain/src/evidence/derive.ts`
turns counts into columns with no I/O at all, so the backfill and the pipeline cannot disagree about
what a row means; `capability/rank.ts` applies the roadmap's six steps as a comparator chain whose
result carries no score, no rating, no rank and no weighted total -- a test walks its own properties
looking for one. `EVIDENCE_MIN_SAMPLE` is five and it is the only threshold this milestone owns.

`staffing.preference_changed` is the fifty-ninth event and pays all nine sites here, the card
included: `ACTIVITY_CARDS` is exhaustive over `DomainEventType`, so deferring the card would leave
four tasks unable to typecheck. `COST_PROVENANCE_WORD` moved out of `TaskDetailPanel` into
`guardrails/spend.ts` beside the type it is total over, which is also now the only thing in the tree
able to pin the new `EvidenceCostProvenance` enum.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"
```

---

### Task 2: The verbs — one writer, one settler, three reads, a preference a person sets, and a boundary that names three nouns (R3, R4, R5, R6, R9, R10, R13, E1, E2, E3, E6, E7, E8, D13–D20)

`packages/control` only, plus the one refusal kind's third home in `apps/web/test/`. After this task the fact table can be written, settled and read, and a person can express a preference — but nothing in the orchestrator calls any of it yet and no surface shows it. `apps/orchestrator` and `apps/web/src` are in no file list here.

**Files:**
- Create: `packages/control/src/evidence.ts`, `packages/control/src/staffing.ts`, `packages/control/test/integration/evidence.test.ts`, `packages/control/test/integration/staffing.test.ts`
- Modify: `packages/control/src/refusal.ts`, `packages/control/src/supervisorWorld.ts`, `packages/control/src/integration.ts`, `packages/control/src/index.ts`, `packages/domain/src/supervisor/world.ts`, `packages/domain/src/supervisor/candidates.ts`, `packages/control/test/simulation-boundary.test.ts`, `apps/web/test/refusal-status.test.ts`
- Test: the two new integration files, plus `packages/control/test/integration/supervisorWorld.test.ts`, `packages/control/test/integration/integration.test.ts`, `packages/control/test/simulation-boundary.test.ts`, `packages/domain/test/supervisor/fixtures.test.ts`, `apps/web/test/refusal-status.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produced (`profileKeyOf`, `normaliseRepositoryKey`, `attemptFrom`, `verifiedFirstPassFrom`, `reviewRejectedFrom`, `reworkCyclesFrom`, `humanInterventionsFrom`, `recoveriesFrom`, `durationMsFrom`, `actualCostFrom`, `domainsFor`, `evidenceOutcomeOf`, `RankEvidence`, `EVIDENCE_MIN_SAMPLE`), plus `prisma` (`@slave-of-ai/db/client`), `appendEvent` (`@slave-of-ai/events`), `Principal` (`packages/control/src/principal.ts`), `capabilityLabel` and `PermissionKind`.
- Produces, for Tasks 3–6:
  - `recordRunEvidence(runId: string, opts?: RecordRunEvidenceOptions): Promise<Result<void, ControlRefusal>>`, `type RecordRunEvidenceOptions = { readonly recoveredBySweep?: boolean; readonly settle?: EvidenceSettle }`
  - `type EvidenceSettle = { kind: 'verify'; verdict: 'passed' | 'failed' } | { kind: 'review'; verdict: 'approved' | 'rejected'; attempt: number | null } | { kind: 'integration'; integrated: boolean }`
  - `settleTaskEvidence(taskId: string, settle: EvidenceSettle): Promise<void>`
  - `evidenceByProfile(filter: EvidenceFilter): Promise<readonly EvidenceProfileGroup[]>`, `evidenceByModel(filter: EvidenceFilter): Promise<readonly EvidenceModelGroup[]>`, `listEvidence(filter: EvidenceFilter): Promise<readonly EvidenceRow[]>`, `evidenceForProfiles(profileKeys: readonly string[]): Promise<ReadonlyMap<string, RankEvidence>>`
  - `type EvidenceFilter = { readonly domain?: string | null; readonly workspaceId?: string | null; readonly limit?: number }`
  - `setStaffingPreference(workspaceId, input: { capability: string; templateId?: string | null; model?: string | null }, principal?): Promise<Result<StaffingPreferenceView, ControlRefusal>>`, `clearStaffingPreference(workspaceId, capability, principal?)`, `listStaffingPreferences(workspaceId): Promise<readonly StaffingPreferenceView[]>`
  - `ControlRefusal` gains `{ kind: 'invalid_staffing_preference'; capability: string }`
  - `SupervisorWorld.staffingPreferences`, `SupervisorWorld.evidence`, `SupervisorSlave.{deniedKinds,hiredFromTemplateId,model}`, `SupervisorCompanyWorker.templateId`, `SupervisorCatalogEntry.defaultModel`

- [ ] **Step 1: Write the failing integration test for the one writer**

`packages/control/test/integration/evidence.test.ts`. A fixture that seeds a workspace, a template, a hired worker and a task, concludes a run by hand, and asserts every column.

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { recordRunEvidence, settleTaskEvidence } from '../../src/evidence.js'
import { seedEvidenceFixture, type EvidenceFixture } from './fixtures/evidence.js'

let fixture: EvidenceFixture
beforeEach(async () => {
  fixture = await seedEvidenceFixture()
})

describe('recordRunEvidence (M53 R1, R3)', () => {
  it('writes ONE row keyed on the four dimensions, with the profile name snapshotted', async () => {
    const result = await recordRunEvidence(fixture.runId)
    expect(result.ok).toBe(true)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.profileKey).toBe(`template:${fixture.templateId}`)
    expect(row.profileName).toBe('Backend Developer')
    expect(row.model).toBe('claude-sonnet-4-20250514')
    expect(row.repositoryKey).toBe(fixture.repoPath)
    expect(row.domains).toEqual(['backend'])
    expect(row.workspaceId).toBe(fixture.workspaceId)
    expect(row.runKind).toBe('implementation')
    expect(row.outcome).toBe('succeeded')
  })

  it('keys a HAND-MADE worker on itself -- there is always a profile (R1)', async () => {
    await prisma.slave.update({ where: { id: fixture.slaveId }, data: { hiredFromTemplateId: null, name: 'Sam' } })
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.profileKey).toBe(`slave:${fixture.slaveId}`)
    expect(row.profileName).toBe('Sam')
  })

  it('writes nothing for a run that has not concluded -- a live run is evidence about nothing', async () => {
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { status: 'working', terminalAt: null, endedAt: null } })
    const result = await recordRunEvidence(fixture.runId)
    expect(result.ok).toBe(true)
    expect(await prisma.evidenceRecord.count({ where: { runId: fixture.runId } })).toBe(0)
  })

  it('is IDEMPOTENT: two calls leave one row, and `recordedAt` is never rewritten (R7, erratum E15)', async () => {
    await recordRunEvidence(fixture.runId)
    const first = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    await recordRunEvidence(fixture.runId)
    const second = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(await prisma.evidenceRecord.count()).toBe(1)
    expect(second).toEqual(first)
  })

  it('refuses a runId that names no run, writing nothing (R13, erratum E3)', async () => {
    const result = await recordRunEvidence('00000000-0000-0000-0000-000000000000')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.kind).toBe('run_not_found')
    expect(await prisma.evidenceRecord.count()).toBe(0)
  })

  it('counts a run toward EVERY domain its task asked for, in ONE row (R2)', async () => {
    await prisma.task.update({
      where: { id: fixture.taskId },
      data: { requiredCapabilities: ['backend.services', 'qa.test-automation'] },
    })
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.domains).toEqual(['backend', 'qa'])
    expect(await prisma.evidenceRecord.count()).toBe(1)
  })

  it('counts a task-less planning run toward `general` (R2)', async () => {
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { taskId: null, kind: 'planning' } })
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.domains).toEqual(['general'])
    expect(row.taskId).toBeNull()
  })

  it('derives the attempt from the reworks BELOW this run started (R4)', async () => {
    // Two reworks before the run, one after: attempt 3, rework cycles 1.
    await appendEvent({ type: 'task.rework', workspaceId: fixture.workspaceId, taskId: fixture.taskId, actor: 'system', payload: { reason: 'a', attempt: 1 } })
    await appendEvent({ type: 'task.rework', workspaceId: fixture.workspaceId, taskId: fixture.taskId, actor: 'system', payload: { reason: 'b', attempt: 2 } })
    await appendEvent({ type: 'run.started', workspaceId: fixture.workspaceId, taskId: fixture.taskId, slaveId: fixture.slaveId, runId: fixture.runId, actor: 'system', payload: { sessionId: 's' } })
    await appendEvent({ type: 'task.rework', workspaceId: fixture.workspaceId, taskId: fixture.taskId, actor: 'system', payload: { reason: 'c', attempt: 3 } })
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.attempt).toBe(3)
    expect(row.reworkCycles).toBe(1)
  })

  it('counts an operator stop and the two pause/resume requests as interventions, and a sweep stop as none (R5)', async () => {
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { status: 'stopped', stopRequestedBy: 'meren' } })
    await appendEvent({ type: 'run.started', workspaceId: fixture.workspaceId, slaveId: fixture.slaveId, runId: fixture.runId, actor: 'system', payload: { sessionId: 's' } })
    await appendEvent({ type: 'run.pause_requested', workspaceId: fixture.workspaceId, slaveId: fixture.slaveId, runId: fixture.runId, actor: 'human', payload: { requestedBy: 'meren' } })
    await appendEvent({ type: 'run.resume_requested', workspaceId: fixture.workspaceId, slaveId: fixture.slaveId, runId: fixture.runId, actor: 'human', payload: { requestedBy: 'meren', message: '' } })
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.humanInterventions).toBe(3)
    expect(row.outcome).toBe('stopped')
  })

  it('counts a sweep conclusion as ONE recovery, from the CALLER and never from reason text (R5)', async () => {
    await recordRunEvidence(fixture.runId, { recoveredBySweep: true })
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.recoveries).toBe(1)
  })

  it('counts every `task.unblocked` after the run started as a recovery too (R5)', async () => {
    await appendEvent({ type: 'run.started', workspaceId: fixture.workspaceId, taskId: fixture.taskId, slaveId: fixture.slaveId, runId: fixture.runId, actor: 'system', payload: { sessionId: 's' } })
    await appendEvent({ type: 'task.unblocked', workspaceId: fixture.workspaceId, taskId: fixture.taskId, actor: 'human', payload: { attempt: 1, maxAttempts: 3, status: 'rework' } })
    await recordRunEvidence(fixture.runId)
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).recoveries).toBe(1)
  })

  it('keeps the REPORTED figure and its word (R6)', async () => {
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.actualCostUsd).toBeCloseTo(0.42)
    expect(row.costProvenance).toBe('reported')
  })

  it('writes NULL and not 0 for a run nobody measured (R6)', async () => {
    await prisma.slaveRun.update({
      where: { id: fixture.runId },
      data: { costUsd: null, tokensIn: null, tokensOut: null, model: null, provider: 'cursor' },
    })
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.actualCostUsd).toBeNull()
    expect(row.costProvenance).toBe('unmeasured')
    expect(row.model).toBeNull()
  })

  it('leaves all three judgement columns NULL at the write -- nobody has judged this yet (R3)', async () => {
    await recordRunEvidence(fixture.runId)
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.verifiedFirstPass).toBeNull()
    expect(row.reviewRejected).toBeNull()
    expect(row.integrated).toBeNull()
    expect(row.settledAt).toBeNull()
  })
})

describe('recordRunEvidence settles, once, and never back (M53 R4, erratum E1)', () => {
  it('settles `verifiedFirstPass` true for a pass on attempt one, and stamps `settledAt`', async () => {
    await recordRunEvidence(fixture.runId)
    await recordRunEvidence(fixture.runId, { settle: { kind: 'verify', verdict: 'passed' } })
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.verifiedFirstPass).toBe(true)
    expect(row.settledAt).not.toBeNull()
  })

  it('settles `verifiedFirstPass` FALSE for a pass on attempt two', async () => {
    await appendEvent({ type: 'task.rework', workspaceId: fixture.workspaceId, taskId: fixture.taskId, actor: 'system', payload: { reason: 'a', attempt: 1 } })
    await appendEvent({ type: 'run.started', workspaceId: fixture.workspaceId, taskId: fixture.taskId, slaveId: fixture.slaveId, runId: fixture.runId, actor: 'system', payload: { sessionId: 's' } })
    await recordRunEvidence(fixture.runId)
    await recordRunEvidence(fixture.runId, { settle: { kind: 'verify', verdict: 'passed' } })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).verifiedFirstPass).toBe(false)
  })

  it('NEVER moves a settled column back -- a replayed conclusion writes nothing', async () => {
    await recordRunEvidence(fixture.runId)
    await recordRunEvidence(fixture.runId, { settle: { kind: 'verify', verdict: 'passed' } })
    const settledAt = (await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).settledAt
    await recordRunEvidence(fixture.runId, { settle: { kind: 'verify', verdict: 'failed' } })
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.verifiedFirstPass).toBe(true)
    expect(row.settledAt).toEqual(settledAt)
  })

  it('settles `reviewRejected` only when the rejection names THIS attempt', async () => {
    await recordRunEvidence(fixture.runId)
    await recordRunEvidence(fixture.runId, { settle: { kind: 'review', verdict: 'rejected', attempt: 7 } })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).reviewRejected).toBe(false)
  })

  it('settles `integrated` from the merge and from a human confirmation alike', async () => {
    await recordRunEvidence(fixture.runId)
    await recordRunEvidence(fixture.runId, { settle: { kind: 'integration', integrated: true } })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).integrated).toBe(true)
  })

  it('settles nothing for a run with no row yet -- a settle never CREATES a fact', async () => {
    await recordRunEvidence(fixture.runId, { settle: { kind: 'verify', verdict: 'passed' } })
    expect(await prisma.evidenceRecord.count()).toBe(0)
  })

  it('a REVIEW run keeps all three judgement columns null forever -- a reviewer gets no verdict (R4)', async () => {
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { kind: 'review' } })
    await recordRunEvidence(fixture.runId)
    await settleTaskEvidence(fixture.taskId, { kind: 'verify', verdict: 'passed' })
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })
    expect(row.verifiedFirstPass).toBeNull()
  })
})

describe('settleTaskEvidence (erratum E2)', () => {
  it('resolves the task newest terminal IMPLEMENTATION run and settles that row', async () => {
    await recordRunEvidence(fixture.runId)
    await settleTaskEvidence(fixture.taskId, { kind: 'integration', integrated: true })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: fixture.runId } })).integrated).toBe(true)
  })

  it('is a silent no-op for a task with no implementation run at all', async () => {
    await prisma.slaveRun.update({ where: { id: fixture.runId }, data: { kind: 'review' } })
    await expect(settleTaskEvidence(fixture.taskId, { kind: 'integration', integrated: true })).resolves.toBeUndefined()
  })
})
```

The fixture module `packages/control/test/integration/fixtures/evidence.ts` seeds: a `Workspace` with `repoPath: '/tmp/m53-evidence-repo'` and `verifyCommands: ['true']`, a `Team`, a `SlaveTemplate` named `Backend Developer`, a `Slave` hired from it, a `Capability` row per key used above (`backend.services` → domain `backend`, `qa.test-automation` → domain `qa`), a `Task` with `requiredCapabilities: ['backend.services']`, and a `SlaveRun` that is `succeeded`, terminal, with `model: 'claude-sonnet-4-20250514'`, `provider: 'claude_code'`, `costUsd: 0.42`, `startedAt` and `endedAt` a known 3 500 ms apart. It returns `{ workspaceId, teamId, templateId, slaveId, taskId, runId, repoPath }`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/control/test/integration/evidence.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/evidence.js"`.

- [ ] **Step 3: Write the one writer**

`packages/control/src/evidence.ts`. The whole module, in the order a reader meets it: the reads, the derivation, the write, the settle.

```ts
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  actualCostFrom,
  attemptFrom,
  domainsFor,
  durationMsFrom,
  evidenceOutcomeOf,
  humanInterventionsFrom,
  normaliseRepositoryKey,
  profileKeyOf,
  recoveriesFrom,
  reviewRejectedFrom,
  reworkCyclesFrom,
  verifiedFirstPassFrom,
  type CapabilityRecord,
  type RankEvidence,
  type Result,
  err,
  ok,
} from '@slave-of-ai/domain'
import type { ControlRefusal } from './refusal.js'

/**
 * THE ONE WRITER of `EvidenceRecord`, and the one place a run becomes a fact (M53 R3).
 *
 * Everything else in this milestone reads. The pipeline calls this at a run's terminal transition
 * (`pump.ts`'s four arms and `sweep.ts`'s two), the four verdict sites call it again to SETTLE, and
 * `scripts/backfill-evidence.mjs` calls exactly the same function over history -- which is what
 * makes "a fact is re-derivable from events" true by construction rather than by assertion. A
 * second derivation, in SQL or in a script, would be a second answer to one question.
 */

/** R4: what a verdict site has to say. Three shapes for four sites -- `merge.ts` and
 *  `confirmIntegration` both settle the same column, from the same fact, for the same reason. */
export type EvidenceSettle =
  | { readonly kind: 'verify'; readonly verdict: 'passed' | 'failed' }
  | { readonly kind: 'review'; readonly verdict: 'approved' | 'rejected'; readonly attempt: number | null }
  | { readonly kind: 'integration'; readonly integrated: boolean }

export interface RecordRunEvidenceOptions {
  /** R5(a): the SWEEP wrote this run's terminal row -- its orphan or dead-pid arm. Known from the
   *  caller and never by matching the reason text of a `run.failed`, which is our own prose. */
  readonly recoveredBySweep?: boolean
  /** Absent for the terminal write; present for one of the four verdicts. */
  readonly settle?: EvidenceSettle
}

/** The `SlaveRun` columns and joins one derivation needs. Selected once, explicitly, so this
 *  function's cost is a single indexed read and a reader can see exactly what it depends on. */
const RUN_SELECT = {
  id: true,
  taskId: true,
  slaveId: true,
  kind: true,
  status: true,
  model: true,
  provider: true,
  costUsd: true,
  tokensIn: true,
  tokensOut: true,
  stopRequestedBy: true,
  startedAt: true,
  terminalAt: true,
  endedAt: true,
  slave: {
    select: {
      name: true,
      hiredFromTemplateId: true,
      hiredFromTemplate: { select: { name: true } },
      team: { select: { workspaceId: true, workspace: { select: { repoPath: true } } } },
    },
  },
  task: { select: { requiredCapabilities: true } },
} satisfies Prisma.SlaveRunSelect

/**
 * The event-derived counters, in ONE query rather than six (R4, R5).
 *
 * Bounded twice over: by `(workspaceId, taskId, seq)` for the task's reworks and unblocks, and by
 * `(runId, seq)` for this run's own pause/resume/start -- the two indexes `ExecutionEvent` actually
 * carries. Never a predicate on `type` and `ts` alone, which is the unindexed full-history scan
 * `loadDenials`'s own docstring measures and refuses (`supervisorWorld.ts:340-352`).
 */
async function eventCountsFor(
  tx: Prisma.TransactionClient,
  run: { readonly id: string; readonly taskId: string | null; readonly workspaceId: string },
): Promise<{
  readonly runStartedSeq: bigint | null
  readonly reworkSeqs: readonly bigint[]
  readonly unblockedSeqs: readonly bigint[]
  readonly pauseRequested: number
  readonly resumeRequested: number
}> {
  const own = await tx.executionEvent.findMany({
    where: { runId: run.id, type: { in: ['run_started', 'run_pause_requested', 'run_resume_requested'] } },
    select: { seq: true, type: true },
    orderBy: { seq: 'asc' },
  })
  const taskRows =
    run.taskId === null
      ? []
      : await tx.executionEvent.findMany({
          where: { workspaceId: run.workspaceId, taskId: run.taskId, type: { in: ['task_rework', 'task_unblocked'] } },
          select: { seq: true, type: true },
          orderBy: { seq: 'asc' },
        })
  return {
    runStartedSeq: own.find((row) => row.type === 'run_started')?.seq ?? null,
    reworkSeqs: taskRows.filter((row) => row.type === 'task_rework').map((row) => row.seq),
    unblockedSeqs: taskRows.filter((row) => row.type === 'task_unblocked').map((row) => row.seq),
    pauseRequested: own.filter((row) => row.type === 'run_pause_requested').length,
    resumeRequested: own.filter((row) => row.type === 'run_resume_requested').length,
  }
}

/**
 * Record, or settle, one run's evidence. Idempotent on both halves.
 *
 * REFUSES BEFORE ANY WRITE (R13, plan erratum E3): a runId naming no `SlaveRun` is
 * `run_not_found`, which is also the boundary tripwire -- `Slave.teamId` and `Team.workspaceId` are
 * both NOT NULL with foreign keys, so "this run's workspace cannot be resolved" and "there is no
 * such run" are the same fact, and a `SimulationRun.id` handed to this function meets exactly that
 * refusal. A simulated role is not a `Slave`, holds no `SlavePermission` and can reach no
 * `SlaveRun`; nothing crosses.
 *
 * NOT keyed on `Workspace.archivedAt`, which is where this differs from the broker
 * (`packages/control/src/broker.ts:204`) and why the difference is written down: an archived
 * project's runs are real history, and refusing them would lose it.
 */
export async function recordRunEvidence(
  runId: string,
  opts: RecordRunEvidenceOptions = {},
): Promise<Result<void, ControlRefusal>> {
  const run = await prisma.slaveRun.findUnique({ where: { id: runId }, select: RUN_SELECT })
  if (run === null) return err({ kind: 'run_not_found', runId })

  const outcome = evidenceOutcomeOf(run.status)
  // A live run is evidence about nothing. Returned as SUCCESS rather than refused: the pump calls
  // this from arms whose conditional terminal write may legitimately have lost a race, and a
  // refusal there would turn "somebody else concluded this run" into an error in the daemon log.
  if (outcome === null) return ok(undefined)

  const workspaceId = run.slave.team.workspaceId
  const counts = await eventCountsFor(prisma, { id: run.id, taskId: run.taskId, workspaceId })
  const attempt = attemptFrom(counts.reworkSeqs, counts.runStartedSeq)
  // The taxonomy, read once per call and only when there is something to resolve. An empty list
  // answers `general` without a query at all.
  const required = run.task?.requiredCapabilities ?? []
  const taxonomy: readonly CapabilityRecord[] =
    required.length === 0
      ? []
      : (await prisma.capability.findMany({ where: { key: { in: [...required] } } })).map((row) => ({
          key: row.key,
          label: row.label,
          domain: row.domain,
          role: row.role,
          synonyms: row.synonyms,
        }))
  const cost = actualCostFrom({
    costUsd: run.costUsd,
    provider: run.provider,
    status: run.status,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    model: run.model,
  })

  const derived = {
    workspaceId,
    slaveId: run.slaveId,
    taskId: run.taskId,
    profileKey: profileKeyOf({ slaveId: run.slaveId, hiredFromTemplateId: run.slave.hiredFromTemplateId }),
    // The template's name when it came from one, the worker's own otherwise. A deleted template
    // leaves `hiredFromTemplate` null while `hiredFromTemplateId` still reads -- `onDelete: SetNull`
    // fires on the column, so this fallback is the "a surface must print a word" half of R1.
    profileName: run.slave.hiredFromTemplate?.name ?? run.slave.name,
    model: run.model,
    repositoryKey: normaliseRepositoryKey(run.slave.team.workspace.repoPath),
    domains: [...domainsFor(required, taxonomy)],
    runKind: run.kind,
    attempt,
    outcome,
    reworkCycles: reworkCyclesFrom(counts.reworkSeqs, counts.runStartedSeq),
    humanInterventions: humanInterventionsFrom({
      pauseRequested: counts.pauseRequested,
      resumeRequested: counts.resumeRequested,
      operatorStopped: run.status === 'stopped' && run.stopRequestedBy !== null,
    }),
    recoveries: recoveriesFrom({
      recoveredBySweep: opts.recoveredBySweep === true,
      unblockedAfterStart:
        counts.runStartedSeq === null
          ? 0
          : counts.unblockedSeqs.filter((seq) => seq > (counts.runStartedSeq as bigint)).length,
    }),
    durationMs: durationMsFrom(run.startedAt, run.endedAt),
    actualCostUsd: cost.actualCostUsd,
    costProvenance: cost.costProvenance,
  }

  // The WRITE half. `update` carries the dimension keys and the run-local measurements and NOTHING
  // else: not `recordedAt`, not `settledAt`, and not one of the three judgement columns. That is
  // what makes a second pass byte-equal to the first (plan erratum E15) and what makes "a judgement
  // moves from null exactly once" a property of the SQL rather than of a convention.
  await prisma.evidenceRecord.upsert({
    where: { runId },
    create: { runId, ...derived },
    update: derived,
  })

  if (opts.settle !== undefined) await applySettle(runId, opts.settle, attempt, run.kind)
  return ok(undefined)
}

/**
 * R4's settle, as three guarded updates (plan erratum E1).
 *
 * Each column is written by an `updateMany` conditioned on THAT COLUMN being null, so a verdict
 * moves it from "nobody judged this" to a verdict exactly once and can never move it back -- and a
 * replayed conclusion, which `concludeReview` legitimately allows, writes nothing. `settledAt` is
 * stamped by its own guarded update and means "somebody has judged this run at least once".
 *
 * A REVIEW run's row and a PLANNING run's row are left alone entirely: a reviewer receives no
 * verdict, and attributing one to it would make the reviewer's record a copy of the implementer's.
 */
async function applySettle(
  runId: string,
  settle: EvidenceSettle,
  attempt: number,
  runKind: 'implementation' | 'review' | 'planning',
): Promise<void> {
  if (runKind !== 'implementation') return

  if (settle.kind === 'verify') {
    await prisma.evidenceRecord.updateMany({
      where: { runId, verifiedFirstPass: null },
      data: { verifiedFirstPass: verifiedFirstPassFrom(settle.verdict, attempt) },
    })
  } else if (settle.kind === 'review') {
    await prisma.evidenceRecord.updateMany({
      where: { runId, reviewRejected: null },
      data: { reviewRejected: reviewRejectedFrom(settle.verdict, settle.attempt, attempt) },
    })
  } else {
    await prisma.evidenceRecord.updateMany({
      where: { runId, integrated: null },
      data: { integrated: settle.integrated },
    })
  }
  await prisma.evidenceRecord.updateMany({ where: { runId, settledAt: null }, data: { settledAt: new Date() } })
}

/**
 * The settle for a verdict that knows a TASK and not a run (plan erratum E2).
 *
 * `implementerOf` answers "who did the work" and an `EvidenceRecord` is keyed on a run, so the four
 * verdict sites need this resolver. It is the same `findFirst` `merge.ts`'s `latestImpl` already
 * makes -- the task's newest implementation run -- and it calls the one writer rather than
 * duplicating a line of it.
 *
 * Silent when there is nothing to settle: a task whose implementation run has no evidence row (a
 * database that predates this milestone, a run that never concluded) is not an error, it is a run
 * nobody recorded.
 */
export async function settleTaskEvidence(taskId: string, settle: EvidenceSettle): Promise<void> {
  const run = await prisma.slaveRun.findFirst({
    where: { taskId, kind: 'implementation', terminalAt: { not: null } },
    orderBy: { startedAt: 'desc' },
    select: { id: true },
  })
  if (run === null) return
  await recordRunEvidence(run.id, { settle })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/control/test/integration/evidence.test.ts`
Expected: PASS — 23 cases.

- [ ] **Step 5: Write the failing integration test for the three reads**

Appended to the same file. The fixture seeds a second profile and a handful of rows so the medians and the domain facet have something to measure.

```ts
describe('the reads (M53 R3, R6, R12, erratum E6)', () => {
  it('groups by profile AND repository, taking the NEWEST profile name for a renamed template', async () => {
    await seedRows(fixture, [
      { profileName: 'Backend Developer', recordedAt: new Date(1_000) },
      { profileName: 'Backend Engineer', recordedAt: new Date(2_000) },
    ])
    const groups = await evidenceByProfile({ domain: null })
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('Backend Engineer')
    expect(groups[0]?.attempted).toBe(2)
    expect(groups[0]?.repositoryKey).toBe(fixture.repoPath)
  })

  it('splits the money three ways with M51 words beside it, never one SUM (R6)', async () => {
    await seedRows(fixture, [
      { costProvenance: 'reported', actualCostUsd: 1 },
      { costProvenance: 'estimated', actualCostUsd: 2 },
      { costProvenance: 'unmeasured', actualCostUsd: null },
    ])
    const group = (await evidenceByProfile({ domain: null }))[0]
    expect(group?.reportedUsd).toBeCloseTo(1)
    expect(group?.estimatedUsd).toBeCloseTo(2)
    expect(group?.unmeasuredRuns).toBe(1)
  })

  it('filters by domain with a CONTAINMENT predicate, so a two-domain run counts under both (R2)', async () => {
    await seedRows(fixture, [{ domains: ['backend', 'qa'] }, { domains: ['backend'] }])
    expect((await evidenceByProfile({ domain: 'backend' }))[0]?.attempted).toBe(2)
    expect((await evidenceByProfile({ domain: 'qa' }))[0]?.attempted).toBe(1)
    // The two filtered counts deliberately do not sum to the unfiltered total.
    expect((await evidenceByProfile({ domain: null }))[0]?.attempted).toBe(2)
  })

  it('groups the by-model table separately, and keeps the null model as its own group (R1)', async () => {
    await seedRows(fixture, [{ model: 'opus' }, { model: 'opus' }, { model: null }])
    const groups = await evidenceByModel({ domain: null })
    expect(groups.map((one) => one.model)).toEqual(['opus', null])
    expect(groups[0]?.attempted).toBe(2)
  })

  it('sorts by attempted DESCENDING then by the row own name ASCENDING (R11)', async () => {
    await seedRows(fixture, [{ profileKey: 'template:z', profileName: 'Zed' }])
    await seedRows(fixture, [{ profileKey: 'template:a', profileName: 'Ann' }, { profileKey: 'template:a', profileName: 'Ann' }])
    expect((await evidenceByProfile({ domain: null })).map((one) => one.name)).toEqual(['Ann', 'Zed'])
  })

  it('answers the ranker with counts and medians per profile, bounded by the candidate set', async () => {
    await seedRows(fixture, [
      { profileKey: 'template:a', verifiedFirstPass: true, actualCostUsd: 1, durationMs: 1_000 },
      { profileKey: 'template:a', verifiedFirstPass: false, actualCostUsd: 3, durationMs: 3_000 },
      { profileKey: 'template:b', verifiedFirstPass: true },
    ])
    const byProfile = await evidenceForProfiles(['template:a'])
    expect([...byProfile.keys()]).toEqual(['template:a'])
    const record = byProfile.get('template:a')
    expect(record?.attempted).toBe(2)
    expect(record?.firstPassJudged).toBe(2)
    expect(record?.firstPassPassed).toBe(1)
    expect(record?.medianCostUsd).toBeCloseTo(2)
    expect(record?.medianDurationMs).toBe(2_000)
  })

  it('asks nothing at all for an empty candidate set', async () => {
    expect((await evidenceForProfiles([])).size).toBe(0)
  })

  it('EXCLUDES unmeasured rows from the median cost -- unmeasured is not cheap (R8)', async () => {
    await seedRows(fixture, [
      { profileKey: 'template:a', costProvenance: 'reported', actualCostUsd: 10 },
      { profileKey: 'template:a', costProvenance: 'unmeasured', actualCostUsd: null },
    ])
    expect((await evidenceForProfiles(['template:a'])).get('template:a')?.medianCostUsd).toBeCloseTo(10)
  })
})
```

- [ ] **Step 6: Run it, watch it fail, and write the three reads**

Run: `npx vitest run packages/control/test/integration/evidence.test.ts -t 'the reads'` → FAIL (`evidenceByProfile is not exported`).

Three `$queryRaw` functions appended to `packages/control/src/evidence.ts`, all three over the same table and the same two bounds. Rules, each of which a case above pins:

- **`EvidenceFilter`** is `{ domain?: string | null; workspaceId?: string | null; limit?: number }`. `domain` null means every domain; a named domain becomes `AND "domains" && ARRAY[$n]::text[]`, the containment predicate the GIN index exists for. `workspaceId` null means every project — the Evidence tab is on `/workforce`, which is global (R1: "a record spans the workspaces one installation holds"), and the column is there for the per-project read a later milestone may want.
- **`evidenceByProfile`** groups `"profileKey", "repositoryKey"`, takes the newest name with `(ARRAY_AGG("profileName" ORDER BY "recordedAt" DESC))[1]` (`loadDenials`' own idiom, `supervisorWorld.ts:365`), and produces `attempted`, the six judged/passed counters as `COUNT(*) FILTER (WHERE …)`, `SUM("reworkCycles")`, `SUM("humanInterventions")`, `SUM("recoveries")`, `percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs")`, and the three money figures — `SUM("actualCostUsd") FILTER (WHERE "costProvenance" = 'reported')`, the same for `'estimated'`, and `COUNT(*) FILTER (WHERE "costProvenance" = 'unmeasured')`. `ORDER BY attempted DESC, name ASC`.
- **`evidenceByModel`** is the same shape grouped on `"model"` alone, without the rework/intervention/recovery columns (R12's seven-column table), and its `ORDER BY` puts the null model group last by `NULLS LAST` on the name — a group with no name cannot sort by one.
- **`evidenceForProfiles`** takes `WHERE "profileKey" = ANY($1::text[])`, returns `ReadonlyMap<string, RankEvidence>`, and **returns an empty map without querying at all for an empty list** — the bounded-loader rule M52 erratum E9 already applied to `denials`. Its medians read `FILTER (WHERE "costProvenance" <> 'unmeasured')` so an unmeasured row ties at step 6 rather than dragging a median down.
- **`listEvidence`** is the raw rows, `ORDER BY "recordedAt" DESC`, `LIMIT` defaulting to 200 — what the CLI's `evidence list` prints, and nothing else reads it.
- Every `bigint` the driver hands back for a `COUNT`/`SUM`-of-integer is converted with `Number()` at the point it is read and never earlier, the rule `perSlaveRunAggregates`' own docstring states.

Run: `npx vitest run packages/control/test/integration/evidence.test.ts`
Expected: PASS — 31 cases.

- [ ] **Step 7: Write the failing integration test for the preference**

`packages/control/test/integration/staffing.test.ts`:

```ts
describe('setStaffingPreference (M53 R9)', () => {
  it('writes one row per capability per project, and names the granting principal', async () => {
    const result = await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', templateId: fixture.templateId }, { userId: 'u1' })
    expect(result.ok).toBe(true)
    const row = await prisma.staffingPreference.findFirstOrThrow({ where: { workspaceId: fixture.workspaceId } })
    expect(row.capability).toBe('backend.services')
    expect(row.templateId).toBe(fixture.templateId)
    expect(row.setBy).toBe('u1')
  })

  it('replaces the decision in place rather than stacking a second row', async () => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', templateId: fixture.templateId })
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    const rows = await prisma.staffingPreference.findMany({ where: { workspaceId: fixture.workspaceId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.templateId).toBeNull()
    expect(rows[0]?.model).toBe('opus')
  })

  it('accepts BOTH halves -- "Atlas, and on opus" is one decision', async () => {
    const result = await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', templateId: fixture.templateId, model: 'opus' })
    expect(result.ok).toBe(true)
  })

  it('refuses a row naming NEITHER, before any write', async () => {
    const result = await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services' })
    expect(result.ok === false && result.error.kind).toBe('invalid_staffing_preference')
    expect(await prisma.staffingPreference.count()).toBe(0)
  })

  it('refuses a capability the taxonomy does not have, reusing the existing kind', async () => {
    const result = await setStaffingPreference(fixture.workspaceId, { capability: 'nowhere.at-all', model: 'opus' })
    expect(result.ok === false && result.error.kind).toBe('capability_not_found')
  })

  it('refuses a template this installation does not have', async () => {
    const result = await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', templateId: 'missing' })
    expect(result.ok === false && result.error.kind).toBe('template_not_found')
  })

  it('refuses a model whose shape is not a model name, with the existing kind', async () => {
    const result = await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'not a model!' })
    expect(result.ok === false && result.error.kind).toBe('invalid_model')
  })

  it('refuses a project that is not there', async () => {
    const result = await setStaffingPreference('missing', { capability: 'backend.services', model: 'opus' })
    expect(result.ok === false && result.error.kind).toBe('workspace_not_found')
  })

  it('appends `staffing.preference_changed` with from, to and by -- and the LABEL beside the key', async () => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', templateId: fixture.templateId }, { userId: 'u1' })
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'staffing_preference_changed' }, orderBy: { seq: 'desc' } })
    expect(event.payload).toMatchObject({
      capability: 'backend.services',
      capabilityLabel: 'Services',
      from: null,
      to: { templateId: fixture.templateId, templateName: 'Backend Developer', model: null },
      by: 'u1',
    })
  })

  it('writes NO event when the decision is already exactly this', async () => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    const before = await prisma.executionEvent.count({ where: { type: 'staffing_preference_changed' } })
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    expect(await prisma.executionEvent.count({ where: { type: 'staffing_preference_changed' } })).toBe(before)
  })
})

describe('clearStaffingPreference (M53 R9)', () => {
  it('deletes the row and appends the change with `to: null`', async () => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    const result = await clearStaffingPreference(fixture.workspaceId, 'backend.services', { userId: 'u1' })
    expect(result.ok).toBe(true)
    expect(await prisma.staffingPreference.count()).toBe(0)
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { type: 'staffing_preference_changed' }, orderBy: { seq: 'desc' } })
    expect((event.payload as { to: unknown }).to).toBeNull()
  })

  it('clearing nothing is SUCCESS and writes no event -- what DELETE promises', async () => {
    const result = await clearStaffingPreference(fixture.workspaceId, 'backend.services')
    expect(result.ok).toBe(true)
    expect(await prisma.executionEvent.count({ where: { type: 'staffing_preference_changed' } })).toBe(0)
  })
})

describe('the refusal is a RETURNED value, never a throw after a write', () => {
  it('leaves no row behind on any refusal path', async () => {
    for (const input of [{ capability: 'backend.services' }, { capability: 'nowhere.at-all', model: 'opus' }, { capability: 'backend.services', templateId: 'missing' }]) {
      await setStaffingPreference(fixture.workspaceId, input)
    }
    expect(await prisma.staffingPreference.count()).toBe(0)
    expect(await prisma.executionEvent.count({ where: { type: 'staffing_preference_changed' } })).toBe(0)
  })
})
```

- [ ] **Step 8: Run it and watch it fail, then write the writers**

Run: `npx vitest run packages/control/test/integration/staffing.test.ts` → FAIL (`Failed to resolve import "../../src/staffing.js"`).

`packages/control/src/staffing.ts` — the shape `setSlavePermission` / `clearSlavePermission` already have (`packages/control/src/permission.ts`), one verb at a time, with every question asked BEFORE any write:

1. **`setStaffingPreference(workspaceId, input, principal?)`** asks, in this order: is the workspace there (`workspace_not_found`); does the input name at least one of `templateId` / `model` (`invalid_staffing_preference { capability }`); is the capability a taxonomy row (`capability_not_found { key }`); does the template exist when one is named (`template_not_found { templateId }`); does the model match `MODEL_ID_PATTERN` when one is named (`invalid_model`, the same kind `setSlaveModel` already returns). Then it reads the PRIOR row, returns `ok` unchanged when the decision already reads exactly this (the `setSlavePermission` `from === mode` precedent, which is what makes the "no event" case above true), `upsert`s on `{ workspaceId_capability }`, and appends `staffing.preference_changed` with `from` and `to` as `{ templateId, templateName, model }` triples — `templateName` resolved from the template rows already read, `capabilityLabel` from `capabilityLabel(key, taxonomy)`. `setBy` is `principal?.userId ?? null`, exactly as `SlavePermission.grantedBy` is.
2. **`clearStaffingPreference(workspaceId, capability, principal?)`** returns `ok` before doing anything when there is no row (deleting nothing is success), `deleteMany`s rather than `delete`s (a concurrent clear must not throw on a row already in the state the caller wanted — `clearSlavePermission`'s own rule), and appends the change with `to: null`.
3. **`listStaffingPreferences(workspaceId)`** returns `readonly StaffingPreferenceView[]` — `{ capability, capabilityLabel, templateId, templateName, model, setBy, setAt }` — ordered by `capability` ascending, with the template names resolved in ONE `findMany` over the distinct ids and never one query per row.

The refusal's three homes, all in this step:

```ts
  /** M53 R9: a staffing preference that names neither a profile nor a model is a preference for
   *  nothing. 409 by `refusalStatus`'s suffix rule, which is right: the project exists and the
   *  capability exists, and the request does not make sense against them. */
  | { readonly kind: 'invalid_staffing_preference'; readonly capability: string }
```

in `packages/control/src/refusal.ts`'s union, with

```ts
    case 'invalid_staffing_preference':
      return `a staffing preference for ${refusal.capability} must name a profile, a model, or both`
```

in `refusalText`, and `invalid_staffing_preference: true,` in `apps/web/test/refusal-status.test.ts`'s `ALL_KINDS` (plus the 409 list its second `describe` walks).

Run: `npx vitest run packages/control/test/integration/staffing.test.ts apps/web/test/refusal-status.test.ts`
Expected: PASS — 13 + the refusal file's own.

- [ ] **Step 9: Write the failing world test for the three bounded loads**

`packages/control/test/integration/supervisorWorld.test.ts` gains:

```ts
describe('the world M53 hands the ranker (R8, R9, R10, errata E7/E8)', () => {
  it('carries each worker DENY rows, and only the denies', async () => {
    await prisma.slavePermission.create({ data: { slaveId: fixture.slaveId, kind: 'run_commands', mode: 'deny' } })
    await prisma.slavePermission.create({ data: { slaveId: fixture.slaveId, kind: 'read_repo', mode: 'allow' } })
    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    expect(world.slaves.find((s) => s.id === fixture.slaveId)?.deniedKinds).toEqual(['run_commands'])
  })

  it('carries the profile key ingredients: the template a worker was hired from, and its resolved model', async () => {
    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    const slave = world.slaves.find((s) => s.id === fixture.slaveId)
    expect(slave?.hiredFromTemplateId).toBe(fixture.templateId)
    expect(slave?.model).toBe('claude-sonnet-4-20250514')
  })

  it('carries the staffing preferences a person set', async () => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    expect(world.staffingPreferences).toEqual([
      { capability: 'backend.services', capabilityLabel: 'Services', templateId: null, model: 'opus', setBy: null },
    ])
  })

  it('carries the record of every candidate profile, and of nobody else', async () => {
    await seedEvidenceRows(fixture, 6)
    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    const record = world.evidence.find((one) => one.profileKey === `template:${fixture.templateId}`)
    expect(record?.attempted).toBe(6)
  })

  it('reads NOTHING when no staffable task asks for a capability (erratum E8)', async () => {
    await prisma.task.updateMany({ where: { workspaceId: fixture.workspaceId }, data: { requiredCapabilities: [] } })
    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    expect(world.evidence).toEqual([])
    expect(world.company).toEqual([])
    expect(world.catalog).toEqual([])
  })

  it('reads no denials query at all when the workspace holds no `SlavePermission` row', async () => {
    const { world } = await loadSupervisorWorld(fixture.workspaceId, new Date())
    for (const slave of world.slaves) expect(slave.deniedKinds).toEqual([])
  })
})
```

- [ ] **Step 10: Run it, watch it fail, and write the loads**

Run: `npx vitest run packages/control/test/integration/supervisorWorld.test.ts` → FAIL (`deniedKinds` is not a property).

`packages/domain/src/supervisor/world.ts` gains, with the docstrings the repository's own world fields carry:

```ts
/** M53 R9: one staffing decision a person took about this project, as the world sees it. The LABEL
 *  rides beside the key because the rationale sentence a decision row stores is read a year later
 *  (`docs/ia.md` rule 3). */
export interface SupervisorStaffingPreference {
  readonly capability: string
  readonly capabilityLabel: string
  readonly templateId: string | null
  readonly model: string | null
  readonly setBy: string | null
}

/** M53 R3/R8: one profile's record, as the RANKER reads it. `RankEvidence` plus the key it is
 *  looked up by -- the world holds no `EvidenceRecord` rows, only the grouped counts, for the
 *  reason `staleMemoryCandidates` holds a count and not the memories (M49 plan erratum E11). */
export interface SupervisorProfileEvidence extends RankEvidence {
  readonly profileKey: string
}
```

`SupervisorWorld` gains:

```ts
  /** M53 R9: what a person asked for, per capability. EMPTY unless some staffable task asks for a
   *  capability -- the same gate `company` and `catalog` wait on. */
  readonly staffingPreferences: readonly SupervisorStaffingPreference[]
  /** M53 R3/R8: the record of every candidate profile -- roster, company roster and catalog --
   *  and of nobody else. EMPTY under the same gate, and bounded by the CANDIDATE SET rather than
   *  by a window: `WHERE profileKey = ANY(...)` is an index probe on
   *  `(profileKey, model, repositoryKey)` (plan erratum E8). */
  readonly evidence: readonly SupervisorProfileEvidence[]
```

`SupervisorSlave` gains `deniedKinds`, `hiredFromTemplateId` and `model` (erratum E7); `SupervisorCompanyWorker` gains `templateId`; `SupervisorCatalogEntry` gains `defaultModel: string | null`, which is what a template candidate's `model` is.

`packages/control/src/supervisorWorld.ts` gains three loaders beside `loadDenials`, every one of them shaped like it:

- **`loadDeniedKinds(tx, slaveIds)`** — one `findMany` on `SlavePermission` where `{ slaveId: { in }, mode: 'deny' }`, `select: { slaveId, kind }`, grouped into a `Map`. **Skipped entirely** (an empty map, no query) when `slaveIds` is empty. Not a `$queryRaw`: this is a small indexed table with a unique index on `(slaveId, kind)` and Prisma's own `findMany` is the honest read.
- **`loadStaffingPreferences(tx, workspaceId, taxonomy)`** — one `findMany` on the `@@unique([workspaceId, capability])` index, labelled through `capabilityLabel(key, taxonomy)`, ordered by capability. Called only when `asksForCapabilities`.
- **`loadProfileEvidence(tx, profileKeys)`** — the same `$queryRaw` `evidenceForProfiles` runs, taken from `./evidence.js` rather than written a second time (erratum E6), with the candidate set built from `slaveRows` (`profileKeyOf` per row), `companyRows` (`template:<templateId>`) and `catalogRows` (`template:<templateId>`). Called only when `asksForCapabilities`.

The world assembly gains the three fields beside `denials`, and `slaveRows`' `select` gains `hiredFromTemplateId: true`, `model: true`, `companySlave: { select: { model: true } }` and `hiredFromTemplate: { select: { defaultModel: true } }` — the resolution chain `Slave.model ?? CompanySlave.model ?? SlaveTemplate.defaultModel ?? null` (`schema.prisma:261-264`), resolved at the edge so the pure functions never have to.

`packages/domain/test/supervisor/fixtures.test.ts` and every `SupervisorWorld` literal in `packages/domain/test/` gain the two empty collections and the three slave fields. This is the change the FULL suite has to see: a world fixture in another package that does not compile is exactly the class of failure a scoped run cannot find.

Run: `npx vitest run packages/control/test/integration/supervisorWorld.test.ts packages/domain/test/supervisor`
Expected: PASS.

- [ ] **Step 11: `confirmIntegration` settles, and the boundary names three nouns**

`packages/control/src/integration.ts`, after the `task.integrated` append (`:36-44`) and never before it — a fact is a record of what happened, and what happened is what that event says:

```ts
  // M53 R4: the human half of the integration verdict. AFTER the event, for `promote`'s reason
  // (M49 R2d) and for one of its own: `settleTaskEvidence` resolves the task's implementation run,
  // and the row it settles is the IMPLEMENTER's -- the person confirming a merge is judging the
  // work, not the confirmation.
  await settleTaskEvidence(taskId, { kind: 'integration', integrated: true })
```

`packages/control/test/simulation-boundary.test.ts`'s second case gains a fourth pattern beside the three it already carries:

```ts
      // M53 R13: the three nouns by NAME, the way the case above names `@slave-of-ai/providers`
      // and M52's own line names the broker. A `SimulationRun` binds to a `Company` and never to a
      // `Workspace`, a simulated role is not a `Slave` and can reach no `SlaveRun` -- so no
      // simulation row can name one, and the scan is what keeps that true through a refactor
      // nobody reads a convention during.
      expect(source, `${file} mentions evidence, ranking or a staffing preference`).not.toMatch(
        /EvidenceRecord|rankCandidates|StaffingPreference/,
      )
```

Before writing it, prove the pattern is clean today:

```bash
grep -rEn "EvidenceRecord|rankCandidates|StaffingPreference" packages/control/src/simulation.ts packages/control/src/simulation/
```

Expected: no output.

- [ ] **Step 12: Run the whole suite**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: ≥ 338 files / ≥ 5642 tests, zero failures, and the new integration files among them. The one to watch is `packages/domain/test/supervisor/fixtures.test.ts` and every consumer of a `SupervisorWorld` literal — Step 10's field additions are the kind of change that compiles in one package and breaks a fixture in another.

- [ ] **Step 13: Prove the refusals are returned, then ladder and commit**

Two checks rather than an edit, because each is a fact about the tree a plan should verify:

```bash
grep -n "\$transaction" packages/control/src/evidence.ts packages/control/src/staffing.ts   # expect no output
grep -n "return err(" packages/control/src/staffing.ts                                       # every one before a write
```

The first is the point: neither module opens a transaction at all, so the "a refusal after a write inside `$transaction` must throw" rule cannot be broken here — and the second shows every refusal sitting above the `upsert`/`deleteMany` it precedes.

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```

```bash
git add packages/control packages/domain/src/supervisor apps/web/test/refusal-status.test.ts packages/domain/test/supervisor
git commit -m "$(cat <<'EOF'
feat(control): m53 t2 — one writer, one settler, three reads, and a preference that is a row

`recordRunEvidence` is the only thing in this system that will ever write an `EvidenceRecord`, and
it re-derives every column from the run row and the run's own bounded event stream, so the pipeline
and the backfill cannot disagree about what a fact means. It refuses before any write and returns
`run_not_found` for a runId no `SlaveRun` answers -- which is also the simulation tripwire, because
`Slave.teamId` and `Team.workspaceId` are both NOT NULL and a `SimulationRun`'s id therefore meets
exactly that refusal.

The settle is three guarded updates rather than one: three judgement columns settle from three
different moments, each `updateMany` is conditioned on its own column being null, and a verdict
moves a column from "nobody has judged this" exactly once and can never move it back. A replayed
review conclusion writes nothing, which is what `concludeReview` has always needed somebody to
promise it.

A staffing preference is one row per capability per project, it refuses to name nothing, and it
appends the fifty-ninth event with both sides and the person. The Supervisor's world gains the three
collections the ranker cannot work without and pays for none of them on a project whose board asks
for no capability. `packages/control/test/simulation-boundary.test.ts` now names all three new nouns.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"
```

---

### Task 3: The pipeline — six places a fact is written, four verdicts that settle it, and a team formed by the record instead of by the alphabet (R3, R4, R5, R8, R9, R10, E2, E7, D21–D26)

`apps/orchestrator`'s write and settle sites, plus the two DOMAIN files that turn `formTeam` from an alphabetical tie-break into a ranking. The domain half is here rather than in Task 1 because it consumes Task 2's world fields: a ranker wired to a world that cannot answer its questions is a task a reviewer could only approve on faith.

**Files:**
- Modify: `apps/orchestrator/src/pump.ts`, `apps/orchestrator/src/sweep.ts`, `apps/orchestrator/src/verify.ts`, `apps/orchestrator/src/review.ts`, `apps/orchestrator/src/merge.ts`, `packages/domain/src/capability/team.ts`, `packages/domain/src/supervisor/candidates.ts`
- Test: `apps/orchestrator/test/integration/{pump,sweep,verify,review,merge}.test.ts`, `packages/domain/test/capability/team.test.ts`, `packages/domain/test/supervisor/candidates.test.ts`

**Interfaces:**
- Consumes: `recordRunEvidence`, `settleTaskEvidence`, `EvidenceSettle` (Task 2); `rankCandidates`, `RankCandidate`, `RankContext`, `RankEvidence` (Task 1); `SupervisorWorld.{staffingPreferences,evidence}`, `SupervisorSlave.{deniedKinds,hiredFromTemplateId,model}`, `SupervisorCompanyWorker.templateId`, `SupervisorCatalogEntry.defaultModel` (Task 2); `profileKeyOf` (Task 1).
- Produces, for Tasks 4–6: `TeamInput.ranking?: TeamRanking` (`{ preferences, evidence, deniedKinds, modelOf, profileKeyOf, runKind }` — spelled in Step 7), `TeamProposal.rationale` naming the step when one decided, and an `EvidenceRecord` row for every run this daemon concludes.

- [ ] **Step 1: Write the failing integration tests for the six write sites**

`apps/orchestrator/test/integration/pump.test.ts` and `sweep.test.ts`. The pump cases drive a real pump over a fake stream (the shape those files already have); the sweep cases call `reconcileOrphans` and the dead-pid arm directly.

```ts
describe('a fact at the terminal transition, and only there (M53 R3)', () => {
  it('leaves NO EvidenceRecord while the run is live', async () => {
    const { runId } = await startRun(fixture)
    expect(await prisma.evidenceRecord.count({ where: { runId } })).toBe(0)
  })

  it('writes exactly one the instant the pump concludes it clean', async () => {
    const { runId } = await runToCompletion(fixture)
    const rows = await prisma.evidenceRecord.findMany({ where: { runId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.outcome).toBe('succeeded')
  })

  it('writes one for the stream-ended arm, as `failed`', async () => {
    const { runId } = await runWithStreamEndingSilently(fixture)
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })).outcome).toBe('failed')
  })

  it('writes one for an operator stop, as `stopped`, with the intervention counted', async () => {
    const { runId } = await runStoppedByOperator(fixture, 'meren')
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })
    expect(row.outcome).toBe('stopped')
    expect(row.humanInterventions).toBeGreaterThanOrEqual(1)
  })

  it('writes one for the gate-failure halt arm', async () => {
    const { runId } = await runWithGateFailure(fixture)
    expect(await prisma.evidenceRecord.count({ where: { runId } })).toBe(1)
  })

  it('writes NOTHING for a spawn failure -- nothing was attempted (R3)', async () => {
    const { runId } = await dispatchWithSpawnFailure(fixture)
    expect(await prisma.evidenceRecord.count({ where: { runId } })).toBe(0)
  })

  it('a sweep racing a pump cannot make two rows -- `runId` is unique', async () => {
    const { runId } = await runToCompletion(fixture)
    await recordRunEvidence(runId)
    expect(await prisma.evidenceRecord.count({ where: { runId } })).toBe(1)
  })
})

describe('the sweep own two arms (M53 R3, R5)', () => {
  it('records an orphaned run, with ONE recovery', async () => {
    const runId = await seedOrphanedRun(fixture)
    await reconcileOrphans({ workspaceId: fixture.workspaceId })
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })
    expect(row.outcome).toBe('failed')
    expect(row.recoveries).toBe(1)
  })

  it('records a dead-pid run the same way, and nothing distinguishes them from the reason text', async () => {
    const runId = await seedDeadPidRun(fixture)
    await sweep({ workspaceId: fixture.workspaceId })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })).recoveries).toBe(1)
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/orchestrator/test/integration/pump.test.ts apps/orchestrator/test/integration/sweep.test.ts`
Expected: FAIL — every `findUniqueOrThrow` on `evidenceRecord` throws `No EvidenceRecord found`.

- [ ] **Step 3: Call the writer at the six terminal transitions**

Every call sits IMMEDIATELY AFTER the conditional terminal write it belongs to and INSIDE the `count > 0` guard where there is one — the fact is about the writer who actually won the race, and a call outside the guard would record a conclusion somebody else made.

`apps/orchestrator/src/pump.ts`, four arms. After the gate-failure halt's `updateMany` (`:1004-1011`):

```ts
            // M53 R3: this run concluded here, so this is where its fact is written. AFTER the
            // status write and never before it -- `recordRunEvidence` reads the row it is about,
            // and a call above this line would find a run that had not ended yet and write nothing.
            await recordRunEvidence(runId)
```

After the stop claim's `if (stopClaimed.count > 0)` block's `emit` (`:1195-1201`), after the stream-ended arm's `if (concluded.count > 0)` block's `emit` (`:1230-1240`), and after the clean conclusion's `emit` pair (`:1339-1348`), the same one line. Four calls, all with no options: a pump is alive to see these, which is exactly what R5(a) means by "not a recovery".

`apps/orchestrator/src/sweep.ts`, two arms, both with `{ recoveredBySweep: true }`. In `reconcileOrphans` after the `db.slaveRun.update` (`:210-213`):

```ts
    // M53 R5(a): the SWEEP concluded this run, which is the recovery -- known because this is the
    // caller, never by matching the reason text of a `run.failed`, which is our own prose and may be
    // reworded tomorrow.
    await recordRunEvidence(run.id, { recoveredBySweep: true })
```

and in `concludeDeadRun` after the `appendEvent` (`:1069-1078`), the same with `run.id`.

Both imports come from `@slave-of-ai/control`, which `pump.ts` and `sweep.ts` already import from.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run apps/orchestrator/test/integration/pump.test.ts apps/orchestrator/test/integration/sweep.test.ts`
Expected: PASS — 9 new cases, and every existing case in both files unchanged.

- [ ] **Step 5: Write the failing tests for the four settle sites**

`apps/orchestrator/test/integration/{verify,review,merge}.test.ts` and `packages/control/test/integration/integration.test.ts`:

```ts
describe('the verify verdict settles the first-pass column (M53 R4)', () => {
  it('settles true for a pass on attempt one', async () => {
    const { runId, taskId } = await concludeRunOnTask(fixture)
    await advance({ taskId, branch: 'feat/x', result: { kind: 'passed' } })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })).verifiedFirstPass).toBe(true)
  })

  it('settles FALSE for a failed verify, and the rework cycle is counted on the row', async () => {
    const { runId, taskId } = await concludeRunOnTask(fixture)
    await advance({ taskId, branch: 'feat/x', result: { kind: 'failed', output: 'red', failedCommand: 'npm test', exitCode: 1, stage: null } })
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })
    expect(row.verifiedFirstPass).toBe(false)
  })

  it('settles NOTHING for a verify that could not run -- that is not the worker being judged', async () => {
    const { runId, taskId } = await concludeRunOnTask(fixture)
    await advance({ taskId, branch: 'feat/x', result: { kind: 'not_configured', output: 'no commands' } })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })).verifiedFirstPass).toBeNull()
  })
})

describe('the review verdict settles the rejection column, on the IMPLEMENTER row (M53 R4, erratum E2)', () => {
  it('settles true on a rejection naming this attempt, against the implementation run', async () => {
    const { implRunId, taskId, reviewRunId } = await reviewRunFor(fixture, 'reject')
    await concludeReview(reviewRunId)
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })).reviewRejected).toBe(true)
  })

  it('settles false on an approval', async () => {
    const { implRunId, reviewRunId } = await reviewRunFor(fixture, 'approve')
    await concludeReview(reviewRunId)
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })).reviewRejected).toBe(false)
  })

  it('leaves the REVIEWER own row null -- a reviewer receives no verdict', async () => {
    const { reviewRunId } = await reviewRunFor(fixture, 'reject')
    await concludeReview(reviewRunId)
    const row = await prisma.evidenceRecord.findUnique({ where: { runId: reviewRunId } })
    expect(row?.reviewRejected ?? null).toBeNull()
  })
})

describe('integration settles only where work actually reached the base branch (M53 R4)', () => {
  it('settles true on an AUTO-MERGE, where `integratedAt` is written', async () => {
    const { implRunId, taskId } = await mergeableTask(fixture, { autoMerge: true })
    await runMergePass({ workspaceId: fixture.workspaceId })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })).integrated).toBe(true)
  })

  it('settles NOTHING on the !autoMerge path, which writes `integratedAt: null` deliberately', async () => {
    const { implRunId } = await mergeableTask(fixture, { autoMerge: false })
    await runMergePass({ workspaceId: fixture.workspaceId })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })).integrated).toBeNull()
  })

  it('settles FALSE on `task.merge_failed`', async () => {
    const { implRunId } = await mergeableTask(fixture, { autoMerge: true, conflict: true })
    await runMergePass({ workspaceId: fixture.workspaceId })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })).integrated).toBe(false)
  })

  it('settles true when a person confirms a hand merge, days later', async () => {
    const { implRunId, taskId } = await mergeableTask(fixture, { autoMerge: false })
    await runMergePass({ workspaceId: fixture.workspaceId })
    await confirmIntegration(taskId, { userId: 'u1' })
    expect((await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId: implRunId } })).integrated).toBe(true)
  })
})
```

- [ ] **Step 6: Run them, watch them fail, and write the four settles**

Run: `npx vitest run apps/orchestrator/test/integration/verify.test.ts apps/orchestrator/test/integration/review.test.ts apps/orchestrator/test/integration/merge.test.ts packages/control/test/integration/integration.test.ts` → FAIL (every judgement column reads null).

Four edits, each beside the event it belongs to and after it:

**`apps/orchestrator/src/verify.ts`**, in `advance`. After the `task.verify_passed` append and its `promote` (`:560-579`):

```ts
    // M53 R4: the verdict is in, so the first-pass column settles. `runId` is the IMPLEMENTATION
    // run's -- read at the top of this function, before the claim was cleared (`:527`) -- so this
    // is `recordRunEvidence` directly rather than `settleTaskEvidence`'s lookup (plan erratum E2).
    if (runId !== null) await recordRunEvidence(runId, { settle: { kind: 'verify', verdict: 'passed' } })
```

and after the `task.verify_failed` append (`:618-631`), before `rejectTask`:

```ts
    if (runId !== null) await recordRunEvidence(runId, { settle: { kind: 'verify', verdict: 'failed' } })
```

The `not_configured` / `could_not_run` branch (`:583-616`) gets NOTHING, deliberately: it already refuses to charge the task an attempt because neither is the worker's doing, and settling a `false` there would charge the worker's record for the orchestrator's problem.

**`apps/orchestrator/src/review.ts`**, in `concludeReview`. After the `task.review_approved` append inside `if (updated.count === 1)`:

```ts
      // M53 R4: the reviewer judged the IMPLEMENTER's work, so the verdict settles on the
      // implementer's row -- the pattern M49 already uses to attribute a verified fact to its
      // author, never through `Task.assigneeId`, which nothing in this pipeline writes.
      await settleTaskEvidence(task.id, { kind: 'review', verdict: 'approved', attempt: null })
```

and after the `task.review_rejected` append:

```ts
  await settleTaskEvidence(task.id, { kind: 'review', verdict: 'rejected', attempt: counted.attempt })
```

`counted.attempt` is the same number the event's own payload carries, which is what `reviewRejectedFrom` compares against the row's derived attempt.

**`apps/orchestrator/src/merge.ts`**, two calls. After the real merge's `task.done` append (`:267-273`):

```ts
  // M53 R4: the commits genuinely reached `workspace.baseBranch`, which is what `integratedAt` says
  // one line above. The `!autoMerge` path at `:146-163` gets NO call at all -- it writes
  // `integratedAt: null` on purpose, and `confirmIntegration` is the verdict for that task.
  await settleTaskEvidence(task.id, { kind: 'integration', integrated: true })
```

and in `failMerge`, after its `task.merge_failed` append and before the escalation count:

```ts
  await settleTaskEvidence(input.taskId, { kind: 'integration', integrated: false })
```

**`packages/control/src/integration.ts`** already landed in Task 2 Step 11.

Run: `npx vitest run apps/orchestrator/test/integration/verify.test.ts apps/orchestrator/test/integration/review.test.ts apps/orchestrator/test/integration/merge.test.ts packages/control/test/integration/integration.test.ts`
Expected: PASS — 10 new cases.

- [ ] **Step 7: Write the failing test for the ranking inside `formTeam`**

`packages/domain/test/capability/team.test.ts` gains a describe block, and **every existing tier-order case stays exactly as it is** — the `TeamSource` order is M47 R4's and this milestone does not touch it.

```ts
describe('formTeam ranks WITHIN a tier (M53 R8)', () => {
  const base = {
    required: ['backend.services'],
    requiredBy: new Map<string, readonly string[]>(),
    company: [],
    catalog: [],
    taxonomy: TAXONOMY,
  }
  const provider = (slaveId: string, extra: Partial<TeamRosterMember> = {}): TeamRosterMember => ({
    slaveId,
    name: slaveId,
    capabilities: ['backend.services'],
    runtimeRoles: [],
    busy: false,
    ...extra,
  })

  it('keeps the TIER order untouched: an existing worker still beats a company worker', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a')],
      company: [{ companySlaveId: 'c', name: 'C', capabilities: ['backend.services'], templateId: 't-c' }],
    })
    expect(plan.proposals[0]?.source).toBe('existing_worker')
  })

  it('picks the profile with the better record, where the alphabet used to decide', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a'), provider('b')],
      ranking: rankingWith({
        'slave:a': { ...NO_EVIDENCE, attempted: 10, firstPassJudged: 10, firstPassPassed: 1 },
        'slave:b': { ...NO_EVIDENCE, attempted: 10, firstPassJudged: 10, firstPassPassed: 9 },
      }),
    })
    expect(plan.proposals[0]?.pick.id).toBe('b')
  })

  it('picks the alphabet again when neither record is thick enough to mean anything (R11)', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a'), provider('b')],
      ranking: rankingWith({
        'slave:a': { ...NO_EVIDENCE, attempted: 2, firstPassJudged: 2, firstPassPassed: 0 },
        'slave:b': { ...NO_EVIDENCE, attempted: 2, firstPassJudged: 2, firstPassPassed: 2 },
      }),
    })
    expect(plan.proposals[0]?.pick.id).toBe('a')
  })

  it('still prefers the IDLE worker -- availability is step 4 and outranks the record', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a', { busy: true }), provider('b')],
      ranking: rankingWith({ 'slave:a': STRONG, 'slave:b': WEAK }),
    })
    expect(plan.proposals[0]?.pick.id).toBe('b')
  })

  it('honours a preference naming a template, above the record', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a'), provider('b')],
      ranking: rankingWith({ 'template:t-a': STRONG }, {
        preferences: new Map([['backend.services', { templateId: 't-b', model: null }]]),
        templateOf: new Map([['a', 't-a'], ['b', 't-b']]),
      }),
    })
    expect(plan.proposals[0]?.pick.id).toBe('b')
  })

  it('ranks a DENIED worker below an undenied one, whatever the preference says', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a'), provider('b')],
      ranking: rankingWith({}, {
        preferences: new Map([['backend.services', { templateId: 't-b', model: null }]]),
        templateOf: new Map([['a', 't-a'], ['b', 't-b']]),
        deniedKinds: new Map([['b', ['run_commands'] as const]]),
      }),
    })
    expect(plan.proposals[0]?.pick.id).toBe('a')
  })

  it('names the step in the rationale, so a person reads WHY rather than a number', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a'), provider('b', { busy: true })],
      ranking: rankingWith({}),
    })
    expect(plan.proposals[0]?.rationale).toMatch(/free/u)
  })

  it('behaves exactly as it did before when `ranking` is absent -- every caller written before M53', () => {
    const plan = formTeam({ ...base, roster: [provider('b', { busy: true }), provider('a')] })
    expect(plan.proposals[0]?.pick.id).toBe('a')
  })
})
```

- [ ] **Step 8: Run it, watch it fail, and wire the ranker in**

Run: `npx vitest run packages/domain/test/capability/team.test.ts` → FAIL (`ranking` is not a property of `TeamInput`).

`packages/domain/src/capability/team.ts` gains one optional input and two call sites.

```ts
/**
 * What `rankCandidates` needs about a world, gathered once by `teamPlanOf` (M53 R8).
 *
 * OPTIONAL on {@link TeamInput}, and that is load-bearing rather than lenient: every caller written
 * before M53 -- and every fixture in `team.test.ts` -- keeps compiling and keeps getting exactly the
 * plan it got before, because with no ranking context the chain falls through to step 7 and the
 * candidate id, which IS the tie-break those callers already had.
 */
export interface TeamRanking {
  /** R9: what a person asked for, per capability. */
  readonly preferences: ReadonlyMap<CapabilityKey, RankPreference>
  /** R3: one record per profile key, from the world's bounded read. */
  readonly evidence: ReadonlyMap<string, RankEvidence>
  /** R10: the `deny` rows per EXISTING worker, by `Slave.id`. Templates and company workers carry
   *  none and are neither favoured nor penalised for it. */
  readonly deniedKinds: ReadonlyMap<string, readonly PermissionKind[]>
  /** The catalog template behind each candidate, by the candidate's own id. R9's preference names a
   *  template, and this is how a roster worker is matched against one. */
  readonly templateOf: ReadonlyMap<string, string | null>
  /** The model each candidate would run on -- the resolved chain, by candidate id. */
  readonly modelOf: ReadonlyMap<string, string | null>
  /** R1: the profile key each candidate's record is looked up by, by candidate id. */
  readonly profileKeyOf: ReadonlyMap<string, string>
  /** R10: whose baseline the permission step reads. `implementation` for every staffing decision
   *  the Supervisor makes today. */
  readonly runKind: PermissionRunKind
}
```

`TeamInput` gains `readonly ranking?: TeamRanking`, and a local helper turns any candidate into a `RankCandidate`:

```ts
/** One candidate, as the ranker reads it. Everything the ranking context does not know about a
 *  candidate answers its own neutral value: no template, no model, no denies, no record -- which is
 *  exactly the state a caller with no `ranking` at all is in, and is why that caller's order does
 *  not move. */
function rankCandidateFor(
  input: TeamInput,
  base: { readonly id: string; readonly kind: RankCandidate['kind']; readonly name: string; readonly covers: readonly CapabilityKey[]; readonly busy: boolean },
): RankCandidate {
  const ranking = input.ranking
  return {
    ...base,
    profileKey: ranking?.profileKeyOf.get(base.id) ?? base.id,
    templateId: ranking?.templateOf.get(base.id) ?? null,
    model: ranking?.modelOf.get(base.id) ?? null,
    deniedKinds: ranking?.deniedKinds.get(base.id) ?? [],
    evidence: ranking?.evidence.get(ranking.profileKeyOf.get(base.id) ?? base.id) ?? null,
  }
}

/** The winner of one tier's field, and the step that won it. `null` for an empty field. */
function bestOf(
  input: TeamInput,
  capability: CapabilityKey,
  field: readonly RankCandidate[],
): RankedCandidate | null {
  const ranked = rankCandidates(field, {
    capability,
    preference: input.ranking?.preferences.get(capability) ?? null,
    runKind: input.ranking?.runKind ?? 'implementation',
  })
  return ranked[0] ?? null
}
```

Tier 1's provider pick (`team.ts:123-129`) — the `busy`-then-`slaveId` sort — becomes:

```ts
    // M53 R8: the six steps decide WITHIN the tier. `covers` is one capability here by
    // construction, so step 1 always ties and steps 2-7 are what choose -- which is exactly the
    // `busy`-then-`slaveId` sort this replaces, with four more reasons in front of the id.
    const field = roster
      .filter((member) => member.capabilities.includes(capability))
      .map((member) =>
        rankCandidateFor(input, {
          id: member.slaveId,
          kind: 'slave',
          name: member.name,
          covers: [capability],
          busy: member.busy,
        }),
      )
    const provider = bestOf(input, capability, field)
    if (provider === null) continue
```

with `provider.candidate.id` / `.name` used where `provider.slaveId` / `.name` were, and the winner's `decidedBy` carried into the group so the rationale can name it.

`coverWith`'s `beats()` keeps every break it has — covers count, recommended, capability count, name — and its LAST line, `challenger.id.localeCompare(holder.id) < 0`, becomes a `rankCandidates` comparison over the two candidates. Tiers 2 and 3 therefore keep M47's minimality and M50's recommendation rules exactly, and the alphabetical tie-break at the bottom of them becomes the record, the preference and the cost.

The rationale gains one clause, appended where a step other than `identity` decided:

```ts
      rationale:
        `${member.name} already provides ${labelList(covers, input.taxonomy)} and does not hold the ` +
        `${roles.map((role) => `"${role}"`).join(' and ')} runtime role${roles.length === 1 ? '' : 's'}, so ` +
        `granting ${roles.length === 1 ? 'it' : 'them'} makes them dispatchable for this work with nobody new.` +
        // M53 R8: WHY this one and not the other candidate, in the ranker's own words. Absent when
        // there was no other candidate, and absent when nothing but the names separated them --
        // "we picked alphabetically" is not a reason worth putting in front of a person.
        (provider.decidedBy === null || provider.decidedBy === 'identity' ? '' : ` ${provider.reason}`),
```

- [ ] **Step 9: Run it and watch it pass**

Run: `npx vitest run packages/domain/test/capability/team.test.ts`
Expected: PASS — 8 new cases and **every existing tier-order case unchanged**. If a tier-order case moved, the ranking has leaked out of a tier and into the tier ORDER, which R8 forbids.

- [ ] **Step 10: Build the ranking context from the world**

`packages/domain/src/supervisor/candidates.ts`'s `teamPlanOf` (`:123`) gains the seventh argument to `formTeam`, built from the world in one pass over the three collections the loader already filled:

```ts
  // M53 R8: everything the six steps need, gathered once from the world. `profileKeyOf` is R1's own
  // rule applied to each candidate kind -- a roster worker keys on the template it was hired from or
  // on itself, and a company worker or a catalog entry keys on its template, which both always have
  // (`CompanySlave.templateId` is NOT NULL).
  const templateOf = new Map<string, string | null>()
  const modelOf = new Map<string, string | null>()
  const profileKeys = new Map<string, string>()
  const deniedKinds = new Map<string, readonly PermissionKind[]>()
  for (const slave of world.slaves) {
    templateOf.set(slave.id, slave.hiredFromTemplateId)
    modelOf.set(slave.id, slave.model)
    profileKeys.set(slave.id, profileKeyOf({ slaveId: slave.id, hiredFromTemplateId: slave.hiredFromTemplateId }))
    if (slave.deniedKinds.length > 0) deniedKinds.set(slave.id, slave.deniedKinds)
  }
  for (const worker of world.company) {
    templateOf.set(worker.companySlaveId, worker.templateId)
    profileKeys.set(worker.companySlaveId, `template:${worker.templateId}`)
  }
  for (const entry of world.catalog) {
    templateOf.set(entry.templateId, entry.templateId)
    modelOf.set(entry.templateId, entry.defaultModel)
    profileKeys.set(entry.templateId, `template:${entry.templateId}`)
  }

  const ranking: TeamRanking = {
    preferences: new Map(
      world.staffingPreferences.map((one) => [one.capability, { templateId: one.templateId, model: one.model }] as const),
    ),
    evidence: new Map(world.evidence.map((one) => [one.profileKey, one] as const)),
    deniedKinds,
    templateOf,
    modelOf,
    profileKeyOf: profileKeys,
    // Every staffing decision the Supervisor makes is about implementation work: `assign_capability`
    // grants a runtime role, and the run that role is dispatched as is an `implementation` run.
    // A parameter rather than a constant because `BASELINE_GRANTS` differs per kind and both
    // answers are true (M52 R1).
    runKind: 'implementation',
  }
```

passed to `formTeam` as `ranking`. `packages/domain/test/supervisor/candidates.test.ts` gains two cases: one asserting a world with a preference produces a plan naming the preferred worker, and one asserting a world with the two new collections EMPTY produces exactly the plan it produced before M53.

Run: `npx vitest run packages/domain/test/supervisor packages/domain/test/capability`
Expected: PASS.

- [ ] **Step 11: Prove `decide()` did not move**

A check rather than an edit, because this is the milestone's loudest promise:

```bash
git diff --stat packages/domain/src/scheduler/
grep -rn "scheduler/decide" packages/domain/src/capability packages/domain/src/supervisor packages/control/src apps/orchestrator/src
```

Expected: no output from either. `decide()` is not changed, not imported by anything this milestone touched, and the roadmap's line 27 stands.

- [ ] **Step 12: Run the whole suite, then ladder and commit**

```bash
npx vitest run 2>&1 | tail -20
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```

Expected: ≥ 338 files / ≥ 5642 tests, zero failures. Two to watch and to re-run ALONE before believing: `apps/orchestrator/test/integration/cli.test.ts`'s llm-decision row count doubles when anything else touches the database, and every `pump.test.ts` case now writes an extra row per conclusion — a count assertion that reads one more than it used to is this task's doing and is correct.

```bash
git add apps/orchestrator/src apps/orchestrator/test packages/domain/src/capability packages/domain/src/supervisor packages/domain/test
git commit -m "$(cat <<'EOF'
feat(orchestrator): m53 t3 — six conclusions become facts, four verdicts settle them, and a team is formed by the record

Every run this daemon concludes now leaves one row behind: the pump's four terminal arms and the
sweep's two, and nowhere else. A spawn failure writes nothing at all, because nothing was attempted
and a profile whose dispatches failed to spawn has not been evidenced about. The sweep's two arms
pass `recoveredBySweep`, so a recovery is known from the caller rather than by matching the reason
text of a `run.failed`, which is our own prose and may be reworded tomorrow.

The four verdicts settle three columns. Verify settles first-pass, review settles the rejection
against the IMPLEMENTER's row rather than the reviewer's, auto-merge settles integrated and a hand
merge settles nothing until a person says the branch actually landed -- the `!autoMerge` path writes
`integratedAt: null` on purpose, and M35 spent a milestone on that distinction. A verify that could
not RUN settles nothing: it already refuses to charge the task an attempt, and charging the worker's
record for the orchestrator's problem would be the same mistake in a new column.

`formTeam` stops breaking ties with the alphabet. The `TeamSource` tier order is M47's and has not
moved; within a tier, six steps decide -- what they can do, what they are allowed to do, what
somebody asked for, who is free, what their record says, and what it costs -- and the proposal's
rationale names the step that won. A caller with no ranking context gets exactly the plan it got
yesterday, because with nothing to rank on the chain falls through to the id it already used.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"
```

---

### Task 4: Two verbs a person types and one script that goes back over everything (R7, R9, R12, E15, D27–D30)

The CLI's read and write verbs, and `scripts/backfill-evidence.mjs` — **split into its own task because it is the one data-touching script this milestone owns**, it is the only thing here that walks every row in a production database, and a reviewer who approved the pipeline could reasonably reject the way history is filled in. It also has its own test cycle: idempotence and incomplete-history handling are properties nothing in Task 3 exercises.

**Files:**
- Create: `scripts/backfill-evidence.mjs`, `packages/control/test/integration/backfill.test.ts`
- Modify: `apps/orchestrator/src/cli.ts`, `package.json`
- Test: `apps/orchestrator/test/integration/cli.test.ts`, `packages/control/test/integration/backfill.test.ts`

**Interfaces:**
- Consumes: `recordRunEvidence`, `listEvidence`, `setStaffingPreference`, `clearStaffingPreference`, `listStaffingPreferences`, `refusalText`, `resolveWorkspace`, `resolvePrincipal`, `requireFlag`, `flagText` (all existing in `apps/orchestrator/src/cli.ts`), `domainLabel`, `EVIDENCE_OUTCOME_LABEL`, `COST_PROVENANCE_WORD`.
- Produces: `orchestrator evidence list`, `orchestrator staffing prefer|clear|list`, `npm run backfill:evidence`.

- [ ] **Step 1: Write the failing CLI tests**

`apps/orchestrator/test/integration/cli.test.ts` gains:

```ts
describe('evidence list (M53 R12)', () => {
  it('prints one line per row with the WORDS beside the keys', async () => {
    await seedEvidence(fixture, { outcome: 'succeeded', costProvenance: 'reported', domains: ['backend', 'qa'] })
    const out = await runCli(['evidence', 'list', '--workspace', fixture.workspaceName])
    expect(out).toContain('Backend Developer')
    expect(out).toContain('Finished')
    expect(out).toContain('reported')
    expect(out).toContain('Backend, QA')
  })

  it('filters by domain, and a two-domain row shows under either', async () => {
    await seedEvidence(fixture, { domains: ['backend', 'qa'] })
    expect(await runCli(['evidence', 'list', '--domain', 'backend'])).toContain('Backend Developer')
    expect(await runCli(['evidence', 'list', '--domain', 'design'])).not.toContain('Backend Developer')
  })
})

describe('staffing (M53 R9)', () => {
  it('records a preference and says what it recorded, in words', async () => {
    const out = await runCli(['staffing', 'prefer', '--workspace', fixture.workspaceName, '--capability', 'backend.services', '--template', fixture.templateId])
    expect(out).toContain('Services')
    expect(out).toContain('Backend Developer')
    expect(await prisma.staffingPreference.count()).toBe(1)
  })

  it('refuses a preference naming neither a profile nor a model, with the refusal own sentence', async () => {
    await expect(runCli(['staffing', 'prefer', '--capability', 'backend.services'])).rejects.toThrow(
      /must name a profile, a model, or both/u,
    )
  })

  it('lists the decisions with the LABEL first and the key beside it', async () => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    const out = await runCli(['staffing', 'list', '--workspace', fixture.workspaceName])
    expect(out).toMatch(/Services\tbackend\.services/u)
  })

  it('clears a decision, and clearing nothing succeeds', async () => {
    await setStaffingPreference(fixture.workspaceId, { capability: 'backend.services', model: 'opus' })
    await runCli(['staffing', 'clear', '--capability', 'backend.services', '--workspace', fixture.workspaceName])
    expect(await prisma.staffingPreference.count()).toBe(0)
    await expect(runCli(['staffing', 'clear', '--capability', 'backend.services', '--workspace', fixture.workspaceName])).resolves.toBeTruthy()
  })
})
```

- [ ] **Step 2: Run them, watch them fail, and write the two verbs**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts -t 'evidence list'` → FAIL (`unknown command: evidence`).

`apps/orchestrator/src/cli.ts`, two cases after `broker` and before `help`, in the shape this file has fifty of.

```ts
    /**
     * M53 R12: the fact table, as lines. A READ ONLY -- there is no `evidence record` and no
     * `evidence delete`: the pipeline is the only writer (R3) and a row is never deleted, so a verb
     * that wrote one by hand would be a second derivation with a person's hand in it.
     */
    case 'evidence': {
      const sub = argv[1] ?? 'list'
      if (sub !== 'list') throw new Error('evidence takes list')
      const workspaceId = flagText(flags, 'workspace') === undefined ? null : await resolveWorkspace(flags)
      const domain = flagText(flags, 'domain') ?? null
      for (const row of await listEvidence({ workspaceId, domain })) {
        // The WORDS first and the keys beside them (`docs/ia.md` rule 3): the label is what a person
        // reads, the key is what they paste into `--domain`, and a CLI's "expanded view" is the line.
        process.stdout.write(
          `${row.profileName}\t${row.profileKey}\t${row.model ?? MODEL_NOT_RECORDED_LABEL}\t` +
            `${row.domains.map(domainLabel).join(', ')}\t${EVIDENCE_OUTCOME_LABEL[row.outcome]}\t` +
            `attempt ${String(row.attempt)}\t${COST_PROVENANCE_WORD[row.costProvenance]}\t` +
            `${row.recordedAt.toISOString()}\n`,
        )
      }
      return 0
    }

    /** M53 R9: who -- or what model -- should take a capability on this project. */
    case 'staffing': {
      const sub = argv[1] ?? 'list'
      const workspaceId = await resolveWorkspace(flags)
      if (sub === 'list') {
        for (const one of await listStaffingPreferences(workspaceId)) {
          process.stdout.write(
            `${one.capabilityLabel}\t${one.capability}\t${one.templateName ?? '-'}\t${one.model ?? '-'}\t` +
              `${one.setAt.toISOString()}\n`,
          )
        }
        return 0
      }
      const capability = requireFlag(flags, 'capability')
      // BEFORE the write, so a `--by` nobody carries refuses instead of leaving a row behind.
      const principal = await resolvePrincipal(flags)
      if (sub === 'prefer') {
        const templateId = flagText(flags, 'template')
        const model = flagText(flags, 'model')
        const result = await setStaffingPreference(
          workspaceId,
          { capability, ...(templateId === undefined ? {} : { templateId }), ...(model === undefined ? {} : { model }) },
          principal,
        )
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(
          `${result.value.capabilityLabel} (${capability}) goes to ` +
            `${result.value.templateName ?? 'whoever is free'}${result.value.model === null ? '' : ` on ${result.value.model}`}\n`,
        )
        return 0
      }
      if (sub === 'clear') {
        const result = await clearStaffingPreference(workspaceId, capability, principal)
        if (!result.ok) throw new Error(refusalText(result.error))
        process.stdout.write(`nobody in particular is asked for on ${capability} any more\n`)
        return 0
      }
      throw new Error('staffing takes prefer, clear or list')
    }
```

`USAGE` gains the two verbs in the block that lists the others.

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts`
Expected: PASS — 6 new cases. Re-run it ALONE before believing a failure: the llm-decision row count in this file doubles when anything else touches the database.

- [ ] **Step 3: Write the failing test for the backfill**

`packages/control/test/integration/backfill.test.ts`. The script's BODY is a plain exported async function so the test drives the same code the `.mjs` entry point does — no child process, no `--env-file`, and a failure names a line rather than an exit code.

```ts
describe('backfillEvidence (M53 R7)', () => {
  it('records every terminal run and skips every live one', async () => {
    await seedRuns(fixture, { terminal: 3, live: 2 })
    const report = await backfillEvidence({ batchSize: 2 })
    expect(report.recorded).toBe(3)
    expect(await prisma.evidenceRecord.count()).toBe(3)
  })

  it('is IDEMPOTENT to the byte, `recordedAt` included (stage 5, erratum E15)', async () => {
    await seedRuns(fixture, { terminal: 4 })
    await backfillEvidence({ batchSize: 2 })
    const first = await prisma.evidenceRecord.findMany({ orderBy: { runId: 'asc' } })
    await backfillEvidence({ batchSize: 2 })
    const second = await prisma.evidenceRecord.findMany({ orderBy: { runId: 'asc' } })
    expect(second).toEqual(first)
  })

  it('walks in `id` order in bounded batches, so the order it walks cannot change the result', async () => {
    await seedRuns(fixture, { terminal: 5 })
    const wide = await backfillEvidence({ batchSize: 100 })
    const rowsWide = await prisma.evidenceRecord.findMany({ orderBy: { runId: 'asc' } })
    await prisma.evidenceRecord.deleteMany({})
    const narrow = await backfillEvidence({ batchSize: 1 })
    expect(narrow.recorded).toBe(wide.recorded)
    expect((await prisma.evidenceRecord.findMany({ orderBy: { runId: 'asc' } })).map((r) => r.runId)).toEqual(
      rowsWide.map((r) => r.runId),
    )
  })

  it('records a run whose `run.started` event has been REMOVED, with zeros and nulls (R7)', async () => {
    const runId = await seedTerminalRun(fixture)
    await prisma.executionEvent.deleteMany({ where: { runId } })
    await backfillEvidence({})
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })
    expect(row.attempt).toBe(1)
    expect(row.reworkCycles).toBe(0)
    expect(row.humanInterventions).toBe(0)
    expect(row.recoveries).toBe(0)
    expect(row.verifiedFirstPass).toBeNull()
    expect(row.reviewRejected).toBeNull()
    expect(row.integrated).toBeNull()
    // The run-local columns come from the ROW, which always exists.
    expect(row.outcome).toBe('succeeded')
    expect(row.repositoryKey).toBe(fixture.repoPath)
  })

  it('REPORTS the runs it could not record rather than failing the pass', async () => {
    await seedRuns(fixture, { terminal: 2 })
    const report = await backfillEvidence({ batchSize: 1, recordOne: async () => ({ ok: false, error: { kind: 'run_not_found', runId: 'x' } }) })
    expect(report.recorded).toBe(0)
    expect(report.skipped).toBe(2)
  })

  it('never settles a judgement column -- history is filled in, never judged', async () => {
    const runId = await seedTerminalRun(fixture)
    await prisma.evidenceRecord.deleteMany({})
    await backfillEvidence({})
    const row = await prisma.evidenceRecord.findUniqueOrThrow({ where: { runId } })
    expect(row.settledAt).toBeNull()
  })
})
```

- [ ] **Step 4: Run it, watch it fail, and write the script**

Run: `npx vitest run packages/control/test/integration/backfill.test.ts` → FAIL (`Failed to resolve import '../../../../scripts/backfill-evidence.mjs'`).

`scripts/backfill-evidence.mjs`, header first:

```js
// scripts/backfill-evidence.mjs — "history counts from day one" (M53 R7).
//
//   npm run backfill:evidence
//   npm run backfill:evidence -- --batch 500 --dry-run
//
// Walks every `SlaveRun` with a non-null `terminalAt`, in `id` order, in bounded batches, and calls
// the SAME `recordRunEvidence` the pipeline calls. There is one derivation in this system and this
// script does not add a second: a rule written twice is a rule that eventually disagrees with
// itself, and the thing it would disagree about here is whether a profile is any good.
//
// DETERMINISTIC. Every input is a stored row or a stored event; the only clock it reads is
// `recordedAt`'s default on a row that does not yet exist; and the order it walks in cannot change
// the result, because each run's derivation reads only that run and its own task's events.
//
// IDEMPOTENT, AND NOT BY CHECKING. It has no "skip rows that already exist" branch, deliberately
// (plan erratum E15): `recordRunEvidence`'s upsert re-derives every column and its `update` half
// touches neither `recordedAt` nor `settledAt` nor any judgement column, so a second pass writes
// the same bytes. A skip branch would make the second pass prove nothing.
//
// RUNS WHOSE EVENTS ARE INCOMPLETE are the normal case on an old database, and they are recorded
// honestly rather than skipped: the run-local columns (outcome, duration, cost, provenance, kind and
// all four dimension keys) come from the `SlaveRun` ROW, which always exists; the event-derived
// counters read a count over a possibly-empty set and record zero, because a count over nothing IS
// zero; and the three JUDGEMENT columns stay null -- "nobody judged this, or the record of the
// judgement is gone" -- rather than settling `false`, which would manufacture a failure.
//
// A run this script cannot record is COUNTED AND REPORTED, never fatal: one unreadable row must not
// stop an operator filling in five years of history.
//
// IT IS NOT A MIGRATION. `20260913090000_m53_evidence` is additive DDL and carries no data statement
// at all; the data arrives here, run once by a person who chose to run it. That is ADR 0003's
// discipline (one write gate, and data statements do not hide inside schema changes), not a style
// preference.
```

The body, with the three rules the cases above pin:

```js
export async function backfillEvidence({ batchSize = 200, dryRun = false, recordOne = recordRunEvidence } = {}) {
  let cursor = null
  let scanned = 0
  let recorded = 0
  let skipped = 0
  for (;;) {
    // A CURSOR and never an OFFSET: an offset re-reads and re-sorts everything it skips, which on a
    // five-year table is the whole table once per batch. `id` is the primary key, so this is an
    // index range scan whatever the batch size is -- which is also what makes the batch size not
    // change the result.
    const runs = await prisma.slaveRun.findMany({
      where: { terminalAt: { not: null }, ...(cursor === null ? {} : { id: { gt: cursor } }) },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    })
    if (runs.length === 0) break
    for (const run of runs) {
      scanned += 1
      if (dryRun) continue
      const result = await recordOne(run.id)
      if (result.ok) recorded += 1
      else {
        skipped += 1
        // NAMED, not counted silently: an operator who runs this once needs to know which rows the
        // log is missing, and `refusalText` is the sentence this system already has for it.
        process.stderr.write(`backfill: skipped run ${run.id}: ${refusalText(result.error)}\n`)
      }
    }
    cursor = runs[runs.length - 1].id
  }
  return { scanned, recorded, skipped }
}
```

with an entry point that parses `--batch` / `--dry-run`, runs it, prints `scanned N, recorded N, skipped N`, and `process.exit(skipped > 0 ? 1 : 0)` — an operator who was told nothing was skipped and then finds a hole should have seen a non-zero status.

`package.json` gains `"backfill:evidence": "tsc --build && node --env-file=.env scripts/backfill-evidence.mjs"` beside the other `scripts/*.mjs` entries and NOT among the `gate:*` ones.

Run: `npx vitest run packages/control/test/integration/backfill.test.ts`
Expected: PASS — 6 cases.

- [ ] **Step 5: Prove the script touches nothing else**

Two checks rather than an edit:

```bash
grep -nE "DELETE|deleteMany|update\(|updateMany|\$executeRaw" scripts/backfill-evidence.mjs   # expect no output
grep -n "recordRunEvidence" scripts/backfill-evidence.mjs                                     # exactly one import, one call
```

The first is the whole safety argument: the only write this script can cause is the one `recordRunEvidence` makes, and that one is an upsert on a table nothing else owns.

- [ ] **Step 6: Ladder and commit**

```bash
npx vitest run 2>&1 | tail -20
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```

```bash
git add apps/orchestrator/src/cli.ts apps/orchestrator/test scripts/backfill-evidence.mjs packages/control/test package.json
git commit -m "$(cat <<'EOF'
feat(cli): m53 t4 — two verbs a person types, and one script that goes back over everything

`evidence list` prints the fact table with the words in front and the keys beside them; there is no
`evidence record` and no `evidence delete`, because the pipeline is the only writer and a row is
never deleted -- a verb that wrote one by hand would be a second derivation with a person's hand in
it. `staffing prefer|clear|list` is the CLI half of a decision a person takes, refusing a preference
that names neither a profile nor a model before it writes anything.

`scripts/backfill-evidence.mjs` walks every terminal run in `id` order, in bounded batches, through a
cursor rather than an offset, and calls exactly the `recordRunEvidence` the pipeline calls. It has no
"skip what exists" branch on purpose: idempotence is a property of the writer -- the upsert's update
half touches neither `recordedAt` nor a judgement column -- and a skip branch would make a second
pass prove nothing. A run whose events are gone is recorded honestly, with zeros in the counters and
nulls in the judgements, because a count over nothing is zero and nobody judged that run. A run it
cannot record is named on stderr and counted in the exit status, never fatal.

The migration carries no data statement at all. The data arrives here, once, when an operator
decides it should.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"
```

---

### Task 5: A sixth tab with two tables, a tile that hands over, and a preference a person sets where the decision is read (R6, R9, R11, R12, E6, E11, E12, E18, D31–D38)

`apps/web` only. The surface half of the milestone: the Evidence tab, the analytics hand-over `docs/ia.md` has promised at two rows since M44, the preference control, and the one gate pin the deleted table takes with it.

**Files:**
- Create: `apps/web/src/server/evidence.ts`, `apps/web/src/components/workforce/EvidenceTab.tsx`, `apps/web/src/app/api/w/[workspaceId]/staffing/[capability]/route.ts`, `apps/web/test/evidence-tab.test.tsx`, `apps/web/test/integration/evidence-page.test.ts`, `apps/web/test/integration/staffing-routes.test.ts`
- Modify: `apps/web/src/components/workforce/WorkforceClient.tsx`, `apps/web/src/app/workforce/page.tsx`, `apps/web/src/server/analytics.ts`, `apps/web/src/components/AnalyticsClient.tsx`, `apps/web/src/components/analytics/KpiStrip.tsx`, `apps/web/src/server/organization.ts`, `apps/web/src/components/organization/OrganizationClient.tsx`, `apps/web/test/analytics-page.test.tsx`, `apps/web/test/integration/analytics.test.ts`, `apps/web/test/organization-page.test.tsx`, `scripts/gate-m16-chrome.mjs`, `docs/ia.md`
- Delete: `apps/web/test/integration/analytics-aggregates.test.ts`
- Test: the three new test files, plus the four modified ones

**Interfaces:**
- Consumes: `evidenceByProfile`, `evidenceByModel`, `setStaffingPreference`, `clearStaffingPreference`, `listStaffingPreferences` (Task 2); `INSUFFICIENT_EVIDENCE`, `MODEL_NOT_RECORDED_LABEL`, `BESPOKE_PROFILE_LABEL`, `EVIDENCE_MIN_SAMPLE`, `domainLabel`, `GENERAL_DOMAIN`, `isBespokeProfileKey`, `COST_PROVENANCE_WORD` (Task 1); `formatUsd` (`apps/web/src/lib/realMoney.ts:26`), `formatDuration` (`apps/web/src/lib/format.ts`), `DataTable`/`Row`, `Panel`, `Chip`, `ProgressBar`, `Tabs`, `workspaceControlResponse`, `requirePrincipal`.
- Produces, for Task 6: `buildEvidencePage(filter: { domain: string | null }): Promise<EvidencePage>` and the types `EvidencePage` (`{ domains, byProfile, byModel, sortCaption, minSample }`), `EvidenceProfileRow`, `EvidenceModelRow` and `EvidenceRate` (`apps/web/src/server/evidence.ts`); `WorkforceTab` gains `'evidence'` and `WorkforceClient` an `evidence: EvidencePage` prop; and the testids `evidence-table-profile`, `evidence-table-model`, `evidence-profile-row-<profileKey>`, `evidence-model-row-<model>`, `evidence-insufficient-<key>`, `evidence-domain-<domain>`, `evidence-sort-caption`, `evidence-link` (on `/analytics`), `staffing-preference-<capability>`, `staffing-clear-<capability>`; and `PUT|DELETE /api/w/[workspaceId]/staffing/[capability]`.

- [ ] **Step 1: Write the failing integration test for the page read**

`apps/web/test/integration/evidence-page.test.ts`:

```ts
describe('buildEvidencePage (M53 R11, R12)', () => {
  it('answers two tables, deliberately -- profile performance and model performance are two questions', async () => {
    await seedEvidence(fixture, 6)
    const page = await buildEvidencePage({ domain: null })
    expect(page.byProfile).toHaveLength(1)
    expect(page.byModel).toHaveLength(1)
  })

  it('replaces EVERY rate with the words when the row attempted count is thin (R11)', async () => {
    await seedEvidence(fixture, 2)
    const row = (await buildEvidencePage({ domain: null })).byProfile[0]
    expect(row?.insufficient).toBe(true)
    expect(row?.firstPassPct).toBeNull()
    expect(row?.reviewRejectedPct).toBeNull()
    expect(row?.integratedPct).toBeNull()
    // The COUNTS stay: they are facts, and only the rates are claims.
    expect(row?.attempted).toBe(2)
  })

  it('replaces ONE rate whose own denominator is thin while its neighbours stay percentages (R11)', async () => {
    await seedEvidence(fixture, 8, { judged: { firstPass: 8, review: 8, integration: 2 } })
    const row = (await buildEvidencePage({ domain: null })).byProfile[0]
    expect(row?.insufficient).toBe(false)
    expect(row?.firstPassPct).not.toBeNull()
    expect(row?.integratedPct).toBeNull()
  })

  it('carries the LABEL and never a bare key for every cell a person reads (ia.md rule 3)', async () => {
    await seedEvidence(fixture, 6, { domains: ['qa'] })
    const page = await buildEvidencePage({ domain: null })
    expect(page.byProfile[0]?.name).toBe('Backend Developer')
    expect(page.byProfile[0]?.profileKey).toMatch(/^template:/u)
    expect(page.domains.map((one) => one.label)).toContain('QA')
  })

  it('marks a bespoke profile, so a reader does not take it for a persona record (R1)', async () => {
    await seedBespokeEvidence(fixture, 6)
    expect((await buildEvidencePage({ domain: null })).byProfile[0]?.bespoke).toBe(true)
  })

  it('names the null model group in words in the by-model table (R1)', async () => {
    await seedEvidence(fixture, 6, { model: null })
    expect((await buildEvidencePage({ domain: null })).byModel[0]?.label).toBe('Model not recorded')
  })

  it('splits the money three ways with the three words, and never sums them into one (R6)', async () => {
    await seedEvidence(fixture, 6, { reported: 2, estimated: 3, unmeasured: 1 })
    const row = (await buildEvidencePage({ domain: null })).byProfile[0]
    expect(row?.reportedUsd).not.toBeNull()
    expect(row?.estimatedUsd).not.toBeNull()
    expect(row?.unmeasuredRuns).toBe(1)
  })

  it('offers the domain chips the data actually has, always including `general`', async () => {
    await seedEvidence(fixture, 3, { domains: ['backend'] })
    const page = await buildEvidencePage({ domain: null })
    expect(page.domains.map((one) => one.domain)).toContain('backend')
  })

  it('sorts by attempted descending then by NAME ascending, and says so in the caption (R11)', async () => {
    await seedTwoProfiles(fixture, { ann: 2, zed: 2 })
    const page = await buildEvidencePage({ domain: null })
    expect(page.byProfile.map((one) => one.name)).toEqual(['Ann', 'Zed'])
    expect(page.sortCaption).toMatch(/most runs first/iu)
    expect(page.sortCaption).toMatch(/name/iu)
  })
})
```

- [ ] **Step 2: Run it, watch it fail, and write the view**

Run: `npx vitest run apps/web/test/integration/evidence-page.test.ts` → FAIL (`Failed to resolve import "../../src/server/evidence"`).

`apps/web/src/server/evidence.ts` — the VIEW and no SQL (erratum E6). It calls `evidenceByProfile` / `evidenceByModel` from `@slave-of-ai/control` exactly as `buildOrganization` calls `loadSupervisorWorld`, and owns four things the control layer deliberately does not: the labels, the `Insufficient evidence` substitution, the sort caption, and the domain chip list.

```ts
/**
 * The Evidence tab's whole read (M53 R12).
 *
 * NO SQL LIVES HERE (plan erratum E6). `packages/control/src/evidence.ts` owns the one aggregation
 * over `EvidenceRecord`; two `GROUP BY`s over one table would eventually disagree in front of a
 * person about how many runs a profile has attempted, and the disagreement would surface on this
 * page. What this module owns is what a person READS: the words for every key, the rate that
 * becomes `Insufficient evidence`, the sentence the sort is stated in, and the chips.
 *
 * GLOBAL, not per project: `/workforce` has no workspace scope, and R1's record spans every project
 * this installation holds. `EvidenceFilter.workspaceId` exists for the per-project read a later
 * milestone may want and is null here.
 */
export interface EvidenceRate {
  /** The percentage, or NULL when this rate's own denominator is below `EVIDENCE_MIN_SAMPLE`. A
   *  null renders {@link INSUFFICIENT_EVIDENCE} and no progress bar at all -- not a dash, not a
   *  zero, and not a greyed percentage (R11), which is also what `gate:m16-chrome`'s moved check 5
   *  measures (plan erratum E11). */
  readonly pct: number | null
  /** The denominator, always shown: a count is a fact and only a rate is a claim. */
  readonly judged: number
}
```

with `EvidenceProfileRow` carrying `{ profileKey, name, bespoke, repositoryKey, attempted, firstPass, reviewRejected, integrated, reworkCycles, humanInterventions, recoveries, medianDurationMs, reportedUsd, estimatedUsd, unmeasuredRuns, insufficient }`, `EvidenceModelRow` carrying `{ model, label, attempted, firstPass, reviewRejected, integrated, medianDurationMs, reportedUsd, estimatedUsd, unmeasuredRuns, insufficient }`, and

```ts
/** R11: a rate is a claim, and a claim needs a sample. `pct` is null below the constant, whether the
 *  ROW is thin or only this one denominator is -- the three judgement columns settle independently
 *  (R3), so a row with twenty attempts and two integrations is ordinary rather than exotic. */
const rateOf = (numerator: number, judged: number): EvidenceRate => ({
  pct: judged < EVIDENCE_MIN_SAMPLE ? null : Math.round((numerator / judged) * 100),
  judged,
})

/** The sort, in the words the caption prints. Stated on the page rather than left to be inferred
 *  from the order (R11), and asserted against the caption itself by `gate:m53-evidence` stage 11. */
const SORT_CAPTION = 'Most runs first, then by name. Nothing here is a score.'
```

`buildEvidencePage({ domain })` then: calls the two control reads in one `Promise.all`; maps each group into a row, with `bespoke: isBespokeProfileKey(group.profileKey)` and `label: group.model ?? MODEL_NOT_RECORDED_LABEL`; sets `insufficient: group.attempted < EVIDENCE_MIN_SAMPLE`; builds `domains` as `[...new Set(everyDomainSeen)].toSorted().map((d) => ({ domain: d, label: domainLabel(d) }))` with `GENERAL_DOMAIN` always present; and returns `{ domains, byProfile, byModel, sortCaption: SORT_CAPTION, minSample: EVIDENCE_MIN_SAMPLE }`.

Run: `npx vitest run apps/web/test/integration/evidence-page.test.ts`
Expected: PASS — 9 cases.

- [ ] **Step 3: Write the failing component test for the tab**

`apps/web/test/evidence-tab.test.tsx` (first line `// @vitest-environment jsdom`):

```tsx
describe('EvidenceTab (M53 R11, R12)', () => {
  it('renders two tables and no chart at all -- counts and rates, never a vanity chart', () => {
    render(<EvidenceTab page={page()} />)
    expect(screen.getByTestId('evidence-table-profile')).toBeTruthy()
    expect(screen.getByTestId('evidence-table-model')).toBeTruthy()
    expect(screen.queryByTestId('bar-chart')).toBeNull()
  })

  it('prints the profile NAME with the key in `title` and on `data-profile-key`, never as text', () => {
    render(<EvidenceTab page={page()} />)
    const row = screen.getByTestId('evidence-profile-row-template:t1')
    expect(row.textContent).toContain('Backend Developer')
    expect(row.textContent).not.toContain('template:t1')
    expect(row.getAttribute('data-profile-key')).toBe('template:t1')
  })

  it('chips a bespoke profile', () => {
    render(<EvidenceTab page={page({ bespoke: true })} />)
    expect(screen.getByText('Bespoke')).toBeTruthy()
  })

  it('renders the WORDS in place of every rate on a thin row, with the counts still beside them', () => {
    render(<EvidenceTab page={page({ insufficient: true, attempted: 2 })} />)
    expect(screen.getByTestId('evidence-insufficient-template:t1')).toBeTruthy()
    expect(screen.getAllByText('Insufficient evidence').length).toBeGreaterThan(0)
    expect(screen.getByTestId('evidence-profile-row-template:t1').textContent).toContain('2')
  })

  it('renders one thin rate as the words while its neighbours render percentages', () => {
    render(<EvidenceTab page={page({ integrated: { pct: null, judged: 2 } })} />)
    const row = screen.getByTestId('evidence-profile-row-template:t1')
    expect(row.textContent).toContain('Insufficient evidence')
    expect(row.textContent).toMatch(/\d+%/u)
  })

  it('gives a shown rate a progress bar carrying `aria-valuenow`, and a thin one NO bar (erratum E11)', () => {
    const { container } = render(<EvidenceTab page={page()} />)
    expect(container.querySelector('[data-testid="progress-bar"][aria-valuenow]')).toBeTruthy()
    cleanup()
    const thin = render(<EvidenceTab page={page({ insufficient: true })} />)
    expect(thin.container.querySelector('[data-testid="progress-bar"]')).toBeNull()
  })

  it('renders money with `formatUsd` and the three provenance words, the unmeasured count on its own line', () => {
    render(<EvidenceTab page={page({ reportedUsd: 8.5, estimatedUsd: 1, unmeasuredRuns: 3 })} />)
    const row = screen.getByTestId('evidence-profile-row-template:t1')
    expect(row.textContent).toContain('$8.50 reported')
    expect(row.textContent).toContain('$1.00 estimated')
    expect(row.textContent).toContain('3 unmeasured')
  })

  it('renders the domain chips with words, the raw key on `data-domain`', () => {
    render(<EvidenceTab page={page()} />)
    const chip = screen.getByTestId('evidence-domain-qa')
    expect(chip.textContent).toBe('QA')
    expect(chip.getAttribute('data-domain')).toBe('qa')
  })

  it('names the null-model group in words in the by-model table', () => {
    render(<EvidenceTab page={page({ model: null })} />)
    expect(screen.getByTestId('evidence-model-row-').textContent).toContain('Model not recorded')
  })

  it('states the sort in a caption rather than leaving it to be inferred (R11)', () => {
    render(<EvidenceTab page={page()} />)
    expect(screen.getByTestId('evidence-sort-caption').textContent).toMatch(/Most runs first, then by name/u)
  })

  it('prints no `EvidenceOutcome`, `EvidenceCostProvenance` or domain KEY as visible text anywhere', () => {
    const { container } = render(<EvidenceTab page={page()} />)
    for (const key of ['succeeded', 'failed', 'stopped', 'backend', 'qa', 'general']) {
      expect(container.textContent ?? '', key).not.toMatch(new RegExp(`\\b${key}\\b`, 'u'))
    }
  })
})
```

- [ ] **Step 4: Run it, watch it fail, and write the tab**

Run: `npx vitest run apps/web/test/evidence-tab.test.tsx` → FAIL (module not found).

`apps/web/src/components/workforce/EvidenceTab.tsx`, a `'use client'` component taking one `EvidencePage` prop. Structure, with every rule a case above pins:

- A `Panel` per table, `DataTable` + `Row` (the house table primitives the deleted per-slave table used), with the by-profile columns `Profile | Repository | Attempted | Verified first pass | Review rejected | Rework cycles | Integrated | Interventions | Recoveries | Median duration | Cost` and the by-model columns `Model | Attempted | Verified first pass | Review rejected | Integrated | Median duration | Cost`.
- A chip row above both, `data-testid={`evidence-domain-${one.domain}`}` and `data-domain={one.domain}`, printing `one.label`; the selected chip writes `?domain=` with `window.history.replaceState`, `WorkforceClient`'s own rule for `?tab=`, MERGED into the existing query so a link arriving with `?tab=evidence` keeps it.
- **`BarChart` is not imported.** Nothing on this tab is a chart, a sparkline or a trend line.
- A rate cell is one helper, used six times:

```tsx
/** One rate, or the words (M53 R11). The BAR renders only when the rate does: `ProgressBar` with a
 *  null `pct` draws a track carrying no `aria-valuenow`, and a greyed empty bar beside the words is
 *  exactly the "greyed percentage" R11 rejected. `gate:m16-chrome`'s check 5 moved onto this pair
 *  (plan erratum E11) -- a shown rate has a bar with a value, a thin one has neither. */
function RateCell({ rate, testId }: { readonly rate: EvidenceRate; readonly testId: string }): React.JSX.Element {
  if (rate.pct === null) {
    return (
      <span data-testid={testId} className="text-[11px] text-text-3">
        {INSUFFICIENT_EVIDENCE}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1">
      <span className="w-[34px]">
        <ProgressBar pct={rate.pct} />
      </span>
      <span className="font-mono text-[11px] text-text-2">{`${String(rate.pct)}%`}</span>
      <span className="font-mono text-[9.5px] text-text-3">{`of ${String(rate.judged)}`}</span>
    </span>
  )
}
```

- Money is one helper too, `formatUsd` only and `formatMinor` never:

```tsx
/** R6 and `docs/ia.md` rule 4: three numbers with three words beside them, and the unmeasured count
 *  on its own line -- never one figure that silently absorbs the runs nobody measured, which is the
 *  raw `SUM(costUsd)` this tab replaces. `formatUsd` is the one real-money formatter; `formatMinor`
 *  is simulated money and is not imported here. */
function CostCell(props: { readonly reportedUsd: number; readonly estimatedUsd: number; readonly unmeasuredRuns: number }): React.JSX.Element {
  return (
    <span className="flex flex-col text-[11px]">
      <span className="font-mono text-text-1">{`${formatUsd(props.reportedUsd)} ${COST_PROVENANCE_WORD.reported}`}</span>
      <span className="font-mono text-text-2">{`${formatUsd(props.estimatedUsd)} ${COST_PROVENANCE_WORD.estimated}`}</span>
      {props.unmeasuredRuns > 0 && (
        <span className="text-text-3">{`${String(props.unmeasuredRuns)} ${COST_PROVENANCE_WORD.unmeasured}`}</span>
      )}
    </span>
  )
}
```

- The caption is a `SectionLabel` with `data-testid="evidence-sort-caption"` under both tables.

Run: `npx vitest run apps/web/test/evidence-tab.test.tsx`
Expected: PASS — 11 cases.

- [ ] **Step 5: Add the sixth tab**

`apps/web/src/components/workforce/WorkforceClient.tsx`:

```ts
export type WorkforceTab = 'slaves' | 'departments' | 'catalog' | 'skills' | 'runbooks' | 'evidence'
```

and `WORKFORCE_TABS` gains, LAST:

```ts
  // M53 R12, LAST: a record is what you look at after you know who is here, what they are made of
  // and how they are asked to work. `docs/ia.md:41` and `:58` promised this since M44 -- the
  // per-profile evidence that replaces the Analytics tiles.
  { id: 'evidence', label: 'Evidence' },
```

with `{tab === 'evidence' && <EvidenceTab page={evidence} />}` beside the other five, and an `evidence: EvidencePage` prop.

`apps/web/src/app/workforce/page.tsx`'s `TAB_IDS` gains `'evidence'` so `?tab=evidence` is bookmarkable like the other five, and its `Promise.all` gains `buildEvidencePage({ domain: queryOf(params).get('domain') })` — read on the server, beside the other eleven, and seeded with the domain the URL already claims to be filtering by (the `parseCatalogFilters` precedent at `:66`).

`apps/web/test/workforce-page.test.tsx` gains one case asserting six tabs and that `?tab=evidence` selects the sixth.

- [ ] **Step 6: The analytics hand-over (R6, R12, errata E12, E18)**

Four deletions and one link, all in one commit because the type deletions break the tests in the same build.

`apps/web/src/server/analytics.ts`: delete `perSlaveRunAggregates`, `SlaveAggRow`, `SlavePerformanceRow` and `AnalyticsSnapshot.perSlave`. `buildAnalytics`' KPI list loses the `Spend` tile and keeps the other five in order; the aggregate loop that fed `knownUsd` and `unknownRuns` goes with it, while `durationMsSum` / `durationCount` / `toolCallsTotal` stay — so the query the five remaining tiles need is a much narrower `groupBy`, not the raw `SUM(costUsd)` scan. The module docstring's "Cost is KNOWN cost" bullet and "The KPI tiles and per-slave table" sentence are rewritten to name what remains and to point at `/workforce?tab=evidence`.

`apps/web/src/components/AnalyticsClient.tsx`: delete `PERF_COLUMNS`, `PERF_HEADER`, the `slave performance` `Panel` and its imports (`AvatarTile`, `DataTable`, `Row`, `ProgressBar`, `formatTokens`, `formatUsd`). In its place, one line:

```tsx
          <Panel title="how this workforce is doing">
            {/* `docs/ia.md` rule 2: nothing is removed, only moved. The per-slave table that stood
              * here counted one project's materialised workers and summed `costUsd` raw -- no
              * provenance, no profile, no model, no domain. Its questions are answered on the
              * Evidence tab, per PROFILE and per MODEL, which are two different questions. */}
            <p className="text-xs text-text-2">
              Per-profile and per-model evidence — counts, rates and what it cost —{' '}
              <a data-testid="evidence-link" className="underline" href="/workforce?tab=evidence">
                moved to Workforce → Evidence
              </a>
              .
            </p>
          </Panel>
```

`apps/web/src/components/analytics/KpiStrip.tsx`: `xl:grid-cols-6` becomes `xl:grid-cols-5`, and its docstring says five (erratum E18). `AnalyticsClient`'s own page docstring and the comment at `:75` move with it, and so does `AnalyticsSnapshot.kpis`' "Exactly six" contract.

`apps/web/test/analytics-page.test.tsx`: the snapshot fixture loses `perSlave` and the `Spend` tile, `renders six KPI tiles` becomes five, the `kpi-note-Spend` assertion goes, and the two per-slave cases (`renders the per-slave table…`, `says how many of a slave runs went unmeasured…`) are DELETED and replaced by one:

```tsx
  it('hands the per-slave question over rather than dropping it (ia.md rule 2)', () => {
    render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    const link = screen.getByTestId('evidence-link')
    expect(link.getAttribute('href')).toBe('/workforce?tab=evidence')
    expect(screen.queryByTestId('perf-success-a1')).toBeNull()
  })
```

`apps/web/test/integration/analytics-aggregates.test.ts` is **deleted** — it is the equivalence proof for a computation that no longer exists. `apps/web/test/integration/analytics.test.ts` loses its ten `perSlave` cases (`:130-182`) and its Spend-tile case (erratum E12); everything about the series, the seeded flag and the remaining five tiles stays.

- [ ] **Step 7: Move `gate:m16-chrome`'s check 5 (erratum E11)**

`scripts/gate-m16-chrome.mjs`, check 5's heading comment and body. It goes to the surface that now carries the wiring, and asserts the stronger pair:

```js
  // ============================================================================================
  // Check 5: Evidence /workforce?tab=evidence -- M53 R12 deleted the per-slave Analytics table this
  // check used to read (plan erratum E11), and the wiring moved with it. The claim is the same and
  // the form is stronger: a rate the page SHOWS carries a `progress-bar` with `aria-valuenow`, and a
  // rate below `EVIDENCE_MIN_SAMPLE` renders the words `Insufficient evidence` and NO bar at all --
  // R11's "not a greyed percentage" is an absence a browser can measure.
  // ============================================================================================
  await page.goto(url('/workforce?tab=evidence'), { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('evidence-table-profile'), 'the by-profile evidence table')
  const cells = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="evidence-profile-row-"]')].map((row) => ({
      insufficient: row.querySelector('[data-testid^="evidence-insufficient-"]') !== null,
      bars: row.querySelectorAll('[data-testid="progress-bar"]').length,
      valued: row.querySelectorAll('[data-testid="progress-bar"][aria-valuenow]').length,
    })),
  )
```

with the assertion: every row is either `insufficient` with `bars === 0`, or not insufficient with `bars === valued` and `valued > 0`. The fallback branch (no thin row in this database) prints which branch it exercised, exactly as the old check did — the wiring must be shown to exist in at least one direction, and saying which one is what stopped that check being vacuous.

- [ ] **Step 8: The preference, where the staffing decision is read (R9)**

`apps/web/src/server/organization.ts`: `OrganizationNeed` gains `preference: { templateId, templateName, model, setBy } | null` and `OrganizationView` gains `templates: readonly { id, name }[]` (the pick list). Both come from one added `listStaffingPreferences(workspaceId)` and one `findMany` over the catalog the page already reads — never one query per need row. `needs[].summary` is unchanged; the "why" sentence under a proposal already comes from `proposal.rationale`, which Task 3 made name the step, so a preference that decided a pick now says so on the page with no further change here.

`apps/web/src/components/organization/OrganizationClient.tsx`: inside each `organization-need-<capability>` section, and beside each COVERED capability chip, one control:

```tsx
                  {/* M53 R9: the decision lives where the staffing decision is READ. Two controls
                    * and no third: a picker that names a profile or a model, and a clear. There is
                    * no "prefer for every project" and no priority -- one decision per capability
                    * per project is the whole of the table. */}
                  <StaffingPreferenceControl
                    workspaceId={view.workspaceId}
                    capability={need.capability}
                    capabilityLabel={need.label}
                    templates={view.templates}
                    preference={need.preference}
                    onChanged={() => void refresh()}
                  />
```

rendering a `<select>` of templates (`data-testid={`staffing-preference-${capability}`}`), an optional model text input, and a `Clear` button (`data-testid={`staffing-clear-${capability}`}`) shown only while a preference exists. A set `PUT`s, a clear `DELETE`s, and a refusal renders through the same `organization-error` row the proposals already use.

`apps/web/src/app/api/w/[workspaceId]/staffing/[capability]/route.ts`, in the shape the permissions route has:

```ts
/**
 * One capability's staffing decision for one project (M53 R9).
 *
 * The capability is in the PATH and the decision is the whole body, because the path names the
 * resource: a PUT sets this decision and a DELETE takes it back, which is exactly the two states the
 * table expresses. In the workspace-scoped family, not an unscoped one -- M50 erratum E8's ruling,
 * and `workspaceControlResponse` 404s a project that is not there and 409s an archived one before
 * the verb runs at all.
 *
 * The body is `.strict()`, its siblings' rule for a route that is new: a caller sending a field this
 * route does not know is sending it to something, and silently ignoring it would set the wrong
 * decision with a 200.
 *
 * The capability, the template and the model are all handed on UNVALIDATED: `setStaffingPreference`
 * owns `capability_not_found`, `template_not_found`, `invalid_model` and
 * `invalid_staffing_preference` together with their verbatim sentences, and a second list of any of
 * them here is a second place for them to go stale.
 */
const bodySchema = z
  .object({ templateId: z.string().min(1).nullable().optional(), model: z.string().min(1).nullable().optional() })
  .strict()
```

with `PUT` calling `setStaffingPreference(workspaceId, { capability, ...body.data }, gate.principal ?? undefined)` and `DELETE` calling `clearStaffingPreference(workspaceId, capability, gate.principal ?? undefined)`, both through `workspaceControlResponse` and both behind `requirePrincipal()`.

`apps/web/test/integration/staffing-routes.test.ts` covers: a PUT writes the row and answers 200; a PUT naming neither half answers **409** with the refusal's sentence; a PUT on an archived project answers 409 `workspace_archived` before the verb runs; a PUT on a missing project answers 404; a DELETE removes the row; a DELETE of nothing answers 200; and an unauthenticated request answers 401 without touching the table.

`apps/web/test/organization-page.test.tsx` gains two cases: the control renders on a need row with the capability's LABEL beside it, and a row with a preference renders the template's NAME and the clear button.

- [ ] **Step 9: `docs/ia.md`**

Four cells, each stating what actually happened rather than what was promised:

- the `/workforce` row's **Later** column gains: *"M53 adds Evidence, the sixth tab: two tables — per profile and per model, because they are two different questions — with counts, rates, and `Insufficient evidence` wherever the sample is too thin to claim one. No chart."*
- BOTH `/analytics` rows' **Later** columns lose "M53 replaces the tiles with per-profile evidence" and gain: *"M53 did it: the per-slave table and the Spend tile are gone — the first because it counted one project's materialised workers, the second because its figure was a raw `SUM(costUsd)` with no provenance — and the route, its five remaining tiles and its `?workspace=` scope are unchanged, with a line pointing at Workforce → Evidence."*
- the `/w/:id/activity` row's **Later** column gains: *"M53 adds the staffing-preference card."*
- the `/w/:id/organization` row's **Later** column gains: *"M53 puts the staffing preference where the staffing decision is read: one choice per capability, naming a profile, a model or both, which the Supervisor's ranking obeys ahead of any record and behind any refusal."*

- [ ] **Step 10: Build, browse, and commit**

```bash
pgrep -af "next dev"     # must be empty; kill it and say so if not
npx vitest run apps/web 2>&1 | tail -20
npm run web:build
npm run gate:m44-ux-foundation
npm run gate:m16-chrome
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```

`gate:m44-ux-foundation` is the one to read closely: its stage 1 logs the `/analytics` `kpi-tile` count, which must now print 5, and its page sweep walks twelve pages for database values shown as text — the Evidence tab is not in that sweep, which is why `gate:m53-evidence` stage 10 exists.

Then the whole suite, because this task DELETED tests:

```bash
npx vitest run 2>&1 | tail -20
```

Expected: **at or above** ≥ 338 files / ≥ 5642 tests. One file was deleted (`analytics-aggregates.test.ts`) and three were created, and eleven cases were removed while roughly forty were added — if either number has gone DOWN, this task is not finished, and the fix is the missing test rather than a lowered baseline.

```bash
git add apps/web scripts/gate-m16-chrome.mjs docs/ia.md
git rm apps/web/test/integration/analytics-aggregates.test.ts
git commit -m "$(cat <<'EOF'
feat(web): m53 t5 — a sixth tab with two tables, a tile that hands over, and a choice a person makes

The Evidence tab answers two questions with two tables, because profile performance and model
performance are not the same question and a single table would keep confusing them. Counts and
rates, no chart of any kind, and wherever the sample is thinner than five the rates are replaced --
entirely -- by the words "Insufficient evidence", with the counts still beside them, because a count
is a fact and only a rate is a claim. A rate the page shows carries a progress bar with a value; a
rate it will not claim carries no bar at all, which is an absence a browser can measure.

`/analytics` keeps its route, its five remaining tiles and its `?workspace=` scope, and loses two
things: the per-slave table, which counted one project's materialised workers with no profile, no
model and no domain in it, and the Spend tile, whose figure was a raw `SUM(costUsd)` that silently
absorbed every run nobody measured. Both are answered on the Evidence tab now, where money is three
numbers with three words beside it -- `docs/ia.md` rule 2, nothing removed, only moved, with a line
on the page saying where it went. `gate:m16-chrome`'s check 5 moved with the table it was reading.

The staffing preference lives where the staffing decision is read: on the Organization tab's own
need rows, one choice per capability, naming a profile or a model or both. The Supervisor obeys it
ahead of any record and behind any refusal, and a proposal now says which of the six steps decided.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"
```

---

### Task 6: `gate:m53-evidence`, the fifth fake, CI, the README, two screenshots — and the full verification ladder (§3, E16, E17, D39–D44)

**Files:**
- Create: `scripts/gate-fakes/fake-verify.sh`, `scripts/gate-m53-evidence.mjs`
- Modify: `package.json`, `.github/workflows/ci.yml`, `README.md`, `docs/superpowers/fidelity/m14/{workforce,analytics}.png`
- Test: the gate itself, plus the whole ladder

**Interfaces:**
- Consumes: everything Tasks 1–5 produced.
- Produces: `npm run gate:m53-evidence`, CI's 28th step, the README's 28.

- [ ] **Step 1: The fifth fake**

`scripts/gate-fakes/fake-verify.sh` — the first fake in this directory that stands in for the PROJECT's own commands rather than for a vendor or for something a worker may not touch:

```bash
#!/usr/bin/env bash
# A scripted verify command, for `scripts/gate-m53-evidence.mjs` (M53 §3).
#
# The FIFTH fake in this directory. `fake-claude.sh` and `fake-cursor-agent.sh` pretend to be a
# worker, `fake-deploy.sh` pretends to be the thing a worker may not touch, `fake-worker-server.sh`
# pretends to be a daemon -- and this pretends to be `Workspace.verifyCommands`, so a gate can decide
# which task's FIRST verify fails and which passes, and prove that `verifiedFirstPass` says the
# difference.
#
# It takes its state file from ARGV -- `--state <path>` -- and never from the environment, the
# `fake-deploy.sh` precedent for the same reason spelled out differently: a verify child is spawned
# by `runShellCommand` (`apps/orchestrator/src/shell.ts:105`) with `/bin/sh -c "<the command>"` and
# the DAEMON's environment, which a gate can set, but the command line is `Workspace.verifyCommands`
# -- a row a person wrote -- and that is exactly where a scripted verification's own configuration
# belongs. Putting it in argv also means two workspaces can carry two different scripts without two
# daemons.
#
# THE RULE IS ONE LINE: while the state file exists, this exits 1 AND REMOVES IT; afterwards it
# exits 0. So a gate that touches the file before a dispatch gets "fails once, passes on the rework",
# and a gate that does not gets "passes first time" -- which is the whole difference between the two
# profiles' records in stages 2 and 7.
set -uo pipefail

state=''
prev=''
for arg in "$@"; do
  if [ "$prev" = '--state' ]; then state="$arg"; fi
  prev="$arg"
done

# Exit 3, not 1: `advance()` reads a 1 as "the commands turned this work down" and would charge the
# task an attempt for the fake being misconfigured. 3 says the FAKE is wrong, not the work.
if [ -z "$state" ]; then
  printf 'fake-verify.sh: no state path -- pass `--state <path>` in the workspace verify command.\n' >&2
  exit 3
fi

if [ -f "$state" ]; then
  rm -f "$state"
  printf 'fake-verify.sh: scripted failure (the state file said so, and is now gone)\n' >&2
  exit 1
fi

printf 'fake-verify.sh: ok\n'
exit 0
```

`chmod +x`. Nothing else in the repository reads it.

- [ ] **Step 2: Write the gate**

`scripts/gate-m53-evidence.mjs`. Scaffolding cribbed function for function from `scripts/gate-m52-broker.mjs` — a free port, a real `next dev`, a real Chromium through `playwright-core` at `CHROMIUM_PATH`, prisma and the real CLI before the browser opens, `preflightCleanup` by name prefix, `gateStateDir()` through `scripts/lib/child-env.mjs` so every run directory lands under `/tmp` and the `finally` removes it, and a `finally` that kills every process and removes every temporary repository — plus one thing of its own: **two daemon PHASES over one workspace** (erratum E16).

Header, in the house register:

```js
// M53's own gate (spec §3): "two workers, two records, and a ranking that says why".
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m53-evidence
//
// NEVER A MODEL CALL, AND ZERO SPEND. Every run is the fake CLI; every verify is
// `scripts/gate-fakes/fake-verify.sh`, the fifth fake; every cost figure in this gate is a literal
// written onto a `SlaveRun` row or a token count under a priced model.
//
// THE GATE ASSERTS, IT NEVER FIXES, and every stage prints every measured value before asserting it.
//
// TWO DAEMON PHASES, ONE WORKSPACE (plan erratum E16). `--review-fixture` reaches a run through
// `SLAVEOFAI_CLAUDE_ARGS`, which is the DAEMON's environment and not a worker's, so two workers under
// one daemon cannot get different review verdicts. Phase A runs with `review-approve` and a verify
// that passes first time, with only profile A dispatchable; phase B restarts the daemon with
// `review-reject` and a seeded `fake-verify.sh` state file, with only profile B dispatchable. The
// workspace, the tasks, the templates and every `EvidenceRecord` are ONE set throughout --
// `gate:m36-messaging` stops and restarts the orchestrator mid-scenario for the same kind of reason.
//
// IT NEVER EDITS A FILE IN THIS REPOSITORY. The temporary repositories, the state directory and the
// fake's own state file are all under `/tmp` and are removed in the `finally`; `git status
// --porcelain` after a green run is what it was before.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: it boots `next dev` against the
// repo's own `apps/web/.next` on a freshly chosen free port, and a second `next dev` sharing that
// directory corrupts the on-disk build cache for both. Stop any running dev server first
// (`pgrep -af "next dev"`).
```

The twelve stages, each with what it measures and the assertion that would fail:

1. **Facts at terminal transitions only.** While phase A's first run is live, `EvidenceRecord` has no row for it — polled between `run.started` and the conclusion. The instant it concludes there is exactly one; a second `recordRunEvidence` call for the same run (a sweep racing a pump, made by hand) still leaves one, because `runId` is unique. Then a run failed at SPAWN — `tick.ts`'s spawn-failure arm, driven by pointing `SLAVEOFAI_CLAUDE_BIN` at a path that does not exist for one dispatch — leaves **NO row at all**, asserted directly, because "nothing was attempted" is the ruling and an absence is only proved by looking for it.
2. **Attempt and first-pass derivation.** Profile A's row: `attempt 1`, `verifiedFirstPass true`. Profile B's first row: `attempt 1`, `verifiedFirstPass false`, `reworkCycles 1`; its second row: `attempt 2`, `verifiedFirstPass false`. Then, from the SCHEMA rather than from the log: `information_schema.columns` has no `attempt` column on `SlaveRun`, and no event row in this workspace carries an `attempt` key in a `task.verify_passed` or `task.verify_failed` payload.
3. **Multi-domain counting.** A task requiring `backend.services` and `qa.test-automation` produces ONE row whose `domains` holds both. The by-profile table under either chip counts that run once, and the two filtered counts deliberately **do not sum** to the unfiltered total — asserted as an inequality, in the browser, which is the only way to show that the design intends it. A task with no required capability lands in `general`.
4. **Provenance on cost.** Three rows in one workspace read `reported`, `estimated` and `unmeasured` — a run whose stream reported a cost, one that reported only tokens under a priced model (`claude-sonnet-4-20250514`, from `MODEL_PRICES`), and one that reported neither. The unmeasured row's `actualCostUsd` is **null and not 0**, and the page prints the word beside the figure with the unmeasured count on its own line.
5. **The backfill is idempotent.** `DELETE FROM "EvidenceRecord"`, run `node scripts/backfill-evidence.mjs`, snapshot the table; run it again; every row is byte-equal, `recordedAt` included. Then remove one run's `run.started` event and re-run: that run still gets a row, with zeros in the four event-derived counters and nulls in the three judgement columns.
6. **Simulation refused, and the boundary named.** `recordRunEvidence(<a real SimulationRun.id>)` returns the refusal and writes nothing (plan erratum E3 — the schema makes "no workspace" and "no such run" one fact, and handing it a simulation's own id is what proves the boundary). The `simulation-boundary` source scan names `EvidenceRecord`, `rankCandidates` and `StaffingPreference` — re-asserted here by grepping `packages/control/src/simulation*` from the gate. No `SimulationRun`, `SimulationJournalEntry` or `SimulationModelUsage` row contributed to any fact: `EvidenceRecord.runId` is checked against `SlaveRun.id` for every row, and the count of unmatched rows is 0.
7. **Ranking order, with a preference set and cleared.** With both profiles evidenced and A's record clearly better, `supervise` proposes A. Then `orchestrator staffing prefer --capability <k> --template <B>` and the same world proposes B, **with a rationale naming the preference** (the decision row's `action`/`rationale` is read from the database and matched against `somebody chose`). Clear it and A comes back. `staffing.preference_changed` appears **twice** on the timeline with `from`, `to` and `by`.
8. **A preference never moves the wall, and never moves the queue.** With the preference on B, `permission deny --slave <B> --kind run_commands` (in `BASELINE_GRANTS.implementation`) — B drops below A again, because permission is step 2. Revoke the deny, make B busy (one live run), and A is proposed again — a preference for a busy candidate is not a preference for this dispatch. **`SlavePermission` is unchanged by every one of these steps** except the two that explicitly write it, asserted by counting the rows before and after each staffing pass.
9. **Insufficient evidence on a small sample.** A third profile with two terminal runs renders `Insufficient evidence` in place of every rate, with its counts still visible and `evidence-insufficient-<key>` present. Then a fourth profile with eight attempts, eight verify verdicts and two integrations renders the words for the integration rate while its neighbours in the SAME ROW render percentages — the case R11 calls ordinary rather than exotic.
10. **No raw key on the page, and no score.** Every visible cell in both tables is checked against the raw values behind it: no `template:<uuid>`, no `slave:<uuid>`, no bare `succeeded` / `reported` / `backend` / `general` as visible text, while `data-profile-key`, `data-domain` and `title` carry them. And the rendered HTML of the tab contains no `score`, `rating`, `rank` or `index` column header — R11's own domain test, asserted a second time from the browser side.
11. **The sort is what the caption says.** The by-profile rows come back `attempted` descending then name ascending, asserted against `evidence-sort-caption`'s **own words** rather than against a constant in the gate: the caption is parsed for `most runs first` and `name`, and the order is checked to match what it claims.
12. **The analytics tiles are gone.** `/analytics` renders **five** `kpi-tile`s and no tile labelled `Spend`, has no `slave performance` panel and no `perf-*` testid anywhere in the DOM, and carries `evidence-link` pointing at `/workforce?tab=evidence`. The Projects home renders the same five from the same builder. The route and its `?workspace=` scope still work — `/analytics?workspace=<id>` answers 200 and its tiles differ from the global ones, which is what proves the scope is still applied rather than merely accepted.

- [ ] **Step 3: Run the gate until it is green, and read its log**

```bash
pgrep -af "next dev"     # must be empty
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m53-evidence 2>&1 | tee /tmp/gate-m53.log; echo "exit ${PIPESTATUS[0]}"
```

Expected: exit 0 and the pass line. Then read the log for the three things a green gate can still hide:

```bash
grep -c "Insufficient evidence" /tmp/gate-m53.log   # at least 2 -- the row case and the single-rate case
grep -iE "template:[0-9a-f-]{36}|slave:[0-9a-f-]{36}" /tmp/gate-m53.log   # only on lines that MEASURE a data- attribute
git status --porcelain                              # must be clean: the gate edits no file in this repo
ls ~/.local/state/slaveofai/runs 2>/dev/null | wc -l   # unchanged across the run (M52 C1)
```

- [ ] **Step 4: The roster, CI and the README**

`package.json` gains `"gate:m53-evidence": "tsc --build && node --env-file=.env scripts/gate-m53-evidence.mjs"` after `gate:m52-broker`. `.github/workflows/ci.yml` gains `- run: npm run gate:m53-evidence` after `gate:m52-broker` (`:80`). `README.md`: the roster sentence (`:853-860`) names `gate:m53-evidence` after `gate:m52-broker`, the `m52` clause gains an `and m53` clause in the same register —

> …and `m53` drives two workers through one project on two different scripts until their records genuinely differ, then shows that the Supervisor picks the one with the better record, that a person's choice overrules it, that a refusal overrules the choice, that a busy worker's fan club counts for nothing, and that a profile with two runs to its name says "Insufficient evidence" instead of a percentage

— and `:936` reads **28 gates**.

- [ ] **Step 5: Regenerate exactly two screenshots**

`gate:m14-fidelity` rewrites every PNG it takes; only two of them changed content in this milestone, so the rest are checked out again — the M50/M51/M52 precedent, and the known m14 PNG nondeterminism in the carried backlog:

```bash
pgrep -af "next dev"   # empty
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m14-fidelity
git status --porcelain docs/superpowers/fidelity/m14/
git checkout -- $(git diff --name-only docs/superpowers/fidelity/m14/ | grep -v -E "(workforce|analytics)\.png$")
```

Then OPEN both PNGs and look: `workforce.png` must show SIX tabs with `Evidence` last, and `analytics.png` must show FIVE tiles, no `Spend`, and the hand-over line where the per-slave table was. A screenshot that regenerated identically means the page did not change and something in Task 5 did not land.

- [ ] **Step 6: The full verification ladder**

One vitest at a time, no gate beside vitest, nothing beside a `web:build`.

```bash
npx tsc --build
npm run --silent typecheck
npx vitest run 2>&1 | tail -20
```

Expected: ≥ 338 files / ≥ 5642 tests, zero failures. Then the migration proof once more, because this is the last chance to catch a schema that drifted from its SQL across six tasks:

```bash
npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
```

Expected: "No difference detected". Then the build:

```bash
pgrep -af "next dev"   # empty
npm run web:build
```

Then every gate this milestone could have moved, one at a time, each with `CHROMIUM_PATH` / `SLAVEOFAI_CLAUDE_BIN` / `SLAVEOFAI_REQUIRE_FAKE_CLI` set and `pgrep -af "next dev"` empty before each:

```bash
npm run gate:m13-runtime
npm run gate:m14-fidelity
npm run gate:m16-chrome
npm run gate:m18-skill-and-teeth
npm run gate:m26-vocabulary
npm run gate:m35-pipeline-honesty
npm run gate:m37-run-context
npm run gate:m38-supervisor
npm run gate:m41-scenario
npm run gate:m44-ux-foundation
npm run gate:m45-project-experience
npm run gate:m47-team-formation
npm run gate:m48-runbooks
npm run gate:m49-memory
npm run gate:m50-ephemeral
npm run gate:m51-breaker
npm run gate:m52-broker
npm run gate:m53-evidence
```

Expected: all eighteen green. Six to watch, and what to do rather than edit them:

- **`gate:m16-chrome`** carries this milestone's one MOVED check (erratum E11). If check 5 fails on "no evidence rows rendered at all", the fixture database has no `EvidenceRecord` — which is a gate-setup problem, not a page problem, and the fix is seeding a run in that gate's own fixture rather than weakening the check.
- **`gate:m47-team-formation`** is the ranking gate and the one this milestone changed the tie-break of. Every TIER-ORDER stage must pass UNCHANGED; if one moved, the ranking has leaked out of a tier and into the tier order, which R8 forbids and which `team.test.ts` should have caught first. Its stage 6 flakes on `recordDecision` committing before `applyDecision` (carried backlog) — re-run it alone before believing it.
- **`gate:m35-pipeline-honesty`** is the "reviewed is not merged" gate, which is exactly the distinction `integrated` settles on. It must pass unchanged: M53 READS `Task.integratedAt`'s two writers and moves neither.
- **`gate:m38-supervisor`** stage 3 pins `situation.facts.reason === 'budget_exhausted'` so another halt cannot pass that stage, and this milestone adds no situation at all. If it fails, something added one.
- **`gate:m45-project-experience`** and **`gate:m44-ux-foundation`** both read `/analytics` and the project brief. The tile count moved from six to five; `gate:m44` PRINTS that count rather than asserting it, so read the printed line rather than trusting the exit code.
- **`gate:m51-breaker`** asserts `workspaceSpend` and `stats.spentUsd` did not move (`:1242`). It must pass unchanged, and it is the strongest evidence that R6's deletion of the raw `SUM(costUsd)` touched a DISPLAY figure and not a charged one.

Record every gate's exit code and its wall time in the task report, and re-run any single failure ALONE before believing it — the daemon CLI test's row counts double when anything else touches the database, and a gate is the heaviest anything.

- [ ] **Step 7: Commit — three of them, in this order**

The code, then the pictures, then the documents, so a screenshot diff never hides a code change and a spec diff never hides either:

```bash
git add scripts package.json .github/workflows/ci.yml README.md
git commit -m "$(cat <<'EOF'
feat(gate): m53 t6 — two workers, two records, and a ranking that says why

`gate:m53-evidence` drives one project through two daemon phases -- one scripted to pass review and
verify first time, one scripted to fail verify once and be rejected in review -- until the two
profiles' records genuinely differ, and then asks the Supervisor who should do the next piece of
work. It proposes the better record; a person's preference overrules it; a refusal overrules the
preference; a busy candidate's fan club counts for nothing. Then it clears the preference and the
record decides again. `SlavePermission` is counted before and after every one of those passes and
never moves except where a person moved it.

The quieter stages are the ones the milestone is actually about. A live run has no fact; the instant
it concludes it has exactly one; a run that failed at SPAWN has none at all, because nothing was
attempted. A task in two domains is ONE row counted under both chips, and the two filtered counts
deliberately do not sum to the total. Three runs in one project read reported, estimated and
unmeasured, and the unmeasured one's figure is null and not zero. The backfill runs twice and the
second pass is byte-equal to the first, `recordedAt` included. A profile with two runs to its name
says "Insufficient evidence" rather than a percentage, and so does a single rate whose own
denominator is thin while its neighbours in the same row say 88%.

`recordRunEvidence` handed a real `SimulationRun.id` refuses and writes nothing. Nothing on either
table is a raw key, and nothing anywhere is a score. CI's 28th gate.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"

git add docs/superpowers/fidelity/m14/workforce.png docs/superpowers/fidelity/m14/analytics.png
git commit -m "$(cat <<'EOF'
chore(fidelity): m53 — regenerate the two screenshots a sixth tab and two deletions changed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"

git add docs/superpowers/specs/2026-09-12-m53-workforce-evaluation-design.md docs/superpowers/plans/2026-09-12-m53-workforce-evaluation.md
git commit -m "$(cat <<'EOF'
docs(spec): m53 — the design, the plan, and the errata execution wrote back into §5

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YAou8qNAnNGPfu5xcAcoeQ
EOF
)"
```

---

## Self-review

**1. Spec coverage.**

| Spec | Where it lands |
|---|---|
| R1 four dimensions, none of them null (`profileKeyOf`, the `slave:`/`template:` split, `profileName`'s snapshot, `SlaveRun.model` and its null group, `normaliseRepositoryKey`, `workspaceId` as a column) | Task 1 Steps 5–7 (`derive.ts`, 6 cases) and 20 (the columns); Task 2 Steps 1–4 (both profile kinds asserted against a real row); Task 5 Steps 1–4 (the `Bespoke` chip and `Model not recorded`); Task 6 stages 1 and 10. **`CompanySlave` is the profile key of nothing** — it appears in no derivation, and Task 3 Step 10 keys a company worker on its `templateId` |
| R2 every domain the task asked for, `general` otherwise, a FILTER and never a partition | Task 1 Steps 5–7 (`domainsFor`, 7 cases including the never-empty invariant); Task 2 Step 1 (the two-capability row and the planning run); Task 5 Steps 1–4 (the chips); Task 6 stage 3, whose assertion is the INEQUALITY — the two filtered counts do not sum to the total |
| R3 a fact table, one writer, no rollup, append-only in three senses | Task 1 Step 20 (the model, its three indexes, `@unique` on `runId`); Task 2 Steps 1–4 (`recordRunEvidence`, 23 cases, including idempotence and the never-back property); Task 3 Steps 1–4 (the six write sites, and the spawn-failure arms asserted to write NOTHING); Task 6 stages 1 and 5. **No VIEW and no rollup table**: `evidenceByProfile` is a `GROUP BY`, and no task creates a second table |
| R4 attempt and first-pass DERIVED, four settle sites, no new event field | Task 1 Steps 5–7 (`attemptFrom`, `verifiedFirstPassFrom`, `reviewRejectedFrom`, `reworkCyclesFrom`, 14 cases); Task 2 Steps 1–4 (the settle, 7 cases) and its `settleTaskEvidence` (erratum E2); Task 3 Steps 5–6 (verify, review, merge, integration); Task 6 stage 2, which asserts from the SCHEMA that no `attempt` column and no `attempt` payload field appeared |
| R5 a recovery is two things, and a de-escalation is neither | Task 1 Steps 5–7 (`recoveriesFrom`, `humanInterventionsFrom`, 6 cases, one of which names M51 R2 by name); Task 2 Step 1 (the sweep flag and the unblock count); Task 3 Step 3 (`recoveredBySweep` at both sweep arms); Task 6 stage 1. **`packages/domain/src/breaker/` and `packages/control/src/breaker.ts` are in no task's file list** — the silence M51 chose is not broken to make a counter |
| R6 provenance kept, the raw `SUM` deleted, `COST_PROVENANCE_WORD` moved | Task 1 Steps 5–7 (`actualCostFrom`, 4 cases) and Step 13 (the move, with `provenanceWordFor` staying put); Task 2 Step 5 (three money figures, never one); Task 5 Step 6 (the deletion, the Spend tile, the three test files). **`packages/control/src/spend.ts`, `packages/control/src/stats.ts` and `packages/domain/src/guardrails/evaluate.ts` are in NO task's file list**, and `gate:m51-breaker`'s own spend assertion is re-run unchanged in Task 6 Step 6 |
| R7 one idempotent backfill over possibly-incomplete history | Task 4 Steps 3–5 (the script, 6 cases: idempotence to the byte, batch-size independence, a run whose events are gone, the skipped-and-reported path, and no settle); Task 6 stage 5, which does it against a real database twice |
| R8 six steps, one pure function, `decide()` unread | Task 1 Steps 9–12 (`rankCandidates`, 29 cases, one per step plus the shape cases); Task 3 Steps 7–10 (`formTeam` within a tier, `teamPlanOf`'s context) and Step 11, which PROVES `decide()` is neither changed nor imported; Task 6 stages 7 and 8. **`packages/domain/src/supervisor/{situations,actions,policy,observe}.ts` are in no task's file list** — no new situation, no new action, and `situations.ts`'s "an EIGHTEENTH kind fails the build" comment is untouched |
| R9 a preference is a row, it wins over the opinion and never over the wall | Task 1 Steps 14–17 (the 59th event) and Step 23 (its card, filter and sentence); Task 2 Steps 7–8 (the two writers, 13 cases, and the one new refusal kind in three homes); Task 3 Steps 7–10 (step 3 in the chain, and the busy rule); Task 4 Step 2 (`staffing prefer|clear|list`); Task 5 Step 8 (the control and the route); Task 6 stages 7 and 8 |
| R10 the permission step reads M52's grants and invents no oracle | Task 1 Step 11 (`isWalled` reads `BASELINE_GRANTS`, 5 cases including "a template is unaffected" and "a wall is not a disqualification"); Task 2 Step 10 (`loadDeniedKinds`, denies only, skipped on an empty roster); Task 6 stage 8. **There is no "would this profile be granted X" function anywhere**, and `run.tool_denied` counts (M52's `denials`) are read by nothing here |
| R11 no universal score, and a thin record says so in words | Task 1 Steps 1–4 (`INSUFFICIENT_EVIDENCE`) and Steps 9–12 (`EVIDENCE_MIN_SAMPLE`, the skip rule, and the case that walks every result property looking for a score); Task 5 Steps 1–4 (the substitution, both the whole-row and single-rate forms, and the sort caption); Task 6 stages 9, 10 and 11 |
| R12 a sixth tab, two tables, the tiles hand over | Task 5 Steps 1–9 in full, with the moved gate pin at Step 7 and `docs/ia.md` at Step 9; Task 6 stages 3, 9, 10, 11 and 12 |
| R13 nothing crosses the simulation boundary | Task 2 Step 3 (the refusal before any write) and Step 11 (the fourth source-scan pattern, with the grep that proves it is clean today); Task 6 stage 6, which reaches the refusal by handing the function a real `SimulationRun.id`. **`packages/simulation/` and `packages/control/src/simulation*` are in no task's file list** |
| §3 the gate, the fifth fake, README 27→28, CI after m52, the moved pins, the m14 screenshots | Task 6 Steps 1–5, twelve stages enumerated with their assertions; the moved pins are named in the tasks that move them (Task 5 Steps 6 and 7) |
| §2 surfaces after M53 | Every module, column, enum, verb, route, testid and file listed there appears in a task's **Interfaces → Produces**: the domain vocabulary, the derivations, the ranker and the two tables in Task 1; the writer, the settler, the reads, the preference and the world in Task 2; the six write sites, the four settles and `formTeam` in Task 3; the two CLI verbs and the script in Task 4; the tab, the route, the analytics surgery and `docs/ia.md` in Task 5; the gate and the fifth fake in Task 6 |
| §4 out of scope | `HandoffContract.evidenceRequired` stays inert (`packages/domain/src/handoff/contract.ts` is in no file list; its docstring's amendment is a documents-commit line in Task 6 Step 7); `broker.executed` is read by nothing (it appears in no derivation); no rollup and no VIEW (no task creates a second table); no `CompanySlave`-keyed record and no cross-company evidence; no score, weighting or configurable threshold beyond `EVIDENCE_MIN_SAMPLE`, whose docstring says it is the only one; no charts (`BarChart` is not imported by the Evidence tab, asserted); `decide()`, `evaluateGuardrails`, `workspaceSpend` and `stats.spentUsd` untouched and asserted so; no new situation and no new action; no tool-call rate anywhere, which is why M52's `toolCallCap` denominator item stays carried; no evidence CLI report beyond `evidence list`; no automatic de-staffing; no `repoPath` backfill |

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N", no "write tests for the above". Six places name the exact file to copy a shape from instead of reprinting it, and each states what it must produce: Task 2 Step 6's three `$queryRaw` reads (five rules given, each pinned by a named case, with the exact aggregate expressions for the medians and the money split), Task 2 Step 8's two writers (the refusal order given question by question, with the kind each one raises), Task 2 Step 10's three loaders (each named after the existing loader it copies, with its skip condition), Task 4 Step 4's script body (given as code, with the cursor rule and the exit-status rule spelled out), Task 5 Step 4's tab (the two cell helpers given in full as code, the column lists given verbatim, the chip behaviour given by the rule it copies) and Task 6 Step 2's gate (twelve stages with their assertions, the scaffolding named function by function from `gate-m52-broker.mjs`, and the two things the implementer may not improvise past: the two-phase structure and the `--state` argv rule). Six steps deliberately end in a CHECK rather than an edit — Task 2 Step 11's boundary grep, Task 2 Step 13's `$transaction` grep, Task 3 Step 11's `decide()` proof, Task 4 Step 5's write-surface grep, Task 6 Step 3's log read and Task 6 Step 5's "open the PNG and look" — because each is a fact about the tree a plan should verify rather than assert. One step (Task 1 Step 21) begins with a decision the implementer must SETTLE (`prisma validate` on the GIN form) and gives the exact fallback and the exact consequence either way.

**3. Type consistency.** `EvidenceOutcome`, `EVIDENCE_OUTCOMES`, `INSUFFICIENT_EVIDENCE`, `MODEL_NOT_RECORDED_LABEL`, `BESPOKE_PROFILE_LABEL`, `GENERAL_DOMAIN`, `domainLabel`, `EVIDENCE_MIN_SAMPLE`, `RANK_STEPS`, `RankStep`, `RankEvidence`, `RankCandidate`, `RankPreference`, `RankContext`, `RankedCandidate`, `rankCandidates` and every function in `evidence/derive.ts` are spelt ONCE (Task 1 Steps 3, 7 and 11) and consumed under those names in Task 2 (`recordRunEvidence`'s derivation and `evidenceForProfiles`' return), Task 3 (`TeamRanking`'s five maps and `teamPlanOf`'s builder), Task 4 (the CLI's label lookups) and Task 5 (the page's rates and chips). `RankEvidence` is the single shape three producers and one consumer agree on: `evidenceForProfiles` returns `ReadonlyMap<string, RankEvidence>`, `SupervisorProfileEvidence extends RankEvidence`, `TeamRanking.evidence` is `ReadonlyMap<string, RankEvidence>`, and `RankCandidate.evidence` is `RankEvidence | null` — so a counter added to the record is a build error in four places rather than a silent zero in one. `EvidenceSettle` has one definition (Task 2 Step 3) and four call sites (Task 3 Steps 6's verify, review and merge, and Task 2 Step 11's `confirmIntegration`), all through two entry points that share one implementation. `profileKeyOf` has one definition and four callers — the writer, the world's slave rows, `teamPlanOf`'s three loops, and the backfill by way of the writer — and `template:`/`slave:` is spelled nowhere else except `isBespokeProfileKey`, which is its inverse and lives beside it. `COST_PROVENANCE_WORD` is one `Record<CostProvenance, string>` with four readers: the task panel's `provenanceWordFor`, the Evidence tab's `CostCell`, the CLI's `evidence list`, and `enum-parity.test.ts`, which is what makes it load-bearing rather than cosmetic. The one asymmetry, named: `EvidenceRecord.model` is a nullable `String` on the row and `RankCandidate.model` is `string | null` in the ranker, and the ranker SKIPS a null rather than treating it as a value — `MODEL_NOT_RECORDED_LABEL` exists because the by-model table does not skip it, and the two behaviours are deliberate and are asserted separately (Task 1 Step 9's preference cases and Task 5 Step 1's model-group case).

**What the self-review pass FIXED, inline.** One gap and one only: Task 5's **Interfaces → Produces** listed the testids and the route but not the module's own types, while Task 5 Step 5 already types a `WorkforceClient` prop as `EvidencePage` — a name Task 6's browser stages read through and nothing had produced. `buildEvidencePage`, `EvidencePage`, `EvidenceProfileRow`, `EvidenceModelRow` and `EvidenceRate` are now named there, so every type a later task consumes is spelled by an earlier task's Produces. Nothing else moved: the spec-coverage walk found a task for every R-section and every gate stage, and the placeholder scan found nothing to remove.

**4. What this plan deliberately does not do.** It does not put a `VIEW` or a materialised aggregate anywhere: R3 refused a rollup, and every rate on every surface is a `GROUP BY` over one fact table — which is also why the plan's own carried backlog keeps "if the fact table's query cost ever matters". It does not give `CompanySlave` a record, which its own schema comment has been claiming since M10; choosing it would key a company-wide record on a row a project hire does not have, and M49 §3 already refused cross-company sharing for memory. It does not read `broker.executed`, although M52's spec named M53 its first consumer: a deployment's exit code is a fact about an operation, not about the run that asked for it. It does not verify `HandoffContract.evidenceRequired`, which stays a list the worker reads and nothing checks — checking it is a verification feature wearing an evaluation feature's name. It does not fix the three web read models that divide tool calls by `maxToolCallsPerRun` where a capped run's honest denominator is `toolCallCap` (M51's carried backlog, which each milestone "may fix where a task touches the file"): no evidence column reads a tool-call rate, Task 5 touches `organization.ts` for two added fields and `graph.ts` / `overview.ts` not at all, so the fix would be a change nothing in this milestone tests — it stays on the list. And it does not pin `MODEL_PRICES` against `CLAUDE_CODE_MODELS`, which this milestone raises from cosmetic to load-bearing (an unpriced model now makes every one of its runs read `unmeasured` and drops that model out of the cost step): the fix is a `satisfies` in `packages/domain/src/guardrails/pricing.ts`, which is in no task's file list, and adding it here would be an M51 change wearing an M53 label. It is named in the carried backlog with that promotion written down, which is the strongest form of "not now" this repository has.
