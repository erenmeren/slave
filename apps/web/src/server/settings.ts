import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PROVIDER_ADAPTERS, capabilitiesOf, type ProviderKind } from '@slave-of-ai/control'
import { PROVIDER_KINDS, PROVIDER_LABEL, manifestFor } from '@slave-of-ai/domain'
import { prisma } from '@slave-of-ai/db/client'

const run = promisify(execFile)

export interface AdapterCard {
  readonly kind: string
  readonly label: string
  /** `'connected'` when the binary is on PATH, `'not found'` when it is not, `'later'` for an
   *  adapter this codebase does not have. */
  readonly state: 'connected' | 'not found' | 'later'
  /** The binary's own `--version` output, `null` when it could not be run. */
  readonly version: string | null
  readonly adapter: string
  /** `capabilitiesOf(kind)` flattened for display; `null` for a `later` card. */
  readonly capabilities: {
    readonly gate: string
    readonly reportsCost: boolean
    readonly canPauseMidRun: boolean
  } | null
  readonly slavesBound: number
}

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

/**
 * The binary's own `--version`, or `null` when it is not on PATH. Bounded, because a hung binary
 * must not hang the Settings page, and it never throws into the page: a missing binary is a fact
 * to render, not a 500.
 *
 * Honours the same `SLAVEOFAI_*_BIN` overrides `apps/orchestrator/src/cli.ts` does, so a fake-CLI
 * gate run sees the fakes rather than whatever happens to be installed on the gate machine.
 */
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

/**
 * @param resolveVersion how to ask a binary its version. Defaults to `versionOf`, i.e. the real
 * PATH probe. Injected only by `settings-snapshot.test.ts`, which must map `connected` and
 * `not found` without probing a real binary: `cursor-agent` self-updates, so no test may assert
 * against a version string it did not itself supply.
 */
export async function buildProviderAdapters(
  resolveVersion: (bin: string) => Promise<string | null> = versionOf,
): Promise<readonly AdapterCard[]> {
  const bound = await prisma.slaveRun.groupBy({ by: ['provider'], _count: { _all: true } })
  const countFor = (kind: string): number => bound.find((row) => row.provider === kind)?._count._all ?? 0

  const real = await Promise.all(
    REAL.map(async (adapter): Promise<AdapterCard> => {
      const version = await resolveVersion(adapter.bin)
      const capabilities = capabilitiesOf(adapter.kind)
      return {
        kind: adapter.kind,
        label: adapter.label,
        // Connect state IS "the binary is on PATH" -- nothing else is checkable without spending
        // money, and a green dot that means "we assume so" is worthless.
        state: version === null ? 'not found' : 'connected',
        version,
        adapter: adapter.adapter,
        capabilities: {
          gate: capabilities.gate,
          reportsCost: capabilities.reportsCost,
          canPauseMidRun: capabilities.canPauseMidRun,
        },
        slavesBound: countFor(adapter.kind),
      }
    }),
  )

  return [
    ...real,
    ...LATER.map(
      (adapter): AdapterCard => ({
        kind: adapter.kind,
        label: adapter.label,
        state: 'later',
        version: null,
        adapter: adapter.adapter,
        capabilities: null,
        slavesBound: 0,
      }),
    ),
  ]
}
