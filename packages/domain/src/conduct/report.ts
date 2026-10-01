import { z } from 'zod'
import { err, ok, type Result } from '../result.js'
import { HANDOFFS_PER_REPORT_MAX } from './constants.js'
import { SLAVE_REPORT_TAG } from './contract.js'
import { readHandOffItem, type ReportedHandOff } from './handOff.js'
import { storableJsonReviver } from './storable.js'

/** A package worker's report on its run (spec R7), as {@link parseSlaveReport} reads it. */
export interface SlaveReport {
  readonly requirements: readonly {
    readonly key: string
    readonly status: 'done' | 'partial' | 'not_done'
    readonly evidence: string
  }[]
  readonly filesTouched: readonly string[]
  readonly workflow: readonly { readonly step: number | string; readonly done: boolean; readonly note: string }[]
  readonly questions: readonly string[]
  /** Supervisor-as-conductor spec C1: changes in files this package does not own, or work another
   *  package must do. Routed by ownership when the report is filed (`routeHandOffs`). An item that
   *  does not read is kept in its place as an `UnreadableHandOff` (final review M4). */
  readonly handOffs: readonly ReportedHandOff[]
  /** User ruling 2026-09-30 (plan B D11): a smoke rework's claim that its fix is in a file another
   *  package owns -- a path and what must change there. A claim only: `handOffSmokeRework` checks it. */
  readonly handOff?: { readonly path: string; readonly change: string } | undefined
}

const reportSchema = z.object({
  requirements: z.array(
    z.object({
      key: z.string(),
      status: z.enum(['done', 'partial', 'not_done']),
      evidence: z.string().max(4000).default(''),
    }),
  ),
  filesTouched: z.array(z.string().max(500)).max(500).default([]),
  workflow: z
    .array(
      z.object({
        step: z.union([z.number().int(), z.string().max(200)]),
        done: z.boolean(),
        note: z.string().max(2000).default(''),
      }),
    )
    .max(100)
    .default([]),
  questions: z.array(z.string().trim().min(1).max(4000)).max(10).default([]),
  // Spec C1: absent in a report written before this plan, which reads as none (spec §4).
  // Final review M4: the list is the report's; each item is read on its own (`readHandOffItem`), so
  // one malformed item becomes a conductor question instead of refusing the whole report.
  handOffs: z.array(z.unknown()).max(HANDOFFS_PER_REPORT_MAX).default([]).transform((items) => items.map(readHandOffItem)),
  // User ruling 2026-09-30 (skeleton-and-smoke plan B D11): a smoke rework's structured hand-off --
  // the file another package owns that the fix needs, and what must change in it. The bounds are
  // `workspace.smoke_handed_off`'s, so a filed claim always fits its event.
  handOff: z.object({ path: z.string().trim().min(1).max(500), change: z.string().trim().max(2000).default('') }).optional(),
})

/** Skeleton spec S8: what one package's latest report asks a verifier to look into. */
export interface WorkerLead {
  readonly packageKey: string
  readonly lines: readonly string[]
}

/**
 * The leads in a stored `RunReport.report` (plan A D11): its questions, every requirement it did
 * not call done (with the worker's own evidence), and every non-empty workflow note. `null` when
 * there is none, or when the row does not read as a report (a later build's shape) -- a lead is
 * never worth a thrown dispatch. The lines are the worker's RAW text: the verifier's prompt
 * sanitises them where it renders them (`renderVerificationLeads`).
 */
export function leadFromReport(packageKey: string, stored: unknown): WorkerLead | null {
  const parsed = reportSchema.safeParse(stored)
  if (!parsed.success) return null
  const lines = [
    ...parsed.data.questions,
    ...parsed.data.requirements.filter((r) => r.status !== 'done').map((r) => `${r.key} ${r.status.replace('_', ' ')}: ${r.evidence}`),
    ...parsed.data.workflow.filter((w) => w.note.trim() !== '').map((w) => `workflow step ${String(w.step)}: ${w.note}`),
  ]
  return lines.length === 0 ? null : { packageKey, lines }
}

/**
 * Whether `text` ends with its LAST `<slave-report>` block, closed -- the pump's cheap "this worker
 * finished and reported" test (skeleton spec S9, plan A D9). Whether the report is USABLE is
 * `parseSlaveReport`'s question, asked afterwards by `fileRunReport`.
 */
export function hasSlaveReportBlock(text: string): boolean {
  const start = text.lastIndexOf(`<${SLAVE_REPORT_TAG}>`)
  const close = `</${SLAVE_REPORT_TAG}>`
  // Anchored at the END (Task 6 fix round 1): the pump's text is every text event joined, so a
  // report followed by "Now let me also clean up..." is a worker that went on working, not one
  // that finished.
  return start !== -1 && text.indexOf(close, start) !== -1 && text.trimEnd().endsWith(close)
}

/**
 * The worker's report (spec R7), from the LAST `<slave-report>` block of its final message -- a
 * worker that quotes its instructions or revises its report mid-message means the last one. Every
 * requirement key of its package must appear exactly once; the error names each gap, because it
 * is handed back to the worker as the rework reason.
 */
export function parseSlaveReport(text: string, requirementKeys: readonly string[]): Result<SlaveReport, string> {
  const open = `<${SLAVE_REPORT_TAG}>`
  const close = `</${SLAVE_REPORT_TAG}>`
  const start = text.lastIndexOf(open)
  if (start === -1) return err(`the final message has no ${open} block`)
  const end = text.indexOf(close, start)
  if (end === -1) return err(`the ${open} block is not closed`)
  let value: unknown
  try {
    // Final review I2: a `\u0000` escape parses to a NUL byte, which the stored report's jsonb
    // refuses -- the filing then threw, and a hand-off's change never reached its attempt row.
    value = JSON.parse(text.slice(start + open.length, end), storableJsonReviver)
  } catch {
    return err(`the ${open} block is not valid JSON`)
  }
  const parsed = reportSchema.safeParse(value)
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`)
    return err(`the ${open} block's shape is wrong: ${issues.join('; ')}`)
  }
  const problems: string[] = []
  for (const key of requirementKeys) {
    const count = parsed.data.requirements.filter((r) => r.key === key).length
    if (count === 0) problems.push(`${key} is not reported`)
    if (count > 1) problems.push(`${key} is reported ${String(count)} times`)
  }
  for (const r of parsed.data.requirements) {
    if (!requirementKeys.includes(r.key)) problems.push(`${r.key} is not one of yours`)
  }
  if (problems.length > 0) return err(`the report is incomplete: ${[...new Set(problems)].join('; ')}`)
  return ok(parsed.data)
}
