// scripts/lib/child-env.mjs
import { gateStateDir } from './state-dir.mjs'

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
 *  Extra keys win over the parent's. An `extra` entry for either blanked variable is overridden
 *  too — the blanks are unconditional. */
export function loopbackChildEnv(extra = {}) {
  gateStateDir()
  const env = { ...process.env, ...extra }
  env.SLAVEOFAI_SESSION_SECRET = ''
  env.SLAVEOFAI_PASSWORD = ''
  return env
}
