// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AppShell } from '../src/components/shell/AppShell.js'

describe('the app shell', () => {
  it('is a three-column grid with the README widths, and says which third column it has', () => {
    render(
      <AppShell
        sidebar={<nav aria-label="Primary" />}
        header={<div data-testid="h" />}
        right={<aside data-testid="r" />}
        rightWidth="panel"
      >
        <div data-testid="page" />
      </AppShell>,
    )
    const shell = screen.getByTestId('app-shell')
    expect(shell.getAttribute('data-right')).toBe('panel')
    expect(shell.className).toContain('min-w-[1280px]')
    expect(shell.style.gridTemplateColumns).toBe('236px minmax(0, 1fr) 372px')
  })

  it('narrows the third column to the dock', () => {
    render(<AppShell sidebar={<nav />} header={<div />} right={<aside />} rightWidth="dock"><div /></AppShell>)
    const shell = screen.getByTestId('app-shell')
    expect(shell.getAttribute('data-right')).toBe('dock')
    expect(shell.style.gridTemplateColumns).toBe('236px minmax(0, 1fr) 52px')
  })

  it('has no third column at all on a global route', () => {
    render(<AppShell sidebar={<nav />} header={<div />} right={null} rightWidth="none"><div /></AppShell>)
    const shell = screen.getByTestId('app-shell')
    expect(shell.getAttribute('data-right')).toBe('none')
    expect(shell.style.gridTemplateColumns).toBe('236px minmax(0, 1fr)')
  })

  it('puts the page inside the one main landmark, which is #main and focusable', () => {
    render(<AppShell sidebar={<nav />} header={<div />} right={null} rightWidth="none"><div data-testid="page" /></AppShell>)
    const main = screen.getByRole('main')
    expect(main.getAttribute('id')).toBe('main')
    expect(main.getAttribute('tabindex')).toBe('-1')
    expect(main.contains(screen.getByTestId('page'))).toBe(true)
  })
})
