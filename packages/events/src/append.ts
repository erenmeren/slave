import { EVENT_TYPE_BY_DOMAIN_TYPE, toExecutionEvent, type DomainEventType } from '@slave-of-ai/db'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import type { ExecutionEvent } from '@slave-of-ai/domain'

export interface AppendableEvent {
  readonly type: DomainEventType
  readonly workspaceId: string
  /**
   * `null` for a task-less (`planning`) run's own events (M8b) -- distinct from `undefined`,
   * which means "this event has no task at all" for callers that never had one to omit.
   */
  readonly taskId?: string | null
  readonly slaveId?: string
  readonly runId?: string
  readonly actor: 'human' | 'slave' | 'system'
  readonly payload: unknown
  /**
   * Who caused this event (M23 F6). `null`/absent for the CLI and the orchestrator, which have
   * no user; a web caller with a `Principal` passes its `userId`.
   */
  readonly userId?: string | null
}

/**
 * Serialises every append in this process onto one chain.
 *
 * `createEventStream` tracks its position with `seq > lastSeq`, and `seq` is assigned at INSERT
 * while a row becomes visible only at COMMIT. Two overlapping appends can therefore take 6 and 7
 * and commit in the order 7, 6 — and a reader that has already advanced past 7 never sees 6 again.
 * `stream.ts` names this assumption and calls it "silent and load-bearing — a second writer breaks
 * it with no error and no failing test", which was exactly true: M3's event pump runs one append
 * chain per active run, and nothing failed.
 *
 * Enforced here rather than in the orchestrator because the invariant belongs to the log, not to
 * one of its callers: any future writer inherits it, and the guarantee now lives beside the code
 * that depends on it.
 *
 * The chain is advanced with a swallowed rejection, so one bad payload cannot wedge every writer
 * in the process behind a permanently rejected promise.
 */
let appendChain: Promise<unknown> = Promise.resolve()

/**
 * The only write path to the event log.
 *
 * The row is inserted first so the database can assign `seq` and default `ts`, and validation
 * then runs on the row that came back — the exact object a reader will see, rather than the
 * object we intended to write. A failure throws, which rolls the transaction back, and because
 * Postgres delivers NOTIFY only on commit, a rolled-back append cannot announce itself.
 *
 * Appends are serialised process-wide — see {@link appendChain}. The cost is real and deliberate:
 * a slow database now slows every writer rather than only the one behind it, which is the
 * backpressure spec §5.6 wanted and did not otherwise have.
 */
export async function appendEvent(input: AppendableEvent): Promise<ExecutionEvent> {
  const result = appendChain.then((): Promise<ExecutionEvent> => appendEventNow(input))
  appendChain = result.catch((): undefined => undefined)
  return result
}

async function appendEventNow(input: AppendableEvent): Promise<ExecutionEvent> {
  return prisma.$transaction(async (tx): Promise<ExecutionEvent> => {
    const row = await tx.executionEvent.create({
      data: {
        type: EVENT_TYPE_BY_DOMAIN_TYPE[input.type],
        workspaceId: input.workspaceId,
        taskId: input.taskId ?? null,
        slaveId: input.slaveId ?? null,
        runId: input.runId ?? null,
        userId: input.userId ?? null,
        actor: input.actor,
        payload: input.payload as Prisma.InputJsonValue,
      },
    })

    const parsed = toExecutionEvent(row)
    if (!parsed.ok) {
      throw new Error(
        'refusing to append an event the domain cannot parse ' +
          `(type=${input.type}, workspaceId=${input.workspaceId}): ${parsed.error}`,
      )
    }

    const notification = JSON.stringify({ seq: parsed.value.seq, workspaceId: parsed.value.workspaceId })
    await tx.$executeRaw`SELECT pg_notify('events', ${notification})`

    return parsed.value
  })
}
