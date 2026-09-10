import { describe, expect, it } from 'vitest'
import { normaliseCollaborationHint } from '../../src/capability/hints.js'
import type { CapabilityRecord } from '../../src/capability/taxonomy.js'

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: ['appsec'] },
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: [] },
]

const TEMPLATES = [
  { id: 'tpl-core', name: 'Gate Platform Builder' },
  { id: 'tpl-sec', name: 'Gate Security Reviewer' },
]

describe('normaliseCollaborationHint', () => {
  it('resolves the target by template name, case-insensitively, and keeps the sentence verbatim', () => {
    const hint = normaliseCollaborationHint(
      'Gate Platform Builder: consult them before you change an endpoint.',
      TEMPLATES,
      TAXONOMY,
    )
    expect(hint.text).toBe('Gate Platform Builder: consult them before you change an endpoint.')
    expect(hint.targetTemplateId).toBe('tpl-core')
  })

  it('finds the capability the sentence is about, by label or synonym', () => {
    expect(normaliseCollaborationHint('Pair with them on application security work.', TEMPLATES, TAXONOMY).capability)
      .toBe('security.application')
    expect(normaliseCollaborationHint('Hand off appsec findings.', TEMPLATES, TAXONOMY).capability)
      .toBe('security.application')
  })

  // The real corpus mostly names a ROLE, not a persona ("escalate to the billing attorney"), so
  // an unresolved hint is the ordinary case and must still be a hint.
  it('is still a hint when nothing resolves', () => {
    const hint = normaliseCollaborationHint('Escalate to the process owner immediately.', TEMPLATES, TAXONOMY)
    expect(hint).toEqual({
      text: 'Escalate to the process owner immediately.',
      targetTemplateId: null,
      capability: null,
    })
  })

  it('prefers the LONGEST matching name, so one title inside another cannot win', () => {
    const templates = [{ id: 'a', name: 'Gate Security Reviewer' }, { id: 'b', name: 'Security' }]
    expect(normaliseCollaborationHint('Consult the Gate Security Reviewer.', templates, TAXONOMY).targetTemplateId).toBe('a')
  })

  it('matches a whole phrase only, so "apidesigner" is not API design', () => {
    expect(normaliseCollaborationHint('Ask the apidesigner.', TEMPLATES, TAXONOMY).capability).toBeNull()
  })
})
