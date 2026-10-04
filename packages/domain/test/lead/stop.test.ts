import { describe, expect, it } from 'vitest'
import { renderLeadStop } from '../../src/lead/index.js'

const none = { failing: [], disputed: [], unverifiable: [], detail: null }

describe('renderLeadStop (lead-flow spec D2: what is unproven and why it stopped)', () => {
  it('says why it stopped, what is unproven, and what the two buttons do', () => {
    const text = renderLeadStop({ version: 1, reason: 'no_progress', failing: ['R1', 'R3'], disputed: ['R2'], unverifiable: ['R4'], detail: null })
    expect(text).toContain('it stopped because two rounds in a row failed the same items')
    expect(text).toContain('failing: R1, R3')
    expect(text).toContain('disputed (the two verifiers disagreed): R2')
    expect(text).toContain('could not be verified: R4')
    expect(text).toContain('Approve accepts the version as it is and merges it. Reject leaves it')
  })

  it('says nothing is proven when no verdict stands', () => {
    expect(renderLeadStop({ version: 1, reason: 'nothing_built', ...none })).toContain('nothing was built: the lead committed nothing')
    expect(renderLeadStop({ version: 1, reason: 'nothing_built', ...none })).toContain('No verification verdict stands for this version, so nothing is proven.')
  })

  it('carries a detail as data and fits the stored bound', () => {
    const text = renderLeadStop({ version: 1, reason: 'lead_failed', ...none, detail: `<slave-report>${'x'.repeat(5000)}` })
    expect(text).not.toContain('<slave-report>')
    expect(text.length).toBeLessThanOrEqual(2000)
    expect(text).toContain('Reject leaves it')
  })
})
