// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SettingsFrame } from '../src/components/ui/SettingsFrame.js'

const SECTIONS = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'bravo', label: 'Bravo' },
  { id: 'charlie', label: 'Charlie' },
  { id: 'delta', label: 'Delta' },
  { id: 'echo', label: 'Echo' },
] as const

describe('SettingsFrame', () => {
  it('renders one settings-nav-item per section, in order', () => {
    render(
      <SettingsFrame sections={SECTIONS} current="alpha" onSelect={() => {}}>
        <div>alpha content</div>
      </SettingsFrame>,
    )
    const items = screen.getAllByTestId('settings-nav-item')
    expect(items).toHaveLength(5)
    expect(items.map((item) => item.getAttribute('data-section'))).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo'])
    expect(items.map((item) => item.textContent)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'])
  })

  it('marks the chosen section with aria-current="page", and none of the others', () => {
    render(
      <SettingsFrame sections={SECTIONS} current="charlie" onSelect={() => {}}>
        <div>charlie content</div>
      </SettingsFrame>,
    )
    const items = screen.getAllByTestId('settings-nav-item')
    const chosen = items.filter((item) => item.getAttribute('data-section') === 'charlie')[0]
    expect(chosen?.getAttribute('aria-current')).toBe('page')
    const others = items.filter((item) => item.getAttribute('data-section') !== 'charlie')
    for (const other of others) expect(other.getAttribute('aria-current')).toBeNull()
  })

  it('calls onSelect with the clicked section id', () => {
    const onSelect = vi.fn()
    render(
      <SettingsFrame sections={SECTIONS} current="alpha" onSelect={onSelect}>
        <div>alpha content</div>
      </SettingsFrame>,
    )
    const delta = screen.getAllByTestId('settings-nav-item').find((item) => item.getAttribute('data-section') === 'delta')
    fireEvent.click(delta as HTMLElement)
    expect(onSelect).toHaveBeenCalledWith('delta')
  })

  it('renders whatever children the caller mounted, in a scroll area', () => {
    render(
      <SettingsFrame sections={SECTIONS} current="alpha" onSelect={() => {}}>
        <div data-testid="the-content">only this</div>
      </SettingsFrame>,
    )
    expect(screen.getByTestId('the-content').textContent).toBe('only this')
  })
})
