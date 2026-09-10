import { unblockTask } from '@slave-of-ai/control'
import { ok } from '@slave-of-ai/domain'
import { taskControlResponse } from '../../../../../../../server/taskControlRoute'
import { archivedRefusal } from '../../../../../../../server/workspaceControlRoute'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * The operator's exit from `blocked` (M45 R2), which had no web route at all until now -- the verb
 * has existed since M35 and only the CLI could reach it (M45 plan erratum E10).
 *
 * No new autonomy and no new rules: `unblockTask` still refuses a task that is not `blocked`, one
 * with a live run, and one at its attempt ceiling, and still decides for itself whether the task
 * belongs in `rework` or back in `reviewing`.
 *
 * An archived project is not a project anybody writes to (M27 §3.3), and `taskControlResponse` has
 * no archived check of its own -- it 404s a task outside this workspace, not one inside an archived
 * one. `archivedRefusal` therefore runs FIRST, exactly as the task-dependency route does it (final
 * wave I1): without it a blocked task could be put back on an archived project's board.
 *
 * `taskControlResponse` takes a `Result<void, ...>` and this verb returns the status it chose, so
 * the success arm is mapped rather than the shell widened: which status it picked is shown by the
 * board's own refetch a moment later, and widening a shell five routes share for one of them would
 * be a change to all five.
 */
export async function POST(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; taskId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, taskId } = await context.params
  const archived = await archivedRefusal(workspaceId)
  if (archived !== null) return archived
  return taskControlResponse(workspaceId, taskId, async () => {
    const result = await unblockTask(taskId, {}, gate.principal ?? undefined)
    return result.ok ? ok(undefined) : result
  })
}
