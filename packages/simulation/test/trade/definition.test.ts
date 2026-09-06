import { describe, expect, it } from 'vitest'
import { cloneDefinition, demoDefinition } from '../../src/trade/definition.js'

const roster = [{ slaveName: 'Sonia', departmentName: 'Sales' }, { slaveName: 'Pete', departmentName: 'Purchasing' }, { slaveName: 'Olga', departmentName: 'Operations' }, { slaveName: 'Fin', departmentName: 'Finance' }]

describe('cloneDefinition', () => {
  it('copies everything but policy and seed, and never aliases the source', () => {
    const source = demoDefinition({ policy: 'A', seed: 3, roster, currency: 'USD' })
    const clone = cloneDefinition(source, { policy: 'B', seed: 9 })
    expect(clone.policy).toBe('B')
    expect(clone.seed).toBe(9)
    const strip = (d: typeof source) => ({ ...d, policy: undefined, seed: undefined })
    expect(strip(clone)).toEqual(strip(source))
    expect(clone.roles).not.toBe(source.roles)
    expect(clone.scenario).not.toBe(source.scenario)
  })
})
