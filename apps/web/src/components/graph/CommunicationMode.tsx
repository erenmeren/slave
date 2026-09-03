'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommunicationGraph } from '../../server/communicationGraph'
import { GraphCanvas } from './GraphCanvas'
import { useLayoutedGraph } from './layout'
import { buildCommunicationGraph, COMM_NODE_TYPES } from './CommunicationNodes'

/** The DTO's own honest zero state (spec §6 E1's empty state) -- also this component's initial
 *  state, before the fetch below has resolved. A workspace whose communication graph genuinely has
 *  zero hand-offs and one that simply hasn't answered yet render identically for that one gap: the
 *  same panel a moment later either stays (truly empty) or gives way to the real graph. Same idiom
 *  as `SkillMode.tsx`'s own `EMPTY_GRAPH`. */
const EMPTY_GRAPH: CommunicationGraph = { agents: [], edges: [] }

/** Debounce window for the stream-driven refetch below (Task 12, M23 E3) -- the same 2s window
 *  `SkillMode.tsx`'s `SKILL_REFETCH_DEBOUNCE_MS` uses, and for the same reason: `GraphClient`'s
 *  `onGraphEvent` can bump this view's tick once per frame of any of the five domain event types
 *  it reacts to, and a burst of those inside one busy moment (a plan that fans out several tasks,
 *  say) must collapse into one re-fetch of this view's own aggregate query, not a fetch per frame. */
const COMM_REFETCH_DEBOUNCE_MS = 2_000

async function fetchCommunicationGraph(workspaceId: string): Promise<CommunicationGraph> {
  const response = await fetch(`/api/w/${workspaceId}/graph/communication`)
  if (!response.ok) throw new Error(`communication graph failed: ${response.status} ${await response.text()}`)
  return (await response.json()) as CommunicationGraph
}

/**
 * Communication mode (Task 12, M23 E3, spec §6 E1): who-talked-to-whom, folded from the event log
 * into agent nodes, one always-present operator node, and cable edges (`buildCommunicationGraph`).
 * `SkillMode.tsx` minus its run-selector strip -- this view has no per-run "Focus" half, only the
 * one aggregate canvas -- on the same `DepsMode.tsx:52-162` template every sibling mode follows: an
 * absolute error band (`role="alert"`) and an absolute empty-state hint stack over an
 * ALWAYS-rendered `GraphCanvas` (never a conditionally-omitted one -- an empty result is still a
 * real, explained canvas, not a blank one).
 *
 * Owns its own fetch, same as `SkillMode`: the communication graph is a SIBLING DTO to
 * `GraphSnapshot` (Task 11's own route, `/api/w/<workspaceId>/graph/communication`), not something
 * `GraphClient` already has in hand.
 *
 * `frameTick` is `GraphClient`'s own debounced-refetch signal, bumped once per raw frame whose
 * `type` is one of the five domain events `communicationFold.ts` reads
 * (`run.started`/`task.review_started`/`task.review_rejected`/`agent.message_sent`/
 * `workspace.plan_created`) -- the same "reuse the raw-frame path already threaded through
 * `onGraphEvent`" shape `SkillMode`'s own `toolCallTick` prop takes, not a second `EventSource`.
 */
export function CommunicationMode({
  workspaceId,
  frameTick = 0,
}: {
  readonly workspaceId: string
  frameTick?: number
}): React.JSX.Element {
  const [graph, setGraph] = useState<CommunicationGraph>(EMPTY_GRAPH)
  const [errorText, setErrorText] = useState<string | null>(null)

  // Fetch-on-mount. Same shape as `SkillMode.tsx`'s own mount effect: keep the stale graph on
  // failure and name the error, rather than clearing to the empty panel and implying "no hand-offs
  // ever happened" when the truth is "the request failed".
  useEffect(() => {
    let cancelled = false
    void fetchCommunicationGraph(workspaceId)
      .then((data) => {
        if (!cancelled) {
          setGraph(data)
          setErrorText(null)
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setErrorText(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  // Debounced stream refetch (Task 12) -- identical shape to `SkillMode.tsx`'s own `tickRef`
  // effect, see that component's doc comment for why this is the smaller diff over a second poll.
  // `tickRef` starts equal to the incoming prop so the FIRST render never schedules a refetch of
  // its own -- only a prop CHANGE after mount does; the mount effect above already owns the very
  // first fetch.
  const tickRef = useRef(frameTick)
  useEffect(() => {
    if (frameTick === tickRef.current) return
    tickRef.current = frameTick
    let cancelled = false
    const timer = setTimeout(() => {
      void fetchCommunicationGraph(workspaceId)
        .then((data) => {
          if (!cancelled) {
            setGraph(data)
            setErrorText(null)
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setErrorText(cause instanceof Error ? cause.message : String(cause))
        })
    }, COMM_REFETCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [frameTick, workspaceId])

  const { nodes, edges } = useMemo(() => buildCommunicationGraph(graph), [graph])
  const { nodes: positioned, edges: visibleEdges } = useLayoutedGraph(nodes, edges, 'layered')

  return (
    <div className="relative h-full w-full">
      {errorText !== null && (
        <div
          role="alert"
          data-testid="comm-error"
          className="absolute inset-x-0 top-0 z-10 border-b border-tone-blocked/40 bg-tone-blocked/10 px-4 py-1.5 text-xs text-tone-blocked"
        >
          {errorText}
        </div>
      )}
      {/* Gated on `graph.edges` -- the message is about hand-offs, not the roster, so the common
       *  real case (a seeded team with no traffic yet) still gets this explanation even though
       *  `graph.agents` and the canvas's agent/operator nodes are non-empty. Same "gate on the
       *  collection the sentence is actually about" idiom `DepsMode.tsx`'s own empty band uses
       *  (`snapshot.dependencies.length === 0` for "no dependencies yet", not `snapshot.tasks`). */}
      {graph.edges.length === 0 && (
        <div
          data-testid="comm-empty"
          className="pointer-events-none absolute inset-x-0 top-10 z-10 text-center text-xs text-text-3"
        >
          no hand-offs yet — edges appear as tasks move between agents
        </div>
      )}
      <GraphCanvas nodes={positioned} edges={visibleEdges} nodeTypes={COMM_NODE_TYPES} />
    </div>
  )
}
