import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const libPath = path.join(repoRoot, 'scripts/lib/permissions.sh')

// A tiny driver, cribbed from pause-gate.test.ts's `runHook` pattern: `read_permission_verdict`
// is a sourced shell FUNCTION, not a script, so there is nothing to spawn directly -- this file
// sources the library the way both gates do (PAUSE_GATE_NAME set first, matching
// pause-flag.sh's convention that stderr is attributed to a caller name) and echoes the verdict
// plus both out-params, report-don't-print: the library itself only sets variables and
// returns/exits a status, and this driver is the one thing here that "prints".
//
// The payload travels on STDIN, never argv -- the same rationale pause-flag.sh's `json_string`
// documents against option-injection (an operator-influenced string beginning with `-` must not
// be parsed by anything as a flag), preserved here since `read_permission_verdict` passes its
// own `$1` straight into a `node` invocation the same way.
const DRIVER_SCRIPT = `#!/usr/bin/env bash
set -uo pipefail
PAUSE_GATE_NAME='test-gate'
. "$PERMISSIONS_LIB_PATH"
payload=$(cat)
read_permission_verdict "$payload"
status=$?
printf 'STATUS=%s\\n' "$status"
printf 'TOOL=%s\\n' "$PERMISSION_DENY_TOOL"
printf 'CAPABILITY=%s\\n' "$PERMISSION_DENY_CAPABILITY"
`

interface VerdictResult {
  readonly status: number | null // the driver's own STATUS= line: 0 (deny) or 1 (allow); null when the process exited 2 before printing it
  readonly tool: string
  readonly capability: string
  readonly code: number | null // the bash process's own exit code -- 2 on fail-closed
  readonly stderr: string
}

// Tracked here and removed in afterEach, package convention (pause-gate.test.ts does the same
// with its per-test flag directories).
const tmpDirs: string[] = []

function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function runVerdict(payload: string, permissionsFile: string | undefined): Promise<VerdictResult> {
  const dir = makeTmpDir('aiteamos-permissions-lib-driver-')
  const driverPath = path.join(dir, 'driver.sh')
  writeFileSync(driverPath, DRIVER_SCRIPT)

  const env: Record<string, string | undefined> = { ...process.env, PERMISSIONS_LIB_PATH: libPath }
  if (permissionsFile === undefined) {
    delete env['AITEAMOS_PERMISSIONS_FILE']
  } else {
    env['AITEAMOS_PERMISSIONS_FILE'] = permissionsFile
  }

  return new Promise((resolve, reject) => {
    const child = spawn('bash', [driverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.once('error', fail)
    child.once('close', (code: number | null) => {
      if (settled) return
      settled = true
      const statusMatch = /^STATUS=(\d+)$/m.exec(stdout)
      const toolMatch = /^TOOL=(.*)$/m.exec(stdout)
      const capabilityMatch = /^CAPABILITY=(.*)$/m.exec(stdout)
      resolve({
        status: statusMatch ? Number(statusMatch[1]) : null,
        tool: toolMatch ? toolMatch[1] : '',
        capability: capabilityMatch ? capabilityMatch[1] : '',
        code,
        stderr,
      })
    })

    child.stdin.write(payload)
    child.stdin.end()
  })
}

describe('scripts/lib/permissions.sh: read_permission_verdict', () => {
  afterEach(() => {
    while (tmpDirs.length > 0) {
      const dir = tmpDirs.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  function writePermissionsFile(content: string): string {
    const dir = makeTmpDir('aiteamos-permissions-lib-file-')
    const filePath = path.join(dir, 'permissions.json')
    writeFileSync(filePath, content)
    return filePath
  }

  it('denies and reports the matched tool + capability when the deny list has a hit', async () => {
    const file = writePermissionsFile('{"version":1,"deny":[{"tool":"Bash","capability":"run tests"}]}')
    const result = await runVerdict('{"tool_name":"Bash"}', file)
    expect(result.code).toBe(0)
    expect(result.status).toBe(0)
    expect(result.tool).toBe('Bash')
    expect(result.capability).toBe('run tests')
  })

  it('allows when the payload tool is present but not on the deny list', async () => {
    const file = writePermissionsFile('{"version":1,"deny":[{"tool":"Bash","capability":"run tests"}]}')
    const result = await runVerdict('{"tool_name":"Read"}', file)
    expect(result.code).toBe(0)
    expect(result.status).toBe(1)
    expect(result.tool).toBe('')
    expect(result.capability).toBe('')
  })

  it('allows when the payload has no tool_name key at all', async () => {
    const file = writePermissionsFile('{"version":1,"deny":[{"tool":"Bash","capability":"run tests"}]}')
    const result = await runVerdict('{"hook_event_name":"SessionStart"}', file)
    expect(result.code).toBe(0)
    expect(result.status).toBe(1)
  })

  it('allows when AITEAMOS_PERMISSIONS_FILE is unset -- no matrix in play', async () => {
    const result = await runVerdict('{"tool_name":"Bash"}', undefined)
    expect(result.code).toBe(0)
    expect(result.status).toBe(1)
  })

  it('allows when the permissions file path does not exist', async () => {
    const dir = makeTmpDir('aiteamos-permissions-lib-missing-')
    const missing = path.join(dir, 'nonexistent-permissions.json')
    const result = await runVerdict('{"tool_name":"Bash"}', missing)
    expect(result.code).toBe(0)
    expect(result.status).toBe(1)
  })

  it('fails closed (exit 2) when the permissions file exists but is not valid JSON', async () => {
    const file = writePermissionsFile('{not valid json')
    const result = await runVerdict('{"tool_name":"Bash"}', file)
    expect(result.code).toBe(2)
    expect(result.status).toBe(null) // exit 2 fires before the driver's first printf
    expect(result.stderr).toContain('permissions file unreadable or malformed')
    expect(result.stderr).toContain(file)
  })

  it('fails closed (exit 2) when the hook payload is not valid JSON while a permissions file is armed', async () => {
    const file = writePermissionsFile('{"version":1,"deny":[{"tool":"Bash","capability":"run tests"}]}')
    const result = await runVerdict('not json at all', file)
    expect(result.code).toBe(2)
    expect(result.status).toBe(null)
    expect(result.stderr).toContain('hook payload did not parse as JSON')
  })

  it('allows when the deny list is present but empty', async () => {
    const file = writePermissionsFile('{"version":1,"deny":[]}')
    const result = await runVerdict('{"tool_name":"Bash"}', file)
    expect(result.code).toBe(0)
    expect(result.status).toBe(1)
  })
})
