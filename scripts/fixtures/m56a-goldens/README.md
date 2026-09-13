# M56a goldens

Captured from the tree M56a forks from, BEFORE the first line of the migration was edited, and never
regenerated afterwards — a golden a gate can rewrite is not a golden, and one regenerated mid-migration
records the answer the migration gave rather than the answer it had to reproduce.

`scripts/gate-m56a-provider-contract.mjs` compares against these and cannot write them. The capture was a
one-off script kept out of this repository on purpose, printed in full in
`docs/superpowers/plans/2026-09-13-m56a-provider-contract.md` (Task 1 Step 1); re-running it is a
deliberate act somebody has to reconstruct, not a convenience one keystroke away.

| File | What it holds | Where it came from |
|---|---|---|
| `permissions-<provider>-<runKind>-<grants>.json` (12) | `permissions.json` v2, byte for byte | `writePermissionsFile`, `runId` and `runToken` fixed |
| `argv.json` | `claudeFlags` once, `cursorFlags` four ways | `packages/providers/src/claude/flags.ts`, `cursor/flags.ts` |
| `capabilities.json` | the five members per kind | `capabilitiesOf` |
| `models.json` | Claude's static listing; Cursor's parse of the recorded capture | `listProviderModels`, `parseCursorModels` over `packages/providers/test/fixtures/cursor/models.txt` |
| `tools-by-kind.json`, `enforce-by-provider.json` | the two per-vendor tables | `packages/domain/src/permission/kinds.ts` |
| `settings-cards.json` | the four Settings adapter cards, `slavesBound` excluded | transcribed from `apps/web/src/server/settings.ts`; `apps/web` has no `dist` a gate could import |
| `provider-literal-allowlist.json`, `run-files-allowlist.json` | what the gate's two greps may match | written in Task 6 |
| `hook-plane-sha256.json` | the sha256 of the five hook-plane scripts | `createHash('sha256')` over the files as they stand, which is byte for byte as they stand on `main` (`cff28066`) |

Twenty-one files and this README, twenty-two entries in all (`ls scripts/fixtures/m56a-goldens | wc -l`).

`hook-plane-sha256.json` is the one golden captured during the milestone rather than before it, and it
records a NON-change: `scripts/pause-gate.sh`, `scripts/cursor-shell-gate.sh`, `scripts/tool-result-tap.sh`,
`scripts/lib/pause-flag.sh` and `scripts/lib/permissions.sh` are byte-identical to `main` (`cff28066`), the
tree M56a forked from, and the digests here were taken from those identical files. Stage 12 compares each
script's on-disk digest against this file; it used to compare against `git show HEAD:`, which only ever
caught an uncommitted edit and would have passed a hook-plane script edited and committed inside the
milestone.
