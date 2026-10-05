import { prisma } from '@slave-of-ai/db/client'
import { err, ok, type Result } from '@slave-of-ai/domain'
import { clearHalt } from './emergency.js'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'
import { requestResume } from './resume.js'

/** What a resume fan-out asked, run by run. */
export interface ResumeFanout {
  readonly requested: readonly string[]
  readonly refused: readonly string[]
}

/**
 * Asks every paused run of one project to resume -- the mirror of `pauseActiveRuns`, which an
 * emergency stop uses. Moved here from the web's own `server/runFanout.ts` (lead UX design section
 * 10): Continue is a control verb now, and the loop it needs belongs beside the verb it loops over.
 *
 * Per-run tolerance, `pauseActiveRuns`' rule: a run that lost a status race, or has no checkpoint to
 * resume from, lands in `refused` and the loop goes on. `slave -> team -> workspaceId`, because a
 * run with no task still belongs to the project through its seat.
 */
export async function resumePausedRuns(workspaceId: string, requestedBy: string, principal?: Principal): Promise<ResumeFanout> {
  const runs = await prisma.slaveRun.findMany({ where: { status: 'paused', slave: { team: { workspaceId } } }, orderBy: { startedAt: 'asc' }, select: { id: true } })
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

/**
 * Lead UX design section 7: the Project screen's Continue -- the undo of Stop (`emergencyStop`).
 * The halt is retracted first (`clearHalt`: a run resumed into a halted project is refused), then
 * every paused run is asked to resume, so the lead continues in the same session (lead-flow spec
 * section 9: "continuing resumes the same sessions"). Refused on an archived project, which must be
 * restored before anything runs in it.
 */
export async function continueWorkspace(
  workspaceId: string,
  requestedBy: string,
  principal?: Principal,
): Promise<Result<{ readonly cleared: boolean } & ResumeFanout, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { archivedAt: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  if (workspace.archivedAt !== null) return err({ kind: 'workspace_archived', workspaceId })
  const cleared = await clearHalt(workspaceId)
  if (!cleared.ok) return cleared
  const fanout = await resumePausedRuns(workspaceId, requestedBy, principal)
  return ok({ cleared: cleared.value.cleared, ...fanout })
}
