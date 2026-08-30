'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Edge } from 'reactflow'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useGraph } from '../../hooks/useGraph'
import { announceProjectName } from '../../hooks/useProjectName'
import type { StreamEvent } from '../../hooks/useWorkspaceStream'
import type { GraphSnapshot } from '../../server/graph'
import { HaltBanner } from '../HaltBanner'
import { TopBar } from '../TopBar'
import { DepsMode } from './DepsMode'
import { GraphCanvas } from './GraphCanvas'
import { handleToolCallFrame, sweepExpired, type Particle } from './flow'
import { useLayoutedGraph } from './layout'
import { buildOrgGraph, ORG_NODE_TYPES } from './OrgNodes'
import { Particles } from './Particles'

/** Sweep tick for expired particles (spec §6: "a sweep on each frame/tick removes expired") --
 *  frequent enough that a particle's ~600ms lifetime never lingers visibly past its expiry, cheap
 *  enough (a filter over at most `PARTICLE_CAP_PER_EDGE` × edge-count items) to run on a plain
 *  interval rather than a `requestAnimationFrame` loop. */
const PARTICLE_SWEEP_INTERVAL_MS = 100

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
 * `/w/[workspaceId]/graph`'s client shell: TopBar plus the mode-tab strip, same house composition
 * as `ActivityClient`/`TasksClient` (M11 Task 10/11) -- the global shell's `<Sidebar>` mounts once
 * in the root layout, not here (M11 Task 10 ruling 2; `announceProjectName` below is how this
 * route hands it the workspace's display name). Organization mode's graph is built and positioned
 * right here (`buildOrgGraph` + `useLayoutedGraph`); Dependencies mode is a self-contained
 * component (`DepsMode`, Task 6) that owns its own graph-building, layout, and edge-editing
 * wiring -- this component only switches between the two on the `mode` tab.
 */
export function GraphClient({
  workspaceId,
  initial,
}: {
  readonly workspaceId: string
  readonly initial: GraphSnapshot
}): React.JSX.Element {
  // Org mode's particle track (spec §6): the agent -> active-task edge to spawn a `run.tool_call`
  // particle on. A ref, not `orgEdges` closed over directly -- `onEvent` below is created once per
  // render and handed straight to `useGraph`'s third argument (a raw-frame pass-through, Task 4's
  // interface), but the edge list it needs is computed *after* this call in the same render; the
  // ref (updated in plain assignment further down, same idiom `useWorkspaceStream` itself uses for
  // its own `onEvent`/`onSnapshot` refs) always reads the latest render's edges by the time a frame
  // actually arrives asynchronously.
  const orgEdgesRef = useRef<readonly Edge[]>([])
  const [particles, setParticles] = useState<readonly Particle[]>([])

  const onGraphEvent = (event: StreamEvent): void => {
    setParticles((current) => handleToolCallFrame(event, orgEdgesRef.current, current, Date.now()))
  }

  const { snapshot, connection, error, latencyMs } = useGraph(workspaceId, initial, onGraphEvent)
  const view = snapshot ?? initial

  // Fills the global shell's Sidebar project-section header with this workspace's real name
  // (M11 Task 10 ruling 2) — the root layout mounts one <Sidebar> with no per-route params of its
  // own, so this is how it learns the name rather than showing the bare workspaceId forever.
  useEffect((): void => {
    announceProjectName(workspaceId, view.workspace.name)
  }, [workspaceId, view.workspace.name])

  // Sweeps expired particles on a plain interval (see `PARTICLE_SWEEP_INTERVAL_MS`'s doc comment)
  // for the component's whole lifetime -- a no-op `setState` is skipped entirely when there is
  // nothing to sweep, so an idle graph (no particles ever spawned) never re-renders from this.
  useEffect(() => {
    const id = setInterval(() => {
      setParticles((current) => (current.length === 0 ? current : sweepExpired(current, Date.now())))
    }, PARTICLE_SWEEP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [])

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
  orgEdgesRef.current = orgEdges
  // The hook's own `edges`, not `orgEdges` directly: it filters out any edge whose endpoint is a
  // node not yet in the positioned set (a newly-appeared active-task satellite, for the one async
  // tick before its layout resolves) -- see `layout.ts`'s doc comment.
  const { nodes: positionedOrgNodes, edges: visibleOrgEdges } = useLayoutedGraph(orgNodes, orgEdges, 'mrtree')

  return (
    <div className={`flex flex-1 flex-col ${error !== null ? 'opacity-60' : ''}`}>
      <TopBar
        workspaceId={workspaceId}
        workspaceName={view.workspace.name}
        connection={connection}
        latencyMs={latencyMs}
        budget={null}
        halted={view.workspace.haltedReason !== null}
      />
      {view.workspace.haltedReason !== null && <HaltBanner reason={view.workspace.haltedReason} />}
      {error !== null && (
        <div role="alert" className="border-b border-status-warn/40 bg-status-warn/10 px-4 py-1.5 text-xs text-status-warn">
          showing stale data: {error}
        </div>
      )}
      {/* No `ui/` component covers a two-way segmented mode toggle with an `aria-current`
       *  "current tab" state -- `Button`'s bordered-pill affordance (spec §3, meant for standalone
       *  actions) would visually redesign this into something the handoff never asked for here.
       *  Left on its existing token-based recipe, same as the "stale data" banner just above (no
       *  `ui/` alert/banner component exists either) -- both predate this task and stay as-is. */}
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
          <>
            <GraphCanvas nodes={positionedOrgNodes} edges={visibleOrgEdges} nodeTypes={ORG_NODE_TYPES} />
            <Particles particles={particles} />
          </>
        ) : (
          <DepsMode workspaceId={workspaceId} snapshot={view} />
        )}
      </div>
    </div>
  )
}
