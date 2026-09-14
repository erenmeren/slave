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
- **`/w/:id`** Overview: title + status pill + goal line → **Needs you** → four fact tiles (Work bar,
  Cost, Supervisor, Latest verified) → Team rows → Recent changes.
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
| `fact-tile` | Overview | `data-fact` = `work`/`cost`/`supervisor`/`verified` |
| `recent-changes` | Overview | the section holding `live-events` and the merge queue |
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
   `1280px`, an Overview page card's `border-radius` `14px`, a fact tile's `border-radius` `12px`,
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

## 6. Out of scope, and the four places this milestone deliberately does not match the README

The domain, `packages/control` (but for R14c's `clearHalt`), `packages/db`, `packages/events`, the
orchestrator, every existing API route's behaviour, every read model's SHAPE (the three new ones are
additive), the Graph canvas, the Office canvas, the Analytics page's content, the simulation engine,
`⌘K` actually opening anything (the field is rendered per the README and is inert this milestone —
named here so nobody reads its inertness as a bug), a real conversation table for the Supervisor,
per-viewer accent colours (the prototype's `data-accent`), and any responsive behaviour below
1280 px (R4).

Four README details are deliberately not built, each because building it would move a number a gate
already measures for no user-visible gain. Each is named here so that nobody reads it as an
oversight, and each is a candidate for the milestone after this one.

1. **The Overview's Team rows stay a CARD GRID, not the README's `34px 120px 120px 1fr 96px 32px`
   table.** That grid is `SlaveCard`, which renders nowhere else in the app and carries six
   `gate:m14-fidelity` assertions (radius 8, padding `12px 13px`, a 28 × 28 avatar tile, a
   radius-999 pill). Rewriting it into a row is a card recipe change, and M44's own erratum E1 already
   ruled that one card recipe waits for a milestone that may move README pixels. This one moves
   plenty, but not that one: the Overview is already the page with the most gate surface in the
   product.
2. **Workforce's People table keeps its ten columns**, not the README's seven.
   `gate:m14-fidelity` asserts the authored `grid-template-columns` string
   (`200px 110px 150px 120px 100px 110px 1fr 90px 90px 160px`) twice, by two different methods and
   for a stated reason; the README's seven-column sketch drops the lifecycle column M50 added and
   the cost column M53 reads. Reconciling the two is a data question, not a styling one.
3. **The sidebar shows a count on `Projects` only**, not on `Workforce` and `Simulations` as the
   prototype draws. Those two numbers would need two more reads in the ROOT layout — on every page
   in the product — for two figures nobody acts on from the sidebar.
4. **`ProjectBrief`, `TopStrip`, `RunbookPanel` and `SupervisorTimeline` keep their own surfaces.**
   Between them they carry over twenty `gate:m14-fidelity` and `gate:m45-project-experience`
   assertions, they all sit below the first viewport the README specifies, and the tokens they paint
   with are themed correctly by R1's alias layer from Task 1 onwards. They look like the new palette;
   they are not laid out like the new sketch.

## 7. Errata — where execution corrects this spec

(appended during execution, in the form `**En (amends Rx)** — <claim>.`)
