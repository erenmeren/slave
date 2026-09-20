import { readInstallationSettings, resolveReposRoot } from '@slave-of-ai/control'
import { buildProviderAdapters } from '../../server/settings'
import { SettingsClient } from '../../components/SettingsClient'
import { boundaryMode } from '../../lib/authEnv'
import { postureFor } from '../../lib/boundary'
import { currentPrincipal } from '../../server/principal'

export const dynamic = 'force-dynamic'

/** The GLOBAL Settings page (M24 §4): the provider adapters (resolved against the real binaries
 *  on PATH), the security posture line, and the reseed. The org catalog (templates, companies)
 *  and the per-project surfaces (the permission matrix, the emergency stop) live elsewhere now --
 *  see `SettingsClient`'s docstring for where.
 *
 *  M61 Task 9: `?section=` picks which of the five sections opens -- read here, on the server,
 *  the same way `app/workforce/page.tsx` reads `?tab=`; an unknown or absent value is handed
 *  through as-is, and `SettingsClient` is what falls back to the first section. */
export default async function SettingsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly section?: string }>
}): Promise<React.JSX.Element> {
  const { section } = await searchParams
  const [adapters, principal, root] = await Promise.all([
    buildProviderAdapters(),
    // The one page that asks WHO is reading it. `null` in accounts mode is the revoked-user case
    // (spec §7 F4): the middleware honoured a still-valid signature, and the posture line is where
    // the operator finds out the account behind it is gone.
    currentPrincipal(),
    // M59 R17. On the SERVER, through the one resolver every reader goes through, so the page and
    // the intake's facts cannot disagree about where a repository will be created.
    resolveReposRoot(),
  ])
  const stored = await readInstallationSettings()
  const mode = boundaryMode()
  return (
    <SettingsClient
      adapters={adapters}
      // Decided on the SERVER, so the client never has to guess -- and the route itself 404s in
      // production regardless, so hiding the button is the second lock, not the only one.
      showReseed={process.env['NODE_ENV'] !== 'production'}
      mode={mode}
      posture={postureFor(mode, principal?.username ?? null)}
      reposRoot={{ reposRoot: stored.reposRoot, resolved: root.root, source: root.source }}
      initialSection={section}
    />
  )
}
