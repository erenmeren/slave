import { prisma } from '@slave-of-ai/db/client'
import { type GoalDiff, type Result, composeGoal, err, goalDiff, goalSha256, ok } from '@slave-of-ai/domain'
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
  options: { readonly request?: string } = {},
): Promise<Result<{ readonly version: number; readonly sha256: string }, ControlRefusal>> {
  // Checked here as well as inside the writer: a blank goal is refused before a transaction is
  // opened at all, exactly as it always was.
  if (goal.trim() === '') return err({ kind: 'invalid_goal' })
  const result = await writeGoalVersion(workspaceId, () => goal, principal, options.request ?? null)
  return result.ok ? ok({ version: result.value.version, sha256: result.value.sha256 }) : result
}

/**
 * "Tell the Supervisor what changed" (M45 R3).
 *
 * The only honest path from a sentence to a plan that this system has today: the request amends
 * the standing goal, the amendment is a new `GoalVersion`, and M40's trigger re-plans that version
 * as a delta on the next tick. Nothing here starts a run, hires anybody or cancels a task -- the
 * re-plan's additions land as tasks and its cancellations land as proposals a human approves,
 * which is exactly what the timeline shows.
 *
 * The words are kept twice: on `GoalVersion.request`, so the history can show what was asked, and
 * on the `workspace.goal_set` event, so the timeline can render the USER REQUEST lane without a
 * second read.
 *
 * `at` is a parameter so a test can pin the date the composed entry carries; it is not part of the
 * hash's meaning, only of the text.
 *
 * A request byte-equal to the newest version's is refused `duplicate_request` (spec erratum E27):
 * a double submit must not write two versions and arm two delta re-plans. `goal_unchanged` and
 * `invalid_goal` are unreachable from here -- composition always appends a dated entry, and a
 * non-blank request always composes a non-blank document.
 */
export async function requestChange(
  workspaceId: string,
  request: string,
  principal?: Principal,
  at: Date = new Date(),
): Promise<Result<{ readonly version: number; readonly sha256: string; readonly goal: string }, ControlRefusal>> {
  if (request.trim() === '') return err({ kind: 'invalid_request' })
  return writeGoalVersion(workspaceId, (previous) => composeGoal(previous, request, at), principal, request.trim())
}

/**
 * The one locked write behind both goal verbs (M45 plan erratum E6).
 *
 * `textOf` is a callback over the PREVIOUS text rather than a finished string, and that is the
 * whole point: `requestChange` has to compose against the goal this lock is holding. Composing
 * outside and then calling `setGoal` would read a body, lose the race to a concurrent set, and
 * write an amendment to a document that no longer exists -- silently dropping the other edit.
 *
 * One locked transaction for the read, the decision and the two writes -- the `failTask` idiom on
 * a workspace. Without `SELECT ... FOR UPDATE` two concurrent sets both read the same
 * `goalVersion` and both try to write `goalVersion + 1`, and the compound unique
 * `(workspaceId, version)` turns the loser into a thrown Prisma error instead of the next
 * version. Both refusals below are reached BEFORE anything is written, so returning them as
 * values is safe; a refusal after a write would have to throw or Prisma would commit that write.
 *
 * The event is appended AFTER the commit, exactly as `setGoal` always did.
 */
async function writeGoalVersion(
  workspaceId: string,
  textOf: (previous: string | null) => string,
  principal: Principal | undefined,
  request: string | null,
): Promise<Result<{ readonly version: number; readonly sha256: string; readonly goal: string }, ControlRefusal>> {
  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id = ${workspaceId} FOR UPDATE`
    const workspace = await tx.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, goal: true, goalVersion: true },
    })
    if (workspace === null) {
      return { ok: false as const, error: { kind: 'workspace_not_found', workspaceId } as ControlRefusal }
    }

    const goal = textOf(workspace.goal)
    if (goal.trim() === '') return { ok: false as const, error: { kind: 'invalid_goal' } as ControlRefusal }
    const sha256 = goalSha256(goal)

    // Erratum E5 (M40), decided INSIDE the lock so the version it compares against is the version
    // the insert below would follow. Only the CURRENT version is compared, never the whole
    // history: returning to an older wording is a real edit and must produce a real version,
    // because a version is what the re-plan trigger counts. `goalVersion: 0` means no version was
    // ever recorded, so there is nothing to be unchanged from.
    const current =
      workspace.goalVersion === 0
        ? null
        : await tx.goalVersion.findUnique({
            where: { workspaceId_version: { workspaceId, version: workspace.goalVersion } },
            select: { sha256: true, request: true },
          })

    // Spec erratum E27, and the reason this read happens inside the lock too: a person who presses
    // "Tell the Supervisor" twice must not get two versions and two delta re-plans. Byte-equality
    // against the NEWEST version's stored request only -- asking for the same change again after
    // something else has been asked in between is a real request, and the trigger should fire for
    // it. Checked before `goal_unchanged` because the composed text DOES differ (the entry is
    // dated and appended): naming the goal would name the wrong thing.
    if (request !== null && current !== null && current.request === request) {
      return {
        ok: false as const,
        error: { kind: 'duplicate_request', workspaceId, version: workspace.goalVersion } as ControlRefusal,
      }
    }

    if (current !== null && current.sha256 === sha256) {
      return {
        ok: false as const,
        error: { kind: 'goal_unchanged', workspaceId, version: workspace.goalVersion } as ControlRefusal,
      }
    }

    const version = workspace.goalVersion + 1
    await tx.goalVersion.create({
      data: { workspaceId, version, text: goal, sha256, setByUserId: principal?.userId ?? null, request },
    })
    await tx.workspace.update({
      where: { id: workspaceId },
      data: { goal, goalSetByUserId: principal?.userId ?? null, goalVersion: version },
    })
    return { ok: true as const, version, sha256, goal }
  })
  if (!outcome.ok) return err(outcome.error)

  await appendEvent({
    type: 'workspace.goal_set',
    workspaceId,
    actor: 'human',
    // Spread, not `request: request ?? undefined`: a `workspace.goal_set` written by `set-goal`
    // must carry NO `request` key at all, so a reader can tell "no request was made" from "a
    // request was made and was empty" without asking which verb wrote the row.
    payload: { goal: outcome.goal, version: outcome.version, sha256: outcome.sha256, ...(request === null ? {} : { request }) },
    userId: principal?.userId ?? null,
  })

  return ok({ version: outcome.version, sha256: outcome.sha256, goal: outcome.goal })
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
