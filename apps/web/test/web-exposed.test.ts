import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')
const SCRIPT = resolve(REPO_ROOT, 'scripts/web-exposed.mjs')

/** Every temp dir `writeStub` made, removed once the file is done rather than left in $TMPDIR. */
const stubDirs: string[] = []

afterAll(() => {
  for (const dir of stubDirs) rmSync(dir, { recursive: true, force: true })
})

/** A stand-in for next's bin: prints its argv as JSON, then exits with STUB_EXIT, or waits for
 *  SIGTERM when STUB_WAIT=1 (exiting 0 on it). The real next must never start on 0.0.0.0 here. */
function writeStub(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-web-exposed-'))
  stubDirs.push(dir)
  const path = join(dir, 'fake-next.mjs')
  writeFileSync(
    path,
    [
      "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n')",
      "if (process.env.STUB_WAIT === '1') { process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000) }",
      'else process.exit(Number(process.env.STUB_EXIT ?? 0))',
      '',
    ].join('\n'),
  )
  return path
}

/** An `undefined` value UNSETS the variable — a spread of `{ KEY: undefined }` onto `process.env`
 *  leaves the inherited value in place, which would hand the refusal rows the operator's own
 *  password. */
function run(
  env: Record<string, string | undefined>,
  onFirstStdout?: (child: ChildProcess) => void,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key]
    else childEnv[key] = value
  }
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [SCRIPT], { env: childEnv, cwd: REPO_ROOT })
    let stdout = ''
    let stderr = ''
    let sawStdout = false
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      // The stub has printed its argv, so it has already installed its SIGTERM handler -- the one
      // observable fact that replaces a wall-clock guess about when signalling is safe.
      if (!sawStdout) {
        sawStdout = true
        onFirstStdout?.(child)
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    // `close`, not `exit`: at `exit` the stdio pipes may still be open, so the stub's JSON line can
    // arrive after it and be lost from `stdout`.
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

describe('scripts/web-exposed.mjs (M21 D)', () => {
  it.each([[''], ['   '], [undefined]])(
    'refuses with exit 2 and runs nothing when the password is %j',
    async (password) => {
      const stub = writeStub()
      const result = await run({ AITEAMOS_PASSWORD: password, AITEAMOS_NEXT_BIN: stub })
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('web:exposed refused')
      expect(result.stdout).toBe('')
    },
  )

  it('passes exactly `dev apps/web -H 0.0.0.0` to the binary and forwards its exit code', async () => {
    const stub = writeStub()
    const result = await run({ AITEAMOS_PASSWORD: 'hunter2', AITEAMOS_NEXT_BIN: stub, STUB_EXIT: '7' })
    expect(JSON.parse(result.stdout.trim())).toEqual(['dev', 'apps/web', '-H', '0.0.0.0'])
    expect(result.code).toBe(7)
  })

  it('forwards SIGTERM to the child and exits with its code', async () => {
    const stub = writeStub()
    const result = await run({ AITEAMOS_PASSWORD: 'hunter2', AITEAMOS_NEXT_BIN: stub, STUB_WAIT: '1' }, (child) =>
      child.kill('SIGTERM'),
    )
    expect(JSON.parse(result.stdout.trim())).toEqual(['dev', 'apps/web', '-H', '0.0.0.0'])
    expect(result.code).toBe(0)
  })
})
