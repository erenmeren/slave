'use client'

import { useState } from 'react'
import { CheckIcon, CopyIcon, GitMergeIcon, RotateCcwIcon, ThumbsUpIcon, XIcon } from 'lucide-react'
import { toast } from 'sonner'
import { REQUIREMENT_RESULT_LABEL, SMOKE_FAILING_KEY, STOP_REASON_WORDS } from '@slave-of-ai/domain'
import type { BuildDecision, BuildView, ProjectView } from '@slave-of-ai/control'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatMinutes, spendLine } from '@/lib/format'

/** One line per thing that is not proven (design section 6.3), the smoke check first. */
export function unprovenLines(build: BuildView): readonly string[] {
  const lines: string[] = []
  if (build.failing.includes(SMOKE_FAILING_KEY)) lines.push("The product's own smoke check failed: it did not start, or its script failed.")
  for (const row of build.proof ?? []) {
    if (row.result === 'pass' || row.result === 'unchecked') continue
    const because = row.reason === null || row.reason.trim() === '' ? '' : ` -- ${row.reason.trim()}`
    lines.push(`Requirement ${row.key.replace(/^R/u, '')}: ${REQUIREMENT_RESULT_LABEL[row.result]}${because}`)
  }
  return lines
}

interface Choice {
  readonly decision: BuildDecision
  readonly label: string
  readonly hint: string
  readonly icon: typeof CheckIcon
  readonly variant: 'default' | 'outline' | 'ghost'
  /** Final: asked once more before it is sent. */
  readonly confirm: { readonly title: string; readonly body: string } | null
}

const STOPPED_CHOICES: readonly Choice[] = [
  {
    decision: 'accept',
    label: 'Accept as it is',
    hint: 'Merge what was built, unproven parts included.',
    icon: ThumbsUpIcon,
    variant: 'default',
    confirm: { title: 'Accept this build as it is?', body: 'What was built is merged, including the parts that were not proven. This cannot be undone from here.' },
  },
  { decision: 'retry', label: 'Check again', hint: 'Run the checker once more on the same code.', icon: RotateCcwIcon, variant: 'outline', confirm: null },
  {
    decision: 'leave',
    label: 'Leave it unmerged',
    hint: 'Keep the branch, merge nothing. You can ask for a change later.',
    icon: XIcon,
    variant: 'ghost',
    confirm: { title: 'Leave this build unmerged?', body: 'Nothing is merged and the build is closed. Its branch stays in the repository.' },
  },
]

/**
 * Lead UX design section 6.3 (U-3): the amber card at the top of the Project screen when a build
 * needs the person -- a stopped build's three answers, or a merge only they can do. Answered here,
 * nowhere else; a final answer is confirmed once.
 */
export function DecisionCard({ project, onDone }: { readonly project: ProjectView; readonly onDone: () => Promise<void> }): React.JSX.Element | null {
  const [busy, setBusy] = useState<BuildDecision | 'auto' | null>(null)
  const [confirming, setConfirming] = useState<Choice | null>(null)
  const [copied, setCopied] = useState(false)
  const build = project.build
  if (build === null || (project.phase !== 'needs_decision' && project.phase !== 'ready_to_merge')) return null

  const send = async (decision: BuildDecision): Promise<void> => {
    setBusy(decision)
    const result = await api(`/api/w/${project.id}/goals/${String(build.version)}/${decision}`, { method: 'POST' })
    setBusy(null)
    setConfirming(null)
    if (result.ok) toast.success({ accept: 'Accepted. Slave merges it next.', retry: 'Checking again.', leave: 'Left unmerged.', merged: 'Recorded as merged.' }[decision])
    else toast.error(result.error)
    await onDone()
  }

  const autoMerge = async (): Promise<void> => {
    setBusy('auto')
    const result = await api(`/api/w/${project.id}/integration`, { method: 'PUT', body: { autoMerge: true } })
    setBusy(null)
    if (result.ok) toast.success('Automatic merge is on. Slave merges on its next pass.')
    else toast.error(result.error)
    await onDone()
  }

  const copyBranch = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(build.branch)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy. Select the branch name instead.')
    }
  }

  const facts = `Spent ${spendLine(build.spentUsd, build.spendUnmeasured, project.budgetUsd)} · worked ${formatMinutes(build.workedMs)}`

  return (
    <section role="alert" aria-labelledby="decision-title" data-testid="decision-card" data-phase={project.phase} className="rounded-xl border-2 border-warning bg-warning-muted p-5 text-foreground shadow-sm">
      {project.phase === 'needs_decision' ? (
        <>
          <h2 id="decision-title" className="text-lg font-semibold">
            Build {build.version} needs your decision
          </h2>
          <p className="mt-1 font-medium">{build.stopReason === null ? 'The build stopped before everything was proven.' : STOP_REASON_WORDS[build.stopReason]}</p>
          {unprovenLines(build).length > 0 && (
            <ul data-testid="unproven" className="mt-3 list-disc space-y-1 pl-5 text-sm">
              {unprovenLines(build).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm text-muted-foreground">{facts}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {STOPPED_CHOICES.map((choice) => (
              <div key={choice.decision} className="flex flex-col gap-1">
                <Button
                  variant={choice.variant}
                  data-testid={`decide-${choice.decision}`}
                  disabled={busy !== null}
                  className={choice.variant === 'ghost' ? 'border border-transparent hover:border-border' : ''}
                  onClick={() => (choice.confirm === null ? void send(choice.decision) : setConfirming(choice))}
                >
                  <choice.icon />
                  {busy === choice.decision ? 'Sending…' : choice.label}
                </Button>
                <span className="text-xs text-muted-foreground">{choice.hint}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <h2 id="decision-title" className="text-lg font-semibold">
            Build {build.version} is ready to merge
          </h2>
          <p className="mt-1 text-sm">{build.mergeError !== null ? `Slave could not merge it: ${build.mergeError}` : 'Automatic merge is off for this project.'}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">Merge</span>
            <code data-testid="merge-branch" className="rounded bg-background px-2 py-1 font-mono text-xs">
              {build.branch}
            </code>
            <Button variant="ghost" size="icon" className="size-7" aria-label="Copy the branch name" onClick={() => void copyBranch()}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
            <span className="text-muted-foreground">into</span>
            <code className="rounded bg-background px-2 py-1 font-mono text-xs">{project.baseBranch}</code>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">{facts}</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Button data-testid="decide-merged" disabled={busy !== null} onClick={() => void send('merged')}>
                <GitMergeIcon />
                {busy === 'merged' ? 'Checking…' : 'I merged it'}
              </Button>
              <span className="text-xs text-muted-foreground">Slave checks that the branch is in {project.baseBranch} and records it.</span>
            </div>
            {!project.autoMerge && (
              <div className="flex flex-col gap-1">
                <Button variant="outline" data-testid="decide-auto-merge" disabled={busy !== null} onClick={() => void autoMerge()}>
                  Merge automatically from now on
                </Button>
                <span className="text-xs text-muted-foreground">Turns on automatic merge for this project; Slave merges on its next pass.</span>
              </div>
            )}
          </div>
        </>
      )}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => (open ? undefined : setConfirming(null))}>
        <AlertDialogContent data-testid="decision-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirming?.confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirming?.confirm?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <AlertDialogAction data-testid="decision-confirm-yes" onClick={() => (confirming === null ? undefined : void send(confirming.decision))}>
              {confirming?.label}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
