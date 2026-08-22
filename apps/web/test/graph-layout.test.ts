import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Edge, Node } from 'reactflow'

// `layout.ts` caches its ELK-instance promise in a module-scope `elkPromise` (see `getElk`) so a
// rejection from one test would otherwise leak into every test that imports the module after it
// -- `vi.resetModules()` around each case here gives `layoutGraph` a fresh module graph (and
// therefore a fresh, unpoisoned `elkPromise`) per test.
describe('layoutGraph / getElk retry after a failed elkjs load', () => {
  afterEach(() => {
    vi.doUnmock('elkjs/lib/elk.bundled.js')
    vi.resetModules()
  })

  it('a transient first-call failure does not poison a later layout -- the retry resolves with real positions', async () => {
    // Fails the *first* `new module.default()` (the same seam a dropped chunk fetch or a bad
    // constructor run would hit inside `getElk`'s `.then`), then succeeds from the second call on
    // -- exercising the fix's `.catch` resetting `elkPromise` to `null` so the next `getElk()`
    // call retries the import instead of replaying the same rejected promise forever.
    let constructAttempts = 0
    vi.doMock('elkjs/lib/elk.bundled.js', () => ({
      default: class {
        constructor() {
          constructAttempts += 1
          if (constructAttempts === 1) throw new Error('simulated chunk-load failure')
        }
        async layout(graph: { children?: { id: string }[] }): Promise<unknown> {
          return {
            ...graph,
            children: (graph.children ?? []).map((child, index) => ({ ...child, x: 50 + index * 140, y: 30 })),
          }
        }
      },
    }))
    vi.resetModules()

    const { layoutGraph } = await import('../src/components/graph/layout.js')

    const nodes: Node[] = [{ id: 'n1', type: 'agent', position: { x: 0, y: 0 }, data: {} }]
    const edges: Edge[] = []

    // First attempt: the mocked ELK constructor throws -- `layoutGraph` must reject (not silently
    // return un-positioned nodes) so the caller can surface it, rather than a poisoned cache
    // masking the failure as "no error, nodes just never moved".
    await expect(layoutGraph(nodes, edges, 'mrtree')).rejects.toThrow('simulated chunk-load failure')

    // Second attempt: without the fix, `elkPromise` would still be the same rejected promise from
    // the first call, so this would reject again with the identical error instead of laying out.
    const result = await layoutGraph(nodes, edges, 'mrtree')
    expect(result[0]?.position).toEqual({ x: 50, y: 30 })
    expect(constructAttempts).toBe(2)
  })
})
