# Lead-flow interface (step 2) -- progress ledger

Work on `main`, pushed after each finished unit (the operator's instruction: no feature branch, no pull
request). Design: `docs/superpowers/specs/2026-10-05-lead-ux-design.md`. One line per finished unit; every design
ruling as "Ruling: what -- why -- cost if wrong"; what was left undone; the stale gates; the three checks before
each push.

## Environment

- Cloud container, Node 22.22 (the repository asks for >= 26; `npm ci` warns and installs). No Postgres, no
  daemon, no real model CLI. Tests are written and NOT run (the operator's instruction); the three checks run
  before every push are `npm run typecheck`, `npm run web:build` and `npm run gate:m26-vocabulary`.
- Every push is `git push --no-verify origin main` (the pre-push hook runs the whole suite, which must not run
  here).

## Units

- Part 1, the design: `docs/superpowers/specs/2026-10-05-lead-ux-design.md` -- six screens and sign-in, one
  Project screen with no tabs, every CLI-only control placed, the removals listed (spec sections 6, 7, 9).

## Rulings

## Left undone

## Stale gates

## Checks before each push
- Before the spec push (`docs(spec)`): typecheck exit 0 (1 m 43 s); web:build exit 0; vocabulary PASS.
