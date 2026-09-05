/**
 * `1 run`, `0 runs`, `3 runs` — a count and its noun, with the `s` only where English wants one
 * (M27 final review, controller ruling R17).
 *
 * Its reason for existing is the confirm texts: `DangerConfirm` states counts ("deletes Alex and
 * 1 run of history"), and three of the seven wrote `${n} runs` flat while the other four repeated
 * the same `${n === 1 ? '' : 's'}` ternary inline. One helper is the only way the seven agree, and
 * a confirm that says "1 runs" reads like a bug in the thing about to delete your data.
 *
 * Regular nouns only — every noun this milestone puts a count in front of (run, slave, department,
 * task, project, department template, catalog slave) takes a plain `s`. An irregular one needs its
 * own call site, not a rule table nothing else would use.
 */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}
