# M25 Departments, Agents and Models — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator create departments, move agents between them, create a catalog agent from the Agents page and land it in a project, and pick a model from a list the provider's own CLI reports — without a schema change.

**Architecture:** Departments are the existing `Team` (project) and `CompanyTeam` (catalog) rows; five new control verbs in `packages/control/src/org.ts` (create-in-project, move agent, move catalog agent, rename/delete template) get routes, CLI verbs and a `<select>` in the Agents table. Model discovery lives in `packages/providers/src/models.ts` (a pure parser for `cursor-agent models`, a static Claude list, one `listProviderModels(kind)` function the two adapters delegate to), is re-exported through `@ai-team-os/control` (the web never imports the providers package), cached five minutes in `apps/web/src/server/models.ts`, served by `GET /api/providers/[kind]/models`, and rendered by one `ModelSelect` component that replaces three free-text inputs. "New agent" is a drawer on the Agents page that calls the existing `POST /api/org/agents` then, optionally, `POST /api/w/:id/company`.

**Tech Stack:** Next.js 15 App Router, React 19, Prisma 7 (read/write, no migration), Vitest 3 (`unit` and `integration` projects; integration runs single-threaded against the shared test DB), Testing Library, `node:child_process` `execFile` for the CLI probe.

**Spec:** `docs/superpowers/specs/2026-09-04-m25-departments-agents-and-models-design.md` — read §2–§6 before any task; §-numbers below refer to it.

## Global Constraints

- Branch: `feature/m25-departments` (holds the spec commit 26c6c21). Every task commits there.
- No migration, no schema change, no new npm dependency; the Prisma `ProviderKind` and `EventType` enums are unchanged (spec §9).
- `apps/web` never imports `@ai-team-os/providers`; anything it needs is re-exported from `@ai-team-os/control` (`packages/control/src/index.ts`, the M12 R10 rule). It never constructs an adapter.
- Every web verb has a CLI verb. Project-level verbs (`createProjectTeam`, `moveAgent`) write exactly one `org.changed` event with the M23 payload `{ entity, id, field, from, to }` and `userId: principal?.userId ?? null`; catalog-level verbs (`moveCompanyAgent`, `renameCompanyTeam`, `deleteCompanyTeam`) write no event (spec §3.1).
- Refusals are typed `kind`s on `ControlRefusal` (`packages/control/src/refusal.ts`) with a `refusalText` case each; routes map them to 409 through `orgControlResponse` (`apps/web/src/server/orgControlRoute.ts`).
- Vocabulary (spec §2): every user-facing string, testid and aria-label that names a `Team`/`CompanyTeam` row says **department** (project) / **department template** (catalog). Identifiers the CLI documents keep their names (`rename-team`, `delete-team`, `teamId`, `companyTeamId`). Testids are exact as written in each task.
- Standing rules: ONE vitest run at a time; no orchestrator daemon during tests; root `tsc --build` does NOT cover `apps/web` tests — run `npx tsc -p apps/web/tsconfig.test.json --noEmit` for those; every web task gates on `npm run web:build` before commit, NEVER while a `next dev` runs (`pgrep -fa 'next dev'` first), and runs `rm -rf apps/web/.next` after; `git add` explicit paths only; comments change in the same commit as the behaviour they describe.
- Integration tests (`**/test/integration/**`) use the Postgres at `TEST_DATABASE_URL` (:5433); each file TRUNCATEs what it touches in `beforeEach` — the org tables are `"ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate"`.
- Commit trailers on every commit:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01UwnbBiQX5Gdm5VKtFvEr9J`.

## File structure

Create:
- `packages/providers/src/models.ts` — `ModelOption`, `ModelListing`, `parseCursorModels`, `CLAUDE_CODE_MODELS`, `listCursorModels`, `listClaudeCodeModels`, `listProviderModels`.
- `packages/providers/test/models.test.ts`, `packages/providers/test/fixtures/cursor/models.txt`.
- `packages/control/test/integration/departments.test.ts` — the five verbs.
- `apps/web/src/server/models.ts` — the five-minute cache over `listProviderModels`.
- `apps/web/src/app/api/providers/[kind]/models/route.ts`.
- `apps/web/src/app/api/w/[workspaceId]/teams/route.ts`, `apps/web/src/app/api/agents/[agentId]/team/route.ts`, `apps/web/src/app/api/org/agents/[companyAgentId]/team/route.ts`, `apps/web/src/app/api/org/teams/[companyTeamId]/name/route.ts`, `apps/web/src/app/api/org/teams/[companyTeamId]/route.ts`.
- `apps/web/src/components/ModelSelect.tsx`, `apps/web/src/components/agents/NewAgentDrawer.tsx`, `apps/web/src/components/DepartmentsTable.tsx` (renamed from `TeamsTable.tsx`).
- Tests: `apps/web/test/integration/department-routes.test.ts`, `apps/web/test/integration/models-route.test.ts`, `apps/web/test/server-models.test.ts`, `apps/web/test/model-select.test.tsx`, `apps/web/test/departments-table.test.tsx` (renamed from `teams-table.test.tsx`), `apps/web/test/new-agent-drawer.test.tsx`.

Modify: `packages/control/src/refusal.ts`, `packages/control/src/org.ts`, `packages/control/src/index.ts`, `apps/orchestrator/src/cli.ts`, `packages/providers/src/index.ts`, `packages/providers/src/claude/adapter.ts` (interface + method), `packages/providers/src/cursor/adapter.ts` (method), the six test fakes that implement the adapter (Task 3 lists them), `apps/web/src/server/org.ts` (`WorkerRow.teamId`, `AllAgentRow`, `listAllAgents`), `AllAgentsTable.tsx`, `AgentsClient.tsx`, `app/agents/page.tsx`, `company/CompanyDetail.tsx`, `company/TeamBlock.tsx`, `TemplateCatalog.tsx`, `ModelOverrideEditor.tsx`, `scripts/gate-m11-shell.mjs`, `scripts/gate-m14-fidelity.mjs`, `README.md`, the spec's §12, and the tests named per task.

Delete: nothing (`TeamsTable.tsx` and its test are renamed with `git mv`).

---

### Task 1: The five control verbs and their CLI

**Files:**
- Modify: `packages/control/src/refusal.ts`, `packages/control/src/org.ts` (append after `deleteTeam`), `apps/orchestrator/src/cli.ts` (help text after the `delete-team` line ~90; cases after `case 'delete-team'` ~677; the import list at lines 4–29)
- Test: `packages/control/test/integration/departments.test.ts` (new)

**Interfaces:**
- Produces (all exported from `packages/control/src/org.ts`, reachable as `@ai-team-os/control` because `index.ts` already does `export * from './org.js'` — verify with `grep -n "org.js" packages/control/src/index.ts`; if it does not, add `export * from './org.js'`):
  - `createProjectTeam(workspaceId: string, name: string, principal?: Principal): Promise<Result<{ readonly id: string }, ControlRefusal>>`
  - `moveAgent(agentId: string, teamId: string, principal?: Principal): Promise<Result<void, ControlRefusal>>`
  - `moveCompanyAgent(companyAgentId: string, companyTeamId: string, principal?: Principal): Promise<Result<void, ControlRefusal>>`
  - `renameCompanyTeam(companyTeamId: string, name: string, principal?: Principal): Promise<Result<void, ControlRefusal>>`
  - `deleteCompanyTeam(companyTeamId: string, principal?: Principal): Promise<Result<void, ControlRefusal>>`
- Produces three refusal kinds: `team_workspace_mismatch { agentId, teamId }`, `company_mismatch { companyAgentId, companyTeamId }`, `company_team_not_empty { companyTeamId, agents }`. (The spec's §3.1 wrote `team_not_empty` for the template case; that kind carries a `teamId` and the text "team", so the template case gets its own kind — Task 9 records this in §12.)

- [ ] **Step 1: Failing tests.** Create `packages/control/test/integration/departments.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createProjectTeam,
  deleteCompanyTeam,
  moveAgent,
  moveCompanyAgent,
  renameCompanyTeam,
} from '../../src/org.js'

// A real directory (M23 G3): a placeholder repo path fails runFilePaths' statSync preflight.
const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-control-departments-'))
afterAll(() => rmSync(repoPath, { recursive: true, force: true }))

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

interface Fixture {
  readonly workspaceId: string
  readonly otherWorkspaceId: string
  readonly engineeringId: string
  readonly qaId: string
  readonly otherTeamId: string
  readonly agentId: string
  readonly companyId: string
  readonly otherCompanyId: string
  readonly templateId: string
  readonly backendTemplateTeamId: string
  readonly emptyTemplateTeamId: string
  readonly otherCompanyTeamId: string
  readonly companyAgentId: string
}

/** Two workspaces (one with two departments and one agent), two companies (one with a
 *  department template holding one catalog agent and an empty template), one agent template. */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  const other = await prisma.workspace.create({
    data: { name: 'Billing', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  const engineering = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const qa = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'QA' } })
  const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: engineering.id, name: 'Alex', role: 'backend' } })
  const template = await prisma.agentTemplate.create({
    data: { name: 'Backend Developer', role: 'backend', description: 'ships services' },
  })
  const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
  const otherCompany = await prisma.company.create({ data: { name: 'hhg' } })
  const backendTemplateTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Backend' } })
  const emptyTemplateTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Design' } })
  const otherCompanyTeam = await prisma.companyTeam.create({ data: { companyId: otherCompany.id, name: 'Backend' } })
  const companyAgent = await prisma.companyAgent.create({
    data: { companyTeamId: backendTemplateTeam.id, templateId: template.id, name: 'Sam' },
  })
  return {
    workspaceId: workspace.id,
    otherWorkspaceId: other.id,
    engineeringId: engineering.id,
    qaId: qa.id,
    otherTeamId: otherTeam.id,
    agentId: agent.id,
    companyId: company.id,
    otherCompanyId: otherCompany.id,
    templateId: template.id,
    backendTemplateTeamId: backendTemplateTeam.id,
    emptyTemplateTeamId: emptyTemplateTeam.id,
    otherCompanyTeamId: otherCompanyTeam.id,
    companyAgentId: companyAgent.id,
  }
}

async function orgChangedEvents(workspaceId: string): Promise<
  readonly { readonly agentId: string | null; readonly payload: Record<string, unknown> }[]
> {
  const rows = await prisma.executionEvent.findMany({
    where: { workspaceId, type: 'org_changed' },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((row) => ({ agentId: row.agentId, payload: row.payload as Record<string, unknown> }))
}

let fixture: Fixture

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
  )
  fixture = await seed()
})

describe('createProjectTeam', () => {
  it('creates a department with no template link and emits one org.changed event', async () => {
    const result = await createProjectTeam(fixture.workspaceId, 'Design')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.team.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row).toMatchObject({ workspaceId: fixture.workspaceId, name: 'Design', companyTeamId: null })

    const events = await orgChangedEvents(fixture.workspaceId)
    expect(events).toHaveLength(1)
    expect(events[0]?.agentId).toBeNull()
    expect(events[0]?.payload).toEqual({ entity: 'team', id: result.value.id, field: 'created', from: null, to: 'Design' })
  })

  it('refuses a name already used in the same workspace, creating nothing', async () => {
    const result = await createProjectTeam(fixture.workspaceId, 'QA')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: 'QA' })
    expect(await prisma.team.count({ where: { workspaceId: fixture.workspaceId } })).toBe(2)
    expect(await orgChangedEvents(fixture.workspaceId)).toHaveLength(0)
  })

  it('refuses a blank name and an unknown workspace', async () => {
    const blank = await createProjectTeam(fixture.workspaceId, '   ')
    expect(blank.ok).toBe(false)
    if (!blank.ok) expect(blank.error).toEqual({ kind: 'invalid_name' })

    const unknown = await createProjectTeam(UNKNOWN, 'Design')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toEqual({ kind: 'workspace_not_found', workspaceId: UNKNOWN })
  })
})

describe('moveAgent', () => {
  it('moves the agent to another department in the same workspace and emits one org.changed event', async () => {
    const result = await moveAgent(fixture.agentId, fixture.qaId)

    expect(result.ok).toBe(true)
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } })
    expect(row.teamId).toBe(fixture.qaId)

    const events = await orgChangedEvents(fixture.workspaceId)
    expect(events).toHaveLength(1)
    expect(events[0]?.agentId).toBe(fixture.agentId)
    expect(events[0]?.payload).toEqual({ entity: 'agent', id: fixture.agentId, field: 'team', from: 'Engineering', to: 'QA' })
  })

  it('refuses a department in another workspace, changing nothing', async () => {
    const result = await moveAgent(fixture.agentId, fixture.otherTeamId)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'team_workspace_mismatch', agentId: fixture.agentId, teamId: fixture.otherTeamId })
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } })
    expect(row.teamId).toBe(fixture.engineeringId)
    expect(await orgChangedEvents(fixture.workspaceId)).toHaveLength(0)
  })

  it('refuses while the agent holds a live run', async () => {
    const task = await prisma.task.create({
      data: { workspaceId: fixture.workspaceId, title: 'Add the thing', description: 'make it work', maxAttempts: 3 },
    })
    const run = await prisma.agentRun.create({ data: { taskId: task.id, agentId: fixture.agentId, status: 'running' } })

    const result = await moveAgent(fixture.agentId, fixture.qaId)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'agent_run_active', agentId: fixture.agentId, runId: run.id })
  })

  it('refuses an unknown agent and an unknown department', async () => {
    const agent = await moveAgent(UNKNOWN, fixture.qaId)
    expect(agent.ok).toBe(false)
    if (!agent.ok) expect(agent.error).toEqual({ kind: 'agent_not_found', agentId: UNKNOWN })

    const team = await moveAgent(fixture.agentId, UNKNOWN)
    expect(team.ok).toBe(false)
    if (!team.ok) expect(team.error).toEqual({ kind: 'team_not_found', teamId: UNKNOWN })
  })
})

describe('moveCompanyAgent', () => {
  it('moves the catalog agent to another template of the same company and writes no event', async () => {
    const result = await moveCompanyAgent(fixture.companyAgentId, fixture.emptyTemplateTeamId)

    expect(result.ok).toBe(true)
    const row = await prisma.companyAgent.findUniqueOrThrow({ where: { id: fixture.companyAgentId } })
    expect(row.companyTeamId).toBe(fixture.emptyTemplateTeamId)
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('refuses a template of another company, changing nothing', async () => {
    const result = await moveCompanyAgent(fixture.companyAgentId, fixture.otherCompanyTeamId)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toEqual({
        kind: 'company_mismatch',
        companyAgentId: fixture.companyAgentId,
        companyTeamId: fixture.otherCompanyTeamId,
      })
    }
    const row = await prisma.companyAgent.findUniqueOrThrow({ where: { id: fixture.companyAgentId } })
    expect(row.companyTeamId).toBe(fixture.backendTemplateTeamId)
  })

  it('refuses when the target template already has a member of that name', async () => {
    await prisma.companyAgent.create({
      data: { companyTeamId: fixture.emptyTemplateTeamId, templateId: fixture.templateId, name: 'Sam' },
    })

    const result = await moveCompanyAgent(fixture.companyAgentId, fixture.emptyTemplateTeamId)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'duplicate_name', name: 'Sam' })
  })

  it('refuses an unknown catalog agent and an unknown template', async () => {
    const agent = await moveCompanyAgent(UNKNOWN, fixture.emptyTemplateTeamId)
    expect(agent.ok).toBe(false)
    if (!agent.ok) expect(agent.error).toEqual({ kind: 'agent_not_found', agentId: UNKNOWN })

    const team = await moveCompanyAgent(fixture.companyAgentId, UNKNOWN)
    expect(team.ok).toBe(false)
    if (!team.ok) expect(team.error).toEqual({ kind: 'company_team_not_found', companyTeamId: UNKNOWN })
  })
})

describe('renameCompanyTeam', () => {
  it('renames the template and writes no event', async () => {
    const result = await renameCompanyTeam(fixture.emptyTemplateTeamId, 'Platform')

    expect(result.ok).toBe(true)
    const row = await prisma.companyTeam.findUniqueOrThrow({ where: { id: fixture.emptyTemplateTeamId } })
    expect(row.name).toBe('Platform')
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('refuses a sibling name in the same company, a blank name and an unknown template', async () => {
    const taken = await renameCompanyTeam(fixture.emptyTemplateTeamId, 'Backend')
    expect(taken.ok).toBe(false)
    if (!taken.ok) expect(taken.error).toEqual({ kind: 'duplicate_name', name: 'Backend' })

    const blank = await renameCompanyTeam(fixture.emptyTemplateTeamId, ' ')
    expect(blank.ok).toBe(false)
    if (!blank.ok) expect(blank.error).toEqual({ kind: 'invalid_name' })

    const unknown = await renameCompanyTeam(UNKNOWN, 'Platform')
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toEqual({ kind: 'company_team_not_found', companyTeamId: UNKNOWN })
  })
})

describe('deleteCompanyTeam', () => {
  it('refuses a template that still has a member, deleting nothing', async () => {
    const result = await deleteCompanyTeam(fixture.backendTemplateTeamId)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toEqual({ kind: 'company_team_not_empty', companyTeamId: fixture.backendTemplateTeamId, agents: 1 })
    }
    expect(await prisma.companyTeam.findUnique({ where: { id: fixture.backendTemplateTeamId } })).not.toBeNull()
  })

  it('deletes an empty template; a project department copied from it survives with companyTeamId null', async () => {
    const copy = await prisma.team.create({
      data: { workspaceId: fixture.workspaceId, name: 'Design', companyTeamId: fixture.emptyTemplateTeamId },
    })

    const result = await deleteCompanyTeam(fixture.emptyTemplateTeamId)

    expect(result.ok).toBe(true)
    expect(await prisma.companyTeam.findUnique({ where: { id: fixture.emptyTemplateTeamId } })).toBeNull()
    const survivor = await prisma.team.findUniqueOrThrow({ where: { id: copy.id } })
    expect(survivor.companyTeamId).toBeNull()
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('refuses an unknown template', async () => {
    const result = await deleteCompanyTeam(UNKNOWN)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toEqual({ kind: 'company_team_not_found', companyTeamId: UNKNOWN })
  })
})
```

- [ ] **Step 2: Run it RED.** `npx tsc --build` will fail on the missing exports; that is the RED signal for this task (an integration test cannot even compile without them). Record the first error line.

- [ ] **Step 3: Refusal kinds.** In `packages/control/src/refusal.ts` add to the `ControlRefusal` union, after the `team_not_empty` member:

```ts
  | { readonly kind: 'team_workspace_mismatch'; readonly agentId: string; readonly teamId: string }
  | { readonly kind: 'company_mismatch'; readonly companyAgentId: string; readonly companyTeamId: string }
  | { readonly kind: 'company_team_not_empty'; readonly companyTeamId: string; readonly agents: number }
```

and in `refusalText`'s `switch`, after the `team_not_empty` case:

```ts
    case 'team_workspace_mismatch':
      return `department ${refusal.teamId} belongs to another project than agent ${refusal.agentId}`
    case 'company_mismatch':
      return `department template ${refusal.companyTeamId} belongs to another company than catalog agent ${refusal.companyAgentId}`
    case 'company_team_not_empty':
      return `department template ${refusal.companyTeamId} still has ${refusal.agents} member(s); move them first`
```

- [ ] **Step 4: The verbs.** Append to `packages/control/src/org.ts` after `deleteTeam`. `NON_TERMINAL_RUN_STATUSES`, `lockAgent`, `lockTeam`, `appendEvent`, `err`, `ok` and `isUniqueConstraintViolation` are already imported/defined in the file. Read `setAgentRole` (grep `agent_run_active` in the file) and copy its live-run check verbatim where marked.

```ts
// ---- M25 §3.1: departments -----------------------------------------------------------------
// A "department" is a project `Team`; a "department template" is a catalog `CompanyTeam`. The two
// project-level verbs below emit `org.changed` like `renameTeam`; the three catalog-level verbs
// emit nothing, the rule `addCompanyTeam`/`addCompanyAgent` already follow (no workspace, no
// event).

/** Creates a department in a project with no template link (`companyTeamId: null`). Names are
 *  unique per workspace, the rule {@link renameTeam} enforces -- and, as there, there is no
 *  unique index to lean on, so the check runs inside the transaction. */
export async function createProjectTeam(
  workspaceId: string,
  name: string,
  principal?: Principal,
): Promise<Result<{ readonly id: string }, ControlRefusal>> {
  if (name.trim() === '') return err({ kind: 'invalid_name' })

  const outcome = await prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
    if (workspace === null) return { ok: false as const, error: { kind: 'workspace_not_found', workspaceId } as ControlRefusal }

    const sibling = await tx.team.findFirst({ where: { workspaceId, name } })
    if (sibling !== null) return { ok: false as const, error: { kind: 'duplicate_name', name } as ControlRefusal }

    const team = await tx.team.create({ data: { workspaceId, name, companyTeamId: null } })
    return { ok: true as const, value: { id: team.id } }
  })

  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'org.changed',
    workspaceId,
    actor: 'human',
    payload: { entity: 'team', id: outcome.value.id, field: 'created', from: null, to: name },
    userId: principal?.userId ?? null,
  })

  return ok({ id: outcome.value.id })
}

/**
 * Moves a project agent to another department of the SAME project. `companyAgentId` is left
 * alone: the agent still knows which catalog row it came from, only its department changed, and
 * `assignCompany` run again later finds it by that id and leaves it where it is. Refused while
 * the agent holds a live run, the rule {@link setAgentRole} applies.
 */
export async function moveAgent(
  agentId: string,
  teamId: string,
  principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    const agent = await lockAgent(tx, agentId)
    if (agent === null) return { ok: false as const, error: { kind: 'agent_not_found', agentId } as ControlRefusal }

    // Copy `setAgentRole`'s live-run check here verbatim (the `agent_run_active` refusal keyed on
    // `NON_TERMINAL_RUN_STATUSES`), so both verbs refuse on the same definition of "live".
    const live = agent.runs.find((run) => (NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status))
    if (live !== undefined) {
      return { ok: false as const, error: { kind: 'agent_run_active', agentId, runId: live.id } as ControlRefusal }
    }

    const target = await tx.team.findUnique({ where: { id: teamId }, select: { id: true, name: true, workspaceId: true } })
    if (target === null) return { ok: false as const, error: { kind: 'team_not_found', teamId } as ControlRefusal }
    if (target.workspaceId !== agent.team.workspaceId) {
      return { ok: false as const, error: { kind: 'team_workspace_mismatch', agentId, teamId } as ControlRefusal }
    }

    const from = await tx.team.findUniqueOrThrow({ where: { id: agent.team.id }, select: { name: true } })
    await tx.agent.update({ where: { id: agentId }, data: { teamId } })
    return { ok: true as const, value: { workspaceId: target.workspaceId, from: from.name, to: target.name } }
  })

  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'org.changed',
    workspaceId: outcome.value.workspaceId,
    agentId,
    actor: 'human',
    payload: { entity: 'agent', id: agentId, field: 'team', from: outcome.value.from, to: outcome.value.to },
    userId: principal?.userId ?? null,
  })

  return ok(undefined)
}

/** Moves a catalog agent to another department template of the SAME company. The unique index
 *  `@@unique([companyTeamId, name])` is what refuses a name clash, caught the way
 *  {@link addCompanyAgent} catches it. No event: the catalog has no workspace. */
export async function moveCompanyAgent(
  companyAgentId: string,
  companyTeamId: string,
  _principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const agent = await prisma.companyAgent.findUnique({
    where: { id: companyAgentId },
    select: { id: true, name: true, companyTeam: { select: { companyId: true } } },
  })
  if (agent === null) return err({ kind: 'agent_not_found', agentId: companyAgentId })

  const target = await prisma.companyTeam.findUnique({ where: { id: companyTeamId }, select: { id: true, companyId: true } })
  if (target === null) return err({ kind: 'company_team_not_found', companyTeamId })
  if (target.companyId !== agent.companyTeam.companyId) return err({ kind: 'company_mismatch', companyAgentId, companyTeamId })

  try {
    await prisma.companyAgent.update({ where: { id: companyAgentId }, data: { companyTeamId } })
    return ok(undefined)
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name: agent.name })
    throw error
  }
}

/** Renames a department template. `@@unique([companyId, name])` refuses a sibling clash. No event. */
export async function renameCompanyTeam(
  companyTeamId: string,
  name: string,
  _principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  if (name.trim() === '') return err({ kind: 'invalid_name' })

  const team = await prisma.companyTeam.findUnique({ where: { id: companyTeamId }, select: { id: true } })
  if (team === null) return err({ kind: 'company_team_not_found', companyTeamId })

  try {
    await prisma.companyTeam.update({ where: { id: companyTeamId }, data: { name } })
    return ok(undefined)
  } catch (error) {
    if (isUniqueConstraintViolation(error)) return err({ kind: 'duplicate_name', name })
    throw error
  }
}

/** Deletes an EMPTY department template. Project departments copied from it survive with
 *  `companyTeamId` set to null (`onDelete: SetNull` on `Team.companyTeam`). No event. */
export async function deleteCompanyTeam(
  companyTeamId: string,
  _principal?: Principal,
): Promise<Result<void, ControlRefusal>> {
  const team = await prisma.companyTeam.findUnique({
    where: { id: companyTeamId },
    select: { id: true, _count: { select: { agents: true } } },
  })
  if (team === null) return err({ kind: 'company_team_not_found', companyTeamId })
  if (team._count.agents > 0) {
    return err({ kind: 'company_team_not_empty', companyTeamId, agents: team._count.agents })
  }

  await prisma.companyTeam.delete({ where: { id: companyTeamId } })
  return ok(undefined)
}
```

If `setAgentRole`'s live-run check differs in shape from the two lines marked above (e.g. it uses a helper), use its exact form.

- [ ] **Step 5: CLI.** In `apps/orchestrator/src/cli.ts`, add the five names to the `@ai-team-os/control` import list (lines 4–29, alphabetical with the rest). In the help text, after the `delete-team` entry (line ~92):

```
  create-team --workspace <id> --name <n>
                                       add a department to a project (no template link)
  move-agent --agent <id> --team <id>  move a project agent to another department of the same
                                       project -- refused while the agent holds a live run
  move-company-agent --agent <companyAgentId> --team <companyTeamId>
                                       move a catalog agent to another department template of
                                       the same company
  rename-company-team --team <companyTeamId> --name <n>
                                       rename a department template
  delete-company-team --team <companyTeamId> --yes
                                       remove an EMPTY department template; project departments
                                       copied from it keep living. Omit --yes to see what would
                                       be deleted without doing it.
```

After `case 'delete-team'` add:

```ts
    // ---- M25 §3.3: departments -----------------------------------------------------------------
    case 'create-team': {
      const workspaceId = requireFlag(flags, 'workspace')
      const name = requireFlag(flags, 'name')
      const result = await createProjectTeam(workspaceId, name)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`department ${result.value.id} created in ${workspaceId}\n`)
      return 0
    }

    case 'move-agent': {
      const agentId = requireFlag(flags, 'agent')
      const teamId = requireFlag(flags, 'team')
      const result = await moveAgent(agentId, teamId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`agent ${agentId} moved to department ${teamId}\n`)
      return 0
    }

    case 'move-company-agent': {
      const companyAgentId = requireFlag(flags, 'agent')
      const companyTeamId = requireFlag(flags, 'team')
      const result = await moveCompanyAgent(companyAgentId, companyTeamId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`catalog agent ${companyAgentId} moved to department template ${companyTeamId}\n`)
      return 0
    }

    case 'rename-company-team': {
      const companyTeamId = requireFlag(flags, 'team')
      const name = requireFlag(flags, 'name')
      const result = await renameCompanyTeam(companyTeamId, name)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`department template ${companyTeamId} renamed\n`)
      return 0
    }

    case 'delete-company-team': {
      const companyTeamId = requireFlag(flags, 'team')
      if (!('yes' in flags)) {
        const team = await prisma.companyTeam.findUnique({ where: { id: companyTeamId }, select: { name: true } })
        throw new Error(`refusing without --yes: this would delete department template ${team?.name ?? companyTeamId} (${companyTeamId})`)
      }
      const result = await deleteCompanyTeam(companyTeamId)
      if (!result.ok) throw new Error(refusalText(result.error))
      process.stdout.write(`department template ${companyTeamId} deleted\n`)
      return 0
    }
```

- [ ] **Step 6: GREEN.** `npx tsc --build && npx vitest run packages/control/test/integration/departments.test.ts` → 16 tests pass. Then `npx vitest run packages/control/test/integration/org-edit.test.ts` (unchanged neighbours still green).

- [ ] **Step 7: Commit.**

```bash
git add packages/control/src/refusal.ts packages/control/src/org.ts packages/control/src/index.ts apps/orchestrator/src/cli.ts packages/control/test/integration/departments.test.ts
git commit -m "feat(control): m25 t1 — departments: create in a project, move an agent, move/rename/delete a template; the CLI verbs"
```

---

### Task 2: The five routes

**Files:**
- Create: `apps/web/src/app/api/w/[workspaceId]/teams/route.ts`, `apps/web/src/app/api/agents/[agentId]/team/route.ts`, `apps/web/src/app/api/org/agents/[companyAgentId]/team/route.ts`, `apps/web/src/app/api/org/teams/[companyTeamId]/name/route.ts`, `apps/web/src/app/api/org/teams/[companyTeamId]/route.ts`
- Test: `apps/web/test/integration/department-routes.test.ts` (new)

**Interfaces:**
- Consumes Task 1's five verbs from `@ai-team-os/control`; `orgControlResponse` (`apps/web/src/server/orgControlRoute.ts`, returns `{ ok: true }` / 409 `{ error }`); `requirePrincipal` (`apps/web/src/server/principal.ts`).
- Produces the five routes of spec §3.2. `POST /api/w/:id/teams` answers 200 `{ ok: true, id }` (the created department's id; the form does not need it but the CLI parity test does).

- [ ] **Step 1: Failing tests.** Create `apps/web/test/integration/department-routes.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as createTeam } from '../../src/app/api/w/[workspaceId]/teams/route.js'
import { PUT as moveAgentRoute } from '../../src/app/api/agents/[agentId]/team/route.js'
import { PUT as moveCompanyAgentRoute } from '../../src/app/api/org/agents/[companyAgentId]/team/route.js'
import { PUT as renameTemplate } from '../../src/app/api/org/teams/[companyTeamId]/name/route.js'
import { DELETE as deleteTemplate } from '../../src/app/api/org/teams/[companyTeamId]/route.js'

const repoPath = mkdtempSync(join(tmpdir(), 'aiteamos-web-department-routes-'))
afterAll(async () => {
  rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
})

function json(body: unknown, method: 'POST' | 'PUT'): Request {
  return new Request('http://test/api', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
}

interface Fixture {
  readonly workspaceId: string
  readonly engineeringId: string
  readonly qaId: string
  readonly agentId: string
  readonly templateTeamId: string
  readonly emptyTemplateTeamId: string
  readonly companyAgentId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath, verifyCommands: ['true'], setupCommands: [] },
  })
  const engineering = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const qa = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'QA' } })
  const agent = await prisma.agent.create({ data: { teamId: engineering.id, name: 'Alex', role: 'backend' } })
  const template = await prisma.agentTemplate.create({ data: { name: 'Backend Developer', role: 'backend', description: '' } })
  const company = await prisma.company.create({ data: { name: 'Atlas Software' } })
  const templateTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Backend' } })
  const emptyTemplateTeam = await prisma.companyTeam.create({ data: { companyId: company.id, name: 'Design' } })
  const companyAgent = await prisma.companyAgent.create({
    data: { companyTeamId: templateTeam.id, templateId: template.id, name: 'Sam' },
  })
  return {
    workspaceId: workspace.id,
    engineeringId: engineering.id,
    qaId: qa.id,
    agentId: agent.id,
    templateTeamId: templateTeam.id,
    emptyTemplateTeamId: emptyTemplateTeam.id,
    companyAgentId: companyAgent.id,
  }
}

let fixture: Fixture

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace", "CompanyAgent", "CompanyTeam", "Company", "AgentTemplate" RESTART IDENTITY CASCADE',
  )
  fixture = await seed()
})

describe('POST /api/w/[workspaceId]/teams', () => {
  it('creates the department and answers its id', async () => {
    const response = await createTeam(json({ name: 'Design' }, 'POST'), { params: Promise.resolve({ workspaceId: fixture.workspaceId }) })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { ok: true; id: string }
    const row = await prisma.team.findUniqueOrThrow({ where: { id: body.id } })
    expect(row.name).toBe('Design')
  })

  it('400s a body without a name and 409s a duplicate name with the refusal text', async () => {
    const bad = await createTeam(json({}, 'POST'), { params: Promise.resolve({ workspaceId: fixture.workspaceId }) })
    expect(bad.status).toBe(400)

    const dup = await createTeam(json({ name: 'QA' }, 'POST'), { params: Promise.resolve({ workspaceId: fixture.workspaceId }) })
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: string }).error).toContain('QA')
  })
})

describe('PUT /api/agents/[agentId]/team', () => {
  it('moves the agent', async () => {
    const response = await moveAgentRoute(json({ teamId: fixture.qaId }, 'PUT'), { params: Promise.resolve({ agentId: fixture.agentId }) })
    expect(response.status).toBe(200)
    const row = await prisma.agent.findUniqueOrThrow({ where: { id: fixture.agentId } })
    expect(row.teamId).toBe(fixture.qaId)
  })

  it('400s without a teamId', async () => {
    const response = await moveAgentRoute(json({}, 'PUT'), { params: Promise.resolve({ agentId: fixture.agentId }) })
    expect(response.status).toBe(400)
  })
})

describe('PUT /api/org/agents/[companyAgentId]/team', () => {
  it('moves the catalog agent', async () => {
    const response = await moveCompanyAgentRoute(json({ companyTeamId: fixture.emptyTemplateTeamId }, 'PUT'), {
      params: Promise.resolve({ companyAgentId: fixture.companyAgentId }),
    })
    expect(response.status).toBe(200)
    const row = await prisma.companyAgent.findUniqueOrThrow({ where: { id: fixture.companyAgentId } })
    expect(row.companyTeamId).toBe(fixture.emptyTemplateTeamId)
  })
})

describe('PUT /api/org/teams/[companyTeamId]/name and DELETE /api/org/teams/[companyTeamId]', () => {
  it('renames the template', async () => {
    const response = await renameTemplate(json({ name: 'Platform' }, 'PUT'), { params: Promise.resolve({ companyTeamId: fixture.emptyTemplateTeamId }) })
    expect(response.status).toBe(200)
    const row = await prisma.companyTeam.findUniqueOrThrow({ where: { id: fixture.emptyTemplateTeamId } })
    expect(row.name).toBe('Platform')
  })

  it('409s deleting a template with members, 200s deleting an empty one', async () => {
    const full = await deleteTemplate(new Request('http://test/api', { method: 'DELETE' }), { params: Promise.resolve({ companyTeamId: fixture.templateTeamId }) })
    expect(full.status).toBe(409)

    const empty = await deleteTemplate(new Request('http://test/api', { method: 'DELETE' }), { params: Promise.resolve({ companyTeamId: fixture.emptyTemplateTeamId }) })
    expect(empty.status).toBe(200)
    expect(await prisma.companyTeam.findUnique({ where: { id: fixture.emptyTemplateTeamId } })).toBeNull()
  })
})
```

- [ ] **Step 2: RED.** `npx tsc -p apps/web/tsconfig.test.json --noEmit` fails on the five missing route modules. Record the first error.

- [ ] **Step 3: The routes.** Each follows `apps/web/src/app/api/teams/[teamId]/name/route.ts` (read it first). Relative import depth: count the segments — the `w/[workspaceId]/teams` and `org/teams/[companyTeamId]/name` and `org/agents/[companyAgentId]/team` and `agents/[agentId]/team` routes are five levels below `src/app` (`../../../../../server/...`); `org/teams/[companyTeamId]/route.ts` is four (`../../../../server/...`).

`apps/web/src/app/api/w/[workspaceId]/teams/route.ts` — the one route that returns the id, so it does not use `orgControlResponse`:

```ts
import { createProjectTeam, refusalText } from '@ai-team-os/control'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "name": string }'

/** `DepartmentsTable`'s "New department" form (M25 §4.2). Answers the new row's id so a caller
 *  (the CLI parity test, a later drawer) can address it without a second read. */
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const { name } = body as { name?: unknown }
  if (typeof name !== 'string') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const result = await createProjectTeam(workspaceId, name, gate.principal ?? undefined)
  return result.ok
    ? Response.json({ ok: true, id: result.value.id })
    : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
```

`apps/web/src/app/api/agents/[agentId]/team/route.ts`:

```ts
import { moveAgent } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const BODY_ERROR = 'the body must be { "teamId": string }'

/** The Agents table's department `<select>` on a project row (M25 §4.1). */
export async function PUT(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { agentId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const { teamId } = body as { teamId?: unknown }
  if (typeof teamId !== 'string') return Response.json({ error: BODY_ERROR }, { status: 400 })
  return orgControlResponse(() => moveAgent(agentId, teamId, gate.principal ?? undefined))
}
```

`apps/web/src/app/api/org/agents/[companyAgentId]/team/route.ts` — same shape with `moveCompanyAgent(companyAgentId, companyTeamId, gate.principal ?? undefined)`, body `{ companyTeamId: string }`, docstring "The Agents table's department `<select>` on a catalog row (M25 §4.1)".

`apps/web/src/app/api/org/teams/[companyTeamId]/name/route.ts` — same shape with `renameCompanyTeam(companyTeamId, name, gate.principal ?? undefined)`, body `{ name: string }`, docstring "`TeamBlock`'s inline rename of a department template (M25 §4.3)".

`apps/web/src/app/api/org/teams/[companyTeamId]/route.ts`:

```ts
import { deleteCompanyTeam } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

/** `TeamBlock`'s delete of an EMPTY department template (M25 §4.3); the verb refuses a
 *  template that still has members. */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ companyTeamId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { companyTeamId } = await context.params
  return orgControlResponse(() => deleteCompanyTeam(companyTeamId, gate.principal ?? undefined))
}
```

- [ ] **Step 4: GREEN.** `npx tsc -p apps/web/tsconfig.test.json --noEmit && npx vitest run apps/web/test/integration/department-routes.test.ts` → 8 pass.

- [ ] **Step 5: Build + commit.** `pgrep -fa 'next dev'` (empty), `npm run web:build && rm -rf apps/web/.next`.

```bash
git add "apps/web/src/app/api/w/[workspaceId]/teams/route.ts" "apps/web/src/app/api/agents/[agentId]/team/route.ts" "apps/web/src/app/api/org/agents/[companyAgentId]/team/route.ts" "apps/web/src/app/api/org/teams/[companyTeamId]/name/route.ts" "apps/web/src/app/api/org/teams/[companyTeamId]/route.ts" apps/web/test/integration/department-routes.test.ts
git commit -m "feat(web): m25 t2 — five department routes over the five verbs"
```

---

### Task 3: Model discovery in the providers package

**Files:**
- Create: `packages/providers/src/models.ts`, `packages/providers/test/models.test.ts`, `packages/providers/test/fixtures/cursor/models.txt`
- Modify: `packages/providers/src/index.ts` (add `export * from './models.js'`), `packages/providers/src/claude/adapter.ts` (the `AgentRuntimeAdapter` interface near line 123 + `ClaudeCodeAdapter`), `packages/providers/src/cursor/adapter.ts` (`CursorAdapter`), `packages/control/src/index.ts` (re-export), and every test fake that implements the adapter: `apps/orchestrator/test/integration/model.test.ts`, `apps/orchestrator/test/integration/tick.test.ts`, `packages/providers/test/adapter-start.test.ts`, `packages/providers/test/capabilities.test.ts`, `packages/providers/test/cursor-adapter.test.ts`, `packages/providers/test/registry.test.ts` (confirm the list with `grep -rln "getCapabilities" apps/orchestrator/test packages/providers/test`)

**Interfaces:**
- Produces (from `@ai-team-os/providers`, and re-exported from `@ai-team-os/control`):

```ts
export interface ModelOption { readonly id: string; readonly label: string; readonly default?: true }
export interface ModelListing {
  readonly models: readonly ModelOption[]
  readonly source: 'account' | 'static'
  readonly error?: string
}
export function parseCursorModels(stdout: string): readonly ModelOption[]
export const CLAUDE_CODE_MODELS: readonly ModelOption[]
export function listClaudeCodeModels(): ModelListing
export function listCursorModels(command?: string, timeoutMs?: number): Promise<ModelListing>
export function listProviderModels(kind: ProviderKind, options?: { readonly cursorCommand?: string; readonly timeoutMs?: number }): Promise<ModelListing>
```
- The `AgentRuntimeAdapter` interface gains `listModels(): Promise<ModelListing>`.

- [ ] **Step 1: Fixture.** Capture the real output once and commit it as `packages/providers/test/fixtures/cursor/models.txt`: run `cursor-agent models > packages/providers/test/fixtures/cursor/models.txt` (it contains ANSI escapes — keep them; that is the point). If `cursor-agent` is not on this machine, write the fixture by hand with these exact bytes (`\x1b` written as the real escape byte):

```
[2mAvailable models[22m

[36mauto[39m [2m- Auto[22m[2m (default)[22m
[36mgpt-5.3-codex[39m [2m- Codex 5.3[22m
[36msonnet-4-thinking[39m [2m- Claude Sonnet 4 Thinking[22m
```

- [ ] **Step 2: Failing tests.** Create `packages/providers/test/models.test.ts`:

```ts
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_CODE_MODELS, listClaudeCodeModels, listCursorModels, listProviderModels, parseCursorModels } from '../src/models.js'

const here = path.dirname(new URL(import.meta.url).pathname)
const fixture = readFileSync(path.join(here, 'fixtures', 'cursor', 'models.txt'), 'utf8')

describe('parseCursorModels', () => {
  it('strips ANSI, skips the heading and blank lines, splits "id - label", marks the default', () => {
    const models = parseCursorModels(fixture)
    expect(models[0]).toEqual({ id: 'auto', label: 'Auto', default: true })
    expect(models.some((m) => m.id === 'gpt-5.3-codex' && m.label === 'Codex 5.3')).toBe(true)
    expect(models.every((m) => !m.id.includes('\x1b') && !m.label.includes('\x1b'))).toBe(true)
    expect(models.every((m) => m.id !== '' && m.label !== '')).toBe(true)
  })

  it('returns an empty list for empty or unrelated output', () => {
    expect(parseCursorModels('')).toEqual([])
    expect(parseCursorModels('cursor-agent: unknown command\n')).toEqual([])
  })
})

describe('listClaudeCodeModels', () => {
  it('is the static table, source static, with the CLI aliases first and the default marked', () => {
    const listing = listClaudeCodeModels()
    expect(listing.source).toBe('static')
    expect(listing.error).toBeUndefined()
    expect(listing.models).toBe(CLAUDE_CODE_MODELS)
    expect(listing.models.slice(0, 5).map((m) => m.id)).toEqual(['default', 'fable', 'opus', 'sonnet', 'haiku'])
    expect(listing.models.filter((m) => m.default).map((m) => m.id)).toEqual(['default'])
  })
})

describe('listCursorModels', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function script(body: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'aiteamos-models-'))
    dirs.push(dir)
    const file = path.join(dir, 'fake-cursor-agent')
    writeFileSync(file, body)
    chmodSync(file, 0o755)
    return file
  }

  it('runs `<command> models` and parses its stdout as an account listing', async () => {
    const fixturePath = path.join(here, 'fixtures', 'cursor', 'models.txt')
    const command = script(`#!/bin/sh\n[ "$1" = "models" ] || exit 2\ncat "${fixturePath}"\n`)
    const listing = await listCursorModels(command)
    expect(listing.source).toBe('account')
    expect(listing.error).toBeUndefined()
    expect(listing.models[0]?.id).toBe('auto')
  })

  it('answers an error listing (empty models, source account) when the binary is missing or fails', async () => {
    const missing = await listCursorModels('/nonexistent/cursor-agent')
    expect(missing).toMatchObject({ models: [], source: 'account' })
    expect(missing.error).toBeTruthy()

    const failing = script('#!/bin/sh\necho "not logged in" >&2\nexit 1\n')
    const listing = await listCursorModels(failing)
    expect(listing).toMatchObject({ models: [], source: 'account' })
    expect(listing.error).toContain('not logged in')
  })
})

describe('listProviderModels', () => {
  it('dispatches on the kind', async () => {
    expect((await listProviderModels('claude_code')).source).toBe('static')
    expect((await listProviderModels('cursor', { cursorCommand: '/nonexistent/cursor-agent' })).error).toBeTruthy()
  })
})
```

- [ ] **Step 3: RED.** `npx vitest run packages/providers/test/models.test.ts` → fails to resolve `../src/models.js`.

- [ ] **Step 4: `models.ts`.** Create `packages/providers/src/models.ts`:

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ProviderKind } from './types.js'

const run = promisify(execFile)

/** One entry of a provider's model list: the id the CLI accepts after `--model`, and a label. */
export interface ModelOption {
  readonly id: string
  readonly label: string
  readonly default?: true
}

/**
 * A provider's selectable models (M25 §5.1). `account` means the list was read from the
 * provider for THIS login (Cursor: `cursor-agent models`); `static` means it is the adapter's own
 * table (Claude Code, whose CLI documents aliases but lists nothing). An `account` read that
 * failed comes back with `error` set and `models` empty -- never a throw -- so a form can fall
 * back to free text and say why.
 */
export interface ModelListing {
  readonly models: readonly ModelOption[]
  readonly source: 'account' | 'static'
  readonly error?: string
}

// `\x1b[36m` / `\x1b[2m` / `\x1b[22m` / `\x1b[39m` -- the colour and dim toggles `cursor-agent
// models` wraps every token in, even when stdout is not a TTY.
const ANSI = /\x1b\[[0-9;]*m/g

/**
 * `cursor-agent models` prints a heading, a blank line, then one `<id> - <label>` per line; the
 * account's default carries a trailing ` (default)`. Pure: the captured output in
 * `test/fixtures/cursor/models.txt` is the contract. Anything that is not an `id - label` line is
 * skipped, so a version that adds prose keeps parsing.
 */
export function parseCursorModels(stdout: string): readonly ModelOption[] {
  const models: ModelOption[] = []
  for (const raw of stdout.replace(ANSI, '').split('\n')) {
    const line = raw.trim()
    const separator = line.indexOf(' - ')
    if (line === '' || separator <= 0) continue
    const id = line.slice(0, separator).trim()
    let label = line.slice(separator + 3).trim()
    let isDefault = false
    if (label.endsWith('(default)')) {
      isDefault = true
      label = label.slice(0, -'(default)'.length).trim()
    }
    if (id === '' || label === '' || id.includes(' ')) continue
    models.push(isDefault ? { id, label, default: true } : { id, label })
  }
  return models
}

/**
 * The Claude Code CLI's `--model` accepts an alias for the latest model of a family
 * (`claude --help`: 'fable', 'opus', 'sonnet') or a full id. It lists nothing, so this table is
 * pinned by hand to the CLI version `ClaudeCodeAdapter` was last measured with and is updated
 * with the adapter. `default` is the CLI's own choice when no `--model` is passed.
 */
export const CLAUDE_CODE_MODELS: readonly ModelOption[] = [
  { id: 'default', label: "default (the CLI's current default)", default: true },
  { id: 'fable', label: 'fable (latest Fable)' },
  { id: 'opus', label: 'opus (latest Opus)' },
  { id: 'sonnet', label: 'sonnet (latest Sonnet)' },
  { id: 'haiku', label: 'haiku (latest Haiku)' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
]

export function listClaudeCodeModels(): ModelListing {
  return { models: CLAUDE_CODE_MODELS, source: 'static' }
}

/** Runs `<command> models` (default `cursor-agent`, 10 s) and parses it. Never throws. */
export async function listCursorModels(command = 'cursor-agent', timeoutMs = 10_000): Promise<ModelListing> {
  try {
    const { stdout } = await run(command, ['models'], { timeout: timeoutMs, env: { ...process.env, NO_COLOR: '1' } })
    return { models: parseCursorModels(stdout), source: 'account' }
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : (error as Error).message
    return { models: [], source: 'account', error: text.split('\n')[0] ?? 'cursor-agent models failed' }
  }
}

/** The one entry point the web reads (through `@ai-team-os/control`'s re-export): a kind in, a
 *  listing out. The adapters' `listModels()` delegate here, so a caller with an adapter and a
 *  caller with only a kind see the same list. */
export async function listProviderModels(
  kind: ProviderKind,
  options?: { readonly cursorCommand?: string; readonly timeoutMs?: number },
): Promise<ModelListing> {
  switch (kind) {
    case 'claude_code':
      return listClaudeCodeModels()
    case 'cursor':
      return listCursorModels(options?.cursorCommand, options?.timeoutMs)
  }
}
```

Add `export * from './models.js'` to `packages/providers/src/index.ts` (after `./capabilities.js`).

- [ ] **Step 5: The adapters and the interface.** In `packages/providers/src/claude/adapter.ts`: import `{ listClaudeCodeModels, type ModelListing } from '../models.js'`; add `listModels(): Promise<ModelListing>` to the `AgentRuntimeAdapter` interface (after `getCapabilities()`), with the docstring "The models an operator can pick for this provider (M25 §5.1) — `listProviderModels(kind)` gives the same answer without an adapter." Add to `ClaudeCodeAdapter`:

```ts
  listModels(): Promise<ModelListing> {
    return Promise.resolve(listClaudeCodeModels())
  }
```

In `packages/providers/src/cursor/adapter.ts`: import `{ listCursorModels, type ModelListing } from '../models.js'`; add to `CursorAdapter`:

```ts
  listModels(): Promise<ModelListing> {
    return listCursorModels(this.command)
  }
```

Then `npx tsc --build` and fix every fake that now fails to satisfy the interface by adding one line to each fake object/class: `listModels: async () => ({ models: [], source: 'static' as const })` (object literals) or `listModels(): Promise<ModelListing> { return Promise.resolve({ models: [], source: 'static' }) }` (classes). Touch nothing else in those tests.

- [ ] **Step 6: Control re-export.** In `packages/control/src/index.ts`, after the `capabilitiesOf` re-export:

```ts
/** Re-exported for the same reason as `capabilitiesOf` (M25 §5.2): `apps/web/src/server/models.ts`
 *  asks "which models can this provider run" by KIND, which spawns the provider's CLI but never
 *  constructs an adapter. */
export { listProviderModels } from '@ai-team-os/providers'
export type { ModelListing, ModelOption } from '@ai-team-os/providers'
```

- [ ] **Step 7: GREEN.** `npx tsc --build && npx vitest run packages/providers/test/models.test.ts packages/providers/test/registry.test.ts packages/providers/test/capabilities.test.ts` → all pass (models: 7).

- [ ] **Step 8: Commit.**

```bash
git add packages/providers/src/models.ts packages/providers/src/index.ts packages/providers/src/claude/adapter.ts packages/providers/src/cursor/adapter.ts packages/providers/test/models.test.ts packages/providers/test/fixtures/cursor/models.txt packages/control/src/index.ts apps/orchestrator/test/integration/model.test.ts apps/orchestrator/test/integration/tick.test.ts packages/providers/test/adapter-start.test.ts packages/providers/test/capabilities.test.ts packages/providers/test/cursor-adapter.test.ts packages/providers/test/registry.test.ts
git commit -m "feat(providers): m25 t3 — listModels: cursor-agent's own list, Claude Code's documented aliases"
```

(Drop from `git add` any fake file Step 5 did not need to touch.)

---

### Task 4: The web cache and the models route

**Files:**
- Create: `apps/web/src/server/models.ts`, `apps/web/src/app/api/providers/[kind]/models/route.ts`
- Test: `apps/web/test/server-models.test.ts` (unit, fake timers), `apps/web/test/integration/models-route.test.ts`

**Interfaces:**
- Consumes `listProviderModels`, `ModelListing` from `@ai-team-os/control` (Task 3).
- Produces `listModelsFor(kind: ProviderKind, options?: { refresh?: true }): Promise<ModelListing>` and `clearModelCache(): void`; `GET /api/providers/<kind>/models[?refresh=1]` → 200 `ModelListing`, 404 `{ error }` for an unknown kind.

- [ ] **Step 1: Failing unit test.** Create `apps/web/test/server-models.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listProviderModels = vi.fn()
vi.mock('@ai-team-os/control', async () => {
  const actual = await vi.importActual<typeof import('@ai-team-os/control')>('@ai-team-os/control')
  return { ...actual, listProviderModels }
})

const { clearModelCache, listModelsFor } = await import('../src/server/models.js')

const OK = { models: [{ id: 'auto', label: 'Auto', default: true as const }], source: 'account' as const }
const FAILED = { models: [], source: 'account' as const, error: 'not logged in' }

describe('listModelsFor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearModelCache()
    listProviderModels.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('reads once per kind and serves the cache for five minutes', async () => {
    listProviderModels.mockResolvedValue(OK)
    expect(await listModelsFor('cursor')).toEqual(OK)
    expect(await listModelsFor('cursor')).toEqual(OK)
    expect(listProviderModels).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5 * 60_000 + 1)
    await listModelsFor('cursor')
    expect(listProviderModels).toHaveBeenCalledTimes(2)
  })

  it('caches a failed read for thirty seconds only', async () => {
    listProviderModels.mockResolvedValue(FAILED)
    await listModelsFor('cursor')
    await listModelsFor('cursor')
    expect(listProviderModels).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30_000 + 1)
    await listModelsFor('cursor')
    expect(listProviderModels).toHaveBeenCalledTimes(2)
  })

  it('refresh bypasses the cache and replaces it', async () => {
    listProviderModels.mockResolvedValueOnce(FAILED).mockResolvedValueOnce(OK)
    await listModelsFor('cursor')
    expect(await listModelsFor('cursor', { refresh: true })).toEqual(OK)
    expect(await listModelsFor('cursor')).toEqual(OK)
    expect(listProviderModels).toHaveBeenCalledTimes(2)
  })

  it('passes the AITEAMOS_CURSOR_BIN override through', async () => {
    vi.stubEnv('AITEAMOS_CURSOR_BIN', '/opt/cursor-agent')
    listProviderModels.mockResolvedValue(OK)
    await listModelsFor('cursor')
    expect(listProviderModels).toHaveBeenCalledWith('cursor', { cursorCommand: '/opt/cursor-agent' })
    vi.unstubAllEnvs()
  })
})
```

- [ ] **Step 2: Failing route test.** Create `apps/web/test/integration/models-route.test.ts` (integration only because the route module pulls the DB-backed principal gate; it makes no DB writes):

```ts
import { describe, expect, it, vi } from 'vitest'

vi.mock('@ai-team-os/control', async () => {
  const actual = await vi.importActual<typeof import('@ai-team-os/control')>('@ai-team-os/control')
  return { ...actual, listProviderModels: vi.fn(async () => ({ models: [{ id: 'opus', label: 'opus' }], source: 'static' })) }
})

const { GET } = await import('../../src/app/api/providers/[kind]/models/route.js')

describe('GET /api/providers/[kind]/models', () => {
  it('serves the listing for a known kind', async () => {
    const response = await GET(new Request('http://test/api'), { params: Promise.resolve({ kind: 'claude_code' }) })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { source: string }).source).toBe('static')
  })

  it('404s an unknown kind, naming it', async () => {
    const response = await GET(new Request('http://test/api'), { params: Promise.resolve({ kind: 'gemini' }) })
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('gemini')
  })
})
```

- [ ] **Step 3: RED.** `npx vitest run apps/web/test/server-models.test.ts` → cannot resolve `../src/server/models.js`.

- [ ] **Step 4: The cache.** Create `apps/web/src/server/models.ts`:

```ts
import { listProviderModels, type ModelListing, type ProviderKind } from '@ai-team-os/control'

const FRESH_MS = 5 * 60_000
const FAILED_MS = 30_000

interface Entry {
  readonly at: number
  readonly listing: ModelListing
}

const cache = new Map<ProviderKind, Entry>()

/** Test seam only. */
export function clearModelCache(): void {
  cache.clear()
}

/**
 * The provider's model list, cached in-process (M25 §5.2): five minutes for a good read, thirty
 * seconds for a failed one so a flapping CLI is not hammered by every open form. `refresh`
 * bypasses and replaces the entry. The Cursor binary override is the same env var `versionOf`
 * honours (`settings.ts`), so a test or a pinned install points both probes at one executable.
 */
export async function listModelsFor(kind: ProviderKind, options?: { readonly refresh?: true }): Promise<ModelListing> {
  const now = Date.now()
  const hit = cache.get(kind)
  if (hit !== undefined && options?.refresh !== true) {
    const ttl = hit.listing.error === undefined ? FRESH_MS : FAILED_MS
    if (now - hit.at < ttl) return hit.listing
  }
  const cursorCommand = process.env['AITEAMOS_CURSOR_BIN']
  const listing = await listProviderModels(
    kind,
    cursorCommand !== undefined && cursorCommand !== '' ? { cursorCommand } : {},
  )
  cache.set(kind, { at: now, listing })
  return listing
}
```

Note the unit test asserts `toHaveBeenCalledWith('cursor', { cursorCommand: '/opt/cursor-agent' })` — with no override the second argument is `{}`.

- [ ] **Step 5: The route.** Create `apps/web/src/app/api/providers/[kind]/models/route.ts`:

```ts
import type { ProviderKind } from '@ai-team-os/control'
import { listModelsFor } from '../../../../../server/models'
import { requirePrincipal } from '../../../../../server/principal'

export const dynamic = 'force-dynamic'

const KINDS: readonly ProviderKind[] = ['claude_code', 'cursor']

/** `ModelSelect`'s source (M25 §5.3): the cached listing for one provider kind; `?refresh=1`
 *  re-reads it. */
export async function GET(
  request: Request,
  context: { params: Promise<{ kind: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { kind } = await context.params
  if (!(KINDS as readonly string[]).includes(kind)) {
    return Response.json({ error: `no provider kind ${kind}` }, { status: 404 })
  }
  const refresh = new URL(request.url).searchParams.get('refresh') === '1'
  const listing = await listModelsFor(kind as ProviderKind, refresh ? { refresh: true } : undefined)
  return Response.json(listing)
}
```

(`KINDS` is a local copy for the same reason `ProviderSelect.tsx` keeps one: the route must not import `@ai-team-os/providers`; `isProviderKind` from control would do too — use it instead of `KINDS` if `grep -n "export function isProviderKind" packages/control/src/org.ts` confirms it is exported, and drop the local array.)

- [ ] **Step 6: GREEN.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/server-models.test.ts apps/web/test/integration/models-route.test.ts` → 6 pass.

- [ ] **Step 7: Build + commit.** `npm run web:build && rm -rf apps/web/.next`.

```bash
git add apps/web/src/server/models.ts "apps/web/src/app/api/providers/[kind]/models/route.ts" apps/web/test/server-models.test.ts apps/web/test/integration/models-route.test.ts
git commit -m "feat(web): m25 t4 — GET /api/providers/:kind/models, five minutes cached"
```

---

### Task 5: `ModelSelect` and its three call sites

**Files:**
- Create: `apps/web/src/components/ModelSelect.tsx`, `apps/web/test/model-select.test.tsx`
- Modify: `apps/web/src/components/ModelOverrideEditor.tsx`, `apps/web/src/components/company/TeamBlock.tsx` (the add-member form's Model field), `apps/web/src/components/TemplateCatalog.tsx` (the Default model field)
- Test: `apps/web/test/model-override-editor.test.tsx`, `apps/web/test/settings-page.test.tsx` (the `add-member form` and `TemplateCatalog` describes)

**Interfaces:**
- Consumes `GET /api/providers/<kind>/models` (Task 4).
- Produces:

```tsx
export function ModelSelect(props: {
  readonly provider: ProviderKind | ''
  readonly value: string
  readonly onChange: (next: string) => void
  readonly disabled?: boolean
  readonly ariaLabel: string
  readonly inputTestId: string   // the free-text input's testid (kept from the field it replaces)
  readonly className?: string
}): React.JSX.Element
export function clearModelSelectCache(): void
```

`value` is the string the form sends (`''` = none). The component owns an internal `mode: 'list' | 'other'`.

- [ ] **Step 1: Failing tests.** Create `apps/web/test/model-select.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelSelect, clearModelSelectCache } from '../src/components/ModelSelect.js'

const LISTING = { models: [{ id: 'auto', label: 'Auto', default: true }, { id: 'gpt-5.3-codex', label: 'Codex 5.3' }], source: 'account' }
const FAILED = { models: [], source: 'account', error: 'not logged in' }

function mockFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => clearModelSelectCache())
afterEach(() => vi.unstubAllGlobals())

describe('ModelSelect', () => {
  it('is disabled with a hint until a provider is chosen, and fetches nothing', () => {
    const fetchMock = mockFetch(LISTING)
    render(<ModelSelect provider="" value="" onChange={() => {}} ariaLabel="model" inputTestId="member-model-input" />)
    const select = screen.getByTestId('model-select') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(screen.getByText('choose a provider first')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lists the provider models with the default marked, none first and other… last', async () => {
    const fetchMock = mockFetch(LISTING)
    render(<ModelSelect provider="cursor" value="" onChange={() => {}} ariaLabel="model" inputTestId="member-model-input" />)
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(4))
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/cursor/models')
    const labels = screen.getAllByRole('option').map((o) => o.textContent)
    expect(labels).toEqual(['— none —', 'Auto (default)', 'Codex 5.3', 'other…'])
  })

  it('emits the chosen id, and other… reveals a text input carrying the old testid', async () => {
    mockFetch(LISTING)
    const onChange = vi.fn()
    render(<ModelSelect provider="cursor" value="" onChange={onChange} ariaLabel="model" inputTestId="member-model-input" />)
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(4))

    fireEvent.change(screen.getByTestId('model-select'), { target: { value: 'gpt-5.3-codex' } })
    expect(onChange).toHaveBeenLastCalledWith('gpt-5.3-codex')

    fireEvent.change(screen.getByTestId('model-select'), { target: { value: '__other__' } })
    const input = screen.getByTestId('member-model-input') as HTMLInputElement
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { value: 'my-custom-model' } })
    expect(onChange).toHaveBeenLastCalledWith('my-custom-model')
  })

  it('falls back to the text input with a note when the listing failed', async () => {
    mockFetch(FAILED)
    render(<ModelSelect provider="cursor" value="" onChange={() => {}} ariaLabel="model" inputTestId="member-model-input" />)
    await waitFor(() => expect(screen.getByTestId('model-select-note').textContent).toContain('not logged in'))
    expect(screen.getByTestId('member-model-input')).toBeTruthy()
    expect(screen.queryByTestId('model-select')).toBeNull()
  })

  it('shows a value that is not in the list as a selected extra option, changing nothing', async () => {
    mockFetch(LISTING)
    const onChange = vi.fn()
    render(<ModelSelect provider="cursor" value="legacy-id" onChange={onChange} ariaLabel="model" inputTestId="member-model-input" />)
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(5))
    expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('legacy-id')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shares one request per provider across instances', async () => {
    const fetchMock = mockFetch(LISTING)
    render(
      <>
        <ModelSelect provider="cursor" value="" onChange={() => {}} ariaLabel="a" inputTestId="a-input" />
        <ModelSelect provider="cursor" value="" onChange={() => {}} ariaLabel="b" inputTestId="b-input" />
      </>,
    )
    await waitFor(() => expect(screen.getAllByTestId('model-select').length).toBe(2))
    await act(async () => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: RED.** `npx vitest run apps/web/test/model-select.test.tsx` → module not found.

- [ ] **Step 3: The component.** Create `apps/web/src/components/ModelSelect.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import type { ModelListing, ProviderKind } from '@ai-team-os/control'
import { INPUT_SHELL } from './ui/FormControls'

const OTHER = '__other__'

// One in-flight/settled request per provider kind, shared by every instance on the page (three
// editors in the Agents table are one `GET`, not three). `clearModelSelectCache` is the test seam.
const listings = new Map<ProviderKind, Promise<ModelListing>>()

export function clearModelSelectCache(): void {
  listings.clear()
}

function listingFor(kind: ProviderKind): Promise<ModelListing> {
  const hit = listings.get(kind)
  if (hit !== undefined) return hit
  const promise = fetch(`/api/providers/${kind}/models`)
    .then(async (response) => (response.ok ? ((await response.json()) as ModelListing) : { models: [], source: 'account' as const, error: `request failed (${response.status})` }))
    .catch((error: unknown) => ({ models: [], source: 'account' as const, error: error instanceof Error ? error.message : 'request failed' }))
  listings.set(kind, promise)
  return promise
}

/**
 * The model field every form shares (M25 §5.3): a `<select>` fed by `GET /api/providers/<kind>/
 * models`, with `— none —` first and `other…` last. `other…` (or a failed listing) reveals a text
 * input that carries the testid the field had before this milestone (`inputTestId`), so the
 * existing tests and gates keep reading the same element. A `value` the list does not know
 * (typed before this milestone) is shown as a selected extra option and never rewritten.
 */
export function ModelSelect({
  provider,
  value,
  onChange,
  disabled = false,
  ariaLabel,
  inputTestId,
  className = '',
}: {
  readonly provider: ProviderKind | ''
  readonly value: string
  readonly onChange: (next: string) => void
  readonly disabled?: boolean
  readonly ariaLabel: string
  readonly inputTestId: string
  readonly className?: string
}): React.JSX.Element {
  const [listing, setListing] = useState<ModelListing | null>(null)
  const [mode, setMode] = useState<'list' | 'other'>('list')

  useEffect(() => {
    if (provider === '') {
      setListing(null)
      return
    }
    let cancelled = false
    setListing(null)
    void listingFor(provider).then((result) => {
      if (!cancelled) setListing(result)
    })
    return () => {
      cancelled = true
    }
  }, [provider])

  const shell = `${INPUT_SHELL} ${className}`.trim()

  if (provider === '') {
    return (
      <span className="flex flex-col gap-1">
        <select data-testid="model-select" aria-label={ariaLabel} disabled value="" className={shell} onChange={() => {}}>
          <option value="">— none —</option>
        </select>
        <span className="text-[10px] text-text-3">choose a provider first</span>
      </span>
    )
  }

  const failed = listing !== null && (listing.error !== undefined || listing.models.length === 0)
  if (mode === 'other' || failed) {
    return (
      <span className="flex flex-col gap-1">
        <input
          data-testid={inputTestId}
          aria-label={ariaLabel}
          value={value}
          disabled={disabled}
          placeholder="model"
          onChange={(event) => onChange(event.target.value)}
          className={`${shell} font-mono`}
        />
        {failed && listing?.error !== undefined ? (
          <span data-testid="model-select-note" className="text-[10px] text-text-3">model list unavailable: {listing.error}</span>
        ) : failed ? (
          <span data-testid="model-select-note" className="text-[10px] text-text-3">model list unavailable: empty</span>
        ) : (
          <button type="button" data-testid="model-select-back" onClick={() => setMode('list')} className="self-start text-[10px] text-text-3 hover:text-text-1">
            pick from the list
          </button>
        )}
      </span>
    )
  }

  const models = listing?.models ?? []
  const known = models.some((m) => m.id === value)
  return (
    <select
      data-testid="model-select"
      aria-label={ariaLabel}
      value={value}
      disabled={disabled || listing === null}
      className={shell}
      onChange={(event) => {
        if (event.target.value === OTHER) {
          setMode('other')
          return
        }
        onChange(event.target.value)
      }}
    >
      <option value="">— none —</option>
      {!known && value !== '' && <option value={value}>{value}</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.default === true ? `${m.label} (default)` : m.label}
        </option>
      ))}
      <option value={OTHER}>other…</option>
    </select>
  )
}
```

- [ ] **Step 4: GREEN on the component.** `npx vitest run apps/web/test/model-select.test.tsx` → 6 pass. If the "shares one request" case sees two calls, the two `useEffect`s ran before the first `listings.set` — `listingFor` is synchronous up to `set`, so this means `clearModelSelectCache` ran between; check the `beforeEach` order.

- [ ] **Step 5: Call sites.** In `ModelOverrideEditor.tsx` replace the `<input data-testid="model-override-input" …/>` with:

```tsx
      <ModelSelect
        provider={providerValue}
        value={value}
        onChange={setValue}
        disabled={pending}
        ariaLabel="model override"
        inputTestId="model-override-input"
        className="w-40 py-1 text-[11px]"
      />
```

(import `ModelSelect` from `./ModelSelect`), and rewrite the docstring's "a plain inline text input" to "a `ModelSelect` (the provider's list, `other…` for free text)". In `company/TeamBlock.tsx` replace the `TextField label="Model"` block with:

```tsx
        <label className="flex flex-col gap-1">
          <FieldLabel>Model</FieldLabel>
          <ModelSelect provider={provider} value={model} onChange={setModel} disabled={pending} ariaLabel="member model" inputTestId="member-model-input" className="w-40" />
        </label>
```

and move the Provider `<label>` ABOVE it (a model only lists once a provider is chosen). In `TemplateCatalog.tsx` do the same for the Default model field (`inputTestId="template-default-model-input"`, `ariaLabel="template default model"`, provider from `defaultProvider`), moving the Default provider field above it.

- [ ] **Step 6: Adapt the existing tests.** `apps/web/test/model-override-editor.test.tsx`: every case that does `fireEvent.change(screen.getByTestId('model-override-input'), …)` must first pick a provider then `other…`: add a helper at the top of the describe —

```tsx
  async function typeModel(value: string): Promise<void> {
    fireEvent.change(screen.getByTestId('model-override-provider'), { target: { value: 'claude_code' } })
    await waitFor(() => expect(screen.getByTestId('model-select')).toBeTruthy())
    fireEvent.change(screen.getByTestId('model-select'), { target: { value: '__other__' } })
    fireEvent.change(screen.getByTestId('model-override-input'), { target: { value } })
  }
```

with `fetchMock` also answering `GET /api/providers/claude_code/models` (`{ models: [{ id: 'opus', label: 'opus' }], source: 'static' }`) — branch on the URL in the mock; and `clearModelSelectCache()` in `beforeEach`. The POST assertions become `{ model: 'claude-opus-4', provider: 'claude_code' }` where they were bare `{ model }` (the provider is now always chosen first). Keep the 409 and resync cases; the resync case asserts the select's value instead of the input's. In `settings-page.test.tsx`'s `add-member form` and `TemplateCatalog` describes apply the same helper shape (`member-provider-select` → `model-select` → `__other__` → `member-model-input`; `template-default-provider-select` → … → `template-default-model-input`) and the same fetch branch; the "model omitted when blank" case still holds because `value` stays `''`.

- [ ] **Step 7: Verify.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/model-select.test.tsx apps/web/test/model-override-editor.test.tsx apps/web/test/settings-page.test.tsx apps/web/test/all-agents-table.test.tsx`; `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/components/ModelSelect.tsx apps/web/src/components/ModelOverrideEditor.tsx apps/web/src/components/company/TeamBlock.tsx apps/web/src/components/TemplateCatalog.tsx apps/web/test/model-select.test.tsx apps/web/test/model-override-editor.test.tsx apps/web/test/settings-page.test.tsx
git commit -m "feat(web): m25 t5 — ModelSelect: the provider's own list where a free-text model field was"
```

---

### Task 6: The Agents table's department select

**Files:**
- Modify: `apps/web/src/server/org.ts` (`WorkerRow`, `listWorkers`, `AllAgentRow`, `listAllAgents`), `apps/web/src/components/AllAgentsTable.tsx`, `apps/web/src/components/AgentsClient.tsx`, `apps/web/src/app/agents/page.tsx`, `scripts/gate-m14-fidelity.mjs` (only the `AGENTS_COLUMNS` string — the gate itself runs in Task 9)
- Test: `apps/web/test/all-agents-table.test.tsx`, `apps/web/test/agents-page.test.tsx`, `apps/web/test/integration/all-agents.test.ts`

**Interfaces:**
- Consumes `PUT /api/agents/:id/team`, `PUT /api/org/agents/:id/team` (Task 2).
- Produces:

```ts
// server/org.ts
export interface WorkerRow { …existing…; readonly teamId: string }           // new field
export interface AllAgentRow {
  …existing minus teamName…
  readonly departmentName: string        // was teamName
  readonly teamId: string | null         // project rows
  readonly companyId: string | null      // catalog rows (and roster-linked project rows)
  readonly companyTeamId: string | null  // catalog rows
}
export interface DepartmentOption { readonly id: string; readonly name: string }
export interface AllAgentsPage {
  readonly rows: readonly AllAgentRow[]
  readonly departmentsByWorkspace: Readonly<Record<string, readonly DepartmentOption[]>>
  readonly templatesByCompany: Readonly<Record<string, readonly DepartmentOption[]>>
}
export async function listAllAgents(): Promise<AllAgentsPage>
```
- `AllAgentsTable({ initial: AllAgentsPage; onOpen })`; `AgentsClient({ agents: AllAgentsPage; teams; … })`.

- [ ] **Step 1: Failing tests.** In `apps/web/test/all-agents-table.test.tsx`: update `row()` — rename `teamName` → `departmentName`, add `teamId: 't1', companyId: null, companyTeamId: null`; add a `page()` helper:

```tsx
function page(rows: readonly AllAgentRow[]): AllAgentsPage {
  return {
    rows,
    departmentsByWorkspace: { w1: [{ id: 't1', name: 'Engineering' }, { id: 't2', name: 'QA' }] },
    templatesByCompany: { c1: [{ id: 'ct1', name: 'Backend' }, { id: 'ct2', name: 'Design' }] },
  }
}
```

and change every `render(<AllAgentsTable initial={[…]} …/>)` to `initial={page([…])}`. Add to the file:

```tsx
describe('the department select', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('lists the project departments on a project row and PUTs the move, then refreshes', async () => {
    render(<AllAgentsTable initial={page([row({})])} onOpen={() => {}} />)
    const select = screen.getByTestId('agent-department') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Engineering', 'QA'])
    expect(select.value).toBe('t1')

    await act(async () => {
      fireEvent.change(select, { target: { value: 't2' } })
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/agents/a1/team', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ teamId: 't2' }) }))
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('lists the company templates on a catalog row and PUTs the catalog move', async () => {
    render(
      <AllAgentsTable
        initial={page([row({ agentId: null, workspaceId: null, projectName: null, teamId: null, companyAgentId: 'ca1', companyId: 'c1', companyTeamId: 'ct1', departmentName: 'Backend' })])}
        onOpen={() => {}}
      />,
    )
    const select = screen.getByTestId('agent-department') as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Backend', 'Design'])

    await act(async () => {
      fireEvent.change(select, { target: { value: 'ct2' } })
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/org/agents/ca1/team', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ companyTeamId: 'ct2' }) }))
  })

  it('renders a 409 under the cell and keeps the old value', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'agent a1 holds a live run' }), { status: 409 }))
    render(<AllAgentsTable initial={page([row({})])} onOpen={() => {}} />)

    await act(async () => {
      fireEvent.change(screen.getByTestId('agent-department'), { target: { value: 't2' } })
    })

    expect(screen.getByTestId('agent-department-error').textContent).toContain('live run')
    expect((screen.getByTestId('agent-department') as HTMLSelectElement).value).toBe('t1')
    expect(routerRefresh).not.toHaveBeenCalled()
  })
})
```

In the polling describe, extend `polledWorker()` with `teamId: 't1'` and add one case: a poll payload with `teamId: 't2', department: 'QA'` for a known row updates the select's value to `t2`. In `agents-page.test.tsx` update `agentRow()` the same way and pass `agents={page([…])}` (copy the `page` helper). In `apps/web/test/integration/all-agents.test.ts` assert on `(await listAllAgents()).rows` and that `departmentsByWorkspace[workspaceId]` lists the seeded project's departments by name and `templatesByCompany[companyId]` the seeded templates.

- [ ] **Step 2: RED.** `npx tsc -p apps/web/tsconfig.test.json --noEmit` → type errors on the new fields.

- [ ] **Step 3: Reads.** In `server/org.ts`: add `readonly teamId: string` to `WorkerRow` and `teamId: agent.team.id` (or `agent.teamId`) where `listWorkers` builds each row (find `department: agent.team.name`). Rewrite `AllAgentRow` per the Interfaces block (`teamName` → `departmentName`), add `DepartmentOption`, `AllAgentsPage`, and make `listAllAgents` return the page: alongside the two existing reads add

```ts
  const [teams, companyTeams] = await Promise.all([
    prisma.team.findMany({ select: { id: true, name: true, workspaceId: true }, orderBy: { name: 'asc' } }),
    prisma.companyTeam.findMany({ select: { id: true, name: true, companyId: true }, orderBy: { name: 'asc' } }),
  ])
  const departmentsByWorkspace: Record<string, DepartmentOption[]> = {}
  for (const t of teams) (departmentsByWorkspace[t.workspaceId] ??= []).push({ id: t.id, name: t.name })
  const templatesByCompany: Record<string, DepartmentOption[]> = {}
  for (const t of companyTeams) (templatesByCompany[t.companyId] ??= []).push({ id: t.id, name: t.name })
```

Worker rows: `departmentName: w.department, teamId: w.teamId, companyId: null, companyTeamId: null`; the roster loop sets `companyId: company.companyId` on a linked worker row; catalog rows: `departmentName: team.teamName, teamId: null, companyId: company.companyId, companyTeamId: team.companyTeamId`. Return `{ rows: [...projectRows, ...catalogRows], departmentsByWorkspace, templatesByCompany }`. Update the docstring.

- [ ] **Step 4: The table.** In `AllAgentsTable.tsx`: `COLUMNS = '200px 110px 150px 120px 110px 1fr 90px 90px 160px'`, `HEADER[2] = 'Department'`; props `initial: AllAgentsPage`; state `rows` from `initial.rows`; `PolledWorker` gains `teamId: string`; the merge copies `teamId: w.teamId, departmentName: w.department`, the append sets `teamId: w.teamId, departmentName: w.department, companyId: null, companyTeamId: null`. Replace the department `<span>` with a `DepartmentCell`:

```tsx
function DepartmentCell({ row, page }: { readonly row: AllAgentRow; readonly page: AllAgentsPage }): React.JSX.Element {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const isProject = row.agentId !== null && row.workspaceId !== null
  const options = isProject
    ? (page.departmentsByWorkspace[row.workspaceId ?? ''] ?? [])
    : (page.templatesByCompany[row.companyId ?? ''] ?? [])
  const current = isProject ? (row.teamId ?? '') : (row.companyTeamId ?? '')

  const move = async (next: string): Promise<void> => {
    if (next === current || next === '') return
    setPending(true)
    setErrorText(null)
    const error =
      isProject && row.agentId !== null
        ? await sendControl(`/api/agents/${row.agentId}/team`, { method: 'PUT', body: { teamId: next } })
        : await sendControl(`/api/org/agents/${row.companyAgentId ?? ''}/team`, { method: 'PUT', body: { companyTeamId: next } })
    setPending(false)
    if (error === null) router.refresh()
    else setErrorText(error)
  }

  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <select
        data-testid="agent-department"
        aria-label="department"
        value={current}
        disabled={pending || options.length === 0}
        onChange={(event) => void move(event.target.value)}
        className="w-full rounded border border-line bg-bg-2 px-1.5 py-1 text-[11px] text-text-1"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      {errorText !== null && (
        <span role="alert" data-testid="agent-department-error" className="text-[10px] text-tone-blocked">
          {errorText}
        </span>
      )}
    </span>
  )
}
```

(`useRouter` from `next/navigation`, `sendControl` from `../lib/postControl`.) The controlled `value={current}` is what keeps the old value on a 409 — the row prop does not change until `router.refresh()`. In `AgentsClient.tsx`: prop `agents: AllAgentsPage`, pass `initial={agents}`. In `app/agents/page.tsx` nothing changes but the docstring ("the page object: rows plus the department options"). In `scripts/gate-m14-fidelity.mjs` set `AGENTS_COLUMNS` to the new string and update the comment's "130" to "150".

- [ ] **Step 5: GREEN.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/all-agents-table.test.tsx apps/web/test/agents-page.test.tsx apps/web/test/integration/all-agents.test.ts`; then `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/server/org.ts apps/web/src/components/AllAgentsTable.tsx apps/web/src/components/AgentsClient.tsx apps/web/src/app/agents/page.tsx scripts/gate-m14-fidelity.mjs apps/web/test/all-agents-table.test.tsx apps/web/test/agents-page.test.tsx apps/web/test/integration/all-agents.test.ts
git commit -m "feat(web): m25 t6 — the Agents table's department is a select; the page carries the options"
```

---

### Task 7: The Departments tab and the catalog's template rename/delete

**Files:**
- Rename: `apps/web/src/components/TeamsTable.tsx` → `apps/web/src/components/DepartmentsTable.tsx`; `apps/web/test/teams-table.test.tsx` → `apps/web/test/departments-table.test.tsx` (both with `git mv`)
- Modify: `apps/web/src/components/AgentsClient.tsx`, `apps/web/src/app/agents/page.tsx`, `apps/web/src/components/company/CompanyDetail.tsx`, `apps/web/src/components/company/TeamBlock.tsx`
- Test: `apps/web/test/departments-table.test.tsx`, `apps/web/test/agents-page.test.tsx`, `apps/web/test/settings-page.test.tsx` (the `CompanyManager` describes)

**Interfaces:**
- Consumes `POST /api/w/:id/teams`, `PUT /api/org/teams/:id/name`, `DELETE /api/org/teams/:id` (Task 2); `listWorkspaceNames()` (`server/org.ts`).
- Produces `DepartmentsTable({ teams: readonly ProjectTeamRow[]; workspaces: readonly { id: string; name: string }[] })`; `AgentsClient` gains `workspaces` and its tab id `'departments'`.

- [ ] **Step 1: Rename and failing tests.** `git mv apps/web/src/components/TeamsTable.tsx apps/web/src/components/DepartmentsTable.tsx && git mv apps/web/test/teams-table.test.tsx apps/web/test/departments-table.test.tsx`. In the test: import `DepartmentsTable`, rename every `team-*` testid to `department-*` (`department-rename`, `department-name-input`, `department-delete`, `department-delete-confirm`, `department-delete-cancel`, `department-actions-error`), the empty text to `'no departments yet.'`, pass `workspaces={[{ id: 'w1', name: 'Checkout' }]}` everywhere, and add:

```tsx
describe('the New department form', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, id: 't9' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('posts { name } to the chosen project and refreshes', async () => {
    render(<DepartmentsTable teams={[]} workspaces={[{ id: 'w1', name: 'Checkout' }, { id: 'w2', name: 'Billing' }]} />)
    fireEvent.change(screen.getByTestId('department-project-select'), { target: { value: 'w2' } })
    fireEvent.change(screen.getByTestId('department-name-input'), { target: { value: 'Design' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('department-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w2/teams', expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Design' }) }))
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('renders a 409 beside the form', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'a department named Design already exists' }), { status: 409 }))
    render(<DepartmentsTable teams={[]} workspaces={[{ id: 'w1', name: 'Checkout' }]} />)
    fireEvent.change(screen.getByTestId('department-name-input'), { target: { value: 'Design' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('department-submit'))
    })
    expect(screen.getByTestId('department-error').textContent).toContain('Design')
  })

  it('is disabled with a hint when the install has no project', () => {
    render(<DepartmentsTable teams={[]} workspaces={[]} />)
    expect((screen.getByTestId('department-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('attach a project first')).toBeTruthy()
  })
})
```

Note the existing rename input testid `team-name-input` inside a row becomes `department-rename-input` (the form's input owns `department-name-input`). In `agents-page.test.tsx`: tab labels `['Agents', 'Departments']`, testid `agents-tab-departments`, `department-rename`, pass `workspaces={[]}`. In `settings-page.test.tsx`'s `CompanyManager` describes: `add-team-form` → `department-template-form`, `team-submit` → `department-template-submit`, `team-name-input` → `department-template-name-input`, `team-error` → `department-template-error`, `team-block` → `department-template-block`, aria `'team name'` → `'department name'`; add two cases under `expanding a company`:

```tsx
    it('renames a department template inline and refreshes', async () => {
      // fetchMock as the sibling cases build it
      render(<CompanyManager companies={companies} roster={roster} templates={[]} />)
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.click(screen.getByTestId('department-template-rename'))
      fireEvent.change(screen.getByTestId('department-template-rename-input'), { target: { value: 'Platform' } })
      await act(async () => {
        fireEvent.keyDown(screen.getByTestId('department-template-rename-input'), { key: 'Enter' })
      })
      expect(fetchMock).toHaveBeenCalledWith('/api/org/teams/ct1/name', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'Platform' }) }))
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('disables delete while the template has members, and DELETEs an empty one', async () => {
      render(<CompanyManager companies={companies} roster={roster} templates={[]} />)
      fireEvent.click(screen.getByTestId('company-toggle'))
      const buttons = screen.getAllByTestId('department-template-delete') as HTMLButtonElement[]
      // roster fixture: first template has a member, second is empty -- adjust to the file's fixture
      expect(buttons[0]?.disabled).toBe(true)
      await act(async () => {
        fireEvent.click(buttons[1] as HTMLButtonElement)
      })
      expect(fetchMock).toHaveBeenCalledWith('/api/org/teams/ct2/name'.replace('/name', ''), expect.objectContaining({ method: 'DELETE' }))
    })
```

(Read the file's roster fixture and use its real `companyTeamId`s in place of `ct1`/`ct2`; give it an empty second template if it has none.)

- [ ] **Step 2: RED.** `npx tsc -p apps/web/tsconfig.test.json --noEmit` → missing module/testids.

- [ ] **Step 3: `DepartmentsTable`.** In the renamed file: export `DepartmentsTable`, rename `TeamRow` → `DepartmentRow`, `HEADER = ['Project', 'Department', 'Agents', '']`, empty text `no departments yet.`, testids per Step 1 (`department-rename`, `department-rename-input`, …), aria-label `'department name'`, `title` "department has agents". Add the form above the table (rendered even when `teams` is empty — move the empty-state `<p>` below the form):

```tsx
function NewDepartmentForm({ workspaces }: { readonly workspaces: readonly { id: string; name: string }[] }): React.JSX.Element {
  const router = useRouter()
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '')
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const none = workspaces.length === 0

  const submit = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const error = await sendControl(`/api/w/${workspaceId}/teams`, { method: 'POST', body: { name } })
    setPending(false)
    if (error === null) {
      setName('')
      router.refresh()
    } else {
      setErrorText(error)
    }
  }

  return (
    <form
      data-testid="department-form"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <SelectField
        label="Project"
        selectProps={{
          'aria-label': 'department project',
          'data-testid': 'department-project-select',
          value: workspaceId,
          onChange: (event) => setWorkspaceId(event.target.value),
          disabled: pending || none,
          className: 'w-44',
        } as React.SelectHTMLAttributes<HTMLSelectElement>}
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </SelectField>
      <TextField
        label="Department"
        inputProps={{
          'aria-label': 'new department name',
          'data-testid': 'department-name-input',
          value: name,
          onChange: (event) => setName(event.target.value),
          disabled: pending || none,
          className: 'w-44',
        } as React.InputHTMLAttributes<HTMLInputElement>}
      />
      <PrimaryButton type="submit" data-testid="department-submit" disabled={pending || none || name === ''}>
        New department
      </PrimaryButton>
      {none && <span className="text-xs text-text-3">attach a project first</span>}
      {errorText !== null && (
        <span role="alert" data-testid="department-error" className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}
    </form>
  )
}

export function DepartmentsTable({
  teams,
  workspaces,
}: {
  readonly teams: readonly ProjectTeamRow[]
  readonly workspaces: readonly { id: string; name: string }[]
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <NewDepartmentForm workspaces={workspaces} />
      {teams.length === 0 ? (
        <p className="text-xs text-text-3">no departments yet.</p>
      ) : (
        <DataTable columns={COLUMNS} header={[...HEADER]}>
          {teams.map((team) => (
            <DepartmentRow key={team.teamId} team={team} />
          ))}
        </DataTable>
      )}
    </div>
  )
}
```

(import `SelectField` alongside `PrimaryButton, TextField`.) Rewrite the file's docstrings: "team" → "department".

- [ ] **Step 4: `AgentsClient` and the page.** `type Tab = 'agents' | 'departments'`, `TABS = [{ id: 'agents', label: 'Agents' }, { id: 'departments', label: 'Departments' }]`, prop `workspaces: readonly { id: string; name: string }[]`, render `<DepartmentsTable teams={teams} workspaces={workspaces} />` on `tab === 'departments'`; docstrings "Teams tab" → "Departments tab". Page: `const [agents, teams, workspaces] = await Promise.all([listAllAgents(), listProjectTeams(), listWorkspaceNames()])` and pass `workspaces`.

- [ ] **Step 5: The catalog.** `CompanyDetail.tsx`: testids `department-template-form` / `department-template-name-input` / `department-template-submit` / `department-template-error`, label "Department", aria `'department name'`, button "Add department", empty text "no departments yet.". `TeamBlock.tsx`: `data-testid="department-template-block"`; replace `<SectionLabel>{teamName}</SectionLabel>` with a header row holding inline rename + delete, modelled on `DepartmentsTable`'s row:

```tsx
      <div className="flex items-center gap-2">
        {renaming ? (
          <TextField
            inputProps={{
              'aria-label': 'department template name',
              'data-testid': 'department-template-rename-input',
              value: draft,
              autoFocus: true,
              disabled: pending,
              onChange: (event) => setDraft(event.target.value),
              onBlur: () => void commitRename(),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void commitRename()
                if (event.key === 'Escape') setRenaming(false)
              },
              className: 'w-44',
            } as React.InputHTMLAttributes<HTMLInputElement>}
          />
        ) : (
          <button type="button" data-testid="department-template-rename" onClick={() => { setDraft(teamName); setErrorText(null); setRenaming(true) }} className="text-left">
            <SectionLabel>{teamName}</SectionLabel>
          </button>
        )}
        <GhostButton
          type="button"
          data-testid="department-template-delete"
          disabled={pending || members.length > 0}
          title={members.length > 0 ? 'department template has members' : undefined}
          onClick={() => void remove()}
        >
          delete
        </GhostButton>
        {errorText !== null && (
          <span role="alert" data-testid="department-template-error" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </div>
```

with `commitRename` → `sendControl(\`/api/org/teams/${companyTeamId}/name\`, { method: 'PUT', body: { name: draft } })` and `remove` → `sendControl(\`/api/org/teams/${companyTeamId}\`, { method: 'DELETE' })`, both `router.refresh()` on success, the `renaming`/`draft` state guarded by `pending` exactly as `DepartmentsTable`'s row does. Keep the add-member form's own `errorText` separate (`member-error`). Docstrings: "team" → "department template".

- [ ] **Step 6: Verify.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/departments-table.test.tsx apps/web/test/agents-page.test.tsx apps/web/test/settings-page.test.tsx apps/web/test/projects-page.test.tsx`; `grep -rn "TeamsTable\|agents-tab-teams\|team-rename\|team-block\|add-team-form" apps/web/src apps/web/test` → nothing; `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 7: Commit.**

```bash
git add apps/web/src/components/DepartmentsTable.tsx apps/web/src/components/AgentsClient.tsx apps/web/src/app/agents/page.tsx apps/web/src/components/company/CompanyDetail.tsx apps/web/src/components/company/TeamBlock.tsx apps/web/test/departments-table.test.tsx apps/web/test/agents-page.test.tsx apps/web/test/settings-page.test.tsx
git commit -m "feat(web): m25 t7 — Departments tab with a New department form; the catalog's templates rename and delete"
```

(`git mv` already staged the renames; `git status` must show `renamed:` for both files.)

---

### Task 8: The New agent drawer

**Files:**
- Create: `apps/web/src/components/agents/NewAgentDrawer.tsx`, `apps/web/test/new-agent-drawer.test.tsx`
- Modify: `apps/web/src/components/AgentsClient.tsx` (header row + drawer), `apps/web/src/app/agents/page.tsx` (loads `listCompanies`, `listRoster`, `listTemplates`)
- Test: `apps/web/test/agents-page.test.tsx`

**Interfaces:**
- Consumes `POST /api/org/agents` (`{ companyTeamId, templateId, name, model?, provider? }`), `POST /api/org/teams` (`{ companyId, name }`), `POST /api/w/:id/company` (`{ companyId }`), `ModelSelect` (Task 5), `ProviderSelect`; `RosterCompany` (`server/org.ts`: `companyId`, `companyName`, `teams[{ companyTeamId, teamName, members }]`), `TemplateRow` (`components/TemplateCatalog.tsx`), `listCompanies()` → `{ id, name }[]`.
- Produces `NewAgentDrawer({ open, onClose, companies, roster, templates, workspaces })`; `AgentsClient` gains `companies`, `roster`, `templates` props and the `new-agent` button.

- [ ] **Step 1: Failing tests.** Create `apps/web/test/new-agent-drawer.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewAgentDrawer } from '../src/components/agents/NewAgentDrawer.js'
import { clearModelSelectCache } from '../src/components/ModelSelect.js'
import type { RosterCompany } from '../src/server/org.js'

const routerRefresh = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh }) }))

const companies = [{ id: 'c1', name: 'Atlas Software' }]
const roster: readonly RosterCompany[] = [
  { companyId: 'c1', companyName: 'Atlas Software', teams: [{ companyTeamId: 'ct1', teamName: 'Backend', members: [] }] },
]
const templates = [{ id: 'tpl1', name: 'Backend Developer', role: 'backend', description: '', defaultModel: null, defaultProvider: null }]
const workspaces = [{ id: 'w1', name: 'Checkout' }]

function drawer(onClose = vi.fn()): ReturnType<typeof render> {
  return render(<NewAgentDrawer open onClose={onClose} companies={companies} roster={roster} templates={templates} workspaces={workspaces} />)
}

async function fillCore(): Promise<void> {
  fireEvent.change(screen.getByTestId('new-agent-company'), { target: { value: 'c1' } })
  fireEvent.change(screen.getByTestId('new-agent-department'), { target: { value: 'ct1' } })
  fireEvent.change(screen.getByTestId('new-agent-template'), { target: { value: 'tpl1' } })
  fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'Sam' } })
}

describe('NewAgentDrawer', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    clearModelSelectCache()
    routerRefresh.mockClear()
    fetchMock = vi.fn(async (url: string) =>
      url.startsWith('/api/providers/')
        ? new Response(JSON.stringify({ models: [{ id: 'opus', label: 'opus' }], source: 'static' }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('posts the catalog agent and closes when no project is chosen', async () => {
    const onClose = vi.fn()
    drawer(onClose)
    await fillCore()
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-agent-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/agents', expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyTeamId: 'ct1', templateId: 'tpl1', name: 'Sam' }) }))
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/company'))).toBe(false)
    expect(onClose).toHaveBeenCalled()
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('sends model+provider when both are chosen', async () => {
    drawer()
    await fillCore()
    fireEvent.change(screen.getByTestId('new-agent-provider'), { target: { value: 'claude_code' } })
    await waitFor(() => expect(screen.getByTestId('model-select')).toBeTruthy())
    fireEvent.change(screen.getByTestId('model-select'), { target: { value: 'opus' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-agent-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/agents', expect.objectContaining({ body: JSON.stringify({ companyTeamId: 'ct1', templateId: 'tpl1', name: 'Sam', model: 'opus', provider: 'claude_code' }) }))
  })

  it('then assigns the company to the chosen project', async () => {
    drawer()
    await fillCore()
    fireEvent.change(screen.getByTestId('new-agent-project'), { target: { value: 'w1' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-agent-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/company', expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyId: 'c1' }) }))
  })

  it('keeps the drawer open with the second step\'s refusal when assign is refused', async () => {
    const onClose = vi.fn()
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/company')
        ? new Response(JSON.stringify({ error: 'a budget needs a provider that reports cost' }), { status: 409 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    drawer(onClose)
    await fillCore()
    fireEvent.change(screen.getByTestId('new-agent-project'), { target: { value: 'w1' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-agent-submit'))
    })
    expect(screen.getByTestId('new-agent-error').textContent).toContain('reports cost')
    expect(screen.getByText(/catalog agent created; assign from the project card/)).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('"new department…" creates the template first, then the agent in it', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url) === '/api/org/teams'
        ? new Response(JSON.stringify({ ok: true, id: 'ct9' }), { status: 200 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )
    drawer()
    fireEvent.change(screen.getByTestId('new-agent-company'), { target: { value: 'c1' } })
    fireEvent.change(screen.getByTestId('new-agent-department'), { target: { value: '__new__' } })
    fireEvent.change(screen.getByTestId('new-agent-department-name'), { target: { value: 'Design' } })
    fireEvent.change(screen.getByTestId('new-agent-template'), { target: { value: 'tpl1' } })
    fireEvent.change(screen.getByTestId('new-agent-name'), { target: { value: 'Sam' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-agent-submit'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/teams', expect.objectContaining({ body: JSON.stringify({ companyId: 'c1', name: 'Design' }) }))
    expect(fetchMock).toHaveBeenCalledWith('/api/org/agents', expect.objectContaining({ body: JSON.stringify({ companyTeamId: 'ct9', templateId: 'tpl1', name: 'Sam' }) }))
  })

  it('closes on Escape and on the close button', () => {
    const onClose = vi.fn()
    drawer(onClose)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('new-agent-close'))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
```

`POST /api/org/teams` today answers `{ ok: true }` without the id (Task 2 left it alone). The drawer needs the new template's id, so this task also changes that route to answer `{ ok: true, id }` the way Task 2's `POST /api/w/:id/teams` does (`addCompanyTeam` already returns `{ id }`): in `apps/web/src/app/api/org/teams/route.ts` replace `orgControlResponse(() => addCompanyTeam(companyId, name))` with the explicit `result.ok ? Response.json({ ok: true, id: result.value.id }) : Response.json({ error: refusalText(result.error) }, { status: 409 })` form, importing `refusalText` from `@ai-team-os/control`. Add to `settings-page.test.tsx`'s `add-team form` case nothing (it asserts the request, not the response). In `agents-page.test.tsx` add: clicking `new-agent` renders `role="dialog"` named /new agent/i; pass `companies={[]} roster={[]} templates={[]}`.

- [ ] **Step 2: RED.** `npx vitest run apps/web/test/new-agent-drawer.test.tsx` → module not found.

- [ ] **Step 3: The drawer.** Create `apps/web/src/components/agents/NewAgentDrawer.tsx`:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderKind } from '@ai-team-os/control'
import type { RosterCompany } from '../../server/org'
import { postControl, sendControl } from '../../lib/postControl'
import { ModelSelect } from '../ModelSelect'
import { ProviderSelect } from '../ProviderSelect'
import type { TemplateRow } from '../TemplateCatalog'
import { FieldLabel, INPUT_SHELL, PrimaryButton, SelectField, TextField } from '../ui/FormControls'

const NEW_DEPARTMENT = '__new__'

/**
 * "New agent" (M25 §6): the catalog form -- company, department template, agent template, name,
 * provider+model -- with an optional "assign to project" step. Two existing calls in sequence:
 * `POST /api/org/agents`, then `POST /api/w/:id/company` when a project was chosen. If the first
 * succeeds and the second is refused, the drawer stays open showing the refusal and says the
 * catalog row exists (nothing is rolled back). `NewProjectDrawer`'s frame: scrim, dialog, Escape.
 */
export function NewAgentDrawer({
  open,
  onClose,
  companies,
  roster,
  templates,
  workspaces,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly companies: readonly { readonly id: string; readonly name: string }[]
  readonly roster: readonly RosterCompany[]
  readonly templates: readonly TemplateRow[]
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
}): React.JSX.Element | null {
  const router = useRouter()
  const [companyId, setCompanyId] = useState('')
  const [companyTeamId, setCompanyTeamId] = useState('')
  const [newDepartment, setNewDepartment] = useState('')
  const [templateId, setTemplateId] = useState('')
  const [name, setName] = useState('')
  const [provider, setProvider] = useState<ProviderKind | ''>('')
  const [model, setModel] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [createdButUnassigned, setCreatedButUnassigned] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const departments = roster.find((c) => c.companyId === companyId)?.teams ?? []
  const ready =
    companyId !== '' &&
    templateId !== '' &&
    name.trim() !== '' &&
    (companyTeamId === NEW_DEPARTMENT ? newDepartment.trim() !== '' : companyTeamId !== '')

  const submit = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    setCreatedButUnassigned(false)
    let targetTeam = companyTeamId
    if (companyTeamId === NEW_DEPARTMENT) {
      const created = await fetch('/api/org/teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ companyId, name: newDepartment }),
      })
      const data = (await created.json().catch(() => null)) as { id?: string; error?: string } | null
      if (!created.ok || data?.id === undefined) {
        setErrorText(data?.error ?? `request failed (${created.status})`)
        setPending(false)
        return
      }
      targetTeam = data.id
    }
    const agent = await postControl('/api/org/agents', {
      companyTeamId: targetTeam,
      templateId,
      name,
      // The pair rule (`pairRefusal`): a provider never travels without a model.
      ...(model !== '' ? { model, ...(provider !== '' ? { provider } : {}) } : {}),
    })
    if (!agent.ok) {
      setErrorText(agent.error)
      setPending(false)
      return
    }
    if (workspaceId !== '') {
      const error = await sendControl(`/api/w/${workspaceId}/company`, { method: 'POST', body: { companyId } })
      if (error !== null) {
        setErrorText(error)
        setCreatedButUnassigned(true)
        setPending(false)
        router.refresh()
        return
      }
    }
    setPending(false)
    router.refresh()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button type="button" aria-label="close" data-testid="new-agent-scrim" onClick={onClose} className="flex-1 bg-black/50" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="New agent"
        data-testid="new-agent-drawer"
        className="flex w-[520px] max-w-full flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-5 shadow-[0_6px_22px_rgba(0,0,0,.45)]"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[14.5px] font-semibold tracking-[-.2px] text-text-1">New agent</h2>
          <button type="button" data-testid="new-agent-close" onClick={onClose} className="text-text-3 hover:text-text-1">
            ✕
          </button>
        </div>
        <p className="text-xs text-text-3">add an agent to a company's catalog — and, if you pick a project, put it to work there now</p>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <SelectField
            label="Company"
            selectProps={{ 'aria-label': 'company', 'data-testid': 'new-agent-company', value: companyId, disabled: pending, onChange: (event) => { setCompanyId(event.target.value); setCompanyTeamId('') } } as React.SelectHTMLAttributes<HTMLSelectElement>}
          >
            <option value="">select a company</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </SelectField>
          <SelectField
            label="Department"
            selectProps={{ 'aria-label': 'department template', 'data-testid': 'new-agent-department', value: companyTeamId, disabled: pending || companyId === '', onChange: (event) => setCompanyTeamId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}
          >
            <option value="">select a department</option>
            {departments.map((d) => (
              <option key={d.companyTeamId} value={d.companyTeamId}>{d.teamName}</option>
            ))}
            <option value={NEW_DEPARTMENT}>new department…</option>
          </SelectField>
          {companyTeamId === NEW_DEPARTMENT && (
            <TextField
              label="New department name"
              inputProps={{ 'aria-label': 'new department name', 'data-testid': 'new-agent-department-name', value: newDepartment, disabled: pending, onChange: (event) => setNewDepartment(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>}
            />
          )}
          <SelectField
            label="Template"
            selectProps={{ 'aria-label': 'agent template', 'data-testid': 'new-agent-template', value: templateId, disabled: pending, onChange: (event) => setTemplateId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}
          >
            <option value="">select a template</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </SelectField>
          <TextField
            label="Name"
            inputProps={{ 'aria-label': 'agent name', 'data-testid': 'new-agent-name', value: name, disabled: pending, onChange: (event) => setName(event.target.value) } as React.InputHTMLAttributes<HTMLInputElement>}
          />
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1">
              <FieldLabel>Provider</FieldLabel>
              <ProviderSelect testId="new-agent-provider" ariaLabel="provider" value={provider} onChange={setProvider} disabled={pending} placeholder="select a provider" className={`w-40 ${INPUT_SHELL}`} />
            </label>
            <label className="flex flex-col gap-1">
              <FieldLabel>Model</FieldLabel>
              <ModelSelect provider={provider} value={model} onChange={setModel} disabled={pending} ariaLabel="model" inputTestId="new-agent-model-input" className="w-52" />
            </label>
          </div>
          <SelectField
            label="Assign to project (optional)"
            selectProps={{ 'aria-label': 'assign to project', 'data-testid': 'new-agent-project', value: workspaceId, disabled: pending, onChange: (event) => setWorkspaceId(event.target.value) } as React.SelectHTMLAttributes<HTMLSelectElement>}
          >
            <option value="">catalog only</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </SelectField>
          <div className="flex items-center gap-3">
            <PrimaryButton type="submit" data-testid="new-agent-submit" disabled={pending || !ready}>
              {pending ? 'creating…' : 'Create agent'}
            </PrimaryButton>
            {errorText !== null && (
              <span role="alert" data-testid="new-agent-error" className="text-xs text-tone-blocked">
                {errorText}
              </span>
            )}
          </div>
          {createdButUnassigned && <p className="text-xs text-text-3">catalog agent created; assign from the project card</p>}
        </form>
      </aside>
    </div>
  )
}
```

- [ ] **Step 4: Wire it.** `AgentsClient` props gain `companies`, `roster`, `templates` (types as above); state `const [newOpen, setNewOpen] = useState(false)`; the tab row becomes a header row `flex items-center justify-between` with the tablist on the left and `<PrimaryButton data-testid="new-agent" onClick={() => setNewOpen(true)}>+ New agent</PrimaryButton>` on the right; render `<NewAgentDrawer open={newOpen} onClose={() => setNewOpen(false)} companies={companies} roster={roster} templates={templates} workspaces={workspaces} />` after the table. Page: `const [agents, teams, workspaces, companies, roster, templates] = await Promise.all([listAllAgents(), listProjectTeams(), listWorkspaceNames(), listCompanies(), listRoster(), listTemplates()])` and pass them. Docstrings updated ("+ New agent opens the catalog form").

- [ ] **Step 5: Verify.** `npx tsc -p apps/web/tsconfig.test.json --noEmit`; `npx vitest run apps/web/test/new-agent-drawer.test.tsx apps/web/test/agents-page.test.tsx apps/web/test/settings-page.test.tsx`; `npm run web:build && rm -rf apps/web/.next`.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/components/agents/NewAgentDrawer.tsx apps/web/src/components/AgentsClient.tsx apps/web/src/app/agents/page.tsx apps/web/src/app/api/org/teams/route.ts apps/web/test/new-agent-drawer.test.tsx apps/web/test/agents-page.test.tsx
git commit -m "feat(web): m25 t8 — New agent: the catalog form in a drawer, with an optional assign step"
```

---

### Task 9: Gates, README, Errata, closing run

**Files:**
- Modify: `scripts/gate-m11-shell.mjs`, `scripts/gate-m14-fidelity.mjs` (its Agents stage; `AGENTS_COLUMNS` already changed in Task 6), `docs/superpowers/fidelity/m14/*.png` (regenerated), `README.md` (Web UI table: Projects and Agents rows; the "manage it on … the Agents page" sentence), the spec's §12

- [ ] **Step 1: Inventory.** `grep -nE "team-block|team-submit|team-error|team-name-input|add-team-form|agents-tab-teams|team name|Add team|model-input|member-model|default-model" scripts/gate-m11-shell.mjs scripts/gate-m14-fidelity.mjs scripts/gate-m16-chrome.mjs scripts/gate-m18-skill-and-teeth.mjs` — write the list into the report before editing. (`team-catalog`, `team-overflow`, `team-size`, `team-node` are NOT department rows and stay.)

- [ ] **Step 2: m11.** In `gate-m11-shell.mjs` stage 1: `getByLabel('team name')` → `getByLabel('department name')`, `team-block` → `department-template-block`, `team-submit` → `department-template-submit`; the member form: after selecting the template and filling the name, if the stage fills a model, it must first select a provider (`member-provider-select`) then pick `__other__` in `model-select` and fill `member-model-input` — read the stage and mirror the test helper from Task 5. Add one stage after the roster assertions on `/agents`: change the seeded member's `agent-department` select (the row filtered by `MEMBER_NAME`) to another department of the same project created through `POST /api/w/:id/teams` (use `page.request.post` or `prisma.team.create` — the gate already uses Prisma for assertions) and assert `prisma.agent.findFirst({ where: { name: MEMBER_NAME } })` now has that `teamId`. Run `CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome npm run gate:m11-shell` → PASS.

- [ ] **Step 3: m14.** `agents-tab-teams` → `agents-tab-departments` in the Agents stage; the column comment names 150 for the third track. Run `AITEAMOS_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome npm run gate:m14-fidelity` → PASS; `git add docs/superpowers/fidelity/m14/*.png`.

- [ ] **Step 4: README.** Web UI table: the **Projects** row's "the team catalog (agent templates and companies)" → "the team catalog (agent templates, companies and their department templates)"; the **Agents** row → "One table + Departments: every agent, project-materialized or still catalog-only, with its department as a select, rename/re-role/delete and a model chosen from the provider's own list inline; **+ New agent** adds one to the catalog and, optionally, to a project; a **Departments** tab beside it to add, rename or delete a project's departments." The sentence "manage it on the Projects page's team catalog and the Agents page" stays true; add after it: "Departments are per project; the catalog holds department templates that `assign-company` copies."

- [ ] **Step 5: Errata.** Spec §12, numbered:
  1. The template-not-empty refusal is its own kind, `company_team_not_empty` (§3.1 wrote `team_not_empty`, whose text and `teamId` field name a project department).
  2. `listProviderModels(kind)` lives in `packages/providers/src/models.ts` and is re-exported through `@ai-team-os/control`; the web reads it by kind and never constructs an adapter (M12 R10). The adapters' `listModels()` delegate to it (§5.1's "adapter contract" holds; the web's entry point is the function).
  3. `POST /api/org/teams` now answers `{ ok: true, id }` (the drawer's "new department…" needs the id).
  4. `AllAgentRow.teamName` became `departmentName`; `WorkerRow` gained `teamId` so the 5 s poll can move a row's department.
  5. `ModelSelect`'s `other…` input keeps the old testids (`model-override-input`, `member-model-input`, `template-default-model-input`); tests and gates reach it by choosing a provider, then `other…`.
  6. Anything else the execution ledger records as a `Ruling:`.

- [ ] **Step 6: Closing run.** `npm run typecheck`; `npm test` (600 s budget); `npm run web:build && rm -rf apps/web/.next`; gates in order, none overlapping: `gate:m15-boundary`, `gate:m20-auth`, `gate:m21-loose-ends`, `gate:m23-onboarding`, `gate:m14-fidelity`, `gate:m16-chrome`, `gate:m11-shell`, `gate:m18-skill-and-teeth` (the same `AITEAMOS_CLAUDE_BIN`/`CHROMIUM_PATH` env as above for m14/m18/m23). Record every PASS line.

- [ ] **Step 7: Commit.**

```bash
git add scripts/gate-m11-shell.mjs scripts/gate-m14-fidelity.mjs docs/superpowers/fidelity/m14 README.md docs/superpowers/specs/2026-09-04-m25-departments-agents-and-models-design.md
git commit -m "test(gates),docs: m25 t9 — the gates read departments and the model select; errata and README"
```

## Closing verification (after Task 9, before the final review)

- Everything in Task 9 Step 6 green at HEAD.
- Final whole-branch review (most capable model), one fix wave, one scoped re-review; then merge fast-forward, push (the pre-push hook runs the suite — budget 600 s), update the memory backlog line.

## Self-review against the spec

- §2 vocabulary → T6 (table), T7 (tab, catalog), T9 (README). §3.1 verbs → T1. §3.2 routes → T2 (+ T8's `org/teams` id). §3.3 CLI → T1. §3.4 reads → T6. §4.1 → T6. §4.2 → T7. §4.3 → T7. §5.1 → T3. §5.2 → T4. §5.3 → T5. §6 → T8. §7 files → per task. §8 tests → per task. §9 constraints → header. §10 order → T1…T9. §11 out of scope → untouched. §12 → T9.
- Types: `ModelListing`/`ModelOption` (T3) ↔ `listModelsFor` (T4) ↔ `ModelSelect` (T5) ↔ drawer (T8); `AllAgentsPage`/`DepartmentOption` (T6) ↔ `AllAgentsTable`/`AgentsClient` (T6, T7, T8); `DepartmentsTable({ teams, workspaces })` (T7) ↔ `AgentsClient` (T7); route bodies (T2) ↔ `DepartmentCell` (T6), `NewDepartmentForm`/`TeamBlock` (T7), drawer (T8).
- Placeholders: none — every "read X and mirror" names a file and a symbol that exist at plan time.
