# M20 — A Lock on the Door: single-operator password login

**Status:** Approved (scenario, mode question and the five design sections approved in conversation 2026-09-02)
**Approach:** two modes, one switch — no password configured means today's M15 behaviour, byte for byte; a configured password means every page and every `/api/` path asks for it.
**Scope rule:** auth alone. The M19 queue's small items (hook_id parser pairing, typed `toolUseId`, B1 negative-control tests, `widthFor` isFinite guard, gate check-2 EOF scan) are carried to M21 untouched — operator decision 2026-09-01, reaffirmed 2026-09-02.

## 1. Why this milestone

M15 closed the browser boundary and named the posture `loopback-only`: the app answers only to
loopback Host names and refuses cross-site `/api/` traffic. That is the right posture for one
operator on one machine, and it is the wrong posture the moment the operator wants to check on
a run from their phone or a second machine. M13's workspace-configuration PUTs, M14's Settings
surfaces and M18's permission matrix make the web app an operator console, not a read-only
view, so opening it to a second device needs a lock — not accounts, not roles, a lock.

**Scenario (chosen 2026-09-02):** a single operator reaching the app from their own devices,
over Tailscale or a trusted LAN. There is exactly one identity, so the credential is one shared
secret. Transport encryption is deliberately not this milestone's job: a tailnet is already
encrypted end to end, and an operator who instead exposes the port on a plain LAN is told, in
the README, that the password and cookie travel in clear.

**Non-goals:** TLS/HTTPS, user accounts, roles, per-workspace authorization, an actor identity
on events, a session table (listing, revoking), a rate-limit table, a secret store beyond the
`.env` file `DATABASE_URL` already lives in, and any change to how the orchestrator or the
control package authenticate (they never did — they share the database, not HTTP).

## 2. Series A — the boundary in two modes

### 2.1 The switch: `AITEAMOS_PASSWORD`

Read from the process environment (the root `.env`, loaded by `npm run web`'s `--env-file`,
exactly like `DATABASE_URL`). Trimmed. Empty or absent → **loopback mode**; anything else →
**password mode**. The one place this variable is read is
`apps/web/src/lib/authEnv.ts` (new):

```ts
export type BoundaryMode = 'loopback-only' | 'password'
/** The trimmed password, or null when the instance runs without one. */
export function configuredPassword(): string | null
export function boundaryMode(): BoundaryMode
```

`boundary.ts` and `session.ts` stay pure: they receive the mode and the password as arguments
and never touch `process.env`. Middleware, the two auth routes, the login page and the Settings
page are the callers of `authEnv.ts`, and nothing else is.

No boot-time refusal is needed for "exposed without a password": with no password the M15 Host
rule still refuses every non-loopback Host, so an accidental `-H 0.0.0.0` is inert, as M15 §2.4
already promised — superseded by Errata 7.

### 2.2 `apps/web/src/lib/session.ts` (new)

The session is a stateless, HMAC-signed cookie. No table, no store; changing the password
invalidates every session at once, which is the revocation story for one operator.

- Cookie name `aiteamos_session`; value `<expiresAt>.<signature>` where `expiresAt` is a unix
  timestamp in seconds and `signature` is lowercase hex HMAC-SHA-256 over the decimal
  `expiresAt` string.
- Key: HMAC-SHA-256 key imported from `SHA-256("aiteamos-session:v1:" + password)`. Derived, not
  random, on purpose — a per-boot random key would log the operator out on every restart, and
  anyone who knows the password already holds the stronger credential.
- Lifetime 30 days from minting. No sliding renewal this milestone.
- Web Crypto only (`crypto.subtle`), no `node:crypto`: the middleware runs on Next's edge
  runtime, the routes on Node, vitest on Node — one module must serve all three.
- Exports:

```ts
export const SESSION_COOKIE = 'aiteamos_session'
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
export async function mintSession(password: string, now: Date): Promise<string>        // cookie value
export async function verifySession(password: string, value: string | null, now: Date): Promise<boolean>
export async function verifyBearer(password: string, authorization: string | null): Promise<boolean>
```

`verifySession`: `null`, a value without exactly one `.`, a non-integer expiry, an expiry at or
before `now`, or a signature that does not match → `false`. `verifyBearer`: the header must be
`Bearer <token>` (one space, case-sensitive scheme) and `<token>` must equal the password.

**Constant time.** Neither runtime offers `timingSafeEqual` on the edge, so every comparison —
signature and bearer — hashes both sides with SHA-256 and compares the two digests with a
non-short-circuiting byte loop. Hashing first makes length differences irrelevant.

### 2.3 `apps/web/src/lib/boundary.ts` (changed)

Still pure, still the one decision module; its inputs grow and its verdict gains a third kind:

```ts
export interface BoundaryRequest {
  readonly mode: BoundaryMode
  readonly host: string | null
  readonly secFetchSite: string | null
  readonly origin: string | null
  readonly path: string
  /** Password mode only; both false in loopback mode. Computed by the middleware from session.ts. */
  readonly sessionValid: boolean
  readonly bearerValid: boolean
}

export type BoundaryVerdict =
  | { readonly allow: true }
  | { readonly allow: false; readonly kind: 'refused'; readonly reason: string }        // 403
  | { readonly allow: false; readonly kind: 'unauthenticated'; readonly reason: string } // 401 / 302

export function boundaryVerdict(request: BoundaryRequest): BoundaryVerdict
export function postureFor(mode: BoundaryMode): string
```

Rules, evaluated in order:

1. **Host allowlist — loopback mode only.** Unchanged from M15 §2.1 rule 1 (hosts, exactly:
   `localhost`, `127.0.0.1`, `[::1]`; port ignored; missing header refused; same reason string).
   In password mode this rule is skipped: the defence is now the credential, and the whole point
   is answering to a tailnet hostname.
2. **Public paths.** `/_next/` (static chunks and HMR — the login page cannot render without
   them), `/favicon.ico`, `/login`, and `/api/auth/login` need no credential in either mode.
   Rule 3 still applies to `/api/auth/login` — a cross-site login POST is refused like any other
   cross-site write. Then allow.
3. **Cross-site refusal — `/api/` only, all methods, both modes.** Unchanged shape from M15 rule
   2, with one change in password mode: when the decision falls to the `Origin` header, its host
   part (M15's `hostOf`, port stripped) is compared against the request's own `Host` header's
   host part, not against the loopback allowlist. A tailnet browser sends
   `Origin: http://box.tail1234.ts.net:3000` with the same Host; that must pass. In loopback
   mode the allowlist comparison stays, so `localhost` ↔ `127.0.0.1` stays allowed as M15 chose.
   Reason strings unchanged.
4. **Credential — password mode only.** `sessionValid` allows any path. `bearerValid` allows
   `/api/` paths only (a bearer on a page request is not a browser and gets nothing useful from
   HTML; refusing keeps the rule small). Otherwise
   `{ allow: false, kind: 'unauthenticated', reason: 'authentication required' }`.
   M15's "neither header — a local process is the operator" escape hatch is closed in password
   mode: a headerless request with no credential is unauthenticated, full stop. It stays open in
   loopback mode.
5. Everything else: `{ allow: true }`.

`postureFor`: `'loopback-only · no accounts · cross-site requests refused'` for loopback mode,
`'password login · single operator · cross-site requests refused'` for password mode. The old
`POSTURE` constant is deleted; `SettingsClient` reads the function's result through a prop the
server page computes (§3.4).

### 2.4 `apps/web/src/middleware.ts` (changed)

Still header extraction plus HTTP, no decisions. Per request: `mode` from `authEnv.ts`; in
password mode `sessionValid` from `verifySession(password, cookie, now)` and `bearerValid` from
`verifyBearer(password, authorizationHeader)`; both `false` in loopback mode without calling
`session.ts` at all. Then:

- `refused` → `NextResponse.json({ error: reason }, { status: 403 })` for page and API paths
  alike (M15's shape).
- `unauthenticated` on an `/api/` path → `NextResponse.json({ error: reason }, { status: 401 })`.
- `unauthenticated` on a page path → 302 to `/login?next=<pathname + search>`, URL-encoded.
- `allow` → `NextResponse.next()`.

Matcher stays "all paths" — rule 2 handles the exemptions inside the decision table so the gate
and the unit tests see them.

## 3. Series B — the login surfaces

### 3.1 `POST /api/auth/login`

Node runtime route. Body `{ password: string }`.

- Loopback mode → 404 `{ error: 'password login is not configured on this instance' }`.
- Wrong password (constant-time, via `session.ts`'s digest compare) → wait 300 ms, log exactly
  one line `[auth] failed login attempt`, respond 401 `{ error: 'wrong password' }`, no cookie.
  The delay is the whole brute-force story this milestone: one operator, one secret, no table.
- Right password → 204, `Set-Cookie: aiteamos_session=<mintSession(...)>; Path=/; HttpOnly;
  SameSite=Lax; Max-Age=2592000` plus `Secure` when the request arrived over https
  (`nextUrl.protocol === 'https:'` or `x-forwarded-proto: https`). `SameSite=Lax` rather than
  `Strict` so a link opened from another app lands logged in; the cross-site rule already covers
  the CSRF case Lax leaves open.

### 3.2 `POST /api/auth/logout`

Node runtime route. Clears the cookie (`Max-Age=0`, same attributes). 204 always — a stale or
absent cookie logging out is not an error. It sits behind rules 3 and 4 like any other `/api/`
path, so a cross-site logout is refused and an unauthenticated one is a 401.

### 3.3 `/login` page

Server component at `apps/web/src/app/login/page.tsx` rendering a small client form
(`components/LoginForm.tsx`): one password field and one submit, built from the M16
`FormControls` kit, on the app's own chrome (no sidebar — the shell layout is a logged-in
surface; the page is a single centred panel). Submits to `POST /api/auth/login` through
`sendControl`; on `null` navigates to `next`, on an error string shows it in the form's error
band (M14's "never blank" rule). Loopback mode renders the same panel with the sentence
`password login is not configured on this instance — loopback-only` and a link to `/` instead
of the form.

`next` is honoured only when it is a same-origin relative path: it must start with `/` and not
with `//` or `/\`; anything else falls back to `/`. Checked in one exported helper
(`lib/safeNext.ts`, `safeNext(value: string | null): string`) so the unit test owns the rule.

### 3.4 Settings, and the one client change

- `apps/web/src/app/settings/page.tsx` computes `mode` on the server and passes
  `posture={postureFor(mode)}` and `mode` down; `SettingsClient`'s security panel renders the
  posture string unchanged in shape (`data-testid="security-posture"`), and in password mode adds
  a `Logout` button (`components/LogoutButton.tsx`: `sendControl('/api/auth/logout', { method:
  'POST' })` then `window.location.assign('/login')`).
- `lib/postControl.ts` `sendControl`: on a 401 response, navigate to
  `/login?next=<current pathname + search>` before returning the error string. Every control
  surface in the app already dials this one function (M19 C4's repo-wide guarantee), so an
  expired session anywhere lands on the login page instead of a red band that never clears. No
  other client code changes: EventSource and the refetch hooks send the cookie on their own, and
  a page whose session expired mid-visit is caught on its next mutation or reload.

## 4. Series C — the operator's surface

- Root `package.json` gains `"web:exposed": "node --env-file=.env node_modules/next/dist/bin/next
  dev apps/web -H 0.0.0.0"`. `web` keeps `-H 127.0.0.1`.
- `.env.example` gains `# AITEAMOS_PASSWORD=` with a two-line comment: set it to require a login;
  leave it unset for the loopback-only default.
- README "Web UI": a "Reaching it from another device" paragraph — set the password, start with
  `web:exposed`, the app then answers to any Host name and asks for the password on every page
  and API call; `curl` sends it as `Authorization: Bearer <password>`; the cookie and the
  password travel in clear over plain HTTP, so use a tailnet (recommended) or a trusted LAN,
  never the open internet; changing the password logs every device out. Plus the gate row.
- No new dependencies.

## 5. Gate — `npm run gate:m20-auth`

Zero spend, CI-runnable, plain `fetch` (the rules are header logic, as in M15). Two real
`next dev` boots, strictly sequential — they share `apps/web/.next`, and M15's gate already
documents why two dev servers must never overlap. Both bind `-H 127.0.0.1`; "foreign Host" is
forged in the header, so the gate never opens a non-loopback socket on the machine it runs on.
Needs the seeded development database (as `gate:m15-boundary` does) and refuses to start if a
`next dev` is already running.

**Run A — loopback mode, behaviour unchanged.** With `AITEAMOS_PASSWORD` deleted from the child
environment, run `scripts/gate-m15-boundary.mjs` as a child process and require its exact PASS
line. Reusing the M15 gate verbatim, rather than copying its stages, is the proof that the
default mode did not move: the same six checks, the same script, one line of glue.

**Run B — password mode.** `AITEAMOS_PASSWORD` set to a random 24-character value for the child
`next dev` only:

1. `GET /` without a cookie → 302, `Location: /login?next=%2F`; `GET /login` → 200 and the HTML
   contains the password field; `GET /_next/static/...` for a chunk referenced by that HTML → 200
   (rule 2 holds — the login page can actually render).
2. `GET /api/w/<seed>/overview` with no cookie and no headers → 401
   `{ error: 'authentication required' }` (the headerless escape hatch is closed).
3. `POST /api/auth/login` wrong password → 401 `{ error: 'wrong password' }`, no `Set-Cookie`,
   and the round trip took ≥ 250 ms.
4. `POST /api/auth/login` right password → 204 with `Set-Cookie` carrying `aiteamos_session`,
   `HttpOnly`, `SameSite=Lax`, no `Secure` (plain http).
5. With the cookie: `GET /` → 200; `GET /api/w/<seed>/overview` → 200; `GET /api/w/<seed>/events`
   delivers its first SSE frame.
6. A tampered cookie (one hex digit of the signature flipped) → 401 on the API, 302 on the page;
   a cookie whose expiry is in the past, minted by the gate with the same key derivation → 401.
7. Bearer: `Authorization: Bearer <password>` and no cookie on `GET /api/w/<seed>/overview` → 200;
   the wrong bearer → 401; the right bearer on `GET /` → 302 (page paths take cookies only).
8. Cross-site with a valid cookie: `POST /api/w/<seed>/emergency-stop` with
   `Sec-Fetch-Site: cross-site` → 403 and the workspace is verifiably NOT halted.
9. Foreign Host is welcome now: `GET /api/w/<seed>/overview` with cookie and
   `Host: box.tail1234.ts.net:3000` → 200; the same with `Origin: http://box.tail1234.ts.net:3000`
   → 200 (same-host origin); with `Origin: http://evil.example` → 403 `cross-origin request
   refused (origin: http://evil.example)`.
10. `POST /api/auth/logout` with the cookie → 204 and a clearing `Set-Cookie`; `GET /` afterwards
    with the cleared cookie → 302.
11. Posture: `GET /settings` with a fresh login's cookie → 200 and the HTML contains
    `password login · single operator · cross-site requests refused` and the Logout button's
    `data-testid="logout"`.

PASS line: `PASS: the door has a lock — loopback unchanged without a password, login required
with one`. Registered as `gate:m20-auth` in the root `package.json`; README row says zero spend.

## 6. Testing summary

- `apps/web/test/boundary.test.ts` grows a password-mode table: Host rule lifted, public paths,
  same-host Origin passes / foreign Origin refused, bearer on `/api/` vs on a page, session on
  both, headerless-without-credential unauthenticated, every new reason string. The loopback-mode
  rows are unchanged and stay — they are the regression proof for run A's promise.
- `apps/web/test/session.test.ts` (new): mint → verify round trip; expiry boundary (at `now`
  is expired); tampered signature; malformed values (`null`, no dot, two dots, non-integer);
  password change invalidates; bearer scheme parsing (`bearer` lowercase refused, `Bearer  x`
  double space refused, exact token accepted); the digest compare is used for both.
- `apps/web/test/safeNext.test.ts` (new): the four shapes (`/w/x`, `//evil`, `/\evil`,
  `https://evil`, `null`).
- `apps/web/test/integration/auth-routes.test.ts` (new, no DB needed but lives with the route
  tests): login right/wrong/unconfigured, logout, cookie attribute string, the 300 ms delay
  (fake timers), the 401 body shape.
- `login-form.test.tsx` and the Settings page test: the form renders and submits through
  `sendControl`; the security panel shows the posture prop and the Logout button only in password
  mode; `sendControl`'s 401 navigation asserted with a stubbed `window.location`.
- Middleware mounting and the env read on the edge runtime are proven by the gate (§5), not
  unit tests — the same M15 ruling; `process.env` on the edge is exactly the kind of thing to
  measure in a real `next dev` rather than assume.
- Standing rules bind: one vitest run at a time, daemon stopped, `web:build` never while a dev
  server runs, every `apps/web` task gates on `npm run web:build`, trace every new field to its
  consumer within the task, `git add` with explicit paths only.

## 7. Global constraints

- One environment variable, `AITEAMOS_PASSWORD`, read in one file, `apps/web/src/lib/authEnv.ts`.
- Loopback mode is M15 byte for byte: same rules, same reason strings, same 403 body, same
  posture text, and `gate:m15-boundary` passes unmodified — the M20 gate runs it to prove so.
- Error body shape everywhere: `{ error: <string> }`; 403 for refused, 401 for unauthenticated
  API, 302 for unauthenticated pages, 404 for login-when-unconfigured.
- Cookie: `aiteamos_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, 30 days, `Secure` only over
  https; value `<expiresAt>.<hex hmac>`; key derived from `SHA-256("aiteamos-session:v1:" + password)`.
- All credential comparisons go through one digest-compare helper in `session.ts`.
- Web Crypto only in `session.ts`; no `node:crypto` anywhere in `apps/web/src`.
- `postureFor(mode)` is the single source for the Settings card text.
- Comments change in the same commit as the behaviour they describe.
- No new dependencies; no schema migration.

## 8. Errata (post-execution, 2026-09-02)

1. §2.4: the unauthenticated-page 302 carries an **absolute** `Location` built from the request's own `Host` header and an `http|https`-allowlisted `x-forwarded-proto` (each falling back to `nextUrl`), because Next's middleware adapter parses every `Location` through `new NextURL(value)` with no base (a relative value 500s) and `nextUrl`'s host is normalised to `localhost` regardless of `Host`/`X-Forwarded-Host`; consequently, in password mode the redirect's host echoes whatever `Host` the requester sent — an ordinary host-header-redirect exposure that affects only that requester, and a reverse proxy in front must forward the real `Host`.
2. §2.3 rule 3: in password mode the `Origin` fallback compares host parts with the port stripped on both sides, so a page served on a different port of the same hostname reads as same-side when `Sec-Fetch-Site` is absent (browsers without fetch metadata only); browsers with fetch metadata report `same-site` for that case and are refused.
3. §2.3 rule order: the implementation evaluates rule 3 (cross-site refusal) before rule 2 (public-path allow) on `/api/` paths so that `/api/auth/login` is public yet still refused cross-site; outcomes are identical to the listed order.
4. §5 check 5: the SSE route sends no greeting frame — with no `?from` the replay is empty and the first bytes are the 15 s id-only heartbeat — so the gate budgets 25 s for "delivers its first SSE frame" and must not be tightened below the heartbeat interval.
5. §5 check 3: the ≥ 250 ms bound is measured on a **warm** route after one throwaway wrong-password POST, because a cold `next dev` compile of the route alone exceeds 250 ms and would pass the check with the delay deleted.
6. §6: the auth-route tests live at `apps/web/test/auth-routes.test.ts` (unit project — the integration project's setup demands a database) and use **real** timers with a ≥ 290 ms wall-clock assertion, because the route's `setTimeout(300)` is registered only after asynchronous Web Crypto work and so is never reached by a fake clock advanced beforehand.
7. §2.1: "an accidental `-H 0.0.0.0` is inert" overstates M15 §2.4, which promises refusal of browsers and accidents only — a LAN client that forges `Host: localhost` with curl passes the Host rule and the headerless escape hatch in loopback mode, so `web:exposed` without a password is a misconfiguration, not a no-op; the `web:exposed` script therefore refuses to start when `AITEAMOS_PASSWORD` is blank (`scripts/web-exposed.mjs`, exit 2).
8. §3.1: the 300 ms failed-login delay bounds latency per attempt, not throughput — attempts are not serialised, so concurrent connections multiply the guess rate — and the password's entropy is the actual brute-force defence. — closed by M21 B3 (the failure path is a queue).
9. §5/§7: `gate:m15-boundary` run standalone now requires `AITEAMOS_PASSWORD` to be unset in the environment (in password mode its stage 1 receives 302/401 rather than 403); `gate:m20-auth` run A deletes the variable from the child environment for exactly this reason.
10. §2.2: `verifySession` accepts an expiry of 1–12 decimal digits only (the concrete form of "a non-integer expiry → false"), and an empty signature part is rejected before any HMAC work.
