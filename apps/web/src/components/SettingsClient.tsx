'use client'

import type { RosterCompany } from '../server/org'
import type { AdapterCard, PermissionRow } from '../server/settings'
import { CompanyManager, type CompanyRow } from './CompanyManager'
import { DangerZone } from './DangerZone'
import { PermissionMatrix } from './PermissionMatrix'
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
  dangerZone,
  showReseed,
}: {
  readonly templates: readonly TemplateRow[]
  readonly companies: readonly CompanyRow[]
  readonly roster: readonly RosterCompany[]
  readonly adapters: readonly AdapterCard[]
  readonly permissions: readonly PermissionRow[]
  /** `null` when no single workspace can be named -- see `buildDangerZoneTarget`. */
  readonly dangerZone: { readonly workspaceId: string; readonly halted: boolean } | null
  /** Computed on the SERVER from `NODE_ENV`, never guessed at here. */
  readonly showReseed: boolean
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 p-4">
      <Panel title="provider adapters">
        <ProviderAdapterCards adapters={adapters} />
      </Panel>
      <Panel title="agent permissions">
        <PermissionMatrix rows={permissions} />
      </Panel>
      <DangerZone
        workspaceId={dangerZone?.workspaceId ?? null}
        halted={dangerZone?.halted ?? false}
        showReseed={showReseed}
      />
      <Panel title="Template catalog">
        <TemplateCatalog templates={templates} />
      </Panel>
      <Panel title="Companies">
        <CompanyManager companies={companies} roster={roster} templates={templates} />
      </Panel>
    </div>
  )
}
