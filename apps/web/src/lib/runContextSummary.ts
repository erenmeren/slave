import type { SectionSource } from '@slave-of-ai/domain'

/**
 * One line of the "What this run saw" list (M37 §6): the section's `kind`, what produced it in
 * words, and the skills it could NOT be given.
 *
 * `missing` is its own field rather than part of `detail` because the panel renders it in the
 * blocked tone -- a run that started without a skill it was assigned is the one thing on this list
 * an operator has to act on (re-add the skill, or accept the gap), and burying it in a sentence
 * with everything that DID reach the run is how it gets read past.
 */
export interface SectionLine {
  readonly kind: SectionSource['kind']
  readonly detail: string
  readonly missing: readonly string[]
}

/** Which level of the profile override chain, in the panel's words rather than the column's. */
const PROFILE_ORIGIN_WORD: Record<'slave' | 'company' | 'template', string> = {
  slave: "the worker's own",
  company: 'its roster row',
  template: 'its template',
}

const plural = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? '' : 's'}`

/** The first 8 characters of a sha or an id — the same shortest-unambiguous convention
 *  `TaskCard`/`SlaveCard` use for a task reference. */
const short = (value: string): string => value.slice(0, 8)

/**
 * Renders one recorded `SectionSource` as a line a human can read (M37 §6).
 *
 * A pure translation of the manifest and nothing else: the row it reads was validated by the route
 * against `runContextManifestSchema` before it got here, and every branch below is one arm of that
 * schema's discriminated union -- so a new section kind fails this switch's exhaustiveness check
 * rather than rendering as a blank line.
 */
export function sectionLine(source: SectionSource): SectionLine {
  switch (source.kind) {
    case 'profile':
      return {
        kind: source.kind,
        detail: `from ${PROFILE_ORIGIN_WORD[source.origin]} (sha ${short(source.sha256)})`,
        missing: [],
      }
    case 'roster':
      return { kind: source.kind, detail: `${plural(source.slaveIds.length, 'slave')} it could address`, missing: [] }
    case 'skills': {
      const parts = [source.copied.length === 0 ? 'no skills copied' : `copied ${source.copied.join(', ')}`]
      if (source.shadowedByRepo.length > 0) parts.push(`already in the repo: ${source.shadowedByRepo.join(', ')}`)
      // Both flags are honest "nothing was injected, and here is why" states, not failures: a
      // Cursor run takes no skills at all, and a planning run executes in the primary checkout
      // (spec erratum E4).
      if (source.provider_unsupported) parts.push('this runtime takes no injected skills')
      if (source.no_worktree) parts.push('no worktree to inject into')
      return { kind: source.kind, detail: parts.join(' · '), missing: source.missing }
    }
    case 'inbox':
      return { kind: source.kind, detail: plural(source.messageIds.length, 'message'), missing: [] }
    case 'ask_protocol':
      return { kind: source.kind, detail: 'how to ask another slave a question', missing: [] }
    case 'answer_protocol':
      return { kind: source.kind, detail: 'how to answer a question it was asked', missing: [] }
    case 'task':
      // M40 t1: the hash of the task text this run saw, beside the task it names. Absent on a
      // pre-M40 row (fix round 1: the field is optional on read), and the honest render of that is
      // the task reference alone -- not "(sha undefined)".
      return {
        kind: source.kind,
        detail: source.sha256 === undefined ? `TASK-${short(source.taskId)}` : `TASK-${short(source.taskId)} (sha ${short(source.sha256)})`,
        missing: [],
      }
    case 'rejection':
      return { kind: source.kind, detail: `why TASK-${short(source.taskId)} came back`, missing: [] }
    case 'review_diff':
      return {
        kind: source.kind,
        detail: `${source.base}..${source.head}${source.capped ? ' (capped)' : ''}`,
        missing: [],
      }
    case 'planning_goal':
      return {
        kind: source.kind,
        // Same rule: a pre-M40 planning run recorded no version, so it is simply not named.
        detail:
          source.version === undefined
            ? `the workspace goal (sha ${short(source.sha256)})`
            : `the workspace goal v${String(source.version)} (sha ${short(source.sha256)})`,
        missing: [],
      }
    // M47 t1: the vocabulary a planning run was shown. The COUNT and whether it was capped, not
    // the keys themselves -- the manifest carries every one of them, and a summary line naming
    // forty-eight of them is not a line a person reads.
    case 'capabilities':
      return {
        kind: source.kind,
        detail: `${plural(source.keys.length, 'capability key')} it could ask for${source.capped ? ' (capped)' : ''}`,
        missing: [],
      }
    // M40 t1, minimal: a re-plan run's own section. Task 4 gives it the diff a human reads.
    case 'replan':
      return {
        kind: source.kind,
        detail: `the goal changed from v${String(source.previousVersion)} to v${String(source.version)}, over ${plural(source.boardTaskIds.length, 'task')}`,
        missing: [],
      }
  }
}
