# M61 — Simple mode: the console a person can run a company from

The milestone after the catalog person pool (merged to `main` at `a231c0e1`, follow-up `1e2fcedf`).
It is a **presentation milestone**, like M57: it rebuilds the operator web UI in `apps/web` and
touches no domain rule, no event, no migration and no control verb. Designed 2026-09-19 with the
user in a brainstorming session that ended with four decisions, each taken against a mockup:

1. the product has **two modes** — `simple` for a person who runs a company and does not read
   code, `developer` for the person who built it — switched with one control and remembered;
2. the project's home screen is a **command screen whose default tab is the team**: one card per
   person, a live "what they are doing now" line and a progress bar, with the board, the office
   and the activity one tab away (mockup "B — Önce ekip");
3. the product's home is a **project list beside a live company-wide feed** ("Happening now"),
   with everything that needs the person at the top (mockup "B — Liste + canlı akış");
4. developer mode is a **different palette as well as a different density** — cool graphite and
   mint against simple mode's warm graphite and amber — and the developer palette lives in one
   file so it can be changed later without touching a component (mockup "A", with the user's
   note "ilerde renkler değişebilir developerin, ona göre programla").

The user's brief, verbatim in intent: the UI today is unusable and confusing; it must be simpler
for end users; there will be a desktop app later; the page must never grow downwards — lists
scroll inside their own region; the theme may change; it is a startup and people should be
impressed when they see it; pages are inconsistent with each other.

**Goal.** One frame that never scrolls as a page, one visual language across every surface
(including the pixel office), five places in simple mode, one switch to developer mode that adds
the rest, and a palette that says "product" rather than "admin panel" — without removing a single
route, a single capability or a single control verb. The proof that nothing below `apps/web`
changes is the same as M57's: `packages/*`, `apps/orchestrator` and every API route appear in no
task's file list, except the four additive web read models and the two additive routes R11/R12
name.

**Facts the design stands on** (each read out of the tree on 2026-09-19).
`apps/web/src/app/globals.css` (448 lines) declares the twenty palette tokens three times (light
on `:root`, dark under `prefers-color-scheme` guarded by `:root:not([data-theme='light'])`, dark
again under `:root[data-theme='dark']`), an alias layer of twenty-two old names, eleven radius
tokens, and an `@theme inline` block; there is no `tailwind.config.*`.
`app/layout.tsx` (146 lines) reads the project tree on the server (`buildSidebarTree`), stamps
`data-theme` from `localStorage['theme']` with an inline `<head>` script whose key comes from the
plain module `lib/themeStorage.ts` (erratum M57-E20: a `'use client'` module's export reaches a
server component as a client reference, not a string), and composes
`ThemeProvider > RightPanelProvider > HeaderActionProvider > ShellFrame`.
`components/shell/AppShell.tsx` is one grid, `236px minmax(0,1fr) <372|52|none>`, `min-h-screen
min-w-[1280px]`, whose `<main>` is the scrolling element. `ShellFrame.tsx` sizes the third track
from `useRightWidth()`. `RightPanelProvider.tsx` holds `{mode, collapsed, content}` in React state
with no persistence; `collapsed` resets to `false` on every load. `SidebarTree.tsx` (314 lines)
draws the project tree, the `⌘K` search, the live chip and the theme pill, with testids
`sidebar-tree/project/section/view/needs-you/search/global/live`, `skip-link`, `theme-toggle`.
`Header.tsx` (252 lines) draws `breadcrumb`, `budget`, `budget-bar`, `budget-unmeasured`,
`halted-pill`, `pause-all`, `stop-split`, `stop-cancel`, `header-action`, `header-error`.
`lib/routes.ts` is the one pure table: `SECTIONS` (six), `VIEWS` (three), `sectionOf`, `viewOf`,
`workspaceIdOf`, `isGlobalRoute`, `breadcrumbOf`; `gate-m49-memory.mjs` reads the six section ids
off `[data-testid="sidebar-section"][data-section]` as a set.
`app/w/[workspaceId]/layout.tsx` seeds `ShellFacts` and renders `{children}`; `page.tsx` there
renders `OverviewClient` over `buildOverviewSnapshot` + `listSkillCatalogue` + `listProjectTeams`.
`app/page.tsx` renders `ProjectsClient` over `listProjects` + `listCompanies` + `buildAnalytics(null)`.
`server/needsYou.ts` (`buildNeedsYou(workspaceId)`) is the fuller per-project queue;
`server/sidebar.ts` (`buildSidebarTree()`) is the four-query floor per project;
`server/supervisorThreads.ts` folds six event families into one thread per local day and uses
`lib/feedSummary.ts`'s `feedSummary(type, payload)` to turn a row into a sentence;
`server/overview.ts`'s `SlaveCardData` carries `id, personId, name, role, provider, gate, profile,
runtimeRoles, grants, …` plus the live run's summary line and feed; `server/organization.ts`'s
`OrganizationRow` carries why a worker is here and their lifecycle; `server/persons.ts` has
`listPersons/readPerson/listPoolCandidates/listSkillCatalogue`; `server/activity.ts` has
`buildActivityPage` and `ACTIVITY_PAGE_LIMIT_MAX = 200`. `@tanstack/react-virtual` is already a
dependency of `apps/web`; `motion` and `@base-ui-components/react` are not installed. Next is
15.5.23, React 19, Tailwind v4. The gate roster is 34 (`package.json:73` `gate:m59-intake`,
`.github/workflows/ci.yml:91`, README `34 gates.` found by `grep -n '^[0-9]\+ gates\.' README.md`).
Ten gates read shell or overview testids: m14-fidelity, m18-skill-and-teeth, m44-ux-foundation,
m45-project-experience, m47-team-formation, m49-memory, m51-breaker, m53-evidence, m55-catalog,
m57-ui-redesign. The `docs/superpowers/fidelity/m14/*.png` set is 13 images regenerated by
`gate:m14-fidelity`, which is not in CI.

---

## 1. Rulings

### The two modes

- **R1 — A mode is an attribute on `<html>`, a `localStorage` key, a pre-hydration script and a
  React provider, built exactly the way the theme is.** `data-mode="developer"` on the root
  element is developer mode; the ABSENCE of the attribute is simple mode, which is the default
  for a person who has never chosen. The choice is persisted under the `localStorage` key `mode`
  with the two values `simple | developer`; the key is the constant `MODE_STORAGE_KEY` in the
  plain module `lib/modeStorage.ts` (no `'use client'`, for M57-E20's reason). The root layout's
  inline `<head>` script grows one clause: if the stored value is `developer`, stamp the
  attribute; otherwise stamp nothing. `components/mode/ModeProvider.tsx` mirrors
  `ThemeProvider.tsx` clause for clause — flat `'simple'` on the server and on the first client
  render, a `hydrated` flag before the attribute effect may run, every storage touch in
  `try/catch` — and exposes `useMode(): { mode, isDeveloper, setMode, toggle }`. It also owns the
  keyboard shortcut: `Mod+Shift+D` (⌘ on macOS, Ctrl elsewhere) calls `toggle()`; a keyboard
  toggle animates nothing (Emil: never animate a keyboard-initiated action). The switch itself is
  the rail's bottom control (`mode-toggle`, R4) and a segmented control on Settings → Appearance
  (`appearance-mode-simple` / `appearance-mode-developer`, R13). The mode never changes the URL:
  a person stays on the route they are on, and R18 says what a developer-only route looks like in
  simple mode.

- **R2 — Four palettes, two files, one alias layer; the developer palette is the one that already
  exists.** `globals.css` keeps its structure and gains `@import './tokens/simple.css'` and
  `@import './tokens/developer.css'` directly after `@import 'tailwindcss'`. Each token file
  declares the twenty palette names plus `--shadow-card`/`--shadow-resting` plus the new surface
  tokens below, for light and for dark, using M57's three-block shape — and the developer file's
  blocks are guarded by `[data-mode='developer']` on every selector:
  `:root[data-mode='developer']`, `@media (prefers-color-scheme: dark) {
  :root[data-mode='developer']:not([data-theme='light']) }`, `:root[data-mode='developer'][data-theme='dark']`.
  The simple file's three blocks are the bare `:root` shapes `globals.css` has today, MOVED out
  of `globals.css` with new values. Specificity: the developer selectors each carry one more
  attribute than their simple counterpart, so developer wins whenever the attribute is present
  and simple wins otherwise; nothing depends on source order. **`developer.css` holds today's
  values verbatim** — cream `#f5f3ef` + teal `#1f8a7a` in light, graphite `#141518` + mint
  `#3ccbb5` in dark — because the user's word for developer mode's look was "the colder, denser
  cousin" and today's sheet already is that. **`simple.css` holds the warm palette the mockups
  were drawn in**, dark: `--bg #121110`, `--panel #171513`, `--card #1d1a17`, `--line
  rgba(255,252,246,.08)`, `--line2 rgba(255,252,246,.15)`, `--t1 #efe9df`, `--t2 #a39c8f`, `--t3
  #857f74`, `--hover rgba(255,252,246,.05)`, `--sel rgba(255,252,246,.08)`, `--accent #f2b544`,
  `--accent-ink #1a1305`; light: `--bg #f7f3ec`, `--panel #fbf8f2`, `--card #ffffff`, `--line
  rgba(40,32,20,.09)`, `--line2 rgba(40,32,20,.16)`, `--t1 #1c1813`, `--t2 #5f584e`, `--t3
  #7a7266`, `--hover rgba(40,32,20,.045)`, `--sel rgba(40,32,20,.07)`, `--accent #b8781a`,
  `--accent-ink #ffffff`. **The eight `--s-*` status tones are identical in all four palettes**
  (today's light set in light, today's dark set in dark): one status vocabulary, one set of
  colours, and no gate that reads a tone colour changes. The alias layer, the `@theme inline`
  block and `color-scheme` stay in `globals.css` untouched except for the additions R3 and R16
  name. *(The user's instruction was that the developer colours may change later. The
  consequence is a rule, not a file: **no component, no test and no gate names a colour**; a
  gate that must prove the palette switched compares `getComputedStyle(html).getPropertyValue('--accent')`
  before and after the toggle for inequality, never against a literal.)*

- **R3 — Surface tokens: glass, edge, three radii, two densities, one motion vocabulary.** Added
  to both token files (palette-dependent) and to `globals.css` (palette-independent):
  - `--glass: color-mix(in srgb, var(--panel) 72%, transparent)` and `--glass-strong:
    color-mix(in srgb, var(--panel) 88%, transparent)` — the backgrounds of the rail, the header,
    the right panel and every `Sheet`, always paired with `backdrop-filter: blur(20px)
    saturate(160%)`; `--edge: rgba(255,255,255,.06)` in dark and `rgba(255,255,255,.7)` in light,
    the one-pixel top border a translucent surface catches light on; `@media
    (prefers-reduced-transparency: reduce)` sets both glass tokens to `var(--panel)` and the blur
    to none.
  - `--radius-control: 8px`, `--radius-surface: 12px`, `--radius-sheet: 16px`. **The eleven
    existing radius tokens become aliases**: `chip, nav, tile, card, panel → control`; `tile-lg,
    panel-card → surface`; `page-card, bubble → sheet`; `pill` stays `999px`; `hair` stays `2px`.
    Every `rounded-*` utility in the tree keeps resolving; three of them change value
    (`tile` 7→8, `panel` 9→8, `panel-card` 12→12 no change, `page-card` 14→16, `bubble` 14→16),
    and the gate rows that measured them (`gate-m14-fidelity.mjs` `NUMBERS`, `gate-m57` stage 6)
    are rewritten in the gate task.
  - Density: `--fs-body: 14px`, `--row-h: 40px`, `--gap-1: 8px`, `--gap-2: 12px`, `--gap-3:
    16px` on `:root`; `:root[data-mode='developer']` sets `13px / 34px / 6px / 8px / 12px`.
    `body { font-size: var(--fs-body) }`. Components that lay out rows and gaps read these four
    tokens; a component that hardcodes a row height is a review finding.
  - Motion: `--ease-out: cubic-bezier(.23,1,.32,1)`, `--ease-in-out: cubic-bezier(.77,0,.175,1)`,
    `--dur-fast: 120ms`, `--dur-base: 180ms`, `--dur-slow: 240ms`. **No `transition: all`
    anywhere in `src/`** (a grep the gate runs); every transition names its properties. The
    existing `prefers-reduced-motion` block that zeroes every animation stays.
  - Type scale, as utilities in `globals.css` (`.type-label 11px/500/+0.01em`, `.type-meta
    12.5px/400`, `.type-body 14px/400`, `.type-title 16px/600/-0.01em`, `.type-heading
    20px/600/-0.015em`, `.type-display 28px/600/-0.02em`). Uppercase tracked mono labels
    (`SectionLabel` today) are gone in simple mode: `SectionLabel` becomes `.type-label` sentence
    case in `--t2`; mono is reserved for `technical` lines (R7) and developer-mode identifiers.

### The frame

- **R4 — The page never scrolls; the frame is `100dvh`, and regions scroll.** `html, body {
  height: 100%; overflow: hidden }`. `AppShell` becomes `h-dvh` (not `min-h-screen`) with
  `min-w-[1024px] min-h-[680px]` — the floor drops from 1280 to 1024 because a desktop app window
  is smaller than a browser tab, and below the floor the shell scrolls as a whole, as it does
  today below 1280. `<main>` is `overflow-hidden`; **it no longer scrolls**. Every page places its
  scrolling content inside the new `ui/ScrollArea` primitive (`data-testid="scroll-area"`,
  `overflow: auto`, `overscroll-behavior: contain`, `min-h-0`, `flex-1`, a `data-scroll-x` variant
  for the board), and a page may have more than one (the board's columns, the Supervisor's
  messages, a Sheet's body). The three long tables — People, Activity's river, Knowledge — render
  their rows through `@tanstack/react-virtual` inside a `ScrollArea`. The new gate's stage 2
  asserts, on every route in `docs/ia.md`'s tables, in both modes, at 1440×900 and 1024×680, that
  `document.scrollingElement.scrollHeight === document.scrollingElement.clientHeight`. The grid
  is `56px minmax(0,1fr) <340px | 52px | none>` — the rail is 56 (R5), the panel narrows from 372
  to 340 to fit 1024 with a usable middle. Below 1280 the panel's track is `none` and the panel
  renders as an OVERLAY (R14).

- **R5 — The sidebar tree is gone; a 56 px icon rail and a project switcher replace it.**
  `components/shell/Rail.tsx` (`data-testid="rail"`) draws: the mark, then one `rail-item` per
  entry of `railFor(mode)` (R18) with an icon, a `title`, an `aria-label`, and a label that is
  visible only while the rail is hovered — the rail expands to 208 px over the content
  (`position: absolute` inside its 56 px track, glass background, `@media (hover: hover) and
  (pointer: fine)` only, 180 ms `--ease-out` width transition, no transition on the way back) —
  and at the bottom the live chip (`sidebar-live`, kept), the theme pill (`theme-toggle`, kept),
  and the mode switch (`mode-toggle`: a 2-state switch whose `aria-checked` is `isDeveloper`,
  labelled `Developer mode`). The `skip-link` stays as the first focusable element. **The list of
  projects moves into the header**: the breadcrumb's project crumb is a button
  (`project-switcher`) that opens a popover listing every project from the same `GET /api/sidebar`
  read (`buildSidebarTree` and the route are kept, unchanged), one `project-switcher-item` per
  row with the same dot, the same amber count (`data-needs-you`) and the same `data-status`, plus a
  `New project` row that opens the intake Sheet (R15). The `⌘K` search keeps its behaviour and
  moves into the header as `search` (it was `sidebar-search`). `SidebarTree.tsx` is deleted as a
  widget; `sidebar-tree`, `sidebar-project`, `sidebar-section`, `sidebar-view`, `sidebar-needs-you`,
  `sidebar-search` leave the vocabulary and §3 lists their replacements. The `SIDEBAR_REFETCH_MS`
  throttle moves with the fetch into the switcher.

- **R6 — The header stays 48 px and keeps every testid; it gains the switcher and the search and
  loses nothing.** `Header.tsx` keeps `breadcrumb`, `budget`, `budget-bar`, `budget-unmeasured`,
  `halted-pill`, `pause-all`, `stop-split`, `stop-cancel`, `header-action`, `header-error` with
  their behaviour (armed two-step Stop, `Clear halt` while halted, `Resume all` when everything is
  paused). It is a glass surface (`--glass`, blur, `--edge` bottom edge instead of a 1 px line).
  The `⌘J` hint for the Supervisor (R14) sits at its right end on project routes.

### The project

- **R7 — A project is one command screen: a strip, a tab bar, and the Team tab by default.**
  `app/w/[workspaceId]/layout.tsx` renders, above `{children}`, `components/project/CommandStrip.tsx`
  (`data-testid="command-strip"`): the **needs-you bar** (`needs-you`, one `needs-you-row` per
  item from `buildNeedsYou`, the amber accent, `data-kind`, the same `href`s, hidden entirely when
  the list is empty — the M45 `NeedsYouCard` rewritten, not a second reader), then the **tab
  bar** (`project-tabs`, one `project-tab` per entry of `tabsFor(mode)` with `data-tab` = the
  route segment and `aria-current="page"` on the current one), and a gear (`project-settings`)
  linking to `/w/:id/settings` at the bar's right in both modes. The strip's footer is not in the
  layout: each tab decides what sits under it. **The Team tab lives at `/w/:id`** — the project's
  canonical URL is its team — and renders `components/project/TeamLive.tsx` over R8's read model:
  one `team-card` per seat (`data-slave`, `data-status`, `data-state` as `SlaveCard` had them),
  with the person's `AvatarTile`, name, role, the `doing` sentence with a `LiveDot`
  (`data-tone`), a 3 px progress bar (`team-progress`, `data-progress`), and in developer mode
  one `technical` line (`team-technical`). Clicking a card selects `?slave=` exactly as today and
  the panel opens in the right slot. Under the grid: three `Stat` tiles — `stat-goal` (the goal
  and `Edit goal`, M45's `GoalCard` reduced to one tile), `stat-work` (in progress · done), and
  `stat-spend` (the same `spentUsd`/`budgetUsd` the header shows). **`OverviewClient.tsx` and
  `ProjectBrief.tsx` are deleted as widgets**; where each of the Overview's blocks went: the
  brief's four tiles → the three `Stat`s and the header's budget; `Needs you` → the strip;
  `Team` → the Team tab; `How this project works` (the runbook adopt panel) → project Settings
  under a `Runbook` heading (`runbook-panel` testid kept, `gate-m33-adopt` and `gate-m48-runbooks`
  navigate to Settings); `Recent changes` (timeline, live events, merge queue) → the Activity
  tab's raw view (R10), where the whole river already was. `/w/:id/organization` **redirects**
  (307, query string preserved) to `/w/:id`: the Team tab is the organization page's content, and
  one page should not answer at two URLs; the redirect is what keeps `docs/ia.md` rule 2
  (`gate-m47-team-formation` follows it and finds the `organization-*` testids it asserts on the
  Team tab, which keeps them).

- **R8 — `buildTeamLive` composes two existing reads and adds one presentation table.**
  `server/teamLive.ts` exports `TeamLiveRow` and `buildTeamLive(workspaceId, now?)`: it calls
  `buildOverviewSnapshot` and `buildOrganization` (both unchanged) and joins their rows on the
  seat id. Per row: `slaveId, personId, name, role, status` (the derived `SlaveStatus`), `state`
  (`cardStateFor`), `doing: string` — the live run's task title when there is one, else the
  waiting reason a person can read (`Waiting for your approval` for a pending decision about this
  seat's task, `Idle · next: <queued task title>` when one is queued for it, `Idle` otherwise),
  never an enum member — `progress: number | null` from `PROGRESS_FOR_TASK_STATUS` in
  `lib/progress.ts`, a total `Record<TaskStatus, number | null>` over the thirteen members of
  `packages/domain/src/task/state.ts`: `backlog 0, ready 0, assigned 10, running 35, verifying 60,
  reviewing 80, merging 90, rework 35, waiting null, blocked null, done 100, failed null,
  cancelled null` (`null` draws no bar; the record is TOTAL so a fourteenth status fails the
  build), and `technical: { runId: string | null; provider:
  ProviderKind | null; startedAt: string | null; toolCalls: number | null; costUsd: number | null }`
  from the fields `SlaveCardData` already carries. `GET /api/w/:id/team` returns
  `{ rows, shellFacts }` and `TeamLive` refetches it through the same `useWorkspaceStream`
  debounce every other page client uses. The organization page's `Needs` section (unstaffed
  roles, answerable proposals) and its preferences keep their components and their testids and
  render below the grid in developer mode; in simple mode the Needs section renders, the
  preferences do not (they are a staffing rule, one click away in developer mode).

- **R9 — The Work tab is the board, inside a `ScrollArea` that scrolls sideways.**
  `/w/:id/tasks` keeps `TasksClient`, `TaskFilters`, `TaskList`, the five columns and every
  testid. Its layout changes: the filter row is fixed, the board is one `ScrollArea` with
  `data-scroll-x`, each column is its own vertical `ScrollArea`, and a card is `--radius-surface`
  with the `technical` details (run kind, attempt, artifacts) rendered only in developer mode —
  the M45 progressive disclosure's `Details` toggle becomes "developer mode shows it".

- **R10 — The Activity tab has two views at one URL; simple mode's is a digest.**
  `/w/:id/activity` unchanged renders today's river (`ActivityClient`, every card, every filter,
  every testid) — the raw view, and the developer tab's `href`. `/w/:id/activity?view=digest` is
  the simple tab's `href` and renders `components/project/ActivityDigest.tsx` over
  `server/activityDigest.ts`'s `buildActivityDigest(workspaceId, now?)`: one `digest-day` per
  local day (the same grouping `buildSupervisorThreads` does, taken from it rather than
  re-derived), each holding `digest-item`s with an avatar, a sentence and a time, over the
  families `workspace.goal_set`, `supervisor.*`, `task.*`, `run.started`, `run.completed`,
  `run.failed`, `merge.*`, `review.*`, capped at 200 rows like the river. No new event type. The
  sentence comes from **one new label table**, `lib/happening.ts`'s `happeningSentence(row)`: a
  `Record<DomainEventType, (payload, names) => string>` over exactly the families above, in the
  mockup's register (`Emma finished "Checkout form"`, `Alex started "Stripe webhook"`, `Riley
  approved "Order summary"`, `You asked for: …`, `The Supervisor proposed: …`), with the actor's
  name and the task's title resolved from the ids the payload carries, and `feedSummary` as the
  fallback for any type the table does not name — a label table beside the thing it names
  (`docs/ia.md` rule 3), unit-tested one type per test, with the raw type on the item's `title`.
  A page reads `searchParams.view`, so a bookmarked `?view=digest` works in developer mode too.

- **R11 — Home is a list beside a feed, over one additive read model, polled.** `app/page.tsx`
  renders `components/home/HomeClient.tsx` over `server/home.ts`'s `buildHomeSnapshot(options)`:
  `{ greeting: { projects, peopleWorking, spendUsd }, needsYou: HomeNeedsYouItem[], projects:
  ProjectRow[], feed: HappeningNowItem[], numbers: { peopleWorking, peopleIdle, spendUsd,
  finishedThisWeek } }`. `projects` is `listProjects(options)` unchanged (`?archived=1` kept).
  `needsYou` is `buildNeedsYou` called for **only** the projects whose `buildSidebarTree` floor is
  positive, each item stamped with `workspaceId` and `workspaceName`, sorted oldest first. `feed`
  is `buildHappeningNow(limit = 40)` in the same file: the newest rows across every non-archived
  workspace in the families R10 lists, each turned into `{ id, at, type, workspaceId,
  workspaceName, actorName, sentence }` by R10's `happeningSentence` — one query over `Event`
  ordered by `seq desc` with `type in (…)`, plus one lookup each for the names and titles the
  payloads reference. `numbers.spendUsd` is the SUM of `workspaceSpend` over the
  listed projects (the guardrail's formula, so Home and the header agree); `finishedThisWeek` is
  `task.count` where `status = 'done'` and `integratedAt >= now − 7d` (integrated, because "done
  and not integrated" is on the needs-you list, not finished). **No "today" window is invented**:
  the label is `Spend`, not `Spend today`, until a per-day formula exists in `control`.
  `GET /api/home` returns the same object; `HomeClient` re-fetches it every `HOME_POLL_MS = 10_000`
  while the tab is visible (`document.visibilityState`), because there is no company-wide SSE and
  this milestone does not add one. Testids: `home-greeting`, `home-needs-you` +
  `needs-you-row`, `home-projects` + `project-row` (`data-workspace`, `data-status`, the old
  `project-card`'s `data-needs-you`), `home-feed` + `feed-item`, `home-numbers` +
  `stat-people/stat-spend/stat-finished`, `new-project` (opens the intake Sheet), `show-archived`.
  `ProjectsClient.tsx` is deleted as a widget; `AssignCompanyDialog` moves into the project row's
  `⋯` menu (`project-menu`). The all-workspaces KPI strip (`buildAnalytics(null).kpis`) renders on
  Home only in developer mode, under the numbers, with its testids unchanged.

### People, Settings, Office, Supervisor

- **R12 — People is one virtualised table, a Sheet per person, and the catalogue one button
  away.** `/workforce` keeps every `?tab=` value. In simple mode the tab bar is hidden and the
  page IS the People tab: the filters row (pool / assigned / released, department, skill — kept),
  the table (`people-table`, virtualised, `--row-h` rows, sticky head), and one primary header
  action `Hire from catalogue` (`hire-from-catalogue`) that opens the existing Catalog panel
  inside a `Sheet`. A row click opens `SlavePanel` inside a `Sheet` (`person-sheet`) rather than
  the page's fixed aside — `?slave=` stays the source of truth and the Sheet's close clears it.
  In developer mode the four tabs (People, Catalog, Skills & runbooks, Evidence) render as today
  with `workforce-segment-*` and every panel unchanged, inside `ScrollArea`s.

- **R13 — Settings is two fixed columns.** `/settings` and `/w/:id/settings`: a 180 px section
  list on the left (`settings-nav`, one `settings-nav-item` per section, `aria-current`), the
  chosen section in a `ScrollArea` on the right, `?section=` round-tripped. Global sections:
  Providers, Appearance (theme segmented control kept; **mode segmented control added**,
  `appearance-mode-simple` / `appearance-mode-developer`), Repositories (M59's `ReposRootField`),
  Security, Danger (reset). Project sections: Goal, Runbook (R7), Runtime, Permissions, Danger.
  Every existing form component and testid is kept; only the frame changes.

- **R14 — The Supervisor opens by default, remembers being closed, answers `⌘J`, and becomes an
  overlay when the window is narrow.** `RightPanelProvider` gains persistence: `collapsed` is
  read from `localStorage['supervisor']` (`'open' | 'collapsed'`, plain module
  `lib/supervisorStorage.ts`) after hydration and written on every `collapse()`/`expand()`;
  absent is `open`. `Mod+J` toggles collapse; a keyboard toggle animates nothing. `useRightWidth`
  gains `'overlay'`: below 1280 px (`matchMedia('(max-width: 1279px)')`) on a project route the
  grid's third track is `none` and `RightPanelHost` renders the same content `position: fixed`
  at the right, 340 px, glass, no scrim, above the page — the panel stays non-modal (`docs/ia.md`
  "Panels that stay where they are"). The dock (`right-dock`, `dock-supervisor`, `dock-badge`,
  `dock-activity`) is unchanged. The panel's chrome: glass, `--edge`, the composer as a
  `--radius-surface` field with `Kbd` `⏎`, the "Every message is recorded as an event" footer
  line removed, the scope line kept as the panel's subtitle. Bubbles are `--radius-sheet`.

- **R15 — `Sheet` is the one modal surface, and `motion` is imported by exactly two files.**
  `ui/Sheet.tsx` (`data-testid="sheet"`, `data-side="right" | "bottom"`): a modal slide-over
  with a scrim, focus trap, `Escape`, `aria-modal`, header with title and `sheet-close`, body as
  a `ScrollArea`. It animates with the `motion` package (v12, `motion/react`): `AnimatePresence`,
  a spring `{ type: 'spring', bounce: 0, visualDuration: 0.35 }` on `transform`, exit faster than
  enter, `drag` along its axis with dismissal when travel exceeds 40 % or velocity exceeds
  `0.11 px/ms`, rubber-band past the edge; `useReducedMotion()` collapses it to a 150 ms opacity
  fade; an `instant` prop renders with no animation at all (a Sheet opened by a keyboard
  shortcut passes it). **Only `ui/Sheet.tsx` and `ui/motion.ts` (the spring constants) import
  from `motion`** — a grep the gate runs — so a later decision to drop the dependency is a
  two-file change. `Sheet` replaces `Drawer` for the New project intake conversation, the Hire
  from catalogue panel and the People row's `SlavePanel`; `Dialog` and `DangerConfirm` stay for
  confirmations. `@base-ui-components/react` is **not** adopted: the popovers and menus this
  milestone needs (the switcher, the row `⋯` menus, the header's Stop) are hand-rolled today over
  `useModalDismiss` and a `relative` wrapper, and a beta dependency for three popovers is a risk
  with no matching reward.

- **R16 — Primitives: five new, six rewritten, none deleted.** New in `components/ui/`:
  `ScrollArea` (R4), `Sheet` (R15), `Stat` (`data-testid` given by the caller; label in
  `.type-label`, value in `.type-heading`, an optional trailing note), `LiveDot` (a 6 px dot in a
  `--s-*` tone, `data-tone`, pulsing only for in-flight tones through the existing
  `status-pulse` keyframe), `Kbd`. Rewritten in place, same exports and same testids: `Button`
  (`:active { transform: scale(.97) }` with a `--dur-base` `--ease-out` transform transition;
  `--radius-control`; the primary variant is `--accent` on `--accent-ink`), `Chip`
  (`--radius-pill`, no background for a status chip — dot + word), `Segmented` (the active
  segment is a clip-path over a duplicated list so the label colour crosses with the pill, 180 ms
  `--ease-in-out`; the same component the tab bar and the Appearance controls use), `Card`
  (`--radius-surface`, no shadow, `--card` on `--panel`), `Panel` (`--glass` when `floating`,
  `--panel` otherwise), `DataTable` (a `virtualized` prop wiring `@tanstack/react-virtual`, sticky
  head, `--row-h` rows). `StatusPill` keeps its name and testid and becomes `LiveDot` + word.
  `Drawer` stays for the two places that still call it after R15 and is not restyled beyond
  tokens.

- **R17 — The Office keeps its engine and gets the product's frame.** `/w/:id/office`: the
  canvas, `lib/office/*`, the `Silkscreen` font and every `office-*` testid are unchanged. The
  black HUD boxes (`LIVE · 1 DEPARTMENT · …`, the time-of-day slider, the legend, the zoom
  buttons) are re-drawn as one glass `Toolbar` above the canvas (`office-toolbar`) using `Chip`,
  `Segmented` and `Button`, and the focused-character card becomes a `Card` beside the canvas
  (`office-focus`). Mono type inside the canvas stays (it is drawn by the canvas); mono type in
  the DOM around it goes.

### Routes, developer mode and the proof

- **R18 — `lib/routes.ts` learns the mode; nothing else in the tree derives a route from a mode.**
  `SECTIONS` becomes `TABS: readonly TabSpec[]` — `{ id, label, href(workspaceId), modes:
  readonly Mode[] }` — in the order `team` (`/w/:id`, both), `tasks` (`Work`, both),
  `office` (both), `activity` (both; simple's `href` carries `?view=digest`), `graph`
  (developer), `knowledge` (developer). `tabsFor(mode)` filters it. `RAIL` is `{ id, label,
  href, modes }` in the order `home` (`/`), `people` (`/workforce`), `settings` (`/settings`)
  for both, then `simulations` (`/sim`) and `analytics` (`/analytics`) for developer; `railFor(mode)`
  filters it. `sectionOf(pathname)` keeps its name and return type (`Section`, now the union of
  the six tab ids plus `settings`) so `breadcrumbOf` and the gates that call it keep working;
  `viewOf` returns `null` for `office` and `graph` now that they are tabs, and `VIEWS` is reduced
  to `analytics` alone. **A developer-only route opened in simple mode does not redirect** (rule
  2): the tab bar renders it as an extra current tab marked `data-outside-mode="true"`, so the
  person can see where they are and leave by any other tab. `gate-m49-memory.mjs`'s set assertion
  reads `[data-testid="project-tab"][data-tab]` in developer mode and expects
  `team, tasks, office, activity, graph, knowledge`.

- **R19 — Developer mode ADDS; it never re-skins an old component.** Every developer-only surface
  (Graph, Analytics, Simulations, Knowledge, Skills & runbooks, Evidence, the raw river, the
  preferences, the KPI strip, the `technical` lines, the board's details) renders inside the same
  frame with the same primitives; the only differences are the palette (R2), the density (R3) and
  the set of things on screen (R18). The developer-only PAGES — Graph, Analytics, Simulations,
  Knowledge, Evidence — are **restyled, not redesigned**: each page's task wraps its content in a
  `ScrollArea`, swaps its `SectionLabel`s and `Card`s for the rewritten primitives, and leaves its
  read model, its client and its testids alone.

- **R20 — Testids: a vocabulary is introduced, a vocabulary is retired, and §3 is the list.**
  Every testid that leaves is listed with the testid that replaces it and the gates that read it.
  A task that removes a testid edits every gate in §3's column for it in the same commit.

- **R21 — The proof is one new gate and the reconciliation of ten.** `scripts/gate-m61-simple-mode.mjs`
  (`npm run gate:m61-simple-mode`, the 35th, after `gate:m59-intake` in `package.json`, in
  `.github/workflows/ci.yml` and in README's roster and count line) runs against
  `GATE_DATABASE_URL` and has the stages §5 lists. The ten gates that read shell or overview
  testids are edited to the new vocabulary, never weakened: an assertion that a thing is on
  screen moves to where the thing is; an assertion that measured a token's old value takes the
  new value. `gate:m14-fidelity` regenerates its 13 PNGs exactly once, in a commit of its own,
  in simple mode, dark.

- **R22 — Documentation.** `docs/ia.md`'s "Top-level navigation", "The header", "The right
  panel" and "Project surfaces" sections are rewritten to §4; every "Later" cell that names a
  surface that moved gets one sentence saying where. README's shell paragraph and screenshots
  follow. `docs/decisions/0007-two-modes.md` records R1/R2/R19 in the ADR form the six existing
  ADRs use.

---

## 2. Surfaces after M61

| Route | Simple mode | Developer mode |
|---|---|---|
| `/` | Greeting · needs-you list · project rows · Happening now · three numbers | + all-workspaces KPI strip |
| `/w/:id` | Command strip · **Team** tab (cards, three stats, Needs) | + `technical` line per card · preferences |
| `/w/:id/tasks` | Work tab: filters · five columns, scroll inside | + card details |
| `/w/:id/office` | Office tab: glass toolbar · canvas · focus card | same |
| `/w/:id/activity` | tab `href` is `?view=digest`: the digest | tab `href` is the bare route: the river |
| `/w/:id/graph`, `/w/:id/knowledge` | reachable by URL, tab marked outside mode | tabs |
| `/w/:id/organization` | 307 → `/w/:id` (query preserved) | same |
| `/w/:id/settings` | gear from the strip; two columns; Runbook section | same |
| `/workforce` | People table · Hire from catalogue Sheet · person Sheet | four tabs |
| `/settings` | two columns; Appearance has theme + mode | same |
| `/analytics`, `/sim/*` | reachable by URL, restyled | rail items |
| `/login` | centred card, same palette | same |

## 3. Testid vocabulary

**Introduced:** `rail`, `rail-item` (`data-rail`), `mode-toggle`, `project-switcher`,
`project-switcher-item` (`data-workspace`, `data-status`, `data-needs-you`), `search`,
`command-strip`, `project-tabs`, `project-tab` (`data-tab`, `data-outside-mode`),
`project-settings`, `team-live`, `team-card` (`data-slave`, `data-status`, `data-state`),
`team-doing`, `team-progress` (`data-progress`), `team-technical`, `stat-goal`, `stat-work`,
`stat-spend`, `scroll-area`, `sheet`, `sheet-close`, `digest-day`, `digest-item`,
`home-greeting`, `home-needs-you`, `home-projects`, `project-row`, `project-menu`, `home-feed`,
`feed-item`, `home-numbers`, `stat-people`, `stat-finished`, `new-project`, `show-archived`,
`hire-from-catalogue`, `person-sheet`, `people-table`, `settings-nav`, `settings-nav-item`,
`appearance-mode-simple`, `appearance-mode-developer`, `office-toolbar`, `office-focus`,
`live-dot` (`data-tone`).

**Retired → replaced by (gates that read it):**
`sidebar-tree` → `rail` (m57); `sidebar-project` → `project-switcher-item` (m57, m45);
`sidebar-section` → `project-tab` (m57, m49); `sidebar-view` → `project-tab` (m57);
`sidebar-needs-you` → `project-switcher-item[data-needs-you]` (m57, m45); `sidebar-search` →
`search` (m57, m44); `brief` and `strip` (ProjectBrief) → `stat-goal/stat-work/stat-spend`
(m45, m57, m14); `needs-you-card` → `needs-you` in `command-strip` (m45, m57); `project-card` →
`project-row` (m44, m45, m57, m14, m18); `recent-changes` → the river/digest (m45, m57);
`workforce-segment-*` stays (developer mode; m57 stage runs in developer mode). Kept verbatim:
every `organization-*`, `task-*`, `slave-*`, `office-*`, `activity-*`, `knowledge-*`,
`runbook-*`, `catalog-*`, `evidence-*`, `skills-*`, `sim-*`, `settings-*`, header, panel and
dock testids.

## 4. `docs/ia.md` after M61

- Top-level navigation: the rail (Home, People, Settings; developer adds Simulations, Analytics)
  and the header's project switcher; the project's TABS table (six, with the mode column) and
  the gear.
- The header: 48 px glass; the same split button; the switcher; the search; `⌘J`.
- The right panel: open by default, remembered, `⌘J`, overlay below 1280.
- Project surfaces: `/w/:id` is the Team tab and where `organization` redirects; `/w/:id/activity`
  has two views; Graph and Knowledge are developer tabs; the Overview's blocks and where each went.
- A new "Modes" section under "The rules": what simple hides, what developer adds, and rule 2's
  guarantee that hidden is reachable.

## 5. The gate's stages

1. **No flash.** Load `/` with `localStorage.mode = developer` set beforehand; the first
   `document.documentElement.dataset.mode` observed by an `addInitScript` observer is `developer`.
2. **Fixed viewport.** Every route in §2, both modes, 1440×900 and 1024×680:
   `scrollingElement.scrollHeight === clientHeight`, and at least one `scroll-area` present.
3. **Mode switch.** Click `mode-toggle`: `data-mode` toggles, `--accent` changes value, the
   `project-tab` set changes from four to six; `Mod+Shift+D` does the same; reload keeps it.
4. **Home.** `home-needs-you` rows link to their project; `project-row` count equals the
   workspaces seeded; `feed-item` sentences contain no bare event type (`/^[a-z_]+\.[a-z_]+$/`).
5. **Team.** `/w/:id` shows `team-card`s equal to the seats; `team-doing` never prints an enum
   member; the seeded live run's card has `data-progress` > 0; `/w/:id/organization` lands on
   `/w/:id` with `organization-*` present.
6. **Supervisor.** `right-panel` open on first visit; `panel-collapse` then reload → `right-dock`;
   `Mod+J` re-opens; at 1200×800 `data-right="overlay"`.
7. **Sheet.** `new-project` opens `sheet`, `Escape` closes it, focus returns; with
   `reducedMotion: 'reduce'` the sheet's computed `transition-property` has no `transform`.
8. **People.** Simple: `hire-from-catalogue` opens a sheet holding the catalog's testids; a row
   click opens `person-sheet` with `slave-panel` inside and `?slave=` set.
9. **Office.** `office-toolbar` present, no element inside `main` outside the canvas has
   `font-family` containing `Silkscreen` or `monospace` in simple mode.
10. **Rule 2.** Every route in `docs/ia.md`'s tables, every `?tab=`, `?mode=`, `?view=` value:
    200 in both modes.
11. **Vocabulary and imports.** `npm run gate:m26-vocabulary` exit 0; `grep -rn "from 'motion"
    apps/web/src` lists exactly `ui/Sheet.tsx` and `ui/motion.ts`; `grep -rn "transition: all\|transition-all"
    apps/web/src` is empty.

## 6. Out of scope

Desktop packaging (Tauri or Electron) — this milestone only obeys its constraints (fixed viewport,
1024×680 floor, self-hosted fonts, no window-size assumptions). A company-wide SSE. A per-day spend
formula. Redesigning Graph, Analytics, Simulations, Knowledge, Evidence beyond R19. A command
palette beyond the existing `⌘K` jump. Touch gestures beyond the Sheet's drag. Any domain, db,
event, provider or orchestrator change. Any new refusal kind.

## 7. Errata

Appended during execution in the form `**En (amends Rx)** — <claim>.`

- **E8 (amends R7/R11)** — `GET /api/w/:id/needs-you` is a third additive web route (over the
  unchanged `buildNeedsYou`), so the command strip's needs-you bar can refresh on the stream's
  wake-up without re-reading the whole Team snapshot; found while planning Task 6.
