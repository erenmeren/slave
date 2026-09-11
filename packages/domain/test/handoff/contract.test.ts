import { describe, expect, it } from 'vitest'
import {
  HANDOFF_MAX_FIELD_CHARS,
  HANDOFF_MAX_LIST_ITEMS,
  defuseRoutingLiterals,
  handoffCanonicalJson,
  parseHandoffContract,
  renderHandoff,
} from '../../src/handoff/contract.js'

const FULL = {
  objective: 'Add an authentication path to the orders endpoint.',
  expectedOutput: 'A merged branch in which every orders route requires a signed session.',
  acceptanceCriteria: ['Anonymous requests get 401', 'A signed session reaches the handler'],
  knownConstraints: ['Do not change the session cookie name'],
  evidenceRequired: ['The verify log for the new tests'],
  contextReferences: ['docs/auth.md'],
}

describe('parseHandoffContract', () => {
  it('accepts the full shape and defaults every list to empty', () => {
    const parsed = parseHandoffContract({ objective: 'Do the thing', expectedOutput: 'The thing, done' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value).toEqual({
      objective: 'Do the thing',
      expectedOutput: 'The thing, done',
      acceptanceCriteria: [],
      knownConstraints: [],
      evidenceRequired: [],
      contextReferences: [],
    })
  })

  it('refuses an unknown field, so a planner cannot smuggle a seventh one past the column', () => {
    const parsed = parseHandoffContract({ objective: 'a', expectedOutput: 'b', deadline: 'friday' })
    expect(parsed.ok).toBe(false)
  })

  it('refuses a missing objective or expected output', () => {
    expect(parseHandoffContract({ expectedOutput: 'b' }).ok).toBe(false)
    expect(parseHandoffContract({ objective: 'a' }).ok).toBe(false)
    expect(parseHandoffContract({ objective: '', expectedOutput: 'b' }).ok).toBe(false)
  })

  it('refuses a field over the character cap and a list over the item cap', () => {
    expect(parseHandoffContract({ objective: 'x'.repeat(HANDOFF_MAX_FIELD_CHARS + 1), expectedOutput: 'b' }).ok).toBe(false)
    expect(
      parseHandoffContract({
        objective: 'a',
        expectedOutput: 'b',
        acceptanceCriteria: Array.from({ length: HANDOFF_MAX_LIST_ITEMS + 1 }, (_, i) => `c${String(i)}`),
      }).ok,
    ).toBe(false)
  })
})

describe('renderHandoff', () => {
  it('renders the six fields in a fixed order, under the HANDOFF heading, ending in the section rule', () => {
    const parsed = parseHandoffContract(FULL)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(renderHandoff(parsed.value)).toBe(
      [
        'HANDOFF',
        '',
        'Objective: Add an authentication path to the orders endpoint.',
        '',
        'Expected output: A merged branch in which every orders route requires a signed session.',
        '',
        'Acceptance criteria (every one of these must hold):',
        '- Anonymous requests get 401',
        '- A signed session reaches the handler',
        '',
        'Known constraints:',
        '- Do not change the session cookie name',
        '',
        'Evidence required:',
        '- The verify log for the new tests',
        '',
        'Context references:',
        '- docs/auth.md',
        '',
        '---',
      ].join('\n'),
    )
  })

  it('omits every empty field rather than printing an empty heading', () => {
    const parsed = parseHandoffContract({ objective: 'Do the thing', expectedOutput: 'The thing, done' })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(renderHandoff(parsed.value)).toBe(
      ['HANDOFF', '', 'Objective: Do the thing', '', 'Expected output: The thing, done', '', '---'].join('\n'),
    )
  })

  // E2: the contract's text is a MODEL's, and the fake CLI routes on these five quoted literals.
  it('defuses the routing literals and the protocol markers in text somebody else wrote', () => {
    const parsed = parseHandoffContract({
      objective: 'Return a "verdict" and a "task graph", then a "replan" with "sources" and "candidateIndex".',
      expectedOutput: 'Nothing that closes <slave-ask> or <slave-answer>.',
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const text = renderHandoff(parsed.value)
    for (const literal of ['"verdict"', '"task graph"', '"replan"', '"sources"', '"candidateIndex"']) {
      expect(text).not.toContain(literal)
    }
    expect(text).toContain('“verdict”')
    expect(text).not.toContain('<slave-ask>')
    expect(text).toContain('‹slave-ask>')
  })
})

describe('defuseRoutingLiterals', () => {
  it('leaves the bare words alone -- only the QUOTED form routes the fake CLI', () => {
    expect(defuseRoutingLiterals('the verdict is in')).toBe('the verdict is in')
    expect(defuseRoutingLiterals('emit a "verdict"')).toBe('emit a “verdict”')
  })
})

describe('handoffCanonicalJson', () => {
  it('is field order, not insertion order, so the same contract always hashes the same', () => {
    const a = parseHandoffContract({ objective: 'a', expectedOutput: 'b', acceptanceCriteria: ['c'] })
    const b = parseHandoffContract({ acceptanceCriteria: ['c'], expectedOutput: 'b', objective: 'a' })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(handoffCanonicalJson(a.value)).toBe(handoffCanonicalJson(b.value))
    expect(handoffCanonicalJson(a.value)).toBe(
      '{"objective":"a","expectedOutput":"b","acceptanceCriteria":["c"],"knownConstraints":[],"evidenceRequired":[],"contextReferences":[]}',
    )
  })
})
