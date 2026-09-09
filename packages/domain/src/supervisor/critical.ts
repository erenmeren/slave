/**
 * The deterministic lexicon that says "a human answers this one" (M39 §1).
 *
 * A critical question NEVER gets an automatic answer, and the check that decides so is code, not a
 * model: erratum E2 short-circuits the whole answer call when any pattern fires, so a question
 * about a credential or a spend cannot be answered even by a model that was about to be careful
 * about it. The model's own `critical` flag is a SECOND, independent signal (§1, "either signal
 * suffices; both are recorded") -- this file is the half nothing can talk its way out of.
 *
 * The six keys are the spec's six: a scope or requirement change, permissions, secrets, money,
 * destruction, and anyone outside the workspace. They are deliberately blunt. A false positive
 * costs one escalation a human answers in a sentence; a false negative is the Supervisor telling a
 * worker which API key to use.
 */

/**
 * The lexicon, in the order {@link criticalMatches} reports its hits.
 *
 * Two properties are load-bearing:
 *
 * - **No `g` or `y` flag.** A global RegExp carries `lastIndex` between `.test` calls, so the same
 *   body would match on one call and not the next -- a lexicon that answers differently the second
 *   time it is asked would let a critical question through on a retry.
 * - **Word boundaries on every alternative.** "administration" is not `admin`, "dropdown" is not
 *   `drop`, and a lexicon that fired on those would escalate half a workspace's questions.
 *
 * The alternatives are the spec's, widened to the PLURAL and inflected spellings of the same words
 * ("credentials", "deleting", "costs"): the spec's list is written `e.g.`, and a lexicon that
 * matched "permission" but not "permissions" would be a spelling test rather than a safety net.
 */
export const CRITICAL_PATTERNS: readonly { readonly key: string; readonly pattern: RegExp }[] = [
  { key: 'scope', pattern: /\b(out of scope|change the (scope|requirements?)|new requirements?)\b/i },
  { key: 'permissions', pattern: /\b(permissions?|credentials?|access tokens?|sudo|admin)\b/i },
  { key: 'secrets', pattern: /\b(secrets?|api[ _-]?keys?|passwords?|private keys?)\b/i },
  { key: 'spend', pattern: /\b(budgets?|costs?|spend|spending|pay)\b/i },
  { key: 'destructive', pattern: /\b(deletes?|deleting|drops?|force[- ]push(ing|ed)?|rm -rf|wipes?)\b/i },
  { key: 'external', pattern: /\b(e-?mails?|contacts?|customers?|clients?)\b/i },
]

/**
 * Every lexicon key `body` trips, in {@link CRITICAL_PATTERNS} order and without repeats.
 *
 * Empty means "nothing in the lexicon says a human must answer this" -- it does NOT mean the
 * question is safe to answer automatically: the answer still has to be sourced, and the model may
 * still mark it critical itself. Order is the catalogue's rather than the body's, so the same body
 * always produces the same list and a stored `draft.critical.lexicon` is comparable across rows.
 */
export function criticalMatches(body: string): readonly string[] {
  const keys: string[] = []
  for (const { key, pattern } of CRITICAL_PATTERNS) {
    if (pattern.test(body) && !keys.includes(key)) keys.push(key)
  }
  return keys
}
