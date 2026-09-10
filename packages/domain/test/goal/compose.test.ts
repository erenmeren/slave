import { describe, expect, it } from 'vitest'
import { REQUESTED_CHANGES_HEADING, composeGoal } from '../../src/goal/compose.js'

const AT = new Date('2026-09-10T11:22:33.000Z')

describe('composeGoal', () => {
  it('keeps the body and opens a dated Requested changes list', () => {
    expect(composeGoal('Ship the checkout flow.', 'Add Apple Pay', AT)).toBe(
      'Ship the checkout flow.\n\n## Requested changes\n\n- 2026-09-10: Add Apple Pay\n',
    )
  })

  it('appends to the list a second time instead of opening a second heading', () => {
    const first = composeGoal('Ship the checkout flow.', 'Add Apple Pay', AT)
    const second = composeGoal(first, 'Drop the gift-card page', new Date('2026-09-11T00:00:00.000Z'))
    expect(second).toBe(
      'Ship the checkout flow.\n\n## Requested changes\n\n- 2026-09-10: Add Apple Pay\n- 2026-09-11: Drop the gift-card page\n',
    )
    expect(second.split(REQUESTED_CHANGES_HEADING)).toHaveLength(2)
  })

  it('takes the request AS the goal when the project has none yet', () => {
    expect(composeGoal(null, 'Build a billing service', AT)).toBe('Build a billing service')
  })

  it('flattens a multi-line request onto one list entry', () => {
    expect(composeGoal('Body.', 'Add Apple Pay\n\nand Google Pay  ', AT)).toBe(
      'Body.\n\n## Requested changes\n\n- 2026-09-10: Add Apple Pay and Google Pay\n',
    )
  })

  it('is byte-stable: the same inputs always produce the same bytes', () => {
    expect(composeGoal('Body.', 'Add Apple Pay', AT)).toBe(composeGoal('Body.', 'Add Apple Pay', AT))
  })
})
