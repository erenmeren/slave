// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityRecord } from '@slave-of-ai/domain'
import { CARD_GRID_COLUMNS, WorkforceCard, WorkforceCardGrid } from '../src/components/workforce/WorkforceCard.js'
import type { CardSkillRow } from '../src/lib/cardSkills.js'
import type { SkillCatalogueRow } from '../src/server/persons.js'
import type { SkillTarget } from '../src/lib/skillWrites.js'

const chip = (skillId: string, name: string, over: Partial<CardSkillRow> = {}): CardSkillRow => ({
  skillId,
  name,
  providerName: 'personal',
  missing: false,
  process: false,
  state: 'persona',
  ...over,
})

const CATALOGUE: readonly SkillCatalogueRow[] = [
  { skillId: 's-sql', name: 'sql', providerName: 'personal', description: 'writes sql', missing: false },
  { skillId: 's-pdf', name: 'pdf', providerName: 'personal', description: 'makes pdfs', missing: false },
]

const TAXONOMY: readonly CapabilityRecord[] = [
  { key: 'frontend.styling', label: 'Styling', domain: 'frontend', role: 'frontend', synonyms: [] },
]

const PERSONA: SkillTarget = { kind: 'persona', templateId: 't1' }
const PERSON: SkillTarget = { kind: 'person', personId: 'p1', personaId: 't1', personaName: 'Builder' }

type CardProps = React.ComponentProps<typeof WorkforceCard>

function renderCard(over: Partial<CardProps> = {}): CardProps {
  const props: CardProps = {
    variant: 'persona',
    testId: 'catalog-row-t1',
    tone: 'idle',
    name: 'Core Builder',
    division: 'engineering',
    capabilityKeys: [],
    taxonomy: TAXONOMY,
    skills: [],
    workflow: { steps: [], total: 0 },
    target: PERSONA,
    catalogue: CATALOGUE,
    openTestId: 'catalog-open-t1',
    onOpen: vi.fn(),
    onChanged: vi.fn(),
    ...over,
  }
  render(<WorkforceCard {...props} />)
  return props
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkforceCard chips', () => {
  it('marks a local skill 🧩 and a plugin skill 🔌, naming the plugin in the tooltip', () => {
    renderCard({ skills: [chip('a', 'pdf'), chip('b', 'frontend-design', { providerName: 'plugin:frontend' })] })
    const plugin = screen.getByTestId('card-skill-b')
    expect(plugin.getAttribute('data-source')).toBe('plugin')
    expect(within(plugin).getByTestId('card-skill-glyph').textContent).toBe('🔌')
    expect(within(plugin).getByTestId('card-skill-glyph').getAttribute('title')).toBe('from the frontend plugin')
    expect(within(screen.getByTestId('card-skill-a')).getByTestId('card-skill-glyph').textContent).toBe('🧩')
  })

  it('on a person card, says where each skill came from and strikes a revoked one with a restore', () => {
    renderCard({
      variant: 'person',
      testId: 'person-row-p1',
      target: PERSON,
      openTestId: 'person-open',
      skills: [chip('a', 'pdf'), chip('b', 'sql', { state: 'person' }), chip('c', 'lint', { state: 'revoked' })],
    })
    expect(within(screen.getByTestId('card-skill-a')).getByTestId('card-skill-origin').textContent).toBe('from persona')
    expect(within(screen.getByTestId('card-skill-b')).getByTestId('card-skill-origin').textContent).toBe('this person only')
    const revoked = screen.getByTestId('card-skill-c')
    expect(revoked.getAttribute('data-origin')).toBe('revoked')
    expect(within(revoked).getByTestId('card-skill-name').className).toContain('line-through')
    expect(screen.getByTestId('card-skill-restore-c')).toBeTruthy()
  })

  it('never marks the origin on a persona card -- every chip there is the persona\'s', () => {
    renderCard({ skills: [chip('a', 'pdf')] })
    expect(screen.queryByTestId('card-skill-origin')).toBeNull()
  })

  it('flags a process skill ⚠️ with the sentence in its tooltip', () => {
    renderCard({ skills: [chip('a', 'writing-plans', { process: true })] })
    const mark = within(screen.getByTestId('card-skill-a')).getByTestId('card-skill-process')
    expect(mark.textContent).toBe('⚠️')
    expect(mark.getAttribute('title')).toBe('Process skill: can make a worker plan and delegate instead of doing its task.')
  })

  it('greys a skill missing from disk but still lets it be removed', () => {
    renderCard({ skills: [chip('a', 'archived', { missing: true })] })
    const missing = screen.getByTestId('card-skill-a')
    expect(missing.getAttribute('data-missing')).toBe('true')
    expect(missing.getAttribute('title')).toBe('archived — missing from disk')
    expect((screen.getByTestId('card-skill-remove-a') as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows six skills and a +N, three specialties and a +N', () => {
    renderCard({
      skills: Array.from({ length: 8 }, (_, index) => chip(`s${String(index)}`, `skill-${String(index)}`)),
      capabilityKeys: [],
      capabilityText: ['One', 'Two', 'Three', 'Four', 'Five'],
    })
    expect(screen.getAllByTestId(/^card-skill-s\d$/u)).toHaveLength(6)
    expect(screen.getByTestId('card-skills-more').textContent).toBe('+2')
    expect(screen.getAllByTestId('catalog-capability-chip').map((node) => node.textContent)).toEqual(['One', 'Two', 'Three'])
    expect(screen.getByTestId('catalog-capability-more').textContent).toBe('+2')
  })

  it('labels taxonomy keys, and falls back to the key itself', () => {
    renderCard({ capabilityKeys: ['frontend.styling', 'qa.unknown'] })
    expect(screen.getAllByTestId('catalog-capability-chip').map((node) => node.textContent)).toEqual(['Styling', 'qa.unknown'])
  })

  it('truncates a very long skill name inside the chip instead of widening the card', () => {
    renderCard({ skills: [chip('a', `a-${'very-long-skill-name-'.repeat(8)}`, { providerName: `plugin:${'x'.repeat(80)}` })] })
    expect(screen.getByTestId('card-skill-a').className).toContain('max-w-full')
    expect(screen.getByTestId('card-skill-a').className).toContain('min-w-0')
    expect(within(screen.getByTestId('card-skill-a')).getByTestId('card-skill-name').className).toContain('truncate')
  })
})

describe('WorkforceCard workflow', () => {
  it('shows the first three steps and "+N steps"', () => {
    renderCard({ workflow: { steps: ['Read', 'Plan', 'Build'], total: 5 } })
    expect(screen.getAllByTestId('card-workflow-step').map((node) => node.textContent)).toEqual(['1. Read', '2. Plan', '3. Build'])
    expect(screen.getByTestId('card-workflow-more').textContent).toBe('+2 steps')
  })

  it('says so when the profile has no workflow, rather than hiding the block', () => {
    renderCard({ workflow: { steps: [], total: 0 } })
    expect(screen.getByTestId('card-workflow-empty').textContent).toBe('No workflow in this profile')
    expect(screen.queryByTestId('card-workflow-more')).toBeNull()
  })

  it('draws no "+N" when every step is shown', () => {
    renderCard({ workflow: { steps: ['Only'], total: 1 } })
    expect(screen.queryByTestId('card-workflow-more')).toBeNull()
  })
})

describe('WorkforceCard opening', () => {
  it('a click on the body opens it; the name button opens it once; a chip control does not open it', () => {
    const props = renderCard({ skills: [chip('a', 'pdf')] })
    fireEvent.click(screen.getByTestId('avatar-tile'))
    expect(props.onOpen).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('catalog-open-t1'))
    expect(props.onOpen).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByTestId('card-skill-add'))
    expect(props.onOpen).toHaveBeenCalledTimes(2)
  })
})

describe('WorkforceCard writes', () => {
  it('adds from the picker as a persona DELTA, shows the chip at once, and reports the write for the row to patch in place', async () => {
    const props = renderCard()
    fireEvent.click(screen.getByTestId('card-skill-add'))
    fireEvent.click(screen.getByTestId('skill-picker-option-s-sql'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('skill-picker-confirm'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/templates/t1/skills', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add: ['s-sql'] }),
    })
    expect(screen.getByTestId('card-skill-s-sql')).toBeTruthy()
    expect(props.onChanged).toHaveBeenCalled()
  })

  it('rolls the chip back and says why when the write is refused', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'the skill sql is missing from disk; it can be linked again once a skills scan finds it' }), {
        status: 409,
      }),
    )
    const props = renderCard()
    fireEvent.click(screen.getByTestId('card-skill-add'))
    fireEvent.click(screen.getByTestId('skill-picker-option-s-sql'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('skill-picker-confirm'))
    })
    expect(screen.queryByTestId('card-skill-s-sql')).toBeNull()
    expect(screen.getByTestId('card-skill-error').textContent).toContain('missing from disk')
    // A refusal is also a reason to re-read: another edit may have raced this one.
    expect(props.onChanged).toHaveBeenCalled()
  })

  it('on a person card, removing an inherited skill asks who loses it', async () => {
    renderCard({ variant: 'person', testId: 'person-row-p1', target: PERSON, openTestId: 'person-open', skills: [chip('a', 'pdf')] })
    fireEvent.click(screen.getByTestId('card-skill-remove-a'))
    expect(screen.getByTestId('card-skill-remove-scope-persona').textContent).toBe('Everyone from Builder')
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-skill-remove-scope-persona'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/org/templates/t1/skills', expect.objectContaining({ body: JSON.stringify({ remove: ['a'] }) }))
  })

  it("on a person card, removing the person's own grant clears it without asking", async () => {
    renderCard({
      variant: 'person',
      testId: 'person-row-p1',
      target: PERSON,
      openTestId: 'person-open',
      skills: [chip('b', 'sql', { state: 'person' })],
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-skill-remove-b'))
    })
    expect(screen.queryByTestId('card-skill-remove-scope')).toBeNull()
    expect(fetchMock).toHaveBeenCalledWith('/api/persons/p1/skills', expect.objectContaining({ body: JSON.stringify({ clear: ['b'] }) }))
  })
})

describe('WorkforceCardGrid', () => {
  it('lays cards out on the auto-fill grid, as an inline style a gate can read back', () => {
    render(
      <WorkforceCardGrid>
        <span />
      </WorkforceCardGrid>,
    )
    // F9 (controller ruling): `minmax(min(320px, 100%), 1fr)` rather than a plain `minmax(320px, 1fr)`,
    // so a single card on a viewport under 320px does not force horizontal scroll.
    expect(CARD_GRID_COLUMNS).toBe('repeat(auto-fill, minmax(min(320px, 100%), 1fr))')
    expect(screen.getByTestId('workforce-card-grid').style.gridTemplateColumns).toBe(CARD_GRID_COLUMNS)
  })
})
