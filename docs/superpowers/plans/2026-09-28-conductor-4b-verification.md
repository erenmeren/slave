# Conductor, Plan 4b of 5: nothing reaches the base branch until every requirement is verified

> **For workers carrying this out:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec R8 (a `verification` run by a seat that implemented nothing in the goal version, in a fresh worktree of the integration branch, writing its own checks in `$SLAVEOFAI_VERIFY_DIR`, reporting `<slave-verification>`, stored as `VerificationResult` rows), R9's gate and loop (all `pass` accepts; a `fail` reworks exactly the owning package with the verifier's evidence; `unverifiable` blocks; `verificationRoundCap` and the budget end the loop in `needs_human`), R11's `verification_failed` (informational) and `goal_needs_human`, and §5's default: new projects are `conducted`.

**Architecture:** Plan 4a's goal pass gains a step: a goal version whose packages are all integrated gets a verification run instead of being accepted. The run is task-less (`SlaveRun.taskId` null, like planning), linked to its `GoalDelivery` by `SlaveRun.goalDeliveryId` and claimed by `GoalDelivery.activeRunId`. Its worktree is a detached checkout of the integration branch; its permissions reuse Plan 3's gate unchanged (a `verification` run kind whose baseline includes `write_repo`, confined by an ownership rule that owns nothing inside the worktree); its scratch directory lives under the run's state directory and reaches the child as `$SLAVEOFAI_VERIFY_DIR`. Its conclusion checks the worktree was not changed, parses the tag in a pure domain parser, stores the evidence, and moves the delivery: `accepted` (then Plan 4a's final merge), back to `integrating` with the failing packages' tasks in `rework`, or `needs_human`. The Supervisor's world gains the goal deliveries and their latest verification.

**Tech Stack:** TypeScript monorepo (npm workspaces, ESM, `.js` import suffixes), Prisma/Postgres, git worktrees, bash hook plane (unchanged), vitest, Next.js (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-09-27-conductor-supervisor-design.md` (R8, R9, R11's two situations, §5 bullet 1, R5's last sentence). **Requires Plan 4a** (`2026-09-28-conductor-4a-integration-branch.md`) merged first. Plan 5 = R10 (the report page and export).

## Decisions this plan makes (read before starting)

- **D1. The verifier's write confinement reuses Plan 3's gate, with no hook-plane change.** A new permission run kind `verification` has the baseline `read_repo`, `write_repo`, `run_commands`, and every verification run's permissions file carries `ownership: { worktreeRoot: <verification worktree>, owned: [], excluded: [] }`: `Write`/`Edit`/`NotebookEdit` on any path inside the worktree are denied (`foreign_file`), and a path outside it is not judged (Plan 3 D4) — the scratch directory is outside it. `scripts/lib/permissions.sh` and its m56a digest do not move. A shell can still write anywhere, so the conclusion checks the worktree: a tracked file changed or `HEAD` moved means the verification is thrown away (D7). Spec R8 says "write only the scratch directory"; outside the repository the gate judges nothing for any run kind today, and narrowing that is a hook-plane change for Plan 5 if it is ever needed. *Cost if wrong:* a verifier can write outside the repository (as every worker can today); it cannot change what it verifies.
- **D2. `$SLAVEOFAI_VERIFY_DIR` is `<runDir>/verify`**, created by the orchestrator for verification runs only; the adapters export the variable exactly when that directory exists (`verifyDirIfPresent(runDir)`). A resumed run finds the same directory under the same run directory, so no `Checkpoint` column is needed (M18's rule: a checkpoint field needs a Prisma column). The checks stay after the run: they are the evidence's source, next to the permissions file. *Cost if wrong:* one `existsSync` per spawn.
- **D3. A verification run is task-less.** `taskId` null (every release path already skips a null task — sweep, resume failure, abandon), `goalDeliveryId` set, claimed by `GoalDelivery.activeRunId` (the `Task.activeRunId` idiom: a unique column, claim with `updateMany where activeRunId: null`). A claim whose run is terminal with no pump in this process (a daemon restart, the orphan pass) is released or concluded by the goal pass (D7).
- **D4. The verifier seat holds runtime role `verifier` and implemented nothing in the goal version** (no `implementation` run on any task of that version). Intake staffs it for a conducted project (its reviewer seat, with `verifier` added — reviewing is not implementing); the conductor ensures one at conduct time (`staffVerifier`: an open seat already holding `verifier`, else an open reviewer seat that holds no package of this version, else a new seat hired from the first package's persona) and records it on the delivery; dispatch re-staffs only when that seat is gone or ineligible. `staffPackages` never reuses a seat holding `verifier`. Verification runs get the persona's profile but no skills or workflow sections (spec R6 names implementation, rework and review runs). *Cost if wrong:* a hire per goal version on a workspace with no reviewer.
- **D5. A verification rework does not charge `Task.attempt`.** The loop is bounded by `Workspace.verificationRoundCap` (default 3; spec R9); charging the task's implementation attempts too would fail a package that needed two tries to pass review on its first verification failure. The task goes `done → rework` with `integratedAt` cleared and the verifier's check, output and reason as `lastRejectionReason` (the channel verify and review use); the `task.rework` event's `attempt` is widened to allow 0 and gains `verificationRound`. A failing requirement whose owning task is not `done` (cancelled, failed) cannot be reworked, and ends the version in `needs_human`.
- **D6. `unverifiable` blocks acceptance.** With no `fail` in the round, the version goes `needs_human` at once (another round would ask the same question); with a `fail`, the failing packages are reworked and the next round asks again. Every `unverifiable` item is stored and shown.
- **D7. A verification run that produced no usable verdict is not a round.** No or malformed `<slave-verification>`, a changed worktree, a process failure, a stranded claim: the run is failed, the claim released, `GoalDelivery.roundRunFailures` incremented, and the same round is dispatched again; at `VERIFICATION_RUN_RETRY_CAP` (3) the version goes `needs_human`.
- **D8. The budget ends the loop through the existing guardrail.** `budget_exhausted` halts the workspace and pauses active runs (a verification run included); the version keeps its state and continues when the person raises the budget. It is not flipped to `needs_human`: the halt is already in front of the person, and raising the budget is the remedy. *Cost if wrong:* a version stopped by budget reads `verifying`/`integrating`, not `needs_human`, in `goal-status`.
- **D9. `retry-goal` moves a `needs_human` version back** to `integrating` and gives it a fresh round window (`roundBase = round`, run failures reset), with event `workspace.goal_retried`. Its failing packages, if any, are already in `rework`; an all-integrated version is verified again on the next tick. There is no "accept anyway" (ruling 5: nothing merges until every requirement is verified); a person who wants the work merges the integration branch by hand.
- **D10. `verification_failed` is informational; `goal_needs_human` escalates.** `chooseByRules` picks `no_action` for `verification_failed` (the loop is already acting: its packages are in rework). `goal_needs_human` is raised for a `needs_human` version and for an accepted version whose final merge failed (`mergeError`, Plan 4a D9); its candidates are `escalate_to_human` and `no_action`.
- **D11. New projects are conducted by default through `createWorkspace`; the Prisma column default stays `planned`.** 139 test files insert `Workspace` rows directly and rely on `planned`; the product's creation paths (CLI `create-workspace`, the web API route, intake accept) all go through `createWorkspace`, which now writes `conducted` unless told otherwise. `--delivery planned` on the CLI and `delivery: 'planned'` on an intake draft opt out; gates that exercise the planner pass it. Existing projects keep their value (spec §5).
- **D12. One detached verification worktree per run** (`<worktreeRoot>/verify-<run8>`, `git worktree add --detach`), setup commands run in it, removed when the run concludes. The integration branch stays checked out only in Plan 4a's integration worktree.
- **D13. A report question whose task can no longer use the answer is no longer pending** (deferred Plan 2 item, folded in because Task 7 edits the loader): the Supervisor's world drops a `<slave-report>` question (`report:` idempotency key) whose task is `failed`/`cancelled` or whose goal version is `accepted` or `abandoned`, so `unanswerable_question` stops firing for it.
- **Left out on purpose:** the m54/m55 gates' pinned `SITUATION_KINDS` counts and world keys (frozen, red on main, and Plans 2–3 left them — deferred Plan 2 item stays deferred); a remedy for a package that must change a shared file (Plan 4a D11); re-verifying the tree after the final merge (Plan 4a D9).

## Global Constraints

- Vocabulary: the product says "slave", never "agent" (`node scripts/gate-m26-vocabulary.mjs`). Never write the string "agency-agents" anywhere tracked.
- Never run prettier (no config in the repo). Match surrounding code: WHY doc comments, `readonly`, explicit return types, `.js` import suffixes, `Result`/`ok`/`err`.
- Tests: `set -a; . ./.env; set +a; export DATABASE_URL=$TEST_DATABASE_URL` in the shell first. ONE vitest process at a time. Iterate per file; `npm run typecheck` (it also checks every `tsconfig.test.json` and `apps/web`) before every commit; the whole suite once, at the end, in the background.
- `apps/web` changes gate on `npm run web:build` (no `next dev` running; `rm -rf apps/web/.next` afterwards).
- Never touch the dev DB. Never `db:seed`. Gates only on `DATABASE_URL="$GATE_DATABASE_URL"` with the fake-CLI env exactly as `.github/workflows/ci.yml` sets it (`SLAVEOFAI_CLAUDE_BIN`/`SLAVEOFAI_CURSOR_BIN` from `scripts/gate-fakes`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`) under `systemd-inhibit --what=sleep:idle`. Red on main today, not regressions: m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58.
- Migrations: hand-written, purely additive, WHY header, dated name; `npm run db:generate && npm run db:migrate:test`.
- Inside a Prisma interactive transaction a refusal must THROW to roll back; a returned value commits what was written.
- `vi.spyOn` on a Prisma delegate breaks later tests: assign a wrapper and restore in `finally`.
- Never `TRUNCATE "SlaveTemplate" CASCADE` in a test; delete your own template rows by id.
- The hook plane (`scripts/pause-gate.sh`, `scripts/cursor-shell-gate.sh`, `scripts/tool-result-tap.sh`, `scripts/lib/pause-flag.sh`, `scripts/lib/permissions.sh`) does not change in this plan; m56a stage 12 pins their digests.
- Every commit message ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec R8 verbatim: "A new run kind `verification`, dispatched once every package of the goal version is integrated into the goal version's **integration branch** (R9), and again after each rework round, in a fresh worktree of that branch, by a verifier seat that implemented nothing in this goal version. Prompt: the requirement set, the integrated diff summary, the rule "for each requirement write a check (command, script or test) in the scratch directory `$SLAVEOFAI_VERIFY_DIR` outside the repository, run it, and report". Permissions: read the repository, run commands, write only the scratch directory. Output `<slave-verification>{ "items": [{ "key", "status": "pass|fail|unverifiable", "check", "output", "reason" }] }</slave-verification>`; stored as `VerificationResult` rows with the check text and trimmed output (evidence)."
- Spec R9 verbatim: "A goal version is `accepted` only when every requirement is `pass` in the latest verification. A `fail` sends its owning package's task back to `rework` with the verifier's check, output and reason (the same rework channel verify and review use); `unverifiable` is surfaced to the person in the report and blocks acceptance (the hard gate). Rounds are capped by the mode's `reviewRetryCap`-like `verificationRoundCap` (default 3) and by the budget; when a cap ends the loop the goal version ends `needs_human` with the report."

## Review Focus

- A verifier that "fixes" the code through the shell so its check passes: the conclusion finds a changed tracked file (or a moved `HEAD`), throws the verification away without accepting, retries the round, and removes the worktree (Task 6 test).
- A verification run paused (budget, a person) and resumed keeps its confinement — the rewritten permissions file still carries the empty ownership rule — and still sees `$SLAVEOFAI_VERIFY_DIR` (Task 5 test).
- The daemon dies mid-verification: the orphan pass fails the run with `taskId` null (nothing released), and the next goal pass releases the stranded claim and dispatches the same round again, counting one run failure (Task 6 test).
- A `<slave-verification>` that repeats a key, omits one, invents one, says `fail` with no reason, or is cut off mid-JSON: the run fails with a sentence naming what was wrong, the round is retried, and three in a row end in `needs_human` (Task 3 + Task 6 tests).
- A failing requirement owned by a package whose task was cancelled: the version goes `needs_human` naming the key, never loops (Task 6 test).

---

### Task 1: The verification's data, events and situations

**Files:**
- Create: `packages/db/prisma/migrations/20260929120000_verification/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (`GoalDeliveryStatus` + 2, `GoalDelivery` columns, `Workspace.verificationRoundCap`, `enum VerificationStatus`, `model VerificationResult`, `EventType` + 4, `SupervisorSituationKind` + 2)
- Modify: `packages/db/src/enums.ts`, `packages/domain/src/events/schema.ts` (4 variants; `task.rework` payload widened)
- Modify: `packages/domain/src/conduct/constants.ts` (constants below)
- Modify: `packages/domain/src/supervisor/situations.ts` (`SITUATION_KINDS` + 2 with doc comments, `SITUATION_LABEL` + 2, the "twenty-two" count comment → twenty-four)
- Modify: `packages/domain/src/supervisor/timeline.ts` (`LANE_BY_TYPE` + 4)
- Modify: `apps/web/src/components/activity/cards.tsx` (4 cards; `TaskReworkCard` shows the verification round), `apps/web/src/lib/activityFilters.ts`, `apps/web/src/server/timeline.ts`
- Modify: `apps/orchestrator/src/goal.ts`, `packages/control/src/goalDelivery.ts` (widen status unions only)
- Modify: `scripts/gate-m56a-provider-contract.mjs` (stage 12: `SITUATION_KINDS` 22 → 24, `LANE_BY_TYPE` 69 → 73, comment)
- Test: `packages/domain/test/events/conductor-events.test.ts`, `packages/domain/test/supervisor/timeline.test.ts` (69 → 73), `packages/domain/test/supervisor/labels.test.ts`, `apps/web/test/activity-cards.test.tsx`, `packages/db/test/integration/enum-parity.test.ts` (stays green)

**Interfaces:**
- Produces (Prisma): `GoalDeliveryStatus { integrating verifying accepted needs_human abandoned }`; `GoalDelivery` gains `round Int @default(0)`, `roundBase Int @default(0)`, `roundRunFailures Int @default(0)`, `activeRunId String? @unique`, `needsHumanReason String?`, `verifierSlaveId String?`, `results VerificationResult[]`; `Workspace.verificationRoundCap Int @default(3)`; `enum VerificationStatus { pass fail unverifiable }`; `model VerificationResult { id, workspaceId, goalDeliveryId, goalVersion Int, round Int, runId String, key String, status VerificationStatus, check String, output String, reason String, createdAt; @@unique([runId, key]); @@index([goalDeliveryId, round]) }` (cascade from `Workspace` and `GoalDelivery`; `runId` is a plain column in this task — Task 2 adds the `SlaveRun` relation with the run kind).
- Produces (events): `workspace.verification_started { version, round, runId }`; `workspace.verified { version, round, runId, pass: int≥0, fail: int≥0, unverifiable: int≥0, failedKeys: string[] ≤60 }`; `workspace.goal_needs_human { version, reason: string ≤2000 }`; `workspace.goal_retried { version, round: int≥0 }`. `task.rework` payload becomes `{ reason: string, attempt: int ≥ 0, verificationRound?: int > 0 }`.
- Produces (situations): `verification_failed` (label `'A verification round failed'`), `goal_needs_human` (label `'A goal needs you'`), after `conduct` in `SITUATION_KINDS`.
- Produces (constants, `@slave-of-ai/domain`): `VERIFIER_ROLE = 'verifier'`, `VERIFICATION_RUN_RETRY_CAP = 3`, `VERIFICATION_ROUND_CAP_DEFAULT = 3`, `VERIFICATION_CHECK_MAX_CHARS = 8000`, `VERIFICATION_OUTPUT_MAX_CHARS = 4000`, `VERIFICATION_REASON_MAX_CHARS = 2000`, `VERIFICATION_DIFF_STAT_MAX_CHARS = 20_000`, `VERIFICATION_REWORK_MAX_CHARS = 6000`, `SLAVE_VERIFICATION_TAG = 'slave-verification'`.

- [ ] **Step 1: Migration**

`packages/db/prisma/migrations/20260929120000_verification/migration.sql`:
```sql
-- Conductor Plan 4b (spec R8, R9, R11), 2026-09-29: nothing reaches the base branch until every
-- requirement is verified.
--
-- A goal version whose packages are integrated is verified by a run of its own (`verifying`); its
-- per-requirement evidence is `VerificationResult` (the check the verifier wrote, its trimmed
-- output, the reason). `round` counts verification rounds, `roundBase` is where the round cap
-- counts from after a person's `retry-goal`, `roundRunFailures` counts verification runs of the
-- current round that produced no usable verdict. `activeRunId` is the claim on the live
-- verification run. `needs_human` is where a cap ends the loop. PURELY ADDITIVE: enum values
-- unused inside this transaction (Postgres 12+ rule for `ADD VALUE`), nullable or defaulted columns,
-- one enum type, one table.

ALTER TYPE "GoalDeliveryStatus" ADD VALUE IF NOT EXISTS 'verifying';
ALTER TYPE "GoalDeliveryStatus" ADD VALUE IF NOT EXISTS 'needs_human';

ALTER TABLE "GoalDelivery" ADD COLUMN "round" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GoalDelivery" ADD COLUMN "roundBase" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GoalDelivery" ADD COLUMN "roundRunFailures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "GoalDelivery" ADD COLUMN "activeRunId" TEXT;
ALTER TABLE "GoalDelivery" ADD COLUMN "needsHumanReason" TEXT;
ALTER TABLE "GoalDelivery" ADD COLUMN "verifierSlaveId" TEXT;
CREATE UNIQUE INDEX "GoalDelivery_activeRunId_key" ON "GoalDelivery"("activeRunId");

ALTER TABLE "Workspace" ADD COLUMN "verificationRoundCap" INTEGER NOT NULL DEFAULT 3;

CREATE TYPE "VerificationStatus" AS ENUM ('pass', 'fail', 'unverifiable');

CREATE TABLE "VerificationResult" (
    "id"             TEXT NOT NULL,
    "workspaceId"    TEXT NOT NULL,
    "goalDeliveryId" TEXT NOT NULL,
    "goalVersion"    INTEGER NOT NULL,
    "round"          INTEGER NOT NULL,
    "runId"          TEXT NOT NULL,
    "key"            TEXT NOT NULL,
    "status"         "VerificationStatus" NOT NULL,
    "check"          TEXT NOT NULL,
    "output"         TEXT NOT NULL,
    "reason"         TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VerificationResult_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "VerificationResult_runId_key_key" ON "VerificationResult"("runId", "key");
CREATE INDEX "VerificationResult_goalDeliveryId_round_idx" ON "VerificationResult"("goalDeliveryId", "round");
ALTER TABLE "VerificationResult" ADD CONSTRAINT "VerificationResult_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationResult" ADD CONSTRAINT "VerificationResult_goalDeliveryId_fkey" FOREIGN KEY ("goalDeliveryId") REFERENCES "GoalDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.verification_started';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.verified';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.goal_needs_human';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.goal_retried';

ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'verification_failed';
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'goal_needs_human';
```
Mirror all of it in `schema.prisma` with `///` doc comments in the file's style (the `GoalDelivery` and `EventType` entries Plan 4a wrote are the pattern; `SupervisorSituationKind` entries after `conduct`). `npm run db:generate && npm run db:migrate:test`.

- [ ] **Step 2: Failing tests**
  - `conductor-events.test.ts`: each new event parses with a valid payload; `workspace.verified` with 61 `failedKeys` is refused; `task.rework { reason: 'x', attempt: 0, verificationRound: 2 }` parses; `task.rework { reason: 'x', attempt: -1 }` is refused; the old `{ reason, attempt: 2 }` still parses.
  - `timeline.test.ts`: length 69 → 73.
  - `labels.test.ts`: the `SITUATION_LABEL` key test already iterates `SITUATION_KINDS`; add expectations `SITUATION_LABEL.verification_failed === 'A verification round failed'` and `SITUATION_LABEL.goal_needs_human === 'A goal needs you'`.
  - `activity-cards.test.tsx` `PAYLOAD_BY_TYPE` + 4:
```ts
  'workspace.verification_started': { version: 1, round: 1, runId: 'r1' },
  'workspace.verified': { version: 1, round: 1, runId: 'r1', pass: 1, fail: 1, unverifiable: 0, failedKeys: ['R2'] },
  'workspace.goal_needs_human': { version: 1, reason: 'the verification round cap (3) was reached' },
  'workspace.goal_retried': { version: 1, round: 3 },
```
    and a `task.rework` case with `verificationRound: 2` that renders the text `verification round 2`.

- [ ] **Step 3: Run to see them fail.**

- [ ] **Step 4: Implement**
  - Constants in `conduct/constants.ts`, each with a one-line WHY (e.g. `VERIFICATION_OUTPUT_MAX_CHARS`: "the evidence a person reads; a test run's full log stays in the scratch directory").
  - The four zod variants after Plan 4a's `workspace.goal_abandoned`; widen `task.rework`:
```ts
    payload: z.object({
      reason: z.string(),
      // Conductor Plan 4b (D5): a verification rework charges no attempt, so it carries the task's
      // CURRENT attempt, which is 0 for a package that passed verify and review first time.
      attempt: z.number().int().nonnegative(),
      verificationRound: z.number().int().positive().optional(),
    }),
```
  - `SITUATION_KINDS` after `'conduct'`:
```ts
  /**
   * Conductor Plan 4b (spec R11, R9): a goal version's verification round found requirements not
   * met, and their packages are back in rework. INFORMATIONAL: the loop is already acting, so the
   * rules record `no_action` (plan D10). `subjectId` is `<workspaceId>:v<n>:r<round>`, so every
   * round is its own decision.
   */
  'verification_failed',
  /**
   * Conductor Plan 4b (spec R11, R9): a goal version's loop ended without acceptance -- a cap, an
   * unverifiable requirement, a failing requirement nobody can rework -- or its final merge into the
   * base branch failed. `subjectId` is `<workspaceId>:v<n>`.
   */
  'goal_needs_human',
```
  - `LANE_BY_TYPE`: `verification_started` → `'work'`, `verified` → `'verified'`, `goal_needs_human` → `'decision'`, `goal_retried` → `'user_request'` (a person's call), one-line comment each.
  - Web: four cards in Plan 4a's card shape (`verification_started`: "verifying goal vN, round R", idle; `verified`: "goal vN round R: P passed, F failed, U unverifiable" with `failedKeys` listed, tone by `fail + unverifiable > 0`; `goal_needs_human`: "goal vN needs you: <reason>", the danger/attention tone the guardrail card uses; `goal_retried`: "goal vN retried after round R", idle); `TaskReworkCard` appends ` (verification round ${n})` when `verificationRound` is present; filters: the four under `workspace`; `titleFor` cases for the three on a lane (`verification_started`: `verifying goal vN (round R)`, `verified`: `verified goal vN round R: F failed`, `goal_needs_human`: `goal vN needs a person`, `goal_retried`: `retried goal vN`).
  - Widen the `status` unions in Plan 4a's `goal.ts`/`goalDelivery.ts` (`GoalDeliveryView['status']`) to the five values.
  - m56a stage 12: `22` → `24` ("twenty-four"), `69` → `73`; comment: "Conductor Plan 4b added the `verification_failed` and `goal_needs_human` situations and four events: `workspace.verification_started`, `workspace.verified`, `workspace.goal_needs_human`, `workspace.goal_retried`."

- [ ] **Step 5: Run** the domain tests, `enum-parity.test.ts`, the web tests (`activity-cards`, `activityFilters`, `activity-filterbar`), `npx vitest run packages/domain/test/supervisor` (policy tests loop over every situation kind — they must stay green with the two new kinds), `npm run typecheck`, `npm run web:build && rm -rf apps/web/.next` → PASS.

- [ ] **Step 6: Commit** — `feat(conductor): verification results, the goal's loop state, its events and two situations`.

---

### Task 2: A `verification` run kind, its permissions and its scratch directory

**Files:**
- Create: `packages/db/prisma/migrations/20260929130000_verification_run/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (`RunKind` + `verification`; `SlaveRun.goalDeliveryId` + relation; `VerificationResult.run` relation)
- Modify: `packages/domain/src/permission/kinds.ts` (`PERMISSION_RUN_KINDS`, `BASELINE_GRANTS`, the pin comment)
- Modify (type widenings the new Prisma member forces — every one listed by the build; the known set): `packages/domain/src/run-context/sections.ts:201` (`Manifest.kind`) and `:354` (manifest zod enum), `packages/domain/src/run-context/render.ts` (`SECTION_ORDER.verification: ['profile']` for now — Task 3 adds its two sections — and the trailer: a new `export const VERIFICATION_INSTRUCTIONS` beside `REVIEW_VERDICT_INSTRUCTIONS`, with its final text from Task 3's Step 3, chosen when `kind === 'verification'`), `packages/domain/src/breaker/detect.ts:103`, `packages/domain/src/supervisor/world.ts:34,80`, `packages/control/src/stats.ts:247`, `packages/control/src/evidence.ts:250`, `apps/orchestrator/src/tick.ts:589` (`concludeFailedResume`), `apps/orchestrator/src/sweep.ts:548` (`|| run.kind === 'verification'` beside `planning`), `:1065,1401,1488`, `apps/orchestrator/src/abandon.ts:36`, `apps/web/src/server/tasks.ts:21` (`TaskRunKind`)
- Modify: `packages/providers/src/runtime/process.ts` (`verifyDirPathFor`, `verifyDirIfPresent`, `buildChildEnv`'s `verifyDir`), `packages/providers/src/claude/adapter.ts` (both `buildChildEnv` calls), `packages/providers/src/cursor/adapter.ts` (`workerEnv`)
- Create: `scripts/fixtures/m56a-goldens/permissions-{claude_code,cursor}-verification-{baseline,granted}.json` (4 files, generated — Step 4); Modify: `scripts/fixtures/m56a-goldens/README.md`, `scripts/gate-m56a-provider-contract.mjs` (stage 2: `compared !== 12` → `16`, "twelve" → "sixteen")
- Test: `packages/domain/test/permission/kinds.test.ts`, `packages/control/test/permission-mapping.test.ts`, `packages/domain/test/run-context/render.test.ts`, `packages/providers/test/child-env.test.ts` (or the file testing `buildChildEnv` — `grep -rln "buildChildEnv" packages/providers/test apps/orchestrator/test`), `apps/orchestrator/test/integration/sweep.test.ts` (helper param types)

**Interfaces:**
- Produces: `RunKind.verification`; `SlaveRun.goalDeliveryId String?` (`goalDelivery GoalDelivery? @relation(fields: [goalDeliveryId], references: [id], onDelete: SetNull)`); `PERMISSION_RUN_KINDS = ['implementation', 'review', 'planning', 'verification']`; `BASELINE_GRANTS.verification = ['read_repo', 'write_repo', 'run_commands']`.
- Produces (`@slave-of-ai/providers`): `export function verifyDirPathFor(runDir: string): string` → `join(runDir, 'verify')`; `export function verifyDirIfPresent(runDir: string): { readonly verifyDir?: string }`; `buildChildEnv` input `readonly verifyDir?: string` → env `SLAVEOFAI_VERIFY_DIR`.

- [ ] **Step 1: Migration** `20260929130000_verification_run/migration.sql`:
```sql
-- Conductor Plan 4b (spec R8), 2026-09-29: the verification run. A run of kind `verification` has
-- no task; `goalDeliveryId` is the goal version it verifies. PURELY ADDITIVE: one enum value (unused
-- here), one nullable column with its foreign key, one foreign key on a table Plan 4b's first
-- migration created empty.

ALTER TYPE "RunKind" ADD VALUE IF NOT EXISTS 'verification';
ALTER TABLE "SlaveRun" ADD COLUMN "goalDeliveryId" TEXT;
ALTER TABLE "SlaveRun" ADD CONSTRAINT "SlaveRun_goalDeliveryId_fkey" FOREIGN KEY ("goalDeliveryId") REFERENCES "GoalDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "SlaveRun_goalDeliveryId_idx" ON "SlaveRun"("goalDeliveryId");
ALTER TABLE "VerificationResult" ADD CONSTRAINT "VerificationResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SlaveRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```
Schema to match (`runs SlaveRun[]` on `GoalDelivery`, `verificationResults VerificationResult[]` on `SlaveRun`). `db:generate && db:migrate:test`.

- [ ] **Step 2: Failing tests**
  - `kinds.test.ts`: `PERMISSION_RUN_KINDS` equals the four; `BASELINE_GRANTS.verification` equals `['read_repo', 'write_repo', 'run_commands']`.
  - `permission-mapping.test.ts`: a `verification` permissions file written with `ownership: { worktreeRoot: '/w', owned: [], excluded: [] }` carries `Write` in `allow` and that exact `ownership` object.
  - A gate-level test in `packages/providers/test/permissions-lib.test.ts` (reuse its helper): with that ownership, `Write` to `/w/src/a.py` → DENY `foreign_file`; `Write` to `/state/runs/r1/verify/check.sh` → ALLOW; `Bash` → ALLOW.
  - child-env test: with `verifyDir: '/x/verify'` the env has `SLAVEOFAI_VERIFY_DIR=/x/verify`; without it the key is absent; `verifyDirIfPresent(dir)` returns `{}` for a run dir with no `verify/` and `{ verifyDir }` once `mkdirSync(join(dir, 'verify'))`.
  - `render.test.ts`: `SECTION_ORDER` gains `verification` (Task 3 fills the list; here assert it exists and starts with `'profile'`).

- [ ] **Step 3: Implement** the Prisma member and every widening the build names (`npm run typecheck` lists them; the set above is the one found by a sweep — fix what the build says, nothing else). Behaviour for a `verification` run in the paths that already skip a null task (sweep's `concludeDeadRun`, `reconcileOrphans`, `abandon.ts`, `concludeFailedResume`) is unchanged: they fail the run and release nothing — Task 6's goal pass releases the goal's claim. `kinds.ts`:
```ts
export const PERMISSION_RUN_KINDS = ['implementation', 'review', 'planning', 'verification'] as const
…
  // Conductor Plan 4b (D1): a verifier writes its checks with the write tools, into its scratch
  // directory. `write_repo` is granted and CONFINED by the ownership rule every verification run's
  // permissions file carries -- it owns nothing inside the worktree, so a write there is denied as
  // `foreign_file`, and the scratch directory is outside it.
  verification: ['read_repo', 'write_repo', 'run_commands'],
```
`process.ts`:
```ts
/**
 * The scratch directory of a verification run (Conductor Plan 4b, spec R8): `<runDir>/verify`,
 * outside the repository, where the verifier writes the checks it runs. The ONE definition of the
 * name, for `permissionsFilePathFor`'s reason. The orchestrator creates it for verification runs
 * only; {@link verifyDirIfPresent} is how a spawn -- first or resumed -- learns it is one.
 */
export function verifyDirPathFor(runDir: string): string {
  return join(runDir, 'verify')
}

/** `{ verifyDir }` when this run has a scratch directory, `{}` otherwise: the directory's presence
 *  is the declaration, so a resume (which has only the run directory) exports exactly what the
 *  start did, with no checkpoint column (plan D2). */
export function verifyDirIfPresent(runDir: string): { readonly verifyDir?: string } {
  const dir = verifyDirPathFor(runDir)
  return existsSync(dir) ? { verifyDir: dir } : {}
}
```
and in `buildChildEnv`'s input `readonly verifyDir?: string` (doc: "Conductor Plan 4b: `SLAVEOFAI_VERIFY_DIR`, absent unless given, for `toolResultsPath`'s reason"), output `...(input.verifyDir === undefined ? {} : { SLAVEOFAI_VERIFY_DIR: input.verifyDir })`. Claude adapter: `...verifyDirIfPresent(input.runDir)` in `spawnRun`'s call and `...verifyDirIfPresent(resumedInput.runDir)` in the resume call; Cursor: in `workerEnv`, `buildChildEnv({ ...input, ...verifyDirIfPresent(runDir) })`. Export both helpers from the providers index.

- [ ] **Step 4: The four goldens.** Build, then generate them with the gate's own fixed run id and token (read `GOLDEN_RUN_ID`/`GOLDEN_RUN_TOKEN` and `grantSets` at `scripts/gate-m56a-provider-contract.mjs:153-154` and `:526` and copy them exactly):
```bash
npm run build >/dev/null
DATABASE_URL=$TEST_DATABASE_URL node --input-type=module -e "
import { mkdtempSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writePermissionsFile } from './packages/control/dist/index.js'
import { PERMISSION_KINDS, PROVIDER_KINDS } from './packages/domain/dist/index.js'
const sets = { baseline: [], granted: PERMISSION_KINDS.map((kind) => ({ kind, mode: 'allow' })) }
for (const provider of PROVIDER_KINDS) for (const [name, rows] of Object.entries(sets)) {
  const dir = mkdtempSync(join(tmpdir(), 'golden-'))
  const written = writePermissionsFile(dir, { rows, provider, runKind: 'verification', runId: '00000000-0000-4000-8000-000000000m56', runToken: 'm56a-golden-token-not-a-secret' })
  copyFileSync(written, 'scripts/fixtures/m56a-goldens/permissions-' + provider + '-verification-' + name + '.json')
}"
git diff --stat scripts/fixtures/m56a-goldens   # only the four NEW files; the twelve existing ones unchanged
```
(Check `npm run build`'s real name in `package.json` — the root has `"test": "tsc --build && …"`; use `npx tsc --build` if there is no `build` script.) Update the README table's row to `(16)`, the file count line, and add: "Conductor Plan 4b (2026-09-29) added the four `verification` files when the run kind was added, written by `writePermissionsFile` with the gate's fixed run id and token (the command is in `docs/superpowers/plans/2026-09-28-conductor-4b-verification.md`, Task 2); the twelve earlier files did not change." Stage 2: `16` / "sixteen".

- [ ] **Step 5: Run** the tests above one file at a time, `enum-parity.test.ts`, `sweep.test.ts`, `npm run typecheck`, `npm run web:build && rm -rf apps/web/.next` → PASS.

- [ ] **Step 6: Commit** — `feat(runs): a verification run kind, confined to writing outside the repository, with its scratch directory`.

---

### Task 3: What the verifier is told and how its answer is read (domain)

**Files:**
- Create: `packages/domain/src/conduct/verification.ts`; Modify: `packages/domain/src/conduct/index.ts`
- Modify: `packages/domain/src/run-context/sections.ts` (`SectionKind` + `verification_goal`, `verification_protocol`; their sources and zod schemas), `packages/domain/src/run-context/render.ts` (`SECTION_ORDER.verification`, the trailer), `packages/domain/src/run-context/markers.ts` (`MARKERS` + the tag pair)
- Modify: `apps/web/src/lib/runContextSummary.ts` (the two new section kinds)
- Test: `packages/domain/test/conduct/verification.test.ts` (new), `packages/domain/test/run-context/render.test.ts`, `packages/domain/test/run-context/markers.test.ts` (or wherever `MARKERS` is pinned — `grep -rln "MARKERS" packages/domain/test`)

**Interfaces:**
- Consumes: `RequirementItem` (`conduct/requirements.ts`), `sanitisePersonText` (`handoff/contract.ts`), constants (Task 1).
- Produces:
  - `export interface VerificationItem { readonly key: string; readonly status: 'pass' | 'fail' | 'unverifiable'; readonly check: string; readonly output: string; readonly reason: string }`
  - `export function parseSlaveVerification(text: string, requirementKeys: readonly string[]): Result<readonly VerificationItem[], string>` — the LAST tag block; each key exactly once; no unknown key; `pass`/`fail` need a non-empty `check`; `fail`/`unverifiable` need a non-empty `reason`; `check`, `output`, `reason` trimmed to their caps with `trimEvidence`.
  - `export function trimEvidence(text: string, max: number): string` — unchanged when `text.length <= max`; otherwise head and tail halves joined by `\n… [N characters cut] …\n`.
  - `export interface VerificationGoalInput { readonly goalVersion: number; readonly round: number; readonly requirements: readonly RequirementItem[]; readonly diffStat: string; readonly diffCapped: boolean }`; `export function renderVerificationGoal(input: VerificationGoalInput): string`
  - `export function renderVerificationProtocol(requirementKeys: readonly string[], verifyDir: string): string`
  - (`VERIFICATION_INSTRUCTIONS`, the trailer, is Task 2's, in `run-context/render.ts`; its text is given in this task's Step 3 so the two tasks agree.)
  - `export function renderVerificationRework(round: number, failed: readonly (VerificationItem & { readonly text: string })[]): string` — bounded by `VERIFICATION_REWORK_MAX_CHARS`.
  - Section sources: `{ kind: 'verification_goal'; goalVersion: number; round: number; requirements: number; diffCapped: boolean }`, `{ kind: 'verification_protocol'; requirements: number }`.
  - `SECTION_ORDER.verification = ['profile', 'verification_goal', 'verification_protocol']`.

- [ ] **Step 1: Failing tests** (`verification.test.ts`):
```ts
import { describe, expect, it } from 'vitest'
import {
  parseSlaveVerification,
  renderVerificationGoal,
  renderVerificationProtocol,
  renderVerificationRework,
  trimEvidence,
} from '../../src/conduct/verification.js'

const block = (items: unknown): string => `done.\n<slave-verification>${JSON.stringify({ items })}</slave-verification>`
const pass = (key: string) => ({ key, status: 'pass', check: 'pytest -k csv', output: '1 passed', reason: '' })

describe('parseSlaveVerification', () => {
  it('reads one item per key', () => {
    const parsed = parseSlaveVerification(block([pass('R1'), { key: 'R2', status: 'fail', check: 'hsql --format json', output: 'Traceback', reason: 'prints CSV' }]), ['R1', 'R2'])
    expect(parsed.ok && parsed.value.map((i) => i.status)).toEqual(['pass', 'fail'])
  })

  it('reads the LAST block', () => {
    const text = `${block([{ ...pass('R1'), status: 'fail', reason: 'draft' }])}\n${block([pass('R1')])}`
    const parsed = parseSlaveVerification(text, ['R1'])
    expect(parsed.ok && parsed.value[0]?.status).toBe('pass')
  })

  it.each([
    ['no block', 'all good', /has no <slave-verification> block/],
    ['unclosed', '<slave-verification>{"items":[', /not closed/],
    ['bad json', '<slave-verification>{items}</slave-verification>', /not valid JSON/],
    ['a key twice', block([pass('R1'), pass('R1')]), /R1 is reported 2 times/],
    ['a key missing', block([pass('R1')]), /R2 is not reported/],
    ['an unknown key', block([pass('R1'), pass('R2'), pass('R9')]), /R9 is not a requirement of this goal/],
    ['fail with no reason', block([pass('R1'), { key: 'R2', status: 'fail', check: 'x', output: '', reason: '' }]), /R2 is fail with no reason/],
    ['pass with no check', block([pass('R1'), { key: 'R2', status: 'pass', check: '', output: '', reason: '' }]), /R2 is pass with no check/],
  ])('refuses %s', (_name, text, message) => {
    const parsed = parseSlaveVerification(text, ['R1', 'R2'])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toMatch(message)
  })

  it('allows unverifiable with no check, and trims long output', () => {
    const parsed = parseSlaveVerification(
      block([{ key: 'R1', status: 'unverifiable', check: '', output: 'x'.repeat(10_000), reason: 'needs a network' }]),
      ['R1'],
    )
    expect(parsed.ok && parsed.value[0]?.output.length).toBeLessThan(4200)
    expect(parsed.ok && parsed.value[0]?.output).toContain('characters cut')
  })
})

describe('trimEvidence', () => {
  it('keeps short text and cuts the middle of long text', () => {
    expect(trimEvidence('abc', 10)).toBe('abc')
    const cut = trimEvidence(`HEAD${'m'.repeat(100)}TAIL`, 20)
    expect(cut.startsWith('HEAD')).toBe(true)
    expect(cut.endsWith('TAIL')).toBe(true)
  })
})

describe('rendering', () => {
  it('names the round, every key and the scratch directory', () => {
    const goal = renderVerificationGoal({
      goalVersion: 2,
      round: 3,
      requirements: [{ key: 'R1', text: 'csv', source: 'Add csv.' }, { key: 'R2', text: 'json', source: 'Add json.' }],
      diffStat: ' src/a.py | 3 +++',
      diffCapped: false,
    })
    expect(goal).toContain('Verification round 3 of goal v2')
    expect(goal).toContain('Requirement keys: R1, R2')
    const protocol = renderVerificationProtocol(['R1', 'R2'], '/state/runs/r1/verify')
    expect(protocol).toContain('$SLAVEOFAI_VERIFY_DIR (/state/runs/r1/verify)')
    expect(protocol).toContain('<slave-verification>')
  })

  it('bounds the rework reason and names each failing requirement', () => {
    const reason = renderVerificationRework(2, [
      { key: 'R2', text: 'json mode', status: 'fail', check: 'hsql --format json', output: 'y'.repeat(20_000), reason: 'prints CSV' },
    ])
    expect(reason).toContain('Verification round 2')
    expect(reason).toContain('R2: json mode')
    expect(reason.length).toBeLessThanOrEqual(6000)
  })
})
```
In `render.test.ts`: `SECTION_ORDER.verification` equals the three; a verification render ends with `VERIFICATION_INSTRUCTIONS`; a `task` section under `verification` throws `unknown section`. Markers test: `neutraliseMarkers('<slave-verification>')` starts with `‹`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** `packages/domain/src/conduct/verification.ts` — the parser mirrors `parseSlaveReport` (same open/close search from `lastIndexOf`, same "first three zod issues" message) with:
```ts
const itemSchema = z.object({
  key: z.string().min(1).max(20),
  status: z.enum(['pass', 'fail', 'unverifiable']),
  check: z.string().max(200_000).default(''),
  output: z.string().max(2_000_000).default(''),
  reason: z.string().max(200_000).default(''),
})
const verificationSchema = z.object({ items: z.array(itemSchema).max(REQUIREMENTS_MAX_ITEMS * 2) })
```
and the problems list: `${key} is not reported`, `${key} is reported ${n} times`, `${key} is not a requirement of this goal`, `${key} is ${status} with no check` (pass/fail), `${key} is ${status} with no reason` (fail/unverifiable); error `the verification is incomplete: <problems joined by '; '>`. Values are `.trim()`ed then `trimEvidence`d to `VERIFICATION_CHECK_MAX_CHARS` / `VERIFICATION_OUTPUT_MAX_CHARS` / `VERIFICATION_REASON_MAX_CHARS`.

`renderVerificationGoal`:
```ts
export function renderVerificationGoal(input: VerificationGoalInput): string {
  return [
    `Verification round ${String(input.round)} of goal v${String(input.goalVersion)}.`,
    `Requirement keys: ${input.requirements.map((r) => r.key).join(', ')}`,
    '',
    'The requirements (check every one):',
    ...input.requirements.map((r) => `${r.key}: ${sanitisePersonText(r.text)}`),
    '',
    'What was built for this goal (git diff --stat from where the goal started):',
    input.diffStat.trim() === '' ? '(no changes)' : input.diffStat,
    ...(input.diffCapped ? ['(the summary was cut; read the repository for the rest)'] : []),
  ].join('\n')
}
```
`renderVerificationProtocol(keys, verifyDir)`:
```ts
  const example = { items: keys.map((key) => ({ key, status: 'pass|fail|unverifiable', check: 'the command or script you ran', output: 'what it printed', reason: 'why it failed or could not be checked' })) }
  return [
    'You verify; you do not fix. For EACH requirement above:',
    `1. Write a check -- a command, a script or a test -- in the scratch directory $SLAVEOFAI_VERIFY_DIR (${verifyDir}). Never in the repository: writes there are denied, and a verification that changed the repository is thrown away.`,
    '2. Run it against this checkout.',
    '3. Decide: pass (the check shows the requirement holds), fail (it shows it does not), or unverifiable (no check you can run here can show it either way -- say why).',
    'End your final message with this block, exactly once, one item per requirement key:',
    `<${SLAVE_VERIFICATION_TAG}>${JSON.stringify(example)}</${SLAVE_VERIFICATION_TAG}>`,
    '"check" is the check itself (the script text or the command line); "output" is what running it printed.',
  ].join('\n')
```
`VERIFICATION_INSTRUCTIONS` (Task 2, `render.ts`) reads exactly: `'Finish with the <slave-verification> block described above as the last thing in your final message. A missing or malformed block means this verification is run again.'` — Task 2 writes this text; this task only asserts it in `render.test.ts`.
`renderVerificationRework(round, failed)`: `Verification round ${round} found requirement(s) your package owns not met. Fix them, then finish as your instructions describe.` then per item `\n\n${key}: ${text}\ncheck: ${check}\noutput: ${output}\nreason: ${reason}` with each item's output first cut by `trimEvidence(output, 1500)` and the whole string finally `trimEvidence`d to `VERIFICATION_REWORK_MAX_CHARS`.
Sections: add the two kinds with doc comments, their `SectionSource` variants and zod schemas (all fields required — new kinds, the `package` rule), register in `sectionSourceSchema`; `SECTION_ORDER.verification = ['profile', 'verification_goal', 'verification_protocol']` (the trailer choice is Task 2's). `MARKERS` + `'<slave-verification>'`, `'</slave-verification>'`. `runContextSummary.ts`: a label for each new kind in the file's existing style.

- [ ] **Step 4: Run** the domain tests above, `npx vitest run apps/web/test` files that cover `runContextSummary` (`grep -rln runContextSummary apps/web/test`), `npm run typecheck`, `npm run web:build && rm -rf apps/web/.next` → PASS.

- [ ] **Step 5: Commit** — `feat(conduct): the verifier's prompt, its <slave-verification> parser and the rework it sends`.

---

### Task 4: A verifier seat that implemented nothing in the goal version

**Files:**
- Modify: `packages/domain/src/conduct/constants.ts` (`VERIFIER_ROLE` exported — added in Task 1; here only used), `packages/domain/src/persons/department.ts` (`verifier: 'QA'` in `ROLE_DEPARTMENT`)
- Modify: `packages/control/src/conductStaffing.ts` (`staffVerifier`; `staffPackages` never reuses a verifier seat)
- Modify: `apps/orchestrator/src/conductor.ts` (staff the verifier before `materialise`; `GoalDelivery.verifierSlaveId`)
- Test: `packages/control/test/integration/conduct-staffing.test.ts` (or the file testing `staffPackages` — `grep -rln "staffPackages" packages/control/test`), `apps/orchestrator/test/integration/conductor.test.ts`

**Interfaces:**
- Produces:
  - `export async function staffVerifier(workspaceId: string, goalVersion: number, packageSeats: ReadonlySet<string>, fallbackTemplateId: string): Promise<Result<string, string>>` — the seat id: (1) an open, unreleased seat holding `VERIFIER_ROLE` not in `packageSeats` and with no `implementation` run on a task of this goal version; else (2) such a seat holding `REVIEWER_ROLE`, given `VERIFIER_ROLE` (`mergeRuntimeRoles(seat, [VERIFIER_ROLE], 'conductor', 'system')`); else (3) `hireFromTemplate(workspaceId, fallbackTemplateId, { rationale: 'Conductor: verifier of goal v<n>', requirePool: true, newSeat: true })` + the role. The refusal names why.
  - `export async function implementersOf(workspaceId: string, goalVersion: number): Promise<ReadonlySet<string>>` (control) — slave ids with an `implementation` run on a task of the version (`slaveRun.findMany({ where: { kind: 'implementation', task: { workspaceId, workPackage: { goalVersion } } }, select: { slaveId: true }, distinct: ['slaveId'] })`).

- [ ] **Step 1: Failing tests**
  - `staffVerifier`: a workspace with a `verifier` seat → that seat; with only a reviewer seat → that seat, now holding `verifier`; with a reviewer seat that is also one of `packageSeats` → a hire (new seat, holds `verifier`); a `verifier` seat that has an implementation run on a v1 task → not chosen for v1.
  - `staffPackages`: an open seat of the package's persona holding `verifier` is NOT reused (a hire happens) — mirror the existing "sole reviewer" test.
  - `conductor.test.ts`: after materialising, `GoalDelivery.verifierSlaveId` is set, that seat holds `verifier`, and it is none of the package seats; when `staffVerifier` fails (no pool for the fallback template and no reviewer), the tick returns `'conduct_failed'` with a `conductor_failed` trip naming "verifier", and nothing is materialised.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** in `conductStaffing.ts` (WHY doc: spec R8 "a verifier seat that implemented nothing in this goal version"; R5 "intake staffs only the verifier seat" — the conductor makes sure one exists when intake did not, e.g. a workspace switched to `conducted`). In `staffPackages`, exclude verifier seats beside the sole reviewer: `&& !s.runtimeRoles.includes(VERIFIER_ROLE)` with a comment ("a verifier is never an implementer; plan 4b D4"). In `conductor.ts` after `staffPackages` succeeds:
```ts
  const verifier = await staffVerifier(workspaceId, version, new Set(seats.value.values()), plan.packages[0]?.templateId ?? '')
  if (!verifier.ok) {
    await tripConductor(workspaceId, `staffing the verifier of goal v${version}: ${verifier.error}`)
    return 'conduct_failed'
  }
```
and pass `verifierSlaveId: verifier.value` into `materialise`'s `delivery` argument, written on the `GoalDelivery` row.

- [ ] **Step 4: Run** the two test files + `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(conductor): every goal version has a verifier seat that implements none of it`.

---

### Task 5: The verification run is dispatched in a fresh worktree of the integration branch

**Files:**
- Create: `apps/orchestrator/src/verification.ts` (`dispatchVerification`, `verificationWorktreeKey`, `removeVerificationWorktree`)
- Modify: `apps/orchestrator/src/worktree.ts` (`provisionDetachedWorktree`)
- Modify: `apps/orchestrator/src/ownership.ts` (`verificationOwnership`)
- Modify: `apps/orchestrator/src/runContext.ts` (`BuildRunContextInput.verification`; the two sections)
- Modify: `apps/orchestrator/src/resume.ts` (ownership for a resumed verification run)
- Modify: `apps/orchestrator/src/verify.ts` (`verifyConcludedRun`: `if (run.kind === 'verification') return` at the top of the failed and the succeeded branches — without it a concluded verification run falls into the implementation path and throws "has no task"; Task 6 replaces both lines with the real conclusion)
- Modify: `apps/orchestrator/src/conductor.ts` (export `tripConductor`)
- Test: `apps/orchestrator/test/integration/verification.test.ts` (new), `apps/orchestrator/test/integration/resume-execution.test.ts` (one case), `apps/orchestrator/test/integration/runContext.test.ts` (one case)

**Interfaces:**
- Consumes: `integrationBranchName` (4a), `renderVerificationGoal`/`renderVerificationProtocol` (Task 3), `staffVerifier`/`implementersOf` (Task 4), `verifyDirPathFor` (Task 2), `createRunUnlessArchived`, `runFilePaths`, `writePermissionsFile`, `pumpRun`, `resolveRuntime`, `resolveAdapter`, `admitProvider`, `pumps`/`activePumpRunIds`/`emailLocalPart` (`tick.ts`).
- Produces:
  - `export async function provisionDetachedWorktree(input: { readonly repoPath: string; readonly ref: string; readonly key: string; readonly setupCommands: readonly string[]; readonly setupTimeoutMs?: number }): Promise<{ readonly path: string; readonly headCommit: string }>` — `SAFE_SEGMENT` on `key`; path `join(worktreeRootFor(repoPath), key)`; refuses an existing path; `git worktree add --detach <path> <ref>`; setup commands as `provisionWorktree` runs them.
  - `export function verificationOwnership(worktreePath: string): PermissionOwnership` → `{ worktreeRoot: resolvedRoot(worktreePath), owned: [], excluded: [] }`.
  - `export const verificationWorktreeKey = (runId: string): string => \`verify-${runId.slice(0, 8)}\``
  - `export async function dispatchVerification(deps: TickDeps, deliveryId: string): Promise<RunId | null>`
  - `export async function removeVerificationWorktree(repoPath: string, worktreePath: string | null): Promise<void>` — only a path under `worktreeRootFor(repoPath)` whose basename starts with `verify-`; `git worktree remove --force`, errors logged.
  - `BuildRunContextInput` gains `readonly verification?: { readonly goalVersion: number; readonly round: number; readonly requirements: readonly RequirementItem[]; readonly diffStat: string; readonly diffCapped: boolean; readonly verifyDir: string }`.

- [ ] **Step 1: Failing tests** (`verification.test.ts`; seed like 4a's `goal-pass.test.ts`: conducted workspace, a v1 delivery whose integration branch carries a package commit, both package tasks `done`+integrated, a `RequirementSet`, a verifier seat recorded on the delivery; the `m8-flow` fake — until Task 9 gives it a verification arm, use the `env-echo` fixture adapter for this task so the spawn is observable without a verdict):
  - `dispatchVerification` → a `SlaveRun { kind: 'verification', taskId: null, goalDeliveryId, slaveId: <verifier> }`; the delivery `verifying`, `round: 1`, `activeRunId` = the run; event `workspace.verification_started { version: 1, round: 1, runId }`.
  - The run's worktree is a detached checkout at the integration branch's tip (`git -C <path> rev-parse HEAD` = `rev-parse <integrationBranch>`; `git -C <path> symbolic-ref -q HEAD` fails), under `worktreeRootFor(repo)` named `verify-<run8>`.
  - The run's `permissions.json` has `ownership: { worktreeRoot: <realpath>, owned: [], excluded: [] }` and `Write` in `allow`.
  - `<runDir>/verify` exists and the child's env (the `env-echo` result line) has `SLAVEOFAI_VERIFY_DIR` = that path.
  - The `RunContext` manifest is `kind: 'verification'` with `profile`, `verification_goal { goalVersion: 1, round: 1, requirements: 2 }`, `verification_protocol`; the prompt contains `Requirement keys: R1, R2`.
  - The implementer of v1 is never chosen: make the recorded verifier seat ALSO the implementer of a v1 task (an implementation run row) → dispatch re-staffs through `staffVerifier` and uses a different seat.
  - A second `dispatchVerification` while the first holds the claim → `null`, no second run row.
  - The verifier busy with another run → `null` (silent), no claim taken.
  - `resume-execution.test.ts`: a paused verification run resumed → the rewritten `permissions.json` still carries the empty ownership rule, and the resumed child's env still has `SLAVEOFAI_VERIFY_DIR`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement.** `dispatchVerification` mirrors `dispatchReview`'s shape and discipline (create the row before anything can fail, claim with a guarded `updateMany`, delete the row on a lost claim, cancel-and-fail on a spawn error). The parts that differ:
```ts
export async function dispatchVerification(deps: TickDeps, deliveryId: string): Promise<RunId | null> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { workspace: true } })
  // A new round starts from `integrating` (every package integrated); a retry of the same round
  // (plan D7) from `verifying` with no claim.
  const newRound = delivery.status === 'integrating'
  if (!newRound && !(delivery.status === 'verifying' && delivery.activeRunId === null)) return null
  const workspace = delivery.workspace
  const excluded = await implementersOf(workspace.id, delivery.goalVersion)
  const seat = await eligibleVerifier(workspace.id, delivery, excluded)
  if (seat === 'busy') return null
  if (seat === null) return null // `eligibleVerifier` already tripped the conductor, once
  const run = await createRunUnlessArchived(workspace.id, {
    slaveId: seat.id,
    kind: 'verification',
    status: 'starting',
    goalDeliveryId: delivery.id,
  })
  if (run === null) return null
  const round = newRound ? delivery.round + 1 : delivery.round
  const claimed = await prisma.goalDelivery.updateMany({
    where: { id: delivery.id, status: delivery.status, activeRunId: null },
    data: newRound ? { status: 'verifying', activeRunId: run.id, round, roundRunFailures: 0 } : { activeRunId: run.id },
  })
  if (claimed.count === 0) {
    await prisma.slaveRun.delete({ where: { id: run.id } })
    return null
  }
  // … resolveRuntime / resolveAdapter / admitProvider exactly as dispatchReview …
  // … inside the try:
  //   const worktree = await provisionDetachedWorktree({ repoPath: workspace.repoPath, ref: delivery.integrationBranch,
  //     key: verificationWorktreeKey(run.id), setupCommands: workspace.setupCommands })
  //   const { runDir, pauseFlagPath } = runFilePaths(workspace.repoPath, runId)
  //   mkdirSync(verifyDirPathFor(runDir), { recursive: true, mode: 0o700 })
  //   const permissionsFilePath = writePermissionsFile(runDir, { rows: seat.permissions, provider: resolved.provider,
  //     runKind: 'verification', runId: run.id, runToken, ownership: verificationOwnership(worktree.path) })
  //   const { text: diffStat, capped } = await diffStat(workspace.repoPath, delivery.baseCommit, delivery.integrationBranch)
  //   const requirements = requirementItemsSchema.parse((await prisma.requirementSet.findUniqueOrThrow({ where:
  //     { workspaceId_goalVersion: { workspaceId: workspace.id, goalVersion: delivery.goalVersion } } })).items)
  //   const built = await buildRunContext({ runId, kind: 'verification', slaveId: seat.id, workspaceId: workspace.id,
  //     taskId: null, worktreePath: worktree.path, provider: resolved.provider,
  //     verification: { goalVersion: delivery.goalVersion, round, requirements, diffStat, diffCapped: capped, verifyDir: verifyDirPathFor(runDir) } })
  //   handle = await runAdapter.start({ runId, prompt: built.prompt, worktreePath: worktree.path, pauseFlagPath, runDir,
  //     permissionsFilePath, runToken, gitIdentity, ...(model !== undefined ? { model } : {}) })
  //   update the run row (pid, worktreePath, provider, model); appendEvent workspace.verification_started
  //   pumpRun(...).then(() => verifyConcludedRun(runId)) registered in `pumps`/`activePumpRunIds`, as dispatchReview does.
  // catch: cancel a spawned child; fail the run row (failureClass as dispatchReview); release the claim
  //   (`goalDelivery.updateMany({ where: { id, activeRunId: run.id }, data: { activeRunId: null, roundRunFailures: { increment: 1 } } })`);
  //   `removeVerificationWorktree`; `run.failed` event with the reason.
}
```
Write the whole function out in full in the file — the comment block above is the list of steps, each of which is a line-for-line copy of `dispatchReview`'s corresponding statement with the names shown. `diffStat` is a local helper: `execFile('git', ['diff', '--stat', \`${base}..${head}\`], { cwd, maxBuffer: 16 MiB, timeout: 30_000 })`, capped at `VERIFICATION_DIFF_STAT_MAX_CHARS` (`capped: true` when cut). `eligibleVerifier`: the delivery's `verifierSlaveId` when that seat is open, unreleased, holds `VERIFIER_ROLE`, is not in `excluded`; else `staffVerifier(workspace.id, goalVersion, excluded, <the version's first package templateId>)` and record the new seat on the delivery; a staffing refusal → `tripConductor` (export it from `conductor.ts`) and `null`; the chosen seat holding a non-terminal run → `'busy'`. `buildRunContext`: when `input.kind === 'verification' && input.verification !== undefined`, push the two sections (`renderVerificationGoal`, `renderVerificationProtocol` with the requirement keys and `verifyDir`) with their sources; nothing else is added for this kind (no roster, inbox, memory, skills sections — D4). `resume.ts`:
```ts
    ownership:
      run.kind === 'verification'
        ? verificationOwnership(checkpoint.worktreePath)
        : run.kind !== 'implementation' || run.taskId === null
          ? undefined
          : await permissionOwnership(run.taskId, checkpoint.worktreePath),
```
with a comment: "Conductor Plan 4b (D1): a resumed verification run keeps the rule that confines its writes; without it its `write_repo` baseline would reach the repository."

- [ ] **Step 4: Run** `verification.test.ts`, `resume-execution.test.ts`, `runContext.test.ts`, `worktree.test.ts` (one at a time) + `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(conductor): a goal version is verified by its own run, in a fresh checkout of its integration branch`.

---

### Task 6: The gate and the loop

**Files:**
- Modify: `apps/orchestrator/src/verification.ts` (`concludeVerification`, `releaseVerification`)
- Modify: `apps/orchestrator/src/verify.ts` (`verifyConcludedRun`: a `verification` arm in the failed and the succeeded branches)
- Modify: `apps/orchestrator/src/goal.ts` (`runGoalPass(deps, { mayStartRuns })`: dispatch instead of accept; stranded claims; the run-failure cap)
- Modify: `apps/orchestrator/src/tick.ts` (the call passes `deps` and `{ mayStartRuns: waitingOn === null }`)
- Modify: `packages/control/src/goalDelivery.ts` (`retryGoal`; `abandonGoal` also refuses on `activeRunId`; `GoalDeliveryView` gains `round`, `needsHumanReason`, `latestVerification`), `packages/control/src/refusal.ts` (`goal_not_needs_human`), `apps/orchestrator/src/cli.ts` (`retry-goal`)
- Test: `apps/orchestrator/test/integration/verification.test.ts` (new describes), `apps/orchestrator/test/integration/goal-pass.test.ts` (4a's accept cases now go through a verification), `packages/control/test/integration/goal-delivery.test.ts`

**Interfaces:**
- Consumes: `parseSlaveVerification`, `renderVerificationRework` (Task 3), `joinRunOutput` (`./runOutput.js`), `failConcludedRun` (`./runs.js`), `acceptGoal`/`mergeGoalIntoBase` (4a), `removeVerificationWorktree` (Task 5).
- Produces:
  - `export async function concludeVerification(runId: RunId): Promise<void>` — replay-safe.
  - `export async function releaseVerification(runId: string): Promise<void>` — clears the claim held by `runId` and counts one run failure; removes the worktree.
  - Plan 4a's `acceptGoal` loses its only caller (acceptance now happens inside `concludeVerification`'s claim release) and is deleted with its test; 4a's `integrating → accepted` path is gone.
  - `export async function retryGoal(workspaceId: string, goalVersion: number, principal?: Principal): Promise<Result<{ readonly round: number }, ControlRefusal>>` — `needs_human` → `integrating`, `roundBase = round`, `roundRunFailures = 0`, `needsHumanReason = null`; event `workspace.goal_retried`; refusal `{ kind: 'goal_not_needs_human'; goalVersion; status }`.
  - CLI `retry-goal --workspace <id> --version <n>`.

- [ ] **Step 1: Failing tests** (`verification.test.ts`, describe `the gate`; drive a verification run to its conclusion by writing the run's `run_output` events directly — copy how `run-report.test.ts` feeds `fileRunReport` — then calling `concludeVerification`, so the fake's arm (Task 9) is not needed here):
  - All pass → `VerificationResult` rows (2, `status: 'pass'`, trimmed output), delivery `accepted` with `activeRunId` null, `workspace.verified { pass: 2, fail: 0 }` then `workspace.goal_accepted { rounds: 1 }`; with `autoMerge` the next `runGoalPass` merges into `main`; the verification worktree is gone.
  - `R2` fails (owned by package `config`) → the `config` task `rework`, `integratedAt` null, `attempt` unchanged, `lastRejectionReason` starts `Verification round 1` and contains the check and output; one `task.rework { attempt: 0, verificationRound: 1 }`; the `report` task still `done`; delivery `integrating`, `round: 1`; `workspace.verified { fail: 1, failedKeys: ['R2'] }`.
  - The loop: after that, mark the `config` task `done`+integrated again, `runGoalPass` → round 2 dispatched; all pass → accepted with `rounds: 2`.
  - Cap: `verificationRoundCap: 2`, fail in round 1 and round 2 → after round 2 `needs_human`, `needsHumanReason` names the cap and the failing keys, `workspace.goal_needs_human`; `runGoalPass` dispatches nothing more.
  - Unverifiable only → `needs_human` at once (round 1), reason names the key and the verifier's reason; fail + unverifiable → rework, not `needs_human`.
  - A failing key whose owning task is `cancelled` → `needs_human` naming the key.
  - No tag / malformed → run `failed` with the parser's reason in `run.failed`, claim released, `roundRunFailures: 1`, delivery still `verifying`, round unchanged; three such runs in a row → `needs_human` ("the verifier could not produce a usable verification 3 times").
  - A tracked file changed in the verification worktree (write to `README.md` there before concluding) → treated as the malformed case, reason names `README.md`; `HEAD` moved (commit in the worktree) → same.
  - Replay: `concludeVerification` twice → one set of rows, one `workspace.verified`, one rework.
  - Stranded claim: a delivery `verifying` whose `activeRunId` names a run already `failed` and not in `activePumpRunIds` → `runGoalPass` releases it (`roundRunFailures: 1`) and dispatches the round again; a `succeeded` one → `runGoalPass` concludes it.
  - `goal-delivery.test.ts`: `retryGoal` on `needs_human` → `integrating`, `roundBase = round`, event; on `integrating` → `goal_not_needs_human`; `abandonGoal` while `activeRunId` is set → `goal_version_busy`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** `concludeVerification`:
```ts
/** Thrown inside the gate's transaction when the run no longer holds the claim: a replay, or a
 *  release that won the race. A refusal inside a Prisma transaction must throw (house rule). */
class NotTheClaim extends Error {}

export async function concludeVerification(runId: RunId): Promise<void> {
  const run = await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId }, include: { goalDelivery: { include: { workspace: true } } } })
  const delivery = run.goalDelivery
  if (delivery === null || delivery.activeRunId !== run.id) return
  const workspace = delivery.workspace
  const set = await prisma.requirementSet.findUniqueOrThrow({
    where: { workspaceId_goalVersion: { workspaceId: workspace.id, goalVersion: delivery.goalVersion } },
  })
  const requirements = requirementItemsSchema.parse(set.items)
  const keys = requirements.map((r) => r.key)

  // Plan D1/D7: a verifier that changed what it verifies has no verdict worth keeping.
  const tampered = await changedCheckout(run.worktreePath, delivery.integrationBranch)
  const rows = await prisma.executionEvent.findMany({ where: { runId: run.id, type: 'run_output' }, orderBy: { seq: 'asc' }, select: { payload: true } })
  const parsed = tampered !== null ? err(tampered) : parseSlaveVerification(joinRunOutput(rows.map((r) => r.payload)), keys)
  if (!parsed.ok) {
    await failConcludedRun(run, workspace.id, `verification: ${parsed.error}`)
    await releaseVerification(run.id)
    return
  }
  const items = parsed.value
  await prisma.verificationResult.createMany({
    data: items.map((item) => ({ workspaceId: workspace.id, goalDeliveryId: delivery.id, goalVersion: delivery.goalVersion, round: delivery.round, runId: run.id, ...item })),
    skipDuplicates: true,
  })

  const failed = items.filter((i) => i.status === 'fail')
  const unverifiable = items.filter((i) => i.status === 'unverifiable')
  const owners = await ownersOf(workspace.id, delivery.goalVersion, failed.map((i) => i.key))
  const orphaned = failed.filter((i) => owners.get(i.key)?.status !== 'done')
  const roundsUsed = delivery.round - delivery.roundBase
  const outcome: 'accept' | 'rework' | { readonly needsHuman: string } =
    failed.length === 0 && unverifiable.length === 0
      ? 'accept'
      : failed.length === 0
        ? { needsHuman: `requirement(s) could not be verified: ${unverifiable.map((i) => `${i.key} (${i.reason.split('\n')[0] ?? ''})`).join('; ')}` }
        : orphaned.length > 0
          ? { needsHuman: `requirement(s) failed whose package cannot be reworked: ${orphaned.map((i) => i.key).join(', ')}` }
          : roundsUsed >= workspace.verificationRoundCap
            ? { needsHuman: `the verification round cap (${String(workspace.verificationRoundCap)}) was reached; still failing: ${failed.map((i) => i.key).join(', ')}` }
            : 'rework'

  const textOf = new Map(requirements.map((r) => [r.key, r.text] as const))
  try {
    await prisma.$transaction(async (tx) => {
      const released = await tx.goalDelivery.updateMany({
        where: { id: delivery.id, activeRunId: run.id },
        data:
          // The status moves in the SAME write that releases the claim: a `verifying` delivery with
          // no claim is what the goal pass retries, so a release first and a status change later
          // would let a tick in between dispatch a verification of an accepted version.
          outcome === 'accept'
            ? { activeRunId: null, status: 'accepted', acceptedAt: new Date() }
            : outcome === 'rework'
              ? { activeRunId: null, status: 'integrating' }
              : { activeRunId: null, status: 'needs_human', needsHumanReason: outcome.needsHuman.slice(0, 2000) },
      })
      if (released.count === 0) throw new NotTheClaim()
      if (outcome !== 'rework') return
      const byTask = new Map<string, (VerificationItem & { readonly text: string })[]>()
      for (const item of failed) {
        const owner = owners.get(item.key)
        if (owner === undefined) continue
        byTask.set(owner.taskId, [...(byTask.get(owner.taskId) ?? []), { ...item, text: textOf.get(item.key) ?? '' }])
      }
      for (const [taskId, its] of byTask) {
        await tx.task.updateMany({
          where: { id: taskId, status: 'done' },
          data: { status: 'rework', integratedAt: null, activeRunId: null, lastRejectionReason: renderVerificationRework(delivery.round, its) },
        })
      }
    })
  } catch (error) {
    if (error instanceof NotTheClaim) return
    throw error
  }
  // … events after the commit: `workspace.verified` (counts + failedKeys ≤ 60); then per outcome:
  //   accept → `workspace.goal_accepted { version, rounds: delivery.round - delivery.roundBase }`;
  //   rework → one `task.rework { reason, attempt: <task's attempt>, verificationRound: delivery.round }` per reworked task;
  //   needs human → `workspace.goal_needs_human { version, reason }`.
  await removeVerificationWorktree(workspace.repoPath, run.worktreePath)
}
```
Write the event block out in full (each event is one `appendEvent` in the shape Task 1 defined). `ownersOf(workspaceId, goalVersion, keys)`: packages of the version whose `requirementKeys` contain a key, joined to their task → `Map<key, { taskId, status }>`. `changedCheckout(worktreePath, branch)`: `null` when the checkout is unchanged; otherwise a sentence — `the verifier changed the repository: <paths>` from `git status --porcelain --untracked-files=no` (paths, ≤ 10), or `the verifier moved HEAD off <branch>` when `rev-parse HEAD` ≠ `rev-parse <branch>`, or `the verification worktree is gone` when the path is null or missing. `releaseVerification(runId)`:
```ts
export async function releaseVerification(runId: string): Promise<void> {
  const run = await prisma.slaveRun.findUnique({ where: { id: runId }, include: { goalDelivery: { include: { workspace: { select: { repoPath: true } } } } } })
  if (run === null || run.goalDelivery === null) return
  await prisma.goalDelivery.updateMany({
    where: { id: run.goalDelivery.id, activeRunId: runId },
    data: { activeRunId: null, roundRunFailures: { increment: 1 } },
  })
  await removeVerificationWorktree(run.goalDelivery.workspace.repoPath, run.worktreePath)
}
```
`verify.ts`: in the failed branch, `if (run.kind === 'verification') { await releaseVerification(run.id); return }` before the `implementation`/`review` arms; in the succeeded branch, beside `planning`/`review`: `if (run.kind === 'verification') { await concludeVerification(brandRunId(run.id)); return }`.
`runGoalPass(deps, opts)` for each open delivery, oldest first:
```ts
    if (delivery.status === 'verifying') {
      if (delivery.activeRunId !== null) {
        await settleStrandedClaim(delivery.activeRunId) // terminal + no pump here: succeeded → concludeVerification, else releaseVerification
        continue
      }
      if (delivery.roundRunFailures >= VERIFICATION_RUN_RETRY_CAP) {
        await endInNeedsHuman(delivery.id, `the verifier could not produce a usable verification ${String(VERIFICATION_RUN_RETRY_CAP)} times in round ${String(delivery.round)}`)
        continue
      }
      if (opts.mayStartRuns) await dispatchVerification(deps, delivery.id)
      continue
    }
    if (delivery.status === 'integrating') {
      if (!(await everyPackageIntegrated(workspaceId, delivery.goalVersion))) continue
      if (opts.mayStartRuns) await dispatchVerification(deps, delivery.id)
      continue
    }
    if (delivery.status === 'accepted' && workspace.autoMerge) await mergeGoalIntoBase(delivery.id, 'system')
```
(`endInNeedsHuman`: guarded `updateMany` `verifying → needs_human` with the reason + `workspace.goal_needs_human`. The open-delivery query now includes `verifying`.) `settleStrandedClaim(runId)`: read the run; if `NON_TERMINAL_RUN_STATUSES` includes its status or `activePumpRunIds.has(runId)` → nothing; `succeeded` → `concludeVerification`; else `releaseVerification`. `tick.ts`: `await runGoalPass(deps, { mayStartRuns: waitingOn === null })`. `retryGoal` as its interface says; the `abandonGoal` guard gains `if (delivery.activeRunId !== null) return err({ kind: 'goal_version_busy', goalVersion, holder: \`verification run ${delivery.activeRunId}\` })` before the task check; `GoalDeliveryView` gains `round`, `needsHumanReason` and `latestVerification` (the same shape Task 7 gives the Supervisor); the CLI verb in 4a's verbs' shape.

- [ ] **Step 4: Run** `verification.test.ts`, `goal-pass.test.ts` (4a's accept cases rewritten: acceptance now needs a `concludeVerification` with all pass), `goal-delivery.test.ts`, `verify.test.ts`, `sweep.test.ts`, `cli.test.ts` (one at a time) + `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(conductor): a goal version is accepted only when every requirement passes; a failure reworks its package`.

---

### Task 7: The conductor is told -- `verification_failed` and `goal_needs_human`

**Files:**
- Modify: `packages/domain/src/supervisor/world.ts` (`SupervisorGoalDelivery`, `SupervisorWorld.goalDeliveries`)
- Modify: `packages/control/src/supervisorWorld.ts` (load them; D13 question filter)
- Modify: `packages/domain/src/supervisor/observe.ts`, `packages/domain/src/supervisor/candidates.ts` (explicit cases, comments), `packages/domain/src/supervisor/policy.ts` (`chooseByRules`: `verification_failed` → `no_action`)
- Modify: `packages/domain/test/supervisor/fixtures.ts` (`goalDeliveries: []`)
- Test: `packages/domain/test/supervisor/observe.test.ts`, `candidates.test.ts`, `policy.test.ts`, `packages/control/test/integration/supervisorWorld.test.ts`

**Interfaces:**
- Produces:
```ts
/** Conductor Plan 4b (spec R11): a conducted goal version still open, and its latest verification.
 *  LOADER CONTRACT: every `GoalDelivery` of the workspace whose status is `integrating`, `verifying`
 *  or `needs_human`, and every `accepted` one with `mergedAt` null and `mergeError` set. */
export interface SupervisorGoalDelivery {
  readonly goalVersion: number
  readonly status: 'integrating' | 'verifying' | 'accepted' | 'needs_human'
  readonly round: number
  readonly needsHumanReason: string | null
  readonly mergeError: string | null
  readonly latestVerification: {
    readonly round: number
    readonly pass: number
    readonly fail: number
    readonly unverifiable: number
    readonly failedKeys: readonly string[]
  } | null
}
```
  `SupervisorWorld.goalDeliveries: readonly SupervisorGoalDelivery[]`.

- [ ] **Step 1: Failing tests**
  - observe: a `needs_human` delivery → one `goal_needs_human`, `subjectId` `${workspaceId}:v1`, summary contains the reason; an `accepted` one with `mergeError` → `goal_needs_human` whose summary says the merge failed; an `integrating` delivery whose `latestVerification.round === round` and `fail: 2` → one `verification_failed`, subject `${workspaceId}:v1:r1`, facts `{ goalVersion: 1, round: 1, failedKeys }`; the same with `latestVerification.round < round` (a new round under way) → none; `verifying` → none.
  - candidates: both kinds → `[escalate_to_human, no_action]`.
  - policy: `chooseByRules` over `verification_failed`'s candidates → the `no_action` index; over `goal_needs_human`'s → the escalation.
  - supervisorWorld integration: two deliveries (one `needs_human`, one merged) and three `VerificationResult` rows of round 2 (pass, fail, fail) for the first → `goalDeliveries` has one entry with `latestVerification { round: 2, pass: 1, fail: 2, failedKeys: [...] }`.
  - supervisorWorld (D13): a report question (`idempotencyKey` `report:<run>:0`, no reply) on a task now `cancelled` → not in `world.questions`; on a task whose goal delivery is `accepted` → not in it; on a live task → still in it.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement.** Observe (after `foreign_file`'s block):
```ts
  // goal_needs_human / verification_failed (Conductor Plan 4b, R11). The first is a person's to
  // decide -- the loop has stopped. The second is news, not a request: its packages are already in
  // rework, so the rules record `no_action` (plan D10). One per round, by subject.
  for (const delivery of world.goalDeliveries) {
    const v = String(delivery.goalVersion)
    if (delivery.status === 'needs_human' || (delivery.status === 'accepted' && delivery.mergeError !== null)) {
      const reason = delivery.status === 'needs_human' ? (delivery.needsHumanReason ?? 'the loop stopped') : `its merge into the base branch failed: ${delivery.mergeError ?? ''}`
      add({
        kind: 'goal_needs_human',
        subjectId: `${world.workspaceId}:v${v}`,
        summary: `Goal v${v} needs a person: ${reason}`,
        facts: { goalVersion: delivery.goalVersion, reason },
      })
      continue
    }
    const latest = delivery.latestVerification
    if (delivery.status === 'integrating' && latest !== null && latest.round === delivery.round && latest.fail > 0) {
      add({
        kind: 'verification_failed',
        subjectId: `${world.workspaceId}:v${v}:r${String(latest.round)}`,
        summary: `Goal v${v}'s verification round ${String(latest.round)} failed ${latest.failedKeys.join(', ')}; their packages are reworking.`,
        facts: { goalVersion: delivery.goalVersion, round: latest.round, failedKeys: [...latest.failedKeys] },
      })
    }
  }
```
(Check `add`'s `facts` type accepts a string array; if facts are scalar-only, join the keys.) Candidates: explicit `case 'verification_failed':` and `case 'goal_needs_human':` with `break` and a comment each (no grant, no hire: the remedy is the loop, or a person's `retry-goal`/`abandon-goal`). `chooseByRules`, before the routine scan:
```ts
  // Conductor Plan 4b (D10): news, not a request. The loop is already acting on it.
  if (situationKind === 'verification_failed') {
    const quiet = cands.findIndex((candidate) => candidate.action.kind === 'no_action')
    if (quiet !== -1) return quiet
  }
```
Loader: `prisma.goalDelivery.findMany` with the contract's `where`, then one `groupBy`/query over `VerificationResult` for those delivery ids at their max round (a `findMany` ordered by `round desc` and reduced in TypeScript is fine — a handful of rows). D13: where the loader builds `questions` (`supervisorWorld.ts` ~1210, `stillPendingQuestion`), read the question tasks' `status` and `workPackage.goalVersion` and the workspace's closed deliveries, and drop a question whose `idempotencyKey` starts with `report:` and whose task is `failed`/`cancelled` or whose version's delivery is `accepted`/`abandoned`:
```ts
  // Conductor Plan 4b (D13, deferred Plan 2 item): a report question to the conductor is answered
  // into the seat's next run ON THAT TASK. A task that is over, or whose goal version is accepted or
  // abandoned, has no next run, so the question is no longer pending for anybody.
  const closedVersions = new Set(
    (await tx.goalDelivery.findMany({ where: { workspaceId, status: { in: ['accepted', 'abandoned'] } }, select: { goalVersion: true } })).map((d) => d.goalVersion),
  )
  const questionTasks = new Map(
    (await tx.task.findMany({ where: { id: { in: reportQuestionTaskIds } }, select: { id: true, status: true, workPackage: { select: { goalVersion: true } } } })).map((t) => [t.id, t] as const),
  )
  const stillUseful = (taskId: string | null): boolean => {
    const task = taskId === null ? undefined : questionTasks.get(taskId)
    if (task === undefined) return true
    if (task.status === 'failed' || task.status === 'cancelled') return false
    return task.workPackage === null || !closedVersions.has(task.workPackage.goalVersion)
  }
```
(Adapt the client (`tx`/`prisma`) and the question row's field names to the loader as it stands; `reportQuestionTaskIds` = the task ids of the loaded questions whose key starts with `report:`.) m54/m55 world-key gates are left as they are (plan "Left out").

- [ ] **Step 4: Run** `npx vitest run packages/domain/test/supervisor`, `supervisorWorld.test.ts`, `enum-parity.test.ts` + `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(supervisor): a failed verification round is reported, a goal that needs a person is escalated`.

---

### Task 8: New projects are conducted

**Files:**
- Modify: `packages/control/src/workspace.ts` (`CreateWorkspaceInput.delivery`, the create)
- Modify: `packages/domain/src/intake/draft.ts` (`delivery` with default `'conducted'`)
- Modify: `packages/control/src/intake.ts` (`createWorkspace` gets `delivery: draft.delivery`; the staff step for a conducted draft)
- Modify: `apps/orchestrator/src/cli.ts` (`create-workspace --delivery`, help text)
- Modify: `packages/db/prisma/schema.prisma` (the `Delivery` enum's doc comment only)
- Modify (gates that drive the planner after creating a project — decide per gate, below): `scripts/gate-m23-onboarding.mjs`, `scripts/gate-m33-adopt.mjs`, `scripts/gate-m42-catalog-import.mjs`, `scripts/gate-m46-workforce-catalog.mjs`, `scripts/gate-m59-intake.mjs`
- Test: `packages/control/test/integration/create-workspace.test.ts`, `packages/control/test/integration/intake-accept.test.ts`, `apps/orchestrator/test/integration/cli.test.ts`, `apps/orchestrator/test/integration/catalog-person-pool-flow.test.ts`, `apps/web/test/integration/intake-routes.test.ts`, `packages/domain/test/intake/*.test.ts` (draft schema)

**Interfaces:**
- Produces: `CreateWorkspaceInput.delivery?: 'conducted' | 'planned'` (absent → `'conducted'`); `intakeDraftSchema.delivery` (`z.enum(['conducted', 'planned']).default('conducted')`); CLI `create-workspace … [--delivery conducted|planned]`.

- [ ] **Step 1: Failing tests**
  - `create-workspace.test.ts`: no `delivery` → the row is `conducted`; `delivery: 'planned'` → `planned`.
  - `cli.test.ts`: `create-workspace` without the flag → `conducted`; with `--delivery planned` → `planned`; `--delivery x` → refused.
  - Draft schema: a draft without `delivery` parses to `'conducted'`; `'planned'` kept; `'x'` refused.
  - `intake-accept.test.ts`: a conducted draft whose team has an engineer seat and a reviewer seat → ONE seat staffed, the reviewer's template, holding `reviewer` AND `verifier`; a `planned` draft → today's seats (update the existing tests' drafts to say `delivery: 'planned'` where they assert today's staffing).
  - Existing tests that create through `createWorkspace`/`acceptIntake` and then plan (`catalog-person-pool-flow.test.ts`, `intake-routes.test.ts`): pass `planned` explicitly where they rely on the planner; leave the rest.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement**
  - `createWorkspace`: `delivery: input.delivery ?? 'conducted',` in the create's `data`, with a comment: "Conductor Plan 4b (spec §5, D11): new projects are conducted. Written here, not as the column's default: the column stays `planned` so every row inserted outside this function -- the seed, 139 test files -- keeps today's planner, and every product path that creates a project goes through here."
  - Draft: the field with a doc comment in the `autoMerge` block's style ("the person's call, never the model's; a draft stored before this field reads as conducted, the product default").
  - `acceptIntake`: pass `delivery: draft.delivery`; in the staff step:
```ts
      // Conductor Plan 4b (spec R5, D4): a conducted project's implementers are staffed by the
      // conductor, one per package, once the goal is split. Intake staffs only the seat that
      // checks the work: the reviewer, who also verifies (reviewing is not implementing).
      const approved = ensureStaffRoles(draft.team, (await installationFacts()).catalogue)
      const seats =
        draft.delivery === 'conducted'
          ? approved
              .filter((seat) => seat.runtimeRoles.includes(REVIEWER_ROLE))
              .map((seat) => ({ ...seat, runtimeRoles: [...new Set([...seat.runtimeRoles, VERIFIER_ROLE])] }))
          : approved
```
  - CLI: `...(oneOfFlag(flags, 'delivery', ['conducted', 'planned'] as const) !== undefined ? { delivery: oneOfFlag(flags, 'delivery', ['conducted', 'planned'] as const) } : {})` (read once into a const), help text line.
  - Schema doc on `enum Delivery`: "Default for NEW projects is `conducted` since Conductor Plan 4b, set by `createWorkspace`; the column default stays `planned` for rows inserted anywhere else."
  - Gates: for each of m23, m33, m42, m46 (`create-workspace` through the CLI) and m59 (`intake accept --draft <file>`), read the gate: if after creating the project it sets a goal and expects a planning run, a planned board, or a `manager` seat, add `'--delivery', 'planned'` to its `create-workspace` argv (or `delivery: 'planned'` to the draft JSON it writes), with a one-line comment "this gate measures the planner; new projects are conducted since Conductor Plan 4b". A gate that only creates and inspects the project needs nothing. Run each gate you touched (gates DB, fake env) and m61 (`grep -n "delivery\|conduct" scripts/gate-m61-simple-mode.mjs`: it creates no project through these paths — confirm).

- [ ] **Step 4: Run** the tests above one file at a time + `npm run typecheck` + `npm run web:build && rm -rf apps/web/.next` (the web route and the intake card read the draft type) → PASS.

- [ ] **Step 5: Commit** — `feat(workspace): new projects are conducted, and intake staffs only the seat that checks the work`.

---

### Task 9: The fake CLI verifies, and a goal goes round the loop end to end

**Files:**
- Modify: `packages/providers/test/fake-claude.mjs` (a verification arm and a per-package work arm in `m8-flow`; header comment)
- Modify: `apps/orchestrator/test/integration/conductor-e2e.test.ts`
- Test: `packages/providers/test/fake-claude.test.ts` (or the file exercising the fake's arms — `grep -rln "report-json-base64" packages/providers/test apps/orchestrator/test`)

**Interfaces:**
- Produces (fake CLI, `m8-flow`):
  - Verification arm, taken when the prompt contains `<slave-verification>` (only the verification protocol section carries the literal tag; quoted copies elsewhere are neutralised): reads `Verification round N` and `Requirement keys: …` from the prompt; when `SLAVEOFAI_VERIFY_DIR` is set writes `check-<key>.sh` there for each key; answers with the items of `--verification-rounds-base64 <base64 JSON: items[][]>` at index `min(N, length) - 1`, or, without the flag, every key `pass` with `check: 'true'`. The answer is appended to the `complete` fixture's last assistant text and result text (the report arm's mechanics).
  - Per-package work arm, taken when `--package-work-base64 <base64 JSON: { [packageKey]: { file: string, report: object } }>` is present and the prompt contains `Your work package: "<key>"` for a key in it: writes `file` (creating directories), commits, and ends with that package's `<slave-report>`.

- [ ] **Step 1: Failing tests**
  - Fake arms (spawn the fake directly as the existing fake tests do): a prompt with `<slave-verification>`, `Verification round 2`, `Requirement keys: R1, R2` and a two-element rounds flag → the result text carries the SECOND element's block; with `SLAVEOFAI_VERIFY_DIR` set, `check-R1.sh` and `check-R2.sh` exist there; no flag → both keys `pass`. A prompt with `Your work package: "config"` and the package flag → `src/config.py` committed, the `config` report appended.
  - e2e, `single`: the existing test now also asserts — one `verification` run by a seat that is not the package seat and holds `verifier`; two `VerificationResult` rows `pass`; `check-R1.sh` in that run's `<runDir>/verify`; no `verify-*` worktree left under `worktreeRootFor(repo)`; `workspace.goal_accepted { rounds: 1 }` then `workspace.goal_merged`.
  - e2e, `partitioned` (packages `report` owns `src/report/**` with R1, `config` owns `src/config.py` with R2, as `conductor.test.ts`'s answer; `--package-work-base64` giving each its file and report; `--verification-rounds-base64` = round 1: R1 pass, R2 fail; round 2: both pass) → the `config` task has two implementation runs and the `report` task one; `config`'s second run's prompt contains `Verification round 1` (its rejection section); the delivery `accepted` with `rounds: 2` and merged; `main` has both files.
  - e2e, `unverifiable`: round 1 R2 `unverifiable` → `needs_human`; `loadSupervisorWorld` + `observe` raise `goal_needs_human` for v1; `retryGoal` → the next ticks run round 2 (rounds flag's second element: all pass) → accepted.
  - e2e, cap: `verificationRoundCap: 2`, rounds flag R2 fail twice → `needs_human` after round 2 with the cap in the reason; the `config` task ran twice (its first run, and one rework after round 1; round 2's failure spends the cap, so no rework follows it).

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** the two arms in the fake's `m8-flow` branch, after the `"verdict"` check and before `workFixtureArm`, in the file's style (a WHY header comment each, `flagValue`, `readFixtureLines('complete')`, `appendToLastAssistantText` + `appendToResultText`, `process.exit(0)`); document both flags in the header's flag list. Update the e2e file's header comment (the "single only" limitation is gone).

- [ ] **Step 4: Run** the fake's test file, then `conductor-e2e.test.ts` → PASS.

- [ ] **Step 5: Commit** — `test(conductor): a goal is verified, reworked where it fails, and accepted end to end`.

---

### Task 10: Whole suite, web build, gates

- [ ] **Step 1:** stop any daemon; no `next dev`. `npm run typecheck`, then `npx vitest run > /tmp/claude-1001/4b-suite.log 2>&1` in the background (~15 min); wait on the log's summary line, not on `pgrep`. Re-run any failing file alone before believing it.
- [ ] **Step 2:** `npm run web:build && rm -rf apps/web/.next`; `node scripts/gate-m26-vocabulary.mjs`.
- [ ] **Step 3:** `DATABASE_URL="$GATE_DATABASE_URL" npm run db:migrate`; the CI gate list with the fake-CLI env exactly as ci.yml sets it and `DATABASE_URL="$GATE_DATABASE_URL"`, under `systemd-inhibit --what=sleep:idle`, `CHROMIUM_PATH` pointed at the installed chromium. Known red on main: m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58. m56a must be green (stage 2: sixteen permission files; stage 12: 24 situations, 73 lanes, the hook-plane digests UNCHANGED). m23, m33, m42, m59, m61 must be green (Task 8). Any other red gate is compared against the same gate on main before it is called pre-existing.

---

## Self-review notes (for the executor)

- Spec coverage: R8 run kind → Task 2; verifier seat that implemented nothing → Task 4 (+ intake, Task 8); fresh worktree of the integration branch → Task 5; `$SLAVEOFAI_VERIFY_DIR` → Tasks 2, 5; permissions (read, run, write only outside the repo) → Tasks 2, 5 (D1); prompt (requirements, integrated diff summary, the rule) → Tasks 3, 5; `<slave-verification>` → Task 3; `VerificationResult` with check and trimmed output → Tasks 1, 6. R9 all-pass acceptance, fail → owning package's rework with check/output/reason, unverifiable blocks, round cap + budget → `needs_human` → Task 6 (budget: D8); dispatched after all packages integrated and after each rework round → Task 6's goal pass. R11 `verification_failed`, `goal_needs_human`, world gains verification results → Task 7. §5 conducted default → Task 8. R5 "intake staffs only the verifier seat" → Task 8. Deferred Plan 2 items: report questions (D13, Task 7) folded in; m54/m55 counts left out; the waiting trip was folded into Plan 4a.
- Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10. Task 5's tests use the `env-echo` fake; Task 9 gives `m8-flow` the verification arm the end-to-end tests need.
- Type names used across tasks: `VerificationItem`, `parseSlaveVerification`, `renderVerificationGoal`, `renderVerificationProtocol`, `renderVerificationRework`, `VERIFICATION_INSTRUCTIONS`, `VERIFIER_ROLE`, `staffVerifier`, `implementersOf`, `dispatchVerification`, `concludeVerification`, `releaseVerification`, `verificationOwnership`, `verifyDirPathFor`, `verifyDirIfPresent`, `provisionDetachedWorktree`, `removeVerificationWorktree`, `retryGoal`, `SupervisorGoalDelivery`.
