import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ActionEnvelope } from '../../src/core/action.js'
import { initialEngineState, replay, runUntil, step, type EngineDefinition } from '../../src/core/engine.js'
import type { RoleDefinition, SectorModel } from '../../src/core/sector.js'
import type { DecisionProvider } from '../../src/decide/provider.js'
import { RecordedDecisionProvider } from '../../src/decide/recorded.js'

interface CounterState { readonly count: number; readonly deliveries: number }
type CounterEvent = { readonly type: 'deliver'; readonly qty: number }
type CounterRejection = { readonly kind: 'too_big'; readonly max: number }

const eventSchema = z.object({ type: z.literal('deliver'), qty: z.number().int() })

const counter: SectorModel<CounterState, CounterEvent, CounterRejection> = {
  name: 'counter',
  eventSchema,
  externalEventSchema: eventSchema,
  observe: (state, role) => (role.observes.includes('count') ? { count: state.count } : {}),
  validate: (_state, _role, action) => (action.type === 'add' && Number(action.params['qty']) > 10 ? { ok: false, reason: { kind: 'too_big', max: 10 } } : { ok: true }),
  apply: (state, _role, action, day) => {
    const qty = Number(action.params['qty'])
    if (action.type === 'order') return { state, schedule: [{ time: day + 2, priority: 'scheduled', event: { type: 'deliver', qty } }] }
    return { state: { ...state, count: state.count + qty }, schedule: [], record: { added: qty } }
  },
  applyEvent: (state, event) => ({ state: { ...state, count: state.count + event.qty, deliveries: state.deliveries + 1 }, schedule: [], record: { qty: event.qty } }),
  closeDay: (state) => ({ state, schedule: [], record: { count: state.count } }),
}

const clerk: RoleDefinition = { name: 'clerk', purpose: 'counts', observes: ['count'], allowedActions: ['add', 'order'], constraints: {}, slaveName: 'Sam' }
const guest: RoleDefinition = { name: 'guest', purpose: 'watches', observes: [], allowedActions: [], constraints: {}, slaveName: 'Guest' }

const definition: EngineDefinition = { roles: [clerk, guest], roleOrder: ['clerk', 'guest'], horizonDays: 10, seed: 1, limits: { maxSteps: 100, maxDecisionsPerStep: 4, maxJournalEntries: 1000 } }

function provider(script: (day: number, role: string) => ActionEnvelope[]): DecisionProvider {
  return { kind: 'rules', decide: (request) => script(request.day, request.role.name) }
}
const add = (qty: number): ActionEnvelope => ({ type: 'add', params: { qty }, rationale: 'test', refs: [] })

describe('engine.step', () => {
  it('applies a valid action through the sector, rejects an unauthorized one and a rule-breaking one, journaling each', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 1)
    const p = provider((_day, role) => (role === 'clerk' ? [add(3), add(50)] : [add(1)]))
    const { state, entries } = step(counter, definition, initial, p)
    expect(state.sector.count).toBe(3)
    expect(state.day).toBe(1)
    expect(entries.map((e) => e.kind)).toEqual(['decision', 'action_applied', 'action_rejected', 'decision', 'action_rejected', 'event'])
    expect(entries[2]?.payload['reason']).toEqual({ kind: 'too_big', max: 10 })
    expect(entries[4]?.payload['reason']).toEqual({ kind: 'role_not_allowed', role: 'guest', type: 'add' })
    expect(entries.at(-1)?.payload).toEqual({ kind: 'close', count: 3 })
    expect(entries[1]?.payload).toEqual(expect.objectContaining({ index: 0, actionIndex: 0, added: 3 }))
  })
  it('an ordered delivery lands only when its scheduled day comes', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 1)
    const p = provider((day, role) => (day === 0 && role === 'clerk' ? [{ type: 'order', params: { qty: 5 }, rationale: 'x', refs: [] }] : []))
    const s1 = step(counter, definition, initial, p).state
    expect(s1.sector.count).toBe(0)
    const s2 = step(counter, definition, s1, p).state
    expect(s2.sector.count).toBe(0)
    const s3 = step(counter, definition, s2, p).state
    expect(s3.sector.count).toBe(5)
    expect(s3.sector.deliveries).toBe(1)
  })
  it('a malformed envelope is schema_invalid and changes nothing', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 1)
    const p: DecisionProvider = { kind: 'rules', decide: () => [{ type: 'add', params: 'not an object', rationale: '', refs: [] } as unknown as ActionEnvelope] }
    const { state, entries } = step(counter, definition, initial, p)
    expect(state.sector.count).toBe(0)
    expect(entries.filter((e) => e.kind === 'action_rejected')[0]?.payload['reason']).toMatchObject({ kind: 'schema_invalid' })
  })
  it('caps decisions per step with limit_exceeded and halts on maxJournalEntries', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 1)
    const p = provider((_day, role) => (role === 'clerk' ? [add(1), add(1), add(1), add(1), add(1), add(1)] : []))
    const { state, entries } = step(counter, definition, initial, p)
    expect(state.sector.count).toBe(4)
    expect(entries.filter((e) => e.kind === 'action_rejected').map((e) => e.payload['reason'])).toEqual([{ kind: 'limit_exceeded', limit: 'maxDecisionsPerStep' }])
    const tiny = { ...definition, limits: { ...definition.limits, maxJournalEntries: 3 } }
    const halted = step(counter, tiny, initial, p).state
    expect(halted.status).toBe('halted')
    expect(halted.haltedReason).toBe('maxJournalEntries')
  })
})

describe('runUntil and replay', () => {
  it('runs to the horizon and finishes; stops early at the per-call cap', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [{ time: 4, priority: 'external', event: { type: 'deliver', qty: 7 } }], 1)
    const p = provider(() => [])
    const partial = runUntil(counter, definition, initial, p, 10, 3)
    expect(partial.state.day).toBe(3)
    expect(partial.state.status).toBe('running')
    const done = runUntil(counter, definition, partial.state, p, 10, 100)
    expect(done.state.day).toBe(10)
    expect(done.state.status).toBe('finished')
    expect(done.state.sector.count).toBe(7)
    expect(done.entries.some((e) => e.kind === 'external_event')).toBe(true)
  })
  it('replaying the journal with the recorded provider reproduces the state exactly, and diverging journals throw', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 1)
    const p = provider((day, role) => (role === 'clerk' ? [add(day), add(50)] : []))
    const live = runUntil(counter, definition, initial, p, 5, 100)
    const replayed = replay(counter, definition, initial, live.entries)
    expect(replayed).toEqual(live.state)
    expect(() => replay(counter, definition, initial, live.entries.slice(0, 2))).toThrow(/replay_divergence/)
  })
  it('the same seed, inputs and decisions produce identical journals', () => {
    const p = provider((day) => [add(day % 3)])
    const a = runUntil(counter, definition, initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 9), p, 6, 100)
    const b = runUntil(counter, definition, initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 9), p, 6, 100)
    expect(a.entries).toEqual(b.entries)
    expect(a.state).toEqual(b.state)
  })
  it('the recorded provider refuses to answer a decision point it has no record for', () => {
    const recorded = new RecordedDecisionProvider([])
    expect(() => recorded.decide({ day: 0, role: clerk, observation: {}, index: 0 })).toThrow(/replay_divergence/)
  })
})

describe('decisionExtras (M31a Task 4)', () => {
  it('merges the named role\'s extras into that role\'s decision payload and leaves every other role\'s alone', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 1)
    const p = provider((_day, role) => (role === 'clerk' ? [add(2)] : []))
    const { entries } = step(counter, definition, initial, p, { clerk: { model: 'claude-haiku-4-5', usageSeq: 3, parseError: null } })
    const decisions = entries.filter((e) => e.kind === 'decision')
    expect(decisions[0]?.payload).toEqual(expect.objectContaining({ index: 0, provider: 'rules', model: 'claude-haiku-4-5', usageSeq: 3, parseError: null }))
    expect(decisions[0]?.payload['actions']).toEqual([add(2)])
    expect(Object.keys(decisions[1]?.payload ?? {})).toEqual(['index', 'provider', 'observation', 'actions'])
  })
  it('a step with no extras is byte-identical to one whose extras name no role in play, and runUntil threads them through every day', () => {
    const initial = initialEngineState<CounterState, CounterEvent>({ count: 0, deliveries: 0 }, [], 1)
    const p = provider(() => [])
    expect(step(counter, definition, initial, p).entries).toEqual(step(counter, definition, initial, p, { nobody: { model: 'x' } }).entries)
    const ran = runUntil(counter, definition, initial, p, 3, 100, { clerk: { usageSeq: 7 } })
    const clerkDecisions = ran.entries.filter((e) => e.kind === 'decision' && e.actorRole === 'clerk')
    expect(clerkDecisions).toHaveLength(3)
    for (const entry of clerkDecisions) expect(entry.payload['usageSeq']).toBe(7)
  })
})
