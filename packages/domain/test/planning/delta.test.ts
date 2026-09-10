import { describe, expect, it } from 'vitest'
import { REPLAN_INSTRUCTIONS, applyCancelPolicy, parsePlanDelta, type BoardTask, type PlanDelta } from '../../src/planning/delta.js'
import type { TaskStatus } from '../../src/task/state.js'

const EXISTING = ['task-1', 'task-2', 'task-3'] as const

function addTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { key: 'docs', title: 'Document the endpoint', description: 'Write the API doc.', role: 'backend', dependsOn: [], ...overrides }
}

function json(delta: Record<string, unknown>): string {
  return JSON.stringify(delta)
}

function board(overrides: Partial<BoardTask> = {}): BoardTask {
  return { id: 'task-1', title: 'Add the thing', status: 'backlog', goalVersion: 1, ...overrides }
}

function delta(overrides: Partial<PlanDelta> = {}): PlanDelta {
  return { add: [], cancel: [], keep: [], ...overrides }
}

describe('parsePlanDelta', () => {
  it('accepts a delta with additions, cancellations and keeps', () => {
    const result = parsePlanDelta(json({ add: [addTask()], cancel: ['task-1'], keep: ['task-2'] }), EXISTING)
    expect(result).toEqual({
      ok: true,
      value: {
        // `capabilities: []` is M47 R3's default: a delta written before this milestone parses
        // unchanged and reads back as "this task asked for no capabilities".
        add: [{ key: 'docs', title: 'Document the endpoint', description: 'Write the API doc.', role: 'backend', dependsOn: [], capabilities: [] }],
        cancel: ['task-1'],
        keep: ['task-2'],
      },
    })
  })

  it('accepts a delta whose three arrays are all empty -- "the goal changed and the board still stands"', () => {
    const result = parsePlanDelta(json({ add: [], cancel: [], keep: [] }), EXISTING)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ add: [], cancel: [], keep: [] })
  })

  it('takes the LAST parseable object, ignoring an earlier draft and surrounding prose', () => {
    const text = [
      'First I thought: {"add":[],"cancel":["task-1"],"keep":[]}',
      'but on reflection:',
      '```json',
      json({ add: [], cancel: [], keep: ['task-1'] }),
      '```',
    ].join('\n')
    const result = parsePlanDelta(text, EXISTING)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ add: [], cancel: [], keep: ['task-1'] })
  })

  it('accepts a new task whose dependsOn names an EXISTING task id', () => {
    const result = parsePlanDelta(json({ add: [addTask({ dependsOn: ['task-2'] })], cancel: [], keep: [] }), EXISTING)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.add[0]?.dependsOn).toEqual(['task-2'])
  })

  it('accepts a new task whose dependsOn names another new key', () => {
    const text = json({ add: [addTask(), addTask({ key: 'ship', dependsOn: ['docs'] })], cancel: [], keep: [] })
    expect(parsePlanDelta(text, EXISTING).ok).toBe(true)
  })

  it('accepts a chain of new tasks that each depend on an existing id -- an existing id is never a cycle', () => {
    const text = json({
      add: [addTask({ key: 'a', dependsOn: ['task-1'] }), addTask({ key: 'b', dependsOn: ['a', 'task-2'] })],
      cancel: [],
      keep: [],
    })
    expect(parsePlanDelta(text, EXISTING).ok).toBe(true)
  })

  it('rejects text with no delta object at all', () => {
    const result = parsePlanDelta('I could not decide.', EXISTING)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('no JSON object') })
  })

  it('rejects a plan graph object -- a re-plan is not a rebuild', () => {
    const result = parsePlanDelta(json({ tasks: [addTask()] }), EXISTING)
    expect(result.ok).toBe(false)
  })

  it('rejects an object missing one of the three arrays', () => {
    expect(parsePlanDelta(json({ add: [], cancel: [] }), EXISTING).ok).toBe(false)
  })

  it('rejects more than 20 additions', () => {
    const add = Array.from({ length: 21 }, (_v, i) => addTask({ key: `k${String(i)}` }))
    expect(parsePlanDelta(json({ add, cancel: [], keep: [] }), EXISTING).ok).toBe(false)
  })

  it('rejects a duplicate key among the additions', () => {
    const result = parsePlanDelta(json({ add: [addTask(), addTask()], cancel: [], keep: [] }), EXISTING)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('duplicate task key: "docs"') })
  })

  it('rejects a key that collides with an existing task id', () => {
    const result = parsePlanDelta(json({ add: [addTask({ key: 'task-2' })], cancel: [], keep: [] }), EXISTING)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('task-2') })
    if (!result.ok) expect(result.error).toContain('already a task')
  })

  it('rejects a dependsOn that names neither a new key nor an existing task id', () => {
    const result = parsePlanDelta(json({ add: [addTask({ dependsOn: ['ghost'] })], cancel: [], keep: [] }), EXISTING)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('unknown key "ghost"') })
  })

  it('rejects a new task that depends on itself', () => {
    const result = parsePlanDelta(json({ add: [addTask({ dependsOn: ['docs'] })], cancel: [], keep: [] }), EXISTING)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('cannot depend on itself') })
  })

  it('rejects a dependency cycle among the additions', () => {
    const text = json({
      add: [addTask({ key: 'a', dependsOn: ['b'] }), addTask({ key: 'b', dependsOn: ['a'] })],
      cancel: [],
      keep: [],
    })
    const result = parsePlanDelta(text, EXISTING)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('dependency cycle') })
    if (!result.ok) expect(result.error).toContain('a, b')
  })

  it('rejects a cancellation of an id that is not on the board', () => {
    const result = parsePlanDelta(json({ add: [], cancel: ['task-9'], keep: [] }), EXISTING)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('cancel names a task that is not on the board: "task-9"') })
  })

  it('rejects a keep of an id that is not on the board', () => {
    const result = parsePlanDelta(json({ add: [], cancel: [], keep: ['task-9'] }), EXISTING)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('keep names a task that is not on the board: "task-9"') })
  })

  it('rejects a task named in both cancel and keep', () => {
    const result = parsePlanDelta(json({ add: [], cancel: ['task-1'], keep: ['task-1'] }), EXISTING)
    expect(result).toEqual({ ok: false, error: expect.stringContaining('both cancelled and kept') })
  })

  it('rejects a structurally bad delta outright rather than falling back to an earlier candidate', () => {
    const text = [json({ add: [], cancel: [], keep: [] }), json({ add: [], cancel: ['task-9'], keep: [] })].join('\n')
    expect(parsePlanDelta(text, EXISTING).ok).toBe(false)
  })

  it('accepts every cancellation when the board is empty only if nothing is cancelled', () => {
    expect(parsePlanDelta(json({ add: [addTask()], cancel: [], keep: [] }), []).ok).toBe(true)
    expect(parsePlanDelta(json({ add: [], cancel: ['task-1'], keep: [] }), []).ok).toBe(false)
  })
})

describe('REPLAN_INSTRUCTIONS', () => {
  it('contains the literal "replan" the fake CLI selects its arm on', () => {
    expect(REPLAN_INSTRUCTIONS).toContain('"replan"')
  })

  it('never contains the literals that would misroute it to another fake arm', () => {
    // `"task graph"` picks the first-plan arm and `"verdict"` the review arm (M8a/M8b) -- a
    // re-plan prompt carrying either would be answered with the wrong fixture.
    expect(REPLAN_INSTRUCTIONS).not.toContain('"task graph"')
    expect(REPLAN_INSTRUCTIONS).not.toContain('task graph')
    expect(REPLAN_INSTRUCTIONS).not.toContain('verdict')
    // M38's decision prompt keys on these two; a planning prompt is not a decision prompt.
    expect(REPLAN_INSTRUCTIONS).not.toContain('candidateIndex')
    expect(REPLAN_INSTRUCTIONS).not.toContain('sources')
  })

  it('asks for exactly one JSON object with the three arrays', () => {
    expect(REPLAN_INSTRUCTIONS).toContain('exactly one JSON object')
    expect(REPLAN_INSTRUCTIONS).toContain('"add"')
    expect(REPLAN_INSTRUCTIONS).toContain('"cancel"')
    expect(REPLAN_INSTRUCTIONS).toContain('"keep"')
  })

  it('separates its two halves with ONE blank line', () => {
    // Final review, Minor 7: two consecutive empty strings joined with '\n' render as a triple
    // newline, a gap nothing in the prompt means -- every other section boundary this codebase
    // writes is one blank line.
    expect(REPLAN_INSTRUCTIONS).not.toContain('\n\n\n')
  })

  it('tells the model never to cancel work that is running or done', () => {
    expect(REPLAN_INSTRUCTIONS).toContain('never cancel work that is running or done')
  })

  it('is a shape parsePlanDelta itself accepts -- the example it prints really parses', () => {
    const example = REPLAN_INSTRUCTIONS.split('\n').find((line) => line.startsWith('{"add"'))
    expect(example).toBeDefined()
    // The example's own placeholders stand in for a board. They are DELIBERATELY three distinct
    // strings: an example that cancelled and kept the same placeholder id would be a delta this
    // very parser refuses, printed as the shape to imitate. This assertion is what caught that.
    const placeholders = ['<task id to cancel>', '<task id to keep>', 'other-key-or-existing-task-id']
    expect(parsePlanDelta(example as string, placeholders).ok).toBe(true)
  })
})

describe('applyCancelPolicy', () => {
  const CANCELLABLE: readonly TaskStatus[] = ['backlog', 'ready', 'blocked']
  const NOT_CANCELLABLE: readonly TaskStatus[] = [
    'assigned',
    'running',
    'verifying',
    'reviewing',
    'merging',
    'rework',
    'waiting',
    'done',
    'failed',
    'cancelled',
  ]

  it.each(CANCELLABLE)('cancels a %s task', (status) => {
    const result = applyCancelPolicy(delta({ cancel: ['task-1'] }), [board({ status })])
    expect(result).toEqual({ cancellable: ['task-1'], dropped: [] })
  })

  it.each(NOT_CANCELLABLE)('drops a cancellation of a %s task, recording its status', (status) => {
    const result = applyCancelPolicy(delta({ cancel: ['task-1'] }), [board({ status })])
    expect(result).toEqual({ cancellable: [], dropped: [{ taskId: 'task-1', status }] })
  })

  it('splits a mixed request and keeps the order the model asked in', () => {
    const result = applyCancelPolicy(delta({ cancel: ['task-3', 'task-2', 'task-1'] }), [
      board({ id: 'task-1', status: 'backlog' }),
      board({ id: 'task-2', status: 'running' }),
      board({ id: 'task-3', status: 'ready' }),
    ])
    expect(result).toEqual({ cancellable: ['task-3', 'task-1'], dropped: [{ taskId: 'task-2', status: 'running' }] })
  })

  it('returns nothing at all for a delta that cancels nothing', () => {
    expect(applyCancelPolicy(delta({ keep: ['task-1'] }), [board()])).toEqual({ cancellable: [], dropped: [] })
  })

  it('ignores an id that is not on the board -- parsePlanDelta already refuses one', () => {
    expect(applyCancelPolicy(delta({ cancel: ['ghost'] }), [board()])).toEqual({ cancellable: [], dropped: [] })
  })

  it('never reads the additions or the keeps', () => {
    const result = applyCancelPolicy(
      { add: [{ key: 'docs', title: 't', description: 'd', role: 'backend', dependsOn: [], capabilities: [] }], cancel: [], keep: ['task-1'] },
      [board()],
    )
    expect(result).toEqual({ cancellable: [], dropped: [] })
  })
})

describe('parsePlanDelta -- capabilities (M47 R3, E2)', () => {
  it('rejects an added task that names neither a role nor a capability', () => {
    const out = parsePlanDelta('{"add":[{"key":"a","title":"t","description":"d"}],"cancel":[],"keep":[]}', [])
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toBe('added task "a" names neither a role nor a capability')
  })

  it('accepts an added task that names a capability instead of a role', () => {
    const out = parsePlanDelta(
      '{"add":[{"key":"a","title":"t","description":"d","capabilities":["security.application"]}],"cancel":[],"keep":[]}',
      [],
    )
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.add[0]?.role).toBeUndefined()
    expect(out.value.add[0]?.capabilities).toEqual(['security.application'])
  })
})

describe('parsePlanDelta -- the capability cap is STRUCTURAL (fix round 1)', () => {
  it('rejects eleven capabilities on an added task by name', () => {
    const keys = Array.from({ length: 11 }, (_v, i) => `qa.k${String(i)}`)
    const out = parsePlanDelta(json({ add: [addTask({ capabilities: keys })], cancel: [], keep: [] }), EXISTING)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('more than 10 capabilities')
  })
})
