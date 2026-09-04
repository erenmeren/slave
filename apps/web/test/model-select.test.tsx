// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelSelect, clearModelSelectCache } from '../src/components/ModelSelect.js'

const LISTING = { models: [{ id: 'auto', label: 'Auto', default: true }, { id: 'gpt-5.3-codex', label: 'Codex 5.3' }], source: 'account' }
const FAILED = { models: [], source: 'account', error: 'not logged in' }

function mockFetch(body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => clearModelSelectCache())
afterEach(() => vi.unstubAllGlobals())

describe('ModelSelect', () => {
  it('is disabled with a hint until a provider is chosen, and fetches nothing', () => {
    const fetchMock = mockFetch(LISTING)
    render(<ModelSelect provider="" value="" onChange={() => {}} ariaLabel="model" inputTestId="member-model-input" />)
    const select = screen.getByTestId('model-select') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(screen.getByText('choose a provider first')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('lists the provider models with the default marked, none first and other… last', async () => {
    const fetchMock = mockFetch(LISTING)
    render(<ModelSelect provider="cursor" value="" onChange={() => {}} ariaLabel="model" inputTestId="member-model-input" />)
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(4))
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/cursor/models')
    const labels = screen.getAllByRole('option').map((o) => o.textContent)
    expect(labels).toEqual(['— none —', 'Auto (default)', 'Codex 5.3', 'other…'])
  })

  it('emits the chosen id, and other… reveals a text input carrying the old testid', async () => {
    mockFetch(LISTING)
    const onChange = vi.fn()
    render(<ModelSelect provider="cursor" value="" onChange={onChange} ariaLabel="model" inputTestId="member-model-input" />)
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(4))

    fireEvent.change(screen.getByTestId('model-select'), { target: { value: 'gpt-5.3-codex' } })
    expect(onChange).toHaveBeenLastCalledWith('gpt-5.3-codex')

    fireEvent.change(screen.getByTestId('model-select'), { target: { value: '__other__' } })
    const input = screen.getByTestId('member-model-input') as HTMLInputElement
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { value: 'my-custom-model' } })
    expect(onChange).toHaveBeenLastCalledWith('my-custom-model')
  })

  it('falls back to the text input with a note when the listing failed', async () => {
    mockFetch(FAILED)
    render(<ModelSelect provider="cursor" value="" onChange={() => {}} ariaLabel="model" inputTestId="member-model-input" />)
    await waitFor(() => expect(screen.getByTestId('model-select-note').textContent).toContain('not logged in'))
    expect(screen.getByTestId('member-model-input')).toBeTruthy()
    expect(screen.queryByTestId('model-select')).toBeNull()
  })

  it('shows a value that is not in the list as a selected extra option, changing nothing', async () => {
    mockFetch(LISTING)
    const onChange = vi.fn()
    render(<ModelSelect provider="cursor" value="legacy-id" onChange={onChange} ariaLabel="model" inputTestId="member-model-input" />)
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(5))
    expect((screen.getByTestId('model-select') as HTMLSelectElement).value).toBe('legacy-id')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shares one request per provider across instances', async () => {
    const fetchMock = mockFetch(LISTING)
    render(
      <>
        <ModelSelect provider="cursor" value="" onChange={() => {}} ariaLabel="a" inputTestId="a-input" />
        <ModelSelect provider="cursor" value="" onChange={() => {}} ariaLabel="b" inputTestId="b-input" />
      </>,
    )
    await waitFor(() => expect(screen.getAllByTestId('model-select').length).toBe(2))
    await act(async () => {})
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
