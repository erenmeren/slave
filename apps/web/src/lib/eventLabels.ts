/**
 * What each family of events is called on the Activity rail (M44 R5).
 *
 * The rail's keys are the dotted PREFIXES `buildActivityPage` groups by
 * (`split_part(type::text, '.', 1) || '.*'`), not the ~57 raw event types -- the M44 spec says
 * "event-type prefix", and this is what that is (plan erratum E5). The raw prefix stays on the
 * bar's `data-prefix` attribute, which a test already pins, and in the label's `title`.
 *
 * Not a `Record<...>` over a closed union: the prefixes come out of SQL as strings, so a family
 * added later must fall back to its own prefix rather than render nothing. That fallback is a
 * safety net and was never a licence to skip an entry -- `apps/web/test/eventLabels.test.ts` holds
 * this table to `EVENT_TYPE_BY_DOMAIN_TYPE`'s own prefixes in both directions, because the
 * fallback RENDERS THE KEY and the one page that claims "the event-type rail reads words"
 * (`docs/ia.md:54`) is where it renders it. `gate:m44-ux-foundation` cannot find that: its seeded
 * database holds no rows of a newly added type, so the bar never draws.
 *
 * M52 t5 fix round 1 (review Important 2) added the last three. `broker.*` and `permission.*` are
 * this milestone's; `memory.*` had been missing since M49, which is exactly what the parity case
 * was written to stop.
 */
export const EVENT_PREFIX_LABEL: Readonly<Record<string, string>> = {
  'task.*': 'Tasks',
  'run.*': 'Runs',
  'slave.*': 'Messages',
  'guardrail.*': 'Guardrails',
  'workspace.*': 'Project',
  'org.*': 'Organisation',
  'supervisor.*': 'Supervisor',
  // M49 R4: the Knowledge tab's word, not the table's -- `/w/:id/knowledge` is what a person
  // clicks and `memory` is what the column is called.
  'memory.*': 'Knowledge',
  // M52 R3: an operation the orchestrator ran FOR a worker, and the refusal of one. `Brokered`
  // rather than `Broker`, so `readableEventType` reads `Brokered · executed` as a sentence.
  'broker.*': 'Brokered',
  // M52 R5: the same word the worker panel's group and the Settings matrix use, because it is the
  // same idea -- what a worker may do.
  'permission.*': 'Permissions',
}

export function eventPrefixLabel(prefix: string): string {
  return EVENT_PREFIX_LABEL[prefix] ?? prefix
}

/**
 * One dotted event type, said out loud: `run.started` → `Runs · started`,
 * `task.dependency_added` → `Tasks · dependency added`.
 *
 * Found by `gate:m44-ux-foundation`'s stage 4 and fixed here rather than exempted. Two surfaces
 * printed the raw type as their only words -- the Overview page's `live events` panel (through
 * {@link feedSummary}'s fallback) and the Activity river's own `e.kind` chip -- so the most
 * user-facing panel on the most user-facing page read `run.started`, which is precisely the
 * vocabulary M44 R5 exists to stop showing people.
 *
 * A PROJECTION, deliberately not a table. Erratum E5 declined a per-type label table for the
 * ~57 event types and that ruling stands: this reuses the seven-family table above and
 * de-underscores whatever follows the dot, so a fifty-eighth event type needs no entry anywhere
 * and can never render as `undefined`. On the Activity page the raw type stays reachable the same
 * way every other R5 fix keeps it -- `data-event-type` on the row, `title` on the chip. The
 * Overview panel deliberately carries no such attribute: `liveEvents` is a three-field snapshot on
 * the RSC wire, and that panel's own `all →` action opens the Activity page, where it is.
 */
export function readableEventType(type: string): string {
  const dot = type.indexOf('.')
  if (dot === -1) return type.replace(/_/g, ' ')
  const prefix = type.slice(0, dot)
  // `EVENT_PREFIX_LABEL[...] ?? prefix`, not `eventPrefixLabel`: that helper falls back to the
  // KEY it was given (`nothing.*`), which is the right answer for the rail (whose rows are keyed
  // by that exact string) and the wrong one here, where a `.*` in the middle of a sentence is one
  // more thing a reader has to decode.
  const family = EVENT_PREFIX_LABEL[`${prefix}.*`] ?? prefix
  const rest = type.slice(dot + 1).replace(/_/g, ' ')
  return rest === '' ? family : `${family} · ${rest}`
}
