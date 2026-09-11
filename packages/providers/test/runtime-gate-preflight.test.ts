import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { preflightTap, runGateScript } from '../src/runtime/gate-preflight.js'

const createdDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true })
  createdDirs.length = 0
})

function hookWith(body: string): string {
  const dir = tempDir('gate-')
  const hookPath = join(dir, 'hook.sh')
  writeFileSync(hookPath, `#!/usr/bin/env bash\n${body}\n`)
  chmodSync(hookPath, 0o755)
  return hookPath
}

describe('runGateScript (characterization)', () => {
  it('returns the hook stdout and exit code verbatim', async () => {
    const dir = tempDir('gate-flag-')
    const result = await runGateScript({
      hookPath: hookWith('echo -n hello'),
      flagPath: join(dir, 'pause.flag'),
      flagPresent: false,
    })
    expect(result.stdout).toBe('hello')
    expect(result.exitCode).toBe(0)
  })

  it('reports a nonzero exit code without throwing', async () => {
    const dir = tempDir('gate-flag-')
    const result = await runGateScript({
      hookPath: hookWith('exit 2'),
      flagPath: join(dir, 'pause.flag'),
      flagPresent: false,
    })
    expect(result.exitCode).toBe(2)
  })

  it('closes the hook stdin -- a stdin-draining hook terminates instead of hanging (gate-preflight.ts:59)', async () => {
    const dir = tempDir('gate-flag-')
    const result = await runGateScript({
      hookPath: hookWith('cat > /dev/null; echo -n drained'),
      flagPath: join(dir, 'pause.flag'),
      flagPresent: false,
    })
    expect(result.stdout).toBe('drained')
    expect(result.exitCode).toBe(0)
  }, 10_000)

  it('writes the flag file first when flagPresent is true, and the child sees it via SLAVEOFAI_PAUSE_FLAG (gate-preflight.ts:25-33)', async () => {
    const dir = tempDir('gate-flag-')
    const flagPath = join(dir, 'pause.flag')
    const result = await runGateScript({
      hookPath: hookWith('[ -f "$SLAVEOFAI_PAUSE_FLAG" ] && echo -n present || echo -n absent'),
      flagPath,
      flagPresent: true,
    })
    expect(result.stdout).toBe('present')
    expect(existsSync(flagPath)).toBe(true)
  })

  it('removes the flag file first when flagPresent is false, even if it already exists (gate-preflight.ts:27-28)', async () => {
    const dir = tempDir('gate-flag-')
    const flagPath = join(dir, 'pause.flag')
    writeFileSync(flagPath, '')
    const result = await runGateScript({
      hookPath: hookWith('[ -f "$SLAVEOFAI_PAUSE_FLAG" ] && echo -n present || echo -n absent'),
      flagPath,
      flagPresent: false,
    })
    expect(result.stdout).toBe('absent')
    expect(existsSync(flagPath)).toBe(false)
  })
})

describe('preflightTap (M51 R6, plan erratum E11)', () => {
  const REAL_TAP = join(fileURLToPath(new URL('../../../', import.meta.url)), 'scripts/tool-result-tap.sh')

  const chatty = (): string =>
    hookWith('cat > /dev/null\nprintf \'{"ok":true}\\n\'\nprintf \'%s\\n\' \'{"toolUseId":"preflight","toolName":"Preflight","outcome":"ok","errorClass":null}\' >> "$SLAVEOFAI_TOOL_RESULTS"\nexit 0')

  const silent = (): string => hookWith('cat > /dev/null\nexit 0')

  it('passes for a tap that writes one line and says nothing', async () => {
    await expect(preflightTap({ tapPath: REAL_TAP })).resolves.toBeUndefined()
  })

  it('fails a tap that writes to stdout -- the CLI would read that as a hook response', async () => {
    await expect(preflightTap({ tapPath: chatty() })).rejects.toThrow(/stdout/u)
  })

  it('fails a tap that writes no line -- a tap that records nothing is not installed', async () => {
    await expect(preflightTap({ tapPath: silent() })).rejects.toThrow(/wrote no line/u)
  })

  it('fails a relative path before it spawns anything', async () => {
    await expect(preflightTap({ tapPath: './x.sh' })).rejects.toThrow(/absolute/u)
  })

  it('fails a tap that exits non-zero, even when it wrote its line', async () => {
    const angry = hookWith(
      'cat > /dev/null\nprintf \'%s\\n\' \'{"toolUseId":"preflight","toolName":"Preflight","outcome":"ok","errorClass":null}\' >> "$SLAVEOFAI_TOOL_RESULTS"\nexit 1',
    )
    await expect(preflightTap({ tapPath: angry })).rejects.toThrow(/exit/u)
  })

  it('leaves nothing behind -- it mints and removes its own directory', async () => {
    // `preflightGate`'s isolation discipline, for its reason: a caller-supplied path could point
    // at a live run's own results file by accident, so there is no such parameter to point.
    //
    // THIS call's directory, not a diff of the whole of `/tmp` (fix round 1, review Minor 6): the
    // adapter's own tests run `preflightTap` under the same prefix in a parallel worker, so a
    // before/after listing fails for a reason that has nothing to do with the code under test. The
    // stand-in tap below reports the path it was handed, which names the directory exactly.
    const dir = tempDir('gate-')
    const echoed = join(dir, 'preflight-path.txt')
    const reporting = hookWith(
      `cat > /dev/null\nprintf '%s\\n' "$SLAVEOFAI_TOOL_RESULTS" >> ${JSON.stringify(echoed)}\n` +
        `printf '%s\\n' '{"toolUseId":"preflight","toolName":"Preflight","outcome":"ok","errorClass":null}' >> "$SLAVEOFAI_TOOL_RESULTS"\nexit 0`,
    )
    await preflightTap({ tapPath: reporting })
    const resultsPath = readFileSync(echoed, 'utf8').trim()
    expect(resultsPath).not.toBe('')
    expect(existsSync(resultsPath)).toBe(false)
    expect(existsSync(dirname(resultsPath))).toBe(false)
  })
})
