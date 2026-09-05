import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as getActivityStream } from '../../src/app/api/w/[workspaceId]/activity/stream/route.js'
import { GET as getEvents } from '../../src/app/api/w/[workspaceId]/events/route.js'

interface Frame {
  readonly id: string | null
  readonly data: string | null
}

/** Reads frames (blocks separated by a blank line) until `count` or `timeoutMs`. Copied from sse.test.ts. */
async function readFrames(response: Response, count: number, timeoutMs = 5_000): Promise<Frame[]> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('response has no body')
  const decoder = new TextDecoder()
  const frames: Frame[] = []
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  try {
    while (frames.length < count && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('frame timeout')), deadline - Date.now())),
      ])
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      let cut: number
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, cut)
        buffer = buffer.slice(cut + 2)
        const id = /^id: (.*)$/m.exec(block)?.[1] ?? null
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? null
        frames.push({ id, data })
      }
    }
  } finally {
    await reader.cancel()
  }
  return frames
}

interface Fixture {
  readonly workspaceId: string
  readonly slaveId1: string
  readonly slaveId2: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'mine', repoPath: '/tmp/mine', verifyCommands: ['true'], setupCommands: [] },
  })
  // ExecutionEvent.slaveId carries no FK — any string identifies "the slave" for filtering.
  return { workspaceId: workspace.id, slaveId1: 'slave-1', slaveId2: 'slave-2' }
}

const emit = async (workspaceId: string, slaveId: string, title: string): Promise<void> => {
  await appendEvent({ type: 'task.created', workspaceId, slaveId, actor: 'system', payload: { title } })
}

describe('the activity SSE stream', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "SlaveRun", "TaskDependency", "Task", "Slave", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('streams only events matching the filters, and heartbeats advance the watermark past filtered spans', async (): Promise<void> => {
    const response = await getActivityStream(
      new Request(`http://test/api?slaves=${fixture.slaveId1}`),
      { params: Promise.resolve({ workspaceId: fixture.workspaceId }) },
    )

    await emit(fixture.workspaceId, fixture.slaveId2, 'not-mine')
    const other = await prisma.executionEvent.findFirst({ orderBy: { seq: 'desc' } })
    await emit(fixture.workspaceId, fixture.slaveId1, 'mine')

    const frames = await readFrames(response, 1)

    expect(frames).toHaveLength(1)
    expect(frames[0]?.data).toContain('mine')
    expect(frames[0]?.data).not.toContain('not-mine')
    // The next id delivered (the surviving frame's own id, here — no heartbeat needed since it
    // follows the filtered event in the same seq order) is past the filtered event's seq: the
    // watermark advanced across the filtered span rather than stalling on it.
    expect(Number(frames[0]?.id)).toBeGreaterThan(Number(other?.seq ?? 0n))
  }, 15_000)

  it('replays from Last-Event-ID across a filtered gap with no duplicate and no gap', async (): Promise<void> => {
    await emit(fixture.workspaceId, fixture.slaveId2, 'filtered-1')
    await emit(fixture.workspaceId, fixture.slaveId1, 'kept-1')
    await emit(fixture.workspaceId, fixture.slaveId2, 'filtered-2')
    await emit(fixture.workspaceId, fixture.slaveId1, 'kept-2')

    const request = new Request(`http://test/api?slaves=${fixture.slaveId1}`, {
      headers: { 'last-event-id': '0' },
    })
    const response = await getActivityStream(request, {
      params: Promise.resolve({ workspaceId: fixture.workspaceId }),
    })
    const frames = await readFrames(response, 2)

    expect(frames.map((f) => f.data ?? '')).toEqual([
      expect.stringContaining('kept-1'),
      expect.stringContaining('kept-2'),
    ])
  }, 15_000)

  it('400s malformed filters without opening a stream', async (): Promise<void> => {
    const response = await getActivityStream(new Request('http://test/api?kinds=nonsense'), {
      params: Promise.resolve({ workspaceId: fixture.workspaceId }),
    })

    expect(response.status).toBe(400)
    expect((await response.json()).error).toBeTruthy()
  })

  it('the M4 events route still streams unfiltered', async (): Promise<void> => {
    const response = await getEvents(new Request('http://test/api'), {
      params: Promise.resolve({ workspaceId: fixture.workspaceId }),
    })

    await emit(fixture.workspaceId, fixture.slaveId2, 'unfiltered')
    const [frame] = await readFrames(response, 1)

    expect(frame?.data).toContain('unfiltered')
  }, 15_000)
})
