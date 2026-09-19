// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Stat } from '../src/components/ui/Stat.js'

describe('Stat', () => {
  it('renders the label, value and note under the given testid', () => {
    render(<Stat testId="stat-spend" label="Spend" value="$4.20" note="of $20" />)
    const stat = screen.getByTestId('stat-spend')
    expect(stat.textContent).toBe('Spend$4.20of $20')
  })

  it('renders with no note at all -- not an empty note node', () => {
    render(<Stat testId="stat-bare" label="Slaves" value="6" />)
    const stat = screen.getByTestId('stat-bare')
    expect(stat.textContent).toBe('Slaves6')
  })

  it('tints the value with the tone text colour when a tone is given, and leaves it untinted otherwise', () => {
    const { rerender } = render(<Stat testId="stat-tone" label="Blocked" value="1" tone="blocked" />)
    const value = screen.getByTestId('stat-tone').querySelector('.type-heading')
    expect(value?.className).toContain('text-tone-blocked')

    rerender(<Stat testId="stat-tone" label="Blocked" value="1" />)
    expect(screen.getByTestId('stat-tone').querySelector('.type-heading')?.className).not.toMatch(/text-tone-/)
  })

  it('carries the M61 surface recipe -- radius-surface, a hairline border, the card fill', () => {
    render(<Stat testId="stat-shape" label="x" value="y" />)
    const stat = screen.getByTestId('stat-shape')
    expect(stat.className).toContain('rounded-surface')
    expect(stat.className).toContain('border-line')
    expect(stat.className).toContain('bg-card')
  })
})
