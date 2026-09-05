// Packages what M3's live gate did by hand (spec §8): a real repo, a real seed, a running daemon.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '../packages/db/dist/client.js'

const repoPath = join(homedir(), '.slaveofai', 'demo-repo')

// 1. A real git repository. Reset on every run: the demo must be repeatable, and stale worktrees
// from the last demo would make the tick escalate instead of starting (M3 §7.4).
rmSync(repoPath, { recursive: true, force: true })
mkdirSync(repoPath, { recursive: true })
const git = (args) => execFileSync('git', args, { cwd: repoPath })
git(['init', '-q', '-b', 'main'])
git(['config', 'user.name', 'Demo'])
git(['config', 'user.email', 'demo@slaveofai.local'])
writeFileSync(join(repoPath, 'README.md'), '# demo\n')
git(['add', '-A'])
git(['commit', '-q', '-m', 'initial'])

// 2. Seed. A fresh workspace every run, named with a timestamp passed in by the operator's clock.
// Goal-driven since M9 (the M8b by-eyes shape): NO pre-seeded task and NO goal here -- the board
// starts empty, and the operator types the goal into the Overview page's goal form. That is the
// whole demo: the goal becomes a plan, the plan becomes the board, the board flows to merged.
// `verifyCommands` is the always-green `true` because the planner's tasks are open-ended -- a
// task-specific check cannot be known before the plan exists. `autoMerge: true` so the merges
// actually land on `main` in front of the operator rather than waiting for a hand-merge.
const workspace = await prisma.workspace.create({
  data: {
    name: `Demo ${new Date().toISOString().slice(0, 16)}`,
    repoPath,
    baseBranch: 'main',
    verifyCommands: ['true'],
    setupCommands: [],
    autoMerge: true,
  },
})
// Without this row, dispatch refuses with `invalid_provider` (M12 Task 8) and nothing ever runs.
await prisma.providerConfiguration.create({
  data: { workspaceId: workspace.id, kind: 'claude_code', settings: {} },
})
const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Demo Team' } })
// Lowercase roles, matching the exact-match conventions: `manager` plans the goal (M8b),
// `backend` implements the planned tasks, `reviewer` keeps them from stalling in `reviewing`.
await prisma.agent.create({ data: { teamId: team.id, name: 'Atlas', role: 'manager' } })
await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
await prisma.agent.create({ data: { teamId: team.id, name: 'Riley', role: 'reviewer' } })
await prisma.$disconnect()

// 3. The daemon, inheriting SLAVEOFAI_CLAUDE_BIN/ARGS so the same script smoke-tests against the
// fake for free (spec §8).
console.log(`workspace: ${workspace.id}`)
console.log(`overview:  http://localhost:${process.env.PORT ?? '3000'}/w/${workspace.id}`)
console.log('starting the daemon (Ctrl-C stops it); run `npm run web` in another terminal')
console.log('')
console.log('the board is empty on purpose: open the overview and type a goal into the goal')
console.log('form (try: "Write three numbered notes, one file each, and a README index"),')
console.log('then watch the plan land in the activity feed and the board flow to merged.')
const daemon = spawn('node', ['apps/orchestrator/dist/cli.js', 'daemon', '--workspace', workspace.id], {
  stdio: 'inherit',
})
process.on('SIGINT', () => daemon.kill('SIGTERM'))
process.on('SIGTERM', () => daemon.kill('SIGTERM'))
daemon.on('exit', (code) => process.exit(code ?? 0))
