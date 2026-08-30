# M15 — The Browser Boundary, M13's Debts, and Cursor's Tokens

**Status:** Approved (sections approved in conversation 2026-08-30)
**Approach:** C — full browser boundary now, named posture, shared-secret auth deferred until a non-loopback bind exists.

## 1. Why this milestone

Every web API route is unauthenticated. That was a consistent, deliberate posture while the app
bound to loopback, but M13 added workspace-configuration PUTs (provider, budget) and M14 added
Settings surfaces and `/api/dev/reseed`; the surface has outgrown "nothing here matters". The
deployment model is a single operator on their own machine, so the threat is not "who are you" —
it is the operator's own browser being used against them: a hostile page issuing cross-site
requests, or DNS rebinding pointing a hostile origin at 127.0.0.1. M15 closes that boundary,
names the posture in code and in the UI, and pays down the small debts M13's final review left,
plus the Cursor token mapping M14 measured but ruled out of scope.

**Non-goals:** user accounts, sessions, tokens, HTTPS, LAN access, per-workspace authorization.
`boundary.ts` is written so a future shared-secret layer slots into the same module, and that is
the only concession to the future.

## 2. Series A — the browser boundary

### 2.1 `apps/web/src/lib/boundary.ts` (new)

Pure, dependency-free decision module. Exports:

```ts
export const POSTURE = 'loopback-only' as const

export interface BoundaryRequest {
  readonly host: string | null          // Host header, verbatim
  readonly secFetchSite: string | null  // Sec-Fetch-Site header
  readonly origin: string | null        // Origin header
  readonly path: string                 // URL pathname
}

export type BoundaryVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: string }

export function boundaryVerdict(request: BoundaryRequest): BoundaryVerdict
```

Rules, evaluated in order:

1. **Host allowlist — every path, every method.** Parse the host part of the `Host` header
   (strip one trailing `:<port>`; `[::1]:3000` parses to `[::1]`). Allowed hosts, exactly:
   `localhost`, `127.0.0.1`, `[::1]`. Anything else — including a missing Host header — is
   `{ allow: false, reason: 'foreign host <host> — this instance is loopback-only' }` (for a
   missing header, `<host>` is the literal `<none>`). Port is not checked: dev runs on 3000, the
   gates bind ephemeral ports.
2. **Cross-site refusal — `/api/` paths only, ALL methods including GET** (the SSE and JSON GETs
   leak workspace data; a cross-site *read* is as much the threat as a cross-site write):
   - If `Sec-Fetch-Site` is present: allow `same-origin` and `none` (address bar, curl with the
     header unset never sends it — "present" means present); refuse anything else
     (`cross-site`, `same-site`, `cross-origin`) with
     `{ allow: false, reason: 'cross-site request refused (sec-fetch-site: <value>)' }`.
   - Else if `Origin` is present: its host part must itself pass rule 1's allowlist; otherwise
     `{ allow: false, reason: 'cross-origin request refused (origin: <value>)' }`. Comparing
     Origin's host against the allowlist rather than against the request's own Host is deliberate:
     both ends must be loopback names, and `localhost` vs `127.0.0.1` mismatches (same machine,
     different spelling) stay allowed.
   - Else (neither header — curl, non-browser clients): allow. The boundary defends against
     browsers; a local process without browser headers is the operator.
3. Everything else: `{ allow: true }`.

No I/O, no Next imports, no env reads — the module must be trivially unit-testable and importable
by the gate.

### 2.2 `apps/web/src/middleware.ts` (new)

Next middleware (edge runtime), matcher: all paths. Builds a `BoundaryRequest` from the incoming
headers and URL, calls `boundaryVerdict`, and:
- on `allow: false` for an `/api/` path: `NextResponse.json({ error: reason }, { status: 403 })`;
- on `allow: false` for a page path: same JSON 403 (a foreign-host page request is a rebinding
  probe, not a person to render an error page for);
- on `allow: true`: `NextResponse.next()` untouched.

The middleware contains no logic beyond header extraction — every decision lives in
`boundary.ts`.

### 2.3 Reseed route simplification

`apps/web/src/app/api/dev/reseed/route.ts` currently carries its own `sec-fetch-site` check
(added in M14's fix wave). Remove it; the middleware is the single rule source. The route keeps
its `NODE_ENV !== 'production'` guard — that is a different rule (dev-only feature, not
boundary). Its tests move to asserting the guard only; the boundary tests own the header rules.

### 2.4 Binding

- The README's dev/start commands and the operator wrapper scripts gain `-H 127.0.0.1`
  (`next dev apps/web -p 3000 -H 127.0.0.1`, same for `next start`).
- The middleware's Host rule is the backstop: even bound to `0.0.0.0` by mistake, a request that
  arrives with a non-loopback Host is refused. (A LAN client could still forge `Host: localhost`
  with curl — the backstop is against browsers and accidents, not against a hostile LAN; that is
  the documented edge of `loopback-only`.)

### 2.5 Settings visibility

The Settings page gains a "Security" card (same card chrome as Provider Adapters), static
content read from `POSTURE`:
`loopback-only · no accounts · cross-site requests refused`.
No controls — an honest statement, per M14's "build what is real, label what is not" rule.

## 3. Series B — M13's five debts

**B1 — `requestPause` read→claim race** (`packages/control/src/pause.ts`). `priorStatus` is read
from a row fetched before the claim; a status change between read and claim can make the
restore-on-refusal path write a stale status back. Collapse read and claim into one atomic
statement:

```sql
UPDATE "AgentRun" AS r
SET status = 'pause_requested'
FROM (SELECT id, status FROM "AgentRun" WHERE id = $1 FOR UPDATE) AS prev
WHERE r.id = prev.id AND prev.status = ANY($2)
RETURNING prev.status AS "priorStatus"
```

via `prisma.$queryRaw`, `$2` = `PAUSABLE_STATUSES`. Zero rows = claim lost (same refusal as
today). All existing refusal paths (run not found, workspace halted, wrong status) keep their
shapes; the pre-claim `findUnique` survives for those checks, but `priorStatus` now comes from
the claim itself. New test: of two concurrent `requestPause` calls only one claims, and the
value restored on a refused signal is the status the claim actually interrupted.

**B2 — Cursor pauses discard `deniedToolUseIds`** (`apps/orchestrator/src/pump.ts`,
`recordCursorPauseIfRequested`). The Claude path checkpoints `input.denied`; the Cursor path
throws the outcome's list away and writes `[]`. Write the outcome's list. One expression, plus a
test asserting a Cursor pause checkpoint carries the denied ids the fixture stream contains.
This lands before anything reads the field — which is the whole point of doing it now.

**B3 — `sweep.ts`'s private `isAlive`** (`apps/orchestrator/src/sweep.ts:59`). Delete it; import
`isAlive` from `@ai-team-os/control`. Behaviour is identical by inspection (EPERM alive, ESRCH
dead, null dead); existing sweep tests guard it. The duplication census then shows zero
unexplained copies.

**B4 — `RuntimeCard` drafts never re-sync** (`apps/web/src/components/RuntimeCard.tsx`). The
card seeds `useState` from props and ignores every later prop change. Key the card at its call
site on the saved pair: `key={`${provider ?? ''}|${budgetUsd ?? ''}`}`. A saved change remounts
with fresh drafts; an unsaved draft is never clobbered by a re-render that changed nothing.
Chosen over effect-based sync deliberately (remount is the idiomatic "reset uncontrolled state").

**B5 — seed hygiene** (`packages/db/src/seed.ts`). Two defects, one cause — the seed exists to
show the UI, not to feed the daemon, and it currently feeds the daemon garbage every tick:
- Every seeded agent whose template carries a role gets that role on its `Agent` row (Atlas
  `manager` and Riley `reviewer` already do; the rest get their template's role — the daemon
  reported `skippedNoRole: 12` on the seed workspace, so the implementer reconciles that count
  against the seeded agents and drives it to 0).
- The fixture task seeded in `reviewing` with no implementation run (`[review] task a9ae38b6 … no
  usable implementation run` logged every tick) is re-seeded as `done` instead. Decision: change
  the seeded status, do not fabricate a fake run.

## 4. Series C — Cursor's tokens

### 4.1 Parser (`packages/providers/src/cursor/stream.ts`)

The `result` line's `usage` object (camelCase: `inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`) is read into `RunOutcome.tokens`:

- `input = inputTokens + cacheReadTokens + cacheWriteTokens` — the same billed-input rule as
  Claude's (`types.ts:56`): every counter that costs money counts, each treated as 0 when absent.
- `output = outputTokens` alone.
- If `usage` is absent, not an object, or any read value is not a non-negative finite number:
  `tokens: null` — tolerance for other binary versions, per the cursor-agent self-update rule
  (never assert vendor schema stability; record, don't require).

Test from the committed fixture `packages/providers/test/fixtures/cursor/cursor-run.ndjson`:
`input = 15391 + 25856 + 0 = 41247`, `output = 223`. A malformed-usage case asserts the `null`
fallback.

### 4.2 Supersession, recorded

M14 spec §4.2's "Cursor → `null`" was a deliberate rule; this section supersedes it. One-line
erratum in the M14 spec pointing here. The stale comments in `cursor/stream.ts` (~41–50 and
~332–398, "usage is deliberately unread") are rewritten in the same commit that changes the
behaviour.

### 4.3 What does not change

`pump.ts`'s `writeStreamUsage` already persists `outcome.tokens` when non-null, and
Agents/Analytics already render numbers when `tokensIn/Out` are present — no DB migration, no UI
work. **No backfill:** raw streams are not retained, so pre-M15 Cursor runs keep `null` tokens;
their `—` in the UI is the honest record.

## 5. Gate — `npm run gate:m15-boundary`

Zero spend, CI-runnable. A real `next dev` on an ephemeral loopback port; plain `fetch` with
forged headers (no browser needed — the rules are pure header logic, and `boundary.test.ts`
already proves the decision table; the gate proves the middleware is actually mounted in front
of every route):

1. **Foreign Host:** `GET /` and `GET /api/w/<seed>/overview` with `Host: evil.example` → both
   403, body `{ error: "foreign host evil.example — this instance is loopback-only" }`.
2. **Cross-site write:** `POST /api/w/<seed>/emergency-stop` with `Sec-Fetch-Site: cross-site`
   → 403; the workspace is verifiably NOT halted afterwards.
3. **Cross-site read:** `GET /api/w/<seed>/events` with `Sec-Fetch-Site: cross-site` → 403
   before any SSE frame.
4. **Cross-origin without fetch metadata:** `POST` with `Origin: https://evil.example` and no
   `Sec-Fetch-Site` → 403.
5. **Same-origin traffic:** `Sec-Fetch-Site: same-origin` GET and headerless (curl-style) GET
   → 200; one real control POST round-trips.
6. **Reseed consolidation:** the route file no longer contains `sec-fetch-site` (single rule
   source, proven by grep), yet a cross-site `POST /api/dev/reseed` still 403s — the middleware
   caught it.

PASS line: `PASS: the boundary holds — loopback-only, cross-site refused`. README row states
zero spend. Registered as `gate:m15-boundary` in the root `package.json`.

## 6. Testing summary

- `apps/web/test/boundary.test.ts` — decision table over host/header combinations (every rule
  and every reason string in §2.1).
- Middleware mounting proven by the gate (§5), not by unit tests — Next's edge runtime is not
  worth simulating in vitest.
- B1 concurrency test in `packages/control`; B2 checkpoint test in orchestrator tests; B5
  asserted by a seed test (roles present, no `reviewing`-without-run task).
- C1 fixture tests in `packages/providers`.
- Standing rules bind: one vitest run at a time, daemon stopped, `web:build` never while a dev
  server runs, `apps/web` tasks gate on `npm run web:build`.

## 7. Global constraints

- Boundary allowlist hosts, verbatim: `localhost`, `127.0.0.1`, `[::1]`.
- 403 body shape everywhere: `{ error: <reason string from boundaryVerdict> }`.
- `POSTURE = 'loopback-only'` is the single source for the Settings card text.
- Billed-input rule (both providers): input = every billed input counter summed; output = output
  counter alone.
- Comments change in the same commit as the behaviour they describe.
- No new dependencies.
