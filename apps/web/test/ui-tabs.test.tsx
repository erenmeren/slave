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

  /**
   * M44 final review, minor d. The strip was a `role="tablist"` of `role="tab"`s that behaved like
   * three separate buttons: every one of them was its own Tab stop, and the arrow keys a screen
   * reader user is TOLD the role implies did nothing at all. APG's tabs pattern is one Tab stop
   * for the whole strip (roving tabindex) plus arrows/Home/End inside it.
   *
   * Automatic activation -- moving focus also selects -- because every consumer's panel switch is
   * local state, not a fetch (APG: manual activation is for panels that are expensive to reveal).
   * The ROUTE form is deliberately untouched: those tabs are `<Link>`s to other pages, they carry
   * no handler at all so the component stays safe in a server component, and giving them
   * `tabindex="-1"` would put four project pages out of reach of the Tab key.
   */
  describe('keyboard (APG tabs)', () => {
    it('is one Tab stop: the selected tab, and only it, is reachable', () => {
      render(<Tabs tabs={TABS} current="b" ariaLabel="Sections" testIdPrefix="t" onSelect={vi.fn()} />)
      expect(screen.getAllByRole('tab').map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
    })

    it('moves focus and selection with ArrowRight/ArrowLeft, wrapping at both ends', () => {
      const onSelect = vi.fn()
      render(<Tabs tabs={TABS} current="a" ariaLabel="Sections" testIdPrefix="t" onSelect={onSelect} />)

      fireEvent.keyDown(screen.getByTestId('t-a'), { key: 'ArrowRight' })
      expect(onSelect).toHaveBeenLastCalledWith('b')
      expect(document.activeElement).toBe(screen.getByTestId('t-b'))

      fireEvent.keyDown(screen.getByTestId('t-a'), { key: 'ArrowLeft' })
      expect(onSelect).toHaveBeenLastCalledWith('c')
      expect(document.activeElement).toBe(screen.getByTestId('t-c'))

      fireEvent.keyDown(screen.getByTestId('t-c'), { key: 'ArrowRight' })
      expect(onSelect).toHaveBeenLastCalledWith('a')
      expect(document.activeElement).toBe(screen.getByTestId('t-a'))
    })

    it('jumps to the first and last tab with Home and End', () => {
      const onSelect = vi.fn()
      render(<Tabs tabs={TABS} current="b" ariaLabel="Sections" testIdPrefix="t" onSelect={onSelect} />)

      fireEvent.keyDown(screen.getByTestId('t-b'), { key: 'End' })
      expect(onSelect).toHaveBeenLastCalledWith('c')
      expect(document.activeElement).toBe(screen.getByTestId('t-c'))

      fireEvent.keyDown(screen.getByTestId('t-b'), { key: 'Home' })
      expect(onSelect).toHaveBeenLastCalledWith('a')
      expect(document.activeElement).toBe(screen.getByTestId('t-a'))
    })

    it('steps over a disabled tab rather than landing on one it cannot select', () => {
      const onSelect = vi.fn()
      render(<Tabs tabs={TABS} current="a" ariaLabel="Sections" testIdPrefix="t" disabledIds={['b']} onSelect={onSelect} />)

      fireEvent.keyDown(screen.getByTestId('t-a'), { key: 'ArrowRight' })
      expect(onSelect).toHaveBeenLastCalledWith('c')
      expect(document.activeElement).toBe(screen.getByTestId('t-c'))
    })

    it('leaves every other key, and the route form, alone', () => {
      const onSelect = vi.fn()
      render(<Tabs tabs={TABS} current="a" ariaLabel="Sections" testIdPrefix="t" onSelect={onSelect} />)
      fireEvent.keyDown(screen.getByTestId('t-a'), { key: 'ArrowDown' })
      expect(onSelect).not.toHaveBeenCalled()

      render(
        <Tabs
          tabs={[{ id: 'a', label: 'Alpha', href: '/a' }, { id: 'b', label: 'Beta', href: '/b' }]}
          current="a"
          ariaLabel="Project"
          testIdPrefix="p"
        />,
      )
      // Every route tab keeps its own Tab stop: they are links to four different pages.
      expect(screen.getAllByTestId(/^p-/).map((tab) => tab.getAttribute('tabindex'))).toEqual([null, null])
    })
  })

  it('disables the tabs it is told to and does not select them', () => {
    const onSelect = vi.fn()
    render(<Tabs tabs={TABS} current="a" ariaLabel="Sections" testIdPrefix="t" disabledIds={['c']} onSelect={onSelect} />)
    expect((screen.getByTestId('t-c') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('t-c'))
    expect(onSelect).not.toHaveBeenCalled()
  })
})
