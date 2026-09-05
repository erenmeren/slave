import { z } from 'zod'
import { jsonObjectsLastToFirst } from '../json/last-object.js'
import { err, ok, type Result } from '../result.js'

export interface ReviewVerdict {
  readonly verdict: 'approve' | 'reject'
  readonly reason: string
}

export const reviewVerdictSchema = z.object({
  verdict: z.enum(['approve', 'reject']),
  reason: z.string().min(1),
})

/**
 * Recover the verdict from a review run's accumulated output text. The prompt demands one JSON
 * object in the final message, but slaves wrap JSON in prose and code fences, so this scans for
 * the LAST parseable object that satisfies the schema (spec §3.2: free-form text never reaches
 * the database — only the validated object does).
 */
export function parseReviewVerdict(text: string): Result<ReviewVerdict, string> {
  for (const candidate of jsonObjectsLastToFirst(text)) {
    const parsed = reviewVerdictSchema.safeParse(candidate)
    if (parsed.success) return ok(parsed.data)
  }
  return err('no JSON object with { "verdict": "approve" | "reject", "reason": string } found in the review output')
}
