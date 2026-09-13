#!/usr/bin/env node
// A signed webhook SENDER, for `scripts/gate-m54-triggers.mjs` (M54 section 3).
//
// The SIXTH fake in this directory and the first that speaks HTTP. `fake-claude.sh` and
// `fake-cursor-agent.sh` pretend to be a worker, `fake-deploy.sh` pretends to be the thing a worker
// may not touch, `fake-worker-server.sh` pretends to be a stray daemon, `fake-verify.sh` pretends to
// be a project's own verify command -- and this pretends to be GitHub. It is a SENDER and not a
// server: it takes a payload file and a target url, computes `X-Hub-Signature-256` over the exact
// bytes it is about to send, POSTs them to the gate's own `next dev`, and prints the status and the
// body.
//
// NODE AND NOT BASH, deliberately (plan erratum E12): an HMAC in bash means
// `openssl dgst -hmac "$SECRET"`, which this repository declares nowhere and which puts the secret on
// a command line and therefore in the process table -- the one thing section 3's own "the secret goes
// exactly one place" stage forbids. `scripts/gate-m20-auth.mjs:35` re-derives a session cookie with
// `node:crypto` for the same reason.
//
// THE `fake-deploy.sh` SPLIT: a PATH in argv for configuration, the ENVIRONMENT for the secret.
//   argv:  <payload-file> <url> [--corrupt-signature] [--no-signature] [--oversize] [--declared]
//          [--delivery <id>] [--event <name>] [--cross-site]
//   env:   SLAVEOFAI_GATE_HOOK_SECRET
//
// IT NEVER PRINTS, ECHOES OR ASSERTS ON THE SECRET, for the reason `fake-deploy.sh`'s own comment
// gives: a fake that printed the secret it was given would put that secret in the gate's log, in CI.
// It prints the DIGEST, which is derived from the secret and from the bytes and is exactly what a
// real sender puts on the wire -- and it prints it on stderr, beside the accounting below, never
// beside the status line the gate parses.
//
// `--oversize` IS CHUNKED BY DEFAULT (plan erratum E20). The route enforces its cap WHILE reading:
// the declared `Content-Length` is only the cheap first lock, and a `Transfer-Encoding: chunked`
// sender carries none to lie with. So the oversized body is streamed through a `ReadableStream` with
// `duplex: 'half'`, pulled on DEMAND, and this fake reports how many bytes the server actually asked
// for before the exchange ended -- which is what turns "413" into "413 without buffering it".
// `--declared` sends the same oversized bytes as ONE buffer instead, so `fetch` sets a
// `Content-Length` and the FIRST lock is the one under test. Either way the filler is appended
// BEFORE the signature is computed, so the request carries a genuinely correct signature for a
// genuinely oversized body (plan decision D46) and a `413` proves the cap was applied before the
// secret was read rather than that the signature happened to be wrong.
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** How far over `HOOK_BODY_MAX_BYTES` (1 048 576) an `--oversize` body goes, and in what pieces.
 *  Eight times the cap in 256 KiB chunks: large enough that a server which buffered the whole thing
 *  would have to ask for all of it, small enough that the exchange is over in well under a second. */
const OVERSIZE_TOTAL_BYTES = 8 * 1024 * 1024
const OVERSIZE_CHUNK_BYTES = 256 * 1024

/** Exit 3, never 1: a 1 is a delivery this sender made and the server refused, which is a thing the
 *  gate asserts on. 3 says the FAKE is misconfigured -- `fake-deploy.sh`'s own rule. 4 says the
 *  EXCHANGE broke (no status was ever read), which is neither. */
function misconfigured(message) {
  process.stderr.write(`fake-github.mjs: ${message}\n`)
  process.exit(3)
}

// ---- argv ---------------------------------------------------------------------------------------
// Parsed in ONE left-to-right pass rather than by filtering, so `--delivery <id>`'s value can never
// be mistaken for a positional: a switch that takes a value consumes the next token, and everything
// else that does not begin with `--` is a positional in the order it arrived.
const VALUE_SWITCHES = new Set(['delivery', 'event'])
const BARE_SWITCHES = new Set(['corrupt-signature', 'no-signature', 'oversize', 'declared', 'cross-site'])
const argv = process.argv.slice(2)
const positional = []
const values = new Map()
const flags = new Set()
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index]
  if (!token.startsWith('--')) {
    positional.push(token)
    continue
  }
  const name = token.slice(2)
  if (VALUE_SWITCHES.has(name)) {
    const value = argv[index + 1]
    if (value === undefined) misconfigured(`--${name} needs a value`)
    values.set(name, value)
    index += 1
    continue
  }
  if (!BARE_SWITCHES.has(name)) misconfigured(`unknown switch ${token}`)
  flags.add(name)
}

const [payloadPath, url] = positional
if (payloadPath === undefined || url === undefined) {
  misconfigured('usage: fake-github.mjs <payload-file> <url> [switches]')
}

const secret = process.env['SLAVEOFAI_GATE_HOOK_SECRET'] ?? ''
if (secret === '') {
  misconfigured('SLAVEOFAI_GATE_HOOK_SECRET is not set -- there is nothing to sign with')
}

// ---- the bytes, read once and sent unchanged ----------------------------------------------------
const base = readFileSync(payloadPath)
const filler = flags.has('oversize')
  ? Buffer.alloc(Math.max(0, OVERSIZE_TOTAL_BYTES - base.byteLength), 0x20)
  : Buffer.alloc(0)
const body = filler.byteLength === 0 ? base : Buffer.concat([base, filler])

const digest = createHmac('sha256', secret).update(body).digest('hex')
const corrupted = `${digest.slice(0, 63)}${digest.endsWith('a') ? 'b' : 'a'}`
const headers = {
  'content-type': 'application/json',
  'x-github-event': values.get('event') ?? 'issues',
  'x-github-delivery': values.get('delivery') ?? `gate-${String(Date.now())}`,
}
if (!flags.has('no-signature')) {
  headers['x-hub-signature-256'] = `sha256=${flags.has('corrupt-signature') ? corrupted : digest}`
}
// The half of R1 a unit test cannot reach: fetch metadata a BROWSER would send, on a request the
// boundary must still allow. `sec-fetch-site` is what `crossSiteRefusal` reads first.
if (flags.has('cross-site')) headers['sec-fetch-site'] = 'cross-site'

// ---- the wire -----------------------------------------------------------------------------------
// Chunked unless the body fits in one piece or `--declared` asks for a single buffer. A
// `ReadableStream` body makes undici send `Transfer-Encoding: chunked` with no `Content-Length`, and
// `duplex: 'half'` is required for a streaming request body. `pull` is DEMAND-DRIVEN, so `pushed`
// below is what the far side actually asked for and not what this process felt like producing.
const chunked = flags.has('oversize') && !flags.has('declared')
let pushed = 0
let requestBody
if (chunked) {
  let offset = 0
  requestBody = new ReadableStream({
    pull(controller) {
      if (offset >= body.byteLength) {
        controller.close()
        return
      }
      const end = Math.min(offset + OVERSIZE_CHUNK_BYTES, body.byteLength)
      controller.enqueue(new Uint8Array(body.subarray(offset, end)))
      pushed += end - offset
      offset = end
    },
  })
} else {
  requestBody = body
  pushed = body.byteLength
}

const accounting = () =>
  `fake-github: offered=${String(body.byteLength)} pushed=${String(pushed)} chunked=${chunked ? 'yes' : 'no'} ` +
  `digest=${headers['x-hub-signature-256'] ?? '<none>'}\n`

let response
try {
  response = await fetch(url, {
    method: 'POST',
    body: requestBody,
    headers,
    ...(chunked ? { duplex: 'half' } : {}),
  })
} catch (cause) {
  process.stderr.write(accounting())
  process.stderr.write(`fake-github.mjs: the exchange failed before a status was read: ${String(cause)}\n`)
  process.exit(4)
}
// The body is read before the accounting is printed, so `pushed` is final: a server that refuses
// mid-stream stops pulling, and the number this prints is the number that proves it.
let text
try {
  text = await response.text()
} catch (cause) {
  // A status WAS read. A server that answers and then destroys the socket without flushing its own
  // body is still an answer, and the status is the thing the gate asserts on.
  process.stderr.write(`fake-github.mjs: the response body was cut short: ${String(cause)}\n`)
  text = ''
}
process.stderr.write(accounting())
process.stdout.write(`${String(response.status)} ${text}\n`)
process.exit(0)
