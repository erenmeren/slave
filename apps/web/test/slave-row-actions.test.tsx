// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlaveRowActions } from '../src/components/SlaveRowActions.js'

const routerRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh }),
}))

describe('SlaveRowActions', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    routerRefresh.mockClear()
  })

  it('PUTs the new name on blur and refreshes on success', async () => {
    render(<SlaveRowActions slaveId="wk1" name="Alex" role="backend" runCount={0} />)

    fireEvent.click(screen.getByTestId('slave-name-edit'))
    fireEvent.change(screen.getByTestId('slave-name-input'), { target: { value: 'Jordan' } })
    await act(async () => {
      fireEvent.blur(screen.getByTestId('slave-name-input'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/slaves/wk1/name',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'Jordan' }) }),
    )
    expect(routerRefresh).toHaveBeenCalled()
    // The field collapses back to the button on a successful commit.
    expect(screen.getByTestId('slave-name-edit')).toBeTruthy()
  })

  it('PUTs the new name on Enter, without waiting for blur', async () => {
    render(<SlaveRowActions slaveId="wk1" name="Alex" role="backend" runCount={0} />)

    fireEvent.click(screen.getByTestId('slave-name-edit'))
    fireEvent.change(screen.getByTestId('slave-name-input'), { target: { value: 'Jordan' } })
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('slave-name-input'), { key: 'Enter' })
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/slaves/wk1/name',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'Jordan' }) }),
    )
  })

  it('PUTs the new role on blur and refreshes on success', async () => {
    render(<SlaveRowActions slaveId="wk1" name="Alex" role="backend" runCount={0} />)

    fireEvent.click(screen.getByTestId('slave-role-edit'))
    fireEvent.change(screen.getByTestId('slave-role-input'), { target: { value: 'frontend' } })
    await act(async () => {
      fireEvent.blur(screen.getByTestId('slave-role-input'))
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/slaves/wk1/role',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ role: 'frontend' }) }),
    )
    expect(routerRefresh).toHaveBeenCalled()
  })

  it('deletes only after a second click -- the DangerConfirm two-step, naming the run count', async () => {
    render(<SlaveRowActions slaveId="wk1" name="Alex" role="backend" runCount={14} />)

    fireEvent.click(screen.getByTestId('slave-delete'))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByTestId('slave-delete-confirm').textContent).toBe('deletes Alex and 14 runs of history')

    await act(async () => {
      fireEvent.click(screen.getByTestId('slave-delete-confirm'))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/slaves/wk1', expect.objectContaining({ method: 'DELETE' }))
    expect(routerRefresh).toHaveBeenCalled()
  })

  // M27 final review, ruling R17. Every other confirm assertion in the suite uses a count of 14,
  // 3 or 4 — none of which can tell `${n} runs` from a pluralisation rule. One is the count that
  // can, and a confirm that says "1 runs" reads like a bug in the thing about to delete your data.
  it('says "1 run", not "1 runs", when exactly one run would go', () => {
    render(<SlaveRowActions slaveId="wk1" name="Alex" role="backend" runCount={1} />)

    fireEvent.click(screen.getByTestId('slave-delete'))
    expect(screen.getByTestId('slave-delete-confirm').textContent).toBe('deletes Alex and 1 run of history')
  })

  it('cancels the delete confirm without ever calling fetch', () => {
    render(<SlaveRowActions slaveId="wk1" name="Alex" role="backend" runCount={0} />)

    fireEvent.click(screen.getByTestId('slave-delete'))
    fireEvent.click(screen.getByTestId('slave-delete-cancel'))

    expect(screen.queryByTestId('slave-delete-confirm')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shows a refusal inline without refreshing, on either edit', async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'the name "Jordan" is already taken' }), { status: 409 }),
    )
    render(<SlaveRowActions slaveId="wk1" name="Alex" role="backend" runCount={0} />)

    fireEvent.click(screen.getByTestId('slave-name-edit'))
    fireEvent.change(screen.getByTestId('slave-name-input'), { target: { value: 'Jordan' } })
    await act(async () => {
      fireEvent.blur(screen.getByTestId('slave-name-input'))
    })

    expect(screen.getByRole('alert').textContent).toBe('the name "Jordan" is already taken')
    expect(routerRefresh).not.toHaveBeenCalled()
  })

  it('shows a refusal on a blocked delete, and leaves the row in place', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ error: 'slave wk1 has 1 live run(s); wait for them to finish or stop them first' }), {
          status: 409,
        }),
    )
    render(<SlaveRowActions slaveId="wk1" name="Alex" role="backend" runCount={2} />)

    fireEvent.click(screen.getByTestId('slave-delete'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('slave-delete-confirm'))
    })

    expect(screen.getByTestId('slave-delete-error').textContent).toBe(
      'slave wk1 has 1 live run(s); wait for them to finish or stop them first',
    )
    expect(routerRefresh).not.toHaveBeenCalled()
  })

  it('a catalog row deletes through /api/org/slaves/:id', async () => {
    render(<SlaveRowActions slaveId="wk1" name="Sam" role="backend" runCount={0} catalog={{ companySlaveId: 'cs1' }} />)

    fireEvent.click(screen.getByTestId('catalog-slave-delete'))
    expect(screen.getByTestId('catalog-slave-delete-confirm').textContent).toBe('deletes Sam from the catalog; project copies stay')

    await act(async () => {
      fireEvent.click(screen.getByTestId('catalog-slave-delete-confirm'))
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/org/slaves/cs1', expect.objectContaining({ method: 'DELETE' }))
    expect(routerRefresh).toHaveBeenCalled()
  })
})
