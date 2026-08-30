// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderKind } from '@ai-team-os/control'
import { CompanyManager } from '../src/components/CompanyManager.js'
import { DangerZone } from '../src/components/DangerZone.js'
import { PermissionMatrix } from '../src/components/PermissionMatrix.js'
import { ProviderAdapterCards } from '../src/components/ProviderAdapterCards.js'
import { SettingsClient } from '../src/components/SettingsClient.js'
import { TemplateCatalog } from '../src/components/TemplateCatalog.js'
import type { RosterCompany, RosterMemberRow } from '../src/server/org.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

function template(
  over: Partial<{
    id: string
    name: string
    role: string
    description: string
    defaultModel: string | null
    defaultProvider: ProviderKind | null
  }> = {},
) {
  return {
    id: 't1',
    name: 'Backend Engineer',
    role: 'backend',
    description: 'ships the API',
    defaultModel: 'claude-sonnet-4',
    ...over,
  }
}

function member(over: Partial<RosterMemberRow> = {}): RosterMemberRow {
  return {
    companyAgentId: 'ca1',
    name: 'Alex',
    role: 'backend',
    templateName: 'Backend Engineer',
    effectiveModel: 'claude-sonnet-4',
    modelSource: 'template',
    rosterModel: null,
    templateDefaultModel: 'claude-sonnet-4',
    effectiveProvider: 'claude_code',
    providerSource: 'template',
    workers: [],
    ...over,
  }
}

function company(over: Partial<RosterCompany> = {}): RosterCompany {
  return {
    companyId: 'c1',
    companyName: 'Acme Robotics',
    teams: [{ companyTeamId: 'ct1', teamName: 'Platform', members: [member()] }],
    ...over,
  }
}

afterEach(() => {
  routerRefresh.mockClear()
})

describe('SettingsClient', () => {
  it('renders both panels', () => {
    render(
      <SettingsClient
        templates={[template()]}
        companies={[{ id: 'c1', name: 'Acme Robotics' }]}
        roster={[company()]}
        adapters={[]}
        permissions={[]}
        workspaces={[]}
        showReseed={false}
      />,
    )
    expect(screen.getByText('Template catalog')).toBeTruthy()
    expect(screen.getByText('Companies')).toBeTruthy()
  })
})

describe('TemplateCatalog', () => {
  it('renders a row per template (name, role chip, description, default model mono)', () => {
    render(<TemplateCatalog templates={[template({ name: 'Backend Engineer', role: 'backend', description: 'ships the API', defaultModel: 'claude-sonnet-4' })]} />)
    expect(screen.getByText('Backend Engineer')).toBeTruthy()
    expect(screen.getByText('backend')).toBeTruthy()
    expect(screen.getByText('ships the API')).toBeTruthy()
    expect(screen.getByText('claude-sonnet-4')).toBeTruthy()
  })

  it('shows "—" for a template with no default model', () => {
    render(<TemplateCatalog templates={[template({ defaultModel: null })]} />)
    // Two dashes now (M12 Task 13 fix round 1, finding 3): `template()`'s default carries no
    // `defaultProvider` either, so both the model and the provider cells fall back to '—'.
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  // M12 Task 13 fix round 1, Important finding 3: `defaultProvider` reached no renderer.
  it('renders a template default provider beside its default model', () => {
    render(<TemplateCatalog templates={[template({ defaultModel: 'claude-sonnet-4', defaultProvider: 'cursor' })]} />)
    // Scoped to the table, not the form: the creation form's own provider `<select>` also
    // renders a `cursor` `<option>`.
    expect(within(screen.getByTestId('data-table')).getByText('cursor')).toBeTruthy()
  })

  describe('the creation form', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('posts the filled fields and refreshes on 200', async () => {
      render(<TemplateCatalog templates={[]} />)
      fireEvent.change(screen.getByLabelText('template name'), { target: { value: 'Frontend Engineer' } })
      fireEvent.change(screen.getByLabelText('template role'), { target: { value: 'frontend' } })
      fireEvent.change(screen.getByLabelText('template description'), { target: { value: 'ships UI' } })
      fireEvent.change(screen.getByLabelText('template default model'), { target: { value: 'claude-opus-4' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('template-submit'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/templates',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'Frontend Engineer', role: 'frontend', description: 'ships UI', defaultModel: 'claude-opus-4' }),
        }),
      )
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('omits description/defaultModel when left blank', async () => {
      render(<TemplateCatalog templates={[]} />)
      fireEvent.change(screen.getByLabelText('template name'), { target: { value: 'Frontend Engineer' } })
      fireEvent.change(screen.getByLabelText('template role'), { target: { value: 'frontend' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('template-submit'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/templates',
        expect.objectContaining({ body: JSON.stringify({ name: 'Frontend Engineer', role: 'frontend' }) }),
      )
    })

    it('shows a duplicate-name 409 refusal inline without refreshing', async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'the name "Backend Engineer" is already taken' }), { status: 409 }),
      )
      render(<TemplateCatalog templates={[]} />)
      fireEvent.change(screen.getByLabelText('template name'), { target: { value: 'Backend Engineer' } })
      fireEvent.change(screen.getByLabelText('template role'), { target: { value: 'backend' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('template-submit'))
      })

      expect(screen.getByRole('alert').textContent).toContain('the name "Backend Engineer" is already taken')
      expect(routerRefresh).not.toHaveBeenCalled()
    })

    // M12 Task 13: `defaultProvider` beside `defaultModel`, the same "never travels alone" idiom
    // `CompanyManager`'s member form uses.
    it('includes defaultProvider alongside defaultModel when both are filled in', async () => {
      render(<TemplateCatalog templates={[]} />)
      fireEvent.change(screen.getByLabelText('template name'), { target: { value: 'Frontend Engineer' } })
      fireEvent.change(screen.getByLabelText('template role'), { target: { value: 'frontend' } })
      fireEvent.change(screen.getByLabelText('template default model'), { target: { value: 'claude-opus-4' } })
      fireEvent.change(screen.getByLabelText('template default provider'), { target: { value: 'cursor' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('template-submit'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/templates',
        expect.objectContaining({
          body: JSON.stringify({
            name: 'Frontend Engineer',
            role: 'frontend',
            defaultModel: 'claude-opus-4',
            defaultProvider: 'cursor',
          }),
        }),
      )
    })

    it('omits defaultProvider when no defaultModel is given, even if a provider is selected', async () => {
      render(<TemplateCatalog templates={[]} />)
      fireEvent.change(screen.getByLabelText('template name'), { target: { value: 'Frontend Engineer' } })
      fireEvent.change(screen.getByLabelText('template role'), { target: { value: 'frontend' } })
      fireEvent.change(screen.getByLabelText('template default provider'), { target: { value: 'cursor' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('template-submit'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/templates',
        expect.objectContaining({ body: JSON.stringify({ name: 'Frontend Engineer', role: 'frontend' }) }),
      )
    })

    it('shows the model-without-provider refusal text verbatim', async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'a model must name the provider that runs it' }), { status: 409 }),
      )
      render(<TemplateCatalog templates={[]} />)
      fireEvent.change(screen.getByLabelText('template name'), { target: { value: 'Frontend Engineer' } })
      fireEvent.change(screen.getByLabelText('template role'), { target: { value: 'frontend' } })
      fireEvent.change(screen.getByLabelText('template default model'), { target: { value: 'claude-opus-4' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('template-submit'))
      })

      expect(screen.getByRole('alert').textContent).toContain('a model must name the provider that runs it')
      expect(routerRefresh).not.toHaveBeenCalled()
    })
  })
})

describe('CompanyManager', () => {
  it('shows an EmptyTile when there are no companies', () => {
    render(<CompanyManager companies={[]} roster={[]} templates={[]} />)
    expect(screen.getByTestId('empty-tile')).toBeTruthy()
    expect(screen.queryByTestId('company-row')).toBeNull()
  })

  it('renders a row per company, collapsed by default', () => {
    render(<CompanyManager companies={[{ id: 'c1', name: 'Acme Robotics' }]} roster={[company()]} templates={[]} />)
    expect(screen.getByText('Acme Robotics')).toBeTruthy()
    expect(screen.queryByTestId('company-detail')).toBeNull()
  })

  it('expanding a company shows its teams and members from the roster', () => {
    render(<CompanyManager companies={[{ id: 'c1', name: 'Acme Robotics' }]} roster={[company()]} templates={[template()]} />)

    fireEvent.click(screen.getByTestId('company-toggle'))

    const detail = screen.getByTestId('company-detail')
    expect(within(detail).getByText('Platform')).toBeTruthy()
    expect(within(detail).getByText('Alex')).toBeTruthy()
    // "Backend Engineer" appears twice inside the detail block -- once as the member's template
    // cell, once as the add-member form's template `<option>` -- so this asserts on the row's
    // own table rather than a single unique text match.
    expect(within(detail).getByTestId('data-table').textContent).toContain('Backend Engineer')

    fireEvent.click(screen.getByTestId('company-toggle'))
    expect(screen.queryByTestId('company-detail')).toBeNull()
  })

  // M12 Task 13 fix round 1, Important finding 3: a member's provider had no reader on this
  // surface either.
  it("shows a member's effective provider beside its effective model", () => {
    const m = member({ name: 'Alex', effectiveModel: 'claude-opus-4', effectiveProvider: 'cursor' })
    render(
      <CompanyManager
        companies={[{ id: 'c1', name: 'Acme Robotics' }]}
        roster={[company({ teams: [{ companyTeamId: 'ct1', teamName: 'Platform', members: [m] }] })]}
        templates={[template()]}
      />,
    )
    fireEvent.click(screen.getByTestId('company-toggle'))

    const detail = screen.getByTestId('company-detail')
    // Scoped to the member table, not the whole detail block: the add-member form's own
    // provider `<select>` (`TeamBlock`) also renders a `cursor` `<option>` inside `detail`.
    expect(within(detail).getByTestId('data-table').textContent).toContain('cursor')
  })

  describe('the company creation form', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('posts the typed name and refreshes on 200', async () => {
      render(<CompanyManager companies={[]} roster={[]} templates={[]} />)
      fireEvent.change(screen.getByLabelText('company name'), { target: { value: 'Globex' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('company-submit'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/companies',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Globex' }) }),
      )
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('shows a duplicate-name 409 refusal inline without refreshing', async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'the name "Acme Robotics" is already taken' }), { status: 409 }),
      )
      render(<CompanyManager companies={[]} roster={[]} templates={[]} />)
      fireEvent.change(screen.getByLabelText('company name'), { target: { value: 'Acme Robotics' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('company-submit'))
      })

      expect(screen.getByRole('alert').textContent).toContain('the name "Acme Robotics" is already taken')
      expect(routerRefresh).not.toHaveBeenCalled()
    })
  })

  describe('the add-team form', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('posts { companyId, name } and refreshes on 200', async () => {
      render(<CompanyManager companies={[{ id: 'c1', name: 'Acme Robotics' }]} roster={[company({ teams: [] })]} templates={[]} />)
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.change(screen.getByLabelText('team name'), { target: { value: 'Platform' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('team-submit'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/teams',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyId: 'c1', name: 'Platform' }) }),
      )
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('shows a refusal inline without refreshing', async () => {
      fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'the name "Platform" is already taken' }), { status: 409 }))
      render(<CompanyManager companies={[{ id: 'c1', name: 'Acme Robotics' }]} roster={[company({ teams: [] })]} templates={[]} />)
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.change(screen.getByLabelText('team name'), { target: { value: 'Platform' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('team-submit'))
      })

      expect(screen.getByRole('alert').textContent).toContain('the name "Platform" is already taken')
      expect(routerRefresh).not.toHaveBeenCalled()
    })
  })

  describe('the add-member form', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('posts { companyTeamId, templateId, name } (model omitted when blank) and refreshes on 200', async () => {
      render(
        <CompanyManager
          companies={[{ id: 'c1', name: 'Acme Robotics' }]}
          roster={[company({ teams: [{ companyTeamId: 'ct1', teamName: 'Platform', members: [] }] })]}
          templates={[template({ id: 'tpl1', name: 'Backend Engineer' })]}
        />,
      )
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.change(screen.getByLabelText('member template'), { target: { value: 'tpl1' } })
      fireEvent.change(screen.getByLabelText('member name'), { target: { value: 'Blair' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('member-submit'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/agents',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyTeamId: 'ct1', templateId: 'tpl1', name: 'Blair' }) }),
      )
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('includes model when filled in', async () => {
      render(
        <CompanyManager
          companies={[{ id: 'c1', name: 'Acme Robotics' }]}
          roster={[company({ teams: [{ companyTeamId: 'ct1', teamName: 'Platform', members: [] }] })]}
          templates={[template({ id: 'tpl1', name: 'Backend Engineer' })]}
        />,
      )
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.change(screen.getByLabelText('member template'), { target: { value: 'tpl1' } })
      fireEvent.change(screen.getByLabelText('member name'), { target: { value: 'Blair' } })
      fireEvent.change(screen.getByLabelText('member model'), { target: { value: 'claude-opus-4' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('member-submit'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/agents',
        expect.objectContaining({
          body: JSON.stringify({ companyTeamId: 'ct1', templateId: 'tpl1', name: 'Blair', model: 'claude-opus-4' }),
        }),
      )
    })

    it('shows a refusal inline without refreshing', async () => {
      fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'the name "Blair" is already taken' }), { status: 409 }))
      render(
        <CompanyManager
          companies={[{ id: 'c1', name: 'Acme Robotics' }]}
          roster={[company({ teams: [{ companyTeamId: 'ct1', teamName: 'Platform', members: [] }] })]}
          templates={[template({ id: 'tpl1', name: 'Backend Engineer' })]}
        />,
      )
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.change(screen.getByLabelText('member template'), { target: { value: 'tpl1' } })
      fireEvent.change(screen.getByLabelText('member name'), { target: { value: 'Blair' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('member-submit'))
      })

      expect(screen.getByRole('alert').textContent).toContain('the name "Blair" is already taken')
      expect(routerRefresh).not.toHaveBeenCalled()
    })

    // M12 Task 13, controller resolution 2: a provider select beside the model input, same idiom
    // as `TemplateCatalog`'s `defaultProvider` -- never travels without the model it names.
    it('includes the provider alongside the model when both are filled in', async () => {
      render(
        <CompanyManager
          companies={[{ id: 'c1', name: 'Acme Robotics' }]}
          roster={[company({ teams: [{ companyTeamId: 'ct1', teamName: 'Platform', members: [] }] })]}
          templates={[template({ id: 'tpl1', name: 'Backend Engineer' })]}
        />,
      )
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.change(screen.getByLabelText('member template'), { target: { value: 'tpl1' } })
      fireEvent.change(screen.getByLabelText('member name'), { target: { value: 'Blair' } })
      fireEvent.change(screen.getByLabelText('member model'), { target: { value: 'claude-opus-4' } })
      fireEvent.change(screen.getByLabelText('member provider'), { target: { value: 'cursor' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('member-submit'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/agents',
        expect.objectContaining({
          body: JSON.stringify({ companyTeamId: 'ct1', templateId: 'tpl1', name: 'Blair', model: 'claude-opus-4', provider: 'cursor' }),
        }),
      )
    })

    it('omits the provider when no model is given, even if a provider is selected', async () => {
      render(
        <CompanyManager
          companies={[{ id: 'c1', name: 'Acme Robotics' }]}
          roster={[company({ teams: [{ companyTeamId: 'ct1', teamName: 'Platform', members: [] }] })]}
          templates={[template({ id: 'tpl1', name: 'Backend Engineer' })]}
        />,
      )
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.change(screen.getByLabelText('member template'), { target: { value: 'tpl1' } })
      fireEvent.change(screen.getByLabelText('member name'), { target: { value: 'Blair' } })
      fireEvent.change(screen.getByLabelText('member provider'), { target: { value: 'cursor' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('member-submit'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/agents',
        expect.objectContaining({ body: JSON.stringify({ companyTeamId: 'ct1', templateId: 'tpl1', name: 'Blair' }) }),
      )
    })

    it('shows the model-without-provider refusal text verbatim', async () => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'a model must name the provider that runs it' }), { status: 409 }),
      )
      render(
        <CompanyManager
          companies={[{ id: 'c1', name: 'Acme Robotics' }]}
          roster={[company({ teams: [{ companyTeamId: 'ct1', teamName: 'Platform', members: [] }] })]}
          templates={[template({ id: 'tpl1', name: 'Backend Engineer' })]}
        />,
      )
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.change(screen.getByLabelText('member template'), { target: { value: 'tpl1' } })
      fireEvent.change(screen.getByLabelText('member name'), { target: { value: 'Blair' } })
      fireEvent.change(screen.getByLabelText('member model'), { target: { value: 'claude-opus-4' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('member-submit'))
      })

      expect(screen.getByRole('alert').textContent).toContain('a model must name the provider that runs it')
      expect(routerRefresh).not.toHaveBeenCalled()
    })
  })
})

describe('provider adapter cards', () => {
  it('renders the two real adapters with their version and capabilities, and the two later ones disabled', () => {
    render(
      <ProviderAdapterCards
        adapters={[
          { kind: 'claude_code', label: 'Claude Code', state: 'connected', version: '2.1.234', adapter: 'ClaudeCodeAdapter', capabilities: { gate: 'all-tools', reportsCost: true, canPauseMidRun: true }, agentsBound: 5 },
          { kind: 'codex', label: 'OpenAI Codex', state: 'later', version: null, adapter: 'CodexAdapter — planned', capabilities: null, agentsBound: 0 },
        ]}
      />,
    )
    expect(screen.getByTestId('adapter-version-claude_code').textContent).toBe('2.1.234')
    expect(screen.getByTestId('adapter-capabilities-claude_code').textContent).toContain('all-tools')
    expect(screen.getByTestId('adapter-state-codex').textContent).toBe('not configured · later')
    expect((screen.getByTestId('adapter-cta-codex') as HTMLButtonElement).disabled).toBe(true)
  })

  it('says a real adapter is not found rather than pretending it is connected', () => {
    render(
      <ProviderAdapterCards
        adapters={[{ kind: 'cursor', label: 'Cursor', state: 'not found', version: null, adapter: 'CursorAdapter', capabilities: { gate: 'all-tools', reportsCost: false, canPauseMidRun: false }, agentsBound: 0 }]}
      />,
    )
    expect(screen.getByTestId('adapter-state-cursor').textContent).toBe('not found on PATH')
  })
})

describe('the permission matrix', () => {
  function cells(over: Partial<Record<string, 'allow' | 'deny' | null>> = {}) {
    return ['repo read', 'source write', 'run tests', 'create branch', 'deploy prod', 'read secrets'].map((tool) => ({
      tool,
      mode: over[tool] ?? null,
    }))
  }

  const rows = [
    {
      workspaceId: 'w1',
      workspaceName: 'Checkout Platform',
      rows: [
        {
          agentId: 'a1',
          name: 'Alex',
          role: 'backend',
          cells: cells({ 'repo read': 'allow', 'source write': 'deny' }),
        },
      ],
    },
  ]

  it('renders the six README columns and a glyph per cell', () => {
    render(<PermissionMatrix sections={rows} />)
    expect(screen.getAllByTestId('perm-column').map((c) => c.textContent)).toEqual([
      'repo read', 'source write', 'run tests', 'create branch', 'deploy prod', 'read secrets',
    ])
    expect(screen.getByTestId('perm-cell-a1-repo read').textContent).toBe('✓')
    expect(screen.getByTestId('perm-cell-a1-source write').textContent).toBe('✕')
  })

  it('distinguishes an unset cell from an explicit deny in its title', () => {
    render(<PermissionMatrix sections={rows} />)
    expect(screen.getByTestId('perm-cell-a1-run tests').getAttribute('title')).toBe('not set')
    expect(screen.getByTestId('perm-cell-a1-source write').getAttribute('title')).toBe('denied')
  })

  it('captions the whole matrix as not yet enforced', () => {
    render(<PermissionMatrix sections={rows} />)
    expect(screen.getByTestId('perm-caption').textContent).toBe('not yet enforced at runtime')
  })

  // Fix round 1, finding 2: the matrix used to list every Agent in the database with nothing to
  // say which project each belonged to -- two projects materialized from one roster produced
  // indistinguishable duplicate "Alex · backend" rows.
  it('renders one section per workspace, so same-named agents in two projects stay apart', () => {
    render(
      <PermissionMatrix
        sections={[
          { workspaceId: 'w1', workspaceName: 'Checkout Platform', rows: [{ agentId: 'a1', name: 'Alex', role: 'backend', cells: cells({ 'repo read': 'allow' }) }] },
          { workspaceId: 'w2', workspaceName: 'Ledger', rows: [{ agentId: 'a2', name: 'Alex', role: 'backend', cells: cells({ 'repo read': 'deny' }) }] },
        ]}
      />,
    )

    const first = screen.getByTestId('permission-matrix-w1')
    const second = screen.getByTestId('permission-matrix-w2')
    expect(within(first).getByText('Checkout Platform')).toBeTruthy()
    expect(within(second).getByText('Ledger')).toBeTruthy()

    // The two same-named agents are distinct rows under distinct sections, and each cell carries
    // its OWN agent's mode.
    expect(within(first).getByTestId('perm-cell-a1-repo read').textContent).toBe('✓')
    expect(within(second).getByTestId('perm-cell-a2-repo read').textContent).toBe('✕')
    expect(within(first).queryByTestId('perm-cell-a2-repo read')).toBeNull()
  })

  it('says which workspace has no agents rather than dropping its section', () => {
    render(<PermissionMatrix sections={[{ workspaceId: 'w9', workspaceName: 'Fresh', rows: [] }]} />)
    expect(screen.getByTestId('permission-matrix-w9')).toBeTruthy()
    expect(screen.getByTestId('perm-empty').textContent).toBe('no agents yet')
    expect(screen.getByTestId('perm-caption').textContent).toBe('not yet enforced at runtime')
  })

  describe('writing a cell', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('PUTs the flipped mode on a cell click', async (): Promise<void> => {
      render(<PermissionMatrix sections={rows} />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('perm-cell-a1-repo read'))
      })
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/agents/a1/permission',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ tool: 'repo read', mode: 'deny' }) }),
      )
    })

    // An UNSET cell is not a deny: clicking it must ask for `allow`, not flip an unmade decision
    // into its opposite.
    it('PUTs allow on an unset cell, the same as on a denied one', async (): Promise<void> => {
      render(<PermissionMatrix sections={rows} />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('perm-cell-a1-run tests'))
      })
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/agents/a1/permission',
        expect.objectContaining({ body: JSON.stringify({ tool: 'run tests', mode: 'allow' }) }),
      )
    })

    it('shows a refusal verbatim without refreshing', async (): Promise<void> => {
      fetchMock.mockImplementationOnce(
        async () => new Response(JSON.stringify({ error: 'a permission must name one of the six tools' }), { status: 409 }),
      )
      render(<PermissionMatrix sections={rows} />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('perm-cell-a1-repo read'))
      })
      expect(screen.getByRole('alert').textContent).toBe('a permission must name one of the six tools')
      expect(routerRefresh).not.toHaveBeenCalled()
    })
  })
})

describe('realtime transport and the danger zone', () => {
  const two = [
    { id: 'w1', name: 'Checkout Platform', halted: false },
    { id: 'w2', name: 'Ledger', halted: true },
  ]

  it('shows SSE selected and WebSocket disabled', () => {
    render(<DangerZone workspaces={[]} showReseed={false} />)
    expect(screen.getByTestId('transport-sse').getAttribute('aria-checked')).toBe('true')
    expect((screen.getByTestId('transport-ws') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('transport-ws').textContent).toContain('later')
  })

  it('offers reset demo data only when the server said it is available', () => {
    const { rerender } = render(<DangerZone workspaces={[]} showReseed={false} />)
    expect(screen.queryByTestId('reseed-button')).toBeNull()

    rerender(<DangerZone workspaces={[]} showReseed />)
    expect(screen.getByTestId('reseed-button')).toBeTruthy()
  })

  // Fix round 1, finding 1: the stop used to VANISH on any install with two or more projects.
  // It now names its target through a selector, the same precedent Analytics carries (§5.7.9).
  it('names its target with a selector when there is more than one project', () => {
    render(<DangerZone workspaces={two} showReseed={false} />)

    const select = screen.getByTestId('danger-workspace') as HTMLSelectElement
    expect(select.getAttribute('aria-label')).toBe('danger zone workspace')
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Checkout Platform', 'Ledger'])
    // Default is the first by name -- `listProjects()` already orders them.
    expect(select.value).toBe('w1')
    expect(screen.getByTestId('emergency-stop')).toBeTruthy()
    expect(screen.queryByTestId('danger-no-workspace')).toBeNull()
  })

  it("points the stop at the SELECTED workspace, with that workspace's own halted state", async (): Promise<void> => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      render(<DangerZone workspaces={two} showReseed={false} />)

      // `w1` is not halted, so the stop is live and fires at `w1`.
      await act(async () => {
        fireEvent.click(screen.getByTestId('emergency-stop'))
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('emergency-stop-confirm'))
      })
      expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/emergency-stop', expect.objectContaining({ method: 'POST' }))

      // Switching to `w2` -- which IS halted -- carries that workspace's real state across, so the
      // button disables rather than offering to halt an already-halted project.
      fireEvent.change(screen.getByTestId('danger-workspace'), { target: { value: 'w2' } })
      expect((screen.getByTestId('emergency-stop') as HTMLButtonElement).disabled).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('falls back to the empty state only when there is no project at all', () => {
    render(<DangerZone workspaces={[]} showReseed={false} />)
    expect(screen.queryByTestId('emergency-stop')).toBeNull()
    expect(screen.queryByTestId('danger-workspace')).toBeNull()
    expect(screen.getByTestId('danger-no-workspace')).toBeTruthy()
  })
})
