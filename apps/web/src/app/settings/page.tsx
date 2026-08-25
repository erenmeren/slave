import { listCompanies, listRoster, listTemplates } from '../../server/org'
import { SettingsClient } from '../../components/SettingsClient'

export const dynamic = 'force-dynamic'

/** The M11 shell's Settings page (Task 9): the template catalog and the company manager, each
 *  reading its own slice of the org query module (`listTemplates`/`listCompanies`/`listRoster`). */
export default async function SettingsPage(): Promise<React.JSX.Element> {
  const [templates, companies, roster] = await Promise.all([listTemplates(), listCompanies(), listRoster()])
  return <SettingsClient templates={templates} companies={companies} roster={roster} />
}
