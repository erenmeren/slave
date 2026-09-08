# M35 Pipeline Honesty Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the execution pipeline tell the truth about two things before a Supervisor is ever built on top of it: a task that failed mid-run must not strand forever, and a task marked `done` must not unblock dependents whose code is not actually integrated.

**Why now:** the Supervisor milestones (M36+) will report completion and schedule dependent work from exactly these two signals. A Supervisor built on a pipeline where `done` can mean "not merged" and where a crashed run silently parks a task in `running` would confidently report finished work that does not exist. This milestone is the foundation, not a feature.

**Architecture:** no new subsystems. One additive column (`Task.integratedAt`), one new control verb, and one new conclusion path reusing the existing `releaseTaskAfterFailure` helper.

**Tech Stack:** TypeScript, Prisma 7 (one additive migration), Next.js app router, vitest.

**Spec:** none — design approved in chat 2026-09-08 (this file is the record). The integration-stamp shape was chosen by the user over branch-chaining and over a documentation-only fix.

## Global Constraints
- No behaviour change beyond the two named defects. A workspace with `autoMerge` on, and any task with no dependents, must behave exactly as it does today.
- Manual workflows must keep working: `autoMerge: false` still marks the task `done` and still leaves the branch and worktree for a human. Only the dependency gate and a new stamp change.
- Reuse `releaseTaskAfterFailure` (`apps/orchestrator/src/tick.ts`) rather than writing a second release path; every task write stays guarded on `activeRunId` so a concurrent sweep/cancel cannot be overwritten.
- Never let a task be released twice or an attempt charged twice (the gate-hook path at `apps/orchestrator/src/pump.ts:847` already increments in its own case).
- One vitest at a time (shared test DB). `npm run --silent typecheck`. `npm run web:build` last for web tasks, never while `next dev` runs. Vocabulary gate: the word is `slave` everywhere it is ours.
- Commit trailer: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File structure
```
apps/orchestrator/src/verify.ts      (conclude a failed run: release + charge)
apps/orchestrator/src/tick.ts        (export/extract releaseTaskAfterFailure if needed)
apps/orchestrator/test/integration/  (failed-run release cases)
packages/db/prisma/schema.prisma + migrations/20260908120000_m35_integrated_at/migration.sql
apps/orchestrator/src/merge.ts       (stamp integratedAt on a real merge)
apps/orchestrator/src/world.ts       (dependency gate reads the stamp)
packages/control/src/task.ts (or wherever task verbs live)  confirmIntegration
apps/orchestrator/src/cli.ts         confirm-integration verb
apps/web/                            a marker that a done task is not integrated
scripts/gate-m35-pipeline-honesty.mjs, package.json, ci.yml, README
```

---

### Task 1: A run that fails mid-execution releases its task

**The defect (verified 2026-09-08 at 9123985):** `pump.ts`'s conclusion writes `SlaveRun.status = 'failed'` terminal and emits `run.failed`, but touches no `Task`. The chained `verifyConcludedRun` (`verify.ts:186`) returns immediately unless the run `succeeded`. `sweep.ts` only acts on NON-terminal runs (`ORPHANABLE`/`SWEEPABLE` both derive from `NON_TERMINAL_RUN_STATUSES`). So the `Task` keeps `status: 'running'` and `activeRunId` pointing at a terminal failed run, forever; `decide()`'s `STARTABLE = ['ready','rework']` never picks it up again. No attempt is charged. The task is permanently stranded.

**Files:** `apps/orchestrator/src/verify.ts` (a `concludeFailedRun`-shaped path, or a branch inside `verifyConcludedRun` before its `succeeded` guard — pick whichever reads better and say why in the report), `apps/orchestrator/src/tick.ts` (`releaseTaskAfterFailure` is currently module-private; export it or move it to a shared module — do NOT copy it), tests in `apps/orchestrator/test/integration/`.

**Behaviour required:**
- An `implementation` run concluding `failed` releases its task with one attempt charged, parked `rework` (or `failed` when attempts are exhausted) — exactly what `concludeFailedResume` already does for a failed resume.
- Guarded on `activeRunId = run.id` so a cancel/sweep that got there first is not overwritten, and idempotent: calling the path twice charges one attempt.
- **Check every run kind.** A `planning` run has no task (guard already exists). A `review` run that fails leaves the task in `reviewing` with `activeRunId` set — determine whether that strands too and handle it consistently; say what you found. Same question for a `verify`-kind run if one exists.
- Do not double-charge with the gate-hook increment at `pump.ts:847`; read that path first and state how you avoided it.

- [ ] Tests first: a failing implementation run leaves the task retryable with exactly one attempt charged (RED today: the task stays `running`); a second call charges nothing more; a cancel that won the race is not overwritten; the review-kind case per your finding.
- [ ] Implement → the covering orchestrator test files one at a time → `npm run --silent typecheck`.
- [ ] Commit `fix(orchestrator): m35 t1 — a run that fails mid-execution releases its task instead of stranding it`.

---

### Task 2: `done` does not unblock dependents until the work is integrated

**The defect:** `merge.ts` marks a task `done` with no git merge when `workspace.autoMerge` is false (deliberate, spec Decision 5), and `world.ts`'s gate is `dep.status <> 'done'`. So a dependent task is scheduled and provisioned from `workspace.baseBranch` while the dependency's commits sit on an unmerged branch.

**Files:** `packages/db/prisma/schema.prisma` (`Task.integratedAt DateTime?`) + migration `20260908120000_m35_integrated_at/migration.sql` (additive, nullable, no backfill of NULL→now for tasks that were never merged; DO backfill `integratedAt = updatedAt` for tasks already `done` in a workspace whose `autoMerge` is true, so an existing board does not freeze — state in the migration comment why), `apps/orchestrator/src/merge.ts` (the real-merge path stamps `integratedAt`; the `!autoMerge` path leaves it null), `apps/orchestrator/src/world.ts` (gate becomes `dep.status = 'done' AND dep."integratedAt" IS NOT NULL`), a control verb `confirmIntegration(taskId, principal?)` in `packages/control` (refuses unless the task is `done` and not already stamped; emits an event; follows the refusal/`Result` idiom of its neighbours), `apps/orchestrator/src/cli.ts` (`confirm-integration --task <id>`, usage text), and a minimal web marker: a done task whose `integratedAt` is null reads as awaiting integration (find the task row/table component; do NOT redesign anything).

**Interfaces:** `confirmIntegration` returns the same `Result<…, ControlRefusal>` shape as its neighbours; refusal kinds reuse existing ones where they fit (`task_not_found`, and an appropriate conflict kind for "already integrated" / "not done yet" — add one only if none fits).

- [ ] Duplicate/consistency check first: how many `done` tasks exist in the dev and test DBs, and how many are in `autoMerge` workspaces — report the numbers before writing the migration.
- [ ] Tests first (control: the verb's happy path and both refusals; orchestrator: an auto-merged task stamps and unblocks its dependent, a hand-merge task does NOT unblock until confirmed, a task with no dependents is unaffected) → `npm run db:generate && npm run db:migrate && npm run db:migrate:test` → implement.
- [ ] Covering test files one at a time → `npm run --silent typecheck` → vocabulary gate → `npm run web:build`.
- [ ] Commit `feat(db,control,orchestrator,web,cli): m35 t2 — done means reviewed, integrated means dependents may start`.

---

### Task 3: Gate, README, verification
**Files:** `scripts/gate-m35-pipeline-honesty.mjs` (browser + CLI, no daemon model calls: a workspace with `autoMerge` off, two tasks where B depends on A, drive A to `done`, assert B is NOT dispatched, run `confirm-integration --task A`, assert B becomes dispatchable; copy the skeleton of `gate-m11-shell.mjs` for the repo/workspace setup), `package.json` `gate:m35-pipeline-honesty`, `.github/workflows/ci.yml`, README (the "done vs integrated" sentence and the new CLI line).
- [ ] Full verification: typecheck, vocabulary, `npx vitest run` (full), `web:build`, gates m35, m11, m29, m33.
- [ ] Commit `test(gates),docs: m35 t3 — gate:m35-pipeline-honesty; README`.
