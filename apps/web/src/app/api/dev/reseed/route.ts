import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const dynamic = 'force-dynamic'

const run = promisify(execFile)

/**
 * The Settings danger zone's `reset demo data` (M14 §5.7). Guarded by `NODE_ENV`, and guarded
 * with a 404 rather than a 403: a route that answers "forbidden" tells a production visitor that
 * a reseed endpoint exists. In production it does not exist.
 *
 * Runs the SAME `npm run db:seed` an operator would run by hand -- no second definition of what
 * the seed is. No argument reaches the shell: the command and its arguments are fixed literals
 * passed to `execFile` (never `exec`), so there is nothing here for a request body to influence.
 *
 * Also refused cross-origin (M14 fix wave, review I8). Every route on this app is unauthenticated
 * and localhost-only, and auth is out of scope -- but this is the first one whose unauthenticated
 * invocation DESTROYS local state: with a dev server up, any page in the same browser could
 * `fetch('http://localhost:3000/api/dev/reseed', {method:'POST', mode:'no-cors'})` and wipe the
 * developer's database. `sec-fetch-site` is set by the browser and cannot be forged from page
 * JavaScript; `same-origin` is this app's own UI and `none` is a direct navigation or a
 * non-browser client (curl, the route tests). Anything else -- `cross-site`, `same-site` -- is a
 * page that is not this app asking this app to erase itself, and gets the same 404 production
 * gets, for the same reason: a 403 would confirm the endpoint exists.
 *
 * Checked BEFORE any side effect, and before the `execFile`, so a refused request costs nothing.
 */
const ALLOWED_FETCH_SITES = ['same-origin', 'none'] as const

export async function POST(request: Request): Promise<Response> {
  if (process.env['NODE_ENV'] === 'production') return new Response('not found', { status: 404 })
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && !(ALLOWED_FETCH_SITES as readonly string[]).includes(site)) {
    return new Response('not found', { status: 404 })
  }
  try {
    await run('npm', ['run', 'db:seed'], { cwd: process.cwd(), timeout: 120_000 })
    return Response.json({ ok: true })
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 500 })
  }
}
