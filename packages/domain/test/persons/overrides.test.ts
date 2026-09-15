import { describe, expect, it } from 'vitest'
import {
  effectiveModelFor,
  effectiveProfileFor,
  effectiveProviderFor,
  resolveOverride,
} from '../../src/persons/overrides.js'

describe('resolveOverride', () => {
  it('the seat wins over the person and the template', () => {
    expect(resolveOverride({ seat: 'a', person: 'b', template: 'c' })).toEqual({ value: 'a', origin: 'seat' })
  })

  it('the person wins when the seat says nothing', () => {
    expect(resolveOverride({ seat: null, person: 'b', template: 'c' })).toEqual({ value: 'b', origin: 'person' })
  })

  it('the template is the floor', () => {
    expect(resolveOverride({ seat: null, person: null, template: 'c' })).toEqual({ value: 'c', origin: 'template' })
  })

  it('nothing anywhere is null, not an empty answer', () => {
    expect(resolveOverride({ seat: null, person: null, template: null })).toBeNull()
  })
})

describe('effectiveProfileFor', () => {
  it('reads the text and the level it came from', () => {
    expect(effectiveProfileFor({ seat: null, person: 'You are Atlas.', template: 'anything' })).toEqual({
      text: 'You are Atlas.',
      origin: 'person',
    })
  })

  it('an empty string at a level CLEARS the chain rather than falling through it', () => {
    expect(effectiveProfileFor({ seat: '', person: 'p', template: 't' })).toBeNull()
    expect(effectiveProfileFor({ seat: null, person: '', template: 't' })).toBeNull()
  })

  it('no profile anywhere is null', () => {
    expect(effectiveProfileFor({ seat: null, person: null, template: null })).toBeNull()
  })
})

describe('effectiveModelFor and effectiveProviderFor', () => {
  it('walk the same three levels', () => {
    expect(effectiveModelFor({ seat: null, person: 'sonnet', template: 'haiku' })).toEqual({
      value: 'sonnet',
      origin: 'person',
    })
    expect(effectiveProviderFor({ seat: 'claude_code', person: null, template: 'cursor' })).toEqual({
      value: 'claude_code',
      origin: 'seat',
    })
  })

  it('an empty model string is NOT the clearing rule the profile has', () => {
    expect(effectiveModelFor({ seat: '', person: 'sonnet', template: null })).toEqual({ value: '', origin: 'seat' })
  })
})
