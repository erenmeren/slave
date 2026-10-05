import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_SEAT_ROLES, LEAD_TEAM_NAME } from '@slave-of-ai/domain'
import { createWorkspace } from '../../src/workspace.js'
import { refusalText } from '../../src/refusal.js'

const dirs: string[] = []
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-create-ws-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@x', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir })
  return dir
}

const valid = (repoPath: string) => ({ name: 'Billing', repoPath, verifyCommands: ['npm test'] })

describe('createWorkspace', () => {
  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "SlaveMessage", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Person", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
    )
  })

  it('creates the row, the provider row and the event in one go', async () => {
    const dir = repo()
    const result = await createWorkspace({ ...valid(dir), provider: 'claude_code', setupCommands: [' npm ci '], budgetUsd: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row).toMatchObject({ name: 'Billing', repoPath: dir, baseBranch: 'main', verifyCommands: ['npm test'], setupCommands: ['npm ci'], budgetUsd: 5 })
    expect(await prisma.providerConfiguration.findMany({ where: { workspaceId: row.id } })).toMatchObject([{ kind: 'claude_code' }])
    const events = await prisma.executionEvent.findMany({ where: { workspaceId: row.id, type: 'workspace_created' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({ name: 'Billing', repoPath: dir, baseBranch: 'main', verifyCommands: ['npm test'], provider: 'claude_code' })
    expect(events[0]?.actor).toBe('human')
  })

  /**
   * The operator's ruling of 2026-10-05: a new project is born in the lead flow wherever that flow
   * can run -- the `claude_code` provider and conducted delivery -- with what `setFlow` would have
   * written: automatic merge on and the three system seats.
   */
  it('is born in the lead flow with the claude_code provider: automatic merge on and the three system seats', async () => {
    const result = await createWorkspace({ ...valid(repo()), provider: 'claude_code' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row).toMatchObject({ flow: 'lead', delivery: 'conducted', autoMerge: true })
    const seats = await prisma.slave.findMany({ where: { team: { workspaceId: row.id, name: LEAD_TEAM_NAME }, closedAt: null }, select: { role: true, model: true, provider: true } })
    expect(seats.map((seat) => seat.role).sort()).toEqual(Object.values(LEAD_SEAT_ROLES).sort())
    expect(seats.every((seat) => seat.model === null && seat.provider === null)).toBe(true)
  })

  it('keeps an explicit automatic-merge choice in the lead flow', async () => {
    const result = await createWorkspace({ ...valid(repo()), provider: 'claude_code', autoMerge: false })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await prisma.workspace.findUniqueOrThrow({ where: { id: result.value.id } })).toMatchObject({ flow: 'lead', autoMerge: false })
  })

  it.each([
    ['no provider', {}],
    ['the cursor provider', { provider: 'cursor' as const }],
    ['the planner', { provider: 'claude_code' as const, delivery: 'planned' as const }],
    ['the packages flow named', { provider: 'claude_code' as const, flow: 'packages' as const }],
  ])('stays in the packages flow with %s, and makes no system seat', async (_label, extra) => {
    const result = await createWorkspace({ ...valid(repo()), ...extra })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await prisma.workspace.findUniqueOrThrow({ where: { id: result.value.id } })).toMatchObject({ flow: 'packages', autoMerge: false })
    expect(await prisma.slave.count({ where: { team: { workspaceId: result.value.id } } })).toBe(0)
  })

  it('refuses the lead flow named where it cannot run, and writes nothing', async () => {
    const result = await createWorkspace({ ...valid(repo()), flow: 'lead' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe('lead_setting_invalid')
    expect(await prisma.workspace.count()).toBe(0)
  })

  // Lead UX design section 10: the time limit a project is born with, before its first build.
  it('writes the time limit of a lead-flow project created with one', async () => {
    const result = await createWorkspace({ ...valid(repo()), provider: 'claude_code', goalTimeLimitMs: 90 * 60_000 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await prisma.workspace.findUniqueOrThrow({ where: { id: result.value.id } })).toMatchObject({ flow: 'lead', goalTimeLimitMs: 5_400_000 })
  })

  it('leaves the time limit null when none is given', async () => {
    const result = await createWorkspace({ ...valid(repo()), provider: 'claude_code', goalTimeLimitMs: null })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: result.value.id } })).goalTimeLimitMs).toBeNull()
  })

  it.each([
    ['below ten minutes', { provider: 'claude_code' as const, goalTimeLimitMs: 5 * 60_000 }],
    ['past a day', { provider: 'claude_code' as const, goalTimeLimitMs: 25 * 60 * 60_000 }],
    ['not whole minutes', { provider: 'claude_code' as const, goalTimeLimitMs: 10 * 60_000 + 1 }],
    ['outside the lead flow', { goalTimeLimitMs: 60 * 60_000 }],
  ])('refuses a time limit %s, writing nothing', async (_label, extra) => {
    const result = await createWorkspace({ ...valid(repo()), ...extra })
    expect(result).toMatchObject({ ok: false, error: { kind: 'lead_setting_invalid', field: 'timeLimitMs' } })
    expect(await prisma.workspace.count()).toBe(0)
  })

  it('no provider means no ProviderConfiguration row and a null in the payload', async () => {
    const result = await createWorkspace(valid(repo()))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await prisma.providerConfiguration.count({ where: { workspaceId: result.value.id } })).toBe(0)
  })

  /**
   * E R7/R1. The two switches are OPTIONAL input, and a caller that names neither gets the column
   * defaults -- `autoMerge` false, `supervisorAutonomy` propose -- which is what the CLI and the
   * project form still create. Only a conversation's card asks for them (its draft defaults both
   * on), so "a project created from the CLI keeps hand-merge" stays true.
   */
  it('leaves both switches at the column defaults when the caller names neither', async () => {
    const result = await createWorkspace(valid(repo()))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row.autoMerge).toBe(false)
    expect(row.supervisorAutonomy).toBe('propose')
  })

  it('writes both switches when the caller asks for them', async () => {
    const result = await createWorkspace({ ...valid(repo()), autoMerge: true, supervisorAutonomy: 'act' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row.autoMerge).toBe(true)
    expect(row.supervisorAutonomy).toBe('act')
  })

  /**
   * Conductor Plan 4b (spec §5, D11): a new project is conducted unless the caller says otherwise.
   * The column default stays `planned` (rows inserted anywhere else keep the planner), so this is
   * `createWorkspace` writing the value, not Postgres.
   */
  it('creates a conducted project when the caller names no delivery', async (): Promise<void> => {
    const result = await createWorkspace(valid(repo()))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row.delivery).toBe('conducted')
  })

  it('creates a planned project when the caller asks for the planner', async (): Promise<void> => {
    const result = await createWorkspace({ ...valid(repo()), delivery: 'planned' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: result.value.id } })
    expect(row.delivery).toBe('planned')
  })

  it.each([
    ['relative path', (d: string) => ({ ...valid(d), repoPath: 'repo' }), 'repo_path_not_absolute'],
    ['missing dir', (d: string) => ({ ...valid(d), repoPath: join(d, 'nope') }), 'repo_not_found'],
    ['not a repo', (d: string) => ({ ...valid(mkdtempSync(join(tmpdir(), 'slaveofai-plain-'))) }), 'not_a_git_repository'],
    ['no base branch', (d: string) => ({ ...valid(d), baseBranch: 'develop' }), 'base_branch_not_found'],
    ['blank verify', (d: string) => ({ ...valid(d), verifyCommands: [' ', ''] }), 'verify_commands_empty'],
    ['blank name', (d: string) => ({ ...valid(d), name: '  ' }), 'invalid_name'],
    ['negative budget', (d: string) => ({ ...valid(d), budgetUsd: -1 }), 'invalid_budget'],
    ['bogus provider', (d: string) => ({ ...valid(d), provider: 'gpt' as never }), 'invalid_provider'],
  ])('refuses %s, writing nothing', async (_label, make, kind) => {
    const result = await createWorkspace(make(repo()))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe(kind)
      expect(refusalText(result.error).length).toBeGreaterThan(0)
    }
    expect(await prisma.workspace.count()).toBe(0)
    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('refuses a second workspace with the same name', async () => {
    expect((await createWorkspace(valid(repo()))).ok).toBe(true)
    const again = await createWorkspace(valid(repo()))
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.error).toEqual({ kind: 'duplicate_name', name: 'Billing' })
  })

  it('puts the intake id on the created event when a conversation asked for it (M59 R4)', async (): Promise<void> => {
    const repoPath = repo()
    const created = await createWorkspace(
      { name: 'From a conversation', repoPath, verifyCommands: ['npm test'] },
      undefined,
      { intakeId: 'intake-1234' },
    )
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('unreachable')
    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: created.value.id, type: 'workspace_created' },
    })
    expect((event.payload as { intakeId?: string }).intakeId).toBe('intake-1234')
  })

  it('leaves the key off entirely when no conversation did', async (): Promise<void> => {
    const repoPath = repo()
    const created = await createWorkspace({ name: 'From the form', repoPath, verifyCommands: ['npm test'] })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error('unreachable')
    const event = await prisma.executionEvent.findFirstOrThrow({
      where: { workspaceId: created.value.id, type: 'workspace_created' },
    })
    expect(Object.keys(event.payload as object)).not.toContain('intakeId')
  })
})
