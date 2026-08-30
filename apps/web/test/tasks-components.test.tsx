// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_COLUMNS } from '../src/lib/taskColumns.js'
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

const task = (over: Partial<TaskBoardItem>): TaskBoardItem => ({
  id: 't1',
  title: 'Add the thing',
  description: 'Add the thing to the app',
  status: 'running',
  priority: 1,
  attempt: 1,
  maxAttempts: 3,
  assigneeName: 'Alex',
  branch: 'feature/add-the-thing',
  lastRejectionReason: null,
  runs: [],
  ...over,
})

const snapshot = (tasks: readonly TaskBoardItem[]): TasksSnapshot => ({
  workspace: { id: 'w1', name: 'W', haltedReason: null },
  shellFacts: {
    workspace: { id: 'w1', name: 'W' },
    counts: { agentsWorking: 0, tasksActive: 0 },
    guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
  },
  tasks,
})

// `TasksClient` (via `useTasks`/`useWorkspaceStream`) opens a real `EventSource` and fetches on
// open; neither exists/should run for real under jsdom, so both are stubbed file-wide — every
// describe below that renders `<TasksClient>` shares this one stub rather than repeating it.
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

describe('TaskColumn', () => {
  it('renders the six columns in the README order, empty ones included', () => {
    render(
      <div>
        {BOARD_COLUMNS.map((column) => (
          <TaskColumn key={column} column={column} tasks={[]} onSelect={() => {}} />
        ))}
      </div>,
    )
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(BOARD_COLUMNS)
  })
})

describe('TaskCard', () => {
  it('shows the title and the attempt/maxAttempts step counter', () => {
    render(<TaskCard task={task({ attempt: 2 })} onSelect={() => {}} />)
    expect(screen.getByText('Add the thing')).toBeTruthy()
    expect(screen.getByTestId('task-step').textContent).toBe('2/3')
  })

  it("shows the task's priority as a word chip", () => {
    render(<TaskCard task={task({ priority: 9 })} onSelect={() => {}} />)
    expect(screen.getByTestId('task-priority').textContent).toBe('URGENT')
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

  // Motion pass (spec §8 / M4 deferral). `TasksClient` mounts this panel fresh on card select, so
  // the slide-in class replays on every open by construction.
  it('carries the motion-safe panel slide-in animation class on its root', () => {
    const { container } = render(<TaskDetailPanel task={task({})} onClose={() => {}} />)
    expect(container.querySelector('aside')?.className).toContain('motion-safe:animate-[panel-in_160ms_ease-out]')
  })
})

describe('TasksClient', () => {
  it('renders all six columns in order, empty ones included', () => {
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

  it('buckets an off-column status (rework) into the Todo column while the card still carries the true status', () => {
    render(<TasksClient workspaceId="w1" initial={snapshot([task({ id: 't1', status: 'rework' })])} />)
    const todoColumn = screen.getAllByTestId('column').find((c) => c.getAttribute('data-column') === 'Todo')
    expect(todoColumn).toBeDefined()
    const card = within(todoColumn!).getByTestId('task-card')
    expect(card.getAttribute('data-status')).toBe('rework')
  })
})

describe('the six-column board', () => {
  it('renders six columns in the README order with a dot and a count each', () => {
    render(<TasksClient workspaceId="w1" initial={snapshot([task({ status: 'running' }), task({ id: 't2', status: 'blocked' })])} />)
    expect(screen.getAllByTestId('column').map((c) => c.getAttribute('data-column'))).toEqual([
      'Backlog', 'Todo', 'In Progress', 'Review', 'Blocked', 'Done',
    ])
    expect(screen.getByTestId('column-count-In Progress').textContent).toBe('1')
    expect(screen.getByTestId('column-count-Blocked').textContent).toBe('1')
    expect(screen.getByTestId('column-dot-Blocked').getAttribute('data-tone')).toBe('blocked')
  })

  it('renders the compact card: mono id, priority chip, title, assignee chip, step counter', () => {
    render(
      <TaskCard
        task={task({ id: '3f9a21c8-0000-4000-8000-000000000000', title: 'Implement Checkout API', priority: 3, assigneeName: 'Alex Turner', status: 'running' })}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByTestId('task-ref').textContent).toBe('TASK-3f9a21c8')
    expect(screen.getByTestId('task-priority').textContent).toBe('HIGH')
    expect(screen.getByTestId('task-title').textContent).toBe('Implement Checkout API')
    expect(screen.getByTestId('avatar-tile').textContent).toBe('AT')
    expect(screen.getByTestId('task-step').textContent).toBe('1/3')
  })

  it('says unassigned rather than showing an empty avatar', () => {
    render(<TaskCard task={task({ assigneeName: null })} onSelect={() => {}} />)
    expect(screen.getByTestId('task-assignee').textContent).toBe('unassigned')
    expect(screen.queryByTestId('avatar-tile')).toBeNull()
  })

  // M14 fix wave, review I2: the card used to pass a fake idle agent through `cardStateFor`, so a
  // `running` task under the teal IN PROGRESS head wore a grey IDLE pill. It reads its column now.
  it('gives a running task the working pill its own column head wears, not IDLE', () => {
    render(<TaskCard task={task({ status: 'running' })} onSelect={() => {}} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('WORKING')
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('working')
  })

  it('keeps a failed task on Done while its own pill still says failed', () => {
    render(<TasksClient workspaceId="w1" initial={snapshot([task({ status: 'failed' })])} />)
    expect(screen.getByTestId('column-count-Done').textContent).toBe('1')
    expect(screen.getByTestId('status-pill').textContent).toBe('BLOCKED')
  })
})
