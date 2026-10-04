import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  RUN_PROMPT_MAX_BYTES,
  cents,
  renderLeadBrief,
  renderLeadContinuation,
  renderLeadTurnNote,
  renderRunContext,
  requirementItemsSchema,
  type LeadTurn,
  type Manifest,
} from '@slave-of-ai/domain'
import { RunContextRefused } from '../runContext.js'
import { gitIn } from '../worktree.js'

/** What one lead turn's prompt is built from; gathered by the dispatch (`planLeadTurn`). */
export interface LeadContextInput {
  readonly runId: string
  readonly workspaceId: string
  readonly goalVersion: number
  readonly worktreePath: string
  readonly turn: LeadTurn
  /** The turn continues an existing session: the prompt is the turn's note alone. */
  readonly resumed: boolean
  /** A new session on a branch an earlier session already worked on (its transcript is gone). */
  readonly continuation: boolean
  /** What came back for this turn: a verifier's evidence, a failure, the reason it was interrupted. */
  readonly note: string | null
  readonly roster: readonly { readonly slug: string; readonly description: string }[]
  /** `unmeasured`: part of the lead's spend is not known yet (C7), so `spentUsd` is a floor. */
  readonly budget: { readonly totalUsd: number; readonly shareUsd: number; readonly spentUsd: number; readonly unmeasured: boolean } | null
  readonly timeLeftMs: number | null
}

/**
 * Lead-flow spec B3 (plan A L4): the one place a lead turn's prompt is assembled and RECORDED,
 * before the spawn -- `buildRunContext`'s contract, for the lead. A new session gets the whole
 * brief and the rules (`renderRunContext('lead', …)`); a continued session gets the turn's note,
 * because the session already holds the brief. No ask protocol in either (spec R-6). Refuses a
 * prompt past the one-argument byte budget, like every other kind.
 */
export async function buildLeadContext(input: LeadContextInput): Promise<{ readonly prompt: string }> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: input.workspaceId }, select: { baseBranch: true } })
  const set = await prisma.requirementSet.findUniqueOrThrow({ where: { workspaceId_goalVersion: { workspaceId: input.workspaceId, goalVersion: input.goalVersion } } })
  const requirements = requirementItemsSchema.parse(set.items)
  const source = {
    kind: 'lead_brief' as const,
    goalVersion: input.goalVersion,
    turn: input.turn,
    resumed: input.resumed,
    requirements: requirements.length,
    roster: input.roster.length,
  }
  const note = renderLeadTurnNote({
    kind: input.turn,
    note: input.note,
    baseBranch: workspace.baseBranch,
    // Cut down to the cent: the lead is never told it has a cent more than it has.
    budgetLeftUsd: input.budget === null ? null : Math.max(0, cents(input.budget.shareUsd - input.budget.spentUsd)),
    budgetUnmeasured: input.budget?.unmeasured === true,
    timeLeftMs: input.timeLeftMs,
  })

  let prompt: string
  let manifest: Manifest
  if (input.resumed) {
    prompt = note
    manifest = { kind: 'lead', sections: [source] }
  } else {
    const version = await prisma.goalVersion.findUniqueOrThrow({ where: { workspaceId_version: { workspaceId: input.workspaceId, version: input.goalVersion } }, select: { text: true } })
    const decisions = await prisma.goalDecision.findMany({ where: { workspaceId: input.workspaceId, goalVersion: input.goalVersion }, orderBy: { createdAt: 'asc' }, select: { title: true, decision: true } })
    const brief = renderLeadBrief({ goalVersion: input.goalVersion, goal: version.text, requirements, decisions, budget: input.budget, timeLeftMs: input.timeLeftMs, roster: input.roster })
    const text = input.continuation
      ? `${brief}\n\n${renderLeadContinuation({ lastCommits: await gitIn(input.worktreePath, 'log', '--oneline', '-15').catch(() => ''), then: note })}`
      : brief
    const rendered = renderRunContext('lead', [{ kind: 'lead_brief', text, source }])
    prompt = rendered.prompt
    manifest = rendered.manifest
  }

  const bytes = Buffer.byteLength(prompt, 'utf8')
  if (bytes > RUN_PROMPT_MAX_BYTES) throw new RunContextRefused('prompt_too_long', { limit: RUN_PROMPT_MAX_BYTES, length: bytes })
  const sections = manifest as unknown as Prisma.InputJsonValue
  await prisma.runContext.upsert({ where: { runId: input.runId }, create: { runId: input.runId, prompt, sections }, update: { prompt, sections } })
  return { prompt }
}
