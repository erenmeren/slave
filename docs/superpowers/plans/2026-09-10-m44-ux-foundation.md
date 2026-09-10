# M44 UX Foundation A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify the application a normal user meets — four top-level entries instead of six, four project tabs plus an Advanced menu, one page shell and one primitive set, one user-facing status vocabulary projected from the domain, and the accessibility and responsive basics — without removing a single capability.

**Architecture:** One pure domain module owns the words (`packages/domain/src/status/user.ts`, no React, no Prisma); `apps/web/src/components/ui` grows the primitives every page will use (`PageShell`, one `Button`, `Tabs`, `Dialog`, `Drawer`, `Alert`, `EmptyState`, `LoadingState`) and `app/globals.css` grows a token for every colour and radius that is currently a literal; the navigation is rebuilt around a new `/workforce` route that MOVES existing panels rather than rewriting them; and the six surfaces that render raw enum values are projected through the domain with the raw value kept in `title`. `docs/ia.md` records every surface and where anything that left a main path now lives; `scripts/gate-m44-ux-foundation.mjs` proves the whole claim in a real browser.

**Tech Stack:** TypeScript monorepo, Next.js 15 App Router + React 19, Tailwind v4 (configured by `@theme inline` inside `apps/web/src/app/globals.css` — there is no `tailwind.config.*`), vitest (two projects: `unit`, `integration`), Prisma 7 + Postgres (:5433), plain-`node` `.mjs` gates driving `playwright-core`.

**Spec:** `docs/superpowers/specs/2026-09-10-m44-ux-foundation-design.md` (rulings R1–R8; §4 errata). Its parent is `docs/superpowers/specs/2026-09-10-roadmap-m44-m56.md` — M45 builds the Supervisor-centred project view on this foundation and **must not be pre-built here**.

Plan-time errata, every one read out of the code and baked into the tasks below (the long form, with file and line evidence, is in the session notes):

- **E1 — R3's "one card recipe" cannot land in M44.** `ui/Card.tsx` is `rounded-card p-3 bg-bg-2`; `SlaveCard.tsx:139` is `rounded-card px-[13px] py-[12px] bg-bg-2`; `TaskCard.tsx:84` is `rounded-tile p-[10px] bg-[#0f1116]`. Two of SlaveCard's numbers are `gate:m14-fidelity` stage-2 assertions (`border-radius: 8px`, `padding: 12px 13px`) read off `design_handoff_ai_team_os/README.md`, and the Global Constraints freeze those. `Card` gains `className`, `testId` and a `data` bag — additive, for M45 — and **no card DOM is restructured**.
- **E2 — R4's "fold the CardState mapping into the domain" cannot move the tone table.** `CARD_STATE_TONE` maps to `StatusTone`, declared in `apps/web/src/components/ui/StatusPill.tsx`, and `packages/domain` may not import from `apps/web` (it also reaches the web CLIENT bundle — M42 erratum E13). The domain owns state + label (`UserCardState`, `USER_CARD_LABEL`, `userRunStatus`, `userSlaveStatus`); `lib/tones.ts` keeps state → tone/pulse and re-exports `CardState`/`cardStateForRun`/`cardStateForSlave` as adapters that read every label from the domain.
- **E3 — `cardStateFor` and `cardStateForTask` stay in the web.** Both derive through `lib/taskColumns.ts`'s `COLUMN_FOR_STATUS`/`COLUMN_STATE` — the board's column grouping, with four documented exceptions. `userTaskStatus` is a separate, domain-owned vocabulary; R5's "nothing else is re-written" keeps the Tasks board's pill exactly as it is.
- **E4 — R4's `needsYou` is under-specified.** "a decision is pending human approval" is written inside the `waiting` case; a `SupervisorDecision` with `status: 'pending'` needs a human whatever the task's state, so `decisionPending` sets `needsYou` on every non-terminal state. `failed` deliberately does NOT set it (the spec's list is closed, FAILED is already red, and M45's needs-you queue owns that call). Both rules are in the docblock and pinned by a case each.
- **E5 — Activity's rail shows PREFIXES.** `server/activity.ts:84` is `split_part(type::text, '.', 1) || '.*'` — seven possible values (`task.*`, `run.*`, `slave.*`, `guardrail.*`, `workspace.*`, `org.*`, `supervisor.*`), and `apps/web/test/activity-page.test.tsx:515` pins `data-prefix`. The label table is keyed by those seven; `data-prefix` and `title` keep the raw value; only the visible text changes.
- **E6 — R5's "the M38 situation label" does not exist.** `packages/domain/src/supervisor/situations.ts` has `SITUATION_KINDS` and a per-decision `situation.summary`, and no label table anywhere. Task 4 adds `SITUATION_LABEL`, `TIER_LABEL`, `DECISION_STATUS_LABEL` and `DECIDER_LABEL` to the domain beside the unions they name.
- **E7 — there are no Next redirects today.** `apps/web/next.config.ts` has `transpilePackages` and a gate-only `onDemandEntries` block and nothing else. `/slaves` and `/skills` become the first `async redirects()` entries, `permanent: false` (307), and their `page.tsx` files are deleted — a route file wins over a redirect.
- **E8 — `gate:m14-fidelity` reaches `/slaves` by URL** (`scripts/gate-m14-fidelity.mjs:760`, and again for the nine-column grid assertion). Its `PAGES` entry becomes `{ name: 'workforce', path: () => '/workforce', testId: 'data-table' }`; `docs/superpowers/fidelity/m14/slaves.png` is deleted and `workforce.png` added in the screenshot commit.
- **E9 — `docs/ia.md` is inside `gate:m26-vocabulary`'s scope.** The exclude list is `docs/superpowers`, `docs/decisions`, `packages/db/prisma/migrations`, `packages/providers/test/fixtures`, `package-lock.json`, two script files, the PDF and `design_handoff_ai_team_os`. `docs/ia.md` is on none of them: it says **slave**, never the other word, and never quotes the handoff README, which uses it.
- **E10 — R8's "fake CLI, like m14" over-specifies.** The gate dispatches no run; its model is `scripts/gate-m16-chrome.mjs`. It keeps m14's preflight refusal (`SLAVEOFAI_CLAUDE_BIN` must name an executable under `scripts/gate-fakes/`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`) so it can never reach a real account, and it writes its OWN fixture rows: the seeded database has 13 tasks but zero `SlaveRun`, `SupervisorDecision`, `SimulationRun` and missing skills, so R8's negative assertions would pass vacuously against it.
- **E11 — m14 is not in CI, m44 is.** CI's `gates` job already installs Chromium and exports `CHROMIUM_PATH` (`.github/workflows/ci.yml:46-47`), and the README's "18 gates" roster is exactly the CI list. m14 stays out (it rewrites committed PNGs); m44 writes no file and joins after `gate:m42-catalog-import`, roster 18 → 19.
- **E12 — `DangerConfirm` lacks three things `EmergencyStopButton` documents:** focus restore to the trigger after Escape (deferred past the trigger's unmount), `role="alertdialog"` + `aria-label` on the open state, and a `title` prop. Its testids already match (`emergency-stop`, `-confirm`, `-cancel`); `DangerZone`'s `reseed-button` becomes `reseed`, and `apps/web/test/settings-page.test.tsx:1017,1020` change with it.
- **E13 — the alias plan moves 35 buttons unless `Button` gains a size.** `Button` is `px-3 py-1.5`; `FormControls`' buttons are `px-2.5 py-1` (same 5px radius). `size: 'md' | 'sm'` where `sm` IS `px-2.5 py-1`. Counts: 24 `<PrimaryButton>`, 11 `<GhostButton>`, 23 `<Button>`. One deliberate convergence: `primary`/`danger` fills take `StatusPill`'s `TONE_FILL` `/10` and `TONE_BORDER` `/24` (the handoff's `1a`/`3d`), not `FormControls`' drifted `/15` and `/40`.
- **E14 — "one spelling per radius" is four literals:** `rounded-[5px]`×5 → `rounded-chip`, `rounded-[7px]`×1 → `rounded-tile`, `rounded-[2px]`×3 → a new `--radius-hair`, `rounded-[14px]`×1 → a new `--radius-bubble`.
- **E15 — "tokens for every ad-hoc colour" is 15 hex literals and 12 white-alpha literals.** The handoff README names the ramp, so the tokens take its names: `--text-strong #f2f5f9`, `--text-body #c8cfda`, `--text-secondary #a8b0bd`, `--text-dim #7c8697`, `--text-ghost #3f4650`, `--bg-selected #151a21`, `--bg-card-alt #0f1116`, `--bg-canvas #08090c`, `--bg-floor #07080b`, `--line-inner rgba(255,255,255,.05)`, `--line-hover rgba(255,255,255,.20)`.
- **E16 — the skip link has no target.** Nine `<main>` elements exist (three page-level, six "no project with id" fallbacks) and the root layout wraps children in a plain `<div>`. That wrapper becomes `<main id="main" tabIndex={-1}>` and all nine inner ones become `<div>`s, leaving exactly one main landmark.
- **E17 — the Skills leak is a word and an assertion.** `SkillsClient.tsx:113` renders `{skill.state}`; `apps/web/test/skills-page.test.tsx:72` asserts `'missing'`. READY/MISSING become the words, the raw value moves to `title` and a new `data-state`.
- **E18 — the Slaves table's tone and label must share one derivation.** `SlavesClient.tsx`'s `SLAVE_STATUS_TONE`/`toneForStatus` are pinned by `apps/web/test/slaves-page.test.tsx:51-58`. `toneForStatus` becomes `CARD_STATE_TONE[userSlaveStatus(status).state].tone` and `SLAVE_STATUS_TONE` is deleted; every existing assertion stays true.
- **E19 — "needs you count" has no read model.** `ProjectRow` (`apps/web/src/server/org.ts:74`) has `taskCounts { done, total, active, blocked }` and no `autoMerge`, no `integratedAt`. `listProjects` gains `needsYou: number` = blocked + un-integrated `done` on a hand-merge project. Question holders are NOT resolved in M44 (M39's unanswerable case is per-task and belongs to M45's needs-you queue); `docs/ia.md` says so in one line.
- **E20 — the Projects home must not duplicate the KPI builder.** `buildAnalytics(null)` already returns the all-workspaces snapshot, and `data-testid="kpi-tile"` is `gate:m14-fidelity`'s marker for `/analytics`. The strip is extracted verbatim into `components/analytics/KpiStrip.tsx`, keeping both testids, and rendered by both pages.
- **E21 — `Alert` cannot swallow 53 `role="alert"` elements.** It replaces the BAND shape only: the three "showing stale data" bands (`OverviewClient.tsx:230`, `TasksClient.tsx:49`, `graph/GraphClient.tsx:221`) and Overview's "adopted from simulation" banner. `HaltBanner` keeps its own component (four gates key off it); inline per-form refusal text is untouched.
- **E22 — menus are not dialogs.** Of 11 hand-rolled Escape sites, six are modal. `Drawer` takes `projects/NewProjectDrawer`, `slaves/NewSlaveDrawer`, `sim/AdoptDrawer`, `sim/CloneDrawer`, `sim/NewSimulationDrawer`; `Dialog` takes `AssignCompanyDialog`. `ProjectSwitcher` and `graph/NodeMenu` keep their own Escape (and `ProjectSwitcher` is the idiom `Advanced ▾` copies). `SlavePanel`, `GraphDrawer` and `TaskDetailPanel` are persistent side panels, not modals — not migrated, recorded in `docs/ia.md` as deliberate.
- **E23 — the Graph/Office tab testids.** `project-tab-graph`/`project-tab-office` become `advanced-item-graph`/`advanced-item-office`; no gate navigates by clicking a project tab, so nothing else moves.
- **E24 — `SlavePanel`'s status is asserted lowercase** (`apps/web/test/slave-panel.test.tsx:531` expects `'working'`). It becomes `WORKING`, with the raw value in `title` and a new `data-status`.

## Global Constraints

- **Never a real model call.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and the fake CLI `packages/providers/test/fake-claude.mjs`; the fidelity gate and `gate:m44-ux-foundation` use `scripts/gate-fakes/fake-claude.sh` through `SLAVEOFAI_CLAUDE_BIN`.
- One vitest process at a time (the shared test database truncates), and **never a gate beside vitest**.
- **`npm run web:build` never while `next dev` is running.** Before any `web:build`, run `pgrep -af "next dev"`; if one is up, `kill <pid>` it and **say so in the task report**. Restarting dev afterwards needs `rm -rf apps/web/.next` first.
- **No functionality is removed.** Anything that leaves a main path is listed in `docs/ia.md` with its Advanced location.
- **README pixel values are unchanged in this milestone** — `design_handoff_ai_team_os/README.md`'s numbers (212px sidebar, 52px top bar, radius 8, pill 20, 340px live panel, rule at x=88px, 352px drawer, 28×28 tile) and every `gate:m14-fidelity` stage-2 assertion stay exactly as they are.
- The vocabulary word is **slave**. `npm run gate:m26-vocabulary` after every task.
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
  ```
- Every task ends with focused tests, `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck` and a commit. Web tasks also run `npm run web:build` (subject to the `next dev` rule above).
- Anything touching the database goes under `test/integration/` — `vitest.config.ts` has two projects, and only `integration` loads `test-setup/require-database.ts`.
- **The implementer never dispatches subagents.**

---

## File structure

```
packages/domain/src/status/user.ts                    R4: the whole projection, pure (new)
packages/domain/src/status/index.ts                   the barrel (new)
packages/domain/src/index.ts                          + ./status/index.js
packages/domain/src/supervisor/situations.ts          E6: SITUATION_LABEL
packages/domain/src/supervisor/actions.ts             E6: TIER_LABEL, DECISION_STATUS_LABEL, DECIDER_LABEL
packages/domain/test/status/user.test.ts              exhaustive over every enum member (new)
packages/domain/test/supervisor/labels.test.ts        every union has a label (new)

apps/web/src/lib/tones.ts                             E2/E18: re-export from the domain; toneForStatus
apps/web/src/app/globals.css                          E14/E15: the new colour + radius tokens
apps/web/src/components/ui/Button.tsx                 R3/E13: variant primary|ghost|danger, size md|sm
apps/web/src/components/ui/FormControls.tsx           R3: GhostButton/PrimaryButton become aliases
apps/web/src/components/ui/Card.tsx                   E1: className, testId, data bag
apps/web/src/components/ui/PageShell.tsx              R3 (new)
apps/web/src/components/ui/Tabs.tsx                   R3 (new)
apps/web/src/components/ui/useModalDismiss.ts         R3/R6: Escape + focus trap + restore (new)
apps/web/src/components/ui/Dialog.tsx                 R3 (new)
apps/web/src/components/ui/Drawer.tsx                 R3 (new)
apps/web/src/components/ui/Alert.tsx                  R3/E21 (new)
apps/web/src/components/ui/EmptyState.tsx             R3 (new)
apps/web/src/components/ui/LoadingState.tsx           R3 (new)
apps/web/src/components/ui/DangerConfirm.tsx          E12: focus restore, alertdialog, title, Button

apps/web/src/app/layout.tsx                           E16: <main id="main">, the skip link
apps/web/src/components/Sidebar.tsx                   R1/R6: four entries, collapse, skip link
apps/web/src/app/workforce/page.tsx                   R1 (new)
apps/web/src/components/workforce/WorkforceClient.tsx R1/D2 (new)
apps/web/src/app/slaves/page.tsx                      DELETED (redirect, E7)
apps/web/src/app/skills/page.tsx                      DELETED (redirect, E7)
apps/web/src/components/SlavesClient.tsx              DELETED (D2)
apps/web/next.config.ts                               E7: async redirects()
apps/web/src/app/page.tsx                             R1/E20: buildAnalytics(null)
apps/web/src/components/ProjectsClient.tsx            R1: catalog out, analytics in
apps/web/src/components/analytics/KpiStrip.tsx        E20 (new)
apps/web/src/components/AnalyticsClient.tsx           E20: renders KpiStrip
apps/web/src/server/org.ts                            E19: ProjectRow.needsYou
apps/web/src/components/project/ProjectTabs.tsx       R2/E23: four tabs + Advanced ▾
docs/ia.md                                            R7 (new)

apps/web/src/components/AllSlavesTable.tsx            R5 leak 1
apps/web/src/components/SlavePanel.tsx                R5 leak 2 / E24
apps/web/src/components/activity/ActivityClient.tsx   R5 leak 3 / E5
apps/web/src/components/SkillsClient.tsx              R5 leak 4 / E17
apps/web/src/components/SupervisorPanel.tsx           R5 leak 5 / E6
apps/web/src/components/sim/{SimulationsClient,SimulationClient}.tsx  R5 leak 6
apps/web/src/components/EmergencyStopButton.tsx       R3: adopts DangerConfirm
apps/web/src/components/DangerZone.tsx                R3: adopts DangerConfirm
apps/web/src/components/graph/GraphClient.tsx         R6/D10: Tabs, Alert
apps/web/src/components/office/OfficeClient.tsx       R6: canvas aria-label + fallback line
apps/web/src/components/{OverviewClient,TasksClient}.tsx  E21: Alert

scripts/gate-m44-ux-foundation.mjs                    R8 (new)
scripts/gate-m14-fidelity.mjs                         E8/R8: workforce, office, project-settings
docs/superpowers/fidelity/m14/*.png                   regenerated, own commit
package.json, .github/workflows/ci.yml, README.md     gate:m44-ux-foundation; roster 18 -> 19
```

---

### Task 1: The domain status projection (R4)

**Files:**
- Create: `packages/domain/src/status/user.ts`, `packages/domain/src/status/index.ts`
- Create: `packages/domain/test/status/user.test.ts`
- Modify: `packages/domain/src/index.ts` (the export list), `apps/web/src/lib/tones.ts`
- Test: `apps/web/test/tones.test.ts` (must still pass, unchanged)

**Interfaces:**
- Consumes: `TaskStatus` (`packages/domain/src/task/state.ts`), `RunStatus` (`run/state.ts`), `SlaveStatus` (`slave/derived.ts`). Nothing from other tasks.
- Produces (Tasks 3 and 4 import all of this from `@slave-of-ai/domain`):
```ts
export interface UserStatus<S extends string> { readonly state: S; readonly label: string; readonly needsYou: boolean }

export type UserTaskState =
  | 'queued' | 'working' | 'verifying' | 'review' | 'merging'
  | 'waiting' | 'blocked' | 'done' | 'integrated' | 'failed' | 'cancelled'
export interface UserTaskFacts {
  readonly status: TaskStatus
  readonly integrated?: boolean
  readonly autoMerge?: boolean
  readonly questionHolder?: 'slave' | 'nobody' | null
  readonly decisionPending?: boolean
}
export const USER_TASK_STATE_FOR_STATUS: Record<TaskStatus, UserTaskState>
export const USER_TASK_LABEL: Record<UserTaskState, string>
export function needsYou(facts: UserTaskFacts): boolean
export function userTaskStatus(facts: UserTaskFacts): UserStatus<UserTaskState>

export type UserCardState =
  | 'working' | 'planning' | 'waiting' | 'review' | 'paused'
  | 'pause_requested' | 'resuming' | 'blocked' | 'cancelled' | 'idle' | 'completed'
export const USER_CARD_LABEL: Record<UserCardState, string>
export function userRunStatus(status: RunStatus | null): UserStatus<UserCardState>
export function userSlaveStatus(status: SlaveStatus): UserStatus<UserCardState>

export type UserWorkspaceState = 'archived' | 'halted' | 'needs_you' | 'working' | 'idle'
export interface UserWorkspaceFacts {
  readonly archived: boolean
  readonly halted: boolean
  readonly needsYouCount: number
  readonly tasksActive: number
}
export const USER_WORKSPACE_LABEL: Record<UserWorkspaceState, string>
export function userWorkspaceStatus(facts: UserWorkspaceFacts): UserStatus<UserWorkspaceState>
```

- [ ] **Step 1: Write the failing test**

Create `packages/domain/test/status/user.test.ts`. The exhaustiveness idiom is the repository's own
(`apps/web/test/refusal-status.test.ts`'s `ALL_KINDS`): a `Record<Union, true>` object literal that
TypeScript refuses to compile with a member missing or an extra key. Two of them here, because a
projection can fail in two directions — a status with no state, and a state nothing reaches.

`packages/domain` may not import `packages/db` (that would be a package cycle — `packages/db`
imports the domain), so the status lists are re-declared here as `Record<…, true>` literals rather
than imported from `TASK_STATUSES`/`RUN_STATUSES`. The literal IS the compile-time proof.

```ts
import { describe, expect, it } from 'vitest'
import type { RunStatus, SlaveStatus, TaskStatus } from '../../src/index.js'
import {
  USER_CARD_LABEL,
  USER_TASK_LABEL,
  USER_TASK_STATE_FOR_STATUS,
  USER_WORKSPACE_LABEL,
  needsYou,
  userRunStatus,
  userSlaveStatus,
  userTaskStatus,
  userWorkspaceStatus,
  type UserCardState,
  type UserTaskState,
  type UserWorkspaceState,
} from '../../src/status/user.js'

/** Every TaskStatus, as a compile-time-complete literal: a fourteenth member fails to compile. */
const ALL_TASK_STATUSES: Record<TaskStatus, true> = {
  backlog: true, ready: true, blocked: true, assigned: true, running: true, verifying: true,
  reviewing: true, merging: true, rework: true, waiting: true, done: true, failed: true,
  cancelled: true,
}
const ALL_RUN_STATUSES: Record<RunStatus, true> = {
  starting: true, working: true, pause_requested: true, paused: true, resuming: true,
  stopping: true, stopped: true, succeeded: true, failed: true,
}
const ALL_SLAVE_STATUSES: Record<SlaveStatus, true> = {
  idle: true, starting: true, working: true, pausing: true, paused: true, resuming: true,
  stopping: true,
}
const ALL_TASK_STATES: Record<UserTaskState, true> = {
  queued: true, working: true, verifying: true, review: true, merging: true, waiting: true,
  blocked: true, done: true, integrated: true, failed: true, cancelled: true,
}
const ALL_CARD_STATES: Record<UserCardState, true> = {
  working: true, planning: true, waiting: true, review: true, paused: true,
  pause_requested: true, resuming: true, blocked: true, cancelled: true, idle: true,
  completed: true,
}
const ALL_WORKSPACE_STATES: Record<UserWorkspaceState, true> = {
  archived: true, halted: true, needs_you: true, working: true, idle: true,
}

const taskStatuses = Object.keys(ALL_TASK_STATUSES) as TaskStatus[]
const runStatuses = Object.keys(ALL_RUN_STATUSES) as RunStatus[]
const slaveStatuses = Object.keys(ALL_SLAVE_STATUSES) as SlaveStatus[]

describe('userTaskStatus', () => {
  it('gives every TaskStatus a state and a non-empty label', () => {
    for (const status of taskStatuses) {
      const projected = userTaskStatus({ status })
      expect(ALL_TASK_STATES[projected.state]).toBe(true)
      expect(projected.label.length).toBeGreaterThan(0)
      expect(projected.label).toBe(USER_TASK_LABEL[projected.state])
    }
  })

  it('reaches every UserTaskState from some input -- no state is unreachable', () => {
    const reached = new Set<UserTaskState>(taskStatuses.map((status) => userTaskStatus({ status }).state))
    reached.add(userTaskStatus({ status: 'done', integrated: true }).state)
    expect([...reached].sort()).toEqual(Object.keys(ALL_TASK_STATES).sort())
  })

  it('spells the eleven labels the spec names', () => {
    expect(USER_TASK_LABEL).toEqual({
      queued: 'QUEUED', working: 'WORKING', verifying: 'VERIFYING', review: 'IN REVIEW',
      merging: 'MERGING', waiting: 'WAITING', blocked: 'BLOCKED', done: 'DONE',
      integrated: 'INTEGRATED', failed: 'FAILED', cancelled: 'CANCELLED',
    })
  })

  it('groups the pre-run statuses under QUEUED and keeps the in-flight ones apart', () => {
    expect(USER_TASK_STATE_FOR_STATUS.backlog).toBe('queued')
    expect(USER_TASK_STATE_FOR_STATUS.ready).toBe('queued')
    expect(USER_TASK_STATE_FOR_STATUS.rework).toBe('queued')
    expect(USER_TASK_STATE_FOR_STATUS.assigned).toBe('queued')
    expect(USER_TASK_STATE_FOR_STATUS.running).toBe('working')
    expect(USER_TASK_STATE_FOR_STATUS.verifying).toBe('verifying')
    expect(USER_TASK_STATE_FOR_STATUS.reviewing).toBe('review')
    expect(USER_TASK_STATE_FOR_STATUS.merging).toBe('merging')
  })

  it('says INTEGRATED only once the work is actually in the base branch', () => {
    expect(userTaskStatus({ status: 'done' }).state).toBe('done')
    expect(userTaskStatus({ status: 'done', integrated: true }).state).toBe('integrated')
    expect(userTaskStatus({ status: 'done', integrated: true }).label).toBe('INTEGRATED')
  })
})

describe('needsYou', () => {
  it('is true for a blocked task', () => {
    expect(needsYou({ status: 'blocked' })).toBe(true)
    expect(userTaskStatus({ status: 'blocked' }).needsYou).toBe(true)
  })

  it('is true for a waiting task whose question nobody holds, and false when a slave does', () => {
    expect(needsYou({ status: 'waiting', questionHolder: 'nobody' })).toBe(true)
    expect(needsYou({ status: 'waiting', questionHolder: 'slave' })).toBe(false)
    expect(needsYou({ status: 'waiting' })).toBe(false)
  })

  it('is true for done work nobody has integrated on a hand-merge project, and false on an auto-merge one', () => {
    expect(needsYou({ status: 'done', autoMerge: false })).toBe(true)
    expect(needsYou({ status: 'done', autoMerge: true })).toBe(false)
    expect(needsYou({ status: 'done', autoMerge: false, integrated: true })).toBe(false)
  })

  it('is true wherever a Supervisor decision is waiting on a human, not only while waiting (erratum E4)', () => {
    expect(needsYou({ status: 'running', decisionPending: true })).toBe(true)
    expect(needsYou({ status: 'ready', decisionPending: true })).toBe(true)
    expect(needsYou({ status: 'waiting', decisionPending: true })).toBe(true)
  })

  it('is false on a terminal task, decision or not -- nothing a person does moves it (erratum E4)', () => {
    expect(needsYou({ status: 'cancelled', decisionPending: true })).toBe(false)
    expect(needsYou({ status: 'failed', decisionPending: true })).toBe(false)
    expect(needsYou({ status: 'failed' })).toBe(false)
    expect(needsYou({ status: 'done', autoMerge: false, integrated: true, decisionPending: true })).toBe(false)
  })

  it('defaults to the safe answer with no facts beyond the status', () => {
    for (const status of taskStatuses) {
      const bare = userTaskStatus({ status }).needsYou
      expect(bare).toBe(status === 'blocked')
    }
  })
})

describe('userRunStatus and userSlaveStatus', () => {
  it('gives every RunStatus, and no run at all, a card state and its label', () => {
    for (const status of [...runStatuses, null]) {
      const projected = userRunStatus(status)
      expect(ALL_CARD_STATES[projected.state]).toBe(true)
      expect(projected.label).toBe(USER_CARD_LABEL[projected.state])
      expect(projected.needsYou).toBe(false)
    }
    expect(userRunStatus(null).state).toBe('idle')
  })

  it('gives every SlaveStatus a card state and its label', () => {
    for (const status of slaveStatuses) {
      const projected = userSlaveStatus(status)
      expect(ALL_CARD_STATES[projected.state]).toBe(true)
      expect(projected.label).toBe(USER_CARD_LABEL[projected.state])
    }
  })

  it('keeps the labels the web already renders, to the letter (erratum E2)', () => {
    expect(USER_CARD_LABEL).toEqual({
      working: 'WORKING', planning: 'PLANNING', waiting: 'WAITING', review: 'REVIEW',
      paused: 'PAUSED', pause_requested: 'PAUSING', resuming: 'RESUMING', blocked: 'BLOCKED',
      cancelled: 'CANCELLED', idle: 'IDLE', completed: 'DONE',
    })
  })

  it('reproduces the three derivations lib/tones.ts already made', () => {
    expect(userRunStatus('starting').state).toBe('planning')
    expect(userRunStatus('pause_requested').state).toBe('pause_requested')
    expect(userRunStatus('stopping').state).toBe('waiting')
    expect(userRunStatus('stopped').state).toBe('idle')
    expect(userRunStatus('succeeded').state).toBe('completed')
    expect(userRunStatus('failed').state).toBe('blocked')
    expect(userSlaveStatus('pausing').state).toBe('pause_requested')
    expect(userSlaveStatus('stopping').state).toBe('waiting')
    expect(userSlaveStatus('idle').state).toBe('idle')
  })
})

describe('userWorkspaceStatus', () => {
  const base = { archived: false, halted: false, needsYouCount: 0, tasksActive: 0 }

  it('gives every state its own word', () => {
    expect(USER_WORKSPACE_LABEL).toEqual({
      archived: 'ARCHIVED', halted: 'HALTED', needs_you: 'WAITING FOR YOU',
      working: 'WORKING', idle: 'IDLE',
    })
    for (const state of Object.keys(ALL_WORKSPACE_STATES) as UserWorkspaceState[]) {
      expect(USER_WORKSPACE_LABEL[state].length).toBeGreaterThan(0)
    }
  })

  it('reads archived first, then halted, then the person, then the work', () => {
    expect(userWorkspaceStatus({ ...base, archived: true, halted: true, needsYouCount: 3, tasksActive: 2 }).state).toBe('archived')
    expect(userWorkspaceStatus({ ...base, halted: true, needsYouCount: 3, tasksActive: 2 }).state).toBe('halted')
    expect(userWorkspaceStatus({ ...base, needsYouCount: 1, tasksActive: 2 }).state).toBe('needs_you')
    expect(userWorkspaceStatus({ ...base, tasksActive: 2 }).state).toBe('working')
    expect(userWorkspaceStatus(base).state).toBe('idle')
  })

  it('carries needsYou on the project row too', () => {
    expect(userWorkspaceStatus({ ...base, needsYouCount: 1 }).needsYou).toBe(true)
    expect(userWorkspaceStatus({ ...base, halted: true }).needsYou).toBe(true)
    expect(userWorkspaceStatus({ ...base, tasksActive: 4 }).needsYou).toBe(false)
    expect(userWorkspaceStatus({ ...base, archived: true, needsYouCount: 9 }).needsYou).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run packages/domain/test/status/user.test.ts
```
Expected: FAIL — `Failed to resolve import "../../src/status/user.js"`. Nothing else is running
vitest at this moment (Global Constraints).

- [ ] **Step 3: Write the implementation**

Create `packages/domain/src/status/user.ts`:

```ts
import type { RunStatus } from '../run/state.js'
import type { SlaveStatus } from '../slave/derived.js'
import type { TaskStatus } from '../task/state.js'

/**
 * The words this product says to a person about what is happening (M44 R4).
 *
 * A PROJECTION, never a replacement: `TaskStatus` (thirteen), `RunStatus` (nine) and
 * `SlaveStatus` (seven) stay exactly as they are, and every surface that renders one of these
 * words keeps the raw value beside it -- in `title`, in a `data-` attribute, or in the expanded
 * view. Backend state fidelity is never weakened for the UI (roadmap, "Rules that apply to every
 * milestone").
 *
 * PURE. No React, no Prisma, no `node:` import: `packages/domain` reaches `apps/web`'s CLIENT
 * bundle, and anything with a runtime dependency here fails `npm run web:build` (M42 erratum E13).
 * The tone and the pulse a pill is painted with are NOT here -- `StatusTone` is declared in
 * `apps/web/src/components/ui/StatusPill.tsx`, and the domain may not import an app (M44 erratum
 * E2). `apps/web/src/lib/tones.ts` keeps that half and reads every LABEL from this file, so the
 * word and the colour cannot drift apart.
 */
export interface UserStatus<S extends string> {
  readonly state: S
  readonly label: string
  /** Whether a person has to do something before this moves. See {@link needsYou}. */
  readonly needsYou: boolean
}

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

export type UserTaskState =
  | 'queued'
  | 'working'
  | 'verifying'
  | 'review'
  | 'merging'
  | 'waiting'
  | 'blocked'
  | 'done'
  | 'integrated'
  | 'failed'
  | 'cancelled'

/**
 * Every `TaskStatus` on exactly one user state. `Record<TaskStatus, UserTaskState>` is
 * load-bearing: a fourteenth status fails the BUILD here rather than becoming a task with no word.
 *
 * The four pre-run statuses collapse into one: a person does not need `backlog` from `ready` from
 * `rework` from `assigned` to know the work has not started. `verifying`, `reviewing` and
 * `merging` stay apart because they are the three different things that can be happening to
 * finished work, and each has a different answer to "what happens next".
 *
 * `done` is refined to `integrated` by {@link userTaskStatus} when the work is actually in the
 * base branch (`Task.integratedAt`); it cannot be decided from the status alone.
 */
export const USER_TASK_STATE_FOR_STATUS: Record<TaskStatus, UserTaskState> = {
  backlog: 'queued',
  ready: 'queued',
  rework: 'queued',
  assigned: 'queued',
  running: 'working',
  verifying: 'verifying',
  reviewing: 'review',
  merging: 'merging',
  waiting: 'waiting',
  blocked: 'blocked',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

export const USER_TASK_LABEL: Record<UserTaskState, string> = {
  queued: 'QUEUED',
  working: 'WORKING',
  verifying: 'VERIFYING',
  review: 'IN REVIEW',
  merging: 'MERGING',
  waiting: 'WAITING',
  blocked: 'BLOCKED',
  done: 'DONE',
  integrated: 'INTEGRATED',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
}

/**
 * Everything the projection needs that a `TaskStatus` alone cannot say. Only `status` is required:
 * a caller who knows less still gets a correct answer, and every default is the one that does NOT
 * claim a person is needed.
 */
export interface UserTaskFacts {
  readonly status: TaskStatus
  /** `Task.integratedAt !== null`. Default `false`. */
  readonly integrated?: boolean
  /** `Workspace.autoMerge`. Default `true` -- an auto-merge project needs nobody to integrate. */
  readonly autoMerge?: boolean
  /**
   * Who can answer the question this task is waiting on: `'slave'` when a live worker holds it,
   * `'nobody'` for M39's unanswerable case, `null`/absent when the task waits on nothing.
   */
  readonly questionHolder?: 'slave' | 'nobody' | null
  /** A `SupervisorDecision` about this task is `pending` a human's approval. Default `false`. */
  readonly decisionPending?: boolean
}

/** The three statuses nothing a person does can move any further. */
const TERMINAL_TASK_STATES: readonly UserTaskState[] = ['failed', 'cancelled', 'integrated']

function taskStateOf(facts: UserTaskFacts): UserTaskState {
  const base = USER_TASK_STATE_FOR_STATUS[facts.status]
  return base === 'done' && facts.integrated === true ? 'integrated' : base
}

/**
 * Whether a person has to do something before this task moves (M44 R4).
 *
 * Four rules, and the reason for each:
 *   - `blocked` -- M35 gave that status the meaning "a human must look at this", and `unblock-task`
 *     is its only exit.
 *   - `waiting` with nobody holding the question -- M39's unanswerable case: the worker that was
 *     asked is gone, so the wait resolves only if a person answers it.
 *   - `done` and not integrated on a hand-merge project (`autoMerge === false`) -- the work is
 *     finished and sitting on a branch nothing will merge by itself. "Ready to integrate."
 *   - a pending Supervisor decision, in ANY non-terminal state. The spec writes this clause under
 *     `waiting`; a proposal waiting for approval needs a person whatever the task is doing
 *     meanwhile, so it is widened here (M44 plan erratum E4).
 *
 * `failed` is deliberately NOT `needsYou`. The spec's list is closed, a FAILED task already reads
 * red on every surface, and whether an exhausted task joins a needs-you queue is M45's call.
 */
export function needsYou(facts: UserTaskFacts): boolean {
  const state = taskStateOf(facts)
  if (TERMINAL_TASK_STATES.includes(state)) return false
  if (state === 'blocked') return true
  if (state === 'done') return facts.autoMerge === false
  if (state === 'waiting' && facts.questionHolder === 'nobody') return true
  return facts.decisionPending === true
}

export function userTaskStatus(facts: UserTaskFacts): UserStatus<UserTaskState> {
  const state = taskStateOf(facts)
  return { state, label: USER_TASK_LABEL[state], needsYou: needsYou(facts) }
}

// ---------------------------------------------------------------------------------------------
// Runs and slaves
// ---------------------------------------------------------------------------------------------

/**
 * The card vocabulary a run or a worker reads as. Identical, member for member, to the display
 * vocabulary `apps/web/src/lib/tones.ts` has carried since M14 -- this milestone MOVES it into the
 * domain and leaves the tone table behind (erratum E2), so nothing a person sees changes.
 */
export type UserCardState =
  | 'working'
  | 'planning'
  | 'waiting'
  | 'review'
  | 'paused'
  | 'pause_requested'
  | 'resuming'
  | 'blocked'
  | 'cancelled'
  | 'idle'
  | 'completed'

export const USER_CARD_LABEL: Record<UserCardState, string> = {
  working: 'WORKING',
  planning: 'PLANNING',
  waiting: 'WAITING',
  review: 'REVIEW',
  paused: 'PAUSED',
  pause_requested: 'PAUSING',
  resuming: 'RESUMING',
  blocked: 'BLOCKED',
  cancelled: 'CANCELLED',
  idle: 'IDLE',
  completed: 'DONE',
}

/** A run's own status. `null` means "no live run", which is `idle` -- the same statement
 *  `deriveSlaveStatus(null)` makes. A run never needs a person by itself: what needs a person is
 *  the TASK the run is on, and {@link needsYou} is where that is decided. */
export function userRunStatus(status: RunStatus | null): UserStatus<UserCardState> {
  const state = runCardState(status)
  return { state, label: USER_CARD_LABEL[state], needsYou: false }
}

function runCardState(status: RunStatus | null): UserCardState {
  if (status === null) return 'idle'
  switch (status) {
    case 'starting':
      return 'planning'
    case 'working':
      return 'working'
    case 'pause_requested':
      return 'pause_requested'
    case 'paused':
      return 'paused'
    case 'resuming':
      return 'resuming'
    case 'stopping':
      return 'waiting'
    case 'stopped':
      return 'idle'
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'blocked'
  }
}

/** `deriveSlaveStatus`'s output. Exhaustive over all seven members -- an eighth is a build error
 *  here, not a silent fall-through to `idle` at render time. */
export function userSlaveStatus(status: SlaveStatus): UserStatus<UserCardState> {
  const state = slaveCardState(status)
  return { state, label: USER_CARD_LABEL[state], needsYou: false }
}

function slaveCardState(status: SlaveStatus): UserCardState {
  switch (status) {
    case 'idle':
      return 'idle'
    case 'starting':
      return 'planning'
    case 'working':
      return 'working'
    case 'pausing':
      return 'pause_requested'
    case 'paused':
      return 'paused'
    case 'resuming':
      return 'resuming'
    case 'stopping':
      return 'waiting'
  }
}

// ---------------------------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------------------------

export type UserWorkspaceState = 'archived' | 'halted' | 'needs_you' | 'working' | 'idle'

export const USER_WORKSPACE_LABEL: Record<UserWorkspaceState, string> = {
  archived: 'ARCHIVED',
  halted: 'HALTED',
  needs_you: 'WAITING FOR YOU',
  working: 'WORKING',
  idle: 'IDLE',
}

export interface UserWorkspaceFacts {
  readonly archived: boolean
  readonly halted: boolean
  /** How many of this project's tasks {@link needsYou} is true for. */
  readonly needsYouCount: number
  readonly tasksActive: number
}

/**
 * One word for a whole project (M44 R4).
 *
 * The order is the order a person reads it in: an archived project is archived whatever else is
 * true of it; a halted one is halted; then "does this want me", then "is anything happening", then
 * nothing is. An archived project never says WAITING FOR YOU -- nothing in it is going to move,
 * and inviting somebody into it would be a lie.
 */
export function userWorkspaceStatus(facts: UserWorkspaceFacts): UserStatus<UserWorkspaceState> {
  const state: UserWorkspaceState = facts.archived
    ? 'archived'
    : facts.halted
      ? 'halted'
      : facts.needsYouCount > 0
        ? 'needs_you'
        : facts.tasksActive > 0
          ? 'working'
          : 'idle'
  return {
    state,
    label: USER_WORKSPACE_LABEL[state],
    needsYou: state === 'halted' || state === 'needs_you',
  }
}
```

Create `packages/domain/src/status/index.ts`:

```ts
export * from './user.js'
```

- [ ] **Step 4: Export it from the domain barrel**

In `packages/domain/src/index.ts`, add one line after `export * from './catalog/index.js'`:

```ts
export * from './status/index.js'
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx tsc --build
npx vitest run packages/domain/test/status/user.test.ts
```
Expected: PASS, every case.

- [ ] **Step 6: Point `lib/tones.ts` at the domain**

Erratum E2: the tone and the pulse stay here (they name Tailwind classes through `StatusTone`); the
state and the label come from the domain. Replace the `CardState` type, the `CARD_STATE_TONE`
labels, `cardStateForRun` and `cardStateForSlave` in `apps/web/src/lib/tones.ts` with the
following, and LEAVE `cardStateFor`, `cardStateForTask` and `toneForTaskStatus` exactly as they are
(erratum E3 — they derive through `lib/taskColumns.ts`, which is the board's business):

```ts
import { USER_CARD_LABEL, userRunStatus, userSlaveStatus, type UserCardState } from '@slave-of-ai/domain'
import type { SlaveStatus, RunStatus, TaskStatus } from '@slave-of-ai/domain'
import type { StatusTone } from '../components/ui/StatusPill'
import { COLUMN_FOR_STATUS, COLUMN_STATE } from './taskColumns'

/**
 * The ten card states, now owned by `packages/domain/src/status/user.ts` (M44 R4). This file keeps
 * the half the domain cannot have: which TONE a state is painted in and whether its dot breathes.
 * `StatusTone` is a `components/ui/StatusPill` type and `packages/domain` may not import an app
 * (M44 erratum E2), so the split runs exactly there -- and every LABEL below is read out of
 * `USER_CARD_LABEL` rather than restated, so the word and the colour cannot drift.
 */
export type CardState = UserCardState

export interface ToneSpec {
  readonly tone: StatusTone
  readonly label: string
  /**
   * Whether the pill's dot breathes. NOT derivable from `tone` alone, which is the whole reason
   * this field exists: `pause_requested` and `waiting` share the amber `waiting` tone, and only
   * the first pulses; `resuming` and `working` share teal, and both do.
   */
  readonly pulse: boolean
}

const TONE_AND_PULSE: Record<CardState, { readonly tone: StatusTone; readonly pulse: boolean }> = {
  working: { tone: 'working', pulse: true },
  planning: { tone: 'planning', pulse: true },
  waiting: { tone: 'waiting', pulse: false },
  review: { tone: 'review', pulse: true },
  paused: { tone: 'paused', pulse: false },
  pause_requested: { tone: 'waiting', pulse: true },
  resuming: { tone: 'working', pulse: true },
  blocked: { tone: 'blocked', pulse: false },
  // M40 §6: a cancelled task is not a broken one. It rides the muted `idle` grey rather than
  // `blocked`'s red, because red is the colour of something that needs an operator and a task
  // somebody took off the board needs nothing at all.
  cancelled: { tone: 'idle', pulse: false },
  idle: { tone: 'idle', pulse: false },
  completed: { tone: 'done', pulse: false },
}

export const CARD_STATE_TONE: Record<CardState, ToneSpec> = Object.fromEntries(
  (Object.keys(TONE_AND_PULSE) as CardState[]).map((state) => [
    state,
    { ...TONE_AND_PULSE[state], label: USER_CARD_LABEL[state] },
  ]),
) as Record<CardState, ToneSpec>

/** A run's own status. `null` means "no live run", which is `idle`. Thin adapter over the domain's
 *  `userRunStatus` -- kept so the ~20 existing call sites read the same as they always did. */
export function cardStateForRun(status: RunStatus | null): CardState {
  return userRunStatus(status).state
}

/** `deriveSlaveStatus`'s output, through the domain. */
export function cardStateForSlave(status: SlaveStatus): CardState {
  return userSlaveStatus(status).state
}

/**
 * The tone for a worker row's `StatusPill`, from the SAME derivation its label comes from (M44
 * erratum E18). Moved here from `components/SlavesClient.tsx`, whose `SLAVE_STATUS_TONE` was a
 * second status->tone table living beside `CARD_STATE_TONE` -- exactly the drift this file exists
 * to end. `AllSlaveRow` types `status` as a bare `string` (`server/org.ts`) even though it is
 * always `deriveSlaveStatus`'s output, so anything outside the vocabulary falls back to `idle`
 * rather than throwing at render time.
 */
export function toneForStatus(status: string): StatusTone {
  const known = (['idle', 'starting', 'working', 'pausing', 'paused', 'resuming', 'stopping'] as const).find(
    (member) => member === status,
  )
  return CARD_STATE_TONE[known === undefined ? 'idle' : cardStateForSlave(known)].tone
}
```

- [ ] **Step 7: Prove the web still says exactly what it said before**

`apps/web/test/tones.test.ts` is untouched and must pass unchanged — that is the whole proof that
the move changed no word. `apps/web/test/slaves-page.test.tsx:51-58` pins the seven `toneForStatus`
cases; it currently imports `toneForStatus` from `../src/components/SlavesClient.js`, so change
that import to `../src/lib/tones.js` and delete the `SLAVE_STATUS_TONE` export and the
`toneForStatus` function from `apps/web/src/components/SlavesClient.tsx`, updating
`components/AllSlavesTable.tsx:9`'s import to `../lib/tones` at the same time.

```bash
npx vitest run apps/web/test/tones.test.ts apps/web/test/slaves-page.test.tsx apps/web/test/all-slaves-table.test.tsx packages/domain/test/status/user.test.ts
```
Expected: PASS, all four files.

- [ ] **Step 8: The task's own gates**

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: three greens. No `web:build` here — this task changes no route, no component tree and no
CSS, and `typecheck` already runs `tsc -p apps/web/tsconfig.json`.

- [ ] **Step 9: Commit**

```bash
git add packages/domain/src/status packages/domain/src/index.ts packages/domain/test/status \
        apps/web/src/lib/tones.ts apps/web/src/components/SlavesClient.tsx \
        apps/web/src/components/AllSlavesTable.tsx apps/web/test/slaves-page.test.tsx
git commit -m "$(cat <<'EOF'
feat(domain,web): m44 t1 -- one place decides what a status is called

packages/domain/src/status/user.ts is the projection R4 asks for: userTaskStatus over all thirteen
TaskStatus members, userRunStatus and userSlaveStatus over the nine and the seven, and
userWorkspaceStatus over a project's four facts -- each returning a state, a label and whether a
person is needed. Exhaustive by construction (Record<TaskStatus, UserTaskState> is the compile-time
proof) and pure: no React, no Prisma, no node import, because this package reaches the web client
bundle.

The tone table stays in apps/web. StatusTone is a components/ui type and the domain may not import
an app, so lib/tones.ts keeps state -> tone/pulse and reads every label out of USER_CARD_LABEL --
the word and the colour can no longer drift. cardStateFor and cardStateForTask stay behind too:
both derive through the board's own column grouping, which is not a domain concern.

needsYou widens the spec's decision clause past `waiting`: a Supervisor proposal waiting on a human
needs one whatever the task is doing meanwhile. It stays false on a terminal task, `failed`
included -- that call belongs to M45's needs-you queue.

SlavesClient's SLAVE_STATUS_TONE was a second status-to-tone table beside CARD_STATE_TONE; it is
gone, and toneForStatus now derives through the same projection its label will.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 2: The design-system primitives (R3) and the tokens (R3/E14/E15)

Additive. Nothing outside `components/ui` and `globals.css` changes in this task except
`DangerConfirm` adopting `Button`; call-site migration is Task 4's job.

**Files:**
- Create: `apps/web/src/components/ui/PageShell.tsx`, `Tabs.tsx`, `useModalDismiss.ts`, `Dialog.tsx`, `Drawer.tsx`, `Alert.tsx`, `EmptyState.tsx`, `LoadingState.tsx`
- Modify: `apps/web/src/components/ui/Button.tsx`, `Card.tsx`, `FormControls.tsx`, `DangerConfirm.tsx`, `apps/web/src/app/globals.css`
- Test: `apps/web/test/ui-components.test.tsx` (extend), `apps/web/test/form-controls.test.tsx` (extend), `apps/web/test/danger-confirm.test.tsx` (extend); create `apps/web/test/ui-modals.test.tsx`, `apps/web/test/ui-tabs.test.tsx`

**Interfaces:**
- Consumes: `StatusTone`, `TONE_FILL`, `TONE_BORDER`, `TONE_TEXT` from `./StatusPill`; `SECTION_LABEL_CLASS` from `./SectionLabel`. Nothing from Task 1.
- Produces (Tasks 3, 4 and 5 rely on these exact signatures):
```ts
// PageShell.tsx
export function PageShell(props: {
  readonly title?: string
  readonly action?: React.ReactNode
  readonly tabs?: React.ReactNode
  readonly testId?: string          // default 'page-shell'
  readonly children: React.ReactNode
}): React.JSX.Element

// Button.tsx
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant: 'primary' | 'ghost' | 'danger'
  readonly size?: 'md' | 'sm'      // default 'md'
}
export function Button(props: ButtonProps): React.JSX.Element

// Card.tsx
export function Card(props: {
  readonly selected?: boolean
  readonly onClick?: () => void
  readonly className?: string
  readonly testId?: string          // default 'card'
  readonly data?: Readonly<Record<`data-${string}`, string>>
  readonly children: React.ReactNode
}): React.JSX.Element

// Tabs.tsx
export interface TabSpec { readonly id: string; readonly label: string; readonly badge?: React.ReactNode; readonly href?: string }
export function Tabs(props: {
  readonly tabs: readonly TabSpec[]
  readonly current: string
  readonly ariaLabel: string
  readonly testIdPrefix: string
  readonly onSelect?: (id: string) => void
  readonly disabledIds?: readonly string[]
}): React.JSX.Element

// useModalDismiss.ts
export function useModalDismiss(args: {
  readonly open: boolean
  readonly onClose: () => void
  readonly enabled?: boolean        // default true; false while a request is in flight
}): React.RefObject<HTMLElement | null>

// Dialog.tsx / Drawer.tsx
export function Dialog(props: { readonly open: boolean; readonly onClose: () => void; readonly label: string; readonly testId: string; readonly dismissible?: boolean; readonly children: React.ReactNode }): React.JSX.Element | null
export function Drawer(props: { readonly open: boolean; readonly onClose: () => void; readonly label: string; readonly testId: string; readonly width?: string; readonly dismissible?: boolean; readonly children: React.ReactNode }): React.JSX.Element | null

// Alert.tsx
export function Alert(props: { readonly variant: 'error' | 'notice' | 'success'; readonly testId?: string; readonly children: React.ReactNode }): React.JSX.Element

// EmptyState.tsx / LoadingState.tsx
export function EmptyState(props: { readonly message: string; readonly action?: React.ReactNode; readonly testId: string }): React.JSX.Element
export function LoadingState(props: { readonly message?: string; readonly testId: string }): React.JSX.Element

// DangerConfirm.tsx (widened; existing props unchanged)
export function DangerConfirm(props: {
  readonly label: string
  readonly testId: string
  readonly confirmText: string
  readonly disabled?: boolean
  readonly title?: string
  readonly onConfirm: () => Promise<string | null>
  readonly className?: string
}): React.JSX.Element
```

- [ ] **Step 1: Add the tokens**

In `apps/web/src/app/globals.css`, inside `:root`, after the `--text-3` line, add the rest of the
handoff's text ramp and the surfaces that are currently hex literals (erratum E15). The names are
the handoff README's own ("Design Tokens": primary, strong, body, secondary, muted, dim, faint,
label, ghost):

```css
  /* The rest of the handoff's text ramp (design_handoff README "Design Tokens"), previously
   * scattered through SlaveCard/TaskCard/ProjectsClient/Sidebar/ProjectSwitcher as hex literals
   * -- a shadow palette beside the declared one (M44 R3). */
  --text-strong: #f2f5f9;
  --text-body: #c8cfda;
  --text-secondary: #a8b0bd;
  --text-dim: #7c8697;
  --text-ghost: #3f4650;

  /* The surfaces the handoff names beside the three declared ones. */
  --bg-selected: #151a21; /* a selected row/card */
  --bg-card-alt: #0f1116; /* the board's task card */
  --bg-canvas: #08090c;   /* the graph canvas */
  --bg-floor: #07080b;    /* the office floor */

  /* Two more hairlines the handoff names: `.05` inner rows, and the `.20` a hover raises to. */
  --line-inner: rgba(255, 255, 255, 0.05);
  --line-hover: rgba(255, 255, 255, 0.2);

  /* Two radii that were literals with no token at all (M44 erratum E14): the 2px bar cap and the
   * 14px message bubble. */
  --radius-hair: 2px;
  --radius-bubble: 14px;
```

and in the `@theme inline` block, the matching mappings:

```css
  --color-text-strong: var(--text-strong);
  --color-text-body: var(--text-body);
  --color-text-secondary: var(--text-secondary);
  --color-text-dim: var(--text-dim);
  --color-text-ghost: var(--text-ghost);
  --color-bg-selected: var(--bg-selected);
  --color-bg-card-alt: var(--bg-card-alt);
  --color-bg-canvas: var(--bg-canvas);
  --color-bg-floor: var(--bg-floor);
  --color-line-inner: var(--line-inner);
  --color-line-hover: var(--line-hover);
  --radius-hair: var(--radius-hair);
  --radius-bubble: var(--radius-bubble);
```

- [ ] **Step 2: Write the failing primitive tests**

Create `apps/web/test/ui-modals.test.tsx` — the focus contract is the only genuinely new behaviour
in this task, so it is written first and in full:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from '../src/components/ui/Dialog.js'
import { Drawer } from '../src/components/ui/Drawer.js'

describe('Dialog and Drawer own Escape, the focus trap and the focus restore (M44 R3/R6)', () => {
  for (const [name, Modal] of [['Dialog', Dialog], ['Drawer', Drawer]] as const) {
    it(`${name} renders nothing when closed and an aria-modal dialog when open`, () => {
      const { rerender } = render(<Modal open={false} onClose={vi.fn()} label="L" testId="m"><button type="button">x</button></Modal>)
      expect(screen.queryByTestId('m')).toBeNull()
      rerender(<Modal open onClose={vi.fn()} label="L" testId="m"><button type="button">x</button></Modal>)
      const node = screen.getByTestId('m')
      expect(node.getAttribute('role')).toBe('dialog')
      expect(node.getAttribute('aria-modal')).toBe('true')
      expect(node.getAttribute('aria-label')).toBe('L')
    })

    it(`${name} moves focus inside on open`, () => {
      render(<Modal open onClose={vi.fn()} label="L" testId="m"><button type="button" data-testid="first">first</button></Modal>)
      expect(document.activeElement).toBe(screen.getByTestId('first'))
    })

    it(`${name} closes on Escape`, () => {
      const onClose = vi.fn()
      render(<Modal open onClose={onClose} label="L" testId="m"><button type="button">x</button></Modal>)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it(`${name} ignores Escape while dismissible is false -- a request is in flight`, () => {
      const onClose = vi.fn()
      render(<Modal open dismissible={false} onClose={onClose} label="L" testId="m"><button type="button">x</button></Modal>)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
    })

    it(`${name} wraps Tab from the last focusable back to the first, and Shift+Tab the other way`, () => {
      render(
        <Modal open onClose={vi.fn()} label="L" testId="m">
          <button type="button" data-testid="first">first</button>
          <input data-testid="middle" />
          <button type="button" data-testid="last">last</button>
        </Modal>,
      )
      const first = screen.getByTestId('first')
      const last = screen.getByTestId('last')

      last.focus()
      fireEvent.keyDown(screen.getByTestId('m'), { key: 'Tab' })
      expect(document.activeElement).toBe(first)

      first.focus()
      fireEvent.keyDown(screen.getByTestId('m'), { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(last)
    })

    it(`${name} gives focus back to whatever opened it`, () => {
      function Open(): React.JSX.Element {
        return (
          <>
            <button type="button" data-testid="trigger">open</button>
            <Modal open onClose={vi.fn()} label="L" testId="m"><button type="button" data-testid="first">first</button></Modal>
          </>
        )
      }
      const { rerender } = render(<><button type="button" data-testid="trigger">open</button></>)
      screen.getByTestId('trigger').focus()
      expect(document.activeElement).toBe(screen.getByTestId('trigger'))
      rerender(<Open />)
      expect(document.activeElement).toBe(screen.getByTestId('first'))
      rerender(
        <>
          <button type="button" data-testid="trigger">open</button>
          <Dialog open={false} onClose={vi.fn()} label="L" testId="m"><button type="button">first</button></Dialog>
        </>,
      )
      expect(document.activeElement).toBe(screen.getByTestId('trigger'))
    })
  }
})
```

Create `apps/web/test/ui-tabs.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Tabs } from '../src/components/ui/Tabs.js'

const TABS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta', badge: 7 },
  { id: 'c', label: 'Gamma' },
]

describe('Tabs', () => {
  it('is a tablist of tabs, one selected, with the name it was given', () => {
    render(<Tabs tabs={TABS} current="b" ariaLabel="Sections" testIdPrefix="t" onSelect={vi.fn()} />)
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Sections')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.getAttribute('data-testid'))).toEqual(['t-a', 't-b', 't-c'])
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(screen.getByTestId('t-b').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('t-a').getAttribute('aria-current')).toBeNull()
  })

  it('renders a badge only where one was given', () => {
    render(<Tabs tabs={TABS} current="a" ariaLabel="Sections" testIdPrefix="t" onSelect={vi.fn()} />)
    expect(screen.getByTestId('t-badge-b').textContent).toBe('7')
    expect(screen.queryByTestId('t-badge-a')).toBeNull()
  })

  it('calls onSelect with the tab id', () => {
    const onSelect = vi.fn()
    render(<Tabs tabs={TABS} current="a" ariaLabel="Sections" testIdPrefix="t" onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('t-c'))
    expect(onSelect).toHaveBeenCalledWith('c')
  })

  it('renders links, not buttons, when a tab carries an href', () => {
    render(
      <Tabs
        tabs={[{ id: 'a', label: 'Alpha', href: '/a' }, { id: 'b', label: 'Beta', href: '/b' }]}
        current="a"
        ariaLabel="Project"
        testIdPrefix="p"
      />,
    )
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('href'))).toEqual(['/a', '/b'])
  })

  it('disables the tabs it is told to and does not select them', () => {
    const onSelect = vi.fn()
    render(<Tabs tabs={TABS} current="a" ariaLabel="Sections" testIdPrefix="t" disabledIds={['c']} onSelect={onSelect} />)
    expect((screen.getByTestId('t-c') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('t-c'))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
```

Append to `apps/web/test/ui-components.test.tsx`:

```tsx
describe('Button (M44 R3: one button, three variants, two sizes)', () => {
  it('renders each variant with its own data-variant', () => {
    render(
      <>
        <Button variant="primary">go</Button>
        <Button variant="ghost">maybe</Button>
        <Button variant="danger">stop</Button>
      </>,
    )
    expect(screen.getAllByTestId('button').map((b) => b.getAttribute('data-variant'))).toEqual(['primary', 'ghost', 'danger'])
  })

  it('is md by default and sm on request -- sm IS the FormControls geometry, so nothing moves', () => {
    render(
      <>
        <Button variant="ghost">a</Button>
        <Button variant="ghost" size="sm">b</Button>
      </>,
    )
    const [md, sm] = screen.getAllByTestId('button')
    expect(md?.className).toContain('px-3')
    expect(md?.className).toContain('py-1.5')
    expect(sm?.className).toContain('px-2.5')
    expect(sm?.className).toContain('py-1')
    expect(md?.getAttribute('data-size')).toBe('md')
    expect(sm?.getAttribute('data-size')).toBe('sm')
  })

  it('paints danger on the blocked tone and primary on working, at the handoff alphas', () => {
    render(<><Button variant="danger">x</Button><Button variant="primary">y</Button></>)
    const [danger, primary] = screen.getAllByTestId('button')
    expect(danger?.className).toContain('bg-tone-blocked/10')
    expect(danger?.className).toContain('border-tone-blocked/24')
    expect(primary?.className).toContain('bg-tone-working/10')
  })

  it('lets a caller name its own testid without losing the variant attribute', () => {
    render(<Button variant="ghost" data-testid="my-button">x</Button>)
    expect(screen.getByTestId('my-button').getAttribute('data-variant')).toBe('ghost')
  })
})

describe('Card (M44 R3, erratum E1: additive only)', () => {
  it('appends a caller className and passes data attributes through', () => {
    render(<Card className="w-40" data={{ 'data-status': 'working' }}>x</Card>)
    const card = screen.getByTestId('card')
    expect(card.className).toContain('w-40')
    expect(card.getAttribute('data-status')).toBe('working')
  })

  it('lets a caller name its own testid', () => {
    render(<Card testId="project-surface">x</Card>)
    expect(screen.getByTestId('project-surface')).toBeTruthy()
    expect(screen.queryByTestId('card')).toBeNull()
  })
})

describe('Alert, EmptyState and LoadingState', () => {
  it('Alert is a role=alert band with its variant on the node', () => {
    render(<Alert variant="notice" testId="stale">showing stale data</Alert>)
    const band = screen.getByTestId('stale')
    expect(band.getAttribute('role')).toBe('alert')
    expect(band.getAttribute('data-variant')).toBe('notice')
    expect(band.textContent).toBe('showing stale data')
  })

  it('EmptyState says the sentence and can carry one action', () => {
    render(<EmptyState testId="no-blocked" message="nothing is blocked" action={<Button variant="ghost">refresh</Button>} />)
    expect(screen.getByTestId('no-blocked').textContent).toContain('nothing is blocked')
    expect(screen.getByTestId('button')).toBeTruthy()
  })

  it('LoadingState is a polite status, not an alert', () => {
    render(<LoadingState testId="loading" />)
    const node = screen.getByTestId('loading')
    expect(node.getAttribute('role')).toBe('status')
    expect(node.getAttribute('aria-live')).toBe('polite')
    expect(node.textContent).toBe('loading…')
  })
})

describe('PageShell', () => {
  it('renders the title row, an optional action, an optional tabs slot and its children', () => {
    render(
      <PageShell title="Workforce" action={<Button variant="primary">+ New slave</Button>} tabs={<div data-testid="tabs-slot" />}>
        <p>body</p>
      </PageShell>,
    )
    const shell = screen.getByTestId('page-shell')
    expect(shell.textContent).toContain('Workforce')
    expect(screen.getByTestId('tabs-slot')).toBeTruthy()
    expect(screen.getByTestId('button').textContent).toBe('+ New slave')
    expect(shell.textContent).toContain('body')
  })

  it('renders children alone when nothing else is given', () => {
    render(<PageShell><p>only</p></PageShell>)
    expect(screen.getByTestId('page-shell').textContent).toBe('only')
  })
})
```

(Add `Alert`, `EmptyState`, `LoadingState` and `PageShell` to that file's import block.)

Append to `apps/web/test/danger-confirm.test.tsx`:

```tsx
describe('DangerConfirm, widened for EmergencyStop and DangerZone (M44 R3, erratum E12)', () => {
  it('is an alertdialog while it is asking, named after its label', () => {
    render(<DangerConfirm label="STOP" testId="x" confirmText="stop everything" onConfirm={async () => null} />)
    fireEvent.click(screen.getByTestId('x'))
    expect(screen.getByRole('alertdialog', { name: /STOP/ })).toBeTruthy()
  })

  it('focuses the confirm on open and gives focus back to the trigger on Escape', () => {
    render(<DangerConfirm label="STOP" testId="x" confirmText="stop everything" onConfirm={async () => null} />)
    screen.getByTestId('x').focus()
    fireEvent.click(screen.getByTestId('x'))
    expect(document.activeElement).toBe(screen.getByTestId('x-confirm'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByTestId('x'))
  })

  it('carries a title on the idle trigger, for a disabled control that has to say why', () => {
    render(<DangerConfirm label="STOP" testId="x" confirmText="c" disabled title="workspace is already halted" onConfirm={async () => null} />)
    expect(screen.getByTestId('x').getAttribute('title')).toBe('workspace is already halted')
  })
})
```

Append to `apps/web/test/form-controls.test.tsx`:

```tsx
describe('GhostButton and PrimaryButton are aliases of Button now (M44 R3)', () => {
  it('GhostButton is a small ghost Button', () => {
    render(<GhostButton>x</GhostButton>)
    const button = screen.getByTestId('button')
    expect(button.getAttribute('data-variant')).toBe('ghost')
    expect(button.getAttribute('data-size')).toBe('sm')
  })

  it('PrimaryButton is a small primary Button, and tone="blocked" is the danger variant', () => {
    render(<><PrimaryButton>go</PrimaryButton><PrimaryButton tone="blocked">stop</PrimaryButton></>)
    const [primary, danger] = screen.getAllByTestId('button')
    expect(primary?.getAttribute('data-variant')).toBe('primary')
    expect(danger?.getAttribute('data-variant')).toBe('danger')
    expect(danger?.getAttribute('data-size')).toBe('sm')
  })

  it('still passes a caller testid, disabled and onClick straight through', () => {
    const onClick = vi.fn()
    render(<GhostButton data-testid="mine" disabled onClick={onClick}>x</GhostButton>)
    expect((screen.getByTestId('mine') as HTMLButtonElement).disabled).toBe(true)
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

```bash
npx vitest run apps/web/test/ui-modals.test.tsx apps/web/test/ui-tabs.test.tsx apps/web/test/ui-components.test.tsx apps/web/test/form-controls.test.tsx apps/web/test/danger-confirm.test.tsx
```
Expected: FAIL — unresolved imports for the five new files, and unknown props on the four existing
components.

- [ ] **Step 4: Write `Button`, `Card` and the `FormControls` aliases**

Replace `apps/web/src/components/ui/Button.tsx`:

```tsx
import { TONE_BORDER, TONE_FILL, TONE_TEXT } from './StatusPill'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant: 'primary' | 'ghost' | 'danger'
  /** `md` is the handoff's standalone action (`px-3 py-1.5`); `sm` is the denser control that sits
   *  inside a form row or a table cell (`px-2.5 py-1`). `sm` is EXACTLY the geometry
   *  `FormControls`' `GhostButton`/`PrimaryButton` carried before M44 folded them into this
   *  component, so the thirty-five call sites that used them did not move a pixel. */
  readonly size?: 'md' | 'sm'
}

const SURFACE: Record<ButtonProps['variant'], string> = {
  ghost: 'border-line bg-transparent text-text-2 hover:border-line-hover hover:text-text-1',
  // Primary rides the `working` tone (the handoff's default "go" colour) and danger the `blocked`
  // one -- both through `StatusPill`'s own `1a`-alpha fill / `3d`-alpha border tables, not a
  // bespoke button colour. `FormControls` had drifted to `/15` and `/40`; M44 converges on the
  // handoff's stated alphas, which is the only visual change this consolidation makes.
  primary: `${TONE_FILL.working} ${TONE_BORDER.working} ${TONE_TEXT.working} hover:brightness-125`,
  danger: `${TONE_FILL.blocked} ${TONE_BORDER.blocked} ${TONE_TEXT.blocked} hover:brightness-125`,
}

const GEOMETRY: Record<NonNullable<ButtonProps['size']>, string> = {
  md: 'px-3 py-1.5',
  sm: 'px-2.5 py-1',
}

/**
 * The ONE button (M44 R3). `ghost` for a secondary action, `primary` for the default "go",
 * `danger` for anything destructive -- and `DangerConfirm` is still the only thing that may FIRE a
 * destructive action, because a destructive action asks twice.
 *
 * Forwards native `<button>` props (`type` defaults to `"button"` so a caller does not accidentally
 * submit an enclosing form); `className` is appended after the variant's own classes so a caller
 * can extend layout (`w-full`) without fighting it; a caller's own `data-testid` overrides the
 * default because `{...rest}` is spread last.
 */
export function Button({ variant, size = 'md', type = 'button', className, ...rest }: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      data-testid="button"
      data-variant={variant}
      data-size={size}
      className={`inline-flex items-center justify-center gap-1.5 rounded-chip border ${GEOMETRY[size]} text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${SURFACE[variant]} ${className ?? ''}`}
      {...rest}
    />
  )
}
```

Replace the body of `apps/web/src/components/ui/Card.tsx` (docblock kept, widened):

```tsx
/**
 * The handoff card surface (spec §3): `bg-bg-2`, radius 8, hover border. Renders as a `<button>`
 * when `onClick` is given and a plain `<div>` otherwise.
 *
 * M44 R3 widens it with `className`, `testId` and a `data` bag so a caller can extend the surface
 * and label it -- the three things `SlaveCard.tsx` names in its own docblock as the reason it is
 * NOT a `Card`. The three card DOMs do not converge in M44: `SlaveCard`'s `padding: 12px 13px` and
 * `border-radius: 8px` are two of `gate:m14-fidelity`'s stage-2 assertions and two of the design
 * README's numbers, and M44 freezes those (plan erratum E1). This is the groundwork M45 finishes.
 */
export function Card({
  selected = false,
  onClick,
  className,
  testId = 'card',
  data,
  children,
}: {
  readonly selected?: boolean
  readonly onClick?: () => void
  readonly className?: string
  readonly testId?: string
  readonly data?: Readonly<Record<`data-${string}`, string>>
  readonly children: React.ReactNode
}): React.JSX.Element {
  const surface = selected ? 'border-line-hover bg-bg-selected' : 'border-line bg-bg-2 hover:border-line-hover'
  const classes = `flex w-full flex-col gap-2 rounded-card border p-3 text-left transition-colors ${surface} ${className ?? ''}`.trim()

  if (onClick !== undefined) {
    return (
      <button type="button" data-testid={testId} data-selected={selected} {...data} onClick={onClick} className={classes}>
        {children}
      </button>
    )
  }

  return (
    <div data-testid={testId} data-selected={selected} {...data} className={classes}>
      {children}
    </div>
  )
}
```

In `apps/web/src/components/ui/FormControls.tsx`, replace `GhostButton` and `PrimaryButton` with
aliases and rewrite `INPUT_SHELL`'s radius literal (erratum E14):

```tsx
export const INPUT_SHELL =
  'rounded-tile border border-line bg-bg-0 px-2.5 py-1.5 text-sm text-text-1 placeholder:text-text-3 focus:border-white/25 focus:outline-none'

/**
 * M44 R3: the second button system is gone. These two are ALIASES of `ui/Button` at `size="sm"`,
 * which is that component's name for the exact geometry these carried (`px-2.5 py-1`, radius 5) --
 * so the thirty-five call sites did not move when the two systems became one. They stay exported
 * so this milestone is not also a thirty-five-file rename; Task 4 migrates the call sites and
 * these go with the last of them.
 */
export function GhostButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return <Button variant="ghost" size="sm" {...props} />
}

export function PrimaryButton({
  tone = 'working',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly tone?: 'working' | 'blocked' }): React.JSX.Element {
  return <Button variant={tone === 'blocked' ? 'danger' : 'primary'} size="sm" {...rest} />
}
```

with `import { Button } from './Button'` added at the top.

- [ ] **Step 5: Write the focus contract, then the two modals**

Create `apps/web/src/components/ui/useModalDismiss.ts`:

```ts
'use client'

import { useEffect, useRef } from 'react'

/** Everything the browser will focus, in document order. `:not([disabled])` and the negative
 *  tabindex filter keep a disabled confirm button and a decorative `tabindex="-1"` container out
 *  of the cycle. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The three keyboard promises a modal makes (M44 R3/R6), written ONCE.
 *
 * Before this, nine components each added their own `document.addEventListener('keydown', ...)`
 * for Escape, no drawer trapped Tab at all, and only `EmergencyStopButton` restored focus to its
 * trigger -- in a comment explaining how, rather than in shared code.
 *
 *   - Escape closes, unless `enabled` is false (a request is in flight and closing would leave the
 *     operator unsure whether it went through).
 *   - Tab and Shift+Tab cycle INSIDE the container, so a keyboard user cannot walk out of an open
 *     modal into the page behind it.
 *   - Whatever had focus when the modal opened gets it back when it closes -- read at open time,
 *     because by close time the trigger may have re-rendered.
 *
 * Returns the ref to put on the modal's container. Menus are NOT modals: `ProjectSwitcher` and
 * `graph/NodeMenu` keep their own Escape handling (plan erratum E22).
 */
export function useModalDismiss({
  open,
  onClose,
  enabled = true,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly enabled?: boolean
}): React.RefObject<HTMLElement | null> {
  const containerRef = useRef<HTMLElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const container = containerRef.current
    const first = container?.querySelector<HTMLElement>(FOCUSABLE) ?? null
    ;(first ?? container)?.focus()
    return () => {
      const restore = restoreRef.current
      restoreRef.current = null
      // `isConnected`: a trigger that unmounted while the modal was open (the two-step confirm
      // idiom replaces its own button) has nowhere to give focus back to, and focusing a detached
      // node silently moves focus to `<body>` instead.
      if (restore !== null && restore.isConnected) restore.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (enabled) onClose()
        return
      }
      if (event.key !== 'Tab') return
      const container = containerRef.current
      if (container === null) return
      const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === container)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, enabled, onClose])

  return containerRef
}
```

Create `apps/web/src/components/ui/Dialog.tsx`:

```tsx
'use client'

import { useModalDismiss } from './useModalDismiss'

/**
 * A centred modal (M44 R3). Owns Escape, the Tab trap, focus restore and `aria-modal` through
 * `useModalDismiss`; the caller owns the content and the verbs. `dismissible={false}` while a
 * request is in flight, so Escape cannot close a dialog mid-POST.
 */
export function Dialog({
  open,
  onClose,
  label,
  testId,
  dismissible = true,
  children,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly label: string
  readonly testId: string
  readonly dismissible?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element | null {
  const ref = useModalDismiss({ open, onClose, enabled: dismissible })
  if (!open) return null
  return (
    <div data-testid={`${testId}-backdrop`} className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={ref as React.RefObject<HTMLDivElement>}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid={testId}
        tabIndex={-1}
        className="flex w-[420px] max-w-full flex-col gap-3 rounded-panel border border-line bg-bg-1 p-4 shadow-[0_6px_22px_rgba(0,0,0,.45)]"
      >
        {children}
      </div>
    </div>
  )
}
```

Create `apps/web/src/components/ui/Drawer.tsx` — the same contract in the right-hand `<aside>` the
five existing drawers already use (`w-[520px] max-w-full ... border-l border-line bg-bg-1 p-5`), so
adopting it moves nothing:

```tsx
'use client'

import { useModalDismiss } from './useModalDismiss'

/**
 * The right-hand drawer (M44 R3), with the same keyboard contract as `Dialog`. Its geometry is the
 * one the five existing drawers already shared, so adopting it in Task 4 changes no pixel.
 */
export function Drawer({
  open,
  onClose,
  label,
  testId,
  width = 'w-[520px]',
  dismissible = true,
  children,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly label: string
  readonly testId: string
  readonly width?: string
  readonly dismissible?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element | null {
  const ref = useModalDismiss({ open, onClose, enabled: dismissible })
  if (!open) return null
  return (
    <div data-testid={`${testId}-backdrop`} className="fixed inset-0 z-40 flex justify-end bg-black/40">
      <aside
        ref={ref as React.RefObject<HTMLElement>}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid={testId}
        tabIndex={-1}
        className={`flex ${width} max-w-full flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-5 shadow-[0_6px_22px_rgba(0,0,0,.45)]`}
      >
        {children}
      </aside>
    </div>
  )
}
```

- [ ] **Step 6: Write `Tabs`, `PageShell`, `Alert`, `EmptyState`, `LoadingState`**

`apps/web/src/components/ui/Tabs.tsx`:

```tsx
import Link from 'next/link'
import type React from 'react'

export interface TabSpec {
  readonly id: string
  readonly label: string
  /** A live count beside the label (the project strip's active-task badge). */
  readonly badge?: React.ReactNode
  /** A route tab renders as a `<Link role="tab">`; without it the tab is a `<button>`. */
  readonly href?: string
}

const BASE = 'flex items-center gap-[6px] rounded-chip border px-3 py-1.5 text-xs font-medium transition-colors'
const ON = 'border-line bg-bg-2 text-text-1'
const OFF = 'border-transparent text-text-3 hover:text-text-2'

/**
 * The segmented tab strip (M44 R3), in the idiom `ProjectTabs` already used: `role="tablist"` with
 * `role="tab"`, `aria-selected` and `aria-current="page"` on the live one. Four surfaces share it
 * now -- the project strip, Workforce, the Graph mode nav (which had plain buttons and an
 * `aria-current`, and a comment saying no shared component covered it) and the simulation tabs.
 *
 * It renders the CONTROLS, never the panels: every consumer here already owns its own content
 * switch, and a `role="tabpanel"` wrapper this component cannot see inside would only be a second
 * place for the two to disagree.
 */
export function Tabs({
  tabs,
  current,
  ariaLabel,
  testIdPrefix,
  onSelect,
  disabledIds = [],
}: {
  readonly tabs: readonly TabSpec[]
  readonly current: string
  readonly ariaLabel: string
  readonly testIdPrefix: string
  readonly onSelect?: (id: string) => void
  readonly disabledIds?: readonly string[]
}): React.JSX.Element {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex gap-1">
      {tabs.map((tab) => {
        const live = tab.id === current
        const className = `${BASE} ${live ? ON : OFF}`
        const badge =
          tab.badge === undefined ? null : (
            <span data-testid={`${testIdPrefix}-badge-${tab.id}`} className="font-mono text-[9.5px] font-medium text-text-faint">
              {tab.badge}
            </span>
          )
        if (tab.href !== undefined) {
          return (
            <Link
              key={tab.id}
              role="tab"
              data-testid={`${testIdPrefix}-${tab.id}`}
              href={tab.href}
              aria-selected={live}
              aria-current={live ? 'page' : undefined}
              className={className}
            >
              {tab.label}
              {badge}
            </Link>
          )
        }
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-testid={`${testIdPrefix}-${tab.id}`}
            aria-selected={live}
            aria-current={live ? 'page' : undefined}
            disabled={disabledIds.includes(tab.id)}
            onClick={() => onSelect?.(tab.id)}
            className={`${className} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {tab.label}
            {badge}
          </button>
        )
      })}
    </div>
  )
}
```

`apps/web/src/components/ui/PageShell.tsx`:

```tsx
import type React from 'react'
import { SectionLabel } from './SectionLabel'

/**
 * The one page frame (M44 R3): the same gutters, the same title row and the same tabs slot on
 * every page, so a new surface does not have to guess at them. `md:` is the only breakpoint --
 * below it the gutters tighten and the title row wraps (M44 R6).
 *
 * It owns the FRAME, never the content: no page's panels move into it, and it fetches nothing.
 */
export function PageShell({
  title,
  action,
  tabs,
  testId = 'page-shell',
  children,
}: {
  readonly title?: string
  readonly action?: React.ReactNode
  readonly tabs?: React.ReactNode
  readonly testId?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-testid={testId} className="flex min-w-0 flex-1 flex-col gap-4 p-3 md:p-4">
      {(title !== undefined || action !== undefined) && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {title === undefined ? <span /> : <SectionLabel>{title}</SectionLabel>}
          {action}
        </div>
      )}
      {tabs}
      {children}
    </div>
  )
}
```

`apps/web/src/components/ui/Alert.tsx`:

```tsx
import type React from 'react'

/**
 * The full-width band (M44 R3): the shape `OverviewClient`, `TasksClient` and `GraphClient` each
 * hand-rolled for "showing stale data", each with its own class string and a comment saying no
 * `ui/` component covered it.
 *
 * NOT a replacement for the ~50 inline `role="alert"` refusal sentences under forms -- those are
 * one consistent convention already, and rewriting them was never the point (plan erratum E21).
 * `HaltBanner` also keeps its own component: four gates key off it by name.
 */
const SURFACE = {
  error: 'border-tone-blocked/40 bg-tone-blocked/10 text-tone-blocked',
  notice: 'border-tone-waiting/40 bg-tone-waiting/10 text-tone-waiting',
  success: 'border-tone-done/40 bg-tone-done/10 text-tone-done',
} as const

export function Alert({
  variant,
  testId,
  children,
}: {
  readonly variant: 'error' | 'notice' | 'success'
  readonly testId?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role="alert"
      data-variant={variant}
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className={`border-b px-4 py-1.5 text-xs ${SURFACE[variant]}`}
    >
      {children}
    </div>
  )
}
```

`apps/web/src/components/ui/EmptyState.tsx` and `LoadingState.tsx`:

```tsx
import type React from 'react'

/** "There is nothing here", said the same way everywhere (M44 R3). One sentence, optionally one
 *  action -- never an illustration and never an invented next step. */
export function EmptyState({
  message,
  action,
  testId,
}: {
  readonly message: string
  readonly action?: React.ReactNode
  readonly testId: string
}): React.JSX.Element {
  return (
    <div data-testid={testId} className="flex flex-col items-start gap-2 py-2 text-xs text-text-3">
      <span>{message}</span>
      {action}
    </div>
  )
}
```

```tsx
/** "This is on its way" (M44 R3). `role="status"` + `aria-live="polite"`, NOT `role="alert"`: a
 *  screen reader should not be interrupted because a panel is fetching. */
export function LoadingState({
  message = 'loading…',
  testId,
}: {
  readonly message?: string
  readonly testId: string
}): React.JSX.Element {
  return (
    <div role="status" aria-live="polite" data-testid={testId} className="py-2 text-xs text-text-3">
      {message}
    </div>
  )
}
```

- [ ] **Step 7: Widen `DangerConfirm` (erratum E12)**

In `apps/web/src/components/ui/DangerConfirm.tsx`: import `Button` instead of `PrimaryButton`, add
the `title` prop, and replace the `useEffect` + open branch so the component focuses its confirm,
restores focus to the trigger after Escape, and announces itself as an `alertdialog`. The
trigger-refocus has to defer past the trigger's own unmount — the reason is
`EmergencyStopButton.tsx:27-31`'s comment, and this is where that idiom now lives:

```tsx
  const triggerRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const refocusTriggerRef = useRef(false)

  useEffect(() => {
    if (!open) return
    confirmRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || pending) return
      // The idle trigger is UNMOUNTED while this is asking, so `triggerRef.current` is already
      // null here. The flag defers the intent to the effect below, which runs once the trigger has
      // remounted and re-attached its ref (the idiom `EmergencyStopButton` documented before M44
      // moved it here).
      refocusTriggerRef.current = true
      setOpen(false)
      setErrorText(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, pending])

  useEffect(() => {
    if (open || !refocusTriggerRef.current) return
    refocusTriggerRef.current = false
    triggerRef.current?.focus()
  }, [open])
```

the idle branch:

```tsx
  if (!open) {
    return (
      <Button
        ref={triggerRef}
        variant="danger"
        size="sm"
        data-testid={testId}
        disabled={disabled}
        {...(title === undefined ? {} : { title })}
        onClick={() => setOpen(true)}
        className={className}
      >
        {label}
      </Button>
    )
  }
```

and the open branch's wrapper:

```tsx
    <span role="alertdialog" aria-label={`confirm ${label}`} className={`flex flex-wrap items-center gap-2 ${className}`.trim()}>
      <Button ref={confirmRef} variant="danger" size="sm" data-testid={`${testId}-confirm`} disabled={pending} onClick={() => void confirm()}>
        {pending ? 'working…' : confirmText}
      </Button>
```

`Button` must therefore forward a ref. Change its signature to
`export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ ... }, ref) { ... })`
with `ref={ref}` on the `<button>` and `Button.displayName = 'Button'` — `ProjectsClient.tsx:61`
already carries a comment about wrapping `Button` in a div precisely because it is not a
`forwardRef`; Task 4 deletes that wrapper.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npx vitest run apps/web/test/ui-modals.test.tsx apps/web/test/ui-tabs.test.tsx apps/web/test/ui-components.test.tsx apps/web/test/form-controls.test.tsx apps/web/test/danger-confirm.test.tsx
```
Expected: PASS. Then the whole web unit suite, because 35 aliased buttons just changed component:

```bash
npx vitest run --project unit apps/web
```
Expected: PASS. A failure here is a test asserting a class string that the alias fold changed — fix
the assertion to the new one and say which in the task report; do NOT reintroduce the old class.

- [ ] **Step 9: The task's own gates**

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
pgrep -af "next dev"
```
If `next dev` is running, `kill <pid>` and **say so in the task report**. Then:

```bash
npm run web:build
```
Expected: green. Restarting dev afterwards needs `rm -rf apps/web/.next` first.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/ui apps/web/src/app/globals.css apps/web/test/ui-modals.test.tsx \
        apps/web/test/ui-tabs.test.tsx apps/web/test/ui-components.test.tsx \
        apps/web/test/form-controls.test.tsx apps/web/test/danger-confirm.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): m44 t2 -- one page frame, one button, and a modal that owns its keyboard

components/ui grows what R3 asks for: PageShell, Tabs (role=tablist, URL- or state-backed),
Dialog and Drawer over a shared useModalDismiss, Alert, EmptyState and LoadingState. Nine
components each had their own Escape listener, no drawer trapped Tab at all, and only
EmergencyStopButton restored focus to its trigger -- in a comment rather than in shared code. That
contract is written once now, and tested: Tab wraps at both ends, Escape is ignored while a request
is in flight, and focus goes back to whatever opened the thing.

The second button system is gone. Button takes primary | ghost | danger and md | sm, where sm IS
the geometry FormControls' GhostButton/PrimaryButton carried, so the thirty-five call sites did not
move; those two stay as aliases until Task 4 migrates the calls. The one deliberate visual change:
primary and danger fills take StatusPill's own 1a/3d alphas instead of FormControls' drifted 15/40.

Card gains className, testId and data attributes -- the three things SlaveCard's docblock names as
the reason it is not a Card. The card DOMs do NOT converge here: SlaveCard's padding 12px 13px and
radius 8px are gate:m14-fidelity assertions and design README numbers, and this milestone freezes
them.

globals.css gains a token for every colour and radius that was a literal, under the handoff's own
names -- text strong/body/secondary/dim/ghost, the selected/card-alt/canvas/floor surfaces, two more
hairlines, and the 2px and 14px radii that had no token at all.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 3: Navigation, Workforce, the Projects home — and `docs/ia.md` (R1/R2/R7)

**Files:**
- Create: `apps/web/src/app/workforce/page.tsx`, `apps/web/src/components/workforce/WorkforceClient.tsx`, `apps/web/src/components/analytics/KpiStrip.tsx`, `docs/ia.md`
- Create: `apps/web/test/workforce-page.test.tsx`
- Delete: `apps/web/src/app/slaves/page.tsx`, `apps/web/src/app/skills/page.tsx`, `apps/web/src/components/SlavesClient.tsx`, `apps/web/test/slaves-page.test.tsx`
- Modify: `apps/web/next.config.ts`, `apps/web/src/app/layout.tsx`, `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/project/ProjectTabs.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/components/ProjectsClient.tsx`, `apps/web/src/components/AnalyticsClient.tsx`, `apps/web/src/server/org.ts`, `apps/web/src/components/{OverviewClient,TasksClient}.tsx` and `apps/web/src/app/login/page.tsx` + the six `app/w/[workspaceId]/**/page.tsx` fallbacks (erratum E16: `<main>` → `<div>`)
- Test: `apps/web/test/shell.test.tsx`, `apps/web/test/project-tabs.test.tsx`, `apps/web/test/projects-page.test.tsx`, `apps/web/test/skills-page.test.tsx` (import path only), `apps/web/test/integration/server-org.test.ts`

**Interfaces:**
- Consumes from Task 1: `userWorkspaceStatus`, `userTaskStatus`, `USER_WORKSPACE_LABEL`. From Task 2: `PageShell`, `Tabs`, `Button`.
- Produces (Tasks 4 and 5 rely on these):
```ts
// apps/web/src/server/org.ts — ProjectRow gains one field
readonly needsYou: number
// apps/web/src/components/workforce/WorkforceClient.tsx
export type WorkforceTab = 'slaves' | 'departments' | 'catalog' | 'skills'
export const WORKFORCE_TABS: readonly { readonly id: WorkforceTab; readonly label: string }[]
export function WorkforceClient(props: { … }): React.JSX.Element
// apps/web/src/components/analytics/KpiStrip.tsx
export function KpiStrip(props: { readonly kpis: readonly Kpi[] }): React.JSX.Element
// testids other tasks and the gates depend on
'nav-row' (data-nav: Projects | Workforce | Simulations | Settings), 'skip-link',
'workforce-tab-slaves' | '-departments' | '-catalog' | '-skills',
'project-tab-overview' | '-tasks' | '-activity' | '-settings',
'project-advanced' (the menu trigger), 'advanced-item-graph', 'advanced-item-office',
'kpi-strip', 'kpi-tile', 'all-projects-analytics', 'project-needs-you'
```

- [ ] **Step 1: Write the failing navigation tests**

Rewrite the first `describe` of `apps/web/test/shell.test.tsx`:

```tsx
describe('the shell', () => {
  afterEach(() => {
    pathname = '/w/w1'
  })

  it('renders the four global rows in order: Projects, Workforce, Simulations, Settings (M44 R1)', () => {
    render(<Sidebar />)
    const labels = screen.getAllByTestId('nav-row').map((row) => row.getAttribute('data-nav'))
    expect(labels).toEqual(['Projects', 'Workforce', 'Simulations', 'Settings'])
    expect(navRow('Workforce').getAttribute('href')).toBe('/workforce')
    expect(navRow('Simulations').getAttribute('href')).toBe('/sim')
    expect(navRow('Settings').getAttribute('href')).toBe('/settings')
  })

  it('has no Slaves, Skills or Analytics row -- they are a Workforce tab, a Workforce tab and a Projects section now', () => {
    render(<Sidebar />)
    const labels = screen.getAllByTestId('nav-row').map((row) => row.getAttribute('data-nav'))
    expect(labels).not.toContain('Slaves')
    expect(labels).not.toContain('Skills')
    expect(labels).not.toContain('Analytics')
  })

  it('marks Workforce current on /workforce and on the routes that redirect into it', () => {
    pathname = '/workforce'
    const { rerender } = render(<Sidebar />)
    expect(navRow('Workforce')).toHaveProperty('ariaCurrent', 'page')
    pathname = '/slaves'
    rerender(<Sidebar />)
    expect(navRow('Workforce')).toHaveProperty('ariaCurrent', 'page')
    pathname = '/skills'
    rerender(<Sidebar />)
    expect(navRow('Workforce')).toHaveProperty('ariaCurrent', 'page')
  })

  it('marks Projects current on /, on /w/:id/... and on /analytics -- analytics is a Projects fact', () => {
    pathname = '/'
    const { rerender } = render(<Sidebar />)
    expect(navRow('Projects')).toHaveProperty('ariaCurrent', 'page')
    pathname = '/w/w1/tasks'
    rerender(<Sidebar />)
    expect(navRow('Projects')).toHaveProperty('ariaCurrent', 'page')
    pathname = '/analytics'
    rerender(<Sidebar />)
    expect(navRow('Projects')).toHaveProperty('ariaCurrent', 'page')
  })

  it('is 212px wide at full width and collapses to a 52px icon rail below 900px (M44 R3/R6)', () => {
    render(<Sidebar />)
    // Class strings, not computed style: jsdom loads no CSS. gate:m44-ux-foundation reads the real
    // widths back at 1440px and at 800px.
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    expect(nav.className).toContain('w-[212px]')
    expect(nav.className).toContain('max-[899px]:w-[52px]')
  })

  it('gives every row an accessible name that survives the collapse', () => {
    render(<Sidebar />)
    expect(navRow('Workforce').getAttribute('aria-label')).toBe('Workforce')
    expect(navRow('Workforce').getAttribute('title')).toBe('Workforce')
    // The collapsed rail shows one letter; the full label is hidden below 900px, not deleted.
    expect(navRow('Workforce').textContent).toContain('Workforce')
  })

  it('puts a skip link first, before the nav, pointing at the one main landmark', () => {
    render(<Sidebar />)
    const skip = screen.getByTestId('skip-link')
    expect(skip.getAttribute('href')).toBe('#main')
    expect(skip.textContent).toBe('Skip to content')
    expect(skip.compareDocumentPosition(screen.getByRole('navigation', { name: 'Primary' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('renders nothing on /login -- the shell is a logged-in surface', () => {
    pathname = '/login'
    const { container } = render(<Sidebar />)
    expect(container.innerHTML).toBe('')
  })
})
```

Keep the file's remaining cases (`the selected row…` with `bg-[#151a21]` rewritten to
`bg-bg-selected`, `renders no project section…`, and the halt-banner describe) unchanged.

Rewrite `apps/web/test/project-tabs.test.tsx`'s tab list and add the Advanced menu:

```tsx
const TAB_HREFS = ['/w/w1', '/w/w1/tasks', '/w/w1/activity', '/w/w1/settings']

describe('ProjectTabs', () => {
  it('renders the four tabs in order with their hrefs (M44 R2)', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={2} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, '').trim())).toEqual(['Overview', 'Tasks', 'Activity', 'Settings'])
    expect(tabs.map((t) => t.getAttribute('href'))).toEqual(TAB_HREFS)
  })

  it('keeps Graph and Office reachable under Advanced, with their routes unchanged', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.queryByTestId('advanced-item-graph')).toBeNull()
    fireEvent.click(screen.getByTestId('project-advanced'))
    expect(screen.getByTestId('project-advanced').getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('advanced-item-graph').getAttribute('href')).toBe('/w/w1/graph')
    expect(screen.getByTestId('advanced-item-office').getAttribute('href')).toBe('/w/w1/office')
    expect(screen.getByRole('menu').getAttribute('aria-label')).toBe('Advanced')
  })

  it('closes the Advanced menu on Escape and gives focus back to its trigger', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    fireEvent.click(screen.getByTestId('project-advanced'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('advanced-item-graph')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('project-advanced'))
  })

  it('marks Advanced current while a Graph or Office route is open, so the strip never looks empty', () => {
    pathname = '/w/w1/graph'
    const { rerender } = render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-advanced').getAttribute('aria-current')).toBe('page')
    pathname = '/w/w1/office'
    rerender(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-advanced').getAttribute('aria-current')).toBe('page')
    pathname = '/w/w1/tasks'
    rerender(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-advanced').getAttribute('aria-current')).toBeNull()
  })

  it('marks Overview current only on the exact route', () => {
    pathname = '/w/w1'
    render(<ProjectTabs workspaceId="w1" initialTasksActive={0} />)
    expect(screen.getByTestId('project-tab-overview').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('project-tab-tasks').getAttribute('aria-current')).toBeNull()
  })

  it('carries the active-task badge on Tasks only, from the initial value and then from publications', () => {
    // (unchanged from before M44 -- the badge is the one live number in the strip)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
npx vitest run apps/web/test/shell.test.tsx apps/web/test/project-tabs.test.tsx
```
Expected: FAIL — six nav rows, six tabs, no skip link, no Advanced menu.

- [ ] **Step 3: Rebuild the sidebar (R1/R6)**

Replace `ROWS` and the `Sidebar` body in `apps/web/src/components/Sidebar.tsx`:

```tsx
/** The four global pages (M44 R1). Slaves and Skills became Workforce TABS; Analytics' route stays
 *  (bookmarks, and gate:m14-fidelity screenshots it) but its all-workspaces view is a section on
 *  the Projects home now and its per-workspace view is reached from the project. Nothing was
 *  removed -- `docs/ia.md` names where each one went. */
const ROWS = [
  { label: 'Projects', href: '/' },
  { label: 'Workforce', href: '/workforce' },
  { label: 'Simulations', href: '/sim' },
  { label: 'Settings', href: '/settings' },
] as const

function NavRow({ label, href, current }: { readonly label: string; readonly href: string; readonly current: boolean }): React.JSX.Element {
  return (
    <Link
      data-testid="nav-row"
      data-nav={label}
      href={href}
      aria-label={label}
      title={label}
      aria-current={current ? 'page' : undefined}
      className={`flex items-center gap-2 rounded-nav px-[9px] py-[7px] text-[12.5px] transition-colors max-[899px]:justify-center max-[899px]:px-0 ${
        current
          ? 'bg-bg-selected font-medium text-text-1 shadow-[inset_2px_0_0_var(--color-tone-working)]'
          : 'text-text-2 hover:bg-white/[0.045] hover:text-text-1'
      }`}
    >
      {/* The collapsed rail's glyph. The handoff ships no icon font and no images -- "every glyph
        * is text" -- so the initial IS the icon, and the row's `aria-label`/`title` carry the word
        * a screen reader and a hover need. */}
      <span aria-hidden className="hidden font-mono text-[12.5px] max-[899px]:inline">{label.slice(0, 1)}</span>
      <span className="max-[899px]:hidden">{label}</span>
    </Link>
  )
}

export function Sidebar(): React.JSX.Element | null {
  const pathname = usePathname()
  if (pathname === '/login') return null
  const isCurrent = (href: string): boolean => {
    // A project page IS a Projects page opened, and so is the analytics view of one.
    if (href === '/') return pathname === '/' || pathname.startsWith('/w/') || pathname.startsWith('/analytics')
    // `/slaves` and `/skills` are 307s to `/workforce` (next.config.ts). The two paths are listed
    // anyway: a soft navigation renders this component against the OLD pathname for one frame, and
    // a nav row that blinks off during a redirect is a nav row that looks broken.
    if (href === '/workforce') return pathname === '/workforce' || pathname === '/slaves' || pathname === '/skills'
    if (href === '/sim') return pathname === '/sim' || pathname.startsWith('/sim/')
    return pathname === href
  }
  return (
    <>
      {/* The first focusable thing in the document (M44 R6). Off-screen until it has focus, which
        * is the only time it means anything. */}
      <a
        data-testid="skip-link"
        href="#main"
        className="sr-only rounded-chip border border-line bg-bg-2 px-3 py-1.5 text-xs text-text-1 focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        Skip to content
      </a>
      <nav
        aria-label="Primary"
        className="flex w-[212px] shrink-0 flex-col border-r border-line bg-bg-1 px-[8px] py-[10px] max-[899px]:w-[52px] max-[899px]:px-[6px]"
      >
        <div className="flex flex-col gap-px">
          {ROWS.map((row) => (
            <NavRow key={row.label} label={row.label} href={row.href} current={isCurrent(row.href)} />
          ))}
        </div>
      </nav>
    </>
  )
}
```

- [ ] **Step 4: Give the skip link one target (erratum E16)**

In `apps/web/src/app/layout.tsx`, the content wrapper becomes the document's only main landmark:

```tsx
      <body className="flex min-h-screen">
        <Sidebar />
        {/* The one `main` landmark, and the skip link's target (M44 R6). `tabIndex={-1}` so the
          * anchor can actually move focus here -- a `<main>` is not focusable by default, and a
          * skip link that only scrolls has moved the viewport and not the keyboard. */}
        <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col focus:outline-none">
          {children}
        </main>
      </body>
```

Then change the nine inner `<main>` elements to `<div>` so the document has exactly one:
`apps/web/src/components/OverviewClient.tsx:244`, `apps/web/src/components/TasksClient.tsx:52`,
`apps/web/src/app/login/page.tsx:19`, and the six `no project with id` fallbacks in
`app/w/[workspaceId]/{page,tasks/page,graph/page,office/page,activity/page,settings/page}.tsx`.
Class names and children are unchanged in all nine.

- [ ] **Step 5: The project tab strip and the Advanced menu (R2/E23)**

Rewrite `apps/web/src/components/project/ProjectTabs.tsx`. The menu copies `ProjectSwitcher`'s
idiom, which is in the same header (erratum E22) — a menu is not a modal, so it keeps its own
Escape and its own trigger-refocus:

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { Tabs, type TabSpec } from '../ui/Tabs'
import { useShellFacts } from '../../hooks/useShellFacts'

/** The four tabs a person needs to answer "what is happening" (M44 R2). Overview matches its route
 *  exactly (it is the prefix of every other tab); the rest match by prefix, so a filter in the
 *  query string still lights its tab. */
const TABS = [
  { id: 'overview', label: 'Overview', path: (id: string) => `/w/${id}`, exact: true },
  { id: 'tasks', label: 'Tasks', path: (id: string) => `/w/${id}/tasks`, exact: false },
  { id: 'activity', label: 'Activity', path: (id: string) => `/w/${id}/activity`, exact: false },
  { id: 'settings', label: 'Settings', path: (id: string) => `/w/${id}/settings`, exact: false },
] as const

/** Graph and Office. COMPLETE and reachable -- by this menu and by their unchanged URLs. They left
 *  the strip because a normal user does not need five graph modes or a pixel office to find out
 *  what the project is doing, not because anything was taken away (`docs/ia.md`). */
const ADVANCED = [
  { id: 'graph', label: 'Graph', path: (id: string) => `/w/${id}/graph` },
  { id: 'office', label: 'Office', path: (id: string) => `/w/${id}/office` },
] as const

export function ProjectTabs({
  workspaceId,
  initialTasksActive,
}: {
  readonly workspaceId: string
  readonly initialTasksActive: number
}): React.JSX.Element {
  const pathname = usePathname()
  const facts = useShellFacts(workspaceId)
  const tasksActive = facts?.counts.tasksActive ?? initialTasksActive
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const isLive = (path: string, exact: boolean): boolean =>
    exact ? pathname === path : pathname === path || pathname.startsWith(`${path}/`)
  const current = TABS.find((tab) => isLive(tab.path(workspaceId), tab.exact))?.id ?? ''
  const advancedLive = ADVANCED.some((item) => isLive(item.path(workspaceId), false))

  const tabs: readonly TabSpec[] = TABS.map((tab) => ({
    id: tab.id,
    label: tab.label,
    href: tab.path(workspaceId),
    ...(tab.id === 'tasks' ? { badge: tasksActive } : {}),
  }))

  return (
    <div className="relative flex items-center gap-1 border-b border-line bg-bg-1 px-4 py-[6px]">
      <Tabs tabs={tabs} current={current} ariaLabel="Project" testIdPrefix="project-tab" />
      <button
        ref={triggerRef}
        type="button"
        data-testid="project-advanced"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-current={advancedLive ? 'page' : undefined}
        onClick={() => setOpen((was) => !was)}
        className={`flex items-center gap-[6px] rounded-chip border px-3 py-1.5 text-xs font-medium transition-colors ${
          advancedLive ? 'border-line bg-bg-2 text-text-1' : 'border-transparent text-text-3 hover:text-text-2'
        }`}
      >
        Advanced
        <span aria-hidden>▾</span>
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Advanced"
          className="absolute right-4 top-[38px] z-30 flex min-w-[160px] flex-col rounded-panel border border-line bg-bg-1 p-1 shadow-resting"
        >
          {ADVANCED.map((item) => (
            <Link
              key={item.id}
              role="menuitem"
              data-testid={`advanced-item-${item.id}`}
              href={item.path(workspaceId)}
              aria-current={isLive(item.path(workspaceId), false) ? 'page' : undefined}
              onClick={() => setOpen(false)}
              className="rounded-nav px-2 py-1.5 text-xs text-text-2 hover:bg-white/[0.045] hover:text-text-1"
            >
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Build `/workforce` and delete what it replaces (R1/D1/D2)**

Create `apps/web/src/app/workforce/page.tsx` — the union of what `app/slaves/page.tsx`,
`app/skills/page.tsx` and the Projects home's catalog section each loaded:

```tsx
import { listAllSlaves, listCatalogImports, listCompanies, listProjectTeams, listRoster, listTemplates, listWorkspaceNames } from '../../server/org'
import { buildSkillsPage } from '../../server/skills'
import { WorkforceClient, type WorkforceTab } from '../../components/workforce/WorkforceClient'

export const dynamic = 'force-dynamic'

const TAB_IDS: readonly WorkforceTab[] = ['slaves', 'departments', 'catalog', 'skills']

/**
 * The people (M44 R1): every slave, the departments they sit on, the catalog they are made from,
 * and the skills they are given -- four tabs on one page instead of two sidebar rows and a section
 * on the Projects home. `/slaves` and `/skills` are 307s into it (`next.config.ts`).
 *
 * The tab is in the URL (`?tab=`), the way the Graph page keeps its mode, so `/skills` can redirect
 * to a tab and a reload or a shared link keeps it. An unknown value falls back to `slaves` rather
 * than rendering an empty page.
 */
export default async function WorkforcePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly tab?: string }>
}): Promise<React.JSX.Element> {
  const { tab } = await searchParams
  const [slaves, teams, workspaces, companies, roster, templates, catalogImports, skills] = await Promise.all([
    listAllSlaves(),
    listProjectTeams(),
    listWorkspaceNames(),
    listCompanies(),
    listRoster(),
    listTemplates(),
    listCatalogImports(),
    buildSkillsPage(),
  ])
  const initialTab = TAB_IDS.find((id) => id === tab) ?? 'slaves'
  return (
    <WorkforceClient
      initialTab={initialTab}
      slaves={slaves}
      teams={teams}
      workspaces={workspaces}
      companies={companies}
      roster={roster}
      templates={templates}
      catalogImports={catalogImports}
      skills={skills}
    />
  )
}
```

Create `apps/web/src/components/workforce/WorkforceClient.tsx`. It is `SlavesClient.tsx`'s body
with two more tabs — the panels are MOVED, not rewritten (`AllSlavesTable`, `DepartmentsTable`,
`NewSlaveDrawer`, `SlavePanel`, `TemplateCatalog`, `CompanyManager`, `CatalogImports` and
`SkillsClient` are all rendered exactly as they are today):

```tsx
'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { AllSlavesPage, CompanyRow, ProjectTeamRow, RosterCompany } from '../../server/org'
import type { CatalogImportRow } from '../CatalogImports'
import type { SkillsPage } from '../../server/skills'
import type { TemplateRow } from '../TemplateCatalog'
import { AllSlavesTable } from '../AllSlavesTable'
import { CatalogImports } from '../CatalogImports'
import { CompanyManager } from '../CompanyManager'
import { DepartmentsTable } from '../DepartmentsTable'
import { SkillsClient } from '../SkillsClient'
import { SlavePanel } from '../SlavePanel'
import { TemplateCatalog } from '../TemplateCatalog'
import { NewSlaveDrawer } from '../slaves/NewSlaveDrawer'
import { Button } from '../ui/Button'
import { PageShell } from '../ui/PageShell'
import { Panel } from '../ui/Panel'
import { Tabs } from '../ui/Tabs'

export type WorkforceTab = 'slaves' | 'departments' | 'catalog' | 'skills'

export const WORKFORCE_TABS: readonly { readonly id: WorkforceTab; readonly label: string }[] = [
  { id: 'slaves', label: 'Slaves' },
  { id: 'departments', label: 'Departments' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'skills', label: 'Skills' },
]

/**
 * The Workforce page (M44 R1). Four tabs, and every panel on them is the one that was already
 * there: this milestone MOVES surfaces, it does not rewrite them (R5, and the roadmap's "extend,
 * do not rewrite"). What changed is where a person finds them -- four surfaces for "a slave" used
 * to be a sidebar row, another sidebar row, a section on the Projects home and a panel inside a
 * project.
 *
 * The tab lives in `?tab=`, pushed with `router.replace` so a tab change does not stack history
 * entries a Back press has to walk through.
 */
export function WorkforceClient({
  initialTab,
  slaves,
  teams,
  workspaces,
  companies,
  roster,
  templates,
  catalogImports,
  skills,
}: {
  readonly initialTab: WorkforceTab
  readonly slaves: AllSlavesPage
  readonly teams: readonly ProjectTeamRow[]
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
  readonly companies: readonly CompanyRow[]
  readonly roster: readonly RosterCompany[]
  readonly templates: readonly TemplateRow[]
  readonly catalogImports: readonly CatalogImportRow[]
  readonly skills: SkillsPage
}): React.JSX.Element {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [tab, setTab] = useState<WorkforceTab>(initialTab)
  const [newOpen, setNewOpen] = useState(false)
  const [selected, setSelected] = useState<{ readonly slaveId: string; readonly workspaceId: string } | null>(null)

  const select = (next: WorkforceTab): void => {
    setTab(next)
    const query = new URLSearchParams(searchParams)
    query.set('tab', next)
    router.replace(`/workforce?${query.toString()}`)
  }

  return (
    <PageShell
      title="Workforce"
      testId="workforce"
      action={
        tab === 'slaves' ? (
          <Button variant="primary" data-testid="new-slave-open" onClick={() => setNewOpen(true)}>
            + New slave
          </Button>
        ) : undefined
      }
      tabs={<Tabs tabs={WORKFORCE_TABS} current={tab} ariaLabel="Workforce" testIdPrefix="workforce-tab" onSelect={(id) => select(id as WorkforceTab)} />}
    >
      {tab === 'slaves' && <AllSlavesTable initial={slaves} onOpen={setSelected} />}
      {tab === 'departments' && <DepartmentsTable teams={teams} workspaces={workspaces} />}
      {tab === 'catalog' && (
        <div className="flex flex-col gap-4">
          <Panel title="Template catalog">
            <TemplateCatalog templates={templates} />
          </Panel>
          <Panel title="Companies">
            <CompanyManager companies={companies} roster={roster} templates={templates} />
          </Panel>
          <Panel title="Catalog imports">
            <CatalogImports imports={catalogImports} />
          </Panel>
        </div>
      )}
      {tab === 'skills' && <SkillsClient page={skills} />}
      <NewSlaveDrawer
        open={newOpen}
        onClose={() => setNewOpen(false)}
        companies={companies}
        roster={roster}
        templates={templates}
        workspaces={workspaces}
      />
      {selected !== null && <SlavePanel slaveId={selected.slaveId} workspaceId={selected.workspaceId} onClose={() => setSelected(null)} />}
    </PageShell>
  )
}
```

**Read `SlavesClient.tsx` before writing this and copy its real prop lists** for `AllSlavesTable`,
`DepartmentsTable`, `NewSlaveDrawer` and `SlavePanel` — the shapes above are the ones that file
passes today, and a prop invented here is a typecheck failure, not a runtime surprise. Then delete
`apps/web/src/components/SlavesClient.tsx`, `apps/web/src/app/slaves/page.tsx` and
`apps/web/src/app/skills/page.tsx`.

- [ ] **Step 7: The redirects (E7)**

In `apps/web/next.config.ts`, add to the config object:

```ts
  // The first redirects in this repository (M44 R1). `/slaves` and `/skills` are two of the four
  // surfaces for "a slave" the M44 audit found; they are Workforce tabs now, and their old URLs
  // still work because a bookmark is a promise. `permanent: false` (307) deliberately: a 308 is
  // cached by the browser forever, and M45/M46 rearrange this page again.
  async redirects() {
    return [
      { source: '/slaves', destination: '/workforce', permanent: false },
      { source: '/skills', destination: '/workforce?tab=skills', permanent: false },
    ]
  },
```

- [ ] **Step 8: The Projects home gains analytics and loses the catalog (R1/E19/E20)**

Extract the KPI strip verbatim into `apps/web/src/components/analytics/KpiStrip.tsx`, keeping both
testids (`kpi-strip` is the section, `kpi-tile` is `gate:m14-fidelity`'s structural marker for
`/analytics`):

```tsx
import type { Kpi } from '../../server/analytics'

/** The six all-time KPI tiles. Extracted from `AnalyticsClient` in M44 so the Projects home can
 *  show the all-workspaces view without a second builder or a second tile recipe (R1). Both
 *  testids are unchanged -- `kpi-tile` is `gate:m14-fidelity`'s structural marker for /analytics. */
export function KpiStrip({ kpis }: { readonly kpis: readonly Kpi[] }): React.JSX.Element {
  return (
    <div data-testid="kpi-strip" className="grid grid-cols-2 gap-px overflow-hidden rounded-tile border border-line bg-line md:grid-cols-3 xl:grid-cols-6">
      {kpis.map((kpi) => (
        <div key={kpi.label} data-testid="kpi-tile" className="flex flex-col gap-1 bg-bg-1 p-[10px]">
          <span className="font-mono text-[10.5px] uppercase tracking-[.09em] text-text-3">{kpi.label}</span>
          <span className="font-mono text-[20px] font-semibold tracking-[-.8px] text-text-1">{kpi.value}</span>
          {kpi.note !== null && (
            <span data-testid={`kpi-note-${kpi.label}`} className="text-[9.5px] text-text-3">
              {kpi.note}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}
```

(`grid-cols-6` becomes a `xl:` step with 2-up and 3-up below it — R6's "page-level `md:` breakpoints
for the shell and the Workforce/Projects grids". At 1440px, `gate:m14-fidelity`'s viewport, `xl:`
is active and the strip is the six-up it has always been.)

`AnalyticsClient.tsx` replaces its inline strip with `<KpiStrip kpis={snapshot.kpis} />`.

In `apps/web/src/app/page.tsx`, load the all-workspaces snapshot alongside the rest:

```tsx
  const [projects, companies, analytics] = await Promise.all([
    listProjects({ includeArchived: archived === '1' }),
    listCompanies(),
    // The all-workspaces view (M44 R1): the SAME builder /analytics calls, with a null scope. The
    // template catalog, the company manager and the catalog-import log that used to load here have
    // moved to Workforce -> Catalog, so `listTemplates`/`listRoster`/`listCatalogImports` went
    // with them.
    buildAnalytics(null),
  ])
  return <ProjectsClient projects={projects} companies={companies} analytics={analytics} />
```

In `apps/web/src/components/ProjectsClient.tsx`: drop the `templates`/`roster`/`catalogImports`
props and the whole `data-testid="team-catalog"` section (with its four imports), take an
`analytics: AnalyticsSnapshot` prop, and render the section where the catalog used to be:

```tsx
      <section data-testid="all-projects-analytics" className="flex flex-col gap-4 px-[20px] pb-[20px]">
        <Panel title="across every project" action={<Link href="/analytics" className="text-[10px] text-text-3 hover:text-text-1">all →</Link>}>
          <KpiStrip kpis={analytics.kpis} />
        </Panel>
      </section>
```

and the project card's pill takes its word from the domain (Task 1), with the needs-you count
beside it:

```tsx
const WORKSPACE_TONE: Record<UserWorkspaceState, StatusTone> = {
  archived: 'idle',
  halted: 'blocked',
  needs_you: 'waiting',
  working: 'working',
  idle: 'idle',
}

// ...inside ProjectCard, replacing `statusOf` and `STATUS_LABEL`:
  const status = userWorkspaceStatus({
    archived: project.archived,
    halted: project.halted,
    needsYouCount: project.needsYou,
    tasksActive: project.taskCounts.active,
  })
  // ...
          <StatusPill tone={WORKSPACE_TONE[status.state]} label={status.label} pulse={status.state === 'working'} />
```

with, under the goal line:

```tsx
            {project.needsYou > 0 && (
              <span data-testid="project-needs-you" className="mt-[2px] block text-[11px] text-tone-waiting">
                {project.needsYou} {project.needsYou === 1 ? 'thing needs' : 'things need'} you
              </span>
            )}
```

- [ ] **Step 9: `ProjectRow.needsYou` (E19)**

In `apps/web/src/server/org.ts`, add `autoMerge: true` to `listProjects`'s workspace `select`, add
a `done`-and-not-integrated count beside the existing `countOf` calls, and add the field:

```ts
  /**
   * How many of this project's tasks need a PERSON before they move -- `userTaskStatus(...).needsYou`
   * (M44 R1/R4), counted here so the Projects home does not have to fetch a board per card.
   *
   * Two of the projection's three inputs are cheap counts this function already makes: `blocked`,
   * and `done` with `integratedAt: null` on a hand-merge project (`autoMerge === false`). The
   * third -- a `waiting` task whose question nobody can answer (M39's unanswerable case) -- is a
   * per-task join that is NOT made here; M45's needs-you queue is where a task-level read of this
   * belongs. `docs/ia.md` records the narrower definition so nobody reads this as a total.
   */
  readonly needsYou: number
```

```ts
    needsYou:
      countOf(workspace.id, ['blocked']) +
      (workspace.autoMerge ? 0 : unintegratedDoneOf(workspace.id)),
```

`unintegratedDoneOf` is a second `groupBy`/`count` over `Task` with
`{ workspaceId, status: 'done', integratedAt: null }`, built in the same pre-pass the existing
`countOf` map is built in — read that pre-pass and follow its shape rather than adding a query per
card.

- [ ] **Step 10: Write `docs/ia.md` (R7)**

The vocabulary gate scans this file (erratum E9): the word is **slave**, and it never quotes the
design handoff README.

````markdown
# Information architecture

What each surface is for, and where anything that left a main path went. Written in M44 from an
audit of every route, panel, control, token and test in `apps/web`; it is the contract M45–M56 read
before adding a surface.

## The rules

1. **Do not build a dashboard for everything.** A number belongs on the page where somebody can act
   on it. A new page needs a question no existing page answers.
2. **Nothing is removed, only moved.** Every capability below is still reachable — by a tab, by a
   menu, or by its own unchanged URL. This table is where you find out which.
3. **One vocabulary.** A status a person reads comes from `packages/domain/src/status/user.ts`. The
   raw value stays available — in `title`, in a `data-` attribute, or in the expanded view.
4. **Real is not simulated.** Simulations live under `/sim`, carry a SIMULATION chip, and their
   money is never shown beside model cost.
5. **Advanced is a promise, not a graveyard.** Anything under Advanced keeps working, keeps its
   tests and keeps its URL.

## Top-level navigation

| Entry | Route | The question it answers |
|---|---|---|
| Projects | `/` | What am I building, and what needs me? |
| Workforce | `/workforce` | Who works here, and what can they do? |
| Simulations | `/sim` | What would a company like this do? |
| Settings | `/settings` | How is this installation set up? |

## Global surfaces

| Route | User goal | Decision | M44 | Later |
|---|---|---|---|---|
| `/` | See every project and what needs me | keep | Project cards read one word from `userWorkspaceStatus` and carry a "needs you" count; the all-workspaces KPI strip moved in from `/analytics`; the team catalog moved out to Workforce → Catalog | M45 rewrites the project card around the Supervisor |
| `/workforce` | Everyone who works here | **new** | Four tabs: Slaves, Departments, Catalog, Skills — the panels are the existing ones, moved | M46 rebuilds Catalog around structured profiles; M47 adds capabilities |
| `/slaves` | — | **merged into** `/workforce` (Slaves tab) | 307 redirect | — |
| `/skills` | — | **merged into** `/workforce?tab=skills` | 307 redirect | — |
| `/analytics` | Spend and throughput | **demoted** from the sidebar, route kept | All-workspaces view is a section on `/`; per-workspace view is reached from a project; the URL and its `?workspace=` scope are unchanged and bookmarkable | M53 replaces the tiles with per-profile evidence |
| `/sim`, `/sim/:id`, `/sim/compare` | Try a company on synthetic data | unchanged | Status chips read words instead of enum values | — |
| `/settings` | Provider adapters, security, reset demo data | unchanged | Reseed uses the one destructive recipe | — |
| `/login` | Sign in | unchanged | — | — |

## Project surfaces (`/w/:id/…`)

| Route | User goal | Decision | M44 | Later |
|---|---|---|---|---|
| `/w/:id` Overview | What is happening right now | keep (tab 1) | Untouched content; the six leaks in its panels are closed | M45 rewrites it around the Supervisor |
| `/w/:id/tasks` Tasks | What work exists, in what state | keep (tab 2) | Untouched | M45 adds progressive disclosure |
| `/w/:id/activity` Activity | What happened, in order | keep (tab 3) | The event-type rail reads words; the raw prefix is on `data-prefix` and in `title` | — |
| `/w/:id/settings` Settings | Goal, runtime, permissions, danger | keep (tab 4) | Emergency stop uses the one destructive recipe | — |
| `/w/:id/graph` Graph | Five structural views of the project | **demoted to Advanced ▾** | Reachable from `Advanced ▾ → Graph` and by URL; all five modes intact; the mode nav is a real tablist now | M45 lifts the org mode's content into an Organization tab; Graph stays |
| `/w/:id/office` Office | The team as a pixel office | **demoted to Advanced ▾** | Reachable from `Advanced ▾ → Office` and by URL; the canvas gains a label and a text line saying what it shows | — |

## Panels that stay where they are, deliberately

- `SlavePanel`, `GraphDrawer` and `TaskDetailPanel` are persistent side panels, not modals: they do
  not close on Escape and do not trap focus, because a person reads them while working in the page
  behind them. `Dialog`/`Drawer` are for the six things that ARE modal.
- `HaltBanner` keeps its own component rather than becoming an `Alert`: four gates key off it.
- The Tasks board's pill keeps its board vocabulary in M44. `userTaskStatus` is the domain's task
  word and is wired to one thing here — the "needs you" count on a project card.

## What "needs you" counts, exactly

Today: tasks that are `blocked`, plus work that is `done` and not integrated on a project that does
not merge by itself. Not yet: a task waiting on a question nobody can answer — that needs a per-task
read, and it arrives with M45's needs-you queue. The number is honest about being a floor, and no
surface calls it a total.
````

- [ ] **Step 11: Update the tests that moved**

- `apps/web/test/slaves-page.test.tsx` → renamed `apps/web/test/workforce-page.test.tsx`: the same
  cases against `WorkforceClient`, with `screen.getAllByRole('tab').map((t) => t.textContent)`
  asserting `['Slaves', 'Departments', 'Catalog', 'Skills']`, `workforce-tab-slaves` selected by
  default, and two new cases — the Catalog tab renders `Template catalog` / `Companies` /
  `Catalog imports` panels, and `initialTab="skills"` renders the skills page's own testids.
  (`toneForStatus`'s seven cases moved to `tones.test.ts` in Task 1; do not duplicate them.)
- `apps/web/test/projects-page.test.tsx:372` — `expect(screen.getByTestId('team-catalog'))` becomes
  `expect(screen.queryByTestId('team-catalog')).toBeNull()` plus
  `expect(screen.getByTestId('all-projects-analytics')).toBeTruthy()` and a `kpi-tile` count; every
  render of `ProjectsClient` in that file takes the new prop set.
- `apps/web/test/skills-page.test.tsx` — import path only, if it imported through the page.
- `apps/web/test/integration/server-org.test.ts` — one case: a workspace with one `blocked` task and
  one un-integrated `done` task reports `needsYou: 2` when `autoMerge` is false and `1` when it is
  true.

- [ ] **Step 12: Run the suite**

```bash
npx vitest run --project unit apps/web
npx vitest run --project integration apps/web
```
Expected: PASS. Nothing else may be running vitest, and no daemon may be up (`subscribe.test.ts`).

- [ ] **Step 13: The task's own gates**

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
pgrep -af "next dev"
```
`gate:m26-vocabulary` runs FIRST here and specifically because `docs/ia.md` is new and tracked
(erratum E9) — `git add docs/ia.md` before running it, or the gate does not see the file at all.
If `next dev` is running, `kill <pid>` and **say so in the task report**, then:

```bash
npm run web:build
```
Expected: green, and a `/workforce` route in the build output with `/slaves` and `/skills` gone.

- [ ] **Step 14: Commit**

```bash
git add apps/web/src apps/web/test docs/ia.md apps/web/next.config.ts
git commit -m "$(cat <<'EOF'
feat(web),docs: m44 t3 -- four ways in, four project tabs, and one page for the people

The sidebar is Projects, Workforce, Simulations, Settings. Slaves and Skills were two of four
surfaces for the same idea; they are Workforce tabs now, beside Departments and the catalog that
used to sit under the project list. /slaves and /skills are 307s into them, so a bookmark still
works. Analytics leaves the sidebar and keeps its route: the all-workspaces view is a section on
the Projects home, built by the same builder with a null scope.

The project strip is Overview, Tasks, Activity, Settings, with Graph and Office under Advanced.
Both keep their URLs, all five graph modes and every test -- they left the strip because a person
does not need them to find out what a project is doing, not because anything was taken away.

A skip link is now the first focusable element in the document, and the root layout is its one main
landmark; nine nested `main` elements became `div`s so there is exactly one. The sidebar collapses
to a 52px rail below 900px, in CSS, with each row keeping the label a screen reader reads.

Project cards read one word from userWorkspaceStatus and say how many things need a person.
listProjects counts that honestly and narrowly -- blocked work, plus finished work nothing will
merge by itself -- and docs/ia.md says so, beside a table of every surface, what it is for, and
where anything that left a main path went.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 4: The call sites and the six leaks (R3/R5/R6)

**Files:**
- Modify (domain labels, erratum E6): `packages/domain/src/supervisor/situations.ts`, `packages/domain/src/supervisor/actions.ts`
- Modify (the six leaks, R5): `apps/web/src/components/AllSlavesTable.tsx`, `SlavePanel.tsx`, `activity/ActivityClient.tsx`, `SkillsClient.tsx`, `SupervisorPanel.tsx`, `sim/SimulationsClient.tsx`, `sim/SimulationClient.tsx`
- Modify (primitives, R3): `apps/web/src/components/EmergencyStopButton.tsx`, `DangerZone.tsx`, `AssignCompanyDialog.tsx`, `projects/NewProjectDrawer.tsx`, `slaves/NewSlaveDrawer.tsx`, `sim/{AdoptDrawer,CloneDrawer,NewSimulationDrawer}.tsx`, `OverviewClient.tsx`, `TasksClient.tsx`, `graph/GraphClient.tsx`, `ProjectsClient.tsx`, and the 22 files importing `GhostButton`/`PrimaryButton`
- Modify (R6): `apps/web/src/components/office/OfficeClient.tsx`
- Create: `packages/domain/test/supervisor/labels.test.ts`, `apps/web/src/lib/eventLabels.ts`
- Test: `apps/web/test/{all-slaves-table,slave-panel,activity-page,skills-page,supervisor-panel,simulations-page,simulation-page,settings-page,emergency-stop,graph-page,office-client,overview-components,tasks-components}.test.tsx`

**Interfaces:**
- Consumes from Task 1: `userSlaveStatus`, `USER_CARD_LABEL`. From Task 2: `Button`, `Dialog`, `Drawer`, `Alert`, `EmptyState`, `LoadingState`, `Tabs`, `DangerConfirm`. From Task 3: `Tabs`' testid convention.
- Produces:
```ts
// packages/domain/src/supervisor/situations.ts
export const SITUATION_LABEL: Record<SituationKind, string>
// packages/domain/src/supervisor/actions.ts
export const TIER_LABEL: Record<Tier, string>
export const DECISION_STATUS_LABEL: Record<DecisionStatus, string>
export const DECIDER_LABEL: Record<Decider, string>
// apps/web/src/lib/eventLabels.ts
export const EVENT_PREFIX_LABEL: Readonly<Record<string, string>>
export function eventPrefixLabel(prefix: string): string
// apps/web/src/lib/simulationLabels.ts
export const SIMULATION_STATUS_LABEL: Record<'ready'|'running'|'paused'|'finished'|'halted', string>
```

- [ ] **Step 1: Add the domain's missing label tables (erratum E6) and their test**

Append to `packages/domain/src/supervisor/situations.ts`:

```ts
/**
 * What each situation is called when a person reads it (M44 R5). `SITUATION_KINDS` are keys, and a
 * key rendered as prose is the leak M44 closes -- the Supervisor panel's recent-decision rows read
 * `no_reviewer · proposed · pending · by model`.
 *
 * `Record<SituationKind, string>` is load-bearing: a twelfth kind fails the build here rather than
 * turning up on the page as an identifier. Each label says what is STUCK, in the words the report
 * already uses; the decision's own `situation.summary` carries the specifics beside it.
 */
export const SITUATION_LABEL: Record<SituationKind, string> = {
  no_reviewer: 'No reviewer',
  no_planner: 'No planner',
  review_cap_blocked: 'Review attempts used up',
  task_failed: 'Task failed',
  task_blocked_human: 'Blocked, needs a person',
  stale_task: 'Work the goal no longer needs',
  waiting_stale: 'Waiting too long',
  unanswerable_question: 'Question nobody can answer',
  ready_unstaffed: 'Ready work, nobody to do it',
  done_not_integrated_stale: 'Finished, not integrated',
  workspace_halted: 'Project halted',
}
```

Append to `packages/domain/src/supervisor/actions.ts`:

```ts
/** What a tier means to a person (M44 R5): what actually happened to the chosen action. */
export const TIER_LABEL: Record<Tier, string> = {
  applied: 'Done',
  proposed: 'Waiting for you',
  escalated: 'Escalated to you',
  noop: 'Nothing to do',
}

/** A decision's life, in words. `pending` is the only OPEN state, and it is the one that says so. */
export const DECISION_STATUS_LABEL: Record<DecisionStatus, string> = {
  applied: 'Applied',
  pending: 'Waiting for you',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
  failed: 'Failed',
}

/** Who picked the candidate. */
export const DECIDER_LABEL: Record<Decider, string> = {
  model: 'the model',
  rules: 'the rules',
}
```

Create `packages/domain/test/supervisor/labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  DECIDERS,
  DECIDER_LABEL,
  DECISION_STATUSES,
  DECISION_STATUS_LABEL,
  SITUATION_KINDS,
  SITUATION_LABEL,
  TIERS,
  TIER_LABEL,
} from '../../src/index.js'

describe('every union a person reads has a label (M44 R5)', () => {
  it('covers every situation kind, with no key that is not one', () => {
    expect(Object.keys(SITUATION_LABEL).sort()).toEqual([...SITUATION_KINDS].sort())
    for (const kind of SITUATION_KINDS) {
      expect(SITUATION_LABEL[kind].length).toBeGreaterThan(0)
      // A label that is the key with the underscores taken out is not a label.
      expect(SITUATION_LABEL[kind]).not.toBe(kind.replace(/_/g, ' '))
    }
  })

  it('covers every tier, decision status and decider', () => {
    expect(Object.keys(TIER_LABEL).sort()).toEqual([...TIERS].sort())
    expect(Object.keys(DECISION_STATUS_LABEL).sort()).toEqual([...DECISION_STATUSES].sort())
    expect(Object.keys(DECIDER_LABEL).sort()).toEqual([...DECIDERS].sort())
  })

  it('never lets a label carry the underscore that gives an enum away', () => {
    for (const label of [...Object.values(SITUATION_LABEL), ...Object.values(TIER_LABEL), ...Object.values(DECISION_STATUS_LABEL)]) {
      expect(label).not.toContain('_')
    }
  })
})
```

- [ ] **Step 2: Write the failing leak tests**

One case per leak, in the file that already covers that surface. Each asserts the WORD a person
reads AND that the raw value is still available — that pair is the whole of R5.

`apps/web/test/all-slaves-table.test.tsx` (leak 1):

```tsx
  it('says PAUSING, not "pausing", and keeps the raw status where a person can still find it (M44 R5)', () => {
    render(<AllSlavesTable initial={page([row({ slaveId: 'a1', name: 'Alex', status: 'pausing' })])} onOpen={vi.fn()} />)
    const pill = screen.getAllByTestId('status-pill')[0]
    expect(pill?.textContent).toContain('PAUSING')
    expect(pill?.textContent).not.toContain('pausing')
    expect(pill?.getAttribute('title')).toBe('pausing')
    expect(pill?.getAttribute('data-tone')).toBe('paused')
  })
```

`apps/web/test/slave-panel.test.tsx` (leak 2) — replace the `:531` assertion:

```tsx
    expect(screen.getByTestId('status-label').textContent).toBe('WORKING')
    expect(screen.getByTestId('status-label').getAttribute('title')).toBe('working')
    expect(screen.getByTestId('status-label').getAttribute('data-status')).toBe('working')
```

`apps/web/test/activity-page.test.tsx` (leak 3) — beside the existing `data-prefix` case:

```tsx
  it('names each event kind instead of printing its prefix, and keeps the prefix on the node (M44 R5)', () => {
    render(<ActivityClient workspaceId="w1" initial={pageWith({ typeVolumes: [{ prefix: 'task.*', count: 9 }, { prefix: 'run.*', count: 4 }] })} />)
    const bars = screen.getAllByTestId('volume-bar')
    expect(bars.map((b) => b.getAttribute('data-prefix'))).toEqual(['task.*', 'run.*'])
    expect(bars[0]?.textContent).toContain('Tasks')
    expect(bars[0]?.textContent).not.toContain('task.*')
    expect(bars[0]?.querySelector('[data-testid="volume-label"]')?.getAttribute('title')).toBe('task.*')
  })

  it('falls back to the raw prefix for a kind it has no word for', () => {
    render(<ActivityClient workspaceId="w1" initial={pageWith({ typeVolumes: [{ prefix: 'future.*', count: 1 }] })} />)
    expect(screen.getAllByTestId('volume-bar')[0]?.textContent).toContain('future.*')
  })
```

`apps/web/test/skills-page.test.tsx` (leak 4) — replace the `:72` assertion:

```tsx
    expect(screen.getByTestId('skill-state-s3').textContent).toBe('MISSING')
    expect(screen.getByTestId('skill-state-s3').getAttribute('data-state')).toBe('missing')
    expect(screen.getByTestId('skill-state-s3').getAttribute('title')).toBe('missing')
    expect(screen.getByTestId('skill-state-s1').textContent).toBe('READY')
```

`apps/web/test/supervisor-panel.test.tsx` (leak 5) — replace the `:209` assertion and add one:

```tsx
    expect(screen.getByTestId('supervisor-proposal-kind').textContent).toBe('Work the goal no longer needs')
    expect(screen.getByTestId('supervisor-proposal-kind').getAttribute('title')).toBe('stale_task')

  it('reads a recent decision as a sentence, with the raw record in the title (M44 R5)', () => {
    // `decision(...)` and `view(...)` are this file's own existing fixture builders
    // (`supervisor-panel.test.tsx:9` and `:75`) -- reuse them rather than building a second
    // fixture shape beside them, and mount the panel the way the file's other cases do.
    render(<SupervisorPanel workspaceId="w1" initial={view({
      recent: [
        decision({
          id: 'd9',
          situationKind: 'no_reviewer',
          tier: 'proposed',
          status: 'approved',
          decidedBy: 'model',
          rationale: 'the project has nobody who can review',
          failureReason: null,
        }),
      ],
    })} />)
    const row = screen.getAllByTestId('supervisor-decision-row')[0]
    expect(row?.textContent).toContain('No reviewer')
    expect(row?.textContent).toContain('Approved')
    expect(row?.textContent).toContain('the model')
    expect(row?.textContent).not.toContain('no_reviewer')
    expect(row?.querySelector('[data-testid="supervisor-decision-meta"]')?.getAttribute('title')).toBe('no_reviewer · proposed · approved · model')
  })
```

`apps/web/test/simulations-page.test.tsx` (leak 6):

```tsx
  it('says what a run is doing rather than printing its status value (M44 R5)', () => {
    render(<SimulationsClient cards={[card({ status: 'finished' }), card({ id: 's3', status: 'halted' })]} companiesBySector={companiesBySector} />)
    const chips = screen.getAllByTestId('chip')
    expect(chips.map((chip) => chip.textContent)).toContain('Finished')
    expect(chips.map((chip) => chip.textContent)).toContain('Halted')
    expect(chips.map((chip) => chip.textContent)).not.toContain('finished')
  })
```

- [ ] **Step 3: Run them to verify they fail**

```bash
npx vitest run apps/web/test/all-slaves-table.test.tsx apps/web/test/slave-panel.test.tsx \
  apps/web/test/activity-page.test.tsx apps/web/test/skills-page.test.tsx \
  apps/web/test/supervisor-panel.test.tsx apps/web/test/simulations-page.test.tsx \
  packages/domain/test/supervisor/labels.test.ts
```
Expected: FAIL — each surface still renders the raw value; the domain has no label tables.

- [ ] **Step 4: Close leaks 1 and 2 (the worker's status)**

`AllSlavesTable.tsx`: import `userSlaveStatus` from `@slave-of-ai/domain` and `toneForStatus` from
`../lib/tones` (Task 1 moved it), and render:

```tsx
        // R5 leak 1: this pill printed `row.status` -- "pausing" where the Overview card said
        // PAUSING. Both words come from the same projection now, and the raw value stays one hover
        // away.
        const known = KNOWN_SLAVE_STATUSES.find((member) => member === row.status)
        const word = known === undefined ? row.status.toUpperCase() : userSlaveStatus(known).label
        // ...
            <StatusPill tone={tone} label={word} title={row.status} />
```

`StatusPill` therefore takes an optional `title?: string` forwarded onto its root — add it beside
`label`/`tone`/`pulse` and a case in `ui-components.test.tsx`. `KNOWN_SLAVE_STATUSES` is the same
seven-member literal `toneForStatus` uses; export it from `lib/tones.ts` so the two agree.

`SlavePanel.tsx:181-183`:

```tsx
          <span
            data-testid="status-label"
            data-status={slave.status}
            title={slave.status}
            className="ml-1 text-xs text-text-2"
          >
            {userSlaveStatus(slave.status).label}
          </span>
```

- [ ] **Step 5: Close leak 3 (the event rail)**

Create `apps/web/src/lib/eventLabels.ts`:

```ts
/**
 * What each family of events is called on the Activity rail (M44 R5).
 *
 * The rail's keys are the seven dotted PREFIXES `buildActivityPage` groups by
 * (`split_part(type::text, '.', 1) || '.*'`), not the ~48 raw event types -- the M44 spec says
 * "event-type prefix", and this is what that is (plan erratum E5). The raw prefix stays on the
 * bar's `data-prefix` attribute, which a test already pins, and in the label's `title`.
 *
 * Not a `Record<...>` over a closed union: the prefixes come out of SQL as strings, so a family
 * added later must fall back to its own prefix rather than render nothing.
 */
export const EVENT_PREFIX_LABEL: Readonly<Record<string, string>> = {
  'task.*': 'Tasks',
  'run.*': 'Runs',
  'slave.*': 'Messages',
  'guardrail.*': 'Guardrails',
  'workspace.*': 'Project',
  'org.*': 'Organisation',
  'supervisor.*': 'Supervisor',
}

export function eventPrefixLabel(prefix: string): string {
  return EVENT_PREFIX_LABEL[prefix] ?? prefix
}
```

`activity/ActivityClient.tsx:229`:

```tsx
                  <span data-testid="volume-label" title={volume.prefix}>{eventPrefixLabel(volume.prefix)}</span>
```

- [ ] **Step 6: Close leak 4 (skills)**

`SkillsClient.tsx:112-114`:

```tsx
                        <span
                          data-testid={`skill-state-${skill.id}`}
                          data-state={skill.state}
                          title={skill.state}
                          className={`font-mono text-[9.5px] ${STATE_TEXT[skill.state]}`}
                        >
                          {SKILL_STATE_LABEL[skill.state]}
                        </span>
```

with, beside `STATE_TEXT`:

```tsx
/** R5 leak 4: the raw `SkillRow['state']` used to be the label. `missingSince !== null` means the
 *  file the catalog scanned is gone, which is a fact about the disk, not a word a person should
 *  have to decode. */
const SKILL_STATE_LABEL: Record<SkillRow['state'], string> = { ready: 'READY', missing: 'MISSING' }
```

- [ ] **Step 7: Close leak 5 (Supervisor decision rows)**

`SupervisorPanel.tsx:199` (the pending proposal's kind chip):

```tsx
        <span data-testid="supervisor-proposal-kind" title={decision.situationKind} className="shrink-0 font-mono text-[10px] text-text-3">
          {SITUATION_LABEL[decision.situationKind]}
        </span>
```

and `:499`, the recent row — one readable sentence, the raw record in `title`:

```tsx
                  <span
                    data-testid="supervisor-decision-meta"
                    title={`${decision.situationKind} · ${decision.tier} · ${decision.status} · ${decision.decidedBy}`}
                    className="text-[10px] text-text-3"
                  >
                    {SITUATION_LABEL[decision.situationKind]} · {DECISION_STATUS_LABEL[decision.status]} · decided by {DECIDER_LABEL[decision.decidedBy]}
                    {decision.failureReason === null ? '' : ` · ${decision.failureReason}`}
                  </span>
```

`tier` leaves the visible line: `status` already says what happened to the decision and the two
read as a duplicate to anyone who does not know the difference. It stays in `title`, and
`TIER_LABEL` ships for M45's Supervisor conversation surface. Say this in the commit body.

- [ ] **Step 8: Close leak 6 (simulation chips)**

Create `apps/web/src/lib/simulationLabels.ts`:

```ts
import type { SimulationSummary } from '../server/simulation'

/** R5 leak 6: the sim list and the sim page painted a Chip with the raw `SimulationStatus` value.
 *  Same five states, said out loud. */
export const SIMULATION_STATUS_LABEL: Record<SimulationSummary['status'], string> = {
  ready: 'Not started',
  running: 'Running',
  paused: 'Paused',
  finished: 'Finished',
  halted: 'Halted',
}
```

`sim/SimulationsClient.tsx:54`: `<Chip tone={STATUS_TONE[card.status]} title={card.status}>{SIMULATION_STATUS_LABEL[card.status]}</Chip>`
(`Chip` gains the same optional `title` prop `StatusPill` did). Do the same at every
`summary.status`-rendered chip in `sim/SimulationClient.tsx` and `sim/SimulationStrip.tsx` — grep
`STATUS_TONE` and `summary.status` in `apps/web/src/components/sim` and fix each rendering site;
the `status === 'paused'` / `'halted'` CONTROL conditions are logic and stay as they are.

- [ ] **Step 9: Migrate the modals to `Dialog`/`Drawer` (R3/R6/E22)**

Six files, each the same shape: delete the local `useEffect` Escape handler and the `<aside>`/`<div>`
wrapper, wrap the existing children in the primitive, keep every testid.

| File | Primitive | `testId` (unchanged) | `label` |
|---|---|---|---|
| `projects/NewProjectDrawer.tsx` | `Drawer` | `new-project-drawer` | `New project` |
| `slaves/NewSlaveDrawer.tsx` | `Drawer` | `new-slave-drawer` | `New slave` |
| `sim/AdoptDrawer.tsx` | `Drawer width="w-[560px]"` | `sim-adopt-drawer` | `Adopt this organisation` |
| `sim/CloneDrawer.tsx` | `Drawer` | `sim-clone-drawer` | `Clone simulation` |
| `sim/NewSimulationDrawer.tsx` | `Drawer` | `new-simulation-drawer` | `New simulation` |
| `AssignCompanyDialog.tsx` | `Dialog` | (its existing dialog testid) | `Assign a company` |

The three that guard Escape with a `pending` flag today (`AdoptDrawer`, `CloneDrawer`,
`NewSimulationDrawer` all read `if (event.key === 'Escape' && !pending)`) pass
`dismissible={!pending}`. `AssignCompanyDialog`'s hand-rolled trigger-refocus goes away — the
primitive does it — and so does `ProjectsClient.tsx:61`'s `triggerWrapRef` `<div>`, because `Button`
forwards a ref now (Task 2).

`ProjectSwitcher.tsx` and `graph/NodeMenu.tsx` are NOT migrated: a `role="menu"` popover is not
modal, must not trap Tab, and closing it is not the same act as dismissing a dialog. `SlavePanel`,
`GraphDrawer` and `TaskDetailPanel` are not migrated either — persistent side panels, recorded in
`docs/ia.md`.

- [ ] **Step 10: Migrate the buttons, the bands and the states**

- **Buttons.** In each of the 22 files importing `GhostButton`/`PrimaryButton`, replace
  `<GhostButton …>` with `<Button variant="ghost" size="sm" …>`, `<PrimaryButton …>` with
  `<Button variant="primary" size="sm" …>` and `<PrimaryButton tone="blocked" …>` with
  `<Button variant="danger" size="sm" …>`, and fix the import. Then delete `GhostButton` and
  `PrimaryButton` from `ui/FormControls.tsx` and their alias cases from
  `apps/web/test/form-controls.test.tsx` — a typecheck error is the proof no call site was missed.
  Counts to expect: 11 `GhostButton` tags, 24 `PrimaryButton` tags.
- **Bands (E21).** `OverviewClient.tsx:230`, `TasksClient.tsx:49` and `graph/GraphClient.tsx:221`
  become `<Alert variant="notice">showing stale data: {error}</Alert>`; Overview's "adopted from
  simulation" banner becomes `<Alert variant="notice">`. `HaltBanner` is untouched. The ~50 inline
  `role="alert"` refusal sentences under forms are untouched.
- **Empty and loading.** Replace the plain sentences with the primitives, keeping every testid:
  Overview's `blocked-empty`, `live-events-empty`, `merge-queue-empty`; Activity's `volume-empty`;
  Skills' empty tile row; `supervisor-recent-empty`. Each becomes
  `<EmptyState testId="…" message="…" />` with the same words. Where a client shows nothing until
  its first read (`SupervisorPanel` returns `null` by design), leave the design as it is — a
  `LoadingState` there would flash on every poll.
- **Destructive.** `EmergencyStopButton.tsx` becomes a `DangerConfirm` (`label="STOP"`,
  `testId="emergency-stop"`, `confirmText="stop everything"`, `disabled={halted}`,
  `title={halted ? 'workspace is already halted' : undefined}`, `onConfirm` posting
  `/api/w/${workspaceId}/emergency-stop` through `postControl` and returning `result.ok ? null : result.error`).
  `DangerZone.tsx`'s reseed becomes a `DangerConfirm` (`label="reset demo data"`, `testId="reseed"`,
  `confirmText="replace the data"`) — its testids change from `reseed-button`/`reseed-confirm`/
  `reseed-cancel` to `reseed`/`reseed-confirm`/`reseed-cancel`, so
  `apps/web/test/settings-page.test.tsx:1017,1020` change with them.

- [ ] **Step 11: Graph modes become a real tablist, and the office canvas gets a name (R6/D10)**

`graph/GraphClient.tsx:229-242` — replace the `<nav>` and its buttons with
`<Tabs tabs={MODE_TABS.map((t) => ({ id: t.mode, label: t.label }))} current={mode} ariaLabel="Graph mode" testIdPrefix="graph-mode" onSelect={(id) => setMode(id as GraphMode)} disabledIds={…} />`
inside a `<div className="flex gap-1 border-b border-line px-3 py-2">`. The `graph-mode-<id>`
testids and the `?mode=` state are unchanged, so `apps/web/test/graph-page.test.tsx`'s eleven
assertions need only two additions: `role` is `tab` and `aria-selected` is `"true"` on the live one.
Delete the file's "No `ui/` component covers a segmented mode toggle" comment — it is no longer true.

`office/OfficeClient.tsx:315` — the least accessible surface in the app gets the two things R6 asks
for and nothing more:

```tsx
      <canvas
        ref={canvasRef}
        data-testid="office-canvas"
        role="img"
        aria-label={`The project's office: ${hud.slaves} slaves across ${hud.departments} departments, ${hud.working} working`}
        className="block h-full w-full cursor-grab"
      />
      {/* The canvas is a picture. This line is the same facts as text, for a person who cannot see
        * it and for a person whose browser draws nothing -- it is NOT a replacement office, and
        * the Focus card below already gives the per-slave detail (M44 R6). */}
      <p data-testid="office-fallback" className="sr-only">
        {hud.slaves} slaves across {hud.departments} departments; {hud.working} working now. The
        same information is on the Overview tab as cards.
      </p>
```

(read `OfficeHud`'s `view` shape first and use its real field names). Add one case to
`apps/web/test/office-client.test.tsx` asserting both the `aria-label` and the fallback text.

- [ ] **Step 12: Run everything web and domain**

```bash
npx vitest run --project unit
npx vitest run --project integration
```
Expected: PASS. Any failure here is a call site whose assertion still expects a raw value or an old
class — fix the assertion to the projected word, never the component back to the raw value.

- [ ] **Step 13: The task's own gates**

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
pgrep -af "next dev"
```
If `next dev` is running, `kill <pid>` and **say so in the task report**, then:

```bash
npm run web:build
```
Expected: green.

- [ ] **Step 14: Commit**

```bash
git add packages/domain/src/supervisor packages/domain/test/supervisor apps/web/src apps/web/test
git commit -m "$(cat <<'EOF'
feat(domain,web): m44 t4 -- the primitives get their call sites, and six surfaces stop leaking

The six places the audit found rendering a database value as prose now read words: the Slaves table
and the slave panel say PAUSING where they said "pausing"; the Activity rail names each family of
events instead of printing `task.*`; Skills says READY and MISSING; the Supervisor's decision rows
read "No reviewer · Waiting for you · decided by the model"; simulation chips say Finished and
Halted. Every one keeps the raw value on the element -- in `title`, and on a data attribute where a
test or a gate needs to read it -- because backend state fidelity is never weakened for the UI.
Panel logic is untouched.

The domain gains the label tables it turned out not to have: SITUATION_LABEL over all eleven
situation kinds, plus TIER_LABEL, DECISION_STATUS_LABEL and DECIDER_LABEL, each a Record over its
own union so a twelfth member fails the build rather than turning up on the page as an identifier.
`tier` leaves the recent-decision line entirely -- `status` already says what happened to the
decision -- and stays in the title for M45.

Two button systems became one: thirty-five GhostButton/PrimaryButton call sites are Buttons now and
those two exports are gone. Six modals moved onto Dialog/Drawer and stopped hand-rolling Escape;
the two menus kept theirs, because a menu is not modal. Three "showing stale data" bands and the
adopted-from-simulation banner are Alerts. EmergencyStop and the reseed control use the one
destructive recipe, so every destructive action in this app now asks twice the same way.

The Graph mode nav is a real tablist instead of buttons with aria-current, and the office canvas --
the least accessible surface in the app -- says what it is drawing and repeats it as text.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

### Task 5: `gate:m44-ux-foundation`, the fidelity gate's new pages, the screenshots, the README, CI — and the full verification ladder

**Files:**
- Create: `scripts/gate-m44-ux-foundation.mjs`
- Modify: `scripts/gate-m14-fidelity.mjs` (E8/R8: `/slaves` → `/workforce`; Office and project Settings joined to the page set), `package.json`, `.github/workflows/ci.yml`, `README.md`
- Regenerate (own commit): `docs/superpowers/fidelity/m14/*.png` — `slaves.png` deleted, `workforce.png`, `office.png` and `project-settings.png` added, the other eight rewritten

**Interfaces:**
- Consumes from Tasks 1–4: the four `nav-row` `data-nav` values and their hrefs; `skip-link`; the `/slaves` and `/skills` redirects; `workforce-tab-*`; `project-tab-*`, `project-advanced`, `advanced-item-graph`, `advanced-item-office`; `page-shell`; `all-projects-analytics`; `office-canvas` + `office-fallback`; `perm-caption`; the projected words and their `title`s at the six leak sites; `Drawer`'s focus contract; `SITUATION_LABEL`, `SIMULATION_STATUS_LABEL`, `eventPrefixLabel`, `USER_CARD_LABEL`.
- Produces: the npm script name `gate:m44-ux-foundation`.

- [ ] **Step 1: Teach the fidelity gate the three route changes (E8 / R8)**

In `scripts/gate-m14-fidelity.mjs`:

1. `PAGES`' `slaves` entry becomes
   `{ name: 'workforce', path: () => '/workforce', testId: 'data-table' }`, and the header comment's
   nine-page list is rewritten to eleven. Add two entries after `settings`:
   ```js
    // M44 R8: the two pages M14 never covered. Office postdates M14 (M28) and the project Settings
    // tab's numbers were only ever asserted in stage 2a -- neither had a committed screenshot, so
    // neither had any protection against a redesign at all.
    { name: 'office', path: () => `/w/${workspaceId}/office`, testId: 'office-canvas' },
    { name: 'project-settings', path: () => `/w/${workspaceId}/settings`, testId: 'perm-caption' },
   ```
2. The `SLAVES_COLUMNS` block's two `gotoReliably(`${baseUrl}/slaves`)` calls become
   `` `${baseUrl}/workforce` ``, and its comment gains one sentence: the table is the Workforce
   page's Slaves tab now, and `/slaves` is a 307 into it.
3. Stage 2a's `gotoReliably(`${baseUrl}/w/${workspaceId}/settings`)` stays exactly as it is — the
   new `PAGES` entry screenshots that page, and stage 2a still measures it.
4. `LIVE_PAGES` is unchanged: Office and project Settings are captured once, idle. Say why in a
   comment — the office canvas animates continuously and a second capture of it would differ from
   the first on every run, which is a screenshot nobody can review.

- [ ] **Step 2: Write `scripts/gate-m44-ux-foundation.mjs`**

Borrow the boot skeleton from `scripts/gate-m16-chrome.mjs` verbatim — `findFreePort()`,
`spawn`ing `next dev apps/web -p <port> -H 127.0.0.1` under `loopbackChildEnv()`, the ready-wait
that parses the bound port back out of next's own ready line, the child killed in `finally`, dist
imports only, one top-level `try` with no `catch`, `let exitCode = 1` set to `0` only by falling off
the end of the try, and `process.exit(exitCode)` as the literal last line. Borrow
`waitVisible`/`clickUntil`/`gotoReliably`/`fail()`'s console dump from
`scripts/gate-m14-fidelity.mjs`, and its **preflight refusal** (erratum E10).

Header:

```js
// M44's own gate (spec R8): "four ways in, and nothing on screen a person cannot read".
//
// `gate-m16-chrome.mjs`'s shape -- a free port, a real `next dev`, a real Chromium through
// `playwright-core` at CHROMIUM_PATH, no daemon -- with `gate-m14-fidelity.mjs`'s preflight and
// its browser helpers.
//
//   CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   npm run gate:m44-ux-foundation
//
// THIS GATE SPENDS NOTHING AND CANNOT. It dispatches no run, so no CLI is ever invoked -- and the
// preflight still REFUSES to start unless SLAVEOFAI_CLAUDE_BIN points at an executable under
// `scripts/gate-fakes/` and SLAVEOFAI_REQUIRE_FAKE_CLI=1, so a later stage that grows a run cannot
// quietly reach a real account (Decision 10, M32 item 7).
//
// UNLIKE m16 IT WRITES FIXTURE ROWS, and that is the point. Six of the eight stages below are
// NEGATIVE ("no raw enum token is visible text"), and a negative assertion against the seeded
// database proves nothing: the seed has thirteen tasks and ZERO SlaveRun, SupervisorDecision,
// SimulationRun and missing-skill rows, so every slave is idle, the Supervisor panel is empty and
// the simulation list is empty. This gate creates exactly the four rows that make those surfaces
// say something -- a pause_requested run (a `pausing` slave), a pending Supervisor decision, a
// Skill with missingSince set, a paused SimulationRun -- and deletes them in `finally`, in FK
// order. `git status` after a green run has to be empty.
//
// The eight stages of R8:
//   1. Four sidebar entries, in order, pointing where they say; /slaves and /skills land on
//      /workforce with the right tab; /analytics still answers.
//   2. The project strip is Overview/Tasks/Activity/Settings, and Advanced opens onto Graph and
//      Office, whose routes still render.
//   3. Every page renders inside PageShell or its page-level equivalent, with the one main
//      landmark and the sidebar present.
//   4. NO RAW ENUM TOKEN is visible text on the eleven pages -- the blocklist is DERIVED from the
//      domain's own unions, not typed here.
//   5. A drawer traps Tab and gives focus back on Escape.
//   6. The skip link is the first focusable element and reaches `main`.
//   7. The sidebar is 212px at 1440 and collapsed at 800.
//   8. Simulated money and model cost never share a tile.
//
// THE GATE ASSERTS, IT NEVER FIXES. Every stage prints every measured value before asserting it.
```

Body, in order. Each numbered item is one stage; each prints before it asserts.

1. **Preflight and fixtures.** Copy `gate-m14-fidelity.mjs`'s `SLAVEOFAI_CLAUDE_BIN` check
   (`accessSync(bin, constants.X_OK)` plus a `startsWith(join(repoRoot, 'scripts/gate-fakes'))`
   guard) and its `SLAVEOFAI_REQUIRE_FAKE_CLI` assertion. `preflightCleanup()` deletes anything a
   previous run left by name prefix. Then, with prisma directly:
   `WORKSPACE_NAME = 'M44 Gate Project <hh:mm:ss>'`, one `Team`, one `Slave`, one `Task`
   (`status: 'running'`), one `SlaveRun` on it with `status: 'pause_requested'` (which is what makes
   `deriveSlaveStatus` say `pausing` — the exact value leak 1 used to print), one
   `SupervisorDecision` (`situationKind: 'no_reviewer'`, `tier: 'proposed'`, `status: 'pending'`,
   `decidedBy: 'model'`, a `situation` JSON with a real `summary`), one `SkillProvider` + `Skill`
   with `missingSince` set, and one `SimulationRun` with `status: 'paused'`. Print every id.
2. **Stage 1 — the four ways in.** On `/`: read
   `nav[aria-label="Primary"] [data-testid="nav-row"]`'s `data-nav` and `href` in DOM order and
   assert exactly `[['Projects','/'],['Workforce','/workforce'],['Simulations','/sim'],['Settings','/settings']]`.
   Then `gotoReliably(baseUrl + '/slaves')` and assert `page.url()` ends `/workforce` and
   `workforce-tab-slaves` has `aria-selected="true"`; `/skills` and assert the URL carries
   `tab=skills` and `workforce-tab-skills` is selected; `/analytics?workspace=<id>` and assert
   `kpi-tile` is visible (the route R1 promised to keep). Assert no `nav-row` has `data-nav` of
   `Slaves`, `Skills` or `Analytics`.
3. **Stage 2 — the project strip.** On `/w/<id>`: `[role="tab"]` text equals
   `['Overview','Tasks','Activity','Settings']` (strip the badge digits, as
   `project-tabs.test.tsx` does). `advanced-item-graph` is absent until `project-advanced` is
   clicked, then both items are present with hrefs `/w/<id>/graph` and `/w/<id>/office`. Navigate to
   each and wait for `graph-canvas` and `office-canvas` — the Advanced items are not decoration.
   Press Escape on the open menu and assert `document.activeElement` is `project-advanced`.
4. **Stage 3 — one shell.** For each of the eleven pages, assert the `Primary` nav is present, that
   `document.querySelectorAll('main').length === 1`, and that `main#main` exists. For the six pages
   that use `PageShell` (`/`, `/workforce`, `/analytics`, `/settings`, `/sim`, `/sim/<id>`) also
   assert `page-shell` is present. Print which check each page passed.
5. **Stage 4 — no raw enum token.** Build the blocklist from the dist packages rather than typing it
   (plan decision D7):
   ```js
   const RAW_TOKENS = [
     ...TASK_STATUSES, ...RUN_STATUSES, ...SITUATION_KINDS, ...DECISION_STATUSES, ...TIERS,
     ...Object.values(EVENT_TYPE_BY_DOMAIN_TYPE), ...Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE),
   ].filter((token) => token.includes('_') || token.includes('.'))
   ```
   — every member that carries an underscore or a dot, which is every member a person could not
   have written by accident. A bare English word that happens to be an enum member (`working`,
   `paused`, `ready`, `done`, `failed`, `blocked`, `merging`, `idle`, `model`, `rules`) is the
   product's own vocabulary and is NOT forbidden. Then, per page, collect visible text with
   ```js
   const text = await page.evaluate(() => {
     const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
     const out = []
     for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
       const parent = node.parentElement
       if (parent === null) continue
       if (parent.closest('nextjs-portal, script, style, [aria-hidden="true"], .sr-only') !== null) continue
       const value = (node.nodeValue ?? '').trim()
       if (value !== '') out.push(value)
     }
     return out
   })
   ```
   and fail naming the page, the token and the offending string. `title` attributes and `data-`
   attributes are NOT text nodes, so the raw values R5 deliberately keeps are invisible to this
   scan — which is exactly the shape the ruling asks for. The eleven pages are the fidelity gate's
   nine (with `workforce` for `slaves`) plus `/w/<id>/office` and `/w/<id>/settings`, and this gate
   also scans `/sim` and `/sim/<id>` because the fixture's paused simulation lives there.
   **Positive counterpart, so the stage is not vacuous:** on `/workforce` assert the fixture
   worker's pill reads `PAUSING` and its `title` reads `pausing`; on `/w/<id>` assert the
   Supervisor row contains `No reviewer` and its `supervisor-decision-meta` `title` contains
   `no_reviewer`; on `/w/<id>/activity` assert a `volume-label` reads a word from
   `EVENT_PREFIX_LABEL` and its `title` is the raw prefix; on `/workforce?tab=skills` assert
   `MISSING` with `title="missing"`; on `/sim` assert `Paused` on a chip whose `title` is `paused`.
6. **Stage 5 — a drawer's keyboard.** On `/`, click `+ New project`, wait for
   `new-project-drawer`. Assert `document.activeElement` is inside it. Press `Tab` enough times to
   pass the last control (loop `Tab` up to 30 times, recording `document.activeElement`'s testid
   each press) and assert focus **never leaves** the drawer's subtree. Press `Escape` and assert the
   drawer is gone and `document.activeElement` is the trigger that opened it. Print the focus trail.
7. **Stage 6 — the skip link.** On `/`, press `Tab` once from `document.body` and assert the focused
   element is `[data-testid="skip-link"]` and its `href` is `#main`. Press `Enter` and assert
   `document.activeElement.id === 'main'` — a skip link that only scrolls has moved the viewport
   and not the keyboard.
8. **Stage 7 — the collapse.** At `1440×900` assert `getComputedStyle(nav).width === '212px'` (the
   README number, unchanged). `page.setViewportSize({ width: 800, height: 900 })`, reload, assert
   it is `'52px'` and that every `nav-row` still has a non-empty `aria-label`. Restore 1440×900.
9. **Stage 8 — two kinds of money.** On `/sim/<fixture id>`, assert no single element contains both
   a `data-simulation` ancestor and a real-cost tile: collect every element whose text matches
   `/\$/` and, for each, assert `element.closest('[data-simulation]') === null` XOR it sits inside
   the "Model usage (real)" panel — never both. Print each `$`-bearing element's testid and which
   side it fell on. **Read `sim/SimulationClient.tsx` first**: if the simulated side has no
   `data-simulation` marker today, add one to the simulated-money panel's root in this task (a
   `data-simulation="true"` attribute and nothing else) and say so in the commit — a gate that has
   to guess which panel is which is a gate that will pass on the day the two merge.
10. **`finally`.** Kill `next dev`, close the browser, delete the fixture rows in FK order
    (`ExecutionEvent`, `SupervisorDecision`, `SlaveRun`, `Task`, `Slave`, `Team`, `Workspace`,
    `SimulationRun`, `Skill`, `SkillProvider`), then `console.log('PASS: four ways in, and nothing
    on screen a person cannot read')` and `exitCode = 0` at the end of the try, never earlier.

Import `TASK_STATUSES`, `RUN_STATUSES`, `EVENT_TYPE_BY_DOMAIN_TYPE` from
`../packages/db/dist/enums.js`, `SITUATION_KINDS`, `DECISION_STATUSES`, `TIERS`,
`EVENT_PREFIX_LABEL`-equivalents from `../packages/domain/dist/index.js`, and `prisma` from
`../packages/db/dist/client.js`. `EVENT_PREFIX_LABEL` lives in `apps/web/src/lib`, which a plain
`node` script cannot load (`apps/web` compiles with `noEmit`) — the gate asserts the WORDS by
reading them off the page and comparing against a small literal list in the gate, and says in a
comment that the source of truth is `apps/web/src/lib/eventLabels.ts`.

- [ ] **Step 3: Add the npm script**

In `package.json`, after the `gate:m42-catalog-import` line (the comma moves onto it):

```json
    "gate:m42-catalog-import": "tsc --build && node --env-file=.env scripts/gate-m42-catalog-import.mjs",
    "gate:m44-ux-foundation": "tsc --build && node --env-file=.env scripts/gate-m44-ux-foundation.mjs"
```

- [ ] **Step 4: Add it to CI (E11)**

In `.github/workflows/ci.yml`, immediately after `- run: npm run gate:m42-catalog-import`:

```yaml
      - run: npm run gate:m44-ux-foundation
```

The `gates` job already installs Chromium and exports `CHROMIUM_PATH`, and already sets
`SLAVEOFAI_CLAUDE_BIN` and `SLAVEOFAI_REQUIRE_FAKE_CLI` job-wide, so the gate's preflight is
satisfied with no new step. `gate:m14-fidelity` stays out of CI — it rewrites committed PNGs.

- [ ] **Step 5: Run the new gate until it is green**

```bash
pgrep -af "next dev"     # must be empty; a second next dev sharing apps/web/.next corrupts both
CHROMIUM_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())") \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m44-ux-foundation
git status --short
```
Expected: `PASS:` and exit 0, and a **clean** `git status`. Paste the gate's full output into the
task report — the eight stages' printed values are the milestone's evidence.

- [ ] **Step 6: Regenerate the fidelity screenshots — its own commit**

```bash
pgrep -af "next dev"     # must be empty
CHROMIUM_PATH=$(node -e "console.log(require('playwright-core').chromium.executablePath())") \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
npm run gate:m14-fidelity
git status --short docs/superpowers/fidelity/m14
```
Expected: `PASS`, and eleven PNGs written — eight rewritten, `workforce.png`, `office.png` and
`project-settings.png` new. Delete the stale one and commit the set ALONE, so a reviewer can see the
design change as a diff of images and nothing else:

```bash
git rm docs/superpowers/fidelity/m14/slaves.png
git add docs/superpowers/fidelity/m14
git commit -m "$(cat <<'EOF'
chore(fidelity): m44 -- regenerate the m14 screenshots for the new navigation

Deliberate, and alone in its own commit so the design change is reviewable as a diff of images.
Eight pages are rewritten (four sidebar rows instead of six, four project tabs plus Advanced, the
projected status words, the analytics section under the project cards). slaves.png is gone and
workforce.png takes its place -- /slaves is a 307 now. office.png and project-settings.png are new:
the Office tab postdates M14 and the project Settings tab's numbers were only ever asserted in
stage 2a, so neither had a committed screenshot to review a redesign against.

Every README pixel value the gate asserts is unchanged; this commit is what the pages LOOK like,
not what they measure.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

- [ ] **Step 7: Update the README's UI section**

In `README.md`, replace the "The web UI" table's four affected rows and add the navigation sentence
above it:

```markdown
Four ways in: **Projects**, **Workforce**, **Simulations**, **Settings**. Everything else is inside
one of them — `docs/ia.md` is the map, and says where anything that left a main path went.

| Page | What it shows |
|---|---|
| **Projects** `/` | Every active project (workspace) with its status in one word, how many things need you, its spend and its team; click one to open it. **New project** attaches a repo; **show archived** also lists archived projects (an "archived" chip, no spend bar, a **restore** button); below the cards, the same all-project figures the Analytics page shows. |
```

replace the `**Slaves** /slaves` and `**Skills** /skills` rows with one:

```markdown
| **Workforce** `/workforce` | Everyone who works here, in four tabs. **Slaves**: every slave, project-materialized or still catalog-only, with its department as a select, rename/re-role/delete with its history and a model chosen from the provider's own list inline; **+ New slave** adds one to the catalog and, optionally, to a project. **Departments**: add, rename or delete a project's department and see who is on it. **Catalog**: the slave templates, the companies and their department templates, and the log of catalog imports. **Skills**: the skill catalog and its assignments. `/slaves` and `/skills` still work — they redirect here. |
```

replace the `**Graph**` and `**Office**` rows' leading cells with `**Graph** (Advanced ▾)` and
`**Office** (Advanced ▾)` and add to each one sentence: "reached from the project's `Advanced ▾`
menu, or by its URL". Replace the `**Analytics** /analytics` row with:

```markdown
| **Analytics** `/analytics` | Spend and throughput, for every project or for one (`?workspace=`). The all-project view is also a section on the Projects page; a project's own view is one click from it. |
```

- [ ] **Step 8: Update the "Tests and CI" roster (E11)**

Replace

```
`gate:m39-supervisor-mailbox`, `gate:m40-requirement-versioning`, `gate:m41-scenario` and
`gate:m42-catalog-import` on every push
```

with

```
`gate:m39-supervisor-mailbox`, `gate:m40-requirement-versioning`, `gate:m41-scenario`,
`gate:m42-catalog-import` and `gate:m44-ux-foundation` on every push
```

and replace

```
up in a real run's recorded prompt. That is 18 gates. Tests and gates share one Postgres — run
one at a time.
```

with

```
up in a real run's recorded prompt, and `m44` drives a real browser over every page at once to
check that there are four ways into the product, that the project's own strip answers "what is
happening" in four tabs with Graph and Office still one menu away, that nothing on any of eleven
pages is a database value a person would have to decode, that a drawer traps the Tab key and hands
focus back on Escape, that the skip link is the first thing the keyboard finds, that the sidebar
collapses on a narrow window, and that simulated money is never shown beside real model cost. That
is 19 gates. Tests and gates share one Postgres — run one at a time.
```

- [ ] **Step 9: Full verification ladder**

Run these **in this order**, one at a time, with no `next dev` running anywhere and no other vitest
process alive (the shared test database truncates, and a running daemon breaks `subscribe.test.ts`):

```bash
npm run --silent typecheck
npm run gate:m26-vocabulary
npx vitest run
npm run web:build
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

with `CHROMIUM_PATH` and `SLAVEOFAI_CLAUDE_BIN` exported for the three browser gates (m44, m14,
m16). Expected: every one green.

`gate:m16-chrome` is on this ladder and was not on M42's: it reads computed styles off `/`,
`/analytics` and `/w/<seed>/settings`, all three of which this milestone changed. A failure there is
a real regression, not a flake — most likely its `team-overflow` check, which lives on a Projects
page whose card this milestone edited.

Known flakes, and what to do about them rather than around them:
`apps/orchestrator/test/integration/cli.test.ts`'s llm-decision row-count case doubles when anything
else touches the database — re-run that file alone before believing a failure. `web:build` must
never run while `next dev` is up; if the dev server was running, stop it (`kill <pid>`), say so in
the report, `rm -rf apps/web/.next`, and restart it afterwards. `gate:m14-fidelity` and
`gate:m44-ux-foundation` both boot their own `next dev` against `apps/web/.next` — run them one at a
time, never beside each other and never beside a dev server.

After the ladder, prove the tree is clean apart from the screenshot commit already made:

```bash
git status --short
```
Expected: empty.

- [ ] **Step 10: Commit**

```bash
git add scripts/gate-m44-ux-foundation.mjs scripts/gate-m14-fidelity.mjs package.json \
        .github/workflows/ci.yml README.md
git commit -m "$(cat <<'EOF'
test(gates),docs: m44 t5 -- gate:m44-ux-foundation, and eleven pages under the fidelity gate

Eight stages in a real browser against a real next dev, and each one measures a rule this milestone
claims to follow: four sidebar entries pointing where they say, with /slaves and /skills landing on
the right Workforce tab and /analytics still answering; a project strip of four tabs with Graph and
Office one menu away and both routes still rendering; one page shell and one main landmark on every
page; no raw enum token as visible text anywhere on eleven pages -- with the blocklist DERIVED from
the domain's own unions rather than typed into the gate, and a positive counterpart per surface so
the negative is not vacuous; a drawer that traps Tab and gives focus back on Escape; a skip link
that is the first thing the keyboard finds and actually moves focus to main; a sidebar that is
212px at 1440 and 52px at 800; and simulated money that never shares a tile with model cost.

It spends nothing and cannot: no run is dispatched, and the preflight still refuses to start unless
SLAVEOFAI_CLAUDE_BIN names a fake under scripts/gate-fakes. It writes four fixture rows -- a
pause_requested run, a pending Supervisor decision, a missing skill, a paused simulation -- because
the seeded database has none of them and a negative assertion against an empty page proves nothing.
Every row is deleted in a finally, in FK order.

gate:m14-fidelity grows from nine pages to eleven: Office and the project Settings tab had no
committed screenshot at all, and /slaves is now /workforce.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MCtZpwnmcQUZcufv1Jz2rP
EOF
)"
```

---

## Self-review

**1. Spec coverage.**

- **R1 — four entries.** Task 3: `Sidebar`'s four rows and their currency rules; `/workforce` with
  its four tabs; `/slaves` and `/skills` as 307s (Task 3 Step 7); the all-workspaces analytics
  section on `/` (Steps 8, and `KpiStrip` reusing `buildAnalytics(null)` — erratum E20); the
  `/analytics` route kept, its per-workspace view still reachable by `?workspace=`; the "needs you"
  count (Step 9, erratum E19). Asserted by gate stage 1.
- **R2 — four project tabs + Advanced.** Task 3 Step 5; both Advanced routes navigated in gate
  stage 2; `docs/ia.md`'s project table records the demotion, per R7 and the "no functionality
  removed" constraint. M45's Organization tab is **not** built (out of scope §3).
- **R3 — one shell, one primitive set.** Task 2 creates all ten primitives named in §2 and the
  tokens; Task 4 migrates every call site, deletes the second button system, and makes
  `DangerConfirm` the only destructive recipe (EmergencyStop and DangerZone both adopt it). `Card`'s
  `className` lands; the card DOMs do not converge, and erratum E1 says why in the plan, in the
  component's own docblock and in `docs/ia.md`. The sidebar collapses below 900px (Task 3 Step 3),
  asserted at 800px in gate stage 7. Office's canvas keeps its rendering (R6 adds only a label and a
  text line). Every README pixel value is untouched — no task edits `design_handoff_ai_team_os/README.md`
  and no task edits a `gate:m14-fidelity` stage-2 number.
- **R4 — the projection.** Task 1, in full: the four functions, the eleven task states and their
  labels, `needsYou`'s four rules (with erratum E4's widening and its `failed` exclusion both
  pinned), `userWorkspaceStatus`'s five words, `tones.ts` re-exporting. Raw values stay reachable —
  Task 4 puts each one in `title` and on a `data-` attribute, and gate stage 4's positive
  counterpart reads both back.
- **R5 — six leaks, nothing else re-written.** Task 4 Steps 4–8, one per leak, each with its own
  test asserting the word AND the raw value. Panel logic is unchanged everywhere; the Tasks board's
  pill is deliberately untouched (erratum E3).
- **R6 — accessibility and responsiveness.** Skip link + one `main` (Task 3 Steps 3–4, erratum E16);
  `Dialog`/`Drawer` focus management (Task 2 Step 5, Task 4 Step 9); `role="tab"` on the Graph mode
  nav via `Tabs` (Task 4 Step 11); the sidebar collapse; `md:`/`xl:` breakpoints on `PageShell` and
  the `KpiStrip`/Workforce grids; the office canvas's `aria-label` and text fallback line, "nothing
  more".
- **R7 — `docs/ia.md`.** Task 3 Step 10, written from the inventory: the five rules including "do
  not build a dashboard for everything", one table per surface group with route → goal → decision →
  what M44 does → what a later milestone does, the deliberate non-migrations, and the honest
  definition of "needs you". Vocabulary-clean (erratum E9).
- **R8 — the gate.** Task 5, all eight assertions R8 names, plus the fidelity gate's page set and
  the screenshot-regeneration commit. CI and the README roster (18 → 19).
- **§1's closing bullet** (never a real model call; one vitest at a time; `web:build` last and never
  beside `next dev`; vocabulary; no migration; no functionality removed) → Global Constraints, and
  the `pgrep -af "next dev"` check is a literal step in Tasks 2, 3, 4 and 5.
- **§3's out-of-scope list is respected.** No task touches Overview's content, builds a Supervisor
  conversation surface, adds an Organization tab, adds progressive disclosure, changes a control
  route or a read model beyond `ProjectRow.needsYou`, adds a chart, or adds an animation. The one
  read-model change is named and justified by R1's own "needs you count".

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "write tests for the
above", no "similar to Task N" — Task 4's leak fixes each carry their own code even where the shape
repeats. Four steps deliberately say "read the file first and follow what it actually supports",
each naming the file, the reason and what to do with what is found: Task 3 Step 6 (`SlavesClient`'s
real prop lists for the five moved panels), Task 4 Step 11 (`OfficeHud`'s `view` field names), Task
4 Step 8 (every `status`-rendered chip under `components/sim`), and Task 5 stage 8 (whether a
`data-simulation` marker exists yet, with the instruction to add one if not). Task 5's gate is a
numbered specification rather than 700 lines of JavaScript, for the reason the M41 and M42 plans
recorded for the same helpers: it names the file each helper is borrowed from, the exact fixture
rows, the exact assertions per stage and the exact teardown order, and retyping `waitVisible` /
`gotoReliably` / `fail` here would risk a silent divergence from the failure-report shape every
other gate in this repository shares.

**3. Type consistency.** `UserStatus<S>`'s three fields are `state`/`label`/`needsYou` in the
interface block, the implementation, the tests, `tones.ts` and every Task 4 call site.
`UserTaskFacts`' five fields (`status`, `integrated`, `autoMerge`, `questionHolder`,
`decisionPending`) are spelled identically in Task 1's interface block, its implementation, its
tests and Task 3's `listProjects`. `UserCardState` is the type `CardState` aliases, so every
existing `CardState` consumer keeps compiling. `USER_CARD_LABEL`, `USER_TASK_LABEL`,
`USER_WORKSPACE_LABEL`, `USER_TASK_STATE_FOR_STATUS`, `SITUATION_LABEL`, `TIER_LABEL`,
`DECISION_STATUS_LABEL`, `DECIDER_LABEL`, `EVENT_PREFIX_LABEL`, `SIMULATION_STATUS_LABEL` and
`SKILL_STATE_LABEL` are each defined once and named the same everywhere they appear.
`Button`'s props are `variant` (`primary|ghost|danger`) and `size` (`md|sm`) in Task 2's interface
block, its implementation, the `FormControls` aliases, the tests and all 58 Task 4 call sites.
`Tabs`' props (`tabs`, `current`, `ariaLabel`, `testIdPrefix`, `onSelect`, `disabledIds`) are the
same six in Task 2, `ProjectTabs`, `WorkforceClient` and `GraphClient`. `Drawer`/`Dialog` both take
`open`/`onClose`/`label`/`testId`/`dismissible` in the interface block, the implementations, the
modal tests and Task 4's migration table. `WorkforceTab` is `'slaves' | 'departments' | 'catalog' | 'skills'`
in the page, the client, `WORKFORCE_TABS`, the test and the gate's `workforce-tab-*` selectors.
`ProjectRow.needsYou` is a `number` in the interface, `listProjects`, `ProjectsClient`,
`userWorkspaceStatus`'s `needsYouCount` argument and the integration test.
