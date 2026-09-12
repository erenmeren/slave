'use client'

import { useId, useState } from 'react'
import { SECTION_LABEL_CLASS } from './SectionLabel'

/**
 * The ten groups M45 R4 names and the twelve M46 R6 names, in the order a panel shows them. A
 * closed union so a group name cannot be typed twice differently in two panels -- the gate reads
 * `data-group`, and two spellings of "verification" would be two groups to it.
 *
 * `skills` belongs to both lists and is written once for that same reason: one group name for one
 * idea, because a `profileSkills` beside a `skills` would be two groups to the gate and one idea
 * to a person.
 */
export type DetailsGroupName =
  // M45 R4: the ten groups a task or a worker panel shows.
  | 'run'
  | 'model'
  | 'profile'
  | 'skills'
  | 'messages'
  | 'context'
  | 'verification'
  | 'cost'
  | 'worktree'
  | 'events'
  // M46 R6: the twelve a specialist profile shows. `skills` above is reused -- one group name for
  // one idea, because the gate reads `data-group` and two spellings would be two groups to it.
  | 'identity'
  | 'mission'
  | 'capabilities'
  | 'expertise'
  | 'principles'
  | 'constraints'
  | 'workflow'
  | 'deliverables'
  | 'success'
  | 'collaboration'
  | 'source'
  // `body` is R6's thirteenth (M46 t4 fix round 1): the persona's own remaining prose is an
  // overridable field like any other, and it had no group to be edited in.
  | 'body'
  | 'advanced'
  // M48 R7: the typed contract a task was handed -- what it is for, what counts as done, and what
  // proof it owes. The fourteenth of R6's groups and the first that is about the WORK rather than
  // about the worker.
  | 'handoff'
  // M49 R6: where a memory came from, and what a task's runs were given and left behind. The
  // fifteenth and sixteenth of R6's groups, and the first two about what the organisation KNOWS
  // rather than about what it did.
  | 'provenance'
  | 'memories'
  // M52 R7: what this worker MAY DO. The seventeenth of R6's groups, and deliberately not
  // `capabilities` (which is already a member, and which answers what a worker is FOR): two words
  // for two things, because a taxonomy key and a permission kind are different objects and the one
  // surface where a person meets both must not call them one.
  | 'permissions'

/**
 * One `Details ▾` group (M45 R4).
 *
 * Children are rendered only while OPEN, and that is the point rather than a nicety: three of
 * these groups fetch on open (`run-context`, the artifacts, the live feed), and a panel that
 * mounted ten collapsed groups with their subtrees rendered would issue every one of those
 * requests to show a person nothing. It is also what makes the raw values honest -- ids, hashes
 * and statuses live INSIDE a group, so the simple row above stays readable and nothing is hidden,
 * only folded.
 *
 * A native `<details>` renders its subtree regardless of `open`, so this is a button and a region
 * instead -- and it therefore owes a screen reader by hand the state a `<summary>` would have
 * given for free: `aria-expanded`, `aria-controls`, and a region that names its own toggle.
 */
export function DetailsGroup({
  group,
  title,
  defaultOpen = false,
  children,
}: {
  readonly group: DetailsGroupName
  readonly title: string
  readonly defaultOpen?: boolean
  readonly children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  const toggleId = `${id}-toggle`
  const bodyId = `${id}-body`
  return (
    <section data-testid="details-group" data-group={group} data-open={open} className="flex flex-col gap-1">
      <button
        type="button"
        id={toggleId}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((current) => !current)}
        className={`flex items-center gap-1 text-left ${SECTION_LABEL_CLASS} hover:text-text-2`}
      >
        <span>{title}</span>
        {/* The marker is decoration: `aria-expanded` above is what a screen reader reads, and a
          * bare `▾` in the accessible name would make `getByRole('button', { name })` -- and a
          * person listening -- read punctuation. */}
        <span aria-hidden>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div id={bodyId} role="group" aria-labelledby={toggleId} className="flex flex-col gap-2">
          {children}
        </div>
      )}
    </section>
  )
}
