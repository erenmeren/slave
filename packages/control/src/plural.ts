/**
 * `1 run`, `0 runs`, `3 runs` — a count and its noun, with the `s` only where English wants one.
 * The web app's `lib/plural.ts` is the same rule for the same reason (M27 R17: "1 runs" in a
 * sentence about deleting data reads like a bug); this copy is for the refusal texts and the CLI,
 * which cannot import from `apps/web`. Regular nouns only — an irregular one (copy/copies) is
 * spelled at its own call site.
 */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
