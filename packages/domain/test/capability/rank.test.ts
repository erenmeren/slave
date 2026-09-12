import { describe, expect, it } from 'vitest'
import {
  EVIDENCE_MIN_SAMPLE,
  RANK_STEPS,
  RANK_STEP_LABEL,
  rankCandidates,
  type RankCandidate,
  type RankContext,
  type RankEvidence,
} from '../../src/capability/rank.js'

const NO_EVIDENCE: RankEvidence = {
  attempted: 0,
  firstPassJudged: 0,
  firstPassPassed: 0,
  reviewJudged: 0,
  reviewRejected: 0,
  integrationJudged: 0,
  integrated: 0,
  medianCostUsd: null,
  medianDurationMs: null,
}

function candidate(overrides: Partial<RankCandidate> & { readonly id: string }): RankCandidate {
  return {
    kind: 'slave',
    name: overrides.id,
    profileKey: `slave:${overrides.id}`,
    templateId: null,
    model: null,
    covers: ['backend.services'],
    busy: false,
    deniedKinds: [],
    evidence: null,
    ...overrides,
  }
}

const CONTEXT: RankContext = { capability: 'backend.services', preference: null, runKind: 'implementation' }

const order = (ranked: ReturnType<typeof rankCandidates>): readonly string[] =>
  ranked.map((one) => one.candidate.id)

describe('RANK_STEPS', () => {
  it('is the roadmap six, IN ORDER, plus the one tie-break that makes the function total (E9)', () => {
    expect(RANK_STEPS).toEqual([
      'capability_fit',
      'permission',
      'preference',
      'availability',
      'evidence',
      'cost_time',
      'identity',
    ])
  })

  it('gives every step a word, so a rationale sentence never prints the key', () => {
    for (const step of RANK_STEPS) {
      expect(RANK_STEP_LABEL[step], step).toMatch(/^[A-Z]/u)
      expect(RANK_STEP_LABEL[step], step).not.toContain('_')
    }
  })
})

describe('EVIDENCE_MIN_SAMPLE', () => {
  it('is five -- the smallest sample this project is willing to call evidence (R11)', () => {
    expect(EVIDENCE_MIN_SAMPLE).toBe(5)
  })
})

describe('rankCandidates: step 1, capability fit', () => {
  it('puts a candidate covering more still-missing capabilities first', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'a', covers: ['backend.services'] }), candidate({ id: 'b', covers: ['backend.services', 'qa.test-automation'] })],
      CONTEXT,
    )
    expect(order(ranked)).toEqual(['b', 'a'])
    expect(ranked[0]?.decidedBy).toBe('capability_fit')
  })

  it('puts a candidate that provides the capability above one that provides none of them', () => {
    const ranked = rankCandidates([candidate({ id: 'a', covers: [] }), candidate({ id: 'b' })], CONTEXT)
    expect(order(ranked)).toEqual(['b', 'a'])
  })
})

describe('rankCandidates: step 2, permission (R10)', () => {
  it('ranks a worker with an explicit deny on a BASELINE kind below one without', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'a', deniedKinds: ['run_commands'] }), candidate({ id: 'b' })],
      CONTEXT,
    )
    expect(order(ranked)).toEqual(['b', 'a'])
    expect(ranked[0]?.decidedBy).toBe('permission')
  })

  it('ignores a deny on a kind the run kind baseline does not include -- a wall nobody walks into', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'b', deniedKinds: ['deploy_release'] }), candidate({ id: 'a' })],
      CONTEXT,
    )
    // Nothing separated them but their identities.
    expect(order(ranked)).toEqual(['a', 'b'])
    expect(ranked[0]?.decidedBy).toBe('identity')
  })

  it('reads the RUN KIND baseline, so `write_repo` walls an implementation and not a planning run', () => {
    const walled = candidate({ id: 'a', deniedKinds: ['write_repo'] })
    expect(order(rankCandidates([walled, candidate({ id: 'b' })], CONTEXT))).toEqual(['b', 'a'])
    expect(
      order(rankCandidates([walled, candidate({ id: 'b' })], { ...CONTEXT, runKind: 'planning' })),
    ).toEqual(['a', 'b'])
  })

  it('does not EXCLUDE a denied candidate -- a wall is a ranking fact, not a disqualification', () => {
    const ranked = rankCandidates([candidate({ id: 'a', deniedKinds: ['run_commands'] })], CONTEXT)
    expect(order(ranked)).toEqual(['a'])
  })

  it('leaves a template and a company worker unaffected: they carry no permission rows at all', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'a', kind: 'template', templateId: 'a' }), candidate({ id: 'b', kind: 'company_slave' })],
      CONTEXT,
    )
    expect(ranked[0]?.decidedBy).toBe('identity')
  })
})

describe('rankCandidates: step 3, preference (R9)', () => {
  const preferring = (templateId: string | null, model: string | null): RankContext => ({
    ...CONTEXT,
    preference: { templateId, model },
  })

  it('puts the preferred candidate first, above one with a better record', () => {
    const strong: RankEvidence = { ...NO_EVIDENCE, attempted: 20, firstPassJudged: 20, firstPassPassed: 20 }
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', templateId: 't-a', evidence: strong }),
        candidate({ id: 'b', templateId: 't-b', evidence: NO_EVIDENCE }),
      ],
      preferring('t-b', null),
    )
    expect(order(ranked)).toEqual(['b', 'a'])
    expect(ranked[0]?.decidedBy).toBe('preference')
  })

  it('never beats the WALL: a preferred candidate with a baseline deny still ranks below', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', templateId: 't-a' }),
        candidate({ id: 'b', templateId: 't-b', deniedKinds: ['run_commands'] }),
      ],
      preferring('t-b', null),
    )
    expect(order(ranked)).toEqual(['a', 'b'])
    expect(ranked[0]?.decidedBy).toBe('permission')
  })

  it('carries NO weight for a BUSY candidate -- a preference for somebody who cannot start is not one', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'a', templateId: 't-a' }), candidate({ id: 'b', templateId: 't-b', busy: true })],
      preferring('t-b', null),
    )
    expect(order(ranked)).toEqual(['a', 'b'])
    expect(ranked[0]?.decidedBy).toBe('availability')
  })

  it('matches on the MODEL alone when the preference names only a model', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'a', model: 'sonnet' }), candidate({ id: 'b', model: 'opus' })],
      preferring(null, 'opus'),
    )
    expect(order(ranked)).toEqual(['b', 'a'])
  })

  it('requires BOTH halves when both are named -- "Atlas, and on opus" is one decision', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', templateId: 't-a', model: 'opus' }),
        candidate({ id: 'b', templateId: 't-b', model: 'sonnet' }),
      ],
      preferring('t-b', 'opus'),
    )
    expect(order(ranked)).toEqual(['a', 'b'])
    expect(ranked[0]?.decidedBy).toBe('identity')
  })
})

describe('rankCandidates: step 4, availability', () => {
  it('puts an idle candidate above a busy one', () => {
    const ranked = rankCandidates([candidate({ id: 'a', busy: true }), candidate({ id: 'b' })], CONTEXT)
    expect(order(ranked)).toEqual(['b', 'a'])
    expect(ranked[0]?.decidedBy).toBe('availability')
  })
})

describe('rankCandidates: step 5, evidence (R8, R11)', () => {
  const withRates = (id: string, passed: number, rejected: number, integrated: number): RankCandidate =>
    candidate({
      id,
      evidence: {
        ...NO_EVIDENCE,
        attempted: 10,
        firstPassJudged: 10,
        firstPassPassed: passed,
        reviewJudged: 10,
        reviewRejected: rejected,
        integrationJudged: 10,
        integrated,
      },
    })

  it('prefers the higher first-pass verify rate, before either of the other two', () => {
    const ranked = rankCandidates([withRates('a', 4, 0, 10), withRates('b', 9, 9, 0)], CONTEXT)
    expect(order(ranked)).toEqual(['b', 'a'])
    expect(ranked[0]?.decidedBy).toBe('evidence')
  })

  it('falls to the LOWER review-rejection rate when the first-pass rates tie', () => {
    const ranked = rankCandidates([withRates('a', 5, 8, 0), withRates('b', 5, 1, 0)], CONTEXT)
    expect(order(ranked)).toEqual(['b', 'a'])
  })

  it('falls to the HIGHER integration rate when the first two tie', () => {
    const ranked = rankCandidates([withRates('a', 5, 5, 2), withRates('b', 5, 5, 9)], CONTEXT)
    expect(order(ranked)).toEqual(['b', 'a'])
  })

  it('SKIPS a rate whose own denominator is thin, so a thin record ties instead of deciding', () => {
    const thin = candidate({
      id: 'a',
      evidence: { ...NO_EVIDENCE, attempted: 2, firstPassJudged: 2, firstPassPassed: 2 },
    })
    const fat = candidate({
      id: 'b',
      evidence: { ...NO_EVIDENCE, attempted: 10, firstPassJudged: 10, firstPassPassed: 1 },
    })
    const ranked = rankCandidates([thin, fat], CONTEXT)
    expect(order(ranked)).toEqual(['a', 'b'])
    expect(ranked[0]?.decidedBy).toBe('identity')
  })

  it('reads a denominator of exactly EVIDENCE_MIN_SAMPLE as enough', () => {
    const five = candidate({
      id: 'a',
      evidence: { ...NO_EVIDENCE, attempted: 5, firstPassJudged: EVIDENCE_MIN_SAMPLE, firstPassPassed: 5 },
    })
    const worse = candidate({
      id: 'b',
      evidence: { ...NO_EVIDENCE, attempted: 5, firstPassJudged: EVIDENCE_MIN_SAMPLE, firstPassPassed: 0 },
    })
    expect(order(rankCandidates([worse, five], CONTEXT))).toEqual(['a', 'b'])
  })

  it('skips every rate for a candidate with NO record at all rather than reading it as zero', () => {
    const none = candidate({ id: 'a', evidence: null })
    const some = candidate({
      id: 'b',
      evidence: { ...NO_EVIDENCE, attempted: 10, firstPassJudged: 10, firstPassPassed: 10 },
    })
    expect(rankCandidates([none, some], CONTEXT)[0]?.decidedBy).toBe('identity')
  })
})

describe('rankCandidates: step 6, cost and time (R8)', () => {
  it('prefers the lower median cost', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', evidence: { ...NO_EVIDENCE, medianCostUsd: 2 } }),
        candidate({ id: 'b', evidence: { ...NO_EVIDENCE, medianCostUsd: 1 } }),
      ],
      CONTEXT,
    )
    expect(order(ranked)).toEqual(['b', 'a'])
    expect(ranked[0]?.decidedBy).toBe('cost_time')
  })

  it('falls to the lower median duration when the costs tie', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', evidence: { ...NO_EVIDENCE, medianCostUsd: 1, medianDurationMs: 9_000 } }),
        candidate({ id: 'b', evidence: { ...NO_EVIDENCE, medianCostUsd: 1, medianDurationMs: 1_000 } }),
      ],
      CONTEXT,
    )
    expect(order(ranked)).toEqual(['b', 'a'])
  })

  it('TIES on an unmeasured candidate rather than letting it win -- unmeasured is not cheap', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', evidence: { ...NO_EVIDENCE, medianCostUsd: null } }),
        candidate({ id: 'b', evidence: { ...NO_EVIDENCE, medianCostUsd: 5 } }),
      ],
      CONTEXT,
    )
    expect(order(ranked)).toEqual(['a', 'b'])
    expect(ranked[0]?.decidedBy).toBe('identity')
  })
})

describe('rankCandidates: the shape of the answer (R11, E9, E10)', () => {
  it('is total and deterministic: the same world always yields the same order', () => {
    const world = [candidate({ id: 'c' }), candidate({ id: 'a' }), candidate({ id: 'b' })]
    expect(order(rankCandidates(world, CONTEXT))).toEqual(['a', 'b', 'c'])
    expect(order(rankCandidates([...world].toReversed(), CONTEXT))).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate its input', () => {
    const world = [candidate({ id: 'c' }), candidate({ id: 'a' })]
    rankCandidates(world, CONTEXT)
    expect(world.map((one) => one.id)).toEqual(['c', 'a'])
  })

  it('answers an empty list for an empty world', () => {
    expect(rankCandidates([], CONTEXT)).toEqual([])
  })

  it('names the step that separated each candidate from the NEXT, and null for the last', () => {
    const ranked = rankCandidates([candidate({ id: 'a' }), candidate({ id: 'b', busy: true })], CONTEXT)
    expect(ranked[0]?.decidedBy).toBe('availability')
    expect(ranked[1]?.decidedBy).toBeNull()
  })

  it('carries a rationale sentence naming both candidates, derived and never invented', () => {
    const ranked = rankCandidates(
      [candidate({ id: 'a', name: 'Atlas' }), candidate({ id: 'b', name: 'Bea', busy: true })],
      CONTEXT,
    )
    expect(ranked[0]?.reason).toContain('Atlas')
    expect(ranked[0]?.reason).toContain('Bea')
    expect(ranked[0]?.reason).toMatch(/free/u)
  })

  it('NEVER puts a currency figure in a rationale -- `formatUsd` owns money (erratum E10)', () => {
    const ranked = rankCandidates(
      [
        candidate({ id: 'a', evidence: { ...NO_EVIDENCE, medianCostUsd: 2.5 } }),
        candidate({ id: 'b', evidence: { ...NO_EVIDENCE, medianCostUsd: 1.25 } }),
      ],
      CONTEXT,
    )
    for (const one of ranked) expect(one.reason).not.toMatch(/\$|\d+\.\d{2}/u)
  })

  it('carries NO score, rating, rank, weight, index or total on any result property (R11)', () => {
    const ranked = rankCandidates([candidate({ id: 'a' }), candidate({ id: 'b' })], CONTEXT)
    for (const one of ranked) {
      for (const key of Object.keys(one)) {
        expect(key, key).not.toMatch(/score|rating|^rank$|weight|index|total/iu)
      }
      // The only numbers anywhere in the answer are the candidate's own measured counts.
      expect(typeof one.decidedBy === 'string' || one.decidedBy === null).toBe(true)
      expect(typeof one.reason).toBe('string')
    }
  })
})
