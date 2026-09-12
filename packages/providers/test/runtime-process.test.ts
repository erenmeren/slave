import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CHILD_ENV_ALLOW,
  brokerChannelPathFor,
  brokerReplyPathFor,
  buildChildEnv,
  isAlive,
  runTokenHash,
  signalRun,
  terminateChild,
} from '../src/runtime/process.js'

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

describe('buildChildEnv (M52 R3: an allow list, never an inheritance)', () => {
  const base = {
    gitIdentity: { name: 'AI Worker', email: 'worker@example.com' },
    pauseFlagPath: '/tmp/x/pause.flag',
    permissionsFilePath: '/tmp/x/permissions.json',
    runId: 'run-1',
    runToken: 'f'.repeat(64),
    brokerChannelPath: '/tmp/x/broker.ndjson',
  }

  // M18 Task 5 grew this from the git identity and the pause flag to the permissions file; M52 R4
  // grows it again, by the run this child IS and the channel it can ask through. Same case, same
  // shape: everything `buildChildEnv` is TOLD reaches the child.
  it('carries the git identity (author + committer), the pause-flag path, and the permissions-file path', () => {
    const env = buildChildEnv(base)
    expect(env['SLAVEOFAI_PAUSE_FLAG']).toBe('/tmp/x/pause.flag')
    // M18 Task 5 -- SLAVEOFAI_PERMISSIONS_FILE, the ONE channel the gates read the verdict's path
    // on, the same shape of channel SLAVEOFAI_PAUSE_FLAG already is.
    expect(env['SLAVEOFAI_PERMISSIONS_FILE']).toBe('/tmp/x/permissions.json')
    expect(env['SLAVEOFAI_RUN_ID']).toBe('run-1')
    expect(env['SLAVEOFAI_RUN_TOKEN']).toBe('f'.repeat(64))
    expect(env['SLAVEOFAI_BROKER_CHANNEL']).toBe('/tmp/x/broker.ndjson')
    // process.ts -- author and committer both, not just author.
    expect(env['GIT_AUTHOR_NAME']).toBe('AI Worker')
    expect(env['GIT_AUTHOR_EMAIL']).toBe('worker@example.com')
    expect(env['GIT_COMMITTER_NAME']).toBe('AI Worker')
    expect(env['GIT_COMMITTER_EMAIL']).toBe('worker@example.com')
  })

  // THE SENTENCE THIS TEST USED TO ASSERT, REVERSED. It characterized `...process.env` --
  // "inherits the current process env underneath the overrides" -- which is exactly what M52 R3
  // deletes. Kept in place, with its meaning inverted, so the diff reads as the inversion it is.
  it('does NOT inherit the current process env -- the sentence this test used to assert', () => {
    process.env['SLAVEOFAI_TEST_PROBE'] = 'inherited'
    try {
      expect('SLAVEOFAI_TEST_PROBE' in buildChildEnv(base)).toBe(false)
    } finally {
      delete process.env['SLAVEOFAI_TEST_PROBE']
    }
  })

  it('carries none of the four secrets a worker must never hold', () => {
    process.env['DATABASE_URL'] = 'postgres://u:p@localhost:5433/db'
    process.env['SLAVEOFAI_SESSION_SECRET'] = 'secret'
    process.env['SLAVEOFAI_PASSWORD'] = 'hunter2'
    process.env['FAKE_DEPLOY_TOKEN'] = 'tok'
    const names = ['DATABASE_URL', 'SLAVEOFAI_SESSION_SECRET', 'SLAVEOFAI_PASSWORD', 'FAKE_DEPLOY_TOKEN']
    try {
      const env = buildChildEnv(base)
      for (const name of names) {
        expect(name in env, name).toBe(false)
      }
    } finally {
      for (const name of names) {
        delete process.env[name]
      }
    }
  })

  it('passes through exactly the CHILD_ENV_ALLOW names that are actually set, and invents none', () => {
    const previousPath = process.env['PATH']
    const previousLcAll = process.env['LC_ALL']
    const previousCache = process.env['XDG_CACHE_HOME']
    try {
      process.env['PATH'] = '/usr/bin'
      process.env['LC_ALL'] = 'C'
      const env = buildChildEnv(base)
      expect(env['PATH']).toBe('/usr/bin')
      expect(env['LC_ALL']).toBe('C')
      // A name on the list that the parent does not have is ABSENT, never empty: an empty PATH is a
      // child that cannot find `git`, and it would look like a configuration rather than a gap.
      delete process.env['XDG_CACHE_HOME']
      expect('XDG_CACHE_HOME' in buildChildEnv(base)).toBe(false)
    } finally {
      if (previousPath === undefined) delete process.env['PATH']
      else process.env['PATH'] = previousPath
      if (previousLcAll === undefined) delete process.env['LC_ALL']
      else process.env['LC_ALL'] = previousLcAll
      if (previousCache === undefined) delete process.env['XDG_CACHE_HOME']
      else process.env['XDG_CACHE_HOME'] = previousCache
    }
  })

  it('is an explicit NAME list -- never a prefix rule and never a denylist', () => {
    process.env['SLAVEOFAI_SOMETHING_NEW'] = 'x'
    try {
      expect('SLAVEOFAI_SOMETHING_NEW' in buildChildEnv(base)).toBe(false)
    } finally {
      delete process.env['SLAVEOFAI_SOMETHING_NEW']
    }
    // And the list itself is names, not patterns: nothing in it ends in a wildcard, and every
    // entry is a legal environment-variable name.
    for (const name of CHILD_ENV_ALLOW) {
      expect(name, name).toMatch(/^[A-Z][A-Z0-9_]*$/u)
    }
  })

  it('leaves the token, the id and the channel ABSENT when they are not supplied', () => {
    const env = buildChildEnv({
      gitIdentity: base.gitIdentity,
      pauseFlagPath: base.pauseFlagPath,
      permissionsFilePath: base.permissionsFilePath,
    })
    expect('SLAVEOFAI_RUN_ID' in env).toBe(false)
    expect('SLAVEOFAI_RUN_TOKEN' in env).toBe(false)
    expect('SLAVEOFAI_BROKER_CHANNEL' in env).toBe(false)
    expect('SLAVEOFAI_BROKER_CLI' in env).toBe(false)
  })

  it('carries the broker CLI path when the adapter has one (M52 erratum E6)', () => {
    const env = buildChildEnv({ ...base, brokerCliPath: '/opt/slaveofai/dist/cli.js' })
    expect(env['SLAVEOFAI_BROKER_CLI']).toBe('/opt/slaveofai/dist/cli.js')
  })
})

describe('the run directory\u2019s file channels (M52 R3/R4)', () => {
  it('puts the broker channel and one reply beside permissions.json, inside runDir', () => {
    expect(brokerChannelPathFor('/tmp/x')).toBe('/tmp/x/broker.ndjson')
    expect(brokerReplyPathFor('/tmp/x', 'a'.repeat(32))).toBe(`/tmp/x/broker-${'a'.repeat(32)}.json`)
  })

  it('refuses a request id that is not 32 lowercase hex characters -- the filename IS the id', () => {
    for (const bad of ['', '../escape', 'A'.repeat(32), 'a'.repeat(31), `${'a'.repeat(32)}/x`]) {
      expect(() => brokerReplyPathFor('/tmp/x', bad), JSON.stringify(bad)).toThrow(/bad request id/u)
    }
  })

  it('hashes a run token with sha256, which is what the file and the row both carry', () => {
    expect(runTokenHash('f'.repeat(64))).toBe(createHash('sha256').update('f'.repeat(64)).digest('hex'))
    expect(runTokenHash('f'.repeat(64))).toHaveLength(64)
  })
})

describe('buildChildEnv and the tool-result tap (M51 R6)', () => {
  it('sets SLAVEOFAI_TOOL_RESULTS when a path is given', () => {
    const env = buildChildEnv({
      gitIdentity: { name: 'AI Worker', email: 'worker@example.com' },
      pauseFlagPath: '/tmp/x/pause.flag',
      permissionsFilePath: '/tmp/x/permissions.json',
      toolResultsPath: '/tmp/x/tool-results.ndjson',
    })
    expect(env['SLAVEOFAI_TOOL_RESULTS']).toBe('/tmp/x/tool-results.ndjson')
  })

  it('leaves the key ABSENT when none is given -- "this run is not tapped" is silence', () => {
    const env = buildChildEnv({
      gitIdentity: { name: 'AI Worker', email: 'worker@example.com' },
      pauseFlagPath: '/tmp/x/pause.flag',
      permissionsFilePath: '/tmp/x/permissions.json',
    })
    // Absent, not present-and-empty: the tap reads an empty value as "unset" too, but a key that
    // is there with nothing in it would be a registration of nothing, exactly as an empty
    // `PostToolUse` array would be in the settings file.
    expect('SLAVEOFAI_TOOL_RESULTS' in env).toBe(false)
  })
})
