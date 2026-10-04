import { trimToFit } from '../conduct/verification.js'
import { sanitisePersonText } from '../handoff/contract.js'
import { LEAD_DECISIONS_FILE, type LeadTurn } from './constants.js'

/** What {@link renderLeadBrief} is told about one goal version. */
export interface LeadBriefInput {
  readonly goalVersion: number
  readonly goal: string
  readonly requirements: readonly { readonly key: string; readonly text: string }[]
  readonly decisions: readonly { readonly title: string; readonly decision: string }[]
  /** Null for an unbudgeted goal. `spentUsd` is what the lead's own turns spent so far. */
  readonly budget: { readonly totalUsd: number; readonly shareUsd: number; readonly spentUsd: number } | null
  readonly timeLeftMs: number | null
  readonly roster: readonly { readonly slug: string; readonly description: string }[]
}

const usd = (amount: number): string => `$${amount.toFixed(2)}`
const minutes = (ms: number): string => `about ${String(Math.max(0, Math.round(ms / 60_000)))} minutes`

/**
 * Lead-flow spec B3: what the lead is told at the start of a session -- the goal, every requirement,
 * the decisions already made, its limits and its roster. The goal, the requirements and the
 * decisions are other parties' text and go through `sanitisePersonText`. The rules of the flow are
 * the trailer ({@link LEAD_RULES}), not part of this text.
 */
export function renderLeadBrief(input: LeadBriefInput): string {
  const { budget } = input
  return [
    `THE GOAL (v${String(input.goalVersion)})`,
    '',
    sanitisePersonText(input.goal),
    '',
    'THE REQUIREMENTS (an independent verifier checks each one on the running product):',
    ...input.requirements.map((r) => `${r.key}: ${sanitisePersonText(r.text)}`),
    ...(input.decisions.length === 0
      ? []
      : ['', 'DECISIONS ALREADY MADE (binding):', ...input.decisions.map((d) => `- ${sanitisePersonText(d.title)}: ${sanitisePersonText(d.decision)}`)]),
    '',
    'YOUR LIMITS',
    budget === null
      ? 'No budget is set for this goal.'
      : `The goal's budget is ${usd(budget.totalUsd)}. Your share is ${usd(budget.shareUsd)}; ${usd(budget.totalUsd - budget.shareUsd)} is kept for proving the result. ` +
        `Spent of your share so far: ${usd(budget.spentUsd)}. At four fifths of your share you are told to wrap up; at all of it you are stopped and what is committed is judged.`,
    input.timeLeftMs === null
      ? 'No time limit is set.'
      : `Time left for this goal: ${minutes(input.timeLeftMs)}. When it runs out you are stopped and what is committed is judged.`,
    ...(input.roster.length === 0
      ? []
      : [
          '',
          'YOUR ROSTER (subordinate sessions defined for this goal; start one by its name, or a general one):',
          ...input.roster.map((member) => `- ${member.slug}: ${sanitisePersonText(member.description)}`),
        ]),
    '',
    '---',
  ].join('\n')
}

/** The rules of the flow live in a leaf module (`./rules.js`) so the run-context renderer can take
 *  its trailer without importing this module's imports; re-exported here, beside the brief. */
export { LEAD_RULES } from './rules.js'

const TURN_OPENING: Readonly<Record<Exclude<LeadTurn, 'build'>, string>> = {
  rework: 'The independent verification of your work found what follows. Fix it on this same branch, commit, and finish with your closing report again.',
  wrap_up:
    `You have used four fifths of your share of the budget. Wrap up now: commit what works, make sure the README is exact, record every open decision in ${LEAD_DECISIONS_FILE}, and write your closing report. Say plainly what is not finished.`,
  continue: 'Your session was interrupted and is being continued. Check git status and git log first, then carry on with the goal from where you stood.',
  answer: `Nobody answers questions in this flow. Decide it yourself, record the decision and its reason in ${LEAD_DECISIONS_FILE}, and continue building.`,
  base: '',
}

/**
 * What a later turn of the lead's session is told (plan A L4): why the turn exists, what came back
 * (`note`: a verifier's evidence, a failure, already sanitised by whoever wrote it), and what is
 * left of its share and of the time.
 */
export function renderLeadTurnNote(input: {
  readonly kind: LeadTurn
  readonly note: string | null
  readonly baseBranch: string
  readonly budgetLeftUsd: number | null
  readonly timeLeftMs: number | null
}): string {
  const opening =
    input.kind === 'base'
      ? `The base branch ${input.baseBranch} moved while you worked and no longer merges cleanly. Merge it into this branch (git merge ${input.baseBranch}), resolve the conflicts, make sure the product still starts and works, and commit.`
      : input.kind === 'build'
        ? 'Continue building the goal.'
        : TURN_OPENING[input.kind]
  return [
    opening,
    ...(input.note === null || input.note.trim() === '' ? [] : ['', trimToFit(input.note, 12_000)]),
    '',
    ...(input.budgetLeftUsd === null ? [] : [`Left of your share: ${usd(input.budgetLeftUsd)}.`]),
    ...(input.timeLeftMs === null ? [] : [`Time left for this goal: ${minutes(input.timeLeftMs)}.`]),
  ]
    .join('\n')
    .trimEnd()
}

/** A new session after one whose transcript is gone (spec B6): where the last one stood, then what to do. */
export function renderLeadContinuation(input: { readonly lastCommits: string; readonly then: string }): string {
  return [
    'CONTINUATION',
    '',
    'An earlier session worked on this goal on this branch and its transcript is gone. The branch holds its work. Its last commits:',
    trimToFit(sanitisePersonText(input.lastCommits.trim() === '' ? '(none yet)' : input.lastCommits), 2_000),
    '',
    'Read the repository before you change anything. Then:',
    input.then,
    '',
    '---',
  ].join('\n')
}
