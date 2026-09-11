import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runbookForWorkspace, skillRoots, skillSourceDir, type SkillRoots } from '@slave-of-ai/control'
import { prisma, type Prisma } from '@slave-of-ai/db/client'
import {
  PROFILE_MAX_CHARS,
  SECTION_ORDER,
  TERMINAL,
  defuseRoutingLiterals,
  effectiveProfile,
  handoffCanonicalJson,
  neutraliseMarkers,
  parseHandoffContract,
  renderHandoff,
  renderRunContext,
  stageOrder,
  type Manifest,
  type Runbook,
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
  /**
   * Present only on a RE-plan run (M40 §5): the goal changed under a board that already exists,
   * and this run is being asked for a delta rather than for a plan.
   *
   * The run `kind` stays `planning` (spec erratum E2) -- what differs is this section, the board
   * it carries, and the trailer `renderRunContext` chooses because of it. `previousVersion` is
   * `version - 1` and may be 0, which is "there is no previous version to show": a goal written
   * straight into the column before M40, or the very first one ever set.
   */
  readonly replan?: {
    readonly previousVersion: number
    readonly version: number
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
  const copied: string[] = []
  const missing: string[] = []
  // A set, not an array: one name reaches it from both loops below when a skill that is still
  // assigned is also one the repository has started tracking since the last dispatch.
  const shadowed = new Set<string>()

  for (const name of previouslyInjected) {
    // The marker is written by this function and lives inside the worktree, but it is still a file
    // on disk: a `..` in it must not be able to delete anything outside the skills directory.
    if (!isPlainSegment(name)) continue
    // Trackedness can change UNDER a directory this orchestrator injected (final review): the run
    // itself can `git add -f .claude/skills/<name>` and commit it, or a branch that ships that
    // directory can be checked out into this worktree. Removing it then would put a DELETION in
    // the slave's own `git status` -- and therefore in `Checkpoint.dirtyFiles`, in the run's own
    // commit, and in the merge. It is the repository's directory now, not this dispatch's, so it
    // is left exactly where the copy path leaves a tracked skill: alone, and named in the manifest.
    if (await repoTracks(worktreePath, `${SKILLS_DIR}/${name}`)) {
      shadowed.add(name)
      continue
    }
    rmSync(join(skillsDir, name), { recursive: true, force: true })
  }

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
        shadowed.add(skill.name)
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

  // Sorted, because the two loops that fill it visit names in different orders (the marker's, then
  // the assignment's) and the manifest is read by a human comparing one run against another.
  const shadowedByRepo = [...shadowed].toSorted((a, b) => a.localeCompare(b))
  return { copied, missing, shadowedByRepo, provider_unsupported: false, no_worktree: false }
}

/** The heading-plus-body shape every section this file writes shares, ending in the `---` rule
 *  M36's own preamble sections established as the boundary between one section and the next. */
const block = (heading: string, body: readonly string[]): string => [heading, '', ...body, '', '---'].join('\n')

/** One line, whatever the source did: every run of whitespace (a newline included) becomes a single
 *  space. For a field that is rendered INSIDE a line whose shape means something -- see the re-plan
 *  board below, where a newline would let a title forge a row. */
const singleLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/**
 * What the slave is told about its skills.
 *
 * Empty -- and therefore absent from both the prompt and the manifest -- only when the slave has no
 * assigned skills at all. When it HAS some and none of them could be installed (all missing, or a
 * Cursor run, or a run with no worktree), the section still says so in one line rather than
 * vanishing: `renderRunContext` drops an empty section from the manifest too, and that is exactly
 * the case where an operator most needs `missing`/`provider_unsupported` on the record. No missing
 * skill is ever NAMED to the model (spec §4) -- naming one would send the run looking for it.
 *
 * "Nothing is installed" has two different reasons and therefore two different sentences (final
 * review). On a Cursor run nothing is installed because the RUNTIME has no skills mechanism at all
 * (spec §9), and telling that run its skills "are not installed in this checkout" invites it to go
 * looking for a mechanism that does not exist. The wording matches the operator-facing one in
 * `apps/web/src/lib/runContextSummary.ts`, so the prompt and the run page say the same thing.
 */
function skillsSectionText(
  offered: readonly { readonly name: string; readonly description: string }[],
  assignedCount: number,
  injection: SkillInjection,
): string {
  if (assignedCount === 0) return ''
  if (offered.length === 0) {
    if (injection.provider_unsupported) {
      return block('SKILLS', ['This runtime has no skills mechanism, so none were installed for you. Work without them.'])
    }
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
 * What a re-plan run is told about the change it has to answer (M40 §3).
 *
 * Three things, in the order a manager needs them: the requirement as it WAS, the requirement as
 * it now IS, and the board that was built for the old one. The board is every task that is not
 * done, failed or cancelled -- the same set the trigger compares versions over, and the same set
 * `applyCancelPolicy` will judge the answer against, so the manager is never shown a task it
 * cannot ask anything about. Each line carries the id (which is the KEY a delta names), the
 * status (so "you never cancel work that is running" is checkable rather than a rule on trust)
 * and the goal version that produced it.
 *
 * Every foreign text goes through `neutraliseMarkers` (M37 §1): two of these are goals a human
 * wrote and the titles are what a MODEL wrote on the last plan, and a live protocol marker in any
 * of them would let one prompt park or answer on this run's behalf.
 */
async function replanSection(input: {
  readonly workspaceId: string
  readonly goal: string
  readonly previousVersion: number
  readonly version: number
}): Promise<Section> {
  // `previousVersion` 0 is "there is no earlier version": a goal hand-seeded into the column, or
  // the first one ever set. A missing ROW is treated the same way, deliberately -- both mean this
  // prompt has no previous requirement to quote, and inventing one would put a sentence nobody
  // wrote in front of the manager.
  const previous =
    input.previousVersion <= 0
      ? null
      : await prisma.goalVersion.findUnique({
          where: { workspaceId_version: { workspaceId: input.workspaceId, version: input.previousVersion } },
          select: { text: true },
        })
  const previousText = previous?.text ?? ''

  const board = await prisma.task.findMany({
    where: { workspaceId: input.workspaceId, status: { notIn: [...TERMINAL] } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, status: true, goalVersion: true },
  })

  // The heading is the honest one for each case (final review, Minor 2). With no previous version
  // there is nothing this goal changed FROM: the board was made by hand, or seeded, before the
  // requirement existed (spec §5 clarified), and telling a manager "the goal changed" over a board
  // nobody derived from a goal is a claim the row cannot support.
  const heading = input.previousVersion <= 0 ? 'THE GOAL WAS SET, and this board predates it' : 'THE GOAL CHANGED'

  const text = block(heading, [
    ...(previousText === ''
      ? ['Previous goal: (no previous version recorded)']
      : [`Previous goal (v${String(input.previousVersion)}):`, neutraliseMarkers(previousText)]),
    '',
    `New goal (v${String(input.version)}):`,
    neutraliseMarkers(input.goal),
    '',
    'Current board (every task that is not done, failed or cancelled):',
    ...(board.length === 0
      ? ['(nothing unfinished is on the board)']
      : board.map(
          (task) =>
            // The title is flattened to ONE line (final review, Minor 4): a board line is a record
            // whose shape the manager reads ids and statuses off, and a title carrying a newline
            // could otherwise write a further `- <id> [ready] ...` line for a task that does not
            // exist -- forging the board out of a field a model wrote on the last plan.
            `- ${task.id} [${task.status}] ${singleLine(neutraliseMarkers(task.title))} ` +
            `(${task.goalVersion === null ? 'unstamped' : `goal v${String(task.goalVersion)}`})`,
        )),
  ])

  return {
    kind: 'replan',
    text,
    // Both hashes are of the RAW texts, like every other `sha256` in this file: they exist so a
    // reader can tell whether two runs saw the same requirement, and that is a question about the
    // stored text rather than about the rendering.
    source: {
      kind: 'replan',
      previousVersion: input.previousVersion,
      version: input.version,
      previousSha256: sha256(previousText),
      sha256: sha256(input.goal),
      boardTaskIds: board.map((task) => task.id),
    },
  }
}

/** How many keys a planning prompt is shown. The taxonomy is ~50 rows today and an operator may
 *  add more; a prompt is not the place for an unbounded list, and `capped` on the source is what
 *  tells a reader the planner was shown a subset. */
const CAPABILITY_KEYS_IN_PROMPT = 80

/**
 * The vocabulary a plan may be written in (M47 R3, plan erratum E3).
 *
 * A SECTION rather than part of `PLANNING_GRAPH_INSTRUCTIONS`: that constant is pure, static and
 * pinned byte-for-byte, and this list is per-workspace data read out of a table. It renders LAST
 * (`SECTION_ORDER.planning`), so the keys sit directly above the trailer that asks for them.
 *
 * The text must never contain the quoted literals `"verdict"`, `"replan"` or `"task graph"`: the
 * fake CLI selects its review, re-plan and planning arms on exactly those, and a first-plan prompt
 * carrying `"replan"` would be answered with a delta fixture. A test pins it.
 */
async function capabilitiesSection(): Promise<Section | null> {
  const rows = await prisma.capability.findMany({ orderBy: { key: 'asc' }, select: { key: true, label: true } })
  if (rows.length === 0) return null
  const shown = rows.slice(0, CAPABILITY_KEYS_IN_PROMPT)
  return {
    kind: 'capabilities',
    text: block('CAPABILITIES YOU MAY ASK FOR', [
      'Each task in the JSON object you return may carry a "capabilities" array. Use ONLY the keys',
      'below, exactly as they are spelt; a key that is not here is dropped. A task may name none,',
      'in which case give it a "role" instead.',
      '',
      ...shown.map((row) => `- ${row.key}: ${row.label}`),
      ...(rows.length > shown.length ? ['', `(${String(rows.length - shown.length)} further keys are not listed.)`] : []),
    ]),
    source: { kind: 'capabilities', keys: shown.map((row) => row.key), capped: rows.length > shown.length },
  }
}

/**
 * The contract this run is being handed (M48 R4).
 *
 * Right after the `task` section on BOTH the implementation and the review order: a reviewer that
 * judges a diff against a paragraph is what this milestone ends, and the reviewer reads the same
 * row the worker did.
 *
 * `null` for a task with no contract -- a hand-made task, or one planned before this milestone --
 * and for a column that will not parse. The second is deliberate and is not silent for an operator
 * (plan decision D9): `renderHandoff` never sees a half-contract, and the prompt a worker gets is
 * exactly the one it would have got before M48 rather than a dispatch that throws. The section's
 * absence from the manifest is the record.
 *
 * The hash is over the contract's CANONICAL JSON, not over the rendered text and not folded into
 * `task.sha256` (spec R4, plan decision D2): that hash is `title + '\n' + description`, and M37/M41
 * both pin it.
 */
function handoffSection(task: { readonly id: string; readonly handoff: unknown }): Section | null {
  const parsed = parseHandoffContract(task.handoff)
  if (!parsed.ok) return null
  return {
    kind: 'handoff',
    // The whole section text, heading and closing rule included, comes from the domain: a test in
    // `packages/domain` pins it byte for byte, the way `REVIEW_VERDICT_INSTRUCTIONS` is pinned.
    text: renderHandoff(parsed.value),
    source: { kind: 'handoff', taskId: task.id, sha256: sha256(handoffCanonicalJson(parsed.value)) },
  }
}

/** The shape both planning sections ask for, spelt once. Deliberately NOT inside
 *  `PLANNING_GRAPH_INSTRUCTIONS`: that constant is byte-pinned against its pre-M37 source, and the
 *  literal `"task graph"` in it is what the fake CLI's planning arm selects on. */
const HANDOFF_SHAPE_LINES: readonly string[] = [
  'Each task in the JSON object you return carries, beside its other fields:',
  '  "stage": "<one of the stage keys above>",',
  '  "handoff": {"objective":"...","expectedOutput":"...","acceptanceCriteria":["..."],',
  '              "knownConstraints":["..."],"evidenceRequired":["..."],"contextReferences":["..."]}',
  'objective and expectedOutput are required; the four lists may be empty and are capped at 12',
  'items. Every string is at most 400 characters. A task with no handoff is a task nobody can',
  'review against anything.',
]

/**
 * What a planning run is told about the way this project works (M48 R4).
 *
 * A SECTION rather than part of `PLANNING_GRAPH_INSTRUCTIONS`, for `capabilities`' own reason (M47
 * plan erratum E3): that constant is pure, static and byte-pinned, and a runbook is per-workspace
 * data. It renders after `capabilities`, so the prompt reads goal, vocabulary, process, request.
 *
 * The stages are in {@link stageOrder}, never in row order, so two runs over one runbook are shown
 * the same list. Every piece of a stage's own text goes through `defuseRoutingLiterals` and
 * `neutraliseMarkers` -- a runbook row is written by a person or translated from a persona, and a
 * stage objective quoting `"verdict"` would answer this planning run with a review fixture.
 */
function runbookSection(runbook: Runbook): Section | null {
  const ordered = stageOrder(runbook.stages)
  if (ordered.length === 0) return null
  const safe = (text: string): string => defuseRoutingLiterals(neutraliseMarkers(singleLine(text)))
  return {
    kind: 'runbook',
    text: block('THE WAY THIS PROJECT WORKS', [
      `This project follows the "${safe(runbook.name)}" runbook: ${safe(runbook.description)}`,
      'Adapt it into the task graph. Give every task you return a "stage" naming one of the keys',
      'below, and a "handoff" object. You may skip a stage this goal does not need; you may give one',
      'stage several tasks. Nothing is refused for skipping a stage -- the gap is simply reported.',
      '',
      ...ordered.flatMap((stage) => [
        `- ${stage.key}: ${safe(stage.title)} -- ${safe(stage.objective)}`,
        ...(stage.capabilities.length === 0 ? [] : [`    capabilities: ${stage.capabilities.join(', ')}`]),
        ...(stage.dependsOn.length === 0 ? [] : [`    after: ${stage.dependsOn.join(', ')}`]),
        ...(stage.expectedOutputs.length === 0 ? [] : [`    leaves behind: ${stage.expectedOutputs.map(safe).join('; ')}`]),
      ]),
      '',
      ...HANDOFF_SHAPE_LINES,
    ]),
    source: { kind: 'runbook', runbookId: runbook.id, key: runbook.key, stageKeys: ordered.map((stage) => stage.key) },
  }
}

/** The same request, minus the stages, for a project that has adopted no runbook (M48 R4). The
 *  contract is worth asking for whether or not a process was chosen. */
function handoffProtocolSection(): Section {
  return {
    kind: 'handoff_protocol',
    text: block('WHAT EVERY TASK MUST HAND OVER', [
      'This project has not adopted a runbook, so you decide the shape of the work. Every task you',
      'return still carries a handoff: what it is for, what exists when it is done, and how anybody',
      'can tell.',
      '',
      ...HANDOFF_SHAPE_LINES.filter((line) => !line.startsWith('  "stage"')),
    ]),
    source: { kind: 'handoff_protocol' },
  }
}

/**
 * The process section a planning prompt carries: the adopted runbook, or -- with none adopted --
 * the contract alone (M48 R4). NEVER both: `SECTION_ORDER.planning` has a slot for each, and
 * exactly one is produced here, which is what makes the mutual exclusion a property of this
 * function rather than of the renderer.
 *
 * Shared by {@link buildRunContext} and {@link renderReplanPreview}, so the preview an operator
 * reads IS the prompt the run would be given.
 */
async function processSection(workspaceId: string): Promise<Section | null> {
  const runbook = await runbookForWorkspace(workspaceId)
  return runbook === null ? handoffProtocolSection() : runbookSection(runbook)
}

/** The `planning_goal` section: the requirement itself, and WHICH version of it (M40 §1). Shared by
 *  the builder below and by {@link renderReplanPreview}, so an operator previewing a re-plan reads
 *  the same first section the run would be given. */
function planningGoalSection(goal: string, version: number): Section {
  return {
    kind: 'planning_goal',
    text: goal === '' ? '' : `GOAL: ${goal}`,
    source: { kind: 'planning_goal', sha256: sha256(goal), version },
  }
}

/**
 * The re-plan prompt a run for this version WOULD be given, rendered and thrown away (M40 §6,
 * `replan-status --prompt`).
 *
 * Deliberately not `buildRunContext` with a flag: that function's contract is that it RECORDS what
 * it renders, before a spawn, and a preview has no run to record against. Writing a `RunContext`
 * row for a run that does not exist would put a prompt nobody was ever given into the one table
 * that answers "what was this run told".
 *
 * What it therefore leaves out is the persona: which manager takes a planning run is decided at
 * dispatch, by who is free, so a preview that picked one would be showing an operator a profile
 * section a different worker's run will not carry. Everything the RE-PLAN is about -- the goal, its
 * version, the previous wording, the board, and the re-plan trailer `renderRunContext` chooses
 * because a `replan` section is present -- is exactly what the run gets.
 */
export async function renderReplanPreview(input: {
  readonly workspaceId: string
  readonly previousVersion: number
  readonly version: number
}): Promise<string> {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: input.workspaceId },
    select: { goal: true, goalVersion: true },
  })
  const goal = workspace.goal ?? ''
  const sections: Section[] = [
    planningGoalSection(goal, workspace.goalVersion),
    await replanSection({
      workspaceId: input.workspaceId,
      goal,
      previousVersion: input.previousVersion,
      version: input.version,
    }),
  ]
  // On the same terms as a real run (E3), so the preview a person reads IS the prompt the run
  // would be given -- keys included.
  const capabilities = await capabilitiesSection()
  if (capabilities !== null) sections.push(capabilities)
  // M48 R4, on the same terms and for the same reason: the process a re-plan is asked to follow is
  // part of the prompt, so it is part of the preview.
  const process = await processSection(input.workspaceId)
  if (process !== null) sections.push(process)
  return renderRunContext('planning', sections).prompt
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
          // M48 R4: `handoff` rides along for the section below. `stage` deliberately does NOT --
          // a stage is a label, and naming it to a worker would invite it to reason about a
          // process it cannot change.
          select: { id: true, title: true, description: true, lastRejectionReason: true, handoff: true },
        })
  const workspace =
    input.kind === 'planning'
      ? await prisma.workspace.findUniqueOrThrow({
          where: { id: input.workspaceId },
          // M40 t1: `goalVersion` rides along so the `planning_goal` source can say WHICH
          // `GoalVersion` row this prompt's goal text is (Task 3 adds the `replan` section itself).
          select: { goal: true, goalVersion: true },
        })
      : null

  const order = SECTION_ORDER[input.kind]
  const sections: Section[] = []

  // A re-plan is a `planning` run and nothing else (M40 §3, erratum E2). Asked for one on a kind
  // whose order has no place for the section, this THROWS rather than dropping it (fix round 1,
  // Minor 3): silently rendering the first-plan trailer would send a manager a board it was never
  // shown and a prompt asking for a task graph, and the caller would have no way to know.
  if (input.replan !== undefined && !order.includes('replan')) {
    throw new Error(`a replan section was asked for on a ${input.kind} run, whose section order has no place for one`)
  }

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
    //
    // Filtered to what is actually ASSIGNED (final review): `shadowedByRepo` can now also name a
    // directory an earlier dispatch injected that the repository has since begun tracking, and
    // that skill may no longer be assigned to this worker -- offering it here would advertise a
    // capability nobody gave this run, under an empty description.
    const offered = [...injection.copied, ...injection.shadowedByRepo]
      .filter((name) => descriptionOf.has(name))
      .toSorted((a, b) => a.localeCompare(b))
      .map((name) => ({ name, description: descriptionOf.get(name) ?? '' }))
    sections.push({
      kind: 'skills',
      text: skillsSectionText(offered, assigned.length, injection),
      source: { kind: 'skills', ...injection },
    })
  }

  // 4. What it is being asked to do.
  if (task !== null && order.includes('task')) {
    sections.push({
      kind: 'task',
      text: `Task: ${task.title}\n\n${task.description}`,
      // M40 §1, "the hash is the hook": the hash of the task text this run actually saw --
      // `title + '\n' + description`, which is NOT the rendered section text (that carries the
      // `Task: ` label and a blank line), so the same task hashes the same from any builder.
      source: { kind: 'task', taskId: task.id, sha256: sha256(`${task.title}\n${task.description}`) },
    })
    // M48 R4. After the task, on the implementation AND the review order -- `order.includes` is
    // what keeps one `if` honest for both.
    if (order.includes('handoff')) {
      const handoff = handoffSection(task)
      if (handoff !== null) sections.push(handoff)
    }
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
    sections.push(planningGoalSection(goal, workspace.goalVersion))
    // M40 §3. After the goal, never instead of it: the prompt reads "here is the requirement,
    // here is what changed about it, here is what to return", and `renderRunContext` picks the
    // re-plan trailer because this section is present (spec erratum E2).
    if (input.replan !== undefined) {
      sections.push(
        await replanSection({
          workspaceId: input.workspaceId,
          goal,
          previousVersion: input.replan.previousVersion,
          version: input.replan.version,
        }),
      )
    }
    // M47 R3: the keys this plan may be written in, last of the planning sections and therefore
    // directly above whichever trailer `renderRunContext` picks. A delta names capabilities the
    // same way a first plan does, so a re-plan gets the list too.
    const capabilities = await capabilitiesSection()
    if (capabilities !== null) sections.push(capabilities)
    // M48 R4: how this project works, or -- with no runbook adopted -- the contract alone.
    const process = await processSection(input.workspaceId)
    if (process !== null) sections.push(process)
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
