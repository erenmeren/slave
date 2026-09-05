#!/usr/bin/env node
// M26: the word is slave. Fails when "agent" is back anywhere it is ours. Protected tokens and
// historical paths mirror scripts/rename-agent-to-slave.mjs -- keep the two lists identical.
import { execFileSync } from 'node:child_process'

const EXCLUDE = [
  ':!docs/superpowers', ':!docs/decisions', ':!packages/db/prisma/migrations',
  ':!packages/providers/test/fixtures', ':!package-lock.json', ':!scripts/rename-agent-to-slave.mjs',
  ':!scripts/gate-m26-vocabulary.mjs', ':!docs/nasil-calisir.pdf', ':!design_handoff_ai_team_os',
]
const PROTECTED = /fake-cursor-agent|cursor-agent|--agents\b|user-agent|agentic|AGENTS\.md|claude-agent-sdk|@anthropic-ai\/[a-z-]+|agent_message(?!_sent)|0002-derived-agent-status/gi

let out = ''
try {
  out = execFileSync('git', ['grep', '-nIiE', '(^|[^a-z])agent', '--', '.', ...EXCLUDE], { encoding: 'utf8' })
} catch (error) {
  if (error.status === 1) out = '' // git grep: no match
  else throw error
}
const offenders = out
  .split('\n')
  .filter((line) => line !== '')
  .filter((line) => line.replace(PROTECTED, '').match(/(^|[^a-z])agent/i) !== null)
if (offenders.length > 0) {
  console.error(`FAIL: "agent" is back in ${offenders.length} line(s):`)
  for (const line of offenders) console.error(`  ${line}`)
  process.exit(1)
}
console.log('PASS: the word is slave everywhere it is ours')
