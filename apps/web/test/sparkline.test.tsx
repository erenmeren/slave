// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sparkline } from '../src/components/Sparkline.js'

describe('Sparkline', () => {
  it('renders an svg with role=img and the given aria-label', () => {
    render(<Sparkline buckets={[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]} width={160} height={24} label="tool calls, last 10 minutes" />)
    const svg = screen.getByRole('img', { name: 'tool calls, last 10 minutes' })
    expect(svg.tagName.toLowerCase()).toBe('svg')
    expect(svg.getAttribute('width')).toBe('160')
    expect(svg.getAttribute('height')).toBe('24')
  })

  it('scales all 10 points to the max bucket value, reaching the top and bottom edges', () => {
    const height = 24
    render(<Sparkline buckets={[0, 0, 5, 0, 0, 0, 0, 0, 0, 10]} width={160} height={height} label="tool calls" />)
    const polyline = document.querySelector('polyline')
    expect(polyline).toBeTruthy()
    const pointsAttr = polyline!.getAttribute('points')!
    const points = pointsAttr
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(',').map(Number) as [number, number])
    expect(points).toHaveLength(10)

    // The max bucket (10, index 9) scales to the top edge (y = 0).
    const maxPoint = points[9]
    expect(maxPoint?.[1]).toBeCloseTo(0, 5)

    // A zero bucket scales to the bottom edge (y = height).
    const zeroPoint = points[0]
    expect(zeroPoint?.[1]).toBeCloseTo(height, 5)
  })

  it('renders a flat baseline polyline (not an empty svg) when every bucket is zero', () => {
    const height = 24
    render(<Sparkline buckets={[0, 0, 0, 0, 0, 0, 0, 0, 0, 0]} width={160} height={height} label="tool calls" />)
    const polyline = document.querySelector('polyline')
    expect(polyline).toBeTruthy()
    const pointsAttr = polyline!.getAttribute('points')!
    const points = pointsAttr
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(',').map(Number) as [number, number])
    expect(points).toHaveLength(10)
    // Every point sits at the bottom edge — a flat baseline, not collapsed/empty.
    for (const [, y] of points) expect(y).toBeCloseTo(height, 5)
  })

  it('colours the stroke with currentColor so the parent text token controls it', () => {
    render(<Sparkline buckets={[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]} width={60} height={16} label="tool calls" />)
    const polyline = document.querySelector('polyline')
    expect(polyline?.getAttribute('stroke')).toBe('currentColor')
  })
})
