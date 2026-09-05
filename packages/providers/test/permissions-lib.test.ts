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
// TEST_DEFAULT_TOOL threads `runVerdict`'s optional `defaultTool` argument through to
// `read_permission_verdict`'s own optional second positional argument (M18 Task 4) -- unset (the
// common case) leaves it `${2:-}`-defaulted to empty, exactly as an un-passed argument would.
const DRIVER_SCRIPT = `#!/usr/bin/env bash
set -uo pipefail
PAUSE_GATE_NAME='test-gate'
. "$PERMISSIONS_LIB_PATH"
payload=$(cat)
read_permission_verdict "$payload" "\${TEST_DEFAULT_TOOL:-}"
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

function runVerdict(
  payload: string,
  permissionsFile: string | undefined,
  defaultTool?: string,
): Promise<VerdictResult> {
  const dir = makeTmpDir('slaveofai-permissions-lib-driver-')
  const driverPath = path.join(dir, 'driver.sh')
  writeFileSync(driverPath, DRIVER_SCRIPT)

  const env: Record<string, string | undefined> = { ...process.env, PERMISSIONS_LIB_PATH: libPath }
  if (permissionsFile === undefined) {
    delete env['SLAVEOFAI_PERMISSIONS_FILE']
  } else {
    env['SLAVEOFAI_PERMISSIONS_FILE'] = permissionsFile
  }
  if (defaultTool === undefined) {
    delete env['TEST_DEFAULT_TOOL']
  } else {
    env['TEST_DEFAULT_TOOL'] = defaultTool
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
        tool: toolMatch?.[1] ?? '',
        capability: capabilityMatch?.[1] ?? '',
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
    const dir = makeTmpDir('slaveofai-permissions-lib-file-')
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

  // M18 Task 4: the optional second argument. Cursor's `beforeShellExecution` payload (measured,
  // packages/providers/test/fixtures/cursor/gate/run-1-hook.log line 5) carries a top-level
  // `command` string and no `tool_name` at all -- this is the shape `default_tool` exists for.
  describe('default_tool (Cursor beforeShellExecution accommodation)', () => {
    it('denies via default_tool when the payload has a command string but no tool_name', async () => {
      const file = writePermissionsFile('{"version":1,"deny":[{"tool":"shell","capability":"run tests"}]}')
      const result = await runVerdict('{"command":"echo hi","cwd":"/tmp"}', file, 'shell')
      expect(result.code).toBe(0)
      expect(result.status).toBe(0)
      expect(result.tool).toBe('shell')
      expect(result.capability).toBe('run tests')
    })

    it('allows via default_tool when the payload command-shaped tool is not on the deny list', async () => {
      const file = writePermissionsFile('{"version":1,"deny":[{"tool":"edit","capability":"source write"}]}')
      const result = await runVerdict('{"command":"echo hi"}', file, 'shell')
      expect(result.code).toBe(0)
      expect(result.status).toBe(1)
    })

    it('prefers tool_name over default_tool when the payload carries both', async () => {
      // Not a real Cursor shape (a fixture-measured payload never carries both), but pins the
      // precedence explicitly: tool_name is read directly from the hook and must win over a
      // caller-supplied fallback whenever it is present.
      const file = writePermissionsFile('{"version":1,"deny":[{"tool":"shell","capability":"run tests"}]}')
      const result = await runVerdict('{"tool_name":"Read","command":"echo hi"}', file, 'shell')
      expect(result.code).toBe(0)
      expect(result.status).toBe(1) // "Read" is not on the deny list -- default_tool never substitutes
    })

    it('does not substitute default_tool when the payload has neither tool_name nor a command string', async () => {
      // The shape guard: default_tool applies ONLY to the beforeShellExecution shape (a `command`
      // string, no `tool_name`). A payload that merely lacks tool_name for some other reason --
      // Claude's own Stop/SessionStart hooks, say -- must keep allowing exactly as it did before
      // this argument existed, never get silently reattributed to the fallback tool.
      const file = writePermissionsFile('{"version":1,"deny":[{"tool":"shell","capability":"run tests"}]}')
      const result = await runVerdict('{"hook_event_name":"SessionStart"}', file, 'shell')
      expect(result.code).toBe(0)
      expect(result.status).toBe(1)
    })

    it('does not substitute default_tool when the command key is present but not a string', async () => {
      const file = writePermissionsFile('{"version":1,"deny":[{"tool":"shell","capability":"run tests"}]}')
      const result = await runVerdict('{"command":123}', file, 'shell')
      expect(result.code).toBe(0)
      expect(result.status).toBe(1)
    })

    it('leaves behavior unchanged when default_tool is omitted, even for a command-shaped payload', async () => {
      const file = writePermissionsFile('{"version":1,"deny":[{"tool":"shell","capability":"run tests"}]}')
      const result = await runVerdict('{"command":"echo hi"}', file)
      expect(result.code).toBe(0)
      expect(result.status).toBe(1)
    })
  })

  it('allows when SLAVEOFAI_PERMISSIONS_FILE is unset -- no matrix in play', async () => {
    const result = await runVerdict('{"tool_name":"Bash"}', undefined)
    expect(result.code).toBe(0)
    expect(result.status).toBe(1)
  })

  it('allows when the permissions file path does not exist', async () => {
    const dir = makeTmpDir('slaveofai-permissions-lib-missing-')
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

  // Security-review Important finding (post-landing): `JSON.parse("null")` succeeds, so a
  // literal `null` payload slipped past the BADPAYLOAD try/catch and the next line's
  // `payload.tool_name` threw an uncaught TypeError -- a raw node stack trace on stderr, failing
  // closed only incidentally (node exit 1 landing in the generic `*)` arm). `null` IS valid JSON
  // and names no tool, so the correct verdict is a clean ALLOW, not BADPAYLOAD and not a crash.
  it('allows cleanly, with no stderr, when the payload is the literal JSON null', async () => {
    const file = writePermissionsFile('{"version":1,"deny":[{"tool":"Bash","capability":"run tests"}]}')
    const result = await runVerdict('null', file)
    expect(result.code).toBe(0)
    expect(result.status).toBe(1)
    expect(result.tool).toBe('')
    expect(result.capability).toBe('')
    expect(result.stderr).toBe('')
  })

  // The brief's own checklist named this alongside `null` ("valid JSON but not an object"); a
  // bare array has no `.tool_name` either but was already safe pre-fix (`typeof undefined ===
  // "string"` is false, no throw) -- kept as a cheap companion case so the class of input stays
  // covered, not just the one member that used to crash.
  it('allows cleanly when the payload is valid JSON but not an object (an array)', async () => {
    const file = writePermissionsFile('{"version":1,"deny":[{"tool":"Bash","capability":"run tests"}]}')
    const result = await runVerdict('[1]', file)
    expect(result.code).toBe(0)
    expect(result.status).toBe(1)
    expect(result.stderr).toBe('')
  })
})
