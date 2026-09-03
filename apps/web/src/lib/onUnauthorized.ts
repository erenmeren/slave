/**
 * The one shared "an expired or missing session lands on the door instead of a red band that
 * never clears" navigation (M20 spec §3.4). Extracted out of `sendControl` (`postControl.ts`) so
 * a control surface that cannot use `sendControl` -- because its success body carries more than
 * `{ ok: true }`, e.g. `ProjectsPanel`'s `POST /api/org/workspaces` -- still gets the same 401
 * behaviour rather than a hand-rolled (and easily forgotten) copy.
 *
 * On `/login` itself a 401 is a wrong password, not an expired session -- the form shows it, so
 * this is a no-op there.
 */
export function onUnauthorized(): void {
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    const here = `${window.location.pathname}${window.location.search}`
    window.location.assign(`/login?next=${encodeURIComponent(here)}`)
  }
}
