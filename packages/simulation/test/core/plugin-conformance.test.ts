import { describe, expect, it } from 'vitest'
import { replay, runUntil } from '../../src/core/engine.js'
import type { AnySectorPlugin } from '../../src/core/plugin.js'
import { sectorFor, sectors } from '../../src/core/registry.js'
import type { RoleDefinition } from '../../src/core/sector.js'

/** A four-slave roster with `role` set (M31b task 1 brief): enough for trade's four roles, and
 *  shaped the way a software roster would be too, so every sector in `sectors` can build a demo
 *  definition from the same fixture. */
const roster = [
  { slaveName: 'Sonia', departmentName: 'Sales', role: 'sales' },
  { slaveName: 'Pete', departmentName: 'Purchasing', role: 'purchasing' },
  { slaveName: 'Olga', departmentName: 'Operations', role: 'operations' },
  { slaveName: 'Fin', departmentName: 'Finance', role: 'finance' },
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
