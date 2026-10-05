import { prisma } from '@slave-of-ai/db/client'
import { LEAD_TEAM_NAME, err, ok, type Result } from '@slave-of-ai/domain'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'
import { liveRunCount, projectFootprint, type Footprint } from './workspace.js'

/** What {@link deleteWorkspace} removed: the project's own counts, and the rows no foreign key reached. */
export interface DeletedProject {
  readonly name: string
  /** The repository the project pointed at -- left on disk exactly as it was. */
  readonly repoPath: string
  readonly footprint: Footprint
  readonly events: number
  readonly intakes: number
  /** The lead flow's system persons (`Lead <id>`, `Verifier <id>`, `Confirmer <id>`): this project's own. */
  readonly systemPersons: number
}

/**
 * What one `$transaction` may take: a project with a long history has tens of thousands of event
 * rows, and the delete holds the workspace row's lock for all of it.
 */
const DELETE_TIMEOUT_MS = 120_000

/**
 * Lead UX design section 10: deletes a project and everything under it. Until now only
 * `archiveWorkspace` existed (M27 kept a project's rows on purpose), and the operator removed two
 * projects by hand in SQL on 2026-10-05.
 *
 * Refused while a run is live, as every M27 verb is. Otherwise, in one transaction under the
 * workspace row's lock (the archive's lock, for the archive's reason: a dispatch re-reads the row
 * `FOR SHARE` before it inserts a run):
 *
 * - the rows that carry the project's id with no cascading foreign key -- `ExecutionEvent` and
 *   `InboundEvent` (bare columns, by design: the log outlives a mapping), `SlaveMessage` (it hangs
 *   off its slave and task, both cascaded, but is cleared here by its own column so none is left
 *   behind) and `Intake` (its foreign key is `SetNull`: the conversation would outlive the project
 *   it created; its messages cascade from it);
 * - the `Workspace` row, from which every other table of the project cascades (teams, seats, runs,
 *   tasks, builds, checks, decisions, memories, credentials);
 * - the lead flow's three system persons of THIS project: `Person` rows with no catalogue template
 *   whose every seat was in its `Lead flow` team. A catalogue person who held a seat here keeps
 *   their row -- they belong to the catalogue, not to the project.
 *
 * It never touches the repository on disk, its branches or its worktrees: the code is the
 * person's, and Slave never deletes it. The returned `repoPath` is what the caller says is kept.
 * No event is written: the project's log is what is being deleted.
 */
export async function deleteWorkspace(workspaceId: string, _principal?: Principal): Promise<Result<DeletedProject, ControlRefusal>> {
  return prisma.$transaction(
    async (tx): Promise<Result<DeletedProject, ControlRefusal>> => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
      // Both refusals are returned before the first write, so returning them commits nothing.
      if (locked.length === 0) return err({ kind: 'workspace_not_found', workspaceId })
      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { name: true, repoPath: true } })
      const runs = await liveRunCount(tx, { workspaceId })
      if (runs > 0) return err({ kind: 'live_runs', entity: 'workspace', id: workspaceId, runs })

      const footprint = await projectFootprint(tx, workspaceId)
      const leadSeats = await tx.slave.findMany({ where: { team: { workspaceId, name: LEAD_TEAM_NAME } }, select: { personId: true } })
      const candidates = [...new Set(leadSeats.map((seat) => seat.personId))]
      const systemPersons = (
        await tx.person.findMany({
          where: { id: { in: candidates }, templateId: null, seats: { none: { team: { workspaceId: { not: workspaceId } } } } },
          select: { id: true },
        })
      ).map((person) => person.id)

      const events = await tx.executionEvent.deleteMany({ where: { workspaceId } })
      await tx.inboundEvent.deleteMany({ where: { workspaceId } })
      await tx.slaveMessage.deleteMany({ where: { workspaceId } })
      const intakes = await tx.intake.deleteMany({ where: { workspaceId } })
      await tx.workspace.delete({ where: { id: workspaceId } })
      // After the workspace: its seats are gone with it, so nothing points at these persons now.
      const persons = await tx.person.deleteMany({ where: { id: { in: systemPersons } } })

      return ok({ name: workspace.name, repoPath: workspace.repoPath, footprint, events: events.count, intakes: intakes.count, systemPersons: persons.count })
    },
    { maxWait: 10_000, timeout: DELETE_TIMEOUT_MS },
  )
}
