'use client'

import { useEffect, useState } from 'react'
import {
  MAPPING_QUALITY_LABEL,
  PROFILE_FIELD_KIND,
  PROFILE_FIELD_LABEL,
  PROFILE_OVERRIDABLE_FIELDS,
  PROFILE_SPEC_FIELDS,
  type ProfileOverridableField,
  type ProfileSpec,
  type ProfileSpecField,
} from '@slave-of-ai/domain'
import type { TemplateProfileView } from '@slave-of-ai/control'
import { sendControl } from '../../lib/postControl'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { DetailsGroup, type DetailsGroupName } from '../ui/DetailsGroup'
import { Drawer } from '../ui/Drawer'
import { EmptyState } from '../ui/EmptyState'
import { LoadingState } from '../ui/LoadingState'
import { INPUT_SHELL } from '../ui/FormControls'

/** Which `DetailsGroup` each profile field renders inside. `runtimeRole` joins `identity` -- it is
 *  the one field the renderer never puts in a prompt (plan erratum E3), and it belongs beside who
 *  the worker is rather than in a group of its own. `body` is Advanced: it is the persona's own
 *  remaining prose, and the rendered Markdown under Advanced is where a person reads it. */
const GROUP_BY_FIELD: Record<ProfileSpecField, DetailsGroupName> = {
  identity: 'identity',
  summary: 'identity',
  runtimeRole: 'identity',
  mission: 'mission',
  capabilities: 'capabilities',
  expertise: 'expertise',
  operatingPrinciples: 'principles',
  constraints: 'constraints',
  workflow: 'workflow',
  deliverables: 'deliverables',
  successCriteria: 'success',
  collaborationHints: 'collaboration',
  recommendedSkills: 'skills',
  body: 'advanced',
}

/** The order R6 names, and the title each group carries. Exhaustive by construction: a group added
 *  to `DetailsGroupName` and not to this list simply does not render, and a title missing from it
 *  fails the build. */
const GROUPS: readonly { readonly group: DetailsGroupName; readonly title: string }[] = [
  { group: 'identity', title: 'Identity' },
  { group: 'mission', title: 'Mission' },
  { group: 'capabilities', title: 'Capabilities' },
  { group: 'expertise', title: 'Expertise' },
  { group: 'principles', title: 'Principles' },
  { group: 'constraints', title: 'Constraints' },
  { group: 'workflow', title: 'Workflow' },
  { group: 'deliverables', title: 'Deliverables' },
  { group: 'success', title: 'Success criteria' },
  { group: 'collaboration', title: 'Collaboration' },
  { group: 'skills', title: 'Skills' },
  { group: 'source', title: 'Source' },
]

const isOverridable = (field: ProfileSpecField): field is ProfileOverridableField =>
  (PROFILE_OVERRIDABLE_FIELDS as readonly string[]).includes(field)

const toText = (spec: ProfileSpec, field: ProfileSpecField): string => {
  const value = spec[field]
  return typeof value === 'string' ? value : value.join('\n')
}

/** One textarea per field, one item per line for a list. Not a chip editor: a list of short lines
 *  IS a textarea to anybody who has edited one, and a bespoke widget would be a second place for
 *  the 240-character rule to be enforced differently from the schema. */
const fromText = (field: ProfileSpecField, text: string): string | string[] =>
  PROFILE_FIELD_KIND[field] === 'text'
    ? text.trim()
    : text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')

/**
 * One template's specialist profile, opened from a catalog row (M46 R6).
 *
 * Read mode shows twelve `DetailsGroup`s, open -- this drawer IS the "on demand" half of D3, so a
 * person who asked for the whole spec should not have to ask twelve more times. `Advanced` is the
 * one group that starts closed, because it holds the raw text rather than the reading of it.
 *
 * `Customise` turns each OVERRIDABLE field into a textarea with its own Save and, where it is
 * overridden, its own Reset -- one field at a time (D5), because a "save everything" button would
 * send fields nobody touched and make every one of them an override. `runtimeRole` gets no editor
 * at all: it is not in `PROFILE_OVERRIDABLE_FIELDS` (plan erratum E21), so a Save beside it would
 * be a control that answers 409 every time it is pressed.
 *
 * The raw Markdown lives under `Advanced` and only there. It is the text a run is actually given,
 * and putting the editor for it beside the structured fields would invite an operator to edit both
 * and lose one: the two do NOT compose -- whichever was written last is what a run sees -- so a
 * raw override that stands is announced as REPLACING the rendered profile, with the way back out
 * beside the button that made it.
 */
export function ProfileDrawer({
  templateId,
  name,
  onClose,
  onChanged,
}: {
  readonly templateId: string
  readonly name: string
  readonly onClose: () => void
  readonly onChanged: () => void
}): React.JSX.Element {
  const [state, setState] = useState<
    { readonly kind: 'loading' } | { readonly kind: 'error' } | { readonly kind: 'ready'; readonly view: TemplateProfileView }
  >({ kind: 'loading' })
  const [customising, setCustomising] = useState(false)
  const [drafts, setDrafts] = useState<Partial<Record<ProfileSpecField, string>>>({})
  const [rawDraft, setRawDraft] = useState<string | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  /**
   * Re-read WITHOUT falling back to `loading` (fix, observed): every group in this drawer keeps
   * its own open/closed state, and unmounting them for the length of a refetch folded `Advanced`
   * shut the instant an operator saved something inside it -- the affordance to undo a raw
   * override disappeared under the click that made one. The previous answer stays on screen until
   * the new one lands; the first load starts in `loading` because that is this state's initial
   * value, not because this function sets it.
   */
  const load = (): void => {
    void fetch(`/api/org/templates/${templateId}/profile`)
      .then(async (response) => (response.ok ? ((await response.json()) as TemplateProfileView) : null))
      .then((view) => {
        setState(view === null ? { kind: 'error' } : { kind: 'ready', view })
        setDrafts({})
        setRawDraft(null)
      })
      .catch(() => setState({ kind: 'error' }))
  }

  useEffect(load, [templateId])

  const after = (error: string | null): void => {
    setErrorText(error)
    if (error === null) {
      load()
      onChanged()
    }
  }

  const saveField = async (field: ProfileOverridableField, spec: ProfileSpec): Promise<void> => {
    const text = drafts[field] ?? toText(spec, field)
    after(
      await sendControl(`/api/org/templates/${templateId}/overrides`, {
        method: 'PATCH',
        body: { patch: { [field]: fromText(field, text) } },
      }),
    )
  }

  const view = state.kind === 'ready' ? state.view : null
  const spec = view?.effective ?? null

  const field = (name_: ProfileSpecField, current: ProfileSpec, overridden: readonly string[]): React.JSX.Element => {
    const isOver = overridden.includes(name_)
    const value = current[name_]
    const editable = customising && isOverridable(name_)
    return (
      <div key={name_} data-testid={`profile-field-${name_}`} data-overridden={isOver} className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-3">
          {PROFILE_FIELD_LABEL[name_]}
          {isOver && <Chip testId={`profile-field-overridden-${name_}`}>customised</Chip>}
        </span>
        {editable && isOverridable(name_) ? (
          <>
            <textarea
              data-testid={`profile-field-input-${name_}`}
              aria-label={PROFILE_FIELD_LABEL[name_]}
              rows={PROFILE_FIELD_KIND[name_] === 'text' ? 2 : 4}
              value={drafts[name_] ?? toText(current, name_)}
              onChange={(event) => {
                const next = event.target.value
                setDrafts((now) => ({ ...now, [name_]: next }))
              }}
              className={`w-full ${INPUT_SHELL}`}
            />
            <span className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                data-testid={`profile-field-save-${name_}`}
                onClick={() => void saveField(name_, current)}
              >
                Save
              </Button>
              {isOver && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`profile-field-reset-${name_}`}
                  onClick={() => {
                    void sendControl(`/api/org/templates/${templateId}/overrides/${name_}`, { method: 'DELETE' }).then(after)
                  }}
                >
                  Reset
                </Button>
              )}
            </span>
          </>
        ) : typeof value === 'string' ? (
          <p className="whitespace-pre-wrap text-xs text-text-2">{value === '' ? '—' : value}</p>
        ) : value.length === 0 ? (
          <p className="text-xs text-text-3">—</p>
        ) : (
          <ul className="flex list-disc flex-col gap-0.5 pl-4 text-xs text-text-2">
            {value.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <Drawer open onClose={onClose} label={`Profile of ${name}`} testId="profile-drawer" width="w-[640px]">
      <div className="flex items-center justify-between gap-2">
        <h2 data-testid="profile-drawer-title" className="text-sm text-text-1">
          {name}
        </h2>
        {spec !== null && (
          <Button variant="ghost" size="sm" data-testid="profile-customise" onClick={() => setCustomising((now) => !now)}>
            {customising ? 'Done' : 'Customise'}
          </Button>
        )}
      </div>

      {state.kind === 'loading' && <LoadingState testId="profile-loading" message="opening this profile…" />}
      {state.kind === 'error' && (
        <Alert variant="error" testId="profile-load-error">
          could not open this profile. Try the row again.
        </Alert>
      )}
      {errorText !== null && (
        <Alert variant="error" testId="profile-error">
          {errorText}
        </Alert>
      )}

      {view !== null && spec === null && (
        <EmptyState
          testId="profile-unstructured"
          message="This template has not been mapped into a specialist profile: import its catalog, or write its profile under Advanced."
        />
      )}

      {view !== null &&
        spec !== null &&
        GROUPS.map(({ group, title }) => (
          <DetailsGroup key={group} group={group} title={title} defaultOpen>
            {group === 'source'
              ? (() => {
                  const source = spec.source
                  if (source === null) return <span className="text-xs text-text-3">made here; no source record.</span>
                  return (
                    <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-xs text-text-2">
                      <dt className="text-text-3">Repository</dt>
                      <dd className="font-mono">{source.repository}</dd>
                      <dt className="text-text-3">Path</dt>
                      <dd className="font-mono">{source.path}</dd>
                      <dt className="text-text-3">Revision</dt>
                      <dd className="font-mono">{source.revision ?? 'not a git checkout'}</dd>
                      <dt className="text-text-3">Licence</dt>
                      <dd className="font-mono">{source.license ?? 'none recorded'}</dd>
                      <dt className="text-text-3">Imported</dt>
                      <dd className="font-mono">{source.importedAt.slice(0, 10)}</dd>
                      <dt className="text-text-3">Mapping</dt>
                      {/* docs/ia.md rule 3: the word comes from the domain's own table, the raw
                        * value stays one attribute away. */}
                      <dd data-mapping-quality={source.mappingQuality} title={source.mappingQuality}>
                        {MAPPING_QUALITY_LABEL[source.mappingQuality]}
                      </dd>
                    </dl>
                  )
                })()
              : PROFILE_SPEC_FIELDS.filter((member) => GROUP_BY_FIELD[member] === group).map((member) =>
                  field(member, spec, view.overridden),
                )}
          </DetailsGroup>
        ))}

      {view !== null && (
        <DetailsGroup group="advanced" title="Advanced">
          {view.rawOverride && (
            <Alert variant="notice" testId="profile-raw-override-notice">
              this profile was written by hand. It replaces the rendered profile above until it is
              removed, and an import will skip this row for as long as it stands.
            </Alert>
          )}
          <span className="text-[10px] uppercase tracking-wide text-text-3">What a run is given</span>
          <pre
            data-testid="profile-markdown"
            className="max-h-64 overflow-auto whitespace-pre-wrap rounded-tile border border-line bg-bg-1 p-2 font-mono text-[11px] text-text-2"
          >
            {view.markdown ?? '(no profile)'}
          </pre>
          <span className="text-[10px] uppercase tracking-wide text-text-3">Raw override</span>
          <textarea
            data-testid="profile-raw-input"
            aria-label="raw profile Markdown"
            rows={6}
            value={rawDraft ?? view.markdown ?? ''}
            onChange={(event) => setRawDraft(event.target.value)}
            className={`w-full ${INPUT_SHELL}`}
          />
          <span className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="profile-raw-save"
              onClick={() => {
                void sendControl(`/api/org/templates/${templateId}/profile`, {
                  method: 'PUT',
                  body: { profile: rawDraft ?? view.markdown ?? '' },
                }).then(after)
              }}
            >
              Save raw override
            </Button>
            {view.rawOverride && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="profile-raw-clear"
                onClick={() => {
                  void sendControl(`/api/org/templates/${templateId}/profile`, {
                    method: 'PUT',
                    body: { profile: null },
                  }).then(after)
                }}
              >
                Clear it
              </Button>
            )}
          </span>
          <span className="text-xs text-text-3">
            Saving here replaces the rendered profile with your words until you clear it, and the
            next import will skip this template rather than overwrite them. Clearing it leaves this
            template without a profile until its catalog is imported again or a field above is
            saved.
          </span>
        </DetailsGroup>
      )}
    </Drawer>
  )
}
