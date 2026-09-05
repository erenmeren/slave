import { prisma } from '@slave-of-ai/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../src/append.js'
import { subscribeEvents, type EventNotification, type EventSubscription } from '../../src/subscribe.js'

const url = (): string => process.env['TEST_DATABASE_URL'] ?? ''

let subscription: EventSubscription | null = null

beforeEach(async (): Promise<void> => {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "ExecutionEvent", "User" RESTART IDENTITY CASCADE')
})

afterEach(async (): Promise<void> => {
  await subscription?.close()
  subscription = null
})

afterAll(async (): Promise<void> => {
  await prisma.$disconnect()
})

/**
 * Runs `fn` while a deferred constraint trigger is attached to `ExecutionEvent` that
 * unconditionally raises. `AFTER INSERT ... DEFERRABLE INITIALLY DEFERRED` fires at COMMIT time,
 * not at statement time, which is the one failure point today's `appendEvent` signature offers no
 * other way to create: everything inside the transaction (the insert, the domain validation, the
 * `pg_notify`) succeeds, and only the COMMIT itself fails.
 *
 * That makes it possible to distinguish "the notify was queued on the transaction's own
 * connection, so Postgres discards it along with everything else when the transaction aborts"
 * from "the notify already escaped on a separate, autocommitting connection before the abort" —
 * exactly the distinction between `tx.$executeRaw` and `prisma.$executeRaw` in `appendEvent`.
 *
 * Scoped to a single test via try/finally (not shared setup) so no other test in this file runs
 * with a table that unconditionally fails to commit, and torn down even if `fn` throws.
 */
async function withCommitFailure<T>(fn: () => Promise<T>): Promise<T> {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_fail_after_insert() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'deliberate commit-time failure for atomicity test';
    END;
    $$ LANGUAGE plpgsql;
  `)
  await prisma.$executeRawUnsafe(`
    CREATE CONSTRAINT TRIGGER fail_after_insert
    AFTER INSERT ON "ExecutionEvent"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION test_fail_after_insert();
  `)
  try {
    return await fn()
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_after_insert ON "ExecutionEvent"')
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_fail_after_insert()')
  }
}

describe('appendEvent', () => {
  it('writes a valid event and returns it parsed', async () => {
    const event = await appendEvent({
      type: 'task.created',
      workspaceId: 'w1',
      taskId: 'task-1',
      actor: 'human',
      payload: { title: 'Add checkout retry' },
    })

    expect(event.type).toBe('task.created')
    expect(typeof event.seq).toBe('number')
    expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(event.taskId).toBe('task-1')
    expect(event.slaveId).toBeUndefined()
    expect(event.runId).toBeUndefined()
    expect(await prisma.executionEvent.count()).toBe(1)
  })

  it('writes and reads back a userId when the caller supplies one', async () => {
    const user = await prisma.user.create({ data: { username: 'u1', passwordHash: 'irrelevant-for-this-test' } })

    const event = await appendEvent({
      type: 'task.created',
      workspaceId: 'w1',
      taskId: 'task-1',
      actor: 'human',
      payload: { title: 'Add checkout retry' },
      userId: user.id,
    })

    expect(event.userId).toBe(user.id)
    const row = await prisma.executionEvent.findUniqueOrThrow({ where: { seq: event.seq } })
    expect(row.userId).toBe(user.id)
  })

  it('leaves userId null/absent when the caller supplies none', async () => {
    const event = await appendEvent({
      type: 'task.created',
      workspaceId: 'w1',
      taskId: 'task-1',
      actor: 'human',
      payload: { title: 'Add checkout retry' },
    })

    expect(event.userId).toBeUndefined()
    const row = await prisma.executionEvent.findUniqueOrThrow({ where: { seq: event.seq } })
    expect(row.userId).toBeNull()
  })

  it('leaves no row when the payload does not match the event type', async () => {
    await expect(
      appendEvent({
        type: 'task.created',
        workspaceId: 'w1',
        actor: 'human',
        payload: { nonsense: true },
      }),
    ).rejects.toThrow()

    expect(await prisma.executionEvent.count()).toBe(0)
  })

  it('notifies a subscriber with the seq and workspace id', async () => {
    const seen: EventNotification[] = []
    subscription = await subscribeEvents(url(), (n) => seen.push(n))

    const event = await appendEvent({
      type: 'run.started',
      workspaceId: 'w1',
      runId: 'run-1',
      actor: 'system',
      payload: { sessionId: 'sess-1' },
    })

    await expect.poll(() => seen).toEqual([{ seq: event.seq, workspaceId: 'w1' }])
  })

  it('delivers no notification when the write is rolled back', async () => {
    const seen: EventNotification[] = []
    subscription = await subscribeEvents(url(), (n) => seen.push(n))

    await withCommitFailure(async () => {
      await expect(
        appendEvent({
          type: 'task.created',
          workspaceId: 'w1',
          actor: 'human',
          payload: { title: 'Should never commit' },
        }),
      ).rejects.toThrow()
    })

    expect(await prisma.executionEvent.count()).toBe(0)

    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(seen).toEqual([])
  })
})

describe('appendEvent serialization', () => {
  /**
   * The single-writer rule `createEventStream` documents as "silent and load-bearing" (stream.ts):
   * `seq` is assigned at INSERT but a row is visible only at COMMIT, so a lower-`seq` transaction
   * that commits after a higher-`seq` one is skipped forever by a `seq > lastSeq` cursor. M3's
   * event pump is the first code to run concurrent appends -- one per active run -- so the rule
   * has to be enforced here rather than assumed of the caller.
   */
  it('assigns seq in the order appends complete, even when they are started together', async (): Promise<void> => {
    const completions: number[] = []

    await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        appendEvent({
          type: 'task.created',
          workspaceId: 'w-serial',
          actor: 'system',
          payload: { title: `t-${index}` },
        }).then((event): void => {
          completions.push(Number(event.seq))
        }),
      ),
    )

    // Strictly increasing in completion order is what "commit order matches seq order" means from
    // outside the database. Overlapping transactions can assign 7 before 6 and commit 6 second,
    // and a reader tracking `seq > lastSeq` never sees 6 again.
    expect(completions).toHaveLength(25)
    expect([...completions].sort((a, b) => a - b)).toEqual(completions)
  })

  it('keeps writing after an append fails', async (): Promise<void> => {
    // Serialization must not mean one poisoned write stops the log: the chain has to survive a
    // rejection, or a single bad payload wedges every pump in the process.
    await expect(
      appendEvent({
        type: 'task.created',
        workspaceId: 'w-serial',
        actor: 'system',
        payload: { wrong: 'shape' },
      }),
    ).rejects.toThrow()

    const after = await appendEvent({
      type: 'task.created',
      workspaceId: 'w-serial',
      actor: 'system',
      payload: { title: 'still working' },
    })
    expect(after.seq).toBeGreaterThan(0)
  })
})
