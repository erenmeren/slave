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
 * collapse, and the entry is one line. A multi-line paste would otherwise break the list, and the
 * request a person typed is kept, trimmed, in `GoalVersion.request` and in the
 * `workspace.goal_set` event either way.
 *
 * The entry lands at the END OF THE MATCHED SECTION, not at the end of the document: a goal is a
 * document an operator edits, and a `## Constraints` section written after the request list must
 * stay after it. The heading is matched as a whole LINE -- a body that merely mentions the words
 * in a sentence gets a real section opened for it, rather than a bullet dropped into prose.
 */
export function composeGoal(previous: string | null, request: string, at: Date): string {
  // Before the entry is built: a project with no goal takes the request AS its body, and there is
  // no list, no date stamp and no heading to compose (plan erratum E7).
  if (previous === null || previous.trim() === '') return request.trim()

  const entry = `- ${dateStamp(at)}: ${request.replace(/\s+/gu, ' ').trim()}`
  const lines = previous.replace(/\s+$/u, '').split('\n')
  const heading = lines.findIndex((line) => line.trim() === REQUESTED_CHANGES_HEADING)
  if (heading === -1) {
    return `${lines.join('\n')}\n\n${REQUESTED_CHANGES_HEADING}\n\n${entry}\n`
  }

  // The section ends at the next heading of any level, or at the end of the document. Blank lines
  // between the last entry and that heading belong to the SEPARATION, not to the list, so the new
  // entry goes above them and the document keeps its shape.
  const next = lines.findIndex((line, index) => index > heading && /^#{1,6}\s/u.test(line))
  let end = next === -1 ? lines.length : next
  while (end > heading + 1 && lines[end - 1]?.trim() === '') end -= 1
  return `${[...lines.slice(0, end), entry, ...lines.slice(end)].join('\n')}\n`
}
