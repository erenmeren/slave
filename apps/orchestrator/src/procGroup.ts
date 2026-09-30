import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/**
 * Which live processes provably belong to a smoke attempt whose owner is gone (skeleton plan B D8,
 * fix ruling 1) -- read from Linux's `/proc`, so a settler never signals a process it cannot tie to
 * the attempt.
 *
 * A stored pid alone proves nothing after a crash: a reboot or a wrapped pid counter can hand that
 * number, and its process group, to a shell or an editor, and `kill(-pid)` would take the whole
 * group down. The opposite failure is just as real: the script's leader died, a server it
 * backgrounded lives on in the group, and a check on the leader alone kills nothing. So each member
 * of the stored group is kept only on evidence of its own: its working directory lies inside the
 * attempt's checkout, or it started no earlier than the attempt did.
 */

/** The start-time comparison's slack: `btime` is whole seconds, so a computed start can read up
 *  to a second early. The group's leader was spawned after the attempt row existed, so a process
 *  started a second before it cannot be the attempt's anyway -- and a reused pid is minutes older. */
const START_SLACK_MS = 1_000

/** `USER_HZ`, the unit of `/proc/<pid>/stat`'s start time: 100 on every mainstream Linux build,
 *  read from `getconf` once when it can be. */
let clockTicks: number | null = null
function clockTicksPerSecond(): number {
  if (clockTicks === null) {
    try {
      const read = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
      clockTicks = Number.isInteger(read) && read > 0 ? read : 100
    } catch {
      clockTicks = 100
    }
  }
  return clockTicks
}

/** `state` (field 3), `pgrp` (field 5) and `starttime` (field 22) of one `/proc/<pid>/stat` line. `comm` (field 2)
 *  may hold spaces and parentheses, so the fields are counted from its LAST `)`. */
function parseStat(line: string): { readonly state: string; readonly pgid: number; readonly startTicks: number } | null {
  const close = line.lastIndexOf(')')
  if (close < 0) return null
  const fields = line.slice(close + 2).split(' ')
  // fields[0] is field 3 (state), so field N is fields[N - 3].
  const pgid = Number(fields[2])
  const startTicks = Number(fields[19])
  return Number.isInteger(pgid) && Number.isFinite(startTicks) ? { state: fields[0] ?? '', pgid, startTicks } : null
}

function bootTimeMs(procRoot: string): number | null {
  const line = readFileSync(join(procRoot, 'stat'), 'utf8').split('\n').find((row) => row.startsWith('btime '))
  const seconds = line === undefined ? NaN : Number(line.slice('btime '.length).trim())
  return Number.isFinite(seconds) ? seconds * 1000 : null
}

function cwdInside(procRoot: string, pid: string, dir: string): boolean {
  try {
    // A removed checkout reads back as "<path> (deleted)".
    const cwd = resolve(readlinkSync(join(procRoot, pid, 'cwd')).replace(/ \(deleted\)$/u, ''))
    return cwd === dir || cwd.startsWith(dir + sep)
  } catch {
    return false
  }
}

/**
 * The pids in process group `pgid` that belong to the attempt, or `null` when `/proc` cannot be
 * read (not Linux, or a restricted mount) -- the caller then kills nothing and says so.
 */
export function attemptGroupMembers(input: {
  readonly pgid: number
  readonly worktreePath: string | null
  readonly startedAt: Date
  readonly procRoot?: string
  readonly clockTicks?: number
}): readonly number[] | null {
  const procRoot = input.procRoot ?? '/proc'
  let entries: string[]
  let boot: number | null
  try {
    entries = readdirSync(procRoot).filter((name) => /^\d+$/u.test(name))
    boot = bootTimeMs(procRoot)
  } catch {
    return null
  }
  const ticks = input.clockTicks ?? clockTicksPerSecond()
  const dir = input.worktreePath === null ? null : resolve(input.worktreePath)
  const members: number[] = []
  for (const pid of entries) {
    let stat: ReturnType<typeof parseStat>
    try {
      stat = parseStat(readFileSync(join(procRoot, pid, 'stat'), 'utf8'))
    } catch {
      continue // Exited while we looked.
    }
    // A zombie is already dead, waiting for its parent to reap it; signalling it again does nothing.
    if (stat === null || stat.pgid !== input.pgid || stat.state === 'Z') continue
    const inCheckout = dir !== null && cwdInside(procRoot, pid, dir)
    const startedSince = boot !== null && boot + (stat.startTicks / ticks) * 1000 >= input.startedAt.getTime() - START_SLACK_MS
    if (inCheckout || startedSince) members.push(Number(pid))
  }
  return members
}

/**
 * SIGKILLs each proven member of the attempt's group, one pid at a time -- never `kill(-pgid)`,
 * which would also reach any member the scan could NOT tie to the attempt. Scanned again after each
 * round, a few times, for children forked meanwhile. Returns false when `/proc` could not be read
 * and nothing was killed.
 */
export function killAttemptGroup(input: Parameters<typeof attemptGroupMembers>[0], kill: (pid: number) => void = defaultKill): boolean {
  for (let round = 0; round < 3; round += 1) {
    const members = attemptGroupMembers(input)
    if (members === null) return round > 0
    if (members.length === 0) return true
    for (const pid of members) kill(pid)
  }
  return true
}

function defaultKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}
