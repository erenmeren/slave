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
  // `workflow` sits directly after `skills` (conductor R6): both are "how to do this", one is what
  // the worker may reach for and the other is the order to do it in, and the checklist reads better
  // right after the tools than buried between the roster and the inbox.
  // `package` (Conductor Plan 2) sits directly under the task it belongs to -- the contract is part
  // of what the task IS. `report_protocol` is the last instruction before the rejection, which
  // stays last (M49 R3): how to report is the final rule, the last attempt's verdict the final word.
  implementation: [
    'profile',
    'roster',
    'skills',
    'workflow',
    'inbox',
    'ask_protocol',
    'task',
    'package',
    'handoff',
    'memory',
    'report_protocol',
    'rejection',
  ],
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
  // `roles` sits directly before `capabilities`: both are the vocabulary a plan may be written in,
  // and a task names one or the other, so the two lists read as one instruction. It is the narrower
  // of the two -- a role that matches no seat is a task that can be dispatched to nobody -- so it
  // comes first.
  planning: ['profile', 'planning_goal', 'replan', 'roles', 'capabilities', 'runbook', 'handoff_protocol', 'memory'],
  // Conductor Plan 4b: the verifier's profile for now; Task 3 adds the goal (requirements + the
  // integrated diff summary) and the protocol that asks for the `<slave-verification>` block.
  verification: ['profile'],
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
 * The verification kind's trailer (Conductor Plan 4b, spec R8): the last thing a verifier reads.
 * The block's shape and the rule for writing checks are the `verification_protocol` section's
 * (Task 3); this line only says where the block goes and what happens when it is missing, so a
 * verifier that forgets it knows the run is simply repeated rather than counted as a verdict.
 */
export const VERIFICATION_INSTRUCTIONS =
  'Finish with the <slave-verification> block described above as the last thing in your final message. A missing or malformed block means this verification is run again.'

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
 * NO LONGER byte-identical to that source as of E R5: the shape line gained `"needs":[]` and one
 * sentence was appended telling the planner what the field is for (spec R5). The trailer is a
 * PROMPT, not a fixture -- what is pinned about it is the two routing literals below and the
 * deviation named next, both of which the appended line leaves untouched.
 *
 * Pilot fix B added the three SIZING lines after the range. The benchmark pilot's planner, told
 * only "between 1 and 20", split one small parser change into four tasks, one of them "document
 * the token in the README" -- which the parser task had already done, so that worker had nothing to
 * do but stop and ask, and the project stalled on its question. One session's work is one task; a
 * split has to be one each side of which can be built and checked alone; and docs travel with the
 * change they describe. The range stays: the schema still accepts 1 to 20, and the rule is about
 * which end of it a goal belongs at. None of the three may carry a routing literal either.
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
  '{"tasks":[{"key":"short-unique-key","title":"...","description":"...","role":"backend","dependsOn":["other-key"],"needs":[]}]}',
  'Between 1 and 20 tasks. Keys are plan-local. dependsOn lists keys, no cycles.',
  'Size the graph to the work, not to the limit. If the whole GOAL fits one focused session -- one coherent change a single engineer would make in one sitting -- return exactly ONE task.',
  'Split only along boundaries where each task can be built AND verified on its own.',
  'Never create a separate task to document a change another task makes (README, docs, changelog): the task that changes the behaviour updates its own docs and tests.',
  'A task that must read the web carries "needs": ["network_fetch"]; one that must run commands beyond the repository\'s own scripts carries "run_commands"; most tasks carry neither.',
].join('\n')

/**
 * The implementation kind's working rules (H9 F9) -- the one fixed text an implementation run
 * ends with, as the verdict and graph instructions end the other two kinds.
 *
 * Why it exists: a Cursor worker loaded the person's own process plugin, brainstormed, planned,
 * dispatched seven helpers of its own and ran its own review rounds inside one task -- three
 * 30-minute timeouts, two edits in 59 tool calls. The adapters now spawn workers without the
 * person's plugins (`@slave-of-ai/providers`' `cursor/home.ts` and `claude/flags.ts`); this is the
 * same rule said to the model, for whatever a vendor loads that no spawn flag reaches.
 *
 * Its last sentences are H9 F6: a headless worker's own ask-the-user tool (`askQuestion`,
 * `AskUserQuestion`) is refused by the runtime, because nobody is there to answer. The refusal no
 * longer fails the run (`@slave-of-ai/providers`' `USER_QUESTION_TOOLS`); this is where the worker
 * learns what to do instead -- the `<slave-ask>` protocol, offered in the `ask_protocol` section
 * whenever there is somebody to address.
 *
 * Must never contain the fake CLI's routing literals (`"verdict"`, `"task graph"`,
 * `"candidateIndex"`, `"sources"`): every implementation prompt carries it, and a fixture that
 * keyed on one would route a work run to the wrong arm.
 */
export const IMPLEMENTATION_WORK_RULES = [
  'How to work: do the task itself, directly, in this repository. Do not brainstorm, write a plan,',
  'or hand parts of it to helpers or subtasks of your own -- this team already planned the work,',
  'and a reviewer checks it after you. Commit your work before you finish.',
  'Nobody is watching this session live, so a tool that asks the user a question is refused. If you',
  'need an answer from someone, ask through the protocol above when one is offered; otherwise make',
  'the most reasonable assumption, say so in your final message, and finish the task.',
].join('\n')

/**
 * The most a rendered prompt may weigh, in UTF-8 BYTES (final review I2).
 *
 * WHY a byte budget at all: both adapters hand the prompt to the CLI as ONE argv string (`-p
 * <prompt>` for Claude, a positional for Cursor), and Linux refuses any single argument of
 * `MAX_ARG_STRLEN` -- 32 pages, 131072 bytes -- or more with `E2BIG` (verified on this host). The
 * spawn then fails outright, after the run row, the worktree and the recorded context all exist.
 * Nothing else bounds the SUM: a review run can carry a profile up to `PROFILE_MAX_CHARS` (48k),
 * skills up to `SKILL_BODIES_MAX_CHARS` (24k), a diff up to 60k, and the task and fixed text on
 * top, each within its own cap and together over the kernel's.
 *
 * Bytes, not characters, because the kernel counts bytes and a prompt in any non-Latin script is
 * two or three bytes a character. 110k, not 131072 less one, so the margin absorbs the NUL
 * terminator and whatever an adapter may one day add around the prompt without a second change
 * here. `buildRunContext` (`apps/orchestrator/src/runContext.ts`) enforces it: it drops inlined
 * skill bodies first ({@link dropLastSkillBody}), and refuses the dispatch (`prompt_too_long`)
 * only when the prompt is still over with none left.
 */
export const RUN_PROMPT_MAX_BYTES = 110_000

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
 * `replan` section) after their sections, the verification kind appends
 * {@link VERIFICATION_INSTRUCTIONS}, and the implementation kind appends
 * {@link IMPLEMENTATION_WORK_RULES}; that text is not itself a section and carries no manifest
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
        : kind === 'verification'
          ? VERIFICATION_INSTRUCTIONS
          : IMPLEMENTATION_WORK_RULES

  const parts = present.map((section) => section.text)
  const prompt = [...parts, trailer].join('\n\n')

  const manifest: Manifest = {
    kind,
    sections: present.map((section) => section.source),
  }

  return { prompt, manifest }
}
