'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { plural } from '../../lib/plural'
import { sendControl } from '../../lib/postControl'
import type { RunbookPanelView, RunbookStageView } from '../../server/runbook'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { Panel } from '../ui/Panel'
import { SectionLabel } from '../ui/SectionLabel'
import type { StatusTone } from '../ui/StatusPill'

/**
 * The four stage states, in words (`docs/ia.md` rule 3).
 *
 * READ off `runbookStatus`, never re-derived here: that ladder asks where the WORK is before it
 * asks what each stage holds, and a second reading off the task counts is how "current stage:
 * Design" came to sit above a row saying Design had been skipped (M48 t2 fix round 1). `pending`
 * is a stage the plan has not reached; `missing` is one it went past without a task -- which is the
 * measurement this whole milestone exists to make.
 */
const STATE_WORD: Record<RunbookStageView['state'], string> = {
  done: 'done',
  active: 'happening now',
  pending: 'planned',
  missing: 'not in the plan',
}

/** The tone each state wears. `missing` is the only one that WANTS a person's attention -- a
 *  stage the work skipped -- so it takes the `waiting` amber; `pending` is ordinary and takes the
 *  neutral idle. */
const STATE_TONE: Record<RunbookStageView['state'], StatusTone> = {
  done: 'done',
  active: 'working',
  pending: 'idle',
  missing: 'waiting',
}

/**
 * How this project works (M48 R7), between what you asked for and what happened.
 *
 * Two halves, one at a time. Before adoption: the runbooks this project's GOAL looks like, each
 * with the sentence the rules wrote and an Adopt button. After it: the runbook, the stage the work
 * is on, every stage's state in words, and each stage's required capabilities marked covered or
 * not by the people actually on this project.
 *
 * Nothing at all when there is neither -- a project nobody has an opinion about gets no panel,
 * which is R5's "silence beats noise" one surface further out.
 *
 * The Adopt button goes through the pending DECISION when the Supervisor has already made one:
 * approving is what the person is being asked for, and adopting behind the proposal's back would
 * leave it pending forever with nothing left for it to decide.
 */
export function RunbookPanel({
  workspaceId,
  view,
}: {
  readonly workspaceId: string
  /** `null` for a workspace the snapshot could not build a panel for -- the same "there is nothing
   *  to say" as an empty one, so it renders the same nothing. */
  readonly view: RunbookPanelView | null
}): React.JSX.Element | null {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState('')

  if (view === null || (view.adopted === null && view.recommendations.length === 0)) return null

  const adopt = async (key: string | null): Promise<void> => {
    setPending(key ?? 'clear')
    // A retry starts clean: a prior refusal must not linger through a second attempt that then
    // succeeds and only clears it after the refetch (`TaskDetailPanel.collect`'s own rule).
    setError(null)
    // Through the pending DECISION when the Supervisor has already made one: approving is what the
    // person is being asked for, and adopting behind the proposal's back leaves it pending forever.
    const failure =
      key !== null && view.pendingDecisionId !== null
        ? await sendControl(`/api/w/${workspaceId}/supervisor/decisions/${view.pendingDecisionId}/approve`, { method: 'POST', body: {} })
        : key === null
          ? await sendControl(`/api/w/${workspaceId}/runbook`, { method: 'DELETE' })
          : await sendControl(`/api/w/${workspaceId}/runbook`, { method: 'POST', body: { key } })
    setPending(null)
    if (failure !== null) {
      setError(failure)
      return
    }
    router.refresh()
  }

  const currentTitle =
    view.currentStage === null
      ? null
      : (view.stages.find((stage) => stage.key === view.currentStage)?.title ?? view.currentStage)

  return (
    <div data-testid="runbook-panel" className="px-[20px] pt-[16px]">
      <Panel title="how this project works">
        {error !== null && (
          <Alert variant="error" testId="runbook-error">
            {error}
          </Alert>
        )}

        {view.adopted === null ? (
          <>
            <SectionLabel>recommended for this goal</SectionLabel>
            {/* A `<ul>` because it is a list of offers, and each row is one offer a person can
              * take -- `ProposalRow`'s own shape for the same kind of row. */}
            <ul className="flex flex-col gap-2">
              {view.recommendations.map((recommendation) => (
                <li
                  key={recommendation.key}
                  data-testid="runbook-recommendation"
                  data-key={recommendation.key}
                  className="flex flex-col gap-1 rounded border border-line p-2"
                >
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs text-text-1">{recommendation.name}</span>
                    <span className="font-mono text-[10px] text-text-3">{plural(recommendation.stageCount, 'stage')}</span>
                  </div>
                  <span className="text-[11px] text-text-2">{recommendation.description}</span>
                  {/* The sentence the RULES wrote -- the same one a pending `adopt_runbook`
                    * decision carries. Interpolated as children, so it is characters on the page
                    * and never elements (spec §1: another party's text is data). */}
                  {recommendation.why !== null && (
                    <span data-testid="runbook-why" className="text-[11px] text-tone-waiting">
                      {recommendation.why}
                    </span>
                  )}
                  <div>
                    <Button
                      variant="primary"
                      size="sm"
                      data-testid="runbook-adopt"
                      disabled={pending !== null}
                      onClick={() => void adopt(recommendation.key)}
                    >
                      {pending === recommendation.key ? 'adopting…' : 'adopt'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-2">
              <span data-testid="runbook-name" className="text-sm text-text-1">
                {view.adopted.name}
              </span>
              <span className="font-mono text-[10px] text-text-3">{plural(view.adopted.stageCount, 'stage')}</span>
              {/* Where the runbook came from, in words. The `source` column is the only provenance
                * a runbook carries (it is not workspace-scoped, so it has no event of its own). */}
              <Chip testId="runbook-source" title={view.adopted.source}>
                {SOURCE_WORD[view.adopted.source]}
              </Chip>
            </div>
            <span data-testid="runbook-current-stage" className="text-xs text-text-2">
              {currentTitle === null ? 'no stage yet — nothing on the board carries one' : `current stage: ${currentTitle}`}
            </span>
            <ul className="flex flex-col gap-1">
              {view.stages.map((stage) => (
                <li
                  key={stage.key}
                  data-testid="runbook-stage-row"
                  data-stage={stage.key}
                  data-state={stage.state}
                  className="flex flex-col gap-1 rounded border border-line p-2"
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-xs text-text-1">{stage.title}</span>
                    <Chip testId="runbook-stage-state" tone={STATE_TONE[stage.state]} title={stage.state}>
                      {STATE_WORD[stage.state]}
                    </Chip>
                    <span className="font-mono text-[10px] text-text-3">{plural(stage.taskCount, 'task')}</span>
                  </div>
                  {stage.objective !== '' && <span className="text-[11px] text-text-2">{stage.objective}</span>}
                  {stage.capabilities.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      {stage.capabilities.map((capability) => (
                        // The wrapper carries the name and the marker, the `Chip` carries the
                        // words: an element has ONE `data-testid`, and `Chip` has no prop for a
                        // `data-covered` of its own (`WorkforceCatalog`'s rows wrap for the same
                        // reason). The KEY is a machine handle -- `title` and `data-`, never
                        // visible text (`docs/ia.md` rule 3).
                        <span
                          key={capability.key}
                          data-testid="runbook-capability-chip"
                          data-covered={capability.covered}
                          data-capability={capability.key}
                        >
                          <Chip tone={capability.covered ? 'idle' : 'waiting'} title={capability.key}>
                            {capability.label}
                          </Chip>
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {view.all.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <SectionLabel>{view.adopted === null ? 'or pick one' : 'follow a different one'}</SectionLabel>
            {/* The NAMES, with the key on each option's value where only the machine reads it. */}
            <select
              data-testid="runbook-picker"
              aria-label="Pick a runbook"
              value={picked}
              onChange={(event) => setPicked(event.target.value)}
              className="rounded border border-line bg-bg-0 px-2 py-1 text-xs text-text-1"
            >
              <option value="">choose…</option>
              {view.all.map((runbook) => (
                <option key={runbook.key} value={runbook.key}>
                  {runbook.name}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="sm"
              data-testid="runbook-adopt"
              disabled={picked === '' || pending !== null}
              onClick={() => void adopt(picked)}
            >
              {pending === picked ? 'adopting…' : 'adopt'}
            </Button>
            {view.adopted !== null && (
              <Button
                variant="ghost"
                size="sm"
                data-testid="runbook-clear"
                disabled={pending !== null}
                onClick={() => void adopt(null)}
              >
                {pending === 'clear' ? 'stopping…' : 'stop following it'}
              </Button>
            )}
          </div>
        )}
      </Panel>
    </div>
  )
}

/** A runbook's provenance in words: where the process came from, which is what a person judges it
 *  by. The raw column stays one hover away (M44 R5). */
const SOURCE_WORD: Record<RunbookPanelView['all'][number]['source'], string> = {
  seed: 'shipped with the product',
  persona: 'from a specialist’s own workflow',
  human: 'written here',
}
