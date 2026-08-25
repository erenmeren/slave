# M12: Provider Adapters — An Honest Seam and a Second Runtime — Design

**Date:** 2026-08-25
**Status:** Approved
**Predecessor:** M11 (the web shell). M11 gave every worker an editable model; this milestone
gives that model a provider to mean something within.
**Structural reference:** the existing `AgentRuntimeAdapter` contract in
`packages/providers/src/claude/adapter.ts` and the `ProviderKind` / `ProviderConfiguration`
models that have sat unread in `packages/db/prisma/schema.prisma` since M3.

M12 makes the provider seam real and proves it with a second runtime. Today the seam is
partly fiction: the adapter interface declares pause methods nothing calls, the orchestrator
writes Claude's settings file itself, the pause protocol writes a Claude-hook-readable flag
from `packages/control`, and `buildAdapter()` hardcodes the one implementation. This
milestone moves every provider-specific decision behind the contract, makes
`ProviderCapabilities` load-bearing rather than decorative, and lands the Cursor CLI as the
second adapter — because a contract with one implementation is an assertion, not a seam.

## 1. Scope

In scope:

- The adapter contract becomes the only thing that knows a provider: settings/hook file
  authorship, the pause mechanism, and adapter selection all move behind it.
- `ProviderCapabilities` is consumed for real, in three places: pause strategy, budget
  admission, and assignment-time refusals.
- Runtime resolution yields a `(provider, model)` pair through M11's existing chain.
- Cost becomes honest: unknown is `null`, never `0`, and a budget that cannot be measured
  is refused rather than silently unenforced.
- A Cursor CLI adapter: stream parser, flags, shell gate, session resume, cancel-based pause.
- Provider surfaces in Settings and the Roster, beside the model fields M11 built.
- A measured gate, `gate-m12-providers.mjs`, running both runtimes live.

Out of scope (deliberate): API-based adapters (an agent loop we write ourselves), provider
failover or fallback chains, pricing tables and token-to-USD arithmetic, the permission
matrix, providers whose runs are not local child processes, and Skills/Analytics. A third
provider is not built; the second one is what proves the seam.

## 2. Decisions of Record

1. **The adapter owns everything provider-shaped.** No caller outside `packages/providers`
   may know that a provider has a settings file, a hook script, or a flag file. The
   orchestrator supplies a per-run scratch directory; the contents are the adapter's.
2. **Capabilities are load-bearing.** `ProviderCapabilities` stops being decorative. A
   capability that no code reads is deleted; every capability that survives has a consumer.
3. **One promise, two mechanisms.** Both providers guarantee: when the operator pauses, the
   run stops and can later continue from where it stopped. How they keep it differs by
   capability. The guarantee never degrades silently.
4. **The gate-failure circuit breaker survives.** A provider whose gate crashes still halts
   its workspace. A provider with no gate never produces that event — and its inability is
   recorded as a capability, not discovered at runtime.
5. **Whoever supplies the model supplies the provider.** Resolution yields a pair from one
   level of the chain. Mixing levels is structurally impossible, so an incompatible
   `(provider, model)` combination cannot be expressed.
6. **Unknown cost is `null`, never `0`.** Writing zero for an unmeasured run is a lie the
   budget guardrail would believe.
7. **An unmeasurable budget is refused.** A workspace with `budgetUsd` set will not accept a
   provider that cannot report cost. The guardrail is real or it is absent; there is no
   silently inert middle.
8. **Gate breadth is a capability, not an assumption.** Claude gates every tool call
   (`PreToolUse` with matcher `"*"`); Cursor gates shell commands only. The difference is
   named in the contract and visible in the UI.
9. **Seam first, on a green suite.** The refactor lands before the second adapter and keeps
   the Claude adapter passing at every step (M11's baseline-green protocol). The second
   adapter arrives on an honest contract, never onto scaffolding built for it.

## 3. The Adapter Contract

`AgentRuntimeAdapter` keeps its shape — `id`, `getCapabilities`, `start`, `events`, `cancel`,
`requestPause`, `awaitPause`, `resume` — but three things change.

**`requestPause` and `awaitPause` acquire callers.** `packages/control/src/pause.ts` today
writes the pause flag with `writeFileSync`, and `emergencyStop` fans out through it. Both now
route through the adapter. The Claude adapter's implementation writes the same flag to the
same path, so the mechanism on disk is unchanged; what changes is who decides to write it.

**Run preparation moves inward.** `writeSettingsFile` is called from three orchestrator sites
(`tick.ts:461`, `planning.ts:280`, `review.ts:307`) and the hook path default lives at
`cli.ts:117`. Both become the adapter's business, performed inside `start`/`resume` from the
scratch directory `runFilePaths` provides. `runFilePaths` keeps giving each run a directory;
it stops naming what goes in it.

**Selection becomes a registry.** `buildAdapter()` resolves a `ProviderKind` to an adapter
instance. `ProviderConfiguration.settings` (JSON, workspace-scoped, already in the schema)
carries per-workspace adapter options — `{ command?: string, extraArgs?: string[] }`, the
shape `ClaudeCodeAdapterOptions` already uses. An unknown or unconfigured kind is a refusal,
not a fallback to Claude.

`ProviderCapabilities` is reduced to exactly the members this spec gives a consumer, per
Decision 2. `streamsToolCalls`, `supportsCustomSystemPrompt` and `enforcesToolPermissions`
have none and are deleted; `supportsHooks` is subsumed by gate breadth. What survives:

| Member | Consumer |
|---|---|
| `canPauseMidRun: boolean` | pause strategy (§4) |
| `canResumeSession: boolean` | pause strategy (§4) |
| `gate: 'all-tools' \| 'shell-only' \| 'none'` | gate semantics (§4), the UI mark (§8) |
| `reportsCost: boolean` | budget admission (§6) |

`reportsCost` replaces `reportsTokenUsage`: its only consumer is the budget guardrail, which
needs USD, and no code in this milestone counts tokens.

## 4. Pause and Emergency Stop

`pump.ts` stops switching on `hook_denied`, `hook_crashed`, `hook_failed_open` and
`permission_denied` as Claude-shaped facts. They remain `RuntimeEvent` variants — a
hook-capable adapter still emits them — but the orchestrator reads them through two
provider-neutral outcomes: *the gate stopped this run* and *the gate itself failed*. The
second still halts the workspace.

Pause dispatches on capability:

- `canPauseMidRun: true` (Claude) — unchanged. The flag is written, the `PreToolUse` hook
  denies the next tool call, the run stops at a tool boundary, a checkpoint is written.
- `canPauseMidRun: false, canResumeSession: true` (Cursor) — the adapter cancels the process
  and writes a checkpoint carrying the provider's session identifier. Resume continues that
  session.

A provider with neither capability cannot be registered. Emergency stop is unchanged for
both: cancellation is universal, and it remains the strongest guarantee in the system.

`Checkpoint` — duplicated deliberately in `packages/providers/src/claude/checkpoint.ts` and
`packages/db` — gains `provider` beside its existing `model`. A resumed run continues with
the pair it started with and is never re-resolved, matching today's behavior for `model`.

## 5. Runtime Resolution

`resolveModel` (`apps/orchestrator/src/model.ts`) becomes `resolveRuntime`, returning
`{ provider, model }`. The chain is M11's, unchanged in order:

> worker → companyAgent → companyAgent.template → workspace `ProviderConfiguration`

The rule is that the pair comes from **one** level: the first level that specifies a model
supplies the provider with it. A level that names a model without a provider is a refusal at
write time, not a resolution-time surprise.

Schema, additive in M11's discipline — nullable columns beside each existing `model`:

- `Agent.provider`, `CompanyAgent.provider`, `AgentTemplate.provider` (`ProviderKind?`)
- `Checkpoint.provider` (`ProviderKind?`)
- `AgentRun.provider` (`ProviderKind?`) — the column `apps/web/src/server/overview.ts:173`
  anticipated in a comment when it hardcoded `provider: 'claude-code'`.

New refusals, in `packages/control/src/refusal.ts`'s existing idiom:

- `model_without_provider` — `a model must name the provider that runs it`
- `invalid_provider` — `a provider must be a configured kind`
- `unmeasurable_budget` — `a budget needs a provider that reports cost`

## 6. Cost and the Budget Guardrail

`RunOutcome.costUsd` becomes `number | null`, and `AgentRun.costUsd` drops its NOT NULL
constraint (existing rows keep their values; the migration stays additive in effect).
`pump.ts` writes what the adapter reported, including `null`.

`world.ts`'s budget guardrail sums `costUsd` against `workspace.budgetUsd`. Under this spec
it never sums a `null` into a total as zero. Instead, admission is gated at both moments a
mismatch can be created, and the same `unmeasurable_budget` refusal serves both:

- **At write time** — assigning a `reportsCost: false` provider to a workspace that has a
  `budgetUsd`, or setting a `budgetUsd` on a workspace already resolved to one, is refused
  outright. The operator learns immediately, in the UI, rather than at the next dispatch.
- **At dispatch** — the orchestrator re-checks before starting a run, because resolution
  crosses four levels and a template edit can change the pair underneath a workspace that
  was valid when it was configured.

A workspace without a budget runs a cost-blind provider freely, and every surface
that displays cost — `overview.ts`, `org.ts`, `tasks.ts`, `graph.ts` and the M11 pages over
them — renders unknown distinctly from `$0.00`.

## 7. The Cursor Adapter

Driven exactly as the Claude adapter is: a local child process, `stream-json` on stdout, a
pid in `RunHandle`. Stream mapping:

| Cursor line | `RuntimeEvent` |
|---|---|
| `system` / init | `session_started` (from `session_id`) |
| `assistant` | `text` |
| `tool_call` (started / completed) | `tool_call` |
| `result` | `terminated` |

`RunOutcome` from the `result` line: `isError` from `is_error`, `terminalReason` from
`subtype`, `costUsd: null`, `stopReason: null`, and `numTurns` **derived** by counting
assistant messages — Cursor reports neither cost, tokens, nor a stop reason. The derivation
is documented at the parse site as a fidelity gap, not presented as a reported figure.

The write gate is a `beforeShellExecution` hook returning `permission: "deny"`, driven by the
same flag file the Claude gate reads. Because Cursor fires only the shell hooks, the gate
covers shell commands alone — hence `gate: 'shell-only'`, and hence pause does not
depend on it.

Capabilities: `{ canPauseMidRun: false, canResumeSession: true, gate: 'shell-only',
reportsCost: false }`. Every one of these is verified against the installed binary during
implementation and the evidence recorded in the task report. A capability that cannot be
proven takes its conservative value — `false` for a boolean, `'none'` for the gate — and is
never assumed true because the vendor's documentation says so.

## 8. Surfaces

Settings' template catalog gains a provider selector beside `defaultModel`, submitted as a
pair. The Roster's model override editor becomes a `(provider, model)` editor; `modelSource`
gains a provider counterpart so the resolution chain stays legible. Wherever a worker's
runtime is shown, a provider whose gate is shell-only is marked as such — Decision 8 is a
user-visible fact, not an internal flag.

No new pages. No SSE changes.

## 9. Testing

- **Parser fixtures.** Recorded Cursor NDJSON exercised through the parser, including a
  truncated stream and an unparsable line, mirroring the Claude parser's existing matrix.
- **Capability dispatch.** Pause strategy selection is tested per capability combination,
  including the unregisterable one.
- **Pair resolution.** Every level of the chain, plus the refusals: model without provider,
  unknown provider, budgeted workspace against a cost-blind provider.
- **Cost honesty.** A `null` cost never becomes `0` in the DB, in a sum, or on a page.
- **Baseline-green refactor.** Each seam task runs the existing suite before and after; the
  Claude adapter's behavior is frozen and its tests are not rewritten to fit the refactor.

## 10. Milestone Gate

`npm run gate:m12-providers` — one workspace, two workers, one per provider, the same task:

1. Both runs reach a terminal state and produce the same event and checkpoint contract.
2. Pause lands on both — by hook on Claude, by cancel-and-resume on Cursor — and both
   continue afterwards from where they stopped.
3. A budgeted workspace refuses the cost-blind provider with the exact refusal text.
4. The DB shows a `null` cost for the Cursor run and a real figure for the Claude run.

PASS: `two providers kept one promise`. FAIL dumps both runs' rows, the resolved pairs, and
the last stream lines from each.

The gate requires `cursor-agent` installed and authenticated. Its absence fails the gate
loudly; it never skips.
