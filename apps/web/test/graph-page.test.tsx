// @vitest-environment jsdom
import type { ReactElement } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphAgent, GraphSnapshot } from '../src/server/graph.js'

// ---- jsdom element-size + ResizeObserver mocks -------------------------------------------------
// React Flow measures its wrapper pane and every node via `ResizeObserver` (no `offsetWidth`/
// `offsetHeight` fallback the way `@tanstack/react-virtual` has one) — jsdom has neither by
// default. Kept local to this file per the Task 5 brief's jsdom note, same as the M6
// `mockElementSizes` precedent in `activity-page.test.tsx`.
function mockElementSizes(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 800 })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 600 })
}

// React Flow measures every node via its own per-node `ResizeObserver` (the container's own size
// is read synchronously at mount, `getDimensions` off the mocked `offsetWidth`/`offsetHeight`
// above -- no observer callback needed for that one) and only marks a node's (and therefore an
// edge's) handle bounds valid once that observer has fired at least once. A no-op stub leaves
// every edge permanently invalid (`EdgeRenderer` renders nothing) — this one echoes back a
// same-tick "the size you asked about is ready" callback, close enough to a real browser's next
// paint for `waitFor` to see the result.
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

// React Flow reads the viewport's zoom (`m22`, i.e. the y-scale) off `window.DOMMatrixReadOnly`
// to convert measured handle pixels into flow coordinates, whenever `updateNodeDimensions` runs
// (see the `ResizeObserverStub` doc above) — jsdom has no `DOMMatrixReadOnly` at all. A fixed
// 1:1 scale is all a test that never asserts on exact coordinates needs.
class DOMMatrixReadOnlyStub {
  readonly m22 = 1
  constructor(_transform?: string) {}
}

let pathname = '/w/w1/graph'
let searchParams = new URLSearchParams()
const routerReplace = vi.fn()

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: routerReplace }),
  useSearchParams: () => searchParams,
}))

interface StreamState {
  snapshot: GraphSnapshot | null
  connection: 'connected' | 'reconnecting'
  error: string | null
}

const streamState: StreamState = { snapshot: null, connection: 'connected', error: null }

vi.mock('../src/hooks/useGraph.js', () => ({
  useGraph: () => streamState,
}))

// The ELK adapter itself, mocked so the recompute-contract tests can count invocations without
// depending on the real layout algorithm's output. `elkjs`'s plain-build entry point (see the
// Task 5 report for why `layout.ts` imports this path rather than the bare `elkjs` specifier) —
// mocking it here at the same specifier keeps `layout.ts`'s own memoization logic real.
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

const buildGraphSnapshotMock = vi.fn()

vi.mock('../src/server/graph.js', () => ({
  buildGraphSnapshot: (...args: unknown[]) => buildGraphSnapshotMock(...args),
}))

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

const SNAPSHOT: GraphSnapshot = {
  workspace: { id: 'w1', name: 'Checkout Platform', haltedReason: null },
  teams: [{ id: 'team1', name: 'Engineering' }],
  agents: [
    agent({ id: 'a1', name: 'Alex', role: 'backend', status: 'idle' }),
    agent({
      id: 'a2',
      name: 'Sam',
      role: 'frontend',
      status: 'working',
      activeTaskId: 't1',
      activeTaskTitle: 'Ship the thing',
      activeRunId: 'run1',
      costUsd: 1.23,
    }),
  ],
  tasks: [
    { id: 't1', title: 'Ship the thing', status: 'running', priority: 1, attempt: 1, maxAttempts: 3, dependenciesDone: true },
  ],
  dependencies: [],
}

describe('GraphClient', () => {
  let GraphClient: (props: { workspaceId: string; initial: GraphSnapshot }) => ReactElement

  beforeEach(async () => {
    mockElementSizes()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub)
    pathname = '/w/w1/graph'
    searchParams = new URLSearchParams()
    routerReplace.mockClear()
    elkLayoutSpy.mockClear()
    streamState.snapshot = null
    streamState.connection = 'connected'
    streamState.error = null
    ;({ GraphClient } = await import('../src/components/graph/GraphClient.js'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders the workspace root, team and agent nodes from the seed snapshot, with status dots and active-task lines', async () => {
    render(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalled())

    expect(screen.getByTestId('workspace-node').textContent).toContain('Checkout Platform')
    expect(screen.getByTestId('team-node').textContent).toContain('Engineering')

    const agentNodes = screen.getAllByTestId('agent-node')
    expect(agentNodes).toHaveLength(2)

    const alexNode = agentNodes.find((node) => node.textContent?.includes('Alex'))!
    expect(alexNode.textContent).toContain('backend')
    expect(within(alexNode).getByTestId('status-dot').className).toContain('bg-status-idle')
    expect(alexNode.textContent).toContain('idle')

    const samNode = agentNodes.find((node) => node.textContent?.includes('Sam'))!
    expect(samNode.textContent).toContain('frontend')
    expect(within(samNode).getByTestId('status-dot').className).toContain('bg-status-working')
    expect(samNode.textContent).toContain('Ship the thing')
  })

  it('shows the halt banner colour on the workspace root when the workspace is halted', async () => {
    const halted: GraphSnapshot = { ...SNAPSHOT, workspace: { ...SNAPSHOT.workspace, haltedReason: 'ran out of budget' } }
    render(<GraphClient workspaceId="w1" initial={halted} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalled())

    const root = screen.getByTestId('workspace-node')
    expect(root.getAttribute('data-halted')).toBe('true')
    expect(root.className).toContain('border-status-danger')
  })

  it('renders no halt colouring when the workspace is not halted', async () => {
    render(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalled())

    const root = screen.getByTestId('workspace-node')
    expect(root.getAttribute('data-halted')).toBe('false')
    expect(root.className).not.toContain('border-status-danger')
  })

  // ---- active-task satellite (spec §6's particle track) ----------------------------------------

  it('a working agent with a live run gets an active-task satellite node and an agent→task edge', async () => {
    render(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalled())

    const satellites = screen.getAllByTestId('active-task-node')
    expect(satellites).toHaveLength(1)
    expect(satellites[0]?.textContent).toContain('Ship the thing')
    expect(screen.getByTestId('rf__edge-agent:a2->activeTask:t1')).toBeTruthy()
  })

  it('an idle agent (no live run) gets no satellite node or edge', async () => {
    const idleOnly: GraphSnapshot = { ...SNAPSHOT, agents: [SNAPSHOT.agents[0]!] } // only Alex, idle
    render(<GraphClient workspaceId="w1" initial={idleOnly} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalled())

    expect(screen.queryAllByTestId('active-task-node')).toHaveLength(0)
  })

  // ---- mode tab ↔ URL round trip -----------------------------------------------------------------

  it('defaults to the Organization tab, and writes ?mode=deps when Dependencies is clicked', async () => {
    render(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalled())

    expect(screen.getByText('Organization')).toHaveProperty('ariaCurrent', 'page')

    fireEvent.click(screen.getByText('Dependencies'))

    expect(routerReplace).toHaveBeenCalledWith('/w/w1/graph?mode=deps', { scroll: false })
  })

  it('round-trips ?mode=deps on mount as the current tab, and clicking Organization clears the param', async () => {
    searchParams = new URLSearchParams('mode=deps')
    render(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)

    expect(screen.getByText('Dependencies')).toHaveProperty('ariaCurrent', 'page')

    fireEvent.click(screen.getByText('Organization'))

    expect(routerReplace).toHaveBeenCalledWith('/w/w1/graph', { scroll: false })
  })

  // ---- layout recompute contract -----------------------------------------------------------------

  it('invokes the ELK adapter on mount, not again for a status-only change, but again when the node/edge set changes', async () => {
    const { rerender } = render(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalledTimes(1))

    // Status-only change: Sam goes from working to paused, same agent/team/task ids.
    streamState.snapshot = {
      ...SNAPSHOT,
      agents: [SNAPSHOT.agents[0]!, { ...SNAPSHOT.agents[1]!, status: 'paused' }],
    }
    rerender(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)
    await Promise.resolve()
    expect(elkLayoutSpy).toHaveBeenCalledTimes(1)

    // Node-set change: a third agent joins the roster.
    streamState.snapshot = {
      ...SNAPSHOT,
      agents: [...SNAPSHOT.agents, agent({ id: 'a3', name: 'Jo', role: 'ops' })],
    }
    rerender(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalledTimes(2))
  })

  it('re-invokes the ELK adapter when the active-task satellite appears (the run starting is a node-set change)', async () => {
    const idleOnly: GraphSnapshot = { ...SNAPSHOT, agents: [SNAPSHOT.agents[0]!] }
    const { rerender } = render(<GraphClient workspaceId="w1" initial={idleOnly} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalledTimes(1))

    streamState.snapshot = SNAPSHOT // Sam starts a run — the satellite + edge appear
    rerender(<GraphClient workspaceId="w1" initial={idleOnly} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalledTimes(2))
  })
})

describe('the graph page route', () => {
  afterEach(() => {
    buildGraphSnapshotMock.mockReset()
    // The `ResizeObserverStub` below schedules its callback via `queueMicrotask` -- it can still
    // be pending when a synchronous test body returns. Unstubbing here (after the test's own
    // assertions, not inline in the test) gives that microtask a chance to run against the real
    // stubs first.
    vi.unstubAllGlobals()
  })

  it('renders the 404 copy for an unknown workspace', async () => {
    buildGraphSnapshotMock.mockResolvedValue(null)
    const { default: GraphPageRoute } = await import('../src/app/w/[workspaceId]/graph/page.js')
    const element = await GraphPageRoute({ params: Promise.resolve({ workspaceId: 'nope' }) })
    render(element)
    expect(screen.getByText(/no workspace with id nope/)).toBeTruthy()
  })

  it('renders GraphClient when the workspace exists', async () => {
    mockElementSizes()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub)
    buildGraphSnapshotMock.mockResolvedValue(SNAPSHOT)
    const { default: GraphPageRoute } = await import('../src/app/w/[workspaceId]/graph/page.js')
    const element = await GraphPageRoute({ params: Promise.resolve({ workspaceId: 'w1' }) })
    render(element)
    expect(screen.getAllByText('Checkout Platform').length).toBeGreaterThan(0)
    // Lets the `ResizeObserverStub`'s queued microtask (scheduled synchronously during `render`
    // above) run against the still-live stubs before `afterEach` unstubs them.
    await waitFor(() => expect(screen.getByTestId('graph-canvas')).toBeTruthy())
  })
})
