import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The home directory a Cursor WORKER runs under (H9 F9): the operator's own home, minus every
 * directory a vendor CLI discovers user-level plugins and skills from.
 *
 * **Why a worker needs one.** `cursor-agent` loads the person's OWN plugins and skills into every
 * session it starts -- measured on 2026-09-21: a worker discovered the person's Superpowers plugin
 * (`~/.cursor/plugins/cache/cursor-public/superpowers/…`), read its skills, ran its worktree script,
 * brainstormed, planned, dispatched seven helpers of its own (`task` calls) and ran its own review rounds --
 * a whole development process inside one task, and three 30-minute timeouts in a row. This system
 * already plans, dispatches and reviews; a worker running a second copy of that process inside its
 * task is doing the wrong job slowly.
 *
 * **Why HOME, and nothing narrower.** `cursor-agent --help` (`2026.09.18-9a7762b`) offers
 * `--plugin-dir` to ADD a plugin and nothing to remove one: there is no `--no-plugins`, and no
 * environment variable names the plugin root. Read out of the installed bundle (free, no model call):
 * the plugin cache (`<HOME>/.cursor/plugins/cache`), local plugins (`<HOME>/.cursor/plugins/local`),
 * marketplaces (`<HOME>/.cursor/plugins/marketplaces`), Claude's installed plugins
 * (`<HOME>/.claude/plugins`) and the user skill roots (`<HOME>/<vendor dot-directory>/skills` for
 * five vendors' directories, `.cursor`, `.claude`, `.codex` and `.grok` among them) are ALL
 * resolved from `HOME` / `os.homedir()`. So the one lever that reaches every one of them is the
 * child's `HOME`.
 *
 * **Why a MIRROR rather than an empty directory.** An empty `HOME` would also take away everything
 * a worker legitimately needs from it: the vendor's own login (`~/.config/cursor/auth.json`), the
 * person's `~/.gitconfig`, package-manager caches, installed browsers for end-to-end tests. So the
 * worker home holds a symlink to every top-level entry of the real home EXCEPT a plugin-bearing
 * one ({@link isPluginBearing}), and an empty `.cursor` of its own. Everything the worker's tools look
 * for is where it always was; only the plugin and skill roots are missing.
 *
 * **What is pointed back at the real `~/.cursor` by name** ({@link cursorWorkerEnv}): the CONFIG dir
 * (`CURSOR_CONFIG_DIR` -- `cli-config.json`, which carries `authInfo`, and `chats/`, which is where a
 * session a later `--resume` names is stored) and the DATA dir (`CURSOR_DATA_DIR`, per-project
 * state). Neither holds a plugin or a skill (read out of the same bundle: config holds `chats`,
 * `cli-config.json`, `permissions.json`, `acp-*`, `statsig-cache.json`; data holds `projects` and
 * `computer-use`). So a run started before this change resumes its session exactly as before.
 *
 * **What was NOT measured, said plainly.** Proving that a real worker session no longer lists the
 * person's plugins needs a real `cursor-agent` model call, which costs money and was not made. The
 * mechanism is read off the vendor's code, not off a recorded run; plugins installed on the
 * person's ACCOUNT (rather than on disk) could in principle be fetched into the worker home's
 * empty cache by the CLI itself. The run context's own rule ("do the task itself; do not
 * brainstorm, plan or hand work to helpers") is the second line for exactly that case.
 */
export const ALWAYS_EXCLUDED_DIRS = ['.cursor', '.claude'] as const

/**
 * Whether a top-level entry of the real home is one the worker home must NOT mirror: Cursor's own
 * and Claude's directories always (plugin state, `CLAUDE.md`, installed-plugin lists live there
 * whatever their layout), and any other DOT-directory holding a `skills` or `plugins` directory --
 * which is the shape of every vendor root the CLI scans (`<dir>/skills`), today's five and
 * whichever one the next self-update adds. A rule about SHAPE rather than a list of names, so a
 * vendor directory nobody here has heard of yet is excluded the day it appears.
 */
export function isPluginBearing(realHome: string, entry: string): boolean {
  if ((ALWAYS_EXCLUDED_DIRS as readonly string[]).includes(entry)) return true
  if (!entry.startsWith('.')) return false
  return existsSync(join(realHome, entry, 'skills')) || existsSync(join(realHome, entry, 'plugins'))
}

/** Where a run's worker home lives: inside the run's own scratch directory, never the worktree. */
export function cursorWorkerHomeFor(runDir: string): string {
  return join(runDir, 'cursor-home')
}

/**
 * Builds (or tops up) the worker home for one run and returns its path. Idempotent: a resume of the
 * same run rebuilds into the same directory, and an entry already there -- a symlink from the first
 * spawn, or a file the CLI wrote into the worker's own `.cursor` -- is left exactly as it is.
 * Nothing here ever deletes, so nothing here can delete through a symlink into the real home.
 */
export function prepareCursorWorkerHome(input: { readonly runDir: string; readonly realHome: string }): string {
  const home = cursorWorkerHomeFor(input.runDir)
  mkdirSync(join(home, '.cursor'), { recursive: true })
  for (const entry of readdirSync(input.realHome)) {
    if (isPluginBearing(input.realHome, entry)) continue
    const target = join(home, entry)
    if (existsNoFollow(target)) continue
    symlinkSync(join(input.realHome, entry), target)
  }
  return home
}

/**
 * The environment a Cursor worker's child gets ON TOP of `buildChildEnv`'s allow list: its own
 * `HOME`, and the two vendor directories named back at the real ones. Each vendor directory is
 * resolved the way `cursor-agent` itself resolves it from the PARENT's environment
 * (`cursor-config/dist/paths.js` in the bundle), so an operator who already moved them keeps them
 * where they put them.
 */
export function cursorWorkerEnv(input: {
  readonly workerHome: string
  readonly realHome: string
  readonly parentEnv: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  const configured = (name: string): string | undefined => {
    const value = input.parentEnv[name]
    return value !== undefined && value.trim() !== '' ? value : undefined
  }
  const xdgConfig = configured('XDG_CONFIG_HOME')
  return {
    HOME: input.workerHome,
    CURSOR_CONFIG_DIR:
      configured('CURSOR_CONFIG_DIR') ?? (xdgConfig !== undefined ? join(xdgConfig, 'cursor') : join(input.realHome, '.cursor')),
    CURSOR_DATA_DIR: configured('CURSOR_DATA_DIR') ?? join(input.realHome, '.cursor'),
  }
}

/** The operator's real home, as the daemon sees it. */
export function realHomeDir(): string {
  const fromEnv = process.env['HOME']
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : homedir()
}

function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
