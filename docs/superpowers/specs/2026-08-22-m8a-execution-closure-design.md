# M8a: Execution Closure — Design

**Date:** 2026-08-22
**Parent:** `docs/superpowers/specs/2026-08-17-ai-team-os-design.md` §9 (the loop's Review and
Advance steps), §9.2 (guardrails), §10 (git model and merge queue), D10 (auto-merge through a
serialized queue). M8 is split in two: **M8a** closes the execution path — QA review, the merge
queue, guardrail wiring, emergency stop — with its own gate, *"a task → merged branch,
unattended"*; **M8b** (planning: a goal → task graph) follows separately and completes the
parent's full M8 sentence.
**Builds on:** M3's verify/advance machinery and worktrees, M5's control plane and
kill-on-pause, M7's dependency DAG. The domain layer is already ahead of the wiring:
`evaluateGuardrails` scores all five guardrails (with the 80% budget warning), the task state
machine already carries `verify_passed → reviewing → review_approved → merging`, and
`Workspace.autoMerge` exists defaulted `false`.

## 1. Scope

- **Review stage** — verify green no longer advances straight to `done`: the task enters
  `reviewing` and a **QA review run** (a new run kind) is dispatched to a `reviewer`-role
  agent; a Zod-validated verdict approves (→ `merging` or `done` per `autoMerge`) or rejects
  (→ `rework` with the reason as next-run input).
- **Merge queue** — a daemon tick pass serializing parent §10 verbatim: rebase onto `main`,
  re-verify the merged result, task-keyed revertible merge commit; conflict or red re-verify
  returns the task to `rework` with the detail; repeated failure escalates.
- **Guardrail wiring** — the missing halves only: one-shot `budget_warning` event, budget
  breach pausing all active runs, and the global concurrency count. Timeout, tool cap, attempt
  cap and the circuit breaker are already live and untouched.
- **Emergency stop** — one control operation (`halt` + pause every active run), surfaced as a
  confirmed TopBar STOP button and a CLI command; cleared by the existing `clear-halt`.

Out of M8a: the planning run (M8b), the merge-queue visualization (parent §12.4, later),
notifications, reviewer-specific permission profiles, garbage collection of worktrees.

## 2. Decisions of Record

| Decision | Choice | Rejected alternative |
|---|---|---|
| QA verdict transport | **Structured JSON in the run's final output**, Zod-validated; invalid output is re-requested once, then the review run fails visibly | A verdict file in the worktree; exit-code semantics |
| QA staffing | **A dedicated `reviewer` role**; the demo seed gains one ("Riley"). No reviewer → `guardrail.tripped` escalation, task waits in `reviewing` | Any idle non-author agent; author self-review |
| E-stop surface | **TopBar button (confirm dialog) + CLI command**, both over one control op | CLI only; ⌘K palette |
| Merge executor | **The daemon tick's merge pass** — serialized by construction, claim still a conditioned `updateMany` | A control-package op callable from the web (the queue is autonomous; no web trigger) |
| `autoMerge=false` path | Review still runs; approval → `merging`, where the merge pass concludes `done` without merging (branch left for the human — M3–M7's ending plus the review gate; no state-machine special case) | Skipping review when not auto-merging |

## 3. The Review Stage

### 3.1 Dispatch

On verify green, `advance` records `verify_passed` (task → `reviewing`) and stops. A new tick
pass finds `reviewing` tasks with no active review run and starts one:

- `AgentRun` gains `kind: 'work' | 'review'` (one migration; existing rows backfill `'work'`).
- The run is assigned to an idle agent whose role is `reviewer` — the same role-matching
  `decide()` already uses. The author agent never reviews its own task by construction (roles
  differ).
- No reviewer-role agent in the workspace → emit `guardrail.tripped`
  (`guardrail: 'no_reviewer'`, detail naming the task) once, and the task waits in `reviewing`
  — the empty-verify-commands precedent: escalate to the human rather than assume success.
- The review run works in the task's preserved worktree (read-only intent), prompted with the
  task title/description and the output of `git diff <base>...<branch>`; its instructions ask
  for judgment of the DIFF against the task, not a rebuild.

### 3.2 The verdict contract

The review run's final output must contain one JSON object:

```json
{ "verdict": "approve" | "reject", "reason": "one paragraph" }
```

Zod-validated at the boundary (parent §9's planning-run language: free-form text never reaches
the database). Invalid or missing → ONE re-request message to the same run; a second failure
concludes the review run `failed` and leaves the task in `reviewing` (visible, human-escalated
via the run's failure). New event types: `task.review_started`, `task.review_approved`
(payload `{ reason }`), `task.review_rejected` (payload `{ reason, attempt }`) — the M6/M7
exhaustive maps (kinds + activity cards) extend in the same task, compile-enforced.

### 3.3 Outcomes

- **approve:** record `review_approved` — the state machine moves the task to `merging` in
  every case (no new edges). `autoMerge` is consulted by the MERGE PASS, not here: when it is
  `false`, the pass concludes the task `done` immediately without merging, branch preserved
  for the human (Decision 5) — a no-op queue step rather than a state-machine special case.
- **reject:** the existing rework machinery verbatim — task → `rework`, `attempt` counted, the
  reviewer's `reason` attached as input to the next work run exactly the way verify-red
  feedback already travels. The attempt cap applies unchanged.

## 4. The Merge Queue

A daemon tick **merge pass** (after the start and resume passes, behind the halted-workspace
bail). Serialization is structural — one daemon per workspace — and enforced anyway: the pass
claims a task with a conditioned `updateMany` (`status: 'merging'`, `mergeClaimedAt: null` →
set), so overlapping ticks cannot double-execute. Queue order: FIFO by the `review_approved`
event's seq. One merge at a time per workspace.

Parent §10's steps verbatim:

1. Rebase the task's branch onto `main` in its preserved worktree. Conflict → step 4.
2. Run the workspace's verify commands on the rebased result — **this, not the branch run, is
   the real gate** (two individually-green branches can break `main` together).
3. Green → merge to `main` with a task-keyed `--no-ff` merge commit (revertible in one
   command). Task → `done` (`task.done`, existing payload). The branch and worktree are kept
   (GC is out of scope).
4. Conflict or red re-verify → do NOT merge: clear the claim, task → `rework` with the
   conflict/failure detail as next-run input (the same channel as review rejection). A second
   queue failure for the same task → `guardrail.tripped` + workspace halt (parent's "repeated
   failure escalates to the human").

**Crash recovery:** a task stuck in `merging` with a stale claim and no live daemon work is
returned to `rework` by the startup reconcile pass (detail: "merge interrupted") — the M5
resume-claim orphan pattern applied to tasks. New event type: `task.merge_failed`
(payload `{ reason }`); `task.done` already covers success. Maps/cards extend as always.

## 5. Guardrail Wiring

Only the missing halves — evaluation exists and is untouched:

- **`budget_warning` one-shot:** when the tick's evaluation reports the warning band, emit
  `guardrail.tripped` (`budget_warning`) only if no such event already exists for the
  workspace (one indexed existence query). No per-tick spam.
- **Budget breach pauses runs:** on `budget_exhausted`, in addition to the existing halt,
  request pause on every active run via `requestPause` — M5's kill-on-pause makes that a
  checkpointed stop, resumable after the operator raises the budget and clears the halt.
- **Global concurrency (6):** `loadWorld` gains one cross-workspace active-run count;
  `evaluateGuardrails` gains `globalActiveRuns`/`maxGlobalConcurrentRuns` (default 6) and
  reports a scheduling-halting breach at the cap. Per-workspace 3 already works.

## 6. Emergency Stop

`packages/control` gains `emergencyStop(workspaceId, requestedBy)`:

1. Halt the workspace (`haltedReason: 'emergency stop by <requestedBy>'`) — scheduling stops
   immediately (`evaluate`'s `emergencyStopped` already derives from the halt).
2. Request pause on every active run (`requestPause` per run). Partial failure is tolerated
   and reported in the result (the halt stands regardless); pause refusals for runs already
   concluding are expected noise, not errors.

Cleared by the existing `clear-halt` (CLI and its semantics unchanged). Surfaces:
`POST /api/w/[workspaceId]/emergency-stop` (200/409/404, the house contract) wired to a red
STOP button in the TopBar behind a confirm dialog (the halt banner then shows the state on
every page); and a CLI `emergency-stop --workspace` command reusing the same operation.
Event: `guardrail.tripped` (`emergency_stop`, detail carries the operator) — no new type.

## 7. Testing

TDD throughout; every task's gate is `npm test && npm run typecheck && npm run web:build`.

- **Fake CLI:** gains a `review-verdict` mode (emits a valid verdict JSON; variants for
  invalid-then-valid and never-valid) so review dispatch, parsing, retry and outcomes are
  integration-tested end to end without the real CLI.
- **Integration:** review pass (assignment to the reviewer role, no-reviewer escalation,
  verdict outcomes incl. reject→rework reason travel); merge queue against REAL git repos
  (green merge with task-keyed commit on `main`, rebase conflict → rework with detail,
  post-merge red → rework, interrupted merge → startup recovery, FIFO order, claim
  idempotence under overlapping ticks); budget one-shot + breach-pauses-runs; global
  concurrency; `emergencyStop` (halt + all paused, partial-failure tolerance).
- **Web/component:** the STOP button (confirm → POST → banner), route contract tests.
- **Domain:** new event types join the schema tests; the M6/M7 exhaustive maps force cards
  and kind assignments at compile time.

## 8. Milestone Gate

M8a's bar: **a task → merged branch, unattended.**

- **Measured half (fake adapter):** a script seeds an `autoMerge: true` workspace with a
  worker and a reviewer and ONE ready task, starts the daemon, and asserts with zero human
  input that the task reaches `done` AND the task-keyed merge commit is reachable from `main`
  (`git log`). A second script measures the emergency stop: engage mid-run, assert every
  active run is `paused` and scheduling is halted within a bounded window, then `clear-halt`
  and assert work resumes.
- **By-eyes half (real CLI, the M3–M7 tradition):** watch one real task flow
  work → verify → reviewing → merging → done across the board and graph live; read the QA
  reason in the activity feed; press STOP mid-run and watch everything checkpoint-pause;
  clear the halt and watch it resume. Findings become gate-fix tasks.
