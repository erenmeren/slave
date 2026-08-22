import { describe, expect, it } from 'vitest'
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '@ai-team-os/db'
import {
  ACTIVITY_KINDS, EMPTY_ACTIVITY_FILTERS, TYPES_BY_KIND,
  eventMatchesFilters, parseActivityFilters,
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
    const result = parseActivityFilters(new URLSearchParams('agents=a1,a2&kinds=guardrails&types=run.output'))
    if (!result.ok) throw new Error(result.error)
    expect(result.filters.agents).toEqual(['a1', 'a2'])
    expect([...result.filters.types].sort()).toEqual(['guardrail.tripped', 'run.output'])
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

describe('eventMatchesFilters', () => {
  const event = { agentId: 'a1', taskId: 't1', type: 'run.tool_call' }
  it('matches everything on empty filters', () => {
    expect(eventMatchesFilters(event, EMPTY_ACTIVITY_FILTERS)).toBe(true)
  })
  it('ANDs across dimensions and ORs within one', () => {
    const f = { agents: ['a1', 'a9'], tasks: [], types: ['run.tool_call' as const] }
    expect(eventMatchesFilters(event, f)).toBe(true)
    expect(eventMatchesFilters({ ...event, agentId: 'a2' }, f)).toBe(false)
    expect(eventMatchesFilters({ ...event, type: 'run.output' }, f)).toBe(false)
  })
  it('an agent filter excludes events with no agentId', () => {
    expect(eventMatchesFilters({ ...event, agentId: null }, { agents: ['a1'], tasks: [], types: [] })).toBe(false)
  })
})
