import { REPLAN_INSTRUCTIONS } from '../planning/delta.js'
import type { Manifest, Section, SectionKind } from './sections.js'

/**
 * The fixed section order per run kind (M37 §3). A section not in the order for the run kind it
 * is rendered under is a bug in the caller, not a shape to silently accept -- {@link
 * renderRunContext} throws rather than dropping it.
 */
export const SECTION_ORDER: Readonly<Record<Manifest['kind'], readonly SectionKind[]>> = {
  // `memory` sits directly after the contract and BEFORE the rejection (M49 R3, plan decision D2):
  // what the organisation knows is context for the work, and the last attempt's rejection is the
  // instruction to act on -- so the rejection stays the last thing the worker reads.
  implementation: ['profile', 'roster', 'skills', 'inbox', 'ask_protocol', 'task', 'handoff', 'memory', 'rejection'],
  review: ['profile', 'skills', 'task', 'handoff', 'review_diff'],
  // `replan` is present only when the goal CHANGED on a non-empty board (M40 §3). It comes last,
  // after the new goal it is about, so the prompt reads "here is the goal, here is what changed
  // about it, here is what to return" -- and `renderRunContext`'s trailer choice keys on it.
  // `capabilities` is LAST (M47, plan erratum E3): the trailer that asks for the JSON object comes
  // straight after it, so the vocabulary a planner may use sits directly above the request to use
  // it. A section whose text is empty is dropped from prompt and manifest alike, so a workspace
  // with no taxonomy rows renders exactly what it rendered before this milestone.
  // `runbook` and `handoff_protocol` are mutually exclusive (one is "here is the process", the
  // other is "there is none"), and both sit after `capabilities` (M48 R4): the prompt reads goal,
  // then what changed, then the words you may use, then the process you are adapting, then the
  // request. A section whose text is empty is dropped from prompt and manifest alike.
  // `memory` is LAST on planning (M49 R3): the prompt reads goal, what changed, the words you may
  // use, the process, what this organisation already knows, then the request.
  planning: ['profile', 'planning_goal', 'replan', 'capabilities', 'runbook', 'handoff_protocol', 'memory'],
}

// The markers and their defusing live in `./markers.js` (M48 t1) and are re-exported here, so
// every caller that has imported them from this module since M37 still does. They moved because
// `../handoff/contract.ts` needs `neutraliseMarkers` and this module imports `REPLAN_INSTRUCTIONS`
// from `../planning/delta.js` -- reaching into it from the handoff module closed an import cycle
// through `../planning/graph.js` that left `planGraphSchema` undefined at evaluation time.
export { MARKERS, neutraliseMarkers } from './markers.js'

/**
 * The review kind's verdict instructions, moved verbatim (M37 t1, fix round 1) from
 * `apps/orchestrator/src/review.ts` `buildReviewPrompt` (lines 40-59) -- every literal array
 * element in that function that is not the task (title + description, now the `task` section) or
 * the diff (now `review_diff`), in order, INCLUDING both blank-string separators (the one right
 * after the intro sentence and the one right before "Your final message...") -- dropping either
 * one silently removes a blank line from the rendered prompt relative to the text this replaces.
 * `buildReviewPrompt` is gone as of M37 Task 2 -- `buildRunContext` is the one place a review
 * prompt is built, and this constant is the source of truth for the text that function used to
 * own. `apps/orchestrator/test/integration/runContext.test.ts` asserts a REAL review prompt still
 * ends with it.
 *
 * The literal substring `"verdict"` is load-bearing beyond this text's own readability (M8a): the
 * fake CLI (`packages/providers/test/fake-claude.mjs`, modes `m8a-flow`/`m8-flow`) keys on it to
 * tell a review run from a work run when neither carries any other marker it can see. A rewrite
 * that rephrased it away would silently break the fixture two gates are driven through.
 */
export const REVIEW_VERDICT_INSTRUCTIONS = [
  'You are the QA reviewer for this task. Judge the DIFF against the task — do not rebuild or re-run it.',
  '',
  '',
  'Your final message must contain exactly one JSON object and nothing else on its line:',
  '{"verdict":"approve","reason":"one paragraph"} or {"verdict":"reject","reason":"one paragraph"}',
].join('\n')

/**
 * The planning kind's graph instructions, moved verbatim (M37 t1, fix round 1) from
 * `apps/orchestrator/src/planning.ts` `buildPlanningPrompt` (lines 32-43) -- every literal array
 * element in that function that is not the goal itself (now the `planning_goal` section), in
 * order, INCLUDING both blank-string separators (the one right before `GOAL: ...` and the one
 * right after it). `buildPlanningPrompt` is gone as of M37 Task 2, and this constant is now the
 * source of truth for its text.
 *
 * The literal substring `"task graph"` is load-bearing for the same reason (M8b): the fake CLI's
 * `m8-flow` mode selects the planning arm on it. This text must also never contain `"verdict"` --
 * the same fake selects the review arm on that literal, and a planning prompt carrying it would be
 * misrouted to the review fixture.
 *
 * **The one word that is NOT verbatim** (spec erratum E6, final review): `below` is `above` here.
 * `buildPlanningPrompt` put the goal after this text; {@link SECTION_ORDER}`.planning` puts the
 * `planning_goal` section BEFORE the trailer, so a prompt still saying "the GOAL below" would end
 * with an instruction pointing at nothing and contradict the prompt it is part of.
 */
export const PLANNING_GRAPH_INSTRUCTIONS = [
  'You are the engineering manager. Decompose the GOAL above into a "task graph" for your team.',
  'Read the repository for context, but do NOT modify, create, or commit any file.',
  '',
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
 * {@link PLANNING_GRAPH_INSTRUCTIONS}, or `REPLAN_INSTRUCTIONS` when the planning run carries a
 * `replan` section) after their sections; that text is not itself a section and carries no manifest
 * entry -- it is fixed and static, not something a debugger needs a provenance record for.
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

  // A re-plan run keeps `kind: 'planning'` (spec erratum E2): the trailer is what differs, and the
  // `replan` section is what says so. Read off `present` rather than `sections`, so the trailer and
  // the manifest can never disagree -- a `replan` section whose text came back empty is in neither.
  const replanning = present.some((section) => section.kind === 'replan')
  const trailer =
    kind === 'review'
      ? REVIEW_VERDICT_INSTRUCTIONS
      : kind === 'planning'
        ? replanning
          ? REPLAN_INSTRUCTIONS
          : PLANNING_GRAPH_INSTRUCTIONS
        : null

  const parts = present.map((section) => section.text)
  const prompt = (trailer === null ? parts : [...parts, trailer]).join('\n\n')

  const manifest: Manifest = {
    kind,
    sections: present.map((section) => section.source),
  }

  return { prompt, manifest }
}
