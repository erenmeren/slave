import { describe, expect, it } from 'vitest'
import { resolveRuntime } from '../src/runtime.js'

const template = (defaultModel: string | null, provider: 'claude_code' | 'cursor' | null) =>
  ({ defaultModel, provider })

describe('resolveRuntime', () => {
  it('takes both halves from the seat when the seat names a model', () => {
    expect(
      resolveRuntime(
        { model: 'w', provider: 'cursor', person: { model: 'c', provider: 'claude_code', template: template('t', 'claude_code') } },
        'claude_code',
      ),
    ).toEqual({ provider: 'cursor', model: 'w' })
  })

  it('falls to the person as a whole, never mixing the seat provider with the person model', () => {
    expect(
      resolveRuntime(
        { model: null, provider: null, person: { model: 'c', provider: 'cursor', template: template('t', 'claude_code') } },
        'claude_code',
      ),
    ).toEqual({ provider: 'cursor', model: 'c' })
  })

  it('falls to the template, then to the workspace default with no model', () => {
    expect(
      resolveRuntime(
        { model: null, provider: null, person: { model: null, provider: null, template: template('t', 'cursor') } },
        'claude_code',
      ),
    ).toEqual({ provider: 'cursor', model: 't' })

    expect(resolveRuntime({ model: null, provider: null, person: null }, 'cursor')).toEqual({
      provider: 'cursor',
      model: undefined,
    })
  })

  it('a seat whose person is not loaded resolves through its own columns alone', () => {
    expect(resolveRuntime({ model: 'legacy-model', provider: 'claude_code', person: null }, 'claude_code')).toEqual({
      provider: 'claude_code',
      model: 'legacy-model',
    })
  })

  describe('a half-pair -- a level naming a model with no provider recorded (a pre-M12 row)', () => {
    it('refuses at the seat level rather than mixing its model with the person provider', () => {
      // The seat names a model M12 could not have written this way (Task 7 refuses writing a
      // model without its provider) -- so this shape only exists on a row from before that guard
      // existed. Falling through to the person's valid 'cursor' pair would run 'legacy' under a
      // provider nobody ever paired it with; falling through to the person's OWN model would
      // silently discard the seat's real override. Both are the mixing this chain forbids, so the
      // whole resolution is unresolvable: `provider: null` tells the caller to refuse the run, not
      // to guess.
      expect(
        resolveRuntime(
          {
            model: 'legacy',
            provider: null,
            person: { model: 'c', provider: 'cursor', template: template('t', 'claude_code') },
          },
          'claude_code',
        ),
      ).toEqual({ provider: null, model: undefined })
    })

    it('refuses at the person level with no lower level consulted', () => {
      expect(
        resolveRuntime(
          { model: null, provider: null, person: { model: 'legacy', provider: null, template: template('t', 'cursor') } },
          'claude_code',
        ),
      ).toEqual({ provider: null, model: undefined })
    })

    it('refuses at the template level even though a workspace default exists', () => {
      expect(
        resolveRuntime(
          { model: null, provider: null, person: { model: null, provider: null, template: template('legacy', null) } },
          'claude_code',
        ),
      ).toEqual({ provider: null, model: undefined })
    })

    it('refuses for a seat whose person is not loaded at all', () => {
      expect(resolveRuntime({ model: 'legacy', provider: null, person: null }, 'claude_code')).toEqual({
        provider: null,
        model: undefined,
      })
    })
  })

  it('resolves to no provider (a refusal, not Claude) when nothing names a model and the workspace has no default', () => {
    expect(resolveRuntime({ model: null, provider: null, person: null }, null)).toEqual({
      provider: null,
      model: undefined,
    })
  })
})
