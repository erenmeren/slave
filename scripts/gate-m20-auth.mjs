// The M20 gate (spec §5): the door has a lock. Zero spend, CI-runnable, plain `fetch` — the rules
// are header logic, as in M15. Two real `next dev` boots, STRICTLY sequential (they share
// apps/web/.next; gate-m15-boundary.mjs documents why two dev servers must never overlap). Both
// bind -H 127.0.0.1; "foreign Host" is forged in the header, so this gate never opens a
// non-loopback socket on the machine it runs on. Needs the seeded development database
// (`--env-file=.env`, same as every other gate) and writes NOTHING to it — every request below is
// a read, and stage 8's one POST is the cross-site write that must be refused before it lands.
//
// Run A proves the OLD door is unchanged: `scripts/gate-m15-boundary.mjs`, unmodified, as a child
// process with `AITEAMOS_PASSWORD` deleted from its environment. Run B proves the NEW one, on a
// password this gate invents per run and never writes anywhere.
//
// The free-port helper, the spawn/ready-wait block, the raw `node:http` request and the teardown
// are cribbed from `scripts/gate-m15-boundary.mjs` — COPIED, not imported: that gate is a script,
// not a module, and the spec requires it to keep passing untouched.
//
// `node:crypto` is used here to re-derive session cookies (stage 6). The Web-Crypto-only rule is a
// rule about `apps/web/src`, which this file is not; `apps/web/src/lib/session.ts` cannot be
// imported by an `.mjs` gate anyway, so the derivation is mirrored and stage 6 proves the mirror
// still matches by minting a FUTURE cookie that the server must accept.
//
// NEVER RUN THIS WHILE A DEV SERVER IS ALREADY SERVING `apps/web` — the preflight below refuses.
//
//   npm run gate:m20-auth
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const PASS_LINE = 'the door has a lock — loopback unchanged without a password, login required with one'
const M15_PASS = 'PASS: the boundary holds — loopback-only, cross-site refused'

const W = '00000000-0000-4000-8000-000000000001' // SEED_WORKSPACE_ID; used only in URLs
const FOREIGN_HOST = 'box.tail1234.ts.net:3000' // forged in the header only — no socket is opened to it

const NEXT_READY_TIMEOUT_MS = 180_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000
const PORT_FREE_TIMEOUT_MS = 10_000
// `apps/web/src/server/sse.ts` sends NO greeting frame: with no `?from` the stream starts "from
// now" (current max seq), so the replay is empty and the FIRST bytes on the wire are the id-only
// heartbeat at `DEFAULT_HEARTBEAT_MS` = 15 s. The budget must therefore clear 15 s with room to
// spare, or stage 5 would fail on the clock rather than on the boundary. Provoking an earlier
// frame would mean writing an event to the database, which this gate does not do.
const SSE_FIRST_FRAME_TIMEOUT_MS = 25_000

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Asks the OS for a free TCP port. `next dev -p <port>` still auto-increments if something grabs
 *  it between this call and the spawn, so the ready-wait parses the ACTUAL bound port back out of
 *  next dev's own ready line rather than trusting this one blindly.
 *  (`scripts/gate-m15-boundary.mjs`, verbatim.) */
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

/** M15's `rawGetWithHost`, generalised: method, headers and body pass through. `node:http` honours
 *  an explicit `Host` header (Node's `fetch` silently drops one), which is the only way to put a
 *  foreign Host on the wire for stages 9's checks. */
function rawRequest(targetUrl, { method = 'GET', headers = {}, body = null } = {}) {
  const parsed = new URL(targetUrl)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: parsed.hostname, port: parsed.port, path: `${parsed.pathname}${parsed.search}`, method, headers },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
      },
    )
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

// ---- process/port hygiene ----------------------------------------------------------------------
// `pgrep -af "next dev"` SELF-MATCHES: this gate is launched through `npm run`, whose wrapper shell
// carries the whole command line — including the literal substring "next dev" once this file is
// named in it — inside ONE argv entry. `gate-m17-stability.mjs` hit the same trap with `cli.js
// daemon` and fixed it the way it is fixed here: `pgrep -f` is only a cheap CANDIDATE list, and a
// candidate counts only once its REAL argv (`/proc/<pid>/cmdline`, null-byte separated) shows two
// ADJACENT, EXACT entries — a path ending in `next` immediately followed by the literal `dev`. A
// wrapper shell's `sh -c '<one long string>'` can never satisfy that. A gate that refuses to run on
// its own shadow is worse than no gate.
function argvOf(pid) {
  let cmdline
  try {
    cmdline = readFileSync(`/proc/${pid}/cmdline`, 'latin1')
  } catch {
    return null // already gone, or /proc unreadable (non-Linux) — not a match either way
  }
  return cmdline.split('\0').filter((part) => part !== '')
}

function isRealNextDevProcess(pid) {
  const argv = argvOf(pid)
  if (argv === null) return false
  for (let i = 0; i < argv.length - 1; i += 1) {
    const entry = argv[i]
    if ((entry === 'next' || entry.endsWith('/next')) && argv[i + 1] === 'dev') return true
  }
  return false
}

/** The worker `next dev` forks renames itself `next-server (vX.Y.Z)` — a SINGLE argv entry, so a
 *  wrapper shell (argv[0] is always its own binary path) can never impersonate one. A leftover
 *  worker still holds the shared `.next` and the old port, which is exactly what ruling 4 of this
 *  task exists for, so the preflight looks for these too. */
function isRealNextServerProcess(pid) {
  const argv = argvOf(pid)
  return argv !== null && argv.length > 0 && argv[0].startsWith('next-server')
}

function confirmedPids(pattern, predicate) {
  const found = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
  return (found.stdout ?? '')
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
    .filter((pid) => predicate(pid))
}

function describe(pid) {
  return `${String(pid)} ${(argvOf(pid) ?? ['<gone>']).join(' ')}`
}

async function portIsFree(port) {
  return await new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

/** Killing `next dev` by its PID can leave the forked `next-server` worker holding the port (seen
 *  in this milestone's Task 4). Leaving it bound poisons the NEXT run — of this gate, of M15's, of
 *  anything sharing `apps/web/.next` — so the port is waited out and then taken by force. */
async function ensurePortFree(port, label) {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await portIsFree(port)) return true
    await delay(200)
  }
  console.log(`cleanup: port ${String(port)} (${label}) is still bound after teardown -- killing whatever holds it`)
  spawnSync('fuser', ['-n', 'tcp', String(port), '-k'], { stdio: 'ignore' })
  await delay(500)
  const free = await portIsFree(port)
  if (!free) console.error(`cleanup: port ${String(port)} (${label}) is STILL bound after fuser -k`)
  return free
}

let exitCode = 1
let nextServer = null
let boundPort = null

try {
  // ---- preflight: no next dev may already be running (shared .next) ---------------------------
  {
    const dev = confirmedPids('next dev', isRealNextDevProcess)
    const worker = confirmedPids('next-server', isRealNextServerProcess)
    const running = [...dev, ...worker]
    assert(running.length === 0, `a next dev is already running -- stop it first:\n${running.map(describe).join('\n')}`)
    console.log('preflight: no next dev and no next-server worker is holding apps/web/.next')
  }

  // ---- run A: loopback mode did not move — the M15 gate, verbatim, with the password removed ---
  {
    const env = { ...process.env }
    delete env.AITEAMOS_PASSWORD
    const out = execFileSync('node', ['scripts/gate-m15-boundary.mjs'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 32 * 1024 * 1024,
    })
    process.stdout.write(`${out.split('\n').map((line) => `[m15] ${line}`).join('\n')}\n`)
    assert(out.includes(M15_PASS), 'run A: gate-m15-boundary did not PASS with the password removed')
    // The child is gone by now (execFileSync returned), but its forked worker may outlive it and
    // keep the port — and the two runs share `apps/web/.next`, so run B must start on a quiet
    // machine. The port comes out of the child's own ready line.
    const m15Port = /next dev ready at http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1]
    if (m15Port !== undefined) await ensurePortFree(Number(m15Port), "run A's dev server")
    console.log('run A: loopback mode unchanged -- the M15 gate passed, same script, no password')
  }

  // ---- run B: password mode -------------------------------------------------------------------
  // Invented per run, passed to the child through its environment only: it never reaches `.env`,
  // the shell history or the repository.
  const PASSWORD = randomBytes(18).toString('base64url') // 24 chars

  const preferredPort = await findFreePort()
  nextServer = spawn(
    'node',
    ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort), '-H', '127.0.0.1'],
    { cwd: repoRoot, env: { ...process.env, AITEAMOS_PASSWORD: PASSWORD }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let nextOutput = ''
  let nextExited = false
  let resolvedPort = null
  nextServer.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    nextOutput += text
    process.stdout.write(`[next] ${text}`)
    // `-H 127.0.0.1` makes next's ready line `http://127.0.0.1:<port>`; older spellings say
    // `localhost`. Matching both keeps this resilient to either. (M15's block, verbatim.)
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
  boundPort = resolvedPort
  const baseUrl = `http://127.0.0.1:${String(resolvedPort)}`
  console.log(`next dev ready at ${baseUrl}, loopback-bound, password mode`)

  const url = (path) => `${baseUrl}${path}`
  const cookieFrom = (setCookie) => setCookie.split(';')[0] // "aiteamos_session=<value>"

  /** The Location of an unauthenticated page request. Asserted by PARTS, never as one string: the
   *  middleware builds an ABSOLUTE Location on the host the request asked for (a relative one
   *  500s in Next's middleware adapter — measured in this milestone's Task 4), so the host varies
   *  with the request and only the pathname and `next` are fixed. */
  function assertLoginRedirect(location, expectedNext, expectedHost, what) {
    assert(location !== '' && location !== null && location !== undefined, `${what}: no Location header`)
    let parsed
    try {
      parsed = new URL(location)
    } catch {
      throw new Error(`${what}: Location is not absolute/parsable: ${location}`)
    }
    assert(parsed.pathname === '/login', `${what}: expected the /login pathname, got ${parsed.pathname} (${location})`)
    assert(
      parsed.searchParams.get('next') === expectedNext,
      `${what}: expected next=${expectedNext}, got ${String(parsed.searchParams.get('next'))} (${location})`,
    )
    if (expectedHost !== null) {
      assert(parsed.host === expectedHost, `${what}: expected the Location on host ${expectedHost}, got ${parsed.host} (${location})`)
    }
  }

  // 1. Page without a cookie -> 302 to /login; the login page renders; its chunks are public.
  {
    const res = await fetch(url('/'), { redirect: 'manual' })
    assert(res.status === 302, `GET / without cookie: expected 302, got ${res.status}`)
    assertLoginRedirect(res.headers.get('location'), '/', null, 'GET / without cookie')
    const login = await fetch(url('/login'))
    assert(login.status === 200, `GET /login: expected 200, got ${login.status}`)
    const html = await login.text()
    assert(html.includes('data-testid="login-password"'), 'login page lacks the password field')
    const chunk = /\/_next\/static\/[^"'\\\s]+\.js(?:\?[^"'\\\s]*)?/.exec(html)?.[0]
    assert(chunk !== undefined, 'login page references no /_next/static chunk')
    const chunkRes = await fetch(url(chunk))
    assert(chunkRes.status === 200, `${chunk}: expected 200, got ${chunkRes.status}`)
  }
  console.log('stage 1: an unauthenticated page goes to /login, and /login can actually render')

  // 2. Headerless API -> 401 (the M15 escape hatch is closed).
  {
    const res = await fetch(url(`/api/w/${W}/overview`))
    assert(res.status === 401, `headerless overview: expected 401, got ${res.status}`)
    assert((await res.json()).error === 'authentication required', 'unexpected 401 body')
  }
  console.log('stage 2: the headerless escape hatch is closed')

  // 3. Wrong password -> slow 401, no cookie. MEASURED ON A WARM ROUTE, and that is the whole
  // point of the throwaway request below: `next dev` compiles a route on its first request, and
  // this stage is the first traffic `/api/auth/login` sees. A cold measurement is dominated by the
  // compiler rather than by the product -- observed `✓ Compiled /api/auth/login in 305ms` with a
  // `POST /api/auth/login 401 in 657ms` on one run and 149ms/508ms on another -- so a cold
  // `>= 250` bound would still have passed with `FAILED_LOGIN_DELAY_MS` deleted, and its verdict
  // would swing with the machine. The first POST is asserted only for its 401 (the answer must not
  // depend on being warm); the SECOND one, on a route that is already compiled, is the one whose
  // elapsed time can only be the deliberate delay.
  {
    const warmup = await fetch(url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: `${PASSWORD}x` }),
    })
    assert(warmup.status === 401, `wrong password (warm-up): expected 401, got ${warmup.status}`)
    const started = Date.now()
    const res = await fetch(url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: `${PASSWORD}x` }),
    })
    const elapsed = Date.now() - started
    assert(res.status === 401, `wrong password: expected 401, got ${res.status}`)
    assert((await res.json()).error === 'wrong password', 'wrong password: unexpected body')
    assert(res.headers.get('set-cookie') === null, 'wrong password must not set a cookie')
    assert(elapsed >= 250, `wrong password answered in ${String(elapsed)}ms on a warm route -- expected >= 250`)
    console.log(`  (the warm wrong-password POST took ${String(elapsed)}ms)`)
  }
  console.log('stage 3: on a warm route the wrong password costs 300 ms and earns no cookie')

  // 4. Right password -> 204 + cookie with the spec attributes.
  let cookie
  {
    const res = await fetch(url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    assert(res.status === 204, `login: expected 204, got ${res.status}`)
    const setCookie = res.headers.get('set-cookie') ?? ''
    assert(
      /^aiteamos_session=\d+\.[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/.test(setCookie),
      `unexpected Set-Cookie: ${setCookie}`,
    )
    cookie = cookieFrom(setCookie)
  }
  console.log('stage 4: the right password mints the cookie the spec describes, no Secure over http')

  // 5. With the cookie: page 200, API 200, a real SSE frame.
  {
    const page = await fetch(url('/'), { headers: { cookie } })
    assert(page.status === 200, `GET / with cookie: expected 200, got ${page.status}`)
    const api = await fetch(url(`/api/w/${W}/overview`), { headers: { cookie } })
    assert(api.status === 200, `overview with cookie: expected 200, got ${api.status}`)
    const sse = await fetch(url(`/api/w/${W}/events`), { headers: { cookie, accept: 'text/event-stream' } })
    assert(sse.status === 200 && sse.body !== null, `events with cookie: expected 200 stream, got ${sse.status}`)
    assert(
      (sse.headers.get('content-type') ?? '').includes('text/event-stream'),
      `events with cookie: expected an event-stream content-type, got ${String(sse.headers.get('content-type'))}`,
    )
    const reader = sse.body.getReader()
    const first = await Promise.race([reader.read(), delay(SSE_FIRST_FRAME_TIMEOUT_MS).then(() => ({ value: undefined, done: true }))])
    assert(
      first.value !== undefined && first.value.length > 0,
      `no SSE frame arrived within ${String(SSE_FIRST_FRAME_TIMEOUT_MS)}ms`,
    )
    await reader.cancel()
  }
  console.log('stage 5: the cookie opens the page, the API and the event stream')

  // 6. Tampered and expired cookies are refused.
  {
    const [name, value] = cookie.split('=')
    const flipped = value.slice(0, -1) + (value.endsWith('0') ? '1' : '0')
    const api = await fetch(url(`/api/w/${W}/overview`), { headers: { cookie: `${name}=${flipped}` } })
    assert(api.status === 401, `tampered cookie on API: expected 401, got ${api.status}`)
    const page = await fetch(url('/'), { headers: { cookie: `${name}=${flipped}` }, redirect: 'manual' })
    assert(page.status === 302, `tampered cookie on page: expected 302, got ${page.status}`)
    assertLoginRedirect(page.headers.get('location'), '/', null, 'tampered cookie on a page')
    // The same derivation `session.ts` uses: HMAC-SHA-256 over the decimal expiry, keyed by
    // SHA-256("aiteamos-session:v1:" + password).
    const key = createHash('sha256').update(`aiteamos-session:v1:${PASSWORD}`).digest()
    const expiresAt = Math.floor(Date.now() / 1000) - 60
    const sig = createHmac('sha256', key).update(String(expiresAt)).digest('hex')
    const expired = await fetch(url(`/api/w/${W}/overview`), { headers: { cookie: `${name}=${expiresAt}.${sig}` } })
    assert(expired.status === 401, `expired cookie: expected 401, got ${expired.status}`)
    // Sanity: the same derivation with a FUTURE expiry must pass, or the expired check proves nothing.
    const future = Math.floor(Date.now() / 1000) + 60
    const futureSig = createHmac('sha256', key).update(String(future)).digest('hex')
    const fresh = await fetch(url(`/api/w/${W}/overview`), { headers: { cookie: `${name}=${future}.${futureSig}` } })
    assert(
      fresh.status === 200,
      `gate-minted fresh cookie: expected 200, got ${fresh.status} -- the gate's derivation drifted from session.ts`,
    )
  }
  console.log('stage 6: a tampered signature and a past expiry are both refused; the derivation matches')

  // 7. Bearer opens the API only.
  {
    const ok = await fetch(url(`/api/w/${W}/overview`), { headers: { authorization: `Bearer ${PASSWORD}` } })
    assert(ok.status === 200, `bearer overview: expected 200, got ${ok.status}`)
    const wrong = await fetch(url(`/api/w/${W}/overview`), { headers: { authorization: `Bearer ${PASSWORD}x` } })
    assert(wrong.status === 401, `wrong bearer: expected 401, got ${wrong.status}`)
    const page = await fetch(url('/'), { headers: { authorization: `Bearer ${PASSWORD}` }, redirect: 'manual' })
    assert(page.status === 302, `bearer on a page: expected 302, got ${page.status}`)
    assertLoginRedirect(page.headers.get('location'), '/', null, 'bearer on a page')
  }
  console.log('stage 7: a bearer opens the API and nothing else')

  // 8. Cross-site with a valid cookie is still refused; the workspace is not halted. The field path
  // is `overview.workspace.haltedAt` — confirmed against `apps/web/src/server/overview.ts`
  // (`OverviewSnapshot.workspace.haltedAt`, written as `workspace.haltedAt?.toISOString() ?? null`).
  {
    const res = await fetch(url(`/api/w/${W}/emergency-stop`), {
      method: 'POST',
      headers: { cookie, 'sec-fetch-site': 'cross-site' },
    })
    assert(res.status === 403, `cross-site stop with cookie: expected 403, got ${res.status}`)
    const overview = await (await fetch(url(`/api/w/${W}/overview`), { headers: { cookie } })).json()
    assert(overview.workspace.haltedAt === null, 'the seed workspace was halted by a cross-site POST')
  }
  console.log('stage 8: a cookie does not launder a cross-site write')

  // 9. A foreign Host is welcome now; a same-host Origin passes; a foreign Origin does not. And the
  // regression the middleware's absolute Location exists for: an unauthenticated page request that
  // arrived on a tailnet hostname is sent back to THAT hostname, not to the server's own localhost.
  {
    const a = await rawRequest(url(`/api/w/${W}/overview`), { headers: { Host: FOREIGN_HOST, Cookie: cookie } })
    assert(a.status === 200, `foreign Host with cookie: expected 200, got ${a.status} -- ${a.body}`)
    const b = await rawRequest(url(`/api/w/${W}/overview`), {
      headers: { Host: FOREIGN_HOST, Cookie: cookie, Origin: `http://${FOREIGN_HOST}` },
    })
    assert(b.status === 200, `same-host Origin: expected 200, got ${b.status}`)
    const c = await rawRequest(url(`/api/w/${W}/overview`), {
      headers: { Host: FOREIGN_HOST, Cookie: cookie, Origin: 'http://evil.example' },
    })
    assert(
      c.status === 403 && JSON.parse(c.body).error === 'cross-origin request refused (origin: http://evil.example)',
      `foreign Origin: expected 403, got ${c.status} ${c.body}`,
    )
    const d = await rawRequest(url(`/w/${W}`), { headers: { Host: FOREIGN_HOST } })
    assert(d.status === 302, `tailnet page without a cookie: expected 302, got ${d.status} -- ${d.body}`)
    assertLoginRedirect(d.headers.location, `/w/${W}`, FOREIGN_HOST, 'tailnet page without a cookie')
  }
  console.log('stage 9: the Host allowlist is lifted; Origin is judged against the Host it came with, and /login is on that Host too')

  // 10. Logout clears the cookie; the cleared cookie is nobody.
  {
    const res = await fetch(url('/api/auth/logout'), { method: 'POST', headers: { cookie } })
    assert(res.status === 204, `logout: expected 204, got ${res.status}`)
    const cleared = res.headers.get('set-cookie') ?? ''
    assert(/^aiteamos_session=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/.test(cleared), `unexpected clearing cookie: ${cleared}`)
    const after = await fetch(url('/'), { headers: { cookie: 'aiteamos_session=' }, redirect: 'manual' })
    assert(after.status === 302, `after logout: expected 302, got ${after.status}`)
    assertLoginRedirect(after.headers.get('location'), '/', null, 'after logout')
  }
  console.log('stage 10: logout clears the cookie and the door closes again')

  // 11. Settings names the mode and offers the way out.
  {
    const login = await fetch(url('/api/auth/login'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    })
    assert(login.status === 204, `stage 11 login: expected 204, got ${login.status}`)
    const fresh = cookieFrom(login.headers.get('set-cookie') ?? '')
    const res = await fetch(url('/settings'), { headers: { cookie: fresh } })
    assert(res.status === 200, `settings: expected 200, got ${res.status}`)
    const html = await res.text()
    assert(
      html.includes('password login · single operator · cross-site requests refused'),
      'settings does not name the password posture',
    )
    assert(html.includes('data-testid="logout"'), 'settings has no Logout button')
  }
  console.log('stage 11: Settings tells the truth about the mode and carries Logout')

  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  // Killing the dev server's PID is not the same as freeing its port: the forked `next-server`
  // worker can outlive it, and a still-bound port breaks the NEXT run's preflight and free-port
  // choice. Leave the machine as this gate found it.
  if (boundPort !== null) await ensurePortFree(boundPort, "run B's dev server")
}

process.exit(exitCode)
