// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PeoplePage, PersonCard, PersonDetail, PersonaCard, PersonaDetail, PersonaPage, SkillUse } from '@slave-of-ai/control'
import type { ProfileSpec } from '@slave-of-ai/domain'
import { PeopleView } from '../src/components/people/PeopleView'
import type { PeopleLocation } from '../src/components/people/words'
import { stubBrowser } from './fixtures/dom'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }), usePathname: () => '/people' }))

beforeAll(() => stubBrowser())
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/people')
})

/** Types into a field the way a person does, so React sees the change. */
async function type(element: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const click = async (testId: string, index = 0): Promise<void> => {
  await act(async () => screen.getAllByTestId(testId)[index]?.click())
}

const card = (n: number, over: Partial<PersonCard> = {}): PersonCard => ({
  id: `p${String(n)}`,
  name: `Person ${String(n)}`,
  personaName: 'Backend Architect',
  role: 'engineering',
  division: 'engineering',
  description: 'Builds APIs.',
  templateId: 't1',
  skillCount: 2,
  ownInstructions: false,
  projects: [],
  working: false,
  ...over,
})
const peoplePage = (people: readonly PersonCard[], over: Partial<PeoplePage> = {}): PeoplePage => ({ people, total: people.length, all: people.length, offset: 0, limit: 48, divisions: [{ key: 'engineering', count: people.length }], ...over })

const SPEC: ProfileSpec = {
  identity: 'A careful builder',
  summary: 'Builds APIs.',
  mission: 'Ship working services.',
  runtimeRole: 'engineering',
  capabilities: ['REST'],
  expertise: [],
  operatingPrinciples: ['Test first'],
  constraints: ['Never skip the proof'],
  workflow: ['Step 1: Read the request', 'Step 2: Build it'],
  deliverables: [],
  successCriteria: [],
  collaborationHints: [],
  recommendedSkills: [],
  body: '',
  source: null,
}
const profile = (over: Partial<PersonaDetail['profile']> = {}): PersonaDetail['profile'] => ({ templateId: 't1', name: 'Backend Architect', upstream: SPEC, overrides: {}, effective: SPEC, markdown: '## Who you are\nA careful builder', rawOverride: false, overridden: [], ...over })
const SKILLS: readonly SkillUse[] = [
  { id: 's-api', name: 'api-design', providerName: 'library:ecc', description: 'REST API design', missing: false, personCount: 2, personaCount: 1 },
  { id: 's-sql', name: 'sql', providerName: 'personal', description: 'Queries', missing: false, personCount: 0, personaCount: 0 },
]
const person = (over: Partial<PersonDetail> = {}): PersonDetail => ({
  id: 'p1',
  name: 'Bea',
  role: 'engineering',
  division: 'engineering',
  description: 'Builds APIs.',
  model: null,
  provider: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  working: false,
  persona: { id: 't1', name: 'Backend Architect', active: true },
  profile: profile(),
  ownInstructions: null,
  skills: [
    { skillId: 's-api', name: 'api-design', providerName: 'library:ecc', description: 'REST API design', state: 'persona', fromPersona: true, missing: false },
    { skillId: 's-css', name: 'css', providerName: 'personal', description: 'Styles', state: 'revoked', fromPersona: true, missing: false },
  ],
  projects: [{ id: 'ws-1', name: 'Todo', listed: false, full: false }],
  footprint: { projects: [], runs: 0 },
  ...over,
})
const personaCard = (over: Partial<PersonaCard> = {}): PersonaCard => ({ id: 't1', name: 'Backend Architect', role: 'engineering', division: 'engineering', description: 'Builds APIs.', active: true, customised: false, handMade: false, skillCount: 1, personCount: 2, ...over })
const personaPage = (personas: readonly PersonaCard[]): PersonaPage => ({ personas, total: personas.length, all: personas.length, activeCount: personas.filter((one) => one.active).length, offset: 0, limit: 48, divisions: [{ key: 'engineering', count: personas.length }] })
const persona = (over: Partial<PersonaDetail> = {}): PersonaDetail => ({
  id: 't1',
  name: 'Backend Architect',
  role: 'engineering',
  division: 'engineering',
  description: 'Builds APIs.',
  active: true,
  handMade: false,
  sourcePath: 'engineering/backend.md',
  profile: profile(),
  skills: [{ id: 's-api', name: 'api-design', providerName: 'library:ecc', description: 'REST API design', missing: false }],
  personCount: 2,
  ...over,
})

interface Call {
  readonly url: string
  readonly method: string
  readonly body: unknown
}

/** A `fetch` that answers by address and remembers every call; a write answers `{ ok: true }`
 *  unless `writes` says otherwise. */
function serve(reads: { people?: PeoplePage; person?: PersonDetail; personas?: PersonaPage; persona?: PersonaDetail } = {}, writes: (call: Call) => { status?: number; body: unknown } | undefined = () => undefined): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const call: Call = { url, method, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined }
      calls.push(call)
      const path = url.split('?')[0] ?? url
      let answer: { status?: number; body: unknown }
      if (method !== 'GET') answer = writes(call) ?? { body: { ok: true } }
      else if (path === '/api/skills') answer = { body: { skills: SKILLS } }
      else if (path === '/api/people') answer = { body: reads.people ?? peoplePage([]) }
      else if (path === '/api/personas') answer = { body: reads.personas ?? personaPage([]) }
      else if (path === '/api/projects') answer = { body: { projects: [] } }
      else if (path.startsWith('/api/people/')) answer = reads.person === undefined ? { status: 404, body: { error: 'no person' } } : { body: { person: reads.person } }
      else if (path.startsWith('/api/personas/')) answer = reads.persona === undefined ? { status: 404, body: { error: 'no persona' } } : { body: { persona: reads.persona } }
      else answer = { status: 404, body: { error: `unexpected ${url}` } }
      return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
    }),
  )
  return calls
}

const at = (over: Partial<PeopleLocation> = {}): PeopleLocation => ({ tab: 'people', personId: null, personaId: null, skillId: null, templateId: null, ...over })
const writesOf = (calls: readonly Call[]): Call[] => calls.filter((call) => call.method !== 'GET')

describe('People: the list', () => {
  it('says nobody is here yet and offers the first person', async () => {
    serve()
    render(<PeopleView initial={peoplePage([])} location={at()} />)
    expect(screen.getByTestId('people-empty').textContent).toContain('Create your first person')
    await click('new-person')
    expect(screen.getByTestId('new-person-dialog')).toBeTruthy()
  })

  it('draws the first page from the server without a request, one uniform card each', async () => {
    const calls = serve()
    render(
      <PeopleView
        initial={peoplePage([card(1, { working: true, projects: [{ id: 'ws-1', name: 'Todo' }], ownInstructions: true }), card(2, { skillCount: 0, personaName: null, division: null, description: '' })], { total: 2, all: 840 })}
        location={at()}
      />,
    )
    const cards = screen.getAllByTestId('person-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]?.textContent).toContain('Person 1')
    expect(cards[0]?.textContent).toContain('Backend Architect')
    expect(cards[0]?.textContent).toContain('Engineering')
    expect(cards[0]?.textContent).toContain('2 skills')
    expect(cards[0]?.textContent).toContain('On Todo')
    expect(cards[0]?.textContent).toContain('Own instructions')
    expect(cards[0]?.textContent).toContain('Working')
    expect(cards[1]?.textContent).toContain('No persona')
    expect(cards[1]?.textContent).toContain('No skills')
    expect(cards[1]?.textContent).toContain('Made from a name alone')
    expect(screen.getByTestId('list-foot').textContent).toContain('Showing 2 of 2 people')
    await waitFor(() => expect(calls.some((call) => call.url === '/api/skills')).toBe(true))
    expect(calls.filter((call) => call.url.startsWith('/api/people'))).toEqual([])
  })

  it('asks the server for a search and a filter, and for the next page', async () => {
    const calls = serve({ people: peoplePage([card(7), card(77)], { total: 1, all: 100 }) })
    render(<PeopleView initial={peoplePage(Array.from({ length: 48 }, (_, n) => card(n)), { total: 100, all: 100 })} location={at()} />)
    await click('list-more')
    await waitFor(() => expect(calls.some((call) => call.url === '/api/people?offset=48&limit=48')).toBe(true))
    // Person 7 is already on screen (the list shifted under the reader); only Person 77 is new.
    await waitFor(() => expect(screen.getAllByTestId('person-card')).toHaveLength(49))

    await type(screen.getByTestId('people-search'), 'architect')
    await waitFor(() => expect(calls.some((call) => call.url === '/api/people?q=architect&offset=0&limit=48')).toBe(true))
    await waitFor(() => expect(screen.getAllByTestId('person-card')).toHaveLength(2))
    expect(screen.getByTestId('people-filter-line').textContent).toContain('1 of 100 people')

    await click('people-no-skills')
    await waitFor(() => expect(calls.some((call) => call.url === '/api/people?q=architect&noSkills=1&offset=0&limit=48')).toBe(true))
    await click('people-clear')
    await waitFor(() => expect(calls.at(-1)?.url).toBe('/api/people?offset=0&limit=48'))
  })

  it('says nobody matches and offers to clear, and draws the dense list on request', async () => {
    serve({ people: peoplePage([], { total: 0, all: 5 }) })
    render(<PeopleView initial={peoplePage([card(1)], { all: 5 })} location={at()} />)
    await click('people-view-list')
    expect(screen.getAllByTestId('person-row')).toHaveLength(1)
    await click('people-on-roster')
    await waitFor(() => expect(screen.getByTestId('people-none').textContent).toContain('Nobody matches'))
  })
})

describe('People: one person', () => {
  it('opens a person from the address: the profile in two parts, the workflow as steps, each skill with its source', async () => {
    serve({ person: person() })
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ personId: 'p1' })} />)
    await waitFor(() => expect(screen.getByTestId('person-name').textContent).toBe('Bea'))
    expect(screen.getByTestId('profile-who').textContent).toContain('A careful builder')
    expect(screen.getByTestId('profile-who').textContent).toContain('Never skip the proof')
    expect(screen.getByTestId('profile-what').textContent).toContain('Ship working services.')
    expect(screen.getByTestId('workflow-steps').textContent).toBe('1Read the request2Build it')
    // The one line is already in the header; a person's profile is read-only.
    expect(screen.queryByTestId('profile-field-summary')).toBeNull()
    expect(screen.queryByTestId('field-edit-workflow')).toBeNull()
    const skills = screen.getAllByTestId('person-skill')
    expect(skills.map((row) => row.getAttribute('data-state'))).toEqual(['persona', 'revoked'])
    expect(skills[0]?.textContent).toContain('From the persona')
    expect(skills[1]?.textContent).toContain('Taken away')
    expect(window.location.search).toBe('?person=p1')
  })

  it('takes a skill away, gives one back, and gives a new one', async () => {
    const calls = serve({ person: person() })
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ personId: 'p1' })} />)
    await waitFor(() => expect(screen.getAllByTestId('person-skill')).toHaveLength(2))
    await click('skill-revoke')
    await click('skill-restore')
    await click('person-skill-add')
    // api-design is already theirs; sql is the one skill left to give.
    const options = screen.getAllByTestId('skill-option')
    expect(options).toHaveLength(1)
    await act(async () => options[0]?.click())
    await waitFor(() => expect(writesOf(calls)).toHaveLength(3))
    expect(writesOf(calls)).toEqual([
      { url: '/api/people/p1/skills', method: 'PATCH', body: { revoke: ['s-api'] } },
      { url: '/api/people/p1/skills', method: 'PATCH', body: { clear: ['s-css'] } },
      { url: '/api/people/p1/skills', method: 'PATCH', body: { grant: ['s-sql'] } },
    ])
  })

  it('writes own instructions starting from the persona\'s profile, and clears them', async () => {
    const calls = serve({ person: person() })
    const view = render(<PeopleView initial={peoplePage([card(1)])} location={at({ personId: 'p1' })} />)
    await waitFor(() => expect(screen.getByTestId('own-instructions').textContent).toContain('None. They use the persona'))
    await click('own-instructions-edit')
    await click('own-instructions-start')
    expect((screen.getByTestId('own-instructions-editor') as HTMLTextAreaElement).value).toBe('## Who you are\nA careful builder')
    await type(screen.getByTestId('own-instructions-editor'), 'Be brief.')
    await click('own-instructions-save')
    await waitFor(() => expect(writesOf(calls)).toEqual([{ url: '/api/people/p1/profile', method: 'PUT', body: { profile: 'Be brief.' } }]))
    view.unmount()

    const again = serve({ person: person({ ownInstructions: 'Be brief.' }) })
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ personId: 'p1' })} />)
    await waitFor(() => expect(screen.getByTestId('own-instructions-text').textContent).toBe('Be brief.'))
    expect(screen.getByTestId('person-profile-replaced').textContent).toContain('instead of this profile')
    await click('own-instructions-clear')
    await waitFor(() => expect(writesOf(again)).toEqual([{ url: '/api/people/p1/profile', method: 'PUT', body: { profile: null } }]))
  })

  it('shows a refusal of the instructions in the editor and keeps what was typed', async () => {
    serve({ person: person() }, () => ({ status: 409, body: { error: 'the profile is too long' } }))
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ personId: 'p1' })} />)
    await waitFor(() => expect(screen.getByTestId('own-instructions-edit')).toBeTruthy())
    await click('own-instructions-edit')
    await type(screen.getByTestId('own-instructions-editor'), 'Too much.')
    await click('own-instructions-save')
    await waitFor(() => expect(screen.getByTestId('own-instructions-problem').textContent).toBe('the profile is too long'))
    expect((screen.getByTestId('own-instructions-editor') as HTMLTextAreaElement).value).toBe('Too much.')
  })

  it('puts them on a project\'s helper list, and does not offer a full one', async () => {
    const calls = serve({ person: person({ projects: [{ id: 'ws-1', name: 'Todo', listed: false, full: false }, { id: 'ws-2', name: 'Packed', listed: false, full: true }] }) })
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ personId: 'p1' })} />)
    await waitFor(() => expect(screen.getAllByTestId('person-project')).toHaveLength(2))
    const switches = screen.getAllByTestId('person-project-switch') as HTMLButtonElement[]
    expect(switches[1]?.disabled).toBe(true)
    expect(screen.getAllByTestId('person-project')[1]?.textContent).toContain('Its helper list is full')
    await click('person-project-switch')
    await waitFor(() => expect(writesOf(calls)).toEqual([{ url: '/api/people/p1/rosters', method: 'PUT', body: { workspaceId: 'ws-1', listed: true } }]))
  })

  it('names what a delete takes before it deletes, and shows a refusal in the dialog', async () => {
    let refuse = true
    const calls = serve({ person: person({ ownInstructions: 'Be brief.', projects: [{ id: 'ws-1', name: 'Todo', listed: true, full: false }], footprint: { projects: ['Older'], runs: 3 } }) }, () => (refuse ? { status: 409, body: { error: 'a run is in progress' } } : undefined))
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ personId: 'p1' })} />)
    await waitFor(() => expect(screen.getByTestId('person-delete')).toBeTruthy())
    await click('person-delete')
    const lines = screen.getByTestId('delete-person-consequences').textContent ?? ''
    expect(lines).toContain('Their own instructions.')
    expect(lines).toContain('1 skill change made for them.')
    expect(lines).toContain('Their place on the helper list of Todo.')
    expect(lines).toContain('Their seat in Older.')
    expect(lines).toContain('3 past runs of theirs')
    expect(screen.getByTestId('delete-person-dialog').textContent).toContain('The persona Backend Architect stays')
    await click('delete-person-confirm')
    await waitFor(() => expect(screen.getByTestId('delete-person-error').textContent).toContain('They are working right now'))
    refuse = false
    await click('delete-person-confirm')
    await waitFor(() => expect(screen.queryByTestId('person-sheet')).toBeNull())
    expect(writesOf(calls).map((call) => [call.method, call.url])).toEqual([['DELETE', '/api/people/p1'], ['DELETE', '/api/people/p1']])
    expect(window.location.search).toBe('')
  })

  it('says a person who is gone is gone', async () => {
    serve()
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ personId: 'gone' })} />)
    await waitFor(() => expect(screen.getByTestId('person-sheet').textContent).toContain('This person is no longer here'))
  })
})

describe('People: a new person', () => {
  it('makes a person from a searched persona with a name, and opens them', async () => {
    const calls = serve({ personas: personaPage([personaCard()]), person: person({ id: 'p9', name: 'Cem' }) }, (call) => (call.url === '/api/people' ? { body: { ok: true, personId: 'p9', name: 'Cem' } } : undefined))
    render(<PeopleView initial={peoplePage([card(1)])} location={at()} />)
    await click('new-person')
    const submit = (): HTMLButtonElement => screen.getByTestId('new-person-submit') as HTMLButtonElement
    expect(submit().disabled).toBe(true)
    await type(screen.getByTestId('new-person-persona-search'), 'backend')
    await waitFor(() => expect(calls.some((call) => call.url === '/api/personas?limit=30&q=backend')).toBe(true))
    await waitFor(() => expect(screen.getAllByTestId('new-person-persona-option')).toHaveLength(1))
    await click('new-person-persona-option')
    expect(screen.getByTestId('new-person-persona-chosen').textContent).toContain('Backend Architect')
    expect(submit().disabled).toBe(false)
    await type(screen.getByTestId('new-person-name'), ' Cem ')
    await click('new-person-submit')
    await waitFor(() => expect(writesOf(calls)).toEqual([{ url: '/api/people', method: 'POST', body: { templateId: 't1', name: 'Cem' } }]))
    await waitFor(() => expect(screen.getByTestId('person-name').textContent).toBe('Cem'))
  })

  it('makes a person from a name alone, and shows a refusal in the dialog', async () => {
    const calls = serve({}, () => ({ status: 409, body: { error: 'that name is taken' } }))
    render(<PeopleView initial={peoplePage([card(1)])} location={at()} />)
    await click('new-person')
    await type(screen.getByTestId('new-person-name'), 'Solo')
    await click('new-person-submit')
    await waitFor(() => expect(screen.getByTestId('new-person-error').textContent).toBe('that name is taken'))
    expect(writesOf(calls)).toEqual([{ url: '/api/people', method: 'POST', body: { name: 'Solo' } }])
  })
})

describe('People: personas', () => {
  it('lists the catalogue with its counts and filters by being active', async () => {
    const calls = serve({ personas: personaPage([personaCard(), personaCard({ id: 't2', name: 'Plain', active: false, handMade: true, customised: true, skillCount: 0, personCount: 0, division: null, role: 'Tester' })]) })
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ tab: 'personas' })} />)
    await waitFor(() => expect(screen.getAllByTestId('persona-card')).toHaveLength(2))
    const cards = screen.getAllByTestId('persona-card')
    expect(cards[0]?.textContent).toContain('1 default skill')
    expect(cards[0]?.textContent).toContain('2 people')
    expect(cards[1]?.textContent).toContain('Inactive')
    expect(cards[1]?.textContent).toContain('Tester')
    expect(cards[1]?.textContent).toContain('No default skills')
    expect(cards[1]?.textContent).toContain('Nobody yet')
    expect(cards[1]?.textContent).toContain('Edited here')
    expect(cards[1]?.textContent).toContain('Made here')
    expect(screen.getByTestId('personas-status-active').textContent).toBe('Active1')
    await click('personas-status-inactive')
    await waitFor(() => expect(calls.some((call) => call.url === '/api/personas?active=0&offset=0&limit=48')).toBe(true))
    expect(window.location.search).toBe('?tab=personas')
  })

  it('edits the workflow of a persona one step per line, and takes an edited field back', async () => {
    const calls = serve({ persona: persona({ profile: profile({ overridden: ['mission'] }) }) }, (call) => ({ body: { ok: true, overridden: call.method === 'DELETE' ? [] : ['mission', 'workflow'] } }))
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ tab: 'personas', personaId: 't1' })} />)
    await waitFor(() => expect(screen.getByTestId('persona-name').textContent).toBe('Backend Architect'))
    expect(screen.getByTestId('profile-field-mission').getAttribute('data-edited')).toBe('true')
    expect(screen.getByTestId('profile-field-mission').textContent).toContain('Edited here')
    expect(screen.queryByTestId('field-reset-workflow')).toBeNull()
    // An empty field is still offered, to be written.
    expect(screen.getByTestId('profile-field-deliverables').textContent).toContain('Nothing written.')

    await click('field-edit-workflow')
    const editor = screen.getByTestId('field-editor-workflow') as HTMLTextAreaElement
    expect(editor.value).toBe('Step 1: Read the request\nStep 2: Build it')
    await type(editor, '1. Ask first\n2. Then build\n\n- Then prove it')
    await click('field-save-workflow')
    await waitFor(() => expect(writesOf(calls)).toEqual([{ url: '/api/personas/t1/overrides', method: 'PATCH', body: { patch: { workflow: ['Ask first', 'Then build', 'Then prove it'] } } }]))
    await waitFor(() => expect(screen.queryByTestId('field-editor-workflow')).toBeNull())

    await click('field-reset-mission')
    await waitFor(() => expect(writesOf(calls).at(-1)).toEqual({ url: '/api/personas/t1/overrides/mission', method: 'DELETE', body: undefined }))
  })

  it('does not send a field that breaks the limits, and shows a refusal beside the field', async () => {
    const calls = serve({ persona: persona() }, () => ({ status: 409, body: { error: 'the catalogue refused it' } }))
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ tab: 'personas', personaId: 't1' })} />)
    await waitFor(() => expect(screen.getByTestId('field-edit-mission')).toBeTruthy())
    await click('field-edit-mission')
    await type(screen.getByTestId('field-editor-mission'), 'x'.repeat(241))
    await click('field-save-mission')
    expect(screen.getByTestId('field-problem').textContent).toBe('Keep this to 240 characters (it has 241).')
    expect(writesOf(calls)).toEqual([])
    await type(screen.getByTestId('field-editor-mission'), 'Short.')
    await click('field-save-mission')
    await waitFor(() => expect(screen.getByTestId('field-problem').textContent).toBe('the catalogue refused it'))
    expect((screen.getByTestId('field-editor-mission') as HTMLTextAreaElement).value).toBe('Short.')
  })

  it('changes the default skills, the activation, and offers a person made from it', async () => {
    const calls = serve({ persona: persona(), personas: personaPage([personaCard()]) })
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ tab: 'personas', personaId: 't1' })} />)
    await waitFor(() => expect(screen.getAllByTestId('persona-skill')).toHaveLength(1))
    await click('persona-skill-remove')
    await click('persona-skill-add')
    await act(async () => screen.getAllByTestId('skill-option')[0]?.click())
    await click('persona-active')
    await waitFor(() => expect(writesOf(calls)).toHaveLength(3))
    expect(writesOf(calls)).toEqual([
      { url: '/api/personas/t1/skills', method: 'PATCH', body: { remove: ['s-api'] } },
      { url: '/api/personas/t1/skills', method: 'PATCH', body: { add: ['s-sql'] } },
      { url: '/api/personas/t1/activation', method: 'POST', body: { active: false } },
    ])
    await click('persona-create-person')
    await waitFor(() => expect(screen.getByTestId('new-person-persona-chosen').textContent).toContain('Backend Architect'))
    expect(screen.queryByTestId('persona-sheet')).toBeNull()
  })

  it('narrows People to the persona\'s people', async () => {
    const calls = serve({ persona: persona(), people: peoplePage([card(1)], { total: 1, all: 9 }) })
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ tab: 'personas', personaId: 't1' })} />)
    await waitFor(() => expect(screen.getByTestId('persona-show-people').textContent).toContain('2 people'))
    await click('persona-show-people')
    await waitFor(() => expect(calls.some((call) => call.url === '/api/people?persona=t1&offset=0&limit=48')).toBe(true))
    await waitFor(() => expect(screen.getByTestId('people-filter-line').textContent).toContain('Made from Backend Architect'))
    expect(window.location.search).toBe('?from=t1')
  })

  it('writes a hand-made persona\'s instructions as one text, and says what a delete leaves behind', async () => {
    const calls = serve({ persona: persona({ handMade: true, sourcePath: null, profile: profile({ upstream: null, effective: null, markdown: null }) }) })
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ tab: 'personas', personaId: 't1' })} />)
    await waitFor(() => expect(screen.getByTestId('persona-instructions').textContent).toContain('No instructions yet'))
    await click('persona-instructions-edit')
    await type(screen.getByTestId('persona-instructions-editor'), 'You test things.')
    await click('persona-instructions-save')
    await waitFor(() => expect(writesOf(calls)).toEqual([{ url: '/api/personas/t1/profile', method: 'PUT', body: { profile: 'You test things.' } }]))
    await click('persona-delete')
    expect(screen.getByTestId('delete-persona-consequence').textContent).toContain('2 people made from it stay, but without a persona')
    await click('delete-persona-confirm')
    await waitFor(() => expect(writesOf(calls).at(-1)).toEqual({ url: '/api/personas/t1', method: 'DELETE', body: undefined }))
    await waitFor(() => expect(screen.queryByTestId('persona-sheet')).toBeNull())
  })

  it('makes a persona by hand and opens it', async () => {
    const calls = serve({ persona: persona({ id: 't9', name: 'Data Wrangler', handMade: true }) }, () => ({ body: { ok: true, id: 't9' } }))
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ tab: 'personas' })} />)
    await click('new-persona')
    expect((screen.getByTestId('new-persona-submit') as HTMLButtonElement).disabled).toBe(true)
    await type(screen.getByTestId('new-persona-name'), 'Data Wrangler')
    await type(screen.getByTestId('new-persona-role'), 'Analyst')
    await click('new-persona-submit')
    await waitFor(() => expect(writesOf(calls)).toEqual([{ url: '/api/personas', method: 'POST', body: { name: 'Data Wrangler', role: 'Analyst' } }]))
    await waitFor(() => expect(screen.getByTestId('persona-name').textContent).toBe('Data Wrangler'))
  })
})

describe('People: skills', () => {
  it('lists every skill with who has it, and opens People narrowed to one', async () => {
    const calls = serve({ people: peoplePage([card(1)], { total: 1, all: 9 }) })
    render(<PeopleView initial={peoplePage([card(1)])} location={at({ tab: 'skills' })} />)
    await waitFor(() => expect(screen.getAllByTestId('skill-row')).toHaveLength(2))
    const rows = screen.getAllByTestId('skill-row')
    expect(rows[0]?.textContent).toContain('api-design')
    expect(rows[0]?.textContent).toContain('ecc')
    expect(rows[0]?.textContent).toContain('2 people')
    expect(rows[1]?.textContent).toContain('Nobody')
    await click('skill-people')
    await waitFor(() => expect(calls.some((call) => call.url === '/api/people?skill=s-api&offset=0&limit=48')).toBe(true))
    expect(screen.getByTestId('tab-people').getAttribute('aria-selected')).toBe('true')
    expect(window.location.search).toBe('?skill=s-api')
  })
})
