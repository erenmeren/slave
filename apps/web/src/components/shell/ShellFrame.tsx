'use client'

import type React from 'react'
import type { SidebarProject } from '../../server/sidebar'
import { AppShell } from './AppShell'
import { Header } from './Header'
import { RightPanelHost } from './RightPanelHost'
import { useRightWidth } from './RightColumn'

/** The one client component that knows both what route this is and whether the panel is
 *  collapsed — the two facts the grid's third track is sized from.
 *
 *  `sidebar` is passed in as a NODE rather than imported, so the root layout's SERVER read of the
 *  tree still reaches it; `projects` is passed as DATA as well, because `Header` needs the same
 *  list to name the project in the breadcrumb on the three routes that publish no `ShellFacts`
 *  (spec erratum E12) and this component is the only thing between the layout and it. */
export function ShellFrame({
  sidebar,
  projects,
  children,
}: {
  readonly sidebar: React.ReactNode
  readonly projects: readonly SidebarProject[]
  readonly children: React.ReactNode
}): React.JSX.Element {
  const rightWidth = useRightWidth()
  return (
    <AppShell sidebar={sidebar} header={<Header projects={projects} />} right={<RightPanelHost />} rightWidth={rightWidth}>
      {children}
    </AppShell>
  )
}
