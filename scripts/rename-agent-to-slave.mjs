#!/usr/bin/env node
// M26: the one rename, reproducible. Three phases so each layer commits on its own:
//   scope — product/package/env/Postgres names (spec §2 row 1)
//   words — agent → slave in file contents (spec §2 rows 2–10)
//   files — git mv for paths that carry the word (spec §2 row 11)
// Protected tokens (spec §2) are swapped for placeholders before the rules run and restored
// after, so `cursor-agent` survives a pass that turns `agent` into `slave`.
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const PROTECTED_PATHS = [
  'docs/superpowers/', 'docs/decisions/', 'node_modules/', '.git/',
  'packages/db/prisma/migrations/', 'packages/providers/test/fixtures/',
  'package-lock.json', 'scripts/rename-agent-to-slave.mjs', 'docs/nasil-calisir.pdf',
]
// Order matters only in that each is restored exactly as matched.
const PROTECTED_TOKENS = [
  /fake-cursor-agent/g, /cursor-agent/g, /--agents\b/g, /user-agent/gi, /agentic/gi,
  /AGENTS\.md/g, /claude-agent-sdk/g, /@anthropic-ai\/[a-z-]+/g,
]

const SCOPE_RULES = [
  [/AI Team OS/g, 'Slave of AI'],
  [/@ai-team-os\//g, '@slave-of-ai/'],
  [/"ai-team-os"/g, '"slave-of-ai"'],
  [/AITEAMOS_/g, 'SLAVEOFAI_'],
  [/aiteamos/g, 'slaveofai'],
]
// `Agent` followed by anything but a lowercase letter other than `s` (so Agents, AgentRun,
// AgentId, Agent. all match; Agentic, Agenda do not); `agent` must start at a non-letter (so
// reagent, management do not match) and obey the same lookahead; AGENT likewise.
const WORD_RULES = [
  [/Agent(?![a-rt-z])/g, 'Slave'],
  [/(?<![A-Za-z])agent(?![a-rt-z])/g, 'slave'],
  [/(?<![A-Za-z])AGENT(?![A-RT-Z])/g, 'SLAVE'],
]

export function renameText(text, phase) {
  const rules = phase === 'scope' ? SCOPE_RULES : phase === 'words' ? WORD_RULES : null
  if (rules === null) throw new Error(`renameText: unknown phase ${phase}`)
  const saved = []
  let out = text
  for (const token of PROTECTED_TOKENS) {
    out = out.replace(token, (m) => {
      saved.push(m)
      return ` P${saved.length - 1} `
    })
  }
  let count = 0
  for (const [re, to] of rules) {
    out = out.replace(re, () => {
      count += 1
      return to
    })
  }
  out = out.replace(/ P(\d+) /g, (_, i) => saved[Number(i)])
  return { text: out, count, protectedMatches: saved }
}

/** A path's new name: every segment through the word rules; a protected path is returned as is. */
export function renamePath(p) {
  if (isProtectedPath(p)) return p
  return p.split('/').map((seg) => renameText(seg, 'words').text).join('/')
}

function isProtectedPath(p) {
  return PROTECTED_PATHS.some((prefix) => p === prefix || p.startsWith(prefix))
}

function trackedFiles(roots) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...roots], { encoding: 'utf8' })
  return out.split('\0').filter((f) => f !== '' && !isProtectedPath(f))
}

function isText(file) {
  const buf = readFileSync(file)
  return !buf.subarray(0, 8000).includes(0)
}

function runPhase(phase, roots, dry, report) {
  let files = 0
  let total = 0
  for (const file of trackedFiles(roots)) {
    if (!existsSync(file) || !statSync(file).isFile() || !isText(file)) continue
    const before = readFileSync(file, 'utf8')
    const { text, count, protectedMatches } = renameText(before, phase)
    if (report !== null) {
      for (const m of protectedMatches) appendFileSync(report, `${file}: skipped protected: ${m}\n`)
      if (count > 0) appendFileSync(report, `${file}: ${count} replacements\n`)
    }
    if (count === 0) continue
    files += 1
    total += count
    if (!dry) writeFileSync(file, text)
  }
  console.log(`${phase}: ${total} replacements in ${files} files${dry ? ' (dry run)' : ''}`)
}

function runFiles(roots, dry, report) {
  // Deepest paths first so a directory rename never invalidates a child's old path.
  const files = trackedFiles(roots).sort((a, b) => b.split('/').length - a.split('/').length)
  const moved = new Set()
  for (const file of files) {
    const next = renamePath(file)
    if (next === file) continue
    // Move the topmost differing directory once, not every file under it.
    const a = file.split('/'), b = next.split('/')
    let i = 0
    while (i < a.length && a[i] === b[i]) i += 1
    const from = a.slice(0, i + 1).join('/'), to = b.slice(0, i + 1).join('/')
    if (moved.has(from)) continue
    moved.add(from)
    if (report !== null) appendFileSync(report, `${from} -> ${to}\n`)
    if (!dry) execFileSync('git', ['mv', from, to], { stdio: 'inherit' })
  }
  console.log(`files: ${moved.size} moves${dry ? ' (dry run)' : ''}`)
}

function selfTest() {
  const cases = [
    ['words', 'const agent = agents[0]; Agent; AgentRun; agentId; companyAgentId; AGENTS_TAB', 'const slave = slaves[0]; Slave; SlaveRun; slaveId; companySlaveId; SLAVES_TAB'],
    ['words', 'management reagent Agenda agentic Agentic cursor-agent user-agent AGENTS.md', 'management reagent Agenda agentic Agentic cursor-agent user-agent AGENTS.md'],
    ['words', "actor: 'agent'; type: 'agent.message_sent'; @map(\"agent.message_sent\")", "actor: 'slave'; type: 'slave.message_sent'; @map(\"slave.message_sent\")"],
    ['words', 'fake-cursor-agent.sh spawns cursor-agent --agents', 'fake-cursor-agent.sh spawns cursor-agent --agents'],
    ['words', 'AgentRuntimeAdapter implements agentRuntime; New agent; agents working', 'SlaveRuntimeAdapter implements slaveRuntime; New slave; slaves working'],
    ['scope', '@ai-team-os/control "ai-team-os" AITEAMOS_CLAUDE_BIN aiteamos-postgres AI Team OS', '@slave-of-ai/control "slave-of-ai" SLAVEOFAI_CLAUDE_BIN slaveofai-postgres Slave of AI'],
    ['scope', 'import x from "@anthropic-ai/sdk"', 'import x from "@anthropic-ai/sdk"'],
  ]
  let failed = 0
  for (const [phase, input, expected] of cases) {
    const got = renameText(input, phase).text
    if (got !== expected) {
      failed += 1
      console.error(`FAIL (${phase})\n  in:  ${input}\n  got: ${got}\n  exp: ${expected}`)
    }
  }
  const paths = [
    ['apps/web/src/components/AgentCard.tsx', 'apps/web/src/components/SlaveCard.tsx'],
    ['apps/web/src/app/api/agents/[agentId]/route.ts', 'apps/web/src/app/api/slaves/[slaveId]/route.ts'],
    ['apps/web/src/app/api/org/agents/[companyAgentId]/team/route.ts', 'apps/web/src/app/api/org/slaves/[companySlaveId]/team/route.ts'],
    ['apps/web/test/all-agents-table.test.tsx', 'apps/web/test/all-slaves-table.test.tsx'],
    ['packages/domain/src/agent/derived.ts', 'packages/domain/src/slave/derived.ts'],
    ['scripts/gate-fakes/fake-cursor-agent.sh', 'scripts/gate-fakes/fake-cursor-agent.sh'],
    ['docs/decisions/0002-derived-agent-status.md', 'docs/decisions/0002-derived-agent-status.md'],
  ]
  for (const [from, to] of paths) {
    const got = renamePath(from)
    if (got !== to) {
      failed += 1
      console.error(`FAIL (path)\n  in:  ${from}\n  got: ${got}\n  exp: ${to}`)
    }
  }
  console.log(failed === 0 ? `self-test: ${cases.length + paths.length} cases pass` : `self-test: ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

const argv = process.argv.slice(2)
if (argv.includes('--self-test')) selfTest()
else {
  const phaseIx = argv.indexOf('--phase')
  const phase = phaseIx === -1 ? null : argv[phaseIx + 1]
  const reportIx = argv.indexOf('--report')
  const report = reportIx === -1 ? null : argv[reportIx + 1]
  const dry = argv.includes('--dry-run')
  const roots = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--phase' && argv[i - 1] !== '--report')
  if (phase === null || roots.length === 0) {
    console.error('usage: rename-agent-to-slave.mjs --phase scope|words|files [--dry-run] [--report file] <path…> | --self-test')
    process.exit(2)
  }
  if (phase === 'files') runFiles(roots, dry, report)
  else runPhase(phase, roots, dry, report)
}
