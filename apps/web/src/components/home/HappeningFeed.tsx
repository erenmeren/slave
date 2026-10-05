'use client'

import Link from 'next/link'
import type { HappeningLine } from '@slave-of-ai/control'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { usePoll } from '@/hooks/usePoll'
import { formatAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

/** How often the feed re-reads: with Home (lead UX design U-9). */
export const HAPPENING_POLL_MS = 10_000

const KIND_TONE: Readonly<Record<HappeningLine['kind'], string>> = {
  lead: 'text-info-foreground',
  helper: 'text-success-foreground',
  checker: 'text-checking-foreground',
  worker: 'text-foreground',
  person: 'text-warning-foreground',
  project: 'text-muted-foreground',
}

const DOT: Readonly<Record<'ok' | 'error' | 'running' | 'none' | 'state', string>> = {
  ok: 'bg-success',
  error: 'bg-destructive',
  running: 'bg-info working-pulse',
  none: 'bg-muted-foreground/40',
  state: 'border-2 border-warning bg-transparent',
}

const DOT_WORD: Readonly<Record<keyof typeof DOT, string>> = { ok: 'Done', error: 'Failed', running: 'Running', none: 'Ended without a result', state: 'A change of state' }

/** The mark in front of a line: a step's outcome, or a ring for a change of state. */
export function dotOf(line: Pick<HappeningLine, 'step' | 'outcome'>): keyof typeof DOT {
  return line.step ? (line.outcome ?? 'none') : 'state'
}

/**
 * Home's "Happening now": the newest steps across every project that is not archived -- which
 * project, who, what it was in words, whether it worked, when -- with the changes of state worth a
 * line among them (a build started, was checked, waits for a decision, was merged, was stopped).
 * Each line opens its project. Re-read with Home; a read that answers without lines keeps the feed
 * as it was.
 */
export function HappeningFeed({ initial }: { readonly initial: readonly HappeningLine[] }): React.JSX.Element {
  const { data } = usePoll<{ readonly lines?: readonly HappeningLine[] }>('/api/happening', { lines: initial }, () => HAPPENING_POLL_MS)
  const lines = data.lines ?? initial
  const running = lines.some((line) => line.outcome === 'running')
  return (
    <Card data-testid="happening" className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Happening now
          {running && <span aria-hidden className="working-pulse size-2 rounded-full bg-info" />}
        </CardTitle>
        <CardDescription>{lines.length === 0 ? 'Nothing has happened yet.' : 'The newest steps across your projects, newest first.'}</CardDescription>
      </CardHeader>
      <CardContent>
        {lines.length === 0 ? (
          <p data-testid="happening-empty" className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
            Every step a lead, a helper or a checker makes shows up here as it happens.
          </p>
        ) : (
          <div className="max-h-[300px] overflow-y-auto pr-2">
            <ol className="flex flex-col">
              {lines.map((line) => {
                const dot = dotOf(line)
                return (
                  <li key={line.id} data-testid="happening-line" data-kind={line.kind} data-outcome={dot} className="border-b last:border-b-0">
                    <Link href={`/w/${line.projectId}`} className="flex min-w-0 items-baseline gap-3 rounded-sm py-1.5 text-sm hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none">
                      <span className={cn('mt-1.5 size-2 shrink-0 self-start rounded-full', DOT[dot])} title={DOT_WORD[dot]} />
                      <span className={cn('w-20 shrink-0 truncate font-medium sm:w-32', KIND_TONE[line.kind])} title={line.who}>
                        {line.who}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className={cn('truncate', !line.step && 'font-medium')} title={line.text}>
                          {line.text}
                        </span>
                        <span className="truncate text-xs text-muted-foreground xl:hidden">{line.projectName}</span>
                      </span>
                      <span className="hidden max-w-[220px] shrink-0 truncate text-xs text-muted-foreground xl:block" title={line.projectName}>
                        {line.projectName}
                      </span>
                      <span className="shrink-0 text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums" suppressHydrationWarning>
                        {formatAgo(line.at)}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ol>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
