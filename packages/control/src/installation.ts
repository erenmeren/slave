import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { prisma } from '@slave-of-ai/db/client'
import { err, intakeRepositorySlug, ok, type Result } from '@slave-of-ai/domain'
import type { ControlRefusal } from './refusal.js'

/** The one row (M59 R3). A constant rather than a literal at three call sites: this id is the
 *  whole of "installation-level" as a database fact. */
const INSTALLATION_ID = 'installation'

/** Where a repository created from a conversation goes, and WHY it goes there.
 *
 *  The source travels with the value because `/settings` shows it: "from Settings" and "from
 *  SLAVEOFAI_REPOS" and "default" are three different things to a person deciding whether to
 *  change it, and a bare path cannot tell them apart. */
export interface ReposRoot {
  readonly root: string
  readonly source: 'settings' | 'env' | 'default'
}

/** What the row holds, or nulls when nobody has ever written one. */
export async function readInstallationSettings(): Promise<{ readonly reposRoot: string | null }> {
  const row = await prisma.installationSettings.findUnique({
    where: { id: INSTALLATION_ID },
    select: { reposRoot: true },
  })
  return { reposRoot: row?.reposRoot ?? null }
}

/**
 * The resolution order M59 R3 fixes: the row, then `SLAVEOFAI_REPOS`, then `~/projects`.
 *
 * ONE function, and every reader goes through it -- the intake's facts, `acceptIntake`'s
 * `<root>/<slug>` and the Settings page all show the same answer, which is what makes "your
 * repository will be created at ..." a promise rather than a guess. The environment variable is
 * the one `docker-compose` already mounts by (README, "Or run it all in Docker"), so an
 * installation that configured it keeps working with no row at all.
 */
export async function resolveReposRoot(): Promise<ReposRoot> {
  const stored = await readInstallationSettings()
  if (stored.reposRoot !== null && stored.reposRoot.trim() !== '') {
    return { root: stored.reposRoot, source: 'settings' }
  }
  const fromEnv = process.env['SLAVEOFAI_REPOS']
  if (fromEnv !== undefined && fromEnv.trim() !== '') return { root: fromEnv.trim(), source: 'env' }
  return { root: join(homedir(), 'projects'), source: 'default' }
}

/**
 * Writes (or clears) the repositories folder.
 *
 * An upsert on a fixed id, so there is exactly one row however often this is called -- the table
 * has one row by design and a second one would make `resolveReposRoot` a question about which.
 * `null` clears, which is a real state ("fall back to the environment or the default") and not the
 * same as the empty string, so a blank is stored as `null` rather than as `""`.
 *
 * Refuses a relative path: `<root>/<slug>` has to be somewhere both this process and the
 * orchestrator can find, and a path relative to whichever directory a process happened to start in
 * is not that. No `stat` -- a folder that does not exist yet is an ordinary thing to configure
 * before the first project, and `initRepository` (R7) is where "the parent does not exist" is
 * decided, against the path it is actually about to create.
 */
export async function setInstallationSettings(input: {
  readonly reposRoot: string | null
}): Promise<Result<{ readonly reposRoot: string | null }, ControlRefusal>> {
  const trimmed = input.reposRoot === null ? null : input.reposRoot.trim()
  const reposRoot = trimmed === null || trimmed === '' ? null : trimmed
  if (reposRoot !== null && !isAbsolute(reposRoot)) return err({ kind: 'invalid_repos_root', path: reposRoot })

  await prisma.installationSettings.upsert({
    where: { id: INSTALLATION_ID },
    create: { id: INSTALLATION_ID, reposRoot },
    update: { reposRoot },
  })
  return ok({ reposRoot })
}

/**
 * A project name, as a directory name (M59 R8: `repo.mode: 'new'` with no path resolves to
 * `<reposRoot>/<slug(name)>`).
 *
 * NFD + strip the combining marks, so `Ödeme` becomes `odeme` rather than `demen` or an escape:
 * the people this milestone exists for do not type in ASCII, and a Turkish project name has to
 * produce a directory a shell can hold without quoting.
 *
 * Never empty and never a path. A name of nothing but punctuation returns `project`, because an
 * empty slug would resolve `<root>/<slug>` to the ROOT ITSELF and create a project at the
 * repositories folder; and every `/` and `.` run is folded away, because a name is not a path and
 * `../etc` must not climb out of the root it was joined to.
 */
export function slugify(name: string): string {
  return intakeRepositorySlug(name)
}
