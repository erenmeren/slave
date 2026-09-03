// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LoginForm } from '../src/components/LoginForm.js'

const assign = vi.fn()

function fill(username: string, password: string): void {
  fireEvent.change(screen.getByTestId('login-username'), { target: { value: username } })
  fireEvent.change(screen.getByTestId('login-password'), { target: { value: password } })
}

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

  it('submits both fields through sendControl and navigates to next on success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    render(<LoginForm next="/w/abc" />)
    const submit = screen.getByTestId('login-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fill('ada', 'hunter2-hunter2')
    expect(submit.disabled).toBe(false)
    await act(async () => {
      fireEvent.submit(screen.getByTestId('login-form'))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/login',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ username: 'ada', password: 'hunter2-hunter2' }) }),
    )
    expect(assign).toHaveBeenCalledWith('/w/abc')
  })

  it('stays disabled until BOTH fields carry something', () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    render(<LoginForm next="/" />)
    const submit = screen.getByTestId('login-submit') as HTMLButtonElement
    fill('ada', '')
    expect(submit.disabled).toBe(true)
    fill('', 'hunter2-hunter2')
    expect(submit.disabled).toBe(true)
    fill('ada', 'hunter2-hunter2')
    expect(submit.disabled).toBe(false)
  })

  it('autofills as a login form: username above password, both named for the browser', () => {
    render(<LoginForm next="/" />)
    const username = screen.getByTestId('login-username') as HTMLInputElement
    const password = screen.getByTestId('login-password') as HTMLInputElement
    expect(username.getAttribute('autocomplete')).toBe('username')
    expect(password.getAttribute('autocomplete')).toBe('current-password')
    expect(password.getAttribute('type')).toBe('password')
    // DOM order is the tab order: the name comes first.
    expect(username.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows the refusal text and stays put on wrong credentials', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'wrong username or password' }, { status: 401 }))
    render(<LoginForm next="/" />)
    fill('ada', 'nope')
    await act(async () => {
      fireEvent.submit(screen.getByTestId('login-form'))
    })
    expect(screen.getByTestId('login-error').textContent).toBe('wrong username or password')
    expect(assign).not.toHaveBeenCalled()
    expect((screen.getByTestId('login-submit') as HTMLButtonElement).disabled).toBe(false)
  })

  it('never renders a blank error band', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 502 }))
    render(<LoginForm next="/" />)
    fill('ada', 'x')
    await act(async () => {
      fireEvent.submit(screen.getByTestId('login-form'))
    })
    expect(screen.getByTestId('login-error').textContent).toBe('request failed (502)')
  })
})
