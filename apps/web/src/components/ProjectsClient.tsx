'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AgentStatus } from '@ai-team-os/domain'
import { CARD_STATE_TONE, cardStateForAgent, type CardState } from '../lib/tones'
import type { ProjectRow } from '../server/org'
import { AssignCompanyDialog } from './AssignCompanyDialog'
import { AvatarTile } from './ui/AvatarTile'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { Chip } from './ui/Chip'
import { ProgressBar } from './ui/ProgressBar'
import { StatStrip } from './ui/StatStrip'
import { StatusPill } from './ui/StatusPill'

interface CompanyOption {
  readonly id: string
  readonly name: string
}

/** The M11 plan's Projects status mapping (Task 7 brief), rebuilt onto the shared `CardState`
 *  vocabulary for the handoff card (M14 Task 13): halted overrides everything else, then any
 *  in-flight task work reads as "working" (RUNNING), and an assigned-but-quiet project reads as
 *  idle. Only three of `CardState`'s ten members are ever reachable from a project -- the other
 *  seven describe an individual agent's run, which a project has none of itself. */
function statusOf(project: ProjectRow): CardState {
  if (project.halted) return 'blocked'
  if (project.taskCounts.active > 0) return 'working'
  return 'idle'
}

/** The handoff's own project-card wording (spec §5.6) -- "Halted / Running / Idle" -- which
 *  differs from `CARD_STATE_TONE`'s generic per-state labels ("BLOCKED" reads as a task fact, not
 *  a project one). Partial, not total: `statusOf` only ever returns these three states, and the
 *  `?? label` fallback below exists for the type checker, not for a reachable case. */
const STATUS_LABEL: Partial<Record<CardState, string>> = { blocked: 'HALTED', working: 'RUNNING', idle: 'IDLE' }

function ProjectCard({
  project,
  companies,
  assigning,
  onAssign,
  onCloseAssign,
}: {
  readonly project: ProjectRow
  readonly companies: readonly CompanyOption[]
  readonly assigning: boolean
  readonly onAssign: () => void
  readonly onCloseAssign: () => void
}): React.JSX.Element {
  const router = useRouter()
  const state = statusOf(project)
  const { tone, label, pulse } = CARD_STATE_TONE[state]
  const pct = project.taskCounts.total > 0 ? Math.round((project.taskCounts.done / project.taskCounts.total) * 100) : 0
  // `Button` isn't a `forwardRef` component -- this wraps it so the dialog has an element to
  // return focus to on Escape (`EmergencyStopButton.tsx`'s trigger-refocus idiom), without
  // touching the shared `ui/` component to add ref forwarding it doesn't otherwise need.
  const triggerWrapRef = useRef<HTMLDivElement>(null)

  return (
    <div data-testid="project-card" className="flex flex-col gap-2">
      <Card onClick={() => router.push(`/w/${project.id}`)}>
        <div className="flex items-start gap-[9px]">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-[6px]">
              <span className="truncate text-[14px] font-semibold tracking-[-.2px]">{project.name}</span>
              <Chip>{project.companyName ?? 'no company'}</Chip>
            </div>
            <div data-testid="project-description" className="mt-[2px] truncate text-[11px] text-[#7c8697]">
              {project.goal ?? 'no goal set'}
            </div>
          </div>
          <StatusPill tone={tone} label={STATUS_LABEL[state] ?? label} pulse={pulse} />
        </div>

        <div aria-label="team" className="mt-[13px] flex flex-wrap items-center gap-1">
          {project.team.slice(0, 6).map((member) => (
            <AvatarTile
              key={member.agentId}
              name={member.name}
              tone={CARD_STATE_TONE[cardStateForAgent(member.status as AgentStatus)].tone}
            />
          ))}
          {project.team.length > 6 && (
            <span
              data-testid="team-overflow"
              title={project.team.slice(6).map((member) => member.name).join(', ')}
              className="flex h-[28px] w-[28px] items-center justify-center rounded-tile border border-line bg-bg-2 font-mono text-[10px] text-text-2"
            >
              +{project.team.length - 6}
            </span>
          )}
        </div>

        <div className="mt-[14px]">
          <ProgressBar pct={pct} tone={tone} />
        </div>
        <div className="mt-[5px] flex justify-between font-mono text-[10px] text-text-3">
          <span>progress</span>
          <span>{pct}%</span>
        </div>

        <div className="mt-[14px]">
          {/* The caveat rides INSIDE the spend tile, as `StatStripItem.note` (M14 fix wave, queue
            * item (f)) -- exactly where `TopStrip` nests its own `strip-unmeasured`. It is never
            * folded into the figure (Decision 4), and the strip stays exactly 4-up, which is the
            * handoff's own geometry. */}
          <StatStrip
            items={[
              { label: 'agents', value: String(project.workerCount) },
              { label: 'active', value: String(project.taskCounts.active), ...(project.taskCounts.active > 0 ? { tone: 'working' as const } : {}) },
              { label: 'blocked', value: String(project.taskCounts.blocked), ...(project.taskCounts.blocked > 0 ? { tone: 'blocked' as const } : {}) },
              {
                label: 'spend',
                value: `$${project.spend.toFixed(2)}`,
                ...(project.unmeasuredRuns > 0
                  ? {
                      note: (
                        <span data-testid="project-unmeasured" className="font-mono text-[9.5px] text-status-warn">
                          {project.unmeasuredRuns} run{project.unmeasuredRuns === 1 ? '' : 's'} unmeasured
                        </span>
                      ),
                    }
                  : {}),
              },
            ]}
          />
        </div>
      </Card>
      {project.companyName === null && (
        <div ref={triggerWrapRef} className="w-full">
          <Button
            variant="ghost"
            className="w-full"
            data-testid="assign-company-button"
            onClick={(event) => {
              event.stopPropagation()
              onAssign()
            }}
          >
            Assign company
          </Button>
        </div>
      )}
      {assigning && (
        <AssignCompanyDialog workspaceId={project.id} companies={companies} onClose={onCloseAssign} triggerRef={triggerWrapRef} />
      )}
    </div>
  )
}

export function ProjectsClient({
  projects,
  companies,
}: {
  readonly projects: readonly ProjectRow[]
  readonly companies: readonly CompanyOption[]
}): React.JSX.Element {
  const [assigningWorkspaceId, setAssigningWorkspaceId] = useState<string | null>(null)

  return (
    <div className="grid grid-cols-1 gap-[14px] p-[18px_20px] md:grid-cols-3">
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          companies={companies}
          assigning={assigningWorkspaceId === project.id}
          onAssign={() => setAssigningWorkspaceId(project.id)}
          onCloseAssign={() => setAssigningWorkspaceId(null)}
        />
      ))}
    </div>
  )
}
