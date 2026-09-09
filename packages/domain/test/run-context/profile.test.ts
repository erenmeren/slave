import { describe, expect, it } from 'vitest'
import { PROFILE_MAX_CHARS, effectiveProfile } from '../../src/run-context/profile.js'

/**
 * Moved here from `apps/orchestrator/test/integration/runContext.test.ts` with the function itself
 * (M37 t3): `effectiveProfile` is pure, and its two callers now live in different packages -- the
 * orchestrator's builder and (M37 t4) the web's profile panel, which may not import from an app.
 */
describe('effectiveProfile', () => {
  it('prefers the slave, then the company slave, then the template, then nothing', () => {
    const template = { profile: 'template text' }
    expect(effectiveProfile({ profile: 'slave text', companySlave: { profile: 'company text', template } })).toEqual({
      text: 'slave text',
      origin: 'slave',
    })
    expect(effectiveProfile({ profile: null, companySlave: { profile: 'company text', template } })).toEqual({
      text: 'company text',
      origin: 'company',
    })
    expect(effectiveProfile({ profile: null, companySlave: { profile: null, template } })).toEqual({
      text: 'template text',
      origin: 'template',
    })
    expect(effectiveProfile({ profile: null, companySlave: { profile: null, template: { profile: null } } })).toBeNull()
    // A slave with no roster link resolves through its own column alone.
    expect(effectiveProfile({ profile: null, companySlave: null })).toBeNull()
  })

  it("treats an empty string as cleared at that level's own position", () => {
    // What `set-profile --clear` means one level down: the column WINS the `??` chain (it is not
    // null) and then renders nothing, rather than falling through to the template's text.
    const template = { profile: 'template text' }
    expect(effectiveProfile({ profile: '', companySlave: { profile: 'company text', template } })).toBeNull()
  })

  it('is the one definition of the cap both enforcement points read', () => {
    expect(PROFILE_MAX_CHARS).toBe(16_000)
  })
})
