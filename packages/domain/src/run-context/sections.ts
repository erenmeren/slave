import { z } from 'zod'

/**
 * The named pieces a run's prompt is assembled from (M37 §3). Each kind is produced by exactly
 * one part of `apps/orchestrator/src/runContext.ts` (Task 2) and rendered in a fixed order per
 * run kind by {@link renderRunContext} (`render.ts`).
 */
export type SectionKind =
  | 'profile'
  | 'roster'
  | 'skills'
  | 'inbox'
  | 'ask_protocol'
  | 'answer_protocol'
  | 'task'
  | 'rejection'
  | 'review_diff'
  | 'planning_goal'
  /** M40 §3: present only on a RE-plan run -- the run kind stays `planning`, and this section is
   *  what tells the two apart (spec erratum E2/E4), for `renderRunContext`'s trailer choice and
   *  for `concludePlanning`'s routing. */
  | 'replan'
  /** M47 R3: the taxonomy keys this workspace can ask for, rendered from the `Capability` table by
   *  the orchestrator. A SECTION and not part of `PLANNING_GRAPH_INSTRUCTIONS` (plan erratum E3):
   *  that constant is pure, static, pinned byte-for-byte by a test, and is what the fake CLI
   *  selects its planning arm on — and a per-workspace key list is none of those things. */
  | 'capabilities'

/**
 * One piece of a run's prompt, as the orchestrator hands it to {@link renderRunContext}: the
 * rendered text (already `neutraliseMarkers`-treated where the milestone requires it -- the
 * renderer itself does not touch section text) and a `source`, which is what actually gets
 * recorded on the `RunContext` row -- `text` never is.
 */
export interface Section {
  readonly kind: SectionKind
  readonly text: string
  readonly source: SectionSource
}

/**
 * What produced a section, durable enough to write to `RunContext.sections` and read back later
 * (a debugger, the Supervisor) without re-deriving it from a prompt string. Deliberately NOT the
 * section text itself -- `RunContext.prompt` already carries that once, in full; the source is
 * the provenance a reader wants alongside it.
 */
export type SectionSource =
  | { readonly kind: 'profile'; readonly origin: 'slave' | 'company' | 'template'; readonly sha256: string }
  | { readonly kind: 'roster'; readonly slaveIds: readonly string[] }
  | {
      readonly kind: 'skills'
      readonly copied: readonly string[]
      readonly missing: readonly string[]
      readonly shadowedByRepo: readonly string[]
      readonly provider_unsupported: boolean
      readonly no_worktree: boolean
    }
  | { readonly kind: 'inbox'; readonly messageIds: readonly string[] }
  | { readonly kind: 'ask_protocol' }
  | { readonly kind: 'answer_protocol' }
  /**
   * M40 §1, "the hash is the hook": `sha256` of the task's `title + '\n' + description` as the
   * run actually saw it. Task text is immutable today, so this is provenance a reader can check
   * rather than a change detector -- and the moment editing arrives it becomes both.
   *
   * OPTIONAL, and only on READ (M40 t1 fix round 1, Important 1). Every `RunContext` row written
   * before M40 records a `task` source with no hash, and this schema's whole job is that "a
   * hand-edited or pre-migration row cannot crash a reader" -- both readers (`show-context` in
   * `apps/orchestrator/src/cli.ts`, the web's run-context route) turn a parse failure into a hard
   * error, so requiring it made every historical run's context unreadable. The WRITE site is
   * strict: `buildRunContext` always sets it, and M40 Task 3 asserts that every manifest it builds
   * carries both this and {@link SectionSource}'s `planning_goal.version`.
   */
  | { readonly kind: 'task'; readonly taskId: string; readonly sha256?: string | undefined }
  | { readonly kind: 'rejection'; readonly taskId: string }
  | { readonly kind: 'review_diff'; readonly base: string; readonly head: string; readonly capped: boolean }
  /** `version` is `Workspace.goalVersion` at dispatch (M40 §1) -- which `GoalVersion` row this
   *  prompt's goal text IS, so a plan can be traced to the requirement that produced it. OPTIONAL
   *  on read for the same reason as `task.sha256` above: a pre-M40 planning run recorded no
   *  version, and a reader must still be able to show what that run saw. */
  | { readonly kind: 'planning_goal'; readonly sha256: string; readonly version?: number | undefined }
  /** M40 §3: the goal CHANGED and the board is not empty. Both ends of the move (version and hash)
   *  plus the board the delta was read against, so a `workspace.replanned` can be checked against
   *  the exact list of ids the manager was shown. */
  | {
      readonly kind: 'replan'
      readonly previousVersion: number
      readonly version: number
      readonly previousSha256: string
      readonly sha256: string
      readonly boardTaskIds: readonly string[]
    }
  /** Which keys the planner was shown, and whether the list was capped. The KEYS, not the text:
   *  a reader asking "could this plan have named `security.application`?" wants the vocabulary the
   *  run was actually given. */
  | { readonly kind: 'capabilities'; readonly keys: readonly string[]; readonly capped: boolean }

/** The manifest stored (as `Json`) on `RunContext.sections` -- an ordered record of what produced
 *  the prompt, without the prompt text itself. */
export interface Manifest {
  readonly kind: 'implementation' | 'review' | 'planning'
  readonly sections: readonly SectionSource[]
}

const profileSourceSchema = z.object({
  kind: z.literal('profile'),
  origin: z.enum(['slave', 'company', 'template']),
  sha256: z.string(),
})

const rosterSourceSchema = z.object({
  kind: z.literal('roster'),
  slaveIds: z.array(z.string()),
})

const skillsSourceSchema = z.object({
  kind: z.literal('skills'),
  copied: z.array(z.string()),
  missing: z.array(z.string()),
  shadowedByRepo: z.array(z.string()),
  provider_unsupported: z.boolean(),
  no_worktree: z.boolean(),
})

const inboxSourceSchema = z.object({
  kind: z.literal('inbox'),
  messageIds: z.array(z.string()),
})

const askProtocolSourceSchema = z.object({ kind: z.literal('ask_protocol') })
const answerProtocolSourceSchema = z.object({ kind: z.literal('answer_protocol') })

// `sha256` optional on read (fix round 1), NOT loose: a row that carries the key must carry a
// string, so a hand-edited `sha256: 42` is still refused. Absent and wrong are different states.
const taskSourceSchema = z.object({ kind: z.literal('task'), taskId: z.string(), sha256: z.string().optional() })
const rejectionSourceSchema = z.object({ kind: z.literal('rejection'), taskId: z.string() })

const reviewDiffSourceSchema = z.object({
  kind: z.literal('review_diff'),
  base: z.string(),
  head: z.string(),
  capped: z.boolean(),
})

// Same rule as `task.sha256`: absent parses (a pre-M40 row), present-and-malformed does not -- a
// negative or fractional version is not a `GoalVersion` any workspace can have.
const planningGoalSourceSchema = z.object({
  kind: z.literal('planning_goal'),
  sha256: z.string(),
  version: z.number().int().nonnegative().optional(),
})

const replanSourceSchema = z.object({
  kind: z.literal('replan'),
  previousVersion: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  previousSha256: z.string(),
  sha256: z.string(),
  boardTaskIds: z.array(z.string()),
})

// M47 E3: both fields REQUIRED, by the same rule `replan` follows -- this source kind is new in
// M47, so there is no history of rows written without them to be tolerant of.
const capabilitiesSourceSchema = z.object({
  kind: z.literal('capabilities'),
  keys: z.array(z.string()),
  capped: z.boolean(),
})

const sectionSourceSchema = z.discriminatedUnion('kind', [
  profileSourceSchema,
  rosterSourceSchema,
  skillsSourceSchema,
  inboxSourceSchema,
  askProtocolSourceSchema,
  answerProtocolSourceSchema,
  taskSourceSchema,
  rejectionSourceSchema,
  reviewDiffSourceSchema,
  planningGoalSourceSchema,
  replanSourceSchema,
  capabilitiesSourceSchema,
])

/**
 * Validates a stored `RunContext.sections` `Json` value at read (M37 §3) -- so a hand-edited or
 * pre-migration row cannot crash a reader (the CLI's `show-context`, Task 4's web route) that
 * expects the {@link Manifest} shape.
 *
 * READ-tolerant, WRITE-strict (M40 t1 fix round 1): a field this milestone added to an EXISTING
 * source kind is optional here, because rows predating it exist and both readers turn a parse
 * failure into a hard error. A field on a source kind M40 itself introduced (`replan`) is required
 * -- there is no history of it to be tolerant of.
 */
export const runContextManifestSchema: z.ZodType<Manifest> = z.object({
  kind: z.enum(['implementation', 'review', 'planning']),
  sections: z.array(sectionSourceSchema),
})
