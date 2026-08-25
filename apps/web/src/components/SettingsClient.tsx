'use client'

import type { RosterCompany } from '../server/org'
import { CompanyManager, type CompanyRow } from './CompanyManager'
import { TemplateCatalog, type TemplateRow } from './TemplateCatalog'
import { Panel } from './ui/Panel'

/** The Settings page's root (M11 Task 9 brief): two `Panel`s -- the template catalog and the
 *  company manager, each carrying its own list + creation form + refusal state. */
export function SettingsClient({
  templates,
  companies,
  roster,
}: {
  readonly templates: readonly TemplateRow[]
  readonly companies: readonly CompanyRow[]
  readonly roster: readonly RosterCompany[]
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 p-4">
      <Panel title="Template catalog">
        <TemplateCatalog templates={templates} />
      </Panel>
      <Panel title="Companies">
        <CompanyManager companies={companies} roster={roster} templates={templates} />
      </Panel>
    </div>
  )
}
