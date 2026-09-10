// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProviderSelect } from '../src/components/ProviderSelect.js'
import { PROVIDER_KINDS, PROVIDER_LABEL, providerLabel } from '../src/lib/providerLabel.js'

/**
 * M44 final review, item I3. `claude_code` is a column value, and it was the visible text of
 * every provider `<select>` in the app -- four call sites, all through this one component.
 *
 * The `<option>` VALUE stays the raw kind, because that is what the form posts and what the
 * column stores; only the text a person reads is projected. Asserting both together is the point:
 * a label table that also changed the submitted value would be a silent data bug behind a
 * cosmetic fix.
 */
describe('ProviderSelect', () => {
  it('reads a label per option while submitting the raw kind', () => {
    const onChange = vi.fn()
    render(
      <ProviderSelect
        ariaLabel="provider"
        testId="member-provider"
        value=""
        onChange={onChange}
        disabled={false}
        placeholder="— inherit —"
        className=""
      />,
    )

    const options = screen.getAllByRole('option') as HTMLOptionElement[]
    expect(options.map((o) => o.textContent)).toEqual(['— inherit —', 'Claude Code', 'Cursor'])
    expect(options.map((o) => o.value)).toEqual(['', 'claude_code', 'cursor'])
    expect(options[1]?.title).toBe('claude_code')

    fireEvent.change(screen.getByTestId('member-provider'), { target: { value: 'claude_code' } })
    expect(onChange).toHaveBeenCalledWith('claude_code')
  })

  it('has a label for every provider kind, and says — for none at all', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(PROVIDER_LABEL[kind]).toBeTruthy()
      // The word a person reads is never the column value itself: no underscore, no bare kind.
      expect(PROVIDER_LABEL[kind]).not.toBe(kind)
      expect(providerLabel(kind)).toBe(PROVIDER_LABEL[kind])
    }
    expect(providerLabel(null)).toBe('—')
  })
})
