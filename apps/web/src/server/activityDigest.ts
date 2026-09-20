import { prisma } from '@slave-of-ai/db/client'
import { loadHappeningRows } from './happeningRows'
import { localDay, whenLabel } from './supervisorThreads'

/** One happening, digest-shaped (M61 R10). */
export interface DigestItem {
  readonly id: string
  /** ISO. */
  readonly at: string
  readonly type: string
  readonly sentence: string
  readonly actorName: string | null
  readonly workspaceId: string
}

/** One calendar day's worth of happenings, newest first. `id` IS the local day (`YYYY-MM-DD`) --
 *  the same grouping idiom `SupervisorThread.id` uses, and the same function (`localDay`) buckets
 *  by, so the two readers of the same event log can never disagree about which day it landed on. */
export interface DigestDay {
  readonly id: string
  readonly when: string
  readonly items: readonly DigestItem[]
}

export const ACTIVITY_DIGEST_LIMIT_DEFAULT = 200

/**
 * Simple mode's Activity tab (M61 R10): the workspace's `HAPPENING_TYPES` events, said as
 * sentences and grouped by local calendar day -- the same day/`when` rule `buildSupervisorThreads`
 * uses, reused rather than restated. `null` for a workspace that does not exist; `[]` for one with
 * no happenings at all.
 *
 * Days newest first; within a day, items newest first -- `loadHappeningRows` already pages
 * `seq desc`, so pushing each row into its day's bucket in the order it arrives keeps that order
 * with no re-sort needed.
 */
export async function buildActivityDigest(
  workspaceId: string,
  now: Date = new Date(),
  limit: number = ACTIVITY_DIGEST_LIMIT_DEFAULT,
): Promise<readonly DigestDay[] | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const rows = await loadHappeningRows({ workspaceId }, limit)

  const byDay = new Map<string, DigestItem[]>()
  for (const row of rows) {
    const day = localDay(new Date(row.at))
    const item: DigestItem = {
      id: row.id,
      at: row.at,
      type: row.type,
      sentence: row.sentence,
      actorName: row.actorName,
      workspaceId: row.workspaceId,
    }
    const bucket = byDay.get(day)
    if (bucket === undefined) byDay.set(day, [item])
    else bucket.push(item)
  }

  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, items]) => ({ id: day, when: whenLabel(day, now), items }))
}
