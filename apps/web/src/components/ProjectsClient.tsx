'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ProjectRow } from '../server/org'
import { AssignCompanyDialog } from './AssignCompanyDialog'
import { Button } from './ui/Button'
import { Card } from './ui/Card'
import { Chip } from './ui/Chip'
import { ProgressBar } from './ui/ProgressBar'
import { StatStrip } from './ui/StatStrip'
import { StatusPill } from './ui/StatusPill'
import type { StatusTone } from './ui/StatusPill'

interface CompanyOption {
  readonly id: string
  readonly name: string
}

/** The M11 plan's Projects status mapping (Task 7 brief): halted overrides everything else, then
 *  any in-flight task work reads as "working", and an assigned-but-quiet project reads as idle. */
function statusOf(project: ProjectRow): { readonly tone: StatusTone; readonly label: string } {
  if (project.halted) return { tone: 'blocked', label: 'Halted' }
  if (project.taskCounts.active > 0) return { tone: 'working', label: 'Working' }
  return { tone: 'idle', label: 'Idle' }
}

function ProjectCard({
  project,
  onAssign,
}: {
  readonly project: ProjectRow
  readonly onAssign: () => void
}): React.JSX.Element {
  const router = useRouter()
  const { tone, label } = statusOf(project)
  const pct = project.taskCounts.total > 0 ? Math.round((project.taskCounts.done / project.taskCounts.total) * 100) : 0

  return (
    <div className="flex flex-col gap-2">
      <Card onClick={() => router.push(`/w/${project.id}`)}>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-text-1">{project.name}</span>
          <Chip>{project.companyName ?? 'no company'}</Chip>
        </div>
        <div className="flex items-center justify-between gap-2">
          <StatusPill tone={tone} label={label} />
          {project.workerCount > 0 && (
            <div aria-label="workers" className="flex flex-wrap justify-end gap-1">
              {Array.from({ length: project.workerCount }, (_, index) => (
                <span
                  key={index}
                  data-testid="worker-avatar"
                  className="flex h-5 w-5 items-center justify-center rounded-full border border-line bg-bg-2 font-mono text-[9px] text-text-2"
                >
                  {index + 1}
                </span>
              ))}
            </div>
          )}
        </div>
        <ProgressBar pct={pct} tone={tone === 'blocked' ? 'blocked' : 'working'} />
        <StatStrip
          items={[
            { label: 'Workers', value: String(project.workerCount) },
            { label: 'Active', value: String(project.taskCounts.active), ...(project.taskCounts.active > 0 ? { tone: 'working' as const } : {}) },
            { label: 'Blocked', value: String(project.taskCounts.blocked), ...(project.taskCounts.blocked > 0 ? { tone: 'blocked' as const } : {}) },
            { label: 'Spend', value: `$${project.spend.toFixed(2)}` },
          ]}
        />
      </Card>
      {project.companyName === null && (
        <Button
          variant="ghost"
          data-testid="assign-company-button"
          onClick={(event) => {
            event.stopPropagation()
            onAssign()
          }}
        >
          Assign company
        </Button>
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
    <>
      <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
        {projects.map((project) => (
          <ProjectCard key={project.id} project={project} onAssign={() => setAssigningWorkspaceId(project.id)} />
        ))}
      </div>
      {assigningWorkspaceId !== null && (
        <AssignCompanyDialog
          workspaceId={assigningWorkspaceId}
          companies={companies}
          onClose={() => setAssigningWorkspaceId(null)}
        />
      )}
    </>
  )
}
