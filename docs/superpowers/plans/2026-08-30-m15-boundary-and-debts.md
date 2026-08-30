# M15 Boundary and Debts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the browser boundary around the unauthenticated web API (loopback-only posture), pay down five M13 debts, and map Cursor's token usage.

**Architecture:** One pure decision module (`boundary.ts`) consulted by a new Next middleware; a zero-spend gate proving the middleware is mounted; surgical fixes in `packages/control`, `apps/orchestrator`, `packages/providers`, `packages/db`, and two web components.

**Tech Stack:** Next 15 middleware (edge runtime), zod, Prisma `$queryRaw`, vitest, plain `fetch` in the gate.

**Spec:** `docs/superpowers/specs/2026-08-30-m15-boundary-and-debts-design.md` — the plan argues from it; read it first. B2 and B5 carry pre-plan amendments (inline notes in §3).

## Global Constraints

- Boundary allowlist hosts, verbatim: `localhost`, `127.0.0.1`, `[::1]`.
- 403 body shape everywhere: `{ error: <reason string from boundaryVerdict> }`.
- `POSTURE = 'loopback-only'` is the single source for the Settings card text.
- Billed-input rule (both providers): input = every billed input counter summed; output = the output counter alone.
- Comments change in the same commit as the behaviour they describe.
- No new dependencies.
- Operational: one vitest run at a time; the orchestrator daemon must NOT be running during tests (its `LISTEN events` breaks `subscribe.test.ts`); never run `npm run web:build` while a `next dev` serves `apps/web`; every `apps/web` task gates on `npm run web:build`.
- The seed workspace stays daemon-inert: no task in `packages/db/src/seed.ts` may gain a `requiredRole` (spec §3 B5 amendment — roles there would point paid runs at demo data).

---

### Task 1: `boundary.ts` — the decision table

**Files:**
- Create: `apps/web/src/lib/boundary.ts`
- Test: `apps/web/test/boundary.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no imports).
- Produces: `POSTURE: 'loopback-only'`; `interface BoundaryRequest { host: string | null; secFetchSite: string | null; origin: string | null; path: string }`; `type BoundaryVerdict = { allow: true } | { allow: false; reason: string }`; `function boundaryVerdict(request: BoundaryRequest): BoundaryVerdict`. Tasks 2, 3 and 5 import exactly these names.

- [ ] **Step 1: Write the failing test** — `apps/web/test/boundary.test.ts`, a decision table (spec §2.1). Use the repo's vitest idiom (see `apps/web/test/taskColumns.test.ts` for a pure-module test's shape):

```ts
import { describe, expect, it } from 'vitest'
import { POSTURE, boundaryVerdict } from '../src/lib/boundary.js'

const base = { host: 'localhost:3000', secFetchSite: null, origin: null, path: '/api/w/x/overview' }

describe('boundaryVerdict', () => {
  it('names the posture', () => {
    expect(POSTURE).toBe('loopback-only')
  })

  it.each([
    ['localhost:3000', true], ['localhost', true], ['127.0.0.1:3000', true],
    ['127.0.0.1', true], ['[::1]:3000', true], ['[::1]', true],
    ['evil.example', false], ['evil.example:3000', false],
    ['localhost.evil.example', false], ['127.0.0.1.evil.example', false],
  ])('host %s → allow=%s (rule 1, every path)', (host, allow) => {
    expect(boundaryVerdict({ ...base, host, path: '/' }).allow).toBe(allow)
    expect(boundaryVerdict({ ...base, host }).allow).toBe(allow)
  })

  it('refuses a missing Host header with the literal <none>', () => {
    const verdict = boundaryVerdict({ ...base, host: null })
    expect(verdict).toEqual({ allow: false, reason: 'foreign host <none> — this instance is loopback-only' })
  })

  it('reports the parsed host, without the port, in the refusal reason', () => {
    const verdict = boundaryVerdict({ ...base, host: 'evil.example:8080' })
    expect(verdict).toEqual({ allow: false, reason: 'foreign host evil.example — this instance is loopback-only' })
  })

  it.each([['same-origin'], ['none']])('allows sec-fetch-site %s on /api/', (site) => {
    expect(boundaryVerdict({ ...base, secFetchSite: site }).allow).toBe(true)
  })

  it.each([['cross-site'], ['same-site'], ['cross-origin']])('refuses sec-fetch-site %s on /api/', (site) => {
    expect(boundaryVerdict({ ...base, secFetchSite: site })).toEqual({
      allow: false,
      reason: `cross-site request refused (sec-fetch-site: ${site})`,
    })
  })

  it('lets a cross-site page request through (rule 2 is /api/ only)', () => {
    expect(boundaryVerdict({ ...base, secFetchSite: 'cross-site', path: '/w/abc/tasks' }).allow).toBe(true)
  })

  it('falls back to Origin when fetch metadata is absent: loopback origins pass', () => {
    expect(boundaryVerdict({ ...base, origin: 'http://localhost:3000' }).allow).toBe(true)
    expect(boundaryVerdict({ ...base, origin: 'http://127.0.0.1:3000' }).allow).toBe(true)
  })

  it('refuses a foreign Origin, quoting it verbatim', () => {
    expect(boundaryVerdict({ ...base, origin: 'https://evil.example' })).toEqual({
      allow: false,
      reason: 'cross-origin request refused (origin: https://evil.example)',
    })
  })

  it('refuses the literal "null" Origin (sandboxed frames)', () => {
    expect(boundaryVerdict({ ...base, origin: 'null' }).allow).toBe(false)
  })

  it('allows headerless clients (curl) on /api/', () => {
    expect(boundaryVerdict(base).allow).toBe(true)
  })

  it('prefers Sec-Fetch-Site over Origin when both are present', () => {
    // A same-origin fetch still carries Origin on POSTs; metadata wins.
    expect(boundaryVerdict({ ...base, secFetchSite: 'cross-site', origin: 'http://localhost:3000' }).allow).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run apps/web/test/boundary.test.ts`. Expected: FAIL — cannot resolve `../src/lib/boundary.js`.

- [ ] **Step 3: Implement** `apps/web/src/lib/boundary.ts`:

```ts
/**
 * The browser boundary's decision table (M15 spec §2.1). Pure on purpose: no I/O, no Next
 * imports, no env reads — the middleware, the Settings card and the gate all consult this one
 * module, and its unit tests are the rules' specification.
 */
export const POSTURE = 'loopback-only' as const

export interface BoundaryRequest {
  readonly host: string | null
  readonly secFetchSite: string | null
  readonly origin: string | null
  readonly path: string
}

export type BoundaryVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: string }

const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The host part of a Host-header value: one trailing `:<port>` stripped, brackets kept. A
 *  bracketless IPv6 (invalid in a Host header) mangles here and then fails the allowlist —
 *  refusal is the right answer for malformed input, so no special case. */
function hostOf(value: string): string {
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? value : value.slice(0, end + 1)
  }
  const colon = value.lastIndexOf(':')
  return colon === -1 ? value : value.slice(0, colon)
}

export function boundaryVerdict(request: BoundaryRequest): BoundaryVerdict {
  // Rule 1 — every path, every method: both loopback spellings and the IPv6 loopback are the
  // only hosts this instance answers as. Anything else is a DNS-rebinding probe or a mistake.
  const host = request.host === null ? null : hostOf(request.host)
  if (host === null || !ALLOWED_HOSTS.has(host)) {
    return { allow: false, reason: `foreign host ${host ?? '<none>'} — this instance is loopback-only` }
  }

  // Rule 2 — /api/ only, ALL methods including GET: the SSE and JSON GETs leak workspace data,
  // so a cross-site read is refused as firmly as a cross-site write.
  if (!request.path.startsWith('/api/')) return { allow: true }

  if (request.secFetchSite !== null) {
    // The browser set fetch metadata; believe it. `same-origin` is this app's own UI, `none` is
    // the address bar or a non-browser client that chose to send it.
    if (request.secFetchSite === 'same-origin' || request.secFetchSite === 'none') return { allow: true }
    return { allow: false, reason: `cross-site request refused (sec-fetch-site: ${request.secFetchSite})` }
  }

  if (request.origin !== null) {
    // Older browsers without fetch metadata still send Origin on cross-origin requests. The
    // origin's own host must pass the same allowlist — comparing against the allowlist rather
    // than against the request's Host keeps `localhost` ↔ `127.0.0.1` (same machine, different
    // spelling) allowed. An unparsable Origin (including the literal `null`) is refused.
    let originHost: string | null = null
    try {
      originHost = hostOf(new URL(request.origin).host)
    } catch {
      originHost = null
    }
    if (originHost === null || !ALLOWED_HOSTS.has(originHost)) {
      return { allow: false, reason: `cross-origin request refused (origin: ${request.origin})` }
    }
  }

  // Neither header: curl, scripts, the gate — a local process without browser headers is the
  // operator. The boundary defends against browsers.
  return { allow: true }
}
```

- [ ] **Step 4: Run the test to verify it passes.** Run: `npx vitest run apps/web/test/boundary.test.ts`. Expected: PASS, all rows.

- [ ] **Step 5: Gate on the bundler and commit.**

```bash
npm run web:build
git add apps/web/src/lib/boundary.ts apps/web/test/boundary.test.ts
git commit -m "feat(web): the boundary's decision table — loopback hosts only, cross-site /api refused"
```

---

### Task 2: The middleware, and the reseed route stops freelancing

**Files:**
- Create: `apps/web/src/middleware.ts`
- Modify: `apps/web/src/app/api/dev/reseed/route.ts` (remove its private `sec-fetch-site` check)
- Test: the reseed route's existing test file (find it: `grep -rln "reseed" apps/web/test/`) — re-point; `apps/web/test/boundary.test.ts` already owns the header rules.

**Interfaces:**
- Consumes: `boundaryVerdict`, `BoundaryRequest` from `../src/lib/boundary` (Task 1).
- Produces: a mounted middleware — every request now passes through `boundaryVerdict`. Task 5's gate proves the mounting.

- [ ] **Step 1: Write the middleware** — `apps/web/src/middleware.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { boundaryVerdict } from './lib/boundary'

/**
 * The browser boundary (M15 spec §2.2). Every decision lives in `lib/boundary.ts`; this file
 * only extracts headers and speaks HTTP. A refused page request gets the same JSON 403 a
 * refused API request does — a foreign-host page fetch is a rebinding probe, not a person to
 * render an error page for.
 */
export function middleware(request: NextRequest): NextResponse {
  const verdict = boundaryVerdict({
    host: request.headers.get('host'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    origin: request.headers.get('origin'),
    path: request.nextUrl.pathname,
  })
  if (!verdict.allow) return NextResponse.json({ error: verdict.reason }, { status: 403 })
  return NextResponse.next()
}
```

No `config.matcher` — the default (everything except Next's own static assets) is exactly the coverage the spec asks for.

- [ ] **Step 2: Simplify the reseed route.** In `apps/web/src/app/api/dev/reseed/route.ts`: delete the `ALLOWED_FETCH_SITES` constant, the `sec-fetch-site` read and its `if` block, and the doc-comment paragraph that begins "Also refused cross-origin (M14 fix wave, review I8)" — replace that paragraph with:

```
 * Cross-origin refusal moved to the app-wide boundary middleware in M15 (spec §2.3): the
 * middleware 403s any cross-site /api request before this handler runs, so a second, private
 * copy of the rule here would only be a place for the two to disagree. The NODE_ENV guard
 * stays — dev-only existence is a different rule from the browser boundary.
```

The `NODE_ENV === 'production'` 404 guard stays untouched.

- [ ] **Step 3: Re-point the reseed tests.** In the reseed test file: delete/replace the cases that POST with a forged `sec-fetch-site` expecting 404 (that rule now lives in `boundary.test.ts`); keep/verify the `NODE_ENV=production → 404` case and the happy-path case. If a deleted case was the file's only coverage of refusal, note in the test file that refusal is owned by `apps/web/test/boundary.test.ts` + the M15 gate.

- [ ] **Step 4: Run the affected tests.** Run: `npx vitest run apps/web/test/boundary.test.ts <reseed test file>`. Expected: PASS.

- [ ] **Step 5: Gate on the bundler** (middleware must compile in a real build): `npm run web:build`. Expected: success.

- [ ] **Step 6: Commit.**

```bash
git add apps/web/src/middleware.ts apps/web/src/app/api/dev/reseed/route.ts <reseed test file>
git commit -m "feat(web): the boundary middleware — one rule source, and reseed stops freelancing"
```

---

### Task 3: The Settings "security" card

**Files:**
- Modify: `apps/web/src/components/SettingsClient.tsx` (add a `Panel`)
- Test: `apps/web/test/settings-page.test.tsx`

**Interfaces:**
- Consumes: `POSTURE` from `../lib/boundary` (Task 1); the existing `Panel` component `SettingsClient` already uses.
- Produces: `data-testid="security-posture"` — Task 5's gate reads it.

- [ ] **Step 1: Write the failing test.** In `apps/web/test/settings-page.test.tsx`, inside the existing `describe('SettingsClient')` (reuse the props the "renders both panels" test builds):

```ts
it('states the security posture, honestly and without controls', () => {
  render(<SettingsClient {...baseProps} />)
  const posture = screen.getByTestId('security-posture')
  expect(posture.textContent).toBe('loopback-only · no accounts · cross-site requests refused')
})
```

(`baseProps` = whatever fixture the neighbouring SettingsClient test constructs; follow its shape exactly.)

- [ ] **Step 2: Run it to verify it fails.** Run: `npx vitest run apps/web/test/settings-page.test.tsx`. Expected: FAIL — no `security-posture` test id.

- [ ] **Step 3: Implement.** In `SettingsClient.tsx`, after the `agent permissions` panel and before `<DangerZone …>`:

```tsx
<Panel title="security">
  <p data-testid="security-posture" className={/* copy the muted footnote idiom the file/section already uses — e.g. the PermissionMatrix "not yet enforced at runtime" note's classes */}>
    {POSTURE} · no accounts · cross-site requests refused
  </p>
</Panel>
```

Import `POSTURE` from `../lib/boundary`. Copy the exact className from the nearest muted-note element (grep `not yet enforced at runtime` in `apps/web/src/components/PermissionMatrix.tsx`) so the card matches the page's chrome — do not invent new styles.

- [ ] **Step 4: Run the test to verify it passes.** Run: `npx vitest run apps/web/test/settings-page.test.tsx`. Expected: PASS.

- [ ] **Step 5: Gate and commit.**

```bash
npm run web:build
git add apps/web/src/components/SettingsClient.tsx apps/web/test/settings-page.test.tsx
git commit -m "feat(web): Settings names the security posture — loopback-only, said out loud"
```

---

### Task 4: B1 — `requestPause` claims and reads in one statement

**Files:**
- Modify: `packages/control/src/pause.ts` (the `priorStatus` capture and the `claimed` updateMany, ~lines 40–58)
- Test: `packages/control/test/integration/pause.test.ts`

**Interfaces:**
- Consumes: existing `PAUSABLE_STATUSES` (`['starting', 'working', 'resuming']`), `prisma`.
- Produces: no signature change — `requestPause(runId, requestedBy, category?)` behaves identically from outside; only the internal claim is atomic.

- [ ] **Step 1: Write the failing/duel test.** In `pause.test.ts` (integration; DB truncated per test — copy the file's existing `seed()` fixture):

```ts
it('two concurrent requests: exactly one claims, the loser is told pause_requested', async () => {
  const { run } = fixture
  const [a, b] = await Promise.all([requestPause(run.id, 'meren'), requestPause(run.id, 'meren')])
  const outcomes = [a, b]
  expect(outcomes.filter((r) => r.ok)).toHaveLength(1)
  const refused = outcomes.find((r) => !r.ok)
  expect(refused && !refused.ok && refused.error.kind).toBe('wrong_status')
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
  expect(after.status).toBe('pause_requested')
})

it('a rollback restores the status the claim actually interrupted', async () => {
  // Make signalPause fail: point the workspace repoPath somewhere unwritable so the flag write throws.
  const { run } = fixture
  await prisma.workspace.update({ where: { id: fixture.workspace.id }, data: { repoPath: '/proc/no-such-dir' } })
  await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'resuming' } })
  const result = await requestPause(run.id, 'meren')
  expect(result.ok).toBe(false)
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
  expect(after.status).toBe('resuming') // the claim's own reading, not a stale earlier read
})
```

(If an equivalent rollback test already exists, extend it to start from `resuming` — the point is that the restored value is the claim-time status.)

- [ ] **Step 2: Run to verify state.** Run: `npx vitest run packages/control/test/integration/pause.test.ts`. Expected: the duel test may already pass (updateMany is atomic for the claim itself) — that is fine; it pins the contract. The file must be green before the change.

- [ ] **Step 3: Implement the atomic claim.** In `pause.ts`, replace the `const priorStatus = run.status` line and the `claimed = await prisma.agentRun.updateMany(…)` block with:

```ts
// Claim and read in ONE statement (M15 spec §3 B1): `priorStatus` must be the status this claim
// actually interrupted, not the status an earlier SELECT happened to see. `FOR UPDATE` orders a
// concurrent claimant behind this one; the RETURNING carries the pre-claim value out.
const claimedRows = await prisma.$queryRaw<{ priorStatus: (typeof PAUSABLE_STATUSES)[number] }[]>`
  UPDATE "AgentRun" AS r
  SET status = 'pause_requested', "pauseReason" = ${category}
  FROM (SELECT id, status FROM "AgentRun" WHERE id = ${run.id} FOR UPDATE) AS prev
  WHERE r.id = prev.id AND prev.status = ANY(${[...PAUSABLE_STATUSES]})
  RETURNING prev.status AS "priorStatus"`
const priorStatus = claimedRows[0]?.priorStatus
if (priorStatus === undefined) {
  return err({ kind: 'wrong_status', runId: run.id, status: run.status, needed: PAUSABLE_STATUSES })
}
```

Keep the surrounding comments' substance (rewrite them to describe the new shape — same commit as the behaviour). The later rollback block keeps using `priorStatus` unchanged. **Casting note:** if Postgres rejects the enum comparison (`operator does not exist`), add explicit casts: `SET status = 'pause_requested'::"RunStatus"`, `= ANY(${[...PAUSABLE_STATUSES]}::text[]::"RunStatus"[])`, and `${category}::"PauseReason"` if `pauseReason` is an enum column (check `packages/db/prisma/schema.prisma`); adjust until the integration test passes — the test, not the first guess, is the arbiter.

- [ ] **Step 4: Run the tests.** Run: `npx vitest run packages/control/test/integration/pause.test.ts`. Expected: PASS, including every pre-existing case (flag file written, event appended, refusals).

- [ ] **Step 5: Commit.**

```bash
git add packages/control/src/pause.ts packages/control/test/integration/pause.test.ts
git commit -m "fix(control): requestPause claims and reads priorStatus in one statement"
```

---

### Task 5: The gate — `npm run gate:m15-boundary`

**Files:**
- Create: `scripts/gate-m15-boundary.mjs`
- Modify: `package.json` (register `"gate:m15-boundary": "tsc --build && node --env-file=.env scripts/gate-m15-boundary.mjs"` beside the other gates); `README.md` (gate table row + `-H 127.0.0.1` on the dev/start commands)

**Interfaces:**
- Consumes: the mounted middleware (Task 2); `data-testid="security-posture"` is NOT needed (no browser — plain fetch).
- Produces: the PASS line `PASS: the boundary holds — loopback-only, cross-site refused`.

- [ ] **Step 1: Write the gate.** Borrow `scripts/gate-m14-fidelity.mjs`'s next-dev boot verbatim (its free-port helper and the spawn-and-wait block around lines 158 and 525–560 — `spawn('node', ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(port)], …)`, resolve the real port from next's own "http://localhost:<port>" line). Add `'-H', '127.0.0.1'` to the spawn args. No Chromium, no daemon, no DB writes. Then the checks, each printing one `stage N:` line (spec §5):

```js
const url = (path) => `${baseUrl}${path}`
const W = '00000000-0000-4000-8000-000000000001' // SEED_WORKSPACE_ID; used only in URLs
const BOGUS = '11111111-1111-4111-8111-111111111111'

// 1. Foreign Host → 403 with the exact reason, on a page AND an API path.
for (const path of ['/', `/api/w/${W}/overview`]) {
  const res = await fetch(url(path), { headers: { host: 'evil.example' } })
  assert(res.status === 403, `${path} with foreign Host: expected 403, got ${res.status}`)
  const body = await res.json()
  assert(body.error === 'foreign host evil.example — this instance is loopback-only', `unexpected body: ${JSON.stringify(body)}`)
}

// 2. Cross-site write → 403, before the route can act. BOGUS id: if the middleware were absent
// the route would answer for itself (404/409) — 403 is the middleware's voice alone.
{
  const res = await fetch(url(`/api/w/${BOGUS}/emergency-stop`), { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })
  assert(res.status === 403, `cross-site POST: expected 403, got ${res.status}`)
}

// 3. Cross-site read → 403 before any SSE frame.
{
  const res = await fetch(url(`/api/w/${W}/events`), { headers: { 'sec-fetch-site': 'cross-site' } })
  assert(res.status === 403, `cross-site SSE GET: expected 403, got ${res.status}`)
}

// 4. Cross-origin without fetch metadata → 403.
{
  const res = await fetch(url(`/api/w/${BOGUS}/emergency-stop`), { method: 'POST', headers: { origin: 'https://evil.example' } })
  assert(res.status === 403, `cross-origin POST: expected 403, got ${res.status}`)
}

// 5. Same-origin and headerless traffic pass THROUGH to the routes.
{
  const a = await fetch(url(`/api/w/${W}/overview`), { headers: { 'sec-fetch-site': 'same-origin' } })
  assert(a.status === 200, `same-origin overview: expected 200, got ${a.status}`)
  const b = await fetch(url(`/api/w/${W}/overview`)) // curl-style
  assert(b.status === 200, `headerless overview: expected 200, got ${b.status}`)
  const c = await fetch(url(`/api/w/${BOGUS}/emergency-stop`), { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
  assert(c.status !== 403, `same-origin control POST must reach the route; got 403`)
}

// 6. Reseed consolidation: the route file no longer knows the header; the middleware still refuses.
{
  const source = readFileSync('apps/web/src/app/api/dev/reseed/route.ts', 'utf8')
  assert(!source.includes('sec-fetch-site'), 'reseed route still carries a private sec-fetch-site check')
  const res = await fetch(url('/api/dev/reseed'), { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } })
  assert(res.status === 403, `cross-site reseed: expected 403, got ${res.status}`)
}

console.log('PASS: the boundary holds — loopback-only, cross-site refused')
```

Check 5 requires the dev DB (overview 200 needs the seed workspace) — the gate runs with `--env-file=.env` like every other gate; if `/api/w/${W}/overview` is not 200 on a seeded dev DB, print the body in the failure. Kill the next-dev child in a `finally`, remove its temp `.next`? No — the gate uses the repo's `apps/web/.next` like gate-m14 does; therefore the gate script must state in a header comment (copied discipline from gate-m14): **never run while a dev server is serving `apps/web`**.

- [ ] **Step 2: Register and document.** `package.json`: add the script line. `README.md`: gate table row — `npm run gate:m15-boundary` | "The M15 gate: the boundary holds — foreign Host, cross-site writes and cross-site SSE reads all refused by the middleware in a real `next dev`, same-origin traffic untouched. **Spends nothing**, CI-runnable." Update the README's `next dev`/`next start` command examples to carry `-H 127.0.0.1` (grep `next dev` and `next start` in README.md).

- [ ] **Step 3: Run the gate.** Stop any dev server first. Run: `npm run gate:m15-boundary`. Expected: the PASS line, exit 0.

- [ ] **Step 4: Commit.**

```bash
git add scripts/gate-m15-boundary.mjs package.json README.md
git commit -m "feat(gate): m15 — the boundary holds, proven against a real next dev for zero dollars"
```

---

### Task 6: B2 — Cursor's denial echo reaches the tally

**Files:**
- Modify: `packages/providers/src/cursor/stream.ts` (the completed branch of `parseToolCallLine`, ~line 288; the docstring's "no denial echo" sentence ~line 61 and R4 paragraph ~lines 64–73)
- Modify: `apps/orchestrator/src/pump.ts` (`recordCursorPauseIfRequested`'s clean-terminal check, ~line 374, and its docstring)
- Test: `packages/providers/test/cursor-stream.test.ts`; the orchestrator test file that exercises `recordCursorPauseIfRequested` (find it: `grep -rln "recordCursorPause\|cursor.*pause" apps/orchestrator/test/`)

**Interfaces:**
- Consumes: the committed fixture `packages/providers/test/fixtures/cursor/gate/run-2-flag-present.ndjson` (real recorded denial); the `permission_denied` variant of `RuntimeEvent` (see `packages/providers/src/types.ts` for its exact fields — match the Claude parser's shape).
- Produces: `parseCursorLine` emits `{ kind: 'permission_denied', toolUseId, toolName }` for a rejected completed half. The pump's `denied` tally now fills for Cursor; the checkpoint chain (already forwarding `input.denied`) carries real ids.

- [ ] **Step 1: Write the failing parser test.** In `cursor-stream.test.ts`, take a real rejected completed line from `fixtures/cursor/gate/run-2-flag-present.ndjson` (read the file, pick the line whose payload carries `"rejected"`) and assert:

```ts
it('maps a completed half carrying a rejected result to permission_denied', () => {
  const line = /* the rejected completed line, verbatim from the fixture */
  const event = parseCursorLine(line)
  expect(event.kind).toBe('permission_denied')
  // toolUseId = the line's call_id; toolName follows the started-half convention (shellToolCall → shell).
})

it('still ignores an ordinary completed half', () => {
  const line = /* a completed line WITHOUT a rejected result, from cursor-run.ndjson */
  expect(parseCursorLine(line).kind).toBe('ignored')
})
```

Never assert on the vendor's `reason` text (cursor-agent self-updates; message prefixes have changed before) — assert kind, `toolUseId`, `toolName` only.

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run packages/providers/test/cursor-stream.test.ts`. Expected: the new first test FAILS (`ignored`).

- [ ] **Step 3: Implement the parser change.** In `parseToolCallLine`'s `subtype !== 'started'` branch: before returning `ignored`, detect a rejection — the tool payload object (the value under the tool key) contains a `rejected` result (derive the exact nesting from the fixture line; write it as code that checks the actual recorded shape, tolerating absence). On detection return the `permission_denied` variant with `toolUseId: data.call_id` and the same `toolName` derivation the started half uses. Update the two comment sites in the same commit:
  - the docstring sentence "`deniedToolUseIds` is always `[]`; Cursor's stream has no denial echo" → the echo exists (M13 measured it; this parser now maps it), `deniedToolUseIds` on the RESULT line stays `[]` because the denials arrive as their own events;
  - the R4 paragraph → the `hook_denied`/`hook_crashed`/`hook_failed_open` ban STANDS (they drive `stopped_by_gate` and the circuit breaker; Cursor's gate is defense-in-depth and must never trip them); `permission_denied` is off the banned list as of M15 because the denial being mapped is Cursor's OWN rejected echo, not a Claude-shaped hook line.

- [ ] **Step 4: Run the parser tests.** Run: `npx vitest run packages/providers/test/cursor-stream.test.ts`. Expected: PASS, including all pre-existing cases (especially: the full-fixture replay must not change any other line's classification).

- [ ] **Step 5: Fix the pump's clean-terminal check.** In `recordCursorPauseIfRequested` (~line 374), change

```ts
if (input.outcome !== null && !input.outcome.isError && input.outcome.deniedToolUseIds.length === 0) return false
```

to

```ts
if (input.outcome !== null && !input.outcome.isError && input.denied.length === 0) return false
```

and update its comment: the denials arrive as stream events into the pump's own tally (`input.denied`) as of M15 — `outcome.deniedToolUseIds` is `[]` for Cursor by construction, so reading it made the check vacuous (review I2's intent, finally real). Extend/adjust the orchestrator's cursor-pause test: a run with a clean terminal result but one denied call still pauses, and its checkpoint's `deniedToolUseIds` carries the id.

- [ ] **Step 6: Run the orchestrator tests.** Run: `npx vitest run <the orchestrator cursor-pause test file>`. Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add packages/providers/src/cursor/stream.ts packages/providers/test/cursor-stream.test.ts apps/orchestrator/src/pump.ts <orchestrator test file>
git commit -m "fix(providers): Cursor's denial echo becomes permission_denied, and the pause check finally reads it"
```

---

### Task 7: B3 + B4 — two one-line debts (batched)

**Files:**
- Modify: `apps/orchestrator/src/sweep.ts` (delete the private `isAlive`, ~lines 50–74; import from `@ai-team-os/control`)
- Modify: `apps/web/src/components/OverviewClient.tsx` (~line 235, the `<RuntimeCard …>` call site — add `key`)
- Test: existing `apps/orchestrator/test` sweep tests (unchanged, must stay green); `apps/web/test/overview-components.test.tsx` (new case)

**Interfaces:**
- Consumes: `isAlive` from `@ai-team-os/control` (re-exported from `@ai-team-os/providers`; `sweep.ts` already imports other names from control — extend that import).
- Produces: nothing new.

- [ ] **Step 1: B3.** In `sweep.ts`: delete the local `isAlive` function AND its docstring; add `isAlive` to the existing `@ai-team-os/control` import. Keep one short comment at the first call site: pid-liveness semantics (EPERM=alive, null/≤0=dead) live with the shared implementation in `packages/providers/src/runtime/process.ts`.

- [ ] **Step 2: Run the sweep tests.** Run: `npx vitest run apps/orchestrator/test` (the sweep specs live there). Expected: PASS, no behaviour change.

- [ ] **Step 3: B4, failing test first.** In `apps/web/test/overview-components.test.tsx`, using the file's existing OverviewClient/RuntimeCard harness idiom:

```ts
it('RuntimeCard drafts re-seed when the saved provider/budget pair changes', () => {
  const { rerender } = render(/* OverviewClient or the smallest wrapper the file already uses, budgetUsd: 20 */)
  // dirty nothing; simulate the snapshot moving under the card:
  rerender(/* same tree, budgetUsd: 35 */)
  expect((screen.getByLabelText('budget (USD)') as HTMLInputElement).value).toBe('35')
})
```

(Adapt the accessor to the card's real label — check `runtime-card.test.tsx` for the exact `getByLabelText` strings.) Run it; expected FAIL (stale `20`).

- [ ] **Step 4: B4 implement.** In `OverviewClient.tsx`, on the `<RuntimeCard` element add:

```tsx
key={`${view.workspace.provider ?? ''}|${view.workspace.budgetUsd ?? ''}`}
```

with a one-line comment: the card's drafts are deliberately uncontrolled; a changed SAVED pair remounts it with fresh drafts, an unrelated re-render (same key) never clobbers a draft in progress (M15 spec §3 B4).

- [ ] **Step 5: Run the web tests and the bundler.** Run: `npx vitest run apps/web/test/overview-components.test.tsx && npm run web:build`. Expected: PASS / success.

- [ ] **Step 6: Commit.**

```bash
git add apps/orchestrator/src/sweep.ts apps/web/src/components/OverviewClient.tsx apps/web/test/overview-components.test.tsx
git commit -m "fix: sweep borrows the one isAlive; RuntimeCard re-seeds on a saved change"
```

---

### Task 8: B5 — the seed says why it is inert, and the review warning says it once

**Files:**
- Modify: `packages/db/src/seed.ts` (comment on the task loop, ~line 127)
- Modify: `apps/orchestrator/src/review.ts` (dedupe the warn, ~line 212)
- Test: the orchestrator test file covering review dispatch (find it: `grep -rln "dispatchReview\|no usable implementation" apps/orchestrator/test/`)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new. **Hard constraint (Global Constraints, spec §3 B5): do NOT add `requiredRole` to any seeded task** — the seed being undispatchable is a money-safety property.

- [ ] **Step 1: Failing test.** In the review test file:

```ts
it('warns once, not once per tick, for a reviewing task with no usable implementation run', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  /* arrange: the file's existing fixture for a reviewing task with no implementation run */
  await /* dispatch call, twice */
  const matching = warn.mock.calls.filter(([msg]) => String(msg).includes('no usable implementation run'))
  expect(matching).toHaveLength(1)
  warn.mockRestore()
})
```

Run it; expected FAIL (2 calls).

- [ ] **Step 2: Implement the dedupe.** In `review.ts`, module level:

```ts
/** Task ids already warned about as unreviewable — once per daemon lifetime, not once per tick
 *  (M15 spec §3 B5): the seeded `reviewing` fixture task made this line the daemon log's loudest
 *  and least informative repetition. Bounded by the number of distinct stuck tasks. */
const warnedUnreviewable = new Set<string>()
```

and wrap the `console.warn` at ~212:

```ts
if (!warnedUnreviewable.has(task.id)) {
  warnedUnreviewable.add(task.id)
  console.warn(/* existing message unchanged */)
}
```

- [ ] **Step 3: The seed's comment.** Above the task-creation loop in `seed.ts` (the `for (const status of TASK_STATUSES)` block), add:

```ts
// Deliberately NO `requiredRole` on any seeded task: `decide()` cannot match a roleless task to
// an agent, so a daemon pointed at freshly-seeded data starts nothing and spends nothing — the
// tick's `skippedNoRole: 12` on this workspace is that invariant showing, not a bug (M15 spec
// §3 B5). The seed demonstrates the UI's states; it must never be dispatchable demo data,
// because this workspace carries a live ProviderConfiguration and real runs cost real money.
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run <review test file>`. Expected: PASS (both the new case and the file's existing ones).

- [ ] **Step 5: Commit.**

```bash
git add packages/db/src/seed.ts apps/orchestrator/src/review.ts <review test file>
git commit -m "fix(orchestrator): the unreviewable warning fires once; the seed says why it is inert"
```

---

### Task 9: C — Cursor's tokens, billed like Claude's

**Files:**
- Modify: `packages/providers/src/cursor/stream.ts` (`resultSchema` ~line 324 and the outcome build ~line 372–401; the stale "usage goes unread" comments ~332–340 and ~386–398)
- Modify: `docs/superpowers/specs/2026-08-29-m14-design-fidelity-design.md` (one erratum line in `## 9. Errata (post-execution)`)
- Test: `packages/providers/test/cursor-stream.test.ts`

**Interfaces:**
- Consumes: fixture `packages/providers/test/fixtures/cursor/cursor-run.ndjson` (result line: `"usage":{"inputTokens":15391,"outputTokens":223,"cacheReadTokens":25856,"cacheWriteTokens":0}`); `RunOutcome.tokens: { input: number; output: number } | null`.
- Produces: Cursor outcomes with real `tokens`; `pump.ts`'s `writeStreamUsage` and the Agents/Analytics pages consume them with zero changes.

- [ ] **Step 1: Failing tests.** In `cursor-stream.test.ts`:

```ts
it('maps the result usage under the billed-input rule: input+cacheRead+cacheWrite / output', () => {
  const event = /* parse the fixture's result line */
  // 15391 + 25856 + 0 = 41247
  expect(event.kind === 'terminated' && event.outcome.tokens).toEqual({ input: 41247, output: 223 })
})

it('degrades malformed usage to null, never to a guess', () => {
  const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, usage: { inputTokens: 'many' } })
  const event = parseCursorLine(line)
  expect(event.kind === 'terminated' && event.outcome.tokens).toBeNull()
})

it('absent usage stays null', () => {
  const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false })
  const event = parseCursorLine(line)
  expect(event.kind === 'terminated' && event.outcome.tokens).toBeNull()
})
```

Run: `npx vitest run packages/providers/test/cursor-stream.test.ts`. Expected: first test FAILS (`null`).

- [ ] **Step 2: Implement.** In `cursor/stream.ts`:
  1. `resultSchema` gains `usage: z.unknown().optional()` (NOT a `z.object` of numbers — a wrongly-typed usage must degrade `tokens` to null, never make the whole result line unparsable and leave the orchestrator waiting on an exited process).
  2. Add:

```ts
/**
 * `RunOutcome.tokens` from the result line's `usage`, under the same billed-input rule as
 * Claude's (`types.ts`): input = inputTokens + cacheReadTokens + cacheWriteTokens (each billed,
 * each 0 when absent), output = outputTokens alone. Any PRESENT field that is not a
 * non-negative finite number degrades the whole reading to `null` — a partial figure is a lie
 * the per-agent averages would believe, and cursor-agent self-updates without notice, so the
 * shape is tolerated, never asserted (M15 spec §4).
 */
function tokensFromUsage(usage: unknown): { readonly input: number; readonly output: number } | null {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return null
  const read = (key: string): number | null => {
    const value = (usage as Record<string, unknown>)[key]
    if (value === undefined) return 0
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  }
  const input = read('inputTokens')
  const output = read('outputTokens')
  const cacheRead = read('cacheReadTokens')
  const cacheWrite = read('cacheWriteTokens')
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null
  return { input: input + cacheRead + cacheWrite, output }
}
```

  3. In the outcome build: `tokens: tokensFromUsage(data.usage)` replacing `tokens: null`.
  4. Rewrite, in this same commit, the two comment blocks that say usage "goes unread" / "is UNMAPPED in M14" (~332–340 and ~386–398): the M14 provider rule is superseded by M15 spec §4; `runtimeReportsUsage` in `pump.ts` concerns SKILL tallies, not tokens, and is untouched.

- [ ] **Step 3: The M14 erratum.** Append to the M14 spec's `## 9. Errata (post-execution)`:

```
7. §4.2's "Cursor → `null` tokens" provider rule is superseded by M15 (spec
   2026-08-30-m15-boundary-and-debts-design.md §4): the recorded `usage` counters are mapped
   under the same billed-input rule as Claude's. Pre-M15 Cursor runs keep `null` — no backfill,
   raw streams are not retained.
```

- [ ] **Step 4: Run the provider tests.** Run: `npx vitest run packages/providers/test/cursor-stream.test.ts packages/providers/test/cursor-adapter.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/providers/src/cursor/stream.ts packages/providers/test/cursor-stream.test.ts docs/superpowers/specs/2026-08-29-m14-design-fidelity-design.md
git commit -m "feat(providers): Cursor's tokens, billed like Claude's — 41247 in, 223 out, from the recorded run"
```

---

### Task 10: Full-suite verification

**Files:** none new.

- [ ] **Step 1:** Ensure no daemon and no dev server are running (`pgrep -af "next dev|cli.js daemon"`).
- [ ] **Step 2:** Run: `npm test`. Expected: every file green (1757 + the new cases).
- [ ] **Step 3:** Run: `npm run typecheck`. Expected: clean.
- [ ] **Step 4:** Run: `npm run gate:m15-boundary` once more at the branch tip. Expected: the PASS line.
- [ ] **Step 5:** No commit (nothing to commit); report counts.
