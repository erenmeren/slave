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
 * attempt's checkout, or it started no earlier than the attempt did -- and nothing at all is claimed
 * on a machine that booted after the attempt started, where every process is "newer" than it.
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

/** What a scan of the attempt's group found (Task 3 fix rounds 1-2). */
export type AttemptGroupScan =
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'rebooted' }
  | { readonly kind: 'members'; readonly pids: readonly number[] }

/** The attempt and where to look. `procRoot` and `clockTicks` exist for tests. */
export interface AttemptGroupInput {
  readonly pgid: number
  readonly worktreePath: string | null
  readonly startedAt: Date
  readonly procRoot?: string
  readonly clockTicks?: number
}

/**
 * The pids in process group `pgid` that belong to the attempt.
 *
 * `rebooted` first, and it settles the question: a machine that booted after the attempt started
 * runs nothing of the attempt's, and on it EVERY process started after the attempt -- so the
 * start-time evidence below would claim any shell job that happens to lead a group of the stored
 * id. Without a reboot a reused id can only lead a group after the attempt's own leader died, which
 * needs the pid counter to wrap within the attempt's lifetime. `unreadable` when `/proc` (or its
 * boot time) cannot be read -- not Linux, or a restricted mount.
 */
export function scanAttemptGroup(input: AttemptGroupInput): AttemptGroupScan {
  const procRoot = input.procRoot ?? '/proc'
  let entries: string[]
  let boot: number | null
  try {
    entries = readdirSync(procRoot).filter((name) => /^\d+$/u.test(name))
    boot = bootTimeMs(procRoot)
  } catch {
    return { kind: 'unreadable' }
  }
  if (boot === null) return { kind: 'unreadable' }
  if (boot > input.startedAt.getTime()) return { kind: 'rebooted' }
  const ticks = input.clockTicks ?? clockTicksPerSecond()
  const dir = input.worktreePath === null ? null : resolve(input.worktreePath)
  const pids: number[] = []
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
    const startedSince = boot + (stat.startTicks / ticks) * 1000 >= input.startedAt.getTime() - START_SLACK_MS
    if (inCheckout || startedSince) pids.push(Number(pid))
  }
  return { kind: 'members', pids }
}

/** {@link scanAttemptGroup} as a list: `null` when unreadable, empty after a reboot. */
export function attemptGroupMembers(input: AttemptGroupInput): readonly number[] | null {
  const scan = scanAttemptGroup(input)
  return scan.kind === 'unreadable' ? null : scan.kind === 'rebooted' ? [] : scan.pids
}

/**
 * How a settle's kill went: `done` (no proven member is left), `survivors` (some outlived three
 * rounds), `rebooted` or `no_proc` (nothing was killed, and the settle's reason says why).
 */
export type AttemptGroupKill = 'done' | 'survivors' | 'rebooted' | 'no_proc'

/**
 * SIGKILLs each proven member of the attempt's group, one pid at a time -- never `kill(-pgid)`,
 * which would also reach any member the scan could NOT tie to the attempt. Up to three rounds,
 * each on a fresh scan (children forked meanwhile), then one last scan for the answer.
 */
export function killAttemptGroup(input: AttemptGroupInput, kill: (pid: number) => void = defaultKill): AttemptGroupKill {
  for (let round = 0; round <= 3; round += 1) {
    const scan = scanAttemptGroup(input)
    if (scan.kind === 'unreadable') return round === 0 ? 'no_proc' : 'survivors'
    if (scan.kind === 'rebooted') return 'rebooted'
    if (scan.pids.length === 0) return 'done'
    if (round === 3) return 'survivors'
    for (const pid of scan.pids) kill(pid)
  }
  return 'survivors'
}

function defaultKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}
