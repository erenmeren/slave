// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillsClient } from '../src/components/SkillsClient.js'
import type { SkillsPage } from '../src/server/skills.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh }) }))

function page(over: Partial<SkillsPage> = {}): SkillsPage {
  return {
    providers: [
      {
        id: 'p1',
        name: 'plugin:superpowers',
        skills: [
          { id: 's1', name: 'writing-plans', description: 'plans things', runs: 18, state: 'ready', holders: [] },
          { id: 's2', name: 'brainstorming', description: 'explores intent', runs: 24, state: 'ready', holders: [{ personId: 'a1', name: 'Alex Turner', origin: 'person' }] },
          { id: 's3', name: 'gone', description: 'was here once', runs: 2, state: 'missing', holders: [] },
        ],
      },
    ],
    slaves: [{ id: 'a1', name: 'Alex Turner', status: 'working' }],
    scannedRoots: ['/home/x/.claude/skills', '/home/x/.claude/plugins/cache', '/repo/.claude/skills'],
    ...over,
  }
}

describe('SkillsClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    routerRefresh.mockClear()
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('groups skills under their provider with run counts and usage bars normalized to the busiest', () => {
    render(<SkillsClient page={page()} />)
    expect(screen.getByTestId('provider-name-p1').textContent).toBe('plugin:superpowers')
    expect(screen.getByTestId('skill-runs-s2').textContent).toBe('24')
    // `brainstorming` is the busiest, so its bar is full and `writing-plans` is 18/24.
    expect(screen.getByTestId('skill-bar-s2').style.width).toBe('100%')
    expect(screen.getByTestId('skill-bar-s1').style.width).toBe('75%')
  })

  it('draws every bar empty when nothing has been invoked, rather than dividing by zero', () => {
    render(
      <SkillsClient
        page={page({
          providers: [
            {
              id: 'p1',
              name: 'personal',
              skills: [{ id: 's1', name: 'quiet', description: 'never called', runs: 0, state: 'ready', holders: [] }],
            },
          ],
        })}
      />,
    )
    expect(screen.getByTestId('skill-bar-s1').style.width).toBe('0%')
    expect(screen.getByTestId('skill-runs-s1').textContent).toBe('0')
  })

  it('marks a skill whose file is gone as missing without hiding its history', () => {
    render(<SkillsClient page={page()} />)
    // M44 R5 leak 4: the raw `SkillRow['state']` used to be the label. READY/MISSING are words;
    // the raw value stays on the node for a gate and one hover away for a person.
    expect(screen.getByTestId('skill-state-s3').textContent).toBe('MISSING')
    expect(screen.getByTestId('skill-state-s3').getAttribute('data-state')).toBe('missing')
    expect(screen.getByTestId('skill-state-s3').getAttribute('title')).toBe('missing')
    expect(screen.getByTestId('skill-state-s1').textContent).toBe('READY')
    expect(screen.getByTestId('skill-runs-s3').textContent).toBe('2')
  })

  it('renders every skill as a domain tile tagged by its provider', () => {
    render(<SkillsClient page={page()} />)
    expect(screen.getAllByTestId('domain-tile')).toHaveLength(3)
    expect(screen.getAllByTestId('domain-source')[0]?.textContent).toBe('plugin:superpowers')
  })

  it('shows the three scanned roots on the add-source tile and offers no way to change them', () => {
    render(<SkillsClient page={page()} />)
    fireEvent.click(screen.getByTestId('empty-tile'))
    expect(screen.getByTestId('scanned-roots').textContent).toContain('/repo/.claude/skills')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('lists who has a skill as a link, with whether it is from the persona or from the slave', () => {
    render(<SkillsClient page={page()} />)
    expect(screen.getByTestId('skill-holders-s1').textContent).toBe('nobody')
    const holder = screen.getByTestId('skill-holder-s2-a1')
    expect(holder.textContent).toContain('Alex Turner')
    expect(holder.textContent).toContain('from slave')
    expect(holder.getAttribute('data-skill-origin')).toBe('person')
    expect(holder.getAttribute('title')).toBe('person')
    expect(holder.getAttribute('href')).toBe('/workforce?tab=slaves&slave=a1')
    expect(screen.queryByTestId('skill-assign-s1')).toBeNull()
    expect(screen.queryByTestId('skill-unassign-s2-a1')).toBeNull()
  })

  it('points the operator at the person panel and the catalog instead of assigning here', () => {
    render(<SkillsClient page={page()} />)
    expect(screen.getByTestId('skills-assign-note').textContent).toContain('Skills are given to a slave, not the other way round')
  })

  it('labels a persona default as from persona', () => {
    render(
      <SkillsClient
        page={page({
          providers: [
            {
              id: 'p1',
              name: 'personal',
              skills: [
                {
                  id: 's1',
                  name: 'pdf',
                  description: 'reads pdfs',
                  runs: 0,
                  state: 'ready',
                  holders: [{ personId: 'a1', name: 'Alex Turner', origin: 'persona' }],
                },
              ],
            },
          ],
        })}
      />,
    )
    const holder = screen.getByTestId('skill-holder-s1-a1')
    expect(holder.textContent).toContain('from persona')
    expect(holder.getAttribute('data-skill-origin')).toBe('persona')
  })

  it('says the catalog is empty rather than drawing an empty frame', () => {
    render(<SkillsClient page={page({ providers: [] })} />)
    expect(screen.getByTestId('skills-empty').textContent).toContain('no skills found')
    // The add-source tile survives an empty catalog -- it is what tells an operator where to look.
    expect(screen.getByTestId('empty-tile')).toBeTruthy()
  })

  // M61 Task 10 (R19): each column scrolls on its own -- the provider list in one `ui/ScrollArea`,
  // the domain-tile grid in another -- and no `SectionLabel` on the page carries
  // `uppercase`/`font-mono` on top of `.type-label`.
  it('gives each column its own ScrollArea, and carries no uppercase/font-mono SectionLabel', () => {
    render(<SkillsClient page={page()} />)
    expect(document.querySelectorAll('[data-scroll-axis]').length).toBeGreaterThanOrEqual(2)

    const offenders = [...document.querySelectorAll('.type-label')].filter((element) =>
      element.className.split(' ').some((cls) => cls === 'uppercase' || cls === 'font-mono'),
    )
    expect(offenders).toHaveLength(0)
  })
})
