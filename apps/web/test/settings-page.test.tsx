// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderKind } from '@slave-of-ai/control'
import { CompanyManager } from '../src/components/CompanyManager.js'
import { DangerZone } from '../src/components/DangerZone.js'
import { clearModelSelectCache } from '../src/components/ModelSelect.js'
import { ProviderAdapterCards } from '../src/components/ProviderAdapterCards.js'
import { SettingsClient } from '../src/components/SettingsClient.js'
import { THEME_STORAGE_KEY, ThemeProvider } from '../src/components/theme/ThemeProvider.js'
import { ModeProvider } from '../src/components/mode/ModeProvider.js'
import { MODE_STORAGE_KEY } from '../src/lib/modeStorage.js'
import type { RosterCompany, RosterMemberRow } from '../src/server/org.js'

// jsdom has no `matchMedia`, and `SettingsClient` now mounts `ThemeProvider` (M57 t8: the
// Appearance section) -- copied verbatim from `theme.test.tsx`, the one place this stub already
// exists.
function installMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

type SettingsClientProps = React.ComponentProps<typeof SettingsClient>
const reposRoot = { reposRoot: null, resolved: '/home/me/projects', source: 'default' as const }

/** Every `<SettingsClient>` render in this file now needs `ThemeProvider` AND `ModeProvider` above
 *  it -- the Appearance section calls `useTheme()` and `useMode()`, either of which throws outside
 *  its own provider (M61 t1). */
function renderSettings(
  props: Omit<SettingsClientProps, 'reposRoot'> & Partial<Pick<SettingsClientProps, 'reposRoot'>>,
): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <ModeProvider>
        <SettingsClient reposRoot={reposRoot} {...props} />
      </ModeProvider>
    </ThemeProvider>,
  )
}

// M25 Task 5: a fetch mock shared by the two describes below that render a `ModelSelect` --
// branches on the URL so the same stub answers both `GET /api/providers/<kind>/models` and the
// describe's own POST endpoint.
function stubModelFetch(postBody: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith('/api/providers/')) {
      return new Response(JSON.stringify({ models: [{ id: 'opus', label: 'opus' }], source: 'static' }), { status: 200 })
    }
    return new Response(JSON.stringify(postBody), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// M25: `ModelSelect` renders its `<select>` disabled until the models listing resolves -- a
// `fireEvent.change` on a disabled select is silently dropped, so callers changing it must wait
// for it to be enabled, not just present.
async function waitForModelSelect(): Promise<HTMLSelectElement> {
  return waitFor(() => {
    const select = screen.getByTestId('model-select') as HTMLSelectElement
    expect(select.disabled).toBe(false)
    return select
  })
}

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
    catalogSlaveCount: number
  }> = {},
) {
  return {
    id: 't1',
    name: 'Backend Engineer',
    role: 'backend',
    description: 'ships the API',
    defaultModel: 'claude-sonnet-4',
    catalogSlaveCount: 0,
    ...over,
  }
}

function member(over: Partial<RosterMemberRow> = {}): RosterMemberRow {
  return {
    personId: 'ca1',
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
    projectsUsing: 0,
    teams: [{ companyTeamId: 'ct1', teamName: 'Platform', members: [member()] }],
    ...over,
  }
}

beforeEach(() => {
  installMatchMedia()
})

afterEach(() => {
  routerRefresh.mockClear()
  // Fix round 1 minor: the Appearance case's `dark` click writes `document.documentElement`'s own
  // `data-theme` attribute and `localStorage[THEME_STORAGE_KEY]` -- real global state `ThemeProvider`
  // re-reads on mount, outside this file's render container and outside vitest's own reset. The
  // `try` is `readStored`/`writeStored`'s own guard, mirrored: this runner's `localStorage` is
  // Node's own inert stub (no `installStorage()` here, unlike `theme.test.tsx`), which throws on
  // every access -- nothing was ever actually written, so nothing to remove either.
  document.documentElement.removeAttribute('data-theme')
  try {
    window.localStorage.removeItem(THEME_STORAGE_KEY)
  } catch {
    /* nothing was stored -- see above */
  }
  // Same story for `ModeProvider`'s own attribute and key (M61 t1).
  document.documentElement.removeAttribute('data-mode')
  try {
    window.localStorage.removeItem(MODE_STORAGE_KEY)
  } catch {
    /* nothing was stored -- see above */
  }
})

describe('SettingsClient', () => {
  it('renders the three panels in order, with the moved-out surfaces gone', () => {
    renderSettings({
      adapters: [],
      showReseed: false,
      mode: 'loopback-only',
      posture: 'loopback-only · no accounts · cross-site requests refused',
    })
    // `Panel` renders `PanelHeader` → `SectionLabel` as its first child when it has a title —
    // the same idiom `ProjectSettingsClient`'s "renders the four panels in order" test uses.
    const titles = screen.getAllByTestId('panel').map((p) => p.firstElementChild?.textContent?.trim().toLowerCase())
    expect(titles).toEqual(['provider adapters', 'security', 'danger zone'])

    // The permission matrix, the workspace create form, the template/company forms and the
    // transport chooser all left this page (M24 Task 5/6) — none of their surfaces render here.
    expect(screen.queryByTestId('perm-caption')).toBeNull()
    expect(screen.queryByTestId('create-workspace-form')).toBeNull()
    expect(screen.queryByTestId('template-form')).toBeNull()
    expect(screen.queryByTestId('company-form')).toBeNull()
    expect(screen.queryByTestId('danger-workspace')).toBeNull()
    expect(screen.queryByTestId('transport-sse')).toBeNull()
  })

  it('states the security posture, honestly and without controls', () => {
    renderSettings({
      adapters: [],
      showReseed: false,
      mode: 'loopback-only',
      posture: 'loopback-only · no accounts · cross-site requests refused',
    })
    const posture = screen.getByTestId('security-posture')
    expect(posture.textContent).toBe('loopback-only · no accounts · cross-site requests refused')
  })

  it('renders whatever posture the server computed (accounts mode names the user)', () => {
    renderSettings({ adapters: [], showReseed: false, mode: 'accounts', posture: 'accounts · signed in as ada · cross-site requests refused' })
    expect(screen.getByTestId('security-posture').textContent).toBe('accounts · signed in as ada · cross-site requests refused')
  })

  it('offers Logout only in accounts mode', () => {
    renderSettings({ adapters: [], showReseed: false, mode: 'loopback-only', posture: 'loopback-only · no accounts · cross-site requests refused' })
    expect(screen.queryByTestId('logout')).toBeNull()
  })

  it('Logout posts to /api/auth/logout and lands on /login', async () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { configurable: true, value: { assign, pathname: '/settings', search: '' } })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    renderSettings({ adapters: [], showReseed: false, mode: 'accounts', posture: 'accounts · signed in as ada · cross-site requests refused' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('logout'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }))
    expect(assign).toHaveBeenCalledWith('/login')
    vi.restoreAllMocks()
  })

  // M57 t8: the Appearance section, folded in beside the provider-adapter cards. `Segmented`
  // (M57 R21) owns the group's own `appearance-theme`/`appearance-theme-<id>` testids; the
  // CHOSEN mode's `data-theme-mode` rides on that SAME group element (`Segmented`'s `data`
  // passthrough), which is what lets a gate read it straight off `appearance-theme` with no
  // wrapper of this page's own to reach through.
  it('offers the three theme choices and stamps the one that is chosen', () => {
    renderSettings({ adapters: [], showReseed: false, mode: 'loopback-only', posture: 'loopback-only · no accounts · cross-site requests refused' })
    expect(screen.getByTestId('appearance-theme').getAttribute('data-theme-mode')).toBe('system')
    act((): void => {
      screen.getByTestId('appearance-theme-dark').click()
    })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(screen.getByTestId('appearance-theme').getAttribute('data-theme-mode')).toBe('dark')
  })

  // M61 t1: the mode switch's second home, directly under the theme control.
  it('offers the two mode choices and stamps the one that is chosen', () => {
    renderSettings({ adapters: [], showReseed: false, mode: 'loopback-only', posture: 'loopback-only · no accounts · cross-site requests refused' })
    act((): void => {
      screen.getByTestId('appearance-mode-developer').click()
    })
    expect(document.documentElement.dataset.mode).toBe('developer')
  })
})

/**
 * The Settings PAGE, not the client below it (M23 spec §7 F5): the one place the posture line's
 * username is filled in. Every collaborator is stubbed — the page's own job here is that it asks
 * `currentPrincipal()` and hands `postureFor(mode, username)` down.
 */
describe('SettingsPage', () => {
  const currentPrincipal = vi.fn()

  async function renderSettingsPage(): Promise<void> {
    vi.doMock('../src/server/principal.js', () => ({ currentPrincipal }))
    vi.doMock('../src/server/settings.js', () => ({
      buildProviderAdapters: async () => [],
    }))
    vi.doMock('@slave-of-ai/control', () => ({
      readInstallationSettings: async () => ({ reposRoot: null }),
      resolveReposRoot: async () => ({ root: '/home/me/projects', source: 'default' }),
    }))
    vi.doMock('../src/components/SettingsClient.js', () => ({
      SettingsClient: ({ mode, posture }: { readonly mode: string; readonly posture: string }) => (
        <div data-testid="settings-client-stub" data-mode={mode} data-posture={posture} />
      ),
    }))
    const { default: SettingsPage } = await import('../src/app/settings/page.js')
    render(await SettingsPage())
  }

  beforeEach(() => {
    vi.resetModules()
    currentPrincipal.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('names the signed-in user in the posture line', async () => {
    vi.stubEnv('SLAVEOFAI_SESSION_SECRET', '0123456789abcdef0123456789abcdef')
    currentPrincipal.mockResolvedValue({ userId: 'ada-0001', username: 'ada' })
    await renderSettingsPage()
    const stub = screen.getByTestId('settings-client-stub')
    expect(stub.getAttribute('data-mode')).toBe('accounts')
    expect(stub.getAttribute('data-posture')).toBe('accounts · signed in as ada · cross-site requests refused')
  })

  it('says "not signed in" when the cookie names a user who is gone (the revocation story)', async () => {
    vi.stubEnv('SLAVEOFAI_SESSION_SECRET', '0123456789abcdef0123456789abcdef')
    currentPrincipal.mockResolvedValue(null)
    await renderSettingsPage()
    expect(screen.getByTestId('settings-client-stub').getAttribute('data-posture')).toBe(
      'accounts · not signed in · cross-site requests refused',
    )
  })

  it('keeps the loopback line byte for byte, with no user to name', async () => {
    vi.stubEnv('SLAVEOFAI_SESSION_SECRET', '')
    currentPrincipal.mockResolvedValue(null)
    await renderSettingsPage()
    const stub = screen.getByTestId('settings-client-stub')
    expect(stub.getAttribute('data-mode')).toBe('loopback-only')
    expect(stub.getAttribute('data-posture')).toBe('loopback-only · no accounts · cross-site requests refused')
  })
})

describe('CompanyManager', () => {
  it('shows an EmptyTile when there are no companies', () => {
    render(<CompanyManager companies={[]} roster={[]} people={[]} />)
    expect(screen.getByTestId('empty-tile')).toBeTruthy()
    expect(screen.queryByTestId('company-row')).toBeNull()
  })

  it('renders a row per company, collapsed by default', () => {
    render(<CompanyManager companies={[{ id: 'c1', name: 'Acme Robotics' }]} roster={[company()]} people={[]} />)
    expect(screen.getByText('Acme Robotics')).toBeTruthy()
    expect(screen.queryByTestId('company-detail')).toBeNull()
  })

  it('expanding a company shows its teams and members from the roster', () => {
    render(<CompanyManager companies={[{ id: 'c1', name: 'Acme Robotics' }]} roster={[company()]} people={[{ personId: 'cs1', name: 'Sam' }]} />)

    fireEvent.click(screen.getByTestId('company-toggle'))

    const detail = screen.getByTestId('company-detail')
    expect(within(detail).getByText('Platform')).toBeTruthy()
    expect(within(detail).getByText('Alex')).toBeTruthy()
    // The member table's own cell, not a single unique text match: the add-member `<select>` also
    // renders names inside `detail`.
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
        people={[{ personId: 'cs1', name: 'Sam' }]}
      />,
    )
    fireEvent.click(screen.getByTestId('company-toggle'))

    const detail = screen.getByTestId('company-detail')
    // Scoped to the member table, not the whole detail block.
    expect(within(detail).getByTestId('data-table').textContent).toContain('cursor')
  })

  // M27 §5.1, R4: a member's row (`MemberRow`) reuses `SlaveRowActions`' POOL branch (M58 R16) --
  // the same `catalog-slave-delete` the Slaves table's pooled row already uses, with the same fixed
  // confirm text (no copy count -- no read provides it).
  describe('a catalog slave row', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('asks twice with the fixed confirm text, then DELETEs and refreshes', async () => {
      const m = member({ personId: 'cs1', name: 'Sam' })
      render(
        <CompanyManager
          companies={[{ id: 'c1', name: 'Acme Robotics' }]}
          roster={[company({ teams: [{ companyTeamId: 'ct1', teamName: 'Platform', members: [m] }] })]}
          people={[{ personId: 'cs1', name: 'Sam' }]}
        />,
      )
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.click(screen.getByTestId('catalog-slave-delete'))
      expect(screen.getByTestId('catalog-slave-delete-confirm').textContent).toBe(
        'takes Sam off every company roster; they keep working and keep every seat',
      )
      await act(async () => {
        fireEvent.click(screen.getByTestId('catalog-slave-delete-confirm'))
      })
      expect(fetchMock).toHaveBeenCalledWith('/api/org/slaves/cs1', expect.objectContaining({ method: 'DELETE' }))
      expect(routerRefresh).toHaveBeenCalled()
    })
  })

  // M27 §5.1: a company row gets its own `DangerConfirm` beside the toggle -- the confirm names
  // the department-template and catalog-slave counts (`listRoster`) and the assigned-project count
  // (`RosterCompany.projectsUsing`) `deleteCompany` would cascade or clear.
  describe('a company row', () => {
    let fetchMock: ReturnType<typeof vi.fn>
    const roster = [
      company({
        companyId: 'c1',
        companyName: 'Atlas Software',
        projectsUsing: 1,
        teams: [
          { companyTeamId: 'ct1', teamName: 'Backend', members: [member(), member({ personId: 'ca2', name: 'Jess' })] },
          { companyTeamId: 'ct2', teamName: 'Design', members: [member({ personId: 'ca3', name: 'Robin' })] },
        ],
      }),
    ]
    const companies = [{ id: 'c1', name: 'Atlas Software' }]

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('asks twice naming the counts, then DELETEs and refreshes', async () => {
      render(<CompanyManager companies={companies} roster={roster} people={[]} />)
      fireEvent.click(screen.getByTestId('company-delete'))
      expect(screen.getByTestId('company-delete-confirm').textContent).toBe(
        'deletes Atlas Software: 2 department templates, 3 catalog slaves; 1 project keeps its copies',
      )
      await act(async () => {
        fireEvent.click(screen.getByTestId('company-delete-confirm'))
      })
      expect(fetchMock).toHaveBeenCalledWith('/api/org/companies/c1', expect.objectContaining({ method: 'DELETE' }))
      expect(routerRefresh).toHaveBeenCalled()
    })
  })

  // M25 Task 7 (inline rename); M27 §5.1 (delete): `deleteCompanyTeam` no longer refuses a
  // non-empty department template -- it cascades the template's MEMBERSHIPS along with it --
  // so `department-template-delete` is always enabled, and its `DangerConfirm` names that cascade
  // instead of a disabled button naming a refusal that no longer exists.
  describe('a department template header row', () => {
    let fetchMock: ReturnType<typeof vi.fn>
    const roster = [
      company({
        teams: [
          { companyTeamId: 'ct1', teamName: 'Backend', members: [member(), member({ personId: 'ca2', name: 'Jess' })] },
        ],
      }),
    ]
    const companies = [{ id: 'c1', name: 'Acme Robotics' }]

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('renames a department template inline and refreshes', async () => {
      render(<CompanyManager companies={companies} roster={roster} people={[]} />)
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.click(screen.getAllByTestId('department-template-rename')[0] as HTMLButtonElement)
      fireEvent.change(screen.getByTestId('department-template-rename-input'), { target: { value: 'Platform' } })
      await act(async () => {
        fireEvent.keyDown(screen.getByTestId('department-template-rename-input'), { key: 'Enter' })
      })
      expect(fetchMock).toHaveBeenCalledWith('/api/org/teams/ct1/name', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'Platform' }) }))
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('is enabled with members, asks twice naming the catalog-slave count, then DELETEs and refreshes', async () => {
      render(<CompanyManager companies={companies} roster={roster} people={[]} />)
      fireEvent.click(screen.getByTestId('company-toggle'))
      const button = screen.getByTestId('department-template-delete') as HTMLButtonElement
      expect(button.disabled).toBe(false)
      fireEvent.click(button)
      expect(screen.getByTestId('department-template-delete-confirm').textContent).toBe(
        'deletes Backend and its 2 memberships; the slaves and the project departments stay',
      )
      await act(async () => {
        fireEvent.click(screen.getByTestId('department-template-delete-confirm'))
      })
      expect(fetchMock).toHaveBeenCalledWith('/api/org/teams/ct1', expect.objectContaining({ method: 'DELETE' }))
      expect(routerRefresh).toHaveBeenCalled()
    })
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
      render(<CompanyManager companies={[]} roster={[]} people={[]} />)
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
      render(<CompanyManager companies={[]} roster={[]} people={[]} />)
      fireEvent.change(screen.getByLabelText('company name'), { target: { value: 'Acme Robotics' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('company-submit'))
      })

      expect(screen.getByRole('alert').textContent).toContain('the name "Acme Robotics" is already taken')
      expect(routerRefresh).not.toHaveBeenCalled()
    })
  })

  describe('the add-department-template form', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('posts { companyId, name } and refreshes on 200', async () => {
      render(<CompanyManager companies={[{ id: 'c1', name: 'Acme Robotics' }]} roster={[company({ teams: [] })]} people={[]} />)
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.change(screen.getByLabelText('department name'), { target: { value: 'Platform' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('department-template-submit'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/teams',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ companyId: 'c1', name: 'Platform' }) }),
      )
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('shows a refusal inline without refreshing', async () => {
      fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'the name "Platform" is already taken' }), { status: 409 }))
      render(<CompanyManager companies={[{ id: 'c1', name: 'Acme Robotics' }]} roster={[company({ teams: [] })]} people={[]} />)
      fireEvent.click(screen.getByTestId('company-toggle'))
      fireEvent.change(screen.getByLabelText('department name'), { target: { value: 'Platform' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('department-template-submit'))
      })

      expect(screen.getByRole('alert').textContent).toContain('the name "Platform" is already taken')
      expect(routerRefresh).not.toHaveBeenCalled()
    })
  })

  // M58 R5: a department holds PEOPLE. The form picks one the installation already has; the
  // persona, the model and the provider left with the roster row -- they are the PERSON's now, and
  // Task 5's own surface is where they are edited.
  describe('the add-member form', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    const people = [
      { personId: 'p1', name: 'Blair' },
      { personId: 'p2', name: 'Rae' },
    ]

    beforeEach(() => {
      fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
      vi.stubGlobal('fetch', fetchMock)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    function renderForm(): void {
      render(
        <CompanyManager
          companies={[{ id: 'c1', name: 'Acme Robotics' }]}
          roster={[company({ teams: [{ companyTeamId: 'ct1', teamName: 'Platform', members: [] }] })]}
          people={people}
        />,
      )
      fireEvent.click(screen.getByTestId('company-toggle'))
    }

    it('offers everybody the installation has, and nothing about a persona', () => {
      renderForm()

      const select = screen.getByLabelText('member slave') as HTMLSelectElement
      expect([...select.options].map((option) => option.textContent)).toEqual(['select a slave', 'Blair', 'Rae'])
      expect(screen.queryByTestId('member-template-select')).toBeNull()
      expect(screen.queryByTestId('member-provider-select')).toBeNull()
    })

    it('joins the chosen slave into the department and refreshes on 200', async () => {
      renderForm()
      fireEvent.change(screen.getByLabelText('member slave'), { target: { value: 'p1' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('member-submit'))
      })

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/org/slaves/p1/team',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ companyTeamId: 'ct1' }) }),
      )
      expect(routerRefresh).toHaveBeenCalled()
    })

    it('cannot be submitted until somebody is chosen', () => {
      renderForm()

      expect((screen.getByTestId('member-submit') as HTMLButtonElement).disabled).toBe(true)
      fireEvent.change(screen.getByLabelText('member slave'), { target: { value: 'p2' } })
      expect((screen.getByTestId('member-submit') as HTMLButtonElement).disabled).toBe(false)
    })

    it('shows a refusal inline without refreshing', async () => {
      fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'no slave with id p1' }), { status: 404 }))
      renderForm()
      fireEvent.change(screen.getByLabelText('member slave'), { target: { value: 'p1' } })

      await act(async () => {
        fireEvent.click(screen.getByTestId('member-submit'))
      })

      expect(screen.getByRole('alert').textContent).toContain('no slave with id p1')
      expect(routerRefresh).not.toHaveBeenCalled()
    })
  })
})

describe('provider adapter cards', () => {
  it('renders the two real adapters with their version and capabilities, and the two later ones disabled', () => {
    render(
      <ProviderAdapterCards
        adapters={[
          { kind: 'claude_code', label: 'Claude Code', state: 'connected', version: '2.1.234', adapter: 'ClaudeCodeAdapter', capabilities: { gate: 'all-tools', reportsCost: true, canPauseMidRun: true }, slavesBound: 5 },
          { kind: 'codex', label: 'OpenAI Codex', state: 'later', version: null, adapter: 'CodexAdapter — planned', capabilities: null, slavesBound: 0 },
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
        adapters={[{ kind: 'cursor', label: 'Cursor', state: 'not found', version: null, adapter: 'CursorAdapter', capabilities: { gate: 'all-tools', reportsCost: false, canPauseMidRun: false }, slavesBound: 0 }]}
      />,
    )
    expect(screen.getByTestId('adapter-state-cursor').textContent).toBe('not found on PATH')
  })
})

// M52 Task 5: `describe('the permission matrix')` moved OUT of this file, whole, into
// `apps/web/test/permission-matrix.test.tsx`. The component gained a three-state write against a
// workspace-scoped route with the kind in its path, and its cases outgrew a shared file that also
// renders `CompanyManager`, `DangerZone`, `ProviderAdapterCards` and `SettingsClient`.

describe('the danger zone', () => {
  it('offers reset demo data only when the server said it is available', () => {
    // M44 R3: the reseed control is a `DangerConfirm` now, so its trigger carries the component's
    // own testid convention -- `reseed`, not `reseed-button` (`reseed-confirm`/`reseed-cancel` are
    // unchanged, because that is what `DangerConfirm` already calls them).
    const { rerender } = render(<DangerZone showReseed={false} />)
    expect(screen.queryByTestId('reseed')).toBeNull()

    rerender(<DangerZone showReseed />)
    expect(screen.getByTestId('reseed')).toBeTruthy()
  })

  // M44 Task 4 fix round 1: the two-step reseed moved out of this component and into
  // `ui/DangerConfirm`, so the BEHAVIOUR that moved is pinned here -- nothing fires on the first
  // click, the POST goes to the unchanged route on the second, and a 200 refreshes.
  it('asks twice, then POSTs /api/dev/reseed and refreshes', async (): Promise<void> => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      render(<DangerZone showReseed />)

      fireEvent.click(screen.getByTestId('reseed'))
      expect(screen.getByTestId('reseed-confirm').textContent).toBe('replace the data')
      expect(screen.getByTestId('reseed-cancel')).toBeTruthy()
      expect(fetchMock).not.toHaveBeenCalled()

      await act(async (): Promise<void> => {
        fireEvent.click(screen.getByTestId('reseed-confirm'))
      })

      expect(fetchMock).toHaveBeenCalledWith('/api/dev/reseed', expect.objectContaining({ method: 'POST' }))
      expect(routerRefresh).toHaveBeenCalled()
      // Back to the one-click trigger, and no refusal to show.
      expect(screen.getByTestId('reseed')).toBeTruthy()
      expect(screen.queryByTestId('reseed-error')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('shows a refusal in place and stays on the confirm, without refreshing', async (): Promise<void> => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'reseed is development only' }), { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      render(<DangerZone showReseed />)
      fireEvent.click(screen.getByTestId('reseed'))
      await act(async (): Promise<void> => {
        fireEvent.click(screen.getByTestId('reseed-confirm'))
      })

      expect(screen.getByTestId('reseed-error').textContent).toBe('reseed is development only')
      expect(screen.getByTestId('reseed-confirm')).toBeTruthy()
      expect(routerRefresh).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// M44 erratum E25 / M45 R5: the one page frame reaches this page too. `flush`, so it brings its
// landmark and its `page-shell` marker and none of its padding -- the frame's own classes are
// unchanged, which is what keeps `gate:m14-fidelity`'s numbers where they are.
describe('SettingsClient (M44 E25 / M45 R5)', () => {
  it('renders inside the one page shell, with its own frame classes untouched', () => {
    renderSettings({ adapters: [], showReseed: false, mode: 'loopback-only', posture: 'loopback-only · no accounts · cross-site requests refused' })
    const shell = screen.getByTestId('page-shell')
    expect(shell.className).not.toContain('p-3')
    expect(shell.querySelector(':scope > div')?.className).toBe('flex flex-col gap-4 p-4')
  })
})
