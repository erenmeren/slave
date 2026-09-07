import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'

const NOT_FOUND: ReadonlySet<ControlRefusal['kind']> = new Set(['simulation_not_found', 'company_not_found'])

/** The one status a refusal maps to across every simulation route -- 404 for a not-found id, 409
 *  for everything else the control layer declines. Exported (M33 §4) so a GET route that cannot
 *  use {@link simControlResponse}'s `{ ok: true, ... }` envelope -- `adoptionPreview` answers with
 *  the preview shape itself, not a mutation's small value -- still maps a refusal the same way. */
export function refusalStatus(kind: ControlRefusal['kind']): number {
  return NOT_FOUND.has(kind) ? 404 : 409
}

/** The simulation routes' one answer shape: a value spread into `{ ok: true, ... }`, a not-found
 *  refusal as 404, every other refusal as 409 with `refusalText`. */
export async function simControlResponse(operate: () => Promise<Result<unknown, ControlRefusal>>): Promise<Response> {
  const result = await operate()
  if (result.ok) return Response.json({ ok: true, ...(typeof result.value === 'object' && result.value !== null ? (result.value as Record<string, unknown>) : {}) })
  return Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
