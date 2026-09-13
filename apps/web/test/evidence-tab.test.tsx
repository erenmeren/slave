// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
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
  const money = {
    reportedUsd: over.reportedUsd ?? 4.2,
    estimatedUsd: over.estimatedUsd ?? 0.5,
    unmeasuredRuns: over.unmeasuredRuns ?? 0,
  }
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
    medianDurationMs: over.medianDurationMs ?? 754_000,
    ...money,
    insufficient,
  }
  const model: EvidenceModelRow = {
    model: 'model' in over ? (over.model ?? null) : 'sonnet-4',
    label: 'model' in over ? (over.model ?? 'Model not recorded') : 'sonnet-4',
    attempted: over.attempted ?? 12,
    ...rates,
    medianDurationMs: over.medianDurationMs ?? 754_000,
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
    // The ROW is not thin -- only one of its denominators is -- so it carries no row marker, which
    // is what `gate:m16-chrome`'s moved check 5 branches on (plan erratum E11).
    expect(screen.queryByTestId('evidence-insufficient-template:t1')).toBeNull()
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
