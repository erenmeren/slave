# M57 — UI redesign (shell + every page + the Supervisor panel)

First milestone after the `2026-09-10-roadmap-m44-m56.md` roadmap closed (M44–M55 merged, M56a merged
at `c828f8c8`; M56b/M56c deferred — neither CLI has an account on the operator's machine). It is a
**presentation milestone**: it rebuilds the operator web UI in `apps/web` against a design prototype
and a handoff README, and it touches no domain rule, no event, no migration, no control verb and no
route. Designed 2026-09-14 from three inputs read end to end:

1. `Slave of AI App.dc.html` (707 lines: a CSS block at 10–27, an HTML template at 28–403 and a
   `Component` class with the whole state machine at 404–705) — **the spec for pixels and
   behaviour**, a working prototype driven by fake in-memory state;
2. the handoff README (`design_handoff_ui_redesign/README.md`, recovered to the session scratchpad as
   `design/README.md`) — the IA table, the per-screen specs, the token values, the type scale and the
   interaction list;
3. a condensed survey of `apps/web` as it stands today (93 component/test files under
   `apps/web/test/`, 370 test files in the tree, 31 CI gates, ~102 API routes).

It extends M44's information architecture (`docs/ia.md`, R1/R2/R7), M45's project experience (the
brief, the needs-you queue, the Supervisor request box), M24's shell split (project header + tab
strip mounted by the project layout, `useShellFacts`/`useStreamState` as module pub/sub stores), and
M14's fidelity gate (13 committed PNGs and a table of computed-style numbers read off a README).
Every **Ruling** below took the controller's direction under the user's standing approval; where the
repository forces a different shape than the direction assumed, the ruling carries an inline
*(verified: …)* note. "Slave" is this project's word for an AI worker.

**Goal.** One navigation a person can predict, one action cluster, one status vocabulary, and light
as well as dark — without removing a single capability, a single route or a single testid the gates
hold. The `ProjectTabs` strip and its `Advanced ▾` menu stop being where a project's sections live;
a sidebar tree holds them, with the project's own `VIEWS` (Graph / Office / Analytics) as visible
chips rather than a menu. The top bar becomes a breadcrumb and one split button. The Overview opens
with what needs a person. The Supervisor stops being a panel behind a disclosure on one page and
becomes a persistent right panel on every project page, with conversation history, collapsing to a
52 px dock. And the whole product renders in light or dark, following the operating system by
default. **Nothing below changes what the product DOES**: the proof of that is that the domain,
`packages/control`, `packages/db`, `packages/events`, the orchestrator and all ~102 API routes appear
in no task's file list except the three additive web routes R14 names.

**Facts the design stands on.** `apps/web/src/app/globals.css` (290 lines) declares `:root` **dark
only** — there is no `data-theme`, no `prefers-color-scheme` block, no theme provider and no
`localStorage` read anywhere in the tree (`grep -rn "prefers-color-scheme\|data-theme" apps/web/src`
returns nothing). Tailwind v4 is configured **inside that file** by `@theme inline` (there is no
`tailwind.config.*`), so every token a utility class can reach is a `--color-*`/`--radius-*` name
mapped there from a `:root` custom property. `apps/web/src/app/layout.tsx` (48 lines) loads
`IBM_Plex_Sans`/`IBM_Plex_Mono` through `next/font/google` and puts their `.variable` classNames on
`<html>`; `apps/web/src/app/w/[workspaceId]/office/page.tsx:9` does the same with `Silkscreen` and a
`--font-pixel` variable it also hands to a canvas as `pixel.style.fontFamily`.
`apps/web/src/components/Sidebar.tsx` (98 lines) is four `nav-row` links, a `skip-link` and a
CSS-only 212 px → 52 px collapse; it reads no per-route data.
`apps/web/src/components/project/ProjectHeader.tsx` (133 lines) and `ProjectTabs.tsx` (157 lines) are
mounted as SIBLINGS of `{children}` by `app/w/[workspaceId]/layout.tsx`, which is why
`hooks/useShellFacts.ts` and `hooks/useStreamState.ts` are module-level `useSyncExternalStore`
publishers and not React context — "nothing a page mounts is ever an ancestor of them"
(`useShellFacts.ts:11-16`). `hooks/useWorkspaceStream.ts` (133 lines) opens ONE `EventSource` per
workspace page, debounces a refetch of ONE endpoint by 250 ms on every wake-up, and hands back
`{snapshot, connection, error, latencyMs}`. `SlavePanel.tsx` (624 lines) and `TaskDetailPanel.tsx`
(776 lines) are hand-rolled `<aside className="fixed inset-y-0 right-0 z-10 … w-96 …">` elements —
deliberately NOT `Drawer`s (`docs/ia.md`, "Panels that stay where they are") — opened from
`hooks/useSelectedId.ts`'s `?slave=`/`?task=` params by `OverviewClient.tsx:292`,
`TasksClient.tsx:78` and `workforce/WorkforceClient.tsx:235`. `lib/taskColumns.ts` holds SIX board
columns keyed by a total `Record<TaskStatus, BoardColumn>`. `packages/domain/src/status/user.ts` owns
every status WORD a person reads (`USER_TASK_LABEL`, `USER_CARD_LABEL`, `USER_WORKSPACE_LABEL`,
`userSupervisorStatus`). There is **no workspace-level pause route** — `grep -rn "pause"
apps/web/src/app/api/w/` returns nothing, and only `runs/[runId]/pause` and `resume` exist — and
**no clear-halt route at all**: `clear-halt` is a CLI case (`apps/orchestrator/src/cli.ts:1718-1729`)
that writes `{haltedReason: null, haltedAt: null}` with a bare Prisma update and emits no event.
`pauseActiveRuns(workspaceId, requestedBy, category)` (`packages/control/src/pause.ts:158`) already
exists and is already exported through the barrel (`index.ts:57`). `next/font/local`'s `src` array
entries accept **only** `path`, `weight` and `style` — there is no per-file `unicodeRange`
(`node_modules/next/dist/compiled/@next/font/dist/local/index.d.ts`) — while `declarations` IS
accepted and is applied to every `@font-face` a call generates, with only `src`, `font-display`,
`font-weight` and `font-style` forbidden (`validate-local-font-function-call.js:48-54`). The gate
roster ends at `gate:m56a-provider-contract`, the 31st, in four places: `package.json:70`,
`.github/workflows/ci.yml:88`, README's roster sentence at `:990` and its count line at `:1088` —
which has moved on every milestone and is therefore found by
`grep -n '^[0-9]\+ gates\.' README.md`, never by line number.

---

## 1. Rulings

### The foundation

- **R1 — Tokens are ADDED, never replaced: every old name becomes an alias of a new one, and
  nothing is deleted from the sheet.** `globals.css` gains the README's token names — `--bg`,
  `--panel`, `--card`, `--line`, `--line2`, `--t1`, `--t2`, `--t3`, `--hover`, `--sel`, `--accent`,
  `--accent-ink` and the eight `--s-*` status tones — defined three times: on bare `:root` (the LIGHT
  palette), under `@media (prefers-color-scheme: dark)` guarded as `:root:not([data-theme='light'])`,
  and again under `:root[data-theme='dark']`. Every name the tree already paints with —
  `--bg-0/1/2`, `--bg-selected`, `--bg-card-alt`, `--bg-canvas`, `--bg-floor`, `--text-1/2/3`,
  `--text-faint`, `--text-body`, `--text-dim`, `--line-hover`, the eight `--tone-*`, the eight radii,
  `--shadow-resting`, `--font-sans`, `--font-mono` — **stays declared, with its value rewritten to
  `var(<new token>)`**, so that a component nobody has restyled yet keeps rendering, and keeps
  rendering CORRECTLY IN BOTH THEMES, on the day the theme switch lands. The `@theme inline` block is
  extended with the new names and loses none of the old ones. *(verified: this is the only shape that
  works. `@theme inline` is what turns a custom property into a Tailwind utility, and ~90 files in
  `src/` spell utilities like `bg-bg-1`, `text-text-2`, `border-line`. Deleting a token breaks the
  BUILD in one file and the RENDER in eighty-nine; rewriting each of those files is a diff this
  milestone cannot land in one milestone and cannot review. An alias costs one line each and is
  exactly reversible.)* Nothing is removed, only moved — `docs/ia.md` rule 2, applied to a
  stylesheet. Which old name maps onto which new one is §3's table.

- **R2 — The theme is an attribute on `<html>`, a `localStorage` key, and a pre-hydration script;
  "absent" means "follow the system".** `data-theme="light"` or `data-theme="dark"` on the root
  element pins a theme; the ABSENCE of the attribute is `system` and is resolved by the
  `prefers-color-scheme` media query R1 guards. The choice is persisted in `localStorage` under the
  key `theme` with the three values `system | light | dark`. A tiny **inline** `<script>` in the root
  layout's `<head>`, running before first paint, reads that key and stamps the attribute — so a
  person who chose Light never sees a dark frame flash. `components/theme/ThemeProvider.tsx` holds
  the same value in React state, writes the attribute and the key on every change, and subscribes to
  `matchMedia('(prefers-color-scheme: dark)')` so `system` tracks the operating system live;
  `useTheme()` returns `{theme, resolved, setTheme, cycle}`. The sidebar footer's pill cycles
  System → Light → Dark (the prototype's `toggleTheme`, `App.dc.html:255`); Settings → Appearance is
  the same three values as a segmented control. *(verified: the prototype persists under
  `'soa-app-theme'` (`App.dc.html:98,107`). This milestone uses the plain key `theme`, per the
  controller's direction; nothing reads the prototype's key, so there is no migration to write.)*
  A theme that cannot be read before hydration is a flash, and a flash is the one defect a person
  notices on every single page load.

- **R3 — Fonts are self-hosted through `next/font/local`, and the per-subset `unicode-range` is
  carried by `declarations`, not by `src`.** Six woff2 files (Instrument Sans normal + italic ×
  latin + latin-ext, variable weight `400 700`; JetBrains Mono normal × latin + latin-ext, variable
  weight `400 600`) are copied into `apps/web/src/app/fonts/` and loaded by **four** `localFont()`
  calls — one per family per subset — each carrying `declarations: [{ prop: 'unicode-range', value:
  … }]` and `adjustFontFallback: false`, exposing four CSS variables
  (`--font-sans-latin`, `--font-sans-ext`, `--font-mono-latin`, `--font-mono-ext`). `globals.css`
  then composes the two public names as stacks:
  `--font-sans: var(--font-sans-latin), var(--font-sans-ext), ui-sans-serif, system-ui, sans-serif`
  and `--font-mono: var(--font-mono-latin), var(--font-mono-ext), ui-monospace, monospace`. The two
  `next/font/google` IBM Plex imports go away. The Office page's `Silkscreen` import **stays exactly
  as it is** — it is a pixel font handed to a canvas by hashed family name
  (`office/page.tsx:9,26`), it is not part of this type scale, and re-hosting it is a change with no
  user-visible effect and a canvas-shaped risk. *(verified: `next/font/local`'s `src` entries accept
  only `path`/`weight`/`style`, so a single call over all four Instrument Sans files would emit four
  `@font-face` rules with identical descriptors and only the last would survive; `declarations` is
  applied to every face a call generates and `unicode-range` is not on its forbidden list, so one
  call PER SUBSET is the only shape that keeps the split. Two families in one stack fall back on a
  codepoint out of range exactly the way one family with two faces does, which is why
  `adjustFontFallback: false` is required: an auto-generated metric-override fallback family carries
  no `unicode-range`, so it would sit between the latin and latin-ext faces and swallow every
  latin-ext glyph.)*

### The shell

- **R4 — One shell component owns the frame, and it is a CSS grid, not four nested flexes.**
  `apps/web/src/components/shell/AppShell.tsx` renders
  `grid-template-columns: 236px minmax(0, 1fr) <right>` where `<right>` is `372px` when a right panel
  is open, `52px` when it is collapsed to the dock, and nothing at all on a global route; the frame
  carries `min-width: 1280px` (the README's "window/app frame min-width 1280px"). It is mounted ONCE,
  by the root layout, around `<main id="main" tabIndex={-1}>`; the workspace layout mounts only the
  header's own facts. The 1280 px floor replaces M44's `max-[899px]` sidebar collapse: the prototype
  is a desktop operator console and the README states a minimum width rather than a breakpoint, so
  the collapse rule is deleted along with `Sidebar.tsx`. *(This is a deliberate reduction in
  responsive behaviour and it is named here so that nobody reads it as an oversight; `docs/ia.md`'s
  responsive line is rewritten in the same task.)*

- **R5 — The sidebar is a TREE, and its data is one server read model refreshed from one existing
  stream.** `components/shell/SidebarTree.tsx` renders, top to bottom: the brand row (26 px accent
  square, `13.5px/600` name, `11.5px` muted sub), a `⌘K` search field, a `Projects` row with a count,
  one row PER PROJECT (7 px status dot from `userWorkspaceStatus`, name, needs-you count in
  `--s-waiting` mono 11 px), and — nested under the CURRENT project only — the six section rows
  Overview / Tasks / Team / Knowledge / Activity / Settings, a `VIEWS` section label and the three
  chips Graph / Office / Analytics; then `Workforce`, `Simulations`, `Settings`; then a footer with
  `● live · Nms` and the theme pill. Its data is `apps/web/src/server/sidebar.ts`'s
  `buildSidebarTree(): Promise<readonly SidebarProject[]>`, each row `{id, name, archived, status,
  needsYouCount, tasksActive}` — built ONCE in the root layout (server-side, so the first paint is
  correct) and refetched client-side from a new `GET /api/sidebar` on two triggers: a route change,
  and a wake-up from the CURRENT workspace's stream, read through the existing `useShellFacts`
  publication rather than by opening a second `EventSource`. *(verified: `useShellFacts` is already
  published by all five workspace page clients and already re-published on every 250 ms-debounced
  refetch, so its identity changing IS the wake-up signal, and the sidebar costs no new connection —
  the exact defect `useShellFacts.ts:18-24` exists to prevent.)*

- **R6 — `sectionOf(pathname)` is one pure function in one file, and it owns the breadcrumb and the
  VIEWS list too.** `apps/web/src/lib/routes.ts` exports `SECTIONS`, `VIEWS`, `sectionOf(pathname):
  Section | null`, `workspaceIdOf(pathname): string | null`, `isGlobalRoute(pathname): boolean` and
  `breadcrumbOf(pathname, projectName): readonly Crumb[]`. Nothing else in the tree may derive "which
  section am I on" from a pathname. It is a pure module with no React import, so it is unit-tested
  without a DOM and the gate can assert the same table the UI renders. **`Team` is the label of the
  EXISTING `/w/:id/organization` route** and `Knowledge` of `/w/:id/knowledge`; not one route string
  changes anywhere in this milestone (`docs/ia.md` rule 2).

- **R7 — The header is 54 px and holds four things: a breadcrumb, a halt pill, the money, and one
  split button — plus a slot a page fills.** `components/shell/Header.tsx` renders the breadcrumb
  `Projects / <project> / <section>` (13 px, `--t3` segments, last one `--t1` 600), the HALTED pill
  when `haltedReason !== null`, the budget `$x / $y` in mono 12.5 px beside a 100 × 5 px bar, a
  1 × 20 px divider, and the `Pause all | Stop ▾` split button — `Stop ▾` arms to
  `Stop everything` + `Cancel` on the first click and fires on the second, and reads `Clear halt`
  while the workspace is halted. A page contributes its own primary action (`+ New project`,
  `+ New slave`, `+ New simulation`) through `HeaderActionProvider`/`useHeaderAction(node)` —
  **React context state, not a DOM portal**, because the header is mounted by the ROOT layout and a
  portal would need a ref to an element that does not exist on the server's first render.
  *(verified: `useShellFacts` cannot serve here — it is keyed to one workspace and the page action
  exists on global routes too — and a second module-level store for a React node would hold a
  detached subtree across route changes. The provider is mounted by the root layout, which IS an
  ancestor of every page, so context is available here in a way it was not in M24.)*

- **R8 — The right panel is a slot with a mode, and the two big panels move into it by changing one
  className each.** `components/shell/RightPanelProvider.tsx` holds
  `{mode: 'supervisor' | 'task' | 'slave' | null, collapsed: boolean, payload}` plus
  `open(mode, payload)`, `close()` and `collapse()`. On a `/w/:id/*` route the default mode is
  `supervisor`; `SlavePanel` and `TaskDetailPanel` keep `useSelectedId('slave'|'task')` as their
  source of truth — the URL is still what a refresh restores — and a small effect in each owning page
  client mirrors that selection into the provider, so the panel RENDERS in the slot and replaces the
  Supervisor content while it is open. `»` collapses to a 52 px dock: a 34 px accent `S` button
  carrying the pending-decision count as a badge, and an `A` button linking to Activity. On a global
  route (`/`, `/workforce`, `/settings`, `/sim*`, `/analytics`) there is no panel and no dock, and
  the grid's third column is absent. **`SlavePanel.tsx` and `TaskDetailPanel.tsx` are not rewritten**:
  their 624 and 776 lines of content, their thirty-odd testids and their control POSTs are
  untouched, and the ONLY edit to each is its outer `<aside>`'s className — `fixed inset-y-0 right-0
  z-10 … w-96` becomes `flex h-full w-full flex-col … overflow-y-auto`, because the slot now owns the
  372 px and the position. *(verified: both files' outer element is a single `<aside>` at
  `SlavePanel.tsx:284-288` and `TaskDetailPanel.tsx:253-263`; everything below it is already a
  vertical flex column that fills its parent.)* Workforce's `⋯` keeps opening `SlavePanel` in ITS own
  page frame, not in the right panel — Workforce is a global route and has no third column.

### The Supervisor panel

- **R9 — Threads are a UI grouping over events that already exist: one thread per local calendar
  day. No table, no event type, no migration.** `apps/web/src/server/supervisorThreads.ts` reads the
  `ExecutionEvent` rows of one workspace whose type is in a fixed list —
  `workspace.goal_set`, `supervisor.proposed`, `supervisor.decided`, `supervisor.resolved`,
  `supervisor.applied`, `supervisor.failed` — and folds them into
  `SupervisorThread { id, title, when, messages }` where `id` is the local calendar day (`YYYY-MM-DD`
  in the server's zone) and a message is
  `{ id, who: 'operator' | 'supervisor', text, at, refs, decisionId }`. A `workspace.goal_set` that
  carries `payload.request` is the OPERATOR's message (the words a person typed — M45 R3 put them
  there for exactly this reason); everything else is the Supervisor's, rendered through the existing
  `feedSummary(type, payload)`. Decision cards inside a message come from the EXISTING pending-
  decisions read (`buildSupervisorView`'s `pending`, i.e. `listDecisions(workspaceId, {pending:
  true})`), matched onto a message by `decisionId`, and Approve/Decline POST to the EXISTING
  `supervisor/decisions/:id/approve|reject` routes. The composer POSTs to the EXISTING
  `POST /api/w/:id/goal/request` (`requestChange`), which is what `SupervisorRequest.tsx` already
  does. **The `+` "new conversation" button starts a thread for TODAY and is otherwise inert** —
  there is no row to create — and `≡` lists the days. *(verified: `workspace.goal_set`'s payload has
  carried an optional `request: string` since M40/M45, `packages/domain/src/events/schema.ts:265-283`;
  nothing about this reading needs a column. A thread is a DAY and not a conversation id precisely
  because there is no conversation id to be had, and inventing one needs a table this milestone
  refuses to add.)*

### The pages

- **R10 — Five task columns, from the README's mapping, replacing six.** `lib/taskColumns.ts`'s
  `BoardColumn` becomes `'Queued' | 'In progress' | 'Review' | 'Blocked' | 'Done'` and
  `COLUMN_FOR_STATUS` stays a total `Record<TaskStatus, BoardColumn>` — which is the load-bearing
  part — mapping `backlog|ready|rework|assigned → Queued`, `running|verifying|waiting → In progress`,
  `reviewing|merging → Review`, `blocked → Blocked`, `done|failed|cancelled → Done`.
  `COLUMN_STATE` keeps one `CardState` per column (`Queued: 'planning'`, `In progress: 'working'`,
  `Review: 'review'`, `Blocked: 'blocked'`, `Done: 'completed'`). A card's label is `USER_TASK_LABEL`
  — the domain's word, never the column's. The board gains a Board ⇄ List toggle, a search box, a
  `Needs you · n` filter and assignee chips, all client-side over the snapshot the page already
  holds. *(Note against `docs/ia.md`: that file records "the Tasks board's pill keeps its board
  vocabulary in M44" — M57 is the milestone that closes it, and §4 rewrites the line.)*

- **R11 — `ProjectTabs.tsx`, `OverviewAdvanced.tsx` and their tests are DELETED, and this does not
  breach `docs/ia.md` rule 2.** Rule 2 says *nothing is removed, only moved* — it is about
  DESTINATIONS, not about the widgets that point at them. Every destination those two components
  carried survives at the same URL and is reachable in one click: the six tabs become the sidebar
  tree's six section rows; `Advanced ▾`'s Graph, Office and scoped Analytics become the `VIEWS`
  chips; the Overview disclosure's four panels are re-homed — the Supervisor panel becomes the RIGHT
  PANEL on every project page (a promotion, not a removal), `blocked · needs you` becomes the
  Overview's own **Needs you** card, and the live-events river and the merge queue move onto the
  Overview's **Recent changes** section and the Tasks board's Review column respectively, with
  `/w/:id/activity` remaining the full river. `ProjectHeader.tsx`, `Sidebar.tsx` and
  `ProjectSwitcher.tsx` are deleted in the same task that mounts their replacements. §3's table names
  every testid that dies and the one that replaces it; §4 rewrites `docs/ia.md` to describe the tree.

- **R12 — Every testid the IA does not remove is preserved VERBATIM, and every gate that asserts a
  removed one is updated in the same task that removes it.** The gates are the contract. Six gate
  scripts hold a testid this milestone moves — `gate-m44-ux-foundation.mjs` (lines 610, 676, 694-743,
  842, 930, 1104), `gate-m14-fidelity.mjs` (928, 941), `gate-m18-skill-and-teeth.mjs` (845, 846,
  863), `gate-m49-memory.mjs` (1534, 1537, 1546, 1547), `gate-m47-team-formation.mjs` (966) and
  `gate-m11-shell.mjs` (445, 446) — and each is edited in the task that moves the testid, never
  later. The Workforce page's four tabs KEEP the ids `slaves | catalog | skills | evidence` even
  though their labels become People / Catalog / Skills & runbooks / Evidence, and the two folded
  tabs keep `workforce-tab-departments` and `workforce-tab-runbooks` verbatim on the segmented
  controls that replace them — so `gate-m11`, `gate-m14`, `gate-m44` and `gate-m48` need **no edit at
  all** for Workforce, and every `?tab=` bookmark still lands where it did.

- **R13 — Workforce goes from six tabs to four, and `?tab=` keeps all six values.** People (a
  segmented control over the existing `AllSlavesTable` and `DepartmentsTable`), Catalog, Skills &
  runbooks (a segmented control over the existing `SkillsClient` and `RunbooksTab`), Evidence. The
  six `WorkforceTab` values stay the URL vocabulary; the four visible tabs and the two segments are a
  rendering of them. Nothing inside any of the six panels is rewritten — this is the same MOVE
  operation M44 R1 performed on the same page.

- **R17 — the Overview follows the README's order exactly, and `ProjectBrief` BECOMES the four fact
  tiles.** Five bands: title row (H1 + `userWorkspaceStatus` pill + goal line + `Edit goal`), the
  Needs-you card, four fact tiles, Team rows, Recent changes. `TopStrip` is removed as a widget and
  its `strip` testid moves onto the fact-tiles container. Stated in full in §6, with the controller
  ruling that produced it.

- **R18 — the Overview's Team is ROWS on the README's `34px 120px 120px 1fr 96px 32px` grid**, by
  restyling `SlaveCard.tsx`, which renders on this page and nowhere else. Stated in full in §6.

### The plumbing this milestone must add

- **R14 — Three additive web routes, no new control verb but one, and no new event type.**
  (a) `POST /api/w/:id/runs/pause-all` calls the EXISTING `pauseActiveRuns(workspaceId, 'web
  operator', 'human')` (`packages/control/src/pause.ts:158`, already exported by the barrel) —
  nothing new at all. (b) `POST /api/w/:id/runs/resume-all` loops the EXISTING per-run
  `requestResume(runId, null, 'web operator', principal)` over this workspace's paused runs, in the
  WEB server layer, reporting `{requested, refused}` the way `pauseActiveRuns` does. (c)
  `POST /api/w/:id/clear-halt` is needed because **there is no clear-halt route in the web at all** —
  the CLI does it inline with a bare Prisma update (`cli.ts:1718-1729`). Rather than write that
  update a second time, `packages/control/src/emergency.ts` gains
  `clearHalt(workspaceId): Promise<Result<{cleared: boolean}, ControlRefusal>>` holding exactly what
  the CLI case holds today, the CLI case is rewritten to call it, and the new route calls it through
  `workspaceControlResponse`. **It emits no event, because the CLI's version emits none** and this
  milestone changes no behaviour. *(This is the one item in the whole milestone the inputs did not
  settle: the brief said "the existing clear route", and there isn't one. A third copy of the same
  two-column update was the alternative, and it is worse.)*

- **R15 — Reduced motion and the accessibility floor are carried forward unchanged.** The skip link
  stays first in the document and still targets `#main`; the sidebar keeps `role="navigation"` named
  `"Primary"`; there is exactly one `<main>` and it is `#main` with `tabindex="-1"`; every new
  interactive element takes a visible `focus-visible` ring; every animation stays behind Tailwind's
  `motion-safe:` variant, which `globals.css`'s `prefers-reduced-motion: reduce` block already kills
  outright. Labels are never keys (`docs/ia.md` rule 3): `PROVIDER_LABEL` for providers, the domain's
  `user.ts` words for every status, and the raw value stays in `title`/`data-*`. Simulations show
  `§` and never `$` (rule 4).

- **R16 — The gate is `gate:m57-ui-redesign`, CI's 32nd, and it drives a fake CLI only.**
  Ten stages, listed in §5. It is followed — in the same task, as the last thing the milestone does —
  by `gate-m14-fidelity.mjs`'s computed-style table being rewritten to the NEW README numbers and its
  13 PNGs regenerated **once**. That is the only task in this plan that regenerates a PNG, and it
  does so in its own commit.

---

## 2. Surfaces after M57

- **Frame.** `AppShell`: sidebar 236 px · main fluid · right panel 372 px / dock 52 px / nothing.
  Min-width 1280 px. Light and dark, system by default.
- **Sidebar.** Brand · `⌘K` field · `Projects` + one row per project (dot + needs-you count) · the
  current project's six section rows + a `VIEWS` chip group · `Workforce` · `Simulations` ·
  `Settings` · footer `● live · Nms` + theme pill.
- **Header.** Breadcrumb · HALTED pill · budget + bar · `Pause all | Stop ▾` (armed → `Stop
  everything` + `Cancel`; halted → `Clear halt`) · the page's own primary action.
- **Right panel.** Supervisor by default on `/w/:id/*` (header, conversations list, thread, messages
  with decision cards, composer), replaced by `SlavePanel` or `TaskDetailPanel` while one is
  selected; `»` → a 52 px dock with `S` (badged) and `A`.
- **`/`** Projects: cards (`auto-fit minmax(300px,1fr)`), a needs strip per card, the five-tile
  "Across every project · last 7 days" panel.
- **`/w/:id`** Overview, in five bands (R17/R18): title + status pill + goal line → **Needs you** →
  four fact tiles (`ProjectBrief`, rebuilt from eight: Work bar, Cost, Supervisor + runbook line,
  Latest verified + Knowledge) → **Team rows** (`SlaveCard`, rebuilt from a card) → Recent changes
  (`SupervisorTimeline`). `TopStrip` is gone; its `strip` testid marks the tile grid.
- **`/w/:id/tasks`** Tasks: filter row, Board (5 columns) ⇄ List.
- **`/w/:id/organization`** Team: worker cards with lifecycle, "Now:", "Why here:", capability chips.
- **`/w/:id/knowledge`** Knowledge: segmented All / Verified / Candidates, rows with Verify/Remove.
- **`/w/:id/activity`** Activity: `200px 1fr` — family rail with volume bars, event rows with
  payload disclosure.
- **`/w/:id/settings`** Project settings: `180px minmax(0,760px)`, sticky in-page nav, four sections.
- **`/w/:id/graph`, `/office`, `/analytics?workspace=`** — content unchanged, re-homed under `VIEWS`.
- **`/workforce`** four tabs, six `?tab=` values.
- **`/sim*`** dashed cards, `§`.
- **`/settings`** provider adapter cards, Appearance (System/Light/Dark), Security.

## 3. The testid vocabulary

### Introduced

| testid | Where | What it marks |
|---|---|---|
| `app-shell` | `AppShell` | the grid frame; `data-right` is `panel`/`dock`/`none` |
| `sidebar-tree` | `SidebarTree` | the `navigation` landmark named "Primary" |
| `sidebar-project` | one per project row | `data-project-id`, `data-status` (raw `UserWorkspaceState`) |
| `sidebar-needs-you` | inside a project row | the amber count; absent at zero |
| `sidebar-section` | one per section row | `data-section` = `sectionOf`'s value |
| `sidebar-view` | one per VIEWS chip | `data-view` = `graph`/`office`/`analytics` |
| `sidebar-global` | Workforce/Simulations/Settings | `data-nav` carries the label (the old `nav-row` contract, renamed) |
| `sidebar-search` | the ⌘K field | `aria-disabled="true"` — rendered, inert this milestone (§6) |
| `sidebar-live` | footer | `● live · Nms`; `data-connection` = `idle`/`reconnecting`/`connected` |
| `theme-toggle` | footer pill | `data-theme-mode` = `system`/`light`/`dark` |
| `app-header` | `Header` | 54 px header |
| `breadcrumb` | in the header | `data-crumbs` = the segments, `/`-joined |
| `halted-pill` | in the header | present only while halted |
| `pause-all` | split button, left | label flips Pause all ⇄ Resume all |
| `stop-split` | split button, right | `data-armed`; label `Stop ▾` / `Stop everything` / `Clear halt` |
| `stop-cancel` | split button | present only while armed |
| `budget-bar` | beside `budget` | absent on an unbudgeted project |
| `header-error` | the header | `role="alert"`, a refusal from one of the three buttons |
| `header-action` | the page's slot | wraps whatever `useHeaderAction` was given |
| `right-panel` | `RightPanel` | `data-mode` = `supervisor`/`task`/`slave` |
| `right-dock` | `RightPanelDock` | the 52 px rail |
| `dock-supervisor` / `dock-activity` | in the dock | the `S` and `A` buttons |
| `dock-badge` | on `S` | the pending-decision count; absent at zero |
| `panel-collapse` / `panel-close` | the slot's header | the `»` and, while a mode is open, the `✕` |
| `supervisor-thread` | the thread body | `data-thread-id` = the day |
| `supervisor-thread-row` | the `≡` list | one per day |
| `supervisor-history` / `supervisor-new` | the panel's own bar | the `≡` and the `+` |
| `supervisor-message` | one per message | `data-who` = `operator`/`supervisor` |
| `supervisor-decision-card` | inside a message | `data-decision-id`, `data-situation-kind` |
| `supervisor-decision-approve` / `-decline` | inside a card | the two answers |
| `supervisor-composer` | the composer wrapper | Enter sends, Shift+Enter newlines |
| `supervisor-empty` | the thread body | "nothing has been said yet" |
| `needs-you-card` / `needs-you-row` | Overview | `data-kind` from `NeedsYouItem.kind` |
| `needs-you-approve` / `-decline` / `-open` | on a row | buttons for a decision, a link for the rest |
| `needs-you-empty` | Overview | the dashed "nothing needs you" box |
| `project-title` / `project-goal-line` | Overview band 1 | the H1 + pill row, and the goal sentence the `objective` tile's fact moved to |
| `card-unblock` | a Team row | the primary button's fourth state (R18). It keys off the TASK — `slave.taskStatus === 'blocked'` — never `slave.status`, which is a `SlaveStatus` with no `blocked` member (erratum E14) |
| `card-more` | a Team row | the `⋯` that opens `SlavePanel` |
| `supervisor-request-error` | the Supervisor composer | the refusal line. The SUCCESS line beside it keeps the old `supervisor-request-result` testid, because that is the one `gate-m45` stage 5 waits for after a send (erratum E17) |
| `workforce-segment-<id>` | Workforce | the two folded tabs, as segments. `workforce-tab-*` stays on the FOUR top tabs only (erratum E15) |
| `recent-changes` | Overview | the section wrapping `supervisor-timeline` |
| `task-search` / `task-filter-needs-you` / `task-filter-assignee` | Tasks | the filter row |
| `task-view-toggle` / `task-view-board` / `task-view-list` | Tasks | `data-view` = `board`/`list` |
| `task-list` / `task-list-row` | Tasks, list mode | the table and one row per task |
| `column-empty` | a board column | the dashed "nothing here" box |
| `appearance-theme` (+ `-system`/`-light`/`-dark`) | Settings | `data-theme-mode` mirrors the pill's |

### Removed, and what replaces it

| Removed | Replaced by | Where the gates are updated |
|---|---|---|
| `nav-row` (+ `data-nav`) | `sidebar-global` (+ `data-nav`, same values) | `gate-m44` 610, 1104; `shell.test.tsx` |
| `project-tab-<id>` | `sidebar-section` + `data-section` | `gate-m44` 676; `gate-m49` 1534/1537/1546/1547; `gate-m47` 966; `project-tabs.test.tsx` (deleted), `project-layout.test.tsx` |
| `project-tab-badge-tasks` | `sidebar-section[data-section=tasks]`'s own count span | `project-layout.test.tsx` |
| `project-advanced` | `sidebar-view` (there is no menu) | `gate-m44` 700, 725-743 |
| `advanced-item-graph` / `advanced-item-office` | `sidebar-view[data-view=graph|office]` | `gate-m44` 694-734 |
| `analytics-link` | `sidebar-view[data-view=analytics]` | `project-tabs.test.tsx` (deleted) |
| `overview-advanced` / `overview-advanced-toggle` | nothing — the four panels are re-homed (R11) | `gate-m44` 842; `gate-m14` 928; `overview-components.test.tsx` |
| `advanced-panel-supervisor` | `right-panel[data-mode=supervisor]` | `gate-m44` 930 |
| `advanced-link-graph|office|analytics` | `sidebar-view` | `overview-components.test.tsx` |
| `strip` (on `TopStrip`) | the SAME testid, **moved** onto the fact-tiles container (R17) | no gate edit — `gate-m14` 773/1132, `gate-m44` 769 and `gate-m49` 1529 only wait on it |
| `strip-tile`, `strip-value-*`, `strip-unmeasured`, `strip-supervisor-spend` | the Work and Cost tiles' own `brief-work-*` and `brief-cost-*` spans | `overview-components.test.tsx` only — no gate reads them |
| `brief-tile[data-brief=objective\|needs-you\|team\|recent-changes]` | the title row, the Needs-you card, the Team rows and `supervisor-timeline` (R17) | `gate-m45` 95-104 (`EXPECTED_BRIEF_FACTS`), 770-780 (two `wants` pairs each), 794-805 |
| `card-message`, `card-stop` | the `⋯` → `SlavePanel`, where the FACT is reachable under `message-box`/`message-input` and `stop-button` — **not** under these testids | `overview-components.test.tsx` only — no gate reads either |
| `card-task-ref`, `card-step`, `card-skill-chip`, `card-waiting-for`, `card-resume-requested` | `SlavePanel`: the id is in its header, the step at `run-paused-step`, the skill at `panel-skill`, and the last two at `waiting-for` and `resume-requested`. **The fact is reachable; the testid is not the same one** | `overview-components.test.tsx` only — no gate reads any |
| `card-percent`, `card-queue-chip` | **Nothing carries these facts as a testid after M57.** `SlavePanel` renders no progress bar and no queued-message chip. The row keeps the PROGRESS itself (the 4 px bar the README draws) and the queued message is still visible in the panel's message box as its initial value — but neither has a handle a test can name, and this table says so rather than claiming a move that did not happen | `overview-components.test.tsx` only — no gate reads either |
| `project-header` | `app-header` | `gate-m11` 445; `gate-m14` 941; `project-layout.test.tsx` |
| `project-header-hairline` | nothing — the new header has a plain hairline | `project-header.test.tsx` |
| `project-switcher*` | `sidebar-project` | `project-header.test.tsx` |
| `project-goal` | nothing in the header — the goal line moves onto the Overview | `project-layout.test.tsx` |
| `connection` | `sidebar-live` | `gate-m18` 845, 846, 863 |

**Preserved verbatim** (a non-exhaustive list of the ones a reader will worry about): `skip-link`,
`page-shell`, `budget`, `budget-unmeasured`, `project-archived`, `emergency-stop`, `status-pill`,
`avatar-tile`, `data-table`, `data-table-row`, `slave-card`, `task-card`, `column`, `strip`,
`brief`, `supervisor-request-input`, `supervisor-request-send`, `supervisor-request-result`,
`supervisor-timeline`, `supervisor-proposal`, `supervisor-approve`, `supervisor-decision-meta`,
`live-events`, `timeline-viewport`, `timeline-rule`, `graph-canvas`, `graph-drawer`, `slave-node`,
`office-canvas`, `office-hud-counts`, `office-focus*`, `organization-rows`, `knowledge-counts`,
`kpi-tile`, `project-card`, `empty-tile`, `security-posture`, `perm-caption`, `runtime-timeout`,
`workforce-tab-*` (all six), `catalog-*`, `profile-drawer`, `capability-chip`, every `slave-panel`
and `task-detail-*` testid, and every testid under `sim*`.

## 4. `docs/ia.md` after M57

The file keeps its four rules verbatim and its per-surface tables, and gains: a **Top-level
navigation** table describing the TREE (Projects → project → six sections + a VIEWS group; Workforce;
Simulations; Settings); a **Header** row saying the top bar is breadcrumb + halt + money + one split
button; a **Right panel** section saying the Supervisor is the default content on `/w/:id/*` and that
`SlavePanel`/`TaskDetailPanel` render in the same slot; and three corrections: the line that says the
Tasks board keeps its own six-column vocabulary in M44 is rewritten to the five README columns under
`USER_TASK_LABEL` (R10), the "Panels that stay where they are, deliberately" paragraph is rewritten
to say the two panels are still non-modal but are now SLOTTED rather than fixed (R8), and the
Overview's own `Advanced ▾` paragraph is replaced by where each of its four panels went (R11). The
file is inside `gate:m26-vocabulary`'s scope (`scripts/gate-m26-vocabulary.mjs:8-11` excludes
`docs/superpowers` and `docs/decisions`, not `docs/`) and it never quotes the design handoff README.

## 5. The gate

`scripts/gate-m57-ui-redesign.mjs` — `playwright-core` against a real `next dev`, fake CLI only
(`SLAVEOFAI_CLAUDE_BIN=scripts/gate-fakes/fake-claude.sh`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`), the
`gate-m16-chrome.mjs` shape M44's gate already copies: free port, `loopbackChildEnv`, no daemon, no
file written. It joins CI immediately after `gate:m56a-provider-contract`.

1. **Theme.** `<html>` carries no `data-theme` on a first visit; clicking `theme-toggle` twice
   stamps `light` then `dark`; a reload keeps `dark`; `localStorage.theme` reads `dark`; the
   computed `background-color` of `body` differs between the two stamps.
2. **Sidebar tree.** The `sidebar-project` rows, in order, equal a direct Prisma read of
   non-archived workspaces by name; each row's `data-status` equals `userWorkspaceStatus(...)`'s
   state for that workspace; a row with a pending decision carries a `sidebar-needs-you` whose text
   is a positive integer; the six `sidebar-section` rows appear only under the CURRENT project.
3. **Breadcrumb.** For each of the six section routes plus the three VIEWS routes plus `/`,
   `/workforce`, `/settings`, `/sim`, the `breadcrumb`'s `data-crumbs` equals
   `breadcrumbOf(pathname, name)`'s own joined output, asserted against the table the gate computes
   itself from the same rules.
4. **Right panel and dock.** On `/w/:id` the `right-panel` is `data-mode="supervisor"`; clicking a
   `task-card` makes it `task` and the URL grows `?task=`; `panel-collapse` replaces it with
   `right-dock`, whose `dock-badge` equals the pending-decision count; on `/workforce` neither
   `right-panel` nor `right-dock` exists.
5. **Needs-you approve flow.** A seeded pending `SupervisorDecision` shows as a `needs-you-row`
   with `data-kind="decision"`; Approve POSTs the existing route; the row disappears, the
   `sidebar-needs-you` count drops by one and the `dock-badge` disappears.
6. **Task columns.** The five column heads are exactly the README's five words; every `task-card`
   in each column has a `data-status` whose `COLUMN_FOR_STATUS` entry is that column, checked
   against a direct Prisma `groupBy` of the workspace's task statuses; the List toggle renders one
   `task-list-row` per task.
7. **Supervisor threads.** Two seeded `workspace.goal_set` events with a `request`, on two different
   local days, produce two `supervisor-thread-row`s; selecting the older one renders its
   `supervisor-message[data-who="operator"]` with the typed words.
8. **Computed style.** Ten README numbers read back with `getComputedStyle`: sidebar width `236px`,
   header height `54px`, right panel width `372px`, dock width `52px`, the frame's `min-width`
   `1280px`, an Overview page card's `border-radius` `14px`, a fact tile's (`brief-tile`) `border-radius` `12px`,
   a task card's `border-radius` `10px`, a status pill's `border-radius` `999px`, and the body's
   `font-size` `14px`.
9. **Vocabulary and the IA floor.** No raw enum token is visible text on the twelve pages the gate
   visits (M44's stage-4 blocklist, derived at run time from the dist enums); the `skip-link` is
   still the first focusable element; there is exactly one `<main>`, it is `#main`, and the
   `navigation` landmark named "Primary" exists on every page; no `$` appears inside a
   `data-simulation` container.
10. **Nothing was removed.** Every route in `docs/ia.md`'s tables answers 200, including
    `/w/:id/graph`, `/w/:id/office`, `/analytics?workspace=`, `/slaves`, `/skills` and
    `/workforce?tab=` for all six values.

Then, in the same task and its own commit: `gate-m14-fidelity.mjs`'s `NUMBERS` table is rewritten to
the new README values (`nav[aria-label="Primary"]` 212 → 236; `[data-testid="project-header"]` 52 →
`[data-testid="app-header"]` 54; the `live-events` 340 px row and its `openOverviewAdvanced` hook are
deleted with the disclosure they measured; the `slave-card` radius/padding rows are re-read from the
new card recipe), `PAGES`' `overview` marker stays `strip`, and its 13 PNGs are regenerated ONCE.

## 6. Out of scope, and the two places this milestone deliberately does not match the README

The domain, `packages/control` (but for R14c's `clearHalt`), `packages/db`, `packages/events`, the
orchestrator, every existing API route's behaviour, every read model's SHAPE (the three new ones are
additive), the Graph canvas, the Office canvas, the Analytics page's content, the simulation engine,
`⌘K` actually opening anything (the field is rendered per the README and is inert this milestone —
named here so nobody reads its inertness as a bug), a real conversation table for the Supervisor,
per-viewer accent colours (the prototype's `data-accent`), and any responsive behaviour below
1280 px (R4).

Two README details are deliberately not built. Each is named here so that nobody reads it as an
oversight, and each is a candidate for the milestone after this one.

1. **Workforce's People table keeps its ten columns**, not the README's seven.
   `gate:m14-fidelity` asserts the authored `grid-template-columns` string
   (`200px 110px 150px 120px 100px 110px 1fr 90px 90px 160px`) twice, by two different methods and
   for a stated reason; the README's seven-column sketch drops the lifecycle column M50 added and
   the cost column M53 reads. Reconciling the two is a data question, not a styling one.
2. **The sidebar shows a count on `Projects` only**, not on `Workforce` and `Simulations` as the
   prototype draws. Those two numbers would need two more reads in the ROOT layout — on every page
   in the product — for two figures nobody acts on from the sidebar.
3. **The Work tile's segmented bar has the READ MODEL's five keys**, not the README's. The README
   draws `working / planning / review / blocked / done`; `ProjectBriefFacts['work']` carries
   `working / verifying / review / waiting / done`, which is what `server/brief.ts` counts and what
   `gate:m45` asserts two of by name. The bar keeps the five it can actually compute, and each gets
   its OWN fill (`working → --s-working`, `verifying → --s-planning`, `review → --s-review`,
   `waiting → --s-waiting`, `done → --s-done`) so that five segments read as five and not as four.
   Changing the read model's buckets to the README's is a `server/brief.ts` change and a
   `gate:m45` change, which is a different milestone's work.

**Two further deviations were drafted here and WITHDRAWN under a controller ruling** (2026-09-14),
recorded because the reasoning that produced them is a trap the next milestone will fall into too.
The draft kept the Overview's `SlaveCard` grid and its eight-tile `ProjectBrief` on the grounds that
each carries computed-style assertions in `gate:m14-fidelity` and `gate:m45-project-experience`. The
ruling: **"a gate already measures that number" is not a reason to keep a layout the user asked to
change** — and it is a particularly bad reason in THIS milestone, whose Task 9 rewrites m14's whole
`NUMBERS` table and regenerates all thirteen screenshots regardless. A gate pins a number so that it
cannot drift by accident; it does not pin it against a deliberate, specified, reviewed change. So:

- **R17 — the Overview follows the README's order exactly**, and `ProjectBrief` becomes the four
  fact tiles rather than gaining a second tile set beside its eight. The page is: (1) title row —
  H1 + `userWorkspaceStatus` pill, goal line, `Edit goal`; (2) the Needs-you card; (3) FOUR fact
  tiles — Work (8 px segmented bar + `<b>n</b> word` list), Cost (22 px mono), Supervisor (pill +
  runbook line), Latest verified (+ Knowledge link); (4) Team ROWS; (5) Recent changes. The
  container keeps `data-testid="brief"`, each tile keeps `brief-tile` + `data-brief`, and
  `brief-supervisor-state` and the five `brief-cost-*` spans are kept verbatim —
  `gate:m51-breaker` reads four of the latter and needs no edit at all. `TopStrip` is removed as a
  widget (its raw counts fold into the Work tile, which is what the README asks for) and its
  `strip` testid **moves onto the fact-tiles container**, because three gates wait on it as the
  Overview's structural marker and none of them cares what it wraps.
- **R18 — the Overview's Team is ROWS**, on the README's `34px 120px 120px 1fr 96px 32px` grid, by
  restyling `SlaveCard.tsx` — which renders on this one page and nowhere else. Each row keeps
  `data-testid="slave-card"` with `avatar-tile` and `status-pill` inside it, so every scoped
  `gate:m14-fidelity` selector still resolves; the six numbers those selectors read are rewritten in
  Task 9 to the README's row numbers (avatar 30 × 30, row padding `10px 14px`, pill radius 999 px),
  and the `card-sweep` and `status-pulse` motion assertions are unchanged because the motion is.
  The row's one primary button keeps whichever of `card-pause` / `card-resume` / `card-answer` /
  `card-unblock` its state calls for — `gate:m14-fidelity:1295` clicks `card-pause` — and `Message`
  and `Stop` fold into the `⋯`, which opens `SlavePanel`, where both already live (`docs/ia.md`
  rule 2: moved, not removed).

## 7. Errata — where execution corrects this spec

E1–E9 are the plan's own, written before execution and argued in full at the head of
`docs/superpowers/plans/2026-09-14-m57-ui-redesign.md`; they are indexed here in one line each so
this section is the whole ledger. E10–E19 were raised by the **pre-flight conflict scan**
(`.superpowers/sdd/2026-09-14-m57-ui-redesign/preflight-scan.md`, 73 findings) and ruled by the
controller before Task 2 began; each names the finding it closes. E20–E39 are EXECUTION's own —
one per controller ruling made while the nine tasks ran that corrects something this spec states
(`.superpowers/sdd/2026-09-14-m57-ui-redesign/task-9-rulings.md` is the ledger they come from).

- **E1 (amends R14c) — there is no `clear-halt` route and no `clearHalt` CONTROL VERB either**; the
  CLI performed the two-column update inline, so Task 4 extracts `clearHalt(workspaceId)` into
  `packages/control/src/emergency.ts`, rewrites the CLI case to call it, and appends no event
  because the CLI appended none.
- **E2 (amends R7) — `Pause all ⇄ Resume all` needs one more number**: `ShellFacts.counts` gains
  `slavesPaused`, derived from the `SlaveRun` rows `buildShellFacts` has already fetched.
- **E3 (amends R5) — `buildSidebarTree` must not call `listProjects()`**, which is the Projects
  page's seven-query read model and would run on every page in the product; it is its own four
  grouped reads, deriving `needsYouCount` through the domain's `needsYou(...)`.
- **E4 (amends R8) — the `?slave=`/`?task=` mirror belongs in the PAGE, not in the provider**: the
  provider lives in the root layout and must not know those parameter names.
- **E5 (amends R8) — a panel's `onClose` closes the PROVIDER as well as the URL, and the provider's
  `close()` clears the URL**, so the slot's `»`, the slot's `✕` and the panel's own close do one
  thing.
- **E6 (amends R10) — `COLUMN_STATE`'s value for the `Done` column is `'completed'`**, which is
  `UserCardState`'s spelling, not `'done'`.
- **E7 (amends R12) — `gate-m49-memory.mjs` reads the six sections as a SET**, so its replacement
  scrapes `[data-testid="sidebar-section"]`'s `data-section` — the same six route segments.
- **E8 (amends R2) — the pre-hydration script must be inside an authored `<head>`**: a `<script>`
  rendered in `<body>` runs after the first paint, which is the flash it exists to prevent.
- **E9 (amends R1) — `--radius-pill` takes the README's `999px`**, and the one gate row that
  measured the old `20px` is rewritten in Task 9 with the rest of `gate-m14-fidelity`'s table.
- **E10 (amends R7 and R8; scan F31) — the spec's two signatures are the PLAN's.** R7 writes
  `useHeaderAction(node)`; it is `useHeaderAction(node: React.ReactNode, deps: readonly unknown[])`,
  because a page rebuilds its action node every render and the effect needs the caller's own
  declaration of what actually changed inside it. R8 writes `open(mode, payload)` over a state of
  `{mode, collapsed, payload}`; it is `open(mode, content: React.ReactNode, onClose: () => void)`
  over `{mode, collapsed, content}` — the third argument is the owning page's URL clearer, which is
  what makes the slot's `»`, the slot's `✕` and the page's own close do one thing (plan erratum E5).
- **E11 (amends R5; scan F23, F55) — the root layout's tree read is gated on a principal and the
  client refetch is throttled.** `buildSidebarTree()` in an `async` + `force-dynamic` root layout
  runs on every request in the product, `/login` included, before anybody has authenticated. It runs
  only when the existing principal helper reports one (no redirect — the layout is not an
  authorisation boundary; `GET /api/sidebar` already has `requirePrincipal`), and answers `[]`
  otherwise. `SidebarTree`'s own refetch fires on a pathname change and on a `ShellFacts` change
  **throttled to at most once per 10 s** by a ref-held timestamp: `sameFacts` compares twelve live
  figures, several of which move every few seconds while a run is live.
- **E12 (amends R7; scan F1) — every `/w/:id/*` route publishes `ShellFacts`, and the breadcrumb
  takes the project's NAME from the tree.** Only five of the eight project page clients publish to
  `useShellFacts`; `/organization`, `/knowledge` and `/office` publish nothing, so a header that
  read the name from that store alone would say the workspace ID on three routes and hide the budget
  and the whole split button on them. Two halves: `w/[workspaceId]/layout.tsx` (which already calls
  `buildShellFacts`) renders a client `<ShellFactsSeed facts={initial}/>` that publishes on mount,
  so the store is never empty inside a project; and `Header` takes the NAME from the sidebar tree by
  `workspaceId` — which the root layout has read server-side — and only the budget, the halt state
  and the paused count from `ShellFacts`. The gate polls until the breadcrumb's TEXT equals the
  expectation rather than waiting for the element, which resolves on the server frame.
- **E13 (amends R7; scan F20) — `runsPaused` is `slavesPaused`, and both sides count SLAVES.**
  `buildShellFacts` counted paused RUNS while the hand-built literal in `OverviewClient` counted
  paused SLAVES, and `sameFacts` compared the two across a route change. Both count slaves, under
  one name. There is no `Slave.status` column — a slave's status is DERIVED from its live runs by
  `deriveSlaveStatus`, which is exactly how `buildShellFacts` already computes `slavesWorking` from
  the `SlaveRun` rows it has already fetched. `slavesPaused` is the same derivation over the same
  rows as `slavesWorking`, asked for `'paused'` and deduped by `slaveId`: no new query.
- **E14 (amends R18; scan F56) — the row's `Unblock` keys off the TASK.**
  `SlaveCardData.status` is a `SlaveStatus` (`idle | starting | working | pausing | paused |
  resuming | stopping`) with no `blocked` member, so `slave.status === 'blocked'` does not compile.
  The README's Unblock is about a blocked TASK: the branch reads `slave.taskStatus === 'blocked'`,
  the field `cardStateFor` already reads.
- **E15 (amends R12 and R13; scan F6) — the two folded Workforce tabs get their own testid
  namespace.** Keeping `workforce-tab-slaves` on both the visible People tab and the Slaves segment
  renders that testid twice, which breaks the plan's own four-tab assertion and puts
  `gate-m11-shell`'s unqualified `getByTestId('workforce-tab-slaves')` into Playwright strict-mode
  failure. `workforce-tab-*` stays on the FOUR top tabs; the segments are `workforce-segment-<id>`
  for all four segment ids, and every gate and test hit on `workforce-tab-departments` /
  `workforce-tab-runbooks` is re-pointed in the task that makes the change.
- **E16 (amends R10; scan F8, F30) — `assigned` moves column, and that moves a card's TONE.** The
  README maps `assigned → Queued`; today it is `In Progress`. `lib/tones.ts`'s `cardStateForTask`
  reads `COLUMN_STATE[COLUMN_FOR_STATUS[status]]`, so an assigned task's card goes from the
  `working` tone to `planning`. **This is a deliberate, user-visible behaviour change** and is named
  here rather than discovered in a diff: a task nobody has started should not be painted the colour
  of work in flight. The Graph page's Execution mode follows the five columns **by construction** —
  it imports `BOARD_COLUMNS`, `COLUMN_FOR_STATUS` and `COLUMN_STATE` rather than restating them
  (`components/graph/ExecutionNodes.tsx:5`) — so its pipeline becomes five stages with no edit to
  its logic, and spec §6's "the Graph canvas is out of scope" means its rendering, not its
  vocabulary.
- **E17 (amends R9; scan F4, F27, F62) — the composer's two outcome lines are two elements.**
  `gate-m45` stage 5 clicks Send *until `supervisor-request-result` is visible* and then asserts its
  text names `v3`, so that testid must be on the SUCCESS line ("goal v{n} saved …", which
  `SupervisorRequest.tsx:75-85` rendered). The refusal line beside it is
  `supervisor-request-error`. `supervisor-composer` is on the composer WRAPPER and
  `supervisor-request-input` / `supervisor-request-send` on the textarea and the button, from the
  moment the panel is written — no mid-milestone rename.
- **E18 (amends R8; scan F2) — `SupervisorPanel.tsx` is deleted, but `ProposalRow` is extracted
  first.** `SupervisorTimeline` imports `ProposalRow` from `SupervisorPanel`
  (`project/SupervisorTimeline.tsx:11`), and four gates read testids that only `ProposalRow` emits.
  It moves to `components/supervisor/ProposalRow.tsx` unchanged; `SupervisorTimeline` imports it
  from there; then `SupervisorPanel.tsx` and `supervisor-panel.test.tsx` go. The two testids that
  die with the panel's own body — `supervisor-decision-meta` and the panel-scoped
  `supervisor-proposal-kind`, both read by `gate-m44` — are emitted by
  `SupervisorThreadPanel`'s decision card with the same semantics: the WORD from `SITUATION_LABEL`
  with the raw record in `title`.
- **E19 (amends R4; scan F32) — `docs/ia.md` has no responsive line to rewrite.**
  `grep -n "responsive\|899\|collapse\|icon rail" docs/ia.md` returns nothing: M44 recorded the
  899 px collapse in its own spec and never in the IA contract. Task 9 ADDS the 1280 px floor as a
  new line rather than replacing one.
- **E20 (amends R2 and E8; found by the gate) — the pre-hydration script's key crossed an RSC
  boundary and shipped as `undefined`.** `THEME_STORAGE_KEY` was exported from `ThemeProvider.tsx`,
  a `'use client'` module, and `app/layout.tsx` is a SERVER component: Next replaces that module's
  exports with client references, so the interpolated script rendered as
  `localStorage.getItem(undefined)`, stamped nothing, and left a pinned operator the flash E8 exists
  to kill. The key moves to `lib/themeStorage.ts`, a plain module both sides import, and
  `ThemeProvider` re-exports it so every importer is unchanged. No jsdom test can see this — both
  sides import the same real module there — and `gate:m57-ui-redesign` stage 1 is what caught it.
- **E21 (amends R5) — the Analytics `VIEWS` chip reads its own currentness from `?workspace=`.**
  `/analytics` carries no `/w/:id` for `viewOf` to read, so `lib/routes.ts` leaves that one chip to
  its caller and `SidebarTree` decides it from `useSearchParams()`; Graph and Office stay a path
  segment (ruling T3-2).
- **E22 (amends R5 and E11) — the shell RENDERS on `/login`; the tree does not.** E11 gated only the
  layout's database read. `SidebarTree` additionally neither requests `/api/sidebar` nor draws a
  tree body there (a signed-out fetch could only 401), and its throttle clock starts at mount, so
  the tree the server already rendered is not refetched by the first `ShellFacts` frame (rulings
  T3-3, T3-5).
- **E23 (amends R8 and E10) — `open()` takes a FOURTH argument, the content KEY.** The outgoing
  owner's `onClose` runs only when a DIFFERENT subject takes the slot; re-asserting the same one
  does not, or a page moving its own selection from one task to the next would cancel the selection
  a person had just made (ruling T3-4).
- **E24 (amends R8) — the owning page hands the slot back on unmount, and never acts from an
  unmounted frame.** Two refs: `mounted`, so a clearer created for a page that has gone cannot
  `router.replace` its old pathname back over a person's navigation, and `owned`, so a page closes
  the slot only while the slot is still its own (ruling T5-1).
- **E25 (amends R8) — the dock's `S` calls `close()` before `expand()`.** A bare `expand()` re-opens
  whatever mode the slot was collapsed with, so a button labelled `Supervisor` would produce a task
  panel; closing first also runs the owning page's clearer, so the `?task=`/`?slave=` goes with it
  (ruling T5-2).
- **E26 (amends R9) — a proposal whose action is `answer_question` gets no Approve/Decline.** Its
  drafted words go out in the operator's name and this card shows the situation summary, not the
  draft, so it renders `supervisor-decision-review` — a link to the timeline lane where
  `ProposalRow` shows the question, the draft, its confidence and its sources. Every other kind
  keeps the two buttons (ruling T5-3).
- **E27 (amends R7) — the split button cannot lie about a halt, and does not lie about a fan-out.**
  `Pause all`/`Resume all` is DISABLED while the project is halted, with a `title` saying the halt
  must be cleared first (nothing resumes into a halt: `requestResume` refuses every run), and the
  header reads the fan-out envelope — an empty `requested` beside a non-empty `refused` prints
  `header-error` rather than a green 200 with nothing happening (ruling T4-2).
- **E28 (amends R7) — the armed Stop disarms on every PATHNAME change.** The header is the root
  layout's and does not unmount between two sections of one project, so keying the disarm on the
  workspace alone would carry a cocked destructive control across a navigation; the same effect
  clears the last refusal, which is otherwise a complaint about a page no longer on screen (ruling
  T4-3).
- **E29 (amends R11 and R17; a scoped exception to "`buildOverviewSnapshot` untouched") — the
  re-homed river excludes the two chatter types AT THE QUERY.** M45 R2 forbids `run.output` /
  `run.tool_call` text on the project page, and the closed disclosure that used to hold the river
  was compliance by accident. Filtering after `take: 8` would starve the panel during a run, so
  `recentForPanel` gains `type: { notIn: … }` and the `liveEvents` projection gains `type`; nothing
  else about that read moves (ruling T6-1).
- **E30 (amends §2's Team row) — `/w/:id/organization` drops `DataTable` for self-contained worker
  cards.** §2's binding text is "worker cards with lifecycle, `Now:`, `Why here:`, capability
  chips", and the handoff's card recipe cannot align to a shared header without changing a
  component other pages use; per-card labels stand in for the column headers. Every
  `organization-*` testid is verbatim (ruling T7-2).
- **E31 (amends R13) — `ui/Segmented`'s option gains an optional `href`.** An option carrying one
  renders a `next/link` `<Link>` instead of a `<button>`; both call `onChange` on click, and the
  link takes `aria-current="page"` when selected — never `aria-selected`/`aria-pressed`, which a
  link's implicit role does not have. That is how Workforce's two folded segments are bookmarkable
  AND one primitive (ruling T8-2).
- **E32 (amends §2's Activity row) — the timeline rule is at 99 px, not 88.** `ActivityCard`'s row
  geometry moved (`px-4` + a 64 px time column + `gap-3` + a 14 px dot column), so the rule moved
  with it to the dot's own centre; `Timeline.tsx`, `activity-page.test.tsx` and
  `gate-m14-fidelity.mjs` all say 99 (ruling T8-3).
- **E33 (amends §2's project-Settings row) — one card per section, and Goal and Runtime are bare
  wrappers.** Their inner `Panel` IS the card, so giving them the section recipe as well would draw
  a card inside a card; Permissions and Danger zone take the recipe with an `<h2>` where the inner
  `Panel title` was (ruling T8-5).
- **E34 (amends R12) — two CI gates are re-pointed at the FACT, not the widget.**
  `gate-m11-shell.mjs` read a project card's company through a `chip` testid the README's card
  recipe no longer draws (and scoped its action buttons to a `Card` they are now siblings of), and
  reads the badge TEXT inside the card's wrapper instead; `gate-m18-skill-and-teeth.mjs` matched
  two nested `complementary` landmarks named "Task detail" once `TaskDetailPanel` moved into the
  slot, and keys off `right-panel`'s `data-mode` with one scoped visibility check. Neither surface
  changed (ruling T8-1).
- **E35 (amends §6) — `workspaceArchived` and its doc comment are deleted from `server/org.ts`.**
  Three dead lines nothing imports, whose comment named a surface that no longer exists; a false
  comment over a dead symbol is worse than one scoped extra hunk, and `buildOrganization`'s body is
  untouched (ruling T4-1).
- **E36 (amends E9) — `gate:m14-fidelity` measures the Needs-you radius on the EMPTY card.** That
  gate's fixture has one `ready` task, no blocked task, no pending decision and no unintegrated
  `done`, so the Overview draws `needs-you-empty` — the same `rounded-panel-card` at the same 12 px.
  The POPULATED `needs-you-card` is measured by `gate:m57-ui-redesign` stage 8, whose fixture seeds
  a decision and a blocked task for exactly that reason.
- **E37 (amends R7 and E9) — `gate:m14-fidelity`'s two-step STOP is the header's split button.**
  `EmergencyStopButton`'s `emergency-stop` → `emergency-stop-confirm` pair left the project header
  with `ProjectHeader.tsx`, so stage 4a arms `stop-split` (asserting the FIRST click did not halt
  anything, which is the rule that stage exists for), waits for `stop-cancel` to appear beside it,
  and fires. The component itself still lives on the project Settings tab's danger zone.
- **E38 (amends E9) — `NUMBERS`' optional sixth element is gone.** M45's erratum E15 added a
  `prepare` hook for the one row that had to open a disclosure before it could be measured; R11
  deleted the disclosure, so the hook has no callers and goes with them rather than staying as a
  mechanism described by a comment nothing can check.
- **E39 (amends §4) — `docs/ia.md` has FIVE rules, not four.** §4 says the file keeps "its four
  rules verbatim"; rule 5 ("Advanced is a promise, not a graveyard") is the fifth, and all five are
  kept verbatim. It is still true after this milestone: the `Advanced ▾` disclosures the Workforce
  Catalog, its profile drawer and `SlavePanel` own are untouched, and what M57 removed —
  `ProjectTabs`' menu and the Overview's own — were menus over DESTINATIONS, every one of which is
  still at the URL it had (R11, and the gate's stage 10).
