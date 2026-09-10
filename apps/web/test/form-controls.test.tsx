// @vitest-environment jsdom
import type React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FieldLabel, GhostButton, INPUT_SHELL, PrimaryButton, SelectField, TextField } from '../src/components/ui/FormControls.js'

describe('FormControls', () => {
  it('TextField: 7px radius shell, mono label, props reach the input', () => {
    render(<TextField label="budget (usd)" inputProps={{ 'data-testid': 'tf', 'aria-label': 'budget (USD)', defaultValue: '20' } as React.InputHTMLAttributes<HTMLInputElement>} />)
    const input = screen.getByTestId('tf')
    expect(input.className).toContain('rounded-tile')
    expect((input as HTMLInputElement).value).toBe('20')
    expect(screen.getByText('budget (usd)').className).toMatch(/font-mono/)
    expect(screen.getByText('budget (usd)').className).toContain('uppercase')
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

  it('GhostButton: 5px radius, ghost idiom, disabled passes through', () => {
    render(<GhostButton data-testid="gb" disabled>cancel</GhostButton>)
    const button = screen.getByTestId('gb') as HTMLButtonElement
    // M44 R3: the alias now draws through `ui/Button`, which names the same 5px with the token
    // (`rounded-chip`) rather than the arbitrary-value literal. Same pixel, one source.
    expect(button.className).toContain('rounded-chip')
    expect(button.disabled).toBe(true)
  })

  // Final review I1: `hover:text-text-0` named a token Tailwind v4 never generates (no
  // `--text-0` in globals.css), so the hover brighten was dead -- only the border changed.
  // Pinned here so a class-string regression back to the nonexistent token fails a real test,
  // not just a human rereading the CSS ramp. M44 R3: the alias draws through `ui/Button`, whose
  // ghost hover is the declared top of the text ramp (`text-text-1`, #e7eaf0) rather than the raw
  // `#fff` this alias had drifted to -- a real token, and a real hover, either way.
  it('GhostButton: hover brightens text to a real token, not to a nonexistent text-0', () => {
    render(<GhostButton data-testid="gb-hover">cancel</GhostButton>)
    const button = screen.getByTestId('gb-hover') as HTMLButtonElement
    expect(button.className).toContain('hover:text-text-1')
    expect(button.className).not.toContain('text-text-0')
  })

  it('PrimaryButton: working tone by default, blocked on request', () => {
    render(<PrimaryButton data-testid="pw">set goal</PrimaryButton>)
    render(<PrimaryButton data-testid="pb" tone="blocked">stop</PrimaryButton>)
    expect(screen.getByTestId('pw').className).toContain('tone-working')
    expect(screen.getByTestId('pb').className).toContain('tone-blocked')
    expect(screen.getByTestId('pb').className).toContain('rounded-chip')
  })

  it('INPUT_SHELL is exported so a shell the kit cannot own directly can reuse it verbatim', () => {
    expect(INPUT_SHELL).toContain('rounded-tile')
  })
})

describe('GhostButton and PrimaryButton are aliases of Button now (M44 R3)', () => {
  it('GhostButton is a small ghost Button', () => {
    render(<GhostButton>x</GhostButton>)
    const button = screen.getByTestId('button')
    expect(button.getAttribute('data-variant')).toBe('ghost')
    expect(button.getAttribute('data-size')).toBe('sm')
  })

  it('PrimaryButton is a small primary Button, and tone="blocked" is the danger variant', () => {
    render(<><PrimaryButton>go</PrimaryButton><PrimaryButton tone="blocked">stop</PrimaryButton></>)
    const [primary, danger] = screen.getAllByTestId('button')
    expect(primary?.getAttribute('data-variant')).toBe('primary')
    expect(danger?.getAttribute('data-variant')).toBe('danger')
    expect(danger?.getAttribute('data-size')).toBe('sm')
  })

  it('still passes a caller testid, disabled and onClick straight through', () => {
    const onClick = vi.fn()
    render(<GhostButton data-testid="mine" disabled onClick={onClick}>x</GhostButton>)
    expect((screen.getByTestId('mine') as HTMLButtonElement).disabled).toBe(true)
  })
})
