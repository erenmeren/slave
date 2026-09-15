import { prisma } from '@slave-of-ai/db/client'
import { INTAKE_ANSWER_MARKER, INTAKE_PER_CALL_CAP_USD } from '@slave-of-ai/domain'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { openIntake, readIntake, sendIntakeMessage } from '../../src/intake.js'
import { drainIntakeCalls, tickIntakes } from '../../src/intakeTick.js'
import type { ModelDecider } from '../../src/simulation/llm.js'

const answering = (body: unknown): ModelDecider => {
  const calls: { prompt: string; maxBudgetUsd: number; model: string }[] = []
  const decider: ModelDecider = async (input) => {
    calls.push({ prompt: input.prompt, maxBudgetUsd: input.maxBudgetUsd, model: input.model })
    return { kind: 'answer', text: JSON.stringify({ intakeAnswer: body }), costUsd: 0.02, tokens: null, numTurns: 1 }
  }
  return Object.assign(decider, { calls })
}

describe('tickIntakes', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "IntakeMessage", "Intake", "InstallationSettings" RESTART IDENTITY CASCADE')
  })

  afterAll(async (): Promise<void> => {
    await drainIntakeCalls()
    await prisma.$disconnect()
  })

  const waiting = async (text = 'I want rate limiting'): Promise<string> => {
    const opened = await openIntake()
    if (!opened.ok) throw new Error('openIntake refused')
    await sendIntakeMessage(opened.value.id, text)
    return opened.value.id
  }

  it('answers a waiting conversation and hands the turn back to the person', async (): Promise<void> => {
    const id = await waiting()
    const decider = answering({ kind: 'ask', text: 'Where is the repository?' })
    const report = await tickIntakes({ now: new Date(), by: 'test', model: 'claude-sonnet-5', modelDecider: decider })
    expect(report.startedModelCalls).toBe(1)
    await drainIntakeCalls()

    const view = await readIntake(id)
    if (!view.ok) throw new Error('unreachable')
    expect(view.value.status).toBe('open')
    expect(view.value.messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Where is the repository?' })
  })

  it('asks the model with the marker, the transcript and the per-call cap', async (): Promise<void> => {
    await waiting('build me a thing')
    const decider = answering({ kind: 'ask', text: 'go on' })
    await tickIntakes({ now: new Date(), by: 'test', model: 'claude-sonnet-5', modelDecider: decider })
    await drainIntakeCalls()
    const call = (decider as unknown as { calls: { prompt: string; maxBudgetUsd: number; model: string }[] }).calls[0]
    expect(call?.prompt).toContain(INTAKE_ANSWER_MARKER)
    expect(call?.prompt).toContain('build me a thing')
    expect(call?.maxBudgetUsd).toBe(INTAKE_PER_CALL_CAP_USD)
    expect(call?.model).toBe('claude-sonnet-5')
  })

  it('claims NOTHING without a decider, and says so', async (): Promise<void> => {
    const id = await waiting()
    const report = await tickIntakes({ now: new Date(), by: 'test', model: 'claude-sonnet-5' })
    expect(report).toMatchObject({ due: 1, skippedNoDecider: 1, startedModelCalls: 0 })
    // The row is untouched: claiming one this pass cannot answer would strand it for five minutes.
    expect((await prisma.intake.findUniqueOrThrow({ where: { id } })).status).toBe('awaiting_reply')
  })

  it('does not start a second call for a conversation whose first is still out', async (): Promise<void> => {
    await waiting()
    let release = (): void => {}
    const slow: ModelDecider = async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { kind: 'answer', text: JSON.stringify({ intakeAnswer: { kind: 'ask', text: 'later' } }), costUsd: null, tokens: null, numTurns: 1 }
    }
    const first = await tickIntakes({ now: new Date(), by: 'test', model: 'm', modelDecider: slow })
    expect(first.startedModelCalls).toBe(1)
    const second = await tickIntakes({ now: new Date(), by: 'test', model: 'm', modelDecider: slow })
    expect(second.startedModelCalls).toBe(0)
    release()
    await drainIntakeCalls()
  })

  it('never carries more calls at once than it was allowed', async (): Promise<void> => {
    await Promise.all([waiting('one'), waiting('two'), waiting('three')])
    let started = 0
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: ModelDecider = async () => {
      started += 1
      await gate
      return { kind: 'answer', text: JSON.stringify({ intakeAnswer: { kind: 'ask', text: 'later' } }), costUsd: null, tokens: null, numTurns: 1 }
    }
    const report = await tickIntakes({ now: new Date(), by: 'test', model: 'm', modelDecider: slow, maxConcurrentModelCalls: 2 })
    expect(report.startedModelCalls).toBe(2)
    expect(started).toBe(2)
    release()
    await drainIntakeCalls()
  })

  it('charges a failed call and tells the person something they can act on', async (): Promise<void> => {
    const id = await waiting()
    const failing: ModelDecider = async () => ({ kind: 'failed', reason: 'the CLI died', costUsd: null, tokens: null })
    await tickIntakes({ now: new Date(), by: 'test', model: 'm', modelDecider: failing })
    await drainIntakeCalls()

    const row = await prisma.intake.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('open')
    expect(row.modelCalls).toBe(1)
    expect(row.unmeasuredCalls).toBe(1)
    const last = await prisma.intakeMessage.findFirstOrThrow({ where: { intakeId: id }, orderBy: { seq: 'desc' } })
    expect(last.role).toBe('assistant')
    expect(last.text).not.toContain('JSON')
  })

  it('treats an isolation breach as an unusable answer rather than a draft', async (): Promise<void> => {
    const id = await waiting()
    const breaching: ModelDecider = async () => ({ kind: 'isolation_breach', tools: ['Write'], costUsd: 0.01, tokens: null })
    await tickIntakes({ now: new Date(), by: 'test', model: 'm', modelDecider: breaching })
    await drainIntakeCalls()
    const view = await readIntake(id)
    if (!view.ok) throw new Error('unreachable')
    expect(view.value.status).toBe('open')
    expect(view.value.draft).toBeNull()
  })

  it('records a draft and leaves the conversation ready to create', async (): Promise<void> => {
    const id = await waiting()
    const decider = answering({
      kind: 'draft',
      text: 'Here is what I would create.',
      draft: {
        name: 'Brand New',
        goal: 'a new service',
        repo: { mode: 'new', path: null },
        baseBranch: 'main',
        verifyCommands: [{ command: 'npm test', source: 'draft' }],
        setupCommands: [],
        budgetUsd: null,
        provider: null,
        team: [],
      },
    })
    await tickIntakes({ now: new Date(), by: 'test', model: 'm', modelDecider: decider })
    await drainIntakeCalls()
    const view = await readIntake(id)
    if (!view.ok) throw new Error('unreachable')
    expect(view.value.status).toBe('drafted')
    expect(view.value.draft?.name).toBe('Brand New')
  })
})
