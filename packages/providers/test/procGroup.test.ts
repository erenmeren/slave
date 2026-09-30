import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { attemptGroupMembers, killAttemptGroup, scanAttemptGroup, signalAttemptGroup } from '../src/runtime/procGroup.js'
import { isAlive } from '../src/runtime/process.js'

/**
 * Skeleton plan B, Task 3 fix ruling 1: a stranded smoke's settler kills only the processes it can
 * tie to the attempt -- by a working directory inside the checkout, or a start no earlier than the
 * attempt's, and nothing on a machine rebooted since -- never a stored pid's group on its word alone.
 */
const dirs: string[] = []
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterAll((): void => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

const BOOT_S = 1_000_000
const TICKS = 100

/** A fake `/proc` with a boot time and the given processes (`comm` holds a space and a paren, as real ones can). */
function fakeProc(
  processes: readonly { readonly pid: number; readonly pgid: number; readonly startedAtMs: number; readonly cwd: string; readonly state?: string }[],
  bootS: number = BOOT_S,
): string {
  const root = tempDir('fake-proc-')
  writeFileSync(join(root, 'stat'), `cpu  1 2 3\nbtime ${String(bootS)}\nprocesses 9\n`)
  for (const proc of processes) {
    const dir = join(root, String(proc.pid))
    mkdirSync(dir)
    const ticks = Math.round(((proc.startedAtMs - bootS * 1000) / 1000) * TICKS)
    // Fields 3..22: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itreal starttime
    const rest = [proc.state ?? 'S', 1, proc.pgid, proc.pgid, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, ticks, 1234, 56].join(' ')
    writeFileSync(join(dir, 'stat'), `${String(proc.pid)} (odd name) x) ${rest}\n`)
    symlinkSync(proc.cwd, join(dir, 'cwd'))
  }
  return root
}

describe('attemptGroupMembers', () => {
  const attemptStart = (BOOT_S + 5000) * 1000
  const worktree = '/repo/.slaveofai-worktrees/verify-smoke-abcd1234'

  it('claims nothing after a reboot: a pid reused by a newer shell job, cwd elsewhere, is left alone', (): void => {
    // The machine booted an hour after the attempt started; the stored id now leads someone's job.
    const bootS = BOOT_S + 5000 + 3600
    const procRoot = fakeProc(
      [
        { pid: 4242, pgid: 4242, startedAtMs: (bootS + 60) * 1000, cwd: '/home/someone' },
        { pid: 4243, pgid: 4242, startedAtMs: (bootS + 61) * 1000, cwd: worktree }, // even a cwd match proves nothing now
      ],
      bootS,
    )
    const input = { pgid: 4242, worktreePath: worktree, startedAt: new Date(attemptStart), procRoot, clockTicks: TICKS }
    expect(scanAttemptGroup(input)).toEqual({ kind: 'rebooted' })
    expect(attemptGroupMembers(input)).toEqual([])
    const killed: number[] = []
    expect(killAttemptGroup(input, (pid) => killed.push(pid))).toBe('rebooted')
    expect(killed).toEqual([])
  })

  it('reports members that outlive every kill round as survivors', (): void => {
    const procRoot = fakeProc([{ pid: 300, pgid: 300, startedAtMs: attemptStart + 2000, cwd: worktree }])
    const killed: number[] = []
    expect(killAttemptGroup({ pgid: 300, worktreePath: worktree, startedAt: new Date(attemptStart), procRoot, clockTicks: TICKS }, (pid) => killed.push(pid))).toBe('survivors')
    expect(killed).toEqual([300, 300, 300])
  })

  it('claims members by checkout cwd or by a start since the attempt, and nothing outside the group', (): void => {
    const procRoot = fakeProc([
      { pid: 100, pgid: 100, startedAtMs: attemptStart - 3_600_000, cwd: `${worktree}/api` }, // old but inside the checkout
      { pid: 101, pgid: 100, startedAtMs: attemptStart + 2000, cwd: '/tmp' }, // started since the attempt
      { pid: 102, pgid: 100, startedAtMs: attemptStart - 3_600_000, cwd: '/home/someone' }, // neither
      { pid: 103, pgid: 555, startedAtMs: attemptStart + 2000, cwd: worktree }, // another group
      { pid: 104, pgid: 100, startedAtMs: attemptStart + 2000, cwd: worktree, state: 'Z' }, // already dead
      { pid: 105, pgid: 100, startedAtMs: attemptStart - 3_600_000, cwd: `${worktree}-other` }, // a sibling path, not inside
    ])
    expect(attemptGroupMembers({ pgid: 100, worktreePath: worktree, startedAt: new Date(attemptStart), procRoot, clockTicks: TICKS })).toEqual([100, 101])
  })

  it('reads nothing and kills nothing without a /proc', (): void => {
    const input = { pgid: 1, worktreePath: null, startedAt: new Date(), procRoot: join(tmpdir(), 'no-such-proc-root'), clockTicks: TICKS }
    expect(attemptGroupMembers(input)).toBeNull()
    const killed: number[] = []
    expect(killAttemptGroup(input, (pid) => killed.push(pid))).toBe('no_proc')
    expect(killed).toEqual([])
  })

  it.runIf(existsSync('/proc/self/stat'))('kills a surviving member whose cwd is in the checkout after its leader died (real /proc)', async (): Promise<void> => {
    const worktreePath = tempDir('verify-smoke-')
    const startedAt = new Date(Date.now() - 60_000) // Old enough that only the cwd can prove it.
    const leader = spawn('/bin/sh', ['-c', 'sleep 60 >/dev/null 2>&1 & echo $!'], { cwd: worktreePath, detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    leader.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    await new Promise<void>((res) => leader.on('exit', () => res()))
    await new Promise<void>((res) => leader.stdout.on('close', () => res()))
    const survivor = Number(out.trim())
    const pgid = leader.pid as number
    try {
      expect(isAlive(pgid)).toBe(false)
      expect(isAlive(survivor)).toBe(true)
      expect(attemptGroupMembers({ pgid, worktreePath, startedAt: new Date(Date.now() + 3_600_000) })).toEqual([survivor])
      expect(killAttemptGroup({ pgid, worktreePath, startedAt })).toBe('done')
      for (let i = 0; i < 50 && isAlive(survivor); i += 1) await new Promise((res) => setTimeout(res, 20))
      expect(isAlive(survivor)).toBe(false)
    } finally {
      try {
        process.kill(survivor, 'SIGKILL')
      } catch {
        // Gone, as it should be.
      }
    }
  }, 15_000)
})

describe('signalAttemptGroup (Task 4 fix ruling 1: abandon)', () => {
  const attemptStart = (BOOT_S + 5000) * 1000
  const worktree = '/repo/.slaveofai-worktrees/verify-smoke-abcd1234'

  it('signals nothing on a machine booted after the attempt, even a process started since it', (): void => {
    const bootS = BOOT_S + 5000 + 3600
    const procRoot = fakeProc([{ pid: 4242, pgid: 4242, startedAtMs: (bootS + 60) * 1000, cwd: '/home/someone' }], bootS)
    const sent: number[] = []
    const scan = signalAttemptGroup({ pgid: 4242, worktreePath: worktree, startedAt: new Date(attemptStart), procRoot, clockTicks: TICKS }, 'SIGTERM', (pid) => sent.push(pid))
    expect(scan).toEqual({ kind: 'rebooted' })
    expect(sent).toEqual([])
  })

  it('signals nothing without a /proc', (): void => {
    const sent: number[] = []
    const input = { pgid: 1, worktreePath: null, startedAt: new Date(), procRoot: join(tmpdir(), 'no-such-proc-root'), clockTicks: TICKS }
    expect(signalAttemptGroup(input, 'SIGTERM', (pid) => sent.push(pid))).toEqual({ kind: 'unreadable' })
    expect(sent).toEqual([])
  })

  it('signals only the proven members, each with the given signal', (): void => {
    const procRoot = fakeProc([
      { pid: 100, pgid: 100, startedAtMs: attemptStart + 2000, cwd: worktree },
      { pid: 102, pgid: 100, startedAtMs: attemptStart - 3_600_000, cwd: '/home/someone' },
    ])
    const sent: (readonly [number, string])[] = []
    signalAttemptGroup({ pgid: 100, worktreePath: worktree, startedAt: new Date(attemptStart), procRoot, clockTicks: TICKS }, 'SIGTERM', (pid, signal) => sent.push([pid, signal]))
    expect(sent).toEqual([[100, 'SIGTERM']])
  })

  it.runIf(existsSync('/proc/self/stat'))('SIGTERMs a live member whose cwd is in the checkout (real /proc)', async (): Promise<void> => {
    const worktreePath = tempDir('verify-smoke-')
    const child = spawn('sleep', ['60'], { cwd: worktreePath, detached: true, stdio: 'ignore' })
    const pid = child.pid as number
    const exited = new Promise<NodeJS.Signals | null>((res) => child.on('exit', (_code, signal) => res(signal)))
    try {
      // Started "before" the attempt, so only the cwd proves it.
      const scan = signalAttemptGroup({ pgid: pid, worktreePath, startedAt: new Date(Date.now() + 3_600_000) }, 'SIGTERM')
      expect(scan).toEqual({ kind: 'members', pids: [pid] })
      expect(await exited).toBe('SIGTERM')
    } finally {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Gone, as it should be.
      }
    }
  }, 15_000)
})
