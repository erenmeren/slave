'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderKind } from '@ai-team-os/control'
import { Chip } from './ui/Chip'
import { DataTable, Row } from './ui/DataTable'
import { FieldLabel, INPUT_SHELL, PrimaryButton, TextField } from './ui/FormControls'
import { ProviderSelect } from './ProviderSelect'

/** A row from `listTemplates` (`server/org.ts`) -- no exported type there, so this is the one
 *  place that names the shape; `CompanyManager.tsx`'s add-member template `<select>` imports it
 *  from here rather than re-declaring it. */
export interface TemplateRow {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly description: string
  readonly defaultModel: string | null
  // Optional, not required: the M11 fixtures/tests that build a `TemplateRow` by hand predate
  // this field (M12 Task 13) and are not this task's to rewrite (Series A freeze) -- `undefined`
  // reads the same as "no default provider recorded" everywhere this is consumed.
  readonly defaultProvider?: ProviderKind | null
}

const COLUMNS = '1fr 110px 2fr 140px 120px'
const HEADER = ['Name', 'Role', 'Description', 'Default model', 'Default provider'] as const

/** Pulls a 409 refusal's `{ error }` text, falling back to something nameable for any other
 *  non-2xx or malformed body -- the `errorMessage` idiom `AssignCompanyDialog.tsx`/
 *  `ModelOverrideEditor.tsx` already use, copied rather than imported (a small local copy is the
 *  house pattern here, not a shared control-plane module). */
function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return `request failed (${status})`
}

/**
 * Settings' template catalog (M11 Task 9 brief): the template list (name, role chip, description,
 * default model mono) plus its own creation form -- name/role/description/default model, all
 * controlled inputs. Truth from snapshot: a 200 clears the form and `router.refresh()`s (the
 * refreshed `templates` prop is what actually shows the new row); a 409/400 renders inline beside
 * the form and leaves it as typed, the `AssignCompanyDialog` refusal idiom.
 */
export function TemplateCatalog({ templates }: { readonly templates: readonly TemplateRow[] }): React.JSX.Element {
  const router = useRouter()
  const [name, setName] = useState('')
  const [role, setRole] = useState('')
  const [description, setDescription] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [defaultProvider, setDefaultProvider] = useState<ProviderKind | ''>('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    try {
      const response = await fetch('/api/org/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          role,
          ...(description !== '' ? { description } : {}),
          // A `defaultProvider` never travels without a `defaultModel` beside it (controller
          // resolution 3, the `CompanyManager` idiom): if the operator left the model blank,
          // nothing here is sent even when a provider is selected.
          ...(defaultModel !== '' ? { defaultModel, ...(defaultProvider !== '' ? { defaultProvider } : {}) } : {}),
        }),
      })
      if (response.ok) {
        router.refresh()
        setName('')
        setRole('')
        setDescription('')
        setDefaultModel('')
        setDefaultProvider('')
        return
      }
      const data: unknown = await response.json().catch(() => null)
      setErrorText(errorMessage(data, response.status))
    } catch (cause) {
      setErrorText(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {templates.length === 0 ? (
        <p className="text-xs text-text-3">no templates yet.</p>
      ) : (
        <DataTable columns={COLUMNS} header={[...HEADER]}>
          {templates.map((template) => (
            <Row key={template.id} columns={COLUMNS}>
              <span className="truncate text-sm text-text-1">{template.name}</span>
              <Chip>{template.role}</Chip>
              <span className="truncate text-text-2">{template.description}</span>
              <span className="font-mono text-xs text-text-2">{template.defaultModel ?? '—'}</span>
              {/* M12 Task 13 fix round 1, Important finding 3: half a pair was legible, half was
               *  not -- `defaultProvider` had no reader anywhere on this surface. */}
              <span className="font-mono text-xs text-text-2">{template.defaultProvider ?? '—'}</span>
            </Row>
          ))}
        </DataTable>
      )}
      <form
        data-testid="template-form"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <TextField
          label="Name"
          inputProps={
            {
              'aria-label': 'template name',
              'data-testid': 'template-name-input',
              value: name,
              onChange: (event) => setName(event.target.value),
              disabled: pending,
              className: 'w-36',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
        <TextField
          label="Role"
          inputProps={
            {
              'aria-label': 'template role',
              'data-testid': 'template-role-input',
              value: role,
              onChange: (event) => setRole(event.target.value),
              disabled: pending,
              className: 'w-28',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
        <TextField
          label="Description"
          inputProps={
            {
              'aria-label': 'template description',
              'data-testid': 'template-description-input',
              value: description,
              onChange: (event) => setDescription(event.target.value),
              disabled: pending,
              className: 'w-48',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
        <TextField
          label="Default model"
          inputProps={
            {
              'aria-label': 'template default model',
              'data-testid': 'template-default-model-input',
              value: defaultModel,
              onChange: (event) => setDefaultModel(event.target.value),
              disabled: pending,
              className: 'w-32 font-mono',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
        <label className="flex flex-col gap-1">
          <FieldLabel>Default provider</FieldLabel>
          <ProviderSelect
            testId="template-default-provider-select"
            ariaLabel="template default provider"
            value={defaultProvider}
            onChange={setDefaultProvider}
            disabled={pending}
            placeholder="select a provider"
            className={`w-32 ${INPUT_SHELL}`}
          />
        </label>
        <PrimaryButton type="submit" data-testid="template-submit" disabled={pending || name === '' || role === ''}>
          Add template
        </PrimaryButton>
        {errorText !== null && (
          <span role="alert" data-testid="template-error" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </form>
    </div>
  )
}
