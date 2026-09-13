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

/** What a cell reads when a list is empty. Never the empty string: a blank cell is indistinguishable
 *  from a cell nobody filled in, and `ledger.test.ts` refuses one. */
const NOTHING = '—'

const code = (value: string): string => `\`${value}\``
const list = (values: readonly string[]): string => (values.length === 0 ? NOTHING : values.map(code).join(' '))

/**
 * The differences ledger, as rows (M56a §4).
 *
 * SIXTEEN ROWS OVER TWELVE of the manifest's fourteen fields, and the arithmetic is the point:
 * `invocation` is five separate decisions (which binary, which env vars override it, which flags go
 * on every spawn, how the prompt is delivered, which flags must never be emitted) and gets five
 * rows; `kind` IS the column header; and `differences` is a list under the table, because a table
 * cell is the wrong shape for a paragraph. Every other field is exactly one row.
 *
 * One row per axis and one axis per row -- nothing is appended to the table outside this list, so a
 * fact printed in the document is always a fact some entry here owns. `ledger.test.ts` asserts the
 * count both ways.
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
  {
    label: 'Resume',
    cell: (m) =>
      [
        `${code(m.resume.mode)}${m.resume.flag === null ? '' : ` on ${code(m.resume.flag)}`}`,
        m.resume.neverPass.length === 0 ? '' : `, never ${list(m.resume.neverPass)}`,
      ].join(''),
  },
  // The ADR link is written relative to the document the block lands in -- `docs/providers/` --
  // rather than from the repository root, because a root-absolute markdown link resolves against the
  // host's domain and not the repository, and is broken everywhere it renders.
  { label: 'Pause rung', cell: (m) => `${code(m.pause.rung)} ([ADR 0001](../${m.pause.adr.replace(/^docs\//, '')}))` },
  { label: 'Events', cell: (m) => `${code(m.events.transport)}: ${list(m.events.produces)}` },
  { label: 'Structured output', cell: (m) => code(m.structuredOutput) },
  { label: 'Tool restrictions', cell: (m) => `${code(m.toolRestrictions.mechanism)} / ${code(m.toolRestrictions.enforce)}` },
  {
    // The NAMES and not a count: the measured difference between these two columns is not that one
    // is longer, it is that this vendor's payloads carry `read`/`edit`/`shell` and the other's carry
    // `Read`/`Edit`/`Bash` -- which is the whole reason `toolRestrictions.enforce` reads
    // `known-tools` on one of them. A count hides exactly the fact the row exists to show.
    label: 'Tool vocabulary',
    cell: (m) => {
      const named = Object.entries(m.toolVocabulary).filter(([, tools]) => tools.length > 0)
      return named.length === 0 ? NOTHING : named.map(([kind, tools]) => `${code(kind)}: ${list(tools)}`).join('; ')
    },
  },
  { label: 'Usage and cost', cell: (m) => code(m.usageCost) },
  { label: 'Hooks', cell: (m) => list(m.hooks) },
  { label: 'Run files', cell: (m) => list(m.runFiles.channels) },
  { label: 'Measured against', cell: (m) => `${code(m.measured.version)} (${m.measured.date})` },
]

const escape = (cell: string): string => cell.replaceAll('|', '\\|')

/**
 * The ledger, rendered from the manifests (M56a §4).
 *
 * PURE: it reads `PROVIDER_MANIFESTS` and returns a string, touches no filesystem and imports no
 * `node:` module -- `apps/web`'s client bundle imports this package's index, and a `node:` anywhere
 * in its graph fails `web:build` outright (`packages/domain/src/goal/version.ts`'s `sha256`
 * docstring records that as a measured fact). Writing the string into the document is a person's
 * act, and `ledger.test.ts` is what makes forgetting it red.
 *
 * The table's cells print the contract's own vocabulary rather than a label table, which is the one
 * place in this product that is right: `docs/ia.md` rule 3 governs what a PERSON USING THE PRODUCT
 * reads, and the reader here is somebody about to write a `ProviderCapabilityManifest`. The COLUMN
 * HEADS are still the words -- `PROVIDER_LABEL` -- because those name the product's two runtimes.
 */
export function renderProviderLedger(): string {
  const kinds = [...PROVIDER_KINDS]
  const lines: string[] = []
  lines.push(`| Axis | ${kinds.map((kind) => PROVIDER_LABEL[kind]).join(' | ')} |`)
  lines.push(`|---|${kinds.map(() => '---').join('|')}|`)
  for (const axis of LEDGER_AXES) {
    lines.push(`| ${axis.label} | ${kinds.map((kind) => escape(axis.cell(manifestFor(kind)))).join(' | ')} |`)
  }
  lines.push('')
  for (const kind of kinds) {
    lines.push(`**${PROVIDER_LABEL[kind]} — stated limitations**`)
    lines.push('')
    for (const sentence of manifestFor(kind).differences) lines.push(`- ${escape(sentence)}`)
    lines.push('')
  }
  return lines.join('\n')
}
