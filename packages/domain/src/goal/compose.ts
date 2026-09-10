/** The heading the request list lives under. A markdown H2, because a goal is a document an
 *  operator edits by hand in the Settings tab and a heading is what they will expect to find. */
export const REQUESTED_CHANGES_HEADING = '## Requested changes'

/** `YYYY-MM-DD` in UTC. `toISOString` and a slice, never a locale: the same instant must produce
 *  the same bytes on every machine, which is what makes {@link composeGoal} byte-stable. */
function dateStamp(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/**
 * The next goal document, after a person told the Supervisor what changed (M45 R3).
 *
 * PURE, and byte-stable: no clock is read here, no locale is consulted, and the same three
 * arguments always produce the same string. That matters because `setGoal` refuses a text whose
 * sha256 equals the current version's -- a composer that folded in "now" would make every request
 * a new version even when nothing was asked.
 *
 * The document KEEPS ITS BODY. A request is not a new requirement, it is an amendment to the one
 * that stands, and a re-plan reads the whole document: replacing the body with the request would
 * throw away the objective and let the delta cancel everything.
 *
 * `previous === null` -- a project whose goal has never been set -- takes the request AS the body
 * (plan erratum E7). A `Requested changes` list under an empty objective is a document that says
 * what to change about nothing.
 *
 * The request is flattened onto one list entry: newlines become spaces, runs of whitespace
 * collapse, and the entry is one line. A multi-line paste would otherwise break the list, and
 * everything a person typed is preserved verbatim in `GoalVersion.request` and in the
 * `workspace.goal_set` event either way.
 */
export function composeGoal(previous: string | null, request: string, at: Date): string {
  const entry = `- ${dateStamp(at)}: ${request.replace(/\s+/gu, ' ').trim()}`
  if (previous === null || previous.trim() === '') return request.trim()
  const body = previous.replace(/\s+$/u, '')
  return body.includes(REQUESTED_CHANGES_HEADING)
    ? `${body}\n${entry}\n`
    : `${body}\n\n${REQUESTED_CHANGES_HEADING}\n\n${entry}\n`
}
