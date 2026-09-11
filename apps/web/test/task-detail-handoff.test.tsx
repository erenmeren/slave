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
    expect(screen.getByTestId('task-stage-chip').textContent).toBe('implement')
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
      <TaskDetailPanel workspaceId="w1" workspaceGoalVersion={1} onClose={() => undefined} task={taskItem({ stage: 'verify' })} />,
    )
    expect(screen.getByTestId('task-stage-chip').textContent).toBe('verify')
    expect(screen.getAllByTestId('details-group').some((node) => node.getAttribute('data-group') === 'handoff')).toBe(false)
  })
})
