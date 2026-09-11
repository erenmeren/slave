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
    /**
     * M51 R6: the tool-result tap, matcher `"*"`, registered exactly the way the gate above is.
     *
     * OPTIONAL, and the key is ABSENT rather than an empty array when there is no tap: a settings
     * file with an empty `PostToolUse` array is a registration of nothing, and this file is the ONE
     * place Claude's hook JSON shape is spelled -- keeping it honest about what is actually
     * installed is the whole reason it is one place.
     */
    readonly PostToolUse?: readonly [
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
 *
 * `tapPath` (M51 R6) is the PostToolUse tool-result tap, and it is OPTIONAL where `hookPath` is
 * required: a deployment that has not installed the tap runs perfectly well without it -- the
 * stream carries the same facts and the tap only fills a gap -- so the key is left out of the file
 * entirely rather than registered empty. It is held to the SAME absolute-path rule, for the same
 * reason and in the same words: a path the CLI cannot resolve is a hook that silently never runs.
 */
export function buildSettings(input: { readonly hookPath: string; readonly tapPath?: string }): ClaudeSettings {
  if (!isAbsolute(input.hookPath)) {
    throw new Error(`buildSettings: hookPath must be absolute, got ${JSON.stringify(input.hookPath)}`)
  }
  if (input.tapPath !== undefined && !isAbsolute(input.tapPath)) {
    throw new Error(`buildSettings: tapPath must be absolute, got ${JSON.stringify(input.tapPath)}`)
  }
  const tapPath = input.tapPath
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: input.hookPath }],
        },
      ],
      ...(tapPath === undefined
        ? {}
        : {
            PostToolUse: [
              {
                matcher: '*',
                hooks: [{ type: 'command', command: tapPath }],
              },
            ] as const,
          }),
    },
  }
}

/**
 * Writes the per-run settings file at `settingsPath`, registering
 * `hookPath` as the `PreToolUse` hook. Called by `ClaudeCodeAdapter.start()`
 * and `.resume()` (M12 Task 2), once per spawn, into the run's own scratch
 * directory (`StartRunInput.runDir` / `Checkpoint.settingsPath`) before the
 * process itself is spawned -- provisioning the run's files is this
 * adapter's own concern (M12's Decision of Record #1), not its caller's.
 * `claudeFlags` then points `--settings` at the same path. Both paths must
 * be absolute for the same reason `claudeFlags` enforces it on
 * `settingsPath`: a path the CLI cannot resolve means the hook never runs,
 * silently.
 */
export function writeSettingsFile(input: {
  readonly settingsPath: string
  readonly hookPath: string
  /** M51 R6. Passed straight through to {@link buildSettings}; absent means "this run is untapped". */
  readonly tapPath?: string
}): void {
  if (!isAbsolute(input.settingsPath)) {
    throw new Error(
      `writeSettingsFile: settingsPath must be absolute, got ${JSON.stringify(input.settingsPath)}`,
    )
  }
  const settings = buildSettings({
    hookPath: input.hookPath,
    ...(input.tapPath === undefined ? {} : { tapPath: input.tapPath }),
  })
  writeFileSync(input.settingsPath, JSON.stringify(settings, null, 2))
}
