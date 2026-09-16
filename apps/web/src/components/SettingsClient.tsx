'use client'

import { useState, type InputHTMLAttributes } from 'react'
import type { AdapterCard } from '../server/settings'
import type { BoundaryMode } from '../lib/authEnv'
import { errorMessage } from '../lib/postControl'
import { onUnauthorized } from '../lib/onUnauthorized'
import { THEME_LABEL, useTheme } from './theme/ThemeProvider'
import { DangerZone } from './DangerZone'
import { LogoutButton } from './LogoutButton'
import { ProviderAdapterCards } from './ProviderAdapterCards'
import { PageShell } from './ui/PageShell'
import { Panel } from './ui/Panel'
import { Segmented } from './ui/Segmented'
import { Button } from './ui/Button'
import { TextField } from './ui/FormControls'

type ReposRootState = { readonly reposRoot: string | null; readonly resolved: string; readonly source: 'settings' | 'env' | 'default' }

/** M59 R17: the one installation-level setting there is. Its own component keeps the page as
 *  layout while the field owns its `pending` and `errorText` state. */
export function ReposRootField({ initial }: { readonly initial: ReposRootState }): React.JSX.Element {
  const [value, setValue] = useState(initial.reposRoot ?? '')
  const [state, setState] = useState(initial)
  const [pending, setPending] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  const save = async (): Promise<void> => {
    setPending(true)
    setErrorText(null)
    try {
      const response = await fetch('/api/installation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reposRoot: value.trim() === '' ? null : value.trim() }),
      })
      if (response.status === 401) onUnauthorized()
      if (!response.ok) {
        setErrorText(errorMessage(await response.json().catch(() => null), response.status))
        return
      }
      const body = (await response.json()) as ReposRootState
      setState(body)
    } catch (cause) {
      setErrorText(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  const sourceLabel: Record<ReposRootState['source'], string> = {
    settings: 'from Settings',
    env: 'from SLAVEOFAI_REPOS',
    default: 'default (~/projects)',
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2">
        <TextField
          label="Repositories folder"
          inputProps={
            {
              'data-testid': 'settings-repos-root',
              'aria-label': 'repositories folder',
              placeholder: state.resolved,
              value,
              onChange: (event) => setValue(event.target.value),
              disabled: pending,
              className: 'w-96 font-mono',
            } as InputHTMLAttributes<HTMLInputElement>
          }
        />
        <Button variant="primary" size="sm" type="button" data-testid="settings-repos-root-save" disabled={pending} onClick={() => void save()}>
          save
        </Button>
      </div>
      <p data-testid="settings-repos-root-source" data-source={state.source} className="text-[12px] text-text-3">
        {state.resolved} — {sourceLabel[state.source]}
      </p>
      {errorText !== null && (
        <span role="alert" data-testid="settings-repos-root-error" className="text-xs text-tone-blocked">
          {errorText}
        </span>
      )}
    </div>
  )
}

/** The GLOBAL Settings page's root (M24 §4): three panels, none of them scoped to a project --
 *  provider adapters, security, and the danger zone's reseed. Everything that used to live here
 *  and DOES belong to a project (the permission matrix, the per-workspace stop) moved to the
 *  project Settings tab (M24 Task 4); everything that belongs to the org, not a project (the
 *  workspace list, the template catalog, the company manager) moved to the Projects page (M24
 *  Task 6). This page is left with the settings that are neither. */
export function SettingsClient({
  adapters,
  showReseed,
  mode,
  posture,
  reposRoot,
}: {
  readonly adapters: readonly AdapterCard[]
  /** Computed on the SERVER from `NODE_ENV`, never guessed at here. */
  readonly showReseed: boolean
  /** Computed on the SERVER from `SLAVEOFAI_SESSION_SECRET` (`boundaryMode()`), never guessed here. */
  readonly mode: BoundaryMode
  /** `postureFor(mode, username)` — the single source for the security line (M23 spec §7 F5). */
  readonly posture: string
  readonly reposRoot: ReposRootState
}): React.JSX.Element {
  const { theme, setTheme } = useTheme()
  return (
    // M44 erratum E25 / M45 R5: the shell WRAPS this page's own frame rather than replacing it --
    // `flush` drops the shell's `gap-4 p-3 md:p-4`, so the page keeps its own padding, gap and
    // width exactly and not a pixel moves. The shell is here for its landmark and its
    // `page-shell` marker.
    <PageShell flush>
      <div className="flex flex-col gap-4 p-4">
        <Panel title="provider adapters">
          <ProviderAdapterCards adapters={adapters} />
        </Panel>
        <section className="flex flex-col gap-3 rounded-page-card border border-line bg-card p-[18px_20px]">
          <h2 className="m-0 text-[15px] font-semibold text-t1">Appearance</h2>
          <div className="flex items-center justify-between gap-4 text-[13.5px]">
            <div>
              <div className="font-medium text-t1">Theme</div>
              <div className="text-[12.5px] text-t3">&quot;System&quot; follows your computer.</div>
            </div>
            {/* `ui/Segmented` (M57 R21), not a fourth copy of the same nine class strings. Its own
              * markup emits `appearance-theme` on the group and `appearance-theme-<id>` on each
              * button, which is exactly what spec §3 lists. `data-theme-mode` rides alongside
              * `Segmented`'s own `data-value` on that SAME group element (its `data` passthrough),
              * because the gate reads the chosen mode off `appearance-theme` directly rather than
              * off a wrapper `Segmented` does not itself render. */}
            <Segmented
              options={[
                { id: 'system', label: THEME_LABEL.system },
                { id: 'light', label: THEME_LABEL.light },
                { id: 'dark', label: THEME_LABEL.dark },
              ]}
              value={theme}
              onChange={setTheme}
              ariaLabel="Theme"
              testIdPrefix="appearance-theme"
              data={{ 'data-theme-mode': theme }}
            />
          </div>
        </section>
        <section data-testid="settings-repositories" className="flex flex-col gap-3 rounded-page-card border border-line bg-card p-[18px_20px]">
          <h2 className="m-0 text-[15px] font-semibold text-t1">Repositories</h2>
          <p className="m-0 text-[12.5px] text-text-3">
            Where a repository created from a conversation goes. A path named in the conversation wins over this.
          </p>
          <ReposRootField initial={reposRoot} />
        </section>
        <Panel title="security">
          <p data-testid="security-posture" className="font-mono text-[10px] text-text-3">
            {posture}
          </p>
          {mode === 'accounts' && <LogoutButton />}
        </Panel>
        <DangerZone showReseed={showReseed} />
      </div>
    </PageShell>
  )
}
