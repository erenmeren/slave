/**
 * What KIND of failure one tool call reported (M51 R1), as a closed list.
 *
 * A normalised token and never the error text: a breaker asking "is everything failing the same
 * way" needs a class, and the text of a failure is exactly the unbounded, sometimes-secret-bearing
 * thing the event log must not hold.
 *
 * The list types the PRODUCERS -- `run.tool_result.errorClass` is `z.string().min(1).max(40)
 * .nullable()` on the wire, for `guardrail.tripped`'s own reason (M51 R4, plan erratum E17): a
 * closed enum in the schema would make a log holding a class a later version invented unreadable,
 * and `packages/events/src/read.ts` throws on a row it cannot parse.
 */
export const TOOL_ERROR_CLASSES = ['api_error', 'timeout', 'not_found', 'permission', 'other'] as const

export type ToolErrorClass = (typeof TOOL_ERROR_CLASSES)[number]

/**
 * The class of one failure, from whatever the runtime said about it. Total, and `other` for
 * everything it does not recognise.
 *
 * Matched on the error text case-insensitively, and deliberately on BOTH the human wording and the
 * errno the runtimes actually emit -- `ENOENT`/`ENOTDIR` for not-found, `EACCES`/`EPERM` for
 * permission. The order matters where two could match: a timeout inside an API call is a timeout,
 * because that is what a person would do something about.
 *
 * Nothing here is measured against every possible tool, and nothing needs to be: an unrecognised
 * failure is `other`, `other` still counts toward an error storm, and the class only ever decorates
 * the trip's `detail`. Being wrong about a class costs a word on a card; being wrong about the
 * OUTCOME would cost a trip, and the outcome is read from the runtime's own boolean.
 *
 * The SHELL twin of this function lives in `scripts/tool-result-tap.sh` (`classify_tool_error`),
 * which classifies the same five tokens for the PostToolUse tap because a hook cannot import
 * TypeScript. `packages/providers/test/tool-result-tap.test.ts` pins the two against each other
 * case by case, the way `scripts/lib/permissions.sh` is pinned against
 * `PERMISSION_DENY_REASON_PREFIX`, so neither can drift alone.
 */
export function classifyToolError(text: string | null): ToolErrorClass {
  if (text === null) return 'other'
  const lower = text.toLowerCase()
  if (lower.includes('timed out') || lower.includes('timeout') || lower.includes('etimedout')) return 'timeout'
  if (lower.includes('api error') || lower.includes('api_error') || lower.includes('rate limit')) return 'api_error'
  if (lower.includes('enoent') || lower.includes('enotdir') || lower.includes('no such file')) return 'not_found'
  if (lower.includes('eacces') || lower.includes('eperm') || lower.includes('permission denied')) return 'permission'
  return 'other'
}
