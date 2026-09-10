// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DangerConfirm } from '../src/components/ui/DangerConfirm.js'

describe('DangerConfirm', () => {
  it('asks twice: the trigger reveals the confirm text and a cancel; cancel calls nothing', () => {
    const onConfirm = vi.fn(async () => null)
    render(<DangerConfirm label="delete" testId="x" confirmText="deletes Alex and 14 runs" onConfirm={onConfirm} />)
    expect(screen.queryByTestId('x-confirm')).toBeNull()
    fireEvent.click(screen.getByTestId('x'))
    expect(screen.getByTestId('x-confirm').textContent).toBe('deletes Alex and 14 runs')
    fireEvent.click(screen.getByTestId('x-cancel'))
    expect(screen.queryByTestId('x-confirm')).toBeNull()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('calls onConfirm on the second click and closes on null', async () => {
    const onConfirm = vi.fn(async () => null)
    render(<DangerConfirm label="delete" testId="x" confirmText="deletes it" onConfirm={onConfirm} />)
    fireEvent.click(screen.getByTestId('x'))
    await act(async () => { fireEvent.click(screen.getByTestId('x-confirm')) })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('x-confirm')).toBeNull()
  })

  // M27 final review, parked: a second click on the confirm while the first is still pending
  // must not run the destructive action twice.
  it('ignores a second confirm click while the first is pending', async () => {
    let resolveConfirm: (value: string | null) => void = () => {}
    const onConfirm = vi.fn(() => new Promise<string | null>((resolve) => { resolveConfirm = resolve }))
    render(<DangerConfirm label="delete" testId="x" confirmText="deletes it" onConfirm={onConfirm} />)
    fireEvent.click(screen.getByTestId('x'))
    const confirm = screen.getByTestId('x-confirm')
    await act(async () => { fireEvent.click(confirm) })
    await act(async () => { fireEvent.click(confirm) })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await act(async () => { resolveConfirm(null) })
    expect(screen.queryByTestId('x-confirm')).toBeNull()
  })

  it('shows a refusal and stays open', async () => {
    const onConfirm = vi.fn(async () => 'slave a1 has 1 live run(s)')
    render(<DangerConfirm label="delete" testId="x" confirmText="deletes it" onConfirm={onConfirm} />)
    fireEvent.click(screen.getByTestId('x'))
    await act(async () => { fireEvent.click(screen.getByTestId('x-confirm')) })
    expect(screen.getByTestId('x-error').textContent).toContain('live run')
    expect(screen.getByTestId('x-confirm')).toBeTruthy()
  })

  // R10: the brief's own case named Escape without pressing it -- this presses it, and keeps the
  // disabled assertion so the case still covers both things its name promises.
  it('cancels on Escape and respects disabled', () => {
    const onConfirm = vi.fn(async () => null)
    render(<DangerConfirm label="delete" testId="x" confirmText="deletes it" onConfirm={onConfirm} />)
    fireEvent.click(screen.getByTestId('x'))
    expect(screen.getByTestId('x-confirm')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByTestId('x-confirm')).toBeNull()
    expect(onConfirm).not.toHaveBeenCalled()

    render(<DangerConfirm label="delete" testId="y" confirmText="deletes it" onConfirm={async () => null} disabled />)
    expect((screen.getByTestId('y') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('DangerConfirm, widened for EmergencyStop and DangerZone (M44 R3, erratum E12)', () => {
  it('is an alertdialog while it is asking, named after its label', () => {
    render(<DangerConfirm label="STOP" testId="x" confirmText="stop everything" onConfirm={async () => null} />)
    fireEvent.click(screen.getByTestId('x'))
    expect(screen.getByRole('alertdialog', { name: /STOP/ })).toBeTruthy()
  })

  it('focuses the confirm on open and gives focus back to the trigger on Escape', () => {
    render(<DangerConfirm label="STOP" testId="x" confirmText="stop everything" onConfirm={async () => null} />)
    screen.getByTestId('x').focus()
    fireEvent.click(screen.getByTestId('x'))
    expect(document.activeElement).toBe(screen.getByTestId('x-confirm'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(screen.getByTestId('x'))
  })

  it('carries a title on the idle trigger, for a disabled control that has to say why', () => {
    render(<DangerConfirm label="STOP" testId="x" confirmText="c" disabled title="workspace is already halted" onConfirm={async () => null} />)
    expect(screen.getByTestId('x').getAttribute('title')).toBe('workspace is already halted')
  })
})
