// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_COLUMNS } from '../src/lib/taskColumns.js'
import { TaskCard } from '../src/components/TaskCard.js'
import { TaskColumn } from '../src/components/TaskColumn.js'
import { TaskDetailPanel } from '../src/components/TaskDetailPanel.js'
import { TasksClient } from '../src/components/TasksClient.js'
import type { TaskBoardItem, TasksSnapshot } from '../src/server/tasks.js'

// Module-level so the M23 B4 collect test below can assert `router.refresh()` fired -- a fresh
// `vi.fn()` returned from inside `useRouter` would give the assertion no stable reference to check.
const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: routerRefresh }),
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
  collectable: false,
  artifacts: [],
  ...over,
})

const snapshot = (tasks: readonly TaskBoardItem[]): TasksSnapshot => ({
  workspace: { id: 'w1', name: 'W', haltedReason: null },
  shellFacts: {
    workspace: { id: 'w1', name: 'W' },
    counts: { agentsWorking: 0, tasksActive: 0 },
    guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 3_600_000, maxAttempts: 3 },
    status: { goal: null, spentUsd: 0, unmeasuredRuns: 0, haltedReason: null },
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
  routerRefresh.mockClear()
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
        workspaceId="w1"
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
              worktreePath: null,
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
        workspaceId="w1"
        task={task({
          runs: [
            {
              id: 'r1',
              status: 'paused',
              costUsd: 0.1,
              toolCalls: 2,
              startedAt: new Date(0).toISOString(),
              endedAt: null,
              worktreePath: null,
              checkpoint: { pausedAtStep: 4, sessionId: 's1', dirtyFileCount: 2, deniedDuringPause: [] },
            },
          ],
        })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/paused at step 4/)).toBeTruthy()
    expect(screen.queryByText(/denied during pause/)).toBeNull()
  })

  it("shows 'N tool calls denied during pause · <id-prefixes>' when the checkpoint has denials", () => {
    // M18 Task 7: `run.tool_call` event payloads carry no `tool_use_id` (verified against
    // `packages/domain/src/events/schema.ts`), so `summary` is always `null` today and the panel
    // always falls back to the truncated id -- not a gap in this test, a fact of the data.
    render(
      <TaskDetailPanel
        workspaceId="w1"
        task={task({
          runs: [
            {
              id: 'r1',
              status: 'paused',
              costUsd: 0.1,
              toolCalls: 2,
              startedAt: new Date(0).toISOString(),
              endedAt: null,
              worktreePath: null,
              checkpoint: {
                pausedAtStep: 4,
                sessionId: 's1',
                dirtyFileCount: 2,
                deniedDuringPause: [
                  { id: 'call-abcdef01', summary: null },
                  { id: 'call-ghijkl02', summary: null },
                ],
              },
            },
          ],
        })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/2 tool calls denied during pause · call-abc…, call-ghi…/)).toBeTruthy()
  })

  it('calls onClose when the close control is used', () => {
    const onClose = vi.fn()
    render(<TaskDetailPanel workspaceId="w1" task={task({})} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })

  // Motion pass (spec §8 / M4 deferral). `TasksClient` mounts this panel fresh on card select, so
  // the slide-in class replays on every open by construction.
  it('carries the motion-safe panel slide-in animation class on its root', () => {
    const { container } = render(<TaskDetailPanel workspaceId="w1" task={task({})} onClose={() => {}} />)
    expect(container.querySelector('aside')?.className).toContain('motion-safe:animate-[panel-in_160ms_ease-out]')
  })
})

describe('TaskDetailPanel worktree collection (M23 B4)', () => {
  const runWithWorktree = (worktreePath: string | null) => ({
    id: 'r1',
    status: 'succeeded' as const,
    costUsd: 0.1,
    toolCalls: 1,
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    worktreePath,
    checkpoint: null,
  })

  it('renders the collect control for a terminal task with a worktree still on disk', () => {
    render(
      <TaskDetailPanel
        workspaceId="w1"
        task={task({ status: 'done', collectable: true, runs: [runWithWorktree('/r/.aiteamos/worktrees/T-1')] })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('collect-worktree')).toBeTruthy()
  })

  it('does not render the collect control for a still-running task', () => {
    render(
      <TaskDetailPanel
        workspaceId="w1"
        task={task({ status: 'running', collectable: false, runs: [runWithWorktree('/r/.aiteamos/worktrees/T-1')] })}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('collect-worktree')).toBeNull()
  })

  it('does not render the collect control for a terminal task whose runs have no worktree left', () => {
    render(
      <TaskDetailPanel
        workspaceId="w1"
        task={task({ status: 'done', collectable: false, runs: [runWithWorktree(null)] })}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('collect-worktree')).toBeNull()
  })

  it('confirms in two steps, then DELETEs the worktree route and refreshes', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <TaskDetailPanel
        workspaceId="w1"
        task={task({ id: 't1', status: 'done', collectable: true, runs: [runWithWorktree('/r/.aiteamos/worktrees/T-1')] })}
        onClose={() => {}}
      />,
    )

    expect(screen.queryByTestId('collect-worktree-confirm')).toBeNull()
    fireEvent.click(screen.getByTestId('collect-worktree'))
    expect(screen.getByTestId('collect-worktree-confirm')).toBeTruthy()

    fireEvent.click(screen.getByTestId('collect-worktree-confirm'))

    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/tasks/t1/worktree', { method: 'DELETE' })
    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalled())
  })

  // Review finding (M23 B4 fix round 1, Important 1): a prior refusal's text must not survive a
  // second attempt -- neither into that attempt's own pending state nor past a second attempt
  // that succeeds.
  it('clears a prior refusal band on the next attempt, once that attempt succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'task t1 has no worktree to collect' }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <TaskDetailPanel
        workspaceId="w1"
        task={task({ id: 't1', status: 'done', collectable: true, runs: [runWithWorktree('/r/.aiteamos/worktrees/T-1')] })}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('collect-worktree'))
    fireEvent.click(screen.getByTestId('collect-worktree-confirm'))
    await vi.waitFor(() => expect(screen.getByTestId('collect-worktree-error').textContent).toBe('task t1 has no worktree to collect'))

    fireEvent.click(screen.getByTestId('collect-worktree'))
    fireEvent.click(screen.getByTestId('collect-worktree-confirm'))

    await vi.waitFor(() => expect(routerRefresh).toHaveBeenCalled())
    expect(screen.queryByTestId('collect-worktree-error')).toBeNull()
  })
})

describe('TaskDetailPanel artifacts (M23 C1-C3)', () => {
  it("shows 'no artifacts yet' when the task has none", () => {
    render(<TaskDetailPanel workspaceId="w1" task={task({ artifacts: [] })} onClose={() => {}} />)
    expect(screen.getByText('no artifacts yet')).toBeTruthy()
  })

  it('renders one row per artifact, with its label and time-of-day', () => {
    render(
      <TaskDetailPanel
        workspaceId="w1"
        task={task({
          artifacts: [
            { id: 'a1', kind: 'verify', label: 'attempt 1 · npm-test', createdAt: '2026-09-03T10:20:30.000Z' },
            { id: 'a2', kind: 'verify', label: 'merge · npm-run-lint', createdAt: '2026-09-03T11:05:00.000Z' },
          ],
        })}
        onClose={() => {}}
      />,
    )
    const rows = screen.getAllByTestId('artifact-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('attempt 1 · npm-test')
    expect(rows[0]?.textContent).toContain('10:20:30')
    expect(rows[1]?.textContent).toContain('merge · npm-run-lint')
    expect(rows[1]?.textContent).toContain('11:05:00')
  })

  it('fetches the artifact text on click and renders it', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('npm test output\nall green\n', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(
      <TaskDetailPanel
        workspaceId="w1"
        task={task({
          id: 't1',
          artifacts: [{ id: 'a1', kind: 'verify', label: 'attempt 1 · npm-test', createdAt: '2026-09-03T10:20:30.000Z' }],
        })}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('artifact-row'))

    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/tasks/t1/artifacts/a1')
    await vi.waitFor(() => expect(screen.getByTestId('artifact-body').textContent).toBe('npm test output\nall green\n'))
    expect(screen.queryByTestId('artifact-truncated')).toBeNull()
  })

  it('shows the truncation notice when the response carries the truncated header', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('...tail only', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'x-artifact-truncated': '1' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(
      <TaskDetailPanel
        workspaceId="w1"
        task={task({
          id: 't1',
          artifacts: [{ id: 'a1', kind: 'verify', label: 'attempt 1 · npm-test', createdAt: '2026-09-03T10:20:30.000Z' }],
        })}
        onClose={() => {}}
      />,
    )

    fireEvent.click(screen.getByTestId('artifact-row'))

    await vi.waitFor(() => expect(screen.getByTestId('artifact-truncated')).toBeTruthy())
    expect(screen.getByTestId('artifact-truncated').textContent).toBe('truncated to the last 256 KiB')
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
