import { describe, expect, it } from 'vitest'
import { renderCatalogue, renderRepositoryMap, topLevelSymbols } from '../../src/conduct/repoMap.js'

describe('topLevelSymbols', () => {
  it('reads TS/JS exports, Python defs and classes, Go funcs and types, Rust pub items', () => {
    expect(topLevelSymbols('a.ts', 'export async function run() {}\nexport const X = 1\nfunction hidden() {}')).toEqual(['run', 'X'])
    expect(topLevelSymbols('a.py', 'def main():\n  pass\nclass Report:\n  def inner(self): pass')).toEqual(['main', 'Report'])
    expect(topLevelSymbols('a.go', 'func (s *S) Serve() {}\ntype Config struct{}')).toEqual(['Serve', 'Config'])
    expect(topLevelSymbols('a.rs', 'pub fn parse() {}\npub struct Row;')).toEqual(['parse', 'Row'])
    expect(topLevelSymbols('a.md', '# title')).toEqual([])
  })
})

describe('renderRepositoryMap', () => {
  const entries = [
    { path: 'src/cli.py', bytes: 1200, symbols: ['main'] },
    { path: 'src/report.py', bytes: 800, symbols: ['render', 'Row'] },
  ]
  it('lists path, size and symbols', () => {
    expect(renderRepositoryMap(entries, 2, 10_000)).toBe('src/cli.py (1200 B): main\nsrc/report.py (800 B): render, Row')
  })
  it('stays under the budget and says how many files it left out', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ path: `src/f${i}.py`, bytes: 10, symbols: ['a', 'b'] }))
    const text = renderRepositoryMap(many, 900, 2_000)
    expect(text.length).toBeLessThanOrEqual(2_000)
    expect(text).toMatch(/… \d+ more files not listed/u)
  })
})

describe('renderCatalogue', () => {
  it('writes one line per template and stops at the budget', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ templateId: `t${i}`, name: `N${i}`, division: 'eng', capabilities: ['backend'] }))
    const text = renderCatalogue(lines, 300)
    expect(text.split('\n')[0]).toBe('t0 | N0 | eng | backend')
    expect(text.length).toBeLessThanOrEqual(300)
  })
})
