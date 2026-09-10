// @vitest-environment jsdom
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DangerConfirm } from '../src/components/ui/DangerConfirm.js'
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

    it(`${name} closes when the scrim is clicked`, () => {
      const onClose = vi.fn()
      render(<Modal open onClose={onClose} label="L" testId="m"><button type="button">x</button></Modal>)
      fireEvent.click(screen.getByTestId('m-scrim'))
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it(`${name} ignores a scrim click while dismissible is false`, () => {
      const onClose = vi.fn()
      render(<Modal open dismissible={false} onClose={onClose} label="L" testId="m"><button type="button">x</button></Modal>)
      fireEvent.click(screen.getByTestId('m-scrim'))
      expect(onClose).not.toHaveBeenCalled()
    })

    it(`${name} still traps Tab while dismissible is false -- refusing to CLOSE is not refusing to HOLD focus`, () => {
      render(
        <Modal open dismissible={false} onClose={vi.fn()} label="L" testId="m">
          <button type="button" data-testid="first">first</button>
          <button type="button" data-testid="last">last</button>
        </Modal>,
      )
      screen.getByTestId('last').focus()
      fireEvent.keyDown(screen.getByTestId('m'), { key: 'Tab' })
      expect(document.activeElement).toBe(screen.getByTestId('first'))
    })

    it(`${name} swallows Tab when nothing inside is focusable, rather than letting focus walk out`, () => {
      // Every control disabled mid-POST, or a progress-only modal: there is nothing to cycle
      // between, and the browser's default Tab would leave an aria-modal container.
      render(
        <Modal open onClose={vi.fn()} label="L" testId="m">
          <button type="button" data-testid="only" disabled>working…</button>
        </Modal>,
      )
      const node = screen.getByTestId('m')
      expect(document.activeElement).toBe(node)
      const notPrevented = fireEvent.keyDown(node, { key: 'Tab' })
      expect(notPrevented).toBe(false)
      expect(document.activeElement).toBe(node)
    })

    it(`${name} cycles forward off the container itself onto the first focusable`, () => {
      render(
        <Modal open onClose={vi.fn()} label="L" testId="m">
          <button type="button" data-testid="first">first</button>
          <button type="button" data-testid="last">last</button>
        </Modal>,
      )
      const node = screen.getByTestId('m')
      node.focus()
      fireEvent.keyDown(node, { key: 'Tab' })
      expect(document.activeElement).toBe(screen.getByTestId('first'))
    })
  }
})

describe('Drawer geometry', () => {
  it('takes the width it is given, and is 520px otherwise', () => {
    const { rerender } = render(<Drawer open onClose={vi.fn()} label="L" testId="m"><button type="button">x</button></Drawer>)
    expect(screen.getByTestId('m').className).toContain('w-[520px]')
    rerender(<Drawer open width="w-[720px]" onClose={vi.fn()} label="L" testId="m"><button type="button">x</button></Drawer>)
    expect(screen.getByTestId('m').className).toContain('w-[720px]')
  })
})

describe('One Escape belongs to ONE layer (M44 R3 fix round 1)', () => {
  function DrawerWithConfirm(): React.JSX.Element {
    const [open, setOpen] = useState(true)
    return (
      <Drawer open={open} onClose={() => setOpen(false)} label="Settings" testId="d">
        <DangerConfirm label="delete" testId="dc" confirmText="deletes it" onConfirm={async () => null} />
      </Drawer>
    )
  }

  it('a DangerConfirm inside a Drawer takes the first Escape for itself and leaves the drawer open', () => {
    render(<DrawerWithConfirm />)
    fireEvent.click(screen.getByTestId('dc'))
    expect(document.activeElement).toBe(screen.getByTestId('dc-confirm'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('dc-confirm')).toBeNull()
    expect(screen.getByTestId('d')).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByTestId('dc'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('d')).toBeNull()
  })
})
