// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReactFlowProvider, type Node, type NodeProps, type NodeTypes } from 'reactflow'
import { NodeMenu } from '../src/components/graph/NodeMenu.js'
import { AgentNode, ActiveTaskNode, TeamNode, WorkspaceNode, type AgentNodeData, type ActiveTaskNodeData, type TeamNodeData, type WorkspaceNodeData } from '../src/components/graph/OrgNodes.js'
import { TaskNode, type TaskNodeData } from '../src/components/graph/TaskNodes.js'

/** Same shape `graph-deps.test.tsx` builds by hand to drive a node renderer directly, without
 *  going through React Flow's own layout/measurement machinery -- this file only exercises
 *  `NodeMenu` and its wiring into each node type, not React Flow itself. */
function nodeProps<T>(id: string, data: T): NodeProps<T> {
  return {
    id,
    data,
    type: '',
    selected: false,
    isConnectable: true,
    xPos: 0,
    yPos: 0,
    zIndex: 0,
    dragging: false,
  }
}

// `<Handle>` (rendered inside every node type) reads React Flow's zustand store off context --
// `ReactFlowProvider` supplies that store without needing the real `<ReactFlow>` component (same
// idiom as `graph-deps.test.tsx`'s `GraphCanvas` stub).
function withProvider(children: React.ReactNode): React.ReactElement {
  return <ReactFlowProvider>{children}</ReactFlowProvider>
}

describe('NodeMenu', () => {
  // ---- agent links --------------------------------------------------------------------------

  it('renders an agent menu\'s two links: Open panel and Show in Activity, scoped to the workspace and agent id', () => {
    render(<NodeMenu kind="agent" workspaceId="w1" id="a1" open onOpenChange={() => {}} />)

    const items = within(screen.getByTestId('node-menu')).getAllByTestId('node-menu-item')
    expect(items.map((item) => item.textContent)).toEqual(['Open panel', 'Show in Activity'])
    expect(items.map((item) => item.getAttribute('href'))).toEqual(['/w/w1?agent=a1', '/w/w1/activity?agents=a1'])
  })

  // ---- task links (also used by the activeTask satellite -- "same target surface") -----------

  it('renders a task menu\'s two links: Open in board and Show in Activity, scoped to the workspace and task id', () => {
    render(<NodeMenu kind="task" workspaceId="w1" id="t1" open onOpenChange={() => {}} />)

    const items = within(screen.getByTestId('node-menu')).getAllByTestId('node-menu-item')
    expect(items.map((item) => item.textContent)).toEqual(['Open in board', 'Show in Activity'])
    expect(items.map((item) => item.getAttribute('href'))).toEqual(['/w/w1/tasks?task=t1', '/w/w1/activity?tasks=t1'])
  })

  // ---- trigger: keyboard-reachable, opens the menu -----------------------------------------

  it('renders no menu when closed, but keeps the "..." trigger a real, enabled, tab-reachable button', () => {
    render(<NodeMenu kind="agent" workspaceId="w1" id="a1" open={false} onOpenChange={() => {}} />)

    expect(screen.queryByTestId('node-menu')).toBeNull()
    const trigger = screen.getByTestId('node-menu-trigger')
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.hasAttribute('disabled')).toBe(false)
    expect(trigger.tabIndex).not.toBe(-1)
  })

  it('clicking the trigger opens the menu (onOpenChange(true))', () => {
    const onOpenChange = vi.fn()
    render(<NodeMenu kind="agent" workspaceId="w1" id="a1" open={false} onOpenChange={onOpenChange} />)

    fireEvent.click(screen.getByTestId('node-menu-trigger'))

    expect(onOpenChange).toHaveBeenCalledWith(true)
  })

  // ---- close on Escape / outside click -------------------------------------------------------

  it('closes on Escape', () => {
    const onOpenChange = vi.fn()
    render(<NodeMenu kind="agent" workspaceId="w1" id="a1" open onOpenChange={onOpenChange} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('closes on an outside click', () => {
    const onOpenChange = vi.fn()
    render(
      <div>
        <button type="button" data-testid="outside">
          elsewhere
        </button>
        <NodeMenu kind="agent" workspaceId="w1" id="a1" open onOpenChange={onOpenChange} />
      </div>,
    )

    fireEvent.mouseDown(screen.getByTestId('outside'))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not close on a click inside the menu itself', () => {
    const onOpenChange = vi.fn()
    render(<NodeMenu kind="agent" workspaceId="w1" id="a1" open onOpenChange={onOpenChange} />)

    fireEvent.mouseDown(screen.getByTestId('node-menu'))

    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('does not close while closed (no listeners attached, no spurious calls)', () => {
    const onOpenChange = vi.fn()
    render(<NodeMenu kind="agent" workspaceId="w1" id="a1" open={false} onOpenChange={onOpenChange} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.mouseDown(document.body)

    expect(onOpenChange).not.toHaveBeenCalled()
  })

  // ---- fix-round-1: focus restoration on Escape ----------------------------------------------

  it('fix-round-1: returns focus to the "..." trigger on Escape, when focus was on a menu item', () => {
    const onOpenChange = vi.fn()
    render(<NodeMenu kind="agent" workspaceId="w1" id="a1" open onOpenChange={onOpenChange} />)

    const [firstItem] = screen.getAllByTestId('node-menu-item')
    firstItem!.focus()
    expect(document.activeElement).toBe(firstItem)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(document.activeElement).toBe(screen.getByTestId('node-menu-trigger'))
  })
})

// ---- wiring into each node type -------------------------------------------------------------

describe('node context menus wired per node type', () => {
  it('an agent node\'s trigger opens a menu targeting /w/<ws>?agent=<id> and /w/<ws>/activity?agents=<id>', () => {
    const data: AgentNodeData = { kind: 'agent', name: 'Alex', role: 'backend', status: 'idle', activeTaskTitle: null, workspaceId: 'w1' }
    render(withProvider(<AgentNode {...nodeProps('agent:a1', data)} />))

    fireEvent.click(screen.getByTestId('node-menu-trigger'))

    const items = screen.getAllByTestId('node-menu-item')
    expect(items.map((item) => item.getAttribute('href'))).toEqual(['/w/w1?agent=a1', '/w/w1/activity?agents=a1'])
  })

  it('right-clicking an agent node opens its menu', () => {
    const data: AgentNodeData = { kind: 'agent', name: 'Alex', role: 'backend', status: 'idle', activeTaskTitle: null, workspaceId: 'w1' }
    render(withProvider(<AgentNode {...nodeProps('agent:a1', data)} />))

    fireEvent.contextMenu(screen.getByTestId('agent-node'))

    expect(screen.getByTestId('node-menu')).toBeTruthy()
  })

  it('an active-task satellite\'s trigger opens the task target surface, by the underlying task id (not the node id\'s activeTask: prefix)', () => {
    const data: ActiveTaskNodeData = { kind: 'activeTask', title: 'Ship it', status: 'running', workspaceId: 'w1' }
    render(withProvider(<ActiveTaskNode {...nodeProps('activeTask:t1', data)} />))

    fireEvent.click(screen.getByTestId('node-menu-trigger'))

    const items = screen.getAllByTestId('node-menu-item')
    expect(items.map((item) => item.getAttribute('href'))).toEqual(['/w/w1/tasks?task=t1', '/w/w1/activity?tasks=t1'])
  })

  it('a deps-mode task node\'s trigger opens a menu targeting /w/<ws>/tasks?task=<id> and /w/<ws>/activity?tasks=<id>', () => {
    const data: TaskNodeData = { kind: 'task', title: 'Write the API', status: 'ready', attempt: 0, maxAttempts: 3, waitingOn: null, workspaceId: 'w1' }
    render(withProvider(<TaskNode {...nodeProps('task:t1', data)} />))

    fireEvent.click(screen.getByTestId('node-menu-trigger'))

    const items = screen.getAllByTestId('node-menu-item')
    expect(items.map((item) => item.getAttribute('href'))).toEqual(['/w/w1/tasks?task=t1', '/w/w1/activity?tasks=t1'])
  })

  it('right-clicking a deps-mode task node opens its menu', () => {
    const data: TaskNodeData = { kind: 'task', title: 'Write the API', status: 'ready', attempt: 0, maxAttempts: 3, waitingOn: null, workspaceId: 'w1' }
    render(withProvider(<TaskNode {...nodeProps('task:t1', data)} />))

    fireEvent.contextMenu(screen.getByTestId('task-node'))

    expect(screen.getByTestId('node-menu')).toBeTruthy()
  })

  it('workspace and team nodes render no menu trigger -- nothing to navigate to (M5\'s "controls live in the panel" decision, plus these have no detail surface at all)', () => {
    const workspaceData: WorkspaceNodeData = { kind: 'workspace', name: 'W', haltedReason: null }
    const teamData: TeamNodeData = { kind: 'team', name: 'Eng' }
    render(
      withProvider(
        <>
          <WorkspaceNode {...nodeProps('workspace:w1', workspaceData)} />
          <TeamNode {...nodeProps('team:team1', teamData)} />
        </>,
      ),
    )

    expect(screen.queryByTestId('node-menu-trigger')).toBeNull()
  })
})

// ---- GraphCanvas's own onNodeContextMenu default -------------------------------------------
// A node with its own menu (agent/task/activeTask) stops the event before it reaches here (see
// each renderer's `onContextMenu`) -- these tests drive a node type with no menu of its own
// (`workspace`), the only case that actually reaches `GraphCanvas`'s default handler, to pin the
// "right-click on a no-menu node is a clean no-op" decision (Task 7 brief).
describe('GraphCanvas default onNodeContextMenu', () => {
  // Same jsdom shims `graph-page.test.tsx` uses for real React Flow measurement -- kept local to
  // this describe block per that file's own precedent (not shared/exported anywhere).
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

  beforeEach(() => {
    mockElementSizes()
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('right-clicking a workspace node (no menu of its own) is a no-op that suppresses the browser context menu', async () => {
    const { GraphCanvas } = await import('../src/components/graph/GraphCanvas.js')
    const nodes: Node[] = [{ id: 'workspace:w1', type: 'workspace', position: { x: 0, y: 0 }, data: { kind: 'workspace', name: 'W', haltedReason: null } }]
    const nodeTypes: NodeTypes = { workspace: WorkspaceNode }

    render(<GraphCanvas nodes={nodes} edges={[]} nodeTypes={nodeTypes} />)
    await waitFor(() => expect(screen.getByTestId('workspace-node')).toBeTruthy())

    const event = fireEvent.contextMenu(screen.getByTestId('workspace-node'))
    // `fireEvent` returns `false` when the event's `defaultPrevented` ended up `true` (i.e. some
    // handler called `preventDefault()`) -- this is what stands in for "no browser context menu
    // pops up" in jsdom, which has no real browser chrome to observe directly.
    expect(event).toBe(false)
    expect(screen.queryByTestId('node-menu')).toBeNull()
  })
})
