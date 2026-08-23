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
