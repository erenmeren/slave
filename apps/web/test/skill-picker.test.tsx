// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SkillPicker } from '../src/components/workforce/SkillPicker.js'
import type { SkillCatalogueRow } from '../src/server/persons.js'

const row = (skillId: string, name: string, providerName: string, over: Partial<SkillCatalogueRow> = {}): SkillCatalogueRow => ({
  skillId,
  name,
  providerName,
  description: `${name} helps`,
  missing: false,
  ...over,
})

const CATALOGUE: readonly SkillCatalogueRow[] = [
  row('s-plan', 'writing-plans', 'plugin:superpowers'),
  row('s-sql', 'sql', 'personal', { description: 'writes database queries' }),
  row('s-pdf', 'pdf', 'personal'),
  row('s-lint', 'lint', 'project'),
  row('s-gone', 'archived', 'personal', { missing: true }),
]

const groupIds = (): string[] =>
  screen.getAllByTestId(/^skill-picker-group-/u).map((node) => node.getAttribute('data-testid') ?? '')

describe('SkillPicker', () => {
  it('groups Your skills, then Project, then each plugin, names sorted inside', () => {
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={null} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(groupIds()).toEqual(['skill-picker-group-personal', 'skill-picker-group-project', 'skill-picker-group-plugin:superpowers'])
    expect(screen.getByTestId('skill-picker-group-plugin:superpowers').textContent).toContain('🔌 superpowers')
    const personal = within(screen.getByTestId('skill-picker-group-personal')).getAllByTestId(/^skill-picker-option-/u)
    expect(personal.map((node) => node.getAttribute('data-testid'))).toEqual([
      'skill-picker-option-s-gone',
      'skill-picker-option-s-pdf',
      'skill-picker-option-s-sql',
    ])
  })

  it('searches the name and the description', () => {
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={null} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByTestId('skill-picker-search'), { target: { value: 'database' } })
    expect(screen.getAllByTestId(/^skill-picker-option-/u).map((node) => node.getAttribute('data-testid'))).toEqual([
      'skill-picker-option-s-sql',
    ])
    fireEvent.change(screen.getByTestId('skill-picker-search'), { target: { value: 'nothing like it' } })
    expect(screen.getByTestId('skill-picker-empty')).toBeTruthy()
  })

  it('shows a linked skill checked and disabled, and a missing one disabled', () => {
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set(['s-pdf'])} scope={null} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    const linked = screen.getByTestId('skill-picker-option-s-pdf')
    expect(linked.getAttribute('data-linked')).toBe('true')
    expect(linked.textContent).toContain('✓')
    expect((linked as HTMLButtonElement).disabled).toBe(true)
    const missing = screen.getByTestId('skill-picker-option-s-gone')
    expect(missing.getAttribute('data-missing')).toBe('true')
    expect((missing as HTMLButtonElement).disabled).toBe(true)
  })

  it('on a persona card there is no scope to choose, and the skill goes to the persona', () => {
    const onConfirm = vi.fn()
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={null} onConfirm={onConfirm} onCancel={vi.fn()} />)
    expect(screen.queryByTestId('skill-picker-scope')).toBeNull()
    fireEvent.click(screen.getByTestId('skill-picker-option-s-sql'))
    fireEvent.click(screen.getByTestId('skill-picker-confirm'))
    expect(onConfirm).toHaveBeenCalledWith('s-sql', 'persona')
  })

  it('on a person card the scope is asked, "only this person" by default', () => {
    const onConfirm = vi.fn()
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={{ personaName: 'Builder' }} onConfirm={onConfirm} onCancel={vi.fn()} />)
    expect(screen.getByTestId('skill-picker-scope').getAttribute('data-value')).toBe('person')
    expect(screen.getByTestId('skill-picker-scope-persona').textContent).toBe('Everyone from Builder')
    fireEvent.click(screen.getByTestId('skill-picker-option-s-sql'))
    fireEvent.click(screen.getByTestId('skill-picker-confirm'))
    expect(onConfirm).toHaveBeenLastCalledWith('s-sql', 'person')
    fireEvent.click(screen.getByTestId('skill-picker-scope-persona'))
    fireEvent.click(screen.getByTestId('skill-picker-confirm'))
    expect(onConfirm).toHaveBeenLastCalledWith('s-sql', 'persona')
  })

  it('says so when the person was hired from no persona', () => {
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={{ personaName: null }} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.queryByTestId('skill-picker-scope')).toBeNull()
    expect(screen.getByTestId('skill-picker-scope-none')).toBeTruthy()
  })

  it('a process skill needs an explicit confirm', () => {
    const onConfirm = vi.fn()
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={null} onConfirm={onConfirm} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('skill-picker-option-s-plan'))
    expect(screen.getByTestId('skill-picker-process-warning').textContent).toBe(
      'Process skill: can make a worker plan and delegate instead of doing its task.',
    )
    const confirm = screen.getByTestId('skill-picker-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('skill-picker-process-confirm'))
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    expect(onConfirm).toHaveBeenCalledWith('s-plan', 'persona')
  })

  // Final review (Task 6's deferred minor): a choice a later search hides is no longer a choice --
  // Add must not stay live for a row nobody can see.
  it('drops the selection when a search filters the chosen row away', () => {
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={null} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.click(screen.getByTestId('skill-picker-option-s-sql'))
    expect((screen.getByTestId('skill-picker-confirm') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(screen.getByTestId('skill-picker-search'), { target: { value: 'pdf' } })
    expect((screen.getByTestId('skill-picker-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('Cancel and Escape both close it', () => {
    const onCancel = vi.fn()
    render(<SkillPicker catalogue={CATALOGUE} linked={new Set()} scope={null} onConfirm={vi.fn()} onCancel={onCancel} />)
    fireEvent.click(screen.getByTestId('skill-picker-cancel'))
    fireEvent.keyDown(screen.getByTestId('skill-picker-search'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(2)
  })
})
