import { describe, expect, it } from 'vitest'
import { isOwned, ownershipPatterns, ownershipRuleFor } from '../../src/conduct/ownership.js'

const report = { key: 'report', ownedPaths: ['src/report/**'], isIntegration: false }
const config = { key: 'config', ownedPaths: ['src/config.py'], isIntegration: false }
const integration = { key: 'integration', ownedPaths: [], isIntegration: true }
const all = [report, config, integration]

describe('ownershipRuleFor', () => {
  it('gives a package its own globs', () => {
    const rule = ownershipRuleFor(report, all)
    expect(rule).toEqual({ owned: ['src/report/**'], excluded: [] })
    expect(rule !== null && isOwned(rule, 'src/report/csv.py')).toBe(true)
    expect(rule !== null && isOwned(rule, 'src/config.py')).toBe(false)
  })

  it('gives integration everything no other package owns', () => {
    const rule = ownershipRuleFor(integration, all)
    expect(rule).toEqual({ owned: null, excluded: ['src/report/**', 'src/config.py'] })
    expect(rule !== null && isOwned(rule, 'src/cli.py')).toBe(true)
    expect(rule !== null && isOwned(rule, 'README.md')).toBe(true)
    expect(rule !== null && isOwned(rule, 'src/report/table.py')).toBe(false)
  })

  it('does not govern a package that owns **', () => {
    expect(ownershipRuleFor({ key: 'main', ownedPaths: ['**'], isIntegration: false }, [])).toBeNull()
  })
})

describe('ownershipPatterns', () => {
  it('carries regex sources the gate can rebuild, with the same verdicts', () => {
    const rule = ownershipRuleFor(integration, all)
    if (rule === null) throw new Error('governed')
    const patterns = ownershipPatterns(rule)
    expect(patterns.owned).toBeNull()
    const excluded = patterns.excluded.map((source) => new RegExp(source, 'u'))
    expect(excluded.some((r) => r.test('src/report/table.py'))).toBe(true)
    expect(excluded.some((r) => r.test('src/cli.py'))).toBe(false)
  })
})
