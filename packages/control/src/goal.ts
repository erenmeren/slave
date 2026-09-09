import { prisma } from '@slave-of-ai/db/client'
import { type GoalDiff, type Result, err, goalDiff, goalSha256, ok } from '@slave-of-ai/domain'
import { appendEvent } from '@slave-of-ai/events'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/**
 * Set the workspace's standing goal, as a NEW VERSION of it (M40 §1).
 *
 * The goal is a versioned requirement, not a mutable string: every accepted set inserts a
 * `GoalVersion` row at `version = goalVersion + 1` and moves the workspace's own `goal` /
 * `goalVersion` columns to it. Those columns are a CACHE of the newest version -- every reader that
 * predates M40 keeps working unchanged -- and the history beside them is what makes a goal edit
 * something the system can react to: the re-plan trigger (Task 3) fires on the version number, and
 * a task carries the version its plan derived from.
 *
 * Succeeds even on a workspace that already has tasks on its board: the FIRST planning pass stays
 * dormant until the board is empty, but an operator revising the goal mid-milestone is ordinary,
 * and from M40 on it is exactly what a re-plan run is for.
 *
 * `goal` is stored untrimmed, as it always was, and hashed untrimmed too -- `goalSha256` is the
 * domain's hand-rolled hash over raw UTF-8, the same function the migration's backfill agrees with
 * and the only one used for a goal anywhere (`node:crypto` would break the web bundle).
 *
 * Returns the version it wrote and that text's hash, so a caller can report "goal v3 saved" without
 * a second read.
 */
export async function setGoal(
  workspaceId: string,
  goal: string,
  principal?: Principal,
): Promise<Result<{ readonly version: number; readonly sha256: string }, ControlRefusal>> {
  if (goal.trim() === '') return err({ kind: 'invalid_goal' })
  const sha256 = goalSha256(goal)

  // One locked transaction for the read, the decision and the two writes -- the `failTask` idiom on
  // a workspace. Without `SELECT ... FOR UPDATE` two concurrent sets both read the same
  // `goalVersion` and both try to write `goalVersion + 1`, and the compound unique
  // `(workspaceId, version)` turns the loser into a thrown Prisma error instead of the next
  // version. Both refusals below are reached BEFORE anything is written, so returning them as
  // values is safe; a refusal after a write would have to throw or Prisma would commit that write.
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, goalVersion: true },
    })
    if (workspace === null) {
      return { ok: false as const, error: { kind: 'workspace_not_found', workspaceId } as ControlRefusal }
    }

    // Erratum E5, decided INSIDE the lock so the version it compares against is the version the
    // insert below would follow. Only the CURRENT version is compared, never the whole history:
    // returning to an older wording is a real edit and must produce a real version, because a
    // version is what the re-plan trigger counts. `goalVersion: 0` means no version was ever
    // recorded, so there is nothing to be unchanged from.
    const current =
      workspace.goalVersion === 0
        ? null
        : await tx.goalVersion.findUnique({
            where: { workspaceId_version: { workspaceId, version: workspace.goalVersion } },
            select: { sha256: true },
          })
    if (current !== null && current.sha256 === sha256) {
      return {
        ok: false as const,
        error: { kind: 'goal_unchanged', workspaceId, version: workspace.goalVersion } as ControlRefusal,
      }
    }

    const version = workspace.goalVersion + 1
    await tx.goalVersion.create({
      data: { workspaceId, version, text: goal, sha256, setByUserId: principal?.userId ?? null },
    })
    await tx.workspace.update({
      where: { id: workspaceId },
      data: { goal, goalSetByUserId: principal?.userId ?? null, goalVersion: version },
    })
    return { ok: true as const, version }
  })
  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'workspace.goal_set',
    workspaceId,
    actor: 'human',
    payload: { goal, version: outcome.version, sha256 },
    userId: principal?.userId ?? null,
  })

  return ok({ version: outcome.version, sha256 })
}

/** One version of a workspace's goal as a reader sees it (M40 §4): the stored row, plus what
 *  changed since the version before it. `createdAt` is an ISO string so a web route can serialise
 *  the view unchanged. */
export interface GoalVersionView {
  readonly version: number
  readonly text: string
  readonly sha256: string
  readonly setByUserId: string | null
  readonly createdAt: string
  /** The line-level difference against the PREVIOUS version, or null for the first one -- v1 is
   *  the requirement's beginning and has nothing to be compared with. */
  readonly diff: GoalDiff | null
}

/**
 * The whole history of a workspace's goal, newest first (M40 §4).
 *
 * Newest first because that is the order a history is read in, and it makes each row's `diff` the
 * answer to "what did this edit change" -- the diff of a row is against the row AFTER it in the
 * list, which is the version it replaced.
 *
 * An unknown workspace is refused rather than answered with an empty list: "this project has no
 * goal history" and "there is no such project" are different facts, and a caller that cannot tell
 * them apart will show the wrong one.
 */
export async function listGoalVersions(
  workspaceId: string,
): Promise<Result<readonly GoalVersionView[], ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })

  const rows = await prisma.goalVersion.findMany({
    where: { workspaceId },
    orderBy: { version: 'desc' },
    select: { version: true, text: true, sha256: true, setByUserId: true, createdAt: true },
  })

  return ok(
    rows.map((row, index) => {
      const previous = rows[index + 1]
      return {
        version: row.version,
        text: row.text,
        sha256: row.sha256,
        setByUserId: row.setByUserId,
        createdAt: row.createdAt.toISOString(),
        diff: previous === undefined ? null : goalDiff(previous.text, row.text),
      }
    }),
  )
}
