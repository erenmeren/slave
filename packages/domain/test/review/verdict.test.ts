import { describe, expect, it } from 'vitest'
import { parseReviewVerdict } from '../../src/review/verdict.js'

describe('parseReviewVerdict', () => {
  it('(a) parses a bare JSON object', () => {
    const text = '{"verdict": "approve", "reason": "Code looks good"}'
    const result = parseReviewVerdict(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.verdict).toBe('approve')
      expect(result.value.reason).toBe('Code looks good')
    }
  })

  it('(b) parses JSON wrapped in prose and a ```json fence', () => {
    const text = `Here is my review:
\`\`\`json
{"verdict": "reject", "reason": "Missing error handling"}
\`\`\`
Thanks for reviewing!`
    const result = parseReviewVerdict(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.verdict).toBe('reject')
      expect(result.value.reason).toBe('Missing error handling')
    }
  })

  it('(c) when TWO objects exist, the last valid one wins', () => {
    const text = `{"verdict": "approve", "reason": "First"} some text {"verdict": "reject", "reason": "Second"}`
    const result = parseReviewVerdict(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.verdict).toBe('reject')
      expect(result.value.reason).toBe('Second')
    }
  })

  it('(d) rejects an object with verdict "maybe" with a message naming the failure', () => {
    const text = '{"verdict": "maybe", "reason": "Not sure"}'
    const result = parseReviewVerdict(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('verdict')
    }
  })

  it('(e) rejects text with no JSON at all', () => {
    const text = 'This is just plain text with no JSON objects'
    const result = parseReviewVerdict(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('no JSON object')
    }
  })

  it('(f) rejects an object with reason: "" (empty string)', () => {
    const text = '{"verdict": "approve", "reason": ""}'
    const result = parseReviewVerdict(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('reason')
    }
  })

  it('(g) handles nested braces inside the reason string without breaking extraction', () => {
    const text = '{"verdict": "approve", "reason": "The code has logic like { x: 1 } which is good"}'
    const result = parseReviewVerdict(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.verdict).toBe('approve')
      expect(result.value.reason).toBe('The code has logic like { x: 1 } which is good')
    }
  })

  it('(h) backtracks past a schema-invalid last object to an earlier valid one, even at index 0', () => {
    const text = '{"verdict": "approve", "reason": "Earlier"} then {"verdict": "maybe", "reason": "Later"}'
    const result = parseReviewVerdict(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.verdict).toBe('approve')
      expect(result.value.reason).toBe('Earlier')
    }
  })
})
