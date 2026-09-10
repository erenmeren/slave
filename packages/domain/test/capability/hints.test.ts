import { describe, expect, it } from 'vitest'
import { normaliseCollaborationHint } from '../../src/capability/hints.js'
import type { CapabilityRecord } from '../../src/capability/taxonomy.js'

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: ['appsec'] },
  { key: 'backend.api-design', label: 'API design', domain: 'backend', role: 'backend', synonyms: [] },
  { key: 'qa.test-automation', label: 'Test automation', domain: 'qa', role: 'qa', synonyms: [] },
  { key: 'mobile.ios', label: 'iOS', domain: 'mobile', role: 'mobile', synonyms: ['swift'] },
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

describe('normaliseCollaborationHint -- every occurrence, not just the first (fix round 1)', () => {
  // `pretest automation` contains `test automation` with no space before it. Testing only the
  // FIRST occurrence threw away the clean one later in the same sentence, which is how a real
  // handoff sentence lost its capability.
  it('finds a clean occurrence after a shadowed one', () => {
    const hint = normaliseCollaborationHint(
      'Run the pretest automation, then hand test automation to them.',
      TEMPLATES,
      TAXONOMY,
    )
    expect(hint.capability).toBe('qa.test-automation')
  })

  it('finds a template name after a shadowed occurrence of it', () => {
    const hint = normaliseCollaborationHint(
      'The xxGate Security Reviewer note: consult the Gate Security Reviewer.',
      TEMPLATES,
      TAXONOMY,
    )
    expect(hint.targetTemplateId).toBe('tpl-sec')
  })

  // MIN_SEARCHABLE is 3: whole-phrase boundary matching is what makes a three-character spelling
  // safe, and `css`, `etl`, `sca` and `iOS` are all real spellings in the shipped taxonomy.
  it('matches a three-character spelling', () => {
    expect(normaliseCollaborationHint('Ask the iOS specialist before shipping', TEMPLATES, TAXONOMY).capability)
      .toBe('mobile.ios')
  })
})
