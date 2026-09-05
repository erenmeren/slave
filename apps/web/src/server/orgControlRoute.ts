import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'

/**
 * Route shell for the org verbs (templates/companies/teams/agents/model): the goal route's
 * shell minus the workspace 404 pre-check -- these operate on catalog rows that have no owning
 * workspace of their own, so there is nothing to 404 against before running the verb.
 */
export async function orgControlResponse(
  operate: () => Promise<Result<unknown, ControlRefusal>>,
): Promise<Response> {
  const result = await operate()
  return result.ok
    ? Response.json({ ok: true })
    : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
