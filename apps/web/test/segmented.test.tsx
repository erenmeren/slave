// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Segmented } from '../src/components/ui/Segmented.js'

const OPTIONS = [
  { id: 'board' as const, label: 'Board' },
  { id: 'list' as const, label: 'List', count: 12 },
]

describe('Segmented', () => {
  it('names every segment by the caller s prefix and marks the chosen one', () => {
    render(<Segmented options={OPTIONS} value="board" onChange={vi.fn()} ariaLabel="View" testIdPrefix="task-view" />)
    expect(screen.getByTestId('task-view').getAttribute('data-value')).toBe('board')
    expect(screen.getByTestId('task-view-board').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('task-view-list').getAttribute('aria-pressed')).toBe('false')
  })

  it('reports the segment that was pressed, and never sets state of its own', () => {
    const onChange = vi.fn()
    render(<Segmented options={OPTIONS} value="board" onChange={onChange} ariaLabel="View" testIdPrefix="task-view" />)
    act((): void => { screen.getByTestId('task-view-list').click() })
    expect(onChange).toHaveBeenCalledWith('list')
    // Still `board`: the caller owns the value.
    expect(screen.getByTestId('task-view').getAttribute('data-value')).toBe('board')
  })

  it('shows a count beside a segment that has one, and nothing where there is none', () => {
    render(<Segmented options={OPTIONS} value="board" onChange={vi.fn()} ariaLabel="View" testIdPrefix="task-view" />)
    expect(screen.getByTestId('task-view-list').textContent).toContain('12')
    expect(screen.getByTestId('task-view-board').textContent).toBe('Board')
  })

  it('is a named group, so a screen reader says what the choice is about', () => {
    render(<Segmented options={OPTIONS} value="list" onChange={vi.fn()} ariaLabel="View" testIdPrefix="task-view" />)
    expect(screen.getByRole('group', { name: 'View' })).toBeTruthy()
  })
})
