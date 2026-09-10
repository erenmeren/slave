import { describe, expect, it } from 'vitest'
import { parsePlanGraph } from '../../src/planning/graph.js'

describe('parsePlanGraph', () => {
  it('(a) parses a bare valid 3-task graph with a chain; dependsOn is defaulted for the root', () => {
    const text = JSON.stringify({
      tasks: [
        { key: 'A', title: 'Set up schema', description: 'Create the schema', role: 'backend' },
        { key: 'B', title: 'Build API', description: 'Build the API', role: 'backend', dependsOn: ['A'] },
        { key: 'C', title: 'Build UI', description: 'Build the UI', role: 'frontend', dependsOn: ['B'] },
      ],
    })
    const result = parsePlanGraph(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tasks).toHaveLength(3)
      const root = result.value.tasks.find((task) => task.key === 'A')
      expect(root?.dependsOn).toEqual([])
    }
  })

  it('(b) parses a graph wrapped in prose and a ```json fence', () => {
    const graph = {
      tasks: [
        { key: 'A', title: 'A', description: 'desc A', role: 'dev' },
        { key: 'B', title: 'B', description: 'desc B', role: 'dev', dependsOn: ['A'] },
      ],
    }
    const text = `Here is my plan:\n\`\`\`json\n${JSON.stringify(graph)}\n\`\`\`\nLet me know what you think!`
    const result = parsePlanGraph(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tasks).toHaveLength(2)
    }
  })

  it('(c) when TWO zod-valid graphs exist, the last one wins', () => {
    const first = { tasks: [{ key: 'A', title: 'First draft', description: 'd', role: 'dev' }] }
    const second = { tasks: [{ key: 'Z', title: 'Final draft', description: 'd', role: 'dev' }] }
    const text = `${JSON.stringify(first)} on second thought: ${JSON.stringify(second)}`
    const result = parsePlanGraph(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.tasks).toHaveLength(1)
      expect(result.value.tasks[0]?.key).toBe('Z')
    }
  })

  it('(d) rejects duplicate task keys, naming the key', () => {
    const text = JSON.stringify({
      tasks: [
        { key: 'A', title: 'One', description: 'd', role: 'dev' },
        { key: 'A', title: 'Two', description: 'd', role: 'dev' },
      ],
    })
    const result = parsePlanGraph(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('A')
    }
  })

  it('(e) rejects a dependsOn entry naming an unknown key', () => {
    const text = JSON.stringify({
      tasks: [{ key: 'A', title: 'One', description: 'd', role: 'dev', dependsOn: ['ghost'] }],
    })
    const result = parsePlanGraph(text)
    expect(result.ok).toBe(false)
  })

  it('(f) rejects a task that depends on itself', () => {
    const text = JSON.stringify({
      tasks: [{ key: 'A', title: 'One', description: 'd', role: 'dev', dependsOn: ['A'] }],
    })
    const result = parsePlanGraph(text)
    expect(result.ok).toBe(false)
  })

  it('(g) rejects a 3-node dependency cycle, error contains "cycle"', () => {
    const text = JSON.stringify({
      tasks: [
        { key: 'A', title: 'One', description: 'd', role: 'dev', dependsOn: ['C'] },
        { key: 'B', title: 'Two', description: 'd', role: 'dev', dependsOn: ['A'] },
        { key: 'C', title: 'Three', description: 'd', role: 'dev', dependsOn: ['B'] },
      ],
    })
    const result = parsePlanGraph(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('cycle')
    }
  })

  it('(h) rejects an empty tasks array', () => {
    const text = JSON.stringify({ tasks: [] })
    const result = parsePlanGraph(text)
    expect(result.ok).toBe(false)
  })

  it('(i) rejects 21 tasks', () => {
    const tasks = Array.from({ length: 21 }, (_, i) => ({
      key: `T${i}`,
      title: `Task ${i}`,
      description: 'd',
      role: 'dev',
    }))
    const text = JSON.stringify({ tasks })
    const result = parsePlanGraph(text)
    expect(result.ok).toBe(false)
  })

  it('(j) rejects text with no JSON at all, with the exact fallback message', () => {
    const text = 'This is plain text with no JSON in it whatsoever.'
    const result = parsePlanGraph(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('no JSON object with { "tasks": [...] } found in the planning output')
    }
  })

  it('(k) a zod-valid graph with a cycle and nothing after it is rejected, not skipped for an earlier valid graph', () => {
    const earlierValid = { tasks: [{ key: 'A', title: 'Earlier valid draft', description: 'd', role: 'dev' }] }
    const laterCyclic = {
      tasks: [
        { key: 'X', title: 'X', description: 'd', role: 'dev', dependsOn: ['Y'] },
        { key: 'Y', title: 'Y', description: 'd', role: 'dev', dependsOn: ['X'] },
      ],
    }
    const text = `${JSON.stringify(earlierValid)} but the real plan is: ${JSON.stringify(laterCyclic)}`
    const result = parsePlanGraph(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('cycle')
    }
  })
})

describe('parsePlanGraph -- capabilities (M47 R3)', () => {
  it('parses a task with capabilities and no role', () => {
    const out = parsePlanGraph('{"tasks":[{"key":"a","title":"t","description":"d","capabilities":["security.application"]}]}')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.tasks[0]?.role).toBeUndefined()
    expect(out.value.tasks[0]?.capabilities).toEqual(['security.application'])
  })

  // The whole compatibility claim, in one assertion: `plan-graph.ndjson` and every graph a model
  // wrote before this milestone still parse, and read back as "no capabilities".
  it('parses a task with a role and no capabilities, exactly as before', () => {
    const out = parsePlanGraph('{"tasks":[{"key":"a","title":"t","description":"d","role":"backend","dependsOn":[]}]}')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.value.tasks[0]?.role).toBe('backend')
    expect(out.value.tasks[0]?.capabilities).toEqual([])
  })

  it('rejects a task that names neither', () => {
    const out = parsePlanGraph('{"tasks":[{"key":"a","title":"t","description":"d"}]}')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('neither a role nor a capability')
  })
})

describe('parsePlanGraph -- the capability cap is STRUCTURAL (fix round 1)', () => {
  const keys = Array.from({ length: 11 }, (_v, i) => `qa.k${String(i)}`)

  // A shape-level `.max(10)` made an over-capped graph fall back to an earlier candidate object in
  // the same message -- silently executing a draft nobody signed off on. A named structural error
  // is what the file's other limits do.
  it('rejects eleven capabilities by name rather than falling back to an earlier draft', () => {
    const text = [
      JSON.stringify({ tasks: [{ key: 'a', title: 't', description: 'd', role: 'backend' }] }),
      JSON.stringify({ tasks: [{ key: 'a', title: 't', description: 'd', capabilities: keys }] }),
    ].join('\n')
    const out = parsePlanGraph(text)
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.error).toContain('more than 10 capabilities')
  })

  it('accepts exactly ten', () => {
    const out = parsePlanGraph(
      JSON.stringify({ tasks: [{ key: 'a', title: 't', description: 'd', capabilities: keys.slice(0, 10) }] }),
    )
    expect(out.ok).toBe(true)
  })
})
