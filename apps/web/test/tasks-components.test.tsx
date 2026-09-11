// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BOARD_COLUMNS } from '../src/lib/taskColumns.js'
import { TaskCard } from '../src/components/TaskCard.js'
import { TaskColumn } from '../src/components/TaskColumn.js'
import { TaskDetailPanel } from '../src/components/TaskDetailPanel.js'
import { TasksClient } from '../src/components/TasksClient.js'
import { publishStreamState } from '../src/hooks/useStreamState.js'
import type { TaskBoardItem, TasksSnapshot } from '../src/server/tasks.js'

vi.mock('../src/hooks/useStreamState', () => ({ publishStreamState: vi.fn() }))

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
  goalVersion: null,
  runs: [],
  collectable: false,
  artifacts: [],
  integratedAt: null,
  // M48 R1/R2: a hand-made task has neither a contract nor a stage, which is what this fixture is.
  // The handoff group and the stage chip have their own file (`task-detail-handoff.test.tsx`).
  handoff: null,
  stage: null,
  stageTitle: null,
  ...over,
})

const snapshot = (tasks: readonly TaskBoardItem[], goalVersion = 0): TasksSnapshot => ({
  workspace: { id: 'w1', name: 'W', haltedReason: null, goalVersion },
  shellFacts: {
    workspace: { id: 'w1', name: 'W' },
    counts: { slavesWorking: 0, tasksActive: 0 },
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
          <TaskColumn workspaceGoalVersion={0} key={column} column={column} tasks={[]} onSelect={() => {}} />
        ))}
      </div>,
    )
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(BOARD_COLUMNS)
  })
})

describe('TaskCard', () => {
  it('shows the title and the attempt/maxAttempts step counter', () => {
    render(<TaskCard workspaceGoalVersion={0} task={task({ attempt: 2 })} onSelect={() => {}} />)
    expect(screen.getByText('Add the thing')).toBeTruthy()
    expect(screen.getByTestId('task-step').textContent).toBe('2/3')
  })

  it('no longer shows the priority chip — it moved to the panel (M24 §5.4)', () => {
    render(<TaskCard workspaceGoalVersion={0} task={task({ priority: 9 })} onSelect={() => {}} />)
    expect(screen.queryByTestId('task-priority')).toBeNull()
  })

  it('calls onSelect with the task id when clicked', () => {
    const onSelect = vi.fn()
    render(<TaskCard workspaceGoalVersion={0} task={task({ id: 't9' })} onSelect={onSelect} />)
    fireEvent.click(screen.getByText('Add the thing'))
    expect(onSelect).toHaveBeenCalledWith('t9')
  })

  /** M40 §6: which requirement produced this task, and whether that requirement has moved on. */
  describe('the goal stamp and the stale badge', () => {
    it('names the goal version the task was derived from', () => {
      render(<TaskCard workspaceGoalVersion={2} task={task({ goalVersion: 2 })} onSelect={() => {}} />)
      expect(screen.getByTestId('task-goal-version').textContent).toBe('goal v2')
      expect(screen.queryByTestId('task-stale')).toBeNull()
    })

    it('says "unstamped" for a hand-made task, and never calls it stale', () => {
      // No plan derived it from a goal, so there is no version for it to be behind.
      render(<TaskCard workspaceGoalVersion={5} task={task({ goalVersion: null })} onSelect={() => {}} />)
      expect(screen.getByTestId('task-goal-version').textContent).toBe('unstamped')
      expect(screen.queryByTestId('task-stale')).toBeNull()
    })

    it('badges a task whose goal version is behind the project\'s', () => {
      render(<TaskCard workspaceGoalVersion={3} task={task({ goalVersion: 1 })} onSelect={() => {}} />)
      expect(screen.getByTestId('task-goal-version').textContent).toBe('goal v1')
      expect(screen.getByTestId('task-stale').textContent).toBe('stale')
    })
  })

  /** M40 §6: a cancelled task is not a broken one. */
  describe('a cancelled task', () => {
    it('reads CANCELLED in the muted tone rather than blocked\'s red, with its reason on the card', () => {
      render(
        <TaskCard
          workspaceGoalVersion={2}
          task={task({ status: 'cancelled', lastRejectionReason: 'the re-plan for goal v2 no longer needs it' })}
          onSelect={() => {}}
        />,
      )

      const pill = screen.getByTestId('status-pill')
      expect(pill.textContent).toContain('CANCELLED')
      expect(pill.getAttribute('data-tone')).toBe('idle')
      // M45 R4: the cancelled-only `task-cancel-reason` line is the general `task-why` line now --
      // one "why" on a card rather than two places to look for one.
      expect(screen.getByTestId('task-why').textContent).toBe('the re-plan for goal v2 no longer needs it')
    })

    it('is greyed, unlike a failed card', () => {
      const { container: cancelled } = render(<TaskCard workspaceGoalVersion={0} task={task({ status: 'cancelled' })} onSelect={() => {}} />)
      expect(cancelled.querySelector('[data-testid="task-card"]')?.className).toContain('opacity-60')

      const { container: failed } = render(<TaskCard workspaceGoalVersion={0} task={task({ status: 'failed' })} onSelect={() => {}} />)
      expect(failed.querySelector('[data-testid="task-card"]')?.className).not.toContain('opacity-60')
      expect(within(failed).getByTestId('status-pill').getAttribute('data-tone')).toBe('blocked')
    })
  })
})

describe('TaskDetailPanel — the goal stamp, the stale badge and a cancellation (M40 §6)', () => {
  it('names the goal version in the header and badges a stale task', () => {
    render(<TaskDetailPanel workspaceGoalVersion={4} workspaceId="w1" task={task({ goalVersion: 2 })} onClose={() => {}} />)

    expect(screen.getByTestId('task-panel-goal-version').textContent).toBe('goal v2')
    expect(screen.getByTestId('task-panel-stale').textContent).toBe('stale')
  })

  it('leaves a current task unbadged, and an unstamped one too', () => {
    const { unmount } = render(
      <TaskDetailPanel workspaceGoalVersion={2} workspaceId="w1" task={task({ goalVersion: 2 })} onClose={() => {}} />,
    )
    expect(screen.queryByTestId('task-panel-stale')).toBeNull()
    unmount()

    render(<TaskDetailPanel workspaceGoalVersion={2} workspaceId="w1" task={task({ goalVersion: null })} onClose={() => {}} />)
    expect(screen.getByTestId('task-panel-goal-version').textContent).toBe('unstamped')
    expect(screen.queryByTestId('task-panel-stale')).toBeNull()
  })

  it('labels a cancelled task\'s reason as a cancellation, not as a rejection', () => {
    // `cancelTask` writes the reason into the same column a review rejection uses; calling it a
    // rejection would say a reviewer turned the work down when nobody reviewed it at all.
    render(
      <TaskDetailPanel
        workspaceGoalVersion={2}
        workspaceId="w1"
        task={task({ status: 'cancelled', lastRejectionReason: 'the re-plan for goal v2 no longer needs it' })}
        onClose={() => {}}
      />,
    )

    // M45 R4: the reason `dl` is inside the Messages group, which renders nothing until opened.
    openGroup('messages')
    expect(screen.getByTestId('detail-cancel-reason').textContent).toBe('the re-plan for goal v2 no longer needs it')
    expect(screen.queryByTestId('detail-rejection-reason')).toBeNull()
    expect(screen.getByText('cancelled', { selector: 'dt' })).toBeTruthy()
  })

  it('still calls a rejected task\'s reason a rejection', () => {
    render(
      <TaskDetailPanel
        workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ status: 'rework', lastRejectionReason: 'edge case unhandled' })}
        onClose={() => {}}
      />,
    )

    openGroup('messages')
    expect(screen.getByTestId('detail-rejection-reason').textContent).toBe('edge case unhandled')
    expect(screen.queryByTestId('detail-cancel-reason')).toBeNull()
  })
})

describe('TaskDetailPanel', () => {
  it('shows TASK-<id> and the priority chip in the header (M24 §5.4 — moved off the card)', () => {
    render(
      <TaskDetailPanel workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ id: '3f9a21c8-0000-4000-8000-000000000000', priority: 3 })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByTestId('task-panel-ref').textContent).toBe('TASK-3f9a21c8')
    expect(screen.getByTestId('task-panel-priority').textContent).toBe('HIGH')
  })

  it('shows description, branch, rejection reason and run rows', () => {
    render(
      <TaskDetailPanel workspaceGoalVersion={0}
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
              waitingFor: null,
            },
          ],
        })}
        onClose={() => {}}
      />,
    )
    // The description and the run rows are above the fold -- the description ungrouped, the runs
    // in the one group this panel leads with. M45 final wave, M1: Messages now carries ONLY the
    // sentence a reviewer left behind. The attempt counter went to the Run group beside the runs
    // it describes; the branch went to the Worktree group, because a branch name is a raw git
    // value and R4 keeps those folded (the Run group leads open).
    expect(screen.getByText('Do the thing well')).toBeTruthy()
    expect(screen.getAllByTestId('run-row')).toHaveLength(1)
    expect(screen.getByText('1/3')).toBeTruthy()
    // Folded, so it is not on screen at all until somebody asks for it.
    expect(screen.queryByTestId('detail-branch')).toBeNull()
    openGroup('worktree')
    expect(screen.getByTestId('detail-branch').textContent).toBe('feature/x')
    openGroup('messages')
    expect(screen.getByText('tests failed on attempt 1')).toBeTruthy()
  })

  /** M45 final wave, M1: a task that has never run still has an attempt counter, and the Run group
   *  is where it is read -- `no runs yet` is a fact about the RUN LIST alone. */
  it('keeps the attempt counter in the Run group with no runs at all', () => {
    render(
      <TaskDetailPanel workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ attempt: 0, branch: null, runs: [] })}
        onClose={() => {}}
      />,
    )
    const group = document.querySelector('[data-testid="details-group"][data-group="run"]')
    expect(group?.textContent).toContain('no runs yet')
    expect(group?.textContent).toContain('0/3')
    // A task with no branch says so rather than leaving the value blank.
    openGroup('worktree')
    expect(screen.getByTestId('detail-branch').textContent).toBe('—')
  })

  /** M45 final wave, M1: Messages is for what was SAID, and a task nobody has said anything about
   *  opens onto a sentence rather than an empty list. */
  it('says so when nothing has been said about the task', () => {
    render(
      <TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={task({ lastRejectionReason: null })} onClose={() => {}} />,
    )
    openGroup('messages')
    const group = document.querySelector('[data-testid="details-group"][data-group="messages"]')
    expect(group?.textContent).toContain('nothing said about this task yet')
    expect(group?.textContent).not.toContain('attempt')
    expect(group?.textContent).not.toContain('branch')
  })

  it("shows 'paused at step N' for a paused run with a checkpoint", () => {
    render(
      <TaskDetailPanel workspaceGoalVersion={0}
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
              waitingFor: null,
            },
          ],
        })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/paused at step 4/)).toBeTruthy()
    expect(screen.queryByText(/denied during pause/)).toBeNull()
  })

  // M36 t3: a run waiting for another slave's answer is `paused` with a checkpoint like any other,
  // but calling it "paused at step N" invites an operator to resume something that is not theirs to
  // resume. The panel names what it is waiting on instead.
  it("shows 'waiting for <recipient>' instead of 'paused at step N' for a waiting run", () => {
    render(
      <TaskDetailPanel workspaceGoalVersion={0}
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
              waitingFor: 'Maya',
            },
          ],
        })}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/waiting for Maya at step 4/)).toBeTruthy()
    expect(screen.queryByText(/paused at step 4/)).toBeNull()
  })

  it("shows 'N tool calls denied during pause · <id-prefixes>' when the checkpoint has denials", () => {
    // M18 Task 7: `run.tool_call` event payloads carry no `tool_use_id` (verified against
    // `packages/domain/src/events/schema.ts`), so `summary` is always `null` today and the panel
    // always falls back to the truncated id -- not a gap in this test, a fact of the data.
    render(
      <TaskDetailPanel workspaceGoalVersion={0}
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
              waitingFor: null,
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
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={task({})} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })

  // Motion pass (spec §8 / M4 deferral). `TasksClient` mounts this panel fresh on card select, so
  // the slide-in class replays on every open by construction.
  it('carries the motion-safe panel slide-in animation class on its root', () => {
    const { container } = render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={task({})} onClose={() => {}} />)
    expect(container.querySelector('aside')?.className).toContain('motion-safe:animate-[panel-in_160ms_ease-out]')
  })
})

// M37 t4 (spec §6): "What this run saw" -- the manifest of the sections the run's prompt was
// assembled from, and the prompt itself behind a collapsed disclosure. Read-only: this panel never
// writes a context, and the row it reads was written before the run's child process started.
describe('TaskDetailPanel — what a run saw (M37 §6)', () => {
  const run = {
    id: 'r1',
    status: 'succeeded' as const,
    costUsd: 0.1,
    toolCalls: 2,
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(0).toISOString(),
    worktreePath: null,
    checkpoint: null,
    waitingFor: null,
  }

  const manifest = {
    kind: 'implementation',
    sections: [
      { kind: 'profile', origin: 'company', sha256: 'abcdef0123456789' + '0'.repeat(48) },
      {
        kind: 'skills',
        copied: ['writing-plans'],
        missing: ['brainstorming'],
        shadowedByRepo: [],
        provider_unsupported: false,
        no_worktree: false,
      },
      { kind: 'inbox', messageIds: ['m-1', 'm-2'] },
      // M40 t1: the `task` source carries the sha256 of the task text the run saw.
      { kind: 'task', taskId: '3f9a21c8-0000-4000-8000-000000000000', sha256: 'd'.repeat(64) },
    ],
  }

  /** Answers the context route and nothing else — every other fetch this panel could make is a
   *  test failure rather than a silently empty snapshot. */
  function stubContext(body: unknown, status = 200): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async (url: string) => {
      if (url === '/api/w/w1/runs/r1/context') return new Response(JSON.stringify(body), { status })
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', mock)
    return mock
  }

  it('fetches the run context on demand and lists what each section came from', async () => {
    const fetchMock = stubContext({ prompt: 'You are careful.', manifest })
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={task({ runs: [run] })} onClose={() => {}} />)

    openGroup('context')
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-context-open'))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/context')
    const sections = screen.getAllByTestId('run-context-section').map((row) => row.textContent ?? '')
    expect(sections).toHaveLength(4)
    expect(sections[0]).toMatch(/profile/)
    // The ORIGIN, not just the word "profile": which level of the chain the run was given is the
    // fact a debugger is here for.
    expect(sections[0]).toMatch(/roster/i)
    expect(sections[2]).toMatch(/2 messages/)
  })

  it('highlights the skills the run could NOT be given', async () => {
    stubContext({ prompt: 'You are careful.', manifest })
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={task({ runs: [run] })} onClose={() => {}} />)

    openGroup('context')
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-context-open'))
    })

    expect(screen.getByTestId('run-context-missing').textContent).toMatch(/brainstorming/)
    // The run still started without it (spec §4); the copied one is named too, not replaced.
    expect(screen.getByTestId('run-context-section-1').textContent).toMatch(/writing-plans/)
  })

  it('keeps the prompt collapsed behind a disclosure, as text', async () => {
    stubContext({ prompt: 'You are careful.\n<b>not markup</b>', manifest })
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={task({ runs: [run] })} onClose={() => {}} />)

    openGroup('context')
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-context-open'))
    })

    const details = screen.getByTestId('run-context-prompt') as HTMLDetailsElement
    expect(details.tagName).toBe('DETAILS')
    expect(details.open).toBe(false)
    // Another party's text is data (spec §1): the prompt is characters in a <pre>, never elements.
    const body = screen.getByTestId('run-context-prompt-body')
    expect(body.textContent).toBe('You are careful.\n<b>not markup</b>')
    expect(body.querySelector('b')).toBeNull()
  })

  it("says so when the run recorded no context, rather than showing an empty section list", async () => {
    stubContext({ error: 'this run recorded no context: it never started' }, 404)
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={task({ runs: [run] })} onClose={() => {}} />)

    openGroup('context')
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-context-open'))
    })

    expect(screen.getByTestId('run-context-error').textContent).toContain('never started')
    expect(screen.queryByTestId('run-context-section')).toBeNull()
  })
})

describe('TaskDetailPanel integration marker (M35 t2)', () => {
  it("shows 'awaiting integration' on a done task whose integratedAt is null", () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={task({ status: 'done', integratedAt: null })} onClose={() => {}} />)
    expect(screen.getByTestId('awaiting-integration')).toBeTruthy()
  })

  it('shows no marker for a done task once integratedAt is set', () => {
    render(
      <TaskDetailPanel workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ status: 'done', integratedAt: new Date(0).toISOString() })}
        onClose={() => {}}
      />,
    )
    expect(screen.queryByTestId('awaiting-integration')).toBeNull()
  })

  it('shows no marker for a task that is not done at all', () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={task({ status: 'running', integratedAt: null })} onClose={() => {}} />)
    expect(screen.queryByTestId('awaiting-integration')).toBeNull()
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
    waitingFor: null,
  })

  it('renders the collect control for a terminal task with a worktree still on disk', () => {
    render(
      <TaskDetailPanel workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ status: 'done', collectable: true, runs: [runWithWorktree('/r/.slaveofai/worktrees/T-1')] })}
        onClose={() => {}}
      />,
    )
    openGroup('worktree')
    expect(screen.getByTestId('collect-worktree')).toBeTruthy()
  })

  it('does not render the collect control for a still-running task', () => {
    render(
      <TaskDetailPanel workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ status: 'running', collectable: false, runs: [runWithWorktree('/r/.slaveofai/worktrees/T-1')] })}
        onClose={() => {}}
      />,
    )
    // Opened first, so this proves the control is ABSENT rather than merely folded away.
    openGroup('worktree')
    expect(screen.queryByTestId('collect-worktree')).toBeNull()
  })

  it('does not render the collect control for a terminal task whose runs have no worktree left', () => {
    render(
      <TaskDetailPanel workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ status: 'done', collectable: false, runs: [runWithWorktree(null)] })}
        onClose={() => {}}
      />,
    )
    openGroup('worktree')
    expect(screen.queryByTestId('collect-worktree')).toBeNull()
  })

  it('confirms in two steps, then DELETEs the worktree route and refreshes', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    render(
      <TaskDetailPanel workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ id: 't1', status: 'done', collectable: true, runs: [runWithWorktree('/r/.slaveofai/worktrees/T-1')] })}
        onClose={() => {}}
      />,
    )

    openGroup('worktree')
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
      <TaskDetailPanel workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ id: 't1', status: 'done', collectable: true, runs: [runWithWorktree('/r/.slaveofai/worktrees/T-1')] })}
        onClose={() => {}}
      />,
    )

    openGroup('worktree')
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
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={task({ artifacts: [] })} onClose={() => {}} />)
    // M45 R4: the artifacts are the Verification attempts group, which renders on open.
    openGroup('verification')
    expect(screen.getByText('no artifacts yet')).toBeTruthy()
  })

  it('renders one row per artifact, with its label and time-of-day', () => {
    render(
      <TaskDetailPanel workspaceGoalVersion={0}
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
    openGroup('verification')
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
      <TaskDetailPanel workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({
          id: 't1',
          artifacts: [{ id: 'a1', kind: 'verify', label: 'attempt 1 · npm-test', createdAt: '2026-09-03T10:20:30.000Z' }],
        })}
        onClose={() => {}}
      />,
    )

    openGroup('verification')
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
      <TaskDetailPanel workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({
          id: 't1',
          artifacts: [{ id: 'a1', kind: 'verify', label: 'attempt 1 · npm-test', createdAt: '2026-09-03T10:20:30.000Z' }],
        })}
        onClose={() => {}}
      />,
    )

    openGroup('verification')
    fireEvent.click(screen.getByTestId('artifact-row'))

    await vi.waitFor(() => expect(screen.getByTestId('artifact-truncated')).toBeTruthy())
    expect(screen.getByTestId('artifact-truncated').textContent).toBe('truncated to the last 256 KiB')
  })
})

describe('TasksClient', () => {
  it('publishes its stream state on mount, for the project header’s connection chip to read', () => {
    render(<TasksClient workspaceId="w1" initial={snapshot([])} />)
    expect(publishStreamState).toHaveBeenCalledWith('w1', { connection: 'connected', latencyMs: null })
  })

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

  it('threads the snapshot\'s own goal version to the card and the panel, badging a stale task (fix round 1)', () => {
    // Every other stale case renders `TaskCard`/`TaskDetailPanel` with a literal prop; this one
    // proves the wiring that actually carries it -- `TasksSnapshot.workspace.goalVersion` through
    // `TasksClient` and `TaskColumn` to both surfaces.
    render(<TasksClient workspaceId="w1" initial={snapshot([task({ id: 't1', goalVersion: 1 })], 2)} />)

    expect(screen.getByTestId('task-goal-version').textContent).toBe('goal v1')
    expect(screen.getByTestId('task-stale').textContent).toBe('stale')

    fireEvent.click(screen.getByText('Add the thing'))
    expect(screen.getByTestId('task-panel-goal-version').textContent).toBe('goal v1')
    expect(screen.getByTestId('task-panel-stale').textContent).toBe('stale')
  })

  it('leaves a task on the project\'s current goal version unbadged all the way through', () => {
    render(<TasksClient workspaceId="w1" initial={snapshot([task({ id: 't1', goalVersion: 2 })], 2)} />)

    expect(screen.getByTestId('task-goal-version').textContent).toBe('goal v2')
    expect(screen.queryByTestId('task-stale')).toBeNull()
  })

  it('buckets an off-column status (rework) into the Todo column while the card still carries the true status', () => {
    render(<TasksClient workspaceId="w1" initial={snapshot([task({ id: 't1', status: 'rework' })])} />)
    const todoColumn = screen.getAllByTestId('column').find((c) => c.getAttribute('data-column') === 'Todo')
    expect(todoColumn).toBeDefined()
    const card = within(todoColumn!).getByTestId('task-card')
    expect(card.getAttribute('data-status')).toBe('rework')
  })
})

// M44 erratum E25 / M45 R5: the one page frame reaches the Tasks board too. `flush`, so it brings
// its landmark and its `page-shell` marker and none of its padding -- the board's own
// `grid-cols-6 gap-[10px] p-[16px]` is what `gate:m14-fidelity` measures, and it is unchanged.
describe('TasksClient (M44 E25 / M45 R5)', () => {
  it('renders inside the one page shell, with the board grid untouched', () => {
    render(<TasksClient workspaceId="w1" initial={snapshot([task({})])} />)
    const shell = screen.getByTestId('page-shell')
    expect(shell.className).not.toContain('p-3')
    expect(shell.querySelector(':scope > div')?.className).toBe('grid grid-cols-6 gap-[10px] p-[16px]')
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

  it('renders the compact card: title, status pill, assignee chip, step counter — no ref or priority chip', () => {
    render(
      <TaskCard
        workspaceGoalVersion={0}
        task={task({ id: '3f9a21c8-0000-4000-8000-000000000000', title: 'Implement Checkout API', priority: 3, assigneeName: 'Alex Turner', status: 'running' })}
        onSelect={() => {}}
      />,
    )
    expect(screen.queryByTestId('task-ref')).toBeNull()
    expect(screen.queryByTestId('task-priority')).toBeNull()
    expect(screen.getByTestId('task-title').textContent).toBe('Implement Checkout API')
    expect(screen.getByTestId('avatar-tile').textContent).toBe('AT')
    expect(screen.getByTestId('task-step').textContent).toBe('1/3')
  })

  it('says unassigned rather than showing an empty avatar', () => {
    render(<TaskCard workspaceGoalVersion={0} task={task({ assigneeName: null })} onSelect={() => {}} />)
    expect(screen.getByTestId('task-assignee').textContent).toBe('unassigned')
    expect(screen.queryByTestId('avatar-tile')).toBeNull()
  })

  // M14 fix wave, review I2: the card used to pass a fake idle slave through `cardStateFor`, so a
  // `running` task under the teal IN PROGRESS head wore a grey IDLE pill. It reads its column now.
  it('gives a running task the working pill its own column head wears, not IDLE', () => {
    render(<TaskCard workspaceGoalVersion={0} task={task({ status: 'running' })} onSelect={() => {}} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('WORKING')
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('working')
  })

  it('keeps a failed task on Done while its own pill still says failed', () => {
    render(<TasksClient workspaceId="w1" initial={snapshot([task({ status: 'failed' })])} />)
    expect(screen.getByTestId('column-count-Done').textContent).toBe('1')
    // M45 R4: the WORD is the domain's (`userTaskStatus`), so a failed task finally reads FAILED --
    // the TONE is still the board column's `blocked` red, which is what put it here.
    expect(screen.getByTestId('status-pill').textContent).toBe('FAILED')
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('blocked')
  })
})

// =================================================================================================
// M45 R4: progressive disclosure. The simple row says the domain's word, who has it, and the ONE
// line about why it is not moving; everything raw is folded under a `DetailsGroup`.
// =================================================================================================

/** Opens one `DetailsGroup` by its `data-group` name. A closed group renders NO children at all
 *  (that is the primitive's whole contract), so every case that reads something now folded away
 *  opens its group first rather than weakening the assertion. */
function openGroup(group: string): void {
  const section = document.querySelector(`[data-testid="details-group"][data-group="${group}"]`)
  const toggle = section?.querySelector('button')
  if (toggle === null || toggle === undefined) throw new Error(`no DetailsGroup named ${group} on screen`)
  fireEvent.click(toggle)
}

describe('TaskCard (M45 R4: the simple row)', () => {
  it('reads the domain word, with the raw status still on the card', () => {
    render(<TaskCard workspaceGoalVersion={1} task={task({ status: 'reviewing' })} onSelect={() => {}} />)
    expect(screen.getByTestId('task-status-word').textContent).toContain('IN REVIEW')
    expect(screen.getByTestId('task-card').getAttribute('data-status')).toBe('reviewing')
  })

  // The TONE still comes from the board's column state, with its four documented exceptions --
  // that decides the colour, not the sentence.
  it('keeps the board column\'s tone while taking the domain\'s word', () => {
    render(<TaskCard workspaceGoalVersion={1} task={task({ status: 'reviewing' })} onSelect={() => {}} />)
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('review')
  })

  it('says WAITING on a task whose worker is waiting for an answer', () => {
    render(<TaskCard workspaceGoalVersion={1} task={task({ status: 'waiting' })} onSelect={() => {}} />)
    expect(screen.getByTestId('task-status-word').textContent).toContain('WAITING')
  })

  it('gives a blocked task its reason as the one-line why', () => {
    render(
      <TaskCard workspaceGoalVersion={1} task={task({ status: 'blocked', lastRejectionReason: 'no credentials' })} onSelect={() => {}} />,
    )
    expect(screen.getByTestId('task-why').textContent).toContain('no credentials')
  })

  it('still says a blocked task needs a person when nothing wrote a reason', () => {
    render(<TaskCard workspaceGoalVersion={1} task={task({ status: 'blocked', lastRejectionReason: null })} onSelect={() => {}} />)
    expect(screen.getByTestId('task-why').textContent).toMatch(/a person has to look at this/)
  })

  it('gives a waiting task who it is waiting on', () => {
    render(
      <TaskCard
        workspaceGoalVersion={1}
        task={task({
          status: 'waiting',
          runs: [
            {
              id: 'r1',
              status: 'paused',
              costUsd: null,
              toolCalls: 0,
              startedAt: new Date(0).toISOString(),
              endedAt: null,
              worktreePath: null,
              checkpoint: null,
              // `TaskRunSummary.waitingFor` is the recipient's NAME (`server/tasks.ts`), already
              // resolved server-side -- not an object.
              waitingFor: 'Bo',
            },
          ],
        })}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByTestId('task-why').textContent).toContain('waiting for Bo')
  })

  it('says a waiting task waits for an answer when no run names a recipient', () => {
    render(<TaskCard workspaceGoalVersion={1} task={task({ status: 'waiting', runs: [] })} onSelect={() => {}} />)
    expect(screen.getByTestId('task-why').textContent).toContain('waiting for an answer')
  })

  it('gives a task sent back its rework reason', () => {
    render(
      <TaskCard
        workspaceGoalVersion={1}
        task={task({ status: 'rework', lastRejectionReason: 'tests fail on Windows' })}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByTestId('task-why').textContent).toContain('tests fail on Windows')
  })

  it('renders no why line at all when there is nothing to explain', () => {
    render(<TaskCard workspaceGoalVersion={1} task={task({ status: 'running', lastRejectionReason: null })} onSelect={() => {}} />)
    expect(screen.queryByTestId('task-why')).toBeNull()
  })
})

describe('TaskDetailPanel (M45 R4: the expanded view)', () => {
  const runRow = {
    id: 'r1',
    status: 'succeeded' as const,
    costUsd: 0.25,
    toolCalls: 3,
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    worktreePath: '/r/.slaveofai/worktrees/T-1',
    checkpoint: null,
    waitingFor: null,
  }
  const withRuns = task({ status: 'done', collectable: true, runs: [runRow] })

  it('groups everything raw under Details, in the spec order', () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={withRuns} onClose={() => {}} />)
    expect(screen.getAllByTestId('details-group').map((group) => group.getAttribute('data-group'))).toEqual([
      'run',
      'messages',
      'context',
      // M49 R6: what this task's runs were given, and what it taught -- after the context they were
      // assembled from and before the attempts that proved it.
      'memories',
      'verification',
      'cost',
      'worktree',
      'events',
    ])
  })

  // A task has no model, no profile and no skill -- its RUN's worker does, and that is the worker
  // panel. Three empty groups would be three promises this panel cannot keep.
  it('renders no model, profile or skills group: a task has none of those', () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={withRuns} onClose={() => {}} />)
    const groups = screen.getAllByTestId('details-group').map((group) => group.getAttribute('data-group'))
    expect(groups).not.toContain('model')
    expect(groups).not.toContain('profile')
    expect(groups).not.toContain('skills')
  })

  it("keeps the task ref and the goal stamp OUT of a group -- they are the row's identity", () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={withRuns} onClose={() => {}} />)
    for (const id of ['task-panel-ref', 'task-panel-priority', 'task-panel-goal-version', 'detail-status']) {
      expect(screen.getByTestId(id).closest('[data-testid="details-group"]')).toBeNull()
    }
  })

  it('reads the domain word in the header, with the raw status kept in title', () => {
    render(
      <TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={task({ status: 'reviewing' })} onClose={() => {}} />,
    )
    expect(screen.getByTestId('detail-status').textContent).toBe('IN REVIEW')
    expect(screen.getByTestId('detail-status').getAttribute('title')).toBe('reviewing')
  })

  it('shows the same one-line why the card shows', () => {
    render(
      <TaskDetailPanel
        workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ status: 'blocked', lastRejectionReason: 'no credentials' })}
        onClose={() => {}}
      />,
    )
    const why = screen.getByTestId('task-why')
    expect(why.textContent).toContain('no credentials')
    expect(why.closest('[data-testid="details-group"]')).toBeNull()
  })

  it('does not fetch a run context until its group is opened', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ prompt: 'p', manifest: { kind: 'implementation', sections: [] } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={withRuns} onClose={() => {}} />)

    expect(screen.queryByTestId('run-context-open')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    openGroup('context')
    await act(async () => {
      fireEvent.click(screen.getByTestId('run-context-open'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/context')
  })

  it('keeps the per-run cost figures in the cost group and a one-line total on the run group', () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={withRuns} onClose={() => {}} />)
    // `run` leads the panel and is open on arrival.
    expect(screen.getByTestId('run-row')).toBeTruthy()
    expect(screen.getByTestId('run-total-cost').textContent).toContain('0.25')
    expect(screen.queryByTestId('run-cost-row')).toBeNull()
    openGroup('cost')
    expect(screen.getByTestId('run-cost-row').textContent).toContain('0.25')
  })

  // Fix round 1, IMPORTANT: `worktreePath` has been on the DTO since M23 B4 and was rendered
  // nowhere -- so `collectable` said a tree existed and nothing on screen said WHERE. This is the
  // folding proof R4 is actually about: the path is absent while the group is closed and there in
  // full once it is open, rather than hidden for good.
  it('folds the worktree path away rather than hiding it', () => {
    const panel = render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={withRuns} onClose={() => {}} />)

    expect(screen.queryByTestId('worktree-path')).toBeNull()
    expect(panel.container.textContent).not.toContain('/r/.slaveofai/worktrees/T-1')

    openGroup('worktree')
    expect(screen.getByTestId('worktree-path').textContent).toBe('/r/.slaveofai/worktrees/T-1')
  })

  it('names no path for a run whose tree is already off disk', () => {
    render(
      <TaskDetailPanel
        workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ status: 'done', collectable: false, runs: [{ ...runRow, worktreePath: null }] })}
        onClose={() => {}}
      />,
    )
    openGroup('worktree')
    expect(screen.queryByTestId('worktree-path')).toBeNull()
    expect(screen.getByText(/nothing to collect/u)).toBeTruthy()
  })

  // Fix round 1, minor 3: the Run rows and the Cost rows are two readings of the same runs, so both
  // name each run the same way.
  it('names each run by the same 8-char prefix in the Run group and the Cost group', () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={withRuns} onClose={() => {}} />)
    expect(screen.getByTestId('run-row').textContent).toContain(runRow.id.slice(0, 8))
    openGroup('cost')
    expect(screen.getByTestId('run-cost-row').textContent).toContain(runRow.id.slice(0, 8))
  })

  // Fix round 1, minor 4: spec Decision 6 -- an unmeasured run is a hole in the total, never a zero.
  it('never claims $0.00 for runs whose runtime reported nothing', () => {
    const unmeasured = { ...runRow, id: 'r2', costUsd: null }
    const { unmount } = render(
      <TaskDetailPanel
        workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ status: 'done', runs: [{ ...runRow, costUsd: null }] })}
        onClose={() => {}}
      />,
    )
    // No run reported spend at all: the unknown mark, and no dollar figure anywhere on the line.
    expect(screen.getByTestId('run-total-cost').textContent).toContain('—')
    expect(screen.getByTestId('run-total-cost').textContent).not.toContain('$')
    unmount()

    render(
      <TaskDetailPanel
        workspaceGoalVersion={0}
        workspaceId="w1"
        task={task({ status: 'done', runs: [runRow, unmeasured] })}
        onClose={() => {}}
      />,
    )
    // One measured, one not: the measured spend, and the hole counted apart rather than folded in.
    const total = screen.getByTestId('run-total-cost').textContent ?? ''
    expect(total).toContain('$0.25')
    expect(total).toContain('across 2 runs')
    expect(total).toContain('1 unmeasured')
  })

  it('points the events group at the Activity page filtered to this task', () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={task({ id: 't1' })} onClose={() => {}} />)
    openGroup('events')
    expect(screen.getByTestId('task-events-link').getAttribute('href')).toBe('/w/w1/activity?tasks=t1')
  })
})
