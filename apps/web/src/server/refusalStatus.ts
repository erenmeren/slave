import type { ControlRefusal } from '@slave-of-ai/control'

/**
 * The one status a `ControlRefusal` maps to across every route shell (M34 T1): 404 for a
 * not-found id, 409 for everything else the control layer declines. Membership is derived by the
 * `_not_found` suffix on the kind's own name -- not an enumerated set -- so a future refusal kind
 * named `..._not_found` is 404 automatically, with no set to remember to update. `refusal-status
 * .test.ts` still pins today's fifteen `_not_found` kinds explicitly, so a new one is at least
 * noticed and reviewed even though this function already handles it correctly by construction.
 */
export function refusalStatus(kind: ControlRefusal['kind']): 404 | 409 {
  return kind.endsWith('_not_found') ? 404 : 409
}
