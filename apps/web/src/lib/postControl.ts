import { onUnauthorized } from './onUnauthorized'

/**
 * The one shared implementation of the control-mutation idiom (M14; widened in M18 Task 9 to a
 * single `sendControl` covering every verb this app's control surfaces use -- POST, PUT, and
 * DELETE -- with `postControl` kept as a POST-shaped convenience wrapping it).
 *
 * `SlavePanel.tsx`, `project/GoalPanel.tsx`, `EmergencyStopButton.tsx`, `project/RuntimePanel.tsx`, and
 * `graph/DepsMode.tsx` (`postDependency`) each carried their own small copy of this fetch-and-decode
 * logic before Task 9 wired all five to call `sendControl`/`postControl` here instead. Task 10 (M19
 * Series C) finished the sweep -- `PermissionMatrix`, `SkillsClient`, `ModelOverrideEditor`,
 * `TemplateCatalog`, `AssignCompanyDialog`, and `CompanyManager`'s three submits all dial
 * `sendControl` now too -- so "canonical" here is a repo-wide guarantee as of M19, not just the
 * shape a new call site should reach for.
 *
 * The contract every call site relies on: a bare `fetch`, no state written from the response
 * beyond the error text, and the event-driven refetch loop owning truth.
 *
 * M20 Task 7: a 401 from anywhere outside `/login` itself navigates to `/login?next=<here>` --
 * an expired or missing session lands on the door instead of a red band that never clears.
 */

/** Pulls a refusal's `{ error }` text (a 409 conflict, or a `*_not_found` refusal's 404 since
 *  `refusalStatus`, M34 t1), falling back to something nameable for any other non-2xx or
 *  malformed body — a control surface's error band must never render blank (spec §9). */
export function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return `request failed (${status})`
}

/** The one place every control mutation in this app dials `fetch` from. `null` on success,
 *  the refusal's message otherwise -- never throws, so a caller never needs its own try/catch. */
export async function sendControl(
  url: string,
  // `PATCH` joined the set in M37 t4: the profile and runtime-role routes each replace ONE field
  // of a worker that has many, which is the verb HTTP has for that.
  options: { method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: Record<string, unknown> },
): Promise<string | null> {
  try {
    const response =
      options.body === undefined
        ? await fetch(url, { method: options.method })
        : await fetch(url, {
            method: options.method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(options.body),
          })
    if (response.ok) return null
    // An expired or missing session anywhere in the app lands on the login page instead of a red
    // band that never clears (M20 spec §3.4). Every control surface dials this one function
    // (M19 C4), so this is the one place -- `onUnauthorized` is the shared four lines, pulled out
    // so a control surface that cannot use `sendControl` (`ProjectsPanel`) still gets it.
    if (response.status === 401) onUnauthorized()
    const data: unknown = await response.json().catch(() => null)
    return errorMessage(data, response.status)
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

export async function postControl(
  url: string,
  body?: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const error = await sendControl(url, body === undefined ? { method: 'POST' } : { method: 'POST', body })
  return error === null ? { ok: true } : { ok: false, error }
}

/**
 * A POST whose ANSWER matters, not only whether it was refused (M45 R3).
 *
 * `sendControl` and `postControl` above throw the response body away, because every control verb
 * they were written for answers `{ ok: true }` and the page's own refetch is what shows the
 * result. `POST /goal/request` is the first that does not: it returns the goal VERSION it wrote,
 * and "goal v3 saved" is the whole confirmation a person gets that their words landed somewhere.
 *
 * Added here rather than a second `fetch` idiom inside `project/SupervisorRequest.tsx`: this file
 * is the one place this app dials `fetch` for a mutation, and the 401 handling below is exactly
 * why that rule exists.
 */
export async function postJson<T>(
  url: string,
  body?: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const response =
      body === undefined
        ? await fetch(url, { method: 'POST' })
        : await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
    const data: unknown = await response.json().catch(() => null)
    if (response.ok) return { ok: true, data: data as T }
    // The same door every other control surface lands on (M20 §3.4).
    if (response.status === 401) onUnauthorized()
    return { ok: false, error: errorMessage(data, response.status) }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}
