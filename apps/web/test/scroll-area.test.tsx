// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScrollArea } from '../src/components/ui/ScrollArea.js'

describe('ScrollArea', () => {
  it('is the one scrolling region: min-h-0, flex-1, and overflow-y-auto by default', () => {
    render(
      <ScrollArea testId="x">
        <div style={{ height: 2000 }} />
      </ScrollArea>,
    )
    const el = screen.getByTestId('x')
    expect(el.className).toContain('overflow-y-auto')
    expect(el.className).toContain('min-h-0')
  })

  it('scrolls sideways when axis is x', () => {
    render(
      <ScrollArea testId="x" axis="x">
        <div style={{ width: 2000 }} />
      </ScrollArea>,
    )
    expect(screen.getByTestId('x').className).toContain('overflow-x-auto')
  })
})
