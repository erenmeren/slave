import { HomeClient } from '../components/home/HomeClient'
import { listCompanies } from '../server/org'
import { buildHomeSnapshot } from '../server/home'

export const dynamic = 'force-dynamic'

/** Home (M61 R11, Task 8): a project list beside a live feed, replacing the deleted
 *  `ProjectsClient` card grid -- `/w/[workspaceId]` and its siblings are still reached from a
 *  project row, the sidebar switcher, or the needs-you queue's own links.
 *
 *  `?archived=1` is `HomeClient`'s `show archived` toggle, round-tripped through the URL rather
 *  than component state so a reload or a shared link keeps the toggle's choice -- unchanged from
 *  the deleted Projects page's own rule, and the same idiom `analytics/page.tsx` and
 *  `login/page.tsx` use for their own `searchParams`. */
export default async function Home({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly archived?: string }>
}): Promise<React.JSX.Element> {
  const { archived } = await searchParams
  const [snapshot, companies] = await Promise.all([
    buildHomeSnapshot({ includeArchived: archived === '1' }),
    listCompanies(),
  ])
  return <HomeClient initial={snapshot} companies={companies} />
}
