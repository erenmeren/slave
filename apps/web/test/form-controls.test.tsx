// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FieldLabel, GhostButton, INPUT_SHELL, PrimaryButton, SelectField, TextField } from '../src/components/ui/FormControls.js'

describe('FormControls', () => {
  it('TextField: 7px radius shell, mono label, props reach the input', () => {
    render(<TextField label="budget (usd)" inputProps={{ 'data-testid': 'tf', 'aria-label': 'budget (USD)', defaultValue: '20' }} />)
    const input = screen.getByTestId('tf')
    expect(input.className).toContain('rounded-[7px]')
    expect((input as HTMLInputElement).value).toBe('20')
    expect(screen.getByText('budget (usd)').className).toMatch(/font-mono/)
    expect(screen.getByText('budget (usd)').className).toContain('uppercase')
  })

  it('TextField without a label renders no label element', () => {
    render(<TextField inputProps={{ 'data-testid': 'bare', 'aria-label': 'goal' }} />)
    expect(screen.getByTestId('bare').closest('label')).toBeNull()
  })

  it('SelectField: same shell, options render, props reach the select', () => {
    render(
      <SelectField label="provider" selectProps={{ 'data-testid': 'sf', defaultValue: 'cursor' }}>
        <option value="claude_code">claude_code</option>
        <option value="cursor">cursor</option>
      </SelectField>,
    )
    const select = screen.getByTestId('sf') as HTMLSelectElement
    expect(select.className).toContain('rounded-[7px]')
    expect(select.value).toBe('cursor')
  })

  it('GhostButton: 5px radius, ghost idiom, disabled passes through', () => {
    render(<GhostButton data-testid="gb" disabled>cancel</GhostButton>)
    const button = screen.getByTestId('gb') as HTMLButtonElement
    expect(button.className).toContain('rounded-[5px]')
    expect(button.disabled).toBe(true)
  })

  it('PrimaryButton: working tone by default, blocked on request', () => {
    render(<PrimaryButton data-testid="pw">set goal</PrimaryButton>)
    render(<PrimaryButton data-testid="pb" tone="blocked">stop</PrimaryButton>)
    expect(screen.getByTestId('pw').className).toContain('tone-working')
    expect(screen.getByTestId('pb').className).toContain('tone-blocked')
    expect(screen.getByTestId('pb').className).toContain('rounded-[5px]')
  })

  it('INPUT_SHELL is exported so a shell the kit cannot own directly can reuse it verbatim', () => {
    expect(INPUT_SHELL).toContain('rounded-[7px]')
  })
})
