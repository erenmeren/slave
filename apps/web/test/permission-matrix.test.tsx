// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERMISSION_KINDS } from '@slave-of-ai/domain'
import { PermissionMatrix } from '../src/components/PermissionMatrix.js'
import type { PermissionRow, PermissionSection } from '../src/server/settings.js'

/**
 * The Settings permission matrix, in the vocabulary M52 R1 gave it.
 *
 * Its own file from M52 Task 5: the component had no test of its own -- its cases lived in
 * `settings-page.test.tsx` beside four unrelated components, and its behaviour past the glyphs was
 * covered only by `gate:m16-chrome`'s read of `data-mode`. It is now the surface that writes a
 * permission, in three states, against a route with the kind in its path; that is a file's worth.
 */

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

function row(slaveId: string, over: Partial<Record<string, 'allow' | 'deny' | null>> = {}): PermissionRow {
  return {
    slaveId,
    name: 'Alex',
    role: 'backend',
    cells: PERMISSION_KINDS.map((kind) => ({ kind, mode: over[kind] ?? null })),
  }
}

const SECTIONS: readonly PermissionSection[] = [
  {
    workspaceId: 'workspace-1',
    workspaceName: 'Checkout Platform',
    rows: [row('slave-1', { read_repo: 'allow', write_repo: 'deny', network_fetch: 'allow' })],
  },
]

describe('PermissionMatrix (M52 R7)', () => {
  beforeEach(() => {
    routerRefresh.mockClear()
  })

  it('has one column per operation, printing the WORD with the key on data-kind', () => {
    render(<PermissionMatrix sections={SECTIONS} />)
    const columns = screen.getAllByTestId('perm-column')
    expect(columns.map((column) => column.textContent)).toEqual([
      'Read the repository',
      'Write source',
      'Run commands',
      'Fetch over the network',
      'Read a secret',
      'Deploy a release',
    ])
    expect(columns.map((column) => column.getAttribute('data-kind'))).toEqual([...PERMISSION_KINDS])
    expect(columns.map((column) => column.getAttribute('title'))).toEqual([...PERMISSION_KINDS])
  })

  it('keeps the three glyphs and their data-mode, which gate:m16 reads', () => {
    render(<PermissionMatrix sections={SECTIONS} />)
    expect(screen.getByTestId('perm-cell-slave-1-network_fetch').getAttribute('data-mode')).toBe('allow')
    expect(screen.getByTestId('perm-cell-slave-1-read_secret').getAttribute('data-mode')).toBe('unset')
    expect(screen.getByTestId('perm-cell-slave-1-write_repo').getAttribute('data-mode')).toBe('deny')
    expect(screen.getByTestId('perm-cell-slave-1-network_fetch').textContent).toBe('✓')
    expect(screen.getByTestId('perm-cell-slave-1-write_repo').textContent).toBe('✕')
    expect(screen.getByTestId('perm-cell-slave-1-read_secret').textContent).toBe('–')
  })

  it('distinguishes an unset cell from an explicit deny in its title, and names the operation', () => {
    render(<PermissionMatrix sections={SECTIONS} />)
    expect(screen.getByTestId('perm-cell-slave-1-read_secret').getAttribute('title')).toBe('not set')
    expect(screen.getByTestId('perm-cell-slave-1-write_repo').getAttribute('title')).toBe('denied')
    // The accessible name is the WORD, never the key: this is the only text a screen reader gets
    // off a cell whose visible content is one glyph.
    expect(screen.getByTestId('perm-cell-slave-1-write_repo').getAttribute('aria-label')).toBe(
      'Alex · Write source · denied',
    )
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

    it('PUTs to the scoped route, with the kind in the PATH and only the mode in the body', async (): Promise<void> => {
      render(<PermissionMatrix sections={SECTIONS} />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('perm-cell-slave-1-read_secret'))
      })
      expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/w/workspace-1/slaves/slave-1/permissions/read_secret')
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('PUT')
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ mode: 'allow' })
      expect(routerRefresh).toHaveBeenCalled()
    })

    // Three clicks, three requests. The rows differ rather than the clicks repeating: this grid is
    // driven by its props and refetched by `router.refresh()`, so the three states of one cell are
    // three renders in production and three rows here.
    it('cycles unset → allow → deny → unset, so a person can take a decision back from the grid', async (): Promise<void> => {
      render(
        <PermissionMatrix
          sections={[
            {
              workspaceId: 'workspace-1',
              workspaceName: 'Checkout Platform',
              rows: [
                row('unset-one'),
                row('allowed-one', { read_secret: 'allow' }),
                row('denied-one', { read_secret: 'deny' }),
              ],
            },
          ]}
        />,
      )

      await act(async () => {
        fireEvent.click(screen.getByTestId('perm-cell-unset-one-read_secret'))
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('perm-cell-allowed-one-read_secret'))
      })
      await act(async () => {
        fireEvent.click(screen.getByTestId('perm-cell-denied-one-read_secret'))
      })

      expect(fetchMock.mock.calls.map((call) => [call[0], call[1]?.method, call[1]?.body])).toEqual([
        ['/api/w/workspace-1/slaves/unset-one/permissions/read_secret', 'PUT', JSON.stringify({ mode: 'allow' })],
        ['/api/w/workspace-1/slaves/allowed-one/permissions/read_secret', 'PUT', JSON.stringify({ mode: 'deny' })],
        // A revoke carries NO body: the path names the cell and DELETE is the whole verb.
        ['/api/w/workspace-1/slaves/denied-one/permissions/read_secret', 'DELETE', undefined],
      ])
    })

    it('shows a refusal verbatim without refreshing', async (): Promise<void> => {
      fetchMock.mockImplementationOnce(
        async () =>
          new Response(JSON.stringify({ error: 'a permission must name one of the six operations' }), { status: 409 }),
      )
      render(<PermissionMatrix sections={SECTIONS} />)
      await act(async () => {
        fireEvent.click(screen.getByTestId('perm-cell-slave-1-read_repo'))
      })
      expect(screen.getByRole('alert').textContent).toBe('a permission must name one of the six operations')
      expect(routerRefresh).not.toHaveBeenCalled()
    })
  })

  it('says what the matrix means NOW, and no longer says it is unenforced', () => {
    render(<PermissionMatrix sections={SECTIONS} />)
    const caption = screen.getByTestId('perm-caption')
    expect(caption.textContent).not.toContain('not yet enforced')
    expect(caption.textContent).toContain('Anything not granted is refused')
  })

  // Fix round 1, review Minor 5 / the plan's dropped caveat. The deleted per-section paragraph said
  // "The three shell-backed capabilities deny the shell tool as a whole" -- obsolete as written
  // (the six kinds map to distinct tool names now) but true in what it was warning about: the
  // caption asserts "Anything not granted is refused", which holds at TOOL DISPATCH and not at
  // EFFECT, because `run_commands` still grants `Bash` and command strings are not inspected
  // (M18's ruling, unchanged by this milestone).
  it('says the shell grant is the coarse one, so the caption is not read as a promise about effect', () => {
    render(<PermissionMatrix sections={SECTIONS} />)
    const note = screen.getByTestId('perm-note').textContent ?? ''
    expect(note).toContain('is the coarse one')
    expect(note).toContain('what a command does there is not inspected')
    expect(note).toContain('Run commands')
  })

  it('says the Cursor limitation and the brokered-operation fact, in the copy rather than implicitly', () => {
    render(<PermissionMatrix sections={SECTIONS} />)
    expect(screen.getByTestId('perm-note').textContent).toContain('On Cursor only the shell is enforced')
    expect(screen.getByTestId('perm-note').textContent).toContain('a brokered operation, not a tool')
    // E14: the section no longer carries a second caption contradicting the first.
    expect(screen.queryByText(/not yet enforced/u)).toBeNull()
    expect(screen.queryByText(/Read secrets/u)).toBeNull()
  })

  // Fix round 1, finding 2 (M14): the matrix used to list every Slave in the database with nothing
  // to say which project each belonged to -- two projects materialized from one roster produced
  // indistinguishable duplicate "Alex · backend" rows.
  it('renders one section per workspace, so same-named slaves in two projects stay apart', () => {
    render(
      <PermissionMatrix
        sections={[
          { workspaceId: 'w1', workspaceName: 'Checkout Platform', rows: [row('a1', { read_repo: 'allow' })] },
          { workspaceId: 'w2', workspaceName: 'Ledger', rows: [row('a2', { read_repo: 'deny' })] },
        ]}
      />,
    )

    const first = screen.getByTestId('permission-matrix-w1')
    const second = screen.getByTestId('permission-matrix-w2')
    expect(within(first).getByText('Checkout Platform')).toBeTruthy()
    expect(within(second).getByText('Ledger')).toBeTruthy()
    expect(within(first).getByTestId('perm-cell-a1-read_repo').textContent).toBe('✓')
    expect(within(second).getByTestId('perm-cell-a2-read_repo').textContent).toBe('✕')
    expect(within(first).queryByTestId('perm-cell-a2-read_repo')).toBeNull()
  })

  it('writes each section against ITS OWN workspace, never the first one on the page', async (): Promise<void> => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(
      <PermissionMatrix
        sections={[
          { workspaceId: 'w1', workspaceName: 'Checkout Platform', rows: [row('a1')] },
          { workspaceId: 'w2', workspaceName: 'Ledger', rows: [row('a2')] },
        ]}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('perm-cell-a2-read_secret'))
    })
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/w/w2/slaves/a2/permissions/read_secret')
    vi.unstubAllGlobals()
  })

  it('says which workspace has no slaves rather than dropping its section', () => {
    render(<PermissionMatrix sections={[{ workspaceId: 'w9', workspaceName: 'Fresh', rows: [] }]} />)
    expect(screen.getByTestId('permission-matrix-w9')).toBeTruthy()
    expect(screen.getByTestId('perm-empty').textContent).toBe('no slaves yet')
    expect(screen.getByTestId('perm-caption')).toBeTruthy()
  })

  it('says so when there is no project at all', () => {
    render(<PermissionMatrix sections={[]} />)
    expect(screen.getByTestId('perm-no-workspace').textContent).toBe('no projects yet')
  })
})
