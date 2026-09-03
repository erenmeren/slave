// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReactFlowProvider, type Node, type NodeProps } from 'reactflow'
import type { GraphCanvasProps } from '../src/components/graph/GraphCanvas.js'
import { buildCommunicationGraph } from '../src/components/graph/CommunicationNodes.js'
import type { CommunicationGraph } from '../src/server/communicationGraph.js'

// ---- GraphCanvas stub -------------------------------------------------------------------------
// Same split `graph-skill.test.tsx` takes for `SkillMode`: `CommunicationMode` renders through the
// real `GraphCanvas` in production, but that component is just a thin passthrough onto React Flow
// -- this stub captures exactly what `CommunicationMode` hands it (nodes, edges, `nodeTypes`) and
// renders each node type's own component directly, so this file exercises `CommAgentNode`/
// `OperatorNode`'s real markup without needing jsdom's `ResizeObserver`/`DOMMatrixReadOnly` shims.
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

// `layout.ts` calls the real ELK adapter regardless of the `GraphCanvas` stub above -- mocked here
// purely for determinism/speed, same fixture shape as `graph-skill.test.tsx`'s own spy.
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

// Same small-factory fixture idiom every graph test file uses.
function commGraph(overrides: Partial<CommunicationGraph> = {}): CommunicationGraph {
  return { agents: [], edges: [], ...overrides }
}

// ==================================================================================================
// buildCommunicationGraph -- pure, no DOM. Node ids, the always-present operator node, edge id
// format, tone-by-kind, weight = count.
// ==================================================================================================

describe('buildCommunicationGraph', () => {
  const GRAPH: CommunicationGraph = commGraph({
    agents: [
      { id: 'a1', name: 'Alex', role: 'backend' },
      { id: 'a2', name: 'Sam', role: 'reviewer' },
    ],
    edges: [
      { from: 'a1', to: 'a2', count: 3, kind: 'plan' },
      { from: 'operator', to: 'a1', count: 1, kind: 'message' },
    ],
  })

  it('emits one agent:<id>-prefixed node per agent, plus one operator node, always', () => {
    const { nodes } = buildCommunicationGraph(GRAPH)
    expect(nodes.map((node) => node.id)).toEqual(['agent:a1', 'agent:a2', 'operator'])
    expect(nodes.find((node) => node.id === 'agent:a1')?.type).toBe('commAgent')
    expect(nodes.find((node) => node.id === 'operator')?.type).toBe('operator')
  })

  it("stamps each agent node's name and role on its data", () => {
    const { nodes } = buildCommunicationGraph(GRAPH)
    const a1 = nodes.find((node) => node.id === 'agent:a1')!
    expect(a1.data).toMatchObject({ name: 'Alex', role: 'backend' })
    const a2 = nodes.find((node) => node.id === 'agent:a2')!
    expect(a2.data).toMatchObject({ name: 'Sam', role: 'reviewer' })
  })

  it('leaves every node at the origin -- topology and data only, never coordinates (ELK owns position)', () => {
    const { nodes } = buildCommunicationGraph(GRAPH)
    expect(nodes.every((node) => node.position.x === 0 && node.position.y === 0)).toBe(true)
  })

  it('always emits the operator node, even for the empty DTO', () => {
    const { nodes, edges } = buildCommunicationGraph(commGraph())
    expect(nodes.map((node) => node.id)).toEqual(['operator'])
    expect(edges).toEqual([])
  })

  it('builds one cable edge per graph.edges entry, id `<source>-><target>:<kind>`, type cable', () => {
    const { edges } = buildCommunicationGraph(GRAPH)
    expect(edges.map((edge) => edge.id)).toEqual(['agent:a1->agent:a2:plan', 'operator->agent:a1:message'])
    expect(edges.every((edge) => edge.type === 'cable')).toBe(true)
    expect(edges.map((edge) => [edge.source, edge.target])).toEqual([
      ['agent:a1', 'agent:a2'],
      ['operator', 'agent:a1'],
    ])
  })

  it('every edge is inactive -- this view has no notion of an edge currently in flight', () => {
    const { edges } = buildCommunicationGraph(GRAPH)
    expect(edges.every((edge) => (edge.data as { active: boolean }).active === false)).toBe(true)
  })

  it('stamps each edge\'s raw count onto data.weight, for CableEdge to render as thickness', () => {
    const { edges } = buildCommunicationGraph(GRAPH)
    expect(edges.map((edge) => (edge.data as { weight: number }).weight)).toEqual([3, 1])
  })

  it('maps each CommunicationEdgeKind to its StatusTone: plan -> planning, review -> working, rework -> waiting, message -> idle', () => {
    const graph = commGraph({
      agents: [
        { id: 'a1', name: 'Alex', role: 'backend' },
        { id: 'a2', name: 'Sam', role: 'reviewer' },
      ],
      edges: [
        { from: 'a1', to: 'a2', count: 1, kind: 'plan' },
        { from: 'a1', to: 'a2', count: 1, kind: 'review' },
        { from: 'a1', to: 'a2', count: 1, kind: 'rework' },
        { from: 'a1', to: 'a2', count: 1, kind: 'message' },
      ],
    })
    const { edges } = buildCommunicationGraph(graph)
    expect(edges.map((edge) => (edge.data as { tone: string }).tone)).toEqual(['planning', 'working', 'waiting', 'idle'])
  })

  it('is pure -- two calls on the same input produce deep-equal, independently-mutable output', () => {
    const once = buildCommunicationGraph(GRAPH)
    const twice = buildCommunicationGraph(GRAPH)
    expect(once).toEqual(twice)
    once.nodes[0]!.position.x = 999
    expect(twice.nodes[0]!.position.x).toBe(0)
  })
})

// ==================================================================================================
// CommunicationMode -- fetches its own DTO on mount, empty state, N nodes + edges, debounced refetch.
// ==================================================================================================

describe('CommunicationMode', () => {
  let CommunicationMode: (props: { workspaceId: string; frameTick?: number }) => ReactElement
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    graphCanvasCalls.length = 0
    elkLayoutSpy.mockClear()
    fetchMock = vi.fn(async () => new Response(JSON.stringify(commGraph()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    ;({ CommunicationMode } = await import('../src/components/graph/CommunicationMode.js'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    // Safe no-op when a test never switched to fake timers -- guards the refetch-debounce test
    // below from leaking fake timers into whichever test runs next.
    vi.useRealTimers()
  })

  it("fetches the workspace's communication graph route on mount", async () => {
    render(<CommunicationMode workspaceId="w1" />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/graph/communication'))
  })

  it('shows the honest empty panel -- never a blank canvas -- when the workspace has zero hand-offs', async () => {
    render(<CommunicationMode workspaceId="w1" />)

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(screen.getByTestId('comm-empty').textContent).toBe('no hand-offs yet — edges appear as tasks move between agents')
    // The canvas itself is still there (real, just empty of agent nodes) -- the stub's own
    // container always renders, matching every sibling mode's "hint stacks over an always-present
    // canvas" idiom.
    expect(screen.getByTestId('graph-canvas-stub')).toBeTruthy()
  })

  // Fix round 1: the band is about HAND-OFFS, not the roster -- a seeded team with zero traffic
  // yet (agents present, edges empty) is exactly the state the sentence was written for, and must
  // still show it, with the agent/operator nodes rendered right alongside it (the canvas is never
  // omitted, same as every other empty case).
  it('shows the empty panel for a non-empty roster with zero edges, alongside the rendered agent nodes', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          commGraph({
            agents: [
              { id: 'a1', name: 'Alex', role: 'backend' },
              { id: 'a2', name: 'Sam', role: 'reviewer' },
            ],
            edges: [],
          }),
        ),
        { status: 200 },
      ),
    )
    render(<CommunicationMode workspaceId="w1" />)

    await waitFor(() => expect(screen.getByTestId('node-agent:a1')).toBeTruthy())

    expect(screen.getByTestId('comm-empty').textContent).toBe('no hand-offs yet — edges appear as tasks move between agents')
    expect(screen.getByTestId('node-agent:a1').querySelector('[data-testid="comm-agent-node"]')?.textContent).toContain('Alex')
    expect(screen.getByTestId('node-agent:a2').querySelector('[data-testid="comm-agent-node"]')?.textContent).toContain('Sam')
    expect(screen.getByTestId('node-operator')).toBeTruthy()
    expect(screen.queryAllByTestId(/^edge-/)).toHaveLength(0)
  })

  it('renders N agent nodes, one operator node, and one edge per fetched two-edge graph', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify(
          commGraph({
            agents: [
              { id: 'a1', name: 'Alex', role: 'backend' },
              { id: 'a2', name: 'Sam', role: 'reviewer' },
            ],
            edges: [
              { from: 'a1', to: 'a2', count: 2, kind: 'review' },
              { from: 'operator', to: 'a1', count: 1, kind: 'message' },
            ],
          }),
        ),
        { status: 200 },
      ),
    )
    render(<CommunicationMode workspaceId="w1" />)

    await waitFor(() => expect(screen.getByTestId('node-agent:a1')).toBeTruthy())

    expect(screen.getByTestId('node-agent:a1').querySelector('[data-testid="comm-agent-node"]')?.textContent).toContain('Alex')
    expect(screen.getByTestId('node-agent:a1').querySelector('[data-testid="comm-agent-node"]')?.textContent).toContain('backend')
    expect(screen.getByTestId('node-agent:a2').querySelector('[data-testid="comm-agent-node"]')?.textContent).toContain('Sam')
    expect(screen.getByTestId('node-operator').querySelector('[data-testid="operator-node"]')?.textContent).toContain('operator')

    expect(screen.queryAllByTestId(/^node-/)).toHaveLength(3) // two agents + the always-present operator
    expect(screen.getByTestId('edge-agent:a1->agent:a2:review')).toBeTruthy()
    expect(screen.getByTestId('edge-operator->agent:a1:message')).toBeTruthy()
    expect(screen.queryAllByTestId(/^edge-/)).toHaveLength(2)

    expect(screen.queryByTestId('comm-empty')).toBeNull()
    expect(graphCanvasCalls.at(-1)!.nodeTypes.commAgent).toBeDefined()
    expect(graphCanvasCalls.at(-1)!.nodeTypes.operator).toBeDefined()
  })

  it('a failed fetch renders its message in the error band, and the canvas stays up rather than going blank', async () => {
    fetchMock.mockResolvedValueOnce(new Response('workspace not found', { status: 404 }))
    render(<CommunicationMode workspaceId="w1" />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    expect(screen.getByTestId('comm-error').textContent).toContain('404')
    expect(screen.getByTestId('graph-canvas-stub')).toBeTruthy()
  })

  // ================================================================================================
  // Refetch wiring: a `frameTick` bump debounces a re-fetch by >=2s, and never fires from the
  // tick's own starting value on first render (same shape as `graph-skill.test.tsx`'s own).
  // ================================================================================================

  it('debounces the stream-driven refetch by >=2s after frameTick changes, and not on first render', async () => {
    const { rerender } = render(<CommunicationMode workspaceId="w1" frameTick={0} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    vi.useFakeTimers()
    try {
      rerender(<CommunicationMode workspaceId="w1" frameTick={1} />)

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
    const { rerender } = render(<CommunicationMode workspaceId="w1" frameTick={0} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    vi.useFakeTimers()
    try {
      rerender(<CommunicationMode workspaceId="w1" frameTick={1} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000)
      })
      rerender(<CommunicationMode workspaceId="w1" frameTick={2} />)
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
