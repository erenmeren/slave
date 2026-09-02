// scripts/lib/child-env.mjs
/** The environment a gate's child `next dev` gets: the parent's, with the operator's password
 *  blanked rather than removed. Gates drive the loopback-only app; a configured password would
 *  put every one of them behind /login (M21 spec §2). A blank value reads as loopback mode
 *  (`apps/web/src/lib/authEnv.ts` trims and treats empty as no password) -- and, unlike deleting
 *  the key, it survives a child that re-reads `.env` itself via `--env-file` (Node's `--env-file`
 *  never overrides a key already present in the environment, only one that's absent). Extra keys
 *  win over the parent's. */
export function loopbackChildEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  env.AITEAMOS_PASSWORD = ''
  return env
}
