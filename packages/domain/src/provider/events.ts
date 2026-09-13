/**
 * Every variant `RuntimeEvent` has (M56a erratum E1).
 *
 * `RuntimeEvent` itself lives in `packages/providers/src/types.ts` and stays there -- it carries a
 * `ToolErrorClass` and a `RunOutcome` and is the providers package's own vocabulary. What a
 * MANIFEST needs is only the NAMES, so a provider can say which of them its stream can produce, and
 * a name is a thing the domain can hold.
 *
 * The list is pinned to the union in both directions at `packages/providers/src/types.ts`: a
 * fourteenth variant added there without a member here, or a member here that is not a variant,
 * fails the build in the file that did it. That pin is why this list may be trusted by a manifest
 * that cannot see the union it describes.
 *
 * ORDER IS THE UNION'S OWN, not alphabetical, so the two read side by side in a diff.
 *
 * `ignored` and `unparsable` are here because the union has them and are not a vendor's events:
 * the first is a recognised line a parser does not act on, the second one it could not read at all.
 * No manifest may list either (`providerManifestSchema`, `manifest.ts`).
 */
export const RUNTIME_EVENT_KINDS = [
  'session_started',
  'tool_call',
  'tool_result',
  'usage',
  'text',
  'hook_started',
  'hook_denied',
  'hook_crashed',
  'hook_failed_open',
  'permission_denied',
  'terminated',
  'ignored',
  'unparsable',
] as const

export type RuntimeEventKind = (typeof RUNTIME_EVENT_KINDS)[number]

/** The two members no runtime PRODUCES: a parser makes them out of a line it read or could not. */
export const PARSER_EVENT_KINDS = ['ignored', 'unparsable'] as const satisfies readonly RuntimeEventKind[]
