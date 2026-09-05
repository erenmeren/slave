import { describe, expect, it } from 'vitest'
import { refusalText } from '../src/refusal.js'

/**
 * The `live_runs` refusal is the one refusal whose text is assembled from a field that names a
 * SCHEMA entity (`workspace`/`team`/`slave`), and it used to interpolate that word straight into
 * the sentence a person reads -- "team 7f3a… has 1 live run(s)" (M27 final review, Important 3).
 * The product's vocabulary is project and department; identifiers keep `Workspace`/`Team`.
 */
describe('refusalText for live_runs', () => {
  it('says project, department and slave — never workspace or team', () => {
    expect(refusalText({ kind: 'live_runs', entity: 'workspace', id: 'w1', runs: 2 })).toBe(
      'project w1 has 2 live run(s); wait for them to finish or stop them first',
    )
    expect(refusalText({ kind: 'live_runs', entity: 'team', id: 't1', runs: 1 })).toBe(
      'department t1 has 1 live run(s); wait for them to finish or stop them first',
    )
    expect(refusalText({ kind: 'live_runs', entity: 'slave', id: 'a1', runs: 1 })).toBe(
      'slave a1 has 1 live run(s); wait for them to finish or stop them first',
    )
  })
})
