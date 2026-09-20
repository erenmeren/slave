# E — The self-running project: autonomy, diagnosed remedies, task needs, auto-merge

The second of the pieces the 2026-09-20 brainstorm ordered (A: catalogue capability mapping, merged
at `6f871afe`; this is E, pulled ahead of B/C/D by the user's direction "bu akışlar otomatik olmalı,
her şeyi AI kendisi halletmeli"). It is a **control milestone**: it changes what the Supervisor may
do on its own, what it knows when a task is stuck, what a run is allowed to touch, and whether a
finished task waits for a person. No new planner, no new UI frame. Designed 2026-09-20 with the
user, who took four decisions:

1. **one switch per project** decides whether the Supervisor proposes or acts: "her şeyi onayla"
   on means the Supervisor applies its own decisions; off means today's behaviour (propose, the
   person approves in the needs-you bar);
2. remedies come with a **diagnosis**: a blocked or failed task is examined for WHY before the
   Supervisor chooses between retrying, reworking, granting a permission, or asking a person;
3. a task's **needs** (network, commands) are written by the planner and honoured at dispatch, so a
   research task can reach the web without a person granting it by hand;
4. **auto-merge is a real switch** in the product, on by default for new projects, not a column
   flipped in the database.

**Why now.** The second maratus project (workspace `bf5429e9…`, 2026-09-20) stalled four times in
three hours, each time on something a person had to do by hand: the audit task's review could not
read a 3.5 MB diff and the task was parked `blocked` after two review failures (fixed the same day
in `reviewDiff.ts`, but the parking rule is unchanged); the finished audit waited for
`confirm-integration`; the research task, whose role has no network permission, spent 2.5 hours
in three runs that timed out or looped and ended `failed` — a terminal status nothing in the product
can leave; and the three failures tripped the workspace's circuit breaker, which nothing but
`clear-halt` clears. The Supervisor saw every one of these situations (`review_cap_blocked`,
`permission_blocked`, `run_looping`) and, for the ones it could act on, was allowed only to propose.

**Goal.** With the switch on, a project like maratus runs from accepted draft to launch with a
person watching the Home feed and answering the questions only a person can answer. Every
intervention a person made by hand on 2026-09-20 becomes something the Supervisor does itself, with
a line in the feed saying it did, and every one of them is still available as a proposal when the
switch is off.

**Facts the design stands on** (read out of the tree on 2026-09-20; line numbers as of `b323674a`).
`tierOf` (`packages/domain/src/supervisor/policy.ts:44-121`) decides an action's tier: `escalate_to_human`
→ escalated; `no_action` → noop; any action on a halted world → proposed; `applied` only for
`unblock_task` on `review_cap_blocked`, `reassign_question` when the target may answer,
`assign_capability` when the worker is idle, `release_worker`, `steer_run`; everything else —
`hire_from_catalog`, `materialise_company_worker`, `request_permission`, `raise_max_attempts`,
`set_runtime_roles`, `mark_task_failed`, `cancel_task`, `adopt_runbook`, `discard_stale_candidates`,
`answer_question` — is proposed. `approveDecision`/`rejectDecision` (`packages/control/src/supervisor.ts:703-804`)
claim a pending row and `applyDecision` → `carryOut` (`:310-548`) maps every kind to a control verb.
`SupervisorTask` (`packages/domain/src/supervisor/world.ts:21-91`) carries `latestGuardrail` (a name)
and no failure reason; `SupervisorRun` (`:312-326`) carries breaker fields and no reason; the loader
(`packages/control/src/supervisorWorld.ts:1036-1084`) reads neither `run.failed` payloads nor
`run.tool_denied` counts. `observe.ts:185-201` splits a `blocked` task into `review_cap_blocked`
(when `latestGuardrail === 'review_retry_cap_exhausted'`) and `task_blocked_human`; `candidates.ts:316-560`
offers `unblock_task`/`raise_max_attempts`/`mark_task_failed` for both, `steer_run` for
`run_looping`, `request_permission` for `permission_blocked`, and `escalate_to_human` + `no_action`
for every kind. A `failed` task is terminal (`docs/domain-model.md:84`); `unblockTask`
(`packages/control/src/unblock.ts:96-172`) accepts only `blocked`, never resets `attempt`, and moves
to `reviewing` only when the review budget is not spent. Workspace settings: `setWorkspaceProvider`,
`setWorkspaceBudget` (`packages/control/src/workspace.ts:33-118`) and `setSupervisorSettings`
(`supervisor.ts:1159-1218`, fields `enabled`/`profile`) emit `workspace.settings_changed`; `autoMerge`
is written by no verb; `CreateWorkspaceInput` (`workspace.ts:120-128`) has `name, repoPath,
baseBranch?, verifyCommands, setupCommands?, budgetUsd?, provider?`; the intake draft
(`packages/domain/src/intake/draft.ts:60-77`) mirrors it plus `team`. `merge.ts:188-191` consults
`workspace.autoMerge` after review approval; `false` writes `integratedAt: null`. The plan graph
task (`packages/domain/src/planning/graph.ts:7-44`) is `{key, title, description, role?, capabilities,
handoff?, stage?, dependsOn}`; `concludePlanning` (`apps/orchestrator/src/planning.ts:200-254`) writes
`requiredRole`, `requiredCapabilities`, `handoff`, `stage`. Permissions: `BASELINE_GRANTS`
(`packages/domain/src/permission/kinds.ts:205`) gives implementation `read_repo, write_repo,
run_commands`, review `read_repo, run_commands`, planning `read_repo`; `network_fetch` is baseline
for nothing; `resolveGrants(rows, provider, runKind)` (`resolve.ts:57-75`) takes the worker's
`SlavePermission` rows and the run kind, deny wins; `writePermissionsFile` (`packages/control/src/permission.ts:52-83`)
snapshots `<runDir>/permissions.json` at dispatch (`tick.ts:701-718`) with no task input. The
dispatch of a task whose worktree still exists from an earlier run fails with `worktree for this
task already exists (both)` (`tick.ts`, `provisionWorktree`; `adoptWorktree` exists beside it). The
tick halts the whole workspace on `circuit_breaker` from the stats snapshot (`decide()`'s guardrail
over consecutive failures, `consecutiveFailureLimit` default 3), retracted by `clear-halt`
(`cli.ts:276`, `haltClearedAt`). Home's "Happening now" families (`apps/web/src/lib/happening.ts:38-42`)
include `supervisor.proposed`/`decided` but not `supervisor.applied`; the Supervisor panel's threads
(`apps/web/src/server/supervisorThreads.ts:38-45`) include `applied`. The panel's scope line is
`SupervisorThreadPanel.tsx:286-291`. `RuntimePanel.tsx:142-148` shows `maxConcurrentRuns`,
`runTimeoutMs`, `maxAttempts` read-only. The maratus workspace was flipped to `autoMerge=true` by
hand on 2026-09-20 and the research seat was granted `network_fetch` by hand; both stay as they are.

## 1. Rulings

**R1 — One switch: `Workspace.supervisorAutonomy`, `propose | act`.** A new Prisma enum
`SupervisorAutonomy { propose, act }` and column `supervisorAutonomy SupervisorAutonomy @default(propose)`
(migration; existing rows keep today's behaviour). `SupervisorWorld` gains `autonomy: 'propose' | 'act'`.
`tierOf` changes in one place: after the `escalate_to_human`, `no_action` and halted checks (which
keep their order and meaning), **when `world.autonomy === 'act'` every remaining action is
`applied`**. `escalate_to_human` stays escalated (a person is asked only when the candidate set
holds nothing else, §R3), and a halted workspace still forces proposals — except the actions R4
adds for a CIRCUIT-BREAKER halt (E11: `clear_halt` and the `retry_task` its evidence is made of). Under `propose` nothing changes. `setSupervisorSettings` gains
`autonomy?: 'propose' | 'act'` and emits `workspace.settings_changed` with field
`supervisorAutonomy`; the CLI's `supervisor` verb gains `--autonomy propose|act`; the web PUT
`/api/w/:id/supervisor` accepts it; the panel's scope line gains the switch (`data-testid="supervisor-autonomy"`,
label "act on its own" — the product's copy language is English; the user's own phrase for it is
"her şeyi onayla").
`createWorkspace` gains `supervisorAutonomy?` and the intake draft gains `autonomy` (default
`'act'`), shown on the intake card as a checkbox, so a new project starts autonomous unless the
person says otherwise. **Why:** the user's decision 1, and the smallest change that honours it: the
tier is the one gate every action passes. **Cost if wrong:** a column and one branch.

**R2 — What the Supervisor knows when a task is stuck.** `SupervisorTask` gains
`latestFailure: { readonly runKind: 'implementation' | 'review' | 'planning'; readonly reason: string; readonly at: string } | null`
(the newest `run.failed` payload among the task's runs), `deniedKinds: readonly string[]` (the
distinct `capability` values of `run.tool_denied` events across the task's runs), and
`failureCount: number` (failed implementation runs on the task). The loader reads them in two
bounded queries (latest `run.failed` per task via `DISTINCT ON`, denied kinds via `groupBy`), the
`brief.ts` precedent. `taskFacts` carries all three onto every task situation. **Why:** decision 2 —
a remedy chosen without the reason is a coin toss, which is what `unblock_task` was on the audit
task. **Cost if wrong:** two read queries per pass.

**R3 — Diagnosed remedies.** New situation kinds and new actions, all going through `carryOut`:
- `task_failed` (new): a task in `failed` with at least one dependent not `done`. Candidates, in
  order: `retry_task` (new action: `status: 'ready'`, `attempt: 0`, `activeRunId: null`, keeps
  `maxAttempts`) **bundled with a cause remedy when the diagnosis names one** — if `deniedKinds`
  includes a kind the task's `requiredPermissions` (R5) would have granted, or includes
  `network_fetch` for a task whose role is research/marketing/sales, the same decision carries
  `request_permission` for that worker first (one decision, two verbs, applied in order); then
  `escalate_to_human`. A task retried twice this
  way (a new `Task.retries` counter) is not retried a third time: the candidate set is
  `escalate_to_human` only, with the last reason in the summary.
- `review_cap_blocked`: the reason decides. Infrastructure (`maxBuffer`, `could not be read`,
  `spawn`, `ENOENT`, `no valid verdict` with an empty text, adapter/provider refusals):
  `retry_review` (new action: `unblockTask({ retryReview: true })`, which moves the task to
  `reviewing` and stamps `Task.reviewWindowFrom = now` so `dispatchReview` counts review attempts
  since that stamp rather than since the implementation run). A verdict that parsed but was
  unusable, or a reviewer that rejected twice: `unblock_task` (rework) with the reason in the
  steer note. `raise_max_attempts` and `mark_task_failed` stay as today; `escalate_to_human` last.
- `task_blocked_human`: unchanged candidates, but the summary carries `latestFailure.reason`.
- `permission_blocked`: `request_permission`, now applied under `act` by R1. The grant is
  recorded as `by: 'supervisor'`.
- `run_looping`: unchanged (`steer_run`), plus `deniedKinds` in the facts so the steer text can
  say "you are being denied X; do not try it again" (the text builder reads the facts).
**Why:** decision 2. **Cost if wrong:** two actions, one situation, and a counter.

**R4 — The halt has a remedy.** New action `clear_halt` for the existing `workspace_halted`
situation when the halt reason is `circuit_breaker` and the newest failed task now has a
`retry_task` decision applied in the same pass or the previous one (the cause was addressed).
Under `act` it is applied at most once per workspace per hour (`Workspace.haltClearedAt` is the
stamp; a second breaker within the hour escalates); under `propose` it is proposed. Budget halts are
never cleared by the Supervisor. **Why:** the breaker's job is to stop a runaway; once the runaway's
cause is fixed the person's `clear-halt` is ceremony. **Cost if wrong:** one hour of spend at most
before a person is asked.

**R5 — Task needs.** The plan graph task gains `needs?: readonly ('network_fetch' | 'run_commands')[]`
(closed list, validated in `validateStructure`; unknown values are dropped and recorded on the plan
event like unknown capability keys). Stored on `Task.requiredPermissions String[] @default([])`.
The planner prompt gains one line beside the capabilities line: "A task that must read the web
carries `needs: ["network_fetch"]`; one that must run commands beyond the repository's own scripts
carries `run_commands`; most tasks carry neither." `writePermissionsFile` gains `taskGrants:
readonly PermissionKind[]`; `resolveGrants(rows, provider, runKind, taskGrants = [])` adds the task
grants to the baseline **for implementation runs only** (a review judges, it does not fetch); an
explicit `deny` row still wins. `task.started`'s payload lists `grants`. **Why:** decision 3; the
research task's three failures were a permission the planner could have asked for. **Cost if
wrong:** a column and a fourth parameter.

**R6 — Retried tasks adopt their worktree.** `startRun` for a task whose branch already has a
worktree under `.slaveofai/worktrees/` adopts it (`adoptWorktree`) instead of failing with "already
exists (both)"; the run starts on the existing branch. A worktree whose branch is gone is removed
and re-provisioned. **Why:** the by-hand retry on 2026-09-20 died on exactly this. **Cost if wrong:**
a branch with stale work is reused, which is what rework already does.

**R7 — Auto-merge is a switch.** `CreateWorkspaceInput.autoMerge?: boolean` (default `true` for
intake-created projects; `createWorkspace` from the CLI keeps `false` unless `--auto-merge`); the
intake draft gains `autoMerge` (default `true`, a checkbox on the card); a new verb
`setWorkspaceIntegration(workspaceId, { autoMerge }, principal)` emits `workspace.settings_changed`
with field `autoMerge`; the CLI gains `set-auto-merge --workspace <id> --on|--off`; the web PUT
`/api/w/:id/integration` and a toggle in `RuntimePanel`'s runtime section. The README's caveat
(tasks finished before the flip stay unstamped) stays true and is printed by the verb when it turns
the switch on for a workspace with `done` unintegrated tasks. **Why:** decision 4. **Cost if wrong:**
a verb and a checkbox.

**R8 — The feed says what the Supervisor did.** `supervisor.applied` joins `HAPPENING_TYPES`, rendered
as "Supervisor <verb phrase>" with the action's summary; `supervisor.failed` joins too, rendered as
"Supervisor could not <verb phrase>: <reason>". The needs-you bar is unchanged: under `act` it holds
only escalations and questions. **Why:** an autonomous Supervisor a person cannot see is one they
will switch off. **Cost if wrong:** two rows in a list.

**R9 — Nothing else moves.** `decide()`, the planner's graph rules beyond `needs`, review verdict
parsing, the breaker's thresholds, the budget guardrail, the vocabulary gate and every existing
event type are unchanged. New event types: none — `supervisor.applied`/`failed`/`decided` and
`workspace.settings_changed` carry the new facts in their payloads. New tables: none. New columns:
`Workspace.supervisorAutonomy`, `Task.requiredPermissions`, `Task.retries`, `Task.reviewWindowFrom`.

## 2. The autonomy switch, spelled out

| | `propose` (today) | `act` |
|---|---|---|
| hire, materialise, set roles, request permission, adopt runbook, raise attempts | proposed | applied |
| unblock (review cap), steer, release, reassign, assign capability | applied | applied |
| mark failed, cancel task, discard candidates | proposed | applied |
| retry task, retry review (new) | proposed | applied |
| clear halt (new, circuit breaker only) | proposed | applied, once per hour |
| answer a worker's question | proposed → `answerTier` | applied when the draft cites its sources, else proposed |
| escalate to human | escalated | escalated |
| anything while halted (except the breaker halt's own remedies, E11) | proposed | proposed |

## 3. The diagnosis, spelled out

A remedy is chosen from facts the world now carries, not from the model's guess:

| Signal on the task | Reading | First remedy |
|---|---|---|
| `latestFailure.reason` matches infrastructure (`maxBuffer`, `could not be read`, `spawn`, `ENOENT`, adapter refusal) | the system failed, not the worker | `retry_review` / `retry_task` |
| `deniedKinds` non-empty and the task's needs or role imply that kind | the worker was refused a tool it needed | `request_permission` + `retry_task` |
| `latestFailure.reason` is `behavioural_loop` or `run_timeout` and `deniedKinds` empty | the worker is lost | `unblock_task` (rework) with a steer note naming the loop; second time `escalate_to_human` |
| review verdict rejected twice | the work is wrong | `unblock_task` (rework) with the rejection reason |
| `retries >= 2` | remedies are not working | `escalate_to_human` with the whole history in the summary |

The model still chooses among the candidates the rules offer (M38's shape); the rules decide what
is on the menu, and under `act` the choice is carried out.

## 4. Surfaces

- Supervisor panel: the autonomy switch on the scope line; applied actions already appear in the
  thread.
- Home feed: `supervisor.applied` and `supervisor.failed` rows (R8).
- Intake card: two checkboxes, "act on its own" and "merge approved work automatically", both on.
- Project Settings → runtime: the two switches, editable.
- CLI: `supervisor --autonomy`, `set-auto-merge`, and `status` prints both.
- `docs/ia.md` and README: one paragraph each.

## 5. Tests

- Domain: `tierOf` under `act` for every kind (table-driven); `observe` produces `task_failed` with
  the three new facts; `candidates` for each row of §3; `validateStructure` accepts and bounds
  `needs`; `resolveGrants` with task grants (added, deny wins, review ignores them).
- Control: `setSupervisorSettings({ autonomy })` event; `setWorkspaceIntegration` event and the
  unstamped-tasks warning; `unblockTask({ retryReview })` moves to `reviewing` and stamps the window;
  `retryTask` resets; the loader's two new queries; `carryOut` for `retry_task`, `retry_review`,
  `clear_halt` (once per hour).
- Orchestrator: `dispatchReview` counts attempts since `reviewWindowFrom`; `startRun` adopts an
  existing worktree; `concludePlanning` writes `requiredPermissions`; `writePermissionsFile` carries
  task grants and the gate honours them (the fake CLI's deny/allow fixture); the daemon under `act`
  retries a failed task with a network grant end to end (fake CLI: first run denied, second allowed).
- Web: the switch renders and PUTs; the intake card's two checkboxes reach the draft; RuntimePanel's
  toggles; the feed rows.
- Gate: `gate:m38-supervisor` gains one stage: a failed task with a denied network tool, autonomy
  `act`, ends `running` again with `network_fetch` granted and the halt cleared, with no human verb.
- The full ladder, typecheck, `web:build`.

## 6. Out of scope

The Supervisor conversation (F, its own spec), plan-time ownership (D), the two-level planner (B/C),
undo for applied actions (the feed names them; reversal stays a manual verb for now), and any change
to the breaker's thresholds or to what counts as a failure.

## 7. Errata

Written at Task 8, which is where the whole path was driven end to end for the first time. Each
names the task that found it.

**E1 — `task_failed` is extended, not new (Task 3).** R3 calls the situation new; `observe` has
raised it since M38 for a `failed` task with dependents. Task 3 extended the existing predicate with
the new facts rather than adding a second kind that would have fired beside it.

**E2 — R6 is satisfied by the status a retry writes (Task 5).** `retry_task` sets `rework`, and
`acquireWorktree` already adopts an existing worktree for a rework run — so "retried tasks adopt
their worktree" needed no new branch in `startRun`. Its second sentence did need one: a worktree
DIRECTORY with no branch behind it is now removed inside the worktrees dir, pruned and re-provisioned,
and a branch whose directory is gone is reattached.

**E3 — `TaskFailure.at` is epoch ms, and there is a fourth field (Task 2/3).** R2 spells `at` as a
string; it is a number, like every other time in `SupervisorWorld` (`statusSince`, `now`,
`haltClearedAt`), so the rules compare it without parsing. `slaveId` joined the shape in Task 3's fix
round: it is the only place a `retry_task` grant can find the worker to grant to, because
`world.denials` and `world.runs` hold only LIVE runs and a failed task's refused run is in neither.

**E4 — a refusal beats an infrastructure marker (Task 3).** §3's table does not order its rows, and a
real failure line carries both ("the run's output stream ended…" on a run that was refused the web).
`readFailure` reads `denied_tool` first: a gate really did turn this worker away from something the
work needs, and the remedy names it, while an infrastructure string can ride along with anything —
including the message a refused run writes on its way out.

**E5 — `clear_halt` requires an APPLIED `retry_task` newer than the task's latest failure (Task 3).**
R4 says "the newest failed task now has a `retry_task` decision applied"; the first implementation
read the task's STATUS instead, and `releaseTaskAfterFailure` writes `rework` — so a retry that had
failed again looked exactly like a cause that had been addressed, and the breaker became an hourly
speed bump in front of a runaway. The evidence is a pair now: an applied `retry_task` for that task,
and no failure on it since that decision was made.

**E6 — control strips the `steer: ` label before the worker sees it (Task 4).** The `lost` reading's
retry reason begins `steer: ` so the panel and the decision row can say what kind of remedy was
chosen. `retryTask` strips the prefix before storing it on `Task.lastRejectionReason`: the prompt
that carries the note already frames it, and the label after that framing would be machinery in an
instruction.

**E7 — `needs` is nullish-tolerant, deduped and bounded, and a re-plan writes it too (Task 5).** R5
gives the closed list and `validateStructure`'s drop; the parser also reads an absent or null `needs`
as `[]` and bounds what one task may ask for, and `replan.ts` writes `requiredPermissions` for the
tasks a delta adds — without that line, a task the planner added on the second pass would silently
carry none.

**E8 — the `workspace.settings_changed` field enum gained two members (Task 4/6).** R1 and R7 say the
verbs emit that event with fields `supervisorAutonomy` and `autoMerge`; the event schema's field enum
is closed, so `appendEvent` refused both until the two were added to it.

**E9 — `supervisor.applied`/`failed` carry the WHOLE action (Task 8).** R8 asks the feed to say what
the Supervisor did, and `applyDecision` appended `{ kind }` alone — so every sentence degraded to
"the Supervisor retried a task". Both arms carry the action now (`.passthrough()` over the kind
enum, so a row written before this still parses), and `verbPhrase` reads the title, the worker's name
and the operation's label off it. `supervisor.decided`/`proposed` still carry the kind alone: they
are read beside the decision row their `decisionId` points at.

**E10 — `task.unblocked` carries the retry's own facts (Task 8).** `retryTask` has written `reason`,
`retries` and `grant` on the row since Task 4, and the typed event stripped all three — `z.object`
drops what its shape does not name. All three are optional on the arm now; an ordinary human unblock
carries none of them.

**E11 — a CIRCUIT-BREAKER halt does not demote `retry_task` under `act` (Task 8).** R4 makes
`clear_halt` the one exception to "a halted workspace still forces proposals", and it was one action
short: `clear_halt` is offered only once a `retry_task` has been APPLIED to the task the breaker
counted (E5), so a halt that demoted the retry made its own remedy unreachable without a person. On
the project this milestone was written for — a research task refused the web, three failed runs, the
breaker down — `act` escalated twice and moved nothing. The pair travels together now. Nothing else
joins them, and what the two have in common is the line: NEITHER STARTS ANYTHING, because nothing is
scheduled while a workspace is halted. The exception is about the BREAKER, not about halts (fix
round 1): R4 says as much of `clear_halt` — "budget halts are never cleared by the Supervisor" — and
the argument that makes `retry_task` safe beside it is the breaker's own. Under `budget_exhausted`
the money is gone and a queued retry is work that starts the moment somebody raises the budget;
under `emergency_stop` a person has their hand on the switch. Both still propose everything. §2's
last row reads "anything while halted (except the breaker halt's own two remedies)".

**E12 — the pass that answers a halt's cause does not also escalate the halt (Task 8).** R4's "applied
in the same pass or the previous one" could not happen in the same pass: `workspace_halted` is the
last kind `observe` emits, and its catalogue is built from a world read before the pass applied
anything — so a pass that had just retried the breaker's own task still found no evidence, escalated,
and then held that situation key behind the pending row for as long as the escalation lived
(`filterFresh`). `supervise` skips the halt in a pass that has already applied something; the next
pass reads a world that knows what this one did. The condition is exact rather than broad: while a
workspace is halted the only things `tierOf` applies are the halt's own remedies.

**E13 — an autonomous grant says who made it (Task 8).** R3 says the grant is recorded as
`by: 'supervisor'`. `setSlavePermission` appended `actor: 'human'` with `by: null` for every caller,
which was true while `request_permission` — always `proposed` — was the only way in; the grant a
`retry_task` carries under `act` has no approver, and the timeline said a person granted network
access to a worker on a quiet afternoon. `origin` travels with the retry, and the event says `system`
/ `by: 'supervisor'`. An approved proposal is unchanged: the approver is the granter.

**E14 — the hour rule reads two different clocks (Task 8, open).** `candidates` measures
`world.now - world.haltClearedAt` against the tick's clock and `carryOut` measures
`Date.now() - haltClearedAt`, and `clearHalt` stamps `new Date()`. In production these are the same
instant and the rule behaves as R4 states; under a test clock they are not, which is why the
end-to-end test sets `haltClearedAt` explicitly for its third pass rather than relying on what the
second one stamped. Left as it is: threading the tick's clock through `clearHalt` touches the
operator's own verb for a difference no production path can observe.

**E15 — the world does not carry a task's needs, so §3's first clause is dead (Task 8, open).**
R5 puts `needs` on the plan graph, `Task.requiredPermissions` and the implementation run's
permission snapshot, and R3's diagnosis reads "a kind the task's `requiredPermissions` would have
granted" first. `SupervisorTask` never gained the column: `candidates.readTaskFailure` passes `[]`,
so only the ROLE clause (research, marketing, sales, paid-media, support, academic + `network_fetch`)
ever names a refused tool. That is enough for the case this milestone was written for and misses a
backend task that declares `needs: ["run_commands"]` and is refused it — it reads as `unknown` and
gets a bare retry. FOLLOW-UP: one field on `SupervisorTask`, one column in the loader's task query,
and pass it through `readTaskFailure`; the rule and its tests already exist.
