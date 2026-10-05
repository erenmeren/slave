'use client'

import Link from 'next/link'
import type { BuildDiagram, DiagramCall, DiagramSession } from '@slave-of-ai/control'
import { TURN_WORD } from '@/components/project/CostSection'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { formatAgo, plural } from '@/lib/format'
import { cn } from '@/lib/utils'
import { costOf } from './shape'
import type { DiagramSubject } from './TeamDiagram'
import { RESULT_WORD, STATE_WORD, TONE_BADGE, endOf, formatClock, formatDuration, toneOfResult, toneOfState } from './words'

/** The most steps the panel lists: the newest ones. */
export const SHEET_STEPS = 200

/** A session's name: the lead's turn in words, a check with its number, or what a helper was asked. */
export function sessionName(session: DiagramSession, index: number): string {
  if (session.nodeId === 'lead') return TURN_WORD[session.label] ?? session.label.replaceAll('_', ' ')
  if (session.label === 'check') return `Check ${String(index + 1)}`
  return session.label
}

const OUTCOME_DOT: Readonly<Record<'ok' | 'error' | 'open' | 'unknown', string>> = { ok: 'bg-success', error: 'bg-destructive', open: 'bg-info working-pulse', unknown: 'bg-muted-foreground/40' }
const OUTCOME_WORD: Readonly<Record<'ok' | 'error' | 'open' | 'unknown', string>> = { ok: 'Done', error: 'Failed', open: 'Running', unknown: 'Ended without a result' }

/** How a step went: done, failed, still running, or cut off when its session ended. */
export function outcomeOf(call: DiagramCall): 'ok' | 'error' | 'open' | 'unknown' {
  return call.outcome ?? (call.endedAt === null ? 'open' : 'unknown')
}

function Figure({ label, value }: { readonly label: string; readonly value: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border p-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-sm font-semibold tabular-nums" title={value}>{value}</span>
    </div>
  )
}

/**
 * The side panel of a card: who it is and how it stands, its sessions with when each began and
 * ended and how long it took, and its steps newest first -- what was done, whether it worked,
 * and when. A roster person links to their page in People.
 */
export function NodeSheet({ build, workspaceId, subject, onClose }: { readonly build: BuildDiagram; readonly workspaceId: string; readonly subject: DiagramSubject | null; readonly onClose: () => void }): React.JSX.Element {
  const node = subject === null ? undefined : build.nodes.find((one) => one.id === subject.nodeId)
  const end = endOf(build)
  const all = node === undefined ? [] : build.sessions.filter((session) => session.nodeId === node.id)
  const sessions = subject?.sessionId == null ? all : all.filter((session) => session.id === subject.sessionId)
  const one = subject?.sessionId == null ? null : (sessions[0] ?? null)
  const calls = node === undefined ? [] : build.calls.filter((call) => call.nodeId === node.id && (one === null || call.sessionId === one.id))
  const steps = calls.slice(-SHEET_STEPS).reverse()
  const total = one?.toolCalls ?? node?.toolCalls ?? 0
  const state = one?.state ?? node?.state ?? 'done'
  const person = node !== undefined && node.kind !== 'request' && node.kind !== 'result'

  return (
    <Sheet open={node !== undefined} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-md" data-testid="diagram-sheet">
        {node !== undefined && (
          <>
            <SheetHeader className="border-b">
              <SheetTitle className="flex flex-wrap items-center gap-2 pr-6">
                {node.name}
                {person && <Badge className={TONE_BADGE[toneOfState(state, node.kind === 'checker')]}>{STATE_WORD[state]}</Badge>}
                {node.kind === 'result' && <Badge className={TONE_BADGE[toneOfResult(build.result)]}>{RESULT_WORD[build.result]}</Badge>}
              </SheetTitle>
              <SheetDescription>
                {node.kind === 'request' && `What you asked for in build ${String(build.version)}.`}
                {node.kind === 'result' && `What came of build ${String(build.version)}.`}
                {node.kind === 'lead' && 'The lead builds what you asked for and starts its own helpers.'}
                {node.kind === 'checker' && (node.id === 'checker' ? 'The checker proves each requirement against the running build.' : 'The second checker confirms what the first one found.')}
                {node.kind === 'helper' && (one === null ? `A helper the lead called ${plural(node.sessions, 'time')}.` : `One session of a helper: ${one.label}`)}
              </SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
              {node.kind === 'request' && <p className="text-sm whitespace-pre-wrap">{build.goal === '' ? 'The request has no text.' : build.goal}</p>}
              {(node.kind === 'request' || node.kind === 'result') && (
                <Button asChild variant="outline" size="sm" className="self-start">
                  <Link href={`/w/${workspaceId}/goals/${String(build.version)}`}>Open the full report</Link>
                </Button>
              )}
              {person && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <Figure label="Steps" value={String(total)} />
                    <Figure label="Failed" value={String(one?.failedCalls ?? node.failedCalls)} />
                    <Figure label="Cost" value={(costOf(node.kind, one === null ? node.costUsd : one.costUsd, state === 'working' || state === 'paused') ?? '').replace(/^cost /u, '')} />
                  </div>
                  {state === 'working' && <p className="text-sm">{one?.doing ?? node.doing ?? 'Starting…'}</p>}
                  {node.personId !== null && (
                    <Button asChild variant="outline" size="sm" className="self-start" data-testid="diagram-person-link">
                      <Link href={`/people?person=${node.personId}`}>Open {node.name} in People</Link>
                    </Button>
                  )}
                  <section className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium">{one === null ? `Sessions (${String(sessions.length)})` : 'Session'}</h3>
                    <ol className="flex flex-col gap-1.5">
                      {sessions.map((session) => {
                        const from = Date.parse(session.startedAt)
                        const to = session.endedAt === null ? end : Date.parse(session.endedAt)
                        return (
                          <li key={session.id} data-testid="diagram-session" className="flex flex-col gap-0.5 rounded-lg border p-2.5 text-sm">
                            <div className="flex items-start justify-between gap-2">
                              <span className="min-w-0 font-medium break-words">{sessionName(session, all.indexOf(session))}</span>
                              <Badge className={cn('shrink-0', TONE_BADGE[toneOfState(session.state, node.kind === 'checker')])}>{STATE_WORD[session.state]}</Badge>
                            </div>
                            <span className="text-xs text-muted-foreground tabular-nums" suppressHydrationWarning>
                              {formatClock(from, true)}{session.endedAt === null ? (session.state === 'paused' ? ', paused' : ' to now') : ` to ${formatClock(to, true)}`} · {formatDuration(to - from)} · {plural(session.toolCalls, 'step')}
                              {session.failedCalls > 0 && ` · ${String(session.failedCalls)} failed`}
                              {node.kind !== 'helper' && ` · ${(costOf(node.kind, session.costUsd, session.endedAt === null) ?? '').replace(/^cost /u, 'cost ')}`}
                            </span>
                          </li>
                        )
                      })}
                    </ol>
                  </section>
                  <section className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium">Steps</h3>
                    <p className="text-xs text-muted-foreground">{steps.length === 0 ? 'No steps yet.' : steps.length < total ? `The newest ${String(steps.length)} of ${String(total)}, newest first.` : 'Newest first.'}</p>
                    <ol className="flex flex-col">
                      {steps.map((call) => {
                        const outcome = outcomeOf(call)
                        return (
                          <li key={call.id} data-testid="diagram-step" data-outcome={outcome} className="flex min-w-0 items-baseline gap-2.5 border-b py-1.5 text-sm last:border-b-0">
                            <span className={cn('mt-1.5 size-2 shrink-0 self-start rounded-full', OUTCOME_DOT[outcome])} title={OUTCOME_WORD[outcome]} />
                            <span className="min-w-0 flex-1 break-words">
                              {call.text}
                              {outcome === 'error' && <span className="text-destructive"> · failed</span>}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground tabular-nums" suppressHydrationWarning title={formatClock(Date.parse(call.at), true)}>
                              {formatAgo(call.at)}
                            </span>
                          </li>
                        )
                      })}
                    </ol>
                  </section>
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
