import { describe, expect, it } from 'vitest'
import { INITIAL_LEAD_PROGRESS, afterCheckFailure, afterConfirm, afterRound, type LeadProgress, type ProofItem } from '../../src/lead/index.js'

const item = (key: string, status: ProofItem['status']): ProofItem => ({ key, status })
const allPass = [item('R1', 'pass'), item('R2', 'pass'), item('RUN', 'pass')]
const round = (items: readonly ProofItem[], progress: LeadProgress = INITIAL_LEAD_PROGRESS, scope: 'full' | 'partial' = 'full', tipMoved = false) =>
  afterRound({ scope, items, progress, runId: 'run-1', tipMoved })

describe('the proof loop\'s step (lead-flow spec P3-P5, P7)', () => {
  it('accepts a full round on the current tip with nothing failing, disputed or unverifiable', () => {
    expect(round(allPass)).toEqual({ kind: 'accept', progress: INITIAL_LEAD_PROGRESS })
  })

  it('sends a failure to the confirmer first, never straight to the lead (P3)', () => {
    const step = round([item('R1', 'fail'), item('R2', 'pass'), item('RUN', 'pass')])
    expect(step.kind).toBe('confirm')
    expect(step.progress.confirm).toEqual({ runId: 'run-1', keys: ['R1'], scope: 'full' })
  })

  it('reworks what both verifiers failed, and the next round checks only that (P3, P5)', () => {
    const waiting = round([item('R1', 'fail'), item('R2', 'fail'), item('RUN', 'pass')]).progress
    const step = afterConfirm({ items: [item('R1', 'fail'), item('R2', 'fail')], progress: waiting })
    expect(step).toMatchObject({ kind: 'rework', keys: ['R1', 'R2'] })
    expect(step.progress).toMatchObject({ confirm: null, failing: ['R1', 'R2'], recheckKeys: ['R1', 'R2'], disputed: [] })
  })

  it('marks what the confirmer does not fail as disputed and does not rework it (P3)', () => {
    const waiting = round([item('R1', 'fail'), item('R2', 'fail'), item('RUN', 'pass')]).progress
    const step = afterConfirm({ items: [item('R1', 'pass'), item('R2', 'fail')], progress: waiting })
    expect(step).toMatchObject({ kind: 'rework', keys: ['R2'] })
    expect(step.progress.disputed).toEqual(['R1'])
    const none = afterConfirm({ items: [item('R1', 'unverifiable'), item('R2', 'pass')], progress: waiting })
    expect(none).toMatchObject({ kind: 'stop', reason: 'not_all_proven' })
    expect(none.progress.disputed).toEqual(['R1', 'R2'])
  })

  it('never confirms or reworks a disputed key again, and clears it when a later round passes it', () => {
    const disputed: LeadProgress = { ...INITIAL_LEAD_PROGRESS, disputed: ['R1'] }
    expect(round([item('R1', 'fail'), item('R2', 'pass'), item('RUN', 'pass')], disputed)).toMatchObject({ kind: 'stop', reason: 'not_all_proven' })
    expect(round(allPass, disputed)).toEqual({ kind: 'accept', progress: INITIAL_LEAD_PROGRESS })
  })

  it('runs the full verification after a partial round that passed, and again when the tip moved under a full one (P5)', () => {
    const afterRework: LeadProgress = { ...INITIAL_LEAD_PROGRESS, failing: ['R1'], recheckKeys: ['R1'] }
    const partial = round([item('R1', 'pass')], afterRework, 'partial')
    expect(partial).toMatchObject({ kind: 'verify_again' })
    expect(partial.progress).toMatchObject({ recheckKeys: [], failing: [] })
    expect(round(allPass, INITIAL_LEAD_PROGRESS, 'full', true).kind).toBe('verify_again')
  })

  it('does not stop on unverifiable while something can still be reworked, and reports it at the end (P4)', () => {
    const first = round([item('R1', 'unverifiable'), item('R2', 'fail'), item('RUN', 'pass')])
    expect(first.kind).toBe('confirm')
    expect(first.progress.unverifiable).toEqual(['R1'])
    const end = round([item('R1', 'unverifiable'), item('R2', 'pass'), item('RUN', 'pass')], { ...INITIAL_LEAD_PROGRESS, unverifiable: ['R1'] })
    expect(end).toMatchObject({ kind: 'stop', reason: 'not_all_proven' })
    expect(end.progress.unverifiable).toEqual(['R1'])
    // A later round that can verify it after all clears it.
    expect(round(allPass, { ...INITIAL_LEAD_PROGRESS, unverifiable: ['R1'] }).kind).toBe('accept')
  })

  it('stops when two rounds in a row confirm the same failing set (P7)', () => {
    const second: LeadProgress = { ...INITIAL_LEAD_PROGRESS, failing: ['R1'], recheckKeys: ['R1'], confirm: { runId: 'run-3', keys: ['R1'], scope: 'partial' } }
    expect(afterConfirm({ items: [item('R1', 'fail')], progress: second })).toMatchObject({ kind: 'stop', reason: 'no_progress' })
    const other: LeadProgress = { ...second, failing: ['R2'] }
    expect(afterConfirm({ items: [item('R1', 'fail')], progress: other }).kind).toBe('rework')
  })

  it('stops with the lead\'s own reason when it is ended and something still fails (P7)', () => {
    const ended: LeadProgress = { ...INITIAL_LEAD_PROGRESS, leadEnded: 'budget_spent' }
    const step = round([item('R1', 'fail'), item('R2', 'pass'), item('RUN', 'pass')], ended)
    expect(step).toMatchObject({ kind: 'stop', reason: 'budget_spent' })
    expect(step.progress.failing).toEqual(['R1'])
    expect(round(allPass, ended).kind).toBe('accept')
    const waiting: LeadProgress = { ...ended, leadEnded: 'time_spent', confirm: { runId: 'r', keys: ['R1'], scope: 'full' } }
    expect(afterConfirm({ items: [item('R1', 'fail')], progress: waiting })).toMatchObject({ kind: 'stop', reason: 'time_spent' })
  })

  it('sends a failing smoke back once and stops when it fails twice in a row (P2, P7)', () => {
    const first = afterCheckFailure(INITIAL_LEAD_PROGRESS, 'SMOKE')
    expect(first).toMatchObject({ kind: 'rework', keys: ['SMOKE'] })
    expect(afterCheckFailure(first.progress, 'SMOKE')).toMatchObject({ kind: 'stop', reason: 'no_progress' })
    expect(afterCheckFailure({ ...INITIAL_LEAD_PROGRESS, leadEnded: 'time_spent' }, 'SMOKE')).toMatchObject({ kind: 'stop', reason: 'time_spent' })
  })
})
