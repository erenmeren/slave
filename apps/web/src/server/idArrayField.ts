/**
 * One optional field of a skill-write route body that must be an array of ids when present
 * (workforce cards F12): absent means the caller did not touch that list, present-but-malformed is
 * `'bad'`. Shared by the persons-skills and templates-skills routes so the two bodies -- `{ grant,
 * revoke, clear }` and `{ skillIds }` / `{ add, remove }` -- are read by the same rule rather than
 * each route parsing "an array of strings" its own way.
 */
export function optionalIdArray(value: unknown): readonly string[] | undefined | 'bad' {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((one) => typeof one !== 'string')) return 'bad'
  return value as readonly string[]
}
