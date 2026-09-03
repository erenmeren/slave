// scripts/lib/child-env.mjs
/** The environment a gate's child `next dev` gets: the parent's, with the operator's session
 *  secret blanked rather than removed. Gates drive the loopback-only app; a configured secret would
 *  put every one of them behind /login (M21 spec §2, M23 spec §7 F1). A blank value reads as
 *  loopback mode (`apps/web/src/lib/authEnv.ts` trims and treats empty as no secret) -- and, unlike
 *  deleting the key, it survives a child that re-reads `.env` itself via `--env-file` (Node's
 *  `--env-file` never overrides a key already present in the environment, only one that's absent).
 *
 *  `AITEAMOS_PASSWORD` is blanked too even though M23 retired it and nothing reads it any more:
 *  the census in `gate:m21` keeps proving every spawner strips both, so a stale `.env` cannot
 *  resurrect password mode through some future reader that has not been written yet.
 *
 *  Extra keys win over the parent's. An `extra` entry for either variable is overridden too — the
 *  blanks are unconditional. */
export function loopbackChildEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  env.AITEAMOS_SESSION_SECRET = ''
  env.AITEAMOS_PASSWORD = ''
  return env
}
