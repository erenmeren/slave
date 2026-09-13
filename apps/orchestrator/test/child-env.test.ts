import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_KINDS, manifestFor } from '@slave-of-ai/domain'
import { describe, expect, it } from 'vitest'

/**
 * `scripts/lib/child-env.mjs`'s half of the widened spend net (M56a R10, plan erratum E11).
 *
 * `fakeCliRefusal` refuses a process that asked for fakes and left any provider's `*_BIN` unset, and
 * `fakeProviderBins` is the one place that fills those in for the twenty-nine gates that ask. The
 * rule it has to get right is not "set the fakes" but "set the fakes NOBODY ELSE SET, and only when
 * asked": a helper that overwrote a gate's own choice would silently replace the fixture fake a gate
 * spawned on purpose, and one that ignored the flag would point `gate:m13-runtime` -- which exists
 * to drive the REAL binaries -- at a rehearsal script.
 *
 * Reached by a computed specifier because the file is plain JS outside every tsconfig (`allowJs` is
 * off), the same way `permissions-lib.test.ts` reaches a shell library it cannot type.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const childEnvModule = new URL('../../../scripts/lib/child-env.mjs', import.meta.url).href

type FakeProviderBins = (env: Record<string, string | undefined>) => Record<string, string>
const { fakeProviderBins } = (await import(childEnvModule)) as { fakeProviderBins: FakeProviderBins }

/** The fake this repository ships for a kind, under `gate-fakes/`'s own `fake-<binary>.sh` name. */
const fakeFor = (kind: (typeof PROVIDER_KINDS)[number]): string =>
  join(repoRoot, 'scripts', 'gate-fakes', `fake-${manifestFor(kind).invocation.binary}.sh`)

describe('fakeProviderBins (M56a R10)', () => {
  it('fills the bin variable of every provider the caller did not name', () => {
    const filled = fakeProviderBins({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1' })
    for (const kind of PROVIDER_KINDS) {
      const { binEnvVar } = manifestFor(kind).invocation
      // Only for a provider whose rehearsal fake exists: a future kind with none must fail loudly
      // at start rather than be pointed at a path that is not there.
      if (!existsSync(fakeFor(kind))) continue
      expect(filled[binEnvVar], binEnvVar).toBe(fakeFor(kind))
    }
    // Both shipped providers have a fake in this repository, so this is not a vacuous loop.
    expect(Object.keys(filled).sort()).toEqual(PROVIDER_KINDS.map((kind) => manifestFor(kind).invocation.binEnvVar).sort())
  })

  it('never returns a key the environment already has, so spreading it last cannot override a choice', () => {
    const chosen = {
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
      SLAVEOFAI_CLAUDE_BIN: 'node',
      SLAVEOFAI_CLAUDE_ARGS: '/repo/packages/providers/test/fake-claude.mjs --fixture m8-flow',
    }
    const filled = fakeProviderBins(chosen)
    expect(filled['SLAVEOFAI_CLAUDE_BIN']).toBeUndefined()
    expect(filled['SLAVEOFAI_CURSOR_BIN']).toBe(fakeFor('cursor'))
    // A set-but-blank value is not a choice -- it is exactly the shape `fakeCliRefusal` refuses.
    expect(fakeProviderBins({ ...chosen, SLAVEOFAI_CLAUDE_BIN: '   ' })['SLAVEOFAI_CLAUDE_BIN']).toBe(fakeFor('claude_code'))
  })

  it('arms nothing at all when the environment did not ask for fakes', () => {
    // `gate:m12-providers` and `gate:m13-runtime` drive the REAL binaries by design and set no flag.
    expect(fakeProviderBins({})).toEqual({})
    expect(fakeProviderBins({ SLAVEOFAI_REQUIRE_FAKE_CLI: '' })).toEqual({})
    expect(fakeProviderBins({ SLAVEOFAI_REQUIRE_FAKE_CLI: '0' })).toEqual({})
  })
})
