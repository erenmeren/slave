import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { isAlive, killWithEscalation } from '../../src/kill.js'

describe('killWithEscalation', () => {
  it('SIGKILLs a child that ignores SIGTERM', async (): Promise<void> => {
    const child = spawn('node', ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'])
    await new Promise((res) => child.once('spawn', res))
    const signalled = await killWithEscalation(child.pid ?? null, 300)
    expect(signalled).toBe(true)
    await new Promise((res) => setTimeout(res, 200))
    expect(isAlive(child.pid ?? null)).toBe(false)
  })

  it('reports false for a pid that is already gone', async (): Promise<void> => {
    expect(await killWithEscalation(null)).toBe(false)
  })
})
