// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EvidenceTab } from '../src/components/workforce/EvidenceTab'
import type { EvidenceModelRow, EvidencePage, EvidenceProfileRow, EvidenceRate } from '../src/server/evidence'

const routerRefresh = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
  useSearchParams: () => new URLSearchParams('tab=evidence'),
}))

const rate = (pct: number | null, judged = 12): EvidenceRate => ({ pct, judged })

/** Every field of one profile row and one model row, so a case states only what it is about. An
 *  override lands on BOTH tables wherever the field exists in both -- the thin-row case is about
 *  the whole page rendering no progress bar, and one measured table would hide that. */
type Over = Partial<EvidenceProfileRow & EvidenceModelRow>

function page(over: Over = {}): EvidencePage {
  const insufficient = over.insufficient ?? false
  const thin = (given: EvidenceRate | undefined, fallback: EvidenceRate): EvidenceRate =>
    given ?? (insufficient ? { pct: null, judged: over.attempted ?? 2 } : fallback)
  const rates = {
    firstPass: thin(over.firstPass, rate(83)),
    reviewRejected: thin(over.reviewRejected, rate(17)),
    integrated: thin(over.integrated, rate(75)),
  }
  // `in`, not `??`: `null` is a MEANING here (nothing was reported, nobody measured the span) and
  // `?? default` would silently turn an explicit null back into a figure.
  const money = {
    reportedUsd: 'reportedUsd' in over ? (over.reportedUsd ?? null) : 4.2,
    estimatedUsd: 'estimatedUsd' in over ? (over.estimatedUsd ?? null) : 0.5,
    unmeasuredRuns: over.unmeasuredRuns ?? 0,
  }
  const medianDurationMs = 'medianDurationMs' in over ? (over.medianDurationMs ?? null) : 754_000
  const profile: EvidenceProfileRow = {
    profileKey: over.profileKey ?? 'template:t1',
    name: over.name ?? 'Backend Developer',
    bespoke: over.bespoke ?? false,
    repositoryKey: over.repositoryKey ?? '/srv/checkout',
    attempted: over.attempted ?? 12,
    ...rates,
    reworkCycles: over.reworkCycles ?? 2,
    humanInterventions: over.humanInterventions ?? 1,
    recoveries: over.recoveries ?? 0,
    medianDurationMs,
    ...money,
    insufficient,
  }
  const model: EvidenceModelRow = {
    model: 'model' in over ? (over.model ?? null) : 'sonnet-4',
    label: 'model' in over ? (over.model ?? 'Model not recorded') : 'sonnet-4',
    attempted: over.attempted ?? 12,
    ...rates,
    medianDurationMs,
    ...money,
    insufficient,
  }
  return {
    domains: [
      { domain: 'backend', label: 'Backend' },
      { domain: 'general', label: 'General' },
      { domain: 'qa', label: 'QA' },
    ],
    byProfile: [profile],
    byModel: [model],
    sortCaption: 'Most runs first, then by name. Nothing here is a score.',
    minSample: 5,
  }
}

describe('EvidenceTab (M53 R11, R12)', () => {
  it('renders two tables and no chart at all -- counts and rates, never a vanity chart', () => {
    render(<EvidenceTab page={page()} />)
    expect(screen.getByTestId('evidence-table-profile')).toBeTruthy()
    expect(screen.getByTestId('evidence-table-model')).toBeTruthy()
    expect(screen.queryByTestId('bar-chart')).toBeNull()
    expect(screen.queryByTestId('bar-column')).toBeNull()
  })

  it('prints the profile NAME with the key in `title` and on `data-profile-key`, never as text', () => {
    render(<EvidenceTab page={page()} />)
    const row = screen.getByTestId('evidence-profile-row-template:t1')
    expect(row.textContent).toContain('Backend Developer')
    expect(row.textContent).not.toContain('template:t1')
    expect(row.getAttribute('data-profile-key')).toBe('template:t1')
    expect(row.querySelector('[title="template:t1"]')).toBeTruthy()
  })

  it('chips a bespoke profile', () => {
    render(<EvidenceTab page={page({ bespoke: true })} />)
    expect(screen.getByText('Bespoke')).toBeTruthy()
  })

  it('renders the WORDS in place of every rate on a thin row, with the counts still beside them', () => {
    render(<EvidenceTab page={page({ insufficient: true, attempted: 2 })} />)
    expect(screen.getByTestId('evidence-insufficient-template:t1')).toBeTruthy()
    expect(screen.getAllByText('Insufficient evidence').length).toBeGreaterThan(0)
    expect(screen.getByTestId('evidence-profile-row-template:t1').textContent).toContain('2')
  })

  it('renders one thin rate as the words while its neighbours render percentages', () => {
    render(<EvidenceTab page={page({ integrated: { pct: null, judged: 2 } })} />)
    const row = screen.getByTestId('evidence-profile-row-template:t1')
    expect(row.textContent).toContain('Insufficient evidence')
    expect(row.textContent).toMatch(/\d+%/u)
    // The ROW claims two of its three rates, so it carries NEITHER row marker -- which is what
    // `gate:m16-chrome`'s moved check 5 branches on (plan erratum E11).
    expect(screen.queryByTestId('evidence-insufficient-template:t1')).toBeNull()
    expect(screen.queryByTestId('evidence-unjudged-template:t1')).toBeNull()
  })

  /**
   * Fix round 1, findings 1 and 4: THREE kinds of row, and the marker each carries.
   *
   * Before this round a row with enough attempts and nothing judged carried no marker at all, so
   * `gate:m16-chrome`'s check 5 classified it as claiming rates and then failed it for drawing no
   * bar. Task 3's fix round made that row ordinary -- only a verdict somebody reached settles a
   * judgement column.
   */
  it('marks a THIN row, marks an UNJUDGED row, and marks a claiming row not at all (fix round 1)', () => {
    const nothingJudged = { pct: null, judged: 0 }

    render(<EvidenceTab page={page({ insufficient: true, attempted: 2 })} />)
    expect(screen.getByTestId('evidence-insufficient-template:t1')).toBeTruthy()
    expect(screen.queryByTestId('evidence-unjudged-template:t1')).toBeNull()
    expect(screen.queryByTestId('progress-bar')).toBeNull()
    cleanup()

    const unjudged = render(
      <EvidenceTab
        page={page({
          attempted: 8,
          firstPass: nothingJudged,
          reviewRejected: nothingJudged,
          integrated: nothingJudged,
        })}
      />,
    )
    expect(screen.getByTestId('evidence-unjudged-template:t1')).toBeTruthy()
    expect(screen.queryByTestId('evidence-insufficient-template:t1')).toBeNull()
    // The whole point of the marker: this row draws no bar either, and the moved check must not
    // read it as a row that claims something.
    expect(unjudged.container.querySelector('[data-testid="progress-bar"]')).toBeNull()
    cleanup()

    render(<EvidenceTab page={page()} />)
    expect(screen.queryByTestId('evidence-insufficient-template:t1')).toBeNull()
    expect(screen.queryByTestId('evidence-unjudged-template:t1')).toBeNull()
  })

  // Fix round 1, item 4: `Insufficient evidence` is ONLY "there is a sample and it is too thin".
  // A denominator of zero is a question nobody has answered, and the page says so in words rather
  // than hiding the difference in a `title`.
  it('says "not judged yet" in words for a rate nobody has judged, never "Insufficient evidence"', () => {
    render(<EvidenceTab page={page({ attempted: 8, integrated: { pct: null, judged: 0 } })} />)
    const row = screen.getByTestId('evidence-profile-row-template:t1')
    expect(row.textContent).toContain('not judged yet')
    // Its neighbours still claim their rates, so the phrase R11 minted does not appear at all here.
    expect(row.textContent).not.toContain('Insufficient evidence')
    cleanup()

    // And the thin-sample case keeps the phrase, with the denominator one hover away. Scoped to the
    // profile row: the fixture patches both tables, so the model row carries the same cell.
    render(<EvidenceTab page={page({ attempted: 8, integrated: { pct: null, judged: 2 } })} />)
    const thinCell = within(screen.getByTestId('evidence-profile-row-template:t1')).getByText('Insufficient evidence')
    expect(thinCell.getAttribute('title')).toBe('2 judged so far')
  })

  // Fix round 1, item 3: `SlavePanel`'s `permission-mode-word` idiom -- a glyph carrying meaning
  // gets a word behind it, or the cell has no accessible name at all.
  it('puts a word behind every "—", for a screen reader and for a hover', () => {
    render(<EvidenceTab page={page({ medianDurationMs: null, reportedUsd: null, estimatedUsd: null, unmeasuredRuns: 0 })} />)
    const durationMark = screen.getAllByTestId('evidence-duration-unrecorded')[0]
    expect(durationMark?.textContent).toContain('not recorded')
    expect(durationMark?.getAttribute('title')).toBe('not recorded')
    expect(durationMark?.querySelector('.sr-only')?.textContent).toBe('not recorded')
    expect(durationMark?.querySelector('[aria-hidden]')?.textContent).toBe('—')
    expect(screen.getAllByTestId('evidence-cost-unrecorded')[0]?.getAttribute('title')).toBe('not recorded')
  })

  /**
   * Fix round 1, finding 2: an empty table under a domain chip means "nothing in THIS domain", and
   * the global sentence there is a claim about the whole installation the page cannot support --
   * the same class of over-claim as the raw `SUM(costUsd)` tile this milestone deleted.
   */
  it('names the filter when an empty table is empty only because of it, and says so in words', () => {
    const empty = { byProfile: [], byModel: [] }
    render(<EvidenceTab page={{ ...page(), ...empty }} selected="qa" />)
    expect(screen.getByTestId('evidence-profile-empty').textContent).toBe('No record in QA yet.')
    expect(screen.getByTestId('evidence-model-empty').textContent).toBe('No record in QA yet.')
    // The LABEL, never the key.
    expect(screen.getByTestId('evidence-profile-empty').textContent).not.toContain('qa')
    cleanup()

    render(<EvidenceTab page={{ ...page(), ...empty }} selected={null} />)
    expect(screen.getByTestId('evidence-profile-empty').textContent).toBe(
      'no run has left a record yet. A record is written when a run concludes, never before.',
    )
  })

  it('gives a shown rate a progress bar carrying `aria-valuenow`, and a thin one NO bar (erratum E11)', () => {
    const { container } = render(<EvidenceTab page={page()} />)
    expect(container.querySelector('[data-testid="progress-bar"][aria-valuenow]')).toBeTruthy()
    cleanup()
    const thin = render(<EvidenceTab page={page({ insufficient: true })} />)
    expect(thin.container.querySelector('[data-testid="progress-bar"]')).toBeNull()
  })

  it('renders money with `formatUsd` and the three provenance words, the unmeasured count on its own line', () => {
    render(<EvidenceTab page={page({ reportedUsd: 8.5, estimatedUsd: 1, unmeasuredRuns: 3 })} />)
    const row = screen.getByTestId('evidence-profile-row-template:t1')
    expect(row.textContent).toContain('$8.50 reported')
    expect(row.textContent).toContain('$1.00 estimated')
    expect(row.textContent).toContain('3 unmeasured')
  })

  it('renders the domain chips with words, the raw key on `data-domain`', () => {
    render(<EvidenceTab page={page()} />)
    const chip = screen.getByTestId('evidence-domain-qa')
    expect(chip.textContent).toBe('QA')
    expect(chip.getAttribute('data-domain')).toBe('qa')
  })

  it('names the null-model group in words in the by-model table', () => {
    render(<EvidenceTab page={page({ model: null })} />)
    expect(screen.getByTestId('evidence-model-row-').textContent).toContain('Model not recorded')
  })

  it('states the sort in a caption rather than leaving it to be inferred (R11)', () => {
    render(<EvidenceTab page={page()} />)
    expect(screen.getByTestId('evidence-sort-caption').textContent).toMatch(/Most runs first, then by name/u)
  })

  it('prints no `EvidenceOutcome`, `EvidenceCostProvenance` or domain KEY as visible text anywhere', () => {
    const { container } = render(<EvidenceTab page={page()} />)
    for (const key of ['succeeded', 'failed', 'stopped', 'backend', 'qa', 'general']) {
      expect(container.textContent ?? '', key).not.toMatch(new RegExp(`\\b${key}\\b`, 'u'))
    }
  })

  // D35: the chip writes the URL the way `WorkforceClient` writes `?tab=` -- merged, so a link that
  // arrived with `?tab=evidence` keeps it -- and then asks the SERVER to read again, because unlike
  // a tab switch a domain changes the data this page was built from.
  it('writes the chosen domain into ?domain= merged with the existing query, and re-reads', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState')
    routerRefresh.mockClear()
    render(<EvidenceTab page={page()} />)
    screen.getByTestId('evidence-domain-qa').click()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/workforce?tab=evidence&domain=qa')
    expect(routerRefresh).toHaveBeenCalled()
    replaceState.mockRestore()
  })

  it('offers a way back to every domain rather than stranding a person inside one', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState')
    render(<EvidenceTab page={page()} selected="qa" />)
    expect(screen.getByTestId('evidence-domain-clear').textContent).toBe('All domains')
    screen.getByTestId('evidence-domain-clear').click()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/workforce?tab=evidence')
    replaceState.mockRestore()
  })
})
