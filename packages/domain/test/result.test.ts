import { describe, expect, it } from 'vitest'
import { err, ok, type Result } from '../src/result.js'
import { agentId, taskId } from '../src/ids.js'

describe('Result', () => {
  it('wraps a success value', () => {
    const r: Result<number, string> = ok(42)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toBe(42)
  })

  it('wraps an error value', () => {
    const r: Result<number, string> = err('boom')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('boom')
  })
})

describe('branded ids', () => {
  it('preserves the underlying string', () => {
    expect(agentId('alex')).toBe('alex')
  })

  it('produces distinct brands that still compare by value', () => {
    expect(taskId('TASK-1')).toBe('TASK-1')
  })
})
