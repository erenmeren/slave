import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { LEAD_TEAM_NAME } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { deleteWorkspace } from '../../src/deleteWorkspace.js'
import { refusalText } from '../../src/refusal.js'

const repoPath = mkdtempSync(join(tmpdir(), 'slaveofai-control-delete-ws-'))
writeFileSync(join(repoPath, 'README.md'), '# kept\n')
afterAll(async () => {
  rmSync(repoPath, { recursive: true, force: true })
  await prisma.$disconnect()
})

const UNKNOWN = '00000000-0000-4000-8000-000000000000'

interface Fixture {
  readonly workspaceId: string
  readonly otherId: string
  readonly leadSlaveId: string
  readonly taskId: string
  readonly systemPersonIds: readonly string[]
  readonly cataloguePersonId: string
}

/**
 * One lead-flow project with its three system persons, a catalogue person seated in it and in a
 * second project, a task with a finished run, events, and the conversation that created it; and a
 * second project that must come through untouched.
 */
async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({ data: { name: 'Doomed', repoPath, verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted' } })
  const other = await prisma.workspace.create({ data: { name: 'Kept', repoPath, verifyCommands: ['true'], setupCommands: [] } })
  const leadTeam = await prisma.team.create({ data: { workspaceId: workspace.id, name: LEAD_TEAM_NAME } })
  const system = await Promise.all(['Lead', 'Verifier', 'Confirmer'].map((role) => prisma.person.create({ data: { name: `${role} ${workspace.id.slice(0, 8)}` } })))
  const seats = await Promise.all(system.map((person, index) => prisma.slave.create({ data: { teamId: leadTeam.id, personId: person.id, role: ['Lead', 'Verifier', 'Confirmer'][index] ?? 'Lead' } })))
  const template = await prisma.slaveTemplate.create({ data: { role: 'Reviewer', name: 'Code Reviewer' } })
  const reviewer = await prisma.person.create({ data: { name: 'Riley', templateId: template.id } })
  const qa = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'QA' } })
  await prisma.slave.create({ data: { teamId: qa.id, personId: reviewer.id, role: 'reviewer' } })
  const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'QA' } })
  await prisma.slave.create({ data: { teamId: otherTeam.id, personId: reviewer.id, role: 'reviewer' } })

  const task = await prisma.task.create({ data: { workspaceId: workspace.id, title: 'The whole goal', description: 'x', maxAttempts: 3 } })
  const lead = seats[0]
  if (lead === undefined) throw new Error('unreachable')
  await prisma.slaveRun.create({ data: { taskId: task.id, slaveId: lead.id, status: 'succeeded' } })
  await appendEvent({ type: 'workspace.archived', workspaceId: workspace.id, actor: 'human', payload: { name: 'Doomed', departments: 2, slaves: 4, tasks: 1, runs: 1 } })
  await appendEvent({ type: 'workspace.archived', workspaceId: other.id, actor: 'human', payload: { name: 'Kept', departments: 1, slaves: 1, tasks: 0, runs: 0 } })
  const intake = await prisma.intake.create({ data: { workspaceId: workspace.id, status: 'created' } })
  await prisma.intakeMessage.create({ data: { intakeId: intake.id, seq: 1, role: 'human', text: 'build me a thing' } })

  return { workspaceId: workspace.id, otherId: other.id, leadSlaveId: lead.id, taskId: task.id, systemPersonIds: system.map((person) => person.id), cataloguePersonId: reviewer.id }
}

let fixture: Fixture

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "IntakeMessage", "Intake", "Checkpoint", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace", "SlaveTemplate" RESTART IDENTITY CASCADE',
  )
  fixture = await seed()
})

describe('deleteWorkspace (lead UX design section 10)', () => {
  it('removes the project, its events, its conversation and its system persons, and says what went', async () => {
    const result = await deleteWorkspace(fixture.workspaceId)

    expect(result).toMatchObject({
      ok: true,
      value: { name: 'Doomed', repoPath, footprint: { departments: 2, slaves: 4, tasks: 1, runs: 1 }, events: 1, intakes: 1, systemPersons: 3 },
    })
    expect(await prisma.workspace.count({ where: { id: fixture.workspaceId } })).toBe(0)
    expect(await prisma.team.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
    expect(await prisma.task.count({ where: { id: fixture.taskId } })).toBe(0)
    expect(await prisma.slaveRun.count({ where: { slaveId: fixture.leadSlaveId } })).toBe(0)
    expect(await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId } })).toBe(0)
    expect(await prisma.intake.count()).toBe(0)
    expect(await prisma.intakeMessage.count()).toBe(0)
    expect(await prisma.person.count({ where: { id: { in: [...fixture.systemPersonIds] } } })).toBe(0)
  })

  it('keeps the catalogue person, the other project and its events, and the repository on disk', async () => {
    await deleteWorkspace(fixture.workspaceId)

    expect(await prisma.person.count({ where: { id: fixture.cataloguePersonId } })).toBe(1)
    expect(await prisma.workspace.count({ where: { id: fixture.otherId } })).toBe(1)
    expect(await prisma.slave.count({ where: { team: { workspaceId: fixture.otherId } } })).toBe(1)
    expect(await prisma.executionEvent.count({ where: { workspaceId: fixture.otherId } })).toBe(1)
    expect(existsSync(join(repoPath, 'README.md'))).toBe(true)
  })

  it('keeps a template-less person who also holds a seat in another project', async () => {
    const shared = fixture.systemPersonIds[0]
    if (shared === undefined) throw new Error('unreachable')
    const team = await prisma.team.findFirstOrThrow({ where: { workspaceId: fixture.otherId } })
    await prisma.slave.create({ data: { teamId: team.id, personId: shared, role: 'helper' } })

    const result = await deleteWorkspace(fixture.workspaceId)

    expect(result).toMatchObject({ ok: true, value: { systemPersons: 2 } })
    expect(await prisma.person.count({ where: { id: shared } })).toBe(1)
  })

  it('refuses while a run is live, deleting nothing', async () => {
    await prisma.slaveRun.create({ data: { taskId: fixture.taskId, slaveId: fixture.leadSlaveId, status: 'working' } })

    const result = await deleteWorkspace(fixture.workspaceId)

    expect(result).toEqual({ ok: false, error: { kind: 'live_runs', entity: 'workspace', id: fixture.workspaceId, runs: 1 } })
    if (!result.ok) expect(refusalText(result.error)).toContain('live run')
    expect(await prisma.workspace.count({ where: { id: fixture.workspaceId } })).toBe(1)
    expect(await prisma.executionEvent.count({ where: { workspaceId: fixture.workspaceId } })).toBe(1)
    expect(await prisma.intake.count()).toBe(1)
  })

  it('refuses a project that does not exist', async () => {
    expect(await deleteWorkspace(UNKNOWN)).toEqual({ ok: false, error: { kind: 'workspace_not_found', workspaceId: UNKNOWN } })
  })

  it('deletes an archived project too', async () => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { archivedAt: new Date() } })
    expect((await deleteWorkspace(fixture.workspaceId)).ok).toBe(true)
    expect(await prisma.workspace.count({ where: { id: fixture.workspaceId } })).toBe(0)
  })
})
