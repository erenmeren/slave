import { loadGoalReport, postSupervisorNote, refusalText } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { GOAL_REPORT_NOTE_KEY_PREFIX, goalReportSummary } from '@slave-of-ai/domain'

/** What {@link restingKey} reads off a delivery row. */
export interface RestingDelivery {
  readonly id: string
  readonly workspaceId: string
  readonly goalVersion: number
  readonly status: 'integrating' | 'verifying' | 'accepted' | 'needs_human' | 'abandoned'
  readonly round: number
  readonly mergedAt: Date | null
  readonly mergeError: string | null
  readonly acceptedAt: Date | null
}

/**
 * Where a goal version is resting, as the key its chat note is posted under (plan D10), or null
 * while it is still moving. The keys are the migration's backfill, spelled the same, except that
 * `awaiting_merge` now names its wait (the backfill's bare form is read by {@link coversLegacyWait}):
 * - `merged`: it reached the base branch, by the goal pass or a person's confirmed hand merge.
 * - `abandoned`: the person moved on.
 * - `needs_human:r<round>`: the loop stopped. A version stops at most once per round (Plan 4b), so
 *   every stop gets its own note.
 * - `awaiting_merge:r<round>:<wait>`: verified, and waiting. `hand` is waiting for a person to
 *   merge it: `autoMerge` is off, git refused the merge (`mergeError`), or the goal pass has tripped
 *   about it since it was accepted for any reason but a dirty checkout (the base moved). `checkout`
 *   is the goal pass's "waits for a clean checkout" trip (final wave M8): the person cleans the
 *   checkout and Slave tries again. The wait is on the key (wording fix W2) because one round can
 *   rest twice: a version waiting for a clean checkout whose base moves meanwhile waits for a hand
 *   merge instead, and that is a new note. An accepted version the next pass will fast-forward is
 *   not resting, and gets its note as `merged`.
 *
 * Accepted limit (controller ruling R8): the goal pass trips once per identical message
 * (`tripOnce`), so a version that is re-accepted in the same round after a retry and then waits
 * again for the SAME reason writes no newer trip and gets no fresh `awaiting_merge` note. A wait
 * that goes checkout, hand, checkout in one round gets no third note either: the note for that key
 * exists (`noteKey`). It still gets its `merged` note when it lands, and the report shows the wait.
 */
export async function restingKey(delivery: RestingDelivery, autoMerge: boolean): Promise<string | null> {
  if (delivery.mergedAt !== null) return 'merged'
  if (delivery.status === 'abandoned') return 'abandoned'
  if (delivery.status === 'needs_human') return `needs_human:r${String(delivery.round)}`
  if (delivery.status !== 'accepted') return null
  const awaiting = `awaiting_merge:r${String(delivery.round)}`
  if (!autoMerge || delivery.mergeError !== null) return `${awaiting}:hand`
  const detail = await acceptedWait(delivery)
  if (detail === null) return null
  // The prefix is `goal.ts`'s own trip text.
  return detail.startsWith(`goal v${String(delivery.goalVersion)} is accepted and waits for a clean checkout`) ? `${awaiting}:checkout` : `${awaiting}:hand`
}

/** The newest goal-pass trip about an accepted version since it was accepted (what it waits for),
 *  or null. `goal v<n> is accepted` with the space after the number: v1's prefix never matches
 *  v10's trips. */
async function acceptedWait(delivery: RestingDelivery): Promise<string | null> {
  const trip = await prisma.executionEvent.findFirst({
    where: {
      workspaceId: delivery.workspaceId,
      type: 'guardrail_tripped',
      ...(delivery.acceptedAt === null ? {} : { ts: { gte: delivery.acceptedAt } }),
      payload: { path: ['detail'], string_starts_with: `goal v${String(delivery.goalVersion)} is accepted` },
    },
    orderBy: { seq: 'desc' },
    select: { payload: true },
  })
  if (trip === null) return null
  const detail = (trip.payload as { readonly detail?: unknown } | null)?.detail
  return typeof detail === 'string' ? detail : ''
}

/**
 * Backward compatibility (wording fix W2): a stamp of the bare `awaiting_merge:r<n>` -- the
 * migration's backfill, or a note posted before the key named the wait -- does not say which wait
 * it was posted for. It was posted (or backfilled) while the version rested in round n, so it
 * covers the wait the version is in now in that round: no note, and the stamp is rewritten to name
 * that wait, so a later DIFFERENT wait in the round is news. A wait that changed between the old
 * note and the first pass after the upgrade is taken as covered too -- the behaviour before the
 * key named the wait, so nothing gets worse. A later round's key never matches.
 */
function coversLegacyWait(stamped: string | null, key: string): boolean {
  return stamped !== null && /^awaiting_merge:r\d+$/u.test(stamped) && key.startsWith(`${stamped}:`)
}

/**
 * The Supervisor chat's side of spec R10 (plan D10): each goal version that has come to a new
 * resting point since its last note gets its report's summary, posted once (`postSupervisorNote`'s
 * key), and the delivery is stamped with the point. Driven by the delivery rows, never by scanning
 * the event log. The rows that can rest are few, and the one event query runs only for an accepted
 * version with `autoMerge` on. Returns how many notes this pass posted. An archived project gets
 * none (the tick does not reach one; the CLI's one-shot might). A halted one does: nothing here
 * calls a model or spends.
 *
 * Plan D11: there is no thread per goal. The note lands in the conversation as it stands when the
 * version comes to rest -- the day's thread -- as that thread's last word about the version.
 */
export async function postGoalReportNotes(workspaceId: string): Promise<number> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { autoMerge: true, archivedAt: true } })
  if (workspace === null || workspace.archivedAt !== null) return 0
  const deliveries = await prisma.goalDelivery.findMany({
    where: { workspaceId, OR: [{ mergedAt: { not: null } }, { status: { in: ['needs_human', 'abandoned', 'accepted'] } }] },
    orderBy: { goalVersion: 'asc' },
    select: { id: true, workspaceId: true, goalVersion: true, status: true, round: true, mergedAt: true, mergeError: true, acceptedAt: true, reportNotedKey: true },
  })
  let posted = 0
  for (const delivery of deliveries) {
    const key = await restingKey(delivery, workspace.autoMerge)
    if (key === null || key === delivery.reportNotedKey) continue
    if (coversLegacyWait(delivery.reportNotedKey, key)) {
      await prisma.goalDelivery.updateMany({ where: { id: delivery.id, reportNotedKey: delivery.reportNotedKey }, data: { reportNotedKey: key } })
      continue
    }
    const report = await loadGoalReport(workspaceId, delivery.goalVersion)
    if (!report.ok) {
      console.warn(`[report] no note for goal v${String(delivery.goalVersion)}: ${refusalText(report.error)}`)
      continue
    }
    const note = await postSupervisorNote(workspaceId, {
      text: goalReportSummary(report.value, { waitsForCleanCheckout: key.endsWith(':checkout') }),
      noteKey: `${GOAL_REPORT_NOTE_KEY_PREFIX}v${String(delivery.goalVersion)}:${key}`,
      goalReportVersion: delivery.goalVersion,
    })
    if (!note.ok) {
      console.warn(`[report] no note for goal v${String(delivery.goalVersion)}: ${refusalText(note.error)}`)
      continue
    }
    // Guarded on the value this pass read: a concurrent pass that already stamped a newer point wins.
    await prisma.goalDelivery.updateMany({ where: { id: delivery.id, reportNotedKey: delivery.reportNotedKey }, data: { reportNotedKey: key } })
    if (note.value.created) posted += 1
  }
  return posted
}
