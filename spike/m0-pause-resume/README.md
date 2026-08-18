# M0 Spike — Pause / Resume

Throwaway investigation. The findings document survives into M3 as evidence
(`docs/superpowers/spikes/2026-08-17-m0-pause-resume-findings.md`). `pause-gate.sh` also survived,
in the sense the README originally meant: it graduated. M3 Task 7 ported it to
`scripts/pause-gate.sh` and gave it a real JSON encoder (ADR 0001 section 7,
`docs/decisions/0001-pause-semantics.md`), and that is now the only copy -- this directory no
longer contains one, so there is nothing here that can drift out of sync with it.

## Re-running

    export SPIKE_REPO="$HOME/.aiteamos-spike/sample-repo"

Then follow the tasks in `docs/superpowers/plans/2026-08-17-m0-m1-foundation.md`, Part 1.
