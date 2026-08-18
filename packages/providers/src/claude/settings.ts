import { writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/**
 * The `claude` CLI settings.json shape that registers a script as the
 * `PreToolUse` hook for every tool (matcher `"*"`), measured in
 * `spike/m0-pause-resume/settings.json` and binding per ADR 0001 §3.
 */
export interface ClaudeSettings {
  readonly hooks: {
    readonly PreToolUse: readonly [
      {
        readonly matcher: '*'
        readonly hooks: readonly [{ readonly type: 'command'; readonly command: string }]
      },
    ]
  }
}

/**
 * Builds the settings object for one run. `hookPath` must be absolute --
 * ADR 0001 measured only the absolute `command` form; the `$VAR` form was
 * never tested -- so a relative path is rejected here rather than silently
 * written to a file the CLI would then fail to resolve.
 */
export function buildSettings(input: { readonly hookPath: string }): ClaudeSettings {
  if (!isAbsolute(input.hookPath)) {
    throw new Error(`buildSettings: hookPath must be absolute, got ${JSON.stringify(input.hookPath)}`)
  }
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: input.hookPath }],
        },
      ],
    },
  }
}

/**
 * Writes the per-run settings file at `settingsPath`, registering
 * `hookPath` as the `PreToolUse` hook. Intended to be called once per run,
 * before the process is spawned, by whatever provisions the run's worktree
 * -- **no call site exists in this codebase yet**; `ClaudeCodeAdapter.start()`
 * (this task) takes an already-written `settingsPath` as given and does not
 * call this. `claudeFlags` then points `--settings` at the same path. Both
 * paths must be absolute for the same reason `claudeFlags` enforces it on
 * `settingsPath`: a path the CLI cannot resolve means the hook never runs,
 * silently.
 */
export function writeSettingsFile(input: { readonly settingsPath: string; readonly hookPath: string }): void {
  if (!isAbsolute(input.settingsPath)) {
    throw new Error(
      `writeSettingsFile: settingsPath must be absolute, got ${JSON.stringify(input.settingsPath)}`,
    )
  }
  const settings = buildSettings({ hookPath: input.hookPath })
  writeFileSync(input.settingsPath, JSON.stringify(settings, null, 2))
}
