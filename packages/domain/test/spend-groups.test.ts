import { describe, expect, it } from 'vitest'
import { sumSpend, sumSpendFromGroups, type SpendGroup, type SpendRow } from '../src/index.js'
import type { RunStatus } from '../src/index.js'

const STATUSES: readonly RunStatus[] = ['starting', 'working', 'pause_requested', 'paused', 'resuming', 'stopping', 'stopped', 'succeeded', 'failed']
const PROVIDERS = [null, 'claude_code'] as const
const COSTS = [null, 0, 1.25] as const

function groupRows(rows: readonly SpendRow[]): SpendGroup[] {
  const byKey = new Map<string, { provider: string | null; status: RunStatus; knownUsd: number; rowCount: number; measuredCount: number }>()
  for (const row of rows) {
    const key = `${row.provider ?? ' '}|${row.status}`
    const g = byKey.get(key) ?? { provider: row.provider, status: row.status, knownUsd: 0, rowCount: 0, measuredCount: 0 }
    g.rowCount += 1
    if (row.costUsd !== null) { g.knownUsd += row.costUsd; g.measuredCount += 1 }
    byKey.set(key, g)
  }
  return [...byKey.values()]
}

describe('sumSpendFromGroups ≡ sumSpend', () => {
  it('agrees with sumSpend over every provider × status × cost combination, duplicated', () => {
    const rows: SpendRow[] = []
    for (const provider of PROVIDERS) for (const status of STATUSES) for (const costUsd of COSTS) {
      rows.push({ provider, status, costUsd }, { provider, status, costUsd }) // ×2: rowCount > measuredCount cases
    }
    expect(sumSpendFromGroups(groupRows(rows))).toEqual(sumSpend(rows))
  })
  it('agrees on the empty set', () => {
    expect(sumSpendFromGroups([])).toEqual(sumSpend([]))
  })
})
