// The gate's measured half (spec §6 / M6 design doc §6): "events appear within one second of
// occurrence." Seeds a workspace (demo-live.mjs's seed shape, minus the git repo and the daemon —
// this script drives appendEvent itself, so there is no `claude` process to spawn and nothing for
// AITEAMOS_CLAUDE_BIN/AITEAMOS_CLAUDE_ARGS to wire up), starts the real web server, opens the
// activity stream over plain `fetch` (the honest end-to-end path — hitting `createEventSse`
// in-process would skip Next's own routing and body-streaming), appends N=50 events at 100ms
// intervals, and for each received frame measures the gap between the event's own `ts` (assigned
// by Postgres at INSERT) and the frame's arrival at this process. Prints min/p50/p95/max and exits
// non-zero if p95 >= 1000ms.
//
// A one-event warm-up precedes the timed run: `fetch()` resolving only means headers have
// arrived, not that the server's `LISTEN` is attached yet (`createEventSse` starts that
// asynchronously, concurrently with the response being constructed — see its comments). An event
// appended into that gap is delivered only by the SSE route's 5-second poll fallback, which would
// blow up p95 for a reason that has nothing to do with the stream's real latency. Waiting for the
// warm-up event to arrive over the wire proves the pipe is live end to end before the timed loop
// starts.

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { prisma } from '../packages/db/dist/client.js'
import { appendEvent } from '../packages/events/dist/index.js'

const PORT = process.env.PORT ?? '3000'
const BASE_URL = `http://127.0.0.1:${PORT}`
const N = 50
const INTERVAL_MS = 100
const P95_BAR_MS = 1000
const WARMUP_TIMEOUT_MS = 5000
const DRAIN_TIMEOUT_MS = 5000

// 1. Seed a workspace, team, agent and task — demo-live.mjs's seed shape. No git repo: nothing
// here ever reads `repoPath` off disk, because no orchestrator runs against this workspace.
const workspace = await prisma.workspace.create({
  data: {
    name: `Latency ${new Date().toISOString()}`,
    repoPath: '/tmp/measure-activity-latency-unused',
    baseBranch: 'main',
    verifyCommands: [],
    setupCommands: [],
  },
})
const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Latency Team' } })
const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Lex', role: 'backend' } })
const task = await prisma.task.create({
  data: {
    workspaceId: workspace.id,
    title: 'Measure activity latency',
    description: 'Synthetic task appended to by scripts/measure-activity-latency.mjs.',
    status: 'running',
    requiredRole: 'backend',
    maxAttempts: workspace.maxAttempts,
  },
})
console.log(`workspace: ${workspace.id}`)

async function waitForWebReady(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fetch(baseUrl)
      return
    } catch {
      if (Date.now() > deadline) throw new Error(`web server did not become reachable within ${timeoutMs}ms`)
      await delay(200)
    }
  }
}

// 2. The real web server, in the background — the same entry point `npm run web` uses.
const web = spawn(
  'node',
  ['--env-file=.env', 'node_modules/next/dist/bin/next', 'dev', 'apps/web', '--port', PORT],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)
web.stdout.on('data', (chunk) => process.stdout.write(`[web] ${chunk}`))
web.stderr.on('data', (chunk) => process.stderr.write(`[web] ${chunk}`))
let webExited = false
web.on('exit', () => {
  webExited = true
})

let exitCode = 1
try {
  await waitForWebReady(BASE_URL, 30_000)
  if (webExited) throw new Error('web server exited before becoming ready')
  console.log(`web ready on ${BASE_URL}`)

  const response = await fetch(`${BASE_URL}/api/w/${workspace.id}/activity/stream`)
  if (!response.ok || response.body === null) {
    throw new Error(`stream did not open: ${response.status} ${response.statusText}`)
  }

  const gaps = []
  let warmupSeen = false
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let sep
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine === undefined) continue // an id-only heartbeat frame
        const arrivedAt = Date.now()
        const event = JSON.parse(dataLine.slice('data: '.length))
        if (event.workspaceId !== workspace.id) continue
        if (event.type === 'run.started') {
          warmupSeen = true
          continue
        }
        if (event.type === 'run.tool_call') {
          gaps.push(arrivedAt - new Date(event.ts).getTime())
        }
      }
    }
  })()

  // 3. Warm-up: append one event, then wait to see it arrive before starting the timed run.
  await appendEvent({
    type: 'run.started',
    workspaceId: workspace.id,
    agentId: agent.id,
    taskId: task.id,
    actor: 'system',
    payload: { sessionId: 'warmup' },
  })
  {
    const deadline = Date.now() + WARMUP_TIMEOUT_MS
    while (!warmupSeen && Date.now() < deadline) await delay(20)
    if (!warmupSeen) throw new Error('warm-up event never arrived over the stream — LISTEN never came up')
  }

  // 4. The timed run: N events at 100ms intervals.
  for (let i = 0; i < N; i += 1) {
    await appendEvent({
      type: 'run.tool_call',
      workspaceId: workspace.id,
      agentId: agent.id,
      taskId: task.id,
      actor: 'agent',
      payload: { name: 'Bash', summary: `measurement event ${i}` },
    })
    await delay(INTERVAL_MS)
  }

  // Let the last few frames catch up before closing the stream.
  {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS
    while (gaps.length < N && Date.now() < deadline) await delay(50)
  }

  await reader.cancel().catch(() => {})
  await pump.catch(() => {})

  if (gaps.length < N) {
    console.error(`only received ${gaps.length}/${N} frames within the drain window`)
  }

  const sorted = [...gaps].sort((a, b) => a - b)
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
  const min = sorted[0]
  const p50 = percentile(50)
  const p95 = percentile(95)
  const max = sorted[sorted.length - 1]

  console.log(`n=${sorted.length}/${N} min=${min}ms p50=${p50}ms p95=${p95}ms max=${max}ms`)

  if (sorted.length < N) {
    exitCode = 1
  } else if (p95 >= P95_BAR_MS) {
    console.error(`FAIL: p95 (${p95}ms) >= ${P95_BAR_MS}ms`)
    exitCode = 1
  } else {
    console.log(`PASS: p95 (${p95}ms) < ${P95_BAR_MS}ms`)
    exitCode = 0
  }
} finally {
  web.kill('SIGTERM')
  await prisma.executionEvent.deleteMany({ where: { workspaceId: workspace.id } }).catch(() => {})
  await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {})
  await prisma.$disconnect()
}

process.exit(exitCode)
