// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Tabs } from '../src/components/ui/Tabs.js'

const TABS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta', badge: 7 },
  { id: 'c', label: 'Gamma' },
]

describe('Tabs', () => {
  it('is a tablist of tabs, one selected, with the name it was given', () => {
    render(<Tabs tabs={TABS} current="b" ariaLabel="Sections" testIdPrefix="t" onSelect={vi.fn()} />)
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('Sections')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.getAttribute('data-testid'))).toEqual(['t-a', 't-b', 't-c'])
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(screen.getByTestId('t-b').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('t-a').getAttribute('aria-current')).toBeNull()
  })

  it('renders a badge only where one was given', () => {
    render(<Tabs tabs={TABS} current="a" ariaLabel="Sections" testIdPrefix="t" onSelect={vi.fn()} />)
    expect(screen.getByTestId('t-badge-b').textContent).toBe('7')
    expect(screen.queryByTestId('t-badge-a')).toBeNull()
  })

  it('calls onSelect with the tab id', () => {
    const onSelect = vi.fn()
    render(<Tabs tabs={TABS} current="a" ariaLabel="Sections" testIdPrefix="t" onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('t-c'))
    expect(onSelect).toHaveBeenCalledWith('c')
  })

  it('renders links, not buttons, when a tab carries an href', () => {
    render(
      <Tabs
        tabs={[{ id: 'a', label: 'Alpha', href: '/a' }, { id: 'b', label: 'Beta', href: '/b' }]}
        current="a"
        ariaLabel="Project"
        testIdPrefix="p"
      />,
    )
    expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('href'))).toEqual(['/a', '/b'])
  })

  it('disables the tabs it is told to and does not select them', () => {
    const onSelect = vi.fn()
    render(<Tabs tabs={TABS} current="a" ariaLabel="Sections" testIdPrefix="t" disabledIds={['c']} onSelect={onSelect} />)
    expect((screen.getByTestId('t-c') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('t-c'))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
