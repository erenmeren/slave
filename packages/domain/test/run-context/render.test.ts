import { describe, expect, it } from 'vitest'
import { parseSlaveAnswers } from '../../src/messaging/answer.js'
import { parseSlaveAsk } from '../../src/messaging/ask.js'
import type { Section } from '../../src/run-context/sections.js'
import { REPLAN_INSTRUCTIONS } from '../../src/planning/delta.js'
import {
  MARKERS,
  PLANNING_GRAPH_INSTRUCTIONS,
  REVIEW_VERDICT_INSTRUCTIONS,
  SECTION_ORDER,
  neutraliseMarkers,
  renderRunContext,
} from '../../src/run-context/render.js'
// M37 Task 2: this file used to cross-check the two constants against LIVE calls to
// `buildReviewPrompt`/`buildPlanningPrompt` in apps/orchestrator, which is why it reached across
// the package boundary. Those two functions are gone -- `buildRunContext` is the only builder now
// and these constants are the source of truth for their text -- so the cross-check and its import
// went with them. What replaced it is `apps/orchestrator/test/integration/runContext.test.ts`,
// which asserts a REAL review/planning prompt still ends with each constant.

const TASK_SHA = 'd'.repeat(64)
const GOAL_SHA = 'c'.repeat(64)
const PREVIOUS_GOAL_SHA = 'a'.repeat(64)

function section(kind: Section['kind'], text: string, source: Section['source']): Section {
  return { kind, text, source }
}

describe('SECTION_ORDER', () => {
  it('lists the fixed order for each run kind', () => {
    expect(SECTION_ORDER).toEqual({
      implementation: ['profile', 'roster', 'skills', 'inbox', 'ask_protocol', 'task', 'rejection'],
      review: ['profile', 'skills', 'task', 'review_diff'],
      planning: ['profile', 'planning_goal', 'replan'],
    })
  })
})

describe('renderRunContext', () => {
  it('orders implementation sections per SECTION_ORDER regardless of input order', () => {
    const sections: Section[] = [
      section('rejection', 'rejected: missing tests', { kind: 'rejection', taskId: 't1' }),
      section('task', 'Task: do the thing', { kind: 'task', taskId: 't1', sha256: TASK_SHA }),
      section('profile', 'You are Maya.', { kind: 'profile', origin: 'slave', sha256: 'a'.repeat(64) }),
      section('inbox', 'pending question from Riley', { kind: 'inbox', messageIds: ['m1'] }),
    ]
    const { prompt, manifest } = renderRunContext('implementation', sections)
    expect(prompt).toBe('You are Maya.\n\npending question from Riley\n\nTask: do the thing\n\nrejected: missing tests')
    expect(manifest).toEqual({
      kind: 'implementation',
      sections: [
        { kind: 'profile', origin: 'slave', sha256: 'a'.repeat(64) },
        { kind: 'inbox', messageIds: ['m1'] },
        { kind: 'task', taskId: 't1', sha256: TASK_SHA },
        { kind: 'rejection', taskId: 't1' },
      ],
    })
  })

  it('drops sections whose text is empty from both the prompt and the manifest', () => {
    const sections: Section[] = [
      section('profile', '', { kind: 'profile', origin: 'slave', sha256: 'a'.repeat(64) }),
      section('task', 'Task: do the thing', { kind: 'task', taskId: 't1', sha256: TASK_SHA }),
    ]
    const { prompt, manifest } = renderRunContext('implementation', sections)
    expect(prompt).toBe('Task: do the thing')
    expect(manifest.sections).toEqual([{ kind: 'task', taskId: 't1', sha256: TASK_SHA }])
  })

  it('throws for a section kind not in the given run kind\'s order', () => {
    const sections: Section[] = [section('review_diff', 'diff', { kind: 'review_diff', base: 'main', head: 'x', capped: false })]
    expect(() => renderRunContext('implementation', sections)).toThrow(
      'unknown section review_diff for run kind implementation',
    )
  })

  it('appends the verdict instructions, verbatim from review.ts, after a review run\'s sections', () => {
    const sections: Section[] = [
      section('profile', 'You are Riley.', { kind: 'profile', origin: 'slave', sha256: 'a'.repeat(64) }),
      section('task', 'Task: do the thing', { kind: 'task', taskId: 't1', sha256: TASK_SHA }),
      section('review_diff', 'DIFF (base...branch):\n```diff\n+x\n```', { kind: 'review_diff', base: 'main', head: 'x', capped: false }),
    ]
    const { prompt } = renderRunContext('review', sections)
    expect(prompt.endsWith(REVIEW_VERDICT_INSTRUCTIONS)).toBe(true)
    // Fix round 1: both blank-string separators from `buildReviewPrompt`'s own array (the one
    // after the intro sentence, the one before "Your final message...") are present -- dropping
    // either one silently removed a blank line relative to the text this replaces.
    expect(REVIEW_VERDICT_INSTRUCTIONS).toBe(
      [
        'You are the QA reviewer for this task. Judge the DIFF against the task — do not rebuild or re-run it.',
        '',
        '',
        'Your final message must contain exactly one JSON object and nothing else on its line:',
        '{"verdict":"approve","reason":"one paragraph"} or {"verdict":"reject","reason":"one paragraph"}',
      ].join('\n'),
    )
  })

  it('appends the graph instructions, verbatim from planning.ts, after a planning run\'s sections', () => {
    const sections: Section[] = [section('planning_goal', 'GOAL: ship it', { kind: 'planning_goal', sha256: GOAL_SHA, version: 1 })]
    const { prompt } = renderRunContext('planning', sections)
    expect(prompt.endsWith(PLANNING_GRAPH_INSTRUCTIONS)).toBe(true)
    // Fix round 1: both blank-string separators from `buildPlanningPrompt`'s own array (the one
    // before `GOAL: ...`, the one after it) are present.
    //
    // Final review (spec erratum E6): ONE word deviates from `buildPlanningPrompt`'s text. That
    // function put the goal after this trailer; `SECTION_ORDER.planning` puts it before, so the
    // constant says "the GOAL above". Asserted as a deviation rather than quietly folded into the
    // expectation, so the next reader knows the reassembly is one word off the pre-M37 source and
    // exactly which word.
    expect(PLANNING_GRAPH_INSTRUCTIONS).toBe(
      [
        'You are the engineering manager. Decompose the GOAL above into a "task graph" for your team.',
        'Read the repository for context, but do NOT modify, create, or commit any file.',
        '',
        '',
        'Your final message must contain exactly one JSON object and nothing else on its line:',
        '{"tasks":[{"key":"short-unique-key","title":"...","description":"...","role":"backend","dependsOn":["other-key"]}]}',
        'Between 1 and 20 tasks. Keys are plan-local. dependsOn lists keys, no cycles.',
      ].join('\n'),
    )
    // The deviation, spelled out: the pre-M37 source is this text with `above` replaced by `below`,
    // and nothing else differs.
    const preM37 = PLANNING_GRAPH_INSTRUCTIONS.replace('the GOAL above', 'the GOAL below')
    expect(preM37.split('\n')[0]).toBe(
      'You are the engineering manager. Decompose the GOAL below into a "task graph" for your team.',
    )
    expect(preM37.split('\n').slice(1)).toEqual(PLANNING_GRAPH_INSTRUCTIONS.split('\n').slice(1))
    // Both literals the fake CLI's `m8-flow` mode selects on: `"task graph"` picks the planning
    // arm, and `"verdict"` -- which this text must never contain -- would misroute it to review.
    expect(PLANNING_GRAPH_INSTRUCTIONS).toContain('"task graph"')
    expect(PLANNING_GRAPH_INSTRUCTIONS).not.toContain('"verdict"')
    // Fix round 1, Minor 2: the guard cuts BOTH ways. `delta.test.ts` proves the re-plan trailer
    // carries no `"task graph"`; this proves the first-plan trailer carries no `replan`. The fake
    // CLI checks `"replan"` FIRST, so a first-plan prompt that merely mentioned the word would be
    // answered with a delta fixture -- and the one-sided assertion would not have noticed.
    expect(PLANNING_GRAPH_INSTRUCTIONS).not.toContain('replan')
  })

  // M40 t1 (spec erratum E2): the trailer, not the run kind, is what makes a re-plan a re-plan.
  it('appends the re-plan instructions instead of the graph instructions when a replan section is present', () => {
    const sections: Section[] = [
      section('planning_goal', 'GOAL: ship it, and now also document it', { kind: 'planning_goal', sha256: GOAL_SHA, version: 2 }),
      section('replan', 'The GOAL changed. Previous goal (v1): ship it', {
        kind: 'replan',
        previousVersion: 1,
        version: 2,
        previousSha256: PREVIOUS_GOAL_SHA,
        sha256: GOAL_SHA,
        boardTaskIds: ['t1'],
      }),
    ]
    const { prompt, manifest } = renderRunContext('planning', sections)
    expect(prompt.endsWith(REPLAN_INSTRUCTIONS)).toBe(true)
    expect(prompt).not.toContain(PLANNING_GRAPH_INSTRUCTIONS)
    // The run kind is unchanged -- only the manifest and the trailer say this was a re-plan.
    expect(manifest.kind).toBe('planning')
    expect(manifest.sections).toEqual([
      { kind: 'planning_goal', sha256: GOAL_SHA, version: 2 },
      {
        kind: 'replan',
        previousVersion: 1,
        version: 2,
        previousSha256: PREVIOUS_GOAL_SHA,
        sha256: GOAL_SHA,
        boardTaskIds: ['t1'],
      },
    ])
  })

  it('puts the replan section AFTER the goal it is about, whatever order the caller passed', () => {
    const sections: Section[] = [
      section('replan', 'The GOAL changed.', {
        kind: 'replan',
        previousVersion: 1,
        version: 2,
        previousSha256: PREVIOUS_GOAL_SHA,
        sha256: GOAL_SHA,
        boardTaskIds: [],
      }),
      section('planning_goal', 'GOAL: ship it', { kind: 'planning_goal', sha256: GOAL_SHA, version: 2 }),
    ]
    const { prompt } = renderRunContext('planning', sections)
    expect(prompt.indexOf('GOAL: ship it')).toBeLessThan(prompt.indexOf('The GOAL changed.'))
  })

  it('falls back to the graph instructions when the replan section rendered no text', () => {
    // The trailer is read off the PRESENT sections, so an empty `replan` section is in neither the
    // manifest nor the trailer choice -- the two can never disagree about what this run was.
    const sections: Section[] = [
      section('planning_goal', 'GOAL: ship it', { kind: 'planning_goal', sha256: GOAL_SHA, version: 2 }),
      section('replan', '', {
        kind: 'replan',
        previousVersion: 1,
        version: 2,
        previousSha256: PREVIOUS_GOAL_SHA,
        sha256: GOAL_SHA,
        boardTaskIds: [],
      }),
    ]
    const { prompt, manifest } = renderRunContext('planning', sections)
    expect(prompt.endsWith(PLANNING_GRAPH_INSTRUCTIONS)).toBe(true)
    expect(manifest.sections).toEqual([{ kind: 'planning_goal', sha256: GOAL_SHA, version: 2 }])
  })

  it('throws for a replan section on an implementation run', () => {
    const sections: Section[] = [
      section('replan', 'The GOAL changed.', {
        kind: 'replan',
        previousVersion: 1,
        version: 2,
        previousSha256: PREVIOUS_GOAL_SHA,
        sha256: GOAL_SHA,
        boardTaskIds: [],
      }),
    ]
    expect(() => renderRunContext('implementation', sections)).toThrow(
      'unknown section replan for run kind implementation',
    )
  })

  it('does not append instructions for an implementation run', () => {
    const sections: Section[] = [section('task', 'Task: do the thing', { kind: 'task', taskId: 't1', sha256: TASK_SHA })]
    const { prompt } = renderRunContext('implementation', sections)
    expect(prompt).toBe('Task: do the thing')
  })

  it('leaves raw <slave-ask>/<slave-answer> markers untouched inside a section\'s own text', () => {
    const sections: Section[] = [section('ask_protocol', 'Wrap your ask in <slave-ask>{...}</slave-ask>.', { kind: 'ask_protocol' })]
    const { prompt } = renderRunContext('implementation', sections)
    expect(prompt).toBe('Wrap your ask in <slave-ask>{...}</slave-ask>.')
  })
})

describe('MARKERS', () => {
  it('lists the four M36 markers', () => {
    expect(MARKERS).toEqual(['<slave-ask>', '</slave-ask>', '<slave-answer>', '</slave-answer>'])
  })
})

describe('neutraliseMarkers', () => {
  it('replaces the leading < of each marker with U+2039', () => {
    const text = neutraliseMarkers('quoting <slave-ask>{"role":"backend","question":"x"}</slave-ask> from earlier')
    expect(text).toBe('quoting ‹slave-ask>{"role":"backend","question":"x"}‹/slave-ask> from earlier')
  })

  it('neutralises an answer block the same way', () => {
    const text = neutraliseMarkers('<slave-answer>{"messageId":"m1","answer":"done"}</slave-answer>')
    expect(text).toBe('‹slave-answer>{"messageId":"m1","answer":"done"}‹/slave-answer>')
  })

  it('makes a quoted ask block invisible to parseSlaveAsk', () => {
    const quoted = 'the last slave wrote: <slave-ask>{"role":"backend","question":"Which queue?"}</slave-ask>'
    expect(parseSlaveAsk(quoted)).toEqual({ kind: 'ask', ask: expect.anything() })
    const neutralised = neutraliseMarkers(quoted)
    expect(parseSlaveAsk(neutralised)).toEqual({ kind: 'absent' })
  })

  it('makes a quoted answer block invisible to parseSlaveAnswers', () => {
    const quoted = 'the last slave wrote: <slave-answer>{"messageId":"m1","answer":"done"}</slave-answer>'
    expect(parseSlaveAnswers(quoted).answers).toHaveLength(1)
    const neutralised = neutraliseMarkers(quoted)
    expect(parseSlaveAnswers(neutralised)).toEqual({ answers: [], malformed: [] })
  })

  it('leaves text with no markers unchanged', () => {
    expect(neutraliseMarkers('nothing to see here')).toBe('nothing to see here')
  })
})
