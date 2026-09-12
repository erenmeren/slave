import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]))
}

describe('the simulation never reaches a real tool (spec §8)', () => {
  it('packages/simulation imports only zod and itself, and never reaches for require/import()/node: (fix wave, Minor #13)', () => {
    const files = walk(new URL('../../simulation/src', import.meta.url).pathname).filter((f) => f.endsWith('.ts'))
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1] ?? '')
      for (const spec of imports) expect(spec === 'zod' || spec.startsWith('.'), `${file} imports ${spec}`).toBe(true)
      expect(source, `${file} contains require(`).not.toMatch(/require\(/)
      expect(source, `${file} contains import(`).not.toMatch(/import\(/)
      expect(source, `${file} contains 'node:'`).not.toContain('node:')
    }
  })
  it('control/simulation.ts and control/simulation/*.ts import no provider, spawn nothing and read no environment', () => {
    const simulationDir = new URL('../src/simulation/', import.meta.url).pathname
    const files = [new URL('../src/simulation.ts', import.meta.url).pathname, ...walk(simulationDir).filter((f) => f.endsWith('.ts'))]
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source, `${file} imports @slave-of-ai/providers`).not.toMatch(/@slave-of-ai\/providers/)
      expect(source, `${file} contains child_process/process.env/spawn(`).not.toMatch(/child_process|process\.env|spawn\(/)
      // M52 R6: the broker module by NAME, the way the case above names `@slave-of-ai/providers`.
      // A simulation reaches no real tool and therefore no real credential; the boundary is a source
      // scan rather than a convention because a convention is what a future refactor does not read.
      // `SLAVEOFAI_RUN_TOKEN` rather than `token`, which appears all over the simulation for model
      // usage.
      expect(source, `${file} mentions the broker or a credential`).not.toMatch(/broker|Credential|SLAVEOFAI_RUN_TOKEN/)
    }
  })
})
