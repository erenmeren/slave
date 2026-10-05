// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProjectDiagram } from '@slave-of-ai/control'
import { DiagramView } from '../src/components/diagram/DiagramView'
import { NodeCard } from '../src/components/diagram/NodeCard'
import { diagramShape } from '../src/components/diagram/shape'
import { barWords } from '../src/components/diagram/Timeline'
import { barsOf, lanesOf, scaleOf } from '../src/components/diagram/timeline'
import { endOf } from '../src/components/diagram/words'
import { ProjectScreen } from '../src/components/project/ProjectScreen'
import { diagramFixture, manyCallsOf, projectDiagramFixture } from './fixtures/diagram'
import { stubBrowser, stubFetch } from './fixtures/dom'
import { projectFixture } from './fixtures/project'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }), usePathname: () => '/w/ws-1' }))

beforeAll(() => stubBrowser())
afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

/** The view with its one read answered; resolves once the read has landed. */
async function show(view: 'diagram' | 'timeline', diagram: ProjectDiagram = projectDiagramFixture(), project = projectFixture()): Promise<ReturnType<typeof stubFetch>> {
  const fetchMock = stubFetch(() => ({ body: { diagram } }))
  render(<DiagramView project={project} view={view} pollMs={3000} />)
  if (project.flow === 'lead') await waitFor(() => expect(screen.queryByTestId('diagram-loading')).toBeNull())
  return fetchMock
}

describe('the Timeline view', () => {
  it('reads the build once on opening and draws a lane per person with their steps', async () => {
    const fetchMock = await show('timeline')
    expect(fetchMock).toHaveBeenCalledWith('/api/w/ws-1/diagram', expect.anything())
    expect(screen.getByTestId('timeline').textContent).toContain('8 steps')
    expect(screen.getAllByTestId('timeline-lane').map((lane) => lane.textContent)).toEqual(['Lead4 steps', 'Bea3 steps · 2 at once', 'Checker1 step'])
    const bars = screen.getAllByTestId('timeline-bar')
    expect(bars).toHaveLength(8)
    expect(bars.map((bar) => bar.getAttribute('data-tone')).sort()).toEqual(['error', 'ok', 'ok', 'ok', 'ok', 'ok', 'running', 'running'])
    expect(bars.map((bar) => bar.getAttribute('aria-label'))).toContain('Lead: Reading package.json')
  })

  it('names the lead\'s turns with their cost, hatches a pause and marks now while the build runs', async () => {
    await show('timeline')
    expect(screen.getAllByTestId('timeline-turn').map((turn) => turn.textContent)).toEqual(['1. Building · $3.90', '2. Fixing what failed · cost when it ends'])
    expect(screen.getAllByTestId('timeline-pause')).toHaveLength(1)
    expect(screen.getByTestId('timeline-now')).toBeTruthy()
    // A helper's and a checker's sessions are spans under their steps.
    expect(screen.getAllByTestId('timeline-session')).toHaveLength(3)
  })

  it('has no now mark on a build that ended, and says when only the newest steps are drawn', async () => {
    const ended = diagramFixture({ to: diagramFixture().at, totalCalls: 5000 })
    await show('timeline', projectDiagramFixture(ended))
    expect(screen.queryByTestId('timeline-now')).toBeNull()
    expect(screen.getByTestId('timeline').textContent).toContain('5000 steps · the newest 8 are drawn')
  })

  it('zooms: Fit is chosen first, and the others widen the drawing so it scrolls', async () => {
    await show('timeline')
    const width = (): string => (screen.getByTestId('timeline-scroll').firstElementChild as HTMLElement).style.width
    expect(screen.getByTestId('zoom-fit').getAttribute('aria-pressed')).toBe('true')
    expect(width()).toBe('800px')
    fireEvent.click(screen.getByTestId('zoom-15m'))
    expect(screen.getByTestId('zoom-15m').getAttribute('aria-pressed')).toBe('true')
    expect(Number.parseFloat(width())).toBeGreaterThan(1000)
    // Twenty minutes fit in an hour: the hour zoom is the fit.
    fireEvent.click(screen.getByTestId('zoom-1h'))
    expect(width()).toBe('800px')
  })

  it('says a step in full when pointed at: the sentence, who, how long, how it went', async () => {
    await show('timeline')
    fireEvent.mouseEnter(screen.getAllByTestId('timeline-bar').find((bar) => bar.getAttribute('data-tone') === 'error') as HTMLElement)
    const tip = screen.getByTestId('timeline-tip')
    expect(tip.textContent).toContain('Running npm test')
    expect(tip.textContent).toContain('Lead')
    expect(tip.textContent).toContain('Took 30 s · Failed')
  })

  it('sums a block of several steps: how many, who, and the failed among them', () => {
    const build = diagramFixture()
    const scale = scaleOf(build, 'fit', 800)
    const [first] = barsOf(lanesOf(build)[0]!, build.calls, scale, endOf(build))
    expect(barWords({ ...first!, calls: build.calls.filter((call) => call.nodeId === 'lead') }, 'Lead', endOf(build))).toMatchObject({ title: '4 steps', lines: expect.arrayContaining(['Lead', 'Running npm test']) })
    expect(barWords({ ...first!, calls: [build.calls[7]!], tone: 'running', open: true }, 'Lead', endOf(build)).lines[1]).toBe('Running for 1 min 40 s · Running')
  })

  it('opens a person\'s panel from their lane: sessions with their times, steps newest first, and their page in People', async () => {
    await show('timeline')
    fireEvent.click(screen.getAllByTestId('timeline-lane')[1] as HTMLElement)
    const sheet = within(screen.getByTestId('diagram-sheet'))
    expect(screen.getByTestId('diagram-sheet').textContent).toContain('A helper the lead called 2 times.')
    expect(sheet.getAllByTestId('diagram-session').map((row) => row.textContent)).toEqual([expect.stringContaining('fix the delete routeFinished'), expect.stringContaining('write the testsWorking')])
    expect(sheet.getAllByTestId('diagram-session')[0]?.textContent).toContain('3 min 20 s · 2 steps')
    expect(sheet.getAllByTestId('diagram-step').map((step) => [step.getAttribute('data-outcome'), step.textContent?.replace(/\d+ (min|h|days) ago|just now/u, '')])).toEqual([
      ['open', 'Editing src/app.ts'],
      ['ok', 'Editing src/routes.ts'],
      ['ok', 'Reading src/routes.ts'],
    ])
    expect(sheet.getByTestId('diagram-person-link').getAttribute('href')).toBe('/people?person=person-bea')
  })

  it('opens one session\'s panel from one of its steps, and the lead\'s without a link to People', async () => {
    await show('timeline')
    fireEvent.click(screen.getByLabelText('Bea: Reading src/routes.ts'))
    expect(screen.getByTestId('diagram-sheet').textContent).toContain('One session of a helper: fix the delete route')
    expect(within(screen.getByTestId('diagram-sheet')).getAllByTestId('diagram-step')).toHaveLength(2)
    fireEvent.click(screen.getByText('Close'))
    fireEvent.click(screen.getAllByTestId('timeline-lane')[0] as HTMLElement)
    const sheet = within(screen.getByTestId('diagram-sheet'))
    expect(sheet.getAllByTestId('diagram-session').map((row) => row.textContent)).toEqual([expect.stringContaining('Building'), expect.stringContaining('Fixing what failed')])
    expect(sheet.getAllByTestId('diagram-step').map((step) => step.getAttribute('data-outcome'))).toEqual(['open', 'error', 'ok', 'ok'])
    expect(sheet.queryByTestId('diagram-person-link')).toBeNull()
  })
})

describe('the Diagram view', () => {
  it('draws the team on the canvas: a card for each of them', async () => {
    await show('diagram')
    expect(screen.getByTestId('diagram-view').textContent).toContain('Build 2: 2 working now, 3 people in all.')
    await waitFor(() => expect(screen.getByTestId('team-diagram').getAttribute('data-layout')).toBe('placed'))
    expect(screen.getAllByTestId('diagram-card').map((card) => card.getAttribute('data-kind'))).toEqual(['request', 'lead', 'session', 'session', 'checker', 'result'])
    // The lines need measured cards, which this DOM cannot give: `diagram-shape.test.ts` reads them.
  })

  it('opens a card\'s panel when the card is pressed', async () => {
    await show('diagram')
    await waitFor(() => expect(screen.getByTestId('team-diagram').getAttribute('data-layout')).toBe('placed'))
    fireEvent.click(screen.getAllByTestId('diagram-card')[1] as HTMLElement)
    expect(screen.getByTestId('diagram-sheet').textContent).toContain('The lead builds what you asked for')
  })

  it('opens a helper called often to its sessions, and closes it again', async () => {
    await show('diagram', projectDiagramFixture(manyCallsOf(5)))
    await waitFor(() => expect(screen.getByTestId('team-diagram').getAttribute('data-layout')).toBe('placed'))
    expect(screen.getAllByTestId('diagram-card')).toHaveLength(5)
    fireEvent.click(screen.getByTestId('diagram-toggle'))
    await waitFor(() => expect(screen.getAllByTestId('diagram-card')).toHaveLength(10))
    // The press was the toggle's own: no panel opened.
    expect(screen.queryByTestId('diagram-sheet')).toBeNull()
    fireEvent.click(screen.getByTestId('diagram-toggle'))
    await waitFor(() => expect(screen.getAllByTestId('diagram-card')).toHaveLength(5))
  })

  it('says a card in words: who, how it stands, what it does now, its steps, failed steps and cost', () => {
    const card = diagramShape(diagramFixture()).cards[1]!
    render(<NodeCard data={card.data} width={card.width} height={card.height} />)
    const text = screen.getByTestId('diagram-card').textContent
    for (const word of ['Lead', '2 turns', 'Working', 'Running npm test', '4 steps', '1 failed', '$3.90 so far']) expect(text).toContain(word)
    expect(screen.getByTestId('diagram-card').getAttribute('data-tone')).toBe('info')
  })

  it('explains itself on an older project instead of drawing', async () => {
    const fetchMock = await show('diagram', projectDiagramFixture(null, 'packages'), projectFixture({ flow: 'packages', phase: 'older', build: null }))
    expect(screen.getByTestId('diagram-older').textContent).toContain('built the older way')
    expect(screen.queryByTestId('team-diagram')).toBeNull()
    expect(fetchMock).toBeDefined()
  })

  it('says so when no build has started', async () => {
    await show('diagram', projectDiagramFixture(null))
    expect(screen.getByTestId('diagram-empty').textContent).toContain('No build has started')
  })

  it('says so when nobody has started on the build yet', async () => {
    const before = diagramFixture()
    await show('timeline', projectDiagramFixture({ ...before, nodes: before.nodes.filter((node) => node.kind === 'request' || node.kind === 'result'), sessions: [], calls: [], edges: [] }))
    expect(screen.getByTestId('diagram-empty').textContent).toContain('Nobody has started yet')
    expect(screen.queryByTestId('timeline')).toBeNull()
  })

  it('says so when the diagram cannot be read', async () => {
    stubFetch(() => ({ status: 409, body: { error: 'nope' } }))
    render(<DiagramView project={projectFixture()} view="diagram" pollMs={3000} />)
    await waitFor(() => expect(screen.getByText(/Could not read the diagram \(nope\)/u)).toBeTruthy())
  })
})

describe('the Project screen\'s view switch', () => {
  it('opens on Overview, and swaps to the diagram and the timeline keeping the view in the URL', async () => {
    stubFetch((url) => (url.endsWith('/diagram') ? { body: { diagram: projectDiagramFixture() } } : { body: { project: projectFixture() } }))
    render(<ProjectScreen initial={projectFixture()} />)
    expect(screen.getByTestId('view-overview').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('overview').className).not.toContain('hidden')
    expect(screen.queryByTestId('diagram-view')).toBeNull()

    await act(async () => screen.getByTestId('view-timeline').click())
    await waitFor(() => expect(screen.getByTestId('timeline')).toBeTruthy())
    expect(window.location.search).toBe('?view=timeline')
    expect(screen.getByTestId('overview').className).toContain('hidden')
    // The figures stay in sight on every view.
    expect(screen.getByTestId('build-stats')).toBeTruthy()

    await act(async () => screen.getByTestId('view-diagram').click())
    await waitFor(() => expect(screen.getByTestId('team-diagram')).toBeTruthy())
    expect(window.location.search).toBe('?view=diagram')

    await act(async () => screen.getByTestId('view-overview').click())
    expect(window.location.search).toBe('')
    expect(screen.queryByTestId('diagram-view')).toBeNull()
  })

  it('opens on the view the URL asked for', async () => {
    stubFetch((url) => (url.endsWith('/diagram') ? { body: { diagram: projectDiagramFixture() } } : { body: { project: projectFixture() } }))
    render(<ProjectScreen initial={projectFixture()} view="timeline" />)
    expect(screen.getByTestId('view-timeline').getAttribute('aria-selected')).toBe('true')
    await waitFor(() => expect(screen.getByTestId('timeline')).toBeTruthy())
  })
})
