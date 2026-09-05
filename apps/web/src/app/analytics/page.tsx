import { buildAnalytics } from '../../server/analytics'
import { listProjects } from '../../server/org'
import { AnalyticsClient } from '../../components/AnalyticsClient'

export const dynamic = 'force-dynamic'

/** `/analytics` is GLOBAL, with an optional `?workspace=` scope (M14 §5, routes note) -- the
 *  same shell idiom `app/slaves/page.tsx` uses. */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>
}): Promise<React.JSX.Element> {
  const { workspace } = await searchParams
  const workspaceId = workspace === undefined || workspace === '' ? null : workspace
  const [snapshot, projects] = await Promise.all([buildAnalytics(workspaceId), listProjects()])
  return (
    <AnalyticsClient
      snapshot={snapshot}
      workspaces={projects.map((project) => ({ id: project.id, name: project.name }))}
      // `buildAnalytics` already resolves this against the seed's fixed workspace id (Decision 3)
      // -- not re-derived here from the project's name, which would drift the moment the seed's
      // display name changes without this page's copy changing with it.
      seeded={snapshot.seeded}
    />
  )
}
