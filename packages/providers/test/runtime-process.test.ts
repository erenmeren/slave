import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildChildEnv, isAlive, signalRun, terminateChild } from '../src/runtime/process.js'

function spawnSleeper() {
  return spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
}

describe('terminateChild (characterization)', () => {
  it('returns promptly for a child that already exited', async () => {
    const child = spawn('node', ['-e', 'process.exit(0)'], { stdio: 'ignore' })
    await new Promise((res) => child.once('exit', res))
    await terminateChild(child, 5_000) // must not wait out the grace for a corpse
    expect(child.exitCode).toBe(0)
  })

  it('SIGTERMs a live child and resolves once it is gone', async () => {
    const child = spawnSleeper()
    await new Promise((res) => child.once('spawn', res))
    await terminateChild(child, 2_000)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })

  it('escalates to SIGKILL past the grace for a SIGTERM-ignorer', async () => {
    // `spawn` fires once the OS process exists, not once the child's JS has run -- signalling
    // immediately races the child's own `process.on('SIGTERM', ...)` call, and losing that race
    // makes the child die of the default SIGTERM action instead of ignoring it. The child reports
    // 'ready' on stdout only after its handler is actually registered, so waiting for that (rather
    // than the 'spawn' event) is what makes this an ignorer instead of a coin flip.
    const child = spawn(
      'node',
      ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    await new Promise((res) => child.stdout?.once('data', res))
    await terminateChild(child, 200)
    expect(child.signalCode).toBe('SIGKILL')
  }, 10_000)
})

describe('signalRun / isAlive (characterization)', () => {
  it('a null pid signals nothing and reports not alive', () => {
    expect(signalRun(null, 'SIGTERM')).toBe(false)
    expect(isAlive(null)).toBe(false)
  })
  it('a live pid is alive and signalable; after the kill it is neither', async () => {
    const child = spawnSleeper()
    await new Promise((res) => child.once('spawn', res))
    expect(isAlive(child.pid ?? null)).toBe(true)
    expect(signalRun(child.pid ?? null, 'SIGKILL')).toBe(true)
    await new Promise((res) => child.once('exit', res))
    expect(isAlive(child.pid ?? null)).toBe(false)
  })
})

describe('buildChildEnv (characterization)', () => {
  it('carries the git identity (author + committer) and the pause-flag path', () => {
    const env = buildChildEnv({
      gitIdentity: { name: 'AI Worker', email: 'worker@example.com' },
      pauseFlagPath: '/tmp/x/pause.flag',
    })
    expect(env['AITEAMOS_PAUSE_FLAG']).toBe('/tmp/x/pause.flag')
    // process.ts:120-123 -- author and committer both, not just author.
    expect(env['GIT_AUTHOR_NAME']).toBe('AI Worker')
    expect(env['GIT_AUTHOR_EMAIL']).toBe('worker@example.com')
    expect(env['GIT_COMMITTER_NAME']).toBe('AI Worker')
    expect(env['GIT_COMMITTER_EMAIL']).toBe('worker@example.com')
  })

  it('inherits the current process env underneath the overrides (process.ts:119)', () => {
    process.env['AITEAMOS_TEST_PROBE'] = 'inherited'
    try {
      const env = buildChildEnv({
        gitIdentity: { name: 'AI Worker', email: 'worker@example.com' },
        pauseFlagPath: '/tmp/x/pause.flag',
      })
      expect(env['AITEAMOS_TEST_PROBE']).toBe('inherited')
    } finally {
      delete process.env['AITEAMOS_TEST_PROBE']
    }
  })
})
