// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EmergencyStopButton } from '../src/components/EmergencyStopButton.js'

describe('EmergencyStopButton', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('(a) renders enabled when not halted, disabled when halted', () => {
    const { rerender } = render(<EmergencyStopButton workspaceId="w1" halted={false} />)
    expect(screen.getByTestId('emergency-stop').getAttribute('disabled')).toBeNull()

    rerender(<EmergencyStopButton workspaceId="w1" halted={true} />)
    const button = screen.getByTestId('emergency-stop')
    expect(button.getAttribute('disabled')).not.toBeNull()
    expect(button.getAttribute('title')).toBe('workspace is already halted')
  })

  it('(b) click shows confirm + cancel and no fetch has fired', () => {
    render(<EmergencyStopButton workspaceId="w1" halted={false} />)
    fireEvent.click(screen.getByTestId('emergency-stop'))

    expect(screen.getByRole('alertdialog', { name: 'confirm emergency stop' })).toBeTruthy()
    expect(screen.getByTestId('emergency-stop-confirm')).toBeTruthy()
    expect(screen.getByTestId('emergency-stop-cancel')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('(c) cancel returns to idle, no fetch', () => {
    render(<EmergencyStopButton workspaceId="w1" halted={false} />)
    fireEvent.click(screen.getByTestId('emergency-stop'))
    fireEvent.click(screen.getByTestId('emergency-stop-cancel'))

    expect(screen.getByTestId('emergency-stop')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('(d) confirm POSTs /api/w/w1/emergency-stop and returns to idle on 200', async () => {
    render(<EmergencyStopButton workspaceId="w1" halted={false} />)
    fireEvent.click(screen.getByTestId('emergency-stop'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('emergency-stop-confirm'))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/emergency-stop', expect.objectContaining({ method: 'POST' }))
    expect(screen.getByTestId('emergency-stop')).toBeTruthy()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    // No optimistic UI: the button is not itself flipped disabled by a successful POST — only the
    // `halted` prop (owned by the snapshot refetch, upstream of this component) can do that.
    expect(screen.getByTestId('emergency-stop').getAttribute('disabled')).toBeNull()
  })

  it('(e) a 409 refusal renders in the role="alert" span', async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'no workspace to stop' }), { status: 409 }),
    )
    render(<EmergencyStopButton workspaceId="w1" halted={false} />)
    fireEvent.click(screen.getByTestId('emergency-stop'))

    await act(async () => {
      fireEvent.click(screen.getByTestId('emergency-stop-confirm'))
    })

    expect(screen.getByRole('alert').textContent).toContain('no workspace to stop')
    // Still in the confirm state — a failed stop does not silently drop back to idle.
    expect(screen.getByTestId('emergency-stop-confirm')).toBeTruthy()
  })

  it('(f) Escape in confirm state returns focus to the STOP button', () => {
    render(<EmergencyStopButton workspaceId="w1" halted={false} />)
    const trigger = screen.getByTestId('emergency-stop')
    fireEvent.click(trigger)
    expect(screen.getByTestId('emergency-stop-confirm')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByTestId('emergency-stop')).toBe(document.activeElement)
  })
})
