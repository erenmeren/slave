# Conductor, Plan 2 of 5: the conductor turns a goal into requirements, packages and seats, and every worker reports

> **For workers carrying this out:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec R1 (requirement sets), R2 (the conductor's size decision), R3 (work packages with disjoint file ownership, materialised as tasks), R5 (one seat per package) and R7 (every package worker ends with a `<slave-report>`; its questions go to the conductor), behind a per-workspace `delivery = conducted` switch.

**Architecture:** A new orchestrator step, `conduct(deps)`, runs in the tick where `dispatchPlanning` runs today, for `conducted` workspaces only. One model call per tick: first the requirement extraction (stored as a `RequirementSet` per goal version, keys stable across versions), then the size decision (`single` or `partitioned`), validated by a pure domain function (coverage, disjoint globs over the repository's files, integration fallback), recorded as a Supervisor decision, staffed one seat per package, and materialised as one `Task` per `WorkPackage` pinned to its seat. Every conductor call is logged in `ConductorCall` (cost, outcome, retry cap). A package task's prompt carries its requirements, owned paths, interface and the report contract; at the run's end the report is parsed before verify, stored as `RunReport`, and a missing or broken report sends the task back to rework. Questions go to role `conductor`, which no seat holds, so the Supervisor's existing sourced-answer path answers them.

**Tech Stack:** TypeScript monorepo (npm workspaces, ESM, `.js` import suffixes), Prisma/Postgres, vitest (unit + integration projects), zod.

**Spec:** `docs/superpowers/specs/2026-09-27-conductor-supervisor-design.md` (R1, R2, R3, R5, R7; §5, §6). Plan 1 shipped R0 and R6. Plan 3 = R4 (ownership enforcement: gate deny + diff audit). Plan 4 = R8/R9 (verification run, gate, integration branch, intake staffing change, `conducted` as the default for new projects, fake-CLI end to end). Plan 5 = R10/R11 (report page, remaining situations).

## Decisions this plan makes (read before starting)

- **D1. `conducted` is opt-in until Plan 4.** The migration adds `Workspace.delivery` with default `planned`; a person switches a workspace with the new CLI verb `set-delivery`. Spec §5 makes `conducted` the default for new projects, but without Plan 3's ownership enforcement and Plan 4's gate a conducted project would merge unverified package work into the base branch; Plan 4 flips the default when the gate exists.
- **D2. The conductor names each package's persona (`templateId`) from the catalogue it is shown**, instead of running `formTeam` over package capabilities (spec R5). `formTeam` covers a capability set with possibly several seats; a package needs exactly one. The catalogue summary lists each template's capabilities, so the choice is made with the same facts. Staffing reuses an idle seat of that template first (spec R5), else hires with `hireFromTemplate(..., { requirePool: true, newSeat: true })`.
- **D3. A package task is pinned to its seat.** `SchedulableTask.pinnedSlaveId` (the task's `assigneeId` when `workPackageId` is set); `decide()` gives a pinned task only to that seat. Package tasks carry `requiredRole = PACKAGE_WORKER_ROLE` (`'implementer'`), and every package seat holds that role, so the world loader, `ready_unstaffed` and the review exclusion keep working unchanged.
- **D4. One model call per tick, cap 3 failures per stage and goal version.** Requirements that cannot be extracted after 3 failures halt the workspace (guardrail `conductor_failed`): without requirements there is nothing to gate. A size decision that is unusable 3 times falls back to `single` (the spec's default) with that reason recorded; `single` is always valid.
- **D5. A new goal version is conducted only when the board is clear.** Conducting version N waits while any task that is not a package of version N is live (not `failed`/`cancelled`, and not `done` with `integratedAt` set). Two goal versions' packages owning the same files at once would break ruling 3. Plan 4 replaces this with the integration-branch rule.
- **D6. The conductor's cost lives on `ConductorCall` rows**, added to `workspaceSpend` as its own term; the `conduct` Supervisor decision row carries `modelCalled: false` (the chat precedent in `supervisorChatTick.ts`'s `recordReplyActions`: never bill one call twice).
- **D7. The `conduct` decision row is written directly inside the materialisation transaction**, not through `recordDecision`: the size decision, the packages and the tasks commit together or not at all, and a conductor decision is not subject to Supervisor cooldowns or the `supervisorEnabled` switch (the conductor IS the delivery mechanism of a conducted workspace). It is still validated with the domain's `situationSchema` and `candidateSchema`.
- **D8. Report questions are asked after the fact.** A `<slave-report>`'s `questions` become `question` messages to role `conductor` with `expectsReply: true` and the task id; the run has ended, so the answer lands in the seat's inbox for its next run on that task. Questions that must block work are asked mid-run with `<slave-ask>` to role `conductor` (the ask protocol now offers it to package tasks).

## Global Constraints

- Vocabulary: the product says "slave", never "agent" (gate `node scripts/gate-m26-vocabulary.mjs` must pass). Never write the string "agency-agents" anywhere tracked.
- Never run prettier (no prettier config in the repo). Match surrounding code: WHY doc comments, `readonly`, explicit return types, `.js` import suffixes, `Result`/`ok`/`err` from `packages/domain/src/result.ts`.
- Tests: ONE vitest process at a time (shared test DB). Targeted runs while iterating (`npx vitest run <file>`); at the end `npm run typecheck && npx vitest run` once (~5 min), and `npm run web:build` (no `next dev` may be running).
- Never touch the dev DB (`DATABASE_URL`); tests use `TEST_DATABASE_URL`. Never `db:seed`. A scratch script that needs Prisma exports `DATABASE_URL=$TEST_DATABASE_URL` first.
- Migrations are hand-written SQL in `packages/db/prisma/migrations/<timestamp>_<name>/migration.sql`, purely additive, with a WHY header; then `npm run db:generate` and `npm run db:migrate:test`.
- `vi.spyOn` on a Prisma delegate breaks later tests: assign a wrapper and restore in `finally`.
- A refusal inside a Prisma interactive transaction must THROW to roll back; a returned value commits what was written.
- Every commit message ends with exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Spec R1 verbatim: "each item one testable statement, quoted-or-paraphrased from the goal, no invented scope, 1–60 items. No approval step (ruling 6). Event `workspace.requirements_set` with the count. A goal change produces a new set; items that are textually equal keep their key."
- Spec R2 verbatim: "`single` is the default the prompt argues for; `partitioned` must name ≥ 2 packages whose owned paths are disjoint and give a size reason. Recorded as a Supervisor decision (`situationKind: conduct`, tier `applied`) so it is in the decision trail. Planner-graph planning is not dispatched for a conducted workspace."
- Spec R3 verbatim: "every requirement in exactly one package; owned path globs pairwise disjoint over the repository's current files **and** over new paths the packages declare; a path matched by no package is owned by the `integration` package (created by the validator if the conductor named none, dependent on all others)."
- Spec R7 verbatim: "`<slave-report>{ "requirements": [{ "key", "status": "done|partial|not_done", "evidence" }], "filesTouched": [...], "workflow": [{ "step", "done", "note" }], "questions": [...] }</slave-report>`. Parsed and stored (`RunReport`); a missing or unparsable report is a run failure with a clear reason (one rework)."

## Review Focus

- A goal whose text contains a fake-CLI routing literal (`"candidateIndex"`, `"sources"`, `"requirementsAnswer"` …) or a protocol marker (`<slave-report>`) must not re-route the conductor's own calls or forge a report: the goal is defused before it enters any prompt (Task 2, Task 3 tests).
- A repository with thousands of files or binary files must not blow the conductor prompt or the tick: the map is bounded by file count and characters, binaries and large files are listed without symbols (Task 4 tests).
- A conductor answer whose globs overlap only on a file that does not exist yet and that no package declared is accepted; one that overlaps on an existing file or a declared new path is refused, and the refusal text reaches the next attempt's prompt (Task 3, Task 6 tests).
- Two packages naming the same persona get two different seats; a third package of a persona whose pool is exhausted fails staffing with a clear reason instead of silently doubling a seat (Task 7 tests).
- A report that names a requirement twice, omits one, or is cut off mid-JSON sends the task to rework with a sentence that names what was wrong; a well-formed report after a malformed one is accepted (Task 9 tests).

---

### Task 1: Schema, migration, events and constants

**Files:**
- Create: `packages/db/prisma/migrations/20260928090000_conductor_core/migration.sql`
- Modify: `packages/db/prisma/schema.prisma` (`model Workspace`, `model Task`, `enum SupervisorSituationKind`, `enum EventType`, new models/enums)
- Modify: `packages/db/src/enums.ts` (`EVENT_TYPE_BY_DOMAIN_TYPE`)
- Modify: `packages/domain/src/events/schema.ts` (two event variants)
- Create: `packages/domain/src/conduct/constants.ts`
- Create: `packages/domain/src/conduct/index.ts`
- Modify: `packages/domain/src/index.ts` (export `./conduct/index.js`)
- Modify: `packages/control/test/integration/helpers.ts` (`truncateAll` list)
- Test: `packages/domain/test/events/conductor-events.test.ts`

**Interfaces:**
- Produces (Prisma): `enum Delivery { conducted planned }`; `Workspace.delivery Delivery @default(planned)`; `model RequirementSet`; `model WorkPackage`; `Task.workPackageId String?`; `model RunReport`; `enum ConductorStage { requirements conduct }`; `enum ConductorCallOutcome { ok failed }`; `model ConductorCall`; `SupervisorSituationKind.conduct`; `EventType.workspace_requirements_set`, `EventType.workspace_conducted`.
- Produces (domain events): `workspace.requirements_set { version: int>0, count: int>0, setId: string }`, `workspace.conducted { version: int>0, mode: 'single'|'partitioned', packages: string[] /* keys */, decisionId: string, fallback: boolean }`.
- Produces (constants, `@slave-of-ai/domain`): `CONDUCTOR_ROLE = 'conductor'`, `PACKAGE_WORKER_ROLE = 'implementer'`, `CONDUCT_RETRY_CAP = 3`, `CONDUCT_PER_CALL_CAP_USD` (= `SUPERVISOR_PER_CALL_CAP_USD`), `REQUIREMENTS_MAX_ITEMS = 60`, `REQUIREMENT_TEXT_MAX_CHARS = 600`, `CONDUCT_MAX_PACKAGES = 8`, `REPO_MAP_MAX_FILES = 2000`, `REPO_MAP_SYMBOL_FILES_MAX = 400`, `REPO_MAP_MAX_CHARS = 40_000`, `CONDUCT_CATALOGUE_MAX_CHARS = 30_000`, `INTEGRATION_PACKAGE_KEY = 'integration'`.

- [ ] **Step 1: Migration**

`packages/db/prisma/migrations/20260928090000_conductor_core/migration.sql`:
```sql
-- Conductor Plan 2 (spec R1, R2, R3, R5, R7), 2026-09-28: the conductor's data.
--
-- A conducted workspace turns each goal version into a numbered requirement set (R1), decides
-- single or partitioned (R2), splits the work into packages that own disjoint files (R3), and
-- every package worker files a structured report (R7). `ConductorCall` is the conductor's own
-- ledger of model calls: its retry cap, its cost (summed into the workspace's spend) and its
-- audit trail. PURELY ADDITIVE: two enum types, one enum-typed column with a default every
-- existing workspace reads as `planned` (today's planner graph, unchanged), one nullable column,
-- four tables, two enum values on existing types. Nothing existing changes shape.
--
-- `ALTER TYPE ... ADD VALUE` runs inside Prisma's per-migration transaction, which Postgres 12+
-- allows so long as the new value is not USED in the same transaction. Nothing here uses them.

CREATE TYPE "Delivery" AS ENUM ('conducted', 'planned');
CREATE TYPE "ConductorStage" AS ENUM ('requirements', 'conduct');
CREATE TYPE "ConductorCallOutcome" AS ENUM ('ok', 'failed');

ALTER TABLE "Workspace" ADD COLUMN "delivery" "Delivery" NOT NULL DEFAULT 'planned';

CREATE TABLE "RequirementSet" (
    "id"           TEXT NOT NULL,
    "workspaceId"  TEXT NOT NULL,
    "goalVersion"  INTEGER NOT NULL,
    "items"        JSONB NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequirementSet_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RequirementSet_workspaceId_goalVersion_key" ON "RequirementSet"("workspaceId", "goalVersion");
ALTER TABLE "RequirementSet" ADD CONSTRAINT "RequirementSet_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkPackage" (
    "id"              TEXT NOT NULL,
    "workspaceId"     TEXT NOT NULL,
    "goalVersion"     INTEGER NOT NULL,
    "key"             TEXT NOT NULL,
    "title"           TEXT NOT NULL,
    "requirementKeys" TEXT[] NOT NULL,
    "ownedPaths"      TEXT[] NOT NULL,
    "newPaths"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "interface"       TEXT NOT NULL,
    "dependsOn"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isIntegration"   BOOLEAN NOT NULL DEFAULT false,
    "templateId"      TEXT NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkPackage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WorkPackage_workspaceId_goalVersion_key_key" ON "WorkPackage"("workspaceId", "goalVersion", "key");
ALTER TABLE "WorkPackage" ADD CONSTRAINT "WorkPackage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Task" ADD COLUMN "workPackageId" TEXT;
CREATE INDEX "Task_workPackageId_idx" ON "Task"("workPackageId");
ALTER TABLE "Task" ADD CONSTRAINT "Task_workPackageId_fkey" FOREIGN KEY ("workPackageId") REFERENCES "WorkPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RunReport" (
    "id"            TEXT NOT NULL,
    "runId"         TEXT NOT NULL,
    "taskId"        TEXT NOT NULL,
    "workPackageId" TEXT NOT NULL,
    "report"        JSONB NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RunReport_runId_key" ON "RunReport"("runId");
CREATE INDEX "RunReport_workPackageId_idx" ON "RunReport"("workPackageId");
ALTER TABLE "RunReport" ADD CONSTRAINT "RunReport_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SlaveRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunReport" ADD CONSTRAINT "RunReport_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RunReport" ADD CONSTRAINT "RunReport_workPackageId_fkey" FOREIGN KEY ("workPackageId") REFERENCES "WorkPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ConductorCall" (
    "id"           TEXT NOT NULL,
    "workspaceId"  TEXT NOT NULL,
    "goalVersion"  INTEGER NOT NULL,
    "stage"        "ConductorStage" NOT NULL,
    "outcome"      "ConductorCallOutcome" NOT NULL,
    "reason"       TEXT,
    "modelCostUsd" DOUBLE PRECISION,
    "unmeasured"   BOOLEAN NOT NULL DEFAULT false,
    "plan"         JSONB,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConductorCall_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConductorCall_workspaceId_goalVersion_stage_idx" ON "ConductorCall"("workspaceId", "goalVersion", "stage");
ALTER TABLE "ConductorCall" ADD CONSTRAINT "ConductorCall_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "SupervisorSituationKind" ADD VALUE IF NOT EXISTS 'conduct';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.requirements_set';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.conducted';
```

Check the `EventType` value spelling first: open `packages/db/prisma/schema.prisma` around `workspace_goal_set @map("workspace.goal_set")` (~line 2114). The Postgres value is the `@map` string; if the existing migrations add values with the dotted spelling (see `20260921110000_planning_stalled`: `'workspace.planning_reset'`), keep the dotted spelling above.

- [ ] **Step 2: Schema**

In `schema.prisma`:
```prisma
/// Conductor R2/R3 (2026-09-28): how a workspace turns a goal into work. `planned` is the planner
/// graph (M8 onwards); `conducted` is the conductor: requirements, a size decision, packages that
/// own disjoint files, one seat each. Default `planned` until Conductor Plan 4 ships the gate.
enum Delivery {
  conducted
  planned
}

enum ConductorStage {
  requirements
  conduct
}

enum ConductorCallOutcome {
  ok
  failed
}
```
`model Workspace`, beside `goalVersion`:
```prisma
  /// Conductor (spec §5): `conducted` workspaces are delivered by the conductor, never by the
  /// planner graph. Switched with the CLI's `set-delivery`.
  delivery                Delivery  @default(planned)
```
and relations `requirementSets RequirementSet[]`, `workPackages WorkPackage[]`, `conductorCalls ConductorCall[]`.

`model Task`: `workPackageId String?`, relation `workPackage WorkPackage? @relation(fields: [workPackageId], references: [id], onDelete: SetNull)`, `runReports RunReport[]`, `@@index([workPackageId])`.

`model SlaveRun`: relation `report RunReport?`.

New models:
```prisma
/// Conductor R1: the numbered requirements of one goal version, extracted by the conductor with
/// no approval step (ruling 6). `items` is `[{ key: 'R1', text, source }]`; keys are stable across
/// versions for textually equal items.
model RequirementSet {
  id          String   @id @default(uuid())
  workspaceId String
  goalVersion Int
  items       Json
  createdAt   DateTime @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@unique([workspaceId, goalVersion])
}

/// Conductor R3: one package of one goal version. Owns `ownedPaths` (repo-relative globs); the
/// integration package also owns every path no other package matches (`ownerOf`).
model WorkPackage {
  id              String   @id @default(uuid())
  workspaceId     String
  goalVersion     Int
  key             String
  title           String
  requirementKeys String[]
  ownedPaths      String[]
  newPaths        String[] @default([])
  interface       String
  dependsOn       String[] @default([])
  isIntegration   Boolean  @default(false)
  templateId      String
  createdAt       DateTime @default(now())

  workspace Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  tasks     Task[]
  reports   RunReport[]

  @@unique([workspaceId, goalVersion, key])
}

/// Conductor R7: the structured report a package worker's final message carried.
model RunReport {
  id            String   @id @default(uuid())
  runId         String   @unique
  taskId        String
  workPackageId String
  report        Json
  createdAt     DateTime @default(now())

  run         SlaveRun    @relation(fields: [runId], references: [id], onDelete: Cascade)
  task        Task        @relation(fields: [taskId], references: [id], onDelete: Cascade)
  workPackage WorkPackage @relation(fields: [workPackageId], references: [id], onDelete: Cascade)

  @@index([workPackageId])
}

/// Conductor D4/D6: every model call the conductor made, ok or failed. The retry cap counts the
/// failed rows per (goal version, stage); `workspaceSpend` sums the cost. `plan` is the validated
/// `ConductPlan` of an ok `conduct` call: staffing can fail after the answer was bought, and the
/// next tick must staff the SAME plan rather than pay for a new one.
model ConductorCall {
  id           String               @id @default(uuid())
  workspaceId  String
  goalVersion  Int
  stage        ConductorStage
  outcome      ConductorCallOutcome
  reason       String?
  modelCostUsd Float?
  unmeasured   Boolean              @default(false)
  plan         Json?
  createdAt    DateTime             @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId, goalVersion, stage])
}
```
`enum SupervisorSituationKind`: append `conduct` with the comment `// Conductor R2: the size decision of one goal version. Not produced by observe; written by the conductor. Subject "<workspaceId>:v<version>".`
`enum EventType`: add `workspace_requirements_set @map("workspace.requirements_set")` and `workspace_conducted @map("workspace.conducted")` next to `workspace_goal_set`.

Run: `npm run db:generate && npm run db:migrate:test`
Expected: migration applied, client generated.

- [ ] **Step 3: Write the failing event test**

`packages/domain/test/events/conductor-events.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { executionEventSchema } from '../../src/events/schema.js'

const envelope = {
  id: '00000000-0000-4000-8000-000000000001',
  seq: 1,
  workspaceId: 'w1',
  taskId: null,
  actor: 'system' as const,
  createdAt: new Date('2026-09-28T09:00:00Z').toISOString(),
}

describe('conductor events', () => {
  it('accepts workspace.requirements_set with the count', () => {
    const parsed = executionEventSchema.safeParse({
      ...envelope,
      type: 'workspace.requirements_set',
      payload: { version: 2, count: 7, setId: 's1' },
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts workspace.conducted and refuses an unknown mode', () => {
    const base = { ...envelope, type: 'workspace.conducted' }
    const good = { version: 1, mode: 'partitioned', packages: ['cli', 'report', 'integration'], decisionId: 'd1', fallback: false }
    expect(executionEventSchema.safeParse({ ...base, payload: good }).success).toBe(true)
    expect(executionEventSchema.safeParse({ ...base, payload: { ...good, mode: 'both' } }).success).toBe(false)
  })
})
```
Before writing it, open `packages/domain/src/events/schema.ts` and copy the exact exported union name and envelope fields from an existing test in `packages/domain/test/events/` (the names above are the likely ones; use the real ones).

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run packages/domain/test/events/conductor-events.test.ts`
Expected: FAIL (unknown event type).

- [ ] **Step 5: Add the event variants and the db mapping**

In `packages/domain/src/events/schema.ts`, after the `workspace.replanned` variant:
```ts
  // Conductor R1 (2026-09-28): a goal version's requirement set was extracted. `count` is the
  // number of items, `setId` the `RequirementSet` row -- the report reads the items from there.
  z.object({
    ...envelope,
    type: z.literal('workspace.requirements_set'),
    payload: z.object({
      version: z.number().int().positive(),
      count: z.number().int().positive(),
      setId: z.string().min(1),
    }),
  }),
  // Conductor R2/R3: a goal version was conducted -- the size decision recorded, its packages
  // materialised as tasks. `fallback` is true when the conductor's answers were unusable and the
  // version went `single` by default (plan decision D4).
  z.object({
    ...envelope,
    type: z.literal('workspace.conducted'),
    payload: z.object({
      version: z.number().int().positive(),
      mode: z.enum(['single', 'partitioned']),
      packages: z.array(z.string().min(1)).min(1),
      decisionId: z.string().min(1),
      fallback: z.boolean(),
    }),
  }),
```
In `packages/db/src/enums.ts` add `'workspace.requirements_set': 'workspace_requirements_set'` and `'workspace.conducted': 'workspace_conducted'` beside `'workspace.goal_set'`.

If the web activity feed has a total `Record` over event types (the build will say so: `npm run typecheck`), add a sentence for each, e.g. "set the requirements for goal v2 (7 items)" and "conducted goal v2: partitioned into 3 packages".

- [ ] **Step 6: Constants**

`packages/domain/src/conduct/constants.ts`:
```ts
import { SUPERVISOR_PER_CALL_CAP_USD } from '../supervisor/constants.js'

/**
 * The role a question to the conductor is addressed to (spec R7). No seat ever holds it, so a
 * question to it is `unanswerable_question` the moment it is written, and the Supervisor's sourced
 * answer path -- the conductor's own voice -- answers it.
 */
export const CONDUCTOR_ROLE = 'conductor'

/**
 * The runtime role every package seat holds (plan decision D3). Package tasks require it; which
 * seat runs a package is decided by the pin (`SchedulableTask.pinnedSlaveId`), not by the role.
 */
export const PACKAGE_WORKER_ROLE = 'implementer'

/** The reserved key of the package that owns every path no other package matches (spec R3). */
export const INTEGRATION_PACKAGE_KEY = 'integration'

/** Failed conductor calls per goal version and stage before the fallback (plan decision D4). */
export const CONDUCT_RETRY_CAP = 3

/** One conductor call's budget: the Supervisor's per-call cap, for the same kind of call. */
export const CONDUCT_PER_CALL_CAP_USD = SUPERVISOR_PER_CALL_CAP_USD

/** Spec R1: "1–60 items". */
export const REQUIREMENTS_MAX_ITEMS = 60

/** One requirement's text and source sentence, each; a longer one is a paragraph, not a check. */
export const REQUIREMENT_TEXT_MAX_CHARS = 600

/** The most packages a partitioned goal may have, integration included. */
export const CONDUCT_MAX_PACKAGES = 8

/** The repository map lists at most this many files (the rest are counted, not listed). */
export const REPO_MAP_MAX_FILES = 2000

/** Files whose top-level symbols are read for the map; the rest are listed with their size only. */
export const REPO_MAP_SYMBOL_FILES_MAX = 400

/** The repository map's size in the conductor prompt. */
export const REPO_MAP_MAX_CHARS = 40_000

/** The catalogue summary's size in the conductor prompt. */
export const CONDUCT_CATALOGUE_MAX_CHARS = 30_000
```
`packages/domain/src/conduct/index.ts`: `export * from './constants.js'` (later tasks add lines). Add `export * from './conduct/index.js'` to `packages/domain/src/index.ts`.

Add `"RunReport", "ConductorCall", "WorkPackage", "RequirementSet"` to the `TRUNCATE` list in `packages/control/test/integration/helpers.ts` (`truncateAll`), and to every integration test file you touch later whose own `TRUNCATE` lists `"Task"` — `CASCADE` from `Workspace` covers them, but name them for clarity only where the file already names children explicitly.

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run packages/domain/test/events/conductor-events.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add packages/db packages/domain packages/control/test/integration/helpers.ts apps/web
git commit -m "feat(db): the conductor's data -- delivery, requirement sets, packages, run reports, conductor calls

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Requirements -- prompt, parser, stable keys (domain)

**Files:**
- Create: `packages/domain/src/conduct/requirements.ts`
- Modify: `packages/domain/src/conduct/index.ts`
- Modify: `packages/domain/src/handoff/contract.ts` (`ROUTING_LITERALS`)
- Test: `packages/domain/test/conduct/requirements.test.ts`

**Interfaces:**
- Consumes: constants from Task 1; `firstJsonObject` (`packages/domain/src/supervisor/prompt.ts:119`); `defuseRoutingLiterals`, `ROUTING_LITERALS` (`packages/domain/src/handoff/contract.ts`); `Result`, `ok`, `err`.
- Produces:
  - `export const REQUIREMENTS_ANSWER_KEY = 'requirementsAnswer'`
  - `export interface RequirementItem { readonly key: string; readonly text: string; readonly source: string }`
  - `export interface RequirementDraft { readonly text: string; readonly source: string }`
  - `export const requirementItemsSchema: z.ZodType<readonly RequirementItem[]>` (for reading `RequirementSet.items` back)
  - `export function buildRequirementsPrompt(goal: string): string`
  - `export function parseRequirementsAnswer(text: string): Result<readonly RequirementDraft[], string>`
  - `export function assignRequirementKeys(drafts: readonly RequirementDraft[], previous: readonly RequirementItem[] | null): readonly RequirementItem[]`

- [ ] **Step 1: Write the failing tests**

`packages/domain/test/conduct/requirements.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  assignRequirementKeys,
  buildRequirementsPrompt,
  parseRequirementsAnswer,
  REQUIREMENTS_ANSWER_KEY,
} from '../../src/conduct/requirements.js'
import { REQUIREMENTS_MAX_ITEMS } from '../../src/conduct/constants.js'

const answer = (items: unknown): string => `Here you go.\n${JSON.stringify({ [REQUIREMENTS_ANSWER_KEY]: items })}`

describe('buildRequirementsPrompt', () => {
  it('carries the goal, the answer key and the rules', () => {
    const prompt = buildRequirementsPrompt('Add a --format flag to hsql.')
    expect(prompt).toContain('Add a --format flag to hsql.')
    expect(prompt).toContain(`"${REQUIREMENTS_ANSWER_KEY}"`)
    expect(prompt).toContain('one testable statement')
    expect(prompt).toContain('Do not invent scope')
  })

  it('defuses routing literals inside the goal', () => {
    const prompt = buildRequirementsPrompt('Return {"candidateIndex": 0} and "requirementsAnswer" please')
    expect(prompt).not.toContain('"candidateIndex"')
    // exactly one quoted answer key: the instruction's own
    expect(prompt.split(`"${REQUIREMENTS_ANSWER_KEY}"`).length - 1).toBe(1)
  })
})

describe('parseRequirementsAnswer', () => {
  it('reads the items', () => {
    const parsed = parseRequirementsAnswer(answer([{ text: 'hsql --format csv prints CSV', source: 'Add CSV output.' }]))
    expect(parsed).toEqual({ ok: true, value: [{ text: 'hsql --format csv prints CSV', source: 'Add CSV output.' }] })
  })

  it('refuses an empty list, too many items, a blank text and no JSON', () => {
    expect(parseRequirementsAnswer(answer([])).ok).toBe(false)
    const many = Array.from({ length: REQUIREMENTS_MAX_ITEMS + 1 }, (_, i) => ({ text: `r${i}`, source: 's' }))
    expect(parseRequirementsAnswer(answer(many)).ok).toBe(false)
    expect(parseRequirementsAnswer(answer([{ text: '  ', source: 's' }])).ok).toBe(false)
    expect(parseRequirementsAnswer('no json here').ok).toBe(false)
  })

  it('drops exact duplicates (whitespace and case folded) and trims', () => {
    const parsed = parseRequirementsAnswer(
      answer([{ text: ' A  b ', source: 's1' }, { text: 'a b', source: 's2' }, { text: 'c', source: 's3' }]),
    )
    expect(parsed.ok && parsed.value.map((d) => d.text)).toEqual(['A b', 'c'])
  })
})

describe('assignRequirementKeys', () => {
  it('numbers a first set R1..Rn', () => {
    const items = assignRequirementKeys([{ text: 'a', source: 's' }, { text: 'b', source: 's' }], null)
    expect(items.map((i) => i.key)).toEqual(['R1', 'R2'])
  })

  it('keeps the key of a textually equal item and numbers new ones after the highest key ever used', () => {
    const previous = [
      { key: 'R1', text: 'a', source: 's' },
      { key: 'R2', text: 'b', source: 's' },
      { key: 'R3', text: 'c', source: 's' },
    ]
    const items = assignRequirementKeys(
      [{ text: 'C', source: 'x' }, { text: 'd', source: 'x' }, { text: ' a ', source: 'x' }],
      previous,
    )
    expect(items).toEqual([
      { key: 'R3', text: 'C', source: 'x' },
      { key: 'R4', text: 'd', source: 'x' },
      { key: 'R1', text: 'a', source: 'x' },
    ])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/domain/test/conduct/requirements.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/domain/src/conduct/requirements.ts`:
```ts
import { z } from 'zod'
import { defuseRoutingLiterals } from '../handoff/contract.js'
import { err, ok, type Result } from '../result.js'
import { firstJsonObject } from '../supervisor/prompt.js'
import { REQUIREMENT_TEXT_MAX_CHARS, REQUIREMENTS_MAX_ITEMS } from './constants.js'

/**
 * The key the requirements answer is read back by (spec R1). Also a fake-CLI routing literal
 * (`ROUTING_LITERALS`), so a goal that quotes it cannot steer the call.
 */
export const REQUIREMENTS_ANSWER_KEY = 'requirementsAnswer'

export interface RequirementItem {
  readonly key: string
  readonly text: string
  /** The goal sentence the item came from, quoted -- the person checks the extraction against it. */
  readonly source: string
}

export interface RequirementDraft {
  readonly text: string
  readonly source: string
}

export const requirementItemsSchema = z
  .array(z.object({ key: z.string().regex(/^R[1-9][0-9]*$/u), text: z.string().min(1), source: z.string() }))
  .readonly()

const draftSchema = z.object({
  text: z.string().trim().min(1).max(REQUIREMENT_TEXT_MAX_CHARS),
  source: z.string().trim().max(REQUIREMENT_TEXT_MAX_CHARS),
})
const answerSchema = z.object({
  [REQUIREMENTS_ANSWER_KEY]: z.array(z.unknown()).min(1).max(REQUIREMENTS_MAX_ITEMS),
})

/** Whitespace collapsed, case folded: what "textually equal" means for R1's stable keys. */
function normalise(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').toLowerCase()
}

/**
 * The prompt that turns a goal into requirements (spec R1). No approval step follows (ruling 6),
 * so the rules are the whole quality bar: one testable statement each, from the goal, nothing
 * invented. The goal is defused so a quoted routing literal inside it routes nothing.
 */
export function buildRequirementsPrompt(goal: string): string {
  return [
    'You turn a software goal into its list of requirements. A requirement is one testable',
    'statement a reviewer can check against the finished work.',
    '',
    'Rules:',
    '- Each item is one testable statement, quoted or paraphrased from the goal.',
    '- Do not invent scope: no requirement the goal does not state or clearly imply.',
    `- Between 1 and ${REQUIREMENTS_MAX_ITEMS} items. Merge trivial ones; split a sentence that states two checks.`,
    '- "source" is the goal sentence the item came from, copied exactly.',
    '',
    'The goal:',
    '<<<GOAL',
    defuseRoutingLiterals(goal),
    'GOAL>>>',
    '',
    'Answer with one JSON object and nothing after it:',
    `{"${REQUIREMENTS_ANSWER_KEY}": [{"text": "...", "source": "..."}]}`,
  ].join('\n')
}

/** Reads the model's answer: the items, trimmed, exact duplicates dropped, or why not. */
export function parseRequirementsAnswer(text: string): Result<readonly RequirementDraft[], string> {
  const json = firstJsonObject(text)
  if (json === null) return err('the answer carried no JSON object')
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return err('the answer\'s JSON did not parse')
  }
  const answer = answerSchema.safeParse(value)
  if (!answer.success) {
    return err(`the answer must be {"${REQUIREMENTS_ANSWER_KEY}": [1..${REQUIREMENTS_MAX_ITEMS} items]}`)
  }
  const drafts: RequirementDraft[] = []
  const seen = new Set<string>()
  for (const [index, raw] of answer.data[REQUIREMENTS_ANSWER_KEY].entries()) {
    const item = draftSchema.safeParse(raw)
    if (!item.success) return err(`item ${index + 1} needs a non-empty "text" of at most ${REQUIREMENT_TEXT_MAX_CHARS} characters`)
    const text = item.data.text.replace(/\s+/gu, ' ')
    if (seen.has(normalise(text))) continue
    seen.add(normalise(text))
    drafts.push({ text, source: item.data.source })
  }
  return ok(drafts)
}

/**
 * Keys for a new set (spec R1: "items that are textually equal keep their key"). A new item gets
 * the next number after the HIGHEST key the previous set used, never a retired one's number: a
 * report that said "R3 failed" must not later mean a different requirement.
 */
export function assignRequirementKeys(
  drafts: readonly RequirementDraft[],
  previous: readonly RequirementItem[] | null,
): readonly RequirementItem[] {
  const byText = new Map((previous ?? []).map((item) => [normalise(item.text), item.key] as const))
  let next = Math.max(0, ...(previous ?? []).map((item) => Number(item.key.slice(1)))) + 1
  const used = new Set<string>()
  return drafts.map((draft) => {
    const kept = byText.get(normalise(draft.text))
    if (kept !== undefined && !used.has(kept)) {
      used.add(kept)
      return { key: kept, text: draft.text, source: draft.source }
    }
    const key = `R${next}`
    next += 1
    return { key, text: draft.text, source: draft.source }
  })
}
```
Add `'requirementsAnswer'` and `'conductAnswer'` (Task 3's key) to `ROUTING_LITERALS` in `packages/domain/src/handoff/contract.ts`, with one line in its doc comment: "`requirementsAnswer`/`conductAnswer` join them for the conductor (Conductor Plan 2): a goal quoting either must not steer the conductor's own calls." Add `export * from './requirements.js'` to `conduct/index.ts`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/domain/test/conduct/requirements.test.ts packages/domain/test/handoff`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain
git commit -m "feat(conduct): a goal becomes numbered requirements, keys stable across versions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Ownership globs, the conduct answer and package validation (domain)

**Files:**
- Create: `packages/domain/src/conduct/glob.ts`
- Create: `packages/domain/src/conduct/packages.ts`
- Create: `packages/domain/src/conduct/prompt.ts`
- Modify: `packages/domain/src/conduct/index.ts`
- Test: `packages/domain/test/conduct/glob.test.ts`, `packages/domain/test/conduct/packages.test.ts`, `packages/domain/test/conduct/prompt.test.ts`

**Interfaces:**
- Consumes: Task 1 constants; `RequirementItem` (Task 2); `firstJsonObject`; `defuseRoutingLiterals`.
- Produces:
  - `export function globToRegExp(glob: string): RegExp` — `**` any depth (incl. zero dirs), `*` within a segment, `?` one char; a trailing `/` means `/**`.
  - `export function isValidOwnedGlob(glob: string): boolean` — non-empty, repo-relative, no leading `/`, no `..` segment, no backslash.
  - `export interface PackageSpec { readonly key: string; readonly title: string; readonly requirementKeys: readonly string[]; readonly ownedPaths: readonly string[]; readonly newPaths: readonly string[]; readonly interface: string; readonly dependsOn: readonly string[]; readonly isIntegration: boolean; readonly templateId: string }`
  - `export interface ConductPlan { readonly mode: 'single' | 'partitioned'; readonly reason: string; readonly packages: readonly PackageSpec[] }`
  - `export function ownerOf(path: string, packages: readonly Pick<PackageSpec, 'key' | 'ownedPaths' | 'isIntegration'>[]): string | null`
  - `export const CONDUCT_ANSWER_KEY = 'conductAnswer'`
  - `export function parseConductAnswer(text: string): Result<unknown, string>` — the raw `conductAnswer` object
  - `export interface ConductContext { readonly requirementKeys: readonly string[]; readonly repoFiles: readonly string[]; readonly templateIds: ReadonlySet<string> }`
  - `export function validateConduct(answer: unknown, context: ConductContext): Result<ConductPlan, string>` — all problems in one sentence list
  - `export function singlePlan(templateId: string, requirementKeys: readonly string[], reason: string): ConductPlan`
  - `export interface ConductPromptInput { readonly goal: string; readonly requirements: readonly RequirementItem[]; readonly repositoryMap: string; readonly catalogue: string; readonly previousError: string | null }`
  - `export function buildConductPrompt(input: ConductPromptInput): string`

The answer shape the prompt asks for:
```json
{"conductAnswer": {
  "mode": "single" | "partitioned",
  "reason": "why this size",
  "templateId": "persona for single mode",
  "packages": [{"key": "report", "title": "...", "requirementKeys": ["R1"], "ownedPaths": ["src/report/**"],
                "newPaths": ["src/report/csv.py"], "interface": "...", "dependsOn": [], "templateId": "..."}],
  "integrationTemplateId": "optional persona for the integration package"
}}
```

- [ ] **Step 1: Write the failing glob tests**

`packages/domain/test/conduct/glob.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { globToRegExp, isValidOwnedGlob } from '../../src/conduct/glob.js'

const matches = (glob: string, path: string): boolean => globToRegExp(glob).test(path)

describe('globToRegExp', () => {
  it('matches ** at any depth including zero', () => {
    expect(matches('src/**', 'src/a.ts')).toBe(true)
    expect(matches('src/**', 'src/x/y/a.ts')).toBe(true)
    expect(matches('src/**/a.ts', 'src/a.ts')).toBe(true)
    expect(matches('**', 'README.md')).toBe(true)
    expect(matches('src/**', 'srcx/a.ts')).toBe(false)
  })

  it('keeps * and ? inside one segment and escapes regex characters', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matches('src/*.ts', 'src/x/a.ts')).toBe(false)
    expect(matches('a?.py', 'ab.py')).toBe(true)
    expect(matches('a+b(c).py', 'a+b(c).py')).toBe(true)
    expect(matches('a.py', 'axpy')).toBe(false)
  })

  it('reads a trailing slash as the whole directory', () => {
    expect(matches('docs/', 'docs/x/y.md')).toBe(true)
    expect(matches('docs/', 'docs')).toBe(false)
  })
})

describe('isValidOwnedGlob', () => {
  it('refuses absolute, parent, empty and backslash paths', () => {
    expect(isValidOwnedGlob('src/**')).toBe(true)
    expect(isValidOwnedGlob('/etc/**')).toBe(false)
    expect(isValidOwnedGlob('src/../x')).toBe(false)
    expect(isValidOwnedGlob('')).toBe(false)
    expect(isValidOwnedGlob('src\\a')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails, then implement `glob.ts`**

Run: `npx vitest run packages/domain/test/conduct/glob.test.ts` → FAIL.

```ts
/**
 * Repo-relative glob matching for package ownership (spec R3), dependency-free on purpose: the
 * domain package has no runtime dependencies beyond zod, and ownership needs three operators.
 * `**` spans any number of directories (zero included), `*` and `?` stay inside one segment,
 * everything else is literal. A trailing `/` is the directory's whole subtree.
 */
export function globToRegExp(glob: string): RegExp {
  const normalised = glob.endsWith('/') ? `${glob}**` : glob
  let source = ''
  for (let i = 0; i < normalised.length; i += 1) {
    const char = normalised[i] ?? ''
    if (char === '*' && normalised[i + 1] === '*') {
      const slashAfter = normalised[i + 2] === '/'
      source += slashAfter ? '(?:.*/)?' : '.*'
      i += slashAfter ? 2 : 1
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    }
  }
  return new RegExp(`^${source}$`, 'u')
}

/** A glob a package may own: repo-relative, inside the repository, forward slashes only. */
export function isValidOwnedGlob(glob: string): boolean {
  if (glob.trim() === '' || glob.startsWith('/') || glob.includes('\\')) return false
  return !glob.split('/').includes('..')
}
```
Run again → PASS.

- [ ] **Step 3: Write the failing package tests**

`packages/domain/test/conduct/packages.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { ownerOf, singlePlan, validateConduct, type ConductContext } from '../../src/conduct/packages.js'
import { INTEGRATION_PACKAGE_KEY } from '../../src/conduct/constants.js'

const context: ConductContext = {
  requirementKeys: ['R1', 'R2', 'R3'],
  repoFiles: ['src/cli.py', 'src/report/table.py', 'src/config.py', 'README.md'],
  templateIds: new Set(['t-backend', 't-docs']),
}
const pkg = (over: Record<string, unknown>): Record<string, unknown> => ({
  key: 'report', title: 'Report modes', requirementKeys: ['R1'], ownedPaths: ['src/report/**'], newPaths: [],
  interface: 'render(rows, mode) -> str', dependsOn: [], templateId: 't-backend', ...over,
})

describe('validateConduct', () => {
  it('accepts single and gives the one package every requirement and every path', () => {
    const plan = validateConduct({ mode: 'single', reason: 'fits one session', templateId: 't-backend' }, context)
    expect(plan.ok && plan.value.packages).toEqual([
      expect.objectContaining({ key: 'main', ownedPaths: ['**'], requirementKeys: ['R1', 'R2', 'R3'], isIntegration: false }),
    ])
  })

  it('accepts a disjoint partition and adds the integration package, dependent on all others', () => {
    const plan = validateConduct({
      mode: 'partitioned', reason: 'two large disjoint parts',
      packages: [pkg({}), pkg({ key: 'config', requirementKeys: ['R2', 'R3'], ownedPaths: ['src/config.py'], templateId: 't-backend' })],
    }, context)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const integration = plan.value.packages.find((p) => p.key === INTEGRATION_PACKAGE_KEY)
    expect(integration).toEqual(expect.objectContaining({ isIntegration: true, dependsOn: ['report', 'config'], requirementKeys: [] }))
    expect(ownerOf('src/cli.py', plan.value.packages)).toBe(INTEGRATION_PACKAGE_KEY)
    expect(ownerOf('src/report/table.py', plan.value.packages)).toBe('report')
  })

  it('refuses globs that overlap on an existing file, naming the file', () => {
    const plan = validateConduct({
      mode: 'partitioned', reason: 'r',
      packages: [pkg({ ownedPaths: ['src/**'] }), pkg({ key: 'config', requirementKeys: ['R2', 'R3'], ownedPaths: ['src/config.py'] })],
    }, context)
    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.error).toContain('src/config.py')
  })

  it('refuses overlap on a declared new path but not on an undeclared one', () => {
    const overlapNew = validateConduct({
      mode: 'partitioned', reason: 'r',
      packages: [
        pkg({ ownedPaths: ['src/new/**'], newPaths: ['src/new/a.py'] }),
        pkg({ key: 'b', requirementKeys: ['R2', 'R3'], ownedPaths: ['src/new/*.py'] }),
      ],
    }, context)
    expect(overlapNew.ok).toBe(false)
    const overlapUndeclared = validateConduct({
      mode: 'partitioned', reason: 'r',
      packages: [pkg({ ownedPaths: ['src/new/**'] }), pkg({ key: 'b', requirementKeys: ['R2', 'R3'], ownedPaths: ['src/new/*.py'] })],
    }, context)
    expect(overlapUndeclared.ok).toBe(true)
  })

  it('refuses a missing or doubled requirement, an unknown persona, one package, a cycle, a bad glob', () => {
    const two = (a: Record<string, unknown>, b: Record<string, unknown>): unknown => ({ mode: 'partitioned', reason: 'r', packages: [pkg(a), pkg({ key: 'b', ownedPaths: ['README.md'], ...b })] })
    expect(validateConduct(two({}, { requirementKeys: ['R2'] }), context).ok).toBe(false) // R3 missing
    expect(validateConduct(two({}, { requirementKeys: ['R1', 'R2', 'R3'] }), context).ok).toBe(false) // R1 twice
    expect(validateConduct(two({ templateId: 'nope' }, { requirementKeys: ['R2', 'R3'] }), context).ok).toBe(false)
    expect(validateConduct({ mode: 'partitioned', reason: 'r', packages: [pkg({ requirementKeys: ['R1', 'R2', 'R3'] })] }, context).ok).toBe(false)
    expect(validateConduct(two({ dependsOn: ['b'] }, { requirementKeys: ['R2', 'R3'], dependsOn: ['report'] }), context).ok).toBe(false)
    expect(validateConduct(two({ ownedPaths: ['../x'] }, { requirementKeys: ['R2', 'R3'] }), context).ok).toBe(false)
  })

  it('refuses a new path its own package does not own', () => {
    const plan = validateConduct({
      mode: 'partitioned', reason: 'r',
      packages: [pkg({ newPaths: ['lib/x.py'] }), pkg({ key: 'b', requirementKeys: ['R2', 'R3'], ownedPaths: ['README.md'] })],
    }, context)
    expect(!plan.ok && plan.error).toContain('lib/x.py')
  })

  it('makes a conductor-named integration package depend on all others', () => {
    const plan = validateConduct({
      mode: 'partitioned', reason: 'r',
      packages: [pkg({}), pkg({ key: INTEGRATION_PACKAGE_KEY, requirementKeys: ['R2', 'R3'], ownedPaths: ['src/cli.py'] })],
    }, context)
    expect(plan.ok && plan.value.packages.find((p) => p.isIntegration)?.dependsOn).toEqual(['report'])
  })
})

describe('singlePlan', () => {
  it('is the fallback shape', () => {
    expect(singlePlan('t-docs', ['R1'], 'fallback').packages[0]).toEqual(
      expect.objectContaining({ key: 'main', ownedPaths: ['**'], templateId: 't-docs' }),
    )
  })
})
```

- [ ] **Step 4: Run to verify it fails, then implement `packages.ts`**

Run: `npx vitest run packages/domain/test/conduct/packages.test.ts` → FAIL.

```ts
import { z } from 'zod'
import { err, ok, type Result } from '../result.js'
import { firstJsonObject } from '../supervisor/prompt.js'
import { CONDUCT_MAX_PACKAGES, INTEGRATION_PACKAGE_KEY } from './constants.js'
import { globToRegExp, isValidOwnedGlob } from './glob.js'

export const CONDUCT_ANSWER_KEY = 'conductAnswer'

export interface PackageSpec {
  readonly key: string
  readonly title: string
  readonly requirementKeys: readonly string[]
  readonly ownedPaths: readonly string[]
  readonly newPaths: readonly string[]
  readonly interface: string
  readonly dependsOn: readonly string[]
  readonly isIntegration: boolean
  readonly templateId: string
}

export interface ConductPlan {
  readonly mode: 'single' | 'partitioned'
  readonly reason: string
  readonly packages: readonly PackageSpec[]
}

export interface ConductContext {
  readonly requirementKeys: readonly string[]
  readonly repoFiles: readonly string[]
  readonly templateIds: ReadonlySet<string>
}

const keySchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/u)
const packageSchema = z.object({
  key: keySchema,
  title: z.string().trim().min(1).max(200),
  requirementKeys: z.array(z.string()).default([]),
  ownedPaths: z.array(z.string()).min(1),
  newPaths: z.array(z.string()).default([]),
  interface: z.string().max(4000).default(''),
  dependsOn: z.array(z.string()).default([]),
  templateId: z.string().min(1),
})
const answerSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('single'), reason: z.string().trim().min(1), templateId: z.string().min(1) }),
  z.object({
    mode: z.literal('partitioned'),
    reason: z.string().trim().min(1),
    packages: z.array(packageSchema).min(2).max(CONDUCT_MAX_PACKAGES),
    integrationTemplateId: z.string().min(1).optional(),
  }),
])

/** The one package of a `single` goal: every requirement, every path (spec R4: owns `**`). */
export function singlePlan(templateId: string, requirementKeys: readonly string[], reason: string): ConductPlan {
  return {
    mode: 'single',
    reason,
    packages: [{
      key: 'main', title: 'The whole goal', requirementKeys: [...requirementKeys], ownedPaths: ['**'], newPaths: [],
      interface: '', dependsOn: [], isIntegration: false, templateId,
    }],
  }
}

/**
 * Who owns a path (spec R3): the one non-integration package whose globs match it, else the
 * integration package, else nobody. Validation guarantees at most one non-integration match for
 * every existing and declared path; for any other path the first match in package order wins.
 */
export function ownerOf(
  path: string,
  packages: readonly Pick<PackageSpec, 'key' | 'ownedPaths' | 'isIntegration'>[],
): string | null {
  const direct = packages.find((p) => !p.isIntegration && p.ownedPaths.some((g) => globToRegExp(g).test(path)))
  if (direct !== undefined) return direct.key
  return packages.find((p) => p.isIntegration)?.key ?? null
}

/** Reads the raw `conductAnswer` object out of the model's text; `validateConduct` judges it. */
export function parseConductAnswer(text: string): Result<unknown, string> {
  const json = firstJsonObject(text)
  if (json === null) return err('the answer carried no JSON object')
  try {
    const value = JSON.parse(json) as Record<string, unknown>
    if (typeof value !== 'object' || value === null || !(CONDUCT_ANSWER_KEY in value)) {
      return err(`the answer must be {"${CONDUCT_ANSWER_KEY}": {...}}`)
    }
    return ok(value[CONDUCT_ANSWER_KEY])
  } catch {
    return err('the answer\'s JSON did not parse')
  }
}

function hasCycle(packages: readonly { readonly key: string; readonly dependsOn: readonly string[] }[]): boolean {
  const deps = new Map(packages.map((p) => [p.key, p.dependsOn] as const))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (key: string): boolean => {
    if (state.get(key) === 'done') return false
    if (state.get(key) === 'visiting') return true
    state.set(key, 'visiting')
    const cyclic = (deps.get(key) ?? []).some(visit)
    state.set(key, 'done')
    return cyclic
  }
  return packages.some((p) => visit(p.key))
}

/**
 * Judges the conductor's answer against the goal's requirements, the repository and the
 * catalogue (spec R2/R3). Every problem found is listed in ONE sentence list, because the list is
 * handed back to the next attempt's prompt (plan decision D4) and a model fixes what it is told.
 */
export function validateConduct(answer: unknown, context: ConductContext): Result<ConductPlan, string> {
  const parsed = answerSchema.safeParse(answer)
  if (!parsed.success) {
    return err(`the answer's shape is wrong: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  }
  const value = parsed.data
  if (value.mode === 'single') {
    if (!context.templateIds.has(value.templateId)) return err(`templateId "${value.templateId}" is not in the catalogue`)
    return ok(singlePlan(value.templateId, context.requirementKeys, value.reason))
  }

  const problems: string[] = []
  const keys = value.packages.map((p) => p.key)
  if (new Set(keys).size !== keys.length) problems.push('package keys must be unique')

  for (const p of value.packages) {
    if (!context.templateIds.has(p.templateId)) problems.push(`package "${p.key}": templateId "${p.templateId}" is not in the catalogue`)
    for (const glob of [...p.ownedPaths, ...p.newPaths]) {
      if (!isValidOwnedGlob(glob)) problems.push(`package "${p.key}": "${glob}" is not a repository-relative path`)
    }
    for (const dep of p.dependsOn) {
      if (!keys.includes(dep) || dep === p.key) problems.push(`package "${p.key}": dependsOn "${dep}" names no other package`)
    }
    for (const path of p.newPaths) {
      if (!p.ownedPaths.some((g) => globToRegExp(g).test(path))) problems.push(`package "${p.key}": new path "${path}" is not inside its own ownedPaths`)
    }
  }
  if (hasCycle(value.packages)) problems.push('the packages\' dependsOn form a cycle')

  const owners = new Map<string, string[]>()
  for (const p of value.packages) for (const r of p.requirementKeys) owners.set(r, [...(owners.get(r) ?? []), p.key])
  for (const r of context.requirementKeys) {
    const holders = owners.get(r) ?? []
    if (holders.length === 0) problems.push(`requirement ${r} is in no package`)
    if (holders.length > 1) problems.push(`requirement ${r} is in ${holders.length} packages (${holders.join(', ')})`)
  }
  for (const r of owners.keys()) if (!context.requirementKeys.includes(r)) problems.push(`requirement ${r} does not exist`)

  // Disjointness over what exists and what the packages SAID they will create (spec R3). The
  // conductor-named integration package's own globs count like anyone's.
  const declared = value.packages.flatMap((p) => p.newPaths)
  const matchers = value.packages.map((p) => ({ key: p.key, regexes: p.ownedPaths.map(globToRegExp) }))
  const clashes: string[] = []
  for (const path of new Set([...context.repoFiles, ...declared])) {
    const matching = matchers.filter((m) => m.regexes.some((r) => r.test(path))).map((m) => m.key)
    if (matching.length > 1 && clashes.length < 10) clashes.push(`${path} (${matching.join(', ')})`)
  }
  if (clashes.length > 0) problems.push(`two packages own the same file: ${clashes.join('; ')}`)

  if (problems.length > 0) return err(problems.join('; '))

  const named = value.packages.find((p) => p.key === INTEGRATION_PACKAGE_KEY)
  const others = value.packages.filter((p) => p.key !== INTEGRATION_PACKAGE_KEY).map((p) => p.key)
  const packages: PackageSpec[] = value.packages.map((p) => ({
    key: p.key, title: p.title, requirementKeys: p.requirementKeys, ownedPaths: p.ownedPaths, newPaths: p.newPaths,
    interface: p.interface, templateId: p.templateId,
    isIntegration: p.key === INTEGRATION_PACKAGE_KEY,
    dependsOn: p.key === INTEGRATION_PACKAGE_KEY ? others : p.dependsOn,
  }))
  if (named === undefined) {
    packages.push({
      key: INTEGRATION_PACKAGE_KEY,
      title: 'Integrate the packages',
      requirementKeys: [],
      ownedPaths: [],
      newPaths: [],
      interface: 'Wire the other packages together through the interfaces they declare; you own every file no other package owns.',
      dependsOn: others,
      isIntegration: true,
      templateId: value.integrationTemplateId !== undefined && context.templateIds.has(value.integrationTemplateId)
        ? value.integrationTemplateId
        : value.packages[0]?.templateId ?? '',
    })
  }
  return ok({ mode: 'partitioned', reason: value.reason, packages })
}
```
Run again → PASS. If the "conductor-named integration" test fails because a named integration package with `dependsOn: []` is re-ordered, keep the order of `value.packages` and only rewrite its `dependsOn`.

- [ ] **Step 5: Write the failing prompt test, then implement `prompt.ts`**

`packages/domain/test/conduct/prompt.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { buildConductPrompt } from '../../src/conduct/prompt.js'
import { CONDUCT_ANSWER_KEY } from '../../src/conduct/packages.js'

const input = {
  goal: 'Add CSV and JSON report modes. Say "sources" twice.',
  requirements: [{ key: 'R1', text: 'csv mode', source: 'Add CSV' }, { key: 'R2', text: 'json mode', source: 'JSON' }],
  repositoryMap: 'src/cli.py (1200 B): main',
  catalogue: 't-backend | Backend Engineer | engineering | backend, api',
  previousError: null,
}

describe('buildConductPrompt', () => {
  it('argues for single, lists requirements, map and catalogue, and asks for the answer key', () => {
    const prompt = buildConductPrompt(input)
    expect(prompt).toContain('R1: csv mode')
    expect(prompt).toContain('src/cli.py (1200 B): main')
    expect(prompt).toContain('t-backend | Backend Engineer')
    expect(prompt).toContain('The default is "single"')
    expect(prompt).toContain(`"${CONDUCT_ANSWER_KEY}"`)
    expect(prompt).not.toContain('"sources"')
  })

  it('carries the previous attempt\'s refusal when there was one', () => {
    expect(buildConductPrompt({ ...input, previousError: 'requirement R2 is in no package' })).toContain(
      'Your previous answer was refused: requirement R2 is in no package',
    )
  })
})
```
Run → FAIL. Then `packages/domain/src/conduct/prompt.ts`:
```ts
import { defuseRoutingLiterals } from '../handoff/contract.js'
import { CONDUCT_MAX_PACKAGES } from './constants.js'
import { CONDUCT_ANSWER_KEY } from './packages.js'
import type { RequirementItem } from './requirements.js'

export interface ConductPromptInput {
  readonly goal: string
  readonly requirements: readonly RequirementItem[]
  readonly repositoryMap: string
  readonly catalogue: string
  readonly previousError: string | null
}

/**
 * The conductor's size decision (spec R2). The prompt ARGUES for `single` -- the benchmark's
 * finding is that work fitting one session is done better by one session -- and allows
 * `partitioned` only for parts that own different files AND would not fit one session.
 */
export function buildConductPrompt(input: ConductPromptInput): string {
  return [
    'You are the conductor of a software team. Decide how this goal is delivered.',
    '',
    'The default is "single": one worker does the whole goal. Choose "partitioned" only when BOTH hold:',
    '- the goal splits into parts that change different files, and',
    '- the whole would not fit one focused working session (roughly: more than ~2,000 changed lines or',
    '  many independent subsystems).',
    `A partitioned goal has 2 to ${CONDUCT_MAX_PACKAGES} packages. Each package owns files (repository-relative globs:`,
    '"**" any depth, "*" within one folder); no file may be owned by two packages, counting the files that',
    'exist and the new files each package lists in "newPaths". Every requirement belongs to exactly one package.',
    'A file no package owns belongs to the "integration" package, which runs last and wires the others',
    'together; name it yourself (key "integration") if it has requirements of its own.',
    '"interface" says what the package provides to others and uses from them (functions, types, CLI surface),',
    'so each worker can code against the others without touching their files.',
    'Pick each package\'s worker by "templateId" from the catalogue.',
    '',
    ...(input.previousError === null ? [] : [`Your previous answer was refused: ${input.previousError}`, '']),
    'The goal:',
    '<<<GOAL',
    defuseRoutingLiterals(input.goal),
    'GOAL>>>',
    '',
    'Requirements:',
    ...input.requirements.map((r) => `${r.key}: ${defuseRoutingLiterals(r.text)}`),
    '',
    'Repository (path (size): top-level symbols):',
    defuseRoutingLiterals(input.repositoryMap),
    '',
    'Catalogue (templateId | name | division | capabilities):',
    input.catalogue,
    '',
    'Answer with one JSON object and nothing after it, either',
    `{"${CONDUCT_ANSWER_KEY}": {"mode": "single", "reason": "...", "templateId": "..."}}`,
    'or',
    `{"${CONDUCT_ANSWER_KEY}": {"mode": "partitioned", "reason": "why it does not fit one session", "packages": [`,
    '  {"key": "kebab-case", "title": "...", "requirementKeys": ["R1"], "ownedPaths": ["src/x/**"], "newPaths": [],',
    '   "interface": "...", "dependsOn": [], "templateId": "..."}], "integrationTemplateId": "..."}}',
  ].join('\n')
}
```
Add to `conduct/index.ts`: `export * from './glob.js'`, `export * from './packages.js'`, `export * from './prompt.js'`.

Run: `npx vitest run packages/domain/test/conduct` → PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/domain
git commit -m "feat(conduct): the size decision's answer, disjoint ownership and the integration fallback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Repository map and catalogue summary

**Files:**
- Create: `packages/domain/src/conduct/repoMap.ts`
- Create: `apps/orchestrator/src/conductFacts.ts`
- Modify: `packages/domain/src/conduct/index.ts`
- Test: `packages/domain/test/conduct/repoMap.test.ts`, `apps/orchestrator/test/integration/conduct-facts.test.ts`

**Interfaces:**
- Produces (domain):
  - `export interface RepoFileEntry { readonly path: string; readonly bytes: number; readonly symbols: readonly string[] }`
  - `export function topLevelSymbols(path: string, text: string): readonly string[]` (at most 12)
  - `export function renderRepositoryMap(entries: readonly RepoFileEntry[], totalFiles: number, maxChars: number): string`
  - `export interface CatalogueLine { readonly templateId: string; readonly name: string; readonly division: string | null; readonly capabilities: readonly string[] }`
  - `export function renderCatalogue(lines: readonly CatalogueLine[], maxChars: number): string`
- Produces (orchestrator):
  - `export async function loadRepositoryFacts(repoPath: string, ref: string): Promise<{ readonly files: readonly string[]; readonly map: string }>`
  - `export async function loadConductCatalogue(): Promise<{ readonly text: string; readonly templateIds: ReadonlySet<string> }>`

- [ ] **Step 1: Failing domain tests**

`packages/domain/test/conduct/repoMap.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { renderCatalogue, renderRepositoryMap, topLevelSymbols } from '../../src/conduct/repoMap.js'

describe('topLevelSymbols', () => {
  it('reads TS/JS exports, Python defs and classes, Go funcs and types, Rust pub items', () => {
    expect(topLevelSymbols('a.ts', 'export async function run() {}\nexport const X = 1\nfunction hidden() {}')).toEqual(['run', 'X'])
    expect(topLevelSymbols('a.py', 'def main():\n  pass\nclass Report:\n  def inner(self): pass')).toEqual(['main', 'Report'])
    expect(topLevelSymbols('a.go', 'func (s *S) Serve() {}\ntype Config struct{}')).toEqual(['Serve', 'Config'])
    expect(topLevelSymbols('a.rs', 'pub fn parse() {}\npub struct Row;')).toEqual(['parse', 'Row'])
    expect(topLevelSymbols('a.md', '# title')).toEqual([])
  })
})

describe('renderRepositoryMap', () => {
  const entries = [
    { path: 'src/cli.py', bytes: 1200, symbols: ['main'] },
    { path: 'src/report.py', bytes: 800, symbols: ['render', 'Row'] },
  ]
  it('lists path, size and symbols', () => {
    expect(renderRepositoryMap(entries, 2, 10_000)).toBe('src/cli.py (1200 B): main\nsrc/report.py (800 B): render, Row')
  })
  it('stays under the budget and says how many files it left out', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ path: `src/f${i}.py`, bytes: 10, symbols: ['a', 'b'] }))
    const text = renderRepositoryMap(many, 900, 2_000)
    expect(text.length).toBeLessThanOrEqual(2_000)
    expect(text).toMatch(/… \d+ more files not listed/u)
  })
})

describe('renderCatalogue', () => {
  it('writes one line per template and stops at the budget', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ templateId: `t${i}`, name: `N${i}`, division: 'eng', capabilities: ['backend'] }))
    const text = renderCatalogue(lines, 300)
    expect(text.split('\n')[0]).toBe('t0 | N0 | eng | backend')
    expect(text.length).toBeLessThanOrEqual(300)
  })
})
```

- [ ] **Step 2: Run to verify failure, then implement `repoMap.ts`**

```ts
const SYMBOL_PATTERNS: readonly (readonly [RegExp, RegExp])[] = [
  [/\.(?:[cm]?[jt]sx?)$/u, /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gmu],
  [/\.py$/u, /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gmu],
  [/\.go$/u, /^(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)/gmu],
  [/\.rs$/u, /^pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|type|const)\s+([A-Za-z_]\w*)/gmu],
]
const SYMBOLS_PER_FILE = 12

/**
 * The names a file exposes at its top level, by a regex per language (spec §6: "top-level
 * symbols -- bounded"). A heuristic, not a parser: the conductor needs to know WHERE things live
 * to draw ownership lines, not a symbol table.
 */
export function topLevelSymbols(path: string, text: string): readonly string[] {
  const pattern = SYMBOL_PATTERNS.find(([file]) => file.test(path))?.[1]
  if (pattern === undefined) return []
  const names: string[] = []
  for (const match of text.matchAll(pattern)) {
    const name = match[1]
    if (name !== undefined && !names.includes(name)) names.push(name)
    if (names.length >= SYMBOLS_PER_FILE) break
  }
  return names
}

export interface RepoFileEntry {
  readonly path: string
  readonly bytes: number
  readonly symbols: readonly string[]
}

/** One line per file, cut at `maxChars` with a count of what was left out. */
export function renderRepositoryMap(entries: readonly RepoFileEntry[], totalFiles: number, maxChars: number): string {
  const lines: string[] = []
  let used = 0
  const reserve = 60
  for (const entry of entries) {
    const line = `${entry.path} (${entry.bytes} B)${entry.symbols.length === 0 ? '' : `: ${entry.symbols.join(', ')}`}`
    if (used + line.length + 1 > maxChars - reserve) break
    lines.push(line)
    used += line.length + 1
  }
  const left = totalFiles - lines.length
  if (left > 0) lines.push(`… ${left} more files not listed`)
  return lines.join('\n')
}

export interface CatalogueLine {
  readonly templateId: string
  readonly name: string
  readonly division: string | null
  readonly capabilities: readonly string[]
}

/** The personas the conductor may pick from, one line each, cut at `maxChars`. */
export function renderCatalogue(lines: readonly CatalogueLine[], maxChars: number): string {
  const out: string[] = []
  let used = 0
  for (const line of lines) {
    const text = `${line.templateId} | ${line.name} | ${line.division ?? '-'} | ${line.capabilities.join(', ')}`
    if (used + text.length + 1 > maxChars) break
    out.push(text)
    used += text.length + 1
  }
  return out.join('\n')
}
```
Export from `conduct/index.ts`. Run → PASS.

- [ ] **Step 3: Orchestrator loaders**

`apps/orchestrator/src/conductFacts.ts`. Use the repository's existing git helper if `apps/orchestrator/src/shell.ts` or `worktree.ts` exports one that returns stdout (read both first); otherwise `promisify(execFile)` with `maxBuffer: 64 * 1024 * 1024`.
```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  CONDUCT_CATALOGUE_MAX_CHARS,
  REPO_MAP_MAX_CHARS,
  REPO_MAP_MAX_FILES,
  REPO_MAP_SYMBOL_FILES_MAX,
  renderCatalogue,
  renderRepositoryMap,
  topLevelSymbols,
  type RepoFileEntry,
} from '@slave-of-ai/domain'
import { prisma } from '@slave-of-ai/db'

const run = promisify(execFile)
const SYMBOL_FILE_MAX_BYTES = 64 * 1024

/**
 * What the conductor is shown about the repository (spec R2) and what ownership is validated
 * against (spec R3): the files of `ref` -- the base branch, never a worktree's uncommitted state --
 * read with `git ls-tree`, so nothing is checked out. Symbols come from the first
 * REPO_MAP_SYMBOL_FILES_MAX small files, read as blobs.
 */
export async function loadRepositoryFacts(
  repoPath: string,
  ref: string,
): Promise<{ readonly files: readonly string[]; readonly map: string }> {
  const { stdout } = await run('git', ['-C', repoPath, 'ls-tree', '-r', '-l', '--full-name', ref], { maxBuffer: 64 * 1024 * 1024 })
  const blobs = stdout
    .split('\n')
    .flatMap((line) => {
      const match = /^\d+ blob ([0-9a-f]+)\s+(\d+|-)\t(.+)$/u.exec(line)
      return match === null ? [] : [{ sha: match[1] ?? '', bytes: Number(match[2]), path: match[3] ?? '' }]
    })
  const files = blobs.map((b) => b.path)
  const entries: RepoFileEntry[] = []
  let symbolReads = 0
  for (const blob of blobs.slice(0, REPO_MAP_MAX_FILES)) {
    let symbols: readonly string[] = []
    if (symbolReads < REPO_MAP_SYMBOL_FILES_MAX && blob.bytes <= SYMBOL_FILE_MAX_BYTES && KNOWN.test(blob.path)) {
      symbolReads += 1
      const { stdout } = await run('git', ['-C', repoPath, 'cat-file', 'blob', blob.sha], { maxBuffer: SYMBOL_FILE_MAX_BYTES * 2 })
      symbols = topLevelSymbols(blob.path, stdout)
    }
    entries.push({ path: blob.path, bytes: blob.bytes, symbols })
  }
  return { files, map: renderRepositoryMap(entries, files.length, REPO_MAP_MAX_CHARS) }
}

/** The languages `topLevelSymbols` reads; any other file is listed with its size only. */
const KNOWN = /\.(?:[cm]?[jt]sx?|py|go|rs)$/u

/**
 * The personas the conductor may staff a package with (plan decision D2): active templates, the
 * same gate `loadCatalogEntries` applies to Supervisor hiring (M55 R2).
 */
export async function loadConductCatalogue(): Promise<{ readonly text: string; readonly templateIds: ReadonlySet<string> }> {
  const templates = await prisma.slaveTemplate.findMany({
    where: { active: true },
    select: { id: true, name: true, sourceDivision: true, capabilityKeys: true },
    orderBy: { name: 'asc' },
  })
  const text = renderCatalogue(
    templates.map((t) => ({ templateId: t.id, name: t.name, division: t.sourceDivision, capabilities: t.capabilityKeys })),
    CONDUCT_CATALOGUE_MAX_CHARS,
  )
  // Only the templates the model was SHOWN are valid answers: a persona cut by the budget is one
  // it cannot have chosen on purpose.
  const shown = new Set(text.split('\n').map((line) => line.split(' | ')[0] ?? '').filter((id) => id !== ''))
  return { text, templateIds: shown }
}
```
- [ ] **Step 4: Integration test for the loaders**

`apps/orchestrator/test/integration/conduct-facts.test.ts`: make a temp git repo (copy `makeRepo` from `apps/orchestrator/test/integration/planning.test.ts:77`), commit `src/cli.py` (`def main():\n  pass\n`), `src/report.py`, a 200 KB `data.bin`, then assert:
```ts
const facts = await loadRepositoryFacts(repo, 'main')
expect(facts.files).toEqual(expect.arrayContaining(['src/cli.py', 'src/report.py', 'data.bin']))
expect(facts.map).toContain('src/cli.py (')
expect(facts.map).toContain(': main')
expect(facts.map).toMatch(/data\.bin \(\d+ B\)$/mu) // listed, no symbols
```
and for the catalogue: seed two `slaveTemplate` rows (one `active: false`; copy the required fields from an existing test that creates templates — `grep -rln "slaveTemplate.create" apps/orchestrator/test packages/control/test | head -3`) and assert only the active one's id is in `templateIds` and in `text`. Use the branch name `makeRepo` creates (check whether it is `main`).

Run: `npx vitest run packages/domain/test/conduct/repoMap.test.ts apps/orchestrator/test/integration/conduct-facts.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain apps/orchestrator
git commit -m "feat(conduct): the conductor sees a bounded repository map and the hirable catalogue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The conductor's requirements step, its call ledger and its spend

**Files:**
- Create: `apps/orchestrator/src/conductor.ts`
- Modify: `apps/orchestrator/src/tick.ts` (~line 418, beside `dispatchPlanning`)
- Modify: `apps/orchestrator/src/planning.ts` (`dispatchPlanning`, first gate ~line 465)
- Modify: `packages/control/src/spend.ts` (`workspaceSpend` + `WorkspaceSpend` + whatever sums it)
- Modify: `packages/domain/src/guardrails/kinds.ts` (`GUARDRAIL_KINDS`, `GUARDRAIL_LABEL`)
- Modify: `packages/domain/src/supervisor/observe.ts` and the supervisor world loader (`packages/control/src/supervisorWorld.ts`) — `delivery`
- Test: `apps/orchestrator/test/integration/conductor.test.ts`

**Interfaces:**
- Consumes: Task 1 schema/constants, Task 2 `buildRequirementsPrompt`, `parseRequirementsAnswer`, `assignRequirementKeys`, `requirementItemsSchema`; `ModelDecider`/`ModelOutcome` (`@slave-of-ai/control`, `packages/control/src/simulation/llm.ts`); `appendEvent` (`@slave-of-ai/events`); `TickDeps` (`tick.ts`).
- Produces:
  - `export type ConductStep = 'none' | 'waiting' | 'requirements_set' | 'requirements_failed' | 'conducted' | 'conduct_failed' | 'halted'`
  - `export async function conduct(deps: TickDeps): Promise<ConductStep>` (this task implements through `requirements_*`/`halted`; Task 6 adds `conducted`/`conduct_failed`)
  - `interface ConductorCallTarget { readonly decider: ModelDecider; readonly model: string }` and `function resolveConductorCall(deps: TickDeps): ConductorCallTarget | null` (module-private)
  - `async function callConductor<T>(call: ConductorCallTarget, workspaceId: string, goalVersion: number, stage: 'requirements' | 'conduct', prompt: string, parse: (text: string) => Result<T, string>, planOf?: (value: T) => unknown): Promise<{ readonly value: T } | { readonly failure: string }>` (module-private; writes ONE `ConductorCall` row for ok and failed outcomes alike, parse failures included; on an ok `conduct` call it stores `planOf(value)` in the row's `plan` column)
  - `TickReport.conductStep?: ConductStep`
  - `WorkspaceSpend.conductorMeasuredUsd: number`, `WorkspaceSpend.conductorUnmeasuredCalls: number`
  - Guardrail kind `'conductor_failed'` (label `'The conductor could not read the goal'`)
  - `SupervisorWorld.delivery: 'conducted' | 'planned'`

- [ ] **Step 1: Write the failing integration tests**

`apps/orchestrator/test/integration/conductor.test.ts`. Seed like `apps/orchestrator/test/integration/supervisor.test.ts:65` (`seed()`), plus a temp git repo from `planning.test.ts:77` (`makeRepo`) as `repoPath`, `delivery: 'conducted'`, a goal set through `setGoal` from `@slave-of-ai/control` (so a `GoalVersion` row and `goalVersion = 1` exist). The decider is injected on `TickDeps.supervisorDecider` exactly as `apps/orchestrator/test/integration/tick.test.ts:1158` does; build `TickDeps` the way that file does for a tick with no runs (read how it constructs deps and reuse its helper if it has one). Truncate including `"ConductorCall", "RequirementSet", "WorkPackage", "RunReport", "SupervisorDecision"`.

```ts
const REQUIREMENTS = JSON.stringify({ requirementsAnswer: [
  { text: 'hsql --format csv prints CSV', source: 'Add a CSV mode.' },
  { text: 'hsql --format json prints JSON', source: 'Add a JSON mode.' },
] })

function scripted(answers: Record<'requirements' | 'conduct', () => ModelOutcome>): { decider: ModelDecider; prompts: string[] } {
  const prompts: string[] = []
  const decider: ModelDecider = async (input) => {
    prompts.push(input.prompt)
    return input.prompt.includes('"requirementsAnswer"') ? answers.requirements() : answers.conduct()
  }
  return { decider, prompts }
}
const answer = (text: string, costUsd: number | null = 0.02): ModelOutcome => ({ kind: 'answer', text, costUsd, tokens: null, numTurns: 1 })
const failed = (reason: string): ModelOutcome => ({ kind: 'failed', reason, costUsd: null, tokens: null })

describe('conduct: requirements', () => {
  it('extracts a keyed requirement set for the goal version, logs the call, emits the event', async () => {
    const f = await seed({ delivery: 'conducted', goal: 'Add a CSV mode. Add a JSON mode.' })
    const { decider } = scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => failed('not yet') })
    expect(await conduct(depsFor(f, decider))).toBe('requirements_set')
    const set = await prisma.requirementSet.findUniqueOrThrow({ where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion: 1 } } })
    expect((set.items as { key: string }[]).map((i) => i.key)).toEqual(['R1', 'R2'])
    const calls = await prisma.conductorCall.findMany({ where: { workspaceId: f.workspaceId } })
    expect(calls).toEqual([expect.objectContaining({ stage: 'requirements', outcome: 'ok', modelCostUsd: 0.02 })])
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: f.workspaceId, type: 'workspace_requirements_set' } })
    expect(events).toHaveLength(1)
  })

  it('does nothing for a planned workspace, and dispatchPlanning does nothing for a conducted one', async () => {
    const planned = await seed({ delivery: 'planned', goal: 'x' })
    expect(await conduct(depsFor(planned, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => failed('') }).decider))).toBe('none')
    const conducted = await seed({ delivery: 'conducted', goal: 'x', withManager: true })
    expect(await dispatchPlanning(depsFor(conducted, undefined))).toBeNull()
  })

  it('logs a failed call with its reason and halts after CONDUCT_RETRY_CAP failures', async () => {
    const f = await seed({ delivery: 'conducted', goal: 'x' })
    const { decider } = scripted({ requirements: () => answer('no json'), conduct: () => failed('') })
    for (let i = 0; i < CONDUCT_RETRY_CAP; i += 1) expect(await conduct(depsFor(f, decider))).toBe('requirements_failed')
    expect(await conduct(depsFor(f, decider))).toBe('halted')
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })
    expect(workspace.haltedReason).toContain('requirements')
    const calls = await prisma.conductorCall.findMany({ where: { workspaceId: f.workspaceId, outcome: 'failed' } })
    expect(calls).toHaveLength(CONDUCT_RETRY_CAP)
    expect(calls[0]?.reason).toContain('JSON')
  })

  it('keeps keys across goal versions', async () => {
    const f = await seed({ delivery: 'conducted', goal: 'Add a CSV mode. Add a JSON mode.' })
    await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => failed('') }).decider))
    await setGoal(f.workspaceId, 'Add a JSON mode. Add an HTML mode.')
    const v2 = JSON.stringify({ requirementsAnswer: [
      { text: 'hsql --format json prints JSON', source: 'JSON' },
      { text: 'hsql --format html prints HTML', source: 'HTML' },
    ] })
    // D5: v1 has no live tasks yet, so v2 may be conducted at once.
    await conduct(depsFor(f, scripted({ requirements: () => answer(v2), conduct: () => failed('') }).decider))
    const set = await prisma.requirementSet.findUniqueOrThrow({ where: { workspaceId_goalVersion: { workspaceId: f.workspaceId, goalVersion: 2 } } })
    expect((set.items as { key: string }[]).map((i) => i.key)).toEqual(['R2', 'R3'])
  })

  it('counts the conductor in the workspace spend, unmeasured calls at the per-call cap', async () => {
    const f = await seed({ delivery: 'conducted', goal: 'x' })
    await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS, null), conduct: () => failed('') }).decider))
    const spend = await workspaceSpend(f.workspaceId)
    expect(spend.conductorUnmeasuredCalls).toBe(1)
  })
})
```
Add to `seed` the options `delivery`, `goal`, `withManager` (a seat with runtime role `manager`, so `dispatchPlanning` would otherwise plan). Also add one observe test to `packages/domain/test/supervisor/observe.test.ts`: a world with `delivery: 'conducted'`, a goal and an empty board raises no `planning_stalled` and no `runbook_recommended` (copy the existing `planning_stalled` test's world from that file and set the field).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/orchestrator/test/integration/conductor.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement the requirements step**

`apps/orchestrator/src/conductor.ts` — structure (write it with the file's conventions; doc comments explain WHY):
```ts
export type ConductStep = 'none' | 'waiting' | 'requirements_set' | 'requirements_failed' | 'conducted' | 'conduct_failed' | 'halted'

/**
 * The conductor's turn in the tick (Conductor Plan 2), for `conducted` workspaces only. ONE model
 * call per tick at most (plan decision D4): the requirement extraction first, the size decision
 * on a later tick. A daemon tick that spends two minutes on each of two calls starves every other
 * workspace; one call bounds it like one Supervisor pass does.
 */
export async function conduct(deps: TickDeps): Promise<ConductStep> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: deps.workspaceId }, select: {
    delivery: true, goal: true, goalVersion: true, repoPath: true, baseBranch: true, haltedReason: true } })
  if (workspace.delivery !== 'conducted' || workspace.goal === null || workspace.goalVersion === 0) return 'none'
  if (workspace.haltedReason !== null) return 'none'
  const version = workspace.goalVersion
  if ((await prisma.workPackage.count({ where: { workspaceId: deps.workspaceId, goalVersion: version } })) > 0) return 'none'
  const call = resolveConductorCall(deps)   // see below
  if (call === null) return 'none'
  if (await boardIsBusy(deps.workspaceId, version)) return 'waiting'

  const set = await prisma.requirementSet.findUnique({ where: { workspaceId_goalVersion: { workspaceId: deps.workspaceId, goalVersion: version } } })
  if (set === null) return extractRequirements(deps, call, workspace.goal, version)
  return 'none' // Task 6 replaces this line with the size decision
}
```
- `resolveConductorCall(deps)`: the decider and model the Supervisor pass would use. Read `supervise()` (`apps/orchestrator/src/supervisor.ts:172` onwards) and find how it resolves `deps.decider`/`deps.model` when absent (workspace `supervisorProvider`/`supervisorModel`, a default constant). Extract that resolution into an exported helper in `supervisor.ts` (e.g. `resolveSupervisorModel(deps, settings)`) and call it from both places; do not copy it. When no decider can be resolved return `null` (the tick reports `'none'`).
- `boardIsBusy(workspaceId, version)` (plan decision D5):
```ts
const live = await prisma.task.count({ where: {
  workspaceId,
  NOT: [
    { status: { in: ['failed', 'cancelled'] } },
    { status: 'done', integratedAt: { not: null } },
    { workPackage: { goalVersion: version } },
  ],
} })
return live > 0
```
- `callConductor(call, workspaceId, version, stage, prompt, parse, planOf?)`: `await call.decider({ model: call.model, prompt, maxBudgetUsd: CONDUCT_PER_CALL_CAP_USD })`; on `kind === 'failed'` the failure reason is `outcome.reason`, on `'isolation_breach'` it is `'the model tried to use tools'`; on an answer, run `parse(outcome.text)`; write ONE `ConductorCall` row `{ stage, outcome: ok|failed, reason: null|failure, modelCostUsd: outcome.costUsd, unmeasured: outcome.costUsd === null, plan: ok && planOf ? planOf(value) : null }` whatever happened (a parse failure is a paid call too). Return `{ value }` or `{ failure }`.
- `extractRequirements`: count `ConductorCall` `{ stage: 'requirements', outcome: 'failed', goalVersion: version }`; at `>= CONDUCT_RETRY_CAP` halt (below) and return `'halted'`. Otherwise call with `buildRequirementsPrompt(goal)` and `parseRequirementsAnswer`; on failure return `'requirements_failed'`. On success: previous = the newest `RequirementSet` with `goalVersion < version` (parsed with `requirementItemsSchema`), `items = assignRequirementKeys(drafts, previous)`, create the row, `appendEvent({ type: 'workspace.requirements_set', workspaceId, actor: 'system', payload: { version, count: items.length, setId } })`, return `'requirements_set'`. The create is `upsert`-free: a unique violation (another tick raced) is caught and read as success.
- Halt: the `merge.ts:84-96` precedent — `prisma.workspace.updateMany({ where: { id, haltedReason: null }, data: { haltedReason: `the conductor could not extract requirements for goal v${version}: ${lastReason}`, haltedAt: new Date() } })` then `appendEvent({ type: 'guardrail.tripped', …, payload: { guardrail: 'conductor_failed' satisfies GuardrailKind, detail } })`. Add `'conductor_failed'` to `GUARDRAIL_KINDS` and `GUARDRAIL_LABEL` (`packages/domain/src/guardrails/kinds.ts`) following the `run_stalled` entry Plan 1 added (commit `8496bb8a` area; `git log -S run_stalled --oneline` shows every file that entry touched — touch the same set).

- [ ] **Step 4: Wire the tick, gate planning, suppress planning situations**

- `tick.ts` ~line 418: `const conductStep = waitingOn === null ? await conductQuietly(deps) : null` BEFORE the `dispatchPlanning` line; `conductQuietly` wraps `conduct` in try/catch and logs like `superviseQuietly` (a throw must not fail the tick). Add `conductStep` to `TickReport` (optional field, so existing `toEqual` assertions on reports keep passing — check `apps/orchestrator/test/integration/tick.test.ts` for exact-shape assertions on `TickReport` and update them if any break).
- `planning.ts` `dispatchPlanning`: select `delivery` with the workspace and return `null` when it is `'conducted'`, with a comment citing spec R2 ("Planner-graph planning is not dispatched for a conducted workspace").
- Supervisor world: add `delivery` to the workspace select in `packages/control/src/supervisorWorld.ts` and to `SupervisorWorld` (`packages/domain/src/supervisor/world.ts`); in `observe.ts`, `planningStalledReason(world)` returns `null` and `runbook_recommended` is not raised when `world.delivery === 'conducted'`. Update `packages/domain/test/supervisor/fixtures.ts` so the default world has `delivery: 'planned'`.

- [ ] **Step 5: Spend**

In `packages/control/src/spend.ts` add, after the chat term:
```ts
  // Conductor Plan 2 (D6): every conductor call is a `ConductorCall` row -- ok and failed alike,
  // because a refused answer was still paid for. Unmeasured calls are charged at the cap, the
  // intake term's rule.
  const conductor = await client.conductorCall.groupBy({
    by: ['unmeasured'],
    where: { workspaceId },
    _sum: { modelCostUsd: true },
    _count: { _all: true },
  })
  const conductorMeasuredUsd = conductor.reduce((total, group) => total + (group._sum.modelCostUsd ?? 0), 0)
  const conductorUnmeasuredCalls = conductor.find((group) => group.unmeasured)?._count._all ?? 0
```
return both, add them to `WorkspaceSpend`, and add them wherever the total is computed from the other terms (search the file and `grep -rn "intakeUnmeasuredCalls" packages apps --include=*.ts` for every consumer, including web). Unmeasured conductor calls are charged at `CONDUCT_PER_CALL_CAP_USD` exactly as intake's are at `INTAKE_PER_CALL_CAP_USD`.

- [ ] **Step 6: Run tests**

Run: `npx vitest run apps/orchestrator/test/integration/conductor.test.ts packages/domain/test/supervisor packages/control/test/integration/spend.test.ts apps/orchestrator/test/integration/planning.test.ts`
(if `spend.test.ts` has another name, `ls packages/control/test/integration | grep -i spend`).
Expected: PASS. Then `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add apps/orchestrator packages/control packages/domain
git commit -m "feat(conductor): a conducted goal version gets its requirement set; the planner stays out

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The size decision, recorded, and packages materialised as tasks

**Files:**
- Modify: `apps/orchestrator/src/conductor.ts`
- Modify: `packages/domain/src/supervisor/situations.ts` (`SITUATION_KINDS`, `SITUATION_LABEL`)
- Modify: `packages/domain/src/supervisor/actions.ts` (action `conduct`)
- Modify: `packages/domain/src/supervisor/policy.ts` (`tierOf`), `packages/control/src/supervisor.ts` (`applyDecision`/`carryOut` case), every total `Record` over action kinds the compiler names
- Test: `apps/orchestrator/test/integration/conductor.test.ts` (new describe), `packages/domain/test/supervisor/actions.test.ts` (or the file testing `actionSchema`)

**Interfaces:**
- Consumes: Task 3 `parseConductAnswer`, `validateConduct`, `singlePlan`, `buildConductPrompt`, `ConductPlan`, `PackageSpec`; Task 4 `loadRepositoryFacts`, `loadConductCatalogue`; Task 5 `callConductor`, `resolveConductorCall`; Task 7 `staffPackages(workspaceId, goalVersion, packages): Promise<Result<ReadonlyMap<string, string>, string>>` (Task 7 is executed before this one).
- Produces:
  - `export const conductPlanSchema` (domain, `packages.ts`)
  - module-private in `conductor.ts`: `decideAndMaterialise`, `fallbackTemplate(workspaceId, catalogue): Promise<string>`, `tripConductor(workspaceId, detail): Promise<void>`, `class AlreadyConducted extends Error`
  - Action `{ readonly kind: 'conduct'; readonly goalVersion: number; readonly mode: 'single' | 'partitioned'; readonly packageKeys: readonly string[] }` in `Action` and `actionSchema`
  - Situation kind `'conduct'` (last in `SITUATION_KINDS`), label `'How a goal is delivered'`
  - `async function materialise(workspaceId, version, plan, fallback, seats: ReadonlyMap<string, string>): Promise<string /* decisionId */>` (module-private)

**Execution order note:** implement Task 7 before this task (Task 6 calls `staffPackages`). The numbering follows the spec's R-order.

- [ ] **Step 1: The action and the situation kind**

- `packages/domain/src/supervisor/actions.ts`: add the union member with a comment ("Conductor R2: the size decision of one goal version. Carried out by the conductor in the same transaction that records it (plan decision D7); `applyDecision` treats it as already applied.") and its zod object `z.object({ kind: z.literal('conduct'), goalVersion: z.number().int().positive(), mode: z.enum(['single', 'partitioned']), packageKeys: z.array(z.string().min(1)).min(1) })`.
- Chat must never offer it: find how `parseSupervisorReply` (`packages/domain/src/supervisor/chatPrompt.ts:529`) limits which action kinds a reply may carry. If it uses the full `actionSchema`, add `conduct` to its refused set with the reason "the conductor decides this itself".
- `tierOf` (`policy.ts:99`): `case 'conduct': return 'applied'`.
- `packages/control/src/supervisor.ts` `carryOut`/`applyDecision`: `case 'conduct':` return success without writing (comment: recorded already applied, D7).
- Run `npm run typecheck` and add an entry to every total `Record<Action['kind'], …>` it names (e.g. `ASKED_FOR` in `supervisorChatTick.ts`: `conduct: 'deciding how the goal is delivered'`; the web decision labels).
- `SITUATION_KINDS`: append `'conduct'`; `SITUATION_LABEL.conduct = 'How a goal is delivered'`. If `candidates()` has an exhaustive switch over situation kinds, return `[]` for `conduct` with a comment (never observed).

- [ ] **Step 2: Write the failing integration tests**

In `conductor.test.ts`, a describe `conduct: the size decision`. The seed adds `src/cli.py`, `src/report/table.py`, `src/config.py`, `README.md` to the repo, two active templates `t-backend`, `t-docs` with a managed pool so `hireFromTemplate(..., { requirePool: true })` can seat people (copy the pool seeding from the test that covers `hire_from_catalog` with `requirePool` — `grep -rln "requirePool" packages/control/test apps/orchestrator/test`), and a project team. A requirement set is created by running `conduct` once with `REQUIREMENTS`.

```ts
const PARTITIONED = JSON.stringify({ conductAnswer: {
  mode: 'partitioned', reason: 'two large disjoint parts',
  packages: [
    { key: 'report', title: 'Report modes', requirementKeys: ['R1'], ownedPaths: ['src/report/**'], newPaths: ['src/report/csv.py'], interface: 'render(rows, mode)', dependsOn: [], templateId: 't-backend' },
    { key: 'config', title: 'Config', requirementKeys: ['R2'], ownedPaths: ['src/config.py'], newPaths: [], interface: 'load()', dependsOn: [], templateId: 't-backend' },
  ],
} })

it('materialises a partitioned plan: packages, pinned tasks, dependencies, a recorded decision, one seat each', async () => {
  const f = await seedWithRequirements()
  expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('conducted')
  const packages = await prisma.workPackage.findMany({ where: { workspaceId: f.workspaceId }, include: { tasks: true }, orderBy: { key: 'asc' } })
  expect(packages.map((p) => p.key)).toEqual(['config', 'integration', 'report'])
  const tasks = packages.flatMap((p) => p.tasks)
  expect(tasks.every((t) => t.status === 'ready' && t.requiredRole === PACKAGE_WORKER_ROLE && t.goalVersion === 1 && t.assigneeId !== null)).toBe(true)
  expect(new Set(tasks.map((t) => t.assigneeId)).size).toBe(3)
  const integrationTask = packages.find((p) => p.key === 'integration')?.tasks[0]
  const deps = await prisma.taskDependency.findMany({ where: { taskId: integrationTask?.id } })
  expect(deps).toHaveLength(2)
  const decision = await prisma.supervisorDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId, situationKind: 'conduct' } })
  expect(decision).toEqual(expect.objectContaining({ tier: 'applied', status: 'applied', subjectId: `${f.workspaceId}:v1`, modelCalled: false, rationale: 'two large disjoint parts' }))
  expect(await prisma.executionEvent.count({ where: { workspaceId: f.workspaceId, type: 'workspace_conducted' } })).toBe(1)
  // idempotent: a second tick does nothing
  expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('none')
})

it('hands the refusal to the next attempt and falls back to single after the cap', async () => {
  const f = await seedWithRequirements()
  const overlapping = PARTITIONED.replace('src/config.py"], "newPaths"', 'src/**"], "newPaths"')
  const { decider, prompts } = scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(overlapping) })
  for (let i = 0; i < CONDUCT_RETRY_CAP; i += 1) expect(await conduct(depsFor(f, decider))).toBe('conduct_failed')
  expect(prompts.at(-1)).toContain('Your previous answer was refused: ')
  expect(await conduct(depsFor(f, decider))).toBe('conducted')
  const packages = await prisma.workPackage.findMany({ where: { workspaceId: f.workspaceId } })
  expect(packages).toEqual([expect.objectContaining({ key: 'main', ownedPaths: ['**'], requirementKeys: ['R1', 'R2'] })])
  const decision = await prisma.supervisorDecision.findFirstOrThrow({ where: { workspaceId: f.workspaceId, situationKind: 'conduct' } })
  expect(decision.decidedBy).toBe('rules')
  expect(decision.rationale).toContain('single by default')
})

it('waits while an older version still has live work (D5)', async () => {
  const f = await seedWithRequirements()
  await prisma.task.create({ data: { workspaceId: f.workspaceId, title: 'old', description: 'old', status: 'running', maxAttempts: 3, requiredRole: 'backend' } })
  expect(await conduct(depsFor(f, scripted({ requirements: () => answer(REQUIREMENTS), conduct: () => answer(PARTITIONED) }).decider))).toBe('waiting')
})
```
The fallback's persona: the template the conductor used most in its refused answers is unknowable after a failure, so the fallback picks, in order, the persona of an existing open seat that holds `PACKAGE_WORKER_ROLE`, else the first template in the catalogue shown — write this rule in a doc comment and assert it in the fallback test (`templateId` equals `t-backend` there, the first by name).

- [ ] **Step 3: Implement the size decision**

In `conduct()`, replace Task 5's `return 'none'` with a call to `decideAndMaterialise(deps, call, workspace, version, set)`:
```ts
async function decideAndMaterialise(…): Promise<ConductStep> {
  const items = requirementItemsSchema.parse(set.items)
  const keys = items.map((i) => i.key)
  // A plan already bought for this version (an ok `conduct` call) is staffed again, never re-bought:
  // staffing can fail after the answer (a pool ran out), and the next tick retries only the staffing.
  const bought = await prisma.conductorCall.findFirst({ where: { workspaceId: deps.workspaceId, goalVersion: version, stage: 'conduct', outcome: 'ok', plan: { not: Prisma.AnyNull } }, orderBy: { createdAt: 'desc' } })
  let plan: ConductPlan
  let fallback = false
  if (bought !== null) {
    plan = conductPlanSchema.parse(bought.plan)
    fallback = plan.reason.endsWith('single by default')
  } else {
    const failures = await prisma.conductorCall.findMany({ where: { workspaceId: deps.workspaceId, goalVersion: version, stage: 'conduct', outcome: 'failed' }, orderBy: { createdAt: 'asc' } })
    const [repo, catalogue] = await Promise.all([loadRepositoryFacts(workspace.repoPath, workspace.baseBranch), loadConductCatalogue()])
    if (failures.length >= CONDUCT_RETRY_CAP) {
      fallback = true
      plan = singlePlan(await fallbackTemplate(deps.workspaceId, catalogue), keys,
        `the conductor's answer was unusable ${failures.length} times (last: ${failures.at(-1)?.reason ?? 'unknown'}); single by default`)
    } else {
      const decided = await callConductor(call, deps.workspaceId, version, 'conduct',
        buildConductPrompt({ goal: workspace.goal, requirements: items, repositoryMap: repo.map, catalogue: catalogue.text, previousError: failures.at(-1)?.reason ?? null }),
        (text) => { const raw = parseConductAnswer(text); return raw.ok ? validateConduct(raw.value, { requirementKeys: keys, repoFiles: repo.files, templateIds: catalogue.templateIds }) : raw },
        (value) => value)
      if ('failure' in decided) return 'conduct_failed'
      plan = decided.value
    }
  }
  const seats = await staffPackages(deps.workspaceId, version, plan.packages)
  if (!seats.ok) {
    await tripConductor(deps.workspaceId, `staffing goal v${version}: ${seats.error}`)
    return 'conduct_failed'
  }
  try {
    await materialise(deps.workspaceId, version, plan, fallback, seats.value)
  } catch (error) {
    if (error instanceof AlreadyConducted) return 'none'
    throw error
  }
  return 'conducted'
}
```
- `conductPlanSchema`: add a zod schema for `ConductPlan` to `packages/domain/src/conduct/packages.ts` (export it; Task 3's types stay the source of truth, the schema mirrors them) so a stored plan is read back typed.
- The fallback plan is not a model call and writes no `ConductorCall` row; it is recorded by the `conduct` decision itself (`decidedBy: 'rules'`). If staffing then fails for it, the next tick re-derives the same fallback (deterministic), so nothing is re-bought.
- `tripConductor(workspaceId, detail)`: append `guardrail.tripped` with guardrail `'conductor_failed'` and this detail, unless the workspace's newest `guardrail.tripped` event already carries the same detail (so a pool that stays empty is said once, not every tick). It does NOT halt: staffing may succeed on a later tick after a pool sync or a person's action.
- `AlreadyConducted`: a module-private `class AlreadyConducted extends Error {}` thrown inside the transaction (step 1 below) so the transaction rolls back.
- `materialise` runs ONE `prisma.$transaction`:
  1. `SELECT id FROM "Workspace" WHERE id = … FOR UPDATE`; if a `WorkPackage` for this version exists, `throw new AlreadyConducted()` (a returned value would commit — Global Constraints).
  2. Create the `SupervisorDecision` directly (D7): `situationKind: 'conduct'`, `subjectId: `${workspaceId}:v${version}``, `situation` = `situationSchema.parse({ kind: 'conduct', subjectId, summary: `Goal v${version}: ${plan.mode}, ${plan.packages.length} package(s)`, facts: { goalVersion: version, mode: plan.mode, packages: plan.packages.length } })`, `candidates` = `[candidateSchema.parse({ action: { kind: 'conduct', goalVersion: version, mode: plan.mode, packageKeys }, tier: 'applied', why: plan.reason })]`, `chosenIndex: 0`, `action`, `rationale: plan.reason`, `tier: 'applied'`, `status: 'applied'`, `decidedBy: fallback ? 'rules' : 'model'`, `modelCostUsd: null`, `modelCalled: false`. (Check `situationSchema`'s `facts` accepts flat scalars only — it does per `observe.ts`'s comment.)
  3. For each package: create `WorkPackage`, then its `Task`: `title: package.title`, `description: taskDescription(package, items)` (below), `status: 'ready'`, `requiredRole: PACKAGE_WORKER_ROLE`, `requiredCapabilities: []`, `createdBy: 'system'`, `maxAttempts: workspace.maxAttempts` (select it), `goalVersion: version`, `assigneeId: seats.get(package.key)`, `workPackageId`.
  4. Then `taskDependency.create` for every `dependsOn` edge, by key → task id.
  After commit: `task.created` per task with the payload `concludePlanning` writes (`apps/orchestrator/src/planning.ts`, read the exact payload), then `workspace.conducted`.
- `taskDescription(pkg, items)`: `Requirements:\n${pkg.requirementKeys.map((k) => `${k}: ${text}`).join('\n')}` for a package with requirements; for integration without any: `Wire the packages together: ${deps.join(', ')}.`. The full contract (owned paths, interfaces) is the run context's job (Task 8), not the description's.

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/orchestrator/test/integration/conductor.test.ts packages/domain/test/supervisor packages/control/test/integration/supervisor*.test.ts`
Expected: PASS. `npm run typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add apps packages
git commit -m "feat(conductor): the size decision is recorded and its packages become pinned tasks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: One seat per package, and a package task runs only on its seat

**Files:**
- Create: `packages/control/src/conductStaffing.ts`
- Modify: `packages/control/src/capability.ts` (`hireFromTemplate`: option `newSeat`)
- Modify: `packages/control/src/index.ts` (export)
- Modify: `packages/domain/src/scheduler/decide.ts` (`SchedulableTask.pinnedSlaveId`, `decide`, `hasStartableWork`)
- Modify: `apps/orchestrator/src/world.ts` (`loadTaskRows` selects the pin)
- Test: `packages/domain/test/scheduler/decide.test.ts`, `packages/control/test/integration/conduct-staffing.test.ts`

**Interfaces:**
- Consumes: `hireFromTemplate(workspaceId, templateId, opts)` (`packages/control/src/capability.ts:745`), `mergeRuntimeRoles(slaveId, adds, actor, origin)` (`capability.ts:428`), `PACKAGE_WORKER_ROLE`, `PackageSpec`.
- Produces:
  - `export async function staffPackages(workspaceId: string, goalVersion: number, packages: readonly Pick<PackageSpec, 'key' | 'templateId'>[]): Promise<Result<ReadonlyMap<string, string>, string>>` — package key → slave id
  - `hireFromTemplate` option `readonly newSeat?: boolean` — skip the reuse-an-existing-worker branch and always seat a new person
  - `SchedulableTask.pinnedSlaveId?: SlaveId | null`

- [ ] **Step 1: Failing scheduler tests**

In `packages/domain/test/scheduler/decide.test.ts` (reuse its world builder):
```ts
it('gives a pinned task only to its seat', () => {
  const world = worldWith({
    tasks: [{ id: taskId('t1'), status: 'ready', requiredRole: 'implementer', priority: 0, dependenciesDone: true, pinnedSlaveId: slaveId('s2') }],
    slaves: [{ id: slaveId('s1'), runtimeRoles: ['implementer'], busy: false }, { id: slaveId('s2'), runtimeRoles: ['implementer'], busy: false }],
  })
  expect(decide(world)).toEqual([{ kind: 'start_run', taskId: 't1', slaveId: 's2' }])
})

it('leaves a pinned task waiting while its seat is busy, even with another seat free', () => {
  const world = worldWith({
    tasks: [{ id: taskId('t1'), status: 'ready', requiredRole: 'implementer', priority: 0, dependenciesDone: true, pinnedSlaveId: slaveId('s2') }],
    slaves: [{ id: slaveId('s1'), runtimeRoles: ['implementer'], busy: false }, { id: slaveId('s2'), runtimeRoles: ['implementer'], busy: true }],
  })
  expect(decide(world)).toEqual([])
})

it('hasStartableWork respects the pin', () => {
  const tasks = [{ status: 'ready' as const, requiredRole: 'implementer', dependenciesDone: true, pinnedSlaveId: slaveId('s2') }]
  expect(hasStartableWork({ id: slaveId('s1'), runtimeRoles: ['implementer'] }, tasks)).toBe(false)
  expect(hasStartableWork({ id: slaveId('s2'), runtimeRoles: ['implementer'] }, tasks)).toBe(true)
})
```
(Use the file's own helpers for building worlds and ids; the names above are placeholders for whatever it uses.)

- [ ] **Step 2: Implement the pin**

`decide.ts`:
```ts
  /**
   * Conductor Plan 2 (D3): the seat a package task belongs to. A pinned task is started only on
   * that seat; the role still has to be held (every package seat holds `PACKAGE_WORKER_ROLE`), so
   * a seat whose role was taken away stops receiving its package rather than running it anyway.
   */
  readonly pinnedSlaveId?: SlaveId | null
```
In `decide()`'s loop:
```ts
    const pinned = candidate.pinnedSlaveId ?? null
    const slave = pinned !== null
      ? (() => { const seat = availableSlaves.get(pinned); return seat !== undefined && holdsRole(seat, candidate.requiredRole) ? seat : undefined })()
      : [...availableSlaves.values()].find((a) => holdsRole(a, candidate.requiredRole))
```
`hasStartableWork(seat: { readonly id?: SlaveId; readonly runtimeRoles: readonly string[] }, tasks: readonly Pick<SchedulableTask, 'status' | 'dependenciesDone' | 'backingOff' | 'requiredRole' | 'pinnedSlaveId'>[])`: a pinned task counts only when `seat.id === task.pinnedSlaveId`. Check its callers (`grep -rn "hasStartableWork" packages apps --include=*.ts`) pass the seat's id; add it where they have it.

`world.ts` `loadTaskRows`: add `CASE WHEN t."workPackageId" IS NOT NULL THEN t."assigneeId" END AS "pinnedSlaveId"` to the SELECT, `readonly pinnedSlaveId: string | null` to `TaskWorldRow`, and `...(row.pinnedSlaveId === null ? {} : { pinnedSlaveId: slaveId(row.pinnedSlaveId) })` when building the task. The comment above `loadTaskRows` names a twin query that must move with it (the graph read model); the pin does not change what "ready" means, so the twin needs no change — say so in one line in the comment.

Run: `npx vitest run packages/domain/test/scheduler` → PASS.

- [ ] **Step 3: Failing staffing tests**

`packages/control/test/integration/conduct-staffing.test.ts` (seed a workspace with a project team, templates `t-backend` and `t-docs`, and a managed pool of 3 persons for `t-backend`, 0 for `t-docs` beyond sync — copy the pool seeding from the `requirePool` test found in Task 6 Step 2):
```ts
it('gives two packages of the same persona two different seats, each holding the package role', async () => {
  const seats = await staffPackages(w, 1, [{ key: 'a', templateId: 't-backend' }, { key: 'b', templateId: 't-backend' }])
  expect(seats.ok).toBe(true)
  if (!seats.ok) return
  expect(seats.value.get('a')).not.toBe(seats.value.get('b'))
  const slaves = await prisma.slave.findMany({ where: { id: { in: [...seats.value.values()] } } })
  expect(slaves.every((s) => s.runtimeRoles.includes(PACKAGE_WORKER_ROLE))).toBe(true)
})

it('reuses an idle seat of the persona before hiring', async () => {
  const first = await staffPackages(w, 1, [{ key: 'a', templateId: 't-backend' }])
  const again = await staffPackages(w, 2, [{ key: 'x', templateId: 't-backend' }])
  expect(first.ok && again.ok && again.value.get('x')).toBe(first.ok ? first.value.get('a') : null)
})

it('does not reuse a seat that still holds a live package task', async () => {
  const first = await staffPackages(w, 1, [{ key: 'a', templateId: 't-backend' }])
  const seat = first.ok ? first.value.get('a') ?? '' : ''
  const pkg = await prisma.workPackage.create({ data: { workspaceId: w, goalVersion: 1, key: 'a', title: 'a', requirementKeys: [], ownedPaths: ['**'], interface: '', templateId: 't-backend' } })
  await prisma.task.create({ data: { workspaceId: w, title: 'a', description: 'a', status: 'running', maxAttempts: 3, requiredRole: PACKAGE_WORKER_ROLE, assigneeId: seat, workPackageId: pkg.id } })
  const second = await staffPackages(w, 2, [{ key: 'x', templateId: 't-backend' }])
  expect(second.ok && second.value.get('x')).not.toBe(seat)
})

it('refuses with the persona named when the pool is exhausted', async () => {
  const result = await staffPackages(w, 1, [1, 2, 3, 4].map((i) => ({ key: `p${i}`, templateId: 't-backend' })))
  expect(result.ok).toBe(false)
  expect(!result.ok && result.error).toContain('t-backend')
})
```
If the pool syncs itself up to 3 per template on `pool_unavailable`, the 4th package is the one refused — adjust the count to whatever `syncPersonPool` guarantees (read `packages/control/src/personPool.ts`) and keep the assertion "the refusal names the persona".

- [ ] **Step 4: Implement staffing**

`hireFromTemplate`: add `newSeat?: boolean` to `opts` with a doc comment ("Conductor Plan 2: the conductor staffs one seat per package and does its own reuse; the verb's reuse-by-persona would put two packages on one seat"). When true, skip the `existing` lookup and go straight to the pool path. Keep every other rule (pool, department, events).

`packages/control/src/conductStaffing.ts`:
```ts
/**
 * One seat per package (spec R5, plan decision D2). For each package in order: an open, unreleased
 * seat of the package's persona in this workspace that no other package of this allocation took
 * and that holds no LIVE package task; else a new seat from the persona's managed pool. Every seat
 * returned holds PACKAGE_WORKER_ROLE. Not one transaction -- `hireFromTemplate` runs its own -- so
 * a failure part-way leaves idle seats the next attempt reuses, never a duplicate.
 */
export async function staffPackages(
  workspaceId: string,
  goalVersion: number,
  packages: readonly Pick<PackageSpec, 'key' | 'templateId'>[],
): Promise<Result<ReadonlyMap<string, string>, string>>
```
Implementation outline:
1. `open = prisma.slave.findMany({ where: { team: { workspaceId }, closedAt: null, person: { releasedAt: null } }, select: { id, runtimeRoles, person: { select: { templateId } } }, orderBy: { id: 'asc' } })`.
2. `holding = new Set((await prisma.task.findMany({ where: { workspaceId, workPackageId: { not: null }, assigneeId: { not: null }, NOT: [{ status: { in: ['failed', 'cancelled'] } }, { status: 'done', integratedAt: { not: null } }] }, select: { assigneeId: true } })).map((t) => t.assigneeId))`.
3. For each package: `reuse = open.find((s) => s.person?.templateId === pkg.templateId && !taken.has(s.id) && !holding.has(s.id))`; if none, `hired = await hireFromTemplate(workspaceId, pkg.templateId, { rationale: `Conductor: package "${pkg.key}" of goal v${goalVersion}`, requirePool: true, newSeat: true })`; a refusal returns `err(`no seat for package "${pkg.key}" (persona ${pkg.templateId}): ${refusalText(hired.error)}`)` (use the control package's existing refusal-to-text helper; `grep -n "export function refusalText" -r packages/control/src`).
4. If the seat lacks `PACKAGE_WORKER_ROLE`: `mergeRuntimeRoles(seat, [PACKAGE_WORKER_ROLE], 'conductor', 'system')`; a refusal is an `err` like above.
5. `taken.add(seat)`; map key → seat.

Export from `packages/control/src/index.ts`.

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/control/test/integration/conduct-staffing.test.ts packages/domain/test/scheduler apps/orchestrator/test/integration/tick.test.ts`
Also run the existing `hireFromTemplate` tests: `grep -rln "hireFromTemplate" packages/control/test apps/orchestrator/test` and run those files.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages apps
git commit -m "feat(conductor): one seat per package, and a package task runs only on its own seat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: A package worker's prompt carries its contract and the report protocol

**Files:**
- Modify: `packages/domain/src/run-context/sections.ts` (`SectionKind`, `SectionSource`, source schemas)
- Modify: `packages/domain/src/run-context/render.ts` (`SECTION_ORDER.implementation`)
- Create: `packages/domain/src/conduct/contract.ts`
- Modify: `apps/orchestrator/src/runContext.ts` (build the two sections; conductor line in the ask protocol)
- Modify: `apps/web/src/lib/runContextSummary.ts` (labels for the new kinds)
- Test: `packages/domain/test/conduct/contract.test.ts`, `packages/domain/test/run-context/render.test.ts`, `apps/orchestrator/test/integration/run-context.test.ts` (or whichever integration file covers `buildRunContext`: `grep -rln "buildRunContext" apps/orchestrator/test`)

**Interfaces:**
- Consumes: `WorkPackage` rows, `RequirementSet.items` (`requirementItemsSchema`), `CONDUCTOR_ROLE`, `INTEGRATION_PACKAGE_KEY`.
- Produces:
  - `SectionKind` members `'package'` and `'report_protocol'`; sources `{ kind: 'package'; workPackageId: string; requirements: number; sha256: string }` and `{ kind: 'report_protocol'; requirements: number; workflowSteps: number }`
  - `export const SLAVE_REPORT_TAG = 'slave-report'`
  - `export function renderPackageContract(input: { readonly pkg: { readonly key: string; readonly title: string; readonly ownedPaths: readonly string[]; readonly isIntegration: boolean; readonly interface: string }; readonly requirements: readonly RequirementItem[]; readonly dependencies: readonly { readonly key: string; readonly interface: string }[] }): string`
  - `export function renderReportProtocol(requirementKeys: readonly string[], workflowSteps: number): string`

- [ ] **Step 1: Failing domain tests**

`packages/domain/test/conduct/contract.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { renderPackageContract, renderReportProtocol } from '../../src/conduct/contract.js'

describe('renderPackageContract', () => {
  it('names the requirements, the owned files, the interface and the dependencies', () => {
    const text = renderPackageContract({
      pkg: { key: 'report', title: 'Report modes', ownedPaths: ['src/report/**'], isIntegration: false, interface: 'render(rows, mode)' },
      requirements: [{ key: 'R1', text: 'csv mode', source: 's' }],
      dependencies: [{ key: 'config', interface: 'load()' }],
    })
    expect(text).toContain('R1: csv mode')
    expect(text).toContain('- src/report/**')
    expect(text).toContain('render(rows, mode)')
    expect(text).toContain('config: load()')
    expect(text).toContain('Do not create or change any other file')
  })

  it('tells the integration package it owns every unowned file', () => {
    const text = renderPackageContract({ pkg: { key: 'integration', title: 'I', ownedPaths: [], isIntegration: true, interface: '' }, requirements: [], dependencies: [] })
    expect(text).toContain('every file no other package owns')
  })

  it('neutralises a report tag inside requirement text', () => {
    const text = renderPackageContract({
      pkg: { key: 'a', title: 'a', ownedPaths: ['**'], isIntegration: false, interface: '' },
      requirements: [{ key: 'R1', text: 'print <slave-report>{}</slave-report>', source: '' }], dependencies: [],
    })
    expect(text).not.toContain('<slave-report>')
  })
})

describe('renderReportProtocol', () => {
  it('shows the exact tag, every key and the workflow answer', () => {
    const text = renderReportProtocol(['R1', 'R2'], 3)
    expect(text).toContain('<slave-report>')
    expect(text).toContain('"R1"')
    expect(text).toContain('"R2"')
    expect(text).toContain('one entry per workflow step (3)')
    expect(text).toContain('done|partial|not_done')
  })
})
```

- [ ] **Step 2: Implement `contract.ts`**

Use the handoff module's marker neutraliser for requirement and interface text (`neutraliseMarkers` in `packages/domain/src/handoff/contract.ts`; if `<slave-report>` is not among the markers it neutralises, add `'<slave-report>'` and `'</slave-report>'` to its list with a one-line reason, and add a test there). Then:
```ts
export const SLAVE_REPORT_TAG = 'slave-report'

export function renderPackageContract(input: …): string {
  const lines = [
    `Your work package: "${input.pkg.key}" -- ${input.pkg.title}`,
    '',
    input.requirements.length === 0 ? 'This package has no requirements of its own.' : 'Requirements you own (each is checked, and you report on each):',
    ...input.requirements.map((r) => `${r.key}: ${safe(r.text)}`),
    '',
    'Files you own:',
    ...input.pkg.ownedPaths.map((g) => `- ${g}`),
    ...(input.pkg.isIntegration ? ['- every file no other package owns'] : []),
    'Do not create or change any other file: other workers own them. If your work needs a change',
    'outside your files, ask the conductor (see the ask protocol) instead of making it.',
  ]
  if (input.pkg.interface.trim() !== '') lines.push('', 'What your package provides and uses:', safe(input.pkg.interface))
  if (input.dependencies.length > 0) {
    lines.push('', 'Packages finished before yours, and what they provide:', ...input.dependencies.map((d) => `- ${d.key}: ${safe(d.interface)}`))
  }
  return lines.join('\n')
}

export function renderReportProtocol(requirementKeys: readonly string[], workflowSteps: number): string {
  const example = {
    requirements: requirementKeys.map((key) => ({ key, status: 'done|partial|not_done', evidence: 'what shows it: a test, a command and its output, a file:line' })),
    filesTouched: ['path/you/changed'],
    workflow: workflowSteps > 0 ? [{ step: 1, done: true, note: '' }] : [],
    questions: [],
  }
  return [
    'When you finish, end your final message with this report, exactly once:',
    `<${SLAVE_REPORT_TAG}>${JSON.stringify(example)}</${SLAVE_REPORT_TAG}>`,
    '- "requirements": one entry per requirement key above, each exactly once, status done|partial|not_done.',
    workflowSteps > 0 ? `- "workflow": one entry per workflow step (${workflowSteps}), by its number.` : '- "workflow": [] (you were given no workflow).',
    '- "questions": anything you need the conductor to decide; each is sent to it when you finish.',
    'A missing or malformed report sends this task back to you.',
  ].join('\n')
}
```
`safe` = the neutraliser composed with `defuseRoutingLiterals`. Export from `conduct/index.ts`. Run the test → PASS.

- [ ] **Step 3: Sections**

- `sections.ts`: add `'package' | 'report_protocol'` to `SectionKind`, the two `SectionSource` variants, their zod objects in `sectionSourceSchema`.
- `render.ts` `SECTION_ORDER.implementation`: `['profile', 'roster', 'skills', 'workflow', 'inbox', 'ask_protocol', 'task', 'package', 'handoff', 'memory', 'report_protocol', 'rejection']`, with a comment: the contract sits right under the task it belongs to; the report protocol is the last instruction before the rejection, which stays last (M49 R3).
- In `packages/domain/test/run-context/render.test.ts` add: an implementation render with both sections places `package` directly after `task` and `report_protocol` directly before `rejection`.

- [ ] **Step 4: Build them in `buildRunContext`**

In `apps/orchestrator/src/runContext.ts`, after the `task` section (~line 1064): when `input.kind === 'implementation'` and the task has `workPackageId`, load the package, its goal version's `RequirementSet`, and the packages it `dependsOn` (same workspace and version), then push:
- `{ kind: 'package', text: renderPackageContract(...), source: { kind: 'package', workPackageId, requirements: n, sha256: sha256(text) } }`
- `{ kind: 'report_protocol', text: renderReportProtocol(pkg.requirementKeys, workflowSteps), source: { kind: 'report_protocol', requirements: n, workflowSteps } }` where `workflowSteps` is the number of steps the `workflow` section already rendered for this run (reuse the variable computed at ~line 1043; 0 when there is none).

Ask protocol: find where the `ask_protocol` section text is built (search `ask_protocol` in `runContext.ts` and `inbox.ts`). For a package task, append: `You can also ask the conductor, who decides how this goal is delivered: <slave-ask>{"role": "${CONDUCTOR_ROLE}", "question": "..."}</slave-ask>` — mirror the exact envelope syntax the section already shows, and render the section for package tasks even when the roster offers nobody else to ask.

Also let `apps/orchestrator/src/ask.ts` `recipientCanAnswer` accept `ask.recipientRole === CONDUCTOR_ROLE` (return `null`, with a comment: nobody holds the role; the Supervisor answers it through `unanswerable_question`, spec R7). Test in the ask integration test file (`grep -rln "recipientCanAnswer\|concludeWithQuestion" apps/orchestrator/test`): a run whose final text asks `{"role":"conductor", …}` parks `waiting` with a `question` message whose `recipientRole` is `conductor`.

Supervisor side: in `packages/domain/src/supervisor/observe.ts` `recipientLabel(question)` returns `'the conductor'` for `recipientRole === CONDUCTOR_ROLE`; in `candidates.ts` (~835-850), for such a question offer only `answer_question` and `escalate_to_human` (no staffing or reassign offers: nobody should be hired to hold the conductor's role). Add an observe/candidates unit test for that.

- [ ] **Step 5: Web summary**

`apps/web/src/lib/runContextSummary.ts`: add labels for `package` ("Work package") and `report_protocol` ("Report required") wherever section kinds are mapped. Run `npm run typecheck`.

- [ ] **Step 6: Integration test for the prompt**

In the `buildRunContext` integration file: seed a package task (WorkPackage + RequirementSet + Task with `workPackageId`) and assert the rendered prompt contains `Your work package: "report"`, `R1: `, `<slave-report>`, and the conductor ask line; a non-package implementation task's prompt contains none of them.

Run: `npx vitest run packages/domain/test/conduct packages/domain/test/run-context packages/domain/test/supervisor <the buildRunContext integration file> <the ask integration file>` → PASS.

- [ ] **Step 7: Commit**

```bash
git add packages apps
git commit -m "feat(run-context): a package worker is told its requirements, its files, its interfaces and how to report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The report is read before verify; a missing one goes back; its questions reach the conductor

**Files:**
- Create: `packages/domain/src/conduct/report.ts`
- Create: `apps/orchestrator/src/report.ts`
- Modify: `apps/orchestrator/src/verify.ts` (`verifyConcludedRun`, the succeeded-implementation branch ~lines 440-501)
- Modify: `apps/orchestrator/src/planning.ts` (extract the generic part of `failPlanningRun` if needed)
- Modify: `packages/providers/test/fake-claude.mjs` (`--report-json-base64`)
- Test: `packages/domain/test/conduct/report.test.ts`, `apps/orchestrator/test/integration/run-report.test.ts`

**Interfaces:**
- Consumes: `SLAVE_REPORT_TAG` (Task 8), `rejectTask(taskId, reason)` (`verify.ts:523`), `joinRunOutput` (`apps/orchestrator/src/runOutput.ts:100`), `sendMessage(runId, input)` (`packages/control/src/messaging.ts:118`), `CONDUCTOR_ROLE`.
- Produces:
  - `export interface SlaveReport { readonly requirements: readonly { readonly key: string; readonly status: 'done' | 'partial' | 'not_done'; readonly evidence: string }[]; readonly filesTouched: readonly string[]; readonly workflow: readonly { readonly step: number | string; readonly done: boolean; readonly note: string }[]; readonly questions: readonly string[] }`
  - `export function parseSlaveReport(text: string, requirementKeys: readonly string[]): Result<SlaveReport, string>`
  - `export async function fileRunReport(run: { readonly id: string; readonly slaveId: string }, task: { readonly id: string; readonly workspaceId: string; readonly workPackageId: string }): Promise<boolean>` — true when the run may go on to verify

- [ ] **Step 1: Failing parser tests**

`packages/domain/test/conduct/report.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseSlaveReport } from '../../src/conduct/report.js'

const wrap = (value: unknown): string => `Done.\n<slave-report>${JSON.stringify(value)}</slave-report>`
const good = {
  requirements: [{ key: 'R1', status: 'done', evidence: 'pytest -k csv passed' }, { key: 'R2', status: 'partial', evidence: 'json lacks nulls' }],
  filesTouched: ['src/report/csv.py'], workflow: [{ step: 1, done: true, note: '' }], questions: ['Should JSON nulls be omitted?'],
}

describe('parseSlaveReport', () => {
  it('reads a complete report', () => {
    const parsed = parseSlaveReport(wrap(good), ['R1', 'R2'])
    expect(parsed.ok && parsed.value.questions).toEqual(['Should JSON nulls be omitted?'])
  })

  it('reads the LAST report when the message quotes an earlier one', () => {
    const text = `${wrap({ ...good, questions: ['old'] })}\n${wrap(good)}`
    const parsed = parseSlaveReport(text, ['R1', 'R2'])
    expect(parsed.ok && parsed.value.questions).toEqual(['Should JSON nulls be omitted?'])
  })

  it('names what is wrong', () => {
    expect(parseSlaveReport('Done, no report.', ['R1'])).toEqual({ ok: false, error: 'the final message has no <slave-report> block' })
    expect(parseSlaveReport('<slave-report>{"requirements": [', ['R1'])).toEqual({ ok: false, error: 'the <slave-report> block is not closed' })
    expect(parseSlaveReport('<slave-report>{nope}</slave-report>', ['R1'])).toEqual({ ok: false, error: 'the <slave-report> block is not valid JSON' })
    const missing = parseSlaveReport(wrap({ ...good, requirements: [good.requirements[0]] }), ['R1', 'R2'])
    expect(!missing.ok && missing.error).toContain('R2 is not reported')
    const twice = parseSlaveReport(wrap({ ...good, requirements: [good.requirements[0], good.requirements[0], good.requirements[1]] }), ['R1', 'R2'])
    expect(!twice.ok && twice.error).toContain('R1 is reported 2 times')
    const unknown = parseSlaveReport(wrap({ ...good, requirements: [...good.requirements, { key: 'R9', status: 'done', evidence: '' }] }), ['R1', 'R2'])
    expect(!unknown.ok && unknown.error).toContain('R9 is not one of yours')
  })

  it('defaults missing optional lists to empty', () => {
    const parsed = parseSlaveReport(wrap({ requirements: good.requirements }), ['R1', 'R2'])
    expect(parsed.ok && parsed.value).toEqual(expect.objectContaining({ filesTouched: [], workflow: [], questions: [] }))
  })
})
```

- [ ] **Step 2: Implement `report.ts` (domain)**

```ts
const reportSchema = z.object({
  requirements: z.array(z.object({ key: z.string(), status: z.enum(['done', 'partial', 'not_done']), evidence: z.string().max(4000).default('') })),
  filesTouched: z.array(z.string().max(500)).max(500).default([]),
  workflow: z.array(z.object({ step: z.union([z.number().int(), z.string().max(200)]), done: z.boolean(), note: z.string().max(2000).default('') })).max(100).default([]),
  questions: z.array(z.string().trim().min(1).max(4000)).max(10).default([]),
})

/**
 * The worker's report (spec R7), from the LAST `<slave-report>` block of its final message -- a
 * worker that quotes its instructions or revises its report mid-message means the last one. Every
 * requirement key of its package must appear exactly once; the error names each gap, because it
 * is handed back to the worker as the rework reason.
 */
export function parseSlaveReport(text: string, requirementKeys: readonly string[]): Result<SlaveReport, string> {
  const open = `<${SLAVE_REPORT_TAG}>`
  const close = `</${SLAVE_REPORT_TAG}>`
  const start = text.lastIndexOf(open)
  if (start === -1) return err(`the final message has no ${open} block`)
  const end = text.indexOf(close, start)
  if (end === -1) return err(`the ${open} block is not closed`)
  let value: unknown
  try {
    value = JSON.parse(text.slice(start + open.length, end))
  } catch {
    return err(`the ${open} block is not valid JSON`)
  }
  const parsed = reportSchema.safeParse(value)
  if (!parsed.success) return err(`the ${open} block's shape is wrong: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  const problems: string[] = []
  for (const key of requirementKeys) {
    const count = parsed.data.requirements.filter((r) => r.key === key).length
    if (count === 0) problems.push(`${key} is not reported`)
    if (count > 1) problems.push(`${key} is reported ${count} times`)
  }
  for (const r of parsed.data.requirements) if (!requirementKeys.includes(r.key)) problems.push(`${r.key} is not one of yours`)
  if (problems.length > 0) return err(`the report is incomplete: ${[...new Set(problems)].join('; ')}`)
  return ok(parsed.data)
}
```
Export from `conduct/index.ts`. Run the unit test → PASS.

- [ ] **Step 3: Fake CLI flag**

In `packages/providers/test/fake-claude.mjs`, next to the ask leg that appends `<slave-ask>` from `--ask-json-base64` (~lines 1266-1284 and 1363-1381), add `--report-json-base64 <b64>`: in the `m8-flow` work arm (~1288-1313), when present, append `\n<slave-report>${decoded}</slave-report>` to the last assistant text block and to `result.result` of the replayed `complete` fixture — the same patching code path the ask leg uses (factor a helper if both need it). Document the flag in the header comment (lines 1-212) beside `--ask-json-base64`.

- [ ] **Step 4: Failing integration tests**

`apps/orchestrator/test/integration/run-report.test.ts`: seed like `planning.test.ts` (real repo, fake CLI with `--fixture m8-flow`, `REAL_GATE`), a conducted workspace with a `RequirementSet` (R1, R2), a `WorkPackage` `main` (`ownedPaths: ['**']`, R1+R2), its `Task` (`ready`, `requiredRole: PACKAGE_WORKER_ROLE`, pinned seat that holds the role), and a reviewer seat. Drive ticks as `planning.test.ts` does (its helper that ticks until a condition holds; `drainPumps()` in `afterEach`).

```ts
it('stores a well-formed report and goes on to verify', async () => {
  const f = await seedPackageTask({ report: goodReport })  // passes --report-json-base64 via depsFor's extraArgs
  await tickUntil(f, async () => (await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).status !== 'running')
  const report = await prisma.runReport.findFirstOrThrow({ where: { taskId: f.taskId } })
  expect((report.report as { requirements: unknown[] }).requirements).toHaveLength(2)
  expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).status).not.toBe('rework')
})

it('fails the run and reworks the task when the report is missing, with the reason', async () => {
  const f = await seedPackageTask({ report: null })
  await tickUntil(f, async () => (await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).status === 'rework')
  const task = await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })
  expect(task.lastRejectionReason).toContain('no <slave-report> block')
  expect(task.attempt).toBe(1)
  const run = await prisma.slaveRun.findFirstOrThrow({ where: { taskId: f.taskId } })
  expect(run.status).toBe('failed')
  expect(await prisma.runReport.count()).toBe(0)
})

it('sends each report question to the conductor, tied to the task', async () => {
  const f = await seedPackageTask({ report: { ...goodReport, questions: ['Omit JSON nulls?'] } })
  await tickUntil(f, async () => (await prisma.runReport.count()) === 1)
  const questions = await prisma.slaveMessage.findMany({ where: { workspaceId: f.workspaceId, kind: 'question' } })
  expect(questions).toEqual([expect.objectContaining({ recipientRole: CONDUCTOR_ROLE, taskId: f.taskId, expectsReply: true, body: 'Omit JSON nulls?' })])
})

it('leaves a non-package task exactly as before', async () => {
  const f = await seedPlainTask()
  await tickUntil(f, async () => (await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).status !== 'running')
  expect(await prisma.runReport.count()).toBe(0)
  expect((await prisma.task.findUniqueOrThrow({ where: { id: f.taskId } })).lastRejectionReason ?? '').not.toContain('slave-report')
})
```
`goodReport` covers R1 and R2. `tickUntil` is whatever loop `planning.test.ts` uses; if it has none, write one bounded to 40 ticks with `drainPumps()` between.

- [ ] **Step 5: Implement `fileRunReport` and wire it**

`apps/orchestrator/src/report.ts`:
```ts
/**
 * Reads a package worker's report (spec R7) before its work is verified. A well-formed report is
 * stored and its questions are sent to the conductor; a missing or malformed one fails the run and
 * sends the task back with the reason -- through `rejectTask`, the same channel verify and review
 * use, so the attempt counter bounds it like any rework. Returns whether verify may go on.
 */
export async function fileRunReport(run, task): Promise<boolean> {
  const rows = await prisma.executionEvent.findMany({ where: { runId: run.id, type: 'run_output' }, orderBy: { seq: 'asc' } })
  const text = joinRunOutput(rows.map((row) => row.payload))
  const pkg = await prisma.workPackage.findUniqueOrThrow({ where: { id: task.workPackageId } })
  const parsed = parseSlaveReport(text, pkg.requirementKeys)
  if (!parsed.ok) {
    await failConcludedRun(run, task.workspaceId, `report: ${parsed.error}`)
    await rejectTask(brandTaskId(task.id), `Your final message did not carry a usable report -- ${parsed.error}. Finish with the <slave-report> block your instructions describe.`)
    return false
  }
  await prisma.runReport.create({ data: { runId: run.id, taskId: task.id, workPackageId: pkg.id, report: parsed.value as unknown as Prisma.InputJsonValue } })
  for (const [index, question] of parsed.value.questions.entries()) {
    const sent = await sendMessage(run.id, { kind: 'question', body: question, recipientRole: CONDUCTOR_ROLE, expectsReply: true, taskId: task.id, idempotencyKey: `report:${run.id}:${index}` })
    if (!sent.ok) console.error(`[report] run ${run.id}: question ${index + 1} was not sent -- ${refusalText(sent.error)}`)
  }
  return true
}
```
- `failConcludedRun`: `failPlanningRun(run, workspaceId, reason)` (`planning.ts:368`) flips `succeeded` → `failed`, amends the outcome and appends `run.failed`. If its body is not planning-specific, rename it to `failConcludedRun`, move it to `apps/orchestrator/src/runs.ts`, and keep `failPlanningRun` as a one-line call to it (so planning's callers do not change). If it is planning-specific, write `failConcludedRun` beside it with the shared part factored out. Either way, one implementation.
- `verifyConcludedRun` (`verify.ts`): in the succeeded-implementation branch, after `commitUncommittedWork` and before `runVerify`, `if (task.workPackageId !== null && !(await fileRunReport(run, { id: task.id, workspaceId, workPackageId: task.workPackageId }))) return`. Select `workPackageId` with the task if the query does not already.
- A duplicate `runReport.create` (the same run concluded twice) must not throw out of `verifyConcludedRun`: catch the unique violation (`P2002`) and treat it as filed.

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/domain/test/conduct apps/orchestrator/test/integration/run-report.test.ts apps/orchestrator/test/integration/planning.test.ts apps/orchestrator/test/integration/verify*.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages apps
git commit -m "feat(conductor): a package run files its report before verify; no report, no verify

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Switching delivery and reading what the conductor decided (CLI)

**Files:**
- Create: `packages/control/src/delivery.ts`
- Modify: `packages/control/src/index.ts`
- Modify: `apps/orchestrator/src/cli.ts` (two verbs + usage lines, beside `set-goal` ~line 2215 and the usage at ~322)
- Test: `packages/control/test/integration/delivery.test.ts`, the CLI test file that covers `set-goal` (`grep -rln "set-goal" apps/orchestrator/test`)

**Interfaces:**
- Produces:
  - `export async function setDelivery(workspaceId: string, delivery: 'conducted' | 'planned'): Promise<Result<{ readonly delivery: 'conducted' | 'planned'; readonly changed: boolean }, ControlRefusal>>`
  - `export async function conductorView(workspaceId: string, goalVersion?: number): Promise<Result<ConductorView, ControlRefusal>>` where `ConductorView = { goalVersion: number; delivery: string; requirements: RequirementItem[] | null; decision: { mode, rationale, decidedBy, createdAt } | null; packages: { key, title, requirementKeys, ownedPaths, isIntegration, seat: { slaveId, name } | null, taskId, taskStatus, reported: boolean }[]; calls: { stage, outcome, reason, modelCostUsd, createdAt }[] }`
  - CLI: `slaveofai set-delivery <workspace> <conducted|planned>` → prints `{ delivery, changed }`; `slaveofai conductor <workspace> [--version N]` → prints the `ConductorView` JSON.

- [ ] **Step 1: Failing tests**

`packages/control/test/integration/delivery.test.ts`:
```ts
it('switches delivery and says whether it changed', async () => {
  const w = await seedWorkspace()
  expect(await setDelivery(w, 'conducted')).toEqual({ ok: true, value: { delivery: 'conducted', changed: true } })
  expect(await setDelivery(w, 'conducted')).toEqual({ ok: true, value: { delivery: 'conducted', changed: false } })
})

it('refuses an unknown workspace', async () => {
  expect((await setDelivery('nope', 'planned')).ok).toBe(false)
})

it('shows requirements, the decision, packages with seats and the conductor calls', async () => {
  const w = await seedConductedVersion() // RequirementSet + decision + one package + task + one ConductorCall
  const view = await conductorView(w)
  expect(view.ok && view.value).toEqual(expect.objectContaining({
    goalVersion: 1, delivery: 'conducted',
    requirements: [expect.objectContaining({ key: 'R1' })],
    decision: expect.objectContaining({ mode: 'single' }),
    packages: [expect.objectContaining({ key: 'main', seat: expect.objectContaining({ name: expect.any(String) }), reported: false })],
  }))
})
```
Use the workspace-not-found refusal kind the control package already has (`workspace_not_found`). `seedWorkspace`/`seedConductedVersion` are local helpers in the test file (see Task 5's seed for the shape).

- [ ] **Step 2: Implement**

`setDelivery`: `findUnique` → `workspace_not_found`; `update` only when it differs. Comment: switching mid-version is allowed; a `planned` board in flight is waited out by the conductor (plan decision D5), and a conducted version's packages stay as they are when switched back (the planner's re-plan intent then treats them as the board).

`conductorView`: `goalVersion` defaults to the workspace's current one; read the set, the `conduct` decision (`situationKind: 'conduct', subjectId: `${w}:v${n}``; mode from `action.mode`), the packages with their tasks (`include: { tasks: { include: { … assignee name } } }` — read how the task's seat name is resolved elsewhere, e.g. the task view in `packages/control/src/task*.ts`), `reported` = a `RunReport` exists for the package, and the calls ordered by `createdAt`.

CLI: add both verbs following `set-goal`'s argument parsing and JSON printing exactly; add usage lines.

- [ ] **Step 3: Run tests**

Run: `npx vitest run packages/control/test/integration/delivery.test.ts <the set-goal CLI test file>` → PASS.

- [ ] **Step 4: Commit**

```bash
git add packages apps
git commit -m "feat(cli): set-delivery switches a workspace to the conductor; conductor shows what it decided

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: End to end, and the whole suite

**Files:**
- Test: `apps/orchestrator/test/integration/conductor-e2e.test.ts`

- [ ] **Step 1: End-to-end test (injected conductor, fake CLI workers)**

One test, `mode: 'single'`: the fake CLI replays one report for every run and cannot tell packages apart, and `parseSlaveReport` refuses keys a package does not own, so a partitioned run cannot be driven end to end by the fake until Plan 4 gives it per-package reports. The partitioned path is covered up to materialisation by Task 6 and up to the report by Task 9.

Set up a conducted workspace (real repo with `src/report/table.py`, `src/config.py`, `README.md`), the goal set, the templates with a pool, and a reviewer seat. Build `TickDeps` with the injected `scripted` decider: requirements R1 and R2, and `{"conductAnswer": {"mode": "single", "reason": "fits one session", "templateId": "t-backend"}}`. Use the fake CLI adapter with `--fixture m8-flow --report-json-base64 <base64 of a report covering R1 and R2>`.

Assert, ticking until quiet (bounded):
- a `RequirementSet` for v1; a `conduct` decision; the package task went `ready → running → …` and reached `done` (m8-flow's work arm commits a file; verify is `true`; review uses the reviewer seat — if review needs `--review-fixture`, pass the approving one `planning.test.ts` or `review.test.ts` uses);
- a `RunReport` for the run;
- `dispatchPlanning` never created a `planning` run (`prisma.slaveRun.count({ where: { kind: 'planning' } }) === 0`);
- `workspaceSpend` includes the conductor calls.

Run: `npx vitest run apps/orchestrator/test/integration/conductor-e2e.test.ts` → PASS.

- [ ] **Step 2: Commit**

```bash
git add apps/orchestrator/test/integration/conductor-e2e.test.ts
git commit -m "test(conductor): a conducted goal goes from requirements to a reported, merged package

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Whole suite, typecheck, web build, vocabulary gate**

Stop any running daemon first (a running daemon breaks `subscribe.test.ts`). No `next dev` may be running.
Run: `npm run typecheck && npx vitest run` (~5 min, alone)
Run: `npm run web:build`
Run: `node scripts/gate-m26-vocabulary.mjs`
Expected: all green. A failure in `daemon-cli` llm-decision row counts is a known load flake: re-run that file alone before believing it.

- [ ] **Step 4: Gates that touch planning**

With the fake-CLI env exactly as `.github/workflows/ci.yml` sets it (`SLAVEOFAI_CLAUDE_BIN`, `SLAVEOFAI_CURSOR_BIN` from `scripts/gate-fakes`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`) and `DATABASE_URL="$GATE_DATABASE_URL"`, run the CI gate list (`grep -n "gate:" .github/workflows/ci.yml`). Gates listed as pre-existing red on main in memory (`m44`, `m57 stage 2`, `m10-org`, `m17-stability`, `m8-plan`, `m47/m48/m50`, `m55 stage 4a`, `m58 stage 7`) are compared against a run on `main` before blaming this branch.

---

## Self-review notes (for the executor)

- Spec coverage: R1 → Tasks 2, 5; R2 → Tasks 3, 4, 6; R3 → Tasks 3, 6; R5 → Task 7 (with D2); R7 → Tasks 8, 9; §5 "planner graph not dispatched for conducted" → Task 5; `Workspace.delivery` → Tasks 1, 10; §6 data → Task 1. R4, R8–R11 are Plans 3–5; the intake staffing change of R5 and the default flip of §5 are Plan 4 (D1).
- Execution order: 1 → 2 → 3 → 4 → 5 → 7 → 6 → 8 → 9 → 10 → 11 (Task 6 calls Task 7's `staffPackages`).
- `ConductorCall.plan` (Task 1) exists for Task 6: a staffing failure must not re-buy the model's answer.
