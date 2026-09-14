'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { breadcrumbOf, workspaceIdOf } from '../../lib/routes'
import { formatUsd } from '../../lib/realMoney'
import { postJson } from '../../lib/postControl'
import { useShellFacts } from '../../hooks/useShellFacts'
import type { SidebarProject } from '../../server/sidebar'
import { useHeaderActionNode } from './HeaderActionProvider'

/** The three shapes the right half of the split button takes (README "Shell" → Header). A halted
 *  project offers the way OUT rather than the way further in. */
type StopState = 'idle' | 'armed' | 'halted'

/**
 * What `runs/pause-all` and `runs/resume-all` answer (M57 R7): a REPORT, not a bare `{ ok: true }`.
 *
 * `refused` carries RUN IDS today. An entry that carries its own refusal text is read if one ever
 * does, which is why the member type is widened here rather than at the route -- the header is the
 * only reader, and a fan-out that starts explaining itself must not need a second release to be
 * heard.
 */
interface FanoutEnvelope {
  readonly requested?: readonly string[]
  readonly refused?: readonly (string | { readonly error?: string })[]
}

/**
 * The sentence for a fan-out that asked for NOTHING and was refused SOMETHING.
 *
 * This is the case `postControl` could not report and the button therefore lied about: after an
 * emergency stop every run is `paused`, so the split button reads `Resume all`, and every
 * `requestResume` then refuses `workspace_halted` -- a 200 with an empty `requested`, a green
 * button, and nothing whatsoever happening. (The halt is ALSO why the button is disabled while
 * halted; this is the belt behind that brace, and it covers every other way a fan-out can come
 * back empty-handed.)
 *
 * `nothingHappened` is `null` for the two routes that answer no report at all (`clear-halt`,
 * `emergency-stop`), which is how their `{ ok: true }` says "there was never a report to read"
 * rather than relying on an empty array to mean the same thing.
 */
function fanoutRefusal(data: FanoutEnvelope, nothingHappened: string | null): string | null {
  if (nothingHappened === null) return null
  const requested = data.requested ?? []
  const refused = data.refused ?? []
  if (requested.length > 0 || refused.length === 0) return null
  const first = refused[0]
  const explained = typeof first === 'object' && typeof first.error === 'string' ? first.error : null
  return explained ?? nothingHappened
}

/**
 * The 54px header (M57 R7): a breadcrumb, a halt pill, the money, one split button, and a slot the
 * page fills.
 *
 * It is mounted by the ROOT layout and is therefore on EVERY page, global routes included -- which
 * is what lets the breadcrumb be the one thing that always says where you are. The project cluster
 * (budget, split button) renders only inside `/w/:id/*`, and only once the page has published its
 * facts: the header opens no connection of its own, exactly as `ProjectHeader` did not (M24 §2.2).
 *
 * `ProjectHeader.tsx`'s gradient hairline does not come with it. That was the old handoff's
 * signature and the new one draws a plain `--line` rule; `project-header-hairline` is in §3's
 * removed column with "nothing" beside it.
 */
export function Header({ projects }: { readonly projects: readonly SidebarProject[] }): React.JSX.Element {
  const pathname = usePathname()
  const workspaceId = workspaceIdOf(pathname)
  const facts = useShellFacts(workspaceId)
  const action = useHeaderActionNode()
  // THE NAME COMES FROM THE TREE (spec erratum E12). `useShellFacts` carries a name too, but only
  // five of the eight project page clients publish to it -- `/organization`, `/knowledge` and
  // `/office` publish nothing -- so a breadcrumb that read the name from that store alone would say
  // the workspace ID on three routes. The tree is read server-side by the root layout and is
  // complete on every route by construction. `ShellFactsSeed` fills the store for the budget and
  // the halt state on those same three routes.
  const projectName = projects.find((project) => project.id === workspaceId)?.name ?? facts?.workspace.name ?? null
  const [armed, setArmed] = useState(false)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const halted = facts?.status.haltedReason != null
  // Disarm AND forget the last refusal on every navigation, not only on a change of project: this
  // header is mounted by the ROOT layout, so `/w/w1/tasks → /w/w1/settings` unmounts nothing and
  // `workspaceId` does not move. An armed Stop carried across a navigation is a destructive control
  // a person did not mean to leave cocked, and an error band from one page reading on the next is a
  // complaint about something that is no longer on screen. `pathname` is what actually changes;
  // `workspaceId` and `halted` stay in the list because they are the two things that matter even
  // when it does not.
  useEffect((): void => {
    setArmed(false)
    setErrorText(null)
  }, [pathname, workspaceId, halted])

  const crumbs = breadcrumbOf(pathname, projectName)
  const stopState: StopState = halted ? 'halted' : armed ? 'armed' : 'idle'

  // ONE POST for all four buttons. `postJson` rather than `postControl` because two of the four
  // answer a report and `postControl` throws the body away (M45 R3 added `postJson` for exactly
  // this, and this is its second caller): a 200 is not the same thing as "it happened".
  const post = async (url: string, nothingHappened: string | null): Promise<void> => {
    setPending(true)
    const result = await postJson<FanoutEnvelope>(url)
    setPending(false)
    setErrorText(result.ok ? fanoutRefusal(result.data, nothingHappened) : result.error)
  }

  // `slavesPaused` beside `slavesWorking` is what tells "everything is paused" from "nothing is
  // running" (plan erratum E2) -- and an idle project must not be offered a Resume that would
  // resume nothing.
  const resuming = facts !== null && facts.counts.slavesWorking === 0 && facts.counts.slavesPaused > 0
  const budgetUsd = facts?.guardrails.budgetUsd ?? null
  const spent = facts?.status.spentUsd ?? 0
  const ratio = budgetUsd === null || budgetUsd <= 0 ? 0 : spent / budgetUsd
  // The tone as a NAME on the track and a class on the fill. The name is the readable contract --
  // a test and a gate can pin "past the 80% line" without pinning a Tailwind class string, which is
  // a colour decision that may move.
  const barTone = ratio >= 1 ? 'over' : ratio >= 0.8 ? 'near' : 'ok'
  const barFill = barTone === 'over' ? 'bg-s-blocked' : barTone === 'near' ? 'bg-s-waiting' : 'bg-accent'

  return (
    <header
      data-testid="app-header"
      className="flex h-[54px] flex-none items-center gap-3 border-b border-line bg-panel px-[24px]"
    >
      {/* README: 13px, `--t3` segments, the last one `--t1` at 600. `data-crumbs` is the gate's
        * read of the same list, so a breadcrumb that is right on screen and wrong in the DOM is
        * not a thing that can happen. */}
      <nav aria-label="Breadcrumb" data-testid="breadcrumb" data-crumbs={crumbs.map((crumb) => crumb.text).join('/')} className="flex items-center gap-[6px] text-[13px]">
        {crumbs.map((crumb, index) => (
          <span key={`${crumb.text}-${String(index)}`} className="flex items-center gap-[6px]">
            {index > 0 && <span aria-hidden className="text-t3">/</span>}
            <span className={crumb.last ? 'font-semibold text-t1' : 'text-t3'}>{crumb.text}</span>
          </span>
        ))}
      </nav>

      {halted && (
        <span
          data-testid="halted-pill"
          title={facts?.status.haltedReason ?? undefined}
          className="inline-flex items-center gap-[6px] rounded-pill bg-[color-mix(in_oklab,var(--s-blocked)_14%,transparent)] px-[10px] py-[4px] font-mono text-[11.5px] font-medium text-s-blocked"
        >
          <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-s-blocked" />
          HALTED · nothing is scheduled
        </span>
      )}

      {errorText !== null && (
        <span role="alert" data-testid="header-error" className="truncate text-[12.5px] text-s-blocked">
          {errorText}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {facts !== null && workspaceId !== null && (
          <>
            <span data-testid="budget" className="flex items-center gap-2 font-mono text-[12.5px] font-medium text-t2">
              <span>
                {formatUsd(spent)}
                {budgetUsd !== null && ` / ${formatUsd(budgetUsd)}`}
              </span>
              {facts.status.unmeasuredRuns > 0 && (
                <span data-testid="budget-unmeasured" className="text-t3">
                  · {facts.status.unmeasuredRuns} unmeasured
                </span>
              )}
              {/* No bar at all for an unbudgeted project (M12 Task 9 / R11): a bar is a fraction of
                * a ceiling, and an empty track reads as "0% of something" rather than "there is no
                * something". README: 100 x 5px, accent fill. */}
              {budgetUsd !== null && (
                <span data-testid="budget-bar" data-tone={barTone} className="block h-[5px] w-[100px] overflow-hidden rounded-hair bg-sel">
                  <span
                    className={`block h-full motion-safe:[transition:width_.5s_ease] ${barFill}`}
                    style={{ width: `${String(Math.min(100, ratio * 100))}%` }}
                  />
                </span>
              )}
            </span>

            <span aria-hidden className="mx-1 h-[20px] w-px bg-line2" />

            <span className="inline-flex overflow-hidden rounded-card border border-line2 text-[13px]">
              {/* DISABLED while the project is halted, and the `title` says why in plain words.
                * Nothing can be resumed into a halt -- `requestResume` refuses every run with
                * `workspace_halted` -- so an enabled Resume here is a button that answers 200 and
                * does nothing. The way out is the control immediately to its right. */}
              <button
                type="button"
                data-testid="pause-all"
                disabled={pending || halted}
                title={halted ? 'Clear the safety halt first — nothing can be started while it stands.' : undefined}
                onClick={() =>
                  void post(
                    `/api/w/${workspaceId}/runs/${resuming ? 'resume-all' : 'pause-all'}`,
                    resuming
                      ? 'Nothing could be resumed: every paused run refused.'
                      : 'Nothing could be paused: every active run refused.',
                  )
                }
                className="border-0 bg-transparent px-3 py-[6px] text-t1 transition-colors hover:bg-hover disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
              >
                {resuming ? 'Resume all' : 'Pause all'}
              </button>
              <span aria-hidden className="w-px bg-line2" />
              {/* ONE button, three states. Armed is the two-step `DangerConfirm` recipe M44 R3
                * made the only way to fire a destructive action -- kept here in the split button's
                * own geometry rather than by mounting `DangerConfirm`, because that component
                * renders its own trigger and its own confirm as two elements and the README draws
                * one control that CHANGES. The rule it exists to enforce is intact: the first
                * click never fires, and Cancel is always beside the armed state. */}
              <button
                type="button"
                data-testid="stop-split"
                data-armed={String(stopState === 'armed')}
                aria-label={stopState === 'halted' ? 'Clear the safety halt' : stopState === 'armed' ? 'Confirm: stop everything' : 'Emergency stop'}
                disabled={pending}
                onClick={() => {
                  if (stopState === 'halted') void post(`/api/w/${workspaceId}/clear-halt`, null)
                  else if (stopState === 'armed') {
                    setArmed(false)
                    void post(`/api/w/${workspaceId}/emergency-stop`, null)
                  } else setArmed(true)
                }}
                className={`border-0 px-3 py-[6px] transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                  stopState === 'armed' ? 'bg-s-blocked font-semibold text-white' : 'bg-transparent text-s-blocked hover:bg-hover'
                }`}
              >
                {stopState === 'halted' ? 'Clear halt' : stopState === 'armed' ? 'Stop everything' : 'Stop ▾'}
              </button>
              {stopState === 'armed' && (
                <>
                  <span aria-hidden className="w-px bg-line2" />
                  <button
                    type="button"
                    data-testid="stop-cancel"
                    onClick={() => setArmed(false)}
                    className="border-0 bg-transparent px-3 py-[6px] text-t2 transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                  >
                    Cancel
                  </button>
                </>
              )}
            </span>
          </>
        )}

        {action !== null && <span data-testid="header-action">{action}</span>}
      </div>
    </header>
  )
}
