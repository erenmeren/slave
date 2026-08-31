/**
 * The one shared copy of the control-POST idiom (M14).
 *
 * `AgentPanel.tsx`, `GoalCard.tsx`, and `EmergencyStopButton.tsx` each carried their own small
 * copy of this pattern before Task 14; all three, along with every other call site, now import
 * `errorMessage` from here instead. This is the single canonical copy repo-wide -- what it
 * prevents is a new one appearing.
 *
 * The contract every call site relies on: a bare `fetch`, no state written from the response
 * beyond the error text, and the event-driven refetch loop owning truth.
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
