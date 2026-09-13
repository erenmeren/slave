# M56a Provider Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** What this product's two runtimes can do stops being five unconnected stories — a TypeScript interface in one vendor's directory, a switch, an ADR, a constant in another package, and several hundred lines of "measured, not assumed" comments — and becomes ONE typed row per provider, on fourteen named axes, as data. Every table that used to hold a second copy of one of those facts derives from that row; the union that says which providers exist has exactly one declaration instead of ten; the registry is a table a new entry joins rather than a signature a new provider widens; and the CI net that keeps a gate from spending real money covers every binary a run could spawn rather than only the first one. Nothing a provider does changes — not one flag, not one verdict byte, not one event, not one rung of the pause ladder — and the proof that nothing changed is the point of the milestone, which is why the gate is mostly golden files captured before the first line was edited.

**Architecture:** The declaration moves DOWN the dependency graph and everything else derives UP from it. `packages/domain` imports nothing but `zod`, `packages/providers` already depends on it, and `apps/web`'s own client bundle imports it — so `packages/domain/src/provider/` is the one place every consumer of a provider fact can reach, and it holds `ProviderKind`, the label table, the two `ProviderCapabilityManifest` rows and `PROVIDER_MANIFESTS`, a `Record<ProviderKind, …>` whose totality makes a third provider a BUILD failure before it is a bug. `packages/domain/src/permission/kinds.ts` keeps `PERMISSION_PROVIDERS`, `PermissionProvider`, `TOOLS_BY_KIND` and `ENFORCE_BY_PROVIDER` as NAMES and loses them as SOURCES: the first two alias the union, the last two are one `Object.fromEntries` over the manifests each, so `writePermissionsFile` is not edited at all and `permissions.json` v2 comes out byte for byte. `packages/providers/src/contract/adapter.ts` becomes the declaring file for `SlaveRuntimeAdapter` (one block, not two), `ProviderCapabilities`, `StartRunInput`, `RunHandle` and `RunFiles`, and `claude/adapter.ts` re-exports every one of them from the path the whole tree already imports, so not one import line moves; `capabilitiesOf` keeps its signature, its docstrings and its object IDENTITY per kind, and its body becomes a projection computed once at module load. `registry.ts` gains `PROVIDER_ADAPTERS: Record<ProviderKind, ProviderRegistration>` and `buildRegistry` becomes a loop over `PROVIDER_KINDS`; `listProviderModels` loses its switch to `modelDiscovery.mode`; `buildAdapterRegistry` reads each kind's `binEnvVar` out of the manifest instead of spelling `SLAVEOFAI_<X>_BIN` at four sites. `RunHandle.runFiles` becomes `Readonly<Record<string, string>>` keyed by the channel names a manifest declares — the one interface change — and `checkpointRunFiles(kind, handle)` is the single place those channels are mapped onto the two NOT NULL `Checkpoint` columns, which do not move. `fakeCliRefusal` loops every registered kind, which is the milestone's only real behaviour change and can only ever turn a silent real spawn into a refusal. **No migration**: the Postgres enum, the `Checkpoint` columns and every `ProviderKind?` column stand exactly as they are, and `enum-parity.test.ts` passes unedited as the proof. **No new event**: the catalogue stays at 61.

**Tech Stack:** TypeScript monorepo, Next.js 15 App Router + React 19, Tailwind v4 (configured by `@theme inline` inside `apps/web/src/app/globals.css` — there is no `tailwind.config.*`), zod, vitest (two projects: `unit`, `integration`), Prisma 7 + Postgres (:5433), plain-`node` `.mjs` gates driving `playwright-core`.

**Spec:** `docs/superpowers/specs/2026-09-13-m56a-provider-contract-design.md` (rulings R1–R12; §2 surfaces; §3 gate, twelve stages plus the non-CI measurement half; §4 the third-provider checklist, 26 sites → 6; §5 out of scope; §6 errata; §7 carried backlog). Its parents are `docs/superpowers/specs/2026-09-10-roadmap-m44-m56.md` (row M56 at line 48, and lines 19-23: extensions named as such), `docs/superpowers/specs/2026-08-25-m12-provider-adapters-design.md` (the adapter seam, the one-consumer-per-capability rule, the two post-merge corrections), `docs/superpowers/specs/2026-08-29-m13-runtime-hardening-design.md` (Series C, the proving methodology M56b/M56c will follow), `docs/decisions/0001-pause-semantics.md` (the three-rung ladder the manifest now cites), `docs/superpowers/specs/2026-09-12-m52-capability-broker-design.md` (the permission matrix, `CHILD_ENV_ALLOW`, the broker channel) and `docs/ia.md` (rule 2, nothing is removed only moved; rule 3, labels never keys; rule 4, real is not simulated). **This is the milestone that discharges the line every predecessor carries: until now the differences between this product's two runtimes lived in five places no test could compare to each other, and adding a third meant finding all five by reading; after it there is one typed row per provider, every table that used to hold a copy derives from it, and the tree fails the build or the gate the moment a second copy appears.**

Plan-time errata E1–E17, every one read out of the code and baked into the tasks below. The long form, with file and line evidence and the alternatives rejected, is in the session notes (`m56a-plan-notes.md`); each is also to be appended to the spec's §6 during execution, in the one-line `**En (amends Rx)** — <claim>.` form.

- **E1 (amends R3 and §2) — `RuntimeEventKind` does not exist, and the domain may not import the type it would be derived from; the domain DECLARES it and `packages/providers` is pinned to it.** R3 types the manifest's `events.produces` as `readonly RuntimeEventKind[]`. `grep -rn RuntimeEventKind` over `packages/`, `apps/` and `scripts/` returns **nothing**: the only thing of that shape is `RuntimeEvent['kind']`, an inline union of thirteen variants at `packages/providers/src/types.ts:79-190`. The manifest lives in `packages/domain`, whose `package.json` lists exactly one dependency (`zod`) and which may never import `packages/providers` (`node:child_process` at module scope, `apps/web`'s client bundle). So `packages/domain/src/provider/events.ts` declares `RUNTIME_EVENT_KINDS` (thirteen members, in `types.ts`'s own order) and `type RuntimeEventKind`, and `packages/providers/src/types.ts` gains a two-way compile-time pin — `RuntimeEvent['kind']` extends `RuntimeEventKind` and `RuntimeEventKind` extends `RuntimeEvent['kind']`, the `_AssertNever` idiom it already carries for `PROVIDER_KINDS` — so a fourteenth variant added to the union without a matching member is a build error in the file that added it.
- **E2 (amends R2 and R3) — `ModelOption` moves to the domain with the union, and `CLAUDE_CODE_MODELS` moves into Claude's manifest.** R3 gives `modelDiscovery` an `options?` field holding Claude's eleven-entry table; R6 reads `manifest.modelDiscovery.options` to answer `listProviderModels`. `ModelOption` is declared at `packages/providers/src/models.ts:8-12` and `CLAUDE_CODE_MODELS` at `:62-74`, and the domain cannot import either. R2 says it moves "only the union" — it cannot: a manifest that holds a model list needs a type for one. `packages/domain/src/provider/models.ts` declares `ModelOption` (three fields, verbatim), `provider/claude-code.ts` holds the eleven entries, and `packages/providers/src/models.ts` re-exports **both names from the paths they already have** — `export type { ModelOption } from '@slave-of-ai/domain'` and `export const CLAUDE_CODE_MODELS = CLAUDE_CODE_MANIFEST.modelDiscovery.options`, the SAME ARRAY OBJECT, because `packages/providers/test/models.test.ts:31` asserts `listing.models).toBe(CLAUDE_CODE_MODELS)` by identity and not by equality. `ModelListing` stays in `packages/providers` — it is the shape of an answer, not a fact about a vendor.
- **E3 (amends R1's verified note) — `adapter.id` has SIX readers and one CONSTRUCTOR, not one reader.** R1 states that `grep` finds `adapter.id` only at `packages/providers/test/cursor-adapter.test.ts:175`. It also finds `cursor-adapter.test.ts:191` (`registry.resolve('cursor').id`) and `registry.test.ts:8,21,22,84,85`; and `registry.test.ts:35-52`'s `stubAdapter` **constructs** `id: 'stub'`, which `readonly kind: ProviderKind` cannot hold. Each line is named in Task 2 Step 9 with its replacement: the three `resolve(...).id` reads become `.kind` against the enum spelling (`'claude_code'`, not `'claude-code'` — the wrinkle the two comments at `packages/control/src/index.ts:18` and `apps/web/src/server/overview.ts:765` exist to warn about, closed here), and `stubAdapter` takes a `kind: ProviderKind` parameter so the two `admitAdapter` cases assert the kind they passed in.
- **E4 (amends R4) — `capabilitiesOf` must keep returning THE SAME OBJECT for a kind, and the `const unhandled: never` guard cannot survive inside the function.** `packages/providers/test/capabilities.test.ts:41` asserts `adapter.getCapabilities()).toBe(capabilitiesOf('claude_code'))` — identity, with a comment saying why equality would not do. A projection computed per call returns a fresh object and fails it. So the projection runs ONCE at module load into a frozen `Record<ProviderKind, ProviderCapabilities>` and `capabilitiesOf` is a lookup in it. The `never` guard cannot be restated there: inside a total `Record` lookup `kind` is never narrowed to `never`, so `const unhandled: never = kind` does not compile. It moves exactly where R4 says it moves — onto `PROVIDER_MANIFESTS`'s own totality, which is a build error one level down — and the function keeps a runtime `undefined` guard that `noUncheckedIndexedAccess: true` (`tsconfig.base.json`) requires anyway, throwing the same sentence it throws today for a kind that reached it through an unchecked cast.
- **E5 (amends §3 stage 1) — stage 1's grep excludes `test/` and `*.test.*`, exactly as stage 8's does.** Ten test files spell the two members as a literal deliberately, and one of them is the pin R2 itself relies on: `packages/providers/test/types.test.ts:11` (`expect(PROVIDER_KINDS).toEqual(['claude_code','cursor'])`, whose comment says it exists so a change to the list is a change a reviewer sees), `packages/domain/test/permission/kinds.test.ts:134,141,150,222` (the file §3's "moved pins" paragraph says is UNCHANGED and re-run), `packages/providers/test/capabilities.test.ts:63`, `packages/control/test/permission-mapping.test.ts:17`, `packages/control/test/runtime.test.ts:4`, `packages/control/test/integration/{workspace-settings,org}.test.ts`. A test that spells the two members is the assertion, not the copy.
- **E6 (amends §3 stage 8 and its allow-list) — the allow-list gains four gate scripts, by name, with a reason each.** Stage 8's grep covers `scripts/` and excludes only `dist/`, `test/` and `*.test.*`. It therefore matches `scripts/gate-m12-providers.mjs:538,541`, `scripts/gate-m13-runtime.mjs:838,891,991,994`, `scripts/gate-m31a-llm-decisions.mjs:403,450` and `scripts/gate-m31b-software-sector.mjs:533,577` — every one of them an ASSERTION that a recorded row carries the provider the gate dispatched, which is the same shape of statement a test makes and must keep making. They join `scripts/fixtures/m56a-goldens/provider-literal-allowlist.json` beside the five sites the spec names, each with its one-line reason, so widening the list stays a diff a reviewer sees.
- **E7 (amends R9 and §2) — `pump.ts:153` is NOT a `canPauseMidRun` read, and a site §2 never names is.** R9 says `pump.ts:153` and `:467` both stand in for `canPauseMidRun`. `:467` does. `:153` is `runtimeReportsUsage` (`apps/orchestrator/src/pump.ts:125-154`), whose own docstring says it answers "whether the runtime this run was SPAWNED with can report SKILL invocations at all" and whose one consumer writes `skillCalls: Prisma.DbNull` — the "we do not know" of M14 Decision 4. Mapping it onto the pause capability would be behaviour-identical today and false tomorrow, which is the exact failure this milestone exists to remove. It is the same fact as `injectSkills` (`apps/orchestrator/src/runContext.ts:221`: "Cursor has no skills mechanism at all"), a site §2 omits entirely, and both become `providerRunsSkills(kind)` — `manifestFor(kind).toolVocabulary.run_commands.includes(SKILL_TOOL)`, true for the provider whose governed toolbox names `Skill` (`packages/domain/src/permission/kinds.ts:142`) and false for the one whose whole vocabulary is `read`, `edit`, `shell`.
- **E8 (amends R2 and §4) — the union has TEN production copies, not five.** Beside the five R2 names, `grep -rn "'claude_code' *| *'cursor'"` finds `packages/control/src/simulation/write.ts:77` (`createSimulation`'s own input type), `apps/orchestrator/src/sweep.ts:940` (`as 'claude_code' | 'cursor'`), `apps/orchestrator/src/cli.ts:2714` (the same cast) and `apps/web/src/components/sim/AdoptDrawer.tsx:36` — a CLIENT component, which takes the union as a TYPE import from `@slave-of-ai/domain` (erased at compile time, reaching no runtime module) rather than the value import that would drag an adapter into a browser bundle. All four are named in the task that owns their file.
- **E9 (amends R2 and §4 row 9) — `--model-provider must be claude_code or cursor` stays exactly that sentence.** `apps/orchestrator/src/cli.ts:2713` is an operator-visible message, and this milestone changes none. The MEMBERSHIP test derives (`isProviderKind`, `packages/control/src/org.ts:21`, already exported and already the tree's one answer for an untrusted provider string); the SENTENCE does not, for §4 row 25's stated reason — prose is not derivable. `oneOfFlag` (`cli.ts:1024`) is the right shape and the wrong milestone: it would reword the message to "must be one of claude_code, cursor", which is a behaviour change in a milestone whose whole claim is that there is none. Carried.
- **E10 (amends R6) — the usage row writes `row.modelProvider ?? 'claude_code'`, and the `??` is a backfill rather than a dispatch.** R6 says `packages/control/src/simulation/llm.ts:235` "stops hard-coding `provider: 'claude_code'` and writes `row.modelProvider` instead". It cannot write it bare: `SimulationModelUsage.provider` is `ProviderKind` NOT NULL (`packages/db/prisma/schema.prisma:1892`) while `SimulationRun.modelProvider` is `ProviderKind?` (`:1827`), so the bare read is `ProviderKind | null` and does not compile. The `??` is the same historical-fact default `apps/orchestrator/src/sweep.ts:940`, `resume.ts:73` and `packages/control/src/pause.ts` already use for a pre-M12 row, it is unreachable for any row that can arrive here (a `rules` run never calls this function and an `llm` run cannot be created without a `modelProvider`), and stage 8's grep does not match it — a `??` default is not a `case` and not an `if`.
- **E11 (amends R10) — widening the spend net refuses 28 gate scripts and 7 test environments, not only CI, and the fix is one helper plus five one-line spreads.** R10's verified note says the workflow gains exactly one line. That line is necessary and nowhere near sufficient: `fakeCliRefusal` is called by `claudeCommandFrom` (`apps/orchestrator/src/claude-command.ts:19`) on EVERY process that sets `SLAVEOFAI_REQUIRE_FAKE_CLI=1`, and today that is twenty-eight gate scripts and seven `env:` literals in `apps/orchestrator/test/integration/{cli,milestone-gate}.test.ts`, none of which sets `SLAVEOFAI_CURSOR_BIN`. Twenty-four of the gates build their child environment through `scripts/lib/child-env.mjs`'s `loopbackChildEnv`, which is where the default lands — the "ONE PLACE, not twenty-eight copies" rule `scripts/lib/state-dir.mjs:12-17` already states for exactly this shape of problem — and it lands CONDITIONALLY, only when the resulting environment asks for the fake CLI, so `gate:m13-runtime` (which calls `loopbackChildEnv()` and sets no flag) still drives the real binaries. The four that build a child environment by hand (`gate-m8-plan.mjs:101`, `gate-m8a-merge.mjs:99`, `gate-m8a-estop.mjs`, `gate-m10-org.mjs:207`) spread the same helper, and the two test files' four base `env:` literals gain one line each.
- **E12 (amends R3 and §3 stage 3) — `headlessFlags` is an in-order SUBSEQUENCE of the golden argv, not a prefix.** R3 asks for "exactly `claudeFlags`'s constant half" and stage 3 asserts it "is a prefix of the corresponding golden". Both cannot hold: `claudeFlags` (`packages/providers/src/claude/flags.ts:31-40`) returns `--output-format stream-json --verbose --permission-mode bypassPermissions --settings <path> --include-hook-events`, so the constant half is six tokens with the variable pair INSIDE it and the last constant token after. `headlessFlags` is the constant half in order (six tokens for Claude, five for Cursor) and stage 3 asserts an in-order subsequence, which is the stronger of the two claims anyway: a prefix assertion would pass a golden that dropped `--include-hook-events` entirely.
- **E13 (amends §3 stage 6) — `checkpointRunFiles` is the only place a `RunHandle`'s files are MAPPED ONTO the two columns; it is not the only place the pair is written.** The pair is also constructed at `apps/orchestrator/src/pump.ts:315-316` (the `Checkpoint` row's own `create`), `apps/orchestrator/src/resume.ts:111-112` and `:180-182` (rebuilt FROM a checkpoint row, for `adapter.resume` and for the pump), and `packages/providers/src/claude/adapter.ts:356` and `:679-680` (`writeSettingsFile`'s two arguments, which are a settings file and a hook script and not a checkpoint at all). None of those reads `handle.runFiles`. The stage's grep is therefore over the word `runFiles` — which after this milestone appears in exactly five files — plus an assertion that `settingsPath` occurs in `tick.ts`, `planning.ts` and `review.ts` only inside comments, and the persistence-side sites are carried on the same checked-in allow-list stage 8 uses, with a reason each.
- **E14 (amends R3, R5 and §4 row 13) — three line citations are stale.** `TOOL_VOCABULARY` is `packages/domain/src/permission/kinds.ts:177-185` (the spec says `:78-86`), `ENFORCE_BY_PROVIDER` is `:248-251` (the spec says `:149-152` twice), and `TOOLS_BY_KIND` is `:111-163` (correct). Every step below cites the verified line.
- **E15 (amends §3 stage 11) — `usage` never comes out of `parseStreamLine`, so the replay cannot pin it and the complement assertion does.** The `usage` event is pushed by the ADAPTER (`packages/providers/src/claude/adapter.ts:597`) from `parseStreamUsage`, not by the line parser; replaying every fixture through `parseStreamLine` produces ten kinds and never the eleventh. Stage 11 keeps its subset assertion (every replayed kind is in `[...produces, 'ignored', 'unparsable']`) and gains the one that actually pins Claude's row: `RUNTIME_EVENT_KINDS` minus Claude's `produces` is exactly `['ignored','unparsable']` — Claude produces every semantic kind there is — while Cursor's six are named one by one.
- **E16 (amends R10 and §4 row 18) — `versionOf` keeps its `bin: string` parameter, and only the env lookup inside it derives.** `apps/web/test/integration/settings-snapshot.test.ts:34` injects `async (bin) => (bin === 'claude' ? '2.1.234' : null)`, and `buildProviderAdapters`'s whole testability rests on that resolver being keyed on the binary NAME. So `versionOf(bin)` keeps its signature and replaces its `bin === 'claude' ? … : …` two-branch override with a lookup in `BIN_ENV_VAR`, one `Object.fromEntries` over `PROVIDER_MANIFESTS` mapping each `invocation.binary` to its `invocation.binEnvVar`. Not one line of that test file's three existing cases moves.
- **E17 (amends §3 stage 10) — the settings-card half of stage 10 cannot run inside a `.mjs` gate, and runs in the web test that already exists.** `apps/web` is a Next app with no `dist` — `scripts/gate-m29-simulation.mjs:80` and `scripts/gate-m30-simulation-compare.mjs:88` both say so in their own words, and no gate in the tree imports anything from `apps/web/src`. `buildProviderAdapters` is therefore asserted against the checked-in golden inside `apps/web/test/integration/settings-snapshot.test.ts` (which already injects the resolver stage 10 asks for), and the GATE asserts the same golden against `PROVIDER_MANIFESTS`, `PROVIDER_LABEL` and `PROVIDER_ADAPTERS` — the three tables the cards are now derived from. `slavesBound` is excluded from both comparisons and asserted to be a non-negative number instead: it is a `groupBy` over whatever `SlaveRun` rows the database holds, which is not a golden-able fact.

---

## Global Constraints

- **Never a real model call in a test or in CI.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and a fake — `packages/providers/test/fake-claude.mjs` for the unit and integration suites, `scripts/gate-fakes/fake-claude.sh` and `scripts/gate-fakes/fake-cursor-agent.sh` for the gates. **The two measurement gates are LOCAL only and never in CI**: `gate:m12-providers` and `gate:m13-runtime` spawn the real paid `claude` and `cursor-agent`, they are in neither `package.json`'s CI list nor `.github/workflows/ci.yml`, and M56a adds no measurement gate and makes neither cheaper. They are run by hand, once, after the migration and before the merge (Task 6), on the user's word, with each binary's `--version` recorded in the task report.
- One vitest process at a time (the shared test database truncates), and **never a gate beside vitest**. A running daemon breaks `subscribe.test.ts`.
- **`npm run web:build` never while `next dev` is running.** Before any `web:build`, run `pgrep -af "next dev"`; if one is up, `kill <pid>` it and **say so in the task report**. Restarting dev afterwards needs `rm -rf apps/web/.next` first. Task 4 runs `web:build`, and it is not optional there: this milestone edits `apps/web/src/lib/providerLabel.ts`, which four client components import, and tsc and vitest do not see bundler-only breakage.
- **No prettier.** There is no prettier config and no prettier dependency in this repository; `prettier --write` would reformat against the house style. Match the surrounding file by hand.
- Inside `apps/web`, import siblings **without** a `.js` suffix (`../server/settings`, not `../server/settings.js`); `packages/*` keep the `.js` suffix.
- Read an exit code with `${PIPESTATUS[0]}`; never `cmd | tail; echo $?` — that reports `tail`'s status.
- After `npm run db:generate`, run `npx tsc --build` **before** any integration test: the generated client's types are what the test files compile against. (This milestone runs no migration, so `db:generate` is only ever needed if the branch is freshly checked out.)
- `npm run typecheck` — which also checks every `tsconfig.test.json` and `apps/web` — is what the pre-push hook runs; **a green `npx tsc --build` can still fail it**, so both run at the end of every task.
- The vocabulary word is **slave** (`gate:m26-vocabulary`), and Task 5 writes a document into `docs/providers/`, which is **not** on that gate's exclude list (`scripts/gate-m26-vocabulary.mjs:8-11` excludes `docs/superpowers` and `docs/decisions`, not `docs/`). The forbidden word may not appear in it in any form the PROTECTED pattern does not already cover — `cursor-agent`, `agentic` and `AGENTS.md` are protected, "the vendor's agent" is not. `npm run gate:m26-vocabulary` after every task.
- **Labels never keys** (`docs/ia.md` rule 3): `PROVIDER_LABEL` stays the one word a person reads and the raw kind stays in `title`/`value`. The table MOVES to `packages/domain/src/provider/kind.ts` and `apps/web/src/lib/providerLabel.ts` re-exports it under the same name, so all four client call sites and `apps/web/test/provider-select.test.tsx` are untouched.
- **Nothing is removed, only moved** (`docs/ia.md` rule 2). `ShellOnlyMark.tsx`, `ProviderCapabilities['gate']`'s unreachable `'shell-only'` arm, `PERMISSION_PROVIDERS`, `PermissionProvider`, `TOOLS_BY_KIND`, `ENFORCE_BY_PROVIDER`, `TOOL_VOCABULARY`, `CLAUDE_CODE_MODELS`, `ModelOption`, `buildRegistry`, `UnknownProviderError`, `UnregistrableProviderError` and every import path in the tree all still exist under their own names.
- **Real is not simulated** (rule 4). `packages/control/test/simulation-boundary.test.ts` is not touched: this milestone adds no control verb and no table.
- Refusals are `ok()` / `err()`; **a refusal after a write inside `$transaction` must throw**. **M56a adds no refusal kind** and changes no refusal text: `unsupported_model_provider`'s two sentences — "it reports no cost, so a cap cannot be enforced" and "it is not a configured provider" — are pinned byte for byte by the gate's stage 10, and `apps/web/test/refusal-status.test.ts` does not move.
- **Untouched and asserted so:** `decide()` (`packages/domain/src/scheduler/decide.ts`), `evaluateGuardrails` (`packages/domain/src/guardrails/evaluate.ts`), `workspaceSpend` (`packages/control/src/spend.ts`), `stats.spentUsd` (`packages/control/src/stats.ts`), the seventeen `SITUATION_KINDS` and seventeen `ACTION_KINDS`, `formTeam` and `rankCandidates`, `profileKeyOf`, `writePermissionsFile` (`packages/control/src/permission.ts:56-91`), `toolKindFor`, `CHILD_ENV_ALLOW` (`packages/providers/src/runtime/process.ts:156-169`), `buildChildEnv`, `estimateCostUsd`/`MODEL_PRICES`, `preflightGate`'s `AllowContract`, and all five hook-plane shell scripts (`scripts/pause-gate.sh`, `scripts/cursor-shell-gate.sh`, `scripts/tool-result-tap.sh`, `scripts/lib/pause-flag.sh`, `scripts/lib/permissions.sh`). Every one of those files appears in NO task's file list.
- **NO BEHAVIOUR CHANGE, and the goldens are the proof.** Every task ends with the same observable behaviour it started with: the same `permissions.json` v2 bytes, the same argv, the same capability objects, the same model listings, the same refusal sentences, the same events. The goldens are captured from the untouched tree in **Task 1 Step 1**, before one line is edited, and checked in under `scripts/fixtures/m56a-goldens/`. **No task regenerates a golden** — a golden a gate can rewrite is not a golden. The one deliberate exception is `fakeCliRefusal`, which gains cases it did not have; it can only ever turn a silent real spawn into a refusal, and its historical sentence is preserved byte for byte as the `SLAVEOFAI_CLAUDE_BIN` case.
- **NO NEW EVENT TYPE.** The catalogue stays at 61 and the nine event sites are untouched: `packages/domain/src/events/schema.ts`, `packages/domain/src/supervisor/timeline.ts`, `packages/db/src/enums.ts`'s `EVENT_TYPE_BY_DOMAIN_TYPE`, `apps/web/src/components/activity/cards.tsx`, `apps/web/src/lib/activityFilters.ts`, `apps/web/src/lib/eventLabels.ts`, `apps/web/src/server/timeline.ts`, `packages/events/src/append.ts` and `docs/event-model.md` are in NO task's file list.
- **THERE IS NO MIGRATION, and nothing in this milestone needs one.** The Postgres `enum ProviderKind` (`packages/db/prisma/schema.prisma`, found with `grep -n 'enum ProviderKind'` — M55 adds two enums and every line number in that file moves) keeps its two members, `Checkpoint.settingsPath`/`.hookPath` (`grep -n 'model Checkpoint'`) stay NOT NULL under those names, and no column, index or enum value is added or changed — R7 generalises the ADAPTER side only, and R12 adds no provider. `packages/db/test/integration/enum-parity.test.ts:148-151` is UNCHANGED and re-run, which is the proof; the gate's stage 12 runs `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` and requires "No difference detected".
- **The DEV-DB rule.** Any scratch script that touches Prisma runs with `DATABASE_URL="$TEST_DATABASE_URL"`, and nothing outside `test-setup/` ever TRUNCATEs. The gates run against the development database through `--env-file=.env` and clean up only the rows they created, by exact name. Task 1 Step 1's golden capture imports `@slave-of-ai/db/client` transitively (through `packages/control/dist/permission.js`) and **reads and writes nothing**; it runs under `--env-file=.env` only so the Prisma adapter has a connection string to construct with.
- **Run directories live under `SLAVEOFAI_STATE_DIR` in tests and gates** (M52 C1). The shared setup already exists and is loaded by both vitest projects (`test-setup/state-dir.ts`) and by every gate that builds a child environment (`scripts/lib/child-env.mjs` → `scripts/lib/state-dir.mjs`); `scripts/gate-m56a-provider-contract.mjs` gets its root from `gateStateDir()` through `loopbackChildEnv` and adds nothing of its own.
- **Test baseline: at or above the M55 Task 6 ladder.** On the tree this plan was written against (`feature/m54-external-triggers`, 036ab54e), `find` counts **357 test files**; M55 adds five more. Task 1 runs `npx vitest run` once and **records the two numbers it actually sees in its task report**; every later ladder in this plan is at or above them and never below. This milestone adds no column and no index, so the cross-package fixture collision a full suite exists to catch is unlikely — which is not the same as impossible, and the full suite still runs in Tasks 1, 3 and 6.
- **30 CI gates become 31.** `gate:m55-catalog` is the 30th after M55. The new `gate:m56a-provider-contract` step goes immediately after it in both `package.json` and `.github/workflows/ci.yml`, and README's roster sentence and its count line say 31. **Find the count line by grep, never by line number** — it moved from `:971` to `:978` to `:1037` across the last three milestones: `grep -n '^[0-9]\+ gates\.' README.md`.
- Commit trailers, on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01RBVSwP5Paww1L1hqS7Dper
  ```
- Every task ends with focused tests, `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck` and a commit. Task 4 also runs `npm run web:build` (subject to the `next dev` rule above).
- Anything touching the database goes under `test/integration/` and is named `*.test.ts` — `vitest.config.ts`'s `integration` project includes `**/test/integration/**/*.test.ts` only (no `.tsx`), and only that project loads `test-setup/require-database.ts`. Component tests are `*.test.tsx` under `apps/web/test/` with a `// @vitest-environment jsdom` first line.
- **`$SCRATCHPAD` is this session's own scratchpad directory**, and every log, capture script and intermediate file this plan writes goes there. Nothing this milestone writes lands in the repository except the files each task's **Files** list names. Export it once at the start of the milestone (`export SCRATCHPAD=<your session scratchpad>`), and `mkdir -p` it if it does not exist.
- **The implementer never dispatches subagents.**

---

## File structure

```
packages/domain/src/provider/kind.ts           R2: ProviderKind, PROVIDER_KINDS,
                                               _ProviderKindsComplete, PROVIDER_LABEL (new)
packages/domain/src/provider/events.ts         E1: RUNTIME_EVENT_KINDS, RuntimeEventKind (new)
packages/domain/src/provider/models.ts         E2: ModelOption (new)
packages/domain/src/provider/manifest.ts       R3/R4/R5: ProviderCapabilityManifest and its
                                               fourteen axis types, providerManifestSchema,
                                               PROVIDER_MANIFESTS, manifestFor, SKILL_TOOL,
                                               providerRunsSkills (new)
packages/domain/src/provider/claude-code.ts    R3: CLAUDE_CODE_MANIFEST, incl. the eleven
                                               CLAUDE_CODE_MODELS entries (new)
packages/domain/src/provider/cursor.ts         R3: CURSOR_MANIFEST (new)
packages/domain/src/provider/ledger.ts         §4/R3: LEDGER_AXES, renderProviderLedger (new,
                                               Task 5)
packages/domain/src/provider/index.ts          the five (six after Task 5) modules (new)
packages/domain/src/index.ts                   + ./provider/index.js
packages/domain/src/permission/kinds.ts        R2/R5: PermissionProvider = ProviderKind,
                                               PERMISSION_PROVIDERS = PROVIDER_KINDS,
                                               TOOLS_BY_KIND and ENFORCE_BY_PROVIDER derived
packages/domain/test/provider/kind.test.ts                                     (new)
packages/domain/test/provider/manifest.test.ts                                 (new)
packages/domain/test/provider/derived.test.ts                                  (new)
packages/domain/test/provider/ledger.test.ts                                   (new, Task 5)
packages/domain/test/permission/kinds.test.ts  UNCHANGED, re-run -- the proof R5 moved no value

packages/providers/src/contract/adapter.ts     R1/R7: SlaveRuntimeAdapter (one block),
                                               ProviderCapabilities, StartRunInput, RunHandle,
                                               RunFiles, checkpointRunFiles (new)
packages/providers/src/claude/adapter.ts       R1/R7: the re-export header, `kind`, the two
                                               runFiles constructions, the relay type
packages/providers/src/cursor/adapter.ts       R1/R7: the same three
packages/providers/src/capabilities.ts         R4: the projection, computed once
packages/providers/src/types.ts                R2/E1: re-exports the union, pins RuntimeEventKind
packages/providers/src/models.ts               R6/E2: ModelOption and CLAUDE_CODE_MODELS
                                               re-exported, listProviderModels without its switch
packages/providers/src/registry.ts             R6: ProviderWiring, ProviderRegistration,
                                               PROVIDER_ADAPTERS, buildRegistry as a loop
packages/providers/src/index.ts                + ./contract/adapter.js
packages/providers/test/contract.test.ts                                       (new)
packages/providers/test/registry.test.ts       E3 + the new parameter shape
packages/providers/test/cursor-adapter.test.ts E3 (:175, :191), runFiles keys (:200), the
                                               wiring shape (:190)
packages/providers/test/adapter-resume.test.ts runFiles keys (7 lines)
packages/providers/test/cursor-stream.test.ts  the derived allow-list (:653)
packages/providers/test/capabilities.test.ts   UNCHANGED, re-run -- the proof R4 moved no value
packages/providers/test/models.test.ts         UNCHANGED, re-run -- `toBe(CLAUDE_CODE_MODELS)`
packages/providers/test/types.test.ts          UNCHANGED, re-run

packages/control/src/simulation/write.ts       R6/E8: reportsCost instead of a vendor literal
packages/control/src/simulation/llm.ts         R6/E10: row.modelProvider ?? 'claude_code'
packages/control/src/simulation/adopt.ts       R2: the union imported (:36, :133)
packages/control/src/simulation/shared.ts      R2: the union imported (:24)
packages/control/test/integration/simulation-llm.test.ts   the two refusal cases, unchanged, re-run

apps/orchestrator/src/cli.ts                   R6/E9: buildAdapterRegistry as a loop (exported),
                                               --model-provider's membership test
apps/orchestrator/src/require-fake-cli.ts      R10: requireFakeCliRefusal(envVar), the loop
apps/orchestrator/src/claude-command.ts        R10: one docstring paragraph
apps/orchestrator/src/pump.ts                  R9/E7: canPauseMidRun (:467), providerRunsSkills
                                               (:153)
apps/orchestrator/src/runContext.ts            E7: providerRunsSkills (:221)
apps/orchestrator/src/sweep.ts                 E8: the cast (:940)
apps/orchestrator/src/tick.ts                  R7: checkpointRunFiles (:776)
apps/orchestrator/src/planning.ts              R7: checkpointRunFiles (:630)
apps/orchestrator/src/review.ts                R7: checkpointRunFiles (:579)
apps/orchestrator/test/require-fake-cli.test.ts            R10: the three Cursor cases
apps/orchestrator/test/integration/adapter-registry.test.ts                    (new)
apps/orchestrator/test/integration/cli.test.ts             E11: four env literals
apps/orchestrator/test/integration/milestone-gate.test.ts  E11: one env literal
apps/orchestrator/test/integration/tick.test.ts            R6: buildRegistry's shape (:1043)

apps/web/src/lib/providerLabel.ts              R2: the imported list and the re-exported label
apps/web/src/server/settings.ts                R10/E16: REAL derived, BIN_ENV_VAR
apps/web/src/app/api/sim/route.ts              R2: z.enum(PROVIDER_KINDS)
apps/web/src/components/sim/AdoptDrawer.tsx    E8: the union as a type import
apps/web/test/integration/settings-snapshot.test.ts        E17: the golden card array
apps/web/test/provider-select.test.tsx         UNCHANGED, re-run

scripts/lib/child-env.mjs                      E11: fakeProviderBins(), armed only for the fake
scripts/gate-m8-plan.mjs                       E11: one spread
scripts/gate-m8a-merge.mjs                     E11: one spread
scripts/gate-m8a-estop.mjs                     E11: one spread
scripts/gate-m10-org.mjs                       E11: one spread
scripts/gate-m56a-provider-contract.mjs        §3 (new)
scripts/fixtures/m56a-goldens/                 §3 (new): README.md, the twelve permissions.json
                                               captures, argv.json, capabilities.json,
                                               models.json, settings-cards.json,
                                               tools-by-kind.json, enforce-by-provider.json,
                                               provider-literal-allowlist.json,
                                               run-files-allowlist.json
docs/providers/adding-a-provider.md            §4 (new, Task 5)
package.json, .github/workflows/ci.yml, README.md                              §3, E11
docs/superpowers/specs/2026-09-13-m56a-provider-contract-design.md              the spec + §6
docs/superpowers/plans/2026-09-13-m56a-provider-contract.md                     this plan
```

---

### Task 1: The goldens, one union, two manifests, and every table that held a second copy (R2, R3, R5, R8, E1, E2, E5, E8, E14, D1–D14)

`packages/domain`, plus the two one-line re-exports in `packages/providers` that turn its own copies into views of the domain's. This task changes no behaviour: after it there are two manifest modules nothing dispatches on, one declaration of the union where there were three, and two derived tables whose values are the same objects they were before — asserted by identity, not by equality, because two tables that agree today are two tables that disagree after the first edit.

It opens with the goldens, and that is not administration: **§3 requires them captured from the untouched tree, and after Step 4 the tree is no longer untouched.** Nothing else in the milestone can prove it changed nothing if this step is skipped or reordered.

**Files:**
- Create: `scripts/fixtures/m56a-goldens/README.md` and its captures, `packages/domain/src/provider/kind.ts`, `packages/domain/src/provider/events.ts`, `packages/domain/src/provider/models.ts`, `packages/domain/src/provider/manifest.ts`, `packages/domain/src/provider/claude-code.ts`, `packages/domain/src/provider/cursor.ts`, `packages/domain/src/provider/index.ts`, `packages/domain/test/provider/kind.test.ts`, `packages/domain/test/provider/manifest.test.ts`, `packages/domain/test/provider/derived.test.ts`
- Modify: `packages/domain/src/index.ts`, `packages/domain/src/permission/kinds.ts`, `packages/providers/src/types.ts`, `packages/providers/src/models.ts`
- Test: the three new domain files, plus `packages/domain/test/permission/kinds.test.ts`, `packages/providers/test/types.test.ts` and `packages/providers/test/models.test.ts` — all three UNCHANGED and re-run, which is what makes "no value moved" a measurement rather than a claim

**Interfaces:**
- Consumes: `zod`; `PermissionKind` (`packages/domain/src/permission/kinds.ts:33`) **as a type only** — a value import would make a runtime cycle, since `kinds.ts` imports `manifestFor` back; `ProviderKind`/`PROVIDER_KINDS` as they stand at `packages/providers/src/types.ts:11,31` (moved verbatim, docstrings included); `RuntimeEvent` (`packages/providers/src/types.ts:79-190`) as the source of the thirteen event-kind names; `ModelOption` and `CLAUDE_CODE_MODELS` (`packages/providers/src/models.ts:8-12,62-74`, moved verbatim); `TOOLS_BY_KIND` (`kinds.ts:111-163`) and `ENFORCE_BY_PROVIDER` (`kinds.ts:248-251`, erratum E14) as the values the manifests must reproduce exactly.
- Produces, for Tasks 2–6:
  - `packages/domain/src/provider/kind.ts`: `type ProviderKind = 'claude_code' | 'cursor'`, `PROVIDER_KINDS`, `PROVIDER_LABEL: Record<ProviderKind, string>`
  - `packages/domain/src/provider/events.ts`: `RUNTIME_EVENT_KINDS` (thirteen), `type RuntimeEventKind`
  - `packages/domain/src/provider/models.ts`: `interface ModelOption { id; label; default? }`
  - `packages/domain/src/provider/manifest.ts`: `interface ProviderInvocation`, `type ProviderModelDiscovery`, `interface ProviderResume`, `interface ProviderPause`, `interface ProviderEvents`, `type ProviderStructuredOutput`, `interface ProviderToolRestrictions`, `type ProviderUsageCost`, `type ProviderHook`, `interface ProviderRunFiles`, `interface ProviderMeasurement`, `interface ProviderCapabilityManifest`, `providerManifestSchema`, `PROVIDER_MANIFESTS: Record<ProviderKind, ProviderCapabilityManifest>`, `manifestFor(kind): ProviderCapabilityManifest`, `SKILL_TOOL`, `providerRunsSkills(kind): boolean`
  - `packages/domain/src/provider/claude-code.ts`: `CLAUDE_CODE_MODELS`, `CLAUDE_CODE_MANIFEST`
  - `packages/domain/src/provider/cursor.ts`: `CURSOR_MANIFEST`
  - `packages/domain/src/permission/kinds.ts`: the same four names it exports today (`PERMISSION_PROVIDERS`, `PermissionProvider`, `TOOLS_BY_KIND`, `ENFORCE_BY_PROVIDER`), three of them now derived and one an alias
  - `packages/providers/src/types.ts`: `PROVIDER_KINDS` and `ProviderKind` re-exported from the domain, `RuntimeEvent['kind']` pinned to `RuntimeEventKind` both ways
  - `packages/providers/src/models.ts`: `ModelOption` and `CLAUDE_CODE_MODELS` re-exported, the SAME array object
  - `scripts/fixtures/m56a-goldens/`: twelve `permissions-*.json`, `argv.json`, `capabilities.json`, `models.json`, `tools-by-kind.json`, `enforce-by-provider.json`, `settings-cards.json`

**One rule about this task's own arithmetic.** Nothing here may be re-derived from something this task also wrote. The goldens come from the tree as it stands BEFORE the first edit; the manifests are transcribed from the files the spec cites, by hand, with the citation beside each value; and the two derived tables are asserted against the goldens by IDENTITY as well as by equality. A table that agrees with a golden it generated proves nothing.

- [ ] **Step 1: Capture the goldens, before one line is edited**

The tree must be clean and on the branch M56a forks from. Check it, out loud:

```bash
git status --porcelain | head
git log --oneline -1
npx tsc --build
```
Expected: no output from `git status --porcelain` (a dirty tree here means a golden would carry somebody else's edit), the M55 merge commit, and a green build — the capture imports `packages/control/dist` and `packages/providers/dist`, so the build must have run.

Write the capture into your **scratchpad**, never into the repository (`"$SCRATCHPAD/m56a-capture.mjs"`). It is deliberately not checked in: a capture script that lives beside the goldens is an invitation to re-run it the day one of them fails, which is the one thing a golden exists to prevent.

```js
// m56a-capture.mjs -- run ONCE, from the repository root, on the untouched tree:
//   node --env-file=.env "$SCRATCHPAD/m56a-capture.mjs"
// Reads and writes NOTHING in the database: `--env-file=.env` is only so the Prisma adapter that
// `packages/control/dist/permission.js` pulls in has a connection string to construct with.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PERMISSION_KINDS, PERMISSION_RUN_KINDS, TOOLS_BY_KIND, ENFORCE_BY_PROVIDER } from './packages/domain/dist/index.js'
import { writePermissionsFile } from './packages/control/dist/permission.js'
import { capabilitiesOf, claudeFlags, cursorFlags, listProviderModels, parseCursorModels, PROVIDER_KINDS } from './packages/providers/dist/index.js'

const OUT = 'scripts/fixtures/m56a-goldens'
mkdirSync(OUT, { recursive: true })
const write = (name, value) => writeFileSync(join(OUT, name), `${JSON.stringify(value, null, 2)}\n`)

// 1. permissions.json v2, twelve files. `runId` and `tokenHash`'s input are FIXED so the whole file
//    can be compared byte for byte rather than field by field.
const RUN_ID = '00000000-0000-4000-8000-000000000m56'
const RUN_TOKEN = 'm56a-golden-token-not-a-secret'
const GRANT_SETS = {
  baseline: [],
  granted: PERMISSION_KINDS.map((kind) => ({ kind, mode: 'allow' })),
}
for (const provider of PROVIDER_KINDS) {
  for (const runKind of PERMISSION_RUN_KINDS) {
    for (const [setName, rows] of Object.entries(GRANT_SETS)) {
      const dir = mkdtempSync(join(tmpdir(), 'm56a-golden-'))
      const path = writePermissionsFile(dir, { rows, provider, runKind, runId: RUN_ID, runToken: RUN_TOKEN })
      writeFileSync(join(OUT, `permissions-${provider}-${runKind}-${setName}.json`), readFileSync(path))
    }
  }
}

// 2. argv, element for element and in order. The settings path is absolute because `claudeFlags`
//    refuses a relative one, and that refusal is itself a golden (stage 3 re-asserts it).
write('argv.json', {
  claudeSettingsPath: '/tmp/m56a-golden/settings.json',
  claude: claudeFlags({ settingsPath: '/tmp/m56a-golden/settings.json' }),
  cursorPlain: cursorFlags({}),
  cursorModel: cursorFlags({ model: 'auto' }),
  cursorResume: cursorFlags({ resume: { sessionId: 'm56a-golden-session' } }),
  cursorModelAndResume: cursorFlags({ model: 'auto', resume: { sessionId: 'm56a-golden-session' } }),
})

// 3. The five capability members, per kind.
write('capabilities.json', Object.fromEntries(PROVIDER_KINDS.map((kind) => [kind, capabilitiesOf(kind)])))

// 4. The model answers. Cursor's is the PARSE of this repository's own recorded capture -- never a
//    live `cursor-agent models`, which would put an account's list in a fixture.
write('models.json', {
  claude_code: await listProviderModels('claude_code'),
  cursorParsed: parseCursorModels(readFileSync('packages/providers/test/fixtures/cursor/models.txt', 'utf8')),
})

// 5. The two per-vendor tables R5 inverts the ownership of.
write('tools-by-kind.json', TOOLS_BY_KIND)
write('enforce-by-provider.json', ENFORCE_BY_PROVIDER)
console.log('captured')
```

```bash
node --env-file=.env "$SCRATCHPAD/m56a-capture.mjs" && ls scripts/fixtures/m56a-goldens
```
Expected: `captured`, and seventeen files — twelve `permissions-*.json`, `argv.json`, `capabilities.json`, `models.json`, `tools-by-kind.json`, `enforce-by-provider.json`. **Read `permissions-cursor-planning-baseline.json` and `argv.json` before going on** and check them against the spec's own description: `enforce: "known-tools"` on the Cursor files and `"all-tools"` on the Claude ones, `vocabulary` holding `read`/`edit`/`shell` for Cursor and sixty-eight-odd names for Claude, and the Claude argv ending `--settings /tmp/m56a-golden/settings.json --include-hook-events`.

The eighteenth golden is written by hand, because `apps/web` is a Next app with no `dist` and no gate in this tree imports from it (erratum E17, and `scripts/gate-m29-simulation.mjs:80` says so in its own words). Transcribe it from `apps/web/src/server/settings.ts:32-40` and `capabilities.json`, with `slavesBound` deliberately absent — it is a `groupBy` over whatever `SlaveRun` rows the database holds, which is not a golden-able fact:

`scripts/fixtures/m56a-goldens/settings-cards.json`:

```json
[
  {
    "kind": "claude_code",
    "label": "Claude Code",
    "state": "connected",
    "version": "<resolver>",
    "adapter": "ClaudeCodeAdapter",
    "capabilities": { "gate": "all-tools", "reportsCost": true, "canPauseMidRun": true }
  },
  {
    "kind": "cursor",
    "label": "Cursor",
    "state": "connected",
    "version": "<resolver>",
    "adapter": "CursorAdapter",
    "capabilities": { "gate": "all-tools", "reportsCost": false, "canPauseMidRun": false }
  },
  {
    "kind": "codex",
    "label": "OpenAI Codex",
    "state": "later",
    "version": null,
    "adapter": "CodexAdapter — planned",
    "capabilities": null
  },
  {
    "kind": "gemini",
    "label": "Gemini",
    "state": "later",
    "version": null,
    "adapter": "GeminiAdapter — planned",
    "capabilities": null
  }
]
```

And the README that says where all eighteen came from:

`scripts/fixtures/m56a-goldens/README.md`:

```markdown
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
```

- [ ] **Step 2: Write the failing test for the union, the label table and the event kinds**

`packages/domain/test/provider/kind.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PROVIDER_KINDS, PROVIDER_LABEL, type ProviderKind } from '../../src/provider/kind.js'
import { RUNTIME_EVENT_KINDS, type RuntimeEventKind } from '../../src/provider/events.js'
import type { ModelOption } from '../../src/provider/models.js'

describe('ProviderKind (R2)', () => {
  it('is exactly the two configured provider kinds, in the Postgres enum order', () => {
    // The same two members, in the same order, as `packages/db/prisma/schema.prisma`'s
    // `enum ProviderKind` -- `enum-parity.test.ts` compares the SORTED lists, and this pins the
    // spelling a reviewer reads in a diff (the reason `packages/providers/test/types.test.ts:11`
    // gives for its own copy of this line, which stays where it is).
    expect(PROVIDER_KINDS).toEqual(['claude_code', 'cursor'])
  })

  it('gives every kind a WORD, and never the key itself (docs/ia.md rule 3)', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(PROVIDER_LABEL[kind], kind).toBeTruthy()
      expect(PROVIDER_LABEL[kind], kind).not.toBe(kind)
    }
    expect(PROVIDER_LABEL).toEqual({ claude_code: 'Claude Code', cursor: 'Cursor' })
  })

  it('is a total record, so a third kind is a build error here rather than a bare enum member on a card', () => {
    const labels: Record<ProviderKind, string> = PROVIDER_LABEL
    expect(Object.keys(labels).sort()).toEqual([...PROVIDER_KINDS].sort())
  })
})

describe('RuntimeEventKind (erratum E1)', () => {
  it('is the thirteen variants of `RuntimeEvent`, in the union’s own order', () => {
    expect(RUNTIME_EVENT_KINDS).toEqual([
      'session_started',
      'tool_call',
      'tool_result',
      'usage',
      'text',
      'hook_started',
      'hook_denied',
      'hook_crashed',
      'hook_failed_open',
      'permission_denied',
      'terminated',
      'ignored',
      'unparsable',
    ])
  })

  it('carries the two that are PARSER artefacts and not a vendor’s events', () => {
    // `ignored` is a recognised line this parser does not act on and `unparsable` is one it could
    // not read at all (`packages/providers/src/types.ts:73-77`). No manifest may list either --
    // `manifest.test.ts` asserts that from the other side -- but the union has to carry them,
    // because `RuntimeEvent['kind']` does and this list is pinned to it.
    expect(RUNTIME_EVENT_KINDS).toContain('ignored')
    expect(RUNTIME_EVENT_KINDS).toContain('unparsable')
  })

  it('has no duplicate member', () => {
    expect(new Set<RuntimeEventKind>(RUNTIME_EVENT_KINDS).size).toBe(RUNTIME_EVENT_KINDS.length)
  })
})

describe('ModelOption (erratum E2)', () => {
  it('is the three fields the providers package declared, and nothing else', () => {
    // A structural assertion, because the type is erased: a fourth REQUIRED field would fail to
    // compile here, which is the point -- `packages/providers/src/models.ts` re-exports this type
    // and `ModelListing.models` is an array of it.
    const option: ModelOption = { id: 'default', label: "default (the CLI's current default)", default: true }
    const minimal: ModelOption = { id: 'opus', label: 'opus (latest Opus)' }
    expect(Object.keys(option).sort()).toEqual(['default', 'id', 'label'])
    expect(Object.keys(minimal).sort()).toEqual(['id', 'label'])
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/provider/kind.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/provider/kind.js"`.

- [ ] **Step 4: Write the three leaf modules**

`packages/domain/src/provider/kind.ts`. The union and its guard are MOVED from `packages/providers/src/types.ts:3-37`, docstrings included and rewritten only where they describe where they now live; the label table is MOVED from `apps/web/src/lib/providerLabel.ts:26-48`:

```ts
/**
 * Which runtime a run is on (M56a R2 -- MOVED here from `packages/providers/src/types.ts`, which
 * re-exports it).
 *
 * A plain string union, not a re-export of the Postgres enum (`packages/db`'s generated
 * `ProviderKind`): `packages/domain` depends on nothing but `zod`, and `packages/db`'s enum is held
 * to this list by `packages/db/test/integration/enum-parity.test.ts` rather than by a type.
 *
 * THE DOMAIN AND NOT THE PROVIDERS PACKAGE, because the dependency direction decides it. Five
 * packages independently needed to enumerate these two members and four of them could not reach
 * `@slave-of-ai/providers`: its barrel re-exports two adapters that import `node:child_process` at
 * module scope with no `sideEffects: false` escape hatch, so a VALUE import of anything from it --
 * even a two-string list -- would force a client bundle to evaluate Node-only code.
 * `apps/web/src/components/SlavePanel.tsx:5-12` already value-imports `PERMISSION_PROVIDERS` and
 * `TOOLS_BY_KIND` from THIS package in a client component, which is the proof that this home works
 * and that one does not.
 *
 * `apps/web/src/lib/providerLabel.ts:41-43` argued the opposite before this milestone -- "inventing
 * a second home for it in the domain would put the union in three places instead of two" -- and it
 * is answered rather than contradicted: the union was in TEN places, and this MOVES it rather than
 * copying it, which is the case that sentence never considered.
 */
export type ProviderKind = 'claude_code' | 'cursor'

/**
 * Every member of `ProviderKind`, as data. The canonical source for any caller that needs to
 * enumerate the kinds -- `packages/control/src/org.ts`'s `isProviderKind` is the reason this
 * exists. A hand-rolled list with no link back to the type is exactly the failure this guards
 * against: a third kind added to the union above without a matching entry here now fails the BUILD
 * (see `_ProviderKindsComplete` below) instead of leaving a validator silently two-wide. Mirrors
 * `capabilitiesOf`'s own `const unhandled: never` idiom -- one canonical table beats several that
 * agree today.
 */
export const PROVIDER_KINDS = ['claude_code', 'cursor'] as const satisfies readonly ProviderKind[]

// Compile-time completeness check: `satisfies` above proves every element of `PROVIDER_KINDS` is
// a `ProviderKind` (soundness); this proves the reverse -- every `ProviderKind` is IN
// `PROVIDER_KINDS` (completeness) -- so omitting a member is a build error, not a silent gap.
type _AssertNever<T extends never> = T
type _ProviderKindsComplete = _AssertNever<Exclude<ProviderKind, (typeof PROVIDER_KINDS)[number]>>

/**
 * The word a person reads for a runtime (M44 R4, final review item I3 -- MOVED here from
 * `apps/web/src/lib/providerLabel.ts`, which re-exports it under the same name).
 *
 * `claude_code` is a COLUMN VALUE. It was visible text on four surfaces -- the Overview slave
 * card's chip, the slave panel's chip, the Workforce table's provider cell and every provider
 * `<select>` -- which is exactly what R4 forbids, and `scripts/gate-m44-ux-foundation.mjs` derives
 * its blocklist from `PROVIDER_KINDS` so a fifth surface cannot reintroduce it.
 *
 * A PROJECTION, never a replacement (the rule `packages/domain/src/status/user.ts` states for
 * statuses): every call site keeps the raw kind beside the word, in `title` on a chip and in
 * `value` on an `<option>` -- the value a form posts and a column stores is untouched.
 *
 * `Record<ProviderKind, string>` is load-bearing: a third kind fails the build here rather than
 * rendering as a bare enum member. It is the FIFTH of the six sites §4's checklist keeps, and the
 * reason it is kept is that a product's word for a vendor is not derivable from the vendor's
 * binary name.
 */
export const PROVIDER_LABEL: Record<ProviderKind, string> = {
  claude_code: 'Claude Code',
  cursor: 'Cursor',
}
```

`packages/domain/src/provider/events.ts`:

```ts
/**
 * Every variant `RuntimeEvent` has (M56a erratum E1).
 *
 * `RuntimeEvent` itself lives in `packages/providers/src/types.ts` and stays there -- it carries a
 * `ToolErrorClass` and a `RunOutcome` and is the providers package's own vocabulary. What a
 * MANIFEST needs is only the NAMES, so a provider can say which of them its stream can produce, and
 * a name is a thing the domain can hold.
 *
 * The list is pinned to the union in both directions at `packages/providers/src/types.ts`: a
 * fourteenth variant added there without a member here, or a member here that is not a variant,
 * fails the build in the file that did it. That pin is why this list may be trusted by a manifest
 * that cannot see the union it describes.
 *
 * ORDER IS THE UNION'S OWN, not alphabetical, so the two read side by side in a diff.
 *
 * `ignored` and `unparsable` are here because the union has them and are not a vendor's events:
 * the first is a recognised line a parser does not act on, the second one it could not read at all.
 * No manifest may list either (`providerManifestSchema`, `manifest.ts`).
 */
export const RUNTIME_EVENT_KINDS = [
  'session_started',
  'tool_call',
  'tool_result',
  'usage',
  'text',
  'hook_started',
  'hook_denied',
  'hook_crashed',
  'hook_failed_open',
  'permission_denied',
  'terminated',
  'ignored',
  'unparsable',
] as const

export type RuntimeEventKind = (typeof RUNTIME_EVENT_KINDS)[number]

/** The two members no runtime PRODUCES: a parser makes them out of a line it read or could not. */
export const PARSER_EVENT_KINDS = ['ignored', 'unparsable'] as const satisfies readonly RuntimeEventKind[]
```

`packages/domain/src/provider/models.ts`:

```ts
/**
 * One entry of a provider's model list: the id the CLI accepts after `--model`, and a label
 * (M56a erratum E2 -- MOVED here from `packages/providers/src/models.ts`, which re-exports it).
 *
 * It moved for one reason: a `configured` provider's manifest HOLDS its model table
 * (`ProviderModelDiscovery`), the manifest lives in this package, and this package cannot import
 * `@slave-of-ai/providers`. `ModelListing` -- the shape of an ANSWER, with its `source` and its
 * `error` -- stays there, because nothing about it is a fact about a vendor.
 */
export interface ModelOption {
  readonly id: string
  readonly label: string
  readonly default?: true
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run packages/domain/test/provider/kind.test.ts`
Expected: PASS — 7 cases.

- [ ] **Step 6: Write the failing test for the two manifests**

`packages/domain/test/provider/manifest.test.ts`. Every axis, both rows, and the three claims a reader has to be able to trust without opening a provider's source: that the list is total, that no row invents a value, and that `differences` is never empty — a provider with no stated limitation is a provider nobody measured.

```ts
import { describe, expect, it } from 'vitest'
import { PERMISSION_KINDS } from '../../src/permission/kinds.js'
import { PROVIDER_KINDS, type ProviderKind } from '../../src/provider/kind.js'
import { PARSER_EVENT_KINDS, RUNTIME_EVENT_KINDS } from '../../src/provider/events.js'
import {
  PROVIDER_MANIFESTS,
  SKILL_TOOL,
  manifestFor,
  providerManifestSchema,
  providerRunsSkills,
} from '../../src/provider/manifest.js'
import { CLAUDE_CODE_MODELS } from '../../src/provider/claude-code.js'

const AXES = [
  'kind',
  'invocation',
  'modelDiscovery',
  'resume',
  'pause',
  'events',
  'structuredOutput',
  'toolRestrictions',
  'toolVocabulary',
  'usageCost',
  'hooks',
  'runFiles',
  'measured',
  'differences',
] as const

describe('PROVIDER_MANIFESTS (R3)', () => {
  it('has exactly the members of PROVIDER_KINDS, so a third provider is a build error here first', () => {
    expect(Object.keys(PROVIDER_MANIFESTS).sort()).toEqual([...PROVIDER_KINDS].sort())
  })

  it('carries all fourteen axes on every row, and no fifteenth', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(Object.keys(PROVIDER_MANIFESTS[kind]).sort(), kind).toEqual([...AXES].sort())
    }
  })

  it('validates against its own schema, which is what the gate re-runs from the built module', () => {
    for (const kind of PROVIDER_KINDS) {
      const parsed = providerManifestSchema.safeParse(PROVIDER_MANIFESTS[kind])
      expect(parsed.success, `${kind}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true)
    }
  })

  it('says which kind it is, in its own row, so a copied row cannot pass for another', () => {
    for (const kind of PROVIDER_KINDS) expect(manifestFor(kind).kind).toBe(kind)
  })

  it('states at least one limitation per provider -- one with none is one nobody measured', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(manifestFor(kind).differences.length, kind).toBeGreaterThan(0)
      for (const sentence of manifestFor(kind).differences) expect(sentence.trim(), kind).not.toBe('')
    }
  })

  it('records the binary VERSION every row was measured against, which is the rule the widening one rests on', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(manifestFor(kind).measured.version, kind).toMatch(/\S/)
      expect(manifestFor(kind).measured.date, kind).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('names a binary and never holds a path or a secret', () => {
    for (const kind of PROVIDER_KINDS) {
      const { binary, binEnvVar, argsEnvVar } = manifestFor(kind).invocation
      expect(binary, kind).not.toContain('/')
      // The `SLAVEOFAI_<PROVIDER>_BIN` convention, declared ONCE here instead of being spelled at
      // four sites in three files (R6). The pair always agree on their stem, which is what lets
      // `buildAdapterRegistry`'s loop read both off the manifest.
      expect(binEnvVar, kind).toMatch(/^SLAVEOFAI_[A-Z]+_BIN$/)
      expect(argsEnvVar, kind).toBe(binEnvVar.replace(/_BIN$/, '_ARGS'))
    }
  })

  it('declares a tool vocabulary for every permission kind, and none for the two broker grants', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(Object.keys(manifestFor(kind).toolVocabulary).sort(), kind).toEqual([...PERMISSION_KINDS].sort())
      expect(manifestFor(kind).toolVocabulary.read_secret, kind).toEqual([])
      expect(manifestFor(kind).toolVocabulary.deploy_release, kind).toEqual([])
    }
  })

  it('produces only real event kinds, and never a parser artefact', () => {
    for (const kind of PROVIDER_KINDS) {
      for (const produced of manifestFor(kind).events.produces) {
        expect(RUNTIME_EVENT_KINDS, `${kind}: ${produced}`).toContain(produced)
        expect(PARSER_EVENT_KINDS as readonly string[], `${kind}: ${produced}`).not.toContain(produced)
      }
    }
  })

  it('declares exactly two run-file channels, both persisted, until Checkpoint gains a Json column (R7)', () => {
    for (const kind of PROVIDER_KINDS) {
      const runFiles = manifestFor(kind).runFiles
      expect(runFiles.channels, kind).toHaveLength(2)
      expect(runFiles.persisted, kind).toHaveLength(2)
      for (const name of runFiles.persisted) expect(runFiles.channels, kind).toContain(name)
    }
  })

  it('cites an ADR anchor for its pause rung, and never invents a fourth rung', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(['hook', 'signal', 'none'], kind).toContain(manifestFor(kind).pause.rung)
      expect(manifestFor(kind).pause.adr, kind).toMatch(/^docs\/decisions\/0001-pause-semantics\.md#[a-z0-9-]+$/)
    }
  })

  it('refuses a kind nothing declares, rather than answering undefined', () => {
    expect(() => manifestFor('codex' as ProviderKind)).toThrow(/codex/)
  })
})

describe('the Claude Code row (R3)', () => {
  const manifest = manifestFor('claude_code')

  it('is `claude`, prompted by a flag, with the two flags ADR 0001 forbids named as forbidden', () => {
    expect(manifest.invocation.binary).toBe('claude')
    expect(manifest.invocation.binEnvVar).toBe('SLAVEOFAI_CLAUDE_BIN')
    expect(manifest.invocation.argsEnvVar).toBe('SLAVEOFAI_CLAUDE_ARGS')
    expect(manifest.invocation.promptDelivery).toBe('flag')
    expect(manifest.invocation.headlessFlags).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--include-hook-events',
    ])
    expect(manifest.invocation.neverPass).toEqual(['--no-session-persistence', '--fork-session'])
    expect(manifest.invocation.cwd).toBe('worktree')
    expect(manifest.invocation.envAllowlist).toBe('CHILD_ENV_ALLOW')
  })

  it('configures its models rather than listing them, and the table is the one the CLI accepts', () => {
    expect(manifest.modelDiscovery.mode).toBe('configured')
    if (manifest.modelDiscovery.mode !== 'configured') throw new Error('unreachable')
    expect(manifest.modelDiscovery.options).toBe(CLAUDE_CODE_MODELS)
    expect(manifest.modelDiscovery.options.map((model) => model.id).slice(0, 5)).toEqual([
      'default',
      'fable',
      'opus',
      'sonnet',
      'haiku',
    ])
  })

  it('resumes by session id, on --resume, and never forks one', () => {
    expect(manifest.resume).toEqual({ mode: 'session_id', flag: '--resume', neverPass: ['--fork-session'] })
  })

  it('sits on ADR 0001’s hook rung, produces eleven kinds, and reports what it spent', () => {
    expect(manifest.pause.rung).toBe('hook')
    expect(manifest.events.transport).toBe('stream_json')
    expect([...manifest.events.produces].sort()).toEqual(
      [...RUNTIME_EVENT_KINDS].filter((kind) => !(PARSER_EVENT_KINDS as readonly string[]).includes(kind)).sort(),
    )
    expect(manifest.usageCost).toBe('reported')
  })

  it('gates every tool through a hook and enforces the whole matrix', () => {
    expect(manifest.toolRestrictions).toEqual({ mechanism: 'hook_gate', enforce: 'all-tools' })
    expect(manifest.hooks).toEqual(['pre_tool_use', 'post_tool_use'])
  })

  it('gets a schema-conformant answer by ASKING for one, like everything else in this tree (R8)', () => {
    expect(manifest.structuredOutput).toBe('prompted')
  })
})

describe('the Cursor row (R3)', () => {
  const manifest = manifestFor('cursor')

  it('is `cursor-agent`, prompted positionally, with six flags that look safe and are not', () => {
    expect(manifest.invocation.binary).toBe('cursor-agent')
    expect(manifest.invocation.binEnvVar).toBe('SLAVEOFAI_CURSOR_BIN')
    expect(manifest.invocation.argsEnvVar).toBe('SLAVEOFAI_CURSOR_ARGS')
    expect(manifest.invocation.promptDelivery).toBe('positional')
    expect(manifest.invocation.headlessFlags).toEqual(['--print', '--output-format', 'stream-json', '--trust', '--force'])
    expect(manifest.invocation.neverPass).toEqual([
      '-w',
      '--worktree',
      '--stream-partial-output',
      '--yolo',
      '--plan',
      '--mode',
    ])
  })

  it('lists its models from the account, by running `cursor-agent models`', () => {
    expect(manifest.modelDiscovery.mode).toBe('listed')
    if (manifest.modelDiscovery.mode !== 'listed') throw new Error('unreachable')
    expect(manifest.modelDiscovery.argv).toEqual(['models'])
  })

  it('resumes by session id and never by "the previous session"', () => {
    expect(manifest.resume).toEqual({ mode: 'session_id', flag: '--resume', neverPass: ['--continue'] })
  })

  it('sits on the signal rung, produces six kinds, and reports no cost at all', () => {
    expect(manifest.pause.rung).toBe('signal')
    expect(manifest.events.transport).toBe('stream_json')
    expect([...manifest.events.produces].sort()).toEqual(
      ['permission_denied', 'session_started', 'terminated', 'text', 'tool_call', 'tool_result'].sort(),
    )
    expect(manifest.events.produces).not.toContain('usage')
    for (const hookEvent of ['hook_started', 'hook_denied', 'hook_crashed', 'hook_failed_open']) {
      expect(manifest.events.produces, hookEvent).not.toContain(hookEvent)
    }
    expect(manifest.usageCost).toBe('unmeasured')
  })

  it('gates through a hook and can only enforce the names it can trust', () => {
    expect(manifest.toolRestrictions).toEqual({ mechanism: 'hook_gate', enforce: 'known-tools' })
    expect(manifest.hooks).toEqual(['pre_tool_use', 'before_shell_execution'])
  })

  it('says in words that its refusal is a BUDGET refusal and not an output-shape one (R8)', () => {
    expect(manifest.structuredOutput).toBe('prompted')
    expect(manifest.differences.join(' ')).toContain('it reports no cost, so a cap cannot be enforced')
  })
})

describe('providerRunsSkills (erratum E7)', () => {
  it('is true for the provider whose governed toolbox names the Skill tool, and false for the other', () => {
    expect(SKILL_TOOL).toBe('Skill')
    expect(providerRunsSkills('claude_code')).toBe(true)
    expect(providerRunsSkills('cursor')).toBe(false)
  })

  it('is the manifest’s own answer, not a second list of the two', () => {
    expect(providerRunsSkills('claude_code')).toBe(
      manifestFor('claude_code').toolVocabulary.run_commands.includes(SKILL_TOOL),
    )
  })
})
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/provider/manifest.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/provider/manifest.js"`.

- [ ] **Step 8: Write the manifest type, the two rows, and the barrel**

`packages/domain/src/provider/manifest.ts`. Fourteen axes and no fifteenth: every one of them has a consumer named in the ruling that asks for it, and a capability nothing reads is a claim nothing checks (`packages/providers/src/claude/adapter.ts:28-31`'s rule, applied one level out).

```ts
import { z } from 'zod'
// TYPE ONLY, and load-bearing: `permission/kinds.ts` imports `manifestFor` from this module as a
// VALUE, so a value import back would be a runtime cycle and a module-evaluation order nobody can
// reason about. `import type` is erased, which makes the dependency one-directional at run time
// while staying total at compile time.
import type { PermissionKind } from '../permission/kinds.js'
import { CLAUDE_CODE_MANIFEST } from './claude-code.js'
import { CURSOR_MANIFEST } from './cursor.js'
import type { RuntimeEventKind } from './events.js'
import { PROVIDER_KINDS, type ProviderKind } from './kind.js'
import type { ModelOption } from './models.js'

/**
 * How a run of this provider is started (R3).
 *
 * `binary` NAMES a binary, it does not hold one: the manifest carries no path, no secret and no
 * per-run value, so a client bundle that imports it gets strings. `binEnvVar`/`argsEnvVar` declare
 * the `SLAVEOFAI_<PROVIDER>_BIN` convention ONCE -- before this milestone it was spelled at four
 * sites in three files, and `apps/orchestrator/src/require-fake-cli.ts`'s spend net knew only the
 * first of them.
 *
 * `cwd` and `envAllowlist` are constants and are here anyway, because they are the two facts a
 * third provider's author is most likely to assume rather than read: every run happens in the
 * worktree the orchestrator made for it, and the child's environment is `CHILD_ENV_ALLOW`'s twelve
 * names and nothing else (`packages/providers/src/runtime/process.ts:156-169`). A per-provider copy
 * of that list is the first place an operator's API key gets re-added, so the field names the list
 * and does not hold one.
 */
export interface ProviderInvocation {
  readonly binary: string
  readonly binEnvVar: string
  readonly argsEnvVar: string
  /** The flags this adapter passes on EVERY spawn, in order. The variable parts -- `--settings
   *  <path>`, `--model <id>`, `--resume <id>` -- are not here: this is the constant half, and the
   *  gate asserts it is an in-order subsequence of the real argv (plan erratum E12). */
  readonly headlessFlags: readonly string[]
  readonly promptDelivery: 'flag' | 'positional'
  /** Flags this vendor really has that this adapter must NEVER emit, each one measured. */
  readonly neverPass: readonly string[]
  readonly cwd: 'worktree'
  readonly envAllowlist: 'CHILD_ENV_ALLOW'
}

/**
 * Where this provider's model list comes from (R6).
 *
 * A discriminated union rather than a record with two optional halves: `listProviderModels` branches
 * on `mode` and then reads exactly one of `argv`/`options`, and `exactOptionalPropertyTypes` makes
 * "present but undefined" a different thing from absent -- so the union is the shape that cannot be
 * read wrong. `'none'` is declarable and unused: a provider whose models are neither listed nor
 * configured answers an empty listing, which is honest and which no shipped provider does.
 */
export type ProviderModelDiscovery =
  | { readonly mode: 'listed'; readonly argv: readonly string[] }
  | { readonly mode: 'configured'; readonly options: readonly ModelOption[] }
  | { readonly mode: 'none' }

/**
 * Whether a stopped session can be continued, and how (R4: `canResumeSession` is `mode !== 'none'`).
 *
 * `neverPass` is the RESUME-specific list and overlaps the invocation's only where a flag is wrong
 * everywhere: Claude's `--fork-session` is both (it mints a new session id, ADR 0001 §3), Cursor's
 * `--continue` is only here (it picks "the previous session" by the CLI's own reckoning rather than
 * by id, `packages/providers/src/cursor/adapter.ts:263-265`) and is a perfectly ordinary flag for
 * anything that is not a resume.
 */
export interface ProviderResume {
  readonly mode: 'session_id' | 'none'
  /** The flag that carries the id, or `null` when `mode` is `'none'`. */
  readonly flag: string | null
  readonly neverPass: readonly string[]
}

/**
 * Which rung of ADR 0001's degradation ladder this provider sits on (R4) -- the ladder as DATA,
 * with the ADR as its rationale.
 *
 *   `'hook'`   hooks that can DENY: the run stops between tool calls and stays resumable in place.
 *              `capabilitiesOf` reads `canPauseMidRun: true` from this.
 *   `'signal'` resume without a mid-run stop: pausing IS cancelling the process and continuing the
 *              session later -- whether because there are no hooks, because they are advisory, or
 *              because the gate refuses calls without suspending the run (Cursor's case, where ADR
 *              lines 320-326 and 332-337 collapse onto the same behaviour).
 *   `'none'`   neither hooks nor resume. DECLARABLE and UNREGISTRABLE: `admitAdapter`
 *              (`packages/providers/src/registry.ts:57-61`) refuses an adapter with neither
 *              capability, and the recap-based continuation the ADR describes at lines 327-333 has
 *              never been built. The manifest may spell it; the registry will refuse it; the spec's
 *              §7 carries the gap rather than pretending the bottom rung works.
 *
 * `adr` is the anchor, and the ADR gains NO new text for it: the ADR is the rationale, this row is
 * the claim.
 */
export interface ProviderPause {
  readonly rung: 'hook' | 'signal' | 'none'
  readonly adr: string
}

/** What this provider's stream is, and which `RuntimeEvent` kinds it can produce at all. Never
 *  `ignored` or `unparsable`: those are what a PARSER makes of a line, not what a vendor sent. */
export interface ProviderEvents {
  readonly transport: 'stream_json' | 'line_json' | 'text'
  readonly produces: readonly RuntimeEventKind[]
}

/**
 * How a caller gets a schema-conformant JSON result out of this provider, distinct from its
 * narration stream (R8). Both rows read `'prompted'`, and M56a implements nothing for this axis:
 * this repository has exactly one structured-output mechanism and it is prompt-and-parse
 * (`packages/domain/src/supervisor/prompt.ts:43` asks for a `candidateIndex` object in words and
 * `:125-142` takes the FIRST JSON object out of the answer). The axis exists so M56b/M56c can
 * record a `'native'` a vendor actually has instead of discovering it three tasks into an
 * implementation.
 */
export type ProviderStructuredOutput = 'native' | 'prompted' | 'none'

/**
 * The two separate facts about restricting tools that happen to be true-and-true for both shipped
 * providers, which is why the distinction has never been forced to matter (R5).
 *
 *   `mechanism` is HOW a call is stopped: a hook that can deny, a flag that allow-lists, or nothing.
 *   `enforce`   is HOW MUCH of the matrix that mechanism can be trusted with -- `'all-tools'` when
 *               an unmatched name may be denied, `'known-tools'` when it may not, because the
 *               payload's casing cannot be matched against the vocabulary (Cursor's measured
 *               limitation, `packages/domain/src/permission/kinds.ts:235-247`).
 *
 * `mechanism: 'none'` is what says the four non-brokered permission kinds are not answered for a
 * vendor: `read_secret` and `deploy_release` are answered for ANY CLI-shaped provider by M52's
 * broker channel, and the other four need a real PreToolUse-shaped interception.
 */
export interface ProviderToolRestrictions {
  readonly mechanism: 'hook_gate' | 'flag_allowlist' | 'none'
  readonly enforce: 'all-tools' | 'known-tools'
}

/**
 * Whether a finished run's cost is knowable, and from where. `'reported'` means the runtime's own
 * terminal line carries a figure; `'estimated'` means it does not but a price table can produce
 * one; `'unmeasured'` means neither, which is Cursor's honest value and the reason
 * `estimateCostUsd` returns `null` rather than `0` for it.
 */
export type ProviderUsageCost = 'reported' | 'estimated' | 'unmeasured'

/** The hook points this adapter registers. `[]` means a provider with no hook plane at all. */
export type ProviderHook = 'pre_tool_use' | 'post_tool_use' | 'before_shell_execution'

/**
 * The files a run of this provider needs in order to be resumed later (R7).
 *
 * `channels` are the KEYS `RunHandle.runFiles` comes back under; `persisted` is the ordered pair
 * that survives a pause, mapped onto `Checkpoint.settingsPath`/`.hookPath` by `checkpointRunFiles`
 * and nowhere else. This generalises the ADAPTER side and not the PERSISTENCE side, and the
 * residual is named rather than hidden: a provider with three channels can declare three and an
 * adapter can return them, but only two survive a pause, so the gate asserts `channels.length === 2`
 * for every registered provider until `Checkpoint` gains a `runFiles Json` column. Making that
 * column now would be a migration in a migration-free milestone, for a provider that does not
 * exist, against a shape nobody has measured.
 */
export interface ProviderRunFiles {
  readonly channels: readonly string[]
  readonly persisted: readonly [string, string]
}

/**
 * The binary version and date every value in this row was measured against.
 *
 * Not decoration: `packages/providers/src/capabilities.ts:81-85` says a recorded capability may only
 * ever be WIDENED by proof and never narrowed, never assumed true because a vendor's documentation
 * says so -- and a claim with no measurement beside it cannot be widened by proof, because nobody
 * can tell what it was proved against. `cursor-agent` self-updates between runs; `claude` does too.
 */
export interface ProviderMeasurement {
  readonly version: string
  readonly date: string
}

/**
 * One provider, on fourteen axes, as data (M56a R3).
 *
 * THE POINT OF THIS TYPE. Before it, the differences between this product's two runtimes lived in
 * five places no test could compare to each other: a TypeScript interface, a switch, an ADR, a
 * constant in another package, and several hundred lines of "measured, not assumed" comments. A
 * third provider had to be threaded through twenty-six edits in six packages, most of which failed
 * silently rather than loudly when they were missed. After it there is one row per provider, every
 * table that used to hold a second copy of one of these facts derives from it, and
 * `Record<ProviderKind, ProviderCapabilityManifest>` makes a missing row a BUILD failure.
 *
 * `differences` IS WHERE THE PROSE GOES. Every "measured, not assumed" caveat that used to live
 * only as a comment beside the code it constrained is a sentence in that array, and the comment at
 * its old site keeps a one-line pointer here. A row with an empty `differences` is a row nobody
 * measured, and the gate refuses one.
 */
export interface ProviderCapabilityManifest {
  readonly kind: ProviderKind
  readonly invocation: ProviderInvocation
  readonly modelDiscovery: ProviderModelDiscovery
  readonly resume: ProviderResume
  readonly pause: ProviderPause
  readonly events: ProviderEvents
  readonly structuredOutput: ProviderStructuredOutput
  readonly toolRestrictions: ProviderToolRestrictions
  /** This provider's own column of `TOOLS_BY_KIND`, which now DERIVES from here (R5). */
  readonly toolVocabulary: Readonly<Record<PermissionKind, readonly string[]>>
  readonly usageCost: ProviderUsageCost
  readonly hooks: readonly ProviderHook[]
  readonly runFiles: ProviderRunFiles
  readonly measured: ProviderMeasurement
  readonly differences: readonly string[]
}

const nonEmpty = z.string().min(1)

/**
 * The manifest, validated at run time as well as at compile time.
 *
 * The type is the real guard -- a missing axis is a build error -- and this is what a GATE can run
 * against the built module, where types are gone. It is `.strict()` at every level, so a fifteenth
 * field is a red schema rather than a silent extra; and it refuses the two parser-only event kinds,
 * which is the one rule the TypeScript type cannot express.
 *
 * `toolVocabulary` is `z.record(z.string(), …)` and NOT `z.enum(PERMISSION_KINDS)`: this module may
 * only import `PermissionKind` as a type (see the import's own comment), and the totality of the
 * record is what the type and `manifest.test.ts` assert between them.
 */
export const providerManifestSchema = z
  .object({
    kind: z.enum(PROVIDER_KINDS),
    invocation: z
      .object({
        binary: nonEmpty,
        binEnvVar: z.string().regex(/^SLAVEOFAI_[A-Z]+_BIN$/),
        argsEnvVar: z.string().regex(/^SLAVEOFAI_[A-Z]+_ARGS$/),
        headlessFlags: z.array(nonEmpty).min(1),
        promptDelivery: z.enum(['flag', 'positional']),
        neverPass: z.array(nonEmpty),
        cwd: z.literal('worktree'),
        envAllowlist: z.literal('CHILD_ENV_ALLOW'),
      })
      .strict(),
    modelDiscovery: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('listed'), argv: z.array(nonEmpty).min(1) }).strict(),
      z
        .object({
          mode: z.literal('configured'),
          options: z
            .array(z.object({ id: nonEmpty, label: nonEmpty, default: z.literal(true).optional() }).strict())
            .min(1),
        })
        .strict(),
      z.object({ mode: z.literal('none') }).strict(),
    ]),
    resume: z
      .object({ mode: z.enum(['session_id', 'none']), flag: nonEmpty.nullable(), neverPass: z.array(nonEmpty) })
      .strict(),
    pause: z
      .object({
        rung: z.enum(['hook', 'signal', 'none']),
        adr: z.string().regex(/^docs\/decisions\/0001-pause-semantics\.md#[a-z0-9-]+$/),
      })
      .strict(),
    events: z
      .object({
        transport: z.enum(['stream_json', 'line_json', 'text']),
        // A vendor produces events; `ignored` and `unparsable` are what a parser produces when it
        // meets a line it does not act on or cannot read, and no manifest may claim one.
        produces: z
          .array(z.enum(RUNTIME_EVENT_KINDS).refine((kind) => kind !== 'ignored' && kind !== 'unparsable'))
          .min(1),
      })
      .strict(),
    structuredOutput: z.enum(['native', 'prompted', 'none']),
    toolRestrictions: z
      .object({
        mechanism: z.enum(['hook_gate', 'flag_allowlist', 'none']),
        enforce: z.enum(['all-tools', 'known-tools']),
      })
      .strict(),
    toolVocabulary: z.record(z.string(), z.array(nonEmpty)),
    usageCost: z.enum(['reported', 'estimated', 'unmeasured']),
    hooks: z.array(z.enum(['pre_tool_use', 'post_tool_use', 'before_shell_execution'])),
    runFiles: z
      .object({ channels: z.array(nonEmpty).min(1), persisted: z.tuple([nonEmpty, nonEmpty]) })
      .strict(),
    measured: z.object({ version: nonEmpty, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict(),
    // A provider with no stated limitation is a provider nobody measured.
    differences: z.array(nonEmpty).min(1),
  })
  .strict()

/**
 * Every provider this product knows, by kind (R3).
 *
 * A TOTAL `Record`, which is the whole mechanism: a third `ProviderKind` with no row here is a
 * BUILD failure in this file before it is a missing case anywhere else, and `PROVIDER_ADAPTERS`
 * (`packages/providers/src/registry.ts`) is a `Record` over the same union so the two fail together.
 * This is where `capabilitiesOf`'s `const unhandled: never` guard moved to (M56a R4): it used to
 * catch a missing capability row one switch-case at a time, and it now catches a missing PROVIDER,
 * once, for every axis at the same moment.
 */
export const PROVIDER_MANIFESTS: Record<ProviderKind, ProviderCapabilityManifest> = {
  claude_code: CLAUDE_CODE_MANIFEST,
  cursor: CURSOR_MANIFEST,
}

/**
 * THE reader. A kind in, its measured row out.
 *
 * The `undefined` branch is not dead code: `noUncheckedIndexedAccess` types the lookup as
 * possibly-absent, and a `ProviderKind` can reach this from an unchecked cast at the two
 * historical-backfill sites (`apps/orchestrator/src/sweep.ts:940`, `resume.ts:73`). A thrown
 * sentence naming the kind is what those get, rather than `undefined` propagating into a manifest
 * read and throwing on a property three frames later.
 */
export function manifestFor(kind: ProviderKind): ProviderCapabilityManifest {
  const manifest = PROVIDER_MANIFESTS[kind]
  if (manifest === undefined) throw new Error(`manifestFor: unhandled provider kind ${JSON.stringify(kind)}`)
  return manifest
}

/**
 * The tool name a skill invocation arrives under, on the one provider that has skills
 * (`packages/domain/src/permission/kinds.ts:142`, and `apps/orchestrator/src/pump.ts:725` counts
 * them by it).
 */
export const SKILL_TOOL = 'Skill'

/**
 * Whether this provider has a skills mechanism at all (M56a erratum E7).
 *
 * TWO consumers, both of which used to name Cursor instead: `apps/orchestrator/src/pump.ts`'s
 * `runtimeReportsUsage`, which writes `skillCalls: Prisma.DbNull` -- the "we do not know" of M14
 * Decision 4 -- for a runtime that cannot report one, and `apps/orchestrator/src/runContext.ts`'s
 * `injectSkills`, which copies no skill files into a worktree a runtime will never read them from.
 *
 * DERIVED rather than declared as a fifteenth axis, because the fact already exists in the row: a
 * provider's skills mechanism IS the `Skill` tool in its governed toolbox. Cursor's whole vocabulary
 * is `read`, `edit` and `shell`; Claude's `run_commands` column names `Skill` explicitly, and
 * `TOOLS_BY_KIND`'s own docstring says why it is a `run_commands` grant and not a `read_repo` one.
 */
export function providerRunsSkills(kind: ProviderKind): boolean {
  return manifestFor(kind).toolVocabulary.run_commands.includes(SKILL_TOOL)
}
```

`packages/domain/src/provider/claude-code.ts`. Every value carries the file it was read out of; nothing here is new, and nothing here is a judgement:

```ts
import type { PermissionKind } from '../permission/kinds.js'
import type { ProviderCapabilityManifest } from './manifest.js'
import type { ModelOption } from './models.js'

/**
 * The Claude Code CLI's `--model` accepts an alias for the latest model of a family
 * (`claude --help`: 'fable', 'opus', 'sonnet') or a full id. It lists nothing, so this table is
 * pinned by hand to the CLI version `ClaudeCodeAdapter` was last measured with and is updated with
 * the adapter. `default` is the CLI's own choice when no `--model` is passed.
 *
 * MOVED here from `packages/providers/src/models.ts:62-74` (M56a erratum E2), which re-exports it
 * under the same name and hands the SAME ARRAY back from `listClaudeCodeModels()` --
 * `packages/providers/test/models.test.ts:31` asserts that by identity. It lives here because a
 * `configured` provider's manifest holds its own model table and `packages/domain` cannot import
 * `packages/providers`; it also lands beside `guardrails/pricing.ts`, which prices six of these
 * eleven ids and whose own docstring already cites this table by name.
 */
export const CLAUDE_CODE_MODELS: readonly ModelOption[] = [
  { id: 'default', label: "default (the CLI's current default)", default: true },
  { id: 'fable', label: 'fable (latest Fable)' },
  { id: 'opus', label: 'opus (latest Opus)' },
  { id: 'sonnet', label: 'sonnet (latest Sonnet)' },
  { id: 'haiku', label: 'haiku (latest Haiku)' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
]

/**
 * The FULL governed toolbox this provider offers, per operation (M52 R1/R2) -- MOVED here from
 * `packages/domain/src/permission/kinds.ts:111-163`'s `claude_code` column, value for value and
 * order for order, and that table now derives from this one (M56a R5).
 *
 * THE CLASSIFICATION RULE is `kinds.ts`'s and is unchanged: a tool that only INSPECTS is
 * `read_repo`; a tool that can DO work, or spawn work that can, is `run_commands`; every `mcp__*`
 * name is `network_fetch` through a PREFIX rule in `toolKindFor` rather than as forty-one literals.
 * `read_secret` and `deploy_release` name NOTHING on purpose -- they are BROKER grants.
 *
 * The values are pinned by a test that DERIVES them from this repository's own recording of the
 * real CLI (`packages/domain/test/permission/kinds.test.ts`, unchanged by this milestone and re-run
 * as the proof), so a recaptured fixture that gains a name is a red test rather than a silent wall.
 */
const CLAUDE_CODE_TOOLS: Readonly<Record<PermissionKind, readonly string[]>> = {
  read_repo: [
    'Read',
    'Glob',
    'Grep',
    'NotebookRead',
    'TodoWrite',
    'ToolSearch',
    'TaskOutput',
    'ListAgents',
    'Monitor',
    'LSP',
    'ListMcpResourcesTool',
    'ReadMcpResourceTool',
    'ReadMcpResourceDirTool',
  ],
  write_repo: ['Write', 'Edit', 'NotebookEdit'],
  run_commands: [
    'Bash',
    'BashOutput',
    'KillShell',
    'Task',
    'TaskStop',
    'Skill',
    'Workflow',
    'SendMessage',
    'EnterWorktree',
    'ExitWorktree',
    'EnterPlanMode',
    'ExitPlanMode',
    'CronCreate',
    'CronDelete',
    'CronList',
    'ScheduleWakeup',
    'RemoteTrigger',
    'PushNotification',
    'ReportFindings',
    'DesignSync',
  ],
  network_fetch: ['WebFetch', 'WebSearch'],
  read_secret: [],
  deploy_release: [],
}

/**
 * Claude Code, measured (M56a R3).
 *
 * Every value below was read out of a file in this repository rather than out of a vendor's
 * documentation, and the file is named beside it. Nothing here is new: this row is where facts that
 * were already true went, not a claim anybody made for the first time while writing it.
 */
export const CLAUDE_CODE_MANIFEST: ProviderCapabilityManifest = {
  kind: 'claude_code',
  invocation: {
    binary: 'claude',
    binEnvVar: 'SLAVEOFAI_CLAUDE_BIN',
    argsEnvVar: 'SLAVEOFAI_CLAUDE_ARGS',
    // `packages/providers/src/claude/flags.ts:31-40`, the constant half in its own order. The
    // variable pair `--settings <absolute path>` sits between `bypassPermissions` and
    // `--include-hook-events` in the real argv, which is why the gate asserts a SUBSEQUENCE rather
    // than a prefix (plan erratum E12).
    headlessFlags: [
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--include-hook-events',
    ],
    promptDelivery: 'flag',
    // ADR 0001 §3: the first makes resume impossible, the second mints a new session id on resume.
    neverPass: ['--no-session-persistence', '--fork-session'],
    cwd: 'worktree',
    envAllowlist: 'CHILD_ENV_ALLOW',
  },
  // "The CLI lists nothing" -- there is no `claude models` (`packages/providers/src/models.ts:56-61`).
  modelDiscovery: { mode: 'configured', options: CLAUDE_CODE_MODELS },
  resume: { mode: 'session_id', flag: '--resume', neverPass: ['--fork-session'] },
  pause: {
    rung: 'hook',
    adr: 'docs/decisions/0001-pause-semantics.md#providercapabilities-for-the-claude-code-adapter-spec-7',
  },
  events: {
    transport: 'stream_json',
    // Every semantic kind there is: ten from `parseStreamLine` and `usage`, which the adapter
    // pushes from `parseStreamUsage` (`claude/adapter.ts:597`) rather than the line parser --
    // which is why the gate's replay can only prove a subset and asserts the complement instead
    // (plan erratum E15).
    produces: [
      'session_started',
      'tool_call',
      'tool_result',
      'usage',
      'text',
      'hook_started',
      'hook_denied',
      'hook_crashed',
      'hook_failed_open',
      'permission_denied',
      'terminated',
    ],
  },
  structuredOutput: 'prompted',
  toolRestrictions: { mechanism: 'hook_gate', enforce: 'all-tools' },
  toolVocabulary: CLAUDE_CODE_TOOLS,
  usageCost: 'reported',
  hooks: ['pre_tool_use', 'post_tool_use'],
  runFiles: { channels: ['settings', 'hook'], persisted: ['settings', 'hook'] },
  // `packages/providers/src/runtime/process.ts:135-138`, the most recent dated measurement against
  // this binary in the tree (M52's `CHILD_ENV_ALLOW` run). The binary installed when M56a was
  // designed was `claude 2.1.270`, one patch ahead, and NOTHING was re-measured for this milestone
  // -- see `differences`.
  measured: { version: 'claude 2.1.269', date: '2026-09-12' },
  differences: [
    '`--settings` must be an ABSOLUTE path: a settings file the CLI cannot find never registers the PreToolUse hook, and there is no error anywhere in the event stream -- the run spawns cleanly, every tool call goes through, and the terminal result reports a clean success. `claudeFlags` refuses a relative path before a process exists.',
    'No `--allowedTools` is passed at all, so every one of the ~68 tools the `system`/`init` line advertises is live; the permission matrix restricts through the PreToolUse hook verdict, never through a CLI flag.',
    "Per-turn `usage` events are a documented FLOOR and not a total: a streamed message's per-turn usage is not what the turn was billed, and the terminal `result` line REPLACES both halves with the authoritative figures.",
    'The PostToolUse tap is an optional GAP FILLER: it never writes stdout, always exits 0, and the stream wins whenever both produce a result for the same tool call. A deployment without it runs exactly as it did before M51.',
    'Hook exit codes were measured, not assumed (M3 Task 1): allow is exit 0 with empty stdout, deny is exit 0 with a JSON body, exit 2 fails CLOSED, and exits 1/126/127 fail OPEN.',
    'The `default` model id is deliberately unpriced -- the CLI’s current choice is not knowable from inside this repository -- so a run on `default` reports the cost the CLI reports and can never be estimated.',
    '`CHILD_ENV_ALLOW` was measured against `claude 2.1.269` and the binary installed at M56a was `2.1.270`. One patch of drift on a twelve-name allowlist, re-measured by the next milestone that changes the list rather than by one that does not touch it.',
  ],
}
```

`packages/domain/src/provider/cursor.ts`:

```ts
import type { PermissionKind } from '../permission/kinds.js'
import type { ProviderCapabilityManifest } from './manifest.js'

/**
 * Cursor's governed toolbox -- exactly three lowercase names, MOVED from
 * `packages/domain/src/permission/kinds.ts:111-163`'s `cursor` column (M56a R5).
 *
 * Three, and not a shortened Claude list: these are the names Cursor's own payloads carry, and
 * `ENFORCE_BY_PROVIDER`'s `'known-tools'` (now `toolRestrictions.enforce`) is the measured reason
 * the gate may only enforce the ones it can match.
 */
const CURSOR_TOOLS: Readonly<Record<PermissionKind, readonly string[]>> = {
  read_repo: ['read'],
  write_repo: ['edit'],
  run_commands: ['shell'],
  network_fetch: [],
  read_secret: [],
  deploy_release: [],
}

/**
 * Cursor, measured (M56a R3) -- and measured is the operative word: every value below was proved
 * against the installed binary in M12 Task 11 and M13 Task 9, and two of the claims the M12 spec
 * originally made were overturned by that proof rather than confirmed by it.
 */
export const CURSOR_MANIFEST: ProviderCapabilityManifest = {
  kind: 'cursor',
  invocation: {
    binary: 'cursor-agent',
    binEnvVar: 'SLAVEOFAI_CURSOR_BIN',
    argsEnvVar: 'SLAVEOFAI_CURSOR_ARGS',
    // `packages/providers/src/cursor/flags.ts:73`, the constant half, in order.
    headlessFlags: ['--print', '--output-format', 'stream-json', '--trust', '--force'],
    promptDelivery: 'positional',
    // `cursor/flags.ts:35-54`. Each one is a flag `cursor-agent` really has, each was tested
    // separately, and each looks safe.
    neverPass: ['-w', '--worktree', '--stream-partial-output', '--yolo', '--plan', '--mode'],
    cwd: 'worktree',
    envAllowlist: 'CHILD_ENV_ALLOW',
  },
  // The only provider whose model list is read from the live account rather than hand-pinned
  // (`packages/providers/src/models.ts:80-90`, `<binary> models`, 10 s, never throws).
  modelDiscovery: { mode: 'listed', argv: ['models'] },
  resume: { mode: 'session_id', flag: '--resume', neverPass: ['--continue'] },
  pause: {
    rung: 'signal',
    adr: 'docs/decisions/0001-pause-semantics.md#degradation-path-if-a-provider-lacks-hooks-spec-7',
  },
  events: {
    transport: 'stream_json',
    // Six. No `usage` -- the stream carries none, and the `result` line's own usage is the only
    // figure there is -- and none of the four `hook_*` variants, because `classifyGateEvent` is
    // never invoked for this runtime by design.
    produces: ['session_started', 'tool_call', 'tool_result', 'text', 'permission_denied', 'terminated'],
  },
  structuredOutput: 'prompted',
  toolRestrictions: { mechanism: 'hook_gate', enforce: 'known-tools' },
  toolVocabulary: CURSOR_TOOLS,
  usageCost: 'unmeasured',
  hooks: ['pre_tool_use', 'before_shell_execution'],
  // `.cursor/hooks.json` in the WORKTREE and the gate script -- two files that are neither a
  // settings file nor a hook, reported under the pair's names because the Postgres columns are
  // those two (`cursor/adapter.ts:196`).
  runFiles: { channels: ['settings', 'hook'], persisted: ['settings', 'hook'] },
  // `packages/providers/src/capabilities.ts:77-79` and `cursor/hooks.ts:65-67` both record this
  // version, and the binary self-updates between runs.
  measured: { version: 'cursor-agent 2026.08.25-3e8eec8', date: '2026-08-29' },
  differences: [
    "`--trust`'s absence is INVISIBLE: in a directory the user has not already trusted, `cursor-agent` exits 1 with a completely empty stdout -- no `system`/`init` line, no `result` line -- and prints “Workspace Trust Required” to stderr only. Every fresh worktree this system creates is exactly such a directory.",
    "`--force` is this vendor's `bypassPermissions`, and its help text's trailing clause -- “unless explicitly denied” -- is load-bearing: it is what keeps the gate's own deny effective under it.",
    '`--resume [chatId]` takes an OPTIONAL argument, so a bare `--resume` swallows the positional prompt as a chat id and leaves the run with no prompt at all. `cursorFlags` structurally cannot emit one: the flag and its id are pushed in the same statement.',
    'The `preToolUse` registration carries NO matcher, and that is measured rather than cautious: this vendor’s edit tool reads its target before writing it, and both steps are gated under the edit call’s own id, so a write was stopped at a `preToolUse` invocation whose `tool_name` was `"Read"`. A matcher scoped to `^(Write|Shell)$` would have let that write through.',
    '`numTurns` has no equivalent in this stream at all: the adapter DERIVES it by counting `assistant` lines while consuming, and overwrites the parser’s `0` before the event leaves `events()`. The parser’s zero must never reach an operator as a figure this vendor reported.',
    '`deniedToolUseIds` is populated from `tool_call`/`completed` lines whose `result.rejected` is set, and NEVER from `result.error`: an ordinary tool error is indistinguishable from a fail-closed gate block, so a fail-closed stop is silently not counted there, though its text still reaches the operator on the terminal line.',
    'The stream does not end at readline close. A real run left a detached worker-server family holding a DUP of this binary’s own stdout write end, so the pipe never closed even after the process itself exited; the adapter ends on the child’s `exit` event plus a 300 ms quiesce window re-armed per chunk.',
    'A run that wrote NOTHING to stdout is diagnosed as the workspace-trust refusal, with the captured stderr included verbatim rather than guessed -- and deliberately not synthesised for a cancelled or signalled run, which is an ordinary reason to write nothing.',
    'The `preToolUse` payload arrives with Claude-shaped casing (`"Read"`/`"Shell"`/`"Write"`) that never matches this vendor’s own lowercase vocabulary, so the gate is told to enforce only the names it can trust (`toolRestrictions.enforce: known-tools`). Under an allow list, matching them naively would deny every call this runtime makes.',
    'It reports no cost at all: the `result` line carries no cost figure, no model in this table is priced, and `estimateCostUsd` therefore answers `null` rather than `0`. This is why an llm-decision simulation refuses this provider -- "it reports no cost, so a cap cannot be enforced" -- which is a BUDGET refusal and not a statement about its output shape.',
    'Only a shell call and an edit call were ever exercised: no MCP call and no subagent call has been measured on this runtime.',
  ],
}
```

`packages/domain/src/provider/index.ts`:

```ts
export * from './kind.js'
export * from './events.js'
export * from './models.js'
export * from './manifest.js'
export * from './claude-code.js'
export * from './cursor.js'
```

`packages/domain/src/index.ts` — one line, in the same shape as its neighbours, placed after `./permission/index.js` so a reader meets the permission vocabulary before the providers that speak it:

```ts
export * from './permission/index.js'
export * from './provider/index.js'
export * from './broker/index.js'
```

- [ ] **Step 9: Run it and watch it pass**

Run: `npx vitest run packages/domain/test/provider/`
Expected: PASS — 29 cases across the two files.

- [ ] **Step 10: Write the failing test for the two derived tables**

`packages/domain/test/provider/derived.test.ts`. Two claims, and the second is the one that fails today: the tables hold the same values they always held, AND they hold the manifest's own arrays rather than copies that agree. The identity half is the `capabilities.test.ts:36-42` idiom — "two frozen objects that happen to agree today would satisfy `toEqual` and still drift apart on the first edit to either one, which is exactly the failure this ruling exists to prevent".

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ENFORCE_BY_PROVIDER,
  PERMISSION_KINDS,
  PERMISSION_PROVIDERS,
  TOOLS_BY_KIND,
  TOOL_VOCABULARY,
  toolKindFor,
} from '../../src/permission/kinds.js'
import { PROVIDER_KINDS } from '../../src/provider/kind.js'
import { manifestFor } from '../../src/provider/manifest.js'

/** The goldens `scripts/fixtures/m56a-goldens/` captured from the tree BEFORE this milestone
 *  edited anything. Read from disk rather than transcribed, so this file cannot drift from the
 *  bytes the gate compares against. */
const golden = (name: string): unknown => JSON.parse(readFileSync(`scripts/fixtures/m56a-goldens/${name}`, 'utf8'))

describe('PERMISSION_PROVIDERS (R2)', () => {
  it('is the same list under the same name -- `enum-parity.test.ts` still reads it', () => {
    expect(PERMISSION_PROVIDERS).toEqual(['claude_code', 'cursor'])
  })

  it('IS `PROVIDER_KINDS`, not a list that agrees with it', () => {
    expect(PERMISSION_PROVIDERS).toBe(PROVIDER_KINDS)
  })
})

describe('TOOLS_BY_KIND (R5)', () => {
  it('is byte for byte the table this milestone found', () => {
    expect(TOOLS_BY_KIND).toEqual(golden('tools-by-kind.json'))
  })

  it('holds each manifest’s OWN array, so a vocabulary cannot be edited in two places', () => {
    for (const kind of PERMISSION_KINDS) {
      for (const provider of PROVIDER_KINDS) {
        expect(TOOLS_BY_KIND[kind][provider], `${kind}.${provider}`).toBe(manifestFor(provider).toolVocabulary[kind])
      }
    }
  })

  it('keeps its shape: every permission kind, every provider, in both directions', () => {
    expect(Object.keys(TOOLS_BY_KIND).sort()).toEqual([...PERMISSION_KINDS].sort())
    for (const kind of PERMISSION_KINDS) {
      expect(Object.keys(TOOLS_BY_KIND[kind]).sort(), kind).toEqual([...PROVIDER_KINDS].sort())
    }
  })
})

describe('TOOL_VOCABULARY and toolKindFor (R5: untouched, and asserted so)', () => {
  it('still derives from TOOLS_BY_KIND and still answers for every governed name', () => {
    for (const provider of PROVIDER_KINDS) {
      for (const kind of PERMISSION_KINDS) {
        for (const tool of TOOLS_BY_KIND[kind][provider]) {
          expect(TOOL_VOCABULARY[provider][tool], `${provider}.${tool}`).toBe(kind)
          expect(toolKindFor(provider, tool), `${provider}.${tool}`).toBe(kind)
        }
      }
    }
  })

  it('still resolves an MCP name by prefix on both providers, and an unknown one to null', () => {
    for (const provider of PROVIDER_KINDS) {
      expect(toolKindFor(provider, 'mcp__acme__search')).toBe('network_fetch')
      expect(toolKindFor(provider, 'SomethingNobodyGoverns')).toBeNull()
    }
  })
})

describe('ENFORCE_BY_PROVIDER (R5)', () => {
  it('is the table this milestone found', () => {
    expect(ENFORCE_BY_PROVIDER).toEqual(golden('enforce-by-provider.json'))
    expect(ENFORCE_BY_PROVIDER).toEqual({ claude_code: 'all-tools', cursor: 'known-tools' })
  })

  it('is the manifest’s own answer, one field away', () => {
    for (const provider of PROVIDER_KINDS) {
      expect(ENFORCE_BY_PROVIDER[provider], provider).toBe(manifestFor(provider).toolRestrictions.enforce)
    }
  })
})
```

- [ ] **Step 11: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/provider/derived.test.ts`
Expected: FAIL — three cases. `PERMISSION_PROVIDERS` is a different array object from `PROVIDER_KINDS` (`expected [ 'claude_code', 'cursor' ] to be [ 'claude_code', 'cursor' ] // Object.is equality`), and both identity assertions on `TOOLS_BY_KIND` and `ENFORCE_BY_PROVIDER` fail the same way. The three `toEqual` cases already pass, which is the point: the values are not what this task is changing.

- [ ] **Step 12: Invert the ownership in `permission/kinds.ts`**

Four edits, and `writePermissionsFile` is not one of them: it reads `ENFORCE_BY_PROVIDER` and `TOOL_VOCABULARY`, both of which keep their names and their shapes (`packages/control/src/permission.ts:76,80`).

Replace `kinds.ts:35-41`:

```ts
/**
 * The two providers a permission resolves against.
 *
 * BOTH NAMES ARE ALIASES NOW (M56a R2): the union has ONE declaration, in
 * `packages/domain/src/provider/kind.ts`, and these two names are what the permission vocabulary
 * has always called it. They are kept rather than replaced because `docs/ia.md` rule 2 is that
 * nothing is removed, only moved: `packages/db/test/integration/enum-parity.test.ts:148-151` pins
 * the Postgres enum to `PERMISSION_PROVIDERS` by that name, `writePermissionsFile` indexes
 * `ENFORCE_BY_PROVIDER` and `TOOL_VOCABULARY` with a `PermissionProvider`, and
 * `apps/web/src/components/SlavePanel.tsx:97-101` reads both in a client component.
 *
 * The old docstring's reason for a SECOND copy -- "spelled here because `packages/domain` may not
 * depend on `@slave-of-ai/providers`" -- is answered rather than contradicted: the union moved INTO
 * this package, so the dependency it was avoiding no longer exists.
 */
export const PERMISSION_PROVIDERS = PROVIDER_KINDS
export type PermissionProvider = ProviderKind
```

with, at the top of the file:

```ts
import { PROVIDER_KINDS, type ProviderKind } from '../provider/kind.js'
import { manifestFor } from '../provider/manifest.js'
```

Replace the literal `TOOLS_BY_KIND` (`kinds.ts:111-163`) with the derivation, keeping the whole docstring above it and adding one paragraph:

```ts
/**
 * The FULL governed toolbox per operation per provider -- the inverted `CAPABILITY_TOOLS`.
 *
 * … (the existing docstring, unchanged, down to and including the `read_secret`/`deploy_release`
 * paragraph) …
 *
 * DERIVED, since M56a R5, from each provider's own manifest rather than written here: a provider's
 * tool vocabulary is a fact about that provider, and it now lives in the row that holds every other
 * fact about it (`packages/domain/src/provider/claude-code.ts`, `provider/cursor.ts`). Not one value
 * moved -- `packages/domain/test/provider/derived.test.ts` pins the whole table against a golden
 * captured before the migration, and `kinds.test.ts` below still derives the Claude column from the
 * real CLI's own recording.
 */
export const TOOLS_BY_KIND: Record<PermissionKind, Record<PermissionProvider, readonly string[]>> =
  Object.fromEntries(
    PERMISSION_KINDS.map((kind) => [
      kind,
      Object.fromEntries(PROVIDER_KINDS.map((provider) => [provider, manifestFor(provider).toolVocabulary[kind]])),
    ]),
  ) as Record<PermissionKind, Record<PermissionProvider, readonly string[]>>
```

And `ENFORCE_BY_PROVIDER` (`kinds.ts:248-251`, erratum E14), keeping its docstring and adding the same one-line note:

```ts
export const ENFORCE_BY_PROVIDER: Record<PermissionProvider, 'all-tools' | 'known-tools'> = Object.fromEntries(
  PROVIDER_KINDS.map((provider) => [provider, manifestFor(provider).toolRestrictions.enforce]),
) as Record<PermissionProvider, 'all-tools' | 'known-tools'>
```

`TOOL_VOCABULARY` (`kinds.ts:177-185`) is **not edited**: it already derives from `TOOLS_BY_KIND` with this exact `Object.fromEntries(...) as …` idiom, which is why the derivation above is written in that shape rather than a new one.

- [ ] **Step 13: Run it and watch it pass, then run the two files that prove nothing moved**

Run: `npx vitest run packages/domain/test/provider/ packages/domain/test/permission/`
Expected: PASS. The two `permission/` files are UNCHANGED by this task and are the real assertion: `kinds.test.ts` derives the Claude toolbox from `packages/providers/test/fixtures/complete.ndjson`'s `system`/`init` line and compares it against `TOOLS_BY_KIND`, so a derivation that dropped or reordered one name is red there and not only in the golden.

- [ ] **Step 14: The providers package stops declaring what it now imports**

`packages/providers/src/types.ts:1-37` becomes a re-export plus the two-way pin erratum E1 asks for. The whole of the old union docstring moves with it (Step 4); what stays here is the note that says where it went and why a consumer may keep importing it from this path:

```ts
import type { ToolErrorClass } from './tool-result.js'
import { RUNTIME_EVENT_KINDS, type RuntimeEventKind } from '@slave-of-ai/domain'

/**
 * Which runtime a run is on.
 *
 * MOVED to `@slave-of-ai/domain` (M56a R2) and re-exported here so every existing import resolves
 * to the same symbol by the same path. The domain is where it can be reached from: this package's
 * barrel re-exports two adapters that import `node:child_process` at module scope, so a VALUE
 * import of anything from it -- even a two-string list -- forces a client bundle to evaluate
 * Node-only code, and four of the five packages that needed to enumerate these members could not.
 * See `packages/domain/src/provider/kind.ts` for the full reasoning and the completeness guard.
 */
export { PROVIDER_KINDS, type ProviderKind } from '@slave-of-ai/domain'
```

and, immediately after the `RuntimeEvent` union at the end of the file:

```ts
/**
 * `RuntimeEvent['kind']` and the domain's `RuntimeEventKind` are the same thirteen names, pinned in
 * BOTH directions (M56a erratum E1).
 *
 * A provider manifest declares which kinds its stream can produce, and the manifest lives in
 * `@slave-of-ai/domain`, which cannot import this file. So the domain declares the NAMES and this
 * is what keeps the two honest: a fourteenth variant added above without a member in
 * `RUNTIME_EVENT_KINDS` fails here, and a member there that is not a variant fails here too. The
 * `_AssertNever` idiom is `PROVIDER_KINDS`' own, one file over.
 */
type _AssertNever<T extends never> = T
type _EventKindsSound = _AssertNever<Exclude<RuntimeEventKind, RuntimeEvent['kind']>>
type _EventKindsComplete = _AssertNever<Exclude<RuntimeEvent['kind'], RuntimeEventKind>>
// A value read of the list, so the import above is not elided and the two checks above cannot be
// silently dropped by an "unused import" cleanup.
export const RUNTIME_EVENT_KIND_COUNT = RUNTIME_EVENT_KINDS.length
```

`packages/providers/src/models.ts` loses its own copies of the two things that moved (erratum E2). Delete the `ModelOption` interface (`:7-12`) and the `CLAUDE_CODE_MODELS` table (`:56-74`), and put in their place:

```ts
import { CLAUDE_CODE_MANIFEST, type ModelOption } from '@slave-of-ai/domain'

/**
 * One entry of a provider's model list. MOVED to `@slave-of-ai/domain` (M56a erratum E2) because a
 * `configured` provider's manifest holds its own model table and the domain cannot import this
 * package; re-exported here so `ModelListing` and every caller keep the path they have.
 */
export type { ModelOption } from '@slave-of-ai/domain'

/**
 * The Claude Code CLI's selectable models -- MOVED into that provider's manifest
 * (`packages/domain/src/provider/claude-code.ts`) and re-exported here under the same name.
 *
 * THE SAME ARRAY OBJECT, deliberately: `listClaudeCodeModels()` hands it back by reference and
 * `test/models.test.ts:31` asserts `listing.models).toBe(CLAUDE_CODE_MODELS)`. A copy here would
 * satisfy `toEqual` and fail that line, which is the test doing exactly its job.
 */
export const CLAUDE_CODE_MODELS: readonly ModelOption[] =
  CLAUDE_CODE_MANIFEST.modelDiscovery.mode === 'configured' ? CLAUDE_CODE_MANIFEST.modelDiscovery.options : []
```

The ternary is not defensiveness, it is the discriminated union's narrowing: `modelDiscovery` is a union and TypeScript will not read `options` off it without the check. The `[]` arm is unreachable for the row above it and is asserted so by `models.test.ts`'s existing `slice(0, 5)` case, which would fail on an empty list. (`listProviderModels`'s switch is Task 3's; nothing else in this file moves.)

Run: `npx vitest run packages/providers/test/types.test.ts packages/providers/test/models.test.ts packages/providers/test/capabilities.test.ts`
Expected: PASS, with all three files UNCHANGED — `PROVIDER_KINDS` still equals the two members through the re-export, `listing.models` is still the same object `CLAUDE_CODE_MODELS` names, and every `MODEL_PRICES` cross-check still resolves.

- [ ] **Step 15: Run the whole suite and RECORD the baseline**

```bash
npx tsc --build
npx vitest run 2>&1 | tail -20
```
Expected: zero failures, and **two numbers to write down in the task report** — the file count and the test count. Those two numbers are this milestone's floor: every later ladder in this plan is at or above them. The tree M55 merged into counted 357 test files before M55's five; this task adds three. **If the numbers are lower than the M55 Task 6 report's, stop and find out why before continuing** — this task moved a value table that four packages read, and only the full suite can see a consumer this plan did not name.

- [ ] **Step 16: Ladder and commit**

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```

```bash
git add scripts/fixtures/m56a-goldens packages/domain packages/providers/src/types.ts packages/providers/src/models.ts
git commit -m "$(cat <<'EOF'
feat(domain): m56a t1 — one union, two manifests, and the goldens that say nothing moved

The goldens come first and they come from the untouched tree: twelve `permissions.json` v2 captures,
the argv of both flag builders, both capability rows, both model answers and the two per-vendor
tables, all captured before the first line of this milestone was edited. The gate compares against
them and cannot write them, and the capture script is deliberately not checked in -- a golden one
keystroke from being regenerated is not a golden.

`ProviderKind` had TEN declarations in this tree. It has one now, in `packages/domain`, because that
is the package every consumer of a provider fact can reach: the domain depends on nothing but zod,
the providers package imports `node:child_process` at module scope, and `SlavePanel.tsx` already
value-imports this package in a client component. `packages/providers/src/types.ts` re-exports it, so
not one import line in the tree moved.

Two manifests say what each provider can do, on fourteen axes, as data -- invocation, model
discovery, resume, pause, events, structured output, tool restrictions, tool vocabulary, usage cost,
hooks, run files, the binary each row was measured against, and the differences. Not one value is
new: every one carries the file it was read out of, and `differences` is where the "measured, not
assumed" comments went -- Cursor's silent `--trust` failure, its load-bearing matcher-less
registration, its derived `numTurns`, Claude's absolute `--settings` requirement, the unpriced
`default` sentinel.

`TOOLS_BY_KIND` and `ENFORCE_BY_PROVIDER` keep their names and stop being sources: each is one
`Object.fromEntries` over the manifests, and the test asserts the table holds the manifest's OWN
arrays rather than copies that agree today. `writePermissionsFile` is not edited at all, and
`kinds.test.ts` -- which derives the toolbox from a recording of the real CLI -- is unchanged and
green, which is what makes "no value moved" a measurement.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RBVSwP5Paww1L1hqS7Dper
EOF
)"
```

---

### Task 2: One contract, in a file that belongs to neither vendor (R1, R4, R7, R8, E3, E4, E12, E13, D15–D26)

`packages/providers`, plus the three orchestrator relays the one interface change forces. After this task `SlaveRuntimeAdapter` is declared once, in one screen, in a directory neither vendor owns; `capabilitiesOf` is a projection of the manifests; and `RunHandle.runFiles` is a record keyed by channel name whose mapping onto the two `Checkpoint` columns happens in exactly one function. Not one import path in the tree changes, because `claude/adapter.ts` re-exports every moved symbol from the path everything already uses.

**Files:**
- Create: `packages/providers/src/contract/adapter.ts`, `packages/providers/test/contract.test.ts`
- Modify: `packages/providers/src/claude/adapter.ts`, `packages/providers/src/cursor/adapter.ts`, `packages/providers/src/capabilities.ts`, `packages/providers/src/index.ts`, `apps/orchestrator/src/tick.ts`, `apps/orchestrator/src/planning.ts`, `apps/orchestrator/src/review.ts`, `packages/providers/test/registry.test.ts`, `packages/providers/test/cursor-adapter.test.ts`, `packages/providers/test/adapter-resume.test.ts`
- Test: `packages/providers/test/contract.test.ts` (new) plus `adapter-start.test.ts`, `adapter-resume.test.ts`, `cursor-adapter.test.ts`, `registry.test.ts`, `packages/providers/test/integration/checkpoint-shape.test.ts` and the orchestrator's `tick`/`planning`/`review` integration files; **`capabilities.test.ts` is UNCHANGED and re-run**, which is what makes R4's "byte-identical" a measurement

**Interfaces:**
- Consumes: `manifestFor`, `PROVIDER_KINDS`, `type ProviderKind` (Task 1); `RunId` (`packages/domain/src/ids.ts`); `ModelListing` (`packages/providers/src/models.ts:21-25`); `RuntimeEvent` (`types.ts:79`); `Checkpoint` (`claude/checkpoint.ts:60-112`).
- Produces, for Tasks 3–6:
  - `packages/providers/src/contract/adapter.ts`: `interface ProviderCapabilities` (five members, unchanged), `interface StartRunInput` (nine fields, unchanged), `type RunFiles = Readonly<Record<string, string>>`, `interface RunHandle { runId; pid; runFiles: RunFiles }`, `interface SlaveRuntimeAdapter { readonly kind: ProviderKind; getCapabilities(); listModels(); start(); events(); cancel(); resume() }` — ONE declaration — and `checkpointRunFiles(kind, handle): { settingsPath: string; hookPath: string }`
  - the same five type names re-exported from `packages/providers/src/claude/adapter.ts`, so `registry.ts:1`, `cursor/adapter.ts:12`, `capabilities.ts:1`, `index.ts:21` and every `@slave-of-ai/control` re-export resolve unchanged
  - `capabilitiesOf(kind)` — same signature, same five members, **same object identity per kind**

- [ ] **Step 1: Write the failing test for the contract**

`packages/providers/test/contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { manifestFor, PROVIDER_KINDS, type ProviderKind } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter } from '../src/claude/adapter.js'
import { CursorAdapter } from '../src/cursor/adapter.js'
import { capabilitiesOf } from '../src/capabilities.js'
import { checkpointRunFiles, type RunFiles, type RunHandle } from '../src/contract/adapter.js'
import { brandRunId } from '@slave-of-ai/domain'

/** A handle shaped exactly as an adapter reports one, with the channel names its manifest
 *  declares -- never hand-spelled keys, so a provider that renamed a channel fails here. */
function handleFor(kind: ProviderKind, paths: readonly [string, string]): RunHandle {
  const channels = manifestFor(kind).runFiles.channels
  const runFiles: Record<string, string> = {}
  channels.forEach((channel, index) => {
    runFiles[channel] = paths[index] ?? `/tmp/m56a-${channel}`
  })
  return { runId: brandRunId('11111111-1111-4111-8111-111111111111'), pid: 4242, runFiles }
}

describe('the contract is declared in one place (R1)', () => {
  it('re-exports every moved type from `claude/adapter.js`, so no import in the tree moved', async () => {
    // A runtime check of the MODULE's exports, because the five names are types and types are
    // erased: what this asserts is that the re-export line exists and resolves.
    const claude = await import('../src/claude/adapter.js')
    const contract = await import('../src/contract/adapter.js')
    expect(typeof contract.checkpointRunFiles).toBe('function')
    expect(claude).toHaveProperty('ClaudeCodeAdapter')
  })

  it('names each adapter by its KIND, in the enum’s spelling, not by an invented id', () => {
    const claude = new ClaudeCodeAdapter({ command: 'claude', hookPath: '/opt/slaveofai/pause-gate.sh' })
    const cursor = new CursorAdapter({ command: 'cursor-agent', gatePath: '/opt/slaveofai/cursor-shell-gate.sh' })
    // `'claude-code'` -- hyphenated, and NOT the `ProviderKind` -- is the wrinkle two comments in
    // this tree exist to warn about (`packages/control/src/index.ts:16-19`,
    // `apps/web/src/server/overview.ts:762-765`). It is gone.
    expect(claude.kind).toBe('claude_code')
    expect(cursor.kind).toBe('cursor')
    expect(PROVIDER_KINDS).toContain(claude.kind)
    expect(PROVIDER_KINDS).toContain(cursor.kind)
  })
})

describe('capabilitiesOf is a projection of the manifest (R4)', () => {
  it('answers the SAME OBJECT for a kind every time, which is what the adapter delegates to', () => {
    // Identity, not equality (`capabilities.test.ts:36-42`'s rule): a projection computed per call
    // would satisfy `toEqual` and break the one assertion that proves there is a single table.
    expect(capabilitiesOf('claude_code')).toBe(capabilitiesOf('claude_code'))
    const adapter = new ClaudeCodeAdapter({ command: 'claude', hookPath: '/opt/slaveofai/pause-gate.sh' })
    expect(adapter.getCapabilities()).toBe(capabilitiesOf('claude_code'))
  })

  it('derives each of the five members from the axis R4 names, for every provider', () => {
    for (const kind of PROVIDER_KINDS) {
      const manifest = manifestFor(kind)
      const capabilities = capabilitiesOf(kind)
      expect(capabilities.canPauseMidRun, kind).toBe(manifest.pause.rung === 'hook')
      expect(capabilities.canResumeSession, kind).toBe(manifest.resume.mode !== 'none')
      expect(capabilities.gate, kind).toBe(manifest.toolRestrictions.mechanism === 'none' ? 'none' : 'all-tools')
      expect(capabilities.reportsCost, kind).toBe(manifest.usageCost === 'reported')
      expect(capabilities.reportsToolResults, kind).toBe(manifest.events.produces.includes('tool_result'))
    }
  })

  it('never produces `shell-only`, which was superseded by proof and stays typed and unreachable', () => {
    for (const kind of PROVIDER_KINDS) expect(capabilitiesOf(kind).gate, kind).not.toBe('shell-only')
  })

  it('is frozen, so a consumer cannot edit the one table every other consumer reads', () => {
    expect(Object.isFrozen(capabilitiesOf('cursor'))).toBe(true)
  })
})

describe('runFiles is a record keyed by channel (R7)', () => {
  it('is what both adapters declare, and both declare exactly two', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(manifestFor(kind).runFiles.channels, kind).toEqual(['settings', 'hook'])
    }
  })

  it('maps the persisted pair onto the two Checkpoint columns, in the manifest’s order', () => {
    const handle = handleFor('claude_code', ['/run/settings.json', '/opt/pause-gate.sh'])
    expect(checkpointRunFiles('claude_code', handle)).toEqual({
      settingsPath: '/run/settings.json',
      hookPath: '/opt/pause-gate.sh',
    })
  })

  it('maps Cursor’s two files onto the same two columns, which is why no schema change was needed', () => {
    const handle = handleFor('cursor', ['/work/.cursor/hooks.json', '/opt/cursor-shell-gate.sh'])
    expect(checkpointRunFiles('cursor', handle)).toEqual({
      settingsPath: '/work/.cursor/hooks.json',
      hookPath: '/opt/cursor-shell-gate.sh',
    })
  })

  it('refuses a handle missing a persisted channel rather than writing an empty column', () => {
    // `Checkpoint.settingsPath` and `.hookPath` are NOT NULL. An adapter that reported one channel
    // would otherwise reach the database as an empty string and be discovered at resume time, three
    // hours later, as a settings file that does not exist.
    const broken: RunHandle = { ...handleFor('cursor', ['/a', '/b']), runFiles: { settings: '/a' } as RunFiles }
    expect(() => checkpointRunFiles('cursor', broken)).toThrow(/hook/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/providers/test/contract.test.ts`
Expected: FAIL — `Failed to resolve import "../src/contract/adapter.js"`.

- [ ] **Step 3: Write the declaring file**

`packages/providers/src/contract/adapter.ts`. Everything below is MOVED, docstring for docstring, from `packages/providers/src/claude/adapter.ts:28-200`; the only edits are the ones R1 and R7 name — one interface declaration instead of two, `id: string` becomes `readonly kind: ProviderKind`, and `runFiles` becomes a record.

```ts
import { manifestFor, type ProviderKind } from '@slave-of-ai/domain'
import type { RunId } from '@slave-of-ai/domain'
import type { Checkpoint } from '../claude/checkpoint.js'
import type { ModelListing } from '../models.js'
import type { RuntimeEvent } from '../types.js'

/**
 * What a runtime can promise. Every member has exactly one consumer in the system --
 * a capability nothing reads is a claim nothing checks, so it does not exist here.
 *
 * Since M56a R4 every member is a PROJECTION of that provider's manifest
 * (`packages/domain/src/provider/manifest.ts`) rather than a hand-written row, and
 * `capabilities.ts` is where the projection is spelled. The rule above is why this interface did
 * NOT grow a member for `structuredOutput`, `usageCost` or `toolVocabulary` when the manifest did:
 * a manifest records what is true about a vendor, and this records what THIS SYSTEM reads.
 */
export interface ProviderCapabilities {
  /** Consumed by the pause strategy: can this runtime stop between tool calls? */
  readonly canPauseMidRun: boolean
  /** Consumed by the pause strategy: can a stopped session be continued? */
  readonly canResumeSession: boolean
  /** Consumed by gate semantics and the roster's provider mark. */
  readonly gate: 'all-tools' | 'shell-only' | 'none'
  /** Consumed by budget admission: does this runtime report spend in USD? */
  readonly reportsCost: boolean
  /**
   * Consumed by M51's behavioural breaker: does this runtime say what came BACK from a tool call?
   *
   * A detector that cannot tell a finished call from a running one has no way to say a quiet
   * twenty-minute build is not a loop, so a runtime answering `false` here would have to be read
   * with the error-storm arm suppressed entirely. Both rows answer `true` today, each by its own
   * proof (`capabilities.ts`) -- this exists so a third runtime that cannot is refused an arm
   * rather than silently mis-judged by it.
   */
  readonly reportsToolResults: boolean
}

/**
 * Everything the adapter needs to spawn one run (M12 spec §7, ADR 0001 §3/§5.5). `worktreePath` and
 * `pauseFlagPath` are supplied by the caller, already absolute.
 *
 * M12 Decision of Record #1: no caller outside `packages/providers` may know that a runtime keeps a
 * settings file, a hook script, or where either lives -- `settingsPath` and `hookPath` used to live
 * here for exactly that reason, and both are gone. `runDir` is the one opaque handle the
 * orchestrator still supplies (`packages/control`'s `runFilePaths`, an already-created, empty
 * per-run scratch directory); everything an adapter keeps inside it is that adapter's own business,
 * reported back to the caller opaquely on `RunHandle.runFiles` for the one thing a caller genuinely
 * needs it for: a resumed run finding the same files.
 */
export interface StartRunInput {
  readonly runId: RunId
  readonly prompt: string
  readonly worktreePath: string
  readonly pauseFlagPath: string
  readonly runDir: string
  /**
   * The permission matrix's resolved deny list for this run (M18 Task 5), already written to disk
   * by the caller as `permissions.json` inside `runDir` (`packages/control`'s
   * `writePermissionsFile`, called once per start AND once per resume) -- an adapter never resolves
   * the matrix itself, only tells the child where to find the resolved file, exactly the way
   * `pauseFlagPath` already works. Required, not optional: every dispatch site writes the file
   * before calling `start()`, even when the resolved deny list is empty.
   */
  readonly permissionsFilePath: string
  readonly gitIdentity: {
    readonly name: string
    readonly email: string
  }
  /**
   * The resolved model override (M10 §6), already the caller's chosen value -- an adapter does not
   * itself consult a worker/roster/template chain, `resolveRuntime` does that before calling
   * `start()`. `undefined` means "no override": `--model` is omitted entirely rather than passed
   * with some sentinel, so a legacy run with no override behaves exactly as it did before this
   * field existed.
   */
  readonly model?: string
  /**
   * M52 R4: the PLAINTEXT run token this spawn's child carries, whose sha256 is already on the
   * `SlaveRun` row and inside the `permissions.json` the caller just wrote. The adapter puts it in
   * exactly one place -- the child's environment -- and never writes it anywhere.
   *
   * OPTIONAL for the same reason `resume`'s fourth parameter is (M52 plan erratum E7): `Checkpoint`
   * may not gain a field with no matching Prisma column, and a token file in `runDir` would be
   * readable by every sibling run under the same uid. Optional cannot widen anything here -- an
   * absent token means the key is absent from the child's environment, and the child then meets a
   * `tokenHash` it cannot match, which denies every tool call rather than allowing one.
   */
  readonly runToken?: string
}

/**
 * The provider-private files one run needs in order to be resumed later, keyed by CHANNEL NAME
 * (M56a R7).
 *
 * Until this milestone it was a frozen `{ settingsPath, hookPath }` pair named after the two
 * Postgres columns it ends up in, and Cursor already reused that pair for two files that are
 * neither a settings file nor a hook. The keys are now whatever that provider's manifest declares
 * in `runFiles.channels`, and `checkpointRunFiles` below is the ONE place they are mapped onto the
 * columns.
 *
 * `Readonly<Record<string, string>>` and not a union of the known channel names: the keys are DATA
 * in a manifest, and a type that enumerated them would put the same list in two places -- which is
 * the thing this milestone exists to stop doing.
 */
export type RunFiles = Readonly<Record<string, string>>

/** What `start()` reports back: enough to find and signal the process later. */
export interface RunHandle {
  readonly runId: RunId
  readonly pid: number
  /**
   * The files this run's adapter actually wrote, under the channel names its manifest declares. The
   * orchestrator relays them into the checkpoint through `checkpointRunFiles` and never interprets
   * them -- only the adapter that produced them reads them back (`resume`, off
   * `Checkpoint.settingsPath`/`.hookPath`).
   */
  readonly runFiles: RunFiles
}

/**
 * The provider-neutral contract every runtime adapter implements (M12 spec §7).
 *
 * ONE DECLARATION (M56a R1). It was built incrementally across M3 as two declaration-merged blocks
 * so that each task's diff stayed legible against the interface's own history; that history is
 * three milestones old, and a contract nobody can read in one screen is the thing M56a exists to
 * fix. It also lived in the CLAUDE adapter's own file, which both adapters imported it from --
 * nothing about it is Claude-specific, and it now lives where that is visible.
 *
 * `requestPause` and `awaitPause` (M3 Task 8) briefly lived here too and are gone (M12 Task 4,
 * controller ruling). They only ever worked for a run registered in *this adapter instance's own
 * in-memory state*, but pause is a cross-process control signal -- a CLI invocation, a web request
 * and the daemon each call it from a process that never called this run's `start()` -- so nothing
 * could ever call them for real (M12 Task 3 proved this). Pause is a stateless flag-file write
 * instead (`packages/providers`'s `signalPause`); the adapter itself has no pause method at all.
 *
 * What M56a deliberately did NOT do to this interface: it added no method, removed none, renamed
 * nothing, and changed no signature but `runFiles`'s type.
 */
export interface SlaveRuntimeAdapter {
  /**
   * Which provider this adapter IS, in the `ProviderKind` spelling (M56a R1).
   *
   * It was `id: string` and `ClaudeCodeAdapter`'s was `'claude-code'` -- HYPHENATED, and not the
   * enum member `claude_code` -- which is a wrinkle two comments in this tree existed to warn
   * about (`packages/control/src/index.ts:16-19`, `apps/web/src/server/overview.ts:762-765`). One
   * spelling now, and a registry that can assert an adapter is the kind it was registered under.
   */
  readonly kind: ProviderKind
  getCapabilities(): ProviderCapabilities
  /**
   * The models an operator can pick for this provider (M25 §5.1) -- `listProviderModels(kind)`
   * gives the same answer without an adapter.
   */
  listModels(): Promise<ModelListing>
  start(input: StartRunInput): Promise<RunHandle>
  events(runId: RunId): AsyncIterable<RuntimeEvent>
  cancel(runId: RunId): Promise<void>
  /**
   * Clears `checkpoint.pauseFlagPath`, **verifies it is actually absent**, then spawns the runtime
   * against `checkpoint.sessionId` in `checkpoint.worktreePath`, with the same settings and
   * permission posture the paused run used (ADR 0001 §5.7/§6). The verification is the point of the
   * step, not ceremony: a flag file that survives the clear attempt makes the hook deny the resumed
   * run's first tool call, and every one after it -- a resumed run that looks, from the outside,
   * exactly like a run stuck in a pause loop, with no error anywhere to say why. `resume` never
   * rewrites `checkpoint.sessionId` (ADR 0001 §5: a plain `--resume` reports the same UUID) and
   * never passes a flag that would mint a new one (each provider's manifest names its own, in
   * `resume.neverPass`).
   *
   * `queuedInstruction` becomes the resume prompt verbatim when supplied. The CLI has no notion
   * that a resume follows a pause -- it treats the prompt as an ordinary next turn (ADR 0001 §6).
   * When `null` (no instruction queued), a generic continuation prompt is substituted: headless mode
   * still needs *some* text, and there is no queued operator instruction to supply it.
   *
   * Resuming a `runId` this adapter instance never itself `start()`-ed is the normal case, not an
   * error -- that is exactly what surviving a daemon restart means. `checkpoint` alone carries
   * everything the spawn needs (`settingsPath`, `hookPath`, `gitAuthorName`, `gitAuthorEmail`,
   * alongside `worktreePath`/`pauseFlagPath`/`sessionId`), so `resume` does not look up any prior
   * in-memory record of `runId` before spawning.
   *
   * `runToken` (M52 R4) is the ROTATED token for this spawn -- a resume mints a fresh one, so a
   * token recovered from an old worktree, an old process listing or a stale environment dump is
   * dead the moment the run resumes. Optional and last, so the ~20 existing call sites compile
   * unchanged; see `StartRunInput.runToken` for why optional cannot widen anything.
   */
  resume(
    runId: RunId,
    checkpoint: Checkpoint,
    queuedInstruction: string | null,
    runToken?: string,
  ): Promise<RunHandle>
}

/**
 * The ONE place a run's channels are mapped onto the two `Checkpoint` columns (M56a R7).
 *
 * `Checkpoint.settingsPath` and `.hookPath` are NOT NULL (`packages/db/prisma/schema.prisma:1227-1228`)
 * and M56a runs no migration, so exactly two of a provider's channels survive a pause: the ordered
 * pair its manifest names in `runFiles.persisted`. Every dispatch site relays through this function
 * -- `apps/orchestrator/src/tick.ts`, `planning.ts` and `review.ts` each used to spread
 * `handle.runFiles` straight into the checkpoint's `spawn` -- so the column names are spelled in
 * this file and in the Prisma schema and nowhere else.
 *
 * WHAT THIS GENERALISES AND WHAT IT DOES NOT. The ADAPTER side: a provider with three run files can
 * declare three channels and its adapter can return them. The PERSISTENCE side is unchanged, and
 * the residual is named rather than hidden -- the third would have to be re-derivable at resume
 * time from `runDir` or the worktree, so the gate asserts `channels.length === 2` for every
 * registered provider until `Checkpoint` gains a `runFiles Json` column. Making that column now
 * would be a migration in a migration-free milestone, for a provider that does not exist, against a
 * shape nobody has measured.
 *
 * It THROWS on a missing channel rather than writing an empty string: both columns are NOT NULL, and
 * an empty settings path is a failure that surfaces hours later as a resumed run whose gate never
 * registers, which is precisely the silent failure `claudeFlags` refuses a relative path to prevent.
 */
export function checkpointRunFiles(
  kind: ProviderKind,
  handle: RunHandle,
): { readonly settingsPath: string; readonly hookPath: string } {
  const [settingsChannel, hookChannel] = manifestFor(kind).runFiles.persisted
  const settingsPath = handle.runFiles[settingsChannel]
  const hookPath = handle.runFiles[hookChannel]
  if (settingsPath === undefined || hookPath === undefined) {
    throw new Error(
      `checkpointRunFiles: ${kind} reported no path for ` +
        `${settingsPath === undefined ? JSON.stringify(settingsChannel) : JSON.stringify(hookChannel)}; ` +
        `its manifest persists ${JSON.stringify(manifestFor(kind).runFiles.persisted)} and the handle carried ` +
        `${JSON.stringify(Object.keys(handle.runFiles))}`,
    )
  }
  return { settingsPath, hookPath }
}
```

- [ ] **Step 4: `claude/adapter.ts` stops declaring the contract and starts re-exporting it**

Four edits, in one file.

(a) Delete `ProviderCapabilities` (`:28-51`), `StartRunInput` (`:53-107`), `RunHandle` (`:109-123`) and BOTH `SlaveRuntimeAdapter` blocks (`:125-200`), and put the re-export in their place, immediately after the imports:

```ts
/**
 * The contract, which is no longer declared here (M56a R1).
 *
 * It moved to `../contract/adapter.ts` -- a directory that belongs to neither vendor -- and is
 * re-exported from this path because the whole tree imports it from here: `registry.ts:1`,
 * `cursor/adapter.ts:12`, `capabilities.ts:1`, `index.ts:21` and `@slave-of-ai/control`'s own
 * re-exports all resolve to the same symbols by the same names. Nothing about the interface was
 * ever Claude-specific; it lived here because M3 built it here.
 */
export type {
  ProviderCapabilities,
  RunFiles,
  RunHandle,
  SlaveRuntimeAdapter,
  StartRunInput,
} from '../contract/adapter.js'
```

and add the type-only imports the class body still needs:

```ts
import type { ProviderCapabilities, RunHandle, StartRunInput } from '../contract/adapter.js'
```

(b) `:301` — `readonly id = 'claude-code' as const` becomes:

```ts
  readonly kind = 'claude_code' as const
```

(c) `:450` and `:808` — the two `runFiles` constructions take the channel names Claude's manifest declares:

```ts
      // `settings` and `hook` are this provider's declared channels
      // (`packages/domain/src/provider/claude-code.ts`'s `runFiles.channels`); the orchestrator maps
      // them onto the checkpoint's two columns through `checkpointRunFiles` and never reads a key
      // here by name.
      runFiles: { settings: settingsPath, hook: this.hookPath },
```

```ts
      runFiles: { settings: checkpoint.settingsPath, hook: checkpoint.hookPath },
```

(d) `:469` — `spawnChild`'s `spec.runFiles` type is `RunHandle['runFiles']` and needs no edit at all; it now reads `RunFiles`, and `:612`'s `resolve({ runId: spec.runId, pid: child.pid, runFiles: spec.runFiles })` relays whatever it was given. **Verify by reading, do not edit.**

- [ ] **Step 5: `cursor/adapter.ts`, the same three**

(a) `:12` — the import path moves from `'../claude/adapter.js'` to `'../contract/adapter.js'`, which is the one import in the tree that changes and changes because it is the one that said, in its own docstring, that it was importing from the wrong place:

```ts
import type { SlaveRuntimeAdapter, ProviderCapabilities, RunHandle, StartRunInput } from '../contract/adapter.js'
```

Update the block comment at `:19-22` in the same edit: "It implements the SAME interface `ClaudeCodeAdapter` does -- `kind`, `getCapabilities`, `start`, `events`, `cancel`, `resume` -- declared in `contract/adapter.ts`, which belongs to neither vendor (M56a R1)."

(b) `:127` — `readonly id = 'cursor' as const` becomes `readonly kind = 'cursor' as const`. The VALUE does not move: it was already the kind's own spelling, which is why R1 calls this "the only value that moves is one nothing reads" and means Claude's.

(c) `:196` and `:285`:

```ts
      runFiles: { settings: hooksPath, hook: this.gatePath },
```

```ts
      runFiles: { settings: checkpoint.settingsPath, hook: checkpoint.hookPath },
```

`:324` (`spec.runFiles: RunHandle['runFiles']`) and `:456` (the relay into `resolve`) need no edit. The block comment at `:26-31` keeps its measured fact and loses its obsolete half — the pair is a RECORD now, and the two Postgres columns are still the two Postgres columns:

```ts
 * - **Its run files are `.cursor/hooks.json` in the WORKTREE, not a settings file in `runDir`.**
 *   `cursor-agent` has no `--settings`-style flag; it reads hooks from the workspace (Task 11 §3
 *   Q1), so per-run gate isolation comes from the run having its own worktree. It reports them on
 *   the `settings` and `hook` CHANNELS its manifest declares (M56a R7), and
 *   `checkpointRunFiles` maps those onto `Checkpoint.settingsPath`/`.hookPath` -- which are still
 *   the two columns, and still NOT NULL, because M56a runs no migration.
```

- [ ] **Step 6: `capabilities.ts` becomes the projection**

The exported signature does not move, both row docstrings stay where they are as the PROVENANCE of the values the manifests now hold, and the body becomes five derivations computed once:

```ts
import { PROVIDER_KINDS, manifestFor, type ProviderCapabilityManifest, type ProviderKind } from '@slave-of-ai/domain'
import type { ProviderCapabilities } from './contract/adapter.js'

/**
 * What each provider kind can promise, as a PURE lookup on the kind alone (M12 Task 9).
 *
 * … (the existing docstring, verbatim, through "the disagreement would be invisible") …
 *
 * SINCE M56a R4 THE ROWS ARE A PROJECTION, not a table. Five members, five axes of the provider's
 * own manifest (`packages/domain/src/provider/manifest.ts`), computed ONCE at module load: the
 * function still answers without constructing an adapter, still answers the same object every time
 * -- `ClaudeCodeAdapter.getCapabilities()` delegates here and `capabilities.test.ts` asserts the two
 * are the same object, not merely equal -- and the values are byte-identical to the two frozen rows
 * this replaced, which `scripts/fixtures/m56a-goldens/capabilities.json` pins from before the
 * migration.
 *
 * The `const unhandled: never` guard that used to live in this switch is not lost; it moved one
 * level down, onto `PROVIDER_MANIFESTS`' own totality (`Record<ProviderKind, …>`), where a third
 * kind with no row is a build error for EVERY axis at once rather than for this one switch. What
 * stays here is the runtime refusal for a kind that reached this function through an unchecked cast.
 */
export function capabilitiesOf(kind: ProviderKind): ProviderCapabilities {
  const capabilities = CAPABILITIES_BY_KIND[kind]
  if (capabilities === undefined) {
    throw new Error(`capabilitiesOf: unhandled provider kind ${JSON.stringify(kind)}`)
  }
  return capabilities
}

/**
 * R4's projection, member by member, with the axis each one reads:
 *
 *   `canPauseMidRun`     `pause.rung === 'hook'` -- ADR 0001's top rung is the only one that stops
 *                        a run between tool calls and leaves it resumable in place.
 *   `canResumeSession`   `resume.mode !== 'none'`.
 *   `gate`               `'none'` when there is no mechanism at all, `'all-tools'` otherwise.
 *                        **`'shell-only'` is unreachable and stays so**: it was superseded by proof
 *                        at M13 Task 9, and `capabilities.ts`'s own widen-never-narrow rule forbids
 *                        narrowing a value already recorded. `ShellOnlyMark.tsx` therefore stays
 *                        exactly as it is, dead and correct (`docs/ia.md` rule 2).
 *   `reportsCost`        `usageCost === 'reported'`.
 *   `reportsToolResults` `events.produces.includes('tool_result')`.
 */
function project(manifest: ProviderCapabilityManifest): ProviderCapabilities {
  return {
    canPauseMidRun: manifest.pause.rung === 'hook',
    canResumeSession: manifest.resume.mode !== 'none',
    gate: manifest.toolRestrictions.mechanism === 'none' ? 'none' : 'all-tools',
    reportsCost: manifest.usageCost === 'reported',
    reportsToolResults: manifest.events.produces.includes('tool_result'),
  }
}

/**
 * One row per kind, computed at module load and FROZEN.
 *
 * Computed once and not per call for a reason a test states: `capabilities.test.ts:36-42` asserts
 * `adapter.getCapabilities()` IS `capabilitiesOf('claude_code')` -- identity, because "two frozen
 * objects that happen to agree today would satisfy `toEqual` and still drift apart on the first
 * edit to either one". A projection computed per call would hand out a fresh object every time and
 * break exactly the assertion that proves there is one table.
 */
const CAPABILITIES_BY_KIND: Record<ProviderKind, ProviderCapabilities> = Object.fromEntries(
  PROVIDER_KINDS.map((kind) => [kind, Object.freeze(project(manifestFor(kind)))]),
) as Record<ProviderKind, ProviderCapabilities>
```

Keep the two long row docstrings (`capabilities.ts:42-53` and `:55-86`) in the file, above `CAPABILITIES_BY_KIND`, re-titled as what they now are: the measurement history of the values, with a pointer to the manifest that holds them. **Nothing in them is deleted** — the Cursor row's three paragraphs on the recorded gate runs, the binary version and the widen-never-narrow rule are the reason a reader can trust the manifest, and they are the only place that reasoning exists.

- [ ] **Step 7: The barrel**

`packages/providers/src/index.ts` gains one line, before the `claude/` group so a reader meets the contract before an implementation of it:

```ts
export * from './contract/adapter.js'
export * from './claude/stream.js'
```

Both `./contract/adapter.js` and `./claude/adapter.js` now export the same five type names, and that is not an ambiguity: `claude/adapter.ts` RE-EXPORTS them from `contract/adapter.ts`, so both star exports resolve to the same declaration, which is exactly the case ES modules and TypeScript resolve rather than exclude. `checkpointRunFiles` reaches the barrel only through `./contract/adapter.js`.

- [ ] **Step 8: The three relays**

`apps/orchestrator/src/tick.ts:773-777`, `planning.ts:627-631` and `review.ts:576-580` each spread `handle.runFiles` into the checkpoint's `spawn`. Each becomes a call, and each keeps its comment with one clause added:

```ts
      // The facts a fresh process cannot rediscover, handed to the component that knows when the
      // run pauses. Identity is supplied per-process by design, so there is nowhere else to
      // recover it from once this process is gone. `settingsPath`/`hookPath` come from the
      // adapter's own report (`handle.runFiles`), not from anything this tick derived or wrote
      // itself (M12 Task 2) -- relayed into the checkpoint verbatim, never interpreted here.
      // `checkpointRunFiles` (M56a R7) is the one place the provider's own channel names are
      // mapped onto those two columns.
      spawn: {
        ...checkpointRunFiles(resolved.provider, handle),
        pauseFlagPath,
```

with `import { checkpointRunFiles } from '@slave-of-ai/providers'` added to each file's existing providers import. `resolved.provider` is already in scope at all three sites — it is the value each one writes to `spawn.provider` two lines below.

- [ ] **Step 9: The three test files that move, line by line (erratum E3)**

`packages/providers/test/registry.test.ts`:
- `:8` — `expect(registry.resolve('claude_code').id).toBe('claude-code')` becomes `expect(registry.resolve('claude_code').kind).toBe('claude_code')`
- `:21`, `:22` — the same two, `.kind` against `'claude_code'` and `'cursor'`
- `:35-52` — `stubAdapter(capabilities)` takes a kind: `function stubAdapter(kind: ProviderKind, capabilities: ProviderCapabilities): SlaveRuntimeAdapter` with `kind,` where `id: 'stub'` was. A `ProviderKind` cannot hold `'stub'`, and an adapter that does not know which provider it is was never a thing the registry could admit.
- `:57-65`, `:69-86` — the three `stubAdapter({…})` calls pass a kind (`'cursor'` for the useless one and the resume-only one, `'claude_code'` for the gate-only one, matching the `admitAdapter` argument each case already passes), and `:84-85`'s `.id).toBe('stub')` becomes `.kind).toBe('claude_code')` / `.toBe('cursor')`
- add `import type { ProviderKind } from '@slave-of-ai/domain'`

`packages/providers/test/cursor-adapter.test.ts`:
- `:175` — `expect(adapter.id).toBe('cursor')` becomes `expect(adapter.kind).toBe('cursor')`
- `:191` — `expect(registry.resolve('cursor').id).toBe('cursor')` becomes `.kind`
- `:200` — `expect(handle.runFiles).toEqual({ settingsPath: hooksPath, hookPath: gatePath })` becomes `toEqual({ settings: hooksPath, hook: gatePath })`, with the comment above it kept: the two files are still the same two files.

`packages/providers/test/adapter-resume.test.ts` — seven lines, all of them reading a channel off a handle to build a `Checkpoint`:
- `:157-158`, `:411-412`, `:478-479`, `:585-586` — `settingsPath: startHandle.runFiles.settingsPath` becomes `settingsPath: startHandle.runFiles.settings`, and `hookPath: …runFiles.hookPath` becomes `…runFiles.hook`. The `Checkpoint` FIELD names do not change; only the channel read does.
- `:224` — `expect(args).toContain(startHandle.runFiles.settingsPath)` becomes `.settings`
- `:263` — `expect(args[settingsIndex + 1]).not.toBe(startHandle.runFiles.settingsPath)` becomes `.settings`

- [ ] **Step 10: Run everything this task touched**

```bash
npx vitest run packages/providers/test
npx vitest run apps/orchestrator/test/integration/tick.test.ts apps/orchestrator/test/integration/planning.test.ts apps/orchestrator/test/integration/review.test.ts
```
Expected: PASS on both, with **`capabilities.test.ts` unchanged** — its four cases are the assertion that R4's projection produces byte-identical rows, and its `toBe` case is the assertion that there is still one table. `checkpoint-shape.test.ts` passing unedited is the assertion that the two columns still receive the two paths.

- [ ] **Step 11: Ladder and commit**

```bash
npx vitest run 2>&1 | tail -20
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: at or above Task 1's recorded numbers, plus one file.

```bash
git add packages/providers apps/orchestrator/src/tick.ts apps/orchestrator/src/planning.ts apps/orchestrator/src/review.ts
git commit -m "$(cat <<'EOF'
feat(providers): m56a t2 — the contract moves to a file that belongs to neither vendor

`SlaveRuntimeAdapter` was declared in the CLAUDE adapter's own directory, in two
declaration-merged blocks, and the Cursor adapter imported it from there. It is one interface in
`contract/adapter.ts` now, and `claude/adapter.ts` re-exports every moved type from the path the
whole tree already imports -- so `registry.ts`, `capabilities.ts`, the barrel and every
`@slave-of-ai/control` re-export resolve to the same symbols by the same names, and exactly one
import line in the tree changed: the one whose own docstring said it was importing from the wrong
place.

`id: string` becomes `readonly kind: ProviderKind`. `ClaudeCodeAdapter.id` was `'claude-code'` --
hyphenated, and not the enum member -- which is a wrinkle two comments in this tree exist to warn
about. One spelling now.

`RunHandle.runFiles` is a record keyed by the channel names a provider's manifest declares, and
`checkpointRunFiles` is the one place those channels are mapped onto `Checkpoint.settingsPath` and
`.hookPath` -- which do not move, are still NOT NULL, and still receive the same two absolute paths
they always did. It throws on a missing channel rather than writing an empty column, because an
empty settings path is a failure that surfaces hours later as a gate that never registered.

`capabilitiesOf` is a projection of the manifest, computed once at module load and frozen: five
members, five axes, and the same OBJECT for a kind every time -- which `capabilities.test.ts`
asserts by identity, unedited, and which is why the projection is not computed per call.
`gate: 'shell-only'` stays typed and unreachable, and `ShellOnlyMark.tsx` stays wired and rendering
nothing: narrowing a recorded capability is the one direction this table may not move.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RBVSwP5Paww1L1hqS7Dper
EOF
)"
```

---

### Task 3: A table where a signature was, a loop where a switch was, and a spend net that covers both binaries (R6, R9, R10, E6, E7, E8, E10, E11, D27–D40)

`packages/providers`'s registry and model discovery, the orchestrator's wiring, its two capability reads and its spend net, `packages/control`'s two simulation literals, and every environment in this repository that arms the fake CLI. This is the task where a new provider stops being a signature to widen and becomes an entry to add — and it is the only task in the milestone that changes an observable behaviour, in exactly one direction: a process that would have silently spawned a real `cursor-agent` under `SLAVEOFAI_REQUIRE_FAKE_CLI=1` now refuses to start.

**Files:**
- Create: `apps/orchestrator/test/integration/adapter-registry.test.ts`
- Modify: `packages/providers/src/registry.ts`, `packages/providers/src/models.ts`, `apps/orchestrator/src/cli.ts`, `apps/orchestrator/src/require-fake-cli.ts`, `apps/orchestrator/src/claude-command.ts`, `apps/orchestrator/src/pump.ts`, `apps/orchestrator/src/runContext.ts`, `apps/orchestrator/src/sweep.ts`, `packages/control/src/simulation/write.ts`, `packages/control/src/simulation/llm.ts`, `packages/control/src/simulation/adopt.ts`, `packages/control/src/simulation/shared.ts`, `scripts/lib/child-env.mjs`, `scripts/gate-m8-plan.mjs`, `scripts/gate-m8a-merge.mjs`, `scripts/gate-m8a-estop.mjs`, `scripts/gate-m10-org.mjs`, `.github/workflows/ci.yml`, `packages/providers/test/registry.test.ts`, `packages/providers/test/cursor-adapter.test.ts`, `packages/providers/test/models.test.ts`, `apps/orchestrator/test/require-fake-cli.test.ts`, `apps/orchestrator/test/integration/tick.test.ts`, `apps/orchestrator/test/integration/cli.test.ts`, `apps/orchestrator/test/integration/milestone-gate.test.ts`
- Test: the new integration file, the four moved test files, plus `apps/orchestrator/test/integration/{pump,runContext,sweep,cursor-pause}.test.ts` and `packages/control/test/integration/simulation-llm.test.ts` — **unchanged and re-run**, which is what makes "the capability reads the same boolean the literal did" a measurement

**Interfaces:**
- Consumes: `manifestFor`, `PROVIDER_KINDS`, `providerRunsSkills`, `type ProviderKind` (Task 1); `SlaveRuntimeAdapter`, `checkpointRunFiles`, `capabilitiesOf` (Task 2); `ClaudeCodeAdapter`/`ClaudeCodeAdapterOptions` (`packages/providers/src/claude/adapter.ts:202-241,296`), `CursorAdapter`/`CursorAdapterOptions` (`cursor/adapter.ts:62-126`); `parseCursorModels` (`models.ts:37`); `isProviderKind` (`packages/control/src/org.ts:21`); `basename` (`node:path`).
- Produces, for Tasks 4–6:
  - `packages/providers/src/registry.ts`: `interface ProviderWiring`, `interface ProviderRegistration`, `PROVIDER_ADAPTERS: Record<ProviderKind, ProviderRegistration>`, `buildRegistry(options: Partial<Record<ProviderKind, ProviderWiring>>)` — `AdapterRegistry`, `UnknownProviderError` and `admitAdapter` unchanged
  - `packages/providers/src/models.ts`: `listProviderModels` without a switch, `listCursorModels` and `listClaudeCodeModels` unchanged in signature
  - `apps/orchestrator/src/cli.ts`: `export function buildAdapterRegistry(): AdapterRegistry`
  - `apps/orchestrator/src/require-fake-cli.ts`: `requireFakeCliRefusal(envVar: string): string`, `REQUIRE_FAKE_CLI_REFUSAL` (the `SLAVEOFAI_CLAUDE_BIN` case of it), `fakeCliRefusal(env)` over every registered kind
  - `scripts/lib/child-env.mjs`: `fakeProviderBins(env)`, and `loopbackChildEnv` arming it

- [ ] **Step 1: Write the failing test for the registry table**

`packages/providers/test/registry.test.ts` keeps every case it has (with Task 2's `.kind` edits) and gains the table's own. The three existing `buildRegistry({ claudeCode: … })` calls take the new shape in the same edit — they are the same three facts about the same registry:

```ts
import { describe, expect, it } from 'vitest'
import { PROVIDER_KINDS, manifestFor, type ProviderKind } from '@slave-of-ai/domain'
import type { SlaveRuntimeAdapter, ProviderCapabilities } from '../src/contract/adapter.js'
import { PROVIDER_ADAPTERS, admitAdapter, buildRegistry, type ProviderWiring } from '../src/index.js'

/** The wiring a process actually hands a registry: one command and the four script paths, the same
 *  object for every kind (`apps/orchestrator/src/cli.ts`'s `buildAdapterRegistry`). */
const wiring = (command: string): ProviderWiring => ({
  command,
  scripts: {
    hookPath: '/opt/slaveofai/pause-gate.sh',
    gatePath: '/opt/slaveofai/cursor-shell-gate.sh',
    brokerCliPath: '/opt/slaveofai/cli.js',
  },
})

describe('PROVIDER_ADAPTERS (R6)', () => {
  it('has exactly the members of PROVIDER_KINDS, so a registration without a manifest cannot exist', () => {
    expect(Object.keys(PROVIDER_ADAPTERS).sort()).toEqual([...PROVIDER_KINDS].sort())
  })

  it('names the class each entry builds, which is what the Settings card prints', () => {
    expect(PROVIDER_ADAPTERS.claude_code.adapterName).toBe('ClaudeCodeAdapter')
    expect(PROVIDER_ADAPTERS.cursor.adapterName).toBe('CursorAdapter')
  })

  it('gives a parser to exactly the providers whose models are LISTED, and to no others', () => {
    for (const kind of PROVIDER_KINDS) {
      const listed = manifestFor(kind).modelDiscovery.mode === 'listed'
      expect(typeof PROVIDER_ADAPTERS[kind].parseModels === 'function', kind).toBe(listed)
    }
  })

  it('builds an adapter that knows which kind it is', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(PROVIDER_ADAPTERS[kind].build(wiring('/bin/true')).kind, kind).toBe(kind)
    }
  })
})

describe('buildRegistry (R6)', () => {
  it('resolves a configured kind to its adapter', () => {
    const registry = buildRegistry({ claude_code: wiring('claude') })
    expect(registry.resolve('claude_code').kind).toBe('claude_code')
  })

  it('refuses an unconfigured kind rather than falling back to Claude', () => {
    const registry = buildRegistry({ claude_code: wiring('claude') })
    expect(() => registry.resolve('cursor')).toThrow(/cursor/)
  })

  it('refuses EVERY kind when it was given nothing -- configured, not buildable, is the question', () => {
    const registry = buildRegistry({})
    for (const kind of PROVIDER_KINDS) expect(() => registry.resolve(kind), kind).toThrow(/no adapter is registered/)
  })

  it('builds both shipped adapters, each of which has at least one of the two pause capabilities', () => {
    const registry = buildRegistry({ claude_code: wiring('claude'), cursor: wiring('cursor-agent') })
    expect(registry.resolve('claude_code').kind).toBe('claude_code')
    expect(registry.resolve('cursor').kind).toBe('cursor')
  })

  it('is a map over the union, so adding a provider is an ENTRY and not a widened signature', () => {
    // The shape assertion R6 exists for: every kind can be wired by name, in a loop, with no
    // function signature naming any vendor.
    const everything = Object.fromEntries(PROVIDER_KINDS.map((kind) => [kind, wiring('/bin/true')]))
    const registry = buildRegistry(everything)
    for (const kind of PROVIDER_KINDS) expect(registry.resolve(kind).kind, kind).toBe(kind)
  })
})
```

(The `admitAdapter` describe block keeps its two cases with Task 2's `stubAdapter(kind, capabilities)` signature.)

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/providers/test/registry.test.ts`
Expected: FAIL — `PROVIDER_ADAPTERS` is not exported, and `buildRegistry({ claude_code: … })` is not assignable to the `{ claudeCode?, cursor? }` parameter.

- [ ] **Step 3: Rewrite the registry as a table**

`packages/providers/src/registry.ts`. `UnknownProviderError`, `UnregistrableProviderError`, `admitAdapter` and `AdapterRegistry` keep their docstrings and their bodies exactly; what changes is the bottom third of the file.

```ts
import { PROVIDER_KINDS, manifestFor, type ProviderKind } from '@slave-of-ai/domain'
import { ClaudeCodeAdapter } from './claude/adapter.js'
import type { SlaveRuntimeAdapter } from './contract/adapter.js'
import { CursorAdapter } from './cursor/adapter.js'
import { parseCursorModels, type ModelOption } from './models.js'

/**
 * Everything a process has to supply to build ONE provider's adapter (M56a R6).
 *
 * One shape for every provider, rather than two option types a caller has to know apart: the
 * command and its extra argv are per-kind (read from that manifest's `binEnvVar`/`argsEnvVar`), and
 * `scripts` is the SAME object for every entry -- four paths a deployment owns, of which each
 * registration takes the ones its adapter needs. `buildAdapterRegistry` therefore builds one
 * `scripts` and hands it to every kind, which is what makes adding a provider one entry rather than
 * one more option block and two more environment reads.
 */
export interface ProviderWiring {
  readonly command: string
  readonly extraArgs?: readonly string[]
  readonly scripts: {
    /** Claude's `PreToolUse` gate (`scripts/pause-gate.sh`). */
    readonly hookPath: string
    /** Claude's `PostToolUse` tap (`scripts/tool-result-tap.sh`). Optional: a deployment that has
     *  not installed it runs perfectly well without it. */
    readonly tapPath?: string
    /** Cursor's shell gate (`scripts/cursor-shell-gate.sh`). A separate path from `hookPath` on
     *  purpose: the two vendors' gates answer different protocols, and pointing one at the other's
     *  script produces a gate that looks installed and blocks every call, or one that blocks none. */
    readonly gatePath: string
    /** The orchestrator CLI a worker runs to ask the broker for an operation (M52 R3). */
    readonly brokerCliPath?: string
  }
}

/**
 * What this package knows how to build for one kind (M56a R6).
 *
 * `adapterName` is the class's own name, read by the Settings page's adapter card
 * (`apps/web/src/server/settings.ts`) so that surface stops carrying its own copy of the two.
 * `parseModels` is present for a provider whose models are LISTED and absent for one whose models
 * are configured -- `PROVIDER_ADAPTERS`'s own test asserts that correspondence against the manifest
 * rather than leaving it to a reader.
 */
export interface ProviderRegistration {
  readonly adapterName: string
  build(wiring: ProviderWiring): SlaveRuntimeAdapter
  parseModels?(stdout: string): readonly ModelOption[]
}

/**
 * Every adapter this package can build, by kind (M56a R6).
 *
 * A `Record<ProviderKind, …>`, like `PROVIDER_MANIFESTS`, and for the same reason: the two fail
 * TOGETHER. A third kind added to the union is a build error here and there at the same moment, so
 * a registration without a manifest -- an adapter nobody measured -- cannot exist.
 *
 * This is what a new provider ADDS: one entry, a constructor call, and for a `listed` provider a
 * parser. It is not what a new provider WIDENS: `buildRegistry` below is a loop and names no vendor.
 */
export const PROVIDER_ADAPTERS: Record<ProviderKind, ProviderRegistration> = {
  claude_code: {
    adapterName: 'ClaudeCodeAdapter',
    build: (wiring) =>
      new ClaudeCodeAdapter({
        command: wiring.command,
        ...(wiring.extraArgs === undefined ? {} : { extraArgs: wiring.extraArgs }),
        hookPath: wiring.scripts.hookPath,
        ...(wiring.scripts.tapPath === undefined ? {} : { tapPath: wiring.scripts.tapPath }),
        ...(wiring.scripts.brokerCliPath === undefined ? {} : { brokerCliPath: wiring.scripts.brokerCliPath }),
      }),
  },
  cursor: {
    adapterName: 'CursorAdapter',
    build: (wiring) =>
      new CursorAdapter({
        command: wiring.command,
        ...(wiring.extraArgs === undefined ? {} : { extraArgs: wiring.extraArgs }),
        gatePath: wiring.scripts.gatePath,
        ...(wiring.scripts.brokerCliPath === undefined ? {} : { brokerCliPath: wiring.scripts.brokerCliPath }),
      }),
    // An arrow that FORWARDS rather than the function reference itself: `models.ts` imports this
    // module (for `PROVIDER_ADAPTERS`) and this module imports `models.ts` (for the parser), and
    // this object literal is evaluated at module load. A forwarding arrow reads the binding at CALL
    // time, so the cycle cannot bite whatever order the two modules are first imported in.
    parseModels: (stdout) => parseCursorModels(stdout),
  },
}

/**
 * Builds a registry from the wiring a process was given, once per process
 * (`apps/orchestrator/src/cli.ts`'s `buildAdapterRegistry`).
 *
 * `Partial<Record<ProviderKind, ProviderWiring>>` (M56a R6) rather than one named optional field per
 * vendor: every entry is still OPTIONAL and none is defaulted, and the rule that made them optional
 * is unchanged -- a deployment that was never given a Cursor gate script must refuse `'cursor'`
 * rather than construct an adapter around a path nobody checked. What a registry resolves remains
 * what a process was CONFIGURED with, not what this package can build.
 */
export function buildRegistry(options: Partial<Record<ProviderKind, ProviderWiring>>): AdapterRegistry {
  const adapters = new Map<ProviderKind, SlaveRuntimeAdapter>()
  for (const kind of PROVIDER_KINDS) {
    const wiring = options[kind]
    if (wiring === undefined) continue
    adapters.set(kind, admitAdapter(kind, PROVIDER_ADAPTERS[kind].build(wiring)))
  }

  return {
    resolve(kind: ProviderKind): SlaveRuntimeAdapter {
      const adapter = adapters.get(kind)
      if (adapter === undefined) throw new UnknownProviderError(kind)
      return adapter
    },
  }
}
```

`manifestFor` is imported for the assertion `admitAdapter` already makes in its own words and now can make in code — leave it out if the built file does not need it, and let `tsc` say so rather than carrying an unused import.

- [ ] **Step 4: `listProviderModels` loses its switch**

`packages/providers/src/models.ts`. `listClaudeCodeModels()` and `listCursorModels(command, timeoutMs)` keep their exported signatures — the second is what `CursorAdapter.listModels()` calls with `this.command` (`cursor/adapter.ts:156`) — and both become thin over one generic reader:

```ts
/** Runs `<command> models` (default `cursor-agent`, 10 s) and parses it. Never throws. */
export async function listCursorModels(command = 'cursor-agent', timeoutMs = 10_000): Promise<ModelListing> {
  return listAccountModels('cursor', command, timeoutMs)
}

/**
 * A `listed` provider's models, read from the account by running the argv its manifest declares
 * (M56a R6).
 *
 * The branch is chosen by DATA now, not by a `case`: `modelDiscovery.mode` says whether this
 * provider's list is read or configured, `modelDiscovery.argv` says what to run, and
 * `PROVIDER_ADAPTERS[kind].parseModels` says how to read the answer. The same two answers as before,
 * from the same two code paths.
 *
 * Never throws, exactly as before: an `account` read that failed comes back with `error` set and
 * `models` empty, so a form can fall back to free text and say why. The message is the first line of
 * stderr, or `<binary> <argv> failed` -- which renders `cursor-agent models failed`, the string this
 * function produced before it was generic.
 */
async function listAccountModels(kind: ProviderKind, command: string, timeoutMs: number): Promise<ModelListing> {
  const manifest = manifestFor(kind)
  const discovery = manifest.modelDiscovery
  if (discovery.mode !== 'listed') return { models: [], source: 'account' }
  const parse = PROVIDER_ADAPTERS[kind].parseModels
  if (parse === undefined) return { models: [], source: 'account', error: `${manifest.invocation.binary}: no model parser` }
  try {
    const { stdout } = await run(command, [...discovery.argv], { timeout: timeoutMs, env: { ...process.env, NO_COLOR: '1' } })
    return { models: parse(stdout), source: 'account' }
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim() : (error as Error).message
    return {
      models: [],
      source: 'account',
      error: text.split('\n')[0] ?? `${manifest.invocation.binary} ${discovery.argv.join(' ')} failed`,
    }
  }
}

/** The one entry point the web reads (through `@slave-of-ai/control`'s re-export): a kind in, a
 *  listing out. The adapters' `listModels()` delegate here, so a caller with an adapter and a
 *  caller with only a kind see the same list.
 *
 *  M56a R6: no switch. `configured` answers the manifest's own table with `source: 'static'`,
 *  `listed` runs the manifest's argv and hands stdout to the entry's parser with
 *  `source: 'account'`, and `none` -- which no shipped provider declares -- answers an empty static
 *  listing rather than throwing, because "this provider lists nothing" is an answer and not a fault. */
export async function listProviderModels(
  kind: ProviderKind,
  options?: { readonly cursorCommand?: string; readonly timeoutMs?: number },
): Promise<ModelListing> {
  const manifest = manifestFor(kind)
  if (manifest.modelDiscovery.mode === 'configured') {
    return { models: manifest.modelDiscovery.options, source: 'static' }
  }
  if (manifest.modelDiscovery.mode === 'none') return { models: [], source: 'static' }
  return listAccountModels(kind, options?.cursorCommand ?? manifest.invocation.binary, options?.timeoutMs ?? 10_000)
}
```

`options.cursorCommand` keeps its name and its meaning: `apps/web/src/server/models.ts:38-42` passes `process.env['SLAVEOFAI_CURSOR_BIN']` into it and that is the ONE caller. Renaming it to `command` would be a rename with no reader, in a milestone that changes nothing — carried, not done.

Run: `npx vitest run packages/providers/test/models.test.ts packages/providers/test/registry.test.ts`
Expected: PASS, with `models.test.ts` **unchanged**: `listClaudeCodeModels()` still returns the same array object, `listProviderModels('cursor')` against a stub binary still parses the same listing, and a failing binary still reports the first line of its stderr.

- [ ] **Step 5: Write the failing test for the spend net**

`apps/orchestrator/test/require-fake-cli.test.ts` keeps all five of its cases — the Claude ones are now the `SLAVEOFAI_CLAUDE_BIN` case of a loop — and gains the Cursor half. Note the new base: with the flag set, a valid environment names BOTH binaries, so every "allows" case has to carry both.

```ts
import { describe, expect, it } from 'vitest'
import { fakeCliRefusal, requireFakeCliRefusal, REQUIRE_FAKE_CLI_REFUSAL } from '../src/require-fake-cli.js'

/** A cursor bin that is not the real one, so a case about Claude is only about Claude. */
const FAKE_CURSOR = '/repo/scripts/gate-fakes/fake-cursor-agent.sh'

describe('fakeCliRefusal', () => {
  it('says nothing when the flag is not set, whatever the binaries are', () => {
    expect(fakeCliRefusal({})).toBeNull()
    expect(fakeCliRefusal({ SLAVEOFAI_CLAUDE_BIN: 'claude', SLAVEOFAI_CURSOR_BIN: 'cursor-agent' })).toBeNull()
    expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '' })).toBeNull()
    expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '0' })).toBeNull()
  })

  it('refuses when the flag is set and no binary is named -- the default IS the real claude', () => {
    expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1' })).toBe(REQUIRE_FAKE_CLI_REFUSAL)
    expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1', SLAVEOFAI_CLAUDE_BIN: '  ' })).toBe(REQUIRE_FAKE_CLI_REFUSAL)
  })

  it('refuses a binary that resolves to a real claude, by name or by path', () => {
    for (const bin of ['claude', '/usr/local/bin/claude', './claude', '  claude  ']) {
      expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1', SLAVEOFAI_CLAUDE_BIN: bin, SLAVEOFAI_CURSOR_BIN: FAKE_CURSOR })).toBe(
        REQUIRE_FAKE_CLI_REFUSAL,
      )
    }
  })

  it('refuses the three Cursor cases that all answered null before this milestone (R10)', () => {
    const claude = { SLAVEOFAI_REQUIRE_FAKE_CLI: '1', SLAVEOFAI_CLAUDE_BIN: '/repo/scripts/gate-fakes/fake-claude.sh' }
    const expected = requireFakeCliRefusal('SLAVEOFAI_CURSOR_BIN')
    // unset -- which is what CI was, and what would have spawned the real binary the moment any
    // code path dispatched a Cursor run
    expect(fakeCliRefusal(claude)).toBe(expected)
    // set-but-empty
    expect(fakeCliRefusal({ ...claude, SLAVEOFAI_CURSOR_BIN: '   ' })).toBe(expected)
    // the real binary, by name or by path
    expect(fakeCliRefusal({ ...claude, SLAVEOFAI_CURSOR_BIN: 'cursor-agent' })).toBe(expected)
    expect(fakeCliRefusal({ ...claude, SLAVEOFAI_CURSOR_BIN: '/usr/local/bin/cursor-agent' })).toBe(expected)
  })

  it('names the variable that failed, so the fix is readable from the message alone', () => {
    expect(REQUIRE_FAKE_CLI_REFUSAL).toBe(
      'refusing to start: SLAVEOFAI_REQUIRE_FAKE_CLI is set but SLAVEOFAI_CLAUDE_BIN is not the fake CLI',
    )
    expect(requireFakeCliRefusal('SLAVEOFAI_CURSOR_BIN')).toBe(
      'refusing to start: SLAVEOFAI_REQUIRE_FAKE_CLI is set but SLAVEOFAI_CURSOR_BIN is not the fake CLI',
    )
    // The historical sentence, byte for byte, as the Claude case of the general one.
    expect(REQUIRE_FAKE_CLI_REFUSAL).toBe(requireFakeCliRefusal('SLAVEOFAI_CLAUDE_BIN'))
  })

  it('allows the shapes every fake in this repo actually takes, once BOTH are named', () => {
    expect(
      fakeCliRefusal({
        SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
        SLAVEOFAI_CLAUDE_BIN: 'node',
        SLAVEOFAI_CLAUDE_ARGS: '/repo/packages/providers/test/fake-claude.mjs --fixture m8-flow',
        SLAVEOFAI_CURSOR_BIN: FAKE_CURSOR,
      }),
    ).toBeNull()
    expect(
      fakeCliRefusal({
        SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
        SLAVEOFAI_CLAUDE_BIN: '/repo/scripts/gate-fakes/fake-claude.sh',
        SLAVEOFAI_CURSOR_BIN: FAKE_CURSOR,
      }),
    ).toBeNull()
  })

  it('reports the FIRST failing variable in PROVIDER_KINDS order, so one fix at a time is readable', () => {
    expect(fakeCliRefusal({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1', SLAVEOFAI_CLAUDE_BIN: 'claude', SLAVEOFAI_CURSOR_BIN: 'cursor-agent' })).toBe(
      REQUIRE_FAKE_CLI_REFUSAL,
    )
  })
})
```

Run: `npx vitest run apps/orchestrator/test/require-fake-cli.test.ts`
Expected: FAIL — `requireFakeCliRefusal` is not exported, and the three Cursor cases return `null`.

- [ ] **Step 6: Widen the spend net**

`apps/orchestrator/src/require-fake-cli.ts`:

```ts
import { basename } from 'node:path'
import { PROVIDER_KINDS, manifestFor } from '@slave-of-ai/domain'

/**
 * What a process refuses to start with when it was told to use the fake CLI and was not given one,
 * for the variable that failed.
 *
 * One sentence with one hole in it (M56a R10), because the gates, the tests and the message an
 * operator reads must be the same sentence — and because a refusal that named `SLAVEOFAI_CLAUDE_BIN`
 * when the Cursor variable was the problem would send somebody to fix the wrong line.
 */
export function requireFakeCliRefusal(envVar: string): string {
  return `refusing to start: SLAVEOFAI_REQUIRE_FAKE_CLI is set but ${envVar} is not the fake CLI`
}

/** The historical constant, byte for byte, kept because every gate and two tests name it: it is the
 *  `SLAVEOFAI_CLAUDE_BIN` case of the sentence above. */
export const REQUIRE_FAKE_CLI_REFUSAL = requireFakeCliRefusal('SLAVEOFAI_CLAUDE_BIN')

/**
 * M32 item 7, widened to every registered provider (M56a R10).
 *
 * … (the existing docstring's first three paragraphs, unchanged) …
 *
 * THE RULE, now per provider: with the flag set, EVERY kind's `binEnvVar` must be named and must not
 * BE that vendor's real CLI. "Real" is judged by the binary's own name (`claude`, `cursor-agent`, at
 * any path), because that is exactly what the fallback would have spawned. Both names come from the
 * manifests, so a third provider is covered by the net the day its manifest exists rather than the
 * day somebody remembers this file.
 *
 * WHY THIS IS A REAL CHANGE AND THE ONLY ONE IN THE MILESTONE. Before it, this function read
 * `SLAVEOFAI_CLAUDE_BIN` and nothing else: a CI job with the flag set, the Claude fake wired and no
 * Cursor variable at all would have spawned the REAL `cursor-agent` the moment any code path
 * dispatched a Cursor run. It can only ever turn a silent real spawn into a refusal.
 *
 * Gates that drive the REAL CLIs by design -- `gate-m12-providers`, `gate-m13-runtime`, whose own
 * headers say so -- must not set the flag, and do not. That is still what arms this.
 */
export function fakeCliRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  const required = env['SLAVEOFAI_REQUIRE_FAKE_CLI']
  // Set-but-empty and an explicit "0" are "not asked for": an exported-blank variable must not be
  // able to stop a daemon that nobody meant to constrain.
  if (required === undefined || required === '' || required === '0') return null
  for (const kind of PROVIDER_KINDS) {
    const { binEnvVar, binary } = manifestFor(kind).invocation
    const bin = env[binEnvVar]?.trim()
    if (bin === undefined || bin === '') return requireFakeCliRefusal(binEnvVar)
    if (basename(bin) === binary) return requireFakeCliRefusal(binEnvVar)
  }
  return null
}
```

`apps/orchestrator/src/claude-command.ts` gains one paragraph and no code:

```ts
 * SINCE M56a R10 THE REFUSAL IT RAISES IS NOT ONLY ABOUT CLAUDE. `fakeCliRefusal` checks every
 * registered provider's binary, so this function throws when `SLAVEOFAI_CURSOR_BIN` is missing too
 * -- which is correct and deliberate: a process that spawns one vendor's CLI under
 * `SLAVEOFAI_REQUIRE_FAKE_CLI` is a process that must not be able to spawn the other's by accident
 * either, and the two adapters are configured unconditionally in the same registry.
```

Run: `npx vitest run apps/orchestrator/test/require-fake-cli.test.ts apps/orchestrator/test/claude-command.test.ts`
Expected: PASS — and `claude-command.test.ts` is unchanged, because its one refusal case (`:23`) sets the flag with no binary at all, which still fails on the FIRST kind in `PROVIDER_KINDS` order.

- [ ] **Step 7: Arm the fake for every environment that asks for one (erratum E11)**

This is the step the milestone breaks without. Twenty-eight gate scripts and five test environments set `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and none sets `SLAVEOFAI_CURSOR_BIN`; every one of them would now refuse to start.

(a) `scripts/lib/child-env.mjs` — the one place, for the reason `scripts/lib/state-dir.mjs:12-17` already states for exactly this shape of problem:

```js
// scripts/lib/child-env.mjs
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROVIDER_MANIFESTS } from '../../packages/domain/dist/index.js'
import { gateStateDir } from './state-dir.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The fake binary for every provider this environment has NOT already named, when it has asked for
 * fakes (M56a R10, plan erratum E11).
 *
 * `fakeCliRefusal` (`apps/orchestrator/src/require-fake-cli.ts`) now refuses to start a process that
 * set `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and left ANY provider's `SLAVEOFAI_<X>_BIN` unset -- which is
 * the point of it, and which would otherwise refuse twenty-eight gates that were never wrong about
 * anything, because before this milestone there was nothing to set. One place rather than
 * twenty-eight copies of one line: `scripts/lib/state-dir.mjs` made exactly this call for exactly
 * this reason.
 *
 * CONDITIONAL, in three ways that matter:
 *   - only when the resulting environment actually asks for fakes, so `gate:m13-runtime` (which
 *     calls `loopbackChildEnv()` and sets no flag) still drives the REAL binaries;
 *   - never over a value the caller supplied, so a gate that points a provider at its own fixture
 *     fake keeps it;
 *   - only where a fake actually exists on disk, under this directory's own `fake-<binary>.sh`
 *     convention, so a future provider with no rehearsal fake fails LOUDLY at start rather than
 *     silently running against nothing.
 *
 * Reads the manifests out of `packages/domain/dist`, the way every gate reads a built package. Every
 * gate's npm script is `tsc --build && node …`, so the build has run by the time this is imported.
 */
export function fakeProviderBins(env) {
  if (env.SLAVEOFAI_REQUIRE_FAKE_CLI !== '1') return {}
  const bins = {}
  for (const manifest of Object.values(PROVIDER_MANIFESTS)) {
    const { binEnvVar, binary } = manifest.invocation
    const named = env[binEnvVar]
    if (named !== undefined && named.trim() !== '') continue
    const fake = join(repoRoot, 'scripts', 'gate-fakes', `fake-${binary}.sh`)
    if (existsSync(fake)) bins[binEnvVar] = fake
  }
  return bins
}

/** … the existing docstring … plus:
 *
 *  It also arms the fake binary of every provider the caller did not name, but ONLY when the
 *  environment says `SLAVEOFAI_REQUIRE_FAKE_CLI=1` -- see `fakeProviderBins`. */
export function loopbackChildEnv(extra = {}) {
  gateStateDir()
  const env = { ...process.env, ...extra }
  env.SLAVEOFAI_SESSION_SECRET = ''
  env.SLAVEOFAI_PASSWORD = ''
  return { ...env, ...fakeProviderBins(env) }
}
```

(b) The four gates that build a child environment by hand rather than through `loopbackChildEnv` — `scripts/gate-m8-plan.mjs:101-108`, `scripts/gate-m8a-merge.mjs:99-106`, `scripts/gate-m8a-estop.mjs` (the same block; find it with `grep -n "SLAVEOFAI_REQUIRE_FAKE_CLI" scripts/gate-m8a-estop.mjs`) and `scripts/gate-m10-org.mjs:205-214`. Each gains one import and one spread, in the same shape, at the END of the literal so it cannot override a value the gate chose:

```js
import { fakeProviderBins } from './lib/child-env.mjs'
```

```js
      env: {
        ...process.env,
        SLAVEOFAI_CLAUDE_BIN: 'node',
        SLAVEOFAI_CLAUDE_ARGS: `${FAKE_CLAUDE} --fixture m8-flow`,
        // M32 item 7: the CLI refuses to start if the two lines above ever go missing, rather
        // than falling back to the real `claude`.
        SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
        // M56a R10: that refusal covers every registered provider now, so this daemon names the
        // rehearsal fake for the ones this gate never dispatches. One helper, not one literal per
        // gate (plan erratum E11).
        ...fakeProviderBins({ SLAVEOFAI_REQUIRE_FAKE_CLI: '1' }),
      },
```

(c) `.github/workflows/ci.yml` — one line in the `gates` job's `env:` block, beside the two that are already there:

```yaml
      SLAVEOFAI_CLAUDE_BIN: ${{ github.workspace }}/scripts/gate-fakes/fake-claude.sh
      # M56a R10: the spend net covers every registered binary now, and this is the outermost net --
      # a gate whose own child environment forgot the Cursor fake still meets a job-wide one. The
      # repository already had this fake; nothing here is new but the line that arms it.
      SLAVEOFAI_CURSOR_BIN: ${{ github.workspace }}/scripts/gate-fakes/fake-cursor-agent.sh
      # M32 item 7: job-wide, beside the binary it is about. …
      SLAVEOFAI_REQUIRE_FAKE_CLI: '1'
```

(d) The five base environments in the two orchestrator integration files that spawn a real CLI subprocess: `apps/orchestrator/test/integration/cli.test.ts:49-55`, `:74-80`, `:1266-1271`, `:1307-1312`, `:2584-2590`, `:3978-3987` and `apps/orchestrator/test/integration/milestone-gate.test.ts:36-43`. Each literal gains one line, with the constant defined once per file beside `FAKE`:

```ts
/** M56a R10: `fakeCliRefusal` covers every registered provider, so a child that asks for fakes has
 *  to name this one too. The gate rehearsal fake, which exists and is not `cursor-agent`. */
const FAKE_CURSOR = join(REPO_ROOT, 'scripts', 'gate-fakes', 'fake-cursor-agent.sh')
```

```ts
        SLAVEOFAI_REQUIRE_FAKE_CLI: '1',
        SLAVEOFAI_CURSOR_BIN: FAKE_CURSOR,
```

Find every one of them rather than trusting this list, and say how many you found in the task report:

```bash
grep -rn "SLAVEOFAI_REQUIRE_FAKE_CLI" apps/orchestrator/test scripts/*.mjs | grep -v "^scripts/lib" | wc -l
```

- [ ] **Step 8: The wiring loop, and the one test that can reach it**

`apps/orchestrator/src/cli.ts:871-923`. The function keeps its whole docstring and gains two paragraphs; it becomes exported so a test and the gate can build the real thing rather than describe it.

```ts
/**
 * The registry every command resolves its adapter from.
 *
 * … (the existing docstring, unchanged) …
 *
 * M56a R6: a LOOP over `PROVIDER_KINDS`, not one option block per vendor. Each kind's command comes
 * from its own manifest's `binEnvVar` (falling back to the binary it names), its extra argv from
 * `argsEnvVar`, and every kind is handed the SAME four script paths -- so the
 * `SLAVEOFAI_<PROVIDER>_BIN` convention is declared once, in the manifest, instead of being spelled
 * at four sites in three files. Both kinds stay configured unconditionally, for the reason above.
 *
 * EXPORTED (M56a §3 stage 5): the gate builds this registry in a process with both bin variables
 * set and asserts both kinds resolve to adapters whose `kind` fields are the two `ProviderKind`
 * members. Importing this module runs nothing -- `main()` is guarded by the `argv[1]` check at the
 * bottom of this file, which exists for exactly that reason.
 */
export function buildAdapterRegistry(): AdapterRegistry {
  // The refusal `claudeCommandFrom` used to raise on the way past. Asked ONCE here, because it is
  // about every registered binary now and not only the one this loop happens to read first
  // (M56a R10) -- and asked BEFORE anything is constructed, so a mis-armed process refuses to start
  // rather than refusing at its first dispatch.
  const refusal = fakeCliRefusal(process.env)
  if (refusal !== null) throw new Error(refusal)

  const tap = tapPath()
  const scripts = {
    // M12 Task 2: the hook path is a fact about the adapter instance, not a per-run input.
    hookPath: hookPath(),
    gatePath: cursorGatePath(),
    // M52 erratum E6: the ONE place `brokerCliPath` is set, for both runtimes, from the same
    // reading -- a worker's broker client is the orchestrator's own CLI whichever vendor is driving.
    brokerCliPath: brokerCliPath(),
    // M51 R6: a conditional spread because `exactOptionalPropertyTypes` treats an explicit
    // `undefined` as a different (and disallowed) thing from the key being absent -- and an absent
    // `tapPath` is exactly what "run as we did before M51" means to the adapter.
    ...(tap === undefined ? {} : { tapPath: tap }),
  }

  const wiring: Partial<Record<ProviderKind, ProviderWiring>> = {}
  for (const kind of PROVIDER_KINDS) {
    const { binEnvVar, argsEnvVar, binary } = manifestFor(kind).invocation
    const extra = process.env[argsEnvVar]
    wiring[kind] = {
      command: process.env[binEnvVar] ?? binary,
      ...(extra === undefined || extra === '' ? {} : { extraArgs: extra.split(' ') }),
      scripts,
    }
  }
  return buildRegistry(wiring)
}
```

`apps/orchestrator/test/integration/adapter-registry.test.ts` — under `test/integration/` because importing `cli.js` pulls the Prisma client in, and only that project is guaranteed a `DATABASE_URL`:

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { PROVIDER_KINDS, manifestFor } from '@slave-of-ai/domain'
import { buildAdapterRegistry } from '../../src/cli.js'

/** Every variable this file touches, restored after each case: `process.env` is process-wide and
 *  the integration project runs single-threaded. */
const TOUCHED = ['SLAVEOFAI_REQUIRE_FAKE_CLI', ...PROVIDER_KINDS.flatMap((kind) => [
  manifestFor(kind).invocation.binEnvVar,
  manifestFor(kind).invocation.argsEnvVar,
])]
const saved = new Map<string, string | undefined>(TOUCHED.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('buildAdapterRegistry (R6)', () => {
  it('wires every kind from its own manifest’s env vars, and resolves each to its own adapter', () => {
    for (const kind of PROVIDER_KINDS) process.env[manifestFor(kind).invocation.binEnvVar] = '/bin/true'
    delete process.env['SLAVEOFAI_REQUIRE_FAKE_CLI']
    const registry = buildAdapterRegistry()
    for (const kind of PROVIDER_KINDS) expect(registry.resolve(kind).kind, kind).toBe(kind)
  })

  it('refuses to build anything at all when the fake CLI was demanded and not supplied (R10)', () => {
    process.env['SLAVEOFAI_REQUIRE_FAKE_CLI'] = '1'
    process.env['SLAVEOFAI_CLAUDE_BIN'] = '/repo/scripts/gate-fakes/fake-claude.sh'
    delete process.env['SLAVEOFAI_CURSOR_BIN']
    expect(() => buildAdapterRegistry()).toThrow(/SLAVEOFAI_CURSOR_BIN/)
  })
})
```

`apps/orchestrator/test/integration/tick.test.ts:1043` takes the new wiring shape and keeps its comment and every assertion:

```ts
    const realRegistry = buildRegistry({
      claude_code: {
        command: 'node',
        extraArgs: [FAKE, '--fixture', 'complete'],
        scripts: { hookPath: REAL_GATE, gatePath: REAL_GATE },
      },
    })
```

and `packages/providers/test/cursor-adapter.test.ts:189-191` the same:

```ts
    const registry = buildRegistry({ cursor: { command: 'cursor-agent', scripts: { hookPath: gatePath, gatePath } } })
    expect(registry.resolve('cursor').kind).toBe('cursor')
```

- [ ] **Step 9: The two capability reads and the skills fact (R9, erratum E7)**

`apps/orchestrator/src/pump.ts:467` — the pause read, which is what R9 is about:

```ts
  // M56a R9: the capability, not the vendor. `capabilitiesOf(provider).canPauseMidRun` is the
  // boolean this literal always stood for, and this function's own docstring already explained the
  // branch in capability terms -- "`claude_code` cannot enter this function's body at all" -- which
  // is now true of the code as well as of the comment.
  if (input.spawn === undefined || capabilitiesOf(input.spawn.provider ?? 'claude_code').canPauseMidRun) return false
```

Read the branch before writing it: today's `if (input.spawn?.provider !== 'cursor') return false` returns `false` for an absent `spawn`, for an absent `provider` and for Claude. The replacement must do the same three things, which is why the backfill default is spelled — `spawn.provider` is optional on `PumpRunInput` and a fixture that never pauses need not invent one, and `?? 'claude_code'` is the historical-fact default this file's neighbours already use.

`apps/orchestrator/src/pump.ts:125-154` — the SKILLS fact, which is not a pause fact:

```ts
/**
 * Whether the runtime this run was SPAWNED with can report SKILL invocations at all (M14
 * §4.1, Decision 4, narrowed by M15 spec §4 -- see below).
 *
 * … (the existing docstring, unchanged) …
 *
 * M56a erratum E7: `providerRunsSkills` is the manifest's own answer -- a provider's skills
 * mechanism IS the `Skill` tool in its governed toolbox -- rather than this file naming a vendor.
 * The literal it replaces read `!== 'cursor'` and stood for exactly this fact; mapping it onto
 * `canPauseMidRun`, which is `false` for the same one provider today, would have been
 * behaviour-identical and false.
 */
function runtimeReportsUsage(spawn: PumpRunInput['spawn']): boolean {
  return providerRunsSkills(spawn?.provider ?? 'claude_code')
}
```

`apps/orchestrator/src/runContext.ts:221` — the same fact, at the site §2 never named:

```ts
  // Cursor has no skills mechanism at all (M37 spec §9, a stated non-goal): copying files it will
  // never read would be a prompt that promises capabilities the run does not have. M56a erratum E7:
  // asked of the manifest -- a provider's skills mechanism is the `Skill` tool in its governed
  // toolbox -- so a third runtime answers this on the day its manifest lands.
  if (!providerRunsSkills(input.provider)) return { ...nothing, provider_unsupported: true, no_worktree: false }
```

`apps/orchestrator/src/sweep.ts:940` — the cast (erratum E8):

```ts
    const adapter = resolveAdapter(deps.registry, (run.provider ?? 'claude_code') as ProviderKind)
```

Run: `npx vitest run apps/orchestrator/test/integration/pump.test.ts apps/orchestrator/test/integration/runContext.test.ts apps/orchestrator/test/integration/cursor-pause.test.ts apps/orchestrator/test/integration/sweep.test.ts`
Expected: PASS, all four **unchanged**: `pump.test.ts`'s Cursor spawn fixtures still get `skillCalls: DbNull` and still record a pause rather than a crash, and `runContext.test.ts:540-544` still reads `provider_unsupported: true` for a Cursor run.

- [ ] **Step 10: The last vendor literal standing in for a capability (R6, errata E8 and E10)**

`packages/control/src/simulation/write.ts`. The two refusal SENTENCES do not move; the order of the two tests does, because a capability cannot be asked of a string that is not a kind:

```ts
type ValidatedLlmInput = { readonly modelProvider: ProviderKind; readonly model: string; readonly maxModelCostUsd: number }

/** `createSimulation`'s `decisionProvider: 'llm'` guard (M31a §3): the provider must be one this
 *  system can CAP -- a provider that reports no cost can never have a budget enforced against it --
 *  then `model` a non-empty text and `maxModelCostUsd` a positive finite number. Returns the
 *  trimmed, narrowed values a `rules` run never needs to carry.
 *
 *  M56a R6: the check is `capabilitiesOf(kind).reportsCost`, not a vendor name. The two sentences an
 *  operator reads are unchanged, and so are the two answers -- `cursor` is a kind whose capability
 *  row reports no cost, anything else is not a kind at all -- but the ORDER of the tests is
 *  reversed, because `capabilitiesOf` may only be asked about a real `ProviderKind`. */
function validateLlmInput(input: { readonly modelProvider?: string; readonly model?: string; readonly maxModelCostUsd?: number }): Result<ValidatedLlmInput, ControlRefusal> {
  if (input.modelProvider === undefined) return err({ kind: 'invalid_simulation_input', detail: LLM_INPUT_MESSAGES.modelProviderRequired })
  if (!isProviderKind(input.modelProvider)) return err({ kind: 'unsupported_model_provider', provider: input.modelProvider, reason: 'it is not a configured provider' })
  if (!capabilitiesOf(input.modelProvider).reportsCost) return err({ kind: 'unsupported_model_provider', provider: input.modelProvider, reason: 'it reports no cost, so a cap cannot be enforced' })
  const model = input.model?.trim()
  if (model === undefined || model === '') return err({ kind: 'invalid_simulation_input', detail: LLM_INPUT_MESSAGES.modelRequired })
  if (input.maxModelCostUsd === undefined || !Number.isFinite(input.maxModelCostUsd) || input.maxModelCostUsd <= 0) return err({ kind: 'invalid_simulation_input', detail: LLM_INPUT_MESSAGES.maxModelCostUsdPositive })
  return ok({ modelProvider: input.modelProvider, model, maxModelCostUsd: input.maxModelCostUsd })
}
```

with `createSimulation`'s own input type at `:77` taking the union by import (`readonly modelProvider?: ProviderKind`) and `isProviderKind`/`capabilitiesOf` imported from `../org.js` and `@slave-of-ai/providers`. `org.ts` and `workspace.ts` already import each other, so a fourth module reaching `isProviderKind` adds no cycle this package does not already have and survive.

`packages/control/src/simulation/llm.ts:235` (erratum E10):

```ts
        simulationId,
        seq: usageSeq,
        // M56a R6: the run's OWN provider, not a constant. `SimulationModelUsage.provider` is NOT
        // NULL and `SimulationRun.modelProvider` is nullable, so the historical-fact default is
        // spelled -- the same one `sweep.ts` and `resume.ts` use for a pre-M12 row. It is
        // unreachable in practice: a `rules` run never reaches this function and an `llm` run
        // cannot be created without a `modelProvider`.
        provider: row.modelProvider ?? 'claude_code',
```

`packages/control/src/simulation/adopt.ts:36,133` and `shared.ts:24` take the union by import (erratum E8):

```ts
  readonly model: { readonly provider: ProviderKind; readonly model: string } | null
```
```ts
  readonly modelProvider: ProviderKind | null
```

Run: `npx vitest run packages/control/test/integration/simulation-llm.test.ts packages/control/test/integration/simulation.test.ts`
Expected: PASS, unchanged — including the two cases that assert `unsupported_model_provider`'s two sentences. If either simulation test file does not exist under those names, find them with `grep -rln "unsupported_model_provider" packages/control/test` and run those.

- [ ] **Step 11: Run the whole suite, then ladder and commit**

```bash
npx vitest run 2>&1 | tail -20
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: at or above Task 1's numbers, plus two files. **This is the task most likely to move a number somewhere else**: the spend net now refuses environments that used to start, so a failure here is most likely a test environment Step 7 missed — read the failing message, which names the variable.

```bash
git add packages/providers packages/control apps/orchestrator scripts/lib/child-env.mjs scripts/gate-m8-plan.mjs scripts/gate-m8a-merge.mjs scripts/gate-m8a-estop.mjs scripts/gate-m10-org.mjs .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
feat(providers,orchestrator): m56a t3 — a table where a signature was, and a net that covers both binaries

`buildRegistry` took a fixed two-named-field object, so adding a provider meant widening a function
signature. It takes `Partial<Record<ProviderKind, ProviderWiring>>` now and its body is a loop;
`PROVIDER_ADAPTERS` is a `Record` over the same union `PROVIDER_MANIFESTS` is, so a registration
without a manifest -- an adapter nobody measured -- cannot exist. One wiring shape, not two option
types a caller has to know apart: the command per kind, and the same four script paths for every
entry.

`listProviderModels` loses its switch: `configured` answers the manifest's own table, `listed` runs
the manifest's argv and hands stdout to the entry's parser. The same two answers, from the same two
code paths, with the branch chosen by data. `buildAdapterRegistry` is a loop that reads each kind's
`SLAVEOFAI_<X>_BIN` out of its manifest instead of spelling the convention at four sites in three
files, and it is exported so the gate can build the real thing rather than describe it.

The spend net covers every registered binary. `fakeCliRefusal` read `SLAVEOFAI_CLAUDE_BIN` and
nothing else, so a CI job with the flag set and no Cursor variable would have spawned the real
`cursor-agent` the moment anything dispatched a Cursor run. It loops the manifests now and names the
variable that failed. That refusal would have stopped twenty-eight gates and five test environments
that were never wrong about anything, so `loopbackChildEnv` arms the rehearsal fake for every
provider a caller did not name -- one helper, not twenty-eight copies of one line -- and only when
the environment actually asked for fakes, which is why `gate:m13-runtime` still drives the real
binaries.

The last three vendor literals standing in for a capability are gone: the simulation's llm guard asks
`reportsCost` (same two sentences, byte for byte), the usage row writes the run's own provider, and
the pump's pause branch asks `canPauseMidRun`. The pump's OTHER literal was not a pause fact at all
-- it gates the skills tally -- and it and `injectSkills` now ask `providerRunsSkills`, which is the
manifest's own answer: a provider's skills mechanism is the `Skill` tool in its governed toolbox.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RBVSwP5Paww1L1hqS7Dper
EOF
)"
```

---

### Task 4: The word a person reads, the cards a person sees, and the flag a person types (R2, R10, E8, E9, E16, E17, D41–D48)

`apps/web` and the CLI's one remaining copy of the union. Nothing rendered changes: the Settings page shows the same four cards with the same four captions, every provider `<select>` offers the same two options with the same two words, and `--model-provider` refuses the same strings with the same sentence. What changes is where those facts come from.

**Files:**
- Modify: `apps/web/src/lib/providerLabel.ts`, `apps/web/src/server/settings.ts`, `apps/web/src/app/api/sim/route.ts`, `apps/web/src/components/sim/AdoptDrawer.tsx`, `apps/orchestrator/src/cli.ts`, `packages/control/src/index.ts`, `apps/web/test/integration/settings-snapshot.test.ts`
- Test: `apps/web/test/integration/settings-snapshot.test.ts` (one case added, three unchanged), plus `apps/web/test/provider-select.test.tsx`, `apps/web/test/settings-page.test.tsx`, `apps/web/test/simulation-page.test.tsx` and `apps/web/test/overview-components.test.tsx` — **unchanged and re-run**
- Gates: `npm run web:build`, `npm run gate:m16-chrome`, `npm run gate:m44-ux-foundation`

**Interfaces:**
- Consumes: `PROVIDER_KINDS`, `PROVIDER_LABEL`, `manifestFor`, `type ProviderKind` (Task 1, via `@slave-of-ai/domain`); `PROVIDER_ADAPTERS` (Task 3, via `@slave-of-ai/control`); `capabilitiesOf` (`@slave-of-ai/control`, unchanged); `isProviderKind` (`packages/control/src/org.ts:21`).
- Produces: `apps/web/src/lib/providerLabel.ts` exporting the same three names (`PROVIDER_KINDS`, `PROVIDER_LABEL`, `providerLabel`) from the same path, so its four client consumers and its test are untouched; `versionOf(bin)` with the same signature and a manifest-driven override; `REAL` derived and `LATER` intact.

- [ ] **Step 1: The client-safe list stops being a second copy**

`apps/web/src/lib/providerLabel.ts` in full. The file keeps its name, its three exports and its em dash; what goes is the list and the table, and what replaces the long docstring is the sentence that says why they left:

```ts
import { PROVIDER_KINDS, PROVIDER_LABEL, type ProviderKind } from '@slave-of-ai/domain'

/**
 * Every `ProviderKind`, and the word a person reads for each -- both RE-EXPORTED from
 * `@slave-of-ai/domain` (M56a R2), which is where they are declared.
 *
 * This file used to carry a second, independently-guarded copy of the list and the only copy of the
 * table, and its own docstring argued for both: "the provider vocabulary belongs to
 * `@slave-of-ai/providers`, whose value exports a client bundle cannot reach, and inventing a second
 * home for it in the domain would put the union in three places instead of two". The first half is
 * still true and is exactly why the union did not move THERE; the second half was answered by
 * counting -- the union was in ten places, and M56a MOVED it rather than copying it.
 *
 * A VALUE import of `@slave-of-ai/domain` is safe in a client component and a value import of
 * `@slave-of-ai/providers` is not: the providers barrel re-exports two adapters that import
 * `node:child_process` at module scope with no `sideEffects: false` escape hatch, while the domain
 * depends on nothing but `zod`. `apps/web/src/components/SlavePanel.tsx:5-12` already value-imports
 * `PERMISSION_PROVIDERS` and `TOOLS_BY_KIND` from the domain in a client component, and has since
 * M52.
 *
 * Re-exported rather than replaced because four client components and
 * `apps/web/test/provider-select.test.tsx` import these two names FROM THIS PATH, and
 * `docs/ia.md` rule 2 is that nothing is removed, only moved.
 */
export { PROVIDER_KINDS, PROVIDER_LABEL }
export type { ProviderKind }

/** The em dash every one of these surfaces already showed for "no run has resolved a provider"
 *  (M12 Task 9, ruling R10), so the null case is spelled once rather than at four call sites. */
export function providerLabel(kind: ProviderKind | null): string {
  return kind === null ? '—' : PROVIDER_LABEL[kind]
}
```

Run: `npx vitest run apps/web/test/provider-select.test.tsx`
Expected: PASS, unchanged — it imports all three names from this path and asserts the label is never the key.

- [ ] **Step 2: The Settings cards derive, and the two placeholders stay exactly where they are**

`apps/web/src/server/settings.ts`. Three edits and one deliberate non-edit.

```ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PROVIDER_ADAPTERS, capabilitiesOf, type ProviderKind } from '@slave-of-ai/control'
import { PERMISSION_KINDS, PROVIDER_KINDS, PROVIDER_LABEL, manifestFor, type PermissionKind } from '@slave-of-ai/domain'
import { prisma } from '@slave-of-ai/db/client'
```

(a) `REAL` (`:32-35`) derives from the three tables that now hold its four fields (M56a R10, §4 row 17):

```ts
/**
 * The REAL adapters, derived, and the two the handoff draws but this codebase does not have.
 *
 * Every field of a real card comes from a table that owns it: the kind and its word from the
 * domain's `PROVIDER_KINDS`/`PROVIDER_LABEL`, the binary from that provider's manifest, the class
 * name from its registry entry. Before M56a this array was a fourth copy of all four, and moving a
 * vendor out of `LATER` meant editing it by hand.
 *
 * `LATER` is UNCHANGED and stays hand-written: there is no adapter behind those two cards to derive
 * anything from, which is the whole point of them. They are rendered disabled and captioned
 * `not configured · later` (M14 Decision 7) -- a card that looks functional and is not is the exact
 * lie that milestone was about -- and they move only in M56b and M56c, each of which installs its
 * vendor's binary and measures it first. M56a ships no third provider, so nothing here moves.
 */
const REAL: ReadonlyArray<{ kind: ProviderKind; label: string; bin: string; adapter: string }> = PROVIDER_KINDS.map(
  (kind) => ({
    kind,
    label: PROVIDER_LABEL[kind],
    bin: manifestFor(kind).invocation.binary,
    adapter: PROVIDER_ADAPTERS[kind].adapterName,
  }),
)

const LATER: ReadonlyArray<{ kind: string; label: string; adapter: string }> = [
  { kind: 'codex', label: 'OpenAI Codex', adapter: 'CodexAdapter — planned' },
  { kind: 'gemini', label: 'Gemini', adapter: 'GeminiAdapter — planned' },
]
```

(b) `versionOf` (`:50-61`) keeps its `bin: string` parameter — `settings-snapshot.test.ts:34` injects a resolver keyed on the binary NAME, and erratum E16 is that keeping the signature is what keeps that file unedited — and replaces its two-branch override with the manifest's own map:

```ts
/**
 * Which environment variable overrides which binary, from the manifests (M56a R10, §4 row 18).
 *
 * The two-branch `bin === 'claude' ? … : …` this replaces had the third provider's branch already
 * written into its shape: a `gemini` would have read `SLAVEOFAI_CURSOR_BIN`. A binary nothing
 * declares now gets NO override, which is the honest answer.
 */
const BIN_ENV_VAR: Readonly<Record<string, string>> = Object.fromEntries(
  PROVIDER_KINDS.map((kind) => [manifestFor(kind).invocation.binary, manifestFor(kind).invocation.binEnvVar]),
)

export async function versionOf(bin: string): Promise<string | null> {
  const envVar = BIN_ENV_VAR[bin]
  const override = envVar === undefined ? undefined : process.env[envVar]
  try {
    const { stdout } = await run(override !== undefined && override !== '' ? override : bin, ['--version'], {
      timeout: 10_000,
    })
    const first = stdout.trim().split('\n')[0]
    return first === undefined || first === '' ? null : first
  } catch {
    return null
  }
}
```

(c) `packages/control/src/index.ts` re-exports the registry table beside the two it already re-exports, with the same reasoning those two carry:

```ts
/** Re-exported for `capabilitiesOf`'s reason (M56a R10): `apps/web/src/server/settings.ts` names
 *  the adapter CLASS on each provider card, and the registry entry is where that name lives now
 *  instead of in a fourth hand-written array. A SERVER caller only -- this is a value from
 *  `@slave-of-ai/providers` and carries its `node:child_process` imports with it, exactly like
 *  `capabilitiesOf` above, which `settings.ts` already imports. */
export { PROVIDER_ADAPTERS } from '@slave-of-ai/providers'
export type { ProviderRegistration, ProviderWiring } from '@slave-of-ai/providers'
```

(d) The deliberate non-edit: `buildProviderAdapters`'s body (`:69-110`) does not change at all. It still maps `REAL`, still calls `resolveVersion(adapter.bin)`, still flattens `capabilitiesOf(adapter.kind)` into the same three display fields, and still appends `LATER`.

- [ ] **Step 3: The card golden, in the one place that can assert it (erratum E17)**

`apps/web/test/integration/settings-snapshot.test.ts` gains ONE case and keeps its four. The other three already assert the mapping, the capability triples and the `later` cards by hand; this one pins the whole array against the bytes captured before the migration.

```ts
import { readFileSync } from 'node:fs'
// …

    it('produces the card array this milestone found, derived from three tables instead of four copies', async (): Promise<void> => {
      // M56a erratum E17: `apps/web` is a Next app with no `dist`, so no `.mjs` gate can import
      // `buildProviderAdapters` -- this file is where stage 10's card half lives, and the gate
      // asserts the same golden against `PROVIDER_MANIFESTS`, `PROVIDER_LABEL` and
      // `PROVIDER_ADAPTERS` from the other side.
      const cards = await buildProviderAdapters(async () => '9.9.9')
      const golden: unknown = JSON.parse(readFileSync('scripts/fixtures/m56a-goldens/settings-cards.json', 'utf8'))
      // `slavesBound` is excluded on purpose: it is a `groupBy` over whatever `SlaveRun` rows this
      // database holds, which is not a golden-able fact. It is asserted as a number instead.
      expect(
        cards.map(({ slavesBound, version, ...card }) => ({ ...card, version: version === null ? null : '<resolver>' })),
      ).toEqual(golden)
      for (const card of cards) expect(card.slavesBound, card.kind).toBeGreaterThanOrEqual(0)
    })
```

Run: `npx vitest run apps/web/test/integration/settings-snapshot.test.ts`
Expected: PASS, five cases.

- [ ] **Step 4: The last two union copies in the web (erratum E8)**

`apps/web/src/app/api/sim/route.ts:25`:

```ts
import { PROVIDER_KINDS } from '@slave-of-ai/domain'
// …
    // M56a R2: the union, not a literal. `z.enum` takes a readonly tuple, which is what
    // `PROVIDER_KINDS` is, so a third provider is offered here the day it exists.
    modelProvider: z.enum(PROVIDER_KINDS).optional(),
```

`apps/web/src/components/sim/AdoptDrawer.tsx:36` — a CLIENT component, so the import is TYPE-ONLY and is erased at compile time, reaching no runtime module:

```ts
import type { ProviderKind } from '@slave-of-ai/domain'
// …
  readonly model: { readonly provider: ProviderKind; readonly model: string } | null
```

- [ ] **Step 5: The CLI's flag (erratum E9)**

`apps/orchestrator/src/cli.ts:2712-2714`. The membership test derives; the SENTENCE does not:

```ts
      const modelProviderText = flagText(flags, 'model-provider')
      // M56a R2: membership from `isProviderKind`, which is this tree's one answer for an untrusted
      // provider string (`packages/control/src/org.ts:21`). The SENTENCE stays hand-written: it is
      // prose an operator reads, `oneOfFlag` would reword it to "must be one of claude_code,
      // cursor", and this milestone changes no operator-visible text (plan erratum E9).
      if (modelProviderText !== undefined && !isProviderKind(modelProviderText)) throw new Error('--model-provider must be claude_code or cursor')
      const modelProvider = modelProviderText as ProviderKind | undefined
```

`isProviderKind` is already imported into `cli.ts`? Check with `grep -n "isProviderKind" apps/orchestrator/src/cli.ts`; if not, add it to the existing `@slave-of-ai/control` import. `ProviderKind` likewise.

- [ ] **Step 6: Run the web suite, then build, then the two browser gates**

One vitest at a time, no gate beside vitest, nothing beside a `web:build`.

```bash
npx vitest run apps/web/test
```
Expected: PASS. Four files assert provider words and none of them was edited: `provider-select.test.tsx`, `settings-page.test.tsx`, `simulation-page.test.tsx` (whose comment at `:301` names the `PROVIDER_KINDS` blocklist) and `overview-components.test.tsx:124`.

```bash
pgrep -af "next dev"   # must be empty; kill it and SAY SO in the report if not
npm run web:build
```
Expected: a clean build. **This is the gate that matters for this task**: `providerLabel.ts` is imported by four client components, and a value import that dragged a Node-only module into a client bundle fails HERE and in neither tsc nor vitest.

```bash
rm -rf apps/web/.next
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m16-chrome
CHROMIUM_PATH="$HOME/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome" \
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m44-ux-foundation
```
Expected: both PASS. `gate:m44` is the one that matters here — it derives its "no raw enum member is visible text" blocklist from `PROVIDER_KINDS` read out of `packages/providers/dist/index.js` (`scripts/gate-m44-ux-foundation.mjs:74,160`), which is now a re-export of the domain's list, and it visits every surface that prints a provider word. **Neither gate needs `SLAVEOFAI_CURSOR_BIN` on the command line**: Task 3's `loopbackChildEnv` arms it for the child, which is what that helper is for.

- [ ] **Step 7: Ladder and commit**

```bash
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```

```bash
git add apps/web apps/orchestrator/src/cli.ts packages/control/src/index.ts
git commit -m "$(cat <<'EOF'
feat(web,cli): m56a t4 — the same words, from the table that owns them

`apps/web/src/lib/providerLabel.ts` kept a second, independently-guarded copy of the union and the
only copy of the label table, and argued for both in its own docstring: a client bundle cannot value
-import the providers package, and a second home in the domain would make three copies. The first
half is why the union did not move there; the second was answered by counting -- there were ten --
and the domain is a package `SlavePanel.tsx` has value-imported from a client component since M52.
Both names are re-exported from this path, so four components and a test are untouched.

The Settings cards derive. Every field of a real card now comes from the table that owns it: the kind
and its word from the domain, the binary from that provider's manifest, the class name from its
registry entry. `versionOf` keeps its parameter -- the snapshot test injects a resolver keyed on the
binary name -- and replaces `bin === 'claude' ? … : …` with the manifests' own map, in which a binary
nothing declares gets no override rather than the other vendor's. The two `later` cards are
untouched: there is no adapter behind them to derive anything from, which is the whole point of them,
and they move in M56b and M56c after somebody installs those binaries and measures them.

`z.enum(PROVIDER_KINDS)` on the simulation route, the union by type import in a client drawer, and
`isProviderKind` behind `--model-provider` -- whose sentence is unchanged, because it is prose an
operator reads and this milestone changes none.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RBVSwP5Paww1L1hqS7Dper
EOF
)"
```

---

### Task 5: The checklist somebody can re-run, and a ledger nobody has to keep in step (§4, R3, R4, D49–D53)

`packages/domain` and `docs/`. The milestone's claim is a COUNT — twenty-six sites become six — and a count belongs somewhere a person can re-run it. This task writes that down, and renders the differences ledger FROM the manifests so the one document that describes both providers cannot drift from the two rows that define them.

**Why this comes before the gate and not after it.** The gate task is last in every milestone this repository has shipped, because the last task is the one that runs the full ladder and (here) the two real-binary measurement gates, and anything that lands after that ladder is unladdered. A generated table and a document are code and prose that the gate's stage 12 then has to find the tree clean of.

**Files:**
- Create: `packages/domain/src/provider/ledger.ts`, `packages/domain/test/provider/ledger.test.ts`, `docs/providers/adding-a-provider.md`
- Modify: `packages/domain/src/provider/index.ts`, `README.md`
- Test: `packages/domain/test/provider/ledger.test.ts`

**Interfaces:**
- Consumes: `PROVIDER_KINDS`, `PROVIDER_LABEL`, `PROVIDER_MANIFESTS`, `manifestFor`, `type ProviderCapabilityManifest` (Task 1).
- Produces: `LEDGER_AXES: readonly LedgerAxis[]`, `renderProviderLedger(): string`, and `docs/providers/adding-a-provider.md` carrying its output between two markers.

**One rule about this task's own prose.** `gate:m26-vocabulary` greps this repository for the old vocabulary and its exclude list covers `docs/superpowers` and `docs/decisions` — **not `docs/providers`** (`scripts/gate-m26-vocabulary.mjs:8-11`). `cursor-agent`, `agentic` and `AGENTS.md` are protected by name; "the vendor's a-g-e-n-t" is not. Write the document, then run the gate, then read it again.

- [ ] **Step 1: Write the failing test for the ledger**

`packages/domain/test/provider/ledger.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PROVIDER_KINDS, PROVIDER_LABEL } from '../../src/provider/kind.js'
import { manifestFor } from '../../src/provider/manifest.js'
import { LEDGER_AXES, LEDGER_END, LEDGER_START, renderProviderLedger } from '../../src/provider/ledger.js'

const DOC = 'docs/providers/adding-a-provider.md'

describe('renderProviderLedger (§4)', () => {
  it('is a column per provider, in PROVIDER_KINDS order, headed by the words a person reads', () => {
    const header = renderProviderLedger().split('\n')[0] ?? ''
    for (const kind of PROVIDER_KINDS) expect(header, kind).toContain(PROVIDER_LABEL[kind])
    expect(header.indexOf(PROVIDER_LABEL.claude_code)).toBeLessThan(header.indexOf(PROVIDER_LABEL.cursor))
  })

  it('is a row per axis, and every axis the manifest has is in it', () => {
    const rendered = renderProviderLedger()
    for (const axis of LEDGER_AXES) expect(rendered, axis.label).toContain(`| ${axis.label} |`)
    // Fourteen axes, minus `kind` (which is the column header) and `differences` (which is a list
    // under the table, not a cell), plus nothing.
    expect(LEDGER_AXES).toHaveLength(12)
  })

  it('never leaves a cell empty -- an unmeasured axis must read as one, not as a blank', () => {
    for (const axis of LEDGER_AXES) {
      for (const kind of PROVIDER_KINDS) expect(axis.cell(manifestFor(kind)).trim(), `${axis.label}/${kind}`).not.toBe('')
    }
  })

  it('escapes the one character a markdown table cannot carry', () => {
    // A `differences` sentence or a flag with a pipe in it would silently split a row in two.
    expect(renderProviderLedger()).not.toMatch(/[^\\]\|[^ \n|]/)
  })

  it('lists every stated limitation, so the ledger carries the prose and not only the axes', () => {
    const rendered = renderProviderLedger()
    for (const kind of PROVIDER_KINDS) {
      for (const sentence of manifestFor(kind).differences) {
        expect(rendered, `${kind}: ${sentence.slice(0, 40)}`).toContain(sentence.replaceAll('|', '\\|'))
      }
    }
  })
})

describe('the checked-in ledger (§4)', () => {
  it('is exactly what the manifests render, between the two markers', () => {
    // THE PARITY TEST. The document is checked in so a person can read it in a browser and a diff
    // can show it changing; this is what keeps it from drifting from the rows it describes. A
    // manifest edit that does not regenerate the block is red HERE.
    const doc = readFileSync(DOC, 'utf8')
    const start = doc.indexOf(LEDGER_START)
    const end = doc.indexOf(LEDGER_END)
    expect(start, `${DOC} carries ${LEDGER_START}`).toBeGreaterThanOrEqual(0)
    expect(end, `${DOC} carries ${LEDGER_END}`).toBeGreaterThan(start)
    expect(doc.slice(start + LEDGER_START.length, end).trim()).toBe(renderProviderLedger().trim())
  })

  it('names all six of the sites a third provider still has to touch', () => {
    const doc = readFileSync(DOC, 'utf8')
    for (const site of [
      'packages/domain/src/provider/',
      'PROVIDER_ADAPTERS',
      'packages/providers/src/',
      'scripts/gate-fakes/',
      'PROVIDER_LABEL',
      'schema.prisma',
    ]) {
      expect(doc, site).toContain(site)
    }
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run packages/domain/test/provider/ledger.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/provider/ledger.js"`.

- [ ] **Step 3: Write the ledger**

`packages/domain/src/provider/ledger.ts`:

```ts
import { PROVIDER_KINDS, PROVIDER_LABEL } from './kind.js'
import { manifestFor, type ProviderCapabilityManifest } from './manifest.js'

/** The markers `docs/providers/adding-a-provider.md` carries around the rendered block, and the
 *  parity test compares between. Kept here so the document and the renderer agree on them. */
export const LEDGER_START = '<!-- generated: provider-ledger -->'
export const LEDGER_END = '<!-- /generated: provider-ledger -->'

export interface LedgerAxis {
  /** What this axis IS, in words -- the row header a person reads. */
  readonly label: string
  /** The raw value, as the contract spells it. A table about a machine-checked contract prints the
   *  contract's own vocabulary: this is the one place in the product where the KEY is the thing
   *  worth reading, because the reader is somebody about to write a manifest. */
  cell(manifest: ProviderCapabilityManifest): string
}

const code = (value: string): string => `\`${value}\``
const list = (values: readonly string[]): string => (values.length === 0 ? '—' : values.map(code).join(' ')) 

/**
 * The differences ledger, as rows (M56a §4).
 *
 * Twelve of the manifest's fourteen axes: `kind` is the column header and `differences` is a list
 * under the table, because a table cell is the wrong shape for a paragraph.
 */
export const LEDGER_AXES: readonly LedgerAxis[] = [
  { label: 'Binary', cell: (m) => code(m.invocation.binary) },
  { label: 'Binary override', cell: (m) => `${code(m.invocation.binEnvVar)} ${code(m.invocation.argsEnvVar)}` },
  { label: 'Headless flags', cell: (m) => list(m.invocation.headlessFlags) },
  { label: 'Prompt', cell: (m) => code(m.invocation.promptDelivery) },
  { label: 'Never pass', cell: (m) => list(m.invocation.neverPass) },
  {
    label: 'Model discovery',
    cell: (m) =>
      m.modelDiscovery.mode === 'listed'
        ? `${code('listed')} (${list(m.modelDiscovery.argv)})`
        : m.modelDiscovery.mode === 'configured'
          ? `${code('configured')} (${String(m.modelDiscovery.options.length)} entries)`
          : code('none'),
  },
  { label: 'Resume', cell: (m) => `${code(m.resume.mode)}${m.resume.flag === null ? '' : ` on ${code(m.resume.flag)}`}` },
  { label: 'Pause rung', cell: (m) => `${code(m.pause.rung)} ([ADR 0001](/${m.pause.adr}))` },
  { label: 'Events', cell: (m) => `${code(m.events.transport)}, ${String(m.events.produces.length)} kinds` },
  { label: 'Structured output', cell: (m) => code(m.structuredOutput) },
  { label: 'Tool restrictions', cell: (m) => `${code(m.toolRestrictions.mechanism)} / ${code(m.toolRestrictions.enforce)}` },
  { label: 'Usage and cost', cell: (m) => code(m.usageCost) },
]

const escape = (cell: string): string => cell.replaceAll('|', '\\|')

/**
 * The ledger, rendered from the manifests (M56a §4).
 *
 * PURE: it reads `PROVIDER_MANIFESTS` and returns a string, touches no filesystem and imports no
 * `node:` module -- `apps/web`'s client bundle imports this package's index, and a `node:` anywhere
 * in its graph fails `web:build` outright (`packages/domain/src/goal/version.ts:23-36` records that
 * as a measured fact). Writing the string into the document is a person's act, and
 * `ledger.test.ts` is what makes forgetting it red.
 *
 * The table's cells print the contract's own vocabulary rather than a label table, which is the one
 * place in this product that is right: `docs/ia.md` rule 3 governs what a PERSON USING THE PRODUCT
 * reads, and the reader here is somebody about to write a `ProviderCapabilityManifest`.
 */
export function renderProviderLedger(): string {
  const kinds = [...PROVIDER_KINDS]
  const lines: string[] = []
  lines.push(`| Axis | ${kinds.map((kind) => PROVIDER_LABEL[kind]).join(' | ')} |`)
  lines.push(`|---|${kinds.map(() => '---').join('|')}|`)
  for (const axis of LEDGER_AXES) {
    lines.push(`| ${axis.label} | ${kinds.map((kind) => escape(axis.cell(manifestFor(kind)))).join(' | ')} |`)
  }
  lines.push(`| Hooks | ${kinds.map((kind) => escape(list(manifestFor(kind).hooks))).join(' | ')} |`)
  lines.push(`| Run files | ${kinds.map((kind) => escape(list(manifestFor(kind).runFiles.channels))).join(' | ')} |`)
  lines.push(
    `| Measured against | ${kinds.map((kind) => escape(`${code(manifestFor(kind).measured.version)} (${manifestFor(kind).measured.date})`)).join(' | ')} |`,
  )
  lines.push('')
  for (const kind of kinds) {
    lines.push(`**${PROVIDER_LABEL[kind]} — stated limitations**`)
    lines.push('')
    for (const sentence of manifestFor(kind).differences) lines.push(`- ${escape(sentence)}`)
    lines.push('')
  }
  return lines.join('\n')
}
```

Note the three rows appended after the loop: `Hooks`, `Run files` and `Measured against` are rendered directly rather than through `LEDGER_AXES` because each reads a LIST off the manifest rather than one value, and the test's `toHaveLength(12)` is what keeps that split honest rather than accidental.

`packages/domain/src/provider/index.ts` gains `export * from './ledger.js'`.

- [ ] **Step 4: Write the document**

`docs/providers/adding-a-provider.md`. Generate the block rather than typing it:

```bash
npx tsc --build
node --input-type=module -e "import('./packages/domain/dist/provider/ledger.js').then((m) => process.stdout.write(m.renderProviderLedger()))" > "$SCRATCHPAD/m56a-ledger.md"
```

```markdown
# Adding a provider

What it costs to put a third CLI runtime behind this product, and where every one of those costs
lives. Written in M56a, from the migration that reduced it: before that milestone a third provider
had to be threaded through **twenty-six** sites in six packages, most of which failed silently rather
than loudly when they were missed. It is **six** now, and the five that collapsed are kept collapsed
by a build error or by a gate.

This is a contract for the two milestones after it — M56b (the Codex CLI) and M56c (the Gemini CLI),
each blocked on its binary being installed and measurable — and for whatever comes after those.

## The rule that governs all six

**Every axis of a manifest is a MEASUREMENT.** `packages/providers/src/capabilities.ts:81-85` states
it and this milestone did not soften it: a capability may only ever be WIDENED by proof, never
narrowed, and never assumed true because a vendor's documentation says so. A first measurement is
held to the same standard as a widening — which is why a provider's spec is written after somebody
installs the binary and reads `--help` and `--version` on the machine, and why every row records the
version it was measured against.

The methodology is M13's Series C
(`docs/superpowers/specs/2026-08-29-m13-runtime-hardening-design.md:184-205`): outcome branches
written down in advance, two runs in a fresh `git worktree add` root, and the measured value recorded
with the binary version beside it.

## The six sites

1. **The manifest** — one module in `packages/domain/src/provider/`, plus one line in that
   directory's `index.ts`. Fourteen axes, and this is the measurement written down. A row with an
   empty `differences` is a row nobody measured, and the schema refuses one.
2. **The registration** — one entry in `PROVIDER_ADAPTERS` (`packages/providers/src/registry.ts`): a
   constructor, and for a provider whose models are LISTED, a parser. `PROVIDER_ADAPTERS` and
   `PROVIDER_MANIFESTS` are both `Record<ProviderKind, …>`, so a registration without a manifest is a
   build error rather than an adapter nobody measured.
3. **The adapter** — one directory under `packages/providers/src/` implementing
   `SlaveRuntimeAdapter` (`packages/providers/src/contract/adapter.ts`). This is the work itself.
4. **The rehearsal fake** — one script under `scripts/gate-fakes/`, named `fake-<binary>.sh`, and the
   one CI `env:` line that arms it. The name is the convention `scripts/lib/child-env.mjs` looks for,
   so a provider with no fake fails LOUDLY when a gate starts rather than quietly running against a
   real binary. A fixture-replay `.mjs` fake is OPTIONAL: Cursor ships without one and reads
   checked-in NDJSON fixtures instead.
5. **The word** — one key in `PROVIDER_LABEL` (`packages/domain/src/provider/kind.ts`) and the README
   sentence naming the vendor's binary. A product's word for a vendor is not derivable from that
   vendor's binary name, and prose is not derivable at all.
6. **The Postgres enum** — one value in `enum ProviderKind` (`packages/db/prisma/schema.prisma`) and
   an additive migration. No TypeScript derivation writes a migration. It is also the LOUDEST of the
   six: `packages/db/test/integration/enum-parity.test.ts` fails by name if the enum and
   `PROVIDER_KINDS` disagree in either direction, so it is the one site that cannot be forgotten.

Everything else derives: the capability table, the model listing, the permission vocabulary, the
enforcement axis, the registry's parameter shape, the wiring loop, the Settings cards, the spend net,
the simulation guard and the pause branch. `gate:m56a-provider-contract` keeps them derived — stage 1
greps for a second copy of the union and stage 8 for a `case` or an `if` keyed on a provider's name
outside a checked-in allow-list.

## What a provider with no hook plane can still do

M52's broker channel is provider-agnostic by construction: `SLAVEOFAI_BROKER_CHANNEL` and
`SLAVEOFAI_BROKER_CLI` need only a writable file and a way to invoke the orchestrator CLI, which is
true of any CLI-shaped runtime. So `read_secret` and `deploy_release` are answered for a hookless
vendor on day one. The other four permission kinds — `read_repo`, `write_repo`, `run_commands`,
`network_fetch` — need a real pre-tool-call interception a vendor may or may not expose, and
`toolRestrictions.mechanism: 'none'` is how a manifest says so out loud instead of letting somebody
discover it at dispatch.

Pause degrades down [ADR 0001's ladder](/docs/decisions/0001-pause-semantics.md#degradation-path-if-a-provider-lacks-hooks-spec-7):
`hook` stops a run between tool calls, `signal` cancels and resumes the session, and `none` is
declarable and **unregistrable** — `admitAdapter` refuses an adapter with neither capability, and the
recap-based continuation the ADR describes for that rung exists in prose and in no code.

## The two providers this product ships

<!-- generated: provider-ledger -->
<!-- /generated: provider-ledger -->

> Generated from `packages/domain/src/provider/`'s manifests by `renderProviderLedger()`. Do not edit
> the block above by hand: `packages/domain/test/provider/ledger.test.ts` compares it against what the
> manifests render, and a manifest edit that does not regenerate it is a red test.
```

Paste `"$SCRATCHPAD/m56a-ledger.md"`'s contents between the two markers, leaving both markers in place.

- [ ] **Step 5: README, one line**

`README.md`'s "Learn more" list gains one entry after the `docs/decisions/` line, in the same register:

```markdown
- `docs/providers/adding-a-provider.md` — what a third CLI runtime costs, and the ledger of what the two shipped ones actually do
```

Nothing else in the README moves in this task; the gate roster and the count are Task 6's.

- [ ] **Step 6: Run it, check the words, ladder and commit**

```bash
npx vitest run packages/domain/test/provider/
npm run gate:m26-vocabulary
npx tsc --build
npm run --silent typecheck
```
Expected: PASS on all four. **If the vocabulary gate fails, it will name a line in the new document**: `docs/providers/` is not on its exclude list, and only `cursor-agent`, `agentic` and `AGENTS.md` are protected spellings.

```bash
git add packages/domain docs/providers README.md
git commit -m "$(cat <<'EOF'
docs(providers): m56a t5 — the checklist as a count somebody can re-run, and a ledger that cannot drift

`docs/providers/adding-a-provider.md` is what this milestone's claim looks like written down: six
sites, each with what it costs and why it survived — the manifest, the registration, the adapter, the
fake, the word, and the Postgres enum, which is the one the repository forces and the loudest of the
six.

The differences ledger under it is RENDERED from the two manifests, and a test compares the checked-in
block against what `renderProviderLedger()` produces. Until this milestone the differences between
this product's two runtimes lived in five places no test could compare to each other; this is the last
of those five, and it is the one that is now derived from the other four's replacement.

`renderProviderLedger` is pure and imports no `node:` module: this package's index reaches a client
bundle, and a `node:` anywhere in that graph fails `web:build` outright.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RBVSwP5Paww1L1hqS7Dper
EOF
)"
```

---

### Task 6: `gate:m56a-provider-contract`, CI's 31st, the full ladder — and the two gates that spend real money (§3, R11, E5, E6, E13, E15, E17, D54–D62)

**Files:**
- Create: `scripts/gate-m56a-provider-contract.mjs`, `scripts/fixtures/m56a-goldens/provider-literal-allowlist.json`, `scripts/fixtures/m56a-goldens/run-files-allowlist.json`
- Modify: `packages/providers/test/cursor-stream.test.ts` (the derived allow-list, stage 11), `package.json`, `.github/workflows/ci.yml`, `README.md`, `docs/superpowers/specs/2026-09-13-m56a-provider-contract-design.md` (its §6), `docs/superpowers/plans/2026-09-13-m56a-provider-contract.md`
- Test: the gate itself, the whole ladder, and — **by hand, locally, on the user's word** — `gate:m12-providers` and `gate:m13-runtime` against the real binaries

**Interfaces:**
- Consumes: everything Tasks 1–5 produced, read from `dist` the way every gate reads a built package — `packages/domain/dist/index.js` (`PROVIDER_MANIFESTS`, `PROVIDER_KINDS`, `PROVIDER_LABEL`, `RUNTIME_EVENT_KINDS`, `PERMISSION_RUN_KINDS`, `PERMISSION_KINDS`, `SITUATION_KINDS`, `ACTION_KINDS`), `packages/providers/dist/index.js` (`capabilitiesOf`, `claudeFlags`, `cursorFlags`, `listProviderModels`, `parseCursorModels`, `parseStreamLine`, `parseCursorLine`, `buildRegistry`, `PROVIDER_ADAPTERS`, `admitAdapter`, `signalPause`, `checkpointRunFiles`), `packages/control/dist/index.js` (`writePermissionsFile`, `requestPause`, `refusalText`, `createSimulation`), `apps/orchestrator/dist/cli.js` (`buildAdapterRegistry`), `packages/db/dist/client.js` (`prisma`), `scripts/lib/child-env.mjs` (`loopbackChildEnv`, which also arms both fakes).
- Produces: `npm run gate:m56a-provider-contract`, CI's 31st step, the README's 31.

- [ ] **Step 1: The two allow-lists, checked in before the gate reads them**

A grep with an allow-list inside it is a grep somebody widens in the same breath as the thing it caught. Both lists are files the gate READS, so widening one is a diff a reviewer sees (§3 stage 8's own rule).

`scripts/fixtures/m56a-goldens/provider-literal-allowlist.json`:

```json
{
  "pattern": "case '(claude_code|cursor)'  |  [!=]== *'(claude_code|cursor)'",
  "scanned": ["packages", "apps", "scripts"],
  "excluded": ["dist/", "test/", "*.test.*"],
  "notMatched": "A `?? 'claude_code'` historical backfill is not a dispatch and is not matched by the pattern: `apps/orchestrator/src/sweep.ts`, `resume.ts`, `packages/control/src/pause.ts`, `resume.ts` and `packages/control/src/simulation/llm.ts` each carry one, every one of them a fact about rows written before M12 when there was no other adapter that could have produced them.",
  "files": [
    {
      "path": "packages/domain/src/provider/claude-code.ts",
      "why": "the manifest module: this row IS the literal, and every other table in the tree derives from it"
    },
    {
      "path": "packages/domain/src/provider/cursor.ts",
      "why": "the second manifest module, for the same reason"
    },
    {
      "path": "packages/db/prisma/schema.prisma",
      "why": "the Postgres enum -- the sixth site a third provider touches, and the one no TypeScript derivation can write"
    },
    {
      "path": "packages/db/src/seed.ts",
      "why": "seeds fixture rows with a provider VALUE; not a dispatch on a kind"
    },
    {
      "path": "packages/db/src/generated/enums.ts",
      "why": "generated from the schema by `prisma generate`; nobody edits it"
    },
    {
      "path": "scripts/gate-m12-providers.mjs",
      "why": "asserts a dispatched run RECORDED the provider it was dispatched with (:538, :541) -- an assertion about data, which is what a test does and must keep doing"
    },
    {
      "path": "scripts/gate-m13-runtime.mjs",
      "why": "the same assertion, four times (:838, :891, :991, :994), across both providers"
    },
    {
      "path": "scripts/gate-m31a-llm-decisions.mjs",
      "why": "asserts the simulation's stored `modelProvider` and its usage rows (:403, :450); the llm-decision path is claude_code-only by a BUDGET rule, and that gate is where that is proven"
    },
    {
      "path": "scripts/gate-m31b-software-sector.mjs",
      "why": "the same two assertions (:533, :577)"
    }
  ]
}
```

`scripts/fixtures/m56a-goldens/run-files-allowlist.json` (erratum E13 — the stage's claim, narrowed to what it can mean):

```json
{
  "claim": "`checkpointRunFiles` is the only place a RunHandle's run files are MAPPED ONTO Checkpoint.settingsPath/.hookPath. It is not the only place that PAIR of column names is written: the checkpoint's own row, and two rebuilds FROM a stored row, also spell them, and none of those reads a handle.",
  "runFilesMayAppearIn": [
    "packages/providers/src/contract/adapter.ts",
    "packages/providers/src/claude/adapter.ts",
    "packages/providers/src/cursor/adapter.ts",
    "apps/orchestrator/src/tick.ts",
    "apps/orchestrator/src/planning.ts",
    "apps/orchestrator/src/review.ts"
  ],
  "columnPairMayAppearIn": [
    { "path": "packages/providers/src/contract/adapter.ts", "why": "`checkpointRunFiles` itself -- the mapping" },
    { "path": "packages/providers/src/claude/checkpoint.ts", "why": "the `Checkpoint` interface's own two fields" },
    { "path": "packages/providers/src/claude/adapter.ts", "why": "`writeSettingsFile({ settingsPath, hookPath })` -- a settings file and a hook script, not a checkpoint -- and `resume()` reading the pair back off a stored row" },
    { "path": "packages/providers/src/cursor/adapter.ts", "why": "`resume()` reading the same pair back" },
    { "path": "apps/orchestrator/src/pump.ts", "why": "the `Checkpoint` row's own `create` -- the persistence side" },
    { "path": "apps/orchestrator/src/resume.ts", "why": "rebuilds the adapter's `Checkpoint` input and the pump's `spawn` FROM a stored row" },
    { "path": "packages/db", "why": "the schema and its generated client" }
  ]
}
```

- [ ] **Step 2: Write the gate**

`scripts/gate-m56a-provider-contract.mjs`. **The scaffolding is `scripts/gate-m37-run-context.mjs`'s, function for function** — it is the newest gate that drives a real daemon with no browser: `preflightCleanup()`, `dumpGateRows()`, `fail()`, `waitUntil(description, timeoutMs, probe)` whose probe reports what it last SAW, the daemon lifecycle with its `findRealDaemonPids()` refusal, "print every measured value before asserting it", FK-ordered cleanup in `finally`, `exitCode` starting at 1 and set to 0 only by falling off the end of the `try`, and `process.exit(exitCode)` as the last line. **The two-provider dispatch is `scripts/gate-m13-runtime.mjs`'s** (`:938-941` creates one worker per provider in one team; `:1122-1250` requests a pause and waits for the row, the announcement and the checkpoint) — with one difference stated in the header: this gate ALWAYS runs the fakes, because `loopbackChildEnv` arms them, and it has no real-binary mode at all.

The header says what the gate is and what it refuses to be:

```js
// M56a's own gate (spec section 3): "nothing a provider does changed, and here are the bytes".
//
//   SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
//   SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
//   npm run gate:m56a-provider-contract
//
// NEVER A MODEL CALL, AND ZERO SPEND. Every child is a fake: `scripts/gate-fakes/fake-claude.sh`
// and `scripts/gate-fakes/fake-cursor-agent.sh`, the second armed by `loopbackChildEnv` itself
// (M56a R10). The two gates that DO spend -- `gate:m12-providers` and `gate:m13-runtime` -- are not
// in CI, are not this gate's business, and are run by hand once before this milestone merges.
//
// NO BROWSER STAGE. Nothing rendered changed, and a Playwright stage asserting that is slower than
// the `web:build` the milestone's web task already gates on.
//
// THE GOLDENS ARE READ, NEVER WRITTEN. `scripts/fixtures/m56a-goldens/` was captured from the tree
// this milestone forked from, before its first edit. This gate compares against those bytes and has
// no mode that regenerates them: a golden a gate can rewrite is not a golden.
//
// THE GATE ASSERTS, IT NEVER FIXES, and every stage prints every measured value before asserting it.
//
// TWELVE STAGES, each measuring one thing the milestone claims:
//   1.  Two manifests, complete, and nobody holds a second copy of the union.
//   2.  The permission verdict is byte-identical -- twelve files, byte for byte.
//   3.  The argv is byte-identical, and the two silent failures are still refused.
//   4.  `capabilitiesOf` equals the golden AND equals the projection -- two paths, five answers.
//   5.  The registry is a table, and an unconfigured kind still refuses.
//   6.  `runFiles` is a record and the checkpoint columns did not move (real daemon, both providers).
//   7.  The spend net covers every registered binary (three unit cases and one live daemon).
//   8.  No `case 'claude_code'` outside a checked-in allow-list.
//   9.  The ladder is read, not written: two ADR anchors, one unchanged byte count, two rungs.
//   10. The model list, the settings cards and the simulation refusal all still say what they said.
//   11. Both providers' event sets are the manifest's.
//   12. Nothing else moved: two catalogues, one lane map, one enum, no migration, one clean tree.
```

Each stage, with the assertions it makes:

**Stage 1 — two manifests, and one union.**
```js
await assertEqual(Object.keys(PROVIDER_MANIFESTS).sort(), [...PROVIDER_KINDS].sort(), 'PROVIDER_MANIFESTS members')
for (const kind of PROVIDER_KINDS) {
  const parsed = providerManifestSchema.safeParse(PROVIDER_MANIFESTS[kind])
  if (!parsed.success) await fail(`stage 1: ${kind}'s manifest fails its own schema: ${JSON.stringify(parsed.error.issues)}`)
  if (PROVIDER_MANIFESTS[kind].differences.length === 0) await fail(`stage 1: ${kind} states no limitation -- a provider with none is one nobody measured`)
}
```
then the greps, over `packages`, `apps` and `scripts`, excluding `dist/` **and `test/` and `*.test.*`** (erratum E5 — ten test files spell the two members deliberately, one of them being the pin R2 itself rests on):
```js
const union = gitGrep("'claude_code' *| *'cursor'")
const array = gitGrep("\\['claude_code', *'cursor'\\]")
```
Both must be exactly one hit and both must be `packages/domain/src/provider/kind.ts`. The gate prints every hit before asserting, so a failure names the file that grew the copy.

**Stage 2 — the permission verdict, byte for byte.** For each of `PROVIDER_KINDS` × `PERMISSION_RUN_KINDS` × `{baseline: [], granted: every kind allowed}`, call `writePermissionsFile` into a `mkdtemp` directory with the golden's own fixed `runId` and `runToken`, read the bytes back and compare against `scripts/fixtures/m56a-goldens/permissions-<provider>-<runKind>-<set>.json` with `Buffer.compare`. Twelve files. On a mismatch, print BOTH parsed objects' differing keys before failing — `enforce`, `vocabulary`, `prefixes`, `grants` and `allow` are five different stories and a byte diff tells none of them.

**Stage 3 — the argv, byte for byte (erratum E12).**
```js
await assertEqual(claudeFlags({ settingsPath: golden.claudeSettingsPath }), golden.claude, 'claudeFlags')
await assertEqual(cursorFlags({}), golden.cursorPlain, 'cursorFlags({})')
// …the other three cursor shapes…
for (const kind of PROVIDER_KINDS) {
  const { headlessFlags, neverPass } = manifestFor(kind).invocation
  const real = kind === 'claude_code' ? golden.claude : golden.cursorPlain
  // An in-order SUBSEQUENCE, not a prefix: `--settings <path>` sits INSIDE Claude's constant half.
  if (!isSubsequence(headlessFlags, real)) await fail(`stage 3: ${kind}'s headlessFlags are not an in-order subsequence of its argv`)
  for (const flag of neverPass) {
    for (const argv of [golden.claude, golden.cursorPlain, golden.cursorModel, golden.cursorResume, golden.cursorModelAndResume]) {
      if (argv.includes(flag)) await fail(`stage 3: ${kind} declares ${flag} never-pass and an argv carries it`)
    }
  }
}
// The two silent failures the flag builders exist to prevent, each re-asserted:
assertThrows(() => claudeFlags({ settingsPath: 'settings.json' }), /absolute/)
assertThrows(() => cursorFlags({ resume: { sessionId: '  ' } }), /non-empty/)
```

**Stage 4 — `capabilitiesOf`, from two directions.** `capabilitiesOf(kind)` deep-equals `capabilities.json`'s row, AND each of its five members equals R4's projection over that kind's manifest, AND `capabilitiesOf(kind) === capabilitiesOf(kind)` (the identity the adapter's delegation rests on).

**Stage 5 — the registry.** `Object.keys(PROVIDER_ADAPTERS)` is `PROVIDER_KINDS`; `buildRegistry({})` refuses BOTH kinds with `UnknownProviderError`; a registry given only one kind's wiring resolves that one and refuses the other; `admitAdapter('cursor', stub)` with a stub declaring neither capability throws `UnregistrableProviderError`; and `buildAdapterRegistry()` — imported from `apps/orchestrator/dist/cli.js`, in a process with both bin variables set to the fakes — resolves both kinds to adapters whose `kind` fields are the two `ProviderKind` members. Then the spelling wrinkle, closed:
```js
const hyphenated = gitGrep("'claude-code'")  // excluding dist/
// Only the two comments that warn about the spelling may mention it.
```

**Stage 6 — `runFiles`, and the two columns (erratum E13).** A real daemon, one workspace, one team, two workers — one `provider: 'claude_code'`, one `provider: 'cursor'`, each with its own task — both dispatched, both paused through `requestPause`, and for each: the `Checkpoint` row read back with `prisma` carries a `settingsPath` and a `hookPath`, both absolute, both existing on disk, and `settingsPath` is the file that provider actually wrote (`<runDir>/settings.json` for Claude, `<worktree>/.cursor/hooks.json` for Cursor). Then the two structural assertions:
```js
for (const kind of PROVIDER_KINDS) {
  const { channels, persisted } = manifestFor(kind).runFiles
  if (channels.length !== 2) await fail(`stage 6: ${kind} declares ${channels.length} run-file channels; only two survive a pause until Checkpoint gains a Json column`)
  for (const name of persisted) if (!channels.includes(name)) await fail(`stage 6: ${kind} persists a channel it does not declare: ${name}`)
}
```
and the grep that keeps the mapping in one place, against `run-files-allowlist.json`: every file in `apps/*/src` and `packages/*/src` containing the word `runFiles` is on the list, and `settingsPath` appears in `tick.ts`, `planning.ts` and `review.ts` only inside comment lines.

**Stage 7 — the spend net.** `fakeCliRefusal` (imported from `apps/orchestrator/dist/require-fake-cli.js`) returns the refusal naming `SLAVEOFAI_CURSOR_BIN` when that variable is unset, when it is empty, and when its basename is `cursor-agent` — three cases that all returned `null` before this milestone — and the Claude cases keep their exact historical sentence. Then the live proof: a daemon spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and `SLAVEOFAI_CURSOR_BIN=/usr/local/bin/cursor-agent` exits non-zero with that sentence on stderr, and the same daemon with both fakes starts and announces itself. **Spawn the refusing daemon with `{ ...loopbackChildEnv(), SLAVEOFAI_CURSOR_BIN: '/usr/local/bin/cursor-agent' }`** — the helper arms the fake, so the override has to come after it, and that ordering is the stage's own point: the net catches a real binary name however it got there.

**Stage 8 — no vendor literal outside the allow-list (erratum E6).**
```js
const pattern = "case '(claude_code|cursor)'|[!=]== *'(claude_code|cursor)'"
const hits = gitGrepE(pattern, ['packages', 'apps', 'scripts'], { excludeDist: true, excludeTests: true })
const allowed = new Set(readJson('scripts/fixtures/m56a-goldens/provider-literal-allowlist.json').files.map((f) => f.path))
for (const hit of hits) if (!allowed.has(hit.path)) await fail(`stage 8: ${hit.path}:${hit.line} dispatches on a provider NAME: ${hit.text}`)
```
and the other direction, so the list cannot rot: every allow-listed path must still exist on disk, and the four gate-script entries must still match (a gate that stopped asserting its provider is a gate that stopped proving something).

**Stage 9 — the ladder is read, not written.** Both manifests' `pause.adr` anchors resolve to a heading that exists in `docs/decisions/0001-pause-semantics.md` — slugified the GitHub way (lower-case, spaces to hyphens, drop anything but `[a-z0-9-]`), with the gate printing both the anchor and the slugs it found; the ADR's byte count equals the constant this gate carries (**read it at execution time and write it in** — on the tree this plan was written against it is 38,862, and a deliberate ADR edit moves this number in the same commit, which is exactly the review a "the ADR gains no new text" ruling wants); Claude's rung is `hook` and Cursor's is `signal`; `signalPause('claude_code', …)` writes the flag file and `signalPause('cursor', { pid: null, … })` throws its existing sentence. The pump's two paths are asserted by stage 8's grep covering `pump.ts` and by stage 6's paused Cursor run having died by pid.

**Stage 10 — the model list, the cards and the refusal (erratum E17).** `listProviderModels('claude_code')` deep-equals `models.json`'s `claude_code`; `listProviderModels('cursor', { cursorCommand })` against a stub script that prints the recorded `packages/providers/test/fixtures/cursor/models.txt` parses to `models.json`'s `cursorParsed` with `source: 'account'`; the card array the manifests, `PROVIDER_LABEL` and `PROVIDER_ADAPTERS` would produce equals `settings-cards.json` (the `buildProviderAdapters` half of this stage runs in `apps/web/test/integration/settings-snapshot.test.ts`, because `apps/web` has no `dist` a gate can import); and `createSimulation`'s guard answers both sentences byte for byte:
```js
const cursorRefusal = await createSimulation({ …, decisionProvider: 'llm', modelProvider: 'cursor', model: 'auto', maxModelCostUsd: 1 })
await assertEqual(refusalText(cursorRefusal.error), 'model provider cursor is not supported for simulations: it reports no cost, so a cap cannot be enforced', 'the cost-blind refusal')
const unknownRefusal = await createSimulation({ …, modelProvider: 'codex', … })
await assertEqual(refusalText(unknownRefusal.error), 'model provider codex is not supported for simulations: it is not a configured provider', 'the unknown-provider refusal')
```

**Stage 11 — the event sets (erratum E15).** Replay every checked-in fixture — `packages/providers/test/fixtures/*.ndjson` through `parseStreamLine`, `packages/providers/test/fixtures/cursor/**/*.ndjson` through `parseCursorLine` — and assert every produced kind is in `[...manifest.events.produces, 'ignored', 'unparsable']`. Then the complement, which is what actually pins the two rows:
```js
const claudeMissing = RUNTIME_EVENT_KINDS.filter((kind) => !manifestFor('claude_code').events.produces.includes(kind))
await assertEqual(claudeMissing, ['ignored', 'unparsable'], "Claude's row is every semantic kind there is")
await assertEqual([...manifestFor('cursor').events.produces].sort(), ['permission_denied','session_started','terminated','text','tool_call','tool_result'], "Cursor's six")
for (const forbidden of ['usage', 'hook_started', 'hook_denied', 'hook_crashed', 'hook_failed_open']) {
  if (manifestFor('cursor').events.produces.includes(forbidden)) await fail(`stage 11: Cursor's row claims ${forbidden}`)
}
if (!manifestFor('claude_code').events.produces.includes('tool_result') || !manifestFor('cursor').events.produces.includes('tool_result')) {
  await fail('stage 11: both rows must carry tool_result -- it is what makes reportsToolResults true by projection rather than by assertion')
}
```
`packages/providers/test/cursor-stream.test.ts:652-665`'s hand-written seven-name array becomes the derived allow-list **in this task, in this step**: `[...manifestFor('cursor').events.produces, 'ignored', 'unparsable']`, which widens it to eight. It is a `toContain` allow-list, so every assertion it makes today still passes; the added member is `permission_denied`, a branch the parser genuinely has at `cursor/stream.ts:342` that no fixture line reaches, and under-claiming it would let a consumer suppress an arm that really fires.

**Stage 12 — nothing else moved.** `SITUATION_KINDS` is seventeen and `ACTION_KINDS` is seventeen, asserted from the modules; `LANE_BY_TYPE` is 61; the Postgres `ProviderKind` enum read with `prisma.$queryRaw` is exactly `['claude_code','cursor']`; `npx prisma migrate diff --from-config-datasource --to-schema packages/db/prisma/schema.prisma --config packages/db/prisma.config.ts` reports "No difference detected"; `CHILD_ENV_ALLOW` is the same twelve names in the same order; the five hook-plane scripts are byte-identical to `git show HEAD:<path>`; and `git status --porcelain` after a green run is what it was before.

- [ ] **Step 3: Run the gate until it is green, and read its log**

```bash
pgrep -af "next dev"        # this gate needs no dev server; a running one is somebody else's
npx tsc --build
SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" \
SLAVEOFAI_REQUIRE_FAKE_CLI=1 \
npm run gate:m56a-provider-contract 2>&1 | tee "$SCRATCHPAD/gate-m56a.log"
```
Expected: `PASS: nothing a provider does changed, and here are the bytes`, and `${PIPESTATUS[0]}` is 0. **Read the log rather than the exit code**: every stage prints what it measured, and stage 2's twelve byte-comparisons and stage 6's two checkpoint rows are the ones worth reading with your own eyes the first time.

- [ ] **Step 4: The roster, CI and the README**

`package.json` gains `"gate:m56a-provider-contract": "tsc --build && node --env-file=.env scripts/gate-m56a-provider-contract.mjs"` immediately after `gate:m55-catalog`.

`.github/workflows/ci.yml` gains `- run: npm run gate:m56a-provider-contract` immediately after `gate:m55-catalog`. (The job's `SLAVEOFAI_CURSOR_BIN` line landed in Task 3.)

`README.md`: the roster paragraph names `gate:m56a-provider-contract` after `gate:m55-catalog`, and the sentence list gains one clause in the same register —

> and `m56a` proves a refactor changed nothing: twelve permission verdicts byte for byte, both flag
> builders' argv element for element, both capability rows two different ways, one paused run per
> provider whose two checkpoint columns hold the two files its adapter actually wrote, and a grep
> that fails the build the moment a second copy of the provider list appears anywhere in the tree

— and the count line, found with `grep -n '^[0-9]\+ gates\.' README.md` (it was `:1037` after M54 and M55 moved it again, so never address it by number), reads **31 gates**.

- [ ] **Step 5: The full verification ladder**

One vitest at a time, no gate beside vitest, nothing beside a `web:build`. Background the long ones with a 600 s budget and wait on a log line rather than on `pgrep`.

```bash
npx tsc --build
npm run --silent typecheck
npx vitest run 2>&1 | tail -20
```
Expected: at or above Task 1's recorded numbers plus four files, zero failures.

```bash
pgrep -af "next dev"   # empty
npm run web:build && rm -rf apps/web/.next
```

Then every fake-CLI gate, one at a time, each with `SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" SLAVEOFAI_REQUIRE_FAKE_CLI=1` and `CHROMIUM_PATH` for the browser ones. **All 31**, because this milestone touched the registry every one of them builds, the environment every one of them spawns and the permission file every one of them writes:

```
m15-boundary m20-auth m21-loose-ends m23-onboarding m29-simulation m30-simulation-compare
m31a-llm-decisions m31b-software-sector m33-adopt m35-pipeline-honesty m36-messaging m37-run-context
m38-supervisor m39-supervisor-mailbox m40-requirement-versioning m41-scenario m42-catalog-import
m44-ux-foundation m45-project-experience m46-workforce-catalog m47-team-formation m48-runbooks
m49-memory m50-ephemeral m51-breaker m52-broker m53-evidence m54-triggers m55-catalog
m56a-provider-contract m26-vocabulary
```

plus the ones that are not in CI and are still ours to keep green: `gate:m8-plan`, `gate:m8a-merge`, `gate:m8a-estop`, `gate:m10-org`, `gate:m11-shell`, `gate:m14-fidelity`, `gate:m16-chrome`, `gate:m17-stability`, `gate:m18-skill-and-teeth`, `gate:m19-measure-and-harden`. **`gate:m14-fidelity` regenerates no screenshot in this milestone**: no rendered surface changed, so run it and check every PNG back out (`git status --porcelain docs/superpowers/fidelity/m14/` then `git checkout --`), reading the status line first — the known m14 PNG nondeterminism can rewrite a file with no visual change, and a listed file is not by itself a failure.

Record, in the task report: every gate's name and its result, and the four counts (test files, tests, CI gates, README count line).

- [ ] **Step 6: The measurement half — the two gates that spend real money (R11b)**

**Not a stage, never in CI, and never run without the user's word.** `gate:m12-providers` and `gate:m13-runtime` spawn the real, paid `claude` and `cursor-agent` against a real daemon. Both are UNCHANGED by this milestone; that is the claim they prove.

**Ask first, and say what it costs**: one execution of `gate:m13-runtime` spawns four vendor children (its own header itemises them) and `gate:m12-providers` five stages' worth. Neither sets `SLAVEOFAI_REQUIRE_FAKE_CLI`, which is what keeps the widened spend net from arming against them — that is R11's own reasoning and stage 7 does not contradict it.

Record the binaries FIRST, because the versions are the measurement:

```bash
which claude cursor-agent
claude --version
cursor-agent --version
```
Expected on the machine this plan was written for: `claude 2.1.270` or later, `cursor-agent 2026.08.25-3e8eec8` or later. **`cursor-agent` self-updates between runs**: whatever the two commands print is what goes in the report, beside the result, and a drift from the versions the manifests record is a LINE IN THE REPORT and never an assertion in a test.

```bash
pgrep -af "next dev"   # empty
npm run gate:m12-providers  2>&1 | tee "$SCRATCHPAD/gate-m12-real.log"; echo "exit ${PIPESTATUS[0]}"
npm run gate:m13-runtime    2>&1 | tee "$SCRATCHPAD/gate-m13-real.log"; echo "exit ${PIPESTATUS[0]}"
```
(`gate:m13-runtime` also needs `CHROMIUM_PATH`; its header names every variable it refuses to start without, and it fails fast and never skips.)

**THE RULE WHEN A BINARY IS MISSING.** If `which claude` or `which cursor-agent` answers `not found`, or the user declines the spend: the measurement is DEFERRED, not faked and not rehearsed-instead-of-run. Write in the task report, verbatim, which binary was missing or which gate was not run and why, note that the fake-CLI half (all 31 CI gates) is green, and carry the deferred run into the spec's §7 as a named item. **A rehearsal against the fakes proves the script, not the provider**, and this milestone does not get to claim otherwise — R11 says the two halves of "green" are different things, and saying so out loud is the whole of what that ruling asks for.

- [ ] **Step 7: The errata, the spec and the plan**

Append E1–E17 to the spec's §6 in the one-line form (`**En (amends Rx)** — <claim>.`), in order, each with the citation that earned it. §6 currently reads "None yet"; replace that sentence with the list.

- [ ] **Step 8: Commit — two of them, in this order**

The code, then the documents, so a spec diff never hides a code change. **There is no screenshot commit.**

```bash
git add scripts package.json .github/workflows/ci.yml README.md
git commit -m "$(cat <<'EOF'
feat(gate): m56a t6 — nothing a provider does changed, and here are the bytes

`gate:m56a-provider-contract` is mostly golden files, which is what a refactor's gate should be. The
goldens were captured from the tree this milestone forked from, before its first edit, and this gate
has no mode that rewrites them.

Twelve `permissions.json` v2 files compared byte for byte -- two providers, three run kinds, two
grant sets -- with `runId` and `tokenHash` held fixed so the comparison is total rather than
field-wise. Both flag builders' argv element for element, with every never-pass flag asserted absent
from every one of them and both silent failures (a relative `--settings`, a bare `--resume`) still
refused. Both capability rows twice: against the bytes they had, and against the projection that
replaced them.

A real daemon dispatches one fake-CLI run per provider and pauses it, and each checkpoint's two
columns hold the two files that adapter actually wrote -- `<runDir>/settings.json` and the gate script
for one, `<worktree>/.cursor/hooks.json` and the shell gate for the other. Every registered provider
declares exactly two run-file channels, because two is what survives a pause until `Checkpoint` gains
a Json column.

Two greps keep the collapse collapsed: exactly one union literal in the tree, and no `case` or `if`
keyed on a provider's name outside a checked-in allow-list -- a file, so widening it is a diff a
reviewer sees. The four gates on that list assert that a dispatched run RECORDED the provider it was
dispatched with, which is an assertion about data and must keep being made.

CI's 31st gate. No screenshot moved, no migration ran, and `prisma migrate diff` reports no
difference.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RBVSwP5Paww1L1hqS7Dper
EOF
)"

git add docs/superpowers/specs/2026-09-13-m56a-provider-contract-design.md docs/superpowers/plans/2026-09-13-m56a-provider-contract.md
git commit -m "$(cat <<'EOF'
docs(spec): m56a — the design, the plan, and the errata execution wrote back into section 6

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01RBVSwP5Paww1L1hqS7Dper
EOF
)"
```

(`docs/providers/adding-a-provider.md` and the README's "Learn more" line are committed in Task 5 and should already be in.)

---

## Self-review

**1. Spec coverage.**

| Spec | Where it lands |
|---|---|
| R1 the contract moves, is re-exported, the two blocks merge, `id` → `kind` | Task 2 Steps 1–5 and 7 (`contract/adapter.ts` as the declaring file, `claude/adapter.ts`'s re-export header, the one import that moves, `readonly kind: ProviderKind` on both classes) and Step 9 (erratum E3's six readers and one constructor, line by line); Task 6 stage 5 (both kinds resolve to adapters whose `kind` is the enum spelling, and `'claude-code'` is absent outside the two comments that warn about it). **No method added, none removed, no signature changed but `runFiles`'s**, and the `requestPause`/`awaitPause` paragraph is carried verbatim into the merged docstring |
| R2 `ProviderKind` has exactly one definition and it is the domain's | Task 1 Steps 4 and 14 (`provider/kind.ts`, `types.ts`'s re-export, the two `permission/kinds.ts` aliases); Task 3 Step 10 (`simulation/adopt.ts`, `shared.ts`, `write.ts`) and Step 9 (`sweep.ts`); Task 4 Steps 1, 4 and 5 (`providerLabel.ts`, `api/sim/route.ts`, `AdoptDrawer.tsx`, `cli.ts`); Task 6 stage 1's two greps. **TEN copies, not five** (erratum E8), each named in the task that owns its file. **The Postgres enum stays exactly as it is** and `enum-parity.test.ts` is in no task's edit list |
| R3 one typed manifest per provider, fourteen axes, as data | Task 1 Steps 6–8 (the type, the schema, both rows, every value carrying the file it was read out of); Task 6 stages 1, 3, 9, 11. **`RuntimeEventKind` and `ModelOption` had to move with it** (errata E1, E2), because the domain cannot import the package those two live in. **No axis nothing reads**: `invocation` → R6/R10, `modelDiscovery` → R6, `resume`/`pause`/`events`/`usageCost`/`toolRestrictions` → R4, `toolVocabulary` → R5, `hooks`/`structuredOutput`/`measured`/`differences` → R9/R8/R11/§4 |
| R4 `capabilitiesOf` becomes a derivation and the ladder is data | Task 2 Step 6 (the projection, computed once and frozen — erratum E4, because a per-call projection breaks the identity assertion that proves there is one table); Task 6 stages 4 and 9. **No rung moves, the ADR gains no text** (stage 9 asserts its byte count), `'shell-only'` stays typed and unreachable and `ShellOnlyMark.tsx` is in no task's file list, and `capabilitiesOf` stays a pure synchronous lookup with no registry in sight |
| R5 `toolVocabulary` is the manifest's, `TOOLS_BY_KIND`/`ENFORCE_BY_PROVIDER` derive, `permissions.json` is byte-identical | Task 1 Steps 10–13 (the derivation, the identity assertions, `TOOL_VOCABULARY` untouched because it already derives); Task 6 stage 2's twelve byte comparisons. **`writePermissionsFile` is edited by nobody** — it appears in no task's Files list — and `kinds.test.ts` is unchanged and re-run, which is R5's own stated proof. No manifest names a tool for `read_secret` or `deploy_release`, asserted in Task 1 Step 6 |
| R6 the registry is a table, `buildRegistry` a loop, `buildAdapterRegistry` reads the manifest | Task 3 Steps 1–4 (`ProviderWiring`, `ProviderRegistration`, `PROVIDER_ADAPTERS`, the widened `buildRegistry`, `listProviderModels` without its switch) and Step 8 (the wiring loop, exported, and its own test) and Step 10 (`validateLlmInput`'s `reportsCost`, `llm.ts`'s `row.modelProvider` — erratum E10's `??` and why it is not a dispatch); Task 6 stages 5 and 10. **All four `buildRegistry` call sites move** (`cli.ts:893`, `tick.test.ts:1043`, `cursor-adapter.test.ts:190`, `registry.test.ts:7,12,17`), the registry is not lazy, nothing is deferred, and `UnknownProviderError`/`admitAdapter` keep their bodies |
| R7 `runFiles` becomes a record, and here is every reader | Task 2 Steps 3–5, 8 and 9 name all fifteen: `tick.ts:776`, `planning.ts:630`, `review.ts:579`; `claude/adapter.ts:450,469,612,808`; `cursor/adapter.ts:196,285,324,456`; `adapter-resume.test.ts` (seven lines) and `cursor-adapter.test.ts:200`. `checkpointRunFiles` is the one mapping, it throws rather than writing an empty NOT NULL column, and Task 6 stage 6 proves the columns with a real daemon. **No migration, no renamed column, no optional `runFiles`, and `channels.length === 2` asserted for every registered provider** |
| R8 structured output gains an axis and no behaviour | Task 1 Steps 6 and 8 (`'prompted'` on both rows, and Cursor's `differences` carrying the sentence that says its refusal is a BUDGET refusal). **Nothing is implemented**: `packages/domain/src/supervisor/prompt.ts` is in no task's file list, no second parser exists, and no `ProviderCapabilities` member was added — Task 2's interface still has exactly five, asserted by `capabilities.test.ts:5-14` unedited |
| R9 the pause mechanisms stop reading a name; the broker channel is untouched | Task 3 Step 9 (`pump.ts:467` → `canPauseMidRun`; and erratum E7's correction — `pump.ts:153` and `runContext.ts:221` are the SKILLS fact and become `providerRunsSkills`); Task 6 stages 6, 8 and 9. **`signalPause` is not edited** (it was already the precedent), `preflightGate`'s `AllowContract` gains no third shape, `CHILD_ENV_ALLOW` does not move into the manifest and is asserted unchanged by stage 12, and the five hook-plane scripts are in no task's file list and are byte-compared by stage 12 |
| R10 a fake per provider, the registry declares it, CI checks every binary | Task 3 Steps 5–7 (the loop, `requireFakeCliRefusal(envVar)`, and erratum E11's real scope: one helper in `child-env.mjs`, four hand-built gates, five test environments and the one CI line); Task 4 Step 2 (`REAL` derived, `versionOf`'s map — erratum E16 keeps its signature, so `settings-snapshot.test.ts`'s three existing cases do not move); Task 6 stage 7. **`LATER` is untouched** and both placeholder cards keep their caption, **neither existing fake is edited**, no fake is added, and `SLAVEOFAI_REQUIRE_FAKE_CLI` still defaults to off |
| R11 "green" is two different things, and both are said out loud | Task 6 Step 5 (the 31 CI gates, all of them, one at a time) and Step 6 (the two measurement gates, by hand, locally, with both `--version` strings recorded — and the deferral rule written out for a missing binary or a declined spend). **No measurement gate is added and neither is made cheaper**: `gate-m12-providers.mjs` and `gate-m13-runtime.mjs` are in no task's Files list, and stage 7 does not arm the net against them because neither sets the flag |
| R12 no new provider, and each of the next two is blocked on a binary | Nothing in any task adds a `ProviderKind` member, an enum value, an adapter directory, a manifest or a migration. `LATER`'s two cards are asserted unchanged by Task 4's golden and Task 6 stage 10. Task 5's document states the rule the next two milestones are held to and the methodology they follow |
| §3 the gate, twelve stages, README 30 → 31, CI after m55 | Task 6 Steps 1–5, every stage enumerated with its assertions and its errata (E5's test exclusion, E6's four gate scripts, E13's narrowed claim, E15's complement assertion, E17's split between the gate and the web test) |
| §3's measurement half | Task 6 Step 6, including what it costs, what is recorded, and what happens when a binary is missing |
| §4 the twenty-six sites | Rows 1, 16, 20, 25 and the enum are the KEPT six and are written into Task 5's document; rows 2–15, 17–19, 22–24 each land in a named step (2 is unchanged and re-run; 3–4 Task 1 Step 14; 5 Task 1 Step 12; 6–7 Task 4 Step 1; 8 Task 3 Step 10; 9 Task 4 Step 4; 10 Task 2 Step 6; 11 Task 3 Step 4; 12–13 Task 1 Step 12; 14 Task 3 Step 3; 15 Task 3 Step 8; 17–18 Task 4 Step 2; 19 Task 3 Step 6; 22 Task 3 Step 10; 23 Task 3 Step 9; 24 Task 2 Steps 4–5; 26 Task 2 Step 3). **Row 21 (a price table entry) is OPTIONAL and not taken**: `packages/domain/src/guardrails/pricing.ts` is in no task's file list |
| §2 surfaces after M56a | Every module, function and constant listed there appears in a task's **Interfaces → Produces**. **DB: NOTHING** — `packages/db` appears in no task's Files list at all. **Supervisor: NOTHING** — `packages/domain/src/supervisor/*` and `packages/control/src/supervisor.ts` likewise. Two additions §2 does not carry, each with its erratum: `runContext.ts` (E7) and `packages/control/src/index.ts`'s one re-export line (R10's card derivation) |
| §5 out of scope | No `tools.json` on disk (no task writes a runtime-loaded file); no third provider; no native structured output; no `Checkpoint.runFiles` column and no migration (stage 12's diff proof); no widened `AllowContract`; `CHILD_ENV_ALLOW` neither moved nor re-measured; no Cursor price entry and no `estimateCostUsd` change; no change to `decide()`, `evaluateGuardrails`, `workspaceSpend`, `stats.spentUsd`, `SITUATION_KINDS`, `ACTION_KINDS`, `formTeam`, `rankCandidates`, `profileKeyOf` or `writePermissionsFile`; no new event, refusal, column, index or migration; no hook-plane script touched; no browser stage |

**2. Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N", no "write tests for the above". Two places name the exact file to copy a shape from instead of reprinting it, and each states what it must produce: Task 6 Step 2's gate (twelve stages with their assertions, the scaffolding named function by function from `gate-m37-run-context.mjs`, the two-provider dispatch named line by line from `gate-m13-runtime.mjs`, and the two things the implementer may not improvise past — the goldens, which are read and never written, and the allow-lists, which are files) and Task 2 Step 9's three test files, which are enumerated line by line rather than described. Five steps deliberately end in a CHECK rather than an edit — Task 1 Step 1's clean-tree check before the goldens are captured, Task 1 Step 15's baseline recording, Task 2 Step 4(d)'s "verify by reading, do not edit", Task 6 Step 3's log read and Task 6 Step 6's `--version` capture — because each is a fact about the tree a plan should verify rather than assert. Every type and function named in a step is either defined in a step (`ProviderCapabilityManifest`, `providerManifestSchema`, `PROVIDER_MANIFESTS`, `manifestFor`, `SKILL_TOOL`, `providerRunsSkills`, `RUNTIME_EVENT_KINDS`, `PARSER_EVENT_KINDS`, `ModelOption`, `PROVIDER_LABEL`, `RunFiles`, `checkpointRunFiles`, `ProviderWiring`, `ProviderRegistration`, `PROVIDER_ADAPTERS`, `requireFakeCliRefusal`, `fakeProviderBins`, `LEDGER_AXES`, `renderProviderLedger`, `LEDGER_START`/`LEDGER_END`, `BIN_ENV_VAR`) or verified present in the repository with a file:line citation (`writePermissionsFile` `packages/control/src/permission.ts:56`, `isProviderKind` `packages/control/src/org.ts:21`, `capabilitiesOf` `packages/providers/src/capabilities.ts:23`, `admitAdapter` `registry.ts:57`, `signalPause` `pause-signal.ts:44`, `parseCursorModels` `models.ts:37`, `loopbackChildEnv` `scripts/lib/child-env.mjs:26`, `gateStateDir` `scripts/lib/state-dir.mjs:42`, `oneOfFlag` `cli.ts:1024`, `toolKindFor` `kinds.ts:207`, `TOOL_VOCABULARY` `kinds.ts:177`, `ENFORCE_BY_PROVIDER` `kinds.ts:248`).

**3. Type consistency.** `ProviderKind` is declared once (Task 1 Step 4) and is the parameter type of `manifestFor`, `capabilitiesOf`, `providerRunsSkills`, `checkpointRunFiles`, `admitAdapter`, `AdapterRegistry.resolve`, `SlaveRuntimeAdapter.kind`, the keys of `PROVIDER_MANIFESTS`, `PROVIDER_ADAPTERS`, `PROVIDER_LABEL`, `TOOLS_BY_KIND`'s inner record and `ENFORCE_BY_PROVIDER`, and the element type of `PROVIDER_KINDS`/`PERMISSION_PROVIDERS` — one union, six total records, and a third member is a build error in every one of them at the same moment. `ProviderCapabilityManifest` has one definition (Task 1 Step 8) and five consumers that read different axes of it: `capabilities.ts`'s `project` (five), `models.ts` (`modelDiscovery`, `invocation.binary`), `cli.ts` (`invocation.binEnvVar`/`argsEnvVar`/`binary`), `require-fake-cli.ts` (`invocation.binEnvVar`/`binary`), `settings.ts` (`invocation.binary`/`binEnvVar`), `ledger.ts` (twelve) — so an axis that changed shape is a build error in every reader rather than a silent `undefined` in one. `RunFiles` is `Readonly<Record<string,string>>` in one place and is produced by two adapters and consumed by one function. `ModelOption` is declared in the domain and re-exported from `packages/providers/src/models.ts`, so `ModelListing.models`, `CLAUDE_CODE_MODELS` and `parseCursorModels`'s return are one type. `ProviderWiring` has one definition and three producers (`buildAdapterRegistry`, and the two test helpers in `registry.test.ts` and `tick.test.ts`). `RuntimeEventKind` is declared in the domain and pinned to `RuntimeEvent['kind']` in both directions, which is the one place two packages' vocabularies meet. The one asymmetry, named: `PumpRunInput.spawn.provider` is `ProviderKind | undefined` while `capabilitiesOf` and `providerRunsSkills` take a `ProviderKind`, so both call sites in `pump.ts` spell `?? 'claude_code'` — the same historical-fact backfill four other files already use, and the only reason the literal survives anywhere outside a manifest.

**What the self-review pass FIXED, inline.** Five gaps, all now closed. **(a)** The manifest first held `toolVocabulary` typed through a zod `z.enum(PERMISSION_KINDS)`, which needs `PERMISSION_KINDS` as a VALUE — and `permission/kinds.ts` imports `manifestFor` back, so that would have been a runtime import cycle between two modules that both initialise constants at load. The schema uses `z.record(z.string(), …)` and the import is `import type`, which is erased; the totality is carried by the TypeScript type and asserted in `manifest.test.ts`. **(b)** `capabilitiesOf` was first written as a per-call projection, which returns a fresh object and breaks `capabilities.test.ts:41`'s `toBe` — the one assertion that proves the adapter and the budget check read the SAME table. It is computed once at module load and frozen (erratum E4). **(c)** `registry.ts`'s `parseModels` was first the function reference `parseCursorModels`, read at module-load time out of `models.ts`, which imports `registry.ts` back for `PROVIDER_ADAPTERS`; a later refactor of that function into a `const` arrow would have put it in its own TDZ at that moment. It is a forwarding arrow, read at call time. **(d)** `buildAdapterRegistry`'s loop first read `process.env[binEnvVar] ?? binary` directly, which would have DROPPED the fake-CLI refusal that `claudeCommand()` raised on the way past — the one thing standing between a CI job and a real vendor bill. `fakeCliRefusal(process.env)` is asked once at the top of the function, before anything is constructed. **(e)** `validateLlmInput`'s two tests were first written in their original order, which would have asked `capabilitiesOf` about a string that is not a `ProviderKind`; they are reversed, and both refusal sentences still come out byte for byte for both inputs. Nothing else moved: the spec-coverage walk found a task for every ruling, every gate stage, every checklist row and every §2 surface, and the placeholder scan found nothing to remove.
