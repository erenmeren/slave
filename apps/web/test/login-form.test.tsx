// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginForm } from '../src/components/LoginForm.js'

const assign = vi.fn()

describe('LoginForm', () => {
  beforeEach(() => {
    assign.mockReset()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { assign, pathname: '/login', search: '?next=%2Fw%2Fabc' },
    })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('submits the password through sendControl and navigates to next on success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    render(<LoginForm next="/w/abc" />)
    const submit = screen.getByTestId('login-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: 'hunter2' } })
    expect(submit.disabled).toBe(false)
    await act(async () => {
      fireEvent.submit(screen.getByTestId('login-form'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST', body: JSON.stringify({ password: 'hunter2' }) }))
    expect(assign).toHaveBeenCalledWith('/w/abc')
  })

  it('shows the refusal text and stays put on a wrong password', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'wrong password' }, { status: 401 }))
    render(<LoginForm next="/" />)
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: 'nope' } })
    await act(async () => {
      fireEvent.submit(screen.getByTestId('login-form'))
    })
    expect(screen.getByTestId('login-error').textContent).toBe('wrong password')
    expect(assign).not.toHaveBeenCalled()
    expect((screen.getByTestId('login-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('never renders a blank error band', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 502 }))
    render(<LoginForm next="/" />)
    fireEvent.change(screen.getByTestId('login-password'), { target: { value: 'x' } })
    await act(async () => {
      fireEvent.submit(screen.getByTestId('login-form'))
    })
    expect(screen.getByTestId('login-error').textContent).toBe('request failed (502)')
  })
})
