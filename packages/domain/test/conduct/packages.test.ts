import { describe, expect, it } from 'vitest'
import {
  CONDUCT_ANSWER_KEY,
  conductPlanSchema,
  ownerOf,
  parseConductAnswer,
  singlePlan,
  validateConduct,
  type ConductContext,
} from '../../src/conduct/packages.js'
import { INTEGRATION_PACKAGE_KEY } from '../../src/conduct/constants.js'

const context: ConductContext = {
  requirementKeys: ['R1', 'R2', 'R3'],
  repoFiles: ['src/cli.py', 'src/report/table.py', 'src/config.py', 'README.md'],
  templateIds: new Set(['t-backend', 't-docs']),
}
const pkg = (over: Record<string, unknown>): Record<string, unknown> => ({
  key: 'report', title: 'Report modes', requirementKeys: ['R1'], ownedPaths: ['src/report/**'], newPaths: [],
  interface: 'render(rows, mode) -> str', dependsOn: [], templateId: 't-backend', ...over,
})

describe('validateConduct', () => {
  it('accepts single and gives the one package every requirement and every path', () => {
    const plan = validateConduct({ mode: 'single', reason: 'fits one session', templateId: 't-backend' }, context)
    expect(plan.ok && plan.value.packages).toEqual([
      expect.objectContaining({ key: 'main', ownedPaths: ['**'], requirementKeys: ['R1', 'R2', 'R3'], isIntegration: false }),
    ])
  })

  it('accepts a disjoint partition and adds the integration package, dependent on all others', () => {
    const plan = validateConduct({
      mode: 'partitioned', reason: 'two large disjoint parts',
      packages: [pkg({}), pkg({ key: 'config', requirementKeys: ['R2', 'R3'], ownedPaths: ['src/config.py'], templateId: 't-backend' })],
    }, context)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const integration = plan.value.packages.find((p) => p.key === INTEGRATION_PACKAGE_KEY)
    expect(integration).toEqual(expect.objectContaining({ isIntegration: true, dependsOn: ['report', 'config'], requirementKeys: [] }))
    expect(ownerOf('src/cli.py', plan.value.packages)).toBe(INTEGRATION_PACKAGE_KEY)
    expect(ownerOf('src/report/table.py', plan.value.packages)).toBe('report')
  })

  it('refuses globs that overlap on an existing file, naming the file', () => {
    const plan = validateConduct({
      mode: 'partitioned', reason: 'r',
      packages: [pkg({ ownedPaths: ['src/**'] }), pkg({ key: 'config', requirementKeys: ['R2', 'R3'], ownedPaths: ['src/config.py'] })],
    }, context)
    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.error).toContain('src/config.py')
  })

  it('refuses overlap on a declared new path but not on an undeclared one', () => {
    const overlapNew = validateConduct({
      mode: 'partitioned', reason: 'r',
      packages: [
        pkg({ ownedPaths: ['src/new/**'], newPaths: ['src/new/a.py'] }),
        pkg({ key: 'b', requirementKeys: ['R2', 'R3'], ownedPaths: ['src/new/*.py'] }),
      ],
    }, context)
    expect(overlapNew.ok).toBe(false)
    const overlapUndeclared = validateConduct({
      mode: 'partitioned', reason: 'r',
      packages: [pkg({ ownedPaths: ['src/new/**'] }), pkg({ key: 'b', requirementKeys: ['R2', 'R3'], ownedPaths: ['src/new/*.py'] })],
    }, context)
    expect(overlapUndeclared.ok).toBe(true)
  })

  it('refuses a missing or doubled requirement, an unknown persona, one package, a cycle, a bad glob', () => {
    const two = (a: Record<string, unknown>, b: Record<string, unknown>): unknown => ({ mode: 'partitioned', reason: 'r', packages: [pkg(a), pkg({ key: 'b', ownedPaths: ['README.md'], ...b })] })
    expect(validateConduct(two({}, { requirementKeys: ['R2'] }), context).ok).toBe(false) // R3 missing
    expect(validateConduct(two({}, { requirementKeys: ['R1', 'R2', 'R3'] }), context).ok).toBe(false) // R1 twice
    expect(validateConduct(two({ templateId: 'nope' }, { requirementKeys: ['R2', 'R3'] }), context).ok).toBe(false)
    expect(validateConduct({ mode: 'partitioned', reason: 'r', packages: [pkg({ requirementKeys: ['R1', 'R2', 'R3'] })] }, context).ok).toBe(false)
    expect(validateConduct(two({ dependsOn: ['b'] }, { requirementKeys: ['R2', 'R3'], dependsOn: ['report'] }), context).ok).toBe(false)
    expect(validateConduct(two({ ownedPaths: ['../x'] }, { requirementKeys: ['R2', 'R3'] }), context).ok).toBe(false)
  })

  it('refuses a new path its own package does not own', () => {
    const plan = validateConduct({
      mode: 'partitioned', reason: 'r',
      packages: [pkg({ newPaths: ['lib/x.py'] }), pkg({ key: 'b', requirementKeys: ['R2', 'R3'], ownedPaths: ['README.md'] })],
    }, context)
    expect(!plan.ok && plan.error).toContain('lib/x.py')
  })

  it('makes a conductor-named integration package depend on all others', () => {
    const plan = validateConduct({
      mode: 'partitioned', reason: 'r',
      packages: [pkg({}), pkg({ key: INTEGRATION_PACKAGE_KEY, requirementKeys: ['R2', 'R3'], ownedPaths: ['src/cli.py'] })],
    }, context)
    expect(plan.ok && plan.value.packages.find((p) => p.isIntegration)?.dependsOn).toEqual(['report'])
  })

  /** Final review I4: integration is rewritten to depend on every other package, so a package that
   *  depends on it would make a cycle neither task could start from. */
  it('refuses a package that depends on the integration package, and never returns a cyclic plan', () => {
    const plan = validateConduct({
      mode: 'partitioned', reason: 'r',
      packages: [
        pkg({ dependsOn: [INTEGRATION_PACKAGE_KEY] }),
        pkg({ key: INTEGRATION_PACKAGE_KEY, requirementKeys: ['R2', 'R3'], ownedPaths: ['src/cli.py'] }),
      ],
    }, context)
    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.error).toContain(`package "report": dependsOn "${INTEGRATION_PACKAGE_KEY}" is not allowed`)
  })
})

describe('parseConductAnswer', () => {
  it('refuses text with no JSON object', () => {
    expect(parseConductAnswer('no json here')).toEqual({ ok: false, error: 'the answer carried no JSON object' })
  })

  it('refuses JSON present but without the conductAnswer key', () => {
    const parsed = parseConductAnswer('{"somethingElse": {"mode": "single"}}')
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.error).toContain(`"${CONDUCT_ANSWER_KEY}"`)
  })

  it('refuses JSON that does not parse', () => {
    expect(parseConductAnswer('{conductAnswer: {"mode": "single"}}')).toEqual({
      ok: false,
      error: 'the answer\'s JSON did not parse',
    })
  })

  it('reads the raw conductAnswer object on the happy path', () => {
    const inner = { mode: 'single', reason: 'fits one session', templateId: 't-backend' }
    const parsed = parseConductAnswer(`Here you go.\n${JSON.stringify({ [CONDUCT_ANSWER_KEY]: inner })}`)
    expect(parsed).toEqual({ ok: true, value: inner })
  })
})

describe('singlePlan', () => {
  it('is the fallback shape', () => {
    expect(singlePlan('t-docs', ['R1'], 'fallback').packages[0]).toEqual(
      expect.objectContaining({ key: 'main', ownedPaths: ['**'], templateId: 't-docs' }),
    )
  })
})

describe('conductPlanSchema', () => {
  it('reads a validated plan back unchanged, integration package and all', () => {
    const plan = validateConduct(
      { mode: 'partitioned', reason: 'split', packages: [pkg({}), pkg({ key: 'config', requirementKeys: ['R2', 'R3'], ownedPaths: ['src/config.py'] })] },
      context,
    )
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(conductPlanSchema.parse(JSON.parse(JSON.stringify(plan.value)))).toEqual(plan.value)
  })

  it('refuses a stored plan with no packages', () => {
    expect(conductPlanSchema.safeParse({ mode: 'single', reason: 'x', packages: [] }).success).toBe(false)
  })
})
