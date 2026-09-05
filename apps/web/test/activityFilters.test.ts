import { describe, expect, it } from 'vitest'
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '@slave-of-ai/db'
import {
  ACTIVITY_KINDS, EMPTY_ACTIVITY_FILTERS, TYPES_BY_KIND,
  eventMatchesFilters, filtersToQuery, parseActivityFilters,
  type ActivityFilters,
} from '../src/lib/activityFilters'

describe('TYPES_BY_KIND', () => {
  it('assigns every domain event type to exactly one kind', () => {
    const assigned = ACTIVITY_KINDS.flatMap((kind) => TYPES_BY_KIND[kind])
    const all = Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE)
    expect([...assigned].sort()).toEqual([...all].sort())
  })
})

describe('parseActivityFilters', () => {
  it('parses lists and expands kinds into the types union', () => {
    const result = parseActivityFilters(new URLSearchParams('slaves=a1,a2&kinds=guardrails&types=run.output'))
    if (!result.ok) throw new Error(result.error)
    expect(result.filters.slaves).toEqual(['a1', 'a2'])
    expect([...result.filters.types].sort()).toEqual(['guardrail.tripped', 'run.output'])
  })
  it('expands kinds=tool_calls to run.tool_call, run.output and run.tool_denied', () => {
    const result = parseActivityFilters(new URLSearchParams('kinds=tool_calls'))
    if (!result.ok) throw new Error(result.error)
    expect([...result.filters.types].sort()).toEqual(['run.output', 'run.tool_call', 'run.tool_denied'])
  })
  it('expands kinds=workspace to the created, goal, plan, company-assigned, settings-changed and org-changed event types', () => {
    const result = parseActivityFilters(new URLSearchParams('kinds=workspace'))
    if (!result.ok) throw new Error(result.error)
    expect([...result.filters.types].sort()).toEqual([
      'org.changed',
      'workspace.company_assigned',
      'workspace.created',
      'workspace.goal_set',
      'workspace.plan_created',
      'workspace.settings_changed',
    ])
  })
  it('returns EMPTY-shaped filters for no params', () => {
    const result = parseActivityFilters(new URLSearchParams())
    if (!result.ok) throw new Error(result.error)
    expect(result.filters).toEqual(EMPTY_ACTIVITY_FILTERS)
  })
  it('rejects an unknown kind and an unknown type', () => {
    expect(parseActivityFilters(new URLSearchParams('kinds=nonsense')).ok).toBe(false)
    expect(parseActivityFilters(new URLSearchParams('types=run.exploded')).ok).toBe(false)
  })
})

describe('filtersToQuery', () => {
  it('emits only non-empty dimensions, types as dotted names comma-joined', () => {
    const filters: ActivityFilters = { slaves: ['a1', 'a2'], tasks: [], types: ['run.output', 'run.tool_call'] }
    const query = filtersToQuery(filters)
    const params = new URLSearchParams(query)
    expect(params.get('slaves')).toBe('a1,a2')
    expect(params.has('tasks')).toBe(false)
    expect(params.get('types')).toBe('run.output,run.tool_call')
  })
  it('emits an empty string for EMPTY_ACTIVITY_FILTERS', () => {
    expect(filtersToQuery(EMPTY_ACTIVITY_FILTERS)).toBe('')
  })
  it('round-trips through parseActivityFilters', () => {
    const filters: ActivityFilters = { slaves: ['a1'], tasks: ['t1', 't2'], types: ['run.tool_call', 'guardrail.tripped'] }
    const result = parseActivityFilters(new URLSearchParams(filtersToQuery(filters)))
    if (!result.ok) throw new Error(result.error)
    expect(result.filters.slaves).toEqual(filters.slaves)
    expect(result.filters.tasks).toEqual(filters.tasks)
    expect([...result.filters.types].sort()).toEqual([...filters.types].sort())
  })
  it('is insensitive to the input order of each dimension — same set, same query', () => {
    const a: ActivityFilters = { slaves: ['a2', 'a1'], tasks: [], types: ['run.tool_call', 'guardrail.tripped'] }
    const b: ActivityFilters = { slaves: ['a1', 'a2'], tasks: [], types: ['guardrail.tripped', 'run.tool_call'] }
    expect(filtersToQuery(a)).toBe(filtersToQuery(b))
  })
})

describe('eventMatchesFilters', () => {
  const event = { slaveId: 'a1', taskId: 't1', type: 'run.tool_call' }
  it('matches everything on empty filters', () => {
    expect(eventMatchesFilters(event, EMPTY_ACTIVITY_FILTERS)).toBe(true)
  })
  it('ANDs across dimensions and ORs within one', () => {
    const f = { slaves: ['a1', 'a9'], tasks: [], types: ['run.tool_call' as const] }
    expect(eventMatchesFilters(event, f)).toBe(true)
    expect(eventMatchesFilters({ ...event, slaveId: 'a2' }, f)).toBe(false)
    expect(eventMatchesFilters({ ...event, type: 'run.output' }, f)).toBe(false)
  })
  it('a slave filter excludes events with no slaveId', () => {
    expect(eventMatchesFilters({ ...event, slaveId: null }, { slaves: ['a1'], tasks: [], types: [] })).toBe(false)
  })
})
