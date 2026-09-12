import { describe, expect, it } from 'vitest'
import { formTeam, type TeamInput, type TeamRanking, type TeamRosterMember } from '../../src/capability/team.js'
import type { RankEvidence } from '../../src/capability/rank.js'
import type { CapabilityRecord } from '../../src/capability/taxonomy.js'

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: [] },
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: [] },
  { key: 'qa.test-automation', label: 'Test automation', domain: 'qa', role: 'qa', synonyms: [] },
  // M53: the one key the ranking cases below are about. Added rather than reused so a case that
  // ranks WITHIN a tier cannot accidentally move a tier-ORDER case that was written before it.
  { key: 'backend.services', label: 'Service implementation', domain: 'backend', role: 'backend', synonyms: [] },
]

const input = (overrides: Partial<TeamInput> = {}): TeamInput => ({
  required: [],
  // M50 R2: who needs what. EMPTY by default, so no case in this file becomes a temporary hire by
  // accident -- a capability no task is recorded as needing has no sole assignment and stays a
  // project worker, which is exactly what every case written before this milestone meant.
  requiredBy: new Map(),
  roster: [],
  company: [],
  catalog: [],
  taxonomy: TAXONOMY,
  ...overrides,
})

describe('formTeam', () => {
  it('calls a capability covered when somebody already holds the role it projects to', () => {
    const plan = formTeam(
      input({
        required: ['backend.api-design'],
        roster: [{ slaveId: 's1', name: 'Alex', capabilities: ['backend.api-design'], runtimeRoles: ['backend'], busy: false }],
      }),
    )
    expect(plan.covered).toEqual([{ capability: 'backend.api-design', by: 's1' }])
    expect(plan.proposals).toEqual([])
    expect(plan.unfillable).toEqual([])
  })

  it('offers the existing capable worker first when they have the capability but not the role', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        roster: [
          { slaveId: 's2', name: 'Rae', capabilities: ['security.application'], runtimeRoles: ['backend'], busy: false },
          { slaveId: 's1', name: 'Alex', capabilities: [], runtimeRoles: ['backend'], busy: false },
        ],
        company: [{ companySlaveId: 'cs1', name: 'Sam', capabilities: ['security.application'] }],
        catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' }],
      }),
    )
    expect(plan.proposals).toHaveLength(1)
    expect(plan.proposals[0]?.source).toBe('existing_worker')
    expect(plan.proposals[0]?.pick).toEqual({ kind: 'slave', id: 's2', name: 'Rae' })
    expect(plan.proposals[0]?.rationale).toContain('Application security')
  })

  it('prefers a company worker over the catalog', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        company: [{ companySlaveId: 'cs1', name: 'Sam', capabilities: ['security.application'] }],
        catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' }],
      }),
    )
    expect(plan.proposals.map((p) => p.source)).toEqual(['company_worker'])
    expect(plan.proposals[0]?.pick.id).toBe('cs1')
  })

  // THE minimality rule the milestone is named for.
  it('picks one template covering two missing capabilities over two covering one each', () => {
    const plan = formTeam(
      input({
        required: ['security.application', 'qa.test-automation'],
        catalog: [
          { templateId: 'tpl-sec', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' },
          { templateId: 'tpl-qa', name: 'Test Engineer', capabilities: ['qa.test-automation'], division: 'testing' },
          { templateId: 'tpl-both', name: 'Security Test Engineer', capabilities: ['security.application', 'qa.test-automation'], division: 'security' },
        ],
      }),
    )
    expect(plan.proposals).toHaveLength(1)
    expect(new Set(plan.proposals.map((p) => p.pick.id))).toEqual(new Set(['tpl-both']))
    expect(plan.proposals[0]?.covers).toEqual(['qa.test-automation', 'security.application'])
    expect(plan.proposals.every((p) => p.source === 'project_worker')).toBe(true)
  })

  it('breaks a coverage tie on a template a worker profile recommends, and says so', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        catalog: [
          { templateId: 'tpl-a', name: 'A Reviewer', capabilities: ['security.application'], division: 'security' },
          { templateId: 'tpl-b', name: 'B Reviewer', capabilities: ['security.application'], division: 'security' },
        ],
        recommendedTemplateIds: ['tpl-b'],
      }),
    )
    expect(plan.proposals[0]?.pick.id).toBe('tpl-b')
    expect(plan.proposals[0]?.rationale).toContain('recommends')
  })

  it('reports what nobody anywhere provides, and proposes nothing for it', () => {
    const plan = formTeam(input({ required: ['qa.test-automation', 'security.application'], catalog: [] }))
    expect(plan.proposals).toEqual([])
    expect(plan.unfillable).toEqual(['qa.test-automation', 'security.application'])
  })

  it('is deterministic: the same world in a different order gives the same plan', () => {
    const one = formTeam(
      input({
        required: ['security.application', 'backend.api-design'],
        catalog: [
          { templateId: 'tpl-b', name: 'B', capabilities: ['security.application'], division: null },
          { templateId: 'tpl-a', name: 'A', capabilities: ['backend.api-design'], division: null },
        ],
      }),
    )
    const two = formTeam(
      input({
        required: ['backend.api-design', 'security.application'],
        catalog: [
          { templateId: 'tpl-a', name: 'A', capabilities: ['backend.api-design'], division: null },
          { templateId: 'tpl-b', name: 'B', capabilities: ['security.application'], division: null },
        ],
      }),
    )
    expect(one).toEqual(two)
  })

  it('keeps a gap two startable tasks share a PROJECT worker -- a standing seat, not one assignment', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        requiredBy: new Map([['security.application', ['t1', 't2']]]),
        catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' }],
      }),
    )
    expect(plan.proposals).toHaveLength(1)
    expect(plan.proposals[0]?.source).toBe('project_worker')
    expect(plan.proposals[0]?.temporary).toBe(false)
    expect(plan.proposals[0]?.engagementTaskId).toBeNull()
  })

  it('asks for a TEMPORARY specialist when the gap belongs to exactly one startable task', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        requiredBy: new Map([['security.application', ['t1']]]),
        catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' }],
      }),
    )
    expect(plan.proposals).toHaveLength(1)
    expect(plan.proposals[0]?.source).toBe('temporary')
    expect(plan.proposals[0]?.temporary).toBe(true)
    expect(plan.proposals[0]?.engagementTaskId).toBe('t1')
    expect(plan.proposals[0]?.rationale).toContain('one assignment')
  })

  // Erratum E2: a catalog pick covers a SET, and the rule is over the union of the tasks behind it.
  it('is temporary when one pick covers two capabilities the SAME single task needs', () => {
    const plan = formTeam(
      input({
        required: ['security.application', 'qa.test-automation'],
        requiredBy: new Map([
          ['security.application', ['t1']],
          ['qa.test-automation', ['t1']],
        ]),
        catalog: [
          { templateId: 'tpl-both', name: 'Security Test Engineer', capabilities: ['security.application', 'qa.test-automation'], division: 'security' },
        ],
      }),
    )
    expect(plan.proposals).toHaveLength(1)
    expect(plan.proposals[0]?.source).toBe('temporary')
    expect(plan.proposals[0]?.engagementTaskId).toBe('t1')
  })

  it('is NOT temporary when one pick covers two capabilities two different tasks need', () => {
    const plan = formTeam(
      input({
        required: ['security.application', 'qa.test-automation'],
        requiredBy: new Map([
          ['security.application', ['t1']],
          ['qa.test-automation', ['t2']],
        ]),
        catalog: [
          { templateId: 'tpl-both', name: 'Security Test Engineer', capabilities: ['security.application', 'qa.test-automation'], division: 'security' },
        ],
      }),
    )
    expect(plan.proposals).toHaveLength(1)
    expect(plan.proposals[0]?.source).toBe('project_worker')
    expect(plan.proposals[0]?.engagementTaskId).toBeNull()
  })

  it('never makes a company worker or an existing worker temporary, however few tasks need them', () => {
    const plan = formTeam(
      input({
        required: ['security.application'],
        requiredBy: new Map([['security.application', ['t1']]]),
        company: [{ companySlaveId: 'cs1', name: 'Sam', capabilities: ['security.application'] }],
        catalog: [{ templateId: 'tpl1', name: 'Security Reviewer', capabilities: ['security.application'], division: 'security' }],
      }),
    )
    expect(plan.proposals.map((p) => p.source)).toEqual(['company_worker'])
    expect(plan.proposals[0]?.temporary).toBe(false)
    expect(plan.proposals[0]?.engagementTaskId).toBeNull()
  })
})

describe('formTeam -- one proposal per worker (fix round 1)', () => {
  it('offers ONE existing worker once, covering every missing capability they provide', () => {
    const plan = formTeam(
      input({
        required: ['security.application', 'qa.test-automation'],
        roster: [
          {
            slaveId: 's1',
            name: 'Rae',
            capabilities: ['security.application', 'qa.test-automation'],
            runtimeRoles: ['backend'],
            busy: false,
          },
        ],
      }),
    )
    expect(plan.proposals).toHaveLength(1)
    expect(plan.proposals[0]?.source).toBe('existing_worker')
    expect(plan.proposals[0]?.pick.id).toBe('s1')
    expect(plan.proposals[0]?.covers).toEqual(['qa.test-automation', 'security.application'])
    expect(plan.proposals[0]?.capability).toBe('qa.test-automation')
    expect(plan.proposals[0]?.rationale).toContain('Application security')
    expect(plan.proposals[0]?.rationale).toContain('Test automation')
    expect(plan.unfillable).toEqual([])
  })

  // A capability the taxonomy does not have projects to no role, so there is no role to grant and
  // nothing to propose -- an empty `""` in the rationale would be the only thing produced.
  it('proposes no existing worker for a capability that projects to no role', () => {
    const plan = formTeam(
      input({
        required: ['ghost.thing'],
        roster: [{ slaveId: 's1', name: 'Rae', capabilities: ['ghost.thing'], runtimeRoles: ['backend'], busy: false }],
      }),
    )
    expect(plan.proposals).toEqual([])
    expect(plan.unfillable).toEqual(['ghost.thing'])
  })
})

/**
 * M53 R8. The `TeamSource` tier ORDER is M47 R4's and this milestone does not touch it -- every
 * tier-order case above stays exactly as it was. What changes is the pick WITHIN a tier: the
 * alphabet used to break every tie and now six steps do, with the id still the last of them.
 */
describe('formTeam ranks WITHIN a tier (M53 R8)', () => {
  const base = {
    required: ['backend.services'],
    requiredBy: new Map<string, readonly string[]>(),
    company: [],
    catalog: [],
    taxonomy: TAXONOMY,
  }

  /** A roster worker who PROVIDES the capability and holds no role for it -- tier 1's whole field. */
  const provider = (slaveId: string, extra: Partial<TeamRosterMember> = {}): TeamRosterMember => ({
    slaveId,
    name: slaveId,
    capabilities: ['backend.services'],
    runtimeRoles: [],
    busy: false,
    ...extra,
  })

  /** A record of nothing: every counter zero, every median absent. The state of a profile nobody
   *  has ever concluded a run for, spelled out so a case that means "thin" says which number is. */
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

  const STRONG: RankEvidence = {
    ...NO_EVIDENCE,
    attempted: 20,
    firstPassJudged: 20,
    firstPassPassed: 19,
    reviewJudged: 20,
    reviewRejected: 1,
    integrationJudged: 20,
    integrated: 19,
    medianCostUsd: 1,
    medianDurationMs: 1_000,
  }

  const WEAK: RankEvidence = {
    ...NO_EVIDENCE,
    attempted: 20,
    firstPassJudged: 20,
    firstPassPassed: 2,
    reviewJudged: 20,
    reviewRejected: 18,
    integrationJudged: 20,
    integrated: 2,
    medianCostUsd: 9,
    medianDurationMs: 9_000,
  }

  /**
   * A ranking context over the two candidates these cases use, with R1's own key rule applied: a
   * worker hired from a template keys on the template, a bespoke one on itself. Everything a case
   * does not name answers its neutral value, which is exactly the state a caller with no `ranking`
   * at all is in.
   */
  const rankingWith = (evidence: Record<string, RankEvidence>, extra: Partial<TeamRanking> = {}): TeamRanking => {
    const templateOf = extra.templateOf ?? new Map<string, string | null>()
    const keyOf = (id: string): string => {
      const templateId = templateOf.get(id) ?? null
      return templateId === null ? `slave:${id}` : `template:${templateId}`
    }
    return {
      preferences: extra.preferences ?? new Map(),
      evidence: new Map(Object.entries(evidence)),
      deniedKinds: extra.deniedKinds ?? new Map(),
      templateOf,
      modelOf: extra.modelOf ?? new Map(),
      profileKeyOf: extra.profileKeyOf ?? new Map(['a', 'b'].map((id) => [id, keyOf(id)] as const)),
      runKind: extra.runKind ?? 'implementation',
    }
  }

  it('keeps the TIER order untouched: an existing worker still beats a company worker', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a')],
      company: [{ companySlaveId: 'c', name: 'C', capabilities: ['backend.services'] }],
    })
    expect(plan.proposals[0]?.source).toBe('existing_worker')
  })

  it('picks the profile with the better record, where the alphabet used to decide', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a'), provider('b')],
      ranking: rankingWith({
        'slave:a': { ...NO_EVIDENCE, attempted: 10, firstPassJudged: 10, firstPassPassed: 1 },
        'slave:b': { ...NO_EVIDENCE, attempted: 10, firstPassJudged: 10, firstPassPassed: 9 },
      }),
    })
    expect(plan.proposals[0]?.pick.id).toBe('b')
  })

  it('picks the alphabet again when neither record is thick enough to mean anything (R11)', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a'), provider('b')],
      ranking: rankingWith({
        'slave:a': { ...NO_EVIDENCE, attempted: 2, firstPassJudged: 2, firstPassPassed: 0 },
        'slave:b': { ...NO_EVIDENCE, attempted: 2, firstPassJudged: 2, firstPassPassed: 2 },
      }),
    })
    expect(plan.proposals[0]?.pick.id).toBe('a')
  })

  it('still prefers the IDLE worker -- availability is step 4 and outranks the record', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a', { busy: true }), provider('b')],
      ranking: rankingWith({ 'slave:a': STRONG, 'slave:b': WEAK }),
    })
    expect(plan.proposals[0]?.pick.id).toBe('b')
  })

  it('honours a preference naming a template, above the record', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a'), provider('b')],
      ranking: rankingWith(
        { 'template:t-a': STRONG },
        {
          preferences: new Map([['backend.services', { templateId: 't-b', model: null }]]),
          templateOf: new Map([
            ['a', 't-a'],
            ['b', 't-b'],
          ]),
        },
      ),
    })
    expect(plan.proposals[0]?.pick.id).toBe('b')
  })

  it('ranks a DENIED worker below an undenied one, whatever the preference says', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a'), provider('b')],
      ranking: rankingWith(
        {},
        {
          preferences: new Map([['backend.services', { templateId: 't-b', model: null }]]),
          templateOf: new Map([
            ['a', 't-a'],
            ['b', 't-b'],
          ]),
          deniedKinds: new Map([['b', ['run_commands'] as const]]),
        },
      ),
    })
    expect(plan.proposals[0]?.pick.id).toBe('a')
  })

  it('names the step in the rationale, so a person reads WHY rather than a number', () => {
    const plan = formTeam({
      ...base,
      roster: [provider('a'), provider('b', { busy: true })],
      ranking: rankingWith({}),
    })
    // R11: the sentence names the STEP, and carries no score, rating or currency figure.
    expect(plan.proposals[0]?.rationale).toMatch(/free/u)
    expect(plan.proposals[0]?.rationale).not.toMatch(/\$|\d+\.\d{2}/u)
  })

  it('says nothing extra when nothing but the names separated them', () => {
    // Plan decision D26: "we picked alphabetically" is not a reason worth putting in front of a
    // person, and a one-candidate field has nothing to compare against at all.
    const alone = formTeam({ ...base, roster: [provider('a')], ranking: rankingWith({}) })
    expect(alone.proposals[0]?.rationale).toMatch(/nobody new\.$/u)

    const tied = formTeam({ ...base, roster: [provider('a'), provider('b')], ranking: rankingWith({}) })
    expect(tied.proposals[0]?.pick.id).toBe('a')
    expect(tied.proposals[0]?.rationale).toMatch(/nobody new\.$/u)
  })

  it('ranks WITHIN the catalog tier too, where the alphabet was the last break', () => {
    // D25: `coverWith`'s four existing breaks -- covers count, recommended, capability count, name
    // -- are M47's and M50's and do not move. Only the LAST one, the id, becomes the record. Two
    // entries with the same name is what it takes to reach it.
    const plan = formTeam({
      ...base,
      roster: [],
      catalog: [
        { templateId: 't-a', name: 'Same Name', capabilities: ['backend.services'], division: 'backend' },
        { templateId: 't-b', name: 'Same Name', capabilities: ['backend.services'], division: 'backend' },
      ],
      ranking: rankingWith(
        { 'template:t-b': STRONG },
        {
          templateOf: new Map([
            ['t-a', 't-a'],
            ['t-b', 't-b'],
          ]),
          profileKeyOf: new Map([
            ['t-a', 'template:t-a'],
            ['t-b', 'template:t-b'],
          ]),
        },
      ),
    })
    expect(plan.proposals[0]?.pick.id).toBe('t-b')
  })

  it('behaves exactly as it did before when `ranking` is absent -- every caller written before M53', () => {
    const plan = formTeam({ ...base, roster: [provider('b', { busy: true }), provider('a')] })
    expect(plan.proposals[0]?.pick.id).toBe('a')
  })
})
