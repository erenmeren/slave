'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderKind } from '@ai-team-os/control'
import type { RosterCompany, RosterMemberRow } from '../server/org'
import { sendControl } from '../lib/postControl'
import { ProviderSelect } from './ProviderSelect'
import type { TemplateRow } from './TemplateCatalog'
import { DataTable, Row } from './ui/DataTable'
import { EmptyTile } from './ui/EmptyTile'
import { FieldLabel, GhostButton, INPUT_SHELL, PrimaryButton, SelectField, TextField } from './ui/FormControls'
import { SectionLabel } from './ui/SectionLabel'

/** A row from `listCompanies` (`server/org.ts`) -- no exported type there, so this is the one
 *  place that names the shape. */
export interface CompanyRow {
  readonly id: string
  readonly name: string
}

const MEMBER_COLUMNS = '1fr 110px 160px 140px 120px'
const MEMBER_HEADER = ['Name', 'Role', 'Template', 'Model', 'Provider'] as const

function MemberRow({ member }: { readonly member: RosterMemberRow }): React.JSX.Element {
  return (
    <Row columns={MEMBER_COLUMNS}>
      <span className="truncate text-sm text-text-1">{member.name}</span>
      <span className="truncate text-text-2">{member.role}</span>
      <span className="truncate text-text-2">{member.templateName}</span>
      <span className="font-mono text-xs text-text-2">{member.effectiveModel ?? '—'}</span>
      {/* M12 Task 13 fix round 1, Important finding 3: `effectiveProvider` had no reader here. */}
      <span className="font-mono text-xs text-text-2">{member.effectiveProvider ?? '—'}</span>
    </Row>
  )
}

/** One team's members plus its own "add member" form (template `<select>`, name, optional
 *  model) -- its own pending/error state so a refusal on one team never touches another. */
function TeamBlock({
  companyTeamId,
  teamName,
  members,
  templates,
}: {
  readonly companyTeamId: string
  readonly teamName: string
  readonly members: readonly RosterMemberRow[]
  readonly templates: readonly TemplateRow[]
}): React.JSX.Element {
  const router = useRouter()
  const [templateId, setTemplateId] = useState('')
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [provider, setProvider] = useState<ProviderKind | ''>('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const error = await sendControl('/api/org/agents', {
      method: 'POST',
      body: {
        companyTeamId,
        templateId,
        name,
        // A `provider` never travels without the `model` it names (controller resolution 2):
        // if the operator left the model blank, nothing here is sent even when a provider is
        // selected -- that pairing is the server's to refuse, not this form's to invent.
        ...(model !== '' ? { model, ...(provider !== '' ? { provider } : {}) } : {}),
      },
    })
    if (error === null) {
      router.refresh()
      setTemplateId('')
      setName('')
      setModel('')
      setProvider('')
    } else {
      setErrorText(error)
    }
    setPending(false)
  }

  return (
    <div data-testid="team-block" className="flex flex-col gap-2">
      <SectionLabel>{teamName}</SectionLabel>
      {members.length === 0 ? (
        <p className="text-xs text-text-3">no members yet.</p>
      ) : (
        <DataTable columns={MEMBER_COLUMNS} header={[...MEMBER_HEADER]}>
          {members.map((member) => (
            <MemberRow key={member.companyAgentId} member={member} />
          ))}
        </DataTable>
      )}
      <form
        data-testid="add-member-form"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <SelectField
          label="Template"
          selectProps={
            {
              'aria-label': 'member template',
              'data-testid': 'member-template-select',
              value: templateId,
              onChange: (event) => setTemplateId(event.target.value),
              disabled: pending,
              className: 'w-40',
            } as React.SelectHTMLAttributes<HTMLSelectElement>
          }
        >
          <option value="">select a template</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Name"
          inputProps={
            {
              'aria-label': 'member name',
              'data-testid': 'member-name-input',
              value: name,
              onChange: (event) => setName(event.target.value),
              disabled: pending,
              className: 'w-36',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
        <TextField
          label="Model"
          inputProps={
            {
              'aria-label': 'member model',
              'data-testid': 'member-model-input',
              value: model,
              onChange: (event) => setModel(event.target.value),
              disabled: pending,
              className: 'w-28 font-mono',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
        <label className="flex flex-col gap-1">
          <FieldLabel>Provider</FieldLabel>
          <ProviderSelect
            testId="member-provider-select"
            ariaLabel="member provider"
            value={provider}
            onChange={setProvider}
            disabled={pending}
            placeholder="select a provider"
            className={`w-28 ${INPUT_SHELL}`}
          />
        </label>
        <GhostButton type="submit" data-testid="member-submit" disabled={pending || templateId === '' || name === ''}>
          Add member
        </GhostButton>
        {errorText !== null && (
          <span role="alert" data-testid="member-error" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </form>
    </div>
  )
}

/** An expanded company's teams (each with its members and add-member form) plus the company's own
 *  "add team" form (name only). */
function CompanyDetail({
  companyId,
  teams,
  templates,
}: {
  readonly companyId: string
  readonly teams: RosterCompany['teams']
  readonly templates: readonly TemplateRow[]
}): React.JSX.Element {
  const router = useRouter()
  const [teamName, setTeamName] = useState('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const error = await sendControl('/api/org/teams', { method: 'POST', body: { companyId, name: teamName } })
    if (error === null) {
      router.refresh()
      setTeamName('')
    } else {
      setErrorText(error)
    }
    setPending(false)
  }

  return (
    <div data-testid="company-detail" className="flex flex-col gap-3 border-t border-white/[0.05] pt-3">
      {teams.length === 0 ? (
        <p className="text-xs text-text-3">no teams yet.</p>
      ) : (
        teams.map((team) => (
          <TeamBlock key={team.companyTeamId} companyTeamId={team.companyTeamId} teamName={team.teamName} members={team.members} templates={templates} />
        ))
      )}
      <form
        data-testid="add-team-form"
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <TextField
          label="Team name"
          inputProps={
            {
              'aria-label': 'team name',
              'data-testid': 'team-name-input',
              value: teamName,
              onChange: (event) => setTeamName(event.target.value),
              disabled: pending,
              className: 'w-40',
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
        <GhostButton type="submit" data-testid="team-submit" disabled={pending || teamName === ''}>
          Add team
        </GhostButton>
        {errorText !== null && (
          <span role="alert" data-testid="team-error" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </form>
    </div>
  )
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
