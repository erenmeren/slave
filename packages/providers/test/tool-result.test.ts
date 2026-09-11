import { describe, expect, it } from 'vitest'
import { TOOL_ERROR_CLASSES, classifyToolError } from '../src/tool-result.js'

describe('classifyToolError', () => {
  it('only ever answers with a member of the closed list', () => {
    for (const text of ['API Error: 500', 'timed out after 120s', 'ENOENT', 'permission denied', 'weird', '', null]) {
      expect(TOOL_ERROR_CLASSES, String(text)).toContain(classifyToolError(text))
    }
  })

  it('names the four kinds a breaker reader would want to tell apart', () => {
    expect(classifyToolError('API Error: 529 overloaded')).toBe('api_error')
    expect(classifyToolError('Command timed out after 120000ms')).toBe('timeout')
    expect(classifyToolError('ENOENT: no such file or directory')).toBe('not_found')
    expect(classifyToolError('EACCES: permission denied, open ...')).toBe('permission')
  })

  it('is `other` for anything it does not recognise, and for nothing at all', () => {
    expect(classifyToolError('the tests failed')).toBe('other')
    expect(classifyToolError(null)).toBe('other')
  })

  it('never returns anything longer than the event schema’s forty-character cap', () => {
    for (const kind of TOOL_ERROR_CLASSES) expect(kind.length).toBeLessThanOrEqual(40)
  })
})
