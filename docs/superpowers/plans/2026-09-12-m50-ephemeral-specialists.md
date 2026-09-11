# M50 Ephemeral Specialists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worker has a lifecycle — PERMANENT, PROJECT or EPHEMERAL — written at the creation site and never derived; the Supervisor brings a specialist in for exactly one assignment when a capability gap belongs to a single task, and when that assignment is over it releases them: runtime roles emptied so nothing dispatches them again, worktrees collected, and every run, context, event, message and memory they produced left exactly where it is.

**Architecture:** One Prisma enum and five columns on `Slave` (`lifecycle`, `engagementTaskId`, `releasedAt`, `releaseReason`, `createdAt`), two pure domain modules under `packages/domain/src/lifecycle/` (`types`, `release`), and one control file (`packages/control/src/lifecycle.ts`) holding the two verbs that write a lifecycle. The one-assignment rule is a PURE function of `formTeam`'s inputs (`requiredBy`, a map the same `isStaffableTask` filter builds); release is a routine Supervisor action carried out by a control verb that never deletes anything and never throws out of a tick. Nothing promotes a worker automatically; a person may, through one verb and one CLI flag.

**Tech Stack:** TypeScript monorepo, Next.js 15 App Router + React 19, Tailwind v4 (configured by `@theme inline` inside `apps/web/src/app/globals.css` — there is no `tailwind.config.*`), zod, vitest (two projects: `unit`, `integration`), Prisma 7 + Postgres (:5433), plain-`node` `.mjs` gates driving `playwright-core`.

**Spec:** `docs/superpowers/specs/2026-09-12-m50-ephemeral-specialists-design.md` (rulings R1–R7; §4 errata). Its parents are `docs/superpowers/specs/2026-09-10-roadmap-m44-m56.md` (row M50), `docs/ia.md`, `docs/superpowers/specs/2026-09-11-m47-team-formation-design.md` (`formTeam`, the capability situation, the three sources), `docs/superpowers/specs/2026-09-09-m38-supervisor-design.md` (situations → candidates → tiers → decide → apply) and `docs/superpowers/specs/2026-09-11-m49-memory-provenance-design.md` (the evidence a released worker keeps). **M52 owns permissions and M53 evidence-based ranking — neither is pre-built here: nothing in this plan reads a permission, and nothing ranks a specialist.**

Plan-time errata, every one read out of the code and baked into the tasks below. The long form, with file and line evidence, is in the session notes (`m50-plan-notes.md`); each is also to be appended to the spec's §4 during execution.

- **E1 (amends R2) — `actionOf` cannot see `requiredBy`, so the PROPOSAL carries the engagement.** `actionOf(proposal, capability, world)` (`packages/domain/src/supervisor/candidates.ts:128`) receives a `TeamProposal` and a world; `requiredBy` is an INPUT to `formTeam` and reachable from neither. `TeamProposal` gains `engagementTaskId: string | null`, null on all three existing arms (`packages/domain/src/capability/team.ts:126,150,171`).
- **E2 (amends R2) — "the capability it covers" is a SET.** A catalog pick covers a LIST (`TeamProposal.covers`, `team.ts:47-49`; the set-cover loop emits one proposal per pick, `:157-176`). The rule is over the UNION of task ids across `covers`: exactly one distinct id makes it temporary and is the `engagementTaskId`; zero or two-or-more keeps it `project_worker`.
- **E3 (amends R2) — `requiredBy` is computed in `teamPlanOf` and nowhere else.** That function is the only production caller of `formTeam` and already derives `required` from `world.tasks.filter(isStaffableTask)` (`candidates.ts:99`). Building the map in the same pass is what makes "the same predicate" literal. Nothing in `supervisorWorld.ts` and nothing in `apps/orchestrator` computes it.
- **E4 (amends R3) — the world cannot answer the predicate yet.** `SupervisorSlave` (`packages/domain/src/supervisor/world.ts:79-96`) has no `engagementTaskId` and `SupervisorTask` (`:17-77`) no `assigneeId`. `SupervisorSlave` gains `lifecycle`, `released` AND `engagementTaskId`; `SupervisorTask` gains `assigneeId: string | null`; the loader's two reads (`packages/control/src/supervisorWorld.ts:203-225`, `:579-594`) grow one line each; `packages/domain/test/supervisor/fixtures.ts` defaults all four.
- **E5 (amends R3) — there is no `WorktreeCollectReason` type.** The union is spelled inline in three places: `packages/control/src/collect.ts:54`, `packages/domain/src/events/schema.ts:378`, `apps/web/src/components/activity/cards.tsx:151`. `'released'` joins all three; no exported type is introduced.
- **E6 (amends R3) — the collection's actor would lie.** `collectTaskWorktree` stamps `actor: reason === 'aged' ? 'system' : 'human'` (`collect.ts:102`), and `release_worker` is `applied` — carried out by a tick with no person in it. The line becomes `reason === 'operator' ? 'human' : 'system'`.
- **E7 (amends R6) — `SlaveCard` does not read `ProjectBrief.team[]`.** It takes `SlaveCardData` from `apps/web/src/server/overview.ts:33`; `team[]` is rendered by the brief's team tile (`apps/web/src/components/project/ProjectBrief.tsx:265-311`, chip `team-company` at `:279`). Both carriers gain the fields.
- **E8 (amends R6) — the routes are `slaves/[slaveId]/…`.** The siblings are `apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/{profile,runtime-roles}/route.ts` and their shell is `slaveControlResponse` (`apps/web/src/server/slaveControlRoute.ts:18`). A `workers/` segment would be a third spelling of one row in one URL space.
- **E9 (amends R6) — `whyHere` reads the `kind` R6 deletes** (`apps/web/src/server/organization.ts:189-197`). Its company branch keys on `companyName !== null` alone afterwards: `companySlaveId` is `SetNull` (`schema.prisma:249`), so a permanent worker can have a lifecycle and no company name.
- **E10 (amends R2) — the M47 pin is rewritten, not deleted.** `packages/domain/test/capability/team.test.ts:124-132` ("never emits the temporary source in this milestone") becomes a shared-gap case, and a new case asserts the emission. The `input()` helper (`:11-18`) gains `requiredBy: new Map()`, which keeps every other case meaning what it meant.
- **E11 (amends R4) — `org.changed.field` is spelled four times.** `packages/domain/src/events/schema.ts:399`, `apps/web/src/components/activity/cards.tsx:671` (the label map's key type), `:674-682` (the labels) and `:688` (the card's inline cast). All four move in Task 1 — `typecheck` is red without the `cards.tsx` two.
- **E12 (amends R7) — the re-raise needs a new task and an aged cooldown.** The engagement task is `done`, so `isStaffableTask` is false and the gap is gone; and `filterFresh` blocks the key for `COOLDOWN_MS` = 15 minutes (`packages/domain/src/supervisor/observe.ts:148-157`, `constants.ts:20`). The gate inserts a fresh `ready` task for the key and back-dates the earlier decision by an hour with one `updateMany`.
- **E13 (amends R2) — a reuse never rewrites a lifecycle.** The reuse branch (`packages/control/src/capability.ts:428-467`) matches on `hiredFromTemplateId` alone, so a temporary hire can land on a `project` worker — and R4 is absolute. The `findFirst` gains `releasedAt: null`; the branch writes `capabilities`/`runtimeRoles` only, leaving `lifecycle` and `engagementTaskId` as the hire that CREATED the worker set them.

## Global Constraints

- **Never a real model call.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and the fake CLI `packages/providers/test/fake-claude.mjs`; the browser gates need `SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh"`. **Nothing in this milestone calls a model: a lifecycle is a column and a release is a rule.**
- One vitest process at a time (the shared test database truncates), and **never a gate beside vitest**.
- **`npm run web:build` never while `next dev` is running.** `next dev` is DOWN on this machine while M49 merges and may be up again afterwards. Before any `web:build`, run `pgrep -af "next dev"`; if one is up, `kill <pid>` it and **say so in the task report**. Restarting dev afterwards needs `rm -rf apps/web/.next` first.
- **No prettier.** There is no prettier config in this repository; match the surrounding file's style by hand.
- Inside `apps/web`, import siblings **without** a `.js` suffix (`../server/organization`, not `../server/organization.js`); `packages/*` keep the `.js` suffix.
- Read an exit code with `${PIPESTATUS[0]}`; never `cmd | tail; echo $?` — that reports `tail`'s status.
- After `npm run db:generate`, run `npx tsc --build` **before** any integration test: the generated client's types are what the test files compile against.
- The vocabulary word is **slave**, fixtures included. `npm run gate:m26-vocabulary` after every task.
- Refusals are `ok()` / `err()`; **a refusal after a write inside `$transaction` must throw**, or Prisma commits that write. Every refusal in this milestone is returned BEFORE the first write in its transaction, so all of them are values.
- **A refusal kind reaches three homes:** the union + `refusalText` (`packages/control/src/refusal.ts`), the CLI (`throw new Error(refusalText(result.error))`), and the web (`apps/web/test/refusal-status.test.ts`'s `ALL_KINDS` record, which is `Record<ControlRefusal['kind'], true>` and fails the build when a kind is missing).
- **`decide()` is unchanged.** `packages/domain/src/scheduler/decide.ts` keeps one matching rule and `packages/domain/test/scheduler/decide.test.ts` keeps every assertion it has. A released worker is undispatchable because its `runtimeRoles` is empty — ONE rule, not a second filter. `loadSlaveRows` (`apps/orchestrator/src/world.ts:117-128`) gains NOTHING.
- **The M38, M47, M48 and M49 gates are unchanged.** None of them plans a task whose capability is needed by exactly one staffable task AND whose gap the catalog fills… except `gate:m47-team-formation`, whose `security.application` gap IS one task's — so Task 1 Step 6 checks that gate's own expectation explicitly and Task 5 re-runs it. `catalog-m47` and `plan-graph-capabilities.ndjson` are never edited.
- **Migrations are additive and applied to both databases** (`npm run db:migrate` and `npm run db:migrate:test`) with the Prisma 7 diff proof: `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` → "No difference detected". The migration directory for this milestone is **`packages/db/prisma/migrations/20260912120000_m50_lifecycle`**. It carries exactly ONE data statement, `UPDATE "Slave" SET "lifecycle" = 'permanent' WHERE "companySlaveId" IS NOT NULL`, which is idempotent by construction: a constant written over a predicate the statement does not itself change.
- **Determinism everywhere.** Sorted keys, stable tie-breaks, `requiredBy` built in one pass over an already-filtered array, `soleTaskFor` reading a `Set` whose size is the whole decision. The same world must produce the same plan, the same proposals and the same `engagementTaskId`, whatever order a query returned rows in.
- **`releaseWorker` never throws out of the Supervisor's apply path.** Every `collectTaskWorktree` call is in its own `try`, a refusal is logged and skipped, and `worktreesCollected` counts successes only.
- **Labels never keys.** `docs/ia.md` rule 3: no surface prints `ephemeral` as its visible text — `SLAVE_LIFECYCLE_LABEL` supplies the word and the raw value stays in `title`/a `data-` attribute.
- **Test baseline: ≥ 312 test files / ≥ 4858 tests** (the whole suite at `f7213ce`, `.superpowers/sdd/2026-09-11-m49-memory/task-1-report.md:212`; M49's later tasks only added to it). Every task's ladder ends at or above that, never below.
- **24 CI gates become 25.** M49's `gate:m49-memory` is the 24th; the new `gate:m50-ephemeral` step goes immediately after it in `.github/workflows/ci.yml`, and README's roster sentence says 25.
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
  ```
- Every task ends with focused tests, `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck` and a commit. Web tasks also run `npm run web:build` (subject to the `next dev` rule above) and `npm run gate:m44-ux-foundation` as the browser check.
- Anything touching the database goes under `test/integration/` and is named `*.test.ts` — `vitest.config.ts`'s `integration` project includes `**/test/integration/**/*.test.ts` only (no `.tsx`), and only that project loads `test-setup/require-database.ts`. Component tests are `*.test.tsx` under `apps/web/test/` with a `// @vitest-environment jsdom` first line.
- **The implementer never dispatches subagents.**

---

## File structure

```
packages/domain/src/lifecycle/types.ts       R1: SLAVE_LIFECYCLES, SlaveLifecycle, SLAVE_LIFECYCLE_LABEL (new)
packages/domain/src/lifecycle/release.ts     R3: ReleasableWorker, isReleasable (new)
packages/domain/src/lifecycle/index.ts       (new) -- ./types.js, ./release.js
packages/domain/src/index.ts                 + ./lifecycle/index.js
packages/domain/src/capability/team.ts       R2/E1/E2: TeamInput.requiredBy, TeamProposal.engagementTaskId,
                                             soleTaskFor, the temporary emission
packages/domain/src/supervisor/situations.ts R3: engagement_over (15th) + its SITUATION_LABEL
packages/domain/src/supervisor/observe.ts    R3: the predicate; staffableSlaves excludes a released worker
packages/domain/src/supervisor/actions.ts    R2/R3: hire_from_catalog.engagementTaskId, release_worker (15th)
packages/domain/src/supervisor/candidates.ts R2/R3/E3/D12: requiredBy, the released roster filter,
                                             actionOf's temporary arm, the engagement_over arm
packages/domain/src/supervisor/policy.ts     R3: tierOf(release_worker) = applied
packages/domain/src/supervisor/world.ts      R3/E4: SupervisorSlave.lifecycle/released/engagementTaskId,
                                             SupervisorTask.assigneeId
packages/domain/src/supervisor/timeline.ts   R3: LANE_BY_TYPE['slave.released'] = 'work'
packages/domain/src/events/schema.ts         R3/R4/E5/E11: slave.released (53rd), org.changed.field 'lifecycle',
                                             task.worktree_collected reason 'released'
packages/domain/test/lifecycle/release.test.ts                          (new)
packages/domain/test/capability/team.test.ts                            E10: rewritten pin + two new cases
packages/domain/test/events/schema.test.ts                              + the new type and the two widened unions
packages/domain/test/supervisor/{fixtures.ts,observe,candidates,policy,labels,timeline}.test.ts   extended

packages/db/prisma/schema.prisma             R1: enum SlaveLifecycle, five Slave columns, the Task
                                             back-relation, one EventType member, one situation member
packages/db/prisma/migrations/20260912120000_m50_lifecycle/migration.sql (new)
packages/db/src/enums.ts                     R3: EVENT_TYPE_BY_DOMAIN_TYPE gains slave.released
packages/db/src/seed.ts                      R1: the legacy worker is written `project` explicitly
packages/db/test/integration/enum-parity.test.ts                        + one assertion

apps/web/src/lib/activityFilters.ts          R3: TYPES_BY_KIND.workspace gains slave.released
apps/web/src/components/activity/cards.tsx   R3/E5/E11: SlaveReleasedCard, the third collect reason,
                                             ORG_CHANGED_LABEL.lifecycle
apps/web/src/server/timeline.ts              R3: the slave.released sentence
apps/web/src/components/SupervisorPanel.tsx  R3: actionText's release_worker arm
apps/web/test/activity-cards.test.tsx        + the payload fixture and one case

packages/control/src/lifecycle.ts            R3/R4: releaseWorker, setLifecycle (new)
packages/control/src/index.ts                + ./lifecycle.js
packages/control/src/capability.ts           R1/R2/E13: hireFromTemplate lifecycle+engagement+reuse rule,
                                             materialiseCompanySlave writes permanent,
                                             OrganizationWorker.lifecycle/released
packages/control/src/org.ts                  R1: assignCompanyTx writes permanent
packages/control/src/collect.ts              R3/E5/E6: the third reason and the actor line
packages/control/src/refusal.ts              three kinds: not_ephemeral, already_released, not_in_roster
packages/control/src/supervisor.ts           R2/R3: carryOut's engagementTaskId and release_worker arm
packages/control/src/supervisorWorld.ts      R3/E4: the four loader fields
packages/control/test/integration/lifecycle.test.ts                     (new)
packages/control/test/integration/{capability,org,supervisor}.test.ts   extended
apps/web/test/refusal-status.test.ts         the three kinds

apps/orchestrator/src/cli.ts                 R4: hire --temporary --for-task, release-worker, set-lifecycle
apps/orchestrator/test/integration/cli.test.ts                          extended

apps/web/src/server/organization.ts          R6/E9: OrganizationRow.lifecycle/released, whyHere, the sort
apps/web/src/components/organization/OrganizationClient.tsx             R6: the chip, the released line
apps/web/src/server/brief.ts                 R6/E7: ProjectBrief.team[].lifecycle/released
apps/web/src/components/project/ProjectBrief.tsx                        R6/E7: team-lifecycle, the greyed row
apps/web/src/server/overview.ts              R6/E7: SlaveCardData.lifecycle/released
apps/web/src/components/SlaveCard.tsx        R6/E7: the chip and the greyed card
apps/web/src/server/org.ts                   R6/D6: WorkerRow + AllSlaveRow lifecycle/released
apps/web/src/components/AllSlavesTable.tsx   R6/D6: the lifecycle column and the polled fields
apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/release/route.ts   (new, POST)
apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/lifecycle/route.ts (new, POST)
apps/web/test/{organization-page,project-brief,all-slaves-table}.test.tsx  extended/new
docs/ia.md                                   R6: the Organization row's Later column

scripts/fixtures/catalog-m50/{divisions.json,LICENSE,security/…,qa/…}   (new)
packages/providers/test/fixtures/plan-graph-lifecycle.ndjson            (new)
scripts/gate-m50-ephemeral.mjs               R7 (new)
scripts/gate-m44-ux-foundation.mjs           R6: RAW_TOKENS gains SLAVE_LIFECYCLES
scripts/gate-m14-fidelity.mjs                unchanged PAGES; organization + overview PNGs regenerated
package.json, .github/workflows/ci.yml, README.md                       R7
docs/superpowers/fidelity/m14/{organization,overview}.png               regenerated in their own commit
docs/superpowers/specs/2026-09-12-m50-ephemeral-specialists-design.md    the spec, committed verbatim + §4
```

---

### Task 1: The lifecycle vocabulary, the one-assignment rule, the fifteenth situation and action, the 53rd event, and the migration (R1–R4, E1–E6, E10, E11, D1, D2, D8, D12, D13)

**Files:**
- Create: `packages/domain/src/lifecycle/types.ts`, `packages/domain/src/lifecycle/release.ts`, `packages/domain/src/lifecycle/index.ts`, `packages/domain/test/lifecycle/release.test.ts`, `packages/db/prisma/migrations/20260912120000_m50_lifecycle/migration.sql`
- Modify: `packages/domain/src/index.ts`, `packages/domain/src/capability/team.ts`, `packages/domain/src/supervisor/{situations,observe,actions,candidates,policy,world,timeline}.ts`, `packages/domain/src/events/schema.ts`, `packages/db/prisma/schema.prisma`, `packages/db/src/enums.ts`, `packages/db/src/seed.ts`, `apps/web/src/lib/activityFilters.ts`, `apps/web/src/components/activity/cards.tsx`, `apps/web/src/server/timeline.ts`, `apps/web/src/components/SupervisorPanel.tsx`
- Test: `packages/domain/test/lifecycle/release.test.ts`, `packages/domain/test/capability/team.test.ts`, `packages/domain/test/events/schema.test.ts`, `packages/domain/test/supervisor/fixtures.ts`, `packages/domain/test/supervisor/{observe,candidates,policy,labels,timeline}.test.ts`, `packages/db/test/integration/enum-parity.test.ts`, `apps/web/test/activity-cards.test.tsx`

**Interfaces:**
- Consumes: `zod`; `TERMINAL` and `TaskStatus` (`packages/domain/src/task/state.js`); `CapabilityKey`, `CapabilityRecord`, `capabilityLabel`, `projectRoles` (`packages/domain/src/capability/taxonomy.js`); `SITUATION_KINDS`, `ACTION_KINDS`, `TIERS` (`packages/domain/src/supervisor/{situations,actions}.js`); `EVENT_TYPE_BY_DOMAIN_TYPE` (`packages/db/src/enums.js`).
- Produces, for Tasks 2–5:
  - `SLAVE_LIFECYCLES = ['permanent', 'project', 'ephemeral'] as const`, `type SlaveLifecycle = (typeof SLAVE_LIFECYCLES)[number]`, `SLAVE_LIFECYCLE_LABEL: Record<SlaveLifecycle, string>`
  - `interface ReleasableWorker { lifecycle: SlaveLifecycle; released: boolean; busy: boolean; engagementTaskStatus: TaskStatus | null; openAssignedTasks: number }` and `isReleasable(worker: ReleasableWorker): boolean`
  - `TeamInput.requiredBy: ReadonlyMap<CapabilityKey, readonly string[]>` (REQUIRED); `TeamProposal.engagementTaskId: string | null`
  - `Action` arm `{ kind: 'release_worker'; slaveId: string; name: string; reason: string }`; `hire_from_catalog` gains `engagementTaskId: string | null`; `ACTION_KINDS` gains `'release_worker'` (15 members)
  - `SITUATION_KINDS` gains `'engagement_over'` (15 members); `SITUATION_LABEL.engagement_over = 'Engagement over'`
  - `SupervisorSlave.lifecycle: SlaveLifecycle`, `.released: boolean`, `.engagementTaskId: string | null`; `SupervisorTask.assigneeId: string | null`
  - Event type `slave.released` with payload `{ slaveId: string; name: string; reason: string; worktreesCollected: number }`; `org.changed.payload.field` gains `'lifecycle'`; `task.worktree_collected.payload.reason` gains `'released'`
  - Prisma: `enum SlaveLifecycle`; `Slave.lifecycle` / `.engagementTaskId` / `.releasedAt` / `.releaseReason` / `.createdAt`
  - `actionOf` now returns `Action` (never null — D12)

- [ ] **Step 1: Write the failing test for the lifecycle vocabulary and the release rule**

`packages/domain/test/lifecycle/release.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { SLAVE_LIFECYCLES, SLAVE_LIFECYCLE_LABEL } from '../../src/lifecycle/types.js'
import { isReleasable, type ReleasableWorker } from '../../src/lifecycle/release.js'

const ENGAGED: ReleasableWorker = {
  lifecycle: 'ephemeral',
  released: false,
  busy: false,
  engagementTaskStatus: 'done',
  openAssignedTasks: 0,
}

describe('the lifecycle vocabulary', () => {
  it('is the three M50 names, in the order a person reads them', () => {
    expect(SLAVE_LIFECYCLES).toEqual(['permanent', 'project', 'ephemeral'])
  })

  it('gives every member a word, so no surface ever prints the key', () => {
    expect(SLAVE_LIFECYCLE_LABEL).toEqual({
      permanent: 'Permanent',
      project: 'Project',
      ephemeral: 'Ephemeral',
    })
  })
})

describe('isReleasable', () => {
  it('releases an ephemeral worker whose one assignment is done and who has nothing else open', () => {
    expect(isReleasable(ENGAGED)).toBe(true)
  })

  it('releases one whose assignment failed or was cancelled -- the engagement is over either way', () => {
    expect(isReleasable({ ...ENGAGED, engagementTaskStatus: 'failed' })).toBe(true)
    expect(isReleasable({ ...ENGAGED, engagementTaskStatus: 'cancelled' })).toBe(true)
  })

  it('never releases a project or permanent worker, whatever else is true of them', () => {
    expect(isReleasable({ ...ENGAGED, lifecycle: 'project' })).toBe(false)
    expect(isReleasable({ ...ENGAGED, lifecycle: 'permanent' })).toBe(false)
  })

  it('never releases one that is already released', () => {
    expect(isReleasable({ ...ENGAGED, released: true })).toBe(false)
  })

  it('never releases one with a live run', () => {
    expect(isReleasable({ ...ENGAGED, busy: true })).toBe(false)
  })

  it('never releases one whose assignment is still open', () => {
    expect(isReleasable({ ...ENGAGED, engagementTaskStatus: 'ready' })).toBe(false)
    expect(isReleasable({ ...ENGAGED, engagementTaskStatus: 'running' })).toBe(false)
    expect(isReleasable({ ...ENGAGED, engagementTaskStatus: 'reviewing' })).toBe(false)
  })

  it('never releases one whose assignment the world no longer holds', () => {
    expect(isReleasable({ ...ENGAGED, engagementTaskStatus: null })).toBe(false)
  })

  it('never releases one that still has other work assigned to it', () => {
    expect(isReleasable({ ...ENGAGED, openAssignedTasks: 1 })).toBe(false)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/lifecycle/release.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/lifecycle/types.js"`.

- [ ] **Step 3: Write the two pure modules**

`packages/domain/src/lifecycle/types.ts`:

```ts
/**
 * WHY a worker exists (M50 R1), as data.
 *
 * `permanent` is somebody who exists in the COMPANY ROSTER and was materialised onto this project;
 * `project` is somebody hired for this project; `ephemeral` is a specialist brought in for exactly
 * ONE assignment, who is released when that assignment is over.
 *
 * A COLUMN, never a derivation. Until this milestone three surfaces derived `company | project`
 * from `Slave.companySlaveId` being null (`packages/control/src/capability.ts`,
 * `apps/web/src/server/organization.ts`, `apps/web/src/server/brief.ts`) -- three readings of one
 * question, none of which could say "this one is temporary" because the schema held no such fact.
 *
 * The order is the one a person reads them in: most permanent first.
 */
export const SLAVE_LIFECYCLES = ['permanent', 'project', 'ephemeral'] as const

export type SlaveLifecycle = (typeof SLAVE_LIFECYCLES)[number]

/**
 * What each lifecycle is called when a person reads it (`docs/ia.md` rule 3). `Record<SlaveLifecycle,
 * string>` is load-bearing: a fourth member fails the build here rather than turning up on the
 * Organization tab as an identifier.
 */
export const SLAVE_LIFECYCLE_LABEL: Record<SlaveLifecycle, string> = {
  permanent: 'Permanent',
  project: 'Project',
  ephemeral: 'Ephemeral',
}
```

`packages/domain/src/lifecycle/release.ts`:

```ts
import { TERMINAL, type TaskStatus } from '../task/state.js'
import type { SlaveLifecycle } from './types.js'

/**
 * The five facts {@link isReleasable} decides on, and the whole of what the rule reads.
 *
 * Deliberately NOT a `SupervisorSlave`: control re-asks the same question of Prisma rows under a
 * row lock, and a shape both sides can build is what keeps one rule from becoming two that drift
 * (the `AnswerEligibility` precedent in `../supervisor/policy.ts`).
 *
 * `engagementTaskStatus` is the status of the ONE task this worker was brought in for, or null when
 * the worker names no task or the world no longer holds it. `openAssignedTasks` counts the
 * non-terminal tasks whose `assigneeId` is this worker.
 */
export interface ReleasableWorker {
  readonly lifecycle: SlaveLifecycle
  readonly released: boolean
  readonly busy: boolean
  readonly engagementTaskStatus: TaskStatus | null
  readonly openAssignedTasks: number
}

/**
 * Is this worker's engagement over (M50 R3)? Pure and total.
 *
 * Five clauses, each of which would otherwise release somebody who is still working:
 *
 *  - only an `ephemeral` worker is released at all. A `project` worker leaves by `deleteSlave`
 *    (M23) and a `permanent` one by leaving the roster; neither is this rule's business.
 *  - an already-released worker is not released twice -- the row keeps the timestamp and the
 *    sentence the first release wrote.
 *  - a BUSY worker holds a live run. Emptying its runtime roles under that run would leave the
 *    record and the roster disagreeing about who the run belongs to.
 *  - the engagement task must be TERMINAL -- `done`, `failed` or `cancelled`. A failed assignment is
 *    over as surely as a finished one; what is NOT over is one still on the board, and a worker
 *    whose task the world cannot find is not evidence of anything.
 *  - nothing else may be assigned to it. `Task.assigneeId` is written by nobody in the pipeline
 *    today, which makes this clause quiet rather than redundant: a hand-assigned task is a real
 *    row, and releasing the only worker who holds it would strand it.
 */
export function isReleasable(worker: ReleasableWorker): boolean {
  if (worker.lifecycle !== 'ephemeral') return false
  if (worker.released) return false
  if (worker.busy) return false
  if (worker.engagementTaskStatus === null) return false
  if (!TERMINAL.includes(worker.engagementTaskStatus)) return false
  return worker.openAssignedTasks === 0
}
```

`packages/domain/src/lifecycle/index.ts`:

```ts
export * from './types.js'
export * from './release.js'
```

`packages/domain/src/index.ts` — one line, beside the other feature barrels (after `./handoff/index.js`, before `./memory/index.js`, which keeps the list alphabetical where it already is):

```ts
export * from './lifecycle/index.js'
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run packages/domain/test/lifecycle/release.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Write the failing tests for the one-assignment rule**

`packages/domain/test/capability/team.test.ts` — the helper at `:11-18` gains one line, the M47 pin at `:124-132` is REWRITTEN (erratum E10), and two cases are added:

```ts
const input = (overrides: Partial<TeamInput> = {}): TeamInput => ({
  required: [],
  // M50 R2: who needs what. EMPTY by default, so no case in this file becomes a temporary hire by
  // accident -- a capability no task is recorded as needing has no sole assignment and stays a
  // project worker, which is exactly what every case written before this milestone meant.
  requiredBy: new Map(),
  roster: [],
  company: [],
  catalog: [],
  taxonomy: TAXONOMY,
  ...overrides,
})
```

Replacing the `never emits the temporary source in this milestone` case:

```ts
  it('keeps a gap two startable tasks share a PROJECT worker -- a standing seat, not one assignment', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        requiredBy: new Map([['security.application', ['t1', 't2']]]),
        catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' }],
      }),
    )
    expect(plan.proposals).toHaveLength(1)
    expect(plan.proposals[0]?.source).toBe('project_worker')
    expect(plan.proposals[0]?.temporary).toBe(false)
    expect(plan.proposals[0]?.engagementTaskId).toBeNull()
  })

  it('asks for a TEMPORARY specialist when the gap belongs to exactly one startable task', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        requiredBy: new Map([['security.application', ['t1']]]),
        catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' }],
      }),
    )
    expect(plan.proposals).toHaveLength(1)
    expect(plan.proposals[0]?.source).toBe('temporary')
    expect(plan.proposals[0]?.temporary).toBe(true)
    expect(plan.proposals[0]?.engagementTaskId).toBe('t1')
    expect(plan.proposals[0]?.rationale).toContain('one assignment')
  })

  // Erratum E2: a catalog pick covers a SET, and the rule is over the union of the tasks behind it.
  it('is temporary when one pick covers two capabilities the SAME single task needs', () => {
    const plan = formTeam(
      input({
        required: ['security.application', 'qa.test-automation'],
        requiredBy: new Map([
          ['security.application', ['t1']],
          ['qa.test-automation', ['t1']],
        ]),
        catalog: [
          { templateId: 'tpl-both', name: 'Security Test Engineer', capabilities: ['security.application', 'qa.test-automation'], division: 'security' },
        ],
      }),
    )
    expect(plan.proposals).toHaveLength(1)
    expect(plan.proposals[0]?.source).toBe('temporary')
    expect(plan.proposals[0]?.engagementTaskId).toBe('t1')
  })

  it('is NOT temporary when one pick covers two capabilities two different tasks need', () => {
    const plan = formTeam(
      input({
        required: ['security.application', 'qa.test-automation'],
        requiredBy: new Map([
          ['security.application', ['t1']],
          ['qa.test-automation', ['t2']],
        ]),
        catalog: [
          { templateId: 'tpl-both', name: 'Security Test Engineer', capabilities: ['security.application', 'qa.test-automation'], division: 'security' },
        ],
      }),
    )
    expect(plan.proposals).toHaveLength(1)
    expect(plan.proposals[0]?.source).toBe('project_worker')
    expect(plan.proposals[0]?.engagementTaskId).toBeNull()
  })

  it('never makes a company worker or an existing worker temporary, however few tasks need them', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        requiredBy: new Map([['security.application', ['t1']]]),
        company: [{ companySlaveId: 'cs1', name: 'Sam', capabilities: ['security.application'] }],
        catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' }],
      }),
    )
    expect(plan.proposals.map((p) => p.source)).toEqual(['company_worker'])
    expect(plan.proposals[0]?.temporary).toBe(false)
    expect(plan.proposals[0]?.engagementTaskId).toBeNull()
  })
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npx vitest run packages/domain/test/capability/team.test.ts`
Expected: FAIL — `Object literal may only specify known properties, and 'requiredBy' does not exist in type 'TeamInput'`, and the four new cases fail on `engagementTaskId` being undefined.

Before moving on, confirm the one existing gate this rule could move: `gate:m47-team-formation`'s `security.application` gap is one task's (`AUTH_TASK_TITLE`, one task in `plan-graph-capabilities.ndjson`), so after Task 1 its proposal becomes `source: 'temporary'` with `temporary: true`. Read `scripts/gate-m47-team-formation.mjs`'s stage 4 assertions: it asserts `action.kind === 'hire_from_catalog'`, the tier, the status and the rationale — **not** `action.temporary`. Confirm that with `grep -n "temporary" scripts/gate-m47-team-formation.mjs` (expected: no hits). If a hit appears, STOP and report it: the gate is unchanged by ruling, and a rule that moves it is a plan error, not a gate edit.

- [ ] **Step 7: Implement the one-assignment rule in `formTeam`**

`packages/domain/src/capability/team.ts` — `TeamInput` gains the map:

```ts
export interface TeamInput {
  /** The capabilities the BOARD needs -- the union over its ready and blocked tasks. */
  readonly required: readonly CapabilityKey[]
  /**
   * WHICH startable tasks need each capability (M50 R2) -- the task ids per key, from the SAME
   * staffable tasks {@link required} is built from (`teamPlanOf`, one pass over one filtered
   * array; plan erratum E3). It is what makes "one assignment" answerable here rather than
   * guessable: a gap exactly one task has is a job, and a gap two tasks share is a seat.
   *
   * A key that is absent, or whose list is empty, has no sole assignment and can never become a
   * temporary hire -- which is what an unfilled map means, and why every caller written before
   * this milestone keeps behaving exactly as it did.
   */
  readonly requiredBy: ReadonlyMap<CapabilityKey, readonly string[]>
  readonly roster: readonly TeamRosterMember[]
  /** The company's roster rows that are NOT already materialised into this project. */
  readonly company: readonly TeamCompanyWorker[]
  readonly catalog: readonly TeamCatalogEntry[]
  readonly taxonomy: readonly CapabilityRecord[]
  /** Templates a current worker's own profile recommends pairing with (R5). A tie-break and a
   *  sentence, never a dispatch. */
  readonly recommendedTemplateIds?: readonly string[]
}
```

`TeamSource`'s docstring loses its "never emitted in M47" sentence and `TeamProposal` gains the carrier (erratum E1):

```ts
/** Where a proposed worker would come from, in the preference order R4 fixes: an existing capable
 *  worker, an existing company worker, a new project worker, a temporary specialist. `temporary` is
 *  a CATALOG pick whose gap belongs to exactly one startable task (M50 R2) -- the same hire, with
 *  an end written into it. */
export type TeamSource = 'existing_worker' | 'company_worker' | 'project_worker' | 'temporary'
```

```ts
  /** M50 R2: true exactly when {@link source} is `temporary`. Kept as its own field because the
   *  ACTION carries it as a flag and a decision row read a year later must say what was claimed. */
  readonly temporary: boolean
  /** The ONE assignment a temporary specialist is being asked for (M50 R2, plan erratum E1), null
   *  on every other source. Carried on the proposal because `actionOf` -- which builds the action
   *  the decision stores -- is handed a proposal and a world, and {@link TeamInput.requiredBy} is
   *  an input to this function that neither of them can reach. */
  readonly engagementTaskId: string | null
  readonly rationale: string
```

The three existing pushes each gain one line. `existing_worker` (`:126` area):

```ts
      temporary: false,
      engagementTaskId: null,
```

`company_worker` (`:150` area) — identically:

```ts
      temporary: false,
      engagementTaskId: null,
```

The catalog arm is the one that decides:

```ts
  coverWith(
    outstanding,
    [...input.catalog].toSorted((a, b) => a.templateId.localeCompare(b.templateId)).map((entry) => ({
      id: entry.templateId,
      name: entry.name,
      capabilities: entry.capabilities,
      recommended: recommended.has(entry.templateId),
    })),
    (pick, covers) => {
      // M50 R2. The ONE difference between a hire and a temporary hire is how much work is waiting:
      // one startable task is an assignment, two are a seat. Everything else about the pick -- how
      // it was chosen, what it covers, the tie-breaks it won -- is identical, which is why this is
      // a field on the proposal rather than a fourth tier of the search.
      const engagementTaskId = soleTaskFor(covers, input.requiredBy)
      const recommendedClause = pick.recommended ? ", and a worker's profile recommends pairing with it" : ''
      proposals.push({
        capability: covers[0] as CapabilityKey,
        source: engagementTaskId === null ? 'project_worker' : 'temporary',
        pick: { kind: 'template', id: pick.id, name: pick.name },
        covers,
        temporary: engagementTaskId !== null,
        engagementTaskId,
        rationale:
          engagementTaskId === null
            ? `${pick.name} provides ${labelList(covers, input.taxonomy)}, which nobody on this project or on the ` +
              `company roster does${recommendedClause}.`
            : `${pick.name} provides ${labelList(covers, input.taxonomy)}, which nobody on this project or on the ` +
              `company roster does, and exactly one piece of startable work needs it -- so this is one assignment ` +
              `rather than a standing seat${recommendedClause}.`,
      })
    },
  )
```

and the helper goes beside `labelList` at the foot of the file:

```ts
/**
 * The ONE task every capability in `covers` is required by, or null (M50 R2, plan erratum E2).
 *
 * A catalog pick covers a SET -- that minimality is what M47 is named for -- so "the capability it
 * covers is required by exactly one task" has to be read over the UNION of the tasks behind those
 * keys. One worker brought in for two capabilities the same task needs is still one assignment;
 * two capabilities two different tasks need is a seat, whoever fills it.
 *
 * Null for an empty list as well as for a crowded one: a key nothing is recorded as needing cannot
 * name the assignment a release would later be measured against, and a temporary worker with no
 * engagement is one nothing can ever release.
 */
function soleTaskFor(
  covers: readonly CapabilityKey[],
  requiredBy: ReadonlyMap<CapabilityKey, readonly string[]>,
): string | null {
  const tasks = new Set<string>()
  for (const capability of covers) {
    const waiting = requiredBy.get(capability) ?? []
    if (waiting.length === 0) return null
    for (const taskId of waiting) tasks.add(taskId)
    if (tasks.size > 1) return null
  }
  return tasks.size === 1 ? ([...tasks][0] as string) : null
}
```

- [ ] **Step 8: Run the team tests and watch them pass**

Run: `npx vitest run packages/domain/test/capability/team.test.ts`
Expected: PASS — every pre-existing case unchanged (the empty default map keeps them `project_worker`) plus the five written in Step 5.

- [ ] **Step 9: Write the failing tests for the fifteenth situation, the fifteenth action and its tier**

`packages/domain/test/supervisor/fixtures.ts` — the two builders gain the four fields (erratum E4), each with the value that keeps every existing test meaning what it meant:

```ts
    requiredCapabilities: [],
    // M50 R3: nobody is hand-assigned by default. `Task.assigneeId` is written by nothing in the
    // pipeline, so a fixture that set one would be describing a board this product does not make.
    assigneeId: null,
    stage: null,
```

```ts
export function slave(overrides: Partial<SupervisorSlave> = {}): SupervisorSlave {
  return {
    id: 's1',
    name: 'Alex',
    role: 'Backend Engineer',
    runtimeRoles: ['backend'],
    capabilities: [],
    busy: false,
    // M50 R1/R3: an ordinary project worker, engaged for nothing in particular and never released
    // -- which is what every fixture in this file means unless it says otherwise.
    lifecycle: 'project',
    engagementTaskId: null,
    released: false,
    ...overrides,
  }
}
```

`packages/domain/test/supervisor/observe.test.ts` — a new describe block:

```ts
describe('engagement_over', () => {
  it('raises one for an ephemeral worker whose assignment is done, keyed on the SLAVE', () => {
    const situations = observe(
      world({
        tasks: [task({ id: 't1', title: 'Add authentication', status: 'done' })],
        slaves: [slave({ id: 's9', name: 'Robin', lifecycle: 'ephemeral', engagementTaskId: 't1', runtimeRoles: ['security'] })],
      }),
    )
    const found = situations.filter((one) => one.kind === 'engagement_over')
    expect(found).toHaveLength(1)
    expect(found[0]?.subjectId).toBe('s9')
    expect(found[0]?.summary).toContain('Robin')
    expect(found[0]?.summary).toContain('Add authentication')
    expect(found[0]?.facts).toEqual({
      slaveId: 's9',
      name: 'Robin',
      engagementTaskId: 't1',
      engagementTaskStatus: 'done',
    })
  })

  it('raises none while the assignment is still on the board', () => {
    const situations = observe(
      world({
        tasks: [task({ id: 't1', status: 'running' })],
        slaves: [slave({ id: 's9', lifecycle: 'ephemeral', engagementTaskId: 't1' })],
      }),
    )
    expect(situations.filter((one) => one.kind === 'engagement_over')).toEqual([])
  })

  it('raises none for a project worker, and none for one already released', () => {
    const done = [task({ id: 't1', status: 'done' })]
    expect(
      observe(world({ tasks: done, slaves: [slave({ id: 's9', engagementTaskId: 't1' })] })).filter(
        (one) => one.kind === 'engagement_over',
      ),
    ).toEqual([])
    expect(
      observe(
        world({
          tasks: done,
          slaves: [slave({ id: 's9', lifecycle: 'ephemeral', engagementTaskId: 't1', released: true, runtimeRoles: [] })],
        }),
      ).filter((one) => one.kind === 'engagement_over'),
    ).toEqual([])
  })

  it('raises none while the worker still has other work assigned to it', () => {
    const situations = observe(
      world({
        tasks: [task({ id: 't1', status: 'done' }), task({ id: 't2', status: 'ready', assigneeId: 's9' })],
        slaves: [slave({ id: 's9', lifecycle: 'ephemeral', engagementTaskId: 't1' })],
      }),
    )
    expect(situations.filter((one) => one.kind === 'engagement_over')).toEqual([])
  })
})

describe('staffableSlaves', () => {
  it('never offers a role to a released worker', () => {
    const released = slave({ id: 's9', lifecycle: 'ephemeral', released: true, runtimeRoles: [] })
    expect(staffableSlaves(world({ slaves: [released] }), 'reviewer')).toEqual([])
  })
})
```

`packages/domain/test/supervisor/candidates.test.ts` — the offer and the shape the action stores:

```ts
describe('engagement_over candidates', () => {
  it('offers release_worker first, then the escalation and the no-op', () => {
    const situation = {
      kind: 'engagement_over' as const,
      subjectId: 's9',
      summary: 'Robin was brought in for "Add authentication" and that assignment is over.',
      facts: {},
    }
    const offers = candidates(
      situation,
      world({
        tasks: [task({ id: 't1', status: 'done' })],
        slaves: [slave({ id: 's9', name: 'Robin', lifecycle: 'ephemeral', engagementTaskId: 't1' })],
      }),
    )
    expect(offers.map((one) => one.action.kind)).toEqual(['release_worker', 'escalate_to_human', 'no_action'])
    expect(offers[0]?.action).toEqual({
      kind: 'release_worker',
      slaveId: 's9',
      name: 'Robin',
      reason: situation.summary,
    })
    expect(offers[0]?.tier).toBe('applied')
  })

  it('offers only the last resorts when the world no longer holds the worker', () => {
    const offers = candidates(
      { kind: 'engagement_over', subjectId: 'gone', summary: 'over', facts: {} },
      world({}),
    )
    expect(offers.map((one) => one.action.kind)).toEqual(['escalate_to_human', 'no_action'])
  })
})

describe('the temporary hire reaches the action', () => {
  it('carries temporary: true and the engagement task the rules chose', () => {
    const offers = candidates(
      {
        kind: 'capability_unstaffed',
        subjectId: 'security.application',
        summary: '1 startable task(s) need Application security and no slave can be dispatched as security.',
        facts: {},
      },
      world({
        taxonomy: TAXONOMY,
        tasks: [task({ id: 't1', status: 'ready', requiredCapabilities: ['security.application'] })],
        catalog: [
          {
            templateId: 'tpl1',
            name: 'Security Reviewer',
            capabilities: ['security.application'],
            division: 'security',
            recommended: false,
          },
        ],
      }),
    )
    expect(offers[0]?.action).toEqual({
      kind: 'hire_from_catalog',
      templateId: 'tpl1',
      capability: 'security.application',
      capabilityLabel: 'Application security',
      name: 'Security Reviewer',
      rationale: expect.stringContaining('one assignment') as unknown as string,
      temporary: true,
      engagementTaskId: 't1',
    })
    expect(offers[0]?.tier).toBe('proposed')
  })
})
```

`packages/domain/test/supervisor/policy.test.ts` — the tier, and the halt that demotes it:

```ts
  it('applies release_worker routinely -- it is the routine this milestone exists for', () => {
    const action = { kind: 'release_worker' as const, slaveId: 's9', name: 'Robin', reason: 'over' }
    expect(tierOf(action, world({}), 'engagement_over')).toBe('applied')
  })

  it('demotes release_worker to a proposal while the workspace is halted, like everything else', () => {
    const action = { kind: 'release_worker' as const, slaveId: 's9', name: 'Robin', reason: 'over' }
    const halted = world({ halted: { reason: 'budget exhausted', guardrail: 'budget' } })
    expect(tierOf(action, halted, 'engagement_over')).toBe('proposed')
  })
```

(The `halted` shape is whatever `world()`'s own fixture already builds for the existing halt cases in this file — copy it from the `workspace_halted` case above rather than inventing one.)

`packages/domain/test/supervisor/labels.test.ts` — the label count moves with the kind; find the assertion that pins `SITUATION_LABEL` and extend it so `engagement_over: 'Engagement over'` is asserted by name.

- [ ] **Step 10: Run them and watch them fail**

Run: `npx vitest run packages/domain/test/supervisor`
Expected: FAIL — `Type '"engagement_over"' is not assignable to type 'SituationKind'` and `'lifecycle' does not exist in type 'SupervisorSlave'`.

- [ ] **Step 11: Declare the fifteenth situation and its label**

`packages/domain/src/supervisor/situations.ts` — the member goes between `done_not_integrated_stale` and `memory_candidates_piling` (plan decision D1):

```ts
  'done_not_integrated_stale',
  /**
   * M50 R3: a worker brought in for ONE assignment, whose assignment is over. `subjectId` is the
   * SLAVE id -- this is about a person's engagement, not about a task or a role, and it is the
   * first situation in this list whose subject is a worker.
   *
   * Directly after `done_not_integrated_stale` and before `memory_candidates_piling` (plan decision
   * D1): all three are housekeeping. Nothing is stuck, nothing is waiting on a person, and a reader
   * meets "finished, not integrated", "this engagement is over" and "nothing verified what was
   * reported" in one pass at the foot of the report.
   */
  'engagement_over',
  'memory_candidates_piling',
```

The `SITUATION_LABEL` comment's count moves ("a SIXTEENTH kind fails the build here … fifteen as of M50's `engagement_over`") and the map gains:

```ts
  engagement_over: 'Engagement over',
```

- [ ] **Step 12: Declare the fifteenth action, widen the hire, and fix the tier**

`packages/domain/src/supervisor/actions.ts` — `hire_from_catalog`'s docstring and arm:

```ts
  /** `hireFromTemplate`: a new project worker from a catalog template. `rationale` is the sentence
   *  stored on the worker (`Slave.selectionRationale`) and shown on the Organization view --
   *  "why selected", months later. `temporary` is M50's lifecycle: true makes the hire `ephemeral`
   *  and `engagementTaskId` is the ONE assignment it was brought in for -- the task
   *  `engagement_over` later measures the end of the engagement against. Both are null/false for an
   *  ordinary hire. */
  | { readonly kind: 'hire_from_catalog'; readonly templateId: string; readonly capability: string; readonly capabilityLabel: string; readonly name: string; readonly rationale: string; readonly temporary: boolean; readonly engagementTaskId: string | null }
  /** `releaseWorker` (M50 R3): an ephemeral worker whose one assignment is over. Its runtime roles
   *  are emptied so nothing dispatches it again and its terminal tasks' worktrees are collected;
   *  NOTHING is deleted -- every run, context, message and memory it produced stays. The ROUTINE
   *  one ({@link tierOf}): the worker's own row is the evidence, nobody new arrives, and nothing is
   *  spent. `name` is carried for the same reason `capabilityLabel` is -- `actionText` runs in the
   *  browser and has no roster to look a slave id up in. */
  | { readonly kind: 'release_worker'; readonly slaveId: string; readonly name: string; readonly reason: string }
```

`ACTION_KINDS` gains `'release_worker'` immediately after `'discard_stale_candidates'` (15 members), and `actionSchema` gains the two changes:

```ts
  z.object({
    kind: z.literal('hire_from_catalog'),
    templateId: z.string().min(1),
    capability: z.string().min(1),
    capabilityLabel: z.string().min(1),
    name: z.string().min(1),
    rationale: z.string().min(1),
    temporary: z.boolean(),
    // Nullable rather than optional: a stored row written before M50 has no key here at all, and
    // `z.object` would strip a missing one to `undefined` -- which is not `null` and is not a value
    // `carryOut` may pass to a column. `.nullish().transform()` makes both readings one value.
    engagementTaskId: z.string().min(1).nullish().transform((value) => value ?? null),
  }),
  z.object({
    kind: z.literal('release_worker'),
    slaveId: z.string().min(1),
    name: z.string().min(1),
    reason: z.string().min(1),
  }),
```

`packages/domain/src/supervisor/policy.ts` — the case joins `assign_capability`'s neighbourhood, after the halt short-circuit:

```ts
    // ROUTINE (M50 R3), and for `assign_capability`'s own reason: EVIDENCE. The worker's own row
    // says it was brought in for one assignment and the board says that assignment is over --
    // nobody new arrives, nothing is spent, nothing is deleted, and the worker keeps every row it
    // wrote. A proposal here would be a person asked to confirm a fact two columns already state.
    // `halted` still demotes it above, like everything else.
    case 'release_worker':
      return 'applied'
```

- [ ] **Step 13: Widen the world and write the predicate**

`packages/domain/src/supervisor/world.ts` — `SupervisorTask` gains one field:

```ts
  /**
   * The worker a task is HAND-assigned to (M50 R3), or null.
   *
   * LOADER CONTRACT: `Task.assigneeId` verbatim. Nothing in the pipeline writes this column -- a run
   * is linked to its worker through `SlaveRun.slaveId` -- so it is null on every task this product
   * plans. It is read by exactly one predicate, `engagement_over`, which must not release the only
   * worker holding a hand-assigned task.
   */
  readonly assigneeId: string | null
```

and `SupervisorSlave` gains three (plan erratum E4):

```ts
  readonly busy: boolean
  /** M50 R1: why this worker exists. A COLUMN -- `permanent` is a roster worker, `project` a
   *  project hire, `ephemeral` a specialist brought in for one assignment. */
  readonly lifecycle: SlaveLifecycle
  /** M50 R2: the ONE assignment an `ephemeral` worker was brought in for, null on everything else.
   *  Read by `engagement_over`, which measures the end of the engagement against that task's own
   *  status. */
  readonly engagementTaskId: string | null
  /** M50 R3: the engagement is over and the worker was released. A released worker holds no runtime
   *  roles -- which is what stops `decide()` picking it, one rule and no second filter -- and it is
   *  excluded from `formTeam`'s roster and from `staffableSlaves` so nothing proposes giving it
   *  roles back. */
  readonly released: boolean
```

with `import type { SlaveLifecycle } from '../lifecycle/types.js'` at the top.

`packages/domain/src/supervisor/observe.ts` — the predicate goes after the `ready_unstaffed` loop and before `memory_candidates_piling`, matching the declared order:

```ts
  // engagement_over: a worker brought in for ONE assignment, whose assignment is over. The subject
  // is the SLAVE, not the task -- what is over is this person's engagement, and there is exactly one
  // situation per worker however many rows their runs left behind.
  const statusByTask = new Map(world.tasks.map((one) => [one.id, one.status] as const))
  for (const worker of world.slaves) {
    const engagementTaskStatus =
      worker.engagementTaskId === null ? null : (statusByTask.get(worker.engagementTaskId) ?? null)
    const openAssignedTasks = world.tasks.filter(
      (one) => one.assigneeId === worker.id && !TERMINAL.includes(one.status),
    ).length
    const releasable = isReleasable({
      lifecycle: worker.lifecycle,
      released: worker.released,
      busy: worker.busy,
      engagementTaskStatus,
      openAssignedTasks,
    })
    if (!releasable) continue
    // The task's TITLE, not its id: this sentence is read on the Supervisor panel and in the
    // decision row a year later, and a uuid is not something anybody can judge an offer by. The id
    // stays on `facts`, which is where every machine reader takes it from.
    const title = world.tasks.find((one) => one.id === worker.engagementTaskId)?.title ?? 'one assignment'
    add({
      kind: 'engagement_over',
      subjectId: worker.id,
      summary: `${worker.name} was brought in for "${title}" and that assignment is over, with nothing else open for them.`,
      facts: {
        slaveId: worker.id,
        name: worker.name,
        engagementTaskId: worker.engagementTaskId,
        engagementTaskStatus,
      },
    })
  }
```

with `TERMINAL` added to the `../task/state.js` import and `isReleasable` imported from `../lifecycle/release.js`.

`staffableSlaves` at the foot of the same file gains one clause:

```ts
/**
 * The slaves a staffing action could add `role` to: not busy (a running slave's roles must not
 * change under it), not already holding it, and NOT RELEASED (M50 R3) -- a released worker's role
 * set is empty on purpose, so without this clause it would be the first candidate every staffing
 * offer named.
 */
export function staffableSlaves(world: SupervisorWorld, role: string): readonly SupervisorSlave[] {
  return world.slaves.filter((slave) => !slave.busy && !slave.released && !slave.runtimeRoles.includes(role))
}
```

- [ ] **Step 14: Build the `requiredBy` map, filter the roster, and give `actionOf` its fifteenth arm**

`packages/domain/src/supervisor/candidates.ts` — `teamPlanOf`:

```ts
export function teamPlanOf(world: SupervisorWorld): TeamPlan {
  const staffable = world.tasks.filter(isStaffableTask)
  const required = staffable.flatMap((task) => task.requiredCapabilities)
  // M50 R2 (plan erratum E3): WHO needs what, off the same filtered array `required` came from --
  // one pass, so "this gap belongs to one assignment" can never be asked of a different set of
  // tasks than the gap itself was measured over. Ids are pushed in `world.tasks` order and never
  // doubled, so the map is the same map whatever order the loader returned rows in.
  const requiredBy = new Map<string, string[]>()
  for (const task of staffable) {
    for (const capability of task.requiredCapabilities) {
      const waiting = requiredBy.get(capability)
      if (waiting === undefined) requiredBy.set(capability, [task.id])
      else if (!waiting.includes(task.id)) waiting.push(task.id)
    }
  }
  return formTeam({
    required,
    requiredBy,
    // M50 R3: a RELEASED worker is not on this team. Its capabilities are still on its row -- they
    // are what it did here -- but it holds no runtime roles and nothing may propose giving it any,
    // so leaving it in the roster would make `formTeam`'s first tier offer the one worker that
    // cannot take the job.
    roster: world.slaves
      .filter((slave) => !slave.released)
      .map((slave) => ({
        slaveId: slave.id,
        name: slave.name,
        capabilities: slave.capabilities,
        runtimeRoles: slave.runtimeRoles,
        busy: slave.busy,
      })),
    company: world.company.map((worker) => ({
      companySlaveId: worker.companySlaveId,
      name: worker.name,
      capabilities: worker.capabilities,
    })),
    catalog: world.catalog.map((entry) => ({
      templateId: entry.templateId,
      name: entry.name,
      capabilities: entry.capabilities,
      division: entry.division,
    })),
    taxonomy: world.taxonomy,
    recommendedTemplateIds: world.catalog.filter((entry) => entry.recommended).map((entry) => entry.templateId),
  })
}
```

`actionOf` loses its null (plan decision D12):

```ts
/** One `formTeam` proposal as an {@link Action}. Total since M50: the `temporary` source is a hire
 *  with an end written into it, so all four sources map to a real offer and the return is an
 *  `Action` rather than an `Action | null`. */
function actionOf(proposal: TeamProposal, capability: string, world: SupervisorWorld): Action {
  const capabilityLabel = capabilityLabelOf(capability, world)
  switch (proposal.source) {
    case 'existing_worker':
      return {
        kind: 'assign_capability',
        slaveId: proposal.pick.id,
        capability,
        capabilityLabel,
        role: projectRoles([capability], world.taxonomy)[0] ?? '',
      }
    case 'company_worker':
      return {
        kind: 'materialise_company_worker',
        companySlaveId: proposal.pick.id,
        capability,
        capabilityLabel,
        name: proposal.pick.name,
        rationale: proposal.rationale,
      }
    // ONE arm for both (M50 R2): the same verb, from the same catalog, chosen by the same search.
    // The only difference is how long the worker is here for, and the proposal carries that as two
    // fields rather than as two shapes.
    case 'project_worker':
    case 'temporary':
      return {
        kind: 'hire_from_catalog',
        templateId: proposal.pick.id,
        capability,
        capabilityLabel,
        name: proposal.pick.name,
        rationale: proposal.rationale,
        temporary: proposal.temporary,
        engagementTaskId: proposal.engagementTaskId,
      }
  }
}
```

and the `capability_unstaffed` loop drops the guard the null needed:

```ts
      for (const proposal of teamPlanOf(world).proposals.filter((one) => one.covers.includes(situation.subjectId))) {
        offers.push(candidate(actionOf(proposal, situation.subjectId, world), world, situation.kind, proposal.rationale))
      }
```

The new arm goes directly before `done_not_integrated_stale`'s, in `SITUATION_KINDS` order:

```ts
    case 'engagement_over': {
      // `subjectId` IS the slave id. A worker the world no longer holds cannot be released -- there
      // is nothing to name in the offer -- so it falls through to the last resorts rather than
      // offering an action against a row that is not there (the question arms' own rule).
      const worker = world.slaves.find((one) => one.id === situation.subjectId)
      if (worker !== undefined) {
        offers.push(
          candidate(
            { kind: 'release_worker', slaveId: worker.id, name: worker.name, reason: situation.summary },
            world,
            situation.kind,
            `${worker.name} was brought in for one assignment and that assignment is over. Releasing them empties their runtime roles so nothing dispatches them again and collects the worktrees their runs left behind; every run, message and thing they learnt stays exactly where it is.`,
          ),
        )
      }
      break
    }
```

- [ ] **Step 15: Run the supervisor domain tests and watch them pass**

Run: `npx vitest run packages/domain/test/supervisor packages/domain/test/capability`
Expected: PASS. If `candidates.test.ts:488`'s existing `hire_from_catalog` expectation fails on a missing key, add `engagementTaskId: null` to that literal — an ordinary hire carries one.

- [ ] **Step 16: Write the failing tests for the 53rd event and the two widened unions**

`packages/domain/test/events/schema.test.ts`:

```ts
  it('accepts slave.released, the 53rd type', () => {
    const parsed = parseExecutionEvent({
      type: 'slave.released',
      workspaceId: 'w1',
      slaveId: 's9',
      actor: 'system',
      payload: { slaveId: 's9', name: 'Robin', reason: 'the engagement is over', worktreesCollected: 1 },
    })
    expect(parsed.ok).toBe(true)
  })

  it('refuses a slave.released with no count -- the payload says what was cleaned up', () => {
    const parsed = parseExecutionEvent({
      type: 'slave.released',
      workspaceId: 'w1',
      slaveId: 's9',
      actor: 'system',
      payload: { slaveId: 's9', name: 'Robin', reason: 'the engagement is over' },
    })
    expect(parsed.ok).toBe(false)
  })

  it('accepts org.changed on the lifecycle field', () => {
    const parsed = parseExecutionEvent({
      type: 'org.changed',
      workspaceId: 'w1',
      slaveId: 's9',
      actor: 'human',
      payload: { entity: 'slave', id: 's9', field: 'lifecycle', from: 'ephemeral', to: 'project' },
    })
    expect(parsed.ok).toBe(true)
  })

  it('accepts a worktree collected because a worker was released', () => {
    const parsed = parseExecutionEvent({
      type: 'task.worktree_collected',
      workspaceId: 'w1',
      taskId: 't1',
      actor: 'system',
      payload: { path: '/tmp/wt', reason: 'released', branch: 'feature/auth' },
    })
    expect(parsed.ok).toBe(true)
  })
```

(Match the envelope's required keys to whatever the neighbouring cases in that file already pass — copy one and change the `type`/`payload`.)

`packages/domain/test/supervisor/timeline.test.ts` — the pin moves from 52 to 53:

```ts
  it('carries the 53 members the schema has today -- a fifty-fourth is a deliberate decision', () => {
    expect(Object.keys(LANE_BY_TYPE)).toHaveLength(53)
  })
```

- [ ] **Step 17: Run them and watch them fail**

Run: `npx vitest run packages/domain/test/events packages/domain/test/supervisor/timeline.test.ts`
Expected: FAIL — the four parses return `ok: false` (no such arm), and `LANE_BY_TYPE` has 52 keys.

- [ ] **Step 18: Add the event, widen the two unions, and give it a lane**

`packages/domain/src/events/schema.ts` — `task.worktree_collected`'s reason (erratum E5):

```ts
  // M23 B2: `collectTaskWorktree` removed a terminal task's worktree. M50 R3 adds the third reason:
  // a WORKER was released and the trees its runs were holding went with the engagement.
  z.object({
    ...envelope,
    type: z.literal('task.worktree_collected'),
    payload: z.object({ path: z.string().min(1), reason: z.enum(['aged', 'operator', 'released']), branch: z.string().nullable() }),
  }),
```

`org.changed`'s field (erratum E11):

```ts
      /** `capabilities` is M47 t2's … `lifecycle` is M50 R4's: a PERSON moved a worker between
       *  `permanent`, `project` and `ephemeral`. `from`/`to` are the lifecycle values. */
      field: z.enum(['name', 'role', 'model', 'deleted', 'created', 'team', 'capabilities', 'lifecycle']),
```

and the new arm, at the foot of the union beside M49's two:

```ts
  // M50 R3: an EPHEMERAL worker's one assignment ended and the worker was released. Its runtime
  // roles are empty, its terminal tasks' worktrees are gone from disk, and NOTHING else moved --
  // every run, context, checkpoint, message and memory it produced is exactly where it was. This is
  // deliberately not `org.changed { field: 'deleted' }`: that event means a row went away, and this
  // one means a person's engagement here finished. `worktreesCollected` is what the release
  // actually managed to remove, which can be fewer than the worker's terminal tasks -- a tree a
  // `git worktree remove` refused is skipped, never retried, and never a failed release.
  z.object({
    ...envelope,
    type: z.literal('slave.released'),
    payload: z.object({
      slaveId: z.string().min(1),
      name: z.string().min(1),
      reason: z.string().min(1),
      worktreesCollected: z.number().int().nonnegative(),
    }),
  }),
```

`packages/domain/src/supervisor/timeline.ts` — in the WORK IN PROGRESS block:

```ts
  'slave.message_sent': 'work',
  // M50 R3: the end of one worker's engagement is part of the work story, beside the messages and
  // the pauses -- who was here, and until when. Not `decision`: the Supervisor applies this
  // routinely, and the decision lane is for what a person still has to answer.
  'slave.released': 'work',
```

- [ ] **Step 19: Add the Prisma enum, the five columns and the migration**

`packages/db/prisma/schema.prisma` — the new enum, beside `ProviderKind`'s neighbourhood (immediately above `model Slave`):

```prisma
/// M50 R1: why a worker exists -- the closed set `SLAVE_LIFECYCLES` in
/// `packages/domain/src/lifecycle/types.ts` mirrors, pinned member-for-member by
/// `packages/db/test/integration/enum-parity.test.ts`.
enum SlaveLifecycle {
  /// Materialised from a company roster row: this worker exists in the organisation.
  permanent
  /// Hired for this project.
  project
  /// Brought in for ONE assignment (`engagementTaskId`), and released when it is over.
  ephemeral
}
```

The five columns, after `profile` and before the relation block:

```prisma
  /// M50 R1: WHY this worker exists, written at the creation site and never derived. Until this
  /// milestone three surfaces each read `companySlaveId === null ? 'project' : 'company'` for
  /// themselves, and none of them could say "this one is temporary" because no column held the
  /// fact. `assignCompanyTx` and `materialiseCompanySlave` write `permanent`; `hireFromTemplate`
  /// writes `project`, or `ephemeral` with an `engagementTaskId` when the Supervisor asked for one
  /// assignment. `@default(project)` is the honest default for a hand-made row -- the migration's
  /// one data statement corrects the roster-linked ones, which the default would call project
  /// hires.
  lifecycle          SlaveLifecycle @default(project)
  /// M50 R2: the ONE assignment an `ephemeral` worker was brought in for -- what `engagement_over`
  /// measures the end of the engagement against. `onDelete: SetNull`, the rule `companySlaveId` and
  /// `hiredFromTemplateId` already follow: a worker with run history must survive the deletion of
  /// the task it was hired for. NULL on every other lifecycle.
  engagementTaskId   String?
  /// M50 R3: when the engagement ended. NULL is "still engaged". A released worker keeps every row
  /// it ever wrote and holds no runtime roles -- that empty set is what stops `decide()` picking
  /// it, and there is no second filter anywhere.
  releasedAt         DateTime?
  /// M50 R3: the sentence the release was recorded with -- the Supervisor's own situation summary,
  /// or an operator's `--reason`.
  releaseReason      String?
  /// M50 R1: when this worker joined the project. Every row that predates this milestone reads back
  /// the migration's own timestamp, which is the only honest answer a table with no history can
  /// give -- and is why no surface presents it as a hire date.
  createdAt          DateTime @default(now())
```

the relation and the index:

```prisma
  hiredFromTemplate SlaveTemplate? @relation("HiredWorkers", fields: [hiredFromTemplateId], references: [id], onDelete: SetNull)
  engagementTask    Task?          @relation("EngagementWorkers", fields: [engagementTaskId], references: [id], onDelete: SetNull)
```

```prisma
  @@index([teamId])
  /// M50 R3: `engagement_over`'s own read -- "which workers were brought in for this task".
  @@index([engagementTaskId])
```

`model Task` gains the back-relation beside `memories`:

```prisma
  /// M50 R2: the temporary specialists brought in for THIS task. SetNull on the other side -- a
  /// worker outlives the task it was hired for.
  engagedWorkers Slave[] @relation("EngagementWorkers")
```

`enum SupervisorSituationKind` gains, between `done_not_integrated_stale` and `memory_candidates_piling`:

```prisma
  /// M50 R3: a worker brought in for one assignment, whose assignment is over. The subject is the
  /// SLAVE.
  engagement_over
```

`enum EventType` gains, at the foot:

```prisma
  /// M50 R3: an ephemeral worker's engagement ended -- runtime roles emptied, worktrees collected,
  /// and everything it produced left where it is. Never a deletion: `org.changed { field:
  /// 'deleted' }` is that, and this is not it.
  slave_released              @map("slave.released")
```

`packages/db/prisma/migrations/20260912120000_m50_lifecycle/migration.sql`:

```sql
-- M50 R1-R3: the worker lifecycle.
--
-- Additive, plus the ONE data statement R1 allows. Nothing else is backfilled: `createdAt` reads
-- back the moment this migration ran for every existing row, which is the only honest answer a
-- table that never recorded a hire date can give.

CREATE TYPE "SlaveLifecycle" AS ENUM ('permanent', 'project', 'ephemeral');

ALTER TABLE "Slave" ADD COLUMN "lifecycle"        "SlaveLifecycle" NOT NULL DEFAULT 'project';
ALTER TABLE "Slave" ADD COLUMN "engagementTaskId" TEXT;
ALTER TABLE "Slave" ADD COLUMN "releasedAt"       TIMESTAMP(3);
ALTER TABLE "Slave" ADD COLUMN "releaseReason"    TEXT;
ALTER TABLE "Slave" ADD COLUMN "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Slave_engagementTaskId_idx" ON "Slave"("engagementTaskId");

ALTER TABLE "Slave" ADD CONSTRAINT "Slave_engagementTaskId_fkey"
    FOREIGN KEY ("engagementTaskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- THE ONE DATA STATEMENT (R1). A roster-linked worker EXISTS in the company roster, which is what
-- `permanent` means; the column default above would call every one of them a project hire, and the
-- Organization view would then say something false about workers nobody hired. Deterministic and
-- idempotent by construction: a constant written over a predicate the statement does not itself
-- change, so a second run writes the same rows to the same value.
UPDATE "Slave" SET "lifecycle" = 'permanent' WHERE "companySlaveId" IS NOT NULL;

-- M47 plan erratum E4's idiom: a situation kind is a Postgres enum member too.
ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'engagement_over';

-- The 53rd event type. The VALUE is the dotted `@map` string, never the Prisma member name (M48
-- plan erratum E5); the idiom is `20260818201422_widen_event_type_for_m3`.
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'slave.released';
```

`packages/db/src/enums.ts` — one entry at the foot of `EVENT_TYPE_BY_DOMAIN_TYPE`:

```ts
  'memory.changed': 'memory_changed',
  'slave.released': 'slave_released',
```

`packages/db/src/seed.ts` — the legacy worker says what it is rather than leaning on the default (R1), the same reason `runtimeRoles` is written there explicitly:

```ts
    await prisma.slave.create({
      data: { teamId, name: member.slaveName, role: member.role, runtimeRoles: [member.role], lifecycle: 'project' },
    })
```

`packages/db/test/integration/enum-parity.test.ts` — one assertion, importing `SLAVE_LIFECYCLES` from `@slave-of-ai/domain`:

```ts
  // M50 R1: the lifecycle enum. Same reason as the Supervisor's four and M49's -- nothing in
  // TypeScript ties a Prisma enum to the domain union it mirrors, and a missing member fails at the
  // first INSERT rather than at build.
  it('SlaveLifecycle matches SLAVE_LIFECYCLES, member for member', async () => {
    expect(await enumValues('SlaveLifecycle')).toEqual([...SLAVE_LIFECYCLES].sort())
  })
```

- [ ] **Step 20: Apply the migration to both databases and prove the schema and the migrations agree**

```bash
npm run db:generate
npm run db:migrate
npm run db:migrate:test
npx tsc --build
npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
```
Expected: the last command prints **"No difference detected"**. If it names the index or the foreign key, the migration SQL and `schema.prisma` disagree — fix the SQL, never the schema.

Then prove the one data statement did what R1 says, against the dev database:

```bash
node -e "const {prisma}=require('./packages/db/dist/client.js');prisma.slave.groupBy({by:['lifecycle'],_count:{_all:true}}).then(r=>{console.log(r);return prisma.slave.count({where:{companySlaveId:{not:null},lifecycle:{not:'permanent'}}})}).then(n=>{console.log('roster workers not permanent:',n);process.exit(n===0?0:1)})"
```
Expected: the counts print and the last line is `roster workers not permanent: 0`.

- [ ] **Step 21: Close the four exhaustive web sites the new members widen**

These are `apps/web` files and they are in THIS task because `npm run --silent typecheck` is red without them — the M49 precedent for a web file that is exhaustive over a domain union.

`apps/web/src/lib/activityFilters.ts` — `TYPES_BY_KIND.workspace` gains one entry, beside the two M49 added:

```ts
    'memory.recorded',
    'memory.changed',
    // M50 t1: a worker's engagement ending is a change to the project's roster, the same chip
    // `org.changed` and `slave.runtime_roles_changed` sit under -- not a run outcome, and it
    // carries no taskId of its own.
    'slave.released',
```

`apps/web/src/components/activity/cards.tsx` — the collect reason (erratum E5), the label map and the card's cast (erratum E11), and the new card:

```ts
  const payload = props.event.payload as { path: string; reason: 'aged' | 'operator' | 'released'; branch: string | null }
```

```ts
const ORG_CHANGED_LABEL: Record<
  'name' | 'role' | 'model' | 'deleted' | 'created' | 'team' | 'capabilities' | 'lifecycle',
  string
> = {
  name: 'renamed',
  role: 'role changed',
  model: 'model changed',
  deleted: 'deleted',
  created: 'created',
  team: 'moved to department',
  // M47: a hire REUSED this worker and merged capability keys into it.
  capabilities: 'capabilities changed',
  // M50 R4: a person moved this worker between permanent, project and ephemeral. Nothing else can.
  lifecycle: 'lifecycle changed',
}
```

```ts
    field: 'name' | 'role' | 'model' | 'deleted' | 'created' | 'team' | 'capabilities' | 'lifecycle'
```

```tsx
/** M50 R3: a temporary specialist's engagement ended. `idle` tone, for `TaskWorktreeCollectedCard`'s
 *  reason -- this is the organisation tidying up after work that already concluded, not a new
 *  outcome. The count says what was actually removed from disk; the worker's own rows are all
 *  still there, which is the whole ruling. */
function SlaveReleasedCard(props: ActivityCardProps): ReactElement {
  const payload = props.event.payload as {
    slaveId: string
    name: string
    reason: string
    worktreesCollected: number
  }
  return (
    <ActivityCard {...props}>
      <Transition tone="idle" label="released">
        <span data-testid="released-name">{payload.name}</span>
        {' · '}
        <span data-testid="released-reason">{payload.reason}</span>
        {' · '}
        <span data-testid="released-worktrees">{plural(payload.worktreesCollected, 'worktree')} collected</span>
      </Transition>
    </ActivityCard>
  )
}
```

and the registry gains `'slave.released': SlaveReleasedCard,` at its foot. (`plural` is already imported in this file — `OrgChangedCard` uses it.)

`apps/web/src/server/timeline.ts` — the sentence, beside M49's two:

```ts
    // M50 R3: a temporary specialist's engagement ended. The payload carries no `title`, so without
    // a case of its own this would read as its own type name on the WORK lane.
    case 'slave.released': {
      const name = payload['name']
      const who = typeof name === 'string' && name !== '' ? name : 'a temporary specialist'
      const reason = payload['reason']
      return typeof reason === 'string' && reason !== '' ? `released ${who}: ${reason}` : `released ${who}`
    }
```

`apps/web/src/components/SupervisorPanel.tsx` — `actionText`'s fifteenth arm, before `escalate_to_human`:

```ts
    // M50 R3: the NAME, off the action -- this function runs in the browser and has no roster to
    // look a slave id up in, exactly as it has no taxonomy for `capabilityLabel` above.
    case 'release_worker':
      return `release ${action.name}: their one assignment is over`
```

`apps/web/test/activity-cards.test.tsx` — `PAYLOAD_BY_TYPE` gains one entry and the file one case:

```ts
  'slave.released': { slaveId: 'ag-9', name: 'Robin', reason: 'the engagement is over', worktreesCollected: 1 },
```

```tsx
  it('names the released worker, why, and what was collected', () => {
    const Card = ACTIVITY_CARDS['slave.released']
    render(<Card event={fixtureFor('slave.released')} {...CARD_PROPS} />)
    expect(screen.getByTestId('released-name').textContent).toBe('Robin')
    expect(screen.getByTestId('released-reason').textContent).toBe('the engagement is over')
    expect(screen.getByTestId('released-worktrees').textContent).toBe('1 worktree collected')
  })
```

- [ ] **Step 22: Run the whole ladder for this task**

```bash
npx vitest run packages/domain packages/db
npx vitest run apps/web/test/activity-cards.test.tsx
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: every domain and db test green (`enum-parity.test.ts` included — that is what Step 20's `db:migrate:test` was for); the card test green; the vocabulary gate prints its PASSED line; `typecheck` is silent, which is what proves `ACTIVITY_CARDS`, `TYPES_BY_KIND`, `actionText`, `ORG_CHANGED_LABEL` and `SITUATION_LABEL` were not forgotten.

- [ ] **Step 23: Commit**

```bash
git add packages/domain packages/db apps/web/src/lib apps/web/src/components apps/web/src/server/timeline.ts apps/web/test/activity-cards.test.tsx
git commit -m "$(cat <<'EOF'
feat(domain,db): m50 t1 — a worker's lifecycle is a column, and one assignment is a rule

`SLAVE_LIFECYCLES` and one enum replace the `companySlaveId === null` reading three surfaces each
made for themselves, and five columns on `Slave` say why a worker is here, what one assignment it
was brought in for, and when that engagement ended. `formTeam` asks the new question -- is this gap
exactly one startable task's? -- off a `requiredBy` map `teamPlanOf` builds in the same pass as the
gap itself, so the two can never be measured over different tasks; a pick covering two capabilities
one task needs is still one assignment, and two tasks make a seat. The fifteenth situation is the
first whose subject is a worker, the fifteenth action is the routine the milestone exists for, and
the 53rd event takes its place at all nine exhaustive sites. The migration is additive plus the one
data statement R1 allows, which is a constant over a predicate it does not change.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 2: The two verbs that write a lifecycle, the four creation sites, the third collect reason and the Supervisor's arm (R1–R5, E6, E9, E13, D3, D4, D10, D11)

**Files:**
- Create: `packages/control/src/lifecycle.ts`, `packages/control/test/integration/lifecycle.test.ts`
- Modify: `packages/control/src/index.ts`, `packages/control/src/refusal.ts`, `packages/control/src/capability.ts`, `packages/control/src/org.ts`, `packages/control/src/collect.ts`, `packages/control/src/supervisor.ts`, `packages/control/src/supervisorWorld.ts`, `apps/web/test/refusal-status.test.ts`
- Test: `packages/control/test/integration/lifecycle.test.ts`, `packages/control/test/integration/capability.test.ts`, `packages/control/test/integration/org.test.ts`, `packages/control/test/integration/supervisor.test.ts`, `apps/web/test/refusal-status.test.ts`

**Interfaces:**
- Consumes from Task 1: `SLAVE_LIFECYCLES`, `SlaveLifecycle`, `isReleasable`, the `release_worker` action arm, `hire_from_catalog.engagementTaskId`, the `slave.released` event, `org.changed.field 'lifecycle'`, `task.worktree_collected.reason 'released'`, `SupervisorSlave.lifecycle/engagementTaskId/released`, `SupervisorTask.assigneeId` (`@slave-of-ai/domain`); `appendEvent` (`@slave-of-ai/events`); `lockSlave` (`./org.js`); `liveRunCount` (`./workspace.js`); `collectTaskWorktree` (`./collect.js`); `TERMINAL` (`@slave-of-ai/domain`).
- Produces, for Tasks 3–5:
  - `releaseWorker(slaveId: string, reason: string, principal?: Principal): Promise<Result<{ worktreesCollected: number }, ControlRefusal>>`
  - `setLifecycle(slaveId: string, lifecycle: SlaveLifecycle, principal?: Principal): Promise<Result<{ from: SlaveLifecycle; to: SlaveLifecycle }, ControlRefusal>>`
  - `hireFromTemplate(workspaceId, templateId, opts: { capabilities?: readonly string[]; rationale: string; temporary?: boolean; engagementTaskId?: string | null })` — unchanged return shape
  - `collectTaskWorktree(taskId: string, reason: 'aged' | 'operator' | 'released', principal?: Principal)`
  - `OrganizationWorker.lifecycle: SlaveLifecycle` and `.released: { at: string; reason: string } | null` (replacing `.kind`)
  - Refusal kinds `not_ephemeral`, `already_released`, `not_in_roster`

- [ ] **Step 1: Write the failing tests for the two verbs**

`packages/control/test/integration/lifecycle.test.ts`. Build the fixtures with the helpers this package's other integration files already use (`packages/control/test/integration/capability.test.ts` has a workspace-plus-team-plus-slave seed — copy its shape, including its `afterAll` teardown in FK order):

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { releaseWorker, setLifecycle } from '../../src/lifecycle.js'

describe('releaseWorker', () => {
  it('empties the runtime roles, stamps the release, and keeps every row the worker wrote', async () => {
    const { workspaceId, slaveId, taskId, runId } = await seedEngagement({ taskStatus: 'done' })

    const result = await releaseWorker(slaveId, 'the engagement is over')
    expect(result.ok).toBe(true)

    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
    expect(after.runtimeRoles).toEqual([])
    expect(after.releasedAt).not.toBeNull()
    expect(after.releaseReason).toBe('the engagement is over')
    // R5: nothing else moved.
    expect(after.lifecycle).toBe('ephemeral')
    expect(after.engagementTaskId).toBe(taskId)
    expect(after.capabilities).toEqual(['security.application'])
    expect(after.selectionRationale).not.toBeNull()
    expect(after.hiredFromTemplateId).not.toBeNull()
    expect(await prisma.slaveRun.count({ where: { slaveId } })).toBe(1)
    expect(await prisma.slaveRun.findUniqueOrThrow({ where: { id: runId } })).toBeDefined()

    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId, type: 'slave_released' },
      orderBy: { seq: 'desc' },
    })
    expect(event.payload).toMatchObject({ slaveId, reason: 'the engagement is over' })
  })

  it('refuses a worker that is not ephemeral', async () => {
    const { slaveId } = await seedEngagement({ taskStatus: 'done', lifecycle: 'project' })
    const result = await releaseWorker(slaveId, 'no')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('not_ephemeral')
  })

  it('refuses a second release, and writes nothing the second time', async () => {
    const { slaveId } = await seedEngagement({ taskStatus: 'done' })
    expect((await releaseWorker(slaveId, 'first')).ok).toBe(true)
    const second = await releaseWorker(slaveId, 'second')
    expect(second.ok).toBe(false)
    expect(second.ok ? null : second.error.kind).toBe('already_released')
    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
    expect(after.releaseReason).toBe('first')
  })

  it('refuses while a run is live, and leaves the roles alone', async () => {
    const { slaveId } = await seedEngagement({ taskStatus: 'done', runStatus: 'working' })
    const result = await releaseWorker(slaveId, 'no')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('live_runs')
    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
    expect(after.runtimeRoles).toEqual(['security'])
  })

  it('refuses a worker that is gone', async () => {
    const result = await releaseWorker('00000000-0000-0000-0000-000000000000', 'no')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('slave_not_found')
  })

  it('counts only the worktrees it could actually collect, and never throws for one it could not', async () => {
    // The run carries a path that is not a worktree of this repository, so `git worktree remove`
    // refuses and `collectTaskWorktree` returns `worktree_remove_failed`. The release still stands.
    const { slaveId } = await seedEngagement({ taskStatus: 'done', worktreePath: '/nonexistent/m50-gate-tree' })
    const result = await releaseWorker(slaveId, 'the engagement is over')
    expect(result.ok).toBe(true)
    expect(result.ok ? result.value.worktreesCollected : -1).toBe(0)
    expect((await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })).releasedAt).not.toBeNull()
  })
})

describe('setLifecycle', () => {
  it('moves ephemeral to project, clearing the engagement and the release with it', async () => {
    const { workspaceId, slaveId } = await seedEngagement({ taskStatus: 'done' })
    expect((await releaseWorker(slaveId, 'over')).ok).toBe(true)

    const result = await setLifecycle(slaveId, 'project')
    expect(result.ok).toBe(true)
    const after = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
    expect(after.lifecycle).toBe('project')
    expect(after.engagementTaskId).toBeNull()
    expect(after.releasedAt).toBeNull()
    expect(after.releaseReason).toBeNull()
    // R4: nothing is restored. The person sets the roles.
    expect(after.runtimeRoles).toEqual([])

    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId, type: 'org_changed' },
      orderBy: { seq: 'desc' },
    })
    expect(event.payload).toMatchObject({ entity: 'slave', field: 'lifecycle', from: 'ephemeral', to: 'project' })
  })

  it('refuses permanent for a worker with no roster row', async () => {
    const { slaveId } = await seedEngagement({ taskStatus: 'done' })
    const result = await setLifecycle(slaveId, 'permanent')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('not_in_roster')
  })

  it('refuses while a run is live', async () => {
    const { slaveId } = await seedEngagement({ taskStatus: 'done', runStatus: 'working' })
    const result = await setLifecycle(slaveId, 'project')
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('live_runs')
  })

  it('writes no event when the lifecycle did not move', async () => {
    const { workspaceId, slaveId } = await seedEngagement({ taskStatus: 'done' })
    const before = await prisma.executionEvent.count({ where: { workspaceId, type: 'org_changed' } })
    expect((await setLifecycle(slaveId, 'ephemeral')).ok).toBe(true)
    expect(await prisma.executionEvent.count({ where: { workspaceId, type: 'org_changed' } })).toBe(before)
  })
})
```

`seedEngagement` is this file's own helper, written directly above the describes:

```ts
/**
 * A project with one task, one template, one ephemeral worker hired for that task, and one run on
 * it. Every knob is a fact one of the cases above is about; the defaults are the ordinary
 * "assignment finished, worker idle" shape.
 */
async function seedEngagement(opts: {
  readonly taskStatus: 'done' | 'running'
  readonly lifecycle?: 'project' | 'ephemeral'
  readonly runStatus?: 'succeeded' | 'working'
  readonly worktreePath?: string | null
}): Promise<{ workspaceId: string; slaveId: string; taskId: string; runId: string }> {
  const workspace = await prisma.workspace.create({
    data: { name: `m50 lifecycle ${String(Date.now())}-${String(Math.random()).slice(2, 8)}`, repoPath: '/tmp/m50-lifecycle', maxAttempts: 3 },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Specialists' } })
  const template = await prisma.slaveTemplate.create({
    data: { name: `M50 Security ${String(Date.now())}-${String(Math.random()).slice(2, 8)}`, role: 'security', capabilityKeys: ['security.application'] },
  })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add authentication', description: 'the one assignment', status: opts.taskStatus, maxAttempts: 3, requiredRole: 'security' },
  })
  const slave = await prisma.slave.create({
    data: {
      teamId: team.id,
      name: 'Robin',
      role: 'Security Reviewer',
      runtimeRoles: ['security'],
      capabilities: ['security.application'],
      selectionRationale: 'brought in for the authentication path',
      hiredFromTemplateId: template.id,
      lifecycle: opts.lifecycle ?? 'ephemeral',
      engagementTaskId: task.id,
    },
  })
  const run = await prisma.slaveRun.create({
    data: {
      taskId: task.id,
      slaveId: slave.id,
      kind: 'implementation',
      status: opts.runStatus ?? 'succeeded',
      worktreePath: opts.worktreePath === undefined ? null : opts.worktreePath,
    },
  })
  return { workspaceId: workspace.id, slaveId: slave.id, taskId: task.id, runId: run.id }
}
```

Teardown: an `afterAll` that deletes this file's rows in FK order — `executionEvent`, `slaveRun`, `task`, `slave`, `team`, `workspace`, `slaveTemplate` — scoped by the `m50 lifecycle`/`M50 Security` name prefixes, exactly as `capability.test.ts` scopes its own.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run packages/control/test/integration/lifecycle.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/lifecycle.js"`.

- [ ] **Step 3: Add the three refusal kinds, in all three homes**

`packages/control/src/refusal.ts` — the union, beside the other slave-shaped kinds near `slave_not_found` (`:165`):

```ts
  /** `releaseWorker` (M50 R3): the worker is not `ephemeral`, and only a specialist brought in for
   *  ONE assignment is released. A project worker leaves by `deleteSlave` (M23) and a roster worker
   *  by leaving the roster; neither is this verb's business. 409, not 404: the worker is right
   *  there and the answer is about what it IS. */
  | { readonly kind: 'not_ephemeral'; readonly slaveId: string; readonly lifecycle: string }
  /** `releaseWorker` (M50 R3): this engagement is already over. Nothing is released twice -- the row
   *  keeps the timestamp and the sentence the first release wrote. */
  | { readonly kind: 'already_released'; readonly slaveId: string; readonly at: string }
  /** `setLifecycle` (M50 R4): `permanent` MEANS "exists in the company roster", and this worker has
   *  no roster row to exist in. A label a person could apply anyway would make the word a
   *  decoration. */
  | { readonly kind: 'not_in_roster'; readonly slaveId: string }
```

`refusalText`'s exhaustive switch, beside `slave_not_found`'s arm (`:454`):

```ts
    case 'not_ephemeral':
      return `slave ${refusal.slaveId} is a ${refusal.lifecycle} worker, not a specialist brought in for one assignment; only an ephemeral worker is released`
    case 'already_released':
      return `slave ${refusal.slaveId} was already released at ${refusal.at}`
    case 'not_in_roster':
      return `slave ${refusal.slaveId} is on no company roster, so it cannot be made permanent; assign it from a company first`
```

`apps/web/test/refusal-status.test.ts` — three entries in `ALL_KINDS`, alphabetically placed among their neighbours:

```ts
  already_released: true,
  not_ephemeral: true,
  not_in_roster: true,
```

The file's own `it('maps every kind in the taxonomy to 404 iff it ends in _not_found, 409 otherwise')` then covers all three with no new case: none of them ends in `_not_found`, so all three are 409, which is what R3 and R4 ask for.

- [ ] **Step 4: Write the two verbs**

`packages/control/src/lifecycle.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { TERMINAL, err, ok, type Result, type SlaveLifecycle } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { collectTaskWorktree } from './collect.js'
import { lockSlave } from './org.js'
import type { Principal } from './principal.js'
import { refusalText, type ControlRefusal } from './refusal.js'
import { liveRunCount } from './workspace.js'

/** How much of a release reason is stored. The three callers all supply a sentence -- the
 *  Supervisor's own situation summary, an operator's `--reason`, the route's `z.string().min(1)` --
 *  so this is a cap, not a validation (plan decision D4). */
const RELEASE_REASON_MAX = 500

/**
 * The end of one worker's engagement (M50 R3). NEVER a deletion.
 *
 * Four refusals, every one of them returned BEFORE the first write in the transaction, so all four
 * are values rather than thrown rollbacks: the worker is gone, the worker is not `ephemeral`, the
 * engagement is already over, or a run is still live.
 *
 * What it writes is exactly four columns: `releasedAt`, `releaseReason`, and `runtimeRoles = []`.
 * That empty set is the WHOLE of how a released worker stops being dispatched -- `decide()` is
 * untouched by this milestone and `loadSlaveRows` still loads every row in the workspace, because a
 * second filter would be a second rule to keep in step with the first (spec R3). Everything else
 * the worker has is left: its capabilities are what it did here, its rationale is why it came, and
 * its runs, contexts, checkpoints, messages and memories are the record (R5).
 *
 * The worktrees are collected AFTER the transaction commits, one `collectTaskWorktree` call per
 * terminal task, each inside its own `try` (plan decision D10). Two reasons, and both matter:
 * `collectTaskWorktree` opens its own transaction and the two must never nest (ADR 0003), and this
 * verb is carried out by a TICK -- `tierOf` makes `release_worker` `applied` -- so a tree `git`
 * refused to remove must be a line in the log and a number in the payload, never an exception out
 * of the Supervisor's apply path.
 */
export async function releaseWorker(
  slaveId: string,
  reason: string,
  principal?: Principal,
): Promise<Result<{ readonly worktreesCollected: number }, ControlRefusal>> {
  const recorded = reason.slice(0, RELEASE_REASON_MAX)

  const plan = await prisma.$transaction(async (tx) => {
    const slave = await lockSlave(tx, slaveId)
    if (slave === null) return { refusal: { kind: 'slave_not_found', slaveId } as ControlRefusal }
    if (slave.lifecycle !== 'ephemeral') {
      return { refusal: { kind: 'not_ephemeral', slaveId, lifecycle: slave.lifecycle } as ControlRefusal }
    }
    if (slave.releasedAt !== null) {
      return { refusal: { kind: 'already_released', slaveId, at: slave.releasedAt.toISOString() } as ControlRefusal }
    }
    const live = await liveRunCount(tx, { slaveId })
    if (live > 0) {
      return { refusal: { kind: 'live_runs', entity: 'slave', id: slaveId, runs: live } as ControlRefusal }
    }

    await tx.slave.update({
      where: { id: slaveId },
      data: { releasedAt: new Date(), releaseReason: recorded, runtimeRoles: [] },
    })

    // The tasks whose worktrees this worker's runs are still holding: terminal, with a path on the
    // row. Read inside the lock so the list cannot grow under the release; collected outside it.
    const runs = await tx.slaveRun.findMany({
      where: { slaveId, worktreePath: { not: null }, task: { status: { in: [...TERMINAL] } } },
      select: { taskId: true },
      orderBy: { id: 'asc' },
    })
    return {
      workspaceId: slave.team.workspaceId,
      name: slave.name,
      taskIds: [...new Set(runs.flatMap((run) => (run.taskId === null ? [] : [run.taskId])))],
    }
  })
  if ('refusal' in plan) return err(plan.refusal)

  let worktreesCollected = 0
  for (const taskId of plan.taskIds) {
    try {
      const collected = await collectTaskWorktree(taskId, 'released', principal)
      if (collected.ok) worktreesCollected += 1
      else console.warn(`releaseWorker: leaving task ${taskId}'s worktree in place: ${refusalText(collected.error)}`)
    } catch (error) {
      console.warn(
        `releaseWorker: leaving task ${taskId}'s worktree in place: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  await appendEvent({
    type: 'slave.released',
    workspaceId: plan.workspaceId,
    slaveId,
    // A person released this only when a person asked. The Supervisor's routine apply passes no
    // principal, and `system` is what the timeline should say about it.
    actor: principal === undefined ? 'system' : 'human',
    payload: { slaveId, name: plan.name, reason: recorded, worktreesCollected },
    userId: principal?.userId ?? null,
  })

  return ok({ worktreesCollected })
}

/**
 * A person moves a worker between lifecycles (M50 R4). The ONLY path that changes the column after
 * creation: nothing promotes a worker automatically, and a tick that did would be the Supervisor
 * deciding who works here.
 *
 * Human-only by construction (plan decision D11): no `origin`, no `carryOut` arm, no Supervisor
 * action, `actor: 'human'` on the event -- the shape `renameSlave` and `setSlaveRole` already have.
 *
 * Leaving `ephemeral` clears the engagement AND the release with it: a worker that is no longer
 * temporary has no one assignment to be over, and a `releasedAt` left behind would keep it off every
 * roster while its lifecycle said it belonged there. Nothing is restored -- the runtime roles are a
 * person's own call through `set-runtime-roles`, which is exactly what R4 says.
 */
export async function setLifecycle(
  slaveId: string,
  lifecycle: SlaveLifecycle,
  principal?: Principal,
): Promise<Result<{ readonly from: SlaveLifecycle; readonly to: SlaveLifecycle }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    const slave = await lockSlave(tx, slaveId)
    if (slave === null) return { refusal: { kind: 'slave_not_found', slaveId } as ControlRefusal }
    const live = await liveRunCount(tx, { slaveId })
    if (live > 0) {
      return { refusal: { kind: 'live_runs', entity: 'slave', id: slaveId, runs: live } as ControlRefusal }
    }
    // `permanent` is not a label somebody may apply: it MEANS "this worker exists in the company
    // roster", and the roster link is the only thing that can say so.
    if (lifecycle === 'permanent' && slave.companySlaveId === null) {
      return { refusal: { kind: 'not_in_roster', slaveId } as ControlRefusal }
    }
    const from = slave.lifecycle
    if (from === lifecycle) return { workspaceId: slave.team.workspaceId, from, changed: false as const }
    await tx.slave.update({
      where: { id: slaveId },
      data: {
        lifecycle,
        ...(from === 'ephemeral' ? { engagementTaskId: null, releasedAt: null, releaseReason: null } : {}),
      },
    })
    return { workspaceId: slave.team.workspaceId, from, changed: true as const }
  })
  if ('refusal' in outcome) return err(outcome.refusal)

  if (outcome.changed) {
    await appendEvent({
      type: 'org.changed',
      workspaceId: outcome.workspaceId,
      slaveId,
      actor: 'human',
      payload: { entity: 'slave', id: slaveId, field: 'lifecycle', from: outcome.from, to: lifecycle },
      userId: principal?.userId ?? null,
    })
  }

  return ok({ from: outcome.from, to: lifecycle })
}
```

`packages/control/src/index.ts` — one line, after `./capability.js`:

```ts
export * from './lifecycle.js'
```

- [ ] **Step 5: Add the third collect reason and fix the actor**

`packages/control/src/collect.ts` — the signature (erratum E5):

```ts
export async function collectTaskWorktree(
  taskId: string,
  reason: 'aged' | 'operator' | 'released',
  principal?: Principal,
): Promise<Result<{ path: string }, ControlRefusal>> {
```

and the actor line (erratum E6):

```ts
  await appendEvent({
    type: 'task.worktree_collected',
    workspaceId: task.workspace.id,
    taskId,
    // M50 R3/E6: `operator` is the only one a PERSON causes. `aged` is the daemon's sweep and
    // `released` is a Supervisor apply -- reading the reason the other way round would record
    // every release-time collection as somebody's button press.
    actor: reason === 'operator' ? 'human' : 'system',
    payload: { path, reason, branch: task.branch },
    userId: principal?.userId ?? null,
  })
```

- [ ] **Step 6: Run the lifecycle tests and watch them pass**

Run: `npx vitest run packages/control/test/integration/lifecycle.test.ts`
Expected: PASS, 10 tests. The `worktreesCollected: 0` case prints one `releaseWorker: leaving task …` warning — expected output, not a failure.

- [ ] **Step 7: Write the failing tests for the creation sites and the reuse rule**

`packages/control/test/integration/capability.test.ts` — four cases added to its `hireFromTemplate` and `materialiseCompanySlave` describes:

```ts
  it('writes lifecycle project for an ordinary hire, and no engagement', async () => {
    const result = await hireFromTemplate(workspaceId, templateId, { rationale: 'needed here' })
    expect(result.ok).toBe(true)
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: result.ok ? result.value.slaveId : '' } })
    expect(worker.lifecycle).toBe('project')
    expect(worker.engagementTaskId).toBeNull()
    // M50 R1: the rationale is the SENTENCE, and nothing else. The column is the record now.
    expect(worker.selectionRationale).toBe('needed here')
  })

  it('writes lifecycle ephemeral and the engagement for a temporary hire', async () => {
    const result = await hireFromTemplate(workspaceId, templateId, {
      rationale: 'one assignment',
      temporary: true,
      engagementTaskId: taskId,
    })
    expect(result.ok).toBe(true)
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: result.ok ? result.value.slaveId : '' } })
    expect(worker.lifecycle).toBe('ephemeral')
    expect(worker.engagementTaskId).toBe(taskId)
    // The suffix is gone (R1): a column holds the fact, so the sentence stays the sentence.
    expect(worker.selectionRationale).toBe('one assignment')
  })

  it('refuses a temporary hire whose assignment is not a task of this project', async () => {
    const result = await hireFromTemplate(workspaceId, templateId, {
      rationale: 'one assignment',
      temporary: true,
      engagementTaskId: '00000000-0000-0000-0000-000000000000',
    })
    expect(result.ok).toBe(false)
    expect(result.ok ? null : result.error.kind).toBe('task_not_found')
  })

  it('reuses an unreleased hire and never rewrites its lifecycle', async () => {
    const first = await hireFromTemplate(workspaceId, templateId, { rationale: 'needed here' })
    const second = await hireFromTemplate(workspaceId, templateId, {
      rationale: 'one assignment',
      temporary: true,
      engagementTaskId: taskId,
    })
    expect(second.ok && second.value.reused).toBe(true)
    expect(second.ok && first.ok && second.value.slaveId).toBe(first.ok ? first.value.slaveId : '')
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: first.ok ? first.value.slaveId : '' } })
    // E13: R4 is absolute -- only `setLifecycle` moves a lifecycle.
    expect(worker.lifecycle).toBe('project')
    expect(worker.engagementTaskId).toBeNull()
  })

  it('never reuses a RELEASED worker -- the new hire is a new worker with the next name', async () => {
    const first = await hireFromTemplate(workspaceId, templateId, {
      rationale: 'one assignment',
      temporary: true,
      engagementTaskId: taskId,
    })
    const firstId = first.ok ? first.value.slaveId : ''
    const firstName = (await prisma.slave.findUniqueOrThrow({ where: { id: firstId } })).name
    expect((await releaseWorker(firstId, 'over')).ok).toBe(true)

    const second = await hireFromTemplate(workspaceId, templateId, { rationale: 'again' })
    expect(second.ok && second.value.reused).toBe(false)
    expect(second.ok && second.value.slaveId).not.toBe(firstId)
    const secondName = (await prisma.slave.findUniqueOrThrow({ where: { id: second.ok ? second.value.slaveId : '' } })).name
    expect(secondName).toBe(`${firstName} 2`)
  })

  it('materialises a roster worker as permanent', async () => {
    const result = await materialiseCompanySlave(workspaceId, companySlaveId, { rationale: 'from the roster' })
    expect(result.ok).toBe(true)
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: result.ok ? result.value.slaveId : '' } })
    expect(worker.lifecycle).toBe('permanent')
  })
```

(`taskId` and `companySlaveId` come from this file's existing seed; if it has no task, add one to the seed the same way the other rows are created.)

`packages/control/test/integration/org.test.ts` — one case in the `assignCompany` describe:

```ts
  it('materialises a whole roster as permanent workers', async () => {
    // ...the file's existing assignCompany call...
    const workers = await prisma.slave.findMany({ where: { team: { workspaceId } }, select: { lifecycle: true } })
    expect(workers.length).toBeGreaterThan(0)
    expect(workers.every((worker) => worker.lifecycle === 'permanent')).toBe(true)
  })
```

- [ ] **Step 8: Run them and watch them fail**

Run: `npx vitest run packages/control/test/integration/capability.test.ts packages/control/test/integration/org.test.ts`
Expected: FAIL — `'engagementTaskId' does not exist in type` on the opts literal, and every `lifecycle` assertion reading `project` where `permanent` is expected.

- [ ] **Step 9: Teach the creation sites the lifecycle**

`packages/control/src/org.ts` — `assignCompanyTx`'s create (`:442`) gains one line:

```ts
          capabilities: [...capabilities],
          companySlaveId: companySlave.id,
          // M50 R1: a roster worker EXISTS in the organisation, which is what `permanent` means.
          // Written here rather than left to the column default, which would call every one of
          // them a project hire.
          lifecycle: 'permanent',
```

`packages/control/src/capability.ts` — `materialiseCompanySlave`'s create (`:344`), identically:

```ts
          capabilities: [...capabilities],
          companySlaveId,
          // M50 R1: the single-worker sibling of `assignCompanyTx`, and the same answer.
          lifecycle: 'permanent',
          ...(opts.rationale === undefined ? {} : { selectionRationale: opts.rationale }),
```

`hireFromTemplate` — the docstring's last paragraph is replaced, the options grow one field, the suffix goes, the reuse is narrowed and the create writes the lifecycle:

```ts
 * REUSES rather than duplicates (plan erratum E10): one supervised pass decides every fresh
 * situation, so two `capability_unstaffed` situations can both land on the same template, and a
 * second approval must not put a second copy of the same specialist on the project. The existing
 * worker gains whatever capabilities and roles the second hire would have brought, and keeps the
 * rationale of the hire that actually created it -- that sentence is why it is here.
 *
 * A RELEASED worker is never reused (M50 R2): its engagement is over, its runtime roles are empty
 * on purpose, and merging a new hire into it would quietly un-retire somebody. The reuse read
 * therefore requires `releasedAt: null`, and a hire that finds only released copies creates a new
 * worker -- which `uniqueSlaveName` names `<Name> 2`, because the released one still holds `<Name>`
 * and nothing deleted it.
 *
 * A reuse NEVER rewrites `lifecycle` or `engagementTaskId` (M50 R4, plan erratum E13). Only
 * `setLifecycle` moves a lifecycle after creation, so a temporary hire landing on a worker created
 * `project` merges capabilities and roles and leaves the worker what it was. The claim stays true
 * of the decision; the worker keeps what it was created as.
 */
export async function hireFromTemplate(
  workspaceId: string,
  templateId: string,
  opts: {
    readonly capabilities?: readonly string[]
    readonly rationale: string
    /** M50 R2: this hire is for ONE assignment. The worker is created `ephemeral` and
     *  {@link engagementTaskId} is what `engagement_over` later measures the end against. */
    readonly temporary?: boolean
    /** M50 R2: the assignment. REQUIRED when `temporary` is true -- a temporary worker with no
     *  engagement is one nothing can ever release (plan decision D3) -- and validated against this
     *  workspace's own tasks, because the column is a foreign key and a dangling one would throw a
     *  P2003 out of a `Promise<Result<…>>` with nowhere to put it. */
    readonly engagementTaskId?: string | null
  },
): Promise<…unchanged…>
```

the pre-checks, immediately after the `capability_not_found` loop (`:415-417`) and before the first write:

```ts
  const capabilities = [...new Set([...template.capabilityKeys, ...asked])].toSorted()
  const runtimeRoles = [...new Set([template.role, ...projectRoles(capabilities, taxonomy)])]
  // M50 R1: the rationale is the SENTENCE now and nothing else. It used to carry
  // `(asked for as a temporary specialist)` because a column nothing released would have been a
  // promise the system could not keep; the column exists, so the promise is the record.
  const rationale = opts.rationale
  const temporary = opts.temporary === true
  const engagementTaskId = temporary ? (opts.engagementTaskId ?? null) : null
  if (temporary) {
    // Reported as "no such task" from this caller's side of the boundary -- `decision_not_found`'s
    // rule (`refusal.ts:293`): a task in another project must read back exactly like one that never
    // existed.
    const engagement =
      engagementTaskId === null
        ? null
        : await prisma.task.findFirst({ where: { id: engagementTaskId, workspaceId }, select: { id: true } })
    if (engagement === null) return err({ kind: 'task_not_found', taskId: engagementTaskId ?? '' })
  }
```

the reuse read (`:428-431`):

```ts
    const existing = await tx.slave.findFirst({
      // `releasedAt: null` (M50 R2): a released worker's engagement is over and nothing re-hires it.
      where: { hiredFromTemplateId: templateId, team: { workspaceId }, releasedAt: null },
      orderBy: { id: 'asc' },
    })
```

and the create (`:474-487`):

```ts
        hiredFromTemplateId: templateId,
        selectionRationale: rationale,
        // M50 R1/R2: WHY this worker exists, written at the creation site. `engagementTaskId` is
        // null for an ordinary hire and is the validated task for a temporary one.
        lifecycle: temporary ? 'ephemeral' : 'project',
        engagementTaskId,
```

- [ ] **Step 10: Widen `listOrganization`**

`packages/control/src/capability.ts` — `OrganizationWorker` loses `kind` and gains two fields (R6):

```ts
  readonly capabilities: readonly string[]
  /** M50 R1: WHY this worker is here, off the column. Replaces the `companySlaveId === null ?
   *  'project' : 'company'` derivation this interface carried until M50 -- one of three readings of
   *  one question, none of which could say "temporary". */
  readonly lifecycle: SlaveLifecycle
  /** M50 R3: the engagement is over. `at` is an ISO string, never a `Date` -- this view crosses a
   *  server/client boundary. Null for every worker still here. */
  readonly released: { readonly at: string; readonly reason: string } | null
  readonly companyName: string | null
```

and the mapper (`:700-712`):

```ts
      capabilities: row.capabilities,
      lifecycle: row.lifecycle,
      released:
        row.releasedAt === null
          ? null
          : { at: row.releasedAt.toISOString(), reason: row.releaseReason ?? 'released' },
      companyName: row.companySlave?.companyTeam.company.name ?? null,
```

with `SlaveLifecycle` added to the `@slave-of-ai/domain` type import at the top of the file.

- [ ] **Step 11: Fill the Supervisor's world and wire the two arms**

`packages/control/src/supervisorWorld.ts` — the task SELECT (`:203-225`) gains one column:

```sql
      t."requiredCapabilities",
      t."assigneeId",
      t."integratedAt",
```

(and `TaskRow`'s interface in the same file gains `assigneeId: string | null`), the task mapper gains `assigneeId: row.assigneeId,` beside `requiredCapabilities`, the slave select (`:579-594`) gains three columns:

```ts
          capabilities: true,
          // M50 R3: the three facts `engagement_over` is decided from. `lifecycle` says whether the
          // question applies at all, `engagementTaskId` names the assignment, and `releasedAt` is
          // what keeps a released worker out of `formTeam`'s roster and out of `staffableSlaves`.
          lifecycle: true,
          engagementTaskId: true,
          releasedAt: true,
```

and the slave mapper (`:741-748`):

```ts
      const slaves: SupervisorSlave[] = slaveRows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        runtimeRoles: row.runtimeRoles,
        capabilities: row.capabilities,
        busy: row.runs.length > 0,
        lifecycle: row.lifecycle,
        engagementTaskId: row.engagementTaskId,
        released: row.releasedAt !== null,
      }))
```

`packages/control/src/supervisor.ts` — the hire arm passes the engagement, and the fifteenth arm joins `carryOut`:

```ts
    case 'hire_from_catalog':
      return reached(
        await hireFromTemplate(decision.workspaceId, action.templateId, {
          capabilities: [action.capability],
          rationale: action.rationale,
          // M50 R2: both together or neither. A temporary hire without its assignment is a worker
          // nothing can release, which is the promise this milestone exists to keep.
          ...(action.temporary && action.engagementTaskId !== null
            ? { temporary: true, engagementTaskId: action.engagementTaskId }
            : {}),
        }),
      )
```

```ts
    case 'release_worker':
      // M50 R3, the routine the milestone is named for. `tierOf` makes this `applied` on an
      // unhalted project, so this arm runs inside a TICK -- which is exactly why `releaseWorker`
      // skips and counts a worktree it could not remove instead of throwing.
      return reached(await releaseWorker(action.slaveId, action.reason, principal))
```

with `releaseWorker` imported from `./lifecycle.js`.

- [ ] **Step 12: Write the failing test for the Supervisor's arm, then run the control suite**

`packages/control/test/integration/supervisor.test.ts` — one case in the `applyDecision` describe, built the way that file already builds an applied decision (seed the world, `recordDecision`, `applyDecision`):

```ts
  it('carries out release_worker: the worker is released and the decision is applied', async () => {
    const { slaveId } = await seedReleasableWorker()
    const decision = await recordDecision({
      workspaceId,
      situation: { kind: 'engagement_over', subjectId: slaveId, summary: 'the engagement is over', facts: {} },
      candidates: [],
      action: { kind: 'release_worker', slaveId, name: 'Robin', reason: 'the engagement is over' },
      tier: 'applied',
      decidedBy: 'rules',
      modelCalled: false,
    })
    const applied = await applyDecision(decision.ok ? decision.value.id : '')
    expect(applied.ok).toBe(true)
    const worker = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId } })
    expect(worker.runtimeRoles).toEqual([])
    expect(worker.releasedAt).not.toBeNull()
  })
```

(`recordDecision`/`applyDecision`'s exact argument shapes are this file's own — copy them from the `discard_stale_candidates` case directly above rather than from this sketch. `seedReleasableWorker` is the same seed as `lifecycle.test.ts`'s `seedEngagement`, inlined into this file's own fixture helpers.)

The two `hire_from_catalog` literals already in this file (`:1765`, `:1830`) each gain `engagementTaskId: null` — an ordinary hire carries one.

Run: `npx vitest run packages/control`
Expected: PASS, whole package.

- [ ] **Step 13: Run the whole ladder for this task**

```bash
npx vitest run packages/control packages/db
npx vitest run apps/web/test/refusal-status.test.ts
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: all green; `typecheck` silent, which is what proves `refusalText`, `ALL_KINDS` and `carryOut` are all exhaustive over the widened unions.

- [ ] **Step 14: Commit**

```bash
git add packages/control apps/web/test/refusal-status.test.ts
git commit -m "$(cat <<'EOF'
feat(control): m50 t2 — one verb ends an engagement, one verb moves a lifecycle, and nothing is deleted

`releaseWorker` writes four columns and removes directories: `releasedAt`, `releaseReason` and an
empty `runtimeRoles` -- which is the whole of how a released worker stops being dispatched, because
`decide()` is untouched and a second filter would be a second rule. Its worktrees are collected
after the transaction commits, one call each inside its own try, so a tree git refused is a number
in the payload and never an exception out of the tick that applied the decision. The four creation
sites now say what they make: the roster materialises `permanent`, a hire is `project`, and a hire
the Supervisor asked for one assignment is `ephemeral` with the task it was brought in for --
validated against the project, because the column is a foreign key. A released worker is never
reused; a reuse never rewrites a lifecycle, because only `setLifecycle` may.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 3: The three CLI verbs a person reaches the lifecycle through (R4, E3, D3)

**Files:**
- Modify: `apps/orchestrator/src/cli.ts`
- Test: `apps/orchestrator/test/integration/cli.test.ts`

**Interfaces:**
- Consumes from Task 2: `releaseWorker`, `setLifecycle`, the widened `hireFromTemplate` options (`@slave-of-ai/control`); `SLAVE_LIFECYCLES`, `SlaveLifecycle` (`@slave-of-ai/domain`); `refusalText`, `requireFlag`, `flagText`, `operatorName`, `plural` (this file's own helpers).
- Produces, for Task 5: the three command lines the gate drives as real subprocesses —
  - `hire --workspace <id> --template <id> --why <text> [--capability <key>] [--temporary --for-task <taskId>]`
  - `release-worker --slave <id> --reason <text>`
  - `set-lifecycle --slave <id> --lifecycle <permanent|project|ephemeral>`
- **Nothing here computes `requiredBy`** (erratum E3). It is built inside `teamPlanOf` from the world the daemon already loads; `apps/orchestrator/src/supervisor.ts`, `world.ts` and `tick.ts` are untouched by this milestone, and `loadSlaveRows` in particular gains nothing — the empty `runtimeRoles` is the only exclusion there is.

- [ ] **Step 1: Write the failing tests for the three verbs**

`apps/orchestrator/test/integration/cli.test.ts` — a new describe beside the `hire` one at `:1480`:

```ts
  describe('the worker lifecycle', () => {
    it('hires a temporary specialist for one task, and records the engagement on the column', async (): Promise<void> => {
      const template = await prisma.slaveTemplate.create({
        data: { name: `M50 CLI Security ${String(Date.now())}`, role: 'security', capabilityKeys: ['security.application'] },
      })
      const result = await runCli([
        'hire',
        '--workspace',
        fixture.workspaceId,
        '--template',
        template.id,
        '--why',
        'the authentication path needs a security read',
        '--temporary',
        '--for-task',
        fixture.taskId,
      ])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('hired ')
      expect(result.stdout).toContain('for one assignment')

      const worker = await prisma.slave.findFirstOrThrow({ where: { hiredFromTemplateId: template.id } })
      expect(worker.lifecycle).toBe('ephemeral')
      expect(worker.engagementTaskId).toBe(fixture.taskId)
    }, 60_000)

    it('refuses --temporary without --for-task: a specialist with no assignment can never be released', async (): Promise<void> => {
      const template = await prisma.slaveTemplate.create({
        data: { name: `M50 CLI Loose ${String(Date.now())}`, role: 'security', capabilityKeys: ['security.application'] },
      })
      const result = await runCli([
        'hire',
        '--workspace',
        fixture.workspaceId,
        '--template',
        template.id,
        '--why',
        'no assignment',
        '--temporary',
      ])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('--for-task')
      expect(await prisma.slave.count({ where: { hiredFromTemplateId: template.id } })).toBe(0)
    }, 60_000)

    it('releases a worker and says what it collected', async (): Promise<void> => {
      const worker = await prisma.slave.create({
        data: {
          teamId: fixture.teamId,
          name: 'M50 CLI Robin',
          role: 'Security Reviewer',
          runtimeRoles: ['security'],
          lifecycle: 'ephemeral',
          engagementTaskId: fixture.taskId,
        },
      })
      const result = await runCli(['release-worker', '--slave', worker.id, '--reason', 'the engagement is over'])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('released M50 CLI Robin')
      expect(result.stdout).toContain('0 worktrees collected')
      const after = await prisma.slave.findUniqueOrThrow({ where: { id: worker.id } })
      expect(after.runtimeRoles).toEqual([])
      expect(after.releasedAt).not.toBeNull()
    }, 60_000)

    it('refuses release-worker on a project worker, in the words the refusal wrote', async (): Promise<void> => {
      const result = await runCli(['release-worker', '--slave', fixture.slaveId, '--reason', 'no'])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('not a specialist brought in for one assignment')
    }, 60_000)

    it('moves a lifecycle by hand and prints both ends of the move', async (): Promise<void> => {
      const worker = await prisma.slave.create({
        data: {
          teamId: fixture.teamId,
          name: 'M50 CLI Sam',
          role: 'Security Reviewer',
          runtimeRoles: [],
          lifecycle: 'ephemeral',
          engagementTaskId: fixture.taskId,
        },
      })
      const result = await runCli(['set-lifecycle', '--slave', worker.id, '--lifecycle', 'project'])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('ephemeral')
      expect(result.stdout).toContain('project')
      const after = await prisma.slave.findUniqueOrThrow({ where: { id: worker.id } })
      expect(after.lifecycle).toBe('project')
      expect(after.engagementTaskId).toBeNull()
    }, 60_000)

    it('refuses a lifecycle that is not one of the three', async (): Promise<void> => {
      const result = await runCli(['set-lifecycle', '--slave', fixture.slaveId, '--lifecycle', 'forever'])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('permanent, project, ephemeral')
    }, 60_000)
  })
```

(`fixture.teamId` — if the file's fixture does not already expose the team id, read it with
`(await prisma.slave.findUniqueOrThrow({ where: { id: fixture.slaveId }, select: { teamId: true } })).teamId`
inside each case rather than widening the shared fixture.)

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts -t "the worker lifecycle"`
Expected: FAIL — `unknown command: release-worker` on three of them and a hire that writes `lifecycle: project` on the first.

- [ ] **Step 3: Extend `hire` and add the two new verbs**

`apps/orchestrator/src/cli.ts` — the help block (`:341-346`) becomes:

```
  hire --workspace <id> --template <id> --why <text> [--capability <key>]
       [--temporary --for-task <taskId>]
                                       put a specialist from the catalog on this project, carrying
                                       its template's capabilities and the roles those project to.
                                       Re-running for the same template REUSES the worker already
                                       hired from it rather than hiring a second -- unless that
                                       worker has been released, which is never reused. --why is
                                       required: it is the record of why this worker is here.
                                       --temporary hires for ONE assignment and needs --for-task:
                                       the worker is ephemeral, and release-worker ends it.
  release-worker --slave <id> --reason <text>
                                       end an ephemeral worker's engagement: its runtime roles are
                                       emptied so nothing dispatches it again and its finished
                                       tasks' worktrees are removed. Nothing is deleted -- every
                                       run, message and thing it learnt stays exactly where it is.
                                       Refused for a worker that is not ephemeral, one already
                                       released, and one with a live run.
  set-lifecycle --slave <id> --lifecycle <permanent|project|ephemeral>
                                       move a worker between lifecycles by hand. Nothing else ever
                                       does: a worker is never promoted automatically. Leaving
                                       ephemeral clears the engagement and the release with it, and
                                       restores no runtime roles -- use set-runtime-roles for that.
                                       permanent is refused for a worker on no company roster.
```

the `hire` case (`:1834`):

```ts
    case 'hire': {
      // `'temporary' in flags`, not `flags['temporary'] !== undefined`: a bare `--temporary`
      // records `undefined` as its value, the same trap `delete-slave`'s `--yes` documents.
      const temporary = 'temporary' in flags
      // M50 R2 (plan decision D3): an assignment is not optional for a temporary hire. A worker
      // brought in for nothing in particular is one `engagement_over` can never fire for, and a
      // specialist nobody can release is exactly the promise this milestone exists to keep.
      const forTask = temporary ? requireFlag(flags, 'for-task') : undefined
      const result = await hireFromTemplate(requireFlag(flags, 'workspace'), requireFlag(flags, 'template'), {
        rationale: requireFlag(flags, 'why'),
        ...(flagText(flags, 'capability') === undefined ? {} : { capabilities: [requireFlag(flags, 'capability')] }),
        ...(temporary && forTask !== undefined ? { temporary: true, engagementTaskId: forTask } : {}),
      })
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        `${result.value.reused ? 'reused' : 'hired'} ${result.value.slaveId}: provides ${result.value.capabilities.join(', ')}, ` +
          `dispatchable as ${result.value.runtimeRoles.join(', ')}` +
          `${temporary && !result.value.reused ? `, for one assignment (${String(forTask)})` : ''}\n`,
      )
      return 0
    }
```

and the two new cases, placed beside `delete-slave` (`:1983`) so the roster verbs stay together:

```ts
    case 'release-worker': {
      const slaveId = requireFlag(flags, 'slave')
      const result = await releaseWorker(slaveId, requireFlag(flags, 'reason'), operatorPrincipal(flags))
      if (!result.ok) throw new Error(refusalText(result.error))
      // The NAME, read back after the write: an operator who typed an id deserves to see who it
      // was, and the row is still there to ask -- which is the whole ruling.
      const worker = await prisma.slave.findUniqueOrThrow({ where: { id: slaveId }, select: { name: true } })
      process.stdout.write(
        `released ${worker.name} (${slaveId}): runtime roles cleared, ` +
          `${plural(result.value.worktreesCollected, 'worktree')} collected; ` +
          'every run, message and memory it produced is untouched\n',
      )
      return 0
    }

    case 'set-lifecycle': {
      const slaveId = requireFlag(flags, 'slave')
      const wanted = requireFlag(flags, 'lifecycle')
      // Checked here rather than in the verb: the verb's parameter is typed, and the honest error
      // for a word an operator mistyped is the list of the three there are.
      if (!(SLAVE_LIFECYCLES as readonly string[]).includes(wanted)) {
        throw new Error(`unknown lifecycle "${wanted}": it is one of ${SLAVE_LIFECYCLES.join(', ')}`)
      }
      const result = await setLifecycle(slaveId, wanted as SlaveLifecycle, operatorPrincipal(flags))
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        result.value.from === result.value.to
          ? `${slaveId} was already ${result.value.to}; nothing changed\n`
          : `${slaveId} moved from ${result.value.from} to ${result.value.to}\n`,
      )
      return 0
    }
```

Two details to settle against the file rather than against this plan:

1. `operatorPrincipal(flags)` — this CLI passes **no** `Principal` anywhere (the web fills it from the session; the CLI passes nothing). Check with `grep -n "Principal" apps/orchestrator/src/cli.ts`. If there is no such helper — which is what the M23/M37 verbs above suggest — drop the argument entirely from both calls: `releaseWorker(slaveId, reason)` and `setLifecycle(slaveId, wanted as SlaveLifecycle)`, exactly as `delete-slave` calls `deleteSlave(slaveId)`. The `actor` a release then records is `system`, which is what the CLI has always meant here.
2. `plural` and `prisma` are already imported in this file (`delete-slave` uses both). `releaseWorker`, `setLifecycle` join the `@slave-of-ai/control` import list; `SLAVE_LIFECYCLES` and `type SlaveLifecycle` join the `@slave-of-ai/domain` one.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts -t "the worker lifecycle"`
Expected: PASS, 6 tests. If Step 3's detail 1 sent you to the no-principal branch, the `release-worker` case's stdout assertions are unchanged — only the `actor` on the event moves, and no test in this file reads it.

- [ ] **Step 5: Run the whole ladder for this task**

```bash
npx vitest run apps/orchestrator
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: the orchestrator package green (the CLI help test, if the file pins the help text's shape, will need the three new lines added to its expectation — check `grep -n "prints the help" -A15 apps/orchestrator/test/integration/cli.test.ts` and extend rather than loosen it), `typecheck` silent.

- [ ] **Step 6: Commit**

```bash
git add apps/orchestrator
git commit -m "$(cat <<'EOF'
feat(orchestrator): m50 t3 — three command lines a person reaches a worker's lifecycle through

`hire --temporary` now needs `--for-task`, because a specialist brought in for nothing in
particular is one nothing can ever release; `release-worker` ends an engagement and says how many
worktrees went with it and that everything else stayed; `set-lifecycle` is the only path that moves
the column after creation, and it names the three words there are when somebody types a fourth.
Nothing else in the orchestrator moves: the `requiredBy` map the one-assignment rule reads is built
inside `teamPlanOf`, off the same staffable tasks the gap was measured over, and `loadSlaveRows`
gains nothing at all -- an empty runtime-role set is the whole of how a released worker stops being
dispatched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 4: The four surfaces that say who is temporary and who has gone (R6, E7, E8, E9, D6, D7)

**Files:**
- Create: `apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/release/route.ts`, `apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/lifecycle/route.ts`, `apps/web/test/all-slaves-table.test.tsx`
- Modify: `apps/web/src/server/organization.ts`, `apps/web/src/components/organization/OrganizationClient.tsx`, `apps/web/src/server/brief.ts`, `apps/web/src/components/project/ProjectBrief.tsx`, `apps/web/src/server/overview.ts`, `apps/web/src/components/SlaveCard.tsx`, `apps/web/src/server/org.ts`, `apps/web/src/components/AllSlavesTable.tsx`, `docs/ia.md`
- Test: `apps/web/test/organization-page.test.tsx`, `apps/web/test/project-brief.test.tsx`, `apps/web/test/all-slaves-table.test.tsx`, `apps/web/test/integration/organization.test.ts`

**Interfaces:**
- Consumes from Tasks 1–2: `SLAVE_LIFECYCLE_LABEL`, `SlaveLifecycle` (`@slave-of-ai/domain`); `OrganizationWorker.lifecycle/released`, `releaseWorker`, `setLifecycle` (`@slave-of-ai/control`); `slaveControlResponse` (`../server/slaveControlRoute`); `requirePrincipal` (`../server/principal`).
- Produces, for Task 5 (the testids and routes the gate reads):
  - `OrganizationRow.lifecycle: SlaveLifecycle` and `.released: { at: string; reason: string } | null`, sorted so released rows come last
  - `organization-lifecycle-<slaveId>` (the chip, whose text is the LABEL and whose `title` is the raw value) and `organization-released-<slaveId>` (the `Released <date>` line, in the doing column)
  - `ProjectBrief.team[].lifecycle` / `.released`; the brief tile's `team-lifecycle` chip; `team-row` carries `data-released="true"` when the member is released
  - `SlaveCardData.lifecycle` / `.released`; `SlaveCard`'s `card-lifecycle-chip`; the card's root carries `data-released="true"`
  - `AllSlaveRow.lifecycle` / `.released` and the table's `worker-lifecycle` cell
  - `POST /api/w/:id/slaves/:slaveId/release` body `{ reason: string }`; `POST /api/w/:id/slaves/:slaveId/lifecycle` body `{ lifecycle: SlaveLifecycle }`

- [ ] **Step 1: Write the failing tests for the Organization row**

`apps/web/test/organization-page.test.tsx` — the fixture at `:51` loses `kind: 'company'` and gains the two fields; the assertion at `:134` is replaced, and two cases are added:

```tsx
  it('prints the lifecycle as a word, with the raw value one hover away', () => {
    render(<OrganizationClient workspaceId="w1" initial={VIEW} />)
    const chip = screen.getByTestId('organization-lifecycle-s3')
    expect(chip.textContent).toBe('Ephemeral')
    expect(chip.querySelector('[data-testid="chip"]')?.getAttribute('title')).toBe('ephemeral')
  })

  it('says when a released worker was released, and puts them last', () => {
    render(<OrganizationClient workspaceId="w1" initial={VIEW} />)
    expect(screen.getByTestId('organization-released-s4').textContent).toContain('Released')
    const rows = screen.getAllByTestId(/^organization-row-/)
    expect(rows[rows.length - 1]?.getAttribute('data-testid')).toBe('organization-row-s4')
  })
```

with `VIEW.workers` gaining a fourth worker whose `released` is `{ at: '2026-09-12T10:00:00.000Z', reason: 'the engagement is over' }` and whose name sorts FIRST alphabetically — so "sorted last" is a statement about the sort and not about the name.

`apps/web/test/integration/organization.test.ts:172` — the tuple it builds changes from `[name, kind, why]` to `[name, lifecycle, why]`, with the expected middle value moving from `'company'`/`'project'` to `'permanent'`/`'project'` per row.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run apps/web/test/organization-page.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="organization-lifecycle-s3"]`.

- [ ] **Step 3: Rebuild the Organization row around the column**

`apps/web/src/server/organization.ts` — `OrganizationRow`:

```ts
export interface OrganizationRow {
  readonly slaveId: string
  readonly name: string
  readonly roleLabel: string
  /** M50 R1: WHY this worker is here, off `Slave.lifecycle`. Replaces the `company | project`
   *  derivation this row carried until M50 -- which could not say "temporary" because no column
   *  held the fact. */
  readonly lifecycle: SlaveLifecycle
  /** M50 R3: the engagement is over. `at` is an ISO string (this crosses a server/client boundary)
   *  and `reason` is the sentence the release was recorded with. Null for everybody still here. */
  readonly released: { readonly at: string; readonly reason: string } | null
  readonly capabilities: readonly { readonly key: string; readonly label: string }[]
  readonly why: string
  readonly runtimeRoles: readonly string[]
  readonly doing: string | null
}
```

the mapper, with the sort (plan decision D7):

```ts
    workers: org.value.workers
      .map((worker) => ({
        slaveId: worker.slaveId,
        name: worker.name,
        roleLabel: worker.role,
        lifecycle: worker.lifecycle,
        released: worker.released,
        capabilities: worker.capabilities.map((key) => ({ key, label: label(key) })),
        why: whyHere(worker),
        runtimeRoles: worker.runtimeRoles,
        doing: doingNow(worker.slaveId, world),
      }))
      // M50 R6: released workers LAST, and never hidden (`docs/ia.md` rule 2 -- nothing is removed,
      // only moved). Somebody looking for the specialist who did the security pass has to find
      // them, with the date they left beside their name. `listOrganization` already returned the
      // rows name-ascending, so this is a stable partition rather than a second sort.
      .toSorted((a, b) => (a.released === null ? 0 : 1) - (b.released === null ? 0 : 1)),
```

and `whyHere` (erratum E9):

```ts
/** The sentence in the "why here" column, in the order of how much it actually says: the
 *  Supervisor's own rationale, then the company it was assigned from, then the honest fallback for
 *  a worker that predates all of this. Never a guess.
 *
 *  The company branch keys on the NAME alone since M50 (plan erratum E9): `kind` is gone, and
 *  `lifecycle === 'permanent'` is not the same question -- `Slave.companySlaveId` is `SetNull`, so
 *  a permanent worker whose roster row was deleted has a lifecycle and no company to name. */
function whyHere(worker: {
  readonly selectionRationale: string | null
  readonly companyName: string | null
}): string {
  if (worker.selectionRationale !== null && worker.selectionRationale !== '') return worker.selectionRationale
  if (worker.companyName !== null) return `Assigned from ${worker.companyName}`
  return 'Seeded'
}
```

`apps/web/src/components/organization/OrganizationClient.tsx` — the header word and the two cells:

```ts
const HEADER = ['Worker', 'Lifecycle', 'Provides', 'Why they are here', 'Doing'] as const
```

```tsx
                      <span data-testid={`organization-lifecycle-${worker.slaveId}`}>
                        {/* The WORD, with the raw value in `title` (`docs/ia.md` rule 3). An
                          * ephemeral worker gets the `waiting` tone -- the one tone in the palette
                          * that already means "this is temporary and somebody will have to act" --
                          * so a temporary specialist is visible in a glance down the column. */}
                        <Chip tone={worker.lifecycle === 'ephemeral' ? 'waiting' : undefined} title={worker.lifecycle}>
                          {SLAVE_LIFECYCLE_LABEL[worker.lifecycle]}
                        </Chip>
                      </span>
```

```tsx
                      {worker.released === null ? (
                        <span
                          data-testid={`organization-doing-${worker.slaveId}`}
                          className={`text-xs ${worker.doing === null ? 'text-text-3' : 'text-tone-working'}`}
                        >
                          {worker.doing ?? 'Idle'}
                        </span>
                      ) : (
                        // The engagement ended, so "Idle" would be a lie about a worker that is not
                        // waiting for anything. The DATE, with the sentence the release was recorded
                        // with one hover away.
                        <span
                          data-testid={`organization-released-${worker.slaveId}`}
                          title={worker.released.reason}
                          className="text-xs text-text-3"
                        >
                          Released {worker.released.at.slice(0, 10)}
                        </span>
                      )}
```

and the row wrapper carries the state a stylesheet and a gate can both read:

```tsx
                  <div
                    key={worker.slaveId}
                    data-testid={`organization-row-${worker.slaveId}`}
                    data-released={worker.released === null ? undefined : 'true'}
                    className={worker.released === null ? undefined : 'opacity-60'}
                  >
```

with `SLAVE_LIFECYCLE_LABEL` imported from `@slave-of-ai/domain`.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run apps/web/test/organization-page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing tests for the brief tile, the card and the table**

`apps/web/test/project-brief.test.tsx` — the fixture's `team[]` members gain `lifecycle`/`released` and one case is added:

```tsx
  it('marks a temporary specialist and greys one whose engagement is over', () => {
    render(<ProjectBrief brief={BRIEF} />)
    expect(screen.getAllByTestId('team-lifecycle').map((chip) => chip.textContent)).toEqual(['Ephemeral'])
    const rows = screen.getAllByTestId('team-row')
    expect(rows.filter((row) => row.getAttribute('data-released') === 'true')).toHaveLength(1)
  })
```

(`BRIEF.team` gets three members: one `permanent`, one `ephemeral` unreleased, one `ephemeral` released. The eight-fact `toEqual` pins at `:42-47` are about the FACTS, not the team, and do not move — E6 of M49 is the precedent that says so.)

`apps/web/test/all-slaves-table.test.tsx` — a new file:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AllSlavesTable } from '../src/components/AllSlavesTable'

/** One project row per lifecycle, built the way `AllSlavesPage` really arrives: `listAllSlaves`'s
 *  own shape, with the two maps empty (the department select renders a bare name without them). */
const PAGE = {
  rows: [
    { slaveId: 's1', companySlaveId: null, name: 'Ada', role: 'Backend', runtimeRoles: ['backend'], departmentName: 'Engineering', projectName: 'Demo', workspaceId: 'w1', teamId: 't1', companyId: null, companyTeamId: null, status: 'idle', currentTask: null, provider: null, gate: null, model: null, costUsd: 0, unmeasuredRuns: 0, runCount: 0, lifecycle: 'project' as const, released: null },
    { slaveId: 's2', companySlaveId: null, name: 'Robin', role: 'Security', runtimeRoles: [], departmentName: 'Specialists', projectName: 'Demo', workspaceId: 'w1', teamId: 't1', companyId: null, companyTeamId: null, status: 'idle', currentTask: null, provider: null, gate: null, model: null, costUsd: 0, unmeasuredRuns: 0, runCount: 0, lifecycle: 'ephemeral' as const, released: { at: '2026-09-12T10:00:00.000Z', reason: 'over' } },
  ],
  departmentsByWorkspace: {},
  templatesByCompany: {},
}

describe('AllSlavesTable lifecycle column', () => {
  it('prints the word, keeps the key in title, and greys a released row', () => {
    render(<AllSlavesTable initial={PAGE} onOpen={() => undefined} />)
    const cells = screen.getAllByTestId('worker-lifecycle')
    expect(cells.map((cell) => cell.textContent)).toEqual(['Project', 'Ephemeral'])
    expect(cells[1]?.getAttribute('title')).toBe('ephemeral')
    expect(screen.getAllByTestId('data-table-row')[1]?.getAttribute('data-released')).toBe('true')
  })
})
```

(Check `AllSlavesTable`'s real props with `grep -n "export function AllSlavesTable" -A6 apps/web/src/components/AllSlavesTable.tsx` and the `Row` component's own testid with `grep -n "data-testid" apps/web/src/components/ui/DataTable.tsx` before writing this file — use whatever those two actually are rather than the names above.)

- [ ] **Step 6: Run them and watch them fail**

Run: `npx vitest run apps/web/test/project-brief.test.tsx apps/web/test/all-slaves-table.test.tsx`
Expected: FAIL — `team-lifecycle` and `worker-lifecycle` are found by nothing.

- [ ] **Step 7: Carry the lifecycle onto the brief, the card and the table**

`apps/web/src/server/brief.ts` — `team[]`'s member (erratum E7):

```ts
    readonly taskTitle: string | null
    /** M50 R1: why this worker is here. Replaces `company: boolean`, which was the only marker the
     *  schema carried before the column existed. */
    readonly lifecycle: SlaveLifecycle
    /** M50 R3: the engagement is over; the row is greyed and the date is one hover away. */
    readonly released: { readonly at: string; readonly reason: string } | null
  }[]
```

the slave select gains three columns beside `companySlaveId` (which stays — `pickVerified` and nothing else read it, and the roster link is still a fact this builder reports nowhere else):

```ts
          companySlaveId: true,
          lifecycle: true,
          releasedAt: true,
          releaseReason: true,
```

and the mapper at `:266-278`:

```ts
        taskTitle: run?.taskId === null || run === null ? null : (titleById.get(run.taskId) ?? null),
        lifecycle: slave.lifecycle,
        released:
          slave.releasedAt === null
            ? null
            : { at: slave.releasedAt.toISOString(), reason: slave.releaseReason ?? 'released' },
```

`apps/web/src/components/project/ProjectBrief.tsx` — the chip replaces `team-company`:

```tsx
                  <span className={`shrink-0 font-mono text-[9.5px] uppercase ${TONE_TEXT[tone]}`}>{member.status}</span>
                  {member.lifecycle !== 'project' && (
                    // The WORD, raw value in `title` (`docs/ia.md` rule 3). `project` is the
                    // ordinary case and prints nothing -- a marker every row carries marks nothing.
                    <span
                      data-testid="team-lifecycle"
                      title={member.lifecycle}
                      className="shrink-0 rounded-chip border border-line px-1.5 text-[9.5px] text-text-3"
                    >
                      {SLAVE_LIFECYCLE_LABEL[member.lifecycle]}
                    </span>
                  )}
```

and both `team-row` elements gain the state:

```tsx
                    <div
                      data-testid="team-row"
                      data-released={member.released === null ? undefined : 'true'}
                      className={`flex w-full items-center gap-2 text-left${member.released === null ? '' : ' opacity-60'}`}
                    >
```

```tsx
                    <button
                      type="button"
                      data-testid="team-row"
                      data-released={member.released === null ? undefined : 'true'}
                      onClick={() => onOpenSlave(member.slaveId)}
                      className={`flex w-full items-center gap-2 rounded-nav text-left hover:bg-white/[0.045]${member.released === null ? '' : ' opacity-60'}`}
                    >
```

`apps/web/src/server/overview.ts` — `SlaveCardData` gains the same two fields with the same comments, and the mapper fills them off the row the existing `include` already loads in full (no `select` change is needed; confirm with `grep -n "include: { companySlave" apps/web/src/server/overview.ts`).

`apps/web/src/components/SlaveCard.tsx` — a fourth chip in the chip row, and the card's own root:

```tsx
        {slave.lifecycle !== 'project' && (
          <Chip tone={slave.lifecycle === 'ephemeral' ? 'waiting' : undefined} title={slave.lifecycle}>
            <span data-testid="card-lifecycle-chip">{SLAVE_LIFECYCLE_LABEL[slave.lifecycle]}</span>
          </Chip>
        )}
```

The root element gains `data-released={slave.released === null ? undefined : 'true'}` and, appended to its existing `className`, `` `${slave.released === null ? '' : ' opacity-50'}` `` — a released worker's card is still a card, still opens its panel, and reads as finished (plan decision D7).

`apps/web/src/server/org.ts` — `WorkerRow` and `AllSlaveRow` each gain `lifecycle: SlaveLifecycle` and `released: { at: string; reason: string } | null`. `listWorkers` reads whole rows (`include: { team: { include: { workspace: true } } }`), so only its mapper changes:

```ts
      runtimeRoles: slave.runtimeRoles,
      lifecycle: slave.lifecycle,
      released:
        slave.releasedAt === null
          ? null
          : { at: slave.releasedAt.toISOString(), reason: slave.releaseReason ?? 'released' },
```

`listAllSlaves`'s `workerRows` mapper copies both across (`lifecycle: w.lifecycle, released: w.released,`), and `catalogRowFor` — the branch that builds a row for a catalog member no project has materialised — writes `lifecycle: 'permanent'` and `released: null`: a roster member IS somebody the organisation has, which is exactly what `permanent` means, and it is the one honest value for a row that has no `Slave` at all.

`apps/web/src/components/AllSlavesTable.tsx` — the column, the header, the cell and the poll (plan decision D6):

```ts
const COLUMNS = '200px 110px 150px 120px 100px 110px 1fr 90px 90px 160px'
const HEADER = ['Slave', 'Role', 'Department', 'Project', 'Lifecycle', 'Status', 'Current task', 'Provider', 'Cost', ''] as const
```

`PolledWorker` gains both fields with the comment that says why they are polled rather than fixed at load:

```ts
  /** M50 R1/R3: polled like `status` and unlike `model` -- an approved hire and a release both land
   *  between reloads, and a table that showed a released worker as dispatchable for five minutes
   *  would be the one surface disagreeing with the roster. */
  readonly lifecycle: AllSlaveRow['lifecycle']
  readonly released: AllSlaveRow['released']
```

they are merged into a known row and written on a brand-new one exactly as `runtimeRoles` is, and the cell goes between the project cell and the `StatusPill`:

```tsx
            <span data-testid="worker-lifecycle" title={row.lifecycle} className="truncate text-[11.5px] text-text-2">
              {SLAVE_LIFECYCLE_LABEL[row.lifecycle]}
            </span>
```

with the `Row` gaining `data-released={row.released === null ? undefined : 'true'}` and the released row greyed the same way the other two surfaces grey theirs. (If `Row` does not forward unknown props, put the attribute and the opacity on a wrapping element the way `OrganizationClient` wraps its `Row`.)

- [ ] **Step 8: Run them and watch them pass**

Run: `npx vitest run apps/web/test/project-brief.test.tsx apps/web/test/all-slaves-table.test.tsx apps/web/test/organization-page.test.tsx`
Expected: PASS.

- [ ] **Step 9: Add the two routes**

`apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/release/route.ts` (erratum E8 — the siblings' shell, verbatim):

```ts
import { z } from 'zod'
import { releaseWorker } from '@slave-of-ai/control'
import { slaveControlResponse } from '../../../../../../../server/slaveControlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The reason is REQUIRED and non-empty: it is stored on the worker and read on the Organization
 *  tab months later, and "released" with no sentence behind it is the row nobody can explain. */
const bodySchema = z.object({ reason: z.string().min(1) })

const BODY_ERROR = 'the body must be { "reason": string }'

/**
 * The web's way to end an ephemeral worker's engagement (M50 R3).
 *
 * No new autonomy and no new rules: `releaseWorker` still refuses a worker that is not ephemeral,
 * one already released, and one with a live run, and it still deletes nothing. Same shell, scope
 * and actor rules as the sibling `profile` and `runtime-roles` routes -- `slaveControlResponse`
 * 404s a worker outside this workspace, which is what makes a cross-project id read back as
 * "no such slave".
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; slaveId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, slaveId } = await context.params

  const raw: unknown = await request.json().catch(() => null)
  const body = bodySchema.safeParse(raw)
  if (!body.success) return Response.json({ error: BODY_ERROR }, { status: 400 })

  return slaveControlResponse(workspaceId, slaveId, () =>
    releaseWorker(slaveId, body.data.reason, gate.principal ?? undefined),
  )
}
```

`apps/web/src/app/api/w/[workspaceId]/slaves/[slaveId]/lifecycle/route.ts`:

```ts
import { z } from 'zod'
import { setLifecycle } from '@slave-of-ai/control'
import { SLAVE_LIFECYCLES } from '@slave-of-ai/domain'
import { slaveControlResponse } from '../../../../../../../server/slaveControlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The three there are, off the domain's own list -- a fourth member is accepted here the moment it
 *  exists, and a typo never is. */
const bodySchema = z.object({ lifecycle: z.enum(SLAVE_LIFECYCLES) })

const BODY_ERROR = `the body must be { "lifecycle": one of ${SLAVE_LIFECYCLES.join(' | ')} }`

/**
 * A person moves a worker between lifecycles (M50 R4) -- the only path that does, and deliberately
 * human-only: there is no Supervisor action for it and no automatic caller anywhere.
 *
 * What the verb refuses -- a live run, and `permanent` for a worker on no company roster -- is left
 * to the verb, so the reason an operator reads here is the reason the CLI reads too.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; slaveId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, slaveId } = await context.params

  const raw: unknown = await request.json().catch(() => null)
  const body = bodySchema.safeParse(raw)
  if (!body.success) return Response.json({ error: BODY_ERROR }, { status: 400 })

  return slaveControlResponse(workspaceId, slaveId, () =>
    setLifecycle(slaveId, body.data.lifecycle, gate.principal ?? undefined),
  )
}
```

- [ ] **Step 10: Update `docs/ia.md`**

The Organization row (`:42`) gains one sentence to its `Later` column, after M47's:

```
M50 marks each worker's lifecycle — Permanent, Project or Ephemeral — as a chip beside their name, and a worker brought in for one assignment and since released keeps their row, greyed and sorted last, with the date the engagement ended
```

and the Overview row (`:40`) gains, after M49's sentence:

```
M50 marks a temporary specialist on the team strip and greys a released one
```

- [ ] **Step 11: Run the whole ladder for this task**

```bash
pgrep -af "next dev"     # must print nothing; if it does, kill it and say so in the report
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
Expected: `apps/web`'s unit and integration tests green; `web:build` completes; `gate:m44-ux-foundation` passes with no new raw token — `permanent`, `project` and `ephemeral` are bare English words, so the gate's `_`/`.` filter drops all three and the LABELS are what the page shows anyway.

- [ ] **Step 12: Commit**

```bash
git add apps/web docs/ia.md
git commit -m "$(cat <<'EOF'
feat(web): m50 t4 — every surface says who is temporary, and who has gone

The Organization row's kind chip was the last of three places that each derived `company | project`
from a null column; it reads `Slave.lifecycle` now, prints the word with the key one hover away, and
a released worker keeps their row -- greyed, sorted last, with the date the engagement ended and the
sentence it ended with in the title. The brief's team tile, the Overview's own card grid and the
Workforce Slaves table carry the same two facts from the same column, and the table polls them
beside `status` because an approved hire and a release both land between reloads. Two routes, gated
exactly like the profile and runtime-roles siblings beside them.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 5: `gate:m50-ephemeral`, its fixtures, CI, the README, the screenshots — and the full verification ladder (R5, R7, E12, D9)

**Files:**
- Create: `scripts/fixtures/catalog-m50/divisions.json`, `scripts/fixtures/catalog-m50/LICENSE`, `scripts/fixtures/catalog-m50/security/gate-m50-security-reviewer.md`, `scripts/fixtures/catalog-m50/qa/gate-m50-test-engineer.md`, `packages/providers/test/fixtures/plan-graph-lifecycle.ndjson`, `scripts/gate-m50-ephemeral.mjs`, `docs/superpowers/specs/2026-09-12-m50-ephemeral-specialists-design.md`
- Modify: `scripts/gate-m44-ux-foundation.mjs`, `package.json`, `.github/workflows/ci.yml`, `README.md`, `docs/superpowers/fidelity/m14/organization.png`, `docs/superpowers/fidelity/m14/overview.png`
- Test: the gate itself; then the whole suite.

**Interfaces:**
- Consumes from Tasks 1–4: every column, verb, CLI line, testid and route named in those tasks' **Produces** blocks.
- Produces: `npm run gate:m50-ephemeral`, the 25th CI step.
- **The fake CLI is NOT changed.** `--plan-fixture <name>` already exists (`packages/providers/test/fake-claude.mjs:241-256`) and `m8-flow` already answers every `"verdict"` prompt with `review-approve`, which is the outcome this gate needs (the engagement task must reach `done`). M49's `--review-fixture` is not used here.

- [ ] **Step 1: Commit the spec**

Copy the session's `m50-spec.md` verbatim to `docs/superpowers/specs/2026-09-12-m50-ephemeral-specialists-design.md` and append the thirteen errata from this plan's header to its `## 4. Errata` section, in the M49 house format (`**E1 (amends R2)** — …`, one paragraph each, with the file:line evidence from `m50-plan-notes.md`).

```bash
git add docs/superpowers/specs/2026-09-12-m50-ephemeral-specialists-design.md docs/superpowers/plans/2026-09-12-m50-ephemeral-specialists.md
git commit -m "$(cat <<'EOF'
docs(m50): the ephemeral-specialists spec and its plan, with the thirteen plan-time errata

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

- [ ] **Step 2: Write the fixture catalog**

`scripts/fixtures/catalog-m50/divisions.json`:

```json
{
  "_note": "M50's own catalog. Two divisions, two personas: one providing Application security and one providing Test automation, so a gap that belongs to ONE startable task and a gap TWO tasks share can be measured side by side in one project. Separate from catalog-m47, whose two personas gate:m47 asserts exactly.",
  "divisions": {
    "security": { "label": "Security" },
    "qa": { "label": "Quality" }
  }
}
```

`scripts/fixtures/catalog-m50/LICENSE` — copy `scripts/fixtures/catalog-m47/LICENSE` byte for byte.

`scripts/fixtures/catalog-m50/security/gate-m50-security-reviewer.md` — the same section shape as `catalog-m47/security/gate-security-reviewer.md` (front matter with `name`/`description`, then `# <name>`, `## Identity & Memory`, `## Core Mission`, `## Core Capabilities`, `## Critical Rules You Must Follow`, `## Technical Deliverables`, `## Workflow Process`, `## Communication Style`, `## Success Metrics`), with:

```
---
name: M50 Gate Security Reviewer
description: Reads an authentication path the way somebody trying to get past it would.
---
```

and a `## Core Capabilities` list of exactly:

```
- Application security
```

`scripts/fixtures/catalog-m50/qa/gate-m50-test-engineer.md` — the same shape, with:

```
---
name: M50 Gate Test Engineer
description: Writes the automated sweep that proves a change did not break what was already there.
---
```

and a `## Core Capabilities` list of exactly:

```
- Test automation
```

Both files get real prose in the other sections — the import reads them, the run-context builder renders them, and a persona of headings with nothing under them is not a persona. Neither mentions the other, so no `CollaborationHint` is created: this gate is about the lifecycle, and an advisory edge would be a second thing for it to assert.

Verify the two bullets resolve to the keys the plan fixture asks for:

```bash
node -e "const {CAPABILITY_SEED}=require('./packages/db/dist/capabilities.js');for(const k of ['security.application','qa.test-automation'])console.log(k, CAPABILITY_SEED.find(r=>r.key===k)?.label)"
```
Expected: `security.application Application security` and `qa.test-automation Test automation`. If a label differs, use the label the seed prints — the bullets are matched against the taxonomy's labels and synonyms.

- [ ] **Step 3: Write the plan fixture**

`packages/providers/test/fixtures/plan-graph-lifecycle.ndjson` is `plan-graph-capabilities.ndjson` with the plan JSON replaced. Copy the file and rewrite the two places that carry it — the assistant text line and the `result` field of the final line — with one script, so the two can never drift:

```bash
node -e '
const {readFileSync,writeFileSync}=require("node:fs")
const src="packages/providers/test/fixtures/plan-graph-capabilities.ndjson"
const dst="packages/providers/test/fixtures/plan-graph-lifecycle.ndjson"
const OLD_PREFIX="Here is the plan. "
const plan={tasks:[
 {key:"core",title:"M50 Gate Feature Core",description:"Implement the core module the goal asks for.",capabilities:["backend.api-design"],dependsOn:[]},
 {key:"auth",title:"M50 Gate Authentication Path",description:"The endpoint needs a real authentication path, reviewed for application security.",capabilities:["security.application"],dependsOn:[]},
 {key:"sweep",title:"M50 Gate Test Sweep",description:"An automated sweep over the endpoint.",capabilities:["qa.test-automation"],dependsOn:[]},
 {key:"regression",title:"M50 Gate Regression Suite",description:"A second automated suite, over the batch export.",capabilities:["qa.test-automation"],dependsOn:[]}
]}
const wanted=OLD_PREFIX+JSON.stringify(plan)
const lines=readFileSync(src,"utf8").split("\n")
let replaced=0
const out=lines.map((line)=>{
  if(line.trim()==="")return line
  const row=JSON.parse(line)
  if(typeof row.result==="string"&&row.result.startsWith(OLD_PREFIX)){row.result=wanted;replaced+=1;return JSON.stringify(row)}
  const content=row?.message?.content
  if(Array.isArray(content)){
    let touched=false
    for(const part of content){if(part?.type==="text"&&typeof part.text==="string"&&part.text.startsWith(OLD_PREFIX)){part.text=wanted;touched=true}}
    if(touched){replaced+=1;return JSON.stringify(row)}
  }
  return line
})
if(replaced!==2)throw new Error("expected to rewrite exactly 2 plan carriers, rewrote "+String(replaced))
writeFileSync(dst,out.join("\n"))
console.log("wrote",dst,"replacements",replaced)
'
```
Expected: `wrote packages/providers/test/fixtures/plan-graph-lifecycle.ndjson replacements 2`. A count other than 2 throws, which is the point: a silent one-sided rewrite would give the daemon one plan and the result reader another.

Why these four tasks: `core` is covered (the project's one worker is dispatchable as `backend`); `auth` is the ONLY startable task needing `security.application`, so its gap is one assignment; `sweep` and `regression` both need `qa.test-automation`, so that gap is a standing seat. That pair — one temporary proposal and one ordinary one, in one project, from one plan — is the whole of R7's first claim.

- [ ] **Step 4: Write the gate**

`scripts/gate-m50-ephemeral.mjs`. Borrow the scaffolding file by file from `scripts/gate-m47-team-formation.mjs`, which is this gate's nearest relative: `findFreePort`, `makeRepo`, `listTree`, `describeDecision`, `describeTask`, `deleteGateTemplates`, `preflightCleanup`, `dumpGateRows`, `fail`, `waitUntil`, `waitVisible`, `gotoReliably`, the temp-directory copy of the fixture catalog plus its `git init`, `loopbackChildEnv()`, the real `next dev` on a free port with the ready-wait on next's own bound-port line, the browser preflight refusal, `exitCode` starting at 1, and teardown in FK order inside a `finally`. Daemon first, browser last, for m47's own reason: the browser photographs rows earlier stages created.

Header constants:

```js
const CATALOG_NAME = 'catalog-m50'
const FIXTURE_CATALOG = join(repoRoot, 'scripts/fixtures', CATALOG_NAME)
const SECURITY_PERSONA = 'M50 Gate Security Reviewer'
const QA_PERSONA = 'M50 Gate Test Engineer'
const GATE_TEMPLATE_NAMES = [SECURITY_PERSONA, QA_PERSONA]
const WORKSPACE_NAME = 'M50 Gate Project'
const WORKER_NAME = 'Dev'
const GOAL = 'Ship the endpoint, with an authentication path somebody who does security has read and a sweep that keeps it honest.'
const AUTH_TASK_TITLE = 'M50 Gate Authentication Path'
const CORE_TASK_TITLE = 'M50 Gate Feature Core'
const SWEEP_TASK_TITLE = 'M50 Gate Test Sweep'
const REGRESSION_TASK_TITLE = 'M50 Gate Regression Suite'
const SECURITY_KEY = 'security.application'
const QA_KEY = 'qa.test-automation'
/** The second security task stage 7 puts on the board, to ask the gap again with the same key. */
const RERAISE_TASK_TITLE = 'M50 Gate Second Authentication Path'
/** Erratum E12: `filterFresh` blocks a situation key for COOLDOWN_MS (15 minutes). One hour back is
 *  comfortably past it and is written as a constant so the reason is readable. */
const COOLDOWN_BACKDATE_MS = 60 * 60 * 1000
```

Spawn env, verbatim from m47 with one substitution:

```js
SLAVEOFAI_CLAUDE_BIN=node
SLAVEOFAI_CLAUDE_ARGS="<fake-claude.mjs> --fixture m8-flow --plan-fixture plan-graph-lifecycle"
SLAVEOFAI_REQUIRE_FAKE_CLI=1
```

**Nine measuring stages and a teardown, each measuring one thing the milestone claims** (`gate-m47-team-formation.mjs`'s own header shape, which enumerates its seven plus teardown the same way).

1. **The catalog is imported through the real CLI.** `catalog-m50` is copied to a temp directory, `git init`ed there, and imported. Assert two templates exist by `sourceId` prefix, with `capabilityKeys` `['security.application']` and `['qa.test-automation']`.
2. **A project with one worker and a goal; the plan comes back with four tasks.** The workspace, a `Engineering` team and `Dev` (`runtimeRoles: ['backend', 'manager']`, `capabilities: ['backend.api-design']`) are created as rows; the goal is set through the real CLI; the daemon runs the planning pass off `plan-graph-lifecycle`. Assert the four titles exist, that `AUTH_TASK_TITLE` carries `requiredCapabilities: ['security.application']` and a `requiredRole` of `security`, and that both QA tasks carry `['qa.test-automation']`.
3. **ONE assignment and ONE seat, side by side.** Wait for the Supervisor to record two `capability_unstaffed` decisions. Assert, with `describeDecision` in every failure message:
   - the `security.application` decision's action is `{ kind: 'hire_from_catalog', temporary: true, engagementTaskId: <the auth task's id> }`, `tier: 'proposed'`, `status: 'pending'`, and its rationale contains `one assignment`;
   - the `qa.test-automation` decision's action is `{ kind: 'hire_from_catalog', temporary: false, engagementTaskId: null }`, also `proposed` and `pending`;
   - **nothing has been hired**: `prisma.slave.count({ where: { team: { workspaceId } } })` is still 1.
4. **A human approves the temporary one, through the real `approve-decision` subprocess.** Assert the hired worker has `lifecycle: 'ephemeral'`, `engagementTaskId` equal to the auth task's id, a non-null `createdAt`, `capabilities` including `security.application`, `runtimeRoles` including `security`, `hiredFromTemplateId` set, and `selectionRationale` that does **not** contain `asked for as a temporary specialist` (R1: the suffix is gone, the column is the record).
5. **It is dispatched by ROLE, works, and the assignment finishes.** Wait for a `SlaveRun` on the auth task whose `slaveId` is the hired worker, then for the task to reach `done`. Assert the run recorded a `worktreePath` and that the directory exists on disk. Capture, before the release: the worker's run count, its `RunContext` count, its `ExecutionEvent` count (`where: { workspaceId, slaveId }`) and its worker-scoped `Memory` count. These four numbers are R5's whole claim.
6. **The next `supervise` raises `engagement_over` and applies `release_worker` routinely.** Assert the decision row is `{ situationKind: 'engagement_over', subjectId: <slaveId>, tier: 'applied', status: 'applied' }`, that it was **not** `pending` at any point (`status` is `applied` and `resolvedAt` is null — an auto-applied decision is terminal at birth), and then:
   - `releasedAt` is not null, `releaseReason` is a non-empty string, `runtimeRoles` is `[]`;
   - one `slave.released` event exists with `payload.worktreesCollected === 1`;
   - the worktree directory captured in stage 5 is **gone from disk** (`existsSync` is false) and the run's `worktreePath` is null;
   - and the four counts from stage 5 are **unchanged**, each asserted by name so a failure says which kind of evidence went missing.
7. **The released worker is never picked again, and is never promoted.** Insert a `ready` task titled `RERAISE_TASK_TITLE` with `requiredCapabilities: [SECURITY_KEY]` and `requiredRole: 'security'`, back-date the earlier `capability_unstaffed(security.application)` decision by `COOLDOWN_BACKDATE_MS` on both `createdAt` and `resolvedAt` (erratum E12 — print both moves), and run `supervise` again. Assert the new decision's action is a `hire_from_catalog` naming the **template** (`templateId` is the security template's id and `name` is `SECURITY_PERSONA`) and **not** an `assign_capability` or anything naming the released worker's id. Then run ten more ticks and assert the released worker's `lifecycle` is still `ephemeral` and its `releasedAt` still the same timestamp — nothing promotes a worker automatically (R4).
8. **The three by-hand paths, through real CLI subprocesses, IN THIS ORDER** (the order is load-bearing — see the note below):
   - **8a, a second specialist.** `hire --workspace <id> --template <the security template's id> --why "a second read of the same path" --temporary --for-task <the auth task's id>` exits 0 and prints `hired`, **not** `reused`: the first worker is released, and a released worker is never reused (R2). Assert the new row's `name` is `` `${SECURITY_PERSONA} 2` `` — the released worker still holds the first name, because nothing deleted it — and that its `lifecycle` is `ephemeral` with `engagementTaskId` equal to the auth task. Then `release-worker --slave <the new id> --reason "the engagement is over"` exits 0, prints `released`, and leaves the row with `runtimeRoles: []` and a non-null `releasedAt`. This is the released row stage 9 photographs.
   - **8b, a lifecycle moved by hand.** `set-lifecycle --slave <the FIRST released worker> --lifecycle project` exits 0; the row reads `lifecycle: 'project'` with `engagementTaskId`, `releasedAt` and `releaseReason` all null and `runtimeRoles` still `[]` (R4 restores nothing), and one `org.changed` event carries `{ entity: 'slave', field: 'lifecycle', from: 'ephemeral', to: 'project' }`.
   - **8c, a refusal.** `release-worker --slave <Dev's id> --reason x` exits non-zero with `not a specialist brought in for one assignment` on stderr, and `Dev`'s `runtimeRoles` are untouched.
9. **In a real browser.** The daemon is stopped and its absence re-checked with `findRealDaemonPids()` before `next dev` is spawned. On `/w/<id>/organization`: the QA hire is absent (nobody approved it), `Dev`'s lifecycle chip reads `Project`, the first worker's now reads `Project` too (stage 8b moved it), exactly ONE row carries the `Ephemeral` chip and exactly ONE carries an `organization-released-*` line whose text starts `Released `, and that row is the LAST `organization-row-*` in the table. On `/w/<id>` (Overview): the released worker's `SlaveCard` carries `data-released="true"` and every other card does not. On `/workforce`: the Slaves table's `worker-lifecycle` column contains both `Project` and `Ephemeral`.
10. **Teardown**, in FK order, in a `finally`: `executionEvent`, `supervisorDecision`, `memory`, `runContext`, `checkpoint`, `slaveRun`, `taskDependency`, `task`, `slave`, `team`, `workspace`, then `deleteGateTemplates`, then the temp repository and the temp catalog copy. Scoped by the exact names in the constants above, so a crashed prior run leaves nothing behind.

Two notes the implementer must not improvise past:

- **Why stage 8's three steps must run in that order.** 8b consumes the first ephemeral worker — moving it to `project` is the only way to prove `set-lifecycle` really clears the engagement and the release — and the browser still has to photograph a live `Ephemeral` chip and a `Released <date>` line, which is what 8a's second specialist provides. The order also decides the `Name 2` assertion: `hireFromTemplate`'s reuse read requires `releasedAt: null`, so 8a must run while the FIRST worker is still released. Run 8b first and the second hire is a REUSE of a worker that is no longer released, `Name 2` never happens, and the gate would be asserting the opposite of the ruling.
- **Never edit a file in this repository.** The catalog is imported from a temp copy and the gate's own `git status` after a green run must be empty. `listTree` prints the temp copy on failure.

- [ ] **Step 5: Register the gate and run it**

`package.json`, after `gate:m49-memory`:

```json
    "gate:m50-ephemeral": "tsc --build && node --env-file=.env scripts/gate-m50-ephemeral.mjs"
```

```bash
pgrep -af "next dev"     # must print nothing
CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
  SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
  npm run gate:m50-ephemeral
```
Expected: every stage prints its `stage N complete` line and the script exits 0. Then `git status --porcelain` must print nothing.

- [ ] **Step 6: Add the union to `gate:m44`'s blocklist and re-run it**

`scripts/gate-m44-ux-foundation.mjs` — `SLAVE_LIFECYCLES` joins `RAW_TOKENS` with the comment that says why it contributes nothing today:

```js
  ...MEMORY_UNIONS,
  // M50 R6: the three lifecycles. Every member is a bare English word, so the `_`/`.` filter below
  // drops all three and this line adds nothing to the blocklist TODAY -- which is exactly the
  // M49/E10 shape it is written in: the first member a later milestone spells `needs_release` joins
  // the blocklist with no edit here, and the real protection is `SLAVE_LIFECYCLE_LABEL`, pinned by
  // `organization-page.test.tsx`.
  ...SLAVE_LIFECYCLES,
```

with `SLAVE_LIFECYCLES` added to the script's `packages/domain/dist` import list. Confirm the no-op is a no-op rather than a typo:

```bash
node -e "const {SLAVE_LIFECYCLES}=require('./packages/domain/dist/index.js');console.log(SLAVE_LIFECYCLES.filter(t=>t.includes('_')||t.includes('.')))"
```
Expected: `[]`.

```bash
CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
  SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
  npm run gate:m44-ux-foundation
```
Expected: PASS, with the same token count it printed in Task 4 plus zero.

- [ ] **Step 7: CI and the README**

`.github/workflows/ci.yml`, immediately after the `gate:m49-memory` step M49 added:

```yaml
      - run: npm run gate:m50-ephemeral
```

`README.md` — the roster sentence (`:770-776`) gains the gate by name after `gate:m49-memory`, and the trailing count (`:829`) moves from `24 gates` to `25 gates`. The paragraph gains one clause saying what m50 proves, in the voice of the m38/m39/m48 clauses beside it:

```
and `m50` drives one until the Supervisor asks for a specialist for exactly one assignment and an
ordinary hire for the gap two tasks share, hires the first when a person approves it, dispatches it
by role, and — once that one assignment is done — releases it by itself: roles emptied, worktree
gone, and every run, message and thing it learnt still exactly where it was.
```

- [ ] **Step 8: Regenerate the two screenshots**

```bash
pgrep -af "next dev"     # must print nothing
CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
  SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
  SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
  npm run gate:m14-fidelity
git status --porcelain docs/superpowers/fidelity/m14
```
`gate:m14-fidelity` rewrites all twelve PNGs and several of them differ run to run (the known m14 PNG nondeterminism in the carried backlog). Only the two this milestone actually changed are kept:

```bash
git add docs/superpowers/fidelity/m14/organization.png docs/superpowers/fidelity/m14/overview.png
git checkout -- docs/superpowers/fidelity/m14
git status --porcelain docs/superpowers/fidelity/m14
```
Expected: the last command prints only the two staged files. Open both and confirm by eye that the Organization tab shows a `Lifecycle` column and the Overview's team strip is unchanged apart from the chip — a PNG nobody looked at is not evidence.

- [ ] **Step 9: The full verification ladder**

Strictly one vitest at a time, nothing else touching the database:

```bash
npm run --silent typecheck
npx tsc --build
npm run gate:m26-vocabulary
npm test
```
Expected: `npm test` reports **at least 312 test files and at least 4858 tests, all passing**. A lower file count means a test file was deleted; a lower test count means a case was.

Then the gates this milestone could have moved, one at a time, each with `CHROMIUM_PATH`/`SLAVEOFAI_CLAUDE_BIN`/`SLAVEOFAI_REQUIRE_FAKE_CLI` set as above and `pgrep -af "next dev"` empty before each:

```bash
npm run gate:m38-supervisor
npm run gate:m44-ux-foundation
npm run gate:m45-project-experience
npm run gate:m47-team-formation
npm run gate:m48-runbooks
npm run gate:m49-memory
npm run gate:m50-ephemeral
```
Expected: all seven green. `gate:m47-team-formation` is the one to watch — its `security.application` gap is one task's, so its proposal is now `temporary: true`; it asserts the action's KIND, tier, status and rationale and not the flag (checked in Task 1 Step 6), so it must pass unchanged. If it does not, report it rather than editing the gate: the M47 gate is unchanged by ruling.

- [ ] **Step 10: Commit**

Two commits — the code, then the pictures, so a screenshot diff never hides a code change:

```bash
git add scripts packages/providers/test/fixtures/plan-graph-lifecycle.ndjson package.json .github/workflows/ci.yml README.md
git commit -m "$(cat <<'EOF'
test(gate): m50 t5 — one assignment, one release, and everything the worker produced still there

`gate:m50-ephemeral` drives a real daemon and the fake CLI through the whole ruling: one plan whose
security gap belongs to a single startable task and whose QA gap two tasks share, two proposals that
differ only in `temporary`, a human approving the first through the real `approve-decision`, a
worker dispatched by role for the one assignment it was hired for, and then a tick that releases it
by itself -- roles emptied, worktree gone from disk, and the run count, the context count, the event
count and the memory count identical on both sides of the release. The released worker is never
picked again (a fresh gap for the same key names the template, not them), never promoted by ten more
ticks, and moved by hand only through `set-lifecycle`. CI's 25th gate.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"

git add docs/superpowers/fidelity/m14/organization.png docs/superpowers/fidelity/m14/overview.png
git commit -m "$(cat <<'EOF'
docs(m14): regenerate the organization and overview screenshots for the lifecycle column

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

## Self-review

**1. Spec coverage.**

| Spec | Where it lands |
|---|---|
| R1 the lifecycle is a column set at the creation site, never derived (the enum, five columns, the three derivations replaced, the migration with its ONE data statement, the domain vocabulary and its labels, the seed) | Task 1 Steps 3 (`SLAVE_LIFECYCLES`, `SLAVE_LIFECYCLE_LABEL`), 19 (the enum, the five columns, the migration, the seed, the parity assertion) and 20 (the diff proof and the data statement's own check); Task 2 Steps 9 (`assignCompanyTx`, `materialiseCompanySlave` and `hireFromTemplate` write it; the rationale suffix goes) and 10 (`listOrganization`'s derivation replaced); Task 4 Step 3 (`organization.ts`'s) and Step 7 (`brief.ts`'s) |
| R2 one assignment: `formTeam` emits `temporary`, `TeamInput.requiredBy`, `actionOf('temporary')`, the action's `engagementTaskId`, `carryOut` passing it, the refined reuse rule, tier stays `proposed` | Task 1 Steps 5–8 (the rule and its five cases), 12 (the action's field), 14 (`requiredBy`, the roster filter, `actionOf`); Task 2 Steps 9 (the reuse rule and the create) and 11 (`carryOut`); the tier is unchanged and pinned by Task 1 Step 9's `expect(offers[0]?.tier).toBe('proposed')` |
| R3 release is routine, never a deletion (situation 15, action 15, tier `applied`, `releaseWorker` with its four refusals, the empty role set, the third collect reason, the 53rd event, the exclusions, `deleteSlave` untouched) | Task 1 Steps 9–14 (the situation, the action, the tier, the predicate, the two exclusions) and 18 (the event, the lane, the reason); Task 2 Steps 3–6 (the verb, the refusals, the collect reason and the actor) and 11 (`carryOut`'s arm). `deleteSlave` appears in no task's file list, which is how it stays unchanged |
| R4 never auto-promoted; a person may (`setLifecycle` with its three rules, `org.changed.field 'lifecycle'`, the three CLI verbs) | Task 1 Steps 18 (the field) and 21 (`ORG_CHANGED_LABEL`); Task 2 Steps 3–4 (the verb and `not_in_roster`); Task 3 Step 3 (all three verbs); Task 4 Step 9 (the lifecycle route); Task 5 stage 7 ("ten more ticks, still ephemeral") and stage 8 |
| R5 evidence persists | Task 2 Step 1's first case (runs, contexts, capabilities, rationale and template link all asserted after a release) and Task 5 stage 5/6's four counts, captured before and compared after |
| R6 surfaces: the row's chip and released line, the brief and `SlaveCard`, the Slaves table column, `docs/ia.md`, `RAW_TOKENS`, the two routes | Task 4 Steps 1–10 (all five surfaces, both routes, the IA row); Task 5 Step 6 (`RAW_TOKENS`) |
| R7 the gate, README 24→25, CI after m49, the two PNGs | Task 5 Steps 2–8, with the nine stages enumerated and their assertions named |
| §2 surfaces (every module, column, kind, verb and file listed there) | Every one appears in a task's **Interfaces → Produces** block: the two domain modules, `requiredBy`, the emission, the situation, the action, the event, the two world fields in Task 1; the two control verbs, the four creation sites, the loader fields, the `carryOut` arm, the three refusal kinds and the collect reason in Task 2; the three CLI verbs in Task 3; the four web surfaces and the two routes in Task 4; the gate in Task 5 |
| §3 out of scope | No budget or cost cap is read anywhere (no task touches `budget.ts` or `stats.ts`); nothing deletes (`deleteSlave` is in no file list and `releaseWorker`'s docstring says so); a released worker is never re-hired (the reuse read requires `releasedAt: null`); no session or provider handle is revoked (no task touches `sweep.ts`, `kill.ts` or `pump.ts`); no permission is read (M52); nothing ranks (M53); there is no lifecycle editor UI — the two routes exist for the gate and the CLI, and no component posts to them |

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Four places name the exact file to copy a shape from instead of reprinting it, and each states what it must produce: Task 2 Step 1's `afterAll` teardown (the FK order is spelled out and `capability.test.ts` is named as the shape), Task 2 Step 12's `recordDecision`/`applyDecision` arguments (the `discard_stale_candidates` case directly above is named as the source, and the assertions are given in full), Task 5 Step 4's gate script (nine stages with their assertions, the constants given, the borrowed scaffolding named function by function, and the two things the implementer may not improvise past called out), and Task 5 Step 2's two persona files (the section list, the front matter and the one capability bullet each are given verbatim; only the prose under the other headings is the implementer's). Three steps deliberately end in a CHECK rather than an edit — Task 1 Step 6's `grep` over the m47 gate, Task 3 Step 3's `grep` for a `Principal` helper, Task 4 Step 5's `grep` for `AllSlavesTable`'s real props — because each is a fact about the current code that a plan should verify rather than assert.

**3. Type consistency.** `SlaveLifecycle`, `SLAVE_LIFECYCLES`, `SLAVE_LIFECYCLE_LABEL`, `ReleasableWorker` and `isReleasable` are spelt once (Task 1 Step 3) and consumed under those names in Task 1 (`observe`, `SupervisorSlave`), Task 2 (`setLifecycle`, `OrganizationWorker`), Task 3 (the CLI's validation), Task 4 (all five surfaces and the lifecycle route) and Task 5 (`RAW_TOKENS`). `TeamProposal.engagementTaskId` is produced by `formTeam` (Task 1 Step 7), read by `actionOf` (Step 14) and by nothing else; `Action`'s `engagementTaskId` is produced there, validated by `actionSchema` (Step 12), and read only by `carryOut` (Task 2 Step 11). `TeamInput.requiredBy` is declared in Step 7 and filled in exactly one production place, `teamPlanOf` (Step 14), plus the test helper (Step 5). `releaseWorker(slaveId, reason, principal?)` and `setLifecycle(slaveId, lifecycle, principal?)` have the same three parameters at all four call sites each — `carryOut`, the CLI, the route and the tests. `collectTaskWorktree`'s widened reason is spelt `'aged' | 'operator' | 'released'` in all three of E5's places and nowhere else. The `released` VIEW field is `{ at: string; reason: string } | null` on `OrganizationWorker` (Task 2), `OrganizationRow` (Task 4), `ProjectBrief.team[]`, `SlaveCardData`, `WorkerRow` and `AllSlaveRow` — one shape, six carriers, each built by the same `releasedAt === null ? null : { at: releasedAt.toISOString(), reason: releaseReason ?? 'released' }` expression — while `SupervisorSlave.released` is a plain `boolean`, because the domain decides with it and never renders it. The `slave.released` payload's four keys are declared in Task 1 Step 18, written in Task 2 Step 4, read by the card in Task 1 Step 21 and asserted by the gate in Task 5 stage 6, spelled `{ slaveId, name, reason, worktreesCollected }` in all four.
