import { describe, expect, it, vi } from 'vitest'

vi.mock('@slave-of-ai/control', async () => {
  const actual = await vi.importActual<typeof import('@slave-of-ai/control')>('@slave-of-ai/control')
  return { ...actual, listProviderModels: vi.fn(async () => ({ models: [{ id: 'opus', label: 'opus' }], source: 'static' })) }
})

const { GET } = await import('../../src/app/api/providers/[kind]/models/route.js')

describe('GET /api/providers/[kind]/models', () => {
  it('serves the listing for a known kind', async () => {
    const response = await GET(new Request('http://test/api'), { params: Promise.resolve({ kind: 'claude_code' }) })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { source: string }).source).toBe('static')
  })

  it('404s an unknown kind, naming it', async () => {
    const response = await GET(new Request('http://test/api'), { params: Promise.resolve({ kind: 'gemini' }) })
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('gemini')
  })
})
