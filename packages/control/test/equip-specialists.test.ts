import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type BundleConfig, planBundles } from '../../../scripts/equip-specialists.mjs'

const config: BundleConfig = {
  bundles: { base: ['plugin:superpowers/test-driven-development'], py: ['library:wshobson/python-type-safety', 'plugin:superpowers/test-driven-development'] },
  divisions: { engineering: ['base'] },
  personas: { 'Data Engineer': ['py'] },
}

describe('planBundles', () => {
  it('gives a persona its division bundles plus its own, each skill once', () => {
    const { plan, problems } = planBundles(config, [
      { name: 'Data Engineer', sourceDivision: 'engineering' },
      { name: 'Brand Guardian', sourceDivision: 'design' },
    ])
    expect(problems).toEqual([])
    expect(plan).toHaveLength(1)
    expect(plan[0]?.bundles).toEqual(['base', 'py'])
    expect(plan[0]?.refs).toEqual(['plugin:superpowers/test-driven-development', 'library:wshobson/python-type-safety'])
  })

  it('refuses a persona that is not in the catalog and a bundle nobody defined', () => {
    const { problems } = planBundles(
      { ...config, personas: { 'Data Enginer': ['py'] }, divisions: { engineering: ['bse'] } },
      [{ name: 'Data Engineer', sourceDivision: 'engineering' }],
    )
    expect(problems).toContain('persona "Data Enginer" is not in the catalog')
    expect(problems).toContain('division "engineering" names unknown bundle "bse"')
  })
})

describe('scripts/skill-bundles.json', () => {
  const real = JSON.parse(readFileSync(join(import.meta.dirname, '../../../scripts/skill-bundles.json'), 'utf8')) as BundleConfig

  it('names only bundles it defines, and every skill as <provider>/<name>', () => {
    const personas = Object.keys(real.personas).map((name) => ({ name, sourceDivision: null }))
    expect(planBundles(real, personas).problems).toEqual([])
    for (const ref of Object.values(real.bundles).flat()) expect(ref).toMatch(/^(personal|project|plugin:[\w.-]+|library:[\w.-]+)\/[\w.-]+$/)
  })
})
