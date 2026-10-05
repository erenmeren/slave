import { onUnauthorized } from './onUnauthorized'

/** What every call from a screen answers: the body on success, the refusal's words otherwise. */
export type ApiResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: string; readonly status: number }

/**
 * The one place a screen dials `fetch` from (lead UX design U-9). Never throws: a network failure
 * is an `ok: false` with its message, so a caller shows it instead of a blank. A 401 anywhere but
 * `/login` sends the person to sign in (`onUnauthorized`). A refusal's `{ error }` is the control
 * layer's own sentence; any other failure names its status, so an error is never empty.
 */
export async function api<T>(url: string, init: { readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; readonly body?: unknown } = {}): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      ...(init.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
      cache: 'no-store',
    })
    if (response.status === 401) onUnauthorized()
    const data: unknown = await response.json().catch(() => null)
    if (response.ok) return { ok: true, data: data as T }
    const error = data !== null && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : `request failed (${String(response.status)})`
    return { ok: false, error, status: response.status }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause), status: 0 }
  }
}
