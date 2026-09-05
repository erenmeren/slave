#!/usr/bin/env node
// M26: the word is slave. Fails when "agent" is back anywhere it is ours, or when the old
// scope tokens (aiteamos, ai-team-os, AITEAMOS_, AI Team OS) resurface outside a protected path.
// Protected tokens and historical paths mirror scripts/rename-agent-to-slave.mjs -- keep the two
// lists identical.
import { execFileSync } from 'node:child_process'

const EXCLUDE = [
  ':!docs/superpowers', ':!docs/decisions', ':!packages/db/prisma/migrations',
  ':!packages/providers/test/fixtures', ':!package-lock.json', ':!scripts/rename-agent-to-slave.mjs',
  ':!scripts/gate-m26-vocabulary.mjs', ':!docs/nasil-calisir.pdf', ':!design_handoff_ai_team_os',
]
// Final review (folded, Task 5): widened past bare "agent" to also guard the scope tokens the
// SCOPE_RULES rename -- the grep and the offender re-check below share this one pattern so
// widening one always widens the other.
const PATTERN = '(^|[^a-z])agent|aiteamos|ai-team-os|AITEAMOS_|AI Team OS'
// `2026-08-17-ai-team-os-design` (final review round 2, controller ruling): the M26 parent spec's
// own filename -- docs/superpowers/ is a protected path, so the file was never renamed on disk,
// and a live doc's cross-reference to it must keep citing the real name, same shape as
// `0002-derived-agent-status` just before it.
const PROTECTED = /fake-cursor-agent|cursor-agent|--agents\b|user-agent|agentic|AGENTS\.md|claude-agent-sdk|@anthropic-ai\/[a-z-]+|agent_message(?!_sent)|0002-derived-agent-status|2026-08-17-ai-team-os-design/gi

let out = ''
try {
  out = execFileSync('git', ['grep', '-nIiE', PATTERN, '--', '.', ...EXCLUDE], { encoding: 'utf8' })
} catch (error) {
  if (error.status === 1) out = '' // git grep: no match
  else throw error
}
const offenders = out
  .split('\n')
  .filter((line) => line !== '')
  .filter((line) => line.replace(PROTECTED, '').match(new RegExp(PATTERN, 'i')) !== null)
if (offenders.length > 0) {
  console.error(`FAIL: the old vocabulary is back in ${offenders.length} line(s):`)
  for (const line of offenders) console.error(`  ${line}`)
  process.exit(1)
}
console.log('PASS: the word is slave everywhere it is ours')
