import { describe, expect, it } from 'vitest'
import {
  CONDUCT_ANSWER_KEY,
  conductPlanSchema,
  decisionTitleKey,
  ownerOf,
  parseConductAnswer,
  singlePlan,
  validateConduct,
  type ConductContext,
} from '../../src/conduct/packages.js'
import { INTEGRATION_PACKAGE_KEY, SKELETON_PACKAGE_KEY } from '../../src/conduct/constants.js'
import { RUN_REQUIREMENT_KEY } from '../../src/conduct/requirements.js'

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
    expect(integration).toEqual(expect.objectContaining({ isIntegration: true, dependsOn: [SKELETON_PACKAGE_KEY, 'report', 'config'], requirementKeys: [] }))
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
    expect(plan.ok && plan.value.packages.find((p) => p.isIntegration)?.dependsOn).toEqual([SKELETON_PACKAGE_KEY, 'report'])
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

const withRun: ConductContext = { ...context, requirementKeys: ['R1', 'R2', 'R3', RUN_REQUIREMENT_KEY] }
const partition = (packages: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): unknown =>
  ({ mode: 'partitioned', reason: 'r', packages, ...extra })
const twoPackages = [pkg({}), pkg({ key: 'config', requirementKeys: ['R2', 'R3'], ownedPaths: ['src/config.py'] })]

describe('validateConduct: the skeleton (spec S1)', () => {
  it('adds a skeleton first when none is named, and makes every other package depend on it', () => {
    const plan = validateConduct(partition(twoPackages), withRun)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.packages.map((p) => p.key)).toEqual([SKELETON_PACKAGE_KEY, 'report', 'config', 'integration'])
    const byKey = new Map(plan.value.packages.map((p) => [p.key, p] as const))
    expect(byKey.get(SKELETON_PACKAGE_KEY)).toEqual(expect.objectContaining({ requirementKeys: [], dependsOn: [], templateId: 't-backend', isIntegration: false }))
    expect(byKey.get(SKELETON_PACKAGE_KEY)?.ownedPaths).toEqual(expect.arrayContaining(['scripts/verify.sh', 'scripts/smoke.sh', 'scripts/verify.d/skeleton.sh', 'Dockerfile']))
    expect(byKey.get('report')?.dependsOn).toEqual([SKELETON_PACKAGE_KEY])
    expect(byKey.get('integration')?.dependsOn).toEqual([SKELETON_PACKAGE_KEY, 'report', 'config'])
  })

  it('keeps a skeleton the conductor named, with its persona, and still adds the gate scripts to it', () => {
    const plan = validateConduct(partition([pkg({ key: SKELETON_PACKAGE_KEY, requirementKeys: [], ownedPaths: ['src/cli.py'], templateId: 't-docs' }), ...twoPackages]), withRun)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const skeleton = plan.value.packages.find((p) => p.key === SKELETON_PACKAGE_KEY)
    expect(skeleton?.templateId).toBe('t-docs')
    expect(skeleton?.ownedPaths).toEqual(['src/cli.py', 'scripts/verify.sh', 'scripts/smoke.sh', 'scripts/verify.d/skeleton.sh'])
  })

  it('refuses a skeleton that depends on something', () => {
    const plan = validateConduct(partition([pkg({ key: SKELETON_PACKAGE_KEY, requirementKeys: [], ownedPaths: ['src/cli.py'], dependsOn: ['report'] }), ...twoPackages]), withRun)
    expect(!plan.ok && plan.error).toContain('package "skeleton" depends on nothing')
  })

  it('lets a package name the skeleton in dependsOn even when the validator adds it', () => {
    const plan = validateConduct(partition([pkg({ dependsOn: [SKELETON_PACKAGE_KEY] }), twoPackages[1] ?? {}]), withRun)
    expect(plan.ok && plan.value.packages.find((p) => p.key === 'report')?.dependsOn).toEqual([SKELETON_PACKAGE_KEY])
  })
})

describe('validateConduct: RUN belongs to integration (spec S6)', () => {
  it('gives RUN to the integration package and never asks the conductor to place it', () => {
    const plan = validateConduct(partition(twoPackages), withRun)
    expect(plan.ok && plan.value.packages.find((p) => p.isIntegration)?.requirementKeys).toEqual([RUN_REQUIREMENT_KEY])
  })
  it('refuses RUN in a package', () => {
    const plan = validateConduct(partition([pkg({ requirementKeys: ['R1', RUN_REQUIREMENT_KEY] }), twoPackages[1] ?? {}]), withRun)
    expect(!plan.ok && plan.error).toContain('requirement RUN is Slave\'s own and belongs to the integration package')
  })
  it('gives single mode every key, RUN included', () => {
    const plan = validateConduct({ mode: 'single', reason: 'fits', templateId: 't-backend' }, withRun)
    expect(plan.ok && plan.value.packages[0]?.requirementKeys).toEqual(['R1', 'R2', 'R3', RUN_REQUIREMENT_KEY])
  })
})

describe('validateConduct: manifests, verify.d and registrations (spec S2, S3)', () => {
  const repo: ConductContext = { ...withRun, repoFiles: [...context.repoFiles, 'backend/package.json', 'backend/src/app.ts'] }
  it('refuses a manifest split from its lockfile, naming the pair', () => {
    const plan = validateConduct(partition([
      pkg({ ownedPaths: ['backend/package.json', 'src/report/**'] }),
      pkg({ key: 'config', requirementKeys: ['R2', 'R3'], ownedPaths: ['backend/package-lock.json', 'src/config.py'] }),
    ]), repo)
    expect(!plan.ok && plan.error).toContain('backend/package.json, backend/package-lock.json')
  })
  it('refuses a manifest and its lockfile named outright by two packages, though neither exists (ruling F4)', () => {
    const plan = validateConduct(partition([
      pkg({ ownedPaths: ['backend/package.json', 'src/report/**'] }),
      pkg({ key: 'config', requirementKeys: ['R2', 'R3'], ownedPaths: ['backend/package-lock.json', 'src/config.py'] }),
    ]), withRun)
    expect(!plan.ok && plan.error).toContain('package "report" owns backend/package.json, but backend/package.json, backend/package-lock.json')
    expect(!plan.ok && plan.error).toContain('package "config" owns backend/package-lock.json')
  })
  it('refuses a feature package whose glob covers a manifest', () => {
    const plan = validateConduct(partition([pkg({ ownedPaths: ['backend/**'] }), twoPackages[1] ?? {}]), repo)
    expect(!plan.ok && plan.error).toContain('package "report" owns backend/package.json')
  })
  it('accepts the manifest family in the skeleton', () => {
    const plan = validateConduct(partition([pkg({ ownedPaths: ['backend/src/**'] }), twoPackages[1] ?? {}]), repo)
    expect(plan.ok && plan.value.packages.find((p) => p.key === SKELETON_PACKAGE_KEY)?.ownedPaths).toEqual(
      expect.arrayContaining(['backend/package.json', 'backend/package-lock.json', 'backend/yarn.lock']),
    )
  })
  it('gives every package exactly its own verify.d check, and refuses a glob over another package\'s', () => {
    const ok = validateConduct(partition(twoPackages), withRun)
    expect(ok.ok && ok.value.packages.map((p) => p.ownedPaths.filter((g) => g.startsWith('scripts/verify.d/')))).toEqual([
      ['scripts/verify.d/skeleton.sh'], ['scripts/verify.d/report.sh'], ['scripts/verify.d/config.sh'], ['scripts/verify.d/integration.sh'],
    ])
    const refused = validateConduct(partition([pkg({ ownedPaths: ['src/report/**', 'scripts/**'] }), twoPackages[1] ?? {}]), withRun)
    expect(!refused.ok && refused.error).toContain('scripts/verify.d/config.sh')
    expect(!refused.ok && refused.error).toContain('scripts/smoke.sh, which belongs to the skeleton package')
  })
  it('turns registrations into owned prefix globs, and refuses a whole shared directory', () => {
    const accepted = validateConduct(partition([
      pkg({ registrations: [{ directory: 'db/migrations', prefix: '0100_report_' }] }),
      pkg({ key: 'config', requirementKeys: ['R2', 'R3'], ownedPaths: ['src/config.py'], registrations: [{ directory: 'db/migrations', prefix: '0200_config_' }] }),
    ]), withRun)
    expect(accepted.ok && accepted.value.packages.find((p) => p.key === 'report')?.ownedPaths).toContain('db/migrations/0100_report_*')
    expect(accepted.ok && accepted.value.packages.find((p) => p.key === 'report')?.registrations).toEqual([{ directory: 'db/migrations', prefix: '0100_report_' }])
    const refused = validateConduct(partition([
      pkg({ ownedPaths: ['src/report/**', 'db/migrations/**'] }),
      pkg({ key: 'config', requirementKeys: ['R2', 'R3'], ownedPaths: ['src/config.py'], registrations: [{ directory: 'db/migrations', prefix: '0200_config_' }] }),
    ]), withRun)
    expect(!refused.ok && refused.error).toContain('package "report" owns files in db/migrations that package "config" registers there')
  })
  it('accepts a package\'s own registration file among its new paths', () => {
    const plan = validateConduct(partition([
      pkg({ newPaths: ['db/m/01_a_init.sql'], registrations: [{ directory: 'db/m', prefix: '01_a_' }] }),
      twoPackages[1] ?? {},
    ]), withRun)
    expect(plan.ok).toBe(true)
  })
  it('refuses a stored plan whose registrations are malformed, rather than reading them as none', () => {
    const stored = { mode: 'single', reason: 'r', packages: [{ key: 'a', title: 'a', requirementKeys: [], ownedPaths: ['**'], newPaths: [], interface: '', dependsOn: [], isIntegration: false, templateId: 't', registrations: 'nope' }] }
    expect(conductPlanSchema.safeParse(stored).success).toBe(false)
  })
  it('reads a stored plan from before registrations existed', () => {
    const stored = { mode: 'partitioned', reason: 'r', packages: [{ key: 'a', title: 'a', requirementKeys: [], ownedPaths: ['a/**'], newPaths: [], interface: '', dependsOn: [], isIntegration: false, templateId: 't' }] }
    expect(conductPlanSchema.parse(stored).packages[0]?.registrations).toEqual([])
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

  it('reads every string without the NUL bytes and controls Postgres refuses (Task 6, ruling F8)', () => {
    const parsed = parseConductAnswer(JSON.stringify({ [CONDUCT_ANSWER_KEY]: { mode: 'single', reason: 'fits\u0000 one', decisions: [{ title: 'A\u0007PI', decision: 'x\u0000y' }] } }))
    expect(parsed).toEqual({ ok: true, value: { mode: 'single', reason: 'fits one', decisions: [{ title: 'API', decision: 'xy' }] } })
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

describe('shared decisions (spec C3)', () => {
  const partitioned = partition(twoPackages) as Record<string, unknown>
  const decisions = [{ title: 'API field naming', decision: 'camelCase JSON fields' }, { title: 'Where routes register', decision: 'one file per package under backend/src/routes/' }]

  it('keeps the conductor decisions on the plan, in both modes', () => {
    const single = validateConduct({ mode: 'single', reason: 'fits', templateId: 't-backend', decisions }, context)
    expect(single.ok && single.value.decisions).toEqual(decisions)
    const parted = validateConduct({ ...partitioned, decisions }, context)
    expect(parted.ok && parted.value.decisions).toEqual(decisions)
  })

  it('reads an answer without decisions, and a stored plan from before them, as none (spec 4)', () => {
    const plan = validateConduct(partitioned, context)
    expect(plan.ok && plan.value.decisions).toEqual([])
    const stored = conductPlanSchema.parse({ mode: 'single', reason: 'r', packages: [{ key: 'main', title: 'M', requirementKeys: [], ownedPaths: ['**'], newPaths: [], interface: '', dependsOn: [], isIntegration: false, templateId: 't' }] })
    expect(stored.decisions).toEqual([])
  })

  it('refuses a sixteenth decision, a title over 80, a decision over 600, and two titles that differ only by case', () => {
    const many = Array.from({ length: 16 }, (_, i) => ({ title: `t${String(i)}`, decision: 'd' }))
    expect(validateConduct({ ...partitioned, decisions: many }, context).ok).toBe(false)
    expect(validateConduct({ ...partitioned, decisions: [{ title: 'x'.repeat(81), decision: 'd' }] }, context).ok).toBe(false)
    expect(validateConduct({ ...partitioned, decisions: [{ title: 'x', decision: 'd'.repeat(601) }] }, context).ok).toBe(false)
    const twice = validateConduct({ ...partitioned, decisions: [{ title: 'API naming', decision: 'a' }, { title: ' api  NAMING', decision: 'b' }] }, context)
    expect(!twice.ok && twice.error).toContain('decision titles must be unique: "api naming"')
  })

  it('folds a title to its key', () => {
    expect(decisionTitleKey('  API   Field Naming ')).toBe('api field naming')
  })
})
