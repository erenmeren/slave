#!/usr/bin/env node
// `npm run web:exposed` — `next dev` bound to EVERY interface, behind one precondition.
//
// M15 §2.4 is explicit about the limit of the Host rule: "A LAN client could still forge
// `Host: localhost` with curl — the backstop is against browsers and accidents, not against a
// hostile LAN." So a 0.0.0.0 bind with no `AITEAMOS_SESSION_SECRET` is not inert: browsers are
// refused, but any LAN/tailnet client that forges the Host header gets full read/write. That is a
// misconfiguration, and the cheapest place to catch it is before the socket opens.
//
// M23 F1 adds the two ways accounts mode can be configured and still be open: a secret too short
// to be worth signing with, and a database with nobody in it (accounts mode with no account is a
// door nobody can walk through — and a `next dev` on 0.0.0.0 nobody can log into). The order
// matters: both cheap checks run BEFORE the database is asked, so a misconfigured instance is
// refused without a connection attempt and this script's cheap refusals stay testable with no
// Postgres at all.
//
// Refusal is exit 2 with one line on stderr; otherwise the real `next dev` runs as a child and
// this process is a pass-through: the child inherits the streams, signals are forwarded, and the
// child's exit code becomes ours.
import { spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'

/** One line on stderr, exit 2 — and never the secret itself. */
function refuse(reason) {
  process.stderr.write(`web:exposed refused: ${reason}\n`)
  process.exit(2)
}

const secret = (process.env['AITEAMOS_SESSION_SECRET'] ?? '').trim()
if (secret.length === 0) {
  refuse('set AITEAMOS_SESSION_SECRET in .env first (openssl rand -hex 32) — without accounts this instance must stay loopback-only (see README "Reaching it from another device")')
}
if (secret.length < 32) {
  refuse('AITEAMOS_SESSION_SECRET is shorter than 32 characters — mint a real one with `openssl rand -hex 32`')
}

// The way the gates ask: the built client, not a second Prisma instance of our own. `--env-file=.env`
// (see package.json's `web:exposed`) has already put DATABASE_URL in the environment.
{
  const { prisma } = await import('../packages/db/dist/client.js')
  let count = null
  try {
    count = await prisma.user.count()
  } catch (error) {
    await prisma.$disconnect().catch(() => {})
    refuse(`could not count users: ${error instanceof Error ? error.message : String(error)}`)
  }
  // Disconnected before the spawn either way: this process goes on to be a signal pass-through and
  // has no further use for a pool of open connections.
  await prisma.$disconnect()
  if (count === 0) {
    refuse('no users yet: create one with npm run orchestrator -- create-user --name <you>')
  }
}

// AITEAMOS_NEXT_BIN exists for apps/web/test/web-exposed.test.ts and its database-backed half in
// apps/web/test/integration/, which must never start the real next on 0.0.0.0; not an operator knob.
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
