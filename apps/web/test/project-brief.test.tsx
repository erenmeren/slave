// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProjectBrief } from '../src/components/project/ProjectBrief'

// This repo's vitest setup carries NO jest-dom matchers (`new-slave-drawer.test.tsx` and
// `project-settings.test.tsx` both say so), so every assertion below reads `textContent` and
// `getAttribute` directly rather than `toHaveTextContent`/`toHaveAttribute`.

/**
 * One project as the brief reads it (M45 R1). Every field is the shape `server/brief.ts` returns,
 * `cost` included -- its two holes are DIFFERENT facts (Task 2 fix round 1), so the fixture
 * carries both and two cases below keep them apart.
 */
const BRIEF = {
  objective: { text: 'Ship the checkout flow', version: 3 },
  supervisor: { state: 'decisions' as const, label: '2 DECISIONS WAITING', needsYou: true },
  work: { working: 2, verifying: 1, review: 0, waiting: 1, done: 4 },
  // M50 R6: one member per lifecycle -- a permanent worker off the roster, a temporary specialist
  // still here, and one whose engagement is over.
  team: [
    { slaveId: 's1', name: 'Ada', roleLabel: 'developer', status: 'WORKING', taskTitle: 'Add Apple Pay', lifecycle: 'permanent' as const, released: null },
    { slaveId: 's2', name: 'Bo', roleLabel: 'reviewer', status: 'IDLE', taskTitle: null, lifecycle: 'project' as const, released: null },
    { slaveId: 's3', name: 'Cass', roleLabel: 'security', status: 'IDLE', taskTitle: null, lifecycle: 'ephemeral' as const, released: null },
    { slaveId: 's4', name: 'Dara', roleLabel: 'security', status: 'IDLE', taskTitle: null, lifecycle: 'ephemeral' as const, released: { at: '2026-09-12T10:00:00.000Z', reason: 'the engagement is over' } },
  ],
  needsYou: [
    { kind: 'blocked_task' as const, id: 't1', title: 'Wire the webhook — no credentials', href: '/w/w1/tasks?task=t1', since: '2026-09-09T08:00:00.000Z', taskId: 't1', decisionId: null, messageId: null },
    { kind: 'decision' as const, id: 'd1', title: 'No reviewer: nobody holds reviewer', href: '/w/w1#decision-d1', since: '2026-09-09T09:00:00.000Z', taskId: null, decisionId: 'd1', messageId: null },
  ],
  latestVerified: { taskTitle: 'Add the banner', kind: 'integrated' as const, at: '2026-09-09T10:00:00.000Z' },
  // M51 R5: three figures and two holes. `actualUsd` IS `measuredUsd` to the cent (plan erratum
  // E13), and this fixture is a project where everything that finished reported -- so the estimate
  // equals the actual and the upper bound equals the total, which is exactly when the tile shows
  // neither line (decision D19) and reads precisely as it did before M51.
  cost: {
    spentUsd: 12.5,
    measuredUsd: 9.5,
    actualUsd: 9.5,
    estimatedUsd: 9.5,
    upperBoundUsd: 12.5,
    unmeasuredCalls: 3,
    unmeasuredRuns: 0,
    budgetUsd: 25,
  },
  recentChanges: [{ at: '2026-09-09T10:30:00.000Z', summary: 'Project · goal set' }],
  knowledge: { verified: 3, candidates: 1 },
}

/** The one tile carrying a given fact. */
const tileFor = (fact: string): HTMLElement => {
  const tile = screen.getAllByTestId('brief-tile').find((one) => one.getAttribute('data-brief') === fact)
  if (tile === undefined) throw new Error(`no brief tile for ${fact}`)
  return tile
}

describe('ProjectBrief', () => {
  it('renders exactly the eight facts, each on its own tile', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const tiles = screen.getAllByTestId('brief-tile')
    expect(tiles.map((tile) => tile.getAttribute('data-brief'))).toEqual([
      'objective', 'supervisor', 'work', 'cost', 'needs-you', 'latest-verified', 'team', 'recent-changes',
    ])
  })

  it('M49 R6: the knowledge line is a link inside the latest-verified tile, not a ninth tile', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    expect(screen.getAllByTestId('brief-tile')).toHaveLength(8)
    const line = screen.getByTestId('brief-knowledge')
    expect(line.getAttribute('href')).toBe('/w/w1/knowledge')
    expect(line.textContent).toBe('Knowledge: 3 verified · 1 candidates')
    expect(tileFor('latest-verified').contains(line)).toBe(true)
  })

  it('says the objective and its version, and links to where it is edited', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const tile = tileFor('objective')
    expect(tile.textContent).toContain('Ship the checkout flow')
    expect(tile.textContent).toContain('v3')
    expect(within(tile).getAllByRole('link')[0]?.getAttribute('href')).toBe('/w/w1/settings')
  })

  it('invites a person to set an objective when the project has none', () => {
    render(<ProjectBrief workspaceId="w1" brief={{ ...BRIEF, objective: { text: null, version: 0 } }} />)
    const link = within(tileFor('objective')).getByRole('link')
    expect(link.textContent).toBe('no objective yet · set one')
    expect(link.getAttribute('href')).toBe('/w/w1/settings')
  })

  it('says what the Supervisor is doing in one word, with the raw state in title', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const state = screen.getByTestId('brief-supervisor-state')
    expect(state.textContent).toBe('2 DECISIONS WAITING')
    expect(state.getAttribute('title')).toBe('decisions')
  })

  it('counts the work in the domain’s own words, and dims a zero rather than hiding it', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    expect(screen.getByTestId('brief-work-working').textContent).toBe('WORKING 2')
    expect(screen.getByTestId('brief-work-verifying').textContent).toBe('VERIFYING 1')
    expect(screen.getByTestId('brief-work-review').textContent).toBe('IN REVIEW 0')
    expect(screen.getByTestId('brief-work-waiting').textContent).toBe('WAITING 1')
    expect(screen.getByTestId('brief-work-done').textContent).toBe('DONE 4')
    // A zero is dimmed, never dropped: "is anything being reviewed" is answered by the 0.
    expect(screen.getByTestId('brief-work-review').className).toContain('text-text-3')
    expect(screen.getByTestId('brief-work-working').className).not.toContain('text-text-3')
  })

  it('names the two halves of the money and never prints a bare unmeasured figure', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const tile = tileFor('cost')
    expect(tile.textContent).toContain('$12.50')
    expect(tile.textContent).toContain('$25')
    // M51 R5 / erratum E13: `actual` REPLACED this line's old `measured` word -- one number, one
    // label, and never both words for the same sum.
    expect(tile.textContent).toContain('actual $9.50')
    expect(tile.textContent).toContain('3 unmeasured calls charged at $1.00 each')
    // Never $0.00 for a hole: an unmeasured call costs an unknown amount up to the cap.
    expect(tile.textContent).not.toContain('$0.00')
  })

  it('says a run nobody measured is in no total at all, in its own sentence', () => {
    render(<ProjectBrief workspaceId="w1" brief={{ ...BRIEF, cost: { ...BRIEF.cost, unmeasuredCalls: 0, unmeasuredRuns: 2 } }} />)
    const tile = tileFor('cost')
    expect(tile.textContent).toContain('2 unmeasured runs (not in the total)')
    // Two different facts, two different sentences -- never one number for both.
    expect(tile.textContent).not.toContain('charged at')
  })

  it('lists what needs a person, with a working link each', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const rows = screen.getAllByTestId('needs-you-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.querySelector('a')?.getAttribute('href')).toBe('/w/w1/tasks?task=t1')
    expect(rows[0]?.textContent).toContain('BLOCKED')
    expect(rows[0]?.textContent).toContain('Wire the webhook')
    expect(rows[1]?.querySelector('a')?.getAttribute('href')).toBe('/w/w1#decision-d1')
    expect(rows[1]?.textContent).toContain('DECISION')
    // The raw kind is reachable, never readable (`docs/ia.md` rule 3).
    expect(rows[0]?.textContent).not.toContain('blocked_task')
    expect(within(rows[0] as HTMLElement).getByTestId('chip').getAttribute('title')).toBe('blocked_task')
  })

  /**
   * M45 final wave, I4: R1's promise is EIGHT FACTS ON ONE SCREEN, and a queue that grows with the
   * project keeps that promise only while the project is small. Five rows and a way to the rest.
   */
  it('caps the needs-you list at five rows and links to the rest', () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      kind: 'blocked_task' as const,
      id: `t${String(index)}`,
      title: `Blocked task ${String(index)}`,
      href: `/w/w1/tasks?task=t${String(index)}`,
      since: '2026-09-09T08:00:00.000Z',
      taskId: `t${String(index)}`,
      decisionId: null,
      messageId: null,
    }))
    render(<ProjectBrief workspaceId="w1" brief={{ ...BRIEF, needsYou: many }} />)
    expect(screen.getAllByTestId('needs-you-row')).toHaveLength(5)
    const more = screen.getByTestId('needs-you-more')
    expect(more.textContent).toContain('+2 more')
    expect(more.querySelector('a')?.getAttribute('href')).toBe('/w/w1/tasks')
  })

  it('shows no overflow row when the needs-you queue is exactly five', () => {
    const five = Array.from({ length: 5 }, (_, index) => ({
      kind: 'question' as const,
      id: `m${String(index)}`,
      title: `Question ${String(index)}`,
      href: `/w/w1#question-m${String(index)}`,
      since: '2026-09-09T08:00:00.000Z',
      taskId: null,
      decisionId: null,
      messageId: `m${String(index)}`,
    }))
    render(<ProjectBrief workspaceId="w1" brief={{ ...BRIEF, needsYou: five }} />)
    expect(screen.getAllByTestId('needs-you-row')).toHaveLength(5)
    expect(screen.queryByTestId('needs-you-more')).toBeNull()
  })

  it('caps the team list at five rows and sends the rest to the Team strip', () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      slaveId: `s${String(index)}`,
      name: `Worker ${String(index)}`,
      roleLabel: 'developer',
      status: 'WORKING',
      taskTitle: null,
      lifecycle: 'project' as const,
      released: null,
    }))
    render(<ProjectBrief workspaceId="w1" brief={{ ...BRIEF, team: many }} />)
    expect(screen.getAllByTestId('team-row')).toHaveLength(5)
    const more = screen.getByTestId('team-more')
    expect(more.textContent).toContain('+3 more')
    expect(more.querySelector('a')?.getAttribute('href')).toBe('#team')
  })

  /** M45 final wave, M6: version 0 is "no version has ever been saved", and a `v0` chip beside a
   *  goal somebody clearly wrote reads as a version somebody made. */
  it('shows no version chip on an objective that has no saved version', () => {
    render(<ProjectBrief workspaceId="w1" brief={{ ...BRIEF, objective: { text: 'Ship the checkout flow', version: 0 } }} />)
    const tile = tileFor('objective')
    expect(tile.textContent).toContain('Ship the checkout flow')
    expect(tile.textContent).not.toContain('v0')
    // The way to the editor stays, chip or no chip.
    expect(within(tile).getAllByRole('link')[0]?.getAttribute('href')).toBe('/w/w1/settings')
  })

  it('says nothing is verified yet rather than leaving the tile blank', () => {
    render(<ProjectBrief workspaceId="w1" brief={{ ...BRIEF, latestVerified: null, needsYou: [] }} />)
    expect(tileFor('latest-verified').textContent).toContain('nothing verified yet')
    expect(tileFor('needs-you').textContent).toContain('nothing needs you')
  })

  it('says which kind of finished the newest verified work reached', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const tile = tileFor('latest-verified')
    expect(tile.textContent).toContain('Add the banner')
    expect(tile.textContent).toContain('integrated into the base branch')
  })

  it('shows what each worker is on', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const tile = tileFor('team')
    expect(tile.textContent).toContain('Ada')
    expect(tile.textContent).toContain('Add Apple Pay')
    // A worker on nothing says so, rather than leaving the column blank.
    expect(screen.getAllByTestId('team-row')[1]?.textContent).toContain('—')
  })

  // M50 R6, `docs/ia.md` rule 3: the word, with the raw value one hover away. `project` is the
  // ordinary case and prints nothing -- a marker every row carries marks nothing.
  it('marks a temporary specialist and greys one whose engagement is over', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const chips = screen.getAllByTestId('team-lifecycle')
    expect(chips.map((chip) => chip.textContent)).toEqual(['Permanent', 'Ephemeral', 'Ephemeral'])
    expect(chips[1]?.getAttribute('title')).toBe('ephemeral')
    const rows = screen.getAllByTestId('team-row')
    expect(rows.filter((row) => row.getAttribute('data-released') === 'true')).toHaveLength(1)
  })

  // The component test passes no handler, and that is the case being pinned: a brief with nowhere
  // to send a click is still a correct brief, and it must not offer a dead button.
  it('is a plain row with no handler and a button with one', () => {
    const { unmount } = render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    expect(screen.getAllByTestId('team-row')[0]?.tagName).toBe('DIV')
    unmount()
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} onOpenSlave={() => undefined} />)
    expect(screen.getAllByTestId('team-row')[0]?.tagName).toBe('BUTTON')
  })

  it('shows no budget figure at all on an unbudgeted project', () => {
    render(<ProjectBrief workspaceId="w1" brief={{ ...BRIEF, cost: { ...BRIEF.cost, budgetUsd: null } }} />)
    expect(tileFor('cost').textContent).not.toContain('/ $')
  })

  it('reads the clock off the stamp rather than computing an age', () => {
    render(<ProjectBrief workspaceId="w1" brief={BRIEF} />)
    const tile = tileFor('recent-changes')
    expect(tile.textContent).toContain('10:30:00')
    expect(tile.textContent).toContain('Project · goal set')
  })
})

/**
 * M51 R5/R7: the cost tile answers three different questions and says which is which. The big mono
 * figure is still `spentUsd` -- the ONE number the budget guardrail compares -- which is how three
 * answers stay inside the one-figure rule rather than breaking it.
 */
describe('the cost tile after M51 R7', () => {
  const cost = {
    spentUsd: 4.5,
    measuredUsd: 3.5,
    actualUsd: 3.5,
    estimatedUsd: 6.25,
    upperBoundUsd: 5.5,
    unmeasuredCalls: 1,
    unmeasuredRuns: 1,
    budgetUsd: 25,
  }
  const briefWith = (over: Partial<typeof cost>): typeof BRIEF => ({ ...BRIEF, cost: { ...cost, ...over } })

  it('is still ONE tile among the eight, and the big figure is still the guardrail’s number', () => {
    render(<ProjectBrief workspaceId="w1" brief={briefWith({})} />)
    expect(screen.getAllByTestId('brief-tile')).toHaveLength(8)
    expect(tileFor('cost').textContent).toContain('$4.50 / $25')
  })

  it('labels all three figures, so no number has to be guessed at', () => {
    render(<ProjectBrief workspaceId="w1" brief={briefWith({})} />)
    expect(screen.getByTestId('brief-cost-actual').textContent).toBe('actual $3.50')
    expect(screen.getByTestId('brief-cost-estimated').textContent).toBe('estimated $6.25')
    expect(screen.getByTestId('brief-cost-upper-bound').textContent).toBe('upper bound $5.50')
  })

  it('keeps both hole sentences exactly as they were', () => {
    render(<ProjectBrief workspaceId="w1" brief={briefWith({})} />)
    expect(screen.getByTestId('brief-cost-unmeasured-calls').textContent).toBe(
      '1 unmeasured calls charged at $1.00 each',
    )
    expect(screen.getByTestId('brief-cost-unmeasured-runs').textContent).toBe('1 unmeasured runs (not in the total)')
  })

  it('replaces the old `measured` line rather than sitting beside it -- one number, one label', () => {
    render(<ProjectBrief workspaceId="w1" brief={briefWith({})} />)
    expect(tileFor('cost').textContent).not.toContain('measured $')
  })

  it('hides the estimate when it is no different from the actual -- a repeated number is noise', () => {
    render(<ProjectBrief workspaceId="w1" brief={briefWith({ estimatedUsd: 3.5 })} />)
    expect(screen.queryByTestId('brief-cost-estimated')).toBeNull()
  })

  // D19 compares what is RENDERED, not the raw floats: `actualUsd` comes from Postgres' `SUM()` and
  // `estimatedUsd` from a JS reduce over rows in unspecified order, so two figures that are
  // mathematically equal need not be bit-equal -- and a tile printing `actual $3.50` above
  // `estimated $3.50` is the repeated number D19 exists to suppress.
  it('hides a line whose float noise is invisible once it is money', () => {
    render(<ProjectBrief workspaceId="w1" brief={briefWith({ estimatedUsd: 3.5000000001 })} />)
    expect(screen.queryByTestId('brief-cost-estimated')).toBeNull()
    expect(screen.getByTestId('brief-cost-actual').textContent).toBe('actual $3.50')
  })

  it('hides the upper bound whose float noise is invisible once it is money', () => {
    render(<ProjectBrief workspaceId="w1" brief={briefWith({ upperBoundUsd: 4.5000000001 })} />)
    expect(screen.queryByTestId('brief-cost-upper-bound')).toBeNull()
  })

  // The other half of decision D19, and the one `gate:m45`'s fold check depends on: a project where
  // every concluded run reported shows exactly the lines it showed before M51.
  it('hides the upper bound when nothing unmeasured moves it off the total', () => {
    render(<ProjectBrief workspaceId="w1" brief={briefWith({ upperBoundUsd: 4.5, unmeasuredRuns: 0 })} />)
    expect(screen.queryByTestId('brief-cost-upper-bound')).toBeNull()
    expect(screen.getByTestId('brief-cost-actual').textContent).toBe('actual $3.50')
  })
})
