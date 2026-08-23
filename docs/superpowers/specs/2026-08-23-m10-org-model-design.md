# M10: The Organization Model — Templates, Companies, Projects — Design

- **Date:** 2026-08-23
- **Status:** Approved (design reviewed in session; user decisions of record recorded below)
- **Parent:** the product direction settled in session on 2026-08-23 from
  `design_handoff_ai_team_os/README.md` (the nine-page shell, 3a, is the structural reference for
  the UI milestones that follow this one)
- **Builds on:** the complete M0–M9 execution engine. This milestone changes NO engine behavior:
  the tick, the passes, guardrails, worktrees, the event log and emergency stop all stand.

M10 lifts the organization out of the workspace. Today one `Workspace` row fuses two ideas: the
WORK (repo, goal, budget) and the STAFF (teams, agents). The product vision separates them: a
global **catalog of agent templates**, reusable **companies** whose rosters are instantiated
from templates, and **projects** that a company is assigned to and staffs automatically. The
same template can serve many companies; the same company can run many projects — with genuinely
parallel, independent workers.

Out of M10: every UI change (the nine-page shell is M11), direct-assignment/model-switch
controls in the web (M12), team suggestions (M13), company un-assignment and re-assignment,
roster-member removal sync, new provider adapters (Cursor/Codex/Gemini stay a Settings-page
promise), and any physical rename of the `Workspace` table.

## 1. Scope

1. **The catalog** — `AgentTemplate`: global, role-shaped cookie cutters with a default model.
2. **The company** — `Company` → `CompanyTeam` → `CompanyAgent`: a persistent roster
   instantiated from templates; the durable identity ("Atlas") statistics accrue to.
3. **Assignment + materialization** — `Workspace.companyId`; assigning a company creates
   PROJECT-LOCAL worker rows from the roster, so two projects of one company run in parallel
   with independent workers.
4. **Model resolution** — worker override → roster override → template default → adapter
   default, passed to the CLI as `--model`.
5. **Control + CLI + seed + the measured gate.**

## 2. Decisions of Record

| # | Decision | Why |
|---|---|---|
| 1 | **Instances live twice**: the company holds a persistent roster (`CompanyAgent`), and assigning the company to a project MATERIALIZES project-local workers (today's `Agent` rows) linked back by `companyAgentId` | User decision. One agent row can run one process at a time, so shared instances would serialize a company's projects against each other; project-local workers give true parallelism while the roster keeps the durable identity |
| 2 | **One company per project** (`Workspace.companyId`, nullable; a company serves many projects) | User decision. Clear ownership — "this project is run by X"; M:N deferred until planning/review/budget ownership questions have answers |
| 3 | **Model override chain**: `AgentTemplate.defaultModel` → `CompanyAgent.model` → worker `Agent.model`, first non-null from the most specific wins | User decision ("assign any model to any agent, any time") with sane defaults |
| 4 | **The `Workspace` table keeps its name** in code and storage; "Project" is product language (UI copy, docs) | A physical rename touches every file and ~950 tests for zero behavior; the UI (M11) is what users see. A later mechanical rename milestone stays possible |
| 5 | Materialization copies the roster's TEAM structure too (`CompanyTeam` → project `Team`) | The company is "teams I built", not a flat list; the existing Team→Agent shape already fits |
| 6 | **Roster sync is additive-only in M10**: re-running materialization adds workers for roster members the project lacks; it never deletes or renames existing workers | A worker with run history must not vanish; removal semantics (retire? reassign tasks?) is its own future decision |
| 7 | Legacy data survives untouched: `companyId` is nullable, and existing seeded workspaces keep their hand-made teams/agents (no forced migration into companies) | The engine never required a company; nothing built before M10 may break |
| 8 | One new event type, `workspace.company_assigned` `{ company, workers }` (actor `human`) | The activity feed is the product's memory; staffing a project is an operator act worth a card. The M8b event-pipeline shape (schema → enum → kind map → card) is the precedent |
| 9 | Template deletion is out of scope; templates are append-only in M10 | Referential simplicity; a template with instances behind it raises versioning questions M10 does not need to answer |

## 3. The Catalog — `AgentTemplate`

```prisma
model AgentTemplate {
  id           String   @id @default(uuid())
  name         String   @unique          // "Java Developer"
  role         String                    // exact-match scheduling role: "backend", "reviewer", "manager", ...
  description  String   @default("")
  defaultModel String?                   // e.g. "claude-sonnet-5"; null = adapter default
  createdAt    DateTime @default(now())
  companyAgents CompanyAgent[]
}
```

`role` is the SAME exact-match string the scheduler, review pass and planning pass already key
on — a template whose role is `reviewer` produces workers the review pass can staff. No new
role machinery.

## 4. The Company and its Roster

```prisma
model Company {
  id        String        @id @default(uuid())
  name      String        @unique
  createdAt DateTime      @default(now())
  teams     CompanyTeam[]
  workspaces Workspace[]
}
model CompanyTeam {
  id        String         @id @default(uuid())
  companyId String
  name      String
  company   Company        @relation(fields: [companyId], references: [id], onDelete: Cascade)
  agents    CompanyAgent[]
  @@unique([companyId, name])
}
model CompanyAgent {
  id            String  @id @default(uuid())
  companyTeamId String
  templateId    String
  name          String            // "Atlas" — the durable identity
  model         String?           // roster-level override of the template default
  companyTeam   CompanyTeam   @relation(fields: [companyTeamId], references: [id], onDelete: Cascade)
  template      AgentTemplate @relation(fields: [templateId], references: [id])
  workers       Agent[]
  @@unique([companyTeamId, name])
}
```

The existing `Agent` (the project-local worker) gains two nullable columns:
`companyAgentId String?` (the roster link; null for legacy hand-made agents) and
`model String?` (the worker-level override). `Workspace` gains `companyId String?`.

## 5. Assignment and Materialization

Control gains `assignCompany(workspaceId, companyId): Promise<Result<AssignReport, ControlRefusal>>`:

1. Refusals: `workspace_not_found`, `company_not_found`, and `company_already_assigned` when
   `workspace.companyId` is non-null and differs (re-assignment is out of scope — Decision 2).
2. Sets `workspace.companyId` (idempotent when already this company).
3. **Materializes additively** (Decision 6): for each `CompanyTeam` ensure a project `Team` of
   the same name exists; for each `CompanyAgent` ensure a worker `Agent` exists in that team
   (matched by `companyAgentId`), created with the roster member's `name`, the template's
   `role`, and `companyAgentId` set. Existing workers are left untouched. All inside one
   transaction.
4. Emits `workspace.company_assigned` `{ company: name, workers: [{ name, role }] }` for the
   NEWLY created workers (empty array on a pure re-sync that added nobody — still emitted, the
   operator asked and the log answers).

Calling it again with the same company IS the sync verb: rerun after growing the roster.

## 6. Model Resolution and the Adapter

Effective model for a run: `worker.model ?? companyAgent.model ?? template.defaultModel ?? null`
(null = the CLI's own default). Resolution happens where runs start — the three dispatch sites
(`startRun`, `dispatchReview`, `dispatchPlanning`) load the worker with its roster+template
chain and pass the result to the adapter. `StartRunInput` gains `readonly model?: string`;
`ClaudeCodeAdapter` appends `--model <value>` to the CLI arguments when set. Resume replays the
SAME model the run started with: `Checkpoint` gains a nullable `model` column (the spawn-critical
-fields precedent — ADR 0001 §5 reasoning), written at start and passed by `adapter.resume`; a
mid-run `setAgentModel` therefore affects the NEXT run, never a resumed continuation. The fake
CLI ignores flags it does not know — verified by a test, not assumed. Legacy
agents (no roster link) resolve through their own `model` column only.

## 7. Control + CLI + Seed

Control (each following the `setGoal`/`emergencyStop` idioms — Result, refusals, events where
warranted): `createTemplate(name, role, { description?, defaultModel? })`,
`createCompany(name)`, `addCompanyTeam(companyId, name)`,
`addCompanyAgent(companyTeamId, templateId, name, { model? })`, `assignCompany` (§5), and
`setAgentModel(agentId, model | null)` (the worker-level override — the "any model, any time"
verb). New refusal kinds as needed, each with a `refusalText` case.

CLI verbs (the `set-goal` idiom, USAGE entries): `create-template --name --role [--model]
[--description]`, `create-company --name`, `add-team --company <id> --name`,
`add-agent --team <companyTeamId> --template <id> --name [--model]`,
`assign-company --workspace <id> --company <id>`, `set-model --agent <workerId> --model <m>`
(and `--clear` to null it).

Seed: a small default catalog (`Engineering Manager`/`manager`, `Backend Developer`/`backend`,
`Frontend Developer`/`frontend`, `QA Reviewer`/`reviewer`, `Java Developer`/`backend` as the
canonical example) and one seeded company ("Atlas Software") whose roster mirrors today's
seeded agents — WITHOUT touching the existing seeded workspace's hand-made staff (Decision 7).

## 8. Testing

The M8-milestone shape, layer by layer: control integration tests per verb (creation,
uniqueness refusals, assignment refusals, additive materialization — assign, grow roster,
re-assign, assert only the delta appeared and existing workers untouched, transactionality on a
mid-way failure); adapter unit tests (model flag present/absent, resume carries it, fake CLI
tolerates it); dispatch-site tests (a worker with a template chain starts its run with the
resolved model — observed through a recording adapter); event-pipeline tests for the new type
(schema round-trip, enum maps, kind map, card); CLI tests per verb; seed test extended.

## 9. Milestone Gate

`gate-m10-org.mjs` (the measured-gate skeleton): via the REAL CLI only — create two templates
(manager+backend+reviewer roles), a company with one team staffed from them, a FRESH workspace
(no hand-made staff), `assign-company`, then `set-goal` and run the daemon with the `m8-flow`
fake; poll write-free until every planned task is `done`; assert the merge commits exist AND
every run's worker traces back to a `companyAgentId` (the org staffed the project, not a
hand-seeded crew). PASS line: *"a company staffed a project from templates and shipped its
goal, unattended."* Second scenario in the same script: assign the SAME company to a second
fresh workspace and let both run concurrently; assert both finish and their workers are
DISTINCT rows sharing roster identities — the parallel-independence claim, measured.

The by-eyes half arrives with M11's Projects/Agents pages; M10 is deliberately headless.
