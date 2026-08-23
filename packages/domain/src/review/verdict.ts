import { z } from 'zod'
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
 * object in the final message, but agents wrap JSON in prose and code fences, so this scans for
 * the LAST parseable object that satisfies the schema (spec §3.2: free-form text never reaches
 * the database — only the validated object does).
 */
export function parseReviewVerdict(text: string): Result<ReviewVerdict, string> {
  for (let start = text.lastIndexOf('{'); start !== -1; start = text.lastIndexOf('{', start - 1)) {
    const candidate = extractObject(text, start)
    if (candidate === null) continue
    const parsed = reviewVerdictSchema.safeParse(candidate)
    if (parsed.success) return ok(parsed.data)
  }
  return err('no JSON object with { "verdict": "approve" | "reject", "reason": string } found in the review output')
}

/** Parse the balanced-brace substring starting at `start`, string-aware; null when unparseable. */
function extractObject(text: string, start: number): unknown {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i += 1
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}
