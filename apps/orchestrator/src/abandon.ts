import { readdirSync, readFileSync } from 'node:fs'
import { recordRunEvidence, signalRun } from '@slave-of-ai/control'
import { prisma } from '@slave-of-ai/db/client'
import { appendEvent } from '@slave-of-ai/events'

/**
 * What a FORCED daemon stop does with the runs it was pumping (H9b R3, F2).
 *
 * The first SIGTERM drains: the tick in flight finishes, every pump is waited for, and a run that
 * has twenty minutes left keeps the daemon alive for twenty minutes. The second is "I mean it", and
 * until H9b it was `process.exit(130)` and nothing else -- the worker children lived on with nobody
 * reading their output, their runs stayed `working` with live pids, and the next daemon's dead-pid
 * arm could not fire until each child exited on its own, up to the run timeout later.
 *
 * Now the daemon ends its own runs before it goes:
 *
 * 1. **Claim** every run a pump of this process holds -- `failed`, `platform`, conditioned on the run
 *    not having concluded -- BEFORE any child is signalled. The order is the whole point: a pump
 *    whose child dies writes `failed` with no class (the stream ended without a terminal result),
 *    which is the worker's failure and an attempt spent. Claimed first, that write matches nothing.
 * 2. **Kill** each claimed run's child by pid, then every other direct child this process still has
 *    (`childPids`) -- a model call, a run whose row the claim could not read because the database is
 *    the reason somebody is forcing the stop.
 * 3. **Release** each claimed run's task the way the sweep's orphan arm does -- `rework` for an
 *    implementation, the claim alone for a review -- and announce it.
 *
 * Every database step is bounded by the caller: a stop that is being forced must never wait on a
 * database that may be what hung. What the bound cuts short, the next daemon's startup pass
 * finishes -- the children are dead either way, so it finds dead pids, which it concludes as the
 * platform's failure too.
 */
export interface AbandonedRun {
  readonly id: string
  readonly taskId: string | null
  readonly slaveId: string
  readonly kind: 'implementation' | 'review' | 'planning'
  readonly pid: number | null
  readonly workspaceId: string
}

/** Step 1 and the first half of step 2: claims the runs, then kills their children. */
export async function claimAndKillOwnRuns(runIds: readonly string[]): Promise<readonly AbandonedRun[]> {
  if (runIds.length === 0) return []
  const rows = await prisma.slaveRun.findMany({
    where: { id: { in: [...runIds] }, endedAt: null },
    select: { id: true, taskId: true, slaveId: true, kind: true, pid: true, slave: { select: { team: { select: { workspaceId: true } } } } },
  })
  const claimed: AbandonedRun[] = []
  for (const row of rows) {
    const now = new Date()
    const write = await prisma.slaveRun.updateMany({
      where: { id: row.id, endedAt: null },
      data: { status: 'failed', terminalAt: now, endedAt: now, failureClass: 'platform' },
    })
    if (write.count === 0) continue
    if (row.pid !== null) signalRun(row.pid, 'SIGKILL')
    claimed.push({
      id: row.id,
      taskId: row.taskId,
      slaveId: row.slaveId,
      kind: row.kind,
      pid: row.pid,
      workspaceId: row.slave.team.workspaceId,
    })
  }
  return claimed
}

/** Step 3: releases the claimed runs' tasks and says so. */
export async function releaseAbandonedRuns(runs: readonly AbandonedRun[]): Promise<void> {
  for (const run of runs) {
    // `sweep.ts`'s `concludeDeadRun` release, and no attempt: the daemon was stopped, the worker
    // did not fail.
    if (run.taskId !== null) {
      await prisma.task.updateMany({
        where: { id: run.taskId, activeRunId: run.id },
        data: run.kind === 'review' ? { activeRunId: null } : { status: 'rework', activeRunId: null },
      })
    }
    await appendEvent({
      type: 'run.failed',
      workspaceId: run.workspaceId,
      taskId: run.taskId,
      slaveId: run.slaveId,
      runId: run.id,
      actor: 'system',
      payload: {
        reason:
          `the daemon was forced to stop while this run was working; its process` +
          `${run.pid === null ? '' : ` (pid ${String(run.pid)})`} was killed so nothing is left running unread`,
      },
    })
    await recordRunEvidence(run.id, { recoveredBySweep: true }).catch(() => undefined)
  }
}

/**
 * The direct children of this process, read from `/proc` -- every process whose parent pid is ours.
 *
 * Linux only, and an empty list anywhere else or on any read failure: this is the second half of
 * step 2, behind the per-run kill that works everywhere, and it exists for the children a row does
 * not name. The worker CLIs are spawned without `detached`, so they are direct children.
 */
export function childPids(parent: number = process.pid): readonly number[] {
  let entries: string[]
  try {
    entries = readdirSync('/proc')
  } catch {
    return []
  }
  const children: number[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      // `/proc/<pid>/stat` is `pid (comm) state ppid ...`, and `comm` may itself contain spaces and
      // parentheses -- so the fields are read after the LAST `)`.
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[1]) === parent) children.push(Number(entry))
    } catch {
      // Gone between the listing and the read: nothing to kill.
    }
  }
  return children
}

/** Resolves `work`, or `fallback` once `ms` has passed -- whichever is first. */
export async function within<T>(ms: number, work: Promise<T>, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
    timer.unref()
  })
  try {
    return await Promise.race([work.catch(() => fallback), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
