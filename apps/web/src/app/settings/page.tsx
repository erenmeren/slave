import { listCompanies, listProjects, listRoster, listTemplates } from '../../server/org'
import { buildPermissionMatrix, buildProviderAdapters } from '../../server/settings'
import { SettingsClient } from '../../components/SettingsClient'
import { boundaryMode } from '../../lib/authEnv'
import { postureFor } from '../../lib/boundary'
import { currentPrincipal } from '../../server/principal'

export const dynamic = 'force-dynamic'

/** The Settings page (M14 §5.7): the org catalog reads from M11, plus the provider adapters
 *  (resolved against the real binaries on PATH), the permission matrix grouped by workspace, and
 *  the projects the danger zone's stop can be pointed at. */
export default async function SettingsPage(): Promise<React.JSX.Element> {
  const [templates, companies, roster, adapters, permissions, projects, principal] = await Promise.all([
    listTemplates(),
    listCompanies(),
    listRoster(),
    buildProviderAdapters(),
    buildPermissionMatrix(),
    listProjects(),
    // The one page that asks WHO is reading it. `null` in accounts mode is the revoked-user case
    // (spec §7 F4): the middleware honoured a still-valid signature, and the posture line is where
    // the operator finds out the account behind it is gone.
    currentPrincipal(),
  ])
  const mode = boundaryMode()
  return (
    <SettingsClient
      templates={templates}
      companies={companies}
      roster={roster}
      adapters={adapters}
      permissions={permissions}
      // `listProjects()` already orders by name, so the selector's default is the first project an
      // operator would read in the list -- not an arbitrary row.
      workspaces={projects.map((project) => ({ id: project.id, name: project.name, halted: project.halted }))}
      // Decided on the SERVER, so the client never has to guess -- and the route itself 404s in
      // production regardless, so hiding the button is the second lock, not the only one.
      showReseed={process.env['NODE_ENV'] !== 'production'}
      mode={mode}
      posture={postureFor(mode, principal?.username ?? null)}
    />
  )
}
