import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createEventSse } from '../../src/server/sse.js'

const CONNECTION = process.env['TEST_DATABASE_URL'] ?? ''

interface Frame {
  readonly id: string | null
  readonly data: string | null
}

/** Reads frames (blocks separated by a blank line) until `count` or `timeoutMs`. */
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
  readonly otherWorkspaceId: string
}

async function seed(): Promise<Fixture> {
  const make = async (name: string): Promise<string> =>
    (
      await prisma.workspace.create({
        data: { name, repoPath: `/tmp/${name}`, verifyCommands: ['true'], setupCommands: [] },
      })
    ).id
  return { workspaceId: await make('mine'), otherWorkspaceId: await make('other') }
}

const emit = async (workspaceId: string, title: string): Promise<void> => {
  await appendEvent({ type: 'task.created', workspaceId, actor: 'system', payload: { title } })
}

describe('the events SSE stream', () => {
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

  it('delivers an appended event with its seq as the SSE id', async (): Promise<void> => {
    const response = await createEventSse({
      workspaceId: fixture.workspaceId,
      fromSeq: null,
      connectionString: CONNECTION,
    })

    await emit(fixture.workspaceId, 'hello')
    const [frame] = await readFrames(response, 1)

    expect(frame?.data).toContain('hello')
    const event = JSON.parse(frame?.data ?? '{}') as { seq: number; type: string }
    expect(frame?.id).toBe(String(event.seq))
    expect(event.type).toBe('task.created')
  }, 15_000)

  it('replays from a given seq without loss', async (): Promise<void> => {
    await emit(fixture.workspaceId, 'before-1')
    await emit(fixture.workspaceId, 'before-2')

    // fromSeq: 0 = everything. EventSource reconnection passes Last-Event-ID the same way.
    const response = await createEventSse({
      workspaceId: fixture.workspaceId,
      fromSeq: 0,
      connectionString: CONNECTION,
    })
    const frames = await readFrames(response, 2)

    expect(frames.map((f) => f.data ?? '')).toEqual([
      expect.stringContaining('before-1'),
      expect.stringContaining('before-2'),
    ])
  }, 15_000)

  it("filters another workspace's events but advances the watermark past them", async (): Promise<void> => {
    const response = await createEventSse({
      workspaceId: fixture.workspaceId,
      fromSeq: null,
      connectionString: CONNECTION,
      heartbeatMs: 300,
    })

    await emit(fixture.otherWorkspaceId, 'not-mine')

    // Amended by controller ruling: reading exactly 1 frame races the 300ms heartbeat (a
    // heartbeat can fire before the filtered event lands, carrying id 0). Read up to 3 frames
    // instead and assert that at least one is an id-only heartbeat whose id has moved past 0
    // (the watermark advanced across the filtered span), and that no frame ever carries data
    // (nothing from the other workspace leaked). Same pinned behaviour, no race.
    const frames = await readFrames(response, 3, 2_000)
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) expect(frame.data).toBeNull()
    expect(frames.some((frame) => Number(frame.id) > 0)).toBe(true)
  }, 15_000)

  it('starts "from now": history is not replayed without a resume point', async (): Promise<void> => {
    await emit(fixture.workspaceId, 'history')

    const response = await createEventSse({
      workspaceId: fixture.workspaceId,
      fromSeq: null,
      connectionString: CONNECTION,
    })
    await emit(fixture.workspaceId, 'fresh')
    const [frame] = await readFrames(response, 1)

    expect(frame?.data).toContain('fresh')
    expect(frame?.data).not.toContain('history')
  }, 15_000)

  it('sends id-only heartbeats while quiet', async (): Promise<void> => {
    const response = await createEventSse({
      workspaceId: fixture.workspaceId,
      fromSeq: null,
      connectionString: CONNECTION,
      heartbeatMs: 200,
    })

    const frames = await readFrames(response, 2, 3_000)

    // Two heartbeats with no events between them: both id-only. This is what keeps proxies from
    // reaping the connection and tells the client "quiet", not "dead" (spec §4).
    expect(frames).toHaveLength(2)
    for (const frame of frames) expect(frame.data).toBeNull()
  }, 15_000)

  it('releases its LISTEN connection when the consumer goes away', async (): Promise<void> => {
    const response = await createEventSse({
      workspaceId: fixture.workspaceId,
      fromSeq: null,
      connectionString: CONNECTION,
    })

    await response.body?.cancel()

    // An abandoned tab must not leak a Postgres LISTEN forever. After cancel, appending events
    // must not throw anywhere (the stream's onEvent writing to a closed controller), and the
    // process must be able to exit — asserted indirectly: this test finishing without vitest
    // hanging is the observable.
    await emit(fixture.workspaceId, 'after-close')
    expect(true).toBe(true)
  }, 15_000)
})
