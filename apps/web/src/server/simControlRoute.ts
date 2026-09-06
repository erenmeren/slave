import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'

const NOT_FOUND: ReadonlySet<ControlRefusal['kind']> = new Set(['simulation_not_found', 'company_not_found'])

/** The simulation routes' one answer shape: a value spread into `{ ok: true, ... }`, a not-found
 *  refusal as 404, every other refusal as 409 with `refusalText`. */
export async function simControlResponse(operate: () => Promise<Result<unknown, ControlRefusal>>): Promise<Response> {
  const result = await operate()
  if (result.ok) return Response.json({ ok: true, ...(typeof result.value === 'object' && result.value !== null ? (result.value as Record<string, unknown>) : {}) })
  return Response.json({ error: refusalText(result.error) }, { status: NOT_FOUND.has(result.error.kind) ? 404 : 409 })
}
