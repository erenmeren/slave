# M45 Project Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening a project answers eight questions in about ten seconds — objective, Supervisor state, current work, team, what needs you, the latest verified result, what it has cost, what changed lately — above one Supervisor timeline whose entries are organisational events in six lanes, with the decisions a human must take answerable in place and one input to tell the Supervisor what changed.

**Architecture:** Three pure domain additions carry the words and the classification (`userSupervisorStatus` in `packages/domain/src/status/user.ts`, `laneFor`/`replanSentence` in `packages/domain/src/supervisor/timeline.ts`, `composeGoal` in `packages/domain/src/goal/compose.ts`); one control verb (`requestChange`) and one additive column (`GoalVersion.request`) turn a sentence into a goal version through the transaction `setGoal` already holds; three read-model builders (`server/brief.ts`, `server/needsYou.ts`, `server/timeline.ts`) are composed into the existing `OverviewSnapshot` so the page keeps exactly one SSE stream; and the Overview is rebuilt from `PageShell` + `ProjectBrief` + `SupervisorRequest` + `SupervisorTimeline` + the Team strip, with every panel that leaves the first viewport moved under `Advanced ▾` rather than removed. No new autonomy: every mutation goes through an existing verb.

**Tech Stack:** TypeScript monorepo, Next.js 15 App Router + React 19, Tailwind v4 (configured by `@theme inline` inside `apps/web/src/app/globals.css` — there is no `tailwind.config.*`), vitest (two projects: `unit`, `integration`), Prisma 7 + Postgres (:5433), plain-`node` `.mjs` gates driving `playwright-core`.

**Spec:** `docs/superpowers/specs/2026-09-10-m45-project-experience-design.md` (rulings R1–R7; §4 errata). Its parents are `docs/superpowers/specs/2026-09-10-roadmap-m44-m56.md` and `docs/ia.md` (M44's contract, which M45 reads before adding a surface). M46 rebuilds the Workforce catalog on this and **must not be pre-built here**.

Plan-time errata, every one read out of the code and baked into the tasks below (the long form, with file and line evidence, is in the session notes):

- **E1 (amends R1) — "exactly ten facts" is eight fields.** `objective`, `supervisor`, `work`, `team`, `needsYou`, `latestVerified`, `cost`, `recentChanges`. The roadmap row names the same eight. The gate asserts eight, not ten.
- **E2 (amends R1) — the cost fact must not invent a second total.** `workspaceSpend()` (`packages/control/src/spend.ts`) is THE formula; the header's budget bar, the Overview strip and the scheduler's guardrail all read it, and M24 §2.2 / M38 t5 exist because a second, smaller figure once shrank the bar on a tab change. The brief carries `cost { spentUsd, measuredUsd, unmeasuredCalls, budgetUsd }` — no new arithmetic.
- **E3 (amends R1) — `userSupervisorStatus` cannot take a `SupervisorReport`.** `report.supervisor.pending` counts only decisions inside `DECISION_WINDOW_MS` (`packages/control/src/supervisorWorld.ts:452`), so it under-counts an older open proposal. The signature is `userSupervisorStatus(facts: UserSupervisorFacts)`; the count comes from `listDecisions(workspaceId, { pending: true })`. `WATCHING` gets the rule the spec's precedence chain omits ("enabled, nothing active, open work on the board"), and `HALTED, NEEDS YOU` is ONE label.
- **E4 (amends R2) — `task.created` has no human writer, and `goalVersion > 1` is the wrong test.** It is appended in exactly two places (`apps/orchestrator/src/planning.ts:149`, `apps/orchestrator/src/replan.ts:397`), both `actor: 'slave'`. `goalVersion > 1` is wrong in both directions: a first plan's tasks are v1 and are still a plan change, a hand-made task on a v3 project is not. The discriminator is the envelope's `actor`; the `human` branch is written and tested so a future create-task verb needs no change here.
- **E5 (amends R2) — the lane table is what makes the classification exhaustive.** The domain exports no runtime list of event types, so `LANE_BY_TYPE: Record<ExecutionEvent['type'], TimelineLane | null>` is the build-time guarantee: a fiftieth event type fails the build here rather than vanishing from the timeline.
- **E6 (amends R3) — `requestChange` must compose INSIDE the lock.** `setGoal` reads `goalVersion` under `SELECT … FOR UPDATE` and appends its event after the commit. Composing outside and calling `setGoal` would compose against a body a concurrent set may already have replaced. Both verbs share one internal `writeGoalVersion(workspaceId, textOf, principal, request)` taking the new text as a callback over the previous one.
- **E7 (amends R3) — a project with no goal yet.** `composeGoal(previous: string | null, …)`: when `previous` is `null` the request text IS the goal body, with no `Requested changes` section.
- **E8 (amends R3) — a blank request needs its own refusal.** `invalid_goal` reads "a goal must be a non-empty text", which is not what happened. New kind `invalid_request`: one union member, one `refusalText` case, one key in `apps/web/test/refusal-status.test.ts`'s `ALL_KINDS`.
- **E9 (amends R3) — the CLI's `[--by]` is dropped.** `GoalVersion.setByUserId` needs a `User` row and `cli.ts` resolves no principal; `set-goal` passes none either.
- **E10 (amends R2) — there is no web unblock route.** `unblockTask` (`packages/control/src/unblock.ts:96`) has none. `POST /api/w/:id/tasks/:taskId/unblock` is added — a thin wrapper, no new autonomy.
- **E11 (amends R1/R2) — nor is there a web integration verb.** `confirmIntegration` is control/CLI only, so the `integrate` needs-you item is a LINK to `/w/:id/tasks?task=<id>`, not an inline action.
- **E12 (amends R2) — `ProposalRow`/`DraftEditor` are module-private.** They are `export`ed in place (one word each) rather than moved, so `apps/web/test/supervisor-panel.test.tsx` (633 lines) keeps passing untouched.
- **E13 (amends R7) — `gate:m11-shell` has no Overview selectors to repoint.** It touches `/w/<id>` for `project-header` and `budget` only (`scripts/gate-m11-shell.mjs:445-446`), both rendered by the project LAYOUT. The ladder re-runs it to prove it.
- **E14 (amends R7) — `timeline-rule` at 88 px is an ACTIVITY assertion** (`scripts/gate-m14-fidelity.mjs:911`). Overview's own m14 pins are `strip`, `slave-card` radius 8 / padding 12×13, `avatar-tile` 28×28, `slave-card status-pill` radius 20, `live-events` 340 px, plus stage 3b's `card-sweep`/`status-pulse` and stage 4b's pill reading `WORKING`.
- **E15 (settles the 340 px question) — keep the panel, teach the gate to open the disclosure.** The river moves under `Advanced ▾` keeping `data-testid="live-events"` and `w-[340px]`; `NUMBERS` gains a per-row `prepare` hook that clicks `overview-advanced` first. Deleting the assertion would leave a README number unmeasured; keeping the panel in the first viewport would defeat R1; and `getComputedStyle` on a closed disclosure's subtree returns `auto`, so the DOM-only option does not work.
- **E16 (settles the Team-strip question) — the Team strip IS the existing `SlaveCard` grid.** `SlaveCard` renders on the Overview and nowhere else, so a worker-row rewrite would delete six fidelity assertions with no page left to host them. The card already is "projected word · name · role · current task"; R4's second clause — the expanded view under `Details ▾` groups — is the real work and lands in Task 4.
- **E17 (amends R1/§2) — `TopStrip` stays, under the brief.** `data-testid="strip"` is m14's Overview page marker and its halt-clear wait's selector, and the README documents its six tiles. The brief's `work` tile speaks the domain's projected words; the strip keeps the raw counts, deliberately, and says so in its docblock.
- **E18 (amends R5, M44 E25) — `PageShell` is not pixel-neutral as it stands** (`gap-4 p-3 md:p-4` against pages that carry `px-[20px] pt-[16px]` gutters). It gains `flush?: boolean`, and every project page adopts `<PageShell flush>`.
- **E19 (settles the route question) — extend `/overview`, do not add two routes.** `useWorkspaceStream` refetches exactly one `endpoint` and the page owns exactly one `EventSource`. `OverviewSnapshot` gains `brief`, `needsYou` and `timeline`; the three builders live in their own modules and `buildOverviewSnapshot` composes them.
- **E20 (amends R1's `needsYou`) — the queue is four sources, not one predicate.** Pending decisions have no task column (`subjectId` may be a task id, a message id, a role name or the workspace's own id), so they are counted as ROWS — exactly the split `docs/ia.md` now records for the project card.
- **E21 (amends R2) — the interpretation sentence needs titles the payload does not carry.** `replanSentence(payload, titlesById)` is pure and lives in the domain; `server/timeline.ts` supplies the titles from the board read it already makes.
- **E22 (amends §2) — three more panels move under `Advanced ▾`.** `SupervisorPanel`, `BlockedPanel` and `MergeQueuePanel` join the live-events river there; "no removal" means moved, not gone.
- **E23 (amends R7) — the m45 gate writes its own fixture rows,** for the same reason m44's did: the seeded database has no `SupervisorDecision`, no pending question and no un-integrated `done` task, so "exactly four needs-you entries" would pass against an empty page.
- **E24 — the optional `request` breaks nothing downstream.** `workspace.goal_set.payload.request?` is additive, so `parseExecutionEvent` still accepts every stored row and `apps/web/test/activity-cards.test.tsx`'s `PAYLOAD_BY_TYPE` (minimal valid payloads) needs no entry change.
- **E25 (amends R1) — there is no `supervisor.approved` event.** The schema has `supervisor.applied` and `supervisor.resolved { outcome: 'approved' | 'rejected' | 'expired' }`. The digest reads `workspace.*`, `org.changed`, `slave.profile_changed`, `slave.runtime_roles_changed`, `supervisor.applied`, `supervisor.resolved`.
- **E26 — the lane table has 49 members today.** `EVENT_TYPE_BY_DOMAIN_TYPE` (`packages/db/src/enums.ts`) carries 49 entries; the test asserts the count so an addition is noticed rather than merely accepted.

## Global Constraints

- **Never a real model call.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and the fake CLI `packages/providers/test/fake-claude.mjs`; the fidelity gate and the browser gates use `scripts/gate-fakes/fake-claude.sh` through `SLAVEOFAI_CLAUDE_BIN`.
- One vitest process at a time (the shared test database truncates), and **never a gate beside vitest**.
- **`npm run web:build` never while `next dev` is running.** Before any `web:build`, run `pgrep -af "next dev"`; if one is up, `kill <pid>` it and **say so in the task report**. Restarting dev afterwards needs `rm -rf apps/web/.next` first.
- **No prettier.** There is no prettier config in this repository; match the surrounding file's style by hand.
- Inside `apps/web`, import siblings **without** a `.js` suffix (`../server/overview`, not `../server/overview.js`); `packages/*` keep the `.js` suffix.
- **README pixel values are unchanged** — `design_handoff_ai_team_os/README.md`'s numbers (212px sidebar, 52px top bar, radius 8, pill 20, 340px live panel, rule at x=88px, 352px drawer, 28×28 tile) stay exactly as they are **unless a `gate:m14-fidelity` assertion is updated in the same task with the reason stated in the commit** (Task 5 does this once, for E15, and changes no number).
- **No functionality is removed.** Anything that leaves the first viewport goes under `Advanced ▾` and is recorded in `docs/ia.md`.
- The vocabulary word is **slave**. `npm run gate:m26-vocabulary` after every task.
- Refusals are `ok()` / `err()`; **a refusal after a write inside `$transaction` must throw**, or Prisma commits that write.
- **Migrations are additive and applied to both databases** (`npm run db:migrate` and `npm run db:migrate:test`) with the Prisma 7 diff proof: `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` → "No difference detected".
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
  ```
- Every task ends with focused tests, `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck` and a commit. Web tasks also run `npm run web:build` (subject to the `next dev` rule above) and, where a page changed, `npm run gate:m44-ux-foundation` as the browser check.
- Anything touching the database goes under `test/integration/` and is named `*.test.ts` — `vitest.config.ts`'s `integration` project includes `**/test/integration/**/*.test.ts` only (no `.tsx`), and only that project loads `test-setup/require-database.ts`.
- **The implementer never dispatches subagents.**

---

## File structure

```
packages/domain/src/status/user.ts                     R1/E3: userSupervisorStatus + its facts and labels
packages/domain/src/supervisor/timeline.ts             R2/E5/E21: TIMELINE_LANES, LANE_LABEL, LANE_BY_TYPE, laneFor, replanSentence (new)
packages/domain/src/supervisor/index.ts                + ./timeline.js
packages/domain/src/goal/compose.ts                    R3/E7: composeGoal (new)
packages/domain/src/goal/index.ts                      + ./compose.js
packages/domain/src/events/schema.ts                   R3/E24: workspace.goal_set.payload.request?
packages/domain/test/status/user.test.ts               + the Supervisor state cases
packages/domain/test/supervisor/timeline.test.ts       exhaustive over LANE_BY_TYPE (new)
packages/domain/test/goal/compose.test.ts              (new)
packages/domain/test/events/schema.test.ts             + the request round-trip

packages/db/prisma/schema.prisma                       R3: GoalVersion.request String?
packages/db/prisma/migrations/20260910210000_m45_goal_request/migration.sql   (new)

packages/control/src/goal.ts                           E6: writeGoalVersion, setGoal(..., options), requestChange
packages/control/src/refusal.ts                        E8: invalid_request
packages/control/src/index.ts                          + requestChange
packages/control/test/integration/goal.test.ts         + requestChange cases
apps/orchestrator/src/cli.ts                           R3/E9: request-change
apps/orchestrator/test/integration/cli.test.ts         + request-change cases

apps/web/src/server/brief.ts                           R1: buildProjectBrief (new)
apps/web/src/server/needsYou.ts                        R1/E20: buildNeedsYou (new)
apps/web/src/server/timeline.ts                        R2/E19: buildSupervisorTimeline (new)
apps/web/src/server/overview.ts                        E19: OverviewSnapshot gains brief/needsYou/timeline
apps/web/src/app/api/w/[workspaceId]/goal/request/route.ts       R3 (new)
apps/web/src/app/api/w/[workspaceId]/tasks/[taskId]/unblock/route.ts  E10 (new)
apps/web/test/integration/brief.test.ts                (new)
apps/web/test/integration/needs-you.test.ts            (new)
apps/web/test/integration/supervisor-timeline.test.ts  (new)
apps/web/test/refusal-status.test.ts                   E8: invalid_request

apps/web/src/components/ui/PageShell.tsx               E18: flush
apps/web/src/components/ui/DetailsGroup.tsx            R4 (new)
apps/web/src/components/project/ProjectBrief.tsx       R1 (new)
apps/web/src/components/project/SupervisorRequest.tsx  R3 (new)
apps/web/src/components/project/SupervisorTimeline.tsx R2 (new)
apps/web/src/components/project/OverviewAdvanced.tsx   E22 (new)
apps/web/src/components/OverviewClient.tsx             R1/R2/E16/E17/E22: the new page order
apps/web/src/components/SupervisorPanel.tsx            E12: export ProposalRow, DraftEditor
apps/web/src/components/TaskCard.tsx                   R4/D4: projected word + the one-line why
apps/web/src/components/TaskDetailPanel.tsx            R4: Details groups
apps/web/src/components/SlavePanel.tsx                 R4: Details groups
apps/web/src/lib/tones.ts                              D4: the board pill reads userTaskStatus
apps/web/src/components/activity/cards.tsx             E24: the goal_set card shows the request
apps/web/test/{overview-components,tasks-components,slave-panel,activity-cards}.test.tsx   updated
apps/web/test/project-brief.test.tsx                   (new)
apps/web/test/supervisor-timeline.test.tsx             (new)

apps/web/src/app/w/[workspaceId]/{page,tasks,activity,settings,graph,office}   E18: PageShell flush
apps/web/src/components/{ProjectsClient,AnalyticsClient,SettingsClient}.tsx    E18/R5
apps/web/src/components/sim/SimulationsClient.tsx                              E18/R5

scripts/gate-m45-project-experience.mjs                R7 (new)
scripts/gate-m14-fidelity.mjs                          E15: the NUMBERS prepare hook
docs/superpowers/fidelity/m14/*.png                    regenerated, own commit
docs/ia.md                                             the Overview/Tasks rows, and where the four panels went
package.json, .github/workflows/ci.yml, README.md      gate:m45-project-experience; roster 19 -> 20; ## One Supervisor
```

---

### Task 1: The domain words, the lane table, `composeGoal`, `requestChange` and its column (R1/R2/R3)

**Files:**
- Modify: `packages/domain/src/status/user.ts` (append a Supervisor section after the Workspaces one), `packages/domain/src/supervisor/index.ts`, `packages/domain/src/goal/index.ts`, `packages/domain/src/events/schema.ts:209-217`, `packages/db/prisma/schema.prisma:145-161`, `packages/control/src/goal.ts`, `packages/control/src/refusal.ts`, `packages/control/src/index.ts`, `apps/orchestrator/src/cli.ts`, `apps/web/test/refusal-status.test.ts`
- Create: `packages/domain/src/supervisor/timeline.ts`, `packages/domain/src/goal/compose.ts`, `packages/db/prisma/migrations/20260910210000_m45_goal_request/migration.sql`
- Test: `packages/domain/test/status/user.test.ts` (append), `packages/domain/test/supervisor/timeline.test.ts` (new), `packages/domain/test/goal/compose.test.ts` (new), `packages/domain/test/events/schema.test.ts` (append), `packages/control/test/integration/goal.test.ts` (append), `apps/orchestrator/test/integration/cli.test.ts` (append)

**Interfaces:**
- Consumes: `UserStatus<S>`, `needsYou`, `userTaskStatus` (`packages/domain/src/status/user.ts`); `ExecutionEvent` (`packages/domain/src/events/schema.ts`); `setGoal`'s existing transaction (`packages/control/src/goal.ts`); `ControlRefusal`, `refusalText`.
- Produces, for Tasks 2–5:
  - `userSupervisorStatus(facts: UserSupervisorFacts): UserStatus<UserSupervisorState>`, `UserSupervisorState = 'halted' | 'off' | 'decisions' | 'answering' | 'working' | 'watching' | 'idle'`, `UserSupervisorFacts = { halted: boolean; enabled: boolean; pendingDecisions: number; pendingQuestions: number; tasksActive: number; tasksOpen: number }`, `USER_SUPERVISOR_LABEL`.
  - `TIMELINE_LANES`, `TimelineLane`, `LANE_LABEL: Record<TimelineLane, string>`, `LANE_BY_TYPE`, `laneFor(subject: TimelineSubject): TimelineLane | null`, `TimelineSubject = { source: 'event'; type: ExecutionEvent['type']; actor: 'human' | 'slave' | 'system' } | { source: 'decision' }`, `replanSentence(payload: ReplanSentenceFacts, titles: Readonly<Record<string, string>>): string`.
  - `composeGoal(previous: string | null, request: string, at: Date): string`, `REQUESTED_CHANGES_HEADING`.
  - `requestChange(workspaceId: string, request: string, principal?: Principal, at?: Date): Promise<Result<{ version: number; sha256: string; goal: string }, ControlRefusal>>`.
  - `setGoal(workspaceId, goal, principal?, options?: { readonly request?: string })` — the fourth parameter is new and optional; no existing call site changes.
  - `GoalVersion.request: string | null`; `workspace.goal_set.payload.request?: string`.
  - CLI `request-change --workspace <id> --request "<text>"`, printing `{"version":N,"sha256":"…","goal":"…"}`.

- [ ] **Step 1: Write the failing test for `userSupervisorStatus`**

Append to `packages/domain/test/status/user.test.ts`:

```ts
describe('userSupervisorStatus', () => {
  const base = {
    halted: false, enabled: true, pendingDecisions: 0, pendingQuestions: 0, tasksActive: 0, tasksOpen: 0,
  }

  it('halted beats everything, and says a person is needed', () => {
    const status = userSupervisorStatus({ ...base, halted: true, enabled: false, pendingDecisions: 3 })
    expect(status.state).toBe('halted')
    expect(status.label).toBe('HALTED, NEEDS YOU')
    expect(status.needsYou).toBe(true)
  })

  it('a switched-off Supervisor says so, even with work in flight', () => {
    const status = userSupervisorStatus({ ...base, enabled: false, tasksActive: 4 })
    expect(status.state).toBe('off')
    expect(status.label).toBe('OFF')
    expect(status.needsYou).toBe(false)
  })

  it('pending decisions are counted into the label and need a person', () => {
    expect(userSupervisorStatus({ ...base, pendingDecisions: 1 }).label).toBe('1 DECISION WAITING')
    const many = userSupervisorStatus({ ...base, pendingDecisions: 3, pendingQuestions: 2, tasksActive: 5 })
    expect(many.state).toBe('decisions')
    expect(many.label).toBe('3 DECISIONS WAITING')
    expect(many.needsYou).toBe(true)
  })

  it('an unanswered question outranks work in flight', () => {
    const status = userSupervisorStatus({ ...base, pendingQuestions: 1, tasksActive: 2 })
    expect(status.state).toBe('answering')
    expect(status.label).toBe('ANSWERING')
    expect(status.needsYou).toBe(false)
  })

  it('work in flight reads WORKING', () => {
    expect(userSupervisorStatus({ ...base, tasksActive: 1, tasksOpen: 6 }).state).toBe('working')
  })

  it('open work with nothing active is WATCHING, and an empty board is IDLE', () => {
    expect(userSupervisorStatus({ ...base, tasksOpen: 2 }).state).toBe('watching')
    expect(userSupervisorStatus(base).state).toBe('idle')
  })
})
```

Add `userSupervisorStatus` to the file's existing import from `../../src/status/user.js`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit packages/domain/test/status/user.test.ts`
Expected: FAIL — `userSupervisorStatus is not a function` / TS2305.

- [ ] **Step 3: Implement it**

Append to `packages/domain/src/status/user.ts`:

```ts
// ---------------------------------------------------------------------------------------------
// The Supervisor
// ---------------------------------------------------------------------------------------------

export type UserSupervisorState =
  | 'halted'
  | 'off'
  | 'decisions'
  | 'answering'
  | 'working'
  | 'watching'
  | 'idle'

/**
 * The facts one word about the Supervisor is decided from (M45 R1).
 *
 * A FACT BAG, not a `SupervisorReport`. `report.supervisor.pending` counts only the decisions
 * inside `loadSupervisorWorld`'s `DECISION_WINDOW_MS` window, so a proposal older than that window
 * -- still open, still waiting on a person -- would not be counted, and the word would be wrong in
 * exactly the case it matters most (M45 plan erratum E3). `pendingDecisions` is the length of
 * `listDecisions(workspaceId, { pending: true })`, which has no window.
 *
 * `tasksActive` is the same widened list `server/overview.ts` counts (`ready`, `running`,
 * `verifying`, `reviewing`, `merging`, `rework`, `waiting`); `tasksOpen` is every non-terminal
 * task, which is what tells "watching a board that has work left" from "nothing to watch".
 */
export interface UserSupervisorFacts {
  readonly halted: boolean
  /** `Workspace.supervisorEnabled`. False means "it reports but decides nothing". */
  readonly enabled: boolean
  readonly pendingDecisions: number
  readonly pendingQuestions: number
  readonly tasksActive: number
  readonly tasksOpen: number
}

/** The six fixed words. `decisions` is absent because its label carries a count. */
export const USER_SUPERVISOR_LABEL: Record<Exclude<UserSupervisorState, 'decisions'>, string> = {
  halted: 'HALTED, NEEDS YOU',
  off: 'OFF',
  answering: 'ANSWERING',
  working: 'WORKING',
  watching: 'WATCHING',
  idle: 'IDLE',
}

/**
 * One word for what the Supervisor is doing (M45 R1).
 *
 * The order is the spec's precedence, and each step is a different question: is this project
 * stopped; is the Supervisor switched off; is it waiting on ME; is it waiting on an answer; is
 * anything running; is there anything left to watch. `watching` is the state the spec's own
 * precedence chain omitted (plan erratum E3) -- enabled, nothing active, a board that still has
 * work on it -- and it is the difference between a quiet project and a finished one.
 *
 * `needsYou` is true for exactly two of the seven: a halted project needs a person to release it,
 * and a pending decision needs a person to answer it. A switched-off Supervisor needs nothing:
 * somebody already decided that.
 */
export function userSupervisorStatus(facts: UserSupervisorFacts): UserStatus<UserSupervisorState> {
  const state: UserSupervisorState = facts.halted
    ? 'halted'
    : !facts.enabled
      ? 'off'
      : facts.pendingDecisions > 0
        ? 'decisions'
        : facts.pendingQuestions > 0
          ? 'answering'
          : facts.tasksActive > 0
            ? 'working'
            : facts.tasksOpen > 0
              ? 'watching'
              : 'idle'
  const label =
    state === 'decisions'
      ? `${String(facts.pendingDecisions)} DECISION${facts.pendingDecisions === 1 ? '' : 'S'} WAITING`
      : USER_SUPERVISOR_LABEL[state]
  return { state, label, needsYou: state === 'halted' || state === 'decisions' }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run --project unit packages/domain/test/status/user.test.ts`
Expected: PASS, every existing case in the file included.

- [ ] **Step 5: Write the failing test for the lane table**

Create `packages/domain/test/supervisor/timeline.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '@slave-of-ai/db'
import {
  LANE_BY_TYPE,
  LANE_LABEL,
  TIMELINE_LANES,
  laneFor,
  replanSentence,
  type TimelineLane,
} from '../../src/supervisor/timeline.js'

describe('LANE_BY_TYPE', () => {
  it('classifies every event type the database can store, and no more', () => {
    expect(Object.keys(LANE_BY_TYPE).sort()).toEqual(Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE).sort())
  })

  it('carries the 49 members the schema has today -- a fiftieth is a deliberate decision', () => {
    expect(Object.keys(LANE_BY_TYPE)).toHaveLength(49)
  })

  it('every value is a lane this file names, or null', () => {
    for (const [type, lane] of Object.entries(LANE_BY_TYPE)) {
      expect(lane === null || (TIMELINE_LANES as readonly string[]).includes(lane), type).toBe(true)
    }
  })

  it('every lane has at least one member, so no filter is dead', () => {
    const used = new Set<TimelineLane | null>(Object.values(LANE_BY_TYPE))
    // `decision` is the one lane no EVENT reaches: it holds SupervisorDecision rows.
    for (const lane of TIMELINE_LANES) {
      if (lane === 'decision') continue
      expect(used.has(lane), lane).toBe(true)
    }
    expect(LANE_LABEL.decision).toBe('DECISION REQUIRED')
  })

  it('model chatter never reaches the timeline', () => {
    expect(LANE_BY_TYPE['run.tool_call']).toBeNull()
    expect(LANE_BY_TYPE['run.output']).toBeNull()
    expect(LANE_BY_TYPE['run.started']).toBeNull()
  })
})

describe('laneFor', () => {
  it('puts a pending decision in DECISION REQUIRED', () => {
    expect(laneFor({ source: 'decision' })).toBe('decision')
  })

  it('reads a goal set as the user request it is', () => {
    expect(laneFor({ source: 'event', type: 'workspace.goal_set', actor: 'human' })).toBe('user_request')
  })

  it('renders the re-plan pair as the interpretation', () => {
    expect(laneFor({ source: 'event', type: 'workspace.replan_started', actor: 'slave' })).toBe('interpretation')
    expect(laneFor({ source: 'event', type: 'workspace.replanned', actor: 'slave' })).toBe('interpretation')
  })

  it('splits task.created and task.cancelled on the ACTOR, not on a goal version', () => {
    expect(laneFor({ source: 'event', type: 'task.created', actor: 'slave' })).toBe('plan_change')
    expect(laneFor({ source: 'event', type: 'task.created', actor: 'human' })).toBe('user_request')
    expect(laneFor({ source: 'event', type: 'task.cancelled', actor: 'system' })).toBe('plan_change')
    expect(laneFor({ source: 'event', type: 'task.cancelled', actor: 'human' })).toBe('user_request')
  })

  it('keeps finished work apart from work in flight', () => {
    expect(laneFor({ source: 'event', type: 'task.started', actor: 'slave' })).toBe('work')
    expect(laneFor({ source: 'event', type: 'task.integrated', actor: 'system' })).toBe('verified')
    expect(laneFor({ source: 'event', type: 'task.verify_passed', actor: 'slave' })).toBe('verified')
  })

  it('answers null for anything the timeline does not show', () => {
    expect(laneFor({ source: 'event', type: 'run.tool_call', actor: 'slave' })).toBeNull()
  })
})

describe('replanSentence', () => {
  const titles = { 't1': 'Add checkout', 't2': 'Old pricing page', 't3': 'Legacy banner' }

  it('names what was added, what is proposed for cancellation and how many were kept', () => {
    expect(
      replanSentence({ version: 3, added: ['t1'], proposedCancellations: ['t2', 't3'], kept: 4 }, titles),
    ).toBe('understood v3: +Add checkout; proposes cancelling Old pricing page, Legacy banner; 4 kept')
  })

  it('says so when a re-plan changed nothing', () => {
    expect(replanSentence({ version: 2, added: [], proposedCancellations: [], kept: 5 }, titles)).toBe(
      'understood v2: nothing to add or cancel; 5 kept',
    )
  })

  it('falls back to the id when a title is gone', () => {
    expect(replanSentence({ version: 4, added: ['gone'], proposedCancellations: [], kept: 0 }, titles)).toBe(
      'understood v4: +gone; 0 kept',
    )
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run --project unit packages/domain/test/supervisor/timeline.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 7: Write `packages/domain/src/supervisor/timeline.ts`**

```ts
import type { ExecutionEvent } from '../events/schema.js'

/**
 * The six lanes a person reads a project's history in (M45 R2).
 *
 * ORGANISATIONAL events only. `run.tool_call` and `run.output` are what a model said while
 * working, and a timeline that carries them is the live-events river this milestone moved under
 * `Advanced` -- not the story of what the project decided. The Activity page keeps every event,
 * unfiltered, and is one link away.
 *
 * The order is the reading order: what you asked for, what was understood, what changed on the
 * board, what is happening, what needs you, what is finished.
 */
export const TIMELINE_LANES = [
  'user_request',
  'interpretation',
  'plan_change',
  'work',
  'decision',
  'verified',
] as const

export type TimelineLane = (typeof TIMELINE_LANES)[number]

export const LANE_LABEL: Record<TimelineLane, string> = {
  user_request: 'USER REQUEST',
  interpretation: 'SUPERVISOR INTERPRETATION',
  plan_change: 'PLAN CHANGE',
  work: 'WORK IN PROGRESS',
  decision: 'DECISION REQUIRED',
  verified: 'VERIFIED RESULT',
}

/**
 * Every event type on exactly one lane, or on none.
 *
 * `Record<ExecutionEvent['type'], ...>` is load-bearing and is the whole exhaustiveness guarantee
 * R2 asks for: a fiftieth event type fails the BUILD here rather than silently never appearing on
 * a timeline nobody thought to check (plan erratum E5). `null` is a real, deliberate answer -- the
 * event is real, it is on the Activity page, and it is not part of the organisation's story.
 *
 * `task.created` and `task.cancelled` carry their DEFAULT lane here; {@link laneFor} overrides
 * both when the envelope's actor is a person, because a task a human created or cancelled is a
 * request, not a plan change (plan erratum E4).
 */
export const LANE_BY_TYPE: Record<ExecutionEvent['type'], TimelineLane | null> = {
  // USER REQUEST
  'workspace.goal_set': 'user_request',
  // INTERPRETATION -- the delta IS the interpretation; no stored sentence exists (spec §3).
  'workspace.replan_started': 'interpretation',
  'workspace.replanned': 'interpretation',
  // PLAN CHANGE
  'task.created': 'plan_change',
  'task.cancelled': 'plan_change',
  'workspace.plan_created': 'plan_change',
  // WORK IN PROGRESS
  'task.started': 'work',
  'task.verifying': 'work',
  'task.review_started': 'work',
  'run.paused': 'work',
  'run.resumed': 'work',
  'slave.message_sent': 'work',
  // VERIFIED RESULT
  'task.verify_passed': 'verified',
  'task.review_approved': 'verified',
  'task.done': 'verified',
  'task.integrated': 'verified',
  // Everything else: real, kept, and not on this timeline.
  'task.rework': null,
  'task.failed': null,
  'task.verify_failed': null,
  'task.review_rejected': null,
  'task.merge_failed': null,
  'task.unblocked': null,
  'task.dependency_added': null,
  'task.dependency_removed': null,
  'task.worktree_collected': null,
  'run.started': null,
  'run.tool_call': null,
  'run.tool_denied': null,
  'run.output': null,
  'run.pause_requested': null,
  'run.resume_requested': null,
  'run.stopped': null,
  'run.succeeded': null,
  'run.failed': null,
  'slave.message_reassigned': null,
  'slave.profile_changed': null,
  'slave.runtime_roles_changed': null,
  'guardrail.tripped': null,
  'org.changed': null,
  'workspace.company_assigned': null,
  'workspace.settings_changed': null,
  'workspace.created': null,
  'workspace.archived': null,
  'workspace.restored': null,
  'supervisor.decided': null,
  'supervisor.proposed': null,
  'supervisor.applied': null,
  'supervisor.resolved': null,
  'supervisor.failed': null,
}

/** What the timeline classifies: a stored event, or a `SupervisorDecision` waiting on a person. */
export type TimelineSubject =
  | {
      readonly source: 'event'
      readonly type: ExecutionEvent['type']
      readonly actor: 'human' | 'slave' | 'system'
    }
  | { readonly source: 'decision' }

/** The lane this belongs on, or null for "not on this timeline". Pure and total. */
export function laneFor(subject: TimelineSubject): TimelineLane | null {
  if (subject.source === 'decision') return 'decision'
  if (subject.type === 'task.created' || subject.type === 'task.cancelled') {
    return subject.actor === 'human' ? 'user_request' : 'plan_change'
  }
  return LANE_BY_TYPE[subject.type]
}

/** The three numbers a `workspace.replanned` payload carries, plus how many tasks survived it. */
export interface ReplanSentenceFacts {
  readonly version: number
  readonly added: readonly string[]
  readonly proposedCancellations: readonly string[]
  readonly kept: number
}

/**
 * What the Supervisor understood, said in the only words the system honestly has: the delta the
 * re-plan produced (spec R2, and §3's rejection of a stored model-written sentence).
 *
 * Pure, so it can be tested with literals: the caller resolves ids to titles, because the payload
 * carries only ids (plan erratum E21). An id with no title left falls back to the id -- a task
 * deleted since the re-plan is still part of what happened.
 */
export function replanSentence(
  facts: ReplanSentenceFacts,
  titles: Readonly<Record<string, string>>,
): string {
  const name = (id: string): string => titles[id] ?? id
  const parts: string[] = []
  if (facts.added.length > 0) parts.push(`+${facts.added.map(name).join(', ')}`)
  if (facts.proposedCancellations.length > 0) {
    parts.push(`proposes cancelling ${facts.proposedCancellations.map(name).join(', ')}`)
  }
  if (parts.length === 0) parts.push('nothing to add or cancel')
  return `understood v${String(facts.version)}: ${parts.join('; ')}; ${String(facts.kept)} kept`
}
```

Add `export * from './timeline.js'` to `packages/domain/src/supervisor/index.ts`, after `./report.js`.

- [ ] **Step 8: Run it and watch it pass**

Run: `npx vitest run --project unit packages/domain/test/supervisor/timeline.test.ts`
Expected: PASS. If the count case fails, the schema has grown — add the new type to `LANE_BY_TYPE` with a deliberate lane or `null`, and update the number in the test and in the docblock. Do not change the assertion to read `Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE).length`: the literal is what makes an addition a decision.

- [ ] **Step 9: Write the failing test for `composeGoal`**

Create `packages/domain/test/goal/compose.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { REQUESTED_CHANGES_HEADING, composeGoal } from '../../src/goal/compose.js'

const AT = new Date('2026-09-10T11:22:33.000Z')

describe('composeGoal', () => {
  it('keeps the body and opens a dated Requested changes list', () => {
    expect(composeGoal('Ship the checkout flow.', 'Add Apple Pay', AT)).toBe(
      'Ship the checkout flow.\n\n## Requested changes\n\n- 2026-09-10: Add Apple Pay\n',
    )
  })

  it('appends to the list a second time instead of opening a second heading', () => {
    const first = composeGoal('Ship the checkout flow.', 'Add Apple Pay', AT)
    const second = composeGoal(first, 'Drop the gift-card page', new Date('2026-09-11T00:00:00.000Z'))
    expect(second).toBe(
      'Ship the checkout flow.\n\n## Requested changes\n\n- 2026-09-10: Add Apple Pay\n- 2026-09-11: Drop the gift-card page\n',
    )
    expect(second.split(REQUESTED_CHANGES_HEADING)).toHaveLength(2)
  })

  it('takes the request AS the goal when the project has none yet', () => {
    expect(composeGoal(null, 'Build a billing service', AT)).toBe('Build a billing service')
  })

  it('flattens a multi-line request onto one list entry', () => {
    expect(composeGoal('Body.', 'Add Apple Pay\n\nand Google Pay  ', AT)).toBe(
      'Body.\n\n## Requested changes\n\n- 2026-09-10: Add Apple Pay and Google Pay\n',
    )
  })

  it('is byte-stable: the same inputs always produce the same bytes', () => {
    expect(composeGoal('Body.', 'Add Apple Pay', AT)).toBe(composeGoal('Body.', 'Add Apple Pay', AT))
  })
})
```

- [ ] **Step 10: Run it and watch it fail**

Run: `npx vitest run --project unit packages/domain/test/goal/compose.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 11: Write `packages/domain/src/goal/compose.ts`**

```ts
/** The heading the request list lives under. A markdown H2, because a goal is a document an
 *  operator edits by hand in the Settings tab and a heading is what they will expect to find. */
export const REQUESTED_CHANGES_HEADING = '## Requested changes'

/** `YYYY-MM-DD` in UTC. `toISOString` and a slice, never a locale: the same instant must produce
 *  the same bytes on every machine, which is what makes {@link composeGoal} byte-stable. */
function dateStamp(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/**
 * The next goal document, after a person told the Supervisor what changed (M45 R3).
 *
 * PURE, and byte-stable: no clock is read here, no locale is consulted, and the same three
 * arguments always produce the same string. That matters because `setGoal` refuses a text whose
 * sha256 equals the current version's -- a composer that folded in "now" would make every request
 * a new version even when nothing was asked.
 *
 * The document KEEPS ITS BODY. A request is not a new requirement, it is an amendment to the one
 * that stands, and a re-plan reads the whole document: replacing the body with the request would
 * throw away the objective and let the delta cancel everything.
 *
 * `previous === null` -- a project whose goal has never been set -- takes the request AS the body
 * (plan erratum E7). A `Requested changes` list under an empty objective is a document that says
 * what to change about nothing.
 *
 * The request is flattened onto one list entry: newlines become spaces, runs of whitespace
 * collapse, and the entry is one line. A multi-line paste would otherwise break the list, and
 * everything a person typed is preserved verbatim in `GoalVersion.request` and in the
 * `workspace.goal_set` event either way.
 */
export function composeGoal(previous: string | null, request: string, at: Date): string {
  const entry = `- ${dateStamp(at)}: ${request.replace(/\s+/gu, ' ').trim()}`
  if (previous === null || previous.trim() === '') return request.trim()
  const body = previous.replace(/\s+$/u, '')
  return body.includes(REQUESTED_CHANGES_HEADING)
    ? `${body}\n${entry}\n`
    : `${body}\n\n${REQUESTED_CHANGES_HEADING}\n\n${entry}\n`
}
```

Add `export * from './compose.js'` to `packages/domain/src/goal/index.ts`.

- [ ] **Step 12: Run it and watch it pass**

Run: `npx vitest run --project unit packages/domain/test/goal/compose.test.ts`
Expected: PASS.

- [ ] **Step 13: Widen the `workspace.goal_set` payload, with its test**

Append to `packages/domain/test/events/schema.test.ts`, beside the existing goal-set cases:

```ts
it('accepts a workspace.goal_set carrying the words a person requested', () => {
  const result = parseExecutionEvent({
    ...BASE,
    actor: 'human',
    type: 'workspace.goal_set',
    payload: { goal: 'Ship it\n\n## Requested changes\n\n- 2026-09-10: add Apple Pay\n', version: 2, sha256: 'abc', request: 'add Apple Pay' },
  })
  expect(result.ok).toBe(true)
  if (result.ok && result.value.type === 'workspace.goal_set') {
    expect(result.value.payload.request).toBe('add Apple Pay')
  }
})

it('still accepts a workspace.goal_set with no request -- every version before M45 has none', () => {
  const result = parseExecutionEvent({
    ...BASE, actor: 'human', type: 'workspace.goal_set', payload: { goal: 'Ship it', version: 1, sha256: 'abc' },
  })
  expect(result.ok).toBe(true)
  if (result.ok && result.value.type === 'workspace.goal_set') {
    expect(result.value.payload.request).toBeUndefined()
  }
})
```

Then in `packages/domain/src/events/schema.ts`, extend the `workspace.goal_set` member's payload and its comment:

```ts
    payload: z.object({
      goal: z.string().min(1),
      version: z.number().int().positive().optional(),
      sha256: z.string().min(1).optional(),
      // M45 R3: the words a person typed when they asked for a change, kept beside the composed
      // document so the timeline can show the REQUEST rather than the diff of the goal it
      // produced. Optional, and null on every version written by `set-goal` or by the Settings
      // editor -- those set a whole goal rather than asking for a change.
      request: z.string().min(1).optional(),
    }),
```

Run: `npx vitest run --project unit packages/domain/test/events/schema.test.ts`
Expected: PASS, and every existing goal-set case still green.

- [ ] **Step 14: Add the column and its migration**

In `packages/db/prisma/schema.prisma`, inside `model GoalVersion`, after `setByUserId`:

```prisma
  /// M45 R3: the words a person typed into "Tell the Supervisor", when this version was made by
  /// `requestChange` rather than by a whole-goal `setGoal`. Null is a real value and the common
  /// one: every version written before M45, and every version written by the Settings editor or
  /// by `set-goal`, was a statement of the goal rather than a request to change it.
  request     String?
```

Create `packages/db/prisma/migrations/20260910210000_m45_goal_request/migration.sql`:

```sql
-- M45 R3: a goal version may record the request that produced it (spec §1 R3).

-- Additive and nullable, with no backfill. Null means "this version was written as a whole goal,
-- not asked for as a change" -- which is true of every row that exists today, so inventing a
-- request for them would be inventing a sentence nobody said.
ALTER TABLE "GoalVersion" ADD COLUMN "request" TEXT;
```

Apply it to both databases and prove the schema and the migrations agree:

```bash
npm run db:migrate
npm run db:migrate:test
npm run db:generate
npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts
```
Expected: the migration applies to both, and the diff prints `No difference detected`. Paste all four outputs into the task report.

- [ ] **Step 15: Write the failing integration test for `requestChange`**

Append to `packages/control/test/integration/goal.test.ts`:

```ts
describe('requestChange', () => {
  it('composes the next version, keeps the words, and stamps the event', async () => {
    const workspace = await makeWorkspace()          // the file's existing helper
    const first = await setGoal(workspace.id, 'Ship the checkout flow.')
    expect(first.ok).toBe(true)

    const result = await requestChange(workspace.id, 'Add Apple Pay', undefined, new Date('2026-09-10T09:00:00.000Z'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(2)
    expect(result.value.goal).toContain('Ship the checkout flow.')
    expect(result.value.goal).toContain('- 2026-09-10: Add Apple Pay')

    const version = await prisma.goalVersion.findUniqueOrThrow({
      where: { workspaceId_version: { workspaceId: workspace.id, version: 2 } },
    })
    expect(version.request).toBe('Add Apple Pay')
    expect(version.text).toBe(result.value.goal)

    const reloaded = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(reloaded.goalVersion).toBe(2)
    expect(reloaded.goal).toBe(result.value.goal)

    const events = await prisma.executionEvent.findMany({
      where: { workspaceId: workspace.id, type: 'workspace_goal_set' },
      orderBy: { seq: 'asc' },
    })
    expect(events).toHaveLength(2)
    expect((events[1].payload as { request?: string }).request).toBe('Add Apple Pay')
    expect((events[1].payload as { version?: number }).version).toBe(2)
  })

  it('takes the request as the goal on a project that never had one', async () => {
    const workspace = await makeWorkspace()
    const result = await requestChange(workspace.id, 'Build a billing service')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.version).toBe(1)
    expect(result.value.goal).toBe('Build a billing service')
  })

  it('refuses a blank request in its own words, and records nothing', async () => {
    const workspace = await makeWorkspace()
    await setGoal(workspace.id, 'Ship it.')
    const result = await requestChange(workspace.id, '   ')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('invalid_request')
    expect(
      await prisma.goalVersion.count({ where: { workspaceId: workspace.id } }),
    ).toBe(1)
  })

  it('refuses an unknown project', async () => {
    const result = await requestChange('nope', 'Add Apple Pay')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('workspace_not_found')
  })

  it('leaves the re-plan trigger looking at the new version', async () => {
    const workspace = await makeWorkspace()
    await setGoal(workspace.id, 'Ship it.')
    await requestChange(workspace.id, 'Add Apple Pay')
    const versions = await prisma.goalVersion.findMany({
      where: { workspaceId: workspace.id }, orderBy: { version: 'asc' }, select: { version: true, request: true },
    })
    expect(versions).toEqual([{ version: 1, request: null }, { version: 2, request: 'Add Apple Pay' }])
  })
})
```

Import `requestChange` from `../../src/goal.js` beside `setGoal`. **Read the top of the file first** and reuse its existing workspace helper and its `beforeEach` truncation rather than writing new ones — the file already has both, and a second seed idiom in one file is a second thing to keep in step.

- [ ] **Step 16: Run it and watch it fail**

Run: `npx vitest run --project integration packages/control/test/integration/goal.test.ts`
Expected: FAIL — `requestChange` is not exported.

- [ ] **Step 17: Add the refusal kind**

In `packages/control/src/refusal.ts`, beside `invalid_goal` in the union:

```ts
  /**
   * M45 R3: `requestChange` was handed a blank request. Distinct from `invalid_goal` because
   * nothing about the GOAL was wrong -- a person pressed "Tell the Supervisor" with an empty box,
   * and telling them a goal must be non-empty would name the wrong thing.
   */
  | { readonly kind: 'invalid_request' }
```

and in `refusalText`'s switch, beside the `invalid_goal` case:

```ts
    case 'invalid_request':
      return 'a change request must be a non-empty text'
```

In `apps/web/test/refusal-status.test.ts`, add `invalid_request: true,` to `ALL_KINDS` immediately after `invalid_goal: true,` (the `Record<ControlRefusal['kind'], true>` annotation fails to compile without it).

- [ ] **Step 18: Refactor `setGoal` onto a shared writer and add `requestChange`**

In `packages/control/src/goal.ts`, add the `composeGoal` import to the existing `@slave-of-ai/domain` import list, then replace the body of `setGoal` with a call to a new internal writer and add the new verb. The transaction body is MOVED, not rewritten — every comment in it stays exactly as it is:

```ts
/**
 * The one locked write behind both goal verbs (M45 plan erratum E6).
 *
 * `textOf` is a callback over the PREVIOUS text rather than a finished string, and that is the
 * whole point: `requestChange` has to compose against the goal this lock is holding. Composing
 * outside and then calling `setGoal` would read a body, lose the race to a concurrent set, and
 * write an amendment to a document that no longer exists -- silently dropping the other edit.
 *
 * Both refusals below are still reached BEFORE anything is written, so returning them as values is
 * safe; a refusal after a write inside `$transaction` would have to throw or Prisma would commit
 * that write.
 *
 * The event is appended AFTER the commit, exactly as `setGoal` always did.
 */
async function writeGoalVersion(
  workspaceId: string,
  textOf: (previous: string | null) => string,
  principal: Principal | undefined,
  request: string | null,
): Promise<Result<{ readonly version: number; readonly sha256: string; readonly goal: string }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, goal: true, goalVersion: true },
    })
    if (workspace === null) {
      return { ok: false as const, error: { kind: 'workspace_not_found', workspaceId } as ControlRefusal }
    }

    const goal = textOf(workspace.goal)
    if (goal.trim() === '') return { ok: false as const, error: { kind: 'invalid_goal' } as ControlRefusal }
    const sha256 = goalSha256(goal)

    // Erratum E5 (M40), decided INSIDE the lock so the version it compares against is the version
    // the insert below would follow. Only the CURRENT version is compared, never the whole
    // history: returning to an older wording is a real edit and must produce a real version,
    // because a version is what the re-plan trigger counts. `goalVersion: 0` means no version was
    // ever recorded, so there is nothing to be unchanged from.
    const current =
      workspace.goalVersion === 0
        ? null
        : await tx.goalVersion.findUnique({
            where: { workspaceId_version: { workspaceId, version: workspace.goalVersion } },
            select: { sha256: true },
          })
    if (current !== null && current.sha256 === sha256) {
      return {
        ok: false as const,
        error: { kind: 'goal_unchanged', workspaceId, version: workspace.goalVersion } as ControlRefusal,
      }
    }

    const version = workspace.goalVersion + 1
    await tx.goalVersion.create({
      data: { workspaceId, version, text: goal, sha256, setByUserId: principal?.userId ?? null, request },
    })
    await tx.workspace.update({
      where: { id: workspaceId },
      data: { goal, goalSetByUserId: principal?.userId ?? null, goalVersion: version },
    })
    return { ok: true as const, version, sha256, goal }
  })
  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'workspace.goal_set',
    workspaceId,
    actor: 'human',
    // Spread, not `request: request ?? undefined`: a `workspace.goal_set` written by `set-goal`
    // must carry NO `request` key at all, so a reader can tell "no request was made" from "a
    // request was made and was empty" without asking which verb wrote the row.
    payload: { goal: outcome.goal, version: outcome.version, sha256: outcome.sha256, ...(request === null ? {} : { request }) },
    userId: principal?.userId ?? null,
  })

  return ok({ version: outcome.version, sha256: outcome.sha256, goal: outcome.goal })
}
```

`setGoal` keeps its whole docblock and becomes:

```ts
export async function setGoal(
  workspaceId: string,
  goal: string,
  principal?: Principal,
  options: { readonly request?: string } = {},
): Promise<Result<{ readonly version: number; readonly sha256: string }, ControlRefusal>> {
  // Checked here as well as inside the writer: a blank goal is refused before a transaction is
  // opened at all, exactly as it always was.
  if (goal.trim() === '') return err({ kind: 'invalid_goal' })
  const result = await writeGoalVersion(workspaceId, () => goal, principal, options.request ?? null)
  return result.ok ? ok({ version: result.value.version, sha256: result.value.sha256 }) : result
}

/**
 * "Tell the Supervisor what changed" (M45 R3).
 *
 * The only honest path from a sentence to a plan that this system has today: the request amends
 * the standing goal, the amendment is a new `GoalVersion`, and M40's trigger re-plans that version
 * as a delta on the next tick. Nothing here starts a run, hires anybody or cancels a task -- the
 * re-plan's additions land as tasks and its cancellations land as proposals a human approves,
 * which is exactly what the timeline shows.
 *
 * The words are kept twice: on `GoalVersion.request`, so the history can show what was asked, and
 * on the `workspace.goal_set` event, so the timeline can render the USER REQUEST lane without a
 * second read.
 *
 * `at` is a parameter so a test can pin the date the composed entry carries; it is not part of the
 * hash's meaning, only of the text.
 */
export async function requestChange(
  workspaceId: string,
  request: string,
  principal?: Principal,
  at: Date = new Date(),
): Promise<Result<{ readonly version: number; readonly sha256: string; readonly goal: string }, ControlRefusal>> {
  if (request.trim() === '') return err({ kind: 'invalid_request' })
  return writeGoalVersion(workspaceId, (previous) => composeGoal(previous, request, at), principal, request.trim())
}
```

Export `requestChange` from `packages/control/src/index.ts` wherever `setGoal` is exported.

- [ ] **Step 19: Run the control tests and watch them pass**

Run: `npx vitest run --project integration packages/control/test/integration/goal.test.ts`
Expected: PASS — the new cases and every existing `setGoal` case, `goal_unchanged` included.

- [ ] **Step 20: Add the CLI verb, with its test**

Append to `apps/orchestrator/test/integration/cli.test.ts`, beside the existing `set-goal` cases:

```ts
it('request-change writes a new version carrying the words', async () => {
  const workspace = await seedWorkspace()             // the file's existing helper
  await run(['set-goal', '--workspace', workspace.id, '--goal', 'Ship the checkout flow.'])
  const { stdout } = await run(['request-change', '--workspace', workspace.id, '--request', 'Add Apple Pay'])
  const parsed = JSON.parse(stdout) as { version: number; sha256: string; goal: string }
  expect(parsed.version).toBe(2)
  expect(parsed.goal).toContain('Add Apple Pay')
  const version = await prisma.goalVersion.findUniqueOrThrow({
    where: { workspaceId_version: { workspaceId: workspace.id, version: 2 } },
  })
  expect(version.request).toBe('Add Apple Pay')
})

it('request-change exits non-zero on a blank request', async () => {
  const workspace = await seedWorkspace()
  await expect(run(['request-change', '--workspace', workspace.id, '--request', '  '])).rejects.toThrow(
    /a change request must be a non-empty text/u,
  )
})
```

**Read the file's own helpers first** (`seedWorkspace`/`run` may be named differently) and use them exactly as the neighbouring `set-goal` cases do.

In `apps/orchestrator/src/cli.ts`, add to `USAGE` immediately after the `set-goal` block:

```
  request-change --workspace <id> --request "<text>"
                                       tell the Supervisor what changed. The request AMENDS the
                                       standing goal -- the document keeps its body and gains a
                                       dated entry under "Requested changes" -- and that amendment
                                       is a new VERSION, which is what makes the next tick re-plan
                                       it as a delta. The words themselves are kept on the version
                                       and on its event, so the project's timeline can show what
                                       was asked and not only what it produced. Prints the version,
                                       its sha256 and the composed goal. Nothing is hired, started
                                       or cancelled here: a re-plan's additions become tasks and
                                       its cancellations become proposals you approve.
```

and the case, immediately after `case 'set-goal'`:

```ts
    case 'request-change': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const request = requireFlag(flags, 'request')
      // No `--by`: `GoalVersion.setByUserId` needs a `User` row and this CLI resolves no principal
      // -- `set-goal` above passes none either (M45 plan erratum E9).
      const result = await requestChange(workspaceId, request)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        `${JSON.stringify({ version: result.value.version, sha256: result.value.sha256, goal: result.value.goal })}\n`,
      )
      return 0
    }
```

Import `requestChange` beside the existing `setGoal` import.

- [ ] **Step 21: Run the CLI test**

Run: `npx vitest run --project integration apps/orchestrator/test/integration/cli.test.ts`
Expected: PASS. If the llm-decision row-count case fails, re-run this file alone before believing it (it doubles when anything else touches the database).

- [ ] **Step 22: Full task verification**

```bash
npx vitest run --project unit packages/domain
npx vitest run --project integration packages/control/test/integration/goal.test.ts apps/orchestrator/test/integration/cli.test.ts
npx vitest run --project unit apps/web/test/refusal-status.test.ts
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: every one green. `typecheck` is the one that proves `LANE_BY_TYPE`'s exhaustiveness and `ALL_KINDS`' completeness.

- [ ] **Step 23: Commit**

```bash
git add packages/domain/src packages/domain/test packages/db/prisma packages/control/src packages/control/test \
        apps/orchestrator/src/cli.ts apps/orchestrator/test apps/web/test/refusal-status.test.ts
git commit -m "$(cat <<'EOF'
feat(domain,db,control,orchestrator): m45 t1 -- one word for the Supervisor, six lanes for its history, and a sentence that becomes a goal version

`userSupervisorStatus` is the seventh projection in `status/user.ts` and takes a FACT BAG, not a
SupervisorReport: `report.supervisor.pending` counts only the decisions inside the world loader's
window, so a proposal older than it -- still open, still waiting on a person -- would have been
missed by the one word that exists to say so. WATCHING gets the rule the spec's precedence chain
left out, and HALTED, NEEDS YOU is one label.

`supervisor/timeline.ts` classifies every event type the database can store onto one of six lanes
or onto none, as a `Record` over the union, so a fiftieth event type fails the build here rather
than silently never appearing. `task.created` and `task.cancelled` split on the envelope's ACTOR
rather than on a goal version: a first plan's tasks are v1 and are still a plan change, and both
events are written today only by planning and re-plan runs. `replanSentence` says what the
Supervisor understood in the only words the system honestly has -- the delta itself.

`requestChange` composes INSIDE the lock. Both goal verbs now share one `writeGoalVersion` that
takes the new text as a callback over the previous one; composing outside and calling `setGoal`
would have amended a document a concurrent set had already replaced. The words a person typed are
kept twice -- `GoalVersion.request` and `workspace.goal_set.payload.request` -- both additive,
both optional, and null on every row that exists today. A blank request gets its own refusal:
`invalid_goal` would have named the wrong thing.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 2: The three read models, the two new routes, and the one stream that carries them (R1/R2/E19)

**Files:**
- Create: `apps/web/src/server/brief.ts`, `apps/web/src/server/needsYou.ts`, `apps/web/src/server/timeline.ts`, `apps/web/src/app/api/w/[workspaceId]/goal/request/route.ts`, `apps/web/src/app/api/w/[workspaceId]/tasks/[taskId]/unblock/route.ts`
- Modify: `apps/web/src/server/overview.ts` (the `OverviewSnapshot` interface and the `return` at the end of `buildOverviewSnapshot`)
- Test: `apps/web/test/integration/needs-you.test.ts` (new), `apps/web/test/integration/supervisor-timeline.test.ts` (new), `apps/web/test/integration/brief.test.ts` (new), `apps/web/test/integration/overview.test.ts` (append one case)

**Interfaces:**
- Consumes from Task 1: `userSupervisorStatus`, `UserSupervisorFacts`, `laneFor`, `LANE_LABEL`, `TIMELINE_LANES`, `TimelineLane`, `replanSentence`, `requestChange`. From the tree: `userTaskStatus`/`needsYou` (`@slave-of-ai/domain`), `workspaceSpend` and `listDecisions`/`DecisionView` (`@slave-of-ai/control`), `buildSupervisorView`/`SupervisorQuestionView` (`../server/supervisor`), `EVENT_TYPE_BY_DOMAIN_TYPE`/`DOMAIN_EVENT_TYPE_BY_DB_VALUE` (`@slave-of-ai/db`), `readableEventType` (`../lib/eventLabels`), `feedSummary` (`../lib/feedSummary`), `unblockTask` (`@slave-of-ai/control`), `archivedRefusal`/`refusalStatus`/`requirePrincipal`.
- Produces, for Tasks 3–5: `ProjectBrief`, `buildProjectBrief(workspaceId, now?)`; `NeedsYouItem`, `buildNeedsYou(workspaceId, now?)`; `TimelineEntry`, `buildSupervisorTimeline(workspaceId, options?)`, `TIMELINE_LIMIT_DEFAULT = 40`, `TIMELINE_LIMIT_MAX = 200`; `OverviewSnapshot.brief: ProjectBrief`, `OverviewSnapshot.needsYou: readonly NeedsYouItem[]`, `OverviewSnapshot.timeline: readonly TimelineEntry[]`; `POST /api/w/:id/goal/request` (`{ request: string }` → `{ ok: true, version, sha256, goal }` or `{ error, kind }`); `POST /api/w/:id/tasks/:taskId/unblock` (no body → `{ ok: true }` or `{ error }`).

- [ ] **Step 1: Write the failing test for `buildNeedsYou`**

Create `apps/web/test/integration/needs-you.test.ts`. **Read `apps/web/test/integration/overview.test.ts`'s header first** and copy its imports, its `beforeEach` truncation and its seeding helpers verbatim — it is the file this one sits beside, and a second seed idiom is a second thing to keep in step.

```ts
describe('buildNeedsYou', () => {
  it('lists a blocked task, a pending decision, an unanswerable question and un-integrated work', async () => {
    const { workspaceId, slaveId } = await seedWorkspace({ autoMerge: false })
    const blocked = await prisma.task.create({
      data: { workspaceId, title: 'Wire the webhook', status: 'blocked', lastRejectionReason: 'no credentials', requiredRole: 'dev' },
    })
    const finished = await prisma.task.create({
      data: { workspaceId, title: 'Add the banner', status: 'done', integratedAt: null, requiredRole: 'dev' },
    })
    const decision = await prisma.supervisorDecision.create({
      data: {
        workspaceId, situationKind: 'no_reviewer', subjectId: 'reviewer',
        situation: { kind: 'no_reviewer', subjectId: 'reviewer', summary: 'nobody holds reviewer' },
        candidates: [], chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'nobody holds reviewer' },
        rationale: 'no holder', tier: 'proposed', status: 'pending', decidedBy: 'rules', modelCalled: false,
      },
    })
    const question = await prisma.slaveMessage.create({
      data: {
        workspaceId, slaveId, kind: 'question', body: 'Which gateway?', expectsReply: true,
        recipientRole: 'nobody-holds-this', threadId: 'th-1',
      },
    })

    const items = await buildNeedsYou(workspaceId)
    expect(items.map((item) => item.kind).sort()).toEqual(['blocked_task', 'decision', 'integrate', 'question'])
    const byKind = Object.fromEntries(items.map((item) => [item.kind, item]))
    expect(byKind.blocked_task.title).toContain('Wire the webhook')
    expect(byKind.blocked_task.href).toBe(`/w/${workspaceId}/tasks?task=${blocked.id}`)
    expect(byKind.blocked_task.taskId).toBe(blocked.id)
    expect(byKind.decision.decisionId).toBe(decision.id)
    expect(byKind.question.messageId).toBe(question.id)
    expect(byKind.integrate.taskId).toBe(finished.id)
    for (const item of items) expect(Date.parse(item.since)).not.toBeNaN()
  })

  it('does not ask for an integration on a project that merges by itself', async () => {
    const { workspaceId } = await seedWorkspace({ autoMerge: true })
    await prisma.task.create({
      data: { workspaceId, title: 'Add the banner', status: 'done', integratedAt: null, requiredRole: 'dev' },
    })
    expect(await buildNeedsYou(workspaceId)).toEqual([])
  })

  it('is oldest first -- the thing that has waited longest is the thing to do', async () => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })
    const older = await prisma.task.create({
      data: { workspaceId, title: 'Older', status: 'blocked', requiredRole: 'dev', createdAt: new Date('2026-09-01T00:00:00.000Z') },
    })
    await prisma.task.create({
      data: { workspaceId, title: 'Newer', status: 'blocked', requiredRole: 'dev', createdAt: new Date('2026-09-09T00:00:00.000Z') },
    })
    const items = await buildNeedsYou(workspaceId)
    expect(items[0].taskId).toBe(older.id)
  })

  it('answers an empty list for a project where nothing is waiting', async () => {
    const { workspaceId } = await seedWorkspace({ autoMerge: false })
    expect(await buildNeedsYou(workspaceId)).toEqual([])
  })
})
```

If `seedWorkspace` in the neighbouring file takes no `autoMerge`, extend it there (one field, defaulted to today's behaviour) rather than writing a second helper, and say so in the commit.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project integration apps/web/test/integration/needs-you.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write `apps/web/src/server/needsYou.ts`**

```ts
import { prisma } from '@slave-of-ai/db/client'
import { listDecisions } from '@slave-of-ai/control'
import { SITUATION_LABEL, needsYou } from '@slave-of-ai/domain'
import { buildSupervisorView } from './supervisor'

/**
 * One thing a person has to do, and where to do it (M45 R1).
 *
 * FOUR SOURCES, not one predicate. `needsYou(facts)` in the domain is per-TASK, and three of the
 * four kinds below are tasks -- but a pending `SupervisorDecision` has no task column at all: its
 * `subjectId` is a task id, a message id, a role name or the workspace's own id depending on the
 * situation, and plenty of pending decisions are about no task (a `ready_unstaffed` is about a
 * role). So decisions are counted as ROWS, exactly the way `docs/ia.md` records it for the project
 * card's own count (M45 plan erratum E20).
 *
 * `href` always points at a surface that can actually resolve the item. `integrate` links to the
 * board rather than offering a button, because `confirmIntegration` has no web route -- it is a
 * control verb the CLI drives, and inventing a route for it is a decision this milestone did not
 * make (plan erratum E11).
 */
export interface NeedsYouItem {
  readonly kind: 'blocked_task' | 'decision' | 'question' | 'integrate'
  /** Stable within a snapshot: the row's own id, so React keys and the gate can both name it. */
  readonly id: string
  readonly title: string
  readonly href: string
  /** ISO. When this started waiting -- the task's creation, the decision's, the question's. */
  readonly since: string
  readonly taskId: string | null
  readonly decisionId: string | null
  readonly messageId: string | null
}

export async function buildNeedsYou(workspaceId: string, now: Date = new Date()): Promise<readonly NeedsYouItem[]> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, autoMerge: true },
  })
  if (workspace === null) return []

  // One read for both task kinds: `blocked` and `done` are the only two statuses any of the three
  // task-shaped clauses can be in, so a single query answers all of them.
  const tasks = await prisma.task.findMany({
    where: { workspaceId, status: { in: ['blocked', 'done'] } },
    select: { id: true, title: true, status: true, integratedAt: true, lastRejectionReason: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  const [decisions, view] = await Promise.all([
    listDecisions(workspaceId, { pending: true }),
    buildSupervisorView(workspaceId, now),
  ])

  const items: NeedsYouItem[] = []

  for (const task of tasks) {
    // The domain decides, not this file: `needsYou` is where the four rules live, and asking it
    // per task is what keeps the queue and the project card's count saying the same thing.
    if (
      !needsYou({
        status: task.status,
        integrated: task.integratedAt !== null,
        autoMerge: workspace.autoMerge,
      })
    ) {
      continue
    }
    const blocked = task.status === 'blocked'
    items.push({
      kind: blocked ? 'blocked_task' : 'integrate',
      id: task.id,
      title: blocked
        ? `${task.title} — ${task.lastRejectionReason ?? 'blocked'}`
        : `${task.title} — ready to integrate`,
      href: `/w/${workspaceId}/tasks?task=${task.id}`,
      since: task.createdAt.toISOString(),
      taskId: task.id,
      decisionId: null,
      messageId: null,
    })
  }

  if (decisions.ok) {
    for (const decision of decisions.value) {
      items.push({
        kind: 'decision',
        id: decision.id,
        // The label, never the member -- `docs/ia.md` rule 3, and the same table `ProposalRow`
        // reads. The raw kind reaches the page on the decision itself.
        title: `${SITUATION_LABEL[decision.situationKind] ?? decision.situationKind}: ${decision.situation.summary}`,
        href: `/w/${workspaceId}#decision-${decision.id}`,
        since: decision.createdAt,
        taskId: null,
        decisionId: decision.id,
        messageId: null,
      })
    }
  }

  if (view !== null) {
    for (const question of view.questions) {
      // `holders === 0` is M39's unanswerable shape: the role the question went to has no live
      // holder, so nothing but a person will ever answer it. A question a slave CAN answer is
      // the fleet waiting on itself and is not on this list.
      if (question.holders !== 0) continue
      items.push({
        kind: 'question',
        id: question.messageId,
        title: `${question.askerName} asked: ${question.body}`,
        href: `/w/${workspaceId}#question-${question.messageId}`,
        since: question.since,
        taskId: null,
        decisionId: null,
        messageId: question.messageId,
      })
    }
  }

  // Oldest first: the thing that has waited longest is the thing to do.
  return items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
}
```

**Read `SupervisorQuestionView` before writing this** (`apps/web/src/server/supervisor.ts:44`) and use its real field names for `askerName`, `body`, `holders` and `since`; the shape above is what the exploration recorded, and the compiler is the arbiter.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run --project integration apps/web/test/integration/needs-you.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `buildSupervisorTimeline`**

Create `apps/web/test/integration/supervisor-timeline.test.ts`, on the same seed helpers:

```ts
describe('buildSupervisorTimeline', () => {
  it('classifies the seeded story into its lanes, newest first', async () => {
    const { workspaceId } = await seedWorkspace({})
    const task = await prisma.task.create({
      data: { workspaceId, title: 'Add Apple Pay', status: 'running', requiredRole: 'dev' },
    })
    await appendEvent({ type: 'workspace.goal_set', workspaceId, actor: 'human', payload: { goal: 'Ship it', version: 2, sha256: 'a', request: 'Add Apple Pay' } })
    await appendEvent({ type: 'workspace.replan_started', workspaceId, actor: 'slave', payload: { version: 2, runId: 'r-1' } })
    await appendEvent({ type: 'workspace.replanned', workspaceId, actor: 'slave', payload: { version: 2, runId: 'r-1', added: [task.id], proposedCancellations: [], droppedCancellations: [] } })
    await appendEvent({ type: 'task.created', workspaceId, taskId: task.id, actor: 'slave', payload: { title: 'Add Apple Pay', goalVersion: 2 } })
    await appendEvent({ type: 'task.started', workspaceId, taskId: task.id, actor: 'slave', payload: { title: 'Add Apple Pay' } })
    await appendEvent({ type: 'task.verify_passed', workspaceId, taskId: task.id, actor: 'slave', payload: { branch: 'feature/apple-pay' } })
    // Model chatter, which must not appear.
    await appendEvent({ type: 'run.tool_call', workspaceId, taskId: task.id, actor: 'slave', payload: { name: 'Read', summary: 'src/pay.ts' } })

    const entries = await buildSupervisorTimeline(workspaceId)
    const lanes = entries.map((entry) => entry.lane)
    expect(lanes).not.toContain(null)
    expect(entries.some((entry) => entry.eventType === 'run.tool_call')).toBe(false)
    expect(entries[0].at >= entries[entries.length - 1].at).toBe(true)

    const byType = Object.fromEntries(entries.filter((e) => e.eventType !== null).map((e) => [e.eventType, e]))
    expect(byType['workspace.goal_set'].lane).toBe('user_request')
    expect(byType['workspace.goal_set'].title).toBe('Add Apple Pay')
    expect(byType['workspace.replanned'].lane).toBe('interpretation')
    expect(byType['workspace.replanned'].title).toBe('understood v2: +Add Apple Pay; 1 kept')
    expect(byType['task.created'].lane).toBe('plan_change')
    expect(byType['task.started'].lane).toBe('work')
    expect(byType['task.verify_passed'].lane).toBe('verified')
  })

  it('shows a goal set with no request as the goal it set', async () => {
    const { workspaceId } = await seedWorkspace({})
    await appendEvent({ type: 'workspace.goal_set', workspaceId, actor: 'human', payload: { goal: 'Ship the checkout flow', version: 1, sha256: 'a' } })
    const entries = await buildSupervisorTimeline(workspaceId)
    expect(entries[0].lane).toBe('user_request')
    expect(entries[0].title).toBe('set the goal to v1')
    expect(entries[0].detail).toBe('Ship the checkout flow')
  })

  it('puts every pending decision in the DECISION REQUIRED lane with its row attached', async () => {
    const { workspaceId } = await seedWorkspace({})
    const decision = await prisma.supervisorDecision.create({
      data: {
        workspaceId, situationKind: 'no_reviewer', subjectId: 'reviewer',
        situation: { kind: 'no_reviewer', subjectId: 'reviewer', summary: 'nobody holds reviewer' },
        candidates: [], chosenIndex: 0, action: { kind: 'escalate_to_human', summary: 'nobody holds reviewer' },
        rationale: 'no holder', tier: 'proposed', status: 'pending', decidedBy: 'rules', modelCalled: false,
      },
    })
    const entries = await buildSupervisorTimeline(workspaceId)
    const row = entries.find((entry) => entry.decision !== null)
    expect(row?.lane).toBe('decision')
    expect(row?.decision?.id).toBe(decision.id)
    expect(row?.key).toBe(`decision-${decision.id}`)
  })

  it('collapses a task chatty with messages to its latest, and counts the rest', async () => {
    const { workspaceId, slaveId } = await seedWorkspace({})
    const task = await prisma.task.create({
      data: { workspaceId, title: 'Add Apple Pay', status: 'running', requiredRole: 'dev' },
    })
    for (const body of ['first', 'second', 'third']) {
      await appendEvent({ type: 'slave.message_sent', workspaceId, taskId: task.id, slaveId, actor: 'slave', payload: { body, kind: 'information' } })
    }
    const entries = await buildSupervisorTimeline(workspaceId)
    const messages = entries.filter((entry) => entry.eventType === 'slave.message_sent')
    expect(messages).toHaveLength(1)
    expect(messages[0].detail).toContain('third')
    expect(messages[0].collapsedCount).toBe(2)
  })

  it('caps the page it reads', async () => {
    const { workspaceId } = await seedWorkspace({})
    const entries = await buildSupervisorTimeline(workspaceId, { limit: 1_000 })
    expect(entries.length).toBeLessThanOrEqual(200)
  })
})
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run --project integration apps/web/test/integration/supervisor-timeline.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 7: Write `apps/web/src/server/timeline.ts`**

```ts
import { prisma } from '@slave-of-ai/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@slave-of-ai/db'
import { listDecisions, type DecisionView } from '@slave-of-ai/control'
import { LANE_BY_TYPE, LANE_LABEL, laneFor, replanSentence, type TimelineLane } from '@slave-of-ai/domain'
import { readableEventType } from '../lib/eventLabels'

/** How many organisational events one timeline page reads. */
export const TIMELINE_LIMIT_DEFAULT = 40
/** The ceiling, matching `ACTIVITY_PAGE_LIMIT_MAX` -- one idea of "a page" across the two rivers. */
export const TIMELINE_LIMIT_MAX = 200

/**
 * One entry on the Supervisor timeline (M45 R2): a stored organisational event, or a
 * `SupervisorDecision` waiting on a person.
 *
 * `title` is the sentence a person reads; `detail` is the second line when there is one. The raw
 * event type stays on `eventType` so the page can put it on `data-event-type` and in `title` --
 * `docs/ia.md` rule 3, the same contract every other projected surface keeps.
 */
export interface TimelineEntry {
  /** `event-<seq>` or `decision-<id>`. Stable, and what the gate names an entry by. */
  readonly key: string
  readonly lane: TimelineLane
  readonly laneLabel: string
  /** ISO. Merged across both sources so the river is one ordered story. */
  readonly at: string
  readonly title: string
  readonly detail: string | null
  readonly taskId: string | null
  readonly taskTitle: string | null
  readonly eventType: DomainEventType | null
  /** The whole decision row, so the DECISION REQUIRED lane can render `ProposalRow` unchanged. */
  readonly decision: DecisionView | null
  /** How many earlier entries this one stands for -- the "+N earlier" disclosure. 0 for most. */
  readonly collapsedCount: number
}

/** The DB enum values `LANE_BY_TYPE` gives a lane to, plus the two the ACTOR decides. Derived, so
 *  the query and the classification can never disagree about what a timeline event is. */
const TIMELINE_DB_TYPES = (Object.keys(LANE_BY_TYPE) as DomainEventType[])
  .filter((type) => LANE_BY_TYPE[type] !== null)
  .map((type) => EVENT_TYPE_BY_DOMAIN_TYPE[type])

/**
 * The project's story, newest first (M45 R2).
 *
 * ONE event query with a type filter -- the idiom `buildActivityHistory` already uses -- plus the
 * pending decisions and the board's titles. Never one query per entry: this builder runs on every
 * SSE-driven refetch of the Overview, several times a second while a run is live.
 *
 * Refreshed by the stream the page already owns: this is a field on `OverviewSnapshot`, so
 * `useWorkspaceStream`'s debounced refetch of `/api/w/:id/overview` updates it with no second
 * `EventSource` and no polling (M45 plan erratum E19).
 */
export async function buildSupervisorTimeline(
  workspaceId: string,
  options: { readonly limit?: number } = {},
): Promise<readonly TimelineEntry[]> {
  const take = Math.min(options.limit ?? TIMELINE_LIMIT_DEFAULT, TIMELINE_LIMIT_MAX)

  const [rows, decisions, tasks] = await Promise.all([
    prisma.executionEvent.findMany({
      where: { workspaceId, type: { in: TIMELINE_DB_TYPES } },
      orderBy: { seq: 'desc' },
      take,
    }),
    listDecisions(workspaceId, { pending: true }),
    prisma.task.findMany({ where: { workspaceId }, select: { id: true, title: true } }),
  ])

  const titles: Record<string, string> = Object.fromEntries(tasks.map((task) => [task.id, task.title]))

  const entries: TimelineEntry[] = []

  // WORK IN PROGRESS collapses a task's message chatter to its latest, because a worker that
  // reported five times is one thing happening, not five (spec R2).
  const messagesSeenPerTask = new Map<string, number>()

  for (const row of rows) {
    const type = (DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type) as DomainEventType
    const lane = laneFor({ source: 'event', type, actor: row.actor as 'human' | 'slave' | 'system' })
    if (lane === null) continue
    const payload = row.payload as Record<string, unknown>

    if (type === 'slave.message_sent') {
      const key = row.taskId ?? 'no-task'
      const seen = messagesSeenPerTask.get(key) ?? 0
      messagesSeenPerTask.set(key, seen + 1)
      // Rows arrive newest-first, so the FIRST one seen for a task is the latest; the rest only
      // raise its count.
      if (seen > 0) {
        const kept = entries.find((entry) => entry.eventType === 'slave.message_sent' && entry.taskId === row.taskId)
        if (kept !== undefined) {
          entries[entries.indexOf(kept)] = { ...kept, collapsedCount: kept.collapsedCount + 1 }
        }
        continue
      }
    }

    entries.push({
      key: `event-${String(row.seq)}`,
      lane,
      laneLabel: LANE_LABEL[lane],
      at: row.ts.toISOString(),
      title: titleFor(type, payload, titles),
      detail: detailFor(type, payload),
      taskId: row.taskId,
      taskTitle: row.taskId === null ? null : (titles[row.taskId] ?? null),
      eventType: type,
      decision: null,
      collapsedCount: 0,
    })
  }

  if (decisions.ok) {
    for (const decision of decisions.value) {
      entries.push({
        key: `decision-${decision.id}`,
        lane: 'decision',
        laneLabel: LANE_LABEL.decision,
        at: decision.createdAt,
        title: decision.situation.summary,
        detail: decision.rationale,
        taskId: null,
        taskTitle: null,
        eventType: null,
        decision,
        collapsedCount: 0,
      })
    }
  }

  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

/** The sentence, per type. Everything a MODEL or a person wrote is passed through as data -- this
 *  builds a string, and the component interpolates it as JSX children. */
function titleFor(
  type: DomainEventType,
  payload: Record<string, unknown>,
  titles: Readonly<Record<string, string>>,
): string {
  switch (type) {
    case 'workspace.goal_set': {
      // R3: when a person asked for a change, the request IS the entry. A whole-goal set has no
      // request and says what it did instead -- inventing a sentence for it would put words in
      // somebody's mouth.
      const request = payload['request']
      if (typeof request === 'string' && request !== '') return request
      const version = payload['version']
      return `set the goal to v${typeof version === 'number' ? String(version) : '1'}`
    }
    case 'workspace.replan_started': {
      const version = payload['version']
      return `reading the change to v${typeof version === 'number' ? String(version) : '?'}`
    }
    case 'workspace.replanned': {
      const added = asIds(payload['added'])
      const cancels = asIds(payload['proposedCancellations'])
      const kept = Math.max(Object.keys(titles).length - added.length, 0)
      return replanSentence(
        { version: typeof payload['version'] === 'number' ? (payload['version'] as number) : 0, added, proposedCancellations: cancels, kept },
        titles,
      )
    }
    default: {
      const title = payload['title']
      return typeof title === 'string' && title !== '' ? title : readableEventType(type)
    }
  }
}

function detailFor(type: DomainEventType, payload: Record<string, unknown>): string | null {
  for (const field of ['goal', 'body', 'reason', 'branch', 'summary'] as const) {
    const value = payload[field]
    if (typeof value === 'string' && value !== '') return value
  }
  return type === 'workspace.replanned' ? null : null
}

function asIds(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
```

Two notes for the implementer, both load-bearing:
- `kept` in `titleFor`'s `workspace.replanned` arm is "how many of the board's tasks this re-plan did not add", computed from the titles map the builder already holds. It is a display number, never a decision; if the board has been edited since, it moves — say so in the docblock.
- `detailFor`'s final `return` reads oddly as written; simplify it to `return null` and keep the field loop. It is written out here so nobody adds a per-type detail table by accident.

- [ ] **Step 8: Run it and watch it pass**

Run: `npx vitest run --project integration apps/web/test/integration/supervisor-timeline.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing test for `buildProjectBrief`**

Create `apps/web/test/integration/brief.test.ts`:

```ts
describe('buildProjectBrief', () => {
  it('answers the eight questions off one project', async () => {
    const { workspaceId, slaveId } = await seedWorkspace({ autoMerge: false, goal: 'Ship the checkout flow', budgetUsd: 25 })
    const task = await prisma.task.create({
      data: { workspaceId, title: 'Add Apple Pay', status: 'running', requiredRole: 'dev', assigneeSlaveId: slaveId },
    })
    await appendEvent({ type: 'task.integrated', workspaceId, taskId: task.id, actor: 'system', payload: {} })
    await appendEvent({ type: 'workspace.settings_changed', workspaceId, actor: 'human', payload: { field: 'budgetUsd', from: 10, to: 25 } })

    const brief = await buildProjectBrief(workspaceId)
    expect(brief).not.toBeNull()
    if (brief === null) return

    expect(brief.objective.text).toBe('Ship the checkout flow')
    expect(brief.objective.version).toBeGreaterThanOrEqual(0)
    expect(brief.supervisor.label).toMatch(/^(WORKING|WATCHING|IDLE|ANSWERING|OFF|HALTED, NEEDS YOU|\d+ DECISIONS? WAITING)$/u)
    expect(brief.work.working).toBe(1)
    expect(brief.team.map((member) => member.slaveId)).toContain(slaveId)
    expect(brief.team[0].taskTitle).toBe('Add Apple Pay')
    expect(brief.latestVerified).toEqual({ taskTitle: 'Add Apple Pay', kind: 'integrated', at: expect.any(String) })
    expect(brief.cost.budgetUsd).toBe(25)
    expect(brief.cost.spentUsd).toBeGreaterThanOrEqual(brief.cost.measuredUsd)
    expect(brief.recentChanges.length).toBeGreaterThan(0)
    expect(brief.recentChanges.length).toBeLessThanOrEqual(6)
    expect(brief.recentChanges[0].summary).not.toContain('workspace.settings_changed')
  })

  it('prefers an integration over an approval over a verify pass', async () => {
    const { workspaceId } = await seedWorkspace({})
    const task = await prisma.task.create({ data: { workspaceId, title: 'Add the banner', status: 'done', requiredRole: 'dev' } })
    await appendEvent({ type: 'task.verify_passed', workspaceId, taskId: task.id, actor: 'slave', payload: { branch: 'b' } })
    expect((await buildProjectBrief(workspaceId))?.latestVerified?.kind).toBe('verified')
    await appendEvent({ type: 'task.review_approved', workspaceId, taskId: task.id, actor: 'slave', payload: { reason: 'ok' } })
    expect((await buildProjectBrief(workspaceId))?.latestVerified?.kind).toBe('approved')
    await appendEvent({ type: 'task.integrated', workspaceId, taskId: task.id, actor: 'system', payload: {} })
    expect((await buildProjectBrief(workspaceId))?.latestVerified?.kind).toBe('integrated')
  })

  it('says nothing is verified yet rather than inventing a result', async () => {
    const { workspaceId } = await seedWorkspace({})
    expect((await buildProjectBrief(workspaceId))?.latestVerified).toBeNull()
  })

  it('answers null for a project that does not exist', async () => {
    expect(await buildProjectBrief('nope')).toBeNull()
  })
})
```

- [ ] **Step 10: Run it and watch it fail**

Run: `npx vitest run --project integration apps/web/test/integration/brief.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 11: Write `apps/web/src/server/brief.ts`**

```ts
import { prisma } from '@slave-of-ai/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@slave-of-ai/db'
import { listDecisions, workspaceSpend } from '@slave-of-ai/control'
import {
  TERMINAL,
  deriveSlaveStatus,
  sumSpend,
  userSlaveStatus,
  userSupervisorStatus,
  userTaskStatus,
  type UserSupervisorState,
} from '@slave-of-ai/domain'
import { readableEventType } from '../lib/eventLabels'
import { buildNeedsYou, type NeedsYouItem } from './needsYou'

/** How many "what changed lately" lines the brief carries (spec R1). */
const RECENT_CHANGES_LIMIT = 6

/** The families a CHANGE belongs to -- what somebody did to this organisation, as opposed to what
 *  its workers did with their hands. `supervisor.resolved` rather than a `supervisor.approved`,
 *  which does not exist: approval is an OUTCOME on `resolved` (M45 plan erratum E25). */
const CHANGE_TYPES: readonly DomainEventType[] = [
  'workspace.goal_set', 'workspace.plan_created', 'workspace.replanned', 'workspace.settings_changed',
  'workspace.company_assigned', 'workspace.created', 'workspace.archived', 'workspace.restored',
  'org.changed', 'slave.profile_changed', 'slave.runtime_roles_changed',
  'supervisor.applied', 'supervisor.resolved',
]

/** The three kinds of "verified", in the order a person reads them: landed, approved, passed. */
const VERIFIED_TYPES = [
  { type: 'task.integrated' as const, kind: 'integrated' as const },
  { type: 'task.review_approved' as const, kind: 'approved' as const },
  { type: 'task.verify_passed' as const, kind: 'verified' as const },
]

/**
 * The eight facts a person needs to understand a project in about ten seconds (M45 R1).
 *
 * A PROJECTION over reads that already exist: no new table, no new formula, no new autonomy. The
 * one number this is careful about is money -- `cost.spentUsd` is `workspaceSpend()`'s total, the
 * SAME figure the project header's budget bar and the Overview strip render, because a page that
 * shows two different totals for one project has taught its reader to trust neither (M24 §2.2,
 * M38 t5, and M45 plan erratum E2). `measuredUsd` and `unmeasuredCalls` are the two halves of it,
 * shown as the M32 upper-bound policy requires: an unmeasured call is named as an estimate at its
 * cap, never folded into one bare figure and never shown as $0.
 */
export interface ProjectBrief {
  readonly objective: { readonly text: string | null; readonly version: number }
  readonly supervisor: { readonly state: UserSupervisorState; readonly label: string; readonly needsYou: boolean }
  readonly work: {
    readonly working: number
    readonly verifying: number
    readonly review: number
    readonly waiting: number
    readonly done: number
  }
  readonly team: readonly {
    readonly slaveId: string
    readonly name: string
    readonly roleLabel: string
    readonly status: string
    readonly taskTitle: string | null
    /** A worker materialised from a company roster row. The PERMANENT/PROJECT lifecycle itself is
     *  M50; this is the only honest marker the schema carries today (`Slave.companySlaveId`). */
    readonly company: boolean
  }[]
  readonly needsYou: readonly NeedsYouItem[]
  readonly latestVerified: {
    readonly taskTitle: string
    readonly kind: 'integrated' | 'approved' | 'verified'
    readonly at: string
  } | null
  readonly cost: {
    readonly spentUsd: number
    readonly measuredUsd: number
    readonly unmeasuredCalls: number
    readonly budgetUsd: number | null
  }
  readonly recentChanges: readonly { readonly at: string; readonly summary: string }[]
}

export async function buildProjectBrief(workspaceId: string, now: Date = new Date()): Promise<ProjectBrief | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, goal: true, goalVersion: true, budgetUsd: true, haltedReason: true, supervisorEnabled: true },
  })
  if (workspace === null) return null

  const [tasks, slaves, spend, decisions, needsYouItems, changeRows] = await Promise.all([
    prisma.task.findMany({
      where: { workspaceId },
      select: { id: true, title: true, status: true, integratedAt: true, assigneeSlaveId: true },
    }),
    prisma.slave.findMany({
      where: { team: { workspaceId } },
      select: {
        id: true, name: true, role: true, companySlaveId: true,
        runs: { where: { status: { in: ['starting', 'working', 'pause_requested', 'paused', 'resuming', 'stopping'] } }, select: { status: true, taskId: true }, take: 1 },
      },
      orderBy: { name: 'asc' },
    }),
    workspaceSpend(workspaceId),
    listDecisions(workspaceId, { pending: true }),
    buildNeedsYou(workspaceId, now),
    prisma.executionEvent.findMany({
      where: { workspaceId, type: { in: CHANGE_TYPES.map((type) => EVENT_TYPE_BY_DOMAIN_TYPE[type]) } },
      orderBy: { seq: 'desc' },
      take: RECENT_CHANGES_LIMIT,
    }),
  ])

  // The counts a person reads, in the DOMAIN's words -- `userTaskStatus`, the same projection the
  // Tasks board's pill and the project card's count use. `TopStrip` below this on the page keeps
  // the raw statuses; that overlap is deliberate (M45 plan erratum E17).
  const wordOf = (task: (typeof tasks)[number]): string =>
    userTaskStatus({ status: task.status, integrated: task.integratedAt !== null }).state
  const countWord = (word: string): number => tasks.filter((task) => wordOf(task) === word).length

  const titleById = new Map(tasks.map((task) => [task.id, task.title]))
  const runningTaskOf = (slave: (typeof slaves)[number]): string | null => {
    const taskId = slave.runs[0]?.taskId ?? null
    return taskId === null ? null : (titleById.get(taskId) ?? null)
  }

  const pendingDecisions = decisions.ok ? decisions.value.length : 0
  const pendingQuestions = needsYouItems.filter((item) => item.kind === 'question').length
  const tasksActive = tasks.filter((task) =>
    (['ready', 'running', 'verifying', 'reviewing', 'merging', 'rework', 'waiting'] as const).includes(task.status as never),
  ).length
  const tasksOpen = tasks.filter((task) => !TERMINAL.includes(task.status)).length

  const supervisor = userSupervisorStatus({
    halted: workspace.haltedReason !== null,
    enabled: workspace.supervisorEnabled,
    pendingDecisions,
    pendingQuestions,
    tasksActive,
    tasksOpen,
  })

  return {
    objective: { text: workspace.goal, version: workspace.goalVersion },
    supervisor: { state: supervisor.state, label: supervisor.label, needsYou: supervisor.needsYou },
    work: {
      working: countWord('working'),
      verifying: countWord('verifying'),
      review: countWord('review'),
      waiting: countWord('waiting'),
      done: countWord('done') + countWord('integrated'),
    },
    team: slaves.map((slave) => ({
      slaveId: slave.id,
      name: slave.name,
      roleLabel: slave.role,
      // The projected WORD, never `deriveSlaveStatus`'s member -- `docs/ia.md` rule 3. The raw
      // value reaches the page on the `SlaveCard` below, which keeps it in `title`.
      status: userSlaveStatus(deriveSlaveStatus(slave.runs[0]?.status ?? null)).label,
      taskTitle: runningTaskOf(slave),
      company: slave.companySlaveId !== null,
    })),
    needsYou: needsYouItems,
    latestVerified: await latestVerified(workspaceId, titleById),
    cost: {
      spentUsd: spend.spentUsd,
      measuredUsd: spend.runsMeasuredUsd + spend.supervisorMeasuredUsd,
      unmeasuredCalls: spend.supervisorUnmeasuredCalls + (await unmeasuredRunCount(workspaceId)),
      budgetUsd: workspace.budgetUsd,
    },
    recentChanges: changeRows.map((row) => ({
      at: row.ts.toISOString(),
      // The family, said out loud -- never the dotted type. `readableEventType` is the projection
      // M44 added for exactly this (erratum E26 there).
      summary: readableEventType(DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? row.type),
    })),
  }
}

/**
 * The newest thing this project can honestly call finished (spec R1).
 *
 * Three queries at most, in preference order, and it stops at the first hit: an INTEGRATION is
 * work in the base branch, an APPROVAL is work a reviewer accepted, and a VERIFY PASS is work the
 * commands accepted. A project that auto-merges reaches the first; one that hands the branch to a
 * person usually stops at the second. `null` -- "nothing yet" -- is a real answer and is shown as
 * one; guessing at a task that merely reached `done` would call unreviewed work verified.
 */
async function latestVerified(
  workspaceId: string,
  titleById: ReadonlyMap<string, string>,
): Promise<ProjectBrief['latestVerified']> {
  for (const { type, kind } of VERIFIED_TYPES) {
    const row = await prisma.executionEvent.findFirst({
      where: { workspaceId, type: EVENT_TYPE_BY_DOMAIN_TYPE[type] },
      orderBy: { seq: 'desc' },
      select: { taskId: true, ts: true },
    })
    if (row === null) continue
    return {
      taskTitle: row.taskId === null ? 'a task' : (titleById.get(row.taskId) ?? 'a task'),
      kind,
      at: row.ts.toISOString(),
    }
  }
  return null
}

/** Runs that spent real money nobody can name -- `sumSpend`'s own `unmeasured` reading, over the
 *  same rows `server/overview.ts` already loads for its strip. */
async function unmeasuredRunCount(workspaceId: string): Promise<number> {
  const rows = await prisma.slaveRun.findMany({
    where: { slave: { team: { workspaceId } } },
    select: { costUsd: true, provider: true, status: true },
  })
  return sumSpend(rows).unmeasuredRuns
}
```

**Read `sumSpend`'s `SpendRow` and its return shape before writing `unmeasuredRunCount`** (`packages/domain/src/guardrails/spend.ts`) and use its real field name for the unmeasured count; `server/overview.ts` already calls it the same way and is the model.

- [ ] **Step 12: Run it and watch it pass**

Run: `npx vitest run --project integration apps/web/test/integration/brief.test.ts`
Expected: PASS.

- [ ] **Step 13: Carry the three onto the snapshot the stream already refetches**

In `apps/web/src/server/overview.ts`, add to the imports:

```ts
import { buildProjectBrief, type ProjectBrief } from './brief'
import { buildNeedsYou, type NeedsYouItem } from './needsYou'
import { buildSupervisorTimeline, type TimelineEntry } from './timeline'
```

add three members to `OverviewSnapshot`, after `mergeQueue`:

```ts
  /**
   * The eight facts the project view answers in ten seconds (M45 R1), the queue of things waiting
   * on a person (R1), and the Supervisor timeline (R2).
   *
   * ON THIS SNAPSHOT rather than behind `/api/w/:id/brief` and `/api/w/:id/timeline`, deliberately
   * (M45 plan erratum E19): `useWorkspaceStream` refetches exactly ONE endpoint on every event,
   * and this page owns exactly one `EventSource` -- the header reads a module store rather than
   * opening a second (`hooks/useShellFacts.ts`). Two more routes would have meant two more streams
   * or a second hook, for three fields that change on the same events as everything else here.
   */
  readonly brief: ProjectBrief
  readonly needsYou: readonly NeedsYouItem[]
  readonly timeline: readonly TimelineEntry[]
```

and in `buildOverviewSnapshot`, add the three to the existing `Promise.all` that already loads `blockedTasks`, `pausedRuns`, `recentForPanel` and `mergingTasks` (do NOT add a fourth sequential `await` — this function runs on every refetch), then add the three fields to the returned object:

```ts
    brief,
    needsYou: brief.needsYou,
    timeline,
```

`brief` is non-null here: `buildOverviewSnapshot` has already returned `null` for a missing workspace above, so a `?? ` fallback would be dead code. If the compiler disagrees, narrow with an explicit `if (brief === null) return null` and say so in the commit rather than casting.

`needsYou` is deliberately BOTH a member of `brief` and a top-level field: the brief's tile shows the count, the DECISION REQUIRED lane shows the list, and one build feeds both.

- [ ] **Step 14: Pin the snapshot's new shape**

Append one case to `apps/web/test/integration/overview.test.ts`:

```ts
it('carries the brief, the needs-you queue and the timeline on the same snapshot the stream refetches', async () => {
  const { workspaceId } = await seedWorkspace({})
  await appendEvent({ type: 'workspace.goal_set', workspaceId, actor: 'human', payload: { goal: 'Ship it', version: 1, sha256: 'a' } })
  const snapshot = await buildOverviewSnapshot(workspaceId)
  expect(snapshot).not.toBeNull()
  if (snapshot === null) return
  expect(snapshot.brief.objective.text).toBe('Ship it')
  expect(Array.isArray(snapshot.needsYou)).toBe(true)
  expect(snapshot.timeline.some((entry) => entry.lane === 'user_request')).toBe(true)
  // One snapshot, one queue: the tile's count and the lane's list are the same build.
  expect(snapshot.needsYou).toEqual(snapshot.brief.needsYou)
})
```

Run: `npx vitest run --project integration apps/web/test/integration/overview.test.ts`
Expected: PASS, and every existing case in the file still green.

- [ ] **Step 15: Add the two routes**

Create `apps/web/src/app/api/w/[workspaceId]/goal/request/route.ts`:

```ts
import { z } from 'zod'
import { refusalText, requestChange } from '@slave-of-ai/control'
import { archivedRefusal } from '../../../../../../server/workspaceControlRoute'
import { refusalStatus } from '../../../../../../server/refusalStatus'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({ request: z.string() })

/**
 * "Tell the Supervisor what changed" (M45 R3).
 *
 * Its own envelope rather than `workspaceControlResponse`'s bare `{ ok: true }`, for the same
 * reason `POST /goal` has one: the version it wrote is a number the page renders ("goal v3
 * saved"), and the refusal's `kind` is how the page tells `goal_unchanged` -- a request that
 * composed to the text already stored -- from a real failure without matching on a sentence.
 *
 * The archived guard runs FIRST and unchanged: an archived project refuses every write.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'the body must be { "request": string }' }, { status: 400 })

  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal

  const result = await requestChange(workspaceId, parsed.data.request, gate.principal ?? undefined)
  if (!result.ok) {
    return Response.json(
      { error: refusalText(result.error), kind: result.error.kind },
      { status: refusalStatus(result.error.kind) },
    )
  }
  return Response.json({ ok: true, version: result.value.version, sha256: result.value.sha256, goal: result.value.goal })
}
```

Create `apps/web/src/app/api/w/[workspaceId]/tasks/[taskId]/unblock/route.ts`:

```ts
import { unblockTask } from '@slave-of-ai/control'
import { ok } from '@slave-of-ai/domain'
import { taskControlResponse } from '../../../../../../../server/taskControlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * The operator's exit from `blocked` (M45 R2), which had no web route at all until now -- the verb
 * has existed since M35 and only the CLI could reach it (M45 plan erratum E10).
 *
 * No new autonomy and no new rules: `unblockTask` still refuses a task that is not `blocked`, one
 * with a live run, and one at its attempt ceiling, and still decides for itself whether the task
 * belongs in `rework` or back in `reviewing`.
 *
 * `taskControlResponse` takes a `Result<void, ...>` and this verb returns the status it chose, so
 * the success arm is mapped rather than the shell widened: which status it picked is shown by the
 * board's own refetch a moment later, and widening a shell five routes share for one of them would
 * be a change to all five.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; taskId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, taskId } = await context.params
  return taskControlResponse(workspaceId, taskId, async () => {
    const result = await unblockTask(taskId, {}, gate.principal ?? undefined)
    return result.ok ? ok(undefined) : result
  })
}
```

**Count the `../` segments against a sibling route file before saving** — `runs/[runId]/resume/route.ts` is the closest existing shape for the unblock route's depth, and `goal/route.ts` for the request route's.

- [ ] **Step 16: Full task verification**

```bash
npx vitest run --project integration apps/web/test/integration
npx vitest run --project unit apps/web
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
pgrep -af "next dev"     # must be empty
npm run web:build
```
Expected: every one green. `web:build` is what proves the two new route files compile as App Router handlers and that nothing server-only leaked into a client bundle.

- [ ] **Step 17: Commit**

```bash
git add apps/web/src/server apps/web/src/app/api apps/web/test
git commit -m "$(cat <<'EOF'
feat(web): m45 t2 -- the brief, the needs-you queue and the Supervisor timeline, on the stream the page already owns

Three builders, three modules, one snapshot. `buildProjectBrief` answers the eight questions the
ten-second view asks; `buildNeedsYou` joins the four sources a queue has to join (pending decisions
are counted as ROWS, because `SupervisorDecision` has no task column and its subject may be a
message id or a role name); `buildSupervisorTimeline` reads the organisational events in ONE query
with a type filter derived from the domain's own lane table, so the query and the classification
cannot disagree about what belongs on a timeline.

They ride on `OverviewSnapshot` rather than behind two new routes. `useWorkspaceStream` refetches
exactly one endpoint per page and this page owns exactly one EventSource -- the header reads a
module store rather than opening a second -- so two more routes would have meant two more streams
for three fields that change on the same events as everything else on the snapshot. The timeline
refreshes because the page refetches, with no polling anywhere.

Money is the one number this was careful about: `cost.spentUsd` is `workspaceSpend()`'s total, the
same figure the header's budget bar and the strip render, with its measured and unmeasured halves
beside it. A page that shows two different totals for one project has taught its reader to trust
neither.

Two routes are new: `POST /goal/request` (the verb from t1) and `POST /tasks/:id/unblock`, which
had no web route at all -- `unblockTask` has existed since M35 and only the CLI could reach it.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 3: The Overview — brief, request, timeline, Team, and everything else under `Advanced ▾` (R1/R2/R3/R5)

**Files:**
- Create: `apps/web/src/components/project/ProjectBrief.tsx`, `apps/web/src/components/project/SupervisorRequest.tsx`, `apps/web/src/components/project/SupervisorTimeline.tsx`, `apps/web/src/components/project/OverviewAdvanced.tsx`
- Modify: `apps/web/src/components/ui/PageShell.tsx` (E18: `flush`), `apps/web/src/components/OverviewClient.tsx`, `apps/web/src/components/SupervisorPanel.tsx` (E12: two `export` keywords), `apps/web/src/components/TopStrip.tsx` (one docblock sentence), `apps/web/src/components/activity/cards.tsx` (E24: the goal-set card shows the request), `docs/ia.md`
- Test: `apps/web/test/project-brief.test.tsx` (new), `apps/web/test/supervisor-timeline.test.tsx` (new), `apps/web/test/overview-components.test.tsx` (rewritten around the new page order), `apps/web/test/activity-cards.test.tsx` (one case)

**Interfaces:**
- Consumes from Task 2: `OverviewSnapshot.brief` (`ProjectBrief`), `.needsYou` (`NeedsYouItem[]`), `.timeline` (`TimelineEntry[]`); `POST /api/w/:id/goal/request`; `POST /api/w/:id/tasks/:taskId/unblock`. From the tree: `PageShell`, `Panel`, `Alert`, `EmptyState`, `Button`, `Chip`, `SectionLabel`, `StatusPill`, `postControl`, `TIMELINE_LANES`/`LANE_LABEL` (`@slave-of-ai/domain`), `ProposalRow`/`DraftEditor` (exported here).
- Produces, for Tasks 4–5, as `data-testid`s: `page-shell` (on `/w/:id`), `brief`, `brief-tile` (with `data-brief` in `objective | supervisor | work | team | needs-you | latest-verified | cost | recent-changes`), `brief-supervisor-state`, `needs-you-row`, `supervisor-request`, `supervisor-request-input`, `supervisor-request-send`, `supervisor-request-result`, `timeline`, `timeline-decisions`, `timeline-entry` (with `data-lane` and `data-event-type`), `timeline-lane-filter` (with `data-lane`), `timeline-empty`, `timeline-answer-input`, `timeline-answer-send`, `timeline-unblock`, `team`, `overview-advanced`, `advanced-panel-supervisor`, and the untouched `strip`, `slave-card`, `live-events`, `blocked-row`, `merge-row`.

- [ ] **Step 1: Give `PageShell` a pixel-neutral mode, with its test**

Append to `apps/web/test/ui-primitives.test.tsx` (or whichever file already covers `PageShell` — find it with `grep -rln "PageShell" apps/web/test`):

```tsx
it('flush drops the frame padding so a page that owns its own gutters is not moved', () => {
  const { getByTestId, rerender } = render(<PageShell><span>x</span></PageShell>)
  expect(getByTestId('page-shell').className).toContain('p-3')
  rerender(<PageShell flush><span>x</span></PageShell>)
  expect(getByTestId('page-shell').className).not.toContain('p-3')
  expect(getByTestId('page-shell').className).not.toContain('gap-4')
})
```

Then in `apps/web/src/components/ui/PageShell.tsx`, add the prop:

```tsx
  /**
   * Drop the frame's own gutters and gap (M44 erratum E25, M45 plan erratum E18).
   *
   * `PageShell` is `gap-4 p-3 md:p-4`, and every `/w/:id/*` page already carries its own
   * `px-[20px] pt-[16px]` from the design handoff. Wrapping them as-is would move pixels on five
   * pages whose design this milestone does not change -- and `gate:m14-fidelity` screenshots four
   * of them. `flush` is how those pages get the shell's LANDMARK and its `page-shell` marker with
   * no visual change at all; a page that has no gutters of its own should not use it.
   */
  readonly flush?: boolean
```

and thread it into the root element:

```tsx
    <div data-testid={testId} className={`flex min-w-0 flex-1 flex-col ${flush === true ? '' : 'gap-4 p-3 md:p-4'}`}>
```

Run: `npx vitest run --project unit <that file>`
Expected: PASS, and `WorkforceClient`'s own cases unchanged (it passes no `flush`).

- [ ] **Step 2: Write the failing component test for `ProjectBrief`**

Create `apps/web/test/project-brief.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProjectBrief } from '../src/components/project/ProjectBrief'

const BRIEF = {
  objective: { text: 'Ship the checkout flow', version: 3 },
  supervisor: { state: 'decisions' as const, label: '2 DECISIONS WAITING', needsYou: true },
  work: { working: 2, verifying: 1, review: 0, waiting: 1, done: 4 },
  team: [
    { slaveId: 's1', name: 'Ada', roleLabel: 'developer', status: 'WORKING', taskTitle: 'Add Apple Pay', company: true },
    { slaveId: 's2', name: 'Bo', roleLabel: 'reviewer', status: 'IDLE', taskTitle: null, company: false },
  ],
  needsYou: [
    { kind: 'blocked_task' as const, id: 't1', title: 'Wire the webhook — no credentials', href: '/w/w1/tasks?task=t1', since: '2026-09-09T08:00:00.000Z', taskId: 't1', decisionId: null, messageId: null },
    { kind: 'decision' as const, id: 'd1', title: 'No reviewer: nobody holds reviewer', href: '/w/w1#decision-d1', since: '2026-09-09T09:00:00.000Z', taskId: null, decisionId: 'd1', messageId: null },
  ],
  latestVerified: { taskTitle: 'Add the banner', kind: 'integrated' as const, at: '2026-09-09T10:00:00.000Z' },
  cost: { spentUsd: 12.5, measuredUsd: 9.5, unmeasuredCalls: 3, budgetUsd: 25 },
  recentChanges: [{ at: '2026-09-09T10:30:00.000Z', summary: 'Project · goal set' }],
}

describe('ProjectBrief', () => {
  it('renders exactly the eight facts, each on its own tile', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const tiles = screen.getAllByTestId('brief-tile')
    expect(tiles.map((tile) => tile.getAttribute('data-brief'))).toEqual([
      'objective', 'supervisor', 'work', 'cost', 'needs-you', 'latest-verified', 'team', 'recent-changes',
    ])
  })

  it('says the objective and its version, and links to where it is edited', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const tile = screen.getAllByTestId('brief-tile')[0]
    expect(tile).toHaveTextContent('Ship the checkout flow')
    expect(tile).toHaveTextContent('v3')
    expect(within(tile).getByRole('link')).toHaveAttribute('href', '/w/w1/settings')
  })

  it('says what the Supervisor is doing in one word, with the raw state in title', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const state = screen.getByTestId('brief-supervisor-state')
    expect(state).toHaveTextContent('2 DECISIONS WAITING')
    expect(state).toHaveAttribute('title', 'decisions')
  })

  it('names the two halves of the money and never prints a bare unmeasured figure', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const tile = screen.getAllByTestId('brief-tile').find((t) => t.getAttribute('data-brief') === 'cost')
    expect(tile).toHaveTextContent('$12.50')
    expect(tile).toHaveTextContent('$25')
    expect(tile).toHaveTextContent('3 unmeasured calls charged at $1.00 each')
  })

  it('lists what needs a person, with a working link each', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const rows = screen.getAllByTestId('needs-you-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].querySelector('a')).toHaveAttribute('href', '/w/w1/tasks?task=t1')
  })

  it('says nothing is verified yet rather than leaving the tile blank', () => {
    render(<ProjectBrief workspaceId="w1" brief={{ ...BRIEF, latestVerified: null, needsYou: [] }} />)
    const tile = screen.getAllByTestId('brief-tile').find((t) => t.getAttribute('data-brief') === 'latest-verified')
    expect(tile).toHaveTextContent('nothing verified yet')
    const needs = screen.getAllByTestId('brief-tile').find((t) => t.getAttribute('data-brief') === 'needs-you')
    expect(needs).toHaveTextContent('nothing needs you')
  })

  it('marks a company worker and shows what each one is on', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const tile = screen.getAllByTestId('brief-tile').find((t) => t.getAttribute('data-brief') === 'team')
    expect(tile).toHaveTextContent('Ada')
    expect(tile).toHaveTextContent('Add Apple Pay')
    expect(within(tile as HTMLElement).getByTestId('team-company')).toHaveTextContent('company')
  })

  it('shows no budget figure at all on an unbudgeted project', () => {
    render(<ProjectBrief workspaceId="w1" brief={{ ...BRIEF, cost: { ...BRIEF.cost, budgetUsd: null } }} />)
    const tile = screen.getAllByTestId('brief-tile').find((t) => t.getAttribute('data-brief') === 'cost')
    expect(tile).not.toHaveTextContent('/ $')
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run --project unit apps/web/test/project-brief.test.tsx`
Expected: FAIL — the component does not exist.

- [ ] **Step 4: Write `ProjectBrief`**

`apps/web/src/components/project/ProjectBrief.tsx`, a `'use client'` component taking
`{ workspaceId: string; brief: ProjectBrief }`. Two rows of four tiles in one
`grid grid-cols-1 gap-[11px] px-[20px] pt-[16px] md:grid-cols-2 xl:grid-cols-4` container marked
`data-testid="brief"`, each tile a `<div data-testid="brief-tile" data-brief="...">` built from
`Panel` with a `SectionLabel` caption. In order:

1. **objective** — the goal text (truncated to three lines with `line-clamp-3`, the whole text in `title`), a `v{version}` `Chip`, and a `<Link href={`/w/${workspaceId}/settings`}>edit →</Link>`. `text === null` renders `no objective yet · set one` as the link's words.
2. **supervisor** — `<span data-testid="brief-supervisor-state" title={brief.supervisor.state}>{brief.supervisor.label}</span>` inside a `StatusPill`-toned wrapper; `needsYou` picks the `blocked` tone, otherwise `working` when the state is `working` and the neutral tone otherwise.
3. **work** — five figures with the domain's words: `WORKING n · VERIFYING n · IN REVIEW n · WAITING n · DONE n`, each `<span data-testid="brief-work-<state>">`. A zero is dimmed, never hidden: a person reading "is anything being reviewed" needs the 0.
4. **cost** — `$${spentUsd.toFixed(2)}` and, when `budgetUsd !== null`, ` / $${budgetUsd}`; a second line `measured $${measuredUsd.toFixed(2)}`; and, when `unmeasuredCalls > 0`, `${unmeasuredCalls} unmeasured calls charged at $1.00 each` in the `waiting` tone. Never one bare number, per the M32 upper-bound policy.
5. **needs-you** — `brief.needsYou` as `<li data-testid="needs-you-row">` rows: a `Chip` with the kind's word (`BLOCKED` / `DECISION` / `QUESTION` / `READY TO INTEGRATE`), the title, and `<Link href={item.href}>`. Empty renders `<EmptyState testId="needs-you-empty" message="nothing needs you" />`.
6. **latest-verified** — `${taskTitle} — ${KIND_WORD[kind]}` (`integrated → integrated into the base branch`, `approved → approved in review`, `verified → passed its verify commands`) and the timestamp. `null` renders `nothing verified yet`.
7. **team** — one row per member: an `AvatarTile`, the name, the `roleLabel`, the projected `status`, the `taskTitle` (or `—`), and `{member.company && <span data-testid="team-company">company</span>}`. Clicking a row calls the OPTIONAL `onOpenSlave?: (slaveId: string) => void` prop (`?slave=`), which `OverviewClient` passes and the component test omits — a brief with no handler is still a correct brief, so the row is a plain `<div>` when it is absent and a `<button>` when it is not.
8. **recent-changes** — up to six `at` + `summary` lines, `HH:MM:SS` out of the ISO stamp the way `LiveEventsPanel` does it.

The whole component is presentational: it fetches nothing and holds no state. Every string it
renders that a model or a person wrote (`objective.text`, `needsYou[].title`, `recentChanges[].summary`)
goes in as JSX children — another party's text is data, never elements.

Its docblock states the one deliberate overlap, so a reviewer does not read it as a bug:

```tsx
/**
 * The eight facts (M45 R1), in two rows of four.
 *
 * The `work` tile and the `strip` below it on the page BOTH count this project's tasks, and that
 * is deliberate (M45 plan erratum E17). They are not the same statement: this tile speaks the
 * domain's user vocabulary (`userTaskStatus` -- WORKING / VERIFYING / IN REVIEW / WAITING / DONE),
 * which is what a person reads in ten seconds; `TopStrip` keeps the raw board counts the design
 * handoff documents and `gate:m14-fidelity` measures. Deleting the strip in a milestone that must
 * not move README pixels was not on the table.
 */
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run --project unit apps/web/test/project-brief.test.tsx`
Expected: PASS.

- [ ] **Step 6: Write the failing component test for `SupervisorRequest` and `SupervisorTimeline`**

Create `apps/web/test/supervisor-timeline.test.tsx`. Stub `fetch` the way
`apps/web/test/supervisor-panel.test.tsx` already does — **read that file's `beforeEach` first and
copy its stub verbatim** rather than inventing a second one.

```tsx
const ENTRIES = [
  { key: 'event-9', lane: 'user_request', laneLabel: 'USER REQUEST', at: '2026-09-09T12:00:00.000Z', title: 'Add Apple Pay', detail: null, taskId: null, taskTitle: null, eventType: 'workspace.goal_set', decision: null, collapsedCount: 0 },
  { key: 'event-8', lane: 'interpretation', laneLabel: 'SUPERVISOR INTERPRETATION', at: '2026-09-09T11:59:00.000Z', title: 'understood v2: +Add Apple Pay; 3 kept', detail: null, taskId: null, taskTitle: null, eventType: 'workspace.replanned', decision: null, collapsedCount: 0 },
  { key: 'event-7', lane: 'work', laneLabel: 'WORK IN PROGRESS', at: '2026-09-09T11:58:00.000Z', title: 'Add Apple Pay', detail: 'reading src/pay.ts', taskId: 't1', taskTitle: 'Add Apple Pay', eventType: 'slave.message_sent', decision: null, collapsedCount: 2 },
  { key: 'event-6', lane: 'verified', laneLabel: 'VERIFIED RESULT', at: '2026-09-09T11:57:00.000Z', title: 'Add the banner', detail: 'feature/banner', taskId: 't2', taskTitle: 'Add the banner', eventType: 'task.verify_passed', decision: null, collapsedCount: 0 },
]

const DECISION_ENTRY = {
  key: 'decision-d1', lane: 'decision', laneLabel: 'DECISION REQUIRED', at: '2026-09-09T11:00:00.000Z',
  title: 'nobody holds reviewer', detail: 'no holder', taskId: null, taskTitle: null, eventType: null,
  collapsedCount: 0,
  decision: {
    id: 'd1', situationKind: 'no_reviewer', situation: { kind: 'no_reviewer', subjectId: 'reviewer', summary: 'nobody holds reviewer' },
    action: { kind: 'escalate_to_human', summary: 'nobody holds reviewer' }, draft: null, rationale: 'no holder',
    tier: 'proposed', status: 'pending', decidedBy: 'rules', createdAt: '2026-09-09T11:00:00.000Z', expiresAt: null,
  },
}

describe('SupervisorTimeline', () => {
  it('pins DECISION REQUIRED above the river when there is one', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={[...ENTRIES, DECISION_ENTRY]} needsYou={[]} />)
    const pinned = screen.getByTestId('timeline-decisions')
    expect(within(pinned).getByTestId('supervisor-proposal')).toBeTruthy()
    expect(pinned.compareDocumentPosition(screen.getByTestId('timeline')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders no pinned section at all when nothing needs a decision', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    expect(screen.queryByTestId('timeline-decisions')).toBeNull()
  })

  it('carries the lane and the raw event type on every entry', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    const rows = screen.getAllByTestId('timeline-entry')
    expect(rows.map((row) => row.getAttribute('data-lane'))).toEqual(['user_request', 'interpretation', 'work', 'verified'])
    expect(rows[0].getAttribute('data-event-type')).toBe('workspace.goal_set')
  })

  it('never prints a dotted event type as visible words', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    expect(screen.getByTestId('timeline').textContent).not.toContain('workspace.goal_set')
    expect(screen.getByTestId('timeline').textContent).not.toContain('slave.message_sent')
  })

  it('says how many earlier messages an entry stands for', () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    expect(screen.getByText('+2 earlier')).toBeTruthy()
  })

  it('filters to one lane and back', async () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    await userEvent.click(screen.getByTestId('timeline-lane-filter-verified'))
    expect(screen.getAllByTestId('timeline-entry')).toHaveLength(1)
    await userEvent.click(screen.getByTestId('timeline-lane-filter-verified'))
    expect(screen.getAllByTestId('timeline-entry')).toHaveLength(4)
  })

  it('says so when a filter empties the river', async () => {
    render(<SupervisorTimeline workspaceId="w1" entries={ENTRIES} needsYou={[]} />)
    await userEvent.click(screen.getByTestId('timeline-lane-filter-plan_change'))
    expect(screen.getByTestId('timeline-empty')).toBeTruthy()
  })

  it('approves a proposal through the decision route', async () => {
    const fetchMock = stubFetch({ ok: true })
    render(<SupervisorTimeline workspaceId="w1" entries={[DECISION_ENTRY]} needsYou={[]} />)
    await userEvent.click(screen.getByTestId('supervisor-approve'))
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/supervisor/decisions/d1/approve', expect.objectContaining({ method: 'POST' }))
  })

  it('answers an unanswerable question in place', async () => {
    const fetchMock = stubFetch({ ok: true })
    const question = { kind: 'question' as const, id: 'm1', title: 'Ada asked: Which gateway?', href: '/w/w1#question-m1', since: '2026-09-09T10:00:00.000Z', taskId: null, decisionId: null, messageId: 'm1' }
    render(<SupervisorTimeline workspaceId="w1" entries={[]} needsYou={[question]} />)
    await userEvent.type(screen.getByTestId('timeline-answer-input'), 'Stripe')
    await userEvent.click(screen.getByTestId('timeline-answer-send'))
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/messages/m1/answer', expect.objectContaining({ method: 'POST' }))
  })

  it('unblocks a blocked task in place', async () => {
    const fetchMock = stubFetch({ ok: true })
    const blocked = { kind: 'blocked_task' as const, id: 't1', title: 'Wire the webhook — no credentials', href: '/w/w1/tasks?task=t1', since: '2026-09-09T10:00:00.000Z', taskId: 't1', decisionId: null, messageId: null }
    render(<SupervisorTimeline workspaceId="w1" entries={[]} needsYou={[blocked]} />)
    await userEvent.click(screen.getByTestId('timeline-unblock'))
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/tasks/t1/unblock', expect.objectContaining({ method: 'POST' }))
  })

  it('offers a link, not a button, for work waiting to be integrated', () => {
    const integrate = { kind: 'integrate' as const, id: 't2', title: 'Add the banner — ready to integrate', href: '/w/w1/tasks?task=t2', since: '2026-09-09T10:00:00.000Z', taskId: 't2', decisionId: null, messageId: null }
    render(<SupervisorTimeline workspaceId="w1" entries={[]} needsYou={[integrate]} />)
    expect(screen.getByRole('link', { name: /Add the banner/u })).toHaveAttribute('href', '/w/w1/tasks?task=t2')
    expect(screen.queryByTestId('timeline-unblock')).toBeNull()
  })
})

describe('SupervisorRequest', () => {
  it('sends the words and reports the version it made', async () => {
    const fetchMock = stubFetch({ ok: true, version: 3, sha256: 'abc', goal: '…' })
    render(<SupervisorRequest workspaceId="w1" />)
    await userEvent.type(screen.getByTestId('supervisor-request-input'), 'Add Apple Pay')
    await userEvent.click(screen.getByTestId('supervisor-request-send'))
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/goal/request', expect.objectContaining({ method: 'POST' }))
    expect(await screen.findByTestId('supervisor-request-result')).toHaveTextContent('goal v3')
  })

  it('will not send an empty request', () => {
    render(<SupervisorRequest workspaceId="w1" />)
    expect(screen.getByTestId('supervisor-request-send')).toBeDisabled()
  })

  it('shows a refusal without clearing what was typed', async () => {
    stubFetch({ error: 'the goal of project w1 already reads exactly this at version 3: nothing was recorded', kind: 'goal_unchanged' }, 409)
    render(<SupervisorRequest workspaceId="w1" />)
    await userEvent.type(screen.getByTestId('supervisor-request-input'), 'Add Apple Pay')
    await userEvent.click(screen.getByTestId('supervisor-request-send'))
    expect(await screen.findByTestId('supervisor-request-result')).toHaveTextContent('nothing was recorded')
    expect(screen.getByTestId('supervisor-request-input')).toHaveValue('Add Apple Pay')
  })
})
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run --project unit apps/web/test/supervisor-timeline.test.tsx`
Expected: FAIL — neither component exists.

- [ ] **Step 8: Export `ProposalRow` and `DraftEditor`**

In `apps/web/src/components/SupervisorPanel.tsx`, change `function DraftEditor(` to
`export function DraftEditor(` and `function ProposalRow(` to `export function ProposalRow(`, and
add one sentence to each docblock:

```
 * Exported since M45: the Supervisor timeline's DECISION REQUIRED lane renders the same row, so a
 * proposal reads and answers identically wherever it is shown. Exported IN PLACE rather than moved
 * to a file of its own, so `apps/web/test/supervisor-panel.test.tsx` keeps testing it where it has
 * always been tested.
```

- [ ] **Step 9: Write `SupervisorRequest`**

`apps/web/src/components/project/SupervisorRequest.tsx`, `'use client'`, props `{ workspaceId: string }`:
a `Panel` titled `tell the Supervisor what changed`, a `<textarea data-testid="supervisor-request-input" rows={2}>`
holding local state, and a `<Button variant="primary" data-testid="supervisor-request-send">` disabled
while the trimmed value is empty or a POST is in flight. On click it POSTs
`{ request }` to `/api/w/${workspaceId}/goal/request` through the existing `postControl` helper's
sibling — **read `apps/web/src/lib/postControl.ts` first**: if it cannot return a body, add a
`postJson` beside it rather than a second `fetch` idiom inside this component, and say so in the
commit. On success it clears the box and renders
`<span data-testid="supervisor-request-result">goal v{version} saved — the next tick re-plans it as a delta</span>`;
on refusal it KEEPS the box and renders the refusal's `error` in the same element, in the
`blocked` tone.

Its docblock says what this is not:

```tsx
/**
 * One input, one verb (M45 R3).
 *
 * This does not brief a model, hire anybody or cancel a task. It writes a GOAL VERSION whose text
 * is the standing goal plus a dated line saying what was asked, and M40's trigger re-plans that
 * version as a delta on the next tick. What the re-plan adds becomes tasks; what it wants to
 * cancel becomes proposals a person approves. That whole path is visible on the timeline below,
 * lane by lane, and nothing here pretends to more than it.
 *
 * "Bring in a security specialist" is M47/M50. Until then the request lands in the goal and the
 * re-plan may add a task for it; the copy above promises exactly that and no more.
 */
```

- [ ] **Step 10: Write `SupervisorTimeline`**

`apps/web/src/components/project/SupervisorTimeline.tsx`, `'use client'`, props
`{ workspaceId: string; entries: readonly TimelineEntry[]; needsYou: readonly NeedsYouItem[] }`.
Structure, top to bottom:

1. **The pinned lane.** Rendered only when `entries.some((e) => e.lane === 'decision')` or
   `needsYou.some((item) => item.kind !== 'integrate')`. A `<section data-testid="timeline-decisions">`
   with the `DECISION REQUIRED` `SectionLabel`, holding:
   - every `decision` entry as `<ProposalRow decision={entry.decision} questions={[]} taskTitles={{}} busy={busy} onApprove={…} onReject={…} />`, wrapped in `<div id={`decision-${entry.decision.id}`}>` so the needs-you tile's `#decision-…` link lands on it. `onApprove` POSTs `/api/w/${workspaceId}/supervisor/decisions/${id}/approve` with `body === undefined ? {} : { body }`; `onReject` POSTs `…/reject` with `reason === '' ? {} : { reason }` — the same two envelopes `SupervisorPanel` already sends, read off that file rather than re-invented.
   - every `needsYou` item of kind `question` as a row with the question text, a `<textarea data-testid="timeline-answer-input">` and a `<Button data-testid="timeline-answer-send">` POSTing `{ answer }` to `/api/w/${workspaceId}/messages/${item.messageId}/answer`, inside `<div id={`question-${item.messageId}`}>`.
   - every `needsYou` item of kind `blocked_task` as a row with the title and a `<Button data-testid="timeline-unblock">` POSTing to `/api/w/${workspaceId}/tasks/${item.taskId}/unblock`.
   - every `needsYou` item of kind `integrate` as a row whose only affordance is `<Link href={item.href}>` — there is no web integration verb, and offering a button that cannot work would be worse than the link (plan erratum E11).
   Each POST sets a per-row `busy` id, and a refusal renders `<span role="alert" data-testid="timeline-error">` beside that row without touching the others.
2. **The lane filters.** `TIMELINE_LANES.map(...)` as toggle chips
   `<button data-testid={`timeline-lane-filter-${lane}`} data-lane={lane} aria-pressed={…}>{LANE_LABEL[lane]}</button>`,
   in a `role="group"` with `aria-label="Timeline lanes"`. State is a `Set<TimelineLane>`; empty means "all".
3. **The river.** `<ol data-testid="timeline">` of
   `<li data-testid="timeline-entry" data-lane={entry.lane} data-event-type={entry.eventType ?? undefined} title={entry.eventType ?? undefined}>`
   carrying: `HH:MM:SS`, a lane chip reading `LANE_LABEL[entry.lane]`, the `title` sentence, the
   `detail` line when present, the task title when present, and
   `{entry.collapsedCount > 0 && <span>+{entry.collapsedCount} earlier</span>}`. A filtered-empty
   river renders `<EmptyState testId="timeline-empty" message="nothing in these lanes yet" />`.

Docblock:

```tsx
/**
 * The project's history in six lanes (M45 R2).
 *
 * ORGANISATIONAL events and pending decisions -- what the project decided, not what a model said
 * while working. `laneFor` in the domain decides which lane an entry is on, and it is exhaustive
 * over every event type the database can store, so nothing arrives here unclassified and
 * `run.tool_call` cannot appear at all.
 *
 * DECISION REQUIRED is pinned above the river rather than sorted into it, and the reason is the
 * whole point of this page: a decision waiting on a person is not a thing that happened, it is a
 * thing that has not happened yet. Everything it can do it does through a verb that already
 * existed -- the M38/M39 approve/reject routes, M36's answer route, M35's unblock -- and the rows
 * are the SAME `ProposalRow`/`DraftEditor` the Supervisor panel renders, so a proposal reads and
 * answers identically wherever it is shown.
 *
 * The raw event type is on `data-event-type` and in `title`, never in the words: `docs/ia.md`
 * rule 3.
 */
```

- [ ] **Step 11: Run the component tests**

Run: `npx vitest run --project unit apps/web/test/supervisor-timeline.test.tsx`
Expected: PASS.

- [ ] **Step 12: Write `OverviewAdvanced` and rebuild `OverviewClient`**

`apps/web/src/components/project/OverviewAdvanced.tsx` — a `<details data-testid="overview-advanced">`
whose `<summary>` reads `Advanced ▾` and whose children render **only when open** (`const [open, setOpen] = useState(false)`
driving `onToggle`, so a closed disclosure costs no `SupervisorPanel` fetch). Inside, in order:
`<SupervisorPanel workspaceId={workspaceId} refreshKey={refreshKey} />` inside
`<div data-testid="advanced-panel-supervisor">`, then the existing bottom row
`<BlockedPanel … /> <LiveEventsPanel … />`, then `<MergeQueuePanel … />`, then a row of links to
`/w/:id/graph`, `/w/:id/office` and `/analytics?workspace=:id` reusing the project tab strip's
`Advanced ▾` hrefs.

`OverviewClient.tsx` keeps every effect it has (`publishShellFacts`, its separate retraction
effect, `publishStreamState` and its retraction) and every `Alert` it renders, and its render
becomes:

```tsx
      <PageShell flush>
        {view.workspace.haltedReason !== null && <HaltBanner reason={view.workspace.haltedReason} />}
        {error !== null && <Alert variant="notice">showing stale data: {error}</Alert>}
        {view.workspace.adoptedFrom !== null && ( /* unchanged */ )}
        <ProjectBrief workspaceId={workspaceId} brief={view.brief} onOpenSlave={selectSlave} />
        {/* M45 erratum E17: the raw board counts the design handoff documents and
          * `gate:m14-fidelity` measures, kept under the brief that speaks the domain's words. */}
        <TopStrip snapshot={view} />
        <SupervisorRequest workspaceId={workspaceId} />
        <SupervisorTimeline workspaceId={workspaceId} entries={view.timeline} needsYou={view.needsYou} />
        <section data-testid="team" className="px-[20px] pt-[16px]">
          <SectionLabel>team</SectionLabel>
          {/* M45 erratum E16: the Team strip IS this grid. `SlaveCard` renders nowhere else in the
            * app, and six `gate:m14-fidelity` assertions live on it. R4's worker disclosure is the
            * EXPANDED view -- `SlavePanel`'s Details groups, Task 4. */}
          <div className="grid grid-cols-1 gap-[11px] pt-[8px] md:grid-cols-2 xl:grid-cols-3">
            {view.slaves.map((slave) => ( /* the existing SlaveCard call, unchanged */ ))}
          </div>
        </section>
        <OverviewAdvanced workspaceId={workspaceId} view={view} refreshKey={view} />
      </PageShell>
```

`<SlavePanel>` stays exactly where it is, as a sibling of the shell inside the same fragment.

- [ ] **Step 13: Rewrite `overview-components.test.tsx` around the new order**

The file's panel cases (`BlockedPanel`, `LiveEventsPanel`, `MergeQueuePanel`, `TopStrip`,
`SlaveCard`, `HaltBanner`, shell-facts publishing, the adopted-from note) are all still true and
stay verbatim — those components did not change. Three things move:

1. The M24 §3 case asserting "strip + slave cards and nothing else above them" becomes:

```tsx
it('M45 R1: the brief is the first thing on the page, and the strip is directly under it', () => {
  render(<OverviewClient workspaceId="w1" initial={SNAPSHOT} />)
  const shell = screen.getByTestId('page-shell')
  const order = [...shell.children].map((child) => child.getAttribute('data-testid'))
  expect(order.filter((id) => id !== null).slice(0, 2)).toEqual(['brief', 'strip'])
})
```

2. A new case for what moved:

```tsx
it('M45 R1: the river, the blocked panel, the merge queue and the Supervisor panel are under Advanced', async () => {
  render(<OverviewClient workspaceId="w1" initial={SNAPSHOT} />)
  expect(screen.queryByTestId('live-events')).toBeNull()
  expect(screen.queryByTestId('advanced-panel-supervisor')).toBeNull()
  await userEvent.click(screen.getByTestId('overview-advanced'))
  expect(screen.getByTestId('live-events')).toBeTruthy()
  expect(screen.getByText('merge queue · serial')).toBeTruthy()
  expect(screen.getByTestId('advanced-panel-supervisor')).toBeTruthy()
})
```

3. `SNAPSHOT` gains `brief`, `needsYou` and `timeline`. Add them as one exported fixture at the
top of the file so the new cases and the old ones share it.

Run: `npx vitest run --project unit apps/web/test/overview-components.test.tsx`
Expected: PASS.

- [ ] **Step 14: Show the request on the goal-set activity card (E24)**

In `apps/web/src/components/activity/cards.tsx`, `WorkspaceGoalSetCard` gains one line before the
goal text:

```tsx
      {typeof payload.request === 'string' && payload.request !== '' && (
        <span data-testid="goal-set-request" className="text-[11px] text-text-2">
          requested: {payload.request}
        </span>
      )}
```

and one case in `apps/web/test/activity-cards.test.tsx`:

```tsx
it('workspace.goal_set shows the words a person requested, when there were any', () => {
  const Card = ACTIVITY_CARDS['workspace.goal_set']
  render(<Card event={baseEvent('workspace.goal_set', { goal: 'Ship it', version: 2, sha256: 'a', request: 'Add Apple Pay' })} {...CARD_PROPS} />)
  expect(screen.getByTestId('goal-set-request')).toHaveTextContent('Add Apple Pay')
})
```

`PAYLOAD_BY_TYPE` is NOT changed: it holds minimal valid payloads, and `request` is optional.

- [ ] **Step 15: Record it in `docs/ia.md`**

In the "Project surfaces" table, the `/w/:id` Overview row's `Later` column becomes
`M46 lifts the org graph's content into an Organization tab`, and a new column entry records what
M45 did:

```
| `/w/:id` Overview | What is happening right now, and what needs me | keep (tab 1) | Rebuilt as a brief (eight facts), one input to the Supervisor, and a six-lane timeline whose decisions are answerable in place; the live-events river, the blocked panel, the merge queue and the Supervisor panel moved under `Advanced ▾` on the page; the team is the same card grid, under a `Team` label | M46 lifts the org graph's content into an Organization tab |
```

and append to the "Panels that stay where they are, deliberately" section:

```
- The Overview's own `Advanced ▾` holds the four panels that left its first viewport — the
  Supervisor panel, `blocked · needs you`, the live-events river and the merge queue. All four
  keep their components, their tests and their behaviour; the river keeps its 340 px, which
  `gate:m14-fidelity` still measures (it opens the disclosure first).
```

- [ ] **Step 16: Full task verification**

```bash
npx vitest run --project unit apps/web
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
pgrep -af "next dev"     # must be empty
npm run web:build
CHROMIUM_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())") \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m44-ux-foundation
```
Expected: every one green. The m44 gate is the browser check for this task: it re-scans eleven
pages for raw enum tokens as visible text, and the Overview is the page this task rewrote — a
`workspace.goal_set` or a `no_reviewer` printed as words fails there, which is exactly the check
this page needs. If its stage 3 now measures a `page-shell` on `/w/<id>` where it did not before,
that is the E18 adoption arriving and is correct; do not weaken the stage.

- [ ] **Step 17: Commit**

```bash
git add apps/web/src/components apps/web/test docs/ia.md
git commit -m "$(cat <<'EOF'
feat(web): m45 t3 -- the Overview is a brief, one input and a six-lane timeline

Eight tiles in two rows answer the ten-second questions, and the tile that says what the Supervisor
is doing reads one word with the raw state in `title`. Under it, unchanged: the strip the design
handoff documents and the fidelity gate measures. The overlap between the two is deliberate and
both docblocks say so -- the tile speaks the domain's user vocabulary, the strip keeps the board's
raw counts, and deleting the strip in a milestone that must not move README pixels was not on the
table.

The timeline is events and pending decisions in six lanes, classified by the domain's exhaustive
table, with DECISION REQUIRED pinned above the river because a decision waiting on a person is not
a thing that happened. It answers in place through verbs that already existed -- approve, reject,
answer, unblock -- and renders the SAME ProposalRow and DraftEditor the Supervisor panel does,
exported in place so that panel's 633-line test file keeps testing them where it always has. Work
waiting to be integrated gets a link rather than a button: `confirmIntegration` has no web route,
and an affordance that cannot work is worse than one that is honest about where to go.

Nothing was removed. The live-events river, `blocked · needs you`, the merge queue and the
Supervisor panel are under the page's own `Advanced ▾`, rendered only when it is open so a closed
disclosure costs no fetch. The Team strip is the same `SlaveCard` grid it always was, under a
label: that card renders nowhere else in the application, and six fidelity assertions live on it.

`PageShell` gains `flush` so the project pages get the shell's landmark with no pixel moved.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 4: Progressive disclosure on tasks and workers, and `PageShell` everywhere else (R4/R5)

**Files:**
- Create: `apps/web/src/components/ui/DetailsGroup.tsx`
- Modify: `apps/web/src/components/TaskCard.tsx`, `apps/web/src/components/TaskDetailPanel.tsx`, `apps/web/src/components/SlavePanel.tsx`, `apps/web/src/lib/tones.ts`, and the page frames: `apps/web/src/app/w/[workspaceId]/{tasks,activity,settings,graph,office}/page.tsx` (or the clients they render — whichever owns the frame), `apps/web/src/components/{ProjectsClient,AnalyticsClient}.tsx`, `apps/web/src/components/settings/…` (the `/settings` client) and `apps/web/src/components/sim/SimulationsClient.tsx`
- Test: `apps/web/test/tasks-components.test.tsx`, `apps/web/test/slave-panel.test.tsx`, `apps/web/test/ui-primitives.test.tsx` (the `DetailsGroup` cases), plus one case per adopting page in its existing test file

**Interfaces:**
- Consumes from Task 3: `PageShell`'s `flush` prop. From the tree: `TaskBoardItem`/`TaskRunSummary` (`../server/tasks`), `SlaveCardData` (`../server/overview`), `userTaskStatus`/`USER_TASK_LABEL` (`@slave-of-ai/domain`), `CARD_STATE_TONE`/`cardStateForTask` (`../lib/tones`), `providerLabel` (`../lib/providerLabel`).
- Produces, for Task 5, as `data-testid`s: `details-group` (with `data-group` in `run | model | profile | skills | messages | context | verification | cost | worktree | events`), `task-why`, `task-status-word`, and `page-shell` on every remaining `/w/:id/*` page and on `/`, `/sim`, `/settings`, `/analytics`.

- [ ] **Step 1: Write the failing test for `DetailsGroup`**

Append to `apps/web/test/ui-primitives.test.tsx`:

```tsx
describe('DetailsGroup', () => {
  it('is closed by default and names itself for a test and a gate', () => {
    render(<DetailsGroup group="run" title="Run"><span data-testid="inside">x</span></DetailsGroup>)
    const group = screen.getByTestId('details-group')
    expect(group.getAttribute('data-group')).toBe('run')
    expect(screen.queryByTestId('inside')).toBeNull()
  })

  it('renders its children only once opened, so a closed group costs nothing', async () => {
    render(<DetailsGroup group="cost" title="Cost"><span data-testid="inside">x</span></DetailsGroup>)
    await userEvent.click(screen.getByText('Cost'))
    expect(screen.getByTestId('inside')).toBeTruthy()
  })

  it('can start open, for the one group a panel leads with', () => {
    render(<DetailsGroup group="run" title="Run" defaultOpen><span data-testid="inside">x</span></DetailsGroup>)
    expect(screen.getByTestId('inside')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit apps/web/test/ui-primitives.test.tsx`
Expected: FAIL — the primitive does not exist.

- [ ] **Step 3: Write `DetailsGroup`**

```tsx
'use client'

import { useState } from 'react'
import { SECTION_LABEL_CLASS } from './SectionLabel'

/** The ten groups R4 names, in the order a panel shows them. A closed union so a group name
 *  cannot be typed twice differently in two panels. */
export type DetailsGroupName =
  | 'run' | 'model' | 'profile' | 'skills' | 'messages'
  | 'context' | 'verification' | 'cost' | 'worktree' | 'events'

/**
 * One `Details ▾` group (M45 R4).
 *
 * Children are rendered only while OPEN, and that is the point rather than a nicety: three of
 * these groups fetch on mount (`run-context`, artifacts, the live feed), and a panel that opened
 * ten collapsed groups would issue every one of those requests to show a person nothing. It is
 * also what makes the raw values honest -- ids, hashes and statuses live INSIDE a group, so the
 * simple row above stays readable and nothing is hidden, only folded.
 *
 * A native `<details>` would render its subtree regardless, so this is a button and a region.
 */
export function DetailsGroup({
  group,
  title,
  defaultOpen = false,
  children,
}: {
  readonly group: DetailsGroupName
  readonly title: string
  readonly defaultOpen?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section data-testid="details-group" data-group={group} data-open={open} className="flex flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`flex items-center gap-1 text-left ${SECTION_LABEL_CLASS}`}
      >
        {title} {open ? '▾' : '▸'}
      </button>
      {open && children}
    </section>
  )
}
```

Run: `npx vitest run --project unit apps/web/test/ui-primitives.test.tsx`
Expected: PASS.

- [ ] **Step 4: Write the failing test for the task row's word and its "why"**

Append to `apps/web/test/tasks-components.test.tsx`:

```tsx
describe('TaskCard (M45 R4: the simple row)', () => {
  it('reads the domain word, with the raw status still on the card', () => {
    render(<TaskCard task={{ ...TASK, status: 'reviewing' }} workspaceGoalVersion={1} onSelect={() => {}} />)
    expect(screen.getByTestId('task-status-word')).toHaveTextContent('IN REVIEW')
    expect(screen.getByTestId('task-card').getAttribute('data-status')).toBe('reviewing')
  })

  it('says WAITING on a task whose worker is waiting for an answer', () => {
    render(<TaskCard task={{ ...TASK, status: 'waiting' }} workspaceGoalVersion={1} onSelect={() => {}} />)
    expect(screen.getByTestId('task-status-word')).toHaveTextContent('WAITING')
  })

  it('gives a blocked task its reason as the one-line why', () => {
    render(<TaskCard task={{ ...TASK, status: 'blocked', lastRejectionReason: 'no credentials' }} workspaceGoalVersion={1} onSelect={() => {}} />)
    expect(screen.getByTestId('task-why')).toHaveTextContent('no credentials')
  })

  it('gives a waiting task who it is waiting on', () => {
    const task = { ...TASK, status: 'waiting' as const, runs: [{ ...RUN, waitingFor: { recipient: 'Bo', question: 'Which gateway?', messageId: 'm1' } }] }
    render(<TaskCard task={task} workspaceGoalVersion={1} onSelect={() => {}} />)
    expect(screen.getByTestId('task-why')).toHaveTextContent('waiting for Bo')
  })

  it('gives a task sent back its rework reason', () => {
    render(<TaskCard task={{ ...TASK, status: 'rework', lastRejectionReason: 'tests fail on Windows' }} workspaceGoalVersion={1} onSelect={() => {}} />)
    expect(screen.getByTestId('task-why')).toHaveTextContent('tests fail on Windows')
  })

  it('renders no why line at all when there is nothing to explain', () => {
    render(<TaskCard task={{ ...TASK, status: 'running', lastRejectionReason: null }} workspaceGoalVersion={1} onSelect={() => {}} />)
    expect(screen.queryByTestId('task-why')).toBeNull()
  })
})

describe('TaskDetailPanel (M45 R4: the expanded view)', () => {
  it('groups everything raw under Details, in the spec order', () => {
    render(<TaskDetailPanel task={TASK_WITH_RUNS} workspaceId="w1" onClose={() => {}} />)
    expect(screen.getAllByTestId('details-group').map((g) => g.getAttribute('data-group'))).toEqual([
      'run', 'messages', 'context', 'verification', 'cost', 'worktree', 'events',
    ])
  })

  it('keeps the task ref and the goal stamp OUT of a group -- they are the row's identity', () => {
    render(<TaskDetailPanel task={TASK_WITH_RUNS} workspaceId="w1" onClose={() => {}} />)
    const ref = screen.getByTestId('task-panel-ref')
    expect(ref.closest('[data-testid="details-group"]')).toBeNull()
  })

  it('does not fetch a run context until its group is opened', async () => {
    const fetchMock = stubFetch({ prompt: 'p', manifest: { kind: 'implementation', sections: [] } })
    render(<TaskDetailPanel task={TASK_WITH_RUNS} workspaceId="w1" onClose={() => {}} />)
    expect(fetchMock).not.toHaveBeenCalled()
    await userEvent.click(screen.getByText(/Context sources/u))
    await userEvent.click(screen.getByTestId('run-context-open'))
    expect(fetchMock).toHaveBeenCalled()
  })
})
```

Append to `apps/web/test/slave-panel.test.tsx`:

```tsx
it('M45 R4: groups the worker panel under the same Details names', () => {
  render(<SlavePanel slave={SLAVE} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />)
  expect(screen.getAllByTestId('details-group').map((g) => g.getAttribute('data-group'))).toEqual([
    'run', 'model', 'profile', 'skills', 'messages', 'cost', 'events',
  ])
})

it('M45 R4: the header keeps the four things a simple row shows, ungrouped', () => {
  render(<SlavePanel slave={SLAVE} liveEvents={[]} workspaceId="w1" haltedReason={null} onClose={() => {}} />)
  for (const id of ['status-label', 'pause-button', 'stop-button']) {
    expect(screen.getByTestId(id).closest('[data-testid="details-group"]')).toBeNull()
  }
})
```

- [ ] **Step 5: Run them and watch them fail**

Run: `npx vitest run --project unit apps/web/test/tasks-components.test.tsx apps/web/test/slave-panel.test.tsx`
Expected: FAIL on the new cases; every existing case in both files still passes.

- [ ] **Step 6: Give the task row the domain's word and its "why"**

In `apps/web/src/lib/tones.ts`, `cardStateForTask` keeps its board-column derivation (four
documented exceptions and all) — the TONE still comes from there. What changes is the LABEL. Add
beside it:

```ts
/**
 * The WORD a task's pill reads, from the domain (M44 erratum E3's deferred half, delivered here).
 *
 * M44 kept the board's pill on `cardStateForTask`'s column vocabulary and said so; M45 R4 is where
 * that changes. The TONE still comes from the column state -- that is the board's own grouping,
 * with its four documented exceptions, and it decides which colour a card is, not what it says.
 * The word comes from `userTaskStatus`, which is the one vocabulary `docs/ia.md` rule 3 names.
 * The raw status stays on the card's `data-status`, where it always was.
 */
export function taskStatusWord(status: TaskStatus, integrated: boolean): string {
  return userTaskStatus({ status, integrated }).label
}
```

In `apps/web/src/components/TaskCard.tsx`, replace the `StatusPill`'s `label={label}` with
`label={taskStatusWord(task.status, task.integratedAt !== null)}` and wrap it so the word is
readable by a test: give the pill `data-testid="task-status-word"` via its existing `testId` prop
if it has one, otherwise wrap in `<span data-testid="task-status-word">`. Then add the why line
directly under `task-title`:

```tsx
      {whyOf(task) !== null && (
        // M45 R4: the ONE line the simple row owes a person -- why this is not moving. Blocked
        // says what stopped it, waiting says who it waits on, rework says what came back. Anything
        // else is in the expanded view, under a group.
        <span data-testid="task-why" className="text-[10px] leading-[1.35] text-tone-waiting">
          {whyOf(task)}
        </span>
      )}
```

with, above the component:

```tsx
/** The one-line reason a task is not moving, or null when it is (M45 R4). */
function whyOf(task: TaskBoardItem): string | null {
  if (task.status === 'blocked') return task.lastRejectionReason ?? 'blocked — a person has to look at this'
  if (task.status === 'rework') return task.lastRejectionReason
  if (task.status === 'waiting') {
    const waiting = task.runs.find((run) => run.waitingFor !== null)?.waitingFor
    return waiting === undefined || waiting === null ? 'waiting for an answer' : `waiting for ${waiting.recipient}`
  }
  if (task.status === 'cancelled') return task.lastRejectionReason
  return null
}
```

The existing `task-cancel-reason` line is REPLACED by this one for the cancelled case — delete it
and update the case in `tasks-components.test.tsx` that asserts `task-cancel-reason` to assert
`task-why`, so there is one "why" line rather than two.

- [ ] **Step 7: Regroup `TaskDetailPanel`**

Nothing is deleted and nothing is fetched differently; the existing sections are wrapped, in this
order, with everything above them left ungrouped:

| Ungrouped (the row's identity) | `task-panel-ref`, the priority chip, the goal-version stamp, the stale badge, the title, `detail-status` (now reading `taskStatusWord(...)` with the raw status in `title`), `awaiting-integration`, the description, and the `task-why` line from Step 6 |
| `run` (`defaultOpen`) | the existing Runs section's status/cost/tool-calls/checkpoint/denied-during-pause lines |
| `messages` | `attempt/maxAttempts`, `branch`, and the rejection/cancel-reason `dl` |
| `context` | the "What this run saw" affordance, `run-context-open`, `run-context`, `run-context-prompt` |
| `verification` | the Artifacts section (`artifact-row`, `artifact-body`, `artifact-truncated`, `artifact-error`) |
| `cost` | the per-run cost figures, moved out of the Runs rows' inline text into their own group; the Runs group keeps a one-line total |
| `worktree` | the `Collect worktree` `DangerConfirm` and its error |
| `events` | nothing today — the task's own event feed is the Activity page, filtered by task; the group holds one `<Link href={`/w/${workspaceId}/activity?tasks=${task.id}`}>every event for this task →</Link>` |

The `model`, `profile` and `skills` groups do NOT appear on the task panel: a task has no model, no
profile and no skill — its RUN's worker does, and that is the worker panel. Say so in the panel's
docblock rather than rendering three empty groups.

**Read `apps/web/src/lib/activityFilters.ts` before writing the `events` link** and use the real
query-parameter name for a task filter; if the Activity page keys it differently, use its spelling.

- [ ] **Step 8: Regroup `SlavePanel`**

Same rule — wrap, never rewrite:

| Ungrouped | `status-dot`, `status-label`, `provider-chip`, the three control buttons, `panel-error`, `waiting-for` (with `waiting-question`), `resume-requested`, `resume-halt-reason` |
| `run` (`defaultOpen`) | `run-cost`'s neighbours `run-tool-calls`, `run-paused-step`, `run-waiting-step` |
| `model` | the provider chip's expansion: `providerLabel(slave.provider)` as the word, the raw kind in `title`, and the gate line `ShellOnlyMark` already renders |
| `profile` | `profile-block` entire (`profile-origin`, `profile-input`, `profile-save`) |
| `skills` | `slave.skill` — the card's latest-skill chip, with the honest line "the latest skill this run used; the catalog is on Workforce → Skills" and a link there |
| `messages` | `message-box` entire (`message-input`, `message-save`, `message-hint`) and `runtime-roles-block` |
| `cost` | `run-cost` |
| `events` | the live feed (`feed-event`) |

`runtime-roles-block` lands under `messages` only if it fits the panel's reading order there;
**open the file and decide**, and if it reads better as its own ungrouped block above the groups
(it is a control, not a detail), leave it ungrouped and say so in the commit. What is NOT negotiable:
every raw value — the provider kind, the profile's `sha256` origin, the runtime-role members —
stays inside a group or inside a `title`, never as a bare word in the header.

- [ ] **Step 9: Run the component tests**

Run: `npx vitest run --project unit apps/web/test/tasks-components.test.tsx apps/web/test/slave-panel.test.tsx apps/web/test/useTasks.test.tsx`
Expected: PASS. Where an existing case asserted a raw status word or a section that is now inside a
group, update the case to open the group first — do not weaken the assertion.

- [ ] **Step 10: Adopt `PageShell flush` on the remaining project pages (E25/E18)**

For each of `/w/:id/tasks`, `/w/:id/activity`, `/w/:id/settings`, `/w/:id/graph`, `/w/:id/office`:
find the element that owns the page frame (usually the client's outermost `<div className="flex
flex-1 flex-col …">`) and replace it with `<PageShell flush>…</PageShell>`, moving any `className`
that is not padding or gap onto an inner wrapper. **Change no padding, no gap and no width.** Add
one case per page to that page's existing test file:

```tsx
it('M44 E25 / M45 R5: renders inside the one page shell', () => {
  render(<TasksClient workspaceId="w1" initial={SNAPSHOT} />)
  expect(screen.getByTestId('page-shell')).toBeTruthy()
})
```

- [ ] **Step 11: Adopt it on the four global pages (R5)**

Same treatment for `/` (`ProjectsClient`), `/sim` (`SimulationsClient`), `/settings` (the global
settings client) and `/analytics` (`AnalyticsClient`). These four may use `PageShell` WITHOUT
`flush` — they have no handoff gutters to preserve — **except** where `gate:m14-fidelity` measures
something on them: `/analytics` carries `kpi-tile` and `/` carries `project-card`, neither of which
is a measured NUMBER in `NUMBERS`, so both are safe. Use `flush` on any page whose test asserts a
padding class today; check with `grep -n "p-3\|px-\[" ` on each client before choosing.

`title` and `tabs` slots: pass the page's existing heading through `PageShell`'s `title` prop and
delete the hand-rolled heading, so the four pages get the same title row Workforce has. If a page's
heading carries a `data-testid` a test asserts, keep the testid by passing the heading element as
`title`'s content rather than a bare string.

- [ ] **Step 12: Full task verification**

```bash
npx vitest run --project unit apps/web
npx vitest run --project integration apps/web/test/integration
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
pgrep -af "next dev"     # must be empty
npm run web:build
CHROMIUM_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())") \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m44-ux-foundation
```
Expected: every one green. The m44 gate is the browser check again, and this time its stage 3 is
the one that matters: `page-shell` now exists on twelve pages rather than one, and its stage 4
scan proves that folding raw values into groups did not accidentally surface one as visible text on
a closed panel.

- [ ] **Step 13: Commit**

```bash
git add apps/web/src apps/web/test
git commit -m "$(cat <<'EOF'
feat(web): m45 t4 -- simple rows, and everything raw folded under Details

A task row now says the domain's word (M44 kept the board's column vocabulary and said M45 would
change it), who has it, and ONE line about why it is not moving -- the blocked reason, who it is
waiting on, or what came back from review. The tone still comes from the board's column state with
its four documented exceptions: that decides the colour, not the sentence. The raw status is still
on `data-status`, where it has always been.

Expanded, both panels are the same content under the same ten group names, and a group renders its
children only while open. That is not a nicety: three of these groups fetch on mount -- the run
context, the artifacts, the live feed -- and ten collapsed groups that all rendered would have
issued every one of those requests to show a person nothing. The task panel has no model, profile
or skills group, because a task has none of those; its run's worker does, and that is the worker
panel.

`PageShell` reaches the twelve pages M44's erratum E25 left out, `flush` on the five project pages
so not a pixel moves.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 5: `gate:m45-project-experience`, the fidelity gate's one repoint, the README, CI — and the full verification ladder

**Files:**
- Create: `scripts/gate-m45-project-experience.mjs`
- Modify: `scripts/gate-m14-fidelity.mjs` (E15: the `NUMBERS` `prepare` hook), `package.json`, `.github/workflows/ci.yml`, `README.md`
- Regenerate (own commit): `docs/superpowers/fidelity/m14/*.png` — the eleven, with `overview.png` and `tasks.png` showing the new design

**Interfaces:**
- Consumes from Tasks 1–4: the CLI verb `request-change`; `GoalVersion.request`; `workspace.goal_set.payload.request`; every `data-testid` the three UI tasks produced (`brief`, `brief-tile` + `data-brief`, `brief-supervisor-state`, `needs-you-row`, `supervisor-request*`, `timeline`, `timeline-decisions`, `timeline-entry` + `data-lane`/`data-event-type`, `timeline-lane-filter-*`, `timeline-unblock`, `timeline-answer-*`, `team`, `overview-advanced`, `details-group` + `data-group`, `task-why`, `task-status-word`, `page-shell`) and the untouched `strip`, `slave-card`, `live-events`.
- Produces: the npm script name `gate:m45-project-experience`.

- [ ] **Step 1: Teach the fidelity gate to open the disclosure before measuring the river (E15)**

In `scripts/gate-m14-fidelity.mjs`, `NUMBERS`' rows gain an optional sixth element — a function run
after navigation and before the measurement — and the `live-events` row uses it:

```js
    // M45 R1 moved the live-events river under the Overview's own `Advanced` disclosure: it is not
    // one of the eight facts a person needs in ten seconds. The panel itself did not change -- same
    // component, same `w-[340px]`, same testid -- so the README's 340px number is still real and is
    // still measured here. What changed is that it has to be OPENED first: `getComputedStyle` on a
    // subtree that is not rendered returns `auto`, so a gate that did not click would read nothing
    // and a gate that dropped the row would leave a documented number with nothing measuring it.
    ['overview', `/w/${workspaceId}`, '[data-testid="live-events"]', 'width', '340px', openOverviewAdvanced],
```

with, beside the other browser helpers:

```js
  /** Opens the Overview's `Advanced` disclosure and waits for the river to be laid out. */
  const openOverviewAdvanced = async () => {
    await clickUntil(
      page.getByTestId('overview-advanced'),
      async () => page.getByTestId('live-events').first().isVisible(),
      "the Overview's Advanced disclosure",
    )
  }
```

and in the loop, after the hydration wait and the graph-drawer special case:

```js
    if (typeof prepare === 'function') await prepare()
```

Every other `NUMBERS` row is untouched, and **no expected value changes anywhere in this file**.
Add a line to the file's header comment saying the one row that now prepares, and why.

- [ ] **Step 2: Write `scripts/gate-m45-project-experience.mjs`**

Borrow the boot skeleton from `scripts/gate-m44-ux-foundation.mjs` verbatim — `findFreePort()`,
`spawn`ing `next dev apps/web -p <port> -H 127.0.0.1` under `loopbackChildEnv()`, the ready-wait
that parses the bound port out of next's own ready line, the child killed in `finally`, dist
imports only, one top-level `try` with no `catch`, `let exitCode = 1` set to `0` only by falling off
the end of the try, and `process.exit(exitCode)` as the literal last line. Borrow
`waitVisible`/`waitUntil`/`clickUntil`/`gotoReliably`/`fail()`'s console dump from
`scripts/gate-m14-fidelity.mjs`, and its **preflight refusal**.

Header:

```js
// M45's own gate (spec R7): "open a project and understand it in ten seconds, then talk to ONE
// Supervisor".
//
// `gate-m44-ux-foundation.mjs`'s shape -- a free port, a real `next dev`, a real Chromium through
// `playwright-core` at CHROMIUM_PATH, no daemon -- plus a fixed scenario written with control verbs
// and prisma before the browser opens.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m45-project-experience
//
// THIS GATE SPENDS NOTHING AND CANNOT. It dispatches no run, so no CLI is ever invoked -- and the
// preflight still REFUSES to start unless SLAVEOFAI_CLAUDE_BIN points at an executable under
// `scripts/gate-fakes/` and SLAVEOFAI_REQUIRE_FAKE_CLI=1, so a later stage that grows a run cannot
// quietly reach a real account.
//
// IT WRITES ITS OWN SCENARIO, and that is the point (m44's erratum E10, again): the seeded
// database has no SupervisorDecision, no pending question, no un-integrated `done` task and no
// spend, so "the needs-you list has exactly four entries" would pass against an empty page. Every
// row it writes is deleted in the `finally`, in FK order, and `git status` after a green run has to
// be empty.
//
// The eight stages of R7:
//   1. The eight facts render inside the first viewport at 1440x900, with the expected words.
//   2. The timeline shows the six lanes with the seeded entries in the RIGHT lanes, and no run.*
//      chatter anywhere on the page.
//   3. The needs-you list has exactly four entries, and every link resolves.
//   4. Approving the seeded proposal FROM THE TIMELINE cancels the task and the lane updates.
//   5. "Tell the Supervisor" creates goal v3 with the words stored, and `replan-status` says
//      willReplan true.
//   6. A task row discloses its raw values only inside `Details` groups.
//   7. `data-simulation` never appears on the project page.
//   8. Every raw event type stays out of the visible words and inside `data-event-type`/`title`.
//
// THE GATE ASSERTS, IT NEVER FIXES. Every stage prints every measured value before asserting it.
```

Body, in order. Each numbered item is one stage; each prints before it asserts.

1. **Preflight and the scenario.** Copy m44's `SLAVEOFAI_CLAUDE_BIN` check (`accessSync(bin,
   constants.X_OK)` plus a `startsWith(join(repoRoot, 'scripts/gate-fakes'))` guard) and its
   `SLAVEOFAI_REQUIRE_FAKE_CLI` assertion; `preflightCleanup()` deletes anything a previous run
   left by name prefix. Then, `WORKSPACE_NAME = 'M45 Gate Project <hh:mm:ss>'`, and:
   - `createWorkspace`-equivalent rows by prisma: one `Workspace` (`autoMerge: false`,
     `budgetUsd: 25`, `supervisorEnabled: true`), one `Team`, two `Slave`s (`Ada`/`developer`,
     `Bo`/`reviewer`, both with `runtimeRoles`).
   - **goal v1 and v2 through the CLI**, so the gate drives the real verbs and not a fixture:
     `node apps/orchestrator/dist/cli.js set-goal --workspace <id> --goal "Ship the checkout flow."`
     then `… request-change --workspace <id> --request "Add Apple Pay"`. Assert the second printed
     `{"version":2,…}` and that `GoalVersion` v2's `request` column reads `Add Apple Pay`.
   - **seven tasks, one per state**: `ready`, `running`, `verifying`, `reviewing`, `waiting`,
     `blocked` (with `lastRejectionReason`), `done` (`integratedAt: null` — the un-integrated one),
     plus an eighth `done` with `integratedAt` set (the integrated one). Print each id and status.
   - one pending `SupervisorDecision`: `situationKind: 'stale_task'`, `subjectId: <the ready
     task's id>`, `action: { kind: 'cancel_task', taskId: <that id>, reason: 'the goal moved' }`,
     `tier: 'proposed'`, `status: 'pending'`, `decidedBy: 'model'`, `modelCalled: false`.
   - one question to nobody: a `SlaveMessage` `kind: 'question'`, `expectsReply: true`,
     `recipientRole: 'nobody-holds-this'`, no answer.
   - one failed `SlaveRun` with `provider` set, `status: 'failed'` and `costUsd: null` — the
     unmeasured-call case the cost tile has to name, plus one `succeeded` run with `costUsd: 3.5`.
   - the events the timeline reads: `workspace.replan_started`, `workspace.replanned` (with the
     running task in `added`), `task.created`, `task.started`, `task.verify_passed`,
     `task.review_approved`, `task.integrated`, and **one `run.tool_call`** whose summary is a
     distinctive literal (`GATE-CHATTER-MUST-NOT-APPEAR`) so stage 2's negative is not vacuous.
   Print every id.
2. **Stage 1 — the eight facts, in the first viewport.** At `1440×900`, `gotoReliably(`${baseUrl}/w/${id}`)`,
   `waitVisible(page.getByTestId('brief'))`. Read every `brief-tile`'s `data-brief` in DOM order and
   assert exactly
   `['objective','supervisor','work','cost','needs-you','latest-verified','team','recent-changes']`.
   For each tile, read `getBoundingClientRect().bottom` and assert it is `<= 900` — the ten-second
   claim is a claim about ONE SCREEN, and a fact below the fold is a fact nobody read. Print each
   tile's bottom. Then assert the words: the objective tile contains `Ship the checkout flow` and
   `v2`; `brief-supervisor-state` reads `1 DECISION WAITING` with `title="decisions"`; the work
   tile contains `WORKING` and `IN REVIEW`; the cost tile contains `$25` and
   `unmeasured calls charged at $1.00 each`; the latest-verified tile names the integrated task and
   the word `integrated`; the team tile names `Ada` and `Bo`; recent-changes has at least one row
   and none of its text contains a `.`-dotted event type.
3. **Stage 2 — six lanes, right entries, no chatter.** Read every `timeline-entry`'s `data-lane`
   and `data-event-type`. Assert: `workspace.goal_set` is on `user_request`; `workspace.replanned`
   on `interpretation`; `task.created` on `plan_change`; `task.started` on `work`;
   `task.integrated` on `verified`; the seeded decision's row is inside `timeline-decisions` and is
   the FIRST thing in the timeline section (`compareDocumentPosition`). Assert no entry has
   `data-event-type` beginning `run.`, and that the whole page's visible text does not contain
   `GATE-CHATTER-MUST-NOT-APPEAR`. Then click `timeline-lane-filter-verified` and assert every
   remaining entry's `data-lane` is `verified`; click it again and assert the count returns.
4. **Stage 3 — exactly four things need a person, and every link works.** Read `needs-you-row`s;
   assert there are exactly four and that their kinds cover blocked / decision / question /
   integrate (read from each row's chip text). For each row's `<a href>`, `gotoReliably` it and
   assert the destination renders (`page-shell` present and the response was not a 404 body), then
   come back. Print each href and what it landed on.
5. **Stage 4 — approving from the timeline really cancels the task.** Back on `/w/<id>`, click the
   `supervisor-approve` inside `timeline-decisions`. `waitUntil` prisma reports the subject task's
   `status === 'cancelled'` (30 s). Then `waitUntil` the page shows no `timeline-decisions` section
   at all — the lane emptied because the decision resolved, through the stream, with no reload.
   Print the task's status before and after and the decision's `status`/`resolvedAt`.
6. **Stage 5 — telling the Supervisor makes a version and arms a re-plan.** Type
   `Also support Google Pay` into `supervisor-request-input`, click `supervisor-request-send`, and
   `waitVisible(page.getByTestId('supervisor-request-result'))` containing `v3`. Then in prisma:
   `GoalVersion` v3 exists, its `request` column reads `Also support Google Pay`, and its `text`
   contains BOTH `Ship the checkout flow.` and `Also support Google Pay` — the amendment kept the
   body. Then run `node apps/orchestrator/dist/cli.js replan-status --workspace <id>`, parse its
   JSON and assert `goalVersion === 3` and `willReplan === true`. **No daemon is started**: the
   gate asserts the verdict the tick WOULD reach, which is what `replan-status` is for.
7. **Stage 6 — the raw values are inside the groups.** Go to `/w/<id>/tasks`, click the blocked
   task's card, wait for the detail panel. Assert `task-status-word` reads `BLOCKED` and
   `task-why` carries the seeded rejection reason. Assert every `details-group` is closed
   (`data-open="false"`) except `run`, and that the panel's visible text contains none of: the
   task's UUID, the branch name, the worktree path. Then open the `worktree` group and assert the
   path IS visible — the negative before is about folding, not about hiding. Print each group's
   name and open state.
8. **Stage 7 — real is not simulated.** On `/w/<id>`, assert
   `document.querySelectorAll('[data-simulation]').length === 0`. Print the count.
9. **Stage 8 — no dotted event type is visible text.** Collect the page's visible text with m44's
   `TreeWalker` snippet (copy it verbatim, including its `nextjs-portal, script, style,
   [aria-hidden="true"], .sr-only` exclusion) and assert no string matches
   `/^(task|run|slave|workspace|org|supervisor|guardrail)\.[a-z_]+$/u`. Then assert the POSITIVE
   counterpart, so the negative is not vacuous: at least one `timeline-entry` carries a
   `data-event-type` that DOES match that shape. Print both.
10. **`finally`.** Kill `next dev`, close the browser, delete the fixture rows in FK order
    (`ExecutionEvent`, `SupervisorDecision`, `SlaveMessage`, `SlaveRun`, `GoalVersion`, `Task`,
    `Slave`, `Team`, `Workspace`), then `console.log('PASS: eight facts in one screen, six lanes,
    four things needing a person, and one Supervisor to tell')` and `exitCode = 0` at the end of
    the try, never earlier.

Import `prisma` from `../packages/db/dist/client.js` and `TIMELINE_LANES`/`LANE_LABEL` from
`../packages/domain/dist/index.js` so the lane names the gate checks are the domain's own, not a
list typed twice. The CLI is invoked as `node apps/orchestrator/dist/cli.js …` under
`buildChildEnv()`, exactly as `gate-m40-requirement-versioning.mjs` drives `set-goal` and
`replan-status` — **read that file's helper for running the CLI and reuse it** rather than writing
a second `spawnSync` idiom.

- [ ] **Step 3: Add the npm script**

In `package.json`, after the `gate:m44-ux-foundation` line (the comma moves onto it):

```json
    "gate:m44-ux-foundation": "tsc --build && node --env-file=.env scripts/gate-m44-ux-foundation.mjs",
    "gate:m45-project-experience": "tsc --build && node --env-file=.env scripts/gate-m45-project-experience.mjs"
```

- [ ] **Step 4: Add it to CI**

In `.github/workflows/ci.yml`, immediately after `- run: npm run gate:m44-ux-foundation`:

```yaml
      - run: npm run gate:m45-project-experience
```

The `gates` job already installs Chromium, exports `CHROMIUM_PATH`, and sets
`SLAVEOFAI_CLAUDE_BIN` and `SLAVEOFAI_REQUIRE_FAKE_CLI` job-wide, so the preflight is satisfied
with no new step. `gate:m14-fidelity` stays out of CI — it rewrites committed PNGs.

- [ ] **Step 5: Run the new gate until it is green**

```bash
pgrep -af "next dev"     # must be empty
CHROMIUM_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())") \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m45-project-experience
git status --short
```
Expected: `PASS:` and exit 0, and a **clean** `git status`. Paste the gate's full output into the
task report — the eight stages' printed values are this milestone's evidence, and stage 1's tile
bottoms are the literal measurement of the "ten seconds, one screen" claim.

- [ ] **Step 6: Update the README's UI table and add `## One Supervisor`**

In `README.md`, replace the `**Overview** /w/<id>` row of "The web UI" table with:

```markdown
| **Overview** `/w/<id>` | The project in one screen: what it is for and at which version, what the Supervisor is doing, what is being worked on, what it has cost, what needs you, the latest verified result, who is on the team and what changed lately — above a timeline of the project's own history in six lanes, where the things waiting on you can be answered in place. One box tells the Supervisor what changed. `Advanced ▾` on the page holds the live event river, the blocked list, the merge queue and the Supervisor's own panel. |
```

and the `**Tasks**` row with:

```markdown
| **Tasks** `/w/<id>/tasks` | The board by status. Each card says its state in one word, who has it, and one line about why it is not moving. Click one for the rest, grouped under `Details ▾`: the run, its messages, what it saw, its verification attempts, its cost, its worktree and its events. |
```

Then add a new section immediately after `## The Supervisor`:

```markdown
## One Supervisor

You do not manage the workers. You talk to the project's Supervisor, and the project page is that
conversation.

The top of the page is a brief: what this project is for and at which version of that requirement,
what the Supervisor is doing right now in one word, how much work is in flight and in what state,
what it has cost against its budget, what is waiting on you, the last thing anybody verified, who
is on the team, and what changed lately. Eight facts, one screen — `gate:m45-project-experience`
measures that literally, by asserting every tile's bottom edge is above the fold at 1440×900.

Under it is the project's own history, in six lanes:

| Lane | What is in it |
|---|---|
| **USER REQUEST** | What you asked for — a goal you set, a change you requested, a task you cancelled |
| **SUPERVISOR INTERPRETATION** | What it understood: the delta a re-plan produced, in its own words — "understood v3: +Add Apple Pay; proposes cancelling the gift-card page; 4 kept" |
| **PLAN CHANGE** | What actually changed on the board |
| **WORK IN PROGRESS** | What workers are doing, one line per task |
| **DECISION REQUIRED** | What is waiting on you — pinned above everything else, and answerable here |
| **VERIFIED RESULT** | What passed, was approved, or landed in the base branch |

What a model said while it worked is not on this timeline. That is the event river, one click away
under `Advanced ▾`, and the Activity tab keeps all of it.

**Telling it what changed.** One box, one sentence: *"Also support Google Pay."* That writes a new
version of the project's requirement — the goal document keeps its body and gains a dated line
saying what you asked — and the next tick re-plans that version as a delta. What the re-plan adds
becomes tasks; what it wants to cancel becomes a proposal you approve or refuse, in the DECISION
REQUIRED lane. Your words are kept beside the version, so the timeline shows what you asked and not
only what it produced.

```bash
npm run orchestrator -- request-change --workspace <id> --request "Also support Google Pay"
npm run orchestrator -- replan-status --workspace <id>      # why the next tick will, or will not, re-plan
```

Nothing here is new authority. Every button on that timeline is a verb that already existed — the
Supervisor's approve and reject, the answer that unsticks a waiting worker, the unblock that sends a
parked task back for another attempt. The Supervisor still proposes and you still decide.
```

- [ ] **Step 7: Update the "Tests and CI" roster (19 → 20)**

Replace

```
`gate:m42-catalog-import` and `gate:m44-ux-foundation` on every push
```

with

```
`gate:m42-catalog-import`, `gate:m44-ux-foundation` and `gate:m45-project-experience` on every push
```

and replace the sentence ending `That is 19 gates.` with the m44 sentence followed by:

```
and `m45` opens a fixed project in a real browser and checks that you can understand it in one
screen: the eight facts render above the fold with the words they promise, the six lanes carry the
seeded entries in the right lanes with no model chatter among them, exactly four things need a
person and every one of their links resolves, approving a proposal from the timeline really cancels
the task, one sentence typed into the box really becomes goal v3 with your words stored and a
re-plan armed, and a task's raw values are reachable only inside its `Details` groups. That is 20
gates. Tests and gates share one Postgres — run one at a time.
```

- [ ] **Step 8: Full verification ladder**

Run these **in this order**, one at a time, with no `next dev` running anywhere and no other vitest
process alive (the shared test database truncates, and a running daemon breaks `subscribe.test.ts`):

```bash
npm run --silent typecheck
npm run gate:m26-vocabulary
npx vitest run
npm run web:build
npm run gate:m45-project-experience
npm run gate:m44-ux-foundation
npm run gate:m14-fidelity
npm run gate:m16-chrome
npm run gate:m42-catalog-import
npm run gate:m41-scenario
npm run gate:m40-requirement-versioning
npm run gate:m39-supervisor-mailbox
npm run gate:m38-supervisor
npm run gate:m37-run-context
npm run gate:m36-messaging
npm run gate:m35-pipeline-honesty
npm run gate:m33-adopt
npm run gate:m11-shell
```

with `CHROMIUM_PATH` and `SLAVEOFAI_CLAUDE_BIN` exported for the four browser gates (m45, m44, m14,
m16). Expected: every one green.

Three of these are on this ladder for a reason and a failure in them is a real regression:

- **`gate:m40-requirement-versioning`** — Task 1 refactored `setGoal` onto a shared writer. m40
  pins `GoalVersion` rows, the `workspace.goal_set` payload shape and the `goal_unchanged` refusal,
  and is the only thing that proves the refactor kept all three.
- **`gate:m11-shell`** — it touches the Overview for `project-header` and `budget`, both rendered by
  the project LAYOUT rather than by `OverviewClient` (plan erratum E13). Nothing was repointed, and
  this run is the proof; if it fails, the layout moved and that is news.
- **`gate:m16-chrome`** — it reads computed styles off `/`, `/analytics` and `/w/<seed>/settings`,
  all three of which Task 4 wrapped in `PageShell`. A failure there means the wrap was not
  pixel-neutral after all, which is a bug in Task 4 and not a flake.

Known flakes, and what to do about them rather than around them:
`apps/orchestrator/test/integration/cli.test.ts`'s llm-decision row-count case doubles when
anything else touches the database — re-run that file alone before believing a failure. `web:build`
must never run while `next dev` is up; if the dev server was running, stop it (`kill <pid>`), say so
in the report, `rm -rf apps/web/.next`, and restart it afterwards. The four browser gates each boot
their own `next dev` against `apps/web/.next` — run them one at a time, never beside each other and
never beside a dev server.

- [ ] **Step 9: Regenerate the fidelity screenshots — its own commit**

```bash
pgrep -af "next dev"     # must be empty
CHROMIUM_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())") \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
npm run gate:m14-fidelity
git status --short docs/superpowers/fidelity/m14
```
Expected: `PASS`, and eleven PNGs written — `overview.png` and `tasks.png` showing the new design,
the other nine unchanged in shape (`office.png` differs on every run: the canvas animates). Commit
the set ALONE, so a reviewer can see the design change as a diff of images and nothing else:

```bash
git add docs/superpowers/fidelity/m14
git commit -m "$(cat <<'EOF'
chore(fidelity): m45 -- regenerate the m14 screenshots for the project view

Deliberate, and alone in its own commit so the design change is reviewable as a diff of images.
overview.png is the milestone: eight fact tiles, the strip under them, the box that tells the
Supervisor what changed, and the six-lane timeline with DECISION REQUIRED pinned. tasks.png shows
the simple row -- one word, who has it, one line about why it is not moving. The other nine pages
are unchanged in shape; office.png differs on every regeneration because its canvas animates.

Every README pixel value the gate asserts is unchanged. One row of that gate now opens the
Overview's Advanced disclosure before measuring the 340px live-events panel -- the panel did not
change, its place on the page did, and a subtree that is not rendered computes to `auto`.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

- [ ] **Step 10: Prove the tree is clean, then commit the rest**

```bash
git status --short
```
Expected: only the files this task changed, and nothing from the gate's own run.

```bash
git add scripts/gate-m45-project-experience.mjs scripts/gate-m14-fidelity.mjs package.json \
        .github/workflows/ci.yml README.md
git commit -m "$(cat <<'EOF'
test(gates),docs: m45 t5 -- gate:m45-project-experience, and the README's One Supervisor

Eight stages in a real browser against a real next dev, over a scenario the gate writes itself with
control verbs and prisma: goal v2 made through `request-change` (the real CLI, not a fixture row),
seven tasks in seven states, an integrated one and an un-integrated one on a hand-merge project, a
pending stale_task proposal, a question nobody holds, a failed run with no measured cost, and one
run.tool_call carrying a literal that must never reach the page.

Stage 1 measures the milestone's actual claim rather than paraphrasing it: every fact tile's bottom
edge has to be above the fold at 1440x900, because "ten seconds" is a claim about one screen. Stage
4 approves the proposal FROM THE TIMELINE and waits for prisma to report the task cancelled and the
lane to empty over the stream, with no reload. Stage 5 types a sentence into the box and then asks
`replan-status` whether the next tick would re-plan it -- the verdict the tick would reach, with no
daemon started and no run dispatched. Stage 6 opens a task's Details groups to prove the raw values
are folded rather than hidden: absent while closed, present once opened.

It spends nothing and cannot: no run is dispatched, and the preflight still refuses to start unless
SLAVEOFAI_CLAUDE_BIN names a fake under scripts/gate-fakes. Every row it writes is deleted in a
finally, in FK order.

gate:m14-fidelity keeps every expected value it had. One row now opens the Overview's Advanced
disclosure first, because that is where the live-events river went -- the panel is the same
component at the same 340px, and dropping the assertion would have left a documented number with
nothing measuring it.

The README gains `## One Supervisor`: the brief, the six lanes and what telling it something
actually does -- a goal version and a delta re-plan, and no authority anybody did not already have.
That is 20 gates.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

## Self-review

**1. Spec coverage.**

- **R1 — the brief is a projection.** Task 2 builds `buildProjectBrief` with all eight fields
  (erratum E1) off reads that already existed, `buildNeedsYou` through the domain's `needsYou`
  plus the decision rows (E20), `latestVerified` as the three-event preference chain, `cost` as the
  one guardrail formula's total plus its two halves (E2), `recentChanges` through
  `readableEventType` over the change families (E25). `userSupervisorStatus` is Task 1, as a fact
  bag (E3). Task 3 renders them as eight tiles; gate stage 1 asserts the words AND that every tile
  is above the fold.
- **R2 — six lanes, deterministically.** Task 1's `laneFor` over an exhaustive `Record` (E5), split
  on `actor` for the two ambiguous types (E4), with `run.*` chatter mapped to `null`. Task 2's
  `buildSupervisorTimeline` merges events and pending decisions in one query with a type filter
  derived from that same table. Task 3 pins DECISION REQUIRED above the river, renders the existing
  `ProposalRow`/`DraftEditor` (E12), and answers in place through the M38/M39 approve/reject routes,
  M36's answer route and the new unblock route (E10); the `integrate` kind links instead (E11).
  `slave.message_sent` collapses per task with "+N earlier". Gate stages 2, 3, 4 and 8.
- **R3 — the request writes a goal version with the words kept.** Task 1: `composeGoal` (pure,
  byte-stable, E7), `requestChange` composing inside `setGoal`'s lock (E6), `GoalVersion.request`
  as one additive migration with the Prisma 7 diff proof, `workspace.goal_set.payload.request?`
  (E24), the `invalid_request` refusal (E8), and the CLI verb without `--by` (E9). Task 2 adds the
  route; Task 3 the input. Gate stage 5 drives it end to end and then asks `replan-status`.
- **R4 — progressive disclosure.** Task 4: the task row's projected word, its one-line why, and
  `TaskDetailPanel`/`SlavePanel` regrouped under the ten `Details ▾` names with children rendered
  only while open. `Advanced ▾` keeps Graph, Office and Analytics (the project tab strip's menu,
  unchanged from M44 plus the fix wave's Analytics entry). Gate stage 6.
- **R5 — `PageShell` for `/w/:id/*` and the four global pages.** Task 3 for the Overview, Task 4 for
  the other five project pages and the four global ones, via the new `flush` prop so nothing moves
  (E18). Office stays exactly as it is inside the shell. Asserted by `gate:m44-ux-foundation`'s
  stage 3 on every task that touches a page.
- **R6 — real vs simulation.** Nothing from `/sim` is read by any builder in Task 2 — the three
  queries are all `workspaceId`-scoped — and `adoptedFrom` stays the `Alert` it already was in
  `OverviewClient` (Task 3 Step 12 keeps it verbatim). Gate stage 7 asserts `data-simulation` never
  appears on the project page.
- **R7 — the gate.** Task 5, all eight assertions R7 names, plus CI, the README roster (19 → 20),
  the `## One Supervisor` section, and the screenshot regeneration in its own commit. m11-shell is
  re-run rather than repointed, with the reason (E13); the m14 page set gains nothing (Overview and
  Tasks were already in it) and one row gains a `prepare` hook (E15).
- **§1's closing bullet** (never a real model call; one vitest at a time; `web:build` last and never
  beside `next dev`; vocabulary; no removal; a refusal after a write in a transaction throws) →
  Global Constraints, with the `pgrep -af "next dev"` check a literal step in Tasks 2, 3, 4 and 5.
- **§3's out-of-scope list is respected.** No task adds a staffing request, a memory store, a
  three-tier cost split, an external-origin label, a stored model-written interpretation sentence,
  an Office redesign or a Cursor-specific surface. The cost tile says exactly what today's backend
  knows and names the unmeasured half as an estimate at its cap.

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "write tests for the
above", no "similar to Task N". Eight steps deliberately say "read the file first and follow what it
actually supports", each naming the file, the reason and what to do with what is found: Task 1
Step 15 and Step 20 (the neighbouring tests' own seed and run helpers), Task 2 Step 3 and Step 11
(`SupervisorQuestionView`'s and `sumSpend`'s real field names), Task 2 Step 15 (the `../` depth
against a sibling route), Task 3 Step 9 (whether `postControl` can return a body), Task 4 Step 7
(the Activity page's task-filter query key) and Task 4 Step 8 (where `runtime-roles-block` reads
best). Task 5's gate is a numbered specification rather than 700 lines of JavaScript, for the reason
the M41, M42 and M44 plans recorded for the same helpers: it names the file each helper is borrowed
from, the exact fixture rows, the exact assertions per stage and the exact teardown order, and
retyping `waitVisible` / `gotoReliably` / `fail` here would risk a silent divergence from the
failure-report shape every other gate in this repository shares.

**3. Type consistency.** `UserSupervisorFacts`' six fields (`halted`, `enabled`, `pendingDecisions`,
`pendingQuestions`, `tasksActive`, `tasksOpen`) are spelled identically in Task 1's interface, its
implementation, its tests and Task 2's `buildProjectBrief`. `UserStatus<S>`'s three fields stay
`state`/`label`/`needsYou` everywhere, including the new `UserSupervisorState`. `TimelineLane`'s six
members (`user_request`, `interpretation`, `plan_change`, `work`, `decision`, `verified`) are the
same six in `TIMELINE_LANES`, `LANE_LABEL`, `LANE_BY_TYPE`, `laneFor`, `TimelineEntry.lane`, the
component's filter testids and the gate's assertions. `TimelineSubject`'s two arms use `source:
'event' | 'decision'` in the domain, in `buildSupervisorTimeline` and in the tests. `TimelineEntry`'s
eleven fields (`key`, `lane`, `laneLabel`, `at`, `title`, `detail`, `taskId`, `taskTitle`,
`eventType`, `decision`, `collapsedCount`) are identical in Task 2's interface, its tests, Task 3's
component and its fixtures. `NeedsYouItem`'s eight fields (`kind`, `id`, `title`, `href`, `since`,
`taskId`, `decisionId`, `messageId`) and its four `kind` members (`blocked_task`, `decision`,
`question`, `integrate`) are spelled the same in Task 2, Task 3's tests and the gate. `ProjectBrief`'s
eight members and `cost`'s four fields (`spentUsd`, `measuredUsd`, `unmeasuredCalls`, `budgetUsd`)
match between the builder, the component, the component's fixture and the gate. `composeGoal`'s
signature is `(previous: string | null, request: string, at: Date) => string` in the domain, in its
test and at `requestChange`'s call site. `requestChange` returns `{ version, sha256, goal }` in the
control verb, the CLI, the route and the gate. `DetailsGroupName`'s ten members are the same ten in
the primitive, both panels and the gate's `data-group` assertions. `PageShell`'s `flush` is a
`boolean` in the primitive, its test and all twelve adopting pages.
