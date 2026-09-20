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

  // M61 R16: the sliding `segmented-indicator` (measured off the active option's own
  // offsetLeft/offsetWidth in a layout effect -- 0 in jsdom, which the indicator's mere presence
  // does not depend on) plus `aria-selected` alongside the pre-existing `aria-pressed`.
  it('marks the chosen option aria-selected (alongside aria-pressed), and renders one indicator', () => {
    render(<Segmented options={OPTIONS} value="board" onChange={vi.fn()} ariaLabel="View" testIdPrefix="task-view" />)
    expect(screen.getByTestId('task-view-board').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('task-view-list').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('segmented-indicator')).toBeTruthy()
  })

  // M57 t8 fix round 1, ruling T8-2: an option that carries `href` renders as a link (Workforce's
  // two sub-segments navigate), not a button -- `aria-current`, never `aria-selected`/
  // `aria-pressed`, which are not valid ARIA on an element with an implicit `role="link"`.
  describe('an option with href', () => {
    const NAV_OPTIONS = [
      { id: 'board' as const, label: 'Board', href: '/tasks?view=board' },
      { id: 'list' as const, label: 'List', href: '/tasks?view=list' },
    ]

    it('renders a link carrying that href, not a button', () => {
      render(<Segmented options={NAV_OPTIONS} value="board" onChange={vi.fn()} ariaLabel="View" testIdPrefix="task-view" />)
      const link = screen.getByTestId('task-view-list')
      expect(link.tagName).toBe('A')
      expect(link.getAttribute('href')).toBe('/tasks?view=list')
    })

    it('calls onChange on click, same as the button form', () => {
      const onChange = vi.fn()
      render(<Segmented options={NAV_OPTIONS} value="board" onChange={onChange} ariaLabel="View" testIdPrefix="task-view" />)
      act((): void => { screen.getByTestId('task-view-list').click() })
      expect(onChange).toHaveBeenCalledWith('list')
    })

    it('shows aria-current="page" only on the chosen option, and never aria-selected', () => {
      render(<Segmented options={NAV_OPTIONS} value="list" onChange={vi.fn()} ariaLabel="View" testIdPrefix="task-view" />)
      expect(screen.getByTestId('task-view-list').getAttribute('aria-current')).toBe('page')
      expect(screen.getByTestId('task-view-board').getAttribute('aria-current')).toBeNull()
      expect(screen.getByTestId('task-view-list').getAttribute('aria-selected')).toBeNull()
      expect(screen.getByTestId('task-view-board').getAttribute('aria-selected')).toBeNull()
    })
  })
})
