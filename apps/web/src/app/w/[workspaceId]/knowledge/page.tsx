import { buildKnowledge } from '../../../../server/memory'
import { KnowledgeClient } from '../../../../components/knowledge/KnowledgeClient'

export const dynamic = 'force-dynamic'

/**
 * The Knowledge tab (M49 R6, `docs/ia.md` tab 4): what this project has learnt, where each piece
 * came from, and what a person can do about it.
 */
export default async function KnowledgePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const view = await buildKnowledge(workspaceId)
  if (view === null) {
    return <div className="p-6 text-tone-blocked">no project with id {workspaceId}</div>
  }
  // Keyed, like every other project tab: a client-side move between projects remounts rather than
  // rendering the old project's rows under the new URL.
  return <KnowledgeClient key={workspaceId} workspaceId={workspaceId} initial={view} />
}
