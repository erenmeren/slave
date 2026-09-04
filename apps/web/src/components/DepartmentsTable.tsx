'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProjectTeamRow } from '../server/org'
import { sendControl } from '../lib/postControl'
import { DataTable, Row } from './ui/DataTable'
import { PrimaryButton, SelectField, TextField } from './ui/FormControls'

const COLUMNS = '1fr 1fr 90px 170px'
const HEADER = ['Project', 'Department', 'Agents', ''] as const

/** One project department: project + inline-renamable name + agent count + a two-step delete,
 *  disabled (with `title="department has agents"`) while `agentCount > 0` -- `deleteTeam`'s own
 *  `team_not_empty` refusal, named on the button before an operator can even try it. */
function DepartmentRow({ team }: { readonly team: ProjectTeamRow }): React.JSX.Element {
  const router = useRouter()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(team.name)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  // Guarded by `pending`, the same reason `AgentRowActions.commit` is: Enter and blur each call
  // this independently, and a field that fails to commit stays open for a retry.
  const commitRename = async (): Promise<void> => {
    if (pending) return
    setPending(true)
    setErrorText(null)
    const error = await sendControl(`/api/teams/${team.teamId}/name`, { method: 'PUT', body: { name: draft } })
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
    const error = await sendControl(`/api/teams/${team.teamId}`, { method: 'DELETE' })
    setPending(false)
    setConfirmingDelete(false)
    if (error === null) {
      router.refresh()
    } else {
      setErrorText(error)
    }
  }

  return (
    <Row columns={COLUMNS}>
      <span className="truncate text-text-2">{team.projectName}</span>
      {renaming ? (
        <TextField
          inputProps={
            {
              'aria-label': 'department name',
              'data-testid': 'department-rename-input',
              value: draft,
              autoFocus: true,
              disabled: pending,
              onChange: (event) => setDraft(event.target.value),
              onBlur: () => void commitRename(),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void commitRename()
              },
            } as React.InputHTMLAttributes<HTMLInputElement>
          }
        />
      ) : (
        <button
          type="button"
          data-testid="department-rename"
          onClick={() => {
            setDraft(team.name)
            setErrorText(null)
            setRenaming(true)
          }}
          className="truncate text-left text-sm text-text-1 hover:text-text-1"
        >
          {team.name}
        </button>
      )}
      <span className="text-text-2">{team.agentCount}</span>
      <div className="flex items-center gap-2">
        {confirmingDelete ? (
          <>
            <PrimaryButton tone="blocked" data-testid="department-delete-confirm" disabled={pending} onClick={() => void remove()}>
              {pending ? 'deleting…' : 'confirm delete'}
            </PrimaryButton>
            <button
              type="button"
              data-testid="department-delete-cancel"
              onClick={() => setConfirmingDelete(false)}
              className="text-xs text-text-3"
            >
              cancel
            </button>
          </>
        ) : (
          <PrimaryButton
            tone="blocked"
            data-testid="department-delete"
            disabled={team.agentCount > 0}
            title={team.agentCount > 0 ? 'department has agents' : undefined}
            onClick={() => setConfirmingDelete(true)}
          >
            delete
          </PrimaryButton>
        )}
        {errorText !== null && (
          <span role="alert" data-testid="department-actions-error" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </div>
    </Row>
  )
}

/** The Departments tab's own "New department" form (M25 §4.2): a project `<select>` (defaulting
 *  to the first workspace) plus a name field, `POST /api/w/:id/teams` on submit -- disabled with
 *  a hint when the install has no project to attach a department to yet. */
function NewDepartmentForm({ workspaces }: { readonly workspaces: readonly { id: string; name: string }[] }): React.JSX.Element {
  const router = useRouter()
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? '')
  const [name, setName] = useState('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const none = workspaces.length === 0

  const submit = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    const error = await sendControl(`/api/w/${workspaceId}/teams`, { method: 'POST', body: { name } })
    setPending(false)
    if (error === null) {
      setName('')
      router.refresh()
    } else {
      setErrorText(error)
    }
  }

  return (
    <form
      data-testid="department-form"
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <SelectField
        label="Project"
        selectProps={{
          'aria-label': 'department project',
          'data-testid': 'department-project-select',
          value: workspaceId,
          onChange: (event) => setWorkspaceId(event.target.value),
          disabled: pending || none,
          className: 'w-44',
        } as React.SelectHTMLAttributes<HTMLSelectElement>}
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </SelectField>
      <TextField
        label="Department"
        inputProps={{
          'aria-label': 'new department name',
          'data-testid': 'department-name-input',
          value: name,
          onChange: (event) => setName(event.target.value),
          disabled: pending || none,
          className: 'w-44',
        } as React.InputHTMLAttributes<HTMLInputElement>}
      />
      <PrimaryButton type="submit" data-testid="department-submit" disabled={pending || none || name === ''}>
        New department
      </PrimaryButton>
      {none && <span className="text-xs text-text-3">attach a project first</span>}
      {errorText !== null && (
        <span role="alert" data-testid="department-error" className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}
    </form>
  )
}

/** The Agents page's Departments tab (M23 D3, renamed in M25 §4.2): the "New department" form
 *  above every project `Team` row, one `DataTable` row per -- project, name, agent count -- fed
 *  by `listProjectTeams()`. */
export function DepartmentsTable({
  teams,
  workspaces,
}: {
  readonly teams: readonly ProjectTeamRow[]
  readonly workspaces: readonly { id: string; name: string }[]
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <NewDepartmentForm workspaces={workspaces} />
      {teams.length === 0 ? (
        <p className="text-xs text-text-3">no departments yet.</p>
      ) : (
        <DataTable columns={COLUMNS} header={[...HEADER]}>
          {teams.map((team) => (
            <DepartmentRow key={team.teamId} team={team} />
          ))}
        </DataTable>
      )}
    </div>
  )
}
