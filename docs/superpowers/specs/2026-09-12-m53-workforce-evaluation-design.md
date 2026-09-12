# M53 — Workforce evaluation

Tenth milestone of the roadmap `2026-09-10-roadmap-m44-m56.md` (row M53, line 45), extending the run
and event history (ADR 0003's one write gate), the verify/review/integration pipeline (M35's
`Task.integratedAt`), M46's `SlaveTemplate`, M47's capability taxonomy and `formTeam`, M51's cost
provenance (`costProvenanceOf`, `sumSpend`, `SlaveRun.model`) and M52's resolved grants (`grantsFor`,
`BASELINE_GRANTS`) — named as extensions, per roadmap lines 19-23. Designed 2026-09-12 from an
inventory of every evidence source in the event catalogue, the run and task rows that carry the rest,
the one ranking function that exists, the three-state honesty precedents (`MappingQuality`,
`CostProvenance`, `SlaveRun.costUsd`), the analytics surface `docs/ia.md` points at twice, the
simulation boundary and the gates that pin all of it (session scratchpad `m53-explore.md`). Every
**Ruling** took the controller's direction under the user's standing approval; where the repository
forces a different shape the ruling carries an inline `*(verified: …)*` note. "Slave" is this
project's word for an AI worker.

**Goal.** The organisation stops guessing which of its workers is any good. Every run that finishes
leaves one row of raw fact behind — who, on what model, in which repository, in which domains; did it
verify first try, was it sent back, was it rejected in review, did the work actually reach the base
branch, how many times did a person have to step in, how long, how much, and where that money figure
came from. Nothing is scored. A profile's record and a model's record are two different tables
because they are two different questions, and a record thin enough to be luck says "Insufficient
evidence" rather than a percentage. The Supervisor stops picking whoever sorts first: it ranks
capability fit, then permission, then what a person asked for, then who is free, then the record,
then cost and time — in that order, in one pure function, with a reason trail. A person's choice
beats the system's opinion and never beats the system's wall.

**Facts the design stands on.** The event catalogue holds 58 types
(`packages/domain/src/events/schema.ts`, `packages/domain/test/supervisor/timeline.test.ts:19` counts
them through `LANE_BY_TYPE`). `task.review_rejected {reason, attempt}` (`schema.ts:239-243`) and
`task.rework {reason, attempt}` (`schema.ts:52-54`) are the only verify/review events carrying an
attempt number; `task.verify_passed {branch}` (`:189`) and `task.verify_failed {command, exitCode,
stage?}` (`:190-200`) carry none. `task.integrated` (`:437`) has an empty payload and is written by
`confirmIntegration` (`packages/control/src/integration.ts:36`); auto-merge writes `Task.integratedAt`
directly (`apps/orchestrator/src/merge.ts:265`) while the non-auto path writes `integratedAt: null`
with `status: 'done'` (`merge.ts:153`) — M35's "reviewed is not merged" distinction. No event type is
named "recovery": the breaker's de-escalation is deliberately SILENT (M51 R2 — *"a de-escalation
is silent"*, `schema.ts:617-619`), and the sweep's orphan and dead-pid arms
(`reconcileOrphans`, `sweep.ts:186`; `concludeDeadRun`, `sweep.ts:1042`) conclude a run as `failed`
and append `task.rework`, with nothing distinguishing them from a run the pump concluded. Terminal
`SlaveRun` writes live in eight places: four in `pump.ts` (`:1008` the gate-failure halt, `:1189` the
stop claim, `:1220` the stream-ended arm, `:1317` the clean conclusion), two in `sweep.ts` (`:212`,
`:1055`), and the spawn-failure arms of `tick.ts` (`:457`, `:828`), `planning.ts` (`:666`) and
`review.ts` (`:598`). `SlaveRun` carries `model String?` / `provider ProviderKind?` (M51, written at
the three dispatch sites and replayed verbatim on resume), `costUsd Float?`, `tokensIn/tokensOut
Int?`, `terminalAt`/`endedAt`, and is indexed only `@@index([taskId])` and `@@index([slaveId,
status])`; `ExecutionEvent` is indexed `(workspaceId, seq)`, `(workspaceId, slaveId, seq)`,
`(workspaceId, taskId, seq)`, `(runId, seq)` and by nothing cross-workspace. `costProvenanceOf(row):
'reported'|'estimated'|'unmeasured'` (`packages/domain/src/guardrails/spend.ts:165`) is the existing
three-way split and `RUN_UNMEASURED_CAP_USD = 1` (`:189`) is display-only and charged by nothing.
`apps/web/src/server/analytics.ts`'s `perSlaveRunAggregates` (`:92`) groups by `r."slaveId"` and takes
`SUM(r."costUsd")::float8` raw — no provenance, no template, no model, no domain — and
`SlavePerformanceRow` (`:40`) feeds six columns of `AnalyticsClient.tsx` (`PERF_HEADER`, `:16`);
`docs/ia.md:41` and `:58` both say "M53 replaces the tiles with per-profile evidence". `formTeam`
(`packages/domain/src/capability/team.ts:97`) implements the roadmap's first ranking step only, over
`TeamSource = existing_worker | company_worker | project_worker | temporary` (`:52`), breaking ties by
`busy` then `slaveId`; its caller `teamPlanOf` (`packages/domain/src/supervisor/candidates.ts:123`)
builds the input from `SupervisorWorld`, and `decide()`
(`packages/domain/src/scheduler/decide.ts`) reads no model, no cost, no permission and no evidence and
is unchanged by roadmap line 27. `Capability {key, label, domain, role, …}` (`schema.prisma`) seeds
thirteen domains — `backend data database design docs frontend mobile operations planning product qa
review security` (`packages/db/src/capabilities.ts`) — and `Task.requiredCapabilities String[]` is
multi-valued. `SimulationRun` binds to a `Company` and never to a `Workspace` (`schema.prisma:1518+`).
The gate roster ends at `gate:m52-broker` with "27 gates" (`README.md:911`, roster `:827-835`,
`package.json:65`); `scripts/gate-fakes/` holds four fakes. No index in `schema.prisma` carries a
`type:` today; no `Insufficient evidence` string, no `EvidenceRecord`, no `StaffingPreference` and no
`rankCandidates` exist anywhere in the tree.

## 1. Rulings

- **R1 — Evidence is keyed on four dimensions, and not one of them may be null.** A fact's identity is
  (PROFILE, MODEL, REPOSITORY, DOMAIN). **Profile** is the catalog persona, `SlaveTemplate`: a worker
  hired from one has `profileKey = 'template:<SlaveTemplate.id>'`, and a worker made by hand — a
  `Slave` with `hiredFromTemplateId` null, which every pre-M46 row and every manual New-slave row is —
  is its own BESPOKE profile, `profileKey = 'slave:<Slave.id>'`. There is therefore always a profile,
  and the tuple is never null on this axis. *(verified: `Slave.hiredFromTemplateId` is
  `onDelete: SetNull` (`schema.prisma`), so a deleted template would strand a key pointing at nothing;
  the fact row therefore also stores `profileName String` — the template's or the worker's name as it
  read at write time — for the reason `permission.changed` carries `name` and `kindLabel` in its
  payload: a surface must print a word without a join, and a renamed or deleted row must not rewrite
  history. This is one column beyond the controller's list and it is the price of "labels never keys".)*
  `CompanySlave` is deliberately NOT the profile key: its own comment (`schema.prisma:508-511`) claims
  statistics accrue to the durable name across projects and nothing in the tree has ever implemented
  that, and choosing it would key a company-wide record on a row a project hire does not have.
  **Model** is `SlaveRun.model` — the spawn-time snapshot, never re-derived from the profile chain,
  because a resume replays `checkpoint.model` verbatim (`apps/orchestrator/src/resume.ts:127,151,199`)
  and the question is "what did this run actually use". It is NULLABLE, and that is the one asymmetry
  with the profile: a pre-M51 run and a run whose chain named no model recorded none, and inventing a
  name for it would invent a fact. The by-model table prints the null group as `Model not recorded`
  from a label constant, and the ranker skips it entirely — a model nobody recorded cannot be preferred
  and cannot be ranked. **Repository** is `Workspace.repoPath`, normalised (trailing separators
  stripped) and SNAPSHOTTED at write time as `repositoryKey String`, so two projects on one checkout
  share a record and a later `repoPath` edit does not rewrite the past. *(verified: `repoPath` is a
  bare `String` with no unique constraint (`schema.prisma:59`) and is the only repository identity in
  the schema — there is no `Repository` model and no remote URL anywhere in `apps/orchestrator` or
  `packages/control`, as M52 §3 records. The residual is stated rather than hidden: a checkout moved to
  a new path splits its own history, and a `repoPath`-normalising migration is carried backlog, not
  M53.)* `workspaceId` rides beside it as a column, not a dimension, so every fact can be traced back
  to the project that produced it. **Domain** is R2's. What this ruling deliberately does NOT do: it
  does not give `CompanySlave` a record, it does not unify a bespoke profile with the template it
  resembles, and it does not let a run belong to two profiles.

- **R2 — A run's evidence counts toward every domain its task asked for, and a task that asked for
  nothing counts toward `general`.** The domain of a fact is `Capability.domain` of each key in
  `Task.requiredCapabilities`, resolved through the taxonomy the workspace has; a task requiring
  `backend.services` and `qa.test-automation` produces ONE fact row whose `domains String[]` is
  `['backend','qa']`, and that run's attempt, its first-pass verdict and its cost count toward BOTH. A
  task with no required capability, an unresolvable key, or no task at all (a planning run, M8b) counts
  toward the single reserved domain `general`, which is not a `Capability.domain` value and is declared
  as a constant beside the label table so nothing has to guess. `domains` is never empty. **Multi-count
  is the rule and it is stated where a person reads it**: the domain is a FILTER on the tables, never a
  group key and never a partition — a count under a domain filter is "runs that touched this domain"
  and the money under it is "spent on runs that touched this domain", and neither is ever presented as
  a share of a total, because no total is ever computed by adding the domains up. What this
  deliberately does NOT do: it does not split a run's cost or duration across its domains (a fraction
  of a run is not a measurement of anything), it does not pick a dominant domain, and it does not write
  one row per (run, domain) pair — that would double-count money in the one place money must not be
  double-counted.

- **R3 — Evidence is a fact table with one row per run, one writer, and no rollup.**
  `model EvidenceRecord { id String @id @default(uuid()), runId String @unique, workspaceId String,
  slaveId String, taskId String?, profileKey String, profileName String, model String?, repositoryKey
  String, domains String[], runKind RunKind, attempt Int, outcome EvidenceOutcome, verifiedFirstPass
  Boolean?, reviewRejected Boolean?, integrated Boolean?, reworkCycles Int @default(0),
  humanInterventions Int @default(0), recoveries Int @default(0), durationMs Int?, actualCostUsd
  Float?, costProvenance EvidenceCostProvenance, recordedAt DateTime @default(now()), settledAt
  DateTime? }` with `enum EvidenceOutcome { succeeded, failed, stopped }` — exactly the three terminal
  members of `RunStatus`, closed — and `enum EvidenceCostProvenance { reported, estimated, unmeasured }`,
  pinned by a test asserting its members equal `CostProvenance`'s three so the two lists cannot drift.
  Indexes: `@@index([profileKey, model, repositoryKey])`, `@@index([workspaceId])` and a GIN index on
  `domains` for the containment predicate. *(verified: no index in this schema carries a `type:` today,
  so this is the first; expressed as `@@index([domains(ops: ArrayOps)], type: Gin)`, and if Prisma 7's
  diff does not round-trip it the migration writes `CREATE INDEX … USING GIN` by hand and the model
  carries no `@@index` for it — which changes nothing about the query. A btree cannot answer an array
  containment predicate, which is the only way the domain facet is ever read.)* Aggregation is
  `GROUP BY` over the composite index in read models — `apps/web/src/server/evidence.ts` for the page,
  `packages/control/src/evidence.ts` for the ranker — and never a database VIEW (this schema has none
  and a view is a migration-owned object Prisma does not model) and never a rollup table: a rollup is
  a second copy of a derived number and M53 does not pay for one. The ranker's read is bounded by the
  CANDIDATE SET (`WHERE profileKey IN (…)` over roster ∪ company ∪ the loader's bounded catalog) and is
  SKIPPED entirely when the world has no missing capability, the rule `company` and `catalog` already
  follow (`packages/control/src/supervisorWorld.ts`). **One writer: `recordRunEvidence(runId, opts)` in
  `packages/control/src/evidence.ts`**, which re-derives every column from the `SlaveRun` row and the
  run's own event stream and upserts on `runId`. It is called at the run's terminal transition by the
  single event write gate — `apps/orchestrator/src/pump.ts`'s four terminal arms (`:1008`, `:1189`,
  `:1220`, `:1317`), which is where every run that actually RAN concludes — and by `sweep.ts`'s two
  arms (`reconcileOrphans` `:212`, `concludeDeadRun` `:1055`), which are the only terminal transitions
  no pump is alive to see, with `opts.recoveredBySweep` true (R5). The four spawn-failure arms
  (`tick.ts:457`/`:828`, `planning.ts:666`, `review.ts:598`) write NO fact: nothing was attempted, and
  a profile whose dispatches failed to spawn has not been evidenced about. **Append-only means: a row is
  never deleted, its dimension keys and its run-local measurements are never rewritten, and a
  judgement column moves from null to a verdict exactly once and never back** — a test walks that
  property directly. *(verified: this is the one place the direction had to bend. "Written once at the
  terminal transition" cannot carry `verifiedFirstPass`, `reviewRejected` or `integrated`: verify runs
  AFTER the pump's terminal write (`verifyConcludedRun` is chained onto the pump by every caller), the
  review verdict comes from a different run, and a person may confirm an integration days later
  (`confirmIntegration`). So the row is written once and SETTLED once, by the same idempotent function,
  from R4's four settle sites; three-state judgement columns carry "not judged yet" as null, the
  `SlaveRun.costUsd` nullability precedent — never a false `false`.)* Facts are re-derivable from
  events by construction, which is what R7's backfill is.

- **R4 — Attempt and first-pass verify are derived, never carried on a new event.** At write time **`attempt`** is
  the number of `task.rework` events for this run's task whose `seq` is below this run's own
  `run.started`, plus one — one bounded count over the `(workspaceId, taskId, seq)` index, and 1 for a
  run with no task.
  No event gains an `attempt` field and no `SlaveRun.attempt` column is added; M51 §3 already refused
  that column and M53 does not resurrect it. `verifiedFirstPass` settles at the verify verdict
  (`apps/orchestrator/src/verify.ts`, beside the `task.verify_passed` / `task.verify_failed` append) as
  `verdict === passed && attempt === 1` — so a run whose verify failed settles `false`, and a run that
  passed on its third attempt settles `false` too, which is the whole point of the column.
  `reviewRejected` settles at the review verdict (`apps/orchestrator/src/review.ts`) as
  `payload.attempt === attempt` on a `task.review_rejected` for this task, and `false` on an approval —
  attributed to the IMPLEMENTER's row through `implementerOf(taskId, hint)`
  (`apps/orchestrator/src/verify.ts:106`), the pattern M49 already uses to attribute a verified fact to
  its author, never through `Task.assigneeId`, which nothing in the pipeline writes.
  `reworkCycles` is the count of `task.rework` events for this task appended between this run's
  `run.started` and its judgement — 0 or 1 in today's pipeline, an `Int` and not a `Boolean` because
  nothing guarantees one and a column that could silently be 2 must be able to say so. `integrated`
  settles `true` at `merge.ts:265` (auto-merge, where `integratedAt` is written) and at
  `confirmIntegration` (`packages/control/src/integration.ts`), and `false` on `task.merge_failed`; it
  never settles at `merge.ts:153`, which writes `integratedAt: null` deliberately. **The four settle
  sites are verify, review, merge and integration, and each calls the same `recordRunEvidence`**, so
  there is one derivation and not five. A REVIEW run's own row keeps all three judgement columns null
  forever — a reviewer receives no verdict — and so does a PLANNING run's; both still carry outcome,
  duration, cost, interventions and recoveries. What this deliberately does NOT do: it adds no field to
  `task.verify_passed`/`task.verify_failed` (nine event sites for a field two queries already answer),
  and it does not judge a run nobody judged.

- **R5 — A recovery is two things, named, and a breaker de-escalation is not one of them.**
  `recoveries` counts exactly: **(a)** one, when this run's own terminal row was written by the sweep's
  orphan or dead-pid arm — known because the SWEEP is the caller (`opts.recoveredBySweep`), never by
  matching the reason text of a `run.failed`, which is our own prose and may be reworded; **(b)** the
  number of `task.unblocked` events (`schema.ts:447`, `packages/control/src/unblock.ts:164`) for this
  run's task appended after this run started — a parked task a person or the Supervisor brought back.
  Nothing else. The breaker's de-escalation is NOT a recovery and is not counted, because M51 R2 made
  it silent on purpose — *"a de-escalation is silent"*, `packages/domain/src/events/schema.ts:617-619`,
  and `packages/domain/src/breaker/detect.ts:131` says the same of `trip` — so there is no event to count;
  inventing one would be an M51 change wearing an M53 label. `run.resumed` after a pause is not counted
  either: the pause is already one `humanInterventions` tick, and counting the resume would count one
  person's single act twice. `humanInterventions` is likewise closed and bounded to the run's own
  stream over the `(runId, seq)` index: `run.pause_requested` + `run.resume_requested` + a
  `run.stopped` whose `SlaveRun.stopRequestedBy` is non-null (the operator-versus-sweep discriminator,
  `schema.prisma`). `supervisor.resolved` is deliberately excluded — it is a decision about the
  workspace, carries no `runId` to be bounded by, and would make the count unbounded in exactly the way
  the Supervisor-world loaders refuse.

- **R6 — Actual cost keeps its provenance, and the raw `SUM(costUsd)` goes.** `actualCostUsd` and
  `costProvenance` are written from M51's own machinery and nothing new: `costProvenanceOf({costUsd,
  provider, status, tokensIn, tokensOut, model})` decides the word, and the figure is the reported
  `costUsd` when reported, `estimateCostUsd(model, tokens)` when estimated, and `null` when unmeasured —
  never a zero standing in for a gap. `sumSpend`/`sumSpendFromGroups` stay the spend readers they are.
  `apps/web/src/server/analytics.ts`'s `SUM(r."costUsd")::float8` and the `SlavePerformanceRow.costUsd`
  it feeds are DELETED along with the per-slave table (R12), which is the `docs/ia.md:41,58` note
  discharged: the money on an evidence surface is three numbers with three words beside them, not one
  number that silently absorbs the runs nobody measured. `COST_PROVENANCE_WORD` moves out of
  `apps/web/src/components/TaskDetailPanel.tsx:48` into `packages/domain/src/guardrails/spend.ts`
  beside `CostProvenance`, so the Evidence tab and the task panel read one table — two homes for one
  label is the exact shape M52 E12 refused; `provenanceWordFor` stays in the component, because "so
  far" is a fact about a live run and the Evidence tab has none. What this deliberately does NOT do:
  `workspaceSpend`, `stats.spentUsd`, `evaluateGuardrails`'s budget arm and `RUN_UNMEASURED_CAP_USD`'s
  charging rule are untouched and re-asserted by the existing tests — an evidence table is a display
  surface, and showing a figure and charging for it are different acts.

- **R7 — History counts from day one: one idempotent backfill, over events that may be incomplete.**
  `scripts/backfill-evidence.mjs` walks every `SlaveRun` with `terminalAt` non-null in `id` order, in
  bounded batches, and calls the SAME `recordRunEvidence` the pipeline calls — so there is one
  derivation, not a second one that can disagree, and running it twice writes the same rows (the upsert
  on `runId` re-derives every column). It is deterministic: every input is a stored row or a stored
  event, it reads no clock except for `recordedAt` on a row that does not yet exist, and the order it
  walks in cannot change the result. It is ONE data statement family in the sense the migration rule
  means: the migration itself is additive DDL only (two enums, two models, three
  indexes and one `EventType` member) and the data arrives from this script, run once by an operator,
  never from migration SQL — which is ADR 0003's discipline, not a stylistic choice. **Runs whose events are incomplete**: the run-local
  columns come from the `SlaveRun` ROW, which always exists, so outcome, duration, cost, provenance,
  kind and the dimension keys are always answerable; the event-derived counters (`attempt`,
  `reworkCycles`, `humanInterventions`, `recoveries`) read a count over a possibly-empty set and
  honestly record zero, because a count over nothing IS zero; and the three JUDGEMENT columns stay
  null — "nobody judged this, or the record of the judgement is gone" — rather than settling `false`,
  which would manufacture a failure. A run whose `Workspace` row cannot be resolved is refused (R13)
  and the script reports the count it skipped rather than failing the pass.

- **R8 — Six steps, one pure function, and `decide()` is not read.**
  `rankCandidates(candidates, context): readonly RankedCandidate[]` in
  `packages/domain/src/capability/rank.ts` — pure, total, deterministic, no I/O, the discipline
  `formTeam` already keeps. It applies the roadmap's six steps as a comparator chain, IN ORDER, and
  each step is named on the result so a rationale sentence is derived rather than invented:
  **(1) capability fit** — a candidate that provides the capability outranks one that does not, and
  among providers the one covering more still-missing capabilities wins (the existing set-cover rule,
  unchanged); **(2) permission** — R10; **(3) user preference** — R9; **(4) availability** — an idle
  candidate outranks a busy one (`busy` is the world's existing flag; a template is never busy);
  **(5) evidence** — three NAMED rates read in a fixed order, first-pass verify rate (higher wins),
  then review-rejection rate (lower wins), then integration rate (higher wins), each skipped for a
  candidate whose own denominator is below `EVIDENCE_MIN_SAMPLE` (R11) so a thin record ties instead of
  deciding; **(6) cost/time** — median `actualCostUsd` over the candidate's `reported` and `estimated`
  rows (lower wins), then median `durationMs` (lower wins), with a candidate that has no measured cost
  tying rather than winning, because being unmeasured is not being cheap. The final tie-break is the
  candidate id, so the function is total and the same world always yields the same order. `formTeam`
  calls it: the `TeamSource` tier ORDER is untouched (it IS step 1, and M47 R4 fixed it), and
  `rankCandidates` decides the pick WITHIN a tier, replacing tier 1's `busy`-then-`slaveId` sort
  (`team.ts:127`) and tiers 2 and 3's bare-id tie-break. `teamPlanOf`
  (`packages/domain/src/supervisor/candidates.ts:123`) supplies the context from `SupervisorWorld`.
  **`packages/domain/src/scheduler/decide.ts` is not imported, not read and not changed by anything in
  this milestone**, and the Supervisor gains NO new situation and NO new action — the action and
  situation catalogues keep their counts, and `situations.ts`'s "an EIGHTEENTH kind fails the build"
  comment is untouched. What this deliberately does NOT do: it produces no number, no ordering key and
  no "fit score"; a comparator chain is not a score precisely because no two dimensions are ever traded
  off against each other.

- **R9 — A user preference is a row, it wins over the system's opinion, and it is not a preference for a
  worker who cannot take the job.** `model StaffingPreference { id String @id @default(uuid()),
  workspaceId String, capability String, templateId String?, model String?, setBy String?, setAt
  DateTime @default(now()), workspace Workspace @relation(…, onDelete: Cascade) }` with
  `@@unique([workspaceId, capability])` and `@@index([workspaceId])`: one decision per capability per
  project, naming a profile, a model, or both ("Atlas, and on opus"). At least one of the two must be
  non-null — a row naming neither is `invalid_staffing_preference { capability }`, the one new
  `ControlRefusal` kind (409 by `refusalStatus`'s suffix rule), and the other refusals reuse what
  exists: `capability_not_found`, `template_not_found`, `invalid_model`, `workspace_not_found`.
  `setBy` is the granting principal's name or null, exactly as `SlavePermission.grantedBy` is. **"User
  choices win" is bounded by the step order and by one rule.** Position gives it half: permission is
  step 2 and preference is step 3, so a preference can never beat a person's explicit refusal — two
  decisions by the same authority, and the refusal is the narrower, safety-bearing one. Position does
  NOT protect availability, which is step 4, so the rule does: **a preference for a BUSY candidate is
  not a preference for this dispatch** and carries no weight at step 3; that candidate is ranked by
  4-6 like everyone else. Availability is not an opinion — it is a fact about the world, and preferring
  a worker who cannot start would park the work. Evidence (5) and cost (6) ARE the system's opinions,
  and a preference short-circuits both: once step 3 has separated two candidates, steps 5 and 6 never
  run between them. Writes go through `setStaffingPreference` / `clearStaffingPreference`
  (`packages/control/src/staffing.ts`), a CLI verb `staffing prefer|clear|list` beside `permission` /
  `credential` / `broker` (`apps/orchestrator/src/cli.ts`), and
  `PUT|DELETE /api/w/[workspaceId]/staffing/[capability]` in the workspace-scoped route family. Every
  write appends **`staffing.preference_changed { capability, capabilityLabel, from, to, by }`** — the
  59th event, `from`/`to` each `{ templateId, templateName, model } | null` — and pays the nine sites
  M52 R3 lists once: `packages/domain/src/events/schema.ts`; `schema.prisma`'s `EventType` plus the
  migration; `packages/db/src/enums.ts`'s `EVENT_TYPE_BY_DOMAIN_TYPE`;
  `packages/domain/src/supervisor/timeline.ts`'s `LANE_BY_TYPE` (lane `null`, the `org.changed`
  precedent at `:132` — a staffing preference is project configuration, not part of the organisation's
  narrative); `apps/web/src/components/activity/cards.tsx` (component + registry);
  `apps/web/src/lib/activityFilters.ts` (under `workspace`, beside `org.changed`, for the reason that
  chip's own comment gives: it carries no taskId and answers "what did an operator change about this
  project"); `apps/web/src/server/timeline.ts`; `packages/domain/test/events/schema.test.ts`; and
  `apps/web/test/{activityFilters,activity-cards}` — twice.
  `packages/domain/test/supervisor/timeline.test.ts:19` moves 58 → 59. The payload carries `capabilityLabel` and `templateName` for
  `permission.changed`'s reason: a card must print words without a join.

- **R10 — The permission step reads M52's grants and invents no oracle.** A candidate that is an
  EXISTING SLAVE and carries an explicit `deny` row (`SlavePermission.mode = 'deny'`) on any kind in
  `BASELINE_GRANTS[runKind]` ranks BELOW every candidate without one. That is the whole step. It reads
  `grantsFor(rows, runKind)` (`packages/domain/src/permission/resolve.ts:102`), the same projection the
  worker panel prints, so the ranking and the surface can never disagree about who is walled off from
  what. A candidate that is a TEMPLATE or a company worker not yet materialised into this project has
  no `SlavePermission` rows at all and is UNAFFECTED — not favoured and not penalised. **There is no
  "would this profile be granted X" oracle in M53**: M52 built a per-run gate over vendor tools, not a
  staffing-time capability question, and a guess about a grant nobody has made would be the system
  inventing a person's decision. `SupervisorSlave` gains `deniedKinds: readonly PermissionKind[]` — the
  `deny` rows only — from one `findMany` scoped to this workspace's slaves, skipped entirely when the
  workspace holds no `SlavePermission` row, the bounded-loader rule M52 E9 already applied to
  `denials`. What this deliberately does NOT do: it does not exclude a denied candidate (a wall is a
  ranking fact, not a disqualification — `formTeam` may still be the only option and must say so), and
  it does not read `run.tool_denied` counts, which are M52's `denials` and answer a different question.

- **R11 — No universal score, anywhere, and a thin record says so in words.** **No column, field,
  property or sort key in this milestone combines two dimensions into one number.** There is no
  `score`, no `rating`, no `rank` value, no weighted total and no normalised index; a test asserts that
  `EvidenceRecord` has no such column and that `rankCandidates`' result type carries none. This is
  `packages/domain/src/memory/types.ts:37-40`'s ruling applied a second time — *"deliberately not a
  number: nothing in this system can honestly produce a 0.73, and a number invites ranking by it --
  which is M53's job, with evidence"* — that file names this milestone by name, and this is the
  answer: the job is done with facts and comparators, and the number it refused is not invented here
  either. It is why R8 is a comparator chain. **The tables sort by `attempted` descending, then by the row's
  own NAME ascending** (profile name, model string), and by nothing else; the sort is stated in a caption on the page so a
  reader is not left inferring it from the order. `EVIDENCE_MIN_SAMPLE = 5` lives in
  `packages/domain/src/capability/rank.ts` beside the ranking that reads it, is labelled in its own
  docstring as the smallest sample this project is willing to call evidence, and is pinned by a test
  that names the number. Wherever `attempted < EVIDENCE_MIN_SAMPLE` the row's rates are replaced,
  entirely, by the words **Insufficient evidence** — not a dash, not a zero, not a greyed percentage —
  and the counts stay visible beside them, because the counts are facts and only the rates are claims.
  The same words render for an individual rate whose OWN denominator is below the constant even when
  the row's `attempted` is not: a first-pass rate over two judged runs is no better evidence than a row
  with two runs, and the three judgement columns are settled independently (R3), so this case is
  ordinary rather than exotic. `MappingQuality`'s `full|partial|none` and `CostProvenance`'s
  `reported|estimated|unmeasured` are the two precedents this follows: an honest small state, never a
  fabricated number.

- **R12 — A sixth Workforce tab, two tables, and the analytics tiles hand over.** `WorkforceTab`
  (`apps/web/src/components/workforce/WorkforceClient.tsx:25`) gains `'evidence'`, `WORKFORCE_TABS`
  gains `{ id: 'evidence', label: 'Evidence' }`, and `TAB_IDS`
  (`apps/web/src/app/workforce/page.tsx:19`) gains it too, so `?tab=evidence` is bookmarkable like the
  other five. `apps/web/src/server/evidence.ts` builds the page from two `GROUP BY` reads over
  `EvidenceRecord`: **by profile** — `Profile | Repository | Attempted | Verified first pass | Review
  rejected | Rework cycles | Integrated | Interventions | Recoveries | Median duration | Cost` — and
  **by model** — `Model | Attempted | Verified first pass | Review rejected | Integrated | Median
  duration | Cost`. Two tables, deliberately, because profile performance and model performance are the
  two questions the roadmap says must not be confused. Domain is a filter chip row above both,
  defaulting to every domain (R2). **Counts and rates only; no chart, no sparkline, no trend line** —
  `BarChart` is not imported. Labels never keys (ia.md rule 3): a profile prints its `profileName` with
  `profileKey` on `data-profile-key` and in `title`, a bespoke profile carries a `Bespoke` chip, a
  domain prints `domainLabel(domain)` — a new helper in
  `packages/domain/src/capability/taxonomy.ts` beside `capabilityLabel`, title-casing the segment with
  a small exception table (`qa` → `QA`, `docs` → `Docs`) and `general` → `General` — with the raw
  string on `data-domain`, and no cell anywhere prints a bare `profileKey`, `EvidenceOutcome` member or
  `EvidenceCostProvenance` member as its visible text. Money follows ia.md rule 4 and M51's words:
  `formatUsd` (`apps/web/src/lib/realMoney.ts`) only, never `formatMinor`, with the three provenance
  words from the moved `COST_PROVENANCE_WORD` beside the figure and the unmeasured count on its own
  line, never folded in. Testids for the gate: `evidence-table-profile`, `evidence-table-model`,
  `evidence-profile-row-<profileKey>`, `evidence-model-row-<model>`, `evidence-insufficient-<key>`,
  `evidence-domain-<domain>`, `evidence-sort-caption`. **`/analytics` keeps its route and its
  `?workspace=` scope** (ia.md rule 2, nothing is removed only moved) and loses two things: the
  `slave performance` panel, replaced by one line linking to `/workforce?tab=evidence`, and the `Spend`
  KPI tile, whose figure was the raw `SUM(costUsd)` R6 deletes — five tiles remain and the same five
  render on the Projects home, which shares `buildAnalytics` and `KpiStrip`. `SlavePerformanceRow`,
  `perSlaveRunAggregates`, `PERF_COLUMNS` and `PERF_HEADER` go with them, and
  `apps/web/test/integration/analytics-aggregates.test.ts` retires with the computation it pins.
  The preference control (R9) lives where the staffing decision is read — the project's Organization
  tab, on the `organization-need-<capability>` rows and beside each covered capability — and the "why"
  sentence names the preference when one decided the pick. `docs/ia.md` gains M53 notes on the
  `/workforce` row, both `/analytics` rows (the Later column's promise, kept) and the Activity row.

- **R13 — Nothing crosses the simulation boundary.** `recordRunEvidence` refuses `simulation` — a
  returned refusal, BEFORE any write — when the run's `Workspace` cannot be resolved. That arm is
  unreachable by construction and is kept as a tripwire, for M52 R6's reason: a `SimulationRun` binds
  to a `Company` and never to a `Workspace` (`schema.prisma:1518+`), a simulated role is not a `Slave`,
  holds no `SlavePermission` and can reach no `SlaveRun`, so no simulation row can name one. It is NOT
  keyed on `Workspace.archivedAt`: an archived project's runs are real history and refusing them would
  lose it, which is where this ruling differs from the broker's (`packages/control/src/broker.ts:204`)
  and why the difference is written down. `SimulationRun`, `SimulationJournalEntry` and
  `SimulationModelUsage` feed `EvidenceRecord` nowhere; `Workspace.adoptedFromSimulationId` is not read
  by anything in this milestone — a project adopted from a simulation is a real project whose real runs
  are real evidence. `packages/control/test/simulation-boundary.test.ts` gains a FOURTH expect in the
  case that walks `packages/control/src/simulation.ts` plus `simulation/*.ts` (beside the existing
  three: `@slave-of-ai/providers`, `child_process|process.env|spawn(`, and M52's
  `broker|Credential|SLAVEOFAI_RUN_TOKEN`): the source must not match
  `/EvidenceRecord|rankCandidates|StaffingPreference/` — the three nouns named by name, the way the
  existing cases name theirs. Simulated money never appears on the Evidence tab (R12).

- **Global constraints.** **Never a real model call** in a test or a gate
  (`packages/providers/test/fake-claude.mjs`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`); a real call needs the
  user's explicit consent, per call. **One vitest run at a time**, and never a gate beside one — they
  share one Postgres, and a running daemon breaks the subscribe test. **`npm run web:build` is never
  run while `next dev` is up**, and it is the last gate of a web task, because tsc and vitest do not
  see bundler-only breakage. **No `prettier`** — this repository has no config and no dependency, and
  `prettier --write` reformats against the house style. **`apps/web` imports carry no `.js` suffix**;
  every other package's do. **A piped command's status is `${PIPESTATUS[0]}`**, never `$?`.
  **`tsc --build` runs after `db:generate`**, and `npm run typecheck` (which also checks every
  `tsconfig.test.json` and `apps/web`) is what the pre-push hook runs — a green `tsc --build` can still
  fail it. **The product word is `slave`** (`gate:m26-vocabulary`). **Labels never keys**
  (`docs/ia.md` rule 3): every new vocabulary gets a label table beside the thing it names, and the raw
  value stays in `title`, a `data-` attribute, or the expanded view. **A refusal lives in three homes**
  — the `ControlRefusal` union and `refusalText` (`packages/control/src/refusal.ts`), the CLI, and
  `apps/web/test/refusal-status.test.ts`'s `Record<ControlRefusal['kind'], true>`. **A refusal after a
  write inside a Prisma transaction THROWS**; a returned `err()` commits. **Untouched and asserted so:**
  `decide()`, `evaluateGuardrails`, `workspaceSpend`, `stats.spentUsd`, and the budget guardrail's
  number. **The migration is additive** — two enums, two models, the indexes, one `EventType` member —
  **deterministic, applied to both databases, with the Prisma 7 diff proof** (M42 E23);
  `20260912210000_m53_evidence`. **A new event pays the nine sites** R9 lists. **Every commit carries
  the session's trailers.** **The test baseline does not go down: ≥ 338 files and ≥ 5642 tests**, and a
  new unique index is checked against every package's fixtures, not only the one under edit — only the
  full suite can see a fixture collision in another package.

## 2. Surfaces after M53
Domain: `capability/rank.ts` (`rankCandidates`, `RankCandidate`, `RankedCandidate`, `RankReason`,
`EVIDENCE_MIN_SAMPLE`), `capability/taxonomy.ts`'s `domainLabel` + `GENERAL_DOMAIN`,
`guardrails/spend.ts`'s moved `COST_PROVENANCE_WORD`, `capability/team.ts`'s `formTeam` calling into
the ranker, event `staffing.preference_changed`, `LANE_BY_TYPE` ×1. DB: `EvidenceRecord`,
`StaffingPreference`, `EvidenceOutcome`, `EvidenceCostProvenance`, one `EventType` member, three
indexes, migration `20260912210000_m53_evidence`. Control: `evidence.ts`
(`recordRunEvidence`, the aggregation read the ranker takes), `staffing.ts`
(`setStaffingPreference`, `clearStaffingPreference`, `listStaffingPreferences`), one refusal kind,
`supervisorWorld.ts`'s two new bounded loads. Supervisor: `SupervisorWorld.staffingPreferences` and
`.evidence`, `SupervisorSlave.deniedKinds`, `teamPlanOf` passing the ranking context — no new
situation, no new action. Orchestrator: `recordRunEvidence` at pump's four terminal arms and sweep's
two, and at verify's, review's, merge's and integration's verdicts; CLI `staffing`. Web:
`/workforce?tab=evidence` (`server/evidence.ts`, the two tables, the domain chips), the Organization
tab's preference control, `PUT|DELETE /api/w/[workspaceId]/staffing/[capability]`, one activity card,
`/analytics` minus the per-slave panel and the Spend tile, `docs/ia.md`. Scripts:
`scripts/backfill-evidence.mjs`, `scripts/gate-m53-evidence.mjs`, `scripts/gate-fakes/fake-verify.sh`.

## 3. Gate
`scripts/gate-m53-evidence.mjs`, `gate:m53-evidence` after `gate:m52-broker` in `package.json` and in
CI, **README 27 → 28 gates** in both places (roster `README.md:827-835`, the count at `README.md:911`);
real daemon, fake CLI, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`, Playwright, zero spend. The fixture set is the
milestone's own scenario: **two templates staffed into one workspace on two tasks, scripted so their
rates differ** — profile A runs with `--review-fixture review-approve` and a verify command that
passes first time; profile B runs with `--review-fixture review-reject` and a verify command that
fails once and passes on the rework, producing the sequence verify-fail → rework → verify-pass →
review-rejected → (after its second cycle) integrated. `scripts/gate-fakes/fake-verify.sh` is the
FIFTH fake: `Workspace.verifyCommands` points at it with `--state <path>` on the command line (the
`fake-deploy.sh` precedent — a path in argv, never an environment variable, because a verify child's
environment is not the gate's to assume), and it exits 1 while the state file says so and 0
afterwards. Stages:

1. **Facts at terminal transitions only.** While a run is live there is no `EvidenceRecord` row for it;
   the instant it concludes there is exactly one; `runId` is unique, so a second conclusion (a sweep
   racing a pump) cannot make two. A run failed at SPAWN (`tick.ts`'s `concludeFailedResume`) leaves
   NO row at all — asserted directly, because "nothing was attempted" is the ruling.
2. **Attempt and first-pass derivation.** Profile A's row: `attempt 1`, `verifiedFirstPass true`.
   Profile B's first row: `attempt 1`, `verifiedFirstPass false`, `reworkCycles 1`; its second row:
   `attempt 2`, `verifiedFirstPass false`. No event in the log gained an `attempt` field and
   `SlaveRun` gained no `attempt` column — asserted from the schema.
3. **Multi-domain counting.** A task requiring two capabilities in two domains produces ONE row whose
   `domains` holds both; the by-profile table under either domain chip counts that run once, and the
   two filtered counts deliberately do not sum to the unfiltered total. A task with no required
   capability lands in `general`.
4. **Provenance on cost.** Three rows in one workspace read `reported`, `estimated` and `unmeasured` —
   a run whose stream reported a cost, one that reported only tokens under a priced model, and one
   that reported neither — the unmeasured row's
   `actualCostUsd` is null and not 0, and the page prints the word beside the figure and the
   unmeasured count on its own line.
5. **The backfill is idempotent.** Delete every `EvidenceRecord` row, run `backfill-evidence.mjs`,
   snapshot the table; run it again; every row is byte-equal, `recordedAt` included — an
   existing row's is never rewritten. A run whose `run.started` event has been removed still
   gets a row, with zeros in the event-derived counters and nulls in the judgement columns.
6. **Simulation refused, and the boundary named.** A `recordRunEvidence` call for a run whose
   workspace cannot be resolved returns the `simulation` refusal and writes nothing; the
   `simulation-boundary` source scan names `EvidenceRecord`, `rankCandidates` and
   `StaffingPreference`; no `SimulationRun`, `SimulationJournalEntry` or `SimulationModelUsage` row
   contributed to any fact.
7. **Ranking order, with a preference set and cleared.** With both profiles evidenced and profile A's
   record clearly better, `formTeam` proposes A. Set `staffing prefer --capability <k> --template <B>`
   and the same world proposes B, with a rationale naming the preference. Clear it and A comes back.
   `staffing.preference_changed` appears twice on the timeline with `from`/`to` and `by`.
8. **A preference never moves the wall, and never moves the queue.** With the preference on B, deny B
   a kind in `BASELINE_GRANTS.implementation` — B drops below A again (permission is step 2). Revoke
   the deny, make B busy — A is proposed again (a preference for a busy candidate is not a preference
   for this dispatch). `SlavePermission` is unchanged by every one of these steps.
9. **Insufficient evidence on a small sample.** A third profile with two terminal runs renders
   `Insufficient evidence` in place of every rate, with its counts still visible, and
   `evidence-insufficient-<key>` present; a rate whose own denominator is below the constant renders
   the same words while its neighbours in the same row render percentages.
10. **No raw key on the page, and no score.** Every visible cell in both tables is checked against the
    raw values behind it — no `template:<uuid>`, no `slave:<uuid>`, no bare `succeeded`/`reported`/
    `backend` as visible text — while `data-profile-key`, `data-domain` and `title` carry them; and
    the page source contains no score, rating or index column, matching R11's own test from the
    browser side.
11. **The sort is what the caption says.** Rows come back `attempted` descending then name ascending,
    asserted against the caption's own words.
12. **The analytics tiles are gone.** `/analytics` renders five tiles and no `Spend` tile, has no
    `slave performance` table and no `perf-*` testid, and carries a link to `/workforce?tab=evidence`;
    the Projects home renders the same five; the route and its `?workspace=` scope still work.

Moved pins, named: `apps/web/test/analytics-page.test.tsx` and
`apps/web/test/integration/analytics-aggregates.test.ts` lose the per-slave computation with the
computation; `packages/domain/test/supervisor/timeline.test.ts:19` 58 → 59;
`packages/domain/test/capability/team.test.ts` gains the within-tier ordering cases and keeps every
tier-order case unchanged; `apps/web/test/refusal-status.test.ts`'s exhaustive record gains one kind.
`gate:m47-team-formation`, `gate:m50-ephemeral`, `gate:m51-breaker` and `gate:m52-broker` are unchanged
and re-run. `gate:m14-fidelity` screenshots are regenerated in a deliberate commit (the Workforce page
with its sixth tab, and the analytics page).

## 4. Out of scope
`HandoffContract.evidenceRequired` (M48) stays INERT — a list the worker reads and nothing verifies —
because checking a run's declared evidence against what it produced is a verification feature wearing
an evaluation feature's name, and M53's evidence is entirely run- and event-derived. `broker.executed`
is NOT read as an evidence signal, although M52 §3 named M53 its first consumer: a deployment's exit
code is a fact about an operation, not about the run that asked for it, and the roadmap's ten evidence
columns name none of it. A rollup or materialised aggregate of `EvidenceRecord` (R3; backlog if the
fact table's query cost ever matters). A `CompanySlave`-keyed record, and any cross-company evidence —
M49 §3 refused cross-company sharing for memory and M53 does not quietly grant it for evidence; a
record spans the workspaces one installation holds, and nothing else. Any universal score, weighting,
normalisation or configurable threshold beyond `EVIDENCE_MIN_SAMPLE` (R11). Per-workspace evidence
thresholds or a settings UI for them (M38 §8's rule, unchanged). Charts, trends, sparklines and
anything the roadmap calls a vanity chart. Changing `decide()`, `evaluateGuardrails`, `workspaceSpend`
or `stats.spentUsd`. A new Supervisor situation or action. Tool-call rates as evidence (which is why
M52's `toolCallCap` denominator item stays carried and is not fixed here). An evidence CLI report.
Automatic de-staffing, retirement or promotion of a profile on the strength of its record — evidence
ranks a proposal, it never takes a person's decision. Backfilling a `repoPath` that has moved.
**And the line every predecessor carries is discharged here: nothing in M47, M48, M49, M50, M51 or M52
ranked by evidence, and after this milestone something does.**

## 5. Errata — where execution corrects this spec
None yet. Errata are added while the plan is written and while it is executed, each as
`**En (amends Rx)** — <one-line claim>.` with its reasoning and file citations, the way M50's fifteen,
M51's and M52's fifteen were.

## 6. Carried backlog (M52 §5 and the items M52 pointed at M53; not M53 scope unless a task touches the file)
From M52 §5 (which reproduces M51's own final-review deferred list; that session's `.superpowers/sdd`
folder is no longer in the tree, so M52's spec is the surviving copy):
eight files still write guardrail names as unchecked literals and want `satisfies GuardrailKind`;
`MODEL_PRICES` (6 entries) is unpinned against `CLAUDE_CODE_MODELS` (11), so a seventh model can be
silently unpriced — **M53 raises this the way M52 raised the Cursor one, from cosmetic to load-bearing:
`costProvenanceOf` is now what decides an evidence row's `costProvenance`, so an unpriced model makes
every one of its runs read `unmeasured` and drops that model out of the cost step of the ranking**;
de-escalation lowers a run's WORD while a standing `toolCallCap` keeps it constrained; the candidates'
vanished-run path records an escalation about a concluded run; `runTapScript` has no timeout while
`preflightTap` runs on every start and resume; a tap that breaks between daemon start and a spawn still
fails that spawn; three web read models (`graph.ts`, `overview.ts`, `org.ts`) divide tool calls by
`maxToolCallsPerRun` where a capped run's honest denominator is `toolCallCap` — **M53 does not inherit
the fix, because no evidence column reads a tool-call rate**; `upperBoundUsd`'s flat
`RUN_UNMEASURED_CAP_USD` can render below the estimate on the same tile; the `brief.test.ts` comment
contradicting `unmeasuredRuns`; M4 Cursor's `rejected` line yields no `tool_result`, raised to likely
by M52's default-deny; M7 analytics and the brief compute two differently-scoped upper bounds; M8
`run.tool_result` plus per-turn usage roughly doubles the pump's write volume — **and M53 adds one
upsert per run conclusion and one per verdict to that same path, which is the next thing to measure if
the pump's write volume is ever the problem**. From M51 §5 (M50's list and M46-M50 §5): a dispatch from
a pre-release snapshot can leave one uncollected worktree; a null-engagement temporary hire downgrades
with a warn; `brief.ts`'s team read has no `orderBy`; `gate:m47-team-formation` stage 6 flakes on
`recordDecision` committing before `applyDecision`; the CLI's singular worktree wording; a
non-temporary hire reusing an unreleased ephemeral worker; a reuse leaving a decision claiming an
engagement; `engagement_over` racing a dispatch; `AllSlavesTable` not sorting released rows last;
Organization/RunbookPanel/Knowledge each loading a full Supervisor world per Overview render — **which
M53's two new world collections make marginally dearer, and which the Evidence tab deliberately does
not join (it reads `EvidenceRecord` and nothing else)**; `tierOf` busy at draft time;
`CATALOG_ENTRIES_MAX` by id; pre-M47 templates keeping `capabilityKeys: []`; gates m8/m10/m13 outside
CI; the m11 flake; m14 PNG nondeterminism; mapper M6/M7/E23; `WorkforceClient`'s bare `<details>`; `q`
undebounced; the drawer's spec-scoped `rawOverride`; the `sourceRepository` asymmetry;
`GET /api/org/catalog` principal harmonisation; M48's `unknownStages`, persona runbook key collisions,
`gate:m48` writing to a seed row, `runbooks show` printing keys, `addRunbook`'s discarded `by`, and
`stageTitle` vs swapped runbooks; M49's workspace-only verified-FACT command names, company-scope
condensation, the unbounded coverage query, summaries never becoming sources, orphan candidates for
stranded runs, no end-to-end failing-write test, and the shared `block`/`singleLine`/`safe` helper.
Newly carried by this milestone, from what it declined: `HandoffContract.evidenceRequired` is still
verified by nothing (§4), and its docstring's "M53 owns evidence-based ranking" sentence is amended to
say the ranking landed and the verification did not; `broker.executed` still has no consumer (§4);
a repository whose checkout moves splits its own evidence (R1); and a GIN index is this schema's first,
so the next array column has a precedent to copy or a reason not to.
