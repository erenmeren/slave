// Packages what M3's live gate did by hand (spec §8): a real repo, a real seed, a running daemon.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '../packages/db/dist/client.js'

const repoPath = join(homedir(), '.aiteamos', 'demo-repo')

// 1. A real git repository. Reset on every run: the demo must be repeatable, and stale worktrees
// from the last demo would make the tick escalate instead of starting (M3 §7.4).
rmSync(repoPath, { recursive: true, force: true })
mkdirSync(repoPath, { recursive: true })
const git = (args) => execFileSync('git', args, { cwd: repoPath })
git(['init', '-q', '-b', 'main'])
git(['config', 'user.name', 'Demo'])
git(['config', 'user.email', 'demo@aiteamos.local'])
writeFileSync(join(repoPath, 'README.md'), '# demo\n')
git(['add', '-A'])
git(['commit', '-q', '-m', 'initial'])

// 2. Seed. A fresh workspace every run, named with a timestamp passed in by the operator's clock.
const workspace = await prisma.workspace.create({
  data: {
    name: `Demo ${new Date().toISOString().slice(0, 16)}`,
    repoPath,
    baseBranch: 'main',
    verifyCommands: ['test -f notes/note3.txt'],
    setupCommands: ['mkdir -p notes'],
  },
})
const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Demo Team' } })
await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
await prisma.task.create({
  data: {
    workspaceId: workspace.id,
    title: 'Write three numbered notes',
    description:
      'Create notes/note1.txt, notes/note2.txt and notes/note3.txt, each containing its own ' +
      'number as a word. Create them one at a time, one file per step, and commit each one.',
    status: 'ready',
    requiredRole: 'backend',
    maxAttempts: workspace.maxAttempts,
  },
})
await prisma.$disconnect()

// 3. The daemon, inheriting AITEAMOS_CLAUDE_BIN/ARGS so the same script smoke-tests against the
// fake for free (spec §8).
console.log(`workspace: ${workspace.id}`)
console.log(`overview:  http://localhost:${process.env.PORT ?? '3000'}/w/${workspace.id}`)
console.log('starting the daemon (Ctrl-C stops it); run `npm run web` in another terminal')
const daemon = spawn('node', ['apps/orchestrator/dist/cli.js', 'daemon', '--workspace', workspace.id], {
  stdio: 'inherit',
})
process.on('SIGINT', () => daemon.kill('SIGTERM'))
process.on('SIGTERM', () => daemon.kill('SIGTERM'))
daemon.on('exit', (code) => process.exit(code ?? 0))
