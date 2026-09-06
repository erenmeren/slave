import { describe, expect, it } from 'vitest'
import { actionEnvelopeSchema } from '../../src/core/action.js'

describe('actionEnvelopeSchema', () => {
  it('accepts a typed envelope and rejects free text', () => {
    expect(actionEnvelopeSchema.safeParse({ type: 'note', params: { text: 'hi' }, rationale: 'because', refs: [] }).success).toBe(true)
    expect(actionEnvelopeSchema.safeParse('I produced 500 units').success).toBe(false)
    expect(actionEnvelopeSchema.safeParse({ type: '', params: {}, rationale: '', refs: [] }).success).toBe(false)
  })
})
