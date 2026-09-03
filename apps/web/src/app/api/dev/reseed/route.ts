import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requirePrincipal } from '../../../../server/principal'

export const dynamic = 'force-dynamic'

const run = promisify(execFile)

/**
 * The Settings danger zone's `reset demo data` (M14 §5.7). Guarded by `requirePrincipal()`, and
 * guarded by `NODE_ENV`, and guarded with a 404 rather than a 403: a route that answers
 * "forbidden" tells a production visitor that a reseed endpoint exists. In production it does not
 * exist.
 *
 * Runs the SAME `npm run db:seed` an operator would run by hand -- no second definition of what
 * the seed is. No argument reaches the shell: the command and its arguments are fixed literals
 * passed to `execFile` (never `exec`), so there is nothing here for a request body to influence.
 *
 * Cross-origin refusal moved to the app-wide boundary middleware in M15 (spec §2.3): the
 * middleware 403s any cross-site /api request before this handler runs, so a second, private
 * copy of the rule here would only be a place for the two to disagree. The NODE_ENV guard
 * stays — dev-only existence is a different rule from the browser boundary.
 *
 * Final review Important 1: this was the one mutating route in the tree with no `requirePrincipal()`
 * gate -- every other of the 25 mutating handlers opens with it. In accounts mode the middleware
 * admits a request on cookie signature and expiry alone; only `currentPrincipal()`'s database probe
 * catches a revoked user, and nothing upstream of this handler ever reached it. Gated first, same as
 * every sibling route, so a revoked session gets 401 `session revoked` before the NODE_ENV check --
 * or anything else -- runs.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  if (process.env['NODE_ENV'] === 'production') return new Response('not found', { status: 404 })
  try {
    await run('npm', ['run', 'db:seed'], { cwd: process.cwd(), timeout: 120_000 })
    return Response.json({ ok: true })
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 500 })
  }
}
