// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TaskCard } from '../src/components/TaskCard'
import type { TaskBoardItem } from '../src/server/tasks'

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
