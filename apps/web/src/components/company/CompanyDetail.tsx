'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { RosterCompany } from '../../server/org'
import { sendControl } from '../../lib/postControl'
import type { TemplateRow } from '../TemplateCatalog'
import { GhostButton, TextField } from '../ui/FormControls'
import { TeamBlock } from './TeamBlock'

/** An expanded company's teams (each with its members and add-member form) plus the company's own
 *  "add team" form (name only). */
export function CompanyDetail({
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
