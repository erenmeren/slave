'use client'

import { useMemo, useState } from 'react'
import { PROCESS_SKILL_WARNING, isProcessSkill } from '@slave-of-ai/domain'
import type { SkillCatalogueRow } from '../../server/persons'
import { skillGlyphOf, skillGroupOf, skillSourceTitle, type SkillGroup } from '../../lib/skillSource'
import type { SkillScope } from '../../lib/skillWrites'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { FieldLabel, INPUT_SHELL } from '../ui/FormControls'
import { Segmented } from '../ui/Segmented'

/**
 * Add one skill to a card (workforce cards §3).
 *
 * Grouped by PROVIDER -- "Your skills", "Project", then one group per plugin -- because a plugin is
 * a skill source and not a concept of its own (decision 5): its skills are linked one by one like
 * any other, and the group heading is the only place the plugin is named as a whole.
 *
 * On a PERSON card the scope is asked first and defaults to "Only this person"; "Everyone from
 * <persona>" writes the persona instead, which reaches every person hired from it at once. A
 * person made from nothing has no persona to write, and the picker says so rather than offering a
 * choice that would silently do the same thing as the other.
 *
 * A PROCESS skill (§4) needs an explicit confirm: it is allowed, and the operator decides, but
 * never by a single click that did not show them the sentence. A MISSING skill is listed, greyed,
 * and cannot be chosen -- the route would refuse it (`skill_missing`) and a control that is known to
 * fail is worse than one that is plainly off.
 *
 * Rendered IN-FLOW inside the card, not a `Dialog`/`Sheet` (task brief, spec §3): the Catalog also
 * renders inside the simple-mode hire sheet, whose `z-40` transformed panel a modal `Dialog`
 * (`z-20`, no portal in `ui/`) would draw under, and a nested `Sheet` would be positioned against.
 */
export function SkillPicker({
  catalogue,
  linked,
  scope: scoping,
  pending = false,
  onConfirm,
  onCancel,
}: {
  readonly catalogue: readonly SkillCatalogueRow[]
  /** Skills the card already holds -- shown checked and not offered again. */
  readonly linked: ReadonlySet<string>
  /** `null` on a persona card (the skill always goes to the persona). On a person card, the
   *  persona they were hired from, whose name the second scope option carries -- or null. */
  readonly scope: null | { readonly personaName: string | null }
  readonly pending?: boolean
  readonly onConfirm: (skillId: string, scope: SkillScope) => void
  readonly onCancel: () => void
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [scope, setScope] = useState<SkillScope>('person')
  const [processConfirmed, setProcessConfirmed] = useState(false)

  const groups = useMemo((): readonly { readonly group: SkillGroup; readonly rows: readonly SkillCatalogueRow[] }[] => {
    const needle = search.trim().toLowerCase()
    const byKey = new Map<string, { group: SkillGroup; rows: SkillCatalogueRow[] }>()
    for (const row of catalogue) {
      if (needle !== '' && !row.name.toLowerCase().includes(needle) && !row.description.toLowerCase().includes(needle)) continue
      const group = skillGroupOf(row.providerName)
      const entry = byKey.get(group.key)
      if (entry === undefined) byKey.set(group.key, { group, rows: [row] })
      else entry.rows.push(row)
    }
    return [...byKey.values()]
      .toSorted((a, b) => a.group.order - b.group.order || a.group.label.localeCompare(b.group.label))
      .map((entry) => ({ group: entry.group, rows: entry.rows.toSorted((a, b) => a.name.localeCompare(b.name)) }))
  }, [catalogue, search])

  const chosen = catalogue.find((row) => row.skillId === selected) ?? null
  const chosenIsProcess = chosen !== null && isProcessSkill(chosen)
  const canConfirm = chosen !== null && !pending && (!chosenIsProcess || processConfirmed)
  const scopeOptions: readonly { readonly id: SkillScope; readonly label: string }[] = [
    { id: 'person', label: 'Only this person' },
    { id: 'persona', label: `Everyone from ${scoping?.personaName ?? ''}` },
  ]

  return (
    <div
      data-testid="skill-picker"
      role="group"
      aria-label="Add a skill"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
      className="flex flex-col gap-2 rounded-card border border-line bg-bg-1 p-2"
    >
      {scoping !== null &&
        (scoping.personaName === null ? (
          <p data-testid="skill-picker-scope-none" className="text-xs text-text-3">
            Only this person — they were not hired from a persona.
          </p>
        ) : (
          <Segmented options={scopeOptions} value={scope} onChange={setScope} ariaLabel="Who gets it" testIdPrefix="skill-picker-scope" />
        ))}
      <label className="flex flex-col gap-1">
        <FieldLabel>Find a skill</FieldLabel>
        <input
          data-testid="skill-picker-search"
          aria-label="find a skill"
          value={search}
          placeholder="name or description"
          onChange={(event) => setSearch(event.target.value)}
          className={`w-full ${INPUT_SHELL}`}
        />
      </label>
      <div data-testid="skill-picker-list" className="flex max-h-64 flex-col gap-2 overflow-y-auto">
        {groups.length === 0 && (
          <p data-testid="skill-picker-empty" className="text-xs text-text-3">
            no skill matches
          </p>
        )}
        {groups.map(({ group, rows }) => (
          <div key={group.key} data-testid={`skill-picker-group-${group.key}`} className="flex flex-col gap-0.5">
            <span className="text-[10.5px] uppercase tracking-wide text-text-3">{group.label}</span>
            {rows.map((row) => {
              const isLinked = linked.has(row.skillId)
              return (
                <button
                  key={row.skillId}
                  type="button"
                  data-testid={`skill-picker-option-${row.skillId}`}
                  data-linked={String(isLinked)}
                  data-missing={String(row.missing)}
                  aria-pressed={selected === row.skillId}
                  disabled={isLinked || row.missing}
                  title={
                    row.missing
                      ? 'missing from disk — it cannot be linked until a skills scan finds it again'
                      : skillSourceTitle(row.providerName)
                  }
                  onClick={() => {
                    setSelected(row.skillId)
                    setProcessConfirmed(false)
                  }}
                  className={`flex min-w-0 items-start gap-1.5 rounded-nav px-1.5 py-1 text-left text-xs disabled:cursor-not-allowed disabled:opacity-50 ${
                    selected === row.skillId ? 'bg-sel text-text-1' : 'text-text-2 hover:bg-bg-2'
                  }`}
                >
                  <span aria-hidden="true" className="w-3 shrink-0">
                    {isLinked ? '✓' : ''}
                  </span>
                  <span aria-hidden="true">{skillGlyphOf(row.providerName)}</span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-mono">
                      {row.name}
                      {isProcessSkill(row) ? ' ⚠️' : ''}
                      {row.missing ? ' · missing' : ''}
                    </span>
                    {row.description !== '' && <span className="truncate text-[10.5px] text-text-3">{row.description}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
      {chosenIsProcess && (
        <div className="flex flex-col gap-1">
          <Alert variant="notice" testId="skill-picker-process-warning">
            {PROCESS_SKILL_WARNING}
          </Alert>
          <label className="flex items-center gap-1.5 text-xs text-text-2">
            <input
              type="checkbox"
              data-testid="skill-picker-process-confirm"
              checked={processConfirmed}
              onChange={(event) => setProcessConfirmed(event.target.checked)}
            />
            Add it anyway
          </label>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" data-testid="skill-picker-cancel" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          data-testid="skill-picker-confirm"
          disabled={!canConfirm}
          onClick={() => {
            if (chosen !== null) onConfirm(chosen.skillId, scoping === null ? 'persona' : scope)
          }}
        >
          Add
        </Button>
      </div>
    </div>
  )
}
