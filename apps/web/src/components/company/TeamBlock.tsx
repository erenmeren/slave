'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderKind } from '@ai-team-os/control'
import type { RosterMemberRow } from '../../server/org'
import { sendControl } from '../../lib/postControl'
import { ProviderSelect } from '../ProviderSelect'
import { ModelSelect } from '../ModelSelect'
import type { TemplateRow } from '../TemplateCatalog'
import { DataTable, Row } from '../ui/DataTable'
import { FieldLabel, GhostButton, INPUT_SHELL, SelectField, TextField } from '../ui/FormControls'
import { SectionLabel } from '../ui/SectionLabel'

export const MEMBER_COLUMNS = '1fr 110px 160px 140px 120px'
export const MEMBER_HEADER = ['Name', 'Role', 'Template', 'Model', 'Provider'] as const

export function MemberRow({ member }: { readonly member: RosterMemberRow }): React.JSX.Element {
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

/** One department template's header (inline rename, delete-when-empty -- M25 §4.3) plus its
 *  members and its own "add member" form (template `<select>`, name, provider `<select>`,
 *  optional model via a `ModelSelect` fed by that provider) -- its own pending/error state so a
 *  refusal on one department template never touches another. */
export function TeamBlock({
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
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(teamName)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [templateId, setTemplateId] = useState('')
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [provider, setProvider] = useState<ProviderKind | ''>('')
  const [memberPending, setMemberPending] = useState(false)
  const [memberErrorText, setMemberErrorText] = useState<string | null>(null)

  // Guarded by `pending`, the same reason `DepartmentsTable`'s row is: Enter and blur each call
  // this independently, and a field that fails to commit stays open for a retry.
  const commitRename = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setErrorText(null)
    const error = await sendControl(`/api/org/teams/${companyTeamId}/name`, { method: 'PUT', body: { name: draft } })
    setPending(false)
    if (error === null) {
      setRenaming(false)
      router.refresh()
    } else {
      setErrorText(error)
    }
  }

  const remove = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const error = await sendControl(`/api/org/teams/${companyTeamId}`, { method: 'DELETE' })
    setPending(false)
    if (error === null) {
      router.refresh()
    } else {
      setErrorText(error)
    }
  }

  const submit = async (): Promise<void> => {
    setMemberPending(true)
    setMemberErrorText(null)
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
      setMemberErrorText(error)
    }
    setMemberPending(false)
  }

  return (
    <div data-testid="department-template-block" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {renaming ? (
          <TextField
            inputProps={{
              'aria-label': 'department template name',
              'data-testid': 'department-template-rename-input',
              value: draft,
              autoFocus: true,
              disabled: pending,
              onChange: (event) => setDraft(event.target.value),
              onBlur: () => void commitRename(),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void commitRename()
                if (event.key === 'Escape') setRenaming(false)
              },
              className: 'w-44',
            } as React.InputHTMLAttributes<HTMLInputElement>}
          />
        ) : (
          <button
            type="button"
            data-testid="department-template-rename"
            onClick={() => {
              setDraft(teamName)
              setErrorText(null)
              setRenaming(true)
            }}
            className="text-left"
          >
            <SectionLabel>{teamName}</SectionLabel>
          </button>
        )}
        <GhostButton
          type="button"
          data-testid="department-template-delete"
          disabled={pending || members.length > 0}
          title={members.length > 0 ? 'department template has members' : undefined}
          onClick={() => void remove()}
        >
          delete
        </GhostButton>
        {errorText !== null && (
          <span role="alert" data-testid="department-template-error" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </div>
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
              disabled: memberPending,
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
              disabled: memberPending,
              className: 'w-36',
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
            disabled={memberPending}
            placeholder="select a provider"
            className={`w-28 ${INPUT_SHELL}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <FieldLabel>Model</FieldLabel>
          <ModelSelect
            provider={provider}
            value={model}
            onChange={setModel}
            disabled={memberPending}
            ariaLabel="member model"
            inputTestId="member-model-input"
            className="w-40"
          />
        </label>
        <GhostButton type="submit" data-testid="member-submit" disabled={memberPending || templateId === '' || name === ''}>
          Add member
        </GhostButton>
        {memberErrorText !== null && (
          <span role="alert" data-testid="member-error" className="text-xs text-tone-blocked">
            {memberErrorText}
          </span>
        )}
      </form>
    </div>
  )
}
