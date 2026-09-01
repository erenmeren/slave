'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { RosterCompany } from '../server/org'
import { sendControl } from '../lib/postControl'
import type { TemplateRow } from './TemplateCatalog'
import { CompanyDetail } from './company/CompanyDetail'
import { EmptyTile } from './ui/EmptyTile'
import { PrimaryButton, TextField } from './ui/FormControls'

/** A row from `listCompanies` (`server/org.ts`) -- no exported type there, so this is the one
 *  place that names the shape. */
export interface CompanyRow {
  readonly id: string
  readonly name: string
}

/**
 * Settings' company manager (M11 Task 9 brief): the company list plus its own creation form;
 * expanding a company (its own toggle, one open at a time) shows `CompanyDetail` -- its teams and
 * members from `listRoster`, an add-team form, and each team's add-member form. `EmptyTile` is the
 * "add company" affordance when the list is empty (per brief); the creation form itself stays
 * visible either way, so `EmptyTile`'s click just moves focus into it rather than duplicating it.
 */
export function CompanyManager({
  companies,
  roster,
  templates,
}: {
  readonly companies: readonly CompanyRow[]
  readonly roster: readonly RosterCompany[]
  readonly templates: readonly TemplateRow[]
}): React.JSX.Element {
  const router = useRouter()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const submit = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const error = await sendControl('/api/org/companies', { method: 'POST', body: { name } })
    if (error === null) {
      router.refresh()
      setName('')
    } else {
      setErrorText(error)
    }
    setPending(false)
  }

  const teamsFor = (companyId: string): RosterCompany['teams'] => roster.find((c) => c.companyId === companyId)?.teams ?? []

  return (
    <div className="flex flex-col gap-3">
      {companies.length === 0 ? (
        <EmptyTile label="Add a company" onClick={() => nameInputRef.current?.focus()} />
      ) : (
        <ul className="flex flex-col gap-2">
          {companies.map((company) => {
            const expanded = expandedId === company.id
            return (
              <li key={company.id} data-testid="company-row" className="flex flex-col gap-2 rounded-card border border-line bg-bg-2 p-3">
                <button
                  type="button"
                  data-testid="company-toggle"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : company.id)}
                  className="flex items-center justify-between text-left text-sm text-text-1"
                >
                  {company.name}
                  <span aria-hidden className="text-text-3">
                    {expanded ? '▾' : '▸'}
                  </span>
                </button>
                {expanded && <CompanyDetail companyId={company.id} teams={teamsFor(company.id)} templates={templates} />}
              </li>
            )
          })}
        </ul>
      )}
      <form
        data-testid="company-form"
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
              ref: nameInputRef,
              'aria-label': 'company name',
              'data-testid': 'company-name-input',
              value: name,
              onChange: (event) => setName(event.target.value),
              disabled: pending,
              className: 'w-48',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
        <PrimaryButton type="submit" data-testid="company-submit" disabled={pending || name === ''}>
          Add company
        </PrimaryButton>
        {errorText !== null && (
          <span role="alert" data-testid="company-error" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </form>
    </div>
  )
}
