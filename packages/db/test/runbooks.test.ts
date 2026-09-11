import { describe, expect, it } from 'vitest'
import { parseRunbookStages, stageOrder } from '@slave-of-ai/domain'
import { CAPABILITY_SEED } from '../src/capabilities.js'
import { RUNBOOK_SEED } from '../src/runbooks.js'

describe('RUNBOOK_SEED', () => {
  it('is the three runbooks R3 names, keyed and sorted', () => {
    expect(RUNBOOK_SEED.map((runbook) => runbook.key)).toEqual(['bug-fix', 'feature-delivery', 'security-review'])
  })

  it('every stage list is valid and its order is the one the description promises', () => {
    for (const runbook of RUNBOOK_SEED) {
      const parsed = parseRunbookStages(runbook.stages)
      expect(parsed.ok, `${runbook.key}: ${parsed.ok ? '' : parsed.error}`).toBe(true)
    }
    const feature = RUNBOOK_SEED.find((runbook) => runbook.key === 'feature-delivery')
    expect(feature).toBeDefined()
    expect(stageOrder(feature?.stages ?? []).map((stage) => stage.key)).toEqual([
      'design',
      'implement',
      'verify',
      'review',
      'release',
    ])
  })

  it('names only capability keys the taxonomy actually has -- nothing matches on a key nobody defined', () => {
    const known = new Set(CAPABILITY_SEED.map((record) => record.key))
    for (const runbook of RUNBOOK_SEED) {
      for (const key of [...runbook.requiredCapabilities, ...runbook.optionalCapabilities, ...runbook.stages.flatMap((s) => s.capabilities)]) {
        expect(known.has(key), `${runbook.key} asks for ${key}`).toBe(true)
      }
    }
  })

  // Fix round 1, Minor 6: the brief promised a `RunbookDraft`-shaped seed, and these two fields are
  // what make the shape whole -- so `seed.ts` and `syncRunbooks()` spread a row rather than
  // re-stating what every row already says about itself.
  it('is RunbookDraft-shaped: every row says it is a seed row, from no template', () => {
    for (const runbook of RUNBOOK_SEED) {
      expect(runbook.source).toBe('seed')
      expect(runbook.sourceTemplateId).toBeNull()
    }
  })

  it('ships NO gates: a gate is a workspace command, and the seed cannot know one', () => {
    for (const runbook of RUNBOOK_SEED) {
      for (const stage of runbook.stages) expect(stage.gates).toEqual([])
    }
  })

  it('puts a retry and an escalation on every verify stage', () => {
    for (const runbook of RUNBOOK_SEED) {
      const verify = runbook.stages.find((stage) => stage.key === 'verify')
      if (verify === undefined) continue
      expect(verify.retry).not.toBeNull()
      expect(verify.escalation).not.toBeNull()
    }
  })
})
