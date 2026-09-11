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
 * Nothing at all when there is none of it -- no runbook, nothing recommended and nothing to pick --
 * which is R5's "silence beats noise" one surface further out. A project with tasks and no runbook
 * is recommended nothing (M48 final review, Minor 1) and gets the picker alone: switching is still
 * a thing a person may do, but the product does not suggest it once a plan exists.
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

  if (view === null) return null
  // Nothing to say, no panel. Since M48's final review (Minor 1) the middle case is real: a project
  // with tasks and no runbook gets NO recommendations from the builder -- the Supervisor only
  // recommends on an empty board -- and what is left for it is the picker. So the silence is now
  // "there is no runbook, nothing to recommend AND nothing to pick", which is a database with no
  // runbooks in it at all.
  //
  // What the picker may offer: everything but the runbook this project already follows.
  const choosable = view.all.filter((runbook) => runbook.key !== view.adopted?.key)
  if (view.adopted === null && view.recommendations.length === 0 && choosable.length === 0) return null

  const proposed = view.pendingDecision

  /**
   * Adopt what was CLICKED (fix round 1, Critical).
   *
   * The pending proposal is approved only when the clicked key IS the one it is about: approving is
   * what the person is being asked for there, and adopting behind the proposal's back would leave
   * it pending forever. Every OTHER click is a by-hand adoption of the runbook that was actually
   * chosen -- the round-1 version sent every click to the approve route, so with a proposal for
   * `security-review` on screen, clicking "Bug fix" adopted the security review.
   *
   * A by-hand adoption ANSWERS the proposal rather than racing it (M48 final wave, Task 4 ruling):
   * `adoptRunbook` resolves this project's pending `runbook_recommended` decisions, so the refresh
   * below comes back with the note gone. The note is still said up front, because it is true at the
   * moment a person is choosing: the question is open until they click.
   */
  const adopt = async (key: string | null): Promise<void> => {
    setPending(key ?? 'clear')
    // A retry starts clean: a prior refusal must not linger through a second attempt that then
    // succeeds and only clears it after the refetch (`TaskDetailPanel.collect`'s own rule).
    setError(null)
    const failure =
      key === null
        ? await sendControl(`/api/w/${workspaceId}/runbook`, { method: 'DELETE' })
        : proposed !== null && proposed.key === key
          ? await sendControl(`/api/w/${workspaceId}/supervisor/decisions/${proposed.id}/approve`, { method: 'POST', body: {} })
          : await sendControl(`/api/w/${workspaceId}/runbook`, { method: 'POST', body: { key } })
    setPending(null)
    if (failure !== null) {
      setError(failure)
      return
    }
    // The box must not go on claiming a choice that has already happened (fix round 1, minor 7):
    // the refresh below re-reads the panel, and the picker's job starts again from "choose…".
    setPicked('')
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

        {/* A proposal is a question somebody asked, said UP FRONT rather than in reaction to what
          * is selected: a person about to pick a runbook should know the question is waiting
          * before they click, and where else it can be answered. Silent once the proposed runbook
          * IS the adopted one, which is a proposal with nothing left to decide. The name, never
          * the key (`docs/ia.md` rule 3). */}
        {proposed !== null && proposed.key !== view.adopted?.key && (
          <span data-testid="runbook-pending-note" className="text-[11px] text-tone-waiting">
            The Supervisor proposed {proposed.name}; answer it on the timeline or adopt another below.
          </span>
        )}

        {/* The recommendation list, and nothing at all when there is none to make: a project with
          * tasks and no runbook drops straight to the picker (M48 final review, Minor 1), and a
          * heading over an empty list reads as a recommendation that failed to load. */}
        {view.adopted === null && view.recommendations.length > 0 && (
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
        )}

        {view.adopted !== null && (
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

        {/* One row for both controls, shown when EITHER has something to do (M48 final review,
          * Minor 9). They are independent: the picker needs a runbook to switch to, while "stop
          * following it" needs only an adopted one -- and a project following the sole runbook in
          * the database had no way to stop, because the empty picker took the button with it. */}
        {(choosable.length > 0 || view.adopted !== null) && (
          <div className="flex flex-wrap items-center gap-2">
            {choosable.length > 0 && (
              <>
                <SectionLabel>
                  {view.adopted !== null ? 'follow a different one' : view.recommendations.length > 0 ? 'or pick one' : 'pick one'}
                </SectionLabel>
                {/* The NAMES, with the key on each option's value where only the machine reads it.
                  * The runbook this project ALREADY follows is not in the list (fix round 1, minor
                  * 7): a picker offers what you could switch to, and adopting the one you have is
                  * a write that changes nothing. */}
                <select
                  data-testid="runbook-picker"
                  aria-label="Pick a runbook"
                  value={picked}
                  onChange={(event) => setPicked(event.target.value)}
                  className="rounded border border-line bg-bg-0 px-2 py-1 text-xs text-text-1"
                >
                  <option value="">choose…</option>
                  {choosable.map((runbook) => (
                    <option key={runbook.key} value={runbook.key}>
                      {runbook.name}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="sm"
                  // Its OWN name (fix round 1, minor 3): two elements answering to `runbook-adopt`
                  // made "the Adopt button" ambiguous to a gate that has to click one on purpose.
                  data-testid="runbook-picker-adopt"
                  disabled={picked === '' || pending !== null}
                  onClick={() => void adopt(picked)}
                >
                  {pending === picked ? 'adopting…' : 'adopt'}
                </Button>
              </>
            )}
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
