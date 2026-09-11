// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskDetailPanel } from '../src/components/TaskDetailPanel'
import { taskItem } from './fixtures/taskItem'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }))

describe('the handoff group (M48 R7)', () => {
  it('shows the stage as a chip above the fold and the contract inside its own Details group', () => {
    render(
      <TaskDetailPanel
        workspaceId="w1"
        workspaceGoalVersion={1}
        onClose={() => undefined}
        task={taskItem({
          stage: 'implement',
          stageTitle: 'Implement',
          handoff: {
            objective: 'Add an authentication path',
            expectedOutput: 'Every route requires a session',
            acceptanceCriteria: ['Anonymous requests get 401'],
            knownConstraints: [],
            evidenceRequired: ['The verify log'],
            contextReferences: [],
          },
        })}
      />,
    )
    expect(screen.getByTestId('task-stage-chip').textContent).toBe('Implement')
    const group = screen.getAllByTestId('details-group').find((node) => node.getAttribute('data-group') === 'handoff')
    expect(group).toBeDefined()
    if (group === undefined) return
    expect(group.textContent).toContain('Add an authentication path')
    expect(group.textContent).toContain('Anonymous requests get 401')
    expect(group.textContent).toContain('The verify log')
    // An empty list is not an empty heading.
    expect(group.textContent).not.toContain('Known constraints')
    // And it folds like every other group.
    fireEvent.click(group.querySelector('button') as HTMLButtonElement)
    expect(group.textContent).not.toContain('Add an authentication path')
  })

  it('has no handoff group and no stage chip for a task with neither', () => {
    render(<TaskDetailPanel workspaceId="w1" workspaceGoalVersion={1} onClose={() => undefined} task={taskItem({})} />)
    expect(screen.queryByTestId('task-stage-chip')).toBeNull()
    expect(screen.getAllByTestId('details-group').some((node) => node.getAttribute('data-group') === 'handoff')).toBe(false)
  })

  it('shows the stage chip on a task that has one and no contract -- the two are separate facts', () => {
    render(
      <TaskDetailPanel
        workspaceId="w1"
        workspaceGoalVersion={1}
        onClose={() => undefined}
        task={taskItem({ stage: 'verify', stageTitle: 'Verify' })}
      />,
    )
    expect(screen.getByTestId('task-stage-chip').textContent).toBe('Verify')
    expect(screen.getAllByTestId('details-group').some((node) => node.getAttribute('data-group') === 'handoff')).toBe(false)
  })

  // Fix round 1, Important 2: the chip is a WORD. The key stays in `title`, where a person can
  // hover it and a gate can read it (docs/ia.md rule 3, M44 R5).
  it('prints the stage TITLE, with the key only in title=', () => {
    render(
      <TaskDetailPanel
        workspaceId="w1"
        workspaceGoalVersion={1}
        onClose={() => undefined}
        task={taskItem({ stage: 'threat-model', stageTitle: 'Threat model' })}
      />,
    )
    const chip = screen.getByTestId('task-stage-chip')
    expect(chip.textContent).toBe('Threat model')
    expect(chip.getAttribute('title')).toBe('threat-model')
  })

  it('says `Unlisted stage` for a stage the adopted runbook does not list, never the raw key', () => {
    render(
      <TaskDetailPanel workspaceId="w1" workspaceGoalVersion={1} onClose={() => undefined} task={taskItem({ stage: 'shipit' })} />,
    )
    const chip = screen.getByTestId('task-stage-chip')
    expect(chip.textContent).toBe('Unlisted stage')
    expect(chip.textContent).not.toContain('shipit')
    expect(chip.getAttribute('title')).toBe('shipit')
  })
})
