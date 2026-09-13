'use client'

import { useState } from 'react'
import { originLabel, parseExternalOrigin } from '@slave-of-ai/domain'
import type { GoalVersionView } from '../../server/goal'
import { errorMessage } from '../../lib/postControl'
import { onUnauthorized } from '../../lib/onUnauthorized'
import { SectionLabel } from '../ui/SectionLabel'

/**
 * The goal's history, collapsed until asked for (M40 §6).
 *
 * Split out of `GoalPanel` rather than folded into it: the panel is a form with two modes, this is
 * a read with its own fetch, its own error and its own open/closed state, and keeping them in one
 * component would mean one `pending` flag standing for two unrelated waits.
 *
 * Fetched on the toggle rather than with the page: a project's whole requirement history is every
 * wording anyone ever gave it, and shipping all of it into a Settings render nobody opened would
 * cost more than the click it saves. Same on-demand shape as `TaskDetailPanel`'s "What this run
 * saw", and the same plain `fetch` for the same reason -- a 200 here is a JSON array, not the
 * `{ ok: true }` envelope `sendControl` decodes.
 *
 * Every version's text and every diff line is another party's text -- what a person typed into this
 * box, possibly months ago -- so all of it is rendered as JSX children (characters on the page,
 * never elements: spec §1, another party's text is data).
 */
/**
 * Whether a 200 body is actually the history (fix round 1, Minor 5).
 *
 * A shallow check, deliberately: it asks the one question the render below depends on -- is this a
 * list of rows each carrying a numeric `version` -- rather than re-validating every field the route
 * already built with `listGoalVersions`. A cast alone would let a proxy's HTML error page, or a
 * route this page is one deploy out of step with, reach the map and throw inside render, where the
 * component has no error span to put it in. This routes it to the one it already has.
 */
function isGoalHistory(data: unknown): data is readonly GoalVersionView[] {
  return (
    Array.isArray(data) &&
    data.every((entry) => typeof entry === 'object' && entry !== null && typeof (entry as { version?: unknown }).version === 'number')
  )
}

export function GoalHistory({ workspaceId }: { readonly workspaceId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<readonly GoalVersionView[] | null>(null)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    try {
      const response = await fetch(`/api/w/${workspaceId}/goal/history`)
      if (response.status === 401) {
        onUnauthorized()
        return
      }
      const data: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        setErrorText(errorMessage(data, response.status))
        return
      }
      if (!isGoalHistory(data)) {
        setErrorText('this project\u2019s goal history came back in a shape this page cannot read')
        return
      }
      setEntries(data)
      setOpen(true)
    } catch (cause) {
      setErrorText(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  // Re-read on every open, not once: a goal set from the CLI (or by another operator) between two
  // opens must not leave this list showing a history that is missing the newest version.
  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    void load()
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        data-testid="goal-history-toggle"
        disabled={pending}
        onClick={toggle}
        className="self-start font-mono text-[10px] text-text-3 underline decoration-dotted underline-offset-2 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {open ? 'hide history' : 'history'}
      </button>
      {errorText !== null && (
        <span role="alert" data-testid="goal-history-error" className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}
      {open && entries !== null && (
        <div data-testid="goal-history" className="flex flex-col gap-2">
          {entries.length === 0 ? (
            <p data-testid="goal-history-empty" className="text-xs text-text-3">
              no version has been recorded for this project
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {/* Newest first, as the verb returns them: each row's diff is against the row BELOW
                * it, which is the version that row replaced. */}
              {entries.map((entry) => {
                // M54 R9: the version a delivery produced says so, on the row it belongs to.
                //
                // PARSED here rather than read straight off the view, for the reason `isGoalHistory`
                // above gives for existing at all: this component fetches its own JSON and
                // deliberately does not re-validate every field the route built, so a row this page
                // is one deploy out of step with -- one with no `origin` key, or one whose `Json`
                // column a hand edit broke -- must read as "nobody outside asked" rather than print
                // `undefined` into the sentence. `parseExternalOrigin` answers null for all three,
                // which is exactly what `listGoalVersions` already answers server-side for the
                // column itself.
                const origin = parseExternalOrigin(entry.origin)
                return (
                  <li
                    key={entry.version}
                    data-testid="goal-history-entry"
                    className="rounded border border-line p-2 text-xs text-text-2"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span data-testid="goal-history-version" className="font-mono text-[10px] text-text-3">
                        v{entry.version}
                      </span>
                      {/* The sentence is built from the origin's STRUCTURED fields -- source label,
                        * repository, ref -- and never from the external title or body, which are
                        * another party's text and live only inside the fence in the version's own
                        * text below. The raw `github` stays in `data-external-source` and the
                        * repository in `title` (`docs/ia.md` rule 3). */}
                      {origin !== null && (
                        <span
                          data-testid="goal-history-origin"
                          data-external-source={origin.source}
                          title={origin.repository}
                          className="font-mono text-[10px] text-text-3"
                        >
                          {originLabel(origin)}
                        </span>
                      )}
                      <span data-testid="goal-history-at" className="font-mono text-[10px] text-text-3">
                        {entry.createdAt.slice(0, 19).replace('T', ' ')}
                      </span>
                    </div>
                    <p data-testid="goal-history-text" className="mt-1 whitespace-pre-wrap text-text-2">
                      {entry.text}
                    </p>
                    {entry.diff === null ? (
                      // v1 is the requirement's beginning, not an edit of anything.
                      <SectionLabel>the first version</SectionLabel>
                    ) : (
                      <ul className="mt-1 flex flex-col font-mono text-[10.5px]">
                        {entry.diff.removed.map((line, index) => (
                          <li
                            key={`removed-${String(index)}`}
                            data-testid="goal-diff-removed"
                            className="text-tone-blocked"
                          >
                            - {line}
                          </li>
                        ))}
                        {entry.diff.added.map((line, index) => (
                          <li key={`added-${String(index)}`} data-testid="goal-diff-added" className="text-tone-done">
                            + {line}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
