import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PROVIDER_KINDS, PROVIDER_LABEL } from '../../src/provider/kind.js'
import { LEDGER_AXES, LEDGER_END, LEDGER_START, renderProviderLedger } from '../../src/provider/ledger.js'
import { manifestFor } from '../../src/provider/manifest.js'

/** Repo-root relative, the way `derived.test.ts` reads its goldens: both vitest projects run from
 *  the repository root. */
const DOC = 'docs/providers/adding-a-provider.md'

/** The table's own lines, header and separator first. The `differences` bullets under the table
 *  start with `- ` and so are never counted as rows. */
const tableRows = (): readonly string[] => renderProviderLedger().split('\n').filter((line) => line.startsWith('|'))

describe('renderProviderLedger (§4)', () => {
  it('is a column per provider, in PROVIDER_KINDS order, headed by the words a person reads', () => {
    const header = renderProviderLedger().split('\n')[0] ?? ''
    for (const kind of PROVIDER_KINDS) expect(header, kind).toContain(PROVIDER_LABEL[kind])
    expect(header.indexOf(PROVIDER_LABEL.claude_code)).toBeLessThan(header.indexOf(PROVIDER_LABEL.cursor))
  })

  it('is a row per axis and an axis per row -- one table line for each, and no line that is neither', () => {
    const rendered = renderProviderLedger()
    for (const axis of LEDGER_AXES) expect(rendered, axis.label).toContain(`| ${axis.label} |`)
    // Header, separator, then exactly one data row per axis: a row rendered outside `LEDGER_AXES`
    // would be a fact no axis owns, and an axis with no row would be a fact no reader sees.
    expect(tableRows().slice(2)).toHaveLength(LEDGER_AXES.length)
    // Sixteen rows over twelve of the manifest's fourteen fields: `invocation` is five separate
    // decisions and gets five rows, `kind` IS the column header, and `differences` is a list under
    // the table because a table cell is the wrong shape for a paragraph.
    expect(LEDGER_AXES).toHaveLength(16)
  })

  it('never leaves a cell empty -- an unmeasured axis must read as one, not as a blank', () => {
    for (const axis of LEDGER_AXES) {
      for (const kind of PROVIDER_KINDS) expect(axis.cell(manifestFor(kind)).trim(), `${axis.label}/${kind}`).not.toBe('')
    }
  })

  it('escapes the one character a markdown table cannot carry', () => {
    // A `differences` sentence or a flag with a pipe in it would silently split a row in two. The
    // assertion is over DATA rows only: the separator row IS `|---|---|` and would fail a rule that
    // exists for cell contents.
    for (const row of tableRows().slice(2)) expect(row, row.slice(0, 32)).not.toMatch(/[^\\]\|[^ \n|]/)
  })

  it('lists every stated limitation, so the ledger carries the prose and not only the axes', () => {
    const rendered = renderProviderLedger()
    for (const kind of PROVIDER_KINDS) {
      for (const sentence of manifestFor(kind).differences) {
        expect(rendered, `${kind}: ${sentence.slice(0, 40)}`).toContain(sentence.replaceAll('|', '\\|'))
      }
    }
  })

  it('renders the same bytes every time, so regenerating it is a no-op diff until a manifest moves', () => {
    expect(renderProviderLedger()).toBe(renderProviderLedger())
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
