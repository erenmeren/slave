# M22 — Polish: the Minor findings M21's reviews left

**Status:** Approved (operator, 2026-09-02: "tamam m22'ye geç" after the list and the lean process were presented)
**Approach:** lean — three batched tasks of same-shape edits, one task review each, final review on a mid-tier model, NO new gate (the proof is `gate:m21-loose-ends` re-run plus the full suite). Zero spend, no dependencies, no migration.

## 1. Why

M21 closed every functional loose end; its reviews left a dozen Minor items (comment accuracy, test depth, a census that greps one spelling, a stub that installs its handler after printing). M22 closes them so the next milestone can be a feature, not a broom.

**Non-goals:** anything not on the list below; new behaviour; new gates.

## 2. Series A — scripts (one task)

- A1 `scripts/gate-m21-loose-ends.mjs` check 1: a spawner is recognised by a regex accepting either quote style AND the bare binary path — `/['"]dev['"],\s*['"]apps\/web['"]|node_modules\/next\/dist\/bin\/next/` — and the header comment states the census's limits (per-file: a second spawn in a file that already calls `loopbackChildEnv(` once is invisible; only top-level `scripts/*.mjs` is scanned). `>= 11` stays.
- A2 `runChildGate` and check 4 assert `child.error === undefined` before reading status (`<label>: could not start: <message>`), so an ENOENT reads as "did not run", not "exited null".
- A3 `scripts/gate-m19-measure-and-harden.mjs` check 2 keys the trailing Stop hook on `hook_event === 'Stop'` (the invariant's owner, `fake-claude.test.ts:94`), not `hook_name`.
- A4 `apps/web/test/web-exposed.test.ts`: the stub installs its SIGTERM handler BEFORE printing its argv, so the "printed, therefore ready" comment is literally true; one new row — `STUB_SELF_KILL=1` makes the stub `process.kill(process.pid, 'SIGKILL')` after printing → the parent exits 137 (the `128 + signo` line gets an automated row).
- A5 `scripts/lib/child-env.mjs` JSDoc: one clause — the blank is unconditional, an `extra.AITEAMOS_PASSWORD` is overridden too.

## 3. Series B — web (one task)

- B1 `README.md` "Reaching it from another device": the lead sentence becomes `Pick a long random password.` so `openssl rand -base64 24` appears once.
- B2 `apps/web/src/app/api/auth/login/route.ts`: one comment sentence after the queue docstring — the queue does not drain on client abort; N aborted wrong guesses still delay the next failure by N×300 ms; successes are never queued.
- B3 `apps/web/src/lib/boundary.ts`: every `default` arm reads `return assertNever(…)` (one style).
- B4 `apps/web/test/boundary.test.ts`: a password-mode row for an unparsable Origin (`'null'` and `'not a url'`, with a session) → refused with the cross-origin reason.

## 4. Series C — orchestrator / providers (one task)

- C1 `apps/orchestrator/src/pump.ts` resume seed: one comment sentence saying the throw on an unparseable `run.tool_denied` row is deliberate (a corrupt row means the write gate was bypassed — the same rule `packages/events/src/read.ts` applies; loud beats a run that silently forgets a confirmed deny).
- C2 `pump.ts` `hookBindings` docstring: "bounded by the run's tool-call count" → "bounded by twice the run's gated tool-call count (two PreToolUse hooks start per call)".
- C3 `packages/providers/test/gate.test.ts`: three pins on `classifyGateEvent` — a matrix `hook_denied` with `hookId` → `tool_denied` carries it; without → the key is absent (`'hookId' in outcome === false`); a pause `hook_denied` (no matrix prefix) with `hookId` → `stopped_by_gate` never carries it.

## 5. Proof

`npm run gate:m21-loose-ends` once after Series A (its check 4 runs the changed web-exposed test; check 1 runs the new regex) and once at the end; `npm test` at the end. Standing rules bind (one vitest run at a time; no daemon; `web:build` for the `apps/web` task, never beside a dev server; `rm -rf apps/web/.next` before any `next dev` — it holds a production build; explicit `git add` paths).
