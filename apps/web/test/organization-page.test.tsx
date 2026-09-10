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
    },
  ],
  taskTitles: { t1: 'Review the checkout API' },
}

const EMPTY: OrganizationView = { workers: [], needs: [], covered: [], unfillable: [], hints: [], taskTitles: {} }

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

  it('renders an empty project without pretending anything is wrong', () => {
    render(<OrganizationClient workspaceId="w1" initial={EMPTY} />)
    expect(screen.getByTestId('organization-empty')).toBeTruthy()
    expect(screen.queryByTestId('organization-needs')).toBeNull()
    expect(screen.queryByTestId('organization-unfillable')).toBeNull()
  })
})
