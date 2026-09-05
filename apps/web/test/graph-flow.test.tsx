// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Position, ReactFlowProvider, type Edge, type EdgeProps, type NodeProps } from 'reactflow'
import type { GraphSlave, GraphSnapshot } from '../src/server/graph.js'
import type { StreamEvent } from '../src/hooks/useWorkspaceStream.js'
import {
  canSpawnParticles,
  edgeIdForSlave,
  handleToolCallFrame,
  outgoingEdgeIds,
  prefersReducedMotion,
  spawnParticle,
  sweepExpired,
  tasksTurnedDone,
  type Particle,
} from '../src/components/graph/flow.js'
import { CableEdge, type CableEdgeData } from '../src/components/graph/CableEdge.js'
import { Particles } from '../src/components/graph/Particles.js'
import { SlaveNode, ActiveTaskNode, type SlaveNodeData, type ActiveTaskNodeData } from '../src/components/graph/OrgNodes.js'
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

const SLAVE_EDGE: Edge = { id: 'slave:a1->activeTask:t1', source: 'slave:a1', target: 'activeTask:t1' }

// Fixture widening only (M14 Task 11): `GraphSnapshot` gained `shellFacts` so `GraphClient` can
// publish them to the project header/tab strip (M24 §2.2) instead of either opening a second
// EventSource of its own. Nothing in this file asserts on them.
const SHELL_FACTS: GraphSnapshot['shellFacts'] = {
  workspace: { id: 'w1', name: 'W' },
  counts: { slavesWorking: 0, tasksActive: 0 },
  guardrails: { budgetUsd: null, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
  status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
}

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

  describe('edgeIdForSlave', () => {
    it('finds the slave -> active-task edge for a given slave id', () => {
      expect(edgeIdForSlave([SLAVE_EDGE], 'a1')).toBe('slave:a1->activeTask:t1')
    })

    it('returns null when the slave has no active-task edge (idle, or an unrelated edge)', () => {
      expect(edgeIdForSlave([SLAVE_EDGE], 'a2')).toBeNull()
      expect(edgeIdForSlave([{ id: 'team:t->slave:a1', source: 'team:t', target: 'slave:a1' }], 'a1')).toBeNull()
    })
  })

  describe('handleToolCallFrame', () => {
    it('spawns a particle for a run.tool_call frame naming a slave with a live edge', () => {
      const result = handleToolCallFrame({ type: 'run.tool_call', slaveId: 'a1' }, [SLAVE_EDGE], [], 1_000)
      expect(result).toHaveLength(1)
      expect(result[0]?.edgeId).toBe('slave:a1->activeTask:t1')
    })

    it('ignores a frame of a different type', () => {
      expect(handleToolCallFrame({ type: 'run.started', slaveId: 'a1' }, [SLAVE_EDGE], [], 1_000)).toEqual([])
    })

    it('ignores a frame missing slaveId (StreamEvent fields are optional -- the M6 rule)', () => {
      expect(handleToolCallFrame({ type: 'run.tool_call' }, [SLAVE_EDGE], [], 1_000)).toEqual([])
    })

    it('ignores a frame for a slave with no active-task edge', () => {
      expect(handleToolCallFrame({ type: 'run.tool_call', slaveId: 'nope' }, [SLAVE_EDGE], [], 1_000)).toEqual([])
    })

    it('does not spawn while document.visibilityState is hidden', () => {
      stubVisibility('hidden')
      expect(handleToolCallFrame({ type: 'run.tool_call', slaveId: 'a1' }, [SLAVE_EDGE], [], 1_000)).toEqual([])
    })

    it('does not spawn under prefers-reduced-motion', () => {
      stubMatchMedia(true)
      expect(handleToolCallFrame({ type: 'run.tool_call', slaveId: 'a1' }, [SLAVE_EDGE], [], 1_000)).toEqual([])
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
// real React Flow tree mounted, every particle's edge-lookup retries exhaust and it renders NOTHING
// (fix-round-1, Important 3 -- an unresolved particle used to render a stray, unpositioned dot here;
// it no longer renders at all until it finds a real edge). Proving "one motion-safe: particle
// element per spawned particle" therefore needs a real edge to portal into -- that's the
// `GraphClient` block further down, which mounts a real tree and proves the element mechanism and
// the real `offset-path` value together.)
// ==================================================================================================

describe('Particles', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders the particle-layer shell once mounted (no particles is a valid, empty steady state)', () => {
    stubMatchMedia(false)
    render(<Particles particles={[]} />)

    expect(screen.getByTestId('particle-layer')).toBeTruthy()
  })

  it('fix-round-1, Important 3: renders nothing for a particle whose edge never resolves -- no stray, unpositioned dot once retries exhaust', () => {
    stubMatchMedia(false)
    vi.useFakeTimers()
    render(<Particles particles={[{ id: 'p1', edgeId: 'does-not-exist', expiresAt: 2_000 }]} />)

    act(() => {
      vi.advanceTimersByTime(200) // past the 5×20ms retry budget
    })

    expect(screen.queryByTestId('particle')).toBeNull()
    // Only the unresolved particle's own dot is suppressed -- the layer itself (an empty overlay)
    // still renders normally.
    expect(screen.getByTestId('particle-layer')).toBeTruthy()
  })

  it('under prefers-reduced-motion, renders nothing at all once mounted -- not even the shell', () => {
    stubMatchMedia(true)
    render(<Particles particles={[{ id: 'p1', edgeId: 'e1', expiresAt: 2_000 }]} />)

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
  it('SlaveNode: no flash class on initial mount', () => {
    const data: SlaveNodeData = { kind: 'slave', name: 'Alex', role: 'backend', status: 'idle', activeTaskTitle: null, workspaceId: 'w1' }
    render(withProvider(<SlaveNode {...nodeProps('slave:a1', data)} />))

    expect(screen.getByTestId('slave-node').className).not.toContain('animate-[border-flash')
  })

  it('SlaveNode: flashes its border on a status change, and carries the status colour as --flash-color', () => {
    const data: SlaveNodeData = { kind: 'slave', name: 'Alex', role: 'backend', status: 'idle', activeTaskTitle: null, workspaceId: 'w1' }
    const { rerender } = render(withProvider(<SlaveNode {...nodeProps('slave:a1', data)} />))

    const changed: SlaveNodeData = { ...data, status: 'working' }
    rerender(withProvider(<SlaveNode {...nodeProps('slave:a1', changed)} />))

    const node = screen.getByTestId('slave-node')
    expect(node.className).toContain('motion-safe:animate-[border-flash_800ms_ease-out]')
    expect(node.style.getPropertyValue('--flash-color')).toBe('var(--color-tone-working)')
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
      slaves: [],
      tasks: [task({ id: 't1', status: 'running' }), task({ id: 't2', status: 'ready', dependenciesDone: false })],
      dependencies: [{ taskId: 't2', dependsOnTaskId: 't1' }],
      shellFacts: SHELL_FACTS,
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
      slaves: [],
      tasks: [task({ id: 't1', status: 'done' }), task({ id: 't2', status: 'ready' })],
      dependencies: [{ taskId: 't2', dependsOnTaskId: 't1' }],
      shellFacts: SHELL_FACTS,
    }
    render(<DepsMode workspaceId="w1" snapshot={snapshot} />)

    await waitFor(() => expect(screen.getByTestId('rf__edge-task:t1->task:t2')).toBeTruthy())
    expect(screen.getByTestId('rf__edge-task:t1->task:t2').getAttribute('class')).not.toContain('edge-flash')
  })

  it('fix-round-1 Critical: an unrelated snapshot refetch mid-window does not suppress the clear, and a later remount does not replay it', async () => {
    const before: GraphSnapshot = {
      workspace: { id: 'w1', name: 'W', haltedReason: null },
      teams: [],
      slaves: [],
      tasks: [task({ id: 't1', status: 'running' }), task({ id: 't2', status: 'ready', dependenciesDone: false })],
      dependencies: [{ taskId: 't2', dependsOnTaskId: 't1' }],
      shellFacts: SHELL_FACTS,
    }
    const afterDone: GraphSnapshot = { ...before, tasks: [{ ...before.tasks[0]!, status: 'done' }, before.tasks[1]!] }
    // A refetch landing mid-window with no NEW completion (same statuses as `afterDone`, just an
    // unrelated field change) -- exactly the shape the spec's 250ms debounce plus the completion
    // burst itself (task.done, run.succeeded, the dependent's start events) makes near-certain
    // inside the flash's own 800ms window.
    const afterUnrelated: GraphSnapshot = { ...afterDone, tasks: [afterDone.tasks[0]!, { ...afterDone.tasks[1]!, priority: 2 }] }
    // A later, genuinely different node/edge SET (a new task, forcing `useLayoutedGraph` to re-lay-
    // out and React Flow to re-render its edges) -- t1->t2 must not carry a replayed flash on this
    // remount even though nothing about t1 changed again.
    const afterGrown: GraphSnapshot = {
      ...afterUnrelated,
      tasks: [...afterUnrelated.tasks, task({ id: 't3', status: 'ready', dependenciesDone: false })],
      dependencies: [...afterUnrelated.dependencies, { taskId: 't3', dependsOnTaskId: 't2' }],
    }

    vi.useFakeTimers()
    const { rerender } = render(<DepsMode workspaceId="w1" snapshot={before} />)
    await vi.waitFor(() => expect(screen.getByTestId('rf__edge-task:t1->task:t2')).toBeTruthy())

    rerender(<DepsMode workspaceId="w1" snapshot={afterDone} />)
    await vi.waitFor(() => expect(screen.getByTestId('rf__edge-task:t1->task:t2').getAttribute('class')).toContain('edge-flash'))

    // Mid-window (well before the 800ms clear), the unrelated refetch lands. Before the fix, this
    // re-ran the effect, hit `turnedDone.length === 0`, and returned WITHOUT re-arming a clear --
    // the timer that would have cleared the flash was cancelled as this same effect's own cleanup on
    // that re-run, and nothing replaced it, so `flashingEdgeIds` stayed stuck forever.
    act(() => {
      vi.advanceTimersByTime(300)
    })
    rerender(<DepsMode workspaceId="w1" snapshot={afterUnrelated} />)

    act(() => {
      vi.advanceTimersByTime(600) // total 900ms since the flash started -- past its own 800ms window
    })
    await vi.waitFor(() => expect(screen.getByTestId('rf__edge-task:t1->task:t2').getAttribute('class')).not.toContain('edge-flash'))

    // A later remount (new node/edge set -> a fresh ELK layout -> React Flow re-renders its edges)
    // must not replay the now-cleared flash.
    rerender(<DepsMode workspaceId="w1" snapshot={afterGrown} />)
    await vi.waitFor(() => expect(screen.getByTestId('rf__edge-task:t2->task:t3')).toBeTruthy())
    expect(screen.getByTestId('rf__edge-task:t1->task:t2').getAttribute('class')).not.toContain('edge-flash')

    vi.useRealTimers()
  })
})

// ==================================================================================================
// GraphClient integration: the actual "frame callback -> spawn" wiring (Task 4's onEvent
// pass-through, spec §6's particle track), through a real React Flow tree.
// ==================================================================================================

function slave(overrides: Partial<GraphSlave> = {}): GraphSlave {
  return {
    id: 'a1',
    name: 'Alex',
    role: 'backend',
    teamId: 'team1',
    status: 'idle',
    activeTaskId: null,
    activeTaskTitle: null,
    activeRunId: null,
    provider: null,
    model: null,
    progressPct: 0,
    checkpoints: [],
    recentEvents: [],
    hasSkillData: false,
    ...overrides,
  }
}

const GRAPH_CLIENT_SNAPSHOT: GraphSnapshot = {
  workspace: { id: 'w1', name: 'W', haltedReason: null },
  teams: [{ id: 'team1', name: 'Eng' }],
  slaves: [slave({ id: 'a1', name: 'Alex', status: 'working', activeTaskId: 't1', activeTaskTitle: 'Ship it', activeRunId: 'run1' })],
  tasks: [{ id: 't1', title: 'Ship it', status: 'running', priority: 1, attempt: 1, maxAttempts: 3, dependenciesDone: true }],
  dependencies: [],
  shellFacts: SHELL_FACTS,
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

  it('a run.tool_call frame for the slave spawns exactly one motion-safe:-classed particle on its slave -> active-task edge', async () => {
    render(<GraphClient workspaceId="w1" initial={GRAPH_CLIENT_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__edge-slave:a1->activeTask:t1')).toBeTruthy())

    act(() => {
      capturedOnEvent?.({ type: 'run.tool_call', slaveId: 'a1', runId: 'run1' })
    })

    const particle = await waitFor(() => screen.getByTestId('particle'))
    expect(particle.getAttribute('class')).toContain('motion-safe:animate-[particle-travel_600ms_linear]')
    expect(screen.getAllByTestId('particle')).toHaveLength(1)
  })

  it('caps concurrent particles per edge at 5 under a burst of 6 run.tool_call frames', async () => {
    render(<GraphClient workspaceId="w1" initial={GRAPH_CLIENT_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__edge-slave:a1->activeTask:t1')).toBeTruthy())

    act(() => {
      for (let i = 0; i < 6; i += 1) capturedOnEvent?.({ type: 'run.tool_call', slaveId: 'a1', runId: 'run1' })
    })

    await waitFor(() => expect(screen.getAllByTestId('particle')).toHaveLength(5))
  })

  it('does not spawn a particle while document.visibilityState is hidden', async () => {
    stubVisibility('hidden')
    render(<GraphClient workspaceId="w1" initial={GRAPH_CLIENT_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__edge-slave:a1->activeTask:t1')).toBeTruthy())

    act(() => {
      capturedOnEvent?.({ type: 'run.tool_call', slaveId: 'a1', runId: 'run1' })
    })

    expect(screen.queryByTestId('particle')).toBeNull()
  })

  it('under prefers-reduced-motion, no particle ever renders even after a run.tool_call frame', async () => {
    stubMatchMedia(true)
    render(<GraphClient workspaceId="w1" initial={GRAPH_CLIENT_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__edge-slave:a1->activeTask:t1')).toBeTruthy())

    act(() => {
      capturedOnEvent?.({ type: 'run.tool_call', slaveId: 'a1', runId: 'run1' })
    })

    expect(screen.queryByTestId('particle-layer')).toBeNull()
    expect(screen.queryByTestId('particle')).toBeNull()
  })

  it("portals the particle into its edge's own DOM group and sets its offset-path from that edge's rendered path", async () => {
    render(<GraphClient workspaceId="w1" initial={GRAPH_CLIENT_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__edge-slave:a1->activeTask:t1')).toBeTruthy())

    act(() => {
      capturedOnEvent?.({ type: 'run.tool_call', slaveId: 'a1', runId: 'run1' })
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
        const liveEdgeGroup = screen.getByTestId('rf__edge-slave:a1->activeTask:t1')
        const particle = within(liveEdgeGroup).queryByTestId('particle')
        expect(particle).not.toBeNull()
        expect(particle!.style.getPropertyValue('offset-path')).toMatch(/^path\(/)
      },
      { timeout: 400, interval: 10 },
    )
  })
})

// ==================================================================================================
// CableEdge -- the design README's signature cable ("1b -- Cables"). Rendered standalone inside a
// bare `<svg>`: this component's whole contract is the SVG it emits (three stacked paths, one blur
// filter, the dash attributes), and jsdom reports SVG ATTRIBUTES exactly. What jsdom cannot see is
// class-derived CSS -- the milestone gate re-reads `stroke-dasharray`/`stroke-dashoffset` off
// `getComputedStyle` on the real page, and confirms the halo's blur by eye.
// ==================================================================================================

describe('CableEdge', () => {
  // The geometry half of `EdgeProps` -- the only part `CableEdge` reads besides `id` and `data`.
  // The cast is the same "only the fields under test" shape `nodeProps` above takes for nodes.
  const GEOMETRY = {
    id: 'e1',
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 100,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
  }

  const ACTIVE: CableEdgeData = { tone: 'working', active: true }

  // `data` is explicit at every call site (no default): one of these tests is precisely about an
  // edge that carries NO data, and a default would quietly substitute for it.
  function renderCable(data: CableEdgeData | undefined): HTMLElement {
    const { container } = render(
      <svg>
        <CableEdge {...({ ...GEOMETRY, data } as unknown as EdgeProps<CableEdgeData>)} />
      </svg>,
    )
    return container
  }

  it('draws three visible paths, the invisible hit path, and one filter def inside one group', () => {
    const container = renderCable(ACTIVE)
    expect(container.querySelectorAll('g[data-testid="cable-edge"] path')).toHaveLength(4)
    expect(container.querySelector('filter#cable-glow feGaussianBlur')?.getAttribute('stdDeviation')).toBe('4')
  })

  it('keeps exactly one react-flow__edge-path so Particles can still find its curve', () => {
    const container = renderCable(ACTIVE)
    const core = container.querySelectorAll('path.react-flow__edge-path')
    expect(core).toHaveLength(1)
    expect(core[0]?.getAttribute('d')).toBeTruthy()
    expect(core[0]?.getAttribute('stroke-width')).toBe('1.4')
  })

  it("keeps React Flow's own 20px invisible hit path, on the same curve, off the core's class", () => {
    // Fix round 1, Important 1: React Flow's `BaseEdge` always emits this, and every deps edge got
    // one for free before they carried a `type`. Without it `.react-flow__edge`'s
    // `pointer-events: visibleStroke` shrinks "select an edge, press Delete" to the 1.4px core --
    // 3px for the inactive edge a dependency is until its prerequisite is done.
    const container = renderCable(ACTIVE)
    const hit = container.querySelectorAll('path.react-flow__edge-interaction')
    expect(hit).toHaveLength(1)
    expect(hit[0]?.getAttribute('stroke-width')).toBe('20')
    expect(hit[0]?.getAttribute('stroke-opacity')).toBe('0')
    // Same curve as the core, and NOT carrying the core's class -- `Particles`' single-node
    // `querySelector('path.react-flow__edge-path')` must keep resolving to exactly one path.
    expect(hit[0]?.getAttribute('d')).toBe(container.querySelector('path.react-flow__edge-path')?.getAttribute('d'))
    expect(hit[0]?.classList.contains('react-flow__edge-path')).toBe(false)
  })

  it('gives the inactive edge the same 20px hit path -- a deps edge is inactive until its prerequisite is done', () => {
    const container = renderCable({ tone: 'idle', active: false })
    expect(container.querySelectorAll('path.react-flow__edge-interaction')).toHaveLength(1)
    expect(container.querySelectorAll('path.react-flow__edge-path')).toHaveLength(1)
  })

  it('draws the halo at 5px, opacity .18, through the blur filter, in the tone colour', () => {
    const container = renderCable(ACTIVE)
    const halo = container.querySelector('path[data-cable="halo"]')
    expect(halo?.getAttribute('stroke-width')).toBe('5')
    expect(halo?.getAttribute('opacity')).toBe('0.18')
    expect(halo?.getAttribute('filter')).toBe('url(#cable-glow)')
    expect(halo?.getAttribute('stroke')).toBe('var(--color-tone-working)')
  })

  it('animates the white dashed overlay with the README dash exactly', () => {
    const container = renderCable(ACTIVE)
    const flow = container.querySelector('path[data-cable="flow"]')
    // SVG ATTRIBUTES, which jsdom does report exactly -- unlike class-derived CSS, which it does
    // not see at all. The gate re-reads `stroke-dasharray` off `getComputedStyle` on the real page.
    expect(flow?.getAttribute('stroke-dasharray')).toBe('5 11')
    expect(flow?.getAttribute('stroke')).toBe('#ffffff')
    expect(flow?.getAttribute('stroke-width')).toBe('1.6')
    // `motion-safe:` is what makes reduced motion kill the dash: Tailwind drops the utility
    // entirely under `prefers-reduced-motion: reduce`, so the overlay renders as a static dashed
    // line rather than a travelling one.
    expect(flow?.getAttribute('class')).toContain('motion-safe:animate-[dash_1.15s_linear_infinite]')
  })

  it('renders an inactive edge as one flat 3px line with no halo and no dash', () => {
    const container = renderCable({ tone: 'idle', active: false })
    // The visible line plus the invisible hit path -- no halo, no dash overlay, no filter def.
    expect(container.querySelectorAll('g[data-testid="cable-edge"] path')).toHaveLength(2)
    expect(container.querySelectorAll('path[data-cable]')).toHaveLength(0)
    expect(container.querySelector('filter#cable-glow')).toBeNull()
    const core = container.querySelector('path.react-flow__edge-path')
    expect(core?.getAttribute('stroke-width')).toBe('3')
    expect(core?.getAttribute('stroke')).toBe('rgba(255,255,255,.13)')
    expect(core?.getAttribute('class')).not.toContain('animate-[dash')
  })

  it("writes the core's paint inline too, so React Flow's own .react-flow__edge-path rule cannot grey it out", () => {
    // `@reactflow/core/dist/style.css` carries `.react-flow__edge-path { stroke: #b1b1b7;
    // stroke-width: 1 }`, and a CSS RULE outranks a presentation attribute -- attributes alone
    // render every cable as React Flow's grey hairline on the real page, which jsdom's attribute
    // reads can never catch. This pins the inline declaration that outranks it.
    const container = renderCable(ACTIVE)
    const core = container.querySelector('path.react-flow__edge-path') as SVGPathElement
    expect(core.style.stroke).toBe('var(--color-tone-working)')
    expect(core.style.strokeWidth).toBe('1.4')
  })

  it("re-draws React Flow's selection cue on the core, since the inline paint outranks its own", () => {
    const { container } = render(
      <svg>
        <CableEdge {...({ ...GEOMETRY, selected: true, data: ACTIVE } as unknown as EdgeProps<CableEdgeData>)} />
      </svg>,
    )
    const core = container.querySelector('path.react-flow__edge-path') as SVGPathElement
    expect(core.style.stroke).toBe('#ffffff')
    expect(core.style.strokeWidth).toBe('2.5')
  })

  it('falls back to the idle tone rather than an undefined stroke when an edge carries no data', () => {
    const container = renderCable(undefined)
    const core = container.querySelector('path.react-flow__edge-path')
    expect(core?.getAttribute('stroke')).toBe('rgba(255,255,255,.13)')
  })
})

// ==================================================================================================
// The cable and the particle, together, through a real React Flow tree: org mode's slave -> active-
// task edge is now a `cable`, and `Particles.tsx` (NOT modified by this task) must still find its
// curve on `path.react-flow__edge-path` inside that edge's own `<g>`.
// ==================================================================================================

describe('GraphClient: cables carry particles', () => {
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

  it("renders org mode's live slave -> active-task edge as a cable, with the particle riding its core path", async () => {
    render(<GraphClient workspaceId="w1" initial={GRAPH_CLIENT_SNAPSHOT} />)
    const edgeGroup = await waitFor(() => screen.getByTestId('rf__edge-slave:a1->activeTask:t1'))

    expect(within(edgeGroup).getByTestId('cable-edge')).toBeTruthy()
    expect(edgeGroup.querySelectorAll('path[data-cable="halo"]')).toHaveLength(1)
    // The single lookup `Particles.tsx:104` performs, verbatim.
    const core = edgeGroup.querySelectorAll('path.react-flow__edge-path')
    expect(core).toHaveLength(1)

    act(() => {
      capturedOnEvent?.({ type: 'run.tool_call', slaveId: 'a1', runId: 'run1' })
    })

    await waitFor(
      () => {
        const liveEdgeGroup = screen.getByTestId('rf__edge-slave:a1->activeTask:t1')
        const particle = within(liveEdgeGroup).queryByTestId('particle')
        expect(particle).not.toBeNull()
        expect(particle!.style.getPropertyValue('offset-path')).toBe(
          `path('${liveEdgeGroup.querySelector('path.react-flow__edge-path')!.getAttribute('d')}')`,
        )
      },
      { timeout: 400, interval: 10 },
    )
  })

  it('paints the canvas surface, its 26px dot grid and the teal wash', async () => {
    render(<GraphClient workspaceId="w1" initial={GRAPH_CLIENT_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('graph-canvas')).toBeTruthy())

    const canvas = screen.getByTestId('graph-canvas')
    expect(canvas.className).toContain('bg-[#08090c]')
    expect(canvas.className).toContain('[background-size:26px_26px]')
    expect(screen.getByTestId('graph-wash')).toBeTruthy()
  })
})
