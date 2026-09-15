// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DeletePersonButton } from '../src/components/persons/DeletePersonButton.js'
import { PersonProjectsGroup } from '../src/components/persons/PersonProjectsGroup.js'
import { PersonSkillsGroup } from '../src/components/persons/PersonSkillsGroup.js'
import type { PersonSeatRow, PersonSkillRow } from '../src/server/persons.js'

const seats: readonly PersonSeatRow[] = [
  { slaveId: 's1', teamId: 'tm1', teamName: 'Engineering', workspaceId: 'w1', projectName: 'Alpha', role: 'dev', runtimeRoles: ['dev'], closedAt: null },
  { slaveId: 's2', teamId: 'tm2', teamName: 'Design', workspaceId: 'w2', projectName: 'Beta', role: 'lead', runtimeRoles: ['manager'], closedAt: null },
]

const skills: readonly PersonSkillRow[] = [
  { skillId: 'sk1', name: 'pdf', providerName: 'personal', state: 'persona' },
  { skillId: 'sk2', name: 'sql', providerName: 'personal', state: 'person' },
  { skillId: 'sk3', name: 'chart', providerName: 'personal', state: 'revoked' },
]

describe('PersonProjectsGroup (R23)', () => {
  it('lists every seat with its role and runtime roles', () => {
    render(<PersonProjectsGroup personId="p1" seats={seats} projects={[]} onChanged={() => {}} />)
    const alpha = screen.getByTestId('panel-seat-s1')
    expect(alpha.textContent).toContain('Alpha')
    expect(alpha.textContent).toContain('Engineering')
    expect(alpha.textContent).toContain('dev')
    expect(screen.getByTestId('panel-seat-s2').textContent).toContain('manager')
  })

  it('“remove from project” posts an unassign for THAT seat’s team', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PersonProjectsGroup personId="p1" seats={seats} projects={[]} onChanged={() => {}} />)
    fireEvent.click(screen.getByTestId('panel-seat-remove-s2'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/persons/p1/unassign')
    expect(JSON.parse(String(init.body))).toMatchObject({ teamId: 'tm2' })
    vi.unstubAllGlobals()
  })

  it('“assign to project” picks a project, then one of its teams, and posts', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(
      <PersonProjectsGroup
        personId="p1"
        seats={[]}
        projects={[{ workspaceId: 'w9', projectName: 'Gamma', teams: [{ teamId: 'tm9', name: 'Engineering' }] }]}
        onChanged={() => {}}
      />,
    )
    fireEvent.change(screen.getByTestId('panel-assign-project'), { target: { value: 'w9' } })
    fireEvent.change(screen.getByTestId('panel-assign-team'), { target: { value: 'tm9' } })
    fireEvent.click(screen.getByTestId('panel-assign-submit'))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/persons/p1/assign')
    expect(JSON.parse(String(init.body))).toMatchObject({ teamId: 'tm9' })
    vi.unstubAllGlobals()
  })
})

describe('PersonSkillsGroup (R23)', () => {
  it('mutes an inherited row and labels it “from persona”', () => {
    render(<PersonSkillsGroup personId="p1" skills={skills} catalogue={[]} onChanged={() => {}} />)
    const inherited = screen.getByTestId('panel-person-skill-sk1')
    expect(inherited.getAttribute('data-skill-state')).toBe('persona')
    expect(within(inherited).getByText(/from persona/i)).toBeTruthy()
  })

  it('a grant is plain and a revoke is struck through', () => {
    render(<PersonSkillsGroup personId="p1" skills={skills} catalogue={[]} onChanged={() => {}} />)
    expect(screen.getByTestId('panel-person-skill-sk2').getAttribute('data-skill-state')).toBe('person')
    const revoked = screen.getByTestId('panel-person-skill-sk3')
    expect(revoked.getAttribute('data-skill-state')).toBe('revoked')
    expect(revoked.className).toContain('line-through')
  })

  it('removing an inherited skill REVOKES it; removing a grant CLEARS it', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PersonSkillsGroup personId="p1" skills={skills} catalogue={[]} onChanged={() => {}} />)

    fireEvent.click(screen.getByTestId('panel-skill-remove-sk1'))
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ revoke: ['sk1'] })

    fireEvent.click(screen.getByTestId('panel-skill-remove-sk2'))
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ clear: ['sk2'] })
    vi.unstubAllGlobals()
  })

  it('restoring a revoked persona skill clears the revoke', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<PersonSkillsGroup personId="p1" skills={skills} catalogue={[]} onChanged={() => {}} />)
    fireEvent.click(screen.getByTestId('panel-skill-restore-sk3'))
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ clear: ['sk3'] })
    vi.unstubAllGlobals()
  })

  it('adding a skill grants it', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(
      <PersonSkillsGroup
        personId="p1"
        skills={[]}
        catalogue={[{ skillId: 'sk9', name: 'deploy', providerName: 'personal' }]}
        onChanged={() => {}}
      />,
    )
    fireEvent.change(screen.getByTestId('panel-skill-add'), { target: { value: 'sk9' } })
    fireEvent.click(screen.getByTestId('panel-skill-add-submit'))
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ grant: ['sk9'] })
    vi.unstubAllGlobals()
  })
})

describe('DeletePersonButton (R13, R23)', () => {
  it('states how many projects go, and deletes only after the confirmation', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<DeletePersonButton personId="p1" name="Atlas" projects={['Alpha', 'Beta']} onDeleted={() => {}} />)

    fireEvent.click(screen.getByTestId('person-delete'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('person-delete-count').textContent).toContain('2 other projects')

    fireEvent.click(screen.getByTestId('person-delete-confirm'))
    expect(fetchMock).toHaveBeenCalledWith('/api/persons/p1', expect.objectContaining({ method: 'DELETE' }))
    vi.unstubAllGlobals()
  })

  it('says nothing about other projects when there are none', () => {
    render(<DeletePersonButton personId="p1" name="Atlas" projects={[]} onDeleted={() => {}} />)
    fireEvent.click(screen.getByTestId('person-delete'))
    expect(screen.getByTestId('person-delete-count').textContent).toContain('no project')
  })
})
