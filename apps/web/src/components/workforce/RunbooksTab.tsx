'use client'

import { useState } from 'react'
import { capabilityIndex, stageOrder, type CapabilityRecord } from '@slave-of-ai/domain'
import type { RunbookRowView } from '../../server/org'
import { plural } from '../../lib/plural'
import { Chip } from '../ui/Chip'
import { DataTable, Row } from '../ui/DataTable'
import { Drawer } from '../ui/Drawer'
import { EmptyState } from '../ui/EmptyState'
import { SectionLabel } from '../ui/SectionLabel'

const COLUMNS = '1.2fr 2fr 90px 190px 100px'
const HEADER = ['Name', 'What it is for', 'Stages', 'Where it came from', 'Projects'] as const

/** Where a runbook came from, in words. The raw column stays one hover away (M44 R5). */
const SOURCE_WORD: Record<RunbookRowView['source'], string> = {
  seed: 'shipped with the product',
  persona: 'a specialist’s own workflow',
  human: 'written here',
}

/**
 * The Runbooks tab (M48 R7): every stage plan a project can adopt, and what each one actually says.
 *
 * READ-ONLY, and that is the design rather than an omission: `runbooks add --file` is the only
 * writer (spec §3), because a runbook is a file an operator reviews and checks in -- not a form
 * somebody fills in while looking at a table. A row opens a drawer that says what adopting it would
 * mean, stage by stage: what the stage is for, who it needs, what has to pass, how many attempts a
 * task in it gets, and what happens when it runs out of them.
 *
 * `stageOrder` rather than the stored array's order: the same topological walk `measureAdherence`
 * and the planner read, so the order a person reads here is the order the work is expected to
 * happen in.
 */
export function RunbooksTab({
  runbooks,
  taxonomy,
}: {
  readonly runbooks: readonly RunbookRowView[]
  /** The capability taxonomy the page already read: what turns a stage's keys into words. */
  readonly taxonomy: readonly CapabilityRecord[]
}): React.JSX.Element {
  const [openKey, setOpenKey] = useState<string | null>(null)
  // ONE index for the whole render (the M47 carry): a drawer labels a capability per stage, and
  // `capabilityLabel` builds a fresh Map out of the taxonomy on every call.
  const index = capabilityIndex(taxonomy)
  const label = (key: string): string => index.get(key)?.label ?? key
  const open = runbooks.find((runbook) => runbook.key === openKey) ?? null

  if (runbooks.length === 0) {
    return <EmptyState testId="runbooks-empty" message="no runbook is installed — `runbooks sync` writes the ones that ship with the product." />
  }

  return (
    <div className="flex flex-col gap-3">
      <div data-testid="workforce-runbooks">
        <DataTable columns={COLUMNS} header={[...HEADER]}>
          {runbooks.map((runbook, position) => (
            // The row carries the identity a gate reads; the `Row` primitive keeps the handle four
            // gates already drive (`WorkforceCatalog`'s own reason for wrapping).
            <div key={runbook.key} data-testid="runbook-row" data-key={runbook.key}>
              {/* `last` because this `Row` is the only child of its wrapper, so its own
                * `:last-child` selector would match every row and draw no separator at all. */}
              <Row columns={COLUMNS} last={position === runbooks.length - 1}>
                <button
                  type="button"
                  data-testid={`runbook-open-${runbook.key}`}
                  onClick={() => setOpenKey(runbook.key)}
                  className="truncate text-left text-sm text-text-1 hover:text-text-2"
                >
                  {runbook.name}
                </button>
                <span className="truncate text-text-2">{runbook.description}</span>
                <span className="font-mono text-xs text-text-2">{plural(runbook.stages.length, 'stage')}</span>
                <span className="truncate text-xs text-text-3" title={runbook.source}>
                  {runbook.source === 'persona' && runbook.sourceTemplateName !== null
                    ? `${SOURCE_WORD.persona} · ${runbook.sourceTemplateName}`
                    : SOURCE_WORD[runbook.source]}
                </span>
                <span className="font-mono text-xs text-text-2">{plural(runbook.workspaceCount, 'project')}</span>
              </Row>
            </div>
          ))}
        </DataTable>
      </div>
      {open !== null && (
        <Drawer open onClose={() => setOpenKey(null)} label={open.name} testId="runbook-drawer">
          <header className="flex flex-col gap-1">
            <h2 className="text-sm font-medium text-text-1">{open.name}</h2>
            <span className="text-xs text-text-2">{open.description}</span>
            <div className="flex flex-wrap items-center gap-1">
              <Chip title={open.source}>{SOURCE_WORD[open.source]}</Chip>
              {/* A persona runbook names the specialist it was translated from -- the NAME, never
                * the template id: an id says nothing to the person reading it. */}
              {open.sourceTemplateName !== null && (
                <Chip testId="runbook-drawer-source-template">translated from {open.sourceTemplateName}</Chip>
              )}
              <span className="font-mono text-[10px] text-text-3">{plural(open.workspaceCount, 'project')}</span>
            </div>
          </header>

          {open.requiredCapabilities.length > 0 && (
            <div className="flex flex-col gap-1">
              <SectionLabel>needs somebody who can</SectionLabel>
              <div className="flex flex-wrap gap-1">
                {open.requiredCapabilities.map((key) => (
                  <Chip key={key} title={key}>
                    {label(key)}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <SectionLabel>stages, in order</SectionLabel>
            {/* An ordered list, because the order IS the content of a runbook. */}
            <ol className="flex flex-col gap-2">
              {stageOrder(open.stages).map((stage) => (
                <li
                  key={stage.key}
                  data-testid="runbook-drawer-stage"
                  data-stage={stage.key}
                  className="flex flex-col gap-1 rounded border border-line p-2"
                >
                  <span className="text-xs text-text-1">{stage.title}</span>
                  <span className="text-[11px] text-text-2">{stage.objective}</span>
                  {stage.capabilities.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {stage.capabilities.map((key) => (
                        <Chip key={key} testId="runbook-stage-capability" title={key}>
                          {label(key)}
                        </Chip>
                      ))}
                    </div>
                  )}
                  {stage.expectedOutputs.length > 0 && (
                    <ul className="flex list-disc flex-col gap-0.5 pl-4">
                      {stage.expectedOutputs.map((output) => (
                        <li key={output} className="text-[11px] text-text-2">
                          {output}
                        </li>
                      ))}
                    </ul>
                  )}
                  {/* The three things that change what happens to a task in this stage: what must
                    * pass, how many tries it gets, and what a person is told when it runs out. */}
                  {stage.gates.length > 0 && (
                    <span data-testid="runbook-stage-gates" className="font-mono text-[10px] text-text-3">
                      gates: {stage.gates.join(' · ')}
                    </span>
                  )}
                  {stage.retry !== null && (
                    <span data-testid="runbook-stage-retry" className="text-[11px] text-text-3">
                      {plural(stage.retry.maxAttempts, 'attempt')} before it stops
                    </span>
                  )}
                  {stage.escalation !== null && (
                    <span data-testid="runbook-stage-escalation" className="text-[11px] text-tone-waiting">
                      {stage.escalation}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </div>

          {/* Said out loud, because a table of things with no Edit button invites the question. */}
          <span className="text-[11px] text-text-3">
            A runbook is a checked-in file: `runbooks add --file` writes one, and an imported
            specialist’s own workflow becomes one automatically.
          </span>
        </Drawer>
      )}
    </div>
  )
}
