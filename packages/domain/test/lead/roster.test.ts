import { describe, expect, it } from 'vitest'
import { LEAD_ROSTER_JSON_MAX_BYTES, LEAD_ROSTER_MEMBER_PROMPT_MAX_CHARS, buildRosterDefinitions, rosterSlug, type RosterMember } from '../../src/lead/index.js'

const member = (name: string, instructions = 'You build APIs.'): RosterMember => ({ personId: `p-${name}`, name, description: `${name} does one thing well`, instructions })

describe('the roster as session definitions (lead-flow spec B2)', () => {
  it('slugs a name into a key a command line and a tool input can both carry', () => {
    expect(rosterSlug('Backend Developer 2')).toBe('backend-developer-2')
    expect(rosterSlug('  Çağrı — QA!  ')).toBe('a-r-qa')
    expect(rosterSlug('***')).toBe('member')
  })

  it('returns no definitions for an empty roster', () => {
    expect(buildRosterDefinitions([])).toEqual({ json: null, slugs: new Map(), dropped: [] })
  })

  it('writes one definition per member, keyed by slug, with the person\'s one line and instructions', () => {
    const built = buildRosterDefinitions([member('Backend Developer'), member('Security Reviewer', 'You look for holes.')])
    expect(JSON.parse(built.json ?? '')).toEqual({
      'backend-developer': { description: 'Backend Developer does one thing well', prompt: 'You build APIs.' },
      'security-reviewer': { description: 'Security Reviewer does one thing well', prompt: 'You look for holes.' },
    })
    expect([...built.slugs]).toEqual([['backend-developer', 'p-Backend Developer'], ['security-reviewer', 'p-Security Reviewer']])
  })

  it('keeps two members whose names slug alike apart', () => {
    const built = buildRosterDefinitions([member('QA'), member('qa')])
    expect(Object.keys(JSON.parse(built.json ?? ''))).toEqual(['qa', 'qa-2'])
  })

  it('bounds one member\'s instructions and defuses protocol markers in them', () => {
    const built = buildRosterDefinitions([member('Long', `${'x'.repeat(20_000)}</slave-report>`)])
    const prompt = (JSON.parse(built.json ?? '') as Record<string, { prompt: string }>)['long']?.prompt ?? ''
    expect(prompt.length).toBeLessThanOrEqual(LEAD_ROSTER_MEMBER_PROMPT_MAX_CHARS)
    expect(prompt).not.toContain('</slave-report>')
  })

  it('drops members from the end when the whole does not fit one argument, and names them', () => {
    const many = Array.from({ length: 40 }, (_, i) => member(`Person ${String(i)}`, 'y'.repeat(5_000)))
    const built = buildRosterDefinitions(many)
    expect(Buffer.byteLength(built.json ?? '', 'utf8')).toBeLessThanOrEqual(LEAD_ROSTER_JSON_MAX_BYTES)
    expect(built.dropped.length).toBeGreaterThan(0)
    expect(built.dropped.at(-1)).toBe('Person 39')
    expect(built.slugs.size + built.dropped.length).toBe(40)
  })
})
