import { z } from 'zod'
import { PROVIDER_KINDS } from '../provider/kind.js'
import { INTAKE_MAX_RUNTIME_ROLES, INTAKE_STEPS, INTAKE_STEP_STATUSES } from './constants.js'

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
 *  as. `ensureStaffRoles` (`./team.js`) is what guarantees a manager and a reviewer among them. */
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
 * `verifyCommands` is `min(1)` for `createWorkspace`'s own reason (`verify_commands_empty`): a
 * project with no definition of done can never reach `done` on its own. A new repository gets one
 * too -- the model proposes for the stack it was told about, the card marks it as a proposal, and
 * R7's README says under `## Goal` what the project verifies with.
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
    .min(1)
    .max(20),
  setupCommands: z.array(z.string().trim().min(1).max(500)).max(20),
  // `finite()` and not a bare `nonnegative()`: `Infinity >= 0` is true, and an infinite ceiling in
  // a Float column is a guardrail that is silently inert -- `setWorkspaceBudget`'s own reasoning.
  budgetUsd: z.number().finite().nonnegative().nullable(),
  provider: z.enum(PROVIDER_KINDS).nullable(),
  team: z.array(intakeSeatSchema).max(12),
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
