import { listGoalVersions, type GoalVersionView } from '@slave-of-ai/control'

export type { GoalVersionView }

/**
 * The goal's whole history as the Settings tab reads it (M40 §6), or `null` for a workspace that
 * does not exist.
 *
 * A READ, and a thin one: `listGoalVersions` already orders newest first and computes each row's
 * line diff against the version it replaced, so there is nothing for the web to decide. What this
 * builder is for is the SHAPE of the answer -- the control verb refuses an unknown workspace with a
 * `ControlRefusal`, and a route owes its caller a 404 for that rather than a 409 envelope. Turning
 * the one refusal that verb can make into `null` here is the same translation
 * `buildSupervisorView` does, and it keeps the route free of `refusalText` for a read that has
 * nothing else to refuse.
 */
export async function buildGoalHistory(workspaceId: string): Promise<readonly GoalVersionView[] | null> {
  const result = await listGoalVersions(workspaceId)
  return result.ok ? result.value : null
}
