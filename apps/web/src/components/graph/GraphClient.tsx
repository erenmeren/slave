'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Edge, NodeMouseHandler } from 'reactflow'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useGraph } from '../../hooks/useGraph'
import { announceProjectName } from '../../hooks/useProjectName'
import { publishShellFacts } from '../../hooks/useShellFacts'
import type { StreamEvent } from '../../hooks/useWorkspaceStream'
import type { GraphSnapshot } from '../../server/graph'
import { HaltBanner } from '../HaltBanner'
import { TopBar } from '../TopBar'
import { DepsMode } from './DepsMode'
import { buildExecutionGraph, EXECUTION_NODE_TYPES } from './ExecutionNodes'
import { GraphCanvas } from './GraphCanvas'
import { GraphDrawer } from './GraphDrawer'
import { handleToolCallFrame, sweepExpired, type Particle } from './flow'
import { useLayoutedGraph } from './layout'
import { buildOrgGraph, ORG_NODE_TYPES } from './OrgNodes'
import { Particles } from './Particles'

/** Sweep tick for expired particles (spec §6: "a sweep on each frame/tick removes expired") --
 *  frequent enough that a particle's ~600ms lifetime never lingers visibly past its expiry, cheap
 *  enough (a filter over at most `PARTICLE_CAP_PER_EDGE` × edge-count items) to run on a plain
 *  interval rather than a `requestAnimationFrame` loop. */
const PARTICLE_SWEEP_INTERVAL_MS = 100

/** The four modes of design README "1b — Modes". `deps` keeps its pre-M14 spelling because it is
 *  a URL value people already have in links and history, not just an internal literal. */
type GraphMode = 'org' | 'exec' | 'deps' | 'skill'
const DEFAULT_MODE: GraphMode = 'org'

function isGraphMode(value: string | null): value is GraphMode {
  return value === 'org' || value === 'exec' || value === 'deps' || value === 'skill'
}

const MODE_TABS: readonly { readonly mode: GraphMode; readonly label: string }[] = [
  { mode: 'org', label: 'Organization' },
  { mode: 'exec', label: 'Execution' },
  { mode: 'deps', label: 'Dependencies' },
  { mode: 'skill', label: 'Skill chain' },
]

/** `agent:<id>` — `buildOrgGraph`'s node-id prefix, and the one node kind the drawer opens for. */
const AGENT_NODE_PREFIX = 'agent:'

/**
 * Execution mode (design README "1b — Modes"): its OWN node set, built by `ExecutionNodes.tsx` and
 * positioned by the same `useLayoutedGraph` every other mode uses — the identical shape `DepsMode`
 * takes for its own builder, just small enough to live here rather than in its own file.
 *
 * `layered` runs left-to-right (`layout.ts` maps it to `elk.direction: RIGHT`), which is what puts
 * the stage chain across the canvas in `BOARD_COLUMNS` order. A stage's own task nodes hang off it
 * as ELK's next layer, so they trail to the right of their stage rather than sitting directly
 * beneath it — the topology is exact (the containment edge names the parent), the vertical
 * arrangement is ELK's, and tightening it to a strict column-per-stage grid needs a per-node ELK
 * partition option `layout.ts` does not pass today.
 */
function ExecutionMode({ snapshot }: { readonly snapshot: GraphSnapshot }): React.JSX.Element {
  const { nodes, edges } = useMemo(() => buildExecutionGraph(snapshot), [snapshot])
  const { nodes: positioned, edges: visibleEdges } = useLayoutedGraph(nodes, edges, 'layered')
  return <GraphCanvas nodes={positioned} edges={visibleEdges} nodeTypes={EXECUTION_NODE_TYPES} />
}

/**
 * `/w/[workspaceId]/graph`'s client shell: TopBar plus the mode-tab strip, same house composition
 * as `ActivityClient`/`TasksClient` (M11 Task 10/11) -- the global shell's `<Sidebar>` mounts once
 * in the root layout, not here (M11 Task 10 ruling 2; `announceProjectName` below is how this
 * route hands it the workspace's display name). Organization mode's graph is built and positioned
 * right here (`buildOrgGraph` + `useLayoutedGraph`); Execution and Dependencies each own their own
 * node set (`ExecutionMode` above, `DepsMode` in its own file) -- this component only switches
 * between them on the `mode` tab, and owns the selected agent the drawer renders.
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

  // Controller ruling carried from Task 3/8: this page already streams the workspace this
  // snapshot's `shellFacts` describes, so it publishes them to `hooks/useShellFacts.ts` and the
  // sidebar opens no second `EventSource` against `/api/w/:id/shell` (see `OverviewClient.tsx`/
  // `TasksClient.tsx` for the exact idiom this mirrors).
  useEffect((): void => {
    publishShellFacts(workspaceId, view.shellFacts)
  }, [workspaceId, view.shellFacts])
  // Retraction is its OWN effect, keyed only on the workspace: folding it into the cleanup of the
  // publish above would retract and re-publish on every snapshot, and the sidebar would flip to
  // its fallback stream (opening a connection) between the two.
  useEffect((): (() => void) => () => publishShellFacts(workspaceId, null), [workspaceId])

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

  // Skill chain is honestly `later` until some run has actually recorded skill data: a mode that
  // would open onto nothing is worse than a tab that says it cannot yet (Decision 7).
  const skillReachable = view.agents.some((agent) => agent.hasSkillData)

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const selectedAgent = view.agents.find((agent) => agent.id === selectedAgentId) ?? null

  const onNodeClick: NodeMouseHandler = (_event, node): void => {
    // Only an agent node opens the drawer -- it is an AGENT detail panel, and a team or workspace
    // node has no drawer's worth of facts behind it (the same reason neither carries a NodeMenu).
    if (!node.id.startsWith(AGENT_NODE_PREFIX)) return
    setSelectedAgentId(node.id.slice(AGENT_NODE_PREFIX.length))
  }

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
      {/* No `ui/` component covers a segmented mode toggle with an `aria-current` "current tab"
       *  state -- `Button`'s bordered-pill affordance (spec §3, meant for standalone actions)
       *  would visually redesign this into something the handoff never asked for here. Left on its
       *  existing token-based recipe, same as the "stale data" banner just above (no `ui/`
       *  alert/banner component exists either) -- both predate this task and stay as-is. */}
      <nav aria-label="Graph mode" className="flex gap-1 border-b border-line px-3 py-2">
        {MODE_TABS.map((tab) => {
          const disabled = tab.mode === 'skill' && !skillReachable
          return (
            <button
              key={tab.mode}
              type="button"
              data-testid={`graph-mode-${tab.mode}`}
              aria-current={mode === tab.mode ? 'page' : undefined}
              disabled={disabled}
              title={disabled ? 'no run has recorded skill data yet' : undefined}
              onClick={() => setMode(tab.mode)}
              className={`rounded px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
                mode === tab.mode ? 'bg-bg-2 text-text-1' : 'text-text-2 hover:text-text-1'
              }`}
            >
              {disabled ? `${tab.label} · later` : tab.label}
            </button>
          )
        })}
      </nav>
      <div className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {mode === 'org' && (
            <>
              <GraphCanvas nodes={positionedOrgNodes} edges={visibleOrgEdges} nodeTypes={ORG_NODE_TYPES} onNodeClick={onNodeClick} />
              <Particles particles={particles} />
            </>
          )}
          {mode === 'exec' && <ExecutionMode snapshot={view} />}
          {mode === 'deps' && <DepsMode workspaceId={workspaceId} snapshot={view} />}
        </div>
        {selectedAgent !== null && (
          <GraphDrawer workspaceId={workspaceId} agent={selectedAgent} onClose={() => setSelectedAgentId(null)} />
        )}
      </div>
    </div>
  )
}
