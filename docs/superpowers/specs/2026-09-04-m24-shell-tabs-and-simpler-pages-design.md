# M24 — One Shell: a tabbed project, a sidebar that never changes, pages that show one thing

**Status:** Approved (navigation shape, the five simplifications and the seven design sections approved in conversation 2026-09-04)
**Approach:** one milestone, web only. No schema, no migration, no new API. Existing pages become tab contents under one project layout; panels move to where their subject lives; nothing is deleted from the data model.
**Scope rule:** the confusion the operator named — a sidebar that turns into something else when a project is open, pages that show several unrelated things at once — and nothing else. The Floor (handoff 2a) and chat-driven project intake are the two milestones that follow; this one prepares their places (a project tab, a "New project" button) and stops there.

## 1. Why this milestone

The M11 shell mounts one sidebar for two audiences. Outside a project it lists the global pages;
inside one it grows a project section (Overview, Agents, Tasks, Graph, Activity) with count
badges and a guardrails block at its foot (`apps/web/src/components/Sidebar.tsx`,
`PROJECT_ROWS`, `workspaceIdFromPathname`). The operator's word for this was "show/hide": the
same strip means different things on different pages, and the project's own identity — its name,
goal, budget — is spread across a `TopBar`, a `GoalCard`, a `RuntimeCard` and the sidebar's
foot. Overview carries a goal editor and a runtime editor next to the agent cards; global
Settings carries a per-workspace permission matrix, the repo-attach form, the template catalog
and the companies; the Agents page asks the operator to know the difference between a company's
roster and a project's workers before it shows a table.

M24 gives a project one page with tabs, gives the sidebar one list, and gives each page one
subject.

**Non-goals:** the Floor view (M25); chat intake and file uploads (M26); editing the runtime
limits `maxConcurrentRuns` / `runTimeoutMs` / `maxAttempts` (there is no API for them today and
the operator did not ask; they stay read-only); any change to `packages/*`, the orchestrator, the
event model or the routes under `apps/web/src/app/api`; a mobile layout; renaming URLs.

## 2. Navigation

### 2.1 The sidebar

One list, identical on every page, in this order: **Projects** (`/`), **Agents** (`/agents`),
**Skills** (`/skills`), **Analytics** (`/analytics`), **Settings** (`/settings`). The current row
is marked. Nothing else: no project section, no count badges, no guardrails block. The 212px
width, the row geometry and the mark at the foot stay as the handoff specifies.

`Sidebar.tsx` loses `PROJECT_ROWS`, `workspaceIdFromPathname`, `useProjectName`, the
`/api/w/:id/shell` fetch and the guardrails block. `SidebarProps` loses `workspaceId` and
`projectName`. The `/api/w/[workspaceId]/shell` route stays (the Tasks tab badge reads it, §2.2)
until nothing reads it — a later cleanup, not this milestone's.

### 2.2 The project layout (`apps/web/src/app/w/[workspaceId]/layout.tsx`, new)

Every `/w/<id>/*` page renders inside one server layout that draws the **project header** and
the **tab strip** once:

- **Header, one row, 52px:** the project name as a `<button>` opening a project switcher
  (`data-testid="project-switcher"`: every workspace by name, the current one marked, and a last
  row **New project** that links to `/?new=1`, §5.2); the goal line (`data-testid="project-goal"`:
  `Goal: <text>` truncated to one line, or `no goal · set one` linking to the Settings tab); the
  SSE/latency chip; the budget bar `$spent / $budget`; the two-step **STOP**. These are the
  elements `TopBar.tsx` carries today; `TopBar` is folded into the header component
  (`components/project/ProjectHeader.tsx`) and deleted.
- **Tab strip** (`components/project/ProjectTabs.tsx`, client): **Overview** `/w/<id>` ·
  **Tasks** `/w/<id>/tasks` · **Graph** `/w/<id>/graph` · **Activity** `/w/<id>/activity` ·
  **Settings** `/w/<id>/settings`. Tabs are `<a>` rows with `aria-current="page"` on the match
  (`usePathname`, exact for Overview, prefix for the rest so `?mode=comm` stays on Graph). The
  Tasks tab carries the active-task count badge (from `/api/w/:id/shell`, the same field the
  sidebar showed); no other tab carries a badge. Testids `project-tab-<name>`.
- The layout loads the header's data once per navigation (`buildShellFacts`, the function
  the shell route already uses) and passes it down; the pages under it stop rendering their own
  `TopBar`.

### 2.3 What moves where

| Today | M24 |
|---|---|
| Sidebar project section (Overview, Agents, Tasks, Graph, Activity) | Tab strip; the Agents row leaves the project context entirely (Agents is global) |
| Sidebar count badges | Tasks tab badge only |
| Sidebar guardrails block (budget, concurrency, run timeout, attempts) | Project Settings → Runtime panel (read-only rows) |
| `TopBar` (name, SSE chip, budget bar, STOP) | Project header |
| Overview `GoalCard` | Header goal line (read) + project Settings → Goal panel (edit) |
| Overview `RuntimeCard` (provider, budget) | Project Settings → Runtime panel |
| Global Settings → agent permissions | Project Settings → Agent permissions (this workspace only) |
| Global Settings → Projects panel (attach a repo) | Projects page → **New project** drawer |
| Global Settings → Template catalog, Companies | Projects page → **Team catalog** section |
| Agents → Roster / Workers / Teams tabs | Agents → one table + **Teams** tab |

## 3. Overview (`/w/<id>`)

Halt banner (when halted) · the six-up status strip (`TopStrip`) · the agent card grid. Nothing
else. `GoalCard`, `RuntimeCard` and the `goalSuggestions` they fed on leave the page;
`OverviewSnapshot.goalSuggestions` and the query behind it (`server/overview.ts:416-421`) are
removed — they surfaced past `goal_set` payloads as "suggestions" and were showing a gate's probe
text on a fresh instance. The agent cards, their Pause/Message/Stop controls and the
`AgentPanel` are unchanged.

## 4. Project Settings tab (`/w/<id>/settings`, new page)

Four panels, in this order, each a `Panel` with the handoff's section label:

1. **Goal** — the goal form exactly as `GoalCard` has it today (textarea, `set goal`, the
   `goal_set` refusal band), minus suggestions. Component `GoalCard` moves under
   `components/project/` unchanged apart from the suggestions prop.
2. **Runtime** — provider select + `set runtime`, budget input + `not budgeted` + `set budget`
   (today's `RuntimeCard`), then three read-only rows `concurrency` · `run timeout` · `attempts`
   with the sidebar's formatting (`30m`, `1m30s`), captioned `set in the workspace record; not
   editable here yet`. Testids `runtime-concurrency`, `runtime-timeout`, `runtime-attempts`.
3. **Agent permissions** — `PermissionMatrix` scoped to this workspace only (it already renders
   per-workspace sections keyed by `workspaceId`; it receives one). Caption unchanged (`not yet
   enforced at runtime`).
4. **Danger zone** — `EmergencyStopButton` (two-step) and nothing else. Retracting a halt stays a
   CLI verb (`clear-halt`) as today, and the halt banner keeps saying so; a web route for it is a
   later milestone's decision, not this one's (no new API). `DangerZone`'s "reset demo data" stays
   in global Settings (§5.1).

All writes go through the routes that exist today (`/api/w/:id/goal`, `/provider`, `/budget`,
`/emergency-stop`, `/api/agents/:id/permission`). No new route.

## 5. Global pages

### 5.1 Settings (`/settings`)

Three panels: **Provider adapters** (unchanged) · **Security** (posture line, Logout in accounts
mode, unchanged) · **Danger zone** with `reset demo data` only. The permission matrix, the Projects
panel, the Template catalog and Companies leave the page.

### 5.2 Projects (`/`)

- A **New project** button in the page header (`data-testid="new-project"`). It opens a drawer
  (`components/projects/NewProjectDrawer.tsx`) holding today's `ProjectsPanel` form — name, repo
  path, base branch, verify/setup commands, budget, provider — posting to `POST /api/org/workspaces`
  as today. `/?new=1` opens it on load (the header switcher's last row links there). M26 replaces
  the drawer's body with the chat; the button and the route parameter are the seam.
- The project cards as today.
- A **Team catalog** section below the cards: the `TemplateCatalog` and `CompanyManager` panels
  moved here unchanged, plus the existing assign-company control per project card (the
  `AssignCompanyDialog` trigger is already on the card).

### 5.3 Agents (`/agents`)

Two tabs: **Agents** (default) and **Teams**.

- **Agents** is one `DataTable`: agent (avatar + name + role) · team · project · status · current
  task · provider · cost, plus the M23 row actions (rename, re-role, delete) on every row that is a
  project agent. Rows come from one new server function `listAllAgents()` in `server/org.ts`
  that unions today's `listRoster()` and `listWorkers()` outputs into `{ agentId | null,
  companyAgentId, name, role, teamName, projectName | null, status, task, provider, cost }`,
  ordered by project then name; a catalog agent not yet assigned to any project shows `project —`
  and no row actions (the D1 verbs address project agents only — spec M23 §5 D3). The Roster and
  Workers tabs, `RosterTable.tsx` and `WorkersTable.tsx`, are deleted; `listRoster`/`listWorkers`
  stay as the union's inputs.
- **Teams** is `TeamsTable` unchanged.

### 5.4 Tasks (`/w/<id>/tasks`)

Card: title · status pill · assignee chip · step counter. The task id and the priority label move
into the detail panel's header line (`TASK-<id> · <priority>`). Columns and the panel are otherwise unchanged.

## 6. Components and files

Create: `app/w/[workspaceId]/layout.tsx`, `app/w/[workspaceId]/settings/page.tsx`,
`components/project/ProjectHeader.tsx`, `components/project/ProjectTabs.tsx`,
`components/project/ProjectSwitcher.tsx`, `components/project/ProjectSettingsClient.tsx`,
`components/projects/NewProjectDrawer.tsx`, `components/AllAgentsTable.tsx`,
`server/org.ts: listAllAgents()`.

Modify: `Sidebar.tsx` (one list), `OverviewClient.tsx` (drop goal/runtime), `SettingsClient.tsx`
(three panels), `ProjectsClient.tsx` (button, drawer, catalog section), `AgentsClient.tsx` (two
tabs), `TaskCard.tsx`/`TaskDetailPanel.tsx` (id + priority relocation), the four `/w/[id]/*` pages
(no `TopBar`), `server/overview.ts` (no suggestions), `app/layout.tsx` (Sidebar props gone).

Delete: `TopBar.tsx`, `RuntimeCard.tsx` (folded into the Runtime panel), `RosterTable.tsx`,
`WorkersTable.tsx`, `GoalCard`'s suggestions branch.

The handoff's tokens stay the source for geometry: 212px sidebar, 52px header, radius 5–10,
mono 9px section labels, status alphas `1a`/`3d`. Nothing new is invented visually; the tab strip
uses the Agents page's existing tab idiom.

## 7. Testing

Unit (Testing Library): `project-layout.test.tsx` (header fields from a snapshot, five tabs, the
current tab by pathname incl. `?mode=`, Tasks badge, switcher rows + New project link),
`project-settings.test.tsx` (four panels, goal/provider/budget posts, read-only runtime rows,
matrix scoped to one workspace, danger zone two-step), `sidebar.test.tsx` rewritten (five rows,
current mark, no project section anywhere), `overview-page.test.tsx` (no goal/runtime elements),
`settings-page.test.tsx` (three panels), `projects-page.test.tsx` (New project button, `?new=1`,
drawer posts, catalog section present), `agents-page.test.tsx` (two tabs, one table, catalog rows
without actions), `task-card.test.tsx`. Integration: `listAllAgents` against the real DB (a
catalog agent, a project agent, ordering).

Gates: `gate:m14-fidelity` regenerates its nine screenshots and its selector table follows the
moved elements; `gate:m16-chrome`, `gate:m11-shell`, `gate:m18-skill-and-teeth` update the
Settings/Agents selectors they read. `gate:m15-boundary`, `gate:m20-auth`, `gate:m21-loose-ends`
and `gate:m23-onboarding` pass unmodified (they do not read the shell).

## 8. Global constraints

Web only: no change under `packages/`, `apps/orchestrator/`, `apps/web/src/app/api/`, no
migration. Every task touching `apps/web` gates on `npm run web:build` (never while a `next dev`
runs) and removes `apps/web/.next` after. One vitest run at a time. Root `tsc --build` does not
cover `apps/web` tests: `npx tsc -p apps/web/tsconfig.test.json --noEmit` is a separate gate.
Comments change in the same commit as the behaviour they describe. `git add` explicit paths.

## 9. Order of work

1. Project layout + header + tabs; pages drop `TopBar`; sidebar to one list (the shell).
2. Overview slimmed; project Settings tab (Goal, Runtime, Danger zone).
3. Permission matrix into project Settings; global Settings to three panels.
4. Projects page: New project drawer, Team catalog section.
5. Agents: one table + Teams.
6. Tasks card/panel relocation.
7. Gates: m14 screenshots, m16/m11/m18 selectors; closing run of every gate.

## 10. Errata — where execution corrected the plan

(empty at approval; filled by the last task)
