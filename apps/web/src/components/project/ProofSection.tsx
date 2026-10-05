'use client'

import { Fragment, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import { REQUIREMENT_RESULT_LABEL, type RequirementResult } from '@slave-of-ai/domain'
import type { BuildView, ProofRow } from '@slave-of-ai/control'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'

const RESULT_TONE: Readonly<Record<RequirementResult, string>> = {
  pass: 'border-transparent bg-success-muted text-success-foreground',
  fail: 'border-transparent bg-destructive/15 text-destructive',
  unverifiable: 'border-transparent bg-warning-muted text-warning-foreground',
  disputed: 'border-transparent bg-checking-muted text-checking-foreground',
  unchecked: 'border-border bg-transparent text-muted-foreground',
}

/** "7 of 9 work · 1 doesn't work · 1 couldn't check · checked 2 times" (design section 6.3). */
export function proofSummary(rows: readonly ProofRow[], rounds: number): string {
  const count = (result: RequirementResult): number => rows.filter((row) => row.result === result).length
  const parts = [`${String(count('pass'))} of ${String(rows.length)} work`]
  if (count('fail') > 0) parts.push(`${String(count('fail'))} doesn't work`)
  if (count('unverifiable') > 0) parts.push(`${String(count('unverifiable'))} couldn't check`)
  if (count('disputed') > 0) parts.push(`${String(count('disputed'))} checkers disagree`)
  if (count('unchecked') > 0) parts.push(`${String(count('unchecked'))} not checked yet`)
  if (rounds > 0) parts.push(`checked ${plural(rounds, 'time')}`)
  return parts.join(' · ')
}

export function ResultBadge({ result }: { readonly result: RequirementResult }): React.JSX.Element {
  return (
    <Badge variant="outline" data-result={result} className={cn('whitespace-nowrap', RESULT_TONE[result])}>
      {REQUIREMENT_RESULT_LABEL[result]}
    </Badge>
  )
}

function Row({ row }: { readonly row: ProofRow }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const toggle =
    row.check === null ? null : (
      <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        {open ? 'Hide how it was checked' : 'Show how it was checked'}
      </Button>
    )
  return (
    <Fragment>
      <TableRow data-testid="proof-row" data-key={row.key} data-result={row.result}>
        <TableCell className="align-top font-mono text-xs text-muted-foreground">{row.key}</TableCell>
        <TableCell className="align-top whitespace-normal">
          {row.text}
          <span className="mt-1 block text-xs text-muted-foreground md:hidden">
            {row.reason}
            {toggle !== null && <span className="block">{toggle}</span>}
          </span>
        </TableCell>
        <TableCell className="align-top">
          <ResultBadge result={row.result} />
        </TableCell>
        <TableCell className="hidden align-top whitespace-normal text-muted-foreground md:table-cell">
          {row.reason ?? '—'}
          {toggle !== null && <span className="block">{toggle}</span>}
        </TableCell>
      </TableRow>
      {open && row.check !== null && (
        <TableRow data-testid="proof-detail">
          <TableCell className="hidden md:table-cell" />
          <TableCell colSpan={3} className="whitespace-normal">
            <p className="mb-1 text-xs font-medium text-muted-foreground">What the checker ran</p>
            <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{row.check}</pre>
            {row.output !== null && row.output !== '' && (
              <>
                <p className="mt-2 mb-1 text-xs font-medium text-muted-foreground">What it got back</p>
                <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{row.output}</pre>
              </>
            )}
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  )
}

/**
 * Lead UX design section 6.3, "Proof": one row per requirement with its result in words and the
 * checker's reason, the check it ran and its output one click away.
 */
export function ProofSection({ build }: { readonly build: BuildView }): React.JSX.Element {
  const rows = build.proof
  return (
    <Card data-testid="proof">
      <CardHeader>
        <CardTitle className="text-base">Proof</CardTitle>
        {rows !== null && rows.length > 0 && build.rounds > 0 && <CardDescription data-testid="proof-summary">{proofSummary(rows, build.rounds)}</CardDescription>}
      </CardHeader>
      <CardContent>
        {rows === null ? (
          <p className="text-sm text-muted-foreground">Reading the requirements from your request…</p>
        ) : build.rounds === 0 && rows.every((row) => row.result === 'unchecked') ? (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              Nothing has been checked yet. When the lead finishes, an independent checker starts the product and tries every requirement.
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {rows.map((row) => (
                <li key={row.key}>{row.text}</li>
              ))}
            </ol>
          </>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>Requirement</TableHead>
                <TableHead className="w-36">Result</TableHead>
                <TableHead className="hidden md:table-cell">Why</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <Row key={row.key} row={row} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
