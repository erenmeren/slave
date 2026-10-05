// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SettingsSheet } from '../src/components/project/SettingsSheet'
import { stubBrowser, stubFetch } from './fixtures/dom'
import { projectFixture } from './fixtures/project'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }), usePathname: () => '/w/ws-1' }))

beforeAll(() => stubBrowser())
afterEach(() => vi.unstubAllGlobals())

describe('the Settings sheet\'s helpers', () => {
  it('links each helper to their page in People, and People itself, and removes one from the list', async () => {
    const fetchMock = stubFetch((url) => (url === '/api/helpers' ? { body: { helpers: [] } } : url.includes('/models') ? { body: { models: [] } } : { body: { ok: true } }))
    const project = projectFixture({ roster: [{ id: 'p1', name: 'Bea', role: 'Backend Architect' }, { id: 'p2', name: 'Cem', role: null }] })
    render(<SettingsSheet project={project} open onOpenChange={() => undefined} onDone={async () => undefined} />)
    const links = screen.getAllByTestId('roster-member-link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Bea', '/people?person=p1'],
      ['Cem', '/people?person=p2'],
    ])
    expect(screen.getByTestId('roster-people-link').getAttribute('href')).toBe('/people')
    await act(async () => screen.getByLabelText('Remove Bea').click())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/api/w/${project.id}/lead`, expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ roster: ['p2'] }) })))
  })
})
