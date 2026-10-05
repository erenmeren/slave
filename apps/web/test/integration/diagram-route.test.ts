import { prisma } from '@slave-of-ai/db/client'
import { LEAD_TEAM_NAME } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as diagram } from '../../src/app/api/w/[workspaceId]/diagram/route.js'

/**
 * The diagram route is a thin envelope over `buildDiagram`: these cases pin the envelope -- the
 * status and the body's shape -- and leave what the diagram says to the control package's tests.
 */
afterAll(async () => {
  await prisma.$disconnect()
})

const UNKNOWN = '00000000-0000-4000-8000-000000000000'
const req = (query = ''): Request => new Request(`http://test/api/diagram${query}`)
const ws = (workspaceId: string): { params: Promise<{ workspaceId: string }> } => ({ params: Promise.resolve({ workspaceId }) })

let leadId = ''
let olderId = ''

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorDecision", "VerificationResult", "RequirementSet", "GoalVersion", "WorkPackage", "GoalDelivery", "Checkpoint", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace" RESTART IDENTITY CASCADE',
  )
  const lead = await prisma.workspace.create({ data: { name: 'Lead project', repoPath: '/tmp/no-such-repo', verifyCommands: ['true'], setupCommands: [], flow: 'lead', delivery: 'conducted', goalVersion: 1, goal: 'Build a todo app.' } })
  await prisma.goalVersion.create({ data: { workspaceId: lead.id, version: 1, text: 'Build a todo app.', sha256: 'x' } })
  const team = await prisma.team.create({ data: { workspaceId: lead.id, name: LEAD_TEAM_NAME } })
  const seat = await prisma.slave.create({ data: { teamId: team.id, role: 'Lead', runtimeRoles: ['implementer'], personId: (await prisma.person.create({ data: { name: 'Lead x' } })).id } })
  await prisma.goalDelivery.create({ data: { workspaceId: lead.id, goalVersion: 1, integrationBranch: 'slaveofai/goal-v1', baseCommit: 'b'.repeat(40), status: 'integrating', leadState: 'building' } })
  const pkg = await prisma.workPackage.create({ data: { workspaceId: lead.id, goalVersion: 1, key: 'main', title: 'The whole goal', requirementKeys: [], ownedPaths: ['**'], interface: '', templateId: 'lead' } })
  const task = await prisma.task.create({ data: { workspaceId: lead.id, title: 'The whole goal', description: 'x', status: 'running', requiredRole: 'implementer', maxAttempts: 3, goalVersion: 1, workPackageId: pkg.id } })
  await prisma.slaveRun.create({ data: { slaveId: seat.id, taskId: task.id, status: 'working', leadTurn: 'build' } })
  leadId = lead.id
  olderId = (await prisma.workspace.create({ data: { name: 'Older project', repoPath: '/tmp/older', verifyCommands: ['true'], setupCommands: [] } })).id
})

describe('GET /api/w/:id/diagram', () => {
  it('answers the newest build as a diagram', async () => {
    const response = await diagram(req(), ws(leadId))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { diagram: { flow: string; build: { version: number; nodes: { id: string }[]; calls: unknown[]; totalCalls: number } | null } }
    expect(body.diagram.flow).toBe('lead')
    expect(body.diagram.build).toMatchObject({ version: 1, goal: 'Build a todo app.', result: 'not_yet', totalCalls: 0, calls: [] })
    expect(body.diagram.build?.nodes.map((node) => node.id)).toEqual(['request', 'lead', 'result'])
  })

  it('answers a chosen build, 404 for a build that is not there, and 400 for a version that is not a number', async () => {
    expect((await diagram(req('?version=1'), ws(leadId))).status).toBe(200)
    const missing = await diagram(req('?version=9'), ws(leadId))
    expect(missing.status).toBe(404)
    expect(((await missing.json()) as { error: string }).error).toContain('v9')
    for (const bad of ['0', '-1', 'x', '1.5', '']) expect((await diagram(req(`?version=${bad}`), ws(leadId))).status, bad).toBe(400)
  })

  it('answers an older project with no build, and 404 for a project that does not exist', async () => {
    const older = await diagram(req(), ws(olderId))
    expect(older.status).toBe(200)
    expect(await older.json()).toEqual({ diagram: { workspaceId: olderId, flow: 'packages', build: null } })
    expect((await diagram(req(), ws(UNKNOWN))).status).toBe(404)
  })
})
