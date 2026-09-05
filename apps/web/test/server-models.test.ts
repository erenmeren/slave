import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listProviderModels = vi.fn()
vi.mock('@slave-of-ai/control', async () => {
  const actual = await vi.importActual<typeof import('@slave-of-ai/control')>('@slave-of-ai/control')
  return { ...actual, listProviderModels }
})

const { clearModelCache, listModelsFor } = await import('../src/server/models.js')

const OK = { models: [{ id: 'auto', label: 'Auto', default: true as const }], source: 'account' as const }
const FAILED = { models: [], source: 'account' as const, error: 'not logged in' }

describe('listModelsFor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearModelCache()
    listProviderModels.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('reads once per kind and serves the cache for five minutes', async () => {
    listProviderModels.mockResolvedValue(OK)
    expect(await listModelsFor('cursor')).toEqual(OK)
    expect(await listModelsFor('cursor')).toEqual(OK)
    expect(listProviderModels).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5 * 60_000 + 1)
    await listModelsFor('cursor')
    expect(listProviderModels).toHaveBeenCalledTimes(2)
  })

  it('caches a failed read for thirty seconds only', async () => {
    listProviderModels.mockResolvedValue(FAILED)
    await listModelsFor('cursor')
    await listModelsFor('cursor')
    expect(listProviderModels).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(30_000 + 1)
    await listModelsFor('cursor')
    expect(listProviderModels).toHaveBeenCalledTimes(2)
  })

  it('refresh bypasses the cache and replaces it', async () => {
    listProviderModels.mockResolvedValueOnce(FAILED).mockResolvedValueOnce(OK)
    await listModelsFor('cursor')
    expect(await listModelsFor('cursor', { refresh: true })).toEqual(OK)
    expect(await listModelsFor('cursor')).toEqual(OK)
    expect(listProviderModels).toHaveBeenCalledTimes(2)
  })

  it('passes the SLAVEOFAI_CURSOR_BIN override through', async () => {
    vi.stubEnv('SLAVEOFAI_CURSOR_BIN', '/opt/cursor-agent')
    listProviderModels.mockResolvedValue(OK)
    await listModelsFor('cursor')
    expect(listProviderModels).toHaveBeenCalledWith('cursor', { cursorCommand: '/opt/cursor-agent' })
    vi.unstubAllEnvs()
  })

  it('shares one CLI run for callers that overlap before the first read settles', async () => {
    let resolve: (value: typeof OK) => void = () => {}
    const deferred = new Promise<typeof OK>((res) => {
      resolve = res
    })
    listProviderModels.mockReturnValue(deferred)

    const first = listModelsFor('cursor')
    const second = listModelsFor('cursor')
    resolve(OK)
    expect(await first).toEqual(OK)
    expect(await second).toEqual(OK)
    expect(listProviderModels).toHaveBeenCalledTimes(1)
  })
})
