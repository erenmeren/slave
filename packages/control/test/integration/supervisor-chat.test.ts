import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { beforeEach, describe, expect, it } from 'vitest'
import { recentFeed } from '../../src/feed.js'

interface Fixture {
  readonly workspaceId: string
  readonly slaveId: string
  readonly taskId: string
}

const reset = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ExecutionEvent", "SupervisorMessage", "SupervisorDecision", "SlaveMessage", "SlaveRun", "Task", "Slave", "Person", "Team", "Workspace", "User" RESTART IDENTITY CASCADE',
  )
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout Platform', repoPath: '/tmp/checkout-chat', verifyCommands: ['npm test'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const person = await prisma.person.create({ data: { name: 'Maya' } })
  const slave = await prisma.slave.create({
    data: { teamId: team.id, role: 'Senior Engineer', runtimeRoles: ['backend'], personId: person.id },
  })
  const task = await prisma.task.create({
    data: {
      workspaceId: workspace.id,
      title: 'Checkout form',
      description: 'make it work',
      status: 'blocked',
      requiredRole: 'backend',
      attempt: 1,
      maxAttempts: 3,
      branch: 'slaveofai/T-abcd1234-checkout-form',
    },
  })
  return { workspaceId: workspace.id, slaveId: slave.id, taskId: task.id }
}

describe('recentFeed', () => {
  let f: Fixture

  beforeEach(async (): Promise<void> => {
    await reset()
    f = await seed()
  })

  it('says what happened in sentences, oldest first, with the log seq a citation names', async (): Promise<void> => {
    const created = await appendEvent({
      type: 'task.created',
      workspaceId: f.workspaceId,
      taskId: f.taskId,
      actor: 'system',
      payload: { title: 'Checkout form', requiredRole: 'backend' },
    })
    const started = await appendEvent({
      type: 'run.started',
      workspaceId: f.workspaceId,
      taskId: f.taskId,
      slaveId: f.slaveId,
      actor: 'system',
      payload: { sessionId: 's-1' },
    })

    const feed = await recentFeed(f.workspaceId, 20)
    expect(feed).toEqual([
      { seq: Number(created.seq), sentence: '"Checkout form" was added to the board' },
      { seq: Number(started.seq), sentence: 'Maya started "Checkout form"' },
    ])
  })

  it('keeps the NEWEST when the limit bites, and reads nothing from another project', async (): Promise<void> => {
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other-chat', verifyCommands: ['npm test'], setupCommands: [] },
    })
    await appendEvent({ type: 'task.created', workspaceId: other.id, actor: 'system', payload: { title: 'Elsewhere', requiredRole: null } })
    for (const title of ['one', 'two', 'three']) {
      await appendEvent({ type: 'task.created', workspaceId: f.workspaceId, actor: 'system', payload: { title, requiredRole: null } })
    }

    const feed = await recentFeed(f.workspaceId, 2)
    expect(feed).toHaveLength(2)
    expect(feed.map((line) => line.sentence)).toEqual(['a task was added to the board', 'a task was added to the board'])
    // Ascending by the log's own seq, which is what the prompt prints and a citation looks up.
    expect(feed[0]!.seq).toBeLessThan(feed[1]!.seq)
  })

  it('ignores the event families the feed does not speak for, and a limit of nothing', async (): Promise<void> => {
    await appendEvent({
      type: 'run.output',
      workspaceId: f.workspaceId,
      slaveId: f.slaveId,
      actor: 'slave',
      payload: { text: 'chatter' },
    })
    expect(await recentFeed(f.workspaceId, 20)).toEqual([])
    expect(await recentFeed(f.workspaceId, 0)).toEqual([])
  })
})
