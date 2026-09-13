# M56a — Provider contract

Thirteenth and last milestone of the roadmap `2026-09-10-roadmap-m44-m56.md` (row M56, line 48), and
the FIRST of the three sub-milestones the controller carved that row into: **M56a** is the capability
contract plus the two shipped providers migrated onto it with no behaviour change and every gate
green; **M56b** is the Codex CLI and **M56c** the Gemini CLI, each a spec of its own, each written
only once its binary is installed on the operator's machine and measurable (`which codex` and
`which gemini` both answer `not found` today — session scratchpad `m56-explore.md` §5). It extends
M12's adapter seam (`SlaveRuntimeAdapter`, `buildRegistry`, `capabilitiesOf`), M13's proving
methodology (Series C: two runs in a fresh worktree, outcome branches written in advance), ADR 0001's
pause ladder, M18/M52's permission matrix (`TOOLS_BY_KIND`, `ENFORCE_BY_PROVIDER`, `permissions.json`
v2), M51's usage provenance and M52's broker channel — named as extensions, per roadmap lines 19-23.
Designed 2026-09-13 from an inventory of the adapter interface and both implementations, every site
in the tree that switches on a `ProviderKind`, the five places the differences between the two
providers are written down today, the two measurement gates that spend real money, and the CI
safety net that guards only one of the two binaries (session scratchpad `m56-explore.md`, 699 lines).
Every **Ruling** took the controller's direction under the user's standing approval; where the
repository forces a different shape the ruling carries an inline `*(verified: …)*` note. This spec
adds one section the house shape does not have — **§4, the third-provider checklist** — because the
milestone's whole claim is a count, and a count belongs in a table somebody can re-run. "Slave" is
this project's word for an AI worker.

**Goal.** Adding a third runtime to this product stops being an archaeology exercise. Today the two
providers it has are described in five unconnected places — a TypeScript interface, a switch, an ADR,
a constant in a different package, and several hundred lines of "measured, not assumed" comments —
and a third one has to be threaded through twenty-six separate edits in six packages, most of which
fail silently rather than loudly when they are missed. After this milestone there is ONE typed,
exhaustive manifest per provider that says what that provider can do, on ten named axes, as DATA;
every table that used to hold a second copy of one of those facts derives from it; and the tree
refuses, at build time and at gate time, to grow a second copy. Nothing a provider does changes — not one flag, not one verdict
byte, not one event, not one rung of the pause ladder — and the proof that nothing changed is the
point of the milestone, which is why the gate is mostly golden files.

**Facts the design stands on.** `SlaveRuntimeAdapter` is declared in
`packages/providers/src/claude/adapter.ts:144-155` and `:162-200` — two declaration-merged blocks, in
the CLAUDE provider's own directory, and `packages/providers/src/cursor/adapter.ts:12` imports the
type from `../claude/adapter.js`; nothing about the interface is Claude-specific. `ProviderCapabilities`
(`claude/adapter.ts:32-51`) has five members and its docstring's rule is "a capability nothing reads
is a claim nothing checks, so it does not exist here"; `gate: 'shell-only'` and `gate: 'none'` are
typed and UNREACHED — both rows answer `'all-tools'` (`capabilities.ts:46,90`) and
`ShellOnlyMark.tsx:19` renders for a value no provider returns. `capabilitiesOf`
(`capabilities.ts:23-40`) is a switch with a `const unhandled: never` guard and two frozen rows, and
the widen-never-narrow rule is stated at `:81-85`. `ProviderKind` is a plain union at
`packages/providers/src/types.ts:11` with `PROVIDER_KINDS` + `_ProviderKindsComplete` at `:31-37`,
and the SAME union is spelled independently **four more times**: `PERMISSION_PROVIDERS`
(`packages/domain/src/permission/kinds.ts:40`, because domain may not depend on a package that
imports `node:child_process` at module scope), `PROVIDER_KINDS` in `apps/web/src/lib/providerLabel.ts:22-24`
(a second guarded copy, because a VALUE import of the providers barrel would drag both adapters into
a client bundle), the bare `'claude_code' | 'cursor'` in `packages/control/src/simulation/adopt.ts:36,133`
and `shared.ts:24`, and `z.enum(['claude_code','cursor'])` at `apps/web/src/app/api/sim/route.ts:25`.
`packages/providers` already depends on `@slave-of-ai/domain` (its `package.json`), `packages/domain`
depends on nothing but `zod`, and `apps/web` depends on `@slave-of-ai/domain` directly — so the
domain is the one package every consumer of a provider fact can reach. `buildRegistry`
(`registry.ts:89-108`) takes a FIXED two-named-field object (`{claudeCode?, cursor?}`), not a map,
and `admitAdapter` (`:57-61`) refuses an adapter with neither pause capability; `buildAdapterRegistry`
(`apps/orchestrator/src/cli.ts:890-923`) is the ONE call site and wires both kinds unconditionally,
reading `SLAVEOFAI_CLAUDE_BIN`/`SLAVEOFAI_CURSOR_BIN`/`SLAVEOFAI_CURSOR_ARGS` and four script paths.
`RunHandle.runFiles` (`claude/adapter.ts:110-123`) is a frozen `{settingsPath, hookPath}` pair named
after the `Checkpoint` columns, which are NOT NULL (`schema.prisma:1224-1225`); Cursor reuses the pair
for two files that are not a settings file and not a hook (`cursor/adapter.ts:196`). `signalPause`
(`pause-signal.ts:44-48`) **already dispatches on a capability rather than on a kind**, and its
docstring says why — "this used to be a `switch (kind)`… which made the capability table a claim
nothing checked". `TOOLS_BY_KIND` (`kinds.ts:111-163`) holds each provider's tool vocabulary per
permission kind (Cursor's is exactly `read`, `edit`, `shell`), `TOOL_VOCABULARY` (`:78-86`) derives
from it, and `ENFORCE_BY_PROVIDER` (`:149-152`) holds the separate enforcement-fidelity axis
(`claude_code: 'all-tools'`, `cursor: 'known-tools'`); `writePermissionsFile`
(`packages/control/src/permission.ts:56-91`) writes all three into `permissions.json` v2.
`fakeCliRefusal` (`apps/orchestrator/src/require-fake-cli.ts:34-42`) reads **only**
`SLAVEOFAI_CLAUDE_BIN`, and `.github/workflows/ci.yml:38-42` sets only that variable job-wide — a CI
job that dispatched a Cursor run would spawn the real `cursor-agent`. `gate:m12-providers` and
`gate:m13-runtime` spawn the REAL paid binaries and are in neither `package.json`'s CI list nor
`.github/workflows/ci.yml`. `docs/decisions/0001-pause-semantics.md:316-337` holds the three-rung
degradation ladder, written as behaviour and never as data. `apps/web/src/components/SlavePanel.tsx:8,97-101`
reads `TOOLS_BY_KIND` and `PERMISSION_PROVIDERS` **in a client component** — the domain's per-vendor
tables already reach a browser bundle, and the providers package never can. `parseDecisionAnswer`
(`packages/domain/src/supervisor/prompt.ts:125-142`) scrapes the FIRST JSON object out of narration
text — **the only structured-output mechanism in the tree**, and `grep -r structuredOutput` finds
nothing anywhere. `pricing.ts:51-58` prices six Claude ids and zero Cursor ones. The installed
binaries at design time are `claude 2.1.270` and `cursor-agent 2026.08.25-3e8eec8`, against
`process.ts:135-138`'s `CHILD_ENV_ALLOW` measurement on `claude 2.1.269`, one patch back. The gate roster ends at `gate:m55-catalog` with 30 gates
after M55, in four places: `README.md`'s `npm run gate:*` roster paragraph and its count sentence,
`package.json`'s script list, and `.github/workflows/ci.yml`'s gates job (M55 moves all four, so the
line numbers are read at execution time and not pinned here).

## 1. Rulings

- **R1 — The contract moves to a provider-neutral home and is re-exported from the old one, so not
  one import changes.** `packages/providers/src/contract/adapter.ts` becomes the declaring file for
  `SlaveRuntimeAdapter`, `ProviderCapabilities`, `StartRunInput`, `RunHandle` and `RunFiles` (R7), and
  `claude/adapter.ts` keeps `export type { … } from '../contract/adapter.js'` at the top — so
  `registry.ts:1`, `cursor/adapter.ts:12`, `capabilities.ts:1`, `index.ts:21` and every
  `@slave-of-ai/control` re-export resolve to the same symbols by the same paths they use today. **The two declaration-merged blocks become one interface declaration.** The merge's stated reason was
  diff legibility across M3's tasks (`adapter.ts:128-132,157-160`); that history is three milestones
  old, and a contract nobody can read in one screen is the thing this milestone exists to fix. The
  declaring file keeps both docstrings verbatim, including the paragraph about `requestPause`/
  `awaitPause` being gone — that paragraph is why a reader does not go looking for a pause method. `SlaveRuntimeAdapter.id: string` becomes `readonly kind: ProviderKind`. *(verified:
  `id` has no production reader anywhere — `grep` finds `adapter.id` only at
  `packages/providers/test/cursor-adapter.test.ts:175`, plus two comments at
  `packages/control/src/index.ts:18` and `apps/web/src/server/overview.ts:765` that exist only to warn
  about its spelling. `ClaudeCodeAdapter.id` is `'claude-code'` (`adapter.ts:301`), HYPHENATED, while
  the enum member is `claude_code` — the wrinkle both comments exist to warn about. `CursorAdapter.id`
  is already `'cursor'` (`:127`), equal to its kind, so the test line is unchanged and the only value
  that moves is one nothing reads.)* What this deliberately does
  NOT do: it adds no method to the interface, removes none, changes no signature but `runFiles`'s
  type (R7), and does not rename the interface.

- **R2 — `ProviderKind` has exactly one definition, and it is the DOMAIN's.**
  `packages/domain/src/provider/kind.ts` declares `ProviderKind`, `PROVIDER_KINDS` and the
  `_ProviderKindsComplete` guard, verbatim from `packages/providers/src/types.ts:11-37` including its
  docstrings. `packages/providers/src/types.ts` becomes `export { PROVIDER_KINDS, type ProviderKind }
  from '@slave-of-ai/domain'`; `packages/domain/src/permission/kinds.ts` makes
  `PermissionProvider = ProviderKind` and `PERMISSION_PROVIDERS = PROVIDER_KINDS` (both names kept as
  aliases, so `packages/db/test/integration/enum-parity.test.ts:148-149`, `writePermissionsFile` and
  every other importer compile untouched); `apps/web/src/lib/providerLabel.ts` imports the list
  instead of re-spelling it; `simulation/adopt.ts`/`shared.ts` and `api/sim/route.ts`'s
  `z.enum(PROVIDER_KINDS)` do the same. *(verified: the domain and NOT the providers package, which is
  where the controller's ruling allowed the dependency direction to decide. `packages/domain` imports
  nothing but `zod`; `packages/providers` already lists `@slave-of-ai/domain` as a dependency; and
  `apps/web`'s client bundle imports `@slave-of-ai/domain` directly — `SlavePanel.tsx:8,97-101` already
  reads `TOOLS_BY_KIND` and `PERMISSION_PROVIDERS` from it in a client component — which
  `packages/providers` can never be. `providerLabel.ts:41-43` argues the opposite today — "NOT in `packages/domain`: the
  provider vocabulary belongs to `@slave-of-ai/providers`… inventing a second home for it in the
  domain would put the union in three places instead of two" — and that sentence is answered rather
  than contradicted: the union is in FIVE places today, and this ruling MOVES it rather than copying
  it, which is the case that docstring never considered.)* The Postgres `enum ProviderKind`
  (`schema.prisma:632-635`) stays exactly as it is and stays pinned by the enum-parity test. What this
  deliberately does NOT do: it does not move `RuntimeEvent`, `RunOutcome` or any other providers-package
  type into the domain — only the union that five packages independently need to enumerate.

- **R3 — One typed, exhaustive manifest per provider, holding the ten axes the roadmap names and the
  four the repository forces (`kind`, `toolVocabulary`, `runFiles`, `measured`), as DATA.** `packages/domain/src/provider/manifest.ts` declares
  `ProviderCapabilityManifest` and the total `PROVIDER_MANIFESTS: Record<ProviderKind,
  ProviderCapabilityManifest>` (a third kind is a BUILD failure here first) with `manifestFor(kind)`
  as the reader; `provider/claude-code.ts` and `provider/cursor.ts` hold one manifest each. The
  fields, each a separately-measured axis in today's code and none invented: **`kind`**; **`invocation`** `{ binary, binEnvVar, argsEnvVar, headlessFlags, promptDelivery:
  'flag' | 'positional', neverPass, cwd: 'worktree', envAllowlist: 'CHILD_ENV_ALLOW' }`;
  **`modelDiscovery`** `{ mode: 'listed' | 'configured' | 'none', argv?, options? }`;
  **`resume`** `{ mode: 'session_id' | 'none', flag, neverPass }`; **`pause`** `{ rung: 'hook' |
  'signal' | 'none', adr }`; **`events`** `{ transport: 'stream_json' | 'line_json' | 'text',
  produces: readonly RuntimeEventKind[] }`; **`structuredOutput`** `'native' | 'prompted' | 'none'`;
  **`toolRestrictions`** `{ mechanism: 'hook_gate' | 'flag_allowlist' | 'none', enforce: 'all-tools' |
  'known-tools' }`; **`toolVocabulary`** `Readonly<Record<PermissionKind, readonly string[]>>` (R5);
  **`usageCost`** `'reported' | 'estimated' | 'unmeasured'`; **`hooks`** `readonly ('pre_tool_use' |
  'post_tool_use' | 'before_shell_execution')[]` with `[]` meaning none; **`runFiles`** (R7);
  **`measured`** `{ version, date }`; **`differences`** `readonly string[]`. The two rows: Claude Code is `binary 'claude'`, `promptDelivery 'flag'`,
  `headlessFlags` exactly `claudeFlags`'s constant half, `neverPass ['--no-session-persistence',
  '--fork-session']`, `modelDiscovery 'configured'` with `CLAUDE_CODE_MODELS`, `resume 'session_id'`
  on `--resume`, `pause.rung 'hook'`, `events.transport 'stream_json'` producing eleven semantic
  kinds, `structuredOutput 'prompted'`, `toolRestrictions { 'hook_gate', 'all-tools' }`,
  `usageCost 'reported'`, `hooks ['pre_tool_use','post_tool_use']`. Cursor is `binary 'cursor-agent'`,
  `promptDelivery 'positional'`, `headlessFlags` exactly `cursorFlags`'s constant half,
  `neverPass ['-w','--worktree','--stream-partial-output','--yolo','--plan','--mode']`,
  `modelDiscovery 'listed'` with `argv ['models']`, `resume 'session_id'` on `--resume` with the
  never-bare rule in `differences`, `pause.rung 'signal'`, `events.transport 'stream_json'` producing
  six, `structuredOutput 'prompted'`, `toolRestrictions { 'hook_gate', 'known-tools' }`,
  `usageCost 'unmeasured'`, `hooks ['pre_tool_use','before_shell_execution']`. **`differences` is
  where the prose goes**: every "measured, not assumed" caveat that today lives only as a comment —
  Cursor's silent-`--trust` failure, the load-bearing matcher-less registration, the derived
  `numTurns`, the `result.error`-is-not-a-denial rule, the stream-quiesce drain, Claude's absolute
  `--settings` requirement, the unpriced `default` sentinel, "only a shell call and an edit call were
  measured; no MCP or subagent tool call was exercised" — becomes a sentence in this array, and the
  comment at its old site keeps a one-line pointer to it. What this deliberately does NOT do: the
  manifest holds no path, no secret and no per-run value (it names a binary, it does not hold one, and
  a client bundle importing it gets strings); it adds no axis nothing reads — every one of the
  fourteen fields has a consumer named in R4, R5, R6, R7 or R10; and it does not become a file on
  disk (see §5).

- **R4 — `capabilitiesOf` becomes a derivation, ADR 0001's ladder stays the rationale, and the
  manifest cites the rung.** `packages/providers/src/capabilities.ts` keeps its exported signature and
  every docstring, and its body becomes one projection of `manifestFor(kind)`:
  `canPauseMidRun = pause.rung === 'hook'`; `canResumeSession = resume.mode !== 'none'`;
  `gate = toolRestrictions.mechanism === 'none' ? 'none' : 'all-tools'` *(verified: the `'shell-only'`
  arm is unreachable and stays so — no manifest may produce it, because `capabilities.ts:81-85`'s
  widen-never-narrow rule forbids narrowing a value already recorded, and `'shell-only'` was
  superseded by proof at M13 Task 9. `ShellOnlyMark.tsx` is therefore left exactly as it is, dead and
  correct, rather than deleted — `docs/ia.md` rule 2, nothing is removed.)*;
  `reportsCost = usageCost === 'reported'`; `reportsToolResults = events.produces.includes('tool_result')`.
  The `const unhandled: never` guard survives, one level down, on `PROVIDER_MANIFESTS`'s totality.
  **The ladder is data now, and only the citation is new**: `pause.rung` names which of ADR 0001's
  three tiers a provider sits on — `'hook'` = hooks that can deny (`canPauseMidRun: true`), `'signal'`
  = resume without a mid-run stop, whether because there are no hooks, because the hooks are advisory,
  or because the gate refuses calls without suspending the run (Cursor's case, ADR lines 320-326 and
  332-337 collapsing to the same behaviour), `'none'` = neither hooks nor resume. Each manifest's
  `pause.adr` carries the anchor into `docs/decisions/0001-pause-semantics.md` and the ADR gains
  **no new text** — it is the rationale, the manifest is the claim. *(verified: rung `'none'` is
  DECLARABLE and UNREGISTRABLE. `admitAdapter` (`registry.ts:57-61`) refuses an adapter with neither
  capability, while ADR lines 327-333 describe that tier degrading to a recap-based continuation that
  has never been built. The manifest may therefore spell `'none'`, the registry will refuse it, and
  §7 carries the gap rather than pretending the ladder's bottom rung works.)* **Nothing in M56a changes
  either provider's rung**, and the gate asserts both rows project to byte-identical
  `ProviderCapabilities` objects. What this deliberately does NOT do: it writes no new ADR, adds no
  fourth rung, and does not make `capabilitiesOf` async or registry-dependent — it stays the pure
  lookup `packages/control` needs at write time with no adapter in hand (`capabilities.ts:7-12`).

- **R5 — "`tools.json`" is the manifest's `toolVocabulary`, not a file; `TOOLS_BY_KIND` and
  `ENFORCE_BY_PROVIDER` become derivations, and `permissions.json` v2 is byte-identical.** The roadmap
  phrase names no artifact that exists — `grep -r tools.json` over the whole tree finds the roadmap row
  and two unrelated `tsconfig.tools.json` mentions and nothing else. What it gestures at is a
  per-provider tool vocabulary, and this repository has one: `TOOLS_BY_KIND`. M56a inverts the
  ownership rather than adding a format. Each manifest's `toolVocabulary` is a
  `Record<PermissionKind, readonly string[]>` holding exactly that provider's column of today's table,
  value for value and order for order; `TOOLS_BY_KIND` becomes
  `Object.fromEntries(PERMISSION_KINDS.map(k => [k, Object.fromEntries(PROVIDER_KINDS.map(p => [p,
  manifestFor(p).toolVocabulary[k]]))]))`, keeping its exported type and every consumer; `TOOL_VOCABULARY`
  (`kinds.ts:78-86`) is untouched because it already derives from `TOOLS_BY_KIND`; and
  `ENFORCE_BY_PROVIDER` becomes `{ [p]: manifestFor(p).toolRestrictions.enforce }`. The fixture-derived
  pin in `packages/domain/test/permission/kinds.test.ts` stays exactly as it is and is the proof that
  the values did not move. **`writePermissionsFile` (`packages/control/src/permission.ts:56-91`) is not
  edited at all** — it reads `ENFORCE_BY_PROVIDER` and `TOOL_VOCABULARY`, both of which keep their
  names, and the gate pins the file it produces byte for byte against goldens captured before the
  migration, for both providers and all three `PERMISSION_RUN_KINDS`. What this deliberately does NOT do: it does not move the permission
  KINDS into the manifest (a permission is a fact about this product, not a vendor — `kinds.ts:4-7`),
  does not touch `toolKindFor`'s `mcp__` prefix rule, and does not let a manifest name a tool for
  `read_secret` or `deploy_release`, which are broker grants and name none on either provider.

- **R6 — The registry is a table keyed by `ProviderKind`, built from the manifests, and one entry is
  what a new provider adds.** `packages/providers/src/registry.ts` gains
  `PROVIDER_ADAPTERS: Record<ProviderKind, ProviderRegistration>` where `ProviderRegistration` is
  `{ adapterName: string; build(wiring: ProviderWiring): SlaveRuntimeAdapter; parseModels?(stdout:
  string): readonly ModelOption[] }` and `ProviderWiring` is `{ command, extraArgs?, scripts: {
  hookPath, tapPath?, gatePath, brokerCliPath } }` — one wiring shape both entries read the parts they
  need from, rather than two option types a caller has to know apart. `buildRegistry`'s parameter
  becomes `Partial<Record<ProviderKind, ProviderWiring>>` and its body one loop through
  `PROVIDER_KINDS`, still calling `admitAdapter` per entry and still resolving only the kinds it was
  given (`UnknownProviderError` unchanged, and the "what a process was CONFIGURED with, not what the
  package can build" rule at `:66-72` restated rather than relaxed). Its four call sites move with it
  and are named here: `apps/orchestrator/src/cli.ts:893`,
  `apps/orchestrator/test/integration/tick.test.ts:1043`,
  `packages/providers/test/cursor-adapter.test.ts:190`, `packages/providers/test/registry.test.ts:7,12,17`.
  `buildAdapterRegistry` (`cli.ts:890-923`) becomes a loop that reads each kind's
  `manifestFor(kind).invocation.binEnvVar`/`argsEnvVar` out of `process.env` and hands the same four
  script paths to every entry — so the `SLAVEOFAI_<PROVIDER>_BIN` convention is declared once, in the
  manifest, instead of being spelled at four sites in three files. Both kinds stay configured
  unconditionally, for the reason `cli.ts:884-888` gives. `listProviderModels` (`models.ts:95-105`)
  loses its switch: `modelDiscovery.mode === 'configured'` returns `{ models: manifest.modelDiscovery.options,
  source: 'static' }` and `'listed'` runs `<command> <argv>` and hands stdout to the entry's
  `parseModels`, returning `source: 'account'` — the same two answers, from the same two code paths,
  with the branch chosen by data. **The last vendor literal standing in for a capability goes with
  them**: `validateLlmInput` (`packages/control/src/simulation/write.ts:39-41`) refuses a provider by
  NAME for a reason it states as cost, and becomes a `capabilitiesOf(kind).reportsCost` test whose two
  refusal sentences are unchanged byte for byte (§3 stage 10) — and because that widens its return
  type past the `'claude_code'` literal it narrows to today, its paired write
  `packages/control/src/simulation/llm.ts:235` stops hard-coding `provider: 'claude_code'` on the
  usage row and writes `row.modelProvider` instead, which is the same value for every run that can
  reach it today. What this deliberately does NOT do: it does not make the registry lazy, does not
  defer construction, does not add a per-deployment opt-out, and does not let a registration exist
  without a manifest — `Record<ProviderKind, …>` on both makes them fail together.

- **R7 — `RunHandle.runFiles` becomes a record keyed by channel name. This is the one interface change,
  and here is every reader.** `RunFiles = Readonly<Record<string, string>>`, whose keys are the channel
  names that provider's manifest declares: `runFiles: { channels: readonly string[]; persisted:
  readonly [string, string] }`. Both providers declare `channels: ['settings','hook']` and
  `persisted: ['settings','hook']`, and both adapters return the same two absolute paths they return
  today under the new keys — Claude `{ settings: <settings file>, hook: <gate script> }`
  (`claude/adapter.ts:450`), Cursor `{ settings: <.cursor/hooks.json>, hook: <gate script> }`
  (`cursor/adapter.ts:196`). **The Postgres columns do not move**: `Checkpoint.settingsPath` and
  `.hookPath` are NOT NULL (`schema.prisma:1224-1225`) and M56a runs no migration, so one exported
  helper, `checkpointRunFiles(kind, handle)`, maps `persisted[0] → settingsPath` and
  `persisted[1] → hookPath` and is the ONLY place the pair is spelled outside the schema. Every reader,
  migrated: `apps/orchestrator/src/tick.ts:776`, `apps/orchestrator/src/planning.ts:630` and
  `apps/orchestrator/src/review.ts:579` (the three `...handle.runFiles` spreads into a checkpoint's
  `spawn`, each becoming `...checkpointRunFiles(resolved.provider, handle)`);
  `packages/providers/src/claude/adapter.ts:450,469,612,808` and
  `packages/providers/src/cursor/adapter.ts:196,285,324,456` (the adapters' own construction, their
  internal `spec.runFiles` relay and their `resume()` return, which reads
  `checkpoint.settingsPath`/`.hookPath` back into the record); and the tests
  `packages/providers/test/adapter-resume.test.ts:157-158,224,263,411-412,478-479,585-586` and
  `packages/providers/test/cursor-adapter.test.ts:200`. *(verified: this generalises the ADAPTER side
  and not the PERSISTENCE side, and the residual is named rather than hidden. A provider with three
  run files can declare three channels and an adapter can return them, but only two survive a pause:
  the third would have to be re-derivable at resume time from `runDir` or the worktree. The gate
  therefore asserts `channels.length === 2` for every registered provider until `Checkpoint` gains a
  `runFiles Json` column, and §7 carries that column. Making it now would be a migration in a
  migration-free milestone, for a provider that does not exist, against a shape nobody has measured.)*
  What this deliberately does NOT do: it does not rename the Postgres columns, does not make
  `runFiles` optional, does not let a channel name be chosen at run time, and does not change one byte
  of what either adapter actually writes to disk.

- **R8 — Structured output gains its axis and no behaviour.** `structuredOutput: 'native' | 'prompted'
  | 'none'` answers "how does a caller get a schema-conformant JSON result out of this provider,
  distinct from its narration stream". Both rows read `'prompted'`. *(verified: the repository has
  exactly ONE structured-output mechanism and it is prompt-and-parse — `buildDecisionPrompt`
  (`packages/domain/src/supervisor/prompt.ts:43`) asks the model for a `candidateIndex` object in
  words, and `parseDecisionAnswer` (`:125-142`) takes the FIRST JSON object out of the answer text and
  validates it with a zod schema. `grep -r structuredOutput` over `packages/`, `apps/` and `docs/`
  returns the roadmap row and nothing else. `'prompted'` for Cursor is a statement about the
  MECHANISM, not a vendor measurement: `parseDecisionAnswer` takes a string and Cursor's stream carries
  `text` (`cursor/stream.ts:239`), and what actually refuses Cursor an llm-decision run is
  `validateLlmInput` (`packages/control/src/simulation/write.ts:39`) refusing it for a BUDGET reason —
  "it reports no cost, so a cap cannot be enforced" — not an output-shape one. Cursor's `differences`
  array says exactly that sentence, so a later reader does not mistake the row for a measurement.)*
  **M56a implements nothing for this axis**: no native mode, no schema flag, no second parser, no
  change to `parseDecisionAnswer`. The axis exists so that M56b/M56c can record a `'native'` a vendor
  actually has instead of discovering it three tasks into an implementation. What this deliberately
  does NOT do: it does not make structured output a registry capability, does not gate anything on it,
  and does not add a `ProviderCapabilities` member for it — `claude/adapter.ts:29-30`'s rule stands,
  and a capability nothing reads does not belong in that interface even when it belongs in the
  manifest.

- **R9 — A provider without a hook plane is gated by the ladder read FROM the manifest; the broker
  channel stays provider-agnostic; nothing in M56a changes a rung.** The three mechanisms that decide
  what a run can be stopped by all stop reading a provider's NAME. `signalPause`
  (`pause-signal.ts:44-48`) already reads `canPauseMidRun` and is left alone — it is the precedent, not
  the work. `apps/orchestrator/src/pump.ts:153` and `:467` read `spawn?.provider !== 'cursor'`, a
  vendor literal standing in for exactly that boolean, and become
  `capabilitiesOf(provider).canPauseMidRun` *(verified: behaviour-identical today — Cursor is the only
  kind whose manifest gives `false`, and `pump.ts:409-417` already explains the branch in capability
  terms ("`claude_code` cannot enter this function's body at all"), so this ruling makes the comment
  true of the code.)*. `preflightGate`'s `AllowContract` (`runtime/gate-preflight.ts:82-84`) keeps its
  two shapes and gains no third; which shape a provider uses is `hooks` plus a `differences` sentence,
  and a vendor whose allow/deny contract is neither `silent` nor `explicit` widens that function in
  its OWN milestone rather than this one. **The M52 broker channel is the provider-agnostic path and
  stays untouched**: `brokerChannelPathFor(runDir)` and the `SLAVEOFAI_BROKER_CHANNEL`/
  `SLAVEOFAI_BROKER_CLI` pair (`runtime/process.ts:200-261`) depend only on the child having a
  writable file and a way to invoke the orchestrator CLI, which is true of any CLI-shaped provider —
  so `read_secret` and `deploy_release` are already answered for a hookless vendor, and the manifest's
  `toolRestrictions.mechanism: 'none'` is what says the other four permission kinds are not.
  `CHILD_ENV_ALLOW` (`process.ts:156-169`) stays one twelve-name list for every provider and does NOT
  move into the manifest: it says what this product will hand a worker, not what a vendor needs, and a
  per-provider copy is the first place an operator's API key gets re-added. What this deliberately does NOT do: no rung moves, no hook is registered or
  unregistered, and the five hook-plane scripts — `pause-gate.sh`, `cursor-shell-gate.sh`,
  `tool-result-tap.sh`, `lib/pause-flag.sh`, `lib/permissions.sh` — are not touched at all.

- **R10 — A fake per provider, declared in the registry, and the CI spend net checks every registered
  binary.** `fakeCliRefusal` (`apps/orchestrator/src/require-fake-cli.ts:34-42`) today reads
  `SLAVEOFAI_CLAUDE_BIN` and nothing else, and `basename(bin) === 'claude'` is its whole rule. It
  becomes a loop over `PROVIDER_KINDS`: for each, read `manifestFor(kind).invocation.binEnvVar`, refuse
  when it is absent or empty, refuse when `basename` equals `manifestFor(kind).invocation.binary`. The
  refusal message names the variable that failed, so `REQUIRE_FAKE_CLI_REFUSAL` becomes
  `requireFakeCliRefusal(envVar)` returning the same sentence with the variable substituted — and
  `apps/orchestrator/test/require-fake-cli.test.ts:40`'s exact-string assertion becomes the
  `SLAVEOFAI_CLAUDE_BIN` case of it, byte for byte. *(verified: this refusal would fail every CI gate
  the day it lands unless CI is changed in the same commit. `.github/workflows/ci.yml:38-42` sets
  `SLAVEOFAI_CLAUDE_BIN` and `SLAVEOFAI_REQUIRE_FAKE_CLI` job-wide and sets no Cursor variable at all;
  `scripts/gate-fakes/fake-cursor-agent.sh` already exists and is what `gate:m13-runtime` rehearses
  against. So the workflow gains exactly one line — `SLAVEOFAI_CURSOR_BIN: ${{ github.workspace
  }}/scripts/gate-fakes/fake-cursor-agent.sh` — and the gap the exploration found is closed by making
  the net cover what the repository already had a fake for. This is a real CI behaviour change and the
  only one in the milestone; it can only ever turn a silent real spawn into a refusal.)*
  `apps/web/src/server/settings.ts:51`'s `bin === 'claude' ? … : …` two-branch override becomes
  `process.env[manifest.invocation.binEnvVar]`, and its `REAL` array derives from `PROVIDER_MANIFESTS`
  while `LATER` keeps its two placeholder cards untouched — Codex and Gemini stay captioned
  `not configured · later` until M56b and M56c respectively move them, which is M14 Decision 7's rule
  and is still true. The fake PAIR is not made mandatory: a live rehearsal fake
  (`scripts/gate-fakes/fake-<x>.sh`) is required of a new provider and a fixture-replay
  `test/fake-<x>.mjs` is not — Cursor ships without one, reading checked-in NDJSON fixtures instead.
  What this deliberately does NOT do: it does not add a fake for either existing provider, does not change
  either existing fake by one line, and does not make `SLAVEOFAI_REQUIRE_FAKE_CLI` default to on.

- **R11 — "Green" is two different things, and both are said out loud.** (a) **The fake-CLI gates**:
  every one of the 31 CI gates passes in CI, under `SLAVEOFAI_REQUIRE_FAKE_CLI=1`, spending nothing —
  that is what CI proves and all it proves. (b) **The real-binary measurement gates**:
  `gate:m12-providers` and `gate:m13-runtime` spawn the actual paid `claude` and `cursor-agent`
  against a real daemon, and M56a re-runs BOTH, by hand, locally, after the migration, with each
  binary's `--version` recorded in the task's report — the `cursor-agent self-updates` lesson applied
  to the one milestone that has no excuse for skipping it. **A measurement gate never runs in CI and
  M56a does not add one**: `gate:m12-providers` and `gate:m13-runtime` are absent from
  `.github/workflows/ci.yml` today, their own headers say they drive the real binaries, and
  `fakeCliRefusal`'s docstring (`:31-32`) already names them as the two that must not set the flag —
  that stays true after R10 widens the check, because the flag is what arms it and they do not set it.
  The versions to beat are `claude 2.1.270` and `cursor-agent 2026.08.25-3e8eec8` as installed at
  design time; the report records what was actually installed on the day, and a drift is a line in the
  report, never an assertion in a test. What this deliberately does NOT do: it adds no measurement
  gate, makes neither cheaper, and does not rehearse them against the fakes INSTEAD of running them
  for real — a rehearsal proves the script, not the provider.

- **R12 — No new provider ships in M56a, and each of the next two is blocked on a binary.** M56a adds
  no `ProviderKind` member, no Postgres enum value, no adapter directory, no manifest beyond the two,
  and no migration. M56b (Codex) and M56c (Gemini) each get their own spec, written only after the
  binary is installed and `--help`/`--version` have been read on the operator's machine, because every
  axis in R3's manifest is a measurement and `capabilities.ts:81-85`'s rule — "never assumed true
  because the vendor's documentation says so" — applies with equal force to a first measurement as to
  a widening. Each will follow M13 Series C's methodology (`docs/superpowers/specs/2026-08-29-m13-runtime-hardening-design.md:184-205`):
  outcome branches written down in advance, two runs in a fresh `git worktree add` root, and the
  measured value recorded with the binary version beside it. What this deliberately does NOT do: it stubs no `CodexAdapter` or `GeminiAdapter`, adds no manifest
  with unmeasured fields, reserves no enum value, and moves neither card out of `LATER`.

- **Global constraints.** **Never a real model call** in a test or a gate
  (`packages/providers/test/fake-claude.mjs`, `SLAVEOFAI_REQUIRE_FAKE_CLI=1`); a real call needs the
  user's explicit consent, per call — and R11(b)'s two measurement gates ARE real spend and are run
  only on the user's word. **A measurement gate never runs in CI.** **One vitest run at a time**, and
  never a gate beside one — they share one Postgres, and a running daemon breaks the subscribe test.
  **`npm run web:build` is never run while `next dev` is up**, and it is the last gate of a web task,
  because tsc and vitest do not see bundler-only breakage — and this milestone touches
  `apps/web/src/lib/providerLabel.ts`, which four client components import, so the build gate is not
  optional here. **No `prettier`** — this repository has no config and no dependency. **`apps/web`
  imports carry no `.js` suffix**; every other package's do. **A piped command's status is
  `${PIPESTATUS[0]}`**, never `$?`. **`tsc --build` runs after `db:generate`**, and `npm run typecheck`
  — which also checks every `tsconfig.test.json` and `apps/web` — is what the pre-push hook runs; a
  green `tsc --build` can still fail it. **The product word is `slave`** (`gate:m26-vocabulary`).
  **Labels never keys** (`docs/ia.md` rule 3): `PROVIDER_LABEL` stays the one word a person reads and
  the raw kind stays in `title`/`value`. **Nothing is removed, only moved** (rule 2) — which is why
  `ShellOnlyMark.tsx`, `gate: 'shell-only'` and `PERMISSION_PROVIDERS`'s name all survive. **Real is
  not simulated** (rule 4). **A refusal lives in three homes** — the `ControlRefusal` union and
  `refusalText`, the CLI, and `apps/web/test/refusal-status.test.ts`'s exhaustive record; **M56a adds
  no refusal kind** and changes no refusal text (R6 and §3 stage 10 pin `unsupported_model_provider`'s
  two sentences byte for byte). **A refusal after a write inside a Prisma transaction THROWS.**
  **Untouched and asserted so:** `decide()`, `evaluateGuardrails`, `workspaceSpend`, `stats.spentUsd`,
  the seventeen `SITUATION_KINDS`, the seventeen `ACTION_KINDS`, `formTeam`, `rankCandidates`,
  `profileKeyOf`, `writePermissionsFile`, `toolKindFor`, `CHILD_ENV_ALLOW`, and all five shell scripts
  of the hook plane. **There is NO migration** — the Postgres enum, the `Checkpoint` columns and every
  `ProviderKind?` column stand exactly as they are, and the enum-parity test is the proof.
  **Every gate gets its own `SLAVEOFAI_STATE_DIR`** through `scripts/lib/state-dir.mjs`. **Every commit
  carries the session's trailers.** **The test baseline does not go down: ≥ the M55 final ladder,
  recorded in the plan.** **30 CI gates become 31.**

## 2. Surfaces after M56a
Domain: `provider/kind.ts` (`ProviderKind`, `PROVIDER_KINDS`, the completeness guard — MOVED, not
copied), `provider/manifest.ts` (`ProviderCapabilityManifest` and its axis types,
`PROVIDER_MANIFESTS`, `manifestFor`), `provider/claude-code.ts`, `provider/cursor.ts`,
`provider/index.ts`, and one line in `src/index.ts`; `permission/kinds.ts`'s `PermissionProvider`/
`PERMISSION_PROVIDERS` aliases and its derived `TOOLS_BY_KIND` and `ENFORCE_BY_PROVIDER`. No new
event, no schema change, no change to `events/schema.ts`, `LANE_BY_TYPE`, `situations.ts`,
`actions.ts`, `team.ts`, `evidence/derive.ts`, `pricing.ts` or `supervisor/prompt.ts`. DB: NOTHING —
no column, no enum member, no index, no migration. Providers: `contract/adapter.ts` (the declaring
file for `SlaveRuntimeAdapter`, `ProviderCapabilities`, `StartRunInput`, `RunHandle`, `RunFiles`,
`checkpointRunFiles`), `claude/adapter.ts`'s re-export header and `kind` field, `cursor/adapter.ts`'s
same, `capabilities.ts` as a projection, `models.ts` without its switch, `registry.ts`'s
`PROVIDER_ADAPTERS`/`ProviderRegistration`/`ProviderWiring` and the widened `buildRegistry`,
`types.ts`'s re-export of the union, `index.ts` gaining `contract/adapter.js`. Control: NOTHING but
`simulation/write.ts`'s `validateLlmInput` reading `reportsCost` instead of a vendor literal,
`simulation/llm.ts:235` writing `row.modelProvider` instead of a hard-coded one, and
`simulation/adopt.ts`/`shared.ts` importing the union. Orchestrator: `cli.ts`'s `buildAdapterRegistry`
loop, `require-fake-cli.ts`'s per-provider check, `pump.ts`'s two capability reads, and the three
checkpoint relays in `tick.ts`/`planning.ts`/`review.ts`. Supervisor: NOTHING. Web:
`lib/providerLabel.ts` (the imported list, the kept label table), `server/settings.ts` (`REAL`
derived, `versionOf` reading the manifest's env var), `app/api/sim/route.ts`'s `z.enum(PROVIDER_KINDS)`;
no component changes, no route added, no `docs/ia.md` row moved. Scripts:
`scripts/gate-m56a-provider-contract.mjs`, and the golden fixtures it compares against under
`scripts/fixtures/m56a-goldens/`. CI: one line, `SLAVEOFAI_CURSOR_BIN`.

## 3. Gate
`scripts/gate-m56a-provider-contract.mjs`, `gate:m56a-provider-contract` after `gate:m55-catalog` in `package.json` and CI, **README 30 → 31 gates** in both places (the
`npm run gate:*` roster paragraph and the count sentence, both moved by M55, so their lines are read
at execution time); real daemon, fake CLI,
`SLAVEOFAI_REQUIRE_FAKE_CLI=1` with BOTH bin variables set, zero spend, its own `SLAVEOFAI_STATE_DIR`
from `scripts/lib/state-dir.mjs`. **No browser stage**: nothing rendered changes, and a Playwright
stage asserting that is slower than the `web:build` the task already gates on. **The goldens are captured from `main` before the first line is edited**, checked in under
`scripts/fixtures/m56a-goldens/` (the convention the five catalog fixtures already use) and never
regenerated by the gate — a golden a gate can rewrite is not a golden. Twelve stages:

1. **Two manifests, complete, and nobody holds a second copy of the union.** `PROVIDER_MANIFESTS` has
   exactly the members of `PROVIDER_KINDS`; every one of the fourteen fields is present and non-empty
   on both rows (`differences` non-empty too — a provider with no stated limitation is a provider
   nobody measured); `manifestFor` answers for both and the `Record` totality is asserted from the
   module. Then a GREP over `packages/`, `apps/` and `scripts/`, excluding `dist/`: exactly ONE
   `'claude_code' | 'cursor'` union literal exists in the tree and it is
   `packages/domain/src/provider/kind.ts`; exactly ONE `['claude_code', 'cursor']` array literal
   exists and it is the same file's `PROVIDER_KINDS`. Four independently-guarded copies are gone and
   the grep is what keeps them gone.
2. **The permission verdict is byte-identical.** For each of the two providers × three
   `PERMISSION_RUN_KINDS` × two grant sets (baseline only, and one explicit grant of each of the six
   kinds), `writePermissionsFile` is run into a temp dir and the resulting `permissions.json` is
   compared **byte for byte** against the golden captured before the migration — twelve files, with
   `runId`/`tokenHash` held fixed so the comparison is total and not field-wise. `enforce`,
   `vocabulary`, `prefixes`, `grants` and `allow` all land where they landed.
3. **The argv is byte-identical.** `claudeFlags({settingsPath})` and `cursorFlags({})`,
   `cursorFlags({model})`, `cursorFlags({resume})` and `cursorFlags({model, resume})` each equal their
   golden array, element for element and in order; each provider's `invocation.headlessFlags` is a
   prefix of the corresponding golden; and every member of each `invocation.neverPass` list is absent
   from every golden array. The absolute-`settingsPath` throw and the bare-`--resume` impossibility
   are each re-asserted, because they are the two silent failures the flag builders exist to prevent.
4. **`capabilitiesOf` equals the manifest, and the frozen rows did not move.** For both kinds,
   `capabilitiesOf(kind)` deep-equals the golden capability object captured before the migration; and
   independently, each of the five members equals the projection R4 defines over that kind's manifest.
   Two paths to the same five booleans-and-a-string, so a derivation that drifted from the row it
   replaced fails here rather than in a budget admission.
5. **The registry is a table, and an unconfigured kind still refuses.** `PROVIDER_ADAPTERS` has
   exactly the members of `PROVIDER_KINDS`; `buildRegistry({})` refuses BOTH kinds with
   `UnknownProviderError`; `buildRegistry` given only one kind's wiring resolves that one and refuses
   the other; `admitAdapter` still throws `UnregistrableProviderError` for a stub declaring neither
   capability; and `buildAdapterRegistry()` in a process with both bin variables set resolves both
   kinds to adapters whose `kind` fields are the two `ProviderKind` members — the spelling wrinkle
   closed, with `'claude-code'` absent from the tree outside the two comments that warn about it.
6. **`runFiles` is a record and the checkpoint columns did not move.** A real daemon dispatches one
   fake-CLI run per provider and pauses it; each run's `Checkpoint` row is read back with `prisma` and
   its `settingsPath` and `hookPath` are the same two absolute paths the adapter reported, in the same
   two columns, for both providers; `checkpointRunFiles` is asserted to be the only place the pair
   is CONSTRUCTED — a grep for an object literal assigning both `settingsPath` and `hookPath` outside
   `checkpointRunFiles`, `packages/providers/src/claude/checkpoint.ts`'s interface, the two adapters'
   `resume()` reads and `packages/db` finds nothing; and every registered provider's
   `runFiles.channels` has length 2 with both `persisted` names inside `channels`.
7. **The spend net covers every registered binary.** `fakeCliRefusal` returns the refusal when
   `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and `SLAVEOFAI_CURSOR_BIN` is unset, when it is empty, and when its
   basename is `cursor-agent` — three cases that all returned `null` before this milestone — and the
   message names `SLAVEOFAI_CURSOR_BIN` in each. The Claude cases keep their exact historical
   sentence. Then the live proof: a daemon started with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and a real-named
   `SLAVEOFAI_CURSOR_BIN` exits non-zero and prints the refusal, and the same daemon with both fakes
   starts, which is the state CI now runs in.
8. **No `case 'claude_code'` outside the allow-list.** A grep for a `switch`/`case` or an `if` keyed
   on either provider literal across `packages/`, `apps/` and `scripts/`, excluding `dist/`, `test/`
   and `*.test.*`, may match only files on a checked-in allow-list: the two manifest modules, the
   Prisma schema, `packages/db/src/seed.ts` and `packages/db/src/generated/enums.ts`. Every other
   match is a failure naming the file and the line. The allow-list is a file the gate reads, so
   widening it is a diff a reviewer sees.
9. **The ladder is read, not written.** Both manifests' `pause.adr` anchors resolve to headings that
   exist in `docs/decisions/0001-pause-semantics.md`, and the ADR's own byte count is unchanged;
   Claude's rung is `hook` and Cursor's is `signal`; `signalPause('claude_code', …)` writes the flag
   and `signalPause('cursor', …)` with a null pid throws its existing sentence; a paused Cursor run
   under the real daemon still dies by pid and a paused Claude run still dies by its gate's next deny,
   with `pump.ts` reaching those two paths through `capabilitiesOf` and not through a vendor literal
   (asserted by stage 8's grep covering `pump.ts`).
10. **The model list, the settings cards and the simulation refusal all still say what they said.**
    `listProviderModels('claude_code')` deep-equals the golden `{models: CLAUDE_CODE_MODELS, source:
    'static'}`; `listProviderModels('cursor')` against a stub binary printing a recorded
    `cursor-agent models` capture parses to the golden listing with `source: 'account'`;
    `buildProviderAdapters` with an injected version resolver produces the golden card array — two
    `REAL` cards with their capability triples and the two `LATER` cards still captioned for Codex and
    Gemini; and `validateLlmInput({modelProvider:'cursor'})` returns `unsupported_model_provider` with
    the sentence "it reports no cost, so a cap cannot be enforced" byte for byte, while an unknown
    string still returns "it is not a configured provider".
11. **Both providers' event sets are the manifest's.** Replaying every checked-in fixture through
    `parseStreamLine` and `parseCursorLine` produces only kinds in `[...manifest.events.produces,
    'ignored', 'unparsable']`; Claude's declared set contains `usage` and the four `hook_*` variants
    and Cursor's contains none of them; both contain `tool_result`, which is what makes
    `reportsToolResults` true for both by projection rather than by assertion. *(verified: this widens
    `packages/providers/test/cursor-stream.test.ts:653`'s hand-written seven-name array to eight. It
    is a `toContain` allow-list, so every assertion it makes today still passes, and the added member
    — `permission_denied` — is a branch the parser genuinely has at `cursor/stream.ts:342` that no
    fixture line reaches; under-claiming it would let a consumer suppress an arm that really fires.)*
12. **Nothing else moved.** `SITUATION_KINDS` is seventeen and `ACTION_KINDS` is seventeen, asserted
    from the modules; `LANE_BY_TYPE` is 61, asserted from the module; the Postgres `ProviderKind` enum
    is still exactly `['claude_code','cursor']` and `enum-parity.test.ts` still passes unedited;
    `prisma migrate diff --from-config-datasource --to-schema … --config packages/db/prisma.config.ts`
    reports "No difference detected"; `CHILD_ENV_ALLOW` is the same twelve names; the five hook-plane
    shell scripts are byte-identical to `main`; and `git status --porcelain` after a green run is what
    it was before.

**The measurement half, which is not a stage and never runs in CI** (R11b): after the migration and
before the merge, `npm run gate:m12-providers` and `npm run gate:m13-runtime` are run by hand against
the real `claude` and `cursor-agent`, and the task's report records each binary's `--version` output
for that run beside the result. Both gates are unchanged by this milestone; that is the claim they
prove. **Moved pins, named:** `packages/providers/test/registry.test.ts` and
`packages/providers/test/cursor-adapter.test.ts:189-190` take `buildRegistry`'s new parameter shape and
keep every assertion; `apps/orchestrator/test/integration/tick.test.ts:1043` the same;
`packages/providers/test/adapter-resume.test.ts` and `cursor-adapter.test.ts:200` take `runFiles`'s new
keys; `apps/orchestrator/test/require-fake-cli.test.ts` gains the three Cursor cases and keeps its
exact-sentence assertion as the Claude case; `packages/providers/test/cursor-stream.test.ts:653` takes
the derived allow-list (stage 11); `packages/domain/test/permission/kinds.test.ts` is UNCHANGED and
re-run, which is itself the assertion that R5's inversion moved no value;
`packages/db/test/integration/enum-parity.test.ts` is UNCHANGED. `gate:m14-fidelity` screenshots are
NOT regenerated: no rendered surface changes.

## 4. The third-provider checklist
The milestone's claim, as a count somebody can re-run. **Today a third provider must touch 26 sites**
(every one verified in the tree by `m56-explore.md` §8 and re-verified while writing this spec).
**After M56a it must touch 6.** The rows marked *collapsed* are exactly what the gate's stage 8 grep
and the `Record<ProviderKind, …>` totalities keep collapsed.

| # | Site | Today | After M56a |
|---|---|---|---|
| 1 | `schema.prisma:632-635` `enum ProviderKind` + an additive migration | hand edit | **KEPT** — the sixth site (see below) |
| 2 | `packages/db/test/integration/enum-parity.test.ts:148-149` | derives; fails unless #5 moves too | derives from `PROVIDER_KINDS`; no edit |
| 3 | `packages/providers/src/types.ts:11` the union | hand edit | *collapsed* → re-export (R2) |
| 4 | `packages/providers/src/types.ts:31-37` `PROVIDER_KINDS` + guard | hand edit | *collapsed* → re-export (R2) |
| 5 | `packages/domain/src/permission/kinds.ts:40` `PERMISSION_PROVIDERS` | hand edit | *collapsed* → alias of `PROVIDER_KINDS` (R2) |
| 6 | `apps/web/src/lib/providerLabel.ts:22-24` second guarded copy | hand edit | *collapsed* → import (R2) |
| 7 | `apps/web/src/lib/providerLabel.ts:45-48` `PROVIDER_LABEL` | hand edit | **KEPT** — the label (R2, `docs/ia.md` rule 3) |
| 8 | `packages/control/src/simulation/adopt.ts:36,133`, `shared.ts:24` bare unions | hand edit ×3 | *collapsed* → import (R2) |
| 9 | `apps/web/src/app/api/sim/route.ts:25` `z.enum([...])` | hand edit | *collapsed* → `z.enum(PROVIDER_KINDS)` (R2) |
| 10 | `packages/providers/src/capabilities.ts:23-40` switch + rows | a new `case` + a new row | *collapsed* → projection of the manifest (R4) |
| 11 | `packages/providers/src/models.ts:95-105` `listProviderModels` switch | a new `case` | *collapsed* → `modelDiscovery` + the entry's `parseModels` (R6) |
| 12 | `packages/domain/src/permission/kinds.ts:111-163` `TOOLS_BY_KIND` | a new key in six objects | *collapsed* → `toolVocabulary` (R5) |
| 13 | `packages/domain/src/permission/kinds.ts:149-152` `ENFORCE_BY_PROVIDER` | a new key | *collapsed* → `toolRestrictions.enforce` (R5) |
| 14 | `packages/providers/src/registry.ts:89-99` two named optional fields | widen the signature | *collapsed* → one key in `PROVIDER_ADAPTERS` (R6) |
| 15 | `apps/orchestrator/src/cli.ts:890-923` `buildAdapterRegistry` wiring | a new option block + two env reads | *collapsed* → one loop over the manifests (R6) |
| 16 | a new adapter directory implementing the contract | write it | **KEPT** — the adapter |
| 17 | `apps/web/src/server/settings.ts:32-40` `REAL`/`LATER` | move a row between arrays | *collapsed* → `REAL` derives; `LATER` shrinks (R10) |
| 18 | `apps/web/src/server/settings.ts:51` `versionOf`'s two-branch override | a third branch | *collapsed* → `manifest.invocation.binEnvVar` (R10) |
| 19 | `apps/orchestrator/src/require-fake-cli.ts:39` the spend net | a Claude-only check | *collapsed* → loops every registered kind (R10) |
| 20 | `scripts/gate-fakes/fake-<x>.sh` + the CI line that arms it | write it + one `env:` line | **KEPT** — the fake |
| 21 | `packages/domain/src/guardrails/pricing.ts:51-74` a price entry | hand edit | **OPTIONAL** — `usageCost: 'unmeasured'` says what skipping it costs |
| 22 | `simulation/write.ts:39-41`'s `claude_code`-only check and `simulation/llm.ts:235`'s hard-coded usage provider | two literals | *collapsed* → `reportsCost` and `row.modelProvider` (R6) |
| 23 | `apps/orchestrator/src/pump.ts:153,467` `provider !== 'cursor'` | a second literal | *collapsed* → `canPauseMidRun` (R9) |
| 24 | `SlaveRuntimeAdapter.id` (`claude/adapter.ts:301`, `cursor/adapter.ts:127`) | invent a string | *collapsed* → `kind: ProviderKind` (R1) |
| 25 | `README.md:8,14` the provider-account bullet and its env var | hand edit | **KEPT** — folded into the label row: prose is not derivable |
| 26 | `RunHandle.runFiles`'s 2-tuple / `Checkpoint`'s two columns | reuse the pair or widen the interface | **CONDITIONAL** — a record now; >2 channels still needs the Json column (R7, §7) |

**The six that remain**, and what each costs: **(a)** one manifest module in
`packages/domain/src/provider/` plus one line in its index — the measurement, written down; **(b)** one
entry in `PROVIDER_ADAPTERS` — a constructor and, for a `listed` provider, a parser; **(c)** one
adapter directory under `packages/providers/src/` implementing the contract; **(d)** one live
rehearsal fake under `scripts/gate-fakes/` and the one CI `env:` line that arms it; **(e)** one label —
`PROVIDER_LABEL`'s new key and the README sentence naming the vendor's binary; **(f)** one Postgres
enum value and its additive migration.

*(verified: (f) is the one ruling I could not honour as stated. The decomposition asks for five —
registry entry, adapter directory, fake, manifest, label — and the repository forces a sixth:
`ProviderKind` is a Postgres `enum` (`schema.prisma:632-635`) carried by five nullable columns across
`Slave`, `SlaveTemplate`, `CompanySlave`, `Checkpoint` and `SlaveRun`, and no TypeScript derivation
writes a migration. It is also the LOUDEST of the twenty-six — `enum-parity.test.ts:148-149` fails by
name if the enum and `PROVIDER_KINDS` disagree in either direction — so it is the one site that
cannot be forgotten. Every other kept site is deliberate: a label is a product word, an adapter is
the work itself, a fake is a file only a human writes, a manifest IS the milestone.)*

## 5. Out of scope
**`tools.json` as an operator-editable file on disk.** The roadmap phrase is satisfied by R5's
`toolVocabulary` and is explicitly NOT satisfied by a runtime-loaded file, for three reasons, each of
which is a rule this repository already enforces elsewhere. A per-provider tool mapping loaded at run
time would be a **third writer** for a value `TOOLS_BY_KIND`'s fixture-derived pin
(`packages/domain/test/permission/kinds.test.ts`) exists to keep honest — the pin DERIVES the toolbox
from a recording of the real CLI so that a vendor's tool list changing is a red test, and a file an
operator edits is precisely a way to make that test green while the wall it describes is gone. It
would be a **file the worker's own uid can read and write**: `permissions.sh:112-127` already states
that the run directory is not a trust boundary and that the database is the authoritative check, and a
tool vocabulary on disk would be a second verdict the worker could rewrite — the one thing M52 R4
spent a whole ruling closing. And it would be **unreachable from the client bundle**:
`apps/web/src/components/SlavePanel.tsx:97-101` reads `TOOLS_BY_KIND` in a browser component to decide
which permission kinds name no vendor tool, and a file on the daemon host cannot reach it. The day a provider's tool list genuinely needs to
change without a rebuild is the day this is worth revisiting; §7 carries it, unbuilt and argued.
Also out of scope: **any third provider** (R12) — no Codex, no Gemini, no stub, no reserved enum value.
**A native structured-output path** (R8). **A `Checkpoint.runFiles` Json column** (R7) and the
recap-based continuation ADR 0001's bottom rung describes (R4). **Widening `preflightGate`'s
`AllowContract`** beyond its two shapes, and **moving `CHILD_ENV_ALLOW` into the manifest** (R9).
**Re-measuring `CHILD_ENV_ALLOW` against `claude 2.1.270`** — one patch of drift on a twelve-name
allowlist is a line in §7, not a task. **A Cursor price table entry**, and any change to
`estimateCostUsd`. **Any change to `decide()`, `evaluateGuardrails`,
`workspaceSpend`, `stats.spentUsd`, `SITUATION_KINDS`, `ACTION_KINDS`, `formTeam`, `rankCandidates`,
`profileKeyOf` or `writePermissionsFile`.** **A new event type, a new refusal kind, a new column, a new
index, a migration.** **Any change to the five hook-plane shell scripts.** **A browser stage.**
**And the line every predecessor carries is discharged here: until this milestone the differences
between this product's two runtimes lived in five places that no test could compare to each other —
an interface, a switch, an ADR, a constant in another package, and several hundred comments — and
adding a third meant finding all five by reading; after it there is one typed row per provider, every
table that used to hold a copy derives from it, and the tree fails the build or the gate the moment a
second copy appears.**

## 6. Errata — where execution corrects this spec
Twenty-six, each as `**En (amends Rx)** — <one-line claim>.` with its citation, the way M50's
fifteen, M51's, M52's fifteen, M53's, M54's twenty-three and M55's were. **E1–E17 were written while
the plan was**; **E18–E26 while it was executed**.

**E1 (amends R3 and §2)** — `RuntimeEventKind` does not exist and the domain may not import the type it would be derived from, so `packages/domain/src/provider/events.ts` DECLARES it (thirteen members) and `packages/providers/src/types.ts` is pinned to it in both directions with the `_AssertNever` idiom it already carries: `grep -rn RuntimeEventKind` over `packages/`, `apps/` and `scripts/` returned nothing, the only thing of that shape being `RuntimeEvent['kind']`, an inline union at `packages/providers/src/types.ts:79-190`, and `packages/domain` may never import the package that spawns a child at module scope.

**E2 (amends R2 and R3)** — `ModelOption` moves to the domain with the union and `CLAUDE_CODE_MODELS` moves into Claude's manifest, both re-exported from the paths they already had: R2 says it moves "only the union" and cannot, because a manifest that holds a model table needs a type for one (`packages/providers/src/models.ts:8-12,62-74`), and `packages/providers/test/models.test.ts:31` asserts `listing.models).toBe(CLAUDE_CODE_MODELS)` by IDENTITY, so it must be the same array object.

**E3 (amends R1's verified note)** — `adapter.id` has SIX readers and one CONSTRUCTOR, not one reader: beside `packages/providers/test/cursor-adapter.test.ts:175` there are `:191` and `registry.test.ts:8,21,22,84,85`, and `registry.test.ts:35-52`'s `stubAdapter` constructs `id: 'stub'`, which `readonly kind: ProviderKind` cannot hold — so the stub takes a `kind` parameter and the three `resolve(...).id` reads become `.kind` against the enum spelling.

**E4 (amends R4)** — `capabilitiesOf` must keep returning THE SAME OBJECT for a kind and the `const unhandled: never` guard cannot survive inside it: `packages/providers/test/capabilities.test.ts:41` asserts `adapter.getCapabilities()).toBe(capabilitiesOf('claude_code'))` by identity, so the projection runs ONCE at module load into a frozen `Record<ProviderKind, ProviderCapabilities>`, and the guard moves onto `PROVIDER_MANIFESTS`' own totality, where a third kind is a build error for every axis at the same moment.

**E5 (amends §3 stage 1)** — stage 1's grep excludes `test/` and `*.test.*` exactly as stage 8's does: ten test files spell the two members as a literal deliberately, and one of them is the pin R2 itself rests on (`packages/providers/test/types.test.ts:11`, whose comment says it exists so a change to the list is a change a reviewer sees), with `packages/domain/test/permission/kinds.test.ts:134,141,150,222` — the file §3's "moved pins" paragraph says is UNCHANGED and re-run — among the rest.

**E6 (amends §3 stage 8 and its allow-list)** — the allow-list gains four gate scripts, by name, with a reason each: the grep covers `scripts/` and therefore matches `scripts/gate-m12-providers.mjs:538,541`, `scripts/gate-m13-runtime.mjs:838,891,991,994`, `scripts/gate-m31a-llm-decisions.mjs:406,453` and `scripts/gate-m31b-software-sector.mjs:536,580`, every one of them an ASSERTION that a recorded row carries the provider the gate dispatched — which is what a test does and must keep doing.

**E7 (amends R9 and §2)** — `apps/orchestrator/src/pump.ts:153` is NOT a `canPauseMidRun` read, and a site §2 never names is: `:153` is `runtimeReportsUsage`, whose one consumer writes `skillCalls: Prisma.DbNull`, and it is the same fact as `apps/orchestrator/src/runContext.ts:221`'s `injectSkills` ("Cursor has no skills mechanism at all") — both become `providerRunsSkills(kind)`, which reads `SKILL_TOOL` out of the manifest's governed toolbox (`packages/domain/src/permission/kinds.ts:142`). Only `pump.ts:467` was ever the pause capability.

**E8 (amends R2 and §4)** — the union has TEN production copies, not five: beside R2's five, `grep -rn "'claude_code' *| *'cursor'"` finds `packages/control/src/simulation/write.ts:77`, `apps/orchestrator/src/sweep.ts:940`, `apps/orchestrator/src/cli.ts:2714` and `apps/web/src/components/sim/AdoptDrawer.tsx:36` — a CLIENT component, which takes the union as a TYPE import (erased at compile time) rather than the value import that would drag an adapter into a browser bundle.

**E9 (amends R2 and §4 row 9)** — `--model-provider must be claude_code or cursor` stays exactly that sentence (`apps/orchestrator/src/cli.ts:2713`): the MEMBERSHIP test derives through `isProviderKind` (`packages/control/src/org.ts:21`), the SENTENCE does not, for §4 row 25's stated reason that prose is not derivable, and `oneOfFlag` (`cli.ts:1024`) would reword it to "must be one of claude_code, cursor" — a behaviour change in a milestone whose whole claim is that there is none. Carried.

**E10 (amends R6)** — the usage row writes `row.modelProvider ?? 'claude_code'` and the `??` is a backfill rather than a dispatch: `SimulationModelUsage.provider` is `ProviderKind` NOT NULL (`packages/db/prisma/schema.prisma:1892`) while `SimulationRun.modelProvider` is nullable (`:1827`), so the bare read does not compile; it is the same historical-fact default four other files already carry for a pre-M12 row, and stage 8's grep does not match a `??`.

**E11 (amends R10)** — widening the spend net refuses 28 gate scripts and 7 test environments, not only CI, and the fix is one helper plus a handful of one-line spreads: `fakeCliRefusal` is called by `claudeCommandFrom` (`apps/orchestrator/src/claude-command.ts:19`) on EVERY process that sets `SLAVEOFAI_REQUIRE_FAKE_CLI=1`, and before this milestone none of them set `SLAVEOFAI_CURSOR_BIN` because there was nothing to set. The default lands in `scripts/lib/child-env.mjs`'s `loopbackChildEnv`, CONDITIONALLY, so `gate:m13-runtime` still drives the real binaries.

**E12 (amends R3 and §3 stage 3)** — `headlessFlags` is an in-order SUBSEQUENCE of the golden argv, not a prefix: `claudeFlags` (`packages/providers/src/claude/flags.ts:31-40`) puts the variable `--settings <path>` pair INSIDE its constant half and `--include-hook-events` after it, and a prefix assertion would pass a golden that dropped the last token entirely.

**E13 (amends §3 stage 6)** — `checkpointRunFiles` is the only place a `RunHandle`'s files are MAPPED ONTO the two columns; it is not the only place the pair is written: `apps/orchestrator/src/pump.ts:315-316` (the `Checkpoint` row's own `create`), `apps/orchestrator/src/resume.ts:111-112,180-182` (rebuilt FROM a stored row) and `packages/providers/src/claude/adapter.ts:356,679-680` (`writeSettingsFile`'s two arguments, a settings file and a hook script and not a checkpoint at all) each spell them, and none of those reads a handle — so the stage greps the word `runFiles` and carries the persistence-side sites on a checked-in allow-list with a reason each.

**E14 (amends R3, R5 and §4 row 13)** — three line citations are stale: `TOOL_VOCABULARY` is `packages/domain/src/permission/kinds.ts:177-185` (the spec says `:78-86`) and `ENFORCE_BY_PROVIDER` is `:248-251` (the spec says `:149-152`, twice); `TOOLS_BY_KIND` at `:111-163` is correct.

**E15 (amends §3 stage 11)** — `usage` never comes out of `parseStreamLine`, so the replay cannot pin it and the complement assertion does: the event is pushed by the ADAPTER (`packages/providers/src/claude/adapter.ts:597`) from `parseStreamUsage`, so stage 11 keeps its subset assertion and gains the one that actually pins the row — `RUNTIME_EVENT_KINDS` minus Claude's `produces` is exactly `['ignored','unparsable']`, while Cursor's six are named one by one.

**E16 (amends R10 and §4 row 18)** — `versionOf` keeps its `bin: string` parameter and only the env lookup inside it derives: `apps/web/test/integration/settings-snapshot.test.ts:34` injects `async (bin) => (bin === 'claude' ? '2.1.234' : null)`, and `buildProviderAdapters`'s whole testability rests on that resolver being keyed on the binary NAME — so the two-branch override becomes a lookup in `BIN_ENV_VAR`, one `Object.fromEntries` over `PROVIDER_MANIFESTS`, and not one line of that test file's three existing cases moves.

**E17 (amends §3 stage 10)** — the settings-card half of stage 10 cannot run inside a `.mjs` gate and runs in the web test that already exists: `apps/web` is a Next app with no `dist` (`scripts/gate-m29-simulation.mjs:80` and `scripts/gate-m30-simulation-compare.mjs:88` both say so), so `buildProviderAdapters` is asserted against the golden inside `apps/web/test/integration/settings-snapshot.test.ts` and the GATE asserts the same golden against `PROVIDER_MANIFESTS`, `PROVIDER_LABEL` and `PROVIDER_ADAPTERS`, with `slavesBound` excluded from both.

**E18 (amends R6)** — `validateLlmInput` reads `manifestFor(kind).usageCost` from the domain, not `capabilitiesOf(kind).reportsCost` from providers: `packages/control/test/simulation-boundary.test.ts` source-scans `simulation/*.ts` for the `@slave-of-ai/providers` specifier; the projection is `usageCost === 'reported'` by R4, so the same axis is read one derivation earlier and both refusal sentences are byte-identical.

**E19 (amends §4 and R3's ledger)** — `LEDGER_AXES` has 16 entries (Hooks, Run files, Measured against and Tool vocabulary are rows), the test asserts rows == axes both ways, the escape rule runs over data rows only, and the ADR link is relative (`../decisions/…`).

**E20 (amends R10 and E11)** — `fakeProviderBins(env)` fills only ABSENT variables and arms only when `env.SLAVEOFAI_REQUIRE_FAKE_CLI === '1'`; ten gate scripts needed an edit (the four hand-built ones plus m14/m18/m23's hand-built envs and m30/m31a/m31b, which set the flag over `loopbackChildEnv()`), and seven test env literals.

**E21 (amends §3 stages 5 and 8)** — both greps are code-only (comment lines dropped) and both exclude `dist/`, `test/`, `*.test.*`; the allow-lists admit no comment.

**E22 (amends §3 stages 2, 9 and Task 1's numbers)** — 21 golden files beside their README, 22 entries in `scripts/fixtures/m56a-goldens/` (`ls scripts/fixtures/m56a-goldens | wc -l`); the twenty-first is `hook-plane-sha256.json`, added by the final review's fix wave so stage 12 pins the five hook-plane scripts to the digests they carry on the tree this milestone forked from rather than to `HEAD`, which only ever catches an uncommitted edit. Claude's governed vocabulary is 38 names; `ENFORCE_BY_PROVIDER` values are strings, so the derived-table proof is value equality against the golden, not identity.

**E23 (amends R1, E3 and R7)** — `brandRunId` is spelled `runId` in the domain; `implements SlaveRuntimeAdapter` needs a local type import beside the re-export; under `noUncheckedIndexedAccess` a `Checkpoint` literal spreads `checkpointRunFiles(kind, handle)` rather than reading `.settings`/`.hook` bare; `buildRegistry` throws when `build(...).kind !== kind`; two readers outside the plan's list (`tick.test.ts`, `model.test.ts`) moved from `id` to `kind`.

**E24 (amends §3 stage 10 and E17)** — `settings-cards.json`'s `version`/`state`/`slavesBound` are placeholders every comparator skips or normalises; the golden is never rewritten.

**E25 (amends R12 and §7)** — on 2026-09-13 the operator installed `codex` (codex-cli 0.154.0) and `gemini` (0.59.0) but holds no account for either; both remain unmeasurable, so M56b/M56c stay blocked and the "installed and measurable" condition is unchanged.

**E26 (amends E13 and §3 stage 6)** — the `runFiles` allow-list carries TEN files, not six: E13 was written before the manifest existed, and `packages/domain/src/provider/manifest.ts` (which DECLARES `ProviderRunFiles`), `claude-code.ts` and `cursor.ts` (which hold the axis) and `ledger.ts` (which renders it as the ledger's "Run files" row) all spell the word under a package's `src/`. Declaring the axis is what the stage protects, so the four files that declare it are on the list with a reason rather than failing the grep that exists to keep the MAPPING in one place — which is still `checkpointRunFiles` and nothing else.

## 7. Carried backlog (M55 §6's list that M56a does not take, plus what M56a declines)
From M55 §6 — which reproduces M54 §6, M53 §6, M52 §5 and M51's own final-review deferred list —
**M56a takes exactly THREE items and touches no other's files**: **`fakeCliRefusal`'s Claude-only
blind spot** (R10), **`ProviderKind`'s four independently-guarded copies** (R2), and
**`RunHandle.runFiles`'s frozen 2-tuple on the adapter side** (R7). Everything else stays carried,
including the two nearest this subject: **`MODEL_PRICES` unpinned against `CLAUDE_CODE_MODELS`** — a
manifest now holds both lists, one axis apart, and pinning them changes what `estimateCostUsd`
returns for a newly-listed model, which is a cost-reporting change and not a contract one — and
**gates m8/m10/m13 outside CI**, which R11 restates as a deliberate posture rather than a gap. Also untouched, verbatim from M55 §6: the eight guardrail-name literals; de-escalation under a
standing `toolCallCap`; the candidates' vanished-run escalation; `runTapScript`'s missing timeout; a
tap breaking between daemon start and a spawn; the three web read models dividing by
`maxToolCallsPerRun`; `upperBoundUsd`'s flat cap below the estimate; `brief.test.ts`'s contradicting
comment; M4 Cursor's `rejected` line; M7's two upper bounds; M8's write volume; the uncollected
pre-release worktree; the null-engagement temporary downgrade; `brief.ts`'s unordered team read;
`gate:m47` stage 6's flake; the singular worktree wording; a non-temporary hire reusing an unreleased
ephemeral worker; a reuse leaving a decision claiming an engagement; `engagement_over` racing a
dispatch; `AllSlavesTable`'s released rows; the three Overview panels each loading a Supervisor world;
`tierOf` busy at draft time; `CATALOG_ENTRIES_MAX` by id; pre-M47 `capabilityKeys: []`; the m11 flake;
m14 PNG nondeterminism; mapper M6/M7/E23; `WorkforceClient`'s bare `<details>`; the drawer's
`rawOverride`; the `sourceRepository` asymmetry; `GET /api/org/catalog` principal harmonisation;
M48's six; M49's seven; `HandoffContract.evidenceRequired`; `broker.executed` with no consumer; a
moved checkout splitting its own evidence; the absent GIN index; M54's nine; and M55's fourteen.

**Newly carried by this milestone, from what it declined** (twelve):
1. **M56b — the Codex CLI**, BLOCKED on the binary. `which codex` answers `not found` on the operator's
   machine; every axis of R3's manifest is a measurement, and `capabilities.ts:81-85` forbids filling
   one from a vendor's documentation. The spec is written after an install and a measured spike, and
   the measured run records the binary's version beside every value.
2. **M56c — the Gemini CLI**, BLOCKED on the binary, on identical terms. Both cards stay in
   `apps/web/src/server/settings.ts`'s `LATER`, captioned `not configured · later`, until their own
   milestones move them — which is the M14 Decision 7 rule that put them there.
3. **The native structured-output path** (R8). The axis records `'prompted'` for both providers and
   M56a implements nothing; the day a vendor offers a schema-conformant result channel, `'native'` is
   the value that says so and a second parser is the work.
4. **`tools.json` as an operator-editable file** (§5), explicitly REJECTED rather than deferred: a
   third writer for the tool vocabulary, readable and writable by the worker's own uid, invisible to
   the client bundle, and able to turn the fixture-derived pin green while the wall it describes is
   gone. Restated here so a later reader does not mistake the rejection for a to-do.
5. **`Checkpoint.runFiles Json`** (R7). A provider with more than two run-file channels cannot be
   resumed today; the gate asserts `channels.length === 2` so the limit is loud, and the column is the
   fix whenever a measured provider actually needs it.
6. **ADR 0001's bottom rung has never run** (R4). `pause.rung: 'none'` is declarable and
   `admitAdapter` refuses it; the recap-based continuation the ADR describes at lines 327-333 — a
   checkpoint degraded to branch, HEAD, dirty files and event history, and a continuation that is a
   fresh run from that recap — exists in prose and in no code. A hookless, resumeless vendor is the
   first thing that would need it built.
7. **`preflightGate` supports two allow shapes, not a family** (R9). `silent` and
   `explicit(allowedBy, hint)` cover both shipped providers; an HTTP callback, a different exit-code
   contract or a non-zero allow would widen `runtime/gate-preflight.ts` in that provider's own
   milestone.
8. **The four non-brokered permission kinds have no vendor-agnostic mechanism** (R9).
   `read_secret` and `deploy_release` are answered for any CLI-shaped provider by M52's broker channel;
   `read_repo`, `write_repo`, `run_commands` and `network_fetch` still need a real PreToolUse-shaped
   interception a vendor may or may not expose, and `toolRestrictions.mechanism: 'none'` is the
   manifest's way of saying so out loud rather than discovering it at dispatch.
9. **`gate: 'shell-only'` stays dead and typed** (R4), and `ShellOnlyMark.tsx` stays wired into
   `SlaveCard`, `SlavePanel` and `AllSlavesTable` rendering nothing. Removing either would narrow a
   recorded capability, which `capabilities.ts:81-85` forbids; the value costs a union member and a
   component nobody sees.
10. **`CHILD_ENV_ALLOW` is measured against `claude 2.1.269` and the installed binary is `2.1.270`**
    (`process.ts:135-138`, `m56-explore.md` §5). One patch of drift on a twelve-name allowlist, with
    both fakes and both real binaries answering `--version` under it; re-measuring is a task for the
    next milestone that changes the list, not for one that does not touch it.
11. **A price table for a second vendor** (§4 row 21). `usageCost: 'unmeasured'` is Cursor's honest
    value and would be a new provider's until somebody prices its models; `estimateCostUsd` already
    returns `null` rather than `0` for it, which is the true answer, and a `reportsCost: false`
    provider remains permanently refused an llm-decision simulation for the budget reason
    `write.ts:39` gives.
12. **M56a's own measurement half, DEFERRED pending the operator's word** (R11b, §3).
    `gate:m12-providers` and `gate:m13-runtime` spawn the real, paid `claude` and `cursor-agent`;
    both are UNCHANGED by this milestone, and that is the claim they prove. Task 6 asked for the
    spend and no answer had arrived, so NEITHER WAS RUN — a rehearsal against the fakes proves the
    script and not the provider, and this milestone does not get to claim otherwise (R11: the two
    halves of "green" are different things). The fake-CLI half IS green: all 31 CI gates pass,
    `gate:m56a-provider-contract` among them. Both binaries are installed on the operator's machine
    as of 2026-09-13 — `claude 2.1.270` at `~/.local/bin/claude` and `cursor-agent
    2026.09.10-fd3934a` at `~/.local/bin/cursor-agent` — and both have drifted from the versions the
    manifests record (`claude 2.1.269`, measured 2026-09-12; `cursor-agent 2026.08.25-3e8eec8`,
    measured 2026-08-29). That drift is a line here and never an assertion in a test: `cursor-agent`
    self-updates between runs and `claude` does too, which is why `ProviderMeasurement` records a
    version beside every value rather than pinning one. **Whoever runs the two gates must run them
    from a shell where `SLAVEOFAI_REQUIRE_FAKE_CLI` is UNSET** — `env | grep
    SLAVEOFAI_REQUIRE_FAKE_CLI` was empty in the shell Task 6 ran in, and it has to stay that way:
    since R10 `loopbackChildEnv` arms BOTH fakes whenever that flag is set, so a shell carrying it
    would silently rehearse instead of measure. `gate:m13-runtime` also needs `CHROMIUM_PATH`, and
    its own header names every variable it refuses to start without.
