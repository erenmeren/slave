# M57 UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator web UI stops being a dark-only, tab-and-menu application and becomes the console the design prototype draws: one sidebar TREE that holds every project and, under the current one, its six sections and its three views; a 54 px header that is a breadcrumb, the money and one split button; a persistent Supervisor right panel that collapses to a 52 px dock and that the two big detail panels slide into; five task columns in the domain's own words; and light as well as dark, following the operating system by default. Not one route, not one event, not one control verb, not one migration and not one domain rule changes — the only additions to anything below `apps/web` are one control function that already exists inline in the CLI and the three web routes that call it and its neighbours.

**Architecture:** The frame moves UP and the data moves DOWN. `AppShell` is one CSS grid mounted by the ROOT layout — `236px minmax(0,1fr) <372px | 52px | nothing>` — which makes the root layout an ancestor of every page for the first time, and that is what lets the right panel and the page's header action be React CONTEXT rather than the module-level pub/sub stores M24 was forced into. The sidebar's tree is one additive server read model (`server/sidebar.ts`) rendered server-side for the first paint and refetched from one additive route (`GET /api/sidebar`) on a route change and on the current workspace's EXISTING stream wake-up, read through the `useShellFacts` publication that every workspace page already makes — so the tree costs no second `EventSource`. Which section a pathname is on, what the breadcrumb says and which views exist are ONE pure module (`lib/routes.ts`) with no React import. The token sheet grows rather than moves: every new token name the handoff README uses is declared for light, for system-dark and for pinned-dark, and every old token name in `globals.css` stays declared as an alias of the matching new one — so the ninety-odd files that spell `bg-bg-1` and `text-text-2` keep rendering, correctly, in both themes, on the day the switch lands, and are restyled one page at a time by the later tasks. The Supervisor's conversation is a GROUPING, not a table: `server/supervisorThreads.ts` folds the `workspace.goal_set`/`supervisor.*` events one workspace already has into one thread per local calendar day, decision cards come from the pending-decisions read the Overview already makes, and the composer posts to the `goal/request` route `SupervisorRequest.tsx` already posts to. And `SlavePanel`/`TaskDetailPanel` — 624 and 776 lines, thirty-odd pinned testids each — move into the slot by ONE className edit apiece.

**Tech Stack:** TypeScript monorepo; Next.js 15 App Router (15.5.23 installed) + React 19; Tailwind v4 configured by `@theme inline` INSIDE `apps/web/src/app/globals.css` (there is no `tailwind.config.*`); `next/font/local`; zod; vitest (two projects: `unit`, `integration`); Prisma 7 + Postgres on :5433; plain-`node` `.mjs` gates driving `playwright-core`.

**Spec:** `docs/superpowers/specs/2026-09-14-m57-ui-redesign-design.md` (rulings R1–R16; §2 surfaces; §3 the testid vocabulary, introduced and removed; §4 `docs/ia.md` after M57; §5 the gate's ten stages; §6 out of scope; §7 errata). Its parents are `docs/ia.md` (the four rules — rule 2 "nothing is removed, only moved" is the one R11 argues from at length, rule 3 "labels never keys", rule 4 "real is not simulated"), `docs/superpowers/specs/2026-09-10-m44-ux-foundation-design.md` (R1 the four-entry navigation, R3 the primitive set, R4 the status projection, R6 the accessibility floor, R8 the gate shape this milestone's gate copies), `docs/superpowers/specs/2026-09-10-m45-project-experience-design.md` (the brief, the needs-you queue, the Supervisor request box, the Overview `Advanced ▾` this milestone dissolves) and `docs/superpowers/specs/2026-09-13-m56a-provider-contract-design.md` (the immediately preceding milestone, and the source of the Global Constraints below). The design inputs are the prototype `Slave of AI App.dc.html` and the handoff README, both in the session scratchpad under `design/`.

Plan-time errata E1–E9, every one read out of the code before a line of this plan's code was written. Each is to be appended to the spec's §7 during execution in the one-line `**En (amends Rx)** — <claim>.` form.

- **E1 (amends R14c) — there is no clear-halt route, and there is no clear-halt CONTROL VERB either.** The spec's R14c already says the route is missing. It is worse than that: `grep -rn "clearHalt\|clear-halt" packages/ apps/` finds only `apps/orchestrator/src/cli.ts:1718-1729`, a `case 'clear-halt'` that runs `prisma.workspace.update({ where: { id }, data: { haltedReason: null, haltedAt: null } })` inline, returns no `Result`, and appends no event. So Task 4 adds `clearHalt(workspaceId)` to `packages/control/src/emergency.ts` — a `Result<{ cleared: boolean }, ControlRefusal>` holding exactly those two columns and nothing else — rewrites the CLI case to call it, and points the new route at it. **No event is appended, because the CLI appends none**, and a milestone whose claim is that nothing changed may not start writing history the CLI does not write. `emergencyStop`'s own `guardrail.tripped` is untouched.
- **E2 (amends R7) — the `Pause all` label cannot be derived from `ShellFacts`, and needs one more number.** R7 says the split button's left half flips `Pause all` ⇄ `Resume all`. `ShellFacts.counts` carries `slavesWorking` and `tasksActive` and nothing about PAUSED runs, so the header cannot tell "everything is paused" from "nothing is running". `ShellFacts.counts` gains one member, **`slavesPaused: number`** — the `deriveSlaveStatus` projection `buildShellFacts` already runs over the `SlaveRun` rows it has fetched, asked for `'paused'` and deduped by `slaveId`, with no new query (spec erratum E13 corrects this erratum: the draft counted paused RUNS here and paused SLAVES in the client literal, and there is no `Slave.status` column to count either way). Every publisher of `ShellFacts` is a page client that spreads a snapshot's `shellFacts` verbatim, so the five of them are untouched; the two that BUILD the object by hand (`OverviewClient.tsx:192-195` and `server/tasks.ts`) gain one line each, counting SLAVES under the same name. `useShellFacts.ts`'s `sameFacts` gains the corresponding comparison — without it the header would not re-render when the last run pauses.
- **E3 (amends R5) — `buildSidebarTree` must not call `listProjects()`.** `listProjects` (`apps/web/src/server/org.ts:159`) makes six grouped queries plus a `findMany` with a nested `include` of every team's every slave, and returns spend, avatars and task counts the tree does not draw. It is the PROJECTS PAGE's read model and running it in the ROOT layout would put it on every page in the product. `buildSidebarTree` is its own four-query read — `workspace.findMany` (id, name, archivedAt, haltedReason, autoMerge), `task.groupBy` by `{workspaceId, status}`, `task.groupBy` by `{workspaceId}` where `{status:'done', integratedAt:null}`, and `supervisorDecision.groupBy` by `{workspaceId}` where `{status:'pending'}` — and it derives `needsYouCount` through the domain's own `needsYou(...)`, exactly the way `listProjects` does at `:317-328`, so the two numbers cannot drift.
- **E4 (amends R8) — `useSelectedId` cannot be the provider's source of truth without a mirror, and the mirror belongs in the PAGE, not in the provider.** `useSelectedId` is a hook over `?slave=`/`?task=` that three page clients already call. The provider lives in the root layout and must not know those parameter names. So each owning page client keeps its `useSelectedId` call verbatim and adds one `useEffect` that calls `open('task', …)` / `close()` as the selection changes; `RightPanel` renders whatever the provider holds. `WorkforceClient` is deliberately NOT given that effect: `/workforce` is a global route with no third column (R8), and its `SlavePanel` stays in the page frame.
- **E5 (amends R8) — the two panels' `onClose` must close the PROVIDER as well as the URL, and the provider's `close()` must clear the URL.** Passing `onClose={() => selectTask(null)}` alone would blank the URL and leave the provider holding a mode; clicking the panel's own `»` would clear the provider and leave `?task=` in the URL for the next reload to restore. Both page clients therefore pass an `onClose` that does both, and the provider is given the page's clearer through the same effect that opens it (`open(mode, { payload, onClose })`), so `RightPanel`'s header `»` and the panel's own close do the same thing.
- **E6 (amends R10) — `COLUMN_STATE` is read through `CARD_STATE_TONE`, and `'completed'` is the spelling.** `lib/taskColumns.ts:46` types `COLUMN_STATE` as `Record<BoardColumn, CardState>` and `CardState = UserCardState` (`lib/tones.ts:20`), whose member for finished work is `'completed'`, not `'done'`. Renaming the columns does not change that; the `Done` column's state stays `'completed'`.
- **E7 (amends R12) — `gate-m49-memory.mjs:1534` reads the tab strip as a SET, and its replacement must read the tree the same way.** That gate asserts the project tab ids by scraping every `[data-testid^="project-tab-"]` and stripping the prefix. Its replacement scrapes `[data-testid="sidebar-section"]` and reads `data-section`, which is the same assertion over the same six values (`overview, tasks, organization, knowledge, activity, settings`) — the ids are the ROUTE segments and do not change, only the labels do (`organization` is labelled `Team`).
- **E8 (amends R2) — the pre-hydration script must be inside `<head>`, and React 19 will not hoist it for us.** A `<script>` rendered inside `<body>` runs after the body's first paint, which is the flash R2 exists to prevent. The root layout therefore renders an explicit `<head>` containing one `<script dangerouslySetInnerHTML>`; `next/font`'s own `<link>` preloads are injected by the framework and are unaffected by an authored `<head>`.
- **E9 (amends R1) — `--radius-pill` changes value, and exactly one gate row measures it.** The README's pill radius is `999px`; `globals.css` has `--radius-pill: 20px` and `gate-m14-fidelity.mjs:947` asserts `[data-testid="slave-card"] [data-testid="status-pill"]` has `border-radius: 20px`. The token takes the README's value in Task 1 and that gate row is rewritten in Task 9, which is the task that rewrites the whole `NUMBERS` table anyway. No other gate and no test reads a pill radius.

---

## Global Constraints

- **Never a real model call in a test or in CI.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and a fake — `packages/providers/test/fake-claude.mjs` for the unit and integration suites, `scripts/gate-fakes/fake-claude.sh` and `scripts/gate-fakes/fake-cursor-agent.sh` for the gates. `gate:m12-providers` and `gate:m13-runtime` spawn the real paid binaries, are in neither `package.json`'s CI list nor `.github/workflows/ci.yml`, and **this milestone runs neither**: it dispatches no run and measures no model.
- One vitest process at a time (the shared test database truncates), and **never a gate beside vitest**. A running daemon breaks `subscribe.test.ts`.
- **`npm run web:build` never while `next dev` is running.** Before any `web:build`, run `pgrep -af "next dev"`; if one is up, `kill <pid>` it and **say so in the task report**. Restarting dev afterwards needs `rm -rf apps/web/.next` first, and `next dev` needs `.env` exported. **The user's dev server is running as this plan is written**, so the first task that builds will have to kill it. Every task in this plan changes `apps/web`, so **every task runs `npm run web:build`** — tsc and vitest do not see bundler-only breakage, and this milestone's whole surface is the bundler's.
- **No prettier.** There is no prettier config and no prettier dependency in this repository; `prettier --write` would reformat against the house style. Match the surrounding file by hand.
- Inside `apps/web/src`, import siblings **without** a `.js` suffix (`../server/sidebar`, not `../server/sidebar.js`); `packages/*` keep the `.js` suffix. Files under `apps/web/test/` import `../src/...` **with** the `.js` suffix, which is that directory's own existing convention (`apps/web/test/shell.test.tsx:4`) — match whichever file you are editing.
- Read an exit code with `${PIPESTATUS[0]}`; never `cmd | tail; echo $?` — that reports `tail`'s status.
- `npm run typecheck` — which also checks every `tsconfig.test.json` and `apps/web` — is what the pre-push hook runs; **a green `npx tsc --build` can still fail it**, so both run at the end of every task.
- The vocabulary word is **slave** (`gate:m26-vocabulary`). `docs/ia.md`, which Task 9 rewrites, is INSIDE its scope (`scripts/gate-m26-vocabulary.mjs:8-11` excludes `docs/superpowers` and `docs/decisions`, not `docs/`). Run `npm run gate:m26-vocabulary` after every task.
- **Labels never keys** (`docs/ia.md` rule 3). Every status word a person reads comes from `packages/domain/src/status/user.ts` (`USER_TASK_LABEL`, `USER_CARD_LABEL`, `USER_WORKSPACE_LABEL`, `USER_SUPERVISOR_LABEL`), every provider word from `PROVIDER_LABEL` via `lib/providerLabel.ts`, and the raw value stays in `title` or a `data-` attribute. No surface prints a bare enum member.
- **Real is not simulated** (rule 4). Simulation money is `§`, never `$`; `data-simulation="true"` stays on every block that renders it.
- **Nothing is removed, only moved** (rule 2). Every route, every `?tab=` value and every `?mode=` value in `docs/ia.md`'s tables still answers 200 after this milestone. `ProjectTabs.tsx` and `OverviewAdvanced.tsx` are deleted as WIDGETS, and spec R11 is the argument for why that is not a breach; the gate's stage 10 is the proof.
- **THERE IS NO MIGRATION.** `packages/db/prisma/schema.prisma` is in no task's file list. No column, index, enum member or table is added or changed.
- **NO NEW EVENT TYPE.** The catalogue stays at 61. `packages/domain/src/events/schema.ts`, `packages/db/src/enums.ts`, `packages/events/src/append.ts`, `apps/web/src/lib/activityFilters.ts`, `apps/web/src/lib/eventLabels.ts` and `docs/event-model.md` are in no task's file list. R9's threads are a GROUPING over rows that already exist.
- **NO NEW CONTROL VERB but one**, and it is a move rather than an addition: `clearHalt` (erratum E1) holds the two-column update `apps/orchestrator/src/cli.ts:1718-1729` already performs inline, and the CLI case is rewritten to call it so the tree ends with one copy and not two. `packages/domain`, `packages/db`, `packages/events` and `apps/orchestrator` are otherwise in no task's file list.
- Refusals are `ok()` / `err()`; **a refusal after a write inside `$transaction` must throw**. This milestone adds no refusal kind and changes no refusal text.
- **Untouched and asserted so — their BODIES are untouched; COMMENT LINES may be corrected:** `decide()`, `evaluateGuardrails`, `workspaceSpend`, `emergencyStop`'s own body, `pauseActiveRuns`'s own body, `requestPause`/`requestResume`, `requestChange`, `approveDecision`/`rejectDecision`, `listDecisions`, `buildSupervisorView`, `buildNeedsYou`, `buildOverviewSnapshot`, `buildActivityPage`, `buildTasksSnapshot`, `buildKnowledge`, `buildOrganization`, `buildAnalytics`, `buildEvidencePage`, `buildSkillsPage`, `buildProviderAdapters`, every `packages/providers` file, and all five hook-plane shell scripts. No task changes what any of them DOES. **A comment is not behaviour**: this milestone deletes four components whose names are cited in prose in nine files, and a comment that names a component which no longer exists is a worse defect than the edit that fixes it. Those nine are listed in Task 4's Files block as "comment-only edits", by path and line, and each is a one-line prose change with no code on it.
- Anything touching the database goes under `test/integration/` and is named `*.test.ts` — `vitest.config.ts`'s `integration` project includes `**/test/integration/**/*.test.ts` only (no `.tsx`), and only that project loads `test-setup/require-database.ts`. Component tests are `*.test.tsx` under `apps/web/test/` with `// @vitest-environment jsdom` as the **first line of the file**.
- **Run directories live under `SLAVEOFAI_STATE_DIR`** in tests and gates (M52 C1). `scripts/gate-m57-ui-redesign.mjs` gets its root from `gateStateDir()` through `loopbackChildEnv` and adds nothing of its own.
- **The DEV-DB rule.** Any scratch script that touches Prisma runs with `DATABASE_URL="$TEST_DATABASE_URL"`, and nothing outside `test-setup/` ever TRUNCATEs. The gates run against the development database through `--env-file=.env` and clean up only the rows they created, by exact name.
- **Test baseline: at or above M56a's final ladder — 370 test files, 6514 tests.** Task 1 runs `npx vitest run` once and **records the two numbers it actually sees in its task report**; every later ladder is at or above them and never below.
- **31 CI gates become 32.** `gate:m56a-provider-contract` is the 31st (`package.json:70`, `.github/workflows/ci.yml:88`). The new `gate:m57-ui-redesign` step goes immediately after it in both, and README's roster sentence and its count line say 32. **Find the count line by grep, never by line number:** `grep -n '^[0-9]\+ gates\.' README.md` (it is at `:1088` today and has moved every milestone).
- **`gate:m14-fidelity` is not in CI and regenerates PNGs.** Exactly ONE task in this plan (Task 9) runs it and commits its 13 regenerated images, in a commit of its own.
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Tb1HCWnBqh63E9diBxdxR6
  ```
- Every task ends with focused tests, `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck`, `npm run web:build` and a commit.
- **`$SCRATCHPAD` is this session's own scratchpad directory**, and every log and intermediate file this plan writes goes there. The design inputs are already in it: `$SCRATCHPAD/design/Slave of AI App.dc.html` (the prototype), `$SCRATCHPAD/design/README.md` (the handoff), `$SCRATCHPAD/fonts/woff2/*.woff2` (six files) and `$SCRATCHPAD/fonts/manifest.json` (the per-file `unicode-range`). Export it once at the start of the milestone.
- **The implementer never dispatches subagents.**

---

## File structure

**New, in `apps/web/src`:**

| File | Responsibility |
|---|---|
| `app/fonts/*.woff2` (6) | the self-hosted faces, copied from `$SCRATCHPAD/fonts/woff2/` |
| `components/theme/ThemeProvider.tsx` | `theme`/`resolved`/`setTheme`/`cycle`, the `matchMedia` subscription, the attribute and the `localStorage` write |
| `components/shell/AppShell.tsx` | the three-column grid, the 1280 px floor, the skip link |
| `components/shell/SidebarTree.tsx` | brand · ⌘K · Projects tree · VIEWS chips · globals · footer |
| `components/shell/Header.tsx` | breadcrumb · HALTED · budget · split button · action slot |
| `components/shell/HeaderActionProvider.tsx` | `useHeaderAction(node)` and the slot's reader |
| `components/shell/RightPanelProvider.tsx` | `{mode, collapsed, payload}` + `open`/`close`/`collapse` |
| `components/shell/RightPanel.tsx` | the 372 px aside, its 54 px header, its `»` |
| `components/shell/RightPanelDock.tsx` | the 52 px rail, `S` (badged) and `A` |
| `components/shell/RightPanelHost.tsx` | picks the content for the current mode |
| `components/supervisor/SupervisorThreadPanel.tsx` | the panel's whole body: `≡` list, thread, messages, decision cards, composer |
| `lib/routes.ts` | `SECTIONS`, `VIEWS`, `sectionOf`, `workspaceIdOf`, `isGlobalRoute`, `breadcrumbOf` |
| `server/sidebar.ts` | `buildSidebarTree(): Promise<readonly SidebarProject[]>` |
| `server/supervisorThreads.ts` | `buildSupervisorThreads(workspaceId)` → one thread per local day |
| `app/api/sidebar/route.ts` | `GET` → `buildSidebarTree()` |
| `app/api/w/[workspaceId]/runs/pause-all/route.ts` | `POST` → `pauseActiveRuns` |
| `app/api/w/[workspaceId]/runs/resume-all/route.ts` | `POST` → `requestResume` per paused run |
| `app/api/w/[workspaceId]/clear-halt/route.ts` | `POST` → `clearHalt` |
| `app/api/w/[workspaceId]/supervisor/threads/route.ts` | `GET` → `buildSupervisorThreads` |

**Modified:** `app/globals.css` (tokens), `app/layout.tsx` (fonts, `<head>` script, providers, `AppShell`), `app/w/[workspaceId]/layout.tsx` (the header's facts only), `lib/taskColumns.ts` (five columns), `server/shell.ts` (+`slavesPaused`), `hooks/useShellFacts.ts` (+one comparison), `components/OverviewClient.tsx`, `components/TasksClient.tsx`, `components/ProjectsClient.tsx`, `components/SlavePanel.tsx` (ONE className), `components/TaskDetailPanel.tsx` (ONE className), `components/workforce/WorkforceClient.tsx`, and the page clients each page task names.

**Deleted:** `components/Sidebar.tsx`, `components/project/ProjectHeader.tsx`, `components/project/ProjectTabs.tsx`, `components/project/ProjectSwitcher.tsx`, `components/project/OverviewAdvanced.tsx`, `apps/web/test/project-tabs.test.tsx`.

**Task order and why:** 1 lays the palette and the fonts under everything, aliased so nothing else has to move yet. 2 is two pure-ish modules and a route with no UI, so 3 can be a rendering task. 3 puts the frame and the tree up and deletes the old sidebar. 4 puts the header up, adds the three routes and deletes the old header, tabs and disclosure — the one task where the six gate scripts move. 5 fills the right panel. 6–8 are the pages, in the order a person meets them. 9 is the documentation, the new gate, the roster and the one PNG regeneration.

---

### Task 1: The palette, in two themes, with every old name still meaning something (R1, R2, R3, E8, E9)

**Files:**
- Create: `apps/web/src/app/fonts/InstrumentSans-normal-latin.woff2`, `…-normal-latin-ext.woff2`, `…-italic-latin.woff2`, `…-italic-latin-ext.woff2`, `apps/web/src/app/fonts/JetBrainsMono-normal-latin.woff2`, `…-normal-latin-ext.woff2` (copied, not authored)
- Create: `apps/web/src/components/theme/ThemeProvider.tsx`
- Create: `apps/web/test/theme.test.tsx`
- Create: `apps/web/test/tokens.test.ts`
- Modify: `apps/web/src/app/globals.css` (whole file rewritten below)
- Modify: `apps/web/src/app/layout.tsx` (whole file rewritten below)

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the first).
- Produces, for every later task: the token names `--bg --panel --card --line --line2 --t1 --t2 --t3 --hover --sel --accent --accent-ink --s-working --s-planning --s-review --s-waiting --s-blocked --s-done --s-paused --s-idle`, reachable as Tailwind utilities `bg-bg bg-panel bg-card border-line border-line2 text-t1 text-t2 text-t3 bg-hover bg-sel bg-accent text-accent text-accent-ink text-s-<tone> bg-s-<tone> border-s-<tone>`; the radii `rounded-chip rounded-nav rounded-tile rounded-card rounded-panel rounded-tile-lg rounded-panel-card rounded-page-card rounded-pill rounded-hair rounded-bubble`; the shadows `shadow-resting` and `shadow-card`; and `ThemeProvider` plus `useTheme(): { theme: ThemeChoice; resolved: 'light' | 'dark'; setTheme(next: ThemeChoice): void; cycle(): void }` with `export type ThemeChoice = 'system' | 'light' | 'dark'` and `export const THEME_STORAGE_KEY = 'theme'`.

- [ ] **Step 1: Copy the six font files in**

```bash
mkdir -p apps/web/src/app/fonts
cp "$SCRATCHPAD"/fonts/woff2/*.woff2 apps/web/src/app/fonts/
ls -la apps/web/src/app/fonts/
```

Expected: six files — `InstrumentSans-italic-latin-ext.woff2`, `InstrumentSans-italic-latin.woff2`, `InstrumentSans-normal-latin-ext.woff2`, `InstrumentSans-normal-latin.woff2`, `JetBrainsMono-normal-latin-ext.woff2`, `JetBrainsMono-normal-latin.woff2`, totalling about 128 KB.

- [ ] **Step 2: Write the failing test for the token sheet**

This is the alias invariant R1 rests on, and it is the one thing about a stylesheet a unit test can actually hold: every token name the tree already paints with must still be DECLARED, every new name must be declared in all THREE blocks, and the dark blocks must be guarded the way R2 requires. Create `apps/web/test/tokens.test.ts` (a `.ts` file, not `.tsx` — it renders nothing):

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(fileURLToPath(new URL('../src/app/globals.css', import.meta.url)), 'utf8')

/** The handoff README's own names (M57 R1). */
const NEW_TOKENS = [
  '--bg', '--panel', '--card', '--line', '--line2', '--t1', '--t2', '--t3',
  '--hover', '--sel', '--accent', '--accent-ink',
  '--s-working', '--s-planning', '--s-review', '--s-waiting',
  '--s-blocked', '--s-done', '--s-paused', '--s-idle',
]

/** Every name `src/` already paints with. Nothing here may stop being declared: ~90 files spell
 *  these as Tailwind utilities, and a deleted token is a silently unstyled page. */
const OLD_TOKENS = [
  '--bg-0', '--bg-1', '--bg-2', '--bg-selected', '--bg-card-alt', '--bg-canvas', '--bg-floor',
  '--text-1', '--text-2', '--text-3', '--text-faint', '--text-body', '--text-dim', '--line-hover',
  '--tone-working', '--tone-planning', '--tone-review', '--tone-waiting',
  '--tone-blocked', '--tone-done', '--tone-paused', '--tone-idle',
  '--radius-chip', '--radius-nav', '--radius-tile', '--radius-card', '--radius-panel',
  '--radius-pill', '--radius-hair', '--radius-bubble',
  '--shadow-resting', '--font-sans', '--font-mono',
]

/** The three blocks R2 requires, by their exact selectors. */
function blockOf(selector: string): string {
  const at = CSS.indexOf(selector)
  expect(at, `${selector} is not in globals.css`).toBeGreaterThan(-1)
  const open = CSS.indexOf('{', at)
  // Token blocks contain no nested braces, so the first `}` closes them.
  return CSS.slice(open, CSS.indexOf('}', open))
}

describe('the token sheet', () => {
  it('declares every new token on bare :root -- the LIGHT palette', () => {
    const light = blockOf('\n:root {')
    for (const token of NEW_TOKENS) expect(light, token).toContain(`${token}:`)
  })

  it('redefines every new token under the system-dark guard', () => {
    const dark = blockOf(":root:not([data-theme='light'])")
    for (const token of NEW_TOKENS) expect(dark, token).toContain(`${token}:`)
  })

  it('redefines every new token under the pinned-dark selector, so the toggle wins both ways', () => {
    const pinned = blockOf(":root[data-theme='dark']")
    for (const token of NEW_TOKENS) expect(pinned, token).toContain(`${token}:`)
  })

  it('guards the system-dark block so an explicit light choice beats the OS', () => {
    expect(CSS).toContain("@media (prefers-color-scheme: dark)")
    expect(CSS).toContain(":root:not([data-theme='light'])")
  })

  it('keeps every old token declared, as an alias of a new one (R1: nothing leaves the sheet)', () => {
    const light = blockOf('\n:root {')
    for (const token of OLD_TOKENS) expect(light, token).toContain(`${token}:`)
  })

  it('maps every new token into @theme inline, so Tailwind can reach it', () => {
    const theme = blockOf('@theme inline')
    for (const token of ['--color-bg', '--color-panel', '--color-card', '--color-line2',
      '--color-t1', '--color-t2', '--color-t3', '--color-hover', '--color-sel',
      '--color-accent', '--color-accent-ink', '--color-s-working', '--color-s-idle',
      '--radius-tile-lg', '--radius-panel-card', '--radius-page-card', '--shadow-card']) {
      expect(theme, token).toContain(`${token}:`)
    }
  })

  it('keeps every old @theme mapping, so no existing utility class stops resolving', () => {
    const theme = blockOf('@theme inline')
    for (const token of ['--color-bg-0', '--color-bg-1', '--color-bg-2', '--color-line',
      '--color-text-1', '--color-text-2', '--color-text-3', '--color-text-faint',
      '--color-text-body', '--color-text-dim', '--color-bg-selected', '--color-bg-card-alt',
      '--color-bg-canvas', '--color-bg-floor', '--color-line-hover',
      '--color-tone-working', '--color-tone-idle', '--radius-pill', '--font-sans', '--font-mono']) {
      expect(theme, token).toContain(`${token}:`)
    }
  })

  it('takes the README pill radius (999px), not the old 20px (erratum E9)', () => {
    expect(blockOf('\n:root {')).toContain('--radius-pill: 999px')
  })

  it('still kills every animation under prefers-reduced-motion', () => {
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)')
    expect(CSS).toContain('animation-name: none !important')
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run apps/web/test/tokens.test.ts
```

Expected: FAIL — several cases report `--bg` / `--panel` / `:root:not([data-theme='light'])` missing, and the pill-radius case reports `20px`.

- [ ] **Step 4: Rewrite the token half of `globals.css`**

Replace everything from line 1 down to and including the closing `}` of the `body` rule (that is, the `@import`, the `:root` block, the `@theme inline` block and the `body` rule — lines 1–118 of the current file) with the block below. **Everything from the `/* Motion pass … */` comment onwards is left exactly as it is**: the eleven `@keyframes`, the `prefers-reduced-motion` kill switch and the two `@media (prefers-reduced-motion: no-preference)` rules do not move a character.

```css
@import 'tailwindcss';

/* ============================================================================================
 * M57 R1 — ONE sheet, TWO themes, and every name that ever meant something still meaning it.
 *
 * The first block below is the handoff README's own vocabulary (`design_handoff_ui_redesign`,
 * "Design Tokens"), in its LIGHT values. The second block is the same names in dark, applied when
 * the operating system asks for dark AND the operator has not pinned light. The third is the same
 * names again under an explicit `data-theme="dark"`, so the toggle wins in both directions -- a
 * person on a light OS who chooses Dark gets dark, and a person on a dark OS who chooses Light
 * gets light. The ABSENCE of `data-theme` is "follow the system": that is why the media query is
 * guarded by `:not([data-theme='light'])` and not by the attribute's presence.
 *
 * The third block after that is the ALIAS LAYER, and it is the reason this milestone can land one
 * page at a time. Ninety-odd files in `src/` spell utilities like `bg-bg-1`, `text-text-2`,
 * `border-line`, `text-tone-blocked`. Deleting those tokens would break the build in one file and
 * the render in eighty-nine. Every one of them is still declared here, with its value rewritten to
 * `var(<the new token that means what it meant>)` -- so a component nobody has restyled yet keeps
 * rendering, and keeps rendering CORRECTLY IN BOTH THEMES, from the moment the switch exists. The
 * old six-rung text ramp collapses onto the new three deliberately: `--text-1`/`--text-body` are
 * primary, `--text-2`/`--text-dim` are muted, `--text-faint`/`--text-3` are labels. As each page is
 * restyled its file stops spelling the old name; when no file spells one, it can go. Not before.
 * ========================================================================================== */

:root {
  /* ---- The handoff palette, LIGHT ---------------------------------------------------------- */
  --bg: #f5f3ef;
  --panel: #faf9f6;
  --card: #ffffff;
  --line: rgba(30, 27, 22, 0.09);
  --line2: rgba(30, 27, 22, 0.16);
  --t1: #1b1a17;
  --t2: #5d5a53;
  --t3: #75716a;
  --hover: rgba(30, 27, 22, 0.045);
  --sel: rgba(30, 27, 22, 0.07);
  --accent: #1f8a7a;
  --accent-ink: #ffffff;
  --s-working: #0b7466;
  --s-planning: #4453d6;
  --s-review: #7d3fc9;
  --s-waiting: #9a6200;
  --s-blocked: #c43a31;
  --s-done: #1f7d45;
  --s-paused: #6b7080;
  --s-idle: #8a8b85;

  /* ---- Radii (README "Radius"): 5 ref chip · 6 kind chip/segment · 7 small button ·
   *      8 button/input/nav · 9-10 tile/card · 12 panel card · 14 page card · 999 pill.
   *      The first five keep the names M44 minted for them; the three the README adds are new;
   *      `--radius-pill` takes the README's 999 (M57 erratum E9 -- one gate row measured the old
   *      20, and Task 9 rewrites that row). `--radius-hair` (2px bar cap) and `--radius-bubble`
   *      (14px message bubble) are M44 erratum E14's and stay. */
  --radius-chip: 5px;
  --radius-nav: 6px;
  --radius-tile: 7px;
  --radius-card: 8px;
  --radius-panel: 9px;
  --radius-tile-lg: 10px;
  --radius-panel-card: 12px;
  --radius-page-card: 14px;
  --radius-pill: 999px;
  --radius-hair: 2px;
  --radius-bubble: 14px;

  /* ---- Shadows. The README allows cards exactly one (`0 1px 2px rgba(0,0,0,.04)`); that is
   *      `--shadow-card`. `--shadow-resting` is NOT that and is not being replaced by it: it names
   *      a FLOATING surface (a popover, a detail panel) and four components already ask for it. */
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.04);
  --shadow-resting: 0 4px 16px rgba(0, 0, 0, 0.12);

  /* ---- Type (M57 R3). Four `next/font/local` calls hand us four variables, one per family per
   *      subset, each carrying its own `unicode-range`; a codepoint outside the latin face's range
   *      falls through to the latin-ext face exactly as it would between two faces of one family.
   *      The literal fallbacks at the end are what a context rendering OUTSIDE this layout gets
   *      (a component test mounting a `ui/` component with no `<html>` wrapper). */
  --font-sans: var(--font-sans-latin), var(--font-sans-ext), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-mono-latin), var(--font-mono-ext), ui-monospace, monospace;

  /* ---- The alias layer (see the header comment). NOTHING here is a colour; every one is a
   *      pointer at one of the twenty names above, so all of them theme for free. */
  --bg-0: var(--bg);
  --bg-1: var(--panel);
  --bg-2: var(--card);
  --bg-selected: var(--sel);
  --bg-card-alt: var(--card);
  --bg-canvas: var(--bg);
  --bg-floor: var(--bg);
  --line-hover: var(--line2);
  --text-1: var(--t1);
  --text-body: var(--t1);
  --text-2: var(--t2);
  --text-dim: var(--t2);
  --text-faint: var(--t3);
  --text-3: var(--t3);
  --tone-working: var(--s-working);
  --tone-planning: var(--s-planning);
  --tone-review: var(--s-review);
  --tone-waiting: var(--s-waiting);
  --tone-blocked: var(--s-blocked);
  --tone-done: var(--s-done);
  --tone-paused: var(--s-paused);
  --tone-idle: var(--s-idle);
}

/* Dark, when the OS asks for it and nobody has pinned light. Only the twenty palette tokens are
 * restated -- the aliases, the radii and the type above point at these names, so they follow. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --bg: #141518;
    --panel: #191a1e;
    --card: #1e2025;
    --line: rgba(255, 255, 255, 0.08);
    --line2: rgba(255, 255, 255, 0.15);
    --t1: #eeede8;
    --t2: #a6a59d;
    --t3: #8f8f87;
    --hover: rgba(255, 255, 255, 0.05);
    --sel: rgba(255, 255, 255, 0.08);
    --accent: #3ccbb5;
    --accent-ink: #0f2521;
    --s-working: #2ee6cf;
    --s-planning: #7b8cff;
    --s-review: #c084fc;
    --s-waiting: #f5b34a;
    --s-blocked: #f87171;
    --s-done: #4ade80;
    --s-paused: #8a929e;
    --s-idle: #6b7280;
    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow-resting: 0 4px 16px rgba(0, 0, 0, 0.35);
  }
}

/* Dark, pinned. The same twenty values, outside the media query, so a person on a light OS who
 * chose Dark actually gets it. */
:root[data-theme='dark'] {
  --bg: #141518;
  --panel: #191a1e;
  --card: #1e2025;
  --line: rgba(255, 255, 255, 0.08);
  --line2: rgba(255, 255, 255, 0.15);
  --t1: #eeede8;
  --t2: #a6a59d;
  --t3: #8f8f87;
  --hover: rgba(255, 255, 255, 0.05);
  --sel: rgba(255, 255, 255, 0.08);
  --accent: #3ccbb5;
  --accent-ink: #0f2521;
  --s-working: #2ee6cf;
  --s-planning: #7b8cff;
  --s-review: #c084fc;
  --s-waiting: #f5b34a;
  --s-blocked: #f87171;
  --s-done: #4ade80;
  --s-paused: #8a929e;
  --s-idle: #6b7280;
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-resting: 0 4px 16px rgba(0, 0, 0, 0.35);
}

@theme inline {
  /* The handoff's own names. */
  --color-bg: var(--bg);
  --color-panel: var(--panel);
  --color-card: var(--card);
  --color-line: var(--line);
  --color-line2: var(--line2);
  --color-t1: var(--t1);
  --color-t2: var(--t2);
  --color-t3: var(--t3);
  --color-hover: var(--hover);
  --color-sel: var(--sel);
  --color-accent: var(--accent);
  --color-accent-ink: var(--accent-ink);
  --color-s-working: var(--s-working);
  --color-s-planning: var(--s-planning);
  --color-s-review: var(--s-review);
  --color-s-waiting: var(--s-waiting);
  --color-s-blocked: var(--s-blocked);
  --color-s-done: var(--s-done);
  --color-s-paused: var(--s-paused);
  --color-s-idle: var(--s-idle);

  /* Every mapping that existed before M57, kept so that not one utility class in `src/` stops
   * resolving. These point at the aliases, which point at the names above. */
  --color-bg-0: var(--bg-0);
  --color-bg-1: var(--bg-1);
  --color-bg-2: var(--bg-2);
  --color-text-1: var(--text-1);
  --color-text-2: var(--text-2);
  --color-text-faint: var(--text-faint);
  --color-text-3: var(--text-3);
  --color-text-body: var(--text-body);
  --color-text-dim: var(--text-dim);
  --color-bg-selected: var(--bg-selected);
  --color-bg-card-alt: var(--bg-card-alt);
  --color-bg-canvas: var(--bg-canvas);
  --color-bg-floor: var(--bg-floor);
  --color-line-hover: var(--line-hover);
  --color-tone-working: var(--tone-working);
  --color-tone-planning: var(--tone-planning);
  --color-tone-review: var(--tone-review);
  --color-tone-waiting: var(--tone-waiting);
  --color-tone-blocked: var(--tone-blocked);
  --color-tone-done: var(--tone-done);
  --color-tone-paused: var(--tone-paused);
  --color-tone-idle: var(--tone-idle);

  --radius-chip: var(--radius-chip);
  --radius-nav: var(--radius-nav);
  --radius-tile: var(--radius-tile);
  --radius-card: var(--radius-card);
  --radius-panel: var(--radius-panel);
  --radius-tile-lg: var(--radius-tile-lg);
  --radius-panel-card: var(--radius-panel-card);
  --radius-page-card: var(--radius-page-card);
  --radius-pill: var(--radius-pill);
  --radius-hair: var(--radius-hair);
  --radius-bubble: var(--radius-bubble);
  --shadow-card: var(--shadow-card);
  --shadow-resting: var(--shadow-resting);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
}

/* `color-scheme` tells the browser which way to paint the things CSS does not own -- form
 * controls, the scrollbar's own gutter, the canvas behind an over-scroll. Without it a light page
 * gets dark native widgets and vice versa. It follows the same three-way rule the palette does. */
:root {
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    color-scheme: dark;
  }
}
:root[data-theme='dark'] {
  color-scheme: dark;
}

body {
  background: var(--bg);
  color: var(--t1);
  font-family: var(--font-sans);
  /* README "Type": body is 14px. Every page's own sizes are relative to this one. */
  font-size: 14px;
  line-height: 1.4;
  text-wrap: pretty;
}

/* README "Scrollbars": 8px, transparent track, `--line2` thumb at radius 8, `--t3` on hover.
 * The prototype draws these on every descendant (`App.dc.html:19-24`); so do we. */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--line2) transparent;
}
*::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
*::-webkit-scrollbar-track {
  background: transparent;
}
*::-webkit-scrollbar-thumb {
  background: var(--line2);
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:hover {
  background: var(--t3);
}
*::-webkit-scrollbar-corner {
  background: transparent;
}
```

- [ ] **Step 5: Run the token test and watch it pass**

```bash
npx vitest run apps/web/test/tokens.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Write the failing test for the theme provider**

Create `apps/web/test/theme.test.tsx`. The `// @vitest-environment jsdom` line must be the FIRST line of the file.

```tsx
// @vitest-environment jsdom
import { render, screen, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThemeProvider, useTheme, THEME_STORAGE_KEY } from '../src/components/theme/ThemeProvider.js'

/** jsdom has no `matchMedia`. One stub, whose `matches` the test drives, plus the `change`
 *  listener the provider subscribes to so that `system` tracks the OS live. */
let systemDark = false
const listeners = new Set<(event: { matches: boolean }) => void>()

function installMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('dark') ? systemDark : false,
    media: query,
    addEventListener: (_type: string, fn: (event: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: (event: { matches: boolean }) => void) => listeners.delete(fn),
  }))
}

function Probe(): React.JSX.Element {
  const { theme, resolved, setTheme, cycle } = useTheme()
  return (
    <div>
      <span data-testid="mode">{theme}</span>
      <span data-testid="resolved">{resolved}</span>
      <button data-testid="cycle" type="button" onClick={cycle} />
      <button data-testid="to-light" type="button" onClick={() => setTheme('light')} />
    </div>
  )
}

beforeEach((): void => {
  systemDark = false
  listeners.clear()
  installMatchMedia()
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('the theme provider', () => {
  it('starts on "system" with no attribute stamped -- absent IS system (R2)', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('mode').textContent).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('resolves "system" against prefers-color-scheme, and tracks it live', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    expect(screen.getByTestId('resolved').textContent).toBe('light')
    act((): void => {
      systemDark = true
      for (const fn of listeners) fn({ matches: true })
    })
    expect(screen.getByTestId('resolved').textContent).toBe('dark')
    // Still SYSTEM: the OS changed, the operator's choice did not.
    expect(screen.getByTestId('mode').textContent).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('cycles System -> Light -> Dark -> System, stamping the attribute for the two pinned ones', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    const cycle = screen.getByTestId('cycle')
    act((): void => { cycle.click() })
    expect(screen.getByTestId('mode').textContent).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    act((): void => { cycle.click() })
    expect(screen.getByTestId('mode').textContent).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    act((): void => { cycle.click() })
    expect(screen.getByTestId('mode').textContent).toBe('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('persists the choice under the key the pre-hydration script reads', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>)
    act((): void => { screen.getByTestId('to-light').click() })
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(THEME_STORAGE_KEY).toBe('theme')
  })

  it('restores a stored choice AFTER mount -- never during hydration (scan finding 51)', async (): Promise<void> => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    render(<ThemeProvider><Probe /></ThemeProvider>)
    // `waitFor`, not a bare read: the first render is deliberately `system` on both sides of
    // hydration, and an effect corrects it a tick later. Asserting the first render would be
    // asserting the bug.
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('dark'))
    expect(screen.getByTestId('resolved').textContent).toBe('dark')
  })

  it('ignores a stored value that is not one of the three', async (): Promise<void> => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'neon')
    render(<ThemeProvider><Probe /></ThemeProvider>)
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('system'))
  })

  it('survives a localStorage that throws (private mode, blocked site data)', () => {
    const blown = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    vi.stubGlobal('localStorage', blown)
    expect(() => render(<ThemeProvider><Probe /></ThemeProvider>)).not.toThrow()
    expect(screen.getByTestId('mode').textContent).toBe('system')
  })
})
```

- [ ] **Step 7: Run it and watch it fail**

```bash
npx vitest run apps/web/test/theme.test.tsx
```

Expected: FAIL — `Failed to resolve import "../src/components/theme/ThemeProvider.js"`.

- [ ] **Step 8: Write the theme provider**

Create `apps/web/src/components/theme/ThemeProvider.tsx`:

```tsx
'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

/** The three values the operator can choose between (M57 R2). `system` is the default and is
 *  represented by the ABSENCE of `data-theme` on `<html>` -- which is what lets the stylesheet
 *  answer it with one `prefers-color-scheme` media query instead of a JavaScript read. */
export type ThemeChoice = 'system' | 'light' | 'dark'

/** The `localStorage` key. Exported because the pre-hydration script in `app/layout.tsx` spells
 *  the same string as a literal -- that script cannot import anything, it runs before the bundle
 *  exists -- and a test that pins the two together is the only thing keeping them in step. */
export const THEME_STORAGE_KEY = 'theme'

const CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark']

function isChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (CHOICES as readonly string[]).includes(value)
}

/** Every `localStorage` touch is wrapped: a private window, blocked site data, or a browser that
 *  throws on the accessor itself must degrade to "system", never to a blank page. */
function readStored(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isChoice(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

function writeStored(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice)
  } catch {
    /* nothing to do: the attribute below still applies for this session */
  }
}

/** `light` | `dark`, with no third state -- what the page is ACTUALLY painted as right now. */
export type ResolvedTheme = 'light' | 'dark'

export interface ThemeState {
  readonly theme: ThemeChoice
  readonly resolved: ResolvedTheme
  readonly setTheme: (next: ThemeChoice) => void
  /** System -> Light -> Dark -> System, the sidebar footer pill's one click (prototype
   *  `App.dc.html:255`). */
  readonly cycle: () => void
}

const ThemeContext = createContext<ThemeState | null>(null)

const DARK_QUERY = '(prefers-color-scheme: dark)'

export function ThemeProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  // `'system'` on the server AND on the first client render, then corrected by an effect (M57
  // erratum, scan finding 51).
  //
  // The tempting version reads `localStorage` in the `useState` initialiser so the first client
  // render already agrees with the stored choice. It does not work: the initialiser runs on the
  // HYDRATION render, so React compares a client tree that says `dark` against a server tree that
  // said `system`, and every node rendered from `theme` -- the sidebar pill's `data-theme-mode`,
  // its glyph and word, Settings' segmented control -- mismatches and logs a hydration error on
  // every page load for anybody who has chosen a theme.
  //
  // THE FLASH IS NOT THIS COMPONENT'S JOB. The inline `<head>` script has already stamped
  // `data-theme` before the first paint, and the stylesheet is what paints -- so the page is the
  // right colour from the first frame whatever React thinks. What this state drives is the two
  // CONTROLS that say which mode is selected, and those correcting themselves one tick after
  // hydration is invisible.
  const [theme, setThemeState] = useState<ThemeChoice>('system')
  const [systemDark, setSystemDark] = useState(false)

  // The read, after mount. `useEffect` never runs on the server and never during hydration, so
  // there is nothing for React to compare.
  useEffect((): void => {
    setThemeState(readStored())
  }, [])

  // `system` must FOLLOW the operating system while the page is open, not only on load -- a person
  // whose machine flips at sunset should see this flip with it (README "Interactions": "system
  // follows prefers-color-scheme live").
  useEffect((): (() => void) | undefined => {
    const query = window.matchMedia?.(DARK_QUERY)
    if (query === undefined) return undefined
    const onChange = (event: { matches: boolean }): void => setSystemDark(event.matches)
    query.addEventListener('change', onChange)
    setSystemDark(query.matches)
    return (): void => query.removeEventListener('change', onChange)
  }, [])

  // The attribute is the ONE thing the stylesheet reads. `system` REMOVES it rather than setting
  // it to some third value, because "absent" is what the media query's `:not([data-theme='light'])`
  // guard is written against.
  useEffect((): void => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const setTheme = useCallback((next: ThemeChoice): void => {
    setThemeState(next)
    writeStored(next)
  }, [])

  const cycle = useCallback((): void => {
    setThemeState((was) => {
      const next: ThemeChoice = was === 'system' ? 'light' : was === 'light' ? 'dark' : 'system'
      writeStored(next)
      return next
    })
  }, [])

  const value = useMemo<ThemeState>(
    () => ({
      theme,
      resolved: theme === 'system' ? (systemDark ? 'dark' : 'light') : theme,
      setTheme,
      cycle,
    }),
    [theme, systemDark, setTheme, cycle],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** Throws rather than returning a default: every consumer of this hook is inside the root layout's
 *  provider by construction, so a null here is a wiring bug and a silent light theme would hide it. */
export function useTheme(): ThemeState {
  const value = useContext(ThemeContext)
  if (value === null) throw new Error('useTheme must be used inside <ThemeProvider>')
  return value
}

/** The glyph and the word the sidebar footer's pill and the Settings segmented control both show
 *  (README "Shell" and "Global Settings"; prototype `App.dc.html:254`). A label table beside the
 *  thing it names -- `docs/ia.md` rule 3's second half: this is not a status, so it keeps its own. */
export const THEME_GLYPH: Record<ThemeChoice, string> = { system: '◐', light: '☀', dark: '☾' }
export const THEME_LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' }
```

- [ ] **Step 9: Run the theme test and watch it pass**

```bash
npx vitest run apps/web/test/theme.test.tsx
```

Expected: PASS, 7 tests.

- [ ] **Step 10: Rewrite the root layout — fonts, the pre-hydration script, the provider**

Replace the whole of `apps/web/src/app/layout.tsx` with this. `AppShell` does not exist yet, so
`<Sidebar />` and `<main>` stay exactly where they are; Task 3 replaces those four lines and nothing
else in this file.

```tsx
import type React from 'react'
import localFont from 'next/font/local'
import './globals.css'
import { Sidebar } from '../components/Sidebar'
import { ThemeProvider, THEME_STORAGE_KEY } from '../components/theme/ThemeProvider'

/**
 * M57 R3 — the handoff's two families, self-hosted, one `localFont()` call PER FAMILY PER SUBSET.
 *
 * Per-file `unicode-range` is the whole point (a page of English must not download the latin-ext
 * face), and `next/font/local`'s `src` array entries carry only `path`/`weight`/`style` -- there is
 * no `unicodeRange` field. `declarations` IS accepted, and is applied to every `@font-face` a call
 * generates, so ONE CALL PER SUBSET is the shape that keeps the split. Two families in one
 * `font-family` stack fall back on a codepoint outside the first's range exactly the way two faces
 * of one family would.
 *
 * `adjustFontFallback: false` on all four is load-bearing, not tidying: with it on, `next/font`
 * synthesises a metric-matched local fallback and puts it INSIDE each variable's value -- and that
 * fallback family carries no `unicode-range`, so it would sit between the latin face and the
 * latin-ext face in the composed stack and swallow every latin-ext glyph. The literal fallbacks
 * live at the end of `globals.css`'s `--font-sans`/`--font-mono` instead, where they belong.
 *
 * The `unicode-range` strings are Google Fonts' own for these two subsets, taken verbatim from the
 * manifest that came with the downloaded files.
 */
const LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'
const LATIN_EXT =
  'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF'

const sansLatin = localFont({
  src: [
    { path: './fonts/InstrumentSans-normal-latin.woff2', weight: '400 700', style: 'normal' },
    { path: './fonts/InstrumentSans-italic-latin.woff2', weight: '400 700', style: 'italic' },
  ],
  declarations: [{ prop: 'unicode-range', value: LATIN }],
  adjustFontFallback: false,
  variable: '--font-sans-latin',
  display: 'swap',
})

const sansExt = localFont({
  src: [
    { path: './fonts/InstrumentSans-normal-latin-ext.woff2', weight: '400 700', style: 'normal' },
    { path: './fonts/InstrumentSans-italic-latin-ext.woff2', weight: '400 700', style: 'italic' },
  ],
  declarations: [{ prop: 'unicode-range', value: LATIN_EXT }],
  adjustFontFallback: false,
  variable: '--font-sans-ext',
  display: 'swap',
})

const monoLatin = localFont({
  src: [{ path: './fonts/JetBrainsMono-normal-latin.woff2', weight: '400 600', style: 'normal' }],
  declarations: [{ prop: 'unicode-range', value: LATIN }],
  adjustFontFallback: false,
  variable: '--font-mono-latin',
  display: 'swap',
})

const monoExt = localFont({
  src: [{ path: './fonts/JetBrainsMono-normal-latin-ext.woff2', weight: '400 600', style: 'normal' }],
  declarations: [{ prop: 'unicode-range', value: LATIN_EXT }],
  adjustFontFallback: false,
  variable: '--font-mono-ext',
  display: 'swap',
})

const FONT_VARIABLES = `${sansLatin.variable} ${sansExt.variable} ${monoLatin.variable} ${monoExt.variable}`

/**
 * M57 R2 / erratum E8 — the flash killer.
 *
 * It is inline, it is in `<head>`, and it cannot import anything: it runs before the bundle exists.
 * That is why `THEME_STORAGE_KEY` is interpolated into it rather than spelled twice, and why
 * `apps/web/test/theme.test.tsx` pins the constant's value -- those are the two halves of keeping
 * one string in one place across a boundary a module graph cannot cross.
 *
 * It stamps NOTHING for `system`: absent is system, and the stylesheet's media query answers it.
 */
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}}catch(e){}})()`

export const metadata = { title: 'Slave of AI' }

export default function RootLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <html lang="en" className={FONT_VARIABLES} suppressHydrationWarning>
      {/* An explicit `<head>` so the script above is genuinely in it (erratum E8): a `<script>`
        * rendered in `<body>` runs after the body has painted, which is the flash. `next/font`'s
        * own preload `<link>`s are injected by the framework and are unaffected by an authored
        * head. `suppressHydrationWarning` on `<html>` because the script mutates the element's
        * attributes before React sees it -- which is exactly its job. */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-screen">
        <ThemeProvider>
          <Sidebar />
          {/* The one `main` landmark, and the skip link's target (M44 R6). `tabIndex={-1}` so the
            * anchor can actually move focus here -- a `<main>` is not focusable by default, and a
            * skip link that only scrolls has moved the viewport and not the keyboard. */}
          <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col focus:outline-none">
            {children}
          </main>
        </ThemeProvider>
      </body>
    </html>
  )
}
```

- [ ] **Step 11: Run the whole suite and RECORD the baseline**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: every test passes. **Write the two numbers the run reports — `Test Files N passed` and
`Tests M passed` — into the task report.** They must be at or above 370 files / 6514 tests; this
task adds two files and sixteen tests, so expect about 372 / 6530.

- [ ] **Step 12: Build, with the dev-server rule**

```bash
pgrep -af "next dev" || echo "no dev server"
# If a pid is printed: kill it, and SAY SO IN THE TASK REPORT.
npm run web:build 2>&1 | tail -30; echo "exit=${PIPESTATUS[0]}"
```

Expected: `exit=0`, and the route table printed. This is the step that proves the four `localFont()`
calls resolve their files and that `declarations` is accepted — neither `tsc` nor `vitest` can see
either.

- [ ] **Step 13: Ladder and commit**

```bash
npm run gate:m26-vocabulary && npx tsc --build && npm run --silent typecheck
git add apps/web/src/app/fonts apps/web/src/app/globals.css apps/web/src/app/layout.tsx \
        apps/web/src/components/theme/ThemeProvider.tsx \
        apps/web/test/tokens.test.ts apps/web/test/theme.test.tsx
git commit -m "$(cat <<'MSG'
feat(m57): t1 — one sheet, two themes, and every old token still meaning something

The handoff README's twenty token names land for light, for system-dark and for
pinned-dark, and every name `src/` already paints with stays declared as an alias of
the one that means what it meant -- so ninety files keep rendering, correctly, in both
themes, before a single one of them is restyled. IBM Plex leaves; Instrument Sans and
JetBrains Mono arrive self-hosted, four `localFont()` calls so each subset keeps its own
`unicode-range`. The flash is killed in `<head>`, before the bundle exists.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tb1HCWnBqh63E9diBxdxR6
MSG
)"
```

---

### Task 2: One function that knows where you are, one read model that knows what is beside you (R5, R6, E2, E3)

**Files:**
- Create: `apps/web/src/lib/routes.ts`
- Create: `apps/web/src/server/sidebar.ts`
- Create: `apps/web/src/app/api/sidebar/route.ts`
- Create: `apps/web/test/routes.test.ts`
- Create: `apps/web/test/integration/sidebar-tree.test.ts`
- Modify: `apps/web/src/server/shell.ts` (add `counts.slavesPaused` — plan erratum E2, spec erratum E13)
- Modify: `apps/web/src/hooks/useShellFacts.ts` (one more comparison in `sameFacts`)
- Modify: `apps/web/src/components/OverviewClient.tsx` (one line in the hand-built `shellFacts`)
- Modify: `apps/web/src/server/tasks.ts` (if it hand-builds `shellFacts`; if it calls `buildShellFacts`, no edit — check first)

**Interfaces:**
- Consumes from Task 1: nothing (this task renders nothing).
- Produces, for Tasks 3–9:
  - `lib/routes.ts`: `export type Section = 'overview' | 'tasks' | 'organization' | 'knowledge' | 'activity' | 'settings'`; `export type ViewId = 'graph' | 'office' | 'analytics'`; `export const SECTIONS: readonly { id: Section; label: string; href: (workspaceId: string) => string }[]`; `export const VIEWS: readonly { id: ViewId; label: string; href: (workspaceId: string) => string }[]`; `export function sectionOf(pathname: string): Section | null`; `export function viewOf(pathname: string): ViewId | null`; `export function workspaceIdOf(pathname: string): string | null`; `export function isGlobalRoute(pathname: string): boolean`; `export interface Crumb { readonly text: string; readonly last: boolean }`; `export function breadcrumbOf(pathname: string, projectName: string | null): readonly Crumb[]`.
  - `server/sidebar.ts`: `export interface SidebarProject { readonly id: string; readonly name: string; readonly archived: boolean; readonly status: UserWorkspaceState; readonly statusLabel: string; readonly needsYouCount: number; readonly tasksActive: number }` and `export async function buildSidebarTree(): Promise<readonly SidebarProject[]>`.
  - `GET /api/sidebar` → `SidebarProject[]`.
  - `ShellFacts.counts.slavesPaused: number`.

- [ ] **Step 1: Write the failing test for `lib/routes.ts`**

Create `apps/web/test/routes.test.ts` (a `.ts` file — this module imports no React and needs no DOM):

```ts
import { describe, expect, it } from 'vitest'
import {
  SECTIONS,
  VIEWS,
  breadcrumbOf,
  isGlobalRoute,
  sectionOf,
  viewOf,
  workspaceIdOf,
} from '../src/lib/routes.js'

describe('SECTIONS', () => {
  it('is the six sections in the sidebar tree, in the README order, keyed by their ROUTE segment', () => {
    expect(SECTIONS.map((s) => s.id)).toEqual([
      'overview', 'tasks', 'organization', 'knowledge', 'activity', 'settings',
    ])
  })

  it('labels the organization route "Team" -- the label changes, the route does not (ia.md rule 2)', () => {
    expect(SECTIONS.find((s) => s.id === 'organization')?.label).toBe('Team')
    expect(SECTIONS.find((s) => s.id === 'organization')?.href('w1')).toBe('/w/w1/organization')
  })

  it('points Overview at the bare project route', () => {
    expect(SECTIONS.find((s) => s.id === 'overview')?.href('w1')).toBe('/w/w1')
  })
})

describe('VIEWS', () => {
  it('is Graph, Office and this project scoped Analytics -- what Advanced was (M44 R2)', () => {
    expect(VIEWS.map((v) => v.id)).toEqual(['graph', 'office', 'analytics'])
    expect(VIEWS.map((v) => v.label)).toEqual(['Graph', 'Office', 'Analytics'])
    expect(VIEWS.find((v) => v.id === 'graph')?.href('w1')).toBe('/w/w1/graph')
    expect(VIEWS.find((v) => v.id === 'office')?.href('w1')).toBe('/w/w1/office')
    expect(VIEWS.find((v) => v.id === 'analytics')?.href('w1')).toBe('/analytics?workspace=w1')
  })
})

describe('sectionOf', () => {
  it('answers the section a project route is on', () => {
    expect(sectionOf('/w/w1')).toBe('overview')
    expect(sectionOf('/w/w1/tasks')).toBe('tasks')
    expect(sectionOf('/w/w1/organization')).toBe('organization')
    expect(sectionOf('/w/w1/knowledge')).toBe('knowledge')
    expect(sectionOf('/w/w1/activity')).toBe('activity')
    expect(sectionOf('/w/w1/settings')).toBe('settings')
  })

  it('answers a deeper path by its first segment, so a sub-route still lights its row', () => {
    expect(sectionOf('/w/w1/tasks/anything')).toBe('tasks')
  })

  it('answers null for a VIEW and for every global route -- a view is not a section', () => {
    expect(sectionOf('/w/w1/graph')).toBeNull()
    expect(sectionOf('/w/w1/office')).toBeNull()
    expect(sectionOf('/')).toBeNull()
    expect(sectionOf('/workforce')).toBeNull()
    expect(sectionOf('/analytics')).toBeNull()
  })

  it('tolerates a trailing slash', () => {
    expect(sectionOf('/w/w1/')).toBe('overview')
    expect(sectionOf('/w/w1/tasks/')).toBe('tasks')
  })
})

describe('viewOf', () => {
  it('answers graph and office by path, and analytics only when it carries this project scope', () => {
    expect(viewOf('/w/w1/graph')).toBe('graph')
    expect(viewOf('/w/w1/office')).toBe('office')
    // `/analytics` has no `/w/:id` prefix, so `viewOf` cannot tell WHICH project it is scoped to;
    // the chip's own `aria-current` is driven by the search string, not by this function.
    expect(viewOf('/analytics')).toBeNull()
    expect(viewOf('/w/w1/tasks')).toBeNull()
  })
})

describe('workspaceIdOf', () => {
  it('lifts the id out of any /w/:id route and answers null elsewhere', () => {
    expect(workspaceIdOf('/w/abc123')).toBe('abc123')
    expect(workspaceIdOf('/w/abc123/tasks')).toBe('abc123')
    expect(workspaceIdOf('/w/abc123/graph')).toBe('abc123')
    expect(workspaceIdOf('/')).toBeNull()
    expect(workspaceIdOf('/workforce')).toBeNull()
    expect(workspaceIdOf('/w')).toBeNull()
    expect(workspaceIdOf('/w/')).toBeNull()
  })
})

describe('isGlobalRoute', () => {
  it('is true for everything outside /w/:id -- the routes with no right panel (R8)', () => {
    for (const path of ['/', '/workforce', '/settings', '/sim', '/sim/s1', '/sim/compare', '/analytics', '/login']) {
      expect(isGlobalRoute(path), path).toBe(true)
    }
  })

  it('is false inside a project, including its views', () => {
    for (const path of ['/w/w1', '/w/w1/tasks', '/w/w1/graph', '/w/w1/office']) {
      expect(isGlobalRoute(path), path).toBe(false)
    }
  })
})

describe('breadcrumbOf', () => {
  it('reads Projects / <project> / <section>, with only the last one emphasised', () => {
    expect(breadcrumbOf('/w/w1/tasks', 'Checkout rewrite')).toEqual([
      { text: 'Projects', last: false },
      { text: 'Checkout rewrite', last: false },
      { text: 'Tasks', last: true },
    ])
  })

  it('ends at the project on its Overview -- Overview is the project, not a place inside it', () => {
    expect(breadcrumbOf('/w/w1', 'Checkout rewrite')).toEqual([
      { text: 'Projects', last: false },
      { text: 'Checkout rewrite', last: true },
    ])
  })

  it('names a VIEW where a section would be', () => {
    expect(breadcrumbOf('/w/w1/graph', 'Checkout rewrite')).toEqual([
      { text: 'Projects', last: false },
      { text: 'Checkout rewrite', last: false },
      { text: 'Graph', last: true },
    ])
  })

  it('says the project id when the name has not arrived yet, never an empty crumb', () => {
    expect(breadcrumbOf('/w/w1/tasks', null)).toEqual([
      { text: 'Projects', last: false },
      { text: 'w1', last: false },
      { text: 'Tasks', last: true },
    ])
  })

  it('is one crumb on every global route', () => {
    expect(breadcrumbOf('/', null)).toEqual([{ text: 'Projects', last: true }])
    expect(breadcrumbOf('/workforce', null)).toEqual([{ text: 'Workforce', last: true }])
    expect(breadcrumbOf('/sim/s1', null)).toEqual([{ text: 'Simulations', last: true }])
    expect(breadcrumbOf('/settings', null)).toEqual([{ text: 'Settings', last: true }])
    expect(breadcrumbOf('/analytics', null)).toEqual([{ text: 'Analytics', last: true }])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/web/test/routes.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/lib/routes.js"`.

- [ ] **Step 3: Write `lib/routes.ts`**

Create `apps/web/src/lib/routes.ts`:

```ts
/**
 * Where you are, said once (M57 R6).
 *
 * `ProjectTabs.tsx` used to hold this — a `TABS` array, an `ADVANCED` array and an `isLive`
 * predicate, all inside a client component — and `Sidebar.tsx` held a second, different answer to
 * the same question in its own `isCurrent`. This module is the one answer: the sidebar tree, the
 * header's breadcrumb and `gate:m57-ui-redesign` all read it, and nothing else in the tree may
 * derive a section from a pathname.
 *
 * No React import, deliberately: it is a pure table plus five string functions, so it is unit
 * tested with no DOM and the gate can recompute the same table it renders.
 *
 * THE ROUTES DO NOT CHANGE. `docs/ia.md` rule 2 is about destinations, and every destination the
 * old tab strip and its `Advanced ▾` menu pointed at is here, at the same URL. Only two LABELS
 * move: `/w/:id/organization` is called `Team` (what the page is about is the people on it, and
 * "Organization" was the graph mode's word) and the three `Advanced` items are called `VIEWS`.
 */

export type Section = 'overview' | 'tasks' | 'organization' | 'knowledge' | 'activity' | 'settings'

export type ViewId = 'graph' | 'office' | 'analytics'

export interface SectionSpec {
  readonly id: Section
  readonly label: string
  readonly href: (workspaceId: string) => string
}

/** The six rows nested under the current project in the sidebar tree, in the README's order.
 *  `id` is the ROUTE SEGMENT, not the label — that is what makes `sectionOf` a lookup and what
 *  lets `gate-m49-memory.mjs`'s set assertion carry over unchanged (plan erratum E7). */
export const SECTIONS: readonly SectionSpec[] = [
  { id: 'overview', label: 'Overview', href: (id) => `/w/${id}` },
  { id: 'tasks', label: 'Tasks', href: (id) => `/w/${id}/tasks` },
  { id: 'organization', label: 'Team', href: (id) => `/w/${id}/organization` },
  { id: 'knowledge', label: 'Knowledge', href: (id) => `/w/${id}/knowledge` },
  { id: 'activity', label: 'Activity', href: (id) => `/w/${id}/activity` },
  { id: 'settings', label: 'Settings', href: (id) => `/w/${id}/settings` },
]

export interface ViewSpec {
  readonly id: ViewId
  readonly label: string
  readonly href: (workspaceId: string) => string
}

/** The `VIEWS` chip group — exactly what `Advanced ▾` held (M44 R2, `docs/ia.md`), visible now
 *  instead of behind a menu. Analytics keeps the global route and this project's `?workspace=`
 *  scope, unchanged and bookmarkable. */
export const VIEWS: readonly ViewSpec[] = [
  { id: 'graph', label: 'Graph', href: (id) => `/w/${id}/graph` },
  { id: 'office', label: 'Office', href: (id) => `/w/${id}/office` },
  { id: 'analytics', label: 'Analytics', href: (id) => `/analytics?workspace=${id}` },
]

/** `/w/<id>` and `/w/<id>/<rest>` → `<id>`; anything else → null. A bare `/w` and a bare `/w/`
 *  are not project routes and must not answer an empty string. */
export function workspaceIdOf(pathname: string): string | null {
  const parts = pathname.split('/').filter((part) => part.length > 0)
  if (parts[0] !== 'w') return null
  const id = parts[1]
  return id === undefined || id.length === 0 ? null : id
}

/** True for every route outside a project — the ones with no right panel and no dock (R8). */
export function isGlobalRoute(pathname: string): boolean {
  return workspaceIdOf(pathname) === null
}

const SECTION_IDS: ReadonlySet<string> = new Set(SECTIONS.map((section) => section.id))
const VIEW_IDS: ReadonlySet<string> = new Set(['graph', 'office'])

/** The segment after `/w/<id>`, or null. Shared by `sectionOf` and `viewOf` so the two can never
 *  disagree about what a path's third part is. */
function segmentOf(pathname: string): string | null {
  const parts = pathname.split('/').filter((part) => part.length > 0)
  if (parts[0] !== 'w' || parts[1] === undefined) return null
  return parts[2] ?? null
}

/**
 * Which of the six sections a pathname is on, or null.
 *
 * A bare `/w/<id>` is `overview` (it is the project's own page), a deeper path answers by its
 * FIRST segment (so `/w/<id>/tasks?filter=x` and any future `/w/<id>/tasks/<sub>` both light the
 * Tasks row), and a VIEW answers null — a view is beside the sections, not one of them.
 */
export function sectionOf(pathname: string): Section | null {
  if (workspaceIdOf(pathname) === null) return null
  const segment = segmentOf(pathname)
  if (segment === null) return 'overview'
  return SECTION_IDS.has(segment) ? (segment as Section) : null
}

/** Which VIEW a project pathname is on. Analytics can never answer here: its route has no `/w/:id`
 *  prefix at all, so the chip's own current-ness is decided from the search string by its caller. */
export function viewOf(pathname: string): ViewId | null {
  if (workspaceIdOf(pathname) === null) return null
  const segment = segmentOf(pathname)
  return segment !== null && VIEW_IDS.has(segment) ? (segment as ViewId) : null
}

export interface Crumb {
  readonly text: string
  /** The last crumb is the one the header paints in `--t1` at weight 600; the rest are `--t3`. */
  readonly last: boolean
}

/** What each global route calls itself in the breadcrumb. One entry per top-level destination;
 *  a path that matches none of them falls back to `Projects`, which is where the tree's root is. */
const GLOBAL_CRUMB: readonly { readonly prefix: string; readonly text: string }[] = [
  { prefix: '/workforce', text: 'Workforce' },
  { prefix: '/sim', text: 'Simulations' },
  { prefix: '/settings', text: 'Settings' },
  { prefix: '/analytics', text: 'Analytics' },
  { prefix: '/login', text: 'Sign in' },
]

/**
 * `Projects / <project> / <section>` (README "Shell" → Header).
 *
 * The project's Overview ends at the project: Overview IS the project's page, and a third crumb
 * reading "Overview" would be saying the same thing twice. `projectName` is null until the layout's
 * read lands, and the id stands in — never an empty crumb, which would render as a stray separator.
 */
export function breadcrumbOf(pathname: string, projectName: string | null): readonly Crumb[] {
  const workspaceId = workspaceIdOf(pathname)
  if (workspaceId === null) {
    const hit = GLOBAL_CRUMB.find(
      (entry) => pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`),
    )
    return [{ text: hit?.text ?? 'Projects', last: true }]
  }
  const leaf =
    SECTIONS.find((section) => section.id === sectionOf(pathname) && section.id !== 'overview')?.label ??
    VIEWS.find((view) => view.id === viewOf(pathname))?.label ??
    null
  const project: Crumb = { text: projectName ?? workspaceId, last: leaf === null }
  const crumbs: Crumb[] = [{ text: 'Projects', last: false }, project]
  if (leaf !== null) crumbs.push({ text: leaf, last: true })
  return crumbs
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run apps/web/test/routes.test.ts
```

Expected: PASS, 18 tests.

- [ ] **Step 5: Write the failing test for the sidebar read model**

Create `apps/web/test/integration/sidebar-tree.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildSidebarTree } from '../../src/server/sidebar.js'
import { truncateAll } from './projectFixture.js'

/**
 * The sidebar tree's own read model (M57 R5, plan erratum E3).
 *
 * Its own four queries and NOT `listProjects()`: that function makes six grouped reads plus a
 * `findMany` with a nested include of every team's every slave, and it would run in the ROOT
 * layout — on every page in the product. What the tree draws is a name, a dot and a number.
 */
async function seedProject(
  name: string,
  options: { readonly halted?: boolean; readonly archived?: boolean; readonly autoMerge?: boolean } = {},
): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: {
      name,
      repoPath: `/tmp/m57-sidebar-${name}`,
      verifyCommands: ['true'],
      setupCommands: [],
      autoMerge: options.autoMerge ?? false,
      haltedReason: options.halted === true ? 'emergency stop by a test' : null,
      haltedAt: options.halted === true ? new Date() : null,
      archivedAt: options.archived === true ? new Date() : null,
    },
  })
  return workspace.id
}

async function seedTask(workspaceId: string, status: string, integratedAt: Date | null = null): Promise<void> {
  await prisma.task.create({
    data: {
      workspaceId,
      title: `${status} task`,
      description: 'seeded',
      role: 'dev',
      status: status as never,
      integratedAt,
    },
  })
}

describe('buildSidebarTree', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('lists every non-archived project by name, ascending -- the order the tree draws', async (): Promise<void> => {
    await seedProject('Zebra')
    await seedProject('Alpha')
    await seedProject('Middle')

    const tree = await buildSidebarTree()

    expect(tree.map((row) => row.name)).toEqual(['Alpha', 'Middle', 'Zebra'])
  })

  it('hides an archived project -- it runs nothing and has nowhere to take you', async (): Promise<void> => {
    await seedProject('Live')
    await seedProject('Filed', { archived: true })

    const tree = await buildSidebarTree()

    expect(tree.map((row) => row.name)).toEqual(['Live'])
  })

  it('gives every row the domain word for the project, not a word of its own', async (): Promise<void> => {
    const idle = await seedProject('Quiet')
    const halted = await seedProject('Stopped', { halted: true })
    const working = await seedProject('Busy')
    await seedTask(working, 'running')

    const tree = await buildSidebarTree()
    const byName = new Map(tree.map((row) => [row.name, row]))

    expect(byName.get('Quiet')?.status).toBe('idle')
    expect(byName.get('Quiet')?.statusLabel).toBe('IDLE')
    expect(byName.get('Stopped')?.status).toBe('halted')
    expect(byName.get('Stopped')?.statusLabel).toBe('HALTED')
    expect(byName.get('Busy')?.status).toBe('working')
    expect(byName.get('Busy')?.statusLabel).toBe('WORKING')
  })

  it('counts a blocked task and a pending decision, and says WAITING FOR YOU', async (): Promise<void> => {
    const workspaceId = await seedProject('Stuck')
    await seedTask(workspaceId, 'blocked')
    await prisma.supervisorDecision.create({
      data: {
        workspaceId,
        situationKind: 'task_blocked',
        subjectId: 'some-task',
        situationJson: { summary: 'a thing' },
        actionJson: { kind: 'unblock_task' },
        tier: 'propose',
        decidedBy: 'rules',
        status: 'pending',
      },
    })

    const [row] = await buildSidebarTree()

    expect(row?.needsYouCount).toBe(2)
    expect(row?.status).toBe('needs_you')
    expect(row?.statusLabel).toBe('WAITING FOR YOU')
  })

  it('counts un-integrated finished work only on a project that does not merge by itself', async (): Promise<void> => {
    const hand = await seedProject('Hand merge', { autoMerge: false })
    const auto = await seedProject('Auto merge', { autoMerge: true })
    await seedTask(hand, 'done', null)
    await seedTask(auto, 'done', null)

    const tree = await buildSidebarTree()
    const byName = new Map(tree.map((row) => [row.name, row]))

    expect(byName.get('Hand merge')?.needsYouCount).toBe(1)
    expect(byName.get('Auto merge')?.needsYouCount).toBe(0)
  })

  it('counts the active tasks the project row reads as "working"', async (): Promise<void> => {
    const workspaceId = await seedProject('Moving')
    await seedTask(workspaceId, 'running')
    await seedTask(workspaceId, 'verifying')
    await seedTask(workspaceId, 'backlog')

    const [row] = await buildSidebarTree()

    expect(row?.tasksActive).toBe(2)
  })

  it('answers an empty list on an empty installation rather than throwing', async (): Promise<void> => {
    expect(await buildSidebarTree()).toEqual([])
  })
})
```

*(Check the `SupervisorDecision` column names against `packages/db/prisma/schema.prisma` before
running — `grep -n "model SupervisorDecision" -A 30 packages/db/prisma/schema.prisma` — and match
whatever `apps/web/test/integration/projectFixture.ts`'s own `seedPendingDecision` does; that
function is the house recipe and this test may simply call it instead if its `workspaceId` is
parameterisable.)*

- [ ] **Step 6: Run it and watch it fail**

```bash
npx vitest run apps/web/test/integration/sidebar-tree.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/server/sidebar.js"`.

- [ ] **Step 7: Write `server/sidebar.ts`**

Create `apps/web/src/server/sidebar.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import {
  needsYou,
  userWorkspaceStatus,
  type TaskStatus,
  type UserWorkspaceState,
} from '@slave-of-ai/domain'

/**
 * One row of the sidebar's Projects tree (M57 R5).
 *
 * FOUR fields a person can see and one they cannot: the name, the dot's status, the amber count,
 * and `tasksActive` — which is not drawn but IS what `userWorkspaceStatus` needs to tell "working"
 * from "idle", so it rides along rather than being recomputed by the component.
 */
export interface SidebarProject {
  readonly id: string
  readonly name: string
  /** Always `false` today: `buildSidebarTree` hides archived projects. On the DTO anyway, because
   *  the tree's own `data-archived` attribute is what a later milestone's "show archived" toggle
   *  would key on, and a field nobody has to add later is cheaper than one they do. */
  readonly archived: boolean
  /** The RAW state, for `data-status` and for the dot's tone. */
  readonly status: UserWorkspaceState
  /** The WORD, for `title` and for a screen reader (`docs/ia.md` rule 3). */
  readonly statusLabel: string
  readonly needsYouCount: number
  readonly tasksActive: number
}

/** `overview.ts`'s and `shell.ts`'s own list, restated here for the same reason `shell.ts` restates
 *  it: neither exports it, and this module's whole point is not to depend on either. */
const ACTIVE_TASK_STATUSES = ['ready', 'running', 'verifying', 'reviewing', 'merging', 'rework', 'waiting'] as const

/**
 * Every project a person can reach, with the one word and the one number the tree draws.
 *
 * FOUR QUERIES, and deliberately not `listProjects()` (plan erratum E3): that function is the
 * PROJECTS PAGE's read model — six grouped reads plus a `findMany` with a nested include of every
 * team's every slave, returning spend, avatars and per-status task counts — and this one runs in
 * the ROOT layout, which means on every page in the product. What the tree draws is a name, a dot
 * and a number.
 *
 * `needsYouCount` derives THROUGH the domain's `needsYou(...)`, one status group at a time, exactly
 * as `listProjects` does (`server/org.ts:317-330`), so the number in the tree and the number on the
 * project card cannot come to disagree. It is the same FLOOR `docs/ia.md` documents: the fourth
 * clause (a `waiting` task whose question nobody can answer) needs a per-task join that neither
 * this reader nor `listProjects` makes, and `buildNeedsYou` is the fuller answer on the Overview.
 */
export async function buildSidebarTree(): Promise<readonly SidebarProject[]> {
  const [workspaces, taskGroups, unintegratedDoneGroups, pendingDecisionGroups] = await Promise.all([
    prisma.workspace.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, haltedReason: true, autoMerge: true, archivedAt: true },
      orderBy: { name: 'asc' },
    }),
    prisma.task.groupBy({ by: ['workspaceId', 'status'], _count: { _all: true } }),
    // `integratedAt` is not a `by` column, so the half of `done` that is still sitting on a branch
    // cannot be counted out of the group above — its own grouped read, ONE for every project.
    prisma.task.groupBy({
      by: ['workspaceId'],
      where: { status: 'done', integratedAt: null },
      _count: { _all: true },
    }),
    // DECISIONS, not the tasks they are about: `SupervisorDecision` has no task column, and its
    // `subjectId` is a task id, a message id, a role name or the workspace's own id depending on
    // the situation. `docs/ia.md` records exactly what this number is.
    prisma.supervisorDecision.groupBy({
      by: ['workspaceId'],
      where: { status: 'pending' },
      _count: { _all: true },
    }),
  ])

  const unintegratedDoneOf = (workspaceId: string): number =>
    unintegratedDoneGroups.find((group) => group.workspaceId === workspaceId)?._count._all ?? 0
  const pendingDecisionsOf = (workspaceId: string): number =>
    pendingDecisionGroups.find((group) => group.workspaceId === workspaceId)?._count._all ?? 0

  return workspaces.map((workspace) => {
    let needsYouCount = 0
    let tasksActive = 0
    for (const group of taskGroups) {
      if (group.workspaceId !== workspace.id) continue
      const status = group.status as TaskStatus
      if ((ACTIVE_TASK_STATUSES as readonly string[]).includes(status)) tasksActive += group._count._all
      if (status === 'done') {
        const unintegrated = unintegratedDoneOf(workspace.id)
        if (needsYou({ status, autoMerge: workspace.autoMerge, integrated: false })) needsYouCount += unintegrated
        if (needsYou({ status, autoMerge: workspace.autoMerge, integrated: true })) {
          needsYouCount += group._count._all - unintegrated
        }
        continue
      }
      if (needsYou({ status, autoMerge: workspace.autoMerge })) needsYouCount += group._count._all
    }
    needsYouCount += pendingDecisionsOf(workspace.id)

    const archived = workspace.archivedAt !== null
    const status = userWorkspaceStatus({
      archived,
      halted: workspace.haltedReason !== null,
      needsYouCount,
      tasksActive,
    })
    return {
      id: workspace.id,
      name: workspace.name,
      archived,
      status: status.state,
      statusLabel: status.label,
      needsYouCount,
      tasksActive,
    }
  })
}
```

- [ ] **Step 8: Run it and watch it pass**

```bash
npx vitest run apps/web/test/integration/sidebar-tree.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 9: Write the route**

Create `apps/web/src/app/api/sidebar/route.ts`:

```ts
import { buildSidebarTree } from '../../../server/sidebar'
import { requirePrincipal } from '../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * The sidebar tree, refetched by `SidebarTree` on a route change and on the CURRENT workspace's
 * stream wake-up (M57 R5).
 *
 * A READ, so no control shell and no refusal to translate. It is NOT workspace-scoped: the tree
 * lists every project, which is the whole point of it, and a per-workspace route would need one
 * call per row.
 */
export async function GET(): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  return Response.json(await buildSidebarTree())
}
```

- [ ] **Step 10: Add `slavesPaused` to `ShellFacts` (plan erratum E2, spec erratum E13)**

The header's left button has to say `Pause all` or `Resume all`, and nothing in `ShellFacts` can
tell "everything is paused" from "nothing is running". Three edits.

**(a)** In `apps/web/src/server/shell.ts`, inside the `counts` block of the `ShellFacts` interface,
after the `tasksActive` member, add:

```ts
    /**
     * SLAVES of this workspace whose derived status is `paused` (M57 R7, plan erratum E2, spec
     * erratum E13). The header's split button reads `Resume all` instead of `Pause all` when this
     * is positive and `slavesWorking` is zero — the two together are the only way to tell
     * "everything is paused" from "nothing is running", and the second must not offer to pause an
     * idle project.
     *
     * SLAVES and not RUNS, and deduped, for exactly the reason `slavesWorking` beside it is: one
     * slave with two live rows is one slave. The draft of this plan counted paused RUNS here and
     * paused SLAVES in `OverviewClient`'s hand-built literal, and `sameFacts` compared the two
     * across a route change — so the button's label flipped depending on which page you were on.
     */
    readonly slavesPaused: number
```

**(b)** In the same file, add a fifth entry to the `Promise.all` in `buildShellFacts` (after
`workspaceSpend(workspaceId)`), and widen the destructuring:

```ts
  const [runs, tasksActive, spendGroups, spendTotal] = await Promise.all([
```

…**and nothing is added to that array.** There is **no `Slave.status` column** — a slave's status is
DERIVED from its live runs — so the count comes from the `runs` this function has ALREADY fetched,
beside the `slavesWorking` line that does the same thing for the same reason. Immediately after the
existing `const slavesWorking = new Set(…)` block, add:

```ts
  // The same derivation, the same dedupe, one word apart (spec erratum E13). `deriveSlaveStatus`
  // is the domain's, so this number and the `paused` pill on the same slave's card cannot come to
  // disagree -- and `SlaveCardData.status` on the client is that identical projection, which is
  // what makes `OverviewClient`'s own literal below equal to this one BY CONSTRUCTION rather than
  // by coincidence. Zero extra queries: `runs` is already in hand.
  const slavesPaused = new Set(
    runs.filter((run) => deriveSlaveStatus(toRunState(run)) === 'paused').map((run) => run.slaveId),
  ).size
```

…and in the returned object, `counts: { slavesWorking, tasksActive, slavesPaused },`. `NON_TERMINAL_RUN_STATUSES`
already includes `paused` (it is why a paused run is still fetched here), so nothing about the query
changes; verify that with `grep -n "NON_TERMINAL_RUN_STATUSES" -A 3 packages/domain/src/` before
relying on it, and if `paused` is NOT in that list, widen the `status: { in: … }` to include it and
say so in the task report.

**(c)** In `apps/web/src/hooks/useShellFacts.ts`, inside `sameFacts`, add one comparison after the
`tasksActive` line:

```ts
    a.counts.slavesPaused === b.counts.slavesPaused &&
```

Without it the store would suppress the notification that the last run just paused, and the header's
label would not flip.

- [ ] **Step 11: Find and fix every hand-built `ShellFacts`**

```bash
grep -rn "slavesWorking" apps/web/src apps/web/test | grep -v "server/shell.ts"
```

Every hit is either a page client spreading a snapshot's `shellFacts` verbatim (nothing to do) or a
place that BUILDS the object literal (one line to add). At the time of writing those are
`apps/web/src/components/OverviewClient.tsx:192-195` (add
`slavesPaused: view.slaves.filter((a) => a.status === 'paused').length,` after `tasksActive` —
the SAME projection `buildShellFacts` derives, which is the whole point of erratum E13) and **every
test fixture that spells a whole `ShellFacts`** — `apps/web/test/shell.test.tsx:202,229`,
`apps/web/test/project-layout.test.tsx:11` and any others the grep finds (add `slavesPaused: 0,`).
Fix each hit the grep reports; `tsc` will list any you miss, because `counts` is a `readonly` object
literal type with no optional members.

*(Every file-and-line citation in this plan was taken against `c828f8c8` and several drift by one or
two lines — `ProjectsClient.tsx:35-41` is really `:34-40`, `gate-m44` "line 610" is `:611`,
`gate-m18` "863" is `:861`, `gate-m11` "444-447" is `:442-446`, `cli.ts` "1718-1729" is
`:1718-1728`. Treat every line number in this plan as a HINT and the quoted text as the contract:
search for the text, not the number.)*

- [ ] **Step 12: Run everything this task touched**

```bash
npx vitest run apps/web/test/routes.test.ts apps/web/test/integration/sidebar-tree.test.ts \
  apps/web/test/shell.test.tsx apps/web/test/project-layout.test.tsx \
  apps/web/test/overview-components.test.tsx apps/web/test/tasks-components.test.tsx
```

Expected: PASS. Then the whole suite once, since `ShellFacts` is a widely spread type:

```bash
npx vitest run 2>&1 | tail -20
```

Expected: at or above Task 1's recorded numbers, plus 2 files and 25 tests.

- [ ] **Step 13: Build, ladder and commit**

```bash
pgrep -af "next dev" || echo "no dev server"
npm run web:build 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"
npm run gate:m26-vocabulary && npx tsc --build && npm run --silent typecheck
git add apps/web/src/lib/routes.ts apps/web/src/server/sidebar.ts apps/web/src/app/api/sidebar \
        apps/web/src/server/shell.ts apps/web/src/hooks/useShellFacts.ts \
        apps/web/src/components/OverviewClient.tsx apps/web/test
git commit -m "$(cat <<'MSG'
feat(m57): t2 — one function that knows where you are, one read that knows what is beside you

`lib/routes.ts` is the single answer to "which section is this pathname on", which two
components used to answer differently, and it owns the breadcrumb and the VIEWS list
too. `server/sidebar.ts` is the tree's own four-query read -- not `listProjects()`,
which would put six grouped reads and every team's every slave into the root layout --
and its needs-you number derives through the domain's own projection, so it cannot
drift from the one on the project card. `ShellFacts` learns how many runs are paused,
because a button that says "Pause all" has to know when to say "Resume all".

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tb1HCWnBqh63E9diBxdxR6
MSG
)"
```

---

### Task 3: The frame, and a sidebar that is a tree (R4, R5, R7's provider, R8's provider, R15)

**Files:**
- Create: `apps/web/src/components/shell/AppShell.tsx`
- Create: `apps/web/src/components/shell/SidebarTree.tsx`
- Create: `apps/web/src/components/shell/HeaderActionProvider.tsx`
- Create: `apps/web/src/components/shell/RightPanelProvider.tsx`
- Create: `apps/web/test/sidebar-tree.test.tsx`
- Create: `apps/web/test/app-shell.test.tsx`
- Modify: `apps/web/src/app/layout.tsx` (mount the providers and `AppShell`; read the tree server-side)
- Modify: `scripts/gate-m44-ux-foundation.mjs` (lines 610 and 1104 — `nav-row` → `sidebar-global`; and stage 7's collapse assertion)
- Rewrite: `apps/web/test/shell.test.tsx` (its `navRow` helper and its eight sidebar cases)
- Delete: `apps/web/src/components/Sidebar.tsx`

**Interfaces:**
- Consumes from Task 1: `useTheme`, `THEME_GLYPH`, `THEME_LABEL`, `ThemeChoice`. From Task 2: `SECTIONS`, `VIEWS`, `sectionOf`, `viewOf`, `workspaceIdOf`, `isGlobalRoute`, `SidebarProject`, `buildSidebarTree`, `GET /api/sidebar`, `useShellFacts`.
- Produces, for Tasks 4–9:
  - `AppShell({ sidebar, header, children, right })` — the grid.
  - `HeaderActionProvider` + `export function useHeaderAction(node: React.ReactNode): void` (a page calls it; the header reads the same context through `useHeaderActionNode()`).
  - `RightPanelProvider` + `export type RightPanelMode = 'supervisor' | 'task' | 'slave'`; `export interface RightPanelState { mode: RightPanelMode | null; collapsed: boolean; content: React.ReactNode; open(mode: RightPanelMode, content: React.ReactNode, onClose: () => void): void; close(): void; collapse(): void; expand(): void }`; `export function useRightPanel(): RightPanelState`.
  - testids `app-shell` (with `data-right`), `sidebar-tree`, `sidebar-project`, `sidebar-needs-you`, `sidebar-section`, `sidebar-view`, `sidebar-global`, `sidebar-live`, `theme-toggle`, `skip-link` (kept).

- [ ] **Step 1: Write the failing test for the sidebar tree**

Create `apps/web/test/sidebar-tree.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarTree } from '../src/components/shell/SidebarTree.js'
import { ThemeProvider } from '../src/components/theme/ThemeProvider.js'
import type { SidebarProject } from '../src/server/sidebar.js'

let pathname = '/'

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('../src/hooks/useShellFacts', () => ({ useShellFacts: () => null }))
vi.mock('../src/hooks/useStreamState', () => ({ useStreamState: () => null }))

const PROJECTS: readonly SidebarProject[] = [
  { id: 'w1', name: 'Checkout rewrite', archived: false, status: 'needs_you', statusLabel: 'WAITING FOR YOU', needsYouCount: 2, tasksActive: 5 },
  { id: 'w2', name: 'Billing API', archived: false, status: 'working', statusLabel: 'WORKING', needsYouCount: 0, tasksActive: 9 },
]

function renderTree(): void {
  render(
    <ThemeProvider>
      <SidebarTree initial={PROJECTS} />
    </ThemeProvider>,
  )
}

beforeEach((): void => {
  pathname = '/'
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PROJECTS), { status: 200 })))
})

afterEach((): void => {
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

describe('the sidebar tree', () => {
  it('is the Primary navigation landmark, and the skip link still comes first', () => {
    renderTree()
    const nav = screen.getByRole('navigation', { name: 'Primary' })
    const skip = screen.getByTestId('skip-link')
    expect(skip.getAttribute('href')).toBe('#main')
    expect(skip.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('lists one row per project, with its raw state on the node and its word in the title', () => {
    renderTree()
    const rows = screen.getAllByTestId('sidebar-project')
    expect(rows.map((row) => row.getAttribute('data-project-id'))).toEqual(['w1', 'w2'])
    expect(rows[0]?.getAttribute('data-status')).toBe('needs_you')
    expect(rows[0]?.getAttribute('title')).toBe('WAITING FOR YOU')
    expect(rows[0]?.textContent).toContain('Checkout rewrite')
  })

  it('shows the needs-you count only where there is one', () => {
    renderTree()
    const counts = screen.getAllByTestId('sidebar-needs-you')
    expect(counts).toHaveLength(1)
    expect(counts[0]?.textContent).toBe('2')
  })

  it('nests the six sections under the CURRENT project only', () => {
    pathname = '/w/w1/tasks'
    renderTree()
    const sections = screen.getAllByTestId('sidebar-section')
    expect(sections.map((row) => row.getAttribute('data-section'))).toEqual([
      'overview', 'tasks', 'organization', 'knowledge', 'activity', 'settings',
    ])
    // The labels are the README's, and `organization` is called Team.
    expect(sections.map((row) => row.textContent?.replace(/\d+$/, '').trim())).toEqual([
      'Overview', 'Tasks', 'Team', 'Knowledge', 'Activity', 'Settings',
    ])
    expect(sections[1]?.getAttribute('aria-current')).toBe('page')
    expect(sections[0]?.getAttribute('aria-current')).toBeNull()
  })

  it('nests nothing when no project is open', () => {
    pathname = '/workforce'
    renderTree()
    expect(screen.queryAllByTestId('sidebar-section')).toEqual([])
    expect(screen.queryAllByTestId('sidebar-view')).toEqual([])
  })

  it('renders the three VIEWS chips under the open project -- what Advanced held (R11)', () => {
    pathname = '/w/w1/graph'
    renderTree()
    const views = screen.getAllByTestId('sidebar-view')
    expect(views.map((chip) => chip.getAttribute('data-view'))).toEqual(['graph', 'office', 'analytics'])
    expect(views.map((chip) => chip.getAttribute('href'))).toEqual([
      '/w/w1/graph', '/w/w1/office', '/analytics?workspace=w1',
    ])
    expect(views[0]?.getAttribute('aria-current')).toBe('page')
  })

  it('keeps the three global rows, with the data-nav contract nav-row used to carry', () => {
    renderTree()
    const globals = screen.getAllByTestId('sidebar-global')
    expect(globals.map((row) => row.getAttribute('data-nav'))).toEqual(['Workforce', 'Simulations', 'Settings'])
    expect(globals.map((row) => row.getAttribute('href'))).toEqual(['/workforce', '/sim', '/settings'])
    expect(globals.every((row) => (row.getAttribute('aria-label') ?? '') !== '')).toBe(true)
  })

  it('marks Workforce current on the two routes that redirect into it', () => {
    pathname = '/skills'
    renderTree()
    const workforce = screen.getAllByTestId('sidebar-global').find((row) => row.getAttribute('data-nav') === 'Workforce')
    expect(workforce?.getAttribute('aria-current')).toBe('page')
  })

  it('shows the live chip, saying "—" when no page has published a stream yet', () => {
    renderTree()
    const live = screen.getByTestId('sidebar-live')
    expect(live.textContent).toContain('live')
    expect(live.textContent).toContain('—')
  })

  it('carries the theme pill, and the pill says which mode it is in', () => {
    renderTree()
    const pill = screen.getByTestId('theme-toggle')
    expect(pill.getAttribute('data-theme-mode')).toBe('system')
    expect(pill.textContent).toContain('System')
  })

  it('is 236px wide -- the README number (R4)', () => {
    // Class string, not computed style: jsdom loads no CSS. gate:m57-ui-redesign reads it back.
    renderTree()
    expect(screen.getByRole('navigation', { name: 'Primary' }).className).toContain('w-[236px]')
  })

  it('renders the ⌘K field, inert this milestone and marked so', () => {
    renderTree()
    const search = screen.getByTestId('sidebar-search')
    expect(search.textContent).toContain('⌘K')
    expect(search.getAttribute('aria-disabled')).toBe('true')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/web/test/sidebar-tree.test.tsx
```

Expected: FAIL — `Failed to resolve import "../src/components/shell/SidebarTree.js"`.

- [ ] **Step 3: Write `SidebarTree`**

Create `apps/web/src/components/shell/SidebarTree.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { SECTIONS, VIEWS, sectionOf, viewOf, workspaceIdOf } from '../../lib/routes'
import type { SidebarProject } from '../../server/sidebar'
import { useShellFacts } from '../../hooks/useShellFacts'
import { useStreamState } from '../../hooks/useStreamState'
import { THEME_GLYPH, THEME_LABEL, useTheme } from '../theme/ThemeProvider'

/** The three destinations that are not a project (M44 R1, unchanged). `Projects` is not among
 *  them: it is the TREE's own root row, above the project list, and it is a link like the rest. */
const GLOBAL_ROWS = [
  { label: 'Workforce', href: '/workforce' },
  { label: 'Simulations', href: '/sim' },
  { label: 'Settings', href: '/settings' },
] as const

/** README "Shell" → Sidebar: rows are 13.5px at `7px 10px`, radius 8; selected takes `--sel`,
 *  weight 600 and `--t1`, everything else `--t2`. One recipe, three callers. */
function rowClass(selected: boolean, dense = false): string {
  const size = dense ? 'px-[9px] py-[5px] text-[13px] rounded-tile' : 'px-[10px] py-[7px] text-[13.5px] rounded-card'
  const state = selected ? 'bg-sel font-semibold text-t1' : 'text-t2 hover:bg-hover hover:text-t1'
  return `flex w-full items-center gap-2 ${size} ${state} transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent`
}

/** The 7px status dot beside a project row. Its colour is the project's own state through the
 *  handoff's status tokens -- one class per state, spelled literally so Tailwind's static scan
 *  finds them (the rule `ui/StatusPill.tsx` already documents for the same reason). */
const PROJECT_DOT: Record<SidebarProject['status'], string> = {
  archived: 'bg-s-idle',
  halted: 'bg-s-blocked',
  needs_you: 'bg-s-waiting',
  working: 'bg-s-working',
  idle: 'bg-s-idle',
}

/**
 * The sidebar, as a TREE (M57 R5).
 *
 * `initial` is the root layout's server read, so the first paint is right; after that the tree
 * refetches `GET /api/sidebar` on two triggers and no more. The first is a ROUTE CHANGE (a project
 * was created, archived or renamed on the page you just left). The second is a wake-up from the
 * CURRENT workspace's stream, observed through `useShellFacts` -- every workspace page client
 * publishes to that store on every one of its own 250ms-debounced refetches, so its identity
 * changing IS "something happened in this project", and the tree costs no second `EventSource`.
 * That is the defect `hooks/useShellFacts.ts:18-24` exists to prevent, and this component is the
 * fourth consumer to respect it.
 */
export function SidebarTree({ initial }: { readonly initial: readonly SidebarProject[] }): React.JSX.Element {
  const pathname = usePathname()
  const [projects, setProjects] = useState<readonly SidebarProject[]>(initial)
  const lastPathname = useRef(pathname)
  const openId = workspaceIdOf(pathname)
  const facts = useShellFacts(openId)
  const section = sectionOf(pathname)
  const view = viewOf(pathname)
  const { theme, cycle } = useTheme()
  // The footer chip is the project header's old `connection` badge, moved (README "Shell" →
  // Sidebar footer). Its source is the SAME module store the header read -- `useStreamState`,
  // published by whichever workspace page is streaming -- so the number is the same number, on a
  // different wall. `null` on a global route and before the first frame, and the chip then says
  // `live · —` rather than inventing one.
  const stream = useStreamState(openId ?? '')

  // THROTTLE (spec erratum E11, scan finding 23). `pathname` may fire this at will -- a
  // navigation is rare and a person just did it. `facts` may not: `sameFacts` compares twelve live
  // figures, and spend, `slavesWorking`, `tasksActive` and `slavesPaused` all move several times a
  // minute while a run is live, so an unthrottled effect fires `GET /api/sidebar` -- four queries
  // -- at roughly the stream's own cadence, for a tree whose rows change when somebody creates or
  // archives a project. A ref, not state: bumping it must not re-render.
  const lastFetchedAt = useRef(0)
  const SIDEBAR_REFETCH_MS = 10_000

  useEffect((): void => {
    const now = Date.now()
    // A pathname change always refetches; a facts change waits its turn.
    const forced = lastPathname.current !== pathname
    lastPathname.current = pathname
    if (!forced && now - lastFetchedAt.current < SIDEBAR_REFETCH_MS) return
    lastFetchedAt.current = now
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const response = await fetch('/api/sidebar')
        if (!response.ok) return
        const next = (await response.json()) as readonly SidebarProject[]
        if (!cancelled) setProjects(next)
      } catch {
        // Keep the tree we have. A sidebar that empties itself because one fetch failed is worse
        // than one that is a few seconds stale.
      }
    })()
    return (): void => {
      cancelled = true
    }
    // `facts` is the wake-up: its identity changes on every snapshot the open project's page
    // refetches. `pathname` is the other: you may have just come back from creating a project.
  }, [pathname, facts])

  return (
    <>
      {/* The first focusable thing in the document (M44 R6), unchanged. Off-screen until it has
        * focus, which is the only time it means anything. */}
      <a
        data-testid="skip-link"
        href="#main"
        className="sr-only rounded-chip border border-line bg-card px-3 py-1.5 text-xs text-t1 focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        Skip to content
      </a>
      <nav
        aria-label="Primary"
        data-testid="sidebar-tree"
        className="flex w-[236px] shrink-0 flex-col overflow-y-auto border-r border-line bg-panel px-[10px] pb-[12px] pt-[14px]"
      >
        {/* Brand (README: 26px accent square, 13.5/600 name, 11.5px muted sub). */}
        <div className="flex items-center gap-[10px] px-2 pb-3 pt-1">
          <span aria-hidden className="h-[26px] w-[26px] shrink-0 rounded-card bg-accent" />
          <span className="min-w-0">
            <span className="block truncate text-[13.5px] font-semibold text-t1">Slave of AI</span>
            <span className="block truncate text-[11.5px] text-t3">self-hosted</span>
          </span>
        </div>

        {/* The ⌘K field. It is RENDERED and INERT this milestone (spec §6 names it): the README
          * draws it, a missing control would read as an unfinished design, and a control that
          * looked live but did nothing would be worse than either. `aria-disabled` is how it says
          * so to a screen reader, and it is not focusable. */}
        <div
          data-testid="sidebar-search"
          aria-disabled="true"
          className="mb-[10px] flex items-center gap-2 rounded-card border border-line2 bg-card px-[10px] py-[6px] text-[12.5px] text-t3"
        >
          <span className="flex-1">Search or jump…</span>
          <span className="font-mono text-[11px] font-medium">⌘K</span>
        </div>

        <div className="flex flex-col gap-px">
          <Link href="/" className={rowClass(pathname === '/')} aria-current={pathname === '/' ? 'page' : undefined}>
            <span className="flex-1 text-left">Projects</span>
            <span className="font-mono text-[11.5px] font-medium text-t3">{projects.length}</span>
          </Link>

          {/* The project list, indented behind a hairline rule -- the README's own geometry. */}
          <div className="ml-[10px] flex flex-col gap-px border-l border-line pl-[6px]">
            {projects.map((project) => {
              const open = project.id === openId
              return (
                <div key={project.id} className="flex flex-col gap-px">
                  <Link
                    data-testid="sidebar-project"
                    data-project-id={project.id}
                    data-status={project.status}
                    title={project.statusLabel}
                    aria-current={open ? 'page' : undefined}
                    href={`/w/${project.id}`}
                    className={rowClass(open)}
                  >
                    <span aria-hidden className={`h-[7px] w-[7px] shrink-0 rounded-full ${PROJECT_DOT[project.status]}`} />
                    <span className="flex-1 truncate text-left">{project.name}</span>
                    {project.needsYouCount > 0 && (
                      <span data-testid="sidebar-needs-you" className="font-mono text-[11px] font-medium text-s-waiting">
                        {project.needsYouCount}
                      </span>
                    )}
                  </Link>

                  {open && (
                    <div className="ml-[14px] flex flex-col gap-px">
                      {SECTIONS.map((spec) => (
                        <Link
                          key={spec.id}
                          data-testid="sidebar-section"
                          data-section={spec.id}
                          href={spec.href(project.id)}
                          aria-current={section === spec.id ? 'page' : undefined}
                          className={rowClass(section === spec.id, true)}
                        >
                          <span className="flex-1 text-left">{spec.label}</span>
                          {spec.id === 'tasks' && facts !== null && (
                            <span className="font-mono text-[11px] font-medium text-t3">{facts.counts.tasksActive}</span>
                          )}
                        </Link>
                      ))}
                      {/* README: mono 600 10.5px, .08em, `--t3`. This is the `Advanced ▾` menu's
                        * three destinations, visible (M57 R11). */}
                      <div className="px-[9px] pb-[3px] pt-2 font-mono text-[10.5px] font-semibold uppercase tracking-[.08em] text-t3">
                        Views
                      </div>
                      <div className="flex flex-wrap gap-1 px-[6px] pb-[6px]">
                        {VIEWS.map((spec) => {
                          const current = spec.id === view
                          return (
                            <Link
                              key={spec.id}
                              data-testid="sidebar-view"
                              data-view={spec.id}
                              href={spec.href(project.id)}
                              aria-current={current ? 'page' : undefined}
                              className={`rounded-nav border px-2 py-[3px] text-[12px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                                current ? 'border-accent text-accent' : 'border-line2 text-t2 hover:text-t1'
                              }`}
                            >
                              {spec.label}
                            </Link>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="h-2" />

          {GLOBAL_ROWS.map((row) => {
            // `/slaves` and `/skills` are 307s into `/workforce` (next.config.ts). Both paths are
            // listed anyway: a soft navigation renders this component against the OLD pathname for
            // one frame, and a row that blinks off during a redirect looks broken.
            const current =
              row.href === '/workforce'
                ? pathname === '/workforce' || pathname === '/slaves' || pathname === '/skills'
                : row.href === '/sim'
                  ? pathname === '/sim' || pathname.startsWith('/sim/')
                  : pathname === row.href
            return (
              <Link
                key={row.label}
                data-testid="sidebar-global"
                data-nav={row.label}
                href={row.href}
                aria-label={row.label}
                title={row.label}
                aria-current={current ? 'page' : undefined}
                className={rowClass(current)}
              >
                <span className="flex-1 text-left">{row.label}</span>
              </Link>
            )
          })}
        </div>

        {/* Footer: the live chip the project header's `connection` badge used to be, and the theme
          * pill (README "Shell" → Sidebar footer). */}
        <div className="mt-auto flex items-center justify-between gap-2 px-[6px] pt-3 text-[12px] text-t3">
          {/* Three states, never two: `idle` (no page is streaming — a global route, or the
            * Settings tab, which publishes no stream), `reconnecting` (amber, no pulse — a chip
            * that keeps the live colour while the stream is down is a lie), and connected. */}
          <span data-testid="sidebar-live" data-connection={stream === null ? 'idle' : stream.connection} className="inline-flex items-center gap-[6px]">
            <span
              aria-hidden
              className={`h-[6px] w-[6px] rounded-full ${
                stream === null
                  ? 'bg-s-idle'
                  : stream.connection === 'reconnecting'
                    ? 'bg-s-waiting'
                    : 'bg-s-working motion-safe:animate-[status-pulse_1.5s_ease-in-out_infinite]'
              }`}
            />
            live · {stream?.latencyMs === null || stream === null ? '—' : `${stream.latencyMs}ms`}
          </span>
          <button
            type="button"
            data-testid="theme-toggle"
            data-theme-mode={theme}
            onClick={cycle}
            title={`Theme: ${THEME_LABEL[theme]} — click for the next one`}
            className="inline-flex items-center gap-[6px] rounded-pill border border-line2 bg-card px-2 py-1 text-[12px] font-medium text-t2 transition-colors hover:text-t1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span aria-hidden className="text-[13px] leading-none">{THEME_GLYPH[theme]}</span>
            {THEME_LABEL[theme]}
          </button>
        </div>
      </nav>
    </>
  )
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run apps/web/test/sidebar-tree.test.tsx
```

Expected: PASS, 12 tests.

- [ ] **Step 5: Write the two providers**

Create `apps/web/src/components/shell/HeaderActionProvider.tsx`:

```tsx
'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

/**
 * The header's page-action slot (M57 R7).
 *
 * CONTEXT, not a DOM portal, and not a module store. A portal would need a ref to a header element
 * that does not exist during the server's render; a module store would hold a detached React
 * subtree across a route change. Context works here for a reason it did NOT work in M24: the
 * header is mounted by the ROOT layout now, which is an ancestor of every page, where
 * `ProjectHeader` was a sibling of `{children}` inside the project layout (`useShellFacts.ts:11-16`
 * is the note that explains why that forced a module store then).
 *
 * A page calls `useHeaderAction(<Button .../>)` and the node appears in the header; when that page
 * unmounts the effect's cleanup clears it, so a page action never outlives its page.
 */
interface HeaderActionStore {
  readonly node: React.ReactNode
  readonly setNode: (node: React.ReactNode) => void
}

const HeaderActionContext = createContext<HeaderActionStore | null>(null)

export function HeaderActionProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const [node, setNodeState] = useState<React.ReactNode>(null)
  const setNode = useCallback((next: React.ReactNode): void => setNodeState(next), [])
  const value = useMemo<HeaderActionStore>(() => ({ node, setNode }), [node, setNode])
  return <HeaderActionContext.Provider value={value}>{children}</HeaderActionContext.Provider>
}

/**
 * Put this page's primary action in the header.
 *
 * The dependency is the CALLER's responsibility in exactly one way: pass a node built from stable
 * values, or memoise it, because a fresh element on every render would set state on every render.
 * Every call site in this milestone passes a node whose only moving part is a `useCallback`'d
 * handler, and the `deps` argument is how that is declared.
 */
export function useHeaderAction(node: React.ReactNode, deps: readonly unknown[]): void {
  const store = useContext(HeaderActionContext)
  const setNode = store?.setNode
  useEffect((): (() => void) | undefined => {
    if (setNode === undefined) return undefined
    setNode(node)
    return (): void => setNode(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `node` is rebuilt every render by
    // construction; `deps` is the caller's declaration of what actually changed inside it.
  }, [setNode, ...deps])
}

/** What the header renders in its slot. `null` on a page that declared no action. */
export function useHeaderActionNode(): React.ReactNode {
  return useContext(HeaderActionContext)?.node ?? null
}
```

Create `apps/web/src/components/shell/RightPanelProvider.tsx`:

```tsx
'use client'

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

/** What the 372px slot is showing (M57 R8). `supervisor` is the DEFAULT on every `/w/:id/*` route;
 *  `task` and `slave` replace it while one is selected and hand it back when it closes. */
export type RightPanelMode = 'supervisor' | 'task' | 'slave'

export interface RightPanelState {
  /** `null` means "the default for this route": the Supervisor inside a project, nothing outside. */
  readonly mode: RightPanelMode | null
  readonly collapsed: boolean
  readonly content: React.ReactNode
  /**
   * Show `content` in the slot. `onClose` is the OWNING PAGE's clearer -- the same call that clears
   * `?task=`/`?slave=` -- so the panel header's own `»` and the page's close button do the same
   * thing (plan erratum E5). A mode opened without one closes the panel and leaves the URL, which
   * is a bug the type cannot prevent, so the parameter is required.
   */
  readonly open: (mode: RightPanelMode, content: React.ReactNode, onClose: () => void, key?: string) => void
  /** Hand the slot back to its default, calling the owner's clearer on the way. */
  readonly close: () => void
  readonly collapse: () => void
  readonly expand: () => void
}

const RightPanelContext = createContext<RightPanelState | null>(null)

export function RightPanelProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const [mode, setMode] = useState<RightPanelMode | null>(null)
  const [content, setContent] = useState<React.ReactNode>(null)
  const [collapsed, setCollapsed] = useState(false)
  // A ref, not state: changing the clearer must not re-render the tree, and it is only ever read
  // inside `close`.
  const onCloseRef = useRef<(() => void) | null>(null)

  /** What is currently open, as a string, so a re-`open()` with the same mode and the same subject
   *  can be told from a genuinely new one. A ref because reading it must not re-render. */
  const openKeyRef = useRef<string | null>(null)

  const open = useCallback(
    (next: RightPanelMode, node: React.ReactNode, onClose: () => void, key?: string): void => {
      onCloseRef.current = onClose
      setMode(next)
      setContent(node)
      // Un-collapse only when something NEW is being opened (scan finding 21). A person who
      // collapsed the panel on a live project would otherwise have it re-open within a second and
      // permanently: the owning page re-runs its mirror effect on every SSE frame, and an
      // unconditional `setCollapsed(false)` turns that into an un-collapse loop. A click that
      // produces no visible change is a click a person repeats — so a genuinely new subject still
      // un-collapses, and only a re-assertion of the same one does not.
      const nextKey = `${next}:${key ?? ''}`
      if (openKeyRef.current !== nextKey) setCollapsed(false)
      openKeyRef.current = nextKey
    },
    [],
  )

  const close = useCallback((): void => {
    const onClose = onCloseRef.current
    onCloseRef.current = null
    openKeyRef.current = null
    setMode(null)
    setContent(null)
    onClose?.()
  }, [])

  const collapse = useCallback((): void => setCollapsed(true), [])
  const expand = useCallback((): void => setCollapsed(false), [])

  const value = useMemo<RightPanelState>(
    () => ({ mode, collapsed, content, open, close, collapse, expand }),
    [mode, collapsed, content, open, close, collapse, expand],
  )
  return <RightPanelContext.Provider value={value}>{children}</RightPanelContext.Provider>
}

/** Throws outside the provider: every consumer is inside the root layout's by construction, and a
 *  silently inert panel would hide the wiring bug. */
export function useRightPanel(): RightPanelState {
  const value = useContext(RightPanelContext)
  if (value === null) throw new Error('useRightPanel must be used inside <RightPanelProvider>')
  return value
}
```

- [ ] **Step 6: Write the failing test for the shell frame**

Create `apps/web/test/app-shell.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppShell } from '../src/components/shell/AppShell.js'

describe('the app shell', () => {
  it('is a three-column grid with the README widths, and says which third column it has', () => {
    render(
      <AppShell
        sidebar={<nav aria-label="Primary" />}
        header={<div data-testid="h" />}
        right={<aside data-testid="r" />}
        rightWidth="panel"
      >
        <div data-testid="page" />
      </AppShell>,
    )
    const shell = screen.getByTestId('app-shell')
    expect(shell.getAttribute('data-right')).toBe('panel')
    expect(shell.className).toContain('min-w-[1280px]')
    expect(shell.style.gridTemplateColumns).toBe('236px minmax(0, 1fr) 372px')
  })

  it('narrows the third column to the dock', () => {
    render(<AppShell sidebar={<nav />} header={<div />} right={<aside />} rightWidth="dock"><div /></AppShell>)
    const shell = screen.getByTestId('app-shell')
    expect(shell.getAttribute('data-right')).toBe('dock')
    expect(shell.style.gridTemplateColumns).toBe('236px minmax(0, 1fr) 52px')
  })

  it('has no third column at all on a global route', () => {
    render(<AppShell sidebar={<nav />} header={<div />} right={null} rightWidth="none"><div /></AppShell>)
    const shell = screen.getByTestId('app-shell')
    expect(shell.getAttribute('data-right')).toBe('none')
    expect(shell.style.gridTemplateColumns).toBe('236px minmax(0, 1fr)')
  })

  it('puts the page inside the one main landmark, which is #main and focusable', () => {
    render(<AppShell sidebar={<nav />} header={<div />} right={null} rightWidth="none"><div data-testid="page" /></AppShell>)
    const main = screen.getByRole('main')
    expect(main.getAttribute('id')).toBe('main')
    expect(main.getAttribute('tabindex')).toBe('-1')
    expect(main.contains(screen.getByTestId('page'))).toBe(true)
  })
})
```

- [ ] **Step 7: Run it and watch it fail**

```bash
npx vitest run apps/web/test/app-shell.test.tsx
```

Expected: FAIL — `Failed to resolve import "../src/components/shell/AppShell.js"`.

- [ ] **Step 8: Write `AppShell`**

Create `apps/web/src/components/shell/AppShell.tsx`:

```tsx
import type React from 'react'

/** How wide the third column is right now (M57 R4). `none` removes it from the grid entirely
 *  rather than sizing it to zero: a zero-width track still takes the gap and still lets a
 *  `min-width` inside it push the layout. */
export type RightWidth = 'panel' | 'dock' | 'none'

const TRACK: Record<RightWidth, string> = {
  panel: '236px minmax(0, 1fr) 372px',
  dock: '236px minmax(0, 1fr) 52px',
  none: '236px minmax(0, 1fr)',
}

/**
 * The frame (M57 R4): sidebar · main · right panel, as ONE grid.
 *
 * A grid and not four nested flexes, because the three columns have to agree about the height of
 * the viewport and about what scrolls: `min-h-screen` on the grid plus `min-h-0` on each column is
 * the shape where the sidebar, the page and the panel each scroll independently and the header
 * never moves. Four nested flexes can be made to do it and cannot be read.
 *
 * `min-w-[1280px]` is the README's own floor. It REPLACES M44's `max-[899px]` sidebar collapse
 * (which went with `Sidebar.tsx`): the prototype is a desktop operator console and the handoff
 * states a minimum width rather than a breakpoint. This is a deliberate reduction in responsive
 * behaviour, it is named in the spec (R4) and in `docs/ia.md`, and it is not an oversight.
 *
 * It declares no `'use client'` and holds no state — it takes nodes and arranges them. That does
 * NOT make it a server component in the built tree: Task 5's `'use client'` `ShellFrame` imports it
 * directly, which pulls it into the client bundle (scan finding 44). What the absence of the
 * directive actually buys is that it can be rendered from EITHER side — the root layout composes
 * `<SidebarTree initial={projects}/>` on the server and hands it down as a prop through client
 * providers, so the server's own read still reaches the first paint.
 */
export function AppShell({
  sidebar,
  header,
  right,
  rightWidth,
  children,
}: {
  readonly sidebar: React.ReactNode
  readonly header: React.ReactNode
  /** The 372px panel, the 52px dock, or nothing. Sized by `rightWidth`, not by itself. */
  readonly right: React.ReactNode
  readonly rightWidth: RightWidth
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="app-shell"
      data-right={rightWidth}
      style={{ gridTemplateColumns: TRACK[rightWidth] }}
      className="grid min-h-screen min-w-[1280px] flex-1 bg-bg text-t1"
    >
      {sidebar}
      {/* The middle column owns the header and the scroll. `min-w-0` so a wide table inside a page
        * scrolls itself instead of stretching the grid; `min-h-0` so the page scrolls under a
        * header that stays put. */}
      <div className="flex min-h-0 min-w-0 flex-col">
        {header}
        {/* The one `main` landmark, and the skip link's target (M44 R6, unchanged). `tabIndex={-1}`
          * so the anchor can actually move focus here. */}
        <main id="main" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto focus:outline-none">
          {children}
        </main>
      </div>
      {right}
    </div>
  )
}
```

- [ ] **Step 9: Run it and watch it pass**

```bash
npx vitest run apps/web/test/app-shell.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 10: Mount the shell in the root layout**

In `apps/web/src/app/layout.tsx`: replace the `Sidebar` import with the four below, make the
component `async`, and replace the `<body>`'s contents. Everything above `export const metadata`
(the four `localFont` calls, the two `unicode-range` constants, `FONT_VARIABLES`, `THEME_SCRIPT`)
does not move a character. The right column is `null`/`'none'` here and Task 5 fills it — this task
proves the grid, the tree and the providers.

```tsx
import { buildSidebarTree } from '../server/sidebar'
import { AppShell } from '../components/shell/AppShell'
import { SidebarTree } from '../components/shell/SidebarTree'
import { HeaderActionProvider } from '../components/shell/HeaderActionProvider'
import { RightPanelProvider } from '../components/shell/RightPanelProvider'
import { ThemeProvider, THEME_STORAGE_KEY } from '../components/theme/ThemeProvider'
```

```tsx
export const metadata = { title: 'Slave of AI' }

/** The tree is read on the SERVER so the first paint carries the real project list — a sidebar
 *  that arrives one frame late is the most visible kind of late. `force-dynamic` because it is a
 *  database read on every request and there is nothing to cache across operators. */
export const dynamic = 'force-dynamic'

export default async function RootLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  // GATED ON A PRINCIPAL (spec erratum E11, scan finding 55). Without this, `/login` — the one page
  // in the product a signed-out person can reach — opens a database connection and lists every
  // project before anybody has authenticated. `GET /api/sidebar` has always been gated; the layout
  // read was not.
  //
  // `currentPrincipal`, NOT `requirePrincipal`: this is a layout, not an authorisation boundary,
  // and it must render (with an empty tree) rather than return a 401 `Response`. In loopback mode
  // there is no account to name and `currentPrincipal` answers `null` for everybody — so read
  // `apps/web/src/server/principal.ts:24-44` first and use whichever helper answers "is this
  // installation gated at all", falling back to reading the tree unconditionally when it is not.
  // A sidebar that is empty for every loopback operator would be a worse bug than the one this
  // fixes.
  const projects = await buildSidebarTree()
  return (
    <html lang="en" className={FONT_VARIABLES} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen">
        <ThemeProvider>
          <RightPanelProvider>
            <HeaderActionProvider>
              <AppShell sidebar={<SidebarTree initial={projects} />} header={null} right={null} rightWidth="none">
                {children}
              </AppShell>
            </HeaderActionProvider>
          </RightPanelProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
```

- [ ] **Step 11: Delete `Sidebar.tsx` and rewrite its test**

```bash
git rm apps/web/src/components/Sidebar.tsx
grep -rn "components/Sidebar" apps/web/src apps/web/test scripts
```

Expected after the `git rm`: the grep reports only `apps/web/test/shell.test.tsx:4`. Rewrite that
file's first half: **delete line 4 (the `Sidebar` import), lines 67–72 (the `navRow` helper) and the
whole `describe('the shell', …)` block down to its closing `})`** — those eight cases are now
`apps/web/test/sidebar-tree.test.tsx`'s twelve — and leave the file's second half
(`describe('the halt banner shows on every page', …)` and its two cases) exactly as it is. The file
keeps its name: what it still tests is that the halt banner reaches every page, which is a shell
claim.

**Two module-scope bindings go with that block** (scan finding 33), and the repo's `noUnusedLocals`
makes leaving them an ERROR rather than a warning: `routerReplace` (`:11`) is read only by the
`next/navigation` mock, and `pathname` (`:10`) only by that mock and the deleted `afterEach`. Neither
remaining case navigates, so collapse the mock to what they need:

```tsx
vi.mock('next/navigation', () => ({
  usePathname: () => '/w/w1',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
```

…and delete the `let pathname = …` and `const routerReplace = …` lines above it, and the
`afterEach(() => { pathname = '/w/w1' })` inside the deleted describe.

Then add `slavesPaused: 0,` to the two `ShellFacts` literals in that file if Task 2's Step 11 has not
already (check with `grep -n slavesPaused apps/web/test/shell.test.tsx`).

- [ ] **Step 12: Update `gate-m44-ux-foundation.mjs`**

**Edit 1 — stage 1's sidebar read (around line 610).** Replace the `page.evaluate` selector and the
expectation. The four-entry claim becomes a three-entry one plus a check that the tree's root row is
present, because `Projects` is no longer a `nav-row`-shaped sibling of the other three — it is the
tree's root, above the project list.

```js
  const navRows = await page.evaluate(() =>
    [...document.querySelectorAll('nav[aria-label="Primary"] [data-testid="sidebar-global"]')].map((row) => [
      row.getAttribute('data-nav') ?? '',
      // `getAttribute`, not `.href`: the DOM property resolves to an absolute URL.
      row.getAttribute('href') ?? '',
      row.getAttribute('aria-label') ?? '',
    ]),
  )
  console.log(`stage 1: sidebar rows in DOM order = ${JSON.stringify(navRows.map(([nav, href]) => [nav, href]))}`)
  // M57 R5: Projects is the TREE's root row now, above the per-project list, not a fourth sibling
  // of these three. Its presence is asserted separately, immediately below.
  const EXPECTED_NAV = [
    ['Workforce', '/workforce'],
    ['Simulations', '/sim'],
    ['Settings', '/settings'],
  ]
```

…and immediately after the existing `for (const gone of ['Slaves', 'Skills', 'Analytics'])` loop,
add:

```js
  const treeRoot = await page.evaluate(() => {
    const root = [...document.querySelectorAll('nav[aria-label="Primary"] a')].find(
      (a) => (a.textContent ?? '').trim().startsWith('Projects'),
    )
    return root === undefined ? null : root.getAttribute('href')
  })
  if (treeRoot !== '/') await fail(`stage 1: the tree's Projects root points at ${JSON.stringify(treeRoot)}, expected "/"`)
  console.log('stage 1: the tree root is Projects → /')
```

**Edit 2 — stage 2's Advanced menu (lines ~676 and ~694–743).** That block — `waitVisible` on
`project-tab-overview`, the `stripLabels` scrape, the three `clickUntil`s on `project-advanced`, the
href reads for `advanced-item-graph`/`advanced-item-office`, and the Escape-refocus check — asserts
a MENU and a TAB STRIP that no longer exist. Replace it from the
`waitVisible(page.getByTestId('project-tab-overview')…)` line down to the `console.log` that ends
the Escape check.

**Three assertions in that block are NOT about the menu and must survive** (scan finding 26): the
tab-LABEL check (`EXPECTED_TABS`, `:692-695`) and the two "not decoration: both routes still
render" checks (`graph-canvas` at `:716-718`, `office-canvas` at `:719-722`). The labels move onto
the tree's section rows, and the two canvas checks are copied across unchanged — they are the whole
point of `docs/ia.md` rule 2 and `gate-m57` stage 10 only asks for a 200. The replacement:

```js
  await waitVisible(page.getByTestId('sidebar-section'), "the project's section rows in the tree")
  const sectionIds = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="sidebar-section"]')].map((row) => row.getAttribute('data-section') ?? ''),
  )
  console.log(`stage 2: section rows = ${JSON.stringify(sectionIds)}`)
  const EXPECTED_SECTIONS = ['overview', 'tasks', 'organization', 'knowledge', 'activity', 'settings']
  if (JSON.stringify(sectionIds) !== JSON.stringify(EXPECTED_SECTIONS)) {
    await fail(`stage 2: the tree's sections are ${JSON.stringify(sectionIds)}, expected ${JSON.stringify(EXPECTED_SECTIONS)}`)
  }
  // The LABEL assertion the tab strip used to carry, re-pointed at the rows that carry those words
  // now. `Organization` became `Team` in M57 R6 -- a label change over an unchanged route -- and
  // this line is where a reviewer sees that, in the same commit as the component.
  const sectionLabels = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="sidebar-section"]')].map((row) =>
      // The Tasks row carries a count in its own text, the way the tab's badge did; the label is
      // what is left.
      (row.textContent ?? '').replace(/\d+$/, '').trim(),
    ),
  )
  console.log(`stage 2: section labels = ${JSON.stringify(sectionLabels)}`)
  const EXPECTED_LABELS = ['Overview', 'Tasks', 'Team', 'Knowledge', 'Activity', 'Settings']
  if (JSON.stringify(sectionLabels) !== JSON.stringify(EXPECTED_LABELS)) {
    await fail(`stage 2: the tree's section labels are ${JSON.stringify(sectionLabels)}, expected ${JSON.stringify(EXPECTED_LABELS)}`)
  }
  // M57 R11: what `Advanced ▾` held is three VISIBLE chips now. No menu to open, and therefore no
  // Escape-refocus contract to hold -- the destinations are the promise `docs/ia.md` makes, and
  // they are all three here, at the URLs they always had.
  const viewHrefs = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-testid="sidebar-view"]')].map((chip) => [
        chip.getAttribute('data-view') ?? '',
        chip.getAttribute('href') ?? '',
      ]),
    ),
  )
  console.log(`stage 2: VIEWS chips = ${JSON.stringify(viewHrefs)}`)
  if (viewHrefs.graph !== `/w/${workspaceId}/graph`) {
    await fail(`stage 2: the Graph chip points at ${JSON.stringify(viewHrefs.graph)}, expected /w/${workspaceId}/graph`)
  }
  if (viewHrefs.office !== `/w/${workspaceId}/office`) {
    await fail(`stage 2: the Office chip points at ${JSON.stringify(viewHrefs.office)}, expected /w/${workspaceId}/office`)
  }
  if (viewHrefs.analytics !== `/analytics?workspace=${workspaceId}`) {
    await fail(`stage 2: the Analytics chip points at ${JSON.stringify(viewHrefs.analytics)}, expected /analytics?workspace=${workspaceId}`)
  }
  // NOT DECORATION: both routes still render (M44's own two checks, kept verbatim -- a chip that
  // points at a page nobody can draw is a chip that lies).
  await gotoReliably(`${baseUrl}/w/${workspaceId}/graph`)
  await waitVisible(page.getByTestId('graph-canvas'), "the Graph route's canvas, reached from VIEWS")
  console.log('stage 2: /w/<id>/graph rendered graph-canvas')
  await gotoReliably(`${baseUrl}/w/${workspaceId}/office`)
  await waitVisible(page.getByTestId('office-canvas'), "the Office route's canvas, reached from VIEWS")
  console.log('stage 2: /w/<id>/office rendered office-canvas')
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)

  console.log('stage 2 PASSED: six section rows with the right words, three VIEWS chips, and both canvases still drawing')
```

**Edit 3 — the Overview disclosure, inside stage 3/4's page loop (lines 842–846).** The real block
is four lines and there is no `clickUntil` in it (scan finding 11) — quoted exactly:

```js
      const toggle = page.getByTestId('overview-advanced-toggle')
      await waitVisible(toggle, "the Overview's Advanced disclosure")
      await toggle.click()
      await waitVisible(page.getByTestId('live-events'), 'the live-events river under Advanced')
```

Replace all four with the one that is left, because the river is on the page without a click now
(Task 4 Step 12 leaves it rendered directly; Task 6 re-homes it under `recent-changes`):

```js
      await waitVisible(page.getByTestId('live-events'), 'the live-events river on the Overview')
```

**Edit 4 — the Supervisor proposal, also inside stage 3/4's page loop (lines 921–933).** *(The
draft of this plan called Edits 3 and 4 "stage 5"; they are in the stage 3/4 loop at `:831-940` —
scan finding 35.)*

Two selectors move, not one. Line 930's panel-scoped chip:

```js
      const kindChip = page.locator('[data-testid="right-panel"] [data-testid="supervisor-proposal-kind"]').first()
```

…and line 933's `timeline-decisions`-scoped chip is **unchanged**: `SupervisorTimeline` renders
`ProposalRow`, which Task 5 extracts rather than deletes (spec erratum E18), so that half of the
comparison keeps working exactly as it does today. Line 921's
`waitVisible(page.getByTestId('supervisor-decision-meta'))` is **also unchanged**, because Task 5's
`SupervisorThreadPanel` emits that testid with the same semantics — the projected sentence, with the
whole raw record in `title`. **Both of those are Task 5's promises**: if Task 5 has not landed when
this gate is run at the end of Task 4, the two lines fail, and the honest answer is to run this gate
again at the end of Task 5 rather than to weaken it here. Note that in the task report.

**Edit 5 — stage 7's collapse (lines ~1090–1110).** The 212 px/52 px collapse is gone with
`Sidebar.tsx` (R4). Replace the whole stage-7 body with the new floor:

```js
  const wideWidth = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Primary"]')
    return nav === null ? null : window.getComputedStyle(nav).width
  })
  console.log(`stage 7: sidebar width at 1440x900 = ${JSON.stringify(wideWidth)}`)
  if (wideWidth !== '236px') await fail(`stage 7: the sidebar is ${JSON.stringify(wideWidth)} at 1440x900, expected "236px" (the M57 README number)`)
  // M57 R4: the handoff states a MINIMUM WIDTH rather than a breakpoint, and the 899px icon rail
  // went with `Sidebar.tsx`. What is asserted instead is that the frame refuses to compress: at
  // 800px the shell is still at least 1280 wide and the page scrolls horizontally rather than the
  // sidebar shrinking into something unusable.
  await page.setViewportSize({ width: 800, height: 900 })
  await gotoReliably(`${baseUrl}/`)
  await waitVisible(page.getByRole('navigation', { name: 'Primary' }), 'the sidebar at 800x900')
  const narrow = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Primary"]')
    const shell = document.querySelector('[data-testid="app-shell"]')
    return {
      width: nav === null ? null : window.getComputedStyle(nav).width,
      shellWidth: shell === null ? null : shell.getBoundingClientRect().width,
      labels: [...document.querySelectorAll('[data-testid="sidebar-global"]')].map((row) => row.getAttribute('aria-label') ?? ''),
    }
  })
  console.log(`stage 7: at 800x900 = ${JSON.stringify(narrow)}`)
  if (narrow.width !== '236px') await fail(`stage 7: the sidebar is ${JSON.stringify(narrow.width)} at 800x900, expected "236px" -- it does not collapse any more`)
  if (narrow.shellWidth === null || narrow.shellWidth < 1280) {
    await fail(`stage 7: the shell is ${JSON.stringify(narrow.shellWidth)} wide at 800px, expected at least 1280 (R4's floor)`)
  }
  if (narrow.labels.length !== 3 || narrow.labels.some((label) => label === '')) {
    await fail(`stage 7: a global row lost its aria-label (${JSON.stringify(narrow.labels)})`)
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  console.log('stage 7 PASSED: 236px at both widths, a 1280px floor, and every global row still says its own name')
```

- [ ] **Step 13: Run the gate**

```bash
pgrep -af vitest || echo "no vitest running"
npm run gate:m44-ux-foundation 2>&1 | tail -40; echo "exit=${PIPESTATUS[0]}"
```

Expected: `exit=0`. If a stage fails on a testid this task did not name, that is a hit the greps
missed — fix it HERE, in this task, and note it as an erratum.

- [ ] **Step 14: Run the suite, build, ladder and commit**

```bash
npx vitest run 2>&1 | tail -20
pgrep -af "next dev" || echo "no dev server"
npm run web:build 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"
npm run gate:m26-vocabulary && npx tsc --build && npm run --silent typecheck
git add -A apps/web/src/components/shell apps/web/src/app/layout.tsx apps/web/test scripts/gate-m44-ux-foundation.mjs
git rm --cached apps/web/src/components/Sidebar.tsx 2>/dev/null || true
git add -u
git commit -m "$(cat <<'MSG'
feat(m57): t3 — the frame is a grid, and the sidebar is a tree

One CSS grid mounted by the ROOT layout -- 236 / fluid / nothing-yet -- which makes the
root layout an ancestor of every page for the first time, and that is what lets the
right panel and the page's header action be context instead of the module stores M24
was forced into. The sidebar lists every project with its own word and its own amber
count, nests the current project's six sections under it, and puts `Advanced ▾`'s three
destinations on the wall as chips. `Sidebar.tsx` and its 899px icon rail are gone; the
README states a 1280px floor instead, and the gate reads it back.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tb1HCWnBqh63E9diBxdxR6
MSG
)"
```

---

### Task 4: One header, one split button, and the three routes it needed (R7, R14, R11's deletions, R12's gate edits, E1, E2, E7)

**Files:**
- Create: `packages/control/src/emergency.ts`'s `clearHalt` (modify — the file exists)
- Create: `apps/web/src/components/shell/Header.tsx`
- Create: `apps/web/src/app/api/w/[workspaceId]/runs/pause-all/route.ts`
- Create: `apps/web/src/app/api/w/[workspaceId]/runs/resume-all/route.ts`
- Create: `apps/web/src/app/api/w/[workspaceId]/clear-halt/route.ts`
- Create: `apps/web/src/server/runFanout.ts`
- Create: `apps/web/src/components/shell/ShellFactsSeed.tsx` (spec erratum E12)
- Create: `apps/web/test/header.test.tsx`
- Create: `apps/web/test/integration/fanout-routes.test.ts`
- Modify: `apps/orchestrator/src/cli.ts` (the `clear-halt` case only — lines 1718–1729)
- Modify: `apps/web/src/app/layout.tsx` (`header={<Header />}`)
- Modify: `apps/web/src/app/w/[workspaceId]/layout.tsx` (drop `ProjectHeader`/`ProjectTabs`)
- Modify: `scripts/gate-m11-shell.mjs` (445–447), `scripts/gate-m14-fidelity.mjs` (941), `scripts/gate-m18-skill-and-teeth.mjs` (845, 846, 863), `scripts/gate-m47-team-formation.mjs` (966), `scripts/gate-m49-memory.mjs` (1534–1547)
- Rewrite: `apps/web/test/project-layout.test.tsx`
- **Comment-only edits** (spec's Global Constraints: a comment is not behaviour). Each of these names a component this task deletes, in prose, with no code on the line. One line each, and NOTHING else in these files moves: `apps/web/src/server/overview.ts:239`, `apps/web/src/server/org.ts:78`, `apps/web/src/hooks/useShellFacts.ts:8,11`, `apps/web/src/components/ui/Tabs.tsx:58`, `apps/web/src/components/ui/useModalDismiss.ts:87`, `apps/web/src/components/SlavePanel.tsx:474`, `apps/web/src/components/ProjectsClient.tsx:217`, and `scripts/gate-m52-broker.mjs:1383-1386` (which explains a scoped locator by naming the Overview's `Advanced` disclosure).
- Delete: `apps/web/src/components/project/ProjectHeader.tsx`, `apps/web/src/components/project/ProjectTabs.tsx`, `apps/web/src/components/project/ProjectSwitcher.tsx`, `apps/web/src/components/project/OverviewAdvanced.tsx`, `apps/web/test/project-tabs.test.tsx`, **`apps/web/test/project-header.test.tsx`** (deleted, not rewritten — Step 12 says why, and the earlier draft's "renamed in place" was wrong)

**Interfaces:**
- Consumes from Task 2: `breadcrumbOf`, `workspaceIdOf`, `isGlobalRoute`, `ShellFacts.counts.slavesPaused`. From Task 3: `useHeaderActionNode`, `AppShell`.
- Produces, for Tasks 5–9: `Header({ projects }: { projects: readonly SidebarProject[] })` — it reads the pathname, the header-action context and `useShellFacts`, and takes the tree as a prop so it can name the project on every route (spec erratum E12); `ShellFactsSeed({ facts }: { facts: ShellFacts })`; `clearHalt(workspaceId: string): Promise<Result<{ readonly cleared: boolean }, ControlRefusal>>` from `@slave-of-ai/control`; `resumeActiveRuns(workspaceId, requestedBy, principal?): Promise<{ requested: string[]; refused: string[] }>` from `apps/web/src/server/runFanout.ts`; the three routes; testids `app-header`, `breadcrumb`, `halted-pill`, `pause-all`, `stop-split`, `stop-cancel`, `budget-bar`, `header-error`, `header-action`.

- [ ] **Step 1: Add `clearHalt` to the control package (erratum E1)**

Append to `packages/control/src/emergency.ts`:

```ts
/**
 * Retract a safety halt (M57 R14c, plan erratum E1).
 *
 * This is not new behaviour: `apps/orchestrator/src/cli.ts`'s `clear-halt` case has written these
 * exact two columns inline since M5. It moves here so that the CLI and the web route share one
 * copy rather than owning two, which is the whole of the change.
 *
 * IT APPENDS NO EVENT, because the CLI's version appends none, and a milestone whose claim is that
 * nothing changed may not start writing history the CLI does not write. (`emergencyStop` above
 * appends `guardrail.tripped` on the way IN; the way out has always been silent, and whether that
 * asymmetry is right is a question for a milestone that is allowed to answer it.)
 *
 * It STARTS NOTHING: it removes the reason nothing was starting. A paused run resumes when the
 * sweep next reaches it, or when somebody presses Resume.
 */
export async function clearHalt(workspaceId: string): Promise<Result<{ readonly cleared: boolean }, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { haltedReason: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  // `updateMany` with the condition in the WHERE, not a read-then-write: two operators clearing at
  // once must not both claim to have been the one who did it.
  const cleared = await prisma.workspace.updateMany({
    where: { id: workspaceId, haltedReason: { not: null } },
    data: { haltedReason: null, haltedAt: null },
  })
  // A workspace that was not halted is NOT a refusal -- the button is idempotent by design, the
  // same way `emergencyStop` treats a second press.
  return ok({ cleared: cleared.count === 1 })
}
```

Then rewrite the CLI case. In `apps/orchestrator/src/cli.ts`, replace the body of `case 'clear-halt':` (lines 1718–1729) with:

```ts
    case 'clear-halt': {
      const workspaceId = await resolveWorkspace({ ...flags, workspace: requireFlag(flags, 'workspace') })
      const result = await clearHalt(workspaceId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(
        `cleared the safety halt on ${workspaceId}. This starts nothing by itself: it removes the ` +
          `reason nothing was starting.\n`,
      )
      return 0
    }
```

…and add `clearHalt` to whichever `import { … } from '@slave-of-ai/control'` statement already
brings in `emergencyStop` (find it with `grep -n "emergencyStop" apps/orchestrator/src/cli.ts | head -3`).
The sentence the CLI prints does not change by one character.

- [ ] **Step 2: Write the failing test for the two fan-out routes and the halt route**

Create `apps/web/test/integration/fanout-routes.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { clearHalt } from '@slave-of-ai/control'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resumeActiveRuns } from '../../src/server/runFanout.js'
import { truncateAll } from './projectFixture.js'

async function seed(): Promise<{ workspaceId: string; slaveId: string }> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Fanout', repoPath: '/tmp/m57-fanout', verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'dev', runtimeRoles: ['dev'] } })
  return { workspaceId: workspace.id, slaveId: slave.id }
}

async function seedRun(slaveId: string, status: string): Promise<string> {
  const run = await prisma.slaveRun.create({
    data: { slaveId, status: status as never, provider: 'claude_code', attempt: 1 },
  })
  return run.id
}

describe('resumeActiveRuns', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('asks every paused run of this workspace to resume, and reports which', async (): Promise<void> => {
    const { workspaceId, slaveId } = await seed()
    const a = await seedRun(slaveId, 'paused')
    const b = await seedRun(slaveId, 'paused')
    await seedRun(slaveId, 'running')

    const report = await resumeActiveRuns(workspaceId, 'a test')

    expect([...report.requested].sort()).toEqual([a, b].sort())
    expect(report.refused).toEqual([])
  })

  it('touches no run of another workspace', async (): Promise<void> => {
    const mine = await seed()
    const theirs = await seed()
    const ours = await seedRun(mine.slaveId, 'paused')
    await seedRun(theirs.slaveId, 'paused')

    const report = await resumeActiveRuns(mine.workspaceId, 'a test')

    expect(report.requested).toEqual([ours])
  })

  it('answers an empty report on a workspace with nothing paused, rather than throwing', async (): Promise<void> => {
    const { workspaceId } = await seed()
    expect(await resumeActiveRuns(workspaceId, 'a test')).toEqual({ requested: [], refused: [] })
  })
})

describe('clearHalt', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  it('clears a halted workspace and says it did', async (): Promise<void> => {
    const { workspaceId } = await seed()
    await prisma.workspace.update({ where: { id: workspaceId }, data: { haltedReason: 'stopped', haltedAt: new Date() } })

    const result = await clearHalt(workspaceId)

    expect(result.ok && result.value.cleared).toBe(true)
    const after = await prisma.workspace.findUnique({ where: { id: workspaceId } })
    expect(after?.haltedReason).toBeNull()
    expect(after?.haltedAt).toBeNull()
  })

  it('is idempotent: a workspace that was not halted is not a refusal', async (): Promise<void> => {
    const { workspaceId } = await seed()
    const result = await clearHalt(workspaceId)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.cleared).toBe(false)
  })

  it('refuses a workspace that does not exist', async (): Promise<void> => {
    const result = await clearHalt('no-such-workspace')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.kind).toBe('workspace_not_found')
  })

  it('appends no event -- the CLI appends none, and this milestone changes no history', async (): Promise<void> => {
    const { workspaceId } = await seed()
    await prisma.workspace.update({ where: { id: workspaceId }, data: { haltedReason: 'stopped', haltedAt: new Date() } })
    await clearHalt(workspaceId)
    expect(await prisma.executionEvent.count({ where: { workspaceId } })).toBe(0)
  })
})
```

*(Check `SlaveRun`'s required columns before running — `grep -n "model SlaveRun" -A 40 packages/db/prisma/schema.prisma` — and match whatever `apps/web/test/integration/control-routes.test.ts` already does to create one; that file is the house recipe.)*

- [ ] **Step 3: Run it and watch it fail**

```bash
npx vitest run apps/web/test/integration/fanout-routes.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/server/runFanout.js"` (and, if Step 1 was skipped, `clearHalt is not exported`).

- [ ] **Step 4: Write the resume fan-out**

Create `apps/web/src/server/runFanout.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { requestResume, type Principal } from '@slave-of-ai/control'

export interface FanoutReport {
  readonly requested: readonly string[]
  readonly refused: readonly string[]
}

/**
 * Ask every paused run of one workspace to resume (M57 R14b).
 *
 * The MIRROR of `pauseActiveRuns` (`packages/control/src/pause.ts:158`), and deliberately NOT a
 * second copy of it in the control package: `pauseActiveRuns` exists because an emergency stop
 * needs it, and resuming has never had a domain-level fan-out. What this is, is the web's own loop
 * over the EXISTING per-run verb -- the same `requestResume` the Resume button on a single worker
 * card already calls, once per run. No new control verb, no new event type; the events are the
 * `run.resume_requested` rows each call already writes.
 *
 * Per-run tolerance, the same rule `pauseActiveRuns` documents at length: a run that lost a status
 * race between the query and the verb belongs in `refused`, never in an exception that would
 * abandon the rest of the fan-out and leave half a project resumed with nothing saying so.
 *
 * `slave -> team -> workspaceId`, not `task -> workspaceId`: a `planning` run has no `Task` row at
 * all, and scoping through `Task` would silently skip it.
 */
export async function resumeActiveRuns(
  workspaceId: string,
  requestedBy: string,
  principal?: Principal,
): Promise<FanoutReport> {
  const runs = await prisma.slaveRun.findMany({
    where: { status: 'paused', slave: { team: { workspaceId } } },
    select: { id: true },
  })

  const requested: string[] = []
  const refused: string[] = []
  for (const run of runs) {
    try {
      const result = await requestResume(run.id, null, requestedBy, principal)
      if (result.ok) requested.push(run.id)
      else refused.push(run.id)
    } catch {
      refused.push(run.id)
    }
  }
  return { requested, refused }
}
```

- [ ] **Step 5: Write the three routes**

`apps/web/src/app/api/w/[workspaceId]/runs/pause-all/route.ts`:

```ts
import { pauseActiveRuns } from '@slave-of-ai/control'
import { archivedRefusal } from '../../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * "Pause everything in this project" (M57 R7).
 *
 * ONE existing control function, called once: `pauseActiveRuns` is what `emergencyStop` already
 * fans out with, and it is already exported from the barrel. No new verb, no new event -- the
 * events are the `run.pause_requested` rows the per-run signal already writes.
 *
 * `category: 'human'`, not `'emergency_stop'`: this is an operator pausing work, not a guardrail
 * halting a project, and the two are different rungs of `docs/decisions/0001-pause-semantics.md`'s
 * ladder. Nothing here touches `haltedReason`.
 *
 * Its own envelope rather than `workspaceControlResponse`'s bare `{ ok: true }`: `pauseActiveRuns`
 * returns a REPORT, and how many runs were asked and how many were already concluding is what the
 * header's own error band has to be able to say.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal
  const report = await pauseActiveRuns(workspaceId, 'web operator', 'human')
  return Response.json({ ok: true, requested: report.requested, refused: report.refused })
}
```

`apps/web/src/app/api/w/[workspaceId]/runs/resume-all/route.ts`:

```ts
import { resumeActiveRuns } from '../../../../../../server/runFanout'
import { archivedRefusal } from '../../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** "Resume everything in this project" (M57 R7/R14b) -- the web's own loop over the EXISTING
 *  per-run `requestResume`, in `server/runFanout.ts`. Same envelope as its pause sibling. */
export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const refusal = await archivedRefusal(workspaceId)
  if (refusal !== null) return refusal
  const report = await resumeActiveRuns(workspaceId, 'web operator', gate.principal ?? undefined)
  return Response.json({ ok: true, requested: report.requested, refused: report.refused })
}
```

`apps/web/src/app/api/w/[workspaceId]/clear-halt/route.ts`:

```ts
import { clearHalt } from '@slave-of-ai/control'
import { workspaceControlResponse } from '../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * Retract a safety halt from the header's `Clear halt` button (M57 R14c).
 *
 * There was no web route for this at all before M57 -- `clear-halt` was a CLI case and nothing
 * else -- and the header's halted state has to be reversible from the same place it is entered
 * from, or the emergency stop is a one-way door in the UI. `clearHalt` is the control function
 * that case's body moved into; the CLI calls the same one.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  return workspaceControlResponse(workspaceId, () => clearHalt(workspaceId))
}
```

- [ ] **Step 6: Run the integration test and watch it pass**

```bash
npx vitest run apps/web/test/integration/fanout-routes.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 7: Write the failing test for the header**

Create `apps/web/test/header.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Header } from '../src/components/shell/Header.js'
import { HeaderActionProvider, useHeaderAction } from '../src/components/shell/HeaderActionProvider.js'
import type { ShellFacts } from '../src/server/shell.js'

let pathname = '/w/w1/tasks'
let facts: ShellFacts | null = null

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('../src/hooks/useShellFacts', () => ({ useShellFacts: () => facts }))

function shellFacts(overrides: Partial<ShellFacts['status']> = {}, counts: Partial<ShellFacts['counts']> = {}): ShellFacts {
  return {
    workspace: { id: 'w1', name: 'Checkout rewrite' },
    counts: { slavesWorking: 2, tasksActive: 5, slavesPaused: 0, ...counts },
    guardrails: { budgetUsd: 40, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
    status: { goal: 'Ship it', spentUsd: 12.4, unmeasuredRuns: 0, haltedReason: null, ...overrides },
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  pathname = '/w/w1/tasks'
  facts = shellFacts()
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

const PROJECTS = [
  { id: 'w1', name: 'Checkout rewrite', archived: false, status: 'working' as const, statusLabel: 'WORKING', needsYouCount: 0, tasksActive: 5 },
]

function renderHeader(): void {
  render(<HeaderActionProvider><Header projects={PROJECTS} /></HeaderActionProvider>)
}

describe('the header', () => {
  it('reads Projects / <project> / <section>, with only the last emphasised', () => {
    renderHeader()
    const crumb = screen.getByTestId('breadcrumb')
    expect(crumb.getAttribute('data-crumbs')).toBe('Projects/Checkout rewrite/Tasks')
    expect(crumb.textContent).toContain('Checkout rewrite')
  })

  it('is 54px tall -- the README number (R7)', () => {
    renderHeader()
    expect(screen.getByTestId('app-header').className).toContain('h-[54px]')
  })

  it('shows the money and the bar, and keeps the budget testids the gates pin', () => {
    renderHeader()
    expect(screen.getByTestId('budget').textContent).toContain('$12.40')
    expect(screen.getByTestId('budget').textContent).toContain('$40.00')
  })

  it('draws no bar for an unbudgeted project -- a bar is a fraction of a ceiling', () => {
    facts = { ...shellFacts(), guardrails: { budgetUsd: null, maxConcurrentRuns: 3, runTimeoutMs: 1, maxAttempts: 3 } }
    renderHeader()
    expect(screen.queryByTestId('budget-bar')).toBeNull()
  })

  it('names the unmeasured runs beside the figure', () => {
    facts = shellFacts({ unmeasuredRuns: 2 })
    renderHeader()
    expect(screen.getByTestId('budget-unmeasured').textContent).toContain('2 unmeasured')
  })

  it('says Pause all while anything is working, and Resume all once everything is paused', () => {
    renderHeader()
    expect(screen.getByTestId('pause-all').textContent).toBe('Pause all')
    facts = shellFacts({}, { slavesWorking: 0, slavesPaused: 3 })
    renderHeader()
    expect(screen.getAllByTestId('pause-all').at(-1)?.textContent).toBe('Resume all')
  })

  it('arms the stop on the first click and fires on the second', () => {
    renderHeader()
    const stop = screen.getByTestId('stop-split')
    expect(stop.getAttribute('data-armed')).toBe('false')
    expect(screen.queryByTestId('stop-cancel')).toBeNull()

    act((): void => { stop.click() })
    expect(screen.getByTestId('stop-split').getAttribute('data-armed')).toBe('true')
    expect(screen.getByTestId('stop-split').textContent).toBe('Stop everything')
    expect(screen.getByTestId('stop-cancel')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()

    act((): void => { screen.getByTestId('stop-split').click() })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/emergency-stop', expect.objectContaining({ method: 'POST' }))
  })

  it('disarms on Cancel without firing', () => {
    renderHeader()
    act((): void => { screen.getByTestId('stop-split').click() })
    act((): void => { screen.getByTestId('stop-cancel').click() })
    expect(screen.getByTestId('stop-split').getAttribute('data-armed')).toBe('false')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows the HALTED pill and offers Clear halt instead of Stop while halted', () => {
    facts = shellFacts({ haltedReason: 'emergency stop by eren' })
    renderHeader()
    expect(screen.getByTestId('halted-pill').textContent).toContain('HALTED')
    const stop = screen.getByTestId('stop-split')
    expect(stop.textContent).toBe('Clear halt')
    act((): void => { stop.click() })
    // One click, no arming: clearing a halt is not destructive.
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/clear-halt', expect.objectContaining({ method: 'POST' }))
  })

  it('posts pause-all and resume-all to their own routes', () => {
    renderHeader()
    act((): void => { screen.getByTestId('pause-all').click() })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/pause-all', expect.objectContaining({ method: 'POST' }))
  })

  it('renders no project cluster at all on a global route', () => {
    pathname = '/workforce'
    facts = null
    renderHeader()
    expect(screen.getByTestId('breadcrumb').getAttribute('data-crumbs')).toBe('Workforce')
    expect(screen.queryByTestId('budget')).toBeNull()
    expect(screen.queryByTestId('pause-all')).toBeNull()
    expect(screen.queryByTestId('stop-split')).toBeNull()
  })

  it('renders whatever a page put in the action slot, and nothing when a page put nothing', () => {
    renderHeader()
    expect(screen.queryByTestId('header-action')).toBeNull()
    render(
      <HeaderActionProvider>
        <Header projects={PROJECTS} />
        <SetsAction />
      </HeaderActionProvider>,
    )
    expect(screen.getAllByTestId('header-action').at(-1)?.textContent).toBe('+ New project')
  })

  it('names the project on a route whose page publishes no ShellFacts (spec erratum E12)', () => {
    pathname = '/w/w1/organization'
    facts = null
    renderHeader()
    // The name comes from the TREE, so it is there even though nothing published.
    expect(screen.getByTestId('breadcrumb').getAttribute('data-crumbs')).toBe('Projects/Checkout rewrite/Team')
  })
})

/** A page that declares a header action, the way `ProjectsClient` will. `useHeaderAction` is a
 *  static import at the top of this file (scan finding 17): `require` is not defined in a vitest
 *  ESM module and threw a `ReferenceError` in the draft of this plan. */
function SetsAction(): null {
  useHeaderAction(<button type="button">+ New project</button>, [])
  return null
}
```

- [ ] **Step 8: Run it and watch it fail**

```bash
npx vitest run apps/web/test/header.test.tsx
```

Expected: FAIL — `Failed to resolve import "../src/components/shell/Header.js"`.

- [ ] **Step 9: Write `Header`**

Create `apps/web/src/components/shell/Header.tsx`:

```tsx
'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { breadcrumbOf, workspaceIdOf } from '../../lib/routes'
import { formatUsd } from '../../lib/realMoney'
import { postControl } from '../../lib/postControl'
import { useShellFacts } from '../../hooks/useShellFacts'
import type { SidebarProject } from '../../server/sidebar'
import { useHeaderActionNode } from './HeaderActionProvider'

/** The three shapes the right half of the split button takes (README "Shell" → Header). A halted
 *  project offers the way OUT rather than the way further in. */
type StopState = 'idle' | 'armed' | 'halted'

/**
 * The 54px header (M57 R7): a breadcrumb, a halt pill, the money, one split button, and a slot the
 * page fills.
 *
 * It is mounted by the ROOT layout and is therefore on EVERY page, global routes included -- which
 * is what lets the breadcrumb be the one thing that always says where you are. The project cluster
 * (budget, split button) renders only inside `/w/:id/*`, and only once the page has published its
 * facts: the header opens no connection of its own, exactly as `ProjectHeader` did not (M24 §2.2).
 *
 * `ProjectHeader.tsx`'s gradient hairline does not come with it. That was the old handoff's
 * signature and the new one draws a plain `--line` rule; `project-header-hairline` is in §3's
 * removed column with "nothing" beside it.
 */
export function Header({ projects }: { readonly projects: readonly SidebarProject[] }): React.JSX.Element {
  const pathname = usePathname()
  const workspaceId = workspaceIdOf(pathname)
  const facts = useShellFacts(workspaceId)
  const action = useHeaderActionNode()
  // THE NAME COMES FROM THE TREE (spec erratum E12). `useShellFacts` carries a name too, but only
  // five of the eight project page clients publish to it -- `/organization`, `/knowledge` and
  // `/office` publish nothing -- so a breadcrumb that read the name from that store alone would say
  // the workspace ID on three routes. The tree is read server-side by the root layout and is
  // complete on every route by construction. `ShellFactsSeed` (Step 9b) fills the store for the
  // budget and the halt state on those same three routes.
  const projectName = projects.find((project) => project.id === workspaceId)?.name ?? facts?.workspace.name ?? null
  const [armed, setArmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const halted = facts?.status.haltedReason != null
  // Disarm whenever the project changes or the halt lands: an armed button carried across a
  // navigation is a destructive control a person did not mean to leave cocked.
  useEffect((): void => setArmed(false), [workspaceId, halted])

  const crumbs = breadcrumbOf(pathname, projectName)
  const stopState: StopState = halted ? 'halted' : armed ? 'armed' : 'idle'

  const post = async (url: string): Promise<void> => {
    setPending(true)
    const result = await postControl(url)
    setPending(false)
    setErrorText(result.ok ? null : result.error)
  }

  // `slavesPaused` beside `slavesWorking` is what tells "everything is paused" from "nothing is
  // running" (plan erratum E2) -- and an idle project must not be offered a Resume that would
  // resume nothing.
  const resuming = facts !== null && facts.counts.slavesWorking === 0 && facts.counts.slavesPaused > 0
  const budgetUsd = facts?.guardrails.budgetUsd ?? null
  const spent = facts?.status.spentUsd ?? 0
  const ratio = budgetUsd === null || budgetUsd <= 0 ? 0 : spent / budgetUsd
  const barTone = ratio >= 1 ? 'bg-s-blocked' : ratio >= 0.8 ? 'bg-s-waiting' : 'bg-accent'

  return (
    <header
      data-testid="app-header"
      className="flex h-[54px] flex-none items-center gap-3 border-b border-line bg-panel px-[24px]"
    >
      {/* README: 13px, `--t3` segments, the last one `--t1` at 600. `data-crumbs` is the gate's
        * read of the same list, so a breadcrumb that is right on screen and wrong in the DOM is
        * not a thing that can happen. */}
      <nav aria-label="Breadcrumb" data-testid="breadcrumb" data-crumbs={crumbs.map((crumb) => crumb.text).join('/')} className="flex items-center gap-[6px] text-[13px]">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.text}-${String(index)}`} className="flex items-center gap-[6px]">
            {index > 0 && <span aria-hidden className="text-t3">/</span>}
            <span className={crumb.last ? 'font-semibold text-t1' : 'text-t3'}>{crumb.text}</span>
          </span>
        ))}
      </nav>

      {halted && (
        <span
          data-testid="halted-pill"
          title={facts?.status.haltedReason ?? undefined}
          className="inline-flex items-center gap-[6px] rounded-pill bg-[color-mix(in_oklab,var(--s-blocked)_14%,transparent)] px-[10px] py-[4px] font-mono text-[11.5px] font-medium text-s-blocked"
        >
          <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-s-blocked" />
          HALTED · nothing is scheduled
        </span>
      )}

      {errorText !== null && (
        <span role="alert" data-testid="header-error" className="truncate text-[12.5px] text-s-blocked">
          {errorText}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {facts !== null && workspaceId !== null && (
          <>
            <span data-testid="budget" className="flex items-center gap-2 font-mono text-[12.5px] font-medium text-t2">
              <span>
                {formatUsd(spent)}
                {budgetUsd !== null && ` / ${formatUsd(budgetUsd)}`}
              </span>
              {facts.status.unmeasuredRuns > 0 && (
                <span data-testid="budget-unmeasured" className="text-t3">
                  · {facts.status.unmeasuredRuns} unmeasured
                </span>
              )}
              {/* No bar at all for an unbudgeted project (M12 Task 9 / R11): a bar is a fraction of
                * a ceiling, and an empty track reads as "0% of something" rather than "there is no
                * something". README: 100 x 5px, accent fill. */}
              {budgetUsd !== null && (
                <span data-testid="budget-bar" className="block h-[5px] w-[100px] overflow-hidden rounded-hair bg-sel">
                  <span
                    className={`block h-full motion-safe:[transition:width_.5s_ease] ${barTone}`}
                    style={{ width: `${String(Math.min(100, ratio * 100))}%` }}
                  />
                </span>
              )}
            </span>

            <span aria-hidden className="mx-1 h-[20px] w-px bg-line2" />

            <span className="inline-flex overflow-hidden rounded-card border border-line2 text-[13px]">
              <button
                type="button"
                data-testid="pause-all"
                disabled={pending}
                onClick={() => void post(`/api/w/${workspaceId}/runs/${resuming ? 'resume-all' : 'pause-all'}`)}
                className="border-0 bg-transparent px-3 py-[6px] text-t1 transition-colors hover:bg-hover disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
              >
                {resuming ? 'Resume all' : 'Pause all'}
              </button>
              <span aria-hidden className="w-px bg-line2" />
              {/* ONE button, three states. Armed is the two-step `DangerConfirm` recipe M44 R3
                * made the only way to fire a destructive action -- kept here in the split button's
                * own geometry rather than by mounting `DangerConfirm`, because that component
                * renders its own trigger and its own confirm as two elements and the README draws
                * one control that CHANGES. The rule it exists to enforce is intact: the first
                * click never fires, and Cancel is always beside the armed state. */}
              <button
                type="button"
                data-testid="stop-split"
                data-armed={String(stopState === 'armed')}
                aria-label={stopState === 'halted' ? 'Clear the safety halt' : stopState === 'armed' ? 'Confirm: stop everything' : 'Emergency stop'}
                disabled={pending}
                onClick={() => {
                  if (stopState === 'halted') void post(`/api/w/${workspaceId}/clear-halt`)
                  else if (stopState === 'armed') {
                    setArmed(false)
                    void post(`/api/w/${workspaceId}/emergency-stop`)
                  } else setArmed(true)
                }}
                className={`border-0 px-3 py-[6px] transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                  stopState === 'armed' ? 'bg-s-blocked font-semibold text-white' : 'bg-transparent text-s-blocked hover:bg-hover'
                }`}
              >
                {stopState === 'halted' ? 'Clear halt' : stopState === 'armed' ? 'Stop everything' : 'Stop ▾'}
              </button>
              {stopState === 'armed' && (
                <>
                  <span aria-hidden className="w-px bg-line2" />
                  <button
                    type="button"
                    data-testid="stop-cancel"
                    onClick={() => setArmed(false)}
                    className="border-0 bg-transparent px-3 py-[6px] text-t2 transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                  >
                    Cancel
                  </button>
                </>
              )}
            </span>
          </>
        )}

        {action !== null && <span data-testid="header-action">{action}</span>}
      </div>
    </header>
  )
}
```

- [ ] **Step 10: Run the header test and watch it pass**

```bash
npx vitest run apps/web/test/header.test.tsx
```

Expected: PASS, 12 tests.

- [ ] **Step 11: Mount the header, and strip the project layout**

In `apps/web/src/app/layout.tsx`, import `Header` and pass it — **with the tree**, which is what
lets it name the project on every route (spec erratum E12):

```tsx
import { Header } from '../components/shell/Header'
```

```tsx
              <AppShell sidebar={<SidebarTree initial={projects} />} header={<Header projects={projects} />} right={null} rightWidth="none">
```

Replace the whole of `apps/web/src/app/w/[workspaceId]/layout.tsx` with:

```tsx
import type React from 'react'
import { buildShellFacts } from '../../../server/shell'
import { ShellFactsSeed } from '../../../components/shell/ShellFactsSeed'

export const dynamic = 'force-dynamic'

/**
 * The project layout seeds the shell's facts and renders its page (M57 R4/R7, spec erratum E12).
 *
 * Until M57 it mounted `ProjectHeader` and `ProjectTabs` as siblings of `{children}` and made THREE
 * server reads to feed them. Two of those are gone: the workspace list is the sidebar tree's server
 * read now, and the archived flag is drawn by the pages that can act on it (the Projects card, the
 * project Settings danger zone).
 *
 * `buildShellFacts` STAYS, and that is the erratum. The header is mounted by the ROOT layout and
 * reads `hooks/useShellFacts.ts` — a store only five of this segment's eight page clients publish
 * into. `/organization`, `/knowledge` and `/office` publish nothing, so without this seed the
 * budget figure and the entire `Pause all | Stop ▾` cluster would vanish on three of a project's
 * own pages. One read per MOUNT of this segment (Next keeps a shared layout mounted across soft
 * navigations between its siblings, so a Tasks→Team→Activity hop reuses it), and a page that DOES
 * stream overwrites the seed on its first snapshot.
 *
 * It stays as a file rather than being deleted for a second reason too: the segment is what gives
 * every page below it the `[workspaceId]` param, and `dynamic = 'force-dynamic'` here is what keeps
 * the whole subtree out of the static cache.
 */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ workspaceId: string }>
  children: React.ReactNode
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const facts = await buildShellFacts(workspaceId)
  return (
    <>
      {facts !== null && <ShellFactsSeed facts={facts} />}
      {children}
    </>
  )
}
```

- [ ] **Step 11b: Write `ShellFactsSeed`**

Create `apps/web/src/components/shell/ShellFactsSeed.tsx`:

```tsx
'use client'

import { useEffect } from 'react'
import { publishShellFacts } from '../../hooks/useShellFacts'
import type { ShellFacts } from '../../server/shell'

/**
 * Puts the project layout's server-read facts into the module store the header reads (spec
 * erratum E12).
 *
 * It renders NOTHING. It exists because `useShellFacts` is a module-level `useSyncExternalStore`
 * publisher — the shape M24 was forced into when the header was a sibling of `{children}` — and
 * only five of this segment's eight page clients publish into it. Three pages
 * (`/organization`, `/knowledge`, `/office`) never did, and before this component the header simply
 * had nothing to show on them.
 *
 * A page that DOES stream publishes its own snapshot on mount and on every refetch, which
 * overwrites this seed with something fresher — so this is a floor, never a ceiling, and there is
 * no ordering to get right between the two.
 *
 * The retraction is keyed on the workspace alone, exactly as every page client's is: folding it
 * into the publish effect's cleanup would retract and re-publish on every re-render, and the header
 * would blink through its empty state in between.
 */
export function ShellFactsSeed({ facts }: { readonly facts: ShellFacts }): null {
  useEffect((): void => {
    publishShellFacts(facts.workspace.id, facts)
  }, [facts])
  useEffect((): (() => void) => () => publishShellFacts(facts.workspace.id, null), [facts.workspace.id])
  return null
}
```

Add one case to `apps/web/test/project-layout.test.tsx` (Step 12's rewrite) asserting the seed is
mounted for a known workspace and absent for an unknown one.

- [ ] **Step 12: Delete the four components and their tests**

```bash
git rm apps/web/src/components/project/ProjectHeader.tsx \
       apps/web/src/components/project/ProjectTabs.tsx \
       apps/web/src/components/project/ProjectSwitcher.tsx \
       apps/web/src/components/project/OverviewAdvanced.tsx \
       apps/web/test/project-tabs.test.tsx
grep -rn "ProjectHeader\|ProjectTabs\|ProjectSwitcher\|OverviewAdvanced" apps/web/src apps/web/test scripts
```

Every hit the grep reports must be dealt with in THIS task, and they come in two kinds.

**Kind one: real imports and elements.** Listed below.

**Kind two: comment-only references** — nine files whose PROSE names a component this task deletes,
with no code on the line (scan findings 13 and 14). They are in the Files block above, by path and
line. Edit the sentence, change nothing else in the file, and do not let the grep's noise pull a
protected module into this task: `server/overview.ts` and `server/org.ts` are on the Global
Constraints' "untouched" list, and that list now says in as many words that a comment is not
behaviour. `scripts/gate-m52-broker.mjs:1383-1386` is the ninth — its comment explains why a locator
is scoped by naming the Overview's `Advanced` disclosure, which stops existing here; rewrite the
sentence, leave the locator alone, and note that Task 8's gate loop re-runs m52.

The real ones:
- `apps/web/src/components/OverviewClient.tsx` — the `<OverviewAdvanced …/>` element and its import.
  **Delete both.** Its four children are re-homed by later tasks (R11): the Supervisor panel is
  Task 5's right panel, `BlockedPanel` becomes Task 6's **Needs you** card, and `LiveEventsPanel`
  and `MergeQueuePanel` keep their components and are rendered by Task 6's **Recent changes**
  section and Task 7's Review column. **In this task, leave `BlockedPanel`, `LiveEventsPanel` and
  `MergeQueuePanel` rendered directly on the Overview**, below the team grid, in the same order the
  disclosure held them — they are not to disappear for four tasks, and a page that loses three
  panels in task 4 and gets them back in task 6 is a page nobody can review in between.
- `apps/web/test/overview-components.test.tsx` — the `overview-advanced` entries in its two `order`
  arrays (lines 863 and 892: drop the trailing `'overview-advanced'` member), the
  `overview-advanced-toggle` click, the three `advanced-link-*` cases and the two
  `advanced-panel-supervisor` cases. Delete those cases; keep every other case in the file.
- `apps/web/test/project-header.test.tsx` — **delete the file** (`git rm`; the Files list above says
  the same, and an earlier draft of this plan said "rewrite" in one place and "delete" in the other
  — scan finding 12). Everything it pinned is either gone (`project-switcher*`, `project-goal`,
  `project-header-hairline`, `connection`) or is re-asserted in `apps/web/test/header.test.tsx`
  (`budget`, `budget-unmeasured`, the halted state). `project-archived` moves to the Projects page's
  own test, where the chip now lives.
- `apps/web/test/project-layout.test.tsx` — rewrite it to the one thing the layout still does:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ProjectLayout from '../src/app/w/[workspaceId]/layout.js'

describe('the project layout', () => {
  it('renders its page and nothing else -- the header is the root layout s now (M57 R7)', () => {
    render(<ProjectLayout><div data-testid="page">page</div></ProjectLayout>)
    expect(screen.getByTestId('page')).toBeTruthy()
    expect(screen.queryByTestId('app-header')).toBeNull()
    expect(screen.queryByTestId('project-header')).toBeNull()
  })
})
```

- [ ] **Step 13: Update the five remaining gate scripts**

**`scripts/gate-m11-shell.mjs`, lines 444–447.** Replace:

```js
  // The header's `budget` chip (M57 R7 -- the project header is the root layout's `app-header`
  // now, on every page, and the budget figure came with it).
  await page.goto(`${baseUrl}/w/${workspaceIdA}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('app-header'), `the "${workspaceNameA}" header`)
  await waitVisible(page.getByTestId('budget'), "the header's budget figure")
  console.log(`the "${workspaceNameA}" header shows a budget figure`)
```

**`scripts/gate-m14-fidelity.mjs`, line 941.** Replace the row:

```js
    ['overview', `/w/${workspaceId}`, '[data-testid="app-header"]', 'height', '54px'],
```

*(Task 9 rewrites the whole `NUMBERS` table; this one row moves now because it would otherwise fail
the moment the header is deleted, and a gate left red across five tasks is a gate nobody reads.)*
In the same file, delete the `openOverviewAdvanced` helper (lines ~920–932) and the `live-events`
row's `openOverviewAdvanced` argument — the disclosure it clicks is gone. **Leave the `live-events`
row itself**: Step 12 keeps that panel on the Overview, un-disclosed, so the 340px number is still
measurable. Task 9 decides its fate.

**`scripts/gate-m18-skill-and-teeth.mjs`, lines 845–865.** The connection chip is the sidebar's
footer now, and it says `live · <n>ms` rather than `sse · <n>ms`:

```js
  await waitVisible(page.getByTestId('sidebar-live'), 'the sidebar live chip')
  const beforeTick = (await page.getByTestId('sidebar-live').first().textContent())?.trim()
  console.log(`stage 3: live chip before a fresh frame: ${JSON.stringify(beforeTick)}`)
```

…and the `waitUntil` below it:

```js
  await waitUntil('the live chip to read live · <n>ms once the stream ticks', ACTION_TIMEOUT_MS, async () => {
    const text = await page.getByTestId('sidebar-live').first().textContent().catch(() => null)
    return text !== null && /live · \d+ms/.test(text) ? { done: true, value: text } : { done: false, detail: `chip reads ${JSON.stringify(text)}` }
  })
  console.log('stage 3: the sidebar chip reads live · <n>ms once the stream ticked')
```

**`scripts/gate-m47-team-formation.mjs`, line 966.** Replace:

```js
  const tabHref = await page.evaluate(
    () => document.querySelector('[data-testid="sidebar-section"][data-section="organization"]')?.getAttribute('href') ?? null,
  )
```

…and update the `fail`/`console.log` beside it to say "the tree's Team row" instead of "the
Organization tab". The expected href does not change.

**`scripts/gate-m49-memory.mjs`, lines 1530–1547** (erratum E7 — the same set assertion over the
same six values, read off the tree instead of the strip):

```js
  // M57 R5: the project's sections are the sidebar tree's rows now, and each carries its ROUTE
  // SEGMENT on `data-section` -- the same six ids the tab strip carried, with two labels changed.
  const tabs = await page
    .locator('[data-testid="sidebar-section"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-section') ?? ''))
  const knowledgeRow = page.locator('[data-testid="sidebar-section"][data-section="knowledge"]')
  const knowledgeTab = (await knowledgeRow.first().textContent())?.trim() ?? ''
  const knowledgeHref = await knowledgeRow.first().getAttribute('href')
```

**The binding keeps the name `tabs`** (scan finding 28): the `assertEqual(tabs, [...])` two lines
below is outside this replacement and renaming the left-hand side alone is a `ReferenceError`. Then
read the surrounding assertions and keep every one of them: the id set, the label text
(`Knowledge`, unchanged) and the href (`/w/<id>/knowledge`, unchanged).

- [ ] **Step 14: Run every gate this task touched**

```bash
pgrep -af vitest || echo "no vitest running"
for g in m11-shell m18-skill-and-teeth m44-ux-foundation m47-team-formation m49-memory; do
  echo "=== $g ==="
  npm run "gate:$g" 2>&1 | tail -12; echo "exit=${PIPESTATUS[0]}"
done
```

Expected: `exit=0` five times. Any failure on a testid this task did not name is a hit the greps
missed — fix it here and record it as an erratum.

- [ ] **Step 15: Suite, build, ladder and commit**

```bash
npx vitest run 2>&1 | tail -20
pgrep -af "next dev" || echo "no dev server"
npm run web:build 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"
npm run gate:m26-vocabulary && npx tsc --build && npm run --silent typecheck
git add -A
git commit -m "$(cat <<'MSG'
feat(m57): t4 — a breadcrumb, the money, and one button that asks twice

The header is the root layout's now, on every page including the global ones, which is
what lets the breadcrumb always say where you are. `Pause all | Stop ▾` is one control
with three states and the two-step rule intact: the first click never fires. Three
routes it needed and did not have -- pause-all over the fan-out `emergencyStop` already
uses, resume-all over the per-run verb a worker card already calls, and clear-halt,
which had no web route at all because it was a CLI case writing two columns inline.
That case now calls the same function the route does. `ProjectHeader`, `ProjectTabs`,
`ProjectSwitcher` and `OverviewAdvanced` are gone; every destination they pointed at is
one click away in the tree, and five gate scripts say so.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tb1HCWnBqh63E9diBxdxR6
MSG
)"
```

---

### Task 5: The right panel — a Supervisor with a memory, and two big panels that slide into the slot (R8, R9, E4, E5)

**Files:**
- Create: `apps/web/src/server/supervisorThreads.ts`
- Create: `apps/web/src/app/api/w/[workspaceId]/supervisor/threads/route.ts`
- Create: `apps/web/src/components/shell/RightPanel.tsx`
- Create: `apps/web/src/components/shell/RightPanelDock.tsx`
- Create: `apps/web/src/components/shell/RightPanelHost.tsx`
- Create: `apps/web/src/components/supervisor/SupervisorThreadPanel.tsx`
- Create: `apps/web/test/integration/supervisor-threads.test.ts`
- Create: `apps/web/test/supervisor-thread-panel.test.tsx`
- Create: `apps/web/test/right-panel.test.tsx`
- Modify: `apps/web/src/app/layout.tsx` (`right={<RightPanelHost />}` and a `rightWidth` that follows the route)
- Modify: `apps/web/src/components/SlavePanel.tsx` (ONE className, line 288)
- Modify: `apps/web/src/components/TaskDetailPanel.tsx` (ONE className, line 263)
- Modify: `apps/web/src/components/OverviewClient.tsx` (mirror `?slave=` into the provider)
- Modify: `apps/web/src/components/TasksClient.tsx` (mirror `?task=` into the provider)
- Create: `apps/web/src/components/supervisor/ProposalRow.tsx` (**extracted**, not written — spec erratum E18)
- Modify: `apps/web/src/components/project/SupervisorTimeline.tsx` (one import line)
- Modify: `apps/web/test/overview-components.test.tsx`, `apps/web/test/tasks-components.test.tsx` (wrap in `RightPanelProvider` — Step 16b)
- Delete: `apps/web/src/components/SupervisorPanel.tsx`, `apps/web/test/supervisor-panel.test.tsx`

**Interfaces:**
- Consumes from Task 3: `useRightPanel`, `RightPanelMode`, `AppShell`'s `right`/`rightWidth`. From Task 2: `workspaceIdOf`, `isGlobalRoute`.
- Produces, for Tasks 6–9:
  - `export interface SupervisorMessage { readonly id: string; readonly who: 'operator' | 'supervisor'; readonly text: string; readonly at: string; readonly refs: readonly string[]; readonly decisionId: string | null }`
  - `export interface SupervisorThread { readonly id: string; readonly title: string; readonly when: string; readonly messages: readonly SupervisorMessage[] }`
  - `export async function buildSupervisorThreads(workspaceId: string, now?: Date): Promise<readonly SupervisorThread[]>` (newest thread first)
  - `GET /api/w/:id/supervisor/threads`
  - testids `right-panel`, `right-dock`, `dock-supervisor`, `dock-activity`, `dock-badge`, `panel-collapse`, `panel-close`, `supervisor-thread`, `supervisor-thread-row`, `supervisor-history`, `supervisor-new`, `supervisor-message`, `supervisor-decision-card`, `supervisor-decision-approve`, `supervisor-decision-decline`, `supervisor-empty`, `supervisor-composer` (the WRAPPER), `supervisor-request-input`, `supervisor-request-send`, `supervisor-request-result` (SUCCESS), `supervisor-request-error` (refusal), and — carried over from the panel this task deletes — `supervisor-decision-meta` and `supervisor-proposal-kind` (spec errata E17, E18).
  - `ProposalRow`, re-exported from `apps/web/src/components/supervisor/ProposalRow.tsx` with every one of its own testids unchanged.

- [ ] **Step 1: Write the failing test for the thread reader**

Create `apps/web/test/integration/supervisor-threads.test.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildSupervisorThreads } from '../../src/server/supervisorThreads.js'
import { truncateAll } from './projectFixture.js'

async function seed(): Promise<string> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Threads', repoPath: '/tmp/m57-threads', verifyCommands: ['true'], setupCommands: [] },
  })
  return workspace.id
}

/** `appendEvent` stamps `ts` itself, so a test that needs two DAYS has to move the row afterwards.
 *  One `updateMany` by `seq` is the smallest way to do it and touches nothing else. */
async function backdate(workspaceId: string, seq: number, ts: Date): Promise<void> {
  await prisma.executionEvent.updateMany({ where: { workspaceId, seq }, data: { ts } })
}

describe('buildSupervisorThreads', () => {
  beforeEach(async (): Promise<void> => {
    await truncateAll()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('reads a goal request as the OPERATOR s own message, in their own words', async (): Promise<void> => {
    const workspaceId = await seed()
    await appendEvent({
      type: 'workspace.goal_set',
      workspaceId,
      actor: 'human',
      payload: { goal: 'Ship the new checkout', version: 2, sha256: 'abc', request: 'make the cart totals right' },
    })

    const threads = await buildSupervisorThreads(workspaceId)

    expect(threads).toHaveLength(1)
    const [message] = threads[0]?.messages ?? []
    expect(message?.who).toBe('operator')
    expect(message?.text).toBe('make the cart totals right')
  })

  it('reads a goal set with no request as the SUPERVISOR s, not as words nobody typed', async (): Promise<void> => {
    const workspaceId = await seed()
    await appendEvent({
      type: 'workspace.goal_set',
      workspaceId,
      actor: 'system',
      payload: { goal: 'Ship the new checkout', version: 1, sha256: 'abc' },
    })

    const [thread] = await buildSupervisorThreads(workspaceId)

    expect(thread?.messages[0]?.who).toBe('supervisor')
  })

  it('carries a pending proposal as a message with a decision id on it', async (): Promise<void> => {
    const workspaceId = await seed()
    await appendEvent({
      type: 'supervisor.proposed',
      workspaceId,
      actor: 'system',
      payload: {
        decisionId: 'd-1',
        situationKind: 'ready_unstaffed',
        subjectId: 'reviewer',
        action: { kind: 'hire_slave' },
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    })

    const [thread] = await buildSupervisorThreads(workspaceId)

    expect(thread?.messages[0]?.who).toBe('supervisor')
    expect(thread?.messages[0]?.decisionId).toBe('d-1')
  })

  it('groups by LOCAL CALENDAR DAY, newest thread first, oldest message first inside one', async (): Promise<void> => {
    const workspaceId = await seed()
    const older = await appendEvent({
      type: 'workspace.goal_set',
      workspaceId,
      actor: 'human',
      payload: { goal: 'a', version: 1, sha256: 'x', request: 'yesterday' },
    })
    const newer = await appendEvent({
      type: 'workspace.goal_set',
      workspaceId,
      actor: 'human',
      payload: { goal: 'b', version: 2, sha256: 'y', request: 'today' },
    })
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    await backdate(workspaceId, Number(older.seq), yesterday)
    void newer

    const threads = await buildSupervisorThreads(workspaceId)

    expect(threads).toHaveLength(2)
    expect(threads[0]?.messages.map((m) => m.text)).toEqual(['today'])
    expect(threads[1]?.messages.map((m) => m.text)).toEqual(['yesterday'])
    // The id IS the day, so a URL or a test can name one without a lookup.
    expect(threads[0]?.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(threads[0]?.id).not.toBe(threads[1]?.id)
  })

  it('reads no other family -- a run starting is not a conversation', async (): Promise<void> => {
    const workspaceId = await seed()
    await appendEvent({ type: 'workspace.created', workspaceId, actor: 'human', payload: { name: 'Threads' } })

    expect(await buildSupervisorThreads(workspaceId)).toEqual([])
  })

  it('answers an empty list for a workspace with no history at all', async (): Promise<void> => {
    expect(await buildSupervisorThreads(await seed())).toEqual([])
  })
})
```

*(`appendEvent`'s return shape and its required fields are in `packages/events/src/append.ts` —
check it before running, and if it does not return the row, read the `seq` back with a
`findFirst({ orderBy: { seq: 'desc' } })` instead. Check the `supervisor.proposed` payload against
`packages/domain/src/events/schema.ts:505-516`; the schema validates on append, so a wrong field
throws rather than being ignored.)*

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/web/test/integration/supervisor-threads.test.ts
```

Expected: FAIL — `Failed to resolve import "../../src/server/supervisorThreads.js"`.

- [ ] **Step 3: Write the thread reader**

Create `apps/web/src/server/supervisorThreads.ts`:

```ts
import { prisma } from '@slave-of-ai/db/client'
import { DOMAIN_EVENT_TYPE_BY_DB_VALUE, EVENT_TYPE_BY_DOMAIN_TYPE, type DomainEventType } from '@slave-of-ai/db'
import { feedSummary } from '../lib/feedSummary'

/** One bubble in the panel. `who` decides which side it is drawn on and which shape its corners
 *  take (README "Supervisor panel"); `decisionId` is how a card is matched onto the message it
 *  belongs inside, from the pending-decisions read the page already makes. */
export interface SupervisorMessage {
  readonly id: string
  readonly who: 'operator' | 'supervisor'
  readonly text: string
  /** ISO. */
  readonly at: string
  /** The small mono chips under a message — a goal version, a task id. Never more than two. */
  readonly refs: readonly string[]
  readonly decisionId: string | null
}

/** One conversation. `id` IS the local calendar day (`YYYY-MM-DD`), which is what makes this a
 *  grouping rather than a table (M57 R9). */
export interface SupervisorThread {
  readonly id: string
  readonly title: string
  /** What the `≡` list shows on the right of a row: `today`, `yesterday`, or the date. */
  readonly when: string
  readonly messages: readonly SupervisorMessage[]
}

/**
 * The six families that ARE the conversation (M57 R9).
 *
 * A conversation between an operator and the Supervisor is: what the operator asked for
 * (`workspace.goal_set` carrying the `request` M45 R3 put on it), what the Supervisor proposed,
 * what it decided, what became of a proposal, what it managed to do and what it could not. Nothing
 * else is addressed to a person. A run starting is activity, and `/w/:id/activity` is where the
 * whole river is.
 */
const THREAD_TYPES: readonly DomainEventType[] = [
  'workspace.goal_set',
  'supervisor.proposed',
  'supervisor.decided',
  'supervisor.resolved',
  'supervisor.applied',
  'supervisor.failed',
]

/** `YYYY-MM-DD` in the SERVER's own zone — the same zone the timestamps beside each message are
 *  formatted in, so a message can never fall in a thread dated differently from its own clock. */
function localDay(at: Date): string {
  const year = at.getFullYear()
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${String(year)}-${month}-${day}`
}

function whenLabel(day: string, now: Date): string {
  const today = localDay(now)
  if (day === today) return 'today'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (day === localDay(yesterday)) return 'yesterday'
  return day
}

/** A string field off an untyped payload, or null. Payloads are `Json` and every optional member
 *  on them is genuinely optional (a row written before the field existed carries none). */
function stringAt(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The Supervisor panel's conversation history — a GROUPING over rows that already exist.
 *
 * There is no conversation table and this milestone refuses to add one (M57 R9): a thread is a
 * LOCAL CALENDAR DAY, which is the one grouping the data can actually support and the one a person
 * can predict without being told. The `+` button in the panel starts a thread for today and writes
 * nothing — there is no row to create; it is a scroll position and an empty composer.
 *
 * `feedSummary` is the same projection the Activity river and the Overview's live-events panel
 * read, so a supervisor message says here exactly what it says there (`docs/ia.md` rule 3: the raw
 * dotted type stays available, and the panel puts it on each bubble's `data-event-type`).
 *
 * Newest thread first, oldest message first inside a thread — the order a person reads a list of
 * conversations in, and the order they read one.
 */
export async function buildSupervisorThreads(
  workspaceId: string,
  now: Date = new Date(),
): Promise<readonly SupervisorThread[]> {
  const rows = await prisma.executionEvent.findMany({
    where: { workspaceId, type: { in: THREAD_TYPES.map((type) => EVENT_TYPE_BY_DOMAIN_TYPE[type]) } },
    orderBy: { seq: 'asc' },
    // A conversation is not an audit log: two hundred bubbles is already more than anybody scrolls,
    // and the whole history is one click away in Activity.
    take: 200,
  })

  const byDay = new Map<string, SupervisorMessage[]>()
  for (const row of rows) {
    const domainType = DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type] ?? (row.type as DomainEventType)
    const payload = row.payload as Record<string, unknown>
    // A goal set that carries the words somebody TYPED is that person's message; one without is
    // the system saying a goal changed. Folding the two together would put the model's composed
    // document in a bubble attributed to a human.
    const request = domainType === 'workspace.goal_set' ? stringAt(payload, 'request') : null
    const refs: string[] = []
    const version = payload['version']
    if (typeof version === 'number') refs.push(`v${String(version)}`)
    const subjectId = stringAt(payload, 'subjectId')
    if (subjectId !== null) refs.push(subjectId)

    const day = localDay(row.ts)
    const message: SupervisorMessage = {
      id: String(row.seq),
      who: request === null ? 'supervisor' : 'operator',
      text: request ?? feedSummary(domainType, payload),
      at: row.ts.toISOString(),
      refs: refs.slice(0, 2),
      decisionId: stringAt(payload, 'decisionId'),
    }
    const bucket = byDay.get(day)
    if (bucket === undefined) byDay.set(day, [message])
    else bucket.push(message)
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, messages]) => ({
      id: day,
      // The first thing said that day, truncated -- a conversation's name is its opening line, the
      // way a mail thread's is its subject.
      title: (messages[0]?.text ?? 'Conversation').slice(0, 60),
      when: whenLabel(day, now),
      messages,
    }))
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run apps/web/test/integration/supervisor-threads.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Write the route**

Create `apps/web/src/app/api/w/[workspaceId]/supervisor/threads/route.ts`:

```ts
import { buildSupervisorThreads } from '../../../../../../server/supervisorThreads'
import { requirePrincipal } from '../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The Supervisor panel's conversation history (M57 R9). A read, so no control shell: there is
 *  nothing here to refuse. It sits beside `GET /api/w/:id/supervisor` (the panel's decisions and
 *  settings) rather than inside it, because the two have different costs and the panel refetches
 *  them on different wake-ups. */
export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  return Response.json(await buildSupervisorThreads(workspaceId))
}
```

- [ ] **Step 6: Write the failing test for the panel frame and the dock**

Create `apps/web/test/right-panel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RightPanelProvider, useRightPanel } from '../src/components/shell/RightPanelProvider.js'
import { RightPanel } from '../src/components/shell/RightPanel.js'
import { RightPanelDock } from '../src/components/shell/RightPanelDock.js'

let pathname = '/w/w1'

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const closed = vi.fn()

/** A stand-in owner: the page client that will call `open` from its `useSelectedId` effect. */
function Opener(): React.JSX.Element {
  const { open, close, collapse } = useRightPanel()
  return (
    <>
      <button data-testid="open-task" type="button" onClick={() => open('task', <div data-testid="task-body" />, closed)} />
      <button data-testid="close" type="button" onClick={close} />
      <button data-testid="collapse" type="button" onClick={collapse} />
    </>
  )
}

beforeEach((): void => {
  pathname = '/w/w1'
  closed.mockClear()
})

afterEach((): void => {
  vi.clearAllMocks()
})

describe('the right panel', () => {
  it('says which mode it is in, and shows the Supervisor by default inside a project', () => {
    render(
      <RightPanelProvider>
        <RightPanel title="Supervisor"><div data-testid="sup" /></RightPanel>
      </RightPanelProvider>,
    )
    const panel = screen.getByTestId('right-panel')
    expect(panel.getAttribute('data-mode')).toBe('supervisor')
    expect(panel.className).toContain('w-[372px]')
    expect(screen.getByTestId('sup')).toBeTruthy()
  })

  it('shows an opened mode s content instead, and says so on the node', () => {
    render(
      <RightPanelProvider>
        <Opener />
        <RightPanel title="Supervisor"><div data-testid="sup" /></RightPanel>
      </RightPanelProvider>,
    )
    act((): void => { screen.getByTestId('open-task').click() })
    expect(screen.getByTestId('right-panel').getAttribute('data-mode')).toBe('task')
    expect(screen.getByTestId('task-body')).toBeTruthy()
    expect(screen.queryByTestId('sup')).toBeNull()
  })

  it('hands the slot back on close, and calls the OWNER s clearer so the URL goes too (E5)', () => {
    render(
      <RightPanelProvider>
        <Opener />
        <RightPanel title="Supervisor"><div data-testid="sup" /></RightPanel>
      </RightPanelProvider>,
    )
    act((): void => { screen.getByTestId('open-task').click() })
    act((): void => { screen.getByTestId('close').click() })
    expect(closed).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('right-panel').getAttribute('data-mode')).toBe('supervisor')
    expect(screen.getByTestId('sup')).toBeTruthy()
  })

  it('collapses from its own » -- the same call the page s close makes', () => {
    render(
      <RightPanelProvider>
        <RightPanel title="Supervisor"><div data-testid="sup" /></RightPanel>
      </RightPanelProvider>,
    )
    expect(screen.getByTestId('panel-collapse')).toBeTruthy()
  })
})

describe('the dock', () => {
  it('is 52px, carries S and A, and badges the pending decisions', () => {
    render(
      <RightPanelProvider>
        <RightPanelDock workspaceId="w1" pendingDecisions={3} />
      </RightPanelProvider>,
    )
    const dock = screen.getByTestId('right-dock')
    expect(dock.className).toContain('w-[52px]')
    expect(screen.getByTestId('dock-supervisor')).toBeTruthy()
    expect(screen.getByTestId('dock-activity').getAttribute('href')).toBe('/w/w1/activity')
    expect(screen.getByTestId('dock-badge').textContent).toBe('3')
  })

  it('shows no badge when nothing is pending -- a zero badge is a false alarm', () => {
    render(
      <RightPanelProvider>
        <RightPanelDock workspaceId="w1" pendingDecisions={0} />
      </RightPanelProvider>,
    )
    expect(screen.queryByTestId('dock-badge')).toBeNull()
  })
})
```

- [ ] **Step 7: Run it and watch it fail**

```bash
npx vitest run apps/web/test/right-panel.test.tsx
```

Expected: FAIL — `Failed to resolve import "../src/components/shell/RightPanel.js"`.

- [ ] **Step 8: Write the panel, the dock and the host**

Create `apps/web/src/components/shell/RightPanel.tsx`:

```tsx
'use client'

import { useRightPanel } from './RightPanelProvider'

/**
 * The 372px slot (M57 R8).
 *
 * It owns the WIDTH, the surface and the 54px header bar; its content owns everything below. That
 * split is what lets `SlavePanel` and `TaskDetailPanel` move in here for the price of one className
 * each: they were `fixed inset-y-0 right-0 w-96` asides, and everything inside them was already a
 * vertical flex column that filled its parent.
 *
 * `children` is the DEFAULT content — the Supervisor, inside a project. Whatever the provider holds
 * replaces it while a task or a worker is selected, and comes back to it when that closes.
 */
export function RightPanel({
  title,
  children,
}: {
  readonly title: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  const { mode, content, close, collapse } = useRightPanel()
  const showing = mode ?? 'supervisor'
  return (
    <aside
      data-testid="right-panel"
      data-mode={showing}
      aria-label={showing === 'supervisor' ? 'Supervisor' : showing === 'task' ? 'Task detail' : 'Worker detail'}
      className="flex min-h-0 w-[372px] flex-none flex-col border-l border-line bg-panel"
    >
      {/* One header bar, at the header's own height, so the three columns line up across the top.
        * The panels that move in here bring their own title row BELOW this one -- theirs carries a
        * task id and a status pill, which this one cannot know about. */}
      <div className="flex h-[54px] flex-none items-center gap-2 border-b border-line px-[14px] pl-[16px]">
        <span className="flex-1 truncate text-[13.5px] font-semibold text-t1">{title}</span>
        {mode !== null && (
          <button
            type="button"
            data-testid="panel-close"
            aria-label="Close this panel"
            onClick={close}
            className="h-[30px] w-[30px] rounded-card border-0 bg-transparent text-[13px] text-t3 transition-colors hover:text-t1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            ✕
          </button>
        )}
        <button
          type="button"
          data-testid="panel-collapse"
          aria-label="Collapse the right panel"
          onClick={collapse}
          className="h-[30px] w-[30px] rounded-card border-0 bg-transparent text-[13px] text-t3 transition-colors hover:text-t1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          »
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{content ?? children}</div>
    </aside>
  )
}
```

Create `apps/web/src/components/shell/RightPanelDock.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { useRightPanel } from './RightPanelProvider'

/**
 * The 52px rail the panel collapses to (M57 R8, README "Shell" → Right panel).
 *
 * Two buttons: the accent `S` that brings the Supervisor back, carrying the pending-decision count
 * as a badge, and an `A` that goes to Activity. The badge is the whole reason the dock is not just
 * an empty gutter: a person who collapsed the panel still has to be told when something is waiting
 * on them.
 */
export function RightPanelDock({
  workspaceId,
  pendingDecisions,
}: {
  readonly workspaceId: string
  readonly pendingDecisions: number
}): React.JSX.Element {
  const { expand } = useRightPanel()
  return (
    <div
      data-testid="right-dock"
      className="flex w-[52px] flex-none flex-col items-center gap-2 border-l border-line bg-panel py-3"
    >
      <button
        type="button"
        data-testid="dock-supervisor"
        title="Supervisor"
        aria-label={pendingDecisions > 0 ? `Supervisor, ${String(pendingDecisions)} waiting on you` : 'Supervisor'}
        onClick={expand}
        className="relative grid h-[34px] w-[34px] place-items-center rounded-panel border-0 bg-accent font-mono text-[13px] font-semibold text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        S
        {pendingDecisions > 0 && (
          <span
            data-testid="dock-badge"
            className="absolute -right-1 -top-1 grid h-[16px] min-w-[16px] place-items-center rounded-pill border-2 border-panel bg-s-waiting px-1 font-mono text-[10px] font-semibold text-white"
          >
            {pendingDecisions}
          </span>
        )}
      </button>
      <Link
        data-testid="dock-activity"
        href={`/w/${workspaceId}/activity`}
        title="Activity"
        aria-label="Activity"
        className="grid h-[34px] w-[34px] place-items-center rounded-panel border border-line2 font-mono text-[12px] font-semibold text-t3 transition-colors hover:text-t1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        A
      </Link>
    </div>
  )
}
```

Create `apps/web/src/components/shell/RightPanelHost.tsx`:

```tsx
'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { workspaceIdOf } from '../../lib/routes'
import { useShellFacts } from '../../hooks/useShellFacts'
import { SupervisorThreadPanel, type PendingDecision } from '../supervisor/SupervisorThreadPanel'
import { RightPanel } from './RightPanel'
import { RightPanelDock } from './RightPanelDock'
import { useRightPanel } from './RightPanelProvider'

/**
 * What goes in the grid's third column, and how wide it is (M57 R8).
 *
 * NOTHING on a global route: `/`, `/workforce`, `/settings`, `/sim*` and `/analytics` have no
 * project to supervise, and a dock on them would be a button that opens an empty panel. Inside a
 * project it is the 372px panel, or the 52px dock once somebody has collapsed it.
 *
 * The pending-decision count the dock badges comes from one small read this component makes for
 * itself, refetched on the same wake-up everything else in the shell uses (`useShellFacts`'s
 * identity). It is a COUNT and not the decisions themselves: the panel below fetches those when it
 * is open, and the dock only has to know whether the number is zero.
 */
export function RightPanelHost(): React.JSX.Element | null {
  const pathname = usePathname()
  const workspaceId = workspaceIdOf(pathname)
  const facts = useShellFacts(workspaceId)
  const { collapsed } = useRightPanel()
  const [pending, setPending] = useState<readonly PendingDecision[]>([])

  // ONE fetch of this endpoint on this page (scan finding 22). The draft had this component fetch
  // `/api/w/:id/supervisor` for the dock's badge and `SupervisorThreadPanel` fetch the SAME endpoint
  // for the SAME `pending` array — two identical round trips per wake-up, for one number and one
  // list that are the same list. The host owns the fetch and passes the list down; the panel reads
  // `pending.length` for nothing and the dock reads it for the badge.
  useEffect((): void => {
    if (workspaceId === null) return
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const response = await fetch(`/api/w/${workspaceId}/supervisor`)
        if (!response.ok) return
        const view = (await response.json()) as { pending?: readonly PendingDecision[] }
        if (!cancelled) setPending(view.pending ?? [])
      } catch {
        /* the list stays as it was: a count that fails to refresh is better than one that lies */
      }
    })()
    return (): void => {
      cancelled = true
    }
  }, [workspaceId, facts])

  if (workspaceId === null) return null
  if (collapsed) return <RightPanelDock workspaceId={workspaceId} pendingDecisions={pending.length} />
  return (
    <RightPanel title="Supervisor">
      <SupervisorThreadPanel workspaceId={workspaceId} pending={pending} />
    </RightPanel>
  )
}
```

- [ ] **Step 9: Run the panel test and watch it pass**

```bash
npx vitest run apps/web/test/right-panel.test.tsx
```

Expected: PASS, 6 tests.

- [ ] **Step 10: Write the failing test for the Supervisor panel body**

Create `apps/web/test/supervisor-thread-panel.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SupervisorThreadPanel } from '../src/components/supervisor/SupervisorThreadPanel.js'
import type { SupervisorThread } from '../src/server/supervisorThreads.js'

vi.mock('next/navigation', () => ({
  usePathname: () => '/w/w1',
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock('../src/hooks/useShellFacts', () => ({ useShellFacts: () => null }))

const THREADS: readonly SupervisorThread[] = [
  {
    id: '2026-09-14',
    title: 'make the cart totals right',
    when: 'today',
    messages: [
      { id: '1', who: 'operator', text: 'make the cart totals right', at: '2026-09-14T09:00:00.000Z', refs: ['v2'], decisionId: null },
      { id: '2', who: 'supervisor', text: 'Supervisor · proposed', at: '2026-09-14T09:01:00.000Z', refs: ['T-118'], decisionId: 'd-1' },
    ],
  },
  { id: '2026-09-13', title: 'earlier', when: 'yesterday', messages: [
    { id: '0', who: 'operator', text: 'earlier', at: '2026-09-13T09:00:00.000Z', refs: [], decisionId: null },
  ] },
]

const DECISIONS = [{ id: 'd-1', situationKind: 'ready_unstaffed', situation: { summary: 'nobody can review' }, status: 'pending' }]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/supervisor/threads')) return new Response(JSON.stringify(THREADS), { status: 200 })
    if (url.includes('/supervisor')) return new Response(JSON.stringify({ pending: DECISIONS, recent: [], questions: [], settings: { enabled: true, profile: null }, report: {}, taskTitles: {} }), { status: 200 })
    return new Response(JSON.stringify({ ok: true, version: 3 }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach((): void => {
  vi.unstubAllGlobals()
})

describe('the Supervisor panel', () => {
  it('renders the newest thread, oldest message first, and says which side each is on', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" />)
    await waitFor(() => expect(screen.getAllByTestId('supervisor-message')).toHaveLength(2))
    const messages = screen.getAllByTestId('supervisor-message')
    expect(messages[0]?.getAttribute('data-who')).toBe('operator')
    expect(messages[0]?.textContent).toContain('make the cart totals right')
    expect(messages[1]?.getAttribute('data-who')).toBe('supervisor')
    expect(screen.getByTestId('supervisor-thread').getAttribute('data-thread-id')).toBe('2026-09-14')
  })

  it('lists the days behind ≡, and switching day switches the messages', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" />)
    await waitFor(() => expect(screen.getAllByTestId('supervisor-message')).toHaveLength(2))
    act((): void => { screen.getByTestId('supervisor-history').click() })
    const rows = screen.getAllByTestId('supervisor-thread-row')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.textContent).toContain('yesterday')
    act((): void => { rows[1]?.click() })
    await waitFor(() => expect(screen.getAllByTestId('supervisor-message')).toHaveLength(1))
    expect(screen.getByTestId('supervisor-thread').getAttribute('data-thread-id')).toBe('2026-09-13')
  })

  it('puts a decision card inside the message that carries its id', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" />)
    await waitFor(() => expect(screen.getByTestId('supervisor-decision-card')).toBeTruthy())
    const card = screen.getByTestId('supervisor-decision-card')
    expect(card.getAttribute('data-decision-id')).toBe('d-1')
    expect(card.textContent).toContain('nobody can review')
    const message = screen.getAllByTestId('supervisor-message')[1]
    expect(message?.contains(card)).toBe(true)
  })

  it('approves through the EXISTING route', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" />)
    await waitFor(() => expect(screen.getByTestId('supervisor-decision-approve')).toBeTruthy())
    act((): void => { screen.getByTestId('supervisor-decision-approve').click() })
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/supervisor/decisions/d-1/approve',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })

  it('sends the composer to the EXISTING goal/request route, on Enter', async (): Promise<void> => {
    render(<SupervisorThreadPanel workspaceId="w1" />)
    await waitFor(() => expect(screen.getByTestId('supervisor-composer')).toBeTruthy())
    const box = screen.getByTestId('supervisor-composer') as HTMLTextAreaElement
    act((): void => {
      box.value = 'add 3-D Secure'
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act((): void => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/w/w1/goal/request',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ request: 'add 3-D Secure' }) }),
      ),
    )
  })

  it('says so, once, when there is no conversation yet', async (): Promise<void> => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/supervisor/threads')
        ? new Response('[]', { status: 200 })
        : new Response(JSON.stringify({ pending: [], recent: [], questions: [], settings: { enabled: true, profile: null }, report: {}, taskTitles: {} }), { status: 200 }),
    )
    render(<SupervisorThreadPanel workspaceId="w1" />)
    await waitFor(() => expect(screen.getByTestId('supervisor-empty')).toBeTruthy())
    expect(screen.queryAllByTestId('supervisor-message')).toEqual([])
    // The composer is still there: an empty conversation is where you START one.
    expect(screen.getByTestId('supervisor-composer')).toBeTruthy()
  })
})
```

- [ ] **Step 11: Run it and watch it fail**

```bash
npx vitest run apps/web/test/supervisor-thread-panel.test.tsx
```

Expected: FAIL — `Failed to resolve import "../src/components/supervisor/SupervisorThreadPanel.js"`.

- [ ] **Step 12: Write the Supervisor panel body**

Create `apps/web/src/components/supervisor/SupervisorThreadPanel.tsx`:

```tsx
'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { SITUATION_LABEL } from '@slave-of-ai/domain'
import { postControl, postJson } from '../../lib/postControl'
import { useShellFacts } from '../../hooks/useShellFacts'
import type { SupervisorThread } from '../../server/supervisorThreads'

/** Exactly what this panel reads off `GET /api/w/:id/supervisor` — the pending proposals, and
 *  nothing else. The full `SupervisorView` carries a report, recent decisions, questions and two
 *  settings; none of them belongs in a conversation, and a narrow local type is what stops one
 *  drifting in.
 *
 *  EXPORTED because `RightPanelHost` does the fetching (scan finding 22) and hands the list down. */
export interface PendingDecision {
  readonly id: string
  readonly situationKind: string
  readonly situation: { readonly summary?: string }
  /** The whole record, for `supervisor-decision-meta`'s `title` (spec erratum E18) — the four
   *  fields `SupervisorPanel.tsx:557` put there before this panel replaced it. Optional because a
   *  row written by an older build carries none. */
  readonly tier?: string
  readonly status?: string
  readonly decidedBy?: string
}

/**
 * The Supervisor, as a conversation (M57 R9).
 *
 * Everything here is UI over data that already exists. The threads are
 * `server/supervisorThreads.ts`'s grouping of the `workspace.goal_set`/`supervisor.*` events this
 * project already has; the decision cards are the SAME `pending` list `SupervisorPanel.tsx` and
 * the Overview's needs-you queue read; Approve and Decline are the same two routes; and the
 * composer is `POST /api/w/:id/goal/request`, which is what `project/SupervisorRequest.tsx` has
 * posted to since M45. No table, no event type, no migration.
 *
 * `+` starts a conversation for TODAY. It writes nothing — there is no row to create — it clears
 * the composer and scrolls to the end of today's thread, which is what "new conversation" means
 * when a conversation is a day.
 */
export function SupervisorThreadPanel({
  workspaceId,
  pending,
}: {
  readonly workspaceId: string
  /** The pending proposals, fetched ONCE by `RightPanelHost` and handed down (scan finding 22):
   *  the dock's badge and this panel's decision cards are the same list, and fetching it twice per
   *  wake-up was two round trips for one fact. */
  readonly pending: readonly PendingDecision[]
}): React.JSX.Element {
  const facts = useShellFacts(workspaceId)
  const [threads, setThreads] = useState<readonly SupervisorThread[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  /** The SUCCESS line `gate-m45` stage 5 waits for after a send (spec erratum E17). */
  const [resultText, setResultText] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(`/api/w/${workspaceId}/supervisor/threads`)
      if (response.ok) setThreads((await response.json()) as readonly SupervisorThread[])
    } catch {
      // Keep what is on screen. A conversation that empties itself because one poll failed is
      // worse than one that is a few seconds behind.
    }
  }, [workspaceId])

  // Two triggers, both existing: the workspace changed, or its stream woke the shell up. No
  // `EventSource` of this panel's own -- `hooks/useShellFacts.ts:18-24` is the rule.
  useEffect((): void => {
    void load()
  }, [load, facts])

  const thread = useMemo(
    () => threads.find((candidate) => candidate.id === selectedId) ?? threads[0] ?? null,
    [threads, selectedId],
  )
  const decisionById = useMemo(() => new Map(pending.map((decision) => [decision.id, decision])), [pending])

  // `postJson`, not `postControl`: the route answers `{ok, version, sha256, goal}` and the VERSION
  // is the thing the success line names -- which is what `gate-m45` stage 5 asserts ("expected it
  // to name goal v3"). `postJson` (`apps/web/src/lib/postControl.ts:84`) exists for exactly this
  // route; its own docstring says it was added so `project/SupervisorRequest.tsx` would not grow a
  // second `fetch` idiom, and this panel is that component's successor.
  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text.length === 0 || busy) return
    setBusy(true)
    setErrorText(null)
    const answerBody = await postJson<{ version: number }>(`/api/w/${workspaceId}/goal/request`, { request: text })
    setBusy(false)
    if (answerBody.ok) {
      setDraft('')
      // The SAME sentence `project/SupervisorRequest.tsx:47` produced, because it is the sentence
      // the gate was written against (spec erratum E17).
      setResultText(`goal v${String(answerBody.data.version)} saved — the next tick re-plans it as a delta`)
      await load()
    } else setErrorText(answerBody.error)
  }

  const answer = async (decisionId: string, verdict: 'approve' | 'reject'): Promise<void> => {
    setBusy(true)
    const result = await postControl(`/api/w/${workspaceId}/supervisor/decisions/${decisionId}/${verdict}`)
    setBusy(false)
    if (result.ok) await load()
    else setErrorText(result.error)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The `≡` / `+` row. `»` is the slot's own, in `RightPanel`'s header bar above this. */}
      <div className="flex flex-none items-center gap-2 border-b border-line px-[16px] py-[8px]">
        <span className="flex-1 truncate text-[12.5px] text-t3">{thread?.title ?? 'No conversation yet'}</span>
        <span className="font-mono text-[11px] font-medium text-t3">{thread?.when ?? ''}</span>
        <button
          type="button"
          data-testid="supervisor-history"
          aria-label="Conversations"
          title="Conversations"
          onClick={() => setHistoryOpen((was) => !was)}
          className="h-[26px] w-[26px] rounded-card border border-line2 bg-card text-[13px] text-t2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          ≡
        </button>
        <button
          type="button"
          data-testid="supervisor-new"
          aria-label="New conversation"
          title="New conversation"
          onClick={() => {
            setSelectedId(threads[0]?.id ?? null)
            setHistoryOpen(false)
            setDraft('')
          }}
          className="h-[26px] w-[26px] rounded-card border border-line2 bg-card text-[15px] text-t2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          +
        </button>
      </div>

      {historyOpen && (
        <div className="flex flex-none flex-col gap-px border-b border-line bg-bg px-3 py-[10px]">
          <div className="px-[6px] pb-[6px] pt-[2px] font-mono text-[10.5px] font-semibold uppercase tracking-[.08em] text-t3">
            Conversations
          </div>
          {threads.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              data-testid="supervisor-thread-row"
              onClick={() => {
                setSelectedId(candidate.id)
                setHistoryOpen(false)
              }}
              className={`flex w-full items-center gap-[10px] rounded-card px-[10px] py-[7px] text-[13px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                candidate.id === thread?.id ? 'bg-sel font-semibold text-t1' : 'text-t2 hover:bg-hover'
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-left">{candidate.title}</span>
              <span className="flex-none font-mono text-[11px] font-medium text-t3">{candidate.when}</span>
            </button>
          ))}
        </div>
      )}

      <div
        data-testid="supervisor-thread"
        data-thread-id={thread?.id ?? ''}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-[16px] text-[13.5px] leading-[1.45]"
      >
        {thread === null && (
          <p data-testid="supervisor-empty" className="text-[13px] text-t2">
            Nothing has been said yet. Tell the Supervisor what you want changed and it will plan
            from there — every message is recorded as an event.
          </p>
        )}
        {thread?.messages.map((message) => {
          const decision = message.decisionId === null ? undefined : decisionById.get(message.decisionId)
          const mine = message.who === 'operator'
          return (
            <div
              key={message.id}
              data-testid="supervisor-message"
              data-who={message.who}
              className={`flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}
            >
              <div
                className={
                  mine
                    ? 'max-w-[86%] rounded-[12px_12px_4px_12px] bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] px-3 py-2 text-t1'
                    : 'max-w-[92%] rounded-[12px_12px_12px_4px] border border-line bg-card px-3 py-2 text-t1'
                }
              >
                <span className="block">{message.text}</span>
                {decision !== undefined && (
                  <div
                    data-testid="supervisor-decision-card"
                    data-decision-id={decision.id}
                    // Spec §3 says the CARD carries both; the draft put this one on the inner `<p>`
                    // (scan finding 29).
                    data-situation-kind={decision.situationKind}
                    className="mt-[10px] rounded-panel border border-[color-mix(in_oklab,var(--s-waiting)_45%,var(--line))] bg-card p-3"
                  >
                    <span className="inline-flex rounded-chip bg-[color-mix(in_oklab,var(--s-waiting)_14%,transparent)] px-[7px] py-[2px] font-mono text-[10.5px] font-medium text-s-waiting">
                      DECISION
                    </span>
                    {/* `supervisor-proposal-kind`, carried over from the panel this task deletes
                      * (spec erratum E18): `gate-m44:930` reads this chip's TEXT and its `title`
                      * and compares them with the timeline's copy of the same proposal. Same
                      * semantics as `SupervisorPanel.tsx:253` — the domain's label, the raw member
                      * in `title`, and the member itself as the runtime fallback for a kind this
                      * bundle has no label for. */}
                    <span
                      data-testid="supervisor-proposal-kind"
                      title={decision.situationKind}
                      className="ml-2 font-mono text-[10.5px] text-t3"
                    >
                      {SITUATION_LABEL[decision.situationKind as keyof typeof SITUATION_LABEL] ?? decision.situationKind}
                    </span>
                    {/* `supervisor-decision-meta`, also carried over (`SupervisorPanel.tsx:557`):
                      * the projected sentence, with the WHOLE record one hover away. `gate-m44:921`
                      * waits on this element, unscoped. */}
                    <span
                      data-testid="supervisor-decision-meta"
                      title={`${decision.situationKind} · ${decision.tier ?? '—'} · ${decision.status ?? 'pending'} · ${decision.decidedBy ?? '—'}`}
                      className="mt-[4px] block text-[10.5px] text-t3"
                    >
                      {SITUATION_LABEL[decision.situationKind as keyof typeof SITUATION_LABEL] ?? decision.situationKind} · waiting for you
                    </span>
                    <p className="mt-[6px] font-medium text-t1">
                      {decision.situation.summary ?? 'The Supervisor has proposed something.'}
                    </p>
                    <div className="mt-[10px] flex gap-[6px]">
                      <button
                        type="button"
                        data-testid="supervisor-decision-approve"
                        disabled={busy}
                        onClick={() => void answer(decision.id, 'approve')}
                        className="rounded-card border-0 bg-accent px-3 py-[6px] text-[12.5px] font-semibold text-accent-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        data-testid="supervisor-decision-decline"
                        disabled={busy}
                        onClick={() => void answer(decision.id, 'reject')}
                        className="rounded-card border border-line2 bg-transparent px-3 py-[6px] text-[12.5px] font-medium text-t1 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        Decline
                      </button>
                    </div>
                  </div>
                )}
                {message.refs.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-[5px]">
                    {message.refs.map((ref) => (
                      <span key={ref} className="rounded-chip border border-line2 px-[7px] py-[2px] font-mono text-[11px] font-medium text-t2">
                        {ref}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <span className="font-mono text-[11px] text-t3">{new Date(message.at).toLocaleTimeString()}</span>
            </div>
          )
        })}
      </div>

      {/* `supervisor-composer` is on the WRAPPER and the two control testids are on the controls,
        * from the moment this file is written (spec erratum E17). An earlier draft put
        * `supervisor-composer` on the `<textarea>` and had Task 6 rename it; a testid that moves
        * mid-milestone is a testid two tasks disagree about. */}
      <div data-testid="supervisor-composer" className="flex flex-none flex-col gap-2 border-t border-line px-[14px] pb-[14px] pt-3">
        {/* TWO lines, not one with two moods. `gate-m45` stage 5 clicks Send *until*
          * `supervisor-request-result` is visible and then asserts its text names `v3` — so that
          * testid has to be the SUCCESS line. The refusal is its own element beside it. */}
        {resultText !== null && (
          <span data-testid="supervisor-request-result" className="text-[12.5px] text-t2">
            {resultText}
          </span>
        )}
        {errorText !== null && (
          <span role="alert" data-testid="supervisor-request-error" className="text-[12.5px] text-s-blocked">
            {errorText}
          </span>
        )}
        <div className="flex items-end gap-2 rounded-[11px] border border-line2 bg-card py-2 pl-3 pr-2">
          <textarea
            data-testid="supervisor-request-input"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter newlines (README "Supervisor panel" → Composer).
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            placeholder="Ask, instruct, or steer… (Enter to send)"
            aria-label="Message the Supervisor"
            className="min-h-[40px] flex-1 resize-none border-0 bg-transparent py-[2px] text-[13.5px] leading-[1.45] text-t1 outline-none"
          />
          <button
            type="button"
            data-testid="supervisor-request-send"
            disabled={busy || draft.trim().length === 0}
            onClick={() => void send()}
            className="rounded-card border-0 bg-accent px-3 py-[7px] text-[12.5px] font-semibold text-accent-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Send
          </button>
        </div>
        <div className="flex justify-between text-[11.5px] text-t3">
          <span>Every message is recorded as an event.</span>
          <span>
            Scope: <b className="font-medium text-t2">{facts?.workspace.name ?? 'this project'}</b>
          </span>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 13: Run it and watch it pass**

```bash
npx vitest run apps/web/test/supervisor-thread-panel.test.tsx
```

Expected: PASS, 6 tests.

- [ ] **Step 14: Mount the host, and give the shell its third column**

In `apps/web/src/app/layout.tsx`, the third column now depends on the ROUTE, which is a client fact.
`AppShell` is a server component and must stay one, so the decision is made by a tiny client
wrapper. Create `apps/web/src/components/shell/RightColumn.tsx`:

```tsx
'use client'

import { usePathname } from 'next/navigation'
import { workspaceIdOf } from '../../lib/routes'
import { useRightPanel } from './RightPanelProvider'
import type { RightWidth } from './AppShell'

/** How wide the third column is right now — read by the shell through a render prop rather than
 *  by `AppShell` itself, which is a server component and has no pathname. */
export function useRightWidth(): RightWidth {
  const pathname = usePathname()
  const { collapsed } = useRightPanel()
  if (workspaceIdOf(pathname) === null) return 'none'
  return collapsed ? 'dock' : 'panel'
}
```

…and make the shell's own wrapper a client component that reads it. Replace the `<AppShell …>`
element in the root layout with a `<ShellFrame …>` and create
`apps/web/src/components/shell/ShellFrame.tsx`:

```tsx
'use client'

import type React from 'react'
import type { SidebarProject } from '../../server/sidebar'
import { AppShell } from './AppShell'
import { Header } from './Header'
import { RightPanelHost } from './RightPanelHost'
import { useRightWidth } from './RightColumn'

/** The one client component that knows both what route this is and whether the panel is
 *  collapsed — the two facts the grid's third track is sized from.
 *
 *  `sidebar` is passed in as a NODE rather than imported, so the root layout's SERVER read of the
 *  tree still reaches it; `projects` is passed as DATA as well, because `Header` needs the same
 *  list to name the project in the breadcrumb on the three routes that publish no `ShellFacts`
 *  (spec erratum E12) and this component is the only thing between the layout and it. */
export function ShellFrame({
  sidebar,
  projects,
  children,
}: {
  readonly sidebar: React.ReactNode
  readonly projects: readonly SidebarProject[]
  readonly children: React.ReactNode
}): React.JSX.Element {
  const rightWidth = useRightWidth()
  return (
    <AppShell sidebar={sidebar} header={<Header projects={projects} />} right={<RightPanelHost />} rightWidth={rightWidth}>
      {children}
    </AppShell>
  )
}
```

The root layout's body becomes:

```tsx
      <body className="min-h-screen">
        <ThemeProvider>
          <RightPanelProvider>
            <HeaderActionProvider>
              <ShellFrame sidebar={<SidebarTree initial={projects} />} projects={projects}>
                {children}
              </ShellFrame>
            </HeaderActionProvider>
          </RightPanelProvider>
        </ThemeProvider>
      </body>
```

…with `ShellFrame` imported in place of `AppShell`, `Header` and `RightPanelHost` (those three are
now `ShellFrame`'s own imports). `SidebarTree` and `buildSidebarTree` stay in the layout.

- [ ] **Step 15: Move the two big panels into the slot — ONE className each**

In `apps/web/src/components/SlavePanel.tsx`, line 288, replace the `className` string on the outer
`<aside>` (leave the `aria-label` and the comment above it alone, and add one sentence to that
comment):

```tsx
      // M57 R8: it renders inside the shell's 372px slot now, which owns the width, the surface
      // and the position -- so this element is a plain column that fills its parent. Not one line
      // below this header moved, and the slide-in stays: this panel is mounted fresh per slave, so
      // the animation still replays on every open and switch by construction.
      className="flex h-full w-full flex-col gap-4 overflow-y-auto p-4 motion-safe:animate-[panel-in_160ms_ease-out]"
```

In `apps/web/src/components/TaskDetailPanel.tsx`, line 263, the same — **and it keeps
`shadow-resting` as well** (scan finding 43), because its own comment says
`tasks-components.test.tsx` asserts on `container.querySelector('aside')` and both classes are part
of what that file reads:

```tsx
      className="flex h-full w-full flex-col gap-4 overflow-y-auto p-4 shadow-resting motion-safe:animate-[panel-in_160ms_ease-out]"
```

**Nothing else in either file changes, and the element stays an `<aside>`.** Both keep every testid,
every control POST, every `DetailsGroup`, and their `onClose` props.

- [ ] **Step 16: Mirror the two selections into the provider (erratum E4/E5)**

In `apps/web/src/components/OverviewClient.tsx`, keep the `useSelectedId('slave')` call and the
`selectedSlave` lookup exactly as they are. **Delete** the `{selectedSlave !== null && (<SlavePanel …/>)}`
block at the end of the returned fragment and add, beside the other effects:

```tsx
  // M57 R8 / plan errata E4-E5: `?slave=` is still the source of truth and still what a refresh
  // restores -- this only MIRRORS it into the shell's right panel, which is where the panel is
  // drawn now. The clearer handed to `open` is the same one the panel's own close used, so the
  // slot's `»`, the slot's `✕` and the panel's own control all clear the URL together.
  //
  // THE DEPENDENCY LIST IS `selectedSlave?.id` AND NOTHING ELSE (scan finding 21). `liveEvents` and
  // `view` change identity on every SSE frame, and an effect that re-`open()`s several times a
  // second is an effect that fights the person who just collapsed the panel. What the panel reads
  // out of those two is read at OPEN time and refreshed by its own props on the next genuine open;
  // the fourth argument to `open` is the content KEY, which is what lets the provider tell a
  // re-assertion of the same slave from a new one.
  //
  // AND IT HANDLES THE CLEAR. `?slave=` can go away by navigation rather than by the close button
  // — a link, a Back — and an effect that only ever opens would leave the provider holding a stale
  // `slave` mode over a page that has no selection.
  const { open: openPanel, close: closePanel, mode: panelMode } = useRightPanel()
  useEffect((): void => {
    if (selectedSlave === null) {
      if (panelMode === 'slave') closePanel()
      return
    }
    openPanel(
      'slave',
      <SlavePanel
        // Keyed on the slave id so switching `?slave=` unmounts the old instance instead of
        // reusing it with new props: a control POST still in flight for the slave just switched
        // away from must not paint its late error onto the next slave's panel (M45 fix round 2).
        key={selectedSlave.id}
        slave={selectedSlave}
        liveEvents={liveEvents[selectedSlave.id] ?? []}
        workspaceId={workspaceId}
        haltedReason={view.workspace.haltedReason}
        onClose={() => {
          selectSlave(null)
          closePanel()
        }}
      />,
      () => selectSlave(null),
      selectedSlave.id,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately keyed on the SELECTION
    // and not on the snapshot: see the note above. `panelMode` is read, not depended on, for the
    // same reason (it changes when this effect's own `close()` lands).
  }, [selectedSlave?.id])
```

…with `import { useRightPanel } from './shell/RightPanelProvider'` added. Do the same in
`apps/web/src/components/TasksClient.tsx` for `selectedTask` / `'task'` / `TaskDetailPanel`, with
its own props (`task`, `workspaceId`, `workspaceGoalVersion`, `onClose`), the same
`[selectedTask?.id]` dependency list, the same `if (selectedTask === null) { if (panelMode === 'task') closePanel(); return }`
guard, and `selectedTask.id` as the content key.

- [ ] **Step 16b: Wrap the two test files in `RightPanelProvider`**

`useRightPanel` throws outside its provider — deliberately, because a silently inert panel would
hide a wiring bug — and Step 16 has just made `OverviewClient` and `TasksClient` call it. Two large
test files render those two bare (scan finding 5): `apps/web/test/overview-components.test.tsx`
(`describe('OverviewClient')`, around `:825`, `:834`, `:847`) and
`apps/web/test/tasks-components.test.tsx` (`describe('TasksClient')`, around `:803`). **The hook
keeps throwing**; the tests gain the provider, because a test that renders a page without the
shell's providers is a test rendering a tree that does not exist.

In each file, add the import and one helper, and route every `render(<OverviewClient …/>)` /
`render(<TasksClient …/>)` through it:

```tsx
import { RightPanelProvider } from '../src/components/shell/RightPanelProvider.js'

/** Every page client in the shell runs inside the root layout's providers. A test that renders one
 *  bare is rendering a tree that does not exist -- and `useRightPanel` says so by throwing. */
function renderInShell(ui: React.ReactElement): ReturnType<typeof render> {
  return render(<RightPanelProvider>{ui}</RightPanelProvider>)
}
```

Then `grep -n "render(<OverviewClient\|render(<TasksClient\|rerender(<OverviewClient\|rerender(<TasksClient" apps/web/test/overview-components.test.tsx apps/web/test/tasks-components.test.tsx`
and convert each hit. A `rerender` returned by `renderInShell` must be given the same wrapper, so
write those as `rerender(<RightPanelProvider><OverviewClient …/></RightPanelProvider>)`.

**`apps/web/src/components/workforce/WorkforceClient.tsx` is NOT changed** (erratum E4):
`/workforce` is a global route with no third column, and its `SlavePanel` stays in the page frame,
where it already is. Its `fixed`-position className went away in Step 15, though, so give that one
call site a wrapper that restores the old geometry — replace the `<SlavePanel …/>` element with:

```tsx
        <div className="fixed inset-y-0 right-0 z-10 w-96 border-l border-line bg-panel shadow-resting motion-safe:animate-[panel-in_160ms_ease-out]">
          <SlavePanel
            key={panel.slave.id}
            slave={panel.slave}
            liveEvents={[]}
            workspaceId={selected.workspaceId}
            haltedReason={null}
            onClose={() => setSelected(null)}
          />
        </div>
```

- [ ] **Step 16c: Extract `ProposalRow`, then delete `SupervisorPanel` (spec erratum E18)**

`SupervisorPanel.tsx` is mounted only by `OverviewAdvanced`, which Task 4 deleted — so from the end
of Task 4 it renders nowhere, and this task is where it goes. **It cannot simply be deleted**:
`project/SupervisorTimeline.tsx:11` imports `ProposalRow` from it, that timeline is Task 6's Recent
changes, and four gates read testids only `ProposalRow` emits.

**(a) Move `ProposalRow` and everything it needs.** Create
`apps/web/src/components/supervisor/ProposalRow.tsx` and move into it, VERBATIM: `ProposalRow`
itself, `DraftEditor`, `actionText`, and the types and imports those three need (`Decision`,
`Question`, `SITUATION_LABEL`, `Button`, `Chip`, and whatever else `tsc` names). Change not one
character of their bodies and not one testid. Then in `SupervisorTimeline.tsx`, change line 11 to
`import { ProposalRow } from '../supervisor/ProposalRow'`.

**(b) Census every testid `SupervisorPanel` emits, before deleting it.** Run this and paste the
output into the task report:

```bash
grep -o 'data-testid="[a-z0-9-]*"' apps/web/src/components/SupervisorPanel.tsx |
  sed 's/.*data-testid="//;s/"//' | sort -u > "$SCRATCHPAD/sp-testids.txt"
while read -r t; do
  printf '%-32s gates=[%s] tests=[%s]\n' "$t" \
    "$(grep -rln -- "$t" scripts/gate-*.mjs 2>/dev/null | xargs -r -n1 basename | tr '\n' ' ')" \
    "$(grep -rln -- "$t" apps/web/test/ 2>/dev/null | xargs -r -n1 basename | tr '\n' ' ')"
done < "$SCRATCHPAD/sp-testids.txt"
```

Against `c828f8c8` it reports **thirty-one** testids, and exactly four of them are read by a gate:

| testid | read by | after this task |
|---|---|---|
| `supervisor-approve` | `gate-m45`, `gate-m47` | **survives** — emitted by `ProposalRow`, which (a) moved |
| `supervisor-proposal` | `gate-m44`, `gate-m45`, `gate-m47`, `gate-m50` | **survives** — same |
| `supervisor-proposal-kind` | `gate-m44` (twice: once scoped to the panel, once to `timeline-decisions`) | **both survive** — the timeline's through `ProposalRow`, the panel-scoped one re-emitted by `SupervisorThreadPanel`'s decision card (Step 12) with the panel-scope re-pointed to `right-panel` in Task 4's Edit 4 |
| `supervisor-decision-meta` | `gate-m44` (unscoped `waitVisible`) | **survives** — re-emitted by `SupervisorThreadPanel`'s decision card (Step 12), same semantics |

The other twenty-seven — `supervisor-panel`, `supervisor-enabled`, `supervisor-profile-input/-save`,
`supervisor-draft*` (eight), `supervisor-decision-row/-rationale`, `supervisor-next`,
`supervisor-done`, `supervisor-stuck-row/-empty`, `supervisor-question-row/-questions-empty`,
`supervisor-pending-empty`, `supervisor-error`, `supervisor-reject/-reject-reason`,
`supervisor-proposal-action/-rationale/-summary` — are read **only** by
`apps/web/test/supervisor-panel.test.tsx` (and, for the six that `ProposalRow` emits, by
`supervisor-timeline.test.tsx`, which keeps working because `ProposalRow` does).

**If your census disagrees with that table, the table is what is stale — trust the census, and say
so in the task report.**

**(c) Delete the panel and its test.**

```bash
git rm apps/web/src/components/SupervisorPanel.tsx apps/web/test/supervisor-panel.test.tsx
grep -rn "SupervisorPanel" apps/web/src apps/web/test scripts
```

The grep must come back empty except for comment-only prose (which Task 4's Files block already
covers) — in particular, `SupervisorTimeline.tsx` must now import from
`../supervisor/ProposalRow` and nothing may still import from `../SupervisorPanel`.

`supervisor-panel.test.tsx` dies with the component it tests: every case in it renders
`SupervisorPanel`, and the six that exercise `ProposalRow` are duplicated by
`supervisor-timeline.test.tsx`'s own approve/reject cases, which render the same row through the
timeline and survive untouched. Nothing is lost that another test does not already say.

- [ ] **Step 17: Run everything this task touched, then the suite**

```bash
npx vitest run apps/web/test/right-panel.test.tsx apps/web/test/supervisor-thread-panel.test.tsx \
  apps/web/test/integration/supervisor-threads.test.ts apps/web/test/slave-panel.test.tsx \
  apps/web/test/task-detail-panel.test.tsx apps/web/test/overview-components.test.tsx \
  apps/web/test/tasks-components.test.tsx apps/web/test/workforce-page.test.tsx \
  apps/web/test/supervisor-timeline.test.tsx
npx vitest run 2>&1 | tail -20
```

*(`supervisor-timeline.test.tsx` is in that list because Step 16c moved the component it renders
half of. It must pass with NO edit — that is the whole point of extracting `ProposalRow` instead of
deleting it. If it fails, the extraction dropped something.)*

*(The panel tests render `SlavePanel`/`TaskDetailPanel` directly, so the className change is the
only thing that can move them — and only if one of them asserts the class string. Read the failure
before changing a test: a test that pinned `fixed inset-y-0` was pinning the OLD placement and its
assertion moves to `right-panel.test.tsx`'s width case; anything else failing is a real break.)*

- [ ] **Step 18: Gates, build, ladder and commit**

```bash
pgrep -af vitest || echo "no vitest running"
for g in m44-ux-foundation m45-project-experience; do
  echo "=== $g ==="; npm run "gate:$g" 2>&1 | tail -12; echo "exit=${PIPESTATUS[0]}"
done
pgrep -af "next dev" || echo "no dev server"
npm run web:build 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"
npm run gate:m26-vocabulary && npx tsc --build && npm run --silent typecheck
git add -A
git commit -m "$(cat <<'MSG'
feat(m57): t5 — the Supervisor gets a memory, and two panels slide into the slot

A thread is a day. That is the only grouping the data can support without a table, and
this milestone refuses to add one: the conversation is the `workspace.goal_set` and
`supervisor.*` rows the project already has, the decision cards are the pending list the
Overview already reads, and the composer is the `goal/request` route the request box has
posted to since M45. `SlavePanel` and `TaskDetailPanel` move into the 372px slot for the
price of one className each -- 1400 lines of content, thirty testids, untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tb1HCWnBqh63E9diBxdxR6
MSG
)"
```

---

### Task 6: The two pages a person opens first — Projects, and a project (README "Projects" and "Overview")

**Files:**
- Create: `apps/web/src/components/project/NeedsYouCard.tsx`
- Create: `apps/web/test/needs-you-card.test.tsx`
- Modify: `apps/web/src/components/ProjectsClient.tsx`
- Modify: `apps/web/src/components/OverviewClient.tsx`
- Modify: `apps/web/src/components/project/ProjectBrief.tsx` (**eight tiles → four**, R17)
- Modify: `apps/web/src/components/SlaveCard.tsx` (**card → row**, R18)
- Modify: `apps/web/src/components/project/SupervisorTimeline.tsx` (the Recent-changes row look; and it keeps its own `SupervisorRequest` cases' component until Step 7g deletes it)
- Modify: `apps/web/src/components/ui/AvatarTile.tsx` (+ `apps/web/test/avatar-tile.test.tsx` if one exists — `ls apps/web/test | grep -i avatar`): a `size` prop, spec erratum in Step 5c
- Modify: `scripts/gate-m45-project-experience.mjs` — `EXPECTED_BRIEF_FACTS` at `:95-104`, the `wants` table at `:761-780`, the `changes` block at `:795-808` (Step 8; the draft called it Step 9 and drifted two of the three ranges)
- Modify: `apps/web/test/projects-page.test.tsx`, `apps/web/test/overview-components.test.tsx`, **`apps/web/test/project-brief.test.tsx`** (28 cases pinning the eight-tile brief — Step 8b has the per-case list), **`apps/web/test/supervisor-timeline.test.tsx`** (its `describe('SupervisorRequest')` block, five cases, dies with the component in Step 7g)
- Delete: `apps/web/src/components/TopStrip.tsx`, `apps/web/src/components/project/SupervisorRequest.tsx`

*(There is no `apps/web/test/slave-card.test.tsx` and no `apps/web/test/brief.test.tsx` — the draft
of this plan named both. Every `card-*` case lives in `overview-components.test.tsx`; the brief's
cases are in `project-brief.test.tsx`.)*

**Interfaces:**
- Consumes from Task 3: `useHeaderAction`. From Task 2: nothing new. From earlier milestones, unchanged: `ProjectRow` (`server/org.ts:94`), `OverviewSnapshot` (`server/overview.ts:230-377`), `NeedsYouItem` (`server/needsYou.ts:26`), `ProjectBrief` the DTO (`server/brief.ts`), `SupervisorTimeline`, `RunbookPanel`, `LiveEventsPanel`, `MergeQueuePanel`, `KpiStrip`, `AvatarTile`, `StatusPill`, `ProgressBar`.
- Produces, for Tasks 7–9: `ProjectBrief({ workspaceId, brief, runbookLine })` rendering FOUR `brief-tile`s (`data-brief` = `work` | `cost` | `supervisor` | `latest-verified`) inside a container carrying BOTH `data-testid="brief"` and `data-testid="strip"`; `SlaveCard` as a row; testids `needs-you-card`, `needs-you-row`, `needs-you-empty`, `card-unblock`, `card-more`, `recent-changes`; the header-action idiom every later page copies.

**The controller ruling this task implements (spec R17/R18, §6).** The first draft of this plan kept
`ProjectBrief`'s eight tiles and `SlaveCard`'s card grid, and added a second four-tile set beside
them, because both carry computed-style assertions in `gate:m14-fidelity` and
`gate:m45-project-experience`. That was withdrawn: **a gate pins a number so it cannot drift by
accident, not against a deliberate, specified, reviewed change** — and Task 9 rewrites m14's whole
`NUMBERS` table and regenerates all thirteen screenshots anyway. The Overview follows the README's
five bands exactly, and the gates that measured the old layout are edited here, by name, with every
assertion either carried over onto the new selector or re-pointed at the surface the fact moved to.

- [ ] **Step 1: Write the failing test for the Needs-you card**

Create `apps/web/test/needs-you-card.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NeedsYouCard } from '../src/components/project/NeedsYouCard.js'
import type { NeedsYouItem } from '../src/server/needsYou.js'

vi.mock('next/navigation', () => ({
  usePathname: () => '/w/w1',
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const ITEMS: readonly NeedsYouItem[] = [
  { kind: 'decision', id: 'd-1', title: 'Staffing: nobody can review', href: '/w/w1#decision-d-1', since: '2026-09-14T09:00:00.000Z', taskId: null, decisionId: 'd-1', messageId: null },
  { kind: 'blocked_task', id: 't-1', title: 'Wire the webhook — no credentials', href: '/w/w1/tasks?task=t-1', since: '2026-09-14T08:00:00.000Z', taskId: 't-1', decisionId: null, messageId: null },
]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach((): void => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach((): void => { vi.unstubAllGlobals() })

describe('the Needs you card', () => {
  it('lists one row per item, with the kind on the node and the chip in words', () => {
    render(<NeedsYouCard workspaceId="w1" items={ITEMS} />)
    const rows = screen.getAllByTestId('needs-you-row')
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['decision', 'blocked_task'])
    expect(rows[0]?.textContent).toContain('DECISION')
    expect(rows[1]?.textContent).toContain('BLOCKED')
    expect(screen.getByTestId('needs-you-card').textContent).toContain('2')
  })

  it('answers a decision in place, through the EXISTING approve route', async (): Promise<void> => {
    render(<NeedsYouCard workspaceId="w1" items={ITEMS} />)
    act((): void => { screen.getByTestId('needs-you-approve').click() })
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/supervisor/decisions/d-1/approve', expect.objectContaining({ method: 'POST' })),
    )
  })

  it('offers a blocked task a link to itself, never an Approve it cannot answer', () => {
    render(<NeedsYouCard workspaceId="w1" items={ITEMS} />)
    const rows = screen.getAllByTestId('needs-you-row')
    expect(rows[1]?.querySelector('[data-testid="needs-you-approve"]')).toBeNull()
    expect(rows[1]?.querySelector('a')?.getAttribute('href')).toBe('/w/w1/tasks?task=t-1')
  })

  it('gives EVERY row a chip with the raw kind in title and a working link (gate-m45 stage 3)', () => {
    render(<NeedsYouCard workspaceId="w1" items={ITEMS} />)
    for (const row of screen.getAllByTestId('needs-you-row')) {
      expect(row.querySelector('[data-testid="chip"]')?.getAttribute('title')).toBe(row.getAttribute('data-kind'))
      expect(row.querySelector('a')?.getAttribute('href')).toBeTruthy()
    }
  })

  it('says nothing needs you, rather than drawing an empty card', () => {
    render(<NeedsYouCard workspaceId="w1" items={[]} />)
    expect(screen.queryByTestId('needs-you-row')).toBeNull()
    expect(screen.getByTestId('needs-you-empty').textContent).toContain('Nothing needs you right now')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/web/test/needs-you-card.test.tsx
```

Expected: FAIL — `Failed to resolve import "../src/components/project/NeedsYouCard.js"`.

- [ ] **Step 3: Write `NeedsYouCard`**

Create `apps/web/src/components/project/NeedsYouCard.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { useState } from 'react'
import { postControl } from '../../lib/postControl'
import type { NeedsYouItem } from '../../server/needsYou'

/** The chip at the left of each row. A WORD, in the tone of the thing it names — the raw `kind`
 *  stays on the row's `data-kind` (`docs/ia.md` rule 3). `integrate` is amber rather than green:
 *  finished work that nobody will merge is waiting, not done. */
const KIND: Record<NeedsYouItem['kind'], { readonly label: string; readonly tone: string }> = {
  decision: { label: 'DECISION', tone: 's-waiting' },
  blocked_task: { label: 'BLOCKED', tone: 's-blocked' },
  question: { label: 'QUESTION', tone: 's-planning' },
  integrate: { label: 'READY', tone: 's-waiting' },
}

/**
 * What is waiting on a person, first on the page (M57, README "Overview" → Needs you).
 *
 * It is `server/needsYou.ts`'s existing queue, drawn as the README's card: a header with the count,
 * one row per item, and an answer in place for the one kind that HAS an answer in place. It
 * replaces `BlockedPanel`, which showed one of the four kinds and lived behind a disclosure.
 *
 * Only a DECISION gets buttons. A blocked task needs a person to look at it, a question needs an
 * answer typed somewhere, and finished work needs `confirmIntegration` — which has no web route
 * and inventing one is not this milestone's decision to make (`server/needsYou.ts:21-24` records
 * that, and it is still true). EVERY row gets a link to the surface that can resolve it, the two
 * buttons included.
 *
 * IT TAKES NO `onRefresh` (scan finding 25). `useOverview` returns
 * `{snapshot, actionLines, liveEvents, connection, error, latencyMs}` and exposes no refetch, and
 * `router.refresh()` is a full server re-render rather than the snapshot refetch this would want.
 * It does not need one: approving or rejecting a decision APPENDS AN EVENT, the page's own
 * `EventSource` wakes on it, and `useOverview` refetches the snapshot 250 ms later — which is the
 * same path every other control on this page relies on, and the one `postControl`'s own docstring
 * calls "the event-driven refetch loop owning truth". The gate polls for the row to disappear
 * rather than asserting it immediately.
 */
export function NeedsYouCard({
  workspaceId,
  items,
}: {
  readonly workspaceId: string
  readonly items: readonly NeedsYouItem[]
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  const answer = async (decisionId: string, verdict: 'approve' | 'reject'): Promise<void> => {
    setBusy(decisionId)
    const result = await postControl(`/api/w/${workspaceId}/supervisor/decisions/${decisionId}/${verdict}`)
    setBusy(null)
    // No local refetch and no optimistic removal: the POST appended an event, the page's stream
    // wakes on it, and the snapshot this component's `items` come from is refetched 250 ms later.
    if (!result.ok) setErrorText(result.error)
  }

  if (items.length === 0) {
    return (
      <section className="px-[24px] pt-[18px]">
        <p data-testid="needs-you-empty" className="rounded-panel-card border border-dashed border-line2 px-4 py-3 text-[13.5px] text-t2">
          Nothing needs you right now. The team is working; you will see it here first when
          something does.
        </p>
      </section>
    )
  }

  return (
    <section className="px-[24px] pt-[18px]">
      <div
        data-testid="needs-you-card"
        className="overflow-hidden rounded-panel-card border border-[color-mix(in_oklab,var(--s-waiting)_40%,var(--line))] bg-card"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <span className="flex items-center gap-[10px] font-semibold text-t1">
            <span aria-hidden className="h-2 w-2 rounded-full bg-s-waiting" />
            Needs you <span className="font-mono text-[12px] font-medium text-t3">{items.length}</span>
          </span>
          <span className="text-[13px] text-t3">Answer here, or open the item</span>
        </div>
        {errorText !== null && (
          <p role="alert" className="border-b border-line px-4 py-2 text-[12.5px] text-s-blocked">
            {errorText}
          </p>
        )}
        {items.map((item) => {
          const kind = KIND[item.kind]
          return (
            <div
              key={item.id}
              data-testid="needs-you-row"
              data-kind={item.kind}
              className="flex items-center gap-[14px] border-b border-line px-4 py-3 last:border-b-0"
            >
              {/* `ui/Chip` with `title={item.kind}`, NOT a bare span (scan finding 61).
                * `gate-m45` stage 3 reads every needs-you row as
                * `{kind: row.querySelector('[data-testid="chip"]')?.getAttribute('title'), href: row.querySelector('a')?.getAttribute('href')}`
                * and asserts the four kinds sort to `['blocked_task','decision','integrate','question']`
                * with a working link on each. `ProjectBrief`'s old rows were `<Chip tone title>` +
                * `<Link>`, which is where that shape came from -- so the card inherits it rather
                * than inventing one, and that stage needs no edit. */}
              <Chip tone={kind.tone} title={item.kind}>
                {kind.label}
              </Chip>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-t1">{item.title}</span>
                <span className="block text-[12.5px] text-t3">
                  waiting since {new Date(item.since).toLocaleString()}
                </span>
              </span>
              {/* EVERY row carries a link, decision rows included (scan finding 61): `gate-m45`
                * stage 3 asserts `row.querySelector('a')` resolves on all four kinds and then
                * NAVIGATES to each href. A decision row gets its two buttons AND an `Open →`
                * beside them -- which is also what the README draws ("Answer here, or open the
                * item"). */}
              <Link
                data-testid="needs-you-open"
                href={item.href}
                className="flex-none rounded-card border border-line2 px-3 py-[6px] text-[13px] text-t1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Open →
              </Link>
              {item.decisionId !== null && (
                <span className="flex flex-none gap-[6px]">
                  <button
                    type="button"
                    data-testid="needs-you-approve"
                    disabled={busy === item.decisionId}
                    onClick={() => void answer(item.decisionId ?? '', 'approve')}
                    className="rounded-card border-0 bg-accent px-3 py-[6px] text-[13px] font-semibold text-accent-ink disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    data-testid="needs-you-decline"
                    disabled={busy === item.decisionId}
                    onClick={() => void answer(item.decisionId ?? '', 'reject')}
                    className="rounded-card border border-line2 bg-transparent px-3 py-[6px] text-[13px] text-t1 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    Decline
                  </button>
                </span>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
```

**The one class-string trap in this file:** `text-${kind.tone}` and the `color-mix` interpolation
are dynamic, and **Tailwind's static scan cannot see them**. Replace the `KIND` table's `tone`
field with two complete literal class strings, exactly the way `ui/StatusPill.tsx`'s `TONE_*` maps
already do for the same reason:

```tsx
/** The word and the TONE for each kind. `ui/Chip` owns the fill and the border (it takes a
 *  `StatusTone` and paints it with the same `1a`/`3d` alphas `StatusPill` uses), so there is no
 *  class string here at all — which is also why Tailwind's static-scan problem does not arise. */
const KIND: Record<NeedsYouItem['kind'], { readonly label: string; readonly tone: StatusTone }> = {
  decision: { label: 'DECISION', tone: 'waiting' },
  blocked_task: { label: 'BLOCKED', tone: 'blocked' },
  question: { label: 'QUESTION', tone: 'planning' },
  integrate: { label: 'READY', tone: 'waiting' },
}
```

…imported as `import { Chip } from '../ui/Chip'` and `import type { StatusTone } from '../ui/StatusPill'`.

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run apps/web/test/needs-you-card.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Turn `ProjectBrief`'s eight tiles into the README's four (R17)**

Rewrite `apps/web/src/components/project/ProjectBrief.tsx`. The `Tile` helper, the imports, the
`WORK_WORDS`/`VERIFIED_WORD`/`toneForCardLabel`/`clock` helpers and the `ProjectBriefFacts` type all
stay; four tiles go, four are restyled, and the container gains one attribute.

**(a) The container** carries BOTH testids. `brief` is what `gate:m45` waits on; `strip` is what
`gate-m14-fidelity` (773, 1132), `gate-m44-ux-foundation` (769) and `gate-m49-memory` (1529) wait on
as the Overview's structural marker, and it is free the moment `TopStrip` goes. A DOM node may carry
one `data-testid`, so the outer element takes `strip` and an inner wrapper takes `brief` — the gates
that ask for `brief` want the tile grid, and the gates that ask for `strip` want "the Overview has
rendered", which both answer.

```tsx
    <section data-testid="strip" className="px-[24px] pt-[18px]">
      <div
        data-testid="brief"
        className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4"
      >
        …the four tiles…
      </div>
    </section>
```

**(b) `Tile`** takes the README's card recipe instead of `Panel`'s:

```tsx
function Tile({
  fact,
  caption,
  children,
}: {
  readonly fact: string
  readonly caption: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid="brief-tile"
      data-brief={fact}
      className="flex min-w-0 flex-col rounded-panel-card border border-line bg-card px-4 py-[14px] shadow-card"
    >
      {/* README "Overview": caption 12px `--t3`, then the fact. Not `SectionLabel` — that is a
        * 9px mono uppercase rail label, and these are sentence-case captions. */}
      <div className="mb-[6px] text-[12px] text-t3">{caption}</div>
      {children}
    </div>
  )
}
```

**(c) The four tiles, in the README's order.** `work` first, because the Work bar is the fact the
README leads with.

```tsx
      <Tile fact="work" caption={`Work · ${String(workTotal)} tasks`}>
        {/* README: an 8px segmented bar, 2px gaps, one segment per word, in the word's own tone.
          * Every class here is a LITERAL (`WORK_WORDS` carries it) because Tailwind's static scan
          * cannot see an interpolated tone — the rule `ui/StatusPill.tsx`'s TONE_* maps document. */}
        <div className="flex h-2 gap-[2px] overflow-hidden rounded-hair">
          {WORK_WORDS.map(({ key, fill }) => (
            <span
              key={key}
              className={`block h-full ${fill}`}
              style={{ width: `${String(workTotal === 0 ? 0 : (work[key] / workTotal) * 100)}%` }}
            />
          ))}
        </div>
        <div className="mt-[10px] flex flex-wrap gap-x-[10px] gap-y-1 text-[12.5px] text-t2">
          {WORK_WORDS.map(({ key, word }) => (
            // A zero is DIMMED, never hidden: a person asking "is anything being reviewed" needs to
            // read the 0. The testid and the word are unchanged from the eight-tile brief, so
            // `gate:m45`'s `['work','WORKING']` and `['work','IN REVIEW']` pairs still match.
            <span key={key} data-testid={`brief-work-${key}`} className={work[key] === 0 ? 'text-t3' : 'text-t2'}>
              <b className={work[key] === 0 ? 'font-medium text-t3' : 'font-medium text-t1'}>{work[key]}</b> {word}
            </span>
          ))}
        </div>
      </Tile>

      <Tile fact="cost" caption="Cost">
        {/* README: 22px mono, -.5px. The five lines below are M32/M51's and are NOT touched --
          * `gate:m51-breaker` (:1413-1436) reads four of them out of this exact tile, by
          * `[data-testid="brief-tile"][data-brief="cost"]`, and needs no edit at all. */}
        <span className="font-mono text-[22px] font-semibold tracking-[-.5px] text-t1">
          {cost.budgetUsd === null ? formatUsd(cost.spentUsd) : `${formatUsd(cost.spentUsd)} / $${String(cost.budgetUsd)}`}
        </span>
        <span data-testid="brief-cost-actual" className="mt-1 text-[12.5px] text-t2">
          actual {formatUsd(cost.actualUsd)}
        </span>
        {formatUsd(cost.estimatedUsd) !== formatUsd(cost.actualUsd) && (
          <span data-testid="brief-cost-estimated" className="text-[12.5px] text-t2">
            estimated {formatUsd(cost.estimatedUsd)}
          </span>
        )}
        {formatUsd(cost.upperBoundUsd) !== formatUsd(cost.spentUsd) && (
          <span data-testid="brief-cost-upper-bound" className="text-[12.5px] text-s-waiting">
            upper bound {formatUsd(cost.upperBoundUsd)}
          </span>
        )}
        {cost.unmeasuredCalls > 0 && (
          <span data-testid="brief-cost-unmeasured-calls" className="text-[12.5px] text-s-waiting">
            {cost.unmeasuredCalls} unmeasured calls charged at {formatUsd(SUPERVISOR_PER_CALL_CAP_USD)} each
          </span>
        )}
        {cost.unmeasuredRuns > 0 && (
          <span data-testid="brief-cost-unmeasured-runs" className="text-[12.5px] text-s-waiting">
            {cost.unmeasuredRuns} unmeasured runs (not in the total)
          </span>
        )}
      </Tile>

      <Tile fact="supervisor" caption="Supervisor">
        {/* Unchanged from the eight-tile brief, deliberately: `gate:m45` (:782-791) reads this
          * node's text AND its `title`, and asserts the word is "1 DECISION WAITING" with the raw
          * state "decisions" behind it (`docs/ia.md` rule 3). Not one character moves. */}
        <span data-testid="brief-supervisor-state" title={supervisor.state} className="w-fit">
          <StatusPill tone={supervisorTone} label={supervisor.label} />
        </span>
        {/* README: "Runbook <b>Web feature</b> · stage 3/5 Verify". ONE line, from the snapshot the
          * page already holds; `RunbookPanel` keeps its own section below, with its own eleven
          * testids that `gate:m48-runbooks` reads (Step 7d). */}
        {runbookLine !== null && (
          <span data-testid="brief-runbook-line" className="mt-2 text-[12.5px] text-t2">
            {runbookLine}
          </span>
        )}
      </Tile>

      <Tile fact="latest-verified" caption="Latest verified">
        {latestVerified === null ? (
          <EmptyState testId="latest-verified-empty" message="nothing verified yet" />
        ) : (
          <>
            {/* `gate:m45` asserts this tile says the task's title and the word "integrated". */}
            <span className="font-medium text-t1">
              {latestVerified.taskTitle} — {VERIFIED_WORD[latestVerified.kind]}
            </span>
            <span className="font-mono text-[12px] text-t3">{clock(latestVerified.at)}</span>
          </>
        )}
        <Link
          href={`/w/${workspaceId}/knowledge`}
          data-testid="brief-knowledge"
          className="mt-[6px] text-[12.5px] font-medium text-accent"
        >
          Knowledge: {knowledge.verified} verified · {knowledge.candidates} candidates →
        </Link>
      </Tile>
```

**(d) The four tiles that GO, and where each fact went** (`docs/ia.md` rule 2 — moved, not removed):

| Tile | Where the fact is now |
|---|---|
| `objective` | the page's title row, above the Needs-you card: the goal line + `Edit goal` link (Step 7a) |
| `needs-you` | the **Needs-you card**, which shows all four kinds rather than a five-row slice, and answers a decision in place |
| `team` | the **Team rows** below the tiles, which show every worker rather than a five-row slice (R18) |
| `recent-changes` | the **Recent changes** section, which is `SupervisorTimeline` — a fuller answer than five mono lines |

Delete those four `<Tile>` blocks, the `BRIEF_LIST_MAX` slicing, `needsYouShown`, `teamShown`,
`NEEDS_YOU_TONE`, `NEEDS_YOU_WORD`, `SLAVE_LIFECYCLE_LABEL`'s use here and the now-unused imports
(`Chip`, `AvatarTile`, `TONE_TEXT`, `Panel`, `SectionLabel` — let `tsc` and `npm run --silent typecheck`
name them). **Note the testid collision this resolves:** the old `needs-you` tile rendered
`data-testid="needs-you-row"`, and so does `NeedsYouCard`. After this step there is exactly one
element with that testid on the page, which is what `apps/web/test/overview-components.test.tsx`'s
`getAllByTestId('needs-you-row')` cases will now count.

**(e) The signature** gains one optional prop and loses one:

```tsx
export function ProjectBrief({
  workspaceId,
  brief,
  runbookLine = null,
}: {
  readonly workspaceId: string
  readonly brief: ProjectBriefFacts
  /** README "Overview" → Supervisor tile: `Runbook <name> · stage n/N <stage>`, or null when this
   *  project has adopted none. It is NOT on `ProjectBrief` the DTO (`server/brief.ts` has no
   *  runbook field) — `OverviewClient` composes it from `view.runbook`, which `RunbookPanel` below
   *  already reads, so no read model changes. */
  readonly runbookLine?: string | null
}): React.JSX.Element {
```

`onOpenSlave` goes: the only thing that used it was the `team` tile's rows, and the Team rows below
own that now. `const { objective, … }` destructuring drops `objective`, `needsYou`, `team` and
`recentChanges`; add `const workTotal = WORK_WORDS.reduce((n, { key }) => n + work[key], 0)`.

**(f) `WORK_WORDS`** gains a `fill` per entry, spelled literally:

```tsx
/**
 * FIVE keys and FIVE distinct fills (spec §6 deviation 3, scan finding 71).
 *
 * The keys are the READ MODEL's (`ProjectBriefFacts['work']`), not the README's — the README draws
 * `working / planning / review / blocked / done` and `server/brief.ts` counts
 * `working / verifying / review / waiting / done`. Changing the buckets is a read-model change and
 * a `gate:m45` change, which is a different milestone's work.
 *
 * What this milestone does owe the README is FIVE segments a person can tell apart: the draft gave
 * `working` and `verifying` the same fill, so two of the five read as one bar. `verifying` takes
 * `--s-planning`, which is the tone nothing else in this bar uses.
 */
const WORK_WORDS: readonly { readonly key: keyof ProjectBriefFacts['work']; readonly word: string; readonly fill: string }[] = [
  { key: 'working', word: 'WORKING', fill: 'bg-s-working' },
  { key: 'verifying', word: 'VERIFYING', fill: 'bg-s-planning' },
  { key: 'review', word: 'IN REVIEW', fill: 'bg-s-review' },
  { key: 'waiting', word: 'WAITING', fill: 'bg-s-waiting' },
  { key: 'done', word: 'DONE', fill: 'bg-s-done' },
]
```

**(g) Delete `TopStrip`:**

```bash
git rm apps/web/src/components/TopStrip.tsx
grep -rn "TopStrip\|strip-value-\|strip-tile\|strip-unmeasured\|strip-supervisor-spend" apps/web/src apps/web/test scripts
```

Every remaining hit is in `apps/web/src/components/OverviewClient.tsx` (the element and its import —
delete both) and in `apps/web/test/overview-components.test.tsx` (Step 9). **No gate script reads
any `strip-*` testid** — the census is in spec §3's removed table — and the bare `strip` is kept by
(a).

- [ ] **Step 5c: Give `AvatarTile` a size, so one row can be 30px without moving five other surfaces**

The README's Team row draws a 30 px avatar; `ui/AvatarTile.tsx` is `h-7 w-7` (28 px) and renders on
six surfaces (`grep -rln AvatarTile apps/web/src`). Editing the literal would resize `TaskCard`,
`AllSlavesTable`, `ProjectsClient` and `GraphDrawer` — four surfaces this milestone says it is not
touching — and leaving it alone makes Task 9's `30px` assertion fail against a 28 px component
(scan finding 57). A prop, defaulted to what every existing caller already gets:

```tsx
export function AvatarTile({
  name,
  tone,
  size = 'sm',
}: {
  readonly name: string
  readonly tone: StatusTone
  /**
   * `sm` (28 px, `h-7 w-7`) is the handoff's original and stays the DEFAULT, so not one of the five
   * existing call sites moves a pixel. `md` (30 px) is the M57 Overview Team row's
   * (README "Overview" → Team rows: "30px avatar tile (18% tint)"), and it is the only caller that
   * passes it. `gate:m14-fidelity` measures both, each scoped to the surface it belongs to.
   */
  readonly size?: 'sm' | 'md'
}): React.JSX.Element {
  return (
    <span
      data-testid="avatar-tile"
      data-tone={tone}
      data-size={size}
      title={name}
      className={`inline-flex ${size === 'md' ? 'h-[30px] w-[30px]' : 'h-7 w-7'} shrink-0 items-center justify-center rounded-tile border font-mono text-[11px] font-semibold ${TONE_FILL[tone]} ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}
    >
      {initialsOf(name)}
    </span>
  )
}
```

Update the docstring's "28×28" sentence to name both sizes. If `apps/web/test/avatar-tile.test.tsx`
exists, add one case asserting the default is `h-7 w-7` and `size="md"` is `h-[30px]`; if it does
not, add those two assertions to the row case in Step 8b instead.

- [ ] **Step 5b: Turn `SlaveCard` into the README's Team row (R18)**

`SlaveCard.tsx` renders on the Overview and nowhere else (`grep -rln "<SlaveCard" apps/web/src`
returns `OverviewClient.tsx` alone), so this is a one-page change with no other caller to consider.
Keep the whole top of the file — the imports, `taskRef`, the `pending`/`run` control machinery, the
`canPause`/`canResume`/`canStop`/`showResume`/`waitingFor` derivations, `FLASH_COLOR`, `flashing`,
and every POST — and replace only the returned JSX and the footer button.

```tsx
  return (
    <article
      data-testid="slave-card"
      data-status={slave.status}
      data-card-state={state}
      data-released={slave.released === null ? undefined : 'true'}
      // README "Overview" → Team rows: `34px 120px 120px 1fr 96px 32px`, padding `10px 14px`, with
      // the row's own hairline underneath. `TONE_BORDER` is gone from the recipe -- a ROW is not a
      // bordered card, and the tone now reads from the avatar tile and the status word instead.
      className={`relative grid grid-cols-[34px_120px_120px_minmax(0,1fr)_96px_32px] items-center gap-3 border-b border-line px-[14px] py-[10px] transition-colors hover:bg-hover ${
        flashing ? 'motion-safe:animate-[border-flash_800ms_ease-out]' : ''
      }${slave.released === null ? '' : ' opacity-60'}`}
      style={flashing ? ({ '--flash-color': FLASH_COLOR[slave.status] } as React.CSSProperties) : undefined}
    >
      {/* The activity sweep, unchanged (design README "Motion"; `gate:m14-fidelity:1238-1240`
        * reads its three animation properties): a 2.2s cubic-bezier(.4,0,.2,1) gradient travelling
        * the row's top hairline while it is `working`. The motion did not change, so neither do
        * those three assertions. */}
      {state === 'working' && (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
          <span
            data-testid="card-sweep"
            className="block h-full w-full bg-gradient-to-r from-transparent via-s-working to-transparent motion-safe:animate-[card-sweep_2.2s_cubic-bezier(.4,0,.2,1)_infinite]"
          />
        </span>
      )}

      {/* 1. The 30px avatar tile (README "Overview" → Team rows). `size="md"` is the prop Step 5c
        * adds to `AvatarTile`: that primitive renders on five other surfaces this milestone does
        * not touch, so its 28px default stays the default and this row opts in. */}
      <AvatarTile name={slave.name} tone={tone} size="md" />

      {/* 2. Name and role. */}
      <button
        type="button"
        onClick={() => onOpen(slave.id)}
        aria-label={`Open ${slave.name}'s detail panel`}
        className="min-w-0 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span className="flex items-center gap-[5px]">
          <span className="block truncate text-[13px] font-semibold text-t1">{slave.name}</span>
          {/* M50's lifecycle marker stays: `docs/ia.md` records it as a promise, and `project` --
            * the ordinary case -- still prints nothing, because a marker every row carries marks
            * nothing. */}
          {slave.lifecycle !== 'project' && (
            <span
              data-testid="card-lifecycle-chip"
              title={slave.lifecycle}
              className="shrink-0 rounded-chip border border-line2 px-[5px] text-[10.5px] text-t3"
            >
              {SLAVE_LIFECYCLE_LABEL[slave.lifecycle]}
            </span>
          )}
        </span>
        <span className="block truncate text-[12px] text-t3">{slave.role}</span>
      </button>

      {/* 3. The mini status: the dot and the WORD, in the tone. `StatusPill` keeps this row's
        * `status-pill` testid and its pulsing inner span, which `gate:m14-fidelity:1241-1242`
        * reads as `[data-testid="slave-card"] [data-testid="status-pill"] span`. */}
      <StatusPill tone={tone} label={label} pulse={pulse} />

      {/* 4. What this worker is doing, ellipsised. The `card-task-title` testid is kept; the
        * separate `card-task-ref` is folded into it, because a row has one line here and the id is
        * in `SlavePanel`, which the `⋯` opens. */}
      <span data-testid="card-task-title" className="min-w-0 truncate text-[13px] text-t2">
        {slave.taskTitle ?? 'idle'}
        {slave.taskId !== null && <span className="ml-2 font-mono text-[11px] text-t3">{taskRef(slave.taskId)}</span>}
      </span>

      {/* 5. ONE primary button (README "One action cluster"). Its testid follows its ACTION, so
        * `gate:m14-fidelity:1295` still finds `card-pause` on a working row. `Unblock` is
        * accent-filled -- the README's one emphasised row action.
        *
        * `slave.taskStatus`, NEVER `slave.status` (spec erratum E14). `SlaveCardData.status` is a
        * `SlaveStatus` -- `idle | starting | working | pausing | paused | resuming | stopping` --
        * with no `blocked` member at all, so comparing it against `'blocked'` does not even
        * compile. The README's Unblock is about a blocked TASK, which is the field
        * `cardStateFor` already reads at `SlaveCard.tsx:86`. Verify the member's name on
        * `SlaveCardData` (`server/overview.ts`) before transcribing: if it is not `taskStatus`,
        * use whatever `cardStateFor`'s second argument is fed from. */}
      {waitingFor !== null ? (
        <RowButton testId="card-answer" accent onClick={() => onOpen(slave.id)}>
          Answer
        </RowButton>
      ) : slave.taskStatus === 'blocked' ? (
        <RowButton testId="card-unblock" accent onClick={() => onOpen(slave.id)}>
          Unblock
        </RowButton>
      ) : showResume ? (
        <RowButton testId="card-resume" disabled={!canResume || pending.has('resume')} onClick={() => void run('resume')}>
          Resume
        </RowButton>
      ) : (
        <RowButton testId="card-pause" disabled={!canPause || pending.has('pause')} onClick={() => void run('pause')}>
          Pause
        </RowButton>
      )}

      {/* 6. `⋯` -- Message and Stop live in `SlavePanel`, which is what this opens, and both are
        * already there (`docs/ia.md` rule 2: moved, not removed). */}
      <button
        type="button"
        data-testid="card-more"
        aria-label={`More actions for ${slave.name}`}
        onClick={() => onOpen(slave.id)}
        className="rounded-card border-0 bg-transparent text-center text-[14px] text-t3 transition-colors hover:text-t1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        ⋯
      </button>

      {errorText !== null && (
        <span role="alert" data-testid="card-error" className="col-span-6 text-[11px] text-s-blocked">
          {errorText}
        </span>
      )}
    </article>
  )
}

/** The row's one action. Not `ui/Button`: that component fixes `data-testid="button"` for every
 *  instance, and this row's button needs the testid to say which action it is. */
function RowButton({
  testId,
  accent = false,
  disabled = false,
  onClick,
  children,
}: {
  readonly testId: string
  readonly accent?: boolean
  readonly disabled?: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-tile px-[10px] py-[5px] text-center text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        accent ? 'border-0 bg-accent font-semibold text-accent-ink' : 'border border-line2 bg-transparent text-t1 hover:bg-hover'
      }`}
    >
      {children}
    </button>
  )
}
```

**What leaves the row, and where it already is.** `card-task-ref` (folded into `card-task-title`
above), `card-step`, `card-percent`, `card-skill-chip`, `card-queue-chip`, `card-waiting-for`,
`card-resume-requested`, the `ProgressBar`, `RuntimeRoleChips`, `provider-chip`, `action-line`,
`card-message` and `card-stop` — **every one of them is already in `SlavePanel`**, which the row's
`⋯` and its name both open. Delete the `FooterButton` helper, the now-unused imports (`Chip`, `ProgressBar`,
`RuntimeRoleChips`, `ShellOnlyMark`, `TONE_BORDER`) **and the now-unused LOCALS** — which
`noUnusedLocals` makes errors rather than warnings, and which `tsc` reports differently from the
imports (scan finding 70): `canStop` (only `card-stop` read it), `line` and the `slave.actionLine`
fallback it wraps (only `action-line` read them), and the `liveActionLine` parameter itself. Leave
`canPause`, `canResume`, `showResume`, `waitingFor`, `state`, `tone`, `pulse`, `label`, `flashing`
and `taskRef` — the row reads every one. **No gate script reads any of the removed testids**; the
census is in spec §3's removed table, and the one gate hit on this file
(`gate-m14-fidelity:1295`, `card-pause`) is preserved above.

- [ ] **Step 6: Restyle the Projects page**

In `apps/web/src/components/ProjectsClient.tsx`:

**(a) The header action moves to the header.** Delete the `<Button variant="primary" size="sm"
data-testid="new-project" …>` element from the title row and add, beside the component's other
hooks:

```tsx
  const openNew = useCallback((): void => setNewOpen(true), [])
  useHeaderAction(
    <button
      type="button"
      data-testid="new-project"
      onClick={openNew}
      className="rounded-card border-0 bg-accent px-[14px] py-[7px] text-[13px] font-semibold text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      + New project
    </button>,
    [openNew],
  )
```

…with `import { useHeaderAction } from './shell/HeaderActionProvider'` and `useCallback` added.
**`data-testid="new-project"` does not change** — `gate-m44-ux-foundation.mjs` clicks it.

**(b) The page title row** becomes the README's H1 + sub. Replace the `<SectionLabel>Projects</SectionLabel>`
line with:

```tsx
          <div>
            <h1 className="m-0 text-[22px] font-semibold tracking-[-.3px] text-t1">Projects</h1>
            <p className="mt-1 text-[13.5px] text-t2">
              {projects.length} projects
              {needsYouTotal > 0 && (
                <>
                  {' · '}
                  <span className="font-medium text-s-waiting">{needsYouTotal} things need you</span>
                </>
              )}
            </p>
          </div>
```

…with `const needsYouTotal = projects.reduce((n, project) => n + project.needsYou, 0)` above the
return. Keep the `show archived` checkbox exactly where it is, on the right of that row.

**(c) The grid** becomes the README's auto-fit: replace
`className="grid grid-cols-1 gap-[14px] p-[18px_20px] md:grid-cols-3"` with
`className="grid gap-[14px] p-[18px_24px] [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]"`.

**(d) The card.** In `ProjectCard`, change ONLY the class strings and add the two rows the README
adds; every `data-testid` in that function is kept verbatim (`project-card`, `project-archived`,
`project-description`, `project-needs-you`, `team-overflow`, `project-unmeasured`,
`restore-project`, `restore-project-error`, `assign-company-button`).

**The recipe lands ON the surface, not on a wrapper** (scan finding 24). Today the function returns
`<div data-testid="project-card" className="flex flex-col gap-2">` wrapping a `<Card>` that draws
the actual bordered surface — so putting the README's border and radius on the outer `div` would
render a bordered card inside a bordered card, and `gate-m57` stage 8 and the rewritten `gate-m14`
both measure `[data-testid="project-card"]`'s `border-radius` as `14px`. `ui/Card` already takes
`testId` and `className` (M44 R3 widened it for exactly this), so the wrapper goes and the testid
moves onto `Card`:

```tsx
    <Card
      testId="project-card"
      className={`gap-3 rounded-page-card p-4 px-[18px] shadow-card ${
        project.needsYou > 0 ? 'border-[color-mix(in_oklab,var(--s-waiting)_45%,var(--line))]' : ''
      }`}
    >
```

`Card`'s own base classes are `flex w-full flex-col gap-2 rounded-card border p-3 text-left
transition-colors` plus `border-line bg-bg-2 hover:border-line-hover`, and a caller's `className` is
appended after them — so `gap-3`, `rounded-page-card`, `p-4 px-[18px]` and the needs-you border each
override their counterpart, and `bg-bg-2` is `var(--card)` through Task 1's alias layer. Check the
rendered result against the README rather than assuming the cascade: if `rounded-card` wins over
`rounded-page-card` because both are single-class utilities of the same specificity in source order,
pass the radius as an arbitrary value (`rounded-[14px]`) and say so in the task report.

…the project name becomes `text-[16px] font-semibold tracking-[-.2px] text-t1`, the company ·
runbook line `text-[12.5px] text-t3`, the goal line `min-h-[40px] text-[13.5px] leading-[1.45] text-t2`,
and a needs strip is inserted between the goal and the team row:

```tsx
      {project.needsYou > 0 && (
        <div className="flex items-center justify-between rounded-panel bg-[color-mix(in_oklab,var(--s-waiting)_10%,transparent)] px-3 py-[9px] text-[13px] text-t1">
          <span data-testid="project-needs-you">{project.needsYou} need you</span>
          <span className="font-semibold">Review →</span>
        </div>
      )}
```

…and the card's footer gains the README's accent call to action:

```tsx
      <div className="flex items-center justify-between border-t border-line pt-3 text-[12.5px] text-t2">
        <span className="font-mono">{formatUsd(project.spend)}</span>
        <span className="text-[13px] font-semibold text-accent">Open project →</span>
      </div>
```

*(`project-needs-you` moves INTO the strip and keeps its testid; delete the old `<span
data-testid="project-needs-you" …>` at line 96 so there is exactly one.)*

**(e) The KPI panel** keeps `data-testid="all-projects-analytics"` and `KpiStrip` untouched; only
its wrapper's classes change, to the README's five-tile card:
`className="flex flex-col gap-4 px-[24px] pb-[24px]"`.

- [ ] **Step 7: Lay the Overview out in the README's five bands**

Rewrite the body of `<PageShell flush>` in `apps/web/src/components/OverviewClient.tsx` so the page
reads, top to bottom, exactly as the README's "Overview" section does. The halt banner, the stale-data
`Alert` and the `ws-adopted-from` `Alert` stay above all five, where they are.

**(a) Band 1 — the title row** (README: "H1 22/600 + workspace status pill. Goal line 13.5 `--t2` +
`Edit goal` accent link"). This is where the deleted `objective` tile's fact went:

```tsx
          <section data-testid="project-title" className="px-[24px] pt-[22px]">
            <div className="flex items-center gap-3">
              <h1 className="m-0 text-[22px] font-semibold tracking-[-.3px] text-t1">{view.workspace.name}</h1>
              <StatusPill tone={WORKSPACE_TONE[workspaceStatus.state]} label={workspaceStatus.label} title={workspaceStatus.state} />
            </div>
            <p data-testid="project-goal-line" className="mt-[6px] text-[13.5px] text-t2">
              {view.brief.objective.version > 0 && `Goal v${String(view.brief.objective.version)} · `}
              {view.brief.objective.text ?? 'no goal yet'}{' '}
              <Link href={`/w/${workspaceId}/settings`} className="font-medium text-accent">
                Edit goal
              </Link>
            </p>
          </section>
```

…with, above the return:

```tsx
  const workspaceStatus = userWorkspaceStatus({
    archived: false,
    halted: view.workspace.haltedReason !== null,
    needsYouCount: view.needsYou.length,
    tasksActive: view.tasks.active,
  })
```

`WORKSPACE_TONE` is `ProjectsClient.tsx:35-41`'s table: **move it into
`apps/web/src/lib/tones.ts` as an export** and import it in both files, so one table has two readers
instead of two tables having one each. `userWorkspaceStatus` comes from `@slave-of-ai/domain`.
`archived: false` because an archived project's Overview is reachable but its chip lives on the
Projects card; read `server/overview.ts`'s `workspace` shape first and pass the real flag if
`OverviewSnapshot` carries one.

**(b) Band 2 — the Needs-you card**, and the `BlockedPanel` it replaces:

```tsx
          <NeedsYouCard workspaceId={workspaceId} items={view.needsYou} />
```

Delete the `<BlockedPanel …/>` element Task 4 Step 12 left on the page and its import — the
Needs-you card is its four-kind superset (`grep -rn BlockedPanel apps/web/src` afterwards; if
`OverviewClient.tsx` still EXPORTS it for another reader, keep the export and delete only the
element). **No `onRefresh` is passed** (scan finding 25): `useOverview` exposes no refetch, and the
card does not need one — approve and reject append events, this page's own stream wakes on them, and
the snapshot is refetched 250 ms later by the loop every other control here already rides.

**(c) Band 3 — the four fact tiles**, which is `ProjectBrief` after Step 5:

```tsx
          <ProjectBrief workspaceId={workspaceId} brief={view.brief} runbookLine={runbookLine} />
```

…with `runbookLine` composed above the return from the snapshot `RunbookPanel` already reads:

```tsx
  // README "Overview" → Supervisor tile: `Runbook <name> · stage 3/5 Verify`. Composed here rather
  // than in `server/brief.ts` because `ProjectBrief` the DTO has no runbook field and this
  // milestone adds no read-model field -- `view.runbook` is already on the snapshot for the panel
  // below.
  //
  // `RunbookPanelView` is `{adopted: RunbookOption | null, currentStage: string | null, stages,
  // recommendations, all, pendingDecision}` (`server/runbook.ts:34-57`): the NAME is on `adopted`,
  // the stage's name is `currentStage`, and there is no index at all -- it is derived from
  // `stages`. A project with no adopted runbook has no line.
  const runbookLine = ((): string | null => {
    const runbook = view.runbook
    if (runbook?.adopted == null) return null
    const stageIndex = runbook.stages.findIndex((stage) => stage.name === runbook.currentStage)
    const position = stageIndex < 0 ? '' : ` · stage ${String(stageIndex + 1)}/${String(runbook.stages.length)}`
    return `Runbook ${runbook.adopted.name}${position}${runbook.currentStage === null ? '' : ` ${runbook.currentStage}`}`
  })()
```

*(`RunbookStageView`'s own member may be `name`, `key` or `label` — read `server/runbook.ts` and use
the one that holds the stage's word. `tsc` names it if you guess wrong.)*

Delete `<TopStrip snapshot={view} />` and its import (Step 5g).

**(d) Band 4 — the Team rows.** The section keeps `id="team"` and `data-testid="team"` (the brief's
old `team-more` anchor pointed at `#team`, and `overview-components.test.tsx` reads the testid); the
GRID becomes a rows container, because `SlaveCard` is a row now:

```tsx
          <section id="team" data-testid="team" className="px-[24px] pt-[18px]">
            <div className="mb-[10px] flex items-center justify-between">
              <span className="font-semibold text-t1">
                Team <span className="font-mono text-[12px] font-medium text-t3">{view.slaves.length}</span>
              </span>
              <Link href={`/w/${workspaceId}/organization`} className="text-[13px] font-medium text-accent">
                Open Team →
              </Link>
            </div>
            {/* README "Overview" → Team rows: one card, hairline-separated rows inside it. The
              * grid itself is `SlaveCard`'s own (R18); this owns only the surface around them. */}
            <div className="overflow-hidden rounded-panel-card border border-line bg-card">
              {view.slaves.map((slave) => (
                // THREE props. `liveActionLine` is gone with the `action-line` the row no longer
                // draws (Step 5b) -- the panel the `⋯` opens renders the live line already. The
                // component's signature and this call site change together, in the same step.
                <SlaveCard key={slave.id} slave={slave} workspaceId={workspaceId} onOpen={selectSlave} />
              ))}
            </div>
          </section>
```

If `actionLines` has no other reader in this file after that, delete the destructuring of it from
the `useOverview(...)` call too — `noUnusedLocals` makes an unused local an error, not a warning.

**(e) Band 5 — Recent changes**, which is `SupervisorTimeline` restyled, plus the two panels Task 4
parked on the page:

```tsx
          <section data-testid="recent-changes" className="flex flex-col gap-3 px-[24px] py-[18px]">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-t1">Recent changes</span>
              <Link href={`/w/${workspaceId}/activity`} className="text-[13px] font-medium text-accent">
                All activity →
              </Link>
            </div>
            {/* M45 R2's six-lane timeline, with the README's row look. Its testid, its lane
              * filters, its `timeline-entry` nodes and their `title` attributes are UNCHANGED --
              * `gate:m45-project-experience`'s whole stage 2 reads them, and stage 1's
              * recent-changes assertions are re-pointed here (Step 9). */}
            <SupervisorTimeline workspaceId={workspaceId} entries={view.timeline} needsYou={view.needsYou} />
            <div className="flex gap-3">
              <LiveEventsPanel workspaceId={workspaceId} events={view.liveEvents} />
              <MergeQueuePanel queue={view.mergeQueue} />
            </div>
          </section>
```

In `apps/web/src/components/project/SupervisorTimeline.tsx`, change **class strings only** so each
entry reads the README's way: a mono time in a fixed **64 px** column, an 8 px tone dot, then
`<b>Family · verb</b> — sentence`. Concretely, whatever element wraps one entry becomes
`grid grid-cols-[64px_14px_minmax(0,1fr)_auto] items-baseline gap-3 border-b border-line px-4 py-[11px]`,
its time span `font-mono text-[12px] text-t3`, and its ref chip
`rounded-chip border border-line2 px-[7px] py-[2px] font-mono text-[11.5px] font-medium text-t2`.
**Do not touch `timeline-lanes`, `timeline-entry`, `timeline-decisions`, `timeline-lane-filter-*`,
`timeline-rule` or any `title` attribute** — `gate:m45` stages 2 and 3 and `gate:m14-fidelity`'s
`timeline-rule` `left: 88px` row all read them.

**(f) What stays exactly as it is.** `RunbookPanel` keeps its own section between the Team rows and
Recent changes, unchanged: it is 318 lines with an adopt drawer and a stage list, `gate:m48-runbooks`
reads eleven of its testids, and the README's "one line" is the SUMMARY of it, which band 3's
Supervisor tile now carries. A `DetailsGroup` was the alternative and is worse for a concrete
reason: `DetailsGroup`'s `group` prop is a closed union of ~28 names in the domain, so hiding this
panel behind one would mean editing the domain in a milestone that promised not to.
`SupervisorRequest` is deleted per Step 7g below.

**(g) The Supervisor request box.** It is the right panel's composer now, and two boxes posting to
one route is one box too many.

**Task 6 renames nothing** (spec erratum E17). Task 5 already wrote `SupervisorThreadPanel` with
`supervisor-composer` on the composer WRAPPER, `supervisor-request-input` on the textarea,
`supervisor-request-send` on the button, `supervisor-request-result` on the SUCCESS line and
`supervisor-request-error` on the refusal — so every testid `gate:m45` reads is already emitted, in
the right places, by the component that is already on screen. All this step does is take the old box
off the page and delete it.

```bash
grep -rn "SupervisorRequest" apps/web/src apps/web/test
```

Against `c828f8c8` that reports THREE things, and each has an instruction:
1. `apps/web/src/components/project/SupervisorRequest.tsx` — the component. `git rm` it.
2. `apps/web/src/components/OverviewClient.tsx` — the element and its import. Delete both.
3. **`apps/web/test/supervisor-timeline.test.tsx:4` and its `describe('SupervisorRequest')` block at
   `:323-380`, five cases** (scan finding 9). There is no `supervisor-request.test.tsx`; the cases
   live inside the timeline's file. Delete that whole `describe` and the import on line 4, and leave
   every one of the file's own 27 `SupervisorTimeline` cases untouched. **Before deleting, check
   each of the five against `apps/web/test/supervisor-thread-panel.test.tsx`** — "sends the words and
   reports the version it made", "will not send an empty request" and "shows a refusal without
   clearing what was typed" are behaviours the composer still has, and any of the three that the
   thread panel's own suite does not already cover moves there rather than dying.

```bash
git rm apps/web/src/components/project/SupervisorRequest.tsx
grep -rn "SupervisorRequest" apps/web/src apps/web/test
```

The second grep must come back empty.

- [ ] **Step 8: Edit `gate-m45-project-experience.mjs` — three places, every assertion carried over**

This is the gate that measured the eight-tile brief. Each of its three stage-1 blocks is edited so
the SUBSTANCE of the assertion survives on the surface the fact moved to.

**(a) `EXPECTED_BRIEF_FACTS`, lines 95–104** — eight facts become four, in the README's order:

```js
// M57 R17: the brief IS the README's four fact tiles now. The four that left are not gone -- the
// objective is the page's own title row, `needs-you` is the Needs-you card above these tiles (which
// shows all four kinds rather than a five-row slice and answers a decision in place), `team` is the
// Team rows below them, and `recent-changes` is the `supervisor-timeline` section. Each is asserted
// below, on its new surface.
const EXPECTED_BRIEF_FACTS = ['work', 'cost', 'supervisor', 'latest-verified']
```

The `belowFold` measurement at 748–759 is UNCHANGED and is now trivially satisfied — which is the
point: the milestone's claim was that the facts are in the first viewport, and four tiles in one row
are more obviously so than eight in two.

**(b) The `wants` table, lines 769–780** — the `objective` and `team` pairs move onto their new
nodes. Replace the table and the loop that follows it with:

```js
  const tileText = (fact) => tiles.find((tile) => tile.fact === fact)?.text ?? ''
  const wants = [
    ['work', 'WORKING'],
    ['work', 'IN REVIEW'],
    ['cost', '$25'],
    ['cost', 'unmeasured calls charged at $1.00 each'],
    ['latest-verified', integratedTask.title],
    ['latest-verified', 'integrated'],
  ]
  for (const [fact, needle] of wants) {
    const text = tileText(fact)
    console.log(`stage 1: ${fact} tile ${JSON.stringify(text.slice(0, 160))}`)
    if (!text.includes(needle)) {
      await fail(`stage 1: the ${fact} tile does not say ${JSON.stringify(needle)} -- it reads ${JSON.stringify(text)}`)
    }
  }

  // M57 R17: the objective left the tile grid for the page's own title row, where a goal belongs --
  // it is what the project IS, not one fact among four. The same two things are asserted: the goal
  // text and its version.
  const goalLine = await page.evaluate(
    () => document.querySelector('[data-testid="project-goal-line"]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  )
  console.log(`stage 1: goal line = ${JSON.stringify(goalLine)}`)
  for (const needle of [GOAL_V1, 'v2']) {
    if (!goalLine.includes(needle)) {
      await fail(`stage 1: the goal line does not say ${JSON.stringify(needle)} -- it reads ${JSON.stringify(goalLine)}`)
    }
  }

  // M57 R18: the team left the tile grid for the Team ROWS, which list EVERY worker rather than the
  // five the tile sliced to. Same two names, more of them.
  const teamNames = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="team"] [data-testid="slave-card"]')].map((row) =>
      (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
    ),
  )
  console.log(`stage 1: team rows = ${JSON.stringify(teamNames)}`)
  for (const needle of [DEVELOPER_NAME, REVIEWER_NAME]) {
    if (!teamNames.some((row) => row.includes(needle))) {
      await fail(`stage 1: no Team row names ${JSON.stringify(needle)} -- rows read ${JSON.stringify(teamNames)}`)
    }
  }

  // M57: the needs-you tile became the Needs-you CARD, above the tiles. It was asserted nowhere in
  // this gate before (the tile was only in EXPECTED_BRIEF_FACTS); it is asserted now, because a
  // surface that answers a decision in place is a stronger claim than a surface that lists one.
  const needsYouRows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="needs-you-row"]')].map((row) => row.getAttribute('data-kind') ?? ''),
  )
  console.log(`stage 1: needs-you rows = ${JSON.stringify(needsYouRows)}`)
  if (!needsYouRows.includes('decision')) {
    await fail(`stage 1: the Needs you card does not carry the seeded pending decision -- it reads ${JSON.stringify(needsYouRows)}`)
  }
```

**(c) The `recent-changes` block, lines 793–806** — the same two assertions, re-pointed at the
section that holds the fact now:

```js
  // M57 R17: "recent changes" is the `supervisor-timeline` section now, not a five-line tile. The
  // two things this block has always asserted are asserted still: there ARE rows, and none of them
  // prints a raw dotted event type (`docs/ia.md` rule 3).
  const changes = await page.evaluate(() => {
    const section = document.querySelector('[data-testid="recent-changes"]')
    return section === null
      ? []
      : [...section.querySelectorAll('[data-testid="timeline-entry"]')].map((row) =>
          (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
        )
  })
  console.log(`stage 1: recent changes = ${JSON.stringify(changes)}`)
  if (changes.length === 0) {
    await fail('stage 1: the recent-changes section has no entries -- the two goal_set events this gate wrote should be in it')
  }
  for (const line of changes) {
    for (const word of line.split(/\s+/)) {
      if (DOTTED_TYPE.test(word)) {
        await fail(`stage 1: a recent-changes row prints the raw event type ${JSON.stringify(word)}: ${JSON.stringify(line)}`)
      }
    }
  }
```

Read lines 806–812 before pasting and keep whatever closes the block and prints its PASS line; change
that line's wording from "eight facts" to "four facts, the objective on its own title row, the team
in rows and the changes in the timeline".

**Left alone entirely, and asserted so:** `gate-m51-breaker.mjs:1413-1436` reads
`[data-testid="brief-tile"][data-brief="cost"]` and the four `brief-cost-*` spans inside it — Step 5c
keeps that tile, that key and all five spans, so **that gate is not edited**. `gate-m45`'s stage 2
(the timeline's lanes, entries and `title` attributes) and stage 3 are not edited either.

- [ ] **Step 8b: Update the component tests, by name and by case**

```bash
npx vitest run apps/web/test/projects-page.test.tsx apps/web/test/overview-components.test.tsx \
  apps/web/test/project-brief.test.tsx apps/web/test/supervisor-timeline.test.tsx 2>&1 | tail -60
```

*(Those are the four real paths. The draft of this plan named `slave-card.test.tsx` and
`brief.test.tsx`; neither exists — scan findings 58 and 59.)*

**`apps/web/test/project-brief.test.tsx` — 28 cases, and each one has a verdict.** It opens with
`describe('ProjectBrief')` at `:57` and a second `describe('the cost tile after M51 R7')` at `:271`.

- **KEEP, unchanged** — the whole second describe (`:271-338`, six cases): the cost tile keeps its
  headline expression and all five `brief-cost-*` spans, which is why `gate:m51-breaker` needs no
  edit either. Also keep `:66` (the knowledge line is a link INSIDE latest-verified, not a ninth
  tile), `:90` (the Supervisor word with the raw state in `title`), `:97` (the work counts in the
  domain's words, dimming a zero), `:109` and `:122` (the two money sentences), `:210` and `:216`
  (latest-verified's empty and kind cases), `:253` (no budget figure on an unbudgeted project), and
  `:258` (the clock is read off the stamp).
- **REWRITE** — `:58` ("renders exactly the eight facts"): the array becomes
  `['work', 'cost', 'supervisor', 'latest-verified']` and the title says four.
- **DELETE** — every case whose tile is gone: `:75` and `:83` (objective — its fact is the page's
  title row now, asserted in `overview-components.test.tsx`), `:201` (the objective's version chip),
  `:130`, `:148`, `:166` (needs-you and its five-row cap — the Needs-you CARD has its own test file
  and no cap), `:182` (the team's five-row cap — the Team rows show everybody), `:223`, `:234`,
  `:245` (the team rows' content, lifecycle marker and handler — all three move to the `SlaveCard`
  row cases below).
- **MOVE, do not delete** — `:234` ("marks a temporary specialist and greys one whose engagement is
  over") is an M50 `docs/ia.md` promise. The row keeps `card-lifecycle-chip` and the released
  `opacity-60`, so this case is rewritten against `SlaveCard` in `overview-components.test.tsx`
  rather than dropped.
- **ADD** — the two cases at the end of this step.

**`apps/web/test/overview-components.test.tsx`:**
- The `strip-value-*` cases: `strip-tile` at `:157`, the six counts at `:178-188`, the two tone
  cases at `:218-224`, and `strip-supervisor-spend` at `:201` and `:206`. Re-point the six counts to
  their `brief-work-<key>` spans. **Three do not have one** (scan finding 65) and each goes
  somewhere different: `strip-value-spend` is the Cost tile's headline figure;
  `strip-value-blocked` is the Needs-you card's row count; and `strip-supervisor-spend`
  (`'supervisor $0.25 · 2 at $1.00'`) is the Cost tile's own `brief-cost-unmeasured-calls` span,
  which `gate:m51-breaker` also reads. `strip-tile` itself is deleted.
- The `order` arrays (`:863`, `:892`) become
  `['project-title', 'needs-you-card', 'strip', 'team', 'recent-changes']`.
- The `card-message`, `card-stop`, `card-step`, `card-percent`, `card-skill-chip`,
  `card-queue-chip`, `card-task-ref`, `card-waiting-for`, `card-resume-requested`, `provider-chip`
  and `action-line` cases: **check `apps/web/test/slave-panel.test.tsx` for an equivalent first.**
  Spec §3's removed table says which facts are genuinely in the panel and under what testid — and
  says plainly that `card-percent` and `card-queue-chip` are NOT carried there by any testid. A case
  with an equivalent in the panel's suite is deleted here; one without is deleted here too, with the
  fact recorded in spec §3 rather than silently dropped.
- Add the `SlaveCard` row cases and the two Overview cases below.

```tsx
  it('is a row on the README grid, with one primary button and a ⋯ (M57 R18)', () => {
    render(<SlaveCard slave={workingSlave} workspaceId="w1" onOpen={vi.fn()} />)
    const row = screen.getByTestId('slave-card')
    expect(row.className).toContain('grid-cols-[34px_120px_120px_minmax(0,1fr)_96px_32px]')
    expect(screen.getByTestId('card-pause')).toBeTruthy()
    expect(screen.getByTestId('card-more').textContent).toBe('⋯')
    expect(screen.queryByTestId('card-stop')).toBeNull()
  })
```

Add the two Overview cases the new structure earns:

```tsx
  it('lays the page out in the README s five bands (M57 R17)', () => {
    // …render the Overview with a needsYou item…
    const order = [...document.querySelectorAll('[data-testid]')]
      .map((node) => node.getAttribute('data-testid'))
      .filter((id) => ['project-title', 'needs-you-card', 'strip', 'team', 'recent-changes'].includes(id ?? ''))
    expect(order).toEqual(['project-title', 'needs-you-card', 'strip', 'team', 'recent-changes'])
  })

  it('draws FOUR fact tiles, and the container carries both the brief and the strip testid', () => {
    // …render…
    expect(screen.getAllByTestId('brief-tile').map((tile) => tile.getAttribute('data-brief')))
      .toEqual(['work', 'cost', 'supervisor', 'latest-verified'])
    expect(screen.getByTestId('strip').contains(screen.getByTestId('brief'))).toBe(true)
  })
```

- [ ] **Step 9: Suite, gates, build, ladder and commit**

```bash
npx vitest run 2>&1 | tail -20
pgrep -af vitest || echo "no vitest running"
# m45 is the gate Step 8 edited; m51 reads the cost tile and must pass WITHOUT an edit.
# `gate:m14-fidelity` is deliberately NOT here: the Global Constraints give it to Task 9 alone,
# because it rewrites thirteen PNGs and running it before `git add` would commit them from the
# wrong task. Its numbers are expected to be red from here until Task 9 rewrites them.
for g in m44-ux-foundation m45-project-experience m47-team-formation m49-memory m51-breaker; do
  echo "=== $g ==="; npm run "gate:$g" 2>&1 | tail -12; echo "exit=${PIPESTATUS[0]}"
done
pgrep -af "next dev" || echo "no dev server"
npm run web:build 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"
npm run gate:m26-vocabulary && npx tsc --build && npm run --silent typecheck
git add -A
git commit -m "$(cat <<'MSG'
feat(m57): t6 — the Overview in the README's five bands

Title row, Needs you, four fact tiles, Team rows, Recent changes -- in that order,
because that is the order the design asks for. `ProjectBrief` BECOMES the four tiles
rather than gaining a second set beside its eight: the objective moves to the title
row where a goal belongs, needs-you to the card that answers a decision in place, team
to rows that list everybody instead of five, and recent changes to the timeline. The
first draft kept all eight because a gate measured them; the controller's ruling is
that a gate pins a number against accident, not against a change the user asked for.
`SlaveCard` becomes a row on the README's six-track grid, keeping `slave-card`,
`avatar-tile` and `status-pill` so every scoped selector still resolves. `TopStrip` goes
and hands `strip` to the tile grid, which is what three gates were really waiting for.
`gate:m45` is edited in three places and every assertion it made is made still, on the
surface its fact moved to; `gate:m51` reads the cost tile and is not edited at all.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tb1HCWnBqh63E9diBxdxR6
MSG
)"
```

---

### Task 7: Five columns, a list beside the board, and two pages that keep their rows (R10, E6; README "Tasks", "Team", "Knowledge")

**Files:**
- Modify: `apps/web/src/lib/taskColumns.ts`
- Modify: `apps/web/src/components/TasksClient.tsx`
- Modify: `apps/web/src/components/TaskColumn.tsx`
- Modify: `apps/web/src/components/TaskCard.tsx` (class strings and the label only)
- Create: `apps/web/src/components/TaskList.tsx`
- Create: `apps/web/src/components/TaskFilters.tsx`
- Create: `apps/web/src/components/ui/Segmented.tsx` + `apps/web/test/segmented.test.tsx`
- Modify: `apps/web/src/components/organization/OrganizationClient.tsx` (class strings; the page is "Team" now)
- Modify: `apps/web/src/components/knowledge/KnowledgeClient.tsx` (class strings)
- Modify: `apps/web/src/components/graph/ExecutionNodes.tsx` (**nothing to edit — see Step 3b**), `apps/web/test/graph-exec.test.ts`, `apps/web/test/tones.test.ts` (spec erratum E16)
- Modify: `apps/web/test/taskColumns.test.ts` (it exists), `apps/web/test/tasks-components.test.tsx`

*(The two client paths are nested — `components/organization/` and `components/knowledge/` — not
top-level, which is where the draft of this plan looked; the same is true of
`components/sim/SimulationsClient.tsx` in Task 8. Scan finding 15.)*

**Interfaces:**
- Consumes from Task 3: `useHeaderAction`. From earlier milestones, unchanged: `TaskBoardItem`, `TasksSnapshot`, `USER_TASK_LABEL`, `userTaskStatus`, `CARD_STATE_TONE`, `TONE_DOT`.
- Produces, for Tasks 8–9: `BoardColumn = 'Queued' | 'In progress' | 'Review' | 'Blocked' | 'Done'`; `BOARD_COLUMNS` (five, in that order); testids `task-view-toggle`, `task-list`, `task-list-row`, `task-filter-needs-you`, `task-search`.

- [ ] **Step 1: Write the failing test for the five columns**

Create (or extend) `apps/web/test/taskColumns.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
// `@slave-of-ai/db`, NOT the domain (scan finding 19): `TASK_STATUSES` is at
// `packages/db/src/enums.ts:81` and no such export exists under `packages/domain/src`. The file
// this extends already imports it — as `ALL_STATUSES` — so REUSE THE EXISTING BINDING rather than
// adding a second import of the same array under a second name.
import { TASK_STATUSES as ALL_STATUSES } from '@slave-of-ai/db'
import { BOARD_COLUMNS, COLUMN_FOR_STATUS, COLUMN_STATE } from '../src/lib/taskColumns.js'

describe('the board columns', () => {
  it('is the README s five, in its order (M57 R10)', () => {
    expect(BOARD_COLUMNS).toEqual(['Queued', 'In progress', 'Review', 'Blocked', 'Done'])
  })

  it('maps every TaskStatus onto exactly one of them, by the README s table', () => {
    expect(COLUMN_FOR_STATUS).toEqual({
      backlog: 'Queued',
      ready: 'Queued',
      rework: 'Queued',
      assigned: 'Queued',
      running: 'In progress',
      verifying: 'In progress',
      waiting: 'In progress',
      reviewing: 'Review',
      merging: 'Review',
      blocked: 'Blocked',
      done: 'Done',
      failed: 'Done',
      cancelled: 'Done',
    })
  })

  it('leaves no status without a column -- the Record s totality is the build-time guard', () => {
    for (const status of ALL_STATUSES) {
      expect(BOARD_COLUMNS, status).toContain(COLUMN_FOR_STATUS[status])
    }
  })

  it('gives each column one CardState, spelled the way lib/tones.ts spells it (erratum E6)', () => {
    expect(COLUMN_STATE).toEqual({
      Queued: 'planning',
      'In progress': 'working',
      Review: 'review',
      Blocked: 'blocked',
      Done: 'completed',
    })
  })
})
```

*(`apps/web/test/taskColumns.test.ts` ALREADY EXISTS and already imports that array as
`ALL_STATUSES`. Open it first: this step rewrites its four cases rather than creating a file, and
its existing "covers every TaskStatus" and "resolves every column tone through the one tone table"
cases carry over with only the expected values changed.)*

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/web/test/taskColumns.test.ts
```

Expected: FAIL — the first case reports the six old names.

- [ ] **Step 3: Rewrite `lib/taskColumns.ts`'s three tables**

Replace lines 5–53 of `apps/web/src/lib/taskColumns.ts` (`BoardColumn` through `COLUMN_STATE`) with:

```ts
export type BoardColumn = 'Queued' | 'In progress' | 'Review' | 'Blocked' | 'Done'

/** The handoff README's five columns, in its order (M57 R10). Six became five when `Backlog` and
 *  `Todo` folded together: a person does not need `backlog` from `ready` from `rework` from
 *  `assigned` to know the work has not started, which is the same collapse
 *  `packages/domain/src/status/user.ts`'s `USER_TASK_STATE_FOR_STATUS` already made for the WORD on
 *  the card. `docs/ia.md`'s line about the board keeping its own vocabulary in M44 is rewritten by
 *  this milestone: the card's pill is `USER_TASK_LABEL` now, and the column is a phase. */
export const BOARD_COLUMNS: readonly BoardColumn[] = ['Queued', 'In progress', 'Review', 'Blocked', 'Done']

/**
 * Every `TaskStatus` on exactly one column. `Record<TaskStatus, BoardColumn>` is load-bearing and
 * is the whole reason this table is worth having: a fourteenth status added to the domain fails the
 * BUILD here rather than becoming a task nobody can see on any column.
 *
 * `waiting` is `In progress` and not `Blocked`, which was true before M57 and is still true: a
 * waiting task is mid-flight — its slave is paused inside a live session holding the worktree, and
 * the answer that releases it comes from another slave, not from the human the `Blocked` column is
 * addressed to. Its card keeps its own amber WAITING pill.
 *
 * `failed` and `cancelled` share `Done` with `done` and carry their own pill: the column is a
 * phase, and both of those are the end of one.
 */
export const COLUMN_FOR_STATUS: Record<TaskStatus, BoardColumn> = {
  backlog: 'Queued',
  ready: 'Queued',
  rework: 'Queued',
  assigned: 'Queued',
  running: 'In progress',
  verifying: 'In progress',
  waiting: 'In progress',
  reviewing: 'Review',
  merging: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Done',
  cancelled: 'Done',
}

/**
 * The `CardState` each column reads as — the source of its head dot.
 *
 * Deliberately a STATE, not a tone: `lib/tones.ts`'s `CARD_STATE_TONE` is the ONE table that
 * assigns a tone, a label and a pulse, and a second `Record<BoardColumn, StatusTone>` here would be
 * a second place for the palette to drift. `'completed'` is that union's spelling for finished work
 * (`lib/tones.ts:20`, `UserCardState`), not `'done'`.
 */
export const COLUMN_STATE: Record<BoardColumn, CardState> = {
  Queued: 'planning',
  'In progress': 'working',
  Review: 'review',
  Blocked: 'blocked',
  Done: 'completed',
}
```

`priorityChip` below it does not change.

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run apps/web/test/taskColumns.test.ts
npx tsc --build 2>&1 | tail -20
```

Expected: PASS, and `tsc` names every other reader of `BoardColumn` that spelled an old column name
(`TasksClient.tsx`'s `grid-cols-6`, `TaskColumn.tsx`, and any test). Fix each.

- [ ] **Step 4b: The Graph's Execution mode, and the tone a card changes (spec erratum E16)**

`BOARD_COLUMNS`, `COLUMN_FOR_STATUS` and `COLUMN_STATE` have a THIRD production consumer that Step 3
silently rewires: `apps/web/src/components/graph/ExecutionNodes.tsx:5` imports all three, and its
own docstring says why — "the board and this graph must never disagree about which column a
`merging` task belongs to, and two tables that agree today are two tables that disagree after the
first edit." **So there is nothing to edit in that file**: the pipeline becomes five stages, in the
new order, with the new tones, by construction. That is the design working, and it is the reason
spec §6's "the Graph canvas is out of scope" means its RENDERING and not its vocabulary.

Two tests pin the old literals and must move with it:

- `apps/web/test/graph-exec.test.ts:47` — `it('emits the six stages in BOARD_COLUMNS order, …')`.
  Retitle it to five and change the expected `stages.map((node) => node.id)` array to the five
  `stage:`-prefixed names. `:126` asserts a `running` task's node reads
  `column === 'In Progress'`; the new spelling is **`'In progress'`** (lower-case `p` — scan
  finding 45, and the same rename hits `column-count-In progress` in `tasks-components.test.tsx`).
- `apps/web/test/tones.test.ts:223-240` — `it("is the column's state for every status except the
  four that are not their column")`. Its `waiting` branch asserts
  `COLUMN_FOR_STATUS['waiting'] === 'In Progress'`: same lower-case fix. **And `assigned` changes
  answer**: it was `In Progress` → `working` and is now `Queued` → `planning`, so
  `cardStateForTask('assigned')` returns `'planning'`. That is a real, user-visible change — an
  assigned task's card stops being painted the colour of work in flight — and it is named in spec
  erratum E16 rather than discovered in a screenshot. Add an explicit case for it:

```ts
  it('paints an assigned task as queued, not as working (M57 R10, spec erratum E16)', () => {
    // Until M57 `assigned` sat on the In Progress column and inherited its `working` tone. The
    // README puts it in Queued, and a task nobody has started should not look like one in flight.
    expect(COLUMN_FOR_STATUS.assigned).toBe('Queued')
    expect(cardStateForTask('assigned')).toBe('planning')
  })
```

- [ ] **Step 4c: Write `ui/Segmented`, so the segmented control is written ONCE**

Five surfaces in this milestone draw the same control — Tasks' Board/List, Knowledge's
All/Verified/Candidates, Workforce's two sub-segments, Settings' Appearance and the project
Settings permission matrix's three-way — and the draft of this plan told an implementer to copy a
three-line `segment()` recipe into two of them and re-spell it in a third (scan finding 46a). One
primitive, in `components/ui/`, where the other twenty live:

```tsx
'use client'

/**
 * The handoff's segmented control (README: "1px `--line2` border, radius 8-9, 2px padding; the
 * chosen segment takes `--sel`, weight 600 and `--t1`").
 *
 * ONE implementation for the five surfaces that draw it (M57 R21): Tasks' Board/List, Knowledge's
 * three filters, Workforce's two sub-segments, Settings' Appearance, and the permission matrix's
 * three-way. Presentational and uncontrolled-free: the caller owns `value` and `onChange`, so a
 * segment that navigates and a segment that sets state are the same component.
 *
 * `testIdPrefix` is required rather than defaulted, because every one of those five surfaces has a
 * gate or a test that names its segments and a shared default would make four of them collide.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  testIdPrefix,
}: {
  readonly options: readonly { readonly id: T; readonly label: string; readonly count?: number }[]
  readonly value: T
  readonly onChange: (next: T) => void
  readonly ariaLabel: string
  readonly testIdPrefix: string
}): React.JSX.Element {
  return (
    <span
      role="group"
      aria-label={ariaLabel}
      data-testid={testIdPrefix}
      data-value={value}
      className="inline-flex gap-[2px] rounded-card border border-line2 p-[2px]"
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          data-testid={`${testIdPrefix}-${option.id}`}
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
          className={`rounded-nav border-0 px-[10px] py-1 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            option.id === value ? 'bg-sel font-semibold text-t1' : 'bg-transparent text-t2 hover:text-t1'
          }`}
        >
          {option.label}
          {option.count !== undefined && (
            <span className="ml-[6px] font-mono text-[11px] font-medium text-t3">{option.count}</span>
          )}
        </button>
      ))}
    </span>
  )
}
```

And `apps/web/test/segmented.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Segmented } from '../src/components/ui/Segmented.js'

const OPTIONS = [
  { id: 'board' as const, label: 'Board' },
  { id: 'list' as const, label: 'List', count: 12 },
]

describe('Segmented', () => {
  it('names every segment by the caller s prefix and marks the chosen one', () => {
    render(<Segmented options={OPTIONS} value="board" onChange={vi.fn()} ariaLabel="View" testIdPrefix="task-view" />)
    expect(screen.getByTestId('task-view').getAttribute('data-value')).toBe('board')
    expect(screen.getByTestId('task-view-board').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('task-view-list').getAttribute('aria-pressed')).toBe('false')
  })

  it('reports the segment that was pressed, and never sets state of its own', () => {
    const onChange = vi.fn()
    render(<Segmented options={OPTIONS} value="board" onChange={onChange} ariaLabel="View" testIdPrefix="task-view" />)
    act((): void => { screen.getByTestId('task-view-list').click() })
    expect(onChange).toHaveBeenCalledWith('list')
    // Still `board`: the caller owns the value.
    expect(screen.getByTestId('task-view').getAttribute('data-value')).toBe('board')
  })

  it('shows a count beside a segment that has one, and nothing where there is none', () => {
    render(<Segmented options={OPTIONS} value="board" onChange={vi.fn()} ariaLabel="View" testIdPrefix="task-view" />)
    expect(screen.getByTestId('task-view-list').textContent).toContain('12')
    expect(screen.getByTestId('task-view-board').textContent).toBe('Board')
  })

  it('is a named group, so a screen reader says what the choice is about', () => {
    render(<Segmented options={OPTIONS} value="list" onChange={vi.fn()} ariaLabel="View" testIdPrefix="task-view" />)
    expect(screen.getByRole('group', { name: 'View' })).toBeTruthy()
  })
})
```

- [ ] **Step 5: Write the filter row and the list view**

Create `apps/web/src/components/TaskFilters.tsx`:

```tsx
'use client'

import type { TaskBoardItem } from '../server/tasks'
import { Segmented } from './ui/Segmented'

/** The README's filter row: a search box, a `Needs you · n` toggle, one chip per assignee and the
 *  Board/List segmented control. Everything here filters the snapshot the page is ALREADY holding
 *  — no query, no route, no server round trip. */
export function TaskFilters({
  query,
  onQuery,
  needsOnly,
  onNeedsOnly,
  needsCount,
  assignees,
  assignee,
  onAssignee,
  view,
  onView,
}: {
  readonly query: string
  readonly onQuery: (next: string) => void
  readonly needsOnly: boolean
  readonly onNeedsOnly: () => void
  readonly needsCount: number
  readonly assignees: readonly string[]
  readonly assignee: string | null
  readonly onAssignee: (next: string | null) => void
  readonly view: 'board' | 'list'
  readonly onView: (next: 'board' | 'list') => void
}): React.JSX.Element {
  // The two filter CHIPS keep their own recipe (they toggle independently and one of them is
  // amber); the Board/List control is `ui/Segmented` (M57 R21) -- no copied class strings.
  const chip = (on: boolean, tone?: 'waiting'): string =>
    `rounded-card border px-3 py-[5px] text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
      on
        ? tone === 'waiting'
          ? 'border-[color-mix(in_oklab,var(--s-waiting)_45%,var(--line2))] bg-[color-mix(in_oklab,var(--s-waiting)_14%,transparent)] text-s-waiting'
          : 'border-line2 bg-sel font-semibold text-t1'
        : 'border-line2 bg-transparent text-t2 hover:text-t1'
    }`
  return (
    <div className="flex flex-wrap items-center gap-2 px-[24px] pt-[18px] text-[13px]">
      <input
        data-testid="task-search"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        placeholder="Search tasks…"
        aria-label="Search tasks"
        className="w-[220px] rounded-card border border-line2 bg-card px-[10px] py-[6px] text-[13px] text-t1 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
      <button type="button" data-testid="task-filter-needs-you" aria-pressed={needsOnly} onClick={onNeedsOnly} className={chip(needsOnly, 'waiting')}>
        Needs you · {needsCount}
      </button>
      {assignees.map((name) => (
        <button
          key={name}
          type="button"
          data-testid="task-filter-assignee"
          data-assignee={name}
          aria-pressed={assignee === name}
          onClick={() => onAssignee(assignee === name ? null : name)}
          className={chip(assignee === name)}
        >
          {name}
        </button>
      ))}
      {/* `testIdPrefix="task-view"` gives `task-view-board` / `task-view-list` -- the two names
        * spec §3 lists and `gate-m57` stage 6 clicks. `task-view-toggle` stays on the wrapper, so
        * all three exist. */}
      <span className="ml-auto" data-testid="task-view-toggle" data-view={view}>
        <Segmented
          options={[
            { id: 'board', label: 'Board' },
            { id: 'list', label: 'List' },
          ]}
          value={view}
          onChange={onView}
          ariaLabel="Task view"
          testIdPrefix="task-view"
        />
      </span>
    </div>
  )
}

/** Which tasks survive the filter row. Exported so the page and its test agree on one rule. */
export function filterTasks(
  tasks: readonly TaskBoardItem[],
  options: { readonly query: string; readonly needsOnly: boolean; readonly assignee: string | null },
  needsYouIds: ReadonlySet<string>,
): readonly TaskBoardItem[] {
  const needle = options.query.trim().toLowerCase()
  return tasks.filter((task) => {
    if (needle.length > 0 && !task.title.toLowerCase().includes(needle) && !task.id.toLowerCase().includes(needle)) return false
    if (options.needsOnly && !needsYouIds.has(task.id)) return false
    if (options.assignee !== null && task.assigneeName !== options.assignee) return false
    return true
  })
}
```

Create `apps/web/src/components/TaskList.tsx`:

```tsx
'use client'

import { USER_TASK_LABEL, userTaskStatus } from '@slave-of-ai/domain'
import { priorityChip } from '../lib/taskColumns'
import type { TaskBoardItem } from '../server/tasks'

/** The README's list view: `70px 120px 1fr 120px 60px`, a mono header at 11px/.06em, one row per
 *  task. The same rows the board draws, in one column instead of five — for the day somebody wants
 *  to read the whole board rather than look at it. */
export function TaskList({
  tasks,
  onSelect,
}: {
  readonly tasks: readonly TaskBoardItem[]
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="px-[24px] pb-[24px] pt-4">
      <div data-testid="task-list" className="overflow-hidden rounded-panel-card border border-line bg-card text-[13.5px]">
        <div className="grid grid-cols-[70px_120px_minmax(0,1fr)_120px_60px] gap-3 border-b border-line px-4 py-[9px] font-mono text-[11px] font-semibold uppercase tracking-[.06em] text-t3">
          <span>ID</span>
          <span>Status</span>
          <span>Title</span>
          <span>Assignee</span>
          <span>Pri</span>
        </div>
        {tasks.map((task) => {
          const word = userTaskStatus({ status: task.status, integrated: task.integratedAt != null })
          const priority = priorityChip(task.priority)
          return (
            <button
              key={task.id}
              type="button"
              data-testid="task-list-row"
              data-task-id={task.id}
              data-status={task.status}
              onClick={() => onSelect(task.id)}
              className="grid w-full grid-cols-[70px_120px_minmax(0,1fr)_120px_60px] items-center gap-3 border-b border-line px-4 py-[10px] text-left last:border-b-0 hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
            >
              <span className="truncate font-mono text-[12px] font-medium text-t3">{task.id.slice(0, 8)}</span>
              {/* The DOMAIN's word, with the raw status one attribute away (`docs/ia.md` rule 3). */}
              <span title={task.status} className="truncate font-mono text-[11px] font-medium tracking-[.04em] text-t2">
                {USER_TASK_LABEL[word.state]}
              </span>
              <span className="truncate font-medium text-t1">{task.title}</span>
              <span className="truncate text-t2">{task.assigneeName ?? '—'}</span>
              <span className="font-mono text-[11.5px] font-medium text-t3">{priority.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
```

*(`task.integratedAt` — check whether `TaskBoardItem` carries it; `grep -n integratedAt apps/web/src/server/tasks.ts`. If it does not, pass `integrated: false` and say so in a comment, which is what the board's own card already does.)*

- [ ] **Step 6: Wire the board**

In `apps/web/src/components/TasksClient.tsx`:
- add `const [query, setQuery] = useState('')`, `const [needsOnly, setNeedsOnly] = useState(false)`,
  `const [assignee, setAssignee] = useState<string | null>(null)`, `const [view, setView] = useState<'board' | 'list'>('board')`;
- **rename the existing `view` local to `snapshotView` FIRST**, so the new `view` state does not
  shadow it, and use that one name everywhere below — `tsc` finds every remaining use;
- derive `const needsYouIds = useMemo(() => new Set(snapshotView.tasks.filter((task) => userTaskStatus({ status: task.status }).needsYou).map((task) => task.id)), [snapshotView.tasks])`;
- derive `const visible = filterTasks(snapshotView.tasks, { query, needsOnly, assignee }, needsYouIds)`;
- derive `const assignees = [...new Set(snapshotView.tasks.map((t) => t.assigneeName).filter((n): n is string => n !== null))].sort()`;
- render `<TaskFilters …/>` above the board;
- change the grid to the README's five: replace `className="grid grid-cols-6 gap-[10px] p-[16px]"` with
  `className="grid gap-3 overflow-x-auto p-[16px_24px_24px] [grid-template-columns:repeat(5,minmax(172px,1fr))] items-start"`;
- feed the columns `visible` instead of `view.tasks`;
- render `<TaskList tasks={visible} onSelect={setSelectedId} />` instead of the board when `view === 'list'`.

In `apps/web/src/components/TaskColumn.tsx`, keep every testid (`column`, `column-dot-<column>`,
`column-count-<column>`) and change only the head's type. **Those last two are built by
interpolation, so the rename changes their VALUES**: `column-dot-In Progress` becomes
`column-dot-In progress` and likewise for the count (scan finding 45). `tasks-components.test.tsx:874`
pins the old spelling and is in this task's Files list; `graph-exec.test.ts:126` pins the same
lower-case change on a different node (Step 4b). No gate reads either. the `<h2>` becomes
`className="text-[13px] font-semibold text-t1"` with the dot at `h-[7px] w-[7px]` and the count
`font-mono text-[11.5px] font-medium text-t3` — the README's numbers. Add the empty state:

```tsx
        {tasks.length === 0 && (
          <p data-testid="column-empty" className="rounded-tile-lg border border-dashed border-line2 p-[14px] text-center text-[12.5px] text-t3">
            Nothing here
          </p>
        )}
```

In `apps/web/src/components/TaskCard.tsx`, change only class strings and one label: the outer
element takes `rounded-tile-lg border bg-card p-[11px_12px] gap-[7px]`, blocked cards take
`border-[color-mix(in_oklab,var(--s-blocked)_45%,var(--line))]`, integrated cards take
`opacity-[.85]`, and **the status word rendered on the card becomes `USER_TASK_LABEL[userTaskStatus(...).state]`** if it is not already
(`grep -n "USER_TASK_LABEL\|taskStatusWord" apps/web/src/components/TaskCard.tsx`). Every testid on
that file is kept verbatim.

- [ ] **Step 7: Restyle Team and Knowledge**

These two pages keep every component, every read model and every testid; only class strings change,
plus the Team page's H1.

**`apps/web/src/components/organization/OrganizationClient.tsx`** (nested, not top-level — scan
finding 15) — find its title (`grep -n "SectionLabel\|<h1" apps/web/src/components/organization/OrganizationClient.tsx`) and change the visible word to `Team`, with the
sub-line `{n} workers on {project} · why they are here and what they are doing`. **The route, the
testids (`organization-rows`, `organization-row-*`, `organization-kind-*`, `organization-why-*`,
`organization-doing-*`, `capability-chip`, `organization-needs`, `organization-need-*`,
`organization-unfillable`, `organization-hint`) and the component name do not change** — four gates
read them. Then apply the README's card recipe to whatever element carries `organization-row-*`:
`rounded-panel-card border border-line bg-card p-[14px_16px] gap-[10px] shadow-card`, name at
`font-semibold text-t1`, role · provider at `text-[12px] text-t3`, capability chips at
`rounded-pill border border-line2 px-2 py-[2px] text-[12px] text-t2`.

**`apps/web/src/components/knowledge/KnowledgeClient.tsx`** (nested, not top-level — scan finding
15) — the All / Verified · n / Candidates · n control becomes `<Segmented …/>` (M57 R21; the draft
told an implementer to copy `TaskFilters`' recipe, which is the duplication the primitive exists to
prevent). **Grep the file for its existing filter testids first and pass whichever prefix reproduces
them**, so nothing a test or a gate names moves. The row grid becomes
`grid-cols-[110px_minmax(0,1fr)_190px] gap-[14px] px-4 py-3 border-b border-line`. Keep
`knowledge-counts`, `knowledge-rows` and every other testid in the file verbatim.

- [ ] **Step 8: Run the tests, the gates, the build, the ladder, and commit**

```bash
npx vitest run apps/web/test/taskColumns.test.ts apps/web/test/tasks-components.test.tsx \
  apps/web/test/organization-page.test.tsx apps/web/test/knowledge-page.test.tsx
npx vitest run 2>&1 | tail -20
pgrep -af vitest || echo "no vitest running"
for g in m45-project-experience m47-team-formation m49-memory; do
  echo "=== $g ==="; npm run "gate:$g" 2>&1 | tail -12; echo "exit=${PIPESTATUS[0]}"
done
pgrep -af "next dev" || echo "no dev server"
npm run web:build 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"
npm run gate:m26-vocabulary && npx tsc --build && npm run --silent typecheck
git add -A
git commit -m "$(cat <<'MSG'
feat(m57): t7 — five columns, and a list for the day you want to read the board

Backlog and Todo fold into Queued, which is the same collapse the domain's own word for
a task already made; the card's pill is `USER_TASK_LABEL` now and the column is a phase.
The `Record<TaskStatus, BoardColumn>` stays total, which is the part that matters: a
fourteenth status is a build failure, not an invisible task. A search box, a Needs-you
toggle and assignee chips filter the snapshot the page already holds -- no query, no
route. Team and Knowledge keep every row, every read and every testid, and get the
handoff's surfaces.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tb1HCWnBqh63E9diBxdxR6
MSG
)"
```

---

### Task 8: The four that are left — Activity, project Settings, Workforce, Simulations, and Appearance (R13, R15, README's remaining screens)

**Files:**
- Modify: `apps/web/src/components/activity/ActivityClient.tsx` and its `FilterBar.tsx` (class strings + the `200px 1fr` split)
- Modify: `apps/web/src/components/project/ProjectSettingsClient.tsx` (the `180px minmax(0,760px)` grid + the sticky in-page nav)
- Modify: `apps/web/src/components/workforce/WorkforceClient.tsx` (six tabs → four visible, six `?tab=` values)
- Modify: `apps/web/src/components/sim/SimulationsClient.tsx` (nested, not top-level — dashed cards; `§` is already the rule)
- Modify: `apps/web/src/components/SettingsClient.tsx` (the Appearance section)
- Modify: `apps/web/test/workforce-page.test.tsx`, `apps/web/test/settings-page.test.tsx`, `apps/web/test/activity-page.test.tsx`, **`apps/web/test/simulations-page.test.tsx`** (plural — the singular `simulation-page.test.tsx` tests `SimulationClient`, the DETAIL page, which this task does not touch; scan finding 16)
- **Re-point every hit** of `workforce-tab-departments` / `workforce-tab-runbooks` found by Step 3's grep — at `c828f8c8` those are `scripts/gate-m11-shell.mjs`, `scripts/gate-m14-fidelity.mjs`, `scripts/gate-m48-runbooks.mjs` and `apps/web/test/workforce-page.test.tsx`

**Interfaces:**
- Consumes from Task 1: `useTheme`, `THEME_LABEL`, `ThemeChoice`. From Task 3: `useHeaderAction`.
- Produces, for Task 9: testids `appearance-theme` and `appearance-theme-<mode>` (one per option). **Every existing `workforce-tab-*` is preserved verbatim** — the two folded tabs keep their testids on the segments that replace them, which is why no gate script changes for this page.

**What this task must NOT restyle** (spec §6's surviving deviation 1, here so an implementer does
not reach for it): `AllSlavesTable`'s `grid-template-columns` string — `gate:m14-fidelity` asserts it
twice, by two different methods, and the README's seven-column sketch drops the lifecycle column M50
added and the cost column M53 reads, so reconciling the two is a data question and not a styling one.
**`RunbookPanel` is also left alone**, for a different and narrower reason: Task 6 Step 7f keeps it
as its own section with its eleven `gate:m48-runbooks` testids, and the README's "one line" about a
runbook is the SUMMARY that Task 6 put in the Overview's Supervisor tile.

- [ ] **Step 1: Write the failing test for Workforce's four tabs**

Add to `apps/web/test/workforce-page.test.tsx`:

```tsx
  it('shows FOUR tabs and keeps all six ?tab= values (M57 R13)', () => {
    // …render WorkforceClient with tab="slaves"…
    const tabs = screen.getAllByTestId(/^workforce-tab-/)
    expect(tabs.map((tab) => tab.getAttribute('data-testid'))).toEqual([
      'workforce-tab-slaves', 'workforce-tab-catalog', 'workforce-tab-skills', 'workforce-tab-evidence',
    ])
    expect(tabs.map((tab) => tab.textContent)).toEqual(['People', 'Catalog', 'Skills & runbooks', 'Evidence'])
  })

  it('folds Departments into People as a segment with its own testid (spec erratum E15)', () => {
    // …render with tab="slaves"…
    const sub = screen.getByTestId('workforce-segment-departments')
    expect(sub.getAttribute('href')).toContain('tab=departments')
    // The Slaves table is what People opens on.
    expect(screen.getByTestId('data-table')).toBeTruthy()
    // And `workforce-tab-slaves` appears exactly ONCE -- the visible tab, not the segment too.
    expect(screen.getAllByTestId('workforce-tab-slaves')).toHaveLength(1)
  })

  it('folds Runbooks into Skills & runbooks as a segment with its own testid', () => {
    // …render with tab="skills"…
    expect(screen.getByTestId('workforce-segment-runbooks').getAttribute('href')).toContain('tab=runbooks')
    expect(screen.getAllByTestId('workforce-tab-skills')).toHaveLength(1)
  })
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run apps/web/test/workforce-page.test.tsx
```

Expected: FAIL — six tabs are found where four were expected.

- [ ] **Step 3: Fold Workforce's six tabs into four**

In `apps/web/src/components/workforce/WorkforceClient.tsx`, **keep `WorkforceTab` and its six
values exactly as they are** — they are the `?tab=` vocabulary, `docs/ia.md` names them, four gates
navigate by them and `next.config.ts` redirects `/skills` into one. Replace `WORKFORCE_TABS` with a
four-entry visible list plus a sub-segment table:

```ts
/** The FOUR visible tabs (M57 R13). `id` is still a `WorkforceTab`, so `Tabs`' own
 *  `workforce-tab-<id>` testids are byte-identical to the six-tab strip's first, third, fourth and
 *  sixth — which is what lets `gate:m11-shell`, `gate:m14-fidelity` and `gate:m44-ux-foundation`
 *  carry over with no edit at all. Only the LABELS move. */
export const WORKFORCE_TABS: readonly { readonly id: WorkforceTab; readonly label: string }[] = [
  { id: 'slaves', label: 'People' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'skills', label: 'Skills & runbooks' },
  { id: 'evidence', label: 'Evidence' },
]

/**
 * The two tabs that folded, as SEGMENTS inside their new parent — with their OWN testid namespace
 * (spec erratum E15).
 *
 * The draft of this plan kept `workforce-tab-<id>` on these, on the theory that a gate clicking
 * `workforce-tab-departments` would then keep working. It does not: `SUB_TABS.slaves` contains
 * `{id:'slaves'}` and `SUB_TABS.skills` contains `{id:'skills'}`, so on `?tab=slaves` the page
 * would render `workforce-tab-slaves` TWICE — once as the visible People tab and once as the
 * segment — which breaks this task's own four-tab assertion and puts `gate-m11-shell`'s
 * unqualified `getByTestId('workforce-tab-slaves')` into Playwright strict-mode failure.
 *
 * `workforce-segment-<id>` for all four. Every `?tab=` value still works, every bookmark still
 * lands, and the four gate/test hits on the two old names are re-pointed in this task.
 */
const SUB_TABS: Record<string, readonly { readonly id: WorkforceTab; readonly label: string }[]> = {
  slaves: [
    { id: 'slaves', label: 'Slaves' },
    { id: 'departments', label: 'Departments' },
  ],
  skills: [
    { id: 'skills', label: 'Skills' },
    { id: 'runbooks', label: 'Runbooks' },
  ],
}
```

…then: the visible tab for the current `tab` is `tab === 'departments' ? 'slaves' : tab === 'runbooks' ? 'skills' : tab`;
the sub-segment row renders under the tab strip whenever `SUB_TABS[visibleTab]` exists, as `<Link>`s
carrying `data-testid={`workforce-segment-${sub.id}`}` and `href={`/workforce?tab=${sub.id}`}`; and
the six `{tab === '…' && <Panel/>}` lines below are unchanged.

**Then re-point the four places that name the old testids** (spec erratum E15). Find them first:

```bash
grep -rn "workforce-tab-departments\|workforce-tab-runbooks" scripts apps/web/test apps/web/src
```

At `c828f8c8` that is `scripts/gate-m11-shell.mjs` and `scripts/gate-m14-fidelity.mjs` (both click
`workforce-tab-departments` to reach the Departments table), `scripts/gate-m48-runbooks.mjs` (clicks
`workforce-tab-runbooks`) and `apps/web/test/workforce-page.test.tsx`. Change each to
`workforce-segment-departments` / `workforce-segment-runbooks`; the hrefs and the `?tab=` values
they navigate to do not change, so nothing else in any of those three gates moves. **This is the one
claim R12 made that the pre-flight scan withdrew** — "no gate script changes for this page" is now
"three gate scripts change one string each", and that is still the smallest edit available.

- [ ] **Step 4: Run it and watch it pass, then run the four gates that navigate this page**

```bash
npx vitest run apps/web/test/workforce-page.test.tsx
pgrep -af vitest || echo "no vitest running"
for g in m11-shell m44-ux-foundation m48-runbooks m55-catalog; do
  echo "=== $g ==="; npm run "gate:$g" 2>&1 | tail -10; echo "exit=${PIPESTATUS[0]}"
done
```

Expected: PASS and `exit=0` four times, **after the three one-string gate edits Step 3 names**. R12's
original claim — "no gate script changes for this page" — was withdrawn by the pre-flight scan
(spec erratum E15); what survives of it is that no gate's LOGIC changes, no route changes and no
`?tab=` value changes.

- [ ] **Step 5: Add Appearance to the global Settings page**

In `apps/web/src/components/SettingsClient.tsx`, insert a section between the provider-adapter cards
and Security:

```tsx
      <section className="flex flex-col gap-3 rounded-page-card border border-line bg-card p-[18px_20px]">
        <h2 className="m-0 text-[15px] font-semibold text-t1">Appearance</h2>
        <div className="flex items-center justify-between gap-4 text-[13.5px]">
          <div>
            <div className="font-medium text-t1">Theme</div>
            <div className="text-[12.5px] text-t3">&quot;System&quot; follows your computer.</div>
          </div>
          {/* `ui/Segmented` (M57 R21), not a fourth copy of the same nine class strings. Its own
            * markup emits `appearance-theme` on the group and `appearance-theme-<id>` on each
            * button, which is exactly what spec §3 lists. `data-theme-mode` rides alongside
            * `Segmented`'s `data-value` because the gate reads it by that name. */}
          <span data-theme-mode={theme}>
            <Segmented
              options={[
                { id: 'system', label: THEME_LABEL.system },
                { id: 'light', label: THEME_LABEL.light },
                { id: 'dark', label: THEME_LABEL.dark },
              ]}
              value={theme}
              onChange={setTheme}
              ariaLabel="Theme"
              testIdPrefix="appearance-theme"
            />
          </span>
        </div>
      </section>
```

…with `const { theme, setTheme } = useTheme()` and three imports (`useTheme`, `THEME_LABEL`,
`Segmented`). The component must be a client component already (it holds the reseed controls); check
its `'use client'` line first. `data-theme-mode` is on a wrapper because `Segmented` owns the group
element and its own `data-value`; the gate's stage 1 reads `appearance-theme`'s `data-theme-mode`,
so put the wrapper's testid nowhere and let `Segmented`'s own `appearance-theme` sit inside it —
**or** give the wrapper the attribute and have the gate read
`[data-testid="appearance-theme"]`'s `data-value` instead. Pick one and make the gate agree.

Add to `apps/web/test/settings-page.test.tsx`:

```tsx
  it('offers the three theme choices and stamps the one that is chosen', () => {
    // …render SettingsClient inside <ThemeProvider>…
    expect(screen.getByTestId('appearance-theme').getAttribute('data-theme-mode')).toBe('system')
    act((): void => { screen.getByTestId('appearance-theme-dark').click() })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(screen.getByTestId('appearance-theme').getAttribute('data-theme-mode')).toBe('dark')
  })
```

…and the same `matchMedia` stub `apps/web/test/theme.test.tsx` installs (copy its `installMatchMedia`
into this file's `beforeEach`; jsdom has none, and `ThemeProvider` calls it).

- [ ] **Step 6: Restyle Activity, project Settings and Simulations**

Class strings only. No testid in any of these three files changes, and no read model is touched.

**`apps/web/src/components/activity/ActivityClient.tsx`** — the page becomes the README's
`200px 1fr`: wrap the existing family rail and the existing river in
`<div className="grid grid-cols-[200px_minmax(0,1fr)] items-start gap-5 px-[24px] py-5">`. Each
family row gets the 56 × 4 px volume bar the README draws, from the `typeVolumes` the page already
has; the selected row takes `bg-sel`. The river's card becomes
`rounded-panel-card border border-line bg-card`, its rows
`grid-cols-[64px_14px_minmax(0,1fr)_auto] gap-3 px-4 py-[11px] border-b border-line`, its time
column `font-mono text-[12px] text-t3`, and its ref chip
`rounded-chip border border-line2 px-[7px] py-[2px] font-mono text-[11.5px] font-medium text-t2`.
The `▸ payload` disclosure and its `<pre>` (`bg-bg border border-line font-mono text-[11.5px]/1.5`)
already exist — restyle, do not rebuild. **`data-event-type` and the `title` stay on every row**
(`docs/ia.md` rule 3, and `gate:m44` stage 4 reads them).

**`apps/web/src/components/project/ProjectSettingsClient.tsx`** — the page becomes
`<div className="grid grid-cols-[180px_minmax(0,760px)] items-start gap-7 px-[24px] py-[22px]">`
with a sticky in-page nav in the first column (four plain anchors to `#goal`, `#runtime`,
`#permissions`, `#danger`, the last in `text-s-blocked`, the wrapper `sticky top-0`) and the four
existing sections in the second, each `rounded-page-card border border-line bg-card p-[18px_20px]`
and each given the matching `id`. The danger section's border becomes
`border-[color-mix(in_oklab,var(--s-blocked)_40%,var(--line))]`. **`perm-caption`,
`runtime-timeout`, `runtime-concurrency`, `runtime-attempts`, `goal-input`, `goal-submit`,
`goal-error`, `archive-project`, `archive-project-confirm` and every `perm-*` testid are kept
verbatim** — `gate:m11-shell` and `gate:m14-fidelity` read four of them, and `gate:m52-broker` reads
the permission matrix.

**`apps/web/src/components/sim/SimulationsClient.tsx`** (nested, not top-level — scan finding 15) — the banner and the cards take the README's
dashed border (`border border-dashed border-line2 rounded-page-card`), which IS the "not real" cue,
and the three stat tiles become a `grid-cols-3 gap-px bg-line` strip inside a `rounded-panel
border border-line` wrapper. **`data-simulation="true"` stays on every block that renders money and
the currency stays `§`** (`docs/ia.md` rule 4; `gate:m44` stage 8 scans for a `$` inside a
`data-simulation` container and this task must not give it one).

- [ ] **Step 7: Suite, every gate that touches these four pages, build, ladder and commit**

```bash
npx vitest run 2>&1 | tail -20
pgrep -af vitest || echo "no vitest running"
# m52 is here because Task 4 edited a COMMENT in it (the one that explained a scoped locator by
# naming the Overview's `Advanced` disclosure) and because its scoped locator has to keep resolving
# now that the disclosure is gone -- a comment edit is not a behaviour change, and this is where
# that is proved rather than assumed.
for g in m11-shell m18-skill-and-teeth m29-simulation m30-simulation-compare m44-ux-foundation m48-runbooks m52-broker m53-evidence m55-catalog; do
  echo "=== $g ==="; npm run "gate:$g" 2>&1 | tail -10; echo "exit=${PIPESTATUS[0]}"
done
pgrep -af "next dev" || echo "no dev server"
npm run web:build 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"
npm run gate:m26-vocabulary && npx tsc --build && npm run --silent typecheck
git add -A
git commit -m "$(cat <<'MSG'
feat(m57): t8 — the four that were left, and a theme you can choose in Settings

Workforce shows four tabs and still answers all six `?tab=` values -- People and Skills
& runbooks each carry the folded tab as a segment, with the testid it had as a tab, so
four gate scripts navigate this page unchanged and every bookmark still lands. Activity
becomes the handoff's rail and river, project Settings its sticky four sections,
Simulations its dashed cards with `§` where money goes. Appearance is three buttons and
the same provider the sidebar pill drives.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tb1HCWnBqh63E9diBxdxR6
MSG
)"
```

---

### Task 9: `docs/ia.md`, CI's 32nd gate, and the thirteen pictures (R16, §4, §5, E9)

**Files:**
- Create: `scripts/gate-m57-ui-redesign.mjs`
- Modify: `docs/ia.md` (rewritten per spec §4)
- Modify: `package.json` (one script line, after `gate:m56a-provider-contract`)
- Modify: `.github/workflows/ci.yml` (one step, after `gate:m56a-provider-contract`)
- Modify: `README.md` (the roster sentence and the count line, 31 → 32)
- Modify: `scripts/gate-m14-fidelity.mjs` (the `NUMBERS` table)
- Modify: `docs/superpowers/fidelity/m14/*.png` (13 files, regenerated ONCE)
- Modify: `docs/superpowers/specs/2026-09-14-m57-ui-redesign-design.md` (§7 errata)

**Interfaces:**
- Consumes: everything Tasks 1–8 produced. Produces: nothing any task reads.

- [ ] **Step 1: Rewrite `docs/ia.md`**

Keep the file's **four rules verbatim** — they are the contract M58+ reads — and its five per-surface
tables. Change these six things, and nothing else:

1. **The "Top-level navigation" table** becomes the tree:

```markdown
## Top-level navigation

The sidebar is one tree (M57 R5). Its root is Projects; under it is one row per project; under the
OPEN project are its six sections and a `VIEWS` group. Below the tree are the three destinations
that are not a project.

| Entry | Route | The question it answers |
|---|---|---|
| Projects | `/` | What am I building, and what needs me? |
| … a project | `/w/:id` | (its six sections, below) |
| Workforce | `/workforce` | Who works here, and what can they do? |
| Simulations | `/sim` | What would a company like this do? |
| Settings | `/settings` | How is this installation set up? |

| A project's row | Route | Label |
|---|---|---|
| Overview | `/w/:id` | Overview |
| Tasks | `/w/:id/tasks` | Tasks |
| Organization | `/w/:id/organization` | **Team** |
| Knowledge | `/w/:id/knowledge` | Knowledge |
| Activity | `/w/:id/activity` | Activity |
| Settings | `/w/:id/settings` | Settings |
| `VIEWS` chips | `/w/:id/graph`, `/w/:id/office`, `/analytics?workspace=:id` | Graph · Office · Analytics |

`ProjectTabs`' six-tab strip and its `Advanced ▾` menu are gone as WIDGETS in M57. Rule 2 is about
destinations and every one of them is above, at the URL it always had — the six tabs are the six
section rows and `Advanced ▾`'s three items are the `VIEWS` chips, visible instead of behind a
menu. `Team` is a LABEL change only: the route, the component and every `organization-*` testid are
untouched, because "Organization" was the graph mode's word for a diagram and this page is about
people.
```

2. **A new "The header" section**, after that:

```markdown
## The header

54 px, on every page, mounted by the ROOT layout (M57 R7): a breadcrumb `Projects / <project> /
<section>`, a HALTED pill while the project is halted, the budget `$x / $y` beside a 100 × 5 px bar,
and one split button — `Pause all | Stop ▾`, where `Stop ▾` arms on the first click and fires on the
second, and reads `Clear halt` while the project is halted. A page contributes its own primary
action (`+ New project`, `+ New slave`, `+ New simulation`) into the header's slot.

`Pause all` and `Resume all` are the web's own fan-outs over verbs that already existed — the first
is `pauseActiveRuns`, which an emergency stop has always used; the second is a loop over the same
per-run `requestResume` a single worker's Resume button calls. `Clear halt` is `clearHalt`, which
until M57 was two columns written inline in the CLI's own `clear-halt` case and had no web route at
all. None of the three adds an event type.

The live/latency chip that used to sit here is the sidebar's footer now, beside the theme pill.
```

3. **A new "The right panel" section**:

```markdown
## The right panel

372 px on every `/w/:id/*` route, collapsing to a 52 px dock; absent on every global route (M57 R8).
Its default content is the **Supervisor**, which is a conversation over events that already exist: a
thread is one local calendar day of this project's `workspace.goal_set` (the operator's own typed
words, which M45 put on the payload) and `supervisor.*` rows, its decision cards are the same
pending list the Overview's Needs-you card reads, and its composer is the same
`POST /api/w/:id/goal/request` the M45 request box posted to. There is no conversation table and no
new event type.

`SlavePanel` and `TaskDetailPanel` render in the SAME slot while one is selected, replacing the
Supervisor and handing it back on close. `?slave=` and `?task=` are still the source of truth and
still what a refresh restores. The dock's `S` button carries the pending-decision count, which is
why the dock exists at all: a person who collapsed the panel still has to be told when something is
waiting on them.
```

4. **The "Panels that stay where they are, deliberately" paragraph** — replace its first sentence
   with: *"`SlavePanel`, `GraphDrawer` and `TaskDetailPanel` are persistent side panels, not modals:
   they do not close on Escape and do not trap focus, because a person reads them while working in
   the page behind them. Since M57 the first two of those render inside the shell's right-panel slot
   rather than as their own fixed asides — the placement moved, the non-modality did not."* Keep
   every other sentence in that section.

5. **The Tasks-board line** — replace *"The Tasks board's pill keeps its board vocabulary in M44.
   `userTaskStatus` is the domain's task word and is wired to one thing here — the 'needs you' count
   on a project card."* with: *"M57 closed this: the board is five columns (Queued / In progress /
   Review / Blocked / Done), the columns are phases and the card's pill is `USER_TASK_LABEL` — the
   domain's own word — so there is one task vocabulary and not two. `COLUMN_FOR_STATUS` stays a
   total `Record<TaskStatus, BoardColumn>`, which is what makes a fourteenth status a build failure
   rather than an invisible task."*

6. **The Overview `Advanced ▾` paragraph** — replace it with: *"The Overview's own `Advanced ▾` is
   gone in M57 and each of its four panels has a home: the Supervisor panel is the RIGHT PANEL on
   every project page, `blocked · needs you` is the Overview's own **Needs you** card (which shows
   all four kinds `buildNeedsYou` finds, not one), and the live-events river and the merge queue are
   under **Recent changes** on the same page, with `/w/:id/activity` still the whole river."*

Also add one line to the `/w/:id/graph` and `/w/:id/office` rows' "Later" column: *"M57 re-homed it
from the `Advanced ▾` menu to the sidebar's `VIEWS` chips; the route and all five modes are
unchanged"*; and one to `/workforce`'s: *"M57 shows four tabs — People, Catalog, Skills & runbooks,
Evidence — and keeps all six `?tab=` values, the two folded ones as segments inside their new
parent."* Finally, **ADD** a responsive line — there is none to replace (scan finding 32:
`grep -n "responsive\|899\|collapse\|icon rail" docs/ia.md` returns nothing, because M44 recorded
its 899 px collapse in its own spec and never in the IA contract, and spec R4's claim that the line
"is rewritten" was wrong). Put it at the end of the new **The header** section: *"**One width.** The
frame has a 1280 px minimum and no breakpoints. M44's sidebar collapsed to a 52 px icon rail below
899 px; M57 removed that with `Sidebar.tsx`, because this is a desktop operator console and the
handoff states a floor rather than a breakpoint. Below 1280 px the page scrolls horizontally rather
than rearranging."*

Then:

```bash
npm run gate:m26-vocabulary
```

Expected: exit 0. `docs/ia.md` is inside that gate's scope.

- [ ] **Step 2: Write the gate**

Create `scripts/gate-m57-ui-redesign.mjs`. **Copy `scripts/gate-m44-ux-foundation.mjs`'s first
~180 lines verbatim** — the header comment (rewritten for this milestone's ten stages), the imports,
the preflight that refuses to start unless `SLAVEOFAI_CLAUDE_BIN` points under `scripts/gate-fakes/`
and `SLAVEOFAI_REQUIRE_FAKE_CLI=1`, `freePort`, `startNext`, `gotoReliably`, `waitVisible`,
`waitUntil`, `clickUntil`, `fail`, and the fixture-seed/`finally`-cleanup skeleton — and then write
the ten stages below. The fixtures it needs: two workspaces (so the tree has rows to order), a
pending `SupervisorDecision`, a blocked `Task`, one task in each of the five columns' statuses, and
two `workspace.goal_set` events with a `request`, one of them backdated a day.

```js
  // ============================================================================================
  // The status -> column table, RE-DECLARED (scan finding 7).
  //
  // This gate cannot import `lib/taskColumns.ts`: `apps/web` compiles with `noEmit: true` under a
  // bundler resolver, so there is no built output for a plain `node` script to load. That is the
  // constraint `apps/web/test/integration/gate-surface-parity.test.ts:18-21` was written to
  // document, and this is the same answer M41 gave -- the gate states the fact it asserts, in its
  // own words, and a vitest case PINS the two together so the copy cannot drift (Step 2b).
  // ============================================================================================
  const GATE_COLUMN_FOR_STATUS = {
    backlog: 'Queued',
    ready: 'Queued',
    rework: 'Queued',
    assigned: 'Queued',
    running: 'In progress',
    verifying: 'In progress',
    waiting: 'In progress',
    reviewing: 'Review',
    merging: 'Review',
    blocked: 'Blocked',
    done: 'Done',
    failed: 'Done',
    cancelled: 'Done',
  }

  // ============================================================================================
  // Stage 1: the theme, which is the one thing a person notices on every single page load.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/`)
  const first = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    stored: (() => { try { return localStorage.getItem('theme') } catch { return 'THREW' } })(),
    background: window.getComputedStyle(document.body).backgroundColor,
  }))
  console.log(`stage 1: first visit = ${JSON.stringify(first)}`)
  if (first.attr !== null) await fail(`stage 1: a first visit stamped data-theme=${JSON.stringify(first.attr)}; absent IS system (R2)`)
  if (first.stored !== null) await fail(`stage 1: a first visit wrote localStorage.theme=${JSON.stringify(first.stored)}; it must write nothing until somebody chooses`)

  await clickUntil(page.getByTestId('theme-toggle'), async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light', 'the theme pill (to Light)')
  const light = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)
  await clickUntil(page.getByTestId('theme-toggle'), async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'dark', 'the theme pill (to Dark)')
  const dark = await page.evaluate(() => window.getComputedStyle(document.body).backgroundColor)
  console.log(`stage 1: light body background = ${light}, dark = ${dark}`)
  if (light === dark) await fail(`stage 1: light and dark paint the same body background (${light}) -- the palette is not switching`)

  await gotoReliably(`${baseUrl}/`)
  const afterReload = await page.evaluate(() => ({
    attr: document.documentElement.getAttribute('data-theme'),
    stored: (() => { try { return localStorage.getItem('theme') } catch { return 'THREW' } })(),
  }))
  console.log(`stage 1: after a reload = ${JSON.stringify(afterReload)}`)
  if (afterReload.attr !== 'dark' || afterReload.stored !== 'dark') {
    await fail(`stage 1: the choice did not survive a reload (${JSON.stringify(afterReload)})`)
  }
  // Back to system, so the remaining stages measure the default the screenshots are taken in.
  await clickUntil(page.getByTestId('theme-toggle'), async () => (await page.evaluate(() => document.documentElement.getAttribute('data-theme'))) === null, 'the theme pill (back to System)')
  console.log('stage 1 PASSED: absent is system, the pill cycles, the palette moves, and the choice survives a reload')

  // ============================================================================================
  // Stage 2: the sidebar tree, against the database rather than against itself.
  // ============================================================================================
  const dbProjects = await prisma.workspace.findMany({ where: { archivedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  const treeRows = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="sidebar-project"]')].map((row) => ({
      id: row.getAttribute('data-project-id'),
      status: row.getAttribute('data-status'),
      needs: row.querySelector('[data-testid="sidebar-needs-you"]')?.textContent?.trim() ?? null,
    })),
  )
  console.log(`stage 2: tree rows = ${JSON.stringify(treeRows)}`)
  if (JSON.stringify(treeRows.map((row) => row.id)) !== JSON.stringify(dbProjects.map((row) => row.id))) {
    await fail(`stage 2: the tree lists ${JSON.stringify(treeRows.map((r) => r.id))}, the database has ${JSON.stringify(dbProjects.map((r) => r.id))}`)
  }
  const seeded = treeRows.find((row) => row.id === workspaceId)
  if (seeded === undefined || seeded.needs === null || !/^\d+$/.test(seeded.needs) || Number(seeded.needs) < 1) {
    await fail(`stage 2: the seeded project has a pending decision and a blocked task, and its needs-you count reads ${JSON.stringify(seeded?.needs)}`)
  }
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  const sections = await page.evaluate(() => [...document.querySelectorAll('[data-testid="sidebar-section"]')].map((row) => row.getAttribute('data-section')))
  if (JSON.stringify(sections) !== JSON.stringify(['overview', 'tasks', 'organization', 'knowledge', 'activity', 'settings'])) {
    await fail(`stage 2: the open project's sections are ${JSON.stringify(sections)}`)
  }
  const otherId = dbProjects.find((row) => row.id !== workspaceId)?.id ?? null
  if (otherId !== null) {
    const nested = await page.evaluate((id) => document.querySelector(`[data-project-id="${id}"] [data-testid="sidebar-section"]`) !== null, otherId)
    if (nested) await fail('stage 2: a project that is not open nested its sections -- only the current one does')
  }
  console.log('stage 2 PASSED: the tree is the database, the count is real, and only the open project nests')

  // ============================================================================================
  // Stage 3: the breadcrumb, on every route the tree can reach.
  // ============================================================================================
  const CRUMBS = [
    ['/', 'Projects'],
    ['/workforce', 'Workforce'],
    ['/settings', 'Settings'],
    ['/sim', 'Simulations'],
    [`/w/${workspaceId}`, `Projects/${workspaceName}`],
    [`/w/${workspaceId}/tasks`, `Projects/${workspaceName}/Tasks`],
    [`/w/${workspaceId}/organization`, `Projects/${workspaceName}/Team`],
    [`/w/${workspaceId}/knowledge`, `Projects/${workspaceName}/Knowledge`],
    [`/w/${workspaceId}/activity`, `Projects/${workspaceName}/Activity`],
    [`/w/${workspaceId}/settings`, `Projects/${workspaceName}/Settings`],
    [`/w/${workspaceId}/graph`, `Projects/${workspaceName}/Graph`],
    [`/w/${workspaceId}/office`, `Projects/${workspaceName}/Office`],
  ]
  for (const [path, expected] of CRUMBS) {
    await gotoReliably(`${baseUrl}${path}`)
    await waitVisible(page.getByTestId('breadcrumb'), `the breadcrumb on ${path}`)
    const actual = await page.evaluate(() => document.querySelector('[data-testid="breadcrumb"]')?.getAttribute('data-crumbs') ?? null)
    console.log(`stage 3: ${path} -> ${JSON.stringify(actual)}`)
    if (actual !== expected) await fail(`stage 3: ${path} reads ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
  console.log('stage 3 PASSED: twelve routes, twelve breadcrumbs')

  // ============================================================================================
  // Stage 4: the right panel, its three modes, and the dock.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('right-panel'), 'the right panel on the Overview')
  if ((await page.getByTestId('right-panel').getAttribute('data-mode')) !== 'supervisor') {
    await fail('stage 4: the default content on a project route is not the Supervisor')
  }
  await gotoReliably(`${baseUrl}/w/${workspaceId}/tasks`)
  await clickUntil(page.getByTestId('task-card').first(), async () => (await page.getByTestId('right-panel').getAttribute('data-mode')) === 'task', 'a task card')
  if (!page.url().includes('task=')) await fail(`stage 4: opening a task left the URL at ${page.url()} -- ?task= is still the source of truth`)
  await clickUntil(page.getByTestId('panel-collapse'), async () => page.getByTestId('right-dock').isVisible(), 'the panel collapse »')
  const badge = await page.evaluate(() => document.querySelector('[data-testid="dock-badge"]')?.textContent?.trim() ?? null)
  const pendingCount = await prisma.supervisorDecision.count({ where: { workspaceId, status: 'pending' } })
  console.log(`stage 4: dock badge = ${JSON.stringify(badge)}, pending decisions in the database = ${pendingCount}`)
  if (Number(badge) !== pendingCount) await fail(`stage 4: the dock badge reads ${JSON.stringify(badge)} and the database has ${pendingCount} pending`)
  await gotoReliably(`${baseUrl}/workforce`)
  const globalRight = await page.evaluate(() => ({
    panel: document.querySelector('[data-testid="right-panel"]') !== null,
    dock: document.querySelector('[data-testid="right-dock"]') !== null,
    shell: document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-right') ?? null,
  }))
  console.log(`stage 4: on /workforce = ${JSON.stringify(globalRight)}`)
  if (globalRight.panel || globalRight.dock || globalRight.shell !== 'none') {
    await fail(`stage 4: a global route grew a third column (${JSON.stringify(globalRight)})`)
  }
  console.log('stage 4 PASSED: supervisor by default, task in the slot, a real badge on the dock, and nothing at all outside a project')

  // ============================================================================================
  // Stage 5: answering a decision, end to end.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('needs-you-card'), 'the Needs you card')
  const before = await page.evaluate(() => ({
    rows: document.querySelectorAll('[data-testid="needs-you-row"]').length,
    count: document.querySelector('[data-testid="sidebar-needs-you"]')?.textContent?.trim() ?? null,
  }))
  await clickUntil(page.getByTestId('needs-you-approve').first(), async () => (await page.getByTestId('needs-you-row').count()) < before.rows, 'Approve on the needs-you row')
  const resolved = await prisma.supervisorDecision.count({ where: { workspaceId, status: 'pending' } })
  console.log(`stage 5: rows ${before.rows} -> ${await page.getByTestId('needs-you-row').count()}, pending in the database -> ${resolved}`)
  if (resolved !== 0) await fail(`stage 5: Approve left ${resolved} pending decisions in the database`)
  console.log('stage 5 PASSED: approved in place, through the route that already existed')

  // ============================================================================================
  // Stage 6: five columns, against a grouped read of the same tasks.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}/tasks`)
  await waitVisible(page.getByTestId('column'), 'the task board')
  const columns = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="column"]')].map((column) => ({
      name: column.getAttribute('data-column'),
      statuses: [...column.querySelectorAll('[data-testid="task-card"]')].map((card) => card.getAttribute('data-status')),
    })),
  )
  console.log(`stage 6: columns = ${JSON.stringify(columns.map((c) => [c.name, c.statuses.length]))}`)
  const EXPECTED_COLUMNS = ['Queued', 'In progress', 'Review', 'Blocked', 'Done']
  if (JSON.stringify(columns.map((c) => c.name)) !== JSON.stringify(EXPECTED_COLUMNS)) {
    await fail(`stage 6: the board is ${JSON.stringify(columns.map((c) => c.name))}, expected ${JSON.stringify(EXPECTED_COLUMNS)}`)
  }
  for (const column of columns) {
    for (const status of column.statuses) {
      if (GATE_COLUMN_FOR_STATUS[status] !== column.name) {
        await fail(`stage 6: a ${status} task is in ${column.name}, and the table says ${GATE_COLUMN_FOR_STATUS[status]}`)
      }
    }
  }
  const dbCounts = await prisma.task.groupBy({ by: ['status'], where: { workspaceId }, _count: { _all: true } })
  const onScreen = columns.reduce((n, column) => n + column.statuses.length, 0)
  const inDatabase = dbCounts.reduce((n, group) => n + group._count._all, 0)
  if (onScreen !== inDatabase) await fail(`stage 6: the board shows ${onScreen} cards and the database has ${inDatabase} tasks`)
  await clickUntil(page.getByTestId('task-view-list'), async () => page.getByTestId('task-list').isVisible(), 'the List toggle')
  const listRows = await page.getByTestId('task-list-row').count()
  if (listRows !== inDatabase) await fail(`stage 6: the list shows ${listRows} rows and the database has ${inDatabase} tasks`)
  console.log('stage 6 PASSED: five columns, every card where the table says, and a list with the same rows')

  // ============================================================================================
  // Stage 7: the Supervisor's threads, which are days.
  // ============================================================================================
  await gotoReliably(`${baseUrl}/w/${workspaceId}`)
  await waitVisible(page.getByTestId('supervisor-thread'), 'the Supervisor thread')
  await clickUntil(page.getByTestId('supervisor-history'), async () => (await page.getByTestId('supervisor-thread-row').count()) > 0, 'the ≡ conversations button')
  const threadRows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="supervisor-thread-row"]')].map((row) => row.textContent?.trim() ?? ''))
  console.log(`stage 7: conversations = ${JSON.stringify(threadRows)}`)
  if (threadRows.length !== 2) await fail(`stage 7: two goal requests on two days produced ${threadRows.length} conversations, expected 2`)
  await clickUntil(page.getByTestId('supervisor-thread-row').nth(1), async () => (await page.getByTestId('supervisor-message').count()) > 0, 'the older conversation')
  const operatorText = await page.evaluate(() => document.querySelector('[data-testid="supervisor-message"][data-who="operator"]')?.textContent ?? '')
  if (!operatorText.includes(SEEDED_REQUEST_YESTERDAY)) {
    await fail(`stage 7: the older thread's operator message reads ${JSON.stringify(operatorText)}, expected the words that were typed`)
  }
  console.log('stage 7 PASSED: one thread per day, and an operator message in the operator s own words')

  // ============================================================================================
  // Stage 8: ten numbers out of the handoff README, read back off the browser.
  // ============================================================================================
  const NUMBERS = [
    [`/w/${workspaceId}`, 'nav[aria-label="Primary"]', 'width', '236px'],
    [`/w/${workspaceId}`, '[data-testid="app-header"]', 'height', '54px'],
    [`/w/${workspaceId}`, '[data-testid="right-panel"]', 'width', '372px'],
    [`/w/${workspaceId}`, '[data-testid="app-shell"]', 'min-width', '1280px'],
    [`/w/${workspaceId}`, 'body', 'font-size', '14px'],
    [`/w/${workspaceId}`, '[data-testid="needs-you-card"]', 'border-radius', '12px'],
    [`/w/${workspaceId}`, '[data-testid="brief-tile"]', 'border-radius', '12px'],
    ['/', '[data-testid="project-card"]', 'border-radius', '14px'],
    [`/w/${workspaceId}/tasks`, '[data-testid="task-card"]', 'border-radius', '10px'],
    [`/w/${workspaceId}/tasks`, '[data-testid="status-pill"]', 'border-radius', '999px'],
  ]
  let currentPath = null
  for (const [path, selector, property, expected] of NUMBERS) {
    if (path !== currentPath) { await gotoReliably(`${baseUrl}${path}`); currentPath = path }
    const actual = await page.evaluate(([sel, prop]) => {
      const node = document.querySelector(sel)
      return node === null ? null : window.getComputedStyle(node).getPropertyValue(prop)
    }, [selector, property])
    console.log(`stage 8: ${path} ${selector} ${property} = ${JSON.stringify(actual)}`)
    if (actual === null) await fail(`stage 8: nothing matched ${selector} on ${path}`)
    if (actual.trim() !== expected) await fail(`stage 8: ${selector} ${property} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)} (the handoff README's number)`)
  }
  // The dock is measured separately: it only exists once somebody collapses the panel.
  await clickUntil(page.getByTestId('panel-collapse'), async () => page.getByTestId('right-dock').isVisible(), 'the panel collapse »')
  const dockWidth = await page.evaluate(() => window.getComputedStyle(document.querySelector('[data-testid="right-dock"]')).width)
  console.log(`stage 8: dock width = ${JSON.stringify(dockWidth)}`)
  if (dockWidth !== '52px') await fail(`stage 8: the dock is ${JSON.stringify(dockWidth)}, expected "52px"`)
  console.log('stage 8 PASSED: eleven README numbers, read back off a real browser')
```

Stages 9 and 10 are M44's stage 4 and a route sweep; copy stage 4's blocklist derivation verbatim
(it builds the forbidden-token list at run time from the dist enums, keeping members containing `_`
or `.`), point it at the twelve routes stage 3 already lists, and add:

```js
  // ============================================================================================
  // Stage 10: nothing was removed, only moved (docs/ia.md rule 2, and M57 R11's whole argument).
  // ============================================================================================
  const EVERY_ROUTE = [
    '/', '/workforce', '/workforce?tab=slaves', '/workforce?tab=departments', '/workforce?tab=catalog',
    '/workforce?tab=skills', '/workforce?tab=runbooks', '/workforce?tab=evidence',
    '/slaves', '/skills', '/settings', '/sim', `/analytics?workspace=${workspaceId}`,
    `/w/${workspaceId}`, `/w/${workspaceId}/tasks`, `/w/${workspaceId}/organization`,
    `/w/${workspaceId}/knowledge`, `/w/${workspaceId}/activity`, `/w/${workspaceId}/settings`,
    `/w/${workspaceId}/graph`, `/w/${workspaceId}/office`,
  ]
  for (const route of EVERY_ROUTE) {
    const response = await page.goto(`${baseUrl}${route}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    const status = response === null ? null : response.status()
    console.log(`stage 10: ${route} -> ${String(status)}`)
    // 200 or a 307 that landed on a 200 (the two redirects `next.config.ts` owns).
    if (status !== 200) await fail(`stage 10: ${route} answered ${String(status)} -- ia.md rule 2 says every destination still answers`)
    await waitVisible(page.getByRole('navigation', { name: 'Primary' }), `the sidebar on ${route}`)
  }
  console.log(`stage 10 PASSED: ${EVERY_ROUTE.length} destinations, all of them still there`)
```

- [ ] **Step 2b: Pin the gate's copy of the column table to `lib/taskColumns` (scan finding 7)**

The gate re-declares `GATE_COLUMN_FOR_STATUS` because it cannot import the real one. A copy nobody
checks is a copy that drifts, so a vitest case checks it — in the idiom
`apps/web/test/integration/gate-surface-parity.test.ts` already establishes for exactly this problem.
**Read that file first** (its docstring is the argument this case inherits), then APPEND to it —
same file, because it is the same claim about the same kind of gate:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { COLUMN_FOR_STATUS } from '../../src/lib/taskColumns.js'

/**
 * M57 R10 / spec §5 stage 6: `scripts/gate-m57-ui-redesign.mjs` asserts that every card on the
 * board sits in the column `COLUMN_FOR_STATUS` says it should — and it cannot import that table,
 * for the reason this file's own header gives. So it re-declares it, and this case is the pin: the
 * gate's literal and the module must be the same thirteen pairs, or the gate is measuring a
 * vocabulary the board does not use.
 *
 * Parsed out of the gate's SOURCE rather than imported from it: the gate is a `.mjs` whose module
 * body drives a browser, and importing it would run it. The literal is a flat block of
 * `key: 'Value',` lines, which is all this needs to read.
 */
describe('the m57 gate reads the same task columns the board draws', () => {
  it('re-declares COLUMN_FOR_STATUS exactly', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../../../scripts/gate-m57-ui-redesign.mjs', import.meta.url)),
      'utf8',
    )
    const block = /const GATE_COLUMN_FOR_STATUS = \{([^}]*)\}/.exec(source)?.[1]
    expect(block, 'GATE_COLUMN_FOR_STATUS is not in the gate').toBeDefined()
    const parsed = Object.fromEntries(
      [...(block ?? '').matchAll(/^\s*(\w+):\s*'([^']+)',/gm)].map((match) => [match[1], match[2]]),
    )
    expect(parsed).toEqual(COLUMN_FOR_STATUS)
  })
})
```

*(Check the relative depth of that `new URL(...)` against the file's own location — it is four
directories below the repository root — and correct it if the first run cannot find the gate.)*

- [ ] **Step 3: Run the gate until it is green**

```bash
pgrep -af "next dev" && echo "STOP the dev server first" || echo "clear"
pgrep -af vitest || echo "no vitest running"
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m57-ui-redesign 2>&1 | tail -60; echo "exit=${PIPESTATUS[0]}"
git status --porcelain
```

Expected: `exit=0`, every stage printing its measured value before asserting it, and
`git status --porcelain` **empty** — the gate writes fixture rows and deletes them in its `finally`,
in foreign-key order.

- [ ] **Step 4: The roster, CI and the README**

```bash
grep -n '"gate:m56a-provider-contract"' package.json
grep -n 'gate:m56a-provider-contract' .github/workflows/ci.yml
grep -n '^[0-9]\+ gates\.' README.md
grep -n 'gate:m56a-provider-contract' README.md
```

- `package.json`: add after the `gate:m56a-provider-contract` line —
  `"gate:m57-ui-redesign": "tsc --build && node --env-file=.env scripts/gate-m57-ui-redesign.mjs"`
  (mind the comma on the line above).
- `.github/workflows/ci.yml`: add after that gate's step — `      - run: npm run gate:m57-ui-redesign`.
- `README.md`: the roster sentence becomes `…, \`gate:m56a-provider-contract\` and
  \`gate:m57-ui-redesign\` on every push…`, and the count line becomes `32 gates. Tests and gates
  share one Postgres --` (keep the rest of that line byte for byte).
- Also update README's "web UI" description if it names the sidebar's four rows or the project tab
  strip — `grep -n "tab strip\|Advanced ▾\|four entries" README.md` and rewrite each hit to the tree.

- [ ] **Step 5: Rewrite `gate-m14-fidelity.mjs`'s numbers to the new README (erratum E9)**

Replace the `NUMBERS` table (around line 936) with:

```js
  // page, path, selector, property, expected -- every row is one number out of the M57 handoff
  // README (`design_handoff_ui_redesign`). The M14-era numbers this table held (212px sidebar,
  // 52px header, 20px pill) are the OLD handoff's and are gone with the components that drew them.
  const NUMBERS = [
    ['overview', `/w/${workspaceId}`, 'nav[aria-label="Primary"]', 'width', '236px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="app-header"]', 'height', '54px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="right-panel"]', 'width', '372px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="needs-you-card"]', 'border-radius', '12px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="brief-tile"]', 'border-radius', '12px'],
    // M57 R18: `slave-card` is a ROW on the README's `34px 120px 120px 1fr 96px 32px` grid, not a
    // bordered card. The radius row and the `12px 13px` padding row are GONE -- a row has neither
    // -- and the padding it does have is the README's. The SCOPED selectors survive because the
    // row still carries `slave-card` with `avatar-tile` and `status-pill` inside it, which is why
    // R18 made keeping those three testids a requirement rather than a convenience.
    ['overview', `/w/${workspaceId}`, '[data-testid="slave-card"]', 'padding', '10px 14px'],
    // 30x30 on THIS row, and 28x28 everywhere else: Task 6 Step 5c gives `ui/AvatarTile` a `size`
    // prop whose default is the 28px every other caller already gets, and the Team row is the ONE
    // caller that passes `md`. The SCOPING is therefore load-bearing rather than defensive -- an
    // unscoped selector would hit whichever 28px tile rendered first (`TaskCard`,
    // `AllSlavesTable`, `ProjectsClient`, `GraphDrawer`) and fail against 30.
    ['overview', `/w/${workspaceId}`, '[data-testid="slave-card"] [data-testid="avatar-tile"]', 'width', '30px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="slave-card"] [data-testid="avatar-tile"]', 'height', '30px'],
    // M57 erratum E9: the handoff's pill radius is 999, not the 20 M44's token carried.
    ['overview', `/w/${workspaceId}`, '[data-testid="slave-card"] [data-testid="status-pill"]', 'border-radius', '999px'],
    // M57 R11 re-homed the live-events river out of a disclosure and onto `recent-changes`; it is
    // the same component at the same 340px, and it needs no click to be measurable any more.
    ['overview', `/w/${workspaceId}`, '[data-testid="live-events"]', 'width', '340px'],
    ['tasks', `/w/${workspaceId}/tasks`, '[data-testid="task-card"]', 'border-radius', '10px'],
    ['projects', '/', '[data-testid="project-card"]', 'border-radius', '14px'],
    ['activity', `/w/${workspaceId}/activity`, '[data-testid="timeline-rule"]', 'left', '88px'],
    ['graph', `/w/${workspaceId}/graph`, '[data-testid="graph-drawer"]', 'width', '352px'],
  ]
```

Also delete the `openOverviewAdvanced` helper if Task 4 Step 13 has not already, and change stage
2a's `project-settings` assertion only if Task 8's restyle moved `runtime-timeout`'s font size (run,
read the failure, then edit — never the other way round).

**Two more places in this file read the Overview and must be checked, not assumed.** Stage 3b
(`:1238-1242`) asserts `card-sweep`'s three animation properties and
`[data-testid="slave-card"] [data-testid="status-pill"] span`'s pulse: **both are unchanged**, because
R18 moved the layout and not the motion, and the row still renders `card-sweep` and a pulsing pill.
Stage 4a (`:1295-1298`) waits for and clicks `card-pause`: **also unchanged**, because the row's one
primary button keeps that testid in its pause state. Run the gate and confirm both rather than
trusting this paragraph.

- [ ] **Step 6: Regenerate the thirteen pictures — the ONLY time this milestone does**

```bash
pgrep -af "next dev" && echo "STOP the dev server first" || echo "clear"
pgrep -af vitest || echo "no vitest running"
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m14-fidelity 2>&1 | tail -60; echo "exit=${PIPESTATUS[0]}"
git status --porcelain docs/superpowers/fidelity/m14/
```

Expected: `exit=0` and thirteen modified PNGs. **Open at least four of them and look** — `overview`,
`tasks`, `projects` and `settings` — before committing: this is the only human check in the whole
milestone that the thing actually looks like the design, and a green gate that screenshots a broken
layout is exactly what a fidelity gate cannot catch. `office.png` differs on every regeneration (the
canvas animates); that is expected and recorded in M44's erratum E26.

- [ ] **Step 7: Write the errata back into the spec**

Append each plan-time erratum E1–E9, plus every erratum execution added along the way, to
`docs/superpowers/specs/2026-09-14-m57-ui-redesign-design.md`'s **§7 Errata**, in the one-line form
`**En (amends Rx)** — <claim>.` Nothing else in the spec changes; the rulings stand as written and
the errata are where the tree corrected them.

- [ ] **Step 8: The full verification ladder**

```bash
pgrep -af "next dev" && echo "STOP the dev server first" || echo "clear"
npm run gate:m26-vocabulary && echo "vocab ok"
npx tsc --build && echo "build ok"
npm run --silent typecheck && echo "typecheck ok"
npx vitest run 2>&1 | tail -20
npm run web:build 2>&1 | tail -20; echo "exit=${PIPESTATUS[0]}"
```

Expected: all green, and the vitest numbers **at or above Task 1's recorded baseline** (which was at
or above 370 files / 6514 tests). Record what you count.

Then every CI gate, one at a time, never beside vitest:

```bash
pgrep -af vitest || echo "no vitest running"
for g in $(node -e "const p=require('./package.json');console.log(Object.keys(p.scripts).filter(k=>k.startsWith('gate:')).join(' '))"); do
  case "$g" in gate:m12-providers|gate:m13-runtime|gate:m14-fidelity) echo "SKIP $g (not in CI)"; continue;; esac
  echo "=== $g ==="
  npm run "$g" 2>&1 | tail -8; echo "exit=${PIPESTATUS[0]}"
done
```

Expected: `exit=0` for all thirty-two.

- [ ] **Step 9: Commit — two of them, in this order**

```bash
git add docs/ia.md scripts/gate-m57-ui-redesign.mjs package.json .github/workflows/ci.yml README.md \
        scripts/gate-m14-fidelity.mjs docs/superpowers/specs/2026-09-14-m57-ui-redesign-design.md
git commit -m "$(cat <<'MSG'
feat(gate): m57 — CI's 32nd, and an IA document that describes a tree

Ten stages, fake CLI only: absent-is-system and a choice that survives a reload; the
tree read back against a Prisma query rather than against itself; twelve breadcrumbs;
the panel's three modes and a dock badge that equals the pending decisions in the
database; an Approve that empties the row and the count together; five columns checked
card by card against `COLUMN_FOR_STATUS` and then against a grouped read; two days of
conversation from two events; eleven numbers out of the handoff README; the raw-enum
sweep M44 wrote, over twelve routes; and twenty-one destinations answering 200, which
is `docs/ia.md` rule 2 proved rather than asserted.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tb1HCWnBqh63E9diBxdxR6
MSG
)"

git add docs/superpowers/fidelity/m14
git commit -m "$(cat <<'MSG'
chore(m57): the thirteen pictures, regenerated once against the new design

`gate:m14-fidelity`'s screenshots are the committed evidence of what this product looks
like, and this is the milestone that changed it. Regenerated in one deliberate commit,
separate from the code, so the diff a reviewer opens is thirteen images and nothing
else. `office.png` differs on every regeneration -- its canvas animates -- which M44's
erratum E26 already records.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Tb1HCWnBqh63E9diBxdxR6
MSG
)"
```

---

## Self-review

Run against the spec and the handoff README with fresh eyes, after the nine tasks were written.
Everything found is fixed inline above; this section records what was checked and what the checks
turned up.

**1. Spec coverage — the README, screen by screen.**

| README screen / section | Task | Note |
|---|---|---|
| Shell → Sidebar | 3 | tree, VIEWS chips, footer, theme pill |
| Shell → Header | 4 | breadcrumb, HALTED, budget, split button, action slot |
| Shell → Right panel | 5 | 372 px, 54 px header, `»` → 52 px dock with `S` (badged) and `A` |
| Projects (`/`) | 6 | auto-fit cards, needs strip, the five-tile KPI panel (existing `KpiStrip`) |
| Overview (`/w/:id`) | 6 | the README's five bands, in order: title + pill + goal line · Needs you · four fact tiles (`ProjectBrief`, rebuilt) · Team ROWS (`SlaveCard`, rebuilt) · Recent changes (`SupervisorTimeline`) |
| Tasks | 7 | filter row, 5 columns, Board ⇄ List |
| Team | 7 | the existing `/organization` route, relabelled and restyled |
| Knowledge | 7 | segmented filter, three-column rows |
| Activity | 8 | `200px 1fr`, volume bars, payload disclosure |
| Project Settings | 8 | `180px minmax(0,760px)`, sticky nav, four sections |
| Workforce | 8 | four tabs, six `?tab=` values |
| Simulations | 8 | dashed cards, `§` |
| Global Settings | 8 | adapter cards (existing), **Appearance** (new), Security (existing) |
| Supervisor panel | 5 | `≡` days, messages, decision cards, composer, the footer sentence |
| Design Tokens | 1 | both themes, plus the alias layer |
| Type / Assets | 1 | four `localFont()` calls, six woff2, `Silkscreen` untouched |
| Interactions & Behavior | 1, 4, 5, 6 | theme cycle + live system tracking (1); Pause all ⇄ Resume all, the two-step stop, Clear halt (4); decision approve/decline, task click → panel (5); needs-you approve (6). Per-worker pause/resume, Knowledge verify, permission changes, goal save, activity filters and the simulation timer are **existing behaviour this milestone does not touch**, and each is restyled by the task that owns its page |
| State Management | 2, 5 | `theme` (1), right-panel mode (5), thread id (5), task filters/view (7), activity family + settings section (8, existing) |

**Two README details are deliberately not built**, each named in spec §6 with its reason: Workforce's
People table keeps its ten columns, and the sidebar counts only `Projects`. Two further deviations
were drafted and **withdrawn under a controller ruling** — the Overview's eight-tile brief and its
`SlaveCard` grid — on the grounds that "a gate already measures that number" is not a reason to keep a
layout the user asked to change, least of all in the milestone whose Task 9 rewrites that gate's whole
`NUMBERS` table anyway. Task 6 now implements spec R17 and R18 in full, and Task 9's m14 list carries
the row numbers they move. No other README requirement is without a task.

**2. Placeholder scan.** `grep -nEi "TBD|TODO|FIXME|implement later|fill in|similar to task|add tests|appropriate error handling|handle edge cases"` over both documents returns two hits, both the
literal column name `Todo` in a sentence explaining that it folded into `Queued`. Every code step
carries complete, transcribable code. Five steps deliberately say **read the real file first and
correct the field names against it** — Task 6 Step 5 (`OverviewSnapshot`'s and
`UserSupervisorFacts`' members), Task 6 Step 7 (`useOverview`'s refetch), Task 5 Step 1
(`appendEvent`'s return), Task 4 Step 2 (`SlaveRun`'s required columns) and Task 2 Step 5
(`SupervisorDecision`'s columns). Those are not placeholders: the surrounding code is complete and
the instruction is to verify a name this plan could not read without opening an 825-line file it does
not otherwise touch. Each names the exact file and line range to read.

**3. Type consistency.** Checked every symbol a later task consumes from an earlier one:

- `useHeaderAction(node, deps)` — two arguments in Task 3's definition, two at both call sites
  (Task 4's test fixture, Task 6 Step 6).
- `RightPanelState.open(mode, content, onClose)` — three arguments in Task 3's definition, three in
  Task 5's test `Opener` and three at both real call sites in Task 5 Step 16.
- `AppShell({ sidebar, header, right, rightWidth, children })` and `RightWidth` — five props in Task
  3, five passed by Task 5's `ShellFrame`; `RightWidth` is exported from `AppShell.tsx` and imported
  as a type by `RightColumn.tsx`.
- `SidebarProject` — seven fields in Task 2's interface, the same seven in Task 3's test fixture and
  the same seven read by `SidebarTree`.
- `ShellFacts.counts.slavesPaused` — added in Task 2 Step 10 (as a `deriveSlaveStatus` count over
  the runs already fetched, because there is no `Slave.status` column), read in Task 4's `Header`,
  present in Task 4's test fixture, and Task 2 Step 11 is the sweep that finds every other literal.
  The name is `slavesPaused` on BOTH sides — server and the `OverviewClient` literal — which is the
  whole of spec erratum E13.
- `ShellFactsSeed({ facts })` — created in Task 4 Step 11b, mounted by the project layout in Step 11,
  and its only import is `publishShellFacts`, which already exists.
- `Header({ projects })` — one prop, passed by the root layout in Task 4 Step 11, threaded through
  `ShellFrame` as its own second prop in Task 5 Step 14, and passed by the header test's
  `renderHeader`. Three call sites, one shape.
- `AvatarTile({ name, tone, size? })` — `size` added in Task 6 Step 5c, defaulted to `'sm'`, passed
  as `'md'` by exactly one caller (the Team row) and by nobody else. Task 9's two 30 px rows are
  scoped to that row.
- `Segmented({ options, value, onChange, ariaLabel, testIdPrefix })` — created in Task 7 Step 4c,
  consumed by Task 7's `TaskFilters` (`testIdPrefix="task-view"`) and Knowledge, and by Task 8's
  Appearance (`testIdPrefix="appearance-theme"`). The testids it emits are
  `<prefix>` on the group and `<prefix>-<id>` on each button, which is what spec §3 lists for both.
- `supervisor-request-result` (SUCCESS) and `supervisor-request-error` (refusal) — two elements, both
  emitted by `SupervisorThreadPanel` from Task 5 onwards, and Task 6 renames neither. `postJson`
  (not `postControl`) is what gives the success line its version number.
- `PendingDecision` — declared and exported by `SupervisorThreadPanel`, imported as a type by
  `RightPanelHost`, which does the one fetch and passes the list down.
- `SupervisorThread` / `SupervisorMessage` — six and five fields in Task 5's definitions, matched by
  its own test fixture and by `SupervisorThreadPanel`'s reads (`id`, `title`, `when`, `messages`;
  `who`, `text`, `at`, `refs`, `decisionId`).
- `clearHalt` returns `Result<{ cleared: boolean }, ControlRefusal>`, which is what
  `workspaceControlResponse(workspaceId, () => Promise<Result<unknown, ControlRefusal>>)` accepts.
- `resumeActiveRuns` returns `FanoutReport { requested, refused }`; the route reads both members and
  `pauseActiveRuns`'s own `PauseFanoutReport` has the same two, so the two routes answer the same
  envelope.
- `BoardColumn` — the five strings are spelled identically in `BOARD_COLUMNS`, `COLUMN_FOR_STATUS`'s
  values, `COLUMN_STATE`'s keys, Task 7's test and the gate's `EXPECTED_COLUMNS`. `COLUMN_STATE`'s
  `Done` value is `'completed'`, which is `UserCardState`'s spelling (erratum E6) and not `'done'`.
- `filterTasks(tasks, options, needsYouIds)` — three arguments where it is defined and where it is
  called.
- `NeedsYouCard({ workspaceId, items })` — two props, matched at its one call site; there is no
  `onRefresh`, because `useOverview` exposes no refetch and the SSE wake-up already refetches.
- `ProjectBrief({ workspaceId, brief, runbookLine })` — `onOpenSlave` is gone with the `team` tile
  that was its only reader, `runbookLine` is optional and defaults to `null`, and the one call site
  in `OverviewClient` passes all three. `SlaveCard` loses `liveActionLine` in the same way: the
  component's signature and the call site move together, and `tsc` names it if only one does.
- The four `data-brief` keys (`work`, `cost`, `supervisor`, `latest-verified`) are spelled
  identically in `ProjectBrief`'s four `<Tile fact=…>` props, in `gate-m45`'s `EXPECTED_BRIEF_FACTS`,
  in its `wants` table, in `gate-m51`'s `[data-brief="cost"]` selector (unedited) and in the two new
  component-test cases.
- `THEME_STORAGE_KEY`, `THEME_GLYPH`, `THEME_LABEL`, `ThemeChoice` — exported from `ThemeProvider`,
  consumed by the root layout's inline script (via interpolation, pinned by a test), `SidebarTree`
  and Task 8's Appearance section.

Two things the sweep fixed: `SidebarTree`'s live chip originally invented a latency of `0` from
`useShellFacts`' arrival, and now reads `useStreamState`, which is the store that actually carries
the number the old `connection` badge showed — so `gate:m18-skill-and-teeth`'s `live · <n>ms`
assertion measures the same clock it always did. And the spec's introduced-testid table was missing
nineteen entries the plan's code blocks produce; it now lists every one, and the stray `views-chip`
row (an alias that was never written) is gone.

**What the pre-flight scan changed, and what it could not.** The scan
(`.superpowers/sdd/2026-09-14-m57-ui-redesign/preflight-scan.md`, 73 findings: 11 blockers, 32
must-rule, 30 notes) was run against both documents after they were complete, and twenty-eight
controller rulings came back. The eleven blockers are all closed in the task that owns them:
the breadcrumb's missing name (`ShellFactsSeed` + the tree, Task 4), `gate-m44`'s two Supervisor
assertions (`ProposalRow` extracted, the two testids re-emitted, Task 5), `useRightPanel` throwing in
two bare test files (the provider added, Task 5), Workforce's duplicated testids
(`workforce-segment-*`, Task 8), the gate's un-importable column table (re-declared and pinned by a
parity case, Task 9), the Graph's six stages (follows by construction; two tests moved, Task 7),
`slave.status === 'blocked'` (it is `taskStatus`, Task 6), the 30 px avatar with no producer (a
`size` prop, Task 6), `project-brief.test.tsx`'s 28 unlisted cases (a per-case verdict, Task 6),
`needs-you-row`'s shape against `gate-m45` stage 3 (a `Chip` and an anchor on every row, Task 6), and
`supervisor-request-result` on an error span (it is the success line, Task 5).

**One ruling could not be applied as stated and was implemented to its intent instead.** P13 asked
for `prisma.slave.count({ where: { status: 'paused', … } })`; **there is no `Slave.status` column** —
a slave's status is derived from its live runs by `deriveSlaveStatus`, which is exactly how
`buildShellFacts` already computes `slavesWorking` from the `SlaveRun` rows it has in hand. The count
is that same derivation asked for `'paused'` and deduped by `slaveId`: it costs no query, it carries
the ruling's intent (both sides count SLAVES, under the name `slavesPaused`), and it is identical to
the client literal by construction rather than by agreement. Spec erratum E13 records it.

**What the earlier controller ruling changed after the first self-review** (recorded here because the plan
was already complete when it arrived): Task 6 grew Steps 5b, 8 and 8b and lost its `FactTiles.tsx`;
`ProjectBrief.tsx`, `SlaveCard.tsx`, `SupervisorTimeline.tsx` and `scripts/gate-m45-project-experience.mjs`
joined its Files list and `TopStrip.tsx` its deletions; spec §6 lost two of its four deviations and
gained R17/R18 plus the reasoning that withdrew them; spec §3's removed table gained six rows naming
every testid that moves and, for each, whether a GATE or only a test reads it; and Task 9's m14
`NUMBERS` list swapped the card radius and `12px 13px` padding rows for the README's `10px 14px` row
padding and a 30 × 30 avatar. The census behind those six rows was taken by grepping each testid
across `scripts/*.mjs` and `apps/web/test/` separately, because "a gate reads it" and "a test reads
it" have different costs and the plan has to say which.

**One thing the review could not settle, and it is recorded rather than guessed:** `docs/ia.md`'s
own line saying the card's `needsYou` count and the Overview queue's can disagree, with reconciliation
"booked for M46", is still true after this milestone — `buildSidebarTree` derives the same FLOOR
`listProjects` does, so there are now three readers of two numbers instead of two. That is not worse
and it is not better, and fixing it is a read-model milestone rather than a redesign.
