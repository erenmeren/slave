import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runId } from '@ai-team-os/domain'
import { describe, expect, it } from 'vitest'
import { ClaudeCodeAdapter } from '../src/index.js'
import { copyGateInto } from './helpers/gate-fixture.js'

describe('the Claude adapter prepares its own run files', () => {
  it('writes the settings file itself, registering the hook it was configured with', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'm12-prep-'))

    // `runDir` mirrors what `packages/control`'s `runFilePaths` actually hands `start()`: an
    // already-created, empty per-run scratch directory, distinct from `worktreePath` -- creating it
    // is the caller's job (spec verbatim: "The orchestrator supplies a per-run scratch directory;
    // the contents are the adapter's"), so it is created here rather than left for `start()` to
    // `mkdir` itself.
    const runDir = join(dir, '.aiteamos', 'runs', 'run-1')
    mkdirSync(runDir, { recursive: true })

    // A real, discriminating hook script, not a bare literal path -- `start()` (Task 6) runs the
    // pre-flight gate against `ClaudeCodeAdapterOptions.hookPath` before writing anything, exactly
    // as every other adapter test in this package sets one up.
    // The helper copies `scripts/lib/pause-flag.sh` into `<dir>/lib/` too -- since M13 §4.2 the
    // gate sources its encoder from there, and a copy without the library refuses to run.
    const hookPath = copyGateInto(dir, 'pause-gate.sh')

    const adapter = new ClaudeCodeAdapter({ command: '/bin/true', hookPath })

    await adapter.start({
      runId: runId('run-1'),
      prompt: 'hello',
      worktreePath: dir,
      pauseFlagPath: join(dir, 'pause.flag'),
      runDir,
      permissionsFilePath: join(runDir, 'permissions.json'),
      gitIdentity: { name: 'a', email: 'a@b.c' },
    })

    // Byte-identical to the pre-M12 path: `.aiteamos/runs/<runId>/settings.json`, only now written
    // by the adapter itself rather than by the orchestrator's `writeSettingsFile` call.
    const settings = join(runDir, 'settings.json')
    expect(existsSync(settings)).toBe(true)
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toMatchObject({
      hooks: { PreToolUse: [{ matcher: '*' }] },
    })
  })
})
