'use client'

import { useState } from 'react'
import type { PersonSkillRow } from '../../server/persons'
import { Button } from '../ui/Button'
import { DetailsGroup } from '../ui/DetailsGroup'
import { SelectField } from '../ui/FormControls'

/**
 * The person panel's Skills group (M58 R23): the EFFECTIVE set, with where each row came from.
 *
 * Three states, three different acts, and the difference is the whole point:
 *   - inherited (`persona`) -- muted, labelled "from persona". Removing it REVOKES it, which is a
 *     fact about this person and leaves the persona alone.
 *   - granted (`person`) -- plain. Removing it CLEARS the grant, so the persona speaks again.
 *   - revoked -- struck through, still listed, because a person cannot put back what they cannot
 *     see. Restoring it clears the revoke.
 */
export function PersonSkillsGroup({
  personId,
  skills,
  catalogue,
  onChanged,
}: {
  readonly personId: string
  readonly skills: readonly PersonSkillRow[]
  readonly catalogue: readonly { readonly skillId: string; readonly name: string; readonly providerName: string }[]
  readonly onChanged: () => void
}): React.JSX.Element {
  const [adding, setAdding] = useState('')
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  const patch = async (key: string, body: Record<string, readonly string[]>): Promise<void> => {
    setPendingKey(key)
    setErrorText(null)
    try {
      const response = await fetch(`/api/persons/${personId}/skills`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null)
        setErrorText(
          payload !== null && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : 'that could not be done',
        )
        return
      }
      onChanged()
    } finally {
      setPendingKey(null)
    }
  }

  const held = new Set(skills.map((row) => row.skillId))
  const addable = catalogue.filter((row) => !held.has(row.skillId))

  return (
    <DetailsGroup group="skills" title="Skills" defaultOpen>
      <div className="flex flex-col gap-1.5">
        {skills.length === 0 && <p className="text-xs text-text-3">no skills</p>}
        {skills.map((skill) => (
          <div
            key={skill.skillId}
            data-testid={`panel-person-skill-${skill.skillId}`}
            data-skill-state={skill.state}
            className={`flex items-center justify-between gap-2 text-xs ${
              skill.state === 'persona' ? 'text-text-3' : skill.state === 'revoked' ? 'text-text-3 line-through' : 'text-text-1'
            }`}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-mono">{skill.name}</span>
              <span className="truncate text-[10.5px] text-text-3">{skill.providerName}</span>
              {skill.state === 'persona' && <span className="text-[10.5px]">from persona</span>}
            </span>
            {skill.state === 'revoked' ? (
              <Button
                variant="ghost"
                size="sm"
                data-testid={`panel-skill-restore-${skill.skillId}`}
                disabled={pendingKey === skill.skillId}
                onClick={() => void patch(skill.skillId, { clear: [skill.skillId] })}
              >
                restore
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                data-testid={`panel-skill-remove-${skill.skillId}`}
                disabled={pendingKey === skill.skillId}
                onClick={() =>
                  void patch(
                    skill.skillId,
                    skill.state === 'persona' ? { revoke: [skill.skillId] } : { clear: [skill.skillId] },
                  )
                }
              >
                remove
              </Button>
            )}
          </div>
        ))}

        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
          <SelectField
            label="Add a skill"
            selectProps={{
              'aria-label': 'add a skill',
              'data-testid': 'panel-skill-add',
              value: adding,
              disabled: pendingKey !== null,
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
            data-testid="panel-skill-add-submit"
            disabled={pendingKey !== null || adding === ''}
            onClick={() => void patch(adding, { grant: [adding] })}
          >
            Add
          </Button>
        </div>
        {errorText !== null && (
          <span role="alert" data-testid="panel-skills-error" className="text-xs text-tone-blocked">{errorText}</span>
        )}
      </div>
    </DetailsGroup>
  )
}
