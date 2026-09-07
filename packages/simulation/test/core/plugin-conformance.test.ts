import { describe, expect, it } from 'vitest'
import { replay, runUntil } from '../../src/core/engine.js'
import type { AnySectorPlugin } from '../../src/core/plugin.js'
import { sectorFor, sectors } from '../../src/core/registry.js'
import type { RoleDefinition } from '../../src/core/sector.js'

/** The catalog's "Checkout Platform" crew (`packages/db/src/checkout-platform.ts`, which the seed
 *  writes both the legacy workspace's slaves and a catalog company from), which is the roster a
 *  person actually creates a simulation from — and the one fixture BOTH sectors accept: nine
 *  slaves clears trade's "four slaves for four roles", and its departments and catalog roles fill
 *  software's product / lead / reviewer / engineers. Task 1's four-slave roster was enough only
 *  while trade was the only sector registered. */
const roster = [
  { slaveName: 'Atlas', departmentName: 'Management', role: 'manager' },
  { slaveName: 'Alex', departmentName: 'Engineering', role: 'Backend' },
  { slaveName: 'Emma', departmentName: 'Engineering', role: 'Frontend' },
  { slaveName: 'Daniel', departmentName: 'Engineering', role: 'DevOps' },
  { slaveName: 'Maya', departmentName: 'Engineering', role: 'QA' },
  { slaveName: 'Riley', departmentName: 'Engineering', role: 'reviewer' },
  { slaveName: 'Sarah', departmentName: 'Security', role: 'Security' },
  { slaveName: 'John', departmentName: 'Product', role: 'Business Analyst' },
  { slaveName: 'Oliver', departmentName: 'Marketing', role: 'SEO' },
]

/** Builds a value for one form field from its `kind`, so `externalEventForms` can be exercised
 *  against `externalEventSchema` without hand-writing a payload per sector: `int` and `money`
 *  fields take a small positive number (satisfies every trade field's own `.positive()` /
 *  `.nonnegative()`), `select` fields take the first id `injectOptions` offers for that field. */
function sampleValue(field: { readonly kind: 'int' | 'money' | 'select'; readonly optionsFrom?: string }, options: Readonly<Record<string, readonly { readonly id: string; readonly label: string }[]>>): unknown {
  if (field.kind === 'select') return options[field.optionsFrom ?? '']?.[0]?.id ?? ''
  return field.kind === 'money' ? 100 : 1
}

describe.each(Object.entries(sectors) as (readonly [string, AnySectorPlugin])[])('sector plugin conformance: %s', (name, plugin) => {
  it('is registered under its own name', () => {
    expect(plugin.name).toBe(name)
  })

  it('rosterFits agrees with demoDefinition on the same roster', () => {
    expect(plugin.rosterFits(roster)).toBe(true)
    expect(() => plugin.demoDefinition({ policy: 'A', seed: 1, roster, currency: 'USD' })).not.toThrow()
  })

  it('policyLabels names both policies, in prose of its own', () => {
    // Both keys, both non-empty: the drawers print these verbatim, so an empty string would be an
    // option a person cannot read rather than a caught error.
    expect(Object.keys(plugin.policyLabels).sort()).toEqual(['A', 'B'])
    expect(plugin.policyLabels.A.trim().length).toBeGreaterThan(0)
    expect(plugin.policyLabels.B.trim().length).toBeGreaterThan(0)
  })

  it('rosterFits is false and demoDefinition throws rosterRequirement on a short roster', () => {
    const short = roster.slice(0, 1)
    expect(plugin.rosterFits(short)).toBe(false)
    expect(() => plugin.demoDefinition({ policy: 'A', seed: 1, roster: short, currency: 'USD' })).toThrow(plugin.rosterRequirement)
  })

  it('initialState round-trips through stateSchema', () => {
    const definition = plugin.demoDefinition({ policy: 'A', seed: 1, roster, currency: 'USD' })
    const state = plugin.initialState(definition)
    const parsed = plugin.stateSchema.parse(state.sector)
    expect(parsed).toEqual(state.sector)
  })

  it('demoDefinition round-trips through definitionSchema', () => {
    const definition = plugin.demoDefinition({ policy: 'A', seed: 1, roster, currency: 'USD' })
    expect(plugin.definitionSchema.parse(definition)).toEqual(definition)
  })

  it('every actionDocs.type appears in some role\'s allowedActions', () => {
    const definition = plugin.demoDefinition({ policy: 'A', seed: 1, roster, currency: 'USD' })
    const allowed = new Set(definition.roles.flatMap((r: RoleDefinition) => r.allowedActions))
    for (const doc of plugin.actionDocs) expect(allowed.has(doc.type)).toBe(true)
  })

  it('every externalEventForms.type parses with externalEventSchema', () => {
    const definition = plugin.demoDefinition({ policy: 'A', seed: 1, roster, currency: 'USD' })
    const state = plugin.initialState(definition).sector
    const options = plugin.injectOptions(state)
    for (const form of plugin.externalEventForms) {
      const event: Record<string, unknown> = { type: form.type }
      for (const field of form.fields) event[field.name] = sampleValue(field, options)
      const parsed = plugin.externalEventSchema.safeParse(event)
      expect(parsed.success, parsed.success ? '' : JSON.stringify((parsed as { error: { issues: unknown } }).error.issues)).toBe(true)
    }
  })

  // `metricLabels`' keys are the labeled, headline-worthy subset of what `metrics(...)` returns
  // -- trade's `metrics` also carries `sources` and `minCashDay`, which the panel reads directly
  // rather than through a label. So the check is that every label has a real field behind it
  // (⊆), not that the two key sets are identical.
  it('every metricLabels key names a real field of metrics(...)', () => {
    const definition = plugin.demoDefinition({ policy: 'A', seed: 1, roster, currency: 'USD' })
    const state = plugin.initialState(definition).sector
    const keys = new Set(Object.keys(plugin.metrics([], state)))
    for (const key of Object.keys(plugin.metricLabels)) expect(keys.has(key)).toBe(true)
  })

  // M32 item 5: `comparedKeys` is the sector's own answer to "did these two runs live in the same
  // world" -- control used to keep a hand-made UNION of every sector's keys, which silently
  // compared nothing for a sector that did not carry one. A key that is not on the definition is
  // exactly that failure, and reads `undefined === undefined` on both sides forever.
  it('every comparedKeys entry is a real field of the demo definition, and neither is the policy', () => {
    const definition = plugin.demoDefinition({ policy: 'A', seed: 1, roster, currency: 'USD' }) as unknown as Record<string, unknown>
    expect(plugin.comparedKeys.length).toBeGreaterThan(0)
    for (const key of plugin.comparedKeys) expect(Object.keys(definition)).toContain(key)
    // `policy` and `seed` are absent by design (M30 §4): differing on them is the whole point of a
    // clone, so comparing them would report every A-vs-B comparison as a different world.
    expect(plugin.comparedKeys).not.toContain('policy')
    expect(plugin.comparedKeys).not.toContain('seed')
  })

  it('headline(state, day) reads back without throwing', () => {
    const definition = plugin.demoDefinition({ policy: 'A', seed: 1, roster, currency: 'USD' })
    const state = plugin.initialState(definition).sector
    const items = plugin.headline(state, 0)
    expect(items.length).toBeGreaterThan(0)
    for (const item of items) expect(typeof item.value).toBe('number')
  })

  it('llmRoleCandidates is a subset of roleOrder', () => {
    const definition = plugin.demoDefinition({ policy: 'A', seed: 1, roster, currency: 'USD' })
    const roleOrder = new Set(definition.roleOrder)
    for (const role of plugin.llmRoleCandidates) expect(roleOrder.has(role)).toBe(true)
  })

  it.each(['A', 'B'] as const)('policy %s runs the demo to the horizon and replays exactly', (policy) => {
    const definition = plugin.demoDefinition({ policy, seed: 1, roster, currency: 'USD' })
    const initial = plugin.initialState(definition)
    const provider = plugin.rulesProvider(definition)
    const result = runUntil(plugin.model, definition, initial, provider, definition.horizonDays, 1000)
    expect(result.state.status).toBe('finished')
    const replayed = replay(plugin.model, definition, initial, result.entries)
    expect(replayed).toEqual(result.state)
  })
})

describe('sectorFor', () => {
  it('finds every registered sector by name', () => {
    for (const name of Object.keys(sectors)) expect(sectorFor(name)).toBe((sectors as Record<string, AnySectorPlugin>)[name])
  })

  it('is undefined for an unregistered name', () => {
    expect(sectorFor('nonsense')).toBeUndefined()
  })

  it('is undefined for a prototype-pollution-shaped name', () => {
    expect(sectorFor('__proto__')).toBeUndefined()
  })
})
