/**
 * Yields every parseable balanced-brace JSON object in `text`, scanning from the rightmost `{`
 * to the leftmost — LAST object to FIRST. Slave output routinely wraps JSON in prose and code
 * fences, or emits more than one candidate object; consumers pick the first one (i.e. the one
 * that appears last in the text) that also satisfies their schema.
 */
export function* jsonObjectsLastToFirst(text: string): Generator<unknown> {
  // `start > 0` guard: lastIndexOf clamps a negative fromIndex to 0, so stepping back from a
  // rejected candidate at index 0 would find index 0 again and never terminate.
  for (let start = text.lastIndexOf('{'); start !== -1; start = start > 0 ? text.lastIndexOf('{', start - 1) : -1) {
    const candidate = extractObject(text, start)
    if (candidate !== null) yield candidate
  }
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
