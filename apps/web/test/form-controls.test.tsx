// @vitest-environment jsdom
import type React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FieldLabel, INPUT_SHELL, SelectField, TextField } from '../src/components/ui/FormControls.js'

describe('FormControls', () => {
  // M61 R16: `FieldLabel` composes `SECTION_LABEL_CLASS`, which is now `.type-label` (sentence
  // case, no mono/uppercase) rather than the old 9px mono/uppercase recipe -- the RECIPE, not one
  // of its old classes, is what this pins (same reasoning `organization-page.test.tsx`'s "the
  // caption itself" case gives for the same constant).
  it('TextField: 7px radius shell, type-label caption, props reach the input', () => {
    render(<TextField label="budget (usd)" inputProps={{ 'data-testid': 'tf', 'aria-label': 'budget (USD)', defaultValue: '20' } as React.InputHTMLAttributes<HTMLInputElement>} />)
    const input = screen.getByTestId('tf')
    expect(input.className).toContain('rounded-tile')
    expect((input as HTMLInputElement).value).toBe('20')
    expect(screen.getByText('budget (usd)').className).toBe('type-label')
  })

  it('TextField without a label renders no label element', () => {
    render(<TextField inputProps={{ 'data-testid': 'bare', 'aria-label': 'goal' } as React.InputHTMLAttributes<HTMLInputElement>} />)
    expect(screen.getByTestId('bare').closest('label')).toBeNull()
  })

  it('SelectField: same shell, options render, props reach the select', () => {
    render(
      <SelectField label="provider" selectProps={{ 'data-testid': 'sf', defaultValue: 'cursor' } as React.SelectHTMLAttributes<HTMLSelectElement>}>
        <option value="claude_code">claude_code</option>
        <option value="cursor">cursor</option>
      </SelectField>,
    )
    const select = screen.getByTestId('sf') as HTMLSelectElement
    expect(select.className).toContain('rounded-tile')
    expect(select.value).toBe('cursor')
  })

  it('INPUT_SHELL is exported so a shell the kit cannot own directly can reuse it verbatim', () => {
    expect(INPUT_SHELL).toContain('rounded-tile')
  })
})
