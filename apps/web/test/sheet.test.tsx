// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Sheet } from '../src/components/ui/Sheet.js'

// `useReducedMotion` mocked to `true` for this whole file (there is only one describe here) so the
// panel's animated properties resolve to the `noMotion` branch and the DOM settles synchronously --
// jsdom runs no real animation frames, so asserting against an in-flight spring would be flaky
// regardless. The non-reduced branch is exercised by the milestone's real-browser gate, not here.
// `vi.mock` is hoisted above every import in this file (including `Sheet`'s own, which pulls in
// `motion/react` transitively), so its textual position here does not matter.
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => true,
}))

describe('Sheet', () => {
  it('renders nothing when closed, and an aria-modal dialog with its testid/side/close button when open', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Sheet open={false} onClose={onClose} title="Hire" testId="hire-sheet">
        body
      </Sheet>,
    )
    expect(screen.queryByTestId('hire-sheet')).toBeNull()

    rerender(
      <Sheet open onClose={onClose} title="Hire" testId="hire-sheet">
        body
      </Sheet>,
    )
    const panel = screen.getByTestId('hire-sheet')
    expect(panel.getAttribute('role')).toBe('dialog')
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panel.getAttribute('data-side')).toBe('right')
    // The dialog's accessible name is the title -- `aria-label`, not a visually-hidden heading.
    expect(panel.getAttribute('aria-label')).toBe('Hire')
    expect(screen.getByTestId('sheet-close')).toBeTruthy()
    expect(screen.getByText('body')).toBeTruthy()
  })

  it('takes the side it is given, "bottom" included', () => {
    render(
      <Sheet open onClose={vi.fn()} title="Detail" testId="d-sheet" side="bottom">
        body
      </Sheet>,
    )
    expect(screen.getByTestId('d-sheet').getAttribute('data-side')).toBe('bottom')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <Sheet open onClose={onClose} title="Hire" testId="hire-sheet">
        <button type="button">x</button>
      </Sheet>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the header close button is clicked', () => {
    const onClose = vi.fn()
    render(
      <Sheet open onClose={onClose} title="Hire" testId="hire-sheet">
        body
      </Sheet>,
    )
    fireEvent.click(screen.getByTestId('sheet-close'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the scrim is clicked', () => {
    const onClose = vi.fn()
    render(
      <Sheet open onClose={onClose} title="Hire" testId="hire-sheet">
        body
      </Sheet>,
    )
    fireEvent.click(screen.getByTestId('hire-sheet-root').firstElementChild as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('focuses the panel on open, and returns focus to whatever opened it on close', () => {
    function Harness({ open }: { readonly open: boolean }): React.JSX.Element {
      return (
        <>
          <button type="button" data-testid="trigger">
            open
          </button>
          <Sheet open={open} onClose={vi.fn()} title="Hire" testId="hire-sheet">
            body
          </Sheet>
        </>
      )
    }
    const { rerender } = render(<Harness open={false} />)
    screen.getByTestId('trigger').focus()
    expect(document.activeElement).toBe(screen.getByTestId('trigger'))

    rerender(<Harness open />)
    expect(document.activeElement).toBe(screen.getByTestId('hire-sheet'))

    rerender(<Harness open={false} />)
    expect(document.activeElement).toBe(screen.getByTestId('trigger'))
  })

  // The header's own `sheet-close` button is the first focusable element in DOM order (the header
  // sits above the scrolling body), so Tab off the caller's own last child wraps there -- not to
  // the caller's own "first" child, which is second in the panel's actual tab order.
  it('wraps Tab from the last focusable to the header close button, and Shift+Tab the other way', () => {
    render(
      <Sheet open onClose={vi.fn()} title="Hire" testId="hire-sheet">
        <button type="button" data-testid="first">
          first
        </button>
        <input data-testid="middle" />
        <button type="button" data-testid="last">
          last
        </button>
      </Sheet>,
    )
    const close = screen.getByTestId('sheet-close')
    const last = screen.getByTestId('last')

    last.focus()
    fireEvent.keyDown(screen.getByTestId('hire-sheet'), { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    close.focus()
    fireEvent.keyDown(screen.getByTestId('hire-sheet'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})
