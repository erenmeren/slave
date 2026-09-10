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

  it('appends inside the matched section, not at the end of the document', () => {
    const previous =
      'Body.\n\n## Requested changes\n\n- 2026-09-10: Add Apple Pay\n\n## Constraints\n\n- No new dependencies\n'
    expect(composeGoal(previous, 'Drop the gift-card page', new Date('2026-09-12T00:00:00.000Z'))).toBe(
      'Body.\n\n## Requested changes\n\n- 2026-09-10: Add Apple Pay\n- 2026-09-12: Drop the gift-card page\n\n## Constraints\n\n- No new dependencies\n',
    )
  })

  it('matches the heading as a LINE, so a body that merely mentions it opens a real section', () => {
    expect(composeGoal('Do not write ## Requested changes inline.', 'Add Apple Pay', AT)).toBe(
      'Do not write ## Requested changes inline.\n\n## Requested changes\n\n- 2026-09-10: Add Apple Pay\n',
    )
  })

  /** M45 final wave, parked domain minor: an operator who typed the heading and left the list empty
   *  got the first bullet welded to it -- `## Requested changes\n- …`, which the composer's own
   *  heading-opening path would never have produced. Same shape, whoever wrote the heading. */
  it('opens a blank line between a bullet-less heading and the first entry', () => {
    expect(composeGoal('Body.\n\n## Requested changes\n', 'Add Apple Pay', AT)).toBe(
      'Body.\n\n## Requested changes\n\n- 2026-09-10: Add Apple Pay\n',
    )
  })

  it('keeps the separation when a bullet-less heading is followed by another section', () => {
    expect(
      composeGoal('Body.\n\n## Requested changes\n\n## Constraints\n\n- No new dependencies\n', 'Add Apple Pay', AT),
    ).toBe('Body.\n\n## Requested changes\n\n- 2026-09-10: Add Apple Pay\n\n## Constraints\n\n- No new dependencies\n')
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
