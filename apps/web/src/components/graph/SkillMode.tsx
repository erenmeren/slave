'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { GraphSnapshot } from '../../server/graph'
import type { SkillGraph, SkillGraphRun } from '../../server/skillGraph'
import { TONE_DOT } from '../ui/StatusPill'
import { GraphCanvas } from './GraphCanvas'
import { useLayoutedGraph } from './layout'
import { buildSkillAggregateGraph, buildSkillChainGraph, SKILL_NODE_TYPES } from './SkillNodes'

/** The DTO's own honest zero state (M18 design doc §6, "Empty state") -- also this component's
 *  initial state, before the fetch below has resolved. A workspace whose skill graph genuinely
 *  has zero calls and one that simply hasn't answered yet render identically for that one gap:
 *  the same panel a moment later either stays (truly empty) or gives way to the real graph. */
const EMPTY_GRAPH: SkillGraph = { skills: [], edges: [], runs: [] }

/** Debounce window for the stream-driven refetch below (Task 12) -- deliberately much wider than
 *  `useWorkspaceStream`'s own 250ms debounce: a busy run fires one `run.tool_call` frame PER Skill
 *  call, and this view's own fetch is a heavier aggregate query (`buildSkillGraph`'s bounded-run
 *  scan), not a cheap per-workspace snapshot -- a burst of frames from one run must collapse into
 *  one re-fetch, not a fetch per frame. */
const SKILL_REFETCH_DEBOUNCE_MS = 2_000

async function fetchSkillGraph(workspaceId: string): Promise<SkillGraph> {
  const response = await fetch(`/api/w/${workspaceId}/skill-graph`)
  if (!response.ok) throw new Error(`skill graph failed: ${response.status} ${await response.text()}`)
  return (await response.json()) as SkillGraph
}

/** `taskTitle ?? runId-prefix` -- the same 8-char id-prefix convention `TaskCard.tsx`/
 *  `SlaveCard.tsx` use for `TASK-{id.slice(0, 8)}`, reused here for a run with no task title
 *  (a directly-dispatched run, or a task whose title hasn't loaded) rather than showing the full
 *  UUID or nothing at all. */
function runChipLabel(run: SkillGraphRun): string {
  return run.taskTitle ?? run.runId.slice(0, 8)
}

/**
 * The run-selector strip (Task 12, M18 design doc §6's "Focus" half): one mono chip per
 * `graph.runs` entry, `taskTitle ?? runId-prefix · slaveName` plus a live dot -- the same
 * `slaveDot`/`DOT` idiom `OrgNodes.tsx`'s `SlaveNode`/`SlavePanel.tsx` already render a status dot
 * with (`inline-block h-2 w-2 rounded-full`, pulsing only while genuinely live), reused here off
 * `SkillGraphRun.live` directly rather than a full `SlaveStatus` (this DTO carries only the
 * boolean -- `NON_TERMINAL_RUN_STATUSES.includes(run.status)`, computed server-side).
 *
 * A horizontally-scrolling strip (not a wrap) -- `SKILL_GRAPH_RUN_LIMIT` (50) runs could otherwise
 * flood several rows over the canvas; `overflow-x-auto` keeps it to one line, same footprint
 * regardless of how many runs the workspace has.
 */
function RunSelectorStrip({
  runs,
  focusedRunId,
  onSelect,
  onClear,
}: {
  readonly runs: readonly SkillGraphRun[]
  readonly focusedRunId: string | null
  readonly onSelect: (runId: string) => void
  readonly onClear: () => void
}): React.JSX.Element | null {
  if (runs.length === 0) return null
  return (
    <div className="pointer-events-none flex items-center gap-1.5 overflow-x-auto px-3 py-2">
      {focusedRunId !== null && (
        <button
          type="button"
          data-testid="skill-focus-clear"
          onClick={onClear}
          className="pointer-events-auto shrink-0 rounded-chip border border-line bg-bg-1 px-2 py-1 font-mono text-[10px] text-text-2 hover:border-white/20 hover:text-text-1"
        >
          ← aggregate
        </button>
      )}
      {runs.map((run) => {
        const selected = run.runId === focusedRunId
        return (
          <button
            key={run.runId}
            type="button"
            data-testid="skill-run-chip"
            aria-current={selected ? 'true' : undefined}
            onClick={() => onSelect(run.runId)}
            className={`pointer-events-auto flex shrink-0 items-center gap-1.5 rounded-chip border px-2 py-1 font-mono text-[10px] ${
              selected ? 'border-tone-planning/40 bg-tone-planning/10 text-tone-planning' : 'border-line bg-bg-1 text-text-2 hover:border-white/20 hover:text-text-1'
            }`}
          >
            <span
              data-testid="skill-run-chip-dot"
              className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${run.live ? `${TONE_DOT.working} animate-pulse` : TONE_DOT.idle}`}
            />
            <span className="truncate">{runChipLabel(run)}</span>
            <span className="text-text-3">· {run.slaveName}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * Skill chain mode (Task 11's Aggregate canvas, M18 design doc §6 -- plus Task 12's "Focus" half:
 * a run-selector strip that swaps the canvas from the cross-run aggregate to one run's own
 * left-to-right chain). On the same `DepsMode.tsx:52-162` template every sibling mode follows: an
 * absolute error band (`role="alert"`) and an absolute empty-state hint stack over an
 * ALWAYS-rendered `GraphCanvas` (never a conditionally-omitted one -- an empty result is still a
 * real, explained canvas, not a blank one).
 *
 * Unlike `DepsMode`/`ExecutionMode` (which receive an already-fetched `GraphSnapshot`), this mode
 * owns its own fetch: `snapshot` is accepted only for prop-shape parity with its siblings (every
 * mode in `GraphClient.tsx`'s render slot takes `{ workspaceId, snapshot }`), and is not read --
 * the skill graph is a SIBLING DTO to `GraphSnapshot` (M18 design doc §6: "New SIBLING builder --
 * NOT a `GraphSnapshot` widening"), fetched from Task 10's own route,
 * `/api/w/<workspaceId>/skill-graph`.
 *
 * `toolCallTick` is Task 12's stream-refetch wiring: `GraphClient` already opens the workspace's
 * one `EventSource` (`useGraph`) and already threads every raw frame through its own
 * `onGraphEvent` (org mode's particle spawn rides the exact same path, `flow.ts`'s
 * `handleToolCallFrame`) -- rather than opening a SECOND connection here, or growing `useGraph`'s
 * own API with a skill-specific callback, `GraphClient` bumps a plain counter once per
 * `run.tool_call` frame and hands it down as a prop. This is the smaller diff of the brief's two
 * sanctioned shapes (thread the raw-frame path vs. a 30s poll): `onGraphEvent` already exists and
 * already receives every frame this view needs to react to, so reusing it costs one `useState` +
 * one `if` in `GraphClient` and nothing new in the stream layer itself, versus a poll that would
 * duplicate a "refetch on an interval while the tab is active" mechanism `useWorkspaceStream`
 * effectively already provides (its own 250ms-debounced refetch-on-any-event, which every mode
 * already benefits from for the SNAPSHOT -- only the skill graph, a sibling DTO, has no live
 * subscriber of its own to ride that debounce).
 */
export function SkillMode({
  workspaceId,
  snapshot: _snapshot,
  toolCallTick = 0,
}: {
  readonly workspaceId: string
  readonly snapshot: GraphSnapshot
  toolCallTick?: number
}): React.JSX.Element {
  const [graph, setGraph] = useState<SkillGraph>(EMPTY_GRAPH)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null)

  // Fetch-on-mount. Same shape as `useWorkspaceStream.ts`'s own `refetch`: keep the stale graph on
  // failure and name the error, rather than clearing to the empty panel and implying "no calls ever
  // happened" when the truth is "the request failed".
  useEffect(() => {
    let cancelled = false
    void fetchSkillGraph(workspaceId)
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

  // Debounced stream refetch (Task 12, see this component's own doc comment for the shape choice).
  // `tickRef` starts equal to the incoming prop so the FIRST render never schedules a refetch of
  // its own -- only a prop CHANGE after mount does; the mount effect above already owns the very
  // first fetch. Each subsequent tick change tears down the previous pending timer (React's own
  // effect-cleanup-then-rerun order) and starts a fresh one, which IS the debounce: a burst of
  // ticks inside one window collapses to the single timer that survives to fire.
  const tickRef = useRef(toolCallTick)
  useEffect(() => {
    if (toolCallTick === tickRef.current) return
    tickRef.current = toolCallTick
    let cancelled = false
    const timer = setTimeout(() => {
      void fetchSkillGraph(workspaceId)
        .then((data) => {
          if (!cancelled) {
            setGraph(data)
            setErrorText(null)
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setErrorText(cause instanceof Error ? cause.message : String(cause))
        })
    }, SKILL_REFETCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [toolCallTick, workspaceId])

  // Selection is a runId, not the run object itself, so a refetch that changes a run's own fields
  // (a fresh live dot, an extended chain) is picked up automatically -- and a run that fell out of
  // the bounded `SKILL_GRAPH_RUN_LIMIT` window on refetch quietly reverts the focus to `null`
  // (`focusedRun` below), the honest "that run isn't in view anymore" fallback rather than showing
  // a stale chain.
  const focusedRun = focusedRunId === null ? null : (graph.runs.find((run) => run.runId === focusedRunId) ?? null)

  const { nodes, edges } = useMemo(
    () => (focusedRun !== null ? buildSkillChainGraph(focusedRun) : buildSkillAggregateGraph(graph)),
    [graph, focusedRun],
  )
  const { nodes: positioned, edges: visibleEdges } = useLayoutedGraph(nodes, edges, 'layered')

  return (
    <div className="relative h-full w-full">
      {/* Error band and run strip share one absolute-top stacking column (rather than each being
       *  independently `top-0`) so a debounced refetch failure -- possible with runs already
       *  loaded from an earlier successful fetch -- never draws the two on top of each other. */}
      <div className="absolute inset-x-0 top-0 z-10 flex flex-col">
        {errorText !== null && (
          <div role="alert" data-testid="skill-error" className="border-b border-tone-blocked/40 bg-tone-blocked/10 px-4 py-1.5 text-xs text-tone-blocked">
            {errorText}
          </div>
        )}
        <RunSelectorStrip
          runs={graph.runs}
          // `focusedRun?.runId`, not the raw `focusedRunId` state -- a run that fell out of the
          // bounded window on refetch (see `focusedRun`'s own comment below) already reverted the
          // CANVAS to the aggregate; this keeps the STRIP in agreement (no chip highlighted, no
          // "← aggregate" clear control dangling for a run that no longer resolves to anything).
          focusedRunId={focusedRun?.runId ?? null}
          onSelect={setFocusedRunId}
          onClear={() => setFocusedRunId(null)}
        />
      </div>
      {graph.skills.length === 0 && (
        <div
          data-testid="skill-empty"
          className="pointer-events-none absolute inset-x-0 top-10 z-10 text-center text-xs text-text-3"
        >
          no skill calls recorded yet — runs record their skills as they use them
        </div>
      )}
      <GraphCanvas nodes={positioned} edges={visibleEdges} nodeTypes={SKILL_NODE_TYPES} />
    </div>
  )
}
