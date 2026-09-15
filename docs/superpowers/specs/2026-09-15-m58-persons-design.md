# M58 — Persons: a slave is a person, and a project seat is where they sit

**Date:** 2026-09-15 · **Status:** design approved in conversation, spec for review · **Branch:** `feature/m58-persons`

## 1. Why

Today a slave cannot exist without a project: `Slave.teamId` is required and a `Team` belongs to a
`Workspace`. The only project-free thing in the product is the persona template. The roster
(`CompanySlave`) is one step looser but still requires a department, and assigning a company to a
project COPIES its roster into new `Slave` rows — so the same persona working on two projects is
two strangers with two memories and two skill lists.

The operator's asks, verbatim in intent:

1. Create a slave without first creating a project or a department, and assign it anywhere later.
2. Assign skills to people rather than people to skills — and default them on the persona.

Both point at the same missing noun. This milestone adds it.

## 2. Decisions taken with the operator (2026-09-15)

| # | Question | Decision |
|---|---|---|
| D1 | How many projects can one person be on at once? | **Several.** A person is a first-class entity; today's `Slave` row becomes the person's SEAT on one project. |
| D2 | Whose is a memory? | **The person's.** What a person learns on project A they know on project B. The project it was learned on stays recorded. |
| D3 | What becomes of companies and departments? | **Optional grouping.** A person MAY belong to departments; assigning a department to a project opens a seat for each member. Nothing is required. |
| D4 | Where are skills defined? | **Persona default + per-person grant/revoke.** Give a skill to the persona once; every person hired from it has it; adjust per person. |
| D5 | What does "delete" mean? | **Delete the person** — every seat, every run, everything, exactly as deleting a slave does today. The one refusal is a run in progress. "Remove from this project only" is a separate, explicit action. The operator rejected a softer delete: "kişiyi silsin, isterse yaratada bilsin". |
| D6 | Approach | **A — `Person` is a new table; `Slave` stays as the seat.** The scheduler, runs, permissions and tasks keep seeing the seat. Rejected: B (nullable `teamId`, string identity) and C (rename `Slave`→`Assignment` across the tree — a milestone of churn for a name). |

Vocabulary (ia.md rule 3): in the UI the person is called a **slave**; the seat is an
**assignment**. In code the person is `Person` and the seat keeps the table name `Slave`, whose
docstring says so.

## 3. Data model (R1–R9)

**R1 — `Person`.** New table. `id`, `name` (unique across the installation), `createdAt`,
`templateId?` → `SlaveTemplate` (the persona it was hired from), `profile?`, `model?`,
`provider?` (person-level defaults), `capabilities String[]` (M47 R2: what this specialist
PROVIDES — a fact about the person, moved here from the seat), `lifecycle` (`permanent` |
`ephemeral`), `releasedAt?`, `releaseReason?`, `selectionRationale?`.

**R2 — `Slave` is the seat.** Keeps `id`, `teamId` (required, immutable), `role`, `runtimeRoles`
(what it may be DISPATCHED as — a schedule decision, stays on the seat), `engagementTaskId?`
(M50: the one task an ephemeral person was seated for), seat-level `profile?`/`model?`/`provider?`
overrides, and every existing child: `SlaveRun`, `SlavePermission`, `SlaveMessage`, tasks. Gains
`personId` (required) and `closedAt?` — a seat that was removed from a project keeps its history
and is CLOSED, not deleted; seating the same person on the same team again reopens that row. Loses `name`, `capabilities`, `hiredFromTemplateId`, `companySlaveId`,
`lifecycle`, `releasedAt`, `releaseReason`. New `@@unique([personId, teamId])`: one seat per person
per team.

**R3 — Skills.** `TemplateSkill (templateId, skillId)` is the persona default;
`PersonSkill (personId, skillId, mode: granted | revoked)` is the per-person adjustment. The
**effective set** = template ∪ granted − revoked, computed on read by one pure domain function,
never copied. `SlaveSkill` is dropped (no seat-level skill difference was wanted).

**R4 — Memory.** `Memory.personId?` is added and `Memory.slaveId` dropped; `workspaceId` /
`companyId` remain as "where it was learned". Recall scope for a run is `project ∪ company ∪
person` (§5).

**R5 — Departments.** `CompanySlave` is dropped; `CompanyTeamMember (companyTeamId, personId)`
replaces it. Assigning a company to a project opens one seat per member (binding, not copying).

**R6 — The pool is derived.** A person with no OPEN seat and `releasedAt = null` is "in the pool".
There is no status column for it.

**R7 — Override chain.** Profile, model and provider resolve seat → person → template. The existing
`effectiveProfile` gains one level; model and provider get the same shape. `PROFILE_MAX_CHARS`
applies at every level.

**R8 — Migration.** ONE migration, irreversible, with a backfill written for a FULL database even
though the operator's is empty today: one `Person` per existing `Slave` (name collisions become
`<name> (<project name>)`); `Slave.personId` filled; `SlaveSkill` → `PersonSkill(granted)`;
`Memory.slaveId` → `personId`; each `CompanySlave` → a `Person` with no seat (it lands in the pool)
plus a `CompanyTeamMember`; then the old columns and tables go. An integration test proves it on a
populated fixture (§7).

**R9 — Untouched.** `Task`, `SlaveRun`, `SlavePermission`, `Team`, `Workspace`, `Company`,
`CompanyTeam`, every simulation table, the event catalogue (still 61 types — a person's creation
and seating are recorded with the existing `slave.*` types carrying `personId` in the payload where
the payload already carries `slaveId`).

## 4. Control layer and CLI (R10–R16)

**R10 — New functions** (`packages/control`, `ok()`/`err()`, a refusal after a write inside
`$transaction` throws):

| Function | Behaviour |
|---|---|
| `createPerson({ templateId?, name?, profile?, model?, provider?, capabilities? })` | From a persona or from nothing; lands in the pool. Name defaults to the template's; a taken name gets ` 2`, ` 3`. |
| `assignPerson(personId, teamId, { role?, runtimeRoles? })` | Opens a seat. Refusals: `already_assigned`, `person_released`. |
| `unassignPerson(personId, teamId, { reason })` | Closes a seat (`closedAt`). Refusal: `run_in_progress`. Runs, messages and permissions stay with the closed seat as history; a later `assignPerson` on the same team reopens it. The real delete is R13. |
| `movePerson(personId, fromTeamId, toTeamId)` | unassign + assign in one transaction. |
| `releasePerson(personId, reason)` | Closes every seat, sets `releasedAt`. History kept. |
| `deletePerson(personId)` | R13. |
| `setPersonSkills(personId, { grant, revoke })`, `setTemplateSkills(templateId, skillIds)` | R3. |
| `joinDepartment(personId, companyTeamId)`, `leaveDepartment(...)` | R5. |

**R11 — Existing verbs keep working, bound to the new model** (ia.md rule 2):

| Verb | Now |
|---|---|
| `add-slave --team --template --name` | `createPerson` + `joinDepartment` |
| `assign-company --workspace --company` | `assignPerson` for every member — the SAME person, no copy |
| `hire --workspace --template --why [--temporary --for-task]` | `createPerson` (+ `lifecycle: ephemeral`) + `assignPerson` with `engagementTaskId` |
| `move-slave --slave --team` | `movePerson` (resolves the seat's person) |
| `move-company-slave`, `delete-company-slave` | department membership change / `leaveDepartment` |
| `delete-slave --slave` | `deletePerson` of the seat's person (R13) |
| `rename-slave --slave --name` / `--role` | name → the person; role → the seat |
| `release-worker --slave --reason` | `releasePerson` |
| `set-profile` / `set-model` `--slave` | the seat; new `--person` targets the person |
| `set-capabilities` | `--person` only (a capability is a person fact); `--slave` is accepted and resolved to the person, with a line saying so |

**R12 — New verb family `person`:** `person create|list|show|assign|unassign|move|release|delete|skills`. `person list` shows pool and seats together; `--pool`, `--released`, `--department`.

**R13 — Delete deletes.** `deletePerson` removes the person and, by cascade, every seat with its
runs, messages, checkpoints, permissions and memories the person owns — what deleting a slave does
today. One refusal: `run_in_progress` on any seat. The CLI and the UI confirmation both say how
many projects the person is on ("this slave works on 2 other projects; all of it goes"). A deleted
person's persona template is untouched; re-creating from it is one command.

**R14 — Refusal kinds added:** `already_assigned`, `person_released`, `run_in_progress`,
`person_name_taken`. Each has operator text in `refusal.ts`; none changes an existing text.

**R15 — Web API.** `POST /api/org/slaves` → `createPerson` (optional department, optional team);
`GET /api/org/workers` → persons with their seats; `DELETE /api/slaves/[id]` → `deletePerson`
(R13); new `POST /api/persons/[id]/assign`, `POST /api/persons/[id]/unassign`,
`PATCH /api/persons/[id]/skills`, `PATCH /api/templates/[id]/skills`, `DELETE /api/persons/[id]`.

**R16 — Supervisor.** When a project needs a capability nobody seated provides, the Supervisor
first looks in the pool: a matching person yields a proposal "seat <name> on this project"; none
yields "create <persona> and seat them" (today's proposal). Two proposal texts, one approval flow,
the same decision kinds.

## 5. Scheduler, run context, memory (R17–R21)

**R17 — The scheduler keeps seeing seats.** A task belongs to a project; the tick looks at that
project's OPEN seats (`closedAt IS NULL`). The only other change is the selection query:
`runtimeRoles` on the seat, `capabilities` via the person join. A pooled person enters no tick.

**R18 — Run context.** Profile, model, provider through the three-level chain (R7). The skills
mounted for a run are the person's effective set (R3). The person's name is the name in the
prompt, the same on every project.

**R19 — Memory write and recall.** A memory written from a run carries the run's seat's `personId`
and the project as `workspaceId`. Recall for a run is today's `project ∪ company` plus `person`.
The Supervisor's memory lane and the Knowledge page show a "from" column for person-scoped rows
(the project it was learned on).

**R20 — Concurrency.** One person may have runs on two projects at once; each run is its own
process and state directory already. Pause, stop and the breaker stay per run / per project. A
person-level "stop everything" is out of scope (§8).

**R21 — Ephemeral (M50).** `hire --temporary` creates the person and a seat with
`engagementTaskId`; `engagement_over` closes the seat and sets `releasedAt`. A released person is
not in the pool, is listed under the "released" filter, and can be deleted.

## 6. UI (R22–R28)

**R22 — Workforce → People lists persons.** One row per person: name, persona, departments,
skill count, and WHERE THEY WORK — one chip per seat (project name) or "in the pool". Filters:
pool / assigned / released, department, skill. `⋯` opens the person panel.

**R23 — Person panel** (the slave panel in the right-panel slot, for a person): person facts
(persona, profile, model/provider, capabilities); a **Projects** group listing seats with role and
runtime roles, "remove from project" per seat, and "assign to project" (project → team) below; a
**Skills** group showing the effective set — template-inherited rows muted and labelled "from
persona", grants plain, revokes struck through — with add/remove here. **Delete** lives here, with
the multi-project count in its confirmation (R13). Opened from inside a project, the same
component shows that project's seat group first.

**R24 — New slave drawer.** Persona (searchable) + name only; department and project are optional
and empty by default → the person lands in the pool. Opened inside a project, the project is
preselected.

**R25 — Persona row (Catalog tab).** A **Default skills** editor. Changing it changes every person
hired from that persona at once (R3: computed, not copied).

**R26 — Skills page.** Each skill row lists "who has it" read-only (name, from persona / from
person) with a link to the person panel; the per-row "pick a slave" assignment control goes. Rule 2:
the old path is one click away through the person panel.

**R27 — Project Team page and Overview Team band** keep showing seats (who is on THIS project); a
name opens the person panel; "Add" offers the pool or a new person.

**R28 — Words.** Person states a human reads — "in the pool", "assigned", "released" — come from
`USER_*_LABEL` tables; the raw value stays in `data-`/`title`. No surface prints a bare enum member.

## 7. Tests and the 33rd gate (R29–R33)

**R29 — Migration test (integration).** A populated pre-migration fixture (two projects, two
same-named slaves, a roster row with no seat, a slave-scoped memory, a slave skill); run the
migration; assert one person per old slave, the collision renamed `<name> (<project>)`, the
roster row a pooled person, memory and skill on the person, and unchanged counts of runs,
permissions and tasks.

**R30 — Control (integration).** One case per new function and per refusal kind; a refusal after a
write rolls back; `assign-company` binds the same person to a second project (no copy);
`deletePerson` cascade counts; the effective-skill function unit-tested in the domain.

**R31 — Run context.** Three-level chain; effective skills mounted; a memory written on project A
recalled on project B.

**R32 — Web (jsdom).** People rows with seat chips and the three filters; person panel Projects
and Skills groups (inheritance label, grant/revoke, remove, assign); drawer creates without
department or project; Skills page shows links, not selects; delete confirmation states the count.

**R33 — `gate:m58-persons`** (Playwright, fake CLI, zero spend; 33rd in `package.json` and
`ci.yml` after `gate:m57-ui-redesign`; README says 33): (1) create a person from the Catalog →
People says "in the pool"; (2) seat on two projects → two chips, same name on both Team pages;
(3) run a task on A that writes a memory → B's run context recalls it; (4) give the persona a skill
→ the person shows it "from persona"; revoke on the person → gone from the effective set;
(5) remove from one project → still on the other; (6) delete → gone everywhere, and the
confirmation had said "2 projects"; (7) `add-slave`, `assign-company`, `hire --temporary` still
work. Existing gates that read slave/roster testids (m11, m44, m45, m47, m48, m49, m50, m52) are
listed line by line in the plan and edited only where a testid genuinely moved.

**Ladder:** never below M57's 381 files / 6604 tests.

## 8. Out of scope, said so

A person-level "stop everything"; project-private memories; budget sharing across seats; a
person analytics page; renaming the `Slave` table. Each becomes a "Later" line in `docs/ia.md`.

## 9. Constraints carried from earlier milestones

Never a real model call in a test or a gate; one vitest at a time; `${PIPESTATUS[0]}`; no
prettier; the vocabulary word is slave (the persona catalogue is "the Agency persona catalogue" in
every tracked line — its repository name contains the forbidden token); labels never keys; real is
not simulated; refusals after a write inside a transaction throw; every task ends with focused
tests, `gate:m26-vocabulary`, `tsc --build`, `typecheck`, `web:build` and a commit.

## 10. Errata — where execution corrects this spec

(none yet)
