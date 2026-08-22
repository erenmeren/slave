// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReactFlowProvider, type Edge, type NodeProps } from 'reactflow'
import type { GraphAgent, GraphSnapshot } from '../src/server/graph.js'
import type { StreamEvent } from '../src/hooks/useWorkspaceStream.js'
import {
  canSpawnParticles,
  edgeIdForAgent,
  handleToolCallFrame,
  outgoingEdgeIds,
  prefersReducedMotion,
  spawnParticle,
  sweepExpired,
  tasksTurnedDone,
  type Particle,
} from '../src/components/graph/flow.js'
import { Particles } from '../src/components/graph/Particles.js'
import { AgentNode, ActiveTaskNode, type AgentNodeData, type ActiveTaskNodeData } from '../src/components/graph/OrgNodes.js'
import { TaskNode, type TaskNodeData } from '../src/components/graph/TaskNodes.js'

// ---- jsdom React Flow measurement shims ---------------------------------------------------------
// Same shims `graph-page.test.tsx`/`graph-menu.test.tsx` use, kept file-local per that file's own
// precedent -- needed by every describe block below that mounts a real `<ReactFlow>` tree (DepsMode
// completion wave, GraphClient wiring). See those files' comments for the "why" in full.
function mockElementSizes(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
}
class ResizeObserverStub {
  readonly #callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback
  }
  observe(target: Element): void {
    queueMicrotask(() => this.#callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver))
  }
  unobserve(): void {}
  disconnect(): void {}
}
class DOMMatrixReadOnlyStub {
  readonly m22 = 1
  constructor(_transform?: string) {}
}

// ---- matchMedia / visibility stubbing -------------------------------------------------------------
// jsdom has no `window.matchMedia` at all -- every test that needs `prefersReducedMotion()`/
// `canSpawnParticles()` to read a real (mocked) answer stubs it.
function stubMatchMedia(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduced && query.includes('reduce'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}
function stubVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

// ---- shared module mocks (declared once, at the top level -- see the file's own note on why
// GraphCanvas is deliberately NOT mocked here: the completion-wave and particle-wiring tests both
// need the *real* React Flow DOM, just for different reasons) --------------------------------------

vi.mock('next/navigation', () => ({
  usePathname: () => '/w/w1/graph',
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

let capturedOnEvent: ((event: StreamEvent) => void) | null = null
interface StreamState {
  snapshot: GraphSnapshot | null
  connection: 'connected' | 'reconnecting'
  error: string | null
}
const streamState: StreamState = { snapshot: null, connection: 'connected', error: null }
vi.mock('../src/hooks/useGraph.js', () => ({
  useGraph: (_workspaceId: string, _initial: GraphSnapshot, onEvent?: (event: StreamEvent) => void) => {
    capturedOnEvent = onEvent ?? null
    return streamState
  },
}))

const elkLayoutSpy = vi.fn(async (graph: { children?: { id: string }[] }) => ({
  ...graph,
  children: (graph.children ?? []).map((child, index) => ({ ...child, x: 50 + index * 140, y: 30 + index * 90 })),
}))
vi.mock('elkjs/lib/elk.bundled.js', () => ({
  default: class {
    layout(graph: { children?: { id: string }[] }): Promise<unknown> {
      return elkLayoutSpy(graph)
    }
  },
}))

const AGENT_EDGE: Edge = { id: 'agent:a1->activeTask:t1', source: 'agent:a1', target: 'activeTask:t1' }

// ==================================================================================================
// flow.ts -- pure particle/wave state, no React
// ==================================================================================================

describe('flow.ts', () => {
  beforeEach(() => {
    stubMatchMedia(false)
    stubVisibility('visible')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('spawnParticle / sweepExpired', () => {
    it('spawns one particle on the given edge, expiring 600ms after `now`', () => {
      const [particle] = spawnParticle([], 'e1', 1_000)
      expect(particle).toMatchObject({ edgeId: 'e1', expiresAt: 1_600 })
    })

    it('sweeps particles whose expiry is at or before `now`', () => {
      const particles: Particle[] = [
        { id: 'p1', edgeId: 'e1', expiresAt: 1_000 },
        { id: 'p2', edgeId: 'e1', expiresAt: 2_000 },
      ]
      expect(sweepExpired(particles, 1_500).map((p) => p.id)).toEqual(['p2'])
      expect(sweepExpired(particles, 1_000).map((p) => p.id)).toEqual(['p2']) // at-expiry counts as expired
    })

    it('holds the per-edge cap at 5 under a burst of 6 spawns on the same edge', () => {
      let particles: readonly Particle[] = []
      for (let i = 0; i < 6; i += 1) particles = spawnParticle(particles, 'e1', 1_000)
      expect(particles).toHaveLength(5)
    })

    it('caps independently per edge -- a full edge does not block a different edge', () => {
      let particles: readonly Particle[] = []
      for (let i = 0; i < 5; i += 1) particles = spawnParticle(particles, 'e1', 1_000)
      particles = spawnParticle(particles, 'e2', 1_000)
      expect(particles.filter((p) => p.edgeId === 'e1')).toHaveLength(5)
      expect(particles.filter((p) => p.edgeId === 'e2')).toHaveLength(1)
    })
  })

  describe('prefersReducedMotion / canSpawnParticles', () => {
    it('reads prefers-reduced-motion via window.matchMedia', () => {
      stubMatchMedia(true)
      expect(prefersReducedMotion()).toBe(true)
      stubMatchMedia(false)
      expect(prefersReducedMotion()).toBe(false)
    })

    it('canSpawnParticles is false under prefers-reduced-motion', () => {
      stubMatchMedia(true)
      expect(canSpawnParticles()).toBe(false)
    })

    it('canSpawnParticles is false while document.visibilityState is hidden', () => {
      stubVisibility('hidden')
      expect(canSpawnParticles()).toBe(false)
    })

    it('canSpawnParticles is true otherwise', () => {
      expect(canSpawnParticles()).toBe(true)
    })
  })

  describe('edgeIdForAgent', () => {
    it('finds the agent -> active-task edge for a given agent id', () => {
      expect(edgeIdForAgent([AGENT_EDGE], 'a1')).toBe('agent:a1->activeTask:t1')
    })

    it('returns null when the agent has no active-task edge (idle, or an unrelated edge)', () => {
      expect(edgeIdForAgent([AGENT_EDGE], 'a2')).toBeNull()
      expect(edgeIdForAgent([{ id: 'team:t->agent:a1', source: 'team:t', target: 'agent:a1' }], 'a1')).toBeNull()
    })
  })

  describe('handleToolCallFrame', () => {
    it('spawns a particle for a run.tool_call frame naming an agent with a live edge', () => {
      const result = handleToolCallFrame({ type: 'run.tool_call', agentId: 'a1' }, [AGENT_EDGE], [], 1_000)
      expect(result).toHaveLength(1)
      expect(result[0]?.edgeId).toBe('agent:a1->activeTask:t1')
    })

    it('ignores a frame of a different type', () => {
      expect(handleToolCallFrame({ type: 'run.started', agentId: 'a1' }, [AGENT_EDGE], [], 1_000)).toEqual([])
    })

    it('ignores a frame missing agentId (StreamEvent fields are optional -- the M6 rule)', () => {
      expect(handleToolCallFrame({ type: 'run.tool_call' }, [AGENT_EDGE], [], 1_000)).toEqual([])
    })

    it('ignores a frame for an agent with no active-task edge', () => {
      expect(handleToolCallFrame({ type: 'run.tool_call', agentId: 'nope' }, [AGENT_EDGE], [], 1_000)).toEqual([])
    })

    it('does not spawn while document.visibilityState is hidden', () => {
      stubVisibility('hidden')
      expect(handleToolCallFrame({ type: 'run.tool_call', agentId: 'a1' }, [AGENT_EDGE], [], 1_000)).toEqual([])
    })

    it('does not spawn under prefers-reduced-motion', () => {
      stubMatchMedia(true)
      expect(handleToolCallFrame({ type: 'run.tool_call', agentId: 'a1' }, [AGENT_EDGE], [], 1_000)).toEqual([])
    })
  })

  describe('tasksTurnedDone', () => {
    it('reports a task that transitioned to done', () => {
      const previous = new Map([['t1', 'running']])
      expect(tasksTurnedDone(previous, [{ id: 't1', status: 'done' }])).toEqual(['t1'])
    })

    it('does not report a task that was already done', () => {
      const previous = new Map([['t1', 'done']])
      expect(tasksTurnedDone(previous, [{ id: 't1', status: 'done' }])).toEqual([])
    })

    it('does not report a task done from the start (no entry in `previous` at all)', () => {
      const previous = new Map<string, string>()
      expect(tasksTurnedDone(previous, [{ id: 't1', status: 'done' }])).toEqual([])
    })

    it('does not report a task still in flight', () => {
      const previous = new Map([['t1', 'running']])
      expect(tasksTurnedDone(previous, [{ id: 't1', status: 'verifying' }])).toEqual([])
    })
  })

  describe('outgoingEdgeIds', () => {
    it('returns edges where the task is the source (the prerequisite)', () => {
      const edges: Edge[] = [
        { id: 'task:t1->task:t2', source: 'task:t1', target: 'task:t2' },
        { id: 'task:t1->task:t3', source: 'task:t1', target: 'task:t3' },
        { id: 'task:t2->task:t3', source: 'task:t2', target: 'task:t3' },
      ]
      expect(outgoingEdgeIds(edges, 't1')).toEqual(['task:t1->task:t2', 'task:t1->task:t3'])
    })
  })
})

// ==================================================================================================
// Particles -- the SVG overlay, mechanism only (Known Risk 1: rendered in isolation here, with no
// real React Flow tree mounted, every particle takes the documented "no portal target yet" fallback
// path -- exactly the mechanism, element count + `motion-safe:` class, Known Risk 1 says to assert
// when the real portal path can't be proven in jsdom. The GraphClient block further down mounts a
// real tree and *does* prove the portal path -- see its last test.)
// ==================================================================================================

describe('Particles', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders one motion-safe:-classed particle element per particle', () => {
    stubMatchMedia(false)
    const particles: Particle[] = [{ id: 'p1', edgeId: 'e1', expiresAt: 2_000 }]
    render(<Particles particles={particles} />)

    const element = screen.getByTestId('particle')
    expect(element.getAttribute('class')).toContain('motion-safe:animate-[particle-travel_600ms_linear]')
  })

  it('renders one element per particle in the list', () => {
    stubMatchMedia(false)
    const particles: Particle[] = [
      { id: 'p1', edgeId: 'e1', expiresAt: 2_000 },
      { id: 'p2', edgeId: 'e1', expiresAt: 2_000 },
      { id: 'p3', edgeId: 'e2', expiresAt: 2_000 },
    ]
    render(<Particles particles={particles} />)

    expect(screen.getAllByTestId('particle')).toHaveLength(3)
  })

  it('under prefers-reduced-motion, the particle layer renders empty even with particles present', () => {
    stubMatchMedia(true)
    const particles: Particle[] = [{ id: 'p1', edgeId: 'e1', expiresAt: 2_000 }]
    render(<Particles particles={particles} />)

    expect(screen.queryByTestId('particle-layer')).toBeNull()
    expect(screen.queryByTestId('particle')).toBeNull()
  })
})

// ==================================================================================================
// Status flash -- the M5 border-flash idiom, copied into OrgNodes.tsx / TaskNodes.tsx
// ==================================================================================================

function nodeProps<T>(id: string, data: T): NodeProps<T> {
  return { id, data, type: '', selected: false, isConnectable: true, xPos: 0, yPos: 0, zIndex: 0, dragging: false }
}
function withProvider(children: React.ReactNode): ReactElement {
  return <ReactFlowProvider>{children}</ReactFlowProvider>
}

describe('node status flash (M5 border-flash idiom)', () => {
  it('AgentNode: no flash class on initial mount', () => {
    const data: AgentNodeData = { kind: 'agent', name: 'Alex', role: 'backend', status: 'idle', activeTaskTitle: null, workspaceId: 'w1' }
    render(withProvider(<AgentNode {...nodeProps('agent:a1', data)} />))

    expect(screen.getByTestId('agent-node').className).not.toContain('animate-[border-flash')
  })

  it('AgentNode: flashes its border on a status change, and carries the status colour as --flash-color', () => {
    const data: AgentNodeData = { kind: 'agent', name: 'Alex', role: 'backend', status: 'idle', activeTaskTitle: null, workspaceId: 'w1' }
    const { rerender } = render(withProvider(<AgentNode {...nodeProps('agent:a1', data)} />))

    const changed: AgentNodeData = { ...data, status: 'working' }
    rerender(withProvider(<AgentNode {...nodeProps('agent:a1', changed)} />))

    const node = screen.getByTestId('agent-node')
    expect(node.className).toContain('motion-safe:animate-[border-flash_800ms_ease-out]')
    expect(node.style.getPropertyValue('--flash-color')).toBe('var(--color-status-working)')
  })

  it('ActiveTaskNode: no flash on initial mount, flashes on a status change', () => {
    const data: ActiveTaskNodeData = { kind: 'activeTask', title: 'Ship it', status: 'running', workspaceId: 'w1' }
    const { rerender } = render(withProvider(<ActiveTaskNode {...nodeProps('activeTask:t1', data)} />))
    expect(screen.getByTestId('active-task-node').className).not.toContain('animate-[border-flash')

    rerender(withProvider(<ActiveTaskNode {...nodeProps('activeTask:t1', { ...data, status: 'done' })} />))
    expect(screen.getByTestId('active-task-node').className).toContain('motion-safe:animate-[border-flash_800ms_ease-out]')
  })

  it('deps-mode TaskNode: no flash on initial mount, flashes on a status change', () => {
    const data: TaskNodeData = { kind: 'task', title: 'Write the API', status: 'ready', attempt: 0, maxAttempts: 3, waitingOn: null, workspaceId: 'w1' }
    const { rerender } = render(withProvider(<TaskNode {...nodeProps('task:t1', data)} />))
    expect(screen.getByTestId('task-node').className).not.toContain('animate-[border-flash')

    rerender(withProvider(<TaskNode {...nodeProps('task:t1', { ...data, status: 'running' })} />))
    expect(screen.getByTestId('task-node').className).toContain('motion-safe:animate-[border-flash_800ms_ease-out]')
  })

  it('does not re-flash on a rerender with the same status (only a change flashes)', () => {
    const data: TaskNodeData = { kind: 'task', title: 'Write the API', status: 'ready', attempt: 0, maxAttempts: 3, waitingOn: null, workspaceId: 'w1' }
    const { rerender } = render(withProvider(<TaskNode {...nodeProps('task:t1', data)} />))

    rerender(withProvider(<TaskNode {...nodeProps('task:t1', { ...data })} />))
    expect(screen.getByTestId('task-node').className).not.toContain('animate-[border-flash')
  })
})

// ==================================================================================================
// DepsMode completion wave: a task turning `done` flashes its outgoing edges once, then clears.
// Renders through the REAL `GraphCanvas`/React Flow (not a stub) -- the flash is a plain CSS class
// on the edge object, and reading it back off the real rendered `<g data-testid="rf__edge-...">` is
// both simpler and more faithful than re-deriving the wrapper's prop-capture plumbing
// `graph-deps.test.tsx` uses for its own (unrelated) purposes.
// ==================================================================================================

function task(overrides: Partial<GraphSnapshot['tasks'][number]>): GraphSnapshot['tasks'][number] {
  return { id: 't1', title: 'Untitled', status: 'ready', priority: 1, attempt: 0, maxAttempts: 3, dependenciesDone: true, ...overrides }
}

describe('DepsMode: completion wave', () => {
  let DepsMode: (props: { workspaceId: string; snapshot: GraphSnapshot }) => ReactElement

  beforeEach(async () => {
    mockElementSizes()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })))
    elkLayoutSpy.mockClear()
    ;({ DepsMode } = await import('../src/components/graph/DepsMode.js'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("flashes a task's outgoing edge once when it turns done, then clears the flash", async () => {
    const before: GraphSnapshot = {
      workspace: { id: 'w1', name: 'W', haltedReason: null },
      teams: [],
      agents: [],
      tasks: [task({ id: 't1', status: 'running' }), task({ id: 't2', status: 'ready', dependenciesDone: false })],
      dependencies: [{ taskId: 't2', dependsOnTaskId: 't1' }],
    }
    const after: GraphSnapshot = { ...before, tasks: [{ ...before.tasks[0]!, status: 'done' }, before.tasks[1]!] }

    vi.useFakeTimers()
    const { rerender } = render(<DepsMode workspaceId="w1" snapshot={before} />)
    await vi.waitFor(() => expect(screen.getByTestId('rf__edge-task:t1->task:t2')).toBeTruthy())

    // The first snapshot DepsMode ever sees must never flash anything (no "flash on mount", the
    // same rule the node border-flash follows) -- t1 is `running`, not `done`, so this also just
    // holds as the natural baseline.
    expect(screen.getByTestId('rf__edge-task:t1->task:t2').getAttribute('class')).not.toContain('edge-flash')

    rerender(<DepsMode workspaceId="w1" snapshot={after} />)
    await vi.waitFor(() => expect(screen.getByTestId('rf__edge-task:t1->task:t2').getAttribute('class')).toContain('edge-flash'))

    act(() => {
      vi.advanceTimersByTime(800)
    })
    await vi.waitFor(() => expect(screen.getByTestId('rf__edge-task:t1->task:t2').getAttribute('class')).not.toContain('edge-flash'))

    vi.useRealTimers()
  })

  it('does not flash on the very first snapshot even if a task already shows done', async () => {
    const snapshot: GraphSnapshot = {
      workspace: { id: 'w1', name: 'W', haltedReason: null },
      teams: [],
      agents: [],
      tasks: [task({ id: 't1', status: 'done' }), task({ id: 't2', status: 'ready' })],
      dependencies: [{ taskId: 't2', dependsOnTaskId: 't1' }],
    }
    render(<DepsMode workspaceId="w1" snapshot={snapshot} />)

    await waitFor(() => expect(screen.getByTestId('rf__edge-task:t1->task:t2')).toBeTruthy())
    expect(screen.getByTestId('rf__edge-task:t1->task:t2').getAttribute('class')).not.toContain('edge-flash')
  })
})

// ==================================================================================================
// GraphClient integration: the actual "frame callback -> spawn" wiring (Task 4's onEvent
// pass-through, spec §6's particle track), through a real React Flow tree.
// ==================================================================================================

function agent(overrides: Partial<GraphAgent> = {}): GraphAgent {
  return {
    id: 'a1',
    name: 'Alex',
    role: 'backend',
    teamId: 'team1',
    status: 'idle',
    activeTaskId: null,
    activeTaskTitle: null,
    activeRunId: null,
    costUsd: 0,
    ...overrides,
  }
}

const GRAPH_CLIENT_SNAPSHOT: GraphSnapshot = {
  workspace: { id: 'w1', name: 'W', haltedReason: null },
  teams: [{ id: 'team1', name: 'Eng' }],
  agents: [agent({ id: 'a1', name: 'Alex', status: 'working', activeTaskId: 't1', activeTaskTitle: 'Ship it', activeRunId: 'run1' })],
  tasks: [{ id: 't1', title: 'Ship it', status: 'running', priority: 1, attempt: 1, maxAttempts: 3, dependenciesDone: true }],
  dependencies: [],
}

describe('GraphClient: particle wiring end-to-end', () => {
  let GraphClient: (props: { workspaceId: string; initial: GraphSnapshot }) => ReactElement

  beforeEach(async () => {
    mockElementSizes()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub)
    stubMatchMedia(false)
    stubVisibility('visible')
    capturedOnEvent = null
    streamState.snapshot = GRAPH_CLIENT_SNAPSHOT
    streamState.connection = 'connected'
    streamState.error = null
    elkLayoutSpy.mockClear()
    ;({ GraphClient } = await import('../src/components/graph/GraphClient.js'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('a run.tool_call frame for the agent spawns exactly one motion-safe:-classed particle on its agent -> active-task edge', async () => {
    render(<GraphClient workspaceId="w1" initial={GRAPH_CLIENT_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__edge-agent:a1->activeTask:t1')).toBeTruthy())

    act(() => {
      capturedOnEvent?.({ type: 'run.tool_call', agentId: 'a1', runId: 'run1' })
    })

    const particle = await waitFor(() => screen.getByTestId('particle'))
    expect(particle.getAttribute('class')).toContain('motion-safe:animate-[particle-travel_600ms_linear]')
    expect(screen.getAllByTestId('particle')).toHaveLength(1)
  })

  it('caps concurrent particles per edge at 5 under a burst of 6 run.tool_call frames', async () => {
    render(<GraphClient workspaceId="w1" initial={GRAPH_CLIENT_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__edge-agent:a1->activeTask:t1')).toBeTruthy())

    act(() => {
      for (let i = 0; i < 6; i += 1) capturedOnEvent?.({ type: 'run.tool_call', agentId: 'a1', runId: 'run1' })
    })

    await waitFor(() => expect(screen.getAllByTestId('particle')).toHaveLength(5))
  })

  it('does not spawn a particle while document.visibilityState is hidden', async () => {
    stubVisibility('hidden')
    render(<GraphClient workspaceId="w1" initial={GRAPH_CLIENT_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__edge-agent:a1->activeTask:t1')).toBeTruthy())

    act(() => {
      capturedOnEvent?.({ type: 'run.tool_call', agentId: 'a1', runId: 'run1' })
    })

    expect(screen.queryByTestId('particle')).toBeNull()
  })

  it('under prefers-reduced-motion, no particle ever renders even after a run.tool_call frame', async () => {
    stubMatchMedia(true)
    render(<GraphClient workspaceId="w1" initial={GRAPH_CLIENT_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__edge-agent:a1->activeTask:t1')).toBeTruthy())

    act(() => {
      capturedOnEvent?.({ type: 'run.tool_call', agentId: 'a1', runId: 'run1' })
    })

    expect(screen.queryByTestId('particle-layer')).toBeNull()
    expect(screen.queryByTestId('particle')).toBeNull()
  })

  it("portals the particle into its edge's own DOM group and sets its offset-path from that edge's rendered path", async () => {
    render(<GraphClient workspaceId="w1" initial={GRAPH_CLIENT_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__edge-agent:a1->activeTask:t1')).toBeTruthy())

    act(() => {
      capturedOnEvent?.({ type: 'run.tool_call', agentId: 'a1', runId: 'run1' })
    })

    // Re-queries the edge group fresh on every poll rather than reusing a captured reference: React
    // Flow can replace an edge's DOM node (same `data-testid`, a new element instance) as part of
    // the same re-render that mounts the particle, which would make a captured-then-stale reference
    // read as permanently empty even after the particle successfully portals into the live node.
    // `waitFor`'s default 1000ms budget is comfortably inside the particle's 600ms lifetime for the
    // portal's own ~100ms (5×20ms) retry window; a `timeout` well under the particle's own lifetime
    // keeps this from racing the sweep interval on a slow machine.
    await waitFor(
      () => {
        const liveEdgeGroup = screen.getByTestId('rf__edge-agent:a1->activeTask:t1')
        const particle = within(liveEdgeGroup).queryByTestId('particle')
        expect(particle).not.toBeNull()
        expect(particle!.style.getPropertyValue('offset-path')).toMatch(/^path\(/)
      },
      { timeout: 400, interval: 10 },
    )
  })
})
