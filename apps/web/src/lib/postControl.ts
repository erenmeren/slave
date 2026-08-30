/**
 * The one shared copy of the control-POST idiom, for NEW call sites (M14).
 *
 * Three older local copies exist -- `AgentPanel.tsx`, `GoalCard.tsx`,
 * `EmergencyStopButton.tsx` -- each documented as a deliberate small copy of the house pattern.
 * They are NOT rewritten here: their tests are not this task's to touch, and rewriting three
 * working components to import a function they already have is churn. What this module prevents
 * is a FOURTH copy.
 *
 * The contract every copy shares and this one keeps: a bare `fetch`, no state written from the
 * response beyond the error text, and the event-driven refetch loop owning truth.
 */

/** Pulls a 409 refusal's `{ error }` text, falling back to something nameable for any other
 *  non-2xx or malformed body — a control surface's error band must never render blank (spec §9). */
export function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return `request failed (${status})`
}

export async function postControl(
  url: string,
  body?: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response =
      body === undefined
        ? await fetch(url, { method: 'POST' })
        : await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (response.ok) return { ok: true }
    const data: unknown = await response.json().catch(() => null)
    return { ok: false, error: errorMessage(data, response.status) }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}
