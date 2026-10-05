'use client'

import { useState } from 'react'
import { PencilIcon, RotateCcwIcon } from 'lucide-react'
import type { ProfileOverridableField, ProfileSpec } from '@slave-of-ai/domain'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { FIELD_WORD, WHAT_FIELDS, WHO_FIELDS, fieldIsEmpty, fieldPatch, fieldText, isListField, plainLine, stepText } from './words'

/** What a profile view may do to a field; absent for a profile that is only read. */
export interface ProfileEditing {
  readonly overridden: readonly ProfileOverridableField[]
  /** Saves one field; answers the refusal's sentence, or null when it was saved. */
  readonly save: (field: ProfileOverridableField, value: string | readonly string[]) => Promise<string | null>
  /** Takes one field back to what the catalogue says. */
  readonly reset: (field: ProfileOverridableField) => Promise<string | null>
}

function FieldValue({ spec, field }: { readonly spec: ProfileSpec; readonly field: ProfileOverridableField }): React.JSX.Element {
  const value = spec[field]
  if (typeof value === 'string') {
    return <p className={cn('text-sm whitespace-pre-wrap', field === 'body' && 'max-h-64 overflow-y-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed')}>{value}</p>
  }
  if (field === 'workflow') {
    return (
      <ol className="flex flex-col gap-1.5 text-sm" data-testid="workflow-steps">
        {value.map((step, index) => (
          <li key={`${String(index)}-${step}`} className="flex gap-2.5">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary tabular-nums">{index + 1}</span>
            <span className="min-w-0">{plainLine(stepText(step))}</span>
          </li>
        ))}
      </ol>
    )
  }
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm marker:text-muted-foreground">
      {value.map((item, index) => (
        <li key={`${String(index)}-${item}`}>{plainLine(item)}</li>
      ))}
    </ul>
  )
}

function FieldEditor({ spec, field, onSave, onCancel }: { readonly spec: ProfileSpec; readonly field: ProfileOverridableField; readonly onSave: (value: string | readonly string[]) => Promise<string | null>; readonly onCancel: () => void }): React.JSX.Element {
  const [text, setText] = useState(fieldText(spec, field))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const list = isListField(field)

  const save = async (): Promise<void> => {
    const patch = fieldPatch(field, text)
    if ('problem' in patch) {
      setProblem(patch.problem)
      return
    }
    setBusy(true)
    const refusal = await onSave(patch.value)
    setBusy(false)
    if (refusal !== null) setProblem(refusal)
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        autoFocus
        aria-label={FIELD_WORD[field]}
        data-testid={`field-editor-${field}`}
        className={cn('text-sm', field === 'body' ? 'min-h-64 font-mono text-xs' : list ? 'min-h-32' : 'min-h-20')}
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          setProblem(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void save()
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-xs text-muted-foreground">{field === 'workflow' ? 'One step per line, in order.' : list ? 'One per line.' : 'Ctrl+Enter saves, Escape cancels.'}</p>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={busy} data-testid={`field-save-${field}`}>
          Save
        </Button>
      </div>
      {problem !== null && (
        <p role="alert" className="text-xs text-destructive" data-testid="field-problem">
          {problem}
        </p>
      )}
    </div>
  )
}

function Field({ spec, field, editing }: { readonly spec: ProfileSpec; readonly field: ProfileOverridableField; readonly editing?: ProfileEditing | undefined }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const empty = fieldIsEmpty(spec, field)
  if (empty && editing === undefined) return null
  const edited = editing?.overridden.includes(field) ?? false

  const reset = async (): Promise<void> => {
    if (editing === undefined) return
    setBusy(true)
    setProblem(await editing.reset(field))
    setBusy(false)
  }

  return (
    <div data-testid={`profile-field-${field}`} data-edited={edited} className="group flex flex-col gap-1.5">
      <div className="flex min-h-6 items-center gap-2">
        <h5 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{FIELD_WORD[field]}</h5>
        {edited && <Badge className="bg-info-muted text-info-foreground">Edited here</Badge>}
        {editing !== undefined && !open && (
          <div className="ml-auto flex items-center gap-1">
            {edited && (
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void reset()} data-testid={`field-reset-${field}`}>
                <RotateCcwIcon />
                Reset to catalogue
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={() => setOpen(true)} data-testid={`field-edit-${field}`}>
              <PencilIcon />
              {empty ? 'Write' : 'Edit'}
            </Button>
          </div>
        )}
      </div>
      {open && editing !== undefined ? (
        <FieldEditor
          spec={spec}
          field={field}
          onCancel={() => setOpen(false)}
          onSave={async (value) => {
            const refusal = await editing.save(field, value)
            if (refusal === null) setOpen(false)
            return refusal
          }}
        />
      ) : empty ? (
        <p className="text-sm text-muted-foreground">Nothing written.</p>
      ) : (
        <FieldValue spec={spec} field={field} />
      )}
      {problem !== null && (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
  )
}

function Part({ title, fields, spec, editing, testId }: { readonly title: string; readonly fields: readonly ProfileOverridableField[]; readonly spec: ProfileSpec; readonly editing?: ProfileEditing | undefined; readonly testId: string }): React.JSX.Element | null {
  const shown = editing === undefined ? fields.filter((field) => !fieldIsEmpty(spec, field)) : fields
  if (shown.length === 0) return null
  return (
    <div data-testid={testId} className="flex flex-col gap-4 rounded-lg border bg-card p-4">
      <h4 className="text-sm font-semibold">{title}</h4>
      {shown.map((field) => (
        <Field key={field} spec={spec} field={field} editing={editing} />
      ))}
    </div>
  )
}

/**
 * A profile in two parts: who somebody is (identity, principles, the rules they keep, how they
 * work with others) and what they do (mission, capabilities, the workflow as numbered steps,
 * deliverables, success criteria). Read-only for a person; with `editing`, each field of a persona
 * has its own Edit and, once edited, its own Reset to catalogue. `skip` leaves fields out that the
 * surrounding screen already shows.
 */
export function ProfileView({ spec, editing, skip = [] }: { readonly spec: ProfileSpec; readonly editing?: ProfileEditing; readonly skip?: readonly ProfileOverridableField[] }): React.JSX.Element {
  const nothing = editing === undefined && [...WHO_FIELDS, ...WHAT_FIELDS].every((field) => fieldIsEmpty(spec, field))
  if (nothing) return <p className="text-sm text-muted-foreground">This persona&apos;s profile is empty.</p>
  return (
    <div className="flex flex-col gap-3" data-testid="profile">
      <Part title="Who they are" fields={WHO_FIELDS.filter((field) => !skip.includes(field))} spec={spec} editing={editing} testId="profile-who" />
      <Part title="What they do" fields={WHAT_FIELDS.filter((field) => !skip.includes(field))} spec={spec} editing={editing} testId="profile-what" />
    </div>
  )
}
