import { PROVIDER_KINDS, manifestFor } from '@slave-of-ai/domain'
import { afterEach, describe, expect, it } from 'vitest'
import { buildAdapterRegistry } from '../../src/cli.js'

/**
 * `buildAdapterRegistry` (M56a R6), reached for real rather than described.
 *
 * Under `test/integration/` because importing `cli.js` pulls the Prisma client in, and only that
 * project is guaranteed a `DATABASE_URL`. Importing the module runs nothing: `main()` is guarded by
 * the `argv[1]` check at the bottom of `cli.ts`.
 */

/** Every variable this file touches, restored after each case: `process.env` is process-wide and
 *  the integration project runs single-threaded. */
const TOUCHED = [
  'SLAVEOFAI_REQUIRE_FAKE_CLI',
  ...PROVIDER_KINDS.flatMap((kind) => [manifestFor(kind).invocation.binEnvVar, manifestFor(kind).invocation.argsEnvVar]),
]
const saved = new Map<string, string | undefined>(TOUCHED.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('buildAdapterRegistry (R6)', () => {
  it('wires every kind from its own manifest’s env vars, and resolves each to its own adapter', () => {
    for (const kind of PROVIDER_KINDS) process.env[manifestFor(kind).invocation.binEnvVar] = '/bin/true'
    delete process.env['SLAVEOFAI_REQUIRE_FAKE_CLI']
    const registry = buildAdapterRegistry()
    for (const kind of PROVIDER_KINDS) expect(registry.resolve(kind).kind, kind).toBe(kind)
  })

  it('refuses to build anything at all when the fake CLI was demanded and not supplied (R10)', () => {
    process.env['SLAVEOFAI_REQUIRE_FAKE_CLI'] = '1'
    process.env['SLAVEOFAI_CLAUDE_BIN'] = '/repo/scripts/gate-fakes/fake-claude.sh'
    delete process.env['SLAVEOFAI_CURSOR_BIN']
    expect(() => buildAdapterRegistry()).toThrow(/SLAVEOFAI_CURSOR_BIN/)
  })
})
