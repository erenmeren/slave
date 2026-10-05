// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROJECTS_CHANGED, api, notifyProjectsChanged } from '../src/lib/api'
import { stubFetch } from './fixtures/dom'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api (lead UX design U-9)', () => {
  it('answers the body on success and sends a JSON body with its method', async () => {
    const fetchMock = stubFetch(() => ({ body: { ok: true, version: 3 } }))
    expect(await api('/api/w/1/goal', { method: 'POST', body: { goal: 'x' } })).toEqual({ ok: true, data: { ok: true, version: 3 } })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/w/1/goal')
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ goal: 'x' }) })
  })

  it('answers a refusal with the control layer\'s own words, and a bare failure with its status', async () => {
    stubFetch(() => ({ status: 409, body: { error: 'the project has 1 live run' } }))
    expect(await api('/api/w/1', { method: 'DELETE' })).toEqual({ ok: false, error: 'the project has 1 live run', status: 409 })
    stubFetch(() => ({ status: 500, body: null }))
    expect(await api('/api/projects')).toEqual({ ok: false, error: 'request failed (500)', status: 500 })
  })

  it('never throws: a network failure is an answer too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    expect(await api('/api/projects')).toEqual({ ok: false, error: 'offline', status: 0 })
  })

  it('tells the sidebar the projects changed', () => {
    const heard = vi.fn()
    window.addEventListener(PROJECTS_CHANGED, heard)
    notifyProjectsChanged()
    expect(heard).toHaveBeenCalledTimes(1)
    window.removeEventListener(PROJECTS_CHANGED, heard)
  })
})
