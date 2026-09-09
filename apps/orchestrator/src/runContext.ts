import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { skillRoots, skillSourceDir, type SkillRoots } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  PROFILE_MAX_CHARS,
  SECTION_ORDER,
  effectiveProfile,
  neutraliseMarkers,
  renderRunContext,
  type Manifest,
  type Section,
} from '@slave-of-ai/domain'
import type { ProviderKind } from '@slave-of-ai/providers'
import { askProtocolSection, inboxSection, rosterSection } from './inbox.js'

const execFileAsync = promisify(execFile)

/** Where a Claude Code run discovers the skills it was given, relative to its worktree root. */
export const SKILLS_DIR = '.claude/skills'

/**
 * The names this orchestrator copied into a worktree on the run before this one.
 *
 * The file is the whole reason the injection can be undone without `rm -rf`ing
 * `<worktree>/.claude/skills` (spec erratum E1): a repository may TRACK skills of its own in that
 * directory, and deleting them would show up as deletions in the slave's own diff. Only the names
 * listed here are removed.
 */
export const INJECTED_MARKER = '.slaveofai-injected.json'

/**
 * A dispatch refused before anything was spawned, because what the run would have been told is not
 * allowed to be sent.
 *
 * Thrown rather than returned so every call site's EXISTING failure path catches it: `tick.ts`'s
 * `startRun` records a run that failed to start (spec §13), `review.ts` treats it exactly as a diff
 * it could not produce, `planning.ts` as its own dispatch failure. Adding a `Result` here would
 * mean three new branches saying what those three catches already say.
 */
export class RunContextRefused extends Error {
  /** The only refusal today (M37 §7): a profile longer than the cap, which is reachable only when
   *  the cap was lowered after the text was written. */
  readonly kind: 'profile_too_long'
  readonly limit: number
  readonly length: number

  constructor(kind: 'profile_too_long', detail: { readonly limit: number; readonly length: number }) {
    super(
      `run context refused (${kind}): the effective profile is ${String(detail.length)} characters, ` +
        `over the ${String(detail.limit)} character limit`,
    )
    this.name = 'RunContextRefused'
    this.kind = kind
    this.limit = detail.limit
    this.length = detail.length
  }
}

export interface BuildRunContextInput {
  readonly runId: string
  readonly kind: Manifest['kind']
  readonly slaveId: string
  readonly workspaceId: string
  /** `null` for a planning run, which is about a workspace goal rather than a task. */
  readonly taskId: string | null
  /** The run's own worktree; `null` for planning, which runs in the primary checkout and therefore
   *  never has skills injected into it (spec erratum E4). */
  readonly worktreePath: string | null
  readonly provider: ProviderKind
  readonly reviewDiff?: {
    readonly text: string
    readonly base: string
    readonly head: string
    readonly capped: boolean
  }
  /** Test seam. Production passes nothing and gets `skillRoots()` -- which is itself redirectable
   *  through `SLAVEOFAI_SKILL_ROOTS_JSON` for the gate's real daemon subprocess. */
  readonly skillRoots?: SkillRoots
}

export interface BuiltRunContext {
  readonly prompt: string
  readonly manifest: Manifest
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** One assigned skill, as the builder needs it: the catalog's own record plus which provider it
 *  came from, which is what decides where its files are. */
export interface AssignedSkill {
  readonly name: string
  readonly description: string
  readonly providerName: string
  readonly missingSince: Date | null
}

/** What one dispatch's injection did, in the shape the `skills` section source records. */
export interface SkillInjection {
  readonly copied: readonly string[]
  readonly missing: readonly string[]
  readonly shadowedByRepo: readonly string[]
  readonly provider_unsupported: boolean
  readonly no_worktree: boolean
}

const isDirectory = (path: string): boolean => statSync(path, { throwIfNoEntry: false })?.isDirectory() === true

/** One path component, and not a traversal: what a directory name under `.claude/skills` may be. */
const isPlainSegment = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')

/** Whether git already tracks a path in this worktree. `ls-files --error-unmatch` exits non-zero
 *  for a pathspec matching nothing tracked, which is exactly the question -- and it answers it
 *  about the checked-out commit rather than about what happens to be on disk. */
async function repoTracks(worktreePath: string, relativePath: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', worktreePath, 'ls-files', '--error-unmatch', '--', relativePath])
    return true
  } catch {
    return false
  }
}

/**
 * Hides the injected paths from git, by appending to the file `git rev-parse --git-path
 * info/exclude` names.
 *
 * Not a `.gitignore` in the worktree (the plan's first draft, corrected by spec erratum E1): a
 * `.gitignore` is itself a file in the tree, so writing one would put the very diff this exists to
 * prevent in front of the merge.
 *
 * **Where that file actually is.** The plan expected `<common>/worktrees/<id>/info/exclude`, a
 * per-worktree file. It is not: `info/` is on git's common-directory list, so `--git-path
 * info/exclude` resolves to the repository-wide `<common>/info/exclude` even from inside a linked
 * worktree, and a file written under `.git/worktrees/<id>/` is read by nothing (verified against
 * real git before this was written). The patterns are therefore repository-wide, which is
 * acceptable only because of what they are: each names one assigned skill's directory (or this
 * module's own marker file) under `.claude/skills`, anchored at a worktree root, and git never
 * ignores a TRACKED file -- so the most they can hide anywhere is another worktree's copy of the
 * same injection.
 *
 * Each line is appended at most once, so redispatches -- and every other worktree of the same
 * repository -- do not grow the file.
 *
 * Split in two (fix round 1) so the path is resolved ONCE per injection while lines can be
 * appended per skill, BEFORE that skill is copied: a `cpSync` that throws half-way must leave a
 * directory git already cannot see.
 */
async function excludeFilePath(worktreePath: string): Promise<string> {
  const reported = (await execFileAsync('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'])).stdout.trim()
  return isAbsolute(reported) ? reported : resolve(worktreePath, reported)
}

/** Appends the lines that are not already there. Re-reads the file on every call rather than
 *  caching it: the file is shared by every worktree of the repository, so a concurrent dispatch's
 *  lines must not be clobbered by this one's idea of what it contained. */
function appendExcludeLines(excludePath: string, lines: readonly string[]): void {
  if (lines.length === 0) return
  let current = ''
  try {
    current = readFileSync(excludePath, 'utf8')
  } catch {
    current = ''
  }
  const present = new Set(current.split('\n'))
  const absent = lines.filter((line) => !present.has(line))
  if (absent.length === 0) return

  mkdirSync(dirname(excludePath), { recursive: true })
  const separator = current === '' || current.endsWith('\n') ? '' : '\n'
  writeFileSync(excludePath, `${current}${separator}${absent.join('\n')}\n`)
}

/**
 * Puts a slave's assigned skills where its runtime will find them, and takes back what the last
 * dispatch put there (M37 §4, spec erratum E1).
 *
 * Exported for its own test, and because it is the one part of the builder with a meaningful
 * result for a run kind whose manifest cannot carry it: `SECTION_ORDER.planning` has no `skills`
 * section, so a planning run's `no_worktree: true` is observable here and nowhere else.
 *
 * Never destructive beyond its own footprint: it removes the directories named in the marker file
 * it wrote last time and nothing else, and it copies nothing over a skill the repository itself
 * tracks -- that one is recorded as `shadowedByRepo`, because the runtime discovers the repo's own
 * copy anyway and overwriting it would put a diff in the slave's tree.
 */
export async function injectSkills(input: {
  readonly worktreePath: string | null
  readonly provider: ProviderKind
  readonly skills: readonly AssignedSkill[]
  readonly roots: SkillRoots
}): Promise<SkillInjection> {
  const nothing = { copied: [], missing: [], shadowedByRepo: [] } as const
  // Cursor has no skills mechanism at all (spec §9, a stated non-goal): copying files it will
  // never read would be a prompt that promises capabilities the run does not have.
  if (input.provider === 'cursor') return { ...nothing, provider_unsupported: true, no_worktree: false }
  if (input.worktreePath === null) return { ...nothing, provider_unsupported: false, no_worktree: true }

  const worktreePath = input.worktreePath
  const skillsDir = join(worktreePath, SKILLS_DIR)
  const markerPath = join(skillsDir, INJECTED_MARKER)

  let previouslyInjected: readonly string[] = []
  let markerExisted = false
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf8'))
    markerExisted = true
    if (Array.isArray(parsed)) previouslyInjected = parsed.filter((name): name is string => typeof name === 'string')
  } catch {
    // Absent, or written by something that is not this (a hand-edited file, a truncated write).
    // Either way there is nothing this dispatch may claim to have put there, so it removes nothing.
    previouslyInjected = []
  }
  for (const name of previouslyInjected) {
    // The marker is written by this function and lives inside the worktree, but it is still a file
    // on disk: a `..` in it must not be able to delete anything outside the skills directory.
    if (!isPlainSegment(name)) continue
    rmSync(join(skillsDir, name), { recursive: true, force: true })
  }

  const copied: string[] = []
  const missing: string[] = []
  const shadowedByRepo: string[] = []
  const excludePath = await excludeFilePath(worktreePath)
  const markerLine = `/${SKILLS_DIR}/${INJECTED_MARKER}`

  try {
    for (const skill of [...input.skills].toSorted((a, b) => a.name.localeCompare(b.name))) {
      // A skill's name is read from its own `SKILL.md` frontmatter (`syncSkillCatalog`), so it is
      // text from outside this system: one carrying a path separator would write outside the skills
      // directory. Refused as missing rather than sanitised -- a skill installed under a different
      // name from the one the catalog and the prompt use is not the skill that was assigned.
      if (!isPlainSegment(skill.name)) {
        missing.push(skill.name)
        continue
      }
      if (await repoTracks(worktreePath, `${SKILLS_DIR}/${skill.name}`)) {
        shadowedByRepo.push(skill.name)
        continue
      }
      const source = skill.missingSince !== null ? null : skillSourceDir(input.roots, skill.providerName, skill.name)
      if (source === null || !isDirectory(source)) {
        missing.push(skill.name)
        continue
      }

      const destination = join(skillsDir, skill.name)
      mkdirSync(skillsDir, { recursive: true })
      // Excluded BEFORE the copy, not after it (fix round 1): `cpSync` can throw part-way through
      // -- an unreadable file in the source is enough -- and the half-written directory it leaves
      // behind is untracked. Excluding it first is what keeps `git status --porcelain` empty for
      // `Checkpoint.dirtyFiles`, the slave's own `git add`, and the merge, whatever happens next.
      appendExcludeLines(excludePath, [markerLine, `/${SKILLS_DIR}/${skill.name}/`])
      try {
        cpSync(source, destination, { recursive: true })
      } catch (error) {
        // Best effort, and only ever this dispatch's own half-copy: leaving it would put a skill
        // directory in the worktree that no marker names, so nothing would ever remove it and the
        // runtime would discover a truncated skill. If the removal itself fails the directory is
        // at least already invisible to git, which is the property that matters most.
        try {
          rmSync(destination, { recursive: true, force: true })
        } catch {
          // Nothing further this dispatch can do about it; the throw below is the real news.
        }
        throw error
      }
      copied.push(skill.name)
    }
  } finally {
    // In a `finally` (fix round 1) so the marker tells the truth even when a copy threw: the
    // previous dispatch's directories are already gone from disk, so a marker still naming them
    // would make the NEXT dispatch's removal a lie. It names exactly what is on disk now.
    //
    // Written only when there is something to record, or something to un-record: a run with no
    // skills at all must not create a `.claude/` directory in a repository that has none.
    if (copied.length > 0 || markerExisted) {
      mkdirSync(skillsDir, { recursive: true })
      appendExcludeLines(excludePath, [markerLine])
      writeFileSync(markerPath, `${JSON.stringify(copied)}\n`)
    }
  }

  return { copied, missing, shadowedByRepo, provider_unsupported: false, no_worktree: false }
}

/** The heading-plus-body shape every section this file writes shares, ending in the `---` rule
 *  M36's own preamble sections established as the boundary between one section and the next. */
const block = (heading: string, body: readonly string[]): string => [heading, '', ...body, '', '---'].join('\n')

/**
 * What the slave is told about its skills.
 *
 * Empty -- and therefore absent from both the prompt and the manifest -- only when the slave has no
 * assigned skills at all. When it HAS some and none of them could be installed (all missing, or a
 * Cursor run, or a run with no worktree), the section still says so in one line rather than
 * vanishing: `renderRunContext` drops an empty section from the manifest too, and that is exactly
 * the case where an operator most needs `missing`/`provider_unsupported` on the record. No missing
 * skill is ever NAMED to the model (spec §4) -- naming one would send the run looking for it.
 */
function skillsSectionText(
  offered: readonly { readonly name: string; readonly description: string }[],
  assignedCount: number,
): string {
  if (assignedCount === 0) return ''
  if (offered.length === 0) {
    return block('SKILLS', ['None of the skills assigned to you are installed in this checkout. Work without them.'])
  }
  return block('SKILLS AVAILABLE IN THIS CHECKOUT', [
    'These are installed under `.claude/skills` in the worktree you are working in. Invoke one by',
    'name when it fits what you are doing; nothing here is compulsory.',
    '',
    // Another party's text: a skill description is written wherever the skill came from, so it
    // cannot be allowed to carry a live protocol marker (M37 §1).
    ...offered.map((skill) => `- ${skill.name}: ${neutraliseMarkers(skill.description)}`),
  ])
}

/**
 * The one place a run's prompt is assembled (M37 §1, "one builder"), and the one place it is
 * recorded.
 *
 * Everything a run is told comes from here: the four builders this replaced (`buildPrompt` and
 * `withPreamble` in `tick.ts`, `buildReviewPrompt` in `review.ts`, `buildPlanningPrompt` in
 * `planning.ts`) each knew about one kind of run and none of them knew who the slave was.
 *
 * Ordering and omission are the pure renderer's (`renderRunContext`, `@slave-of-ai/domain`); this
 * function does the gathering and the two side effects a prompt cannot be honest without -- the
 * skills it names are copied into the worktree BEFORE the row is written, and the row is written
 * BEFORE the caller spawns anything, so a run that started always has a record of what it saw.
 *
 * The upsert is keyed on `runId`: a redispatch of the same run (after `failToStart`) rewrites its
 * one row rather than adding a second (spec §7).
 */
export async function buildRunContext(input: BuildRunContextInput): Promise<BuiltRunContext> {
  const slave = await prisma.slave.findUniqueOrThrow({
    where: { id: input.slaveId },
    include: {
      companySlave: { include: { template: true } },
      skills: { include: { skill: { include: { provider: true } } } },
    },
  })
  const task =
    input.taskId === null
      ? null
      : await prisma.task.findUniqueOrThrow({
          where: { id: input.taskId },
          select: { id: true, title: true, description: true, lastRejectionReason: true },
        })
  const workspace =
    input.kind === 'planning'
      ? await prisma.workspace.findUniqueOrThrow({ where: { id: input.workspaceId }, select: { goal: true } })
      : null

  const order = SECTION_ORDER[input.kind]
  const sections: Section[] = []

  // 1. Who the slave is. Re-checked against the cap here and not only at write (spec §7): a
  // profile written while the cap was higher is unsendable, and the honest thing to do with it is
  // refuse the dispatch rather than truncate a persona halfway through a sentence.
  const profile = effectiveProfile(slave)
  if (profile !== null) {
    if (profile.text.length > PROFILE_MAX_CHARS) {
      throw new RunContextRefused('profile_too_long', { limit: PROFILE_MAX_CHARS, length: profile.text.length })
    }
    sections.push({
      kind: 'profile',
      text: block('WHO YOU ARE', [neutraliseMarkers(profile.text)]),
      // The hash is of the RAW text, not the neutralised rendering: it is there so a reader can
      // tell whether two runs saw the same profile, and that is a question about the stored text.
      source: { kind: 'profile', origin: profile.origin, sha256: sha256(profile.text) },
    })
  }

  // 2. Who else is here, what they asked, and how to ask them. Implementation runs only --
  // `ask.ts` refuses an ask from a review run, and teaching a move that is always refused is a lie.
  if (input.kind === 'implementation') {
    const roster = await rosterSection(input.slaveId, input.workspaceId)
    if (roster !== null) sections.push(roster)
    const inbox = await inboxSection(input.slaveId)
    if (inbox !== null) sections.push(inbox)
    // Offered only alongside a roster: with nobody to address, `recipientCanAnswer` refuses every
    // recipient the slave could name, and an offer the system always turns down is worse than none.
    if (roster !== null) sections.push(askProtocolSection())
  }

  // 3. What it can do. Injected for every kind (the flags are part of the record), but rendered
  // only where the run kind's order has a place for it -- planning has none (erratum E4).
  const assigned: readonly AssignedSkill[] = slave.skills.map((link) => ({
    name: link.skill.name,
    description: link.skill.description,
    providerName: link.skill.provider.name,
    missingSince: link.skill.missingSince,
  }))
  const injection = await injectSkills({
    worktreePath: input.worktreePath,
    provider: input.provider,
    skills: assigned,
    roots: input.skillRoots ?? skillRoots(),
  })
  if (order.includes('skills')) {
    const descriptionOf = new Map(assigned.map((skill) => [skill.name, skill.description]))
    // Both halves are discoverable by the runtime: one because this dispatch copied it, the other
    // because the repository ships it. A missing skill is deliberately absent -- naming a skill
    // that is not there would send the run looking for it.
    const offered = [...injection.copied, ...injection.shadowedByRepo]
      .toSorted((a, b) => a.localeCompare(b))
      .map((name) => ({ name, description: descriptionOf.get(name) ?? '' }))
    sections.push({
      kind: 'skills',
      text: skillsSectionText(offered, assigned.length),
      source: { kind: 'skills', ...injection },
    })
  }

  // 4. What it is being asked to do.
  if (task !== null && order.includes('task')) {
    sections.push({
      kind: 'task',
      text: `Task: ${task.title}\n\n${task.description}`,
      source: { kind: 'task', taskId: task.id },
    })
    // The whole point of spec §8's loop: a rework is supposed to act on why the last attempt was
    // rejected, and one that arrives without it is just a retry. Never on a review run, whose
    // order has no place for it -- the reviewer judges this diff, not the last one.
    if (task.lastRejectionReason !== null && order.includes('rejection')) {
      sections.push({
        kind: 'rejection',
        text: `A previous attempt was rejected. Address this before anything else:\n${task.lastRejectionReason}`,
        source: { kind: 'rejection', taskId: task.id },
      })
    }
  }

  if (input.reviewDiff !== undefined && order.includes('review_diff')) {
    const diff = input.reviewDiff
    sections.push({
      kind: 'review_diff',
      text: `DIFF (base...branch):\n\`\`\`diff\n${diff.text}\n\`\`\``,
      source: { kind: 'review_diff', base: diff.base, head: diff.head, capped: diff.capped },
    })
  }

  if (workspace !== null) {
    const goal = workspace.goal ?? ''
    sections.push({
      kind: 'planning_goal',
      text: goal === '' ? '' : `GOAL: ${goal}`,
      source: { kind: 'planning_goal', sha256: sha256(goal) },
    })
  }

  const { prompt, manifest } = renderRunContext(input.kind, sections)

  // The row, before the caller spawns anything (spec §1, "record before spawn"). Keyed on `runId`,
  // so a redispatch of the same run rewrites its one row instead of adding a second.
  //
  // The cast is the one `appendEvent` uses for `ExecutionEvent.payload`: `Manifest` is a readonly
  // structure of plain data, which is a valid `Json` value, but not assignable to Prisma's
  // mutable-array `InputJsonValue` without it.
  const sectionsJson = manifest as unknown as Prisma.InputJsonValue
  await prisma.runContext.upsert({
    where: { runId: input.runId },
    create: { runId: input.runId, prompt, sections: sectionsJson },
    update: { prompt, sections: sectionsJson },
  })

  return { prompt, manifest }
}
