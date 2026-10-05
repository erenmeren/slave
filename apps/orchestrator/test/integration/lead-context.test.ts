import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_RULES, runContextManifestSchema } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildLeadContext, type LeadContextInput } from '../../src/lead/context.js'

const dirs: string[] = []

async function seed(): Promise<Omit<LeadContextInput, 'turn' | 'resumed' | 'continuation' | 'note'>> {
  const dir = mkdtempSync(join(tmpdir(), 'slaveofai-lead-context-'))
  dirs.push(dir)
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# x\n')
  git('add', '-A')
  git('-c', 'user.name=F', '-c', 'user.email=f@x', 'commit', '-q', '-m', 'add the health route')
  const ws = await prisma.workspace.create({ data: { name: `Ctx ${String(Math.random()).slice(2)}`, repoPath: dir, verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted', goal: 'Build the status page.', goalVersion: 1 } })
  await prisma.goalVersion.create({ data: { workspaceId: ws.id, version: 1, text: 'Build the status page.', sha256: 'x' } })
  await prisma.requirementSet.create({ data: { workspaceId: ws.id, goalVersion: 1, items: [{ key: 'R1', text: 'GET /health answers 200', source: 's' }, { key: 'RUN', text: 'It starts', source: '' }] } })
  await prisma.goalDecision.create({ data: { workspaceId: ws.id, goalVersion: 1, title: 'Database', titleKey: 'database', decision: 'SQLite', source: 'person' } })
  const team = await prisma.team.create({ data: { workspaceId: ws.id, name: 'Lead flow' } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Lead', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: `Lead ${ws.id.slice(0, 8)}` } })).id } })
  const run = await prisma.slaveRun.create({ data: { slaveId: seat.id, kind: 'implementation', status: 'starting', leadTurn: 'build' } })
  return { runId: run.id, workspaceId: ws.id, goalVersion: 1, worktreePath: dir, roster: [{ slug: 'backend-developer', description: 'builds APIs' }], budget: { totalUsd: 30, shareUsd: 24, spentUsd: 0, unmeasured: false }, timeLeftMs: null }
}

describe('buildLeadContext (lead-flow spec B3)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "RunContext", "GoalDecision", "RequirementSet", "GoalVersion", "SlaveRun", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    await prisma.$disconnect()
  })

  it('gives a new session the whole brief and the rules, and records it', async (): Promise<void> => {
    const base = await seed()
    const { prompt } = await buildLeadContext({ ...base, turn: 'build', resumed: false, continuation: false, note: null })
    expect(prompt).toContain('THE GOAL (v1)')
    expect(prompt).toContain('R1: GET /health answers 200')
    expect(prompt).toContain('- Database: SQLite')
    expect(prompt).toContain('- backend-developer: builds APIs')
    expect(prompt.endsWith(LEAD_RULES)).toBe(true)
    expect(prompt).not.toContain('<slave-ask>')
    const row = await prisma.runContext.findUniqueOrThrow({ where: { runId: base.runId } })
    expect(row.prompt).toBe(prompt)
    expect(runContextManifestSchema.parse(row.sections)).toEqual({ kind: 'lead', sections: [{ kind: 'lead_brief', goalVersion: 1, turn: 'build', resumed: false, requirements: 2, roster: 1 }] })
  })

  it('gives a continued session only the turn\'s note', async (): Promise<void> => {
    const base = await seed()
    const { prompt } = await buildLeadContext({ ...base, turn: 'rework', resumed: true, continuation: false, note: 'R1: output: 404' })
    expect(prompt).toContain('R1: output: 404')
    expect(prompt).not.toContain('THE GOAL')
    expect(prompt).not.toContain(LEAD_RULES)
    expect(runContextManifestSchema.parse((await prisma.runContext.findUniqueOrThrow({ where: { runId: base.runId } })).sections).sections[0]).toMatchObject({ turn: 'rework', resumed: true })
  })

  it('tells a continued session what is left of its share, cut down to the cent', async (): Promise<void> => {
    const base = await seed()
    const { prompt } = await buildLeadContext({ ...base, budget: { totalUsd: 30, shareUsd: 24, spentUsd: 0.004, unmeasured: false }, turn: 'rework', resumed: true, continuation: false, note: 'R1: output: 404' })
    expect(prompt).toContain('Left of your share: $23.99.')
  })

  it('says "at least" spent and "at most" left while part of the spend is unmeasured (C7, task 6 review)', async (): Promise<void> => {
    const base = await seed()
    const budget = { totalUsd: 30, shareUsd: 24, spentUsd: 2, unmeasured: true }
    expect((await buildLeadContext({ ...base, budget, turn: 'build', resumed: false, continuation: false, note: null })).prompt).toContain('Spent of your share so far: at least $2.00.')
    expect((await buildLeadContext({ ...base, budget, turn: 'continue', resumed: true, continuation: false, note: null })).prompt).toContain('Left of your share: at most $22.00.')
  })

  it('gives a new session after a lost transcript the brief, where the branch stands, and the note', async (): Promise<void> => {
    const base = await seed()
    const { prompt } = await buildLeadContext({ ...base, turn: 'continue', resumed: false, continuation: true, note: 'the earlier transcript is gone' })
    expect(prompt).toContain('THE GOAL (v1)')
    expect(prompt).toContain('CONTINUATION')
    expect(prompt).toContain('add the health route')
    expect(prompt).toContain('the earlier transcript is gone')
    expect(prompt.endsWith(LEAD_RULES)).toBe(true)
  })
})
