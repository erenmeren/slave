// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionView } from '@slave-of-ai/control'
import type { OrganizationView } from '../src/server/organization'
import { OrganizationClient } from '../src/components/organization/OrganizationClient'

const decision: DecisionView = {
  id: 'd1',
  workspaceId: 'w1',
  situationKind: 'capability_unstaffed',
  subjectId: 'security.application',
  situation: {
    kind: 'capability_unstaffed',
    subjectId: 'security.application',
    summary: 'Nobody on this project can be dispatched for Application security.',
    facts: { capability: 'security.application', role: 'security', readyTasks: 2 },
  },
  candidates: [],
  chosenIndex: 0,
  action: {
    kind: 'hire_from_catalog',
    templateId: 't-sec',
    capability: 'security.application',
    name: 'Security Reviewer',
    rationale: 'Security Reviewer provides Application security and nobody here does.',
    temporary: false,
  },
  draft: null,
  rationale: 'Security Reviewer provides Application security and nobody here does.',
  tier: 'proposed',
  status: 'pending',
  decidedBy: 'rules',
  modelCostUsd: null,
  modelCalled: false,
  failureReason: null,
  createdAt: '2026-09-11T09:00:00.000Z',
  expiresAt: null,
  resolvedAt: null,
}

const view: OrganizationView = {
  workers: [
    {
      slaveId: 's1',
      name: 'Alex',
      roleLabel: 'engineering',
      kind: 'company',
      capabilities: [{ key: 'security.application', label: 'Application security' }],
      why: 'Assigned from M47 Co',
      runtimeRoles: ['engineering'],
      doing: 'Working',
    },
    {
      slaveId: 's2',
      name: 'Rae',
      roleLabel: 'backend',
      kind: 'project',
      capabilities: [{ key: 'backend.api-design', label: 'API design' }],
      why: 'Seeded',
      runtimeRoles: ['backend'],
      doing: null,
    },
    {
      slaveId: 's3',
      name: 'Security Reviewer',
      roleLabel: 'security',
      kind: 'project',
      capabilities: [],
      why: 'Hired for security.application because the board needs it',
      runtimeRoles: ['reviewer'],
      doing: null,
    },
  ],
  needs: [
    {
      capability: 'security.application',
      label: 'Application security',
      summary: 'Nobody on this project can be dispatched for Application security.',
      readyTasks: 2,
      decisions: [decision],
    },
  ],
  covered: [{ capability: 'backend.api-design', label: 'API design', by: 's2' }],
  unfillable: [{ capability: 'mobile.ios', label: 'iOS' }],
  hints: [
    {
      slaveId: 's3',
      text: 'Consult the Gate Platform Builder before changing an endpoint.',
      targetTemplateName: 'Gate Platform Builder',
      capability: 'backend.api-design',
      capabilityLabel: 'API design',
    },
  ],
  pendingElsewhere: 0,
  taskTitles: { t1: 'Review the checkout API' },
}

const EMPTY: OrganizationView = {
  workers: [],
  needs: [],
  covered: [],
  unfillable: [],
  hints: [],
  pendingElsewhere: 0,
  taskTitles: {},
}

/** `count` advisory edges, so the collapsed case has something to collapse. */
const hints = (count: number): OrganizationView['hints'] =>
  Array.from({ length: count }, (_unused, index) => ({
    slaveId: 's3',
    text: `Consult somebody about thing ${String(index)}.`,
    targetTemplateName: null,
    capability: null,
    capabilityLabel: null,
  }))

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(view), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

describe('OrganizationClient', () => {
  it('renders one row per worker with kind, capabilities, why and what they are doing', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    expect(within(screen.getByTestId('organization-rows')).getAllByTestId('data-table-row').length).toBe(3)
    expect(screen.getByTestId('organization-row-s3')).toBeTruthy()
    expect(screen.getByTestId('organization-kind-s3').textContent).toBe('project')
    expect(screen.getByTestId('organization-why-s3').textContent).toBe(
      'Hired for security.application because the board needs it',
    )
    expect(screen.getByTestId('organization-doing-s1').textContent).toBe('Working')
    expect(screen.getByTestId('organization-doing-s2').textContent).toBe('Idle')
  })

  // `docs/ia.md` rule 3: a surface may print a label, and the raw value stays reachable.
  it('shows capabilities as labels, with the key in the title attribute', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    const chip = screen.getAllByTestId('capability-chip')[0]
    expect(chip?.textContent).toBe('Application security')
    expect(chip?.getAttribute('title')).toBe('security.application')
  })

  it('says so plainly when a worker provides nothing the taxonomy knows', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    const row = screen.getByTestId('organization-row-s3')
    expect(within(row).queryAllByTestId('capability-chip')).toHaveLength(0)
    expect(row.textContent).toContain('no capabilities recorded')
  })

  it('lists what the board needs, with the pending proposal answerable in place', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    expect(screen.getByTestId('organization-needs')).toBeTruthy()
    const need = screen.getByTestId('organization-need-security.application')
    expect(need.textContent).toContain('Application security')
    expect(need.textContent).toContain('2 ready tasks')
    expect(screen.getByTestId('supervisor-proposal')).toBeTruthy()
    expect(screen.getByTestId('supervisor-approve')).toBeTruthy()
  })

  it('approves through the route that already exists, then re-reads this page', async () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    fireEvent.click(screen.getByTestId('supervisor-approve'))
    await waitFor(() =>
      expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
        '/api/w/w1/supervisor/decisions/d1/approve',
        '/api/w/w1/organization',
      ]),
    )
  })

  it('says plainly when nobody anywhere can do something', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    expect(screen.getByTestId('organization-unfillable').textContent).toContain('iOS')
  })

  it('shows a collaboration hint as advice, and says it is advice', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    const hint = screen.getByTestId('organization-hint')
    expect(hint.textContent).toContain('Consult the Gate Platform Builder')
    expect(screen.getByTestId('organization-advice').textContent).toContain('advice')
  })

  // Fix round 1, Important: the chip above this line reads `API design`, and the line under it read
  // `backend.api-design`. One capability, one word for it, wherever it is shown.
  it('names the hint\'s capability in words, with the key only in an attribute', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    const hint = screen.getByTestId('organization-hint')
    expect(hint.textContent).toContain('API design')
    expect(hint.textContent).not.toContain('backend.api-design')
    expect(hint.getAttribute('data-capability')).toBe('backend.api-design')
  })

  // Fix round 1, minor 6: a persona with thirty handoff sentences would otherwise print thirty
  // lines under a roster of three.
  it('folds the advice away when there is more than a handful of it', () => {
    render(<OrganizationClient workspaceId="w1" initial={{ ...view, hints: hints(6) }} />)
    expect(screen.queryAllByTestId('organization-hint')).toHaveLength(0)
    const group = screen.getAllByTestId('details-group').find((node) => node.getAttribute('data-group') === 'collaboration')
    expect(group?.getAttribute('data-open')).toBe('false')

    fireEvent.click(within(group as HTMLElement).getByRole('button'))
    expect(screen.getAllByTestId('organization-hint')).toHaveLength(6)
  })

  it('leaves a handful of advice open, so a short list needs no click', () => {
    render(<OrganizationClient workspaceId="w1" initial={{ ...view, hints: hints(5) }} />)
    expect(screen.getAllByTestId('organization-hint')).toHaveLength(5)
  })

  // Fix round 1, nit 7: the caption IS the section label, rather than a span wrapped around one.
  it('puts the advice caption on the section label itself', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    const caption = screen.getByTestId('organization-advice')
    expect(caption.className).toContain('font-mono')
    expect(within(caption).queryByTestId('section-label')).toBeNull()
  })

  // Fix round 1, minor 4: a proposal whose capability somebody has since been given a role for is
  // shown by no need row, and is still waiting on a human.
  it('says how many staffing proposals are waiting somewhere this page cannot show them', () => {
    render(<OrganizationClient workspaceId="w1" initial={{ ...view, pendingElsewhere: 2 }} />)
    const line = screen.getByTestId('organization-pending-elsewhere')
    expect(line.textContent).toContain('2 staffing proposals')
    expect(line.textContent).toContain('Overview')
  })

  it('says nothing about proposals elsewhere when there are none', () => {
    render(<OrganizationClient workspaceId="w1" initial={view} />)
    expect(screen.queryByTestId('organization-pending-elsewhere')).toBeNull()
  })

  it('shows the elsewhere line even on a project with no needs of its own', () => {
    render(<OrganizationClient workspaceId="w1" initial={{ ...view, needs: [], pendingElsewhere: 1 }} />)
    expect(screen.getByTestId('organization-pending-elsewhere').textContent).toContain('1 staffing proposal')
  })

  it('renders an empty project without pretending anything is wrong', () => {
    render(<OrganizationClient workspaceId="w1" initial={EMPTY} />)
    expect(screen.getByTestId('organization-empty')).toBeTruthy()
    expect(screen.queryByTestId('organization-needs')).toBeNull()
    expect(screen.queryByTestId('organization-unfillable')).toBeNull()
  })
})
