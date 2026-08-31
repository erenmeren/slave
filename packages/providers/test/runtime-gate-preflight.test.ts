import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runGateScript } from '../src/runtime/gate-preflight.js'

function hookWith(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'))
  const hookPath = join(dir, 'hook.sh')
  writeFileSync(hookPath, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(hookPath, 0o755)
  return hookPath
}

describe('runGateScript (characterization)', () => {
  it('returns the hook stdout and exit code verbatim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-flag-'))
    const result = await runGateScript({
      hookPath: hookWith('echo -n hello'),
      flagPath: join(dir, 'pause.flag'),
      flagPresent: false,
    })
    expect(result.stdout).toBe('hello')
    expect(result.exitCode).toBe(0)
  })

  it('reports a nonzero exit code without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-flag-'))
    const result = await runGateScript({
      hookPath: hookWith('exit 2'),
      flagPath: join(dir, 'pause.flag'),
      flagPresent: false,
    })
    expect(result.exitCode).toBe(2)
  })

  it('closes the hook stdin -- a stdin-draining hook terminates instead of hanging (gate-preflight.ts:59)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-flag-'))
    const result = await runGateScript({
      hookPath: hookWith('cat > /dev/null; echo -n drained'),
      flagPath: join(dir, 'pause.flag'),
      flagPresent: false,
    })
    expect(result.stdout).toBe('drained')
    expect(result.exitCode).toBe(0)
  }, 10_000)

  it('writes the flag file first when flagPresent is true, and the child sees it via AITEAMOS_PAUSE_FLAG (gate-preflight.ts:25-33)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-flag-'))
    const flagPath = join(dir, 'pause.flag')
    const result = await runGateScript({
      hookPath: hookWith('[ -f "$AITEAMOS_PAUSE_FLAG" ] && echo -n present || echo -n absent'),
      flagPath,
      flagPresent: true,
    })
    expect(result.stdout).toBe('present')
    expect(existsSync(flagPath)).toBe(true)
  })

  it('removes the flag file first when flagPresent is false, even if it already exists (gate-preflight.ts:27-28)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-flag-'))
    const flagPath = join(dir, 'pause.flag')
    writeFileSync(flagPath, '')
    const result = await runGateScript({
      hookPath: hookWith('[ -f "$AITEAMOS_PAUSE_FLAG" ] && echo -n present || echo -n absent'),
      flagPath,
      flagPresent: false,
    })
    expect(result.stdout).toBe('absent')
    expect(existsSync(flagPath)).toBe(false)
  })
})
