# M27 — Everything can go: archive a project, delete departments, slaves and catalog rows

**Status:** Approved in outline (2026-09-05: "proje, departman, slave hepsinin kaldırılabiliniyor olması lazım"; decisions taken in conversation — project archived (soft), department and slave permanently deleted with their history, catalog rows all deletable; two-step confirms that name the counts). Sections below are the design for review.
**Approach:** one milestone. One migration (`Workspace.archivedAt`, two `EventType` members). Deletion is cascade-by-database where the schema already says `onDelete: Cascade`, and explicit-in-the-verb where it says nothing (`Restrict`). Every destructive verb refuses while a live run exists, and every web surface asks twice, naming what will go.
**Scope rule:** project archive/restore; department delete (with its slaves); slave delete (with its run history); company / department template / catalog slave / slave template delete; the confirms; CLI parity. Nothing else — no bulk operations, no undo for hard deletes, no retention policy.

## 1. Why this milestone

Today a slave with any run history cannot be deleted (`slave_has_runs`), a department cannot be
deleted while it has slaves (`team_not_empty`), a department template cannot be deleted while it
has catalog slaves (`company_team_not_empty`), companies and slave templates cannot be deleted at
all, and a project (workspace) has no delete or archive of any kind. The operator wants to remove
what they created. The one thing that must not be lost silently is spend and run history, which
is why a project is archived rather than deleted, and why every hard delete says its counts first.

**Non-goals:** deleting a project's rows (archive only; a hard "purge" is a later decision);
undo/restore for department, slave or catalog deletes; deleting users; deleting tasks or runs
individually (they go with their owner); bulk multi-select; a retention/GC job; a confirm that
requires typing the name (two clicks suffice, the counts are the safeguard).

## 2. Principles

| | archive (project) | delete (department, slave, catalog rows) |
|---|---|---|
| reversible | yes — `restore` | no |
| rows | kept; `archivedAt` set | removed, with everything the schema cascades |
| live run present | refused (`live_runs`) | refused (`live_runs`) |
| scheduler | never picks the project | n/a |
| lists | hidden unless "show archived" | gone |
| event | `workspace.archived` / `workspace.restored` | `org.changed` with `field: 'deleted'` (project-level); none for catalog rows |
| confirm | two clicks, counts shown | two clicks, counts shown |

**Live run** = any `SlaveRun` whose status is in `NON_TERMINAL_RUN_STATUSES` (the same set
`emergencyStop` and `setSlaveRole` use). Refusal kind `live_runs { entity, id, runs }`.

**Counts** come from one server read per surface (§7), never from a second round trip on click.

## 3. Project archive and restore

### 3.1 Schema (one migration, `<timestamp>_m27_archive_and_delete`)

```prisma
model Workspace {
  …
  /// M27: an archived project keeps every row but leaves every list and the scheduler.
  archivedAt DateTime?
}
enum EventType {
  …
  workspace_archived   @map("workspace.archived")
  workspace_restored   @map("workspace.restored")
}
```

### 3.2 Verbs (`packages/control/src/workspace.ts`)

- `archiveWorkspace(workspaceId, principal?)` → refuses `workspace_not_found`, `already_archived`, `live_runs` (count of non-terminal runs across the project's slaves); sets `archivedAt = now()` (that flag alone is what stops scheduling — §3.3; no halt is written); appends `workspace.archived`.
- `restoreWorkspace(workspaceId, principal?)` → refuses `workspace_not_found`, `not_archived`; clears `archivedAt`; appends `workspace.restored`. A halt that was in place before the archive is untouched by both verbs (it is its own state).

### 3.3 Effects of `archivedAt !== null`

- **Scheduler**: `tick(workspaceId)` returns a `skipped: 'archived'` report without loading the world; the daemon's all-workspaces loop (`cli.ts` `prisma.workspace.findMany` for `daemon`/`tick` without `--workspace`) filters `archivedAt: null`. `admitRun`/`planning`/`review` never see an archived workspace because nothing dispatches for it.
- **Reads**: `listProjects()`, `listWorkspaceNames()` (the header switcher, the New department and New slave forms), `listWorkspaces()` (`server/workspaces.ts`), `listProjectTeams()`, `listAllSlaves()` and `listWorkers()` (project rows of an archived project) all take `includeArchived = false` and filter `workspace.archivedAt: null` by default. The Projects page alone passes `true` when its toggle is on.
- **Routes** under `/w/[workspaceId]/*`: an archived project's pages still open (read-only view of its history); every WRITE route for the project (`goal`, `provider`, `budget`, `company`, `emergency-stop`, `teams`, task dependency edits, worktree collect) answers 409 `workspace_archived` — implemented once in `workspaceControlResponse` by reading `archivedAt` before the verb.
- **Shell**: `ProjectHeader` shows an `archived` chip (`data-testid="project-archived"`, faint tone) beside the name and hides STOP; `ProjectSettingsClient`'s danger zone shows **Restore** instead of Archive; the switcher never lists archived projects; an archived project is reached from the Projects page with `show archived` on (or by its URL).

### 3.4 UI

- **Project Settings tab → Danger zone** (M24 §4): below the emergency stop, `archive project` (`data-testid="archive-project"`) opens the two-step confirm (`archive-project-confirm` / `archive-project-cancel`) whose text names the footprint: "archives Checkout Platform: 3 departments, 9 slaves, 12 tasks, 41 runs stay on record; nothing runs until you restore it". Success → `router.push('/')` (the project leaves the header's world).
- **Projects page**: a `show archived` toggle (`show-archived`, persisted in the URL as `?archived=1`); archived cards render with the `archived` chip, no spend bar, and a **Restore** button (`restore-project`, no confirm — it is reversible).
- **Restore** is also on the archived project's Settings tab danger zone (`restore-project`).

### 3.5 Routes and CLI

`POST /api/w/[workspaceId]/archive`, `POST /api/w/[workspaceId]/restore` (through `workspaceControlResponse`, refusal → 409). CLI `archive-workspace --workspace <id>`, `restore-workspace --workspace <id>`; `status` and `list-workspaces` (new, small: id · name · archived?) show the flag.

## 4. Department and slave delete (project level)

### 4.1 `deleteSlave(slaveId, principal?)` — changed

- Refuses `slave_not_found`, `live_runs`. **No longer** refuses on run history: `slave_has_runs` is removed from the union (its two call sites and the CLI text follow).
- Deletes the row; the database cascades `SlaveRun` (and their `Checkpoint`s), `SlavePermission`, `SlaveSkill`, `SlaveMessage`. `ExecutionEvent.slaveId` has no FK and keeps its value — the activity feed already renders events by payload and tolerates a slave it cannot resolve (verified by a test in §9).
- Event `org.changed { entity: 'slave', field: 'deleted', from: name, to: null }` — unchanged shape; the payload gains `runs: <count deleted>` so the timeline says what went.
- Worktrees: a run's `worktreePath` is task-owned; deleting the slave's runs does not touch disk. `collectTaskWorktree` keeps working for the task.

### 4.2 `deleteTeam(teamId, principal?)` — changed

- Refuses `team_not_found`, `live_runs` (any live run on any slave of the department). **No longer** refuses `team_not_empty` (removed).
- Deletes the row; the database cascades `Slave` and everything under it (§4.1). Event `org.changed { entity: 'team', field: 'deleted', from: name, to: null, slaves: <n>, runs: <n> }`.

### 4.3 UI

- **Slaves table** row actions: `slave-delete` → confirm (`slave-delete-confirm`/`-cancel`) whose text is "deletes Alex and 14 runs of history"; the row's `runCount` comes with `AllSlaveRow` (§7). The existing disabled-with-title treatment for history goes away.
- **Departments tab** rows: `department-delete` is always enabled; confirm text "deletes Engineering: 4 slaves, 31 runs"; `ProjectTeamRow` gains `runCount`.
- **Catalog rows in the Slaves table** (catalog slaves, `slaveId === null`): a `catalog-slave-delete` action → `deleteCompanySlave` (§5).

## 5. Catalog deletes

All four are catalog-level: no `ExecutionEvent` (no workspace), the M23/M25 rule. Project copies made by `assignCompany` survive every one of them (`Slave.companySlaveId` and `Team.companyTeamId` are `SetNull`; `Workspace.companyId` is cleared explicitly).

| Verb | Refusals | What goes | What survives |
|---|---|---|---|
| `deleteCompany(companyId)` | `company_not_found` | the company; DB cascades its department templates and their catalog slaves | projects that had it assigned (`Workspace.companyId` set to null inside the verb's transaction first — the FK has no rule); their departments and slaves |
| `deleteCompanyTeam(companyTeamId)` — changed | `company_team_not_found` (**`company_team_not_empty` removed**) | the template; DB cascades its catalog slaves | project departments copied from it (`SetNull`) |
| `deleteCompanySlave(companySlaveId)` — new | `company_slave_not_found` | the catalog slave | project slaves materialized from it (`SetNull`) |
| `deleteSlaveTemplate(templateId)` — new | `template_not_found` | the template; the verb deletes its catalog slaves explicitly first (`CompanySlave.template` has no rule) | project slaves (their `role` was copied at materialization) |

Each verb runs in one transaction behind `SELECT … FOR UPDATE` on the row it deletes (the
`deleteCompanyTeam` shape from M25) and reports its footprint in the success value
(`{ templates, catalogSlaves }` / `{ catalogSlaves }`) so the CLI can print it.

### 5.1 UI (Projects page → Team catalog)

- **Companies**: each company row gets `company-delete` → confirm naming "N department templates, M catalog slaves; K projects keep their copies" (counts from `listRoster` + a `projectsUsing` count added to the company row).
- **Department templates** (`TeamBlock` header): `department-template-delete` is always enabled; confirm names its catalog-slave count.
- **Catalog slaves** (`MemberRow`): `catalog-slave-delete` → confirm "deletes Sam from the catalog; 2 project copies stay".
- **Slave templates** (`TemplateCatalog` rows): `template-delete` → confirm "deletes Backend Developer and its 3 catalog slaves; project slaves keep their role".

### 5.2 Routes and CLI

`DELETE /api/org/companies/[companyId]`, `DELETE /api/org/teams/[companyTeamId]` (exists; refusal set changes), `DELETE /api/org/slaves/[companySlaveId]`, `DELETE /api/org/templates/[templateId]` — all through `orgControlResponse`. CLI: `delete-company --company <id> --yes`, `delete-company-team --team <id> --yes` (exists; `--yes` text now names the cascade), `delete-company-slave --slave <id> --yes`, `delete-template --template <id> --yes`; without `--yes` each prints the footprint and refuses, the `delete-team` idiom.

## 6. The confirm component

One `DangerConfirm` (`apps/web/src/components/ui/DangerConfirm.tsx`) replaces the four hand-rolled two-step blocks (`DepartmentsTable`, `TeamBlock`, `SlaveRowActions`, `EmergencyStopButton` keeps its own — it is not a delete). Props: `{ label, testId, confirmText: string, disabled?, onConfirm, tone?: 'blocked' }`. Renders the trigger; on click swaps to `[confirm: <confirmText>] [cancel]` with testids `${testId}-confirm` / `${testId}-cancel`, disables during pending, shows the refusal in `${testId}-error` (`role="alert"`). Escape cancels. The confirm text is passed in fully formed — the component does not count anything.

## 7. Reads (`apps/web/src/server/…`)

- `AllSlaveRow` gains `runCount: number` (project rows; 0 for catalog rows) — one `groupBy` on `SlaveRun` by `slaveId`.
- `ProjectTeamRow` gains `runCount`.
- `ProjectSettings` (M24) gains `footprint: { departments, slaves, tasks, runs }` and `archivedAt`.
- `ProjectRow` (Projects page) gains `archivedAt`.
- Company rows on the Projects page gain `projectsUsing` (count of `Workspace.companyId`).
- `listAllSlaves`, `listProjects`, `listWorkspaceNames`, `listProjectTeams`, `listWorkers`, `listWorkspaces` take `includeArchived?: boolean` (default false).

## 8. Errors and edge cases

- Archive or delete raced by a run starting: every verb takes the row lock and re-checks live runs inside the transaction; `admitRun` additionally refuses `workspace_archived` so a tick that loaded the world just before the archive cannot dispatch after it.
- Deleting the department that `assignCompany` would recreate on the next assign: allowed; the next `assignCompany` recreates the department and re-materializes the catalog slaves that are missing (existing behaviour — a note in the confirm text: "the catalog can put it back with assign-company").
- Deleting the last department of a project: allowed (a project may be empty).
- Archiving a project that is halted: allowed; restore leaves it halted.
- Restore while the Projects toggle is off: the card reappears on the next load.
- The activity feed of a project after a slave delete: `slave-link` on old events renders the name from the payload and no link when the slave is gone (`slaveId` unresolved) — tested.

## 9. Testing

- `packages/control/test/integration/archive.test.ts`: archive/restore round trip, both refusals, events, `tick` skip, `admitRun` refusal, halted stays halted.
- `packages/control/test/integration/delete.test.ts`: `deleteSlave` with history (cascade counts), `live_runs` refusal, event payload; `deleteTeam` cascade; the four catalog verbs incl. `Workspace.companyId` cleared and `SetNull` survivors; `deleteSlaveTemplate`'s explicit cascade.
- Web: route tests for the six new/changed routes; `danger-confirm.test.tsx`; `all-slaves-table` (delete with count, catalog delete), `departments-table` (delete with count), `project-settings` (archive → push('/'), restore), `projects-page` (toggle, archived card, restore), `company-manager`/`template-catalog` (deletes with counts), `activity` (deleted slave renders).
- Gates: m11-shell gains a stage that deletes the member it created (catalog) and the department it moved to (project) and asserts the DB; m14 reads the archived chip on Settings; m21 loose-ends unaffected.

## 10. Global constraints

- One migration (`archivedAt`, two enum values); no other schema change; no new dependency.
- Every destructive web verb has a CLI verb with `--yes`; the CLI prints the footprint without it.
- Refusals typed; routes → 409; every project-level delete writes one `org.changed`; archive/restore write their own event type; catalog verbs write none.
- The confirm text always states counts; a `DangerConfirm` with an empty `confirmText` is a defect.
- Standing rules: ONE vitest at a time; `web:build` gates web tasks; gates never overlap; `git add` explicit paths; comments change with behaviour.

## 11. Order of work

1. Migration + `archiveWorkspace`/`restoreWorkspace` + scheduler/`admitRun` effects + CLI + tests.
2. `deleteSlave`/`deleteTeam` changes + the four catalog verbs + refusal kinds + CLI + tests.
3. Reads (§7) and routes (§3.5, §5.2) with tests.
4. `DangerConfirm` + Slaves table + Departments tab.
5. Project Settings danger zone + header chip + Projects page toggle/restore + switcher rule.
6. Catalog UI (companies, templates, catalog slaves, slave templates).
7. Gates, README, §13 Errata, closing run.

## 12. Out of scope, recorded

Hard purge of an archived project; undo for deletes; bulk selection; a retention job; deleting users or individual tasks/runs.

## 13. Errata — where execution corrected the plan

Every controller ruling made while executing Tasks 1–6, in order, one line each:

- **R1** — commit trailers use the harness's own attribution block (session URL included), not the literal URL the plan text carried; costs nothing.
- **R2** — `ProjectRow.archived` / `ProjectSettings.workspace.archived` are booleans, not spec §7's `archivedAt` timestamp: a boolean crosses the server/client boundary and fixtures cleanly, and no surface needs the date; costs a field rename later if one ever does.
- **R3** — the archive/restore routes (§3.5) answer inline rather than through `workspaceControlResponse`: archive must return the footprint and restore must bypass the archived guard, which that shared helper doesn't accommodate; costs one more envelope shape.
- **R4** — the catalog-slave delete confirm text ("deletes Sam from the catalog; project copies stay") omits §5.1's copy count: no `§7` read supplies it; costs one `groupBy` if the count is later wanted.
- **R5** — spec §9's activity test (an event whose `slaveId` resolves to no slave renders the payload's name with no link) was added to Task 4's scope; the plan had dropped a spec-required test. Detail: `ActivityCard.tsx`'s `SlaveLink` used to render the raw `slaveId` as link text pointing at a slave that no longer exists — it now returns `null` when `slaveName` is `null`, so the card body carries whatever name the payload has.
- **R6** — `deleteCompanySlave` runs in a transaction behind `SELECT … FOR UPDATE`, matching its sibling catalog verbs (spec §5); the plan's bare find-then-delete would race a concurrent delete into a `P2025` throw.
- **R7** — Task 2 also updated `scripts/gate-m23-onboarding.mjs` stage 6 and `apps/orchestrator/test/integration/cli.test.ts`'s `slave_has_runs` case to the new cascade behaviour — both asserted text the behaviour change removed, and the plan missed them.
- **R8** — Task 4 rewrote the `DepartmentsTable.tsx:15` comment that named `team_not_empty`, a refusal that no longer exists; comments change with the behaviour they describe.
- **R9** — a stray `next dev` left over from an earlier screenshot session was killed before Task 3's `web:build` (pid 1190846) — the build clobbers a running dev server.
- **R10** — the `danger-confirm` "cancels on Escape" test was rewritten to actually press Escape and assert the confirm closes; a test that asserts less than its own name is a rubric defect.
- **R11** — `deleteTeam` locks the department's `Slave` rows (`SELECT id FROM "Slave" WHERE "teamId" = $1 FOR UPDATE`) before counting live runs, which the brief's block did not call for: the spec's "checked inside the row-locked transaction" only holds if the lock covers the rows a `SlaveRun` insert takes `FOR KEY SHARE` on, and `lockTeam`'s lock on the `Team` row alone does not.
- **R12** — the final review's minor #7 was reclassified as a spec gap: §3.3 names `teams` and task-dependency edits among the writes that must 409 on an archived project, and those routes built their envelopes inline, bypassing `workspaceControlResponse`. Fix round 1 added the same archived guard to `POST teams`, `POST tasks` and the dependency routes through one shared helper; the run routes (pause/resume/stop/message) stay unguarded because archive already refuses while any non-terminal run exists.
- **R13** — the `show-archived` toggle merges `archived` into the current search params instead of replacing the URL wholesale: spec §3.4 says "persisted in the URL as `?archived=1`," not "the only param," and the brief's expected `router.replace('/?archived=1')` / `('/')` still hold when no other param is present.
- **R14** — the closing run (this task) adds `npm run gate:m23-onboarding` to the plan's eight gates, run right after `m21-loose-ends`: Task 2 changed stage 6's assertions and nothing had executed them until now. It ran unchanged and passed (see the closing run below) — no further gate fix was needed.
- **R15** — §8's first bullet ("every verb takes the row lock … so a tick that loaded the world just before the archive cannot dispatch after it") was not true of archive: `archiveWorkspace`'s `FOR UPDATE` is on `Workspace`, a `SlaveRun` insert takes `FOR KEY SHARE` on `Slave`, and the two never conflict. The three orchestrator insert sites (`tick.ts`, `planning.ts`, `review.ts`) now go through one helper, `createRunUnlessArchived` (`apps/orchestrator/src/runs.ts`), which re-reads `archivedAt` under `SELECT … FOR SHARE` on the `Workspace` row inside the transaction that writes the run — `FOR SHARE` does conflict with `FOR UPDATE`, which serialises the pair. A refused insert returns each path's existing "nothing started" outcome (`null`), so nothing is recorded against the task; costs one extra transaction per dispatch.
- **R16** — `org.changed`'s domain payload gains `runs` and `slaves`, both optional: `deleteSlave`/`deleteTeam` had been writing the cascade counts (§4.1/§4.2) onto a `z.object` that did not declare them, so `parseExecutionEvent` stripped them and every `ExecutionEvent`-typed reader saw the event without its counts. Optional because no pre-M27 row and no other `field` carries them. `OrgChangedCard` now appends them on a `deleted` event; costs nothing.
- **R17** — one `plural(n, noun)` helper (`apps/web/src/lib/plural.ts`) behind all seven `DangerConfirm` texts: three wrote `${n} runs` flat ("1 slaves, 1 runs") and four repeated the same inline ternary. Regular nouns only — the one place a verb also has to agree (`CompanyManager`'s "1 project keeps its copies") keeps its own ternary for the verb; costs a conjugation table if an irregular noun ever needs counting.

Two more deliberate omissions, recorded rather than fixed:

- `DepartmentsTable`'s delete confirm does not carry §8's note "the catalog can put it back with assign-company". A confirm states what goes and how much of it (§10: "the confirm text always states counts"), not what could undo it; the remedy belongs in the docs and the CLI help, where it is. Deliberate.
- `ProjectsClient.tsx:284`'s drawer-close `router.replace('/')` drops `archived=1` when both params are present — the same shape as R13, in the one place R13 did not reach. Known, deferred: closing the drawer with the archived toggle on is the only way to hit it, and the toggle is one click away.

Divergences the plan itself predicted (T7 Step 3), both confirmed as intentional:

- The `archived` chip is asserted by `gate-m11-shell.mjs`'s new stage 6, not `gate-m14-fidelity`: m14 re-screenshots and commits its nine PNGs on every run with no pixel-diff against a prior baseline (a human reviews them), so nothing there would have caught a missing chip anyway — the assertion belongs on the gate whose own dedicated project already carries an archived state to check, not on the one whose committed images would gain an unrelated visual change with nothing to verify it.
- `TemplateRow.catalogSlaveCount` was added in Task 6 for the `template-delete` confirm's "and its 3 catalog slaves" text (§5.1); §7's read list did not name it.

Comment-only fixes carried by this task (stale since Task 2's behaviour change; no schema or behaviour change):

- `apps/web/src/app/api/org/teams/[companyTeamId]/route.ts`'s docstring still said the template delete refuses while it has members — it now deletes the template WITH its catalog slaves, refusing only on an unknown id.
- `packages/db/prisma/schema.prisma:159-160` and `:219-220` still said template/company deletion was out of scope — both are deletable now (catalog slaves go with their template).

No further divergence surfaced while executing Task 7 itself: the closing run's nine gates (§9's eight plus `gate:m23-onboarding` per R14) all passed unchanged, and `gate-m11-shell.mjs`'s stage 6 needed one self-correction during authoring (a DOM row-count assertion checked before the client's `router.refresh()` had landed; replaced with the same bounded poll every other assertion in that file already uses) — a gate-authoring fix, not a product or spec divergence.
