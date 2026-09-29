# Conductor, Plan 4a of 5: a goal version is built on its own integration branch and reaches the base branch once

> **For workers carrying this out:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec R9's "where merges go" and §5's merge-failure rule: every conducted goal version gets an integration branch cut from the base branch; its package tasks are cut from, audited against, reviewed against and merged into that branch; when every package is integrated the version is accepted and merged into the base branch once (honouring `autoMerge`); no later goal version is conducted until the current one has reached the base branch or the person abandons it; a package that fails to merge twice is escalated alone, the workspace keeps running.

**Architecture:** A new row, `GoalDelivery`, one per conducted goal version, records the integration branch and the version's delivery state (`integrating → accepted → merged`, or `abandoned`). It is written in the conductor's materialisation transaction, after the branch is cut. One orchestrator helper, `integrationTargetFor(taskId)`, answers "which branch was this task cut from and merges into" for every consumer (dispatch, the ownership audit, review, the merge pass); a package task with no `GoalDelivery` (a version materialised before this plan) keeps today's base-branch path. The merge pass merges a package into a dedicated integration worktree, never the primary checkout. A new tick pass, `runGoalPass`, accepts a version whose packages are all integrated and merges its branch into the base branch in the primary checkout, once. Plan 4b inserts the verification run and the gate between "all integrated" and "accepted".

**Tech Stack:** TypeScript monorepo (npm workspaces, ESM, `.js` import suffixes), Prisma/Postgres, git worktrees, vitest (unit + integration projects), Next.js (`apps/web`).

**Spec:** `docs/superpowers/specs/2026-09-27-conductor-supervisor-design.md` (R9 "Where merges go", R9's last sentence, §5 bullets 3–4). Plans 1–3 shipped R0–R7 and R4. **Plan 4a comes first; Plan 4b** (`2026-09-28-conductor-4b-verification.md`) adds R8, R9's gate and loop, R11's `verification_failed`/`goal_needs_human`, and §5's `conducted` default. Plan 5 = R10.

## Decisions this plan makes (read before starting)

- **D1. The integration branch is `slaveofai/goal-v<n>-<ws8>`**, `<ws8>` = the workspace id's first 8 hex characters. Spec R9 says `slaveofai/goal-v<n>`; a workspace re-created on the same repository starts again at goal v1 and would find a stale `slaveofai/goal-v1` from its predecessor, which `git branch` refuses and the conductor could never get past. *Cost if wrong:* cosmetic — one helper (`integrationBranchName`) spells it.
- **D2. Package merges land in a dedicated integration worktree** (`<worktreeRoot>/goal-v<n>-<ws8>`, checked out on the integration branch), never in the primary checkout. The primary checkout is shared with the person and is touched once per goal version, at the final merge. A branch can be checked out in only one worktree, so everything else that reads the integration branch (package worktrees are `-b` off it; Plan 4b's verification worktree is `--detach`) never checks it out. *Cost if wrong:* one extra worktree per open goal version on disk.
- **D3. `autoMerge` governs only the final merge into the base branch** (spec R9: "the workspace's `autoMerge` setting deciding whether a person confirms it"). A package merges into its goal's integration branch whatever `autoMerge` says — that branch is Slave's staging area, and a version whose packages wait for a person one by one could never reach its gate. *Cost if wrong:* a person who wanted to approve every package merge cannot; they still approve the one that reaches their base branch.
- **D4. On a package task, `integratedAt` means "on its goal version's integration branch".** `world.ts`'s dependency gate reads it, and a dependent package must start from a branch that has its dependency's commits — which is exactly the integration branch. The M53 integration evidence (`settleTaskEvidence(..., { kind: 'integration' })`) is settled at the FINAL merge, for every package task of the version, because "integrated" in the ranker means "reached the base branch". An abandoned version settles nothing (null = not judged). *Cost if wrong:* the ranker's third rate lags by one goal version for conducted work.
- **D5. A `GoalDelivery` row is the switch.** A package task whose goal version has a `GoalDelivery` rides the integration branch; one without (a version materialised before this plan, on a live workspace) keeps today's base-branch path unchanged. No data migration. *Cost if wrong:* none — the old path is the one Plans 2–3 shipped and tested.
- **D6. A later goal version is conducted only when every earlier `GoalDelivery` of the workspace is merged or abandoned** (spec R9: "No task of a later goal version is dispatched until the current one is accepted or the person moves on"). Tasks of version N+1 exist only once it is conducted, so gating the conductor gates their dispatch. "Accepted" is not enough: version N+1's branch is cut from the base branch, which lacks version N's work until the merge — so an accepted-but-unmerged version (`autoMerge` off) holds the next one until a person confirms the merge. Plan 2's D5 board check stays for boards left over from `planned` delivery. The wait is said once per (version, what it waits on) with its own event `workspace.goal_waiting`, **replacing** the `conductor_failed` guardrail the wait used to borrow (deferred Plan 2 item: the Home feed read it as "a task is blocked and needs you"). *Cost if wrong:* a person who wants two goal versions in flight at once cannot; they abandon the first.
- **D7. A package that fails to merge into its integration branch twice is blocked, not the workspace** (spec §5). First failure: today's rework (attempt charged, reason on the task). Second and later: the task goes `blocked` (the "a person must look at this" status `unblock-task` leaves) with a task-scoped `guardrail.tripped { guardrail: 'merge_failure' }` — no `haltedReason`. The Supervisor's existing `task_blocked_human` picks it up. Planned-delivery tasks and package tasks with no `GoalDelivery` keep today's halt. *Cost if wrong:* a genuinely broken base (every merge fails) no longer stops the whole workspace; each package blocks separately, which is what §5 asks for.
- **D8. Until Plan 4b lands, a version is accepted as soon as every package is integrated** — the per-task verify and review are its only gates. Safe because `conducted` stays opt-in (Plan 2 D1) until Plan 4b flips the default in the same plan that adds the verification gate. *Cost if wrong:* none outside workspaces a person explicitly switched to `conducted`.
- **D9. The final merge is attempted once per acceptance.** A primary checkout that is dirty or on another branch is a WAIT, not a failure (the person is working there): the pass retries next tick and says so once (`workspace.goal_waiting` is not reused — a `guardrail.tripped merge_failure` with the version in its detail, deduped by detail). A merge git refuses (a conflict: the person committed to the base branch meanwhile) is aborted, recorded on `GoalDelivery.mergeError`, tripped once, and left for the person to merge by hand and confirm with `confirm-goal-merge`. The merged tree is not re-verified. *Cost if wrong:* a base branch that moved during a goal version gets a merge nobody re-checked; Plan 5's report shows the merge commit.
- **D10. Abandoning a goal version is the person "moving on"** (`abandon-goal`). Refused while any package task of the version holds a run or a merge claim (stop it first); otherwise every unfinished package task is cancelled through the existing `cancelTask` and the version is `abandoned`. The integration branch and worktree are kept for inspection. *Cost if wrong:* a person must stop runs before abandoning.
- **D11. A package that legitimately needs a shared file gets no new remedy in Plan 4.** Today's remedies stand: the integration package owns every path no other package owns (so wiring usually lands there); a worker that needs a foreign file is told to ask the conductor (`renderPackageContract`); two audit violations raise `foreign_file` to a person; and this plan adds the person's way out — `abandon-goal`, then set the goal again (the conductor decides afresh, `single` by default). A real remedy (transferring a path between packages mid-version, or re-conducting as `single`) changes another package's rule under a live worker and belongs with Plan 5's report, where the person can see why. *Cost if wrong:* a badly split goal costs one abandoned version before it is delivered.
- **D12. The ownership audit and the review diff compare against the branch the task was cut from** (carried from Plan 3's final review). `auditOwnership` and `buildReviewDiff` take the integration branch as their base for a governed task: the three-dot range then excludes the dependency work already merged into it, and after a later rework (Plan 4b) shows only the rework's own changes. `undoInstruction` names the same base.

## Global Constraints

- Vocabulary: the product says "slave", never "agent" (`node scripts/gate-m26-vocabulary.mjs`). Never write the string "agency-agents" anywhere tracked.
- Never run prettier (no config in the repo). Match surrounding code: WHY doc comments, `readonly`, explicit return types, `.js` import suffixes, `Result`/`ok`/`err`.
- Tests: `set -a; . ./.env; set +a; export DATABASE_URL=$TEST_DATABASE_URL` in the shell first. ONE vitest process at a time (shared test DB). Iterate per file (`npx vitest run <file>`); `npm run typecheck` (never `tsc --build` alone — it misses the test tsconfigs and `apps/web`) before every commit; the whole suite once, at the end, in the background.
- `apps/web` changes gate on `npm run web:build` (no `next dev` may be running; `rm -rf apps/web/.next` afterwards).
- Never touch the dev DB. Never `db:seed`. Gates only on `DATABASE_URL="$GATE_DATABASE_URL"` with the fake-CLI env exactly as `.github/workflows/ci.yml` sets it (`SLAVEOFAI_CLAUDE_BIN`/`SLAVEOFAI_CURSOR_BIN` from `scripts/gate-fakes`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`) under `systemd-inhibit --what=sleep:idle`. Red on main today, not regressions: m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58.
- Migrations: hand-written, purely additive, WHY header, dated name; `npm run db:generate && npm run db:migrate:test`.
- Inside a Prisma interactive transaction a refusal must THROW to roll back; a returned value commits what was written.
- `vi.spyOn` on a Prisma delegate breaks later tests: assign a wrapper and restore in `finally`.
- Never `TRUNCATE "SlaveTemplate" CASCADE` in a test; delete your own template rows by id.
- Every git command the orchestrator runs goes through `gitIn` (identity-scoped) or `execFile('git', …)` with a timeout; never `git stash` (shared `refs/stash`).
- Every commit message ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec R9 verbatim: "A conducted goal version gets an integration branch `slaveofai/goal-v<n>` cut from the base branch. Package tasks merge into it with today's merge pass (rebase, post-rebase verify commands, serial), not into the base branch. When the goal version is accepted, the integration branch is merged into the base branch once (fast-forward or a merge commit, the workspace's `autoMerge` setting deciding whether a person confirms it, as today). No task of a later goal version is dispatched until the current one is accepted or the person moves on."
- Spec §5 verbatim: "Repeated merge failure no longer halts a conducted workspace: disjoint ownership removes the cause; a merge failure into the integration branch goes back to its package's rework once, then escalates that package only. A conducted workspace's base branch changes only when a goal version is accepted (R9)."

## Review Focus

- A person's primary checkout that is dirty, or on another branch, when a goal version is accepted: nothing is merged, nothing is lost, the pass waits and says so once, and the merge happens on the first tick after the checkout is clean (Task 5 test).
- The base branch moved (the person committed to it) between the cut and the acceptance, touching the same lines: the final merge is aborted cleanly (`git status` of the primary checkout is empty afterwards), `mergeError` is recorded, and no later tick retries it by itself (Task 5 test).
- A dependent package starts only after its dependency is merged into the integration branch, and its worktree has the dependency's commit (Task 3 + Task 7 tests).
- A daemon that crashed between cutting the integration branch and committing the `GoalDelivery` row re-conducts the same version on the next tick without refusing on the existing branch (Task 2 test: the branch exists, the row does not → the branch is reused if it points at a commit on the base branch's history).
- A goal set to a new version while the previous version's packages are still running: the running packages finish and merge; the new version is conducted only after the previous one merged, and `workspace.goal_waiting` says so exactly once (Task 2 test).

---

### Task 1: The goal delivery's data, its events and how they read

**Files:**
- Create: `packages/db/prisma/migrations/20260929090000_goal_delivery/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (`enum GoalDeliveryStatus`, `model GoalDelivery`, `Workspace.goalDeliveries`, `enum EventType` + 4 values, the `Delivery` enum's doc comment is untouched here — Plan 4b rewrites it)
- Modify: `packages/db/src/enums.ts` (4 mappings)
- Modify: `packages/domain/src/events/schema.ts` (4 variants)
- Create: `packages/domain/src/conduct/goalBranch.ts`; Modify: `packages/domain/src/conduct/index.ts`
- Modify: `packages/domain/src/supervisor/timeline.ts` (`LANE_BY_TYPE` + 4)
- Modify: `apps/web/src/components/activity/cards.tsx` (4 cards + registry), `apps/web/src/lib/activityFilters.ts` (`workspace` chip + 4), `apps/web/src/server/timeline.ts` (`titleFor` cases for the 3 on a lane)
- Modify: `scripts/gate-m56a-provider-contract.mjs` (stage 12: `LANE_BY_TYPE` 65 → 69, comment names this plan's four events)
- Test: `packages/domain/test/conduct/goalBranch.test.ts`, `packages/domain/test/events/conductor-events.test.ts` (extend), `packages/domain/test/supervisor/timeline.test.ts` (length 65 → 69), `apps/web/test/activity-cards.test.tsx` (`PAYLOAD_BY_TYPE` + 4), `packages/db/test/integration/enum-parity.test.ts` (unchanged; must stay green)

**Interfaces:**
- Produces (Prisma):
  - `enum GoalDeliveryStatus { integrating accepted abandoned }` (Plan 4b adds `verifying`, `needs_human`).
  - `model GoalDelivery { id, workspaceId, goalVersion Int, integrationBranch String, baseCommit String, status GoalDeliveryStatus @default(integrating), acceptedAt DateTime?, mergedAt DateTime?, mergeError String?, createdAt; @@unique([workspaceId, goalVersion]) }`, cascade from `Workspace`.
- Produces (events, `@slave-of-ai/domain`):
  - `workspace.goal_waiting { version: int>0, waitingOn: int>0 | null }` — `waitingOn` is the earlier goal version it waits for, `null` for a board left over from `planned` delivery.
  - `workspace.goal_accepted { version: int>0, rounds: int>=0 }` — `rounds` is the verification rounds it took (always 0 in 4a).
  - `workspace.goal_merged { version: int>0, branch: string, into: string, commit: string, by: 'system' | 'human' }`.
  - `workspace.goal_abandoned { version: int>0, cancelled: string[] /* task ids, ≤ 50 */ }`.
  - DB values `workspace_goal_waiting`, `workspace_goal_accepted`, `workspace_goal_merged`, `workspace_goal_abandoned`.
- Produces (domain helper): `export function integrationBranchName(version: number, workspaceId: string): string` → `` `slaveofai/goal-v${version}-${workspaceId.slice(0, 8)}` ``; `export function integrationWorktreeKey(version: number, workspaceId: string): string` → `` `goal-v${version}-${workspaceId.slice(0, 8)}` `` (a path segment under `worktreeRootFor`).

- [ ] **Step 1: Migration**

`packages/db/prisma/migrations/20260929090000_goal_delivery/migration.sql`:
```sql
-- Conductor Plan 4a (spec R9 "Where merges go", §5), 2026-09-29: a goal version is built on its own
-- integration branch and reaches the base branch once.
--
-- One `GoalDelivery` row per conducted goal version: the integration branch the conductor cut from
-- the base branch (and the base commit it was cut at), and where the version stands --
-- `integrating` while its packages are worked and merged into that branch, `accepted` once every
-- package is integrated (Plan 4b: once every requirement is verified), `abandoned` when the person
-- moved on. `mergedAt` is when the branch reached the base branch; `mergeError` is a final merge git
-- refused, left for a person. PURELY ADDITIVE: one enum type, one table, four event values, unused
-- inside this migration's transaction (which Postgres 12+ requires of `ADD VALUE`).

CREATE TYPE "GoalDeliveryStatus" AS ENUM ('integrating', 'accepted', 'abandoned');

CREATE TABLE "GoalDelivery" (
    "id"                TEXT NOT NULL,
    "workspaceId"       TEXT NOT NULL,
    "goalVersion"       INTEGER NOT NULL,
    "integrationBranch" TEXT NOT NULL,
    "baseCommit"        TEXT NOT NULL,
    "status"            "GoalDeliveryStatus" NOT NULL DEFAULT 'integrating',
    "acceptedAt"        TIMESTAMP(3),
    "mergedAt"          TIMESTAMP(3),
    "mergeError"        TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GoalDelivery_workspaceId_goalVersion_key" ON "GoalDelivery"("workspaceId", "goalVersion");
ALTER TABLE "GoalDelivery" ADD CONSTRAINT "GoalDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.goal_waiting';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.goal_accepted';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.goal_merged';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.goal_abandoned';
```

Schema (next to `ConductorCall`):
```prisma
/// Conductor Plan 4a (spec R9): where one conducted goal version stands. `integrating` while its
/// packages are merged into `integrationBranch`; `accepted` once the version passed its gate
/// (4a: every package integrated; 4b: every requirement verified); `abandoned` when the person
/// moved on. `mergedAt` is when the integration branch reached the base branch -- the next goal
/// version is conducted only after it (or an abandon).
enum GoalDeliveryStatus {
  integrating
  accepted
  abandoned
}

model GoalDelivery {
  id                String             @id @default(uuid())
  workspaceId       String
  goalVersion       Int
  integrationBranch String
  /// The base branch's commit the integration branch was cut at -- what the version's diff is
  /// measured from.
  baseCommit        String
  status            GoalDeliveryStatus @default(integrating)
  acceptedAt        DateTime?
  mergedAt          DateTime?
  /// A final merge git refused (plan D9): left for a person to merge by hand and confirm.
  mergeError        String?
  createdAt         DateTime           @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, goalVersion])
}
```
Add `goalDeliveries GoalDelivery[]` to `model Workspace`. In `enum EventType`, after `workspace_conducted`:
```prisma
  /// Conductor Plan 4a (spec R9): the goal version waits for an earlier one to reach the base branch
  /// (or for a planned board to go quiet) before it is conducted.
  workspace_goal_waiting      @map("workspace.goal_waiting")
  /// Conductor Plan 4a: every package of a goal version is integrated (4b: every requirement verified).
  workspace_goal_accepted     @map("workspace.goal_accepted")
  /// Conductor Plan 4a: a goal version's integration branch reached the base branch.
  workspace_goal_merged       @map("workspace.goal_merged")
  /// Conductor Plan 4a: the person moved on from a goal version; its unfinished packages were cancelled.
  workspace_goal_abandoned    @map("workspace.goal_abandoned")
```
`packages/db/src/enums.ts`, after `'workspace.conducted'`:
```ts
  'workspace.goal_waiting': 'workspace_goal_waiting',
  'workspace.goal_accepted': 'workspace_goal_accepted',
  'workspace.goal_merged': 'workspace_goal_merged',
  'workspace.goal_abandoned': 'workspace_goal_abandoned',
```
Run `npm run db:generate && npm run db:migrate:test`.

- [ ] **Step 2: Failing tests**

`packages/domain/test/conduct/goalBranch.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { integrationBranchName, integrationWorktreeKey } from '../../src/conduct/goalBranch.js'

describe('integrationBranchName', () => {
  it('names the version and the workspace', () => {
    expect(integrationBranchName(3, '0c1d2e3f-aaaa-4bbb-8ccc-123456789abc')).toBe('slaveofai/goal-v3-0c1d2e3f')
    expect(integrationWorktreeKey(3, '0c1d2e3f-aaaa-4bbb-8ccc-123456789abc')).toBe('goal-v3-0c1d2e3f')
  })

  it('refuses a version that is not a positive integer', () => {
    expect(() => integrationBranchName(0, 'x')).toThrow(/positive integer/)
  })
})
```
In `conductor-events.test.ts`, one parse per new event through the domain's event schema (copy the file's existing `workspace.conducted` case): a valid payload parses; `workspace.goal_waiting` with `waitingOn: null` parses; `workspace.goal_merged` with `by: 'robot'` is refused; `workspace.goal_abandoned` with 51 ids is refused.
In `timeline.test.ts` change the `LANE_BY_TYPE` length expectation from 65 to 69.
In `apps/web/test/activity-cards.test.tsx` add to `PAYLOAD_BY_TYPE`:
```ts
  'workspace.goal_waiting': { version: 2, waitingOn: 1 },
  'workspace.goal_accepted': { version: 1, rounds: 0 },
  'workspace.goal_merged': { version: 1, branch: 'slaveofai/goal-v1-0c1d2e3f', into: 'main', commit: 'abc1234', by: 'system' },
  'workspace.goal_abandoned': { version: 1, cancelled: ['t1', 't2'] },
```

- [ ] **Step 3: Run to see them fail** — `npx vitest run packages/domain/test/conduct/goalBranch.test.ts packages/domain/test/events/conductor-events.test.ts packages/domain/test/supervisor/timeline.test.ts` → FAIL.

- [ ] **Step 4: Implement**

`packages/domain/src/conduct/goalBranch.ts`:
```ts
/**
 * The integration branch of one conducted goal version (spec R9), and the path segment of the
 * worktree the merge pass keeps checked out on it. The workspace's first eight id characters are
 * part of the name (plan D1): a workspace re-created on the same repository starts again at goal v1,
 * and a bare `slaveofai/goal-v1` left by its predecessor would make every conduct refuse.
 */
export function integrationBranchName(version: number, workspaceId: string): string {
  return `slaveofai/${integrationWorktreeKey(version, workspaceId)}`
}

export function integrationWorktreeKey(version: number, workspaceId: string): string {
  if (!Number.isInteger(version) || version <= 0) throw new Error(`goal version must be a positive integer, got ${String(version)}`)
  return `goal-v${String(version)}-${workspaceId.slice(0, 8)}`
}
```
Export it from `conduct/index.ts`.

`events/schema.ts`, after the `workspace.conducted` variant:
```ts
  // Conductor Plan 4a (spec R9): a goal version is not conducted while an earlier one has not
  // reached the base branch (`waitingOn` names it) or a planned board is still live (`null`).
  z.object({
    ...envelope,
    type: z.literal('workspace.goal_waiting'),
    payload: z.object({ version: z.number().int().positive(), waitingOn: z.number().int().positive().nullable() }),
  }),
  // Conductor Plan 4a: the version passed its gate. `rounds` is how many verification rounds it
  // took (Plan 4b); 0 when acceptance was every package integrated.
  z.object({
    ...envelope,
    type: z.literal('workspace.goal_accepted'),
    payload: z.object({ version: z.number().int().positive(), rounds: z.number().int().nonnegative() }),
  }),
  // Conductor Plan 4a: the integration branch reached the base branch -- merged by the goal pass
  // (`system`) or by a person and confirmed (`human`).
  z.object({
    ...envelope,
    type: z.literal('workspace.goal_merged'),
    payload: z.object({
      version: z.number().int().positive(),
      branch: z.string().min(1),
      into: z.string().min(1),
      commit: z.string().min(1),
      by: z.enum(['system', 'human']),
    }),
  }),
  // Conductor Plan 4a (plan D10): the person moved on; `cancelled` are the package tasks cancelled.
  z.object({
    ...envelope,
    type: z.literal('workspace.goal_abandoned'),
    payload: z.object({ version: z.number().int().positive(), cancelled: z.array(z.string().min(1)).max(50) }),
  }),
```
`timeline.ts` `LANE_BY_TYPE`: `'workspace.goal_waiting': null` (a wait is not news on the timeline; its card is in the feed), `'workspace.goal_accepted': 'verified'`, `'workspace.goal_merged': 'verified'`, `'workspace.goal_abandoned': 'plan_change'`, each with a one-line comment in the file's style.

Web: in `cards.tsx`, four cards in `WorkspaceConductedCard`'s shape, registered in the `satisfies Record<DomainEventType, …>` registry:
```tsx
/** Conductor Plan 4a: a goal version waiting for an earlier one to reach the base branch. */
function WorkspaceGoalWaitingCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { version: number; waitingOn: number | null }
  const on = payload.waitingOn === null ? 'the work already on the board' : `goal v${String(payload.waitingOn)} to be merged`
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label={`goal v${String(payload.version)} waits for ${on}`} />
    </ActivityCard>
  )
}

/** Conductor Plan 4a: every package of a goal version integrated (4b: every requirement verified). */
function WorkspaceGoalAcceptedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { version: number; rounds: number }
  const rounds = payload.rounds === 0 ? '' : ` after ${plural(payload.rounds, 'verification round')}`
  return (
    <ActivityCard {...props}>
      <Transition tone="success" label={`goal v${String(payload.version)} accepted${rounds}`} />
    </ActivityCard>
  )
}

/** Conductor Plan 4a: a goal version's integration branch reached the base branch. */
function WorkspaceGoalMergedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { version: number; into: string; commit: string; by: 'system' | 'human' }
  return (
    <ActivityCard {...props}>
      <Transition
        tone="success"
        label={`goal v${String(payload.version)} merged into ${payload.into}${payload.by === 'human' ? ' by hand' : ''}`}
      >
        <span data-testid="goal-merged-commit">{payload.commit.slice(0, 12)}</span>
      </Transition>
    </ActivityCard>
  )
}

/** Conductor Plan 4a: the person moved on from a goal version. */
function WorkspaceGoalAbandonedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as { version: number; cancelled: readonly string[] }
  return (
    <ActivityCard {...props}>
      <Transition
        tone="idle"
        label={`goal v${String(payload.version)} abandoned; ${plural(payload.cancelled.length, 'unfinished package')} cancelled`}
      />
    </ActivityCard>
  )
}
```
(Check `Transition`'s `tone` union in the file — use the tones the file already uses for a success and an idle transition; if `success` is not one, use the tone `task.done`'s card uses.) `activityFilters.ts`: the four types under the `workspace` chip after `'workspace.conducted'`, with a comment. `server/timeline.ts` `titleFor`, after the `workspace.conducted` case:
```ts
    // Conductor Plan 4a: a goal version's gate passed, and its branch reached the base branch.
    case 'workspace.goal_accepted': {
      const version = payload['version']
      return `accepted goal v${typeof version === 'number' ? String(version) : '?'}`
    }
    case 'workspace.goal_merged': {
      const version = payload['version']
      const into = payload['into']
      return `merged goal v${typeof version === 'number' ? String(version) : '?'} into ${typeof into === 'string' ? into : 'the base branch'}`
    }
    case 'workspace.goal_abandoned': {
      const version = payload['version']
      return `abandoned goal v${typeof version === 'number' ? String(version) : '?'}`
    }
```
m56a stage 12: `65` → `69` in both the check and its message; extend the comment: "Conductor Plan 4a added four events: `workspace.goal_waiting`, `workspace.goal_accepted`, `workspace.goal_merged`, `workspace.goal_abandoned`."

- [ ] **Step 5: Run** the three domain tests, `npx vitest run packages/db/test/integration/enum-parity.test.ts`, `npx vitest run apps/web/test/activity-cards.test.tsx apps/web/test/activityFilters.test.ts apps/web/test/activity-filterbar.test.tsx`, `npm run typecheck`, `npm run web:build && rm -rf apps/web/.next` → PASS.

- [ ] **Step 6: Commit** — `feat(conductor): a goal version's delivery row and its four events`.

---

### Task 2: The conductor cuts the integration branch, and a later goal waits for the earlier one

**Files:**
- Create: `apps/orchestrator/src/goalBranch.ts` (`ensureIntegrationBranch`)
- Modify: `apps/orchestrator/src/conductor.ts` (`decideAndMaterialise`, `materialise`, `conduct`'s wait, `boardIsBusy`, new `goalWaiting`)
- Test: `apps/orchestrator/test/integration/goal-branch.test.ts` (new), `apps/orchestrator/test/integration/conductor.test.ts` (wait cases updated)

**Interfaces:**
- Consumes: `integrationBranchName` (Task 1), `gitIn` (`./worktree.js`), the `GoalDelivery` model (Task 1).
- Produces:
  - `export async function ensureIntegrationBranch(repoPath: string, baseBranch: string, branch: string): Promise<{ readonly baseCommit: string }>` — creates `branch` at `baseBranch`'s tip, or reuses it when it already exists AND is an ancestor-or-equal of nothing foreign (its tip is `baseBranch`'s tip or an ancestor of it: `git merge-base --is-ancestor <branch> <baseBranch>`); throws `Error('integration branch <b> exists and is not on <base>'s history')` otherwise. Returns the commit the branch points at.
  - `materialise(...)` gains a `delivery: { readonly integrationBranch: string; readonly baseCommit: string }` parameter and creates the `GoalDelivery` row inside its transaction.
  - `export type ConductStep` unchanged.

- [ ] **Step 1: Failing tests** (`goal-branch.test.ts`; temp repo helpers copied from `conductor-e2e.test.ts`'s `makeRepo`):
  - `ensureIntegrationBranch(repo, 'main', 'slaveofai/goal-v1-abcdef12')` creates the branch at `main`'s tip and returns that sha.
  - Called again (the crash-before-commit replay): returns the same sha, no error.
  - A branch of that name that has a commit not on `main` → throws `/is not on main's history/`.
  - A conducted fixture (reuse `conductor.test.ts`'s seed with the injected decider answering requirements then `single`): after the materialising tick, one `GoalDelivery` row `{ goalVersion: 1, status: 'integrating', integrationBranch: integrationBranchName(1, ws.id), baseCommit: <main tip> }` exists and the branch exists in the repo.
  - When `ensureIntegrationBranch` throws (pre-create the foreign branch), the tick returns `'conduct_failed'`, no `WorkPackage` and no `GoalDelivery` rows exist, and one `guardrail.tripped conductor_failed` names the branch.

  In `conductor.test.ts` (read its existing "board is busy" case first and replace its `conductor_failed` assertions):
  - A planned-board leftover (a live task with no package) → step `'waiting'`, exactly one `workspace.goal_waiting { version: 1, waitingOn: null }` after two ticks, and NO `guardrail.tripped conductor_failed`.
  - A `GoalDelivery` for v1 with `status: 'accepted', mergedAt: null` and goal moved to v2 → `'waiting'`, one `workspace.goal_waiting { version: 2, waitingOn: 1 }` after two ticks; set `mergedAt` → the next tick extracts v2's requirements.
  - v1 `abandoned` → v2 proceeds.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement**

`apps/orchestrator/src/goalBranch.ts`:
```ts
import { gitIn } from './worktree.js'

/**
 * Cuts a conducted goal version's integration branch from the base branch (spec R9), or reuses it.
 *
 * Reuse is the crash case: the branch is cut BEFORE the materialisation transaction (git is not
 * transactional), so a daemon that died between the two finds its own branch on the next tick.
 * It is reused only while it carries nothing the base branch does not -- a branch of this name with
 * commits of its own is somebody else's, and building a goal version on it would ship them.
 */
export async function ensureIntegrationBranch(
  repoPath: string,
  baseBranch: string,
  branch: string,
): Promise<{ readonly baseCommit: string }> {
  const exists = await gitIn(repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(
    () => true,
    () => false,
  )
  if (!exists) {
    await gitIn(repoPath, 'branch', branch, baseBranch)
  } else {
    const onBase = await gitIn(repoPath, 'merge-base', '--is-ancestor', branch, baseBranch).then(
      () => true,
      () => false,
    )
    if (!onBase) throw new Error(`integration branch ${branch} exists and is not on ${baseBranch}'s history`)
  }
  return { baseCommit: await gitIn(repoPath, 'rev-parse', branch) }
}
```
In `conductor.ts` `decideAndMaterialise`, after staffing succeeds and before `materialise`:
```ts
  const integrationBranch = integrationBranchName(version, workspaceId)
  let cut: { readonly baseCommit: string }
  try {
    cut = await ensureIntegrationBranch(workspace.repoPath, workspace.baseBranch, integrationBranch)
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] ?? error.message : String(error)
    await tripConductor(workspaceId, `goal v${version} could not cut its integration branch: ${message}`)
    return 'conduct_failed'
  }
```
and pass `{ integrationBranch, baseCommit: cut.baseCommit }` into `materialise`, which writes, inside the transaction right after the `AlreadyConducted` check:
```ts
    await tx.goalDelivery.create({
      data: { workspaceId, goalVersion: version, integrationBranch: delivery.integrationBranch, baseCommit: delivery.baseCommit },
    })
```
The wait (plan D6). In `conduct`, the `if (await boardIsBusy(...)) { await tripConductor(...); return 'waiting' }` block becomes:
```ts
  const waitingOn = await earlierGoalOpen(deps.workspaceId, version)
  if (waitingOn !== undefined) {
    await goalWaiting(deps.workspaceId, version, waitingOn)
    return 'waiting'
  }
```
and these two functions are added beside `boardIsBusy`:
```ts
/**
 * Plan D6: what goal version `version` waits for, or `undefined` when it may be conducted. An
 * earlier goal version that has not reached the base branch (and was not abandoned) comes first:
 * its number. Else a board left over from planned delivery (Plan 2 D5's `boardIsBusy`): `null`.
 */
async function earlierGoalOpen(workspaceId: string, version: number): Promise<number | null | undefined> {
  const open = await prisma.goalDelivery.findFirst({
    where: { workspaceId, goalVersion: { lt: version }, status: { not: 'abandoned' }, mergedAt: null },
    orderBy: { goalVersion: 'asc' },
    select: { goalVersion: true },
  })
  if (open !== null) return open.goalVersion
  return (await boardIsBusy(workspaceId, version)) ? null : undefined
}

/**
 * Says the wait once per (version, what it waits on) -- its own event, not the `conductor_failed`
 * guardrail it used to borrow (plan D6: the Home feed read that as "a task is blocked and needs
 * you"). Deduplicated against the log, so a daemon restart does not repeat it.
 */
async function goalWaiting(workspaceId: string, version: number, waitingOn: number | null): Promise<void> {
  // Filtered by `version` in SQL and compared on `waitingOn` here: a JSON-path `equals: null` does
  // not match a JSON null in Prisma, and the handful of rows per version costs nothing to read.
  const said = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'workspace_goal_waiting', payload: { path: ['version'], equals: version } },
    select: { payload: true },
  })
  if (said.some((row) => (row.payload as { readonly waitingOn?: unknown }).waitingOn === waitingOn)) return
  await appendEvent({ type: 'workspace.goal_waiting', workspaceId, actor: 'system', payload: { version, waitingOn } })
}
```
Keep `boardIsBusy` and its doc comment, adding one line: "Plan 4a: consulted after the goal-delivery rule, for a board left over from planned delivery." Remove the now-unused `tripConductor` call from the wait and update `boardIsBusy`'s caller comment.

- [ ] **Step 4: Run** `goal-branch.test.ts`, `conductor.test.ts`, `conductor-e2e.test.ts` (one at a time) + `npm run typecheck` → PASS. (The e2e still merges into `main`: Task 4 moves the merge; until then a package task of a version with a `GoalDelivery` still takes the old merge path, because Task 3's helper does not exist yet. Confirm the e2e is green here; it is re-asserted in Task 7.)

- [ ] **Step 5: Commit** — `feat(conductor): each goal version is cut its own integration branch, and waits for the one before it`.

---

### Task 3: Package work is cut from, audited against and reviewed against its integration branch

**Files:**
- Modify: `apps/orchestrator/src/goalBranch.ts` (`integrationTargetFor`, `baseRefFor`)
- Modify: `apps/orchestrator/src/tick.ts` (`startRun`: the `acquireWorktree` base)
- Modify: `apps/orchestrator/src/verify.ts` (`verifyConcludedRun`: the `auditOwnership` workspace argument)
- Modify: `apps/orchestrator/src/review.ts` (`dispatchReview`: `buildReviewDiff` base and `reviewDiff.base`)
- Test: `apps/orchestrator/test/integration/goal-branch.test.ts` (new describes), `apps/orchestrator/test/integration/ownership.test.ts` (one new case), `apps/orchestrator/test/integration/review.test.ts` (one new case)

**Interfaces:**
- Consumes: `GoalDelivery` (Task 1), `auditOwnership(run, task, { repoPath, baseBranch })` (Plan 3, unchanged signature — the base is passed in), `buildReviewDiff(repoPath, base, head)`.
- Produces:
  - `export interface IntegrationTarget { readonly deliveryId: string; readonly goalVersion: number; readonly branch: string }`
  - `export async function integrationTargetFor(taskId: string): Promise<IntegrationTarget | null>` — `null` for a task with no package, or whose goal version has no `GoalDelivery` (plan D5).
  - `export async function baseRefFor(taskId: string, baseBranch: string): Promise<string>` — the target's branch, else `baseBranch`.

- [ ] **Step 1: Failing tests**
  - `goal-branch.test.ts`, describe `integrationTargetFor`: a package task of a version with a delivery → `{ branch: integrationBranchName(1, ws) , goalVersion: 1 }`; a package task of a version without one → `null`; a task with no package → `null`; `baseRefFor` returns the branch / `'main'` accordingly.
  - `goal-branch.test.ts`, describe `a package task is cut from its integration branch`: seed a conducted workspace whose v1 `GoalDelivery` branch carries one extra commit (`dep.txt`, committed onto the integration branch with `git commit-tree`/`update-ref` or a scratch worktree), a `ready` package task pinned to a seat, the `m8-flow` fake with a report (copy `run-report.test.ts`'s deps); one tick → the run's worktree contains `dep.txt` (`existsSync(join(run.worktreePath, 'dep.txt'))`).
  - `ownership.test.ts`: the same shape — an integration branch that already carries another package's file `src/config.py` change (merged dependency work), and the `report` package run commits only `src/report/x.py` → the audit PASSES (before this task it failed, naming `src/config.py`, because the three-dot base was `main`).
  - `review.test.ts`: a package task whose integration branch carries `dep.txt` → the review run's `RunContext` manifest `review_diff` source has `base: <integration branch>`, and the diff text does not mention `dep.txt`.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** in `goalBranch.ts`:
```ts
export interface IntegrationTarget {
  readonly deliveryId: string
  readonly goalVersion: number
  readonly branch: string
}

/**
 * The branch a package task was cut from and merges back into (spec R9, plan D5): its goal
 * version's integration branch. `null` for a task with no package, and for a package whose version
 * was materialised before goal deliveries existed -- that one keeps the base-branch path it started on.
 * One answer for dispatch, the ownership audit, review and the merge pass, so none of them can
 * judge a task against a different base than another (plan D12).
 */
export async function integrationTargetFor(taskId: string): Promise<IntegrationTarget | null> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { workspaceId: true, workPackage: { select: { goalVersion: true } } },
  })
  if (task === null || task.workPackage === null) return null
  const delivery = await prisma.goalDelivery.findUnique({
    where: { workspaceId_goalVersion: { workspaceId: task.workspaceId, goalVersion: task.workPackage.goalVersion } },
    select: { id: true, goalVersion: true, integrationBranch: true },
  })
  return delivery === null ? null : { deliveryId: delivery.id, goalVersion: delivery.goalVersion, branch: delivery.integrationBranch }
}

export async function baseRefFor(taskId: string, baseBranch: string): Promise<string> {
  return (await integrationTargetFor(taskId))?.branch ?? baseBranch
}
```
Wire it:
- `tick.ts` `startRun`: `baseBranch: await baseRefFor(task.id, workspace.baseBranch),` in the `acquireWorktree` call (a rework adopts its tree and ignores it; a first provision cuts from it).
- `verify.ts`: `task.workspace` → `{ repoPath: task.workspace.repoPath, baseBranch: await baseRefFor(task.id, task.workspace.baseBranch) }` in the `auditOwnership` call. Extend the comment above it: "Plan 4a (D12): against the branch the task was cut from."
- `review.ts`: compute `const base = await baseRefFor(task.id, workspace.baseBranch)` inside the `try`, before `buildReviewDiff`, and use `base` in both `buildReviewDiff(workspace.repoPath, base, task.branch)` and `reviewDiff: { …, base, … }`.

- [ ] **Step 4: Run** `goal-branch.test.ts`, `ownership.test.ts`, `review.test.ts`, `tick.test.ts`, `run-report.test.ts` (one at a time) + `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(conductor): a package task is cut from, audited against and reviewed against its goal's integration branch`.

---

### Task 4: The merge pass merges a package into its integration branch, and a second failure blocks only that package

**Files:**
- Modify: `apps/orchestrator/src/goalBranch.ts` (`ensureIntegrationWorktree`)
- Modify: `apps/orchestrator/src/merge.ts` (`runMergePass`, `failMerge`)
- Modify: `packages/db/prisma/schema.prisma` (doc comment on `Task.integratedAt` only — no migration)
- Test: `apps/orchestrator/test/integration/merge.test.ts` (new describe `into the integration branch`)

**Interfaces:**
- Consumes: `integrationTargetFor` (Task 3), `integrationWorktreeKey` (Task 1), `worktreeRootFor` (`./worktree.js`).
- Produces:
  - `export async function ensureIntegrationWorktree(repoPath: string, target: IntegrationTarget, workspaceId: string): Promise<string>` — the path of the worktree checked out on `target.branch` (`join(worktreeRootFor(repoPath), integrationWorktreeKey(target.goalVersion, workspaceId))`), created with `git worktree add <path> <branch>` when missing (after `git worktree prune`), verified to be registered on that branch otherwise (the `adoptWorktree` porcelain check), with an interrupted merge aborted (`git merge --abort`, errors ignored).
  - `failMerge` input gains `readonly conducted: boolean`.

- [ ] **Step 1: Failing tests** (`merge.test.ts`; read its existing autoMerge/rebase setup first and reuse it; add a `GoalDelivery` + integration branch to the seed via Task 2's `ensureIntegrationBranch`):
  - A `merging` package task (approved) of a version with a delivery, workspace `autoMerge: false`: one `runMergePass` → task `done`, `integratedAt` set, the integration branch contains the task's commit (`git merge-base --is-ancestor <taskBranch> <integrationBranch>`), `main` does NOT, the primary checkout's HEAD and status are unchanged, and no `EvidenceRecord` integration verdict was settled (`integrated` column still null for the implementation run's fact).
  - Two package tasks merged one after another → both on the integration branch, merged with `--no-ff` (two merge commits: `git rev-list --merges <base>..<integrationBranch>` has 2 lines).
  - Conflict: the integration branch already changed `a.txt` one way and the task branch the other way → first pass: `task.merge_failed`, task `rework`, attempt 1, NO workspace halt; set the task back to `merging` with the same conflict and run again → task `blocked`, `lastRejectionReason` names the conflict, a `guardrail.tripped { guardrail: 'merge_failure' }` event WITH the task id whose detail names the goal version, `workspace.haltedReason` still null, `mergeClaimedAt` null.
  - The same second failure on a planned task (no package) still halts the workspace (today's behaviour, pinned).
  - An interrupted merge left in the integration worktree by a crash (before the pass, run `git merge --no-ff --no-commit <some other branch>` there so `MERGE_HEAD` exists) → the pass aborts it and merges the task.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement**

`goalBranch.ts`:
```ts
/**
 * The worktree the merge pass keeps checked out on a goal version's integration branch (plan D2):
 * package merges land here, never in the person's primary checkout. Outside the repository, beside
 * the task worktrees (`worktreeRootFor`). A merge a crash interrupted is aborted first -- nothing
 * else ever writes here, so an in-progress merge can only be this pass's own.
 */
export async function ensureIntegrationWorktree(repoPath: string, target: IntegrationTarget, workspaceId: string): Promise<string> {
  const path = join(worktreeRootFor(repoPath), integrationWorktreeKey(target.goalVersion, workspaceId))
  if (!existsSync(path)) {
    await gitIn(repoPath, 'worktree', 'prune')
    await gitIn(repoPath, 'worktree', 'add', path, target.branch)
    return path
  }
  const records = (await gitIn(repoPath, 'worktree', 'list', '--porcelain')).split('\n\n')
  const registered = records.find((record) => record.startsWith(`worktree ${path}\n`))
  if (registered === undefined || !registered.split('\n').includes(`branch refs/heads/${target.branch}`)) {
    throw new Error(`${path} is not a worktree of ${repoPath} on ${target.branch}`)
  }
  await gitIn(path, 'merge', '--abort').catch(() => {})
  return path
}
```
(`join`, `existsSync`, `worktreeRootFor` imported; `realpath` is not needed — git records the path as given.)

`merge.ts`:
1. After the claim, resolve `const target = await integrationTargetFor(task.id)` and `const into = target?.branch ?? workspace.baseBranch`.
2. The `!workspace.autoMerge` early return applies only when `target === null` (plan D3): wrap it in `if (target === null && !workspace.autoMerge) { … }`.
3. The rebase: `await gitIn(worktreePath, 'rebase', into)`; the conflict reason says `rebase onto ${into} conflicted: …`.
4. After the post-rebase verify passes, branch:
```ts
  if (target !== null) {
    // Plan 4a (spec R9, D2): into the goal version's integration branch, in the worktree kept on it.
    // The primary checkout is not read or touched: it is the person's, and the base branch changes
    // only when the goal version is accepted (spec §5).
    try {
      const integrationPath = await ensureIntegrationWorktree(workspace.repoPath, target, workspaceId)
      await gitIn(integrationPath, 'merge', '--no-ff', '--no-verify', branch, '-m', `merge(${taskKey}): ${task.title}`)
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
      await failMerge({
        taskId: task.id,
        workspaceId,
        taskKey,
        reason: `merge of ${branch} into ${target.branch} failed: ${message}`,
        judged: true,
        conducted: true,
      })
      return
    }
    // Plan D4: on a package task `integratedAt` means "on its goal's integration branch" -- what
    // the dependency gate needs. The integration EVIDENCE waits for the final merge (goal.ts).
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'done', mergeClaimedAt: null, lastRejectionReason: null, integratedAt: new Date() },
    })
    await appendEvent({ type: 'task.done', workspaceId, taskId: task.id, actor: 'system', payload: { branch } })
    return
  }
```
   Everything after (the primary-checkout guard, the base-branch merge, the evidence settle) is the unchanged `target === null` path. Every existing `failMerge` call passes `conducted: target !== null` (the rebase and verify failures of a package with a target are conducted too).
   The failed `ensureIntegrationWorktree`/merge must leave the integration worktree clean: in the `catch`, run `await gitIn(integrationPath, 'merge', '--abort').catch(() => {})` when the path was obtained (hoist `let integrationPath: string | null = null`).
5. `failMerge` (plan D7) — after appending `task.merge_failed` and counting:
```ts
  if (input.conducted) {
    if (failureCount > 1) {
      // Spec §5: a conducted workspace is not halted by one package that will not merge. The package
      // is escalated alone -- `blocked` is "a person must look at this" (`unblock-task` leaves it) --
      // and every other package keeps going.
      await prisma.task.updateMany({
        where: { id: input.taskId, status: 'merging' },
        data: { status: 'blocked', mergeClaimedAt: null, lastRejectionReason: input.reason },
      })
      await appendEvent({
        type: 'guardrail.tripped',
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        actor: 'system',
        payload: {
          guardrail: 'merge_failure' satisfies GuardrailKind,
          detail: `package task ${input.taskKey} failed to merge into its goal's integration branch twice; blocked for a person: ${input.reason}`,
        },
      })
      return
    }
  } else if (failureCount > 1) {
    // today's workspace halt, unchanged
  }
```
   (Restructure the existing `if (failureCount > 1) { halt … }` into the `else if` arm; the first conducted failure falls through to today's `rejectTask` + evidence + claim release exactly as before.)
6. `schema.prisma` `Task.integratedAt` doc: add "Conductor Plan 4a (D4): on a package task of a goal version with a `GoalDelivery`, when it was merged into that version's integration branch."

- [ ] **Step 4: Run** `merge.test.ts`, `goal-branch.test.ts`, `sweep.test.ts` (the stale-merge-claim sweep must still recover a claimed package task) one at a time + `npm run typecheck` → PASS. `conductor-e2e.test.ts` asserts the worker's file on `main`, which from this task on happens only at the goal pass: it is red between this task and Task 5, and Task 5 runs it.

- [ ] **Step 5: Commit** — `feat(merge): a package merges into its goal's integration branch; a second failure blocks the package, not the workspace`.

---

### Task 5: A goal version whose packages are all integrated is accepted and merged into the base branch once

**Files:**
- Create: `apps/orchestrator/src/goal.ts` (`runGoalPass`, `acceptGoal`, `mergeGoalIntoBase`)
- Create: `packages/control/src/goalDelivery.ts` (`settleGoalEvidence` — Task 6 adds the person's verbs to the same file); Modify: `packages/control/src/index.ts`
- Modify: `apps/orchestrator/src/tick.ts` (call `runGoalPass` after `runMergePass`, in the ordinary branch)
- Test: `apps/orchestrator/test/integration/goal-pass.test.ts` (new)

**Interfaces:**
- Consumes: `GoalDelivery` (Task 1), `integrationWorktreeKey` (Task 1), `settleTaskEvidence` (`@slave-of-ai/control`), `gitIn`, `worktreeRootFor`.
- Produces:
  - `export async function runGoalPass(workspaceId: WorkspaceId): Promise<void>` — for each `GoalDelivery` of the workspace with `status: 'integrating'`: accept it when every package task of its version is `done` with `integratedAt` set (plan D8; Plan 4b replaces this with dispatching a verification); for each `accepted` one with `mergedAt: null` and `mergeError: null`: `mergeGoalIntoBase` when the workspace has `autoMerge`.
  - `export async function acceptGoal(deliveryId: string, rounds: number): Promise<boolean>` — `integrating`/(4b: `verifying`) → `accepted`, guarded, writes `workspace.goal_accepted`; returns whether it applied.
  - `export async function mergeGoalIntoBase(deliveryId: string, by: 'system'): Promise<'merged' | 'waiting' | 'failed'>`.
  - `export async function settleGoalEvidence(workspaceId: string, goalVersion: number): Promise<void>` (in `@slave-of-ai/control`, so the person's `confirm-goal-merge` can call it too) — `settleTaskEvidence(taskId, { kind: 'integration', integrated: true })` for every package task of the version with `integratedAt` set (plan D4).
  - `runGoalPass` also removes the integration worktree of any MERGED delivery still on disk (a hand merge confirmed from the CLI leaves it; `packages/control` does not know `worktreeRootFor`).

- [ ] **Step 1: Failing tests** (`goal-pass.test.ts`; seed a conducted workspace, a v1 delivery via `ensureIntegrationBranch`, two package tasks; drive states directly with Prisma and real git in the temp repo):
  - One package `done`+integrated, the other `reviewing` → pass does nothing (delivery `integrating`, no event).
  - Both `done`+integrated, `autoMerge: true`, the integration branch carrying a commit → delivery `accepted` then (same pass) `mergedAt` set; `main` contains the commit via a merge commit whose subject starts `merge(goal-v1)`; events `workspace.goal_accepted { version: 1, rounds: 0 }` then `workspace.goal_merged { by: 'system', into: 'main', commit: <main's new tip> }`; the integration worktree directory is removed, the branch kept; both package tasks' implementation facts have `integrated: true` (read `EvidenceRecord` for their runs — copy the read from `merge.test.ts`'s evidence case).
  - `autoMerge: false` → `accepted`, `mergedAt` null, no `goal_merged`, `main` unchanged; a second pass changes nothing.
  - Primary checkout dirty (an untracked file) → `accepted`, not merged, ONE `guardrail.tripped merge_failure` whose detail names goal v1 and "clean"; a second pass writes no second trip; remove the file → the next pass merges.
  - Primary checkout on another branch → same as dirty.
  - Conflict (commit a conflicting change to `a.txt` on `main` after the cut) → `mergeError` set, `git status --porcelain` in the repo is empty, `git rev-parse HEAD` unchanged, one trip; a further pass does not retry (no second `git merge` — assert `main` unchanged and no second trip).
  - Replay safety: `acceptGoal` called twice → one `workspace.goal_accepted`.
  - A delivery already `mergedAt` (a confirmed hand merge) whose integration worktree is still on disk → the pass removes the worktree and keeps the branch.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** `apps/orchestrator/src/goal.ts`:
```ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { settleGoalEvidence } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { integrationWorktreeKey, type GuardrailKind, type WorkspaceId } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { gitIn, worktreeRootFor } from './worktree.js'

/**
 * The goal pass (Conductor Plan 4a, spec R9): once per ordinary tick, after the merge pass. Moves
 * each open goal version of the workspace on -- accepted when its gate holds, merged into the base
 * branch once when accepted. Plan 4b puts the verification run between "every package integrated"
 * and "accepted".
 */
export async function runGoalPass(workspaceId: WorkspaceId): Promise<void> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { autoMerge: true, repoPath: true } })
  // A hand merge confirmed from the CLI leaves the integration worktree behind (`packages/control`
  // does not know where worktrees live); it is spent once the branch is in the base branch.
  const merged = await prisma.goalDelivery.findMany({ where: { workspaceId, mergedAt: { not: null } }, select: { goalVersion: true } })
  for (const delivery of merged) await removeIntegrationWorktree(workspace.repoPath, delivery.goalVersion, workspaceId)

  const open = await prisma.goalDelivery.findMany({
    where: { workspaceId, OR: [{ status: 'integrating' }, { status: 'accepted', mergedAt: null, mergeError: null }] },
    orderBy: { goalVersion: 'asc' },
  })
  for (const delivery of open) {
    if (delivery.status === 'integrating') {
      if (!(await everyPackageIntegrated(workspaceId, delivery.goalVersion))) continue
      // Plan D8: until Plan 4b the per-task verify and review are the gate.
      if (!(await acceptGoal(delivery.id, 0))) continue
    }
    if (workspace.autoMerge) await mergeGoalIntoBase(delivery.id, 'system')
  }
}

/** Every package task of the version is `done` and on the integration branch -- and there is at
 *  least one (a version whose tasks were all cancelled is not "delivered"; it is abandoned). */
async function everyPackageIntegrated(workspaceId: string, goalVersion: number): Promise<boolean> {
  const tasks = await prisma.task.findMany({
    where: { workspaceId, workPackage: { goalVersion } },
    select: { status: true, integratedAt: true },
  })
  return tasks.length > 0 && tasks.every((task) => task.status === 'done' && task.integratedAt !== null)
}

/** Guarded on the status it leaves, so a replay (or two ticks) writes one `goal_accepted`. */
export async function acceptGoal(deliveryId: string, rounds: number): Promise<boolean> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({ where: { id: deliveryId } })
  const moved = await prisma.goalDelivery.updateMany({
    where: { id: deliveryId, status: 'integrating' },
    data: { status: 'accepted', acceptedAt: new Date() },
  })
  if (moved.count === 0) return false
  await appendEvent({
    type: 'workspace.goal_accepted',
    workspaceId: delivery.workspaceId,
    actor: 'system',
    payload: { version: delivery.goalVersion, rounds },
  })
  return true
}

/**
 * The one merge of a goal version into the base branch (spec R9, plan D9), in the primary checkout.
 * A checkout that is dirty or on another branch is the person working there: `waiting`, said once,
 * tried again next tick. A merge git refuses is aborted, recorded on `mergeError` and left for the
 * person (`confirm-goal-merge` after merging by hand); nothing retries it.
 */
export async function mergeGoalIntoBase(deliveryId: string, by: 'system'): Promise<'merged' | 'waiting' | 'failed'> {
  const delivery = await prisma.goalDelivery.findUniqueOrThrow({
    where: { id: deliveryId },
    include: { workspace: { select: { repoPath: true, baseBranch: true, goal: true } } },
  })
  const { repoPath, baseBranch } = delivery.workspace
  const version = delivery.goalVersion
  const current = await gitIn(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD')
  const status = await gitIn(repoPath, 'status', '--porcelain')
  if (current !== baseBranch || status !== '') {
    await tripOnce(
      delivery.workspaceId,
      `goal v${String(version)} is accepted and waits for a clean checkout of ${baseBranch} to be merged into it`,
    )
    return 'waiting'
  }
  const subject = `merge(goal-v${String(version)}): ${(delivery.workspace.goal ?? '').split('\n')[0]?.slice(0, 60) ?? ''}`
  try {
    await gitIn(repoPath, 'merge', '--no-ff', '--no-verify', delivery.integrationBranch, '-m', subject)
  } catch (error) {
    await gitIn(repoPath, 'merge', '--abort').catch(() => {})
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000)
    await prisma.goalDelivery.updateMany({ where: { id: deliveryId, mergedAt: null }, data: { mergeError: message } })
    await tripOnce(
      delivery.workspaceId,
      `goal v${String(version)} could not be merged into ${baseBranch}: ${message.split('\n')[0] ?? ''}. ` +
        `Merge ${delivery.integrationBranch} by hand, then run confirm-goal-merge --workspace ${delivery.workspaceId} --version ${String(version)}`,
    )
    return 'failed'
  }
  const commit = await gitIn(repoPath, 'rev-parse', 'HEAD')
  const stamped = await prisma.goalDelivery.updateMany({ where: { id: deliveryId, mergedAt: null }, data: { mergedAt: new Date() } })
  if (stamped.count === 0) return 'merged'
  await appendEvent({
    type: 'workspace.goal_merged',
    workspaceId: delivery.workspaceId,
    actor: 'system',
    payload: { version, branch: delivery.integrationBranch, into: baseBranch, commit, by },
  })
  await settleGoalEvidence(delivery.workspaceId, version)
  await removeIntegrationWorktree(repoPath, version, delivery.workspaceId)
  return 'merged'
}

/** The branch stays (it is the goal version's record); the worktree on it is spent. */
async function removeIntegrationWorktree(repoPath: string, version: number, workspaceId: string): Promise<void> {
  const path = join(worktreeRootFor(repoPath), integrationWorktreeKey(version, workspaceId))
  if (!existsSync(path)) return
  await gitIn(repoPath, 'worktree', 'remove', '--force', path).catch((error: unknown) => {
    console.warn(`[goal] could not remove ${path}: ${String(error)}`)
  })
}

/** A `merge_failure` trip, workspace-scoped, said once per detail (the conductor's dedup rule). */
async function tripOnce(workspaceId: string, detail: string): Promise<void> {
  const said = await prisma.executionEvent.findFirst({
    where: { workspaceId, type: 'guardrail_tripped', payload: { path: ['detail'], equals: detail } },
    select: { seq: true },
  })
  if (said !== null) return
  await appendEvent({
    type: 'guardrail.tripped',
    workspaceId,
    actor: 'system',
    payload: { guardrail: 'merge_failure' satisfies GuardrailKind, detail },
  })
}
```
`packages/control/src/goalDelivery.ts` (new; exported from `index.ts`):
```ts
import { prisma } from '@slave-of-ai/db/client'
import { settleTaskEvidence } from './evidence.js'

/**
 * Plan 4a D4: the integration verdict of every package task of a goal version, settled when the
 * version's branch reaches the base branch -- by the goal pass, or by a person's confirmed hand
 * merge. "Integrated" in the ranker means "reached the base branch", which a package merged into
 * its integration branch has not yet done.
 */
export async function settleGoalEvidence(workspaceId: string, goalVersion: number): Promise<void> {
  const tasks = await prisma.task.findMany({
    where: { workspaceId, workPackage: { goalVersion }, integratedAt: { not: null } },
    select: { id: true },
  })
  for (const task of tasks) await settleTaskEvidence(task.id, { kind: 'integration', integrated: true })
}
```
(Check where `settleTaskEvidence` is defined — `grep -n "export async function settleTaskEvidence" packages/control/src` — and import it from that module.) In `tick.ts`, after `await runMergePass(deps.workspaceId)`:
```ts
  // Conductor Plan 4a: after the merge pass, which is what integrates the last package of a goal
  // version. Wrapped like the Supervisor pass: a goal pass that throws must not stop scheduling.
  await runGoalPass(deps.workspaceId).catch((error: unknown) => {
    console.error(`[tick] the goal pass for workspace ${deps.workspaceId} failed:`, error)
  })
```

- [ ] **Step 4: Run** `goal-pass.test.ts`, `tick.test.ts`, `merge.test.ts`, `conductor-e2e.test.ts` (one at a time; the e2e is green again) + `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(conductor): a goal version whose packages are integrated is accepted and merged into the base branch once`.

---

### Task 6: The person's verbs -- see, abandon, confirm a hand merge

**Files:**
- Modify: `packages/control/src/goalDelivery.ts` (Task 5 created it)
- Modify: `packages/control/src/refusal.ts` (five refusals + `refusalText` arms)
- Modify: `apps/orchestrator/src/cli.ts` (help text + three `case`s)
- Test: `packages/control/test/integration/goal-delivery.test.ts` (new), `apps/orchestrator/test/integration/cli.test.ts` (one case per verb)

**Interfaces:**
- Consumes: `cancelTask(taskId, reason, origin, principal?)` (`packages/control/src/task.ts:107`), `gitIn` (`packages/control/src/git.ts`), the four events (Task 1).
- Produces:
  - `export interface GoalDeliveryView { readonly goalVersion: number; readonly status: 'integrating' | 'accepted' | 'abandoned'; readonly integrationBranch: string; readonly baseCommit: string; readonly acceptedAt: string | null; readonly mergedAt: string | null; readonly mergeError: string | null; readonly packages: readonly { readonly taskId: string; readonly key: string; readonly status: string; readonly integrated: boolean }[] }` (Plan 4b widens `status`).
  - `export async function goalDeliveries(workspaceId: string, goalVersion?: number): Promise<Result<readonly GoalDeliveryView[], ControlRefusal>>`
  - `export async function abandonGoal(workspaceId: string, goalVersion: number, principal?: Principal): Promise<Result<{ readonly cancelled: readonly string[] }, ControlRefusal>>`
  - `export async function confirmGoalMerge(workspaceId: string, goalVersion: number, principal?: Principal): Promise<Result<{ readonly commit: string }, ControlRefusal>>`
  - Refusals: `{ kind: 'goal_version_not_found'; workspaceId; goalVersion }`, `{ kind: 'goal_version_closed'; goalVersion; status: string }` (already merged or abandoned), `{ kind: 'goal_version_busy'; goalVersion; holder: string }` (`holder` says what is in flight, e.g. `task <id>`; a package task holds a run or a merge claim), `{ kind: 'goal_not_merged'; goalVersion; branch: string; into: string }` (confirm when the branch is not in the base branch), `{ kind: 'goal_not_accepted'; goalVersion; status: string }`.
  - CLI: `goal-status --workspace <id> [--version <n>]`, `abandon-goal --workspace <id> --version <n>`, `confirm-goal-merge --workspace <id> --version <n>`.

- [ ] **Step 1: Failing tests** (`goal-delivery.test.ts`, temp repo + seeded deliveries):
  - `goalDeliveries` lists versions ascending with their packages; `--version` filters; unknown workspace → `workspace_not_found`.
  - `abandonGoal` on an `integrating` v1 with tasks `ready`, `rework`, `done`: the two unfinished ones are `cancelled` (via `cancelTask` — a `task.cancelled` event each), the `done` one untouched, delivery `abandoned`, one `workspace.goal_abandoned { cancelled: [those two ids] }`; a task with `activeRunId` set → `goal_version_busy` and NOTHING changed (no task cancelled, status still `integrating`); an already-`abandoned` or merged version → `goal_version_closed`.
  - `confirmGoalMerge` on `accepted`+unmerged after merging the branch into `main` by hand in the test → `mergedAt` set, `mergeError` cleared, `workspace.goal_merged { by: 'human', commit: <main tip> }`, package evidence settled (`settleGoalEvidence`, Task 5); branch NOT an ancestor of `main` → `goal_not_merged`; an `integrating` version → `goal_not_accepted`; an already merged one → `goal_version_closed`.
  - `cli.test.ts`: each verb prints JSON and exits 0; a refusal exits non-zero with the refusal text.

- [ ] **Step 2: Run to see them fail.**

- [ ] **Step 3: Implement** `packages/control/src/goalDelivery.ts` (WHY doc on each function):
```ts
export async function abandonGoal(
  workspaceId: string,
  goalVersion: number,
  principal?: Principal,
): Promise<Result<{ readonly cancelled: readonly string[] }, ControlRefusal>> {
  const delivery = await prisma.goalDelivery.findUnique({ where: { workspaceId_goalVersion: { workspaceId, goalVersion } } })
  if (delivery === null) return err({ kind: 'goal_version_not_found', workspaceId, goalVersion })
  if (delivery.status === 'abandoned' || delivery.mergedAt !== null) {
    return err({ kind: 'goal_version_closed', goalVersion, status: delivery.mergedAt !== null ? 'merged' : delivery.status })
  }
  const tasks = await prisma.task.findMany({
    where: { workspaceId, workPackage: { goalVersion } },
    select: { id: true, status: true, activeRunId: true, mergeClaimedAt: true },
  })
  // Plan D10: stop first. A run or a merge in flight would finish into a version nobody wants, and
  // cancelling half the tasks before refusing on the busy one would leave the version in neither state.
  const busy = tasks.find((task) => task.activeRunId !== null || task.mergeClaimedAt !== null)
  if (busy !== undefined) return err({ kind: 'goal_version_busy', goalVersion, holder: `task ${busy.id}` })
  const cancelled: string[] = []
  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') continue
    const result = await cancelTask(task.id, `goal v${String(goalVersion)} abandoned`, 'human', principal)
    if (!result.ok) return result
    cancelled.push(task.id)
  }
  const moved = await prisma.goalDelivery.updateMany({
    where: { id: delivery.id, status: { not: 'abandoned' }, mergedAt: null },
    data: { status: 'abandoned' },
  })
  if (moved.count === 1) {
    await appendEvent({
      type: 'workspace.goal_abandoned',
      workspaceId,
      actor: 'human',
      payload: { version: goalVersion, cancelled: cancelled.slice(0, 50) },
      userId: principal?.userId ?? null,
    })
  }
  return ok({ cancelled })
}
```
(Check `appendEvent`'s envelope for `userId` against another human-actor event in control, e.g. `cancelTask`, and match it.) `confirmGoalMerge`:
```ts
export async function confirmGoalMerge(
  workspaceId: string,
  goalVersion: number,
  principal?: Principal,
): Promise<Result<{ readonly commit: string }, ControlRefusal>> {
  const delivery = await prisma.goalDelivery.findUnique({
    where: { workspaceId_goalVersion: { workspaceId, goalVersion } },
    include: { workspace: { select: { repoPath: true, baseBranch: true } } },
  })
  if (delivery === null) return err({ kind: 'goal_version_not_found', workspaceId, goalVersion })
  if (delivery.mergedAt !== null || delivery.status === 'abandoned') {
    return err({ kind: 'goal_version_closed', goalVersion, status: delivery.mergedAt !== null ? 'merged' : delivery.status })
  }
  if (delivery.status !== 'accepted') return err({ kind: 'goal_not_accepted', goalVersion, status: delivery.status })
  const { repoPath, baseBranch } = delivery.workspace
  // The person's word is checked against git: confirming a merge that did not happen would let the
  // next goal version be cut from a base branch without this one's work (plan D6).
  const merged = await gitIn(repoPath, 'merge-base', '--is-ancestor', delivery.integrationBranch, baseBranch).then(
    () => true,
    () => false,
  )
  if (!merged) return err({ kind: 'goal_not_merged', goalVersion, branch: delivery.integrationBranch, into: baseBranch })
  const commit = await gitIn(repoPath, 'rev-parse', baseBranch)
  const stamped = await prisma.goalDelivery.updateMany({
    where: { id: delivery.id, mergedAt: null },
    data: { mergedAt: new Date(), mergeError: null },
  })
  if (stamped.count === 1) {
    await appendEvent({
      type: 'workspace.goal_merged',
      workspaceId,
      actor: 'human',
      payload: { version: goalVersion, branch: delivery.integrationBranch, into: baseBranch, commit, by: 'human' },
      userId: principal?.userId ?? null,
    })
    await settleGoalEvidence(workspaceId, goalVersion)
  }
  return ok({ commit })
}
```
The integration worktree is left for the goal pass to remove (Task 5). `goalDeliveries` reads the rows ascending (filtered by `goalVersion` when given) with, per row, the package tasks `{ taskId, key: workPackage.key, status, integrated: integratedAt !== null }`; `workspace_not_found` when the workspace is missing. `refusalText` arms, one sentence each: `goal_version_not_found` "workspace X has no conducted goal v N"; `goal_version_closed` "goal vN is already {status}"; `goal_version_busy` "goal vN still has work in flight ({holder}); stop it before abandoning the version"; `goal_not_accepted` "goal vN is {status}, not accepted; there is nothing to confirm yet"; `goal_not_merged` "{branch} is not merged into {into}; merge it by hand first".
CLI: copy `set-delivery`/`conductor`'s shape (`resolveWorkspace`, `requireFlag`, the `--version` integer check), print `JSON.stringify(result.value, null, 2)` for `goal-status` and one-line JSON for the other two; help text entries in the `set-delivery` block's style.

- [ ] **Step 4: Run** `goal-delivery.test.ts`, `cli.test.ts`, `goal-pass.test.ts` (one at a time) + `npm run typecheck` → PASS.

- [ ] **Step 5: Commit** — `feat(cli): see a goal version's delivery, abandon it, confirm a hand merge`.

---

### Task 7: End to end, and the whole suite

**Files:**
- Modify: `apps/orchestrator/test/integration/conductor-e2e.test.ts`

- [ ] **Step 1: Extend the e2e** (the existing single-package test): after the package task is `done`, also assert — a `GoalDelivery` v1 exists with `status: 'accepted'`, `mergedAt` set; `m8a-work.txt` is on `main` AND on the integration branch; the package's implementation run's worktree was cut from the integration branch (its first parent chain contains `baseCommit`); events include `workspace.goal_accepted` before `workspace.goal_merged`; `tickUntil`'s condition becomes "delivery merged". Add a second test: after v1 merges, `setGoal` a second text → v2 is conducted, cut from `main`'s new tip (v2's `baseCommit` = the v1 merge commit), and reaches `merged`. Add a third: `autoMerge: false` → v1 `accepted`, not merged; `setGoal` v2 → `workspace.goal_waiting { version: 2, waitingOn: 1 }` and no v2 `WorkPackage`; merge by hand in the test + `confirmGoalMerge` → the next ticks conduct v2.

- [ ] **Step 2: Run** `npx vitest run apps/orchestrator/test/integration/conductor-e2e.test.ts` → PASS.

- [ ] **Step 3: Commit** — `test(conductor): a conducted goal reaches the base branch through its integration branch, and the next goal waits for it`.

- [ ] **Step 4: Whole suite.** Stop any daemon; no `next dev`. `npm run typecheck`, then `npx vitest run > /tmp/claude-1001/4a-suite.log 2>&1` in the background (~15 min); wait on the log's summary line, not on `pgrep`. Re-run any failing file alone before believing it (`daemon-cli` flakes under load).

- [ ] **Step 5:** `npm run web:build && rm -rf apps/web/.next`; `node scripts/gate-m26-vocabulary.mjs`.

- [ ] **Step 6: Gates.** `DATABASE_URL="$GATE_DATABASE_URL" npm run db:migrate`; then the CI gate list with the fake-CLI env exactly as ci.yml sets it and `DATABASE_URL="$GATE_DATABASE_URL"`, under `systemd-inhibit --what=sleep:idle`; `CHROMIUM_PATH` pointed at the installed chromium (`ls ~/.cache/ms-playwright`). Known red on main: m44 m46 m47 m48 m49 m50 m52 m54 m55 m57 m58. m56a must be green (Task 1 moved its lane count). Any other red gate is compared against the same gate on main (`/home/meren/projects/slave-of-ai`) before it is called pre-existing.

---

## Self-review notes (for the executor)

- Spec coverage: R9 "integration branch cut from the base branch" → Tasks 1–2; "package tasks merge into it with today's merge pass" → Task 4; "merged into the base branch once, `autoMerge` deciding" → Task 5; "no task of a later goal version is dispatched until the current one is accepted or the person moves on" → Task 2 (wait) + Task 6 (`abandon-goal`); §5 merge failure → Task 4; §5 "base branch changes only when a goal version is accepted" → Tasks 4–5; Plan 3 carry-over (audit base) → Task 3; shared-file remedy → D11 (deferred); Plan 2 deferred "waiting trip reuses conductor_failed" → Task 2.
- Not here (Plan 4b): the verification run, `VerificationResult`, the gate and loop, `verification_failed`/`goal_needs_human`, the verifier seat, `conducted` as the default.
- Order: 1 → 2 → 3 → 4 → 5 → 6 → 7. Task 4 needs Task 3's helper; Task 6 moves `settleGoalEvidence` into control (Task 5 then imports it from there).
