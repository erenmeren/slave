import { buildKnowledge } from '../../../../server/memory'
import { knowledgeQueryOf, parseKnowledgeFilters } from '../../../../lib/knowledgeFilters'
import { KnowledgeClient } from '../../../../components/knowledge/KnowledgeClient'

export const dynamic = 'force-dynamic'

/**
 * The Knowledge tab (M49 R6, `docs/ia.md` tab 4): what this project has learnt, where each piece
 * came from, and what a person can do about it.
 *
 * The FIRST paint is already the rows the filter bar claims to be showing (t4 fix round 1, minor
 * 4): a shared `?status=removed` link used to paint the default two statuses and replace them a
 * request later, which is the page disagreeing with its own address bar for as long as the round
 * trip takes. `parseKnowledgeFilters` is the same parse the route and the client hook use.
 */
export default async function KnowledgePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const query = knowledgeQueryOf((await searchParams) ?? {})
  const view = await buildKnowledge(workspaceId, parseKnowledgeFilters(query))
  if (view === null) {
    return <div className="p-6 text-tone-blocked">no project with id {workspaceId}</div>
  }
  // Keyed, like every other project tab: a client-side move between projects remounts rather than
  // rendering the old project's rows under the new URL.
  return <KnowledgeClient key={workspaceId} workspaceId={workspaceId} initial={view} />
}
