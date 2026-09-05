#!/usr/bin/env node
// M26: the one rename, reproducible. Three phases so each layer commits on its own:
//   scope — product/package/env/Postgres names (spec §2 row 1)
//   words — agent → slave in file contents (spec §2 rows 2–10)
//   files — git mv for paths that carry the word (spec §2 row 11)
// Protected tokens (spec §2) are swapped for placeholders before the rules run and restored
// after, so `cursor-agent` survives a pass that turns `agent` into `slave`.
import { readFileSync, writeFileSync, appendFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
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
  // Cursor's own response-validator field name (fix round 1, Task 3 review Important 1): its
  // binary's real, external API accepts exactly `permission`, `user_message`, `agent_message` --
  // vendor vocabulary we document, not ours to rename, the same way `cursor-agent` survives.
  /agent_message/g,
]

// Fix round 1 (Task 3 review Minor, folded): the word rules alone turn "an agent" into "an slave"
// -- correct for the noun, wrong for the article that agrees with it. Applied AFTER WORD_RULES,
// on their output, so it only ever sees a `slave` the rules just produced, never an unrelated
// "an slave" some caller passed in as already-renamed text. `\b` so "clean slave" (no article) is
// untouched -- these two patterns match only the article immediately before the word.
const ARTICLE_RULES = [
  [/\ban slave/g, 'a slave'],
  [/\bAn slave/g, 'A slave'],
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
  // Fix round 1: the article post-pass runs AFTER the word rules, on their own output, and only
  // in the `words` phase -- see ARTICLE_RULES' docstring.
  if (phase === 'words') {
    for (const [re, to] of ARTICLE_RULES) {
      out = out.replace(re, () => {
        count += 1
        return to
      })
    }
  }
  out = out.replace(/ P(\d+) /g, (_, i) => saved[Number(i)])
  return { text: out, count, protectedMatches: saved }
}

/** A path's new name: every segment through the word rules; a protected path is returned as is. */
export function renamePath(p) {
  if (isProtectedPath(p)) return p
  return p.split('/').map((seg) => renameText(seg, 'words').text).join('/')
}

/** [from, to] for every path in `paths` whose name changes; protected paths are dropped. */
export function planMoves(paths) {
  const moves = []
  for (const p of paths) {
    const next = renamePath(p)
    if (next !== p) moves.push([p, next])
  }
  return moves
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
  // One git mv per file (not per topmost differing directory), so a nested rename inside an
  // already-renamed directory — [agentId] under api/agents, NewAgentDrawer under components/agents
  // — is never lost.
  let moved = 0
  for (const [from, to] of planMoves(trackedFiles(roots))) {
    if (!existsSync(from) || !statSync(from).isFile()) continue
    moved += 1
    if (report !== null) appendFileSync(report, `${from} -> ${to}\n`)
    if (!dry) {
      mkdirSync(path.dirname(to), { recursive: true })
      execFileSync('git', ['mv', from, to], { stdio: 'inherit' })
    }
  }
  console.log(`files: ${moved} moves${dry ? ' (dry run)' : ''}`)
}

function selfTest() {
  const cases = [
    ['words', 'const agent = agents[0]; Agent; AgentRun; agentId; companyAgentId; AGENTS_TAB', 'const slave = slaves[0]; Slave; SlaveRun; slaveId; companySlaveId; SLAVES_TAB'],
    ['words', 'management reagent Agenda agentic Agentic cursor-agent user-agent AGENTS.md', 'management reagent Agenda agentic Agentic cursor-agent user-agent AGENTS.md'],
    ['words', "actor: 'agent'; type: 'agent.message_sent'; @map(\"agent.message_sent\")", "actor: 'slave'; type: 'slave.message_sent'; @map(\"slave.message_sent\")"],
    ['words', 'fake-cursor-agent.sh spawns cursor-agent --agents', 'fake-cursor-agent.sh spawns cursor-agent --agents'],
    ['words', 'AgentRuntimeAdapter implements agentRuntime; New agent; agents working', 'SlaveRuntimeAdapter implements slaveRuntime; New slave; slaves working'],
    // Fix round 1 (Task 3 review): agent_message is Cursor's own vendor field name, protected
    // like cursor-agent; the article post-pass fixes "an/An slave" produced by the word rules,
    // leaving an unrelated "clean slave" (no article immediately before) untouched.
    ['words', 'user_message and agent_message; an agent; An agent; clean agent', 'user_message and agent_message; a slave; A slave; clean slave'],
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
  // planMoves must move every nested renamed segment (not just the topmost differing one), and
  // must drop a protected path entirely rather than emitting a no-op pair.
  const moveCases = [
    ['apps/web/src/app/api/agents/[agentId]/route.ts', 'apps/web/src/app/api/slaves/[slaveId]/route.ts'],
    ['apps/web/src/app/api/org/agents/[companyAgentId]/team/route.ts', 'apps/web/src/app/api/org/slaves/[companySlaveId]/team/route.ts'],
    ['apps/web/src/components/agents/NewAgentDrawer.tsx', 'apps/web/src/components/slaves/NewSlaveDrawer.tsx'],
    ['scripts/gate-fakes/fake-cursor-agent.sh', null],
  ]
  for (const [from, to] of moveCases) {
    const got = planMoves([from])
    const expected = to === null ? [] : [[from, to]]
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      failed += 1
      console.error(`FAIL (planMoves)\n  in:  ${from}\n  got: ${JSON.stringify(got)}\n  exp: ${JSON.stringify(expected)}`)
    }
  }
  const total = cases.length + paths.length + moveCases.length
  console.log(failed === 0 ? `self-test: ${total} cases pass` : `self-test: ${failed} failed`)
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
