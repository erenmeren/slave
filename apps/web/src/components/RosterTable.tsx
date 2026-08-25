'use client'

import { useState } from 'react'
import type { RosterCompany, RosterMemberRow } from '../server/org'
import { toneForStatus } from './AgentsClient'
import { ModelOverrideEditor } from './ModelOverrideEditor'
import { Chip } from './ui/Chip'
import { DataTable, Row } from './ui/DataTable'
import { ProgressBar } from './ui/ProgressBar'
import { SectionLabel } from './ui/SectionLabel'
import { StatusPill } from './ui/StatusPill'

const COLUMNS = '1fr 120px 160px 1fr 28px'
const HEADER = ['Agent', 'Role', 'Template', 'Model', ''] as const

/** The effective-model + `modelSource` chip pair (brief: "effective model + `modelSource` chip
 *  (mono; \"—\" when none)"). `effectiveModel` (`listRoster`'s derivation) is the roster/template
 *  chain ignoring worker overrides, so it can be `null` under `modelSource: 'worker-varies'` too --
 *  a worker overrides its own model while the roster has neither its own model nor a template
 *  default. The "—" fallback below covers every `null` case, not just `'none'`. */
function ModelChain({ member }: { readonly member: RosterMemberRow }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs text-text-1">{member.effectiveModel ?? '—'}</span>
      <Chip>{member.modelSource}</Chip>
    </div>
  )
}

/** One roster member: a `Row` summary (name/role/template chip/model chain) that toggles an
 *  expanded block of its workers underneath -- each with a `ModelOverrideEditor` for that
 *  specific worker's own override (per brief: "`ModelOverrideEditor` per worker"). */
function MemberRow({ member }: { readonly member: RosterMemberRow }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <div data-testid="roster-member">
      <Row columns={COLUMNS}>
        <button
          type="button"
          data-testid="roster-member-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="truncate text-left text-sm text-text-1 hover:text-text-1"
        >
          {member.name}
        </button>
        <span className="truncate text-text-2">{member.role}</span>
        <Chip>{member.templateName}</Chip>
        <ModelChain member={member} />
        <span aria-hidden className="text-text-3">
          {expanded ? '▾' : '▸'}
        </span>
      </Row>
      {expanded && (
        <div data-testid="member-workers" className="flex flex-col gap-2 border-b border-white/[0.05] bg-black/10 py-2 pl-6 pr-3">
          {member.workers.length === 0 ? (
            <p className="text-xs text-text-3">no workers</p>
          ) : (
            member.workers.map((worker) => (
              <div key={worker.agentId} data-testid="roster-worker-row" className="flex flex-wrap items-center gap-3 text-xs">
                <span className="min-w-[100px] truncate text-text-2">{worker.projectName}</span>
                <StatusPill tone={toneForStatus(worker.status)} label={worker.status} />
                <div className="flex min-w-[160px] flex-1 flex-col gap-1">
                  {worker.currentTask !== null ? (
                    <>
                      <span className="truncate text-text-2">{worker.currentTask.title}</span>
                      <ProgressBar pct={worker.currentTask.pct} />
                    </>
                  ) : (
                    <span className="text-text-3">—</span>
                  )}
                </div>
                <span className="font-mono text-text-3">{worker.model ?? '—'}</span>
                <ModelOverrideEditor agentId={worker.agentId} model={worker.model} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** The Roster tab (M11 Task 8 brief): `DataTable` grouped company -> team, `SectionLabel` group
 *  headers, one `DataTable` per team so its rows line up under that team's own header row. */
export function RosterTable({ roster }: { readonly roster: readonly RosterCompany[] }): React.JSX.Element {
  if (roster.length === 0) {
    return <p className="text-xs text-text-3">no companies yet.</p>
  }

  return (
    <div className="flex flex-col gap-5">
      {roster.map((company) => (
        <div key={company.companyId} data-testid="roster-company" className="flex flex-col gap-2">
          <SectionLabel>{company.companyName}</SectionLabel>
          {company.teams.map((team) => (
            <div key={team.companyTeamId} data-testid="roster-team" className="flex flex-col gap-1">
              <SectionLabel>{team.teamName}</SectionLabel>
              <DataTable columns={COLUMNS} header={[...HEADER]}>
                {team.members.map((member) => (
                  <MemberRow key={member.companyAgentId} member={member} />
                ))}
              </DataTable>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
