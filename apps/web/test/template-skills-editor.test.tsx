// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TemplateSkillsEditor } from '../src/components/workforce/TemplateSkillsEditor.js'

const catalogue = [
  { skillId: 'sk1', name: 'pdf', providerName: 'personal' },
  { skillId: 'sk2', name: 'sql', providerName: 'personal' },
]

describe('TemplateSkillsEditor (R25)', () => {
  it('lists the persona’s defaults and says the change reaches everybody hired from it', () => {
    render(<TemplateSkillsEditor templateId="t1" skillIds={['sk1']} catalogue={catalogue} hiredCount={4} onChanged={() => {}} />)
    expect(screen.getByTestId('template-skill-sk1').textContent).toContain('pdf')
    expect(screen.queryByTestId('template-skill-sk2')).toBeNull()
    expect(screen.getByTestId('template-skills-note').textContent).toContain('4 slaves')
  })

  it('adding a skill PATCHes the WHOLE set, never a delta', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<TemplateSkillsEditor templateId="t1" skillIds={['sk1']} catalogue={catalogue} hiredCount={0} onChanged={() => {}} />)

    fireEvent.change(screen.getByTestId('template-skill-add'), { target: { value: 'sk2' } })
    fireEvent.click(screen.getByTestId('template-skill-add-submit'))

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/org/templates/t1/skills')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ skillIds: ['sk1', 'sk2'] })
    vi.unstubAllGlobals()
  })

  it('removing a skill PATCHes what is left', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<TemplateSkillsEditor templateId="t1" skillIds={['sk1', 'sk2']} catalogue={catalogue} hiredCount={0} onChanged={() => {}} />)

    fireEvent.click(screen.getByTestId('template-skill-remove-sk1'))
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ skillIds: ['sk2'] })
    vi.unstubAllGlobals()
  })

  /**
   * The window between a save and the re-read it triggers: the editor re-enables when the PATCH
   * answers, before its `skillIds` prop has caught up. A second edit built from that prop wrote the
   * pre-save set back -- reverting the first edit.
   */
  it('builds a quick second edit on the set it just saved, not on the prop that has not caught up', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const catalogueOf3 = [...catalogue, { skillId: 'sk3', name: 'git', providerName: 'personal' }]
    render(<TemplateSkillsEditor templateId="t1" skillIds={['sk1']} catalogue={catalogueOf3} hiredCount={0} onChanged={() => {}} />)

    fireEvent.change(screen.getByTestId('template-skill-add'), { target: { value: 'sk2' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('template-skill-add-submit'))
    })
    expect(screen.getByTestId('template-skill-sk2')).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByTestId('template-skill-remove-sk1'))
    })
    const bodyOf = (call: number): unknown => JSON.parse(String((fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1].body))
    expect(bodyOf(1)).toEqual({ skillIds: ['sk2'] })
    vi.unstubAllGlobals()
  })

  it('follows the prop again once the re-read lands', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })))
    const { rerender } = render(
      <TemplateSkillsEditor templateId="t1" skillIds={['sk1']} catalogue={catalogue} hiredCount={0} onChanged={() => {}} />,
    )
    fireEvent.change(screen.getByTestId('template-skill-add'), { target: { value: 'sk2' } })
    await act(async () => {
      fireEvent.click(screen.getByTestId('template-skill-add-submit'))
    })
    // The server's answer wins, whatever it is -- here somebody else removed sk1 meanwhile.
    rerender(<TemplateSkillsEditor templateId="t1" skillIds={['sk2']} catalogue={catalogue} hiredCount={0} onChanged={() => {}} />)
    expect(screen.queryByTestId('template-skill-sk1')).toBeNull()
    expect(screen.getByTestId('template-skill-sk2')).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('says nobody is affected when nobody was hired from the persona', () => {
    render(<TemplateSkillsEditor templateId="t1" skillIds={[]} catalogue={catalogue} hiredCount={0} onChanged={() => {}} />)
    expect(screen.getByTestId('template-skills-note').textContent ?? '').toMatch(/nobody has been hired/i)
  })
})
