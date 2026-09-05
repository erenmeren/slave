// The M21 gate (spec §6): no loose ends. Zero spend. Checks 2 and 3 run the M15 and M20 gates as
// children WITH a configured SLAVEOFAI_PASSWORD in their environment -- the breakage A1 fixed, proven
// where it bit. Sequential: the children boot dev servers on the shared apps/web/.next.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const PASS_LINE = 'no loose ends — the gates survive a password, the door serialises its refusals, the evidence chain is typed and paired'
const M15_PASS = 'PASS: the boundary holds — loopback-only, cross-site refused'
const M20_PASS = 'PASS: the door has a lock — loopback unchanged without a secret, a named login with one'
const EXEMPT = new Set(['gate-m20-auth.mjs', 'web-exposed.mjs'])

/** A next-dev spawner, by source text: either quote style of the argv pair, or the bare binary
 *  path. This is a per-file census over top-level `scripts/*.mjs` only -- a second spawn inside a
 *  file that already calls `loopbackChildEnv(` once, or a spawner under `scripts/lib/` or
 *  `scripts/gate-fakes/`, is invisible to it (M22 A1). A non-spawner script that merely mentions
 *  the binary path or the argv pair (in a comment, say) is a false positive that fails check 1
 *  loud and closed with the "spawns next dev without loopbackChildEnv" message -- acceptable for
 *  a string census. */
const SPAWN_RE = /['"]dev['"],\s*['"]apps\/web['"]|node_modules\/next\/dist\/bin\/next/

function assert(condition, message) { if (!condition) throw new Error(message) }

function runChildGate(script, env, passLine, label) {
  const child = spawnSync('node', [script], { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 })
  const out = child.stdout ?? ''
  process.stdout.write(`${out.split('\n').map((line) => `[${label}] ${line}`).join('\n')}\n`)
  assert(child.error === undefined, `${label}: could not start: ${child.error?.message ?? ''}`)
  assert(child.status === 0, `${label}: exited ${String(child.status)} (signal ${String(child.signal)})`)
  assert(out.includes(passLine), `${label}: PASS line missing`)
}

let exitCode = 1
try {
  // 1. Census: every next-dev spawner uses loopbackChildEnv, except the two named exceptions.
  {
    // The census greps source text. This file's own regex source does NOT match itself (its
    // separators are escaped), but 'loopbackChildEnv(' appears here as a search string and a future
    // verbatim quote of the argv pair would match -- so the gate excludes itself by name rather than
    // ever counting itself as a twelfth spawner.
    const spawners = readdirSync(`${repoRoot}scripts`)
      .filter((f) => f.endsWith('.mjs') && f !== 'gate-m21-loose-ends.mjs')
      .map((name) => ({ name, text: readFileSync(`${repoRoot}scripts/${name}`, 'utf8') }))
      .filter(({ text }) => SPAWN_RE.test(text))
    const names = spawners.map(({ name }) => name)
    assert(spawners.length >= 11, `check 1: expected >= 11 next-dev spawners, found ${String(spawners.length)}: ${names.join(', ')}`)
    for (const { name, text } of spawners) {
      const uses = text.includes('loopbackChildEnv(')
      if (EXEMPT.has(name)) assert(!uses, `check 1: ${name} is a named exception and must not use loopbackChildEnv`)
      else assert(uses, `check 1: ${name} spawns next dev without loopbackChildEnv`)
    }
    for (const f of EXEMPT) assert(names.includes(f), `check 1: exception ${f} not found among spawners`)
    // The census above is a per-file grep and cannot see into `scripts/lib/child-env.mjs` itself
    // (a spawner under `scripts/lib/` is invisible to it, by design). So this reads that module's
    // source directly and confirms it blanks BOTH names -- M23 retired `SLAVEOFAI_PASSWORD`, but the
    // census keeps proving every spawner strips it too, in case some future reader resurrects it
    // from a stale `.env`.
    const childEnvSource = readFileSync(`${repoRoot}scripts/lib/child-env.mjs`, 'utf8')
    assert(childEnvSource.includes('SLAVEOFAI_SESSION_SECRET'), 'check 1: child-env.mjs does not mention SLAVEOFAI_SESSION_SECRET')
    assert(childEnvSource.includes('SLAVEOFAI_PASSWORD'), 'check 1: child-env.mjs does not mention SLAVEOFAI_PASSWORD')
  }
  console.log('check 1: every dev-server spawner strips the secret and the retired password, the two exceptions by name')

  const PASSWORD = randomBytes(18).toString('base64url')
  const env = { ...process.env, SLAVEOFAI_PASSWORD: PASSWORD }

  // 2. The M15 gate under a configured password.
  runChildGate('scripts/gate-m15-boundary.mjs', env, M15_PASS, 'm15')
  console.log('check 2: gate-m15-boundary PASSes with SLAVEOFAI_PASSWORD set in its environment')

  // 3. The M20 gate under a configured password (its own run A deletes it, run B overrides it).
  runChildGate('scripts/gate-m20-auth.mjs', env, M20_PASS, 'm20')
  console.log('check 3: gate-m20-auth PASSes with SLAVEOFAI_PASSWORD set in its environment')

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
    // Print what vitest said BEFORE judging it: a non-zero exit must be diagnosable from the
    // transcript, not swallowed by a throw that carries no output. Same print-then-assert shape
    // as runChildGate.
    // Colour off, twice over: GitHub Actions advertises a colour-capable log, so vitest interleaves
    // ANSI escapes between "Test Files" and "6 passed" and the regex below never matches (observed
    // on the first CI run, 2026-09-03). `NO_COLOR` + `FORCE_COLOR=0` ask vitest to stay plain, and
    // the strip below makes the assertion hold even if a future reporter ignores the ask.
    const child = spawnSync('npx', ['vitest', 'run', ...files], { cwd: repoRoot, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 })
    // eslint-disable-next-line no-control-regex -- stripping terminal escapes is the whole point
    const out = (child.stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '')
    process.stdout.write(`${out.split('\n').slice(-40).map((line) => `[vitest] ${line}`).join('\n')}\n`)
    assert(child.error === undefined, `check 4: could not start vitest: ${child.error?.message ?? ''}`)
    assert(child.status === 0, `check 4: vitest exited ${String(child.status)} (signal ${String(child.signal)})`)
    assert(/Test Files\s+6 passed/.test(out), `check 4: expected 6 passed test files -- got:\n${out.slice(-600)}`)
  }
  console.log('check 4: the six unit files that carry M21 are green')

  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  // Nothing of ours to tear down: each child gate frees its own port.
}
process.exit(exitCode)
