// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskCard } from '../src/components/TaskCard.js'
import { TaskColumn } from '../src/components/TaskColumn.js'
import { TaskDetailPanel } from '../src/components/TaskDetailPanel.js'
import { TasksClient } from '../src/components/TasksClient.js'
import type { TaskBoardItem, TasksSnapshot } from '../src/server/tasks.js'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/w/w1/tasks',
  useSearchParams: () => new URLSearchParams(),
}))

// The board's fixed, spec-mandated column order (design doc §5) — a deliberate literal here
// since `@ai-team-os/domain` exports the wider 12-value `TaskStatus` type but no ordered
// constant matching this narrower 8-column board.
const BOARD_COLUMNS = ['backlog', 'ready', 'running', 'verifying', 'reviewing', 'blocked', 'done', 'failed'] as const

const task = (over: Partial<TaskBoardItem>): TaskBoardItem => ({
  id: 't1',
  title: 'Add the thing',
  description: 'Add the thing to the app',
  status: 'running',
  priority: 1,
  attempt: 2,
  maxAttempts: 3,
  assigneeName: 'Alex',
  branch: 'feature/add-the-thing',
  lastRejectionReason: null,
  runs: [],
  ...over,
})

const snapshot = (tasks: readonly TaskBoardItem[]): TasksSnapshot => ({
  workspace: { id: 'w1', name: 'W', haltedReason: null },
  tasks,
})

describe('TaskColumn', () => {
  it('renders all eight columns in the spec order, empty ones included', () => {
    render(
      <div>
        {BOARD_COLUMNS.map((status) => (
          <TaskColumn key={status} status={status} tasks={[]} onSelect={() => {}} />
        ))}
      </div>,
    )
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(BOARD_COLUMNS)
  })
})

describe('TaskCard', () => {
  it('shows the title, attempt/maxAttempts, and assignee when present', () => {
    render(<TaskCard task={task({})} onSelect={() => {}} />)
    expect(screen.getByText('Add the thing')).toBeTruthy()
    expect(screen.getByTestId('attempt').textContent).toBe('2/3')
    expect(screen.getByTestId('assignee').textContent).toBe('Alex')
  })

  it('omits the assignee when there is none', () => {
    render(<TaskCard task={task({ assigneeName: null })} onSelect={() => {}} />)
    expect(screen.queryByTestId('assignee')).toBeNull()
  })

  it('calls onSelect with the task id when clicked', () => {
    const onSelect = vi.fn()
    render(<TaskCard task={task({ id: 't9' })} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('Add the thing'))
    expect(onSelect).toHaveBeenCalledWith('t9')
  })
})

describe('TaskDetailPanel', () => {
  it('shows description, branch, rejection reason and run rows', () => {
    render(
      <TaskDetailPanel
        task={task({
          description: 'Do the thing well',
          branch: 'feature/x',
          lastRejectionReason: 'tests failed on attempt 1',
          runs: [
            {
              id: 'r1',
              status: 'working',
              costUsd: 0.42,
              toolCalls: 5,
              startedAt: new Date(0).toISOString(),
              endedAt: null,
              checkpoint: null,
            },
          ],
        })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText('Do the thing well')).toBeTruthy()
    expect(screen.getByText('feature/x')).toBeTruthy()
    expect(screen.getByText('tests failed on attempt 1')).toBeTruthy()
    expect(screen.getAllByTestId('run-row')).toHaveLength(1)
  })

  it("shows 'paused at step N' for a paused run with a checkpoint", () => {
    render(
      <TaskDetailPanel
        task={task({
          runs: [
            {
              id: 'r1',
              status: 'paused',
              costUsd: 0.1,
              toolCalls: 2,
              startedAt: new Date(0).toISOString(),
              endedAt: null,
              checkpoint: { pausedAtStep: 4, sessionId: 's1', dirtyFileCount: 2 },
            },
          ],
        })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/paused at step 4/)).toBeTruthy()
  })

  it('calls onClose when the close control is used', () => {
    const onClose = vi.fn()
    render(<TaskDetailPanel task={task({})} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('TasksClient', () => {
  // useTasks (via useWorkspaceStream) opens a real EventSource and fetches on open; neither
  // exists/should run for real under jsdom, so both are stubbed to a no-op minimal stand-in —
  // same shape as useTasks.test.tsx's FakeEventSource.
  class FakeEventSource {
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    onopen: (() => void) | null = null
    close(): void {}
  }

  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(snapshot([])), { status: 200 })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders all eight columns in order, empty ones included', () => {
    render(<TasksClient workspaceId="w1" initial={snapshot([task({})])} />)
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(BOARD_COLUMNS)
  })

  it('opens the detail panel on card click and closes back to the board', () => {
    render(<TasksClient workspaceId="w1" initial={snapshot([task({ id: 't1', description: 'The full description' })])} />)

    expect(screen.queryByText('The full description')).toBeNull()
    fireEvent.click(screen.getByText('Add the thing'))
    expect(screen.getByText('The full description')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(screen.queryByText('The full description')).toBeNull()
  })
})
