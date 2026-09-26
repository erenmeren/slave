'use client'

import { useEffect, useState } from 'react'
import {
  PROCESS_SKILL_WARNING,
  capabilityLabel,
  isProcessSkill,
  skillSourceOf,
  type CapabilityRecord,
  type WorkflowPreview,
} from '@slave-of-ai/domain'
import { byCardOrder, type CardSkillRow } from '../../lib/cardSkills'
import type { SkillCatalogueRow } from '../../server/persons'
import { plural } from '../../lib/plural'
import { sendControl } from '../../lib/postControl'
import { skillGlyphOf, skillSourceTitle } from '../../lib/skillSource'
import {
  addSkillWrite,
  removeSkillWrite,
  restoreSkillWrite,
  type SkillScope,
  type SkillTarget,
  type SkillWrite,
} from '../../lib/skillWrites'
import { Alert } from '../ui/Alert'
import { AvatarTile } from '../ui/AvatarTile'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Chip } from '../ui/Chip'
import type { StatusTone } from '../ui/StatusPill'
import { SkillPicker } from './SkillPicker'

/**
 * The card grid (spec §2). An INLINE style rather than a Tailwind class, so `gate:m14-fidelity` can
 * read the authored template back off `style.gridTemplateColumns` the way it read the table's.
 *
 * `minmax(min(320px, 100%), 1fr)` rather than a plain `minmax(320px, 1fr)` (controller ruling F9):
 * a bare `320px` floor forces horizontal scroll on any viewport narrower than that, and `min(…,
 * 100%)` lets the track shrink to the viewport instead once it cannot fit 320px.
 */
export const CARD_GRID_COLUMNS = 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))'

/** How many specialty chips a card shows before `+N` -- the catalog row's own number. */
export const CARD_SPECIALTIES = 3

/** How many skill chips a card shows before `+N` (spec §2); the full list is in the drawer. */
export const CARD_SKILLS = 6

const ORIGIN_LABEL: Record<CardSkillRow['state'], string> = {
  persona: 'from persona',
  person: 'this person only',
  revoked: 'revoked',
}

const stop = (event: React.SyntheticEvent): void => event.stopPropagation()

/**
 * What a card's write DID, handed to `onChanged` (controller ruling F2) so the row's owner -- a
 * page of persona or person rows, Tasks 8/9 -- can patch THIS row's `skills` in place instead of
 * re-reading the whole list from page one: `added`/`restored` carry the `CardSkillRow` the card now
 * shows (the same shape `PersonCardRow.skills`/the catalog row's `skills` already store, so it drops
 * straight into a `.map` over the page's rows), `removed` carries the id that dropped off, and
 * `refused` carries nothing to patch -- the chip already rolled itself back on this card -- but is
 * still reported, because a refusal (a race with another edit, a skill gone missing from disk since
 * the page loaded) means the row's cached data cannot be trusted either, and only a re-read settles
 * that.
 */
export type SkillWriteOutcome =
  | { readonly kind: 'added' | 'restored'; readonly skill: CardSkillRow }
  | { readonly kind: 'removed'; readonly skillId: string }
  | { readonly kind: 'refused' }

/** The Catalog and People tabs' shared layout (spec §2): cards flow onto {@link CARD_GRID_COLUMNS}'s
 *  auto-fill track instead of each tab hand-rolling its own grid wrapper. */
export function WorkforceCardGrid({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <div data-testid="workforce-card-grid" className="grid gap-[var(--gap-2)]" style={{ gridTemplateColumns: CARD_GRID_COLUMNS }}>
      {children}
    </div>
  )
}

/**
 * One persona or one person as a CARD (workforce cards §2): who, what they are good at, which skills
 * they carry and where each came from, and the first steps of how they work -- with a skill one
 * click away ("+ skill") instead of one drawer away.
 *
 * The WHOLE card opens the existing drawer (`ProfileDrawer` for a persona, the person sheet for a
 * person) -- which is why the root is a plain `<div>` and not `ui/Card`'s button mode: the chips'
 * remove controls, "+ skill" and the Hirable toggle are buttons inside it, and a button inside a
 * button is not a thing a screen reader can describe. The keyboard path is the name, a real button
 * with the caller's own testid (`catalog-open-<id>` / `person-open`, the two a gate already drives).
 *
 * Writes are OPTIMISTIC and roll back: a chip appears (or disappears) on the click, the route is
 * asked, and a refusal puts the chip back and prints the route's own sentence on the card. On
 * success `onChanged` hands the row's owner a `SkillWriteOutcome` describing exactly what changed,
 * so a page of many rows patches only this one instead of re-reading from page one (F2); on a
 * refusal the outcome carries nothing to patch, but the caller is still told, because a refusal is
 * itself a reason to re-read -- the row's cached data cannot be trusted either. A fresh `skills`
 * prop, however it arrives, replaces every optimistic change, because it IS what those changes did.
 *
 * Nothing on the card is hidden by mode (`docs/ia.md` rule 2); developer mode is only DENSER, through
 * the `--gap-*` tokens `globals.css` shrinks under `:root[data-mode='developer']`.
 */
export function WorkforceCard({
  variant,
  testId,
  data,
  dimmed = false,
  tone,
  name,
  subtitle,
  summary,
  division,
  divisionTitle,
  capabilityKeys,
  capabilityText = [],
  taxonomy,
  skills,
  workflow,
  target,
  catalogue,
  openTestId,
  onOpen,
  onChanged,
  header,
  footer,
}: {
  readonly variant: 'persona' | 'person'
  /** The wrapper's testid -- `catalog-row-<id>` or `person-row-<id>`, the handles gates drive. */
  readonly testId: string
  readonly data?: Readonly<Record<`data-${string}`, string>>
  /** A released person reads as finished (M50 R3): greyed, still a card, still opens. */
  readonly dimmed?: boolean
  readonly tone: StatusTone
  readonly name: string
  readonly subtitle?: string | null
  readonly summary?: string
  readonly division: string | null
  /** The raw value behind the division chip, one hover away (M44 R5). */
  readonly divisionTitle?: string
  readonly capabilityKeys: readonly string[]
  /** Free-text capabilities, shown when a row has no taxonomy keys (an unmapped persona). */
  readonly capabilityText?: readonly string[]
  readonly taxonomy: readonly CapabilityRecord[]
  readonly skills: readonly CardSkillRow[]
  readonly workflow: WorkflowPreview
  readonly target: SkillTarget
  readonly catalogue: readonly SkillCatalogueRow[]
  readonly openTestId: string
  readonly onOpen: () => void
  /** Told after every write settles -- see {@link SkillWriteOutcome} for what it carries and why. */
  readonly onChanged: (outcome: SkillWriteOutcome) => void
  readonly header?: React.ReactNode
  readonly footer?: React.ReactNode
}): React.JSX.Element {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [added, setAdded] = useState<readonly CardSkillRow[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [removing, setRemoving] = useState<CardSkillRow | null>(null)

  useEffect(() => {
    setHidden(new Set())
    setAdded([])
  }, [skills])

  const visible = [...skills.filter((skill) => !hidden.has(skill.skillId)), ...added].toSorted(byCardOrder)
  const linked = new Set(visible.filter((skill) => skill.state !== 'revoked').map((skill) => skill.skillId))
  const specialties = capabilityKeys.length > 0 ? capabilityKeys.map((key) => capabilityLabel(key, taxonomy)) : capabilityText
  const chipPrefix = variant === 'persona' ? 'catalog' : 'person'

  const hide = (skillId: string): void => setHidden((current) => new Set([...current, skillId]))
  const unhide = (skillId: string): void =>
    setHidden((current) => new Set([...current].filter((one) => one !== skillId)))
  const unadd = (skillId: string): void => setAdded((current) => current.filter((one) => one.skillId !== skillId))

  const run = async (write: SkillWrite, rollback: () => void, success: SkillWriteOutcome): Promise<void> => {
    setPending(true)
    setError(null)
    const refusal = await sendControl(write.url, { method: 'PATCH', body: write.body })
    setPending(false)
    if (refusal !== null) {
      rollback()
      setError(refusal)
      onChanged({ kind: 'refused' })
      return
    }
    onChanged(success)
  }

  const add = (skillId: string, scope: SkillScope): void => {
    const row = catalogue.find((one) => one.skillId === skillId)
    if (row === undefined) return
    setPicking(false)
    const toPersona = target.kind === 'persona' || (scope === 'persona' && target.personaId !== null)
    // A struck-through chip for the same skill gives way to the one being added.
    hide(skillId)
    const chip: CardSkillRow = {
      skillId,
      name: row.name,
      providerName: row.providerName,
      missing: row.missing,
      process: isProcessSkill(row),
      state: toPersona ? 'persona' : 'person',
    }
    setAdded((current) => [...current, chip])
    void run(
      addSkillWrite(target, skillId, scope),
      () => {
        unadd(skillId)
        unhide(skillId)
      },
      { kind: 'added', skill: chip },
    )
  }

  const remove = (skill: CardSkillRow, scope: SkillScope): void => {
    setRemoving(null)
    hide(skill.skillId)
    void run(removeSkillWrite(target, skill, scope), () => unhide(skill.skillId), { kind: 'removed', skillId: skill.skillId })
  }

  const restore = (skill: CardSkillRow): void => {
    if (target.kind !== 'person') return
    hide(skill.skillId)
    const restored: CardSkillRow = { ...skill, state: 'persona' }
    setAdded((current) => [...current, restored])
    void run(
      restoreSkillWrite(target, skill.skillId),
      () => {
        unadd(skill.skillId)
        unhide(skill.skillId)
      },
      { kind: 'restored', skill: restored },
    )
  }

  /** Removing an INHERITED skill on a person card is two different acts -- this person only (a
   *  revoke) or everyone from the persona (the persona loses it) -- so it asks. Anything else has
   *  one meaning and goes straight through. */
  const onRemove = (skill: CardSkillRow): void => {
    if (target.kind === 'person' && skill.state === 'persona' && target.personaId !== null) setRemoving(skill)
    else remove(skill, 'person')
  }

  const skillChip = (skill: CardSkillRow): React.JSX.Element => {
    const struck = skill.state === 'revoked'
    return (
      <span
        key={skill.skillId}
        data-testid={`card-skill-${skill.skillId}`}
        data-source={skillSourceOf(skill.providerName).kind}
        data-origin={skill.state}
        data-process={String(skill.process)}
        data-missing={String(skill.missing)}
        title={skill.missing ? `${skill.name} — missing from disk` : skill.name}
        className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-pill border px-2 py-0.5 text-xs ${
          struck
            ? 'border-line text-text-3'
            : skill.missing
              ? 'border-line bg-bg-1 text-text-3 opacity-60'
              : 'border-line bg-bg-2 text-text-2'
        }`}
      >
        <span data-testid="card-skill-glyph" aria-hidden="true" title={skillSourceTitle(skill.providerName)}>
          {skillGlyphOf(skill.providerName)}
        </span>
        <span data-testid="card-skill-name" className={`min-w-0 truncate font-mono ${struck ? 'line-through' : ''}`.trim()}>
          {skill.name}
        </span>
        {skill.process && (
          <span data-testid="card-skill-process" role="img" aria-label="process skill" title={PROCESS_SKILL_WARNING}>
            ⚠️
          </span>
        )}
        {variant === 'person' && (
          <span data-testid="card-skill-origin" className="shrink-0 text-[10px] text-text-3">
            {ORIGIN_LABEL[skill.state]}
          </span>
        )}
        <span onClick={stop} className="shrink-0">
          {struck ? (
            <button
              type="button"
              data-testid={`card-skill-restore-${skill.skillId}`}
              aria-label={`restore ${skill.name}`}
              disabled={pending}
              onClick={() => restore(skill)}
              className="text-text-3 hover:text-text-1"
            >
              ↺
            </button>
          ) : (
            <button
              type="button"
              data-testid={`card-skill-remove-${skill.skillId}`}
              aria-label={`remove ${skill.name}`}
              disabled={pending}
              onClick={() => onRemove(skill)}
              className="text-text-3 hover:text-text-1"
            >
              ×
            </button>
          )}
        </span>
      </span>
    )
  }

  return (
    <div data-testid={testId} {...data} onClick={onOpen} className={`min-w-0 cursor-pointer ${dimmed ? 'opacity-60' : ''}`.trim()}>
      <Card testId="workforce-card" data={{ 'data-variant': variant }} className="h-full min-w-0">
        <div className="flex min-w-0 items-start gap-[var(--gap-1)]">
          <AvatarTile name={name} tone={tone} size="md" />
          <span className="flex min-w-0 flex-1 flex-col">
            <button
              type="button"
              data-testid={openTestId}
              aria-label={`open ${name}`}
              onClick={(event) => {
                // Once: the wrapper's own `onClick` would open it a second time.
                event.stopPropagation()
                onOpen()
              }}
              className="truncate text-left text-sm font-semibold text-text-1 hover:text-text-2"
            >
              {name}
            </button>
            {subtitle !== undefined && subtitle !== null && <span className="truncate text-[11.5px] text-text-2">{subtitle}</span>}
          </span>
          {division !== null && (
            <Chip testId="card-division" {...(divisionTitle === undefined ? {} : { title: divisionTitle })}>
              {division}
            </Chip>
          )}
        </div>
        {header}
        {summary !== undefined && summary !== '' && <p className="line-clamp-2 text-xs text-text-2">{summary}</p>}
        {specialties.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center gap-1">
            {specialties.slice(0, CARD_SPECIALTIES).map((label, index) => (
              <Chip key={`${String(index)}-${label}`} testId={`${chipPrefix}-capability-chip`}>
                {label}
              </Chip>
            ))}
            {specialties.length > CARD_SPECIALTIES && (
              <span data-testid={`${chipPrefix}-capability-more`} className="text-[10px] text-text-3">
                +{specialties.length - CARD_SPECIALTIES}
              </span>
            )}
          </div>
        )}
        <div data-testid="card-skills" className="flex min-w-0 flex-wrap items-center gap-1">
          {visible.length === 0 && (
            <span data-testid="card-skills-empty" className="text-xs text-text-3">
              no skills yet
            </span>
          )}
          {visible.slice(0, CARD_SKILLS).map(skillChip)}
          {visible.length > CARD_SKILLS && (
            <span data-testid="card-skills-more" className="text-[10px] text-text-3">
              +{visible.length - CARD_SKILLS}
            </span>
          )}
          <span onClick={stop}>
            <button
              type="button"
              data-testid="card-skill-add"
              aria-expanded={picking}
              disabled={pending}
              onClick={() => setPicking(!picking)}
              className="rounded-pill border border-dashed border-line px-2 py-0.5 text-xs text-text-3 hover:text-text-1"
            >
              + skill
            </button>
          </span>
        </div>
        {removing !== null && target.kind === 'person' && (
          <div data-testid="card-skill-remove-scope" onClick={stop} className="flex flex-wrap items-center gap-1 text-xs text-text-2">
            <span>{`Remove ${removing.name} from:`}</span>
            <Button variant="ghost" size="sm" data-testid="card-skill-remove-scope-person" onClick={() => remove(removing, 'person')}>
              Only this person
            </Button>
            <Button variant="ghost" size="sm" data-testid="card-skill-remove-scope-persona" onClick={() => remove(removing, 'persona')}>
              {`Everyone from ${target.personaName ?? 'the persona'}`}
            </Button>
            <Button variant="ghost" size="sm" data-testid="card-skill-remove-scope-cancel" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
          </div>
        )}
        {picking && (
          <div onClick={stop}>
            <SkillPicker
              catalogue={catalogue}
              linked={linked}
              scope={target.kind === 'person' ? { personaName: target.personaName } : null}
              pending={pending}
              onConfirm={add}
              onCancel={() => setPicking(false)}
            />
          </div>
        )}
        {error !== null && (
          <div onClick={stop}>
            <Alert variant="error" testId="card-skill-error">
              {error}
            </Alert>
          </div>
        )}
        <div data-testid="card-workflow" className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[10.5px] uppercase tracking-wide text-text-3">Workflow</span>
          {workflow.total === 0 ? (
            <span data-testid="card-workflow-empty" className="text-xs text-text-3">
              No workflow in this profile
            </span>
          ) : (
            <ol className="flex min-w-0 flex-col gap-0.5">
              {workflow.steps.map((step, index) => (
                <li key={`${String(index)}-${step}`} data-testid="card-workflow-step" className="truncate text-xs text-text-2">
                  {`${String(index + 1)}. ${step}`}
                </li>
              ))}
            </ol>
          )}
          {workflow.total > workflow.steps.length && (
            <span data-testid="card-workflow-more" className="text-[10.5px] text-text-3">
              {`+${plural(workflow.total - workflow.steps.length, 'step')}`}
            </span>
          )}
        </div>
        {footer !== undefined && (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-[10.5px] text-text-3">
            {footer}
          </div>
        )}
      </Card>
    </div>
  )
}
