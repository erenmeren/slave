/**
 * The skill NAME out of a `Skill` tool call's summary, shared by every server-side reader that
 * turns a `run_tool_call` event's payload into a skill's name (`server/overview.ts`'s live-run
 * chip, `server/skillGraph.ts`'s chain) -- one convention, not a second unknown-handling rule
 * invented per caller.
 *
 * The summary's shape is the parser's, not this file's: `summaryFor` writes `Skill <name>` for a
 * `Skill` call once `skill` joins `CLAUDE_SUMMARY_ARG_KEYS` (M14 Task 4, which owns that change).
 * Everything else -- a bare `Skill` from before that, a summary the parser could not fill, a
 * non-string payload -- is `null`: the word `Skill` is the TOOL's name and never a skill's, and
 * returning it where a skill name belongs would be a placeholder standing in for an unknown.
 */
export function skillNameOf(summary: unknown): string | null {
  if (typeof summary !== 'string') return null
  const match = /^Skill\s+(\S+)/.exec(summary)
  return match?.[1] ?? null
}

/**
 * The `SkillGraph` chain entry's `name` is a non-nullable `string` (unlike `overview.ts`'s
 * nullable `skill` chip, which a client renders as `—` for `null`) -- the DTO has no `null` to
 * carry, so `skillNameOf`'s `null` is written into the chain as this literal instead. It is the
 * SAME em dash the chip already prints for an unknown, chosen so the server marks an unparsable
 * call rather than filling it with the tool's own name (`'Skill'`), and so a chain entry for it
 * collapses/aggregates/edges exactly like any other named entry -- it IS the DTO's name for
 * "unknown," not a sentinel a caller has to special-case.
 */
export const UNKNOWN_SKILL_NAME = '—'
