'use client'

import type { RosterCompany } from '../server/org'
import type { AdapterCard, PermissionSection } from '../server/settings'
import type { BoundaryMode } from '../lib/authEnv'
import { CompanyManager, type CompanyRow } from './CompanyManager'
import { DangerZone } from './DangerZone'
import { LogoutButton } from './LogoutButton'
import { PermissionMatrix } from './PermissionMatrix'
import { ProjectsPanel } from './ProjectsPanel'
import { ProviderAdapterCards } from './ProviderAdapterCards'
import { TemplateCatalog, type TemplateRow } from './TemplateCatalog'
import { Panel } from './ui/Panel'

/** The Settings page's root: the M14 §5.7 sections -- provider adapters, the permission matrix,
 *  realtime transport and the danger zone -- above the two M11 panels (the template catalog and
 *  the company manager), which stay exactly as they were. */
export function SettingsClient({
  templates,
  companies,
  roster,
  adapters,
  permissions,
  workspaces,
  showReseed,
  mode,
  posture,
}: {
  readonly templates: readonly TemplateRow[]
  readonly companies: readonly CompanyRow[]
  readonly roster: readonly RosterCompany[]
  readonly adapters: readonly AdapterCard[]
  /** One section per workspace -- see `PermissionSection`. */
  readonly permissions: readonly PermissionSection[]
  /** Every project, for the danger zone's target selector. */
  readonly workspaces: readonly { readonly id: string; readonly name: string; readonly halted: boolean }[]
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
      <Panel title="agent permissions">
        <PermissionMatrix sections={permissions} />
      </Panel>
      <Panel title="security">
        <p data-testid="security-posture" className="font-mono text-[10px] text-text-3">
          {posture}
        </p>
        {mode === 'accounts' && <LogoutButton />}
      </Panel>
      <DangerZone workspaces={workspaces} showReseed={showReseed} />
      <Panel title="Projects">
        <ProjectsPanel />
      </Panel>
      <Panel title="Template catalog">
        <TemplateCatalog templates={templates} />
      </Panel>
      <Panel title="Companies">
        <CompanyManager companies={companies} roster={roster} templates={templates} />
      </Panel>
    </div>
  )
}
