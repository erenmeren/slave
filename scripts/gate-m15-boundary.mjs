// M15's own gate (Task 5 brief, spec §5): the boundary holds -- foreign Host, cross-site writes and
// cross-site SSE reads all refused by the app-wide middleware (`apps/web/src/middleware.ts`,
// `apps/web/src/lib/boundary.ts`) in a REAL `next dev`, while same-origin and headerless traffic
// pass straight through to the routes. No browser: every check here is a plain `fetch` (or, for the
// one check that needs it, a raw `node:http` request) against JSON responses -- the middleware
// speaks HTTP, not the DOM, so nothing here needs `data-testid="security-posture"` or Chromium.
//
// UNLIKE the fidelity/runtime gates this one touches no database and starts no daemon: it boots
// `next dev` (`scripts/gate-m14-fidelity.mjs`'s free-port helper and spawn/wait block, verbatim,
// with `-H 127.0.0.1` added to the spawn args -- the boundary this gate proves is a loopback bind,
// not just a header check) against the SEEDED DEVELOPMENT DATABASE (`--env-file=.env`, same as
// every other gate) and writes nothing to it. Stage 5 below needs the seed workspace
// (`00000000-0000-4000-8000-000000000001`) to already exist for its one `200` assertion; run
// `npm run db:seed` first on a fresh clone.
//
// Dist imports only, one top-level `try` with no `catch`, `let exitCode = 1` set to `0` only by
// falling off the end of the try, and `process.exit(exitCode)` as the literal last line -- the
// same discipline `gate-m14-fidelity.mjs` uses.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web`: like `gate-m14-fidelity.mjs`,
// this gate boots `next dev` against the repo's own `apps/web/.next` (no temp dir, no throwaway
// build) on a freshly-chosen free port, and a second `next dev` sharing that same `.next` directory
// with one already running corrupts the on-disk build cache for both. Stop any running dev server
// first (`pgrep -af "next dev"`).
//
//   npm run gate:m15-boundary

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const PASS_LINE = 'the boundary holds — loopback-only, cross-site refused'

const W = '00000000-0000-4000-8000-000000000001' // SEED_WORKSPACE_ID; used only in URLs
const BOGUS = '11111111-1111-4111-8111-111111111111'

/** Asks the OS for a free TCP port. `next dev -p <port>` still auto-increments if something grabs
 *  it between this call and the spawn, so the ready-wait parses the ACTUAL bound port back out of
 *  next dev's own ready line rather than trusting this one blindly.
 *  (`scripts/gate-m14-fidelity.mjs`, verbatim.) */
async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : null
      server.close(() => (port !== null ? resolve(port) : reject(new Error('could not determine a free port'))))
    })
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** A GET with a literal foreign `Host` header, via `node:http` directly. `node:http` honors an
 *  explicit `Host` header override in `options.headers`, so this is the one way to put a foreign
 *  Host on the wire for the check below. */
function rawGetWithHost(targetUrl, hostHeader) {
  const parsed = new URL(targetUrl)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: { Host: hostHeader },
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

let exitCode = 1
let nextServer = null

try {
  // ---- The real web shell, on a free port, loopback-bound. -----------------------------------
  const preferredPort = await findFreePort()
  nextServer = spawn(
    'node',
    ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort), '-H', '127.0.0.1'],
    { cwd: repoRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let nextOutput = ''
  let nextExited = false
  let resolvedPort = null
  nextServer.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    nextOutput += text
    process.stdout.write(`[next] ${text}`)
    // `-H 127.0.0.1` changes next's own ready line from `http://localhost:<port>` (the line
    // `gate-m14-fidelity.mjs` parses, on the default host) to `http://127.0.0.1:<port>` --
    // confirmed empirically against this repo's next version before writing this gate. Matching
    // both keeps this resilient to either spelling.
    const match = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/.exec(nextOutput)
    if (match) resolvedPort = Number(match[1])
  })
  nextServer.stderr.on('data', (chunk) => process.stderr.write(`[next] ${chunk}`))
  nextServer.on('exit', () => {
    nextExited = true
  })
  nextServer.on('error', (error) => {
    nextExited = true
    console.error('[next] failed to start:', error)
  })
  {
    const deadline = Date.now() + NEXT_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (nextExited) throw new Error(`next dev exited before becoming ready -- output so far: ${nextOutput}`)
      if (resolvedPort !== null && /Ready in \d+/.test(nextOutput)) break
      await delay(50)
    }
    if (resolvedPort === null || !/Ready in \d+/.test(nextOutput)) {
      throw new Error(`next dev did not become ready within ${String(NEXT_READY_TIMEOUT_MS)}ms -- output so far: ${nextOutput}`)
    }
  }
  const baseUrl = `http://127.0.0.1:${String(resolvedPort)}`
  console.log(`next dev ready at ${baseUrl}, loopback-bound`)

  const url = (path) => `${baseUrl}${path}`

  // 1. Foreign Host -> 403 with the exact reason, on a page AND an API path. Node's `fetch`
  // silently drops an explicit `host` header in this Node version (verified against a throwaway
  // `http.createServer` before writing this gate) -- a foreign Host set through `fetch` reaches
  // the server as the true loopback Host, and a 403 from THAT would prove nothing about the
  // boundary. So: try `fetch` first, and only trust it if the 403 body actually NAMES
  // `evil.example` -- that's the header having reached the server, not just a coincidental 403 --
  // otherwise fall back to `rawGetWithHost`, which sets `Host` through `node:http` directly.
  for (const path of ['/', `/api/w/${W}/overview`]) {
    const viaFetch = await fetch(url(path), { headers: { host: 'evil.example' } })
    const fetchBody = await viaFetch.json().catch(() => null)
    const fetchCarriedHost =
      viaFetch.status === 403 && fetchBody !== null && typeof fetchBody.error === 'string' && fetchBody.error.includes('evil.example')
    const { status, body } = fetchCarriedHost
      ? { status: viaFetch.status, body: fetchBody }
      : await rawGetWithHost(url(path), 'evil.example').then((raw) => ({ status: raw.status, body: JSON.parse(raw.body) }))
    if (!fetchCarriedHost) {
      console.log(`  (fetch dropped the Host header for ${path} -- fell back to a raw node:http request)`)
    }
    assert(status === 403, `${path} with foreign Host: expected 403, got ${status}`)
    assert(
      body.error === 'foreign host evil.example — this instance is loopback-only',
      `${path}: unexpected body: ${JSON.stringify(body)}`,
    )
  }
  console.log('stage 1: foreign Host refused with the exact reason, on a page and an API path')

  // 2. Cross-site write -> 403, before the route can act. BOGUS id: if the middleware were absent
  // the route would answer for itself (404/409) -- 403 is the middleware's voice alone.
  {
    const res = await fetch(url(`/api/w/${BOGUS}/emergency-stop`), { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })
    assert(res.status === 403, `cross-site POST: expected 403, got ${res.status}`)
  }
  console.log('stage 2: cross-site write refused before the route could answer for itself')

  // 3. Cross-site read -> 403 before any SSE frame.
  {
    const res = await fetch(url(`/api/w/${W}/events`), { headers: { 'sec-fetch-site': 'cross-site' } })
    assert(res.status === 403, `cross-site SSE GET: expected 403, got ${res.status}`)
  }
  console.log('stage 3: cross-site SSE read refused before any frame')

  // 4. Cross-origin without fetch metadata -> 403.
  {
    const res = await fetch(url(`/api/w/${BOGUS}/emergency-stop`), { method: 'POST', headers: { origin: 'https://evil.example' } })
    assert(res.status === 403, `cross-origin POST: expected 403, got ${res.status}`)
  }
  console.log('stage 4: cross-origin request without fetch metadata refused via Origin')

  // 5. Same-origin and headerless traffic pass THROUGH to the routes.
  {
    const a = await fetch(url(`/api/w/${W}/overview`), { headers: { 'sec-fetch-site': 'same-origin' } })
    if (a.status !== 200) {
      throw new Error(`same-origin overview: expected 200, got ${a.status} -- body: ${await a.text().catch(() => '<unreadable>')}`)
    }
    const b = await fetch(url(`/api/w/${W}/overview`)) // curl-style
    if (b.status !== 200) {
      throw new Error(`headerless overview: expected 200, got ${b.status} -- body: ${await b.text().catch(() => '<unreadable>')}`)
    }
    const c = await fetch(url(`/api/w/${BOGUS}/emergency-stop`), { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
    assert(c.status !== 403, `same-origin control POST must reach the route; got 403`)
  }
  console.log('stage 5: same-origin and headerless traffic pass through to the routes untouched')

  // 6. Reseed consolidation: the route file no longer knows the header; the middleware still refuses.
  {
    const source = readFileSync('apps/web/src/app/api/dev/reseed/route.ts', 'utf8')
    assert(!source.includes('sec-fetch-site'), 'reseed route still carries a private sec-fetch-site check')
    const res = await fetch(url('/api/dev/reseed'), { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })
    assert(res.status === 403, `cross-site reseed: expected 403, got ${res.status}`)
  }
  console.log('stage 6: reseed consolidation held -- the route forgot the header, the middleware still refuses')

  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
}

process.exit(exitCode)
