import { mkdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { ATTACHMENT_KIND_BY_EXTENSION, err, ok, type ChatAttachment, type Result } from '@slave-of-ai/domain'
import { gitIn } from './git.js'
import type { Principal } from './principal.js'
import type { ControlRefusal } from './refusal.js'

/** At most five files in one request (F R6). A conversation hands the Supervisor a brief and a
 *  screenshot, not a folder; past this the person wants the repository itself, which they already
 *  have. */
export const SUPERVISOR_UPLOAD_MAX_FILES = 5

/** Twenty megabytes per file (F R6). A PDF and a screenshot fit; a video does not, and a video is
 *  not something any worker on this system can read. */
export const SUPERVISOR_UPLOAD_MAX_BYTES = 20 * 1024 * 1024

/** Where everything a person hands the Supervisor lands, relative to the repository root -- the one
 *  place every worker already reads, which is the whole of R6's reasoning. Written as POSIX
 *  segments because it is a PATH IN A REPOSITORY (what a citation names and what a prompt prints),
 *  never a path on this host. */
export const INBOX_DIR = 'docs/inbox'

/** The note file a conversation appends to (F R3) -- context for whoever plans next, without
 *  changing the goal. */
export const PLANNER_NOTES_PATH = `${INBOX_DIR}/NOTES.md`

/** The heading the file is CREATED with, so a person opening the repository finds a document
 *  rather than a bare list. Written once, at birth, and never rewritten. */
const PLANNER_NOTES_HEADING = '# Notes for the planner'

/** One file as a caller hands it over: the name the person's own machine gave it, and its bytes. */
export interface SupervisorUpload {
  readonly name: string
  readonly bytes: Buffer
}

/** How long a slug may be. Sixty characters is a sentence; past it a filename stops being
 *  something a person reads in a prompt or a `git log` line. */
const SLUG_MAX_CHARS = 60

/** What a name whose every character is punctuation comes to. A path with a hole in it
 *  (`2026-09-20-.md`) is worse than a generic word, and the original name is kept on the
 *  attachment row beside the path either way. */
const EMPTY_SLUG = 'file'

/** `yyyy-mm-dd` in UTC -- the date the repository will still read correctly in another timezone.
 *  `toISOString` is the one formatting this product uses for a stamp anybody compares. */
const dateStamp = (at: Date): string => at.toISOString().slice(0, 10)

/**
 * The slug half of `<yyyy-mm-dd>-<slug>.<ext>`: the name lowercased, its extension dropped, and
 * every run of anything that is not `[a-z0-9]` collapsed to a single `-`.
 *
 * Deliberately NOT `slugify` from `installation.ts`: that one names a DIRECTORY for a repository
 * and is free to change; this one names a file a model quotes by path and a commit records, and
 * the two must be able to move independently.
 */
function slugOf(base: string): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/, '')
  return slug === '' ? EMPTY_SLUG : slug
}

/** The extension, lowercased, or `''` when the name has none. The LAST dot, so `brief.v2.md` is
 *  markdown rather than nothing. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Whether the name is a NAME rather than a path (F R6's "a path that resolves outside
 * `docs/inbox/` is refused").
 *
 * The check is made on what the caller handed over, before any slugging, because slugging would
 * quietly turn `../../etc/passwd.md` into `etc-passwd` -- a file the person never asked for, under
 * a name they would not recognise, with no word said about it. A person whose upload was refused
 * can rename it; a person whose upload was renamed cannot tell.
 *
 * Both separators, on every host: `\` is a legal character in a POSIX filename, so a name carrying
 * one is a Windows path that arrived intact rather than a file somebody meant to call that.
 */
function isPlainName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name.includes('\0')) return false
  return true
}

/** The bytes of one file, as a number the attachment row carries. `Buffer.byteLength` rather than
 *  `.length` so a caller that handed over a string still gets the size the file will have. */
const sizeOf = (bytes: Buffer): number => Buffer.byteLength(bytes)

/** The project's repository, or the refusal that says why there is nothing to write into. Shared
 *  by both writers below so "a project with a repository nobody can stat" is one sentence rather
 *  than two that drift. */
async function inboxRepo(workspaceId: string): Promise<Result<string, ControlRefusal>> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { repoPath: true } })
  if (workspace === null) return err({ kind: 'workspace_not_found', workspaceId })
  try {
    const root = await stat(workspace.repoPath)
    if (!root.isDirectory()) return err({ kind: 'repo_not_found', path: workspace.repoPath })
  } catch {
    // Stat'd rather than trusted, and BEFORE any `mkdir -p`: a project whose repository has moved
    // would otherwise have a `docs/inbox` tree created for it at a path that is not a repository.
    return err({ kind: 'repo_not_found', path: workspace.repoPath })
  }
  return ok(workspace.repoPath)
}

/** Whether a repository path really lands inside `<repoPath>/docs/inbox`. Structural, and
 *  unreachable given {@link isPlainName} and {@link slugOf} above -- which is exactly why it is
 *  here: the assertion is what keeps the two of them honest as they change. */
function insideInbox(repoPath: string, repoRelativePath: string): boolean {
  const inbox = resolve(repoPath, INBOX_DIR)
  const target = resolve(repoPath, repoRelativePath)
  const within = relative(inbox, target)
  return within !== '' && !within.startsWith('..') && !isAbsolute(within) && !within.includes(sep)
}

/**
 * Writes what a person attached to a message into the project's repository, and commits it (F R6).
 *
 * The repository is the one place every worker already reads, and a commit is a record: this is
 * the whole of why an attachment is a file on a branch rather than a row in a table. The returned
 * list is what the message row stores and what the chat prompt renders -- `path` is repository
 * relative, which is what the Supervisor quotes and what a worker later opens.
 *
 * EVERY CHECK BEFORE EVERY WRITE. The count, each size, each extension and each name are decided
 * first, so a request with one bad file writes none of them: a person who has to resend gets to
 * resend the whole request rather than discover half of it already landed under numbered names.
 *
 * ONE COMMIT for the request, named after the files the PERSON named (`inbox: brief.md,
 * screenshot.png`), with `ORCHESTRATOR_GIT_IDENTITY` -- `initRepository`'s precedent, through the
 * `gitIn` wrapper so the `-c user.name=…` pair is spelt in one place.
 *
 * TWO RESIDUALS, said out loud rather than hidden. It commits onto whatever the repository is
 * checked out at, which in ordinary operation is the base branch -- runs work in worktrees -- and
 * it does not switch branches, because switching a checkout out from under an operator is worse
 * than a file landing on the branch they are standing on. And a git failure AFTER the files are
 * written leaves them on disk, uncommitted: `inbox_write_failed` says so, and `git status` is
 * where a person sees what is there.
 */
export async function storeSupervisorUploads(
  workspaceId: string,
  files: readonly SupervisorUpload[],
  _principal?: Principal,
  at: Date = new Date(),
): Promise<Result<readonly ChatAttachment[], ControlRefusal>> {
  if (files.length > SUPERVISOR_UPLOAD_MAX_FILES) {
    return err({ kind: 'too_many_attachments', limit: SUPERVISOR_UPLOAD_MAX_FILES, count: files.length })
  }
  const repo = await inboxRepo(workspaceId)
  if (!repo.ok) return repo
  const repoPath = repo.value
  // A request with nothing in it is not a refusal: there is nothing to refuse. It writes nothing
  // and, crucially, commits nothing -- an empty commit on the base branch would be a record of an
  // event that did not happen.
  if (files.length === 0) return ok([])

  for (const file of files) {
    if (!isPlainName(file.name)) return err({ kind: 'attachment_path_refused', name: file.name })
    const extension = extensionOf(file.name)
    if (ATTACHMENT_KIND_BY_EXTENSION[extension] === undefined) {
      return err({ kind: 'attachment_kind_not_allowed', name: file.name, extension })
    }
    const bytes = sizeOf(file.bytes)
    if (bytes > SUPERVISOR_UPLOAD_MAX_BYTES) {
      return err({ kind: 'attachment_too_large', name: file.name, bytes, limit: SUPERVISOR_UPLOAD_MAX_BYTES })
    }
  }

  const inboxPath = join(repoPath, ...INBOX_DIR.split('/'))
  const stamp = dateStamp(at)
  const attachments: ChatAttachment[] = []
  const taken = new Set<string>()
  for (const file of files) {
    const extension = extensionOf(file.name)
    const slug = slugOf(file.name.slice(0, file.name.length - extension.length - 1))
    // The collision rule is ONE question asked of two places: the names this request has already
    // used, and the names already on disk. A second upload of `brief.md` on the same day is an
    // ordinary thing a person does, and overwriting yesterday's -- or this request's own first
    // file -- would lose a document nobody was told was at risk.
    let candidate = `${stamp}-${slug}.${extension}`
    for (let attempt = 2; taken.has(candidate) || (await exists(join(inboxPath, candidate))); attempt += 1) {
      candidate = `${stamp}-${slug}-${String(attempt)}.${extension}`
    }
    taken.add(candidate)
    const repoRelativePath = `${INBOX_DIR}/${candidate}`
    if (!insideInbox(repoPath, repoRelativePath)) return err({ kind: 'attachment_path_refused', name: file.name })
    attachments.push({
      path: repoRelativePath,
      name: file.name,
      bytes: sizeOf(file.bytes),
      kind: ATTACHMENT_KIND_BY_EXTENSION[extension] ?? 'binary',
    })
  }

  try {
    await mkdir(inboxPath, { recursive: true })
    for (const [index, file] of files.entries()) {
      // `attachments[index]` is the row built for exactly this file, one loop above.
      await writeFile(join(repoPath, ...(attachments[index]?.path ?? '').split('/')), file.bytes)
    }
    await gitIn(repoPath, 'add', '--', ...attachments.map((attachment) => attachment.path))
    await gitIn(repoPath, 'commit', '-m', `inbox: ${files.map((file) => file.name).join(', ')}`)
  } catch (error) {
    return err({
      kind: 'inbox_write_failed',
      path: INBOX_DIR,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  return ok(attachments)
}

/**
 * Appends one dated line to `docs/inbox/NOTES.md` and commits it (F R3).
 *
 * The way a conversation hands the next planner context WITHOUT changing the goal: nothing reads
 * this file automatically -- it is read by whoever plans next, the way a person's note in a
 * repository is. That is what makes it cheap enough to offer in a chat message, and it is still
 * never automatic under `propose`, because a commit to the repository is a commit to the
 * repository.
 *
 * Created with a heading when it is absent, appended to when it is there, and the heading is never
 * rewritten: a person may edit this file by hand and their edits are somebody's work.
 *
 * The date is `at`'s, UTC, to the day -- the resolution a planner reading "what did they say last
 * week" actually uses. The text is written verbatim onto ONE line: a note is a line, and a
 * multi-line note would break the list the file is.
 */
export async function appendPlannerNote(
  workspaceId: string,
  text: string,
  at: Date = new Date(),
): Promise<Result<{ readonly path: string }, ControlRefusal>> {
  const note = text.replace(/\s+/g, ' ').trim()
  if (note === '') return err({ kind: 'invalid_message', reason: 'a note for the planner must not be blank' })
  const repo = await inboxRepo(workspaceId)
  if (!repo.ok) return repo
  const repoPath = repo.value

  const inboxPath = join(repoPath, ...INBOX_DIR.split('/'))
  const notesPath = join(repoPath, ...PLANNER_NOTES_PATH.split('/'))
  try {
    await mkdir(inboxPath, { recursive: true })
    const head = (await exists(notesPath)) ? '' : `${PLANNER_NOTES_HEADING}\n\n`
    // `appendFile` semantics through `writeFile`'s `flag`, so the file is created with the heading
    // and extended without it in one call either way.
    await writeFile(notesPath, `${head}- ${dateStamp(at)} — ${note}\n`, { flag: 'a' })
    await gitIn(repoPath, 'add', '--', PLANNER_NOTES_PATH)
    await gitIn(repoPath, 'commit', '-m', 'inbox: planner note')
  } catch (error) {
    return err({
      kind: 'inbox_write_failed',
      path: PLANNER_NOTES_PATH,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  return ok({ path: PLANNER_NOTES_PATH })
}

/** Whether a path is there at all. `stat` rather than `access`, for the reason `inboxRepo` states:
 *  the answer wanted is "is there something here", and a throw is the only way `stat` says no. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
