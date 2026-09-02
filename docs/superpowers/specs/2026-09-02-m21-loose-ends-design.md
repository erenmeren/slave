# M21 — Loose Ends: everything M19 and M20 left on the table

**Status:** Approved in advance (operator, 2026-09-02: "hepsini M21'de bitir" — all remaining items, design decisions delegated; each decision is named below and in the plan's rulings)
**Approach:** one milestone, four series, every item small, none skipped. Zero spend.

## 1. Why this milestone

M20 merged with a clean final review and a list of thirteen deferred items, five of them inherited
from M19. Each is small; together they are a milestone's worth of unfinished edges — one of which
(the gates inheriting `AITEAMOS_PASSWORD`) became a real breakage the moment the operator set a
password. M21 closes all of them and adds nothing new.

**Non-goals:** any new feature; TLS; accounts; changing M20's security model; touching the
Cursor adapter; the plan file's historical text (plans are records, not live docs).

## 2. Series A — the gates survive a configured password

### A1 `scripts/lib/child-env.mjs` (new) and every `next dev` spawner

The operator now has `AITEAMOS_PASSWORD` in `.env`. Every gate that boots `next dev` inherits it
(measured: m11, m13, m14, m15, m16, m18, m19 spawn with `process.env` or a spread of it; the two
`measure-*` scripts omit `env` and inherit by default) and so lands on `/login` instead of the
page it meant to drive. Fix, one helper:

```js
// scripts/lib/child-env.mjs
/** The environment a gate's child `next dev` gets: the parent's, minus the operator's password.
 *  Gates drive the loopback-only app; a configured password would put every one of them behind
 *  /login (M21 spec §2). Extra keys win over the parent's. */
export function loopbackChildEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.AITEAMOS_PASSWORD
  return env
}
```

Every script that spawns `next dev` imports it and passes `env: loopbackChildEnv()` (or
`loopbackChildEnv({ AITEAMOS_GATE_WARM: '1' })` where the script set that key). The list, verbatim:
`gate-m11-shell.mjs`, `gate-m13-runtime.mjs`, `gate-m14-fidelity.mjs`, `gate-m15-boundary.mjs`,
`gate-m16-chrome.mjs`, `gate-m18-skill-and-teeth.mjs`, `gate-m19-measure-and-harden.mjs`,
`measure-activity-latency.mjs`, `measure-graph-status-latency.mjs`. `gate-m20-auth.mjs` keeps its
own two env constructions (run A deletes the variable for the M15 child; run B sets a random one)
— they are the point of that gate. `web-exposed.mjs` keeps inheriting (it needs the password).

M20's "gate-m15-boundary.mjs unmodified" proof was a one-milestone requirement; M20 is merged, so
the M15 gate may change. M20's run A still deletes the variable and still passes.

### A2 README gate table

Add the missing `gate:m19-measure-and-harden` row (M19 never wrote one), between m18 and m20:
"The M19 gate: a typed build that bites, a real capture, cables that measure, and a ledger that
adds up — a typecheck bite-probe, the real matrix-deny fixture's provenance, two cables of
different `stroke-width` on a live page, the C5 equivalence suite, the C1 partial index in the
dev database, and the spend ledger summing under its cap. **Spends nothing** — it reads M19's
recorded evidence instead of re-spending; needs the dev database and a real browser
(`playwright-core` + `CHROMIUM_PATH`), refuses under a running orchestrator daemon." Also drop the
"requires `AITEAMOS_PASSWORD` unset" clause from the m15 row — A1 makes it untrue.

### A3 `gate-m20-auth.mjs` diagnosability and one negative control

- Run A: `spawnSync` instead of `execFileSync`; print the child's stdout (prefixed `[m15] `)
  BEFORE asserting `status === 0` and the PASS line, so a failing M15 stage is named.
- Stage 2 gains: `GET /api/w/<W>/events` with no cookie and `Accept: text/event-stream` → 401
  before any frame (the SSE route is behind the same rule; prove it).
- Stage 3 gains the throughput probe for B3: two wrong-password POSTs fired concurrently on the
  warm route → both 401, and the later of the two completes ≥ 550 ms after the pair was fired
  (serialised: 300 + 300, minus the same ~50 ms slack stage 3 already allows).

## 3. Series B — the boundary and the login route

### B1 Origin compared with its port in password mode (`apps/web/src/lib/boundary.ts`)

Password mode's Origin fallback (rule 3, browsers without fetch metadata) currently strips the
port from both sides, so `http://box:8080` reads as same-side to a request with `Host: box:3000`
(M20 Errata 2). New rule, password mode only: `new URL(origin).host` (the WHATWG host — lowercase,
default port dropped) must equal the request's `Host` header value lowercased, verbatim otherwise.
`Host: box:3000` ↔ `Origin: http://box:3000` passes; `Origin: http://box:8080` is refused;
`Host: box:80` ↔ `Origin: http://box` is refused (URL drops the default port, the header kept it —
fail-closed on a shape no browser produces). Loopback mode is untouched: allowlist compare, port
ignored, `localhost` ↔ `127.0.0.1` allowed. Reason string unchanged. The M20 test row asserting
`8080` passes flips to refused; a `Host`-case row (`Box.Tail:3000` ↔ `http://box.tail:3000`) is
added and passes.

### B2 Exhaustive mode dispatch (`boundary.ts`)

Rule 1, rule 4 and `postureFor` dispatch on `mode` positively today with an allow fall-through
(M20 minor 7). Rewrite each as a `switch (mode)` over both members with a `default` that
`assertNever(mode)` — a compile-time error when `BoundaryMode` grows, and a thrown error at
runtime rather than an open door. Verdicts for both existing modes are unchanged; every
boundary test row stays green byte for byte. `assertNever` lives in `apps/web/src/lib/assertNever.ts`
(`(value: never): never` throwing `unreachable: ${String(value)}`); it is the repo's first, so the
file is new.

### B3 The failed-login path is serialised (`apps/web/src/app/api/auth/login/route.ts`)

The 300 ms delay bounds latency per attempt, not throughput (M20 Errata 8). Make it a queue: a
module-level `let failureGate: Promise<void> = Promise.resolve()`; on a wrong password,
`failureGate = failureGate.then(() => delay(FAILED_LOGIN_DELAY_MS))`, `await failureGate`, then
respond. N concurrent wrong guesses complete at 300, 600, … N×300 ms. Successes never touch the
queue. The route comment says what this bounds (one process's guess rate to ~3.3/s) and what it
does not (a distributed attacker; the password's entropy remains the defence, README already says
so). Test: two concurrent wrong-password POSTs — the second resolves ≥ 590 ms after start, the
first ≥ 290 ms; a right-password POST fired alongside them resolves in < 250 ms.

## 4. Series C — the evidence chain (M19's carry-overs)

### C1 `hook_id` pairing (`packages/providers/src/claude/stream.ts`, `apps/orchestrator/src/pump.ts`)

The real capture (`permission-matrix-deny.ndjson`, fixture README "out of order") shows what the
stream carries: every `hook_started` and `hook_response` line has a `hook_id`; a `hook_started`
carries NO `tool_use_id`; two `PreToolUse:<Tool>` hooks start per tool call, and their responses
can arrive out of order (line 24 answers line 15 after an unrelated Bash deny). Today the pump
associates a deny with "the last `tool_call` seen, if its name matches" (M19 B2) — right in that
recording by luck, and over-failing when a deny's response lands after a differently named call.

Change, in two halves:
- Parser: `hook_started` lines whose `hook_event` is `PreToolUse` become
  `{ kind: 'hook_started', hookId: string, hookName: string }` (a new `RuntimeEvent` member; other
  subtypes stay `ignored`); `hook_denied` gains `hookId: string | null` (`null` when the line lacks
  one — older captures). `hookResponseSchema` gains `hook_id: z.string().optional()`.
- Pump: a per-run `Map<hookId, { toolUseId, toolName }>`. On `hook_started` for `PreToolUse:<T>`,
  bind `hookId → lastToolUse` iff `lastToolUse.name === T`, else bind nothing. On `tool_denied`,
  `associated = hookId !== null ? (map.get(hookId)?.toolUseId ?? null) : <today's B2 rule>`. The
  binding happens at hook START — immediately after the tool_use it serves, before any later
  tool_call — so the out-of-order RESPONSE the capture recorded no longer matters, and the B2
  over-fail (deny response after a differently named call) is closed. Map entries are deleted
  when consumed.

**Known limit, stated:** parallel same-named `tool_use` blocks inside one assistant message start
their hooks after the whole message is emitted, so both bind to the last block; a deny for the
first would be attributed to the second. Unfixable without a `tool_use_id` on `hook_started`,
which the stream does not carry (measured). The pump comment names this as the residual limit,
replacing the "out of scope" paragraph.

Tests: parser fixture test — line 22's deny carries `hookId` `ccfca4a2-…`, lines 14/15 yield two
`hook_started` events with distinct ids and the same name; pump test — a deny whose hook_response
arrives after a differently named later `tool_call` (the B2 over-fail shape) now associates the
correct id and the run survives; the existing B2 mismatch test keeps passing (deny with no
`hook_started` binding and a name mismatch → `null`).

### C2 Typed `toolUseId` (`packages/domain/src/events/schema.ts`)

`run.tool_denied`'s payload schema gains `toolUseId: z.string().nullable().optional()` — pre-B1
rows lack it, B1+ rows carry `string | null`. `pump.ts`'s B1 resume seed (`findMany` + hand cast
on the raw column) is rewritten to read through the typed path (`@ai-team-os/events`' reader
filtered to `run.tool_denied`) and use the typed field. The Activity card for `run.tool_denied`
(M18) is unchanged (it reads `tool`/`capability`). Test: a round trip through `parseExecutionEvent`
preserves `toolUseId` (string and null) and tolerates its absence.

### C3 B1 negative controls (`apps/orchestrator/test/integration/pump.test.ts`)

Two tests beside the existing B1 test, same helpers (`ids`, `fromArray`, `okOutcome`,
`appendEvent`, `eventTypesFor`):
1. non-resumed, no seed: a prior `run.tool_denied` event exists for the run with
   `toolUseId: 'toolu_old_matrix'`, the pump runs with `resumed` absent, the terminal outcome
   echoes `deniedToolUseIds: ['toolu_old_matrix']` → the run FAILS (the seed applies only on
   resume).
2. resumed, genuine denial still fails: prior event seeds `toolu_old_matrix`; the terminal outcome
   echoes `['toolu_old_matrix', 'toolu_new_real']` → the run FAILS and the failure names
   `toolu_new_real` only (the seed is not an amnesty).

### C4 `widthFor` guard (`apps/web/src/components/graph/CableEdge.tsx`)

`if (weight === undefined || !Number.isFinite(weight)) return active ? '1.4' : '3'`. Tests: `NaN`,
`Infinity`, `-Infinity` each render the default width; a negative finite weight clamps to the
minimum (already true; pinned).

### C5 Gate check 2 EOF scan (`scripts/gate-m19-measure-and-harden.mjs`)

The item's name was shorthand; the loop it names must keep its per-line error (a one-liner would
lose the line number). What the check lacks is an end-of-file assertion: add, after the parse
loop, that the LAST non-blank line is the `result` line and that the file ends with exactly one
`\n` — a truncated or re-appended capture fails here with a message naming the offending tail.
Two lines, not one; the backlog's "one-liner" is recorded as an estimate that was wrong.

## 5. Series D — `web-exposed.mjs` pass-through, tested

`scripts/web-exposed.mjs` resolves the binary from `process.env.AITEAMOS_NEXT_BIN ??
'node_modules/next/dist/bin/next'` (the house `AITEAMOS_*_BIN` override pattern; a comment says it
exists for the test and is not documented for operators) and maps a signal death to
`128 + os.constants.signals[signal]` (SIGKILL → 137, not 143). Test
`apps/web/test/web-exposed.test.ts` (unit project, node env) writes a stub "next" to a temp dir
that prints `process.argv.slice(2)` as JSON and then either exits with the code in
`STUB_EXIT`, or (when `STUB_WAIT=1`) waits for SIGTERM and exits 0. It spawns
`node scripts/web-exposed.mjs` and asserts: blank/whitespace/unset password → exit 2, the
refusal line on stderr, the stub never ran; with a password → the stub received exactly
`['dev', 'apps/web', '-H', '0.0.0.0']`; `STUB_EXIT=7` → parent exit 7; `STUB_WAIT=1` then SIGTERM
to the parent → the stub receives SIGTERM (it exits 0 on it) and the parent exits 0. No real
`next` runs in the test.

## 6. Gate — `npm run gate:m21-loose-ends`

Zero spend, CI-runnable, ~1.5 minutes. `scripts/gate-m21-loose-ends.mjs`:

1. **Census:** every script under `scripts/` that spawns `next dev` (grep `'dev', 'apps/web'`)
   imports `loopbackChildEnv` from `./lib/child-env.mjs`, except `gate-m20-auth.mjs` and
   `web-exposed.mjs` (named exceptions, asserted present).
2. **The M15 gate under a configured password:** with `AITEAMOS_PASSWORD` SET to a random value
   in the child environment, `scripts/gate-m15-boundary.mjs` PASSes (its exact PASS line) — the
   proof that A1 works where it matters.
3. **The M20 gate under a configured password:** same environment, `scripts/gate-m20-auth.mjs`
   PASSes — which also runs A3's new stage-2 SSE 401 and stage-3 throughput probe.
4. **Unit-level proofs as a child vitest run:** `npx vitest run` on exactly these files:
   `apps/web/test/boundary.test.ts`, `apps/web/test/auth-routes.test.ts`,
   `apps/web/test/web-exposed.test.ts`, `apps/web/test/graph-skill.test.tsx`,
   `packages/providers/test/stream.test.ts`, `packages/domain/test/events/schema.test.ts` — green.

PASS line: `PASS: no loose ends — the gates survive a password, the door serialises its refusals,
the evidence chain is typed and paired`. Registered as `gate:m21-loose-ends`; README row says zero
spend.

## 7. Testing summary and standing rules

- Unit: boundary rows (B1 flip + case row, B2 unchanged verdicts), auth-routes concurrency (B3),
  web-exposed (D), CableEdge (C4), parser fixture (C1), domain schema round trip (C2).
- Integration: pump C1 association test, C3's two negative controls.
- Gates: m21 (new), m20 (extended), m15/m20 re-run under a password by m21.
- Standing rules bind: one vitest run at a time; no daemon during tests; `web:build` gates every
  `apps/web` task and never runs beside a dev server; trace every new field to its consumer
  (`hookId` → pump map; `toolUseId` typed → pump seed; `AITEAMOS_NEXT_BIN` → test); `git add`
  explicit paths; comments change with behaviour.

## 8. Global constraints

- No new dependencies, no migration, zero spend.
- Loopback-mode boundary verdicts and reason strings unchanged (M15 byte for byte still holds).
- `AITEAMOS_PASSWORD` is read in exactly one production file (`authEnv.ts`); the gates DELETE it
  from child environments through one helper; nothing else reads it.
- M20's Errata 2 (port-stripped Origin) and Errata 8 (delay bounds latency) are marked
  "closed by M21 B1/B3" in the M20 spec in the same commit as the code.

## 9. Errata (post-execution, 2026-09-02)

1. §2 A1: `loopbackChildEnv` sets `AITEAMOS_PASSWORD` to `''` rather than deleting it, because the two `measure-*` scripts pass `--env-file=.env` to their child and Node's env-file loader repopulates an absent key but never overrides a present one (verified on Node 26.7); blank is loopback mode under `authEnv`'s trim rule.
2. §8: "the gates DELETE it from child environments" reads "the gates BLANK it", per Erratum 1.
3. §4 C5: the capture's last parsed line is the routine `Stop` `hook_response` and the `result` line is second-to-last (fixture README redaction rule 4, `fake-claude.test.ts`), so check 2 asserts that order plus exactly one trailing `\n`; the plan's "last line is the result line" was wrong.
4. §4 C1: `hook_denied.hookId` is `string | undefined` (key absent when the line carried no `hook_id`), not `string | null`, so existing event literals compile under `exactOptionalPropertyTypes`; `GateOutcome.tool_denied.hookId` is threaded through `classifyGateEvent` the same way; and a bound hook whose deny reason names a different tool resolves to `null` (final-review tightening).
5. §4 C2: the resume seed reads `prisma.executionEvent.findMany({ where: { runId, type: 'run_tool_denied' } })` through `@ai-team-os/db`'s `toExecutionEvent` mapper (already exported), not through `@ai-team-os/events`' reader, which is not run-filterable.
6. §6 check 1: the census excludes `gate-m21-loose-ends.mjs` itself (its search strings self-match) and asserts `>= 11` spawners over top-level `scripts/*.mjs`; it is a per-file string census, not a per-spawn-site one.
7. §6 check 4 / §2 A3: both child invocations are `spawnSync` with stdout printed before `status` and the PASS / `Test Files 6 passed` assertions, so a failing child is quoted, not swallowed.
8. §3 B3: the README paragraph on the 300 ms delay is rewritten in the same change (it stated the non-serialisation B3 closes).
9. §8: M20 Errata 9 (the M15 gate requires the variable unset) is also closed by M21 A1 and marked so.
