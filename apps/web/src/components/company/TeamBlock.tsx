'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProviderKind } from '@slave-of-ai/control'
import type { RosterMemberRow } from '../../server/org'
import { plural } from '../../lib/plural'
import { sendControl } from '../../lib/postControl'
import { ProviderSelect } from '../ProviderSelect'
import { ModelSelect } from '../ModelSelect'
import { SlaveRowActions } from '../SlaveRowActions'
import type { TemplateRow } from '../workforce/TemplateForm'
import { DangerConfirm } from '../ui/DangerConfirm'
import { DataTable, Row } from '../ui/DataTable'
import { FieldLabel, INPUT_SHELL, SelectField, TextField } from '../ui/FormControls'
import { SectionLabel } from '../ui/SectionLabel'
import { Button } from '../ui/Button'

export const MEMBER_COLUMNS = '1fr 110px 160px 140px 120px 120px'
export const MEMBER_HEADER = ['Name', 'Role', 'Template', 'Model', 'Provider', ''] as const

/** One catalog slave's row: name/role/template/model/provider, then a `catalog-slave-delete`
 *  (M27 §5.1) -- `SlaveRowActions`' `catalog` branch, the same one `AllSlavesTable`'s catalog row
 *  renders, so this reuses it rather than hand-rolling a second `DangerConfirm` for the same
 *  delete. `slaveId`/`role`/`runCount` are unused by that branch (see its own docstring); this
 *  passes `member.companySlaveId` as the dummy `slaveId` the same way `AllSlavesTable` does. */
export function MemberRow({ member }: { readonly member: RosterMemberRow }): React.JSX.Element {
  return (
    <Row columns={MEMBER_COLUMNS}>
      <span className="truncate text-sm text-text-1">{member.name}</span>
      <span className="truncate text-text-2">{member.role}</span>
      <span className="truncate text-text-2">{member.templateName}</span>
      <span className="font-mono text-xs text-text-2">{member.effectiveModel ?? '—'}</span>
      {/* M12 Task 13 fix round 1, Important finding 3: `effectiveProvider` had no reader here. */}
      <span className="font-mono text-xs text-text-2">{member.effectiveProvider ?? '—'}</span>
      <SlaveRowActions name={member.name} role={member.role} pool={{ personId: member.personId }} />
    </Row>
  )
}

/** One department template's header (inline rename; delete -- M27 §5.1) plus its members and its
 *  own "add member" form -- its own pending/error state so a refusal on one department template's
 *  RENAME never touches another (the delete's pending/error is `DangerConfirm`'s own).
 *  `deleteCompanyTeam` no longer refuses a non-empty department template -- it cascades the
 *  template's memberships along with it -- so the delete is always enabled; its confirm names that
 *  cascade instead of a disabled button naming a refusal that no longer exists.
 *
 *  M58 R5: a department holds PEOPLE, so the form picks one from those the installation already
 *  has rather than typing a name and a template. The persona, the model and the provider left with
 *  the roster row -- they are the PERSON's, edited where the person is (Task 5's own surface). */
export function TeamBlock({
  companyTeamId,
  teamName,
  members,
  people,
}: {
  readonly companyTeamId: string
  readonly teamName: string
  readonly members: readonly RosterMemberRow[]
  /** Everybody this installation has, by id and name -- the add-member `<select>`'s options. */
  readonly people: readonly { readonly personId: string; readonly name: string }[]
}): React.JSX.Element {
  const router = useRouter()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(teamName)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [personId, setPersonId] = useState('')
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

  const submit = async (): Promise<void> => {
    setMemberPending(true)
    setMemberErrorText(null)
    const error = await sendControl('/api/org/slaves', { method: 'POST', body: { companyTeamId, personId } })
    if (error === null) {
      router.refresh()
      setPersonId('')
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
        <DangerConfirm
          label="delete"
          testId="department-template-delete"
          confirmText={`deletes ${teamName} and its ${plural(members.length, 'membership')}; the slaves and the project departments stay`}
          onConfirm={async () => {
            const error = await sendControl(`/api/org/teams/${companyTeamId}`, { method: 'DELETE' })
            if (error === null) router.refresh()
            return error
          }}
        />
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
            <MemberRow key={member.personId} member={member} />
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
          label="Slave"
          selectProps={
            {
              'aria-label': 'member slave',
              'data-testid': 'member-person-select',
              value: personId,
              onChange: (event) => setPersonId(event.target.value),
              disabled: memberPending,
              className: 'w-52',
            } as React.SelectHTMLAttributes<HTMLSelectElement>
          }
        >
          <option value="">select a slave</option>
          {people.map((person) => (
            <option key={person.personId} value={person.personId}>
              {person.name}
            </option>
          ))}
        </SelectField>
        <Button variant="ghost" size="sm" type="submit" data-testid="member-submit" disabled={memberPending || personId === ''}>
          Add member
        </Button>
        {memberErrorText !== null && (
          <span role="alert" data-testid="member-error" className="text-xs text-tone-blocked">
            {memberErrorText}
          </span>
        )}
      </form>
    </div>
  )
}
