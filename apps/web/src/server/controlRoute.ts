import { refusalText, type ControlRefusal } from '@slave-of-ai/control'
import type { Result } from '@slave-of-ai/domain'
import { refusalStatus } from './refusalStatus'

/**
 * The envelope of a write that belongs to no project (a person, a persona): `{ ok: true }` with
 * what the verb answered beside it, or the refusal's own sentence with its status (404 for a
 * thing that is not there, 409 for anything else the control layer declines).
 */
export async function controlResponse(operate: () => Promise<Result<unknown, ControlRefusal>>): Promise<Response> {
  const result = await operate()
  if (!result.ok) return Response.json({ error: refusalText(result.error) }, { status: refusalStatus(result.error.kind) })
  return Response.json({ ok: true, ...(result.value !== null && typeof result.value === 'object' ? result.value : {}) })
}

/** The page a list request asked for: `offset` and `limit` as whole numbers, absent when not given
 *  or not a number (the read function bounds them). */
export function pageOf(params: URLSearchParams): { readonly offset?: number; readonly limit?: number } {
  const whole = (key: string): number | undefined => {
    const raw = params.get(key)
    return raw !== null && /^\d{1,6}$/u.test(raw) ? Number(raw) : undefined
  }
  const [offset, limit] = [whole('offset'), whole('limit')]
  return { ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) }
}

/** A filter's text from the query string: trimmed, absent when empty. */
export function textOf(params: URLSearchParams, key: string): string | undefined {
  const value = (params.get(key) ?? '').trim()
  return value === '' ? undefined : value
}
