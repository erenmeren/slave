// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CapabilityRecord } from '@slave-of-ai/domain'
import { RunbooksTab } from '../src/components/workforce/RunbooksTab'
import type { RunbookRowView } from '../src/server/org'

const taxonomy: readonly CapabilityRecord[] = [
  { key: 'planning.decomposition', label: 'Work decomposition', domain: 'planning', role: 'manager', synonyms: [] },
  { key: 'review.code-review', label: 'Code review', domain: 'review', role: 'reviewer', synonyms: [] },
]

const stage = (key: string, title: string, over: Partial<RunbookRowView['stages'][number]> = {}): RunbookRowView['stages'][number] => ({
  key,
  title,
  objective: `Do ${title}`,
  capabilities: [],
  dependsOn: [],
  expectedOutputs: [],
  gates: [],
  retry: null,
  escalation: null,
  ...over,
})

const runbook = (over: Partial<RunbookRowView>): RunbookRowView => ({
  id: 'r1',
  key: 'feature-delivery',
  name: 'Feature delivery',
  description: 'Decide the shape, build it, prove it.',
  keywords: ['feature'],
  requiredCapabilities: ['planning.decomposition'],
  optionalCapabilities: [],
  stages: [
    stage('design', 'Design', { capabilities: ['planning.decomposition'] }),
    stage('review', 'Review', { capabilities: ['review.code-review'], gates: ['npm test'], retry: { maxAttempts: 2 }, escalation: 'Bring a person in.' }),
  ],
  source: 'seed',
  sourceTemplateId: null,
  sourceTemplateName: null,
  workspaceCount: 2,
  ...over,
})

describe('the Runbooks tab (M48 R7)', () => {
  it('lists one row per runbook, with its stage count and how many projects follow it', () => {
    render(<RunbooksTab runbooks={[runbook({}), runbook({ id: 'r2', key: 'bug-fix', name: 'Bug fix', workspaceCount: 0 })]} taxonomy={taxonomy} />)
    const rows = screen.getAllByTestId('runbook-row')
    expect(rows.map((row) => row.getAttribute('data-key'))).toEqual(['feature-delivery', 'bug-fix'])
    expect(rows[0]?.textContent).toContain('Feature delivery')
    expect(rows[0]?.textContent).toContain('2 stages')
    expect(rows[0]?.textContent).toContain('2 projects')
  })

  it('opens a read-only drawer with the stages in order, each stage told in words', () => {
    render(<RunbooksTab runbooks={[runbook({})]} taxonomy={taxonomy} />)
    expect(screen.queryByTestId('runbook-drawer')).toBeNull()

    fireEvent.click(screen.getByTestId('runbook-open-feature-delivery'))

    const drawer = screen.getByTestId('runbook-drawer')
    expect(within(drawer).getAllByTestId('runbook-drawer-stage').map((node) => node.getAttribute('data-stage'))).toEqual([
      'design',
      'review',
    ])
    // Labels, never keys (docs/ia.md rule 3).
    expect(drawer.textContent).toContain('Work decomposition')
    expect(drawer.textContent).not.toContain('planning.decomposition')
    // A stage's gates, its retry and its escalation -- the three things that change what happens
    // to a task in it.
    expect(drawer.textContent).toContain('npm test')
    expect(drawer.textContent).toContain('2 attempts')
    expect(drawer.textContent).toContain('Bring a person in.')
    // Read-only: `runbooks add --file` is the only writer (spec §3).
    expect(within(drawer).queryAllByRole('textbox')).toEqual([])
  })

  it('names the specialist a persona runbook was translated from', () => {
    render(
      <RunbooksTab
        runbooks={[runbook({ source: 'persona', sourceTemplateId: 'tpl1', sourceTemplateName: 'Security Engineer' })]}
        taxonomy={taxonomy}
      />,
    )
    fireEvent.click(screen.getByTestId('runbook-open-feature-delivery'))
    const drawer = screen.getByTestId('runbook-drawer')
    expect(drawer.textContent).toContain('Security Engineer')
    expect(drawer.textContent).not.toContain('tpl1')
  })

  // Fix round 1, minor 6: the empty state names the BINARY (`SkillsClient`'s own wording), and it
  // lives inside the `workforce-runbooks` wrapper -- that handle is "where the runbooks are", and
  // a gate looking for it must find the tab's answer whichever answer it is.
  it('says so when there is no runbook at all, and names the command that writes them', () => {
    render(<RunbooksTab runbooks={[]} taxonomy={taxonomy} />)
    const empty = screen.getByTestId('runbooks-empty')
    expect(empty.textContent).toContain('orchestrator runbooks sync')
    expect(screen.getByTestId('workforce-runbooks').contains(empty)).toBe(true)
  })
})
