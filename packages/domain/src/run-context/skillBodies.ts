import { sliceCodePoints } from '../profile/spec.js'

/**
 * Conductor spec R6: one skill's inlined text at most.
 *
 * Fix round 1: this bounds the skill's BODY as read off disk, before this module adds anything of
 * its own. It does NOT bound the `[skill text cut at ...]` marker {@link fitSkillBodies} appends to
 * a cut body (a truncated block's `text` can run a little over this number), and it says nothing
 * about the `### <name>` heading `skillsSectionText` (`apps/orchestrator/src/runContext.ts`) wraps
 * each block in -- that heading is rendered outside this module entirely, over the block this
 * function already decided fits.
 */
export const SKILL_BODY_MAX_CHARS = 8_000
/** Conductor spec R6: all inlined skill text of one run at most -- the sum of each block's `text`,
 *  cut marker included (the running `used` total below counts it), but still not the headings
 *  `skillsSectionText` adds around every block once they leave this module. */
export const SKILL_BODIES_MAX_CHARS = 24_000

export interface SkillBodyInput {
  readonly name: string
  readonly origin: 'persona' | 'person'
  /** The SKILL.md text after its front matter; null when there is none to read. */
  readonly body: string | null
}

/** What {@link fitSkillBodies} decided, in the shape `buildRunContext` renders and records. */
export interface FittedSkillBodies {
  readonly blocks: readonly { readonly name: string; readonly text: string; readonly truncated: boolean }[]
  readonly inlined: readonly string[]
  readonly truncated: readonly string[]
  /** Left out whole FOR LENGTH -- the total had no room, or (`dropLastSkillBody`) the whole prompt
   *  did not. The prompt says exactly that of these, so nothing else may land here. */
  readonly omitted: readonly string[]
  /** Installed, but with no instructions to show: the SKILL.md had nothing after its front matter,
   *  or could not be read at all (final review M2). Kept apart from `omitted` because the prompt
   *  line for `omitted` says "for length", which of these would be false. */
  readonly unreadable: readonly string[]
}

/**
 * Which skill texts go into a worker's prompt, in what order, and cut where (conductor spec R6).
 *
 * Persona defaults first -- they are what the persona IS -- then the person's grants, each group by
 * name so two runs of the same seat read the same prompt. A body over the per-skill cap is cut and
 * says so; a skill that no longer fits the total is omitted whole (half a skill reads as a
 * different skill). Its files stay copied in the worktree either way, so nothing is lost to a run
 * that goes looking.
 */
export function fitSkillBodies(skills: readonly SkillBodyInput[]): FittedSkillBodies {
  const ordered = [...skills].toSorted(
    (a, b) => (a.origin === b.origin ? a.name.localeCompare(b.name) : a.origin === 'persona' ? -1 : 1),
  )
  const blocks: { name: string; text: string; truncated: boolean }[] = []
  const truncated: string[] = []
  const omitted: string[] = []
  const unreadable: string[] = []
  let used = 0
  for (const skill of ordered) {
    const body = skill.body?.trim() ?? ''
    if (body === '') {
      unreadable.push(skill.name)
      continue
    }
    const cut = body.length > SKILL_BODY_MAX_CHARS
    const text = cut
      ? `${sliceCodePoints(body, SKILL_BODY_MAX_CHARS)}\n[skill text cut at ${SKILL_BODY_MAX_CHARS} characters; the full skill is in .claude/skills/${skill.name}]`
      : body
    if (used + text.length > SKILL_BODIES_MAX_CHARS) {
      omitted.push(skill.name)
      continue
    }
    used += text.length
    blocks.push({ name: skill.name, text, truncated: cut })
    if (cut) truncated.push(skill.name)
  }
  return { blocks, inlined: blocks.map((block) => block.name), truncated, omitted, unreadable }
}
