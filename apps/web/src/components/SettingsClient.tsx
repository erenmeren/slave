'use client'

import type { AdapterCard } from '../server/settings'
import type { BoundaryMode } from '../lib/authEnv'
import { DangerZone } from './DangerZone'
import { LogoutButton } from './LogoutButton'
import { ProviderAdapterCards } from './ProviderAdapterCards'
import { Panel } from './ui/Panel'

/** The GLOBAL Settings page's root (M24 §4): three panels, none of them scoped to a project --
 *  provider adapters, security, and the danger zone's reseed. Everything that used to live here
 *  and DOES belong to a project (the permission matrix, the per-workspace stop) moved to the
 *  project Settings tab (M24 Task 4); everything that belongs to the org, not a project (the
 *  workspace list, the template catalog, the company manager) moved to the Projects page (M24
 *  Task 6). This page is left with the settings that are neither. */
export function SettingsClient({
  adapters,
  showReseed,
  mode,
  posture,
}: {
  readonly adapters: readonly AdapterCard[]
  /** Computed on the SERVER from `NODE_ENV`, never guessed at here. */
  readonly showReseed: boolean
  /** Computed on the SERVER from `AITEAMOS_SESSION_SECRET` (`boundaryMode()`), never guessed here. */
  readonly mode: BoundaryMode
  /** `postureFor(mode, username)` — the single source for the security line (M23 spec §7 F5). */
  readonly posture: string
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 p-4">
      <Panel title="provider adapters">
        <ProviderAdapterCards adapters={adapters} />
      </Panel>
      <Panel title="security">
        <p data-testid="security-posture" className="font-mono text-[10px] text-text-3">
          {posture}
        </p>
        {mode === 'accounts' && <LogoutButton />}
      </Panel>
      <DangerZone showReseed={showReseed} />
    </div>
  )
}
