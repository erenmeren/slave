// The M21 gate (spec §6): no loose ends. Zero spend. Checks 2 and 3 run the M15 and M20 gates as
// children WITH a configured AITEAMOS_PASSWORD in their environment -- the breakage A1 fixed, proven
// where it bit. Sequential: the children boot dev servers on the shared apps/web/.next.
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const PASS_LINE = 'no loose ends — the gates survive a password, the door serialises its refusals, the evidence chain is typed and paired'
const M15_PASS = 'PASS: the boundary holds — loopback-only, cross-site refused'
const M20_PASS = 'PASS: the door has a lock — loopback unchanged without a password, login required with one'
const EXEMPT = new Set(['gate-m20-auth.mjs', 'web-exposed.mjs'])

function assert(condition, message) { if (!condition) throw new Error(message) }

function runChildGate(script, env, passLine, label) {
  const child = spawnSync('node', [script], { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 })
  const out = child.stdout ?? ''
  process.stdout.write(`${out.split('\n').map((line) => `[${label}] ${line}`).join('\n')}\n`)
  assert(child.status === 0, `${label}: exited ${String(child.status)} (signal ${String(child.signal)})`)
  assert(out.includes(passLine), `${label}: PASS line missing`)
}

let exitCode = 1
try {
  // 1. Census: every next-dev spawner uses loopbackChildEnv, except the two named exceptions.
  {
    const spawners = readdirSync(`${repoRoot}scripts`).filter((f) => f.endsWith('.mjs') && readFileSync(`${repoRoot}scripts/${f}`, 'utf8').includes("'dev', 'apps/web'"))
    assert(spawners.length >= 11, `check 1: expected >= 11 next-dev spawners, found ${String(spawners.length)}: ${spawners.join(', ')}`)
    for (const f of spawners) {
      const uses = readFileSync(`${repoRoot}scripts/${f}`, 'utf8').includes('loopbackChildEnv(')
      if (EXEMPT.has(f)) assert(!uses, `check 1: ${f} is a named exception and must not use loopbackChildEnv`)
      else assert(uses, `check 1: ${f} spawns next dev without loopbackChildEnv`)
    }
    for (const f of EXEMPT) assert(spawners.includes(f), `check 1: exception ${f} not found among spawners`)
  }
  console.log('check 1: every dev-server spawner strips the password, the two exceptions by name')

  const PASSWORD = randomBytes(18).toString('base64url')
  const env = { ...process.env, AITEAMOS_PASSWORD: PASSWORD }

  // 2. The M15 gate under a configured password.
  runChildGate('scripts/gate-m15-boundary.mjs', env, M15_PASS, 'm15')
  console.log('check 2: gate-m15-boundary PASSes with AITEAMOS_PASSWORD set in its environment')

  // 3. The M20 gate under a configured password (its own run A deletes it, run B overrides it).
  runChildGate('scripts/gate-m20-auth.mjs', env, M20_PASS, 'm20')
  console.log('check 3: gate-m20-auth PASSes with AITEAMOS_PASSWORD set in its environment')

  // 4. The unit-level proofs, one child vitest run.
  {
    const files = [
      'apps/web/test/boundary.test.ts',
      'apps/web/test/auth-routes.test.ts',
      'apps/web/test/web-exposed.test.ts',
      'apps/web/test/graph-skill.test.tsx',
      'packages/providers/test/stream.test.ts',
      'packages/domain/test/events/schema.test.ts',
    ]
    const out = execFileSync('npx', ['vitest', 'run', ...files], { cwd: repoRoot, env: process.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    assert(/Test Files\s+6 passed/.test(out), `check 4: expected 6 passed test files -- got:\n${out.slice(-600)}`)
  }
  console.log('check 4: the six unit files that carry M21 are green')

  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  // Nothing of ours to tear down: each child gate frees its own port.
}
process.exit(exitCode)
