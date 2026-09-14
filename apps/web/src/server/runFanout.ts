import { prisma } from '@slave-of-ai/db/client'
import { requestResume, type Principal } from '@slave-of-ai/control'

export interface FanoutReport {
  readonly requested: readonly string[]
  readonly refused: readonly string[]
}

/**
 * Ask every paused run of one workspace to resume (M57 R14b).
 *
 * The MIRROR of `pauseActiveRuns` (`packages/control/src/pause.ts:158`), and deliberately NOT a
 * second copy of it in the control package: `pauseActiveRuns` exists because an emergency stop
 * needs it, and resuming has never had a domain-level fan-out. What this is, is the web's own loop
 * over the EXISTING per-run verb -- the same `requestResume` the Resume button on a single worker
 * card already calls, once per run. No new control verb, no new event type; the events are the
 * `run.resume_requested` rows each call already writes.
 *
 * Per-run tolerance, the same rule `pauseActiveRuns` documents at length: a run that lost a status
 * race between the query and the verb belongs in `refused`, never in an exception that would
 * abandon the rest of the fan-out and leave half a project resumed with nothing saying so. A run
 * with no checkpoint refuses here for the same reason it refuses on the card -- nobody can execute
 * that intent -- and lands in `refused` rather than stopping the loop.
 *
 * `slave -> team -> workspaceId`, not `task -> workspaceId`: a `planning` run has no `Task` row at
 * all, and scoping through `Task` would silently skip it.
 */
export async function resumeActiveRuns(
  workspaceId: string,
  requestedBy: string,
  principal?: Principal,
): Promise<FanoutReport> {
  const runs = await prisma.slaveRun.findMany({
    where: { status: 'paused', slave: { team: { workspaceId } } },
    select: { id: true },
  })

  const requested: string[] = []
  const refused: string[] = []
  for (const run of runs) {
    try {
      const result = await requestResume(run.id, null, requestedBy, principal)
      if (result.ok) requested.push(run.id)
      else refused.push(run.id)
    } catch {
      refused.push(run.id)
    }
  }
  return { requested, refused }
}
