import { prisma } from '@slave-of-ai/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PERMISSION_KINDS } from '@slave-of-ai/domain'
import { clearSlavePermission, setSlavePermission } from '../../src/permission.js'
import { refusalText } from '../../src/refusal.js'

let slaveId: string

/** The `permission.changed` rows this file reads back, oldest first, with the payload typed --
 *  Prisma hands back a `JsonValue`, and every assertion here is about named fields inside it. */
async function changes(): Promise<
  readonly {
    readonly actor: string
    readonly payload: { readonly from: string | null; readonly to: string | null; readonly by: string | null }
  }[]
> {
  const rows = await prisma.executionEvent.findMany({
    where: { type: 'permission_changed' },
    orderBy: { seq: 'asc' },
  })
  return rows.map((row) => ({
    actor: row.actor,
    payload: row.payload as { from: string | null; to: string | null; by: string | null },
  }))
}

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SlavePermission", "SlaveSkill", "Skill", "SkillProvider", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
  )
  // A REAL account, with the id the cases below pass as a principal: `ExecutionEvent.userId` is a
  // foreign key to `User`, so an invented id would make the append throw rather than record who
  // granted what.
  await prisma.user.create({ data: { id: 'user-1', username: 'operator', passwordHash: 'x' } })
  const workspace = await prisma.workspace.create({
    data: { name: 'W', repoPath: '/tmp/perm', verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'T' } })
  slaveId = (await prisma.slave.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })).id
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

describe('setSlavePermission', () => {
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

  it('records WHO granted and WHEN, which no row could say before', async (): Promise<void> => {
    await setSlavePermission(slaveId, 'network_fetch', 'allow', { userId: 'user-1' })
    const row = await prisma.slavePermission.findUniqueOrThrow({
      where: { slaveId_kind: { slaveId, kind: 'network_fetch' } },
    })
    expect(row.grantedBy).toBe('user-1')
    expect(row.grantedAt.getTime()).toBeGreaterThan(Date.now() - 60_000)
  })

  it('appends permission.changed with the from/to/by triple, and the LABEL beside the key', async (): Promise<void> => {
    await setSlavePermission(slaveId, 'network_fetch', 'allow', { userId: 'user-1' })
    const events = await prisma.executionEvent.findMany({ where: { type: 'permission_changed' } })
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({
      slaveId,
      name: 'Alex',
      kind: 'network_fetch',
      kindLabel: 'Fetch over the network',
      from: null,
      to: 'allow',
      by: 'user-1',
    })
    expect(events[0]?.actor).toBe('human')
    expect(events[0]?.userId).toBe('user-1')
  })

  it('records the FROM state when a grant is flipped to a refusal', async (): Promise<void> => {
    await setSlavePermission(slaveId, 'network_fetch', 'allow')
    await setSlavePermission(slaveId, 'network_fetch', 'deny')
    expect((await changes()).map((event) => [event.payload.from, event.payload.to])).toEqual([
      [null, 'allow'],
      ['allow', 'deny'],
    ])
  })

  it('writes NO event when the mode is already what was asked for -- an idempotent PUT is not a change', async (): Promise<void> => {
    await setSlavePermission(slaveId, 'network_fetch', 'allow')
    await setSlavePermission(slaveId, 'network_fetch', 'allow')
    expect(await prisma.executionEvent.count({ where: { type: 'permission_changed' } })).toBe(1)
  })
})

describe('clearSlavePermission', () => {
  it('REVOKES back to unset -- the state setSlavePermission could never reach', async (): Promise<void> => {
    await setSlavePermission(slaveId, 'network_fetch', 'allow')
    const result = await clearSlavePermission(slaveId, 'network_fetch', { userId: 'user-1' })
    expect(result.ok).toBe(true)
    expect(await prisma.slavePermission.count({ where: { slaveId } })).toBe(0)
    expect((await changes()).at(-1)?.payload).toMatchObject({ from: 'allow', to: null, by: 'user-1' })
  })

  it('a revoke of a kind nobody ever decided is a no-op, not a refusal -- the DELETE is idempotent', async (): Promise<void> => {
    const result = await clearSlavePermission(slaveId, 'network_fetch')
    expect(result.ok).toBe(true)
    expect(await prisma.executionEvent.count({ where: { type: 'permission_changed' } })).toBe(0)
  })

  it('refuses a revoke of a kind outside the six, and of an unknown slave', async (): Promise<void> => {
    expect((await clearSlavePermission(slaveId, 'launch_nukes')).ok).toBe(false)
    expect((await clearSlavePermission('00000000-0000-4000-8000-000000000000', 'read_repo')).ok).toBe(false)
  })
})
