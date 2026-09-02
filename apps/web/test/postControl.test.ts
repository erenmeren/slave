// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendControl } from '../src/lib/postControl.js'

const assign = vi.fn()

function stubLocation(pathname: string, search = ''): void {
  Object.defineProperty(window, 'location', { configurable: true, value: { assign, pathname, search } })
}

describe('sendControl on 401', () => {
  beforeEach(() => {
    assign.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('navigates to /login with the current path as next, and still returns the error text', async () => {
    stubLocation('/w/abc/tasks', '?tab=done')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'authentication required' }, { status: 401 }))
    const failure = await sendControl('/api/w/abc/emergency-stop', { method: 'POST' })
    expect(failure).toBe('authentication required')
    expect(assign).toHaveBeenCalledWith('/login?next=%2Fw%2Fabc%2Ftasks%3Ftab%3Ddone')
  })

  it('does not navigate when already on /login (a wrong password is not an expired session)', async () => {
    stubLocation('/login', '?next=%2F')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'wrong password' }, { status: 401 }))
    const failure = await sendControl('/api/auth/login', { method: 'POST', body: { password: 'x' } })
    expect(failure).toBe('wrong password')
    expect(assign).not.toHaveBeenCalled()
  })

  it('does not navigate on any other failure', async () => {
    stubLocation('/w/abc')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'run is succeeded' }, { status: 409 }))
    expect(await sendControl('/api/x', { method: 'POST' })).toBe('run is succeeded')
    expect(assign).not.toHaveBeenCalled()
  })
})
