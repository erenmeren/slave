import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../../src/client.js'

describe('execution event log', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('assigns a monotonic seq and a default timestamp', async () => {
    const first = await prisma.executionEvent.create({
      data: { type: 'task_created', workspaceId: 'w1', actor: 'system', payload: { title: 'a' } },
    })
    const second = await prisma.executionEvent.create({
      data: { type: 'task_created', workspaceId: 'w1', actor: 'system', payload: { title: 'b' } },
    })

    expect(second.seq > first.seq).toBe(true)
    expect(first.ts).toBeInstanceOf(Date)
  })

  it('stores the dotted domain spelling in the column, not the Prisma identifier', async () => {
    await prisma.executionEvent.create({
      data: { type: 'run_tool_call', workspaceId: 'w1', actor: 'agent', payload: { name: 'Bash', summary: 'ls' } },
    })

    const rows = await prisma.$queryRawUnsafe<{ type: string }[]>('SELECT type::text AS type FROM "ExecutionEvent"')
    expect(rows[0]?.type).toBe('run.tool_call')
  })

  it('round-trips a JSON payload', async () => {
    const created = await prisma.executionEvent.create({
      data: {
        type: 'agent_message_sent',
        workspaceId: 'w1',
        agentId: 'a1',
        actor: 'human',
        payload: { category: 'instruction', body: 'use the retry helper' },
      },
    })

    const found = await prisma.executionEvent.findUniqueOrThrow({ where: { seq: created.seq } })
    expect(found.payload).toEqual({ category: 'instruction', body: 'use the retry helper' })
    expect(found.agentId).toBe('a1')
    expect(found.taskId).toBeNull()
  })
})
