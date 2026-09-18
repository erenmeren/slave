import { z } from 'zod'
import { PROVIDER_KINDS } from '../provider/kind.js'
import { INTAKE_MAX_RUNTIME_ROLES, INTAKE_MAX_SEATS_PER_TEMPLATE, INTAKE_STEPS, INTAKE_STEP_STATUSES } from './constants.js'

/**
 * Where a verify command came from (M59 R8), and the difference is enforced rather than decorative:
 * `detected` means a `fact` row really found this exact string in this repository, `draft` means
 * the model proposed it for a stack it was TOLD about (only legal for a repository that does not
 * exist yet), and `operator` means a person typed it into the card -- which the model may never
 * claim (R9).
 */
export const VERIFY_SOURCES = ['detected', 'draft', 'operator'] as const

export type VerifySource = (typeof VERIFY_SOURCES)[number]

/** `docs/ia.md` rule 3: the chip shows the word, and the raw member stays on `title`. */
export const VERIFY_SOURCE_LABEL: Record<VerifySource, string> = {
  detected: 'found in the repository',
  draft: 'proposed for this stack',
  operator: 'typed by you',
}

/** One proposed seat: a persona from the Agency persona catalogue, and what it may be dispatched
 *  as. `ensureStaffRoles` (`./team.js`) is what guarantees a manager and a reviewer among them, and
 *  {@link INTAKE_MAX_SEATS_PER_TEMPLATE} is how many of these one persona may fill. */
export const intakeSeatSchema = z.object({
  templateId: z.string().min(1).max(200),
  runtimeRoles: z.array(z.string().trim().min(1).max(100)).max(INTAKE_MAX_RUNTIME_ROLES),
})

export type IntakeSeat = z.infer<typeof intakeSeatSchema>

/**
 * What the model produces and what the person edits (M59 R8).
 *
 * `repo` is a discriminated union rather than a path plus a flag, so "a repository that exists" and
 * "a repository to create" cannot be confused by a reader or by a form: `existing` REQUIRES a path
 * (there is nothing to attach otherwise) and `new` allows a null one, which `acceptIntake` resolves
 * to `<reposRoot>/<slug(name)>` and the card shows before the button is pressed.
 *
 * `verifyCommands` is required for a repository that EXISTS, for `createWorkspace`'s own reason
 * (`verify_commands_empty`): there is code in it, so something can be run against that code, and a
 * project with no definition of done can never reach `done` on its own.
 *
 * It is NOT required for a repository that does not exist yet (M60 §7a). That clause used to apply
 * to both, and the cost was measured rather than argued: there is no code in a repository nobody
 * has created, so there is no command that proves anything about it, and demanding one left the
 * model two moves -- answer `[]` and have its entire draft discarded by this schema, or INVENT a
 * command for code that does not exist. Both were observed on 2026-09-16. The first told the person
 * "Sorry -- I did not follow that", blaming their message for a refusal their message did not
 * cause, at roughly $0.10 a turn, every time, so an idea-only project could not be created at all.
 * The second is how `npx html-validate index.html` became the workspace-wide gate of a project with
 * no `index.html` anywhere in it -- the gate no task could pass, and the one two runs went into the
 * control database to rewrite rather than accept.
 *
 * An empty list never reaches `runVerify` as zero commands: `acceptIntake` plants a
 * system-authored bootstrap command in its place, so the `verify_not_configured` halt
 * (`apps/orchestrator/src/verify.ts`) cannot fire and no gate is ever fabricated by a model.
 */
export const intakeDraftSchema = z.object({
  name: z.string().trim().min(1).max(80),
  goal: z.string().trim().min(1).max(8_000),
  repo: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('existing'), path: z.string().trim().min(1).max(4_096) }),
    z.object({ mode: z.literal('new'), path: z.string().trim().min(1).max(4_096).nullable() }),
  ]),
  baseBranch: z.string().trim().min(1).max(200),
  verifyCommands: z
    .array(z.object({ command: z.string().trim().min(1).max(500), source: z.enum(VERIFY_SOURCES) }))
    .max(20),
  setupCommands: z.array(z.string().trim().min(1).max(500)).max(20),
  // `finite()` and not a bare `nonnegative()`: `Infinity >= 0` is true, and an infinite ceiling in
  // a Float column is a guardrail that is silently inert -- `setWorkspaceBudget`'s own reasoning.
  budgetUsd: z.number().finite().nonnegative().nullable(),
  provider: z.enum(PROVIDER_KINDS).nullable(),
  team: z.array(intakeSeatSchema).max(12),
})
  // The requirement the field's own `min(1)` used to carry, narrowed to the case it is true of.
  // Object-level rather than on the array, because it depends on a SIBLING field: "does this
  // project have code yet" is what decides whether a command could prove anything, and the array
  // cannot see `repo` from inside itself. The issue is reported on `verifyCommands` all the same,
  // so a caller reading the path still learns which field to fix.
  .superRefine((draft, ctx) => {
    if (draft.repo.mode === 'existing' && draft.verifyCommands.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verifyCommands'],
        message: 'a repository that already exists must say how its work is proven',
      })
    }
  })
  /**
   * Final review, Important 8: at most {@link INTAKE_MAX_SEATS_PER_TEMPLATE} seats from any one
   * persona, because a persona has exactly that many people. A draft asking for a fourth is asking
   * for somebody who does not exist, and it used to be accepted -- the twelve-seat cap on the array
   * counts seats, not who they name, so twelve copies of one specialist parsed cleanly, reached the
   * card, and were approved. `staffIntakeTeam` then filled three of them and had nothing for the
   * rest, so the operator got a team their approval never described.
   *
   * Reported at the FOURTH seat of each offending persona, on `templateId`: the path names a row a
   * form can mark and the message names the persona, so "remove this one" is actionable without
   * reading the whole team. One issue per persona rather than one per surplus seat -- five seats
   * from one persona is ONE thing wrong, and five copies of one complaint reads as five.
   *
   * A separate `superRefine` from the `verifyCommands` clause above deliberately: they check
   * unrelated fields for unrelated reasons, and Zod runs every refinement in the chain, so both
   * report on a draft that breaks both rather than the first one hiding the second.
   */
  .superRefine((draft, ctx) => {
    const seen = new Map<string, number>()
    draft.team.forEach((seat, index) => {
      const count = (seen.get(seat.templateId) ?? 0) + 1
      seen.set(seat.templateId, count)
      if (count !== INTAKE_MAX_SEATS_PER_TEMPLATE + 1) return
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['team', index, 'templateId'],
        message:
          `${seat.templateId} appears ${String(draft.team.filter((other) => other.templateId === seat.templateId).length)} ` +
          'times, and only three people exist for any one persona -- ask for at most three seats from it',
      })
    })
  })

export type IntakeDraft = z.infer<typeof intakeDraftSchema>

/**
 * A project name as the directory name used when `repo.mode: 'new'` has no explicit path.
 * Client surfaces and accept-time creation share this exact pure helper so displayed promises
 * cannot drift from the path that will be created.
 */
export function intakeRepositorySlug(name: string): string {
  const folded = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return folded === '' ? 'project' : folded.slice(0, 80)
}

/** Client-safe POSIX root + slug join for installation repository roots. */
export function intakeRepositoryPath(root: string, slug: string): string {
  const normalizedRoot = root === '/' ? '/' : root.replace(/\/+$/u, '')
  return normalizedRoot === '/' ? `/${slug}` : `${normalizedRoot}/${slug}`
}

/** One line of `Intake.stepLog` (M59 R10). `skipped` is a real outcome and not a failure: it is
 *  what the `staff` step records until M58 is on `main`. */
export const intakeStepEntrySchema = z.object({
  step: z.enum(INTAKE_STEPS),
  status: z.enum(INTAKE_STEP_STATUSES),
  at: z.string().datetime(),
  detail: z.string().max(2_000).nullable(),
})

export type IntakeStepEntry = z.infer<typeof intakeStepEntrySchema>

/** The whole log. Capped past any run of the five steps plus a resume or two: a log longer than
 *  this is a loop, not a history. */
export const intakeStepLogSchema = z.array(intakeStepEntrySchema).max(20)
