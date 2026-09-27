'use client'

import { useState } from 'react'
import { Button } from '../ui/Button'
import { SelectField } from '../ui/FormControls'

/**
 * A persona's DEFAULT skills (M58 R25).
 *
 * The whole force of D4 is in the note this renders: changing this list changes every person hired
 * from the persona AT ONCE, because nothing is copied -- the effective set is computed on read
 * (`effectiveSkills`). A person who has revoked one of these keeps their revoke; that is their own
 * word about themselves and a persona edit does not overrule it.
 *
 * A SET, not a delta: every write sends the whole list, which is what `setTemplateSkills` takes and
 * is why two operators editing the same persona cannot interleave into a half-list.
 *
 * After a save, the set just SENT is this editor's base until the `skillIds` prop changes (the
 * caller's re-read landing). The editor re-enables when the PATCH answers, before that re-read; a
 * quick second edit built from the not-yet-updated prop wrote the pre-save set back and reverted
 * the first edit.
 */
export function TemplateSkillsEditor({
  templateId,
  skillIds,
  catalogue,
  hiredCount,
  onChanged,
}: {
  readonly templateId: string
  readonly skillIds: readonly string[]
  readonly catalogue: readonly { readonly skillId: string; readonly name: string; readonly providerName: string }[]
  /** How many people were hired from this persona -- the number the note names, so an operator sees
   *  the blast radius before they click. */
  readonly hiredCount: number
  readonly onChanged: () => void
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [adding, setAdding] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)
  // `from` is the prop as it was when `sent` was saved: the moment the prop differs from it, the
  // caller's re-read has landed and the prop is the truth again. Compared by value, because a
  // re-read that hands back a new array holding the OLD set has not caught up yet.
  const [saved, setSaved] = useState<{ readonly from: string; readonly sent: readonly string[] } | null>(null)
  const propKey = skillIds.join('\n')
  const current = saved !== null && saved.from === propKey ? saved.sent : skillIds

  const write = async (next: readonly string[]): Promise<void> => {
    setPending(true)
    setErrorText(null)
    try {
      const response = await fetch(`/api/org/templates/${templateId}/skills`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skillIds: next }),
      })
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null)
        setErrorText(
          payload !== null && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : 'that could not be saved',
        )
        return
      }
      setSaved({ from: propKey, sent: next })
      setAdding('')
      onChanged()
    } finally {
      setPending(false)
    }
  }

  const nameOf = new Map(catalogue.map((row) => [row.skillId, row] as const))
  const addable = catalogue.filter((row) => !current.includes(row.skillId))

  return (
    <div data-testid="template-skills-editor" className="flex flex-col gap-1.5">
      {current.length === 0 && <p className="text-xs text-text-3">no default skills</p>}
      {current.map((skillId) => {
        const skill = nameOf.get(skillId)
        return (
          <div key={skillId} data-testid={`template-skill-${skillId}`} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono text-text-1">{skill?.name ?? skillId}</span>
              <span className="truncate text-[10.5px] text-text-3">{skill?.providerName ?? ''}</span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              data-testid={`template-skill-remove-${skillId}`}
              disabled={pending}
              onClick={() => void write(current.filter((one) => one !== skillId))}
            >
              remove
            </Button>
          </div>
        )
      })}

      <div className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
        <SelectField
          label="Add a default skill"
          selectProps={{
            'aria-label': 'add a default skill',
            'data-testid': 'template-skill-add',
            value: adding,
            disabled: pending,
            onChange: (event) => setAdding(event.target.value),
          } as React.SelectHTMLAttributes<HTMLSelectElement>}
        >
          <option value="">select a skill</option>
          {addable.map((row) => (
            <option key={row.skillId} value={row.skillId}>{`${row.name} (${row.providerName})`}</option>
          ))}
        </SelectField>
        <Button
          variant="primary"
          size="sm"
          data-testid="template-skill-add-submit"
          disabled={pending || adding === ''}
          onClick={() => void write([...current, adding])}
        >
          Add
        </Button>
      </div>

      <p data-testid="template-skills-note" className="text-xs text-text-3">
        {hiredCount === 0
          ? 'nobody has been hired from this persona yet; whoever is, starts with these'
          : `changing this changes ${hiredCount === 1 ? '1 slave' : `${String(hiredCount)} slaves`} at once — ` +
            'nothing is copied, so anybody who revoked one of these keeps their revoke'}
      </p>
      {errorText !== null && (
        <span role="alert" data-testid="template-skills-error" className="text-xs text-tone-blocked">{errorText}</span>
      )}
    </div>
  )
}
