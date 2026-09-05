// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Position, ReactFlowProvider, type EdgeProps, type Node, type NodeProps } from 'reactflow'
import type { GraphCanvasProps } from '../src/components/graph/GraphCanvas.js'
import {
  buildSkillAggregateGraph,
  buildSkillChainGraph,
  SKILL_NODE_PREFIX,
  SKILLSTEP_NODE_PREFIX,
  skillProminence,
  type SkillNodeData,
} from '../src/components/graph/SkillNodes.js'
import { CableEdge, type CableEdgeData } from '../src/components/graph/CableEdge.js'
import type { GraphSnapshot } from '../src/server/graph.js'
import type { SkillGraph, SkillGraphRun } from '../src/server/skillGraph.js'

// ---- GraphCanvas stub -------------------------------------------------------------------------
// Same split `graph-deps.test.tsx` takes for `DepsMode`: `SkillMode` renders through the real
// `GraphCanvas` in production, but that component is just a thin passthrough onto React Flow
// (Task 5 report) -- this stub captures exactly what `SkillMode` hands it (nodes, edges,
// `nodeTypes`) and renders the `skill` type's own component directly, so this file exercises
// `SkillNode`'s real markup without needing jsdom's `ResizeObserver`/`DOMMatrixReadOnly` shims
// (those exist only for React Flow's own DOM measurement, never reached through this stub).
const graphCanvasCalls: GraphCanvasProps[] = []

function nodeProps(node: Node): NodeProps {
  return {
    id: node.id,
    data: node.data as never,
    type: node.type ?? '',
    selected: false,
    isConnectable: true,
    xPos: node.position.x,
    yPos: node.position.y,
    zIndex: 0,
    dragging: false,
  }
}

vi.mock('../src/components/graph/GraphCanvas.js', () => ({
  GraphCanvas: (props: GraphCanvasProps) => {
    graphCanvasCalls.push(props)
    return (
      // `<Handle>` (rendered inside `SkillNode`/`SkillStepNode`) reads React Flow's zustand store
      // off context -- `ReactFlowProvider` supplies that store without the real `<ReactFlow>`
      // component. Looked up per-node by its own `type` (not just `.skill`) -- Task 12 adds a
      // second node type (`skillstep`) this same stub must render too, for the Focus view.
      <ReactFlowProvider>
        <div data-testid="graph-canvas-stub">
          {props.nodes.map((node) => {
            const Renderer = props.nodeTypes[node.type ?? '']
            return (
              <div key={node.id} data-testid={`node-${node.id}`}>
                {Renderer ? <Renderer {...nodeProps(node)} /> : null}
              </div>
            )
          })}
          {props.edges.map((edge) => (
            <div key={edge.id} data-testid={`edge-${edge.id}`} />
          ))}
        </div>
      </ReactFlowProvider>
    )
  },
}))

// `layout.ts` calls the real ELK adapter regardless of the `GraphCanvas` stub above -- mocked
// here purely for determinism/speed, same fixture shape as `graph-deps.test.tsx`'s own spy.
const elkLayoutSpy = vi.fn(async (graph: { children?: { id: string }[] }) => ({
  ...graph,
  children: (graph.children ?? []).map((child, index) => ({ ...child, x: index * 200, y: 0 })),
}))
vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: class {
    layout(graph: { children?: { id: string }[] }): Promise<unknown> {
      return elkLayoutSpy(graph)
    }
  },
}))

// A minimal `GraphSnapshot` -- `SkillMode` takes it only for prop-shape parity with its siblings
// (`DepsMode`/`ExecutionMode`, both `{ workspaceId, snapshot }`) and never reads it: the skill
// graph is its own sibling DTO, fetched from Task 10's route on mount.
const SNAPSHOT: GraphSnapshot = {
  workspace: { id: 'w1', name: 'W', haltedReason: null },
  teams: [],
  slaves: [],
  tasks: [],
  dependencies: [],
  shellFacts: {
    workspace: { id: 'w1', name: 'W' },
    counts: { slavesWorking: 0, tasksActive: 0 },
    guardrails: { budgetUsd: null, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
    status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
  },
}

// Same "small factory, spread overrides" fixture idiom `graph-exec.test.ts`'s own `snapshot()`/
// `task()` helpers use.
function skillGraph(overrides: Partial<SkillGraph> = {}): SkillGraph {
  return { skills: [], edges: [], runs: [], ...overrides }
}

function skillGraphRun(overrides: Partial<SkillGraphRun> = {}): SkillGraphRun {
  return {
    runId: 'run-1',
    taskTitle: 'Ship the thing',
    slaveName: 'builder',
    live: false,
    startedAt: '2026-08-31T00:00:00.000Z',
    chain: [],
    ...overrides,
  }
}

// ==================================================================================================
// buildSkillAggregateGraph -- pure, no DOM. Purity/order/prefix/types (Step 5 of the Task 11 brief).
// ==================================================================================================

describe('buildSkillAggregateGraph', () => {
  const GRAPH: SkillGraph = skillGraph({
    skills: [
      { name: 'brainstorming', calls: 2 },
      { name: 'test-driven-development', calls: 9 },
      { name: 'writing-plans', calls: 5 },
    ],
    edges: [
      { from: 'brainstorming', to: 'writing-plans', count: 2 },
      { from: 'writing-plans', to: 'test-driven-development', count: 2 },
    ],
  })

  it("emits one skill:-prefixed node per skill entry, in the server's own order", () => {
    const { nodes } = buildSkillAggregateGraph(GRAPH)
    expect(nodes.map((node) => node.id)).toEqual(['skill:brainstorming', 'skill:test-driven-development', 'skill:writing-plans'])
    expect(nodes.every((node) => node.type === 'skill')).toBe(true)
    expect(nodes.every((node) => node.id.startsWith(SKILL_NODE_PREFIX))).toBe(true)
  })

  it('leaves every node at the origin — topology and data only, never coordinates (ELK owns position)', () => {
    const { nodes } = buildSkillAggregateGraph(GRAPH)
    expect(nodes.every((node) => node.position.x === 0 && node.position.y === 0)).toBe(true)
  })

  it("stamps calls and the call-count-bucketed prominence on each node's data", () => {
    const { nodes } = buildSkillAggregateGraph(GRAPH)
    const byName = new Map(nodes.map((node) => [(node.data as SkillNodeData).name, node.data as SkillNodeData]))
    expect(byName.get('brainstorming')).toMatchObject({ calls: 2, prominence: 'small' })
    expect(byName.get('writing-plans')).toMatchObject({ calls: 5, prominence: 'medium' })
    expect(byName.get('test-driven-development')).toMatchObject({ calls: 9, prominence: 'large' })
  })

  it('builds one cable edge per succession pair (from -> to), fixed planning tone, always inactive in the aggregate view', () => {
    const { edges } = buildSkillAggregateGraph(GRAPH)
    expect(edges.map((edge) => edge.id)).toEqual([
      'skill:brainstorming->skill:writing-plans',
      'skill:writing-plans->skill:test-driven-development',
    ])
    expect(edges.every((edge) => edge.type === 'cable')).toBe(true)
    expect(edges.every((edge) => (edge.data as { tone: string }).tone === 'planning')).toBe(true)
    expect(edges.every((edge) => (edge.data as { active: boolean }).active === false)).toBe(true)
  })

  it('is pure — two calls on the same input produce deep-equal, independently-mutable output', () => {
    const once = buildSkillAggregateGraph(GRAPH)
    const twice = buildSkillAggregateGraph(GRAPH)
    expect(once).toEqual(twice)
    once.nodes[0]!.position.x = 999
    expect(twice.nodes[0]!.position.x).toBe(0)
  })

  it('returns no nodes and no edges for the empty DTO', () => {
    expect(buildSkillAggregateGraph(skillGraph())).toEqual({ nodes: [], edges: [] })
  })

  it("stamps each edge's raw succession count onto data.weight, for CableEdge to render as thickness (C3)", () => {
    const { edges } = buildSkillAggregateGraph(GRAPH)
    expect(edges.map((edge) => (edge.data as { weight: number }).weight)).toEqual([2, 2])
  })
})

// ==================================================================================================
// Cable thickness -- C3: an aggregate edge's `weight` (the server's raw succession count) renders as
// the cable's stroke width. Rendered through the real `CableEdge`, not the `GraphCanvas` stub above
// (which only stands in a `data-testid` div per edge) -- same "render the real edge component"
// approach `graph-flow.test.tsx`'s own `CableEdge` describe block takes, fed here with the exact
// `data` `buildSkillAggregateGraph` produces.
// ==================================================================================================

describe('cable thickness from edge weight (C3)', () => {
  const GEOMETRY = {
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 100,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
  }

  it('renders a heavier edge (count 4) with a thicker core than a lighter one (count 1), attribute and inline style agreeing', () => {
    const graph = skillGraph({
      skills: [
        { name: 'a', calls: 1 },
        { name: 'b', calls: 1 },
        { name: 'c', calls: 1 },
      ],
      edges: [
        { from: 'a', to: 'b', count: 1 },
        { from: 'b', to: 'c', count: 4 },
      ],
    })
    const { edges } = buildSkillAggregateGraph(graph)
    expect(edges).toHaveLength(2)

    const { container } = render(
      <svg>
        <CableEdge {...({ ...GEOMETRY, id: edges[0]!.id, data: edges[0]!.data } as unknown as EdgeProps<CableEdgeData>)} />
        <CableEdge {...({ ...GEOMETRY, id: edges[1]!.id, data: edges[1]!.data } as unknown as EdgeProps<CableEdgeData>)} />
      </svg>,
    )

    const cores = container.querySelectorAll('path.react-flow__edge-path')
    expect(cores).toHaveLength(2)
    const light = cores[0] as SVGPathElement
    const heavy = cores[1] as SVGPathElement

    // The attribute and the inline style must agree -- React Flow's own stylesheet outranks the
    // attribute, so a mismatch here would render correctly in this DOM read but wrong on the page.
    expect(light.getAttribute('stroke-width')).toBe(light.style.strokeWidth)
    expect(heavy.getAttribute('stroke-width')).toBe(heavy.style.strokeWidth)

    expect(light.style.strokeWidth).not.toBe(heavy.style.strokeWidth)
    expect(Number(heavy.style.strokeWidth)).toBeGreaterThan(Number(light.style.strokeWidth))
  })

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY]])(
    'renders the default width, never "NaN", for the non-finite weight %s (M21 C4)',
    (weight) => {
      const graph = skillGraph({ skills: [{ name: 'a', calls: 1 }, { name: 'b', calls: 1 }], edges: [{ from: 'a', to: 'b', count: 1 }] })
      const { edges } = buildSkillAggregateGraph(graph)
      const data = { ...edges[0]!.data, weight }
      const { container } = render(
        <svg>
          <CableEdge {...({ ...GEOMETRY, id: edges[0]!.id, data } as unknown as EdgeProps<CableEdgeData>)} />
        </svg>,
      )
      const core = container.querySelector('path.react-flow__edge-path') as SVGPathElement
      expect(core.style.strokeWidth).toBe('3')
    },
  )
})

// ==================================================================================================
// buildSkillChainGraph -- pure, no DOM. Order, badge, single-step (Task 12).
// ==================================================================================================

describe('buildSkillChainGraph', () => {
  it("emits one skillstep:<i>-prefixed node per collapsed chain entry, in the run's own left-to-right order", () => {
    const run = skillGraphRun({
      chain: [
        { name: 'brainstorming', count: 1 },
        { name: 'writing-plans', count: 1 },
        { name: 'test-driven-development', count: 3 },
      ],
    })
    const { nodes } = buildSkillChainGraph(run)
    expect(nodes.map((node) => node.id)).toEqual(['skillstep:0', 'skillstep:1', 'skillstep:2'])
    expect(nodes.every((node) => node.type === 'skillstep')).toBe(true)
    expect(nodes.every((node) => node.id.startsWith(SKILLSTEP_NODE_PREFIX))).toBe(true)
    expect(nodes.map((node) => (node.data as { name: string }).name)).toEqual(['brainstorming', 'writing-plans', 'test-driven-development'])
  })

  it('carries in-order edges, step i -> i+1, as fixed-planning-tone inactive cables', () => {
    const run = skillGraphRun({
      chain: [
        { name: 'a', count: 1 },
        { name: 'b', count: 1 },
        { name: 'c', count: 1 },
      ],
    })
    const { edges } = buildSkillChainGraph(run)
    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([
      ['skillstep:0', 'skillstep:1'],
      ['skillstep:1', 'skillstep:2'],
    ])
    expect(edges.every((edge) => edge.type === 'cable')).toBe(true)
    expect(edges.every((edge) => (edge.data as { tone: string }).tone === 'planning')).toBe(true)
    expect(edges.every((edge) => (edge.data as { active: boolean }).active === false)).toBe(true)
  })

  it("stamps each step's own collapsed count on its data, for the ×N badge", () => {
    const run = skillGraphRun({
      chain: [
        { name: 'brainstorming', count: 1 },
        { name: 'test-driven-development', count: 4 },
      ],
    })
    const { nodes } = buildSkillChainGraph(run)
    expect(nodes.map((node) => (node.data as { count: number }).count)).toEqual([1, 4])
  })

  it('renders one node and zero edges for a single-skill run -- not an error, the shortest possible chain', () => {
    const run = skillGraphRun({ chain: [{ name: 'brainstorming', count: 2 }] })
    const { nodes, edges } = buildSkillChainGraph(run)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]!.id).toBe('skillstep:0')
    expect(edges).toEqual([])
  })

  it('returns no nodes and no edges for a run with an empty chain', () => {
    expect(buildSkillChainGraph(skillGraphRun({ chain: [] }))).toEqual({ nodes: [], edges: [] })
  })
})

// ==================================================================================================
// skillProminence -- the pure bucket function (Step 1: "NOT free-form scaling").
// ==================================================================================================

describe('skillProminence', () => {
  it('buckets 0-2 calls as small', () => {
    expect(skillProminence(0)).toBe('small')
    expect(skillProminence(1)).toBe('small')
    expect(skillProminence(2)).toBe('small')
  })

  it('buckets 3-7 calls as medium', () => {
    expect(skillProminence(3)).toBe('medium')
    expect(skillProminence(7)).toBe('medium')
  })

  it('buckets 8 and above as large, unbounded', () => {
    expect(skillProminence(8)).toBe('large')
    expect(skillProminence(500)).toBe('large')
  })
})

// ==================================================================================================
// SkillMode -- fetches its own DTO on mount, empty state, error band (Step 2/5).
// ==================================================================================================

describe('SkillMode', () => {
  let SkillMode: (props: { workspaceId: string; snapshot: GraphSnapshot; toolCallTick?: number }) => ReactElement
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    graphCanvasCalls.length = 0
    elkLayoutSpy.mockClear()
    fetchMock = vi.fn(async () => new Response(JSON.stringify(skillGraph()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    ;({ SkillMode } = await import('../src/components/graph/SkillMode.js'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    // Safe no-op when a test never switched to fake timers -- guards the refetch-debounce test
    // below from leaking fake timers into whichever test runs next.
    vi.useRealTimers()
  })

  it("fetches Task 10's own route for its workspace on mount", async () => {
    render(<SkillMode workspaceId="w7" snapshot={SNAPSHOT} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/w/w7/skill-graph'))
  })

  it('renders one skill node per fetched skill, named + call-counted, sized by its own prominence bucket', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          skillGraph({
            skills: [
              { name: 'brainstorming', calls: 2 },
              { name: 'test-driven-development', calls: 9 },
            ],
            edges: [{ from: 'brainstorming', to: 'test-driven-development', count: 2 }],
          }),
        ),
        { status: 200 },
      ),
    )
    render(<SkillMode workspaceId="w1" snapshot={SNAPSHOT} />)

    await waitFor(() => expect(screen.getByTestId('node-skill:brainstorming')).toBeTruthy())

    const small = screen.getByTestId('node-skill:brainstorming').querySelector('[data-testid="skill-node"]')!
    expect(small.getAttribute('data-prominence')).toBe('small')
    expect(small.querySelector('[data-testid="skill-node-name"]')?.textContent).toBe('brainstorming')
    expect(small.querySelector('[data-testid="skill-node-calls"]')?.textContent).toBe('2 calls')

    const large = screen.getByTestId('node-skill:test-driven-development').querySelector('[data-testid="skill-node"]')!
    expect(large.getAttribute('data-prominence')).toBe('large')
    expect(large.querySelector('[data-testid="skill-node-calls"]')?.textContent).toBe('9 calls')

    // Registered under the `skill` React Flow node type -- the `layout.ts` `DEFAULT_SIZE.skill`
    // entry this same task adds is what keeps this type's footprint out of the silent fallback.
    expect(graphCanvasCalls.at(-1)!.nodeTypes.skill).toBeDefined()
  })

  it('shows the honest empty panel — never a blank canvas — when the workspace has zero skill calls', async () => {
    render(<SkillMode workspaceId="w1" snapshot={SNAPSHOT} />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.getByTestId('skill-empty').textContent).toBe('no skill calls recorded yet — runs record their skills as they use them')
    // The canvas itself is still there (real, just empty of nodes) -- the stub's own container
    // always renders, matching `DepsMode`'s "hint stacks over an always-present canvas" idiom.
    expect(screen.getByTestId('graph-canvas-stub')).toBeTruthy()
  })

  it('a failed fetch renders its message in the error band, and the canvas stays up rather than going blank', async () => {
    fetchMock.mockResolvedValueOnce(new Response('workspace not found', { status: 404 }))
    render(<SkillMode workspaceId="w1" snapshot={SNAPSHOT} />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByTestId('skill-error').textContent).toContain('404')
    expect(screen.getByTestId('graph-canvas-stub')).toBeTruthy()
  })

  // Final review one-liner: `errorText` was set on a failed fetch but never cleared on a later
  // success -- a stale error band could sit over a now-healthy graph indefinitely.
  it('a failed fetch followed by a successful debounced refetch clears the error band', async () => {
    fetchMock.mockResolvedValueOnce(new Response('workspace not found', { status: 404 }))
    const { rerender } = render(<SkillMode workspaceId="w1" snapshot={SNAPSHOT} toolCallTick={0} />)
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByTestId('skill-error').textContent).toContain('404')

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(skillGraph()), { status: 200 }))
    vi.useFakeTimers()
    try {
      rerender(<SkillMode workspaceId="w1" snapshot={SNAPSHOT} toolCallTick={1} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100)
      })
    } finally {
      vi.useRealTimers()
    }

    await waitFor(() => expect(screen.queryByTestId('skill-error')).toBeNull())
  })

  // ================================================================================================
  // Run selector strip (Task 12): one chip per `graph.runs` entry, live dot from `run.live`.
  // ================================================================================================

  it('renders one run chip per graph.runs entry — taskTitle (or the runId prefix) · slaveName, plus a live dot', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          skillGraph({
            skills: [{ name: 'brainstorming', calls: 2 }],
            runs: [
              skillGraphRun({
                runId: 'run-live-1',
                taskTitle: 'Ship it',
                slaveName: 'builder',
                live: true,
                chain: [{ name: 'brainstorming', count: 1 }],
              }),
              skillGraphRun({
                runId: 'run-done1',
                taskTitle: null,
                slaveName: 'reviewer',
                live: false,
                chain: [{ name: 'brainstorming', count: 1 }],
              }),
            ],
          }),
        ),
        { status: 200 },
      ),
    )
    render(<SkillMode workspaceId="w1" snapshot={SNAPSHOT} />)

    const chips = await waitFor(() => {
      const found = screen.getAllByTestId('skill-run-chip')
      expect(found).toHaveLength(2)
      return found
    })

    expect(chips[0]!.textContent).toContain('Ship it')
    expect(chips[0]!.textContent).toContain('builder')
    // No taskTitle -- falls back to the 8-char runId prefix (`TASK-{id.slice(0,8)}`'s convention,
    // sans the "TASK-" -- this is a run, not a task).
    expect(chips[1]!.textContent).toContain('run-done1'.slice(0, 8))
    expect(chips[1]!.textContent).toContain('reviewer')

    const liveDot = chips[0]!.querySelector('[data-testid="skill-run-chip-dot"]')!
    expect(liveDot.className).toContain('animate-pulse')
    const idleDot = chips[1]!.querySelector('[data-testid="skill-run-chip-dot"]')!
    expect(idleDot.className).not.toContain('animate-pulse')
  })

  // ================================================================================================
  // Selection (Task 12): a chip click focuses the canvas on that run's chain; clear returns to the
  // aggregate. Both directions.
  // ================================================================================================

  it("selecting a run chip swaps the canvas to that run's chain; the clear control swaps it back to the aggregate", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          skillGraph({
            skills: [
              { name: 'brainstorming', calls: 3 },
              { name: 'writing-plans', calls: 1 },
            ],
            edges: [{ from: 'brainstorming', to: 'writing-plans', count: 1 }],
            runs: [
              skillGraphRun({
                runId: 'run-1',
                taskTitle: 'Ship it',
                slaveName: 'builder',
                chain: [
                  { name: 'brainstorming', count: 2 },
                  { name: 'writing-plans', count: 1 },
                ],
              }),
            ],
          }),
        ),
        { status: 200 },
      ),
    )
    render(<SkillMode workspaceId="w1" snapshot={SNAPSHOT} />)

    // Aggregate view first (default, nobody focused yet).
    await waitFor(() => expect(screen.getByTestId('node-skill:brainstorming')).toBeTruthy())
    expect(screen.queryByTestId('skill-focus-clear')).toBeNull()

    fireEvent.click(screen.getByTestId('skill-run-chip'))

    // Focus view: skillstep nodes, in order, the repeated step carrying its ×N badge; the
    // aggregate's own `skill:`-prefixed nodes are gone.
    await waitFor(() => expect(screen.getByTestId('node-skillstep:0')).toBeTruthy())
    expect(screen.getByTestId('node-skillstep:1')).toBeTruthy()
    expect(screen.queryByTestId('node-skill:brainstorming')).toBeNull()
    expect(
      screen.getByTestId('node-skillstep:0').querySelector('[data-testid="skillstep-node-badge"]')?.textContent,
    ).toBe('×2')
    expect(screen.getByTestId('node-skillstep:1').querySelector('[data-testid="skillstep-node-badge"]')).toBeNull()

    fireEvent.click(screen.getByTestId('skill-focus-clear'))

    // Back to the aggregate; the chain's skillstep nodes are gone.
    await waitFor(() => expect(screen.getByTestId('node-skill:brainstorming')).toBeTruthy())
    expect(screen.queryByTestId('node-skillstep:0')).toBeNull()
    expect(screen.queryByTestId('skill-focus-clear')).toBeNull()
  })

  // ================================================================================================
  // Refetch wiring (Task 12): a `toolCallTick` bump debounces a re-fetch by >=2s, and never fires
  // from the tick's own starting value on first render.
  // ================================================================================================

  it('debounces the stream-driven refetch by >=2s after toolCallTick changes, and not on first render', async () => {
    const { rerender } = render(<SkillMode workspaceId="w1" snapshot={SNAPSHOT} toolCallTick={0} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    vi.useFakeTimers()
    try {
      rerender(<SkillMode workspaceId="w1" snapshot={SNAPSHOT} toolCallTick={1} />)

      // Still inside the debounce window -- no second fetch yet.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)

      // Past the >=2s window -- the debounced refetch fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100)
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapses a burst of ticks inside one debounce window into a single refetch', async () => {
    const { rerender } = render(<SkillMode workspaceId="w1" snapshot={SNAPSHOT} toolCallTick={0} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    vi.useFakeTimers()
    try {
      rerender(<SkillMode workspaceId="w1" snapshot={SNAPSHOT} toolCallTick={1} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      rerender(<SkillMode workspaceId="w1" snapshot={SNAPSHOT} toolCallTick={2} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      // 2s have elapsed since the FIRST tick, but the second tick reset the debounce window --
      // still only the mount fetch so far.
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_100)
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
