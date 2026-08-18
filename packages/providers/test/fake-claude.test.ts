import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))
const FIXTURES_DIR = path.join(path.dirname(FAKE), 'fixtures')

type Line = { type: string; [key: string]: unknown }

function parseLines(stdout: string): Line[] {
  return stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Line)
}

describe('fake-claude', () => {
  it('replays a fixture as NDJSON on stdout', async (): Promise<void> => {
    const { stdout } = await run('node', [FAKE, '--fixture', 'complete'])
    const lines = parseLines(stdout)
    expect(lines[0]?.type).toBe('system')
    expect(lines.at(-1)?.type).toBe('system')
    const last = lines.at(-1) as Line
    expect(last.subtype).toBe('hook_response')
    expect(last.hook_event).toBe('Stop')
  })

  it('exits non-zero and truncates the stream in crash mode', async (): Promise<void> => {
    await expect(run('node', [FAKE, '--fixture', 'crash'])).rejects.toMatchObject({ code: 1 })
  })

  it('accepts the real CLI flags without choking', async (): Promise<void> => {
    const { stdout } = await run('node', [
      FAKE,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--settings',
      '/tmp/does-not-need-to-exist.json',
      '--include-hook-events',
      '-p',
      'do the thing',
      '--resume',
      'some-session-id',
      '--fixture',
      'complete',
    ])
    const lines = parseLines(stdout)
    expect(lines[0]?.type).toBe('system')
  })

  it('produces every mode named in the brief plus hook-crash, hook-fail-open, and env-echo', async (): Promise<void> => {
    for (const mode of ['complete', 'hook-deny', 'hook-crash', 'hook-fail-open', 'permission-denied', 'malformed']) {
      const { stdout } = await run('node', [FAKE, '--fixture', mode])
      expect(stdout.trim().split('\n').length).toBeGreaterThan(0)
    }
  })

  it('every fixture file ends with the routine Stop hook line', async (): Promise<void> => {
    const fs = await import('node:fs/promises')
    const files = (await fs.readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.ndjson'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const content = await fs.readFile(path.join(FIXTURES_DIR, file), 'utf8')
      const lines = content
        .trim()
        .split('\n')
        .map((l) => {
          try {
            return JSON.parse(l) as Line
          } catch {
            return null
          }
        })
        .filter((l): l is Line => l !== null)
      const last = lines.at(-1)
      expect(last?.type, `${file} must end with the routine Stop hook line`).toBe('system')
      expect(last?.subtype).toBe('hook_response')
      expect(last?.hook_event).toBe('Stop')
      expect(last?.exit_code).toBe(1)
      expect(last?.outcome).toBe('cancelled')
    }
  })

  it('hook-crash blocks the tool call: no PostToolUse fires for it', async (): Promise<void> => {
    const { stdout } = await run('node', [FAKE, '--fixture', 'hook-crash'])
    const lines = parseLines(stdout)
    const crashResponses = lines.filter(
      (l) => l.type === 'system' && l.subtype === 'hook_response' && l.hook_event === 'PreToolUse' && l.exit_code === 2,
    )
    expect(crashResponses.length).toBeGreaterThan(0)
    expect(stdout).not.toContain('PostToolUse')
  })

  it('hook-fail-open lets the tool proceed after the gate breaks', async (): Promise<void> => {
    const { stdout } = await run('node', [FAKE, '--fixture', 'hook-fail-open'])
    const lines = parseLines(stdout)
    const failedOpen = lines.filter(
      (l) =>
        l.type === 'system' &&
        l.subtype === 'hook_response' &&
        l.hook_event === 'PreToolUse' &&
        typeof l.exit_code === 'number' &&
        l.exit_code !== 0 &&
        l.exit_code !== 2,
    )
    expect(failedOpen.length).toBeGreaterThan(0)
    // The terminal result must show nothing was actually denied.
    const result = lines.find((l) => l.type === 'result') as
      | { permission_denials?: unknown[]; is_error?: boolean }
      | undefined
    expect(result?.is_error).toBe(false)
    expect(result?.permission_denials).toEqual([])
  })

  it('env-echo carries the child process environment in the terminal result', async (): Promise<void> => {
    const { stdout } = await run(
      'node',
      [FAKE, '--fixture', 'env-echo'],
      { env: { ...process.env, AITEAMOS_PROBE_VAR: 'probe-value' } },
    )
    const lines = parseLines(stdout)
    const result = lines.find((l) => l.type === 'result') as { env?: Record<string, string> } | undefined
    expect(result?.env?.AITEAMOS_PROBE_VAR).toBe('probe-value')
  })

  it('hang mode writes nothing and does not exit on its own', async (): Promise<void> => {
    const child = await import('node:child_process').then((m) => m.spawn('node', [FAKE, '--fixture', 'hang']))
    let sawExit = false
    child.on('exit', () => {
      sawExit = true
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(sawExit).toBe(false)
    child.kill('SIGKILL')
  })
})
