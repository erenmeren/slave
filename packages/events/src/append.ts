import { EVENT_TYPE_BY_DOMAIN_TYPE, toExecutionEvent, type DomainEventType } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import type { ExecutionEvent } from '@ai-team-os/domain'

export interface AppendableEvent {
  readonly type: DomainEventType
  readonly workspaceId: string
  readonly taskId?: string
  readonly agentId?: string
  readonly runId?: string
  readonly actor: 'human' | 'agent' | 'system'
  readonly payload: unknown
}

/**
 * The only write path to the event log.
 *
 * The row is inserted first so the database can assign `seq` and default `ts`, and validation
 * then runs on the row that came back — the exact object a reader will see, rather than the
 * object we intended to write. A failure throws, which rolls the transaction back, and because
 * Postgres delivers NOTIFY only on commit, a rolled-back append cannot announce itself.
 */
export async function appendEvent(input: AppendableEvent): Promise<ExecutionEvent> {
  return prisma.$transaction(async (tx): Promise<ExecutionEvent> => {
    const row = await tx.executionEvent.create({
      data: {
        type: EVENT_TYPE_BY_DOMAIN_TYPE[input.type],
        workspaceId: input.workspaceId,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        runId: input.runId ?? null,
        actor: input.actor,
        payload: input.payload as never,
      },
    })

    const parsed = toExecutionEvent(row)
    if (!parsed.ok) {
      throw new Error(`refusing to append an event the domain cannot parse: ${parsed.error}`)
    }

    const notification = JSON.stringify({ seq: parsed.value.seq, workspaceId: parsed.value.workspaceId })
    await tx.$executeRaw`SELECT pg_notify('events', ${notification})`

    return parsed.value
  })
}
