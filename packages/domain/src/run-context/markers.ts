/**
 * The M36 worker-protocol markers a quoted profile, inbox message or skill description must not
 * be able to reopen (M37 §1, "another party's text is data"). Mirrors `ASK_BLOCK_OPEN`/
 * `ASK_BLOCK_CLOSE`/`ANSWER_BLOCK_OPEN`/`ANSWER_BLOCK_CLOSE` in `../messaging/`, spelled out here
 * rather than imported so this module stays the one place that knows what "neutralised" means --
 * the messaging module's own constants are the ACTIVE markers a slave writes, these are the same
 * four strings as DATA to be defused.
 *
 * These two live in a LEAF module of their own (M48 t1), re-exported by `./render.ts` so every
 * caller since M37 is untouched. The reason is the import graph: `render.ts` imports
 * `REPLAN_INSTRUCTIONS` from `../planning/delta.js`, `delta.ts` reads `planGraphSchema.shape` off
 * `../planning/graph.js` at MODULE scope, and `graph.ts` needs the handoff schema -- so
 * `../handoff/contract.ts` reaching straight into `render.ts` for `neutraliseMarkers` closed a
 * four-module cycle and left `planGraphSchema` undefined at the moment `delta.ts` evaluated. This
 * file imports nothing, which is what makes the graph acyclic again.
 */
export const MARKERS = ['<slave-ask>', '</slave-ask>', '<slave-answer>', '</slave-answer>'] as const

/**
 * Replaces the leading `<` of each {@link MARKERS} entry with `‹` (U+2039) so a quoted marker in a
 * profile, an inbox message body or a skill description cannot be read back as a real one by
 * `parseSlaveAsk`/`parseSlaveAnswers` (M37 §1) -- reversible for a human reader (the glyph still
 * reads as an angle bracket), inert for the parser (neither function's marker string matches it).
 *
 * Applied by the orchestrator's section builders (Task 2) to profile text, inbox message bodies
 * and skill descriptions BEFORE they become `Section.text` -- never by {@link renderRunContext}
 * itself, which must leave the `ask_protocol`/`answer_protocol` sections' own raw markers alone
 * (those sections are what TEACHES the real markers to the model).
 */
export function neutraliseMarkers(text: string): string {
  let result = text
  for (const marker of MARKERS) {
    const neutralised = `‹${marker.slice(1)}`
    result = result.split(marker).join(neutralised)
  }
  return result
}
