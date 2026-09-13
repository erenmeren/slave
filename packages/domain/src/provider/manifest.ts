import { z } from 'zod'
// TYPE ONLY, and load-bearing: `permission/kinds.ts` imports `manifestFor` from this module as a
// VALUE, so a value import back would be a runtime cycle and a module-evaluation order nobody can
// reason about. `import type` is erased, which makes the dependency one-directional at run time
// while staying total at compile time.
import type { PermissionKind } from '../permission/kinds.js'
import { CLAUDE_CODE_MANIFEST } from './claude-code.js'
import { CURSOR_MANIFEST } from './cursor.js'
// The NAMES as a value, because `providerManifestSchema` builds a `z.enum` out of them, and the
// type, because `ProviderEvents.produces` is an array of it.
import { RUNTIME_EVENT_KINDS, type RuntimeEventKind } from './events.js'
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
