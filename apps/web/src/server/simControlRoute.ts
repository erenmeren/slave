import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'
import { refusalStatus } from './refusalStatus'

/** Re-exported (M33 §4, M34 T1) so a GET route that cannot use {@link simControlResponse}'s
 *  `{ ok: true, ... }` envelope -- `adoptionPreview` answers with the preview shape itself, not a
 *  mutation's small value -- still maps a refusal the same way every other route shell does. The
 *  mapping itself now lives in one place, `refusalStatus.ts`, not duplicated here. */
export { refusalStatus }

/** The simulation routes' one answer shape: a value spread into `{ ok: true, ... }`, a not-found
 *  refusal as 404, every other refusal as 409 with `refusalText`. */
export async function simControlResponse(operate: () => Promise<Result<unknown, ControlRefusal>>): Promise<Response> {
  const result = await operate()
  if (result.ok) return Response.json({ ok: true, ...(typeof result.value === 'object' && result.value !== null ? (result.value as Record<string, unknown>) : {}) })
  return Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
}
