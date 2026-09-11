import { describe, expect, it } from 'vitest'
import { formTeam, type TeamInput } from '../../src/capability/team.js'
import type { CapabilityRecord } from '../../src/capability/taxonomy.js'

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: [] },
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: [] },
  { key: 'qa.test-automation', label: 'Test automation', domain: 'qa', role: 'qa', synonyms: [] },
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
