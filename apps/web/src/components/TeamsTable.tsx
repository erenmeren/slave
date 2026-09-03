'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProjectTeamRow } from '../server/org'
import { sendControl } from '../lib/postControl'
import { DataTable, Row } from './ui/DataTable'
import { PrimaryButton, TextField } from './ui/FormControls'

const COLUMNS = '1fr 1fr 90px 170px'
const HEADER = ['Project', 'Name', 'Agents', ''] as const

/** One project team: project + inline-renamable name + agent count + a two-step delete, disabled
 *  (with `title="team has agents"`) while `agentCount > 0` -- `deleteTeam`'s own `team_not_empty`
 *  refusal, named on the button before an operator can even try it. */
function TeamRow({ team }: { readonly team: ProjectTeamRow }): React.JSX.Element {
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
              'aria-label': 'team name',
              'data-testid': 'team-name-input',
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
          data-testid="team-rename"
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
            <PrimaryButton tone="blocked" data-testid="team-delete-confirm" disabled={pending} onClick={() => void remove()}>
              {pending ? 'deleting…' : 'confirm delete'}
            </PrimaryButton>
            <button
              type="button"
              data-testid="team-delete-cancel"
              onClick={() => setConfirmingDelete(false)}
              className="text-xs text-text-3"
            >
              cancel
            </button>
          </>
        ) : (
          <PrimaryButton
            tone="blocked"
            data-testid="team-delete"
            disabled={team.agentCount > 0}
            title={team.agentCount > 0 ? 'team has agents' : undefined}
            onClick={() => setConfirmingDelete(true)}
          >
            delete
          </PrimaryButton>
        )}
        {errorText !== null && (
          <span role="alert" data-testid="team-actions-error" className="text-xs text-tone-blocked">
            {errorText}
          </span>
        )}
      </div>
    </Row>
  )
}

/** The Agents page's Teams tab (M23 D3): every project `Team`, one `DataTable` row per --
 *  project, name, agent count -- fed by `listProjectTeams()`. */
export function TeamsTable({ teams }: { readonly teams: readonly ProjectTeamRow[] }): React.JSX.Element {
  if (teams.length === 0) {
    return <p className="text-xs text-text-3">no teams yet.</p>
  }
  return (
    <DataTable columns={COLUMNS} header={[...HEADER]}>
      {teams.map((team) => (
        <TeamRow key={team.teamId} team={team} />
      ))}
    </DataTable>
  )
}
