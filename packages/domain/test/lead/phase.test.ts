import { describe, expect, it } from 'vitest'
import {
  LEAD_NOTE_KINDS,
  LEAD_NOTE_WORDS,
  PROJECT_PHASES,
  PROJECT_PHASE_LABEL,
  STOP_REASONS,
  STOP_REASON_WORDS,
  phaseIsActive,
  phaseNeedsPerson,
  projectPhaseOf,
  projectPhaseSentence,
  requirementResultOf,
  type ProjectPhaseFacts,
} from '../../src/lead/index.js'

const facts = (over: Partial<ProjectPhaseFacts>): ProjectPhaseFacts => ({
  flow: 'lead',
  haltedReason: null,
  goalVersion: 1,
  delivery: { goalVersion: 1, leadState: 'building', status: 'integrating' },
  ...over,
})

describe('projectPhaseOf (lead UX design section 5)', () => {
  it('reads a packages-flow project as older, whatever its state', () => {
    expect(projectPhaseOf(facts({ flow: 'packages' }))).toBe('older')
    expect(projectPhaseOf(facts({ flow: 'packages', haltedReason: 'emergency stop by x' }))).toBe('older')
  })

  it('reads a person\'s stop as paused and any other halt as failed, over every build state', () => {
    expect(projectPhaseOf(facts({ haltedReason: 'emergency stop by web operator' }))).toBe('paused')
    expect(projectPhaseOf(facts({ haltedReason: 'verify_not_configured' }))).toBe('failed')
    expect(projectPhaseOf(facts({ haltedReason: 'emergency stop by cli', delivery: { goalVersion: 1, leadState: 'delivered', status: 'accepted' } }))).toBe('paused')
  })

  it('reads empty before anything was asked for, and starting until the newest build has a state', () => {
    expect(projectPhaseOf(facts({ goalVersion: 0, delivery: null }))).toBe('empty')
    expect(projectPhaseOf(facts({ delivery: null }))).toBe('starting')
    expect(projectPhaseOf(facts({ goalVersion: 2 }))).toBe('starting')
    expect(projectPhaseOf(facts({ delivery: { goalVersion: 1, leadState: null, status: 'integrating' } }))).toBe('starting')
  })

  it('maps each lead state to its phase', () => {
    const of = (leadState: 'building' | 'proving' | 'delivered' | 'stopped', status: 'integrating' | 'verifying' | 'accepted' | 'abandoned' = 'integrating'): string =>
      projectPhaseOf(facts({ delivery: { goalVersion: 1, leadState, status } }))
    expect(of('building')).toBe('building')
    expect(of('proving', 'verifying')).toBe('checking')
    expect(of('delivered', 'accepted')).toBe('delivered')
    expect(of('stopped', 'abandoned')).toBe('closed')
  })

  it('tells a stopped build from an accepted one that waits for a merge', () => {
    expect(projectPhaseOf(facts({ delivery: { goalVersion: 1, leadState: 'awaiting_decision', status: 'needs_human' } }))).toBe('needs_decision')
    expect(projectPhaseOf(facts({ delivery: { goalVersion: 1, leadState: 'awaiting_decision', status: 'accepted' } }))).toBe('ready_to_merge')
  })
})

describe('the phase helpers and words', () => {
  it('marks exactly the two waiting phases as needing a person, and the three running ones as active', () => {
    expect(PROJECT_PHASES.filter(phaseNeedsPerson)).toEqual(['needs_decision', 'ready_to_merge'])
    expect(PROJECT_PHASES.filter(phaseIsActive)).toEqual(['starting', 'building', 'checking'])
  })

  it('has a label and a sentence for every phase, none of them a raw token', () => {
    for (const phase of PROJECT_PHASES) {
      expect(PROJECT_PHASE_LABEL[phase]).not.toMatch(/_/u)
      const sentence = projectPhaseSentence(phase, { baseBranch: 'main', haltedReason: 'the gate failed' })
      expect(sentence.length).toBeGreaterThan(10)
      expect(sentence).not.toMatch(/goal version|conducted|work package/iu)
    }
    expect(projectPhaseSentence('delivered', { baseBranch: 'trunk', haltedReason: null })).toContain('trunk')
    expect(projectPhaseSentence('failed', { baseBranch: 'main', haltedReason: 'the gate failed' })).toContain('the gate failed')
  })

  it('says every stop reason and every note kind in words', () => {
    for (const reason of STOP_REASONS) expect(STOP_REASON_WORDS[reason]).toMatch(/\.$/u)
    for (const kind of LEAD_NOTE_KINDS) expect(LEAD_NOTE_WORDS[kind]).not.toMatch(/_/u)
  })

  it('reads a disputed key as disputed whatever its newest verdict, and no verdict as unchecked', () => {
    expect(requirementResultOf('R1', 'pass', ['R1'])).toBe('disputed')
    expect(requirementResultOf('R2', 'fail', ['R1'])).toBe('fail')
    expect(requirementResultOf('R3', null, [])).toBe('unchecked')
  })
})
