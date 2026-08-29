// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CompanyManager } from '../src/components/CompanyManager.js'
import { SettingsClient } from '../src/components/SettingsClient.js'
import { TemplateCatalog } from '../src/components/TemplateCatalog.js'
import type { RosterCompany, RosterMemberRow } from '../src/server/org.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

function template(over: Partial<{ id: string; name: string; role: string; description: string; defaultModel: string | null }> = {}) {
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
    render(<SettingsClient templates={[template()]} companies={[{ id: 'c1', name: 'Acme Robotics' }]} roster={[company()]} />)
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
    expect(screen.getByText('—')).toBeTruthy()
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
