// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReactFlowProvider, type Node, type NodeProps } from 'reactflow'
import type { GraphSnapshot } from '../src/server/graph.js'
import type { GraphCanvasProps } from '../src/components/graph/GraphCanvas.js'

// `DepsMode` renders through the real `GraphCanvas` in production, but `GraphCanvas` is just a
// thin passthrough onto React Flow (verified in the Task 5 report) -- the actual drag-to-connect
// gesture and "select an edge, press Delete" keyboard interaction are React Flow's own mechanics,
// not this task's. This stub captures exactly what `DepsMode` hands `GraphCanvas` (nodes, edges,
// `onConnect`, `onEdgeDelete`) and renders two test-only affordances that call those handlers
// directly with an already-formed `Connection` / edge id -- the same "unit test our own logic,
// don't re-verify the library" split `AgentPanel.tsx`'s tests take for its POST handlers.
const graphCanvasCalls: GraphCanvasProps[] = []
let pendingConnection: { source: string; target: string; sourceHandle: null; targetHandle: null } | null = null

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
    const Renderer = props.nodeTypes.task
    return (
      // `<Handle>` (rendered inside `TaskNode`) reads React Flow's zustand store off context --
      // `ReactFlowProvider` supplies that store without needing the real `<ReactFlow>` component
      // (and therefore without the DOM-measurement machinery that requires jsdom shims).
      <ReactFlowProvider>
        <div data-testid="graph-canvas-stub">
          {props.nodes.map((node) => (
            <div key={node.id} data-testid={`node-${node.id}`}>
              {Renderer ? <Renderer {...nodeProps(node)} /> : null}
            </div>
          ))}
          {props.edges.map((edge) => (
            <button key={edge.id} type="button" data-testid={`edge-${edge.id}`} onClick={() => props.onEdgeDelete?.(edge.id)}>
              select + delete {edge.id}
            </button>
          ))}
          <button
            type="button"
            data-testid="test-connect"
            onClick={() => {
              if (pendingConnection !== null) props.onConnect?.(pendingConnection)
            }}
          >
            connect
          </button>
        </div>
      </ReactFlowProvider>
    )
  },
}))

// `layout.ts` calls the real ELK adapter regardless of the `GraphCanvas` stub above -- mocked here
// purely for determinism/speed, same fixture shape as `graph-page.test.tsx`'s own `elkLayoutSpy`.
// The stub's node rendering doesn't depend on position, so no jsdom `ResizeObserver`/
// `DOMMatrixReadOnly` shims are needed in this file (those exist only for real React Flow's DOM
// measurement, which the `GraphCanvas` mock above never reaches).
const elkLayoutSpy = vi.fn(async (graph: { children?: { id: string }[] }) => ({
  ...graph,
  children: (graph.children ?? []).map((child, index) => ({ ...child, x: index * 140, y: index * 90 })),
}))
vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: class {
    layout(graph: { children?: { id: string }[] }): Promise<unknown> {
      return elkLayoutSpy(graph)
    }
  },
}))

function task(overrides: Partial<GraphSnapshot['tasks'][number]>): GraphSnapshot['tasks'][number] {
  return {
    id: 't1',
    title: 'Untitled',
    status: 'ready',
    priority: 1,
    attempt: 0,
    maxAttempts: 3,
    dependenciesDone: true,
    ...overrides,
  }
}

// Fixture widening only (M14 Task 11): `GraphSnapshot` gained `shellFacts`. Nothing here reads it.
const SHELL_FACTS: GraphSnapshot['shellFacts'] = {
  workspace: { id: 'w1', name: 'W' },
  counts: { agentsWorking: 0, tasksActive: 0 },
  guardrails: { budgetUsd: null, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
}

const SNAPSHOT: GraphSnapshot = {
  shellFacts: SHELL_FACTS,
  workspace: { id: 'w1', name: 'W', haltedReason: null },
  teams: [],
  agents: [],
  tasks: [
    task({ id: 't1', title: 'Set up DB schema', status: 'done', attempt: 1, maxAttempts: 3, dependenciesDone: true }),
    task({ id: 't2', title: 'Write the API', status: 'running', attempt: 1, maxAttempts: 3, dependenciesDone: true }),
    task({ id: 't3', title: 'Ship the UI', status: 'ready', attempt: 0, maxAttempts: 3, dependenciesDone: false }),
  ],
  // t3 depends on both t1 (done -- doesn't count) and t2 (not done -- counts): "waiting on 1", not
  // a naive "waiting on 2" off the raw dependency count.
  dependencies: [
    { taskId: 't3', dependsOnTaskId: 't1' },
    { taskId: 't3', dependsOnTaskId: 't2' },
  ],
}

describe('DepsMode', () => {
  let DepsMode: (props: { workspaceId: string; snapshot: GraphSnapshot }) => ReactElement
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    graphCanvasCalls.length = 0
    pendingConnection = null
    elkLayoutSpy.mockClear()
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    ;({ DepsMode } = await import('../src/components/graph/DepsMode.js'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // ---- task node content ----------------------------------------------------------------------

  it('renders a task node with its title, status border, and attempt/maxAttempts', async () => {
    render(<DepsMode workspaceId="w1" snapshot={SNAPSHOT} />)

    const node = screen.getByTestId('node-task:t2').querySelector('[data-testid="task-node"]')!
    expect(node.textContent).toContain('Write the API')
    expect(node.className).toContain('border-status-working') // running
    expect(node.querySelector('[data-testid="attempt"]')?.textContent).toBe('1/3')
  })

  it('shows "waiting on N" (N = unmet dependency count, not raw dependency count) on a ready task with dependenciesDone: false', async () => {
    render(<DepsMode workspaceId="w1" snapshot={SNAPSHOT} />)

    const node = screen.getByTestId('node-task:t3').querySelector('[data-testid="task-node"]')!
    expect(node.querySelector('[data-testid="waiting-badge"]')?.textContent).toBe('waiting on 1')
  })

  it('does not show a "waiting on" badge for a done task or a ready task whose dependencies are all done', async () => {
    render(<DepsMode workspaceId="w1" snapshot={SNAPSHOT} />)

    expect(screen.getByTestId('node-task:t1').querySelector('[data-testid="waiting-badge"]')).toBeNull()
    expect(screen.getByTestId('node-task:t2').querySelector('[data-testid="waiting-badge"]')).toBeNull()
  })

  // ---- edge direction + no optimistic insert ---------------------------------------------------

  it('onConnect POSTs to the target task\'s dependencies route with the source as dependsOnTaskId (dependsOn -> task), and does not insert the edge locally', async () => {
    render(<DepsMode workspaceId="w1" snapshot={SNAPSHOT} />)
    const edgesBefore = graphCanvasCalls.at(-1)!.edges.length

    // Drawn source: t1 (the prerequisite) -> target: t2 (the dependent) -- t2 should end up
    // depending on t1.
    pendingConnection = { source: 'task:t1', target: 'task:t2', sourceHandle: null, targetHandle: null }
    await act(async () => {
      fireEvent.click(screen.getByTestId('test-connect'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/w/w1/tasks/t2/dependencies',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ dependsOnTaskId: 't1' }) }),
    )
    // No optimistic edge: the edge set React Flow is handed is unchanged by the click -- only a
    // refetched snapshot (not exercised in this unit test) would add it.
    expect(graphCanvasCalls.at(-1)!.edges.length).toBe(edgesBefore)
  })

  it('a 409 response renders its {error} verbatim in the error band, and the provisional edge is still gone', async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'would create a cycle' }), { status: 409 }))
    render(<DepsMode workspaceId="w1" snapshot={SNAPSHOT} />)
    const edgesBefore = graphCanvasCalls.at(-1)!.edges.length

    pendingConnection = { source: 'task:t2', target: 'task:t1', sourceHandle: null, targetHandle: null }
    await act(async () => {
      fireEvent.click(screen.getByTestId('test-connect'))
    })

    expect(screen.getByRole('alert').textContent).toBe('would create a cycle')
    expect(graphCanvasCalls.at(-1)!.edges.length).toBe(edgesBefore)
  })

  // ---- edge deletion ----------------------------------------------------------------------------

  it('selecting an edge and pressing Delete fires the DELETE route for that dependency', async () => {
    render(<DepsMode workspaceId="w1" snapshot={SNAPSHOT} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('edge-task:t1->task:t3'))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/tasks/t3/dependencies/t1', expect.objectContaining({ method: 'DELETE' }))
  })

  // ---- empty DAG ----------------------------------------------------------------------------

  it('shows the empty-DAG copy when there are no dependencies yet', async () => {
    const noDeps: GraphSnapshot = { ...SNAPSHOT, dependencies: [] }
    render(<DepsMode workspaceId="w1" snapshot={noDeps} />)

    expect(screen.getByTestId('deps-empty').textContent).toBe('no dependencies yet — draw one, or planning arrives in M8')
  })

  it('does not show the empty-DAG copy once a dependency exists', async () => {
    render(<DepsMode workspaceId="w1" snapshot={SNAPSHOT} />)

    expect(screen.queryByTestId('deps-empty')).toBeNull()
  })
})
