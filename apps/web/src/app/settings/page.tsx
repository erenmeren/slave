import { buildProviderAdapters } from '../../server/settings'
import { SettingsClient } from '../../components/SettingsClient'
import { boundaryMode } from '../../lib/authEnv'
import { postureFor } from '../../lib/boundary'
import { currentPrincipal } from '../../server/principal'

export const dynamic = 'force-dynamic'

/** The GLOBAL Settings page (M24 §4): the provider adapters (resolved against the real binaries
 *  on PATH), the security posture line, and the reseed. The org catalog (templates, companies)
 *  and the per-project surfaces (the permission matrix, the emergency stop) live elsewhere now --
 *  see `SettingsClient`'s docstring for where. */
export default async function SettingsPage(): Promise<React.JSX.Element> {
  const [adapters, principal] = await Promise.all([
    buildProviderAdapters(),
    // The one page that asks WHO is reading it. `null` in accounts mode is the revoked-user case
    // (spec §7 F4): the middleware honoured a still-valid signature, and the posture line is where
    // the operator finds out the account behind it is gone.
    currentPrincipal(),
  ])
  const mode = boundaryMode()
  return (
    <SettingsClient
      adapters={adapters}
      // Decided on the SERVER, so the client never has to guess -- and the route itself 404s in
      // production regardless, so hiding the button is the second lock, not the only one.
      showReseed={process.env['NODE_ENV'] !== 'production'}
      mode={mode}
      posture={postureFor(mode, principal?.username ?? null)}
    />
  )
}
