import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { runShellCommand } from '../src/shell.js'

/**
 * `runShellCommand`'s own contract (skeleton plan B, F7). The smoke gate records the process group
 * leader it spawned, so a daemon that died mid-smoke can have its group killed by the next one.
 */
describe('runShellCommand', () => {
  it('reports the spawned process group leader to onSpawn', async (): Promise<void> => {
    let seen: number | null = null
    const outcome = await runShellCommand({ command: 'echo $$', cwd: tmpdir(), timeoutMs: 5000, onSpawn: (pid) => { seen = pid } })
    expect(seen).not.toBeNull()
    expect(outcome.output.trim()).toBe(String(seen))
  })
})
