import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { signalPause } from '../src/pause-signal.js'

describe('signalPause', () => {
  it('writes the reason to the pause flag path for claude_code, byte-identical to the pre-M12 direct write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slaveofai-signal-pause-'))
    const pauseFlagPath = join(dir, 'pause.flag')

    await signalPause('claude_code', { pauseFlagPath, pid: 4242 }, 'meren')

    expect(readFileSync(pauseFlagPath, 'utf8')).toBe('meren\n')
  })

  it('requires no adapter instance, constructor options, or prior registration -- any process can call it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slaveofai-signal-pause-'))
    const pauseFlagPath = join(dir, 'pause.flag')

    // A `pid` unrelated to any real process, and no `SlaveRuntimeAdapter` in sight -- proof this
    // is a pure, stateless dispatch on `kind` and the row's own persisted facts.
    await signalPause('claude_code', { pauseFlagPath, pid: null }, 'budget guardrail')

    expect(readFileSync(pauseFlagPath, 'utf8')).toBe('budget guardrail\n')
  })

  it('rejects a provider kind with no pause signal implemented yet', async () => {
    await expect(signalPause('cursor', { pauseFlagPath: '/tmp/does-not-matter', pid: null }, 'operator')).rejects.toThrow(
      /cursor/i,
    )
  })
})
