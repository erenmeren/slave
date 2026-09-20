'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useMode } from '../mode/ModeProvider'
import { TABS, tabsFor, sectionOf, type TabSpec } from '../../lib/routes'
import type { NeedsYouItem } from '../../server/needsYou'
import { SettingsIcon } from '../shell/icons'
import { NeedsYouBar } from './NeedsYouBar'

/**
 * The project command strip (M61 R7/R8/Task 6): the tab row (mode-aware, `lib/routes.ts`'s `TABS`)
 * and the settings shortcut, with the needs-you queue riding beneath it. Mounted by the project
 * layout, above `{children}` -- `buildShellFacts` still seeds the header's figures the same way it
 * always has; this strip is the ADDITION, not a replacement of that seed.
 *
 * Hand-rolled rather than `ui/Segmented` (spec erratum resolution): the testid vocabulary here is
 * `project-tab`/`data-tab`, one per tab, which is not `Segmented`'s `${testIdPrefix}-${option.id}`
 * shape -- so this draws its own pill row, styled like `Segmented`'s options (the same
 * `rounded-nav`/`bg-sel` recipe) rather than reusing the component.
 */
export function CommandStrip({
  workspaceId,
  needsYou,
}: {
  readonly workspaceId: string
  readonly needsYou: readonly NeedsYouItem[]
}): React.JSX.Element {
  const { mode } = useMode()
  const pathname = usePathname()
  const currentSection = sectionOf(pathname)
  const tabs = tabsFor(mode)

  // The current tab's spec, when the URL is on a tab this MODE does not show (R8's "developer left
  // Graph open, then flipped back to simple" case): the strip keeps it visible, marked, rather than
  // yanking a person off the page they are looking at the instant they change modes.
  const outside = TABS.find((tab) => tab.id === currentSection && !tab.modes.includes(mode))
  const allTabs: readonly TabSpec[] = outside === undefined ? tabs : [...tabs, outside]

  return (
    <div data-testid="command-strip" className="flex flex-col gap-[var(--gap-2)] px-[var(--gap-3)] pt-[var(--gap-2)]">
      <div className="flex items-center justify-between gap-[var(--gap-2)]">
        <nav
          data-testid="project-tabs"
          aria-label="Project"
          className="relative inline-flex gap-[2px] rounded-card border border-line2 p-[2px]"
        >
          {allTabs.map((tab) => {
            const current = tab.id === currentSection
            return (
              <Link
                key={tab.id}
                href={tab.href(workspaceId, mode)}
                data-testid="project-tab"
                data-tab={tab.id}
                aria-current={current ? 'page' : undefined}
                {...(tab === outside ? { 'data-outside-mode': 'true' } : {})}
                className={`type-meta rounded-nav border-0 px-[10px] py-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                  current ? 'bg-sel font-semibold text-t1' : 'bg-transparent text-t2 hover:text-t1'
                }`}
              >
                {tab.label}
              </Link>
            )
          })}
        </nav>
        <Link
          data-testid="project-settings"
          href={`/w/${workspaceId}/settings`}
          aria-label="Project settings"
          className="inline-flex h-[var(--row-h)] w-[var(--row-h)] items-center justify-center rounded-control border border-line2 text-t2 hover:border-line-hover hover:text-t1"
        >
          <SettingsIcon />
        </Link>
      </div>
      <NeedsYouBar workspaceId={workspaceId} initial={needsYou} />
    </div>
  )
}
