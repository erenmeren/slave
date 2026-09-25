import { describe, expect, it } from 'vitest'
import { NETWORK_ROLES, readFailure } from '../../src/supervisor/diagnosis.js'

/**
 * Spec §3, one `it` per row of the table plus the row that is not in it (`unknown`).
 *
 * The whole point of this module is that the remedy is chosen from FACTS -- the reason a run
 * recorded, the kinds a gate refused -- and never from a model's guess about them, so every case
 * below is a literal in, a reading out, and nothing in between.
 */
describe('readFailure -- the diagnosis table (spec §3)', () => {
  /** The emptiest input that is still a real failure: nothing denied, no permissions asked for,
   *  and a role no rule names. Each test changes exactly the one fact its row is about. */
  const base = {
    reason: null,
    deniedKinds: [],
    requiredPermissions: [],
    requiredRole: 'backend',
    failureClass: null,
  } as const

  it('reads the system failing, not the worker, off the infrastructure markers', () => {
    for (const reason of [
      'stdout maxBuffer length exceeded',
      'the transcript could not be read',
      'spawn cursor-agent ENOENT',
      'EACCES: permission denied, open ".slaveofai/runs"',
      'the adapter refused the request',
      'the provider returned no content',
      'no valid verdict in the review output',
    ]) {
      expect(readFailure({ ...base, reason }), reason).toEqual({ reading: 'infrastructure', deniedKind: null })
    }
  })

  it('matches an infrastructure marker whatever case it was written in', () => {
    expect(readFailure({ ...base, reason: 'STDOUT MAXBUFFER EXCEEDED' }).reading).toBe('infrastructure')
  })

  // H4b, generalised by H9b R1: the row says the platform failed (a spawn that never reached the
  // model, a daemon crash, a provider refusal), so the sentence is not consulted -- a reason no
  // marker matches, or none at all, still reads as the system failing.
  it('reads a platform failure as infrastructure, whatever its reason says', () => {
    expect(readFailure({ ...base, failureClass: 'platform' })).toEqual({ reading: 'infrastructure', deniedKind: null })
    expect(readFailure({ ...base, reason: 'the worker concluded the task could not be done', failureClass: 'platform' })).toEqual({
      reading: 'infrastructure',
      deniedKind: null,
    })
    // And the refusal still wins over it, as it does over the markers.
    expect(
      readFailure({ ...base, deniedKinds: ['network_fetch'], requiredRole: 'research', failureClass: 'platform' }).reading,
    ).toBe('denied_tool')
    // A `worker` failure is read from its sentence, exactly as a row with no class is.
    expect(readFailure({ ...base, reason: 'the worker concluded the task could not be done', failureClass: 'worker' }).reading).not.toBe(
      'infrastructure',
    )
  })

  it('reads a refused tool the task itself asked for, and names the kind', () => {
    const reading = readFailure({
      ...base,
      reason: 'the run ended without finishing the work',
      deniedKinds: ['network_fetch'],
      requiredPermissions: ['network_fetch'],
    })
    expect(reading).toEqual({ reading: 'denied_tool', deniedKind: 'network_fetch' })
  })

  it('reads a refused network tool off the ROLE alone, for the roles whose work is the web', () => {
    for (const requiredRole of NETWORK_ROLES) {
      const reading = readFailure({ ...base, reason: 'the run ended', deniedKinds: ['network_fetch'], requiredRole })
      expect(reading, requiredRole).toEqual({ reading: 'denied_tool', deniedKind: 'network_fetch' })
    }
  })

  it('does not read a refused tool nobody asked for as the cause', () => {
    // `read_secret` was refused, the task asked for nothing, and the role is not one of the six:
    // the denial is real and is not what this failure is about, so nothing here names a grant.
    const reading = readFailure({ ...base, reason: 'the run ended', deniedKinds: ['read_secret'] })
    expect(reading).toEqual({ reading: 'unknown', deniedKind: null })
  })

  it('does not read network_fetch off a role that is not one of the six', () => {
    const reading = readFailure({ ...base, reason: 'the run ended', deniedKinds: ['network_fetch'], requiredRole: 'backend' })
    expect(reading).toEqual({ reading: 'unknown', deniedKind: null })
  })

  it('reads a worker going in circles as lost, when nothing was refused it', () => {
    for (const reason of [
      'guardrail behavioural_loop tripped',
      'guardrail run_timeout tripped',
      'the run kept going in circles',
      'the output stream ended before the run concluded',
    ]) {
      expect(readFailure({ ...base, reason }), reason).toEqual({ reading: 'lost', deniedKind: null })
    }
  })

  it('never reads lost while something was refused -- a wall is not the same as being lost', () => {
    // `read_secret` names no grant (the row above), so this is neither `denied_tool` nor `lost`:
    // a worker that was refused something may be stuck ON that, and a steer that told it to change
    // approach would be the Supervisor guessing.
    const reading = readFailure({ ...base, reason: 'guardrail run_timeout tripped', deniedKinds: ['read_secret'] })
    expect(reading).toEqual({ reading: 'unknown', deniedKind: null })
  })

  it('reads a rejected review as the work being wrong', () => {
    for (const reason of ['the review rejected the change', 'rejected: the tests do not cover it']) {
      expect(readFailure({ ...base, reason }), reason).toEqual({ reading: 'rejected', deniedKind: null })
    }
  })

  it('reads anything else, and a failure with no reason at all, as unknown', () => {
    expect(readFailure(base)).toEqual({ reading: 'unknown', deniedKind: null })
    expect(readFailure({ ...base, reason: 'the worker concluded the task could not be done' })).toEqual({
      reading: 'unknown',
      deniedKind: null,
    })
  })

  it('reads the REFUSAL first when a failure carries both signals', () => {
    // Fix round 1, the controller's ruling: a refusal is the more specific fact -- a gate really
    // did turn this worker away from something this work needs -- while an infrastructure marker
    // is a string on a reason line and can ride along with anything, including the message a
    // refused run wrote on its way out. Reading it first would retry into the same wall.
    const reading = readFailure({
      ...base,
      reason: 'spawn ENOENT',
      deniedKinds: ['network_fetch'],
      requiredPermissions: ['network_fetch'],
    })
    expect(reading).toEqual({ reading: 'denied_tool', deniedKind: 'network_fetch' })
    // And the infrastructure reading is still what is left when nothing was refused.
    expect(readFailure({ ...base, reason: 'spawn ENOENT' }).reading).toBe('infrastructure')
  })

  it('names the kind the task asked for when several were refused', () => {
    const reading = readFailure({
      ...base,
      reason: 'the run ended',
      deniedKinds: ['read_secret', 'run_commands'],
      requiredPermissions: ['run_commands'],
    })
    expect(reading.deniedKind).toBe('run_commands')
  })

  it('reads a role however it was capitalised -- requiredRole is free text an operator typed', () => {
    const reading = readFailure({ ...base, reason: 'the run ended', deniedKinds: ['network_fetch'], requiredRole: 'Research' })
    expect(reading).toEqual({ reading: 'denied_tool', deniedKind: 'network_fetch' })
  })
})
