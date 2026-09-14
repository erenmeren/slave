import type React from 'react'
import { buildShellFacts } from '../../../server/shell'
import { ShellFactsSeed } from '../../../components/shell/ShellFactsSeed'

export const dynamic = 'force-dynamic'

/**
 * The project layout seeds the shell's facts and renders its page (M57 R4/R7, spec erratum E12).
 *
 * Until M57 it mounted `ProjectHeader` and `ProjectTabs` as siblings of `{children}` and made THREE
 * server reads to feed them. Two of those are gone: the workspace list is the sidebar tree's server
 * read now, and the archived flag is drawn by the pages that can act on it (the Projects card, the
 * project Settings danger zone).
 *
 * `buildShellFacts` STAYS, and that is the erratum. The header is mounted by the ROOT layout and
 * reads `hooks/useShellFacts.ts` — a store only five of this segment's eight page clients publish
 * into. `/organization`, `/knowledge` and `/office` publish nothing, so without this seed the
 * budget figure and the entire `Pause all | Stop ▾` cluster would vanish on three of a project's
 * own pages. One read per MOUNT of this segment (Next keeps a shared layout mounted across soft
 * navigations between its siblings, so a Tasks→Team→Activity hop reuses it), and a page that DOES
 * stream overwrites the seed on its first snapshot.
 *
 * It stays as a file rather than being deleted for a second reason too: the segment is what gives
 * every page below it the `[workspaceId]` param, and `dynamic = 'force-dynamic'` here is what keeps
 * the whole subtree out of the static cache.
 */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ workspaceId: string }>
  children: React.ReactNode
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const facts = await buildShellFacts(workspaceId)
  return (
    <>
      {facts !== null && <ShellFactsSeed facts={facts} />}
      {children}
    </>
  )
}
