# M27 Archive and Delete — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator archive (and restore) a project and permanently delete departments, slaves, companies, department templates, catalog slaves and slave templates — every destructive verb refusing while a run is live, every web surface asking twice with the counts in the question.

**Architecture:** One migration adds `Workspace.archivedAt` and two `EventType` members. `archiveWorkspace`/`restoreWorkspace` live in `packages/control/src/workspace.ts`; the scheduler skips an archived workspace in `tick()` and `admitRun()`; every read takes `includeArchived` (default false). The delete verbs in `packages/control/src/org.ts` drop their "not empty / has history" refusals in favour of one `live_runs` refusal and let the database cascade what the schema already cascades (`Team → Slave → SlaveRun/…`), deleting explicitly only where the schema is silent (`SlaveTemplate → CompanySlave`, `Company → Workspace.companyId`). The web gets one `DangerConfirm` component that renders a two-click confirm whose text the caller composes from server-provided counts.

**Tech Stack:** Prisma 7 (one hand-written migration), Zod event schemas in `packages/domain`, Next.js 15 App Router, React 19, Vitest 3 (unit + integration projects), the M11/M14 Playwright gates.

**Spec:** `docs/superpowers/specs/2026-09-05-m27-archive-and-delete-design.md` — read §2–§8 before any task; §-numbers below refer to it.

## Global Constraints

- Branch: `feature/m27-archive-and-delete` (holds the spec commit eeced8d). Every task commits there.
- One migration (`archivedAt`, `workspace.archived`, `workspace.restored`); no other schema change; no new npm dependency.
- **Live run** = a `SlaveRun` whose `status` is in `NON_TERMINAL_RUN_STATUSES` (`@slave-of-ai/domain`). Every destructive verb refuses with `live_runs { entity, id, runs }` while one exists, checked inside the row-locked transaction.
- Every web verb has a CLI verb; the CLI's delete verbs take `--yes` and print the footprint without it (the `delete-team` idiom). Refusals are typed `ControlRefusal` kinds with a `refusalText` case; routes map them to 409.
- Project-level deletes write one `org.changed` event (`field: 'deleted'`); archive/restore write `workspace.archived`/`workspace.restored`; catalog verbs write no event (the M23/M25 rule).
- `DangerConfirm` always receives a fully composed `confirmText` naming counts; an empty one is a defect.
- Vocabulary: "slave", "department", "department template", "catalog slave", "slave template", "project" in every string; identifiers keep `Team`/`Workspace`/`CompanyTeam`/`CompanySlave`.
- Standing rules: ONE vitest run at a time; no orchestrator daemon during tests; root `tsc --build` does NOT cover `apps/web` tests — `npx tsc -p apps/web/tsconfig.test.json --noEmit`; every web task gates on `npm run web:build` before commit (`pgrep -fa 'next dev'` empty first, `rm -rf apps/web/.next` after); `git add` explicit paths; comments change with the behaviour they describe.
- Integration tests (`**/test/integration/**`) use the Postgres at :5433 (`slaveofai_test`); TRUNCATE list for org tables: `"ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate"`.
- Commit trailers on every commit: `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UwnbBiQX5Gdm5VKtFvEr9J`.

## File structure

Create:
- `packages/db/prisma/migrations/20260905150000_m27_archive_and_delete/migration.sql`
- `packages/control/test/integration/archive.test.ts`, `packages/control/test/integration/delete.test.ts`
- `apps/web/src/components/ui/DangerConfirm.tsx`, `apps/web/test/danger-confirm.test.tsx`
- Routes: `apps/web/src/app/api/w/[workspaceId]/archive/route.ts`, `…/restore/route.ts`, `apps/web/src/app/api/org/companies/[companyId]/route.ts`, `apps/web/src/app/api/org/slaves/[companySlaveId]/route.ts`, `apps/web/src/app/api/org/templates/[templateId]/route.ts`
- `apps/web/test/integration/archive-routes.test.ts`, `apps/web/test/integration/delete-routes.test.ts`

Modify: `packages/db/prisma/schema.prisma`, `packages/db/src/enums.ts`, `packages/domain/src/events/schema.ts`, `packages/control/src/refusal.ts`, `packages/control/src/workspace.ts`, `packages/control/src/budget.ts`, `packages/control/src/org.ts`, `apps/orchestrator/src/tick.ts`, `apps/orchestrator/src/cli.ts`, `apps/web/src/server/org.ts`, `apps/web/src/server/workspaces.ts`, `apps/web/src/server/projectSettings.ts`, `apps/web/src/server/workspaceControlRoute.ts`, `apps/web/src/app/w/[workspaceId]/layout.tsx`, `apps/web/src/app/page.tsx`, `apps/web/src/components/project/ProjectHeader.tsx`, `project/ProjectSettingsClient.tsx`, `ProjectsClient.tsx`, `SlaveRowActions.tsx`, `AllSlavesTable.tsx`, `DepartmentsTable.tsx`, `CompanyManager.tsx`, `company/TeamBlock.tsx`, `TemplateCatalog.tsx`, `scripts/gate-m11-shell.mjs`, `README.md`, the spec's §13, and the tests named per task.

Delete: nothing (refusal kinds `slave_has_runs`, `team_not_empty`, `company_team_not_empty` are removed from the union).

---

### Task 1: Archive and restore — migration, events, verbs, scheduler, CLI

**Files:**
- Create: `packages/db/prisma/migrations/20260905150000_m27_archive_and_delete/migration.sql`, `packages/control/test/integration/archive.test.ts`
- Modify: `packages/db/prisma/schema.prisma`, `packages/db/src/enums.ts`, `packages/domain/src/events/schema.ts`, `packages/control/src/refusal.ts`, `packages/control/src/workspace.ts`, `packages/control/src/budget.ts` (+ its callers), `apps/orchestrator/src/tick.ts`, `apps/orchestrator/src/cli.ts`
- Test: `packages/control/test/integration/archive.test.ts` (new), `apps/orchestrator/test/integration/tick.test.ts` (one case added), `packages/control/test/runtime.test.ts` or wherever `admitRun` is unit-tested (`grep -rln "admitRun" packages/control/test`)

**Interfaces:**
- Produces refusal kinds: `live_runs { entity: 'workspace' | 'team' | 'slave'; id: string; runs: number }`, `already_archived { workspaceId }`, `not_archived { workspaceId }`, `workspace_archived { workspaceId }`.
- Produces `archiveWorkspace(workspaceId, principal?): Promise<Result<{ readonly footprint: Footprint }, ControlRefusal>>` and `restoreWorkspace(workspaceId, principal?): Promise<Result<void, ControlRefusal>>` with `Footprint = { readonly departments: number; readonly slaves: number; readonly tasks: number; readonly runs: number }`; `projectFootprint(tx | prisma, workspaceId): Promise<Footprint>` exported from `workspace.ts` (Task 3 reuses it).
- `admitRun` input's `workspace` gains `readonly archivedAt: Date | null` (required); refuses `workspace_archived` first.
- `TickReport` gains `readonly skipped: 'archived' | null`; `tick()` returns `{ started: [], halted: null, skippedNoRole: 0, planningStarted: null, reviewsStarted: [], skipped: 'archived' }` for an archived workspace before `loadWorld`.
- Events: `workspace.archived` payload `{ name, departments, slaves, tasks, runs }`; `workspace.restored` payload `{ name }`.
- CLI: `archive-workspace --workspace <id>`, `restore-workspace --workspace <id>`, `list-workspaces`; `status` prints `archived: <iso>` when set; `resolveWorkspace` auto-picks only among `archivedAt: null` workspaces.

- [ ] **Step 1: Failing tests.** Create `packages/control/test/integration/archive.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { admitRun } from '../../src/budget.js'
import { archiveWorkspace, restoreWorkspace } from '../../src/workspace.js'

const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-archive-'))
afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
  readonly taskId: string
}

/** One project: two departments, one slave, one task, two finished runs. */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  const engineering = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  await prisma.team.create({ data: { workspaceId: workspace.id, name: 'QA' } })
  const slave = await prisma.slave.create({ data: { teamId: engineering.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add the thing', description: 'make it work', maxAttempts: 3 },
  })
  await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: slave.id, status: 'succeeded' } })
  await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: slave.id, status: 'failed' } })
  return { workspaceId: workspace.id, slaveId: slave.id, taskId: task.id }
}

async function eventsOfType(workspaceId: string, type: 'workspace_archived' | 'workspace_restored') {
  return prisma.executionEvent.findMany({ where: { workspaceId, type }, orderBy: { seq: 'asc' } })
}

let fixture: Fixture

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
  fixture = await seed()
})

describe('archiveWorkspace', () => {
  it('sets archivedAt, keeps every row, reports the footprint and emits workspace.archived', async () => {
    const result = await archiveWorkspace(fixture.workspaceId)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.footprint).toEqual({ departments: 2, slaves: 1, tasks: 1, runs: 2 })
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(row.archivedAt).not.toBeNull()
    expect(await prisma.slaveRun.count()).toBe(2)
    expect(await prisma.slave.count()).toBe(1)

    const events = await eventsOfType(fixture.workspaceId, 'workspace_archived')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({ name: 'Checkout Platform', departments: 2, slaves: 1, tasks: 1, runs: 2 })
  })

  it('refuses while a run is live, changing nothing', async () => {
    await prisma.slaveRun.create({ data: { taskId: fixture.taskId, slaveId: fixture.slaveId, status: 'working' } })

    const result = await archiveWorkspace(fixture.workspaceId)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'live_runs', entity: 'workspace', id: fixture.workspaceId, runs: 1 })
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(row.archivedAt).toBeNull()
    expect(await eventsOfType(fixture.workspaceId, 'workspace_archived')).toHaveLength(0)
  })

  it('refuses an already archived project and an unknown one', async () => {
    await archiveWorkspace(fixture.workspaceId)
    const twice = await archiveWorkspace(fixture.workspaceId)
    expect(twice.ok).toBe(false)
    if (!twice.ok) expect(twice.error).toEqual({ kind: 'already_archived', workspaceId: fixture.workspaceId })

    const unknown = await archiveWorkspace(UNKNOWN)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toEqual({ kind: 'workspace_not_found', workspaceId: UNKNOWN })
  })

  it('leaves a halt in place: archive then restore keeps haltedReason', async () => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { haltedReason: 'emergency stop by test', haltedAt: new Date() } })
    await archiveWorkspace(fixture.workspaceId)
    const restored = await restoreWorkspace(fixture.workspaceId)
    expect(restored.ok).toBe(true)
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(row.archivedAt).toBeNull()
    expect(row.haltedReason).toBe('emergency stop by test')
  })
})

describe('restoreWorkspace', () => {
  it('clears archivedAt and emits workspace.restored', async () => {
    await archiveWorkspace(fixture.workspaceId)

    const result = await restoreWorkspace(fixture.workspaceId)

    expect(result.ok).toBe(true)
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: fixture.workspaceId } })
    expect(row.archivedAt).toBeNull()
    const events = await eventsOfType(fixture.workspaceId, 'workspace_restored')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({ name: 'Checkout Platform' })
  })

  it('refuses a project that is not archived, and an unknown one', async () => {
    const notArchived = await restoreWorkspace(fixture.workspaceId)
    expect(notArchived.ok).toBe(false)
    if (!notArchived.ok) expect(notArchived.error).toEqual({ kind: 'not_archived', workspaceId: fixture.workspaceId })

    const unknown = await restoreWorkspace(UNKNOWN)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toEqual({ kind: 'workspace_not_found', workspaceId: UNKNOWN })
  })
})

describe('admitRun on an archived workspace', () => {
  it('refuses workspace_archived before any budget rule', () => {
    const refused = admitRun({
      workspace: { id: 'w1', budgetUsd: null, archivedAt: new Date() },
      provider: 'cursor',
      capabilities: { reportsCost: false },
    })
    expect(refused).toEqual({ ok: false, refusal: { kind: 'workspace_archived', workspaceId: 'w1' } })

    const admitted = admitRun({
      workspace: { id: 'w1', budgetUsd: null, archivedAt: null },
      provider: 'cursor',
      capabilities: { reportsCost: false },
    })
    expect(admitted).toEqual({ ok: true })
  })
})
```

In `apps/orchestrator/test/integration/tick.test.ts` add one case next to the existing halt case (read the file's fixture helpers and reuse them):

```ts
  it('skips an archived workspace without loading the world', async () => {
    await prisma.workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date() } })
    const report = await tick(deps())   // the file's own deps builder
    expect(report.skipped).toBe('archived')
    expect(report.started).toEqual([])
    expect(await prisma.slaveRun.count()).toBe(0)
  })
```

- [ ] **Step 2: RED.** `npx tsc --build` fails on the missing exports/fields — record the first error.

- [ ] **Step 3: Schema + migration + enums + event schema.** In `packages/db/prisma/schema.prisma`, add to `model Workspace` after `haltedAt`:

```prisma
  /// M27: an archived project keeps every row but leaves every list and the scheduler (spec §3).
  archivedAt DateTime?
```

and to `enum EventType` after `workspace_created`:

```prisma
  /// M27 §3: the project was archived / restored; the archive payload carries the footprint.
  workspace_archived         @map("workspace.archived")
  workspace_restored         @map("workspace.restored")
```

Create `packages/db/prisma/migrations/20260905150000_m27_archive_and_delete/migration.sql`:

```sql
-- M27: a project can be archived (soft) -- the flag every list and the scheduler read. Two event
-- types record the archive and the restore. Nothing else changes; every delete in M27 rides the
-- cascades the schema already declares.
ALTER TABLE "Workspace" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.archived';
ALTER TYPE "EventType" ADD VALUE IF NOT EXISTS 'workspace.restored';
```

`packages/db/src/enums.ts`: add `'workspace.archived': 'workspace_archived'` and `'workspace.restored': 'workspace_restored'` to `EVENT_TYPE_BY_DOMAIN_TYPE` (the `satisfies Record<DomainEventType, string>` will demand it once the domain union grows). `packages/domain/src/events/schema.ts`: add after the `workspace.created` member:

```ts
  // M27 §3: archived keeps every row; the payload is the footprint the confirm showed.
  z.object({
    ...envelope,
    type: z.literal('workspace.archived'),
    payload: z.object({
      name: z.string().min(1),
      departments: z.number().int().nonnegative(),
      slaves: z.number().int().nonnegative(),
      tasks: z.number().int().nonnegative(),
      runs: z.number().int().nonnegative(),
    }),
  }),
  z.object({ ...envelope, type: z.literal('workspace.restored'), payload: z.object({ name: z.string().min(1) }) }),
```

Then `set -a; source .env; set +a; npm run db:migrate && npm run db:migrate:test && npm run db:generate`.

- [ ] **Step 4: Refusal kinds.** In `packages/control/src/refusal.ts` add to the union (after `workspace_halted`):

```ts
  | { readonly kind: 'workspace_archived'; readonly workspaceId: string }
  | { readonly kind: 'already_archived'; readonly workspaceId: string }
  | { readonly kind: 'not_archived'; readonly workspaceId: string }
  /** M27 §2: every destructive verb refuses while a run is live. `entity` names what was being
   *  archived or deleted; `runs` how many non-terminal runs stood in the way. */
  | { readonly kind: 'live_runs'; readonly entity: 'workspace' | 'team' | 'slave'; readonly id: string; readonly runs: number }
```

and the `refusalText` cases:

```ts
    case 'workspace_archived':
      return `project ${refusal.workspaceId} is archived; restore it first`
    case 'already_archived':
      return `project ${refusal.workspaceId} is already archived`
    case 'not_archived':
      return `project ${refusal.workspaceId} is not archived`
    case 'live_runs':
      return `${refusal.entity} ${refusal.id} has ${refusal.runs} live run(s); wait for them to finish or stop them first`
```

- [ ] **Step 5: The verbs.** Append to `packages/control/src/workspace.ts` (imports it already has: `prisma`, `Result`/`err`/`ok`, `appendEvent`, `Principal`; add `NON_TERMINAL_RUN_STATUSES` from `@slave-of-ai/domain` and `Prisma` type from `@slave-of-ai/db/client` if not present):

```ts
export interface Footprint {
  readonly departments: number
  readonly slaves: number
  readonly tasks: number
  readonly runs: number
}

/** What a project holds (M27 §3.4's confirm text, §7's `ProjectSettings.footprint`). Four counts,
 *  one round trip each; `db` is a transaction client inside the verbs and `prisma` for reads. */
export async function projectFootprint(db: Prisma.TransactionClient | typeof prisma, workspaceId: string): Promise<Footprint> {
  const [departments, slaves, tasks, runs] = await Promise.all([
    db.team.count({ where: { workspaceId } }),
    db.slave.count({ where: { team: { workspaceId } } }),
    db.task.count({ where: { workspaceId } }),
    db.slaveRun.count({ where: { slave: { team: { workspaceId } } } }),
  ])
  return { departments, slaves, tasks, runs }
}

/** Non-terminal runs anywhere in the project -- the one definition every M27 verb refuses on. */
export async function liveRunCount(db: Prisma.TransactionClient | typeof prisma, where: { workspaceId: string } | { teamId: string } | { slaveId: string }): Promise<number> {
  const status = { in: NON_TERMINAL_RUN_STATUSES as unknown as string[] }
  if ('slaveId' in where) return db.slaveRun.count({ where: { slaveId: where.slaveId, status } })
  if ('teamId' in where) return db.slaveRun.count({ where: { slave: { teamId: where.teamId }, status } })
  return db.slaveRun.count({ where: { slave: { team: { workspaceId: where.workspaceId } }, status } })
}

/**
 * Archives a project (M27 §3): every row stays, `archivedAt` is set, and from then on `tick()`
 * skips it, `admitRun` refuses it and every list hides it. Refused while a run is live -- an
 * archived project must have nothing in flight. A halt already in place is left alone.
 */
export async function archiveWorkspace(
  workspaceId: string,
  principal?: Principal,
): Promise<Result<{ readonly footprint: Footprint }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, archivedAt: true } })
    if (workspace === null) return { ok: false as const, error: { kind: 'workspace_not_found', workspaceId } as ControlRefusal }
    if (workspace.archivedAt !== null) return { ok: false as const, error: { kind: 'already_archived', workspaceId } as ControlRefusal }
    const runs = await liveRunCount(tx, { workspaceId })
    if (runs > 0) return { ok: false as const, error: { kind: 'live_runs', entity: 'workspace', id: workspaceId, runs } as ControlRefusal }
    const footprint = await projectFootprint(tx, workspaceId)
    await tx.workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date() } })
    return { ok: true as const, value: { name: workspace.name, footprint } }
  })
  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'workspace.archived',
    workspaceId,
    actor: 'human',
    payload: { name: outcome.value.name, ...outcome.value.footprint },
    userId: principal?.userId ?? null,
  })
  return ok({ footprint: outcome.value.footprint })
}

/** Undoes {@link archiveWorkspace}. A halt that predates the archive stays. */
export async function restoreWorkspace(
  workspaceId: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, archivedAt: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  if (workspace.archivedAt === null) return err({ kind: 'not_archived', workspaceId })
  await prisma.workspace.update({ where: { id: workspaceId }, data: { archivedAt: null } })
  await appendEvent({
    type: 'workspace.restored',
    workspaceId,
    actor: 'human',
    payload: { name: workspace.name },
    userId: principal?.userId ?? null,
  })
  return ok(undefined)
}
```

Check `appendEvent`'s input type (`AppendableEvent` in `packages/events/src/append.ts`) accepts the two new types — it is derived from the domain union, so it does once Step 3 lands.

- [ ] **Step 6: `admitRun`.** In `packages/control/src/budget.ts` widen the input and refuse first:

```ts
export function admitRun(input: {
  readonly workspace: { readonly id: string; readonly budgetUsd: number | null; readonly archivedAt: Date | null }
  readonly provider: ProviderKind
  readonly capabilities: Pick<ProviderCapabilities, 'reportsCost'>
}): { readonly ok: true } | { readonly ok: false; readonly refusal: ControlRefusal } {
  if (input.workspace.archivedAt !== null) return { ok: false, refusal: { kind: 'workspace_archived', workspaceId: input.workspace.id } }
  if (input.workspace.budgetUsd === null) return { ok: true }
  …
```

and `admitProvider(workspace: { id; budgetUsd; archivedAt }, provider)`. Then `npx tsc --build`: every caller that passes a literal `{ id, budgetUsd }` (tests, and possibly `org.ts`'s `assignCompany`/`setSlaveModel`, `tick.ts`, `review.ts`, `planning.ts`) must now pass `archivedAt` — callers that hold a Prisma `Workspace` row already have it; fix the literals by adding `archivedAt: workspace.archivedAt` (or `null` in tests). List every touched call site in the report.

- [ ] **Step 7: `tick` skip.** In `apps/orchestrator/src/tick.ts`, add `readonly skipped: 'archived' | null` to `TickReport`, add `skipped: null` to the two existing return objects, and at the top of `tick()` before `loadWorld`:

```ts
  // M27 §3.3: an archived project is invisible to the scheduler -- decided from one cheap read,
  // before the world is loaded, so nothing under it can be dispatched.
  const archived = await prisma.workspace.findUnique({ where: { id: deps.workspaceId }, select: { archivedAt: true } })
  if (archived?.archivedAt != null) {
    return { started: [], halted: null, skippedNoRole: 0, planningStarted: null, reviewsStarted: [], skipped: 'archived' }
  }
```

(`prisma` is already imported in `tick.ts`; if not, import `{ prisma } from '@slave-of-ai/db/client'`.)

- [ ] **Step 8: CLI.** In `apps/orchestrator/src/cli.ts`: `resolveWorkspace` filters the auto-pick — `prisma.workspace.findMany({ where: { archivedAt: null }, select: { id: true, name: true } })` (an explicit `--workspace` may still name an archived one; `tick` then reports `skipped`). Help text after `create-workspace`:

```
  archive-workspace --workspace <id>   archive a project: every row stays, nothing runs until
                                       restore-workspace. Refused while a run is live.
  restore-workspace --workspace <id>   bring an archived project back
  list-workspaces                      every project, archived ones marked
```

Cases (after `case 'create-workspace'`):

```ts
    case 'archive-workspace': {
      const workspaceId = requireFlag(flags, 'workspace')
      const result = await archiveWorkspace(workspaceId)
      if (!result.ok) throw new Error(refusalText(result.error))
      const f = result.value.footprint
      process.stdout.write(`project ${workspaceId} archived: ${f.departments} departments, ${f.slaves} slaves, ${f.tasks} tasks, ${f.runs} runs stay on record\n`)
      return 0
    }

    case 'restore-workspace': {
      const workspaceId = requireFlag(flags, 'workspace')
      const result = await restoreWorkspace(workspaceId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`project ${workspaceId} restored\n`)
      return 0
    }

    case 'list-workspaces': {
      const all = await prisma.workspace.findMany({ select: { id: true, name: true, archivedAt: true }, orderBy: { name: 'asc' } })
      for (const w of all) process.stdout.write(`${w.id}  ${w.name}${w.archivedAt === null ? '' : `  (archived ${w.archivedAt.toISOString()})`}\n`)
      return 0
    }
```

`status`: after the workspace line it prints, add `if (workspace.archivedAt !== null) process.stdout.write(\`archived: ${workspace.archivedAt.toISOString()}\n\`)`. Import the two verbs from `@slave-of-ai/control`.

- [ ] **Step 9: GREEN.** `npx tsc --build`; `npx vitest run packages/control/test/integration/archive.test.ts` (8 pass); `npx vitest run apps/orchestrator/test/integration/tick.test.ts`; the `admitRun` unit file if one exists; then `npx vitest run packages/control` (the whole package, one run) to catch the widened `admitRun` callers.

- [ ] **Step 10: Commit.**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260905150000_m27_archive_and_delete/migration.sql packages/db/src/enums.ts packages/domain/src/events/schema.ts packages/control/src/refusal.ts packages/control/src/workspace.ts packages/control/src/budget.ts packages/control/src/org.ts apps/orchestrator/src/tick.ts apps/orchestrator/src/cli.ts packages/control/test/integration/archive.test.ts apps/orchestrator/test/integration/tick.test.ts
git commit -m "feat(control): m27 t1 — archive and restore a project; the scheduler and admitRun skip an archived one"
```

(add any other file Step 6 made you touch.)

---

### Task 2: The delete verbs

**Files:**
- Modify: `packages/control/src/refusal.ts`, `packages/control/src/org.ts`, `apps/orchestrator/src/cli.ts`
- Create: `packages/control/test/integration/delete.test.ts`
- Test: also `packages/control/test/integration/org-edit.test.ts` and `departments.test.ts` (cases that assert the removed refusals change)

**Interfaces:**
- Consumes `liveRunCount` from Task 1.
- Produces: `deleteSlave` → `Result<{ readonly runs: number }, …>` (refuses `slave_not_found`, `live_runs`); `deleteTeam` → `Result<{ readonly slaves: number; readonly runs: number }, …>` (refuses `team_not_found`, `live_runs`); `deleteCompany(companyId, principal?)` → `Result<{ readonly templates: number; readonly catalogSlaves: number; readonly projectsDetached: number }, …>`; `deleteCompanyTeam` → `Result<{ readonly catalogSlaves: number }, …>` (refuses only `company_team_not_found`); `deleteCompanySlave(companySlaveId, principal?)` → `Result<void, …>` (refuses `company_slave_not_found`); `deleteSlaveTemplate(templateId, principal?)` → `Result<{ readonly catalogSlaves: number }, …>` (refuses `template_not_found`).
- Removes refusal kinds `slave_has_runs`, `team_not_empty`, `company_team_not_empty`; adds `company_slave_not_found { companySlaveId }`.
- CLI: `delete-company --company <id> --yes`, `delete-company-slave --slave <id> --yes`, `delete-template --template <id> --yes`; `delete-slave`/`delete-team`/`delete-company-team` without `--yes` print the footprint.

- [ ] **Step 1: Failing tests.** Create `packages/control/test/integration/delete.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deleteCompany, deleteCompanySlave, deleteCompanyTeam, deleteSlave, deleteSlaveTemplate, deleteTeam } from '../../src/org.js'

const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-delete-'))
afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

interface Fixture {
  readonly workspaceId: string
  readonly teamId: string
  readonly slaveId: string
  readonly otherSlaveId: string
  readonly taskId: string
  readonly companyId: string
  readonly templateId: string
  readonly companyTeamId: string
  readonly companySlaveId: string
}

/** A company with one template, one department template, one catalog slave; a project that has
 *  the company assigned, whose department copies the template and whose two slaves (one linked to
 *  the catalog slave, one hand-made) share a task with three finished runs. */
async function seed(): Promise<Fixture> {
  const template = await prisma.slaveTemplate.create({ data: { name: 'Backend Developer', role: 'backend', description: '' } })
  const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
  const companyTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Backend' } })
  const companySlave = await prisma.companySlave.create({ data: { companyTeamId: companyTeam.id, templateId: template.id, name: 'Sam' } })
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [], companyId: company.id },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Backend', companyTeamId: companyTeam.id } })
  const slave = await prisma.slave.create({ data: { teamId: team.id, name: 'Sam', role: 'backend', companySlaveId: companySlave.id } })
  const other = await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  const task = await prisma.task.create({
    data: { workspaceId: workspace.id, title: 'Add the thing', description: 'make it work', maxAttempts: 3 },
  })
  await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: slave.id, status: 'succeeded' } })
  await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: slave.id, status: 'failed' } })
  await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: other.id, status: 'succeeded' } })
  return {
    workspaceId: workspace.id, teamId: team.id, slaveId: slave.id, otherSlaveId: other.id, taskId: task.id,
    companyId: company.id, templateId: template.id, companyTeamId: companyTeam.id, companySlaveId: companySlave.id,
  }
}

async function orgChanged(workspaceId: string) {
  const rows = await prisma.executionEvent.findMany({ where: { workspaceId, type: 'org_changed' }, orderBy: { seq: 'asc' } })
  return rows.map((r) => r.payload as Record<string, unknown>)
}

let f: Fixture

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
  f = await seed()
})

describe('deleteSlave', () => {
  it('deletes a slave WITH its run history and says how many runs went', async () => {
    const result = await deleteSlave(f.slaveId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ runs: 2 })
    expect(await prisma.slave.findUnique({ where: { id: f.slaveId } })).toBeNull()
    expect(await prisma.slaveRun.count({ where: { slaveId: f.slaveId } })).toBe(0)
    expect(await prisma.slaveRun.count()).toBe(1)
    const events = await orgChanged(f.workspaceId)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ entity: 'slave', id: f.slaveId, field: 'deleted', from: 'Sam', to: null, runs: 2 })
  })

  it('refuses while the slave holds a live run', async () => {
    await prisma.slaveRun.create({ data: { taskId: f.taskId, slaveId: f.slaveId, status: 'working' } })
    const result = await deleteSlave(f.slaveId)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'live_runs', entity: 'slave', id: f.slaveId, runs: 1 })
    expect(await prisma.slave.findUnique({ where: { id: f.slaveId } })).not.toBeNull()
  })
})

describe('deleteTeam', () => {
  it('deletes a department with its slaves and their runs, and says the counts', async () => {
    const result = await deleteTeam(f.teamId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ slaves: 2, runs: 3 })
    expect(await prisma.team.findUnique({ where: { id: f.teamId } })).toBeNull()
    expect(await prisma.slave.count()).toBe(0)
    expect(await prisma.slaveRun.count()).toBe(0)
    expect(await prisma.task.count()).toBe(1) // tasks belong to the project, not the department
    const events = await orgChanged(f.workspaceId)
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ entity: 'team', id: f.teamId, field: 'deleted', from: 'Backend', to: null, slaves: 2, runs: 3 })
  })

  it('refuses while any slave of the department holds a live run', async () => {
    await prisma.slaveRun.create({ data: { taskId: f.taskId, slaveId: f.otherSlaveId, status: 'starting' } })
    const result = await deleteTeam(f.teamId)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'live_runs', entity: 'team', id: f.teamId, runs: 1 })
    expect(await prisma.slave.count()).toBe(2)
  })
})

describe('deleteCompanySlave', () => {
  it('deletes the catalog slave; the project copy survives with companySlaveId null; no event', async () => {
    const result = await deleteCompanySlave(f.companySlaveId)
    expect(result.ok).toBe(true)
    expect(await prisma.companySlave.findUnique({ where: { id: f.companySlaveId } })).toBeNull()
    const copy = await prisma.slave.findUniqueOrThrow({ where: { id: f.slaveId } })
    expect(copy.companySlaveId).toBeNull()
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('refuses an unknown catalog slave', async () => {
    const result = await deleteCompanySlave('00000000-0000-4000-8000-000000000000')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'company_slave_not_found', companySlaveId: '00000000-0000-4000-8000-000000000000' })
  })
})

describe('deleteCompanyTeam', () => {
  it('deletes a template WITH its catalog slaves; the project department survives unlinked', async () => {
    const result = await deleteCompanyTeam(f.companyTeamId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ catalogSlaves: 1 })
    expect(await prisma.companySlave.count()).toBe(0)
    const dept = await prisma.team.findUniqueOrThrow({ where: { id: f.teamId } })
    expect(dept.companyTeamId).toBeNull()
    expect(await prisma.slave.count()).toBe(2)
  })
})

describe('deleteSlaveTemplate', () => {
  it('deletes the template and its catalog slaves explicitly; project slaves keep their role', async () => {
    const result = await deleteSlaveTemplate(f.templateId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ catalogSlaves: 1 })
    expect(await prisma.slaveTemplate.findUnique({ where: { id: f.templateId } })).toBeNull()
    expect(await prisma.companySlave.count()).toBe(0)
    const copy = await prisma.slave.findUniqueOrThrow({ where: { id: f.slaveId } })
    expect(copy.role).toBe('backend')
  })

  it('refuses an unknown template', async () => {
    const result = await deleteSlaveTemplate('00000000-0000-4000-8000-000000000000')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'template_not_found', templateId: '00000000-0000-4000-8000-000000000000' })
  })
})

describe('deleteCompany', () => {
  it('deletes the company, its templates and catalog slaves; detaches the project; project rows survive', async () => {
    const result = await deleteCompany(f.companyId)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({ templates: 1, catalogSlaves: 1, projectsDetached: 1 })
    expect(await prisma.company.count()).toBe(0)
    expect(await prisma.companyTeam.count()).toBe(0)
    expect(await prisma.companySlave.count()).toBe(0)
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: f.workspaceId } })
    expect(ws.companyId).toBeNull()
    expect(await prisma.team.count()).toBe(1)
    expect(await prisma.slave.count()).toBe(2)
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('refuses an unknown company', async () => {
    const result = await deleteCompany('00000000-0000-4000-8000-000000000000')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'company_not_found', companyId: '00000000-0000-4000-8000-000000000000' })
  })
})
```

Then update the OLD expectations: in `packages/control/test/integration/org-edit.test.ts` the `deleteSlave` case "refuses a slave with run history" becomes "deletes a slave with terminal run history" (assert the runs are gone and `value.runs`), and the `deleteTeam` case "refuses a team that still has slaves" becomes "deletes the department with its slaves" (assert counts); in `departments.test.ts` the `deleteCompanyTeam` "refuses a template that still has a member" case becomes "deletes a template with its member" (assert `catalogSlaves: 1`). Keep every other case.

- [ ] **Step 2: RED.** `npx tsc --build` — missing exports.

- [ ] **Step 3: Refusal kinds.** In `refusal.ts` remove the three members `slave_has_runs`, `team_not_empty`, `company_team_not_empty` and their `refusalText` cases; add `| { readonly kind: 'company_slave_not_found'; readonly companySlaveId: string }` with `return \`no catalog slave with id ${refusal.companySlaveId}\``. `npx tsc --build` now points at every producer of the removed kinds (org.ts) and every consumer (cli.ts texts, the web's `SlaveRowActions` title — Task 4's) — fix the control/CLI ones here.

- [ ] **Step 4: The verbs.** In `packages/control/src/org.ts` (import `liveRunCount` from `./workspace.js`):

`deleteSlave` — replace the has-runs branch:

```ts
    const live = await liveRunCount(tx, { slaveId })
    if (live > 0) return { ok: false as const, error: { kind: 'live_runs', entity: 'slave', id: slaveId, runs: live } as ControlRefusal }
    const runs = slave.runs.length
    await tx.slave.delete({ where: { id: slaveId } })   // cascades SlaveRun (+Checkpoint), SlavePermission, SlaveSkill, SlaveMessage
    return { ok: true as const, value: { workspaceId: slave.team.workspaceId, from: slave.name, runs } }
```

the event payload gains `runs: outcome.value.runs`; the function returns `ok({ runs: outcome.value.runs })` and its signature `Promise<Result<{ readonly runs: number }, ControlRefusal>>`. Rewrite the docstring: "with its run history; refused only while a run is live (M27 §4.1)".

`deleteTeam` — replace the not-empty branch:

```ts
    const live = await liveRunCount(tx, { teamId })
    if (live > 0) return { ok: false as const, error: { kind: 'live_runs', entity: 'team', id: teamId, runs: live } as ControlRefusal }
    const slaves = team.slaves.length
    const runs = await tx.slaveRun.count({ where: { slave: { teamId } } })
    await tx.team.delete({ where: { id: teamId } })   // cascades Slave and everything under it
    return { ok: true as const, value: { workspaceId: team.workspaceId, from: team.name, slaves, runs } }
```

payload gains `slaves`, `runs`; returns `ok({ slaves, runs })`; signature `Result<{ readonly slaves: number; readonly runs: number }, …>`.

`deleteCompanyTeam` — drop the not-empty branch; read `_count.slaves` as `catalogSlaves`; delete (cascades `CompanySlave`); return `ok({ catalogSlaves })`; signature `Result<{ readonly catalogSlaves: number }, …>`; docstring: "with its catalog slaves; project departments copied from it survive (`SetNull`)".

New verbs, after `deleteCompanyTeam`:

```ts
/** Removes a catalog slave (M27 §5). The project slaves materialized from it survive with
 *  `companySlaveId` null (`SetNull`). No event: the catalog has no workspace. */
export async function deleteCompanySlave(
  companySlaveId: string,
  _principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const row = await prisma.companySlave.findUnique({ where: { id: companySlaveId }, select: { id: true } })
  if (row === null) return err({ kind: 'company_slave_not_found', companySlaveId })
  await prisma.companySlave.delete({ where: { id: companySlaveId } })
  return ok(undefined)
}

/**
 * Removes a slave template WITH the catalog slaves instantiated from it (M27 §5): the schema says
 * nothing about `CompanySlave.template` (Restrict), so the verb deletes them first, in the same
 * transaction behind a row lock. Project slaves keep the role that was copied at
 * materialization. No event.
 */
export async function deleteSlaveTemplate(
  templateId: string,
  _principal?: Principal,
): Promise<Result<{ readonly catalogSlaves: number }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "SlaveTemplate" WHERE id = ${templateId} FOR UPDATE`
    const row = await tx.slaveTemplate.findUnique({ where: { id: templateId }, select: { id: true } })
    if (row === null) return { ok: false as const, error: { kind: 'template_not_found', templateId } as ControlRefusal }
    const { count: catalogSlaves } = await tx.companySlave.deleteMany({ where: { templateId } })
    await tx.slaveTemplate.delete({ where: { id: templateId } })
    return { ok: true as const, value: { catalogSlaves } }
  })
  return outcome.ok ? ok(outcome.value) : err(outcome.error)
}

/**
 * Removes a company WITH its department templates and catalog slaves (the schema cascades both).
 * Projects that had the company assigned are detached first (`Workspace.companyId` has no rule)
 * and keep every department and slave they copied. No event.
 */
export async function deleteCompany(
  companyId: string,
  _principal?: Principal,
): Promise<Result<{ readonly templates: number; readonly catalogSlaves: number; readonly projectsDetached: number }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Company" WHERE id = ${companyId} FOR UPDATE`
    const row = await tx.company.findUnique({ where: { id: companyId }, select: { id: true, _count: { select: { teams: true } } } })
    if (row === null) return { ok: false as const, error: { kind: 'company_not_found', companyId } as ControlRefusal }
    const catalogSlaves = await tx.companySlave.count({ where: { companyTeam: { companyId } } })
    const { count: projectsDetached } = await tx.workspace.updateMany({ where: { companyId }, data: { companyId: null } })
    await tx.company.delete({ where: { id: companyId } })
    return { ok: true as const, value: { templates: row._count.teams, catalogSlaves, projectsDetached } }
  })
  return outcome.ok ? ok(outcome.value) : err(outcome.error)
}
```

(`Company.teams` is the relation name to `CompanyTeam` — confirm with `grep -n "teams" packages/db/prisma/schema.prisma` under `model Company`; adjust the `_count` key if it differs.)

- [ ] **Step 5: CLI.** In `apps/orchestrator/src/cli.ts`: `delete-slave`/`delete-team`/`delete-company-team` without `--yes` now print the footprint instead of the old texts — read the row and its counts (`prisma.slaveRun.count({ where: { slaveId } })`, `prisma.slave.count({ where: { teamId } })` + runs, `prisma.companySlave.count({ where: { companyTeamId } })`) and throw `refusing without --yes: this would delete slave Alex (…) and 14 runs` (same shape for the others). Add:

```
  delete-company --company <id> --yes  remove a company with its department templates and catalog
                                       slaves; projects keep their copies. Omit --yes to preview.
  delete-company-slave --slave <companySlaveId> --yes
                                       remove a catalog slave; project copies survive
  delete-template --template <id> --yes
                                       remove a slave template with the catalog slaves made from
                                       it; project slaves keep their role
```

with three `case`s in the `delete-team` shape (`--yes` gate → verb → `refusalText` on refusal → one line with the footprint on success). Update the help lines of `delete-slave`/`delete-team`/`delete-company-team` ("refused while … live run", not "has run history"/"still has").

- [ ] **Step 6: GREEN.** `npx tsc --build`; `npx vitest run packages/control/test/integration/delete.test.ts packages/control/test/integration/org-edit.test.ts packages/control/test/integration/departments.test.ts` (one run) → all pass; then `npx vitest run apps/orchestrator` (the CLI's integration test, if it drives `delete-slave`, sees the new text).

- [ ] **Step 7: Commit.**

```bash
git add packages/control/src/refusal.ts packages/control/src/org.ts apps/orchestrator/src/cli.ts packages/control/test/integration/delete.test.ts packages/control/test/integration/org-edit.test.ts packages/control/test/integration/departments.test.ts
git commit -m "feat(control): m27 t2 — delete a slave or department with its history, a company/template/catalog slave with what hangs off it; refused only while a run is live"
```

---

### Task 3: Reads and routes

**Files:**
- Modify: `apps/web/src/server/org.ts` (`listProjects`, `listWorkspaceNames`, `listProjectTeams`, `listAllSlaves`, `listWorkers`, `listRoster`, `ProjectRow`, `ProjectTeamRow`, `AllSlaveRow`, `RosterCompany`), `apps/web/src/server/workspaces.ts`, `apps/web/src/server/projectSettings.ts`, `apps/web/src/server/workspaceControlRoute.ts`
- Create: `apps/web/src/app/api/w/[workspaceId]/archive/route.ts`, `…/restore/route.ts`, `apps/web/src/app/api/org/companies/[companyId]/route.ts`, `apps/web/src/app/api/org/slaves/[companySlaveId]/route.ts`, `apps/web/src/app/api/org/templates/[templateId]/route.ts`
- Test: `apps/web/test/integration/archive-routes.test.ts`, `apps/web/test/integration/delete-routes.test.ts` (new), `apps/web/test/integration/all-slaves.test.ts`, `apps/web/test/integration/project-settings.test.ts` (one assertion each)

**Interfaces:**
- Produces: every list read takes `options?: { readonly includeArchived?: boolean }` (default excludes archived); `ProjectRow.archived: boolean`; `ProjectTeamRow.runCount: number`; `AllSlaveRow.runCount: number`; `RosterCompany.projectsUsing: number`; `ProjectSettings.workspace.archived: boolean` and `ProjectSettings.footprint: Footprint`; `workspaceArchived(workspaceId): Promise<boolean>` (`server/org.ts`).
- Routes: `POST /api/w/[workspaceId]/archive` → `archiveWorkspace` (200 `{ ok: true, footprint }`), `POST /api/w/[workspaceId]/restore` → `restoreWorkspace` (bypasses the archived guard), `DELETE /api/org/companies/[companyId]`, `DELETE /api/org/slaves/[companySlaveId]`, `DELETE /api/org/templates/[templateId]` (all `orgControlResponse`). `workspaceControlResponse` answers 409 `workspace_archived` for every write on an archived project.

- [ ] **Step 1: Failing tests.** `apps/web/test/integration/archive-routes.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as archive } from '../../src/app/api/w/[workspaceId]/archive/route.js'
import { POST as restore } from '../../src/app/api/w/[workspaceId]/restore/route.js'
import { POST as setGoalRoute } from '../../src/app/api/w/[workspaceId]/goal/route.js'
import { listProjects, listWorkspaceNames } from '../../src/server/org.js'
import { buildProjectSettings } from '../../src/server/projectSettings.js'

const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-web-archive-routes-'))
afterAll(async () => { rmSync(repoPath, { recursive: true, force: true }); await prisma.$disconnect() })

const req = (method: 'POST', body?: unknown): Request =>
  new Request('http://test/api', { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) })

let workspaceId = ''
beforeEach(async () => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "CompanySlave", "CompanyTeam", "Company", "SlaveTemplate" RESTART IDENTITY CASCADE')
  const ws = await prisma.workspace.create({ data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] } })
  await prisma.team.create({ data: { workspaceId: ws.id, name: 'Engineering' } })
  workspaceId = ws.id
})

describe('archive and restore routes', () => {
  it('archives, hides the project from the default lists, blocks writes, then restores', async () => {
    const archived = await archive(req('POST'), { params: Promise.resolve({ workspaceId }) })
    expect(archived.status).toBe(200)
    expect(((await archived.json()) as { footprint: { departments: number } }).footprint.departments).toBe(1)

    expect((await listProjects()).length).toBe(0)
    expect((await listProjects({ includeArchived: true }))[0]?.archived).toBe(true)
    expect((await listWorkspaceNames()).length).toBe(0)
    const settings = await buildProjectSettings(workspaceId)
    expect(settings?.workspace.archived).toBe(true)
    expect(settings?.footprint).toEqual({ departments: 1, slaves: 0, tasks: 0, runs: 0 })

    const write = await setGoalRoute(req('POST', { goal: 'Ship it' }), { params: Promise.resolve({ workspaceId }) })
    expect(write.status).toBe(409)
    expect(((await write.json()) as { error: string }).error).toContain('archived')

    const restored = await restore(req('POST'), { params: Promise.resolve({ workspaceId }) })
    expect(restored.status).toBe(200)
    expect((await listProjects()).length).toBe(1)
  })

  it('409s a second archive and a restore of a live project', async () => {
    expect((await restore(req('POST'), { params: Promise.resolve({ workspaceId }) })).status).toBe(409)
    await archive(req('POST'), { params: Promise.resolve({ workspaceId }) })
    expect((await archive(req('POST'), { params: Promise.resolve({ workspaceId }) })).status).toBe(409)
  })
})
```

`apps/web/test/integration/delete-routes.test.ts` — seed a company/template/department-template/catalog-slave (the Task 2 fixture shape, trimmed) and assert: `DELETE /api/org/slaves/[companySlaveId]` → 200 and the row is gone; `DELETE /api/org/templates/[templateId]` → 200 and its catalog slaves are gone; `DELETE /api/org/companies/[companyId]` → 200, company gone, the workspace's `companyId` null; each 409s (via `orgControlResponse`'s envelope) on an unknown id with the refusal text. In `all-slaves.test.ts` assert a project row's `runCount` equals the runs seeded for it and that an archived project's rows are absent unless `includeArchived`; in `project-settings.test.ts` assert `footprint` and `archived: false` on the seeded project.

- [ ] **Step 2: RED.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`.

- [ ] **Step 3: Reads.** In `apps/web/src/server/org.ts`:
  - Add a module-level helper `const notArchived = (includeArchived?: boolean) => (includeArchived === true ? {} : { archivedAt: null })` and use it in the `where` of `listProjects` (`prisma.workspace.findMany({ where: notArchived(options?.includeArchived), … })`), `listWorkspaceNames`, `listProjectTeams` (`where: { workspace: notArchived(...) }`), `listWorkers` (`where: { team: { workspace: notArchived(...) } }` on the slave query), `listAllSlaves` (passes its option through to `listWorkers`; catalog rows are never archived).
  - `ProjectRow` gains `archived: boolean` (`workspace.archivedAt !== null`); `ProjectTeamRow` gains `runCount` (one `slaveRun.groupBy`/count per team via `prisma.slaveRun.groupBy({ by: ['slaveId'] })` joined through the slaves' `teamId` — or a `_count` on a nested relation if Prisma allows `_count: { select: { slaves: true } }` plus a second grouped query for runs; either way one query, no per-row round trip); `AllSlaveRow` gains `runCount` (project rows: from the same `slaveRun.groupBy({ by: ['slaveId'], _count })`; catalog rows 0); the poll merge in `AllSlavesTable` leaves `runCount` as it was (a note in the row's docstring: refreshed on reload).
  - `RosterCompany` gains `projectsUsing` (`prisma.workspace.groupBy({ by: ['companyId'], _count })` once in `listRoster`).
  - `export async function workspaceArchived(workspaceId: string): Promise<boolean>` — `findUnique … select: { archivedAt: true }`.
  In `server/workspaces.ts`: `listWorkspaces(options?)` filters the same way. In `server/projectSettings.ts`: select `archivedAt` too, add `archived: workspace.archivedAt !== null` to the workspace block and `footprint: await projectFootprint(prisma, workspaceId)` (imported from `@slave-of-ai/control`) to the return; update the `ProjectSettings` interface.

- [ ] **Step 4: The archived guard.** `apps/web/src/server/workspaceControlRoute.ts`:

```ts
export async function workspaceControlResponse(
  workspaceId: string,
  operate: () => Promise<Result<unknown, ControlRefusal>>,
): Promise<Response> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, archivedAt: true } })
  if (workspace === null) return Response.json({ error: 'no such workspace' }, { status: 404 })
  // M27 §3.3: an archived project takes no writes; the restore route is the one exception and
  // does not go through this shell.
  if (workspace.archivedAt !== null) {
    return Response.json({ error: refusalText({ kind: 'workspace_archived', workspaceId }) }, { status: 409 })
  }
  const result = await operate()
  return result.ok ? Response.json({ ok: true }) : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
```

- [ ] **Step 5: Routes.** `archive/route.ts` (through `workspaceControlResponse`? — it must answer the footprint, so build the envelope inline like `POST /api/w/[workspaceId]/teams` does, but keep the 404 + archived guard by calling the verb and mapping):

```ts
import { archiveWorkspace, refusalText } from '@slave-of-ai/control'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

/** The project Settings tab's "archive project" (M27 §3.4). Answers the footprint so the page can
 *  say what stayed on record. */
export async function POST(_request: Request, context: { params: Promise<{ workspaceId: string }> }): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const result = await archiveWorkspace(workspaceId, gate.principal ?? undefined)
  if (result.ok) return Response.json({ ok: true, footprint: result.value.footprint })
  const status = result.error.kind === 'workspace_not_found' ? 404 : 409
  return Response.json({ error: refusalText(result.error) }, { status })
}
```

`restore/route.ts` — same shape with `restoreWorkspace`, answering `{ ok: true }`. The three `DELETE` org routes follow `apps/web/src/app/api/org/teams/[companyTeamId]/route.ts` verbatim with their verb (`deleteCompany`, `deleteCompanySlave`, `deleteSlaveTemplate`) and docstrings naming their UI caller (§5.1). Import depth: count from the file (Task 2 of M25 found the brief's counts off by one).

- [ ] **Step 6: GREEN + build.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/integration/archive-routes.test.ts apps/web/test/integration/delete-routes.test.ts apps/web/test/integration/all-slaves.test.ts apps/web/test/integration/project-settings.test.ts`; then `npx vitest run apps/web` (the whole web project — the widened DTOs touch many fixtures: add `archived: false`, `runCount: 0`, `projectsUsing: 0`, `footprint`, `archived` where tsc demands); `pgrep -fa 'next dev'` empty, `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 7: Commit.** `git add` the server files, the five routes, the tests you touched; `git commit -m "feat(web): m27 t3 — archive/restore and the three catalog delete routes; every list hides an archived project; counts ride the rows"`.

---

### Task 4: `DangerConfirm`, the Slaves table and the Departments tab

**Files:**
- Create: `apps/web/src/components/ui/DangerConfirm.tsx`, `apps/web/test/danger-confirm.test.tsx`
- Modify: `apps/web/src/components/SlaveRowActions.tsx`, `apps/web/src/components/AllSlavesTable.tsx`, `apps/web/src/components/DepartmentsTable.tsx`
- Test: `apps/web/test/slave-row-actions.test.tsx`, `apps/web/test/all-slaves-table.test.tsx`, `apps/web/test/departments-table.test.tsx`

**Interfaces:**
- Produces `DangerConfirm({ label, testId, confirmText, disabled?, onConfirm, className? })`: renders `<PrimaryButton tone="blocked" data-testid={testId}>{label}</PrimaryButton>`; on click, `[<PrimaryButton tone="blocked" data-testid={`${testId}-confirm`}>{confirmText}</PrimaryButton>] [<button data-testid={`${testId}-cancel`}>cancel</button>]`; `onConfirm(): Promise<string | null>` — a returned string is the refusal, rendered in `role="alert"` `data-testid={`${testId}-error`}`; `null` closes the confirm; `pending` disables both; Escape cancels.
- `SlaveRowActions` gains `runCount: number` and `catalog?: { companySlaveId: string }` props (a catalog row renders only the delete); `DepartmentsTable` rows read `team.runCount`.

- [ ] **Step 1: Failing tests.** `apps/web/test/danger-confirm.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DangerConfirm } from '../src/components/ui/DangerConfirm.js'

describe('DangerConfirm', () => {
  it('asks twice: the trigger reveals the confirm text and a cancel; cancel calls nothing', () => {
    const onConfirm = vi.fn(async () => null)
    render(<DangerConfirm label="delete" testId="x" confirmText="deletes Alex and 14 runs" onConfirm={onConfirm} />)
    expect(screen.queryByTestId('x-confirm')).toBeNull()
    fireEvent.click(screen.getByTestId('x'))
    expect(screen.getByTestId('x-confirm').textContent).toBe('deletes Alex and 14 runs')
    fireEvent.click(screen.getByTestId('x-cancel'))
    expect(screen.queryByTestId('x-confirm')).toBeNull()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('calls onConfirm on the second click and closes on null', async () => {
    const onConfirm = vi.fn(async () => null)
    render(<DangerConfirm label="delete" testId="x" confirmText="deletes it" onConfirm={onConfirm} />)
    fireEvent.click(screen.getByTestId('x'))
    await act(async () => { fireEvent.click(screen.getByTestId('x-confirm')) })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('x-confirm')).toBeNull()
  })

  it('shows a refusal and stays open', async () => {
    const onConfirm = vi.fn(async () => 'slave a1 has 1 live run(s)')
    render(<DangerConfirm label="delete" testId="x" confirmText="deletes it" onConfirm={onConfirm} />)
    fireEvent.click(screen.getByTestId('x'))
    await act(async () => { fireEvent.click(screen.getByTestId('x-confirm')) })
    expect(screen.getByTestId('x-error').textContent).toContain('live run')
    expect(screen.getByTestId('x-confirm')).toBeTruthy()
  })

  it('cancels on Escape and respects disabled', () => {
    render(<DangerConfirm label="delete" testId="x" confirmText="deletes it" onConfirm={async () => null} disabled />)
    expect((screen.getByTestId('x') as HTMLButtonElement).disabled).toBe(true)
  })
})
```

In `slave-row-actions.test.tsx`: the "shows a refusal on a blocked delete" case now mocks a 409 `live_runs` text and asserts `slave-delete-error`; the two-step case asserts the confirm text `deletes Alex and 14 runs of history` when rendered with `runCount={14}`; add "a catalog row deletes through /api/org/slaves/:id" (`catalog={{ companySlaveId: 'cs1' }}` → DELETE `/api/org/slaves/cs1`, confirm text `deletes Sam from the catalog; project copies stay`). In `all-slaves-table.test.tsx`: a catalog row renders `catalog-slave-delete` (not `slave-delete`); the fixture gains `runCount`. In `departments-table.test.tsx`: the delete is enabled with `slaveCount: 4`, confirm text `deletes Engineering: 4 slaves, 31 runs` (fixture `runCount: 31`), and the old "disabled while it has slaves" case is replaced by that.

- [ ] **Step 2: RED.** `npx vitest run apps/web/test/danger-confirm.test.tsx` → module not found.

- [ ] **Step 3: The component.** `apps/web/src/components/ui/DangerConfirm.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { PrimaryButton } from './FormControls'

/**
 * The two-click destructive action every M27 surface uses (spec §6). The caller composes
 * `confirmText` from server counts ("deletes Alex and 14 runs of history") -- this component
 * counts nothing. `onConfirm` resolves to a refusal string (shown in `${testId}-error`, the confirm
 * stays open) or `null` (done; the caller has refreshed or navigated).
 */
export function DangerConfirm({
  label,
  testId,
  confirmText,
  disabled = false,
  onConfirm,
  className = '',
}: {
  readonly label: string
  readonly testId: string
  readonly confirmText: string
  readonly disabled?: boolean
  readonly onConfirm: () => Promise<string | null>
  readonly className?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !pending) {
        setOpen(false)
        setErrorText(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, pending])

  const confirm = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const refusal = await onConfirm()
    setPending(false)
    if (refusal === null) setOpen(false)
    else setErrorText(refusal)
  }

  if (!open) {
    return (
      <PrimaryButton tone="blocked" data-testid={testId} disabled={disabled} onClick={() => setOpen(true)} className={className}>
        {label}
      </PrimaryButton>
    )
  }
  return (
    <span className={`flex flex-wrap items-center gap-2 ${className}`.trim()}>
      <PrimaryButton tone="blocked" data-testid={`${testId}-confirm`} disabled={pending} onClick={() => void confirm()}>
        {pending ? 'working…' : confirmText}
      </PrimaryButton>
      <button type="button" data-testid={`${testId}-cancel`} disabled={pending} onClick={() => { setOpen(false); setErrorText(null) }} className="text-xs text-text-3">
        cancel
      </button>
      {errorText !== null && (
        <span role="alert" data-testid={`${testId}-error`} className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}
    </span>
  )
}
```

- [ ] **Step 4: Call sites.** `SlaveRowActions`: replace the `confirmingDelete` block with `<DangerConfirm label="delete" testId="slave-delete" confirmText={`deletes ${name} and ${runCount} runs of history`} onConfirm={async () => { const error = await sendControl(`/api/slaves/${slaveId}`, { method: 'DELETE' }); if (error === null) router.refresh(); return error }} />`; drop the has-history `title`/disabled treatment; for `catalog` rows render only `<DangerConfirm label="delete" testId="catalog-slave-delete" confirmText={`deletes ${name} from the catalog; project copies stay`} onConfirm={… DELETE /api/org/slaves/${catalog.companySlaveId} …} />`. `AllSlavesTable`: pass `runCount={row.runCount}` on project rows and render `<SlaveRowActions … catalog={{ companySlaveId }} />` on catalog rows (they had no actions before). `DepartmentsTable`: replace its block with `<DangerConfirm label="delete" testId="department-delete" confirmText={`deletes ${team.name}: ${team.slaveCount} slaves, ${team.runCount} runs`} onConfirm={…}/>` (always enabled). Delete the now-unused `confirmingDelete` state and the old testids `*-delete-confirm`/`-cancel` keep their names through the component (they do: `${testId}-confirm`).

- [ ] **Step 5: Verify + commit.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/danger-confirm.test.tsx apps/web/test/slave-row-actions.test.tsx apps/web/test/all-slaves-table.test.tsx apps/web/test/departments-table.test.tsx`; `npm run web:build && rm -rf apps/web/.next`; `git add` the five files + tests; `git commit -m "feat(web): m27 t4 — DangerConfirm; a slave or department deletes with its counts in the question; catalog rows can go too"`.

---

### Task 5: Project archive — Settings danger zone, header chip, Projects page

**Files:**
- Modify: `apps/web/src/components/project/ProjectSettingsClient.tsx`, `apps/web/src/components/project/ProjectHeader.tsx`, `apps/web/src/app/w/[workspaceId]/layout.tsx`, `apps/web/src/components/ProjectsClient.tsx`, `apps/web/src/app/page.tsx`
- Test: `apps/web/test/project-settings.test.tsx`, `apps/web/test/project-header.test.tsx`, `apps/web/test/project-layout.test.tsx`, `apps/web/test/projects-page.test.tsx`

**Interfaces:**
- Consumes `ProjectSettings.workspace.archived`, `ProjectSettings.footprint`, `ProjectRow.archived`, `workspaceArchived()`, `listProjects({ includeArchived })`, the two routes.
- Produces: `ProjectHeader` gains `archived: boolean` (the layout passes `await workspaceArchived(workspaceId)`); testids `project-archived` (chip), `archive-project` (+ `-confirm`/`-cancel`/`-error`), `restore-project`, `show-archived` (checkbox), `restore-project` on an archived card.

- [ ] **Step 1: Failing tests.**
  - `project-settings.test.tsx`: with the default fixture (`archived: false`, `footprint: { departments: 3, slaves: 9, tasks: 12, runs: 41 }`), `archive-project` opens a confirm whose text is `archives Checkout Platform: 3 departments, 9 slaves, 12 tasks, 41 runs stay on record; nothing runs until you restore it`; confirming POSTs `/api/w/w1/archive` and calls `router.push('/')` (mock `useRouter` → `{ refresh, push }`); with `archived: true` the danger zone shows `restore-project` (no confirm) which POSTs `/api/w/w1/restore` then `refresh`, and the emergency stop is hidden.
  - `project-header.test.tsx`: `archived` renders `project-archived` with text `archived` and no `emergency-stop`.
  - `project-layout.test.tsx`: mock `workspaceArchived` → true and assert `ProjectHeader` receives `archived` (render and look for `project-archived`).
  - `projects-page.test.tsx`: `show-archived` unchecked by default and archived cards absent when `search=''`; with `search='archived=1'` the checkbox is checked and an archived card renders the `archived` chip (`project-archived`) and `restore-project`; toggling calls `router.replace('/?archived=1')` / `router.replace('/')`; clicking `restore-project` POSTs `/api/w/w1/restore` and refreshes.

- [ ] **Step 2: RED**, then **Step 3: implement.**
  - `ProjectSettingsClient`: the danger zone becomes two rows: the existing stop (hidden when `workspace.archived`), and `{workspace.archived ? <PrimaryButton data-testid="restore-project" onClick={restore}>restore project</PrimaryButton> : <DangerConfirm label="archive project" testId="archive-project" confirmText={`archives ${workspace.name}: ${f.departments} departments, ${f.slaves} slaves, ${f.tasks} tasks, ${f.runs} runs stay on record; nothing runs until you restore it`} onConfirm={async () => { const error = await sendControl(`/api/w/${workspace.id}/archive`, { method: 'POST' }); if (error === null) router.push('/'); return error }} />}`; `restore` = `sendControl(…/restore, POST)` → `router.refresh()`; a refusal shows in `restore-project-error`. An archived project's other panels stay rendered (read-only feel comes from the server's 409 on writes — the forms show the refusal text).
  - `ProjectHeader`: prop `archived: boolean`; when true render `<span data-testid="project-archived" className="rounded-pill border border-line px-[9px] py-[3px] text-[10px] text-text-faint">archived</span>` after the name and skip the `EmergencyStopButton`.
  - Layout: `const [facts, workspaces, archived] = await Promise.all([buildShellFacts(workspaceId), listWorkspaceNames(), workspaceArchived(workspaceId)])`; pass `archived`.
  - `ProjectsClient`: read `searchParams.get('archived') === '1'` as `showArchived`; render `<label><input type="checkbox" data-testid="show-archived" checked={showArchived} onChange={(e) => router.replace(e.target.checked ? '/?archived=1' : '/')} /> show archived</label>` in the header row; the page (`app/page.tsx`) reads the same param via its `searchParams` prop (`{ searchParams }: { searchParams: Promise<{ archived?: string }> }`) and calls `listProjects({ includeArchived: archived === '1' })`; an archived `ProjectCard` renders the chip, no spend bar, no assign-company control, and `<PrimaryButton data-testid="restore-project" …>restore</PrimaryButton>` posting `/api/w/${id}/restore` then `router.refresh()`.

- [ ] **Step 4: Verify + commit.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/project-settings.test.tsx apps/web/test/project-header.test.tsx apps/web/test/project-layout.test.tsx apps/web/test/projects-page.test.tsx`; `npm run web:build && rm -rf apps/web/.next`; commit `"feat(web): m27 t5 — archive a project from its Settings tab, see the chip in the header, find and restore it from Projects"`.

---

### Task 6: Catalog deletes in the UI

**Files:**
- Modify: `apps/web/src/components/CompanyManager.tsx`, `apps/web/src/components/company/TeamBlock.tsx`, `apps/web/src/components/TemplateCatalog.tsx`
- Test: `apps/web/test/settings-page.test.tsx` (the `CompanyManager` and `TemplateCatalog` describes)

**Interfaces:**
- Consumes `DangerConfirm`, `RosterCompany.projectsUsing`, the three `DELETE` org routes (Task 3), `DELETE /api/org/teams/[companyTeamId]` (its refusal set changed in Task 2).
- Produces testids: `company-delete`, `department-template-delete` (always enabled), `catalog-slave-delete` (in `MemberRow`), `template-delete` (in `TemplateCatalog` rows), each with `-confirm`/`-cancel`/`-error`.

- [ ] **Step 1: Failing tests** (in `settings-page.test.tsx`, next to the existing `CompanyManager`/`TemplateCatalog` cases; read the roster fixture and extend it with `projectsUsing: 1` and a second, empty template):
  - company row: `company-delete` → confirm text `deletes Atlas Software: 2 department templates, 3 catalog slaves; 1 project keeps its copies` → DELETE `/api/org/companies/c1` → refresh.
  - department template: `department-template-delete` enabled with members; confirm `deletes Backend and its 2 catalog slaves; project departments stay` → DELETE `/api/org/teams/ct1`.
  - catalog slave row: `catalog-slave-delete` → confirm `deletes Sam from the catalog; project copies stay` → DELETE `/api/org/slaves/cs1`.
  - slave template row: `template-delete` → confirm `deletes Backend Developer and its 3 catalog slaves; project slaves keep their role` → DELETE `/api/org/templates/tpl1`; the count comes from `TemplateRow.catalogSlaveCount` — add that field in `listTemplates` (one `companySlave.groupBy({ by: ['templateId'] })`) as part of this task (the read is tiny and only this row needs it).

- [ ] **Step 2: RED**, **Step 3: implement** each with `DangerConfirm` and `sendControl(url, { method: 'DELETE' })` → `router.refresh()`; `MemberRow` gains an actions cell (widen `MEMBER_COLUMNS` by one `120px` track and `MEMBER_HEADER` by `''`); `TemplateCatalog`'s `COLUMNS` likewise; `TeamBlock`'s delete drops its `disabled`/`title`; `CompanyManager`'s row gets the delete beside the toggle. Docstrings updated.

- [ ] **Step 4: Verify + commit.** tsc; `npx vitest run apps/web/test/settings-page.test.tsx apps/web/test/projects-page.test.tsx`; build; commit `"feat(web): m27 t6 — the catalog deletes: company, department template, catalog slave, slave template, each asking twice with its counts"`.

---

### Task 7: Gates, README, Errata, closing run

**Files:**
- Modify: `scripts/gate-m11-shell.mjs` (stage 6), `README.md` (Web UI table + the CLI cheat sheet), the spec's §13; `docs/superpowers/fidelity/m14/*.png` only if m14 fails on the Slaves table's new column width (Task 4 widened nothing on the Slaves table; the catalog tables changed, which m14 does not measure — expect no PNG change)

- [ ] **Step 1: m11 stage 6.** After stage 5 (the department move), on `/slaves`: delete the moved slave through `slave-delete` → `slave-delete-confirm` and assert `prisma.slave.findUnique` is null and its runs are gone; on the Departments tab delete the second department (`department-delete` → confirm) and assert the row is gone; on `/` with `?archived=1` absent, archive project A through `/w/<id>/settings` (`archive-project` → confirm → lands on `/`), assert `prisma.workspace.archivedAt` set and the card absent, toggle `show-archived`, assert the card + `project-archived`, click `restore-project`, assert `archivedAt` null. Run `CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome npm run gate:m11-shell` → PASS.
- [ ] **Step 2: README.** Web UI table: the project Settings row gains "archive/restore the project"; the Projects row gains "show archived"; the Slaves row says "delete a slave with its history"; the catalog sentence says every catalog row can be deleted. CLI cheat sheet: the new verbs and the `--yes` preview rule.
- [ ] **Step 3: §13 Errata** — every controller ruling in the ledger, plus: the archived chip is asserted by m11 (not m14, to keep the fidelity PNGs stable); `TemplateRow.catalogSlaveCount` was added in Task 6 (§7 did not list it); anything else that diverged.
- [ ] **Step 4: Closing run.** `npm run typecheck`; `npm test` (600 s); `npm run web:build && rm -rf apps/web/.next`; `npm run gate:m26-vocabulary`; the eight gates in order (`m15-boundary`, `m20-auth`, `m21-loose-ends`, `m23-onboarding`, `m14-fidelity`, `m16-chrome`, `m11-shell`, `m18-skill-and-teeth`) with `SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh"` and `CHROMIUM_PATH` as above, none overlapping. Record every PASS line.
- [ ] **Step 5: Commit.** `git add scripts/gate-m11-shell.mjs README.md docs/superpowers/specs/2026-09-05-m27-archive-and-delete-design.md` (+ PNGs only if regenerated); `git commit -m "test(gates),docs: m27 t7 — m11 deletes and archives; README and errata"`.

## Closing verification (after Task 7, before the final review)

- Everything in Task 7 Step 4 green at HEAD.
- Final whole-branch review (most capable model) with the lens "every destructive path refuses on a live run, asks twice with real counts, and cascades exactly what the spec says"; one fix wave, one scoped re-review; then merge fast-forward, push (pre-push hook: 600 s), update the memory backlog line, delete the plan's workspace.

## Self-review against the spec

- §2 principles → T1 (`live_runs`, events), T2 (deletes), T4–T6 (confirms with counts). §3 archive → T1 (schema, verbs, tick, admitRun, CLI), T3 (reads, routes, guard), T5 (UI). §4 → T2 (verbs), T4 (UI). §5 → T2 (verbs), T3 (routes), T6 (UI). §6 → T4 (`DangerConfirm`). §7 reads → T3 (+ `catalogSlaveCount` in T6). §8 edge cases → T1 (halt stays; admitRun), T2 (live run inside the tx), T3 (guard), T5 (restore reappears). §9 tests → per task; gates → T7. §10 constraints → header. §11 order → T1…T7. §12 out of scope untouched.
- Types: `Footprint`/`projectFootprint`/`liveRunCount` (T1) ↔ T2's verbs ↔ T3's `ProjectSettings.footprint`; the verbs' `value` shapes (T2) ↔ the CLI footprints (T2) ↔ the routes (T3); `DangerConfirm`'s `onConfirm(): Promise<string | null>` (T4) ↔ every call site's `sendControl` return (`string | null`).
- Placeholders: none — each verb, migration, component and test is written out; "read X and mirror" names an existing file every time.
