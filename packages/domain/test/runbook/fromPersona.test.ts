import { describe, expect, it } from 'vitest'
import { runbookFromProfileSpec } from '../../src/runbook/fromPersona.js'
import { RUNBOOK_KEY_PATTERN } from '../../src/runbook/spec.js'
import type { CapabilityRecord } from '../../src/capability/taxonomy.js'
import type { ProfileSpec } from '../../src/profile/spec.js'

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'security.application', label: 'Application security', domain: 'security', role: 'security', synonyms: [] },
]

const spec = (workflow: readonly string[]): ProfileSpec => ({
  identity: 'A reviewer',
  summary: 'Reads login paths',
  mission: 'Find the holes',
  runtimeRole: 'security',
  capabilities: ['Application security'],
  expertise: [],
  operatingPrinciples: [],
  constraints: [],
  workflow: [...workflow],
  deliverables: [],
  successCriteria: [],
  collaborationHints: [],
  recommendedSkills: [],
  body: '',
  source: { repository: 'catalog-m48', path: 'security/x.md', revision: null, license: null, importedAt: '2026-09-11T00:00:00.000Z', mappingQuality: 'full' },
})

describe('runbookFromProfileSpec', () => {
  it('turns each workflow line into a linear stage, keyed step-N, with the template capabilities', () => {
    const draft = runbookFromProfileSpec(
      spec(['Step 1: Read the request path', 'Step 2: Model the attacker', 'Step 3: Write the findings']),
      { id: 'tpl-1', name: 'Gate Threat Reviewer', capabilityKeys: ['security.application'] },
      TAXONOMY,
    )
    expect(draft).not.toBeNull()
    if (draft === null) return
    expect(draft.key).toBe('persona-gate-threat-reviewer')
    expect(draft.name).toBe('Gate Threat Reviewer workflow')
    expect(draft.source).toBe('persona')
    expect(draft.sourceTemplateId).toBe('tpl-1')
    expect(draft.keywords).toEqual(['Application security'])
    expect(draft.requiredCapabilities).toEqual(['security.application'])
    expect(draft.stages.map((stage) => stage.key)).toEqual(['step-1', 'step-2', 'step-3'])
    expect(draft.stages.map((stage) => stage.dependsOn)).toEqual([[], ['step-1'], ['step-2']])
    expect(draft.stages[0]?.title).toBe('Step 1: Read the request path')
    expect(draft.stages[0]?.capabilities).toEqual(['security.application'])
    expect(draft.stages[0]?.gates).toEqual([])
    expect(draft.stages[0]?.retry).toBeNull()
  })

  it('is null for a persona with fewer than two workflow lines: one step is not a process', () => {
    expect(runbookFromProfileSpec(spec([]), { id: 't', name: 'X', capabilityKeys: [] }, TAXONOMY)).toBeNull()
    expect(runbookFromProfileSpec(spec(['Step 1: do it']), { id: 't', name: 'X', capabilityKeys: [] }, TAXONOMY)).toBeNull()
  })

  // Fix round 1, Minor 2: `String.prototype.slice` cuts UTF-16 CODE UNITS, so a title trimmed in
  // the middle of a surrogate pair left a lone surrogate -- which Postgres's jsonb rejects outright
  // (`unsupported Unicode escape sequence`), turning a long persona bullet into a failed import.
  it('trims a long title by code point, so a cut through an emoji cannot leave a lone surrogate', () => {
    // 158 characters, then the rocket: `slice(0, TITLE_MAX - 1)` cuts at index 159, which is exactly
    // between the rocket's high and low surrogate.
    const line = `${'a'.repeat(158)}🚀 and several more words after it`
    const draft = runbookFromProfileSpec(
      spec(['Step 1: ok', line]),
      { id: 't', name: 'X', capabilityKeys: [] },
      TAXONOMY,
    )
    const title = draft?.stages[1]?.title ?? ''
    // Every code unit pairs up: no unpaired high (D800-DBFF) or low (DC00-DFFF) surrogate survives.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(title)).toBe(false)
    expect(title.endsWith('…')).toBe(true)
    expect([...title]).toHaveLength(160)
  })

  // Fix round 1, Minor 3: a name with no ASCII alphanumerics slugged to the empty string, so the
  // key was `persona-` -- which fails `RUNBOOK_KEY_PATTERN` AND is the same key for every such
  // persona, so the second import would collide on `RunbookTemplate.key`'s unique index.
  it('keys off the template id when the name slugs to nothing, and the key is always a slug', () => {
    const draft = runbookFromProfileSpec(
      spec(['Step 1: ok', 'Step 2: also ok']),
      { id: 'TPL-42a', name: '***', capabilityKeys: [] },
      TAXONOMY,
    )
    expect(draft?.key).toBe('persona-tpl-42a')
    expect(RUNBOOK_KEY_PATTERN.test(draft?.key ?? '')).toBe(true)
  })

  it('does the same for a name with no Latin letters at all', () => {
    const draft = runbookFromProfileSpec(
      spec(['Step 1: ok', 'Step 2: also ok']),
      { id: 'tpl-9', name: 'Проверка безопасности', capabilityKeys: [] },
      TAXONOMY,
    )
    expect(draft?.key).toBe('persona-tpl-9')
    expect(RUNBOOK_KEY_PATTERN.test(draft?.key ?? '')).toBe(true)
  })

  it('caps the stages at the runbook maximum rather than refusing a long persona', () => {
    const draft = runbookFromProfileSpec(
      spec(Array.from({ length: 20 }, (_, i) => `Step ${String(i + 1)}: something`)),
      { id: 't', name: 'X', capabilityKeys: [] },
      TAXONOMY,
    )
    expect(draft?.stages).toHaveLength(12)
  })
})
