// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskCard } from '../src/components/TaskCard'
import { TaskDetailPanel } from '../src/components/TaskDetailPanel'
import type { TaskBoardItem, TaskRunSummary } from '../src/server/tasks'

// `TaskDetailPanel` calls `useRouter()` (the worktree-collect control) -- unused by the cases
// below, but Next throws mounting it with no app router in the tree at all.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}))

const ORIGIN = {
  source: 'github' as const,
  repository: 'acme/checkout',
  ref: '#412',
  url: 'https://github.com/acme/checkout/issues/412',
}

function task(overrides: Partial<TaskBoardItem> = {}): TaskBoardItem {
  return {
    id: 't1',
    title: 'Retry the charge',
    description: '',
    status: 'ready',
    priority: 0,
    attempt: 1,
    maxAttempts: 3,
    assigneeName: null,
    branch: null,
    lastRejectionReason: null,
    goalVersion: 2,
    origin: null,
    integratedAt: null,
    runs: [],
    collectable: false,
    artifacts: [],
    handoff: null,
    stage: null,
    stageTitle: null,
    ...overrides,
  } as TaskBoardItem
}

describe('TaskCard`s origin sentence (M54 R9)', () => {
  it('prints it BESIDE the goal stamp, never instead of it', () => {
    render(<TaskCard task={task({ origin: ORIGIN })} workspaceGoalVersion={2} onSelect={() => undefined} />)
    expect(screen.getByTestId('task-goal-version').textContent).toBe('goal v2')
    expect(screen.getByTestId('task-origin').textContent).toContain('from GitHub')
    expect(screen.getByTestId('task-origin').textContent).toContain('acme/checkout#412')
  })

  it('keeps the raw source on a data attribute and prints no key (ia.md rule 3)', () => {
    render(<TaskCard task={task({ origin: ORIGIN })} workspaceGoalVersion={2} onSelect={() => undefined} />)
    const chip = screen.getByTestId('task-origin')
    expect(chip.getAttribute('data-external-source')).toBe('github')
    expect(chip.textContent).not.toContain('github')
  })

  it('renders NOTHING for a task whose version nobody outside asked for', () => {
    render(<TaskCard task={task()} workspaceGoalVersion={2} onSelect={() => undefined} />)
    expect(screen.queryByTestId('task-origin')).toBeNull()
  })

  it('renders nothing for an unstamped task either, and still says `unstamped`', () => {
    render(<TaskCard task={task({ goalVersion: null })} workspaceGoalVersion={2} onSelect={() => undefined} />)
    expect(screen.getByTestId('task-goal-version').textContent).toBe('unstamped')
    expect(screen.queryByTestId('task-origin')).toBeNull()
  })

  it('leaves the stale badge exactly where it was', () => {
    render(<TaskCard task={task({ origin: ORIGIN, goalVersion: 1 })} workspaceGoalVersion={2} onSelect={() => undefined} />)
    expect(screen.getByTestId('task-stale')).toBeTruthy()
  })

  // E16 / R9: the delivery id is an operator's correlation id and belongs in an operator's
  // terminal. A board card has no payload disclosure to put one in, so on THIS surface the rule is
  // absolute -- nothing here may carry one, not even in a `title` or a `data-` attribute.
  it('carries no delivery id and no url anywhere on the card -- not even out of sight', () => {
    const { container } = render(
      <TaskCard task={task({ origin: ORIGIN })} workspaceGoalVersion={2} onSelect={() => undefined} />,
    )
    expect(container.innerHTML).not.toContain('https://github.com/acme/checkout/issues/412')
    expect(container.innerHTML).not.toContain('d-7f3c')
  })

  // The other two shapes `originLabel` answers, on the surface a person actually scans: a commit
  // sha joins after a SPACE, and a delivery with nothing to point at says the repository alone.
  it('says a sha-referenced and a ref-less origin the way `originLabel` says them', () => {
    const { unmount } = render(
      <TaskCard
        task={task({ origin: { ...ORIGIN, ref: '1a2b3c4', url: null } })}
        workspaceGoalVersion={2}
        onSelect={() => undefined}
      />,
    )
    expect(screen.getByTestId('task-origin').textContent).toBe('from GitHub · acme/checkout 1a2b3c4')
    unmount()

    render(
      <TaskCard task={task({ origin: { ...ORIGIN, ref: null } })} workspaceGoalVersion={2} onSelect={() => undefined} />,
    )
    expect(screen.getByTestId('task-origin').textContent).toBe('from GitHub · acme/checkout')
  })
})

// M61 R9/Task 7: the details block (run kind/attempt/artifacts, and everything else `DetailsGroup`
// folds) renders only for a developer -- `TaskDetailPanel`'s own explicit `isDeveloper` prop, so
// every one of this suite's neighbouring `TaskDetailPanel` renders below and elsewhere in the repo
// -- none of which pass it -- keeps seeing exactly what it always has (the prop defaults to `true`).
describe('TaskCard when nobody is named on it (H2)', () => {
  it('says nobody holds this role yet for a task whose role has no holder', () => {
    // Since H2 a planned task names its holder at creation and the tick names an older board on its
    // next pass, so a nameless card with a role means one thing: nobody on this project holds it.
    render(
      <TaskCard
        task={task({ assigneeName: null, requiredRole: 'backend' })}
        workspaceGoalVersion={2}
        onSelect={() => undefined}
      />,
    )
    expect(screen.getByTestId('task-assignee').textContent).toBe('nobody holds this role yet')
    expect(screen.queryByTestId('avatar-tile')).toBeNull()
  })

  it('says not started yet for a task with no role, which no roster gap explains', () => {
    // A hand-made task that asks for no role at all: nobody is missing from the project, so the
    // card must not report a staffing gap that does not exist.
    render(
      <TaskCard
        task={task({ assigneeName: null, requiredRole: null })}
        workspaceGoalVersion={2}
        onSelect={() => undefined}
      />,
    )
    expect(screen.getByTestId('task-assignee').textContent).toBe('not started yet')
  })

  it('treats an empty required role as no role at all, the way dispatch does', () => {
    render(
      <TaskCard
        task={task({ assigneeName: null, requiredRole: '' })}
        workspaceGoalVersion={2}
        onSelect={() => undefined}
      />,
    )
    expect(screen.getByTestId('task-assignee').textContent).toBe('not started yet')
  })

  it('names the person when there is one, whatever the role says', () => {
    render(
      <TaskCard
        task={task({ assigneeName: 'Alex Turner', requiredRole: null })}
        workspaceGoalVersion={2}
        onSelect={() => undefined}
      />,
    )
    expect(screen.getByTestId('task-assignee').textContent).toBe('Alex Turner')
  })
})

describe('TaskDetailPanel — raw details only in developer mode (M61 R9)', () => {
  const run: TaskRunSummary = {
    id: 'r1',
    status: 'succeeded',
    costUsd: 0.42,
    kind: 'implementation',
    tokensIn: null,
    tokensOut: null,
    model: null,
    provider: 'claude_code',
    toolCallCap: null,
    toolCalls: 5,
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
    worktreePath: null,
    checkpoint: null,
    waitingFor: null,
  }
  const withRun = (overrides: Partial<TaskBoardItem> = {}): TaskBoardItem =>
    ({
      id: 't1',
      title: 'Retry the charge',
      description: '',
      status: 'done',
      priority: 0,
      attempt: 1,
      maxAttempts: 3,
      assigneeName: null,
      branch: null,
      lastRejectionReason: null,
      goalVersion: 2,
      origin: null,
      integratedAt: null,
      runs: [run],
      collectable: false,
      artifacts: [],
      handoff: null,
      stage: null,
      stageTitle: null,
      ...overrides,
    }) as TaskBoardItem

  it('shows the run kind/attempt/artifact details by default (isDeveloper omitted)', () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={withRun()} onClose={() => {}} />)
    const details = screen.getByTestId('task-details')
    expect(within(details).getAllByTestId('details-group').map((el) => el.getAttribute('data-group'))).toContain('run')
    expect(within(details).getByTestId('run-total-cost').textContent).toContain('across 1 run')
  })

  it('shows it when isDeveloper is explicitly true', () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={withRun()} isDeveloper onClose={() => {}} />)
    expect(screen.getByTestId('task-details')).toBeTruthy()
  })

  // Fix round 1, Ruling 7: Cost is the one raw group that is NOT gated -- it stays in its own spot
  // (between Verification and Worktree) and renders in both modes, so "nothing at all" is no
  // longer true; the `task-details` wrapper (the other seven groups) is still absent.
  it('renders no task-details wrapper (the seven gated groups) but keeps Cost, when isDeveloper is false', () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={withRun()} isDeveloper={false} onClose={() => {}} />)
    expect(screen.queryByTestId('task-details')).toBeNull()
    expect(screen.queryByTestId('run-total-cost')).toBeNull()
    const groups = screen.getAllByTestId('details-group').map((el) => el.getAttribute('data-group'))
    expect(groups).toEqual(['cost'])
  })

  // The exact assertion the review asked for: Cost present, Run/Events (two of the seven still
  // gated groups) absent.
  it('shows Cost but not Run/Events when isDeveloper is false', () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={withRun()} isDeveloper={false} onClose={() => {}} />)
    const groups = screen.getAllByTestId('details-group').map((el) => el.getAttribute('data-group'))
    expect(groups).toContain('cost')
    expect(groups).not.toContain('run')
    expect(groups).not.toContain('events')
  })

  // The identity block above Details (ref, priority, goal stamp, title, status word, the one-line
  // why) is never gated -- only the RAW groups are (M45 R4's own progressive disclosure, folded
  // further by mode rather than replaced).
  it('keeps the panel identity visible in simple mode', () => {
    render(<TaskDetailPanel workspaceGoalVersion={0} workspaceId="w1" task={withRun()} isDeveloper={false} onClose={() => {}} />)
    expect(screen.getByTestId('task-panel-ref').textContent).toBe('TASK-t1')
    expect(screen.getByText('Retry the charge')).toBeTruthy()
  })
})
