// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Dialog } from '../src/components/ui/Dialog.js'
import { Drawer } from '../src/components/ui/Drawer.js'

describe('Dialog and Drawer own Escape, the focus trap and the focus restore (M44 R3/R6)', () => {
  for (const [name, Modal] of [['Dialog', Dialog], ['Drawer', Drawer]] as const) {
    it(`${name} renders nothing when closed and an aria-modal dialog when open`, () => {
      const { rerender } = render(<Modal open={false} onClose={vi.fn()} label="L" testId="m"><button type="button">x</button></Modal>)
      expect(screen.queryByTestId('m')).toBeNull()
      rerender(<Modal open onClose={vi.fn()} label="L" testId="m"><button type="button">x</button></Modal>)
      const node = screen.getByTestId('m')
      expect(node.getAttribute('role')).toBe('dialog')
      expect(node.getAttribute('aria-modal')).toBe('true')
      expect(node.getAttribute('aria-label')).toBe('L')
    })

    it(`${name} moves focus inside on open`, () => {
      render(<Modal open onClose={vi.fn()} label="L" testId="m"><button type="button" data-testid="first">first</button></Modal>)
      expect(document.activeElement).toBe(screen.getByTestId('first'))
    })

    it(`${name} closes on Escape`, () => {
      const onClose = vi.fn()
      render(<Modal open onClose={onClose} label="L" testId="m"><button type="button">x</button></Modal>)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it(`${name} ignores Escape while dismissible is false -- a request is in flight`, () => {
      const onClose = vi.fn()
      render(<Modal open dismissible={false} onClose={onClose} label="L" testId="m"><button type="button">x</button></Modal>)
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
    })

    it(`${name} wraps Tab from the last focusable back to the first, and Shift+Tab the other way`, () => {
      render(
        <Modal open onClose={vi.fn()} label="L" testId="m">
          <button type="button" data-testid="first">first</button>
          <input data-testid="middle" />
          <button type="button" data-testid="last">last</button>
        </Modal>,
      )
      const first = screen.getByTestId('first')
      const last = screen.getByTestId('last')

      last.focus()
      fireEvent.keyDown(screen.getByTestId('m'), { key: 'Tab' })
      expect(document.activeElement).toBe(first)

      first.focus()
      fireEvent.keyDown(screen.getByTestId('m'), { key: 'Tab', shiftKey: true })
      expect(document.activeElement).toBe(last)
    })

    it(`${name} gives focus back to whatever opened it`, () => {
      // One stable harness component across all three renders, deliberately: React reconciles the
      // ROOT element by type, so handing `rerender` a different top-level type (a fragment one
      // time, a component the next) unmounts and rebuilds the trigger -- and a trigger that was
      // destroyed between opening and closing is exactly the case `useModalDismiss` refuses to
      // focus (`isConnected`). Toggling one prop on one component is what a real caller does.
      function Harness({ open }: { readonly open: boolean }): React.JSX.Element {
        return (
          <>
            <button type="button" data-testid="trigger">open</button>
            <Modal open={open} onClose={vi.fn()} label="L" testId="m"><button type="button" data-testid="first">first</button></Modal>
          </>
        )
      }
      const { rerender } = render(<Harness open={false} />)
      screen.getByTestId('trigger').focus()
      expect(document.activeElement).toBe(screen.getByTestId('trigger'))
      rerender(<Harness open />)
      expect(document.activeElement).toBe(screen.getByTestId('first'))
      rerender(<Harness open={false} />)
      expect(document.activeElement).toBe(screen.getByTestId('trigger'))
    })

    it(`${name} leaves focus alone when the trigger itself unmounted while it was open`, () => {
      // The two-step confirm idiom replaces its own trigger, so there is nothing to give focus
      // back to; focusing the detached node would silently drop focus to `<body>` anyway.
      function Harness({ open }: { readonly open: boolean }): React.JSX.Element {
        return (
          <>
            {!open && <button type="button" data-testid="trigger">open</button>}
            <Modal open={open} onClose={vi.fn()} label="L" testId="m"><button type="button" data-testid="first">first</button></Modal>
          </>
        )
      }
      const { rerender } = render(<Harness open={false} />)
      screen.getByTestId('trigger').focus()
      rerender(<Harness open />)
      expect(document.activeElement).toBe(screen.getByTestId('first'))
      rerender(<Harness open={false} />)
      expect(document.activeElement).toBe(document.body)
    })
  }
})
