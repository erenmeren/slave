// scripts/lib/child-env.mjs
/** The environment a gate's child `next dev` gets: the parent's, minus the operator's password.
 *  Gates drive the loopback-only app; a configured password would put every one of them behind
 *  /login (M21 spec §2). Extra keys win over the parent's. */
export function loopbackChildEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.AITEAMOS_PASSWORD
  return env
}
