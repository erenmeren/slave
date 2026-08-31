// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReactFlowProvider, type Node, type NodeProps } from 'reactflow'
import type { GraphCanvasProps } from '../src/components/graph/GraphCanvas.js'
import { buildSkillAggregateGraph, SKILL_NODE_PREFIX, skillProminence, type SkillNodeData } from '../src/components/graph/SkillNodes.js'
import type { GraphSnapshot } from '../src/server/graph.js'
import type { SkillGraph } from '../src/server/skillGraph.js'

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
    const Renderer = props.nodeTypes.skill
    return (
      // `<Handle>` (rendered inside `SkillNode`) reads React Flow's zustand store off context --
      // `ReactFlowProvider` supplies that store without the real `<ReactFlow>` component.
      <ReactFlowProvider>
        <div data-testid="graph-canvas-stub">
          {props.nodes.map((node) => (
            <div key={node.id} data-testid={`node-${node.id}`}>
              {Renderer ? <Renderer {...nodeProps(node)} /> : null}
            </div>
          ))}
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
  agents: [],
  tasks: [],
  dependencies: [],
  shellFacts: {
    workspace: { id: 'w1', name: 'W' },
    counts: { agentsWorking: 0, tasksActive: 0 },
    guardrails: { budgetUsd: null, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
  },
}

// Same "small factory, spread overrides" fixture idiom `graph-exec.test.ts`'s own `snapshot()`/
// `task()` helpers use.
function skillGraph(overrides: Partial<SkillGraph> = {}): SkillGraph {
  return { skills: [], edges: [], runs: [], ...overrides }
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
  let SkillMode: (props: { workspaceId: string; snapshot: GraphSnapshot }) => ReactElement
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
})
