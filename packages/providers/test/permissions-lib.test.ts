import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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
//
// M52 R4 adds one more passthrough and it is an ENVIRONMENT variable, not an argument:
// `SLAVEOFAI_RUN_TOKEN` is what `buildChildEnv` puts in a real worker's environment, and the
// library hashes it against the file's `tokenHash`. `runVerdict` sets or deletes it on the child
// exactly the way it already sets or deletes `SLAVEOFAI_PERMISSIONS_FILE`, so a test can spawn a
// child that is the run the verdict is about, a child that is a DIFFERENT run, or a child that
// carries no identity at all.
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

/**
 * The plaintext run token every case spawns with unless it says otherwise, and the sha256 the
 * file carries.
 *
 * `TOKEN_HASH` is spelled here with `createHash` rather than pasted as a hex literal so the
 * fixture stays readable, and computed from `node:crypto` rather than imported from the code under
 * test so the assertion is about sha256 and not about whatever this repository happens to call it.
 */
const TOKEN = 'f'.repeat(64)
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex')

/**
 * A `permissions.json` v2 body, with the defaults every case that is not about the file's shape
 * wants: this run's own `tokenHash`, `enforce: all-tools` (Claude), `Read` granted, and a
 * three-entry vocabulary. `allow` and `vocabulary` are deliberately independent -- a tool can be
 * governed and ungranted (the ordinary denial), governed and granted (the allow), or in neither
 * (`ungoverned_tool`).
 */
function v2(input: {
  allow?: readonly { readonly tool: string; readonly kind: string }[]
  vocabulary?: Readonly<Record<string, string>>
  prefixes?: readonly { readonly prefix: string; readonly kind: string }[]
  grants?: readonly string[]
  enforce?: 'all-tools' | 'known-tools'
  tokenHash?: string
}): string {
  return JSON.stringify({
    version: 2,
    runId: 'run-1',
    tokenHash: input.tokenHash ?? TOKEN_HASH,
    enforce: input.enforce ?? 'all-tools',
    grants: input.grants ?? ['read_repo'],
    allow: input.allow ?? [{ tool: 'Read', kind: 'read_repo' }],
    vocabulary: input.vocabulary ?? { Read: 'read_repo', Bash: 'run_commands', WebFetch: 'network_fetch' },
    prefixes: input.prefixes ?? [{ prefix: 'mcp__', kind: 'network_fetch' }],
  })
}

function runVerdict(
  payload: string,
  permissionsFile: string | undefined,
  defaultTool?: string,
  runToken: string = TOKEN,
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
  env['SLAVEOFAI_RUN_TOKEN'] = runToken

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

describe('scripts/lib/permissions.sh: read_permission_verdict (M52 R2: default-DENY)', () => {
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

  it('allows a tool that is ON the allow list', async () => {
    const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({})))
    expect(result.code).toBe(0)
    expect(result.status).toBe(1)
    expect(result.tool).toBe('')
    expect(result.capability).toBe('')
  })

  // MOVED, same name: this case used to assert a deny-list HIT. A governed tool that is not
  // granted is now the ordinary denial, and it names the KIND that governs it -- which is why the
  // file carries a vocabulary and not only an allow list (an allow list alone cannot say why).
  it('denies and reports the matched tool + capability when the deny list has a hit', async () => {
    const result = await runVerdict('{"tool_name":"Bash"}', writePermissionsFile(v2({})))
    expect(result.code).toBe(0)
    expect(result.status).toBe(0)
    expect(result.tool).toBe('Bash')
    expect(result.capability).toBe('run_commands')
  })

  // THE PAYLOAD DOES NOT GET TO CHOOSE THE CAPABILITY (M52 final review, Important 2). The verdict
  // the library prints is TAB-delimited and the caller splits it with `cut -f2`/`cut -f3`, so a
  // `tool_name` carrying a tab used to shift the fields: this exact payload was MEASURED returning
  // `TOOL=Bash CAPABILITY=deploy_release` -- a broker kind no vendor tool can ever produce, which
  // is how a worker would author the denial evidence a `request_permission` proposal is built on.
  it('does not let a TAB in tool_name choose the capability recorded against the worker', async () => {
    // `\\t` in the SOURCE is `\t` in the JSON, which parses to one real tab character -- a raw tab
    // inside a JSON string is not JSON at all, and this is the escape a worker would send.
    const result = await runVerdict('{"tool_name":"Bash\\tdeploy_release"}', writePermissionsFile(v2({})))

    expect(result.code).toBe(0)
    expect(result.status).toBe(0)
    // The whole finding in one line: the field a person reads as the capability is not the worker's
    // to write.
    expect(result.capability).not.toBe('deploy_release')
    // What it IS: the tab is stripped, so the name matches nothing in the vocabulary and the call
    // is denied as the ungoverned tool it is.
    expect(result.capability).toBe('ungoverned_tool')
    expect(result.tool).toBe('Bashdeploy_release')
    expect(result.tool).not.toContain('\t')
  })

  // MOVED from M18, where it was called "allows when the payload tool is present but not on the
  // deny list" -- the name is the verdict, and the verdict inverted (final review Minor 3).
  it('denies a payload tool nothing governs: default-deny has no "not on the list" arm', async () => {
    const result = await runVerdict('{"tool_name":"Sandbox"}', writePermissionsFile(v2({})))
    expect(result.code).toBe(0)
    expect(result.status).toBe(0)
    expect(result.tool).toBe('Sandbox')
    expect(result.capability).toBe('ungoverned_tool')
  })

  // MOVED from M18's "allows when the payload has no tool_name key at all" (plan erratum E8): a
  // PreToolUse payload this gate cannot read is a refused CALL, not a broken gate, so it denies at
  // exit 0 and the run survives.
  it('denies when the payload has no tool_name key at all', async () => {
    const result = await runVerdict('{"hook_event_name":"SessionStart"}', writePermissionsFile(v2({})))
    expect(result.code).toBe(0)
    expect(result.status).toBe(0)
    expect(result.tool).toBe('unknown')
    expect(result.capability).toBe('ungoverned_tool')
  })

  // M52 fix-round carry (erratum E16): `toolKindFor` resolves every `mcp__*` name through a
  // PREFIX, and a prefix is not enumerable -- `resolveGrants` puts no `mcp__` name on the allow
  // list however `network_fetch` resolves. So the gate decides by KIND: the file carries the
  // granted kind set and the prefix table, and ONE `network_fetch` grant opens every MCP tool
  // rather than two.
  describe('the mcp__ prefix (M52 erratum E16)', () => {
    it('allows any mcp__ tool when network_fetch is among the granted kinds, though no mcp name is on the allow list', async () => {
      const file = writePermissionsFile(v2({ grants: ['read_repo', 'network_fetch'] }))
      for (const tool of ['mcp__notion__search', 'mcp__gmail__send_message']) {
        const result = await runVerdict(`{"tool_name":"${tool}"}`, file)
        expect(result.code, tool).toBe(0)
        expect(result.status, tool).toBe(1)
      }
    })

    it('denies an mcp__ tool naming network_fetch when that kind was not granted', async () => {
      const result = await runVerdict('{"tool_name":"mcp__notion__search"}', writePermissionsFile(v2({})))
      expect(result.code).toBe(0)
      expect(result.status).toBe(0)
      expect(result.tool).toBe('mcp__notion__search')
      expect(result.capability).toBe('network_fetch')
    })

    it('grants the KIND, not the list: a granted kind allows a governed tool the allow list omits', async () => {
      // The allow list and the grants agree in production (one writer computes both), but the
      // decision is the kind's, and this pins which of the two the gate actually believes.
      const file = writePermissionsFile(v2({ grants: ['read_repo', 'run_commands'], allow: [] }))
      const result = await runVerdict('{"tool_name":"Bash"}', file)
      expect(result.code).toBe(0)
      expect(result.status).toBe(1)
    })
  })

  // MOVED from M18's "allows cleanly, with no stderr, when the payload is the literal JSON null".
  // `JSON.parse("null")` succeeds and names no tool; under an allow list that is a call nobody can
  // authorise.
  it('denies cleanly, with no stderr, when the payload is the literal JSON null', async () => {
    const result = await runVerdict('null', writePermissionsFile(v2({})))
    expect(result.code).toBe(0)
    expect(result.status).toBe(0)
    expect(result.tool).toBe('unknown')
    expect(result.capability).toBe('ungoverned_tool')
    expect(result.stderr).toBe('')
  })

  // MOVED from M18's "allows cleanly when the payload is valid JSON but not an object (an array)",
  // and widened to the whole class the security review named.
  it('denies cleanly when the payload is valid JSON but not an object (an array)', async () => {
    for (const payload of ['[1]', '7', '"x"']) {
      const result = await runVerdict(payload, writePermissionsFile(v2({})))
      expect(result.code, payload).toBe(0)
      expect(result.status, payload).toBe(0)
      expect(result.stderr, payload).toBe('')
    }
  })

  // MOVED from M18's "allows when the deny list is present but empty": an empty allow list is a run
  // granted nothing, which is a real state and not an unarmed gate.
  it('denies when the allow list is present but empty -- a run granted nothing', async () => {
    const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({ allow: [], grants: [] })))
    expect(result.code).toBe(0)
    expect(result.status).toBe(0)
    expect(result.tool).toBe('Read')
    expect(result.capability).toBe('read_repo')
  })

  // M18 Task 4: the optional second argument. Cursor's `beforeShellExecution` payload (measured,
  // packages/providers/test/fixtures/cursor/gate/run-1-hook.log line 5) carries a top-level
  // `command` string and no `tool_name` at all -- this is the shape `default_tool` exists for.
  // The SHAPE rule is untouched by M52; only the verdict on the other side of it inverted.
  describe('default_tool (Cursor beforeShellExecution accommodation)', () => {
    const CURSOR = {
      enforce: 'known-tools' as const,
      vocabulary: { read: 'read_repo', edit: 'write_repo', shell: 'run_commands' },
    }

    it('denies via default_tool when the payload has a command string but no tool_name', async () => {
      const file = writePermissionsFile(v2({ ...CURSOR, allow: [{ tool: 'read', kind: 'read_repo' }], grants: ['read_repo'] }))
      const result = await runVerdict('{"command":"echo hi","cwd":"/tmp"}', file, 'shell')
      expect(result.code).toBe(0)
      expect(result.status).toBe(0)
      expect(result.tool).toBe('shell')
      expect(result.capability).toBe('run_commands')
    })

    it('allows via default_tool when the payload command-shaped tool is not on the deny list', async () => {
      const file = writePermissionsFile(
        v2({ ...CURSOR, allow: [{ tool: 'shell', kind: 'run_commands' }], grants: ['run_commands'] }),
      )
      const result = await runVerdict('{"command":"echo hi"}', file, 'shell')
      expect(result.code).toBe(0)
      expect(result.status).toBe(1)
    })

    it('prefers tool_name over default_tool when the payload carries both', async () => {
      // Not a real Cursor shape (a fixture-measured payload never carries both), but pins the
      // precedence explicitly: tool_name is read directly from the hook and must win over a
      // caller-supplied fallback whenever it is present. `Read` is a Claude-shaped name Cursor's
      // vocabulary does not know, so under `known-tools` it allows -- and that is the proof the
      // fallback never substituted, because `shell` is NOT granted here and would have denied.
      const file = writePermissionsFile(v2({ ...CURSOR, allow: [], grants: [] }))
      const result = await runVerdict('{"tool_name":"Read","command":"echo hi"}', file, 'shell')
      expect(result.code).toBe(0)
      expect(result.status).toBe(1)
      expect(result.tool).toBe('')
    })

    it('does not substitute default_tool when the payload has neither tool_name nor a command string', async () => {
      // The shape guard: default_tool applies ONLY to the beforeShellExecution shape (a `command`
      // string, no `tool_name`). A payload that merely lacks tool_name for some other reason --
      // Claude's own Stop/SessionStart hooks, say -- must never be reattributed to the fallback
      // tool. Measured on the CLAUDE side, where the verdict is a deny, because that is where the
      // substitution would be visible: the reported tool is `unknown`, never `shell`.
      const file = writePermissionsFile(v2({}))
      const result = await runVerdict('{"hook_event_name":"SessionStart"}', file, 'shell')
      expect(result.code).toBe(0)
      expect(result.status).toBe(0)
      expect(result.tool).toBe('unknown')
    })

    it('does not substitute default_tool when the command key is present but not a string', async () => {
      const file = writePermissionsFile(v2({}))
      const result = await runVerdict('{"command":123}', file, 'shell')
      expect(result.code).toBe(0)
      expect(result.status).toBe(0)
      expect(result.tool).toBe('unknown')
    })

    it('leaves behavior unchanged when default_tool is omitted, even for a command-shaped payload', async () => {
      const file = writePermissionsFile(v2({}))
      const result = await runVerdict('{"command":"echo hi"}', file)
      expect(result.code).toBe(0)
      expect(result.status).toBe(0)
      expect(result.tool).toBe('unknown')
    })
  })

  // UNCHANGED, and plan erratum E1 is why: the VARIABLE unset means "this process is not a governed
  // run" -- an operator running the gate by hand, and `preflightGate`, which spawns the real hook
  // twice per spawn and requires the disarmed direction to allow.
  it('allows when SLAVEOFAI_PERMISSIONS_FILE is unset -- no matrix in play', async () => {
    const result = await runVerdict('{"tool_name":"Bash"}', undefined)
    expect(result.code).toBe(0)
    expect(result.status).toBe(1)
  })

  // MOVED from M18's "allows when the permissions file path does not exist", and the sharpest one:
  // the variable is SET and the file is gone. That used to be "no matrix in play: allow", which is
  // the self-policing hole `permissions.sh` recorded in its own header -- a run that deleted its own
  // file disarmed itself. It fails CLOSED now.
  it('fails closed (exit 2) when the permissions file path does not exist', async () => {
    const dir = makeTmpDir('slaveofai-permissions-lib-missing-')
    const missing = path.join(dir, 'nonexistent-permissions.json')
    const result = await runVerdict('{"tool_name":"Read"}', missing)
    expect(result.code).toBe(2)
    expect(result.status).toBe(null)
    expect(result.stderr).toMatch(/unreadable|missing/)
    expect(result.stderr).toContain(missing)
  })

  it('fails closed (exit 2) when the permissions file exists but is not valid JSON', async () => {
    const file = writePermissionsFile('{not valid json')
    const result = await runVerdict('{"tool_name":"Read"}', file)
    expect(result.code).toBe(2)
    expect(result.status).toBe(null)
    expect(result.stderr).toContain('permissions file unreadable')
    expect(result.stderr).toContain(file)
  })

  // MOVED, same name in spirit and NEW in content: a pre-M52 file is version 1 with a `deny` key
  // and no allow list. It is not read -- a v1 file under a v2 gate is a stale verdict, and a stale
  // verdict denies.
  it('fails closed on a version-1 file', async () => {
    const result = await runVerdict(
      '{"tool_name":"Read"}',
      writePermissionsFile('{"version":1,"deny":[{"tool":"Bash","capability":"run tests"}]}'),
    )
    expect(result.code).toBe(2)
  })

  it('fails closed when `allow` is not an array, and when `version` is not 2', async () => {
    expect((await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({ allow: 'all' as never })))).code).toBe(2)
    expect(
      (await runVerdict('{"tool_name":"Read"}', writePermissionsFile(JSON.stringify({ version: 3, allow: [] })))).code,
    ).toBe(2)
  })

  it('fails closed on a file that is valid JSON but not an object at all', async () => {
    for (const body of ['null', '[]', '7']) {
      expect((await runVerdict('{"tool_name":"Read"}', writePermissionsFile(body))).code, body).toBe(2)
    }
  })

  it('fails closed (exit 2) when the hook payload is not valid JSON while a permissions file is armed', async () => {
    const result = await runVerdict('not json at all', writePermissionsFile(v2({})))
    expect(result.code).toBe(2)
    expect(result.status).toBe(null)
    expect(result.stderr).toContain('hook payload did not parse as JSON')
  })

  describe('identity (M52 R4)', () => {
    it('allows when the child\u2019s token hashes to the file\u2019s tokenHash', async () => {
      const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({})), undefined, TOKEN)
      expect(result.code).toBe(0)
      expect(result.status).toBe(1)
    })

    it('FAILS CLOSED when the child\u2019s token hashes to something else -- a sibling run\u2019s file cannot be borrowed', async () => {
      const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({})), undefined, 'a'.repeat(64))
      expect(result.code).toBe(2)
      expect(result.stderr).toMatch(/identity/)
    })

    it('FAILS CLOSED when the child carries no token at all while the file names one', async () => {
      const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({})), undefined, '')
      expect(result.code).toBe(2)
    })

    it('FAILS CLOSED when the file carries no tokenHash -- an unbound verdict is not a verdict', async () => {
      const file = writePermissionsFile(
        JSON.stringify({ version: 2, runId: 'r', enforce: 'all-tools', grants: [], allow: [], vocabulary: {} }),
      )
      const result = await runVerdict('{"tool_name":"Read"}', file)
      expect(result.code).toBe(2)
    })

    it('compares the two hashes at equal length, so a truncated token cannot short-circuit the check', async () => {
      // `timingSafeEqual` THROWS on a length mismatch, and a thrown comparison would leave node
      // exiting nonzero with no message -- which the generic arm would report as an unrecognized
      // answer rather than as an identity failure. The length guard runs first, so this lands on
      // the identity arm with its own sentence.
      const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({})), undefined, TOKEN.slice(0, 8))
      expect(result.code).toBe(2)
      expect(result.stderr).toMatch(/identity/)
    })

    it('checks identity BEFORE the allow list, so a borrowed verdict never allows anything', async () => {
      const result = await runVerdict('{"tool_name":"Read"}', writePermissionsFile(v2({})), undefined, 'b'.repeat(64))
      expect(result.code).toBe(2)
      expect(result.status).toBe(null)
    })
  })

  describe('enforce: known-tools (Cursor, plan erratum E3)', () => {
    it('still enforces the ONE name Cursor can be trusted to send -- the shell, through default_tool', async () => {
      const file = writePermissionsFile(
        v2({
          enforce: 'known-tools',
          allow: [{ tool: 'read', kind: 'read_repo' }],
          grants: ['read_repo'],
          vocabulary: { read: 'read_repo', shell: 'run_commands' },
        }),
      )
      const result = await runVerdict('{"command":"npm test","cwd":"/tmp"}', file, 'shell')
      expect(result.status).toBe(0)
      expect(result.tool).toBe('shell')
      expect(result.capability).toBe('run_commands')
    })

    it('allows a Claude-shaped name Cursor\u2019s preToolUse sends, because that identity is untrustworthy for enforcement', async () => {
      const file = writePermissionsFile(
        v2({ enforce: 'known-tools', allow: [], grants: [], vocabulary: { read: 'read_repo', shell: 'run_commands' } }),
      )
      const result = await runVerdict('{"tool_name":"Read"}', file)
      expect(result.code).toBe(0)
      expect(result.status).toBe(1)
    })

    it('and the SAME payload denies under all-tools, which is the whole difference between the two providers', async () => {
      const file = writePermissionsFile(v2({ enforce: 'all-tools', allow: [], grants: [], vocabulary: { read: 'read_repo' } }))
      const result = await runVerdict('{"tool_name":"Read"}', file)
      expect(result.code).toBe(0)
      expect(result.status).toBe(0)
      expect(result.capability).toBe('ungoverned_tool')
    })

    it('does not let known-tools rescue an identity failure -- that is exit 2 on both providers', async () => {
      const file = writePermissionsFile(v2({ enforce: 'known-tools', allow: [], grants: [], vocabulary: {} }))
      const result = await runVerdict('{"tool_name":"Read"}', file, undefined, 'c'.repeat(64))
      expect(result.code).toBe(2)
    })
  })
})
