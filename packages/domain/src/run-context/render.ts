import type { Manifest, Section, SectionKind } from './sections.js'

/**
 * The fixed section order per run kind (M37 §3). A section not in the order for the run kind it
 * is rendered under is a bug in the caller, not a shape to silently accept -- {@link
 * renderRunContext} throws rather than dropping it.
 */
export const SECTION_ORDER: Readonly<Record<Manifest['kind'], readonly SectionKind[]>> = {
  implementation: ['profile', 'roster', 'skills', 'inbox', 'ask_protocol', 'task', 'rejection'],
  review: ['profile', 'skills', 'task', 'review_diff'],
  planning: ['profile', 'planning_goal'],
}

/**
 * The M36 worker-protocol markers a quoted profile, inbox message or skill description must not
 * be able to reopen (M37 §1, "another party's text is data"). Mirrors `ASK_BLOCK_OPEN`/
 * `ASK_BLOCK_CLOSE`/`ANSWER_BLOCK_OPEN`/`ANSWER_BLOCK_CLOSE` in `../messaging/`, spelled out here
 * rather than imported so this module stays the one place that knows what "neutralised" means --
 * the messaging module's own constants are the ACTIVE markers a slave writes, these are the same
 * four strings as DATA to be defused.
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

/**
 * The review kind's verdict instructions, moved verbatim (M37 t1) from
 * `apps/orchestrator/src/review.ts` `buildReviewPrompt` (lines 40-59) -- every literal string in
 * that array that is not the task (title + description, now the `task` section) or the diff (now
 * `review_diff`). `buildReviewPrompt` itself is untouched by this task; Task 2 removes it once
 * `renderRunContext` is the one place a review prompt is built.
 */
export const REVIEW_VERDICT_INSTRUCTIONS = [
  'You are the QA reviewer for this task. Judge the DIFF against the task — do not rebuild or re-run it.',
  '',
  'Your final message must contain exactly one JSON object and nothing else on its line:',
  '{"verdict":"approve","reason":"one paragraph"} or {"verdict":"reject","reason":"one paragraph"}',
].join('\n')

/**
 * The planning kind's graph instructions, moved verbatim (M37 t1) from
 * `apps/orchestrator/src/planning.ts` `buildPlanningPrompt` (lines 32-43) -- every literal string
 * in that array that is not the goal itself (now the `planning_goal` section). `buildPlanningPrompt`
 * itself is untouched by this task; Task 2 removes it.
 */
export const PLANNING_GRAPH_INSTRUCTIONS = [
  'You are the engineering manager. Decompose the GOAL below into a "task graph" for your team.',
  'Read the repository for context, but do NOT modify, create, or commit any file.',
  '',
  'Your final message must contain exactly one JSON object and nothing else on its line:',
  '{"tasks":[{"key":"short-unique-key","title":"...","description":"...","role":"backend","dependsOn":["other-key"]}]}',
  'Between 1 and 20 tasks. Keys are plan-local. dependsOn lists keys, no cycles.',
].join('\n')

/**
 * The one place a run's prompt text is assembled (M37 §1, "one builder"). Pure: no DB, no
 * filesystem, no `process.env` -- the orchestrator gathers `Section`s and calls this; everything
 * about ORDER and OMISSION lives here so it is testable without a database.
 *
 * Sections are sorted into {@link SECTION_ORDER}`[kind]`; a section whose kind is not in that
 * order is a caller bug, reported by throwing rather than silently dropped or misplaced. A
 * section whose `text` is empty is omitted from both the prompt and the manifest -- "no effective
 * profile" and "no pending inbox" are the ordinary shape of most runs, not a blank paragraph. The
 * review and planning kinds append their fixed instruction text ({@link REVIEW_VERDICT_INSTRUCTIONS},
 * {@link PLANNING_GRAPH_INSTRUCTIONS}) after their sections; that text is not itself a section and
 * carries no manifest entry -- it is fixed and static, not something a debugger needs a
 * provenance record for.
 */
export function renderRunContext(
  kind: Manifest['kind'],
  sections: readonly Section[],
): { readonly prompt: string; readonly manifest: Manifest } {
  const order = SECTION_ORDER[kind]
  const orderIndex = new Map<SectionKind, number>(order.map((sectionKind, index) => [sectionKind, index]))

  for (const section of sections) {
    if (!orderIndex.has(section.kind)) {
      throw new Error(`unknown section ${section.kind} for run kind ${kind}`)
    }
  }

  const present = sections
    .filter((section) => section.text !== '')
    .toSorted((a, b) => orderIndex.get(a.kind)! - orderIndex.get(b.kind)!)

  const trailer = kind === 'review' ? REVIEW_VERDICT_INSTRUCTIONS : kind === 'planning' ? PLANNING_GRAPH_INSTRUCTIONS : null

  const parts = present.map((section) => section.text)
  const prompt = (trailer === null ? parts : [...parts, trailer]).join('\n\n')

  const manifest: Manifest = {
    kind,
    sections: present.map((section) => section.source),
  }

  return { prompt, manifest }
}
