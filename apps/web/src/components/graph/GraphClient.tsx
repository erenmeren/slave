'use client'

import { useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useGraph } from '../../hooks/useGraph'
import type { GraphSnapshot } from '../../server/graph'
import { HaltBanner } from '../HaltBanner'
import { Sidebar } from '../Sidebar'
import { TopBar } from '../TopBar'
import { DepsMode } from './DepsMode'
import { GraphCanvas } from './GraphCanvas'
import { useLayoutedGraph } from './layout'
import { buildOrgGraph, ORG_NODE_TYPES } from './OrgNodes'

type GraphMode = 'org' | 'deps'
const DEFAULT_MODE: GraphMode = 'org'

function isGraphMode(value: string | null): value is GraphMode {
  return value === 'org' || value === 'deps'
}

const MODE_TABS: readonly { readonly mode: GraphMode; readonly label: string }[] = [
  { mode: 'org', label: 'Organization' },
  { mode: 'deps', label: 'Dependencies' },
]

/**
 * `/w/[workspaceId]/graph`'s client shell: Sidebar + TopBar, same house composition as
 * `ActivityClient`/`TasksClient`, plus the mode-tab strip. Organization mode's graph is built and
 * positioned right here (`buildOrgGraph` + `useLayoutedGraph`); Dependencies mode is a
 * self-contained component (`DepsMode`, Task 6) that owns its own graph-building, layout, and
 * edge-editing wiring -- this component only switches between the two on the `mode` tab.
 */
export function GraphClient({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: GraphSnapshot
}): React.JSX.Element {
  const { snapshot, connection, error } = useGraph(workspaceId, initial)
  const view = snapshot ?? initial

  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // Same idiom as `useSelectedId`: local state seeded once from the URL so a tab click re-renders
  // synchronously, `router.replace` kept as the side effect that lets a refresh restore it.
  const [mode, setModeState] = useState<GraphMode>(() => {
    const raw = searchParams.get('mode')
    return isGraphMode(raw) ? raw : DEFAULT_MODE
  })

  const setMode = (next: GraphMode): void => {
    setModeState(next)
    const params = new URLSearchParams(searchParams.toString())
    // The default mode is left out of the URL entirely (rather than written as `?mode=org`) --
    // the same "omit when it's nothing to say" instinct `useSelectedId` applies to `null`.
    if (next === DEFAULT_MODE) params.delete('mode')
    else params.set('mode', next)
    const query = params.toString()
    router.replace(query.length > 0 ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  const { nodes: orgNodes, edges: orgEdges } = useMemo(() => buildOrgGraph(view), [view])
  // The hook's own `edges`, not `orgEdges` directly: it filters out any edge whose endpoint is a
  // node not yet in the positioned set (a newly-appeared active-task satellite, for the one async
  // tick before its layout resolves) -- see `layout.ts`'s doc comment.
  const { nodes: positionedOrgNodes, edges: visibleOrgEdges } = useLayoutedGraph(orgNodes, orgEdges, 'mrtree')

  return (
    <div className="flex min-h-screen w-full">
      <Sidebar workspaceId={workspaceId} />
      <div className={`flex flex-1 flex-col ${error !== null ? 'opacity-60' : ''}`}>
        <TopBar workspaceName={view.workspace.name} connection={connection} budget={null} />
        {view.workspace.haltedReason !== null && <HaltBanner reason={view.workspace.haltedReason} />}
        {error !== null && (
          <div role="alert" className="border-b border-status-warn/40 bg-status-warn/10 px-4 py-1.5 text-xs text-status-warn">
            showing stale data: {error}
          </div>
        )}
        <nav aria-label="Graph mode" className="flex gap-1 border-b border-line px-3 py-2">
          {MODE_TABS.map((tab) => (
            <button
              key={tab.mode}
              type="button"
              aria-current={mode === tab.mode ? 'page' : undefined}
              onClick={() => setMode(tab.mode)}
              className={`rounded px-2 py-1 text-xs ${mode === tab.mode ? 'bg-bg-2 text-text-1' : 'text-text-2 hover:text-text-1'}`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div className="relative flex-1">
          {mode === 'org' ? (
            <GraphCanvas nodes={positionedOrgNodes} edges={visibleOrgEdges} nodeTypes={ORG_NODE_TYPES} />
          ) : (
            <DepsMode workspaceId={workspaceId} snapshot={view} />
          )}
        </div>
      </div>
    </div>
  )
}
