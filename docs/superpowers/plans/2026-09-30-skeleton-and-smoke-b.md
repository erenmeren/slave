# Skeleton and smoke, Plan B of 2: the smoke gate

> **For workers carrying this out:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec S7 and the rest of S8 and S9. Once every package of a goal version is integrated, and before its verification run, the orchestrator runs `bash scripts/smoke.sh` itself, with no model, in a fresh detached checkout of the integration tip. The run is bounded, constrained, recorded, and routed. A stub or missing script sends the skeleton back to rework. Any other failure or a timeout sends the integration package back. Each failed attempt spends a verification round, and at the cap the version ends `needs_human`. A passing smoke's output goes to the verifier as evidence. The report page and the Markdown export list every smoke attempt and every denied tool call.

**Architecture:** A new table `SmokeAttempt` holds one row per attempt: its round, the commit it checked, its outcome, exit code, duration and trimmed output, the pid of its process group, and the process that owns it. `GoalDelivery.activeSmokeId` is the claim, the `activeRunId` idiom: a unique column, taken under the delivery's advisory lock, and never held while the script runs. The attempt runs in the background (`apps/orchestrator/src/smoke.ts`), registered in the tick's `pumps` set, so a tick never waits up to 15 minutes. Its conclusion (`applySmokeOutcome`) takes the lock only to record the event and move the delivery. The goal pass starts a smoke where it used to start a verification run whenever the version's delivery has `smokeRequired`. That flag is true for a delivery whose requirement set holds `RUN` (Plan A). The verification run is dispatched only once a passing attempt exists for the integration branch's current tip.

**Tech Stack:** TypeScript monorepo (npm workspaces, ESM, `.js` import suffixes), Prisma/Postgres, git worktrees, bash, process groups, vitest (+ jsdom/Testing Library for web), Next.js (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-09-29-skeleton-and-smoke-design.md` (S7; S8's smoke output; S9's "listed on the report page"; §4; §5; §6). **Requires Plan A** (`2026-09-30-skeleton-and-smoke-a.md`) merged first: `RUN_REQUIREMENT_KEY`, `SKELETON_PACKAGE_KEY`, `SMOKE_SCRIPT_PATH`, `SMOKE_CONTRACT_LINES`, `SMOKE_STUB_MESSAGE`, `SMOKE_STUB_EXIT_CODE`, `WorkerLead`, and the verification prompt's leads.

## Decisions this plan makes (read before starting)

- **D1. The lock is held for milliseconds, never for the smoke run.** `startSmoke` takes the delivery lock to claim and to insert the attempt row, and nothing else. The claim is a guarded `updateMany` on `activeRunId: null, activeSmokeId: null`, and a lost race inside the lock throws, so the inserted row rolls back. The script then runs outside every transaction. `applySmokeOutcome` takes the lock again to write `workspace.smoke_run` and move the delivery, in the Plan 4b order: events first, each only if missing, then the guarded moves. *Cost if wrong:* nothing. `withDeliveryLock`'s own 120 s transaction timeout would fail a lock held for a 15-minute smoke run.
- **D2. One attempt per claim, and the claim excludes a verification run and a second smoke.** `activeSmokeId` is `@unique`. `startSmoke` refuses a delivery holding either claim. `dispatchVerification`'s claim also requires `activeSmokeId: null`. Each process keeps the attempts it runs in `activeSmokeIds`, the `activePumpRunIds` idiom. Two overlapping ticks, a daemon and a CLI `tick`, therefore start at most one attempt, and the loser writes nothing.
- **D3. A failed attempt spends a round; an attempt that could not run does not.** A new round's smoke moves the delivery `integrating → verifying` with `round + 1`, exactly as a new verification round did. The verification run that follows a passing smoke is part of the same round: it is dispatched through the existing "same round, no claim" path, which does not increment. `stub`, `missing`, `failed` and `timed_out` release the claim and either rework (`verifying → integrating`) or, at `round - roundBase >= verificationRoundCap`, end `needs_human` with the trimmed output in the reason. `error` is the orchestrator's own failure: no worktree, no spawn, a stranded attempt. It releases the claim and counts one `roundRunFailures`, the same counter and cap (`VERIFICATION_RUN_RETRY_CAP`) that unusable verification runs use (Plan 4b D7), so the next pass tries the same round again.
- **D4. Rework routing is deterministic and never reads the output.** `missing` and `stub` go to the `skeleton` package's task. `failed` and `timed_out` go to the `integration` package's task. In `single` mode both go to the one package. A plan from before Plan A has no skeleton, so `missing`/`stub` fall back to integration. The task goes `done → rework` with `integratedAt` cleared and the smoke's reason as `lastRejectionReason`, and no attempt is charged (Plan 4b D5). `task.rework` carries `verificationRound`. A target task that is not `done` ends the version `needs_human`, with the `blocked_package` remedy. The rework reason for `failed`/`timed_out` tells the integration worker that a fix in another package's file goes in its report's questions, not in the file (spec §7's shared-file risk; OBS-18 is the Supervisor-as-conductor spec's).
- **D5. A passing smoke is reused while the tip is the one it passed on.** The verification run is dispatched only when a `passed` attempt exists whose `tip` equals the integration branch's current tip. A same-round retry after an unusable verification run therefore does not rerun the smoke. A `retry-goal` of an unchanged tree skips the smoke and starts the new round's verification directly. Any merge onto the branch (a rework) moves the tip and requires a new smoke. *Cost if wrong:* a smoke that is flaky on an unchanged tip is not rerun on a retry. The verifier's own RUN check (Plan A D10) still runs.
- **D6. The attempt runs in a fresh detached checkout with no setup commands, in the constrained environment.** The worktree is `verify-smoke-<id8>` under `worktreeRootFor(repo)`. The `verify-` prefix means `removeVerificationWorktree` removes it unchanged. The worktree is checked out at the claimed tip SHA and removed after every attempt. `setupCommands` are not run: the smoke's job is to start the product the way a person following the README would, from a clean clone. The environment is `CHILD_ENV_ALLOW` plus `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_CONTEXT` and `XDG_RUNTIME_DIR` when the daemon has them, plus `SLAVEOFAI_SMOKE_PROJECT=slaveofai-smoke-<id12>`. `DATABASE_URL` and operator keys are absent. `bash scripts/smoke.sh` runs through `runShellCommand` (its own process group, SIGTERM then SIGKILL at `Workspace.smokeTimeoutMs`, default 900 000). After every attempt a best-effort `docker compose -p <project> down -v --remove-orphans` plus `docker rm -f` of containers named with the project prefix runs, when `docker` exists, bounded at 2 minutes. That cleans up containers a killed script started outside its process group (OBS-16).
- **D7. "Missing" means no regular file at `scripts/smoke.sh` in the checkout; the executable bit is not required.** The script is run as `bash scripts/smoke.sh`, so a missing `+x` does not stop it. `stub` is exit code `SMOKE_STUB_EXIT_CODE` (2) with `SMOKE_STUB_MESSAGE` in the output. Every other non-zero exit, and a death by signal, is `failed`.
- **D8. A stranded attempt is settled by the goal pass.** A claim whose attempt row is gone is released as `error`. So is a `running` attempt that this process does not run and whose owner is this process or a dead process (`ownerGone`), and one older than `smokeTimeoutMs + SMOKE_STRANDED_GRACE_MS` (60 s) whatever its owner. Its process group is killed (`-pid`, SIGKILL) if it is still alive, and its worktree is removed. An attempt that already has an outcome but still holds the claim (a crash between the two writes) is applied again: `applySmokeOutcome` is replay-safe.
- **D9. `abandon-goal` clears the smoke claim and signals its process group.** The attempt finishes, because its script's `trap` runs on SIGTERM. The attempt records what happened. Its conclusion finds the delivery `abandoned` and moves nothing.
- **D10. The report lists every attempt and every denied tool call of the version.** `GoalReport.smoke` lists every `SmokeAttempt` of the delivery, oldest first, with round, outcome, exit code, duration, the commit, the trimmed output and the package it reworked. `GoalReport.deniedToolCalls` lists the `guardrail.tripped { guardrail: 'permission_mode' }` and `run.tool_denied` events of the version's runs (its package tasks' runs and its verification runs), oldest first, capped at 200 with the rest counted. The Markdown gains "Smoke checks" after "Verification rounds" and "Denied tool calls" after "Packages". The page gains the same two panels. The trail gains a sentence per `workspace.smoke_run`.
- **Left out on purpose:** a settings surface for `smokeTimeoutMs` (the column and its default only); a Supervisor situation for a failed smoke (a failed smoke reworks automatically, and its cap is `goal_needs_human`, which already exists); running `setupCommands` before the smoke (D6); smoke checks for planned (non-conducted) delivery (spec §4); a version's smoke after its final merge (Plan 4a D9's reasoning).

## Global Constraints

- Vocabulary: the product says "slave", never "agent" (`node scripts/gate-m26-vocabulary.mjs`). Never write the string "agency-agents" anywhere tracked.
- Never run prettier. The repository has no prettier config, and `prettier --write` reformats against the codebase's style. Match surrounding code: WHY doc comments, `readonly`, explicit return types, `.js` import suffixes (not in `apps/web`), `Result`/`ok`/`err`.
- Tests: `set -a; . ./.env; set +a; export DATABASE_URL=$TEST_DATABASE_URL` in the shell first. That export also applies to any scratch Prisma script: a script's `PrismaClient` reads `DATABASE_URL`, which is the dev DB unless exported. Run ONE vitest process at a time. Iterate per file. Run `npx tsc --build` after changing a package that another package's test imports. Run `npm run typecheck` before every commit, not `tsc --build`: the script also checks every `tsconfig.test.json` and `apps/web`. Run the whole suite once, at the end, in the background.
- `apps/web` changes gate on `npm run web:build`, with no `next dev` running, then `rm -rf apps/web/.next`.
- Never touch the dev DB. Never `db:seed`. Gates run only on `DATABASE_URL="$GATE_DATABASE_URL"`, with the fake-CLI env exactly as `.github/workflows/ci.yml` sets it (`SLAVEOFAI_CLAUDE_BIN`/`SLAVEOFAI_CURSOR_BIN` from `scripts/gate-fakes`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`), with the host daemon stopped, under `systemd-inhibit --what=sleep:idle`. Red on main today, not regressions: m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58.
- Migrations: hand-written, purely additive, WHY header, dated name; `npm run db:generate && npm run db:migrate:test`. The schema must mirror the SQL exactly, or m56a stage 12's `prisma migrate diff` fails.
- Inside a Prisma interactive transaction a refusal must THROW to roll back; a returned value commits what was written. This matters in `startSmoke`: the attempt row is inserted before the claim's guarded update.
- `vi.spyOn` on a Prisma delegate breaks later tests: assign a wrapper and restore it in `finally`.
- Never `TRUNCATE "SlaveTemplate" CASCADE` in a test; delete your own template rows by id.
- The hook plane (`scripts/pause-gate.sh`, `scripts/cursor-shell-gate.sh`, `scripts/tool-result-tap.sh`, `scripts/lib/pause-flag.sh`, `scripts/lib/permissions.sh`) does not change; m56a stage 12 pins their digests. This plan adds one event type (`LANE_BY_TYPE` 73 → 74) and no situation kind (24).
- Every commit message ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec S7 verbatim: "When every package of a goal version is integrated and before the verification run is dispatched, the orchestrator runs `bash scripts/smoke.sh` in a fresh detached worktree of the integration branch tip, without a model: bounded by `Workspace.smokeTimeoutMs` (default 15 minutes); the process group is killed on timeout and the worktree is removed afterwards, pass or fail; the same constrained environment a run gets (allow-listed env, own process group), plus `SLAVEOFAI_SMOKE_PROJECT`; recorded as one event per attempt (`workspace.smoke_run` with exit code, duration and trimmed output), shown on the report page; pass → the verification run is dispatched as today, and the smoke output is handed to the verifier as evidence (S8); the script missing, not executable, or exiting 2 with the stub's message → the `skeleton` package's task goes back to rework (single: the single task) with the output; any other non-zero exit or a timeout → the `integration` package's task (single: the single task) goes back to rework with the trimmed output; each failed smoke attempt counts as a verification round against the same round cap; at the cap the version ends `needs_human` with the smoke output in the reason. A smoke that cannot even start (the orchestrator's own failure: worktree, spawn) is retried like an unusable verification (Plan 4b D7), not charged to a package."

## Review Focus

- A smoke script that backgrounds a server and exits 0 without stopping it, or a script that times out after starting `docker compose up`. The server's process group is killed at the timeout, the compose project is brought down by name, the worktree is gone, and the next attempt's port check finds the port free (Task 3 timeout test; cleanup in D6).
- The daemon restarts mid-smoke. The next goal pass finds a `running` attempt owned by a dead process, kills its group if it is alive, records `error`, counts one run failure, and starts the same round again. It is never charged as a round (Task 3 stranded test).
- A person abandons the version during a 10-minute smoke. The process group gets SIGTERM, and the attempt's conclusion lands nowhere: no rework, no `needs_human`, no event after `workspace.goal_abandoned` except the attempt's own `workspace.smoke_run` (Task 4 test).
- A smoke script that prints megabytes, or prints `<slave-verification>`/`<slave-report>` markers. The stored and event output is bounded (4000 chars, head and tail), and in the verifier's prompt and the rework prompt it is sanitised text that cannot forge a block (Task 2 + Task 5 tests).
- A `retry-goal` on a version stopped for an unverifiable item, with an unchanged tree. No new smoke runs, and the verification round starts at once, with the earlier passing smoke's output as evidence (Task 4 test).

---

### Task 1: The smoke's data and its event

**Files:**
- Create: `packages/db/prisma/migrations/20260930130000_smoke_gate/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (`enum SmokeOutcome`, `model SmokeAttempt`, `GoalDelivery.activeSmokeId`/`smokeRequired`/`smokes`, `Workspace.smokeTimeoutMs`/`smokeAttempts`, `EventType.workspace_smoke_run`)
- Modify: `packages/db/src/enums.ts:48-51` (`'workspace.smoke_run': 'workspace_smoke_run'` after `workspace.goal_retried`)
- Modify: `packages/domain/src/conduct/constants.ts` (`SMOKE_OUTCOMES`, `SmokeOutcome`, `SMOKE_TIMEOUT_MS_DEFAULT`, `SMOKE_OUTPUT_MAX_CHARS`, `SMOKE_STRANDED_GRACE_MS`)
- Modify: `packages/domain/src/events/schema.ts:540-552` (the variant after `workspace.goal_retried`)
- Modify: `packages/domain/src/supervisor/timeline.ts:57` (`LANE_BY_TYPE['workspace.smoke_run'] = 'verified'`)
- Modify: `apps/web/src/components/activity/cards.tsx` (`WorkspaceSmokeRunCard`, registered after `workspace.goal_retried`), `apps/web/src/lib/activityFilters.ts:110-113`, `apps/web/src/server/timeline.ts:345-355` (`titleFor` case)
- Modify: `scripts/gate-m56a-provider-contract.mjs:1240-1258` (73 → 74, comment)
- Test: `packages/domain/test/events/conductor-events.test.ts`, `packages/domain/test/supervisor/timeline.test.ts:18-19` (73 → 74), `apps/web/test/activity-cards.test.tsx:100` (`PAYLOAD_BY_TYPE`), `packages/db/test/integration/enum-parity.test.ts`

**Interfaces:**
- Produces (Prisma): `enum SmokeOutcome { running passed missing stub failed timed_out error }`; `model SmokeAttempt { id, workspaceId, goalDeliveryId, goalVersion Int, round Int, tip String, status SmokeOutcome @default(running), exitCode Int?, signal String?, durationMs Int?, output String @default(""), pid Int?, ownerInstance String?, worktreePath String?, reworkedTaskId String?, startedAt DateTime @default(now()), endedAt DateTime? }`, cascading from `Workspace` and `GoalDelivery`, `@@index([goalDeliveryId, startedAt])`. `GoalDelivery.activeSmokeId String? @unique`, `GoalDelivery.smokeRequired Boolean @default(false)`. `Workspace.smokeTimeoutMs Int @default(900000)`.
- Produces (domain): `SMOKE_OUTCOMES = ['running', 'passed', 'missing', 'stub', 'failed', 'timed_out', 'error'] as const`, `type SmokeOutcome`, `SMOKE_TIMEOUT_MS_DEFAULT = 900_000`, `SMOKE_OUTPUT_MAX_CHARS = 4000`, `SMOKE_STRANDED_GRACE_MS = 60_000`.
- Produces (event): `workspace.smoke_run { version: int>0, round: int>0, attemptId: string, outcome: 'passed'|'missing'|'stub'|'failed'|'timed_out'|'error', exitCode: int|null, durationMs: int>=0, output: string<=4000, reworkedPackage: string|null }`.

- [ ] **Step 1: Migration**

```sql
-- Skeleton spec S7, 2026-09-30: the smoke gate. Before a goal version is verified the orchestrator
-- runs the project's own `scripts/smoke.sh` -- no model -- in a fresh checkout of the integration
-- tip, and a version is accepted only after a passing one.
--
-- `SmokeAttempt` is one attempt: its round, the commit it checked, its outcome, exit code, duration
-- and trimmed output, the process group it ran in and the process that owns it (so a daemon that
-- died mid-smoke can be told from one still running it). `GoalDelivery.activeSmokeId` is the claim
-- (the `activeRunId` idiom); `smokeRequired` is set for a delivery whose requirement set carries
-- RUN, so versions conducted before this migration are verified as they were.
-- `Workspace.smokeTimeoutMs` bounds one attempt (spec: 15 minutes). PURELY ADDITIVE: one enum type,
-- one table, defaulted or nullable columns, one enum value unused inside this transaction.

CREATE TYPE "SmokeOutcome" AS ENUM ('running', 'passed', 'missing', 'stub', 'failed', 'timed_out', 'error');

CREATE TABLE "SmokeAttempt" (
    "id"             TEXT NOT NULL,
    "workspaceId"    TEXT NOT NULL,
    "goalDeliveryId" TEXT NOT NULL,
    "goalVersion"    INTEGER NOT NULL,
    "round"          INTEGER NOT NULL,
    "tip"            TEXT NOT NULL,
    "status"         "SmokeOutcome" NOT NULL DEFAULT 'running',
    "exitCode"       INTEGER,
    "signal"         TEXT,
    "durationMs"     INTEGER,
    "output"         TEXT NOT NULL DEFAULT '',
    "pid"            INTEGER,
    "ownerInstance"  TEXT,
    "worktreePath"   TEXT,
    "reworkedTaskId" TEXT,
    "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt"        TIMESTAMP(3),

    CONSTRAINT "SmokeAttempt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SmokeAttempt_goalDeliveryId_startedAt_idx" ON "SmokeAttempt"("goalDeliveryId", "startedAt");
ALTER TABLE "SmokeAttempt" ADD CONSTRAINT "SmokeAttempt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SmokeAttempt" ADD CONSTRAINT "SmokeAttempt_goalDeliveryId_fkey" FOREIGN KEY ("goalDeliveryId") REFERENCES "GoalDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GoalDelivery" ADD COLUMN "activeSmokeId" TEXT;
CREATE UNIQUE INDEX "GoalDelivery_activeSmokeId_key" ON "GoalDelivery"("activeSmokeId");
ALTER TABLE "GoalDelivery" ADD COLUMN "smokeRequired" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Workspace" ADD COLUMN "smokeTimeoutMs" INTEGER NOT NULL DEFAULT 900000;

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.smoke_run';
```

Mirror it in `schema.prisma` with `///` doc comments in the file's style: `SmokeAttempt` after `VerificationResult`; the back relations `smokes SmokeAttempt[]` on `GoalDelivery` and `smokeAttempts SmokeAttempt[]` on `Workspace`; `workspace_smoke_run @map("workspace.smoke_run")` after `workspace_goal_retried`, with a `///` line ("Skeleton spec S7: one smoke attempt concluded -- its outcome, exit code, duration, trimmed output, and the package it sent back"). Then `npm run db:generate && npm run db:migrate:test`.

- [ ] **Step 2: Failing tests**
  - `conductor-events.test.ts`: `workspace.smoke_run` parses with `{ version: 1, round: 2, attemptId: 'a1', outcome: 'failed', exitCode: 1, durationMs: 1200, output: 'npm error Missing script: "start"', reworkedPackage: 'integration' }`; it is refused with `outcome: 'running'` and with an `output` of 4001 characters.
  - `timeline.test.ts`: `toHaveLength(73)` → `74`, and the title → `'lanes every event type -- 74 as of skeleton-and-smoke Plan B Task 1'`.
  - `activity-cards.test.tsx`: `PAYLOAD_BY_TYPE` gains `'workspace.smoke_run': { version: 1, round: 2, attemptId: 'a1', outcome: 'failed', exitCode: 1, durationMs: 1200, output: 'npm error Missing script: "start"', reworkedPackage: 'integration' },`, plus a case:

    ```tsx
      it('workspace.smoke_run says how the smoke check ended and who was sent back', () => {
        const Card = ACTIVITY_CARDS['workspace.smoke_run']
        render(<Card event={baseEvent('workspace.smoke_run', { version: 1, round: 2, attemptId: 'a1', outcome: 'failed', exitCode: 1, durationMs: 1200, output: 'npm error Missing script: "start"', reworkedPackage: 'integration' })} {...CARD_PROPS} />)
        expect(screen.getByText('goal v1 round 2: the smoke check failed (exit 1); integration sent back')).toBeTruthy()
        expect(screen.getByTestId('smoke-run-output').textContent).toContain('Missing script: "start"')
      })
    ```
  - `enum-parity.test.ts` (import `SMOKE_OUTCOMES` from `@slave-of-ai/domain`):

    ```ts
      it('SmokeOutcome matches SMOKE_OUTCOMES, member for member', async () => {
        expect(await enumValues('SmokeOutcome')).toEqual([...SMOKE_OUTCOMES].sort())
      })
    ```

- [ ] **Step 3: Run to see them fail.**

- [ ] **Step 4: Implement**
  - `constants.ts`:

    ```ts
    /** Skeleton spec S7: one smoke attempt's life. `running` until it concludes; `error` is the
     *  orchestrator's own failure (no worktree, no spawn, stranded) and is never charged to a package. */
    export const SMOKE_OUTCOMES = ['running', 'passed', 'missing', 'stub', 'failed', 'timed_out', 'error'] as const
    export type SmokeOutcome = (typeof SMOKE_OUTCOMES)[number]

    /** `Workspace.smokeTimeoutMs`' default (spec S7: 15 minutes) -- a Docker image build fits. */
    export const SMOKE_TIMEOUT_MS_DEFAULT = 900_000

    /** A smoke attempt's output as stored, sent in its event and shown -- head and tail kept (`trimEvidence`). */
    export const SMOKE_OUTPUT_MAX_CHARS = 4000

    /** Past its timeout plus this, a `running` attempt nobody is running is stranded (plan B D8). */
    export const SMOKE_STRANDED_GRACE_MS = 60_000
    ```
  - The zod variant, after `workspace.goal_retried`:

    ```ts
      // Skeleton spec S7: one smoke attempt concluded. `reworkedPackage` is the package sent back for
      // it, null for a pass, an orchestrator error, or a failure the round cap stopped.
      z.object({
        ...envelope,
        type: z.literal('workspace.smoke_run'),
        payload: z.object({
          version: z.number().int().positive(),
          round: z.number().int().positive(),
          attemptId: z.string().min(1),
          outcome: z.enum(['passed', 'missing', 'stub', 'failed', 'timed_out', 'error']),
          exitCode: z.number().int().nullable(),
          durationMs: z.number().int().nonnegative(),
          // `SMOKE_OUTPUT_MAX_CHARS`, spelled here the way this file spells every stored bound.
          output: z.string().max(4000),
          reworkedPackage: z.string().min(1).nullable(),
        }),
      }),
    ```
  - `LANE_BY_TYPE`: `'workspace.smoke_run': 'verified', // Skeleton spec S7: the smoke check is the first half of a verification round.`
  - Card:

    ```tsx
    /** Skeleton spec S7: one smoke attempt. `working` when it passed, `danger` when a package was sent
     *  back or the version stopped, `warn` for the orchestrator's own failure (retried, not charged). */
    function WorkspaceSmokeRunCard(props: ActivityCardProps): ReactElement {
      const payload = props.event.payload as {
        version: number
        round: number
        outcome: 'passed' | 'missing' | 'stub' | 'failed' | 'timed_out' | 'error'
        exitCode: number | null
        output: string
        reworkedPackage: string | null
      }
      const said: Record<typeof payload.outcome, string> = {
        passed: 'the smoke check passed',
        missing: 'there is no scripts/smoke.sh',
        stub: 'scripts/smoke.sh is still the stub',
        failed: `the smoke check failed${payload.exitCode === null ? '' : ` (exit ${String(payload.exitCode)})`}`,
        timed_out: 'the smoke check timed out',
        error: 'the smoke check could not be run; it will be tried again',
      }
      const label = `goal v${String(payload.version)} round ${String(payload.round)}: ${said[payload.outcome]}${payload.reworkedPackage === null ? '' : `; ${payload.reworkedPackage} sent back`}`
      const tone = payload.outcome === 'passed' ? 'working' : payload.outcome === 'error' ? 'warn' : 'danger'
      return (
        <ActivityCard {...props}>
          <Transition tone={tone} label={label}>
            {payload.output !== '' && <span data-testid="smoke-run-output">{payload.output}</span>}
          </Transition>
        </ActivityCard>
      )
    }
    ```

    Register `'workspace.smoke_run': WorkspaceSmokeRunCard,` after `'workspace.goal_retried'`.
  - `activityFilters.ts`: `'workspace.smoke_run',` after `'workspace.goal_retried'`, under the Plan 4b comment ("…and its smoke check, skeleton spec S7").
  - `server/timeline.ts` `titleFor`:

    ```ts
        // Skeleton spec S7: one smoke attempt. No `title` in the payload, so without a case it would
        // read as its own type name on the VERIFIED lane.
        case 'workspace.smoke_run': {
          const version = payload['version']
          const round = payload['round']
          const outcome = payload['outcome']
          const v = typeof version === 'number' ? String(version) : '?'
          const r = typeof round === 'number' ? String(round) : '?'
          return `smoke goal v${v} round ${r}: ${typeof outcome === 'string' ? outcome.replace('_', ' ') : '?'}`
        }
    ```
  - m56a stage 12: `73` → `74` in the check and its message. Append to the comment: "Skeleton-and-smoke Plan B added one event, `workspace.smoke_run`."

- [ ] **Step 5: Run** the domain event and timeline tests, `enum-parity.test.ts`, `apps/web/test/activity-cards.test.tsx`, `apps/web/test/activityFilters.test.ts` (if present), then `npm run typecheck` and `npm run web:build && rm -rf apps/web/.next` → PASS.

- [ ] **Step 6: Commit** — `feat(smoke): smoke attempts, the delivery's smoke claim and the workspace.smoke_run event`.

---

### Task 2: What a smoke outcome means (domain)

**Files:**
- Create: `packages/domain/src/conduct/smoke.ts`; Modify: `packages/domain/src/conduct/index.ts`
- Test: Create `packages/domain/test/conduct/smoke.test.ts`

**Interfaces:**
- Consumes: `SMOKE_STUB_EXIT_CODE`, `SMOKE_STUB_MESSAGE`, `SMOKE_CONTRACT_LINES`, `SKELETON_PACKAGE_KEY`, `SMOKE_SCRIPT_PATH`, `trimEvidence`, `sanitisePersonText` (Plan A / existing).
- Produces:
  - `type SmokeFailure = 'missing' | 'stub' | 'failed' | 'timed_out'`
  - `classifySmoke(input: { readonly code: number | null; readonly timedOut: boolean; readonly output: string }): 'passed' | 'stub' | 'failed' | 'timed_out'`
  - `smokeReworkTarget(outcome: SmokeFailure, packages: readonly { readonly key: string; readonly isIntegration: boolean }[]): string | null`
  - `smokeProjectName(attemptId: string): string`
  - `renderSmokeRework(input: { readonly round: number; readonly outcome: SmokeFailure; readonly output: string }): string`
  - `smokeStopReason(input: { readonly outcome: SmokeFailure; readonly output: string }): string`
  - `renderSmokeEvidence(input: { readonly output: string; readonly durationMs: number | null; readonly tip: string }): string`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from 'vitest'
import {
  classifySmoke,
  renderSmokeEvidence,
  renderSmokeRework,
  smokeProjectName,
  smokeReworkTarget,
  smokeStopReason,
} from '../../src/conduct/smoke.js'

describe('classifySmoke', () => {
  it('reads exit 0 as passed, the stub pair as stub, a timeout as timed_out, anything else as failed', () => {
    expect(classifySmoke({ code: 0, timedOut: false, output: 'flow ok' })).toBe('passed')
    expect(classifySmoke({ code: 2, timedOut: false, output: 'smoke not written yet' })).toBe('stub')
    expect(classifySmoke({ code: 2, timedOut: false, output: 'usage error' })).toBe('failed')
    expect(classifySmoke({ code: 1, timedOut: false, output: 'npm error Missing script: "start"' })).toBe('failed')
    expect(classifySmoke({ code: null, timedOut: false, output: '' })).toBe('failed')
    expect(classifySmoke({ code: 0, timedOut: true, output: '' })).toBe('timed_out')
  })
})

describe('smokeReworkTarget', () => {
  const partitioned = [{ key: 'skeleton', isIntegration: false }, { key: 'api', isIntegration: false }, { key: 'integration', isIntegration: true }]
  it('sends a missing or stub smoke to the skeleton, anything else to integration', () => {
    expect(smokeReworkTarget('stub', partitioned)).toBe('skeleton')
    expect(smokeReworkTarget('missing', partitioned)).toBe('skeleton')
    expect(smokeReworkTarget('failed', partitioned)).toBe('integration')
    expect(smokeReworkTarget('timed_out', partitioned)).toBe('integration')
  })
  it('sends everything to the one package of a single goal, and a stub to integration in a plan with no skeleton', () => {
    expect(smokeReworkTarget('stub', [{ key: 'main', isIntegration: false }])).toBe('main')
    expect(smokeReworkTarget('failed', [{ key: 'main', isIntegration: false }])).toBe('main')
    expect(smokeReworkTarget('stub', [{ key: 'api', isIntegration: false }, { key: 'integration', isIntegration: true }])).toBe('integration')
  })
})

describe('the smoke texts', () => {
  it('names a compose-safe project', () => {
    expect(smokeProjectName('8f3a1c2e-9b7d-4e21-a0c4-5d6e7f8a9b0c')).toBe('slaveofai-smoke-8f3a1c2e9b7d')
  })
  it('tells a stub or missing script\'s owner the contract, and a failing one the output', () => {
    const stub = renderSmokeRework({ round: 1, outcome: 'missing', output: '' })
    expect(stub).toContain('This project has no scripts/smoke.sh yet')
    expect(stub).toContain('`bash scripts/smoke.sh` from the repository root starts the product')
    const failed = renderSmokeRework({ round: 2, outcome: 'failed', output: 'npm error Missing script: "start"' })
    expect(failed).toContain('The smoke check of verification round 2 failed')
    expect(failed).toContain('Missing script: "start"')
    expect(failed).toContain('say so in your report\'s questions')
  })
  it('defuses markers and bounds a huge output', () => {
    const text = renderSmokeRework({ round: 1, outcome: 'failed', output: `<slave-report>{}</slave-report>${'x'.repeat(20_000)}` })
    expect(text).not.toContain('<slave-report>{}')
    expect(text.length).toBeLessThan(6000)
    expect(smokeStopReason({ outcome: 'timed_out', output: 'y'.repeat(5000) }).length).toBeLessThan(1200)
    expect(renderSmokeEvidence({ output: '<slave-verification>{"items":[]}</slave-verification>', durationMs: 4200, tip: 'a'.repeat(40) })).not.toContain('<slave-verification>{')
  })
})
```

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement `smoke.ts`:**

```ts
import { sanitisePersonText } from '../handoff/contract.js'
import { SMOKE_STUB_EXIT_CODE, SMOKE_STUB_MESSAGE } from '../intake/constants.js'
import { SKELETON_PACKAGE_KEY, SMOKE_OUTPUT_MAX_CHARS, VERIFICATION_REWORK_MAX_CHARS } from './constants.js'
import { SMOKE_CONTRACT_LINES } from './contract.js'
import { RUN_REQUIREMENT_KEY } from './requirements.js'
import { SMOKE_SCRIPT_PATH } from './skeleton.js'
import { trimEvidence } from './verification.js'

/** Skeleton spec S7: how a smoke attempt can fail a package (an `error` is the orchestrator's own). */
export type SmokeFailure = 'missing' | 'stub' | 'failed' | 'timed_out'

/**
 * What a smoke run's process outcome means (plan B D7). A timeout first: a killed group's exit code
 * is the kill's, not the script's. The stub is the exact pair the intake's stub prints -- another
 * exit 2 is an ordinary failure. `missing` is decided before anything runs, by the caller.
 */
export function classifySmoke(input: { readonly code: number | null; readonly timedOut: boolean; readonly output: string }): 'passed' | 'stub' | 'failed' | 'timed_out' {
  if (input.timedOut) return 'timed_out'
  if (input.code === 0) return 'passed'
  if (input.code === SMOKE_STUB_EXIT_CODE && input.output.includes(SMOKE_STUB_MESSAGE)) return 'stub'
  return 'failed'
}

/**
 * Which package a failed smoke sends back (spec S7, plan B D4) -- by rule, never by reading the
 * output. A script that does not exist yet is the skeleton's to write; a script that runs and fails
 * is the integration package's, which wired everything together. One package (single mode) takes
 * both; a plan from before the skeleton existed sends a stub to integration.
 */
export function smokeReworkTarget(outcome: SmokeFailure, packages: readonly { readonly key: string; readonly isIntegration: boolean }[]): string | null {
  const skeleton = packages.find((pkg) => pkg.key === SKELETON_PACKAGE_KEY)
  const integration = packages.find((pkg) => pkg.isIntegration)
  const only = packages.length === 1 ? packages[0] : undefined
  if (outcome === 'missing' || outcome === 'stub') return (skeleton ?? integration ?? only)?.key ?? null
  return (integration ?? only)?.key ?? null
}

/** `$SLAVEOFAI_SMOKE_PROJECT` (spec S5): unique per attempt, and a valid compose project name. */
export function smokeProjectName(attemptId: string): string {
  return `slaveofai-smoke-${attemptId.toLowerCase().replace(/[^a-z0-9]/gu, '').slice(0, 12)}`
}

const SAID: Readonly<Record<SmokeFailure, string>> = {
  missing: `there is no ${SMOKE_SCRIPT_PATH}`,
  stub: `${SMOKE_SCRIPT_PATH} is still the stub`,
  failed: 'the smoke check failed',
  timed_out: 'the smoke check timed out',
}

/**
 * The rework reason a failed smoke sends (plan B D4). Its output is the SCRIPT's -- code a worker
 * wrote -- landing in another run's prompt, so it is sanitised and bounded like a verifier's evidence.
 */
export function renderSmokeRework(input: { readonly round: number; readonly outcome: SmokeFailure; readonly output: string }): string {
  const output = trimEvidence(sanitisePersonText(input.output), 2500)
  if (input.outcome === 'missing' || input.outcome === 'stub') {
    const why = input.outcome === 'missing' ? `This project has no ${SMOKE_SCRIPT_PATH} yet` : `${SMOKE_SCRIPT_PATH} is still the stub`
    return trimEvidence(
      [`${why}, so the smoke check of verification round ${String(input.round)} could not show the product runs. Write it:`, ...SMOKE_CONTRACT_LINES].join('\n'),
      VERIFICATION_REWORK_MAX_CHARS,
    )
  }
  return trimEvidence(
    [
      `The smoke check of verification round ${String(input.round)} ${input.outcome === 'timed_out' ? 'timed out' : 'failed'}: \`bash ${SMOKE_SCRIPT_PATH}\` must start the product the way the README documents and run one basic user flow. Make it pass, then finish as your instructions describe.`,
      'If the fix is in a file another package owns, do not edit it: say exactly what must change, and where, in your report\'s questions.',
      'Its output:',
      output === '' ? '(it printed nothing)' : output,
    ].join('\n'),
    VERIFICATION_REWORK_MAX_CHARS,
  )
}

/** The `needs_human` reason when a failed smoke meets the round cap or a package that cannot be reworked. */
export function smokeStopReason(input: { readonly outcome: SmokeFailure; readonly output: string }): string {
  const output = trimEvidence(sanitisePersonText(input.output).replace(/\s+/gu, ' ').trim(), 800)
  return `${SAID[input.outcome]}${output === '' ? '' : `: ${output}`}`
}

/** Spec S8: a passing smoke, handed to the verifier as evidence -- not as its RUN verdict. */
export function renderSmokeEvidence(input: { readonly output: string; readonly durationMs: number | null; readonly tip: string }): string {
  const took = input.durationMs === null ? '' : ` in ${String(Math.round(input.durationMs / 1000))} s`
  return [
    `The orchestrator ran \`bash ${SMOKE_SCRIPT_PATH}\` on commit ${input.tip.slice(0, 12)} and it passed${took}. Its output is evidence the product can start -- not a substitute for your own ${RUN_REQUIREMENT_KEY} check:`,
    trimEvidence(sanitisePersonText(input.output), SMOKE_OUTPUT_MAX_CHARS),
  ].join('\n')
}
```

(`VERIFICATION_REWORK_MAX_CHARS` and `SMOKE_OUTPUT_MAX_CHARS` both live in `constants.ts`.)

- [ ] **Step 4: Run** `smoke.test.ts` → PASS. `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(smoke): what a smoke outcome means, whom it sends back, and what it says`.

---

### Task 3: Running a smoke attempt (orchestrator)

**Files:**
- Create: `apps/orchestrator/src/smoke.ts`
- Modify: `apps/orchestrator/src/shell.ts:98-110` (`runShellCommand` input `onSpawn?`)
- Modify: `packages/control/src/goalDelivery.ts:79` (`goalEventWith`'s `type` union gains `'workspace_smoke_run'`)
- Modify: `apps/orchestrator/src/goal.ts:269-272` (`needsHumanInLock` also clears `activeSmokeId`)
- Test: Create `apps/orchestrator/test/integration/smoke.test.ts`; Modify `apps/orchestrator/test/shell.test.ts` (or the file that tests `runShellCommand`; find it with `grep -rln "runShellCommand" apps/orchestrator/test`)

**Interfaces:**
- Consumes: Task 1's rows; Task 2's functions; `withDeliveryLock`, `goalEventWith`, `isAlive` (`@slave-of-ai/control`); `needsHumanInLock` (`./goal.js`); `OWNER_INSTANCE`, `ownerGone` (`./runs.js`); `pumps` (`./tick.js`); `removeVerificationWorktree` (`./verification.js`); `provisionDetachedWorktree`, `worktreeRootFor`, `gitIn` (`./worktree.js`); `CHILD_ENV_ALLOW` (`@slave-of-ai/providers`).
- Produces:
  - `activeSmokeIds: Set<string>`
  - `smokeWorktreeKey(attemptId: string): string` → `verify-smoke-<id8>`
  - `smokeEnv(project: string): NodeJS.ProcessEnv`
  - `startSmoke(deliveryId: string): Promise<string | null>`: the attempt id, or null when nothing was started.
  - `applySmokeOutcome(attemptId: string): Promise<void>`: replay-safe.
  - `settleStrandedSmoke(attemptId: string): Promise<void>`
  - `passedSmokeAtTip(repoPath: string, delivery: { readonly id: string; readonly integrationBranch: string }): Promise<{ readonly output: string; readonly durationMs: number | null; readonly tip: string } | null>`
  - `smokeErrorsInRound(deliveryId: string, round: number): Promise<{ readonly count: number; readonly last: string | null }>`
  - `runShellCommand` input `readonly onSpawn?: (pid: number) => void`.

- [ ] **Step 1: Failing `onSpawn` test** (in the `runShellCommand` test file):

```ts
  it('reports the spawned process group leader to onSpawn', async () => {
    let seen: number | null = null
    const outcome = await runShellCommand({ command: 'echo $$', cwd: tmpdir(), timeoutMs: 5000, onSpawn: (pid) => { seen = pid } })
    expect(seen).not.toBeNull()
    expect(outcome.output.trim()).toBe(String(seen))
  })
```

Implement it in `shell.ts`: add the optional field to the input type. Right after `spawn(...)`, add `if (child.pid !== undefined) input.onSpawn?.(child.pid)`. Run the test → PASS.

- [ ] **Step 2: Failing integration tests** (`apps/orchestrator/test/integration/smoke.test.ts`):

```ts
/**
 * Skeleton spec S7: the smoke gate's attempt -- claimed under the delivery's lock, run outside it in
 * a fresh checkout of the integration tip, concluded into a pass, a rework or a stop. Real git, a
 * real bash script on the integration branch, task states driven with Prisma.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAlive } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { INTAKE_BOOTSTRAP_SMOKE_SCRIPT, RUN_REQUIREMENT, integrationBranchName } from '@slave-of-ai/domain'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureIntegrationBranch, ensureIntegrationWorktree } from '../../src/goalBranch.js'
import { applySmokeOutcome, settleStrandedSmoke, startSmoke } from '../../src/smoke.js'
import { drainPumps } from '../../src/tick.js'
import { worktreeRootFor } from '../../src/worktree.js'

const repos: string[] = []
const git = (args: readonly string[], cwd: string): string => execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim()

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-smoke-'))
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.name', 'Fixture'], dir)
  git(['config', 'user.email', 'fixture@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'initial'], dir)
  repos.push(dir)
  return dir
}

interface Fixture {
  readonly workspaceId: string
  readonly repoPath: string
  readonly deliveryId: string
  readonly branch: string
  readonly integrationPath: string
  readonly taskOf: Readonly<Record<'skeleton' | 'api' | 'integration', string>>
}

/**
 * A conducted workspace at goal v1 whose three packages (skeleton, api, integration) are done and
 * integrated, a set with R1 and RUN, `smokeRequired`, and `scripts/smoke.sh` on the integration
 * branch holding `smoke` (or no script at all when `smoke` is null).
 */
async function seed(smoke: string | null, options: { readonly smokeTimeoutMs?: number; readonly verificationRoundCap?: number } = {}): Promise<Fixture> {
  const repoPath = makeRepo()
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Smoke', repoPath, baseBranch: 'main', verifyCommands: ['true'], setupCommands: [], delivery: 'conducted', goal: 'Make it run.', goalVersion: 1,
      ...(options.smokeTimeoutMs === undefined ? {} : { smokeTimeoutMs: options.smokeTimeoutMs }),
      ...(options.verificationRoundCap === undefined ? {} : { verificationRoundCap: options.verificationRoundCap }),
    },
  })
  await prisma.requirementSet.create({ data: { workspaceId: workspace.id, goalVersion: 1, items: [{ key: 'R1', text: 'an API', source: 'x' }, RUN_REQUIREMENT] } })
  const branch = integrationBranchName(1, workspace.id)
  const { baseCommit } = await ensureIntegrationBranch(repoPath, 'main', branch)
  const delivery = await prisma.goalDelivery.create({ data: { workspaceId: workspace.id, goalVersion: 1, integrationBranch: branch, baseCommit, smokeRequired: true } })
  const integrationPath = await ensureIntegrationWorktree(repoPath, { deliveryId: delivery.id, goalVersion: 1, branch }, workspace.id)
  if (smoke !== null) {
    execFileSync('mkdir', ['-p', join(integrationPath, 'scripts')])
    writeFileSync(join(integrationPath, 'scripts/smoke.sh'), smoke)
  }
  writeFileSync(join(integrationPath, 'app.txt'), 'the product\n')
  git(['add', '-A'], integrationPath)
  git(['commit', '-q', '-m', 'merge(T-pkg): the packages'], integrationPath)
  const taskOf: Record<string, string> = {}
  for (const [key, isIntegration, requirementKeys] of [['skeleton', false, []], ['api', false, ['R1']], ['integration', true, ['RUN']]] as const) {
    const pkg = await prisma.workPackage.create({
      data: { workspaceId: workspace.id, goalVersion: 1, key, title: key, requirementKeys: [...requirementKeys], ownedPaths: [`${key}/**`], interface: '', templateId: 'tpl', isIntegration },
    })
    const task = await prisma.task.create({
      data: { workspaceId: workspace.id, title: key, description: 'x', status: 'done', integratedAt: new Date(), requiredRole: 'implementer', maxAttempts: 5, workPackageId: pkg.id, goalVersion: 1 },
    })
    taskOf[key] = task.id
  }
  return { workspaceId: workspace.id, repoPath, deliveryId: delivery.id, branch, integrationPath, taskOf: taskOf as Fixture['taskOf'] }
}

const deliveryOf = async (f: Fixture) => prisma.goalDelivery.findUniqueOrThrow({ where: { id: f.deliveryId } })
const attemptsOf = async (f: Fixture) => prisma.smokeAttempt.findMany({ where: { goalDeliveryId: f.deliveryId }, orderBy: { startedAt: 'asc' } })
const smokeWorktrees = (f: Fixture): string[] => {
  const root = worktreeRootFor(f.repoPath)
  return existsSync(root) ? readdirSync(root).filter((name) => name.startsWith('verify-smoke-')) : []
}
const taskStatus = async (id: string) => (await prisma.task.findUniqueOrThrow({ where: { id } })).status

afterAll(async (): Promise<void> => {
  for (const repo of repos) {
    rmSync(worktreeRootFor(repo), { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
  await prisma.$disconnect()
}, 30_000)

describe('a smoke attempt', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SmokeAttempt", "SlaveRun", "TaskDependency", "Task", "WorkPackage", "RequirementSet", "GoalDelivery", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
  })
  afterEach(async (): Promise<void> => {
    await drainPumps()
  })

  it('passes in a fresh checkout with the constrained env, starts the round, keeps the output and removes the checkout', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho "project=$SLAVEOFAI_SMOKE_PROJECT db=${DATABASE_URL:-absent}"\ntest -f app.txt && echo "flow ok"\n')
    const tip = git(['rev-parse', f.branch], f.repoPath)
    const id = await startSmoke(f.deliveryId)
    expect(id).not.toBeNull()
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', round: 1, activeSmokeId: id })
    await drainPumps()
    const [attempt] = await attemptsOf(f)
    expect(attempt).toMatchObject({ status: 'passed', exitCode: 0, round: 1, tip })
    expect(attempt?.output).toContain('flow ok')
    expect(attempt?.output).toContain('project=slaveofai-smoke-')
    expect(attempt?.output).toContain('db=absent')
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', round: 1, activeSmokeId: null, activeRunId: null, roundRunFailures: 0 })
    expect(smokeWorktrees(f)).toEqual([])
    const event = await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })
    expect(event.payload).toMatchObject({ version: 1, round: 1, attemptId: id, outcome: 'passed', exitCode: 0, reworkedPackage: null })
  }, 60_000)

  it('sends the stub back to the skeleton, with the smoke contract, charging no attempt', async (): Promise<void> => {
    const f = await seed(INTAKE_BOOTSTRAP_SMOKE_SCRIPT)
    await startSmoke(f.deliveryId)
    await drainPumps()
    expect((await attemptsOf(f))[0]).toMatchObject({ status: 'stub', exitCode: 2, reworkedTaskId: f.taskOf.skeleton })
    const skeleton = await prisma.task.findUniqueOrThrow({ where: { id: f.taskOf.skeleton } })
    expect(skeleton).toMatchObject({ status: 'rework', integratedAt: null, attempt: 0 })
    expect(skeleton.lastRejectionReason).toContain('scripts/smoke.sh is still the stub')
    expect(await taskStatus(f.taskOf.integration)).toBe('done')
    expect(await deliveryOf(f)).toMatchObject({ status: 'integrating', round: 1, activeSmokeId: null })
    const rework = await prisma.executionEvent.findFirstOrThrow({ where: { taskId: f.taskOf.skeleton, type: 'task_rework' } })
    expect(rework.payload).toMatchObject({ attempt: 0, verificationRound: 1 })
  }, 60_000)

  it('sends a missing script to the skeleton, saying it does not exist yet', async (): Promise<void> => {
    const f = await seed(null)
    await startSmoke(f.deliveryId)
    await drainPumps()
    expect((await attemptsOf(f))[0]?.status).toBe('missing')
    expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskOf.skeleton } })).lastRejectionReason).toContain('This project has no scripts/smoke.sh yet')
  }, 60_000)

  it('sends a failing smoke to integration with its output -- the 2026-09-29 project\'s class', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho "docker compose up --build"\necho \'npm error Missing script: "start"\' >&2\nexit 1\n')
    await startSmoke(f.deliveryId)
    await drainPumps()
    expect((await attemptsOf(f))[0]).toMatchObject({ status: 'failed', exitCode: 1, reworkedTaskId: f.taskOf.integration })
    const integration = await prisma.task.findUniqueOrThrow({ where: { id: f.taskOf.integration } })
    expect(integration.status).toBe('rework')
    expect(integration.lastRejectionReason).toContain('Missing script: "start"')
    expect(await taskStatus(f.taskOf.skeleton)).toBe('done')
  }, 60_000)

  it('kills a timed-out smoke\'s whole process group and sends it to integration', async (): Promise<void> => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'smoke-pid-')), 'pid')
    const f = await seed(`#!/usr/bin/env bash\nsleep 60 &\necho $! > '${pidFile}'\nwait\n`, { smokeTimeoutMs: 1500 })
    await startSmoke(f.deliveryId)
    await drainPumps()
    expect((await attemptsOf(f))[0]?.status).toBe('timed_out')
    expect(await taskStatus(f.taskOf.integration)).toBe('rework')
    const child = Number(readFileSync(pidFile, 'utf8').trim())
    expect(isAlive(child)).toBe(false)
    expect(smokeWorktrees(f)).toEqual([])
  }, 60_000)

  it('stops for a person at the round cap, with the smoke output in the reason', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho "the app crash-loops"\nexit 1\n', { verificationRoundCap: 1 })
    await startSmoke(f.deliveryId)
    await drainPumps()
    const delivery = await deliveryOf(f)
    expect(delivery).toMatchObject({ status: 'needs_human', round: 1, activeSmokeId: null })
    expect(delivery.needsHumanReason).toContain('the verification round cap (1) was reached')
    expect(delivery.needsHumanReason).toContain('the app crash-loops')
    expect(await taskStatus(f.taskOf.integration)).toBe('done')
    expect((await prisma.executionEvent.findFirstOrThrow({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })).payload).toMatchObject({ reworkedPackage: null })
  }, 60_000)

  it('starts at most one attempt when two passes race for the claim', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho ok\n')
    const ids = await Promise.all([startSmoke(f.deliveryId), startSmoke(f.deliveryId)])
    expect(ids.filter((id) => id !== null)).toHaveLength(1)
    await drainPumps()
    expect(await attemptsOf(f)).toHaveLength(1)
  }, 60_000)

  it('settles an attempt whose owner died: error, one run failure, the claim released -- never a round', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\necho ok\n')
    const attempt = await prisma.smokeAttempt.create({
      data: { workspaceId: f.workspaceId, goalDeliveryId: f.deliveryId, goalVersion: 1, round: 1, tip: git(['rev-parse', f.branch], f.repoPath), ownerInstance: '999999/dead-daemon' },
    })
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 1, activeSmokeId: attempt.id } })
    await settleStrandedSmoke(attempt.id)
    expect(await prisma.smokeAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ status: 'error' })
    expect(await deliveryOf(f)).toMatchObject({ status: 'verifying', round: 1, roundRunFailures: 1, activeSmokeId: null })
    expect(await taskStatus(f.taskOf.integration)).toBe('done')
  }, 60_000)

  it('applies an outcome at most once', async (): Promise<void> => {
    const f = await seed('#!/usr/bin/env bash\nexit 1\n')
    const id = await startSmoke(f.deliveryId)
    await drainPumps()
    await applySmokeOutcome(id ?? '')
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'workspace_smoke_run' } })).toBe(1)
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'task_rework' } })).toBe(1)
  }, 60_000)
})
```

- [ ] **Step 3: Run to see them fail.** `npx vitest run apps/orchestrator/test/integration/smoke.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement `apps/orchestrator/src/smoke.ts`:**

```ts
/**
 * Skeleton spec S7: the smoke gate's attempt. Before a goal version's verification run, the
 * orchestrator runs the project's own `bash scripts/smoke.sh` -- no model -- in a fresh detached
 * checkout of the integration tip, and routes the outcome: a pass lets the verification run start;
 * a stub or missing script sends the skeleton back; any other failure sends the integration package
 * back; the round cap stops the version for a person.
 *
 * The delivery's lock is taken to CLAIM and to CONCLUDE, never around the run (plan B D1): a smoke
 * can take fifteen minutes, and the lock's transaction times out at two. The run itself is
 * background work in the tick's `pumps`, like a slave's run.
 */
import { existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { goalEventWith, isAlive, withDeliveryLock } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import {
  SMOKE_OUTPUT_MAX_CHARS,
  SMOKE_SCRIPT_PATH,
  SMOKE_STRANDED_GRACE_MS,
  classifySmoke,
  renderSmokeRework,
  smokeProjectName,
  smokeReworkTarget,
  smokeStopReason,
  trimEvidence,
  type SmokeFailure,
  type SmokeOutcome,
} from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { CHILD_ENV_ALLOW } from '@slave-of-ai/providers'
import { needsHumanInLock } from './goal.js'
import { OWNER_INSTANCE, ownerGone } from './runs.js'
import { runShellCommand } from './shell.js'
import { pumps } from './tick.js'
import { removeVerificationWorktree } from './verification.js'
import { gitIn, provisionDetachedWorktree, worktreeRootFor } from './worktree.js'

/** The attempts THIS process is running (the `activePumpRunIds` idiom, plan B D8). */
export const activeSmokeIds = new Set<string>()

/** Under the `verify-` prefix on purpose: `removeVerificationWorktree` removes it unchanged (plan B D6). */
export const smokeWorktreeKey = (attemptId: string): string => `verify-smoke-${attemptId.slice(0, 8)}`

/** Plan B D6: what a daemon may hand a smoke script beyond `CHILD_ENV_ALLOW` -- how to reach Docker. */
const SMOKE_ENV_EXTRA = ['DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'XDG_RUNTIME_DIR'] as const

/** The docker cleanup's bound: a hung daemon must not hold a tick's background work forever. */
const DOCKER_CLEANUP_TIMEOUT_MS = 120_000

/**
 * The smoke script's environment (spec S7): a run's allow list, how to reach Docker, and the
 * attempt's own project name. Absent, never empty, for a name the daemon does not hold.
 */
export function smokeEnv(project: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of [...CHILD_ENV_ALLOW, ...SMOKE_ENV_EXTRA]) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, SLAVEOFAI_SMOKE_PROJECT: project }
}

/** Thrown inside the lock when the claim was lost: the attempt row inserted beside it must roll back. */
class LostSmokeClaim extends Error {}
/** Thrown inside the lock when an outcome is no longer this attempt's to apply. */
class NotTheSmoke extends Error {}

/**
 * Starts a smoke attempt of a goal version, or returns null. From `integrating` it starts a new
 * round (`round + 1`, `verifying`, run failures reset -- plan B D3); from `verifying` with no claim
 * it tries the same round again. The tip is read first and checked out by SHA, so the attempt
 * checks exactly the commit it records.
 */
export async function startSmoke(deliveryId: string): Promise<string | null> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId }, include: { workspace: { select: { repoPath: true, archivedAt: true } } } })
  const newRound = delivery.status === 'integrating'
  if (!newRound && !(delivery.status === 'verifying' && delivery.activeRunId === null && delivery.activeSmokeId === null)) return null
  if (delivery.workspace.archivedAt !== null) return null
  let tip: string
  try {
    tip = await gitIn(delivery.workspace.repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${delivery.integrationBranch}^{commit}`)
  } catch {
    // A deleted branch: the goal pass's own trip says so (`integrationTipOrTrip`); nothing to check.
    return null
  }
  const round = newRound ? delivery.round + 1 : delivery.round
  let attemptId: string | null
  try {
    attemptId = await withDeliveryLock(delivery.id, async (tx) => {
      const now = await tx.goalDelivery.findUniqueOrThrow({ where: { id: delivery.id } })
      if (now.status !== delivery.status || now.round !== delivery.round || now.activeRunId !== null || now.activeSmokeId !== null) return null
      const attempt = await tx.smokeAttempt.create({
        data: { workspaceId: now.workspaceId, goalDeliveryId: now.id, goalVersion: now.goalVersion, round, tip, ownerInstance: OWNER_INSTANCE },
        select: { id: true },
      })
      const moved = await tx.goalDelivery.updateMany({
        where: { id: now.id, status: now.status, activeRunId: null, activeSmokeId: null },
        data: newRound ? { status: 'verifying', round, roundRunFailures: 0, activeSmokeId: attempt.id } : { activeSmokeId: attempt.id },
      })
      if (moved.count === 0) throw new LostSmokeClaim()
      return attempt.id
    })
  } catch (error) {
    if (error instanceof LostSmokeClaim) return null
    throw error
  }
  if (attemptId === null) return null
  const id = attemptId
  activeSmokeIds.add(id)
  const job: Promise<void> = executeSmoke(id)
    .catch((error: unknown): void => {
      console.error(`[smoke] attempt ${id} failed outside its own handling:`, error)
    })
    .finally((): void => {
      activeSmokeIds.delete(id)
      pumps.delete(job)
    })
  pumps.add(job)
  return id
}

interface SmokeResult {
  readonly status: Exclude<SmokeOutcome, 'running'>
  readonly exitCode: number | null
  readonly signal: string | null
  readonly output: string
}

/** The attempt itself: checkout, script, cleanup, record, apply. Never throws past a recorded result. */
async function executeSmoke(attemptId: string): Promise<void> {
  const attempt = await prisma.smokeAttempt.findUniqueOrThrow({ where: { id: attemptId }, include: { workspace: { select: { repoPath: true, smokeTimeoutMs: true } } } })
  const repoPath = attempt.workspace.repoPath
  const key = smokeWorktreeKey(attemptId)
  const worktreePath = resolve(worktreeRootFor(repoPath), key)
  const project = smokeProjectName(attemptId)
  const started = Date.now()
  let result: SmokeResult
  try {
    // Plan B D6: no setup commands -- the smoke starts the product the way the README says, from a clean clone.
    await provisionDetachedWorktree({ repoPath, ref: attempt.tip, key, setupCommands: [] })
    await prisma.smokeAttempt.update({ where: { id: attemptId }, data: { worktreePath } })
    const script = join(worktreePath, SMOKE_SCRIPT_PATH)
    if (!existsSync(script) || !statSync(script).isFile()) {
      result = { status: 'missing', exitCode: null, signal: null, output: `${SMOKE_SCRIPT_PATH} does not exist at ${attempt.tip.slice(0, 12)}` }
    } else {
      const outcome = await runShellCommand({
        command: `bash ${SMOKE_SCRIPT_PATH}`,
        cwd: worktreePath,
        timeoutMs: attempt.workspace.smokeTimeoutMs,
        env: smokeEnv(project),
        onSpawn: (pid): void => {
          void prisma.smokeAttempt.update({ where: { id: attemptId }, data: { pid } }).catch(() => undefined)
        },
      })
      result = { status: classifySmoke(outcome), exitCode: outcome.code, signal: outcome.signal, output: outcome.output }
    }
  } catch (error) {
    result = { status: 'error', exitCode: null, signal: null, output: `the smoke check could not be run: ${error instanceof Error ? error.message : String(error)}` }
  }
  await cleanUpSmokeProject(project)
  await removeVerificationWorktree(repoPath, worktreePath)
  await recordSmokeResult(attemptId, result, Date.now() - started)
  await applySmokeOutcome(attemptId)
}

/** `running` -> the outcome, once (a second writer finds it concluded). */
async function recordSmokeResult(attemptId: string, result: SmokeResult, durationMs: number): Promise<void> {
  await prisma.smokeAttempt.updateMany({
    where: { id: attemptId, status: 'running' },
    data: {
      status: result.status,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: Math.max(0, Math.round(durationMs)),
      output: trimEvidence(result.output, SMOKE_OUTPUT_MAX_CHARS),
      endedAt: new Date(),
    },
  })
}

/**
 * Plan B D6: best effort, by name -- containers a killed script started outside its process group
 * (a Docker daemon's children are not the script's). Logged, never thrown: a leftover container is
 * an operator's tidy-up, not a reason to lose the attempt's result.
 */
async function cleanUpSmokeProject(project: string): Promise<void> {
  const command = [
    'command -v docker >/dev/null 2>&1 || exit 0',
    `docker compose -p ${project} down -v --remove-orphans >/dev/null 2>&1`,
    `ids=$(docker ps -aq --filter "name=^${project}" 2>/dev/null)`,
    '[ -z "$ids" ] || docker rm -f $ids >/dev/null 2>&1',
    'exit 0',
  ].join('; ')
  await runShellCommand({ command, cwd: tmpdir(), timeoutMs: DOCKER_CLEANUP_TIMEOUT_MS, env: smokeEnv(project) }).catch((error: unknown) => {
    console.warn(`[smoke] could not clean up ${project}: ${String(error)}`)
  })
}

/**
 * Applies a concluded attempt to its delivery (spec S7, plan B D3/D4), under the delivery's lock, in
 * the Plan 4b order: `workspace.smoke_run` (and a `task.rework`) first, each only if missing, then
 * the guarded moves. Replay-safe: only the attempt holding `activeSmokeId` on a `verifying` delivery
 * moves anything, and a lost race throws inside the lock and is swallowed here.
 */
export async function applySmokeOutcome(attemptId: string): Promise<void> {
  const attempt = await prisma.smokeAttempt.findUnique({ where: { id: attemptId } })
  if (attempt === null || attempt.status === 'running') return
  const outcome = attempt.status
  try {
    await withDeliveryLock(attempt.goalDeliveryId, async (tx) => {
      const delivery = await tx.goalDelivery.findUniqueOrThrow({ where: { id: attempt.goalDeliveryId }, include: { workspace: { select: { verificationRoundCap: true } } } })
      if (delivery.activeSmokeId !== attempt.id || delivery.status !== 'verifying') throw new NotTheSmoke()
      const cap = delivery.workspace.verificationRoundCap
      const capped = delivery.round - delivery.roundBase >= cap
      const packages = await tx.workPackage.findMany({
        where: { workspaceId: delivery.workspaceId, goalVersion: delivery.goalVersion },
        orderBy: { key: 'asc' },
        select: { key: true, isIntegration: true, tasks: { orderBy: { createdAt: 'asc' }, take: 1, select: { id: true, status: true, attempt: true } } },
      })
      const failure: SmokeFailure | null = outcome === 'passed' || outcome === 'error' ? null : outcome
      const targetKey = failure === null ? null : smokeReworkTarget(failure, packages)
      const task = packages.find((pkg) => pkg.key === targetKey)?.tasks[0]
      const reworks = failure !== null && !capped && task?.status === 'done'

      if (!(await goalEventWith(tx, delivery.workspaceId, 'workspace_smoke_run', { attemptId: attempt.id }))) {
        await appendEvent({
          type: 'workspace.smoke_run',
          workspaceId: delivery.workspaceId,
          actor: 'system',
          payload: {
            version: delivery.goalVersion,
            round: attempt.round,
            attemptId: attempt.id,
            outcome,
            exitCode: attempt.exitCode,
            durationMs: attempt.durationMs ?? 0,
            output: attempt.output,
            reworkedPackage: reworks ? targetKey : null,
          },
        })
      }

      if (failure === null) {
        // A pass: the verification run may start. An error: the same round again, one run failure (D3).
        const released = await tx.goalDelivery.updateMany({
          where: { id: delivery.id, status: 'verifying', activeSmokeId: attempt.id },
          data: outcome === 'error' ? { activeSmokeId: null, roundRunFailures: { increment: 1 } } : { activeSmokeId: null },
        })
        if (released.count === 0) throw new NotTheSmoke()
        return
      }
      const stop = smokeStopReason({ outcome: failure, output: attempt.output })
      if (capped) {
        if (!(await needsHumanInLock(tx, delivery.id, null, `the verification round cap (${String(cap)}) was reached on a failing smoke check: ${stop}`))) throw new NotTheSmoke()
        return
      }
      if (task === undefined || task.status !== 'done') {
        const reason = `the smoke check found ${stop}, and ${targetKey === null ? 'no package' : `package "${targetKey}"`} can be sent back for it`
        const cause = task === undefined ? undefined : { kind: 'blocked_package' as const, tasks: [{ taskId: task.id, status: task.status }] }
        if (!(await needsHumanInLock(tx, delivery.id, null, reason, cause))) throw new NotTheSmoke()
        return
      }
      const reason = renderSmokeRework({ round: attempt.round, outcome: failure, output: attempt.output })
      if (!(await goalEventWith(tx, delivery.workspaceId, 'task_rework', { verificationRound: attempt.round }, { taskId: task.id }))) {
        await appendEvent({
          type: 'task.rework',
          workspaceId: delivery.workspaceId,
          taskId: task.id,
          actor: 'system',
          // Plan 4b D5: no attempt is charged -- the round cap bounds this loop.
          payload: { reason, attempt: task.attempt, verificationRound: attempt.round },
        })
      }
      await tx.task.updateMany({
        where: { id: task.id, status: 'done' },
        data: { status: 'rework', integratedAt: null, activeRunId: null, lastRejectionReason: reason },
      })
      await tx.smokeAttempt.update({ where: { id: attempt.id }, data: { reworkedTaskId: task.id } })
      const moved = await tx.goalDelivery.updateMany({
        where: { id: delivery.id, status: 'verifying', activeSmokeId: attempt.id },
        data: { status: 'integrating', activeSmokeId: null },
      })
      if (moved.count === 0) throw new NotTheSmoke()
    })
  } catch (error) {
    if (!(error instanceof NotTheSmoke)) throw error
  }
}

/**
 * Plan B D8: a claim the goal pass found. Nothing while this process runs the attempt, or while a
 * live owner elsewhere may still be inside its timeout. A claim naming no row, a `running` attempt
 * whose owner is gone (or is this process, which no longer runs it), or one past its timeout plus
 * the grace, is recorded `error` (its group killed, its checkout removed) and applied. An attempt
 * already concluded but still holding the claim (a crash between the two writes) is applied again.
 */
export async function settleStrandedSmoke(attemptId: string): Promise<void> {
  const attempt = await prisma.smokeAttempt.findUnique({ where: { id: attemptId }, include: { workspace: { select: { repoPath: true, smokeTimeoutMs: true } } } })
  if (attempt === null) {
    const delivery = await prisma.goalDelivery.findUnique({ where: { activeSmokeId: attemptId }, select: { id: true } })
    if (delivery !== null) {
      await withDeliveryLock(delivery.id, async (tx) =>
        tx.goalDelivery.updateMany({ where: { id: delivery.id, activeSmokeId: attemptId }, data: { activeSmokeId: null, roundRunFailures: { increment: 1 } } }),
      )
    }
    return
  }
  if (attempt.status !== 'running') {
    await applySmokeOutcome(attemptId)
    return
  }
  if (activeSmokeIds.has(attemptId)) return
  const mine = attempt.ownerInstance === OWNER_INSTANCE
  const overdue = Date.now() - attempt.startedAt.getTime() > attempt.workspace.smokeTimeoutMs + SMOKE_STRANDED_GRACE_MS
  if (!mine && !ownerGone(attempt.ownerInstance) && !overdue) return
  if (attempt.pid !== null && isAlive(attempt.pid)) {
    try {
      process.kill(-attempt.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  await cleanUpSmokeProject(smokeProjectName(attemptId))
  await removeVerificationWorktree(attempt.workspace.repoPath, attempt.worktreePath)
  await recordSmokeResult(
    attemptId,
    { status: 'error', exitCode: null, signal: null, output: 'the process running this smoke check is gone; it will be tried again' },
    Date.now() - attempt.startedAt.getTime(),
  )
  await applySmokeOutcome(attemptId)
}

/** Plan B D5: the latest passing attempt on the integration branch's CURRENT tip, or null. */
export async function passedSmokeAtTip(
  repoPath: string,
  delivery: { readonly id: string; readonly integrationBranch: string },
): Promise<{ readonly output: string; readonly durationMs: number | null; readonly tip: string } | null> {
  let tip: string
  try {
    tip = await gitIn(repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${delivery.integrationBranch}^{commit}`)
  } catch {
    return null
  }
  return prisma.smokeAttempt.findFirst({
    where: { goalDeliveryId: delivery.id, status: 'passed', tip },
    orderBy: { startedAt: 'desc' },
    select: { output: true, durationMs: true, tip: true },
  })
}

/** How many attempts of `round` the orchestrator could not run, and the last one's output -- for the run-failure cap's reason. */
export async function smokeErrorsInRound(deliveryId: string, round: number): Promise<{ readonly count: number; readonly last: string | null }> {
  const rows = await prisma.smokeAttempt.findMany({ where: { goalDeliveryId: deliveryId, round, status: 'error' }, orderBy: { startedAt: 'asc' }, select: { output: true } })
  return { count: rows.length, last: rows.at(-1)?.output ?? null }
}
```

`needsHumanInLock` (`goal.ts:269-272`): the `updateMany` data gains `activeSmokeId: null`. That is its only change in this task.

- [ ] **Step 5: Run** `npx tsc --build && npx vitest run apps/orchestrator/test/integration/smoke.test.ts` → PASS. Also `goal-pass.test.ts` and `verification.test.ts`, which must stay green, because nothing calls `startSmoke` yet. `npm run typecheck`.

- [ ] **Step 6: Commit** — `feat(smoke): run a smoke attempt in a fresh checkout, outside the lock, and route its outcome`.

---

### Task 4: The goal pass runs the smoke gate

**Files:**
- Modify: `apps/orchestrator/src/goal.ts:81-120` (`advanceDelivery`)
- Modify: `apps/orchestrator/src/verification.ts:376-383` (the claim also requires `activeSmokeId: null`)
- Modify: `apps/orchestrator/src/conductor.ts:350-358` (`goalDelivery.create` sets `smokeRequired`)
- Modify: `packages/control/src/goalDelivery.ts:270-320` (`abandonGoal` clears the smoke claim and signals its group)
- Test: `apps/orchestrator/test/integration/smoke.test.ts` (a `describe('the goal pass and the smoke gate')`), `apps/orchestrator/test/integration/conductor.test.ts` (`smokeRequired`)

**Interfaces:**
- Consumes: Task 3's `startSmoke`, `settleStrandedSmoke`, `passedSmokeAtTip`, `smokeErrorsInRound`.

- [ ] **Step 1: Failing tests** (append to `smoke.test.ts`). Add the imports `fileURLToPath` from `node:url`, `runGoalPass` from `../../src/goal.js`, `type TickDeps` from `../../src/tick.js`, `abandonGoal` from `@slave-of-ai/control`, `workspaceId as brandWorkspaceId` from `@slave-of-ai/domain` and `ClaudeCodeAdapter` from `@slave-of-ai/providers`, plus these helpers, which mirror `verification.test.ts`'s:

```ts
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const FAKE = join(repoRoot, 'packages/providers/test/fake-claude.mjs')
const REAL_GATE = join(repoRoot, 'scripts/pause-gate.sh')

/** The fake's verification arm: every requirement passes, RUN with a check of its own. */
const verifier = (): ClaudeCodeAdapter => new ClaudeCodeAdapter({ command: 'node', extraArgs: [FAKE, '--fixture', 'm8-flow'], hookPath: REAL_GATE })
const depsFor = (workspaceId: string, adapter: ClaudeCodeAdapter): TickDeps => ({ workspaceId: brandWorkspaceId(workspaceId), registry: { resolve: () => adapter } })

/** `seed` plus what a verification run needs: a provider, and a verifier seat recorded on the delivery. */
async function seedWithVerifier(smoke: string | null): Promise<Fixture & { readonly verifierId: string }> {
  const f = await seed(smoke)
  await prisma.providerConfiguration.create({ data: { workspaceId: f.workspaceId, kind: 'claude_code', settings: {} } })
  const team = await prisma.team.create({ data: { workspaceId: f.workspaceId, name: 'Engineering' } })
  const person = await prisma.person.create({ data: { name: 'Vera' } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Verifier', runtimeRoles: ['reviewer', 'verifier'], profile: 'You check what was built.', personId: person.id } })
  await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { verifierSlaveId: seat.id } })
  return { ...f, verifierId: seat.id }
}
```

(Check `REAL_GATE`'s path against `verification.test.ts`'s own constant and use the same one. Add `"ProviderConfiguration", "RunContext", "Checkpoint", "Artifact"` to both `describe`s' TRUNCATE lists.)

```ts
describe('the goal pass and the smoke gate', () => {
  // beforeEach/afterEach as in 'a smoke attempt'

  it('starts a smoke, not a verification run, once every package is integrated; the next pass verifies', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho "flow ok"\n')
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(0)
    await drainPumps()
    expect((await attemptsOf(f))[0]?.status).toBe('passed')
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()
    const runs = await prisma.slaveRun.findMany({ where: { kind: 'verification' } })
    expect(runs).toHaveLength(1)
    expect((await deliveryOf(f)).round).toBe(1)
  }, 120_000)

  it('starts nothing while the scheduler has no room', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho ok\n')
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: false })
    expect(await attemptsOf(f)).toEqual([])
  }, 60_000)

  it('verifies a retried version of an unchanged tree without running the smoke again', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho ok\n')
    await startSmoke(f.deliveryId)
    await drainPumps()
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'integrating', roundBase: 1 } })
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    await drainPumps()
    expect(await attemptsOf(f)).toHaveLength(1)
    expect(await prisma.slaveRun.count({ where: { kind: 'verification' } })).toBe(1)
    expect((await deliveryOf(f)).round).toBe(2)
  }, 120_000)

  it('ends in needs_human after three smoke attempts that could not run in one round, saying so', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\necho ok\n')
    await prisma.goalDelivery.update({ where: { id: f.deliveryId }, data: { status: 'verifying', round: 1, roundRunFailures: 3 } })
    await prisma.smokeAttempt.create({ data: { workspaceId: f.workspaceId, goalDeliveryId: f.deliveryId, goalVersion: 1, round: 1, tip: 'x', status: 'error', output: 'worktree add failed' } })
    await runGoalPass(depsFor(f.workspaceId, verifier()), { mayStartRuns: true })
    const delivery = await deliveryOf(f)
    expect(delivery.status).toBe('needs_human')
    expect(delivery.needsHumanReason).toContain('1 smoke check(s) could not be run; the last: worktree add failed')
  }, 60_000)

  it('abandons a version mid-smoke: the script is signalled, its outcome moves nothing', async (): Promise<void> => {
    const f = await seedWithVerifier('#!/usr/bin/env bash\ntrap "echo stopped; exit 143" TERM\nsleep 30 &\nwait\n')
    await startSmoke(f.deliveryId)
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect((await abandonGoal(f.workspaceId, 1)).ok).toBe(true)
    await drainPumps()
    expect(await deliveryOf(f)).toMatchObject({ status: 'abandoned', activeSmokeId: null })
    expect((await attemptsOf(f))[0]?.status).toBe('failed')
    expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'task_rework' } })).toBe(0)
  }, 60_000)
})
```

`conductor.test.ts`, in "cuts the version's integration branch…" (`:410`): assert `delivery.smokeRequired` is `true`. Add a case with a stored set of R-keys only (a set extracted before Plan A: create the `RequirementSet` directly without RUN), whose delivery gets `smokeRequired: false`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement.** `goal.ts` `advanceDelivery`, replacing `:89-120`:

```ts
  let delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id } })
  if (delivery.activeSmokeId !== null) {
    // Plan B D8: a smoke claim nothing will conclude is settled here; a live one is waited for.
    await settleStrandedSmoke(delivery.activeSmokeId)
    delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id } })
    if (delivery.activeSmokeId !== null) return
  }
  if (delivery.status === 'verifying' && delivery.activeRunId !== null) {
    // (unchanged: settleStrandedClaim, re-read)
  }
  if (delivery.status === 'verifying') {
    if (delivery.activeRunId !== null) return
    if (delivery.roundRunFailures >= VERIFICATION_RUN_RETRY_CAP) {
      const last = await lastVerificationFailure(delivery.id)
      const smoke = await smokeErrorsInRound(delivery.id, delivery.round)
      const round = String(delivery.round)
      const reason =
        smoke.count === 0
          ? `the verifier could not produce a usable verification ${String(VERIFICATION_RUN_RETRY_CAP)} times in round ${round}` + (last === null ? '' : `; the last: ${last.slice(0, 1000)}`)
          : `the round could not be run ${String(VERIFICATION_RUN_RETRY_CAP)} times in round ${round}: ${String(smoke.count)} smoke check(s) could not be run; the last: ${(smoke.last ?? '').slice(0, 800)}` +
            (last === null ? '' : `; the last unusable verification: ${last.slice(0, 500)}`)
      await endInNeedsHuman(delivery.id, null, reason)
      return
    }
    if (!(await everyPackageIntegrated(workspaceId, delivery.goalVersion))) return
    if (!options.mayStartRuns) return
    // Skeleton spec S7 (plan B D5): the verification run follows a passing smoke on THIS tip.
    if (delivery.smokeRequired && (await passedSmokeAtTip(workspace.repoPath, delivery)) === null) {
      await startSmoke(delivery.id)
      return
    }
    await dispatchVerification(deps, delivery.id)
    return
  }
  if (delivery.status === 'integrating') {
    if (!(await everyPackageIntegrated(workspaceId, delivery.goalVersion))) return
    if (!options.mayStartRuns) return
    // Plan 4b (spec R8/R9): integration is not acceptance -- a round is. Skeleton spec S7: the round
    // starts with a smoke, unless one already passed on this tip (a retry of an unchanged tree).
    if (delivery.smokeRequired && (await passedSmokeAtTip(workspace.repoPath, delivery)) === null) {
      await startSmoke(delivery.id)
      return
    }
    await dispatchVerification(deps, delivery.id)
    return
  }
```

Import `passedSmokeAtTip`, `settleStrandedSmoke`, `smokeErrorsInRound`, `startSmoke` from `./smoke.js`. Update `runGoalPass`'s doc comment: "…once every package is on its integration branch, a smoke check (skeleton spec S7) and then a verification run check every requirement…".

`verification.ts` `dispatchVerification`'s claim:

```ts
    if (now.status !== delivery.status || now.round !== delivery.round || now.activeRunId !== null || now.activeSmokeId !== null) return { count: 0 }
    return tx.goalDelivery.updateMany({
      where: { id: delivery.id, status: delivery.status, activeRunId: null, activeSmokeId: null },
      // ... data unchanged
    })
```

`conductor.ts` `materialise`, `goalDelivery.create` data: `smokeRequired: items.some((item) => item.key === RUN_REQUIREMENT_KEY),`, with the comment "Skeleton spec S7: a version whose set carries RUN is smoke-checked; one extracted before RUN existed is verified as it was." (`items` is the parsed set `materialise` already receives; widen its element type to include `key`, which it already has.)

`packages/control/src/goalDelivery.ts` `abandonGoal`: inside the lock, after the `claim` lookup:

```ts
      const smoke = delivery.activeSmokeId === null ? null : await tx.smokeAttempt.findUnique({ where: { id: delivery.activeSmokeId }, select: { pid: true } })
```

In the final update, data `{ status: 'abandoned', activeRunId: null, activeSmokeId: null }`. Return `smokePid: smoke?.pid ?? null` alongside `verification`. After the lock, before the verification stop:

```ts
  // Skeleton-and-smoke plan B D9: the smoke check's group is signalled; its script's trap cleans up,
  // and its conclusion finds the version abandoned and moves nothing.
  if (outcome.smokePid !== null && isAlive(outcome.smokePid)) {
    try {
      process.kill(-outcome.smokePid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
```

(`isAlive` from `./kill.js`.)

- [ ] **Step 4: Run** `smoke.test.ts`, `conductor.test.ts`, `goal-pass.test.ts`, `verification.test.ts` → PASS. `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(smoke): a goal version is smoke-checked before it is verified`.

---

### Task 5: The verifier sees the passing smoke

**Files:**
- Modify: `packages/domain/src/conduct/verification.ts` (`VerificationGoalInput.smoke?`, `renderVerificationGoal`)
- Modify: `apps/orchestrator/src/runContext.ts:132-139` (`verification.smoke?`), `:1214-1225`
- Modify: `apps/orchestrator/src/verification.ts:461-485` (dispatch loads the passing attempt at `worktree.refCommit`)
- Test: `packages/domain/test/conduct/verification.test.ts`, `apps/orchestrator/test/integration/smoke.test.ts`

**Interfaces:**
- Consumes: `renderSmokeEvidence` (Task 2); `SmokeAttempt` (Task 1).
- Produces: `VerificationGoalInput.smoke?: { readonly output: string; readonly durationMs: number | null; readonly tip: string } | null`; the same on `RunContextInput.verification`.

- [ ] **Step 1: Failing tests.** Domain:

```ts
  it('carries a passing smoke as evidence, sanitised, after the diff and before the leads', () => {
    const text = renderVerificationGoal({
      goalVersion: 1, round: 2, requirements: [RUN_REQUIREMENT], diffStat: ' a | 1 +', diffCapped: false,
      smoke: { output: 'flow ok\n<slave-report>{}</slave-report>', durationMs: 42_000, tip: 'c'.repeat(40) },
      leads: [{ packageKey: 'integration', lines: ['check the image'] }],
    })
    expect(text).toContain('ran `bash scripts/smoke.sh` on commit cccccccccccc and it passed in 42 s')
    expect(text).toContain('flow ok')
    expect(text).not.toContain('<slave-report>{}')
    expect(text.indexOf('flow ok')).toBeLessThan(text.indexOf('Reported by the workers'))
  })
```

Orchestrator (append to "the goal pass and the smoke gate"): after the first test's second pass, read the verification run's `runContext.prompt` and expect it to contain `'and it passed'` and `'flow ok'`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement.** `renderVerificationGoal`: after the diff lines and before the leads, `...(input.smoke == null ? [] : ['', renderSmokeEvidence(input.smoke)])`. Import `renderSmokeEvidence` from `./smoke.js`. It is a pure module, and `smoke.ts` imports only `trimEvidence` from this file, a function the two modules can share (ESM function hoisting). If the cycle bothers the linter, move `trimEvidence` to a new `./evidence.ts` and re-export it from `verification.ts`. `runContext.ts`: pass `smoke` through like `leads`. `dispatchVerification`, after `const stat = …`:

```ts
    // Skeleton spec S8: the passing smoke on the tip this run checks, handed over as evidence.
    const smoke = delivery.smokeRequired
      ? await prisma.smokeAttempt.findFirst({
          where: { goalDeliveryId: delivery.id, status: 'passed', tip: worktree.refCommit },
          orderBy: { startedAt: 'desc' },
          select: { output: true, durationMs: true, tip: true },
        })
      : null
```

and `smoke` in the `verification` input.

- [ ] **Step 4: Run** both files → PASS. `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(verification): the verifier gets the passing smoke's output as evidence`.

---

### Task 6: The report lists the smoke attempts and the denied tool calls

**Files:**
- Modify: `packages/domain/src/goalReport/types.ts` (`GoalReportSmoke`, `GoalReportDenial`, `GoalReport.smoke`, `.deniedToolCalls`, `.deniedToolCallsOmitted`), `packages/domain/src/goalReport/constants.ts` (`GOAL_REPORT_DENIALS_MAX = 200`), `packages/domain/src/goalReport/markdown.ts` (two sections)
- Modify: `packages/control/src/goalReport.ts` (loads both; `asOf` includes attempt times), `packages/control/src/goalReportTrail.ts:85-160` (`workspace_smoke_run` in `VERSION_TRAIL_TYPES`; its sentence)
- Modify: `apps/web/src/components/project/GoalReportView.tsx` (two panels)
- Test: `packages/domain/test/goalReport/markdown.test.ts`, `packages/domain/test/goalReport/caveats.test.ts`, `packages/domain/test/goalReport/summary.test.ts` (fixtures gain the three fields), `packages/control/test/integration/goal-report.test.ts` (find the loader's test with `grep -rln "loadGoalReport" packages/control/test`), `apps/web/test/goal-report-view.test.tsx`, `apps/orchestrator/test/integration/conductor-e2e.test.ts` (fixture literal, if it builds a `GoalReport`)

**Interfaces:**
- Produces:

```ts
export interface GoalReportSmoke {
  readonly attemptId: string
  readonly round: number
  readonly outcome: 'running' | 'passed' | 'missing' | 'stub' | 'failed' | 'timed_out' | 'error'
  readonly exitCode: number | null
  readonly durationMs: number | null
  /** The integration commit it checked. */
  readonly tip: string
  /** Trimmed at `SMOKE_OUTPUT_MAX_CHARS` when it was recorded. */
  readonly output: string
  /** `endedAt`, or `startedAt` while it runs. */
  readonly at: string
  /** The package its failure sent back, or null. */
  readonly reworkedPackage: string | null
}

export interface GoalReportDenial {
  readonly at: string
  readonly runId: string
  /** The package whose task the run worked, or null for a verification run. */
  readonly packageKey: string | null
  readonly kind: 'permission_mode' | 'permission_matrix'
  readonly detail: string
}
```

`GoalReport` gains `readonly smoke: readonly GoalReportSmoke[]`, `readonly deniedToolCalls: readonly GoalReportDenial[]` and `readonly deniedToolCallsOmitted: number`.

- [ ] **Step 1: Failing tests.**
  - `markdown.test.ts`: a report with `smoke: [{ attemptId: 'a1', round: 1, outcome: 'failed', exitCode: 1, durationMs: 61_000, tip: 'd'.repeat(40), output: 'npm error Missing script: "start"', at: '2026-09-30T10:00:00.000Z', reworkedPackage: 'integration' }, { …round 2, outcome: 'passed', exitCode: 0, output: 'flow ok', reworkedPackage: null }]` and `deniedToolCalls: [{ at: '2026-09-30T09:50:00.000Z', runId: 'r9', packageKey: 'integration', kind: 'permission_mode', detail: 'Bash was denied by the permission mode (tu_1)' }]`. The Markdown contains `'## Smoke checks'`, the row `'| 1 | failed | 1 | 61 s | dddddddddddd | integration | 2026-09-30T10:00:00.000Z |'`, a fenced block with `Missing script: "start"`, `'## Denied tool calls'`, and `'- 2026-09-30T09:50:00.000Z · integration: Bash was denied by the permission mode (tu_1) (run r9)'`. The sections come in the order rounds → smoke → evidence and packages → denials → spend. An output containing a ``` fence stays inside its fence (`mdFence`). A report with none of either says `'No smoke check has run.'` and `'No tool call was denied.'`.
  - Loader test: a delivery with two attempts, and a package run with one `guardrail.tripped { guardrail: 'permission_mode', detail }` event and one `run.tool_denied { tool, capability }` event. The report has both attempts oldest first (`reworkedPackage` resolved from `reworkedTaskId`), and both denials oldest first (`kind` `permission_mode`, then `permission_matrix` with detail `'Write (write_repo) was refused by the permission matrix'`). A `guardrail.tripped` with any other guardrail is left out. The trail contains `'Smoke check, round 1: failed (exit 1); integration sent back.'`.
  - `goal-report-view.test.tsx`: `report()` gains the three fields (empty by default). Add a test: the smoke panel has two `data-testid="goal-report-smoke"` rows and the output text; the denials panel has one `data-testid="goal-report-denial"` with its detail.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement.**
  - Markdown, after the "Verification rounds" block:

    ```ts
      lines.push('## Smoke checks', '')
      if (report.smoke.length === 0) {
        lines.push('No smoke check has run.', '')
      } else {
        lines.push('| Round | Outcome | Exit | Took | Commit checked | Sent back | Finished |', '| --- | --- | --- | --- | --- | --- | --- |')
        for (const s of report.smoke) {
          lines.push(
            `| ${String(s.round)} | ${mdInline(s.outcome.replace('_', ' '))} | ${s.exitCode === null ? '—' : String(s.exitCode)} | ` +
              `${s.durationMs === null ? '—' : `${String(Math.round(s.durationMs / 1000))} s`} | ${shortCommit(s.tip)} | ` +
              `${s.reworkedPackage === null ? '—' : mdInline(s.reworkedPackage)} | ${mdInline(s.at)} |`,
          )
        }
        const latest = report.smoke.at(-1)
        if (latest !== undefined && latest.output !== '') lines.push('', `Output of the latest smoke check (round ${String(latest.round)}):`, '', mdFence(latest.output))
        lines.push('')
      }
    ```

    After the "Verifier:" line and before "## Spend":

    ```ts
      lines.push('## Denied tool calls', '')
      if (report.deniedToolCalls.length === 0) lines.push('No tool call was denied.', '')
      for (const denial of report.deniedToolCalls) {
        lines.push(`- ${mdInline(denial.at)} · ${denial.packageKey === null ? 'the verifier' : mdInline(denial.packageKey)}: ${mdInline(denial.detail)} (run ${mdInline(denial.runId)})`)
      }
      if (report.deniedToolCallsOmitted > 0) lines.push(`- … and ${String(report.deniedToolCallsOmitted)} more, not listed.`)
      if (report.deniedToolCalls.length > 0) lines.push('')
    ```

    Update the section list in `renderGoalReportMarkdown`'s doc comment.
  - Loader (`goalReport.ts`), after `results`:

    ```ts
      // Skeleton spec S7 (plan B D10): every smoke attempt of the version, oldest first.
      const smokeRows = delivery === null ? [] : await prisma.smokeAttempt.findMany({ where: { goalDeliveryId: delivery.id }, orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] })
      const packageOfTask = new Map(scope.tasks.map((task) => [task.taskId, task.packageKey] as const))
      const smoke = smokeRows.map((row) => ({
        attemptId: row.id,
        round: row.round,
        outcome: row.status,
        exitCode: row.exitCode,
        durationMs: row.durationMs,
        tip: row.tip,
        output: row.output,
        at: (row.endedAt ?? row.startedAt).toISOString(),
        reworkedPackage: row.reworkedTaskId === null ? null : (packageOfTask.get(row.reworkedTaskId) ?? null),
      }))
      // Skeleton spec S9 (plan B D10): the denials of the version's runs -- its package tasks' and its verification runs'.
      const versionRuns = await prisma.slaveRun.findMany({
        where: { OR: [{ taskId: { in: scope.tasks.map((task) => task.taskId) } }, ...(delivery === null ? [] : [{ goalDeliveryId: delivery.id }])] },
        select: { id: true, taskId: true },
      })
      const taskOfRun = new Map(versionRuns.map((run) => [run.id, run.taskId] as const))
      const denialRows = await prisma.executionEvent.findMany({
        where: { runId: { in: versionRuns.map((run) => run.id) }, type: { in: ['guardrail_tripped', 'run_tool_denied'] } },
        orderBy: { seq: 'asc' },
        select: { runId: true, type: true, ts: true, payload: true },
      })
      const denials = denialRows.flatMap((row): GoalReportDenial[] => {
        const p = (row.payload ?? {}) as Record<string, unknown>
        const taskId = row.runId === null ? null : (taskOfRun.get(row.runId) ?? null)
        const base = { at: row.ts.toISOString(), runId: row.runId ?? '', packageKey: taskId === null ? null : (packageOfTask.get(taskId) ?? null) }
        if (row.type === 'guardrail_tripped') {
          return p['guardrail'] === 'permission_mode' && typeof p['detail'] === 'string' ? [{ ...base, kind: 'permission_mode', detail: p['detail'] }] : []
        }
        const tool = typeof p['tool'] === 'string' ? p['tool'] : 'a tool'
        const capability = typeof p['capability'] === 'string' ? ` (${p['capability']})` : ''
        return [{ ...base, kind: 'permission_matrix', detail: `${tool}${capability} was refused by the permission matrix` }]
      })
    ```

    Return `smoke`, `deniedToolCalls: denials.slice(0, GOAL_REPORT_DENIALS_MAX)`, `deniedToolCallsOmitted: Math.max(0, denials.length - GOAL_REPORT_DENIALS_MAX)`, and add `...smoke.map((s) => s.at)` to `stamps`.
  - Trail (`goalReportTrail.ts`): add `'workspace_smoke_run'` to `VERSION_TRAIL_TYPES` after `'workspace_goal_waiting'`, and in `eventDraft`:

    ```ts
        case 'workspace.smoke_run': {
          const outcome = (str(p, 'outcome') ?? '?').replace('_', ' ')
          const exit = typeof p['exitCode'] === 'number' ? ` (exit ${String(p['exitCode'])})` : ''
          const back = str(p, 'reworkedPackage')
          return {
            text: `Smoke check, round ${String(num(p, 'round'))}: ${outcome}${exit}${back === null ? '' : `; ${back} sent back`}.`,
            detail: outcome === 'passed' ? null : str(p, 'output'),
            detailBy: 'system',
          }
        }
    ```

    A `workspace.smoke_run` event carries `payload.version`, so the existing version filter picks it up. Confirm this in the loader test.
  - Web: two `Panel`s in the same order as the Markdown. `Panel title="Smoke checks"` lists `<li data-testid="goal-report-smoke">`, each with "Round N: outcome, exit X, took Y s, on commit Z, <package> sent back, finished T", and the latest output in `<pre className={PRE}>` as a JSX child. `Panel title="Denied tool calls"` lists `<li data-testid="goal-report-denial">` entries, each with at, package or "the verifier", detail and run id, plus the omitted count. The empty states use the Markdown's wording.
  - Every test fixture that builds a `GoalReport` literal gains `smoke: [], deniedToolCalls: [], deniedToolCallsOmitted: 0`. `npm run typecheck` names each one.

- [ ] **Step 4: Run** the domain goalReport tests, the loader's test, `goal-report-view.test.tsx`, then `npm run typecheck` and `npm run web:build && rm -rf apps/web/.next` → PASS.

- [ ] **Step 5: Commit** — `feat(report): every smoke attempt and every denied tool call of a goal version, on the page and in the export`.

---

### Task 7: End to end with the fake CLI

**Files:**
- Modify: `apps/orchestrator/test/integration/conductor-e2e.test.ts`

**Interfaces:**
- Consumes: everything above; Plan A's e2e fixture (`workFileFor` with `skeleton`, `checked('RUN', 'pass')` in the scripted rounds).

- [ ] **Step 1: Fixture.** Every conducted version extracted now carries `RUN`, so every test here now runs a smoke. `makeRepo` gains a `scripts/smoke.sh` in the initial commit. It is built by:

```ts
/** A smoke script that fails its first `failures` runs the way the 2026-09-29 project's image did,
 *  then passes -- counted in a file outside the repository, so no package's commit resets it. */
function smokeScript(stateFile: string, failures: number): string {
  return [
    '#!/usr/bin/env bash',
    `n=$(cat '${stateFile}' 2>/dev/null || echo 0)`,
    `echo $((n + 1)) > '${stateFile}'`,
    'echo "smoke project: $SLAVEOFAI_SMOKE_PROJECT"',
    `if [ "$n" -lt ${String(failures)} ]; then echo 'npm error Missing script: "start"' >&2; exit 1; fi`,
    'echo "flow ok"',
    '',
  ].join('\n')
}
```

`makeRepo(smoke: string)` writes it executable. `SeedOptions` gains `smokeFailures?: number` (default 0), and `seed` passes `smokeScript(join(mkdtempSync(join(tmpdir(), 'e2e-smoke-')), 'count'), options.smokeFailures ?? 0)`. The skeleton owns `scripts/smoke.sh`, and no fake worker writes it. Add `'SmokeAttempt'` to the `beforeEach` TRUNCATE list.

- [ ] **Step 2: New and changed assertions**
  - "takes a conducted goal…" (single): one `SmokeAttempt`, `passed`, round 1, `tip` equal to the verified commit. The verification run's prompt contains `'flow ok'`. `workspace.goal_accepted` still has `rounds: 1`. No `verify-*` worktree is left, smoke ones included.
  - New test: a partitioned goal whose smoke fails once, then is accepted.

    ```ts
      it('sends a partitioned goal whose smoke fails back to integration, then accepts it with RUN verified', async (): Promise<void> => {
        const f = await seed({ conductAnswer: PARTITIONED, smokeFailures: 1 })
        await tickUntil(f, merged(f, 1))
        const d1 = await delivery(f, 1)
        const attempts = await prisma.smokeAttempt.findMany({ where: { goalDeliveryId: d1?.id ?? '' }, orderBy: { startedAt: 'asc' } })
        expect(attempts.map((a) => [a.round, a.status])).toEqual([[1, 'failed'], [2, 'passed']])
        const integration = await implementationRunsOf(f, 'integration')
        expect(integration).toHaveLength(2)
        expect(integration[1]?.prompt).toContain('The smoke check of verification round 1 failed')
        expect(integration[1]?.prompt).toContain('Missing script: "start"')
        expect(await implementationRunsOf(f, 'skeleton')).toHaveLength(1)
        expect(await implementationRunsOf(f, 'report')).toHaveLength(1)
        // One verification run, in round 2, after the passing smoke.
        const verifications = f.starts.filter((s) => s.kind === 'verification')
        expect(verifications.map((s) => /Verification round (\d+)/.exec(s.prompt)?.[1])).toEqual(['2'])
        expect(verifications[0]?.prompt).toContain('flow ok')
        expect((await goalEvents(f)).find((e) => e.type === 'workspace.goal_accepted')?.payload).toEqual({ version: 1, rounds: 2 })
        expect(await prisma.verificationResult.findFirst({ where: { key: 'RUN' }, select: { status: true } })).toEqual({ status: 'pass' })
        const report = await loadGoalReport(f.workspaceId, 1)
        expect(report.ok && report.value.smoke.map((s) => [s.round, s.outcome, s.reworkedPackage])).toEqual([[1, 'failed', 'integration'], [2, 'passed', null]])
        expect(verifyWorktrees(f)).toEqual([])
      })
    ```
  - "reworks only the package…", "stops for a person…" and "ends in needs_human when the round cap…" keep their assertions. Their smoke passes on every tip. Add to "stops for a person…": after `retryGoal`, still exactly one `SmokeAttempt` (plan B D5: an unchanged tree is not smoked again).

- [ ] **Step 3: Run** `npx tsc --build && npx vitest run apps/orchestrator/test/integration/conductor-e2e.test.ts` → PASS.

- [ ] **Step 4: Commit** — `test(smoke): a goal is smoke-checked end to end, reworked where the smoke fails, and accepted`.

---

### Task 8: Whole suite, web build, gates

- [ ] **Step 1:** Stop any daemon, and make sure no `next dev` is running. Run `npm run typecheck`, then `npx vitest run > "$SCRATCH/skeleton-b-suite.log" 2>&1` in the background. Wait on the log's summary line, not on `pgrep`. Re-run any failing file alone before believing it.
- [ ] **Step 2:** `npm run web:build && rm -rf apps/web/.next`; `node scripts/gate-m26-vocabulary.mjs`; `git grep -n "agency-agents"` prints nothing.
- [ ] **Step 3:** `DATABASE_URL="$GATE_DATABASE_URL" npm run db:migrate`. Then run the CI gate list with the fake-CLI env exactly as `ci.yml` sets it, `DATABASE_URL="$GATE_DATABASE_URL"`, under `systemd-inhibit --what=sleep:idle`, with `CHROMIUM_PATH` set. Known red on main: m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58. m56a must be green (stage 12: 24 situations, 74 lanes, hook-plane digests unchanged, `prisma migrate diff` clean). A gate that drives a conducted goal to acceptance with a fixture repository that has no `scripts/smoke.sh` now stops with a skeleton or single rework. That is the intended legacy path (spec §4). Give such a gate's fixture a passing `scripts/smoke.sh`, and never loosen the product. Compare any other red gate against the same gate on main.

---

## Self-review notes (for the executor)

- Spec coverage: S7 fresh detached worktree of the tip → Task 3 (D6). Timeout + group kill + worktree removed pass or fail → Task 3 (tests: timeout, pass). Constrained env + `SLAVEOFAI_SMOKE_PROJECT` → Task 3 (`smokeEnv`, pass test). One event per attempt with exit code, duration, trimmed output → Tasks 1, 3. Shown on the report page → Task 6. Pass → verification dispatched with smoke evidence → Tasks 4, 5. Stub/missing → skeleton (single: the one) → Tasks 2, 3. Other exit / timeout → integration → Tasks 2, 3. A failed attempt spends a round, and the cap gives `needs_human` with the output → Tasks 3, 4 (D3). An orchestrator failure is retried like an unusable verification → Tasks 3, 4 (D3, D8). S8's smoke output → Task 5. S9's report listing → Task 6. §4 legacy: versions without `RUN` keep `smokeRequired: false` (Task 4); a legacy project whose next version has no `smoke.sh` → `missing` → skeleton/single rework, whose reason says it does not exist yet (Tasks 2, 3). §5 `Workspace.smokeTimeoutMs` → Task 1.
- Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Task 6 only needs Task 1's table and may run after Task 3.
- Names used across tasks: `SMOKE_OUTCOMES`, `SmokeOutcome`, `SMOKE_OUTPUT_MAX_CHARS`, `SMOKE_STRANDED_GRACE_MS`, `SmokeFailure`, `classifySmoke`, `smokeReworkTarget`, `smokeProjectName`, `renderSmokeRework`, `smokeStopReason`, `renderSmokeEvidence`, `activeSmokeIds`, `smokeWorktreeKey`, `smokeEnv`, `startSmoke`, `applySmokeOutcome`, `settleStrandedSmoke`, `passedSmokeAtTip`, `smokeErrorsInRound`, `GoalReportSmoke`, `GoalReportDenial`, `GOAL_REPORT_DENIALS_MAX`.
