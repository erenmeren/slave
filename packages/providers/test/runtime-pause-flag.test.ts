import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clearAndVerifyPauseFlagAbsent } from '../src/runtime/pause-flag.js'

const input = (flagPath: string) => ({ flagPath, runId: 'run-test', adapterName: 'test-adapter', gateNoun: 'gate' })

describe('clearAndVerifyPauseFlagAbsent (characterization)', () => {
  it('removes a present flag file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pause-flag-'))
    const flagPath = join(dir, 'pause.flag')
    writeFileSync(flagPath, 'reason')
    await clearAndVerifyPauseFlagAbsent(input(flagPath))
    expect(existsSync(flagPath)).toBe(false)
  })

  it('is a no-op when the flag is already absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pause-flag-'))
    await expect(clearAndVerifyPauseFlagAbsent(input(join(dir, 'pause.flag')))).resolves.toBeUndefined()
  })

  it('refuses a directory sitting at the flag path (the doc-comment case)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pause-flag-'))
    const flagPath = join(dir, 'pause.flag')
    mkdirSync(flagPath)
    await expect(clearAndVerifyPauseFlagAbsent(input(flagPath))).rejects.toThrow()
  })

  it('names the adapter, run id, and gate noun in the refusal message (pause-flag.ts:39-43)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pause-flag-'))
    const flagPath = join(dir, 'pause.flag')
    mkdirSync(flagPath)
    await expect(
      clearAndVerifyPauseFlagAbsent({
        flagPath,
        runId: 'run-42',
        adapterName: 'ClaudeCodeAdapter',
        gateNoun: 'hook',
      }),
    ).rejects.toThrow(/ClaudeCodeAdapter.*run-42.*hook deny/s)
  })
})
