import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../..')
const SCRIPT = resolve(REPO_ROOT, 'scripts/web-exposed.mjs')
const GOOD_SECRET = '0123456789abcdef0123456789abcdef'

/**
 * The two refusals that cost nothing to check (M23 spec §7 F1): a missing secret and a short one.
 * The script asks the database who exists ONLY after both of these pass, which is exactly what
 * keeps this file runnable without Postgres — the zero-users refusal and the pass-through cases
 * live in `test/integration/web-exposed.test.ts`, where a database is guaranteed.
 */

/** Every temp dir `writeStub` made, removed once the file is done rather than left in $TMPDIR. */
const stubDirs: string[] = []

afterAll(() => {
  for (const dir of stubDirs) rmSync(dir, { recursive: true, force: true })
})

/** A stand-in for next's bin: prints its argv as JSON. It must never be reached here — every case
 *  in this file is a refusal, and an empty stdout is how that is proven. */
function writeStub(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-web-exposed-'))
  stubDirs.push(dir)
  const path = join(dir, 'fake-next.mjs')
  writeFileSync(path, "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n')\n")
  return path
}

/** An `undefined` value UNSETS the variable — a spread of `{ KEY: undefined }` onto `process.env`
 *  leaves the inherited value in place, which would hand the refusal rows the operator's own
 *  secret. */
function run(env: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
    // `close`, not `exit`: at `exit` the stdio pipes may still be open, so the stub's JSON line can
    // arrive after it and be lost from `stdout`.
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

describe('scripts/web-exposed.mjs (M23 F1)', () => {
  it.each([[''], ['   '], [undefined]])(
    'refuses with exit 2 and runs nothing when the secret is %j',
    async (secret) => {
      const stub = writeStub()
      const result = await run({ AITEAMOS_SESSION_SECRET: secret, AITEAMOS_NEXT_BIN: stub })
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('web:exposed refused')
      expect(result.stderr).toContain('set AITEAMOS_SESSION_SECRET in .env first (openssl rand -hex 32)')
      expect(result.stdout).toBe('')
    },
  )

  it.each([['short'], ['0123456789abcdef0123456789abcde']])(
    'refuses a secret shorter than 32 characters (%j), naming the length rule',
    async (secret) => {
      const stub = writeStub()
      const result = await run({ AITEAMOS_SESSION_SECRET: secret, AITEAMOS_NEXT_BIN: stub })
      expect(result.code).toBe(2)
      expect(result.stderr).toContain('web:exposed refused: AITEAMOS_SESSION_SECRET is shorter than 32 characters')
      expect(result.stdout).toBe('')
    },
  )

  it('never echoes the secret it refused', async () => {
    const stub = writeStub()
    const result = await run({ AITEAMOS_SESSION_SECRET: 'sh0rt-but-secret', AITEAMOS_NEXT_BIN: stub })
    expect(result.stderr).not.toContain('sh0rt-but-secret')
  })

  it('does not resurrect password mode: the retired variable opens nothing', async () => {
    const stub = writeStub()
    const result = await run({ AITEAMOS_SESSION_SECRET: undefined, AITEAMOS_PASSWORD: GOOD_SECRET, AITEAMOS_NEXT_BIN: stub })
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
  })
})
