import { z } from 'zod'
import { err, ok, type Result } from '../result.js'
import { SLAVE_REPORT_TAG } from './contract.js'

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
})

/**
 * Whether `text` ends its LAST `<slave-report>` with a closing tag -- the pump's cheap "this worker
 * finished and reported" test (skeleton spec S9, plan A D9). Whether the report is USABLE is
 * `parseSlaveReport`'s question, asked afterwards by `fileRunReport`.
 */
export function hasSlaveReportBlock(text: string): boolean {
  const start = text.lastIndexOf(`<${SLAVE_REPORT_TAG}>`)
  return start !== -1 && text.indexOf(`</${SLAVE_REPORT_TAG}>`, start) !== -1
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
    value = JSON.parse(text.slice(start + open.length, end))
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
