'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderKind } from '@slave-of-ai/control'
import { sendControl } from '../../lib/postControl'
import { FieldLabel, INPUT_SHELL, TextField } from '../ui/FormControls'
import { ModelSelect } from '../ModelSelect'
import { ProviderSelect } from '../ProviderSelect'
import { Button } from '../ui/Button'

/** A row from `listTemplates` (`server/org.ts`) -- no exported type there when this was written,
 *  so this is the one place that names the shape `CompanyManager.tsx`'s add-member template
 *  `<select>`, `company/CompanyDetail.tsx`, `company/TeamBlock.tsx` and `slaves/NewSlaveDrawer.tsx`
 *  all import rather than re-declaring. `CatalogRowView` (M46) is a strict superset of it. */
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
  /** How many catalog slaves use this template (M27 §5.1) -- the catalog row's `template-delete`
   *  confirm names it before `deleteSlaveTemplate` cascades them. */
  readonly catalogSlaveCount: number
  /** M42 §2: provenance, present only on an imported template. Optional for the same reason
   *  `defaultProvider` is -- the M11 fixtures that build a `TemplateRow` by hand predate it. */
  readonly sourceId?: string | null
  readonly sourceDivision?: string | null
  readonly importedAt?: string | null
}

/**
 * Adding a template by hand (M11 Task 9, moved here by M46 R6).
 *
 * The Workforce Catalog replaced the TABLE this form used to sit under, not the form: a template
 * an operator types in has no persona file to be mapped from, and `gate:m11-shell` drives exactly
 * these fields on `/workforce?tab=catalog`. Every testid is the one it had.
 *
 * Truth from snapshot, unchanged: a 200 clears the form and `router.refresh()`s; a 409/400 renders
 * inline beside the form and leaves it as typed, the `AssignCompanyDialog` refusal idiom. What is
 * new is `onCreated`, called beside `router.refresh()` -- the rows are fetched from
 * `/api/org/catalog` now, not handed down as a page prop, so refreshing the page alone would not
 * put the new row on screen.
 */
export function TemplateForm({ onCreated }: { readonly onCreated?: () => void }): React.JSX.Element {
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
    const error = await sendControl('/api/org/templates', {
      method: 'POST',
      body: {
        name,
        role,
        ...(description !== '' ? { description } : {}),
        // A `defaultProvider` never travels without a `defaultModel` beside it (controller
        // resolution 3, the `CompanyManager` idiom): if the operator left the model blank,
        // nothing here is sent even when a provider is selected.
        ...(defaultModel !== '' ? { defaultModel, ...(defaultProvider !== '' ? { defaultProvider } : {}) } : {}),
      },
    })
    if (error === null) {
      router.refresh()
      onCreated?.()
      setName('')
      setRole('')
      setDescription('')
      setDefaultModel('')
      setDefaultProvider('')
    } else {
      setErrorText(error)
    }
    setPending(false)
  }

  return (
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
      <label className="flex flex-col gap-1">
        <FieldLabel>Default model</FieldLabel>
        <ModelSelect
          provider={defaultProvider}
          value={defaultModel}
          onChange={setDefaultModel}
          disabled={pending}
          ariaLabel="template default model"
          inputTestId="template-default-model-input"
          className="w-32"
        />
      </label>
      <Button variant="primary" size="sm" type="submit" data-testid="template-submit" disabled={pending || name === '' || role === ''}>
        Add template
      </Button>
      {errorText !== null && (
        <span role="alert" data-testid="template-error" className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}
    </form>
  )
}
