import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '@slave-of-ai/db/client'
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
      'TRUNCATE TABLE "ExecutionEvent", "Approval", "AgentMessage", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "ProviderConfiguration", "Workspace" RESTART IDENTITY CASCADE',
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

  it('no provider means no ProviderConfiguration row and a null in the payload', async () => {
    const result = await createWorkspace(valid(repo()))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(await prisma.providerConfiguration.count({ where: { workspaceId: result.value.id } })).toBe(0)
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
})
