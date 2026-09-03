import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * The half of `scripts/web-exposed.mjs` that needs Postgres (M23 spec §7 F1): the zero-users
 * refusal, and — because a run that reaches `next` must first satisfy the same check — the
 * pass-through rows M21 D wrote. The two cheap refusals stay in `apps/web/test/web-exposed.test.ts`,
 * which needs no database at all.
 *
 * `test-setup/require-database.ts` points `DATABASE_URL` at `TEST_DATABASE_URL`, and the spawned
 * script inherits it, so the count it runs is against the test database.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../../../..')
const SCRIPT = resolve(REPO_ROOT, 'scripts/web-exposed.mjs')
const SECRET = '0123456789abcdef0123456789abcdef'

const stubDirs: string[] = []

afterAll(async (): Promise<void> => {
  for (const dir of stubDirs) rmSync(dir, { recursive: true, force: true })
  await prisma.$disconnect()
})

/** A stand-in for next's bin: prints its argv as JSON, then exits with STUB_EXIT, or waits for
 *  SIGTERM when STUB_WAIT=1 (exiting 0 on it), or STUB_SELF_KILL=1 kills itself with SIGKILL
 *  right after printing. The real next must never start on 0.0.0.0 here. */
function writeStub(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aiteamos-web-exposed-db-'))
  stubDirs.push(dir)
  const path = join(dir, 'fake-next.mjs')
  writeFileSync(
    path,
    [
      "if (process.env.STUB_WAIT === '1') process.on('SIGTERM', () => process.exit(0))",
      "process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\\n')",
      "if (process.env.STUB_SELF_KILL === '1') process.kill(process.pid, 'SIGKILL')",
      "else if (process.env.STUB_WAIT === '1') setInterval(() => {}, 1000)",
      'else process.exit(Number(process.env.STUB_EXIT ?? 0))',
      '',
    ].join('\n'),
  )
  return path
}

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
      // The stub installs its SIGTERM handler before printing its argv, so the first stdout chunk
      // means the handler is already in place -- the one observable fact that replaces a
      // wall-clock guess about when signalling is safe.
      if (!sawStdout) {
        sawStdout = true
        onFirstStdout?.(child)
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }))
  })
}

async function seedUser(): Promise<void> {
  await prisma.user.create({
    data: { username: `exposed-${Math.random().toString(16).slice(2, 10)}`, passwordHash: 'pbkdf2-sha256$600000$00$00' },
  })
}

describe('scripts/web-exposed.mjs against the database (M23 F1)', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "User" RESTART IDENTITY CASCADE')
  })

  it('refuses with exit 2 when nobody has an account yet, and names the command that makes one', async () => {
    const stub = writeStub()
    const result = await run({ AITEAMOS_SESSION_SECRET: SECRET, AITEAMOS_NEXT_BIN: stub })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('web:exposed refused: no users yet: create one with npm run orchestrator -- create-user --name <you>')
    expect(result.stdout).toBe('')
  })

  it('passes exactly `dev apps/web -H 0.0.0.0` to the binary and forwards its exit code', async () => {
    await seedUser()
    const stub = writeStub()
    const result = await run({ AITEAMOS_SESSION_SECRET: SECRET, AITEAMOS_NEXT_BIN: stub, STUB_EXIT: '7' })
    expect(JSON.parse(result.stdout.trim())).toEqual(['dev', 'apps/web', '-H', '0.0.0.0'])
    expect(result.code).toBe(7)
  })

  it('forwards SIGTERM to the child and exits with its code', async () => {
    await seedUser()
    const stub = writeStub()
    const result = await run({ AITEAMOS_SESSION_SECRET: SECRET, AITEAMOS_NEXT_BIN: stub, STUB_WAIT: '1' }, (child) =>
      child.kill('SIGTERM'),
    )
    expect(JSON.parse(result.stdout.trim())).toEqual(['dev', 'apps/web', '-H', '0.0.0.0'])
    expect(result.code).toBe(0)
  })

  it('maps a signal death to 128 + the signal number (SIGKILL → 137)', async () => {
    await seedUser()
    const stub = writeStub()
    const result = await run({ AITEAMOS_SESSION_SECRET: SECRET, AITEAMOS_NEXT_BIN: stub, STUB_SELF_KILL: '1' })
    expect(JSON.parse(result.stdout.trim())).toEqual(['dev', 'apps/web', '-H', '0.0.0.0'])
    expect(result.code).toBe(137)
  })

  it('refuses, rather than starting, when the count itself cannot be run', async () => {
    await seedUser()
    const stub = writeStub()
    const result = await run({
      AITEAMOS_SESSION_SECRET: SECRET,
      AITEAMOS_NEXT_BIN: stub,
      DATABASE_URL: 'postgresql://nobody:nobody@127.0.0.1:1/none',
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('web:exposed refused: could not count users:')
    expect(result.stdout).toBe('')
  })
})
