import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')
const SCRIPT = resolve(REPO_ROOT, 'scripts/web-exposed.mjs')

/** A stand-in for next's bin: prints its argv as JSON, then exits with STUB_EXIT, or waits for
 *  SIGTERM when STUB_WAIT=1 (exiting 0 on it). The real next must never start on 0.0.0.0 here. */
function writeStub(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-web-exposed-'))
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
  signalAfterMs?: number,
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
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    if (signalAfterMs !== undefined) setTimeout(() => child.kill('SIGTERM'), signalAfterMs)
    child.on('exit', (code) => resolvePromise({ code, stdout, stderr }))
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
    const result = await run({ AITEAMOS_PASSWORD: 'hunter2', AITEAMOS_NEXT_BIN: stub, STUB_WAIT: '1' }, 300)
    expect(JSON.parse(result.stdout.trim())).toEqual(['dev', 'apps/web', '-H', '0.0.0.0'])
    expect(result.code).toBe(0)
  })
})
