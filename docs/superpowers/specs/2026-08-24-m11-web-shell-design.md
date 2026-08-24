# M11: The Web Shell — Global IA, Handoff Tokens, Org Surfaces — Design

**Date:** 2026-08-24
**Status:** Approved
**Predecessor:** M10 (the organization model, headless). This milestone is its by-eyes half.
**Structural reference:** `design_handoff_ai_team_os/README.md` §3a (the nine-page shell) and
its Design Tokens section. The handoff's `AI Team OS Web.dc.html` is the behavior reference
for the existing pages.

M11 turns the workspace-scoped four-page web app into a global, sidebar-driven shell in the
handoff's visual language, and gives the M10 organization model its user interface: a
Projects list with company assignment, an Agents surface over rosters and workers, and a
Settings page that manages the catalog and companies through the M10 control verbs.

## 1. Scope

In scope:

- A new presentational component library built from the handoff mockups, and a full
  migration of the design tokens (palette, IBM Plex Sans/Mono, radii, spacing, shadows).
- A global shell: two-section sidebar (global: Projects / Agents / Settings; project-scoped:
  Overview / Tasks / Graph / Activity), root `/` becomes the Projects page.
- Three new pages — Projects, Agents (tabbed Roster/Workers), Settings — wired to the full
  M10 verb set through thin API routes.
- Migration of the four existing pages onto the new component library, behavior unchanged.
- Three carried-over M10 pre-tasks (§8) that the UI builds on.
- A measured browser gate, `gate-m11-shell.mjs`.

Out of scope (deliberate): the handoff's Skills and Analytics pages, provider adapters, the
permission matrix, transport selection, danger zone, global SSE, and the 1b/2a visual
concepts. "Workspace" keeps its name in code and storage (M10 spec Decision 4); "Project"
remains UI copy only.

## 2. Decisions of Record

1. **Scope is the core trio plus the shell** — Projects, Agents, Settings on a restructured
   global IA. Skills/Analytics have no domain backing and are not built.
2. **The web gets the full M10 verb set** — createTemplate, createCompany, addCompanyTeam,
   addCompanyAgent, assignCompany, setAgentModel — each behind a thin API route in the
   established goal/emergency-stop pattern. No new domain verbs.
3. **Full token migration** — the handoff palette and IBM Plex replace the current tokens,
   and the four existing pages are restyled onto the new component library (not merely
   re-themed). Two visual languages never ship side by side.
4. **Two-section sidebar** — global section always visible; the project section appears when
   inside a project. Existing `w/[workspaceId]/...` routes stay; only the root route changes.
5. **Agents is tabbed** — Roster (org structure and the model chain, editable) and Workers
   (operational cross-project view). Neither absorbs the other.
6. **Settings is org management only** — template catalog and company/team/roster
   administration. Nothing else.
7. **Org pages have no SSE** — server-render plus `router.refresh()` after mutations;
   the Workers tab polls at 5s. Project pages keep their existing SSE.
8. **Truth from snapshot** (handoff State Management): the UI never renders optimistically;
   mutations re-read.

## 3. Tokens and the Component Library

`globals.css` redefines the existing CSS variables to the handoff values and adds the
missing families — surfaces (`#0a0c0f` page, `#0c0f13` panel, `#0f1217` card, `#151a21`
selected), hairlines (`rgba(255,255,255,.07)` structural / `.05` rows / `.08–.12` card
borders), the status palette (working `#2ee6cf`, planning `#7b8cff`, review `#c084fc`,
waiting/merging `#f5b34a`, blocked/failed `#f87171`, done `#4ade80`, paused `#8a929e`,
idle `#5b6472`; fills at `1a` alpha, borders at `3d`, bar glow `0 0 8px`), text ramp
(`#e7eaf0` → `#3f4650`), IBM Plex Sans (UI) + IBM Plex Mono (data/labels; section labels
9px uppercase `.09em`), radii 5/6/7/8/9–10/20, the handoff spacing and shadow sets. The
existing semantic variable names stay where they exist; new tokens follow the same naming.

`apps/web/src/components/ui/` — roughly ten focused presentational components, each with a
single responsibility, its own test file, and no data access:

`Panel`, `Card`, `StatusPill` (the 1a-alpha fill / 3d-alpha border pattern), `StatStrip`
(n-up with 1px gutters), `DataTable` (explicit grid-template columns), `ProgressBar`
(glowed), `SectionLabel`, `Chip`, `GhostButton`/`PrimaryButton`, `EmptyTile` (the dashed
"add" tile).

Motion per the handoff: status-dot pulse (1.5s, in-flight states only), new-row rise
(0.3s translateY), progress `width .5s ease` — all behind `prefers-reduced-motion`.

## 4. Shell and Routes

`app/layout.tsx` mounts the global shell. Sidebar, two sections: **Projects / Agents /
Settings** on top; when a project is open, a project section beneath it (the project's name
as its header) linking **Overview / Tasks / Graph / Activity**. The topbar keeps the current
page title, `HaltBanner`, and connection status placement.

Routes: `/` → Projects (replaces the current root), `/agents`, `/settings` (new);
`w/[workspaceId]`, `w/[workspaceId]/tasks`, `w/[workspaceId]/graph`,
`w/[workspaceId]/activity` unchanged.

## 5. Data Layer and API

`src/server/org.ts` — pure query module in the existing `server/` idiom, one Prisma query
plus pure shaping per function, integration-tested against the test DB:

- `listProjects()` — workspace + company name + task counts/done ratio + spend + worker count
- `listRoster()` — company → team → member with template, the resolved model chain, and each
  member's workers (project, status, current task, progress)
- `listWorkers()` — all materialized workers across projects: status, current task, progress
- `listTemplates()`, `listCompanies()`

API routes, each in the goal/emergency-stop pattern (zod body validation → control function
→ refusal mapped to 4xx with its text):

- `POST /api/org/templates` → `createTemplate`
- `POST /api/org/companies` → `createCompany`
- `POST /api/org/teams` → `addCompanyTeam`
- `POST /api/org/agents` → `addCompanyAgent`
- `POST /api/w/[workspaceId]/company` → `assignCompany`
- `POST /api/agents/[agentId]/model` → `setAgentModel` (null clears)

## 6. The Three New Pages

**Projects (`/`).** Project cards: name, company badge (dim "no company" when unassigned),
status pill (halted/running/idle), worker avatar row, done/total progress bar, and a 4-up
stat strip (workers / active / blocked / spend). A card opens the project. An unassigned
project offers **assign company** — a small dialog listing companies → the assign route →
`router.refresh()`. The card layout follows §3a's Projects composition.

**Agents (`/agents`).** Two tabs.
*Roster:* a table grouped company → team; per member: name, role, template, the model chain
(effective model plus its source: template / roster / worker). Expanding a row reveals that
member's workers across projects (project, status, current task, progress) and the worker
model override editor (set/clear through the model route). *Workers:* a flat table — worker,
role, project, status pill, current task with inline progress — refreshed by 5s polling.

**Settings (`/settings`).** Two panels.
*Template catalog:* the template list plus a creation form (name, role, description, default
model). *Companies:* the company list plus creation; an expanded company shows its teams and
roster with **add team** and **add member** (template picker + name + optional model) forms.
All writes go through the §5 routes; refusals render inline beside the submitting form.

## 7. Migration of the Existing Pages

The four existing pages move onto the component library one page at a time, behavior
identical: the goal form, board columns, two-step STOP, halt banner, SSE streams, and
payload disclosure all keep their semantics and test-ids. Structural nudges toward the
handoff where the mockups differ: Tasks adopts §3a's compact card (id, priority, title,
assignee chip, step counter), Activity adopts 1c's row rhythm, Overview adopts 1a's 6-up
strip + agent cards. The existing test suite is the migration's safety net.

## 8. Pre-Tasks (carried over from M10's final review)

1. **`companyAgentId` in the assignment event** — `workspace.company_assigned`'s `workers`
   entries gain `companyAgentId`; schema, emitter, card (the card keys on it, replacing the
   index-qualified key).
2. **Model-string guard** — `createTemplate` (defaultModel), `addCompanyAgent` (model), and
   `setAgentModel` refuse empty/whitespace model strings with an `invalid_name`-style
   refusal, so `--model ''` can never reach the adapter.
3. **`Team.companyTeamId String?`** — new nullable column; `assignCompany` matches project
   teams by this id, falling back to name-match only to adopt (and stamp) pre-M11 teams on
   first contact. Removes the rename-resync duplicate risk flagged in the M10 review.

These land before any UI work; each is its own TDD task.

## 9. Testing

Full gate per task: `npm test && npm run typecheck && npm run web:build`, TDD throughout.
`org.ts` queries get integration tests; UI components get render tests in the existing
vitest + testing-library pattern; API routes get the existing route-test treatment
(refusal → status/text mapping included). Migrated pages must keep their existing tests
green with unchanged test-ids.

## 10. Milestone Gate

`scripts/gate-m11-shell.mjs`, in the measured-gate idiom, driving a real browser (the
chromium + playwright-core pattern from the demo tooling) against a dev server on a seeded
DB with two projects:

1. Settings: create a template, a company, a team, a member — through the forms.
2. Projects: assign the company to both projects; see worker avatars appear.
3. Agents/Workers: both projects' workers visible; Roster shows the model chain.
4. Set a worker model override in the UI; assert `Agent.model` in the DB.
5. PASS line names the flow; FAIL dumps page state and org rows.

README gains the command beside the M8/M10 gates and the M11 row: "the shell went global —
a company was staffed, assigned, and steered entirely from the browser".
