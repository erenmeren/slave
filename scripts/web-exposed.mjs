#!/usr/bin/env node
// `npm run web:exposed` — `next dev` bound to EVERY interface, behind one precondition.
//
// M15 §2.4 is explicit about the limit of the Host rule: "A LAN client could still forge
// `Host: localhost` with curl — the backstop is against browsers and accidents, not against a
// hostile LAN." So a 0.0.0.0 bind with no `AITEAMOS_PASSWORD` is not inert: browsers are refused,
// but any LAN/tailnet client that forges the Host header gets full read/write. That is a
// misconfiguration, and the cheapest place to catch it is before the socket opens.
//
// Refusal is exit 2 with one line on stderr; otherwise the real `next dev` runs as a child and
// this process is a pass-through: the child inherits the streams, signals are forwarded, and the
// child's exit code becomes ours.
import { spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'

const password = (process.env['AITEAMOS_PASSWORD'] ?? '').trim()
if (password.length === 0) {
  process.stderr.write(
    'web:exposed refused: set AITEAMOS_PASSWORD in .env first — without a password this instance must stay loopback-only (see README "Reaching it from another device")\n',
  )
  process.exit(2)
}

// AITEAMOS_NEXT_BIN exists for apps/web/test/web-exposed.test.ts, which must never start the real
// next on 0.0.0.0; not an operator knob.
const nextBin = process.env['AITEAMOS_NEXT_BIN'] ?? 'node_modules/next/dist/bin/next'

const child = spawn('node', [nextBin, 'dev', 'apps/web', '-H', '0.0.0.0'], {
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}

child.on('error', (error) => {
  process.stderr.write(`web:exposed failed to start next dev: ${error.message}\n`)
  process.exit(1)
})

// A child killed by a signal reports `code === null`; 128 + the signal's number is the shell's own
// convention for that (SIGINT → 130, SIGTERM → 143, SIGKILL → 137), and keeps "did it exit
// cleanly?" answerable by the caller. The table is looked up rather than spelled out so every
// signal maps, not just the two we forward; an unknown name falls back to SIGTERM's 15.
child.on('exit', (code, signal) => {
  if (code !== null) process.exit(code)
  process.exit(128 + (osConstants.signals[signal] ?? 15))
})
