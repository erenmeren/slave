// @vitest-environment jsdom
import { StrictMode, type ReactElement } from 'react'
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Edge, Node } from 'reactflow'
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
// Offset by a nonzero base so even the first node's computed position (index 0) is
// distinguishable from the un-positioned `{x: 0, y: 0}` every node starts at — the Strict Mode
// test below asserts a node actually moved off that origin, which `index * 140` alone could not
// tell apart from "never positioned" for index 0.
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

const buildGraphSnapshotMock = vi.fn()

vi.mock('../src/server/graph.js', () => ({
  buildGraphSnapshot: (...args: unknown[]) => buildGraphSnapshotMock(...args),
}))

// Fixture widening only (M14 Task 11): `GraphSnapshot` gained `shellFacts` so `GraphClient` can
// publish them to the global shell's sidebar rather than the sidebar opening a second EventSource
// on this route. Nothing above the drawer/mode-tab blocks asserts on them.
const SHELL_FACTS: GraphSnapshot['shellFacts'] = {
  workspace: { id: 'w1', name: 'Checkout Platform' },
  counts: { agentsWorking: 1, tasksActive: 1 },
  guardrails: { budgetUsd: 100, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
}

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
    provider: null,
    model: null,
    progressPct: 0,
    checkpoints: [],
    recentEvents: [],
    hasSkillData: false,
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
    }),
  ],
  tasks: [
    { id: 't1', title: 'Ship the thing', status: 'running', priority: 1, attempt: 1, maxAttempts: 3, dependenciesDone: true },
  ],
  dependencies: [],
  shellFacts: SHELL_FACTS,
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

  it('fix-round-1 finding 4: colours the satellite border with the literal border-status-working class for a running (non-danger) task', async () => {
    render(<GraphClient workspaceId="w1" initial={SNAPSHOT} />) // t1's status is 'running'
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalled())

    // Pinned to `TASK_STATUS_BORDER`'s literal string (`TaskCard.tsx`), not a runtime
    // `.replace('bg-', 'border-')` on the dot colour — Tailwind v4 only generates a utility whose
    // literal class name appears in source text, so an assembled-at-build string like the old
    // `.replace()` shape never actually renders (jsdom can't observe that directly; this pins the
    // fixed source to the literal it must produce).
    expect(screen.getByTestId('active-task-node').className).toContain('border-status-working')
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

  it('fix-round-1 findings 1+2: survives Strict Mode\'s mount → cleanup → remount double-invoke without losing the in-flight layout', async () => {
    render(
      <StrictMode>
        <GraphClient workspaceId="w1" initial={SNAPSHOT} />
      </StrictMode>,
    )

    // Under the old `keyRef`-guarded hook, Strict Mode's extra effect run sees the ref already set
    // (from the run it just cancelled) and returns without starting a replacement — the node sits
    // at its un-positioned `{x: 0, y: 0}` origin for the rest of the (dev-only) session. Call count
    // alone can't tell the buggy and fixed versions apart (Strict Mode invokes the adapter either
    // way); only the position actually landing can. `elkLayoutSpy`'s fixture offsets even index 0
    // away from the origin for exactly this reason (see its own comment above).
    await waitFor(() => {
      expect(screen.getByTestId('rf__node-workspace:w1').style.transform).toBe('translate(50px,30px)')
    })
  })

  it('fix-round-1 finding 3: does not dangle the new agent→task edge while its satellite node\'s layout is still pending', async () => {
    const idleOnly: GraphSnapshot = { ...SNAPSHOT, agents: [SNAPSHOT.agents[0]!] }
    const { rerender } = render(<GraphClient workspaceId="w1" initial={idleOnly} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalledTimes(1))

    let resolvePending: (() => void) | undefined
    elkLayoutSpy.mockImplementationOnce(
      (graph: { children?: { id: string }[] }) =>
        new Promise((resolve) => {
          resolvePending = () =>
            resolve({
              ...graph,
              children: (graph.children ?? []).map((child, index) => ({ ...child, x: 50 + index * 140, y: 30 + index * 90 })),
            })
        }),
    )

    streamState.snapshot = SNAPSHOT // Sam starts a run — the satellite + its agent→task edge appear
    rerender(<GraphClient workspaceId="w1" initial={idleOnly} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalledTimes(2))

    // Mid-flight: the new nodes (Sam, the satellite) are not yet in the positioned set, so any
    // edge touching them must not render either — React Flow's error #008 (a dangling endpoint)
    // otherwise fires on every run start.
    expect(screen.queryByTestId('rf__edge-agent:a2->activeTask:t1')).toBeNull()
    expect(screen.queryByTestId('active-task-node')).toBeNull()

    resolvePending?.()
    await waitFor(() => expect(screen.getByTestId('rf__edge-agent:a2->activeTask:t1')).toBeTruthy())
    expect(screen.getByTestId('active-task-node')).toBeTruthy()
  })

  // ---- the four modes, the drawer, and the instruct box (M14 Task 11) --------------------------

  // 'Alex Turner' (not the shared SNAPSHOT's 'Alex') so the drawer's `AvatarTile` renders the
  // two-word initials the handoff specifies, and 'run1' so the run-scoped controls are live.
  const DRAWER_SNAPSHOT: GraphSnapshot = {
    ...SNAPSHOT,
    agents: [
      agent({
        id: 'a1',
        name: 'Alex Turner',
        role: 'backend',
        status: 'working',
        activeTaskId: 't1',
        activeTaskTitle: 'Ship the thing',
        activeRunId: 'run1',
        provider: 'claude_code',
        model: 'sonnet',
        progressPct: 40,
        checkpoints: [
          { label: 'checkpoint at step 12', state: 'done' },
          { label: 'step 18', state: 'current' },
        ],
        recentEvents: [{ seq: 9, ts: '2026-08-29T10:11:12.000Z', summary: 'Edit src/index.ts' }],
      }),
    ],
  }

  it('offers four modes, with Skill chain permanently disabled as `later`', async () => {
    const { rerender } = render(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalled())

    expect(screen.getAllByTestId(/^graph-mode-/).map((tab) => tab.textContent)).toEqual([
      'Organization',
      'Execution',
      'Dependencies',
      'Skill chain \u00b7 later',
    ])
    expect((screen.getByTestId('graph-mode-skill') as HTMLButtonElement).disabled).toBe(true)

    // Fix round 1, Important 2 (controller ruling): recorded skill data is a DATA signal, not a
    // view -- there is no skill-chain canvas to open onto, so the tab stays `later` even once a
    // run has a `skillCalls` tally. `hasSkillData` remains the plumbing a later milestone flips.
    streamState.snapshot = { ...SNAPSHOT, agents: SNAPSHOT.agents.map((a) => ({ ...a, hasSkillData: true })) }
    rerender(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)

    expect((screen.getByTestId('graph-mode-skill') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('graph-mode-skill').textContent).toBe('Skill chain \u00b7 later')
  })

  it('never lets a click on the Skill chain tab strand the page on a blank canvas', async () => {
    streamState.snapshot = { ...SNAPSHOT, agents: SNAPSHOT.agents.map((a) => ({ ...a, hasSkillData: true })) }
    render(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalled())

    fireEvent.click(screen.getByTestId('graph-mode-skill'))

    // A disabled button fires nothing: no URL write, and Organization is still the mode showing a
    // real canvas.
    expect(routerReplace).not.toHaveBeenCalled()
    expect(screen.getByTestId('graph-mode-org')).toHaveProperty('ariaCurrent', 'page')
    expect(screen.getByTestId('graph-canvas')).toBeTruthy()
  })

  it('falls back to Organization for a hand-typed ?mode=skill rather than showing an empty panel', async () => {
    searchParams = new URLSearchParams('mode=skill')
    render(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalled())

    expect(screen.getByTestId('graph-mode-org')).toHaveProperty('ariaCurrent', 'page')
    expect(screen.getByTestId('graph-canvas')).toBeTruthy()
  })

  it('switches to Execution mode and draws the six pipeline stages', async () => {
    render(<GraphClient workspaceId="w1" initial={SNAPSHOT} />)
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalled())

    fireEvent.click(screen.getByText('Execution'))

    expect(routerReplace).toHaveBeenCalledWith('/w/w1/graph?mode=exec', { scroll: false })
    await waitFor(() => expect(screen.getAllByTestId('stage-node')).toHaveLength(6))
    // The one running task rides its own compact node under In Progress.
    expect(screen.getAllByTestId('stage-task-node')).toHaveLength(1)
  })

  it('opens the 352px drawer on a node click and closes it again', async () => {
    render(<GraphClient workspaceId="w1" initial={DRAWER_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__node-agent:a1')).toBeTruthy())
    expect(screen.queryByTestId('graph-drawer')).toBeNull()

    fireEvent.click(screen.getByTestId('rf__node-agent:a1'))

    const drawer = screen.getByTestId('graph-drawer')
    expect(drawer.className).toContain('w-[352px]')
    expect(within(drawer).getByTestId('avatar-tile').textContent).toBe('AT')
    expect(within(drawer).getByTestId('drawer-provider').textContent).toBe('claude_code')
    expect(within(drawer).getByTestId('drawer-model').textContent).toBe('sonnet')
    expect(within(drawer).getByTestId('drawer-task').textContent).toBe('Ship the thing')
    expect(within(drawer).getAllByTestId('drawer-checkpoint').map((row) => row.textContent)).toEqual([
      '\u2713checkpoint at step 12',
      '\u25cfstep 18',
    ])
    expect(within(drawer).getAllByTestId('drawer-event')).toHaveLength(1)
    expect((within(drawer).getByTestId('drawer-reassign') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(within(drawer).getByTestId('drawer-close'))
    expect(screen.queryByTestId('graph-drawer')).toBeNull()
  })

  it('does not open the drawer for a non-agent node', async () => {
    render(<GraphClient workspaceId="w1" initial={DRAWER_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__node-team:team1')).toBeTruthy())

    fireEvent.click(screen.getByTestId('rf__node-team:team1'))

    expect(screen.queryByTestId('graph-drawer')).toBeNull()
  })

  it('sends the free-text instruction on Enter through the existing run message route', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<GraphClient workspaceId="w1" initial={DRAWER_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__node-agent:a1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('rf__node-agent:a1'))

    // A quick-instruction chip fills the box; Enter is what actually sends.
    fireEvent.click(screen.getAllByTestId('drawer-quick')[0]!)
    const input = screen.getByTestId('drawer-instruct') as HTMLInputElement
    // Captured BEFORE Enter: a successful send clears the box, which is the point.
    const sent = input.value
    expect(sent.length).toBeGreaterThan(0)
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/w/w1/runs/run1/message')
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST')
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ message: sent })
    await waitFor(() => expect((screen.getByTestId('drawer-instruct') as HTMLInputElement).value).toBe(''))
  })

  it('pauses and stops through the existing run routes', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<GraphClient workspaceId="w1" initial={DRAWER_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__node-agent:a1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('rf__node-agent:a1'))

    fireEvent.click(screen.getByTestId('drawer-pause'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/w/w1/runs/run1/pause')

    fireEvent.click(screen.getByTestId('drawer-stop'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/w/w1/runs/run1/stop')
  })

  it('surfaces a refused control as the drawer\'s own error band', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ error: 'run is not pausable' }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<GraphClient workspaceId="w1" initial={DRAWER_SNAPSHOT} />)
    await waitFor(() => expect(screen.getByTestId('rf__node-agent:a1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('rf__node-agent:a1'))

    fireEvent.click(screen.getByTestId('drawer-pause'))

    await waitFor(() => expect(screen.getByTestId('drawer-error').textContent).toBe('run is not pausable'))
  })
})

describe('useLayoutedGraph', () => {
  beforeEach(() => {
    elkLayoutSpy.mockClear()
  })

  it('fix-round-1 findings 1+2: re-invokes the ELK adapter when only the algorithm changes, even with an unchanged node/edge set', async () => {
    const { useLayoutedGraph } = await import('../src/components/graph/layout.js')
    const nodes: Node[] = [
      { id: 'n1', type: 'workspace', position: { x: 0, y: 0 }, data: {} },
      { id: 'n2', type: 'team', position: { x: 0, y: 0 }, data: {} },
    ]
    const edges: Edge[] = [{ id: 'n1->n2', source: 'n1', target: 'n2' }]

    const { rerender } = renderHook(
      ({ algorithm }: { algorithm: 'mrtree' | 'layered' }) => useLayoutedGraph(nodes, edges, algorithm),
      { initialProps: { algorithm: 'mrtree' } as { algorithm: 'mrtree' | 'layered' } },
    )
    await waitFor(() => expect(elkLayoutSpy).toHaveBeenCalledTimes(1))

    // Same `layoutKey` (node ids/edge pairs unchanged) — under the old `keyRef` guard this second
    // call would have been silently swallowed regardless of the algorithm switch.
    rerender({ algorithm: 'layered' })
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
