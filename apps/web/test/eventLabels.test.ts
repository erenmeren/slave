import { describe, expect, it } from 'vitest'
import { EVENT_TYPE_BY_DOMAIN_TYPE } from '@slave-of-ai/db'
import { EVENT_PREFIX_LABEL, eventPrefixLabel, readableEventType } from '../src/lib/eventLabels.js'

/**
 * The Activity rail's family table, and the one rule that keeps it from going stale (M52 t5 fix
 * round 1, review Important 2).
 *
 * `eventPrefixLabel` falls back to the KEY it was given, which is the right behaviour for a rail
 * whose rows are keyed by that exact string and the wrong thing to SHOW: until this round the
 * right rail of `/w/:id/activity` read `broker.*` and `permission.*` as visible words the moment a
 * workspace had one brokered call or one permission change in twenty-four hours, and the Overview
 * river read `broker · executed` in lowercase where every other family is capitalised.
 *
 * The parity case below is what stops the NEXT family being forgotten: a new `DomainEventType`
 * whose prefix has no entry fails here rather than on somebody's screen. `gate:m44-ux-foundation`
 * cannot catch it -- its seeded database has no rows of a new type, so its stage-4 token sweep
 * walks a page where the bar never renders.
 */
describe('EVENT_PREFIX_LABEL', () => {
  it('has a word for every event-type family the domain can write', () => {
    const prefixes = [...new Set(Object.keys(EVENT_TYPE_BY_DOMAIN_TYPE).map((type) => `${type.split('.')[0] ?? ''}.*`))]
    const missing = prefixes.filter((prefix) => EVENT_PREFIX_LABEL[prefix] === undefined)
    expect(missing).toEqual([])
    // And the reverse: a label for a family that no longer exists is a word nothing can render.
    expect(Object.keys(EVENT_PREFIX_LABEL).filter((prefix) => !prefixes.includes(prefix))).toEqual([])
  })

  it('names M52’s two families, so the rail never prints their keys', () => {
    expect(eventPrefixLabel('broker.*')).toBe('Brokered')
    expect(eventPrefixLabel('permission.*')).toBe('Permissions')
  })

  it('says the three M52 event types out loud, capitalised like every other family', () => {
    expect(readableEventType('broker.executed')).toBe('Brokered · executed')
    expect(readableEventType('broker.refused')).toBe('Brokered · refused')
    expect(readableEventType('permission.changed')).toBe('Permissions · changed')
  })

  // M49's families were the gap this parity case found on its first run: `memory.*` has been
  // writable since that milestone and had no entry either.
  it('says the knowledge events out loud too', () => {
    expect(readableEventType('memory.recorded')).toBe('Knowledge · recorded')
    expect(readableEventType('memory.changed')).toBe('Knowledge · changed')
  })

  it('still falls back to the key for a family this build has never heard of', () => {
    expect(eventPrefixLabel('nothing.*')).toBe('nothing.*')
    expect(readableEventType('nothing.happened')).toBe('nothing · happened')
  })
})
