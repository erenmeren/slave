// scripts/lib/child-env.mjs
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_MANIFESTS } from '../../packages/domain/dist/index.js'
import { gateStateDir } from './state-dir.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The fake binary for every provider this environment has NOT already named, when it has asked for
 * fakes (M56a R10, plan erratum E11).
 *
 * `fakeCliRefusal` (`apps/orchestrator/src/require-fake-cli.ts`) now refuses to start a process that
 * set `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and left ANY provider's `SLAVEOFAI_<X>_BIN` unset -- which is
 * the point of it, and which would otherwise refuse the twenty-nine gates that were never wrong
 * about anything, because before this milestone there was nothing to set. One place rather than
 * twenty-nine copies of one line: `scripts/lib/state-dir.mjs` made exactly this call for exactly
 * this reason.
 *
 * CONDITIONAL, in three ways that matter:
 *   - only when the environment it is HANDED actually asks for fakes, so `gate:m13-runtime` (which
 *     calls `loopbackChildEnv()` and sets no flag) still drives the REAL binaries;
 *   - never over a value the caller supplied, so a gate that points a provider at its own fixture
 *     fake keeps it -- which is also why a caller can spread the result last without it overriding
 *     anything the caller chose;
 *   - only where a fake actually exists on disk, under `scripts/gate-fakes/`'s own
 *     `fake-<binary>.sh` convention, so a future provider with no rehearsal fake fails LOUDLY at
 *     start rather than silently running against nothing.
 *
 * Reads the manifests out of `packages/domain/dist`, the way every gate reads a built package. Every
 * gate's npm script is `tsc --build && node …`, so the build has run by the time this is imported.
 *
 * Prints nothing: it is called on the way into a `spawn` and a line of chatter there would land in
 * the middle of the output the gates parse.
 */
export function fakeProviderBins(env) {
  if (env.SLAVEOFAI_REQUIRE_FAKE_CLI !== '1') return {}
  const bins = {}
  for (const manifest of Object.values(PROVIDER_MANIFESTS)) {
    const { binEnvVar, binary } = manifest.invocation
    const named = env[binEnvVar]
    if (named !== undefined && named.trim() !== '') continue
    const fake = join(repoRoot, 'scripts', 'gate-fakes', `fake-${binary}.sh`)
    if (existsSync(fake)) bins[binEnvVar] = fake
  }
  return bins
}

/** The environment a gate's child `next dev` gets: the parent's, with the operator's session
 *  secret blanked rather than removed. Gates drive the loopback-only app; a configured secret would
 *  put every one of them behind /login (M21 spec §2, M23 spec §7 F1). A blank value reads as
 *  loopback mode (`apps/web/src/lib/authEnv.ts` trims and treats empty as no secret) -- and, unlike
 *  deleting the key, it survives a child that re-reads `.env` itself via `--env-file` (Node's
 *  `--env-file` never overrides a key already present in the environment, only one that's absent).
 *
 *  `SLAVEOFAI_PASSWORD` is blanked too even though M23 retired it and nothing reads it any more:
 *  the census in `gate:m21` keeps proving every spawner strips both, so a stale `.env` cannot
 *  resurrect password mode through some future reader that has not been written yet.
 *
 *  `SLAVEOFAI_STATE_DIR` is the third thing this helper settles, and the reason it is here rather
 *  than in twenty-eight gates (M52 Task 6 fix round 1): since M52 R4 a run's own directory lives
 *  under `$SLAVEOFAI_STATE_DIR ?? $XDG_STATE_HOME ?? ~/.local/state`, outside the repository and
 *  outside every repo-scoped cleanup, so a gate that did not choose one left its run directories in
 *  the operator's `$HOME` forever (measured: 1,645 of them in one afternoon). `gateStateDir()`
 *  creates ONE per gate process, sets it on `process.env` so the gate and its daemons agree on
 *  where a run's files are, and removes it on exit. An `extra` entry -- or an operator's own
 *  exported value -- still wins, because it is read before anything is created.
 *
 *  It also arms the fake binary of every provider the caller did not name, but ONLY when the
 *  resulting environment says `SLAVEOFAI_REQUIRE_FAKE_CLI=1` -- see `fakeProviderBins`. The flag is
 *  read off the MERGED environment, so a caller that arms the fakes through `extra` (rather than
 *  through its own exported variables) is covered by the same line.
 *
 *  Extra keys win over the parent's. An `extra` entry for either blanked variable is overridden
 *  too — the blanks are unconditional. */
export function loopbackChildEnv(extra = {}) {
  gateStateDir()
  const env = { ...process.env, ...extra }
  env.SLAVEOFAI_SESSION_SECRET = ''
  env.SLAVEOFAI_PASSWORD = ''
  return { ...env, ...fakeProviderBins(env) }
}
