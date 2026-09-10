/**
 * What each family of events is called on the Activity rail (M44 R5).
 *
 * The rail's keys are the seven dotted PREFIXES `buildActivityPage` groups by
 * (`split_part(type::text, '.', 1) || '.*'`), not the ~48 raw event types -- the M44 spec says
 * "event-type prefix", and this is what that is (plan erratum E5). The raw prefix stays on the
 * bar's `data-prefix` attribute, which a test already pins, and in the label's `title`.
 *
 * Not a `Record<...>` over a closed union: the prefixes come out of SQL as strings, so a family
 * added later must fall back to its own prefix rather than render nothing.
 */
export const EVENT_PREFIX_LABEL: Readonly<Record<string, string>> = {
  'task.*': 'Tasks',
  'run.*': 'Runs',
  'slave.*': 'Messages',
  'guardrail.*': 'Guardrails',
  'workspace.*': 'Project',
  'org.*': 'Organisation',
  'supervisor.*': 'Supervisor',
}

export function eventPrefixLabel(prefix: string): string {
  return EVENT_PREFIX_LABEL[prefix] ?? prefix
}
