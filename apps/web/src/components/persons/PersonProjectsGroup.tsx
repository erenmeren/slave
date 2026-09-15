'use client'

import { useState } from 'react'
import type { PersonSeatRow } from '../../server/persons'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { DetailsGroup } from '../ui/DetailsGroup'
import { SelectField } from '../ui/FormControls'

export interface AssignableProject {
  readonly workspaceId: string
  readonly projectName: string
  readonly teams: readonly { readonly teamId: string; readonly name: string }[]
}

export function assignableProjectsOf(
  teams: readonly { readonly teamId: string; readonly name: string; readonly workspaceId: string; readonly projectName: string }[],
): readonly AssignableProject[] {
  const byWorkspace = new Map<string, { workspaceId: string; projectName: string; teams: { teamId: string; name: string }[] }>()
  for (const team of teams) {
    const existing = byWorkspace.get(team.workspaceId)
    if (existing === undefined) {
      byWorkspace.set(team.workspaceId, {
        workspaceId: team.workspaceId,
        projectName: team.projectName,
        teams: [{ teamId: team.teamId, name: team.name }],
      })
    } else {
      existing.teams.push({ teamId: team.teamId, name: team.name })
    }
  }
  return [...byWorkspace.values()]
}

/**
 * The person panel's Projects group (M58 R23): every seat this person holds, what they are on each
 * one, and the two acts that change it -- "remove from project" per seat, and "assign to project"
 * below.
 *
 * REMOVE IS NOT DELETE, and the copy says so: the seat closes and its runs, messages and
 * permissions stay. Delete lives at the bottom of the panel, behind a confirmation that states how
 * many projects it takes (R13) -- two different acts, two different places, deliberately.
 */
export function PersonProjectsGroup({
  personId,
  seats,
  projects,
  onChanged,
}: {
  readonly personId: string
  readonly seats: readonly PersonSeatRow[]
  readonly projects: readonly AssignableProject[]
  readonly onChanged: () => void
}): React.JSX.Element {
  const [workspaceId, setWorkspaceId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const teams = projects.find((project) => project.workspaceId === workspaceId)?.teams ?? []

  const send = async (url: string, body: unknown): Promise<void> => {
    setPending(true)
    setErrorText(null)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        const payload: unknown = await response.json().catch(() => null)
        setErrorText(
          payload !== null && typeof payload === 'object' && 'error' in payload
            ? String((payload as { error: unknown }).error)
            : 'that could not be done',
        )
        return
      }
      onChanged()
    } finally {
      setPending(false)
    }
  }

  return (
    <div data-testid="panel-projects-group">
      <DetailsGroup group="projects" title="Projects" defaultOpen>
        <div className="flex flex-col gap-2">
          {seats.length === 0 && <p className="text-xs text-text-3">in the pool — on no project yet</p>}
          {seats.map((seat) => (
            <div
              key={seat.slaveId}
              data-testid={`panel-seat-${seat.slaveId}`}
              data-team-id={seat.teamId}
              className={`flex items-center justify-between gap-2 ${seat.closedAt === null ? '' : 'opacity-60'}`}
            >
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                <span className="truncate text-xs text-text-1">{seat.projectName}</span>
                <span className="truncate text-[10.5px] text-text-3">{seat.teamName}</span>
                <Chip title={seat.role}>{seat.role}</Chip>
                {seat.runtimeRoles.map((role) => (
                  <Chip key={role} testId="panel-seat-runtime-role" title={role}>{role}</Chip>
                ))}
              </span>
              {seat.closedAt === null && (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`panel-seat-remove-${seat.slaveId}`}
                  disabled={pending}
                  onClick={() => void send(`/api/persons/${personId}/unassign`, { teamId: seat.teamId, reason: 'removed from the project' })}
                >
                  remove from project
                </Button>
              )}
            </div>
          ))}

          <div className="flex flex-wrap items-end gap-2 border-t border-line pt-2">
            <SelectField
              label="Assign to project"
              selectProps={{
                'aria-label': 'assign to project',
                'data-testid': 'panel-assign-project',
                value: workspaceId,
                disabled: pending,
                onChange: (event) => { setWorkspaceId(event.target.value); setTeamId('') },
              } as React.SelectHTMLAttributes<HTMLSelectElement>}
            >
              <option value="">select a project</option>
              {projects.map((project) => (
                <option key={project.workspaceId} value={project.workspaceId}>{project.projectName}</option>
              ))}
            </SelectField>
            <SelectField
              label="Department"
              selectProps={{
                'aria-label': 'assign to department',
                'data-testid': 'panel-assign-team',
                value: teamId,
                disabled: pending || workspaceId === '',
                onChange: (event) => setTeamId(event.target.value),
              } as React.SelectHTMLAttributes<HTMLSelectElement>}
            >
              <option value="">select a department</option>
              {teams.map((team) => (
                <option key={team.teamId} value={team.teamId}>{team.name}</option>
              ))}
            </SelectField>
            <Button
              variant="primary"
              size="sm"
              data-testid="panel-assign-submit"
              disabled={pending || teamId === ''}
              onClick={() => void send(`/api/persons/${personId}/assign`, { teamId })}
            >
              Assign
            </Button>
          </div>
          {errorText !== null && (
            <span role="alert" data-testid="panel-projects-error" className="text-xs text-tone-blocked">{errorText}</span>
          )}
        </div>
      </DetailsGroup>
    </div>
  )
}
