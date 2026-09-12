import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PERMISSION_KINDS } from '@slave-of-ai/domain'
import { setSlavePermission } from '../../src/permission.js'
import { refusalText } from '../../src/refusal.js'

let slaveId: string

describe('setSlavePermission', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "SlavePermission", "SlaveSkill", "Skill", "SkillProvider", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    const workspace = await prisma.workspace.create({
      data: { name: 'W', repoPath: '/tmp/perm', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'T' } })
    slaveId = (await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })).id
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('lists the six OPERATIONS, in the order a person grants them (M52 R1)', () => {
    expect(PERMISSION_KINDS).toEqual([
      'read_repo',
      'write_repo',
      'run_commands',
      'network_fetch',
      'read_secret',
      'deploy_release',
    ])
  })

  it('writes a row and flips it in place rather than adding a second', async (): Promise<void> => {
    expect((await setSlavePermission(slaveId, 'read_repo', 'allow')).ok).toBe(true)
    expect((await setSlavePermission(slaveId, 'read_repo', 'deny')).ok).toBe(true)

    const rows = await prisma.slavePermission.findMany({ where: { slaveId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.mode).toBe('deny')
  })

  // The refusal KIND is still `invalid_tool` (plan erratum E11): renaming it costs three homes to
  // rename a word no surface prints. Only its sentence moved with the vocabulary.
  it('refuses a kind outside the six with the verbatim text', async (): Promise<void> => {
    const result = await setSlavePermission(slaveId, 'rm -rf', 'allow')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_tool')
      expect(refusalText(result.error)).toBe('a permission must name one of the six operations')
    }
  })

  it('refuses a mode that is neither allow nor deny', async (): Promise<void> => {
    const result = await setSlavePermission(slaveId, 'read_repo', 'maybe' as 'allow')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(refusalText(result.error)).toBe('a permission must be allow or deny')
  })

  it('refuses an unknown slave', async (): Promise<void> => {
    const result = await setSlavePermission('00000000-0000-4000-8000-000000000000', 'read_repo', 'allow')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('slave_not_found')
  })
})
