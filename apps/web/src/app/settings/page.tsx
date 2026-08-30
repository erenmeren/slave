import { listCompanies, listRoster, listTemplates } from '../../server/org'
import { buildDangerZoneTarget, buildPermissionMatrix, buildProviderAdapters } from '../../server/settings'
import { SettingsClient } from '../../components/SettingsClient'

export const dynamic = 'force-dynamic'

/** The Settings page (M14 §5.7): the org catalog reads from M11, plus the provider adapters
 *  (resolved against the real binaries on PATH), the permission matrix and the danger zone's
 *  target. */
export default async function SettingsPage(): Promise<React.JSX.Element> {
  const [templates, companies, roster, adapters, permissions, dangerZone] = await Promise.all([
    listTemplates(),
    listCompanies(),
    listRoster(),
    buildProviderAdapters(),
    buildPermissionMatrix(),
    buildDangerZoneTarget(),
  ])
  return (
    <SettingsClient
      templates={templates}
      companies={companies}
      roster={roster}
      adapters={adapters}
      permissions={permissions}
      dangerZone={dangerZone}
      // Decided on the SERVER, so the client never has to guess -- and the route itself 404s in
      // production regardless, so hiding the button is the second lock, not the only one.
      showReseed={process.env['NODE_ENV'] !== 'production'}
    />
  )
}
