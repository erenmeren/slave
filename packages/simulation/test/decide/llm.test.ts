import { describe, expect, it } from 'vitest'
import type { ActionEnvelope } from '../../src/core/action.js'
import { step } from '../../src/core/engine.js'
import type { RoleDefinition } from '../../src/core/sector.js'
import type { DecisionProvider } from '../../src/decide/provider.js'
import { CompositeDecisionProvider, LlmDecisionProvider, parseEnvelopes } from '../../src/decide/llm.js'
import { buildDecisionPrompt } from '../../src/decide/llm-prompt.js'
import { TRADE_ACTION_DOCS } from '../../src/trade/action-docs.js'
import { demoDefinition, tradeInitialEngineState } from '../../src/trade/definition.js'
import { tradeModel } from '../../src/trade/model.js'
import { RulesDecisionProvider } from '../../src/trade/rules.js'

const purchasingRole: RoleDefinition = {
  name: 'purchasing',
  purpose: 'keeps stock able to cover open orders within cash',
  observes: ['inventory', 'cashMinor'],
  allowedActions: ['place_purchase', 'note'],
  constraints: {},
  slaveName: 'Pete',
}
const salesRole: RoleDefinition = { name: 'sales', purpose: 'accepts customer demand into orders', observes: [], allowedActions: ['accept_order', 'note'], constraints: {}, slaveName: 'Sonia' }

const noteEnvelope = (text: string): ActionEnvelope => ({ type: 'note', params: { text }, rationale: 'r', refs: [] })

describe('buildDecisionPrompt', () => {
  it('contains the purpose, each action doc line, the observation JSON, the JSON-only contract, the max count and the synthetic notice', () => {
    const observation = { inventory: 42, cashMinor: 1_000 }
    const prompt = buildDecisionPrompt({ role: purchasingRole, observation, actionDocs: TRADE_ACTION_DOCS, day: 3, currency: 'USD', maxActions: 8 })
    expect(prompt).toContain(purchasingRole.purpose)
    for (const doc of TRADE_ACTION_DOCS) expect(prompt).toContain(`${doc.type} ${doc.params} — ${doc.when}`)
    expect(prompt).toContain(JSON.stringify(observation))
    expect(prompt).toContain('ONLY a JSON array')
    expect(prompt).toContain('8')
    expect(prompt).toContain('synthetic')
  })
})

describe('parseEnvelopes', () => {
  it('parses a bare JSON array', () => {
    const result = parseEnvelopes('[{"type":"note","params":{"text":"hi"},"rationale":"r","refs":[]}]', 8)
    if (!('envelopes' in result)) throw new Error('expected envelopes')
    expect(result.envelopes).toEqual([noteEnvelope('hi')])
  })

  it('parses a ```json fenced array', () => {
    const text = '```json\n[{"type":"note","params":{"text":"hi"},"rationale":"r","refs":[]}]\n```'
    const result = parseEnvelopes(text, 8)
    if (!('envelopes' in result)) throw new Error('expected envelopes')
    expect(result.envelopes).toEqual([noteEnvelope('hi')])
  })

  it('extracts the array from the r4 real-call answer shape (prose, tool-call noise, fenced array, prose)', () => {
    const text = '<function_calls>\n<invoke name="Bash">...</invoke>\n</function_calls>\nThe directory is empty.\n\n```json\n[{"type":"note","params":{"text":"no change"},"rationale":"stable","refs":[]}]\n```\nDone.'
    const result = parseEnvelopes(text, 8)
    if (!('envelopes' in result)) throw new Error('expected envelopes')
    expect(result.envelopes).toEqual([{ type: 'note', params: { text: 'no change' }, rationale: 'stable', refs: [] }])
  })

  it('prefers the LAST fenced json block when more than one is present', () => {
    const text = '```json\n[{"type":"note","params":{"text":"first"},"rationale":"r","refs":[]}]\n```\nthen I reconsidered\n```json\n[{"type":"note","params":{"text":"second"},"rationale":"r","refs":[]}]\n```'
    const result = parseEnvelopes(text, 8)
    if (!('envelopes' in result)) throw new Error('expected envelopes')
    expect(result.envelopes).toEqual([noteEnvelope('second')])
  })

  it('accepts an empty array', () => {
    const result = parseEnvelopes('[]', 8)
    if (!('envelopes' in result)) throw new Error('expected envelopes')
    expect(result.envelopes).toEqual([])
  })

  it('a non-array value is a parseError', () => {
    const result = parseEnvelopes('{"type":"note"}', 8)
    expect('parseError' in result).toBe(true)
  })

  it('a fenced non-array value is a parseError mentioning "array"', () => {
    const result = parseEnvelopes('```json\n{"type":"note"}\n```', 8)
    if (!('parseError' in result)) throw new Error('expected parseError')
    expect(result.parseError).toContain('array')
  })

  it('an array of non-envelope elements is a parseError naming element 0', () => {
    const result = parseEnvelopes('[1,2,3]', 8)
    if (!('parseError' in result)) throw new Error('expected parseError')
    expect(result.parseError).toContain('element 0')
  })

  it('finds the unfenced array by a bracket scan, not the last "]" — a "]" inside a string value or in trailing prose does not fool it', () => {
    const text = 'Here: [{"type":"note","params":{"text":"a]b"},"rationale":"r","refs":[]}] see item [2] for details'
    const result = parseEnvelopes(text, 8)
    if (!('envelopes' in result)) throw new Error('expected envelopes')
    expect(result.envelopes).toEqual([noteEnvelope('a]b')])
  })

  it('names the index of an element that fails the envelope schema', () => {
    const text = '[{"type":"note","params":{"text":"ok"},"rationale":"r","refs":[]},{"type":"note","params":{"text":"bad"}}]'
    const result = parseEnvelopes(text, 8)
    if (!('parseError' in result)) throw new Error('expected parseError')
    expect(result.parseError).toContain('element 1')
  })

  it('truncates to maxActions', () => {
    const elements = [0, 1, 2, 3].map((i) => `{"type":"note","params":{"text":"n${i}"},"rationale":"r","refs":[]}`)
    const result = parseEnvelopes(`[${elements.join(',')}]`, 2)
    if (!('envelopes' in result)) throw new Error('expected envelopes')
    expect(result.envelopes).toHaveLength(2)
  })
})

describe('LlmDecisionProvider', () => {
  it('answers its role from the map and [] for a role without an answer', () => {
    const answer = noteEnvelope('ok')
    const provider = new LlmDecisionProvider(new Map([['purchasing', [answer]]]))
    expect(provider.decide({ day: 0, role: purchasingRole, observation: {}, index: 0 })).toEqual([answer])
    expect(provider.decide({ day: 0, role: salesRole, observation: {}, index: 0 })).toEqual([])
  })
})

describe('CompositeDecisionProvider', () => {
  it('routes purchasing to llm and sales to rules, and kindFor reports the kind of the provider that actually answered', () => {
    const llmAnswer = noteEnvelope('llm')
    const rulesAnswer = noteEnvelope('rules')
    const llm = new LlmDecisionProvider(new Map([['purchasing', [llmAnswer]]]))
    const rules: DecisionProvider = { kind: 'rules', decide: () => [rulesAnswer] }
    const composite = new CompositeDecisionProvider({ llmRoles: ['purchasing'], llm, rules })
    expect(composite.decide({ day: 0, role: purchasingRole, observation: {}, index: 0 })).toEqual([llmAnswer])
    expect(composite.decide({ day: 0, role: salesRole, observation: {}, index: 0 })).toEqual([rulesAnswer])
    expect(composite.kindFor?.(purchasingRole)).toBe('llm')
    expect(composite.kindFor?.(salesRole)).toBe('rules')
  })

  it('through engine.step with demoDefinition, journals provider "llm" for purchasing and "rules" for the other roles', () => {
    const roster = [
      { slaveName: 'Sonia', departmentName: 'Sales' },
      { slaveName: 'Pete', departmentName: 'Purchasing' },
      { slaveName: 'Olga', departmentName: 'Operations' },
      { slaveName: 'Fin', departmentName: 'Finance' },
    ]
    const definition = demoDefinition({ policy: 'A', seed: 3, roster, currency: 'USD' })
    const initial = tradeInitialEngineState(definition)
    const llm = new LlmDecisionProvider(new Map())
    const rules = new RulesDecisionProvider(definition)
    const composite = new CompositeDecisionProvider({ llmRoles: ['purchasing'], llm, rules })
    const { entries } = step(tradeModel, definition, initial, composite)
    const byRole = new Map(entries.filter((e) => e.kind === 'decision').map((e) => [e.actorRole, e.payload['provider']]))
    expect(byRole.get('purchasing')).toBe('llm')
    expect(byRole.get('sales')).toBe('rules')
    expect(byRole.get('operations')).toBe('rules')
    expect(byRole.get('finance')).toBe('rules')
  })
})
