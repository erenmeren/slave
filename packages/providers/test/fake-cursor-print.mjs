#!/usr/bin/env node
// A stand-in for `cursor-agent --print --output-format stream-json`, the ONE-SHOT call
// `decideWithCursor` makes (F R5). It is the print-mode sibling of `fake-cursor.mjs`'s run-mode
// job, and it is deliberately a separate file: a run replays a recorded NDJSON fixture of a whole
// working session, while a decision call is three or four lines and has no session at all.
//
// EVERY LINE SHAPE HERE IS COPIED FROM A REAL CALL, not from vendor documentation: the spike at
// `.superpowers/sdd/2026-09-20-supervisor-chat/cursor-print-spike.jsonl` recorded
// `cursor-agent --print --output-format stream-json --trust --force --model auto "<prompt>"` and
// its seven lines are `system/init`, `user`, three `thinking` deltas, `assistant`, `result`
// (spec §4 erratum E1). The two facts that cost something if forgotten:
//
//  - The terminal `result` line carries `usage` and NO cost field of any name. A decision made on
//    this runtime is therefore unmeasured, and `costUsd` is `null` rather than `0`.
//  - The assistant text opens with a vendor preface line ("> Auto routed to <model>") before the
//    answer. `--fixture preface` reproduces it, because a parser that only ever met the clean
//    shape would look correct until the first real call.
//
// Modes (`--fixture <name>`, default `answer`):
//   answer    init, one assistant line carrying the reply envelope, a success result. The shape
//             every other test is written against.
//   preface   `answer` with the measured vendor preface in front of the envelope.
//   breach    a `tool_call` line BEFORE the assistant line. A decision call is spawned with a gate
//             that denies every tool, so a tool call in this stream means the gate was defeated:
//             `decideWithCursor` must report `isolation_breach` and not the answer.
//   noresult  init and the assistant line, then exit 0 with no `result` line at all.
//   hang      writes nothing and never exits on its own -- the timeout path.
//
// `--dump <path>` writes this process's own cwd, argv, environment and the two run files it was
// spawned around (the hooks file in its cwd, the permissions file its environment names) as one
// JSON object. It is `fake-claude.mjs`'s `--env-out` convention and it is here for that file's
// reason: a call's wiring is only really proved from INSIDE the child, and the caller deletes its
// temp directory the moment the call ends, so nothing outside can read those files afterwards.
// The run token is redacted to `<present>` at write time -- the plaintext is the capability
// itself, and a dump that wrote it would put a live token on disk to prove a point about
// isolation. `tokenMatchesFile` is the assertion it exists for, computed here where both halves
// are in hand.
//
// Every other argument (`--print`, `--output-format`, `--trust`, `--force`, `--model <m>`, the
// positional prompt) is accepted and never parsed, `fake-claude.mjs`'s rule: an argument this
// script chokes on would make a flag change look like a runtime failure.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)

function flagValue(name) {
  const index = args.indexOf(name)
  const value = index === -1 ? undefined : args[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

const fixture = flagValue('--fixture') ?? 'answer'
const sessionId = 'fake-cursor-print-session'
const reply = JSON.stringify({ supervisorReply: { text: 'from cursor', actions: [], sources: [] } })
// Measured verbatim off the spike's assistant line, preface and blank line included.
const preface = '> Auto routed to Cursor Grok 4.6\n\n'
const text = fixture === 'preface' ? `${preface}${reply}` : reply

const init = {
  type: 'system',
  subtype: 'init',
  apiKeySource: 'login',
  cwd: process.cwd(),
  session_id: sessionId,
  // The routed model, not the requested one -- the spike asked for `auto` and was answered
  // `Auto Balance`.
  model: 'Auto Balance',
  permissionMode: 'default',
}

const assistant = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  session_id: sessionId,
}

// The shape of a started tool call, copied from `test/fixtures/cursor/cursor-run.ndjson` line 7:
// the tool is named by a `<name>ToolCall` key inside `tool_call`, never by a `tool_name` field.
const toolCall = {
  type: 'tool_call',
  subtype: 'started',
  call_id: 'fake-call-1',
  tool_call: {
    readToolCall: { args: { path: '/etc/passwd' } },
    hookAdditionalContexts: [],
    toolCallId: 'fake-call-1',
    startedAtMs: '1',
  },
  session_id: sessionId,
}

const result = {
  type: 'result',
  subtype: 'success',
  duration_ms: 5327,
  duration_api_ms: 5327,
  is_error: false,
  // On a success this field is the answer text, preface and all -- the spike's own line repeats
  // the assistant message here rather than adding anything to it.
  result: text,
  session_id: sessionId,
  request_id: 'fake-request-1',
  // No cost field of any kind, exactly as measured. A `usage` object is not a price.
  usage: { inputTokens: 20948, outputTokens: 83, cacheReadTokens: 2304, cacheWriteTokens: 0 },
}

const dumpPath = flagValue('--dump')
if (dumpPath !== undefined) {
  const readJson = (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  const permissionsPath = process.env.SLAVEOFAI_PERMISSIONS_FILE
  const permissions = permissionsPath === undefined ? null : readJson(permissionsPath)
  const token = process.env.SLAVEOFAI_RUN_TOKEN
  const env = Object.fromEntries(
    Object.entries(process.env).map(([name, value]) => [name, name === 'SLAVEOFAI_RUN_TOKEN' ? '<present>' : value]),
  )
  writeFileSync(
    dumpPath,
    JSON.stringify({
      cwd: process.cwd(),
      argv: args,
      env,
      hooks: readJson(path.join(process.cwd(), '.cursor', 'hooks.json')),
      permissions,
      tokenMatchesFile:
        token !== undefined &&
        permissions !== null &&
        createHash('sha256').update(token).digest('hex') === permissions.tokenHash,
    }),
  )
}

if (fixture === 'hang') {
  // Never exits on its own: the caller's timeout is what ends this process.
  setInterval(() => {}, 60_000)
} else {
  const lines = [init]
  if (fixture === 'breach') lines.push(toolCall)
  lines.push(assistant)
  if (fixture !== 'noresult') lines.push(result)
  for (const line of lines) process.stdout.write(`${JSON.stringify(line)}\n`)
  process.exit(0)
}
