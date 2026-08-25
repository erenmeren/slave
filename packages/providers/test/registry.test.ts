import { describe, expect, it } from 'vitest'
import { buildRegistry } from '../src/index.js'

describe('buildRegistry', () => {
  it('resolves a configured kind to its adapter', () => {
    const registry = buildRegistry({ claudeCode: { command: 'claude', hookPath: '/tmp/g.sh' } })
    expect(registry.resolve('claude_code').id).toBe('claude-code')
  })

  it('refuses an unconfigured kind rather than falling back to Claude', () => {
    const registry = buildRegistry({ claudeCode: { command: 'claude', hookPath: '/tmp/g.sh' } })
    expect(() => registry.resolve('cursor')).toThrow(/cursor/)
  })
})
