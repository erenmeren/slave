# M17 flake ledger

One section per named flake (spec §2 roster). A section is complete when it has all five
fields filled with measured facts — "it went green on retry" is not a finding.

Template per flake:
- **Evidence** — the recorded failures (from the spec table) plus anything new this wave measured.
- **Mechanism** — the root cause, stated as a sentence about code, with file:line.
- **Change** — what was changed (product fix / test fix / config), with commit hash. A widened
  timeout must show the margin math: observed worst case × headroom factor = new budget.
- **Proof** — the 20× loop command and its result; for flake 6, the gate 3× result.
- **Residue** — anything left open, or "none".

## Flake 1 — sweep.test.ts "counts only the runs it actually failed"

## Flake 2 — cli.test.ts "the daemon enforces the run-timeout guardrail on a hung run"

## Flake 3 — subscribe.test.ts "delivers exactly one notification per event across a reconnect"

## Flake 4 — stream.test.ts delivery tests (:77 and :115)

## Flake 5 — activity-history.test.ts sparkline buckets

## Flake 6 — live-gate Activity hydration
