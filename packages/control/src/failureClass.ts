import { prisma, type Prisma } from '@slave-of-ai/db/client'
import { PROVIDER_BACKOFF_ROWS, providerBackoffUntil } from '@slave-of-ai/domain'

/**
 * H9b R1: the Prisma `where` fragment for "a run that is not a platform failure" -- `failureClass`
 * is `worker`, or there is none (a run that did not fail, or a failure written before the column
 * existed, which counts as the worker's). Spread into a count's `where`: beside `status: 'failed'`
 * it is "the failures the worker is charged for", and alone it is "the attempts that were really
 * made" (`dispatchReview`'s retry cap).
 *
 * Spelt as an `OR` with `null` on purpose, and shared so nobody spells it again: the obvious
 * `failureClass: { not: 'platform' }` compiles to `"failureClass" <> 'platform'`, which is NULL --
 * not true -- for every unclassified row, so it silently stops counting every failure older than
 * the column. The raw-SQL readers (`workspaceStats`) say `IS DISTINCT FROM` for the same reason.
 */
export const NOT_PLATFORM_FAILURE = {
  OR: [{ failureClass: null }, { failureClass: 'worker' as const }],
}

/**
 * H9b R1 (F5): when the line of work `where` names may next be dispatched after a provider refusal,
 * or null when it may be dispatched now -- `providerBackoffUntil` over its newest concluded runs.
 *
 * `where` names ONE line of work: a task's `review` runs (`dispatchReview`), a workspace's
 * `planning` runs (`dispatchPlanning`). Implementation runs are read in bulk by the scheduler's own
 * loader (`loadWorld`), which cannot afford a query per task inside its snapshot. Only `failed` and
 * `succeeded` rows: an operator's stop is neither the provider refusing nor the provider answering,
 * and a live run has not concluded.
 */
export async function providerBackoffFor(
  where: Prisma.SlaveRunWhereInput,
  client: Pick<typeof prisma, 'slaveRun'> = prisma,
): Promise<Date | null> {
  const rows = await client.slaveRun.findMany({
    where: { ...where, status: { in: ['failed', 'succeeded'] } },
    // The breaker's own sort key: when the run CONCLUDED, `startedAt` standing in for a row that
    // never recorded one.
    orderBy: [{ terminalAt: { sort: 'desc', nulls: 'last' } }, { startedAt: 'desc' }],
    take: PROVIDER_BACKOFF_ROWS,
    select: { providerError: true, terminalAt: true, startedAt: true },
  })
  return providerBackoffUntil(rows.map((row) => ({ providerError: row.providerError, concludedAt: row.terminalAt ?? row.startedAt })))
}
