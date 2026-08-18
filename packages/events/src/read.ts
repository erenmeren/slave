import { toExecutionEvent } from '@ai-team-os/db'
import { prisma } from '@ai-team-os/db/client'
import type { ExecutionEvent } from '@ai-team-os/domain'

export const DEFAULT_READ_LIMIT = 500

/**
 * Reads forward from `seq`, exclusive. An unparseable row throws rather than being skipped: the
 * write gate guarantees every row parses, so a failure here means that guarantee has been
 * bypassed, and continuing quietly would hide it.
 */
export async function readEventsSince(
  seq: number,
  limit: number = DEFAULT_READ_LIMIT,
): Promise<ExecutionEvent[]> {
  const rows = await prisma.executionEvent.findMany({
    where: { seq: { gt: BigInt(seq) } },
    orderBy: { seq: 'asc' },
    take: limit,
  })

  return rows.map((row) => {
    const parsed = toExecutionEvent(row)
    if (!parsed.ok) {
      throw new Error(`event log contains an unparseable row at seq ${String(row.seq)}: ${parsed.error}`)
    }
    return parsed.value
  })
}
