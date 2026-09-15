import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { INTAKE_MAX_MODEL_CALLS, INTAKE_MAX_RUNTIME_ROLES } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_RUNTIME_ROLES } from '../../src/profile.js'
import { claimIntakes, openIntake, abandonIntake, readIntake, recordIntakeReply, sendIntakeMessage } from '../../src/intake.js'

/** A real repository with a package.json, because detection is the seam under test. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'intake-repo-'))
  const git = (args: readonly string[]): void => {
    execFileSync('git', [...args], { cwd: dir })
  }
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.name', 'Fixture'])
  git(['config', 'user.email', 'fixture@example.com'])
  writeFileSync(join(dir, 'package.json'), '{"scripts":{"test":"vitest run","typecheck":"tsc --noEmit"}}')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'initial'])
  return dir
}

describe('the intake conversation', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "IntakeMessage", "Intake", "InstallationSettings" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  const open = async (): Promise<string> => {
    const opened = await openIntake()
    if (!opened.ok) throw new Error('openIntake refused')
    return opened.value.id
  }

  it('opens empty, spends nothing and waits for the person', async (): Promise<void> => {
    const view = await readIntake(await open())
    expect(view.ok).toBe(true)
    if (!view.ok) throw new Error('unreachable')
    expect(view.value.status).toBe('open')
    expect(view.value.messages).toEqual([])
    expect(view.value.callsLeft).toBe(INTAKE_MAX_MODEL_CALLS)
    expect(view.value.draft).toBeNull()
  })

  it('refuses a blank message and an unknown intake', async (): Promise<void> => {
    const id = await open()
    const blank = await sendIntakeMessage(id, '   ')
    expect(blank.ok).toBe(false)
    if (blank.ok) throw new Error('unreachable')
    expect(blank.error.kind).toBe('invalid_message')

    const missing = await sendIntakeMessage('00000000-0000-0000-0000-000000000000', 'hello')
    expect(missing.ok).toBe(false)
    if (missing.ok) throw new Error('unreachable')
    expect(missing.error.kind).toBe('intake_not_found')
  })

  it('writes the person s line, then what detection found, and waits for the daemon', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await open()
    const sent = await sendIntakeMessage(id, `the repository is at ${repo}`)
    expect(sent.ok).toBe(true)

    const view = await readIntake(id)
    if (!view.ok) throw new Error('unreachable')
    expect(view.value.status).toBe('awaiting_reply')
    expect(view.value.messages.map((message) => message.role)).toEqual(['human', 'fact'])
    expect(view.value.messages[1]?.text).toContain(repo)
    expect(view.value.messages[1]?.text).toContain('npm test')
    expect(view.value.facts?.paths[0]?.isRepository).toBe(true)
    expect(view.value.facts?.paths[0]?.verify.map((finding) => finding.command)).toEqual(['npm test', 'npm run typecheck'])
    expect(view.value.facts?.reposRoot.length).toBeGreaterThan(0)
  })

  it('writes NO fact row when a message names no path, so the transcript is not padded', async (): Promise<void> => {
    const id = await open()
    await sendIntakeMessage(id, 'I want rate limiting on our public API')
    const view = await readIntake(id)
    if (!view.ok) throw new Error('unreachable')
    expect(view.value.messages.map((message) => message.role)).toEqual(['human'])
    expect(view.value.facts).toBeNull()
  })

  it('refuses a second message while the first is still unanswered', async (): Promise<void> => {
    const id = await open()
    await sendIntakeMessage(id, 'first')
    const second = await sendIntakeMessage(id, 'second')
    expect(second.ok).toBe(false)
    if (second.ok) throw new Error('unreachable')
    expect(second.error.kind).toBe('intake_not_open')
  })

  it('claims a due intake exactly once, however many daemons ask at the same instant', async (): Promise<void> => {
    const id = await open()
    await sendIntakeMessage(id, 'hello')
    const [a, b] = await Promise.all([
      claimIntakes({ by: 'daemon-a', limit: 5 }),
      claimIntakes({ by: 'daemon-b', limit: 5 }),
    ])
    expect(a.length + b.length).toBe(1)
    const row = await prisma.intake.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('replying')
    expect(row.claimedBy === 'daemon-a' || row.claimedBy === 'daemon-b').toBe(true)
  })

  it('hands the claimer the transcript, the facts and how many turns are left', async (): Promise<void> => {
    const id = await open()
    await sendIntakeMessage(id, 'hello')
    const claimed = await claimIntakes({ by: 'daemon', limit: 1 })
    expect(claimed[0]?.id).toBe(id)
    expect(claimed[0]?.transcript.map((line) => line.role)).toEqual(['human'])
    expect(claimed[0]?.callsLeft).toBe(INTAKE_MAX_MODEL_CALLS)
  })

  it('reclaims a claim whose daemon died, and only after the TTL', async (): Promise<void> => {
    const id = await open()
    await sendIntakeMessage(id, 'hello')
    await claimIntakes({ by: 'dead-daemon', limit: 1 })
    expect(await claimIntakes({ by: 'live-daemon', limit: 1 })).toEqual([])

    await prisma.intake.update({ where: { id }, data: { claimedAt: new Date(Date.now() - 10 * 60_000) } })
    const reclaimed = await claimIntakes({ by: 'live-daemon', limit: 1 })
    expect(reclaimed.map((intake) => intake.id)).toEqual([id])
  })

  it('records an ask, puts the turn back to the person and charges the call', async (): Promise<void> => {
    const id = await open()
    await sendIntakeMessage(id, 'hello')
    await claimIntakes({ by: 'daemon', limit: 1 })
    const recorded = await recordIntakeReply(id, {
      kind: 'answer',
      answer: { kind: 'ask', text: 'Where is the repository?' },
      downgraded: null,
      costUsd: 0.02,
    })
    expect(recorded.ok).toBe(true)

    const view = await readIntake(id)
    if (!view.ok) throw new Error('unreachable')
    expect(view.value.status).toBe('open')
    expect(view.value.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Where is the repository?' })
    expect(view.value.callsLeft).toBe(INTAKE_MAX_MODEL_CALLS - 1)
    const row = await prisma.intake.findUniqueOrThrow({ where: { id } })
    expect(row.modelCostUsd).toBeCloseTo(0.02)
    expect(row.unmeasuredCalls).toBe(0)
    expect(row.claimedBy).toBeNull()
  })

  it('charges an unmeasured call rather than counting it as free', async (): Promise<void> => {
    const id = await open()
    await sendIntakeMessage(id, 'hello')
    await claimIntakes({ by: 'daemon', limit: 1 })
    await recordIntakeReply(id, { kind: 'answer', answer: { kind: 'ask', text: 'go on' }, downgraded: null, costUsd: null })
    const row = await prisma.intake.findUniqueOrThrow({ where: { id } })
    expect(row.modelCostUsd).toBe(0)
    expect(row.unmeasuredCalls).toBe(1)
    expect(row.modelCalls).toBe(1)
  })

  it('records a draft, and the conversation becomes a card', async (): Promise<void> => {
    const repo = makeRepo()
    const id = await open()
    await sendIntakeMessage(id, `it is at ${repo}`)
    await claimIntakes({ by: 'daemon', limit: 1 })
    await recordIntakeReply(id, {
      kind: 'answer',
      answer: {
        kind: 'draft',
        text: 'Here is what I would create.',
        draft: {
          name: 'Public API',
          goal: 'Add rate limiting',
          repo: { mode: 'existing', path: repo },
          baseBranch: 'main',
          verifyCommands: [{ command: 'npm test', source: 'detected' }],
          setupCommands: [],
          budgetUsd: 20,
          provider: null,
          team: [],
        },
      },
      downgraded: null,
      costUsd: 0.03,
    })
    const view = await readIntake(id)
    if (!view.ok) throw new Error('unreachable')
    expect(view.value.status).toBe('drafted')
    expect(view.value.draft?.name).toBe('Public API')
  })

  it('leaves a note in the transcript when a proposal was discarded (R9)', async (): Promise<void> => {
    const id = await open()
    await sendIntakeMessage(id, 'hello')
    await claimIntakes({ by: 'daemon', limit: 1 })
    await recordIntakeReply(id, {
      kind: 'answer',
      answer: { kind: 'ask', text: 'Shall I use npm run e2e?' },
      downgraded: '"npm run e2e" is marked as detected and was not found in any repository',
      costUsd: 0.01,
    })
    const view = await readIntake(id)
    if (!view.ok) throw new Error('unreachable')
    expect(view.value.messages.at(-1)).toMatchObject({ role: 'fact' })
    expect(view.value.messages.at(-1)?.text).toContain('npm run e2e')
  })

  it('refuses a message once the twelve calls are gone (R12)', async (): Promise<void> => {
    const id = await open()
    await prisma.intake.update({ where: { id }, data: { modelCalls: INTAKE_MAX_MODEL_CALLS } })
    const sent = await sendIntakeMessage(id, 'one more')
    expect(sent.ok).toBe(false)
    if (sent.ok) throw new Error('unreachable')
    expect(sent.error.kind).toBe('intake_budget_exhausted')
  })

  it('abandons an open conversation and refuses to abandon one that created a project', async (): Promise<void> => {
    const id = await open()
    expect((await abandonIntake(id)).ok).toBe(true)
    expect((await prisma.intake.findUniqueOrThrow({ where: { id } })).status).toBe('abandoned')
    // The rows stay: the Projects page never lists intakes, so there is nothing to tidy.
    expect(await prisma.intakeMessage.count({ where: { intakeId: id } })).toBe(0)

    const other = await open()
    await prisma.intake.update({ where: { id: other }, data: { status: 'created' } })
    const refused = await abandonIntake(other)
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('unreachable')
    expect(refused.error.kind).toBe('intake_not_abandonable')
  })

  it('pins the draft seat cap to the verb that will enforce it', (): void => {
    // The domain cannot import `packages/control`; this file can import both, and it is the only
    // place the two numbers can be compared at all (M59 Task 1, INTAKE_MAX_RUNTIME_ROLES).
    expect(INTAKE_MAX_RUNTIME_ROLES).toBe(MAX_RUNTIME_ROLES)
  })
})
