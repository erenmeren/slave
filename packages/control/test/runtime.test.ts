import { describe, expect, it } from 'vitest'
import { resolveRuntime } from '../src/runtime.js'

const template = (defaultModel: string | null, provider: 'claude_code' | 'cursor' | null) =>
  ({ defaultModel, provider })

describe('resolveRuntime', () => {
  it('takes both halves from the worker when the worker names a model', () => {
    expect(
      resolveRuntime(
        { model: 'w', provider: 'cursor', companyAgent: { model: 'c', provider: 'claude_code', template: template('t', 'claude_code') } },
        'claude_code',
      ),
    ).toEqual({ provider: 'cursor', model: 'w' })
  })

  it('falls to the roster row as a whole, never mixing the worker provider with the roster model', () => {
    expect(
      resolveRuntime(
        { model: null, provider: null, companyAgent: { model: 'c', provider: 'cursor', template: template('t', 'claude_code') } },
        'claude_code',
      ),
    ).toEqual({ provider: 'cursor', model: 'c' })
  })

  it('falls to the template, then to the workspace default with no model', () => {
    expect(
      resolveRuntime(
        { model: null, provider: null, companyAgent: { model: null, provider: null, template: template('t', 'cursor') } },
        'claude_code',
      ),
    ).toEqual({ provider: 'cursor', model: 't' })

    expect(resolveRuntime({ model: null, provider: null, companyAgent: null }, 'cursor')).toEqual({
      provider: 'cursor',
      model: undefined,
    })
  })

  it('a legacy agent with no roster link resolves through its own column alone', () => {
    expect(resolveRuntime({ model: 'legacy-model', provider: 'claude_code', companyAgent: null }, 'claude_code')).toEqual({
      provider: 'claude_code',
      model: 'legacy-model',
    })
  })

  describe('a half-pair -- a level naming a model with no provider recorded (a pre-M12 row)', () => {
    it('refuses at the worker level rather than mixing its model with the roster provider', () => {
      // The worker names a model M12 could not have written this way (Task 7 refuses writing a
      // model without its provider) -- so this shape only exists on a row from before that guard
      // existed. Falling through to the roster's valid 'cursor' pair would run 'legacy' under a
      // provider nobody ever paired it with; falling through to the roster's OWN model would
      // silently discard the worker's real override. Both are the mixing this chain forbids, so
      // the whole resolution is unresolvable: `provider: null` tells the caller to refuse the run,
      // not to guess.
      expect(
        resolveRuntime(
          {
            model: 'legacy',
            provider: null,
            companyAgent: { model: 'c', provider: 'cursor', template: template('t', 'claude_code') },
          },
          'claude_code',
        ),
      ).toEqual({ provider: null, model: undefined })
    })

    it('refuses at the roster level with no lower level consulted', () => {
      expect(
        resolveRuntime(
          { model: null, provider: null, companyAgent: { model: 'legacy', provider: null, template: template('t', 'cursor') } },
          'claude_code',
        ),
      ).toEqual({ provider: null, model: undefined })
    })

    it('refuses at the template level even though a workspace default exists', () => {
      expect(
        resolveRuntime(
          { model: null, provider: null, companyAgent: { model: null, provider: null, template: template('legacy', null) } },
          'claude_code',
        ),
      ).toEqual({ provider: null, model: undefined })
    })

    it('refuses for a legacy agent with no roster link at all', () => {
      expect(resolveRuntime({ model: 'legacy', provider: null, companyAgent: null }, 'claude_code')).toEqual({
        provider: null,
        model: undefined,
      })
    })
  })

  it('resolves to no provider (a refusal, not Claude) when nothing names a model and the workspace has no default', () => {
    expect(resolveRuntime({ model: null, provider: null, companyAgent: null }, null)).toEqual({
      provider: null,
      model: undefined,
    })
  })
})
