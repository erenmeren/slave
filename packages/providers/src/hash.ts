import { createHash } from 'node:crypto'

/**
 * How long any one string may be before it is cut, in CODE POINTS (M51 R1).
 *
 * A cap PER STRING, never a slice of the whole serialisation -- and that distinction is the whole
 * point of this module. A prefix slice of the serialised input collides two calls whose difference
 * sits past the cut, which in the harness this finding comes from meant nine different `Bash`
 * commands sharing a long path preamble all hashed the same and a working agent was constrained for
 * repeating itself. A per-string cap collides only two strings that are identical for their first
 * 512 characters, which is a real collision and a rare one, and never mixes one argument's length
 * with another's.
 *
 * Code points rather than UTF-16 units so a cut never lands inside a surrogate pair and produces a
 * lone half that hashes differently from run to run.
 */
export const HASH_STRING_CAP = 512

/**
 * How many entries of any one array are read. The COUNT is canonicalised alongside them, so two
 * arrays that differ only past the cap still differ.
 */
export const HASH_ARRAY_MAX = 32

/**
 * How deep the walk goes before it stops descending. A tool input is a flat-ish options object;
 * six levels is far past any measured one and bounds the walk against a pathological payload.
 */
export const HASH_DEPTH_MAX = 6

/**
 * `sha256(canonical(input))`, hex, for one tool call's arguments (M51 R1).
 *
 * **The arguments are never persisted anywhere.** This function's whole purpose is to let the
 * detector ask "is this the same call again?" without the event log becoming a transcript:
 * `RunContext.prompt` remains the only place in this system where a prompt or a body of text a
 * worker produced is stored, and `run.tool_call` carries this digest instead.
 *
 * Canonicalisation, in one pass, and every rule is a way two calls could look different while being
 * the same call (or the reverse):
 *   - object keys are SORTED, so `{a,b}` and `{b,a}` are one call;
 *   - each string is capped at {@link HASH_STRING_CAP} code points;
 *   - each array is capped at {@link HASH_ARRAY_MAX} entries, with its true LENGTH kept beside them;
 *   - the walk stops at {@link HASH_DEPTH_MAX} and writes a sentinel;
 *   - non-finite numbers, functions, symbols and `undefined` are DROPPED (they cannot round-trip
 *     through JSON anyway, so keeping them would make the digest depend on how the CLI happened to
 *     serialise the line);
 *   - a value already on the walk's own stack is a CYCLE and writes a sentinel, because a parser
 *     must not die on a shape the CLI sent.
 *
 * The four empty cases -- `undefined`, `null`, `{}`, `[]` -- canonicalise differently on purpose: a
 * tool called with no arguments and a tool called with an empty options object are different calls,
 * and folding them together would be the first collision anybody hit.
 */
export function hashToolInput(input: unknown): string {
  return createHash('sha256').update(canonical(input, 0, new Set())).digest('hex')
}

function canonical(value: unknown, depth: number, seen: Set<object>): string {
  if (depth > HASH_DEPTH_MAX) return '#deep'
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string': {
      const points = [...value]
      return points.length <= HASH_STRING_CAP ? `s:${value}` : `s:${points.slice(0, HASH_STRING_CAP).join('')}#cut`
    }
    case 'number':
      return Number.isFinite(value) ? `n:${String(value)}` : '#drop'
    case 'boolean':
      return `b:${String(value)}`
    case 'bigint':
      return `n:${value.toString()}`
    case 'undefined':
    case 'function':
    case 'symbol':
      return '#drop'
    default:
      break
  }
  const object = value as object
  if (seen.has(object)) return '#cycle'
  seen.add(object)
  try {
    if (Array.isArray(value)) {
      const head = value.slice(0, HASH_ARRAY_MAX).map((entry) => canonical(entry, depth + 1, seen))
      return `a:${String(value.length)}:[${head.join(',')}]`
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, canonical(entry, depth + 1, seen)] as const)
      // Dropped values take their KEY with them: a key whose value cannot be canonicalised is not a
      // fact about the call, and keeping the bare key would make `{f: () => 1}` differ from `{}`
      // for a reason nobody could see.
      .filter(([, entry]) => entry !== '#drop')
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `o:{${entries.map(([key, entry]) => `${key}=${entry}`).join(',')}}`
  } finally {
    seen.delete(object)
  }
}
