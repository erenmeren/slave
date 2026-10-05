import { readInstallationSettings, resolveReposRoot } from '@slave-of-ai/control'
import { SettingsView } from '@/components/settings/SettingsView'
import { boundaryMode } from '../../../lib/authEnv'
import { currentPrincipal } from '../../../server/principal'
import { buildProviderAdapters } from '../../../server/settings'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Settings · Slave of AI' }

/** Settings (lead UX design section 6.6): how is this installation set up? */
export default async function SettingsPage(): Promise<React.JSX.Element> {
  const [adapters, principal, root, stored] = await Promise.all([buildProviderAdapters(), currentPrincipal(), resolveReposRoot(), readInstallationSettings()])
  const mode = boundaryMode()
  return (
    <SettingsView
      runtimes={adapters.filter((adapter) => adapter.state !== 'later').map((adapter) => ({ kind: adapter.kind, label: adapter.label, found: adapter.state === 'connected', version: adapter.version }))}
      reposRoot={{ stored: stored.reposRoot, resolved: root.root }}
      posture={
        mode === 'accounts'
          ? `Accounts are on. ${principal === null ? 'Not signed in.' : `Signed in as ${principal.username}.`} Requests from other sites are refused.`
          : 'No accounts: only this machine can open Slave. Requests from other sites are refused.'
      }
      username={principal?.username ?? null}
      // The route itself 404s in production; hiding the card is the second lock.
      showReseed={process.env['NODE_ENV'] !== 'production'}
    />
  )
}
