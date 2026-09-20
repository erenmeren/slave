# M61 Simple Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator web UI becomes a fixed-viewport console with two modes — `simple` (a person who runs a company: five places, warm palette, a project whose home is its live team) and `developer` (everything else, cool palette, denser) — without removing a route, a capability, a control verb or a domain rule.

**Architecture:** The mode is built exactly like the theme: an attribute on `<html>`, a `localStorage` key, a clause in the pre-hydration script and a React provider; every visual difference between the modes is CSS keyed on `[data-mode='developer']` plus one pure table (`lib/routes.ts`) that says which tabs and rail items exist in which mode. The frame becomes `100dvh` with `overflow: hidden` on the page and a `ScrollArea` primitive wherever content is taller than its region. The project's page dissolves the Overview into a command strip (needs-you + tabs) mounted by the project LAYOUT and a Team tab at `/w/:id` fed by one additive read model (`server/teamLive.ts`) that composes the two reads the Overview and the Organization page already make. Home becomes a list beside a feed over one additive read model (`server/home.ts`) polled every ten seconds. Every other page keeps its client and its testids and is re-framed, not rewritten.

**Tech Stack:** TypeScript monorepo; Next.js 15.5 App Router + React 19; Tailwind v4 configured by `@theme inline` inside `apps/web/src/app/globals.css` (no `tailwind.config.*`); `next/font/local`; `@tanstack/react-virtual` (installed); `motion` v12 (added by Task 4, imported by exactly two files); vitest 3 (`unit` jsdom/react project, `integration` node project against the shared test database); Prisma 7 + Postgres 17 on :5433; plain-`node` `.mjs` gates driving `playwright-core`.

**Spec:** `docs/superpowers/specs/2026-09-19-m61-simple-mode-design.md` (R1–R22; §2 surfaces; §3 testid vocabulary; §4 `docs/ia.md`; §5 gate stages; §6 out of scope; §7 errata). Parents: `docs/ia.md`, `docs/superpowers/specs/2026-09-14-m57-ui-redesign-design.md` (the shell this milestone re-frames; its R1 alias-layer argument is why Task 1 deletes no token), `docs/superpowers/specs/2026-09-15-m59-intake-design.md` (the New project conversation Task 8 puts in a Sheet).

Plan-time errata, read out of the tree before this plan was written. Each is appended to the spec's §7 during execution in the form `**En (amends Rx)** — <claim>.`

- **E1 (amends R7) — `GoalCard` does not exist; the goal lives in `components/project/GoalPanel.tsx` and `GoalHistory.tsx`.** `stat-goal` wraps `GoalPanel`'s edit affordance, and `GoalHistory` moves to project Settings → Goal.
- **E2 (amends R8) — `OrganizationRow` already carries `doing: string | null`, `why`, `lifecycle` and `released`;** `TeamLiveRow.doing` prefers `SlaveCardData.taskTitle` (a live run's task) and falls back to `OrganizationRow.doing`, then to the waiting/idle sentences R8 lists. `SlaveCardData` also already carries `progressPct` (a live run's step progress) — `TeamLiveRow.progress` is `PROGRESS_FOR_TASK_STATUS[taskStatus]` when the task is not `running`, and `35 + progressPct * 0.25` (35→60) while it is, so the bar moves during a run and lands on the table's value at each transition.
- **E3 (amends R12) — the Workforce page's `?tab=` ids are `slaves | departments | catalog | skills | runbooks | evidence`** (`WorkforceClient.tsx:31`), shown as four segments `workforce-segment-<id>`. "People" in the spec is the `slaves` tab. Simple mode renders the `slaves` tab's content with the segments hidden; any other `?tab=` value in simple mode still renders (rule 2) with the segments shown, marked `data-outside-mode="true"`.
- **E4 (amends R11) — `ProjectRow` already carries `needsYou`, `spend`, `unmeasuredRuns`, `team[]`, `taskCounts`, `goal`, `halted`, `archived`, `companyName`;** `HomeSnapshot.projects` is `readonly ProjectRow[]` verbatim and `project-row` draws from it. `numbers.spendUsd` is `Σ project.spend` (the run-only total `listProjects` computes) — NOT `workspaceSpend` — because `listProjects` is the reader already in hand and the header's per-project figure is a different question; the tile is labelled `Spend` and carries `data-unmeasured` when any row's `unmeasuredRuns > 0`. R11's "sum of `workspaceSpend`" is withdrawn by this erratum.
- **E5 (amends R5) — the rail has no icon library to draw from.** `components/shell/icons.tsx` holds seven inline 20×20 stroke SVGs (`HomeIcon`, `PeopleIcon`, `SettingsIcon`, `FlaskIcon`, `ChartIcon`, `SearchIcon`, `ChevronIcon`); nothing else imports an icon set.
- **E6 (amends R14) — `RightWidth` is declared in `AppShell.tsx` and read by `ShellFrame` through `useRightWidth()`.** `'overlay'` is added there; `AppShell`'s `TRACK` maps it to the same track as `'none'`, and `RightPanelHost` draws the fixed overlay when `useRightWidth()` answers `'overlay'`.
- **E7 (amends R21) — the fixture in `gate-m57-ui-redesign.mjs` (two workspaces, five tasks, a pending decision, two goal events, a simulated company) is exactly the fixture stages 2–10 of the new gate need;** `gate-m61-simple-mode.mjs` copies its Stage 0 (preflight + fixture + `finally` teardown) verbatim with `M61` names, and adds one live `SlaveRun` in `running` status on the seeded slave so stage 5 has a `data-progress > 0` card.

---

## Global Constraints

- **Never a real model call in a test or in CI.** Every child is spawned with `SLAVEOFAI_REQUIRE_FAKE_CLI=1` and a fake; `gate:m12-providers` and `gate:m13-runtime` are never run by this milestone.
- **Gates run against the dedicated gate database, never the user's dev database:** every gate invocation in this plan is `DATABASE_URL="$GATE_DATABASE_URL" SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" SLAVEOFAI_REQUIRE_FAKE_CLI=1 CHROMIUM_PATH=... npm run gate:<name>`. **Never `npm run db:seed` against `slaveofai`.**
- **One vitest process at a time; never a gate beside vitest; no daemon while tests run** (`pgrep -af "orchestrator|vitest|next dev"` before starting either).
- **`npm run web:build` never while `next dev` is running.** `pgrep -af "next dev"` first; if one is up, `kill <pid>` and say so in the task report. Every task in this plan changes `apps/web`, so **every task ends with `npm run web:build`**.
- **No prettier.** Match the surrounding file by hand.
- Inside `apps/web/src`, import siblings **without** a `.js` suffix; files under `apps/web/test/` import `../src/...` **with** the `.js` suffix.
- `npm run typecheck` (not `tsc --build` alone) is the pre-push standard; both run at the end of every task.
- The vocabulary word is **slave** (`gate:m26-vocabulary`; `docs/ia.md` is in scope). Run `npm run gate:m26-vocabulary` after every task. Never write the Agency catalogue's repository name in a tracked file; call it "the Agency persona catalogue".
- **Labels never keys** (`docs/ia.md` rule 3): no surface prints a bare enum member; the raw value rides on `title` or a `data-` attribute.
- **Real is not simulated** (rule 4). **Nothing is removed, only moved** (rule 2): every route and every `?tab=`/`?mode=`/`?view=` value answers 200 in both modes after this milestone.
- **No migration, no new event type (61), no new control verb, no new refusal kind.** `packages/*` and `apps/orchestrator` are in no task's file list.
- **No component, test or gate names a colour.** A palette assertion compares a computed value before and after a toggle, never against a literal (spec R2).
- **`motion` is imported by exactly `apps/web/src/components/ui/Sheet.tsx` and `apps/web/src/components/ui/motion.ts`** (spec R15). `@base-ui-components/react` is not added.
- **No `transition: all` / `transition-all` anywhere under `apps/web/src`** (spec R3).
- Component tests are `*.test.tsx` under `apps/web/test/` with `// @vitest-environment jsdom` as the first line; anything touching the database is `apps/web/test/integration/*.test.ts` and uses `helpers.ts`/`projectFixture.ts` there.
- **Test baseline: the catalog-person-pool ladder — 7140 tests passed** (two pre-existing `subscribe` reconnect failures reproduce on `main`). Task 1 records the two numbers it actually sees; every later ladder is at or above them.
- **34 CI gates become 35.** `gate:m59-intake` is the 34th (`package.json:73`, `.github/workflows/ci.yml:91`). The new step goes after it in both; README's roster sentence and its count line (`grep -n '^[0-9]\+ gates\.' README.md`) say 35.
- **`gate:m14-fidelity` is not in CI and regenerates PNGs.** Exactly one task (Task 11) runs it and commits its 13 images in a commit of its own, in simple mode, dark.
- Commit trailers on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_f1f5b8bb-f026-4d7e-8227-c5e3e970dfb0
  ```
- Every task ends with its focused tests, `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck`, `npm run web:build` and a commit with explicit `git add` paths.
- **The implementer never dispatches subagents.**
- Branch: `feature/m61-simple-mode` (spec committed at `6194ac61`). The milestone merges to `main` locally at the end (Task 12); nothing is pushed.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/web/src/lib/modeStorage.ts` | `MODE_STORAGE_KEY`, `Mode`, `isMode` — plain module, no `'use client'` |
| `apps/web/src/lib/supervisorStorage.ts` | `SUPERVISOR_STORAGE_KEY` and its two values — plain module |
| `apps/web/src/lib/shortcuts.ts` | `isModKey(event)`, `matchesShortcut(event, {key, shift})` |
| `apps/web/src/components/mode/ModeProvider.tsx` | `ModeProvider`, `useMode`, the `Mod+Shift+D` listener |
| `apps/web/src/app/tokens/simple.css` | the warm palette, light + dark, bare `:root` selectors |
| `apps/web/src/app/tokens/developer.css` | today's palette verbatim, light + dark, `[data-mode='developer']` selectors |
| `apps/web/src/app/globals.css` | imports, alias layer, surface/density/motion tokens, type utilities, `html/body` |
| `apps/web/src/lib/routes.ts` | `TABS`, `RAIL`, `tabsFor`, `railFor`, `sectionOf`, `viewOf`, `breadcrumbOf` |
| `apps/web/src/lib/progress.ts` | `PROGRESS_FOR_TASK_STATUS`, `progressOf` |
| `apps/web/src/lib/happening.ts` | `HAPPENING_TYPES`, `happeningSentence` |
| `apps/web/src/components/ui/ScrollArea.tsx` | the one scrolling region |
| `apps/web/src/components/ui/Sheet.tsx`, `ui/motion.ts` | the modal slide-over and its spring constants |
| `apps/web/src/components/ui/Stat.tsx`, `LiveDot.tsx`, `Kbd.tsx` | new primitives |
| `apps/web/src/components/shell/Rail.tsx`, `icons.tsx`, `ProjectSwitcher.tsx`, `HeaderSearch.tsx` | the rail and what the sidebar tree became |
| `apps/web/src/components/project/CommandStrip.tsx`, `NeedsYouBar.tsx`, `TeamLive.tsx`, `TeamCard.tsx`, `ActivityDigest.tsx` | the project command screen |
| `apps/web/src/server/teamLive.ts`, `activityDigest.ts`, `home.ts` | the three additive read models |
| `apps/web/src/app/api/w/[workspaceId]/team/route.ts`, `api/home/route.ts` | the two additive routes |
| `apps/web/src/components/home/HomeClient.tsx`, `ProjectRowItem.tsx`, `HappeningFeed.tsx` | Home |
| `scripts/gate-m61-simple-mode.mjs` | the proof |

---

### Task 1: Mode storage, provider, boot script, and the four palettes

**Files:**
- Create: `apps/web/src/lib/modeStorage.ts`, `apps/web/src/lib/shortcuts.ts`, `apps/web/src/components/mode/ModeProvider.tsx`, `apps/web/src/app/tokens/simple.css`, `apps/web/src/app/tokens/developer.css`
- Modify: `apps/web/src/app/globals.css` (the three palette blocks move OUT; imports, surface/density/motion tokens and type utilities come IN), `apps/web/src/app/layout.tsx:104-112` (the boot script), `apps/web/src/components/SettingsClient.tsx:120-150` (Appearance gains the mode control)
- Test: `apps/web/test/mode.test.tsx` (new), `apps/web/test/tokens.test.ts` (extend), `apps/web/test/shortcuts.test.ts` (new), `apps/web/test/settings-page.test.tsx` (extend)

**Interfaces:**
- Produces: `MODE_STORAGE_KEY = 'mode'`; `type Mode = 'simple' | 'developer'`; `MODES: readonly Mode[]`; `isMode(v: unknown): v is Mode`; `useMode(): { mode: Mode; isDeveloper: boolean; setMode(next: Mode): void; toggle(): void }`; `ModeProvider`; `isModKey(e: KeyboardEvent | React.KeyboardEvent): boolean`; `matchesShortcut(e, spec: { key: string; shift?: boolean }): boolean`; CSS tokens `--glass`, `--glass-strong`, `--edge`, `--radius-control/surface/sheet`, `--fs-body`, `--row-h`, `--gap-1/2/3`, `--ease-out`, `--ease-in-out`, `--dur-fast/base/slow`; utilities `.type-label/.type-meta/.type-body/.type-title/.type-heading/.type-display`, `.glass`.

- [ ] **Step 1: Record the baseline ladder.** Run `pgrep -af "orchestrator|vitest|next dev"` (nothing may be running), then `npx vitest run 2>&1 | tail -5`. Write the `Test Files` and `Tests` counts into the task report; they are the floor for every later task.

- [ ] **Step 2: Write the failing storage and shortcut tests.**

`apps/web/test/shortcuts.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { isModKey, matchesShortcut } from '../src/lib/shortcuts.js'
import { MODE_STORAGE_KEY, MODES, isMode } from '../src/lib/modeStorage.js'

const ev = (over: Partial<KeyboardEvent>): KeyboardEvent =>
  ({ key: 'd', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over }) as KeyboardEvent

describe('modeStorage', () => {
  it('pins the key the boot script interpolates', () => expect(MODE_STORAGE_KEY).toBe('mode'))
  it('has exactly two modes, simple first', () => expect(MODES).toEqual(['simple', 'developer']))
  it('rejects anything else', () => {
    expect(isMode('developer')).toBe(true)
    expect(isMode('dark')).toBe(false)
    expect(isMode(null)).toBe(false)
  })
})

describe('shortcuts', () => {
  it('treats meta OR ctrl as the modifier, never alt', () => {
    expect(isModKey(ev({ metaKey: true }))).toBe(true)
    expect(isModKey(ev({ ctrlKey: true }))).toBe(true)
    expect(isModKey(ev({ altKey: true }))).toBe(false)
  })
  it('matches Mod+Shift+D case-insensitively and refuses without shift', () => {
    expect(matchesShortcut(ev({ metaKey: true, shiftKey: true, key: 'D' }), { key: 'd', shift: true })).toBe(true)
    expect(matchesShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'd' }), { key: 'd', shift: true })).toBe(true)
    expect(matchesShortcut(ev({ metaKey: true, key: 'd' }), { key: 'd', shift: true })).toBe(false)
  })
  it('matches Mod+J with no shift', () => {
    expect(matchesShortcut(ev({ metaKey: true, key: 'j' }), { key: 'j' })).toBe(true)
    expect(matchesShortcut(ev({ metaKey: true, shiftKey: true, key: 'j' }), { key: 'j' })).toBe(false)
  })
})
```

`apps/web/test/mode.test.tsx` — copy `theme.test.tsx`'s `installMatchMedia`/`installStorage` stubs and its `renders` probe idiom, then:
```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModeProvider, useMode } from '../src/components/mode/ModeProvider.js'
import { MODE_STORAGE_KEY } from '../src/lib/modeStorage.js'

// installStorage(): the same in-memory localStorage stub theme.test.tsx installs (copy it here).

const renders: string[] = []
function Probe(): React.JSX.Element {
  const { mode, isDeveloper, setMode, toggle } = useMode()
  renders.push(mode)
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="dev">{String(isDeveloper)}</span>
      <button data-testid="toggle" type="button" onClick={toggle} />
      <button data-testid="to-dev" type="button" onClick={() => setMode('developer')} />
    </div>
  )
}

beforeEach(() => { renders.length = 0; installStorage(); document.documentElement.removeAttribute('data-mode') })
afterEach(() => vi.unstubAllGlobals())

describe('ModeProvider', () => {
  it('renders simple first even when developer is stored (hydration must match the server)', async () => {
    localStorage.setItem(MODE_STORAGE_KEY, 'developer')
    render(<ModeProvider><Probe /></ModeProvider>)
    expect(renders[0]).toBe('simple')
    expect(await screen.findByText('developer')).toBeTruthy()
    expect(document.documentElement.getAttribute('data-mode')).toBe('developer')
  })
  it('removes the attribute for simple and never writes "simple" as an attribute value', async () => {
    render(<ModeProvider><Probe /></ModeProvider>)
    fireEvent.click(screen.getByTestId('to-dev'))
    expect(document.documentElement.getAttribute('data-mode')).toBe('developer')
    fireEvent.click(screen.getByTestId('toggle'))
    expect(document.documentElement.hasAttribute('data-mode')).toBe(false)
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('simple')
  })
  it('toggles on Mod+Shift+D and ignores Mod+D', () => {
    render(<ModeProvider><Probe /></ModeProvider>)
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', metaKey: true, shiftKey: true })) })
    expect(screen.getByTestId('mode').textContent).toBe('developer')
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true })) })
    expect(screen.getByTestId('mode').textContent).toBe('developer')
  })
  it('throws outside the provider', () => {
    expect(() => render(<Probe />)).toThrow(/ModeProvider/)
  })
})
```

- [ ] **Step 3: Run them to see them fail.** `npx vitest run apps/web/test/mode.test.tsx apps/web/test/shortcuts.test.ts` — FAIL: modules not found.

- [ ] **Step 4: Write the plain modules.**

`apps/web/src/lib/modeStorage.ts`:
```ts
/** The `localStorage` key the operator's MODE is remembered under (M61 R1). A plain module for the
 *  same reason `themeStorage.ts` is one: `app/layout.tsx` interpolates it into the pre-hydration
 *  script, and a server component importing it from a `'use client'` module would get a client
 *  reference rather than the string (M57 erratum E20). */
export const MODE_STORAGE_KEY = 'mode'
export type Mode = 'simple' | 'developer'
export const MODES: readonly Mode[] = ['simple', 'developer']
export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value)
}
```

`apps/web/src/lib/shortcuts.ts`:
```ts
interface KeyLike { readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean }
/** ⌘ on macOS, Ctrl elsewhere; never Alt (Alt+letter types a glyph on macOS). */
export function isModKey(event: KeyLike): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey
}
export function matchesShortcut(event: KeyLike, spec: { readonly key: string; readonly shift?: boolean }): boolean {
  if (!isModKey(event)) return false
  if (event.key.toLowerCase() !== spec.key.toLowerCase()) return false
  return event.shiftKey === (spec.shift ?? false)
}
```

- [ ] **Step 5: Write `ModeProvider.tsx`** — `ThemeProvider.tsx` clause for clause (flat initial state, `hydrated` flag, `try/catch` storage, attribute effect inert until hydrated), plus the listener:
```tsx
'use client'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { MODE_STORAGE_KEY, isMode, type Mode } from '../../lib/modeStorage'
import { matchesShortcut } from '../../lib/shortcuts'

export type { Mode }
export interface ModeState { readonly mode: Mode; readonly isDeveloper: boolean; readonly setMode: (next: Mode) => void; readonly toggle: () => void }
const ModeContext = createContext<ModeState | null>(null)

function readStored(): Mode { try { const raw = window.localStorage.getItem(MODE_STORAGE_KEY); return isMode(raw) ? raw : 'simple' } catch { return 'simple' } }
function writeStored(mode: Mode): void { try { window.localStorage.setItem(MODE_STORAGE_KEY, mode) } catch { /* attribute still applies this session */ } }

export function ModeProvider({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  const [mode, setModeState] = useState<Mode>('simple')
  const [hydrated, setHydrated] = useState(false)
  useEffect((): void => { setModeState(readStored()); setHydrated(true) }, [])
  // `simple` REMOVES the attribute: absent is simple, and every `[data-mode='developer']` selector
  // in the token sheet is written against presence, never against a second value.
  useEffect((): void => {
    if (!hydrated) return
    if (mode === 'developer') document.documentElement.setAttribute('data-mode', 'developer')
    else document.documentElement.removeAttribute('data-mode')
  }, [mode, hydrated])
  const setMode = useCallback((next: Mode): void => { setModeState(next); writeStored(next) }, [])
  const toggle = useCallback((): void => { setModeState((was) => { const next: Mode = was === 'simple' ? 'developer' : 'simple'; writeStored(next); return next }) }, [])
  // Mod+Shift+D. A keyboard toggle animates nothing -- there is nothing here to animate, and the
  // token sheet transitions no colour on `data-mode` (R1).
  useEffect((): (() => void) => {
    const onKey = (event: KeyboardEvent): void => { if (matchesShortcut(event, { key: 'd', shift: true })) { event.preventDefault(); toggle() } }
    window.addEventListener('keydown', onKey)
    return (): void => window.removeEventListener('keydown', onKey)
  }, [toggle])
  const value = useMemo<ModeState>(() => ({ mode, isDeveloper: mode === 'developer', setMode, toggle }), [mode, setMode, toggle])
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>
}
export function useMode(): ModeState {
  const value = useContext(ModeContext)
  if (value === null) throw new Error('useMode must be used inside <ModeProvider>')
  return value
}
export const MODE_LABEL: Record<Mode, string> = { simple: 'Simple', developer: 'Developer' }
```

- [ ] **Step 6: Run the two tests to green.** `npx vitest run apps/web/test/mode.test.tsx apps/web/test/shortcuts.test.ts` — PASS.

- [ ] **Step 7: Extend `tokens.test.ts` (failing first).** Add, reading the two new files the same way `CSS` is read:
```ts
const SIMPLE = readFileSync(fileURLToPath(new URL('../src/app/tokens/simple.css', import.meta.url)), 'utf8')
const DEVELOPER = readFileSync(fileURLToPath(new URL('../src/app/tokens/developer.css', import.meta.url)), 'utf8')
const SURFACE_TOKENS = ['--glass', '--glass-strong', '--edge']
const FRAME_TOKENS = ['--radius-control', '--radius-surface', '--radius-sheet', '--fs-body', '--row-h', '--gap-1', '--gap-2', '--gap-3', '--ease-out', '--ease-in-out', '--dur-fast', '--dur-base', '--dur-slow']

describe('the two mode palettes (M61 R2)', () => {
  it('imports both token files right after tailwind', () => {
    expect(CSS.indexOf("@import './tokens/simple.css'")).toBeGreaterThan(CSS.indexOf("@import 'tailwindcss'"))
    expect(CSS).toContain("@import './tokens/developer.css'")
  })
  it('declares every palette token three times in each file', () => {
    for (const file of [SIMPLE, DEVELOPER]) for (const token of NEW_TOKENS) {
      expect(file.split(`${token}:`).length - 1, token).toBe(3)
    }
  })
  it('guards every developer selector on the attribute and no simple selector on it', () => {
    expect(DEVELOPER).toContain(":root[data-mode='developer'] {")
    expect(DEVELOPER).toContain(":root[data-mode='developer']:not([data-theme='light'])")
    expect(DEVELOPER).toContain(":root[data-mode='developer'][data-theme='dark']")
    expect(SIMPLE).not.toContain('data-mode')
    expect(SIMPLE).toContain('\n:root {')
    expect(SIMPLE).toContain(":root:not([data-theme='light'])")
    expect(SIMPLE).toContain(":root[data-theme='dark']")
  })
  it('keeps the status tones identical across the two modes, per theme', () => {
    const tones = (css: string, selector: string): string[] => blockIn(css, selector).match(/--s-[a-z]+: [^;]+/g) ?? []
    expect(tones(SIMPLE, '\n:root {')).toEqual(tones(DEVELOPER, ":root[data-mode='developer'] {"))
    expect(tones(SIMPLE, ":root[data-theme='dark']")).toEqual(tones(DEVELOPER, ":root[data-mode='developer'][data-theme='dark']"))
  })
  it('declares the surface tokens in both files and the frame tokens in globals', () => {
    for (const t of SURFACE_TOKENS) { expect(SIMPLE).toContain(`${t}:`); expect(DEVELOPER).toContain(`${t}:`) }
    for (const t of FRAME_TOKENS) expect(CSS).toContain(`${t}:`)
  })
  it('aliases the eleven old radii onto the three new ones', () => {
    for (const [old, target] of [['chip', 'control'], ['nav', 'control'], ['tile', 'control'], ['card', 'control'], ['panel', 'control'], ['tile-lg', 'surface'], ['panel-card', 'surface'], ['page-card', 'sheet'], ['bubble', 'sheet']]) {
      expect(CSS).toContain(`--radius-${old}: var(--radius-${target});`)
    }
    expect(CSS).toContain('--radius-pill: 999px')
  })
  it('never spells transition: all', () => { expect(CSS).not.toMatch(/transition:\s*all/) })
})
```
(`blockIn(css, selector)` is `blockOf` parameterised on the text; refactor `blockOf` to call it. The existing `blockOf('\n:root {')` assertions on `CSS` now read the palette from `SIMPLE` — update them: the light palette is `blockIn(SIMPLE, '\n:root {')`; the alias-layer assertions stay on `CSS`.)

- [ ] **Step 8: Write the two token files and rewrite `globals.css`'s head.**

`apps/web/src/app/tokens/simple.css` (the values from spec R2; three blocks; `--shadow-card`/`--shadow-resting` in the dark blocks as today; plus in every block `--glass`, `--glass-strong`, `--edge`):
```css
/* M61 R2 -- SIMPLE mode: the warm palette the mockups were drawn in. Bare `:root` selectors:
 * simple is the ABSENCE of `data-mode`, exactly as system is the absence of `data-theme`. */
:root {
  --bg: #f7f3ec; --panel: #fbf8f2; --card: #ffffff;
  --line: rgba(40, 32, 20, 0.09); --line2: rgba(40, 32, 20, 0.16);
  --t1: #1c1813; --t2: #5f584e; --t3: #7a7266;
  --hover: rgba(40, 32, 20, 0.045); --sel: rgba(40, 32, 20, 0.07);
  --accent: #b8781a; --accent-ink: #ffffff;
  --s-working: #0b7466; --s-planning: #4453d6; --s-review: #7d3fc9; --s-waiting: #9a6200;
  --s-blocked: #c43a31; --s-done: #1f7d45; --s-paused: #6b7080; --s-idle: #8a8b85;
  --glass: color-mix(in srgb, var(--panel) 72%, transparent);
  --glass-strong: color-mix(in srgb, var(--panel) 88%, transparent);
  --edge: rgba(255, 255, 255, 0.7);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) {
    --bg: #121110; --panel: #171513; --card: #1d1a17;
    --line: rgba(255, 252, 246, 0.08); --line2: rgba(255, 252, 246, 0.15);
    --t1: #efe9df; --t2: #a39c8f; --t3: #857f74;
    --hover: rgba(255, 252, 246, 0.05); --sel: rgba(255, 252, 246, 0.08);
    --accent: #f2b544; --accent-ink: #1a1305;
    --s-working: #2ee6cf; --s-planning: #7b8cff; --s-review: #c084fc; --s-waiting: #f5b34a;
    --s-blocked: #f87171; --s-done: #4ade80; --s-paused: #8a929e; --s-idle: #6b7280;
    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4); --shadow-resting: 0 4px 16px rgba(0, 0, 0, 0.35);
    --edge: rgba(255, 255, 255, 0.06);
  }
}
:root[data-theme='dark'] { /* the same block again, pinned */ }
```
Write each block out in full (one declaration per line, like the file today); the dark block is repeated verbatim under `:root[data-theme='dark']`. `developer.css` is the same three-block shape with the selectors from spec R2 and TODAY's values copied from `globals.css:27-46`, `:110-131`, `:138-159` verbatim, plus the same three surface tokens.

In `globals.css`: delete the three palette blocks (the `:root { --bg … --s-idle }` values at lines 27–46 only — the radius, shadow, font and alias declarations in that block STAY on `:root`; the two whole dark blocks at 108–160 go), add after `@import 'tailwindcss';`:
```css
@import './tokens/simple.css';
@import './tokens/developer.css';
```
and add to the `:root` block:
```css
  /* ---- M61 R3: three radii, and every old name is an alias of one of them ------------------ */
  --radius-control: 8px;
  --radius-surface: 12px;
  --radius-sheet: 16px;
  --radius-chip: var(--radius-control);
  --radius-nav: var(--radius-control);
  --radius-tile: var(--radius-control);
  --radius-card: var(--radius-control);
  --radius-panel: var(--radius-control);
  --radius-tile-lg: var(--radius-surface);
  --radius-panel-card: var(--radius-surface);
  --radius-page-card: var(--radius-sheet);
  --radius-bubble: var(--radius-sheet);
  --radius-pill: 999px;
  --radius-hair: 2px;
  /* ---- density (developer overrides below) and motion ------------------------------------- */
  --fs-body: 14px; --row-h: 40px; --gap-1: 8px; --gap-2: 12px; --gap-3: 16px;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --dur-fast: 120ms; --dur-base: 180ms; --dur-slow: 240ms;
```
(replacing the eleven old radius declarations), then after the `@theme inline` block:
```css
:root[data-mode='developer'] { --fs-body: 13px; --row-h: 34px; --gap-1: 6px; --gap-2: 8px; --gap-3: 12px; }
@media (prefers-reduced-transparency: reduce) { :root { --glass: var(--panel); --glass-strong: var(--panel); } }
body { font-size: var(--fs-body); }   /* replaces the literal 14px */
.glass { background: var(--glass); backdrop-filter: blur(20px) saturate(160%); -webkit-backdrop-filter: blur(20px) saturate(160%); }
@media (prefers-reduced-transparency: reduce) { .glass { backdrop-filter: none; -webkit-backdrop-filter: none; } }
.type-label { font-size: 11px; font-weight: 500; letter-spacing: 0.01em; color: var(--t2); }
.type-meta { font-size: 12.5px; font-weight: 400; }
.type-body { font-size: var(--fs-body); font-weight: 400; }
.type-title { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.25; }
.type-heading { font-size: 20px; font-weight: 600; letter-spacing: -0.015em; line-height: 1.2; }
.type-display { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; }
```
Add to `@theme inline`: `--color-glass: var(--glass); --color-glass-strong: var(--glass-strong); --color-edge: var(--edge); --radius-control: var(--radius-control); --radius-surface: var(--radius-surface); --radius-sheet: var(--radius-sheet);`.

- [ ] **Step 9: The boot script.** In `layout.tsx` replace `THEME_SCRIPT` with:
```ts
import { MODE_STORAGE_KEY } from '../lib/modeStorage'
const BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t)}var m=localStorage.getItem(${JSON.stringify(MODE_STORAGE_KEY)});if(m==='developer'){document.documentElement.setAttribute('data-mode','developer')}}catch(e){}})()`
```
and wrap the tree: `<ThemeProvider><ModeProvider><RightPanelProvider>…`. Update the docstring above the script to name both keys.

- [ ] **Step 10: Appearance gains the mode control.** In `SettingsClient.tsx`'s Appearance section, under the theme `Segmented`, add a second `Segmented` with `options={[{id:'simple',label:'Simple'},{id:'developer',label:'Developer'}]}`, `value={mode}`, `onChange={setMode}`, `ariaLabel="Mode"`, `testIdPrefix="appearance-mode"`, and a one-line `.type-meta` under it: `Simple hides the developer views; developer mode shows everything and packs it tighter.` Extend `settings-page.test.tsx`: render inside `ModeProvider` (add it to the test's wrapper), click `appearance-mode-developer`, expect `document.documentElement.dataset.mode === 'developer'`.

- [ ] **Step 11: Run the web unit suite, typecheck, build.** `npx vitest run apps/web` — every test green (the `tokens.test.ts` rewrites included). Then `npm run gate:m26-vocabulary`, `npx tsc --build`, `npm run --silent typecheck`, `pgrep -af "next dev"` then `npm run web:build`.

- [ ] **Step 12: Commit.**
```bash
git add apps/web/src/lib/modeStorage.ts apps/web/src/lib/shortcuts.ts apps/web/src/components/mode/ModeProvider.tsx apps/web/src/app/tokens/simple.css apps/web/src/app/tokens/developer.css apps/web/src/app/globals.css apps/web/src/app/layout.tsx apps/web/src/components/SettingsClient.tsx apps/web/test/mode.test.tsx apps/web/test/shortcuts.test.ts apps/web/test/tokens.test.ts apps/web/test/settings-page.test.tsx
git commit -m "feat(web): simple/developer mode -- attribute, storage, boot script, four palettes (M61 R1-R3)"
```

---

### Task 2: The pure tables — routes by mode, task progress, happening sentences

**Files:**
- Modify: `apps/web/src/lib/routes.ts`
- Create: `apps/web/src/lib/progress.ts`, `apps/web/src/lib/happening.ts`
- Test: `apps/web/test/routes.test.ts` (rewrite the `SECTIONS`/`VIEWS` blocks), `apps/web/test/progress.test.ts`, `apps/web/test/happening.test.ts`

**Interfaces:**
- Consumes: `Mode` from `lib/modeStorage`; `TaskStatus` from `@slave-of-ai/domain`; `feedSummary` from `lib/feedSummary`; `DomainEventType` from `@slave-of-ai/db`.
- Produces:
  ```ts
  export type TabId = 'team' | 'tasks' | 'office' | 'activity' | 'graph' | 'knowledge'
  export type Section = TabId | 'settings'
  export interface TabSpec { readonly id: TabId; readonly label: string; readonly href: (workspaceId: string, mode: Mode) => string; readonly modes: readonly Mode[] }
  export const TABS: readonly TabSpec[]
  export function tabsFor(mode: Mode): readonly TabSpec[]
  export type RailId = 'home' | 'people' | 'settings' | 'simulations' | 'analytics'
  export interface RailSpec { readonly id: RailId; readonly label: string; readonly href: string; readonly modes: readonly Mode[] }
  export const RAIL: readonly RailSpec[]
  export function railFor(mode: Mode): readonly RailSpec[]
  export function railIdOf(pathname: string): RailId | null
  export const VIEWS: readonly ViewSpec[]            // analytics only
  export function sectionOf(pathname: string): Section | null   // '/w/:id' → 'team'; '/w/:id/organization' → 'team'
  export function viewOf(pathname: string): ViewId | null         // always null now except future views; kept for callers
  export function breadcrumbOf(pathname: string, projectName: string | null): readonly Crumb[]  // unchanged shape
  export const PROGRESS_FOR_TASK_STATUS: Record<TaskStatus, number | null>
  export function progressOf(status: TaskStatus | null, runPct: number | null): number | null
  export const HAPPENING_TYPES: readonly DomainEventType[]
  export interface HappeningNames { readonly actor: string | null; readonly taskTitle: string | null }
  export function happeningSentence(type: string, payload: Record<string, unknown>, names: HappeningNames): string
  ```

- [ ] **Step 1: Rewrite the failing `routes.test.ts` head** — replace the `SECTIONS`/`VIEWS` describes with:
```ts
describe('TABS', () => {
  it('is the six tabs, team first, keyed by route segment', () => {
    expect(TABS.map((t) => t.id)).toEqual(['team', 'tasks', 'office', 'activity', 'graph', 'knowledge'])
  })
  it('shows four in simple mode and six in developer mode', () => {
    expect(tabsFor('simple').map((t) => t.id)).toEqual(['team', 'tasks', 'office', 'activity'])
    expect(tabsFor('developer').map((t) => t.id)).toEqual(['team', 'tasks', 'office', 'activity', 'graph', 'knowledge'])
  })
  it('points Team at the bare project route and Work at /tasks', () => {
    expect(TABS[0]?.href('w1', 'simple')).toBe('/w/w1')
    expect(TABS.find((t) => t.id === 'tasks')?.label).toBe('Work')
  })
  it("gives Activity the digest in simple mode and the river in developer mode (R10)", () => {
    const activity = TABS.find((t) => t.id === 'activity')
    expect(activity?.href('w1', 'simple')).toBe('/w/w1/activity?view=digest')
    expect(activity?.href('w1', 'developer')).toBe('/w/w1/activity')
  })
})
describe('RAIL', () => {
  it('is Home, People, Settings for everybody and Simulations, Analytics for developers', () => {
    expect(railFor('simple').map((r) => r.id)).toEqual(['home', 'people', 'settings'])
    expect(railFor('developer').map((r) => r.id)).toEqual(['home', 'people', 'settings', 'simulations', 'analytics'])
    expect(RAIL.find((r) => r.id === 'people')?.href).toBe('/workforce')
  })
  it('answers which rail item a global path lights', () => {
    expect(railIdOf('/')).toBe('home'); expect(railIdOf('/workforce?tab=catalog')).toBe('people')
    expect(railIdOf('/sim/abc')).toBe('simulations'); expect(railIdOf('/w/w1')).toBe(null)
  })
})
describe('sectionOf', () => {
  it('answers team for the project root AND for /organization (the redirect target, R7)', () => {
    expect(sectionOf('/w/w1')).toBe('team'); expect(sectionOf('/w/w1/organization')).toBe('team')
    expect(sectionOf('/w/w1/tasks')).toBe('tasks'); expect(sectionOf('/w/w1/graph')).toBe('graph')
    expect(sectionOf('/w/w1/settings')).toBe('settings'); expect(sectionOf('/workforce')).toBe(null)
  })
})
describe('VIEWS', () => { it('is analytics alone now that graph and office are tabs', () => { expect(VIEWS.map((v) => v.id)).toEqual(['analytics']) }) })
```
Keep the existing `workspaceIdOf`, `isGlobalRoute` and `breadcrumbOf` tests; change the breadcrumb expectations so `/w/w1` reads `Projects / <name>` (unchanged), `/w/w1/tasks` reads `… / Work`, `/w/w1/organization` reads `… / <name>` (Team is the project's page, so no third crumb — same rule Overview had).

- [ ] **Step 2: Write `progress.test.ts` and `happening.test.ts`.**
```ts
import { describe, expect, it } from 'vitest'
import { PROGRESS_FOR_TASK_STATUS, progressOf } from '../src/lib/progress.js'
describe('PROGRESS_FOR_TASK_STATUS', () => {
  it('covers all thirteen statuses and is monotone through the pipeline', () => {
    expect(Object.keys(PROGRESS_FOR_TASK_STATUS).sort()).toEqual(['assigned','backlog','blocked','cancelled','done','failed','merging','ready','reviewing','rework','running','verifying','waiting'].sort())
    expect([PROGRESS_FOR_TASK_STATUS.ready, PROGRESS_FOR_TASK_STATUS.assigned, PROGRESS_FOR_TASK_STATUS.running, PROGRESS_FOR_TASK_STATUS.verifying, PROGRESS_FOR_TASK_STATUS.reviewing, PROGRESS_FOR_TASK_STATUS.merging, PROGRESS_FOR_TASK_STATUS.done]).toEqual([0, 10, 35, 60, 80, 90, 100])
    expect(PROGRESS_FOR_TASK_STATUS.blocked).toBe(null)
  })
  it('moves inside the running band with the live run and never past 60', () => {
    expect(progressOf('running', 0)).toBe(35); expect(progressOf('running', 100)).toBe(60); expect(progressOf('running', 50)).toBe(48)
    expect(progressOf('verifying', 100)).toBe(60); expect(progressOf(null, 50)).toBe(null); expect(progressOf('blocked', 50)).toBe(null)
  })
})
```
```ts
import { describe, expect, it } from 'vitest'
import { HAPPENING_TYPES, happeningSentence } from '../src/lib/happening.js'
const names = { actor: 'Emma', taskTitle: 'Checkout form' }
describe('happeningSentence', () => {
  it('names the actor and quotes the task for task.completed', () => {
    expect(happeningSentence('task.completed', {}, names)).toBe('Emma finished "Checkout form"')
  })
  it('says who started what', () => { expect(happeningSentence('run.started', {}, names)).toBe('Emma started "Checkout form"') })
  it('reads the operator request off workspace.goal_set', () => {
    expect(happeningSentence('workspace.goal_set', { request: 'Use Stripe' }, { actor: null, taskTitle: null })).toBe('You asked for: Use Stripe')
  })
  it('falls back to feedSummary for a type it does not name', () => {
    expect(happeningSentence('run.tool_call', { summary: 'read src/a.ts' }, names)).toBe('read src/a.ts')
  })
  it('never leaks a bare event type', () => {
    for (const type of HAPPENING_TYPES) expect(happeningSentence(type, {}, { actor: null, taskTitle: null })).not.toMatch(/^[a-z_]+\.[a-z_]+$/)
  })
})
```

- [ ] **Step 3: Run all three — FAIL.**

- [ ] **Step 4: Implement `routes.ts`.** Keep `workspaceIdOf`, `isGlobalRoute`, `segmentOf`, `Crumb`, `GLOBAL_CRUMB` and `breadcrumbOf`'s shape. Replace `SECTIONS` with `TABS` and add `RAIL`:
```ts
import type { Mode } from './modeStorage'
export type TabId = 'team' | 'tasks' | 'office' | 'activity' | 'graph' | 'knowledge'
export type Section = TabId | 'settings'
export interface TabSpec { readonly id: TabId; readonly label: string; readonly href: (workspaceId: string, mode: Mode) => string; readonly modes: readonly Mode[] }
const BOTH: readonly Mode[] = ['simple', 'developer']
const DEV: readonly Mode[] = ['developer']
export const TABS: readonly TabSpec[] = [
  { id: 'team', label: 'Team', href: (id) => `/w/${id}`, modes: BOTH },
  { id: 'tasks', label: 'Work', href: (id) => `/w/${id}/tasks`, modes: BOTH },
  { id: 'office', label: 'Office', href: (id) => `/w/${id}/office`, modes: BOTH },
  { id: 'activity', label: 'Activity', href: (id, mode) => (mode === 'simple' ? `/w/${id}/activity?view=digest` : `/w/${id}/activity`), modes: BOTH },
  { id: 'graph', label: 'Graph', href: (id) => `/w/${id}/graph`, modes: DEV },
  { id: 'knowledge', label: 'Knowledge', href: (id) => `/w/${id}/knowledge`, modes: DEV },
]
export function tabsFor(mode: Mode): readonly TabSpec[] { return TABS.filter((tab) => tab.modes.includes(mode)) }
export type RailId = 'home' | 'people' | 'settings' | 'simulations' | 'analytics'
export interface RailSpec { readonly id: RailId; readonly label: string; readonly href: string; readonly modes: readonly Mode[] }
export const RAIL: readonly RailSpec[] = [
  { id: 'home', label: 'Home', href: '/', modes: BOTH },
  { id: 'people', label: 'People', href: '/workforce', modes: BOTH },
  { id: 'settings', label: 'Settings', href: '/settings', modes: BOTH },
  { id: 'simulations', label: 'Simulations', href: '/sim', modes: DEV },
  { id: 'analytics', label: 'Analytics', href: '/analytics', modes: DEV },
]
export function railFor(mode: Mode): readonly RailSpec[] { return RAIL.filter((item) => item.modes.includes(mode)) }
export function railIdOf(pathname: string): RailId | null {
  if (workspaceIdOf(pathname) !== null) return null
  const path = pathname.split('?')[0] ?? pathname
  if (path === '/') return 'home'
  const hit = RAIL.find((item) => item.href !== '/' && (path === item.href || path.startsWith(`${item.href}/`)))
  return hit?.id ?? null
}
const TAB_IDS: ReadonlySet<string> = new Set(TABS.map((t) => t.id))
export function sectionOf(pathname: string): Section | null {
  if (workspaceIdOf(pathname) === null) return null
  const segment = segmentOf(pathname)
  if (segment === null || segment === 'organization') return 'team'
  if (segment === 'settings') return 'settings'
  return TAB_IDS.has(segment) ? (segment as TabId) : null
}
export type ViewId = 'analytics'
export const VIEWS: readonly ViewSpec[] = [{ id: 'analytics', label: 'Analytics', href: (id) => `/analytics?workspace=${id}` }]
export function viewOf(_pathname: string): ViewId | null { return null }
```
In `breadcrumbOf`, the leaf is `TABS.find(t => t.id === sectionOf(p) && t.id !== 'team')?.label ?? (sectionOf(p) === 'settings' ? 'Settings' : null)`. Grep for every importer of `SECTIONS`/`viewOf`/`VIEWS` (`Header.tsx`, `SidebarTree.tsx`, `gate-surface-parity.test.ts`, gates) and fix the imports that still compile; `SidebarTree.tsx` is deleted in Task 3, so for THIS task change its `SECTIONS` reference to `tabsFor('developer')` and `section.href(id)` to `section.href(id, 'developer')` so the tree keeps compiling until Task 3 removes it.

- [ ] **Step 5: Implement `progress.ts` and `happening.ts`.**
```ts
import type { TaskStatus } from '@slave-of-ai/domain'
/** A PRESENTATION table (spec R8), total so a fourteenth status is a build failure. `null` draws no bar. */
export const PROGRESS_FOR_TASK_STATUS: Record<TaskStatus, number | null> = {
  backlog: 0, ready: 0, assigned: 10, running: 35, verifying: 60, reviewing: 80, merging: 90, rework: 35,
  waiting: null, blocked: null, done: 100, failed: null, cancelled: null,
}
/** While a run is live the bar moves inside the running band (35→60) with the run's own step
 *  progress (plan erratum E2); every other status is the table's value. */
export function progressOf(status: TaskStatus | null, runPct: number | null): number | null {
  if (status === null) return null
  const base = PROGRESS_FOR_TASK_STATUS[status]
  if (status !== 'running' || runPct === null || base === null) return base
  return Math.round(base + Math.max(0, Math.min(100, runPct)) * 0.25)
}
```
```ts
import type { DomainEventType } from '@slave-of-ai/db'
import { feedSummary } from './feedSummary'
export interface HappeningNames { readonly actor: string | null; readonly taskTitle: string | null }
const quoted = (n: HappeningNames): string => (n.taskTitle === null ? 'a task' : `"${n.taskTitle}"`)
const who = (n: HappeningNames): string => n.actor ?? 'Somebody'
const str = (p: Record<string, unknown>, k: string): string | null => (typeof p[k] === 'string' ? (p[k] as string) : null)
/** The families Home's feed and the Activity digest draw from (spec R10/R11). */
export const HAPPENING_TYPES: readonly DomainEventType[] = [
  'workspace.goal_set', 'supervisor.proposed', 'supervisor.decided', 'task.created', 'task.assigned', 'task.completed',
  'task.verified', 'task.blocked', 'run.started', 'run.completed', 'run.failed', 'merge.queued', 'merge.merged',
  'review.approved', 'review.rejected',
]
const SENTENCE: Partial<Record<DomainEventType, (p: Record<string, unknown>, n: HappeningNames) => string>> = {
  'workspace.goal_set': (p) => `You asked for: ${str(p, 'request') ?? str(p, 'goal') ?? 'a new goal'}`,
  'supervisor.proposed': (p) => `The Supervisor proposed: ${str(p, 'summary') ?? 'a change'}`,
  'supervisor.decided': (p) => `The Supervisor decided: ${str(p, 'summary') ?? str(p, 'decision') ?? 'something'}`,
  'task.created': (_p, n) => `${quoted(n)} was added to the board`,
  'task.assigned': (_p, n) => `${who(n)} picked up ${quoted(n)}`,
  'task.completed': (_p, n) => `${who(n)} finished ${quoted(n)}`,
  'task.verified': (_p, n) => `${quoted(n)} passed verification`,
  'task.blocked': (_p, n) => `${quoted(n)} is blocked and needs you`,
  'run.started': (_p, n) => `${who(n)} started ${quoted(n)}`,
  'run.completed': (_p, n) => `${who(n)} wrapped up ${quoted(n)}`,
  'run.failed': (_p, n) => `${who(n)} hit a failure on ${quoted(n)}`,
  'merge.queued': (_p, n) => `${quoted(n)} is waiting to merge`,
  'merge.merged': (_p, n) => `${quoted(n)} was merged`,
  'review.approved': (_p, n) => `${who(n)} approved ${quoted(n)}`,
  'review.rejected': (_p, n) => `${who(n)} asked for changes on ${quoted(n)}`,
}
export function happeningSentence(type: string, payload: Record<string, unknown>, names: HappeningNames): string {
  const make = SENTENCE[type as DomainEventType]
  return make === undefined ? feedSummary(type, payload) : make(payload, names)
}
```
Check every type name in `HAPPENING_TYPES` against `packages/db/src/enums.ts`'s `DomainEventType` union (`grep -n "'task\.\|'run\.\|'merge\.\|'review\.\|'supervisor\." packages/db/src/enums.ts`); drop any that does not exist and add the nearest that does, keeping the test's five cases true.

- [ ] **Step 6: Green, then the usual tail.** `npx vitest run apps/web/test/routes.test.ts apps/web/test/progress.test.ts apps/web/test/happening.test.ts apps/web/test/header.test.tsx apps/web/test/sidebar-tree.test.tsx apps/web/test/integration/gate-surface-parity.test.ts` (the last needs the DB; it pins the column table only, so it should still pass). Then m26, tsc, typecheck, web:build.

- [ ] **Step 7: Commit.** `git add apps/web/src/lib/routes.ts apps/web/src/lib/progress.ts apps/web/src/lib/happening.ts apps/web/src/components/shell/SidebarTree.tsx apps/web/src/components/shell/Header.tsx apps/web/test/routes.test.ts apps/web/test/progress.test.ts apps/web/test/happening.test.ts` and any other importer you touched; `git commit -m "feat(web): routes learn the mode; task progress and happening-sentence tables (M61 R8, R10, R18)"`.

---

### Task 3: The fixed-viewport frame — ScrollArea, rail, header switcher, remembered Supervisor

**Files:**
- Create: `apps/web/src/components/ui/ScrollArea.tsx`, `apps/web/src/components/shell/Rail.tsx`, `apps/web/src/components/shell/icons.tsx`, `apps/web/src/components/shell/ProjectSwitcher.tsx`, `apps/web/src/components/shell/HeaderSearch.tsx`, `apps/web/src/lib/supervisorStorage.ts`
- Modify: `apps/web/src/components/shell/AppShell.tsx`, `ShellFrame.tsx`, `RightColumn.tsx`, `RightPanelProvider.tsx`, `RightPanelHost.tsx`, `RightPanel.tsx`, `Header.tsx`, `apps/web/src/app/layout.tsx`, `apps/web/src/app/globals.css` (`html, body`)
- Delete: `apps/web/src/components/shell/SidebarTree.tsx`, `apps/web/test/sidebar-tree.test.tsx`
- Test: `apps/web/test/app-shell.test.tsx`, `shell.test.tsx`, `header.test.tsx`, `right-panel.test.tsx` (extend), `apps/web/test/rail.test.tsx`, `scroll-area.test.tsx`, `project-switcher.test.tsx` (new)
- Gates (selector edits only, run in Task 11): `scripts/gate-m57-ui-redesign.mjs`, `gate-m45-project-experience.mjs`, `gate-m44-ux-foundation.mjs`, `gate-m49-memory.mjs`, `gate-m14-fidelity.mjs` — every `sidebar-*` selector per spec §3

**Interfaces:**
- Consumes: `railFor`, `railIdOf`, `tabsFor`, `sectionOf`, `workspaceIdOf`, `breadcrumbOf` (Task 2); `useMode` (Task 1); `matchesShortcut`.
- Produces: `ScrollArea({ axis?: 'y' | 'x' | 'both'; className?; testId?; children })`; `RightWidth = 'panel' | 'dock' | 'none' | 'overlay'`; `useRightWidth()`; `SUPERVISOR_STORAGE_KEY = 'supervisor'`, values `'open' | 'collapsed'`; `Rail({ children? })`; `ProjectSwitcher({ projects: readonly SidebarProject[]; currentId: string | null; currentName: string | null })`; `HeaderSearch()`; testids `rail`, `rail-item[data-rail]`, `mode-toggle`, `project-switcher`, `project-switcher-item`, `search`, `scroll-area`.

- [ ] **Step 1: Failing tests.**

`scroll-area.test.tsx`: renders `<ScrollArea testId="x"><div style={{height: 2000}} /></ScrollArea>` and asserts the element has `data-testid="x"`, class contains `overflow-y-auto` for the default axis and `overflow-x-auto` for `axis="x"`, and `min-h-0`.

`rail.test.tsx`: inside `ModeProvider` + a mocked `usePathname` (`vi.mock('next/navigation', () => ({ usePathname: () => '/workforce', useSearchParams: () => new URLSearchParams() }))`), renders `<Rail />`; expects three `rail-item`s whose `data-rail` are `home, people, settings`; the `people` one has `aria-current="page"`; clicking `mode-toggle` makes it five with `simulations, analytics` last and `aria-checked="true"` on the toggle; `theme-toggle`, `sidebar-live` and `skip-link` present.

`project-switcher.test.tsx`: renders `<ProjectSwitcher projects={[{id:'a',name:'Alpha',archived:false,status:'working',statusLabel:'Working',needsYouCount:2,tasksActive:1},{id:'b',name:'Beta',…needsYouCount:0}]} currentId="a" currentName="Alpha" />`; the trigger `project-switcher` reads `Alpha`; clicking it shows two `project-switcher-item`s with `data-needs-you="2"` on the first and a last row `new-project`; `Escape` closes it and returns focus to the trigger.

`right-panel.test.tsx` additions: with `localStorage.supervisor = 'collapsed'` the provider's `collapsed` is `true` after hydration; `collapse()` writes `'collapsed'`; a `keydown` `Mod+J` toggles it.

`app-shell.test.tsx`: `data-right="overlay"` sets the two-track template; the grid class contains `h-dvh` and `min-w-[1024px]`, not `min-h-screen`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: `ScrollArea`.**
```tsx
import type React from 'react'
const AXIS = { y: 'overflow-y-auto overflow-x-hidden', x: 'overflow-x-auto overflow-y-hidden', both: 'overflow-auto' } as const
/** The ONE scrolling region (M61 R4). The page never scrolls; this does. `min-h-0` + `flex-1` is
 *  what lets it take the rest of a flex column instead of pushing the column taller than the frame. */
export function ScrollArea({ axis = 'y', className = '', testId = 'scroll-area', children }: {
  readonly axis?: keyof typeof AXIS; readonly className?: string; readonly testId?: string; readonly children: React.ReactNode
}): React.JSX.Element {
  return <div data-testid={testId} data-scroll-axis={axis} className={`min-h-0 min-w-0 flex-1 [overscroll-behavior:contain] ${AXIS[axis]} ${className}`}>{children}</div>
}
```

- [ ] **Step 4: The frame.** `globals.css`: `html, body { height: 100%; overflow: hidden; }` (add beside the `body` rule; `body` keeps `min-h-screen` off — remove `className="min-h-screen"` from `<body>` in `layout.tsx`). `AppShell.tsx`: `RightWidth` gains `'overlay'`; `TRACK` gains `overlay: '56px minmax(0, 1fr)'`; the other three tracks change their first column from `236px` to `56px` and `panel` to `340px`; the grid class becomes `grid h-dvh min-h-[680px] min-w-[1024px] bg-bg text-t1`; `<main>` loses `overflow-y-auto` and gains `overflow-hidden`. `RightColumn.tsx`:
```ts
const NARROW = '(max-width: 1279px)'
function subscribe(cb: () => void): () => void { const q = window.matchMedia(NARROW); q.addEventListener('change', cb); return () => q.removeEventListener('change', cb) }
export function useRightWidth(): RightWidth {
  const pathname = usePathname(); const { collapsed } = useRightPanel()
  const narrow = useSyncExternalStore(subscribe, () => window.matchMedia(NARROW).matches, () => false)
  if (workspaceIdOf(pathname) === null) return 'none'
  if (collapsed) return 'dock'
  return narrow ? 'overlay' : 'panel'
}
```
`RightPanelHost`: read `useRightWidth()`; when `'overlay'` render `<div data-testid="right-overlay" className="glass fixed inset-y-0 right-0 z-30 w-[340px] border-l border-line shadow-resting"><RightPanel>…</RightPanel></div>`; the dock renders as today.

- [ ] **Step 5: Remembered Supervisor + `⌘J`.** `lib/supervisorStorage.ts` exports `SUPERVISOR_STORAGE_KEY = 'supervisor'` and `type SupervisorChoice = 'open' | 'collapsed'`. In `RightPanelProvider`: `collapsed` starts `false`; a mount effect reads storage (try/catch) and sets it; `collapse()`/`expand()` write `'collapsed'`/`'open'`; a `keydown` listener for `matchesShortcut(e, { key: 'j' })` calls `collapsed ? expand() : collapse()` — inside the provider, so it works on every route with a panel. Document in the provider's docstring that the `open()` un-collapse rule (M57 scan finding 21) still applies and also writes `'open'`.

- [ ] **Step 6: The rail and the icons.** `icons.tsx`: seven `function XIcon(props: React.SVGProps<SVGSVGElement>)` components, each `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>` with paths: Home `M3 9.5 10 3l7 6.5V17H3z M8 17v-5h4v5`; People `M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M14 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M2 17c0-3 2.5-5 5-5s5 2 5 5 M12.5 12.5c2.5 0 4.5 2 4.5 4.5`; Settings `M10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M16.5 10a6.5 6.5 0 0 0-.1-1l1.6-1.2-1.5-2.6-1.9.7a6.5 6.5 0 0 0-1.7-1L12.5 3h-5l-.4 2a6.5 6.5 0 0 0-1.7 1l-1.9-.7L2 7.8 3.6 9a6.5 6.5 0 0 0 0 2L2 12.2l1.5 2.6 1.9-.7a6.5 6.5 0 0 0 1.7 1l.4 2h5l.4-2a6.5 6.5 0 0 0 1.7-1l1.9.7 1.5-2.6-1.6-1.2c.1-.3.1-.7.1-1z`; Flask `M8 3h4 M9 3v5l-4.5 7.5A1.5 1.5 0 0 0 5.8 18h8.4a1.5 1.5 0 0 0 1.3-2.5L11 8V3`; Chart `M3 17h14 M5 14V9 M9 14V5 M13 14v-3 M17 14V7`; Search `M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M17 17l-3.5-3.5`; Chevron `M7 8l3 3 3-3`. `Rail.tsx`:
```tsx
'use client'
const ICON: Record<RailId, (p: React.SVGProps<SVGSVGElement>) => React.JSX.Element> = { home: HomeIcon, people: PeopleIcon, settings: SettingsIcon, simulations: FlaskIcon, analytics: ChartIcon }
export function Rail(): React.JSX.Element {
  const pathname = usePathname(); const { mode, isDeveloper, toggle } = useMode(); const { theme, cycle } = useTheme()
  const current = railIdOf(pathname)
  const openId = workspaceIdOf(pathname) ?? useSearchParams().get('workspace')   // (call useSearchParams unconditionally above)
  const stream = useStreamState(openId ?? '')
  return (
    <nav data-testid="rail" aria-label="Main" className="group/rail relative z-20 h-full w-[56px]">
      <a data-testid="skip-link" href="#main" className="sr-only …">Skip to content</a>
      <div className="glass absolute inset-y-0 left-0 flex w-[56px] flex-col items-center gap-1 border-r border-line py-3 transition-[width] duration-[var(--dur-base)] ease-[var(--ease-out)] [@media(hover:hover)_and_(pointer:fine)]:group-hover/rail:w-[208px] [@media(hover:hover)_and_(pointer:fine)]:group-hover/rail:items-stretch">
        <Link href="/" aria-label="Slave of AI" className="mb-2 grid h-8 w-8 place-items-center self-center rounded-control bg-accent text-accent-ink font-semibold">S</Link>
        {railFor(mode).map((item) => { const Icon = ICON[item.id]; const on = current === item.id; return (
          <Link key={item.id} href={item.href} data-testid="rail-item" data-rail={item.id} title={item.label} aria-label={item.label} aria-current={on ? 'page' : undefined}
            className={`flex h-9 items-center gap-3 rounded-control px-2 mx-2 text-t2 hover:bg-hover hover:text-t1 ${on ? 'bg-sel text-t1 outline outline-1 outline-accent/50' : ''}`}>
            <Icon className="shrink-0" /><span className="hidden whitespace-nowrap text-[13px] group-hover/rail:[@media(hover:hover)_and_(pointer:fine)]:inline">{item.label}</span>
          </Link>) })}
        <div className="flex-1" />
        <span data-testid="sidebar-live" …>{/* the live chip exactly as SidebarTree drew it */}</span>
        <button data-testid="theme-toggle" …>{THEME_GLYPH[theme]}</button>
        <button type="button" role="switch" aria-checked={isDeveloper} data-testid="mode-toggle" aria-label="Developer mode" title={`Developer mode (${isDeveloper ? 'on' : 'off'}) · ⌘⇧D`} onClick={toggle}
          className="mx-2 flex h-9 items-center gap-3 rounded-control px-2 text-t2 hover:text-t1">
          <span className={`relative h-[16px] w-[28px] rounded-pill transition-colors duration-[var(--dur-fast)] ${isDeveloper ? 'bg-accent' : 'bg-line2'}`}><span className={`absolute top-[2px] h-[12px] w-[12px] rounded-pill bg-bg transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] ${isDeveloper ? 'translate-x-[14px]' : 'translate-x-[2px]'}`} /></span>
          <span className="hidden text-[12.5px] group-hover/rail:[@media(hover:hover)_and_(pointer:fine)]:inline">{MODE_LABEL[mode]}</span>
        </button>
      </div>
    </nav>
  )
}
```
(Move the live-chip markup and the theme pill out of `SidebarTree.tsx` verbatim; then delete `SidebarTree.tsx` and its test.)

- [ ] **Step 7: The switcher and the search in the header.** `ProjectSwitcher.tsx`: a `relative` wrapper, a trigger button (`project-switcher`, the current name or `Projects`, a `ChevronIcon`), a popover `<div role="menu" data-testid="project-switcher-menu" className="glass absolute left-0 top-full mt-1 w-[280px] rounded-surface border border-line p-1 shadow-resting">` listing rows as `<Link role="menuitem" data-testid="project-switcher-item" data-workspace data-status data-needs-you href={`/w/${id}`}>` with the dot (`LiveDot` arrives in Task 4 — until then a 6px span with `bg-tone-*`) and the amber count, and a last `<button data-testid="new-project">` that navigates to `/?new=1` (Task 8 turns it into the Sheet). Fetch: `GET /api/sidebar` on open and on route change, throttled by `SIDEBAR_REFETCH_MS = 10_000` moved here from `SidebarTree`. Dismissal through `useModalDismiss`. `HeaderSearch.tsx`: the `⌘K` field from `SidebarTree` (its markup and its jump behaviour verbatim), testid `search`. In `Header.tsx` the project crumb renders `<ProjectSwitcher …/>` instead of plain text (the `breadcrumb` testid and its text content stay: the trigger's text IS the crumb), `HeaderSearch` sits after the breadcrumb, and on project routes a `<Kbd>`-less `⌘J` hint text (`supervisor-hint`) sits before the split button. The header's outer div gains `glass border-b border-edge` in place of `border-line`. `layout.tsx`: `<ShellFrame sidebar={<Rail />} projects={projects}>`.

- [ ] **Step 8: Gate selector edits (no run).** In the five gates, replace per spec §3: `[data-testid="sidebar-project"]` → `[data-testid="project-switcher-item"]` (the switcher must be opened first: add a `await page.click('[data-testid="project-switcher"]')` before the read), `sidebar-section`/`data-section` → `project-tab`/`data-tab` with the six developer ids (`gate-m49` must set `localStorage.mode='developer'` in an `addInitScript` before the assertion), `sidebar-needs-you` → `project-switcher-item[data-needs-you]`, `sidebar-search` → `search`, `sidebar-tree` → `rail`. Leave every assertion's MEANING intact; note each edit in the task report by file and line.

- [ ] **Step 9: Green, tail, commit.** `npx vitest run apps/web` green; m26; tsc; typecheck; web:build. `git add` the files above (use `git add -A apps/web/src/components/shell apps/web/test` plus the explicit others) and `git commit -m "feat(web): fixed-viewport frame, icon rail, header project switcher, remembered Supervisor (M61 R4-R6, R14)"`.

---

### Task 4: Primitives — Sheet with motion, Stat, LiveDot, Kbd, and the rewrites

**Files:**
- Create: `apps/web/src/components/ui/Sheet.tsx`, `ui/motion.ts`, `ui/Stat.tsx`, `ui/LiveDot.tsx`, `ui/Kbd.tsx`
- Modify: `ui/Button.tsx`, `ui/Chip.tsx`, `ui/Segmented.tsx`, `ui/Card.tsx`, `ui/Panel.tsx`, `ui/DataTable.tsx`, `ui/SectionLabel.tsx`, `ui/StatusPill.tsx`, `apps/web/package.json` (+ `motion`), root `package-lock.json`
- Test: `apps/web/test/ui-components.test.tsx`, `ui-modals.test.tsx`, `segmented.test.tsx` (extend), `apps/web/test/sheet.test.tsx`, `stat.test.tsx` (new)

**Interfaces:**
- Produces: `Sheet({ open, onClose, title, testId, side?: 'right' | 'bottom', width?: string, instant?: boolean, children })`; `SPRING = { type: 'spring', bounce: 0, visualDuration: 0.35 }`, `EXIT = { type: 'spring', bounce: 0, visualDuration: 0.22 }`, `DISMISS_VELOCITY = 0.11` (px/ms), `DISMISS_TRAVEL = 0.4`; `Stat({ testId, label, value, note?, tone? })`; `LiveDot({ tone, pulse?: boolean, testId? })`; `Kbd({ children })`; `DataTable` gains `virtualized?: { rowHeight: number; count: number; render: (index) => ReactNode }`.

- [ ] **Step 1: Install motion.** `npm install motion@^12 --workspace apps/web` from the repo root; confirm `node -e "require('motion/react')"` resolves from `apps/web`.

- [ ] **Step 2: Failing tests.** `sheet.test.tsx` (jsdom; mock `motion/react`'s `useReducedMotion` to return `true` in one describe so the DOM is stable): renders `<Sheet open title="Hire" testId="hire-sheet" onClose={onClose}>body</Sheet>` — expects `role="dialog"`, `aria-modal="true"`, `data-testid="hire-sheet"`, `data-side="right"`, a `sheet-close` button, the title as the dialog's accessible name, `Escape` calls `onClose`, and focus lands inside on open and returns to the previously focused element on close; with `open={false}` nothing renders. `stat.test.tsx`: `<Stat testId="stat-spend" label="Spend" value="$4.20" note="of $20" />` renders label/value/note with the testid on the outer element. `ui-components.test.tsx` additions: `Button` has class `active:scale-[0.97]`; `LiveDot` sets `data-tone` and adds the pulse class only for `working|planning|review|waiting`; `Chip` with a `tone` renders a dot and no fill class. `segmented.test.tsx`: the active option has `aria-selected="true"` and the component renders `data-testid="<prefix>-<id>"` for each (unchanged), plus a `segmented-indicator` element.

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: `motion.ts` and `Sheet.tsx`.**
```ts
// ui/motion.ts -- the ONLY two files that import `motion` are this one and Sheet.tsx (spec R15).
export const SPRING = { type: 'spring', bounce: 0, visualDuration: 0.35 } as const
export const EXIT = { type: 'spring', bounce: 0, visualDuration: 0.22 } as const
export const DISMISS_VELOCITY = 0.11
export const DISMISS_TRAVEL = 0.4
```
```tsx
'use client'
import { AnimatePresence, motion, useReducedMotion, type PanInfo } from 'motion/react'
import { useEffect, useRef } from 'react'
import { useEscapeStack } from './useModalDismiss'
import { ScrollArea } from './ScrollArea'
import { DISMISS_TRAVEL, DISMISS_VELOCITY, EXIT, SPRING } from './motion'

export function Sheet({ open, onClose, title, testId, side = 'right', width = '440px', instant = false, children }: { … }): React.JSX.Element {
  const reduced = useReducedMotion() === true
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  useEscapeStack({ open, onEscape: onClose })
  useEffect(() => { if (!open) return; restoreRef.current = document.activeElement as HTMLElement | null; panelRef.current?.focus(); return () => restoreRef.current?.focus() }, [open])
  const axis = side === 'right' ? 'x' : 'y'
  const hidden = side === 'right' ? { transform: 'translateX(100%)' } : { transform: 'translateY(100%)' }
  const shown = { transform: side === 'right' ? 'translateX(0%)' : 'translateY(0%)' }
  const noMotion = reduced || instant
  const onDragEnd = (_e: unknown, info: PanInfo): void => {
    const size = axis === 'x' ? (panelRef.current?.offsetWidth ?? 1) : (panelRef.current?.offsetHeight ?? 1)
    const offset = axis === 'x' ? info.offset.x : info.offset.y
    const velocity = Math.abs(axis === 'x' ? info.velocity.x : info.velocity.y) / 1000
    if (offset > size * DISMISS_TRAVEL || (offset > 0 && velocity > DISMISS_VELOCITY)) onClose()
  }
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-40" data-testid={`${testId}-root`}>
          <motion.div className="absolute inset-0 bg-black/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={noMotion ? { duration: 0 } : { duration: 0.18 }} onClick={onClose} />
          <motion.div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} data-testid={testId} data-side={side}
            className={`glass absolute flex flex-col border-line shadow-resting focus:outline-none ${side === 'right' ? 'inset-y-0 right-0 border-l rounded-l-sheet' : 'inset-x-0 bottom-0 max-h-[85dvh] border-t rounded-t-sheet'}`}
            style={side === 'right' ? { width } : undefined}
            initial={noMotion ? { opacity: 0 } : hidden} animate={noMotion ? { opacity: 1 } : shown} exit={noMotion ? { opacity: 0 } : hidden}
            transition={noMotion ? { duration: reduced ? 0.15 : 0 } : SPRING}
            drag={noMotion ? false : axis} dragConstraints={axis === 'x' ? { left: 0, right: 0 } : { top: 0, bottom: 0 }} dragElastic={{ [axis === 'x' ? 'left' : 'top']: 0.05, [axis === 'x' ? 'right' : 'bottom']: 0.6 }} onDragEnd={onDragEnd}>
            <header className="flex h-[48px] items-center gap-3 border-b border-line px-4"><h2 className="type-title m-0 flex-1 truncate">{title}</h2><button type="button" data-testid="sheet-close" aria-label="Close" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-control text-t2 hover:bg-hover hover:text-t1">×</button></header>
            <ScrollArea testId={`${testId}-body`} className="p-4">{children}</ScrollArea>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
```
(`exit` uses `EXIT` — pass `transition={{ ...SPRING }}` for enter and set `exit`'s timing via the `transition` prop's `exit` key if the installed `motion` supports per-variant transitions; otherwise keep `SPRING` for both and note it in the report.)

- [ ] **Step 5: `Stat`, `LiveDot`, `Kbd`, and the rewrites.** `Stat`: `<div data-testid={testId} className="flex min-w-[110px] flex-col gap-0.5 rounded-surface border border-line bg-card px-3.5 py-2.5"><span className="type-label">{label}</span><span className={`type-heading ${tone ? TONE_TEXT[tone] : ''}`}>{value}</span>{note && <span className="type-meta text-t3">{note}</span>}</div>`. `LiveDot`: `<span data-testid={testId ?? 'live-dot'} data-tone={tone} className={`inline-block h-[6px] w-[6px] rounded-pill ${TONE_DOT[tone]} ${PULSE.has(tone) && pulse !== false ? 'motion-safe:animate-[status-pulse_1.5s_ease-in-out_infinite]' : ''}`} />` with `PULSE = new Set(['working','planning','review','waiting'])`. `Kbd`: `<kbd className="rounded-[4px] border border-line2 bg-panel px-1.5 font-mono text-[10.5px] text-t2">`. `Button`: base classes gain `rounded-control transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)] active:scale-[0.97]`; `primary` becomes `bg-accent text-accent-ink border-transparent hover:brightness-110`; `ghost` and `danger` keep their tone classes with `rounded-control`. `Chip`: `rounded-pill`; with a `tone`, render `<LiveDot tone pulse={false}/>` + text, no `TONE_FILL`. `Segmented`: keep the API; add an absolutely positioned `segmented-indicator` span sized/positioned from the active option's `offsetLeft/offsetWidth` (measured in a layout effect on `value`) with `transition-[transform,width] duration-[var(--dur-base)] ease-[var(--ease-in-out)]`; the labels sit above it. `Card`: `rounded-surface border border-line bg-card`, no shadow. `Panel`: a `floating?: boolean` prop → `glass rounded-sheet`; default `bg-panel rounded-surface`. `SectionLabel`: `SECTION_LABEL_CLASS = 'type-label'` (sentence case, no uppercase/mono; keep the export name). `StatusPill`: `LiveDot` + word, `rounded-pill`, no fill; keep testid `status-pill` and every `TONE_*` export. `DataTable`: add `virtualized` — when set, render the head as today and the body via `useVirtualizer({ count, getScrollElement: () => scrollRef.current, estimateSize: () => rowHeight })` inside a `ScrollArea` with a `ref`, painting `render(index)` at `translateY(virtualRow.start)`; `Row` unchanged.

- [ ] **Step 6: Green, tail, commit.** `npx vitest run apps/web` green (fix snapshot-free class assertions in existing tests that named the old classes: `rounded-card` → `rounded-control` etc.). m26; tsc; typecheck; web:build. `git add apps/web/package.json package-lock.json apps/web/src/components/ui apps/web/test/sheet.test.tsx apps/web/test/stat.test.tsx apps/web/test/ui-components.test.tsx apps/web/test/ui-modals.test.tsx apps/web/test/segmented.test.tsx` and `git commit -m "feat(web): Sheet over motion, Stat, LiveDot, Kbd; primitives rewritten on the M61 tokens (R15, R16)"`.

---

### Task 5: The Team read model and its route

**Files:**
- Create: `apps/web/src/server/teamLive.ts`, `apps/web/src/app/api/w/[workspaceId]/team/route.ts`
- Test: `apps/web/test/integration/team-live.test.ts`

**Interfaces:**
- Consumes: `buildOverviewSnapshot` (`server/overview.ts:413`), `buildOrganization` (`server/organization.ts:131`), `progressOf` (Task 2), `cardStateFor` (`lib/tones.ts:121`), `USER_CARD_LABEL` (`@slave-of-ai/domain`).
- Produces:
  ```ts
  export interface TeamLiveTechnical { readonly runId: string | null; readonly provider: ProviderKind | null; readonly startedAt: string | null; readonly toolCalls: number; readonly costUsd: number | null }
  export interface TeamLiveRow { readonly slaveId: string; readonly personId: string; readonly name: string; readonly role: string; readonly status: SlaveStatus; readonly state: CardState; readonly stateLabel: string; readonly doing: string; readonly doingTone: StatusTone; readonly progress: number | null; readonly taskId: string | null; readonly lifecycle: SlaveLifecycle; readonly released: { at: string; reason: string } | null; readonly why: string; readonly technical: TeamLiveTechnical }
  export interface TeamLiveSnapshot { readonly workspaceId: string; readonly rows: readonly TeamLiveRow[]; readonly stats: { readonly inProgress: number; readonly done: number; readonly goal: string | null }; readonly shellFacts: ShellFacts; readonly needs: OrganizationView['needs']; readonly preferences: OrganizationView['preferences']; readonly haltedReason: string | null }
  export async function buildTeamLive(workspaceId: string, now?: Date): Promise<TeamLiveSnapshot | null>
  // GET /api/w/:id/team → TeamLiveSnapshot | 404
  ```

- [ ] **Step 1: Failing integration test.** Use `apps/web/test/integration/projectFixture.ts` (read it: it seeds a workspace, team, slaves, tasks; reuse its helper and add a live `slaveRun` in `running` status for one slave with `costUsd: 0.42`, `toolCalls` per its column name, and a task in `running` assigned to that slave):
```ts
describe('buildTeamLive', () => {
  it('returns one row per seat with a sentence, never an enum member', async () => {
    const snap = await buildTeamLive(fx.workspaceId)
    expect(snap?.rows.map((r) => r.slaveId).sort()).toEqual([fx.slaveId1, fx.slaveId2].sort())
    for (const row of snap!.rows) expect(row.doing).not.toMatch(/^[a-z_]+$/)
  })
  it('says the live task title and moves the bar inside the running band', async () => {
    const row = (await buildTeamLive(fx.workspaceId))!.rows.find((r) => r.slaveId === fx.slaveId1)!
    expect(row.doing).toBe('Add the thing'); expect(row.progress).toBeGreaterThanOrEqual(35); expect(row.progress).toBeLessThanOrEqual(60)
    expect(row.technical.runId).toBe(fx.runId); expect(row.technical.costUsd).toBe(0.42)
  })
  it('says Idle with the next queued task for a seat with no run', async () => {
    const row = (await buildTeamLive(fx.workspaceId))!.rows.find((r) => r.slaveId === fx.slaveId2)!
    expect(row.doing).toMatch(/^Idle/); expect(row.progress).toBe(null); expect(row.technical.runId).toBe(null)
  })
  it('counts in-progress and done and carries the shell facts', async () => {
    const snap = (await buildTeamLive(fx.workspaceId))!
    expect(snap.stats.inProgress).toBe(1); expect(snap.shellFacts.workspace.id).toBe(fx.workspaceId)
  })
  it('404s through the route for an unknown workspace', async () => {
    const res = await GET(new Request('http://x'), { params: Promise.resolve({ workspaceId: 'nope' }) }); expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `teamLive.ts`.**
```ts
export async function buildTeamLive(workspaceId: string, now: Date = new Date()): Promise<TeamLiveSnapshot | null> {
  const [overview, organization] = await Promise.all([buildOverviewSnapshot(workspaceId), buildOrganization(workspaceId, now)])
  if (overview === null || organization === null) return null
  const orgBySeat = new Map(organization.rows.map((row) => [row.slaveId, row]))
  const queuedByRole = new Map<string, string>()   // first `ready`/`assigned` task title per required role, from overview.tasks if it carries them, else from a `prisma.task.findMany({ where: { workspaceId, status: { in: ['ready','assigned'] } }, select: { title: true, requiredRole: true }, orderBy: { createdAt: 'asc' } })` here
  const rows = overview.slaves.map((slave): TeamLiveRow => {
    const org = orgBySeat.get(slave.id)
    const state = cardStateFor(slave.status, slave.taskStatus, { … })   // exactly the facts SlaveCard passes today -- read SlaveCard.tsx:66-120 and copy its call
    const doing = doingSentence(slave, org, queuedByRole.get(slave.role) ?? null)
    return { slaveId: slave.id, personId: slave.personId, name: slave.name, role: slave.role, status: slave.status, state, stateLabel: USER_CARD_LABEL[state],
      doing: doing.text, doingTone: doing.tone, progress: progressOf(slave.taskStatus, slave.runId === null ? null : slave.progressPct), taskId: slave.taskId,
      lifecycle: slave.lifecycle, released: slave.released, why: org?.why ?? '',
      technical: { runId: slave.runId, provider: slave.provider, startedAt: slave.startedAt ?? null, toolCalls: slave.toolCalls, costUsd: slave.costUsd } }
  })
  return { workspaceId, rows, stats: { inProgress: overview.shellFacts.counts.tasksActive, done: overview.brief?.tasksDone ?? countDone(overview), goal: overview.shellFacts.status.goal }, shellFacts: overview.shellFacts, needs: organization.needs, preferences: organization.preferences, haltedReason: overview.shellFacts.status.haltedReason }
}
function doingSentence(slave: SlaveCardData, org: OrganizationRow | undefined, nextTitle: string | null): { text: string; tone: StatusTone } {
  if (slave.waitingFor !== null) return { text: slave.waitingFor.question === null ? `Waiting for ${slave.waitingFor.recipient}` : `Asked ${slave.waitingFor.recipient}: ${slave.waitingFor.question}`, tone: 'waiting' }
  if (slave.taskStatus === 'blocked') return { text: `Blocked on "${slave.taskTitle ?? 'a task'}" — needs you`, tone: 'blocked' }
  if (slave.runId !== null && slave.taskTitle !== null) return { text: slave.taskTitle, tone: toneForStatus(slave.status) }
  if (org?.doing) return { text: org.doing, tone: 'working' }
  if (slave.released !== null) return { text: `Released · ${slave.released.reason}`, tone: 'idle' }
  return { text: nextTitle === null ? 'Idle' : `Idle · next: ${nextTitle}`, tone: 'idle' }
}
```
Read `SlaveCardData` (`overview.ts:73-250`) and `OverviewSnapshot` (`:248-410`) for the exact field names (`startedAt` may be named differently — use what exists; `brief`'s done count is in `server/brief.ts`'s DTO which the snapshot embeds — use it, else `countDone` from the snapshot's task counts). Every sentence is English prose; no `status` member is ever `text`.

- [ ] **Step 4: The route** — `api/w/[workspaceId]/team/route.ts` copies `overview/route.ts` with `buildTeamLive`.

- [ ] **Step 5: Green, tail, commit.** `npx vitest run --project integration apps/web/test/integration/team-live.test.ts`; m26; tsc; typecheck; web:build. `git add apps/web/src/server/teamLive.ts "apps/web/src/app/api/w/[workspaceId]/team/route.ts" apps/web/test/integration/team-live.test.ts`; `git commit -m "feat(web): buildTeamLive read model and GET /api/w/:id/team (M61 R8)"`.

---

### Task 6: The command strip, the Team tab, and the Overview's dissolution

**Files:**
- Create: `apps/web/src/components/project/CommandStrip.tsx`, `NeedsYouBar.tsx`, `TeamLive.tsx`, `TeamCard.tsx`, `apps/web/src/hooks/useTeamLive.ts`
- Modify: `apps/web/src/app/w/[workspaceId]/layout.tsx`, `apps/web/src/app/w/[workspaceId]/page.tsx`, `apps/web/src/app/w/[workspaceId]/organization/page.tsx` (→ redirect), `apps/web/src/components/project/ProjectSettingsClient.tsx` (+ Runbook and Goal history sections), `apps/web/src/components/organization/OrganizationClient.tsx` (its Needs/preferences blocks become exported sub-components `OrganizationNeeds`, `OrganizationPreferences`), `apps/web/src/components/slaves/*` importers of `SlaveCard` (keep `SlaveCard` for the panel; it is no longer rendered on the page)
- Delete: `apps/web/src/components/OverviewClient.tsx`, `apps/web/src/components/project/ProjectBrief.tsx`, `apps/web/src/components/project/NeedsYouCard.tsx`, tests `overview-components.test.tsx`, `project-brief.test.tsx`, `needs-you-card.test.tsx`, `organization-page.test.tsx` (rewritten as `team-tab.test.tsx`)
- Test: `apps/web/test/command-strip.test.tsx`, `team-tab.test.tsx`, `project-layout.test.tsx` (extend), `apps/web/test/integration/routes.test.ts` (add the redirect)
- Gates (selector edits only): `gate-m45-project-experience.mjs` (`needs-you-card`→`needs-you`, `brief`/`strip`→`stat-*`), `gate-m57-ui-redesign.mjs` (same), `gate-m47-team-formation.mjs` (loads `/w/:id/organization` — follows the redirect; verify its selectors exist on the Team tab), `gate-m33-adopt.mjs`, `gate-m48-runbooks.mjs` (navigate to `/w/:id/settings` for `runbook-panel`), `gate-m14-fidelity.mjs` (`overview.png` rows)

**Interfaces:**
- Consumes: `TeamLiveSnapshot` and `GET /api/w/:id/team` (Task 5); `buildNeedsYou` + `NeedsYouItem`; `tabsFor`, `sectionOf` (Task 2); `useMode`; `Stat`, `LiveDot`, `AvatarTile`, `Card`, `ScrollArea` (Tasks 3–4); `useWorkspaceStream`; `useSelectedId`, `useRightPanel` (the `?slave=` → panel mirror effect exactly as `OverviewClient.tsx:216-260` does it — copy it).
- Produces: `CommandStrip({ workspaceId, needsYou: readonly NeedsYouItem[] })` (server component → client for the bar's live refetch via `useShellFacts` identity); `TeamLive({ workspaceId, initial: TeamLiveSnapshot, skillCatalogue, projects })`; `useTeamLive(workspaceId, initial)`; testids per spec §3.

- [ ] **Step 1: Failing tests.** `command-strip.test.tsx` (mock `next/navigation` pathname `/w/w1/tasks`, wrap in `ModeProvider`): four `project-tab`s in simple mode with `data-tab` `team,tasks,office,activity`, `aria-current="page"` on `tasks`, the Activity tab's `href` ending in `?view=digest`; after `mode-toggle`-equivalent (`setMode('developer')` via a probe) six tabs; `project-settings` links to `/w/w1/settings`; with two needs-you items, `needs-you` shows two `needs-you-row`s with `data-kind`, `href` and the text; with none, `needs-you` is absent; on `/w/w1/graph` in simple mode a fifth tab appears with `data-outside-mode="true"`. `team-tab.test.tsx`: renders `TeamLive` with a two-row snapshot: two `team-card`s with `data-slave`, `data-status`, `team-doing` text, `team-progress[data-progress="48"]` on the first, no `team-progress` bar fill when `progress` is null, `team-technical` absent in simple mode and present in developer mode with the run id; `stat-work` reads `1 in progress · 3 done`; clicking a card calls the `?slave=` setter (mock `useSelectedId`).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: `CommandStrip` + `NeedsYouBar`.** The layout renders `<CommandStrip workspaceId needsYou={await buildNeedsYou(workspaceId)} />` above `{children}` (`buildShellFacts` stays). `CommandStrip` is a client component: `useMode()`, `usePathname()`, `tabsFor(mode)` + the outside-mode current tab (`TABS.find(t => t.id === sectionOf(pathname) && !t.modes.includes(mode))`), rendered as `<nav data-testid="project-tabs" aria-label="Project">` of `<Link data-testid="project-tab" data-tab aria-current data-outside-mode>` inside a `Segmented`-styled pill row (use the `Segmented` component with `href`s — it already supports `href` per option), then `<Link data-testid="project-settings" href=… aria-label="Project settings"><SettingsIcon/></Link>`. `NeedsYouBar`: `<section data-testid="needs-you" className="rounded-surface border border-accent/35 bg-accent/10 px-3.5 py-2.5">` with one `<Link data-testid="needs-you-row" data-kind href>` per item (a `LiveDot tone="waiting"`, the title, the age from `since` via `lib/format.ts`'s relative helper, and a `Button variant="primary" size="sm"` reading `Open`); it re-fetches `GET /api/w/:id/overview`'s `needsYou`? No — add the list to `TeamLiveSnapshot`? Keep it simple and correct: `NeedsYouBar` receives `initial` and refetches `GET /api/w/${id}/needs-you` — create that route in this task (`api/w/[workspaceId]/needs-you/route.ts` → `buildNeedsYou`) — on `useShellFacts(workspaceId)` identity change, throttled 5 s like the switcher.

- [ ] **Step 4: `useTeamLive` + `TeamLive` + `TeamCard`.** `useTeamLive` wraps `useWorkspaceStream<TeamLiveSnapshot>({ workspaceId, endpoint: `/api/w/${workspaceId}/team`, initial, onSnapshot: (s) => publishShellFacts(workspaceId, s.shellFacts) })` and unpublishes on unmount (copy `OverviewClient.tsx:170-182`). `TeamLive`: `<section data-testid="team-live" className="flex min-h-0 flex-1 flex-col gap-[var(--gap-2)] p-[var(--gap-3)]">` → `<ScrollArea><div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-[var(--gap-2)]">{rows.map(<TeamCard/>)}</div>{mode==='developer' && <OrganizationPreferences …/>}<OrganizationNeeds …/></ScrollArea>` then a footer `<div className="flex gap-[var(--gap-2)]"><Stat testId="stat-goal" label="Goal" value={goal ?? 'No goal yet'} note={<GoalPanel-edit-link/>}/><Stat testId="stat-work" label="Work" value={`${inProgress} in progress`} note={`${done} done`}/><Stat testId="stat-spend" label="Spend" value={formatUsd(spentUsd)} note={budget === null ? 'no budget' : `of ${formatUsd(budget)}`}/></div>`. `TeamCard`: `<Card testId="team-card" data={{ 'data-slave': id, 'data-status': status, 'data-state': state }} onClick={() => onOpen(slaveId)}>` → header row `AvatarTile size="md"` + name (`type-title` at 14px weight 600) + role (`type-meta text-t2`) + in developer mode the provider label; `<p data-testid="team-doing" className="type-meta mt-2 flex items-center gap-2"><LiveDot tone={doingTone}/>{doing}</p>`; `<div data-testid="team-progress" data-progress={progress ?? ''} className="mt-2 h-[3px] rounded-pill bg-line">{progress !== null && <span style={{width:`${progress}%`}} className={`block h-full rounded-pill ${TONE_DOT[doingTone]} transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]`}/>}</div>`; developer: `<p data-testid="team-technical" className="mt-1.5 font-mono text-[10.5px] text-t3">run {runId?.slice(0,4) ?? '—'} · {providerLabel} · {toolCalls} tool calls · {costUsd === null ? 'cost unknown' : formatUsd(costUsd)}</p>`. The `?slave=` mirror effect and the `SlavePanel` in the right slot: copy `OverviewClient.tsx`'s block verbatim, feeding it the same `skillCatalogue`/`projects` the page already loads.

- [ ] **Step 5: Pages.** `page.tsx` (project root) loads `buildTeamLive`, `listSkillCatalogue`, `listProjectTeams` and renders `<TeamLive key={workspaceId} …/>`. `organization/page.tsx` becomes:
```ts
import { redirect } from 'next/navigation'
export default async function OrganizationRedirect({ params, searchParams }: { params: Promise<{ workspaceId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<never> {
  const { workspaceId } = await params
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(await searchParams)) { const first = typeof v === 'string' ? v : v?.[0]; if (first !== undefined) query.set(k, first) }
  const qs = query.toString()
  redirect(`/w/${workspaceId}${qs === '' ? '' : `?${qs}`}`)
}
```
`ProjectSettingsClient`: add a `Runbook` section rendering `<RunbookPanel workspaceId view={runbook}/>` (the project settings page loads `buildRunbookView` — see how `overview.ts` obtains `runbook` and call the same builder) and a `Goal history` section rendering `GoalHistory`. Delete `OverviewClient.tsx`, `ProjectBrief.tsx`, `NeedsYouCard.tsx` and their tests; move `LiveEventsPanel`/`MergeQueuePanel` (exported from `OverviewClient.tsx:37-118`) into `components/activity/OverviewPanels.tsx` for Task 7's raw river.

- [ ] **Step 6: Gate selector edits (no run)** per the Files block, each noted in the report.

- [ ] **Step 7: Green, tail, commit.** `npx vitest run apps/web`; the integration `routes.test.ts` gains: `GET /w/:id/organization?slave=x` → 307 with `location` `/w/:id?slave=x` (render the page function and catch Next's redirect error, as the existing redirect tests in that file do). m26; tsc; typecheck; web:build. Commit: `feat(web): project command strip and live Team tab replace the Overview; /organization redirects (M61 R7)`.

---

### Task 7: Work, Activity digest, Office frame

**Files:**
- Create: `apps/web/src/server/activityDigest.ts`, `apps/web/src/components/project/ActivityDigest.tsx`
- Modify: `apps/web/src/components/TasksClient.tsx:160-205` (frame), `apps/web/src/components/TaskCard.tsx` (details only in developer mode), `apps/web/src/app/w/[workspaceId]/activity/page.tsx` (`?view=digest`), `apps/web/src/components/activity/ActivityClient.tsx` (ScrollArea frame; the raw river gains the `OverviewPanels` under a `Recent changes` label in developer mode), `apps/web/src/components/office/OfficeHud.tsx`, `OfficeClient.tsx`, `FocusCard.tsx`
- Test: `apps/web/test/integration/activity-digest.test.ts`, `apps/web/test/activity-digest.test.tsx`, `tasks-components.test.tsx`, `task-card.test.tsx`, `office-client.test.tsx` (extend)

**Interfaces:**
- Consumes: `buildSupervisorThreads`' day-grouping (`server/supervisorThreads.ts:92`; export its `localDay` helper if private), `happeningSentence`, `HAPPENING_TYPES` (Task 2), `ScrollArea`, `Chip`, `Segmented`, `Button`, `Card`.
- Produces: `DigestItem { id, at, type, sentence, actorName: string | null, workspaceId }`, `DigestDay { id: string (YYYY-MM-DD), when: string, items: readonly DigestItem[] }`, `buildActivityDigest(workspaceId, now?, limit = 200): Promise<readonly DigestDay[] | null>`; `ActivityDigest({ workspaceId, days })`; testids `digest-day`, `digest-item`, `office-toolbar`.

- [ ] **Step 1: Failing tests.** Integration: seed (reuse `activity-history.test.ts`'s `seed`) then `appendEvent` five rows of the named families across two days (backdate one with the events helper's `at`/`ts` option the supervisor-threads test uses); expect two `DigestDay`s, newest first, items newest first, every `sentence` free of `/^[a-z_]+\.[a-z_]+$/`, the `task.completed` row's sentence containing the task title and the actor name. Component: `ActivityDigest` renders `digest-day` headers with `when` and `digest-item`s with `title={type}`. `task-card.test.tsx`: the details block (run kind/attempt/artifacts) renders only inside `ModeProvider` with `data-mode` developer. `office-client.test.tsx`: `office-toolbar` present, `office-hud-counts`, `office-tod`, `office-zoom-in/out`, `office-legend`, `office-live` still present inside it (they move, they do not vanish).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: `activityDigest.ts`.** One `prisma.event.findMany({ where: { workspaceId, type: { in: HAPPENING_TYPES.map(t => EVENT_TYPE_BY_DOMAIN_TYPE[t]) } }, orderBy: { seq: 'desc' }, take: limit })`, then resolve names: collect `slaveId`s and payload `taskId`s → `prisma.slave.findMany({ select: { id, person: { select: { name } } } })` and `prisma.task.findMany({ select: { id, title } })`; map each row through `happeningSentence(DOMAIN_EVENT_TYPE_BY_DB_VALUE[row.type], payload, { actor, taskTitle })`; group by `localDay(ts)` using the same function `supervisorThreads.ts` uses (export it); `when` is `today`/`yesterday`/the date exactly as `SupervisorThread.when` is computed (reuse).

- [ ] **Step 4: Activity page + digest view.** `activity/page.tsx` reads `searchParams.view`; when `'digest'`, renders `<ActivityDigest workspaceId days={await buildActivityDigest(workspaceId)}/>` (with `ShellFactsSeed` already in the layout); else the river. `ActivityDigest`: `<ScrollArea className="p-[var(--gap-3)]">` of `<section data-testid="digest-day">` (`<h3 className="type-label sticky top-0 glass py-1">{when}</h3>` + `<ul>` of `<li data-testid="digest-item" title={type} className="flex gap-3 py-2"><AvatarTile size="sm" name={actorName ?? 'S'} tone="idle"/><div><p className="type-body">{sentence}</p><time className="type-meta text-t3">{hh:mm}</time></div></li>`). In developer mode the digest tab still shows (bookmark), and the river page wraps `ActivityClient` in `ScrollArea` and appends `OverviewPanels` (live events + merge queue) at the bottom under `<SectionLabel>Recent changes</SectionLabel>` with testids `live-events`/`merge-row` unchanged.

- [ ] **Step 5: Work tab frame.** In `TasksClient`, replace the `PageShell flush` body with `<div className="flex min-h-0 flex-1 flex-col">{filters row unchanged}<ScrollArea axis="x" testId="board-scroll" className="px-[var(--gap-3)] pb-[var(--gap-3)]"><div className="grid h-full items-start gap-[var(--gap-2)] [grid-template-columns:repeat(5,minmax(220px,1fr))]">{columns, each column's card list inside <ScrollArea testId="column-scroll">}</div></ScrollArea></div>`; the List view wraps its `TaskList` in a `ScrollArea`. `TaskCard`: the details disclosure renders only when `useMode().isDeveloper` (keep the `task-details` testid).

- [ ] **Step 6: Office frame.** `OfficeHud` renders `<div data-testid="office-toolbar" className="glass flex h-[44px] items-center gap-[var(--gap-2)] rounded-surface border border-line px-3">` with: `<Chip testId="office-live" tone={live ? 'working' : 'idle'}>…</Chip>`, `<span data-testid="office-hud-counts" className="type-meta">…</span>`, the clock as `type-meta`, the time-of-day slider (`office-tod`, a native `<input type="range">` styled with `accent-color: var(--accent)`), a `Segmented`-free `Button variant="ghost" size="sm"` for `LIVE`, the legend as three `Chip`s (`office-legend` on the wrapper), and `office-zoom-out`/`office-zoom-in` as ghost buttons. The canvas keeps its black background inside a `rounded-surface overflow-hidden border border-line` wrapper; `FocusCard` becomes a `Card` positioned beside the canvas (right, 260 px) in the DOM, using `type-*` classes and `Button`s; no `font-mono` in any HUD element. The `OfficeClient` root is `flex min-h-0 flex-1 flex-col gap-[var(--gap-2)] p-[var(--gap-3)]` with the canvas region `min-h-0 flex-1`.

- [ ] **Step 7: Green, tail, commit.** Both projects' focused tests; m26; tsc; typecheck; web:build. Commit: `feat(web): Work tab scrolls inside; Activity digest view; Office in the product's frame (M61 R9, R10, R17)`.

---

### Task 8: Home — list beside a feed, and the intake in a Sheet

**Files:**
- Create: `apps/web/src/server/home.ts`, `apps/web/src/app/api/home/route.ts`, `apps/web/src/components/home/HomeClient.tsx`, `ProjectRowItem.tsx`, `HappeningFeed.tsx`, `apps/web/src/hooks/useHome.ts`
- Modify: `apps/web/src/app/page.tsx`, `apps/web/src/components/projects/NewProjectDrawer.tsx` (Drawer → Sheet), `apps/web/src/components/shell/ProjectSwitcher.tsx` (`new-project` row opens the Sheet through a `?new=1` push, which `HomeClient` reads — same idiom as today)
- Delete: `apps/web/src/components/ProjectsClient.tsx`, `apps/web/src/components/ProjectsPanel.tsx` (if only `ProjectsClient` imports it — grep first), tests `projects-page.test.tsx`, `projects-panel.test.tsx`
- Test: `apps/web/test/integration/home-snapshot.test.ts`, `apps/web/test/home.test.tsx`, `apps/web/test/useHome.test.tsx`
- Gates (selector edits only): `gate-m44`, `gate-m45`, `gate-m57`, `gate-m14`, `gate-m18` (`project-card` → `project-row`, `all-projects-analytics` now developer-only — set the mode in `addInitScript` where a gate asserts it)

**Interfaces:**
- Consumes: `listProjects`, `listCompanies` (`server/org.ts`), `buildSidebarTree`, `buildNeedsYou`, `buildAnalytics(null)`, `happeningSentence`, `HAPPENING_TYPES`, `Sheet`, `Stat`, `ScrollArea`, `useMode`.
- Produces:
  ```ts
  export interface HomeNeedsYouItem extends NeedsYouItem { readonly workspaceId: string; readonly workspaceName: string }
  export interface HappeningNowItem { readonly id: string; readonly at: string; readonly type: string; readonly workspaceId: string; readonly workspaceName: string; readonly actorName: string | null; readonly sentence: string }
  export interface HomeSnapshot { readonly projects: readonly ProjectRow[]; readonly needsYou: readonly HomeNeedsYouItem[]; readonly feed: readonly HappeningNowItem[]; readonly numbers: { peopleWorking: number; peopleIdle: number; spendUsd: number; unmeasured: boolean; finishedThisWeek: number }; readonly kpis: readonly Kpi[] }
  export const HOME_FEED_LIMIT = 40; export const HOME_POLL_MS = 10_000
  export async function buildHomeSnapshot(options?: { includeArchived?: boolean; now?: Date }): Promise<HomeSnapshot>
  // GET /api/home?archived=1 → HomeSnapshot
  ```

- [ ] **Step 1: Failing tests.** Integration: two workspaces via the fixture, one with a pending `SupervisorDecision` and a blocked task, five events across both; `buildHomeSnapshot()` → `needsYou` has two items both carrying the first workspace's name, sorted oldest first; `feed` has five items newest first with `workspaceName` and no bare type; `numbers.peopleWorking` equals the seats with a live run; `projects.length === 2`; `includeArchived: false` hides an archived third. Component `home.test.tsx`: renders `HomeClient` with a snapshot: `home-greeting` text contains `2 projects`; two `needs-you-row`s; two `project-row`s with `data-workspace`, `data-status`, `data-needs-you`; `home-feed` with `feed-item`s; `home-numbers` with `stat-people/stat-spend/stat-finished`; `all-projects-analytics` absent in simple, present in developer; `new-project` click renders a `sheet`. `useHome.test.tsx`: fake timers — a fetch mock is called again after `HOME_POLL_MS` while `document.visibilityState === 'visible'` and not while `'hidden'`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: `home.ts`.**
```ts
export async function buildHomeSnapshot(options: { readonly includeArchived?: boolean; readonly now?: Date } = {}): Promise<HomeSnapshot> {
  const now = options.now ?? new Date()
  const [projects, tree, analytics] = await Promise.all([listProjects({ includeArchived: options.includeArchived ?? false }), buildSidebarTree(), buildAnalytics(null)])
  const nameOf = new Map(projects.map((p) => [p.id, p.name]))
  const hot = tree.filter((row) => row.needsYouCount > 0 && nameOf.has(row.id))
  const queues = await Promise.all(hot.map(async (row) => (await buildNeedsYou(row.id, now)).map((item) => ({ ...item, workspaceId: row.id, workspaceName: row.name }))))
  const needsYou = queues.flat().sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
  const feed = await buildHappeningNow([...nameOf.keys()], nameOf, HOME_FEED_LIMIT)
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000)
  const [finishedThisWeek, liveSeats, seats] = await Promise.all([
    prisma.task.count({ where: { workspaceId: { in: [...nameOf.keys()] }, status: 'done', integratedAt: { gte: weekAgo } } }),
    prisma.slaveRun.findMany({ where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] }, slave: { team: { workspaceId: { in: [...nameOf.keys()] } } } }, select: { slaveId: true } }),
    prisma.slave.count({ where: { releasedAt: null, team: { workspaceId: { in: [...nameOf.keys()] } } } }),
  ])
  const peopleWorking = new Set(liveSeats.map((r) => r.slaveId)).size
  return { projects, needsYou, feed, numbers: { peopleWorking, peopleIdle: Math.max(0, seats - peopleWorking), spendUsd: projects.reduce((s, p) => s + p.spend, 0), unmeasured: projects.some((p) => p.unmeasuredRuns > 0), finishedThisWeek }, kpis: analytics.kpis }
}
```
`buildHappeningNow` is the same query `activityDigest.ts` makes without the workspace filter (`workspaceId: { in }`), with the same name/title resolution — extract the shared part into `server/happeningRows.ts` (`loadHappeningRows(where, take)`) and have both call it. Check the seat column for "released" against `schema.prisma` (`Slave.releasedAt`) and the `slaveRun` select against the schema before running.

- [ ] **Step 4: `HomeClient` and friends.** `useHome(initial, archived)` polls `/api/home` every `HOME_POLL_MS` while visible (`setInterval` + `visibilitychange` listener), 250 ms after mount skipped (the server render is fresh). `HomeClient`: `<div className="flex min-h-0 flex-1 flex-col gap-[var(--gap-2)] p-[var(--gap-3)]">` → `<header data-testid="home-greeting"><h1 className="type-display">{greeting()}</h1><p className="type-meta text-t2">{projects.length} projects · {peopleWorking} people working · {formatUsd(spendUsd)} spent</p></header>` (greeting by local hour: `Good morning/afternoon/evening`) → `needsYou.length > 0 && <section data-testid="home-needs-you" …amber…>` rows as Task 6's `needs-you-row` (same component, with a `workspaceName` chip) → `<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_300px] gap-[var(--gap-2)]"><ScrollArea testId="home-projects">{rows}</ScrollArea><HappeningFeed items/></div>` → `<div data-testid="home-numbers" className="flex gap-[var(--gap-2)]"><Stat testId="stat-people" …/><Stat testId="stat-spend" label="Spend" value=… note={unmeasured ? 'some runs unmeasured' : undefined} data-unmeasured/><Stat testId="stat-finished" label="Finished this week" value=… note="tasks"/></div>` → developer only: `<section data-testid="all-projects-analytics">` with the KPI tiles exactly as `ProjectsClient.tsx:332-340` drew them. `ProjectRowItem`: `<Link data-testid="project-row" data-workspace data-status data-needs-you href={`/w/${id}`} className="grid h-[var(--row-h)] grid-cols-[minmax(0,1fr)_150px_90px_80px] items-center gap-3 rounded-control px-2.5 hover:bg-hover">` — name + goal (`type-meta text-t2 truncate`), the status word + working count (`needsYou > 0` in accent), spend, `Math.round(done/total*100)%`, a trailing `⋯` (`project-menu`) opening a hand-rolled menu with `Assign company` (→ `AssignCompanyDialog`), `Archive`/`Restore` (the existing controls), `Settings`. `show-archived` checkbox and `?archived=1` round-trip stay. `HappeningFeed`: `<aside data-testid="home-feed" className="flex min-h-0 flex-col rounded-surface border border-line bg-panel p-3"><h2 className="type-label">Happening now</h2><ScrollArea>` of `<div data-testid="feed-item" title={type}>` (avatar, sentence, `workspaceName · relative time`). `NewProjectDrawer` → renders `<Sheet open onClose title="New project" testId="new-project-sheet">` around the same `IntakeConversation`; `HomeClient` reads `?new=1` to open it and `new-project` (header action, via `useHeaderAction`) pushes it.

- [ ] **Step 5: Gate selector edits (no run)**, noted in the report.

- [ ] **Step 6: Green, tail, commit.** Commit: `feat(web): Home is a project list beside a live feed; New project opens in a Sheet (M61 R11)`.

---

### Task 9: People, Settings, Login frames

**Files:**
- Modify: `apps/web/src/components/workforce/WorkforceClient.tsx`, `apps/web/src/components/persons/PeopleTable.tsx` (virtualised `DataTable`), `apps/web/src/components/SettingsClient.tsx`, `apps/web/src/components/project/ProjectSettingsClient.tsx`, `apps/web/src/app/settings/page.tsx` (`?section=`), `apps/web/src/app/w/[workspaceId]/settings/page.tsx`, `apps/web/src/components/LoginForm.tsx`, `apps/web/src/app/login/page.tsx`
- Create: `apps/web/src/components/ui/SettingsFrame.tsx`
- Test: `workforce-page.test.tsx`, `people-table.test.tsx`, `settings-page.test.tsx`, `project-settings.test.tsx`, `login-page.test.tsx` (extend), `settings-frame.test.tsx` (new)
- Gates (selector edits only): `gate-m11-shell.mjs`, `gate-m44`, `gate-m46`, `gate-m53`, `gate-m55`, `gate-m58` (Workforce segments exist only in developer mode → `addInitScript` sets developer where a gate clicks a segment; `slave-panel` inside `person-sheet`), `gate-m20-auth` (login card), `gate-m59-intake` (`settings-repos-root` under `?section=repositories`)

**Interfaces:**
- Consumes: `Sheet`, `DataTable.virtualized`, `ScrollArea`, `useMode`, `useUrlFilters`.
- Produces: `SettingsFrame({ sections: readonly { id: string; label: string }[], current, onSelect, children })` with `settings-nav`/`settings-nav-item[data-section][aria-current]`; testids `hire-from-catalogue`, `person-sheet`, `people-table`.

- [ ] **Step 1: Failing tests.** `workforce-page.test.tsx`: in simple mode with `initialTab: 'slaves'` no `workforce-segment-*` renders, `hire-from-catalogue` opens a `sheet` containing `catalog-*` testids; with `initialTab: 'catalog'` in simple mode the segments render with `data-outside-mode="true"`; in developer mode four segments as before; a row click (`useSelectedId('slave')` set) renders `person-sheet` with `slave-panel` inside. `people-table.test.tsx`: renders 500 rows inside a 400px-tall scroll element and asserts fewer than 60 `people-row`s in the DOM (virtualised). `settings-frame.test.tsx`: five `settings-nav-item`s, `aria-current` on the chosen, clicking calls `onSelect`. `settings-page.test.tsx`: `?section=appearance` shows the Appearance section only. `login-page.test.tsx`: the form is inside an element with class `rounded-sheet`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Workforce.** `WorkforceClient`: `const { isDeveloper } = useMode()`; `const outside = !isDeveloper && tab !== 'slaves'`; render the `Tabs` only when `isDeveloper || outside` (with `data-outside-mode` on the wrapper when `outside`); the primary header action is `Hire from catalogue` (`hire-from-catalogue`) in simple mode and `+ New slave` in developer mode; `hire` opens `<Sheet testId="hire-sheet" title="Hire from the catalogue" width="720px">` containing `<WorkforceCatalog …/>` with the same props the Catalog tab passes; the `slaves` tab's `PeopleTable` becomes virtualised (`virtualized={{ rowHeight: 40, count, render }}` — `--row-h` read as 40/34 via `getComputedStyle` once on mount); the person panel (`WorkforceClient.tsx:167-215`'s `panel` state) renders inside `<Sheet testId="person-sheet" title={person.name}>` instead of the fixed aside, with `onClose` clearing `?slave=`.

- [ ] **Step 4: Settings.** `SettingsFrame`: `<div className="grid min-h-0 flex-1 grid-cols-[180px_minmax(0,760px)] gap-[var(--gap-3)] p-[var(--gap-3)]"><nav data-testid="settings-nav">{buttons}</nav><ScrollArea>{children}</ScrollArea></div>`. Global sections `providers | appearance | repositories | security | danger`; project sections `goal | runbook | runtime | permissions | danger`; `?section=` via `useUrlFilters`-style push; each existing `<section data-testid="settings-…">` renders only when current (all remain mounted-on-demand; their testids unchanged). Login: `LoginForm` inside `<div className="glass mx-auto mt-[12dvh] w-[380px] rounded-sheet border border-line p-6">` with the mark above.

- [ ] **Step 5: Gate selector edits (no run)**, noted in the report.

- [ ] **Step 6: Green, tail, commit.** Commit: `feat(web): People with sheets and a virtual table; two-column Settings; login card (M61 R12, R13)`.

---

### Task 10: Developer-only pages re-framed

**Files:**
- Modify: `apps/web/src/components/graph/GraphClient.tsx`, `apps/web/src/components/AnalyticsClient.tsx`, `apps/web/src/components/sim/*Client.tsx` (the three sim pages), `apps/web/src/components/knowledge/KnowledgeClient.tsx` (virtualised rows), `apps/web/src/components/workforce/EvidenceTab.tsx`, `apps/web/src/components/SkillsClient.tsx`, `apps/web/src/components/ui/PageShell.tsx` (its body becomes `flex min-h-0 flex-1 flex-col`; `flush` keeps working)
- Test: `graph-page.test.tsx`, `analytics-page.test.tsx`, `simulations-page.test.tsx`, `simulation-page.test.tsx`, `compare-page.test.tsx`, `knowledge-page.test.tsx`, `evidence-tab.test.tsx`, `skills-page.test.tsx` (each gains one assertion: a `scroll-area` is present and no `font-mono` uppercase `SectionLabel` remains)

- [ ] **Step 1: Failing assertions** (one per test file, as above). **Step 2: Run — FAIL.**
- [ ] **Step 3: Re-frame each page:** wrap the scrolling body in `ScrollArea` (Graph: the canvas is already sized to its container — give the container `min-h-0 flex-1`; the `GraphDrawer` aside stays), replace `SectionLabel` usages that added their own `uppercase`/`font-mono` classes with the bare component, replace `rounded-page-card`/`rounded-panel-card` with `rounded-surface` where a `Card` would do, `Knowledge` rows through `DataTable.virtualized`. No read model, no client logic and no testid changes.
- [ ] **Step 4: Green, tail, commit.** Commit: `style(web): developer-only pages in the M61 frame (R19)`.

---

### Task 11: The gate, the reconciliation, the docs, the pictures

**Files:**
- Create: `scripts/gate-m61-simple-mode.mjs`, `docs/decisions/0007-two-modes.md`
- Modify: `package.json` (script after `gate:m59-intake`), `.github/workflows/ci.yml` (step after `gate:m59-intake`), `README.md` (roster sentence + count line → 35; the shell paragraph), `docs/ia.md` (spec §4), `docs/superpowers/specs/2026-09-19-m61-simple-mode-design.md` §7 (errata E1–E7 + any found), the ten gates (RUN them now), `scripts/gate-m14-fidelity.mjs` (`NUMBERS` rewritten for the new tokens and pages; run once → 13 PNGs)
- Test: `apps/web/test/integration/gate-surface-parity.test.ts` (extend with `TABS` ids ↔ the gate's `TAB_IDS`)

- [ ] **Step 1: Write the gate.** Copy `gate-m57-ui-redesign.mjs`'s imports, constants (renamed `M61 …`), `assert`, `findFreePort`, `preflightCleanup`, Stage 0 (preflight + fixture + the `finally` teardown) verbatim; add one `slaveRun` in `running` on the seeded slave (see `test/integration/projectFixture.ts` for the columns); `PASS_LINE = 'two modes, one frame that never scrolls, and nothing was removed'`. Then the eleven stages from spec §5, each as a labelled block that prints every measured value before asserting. Skeletons for the ones that are not straight ports:
```js
// Stage 1 -- no flash
const ctx1 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await ctx1.addInitScript(() => { localStorage.setItem('mode', 'developer'); window.__firstMode = null; new MutationObserver(() => { if (window.__firstMode === null) window.__firstMode = document.documentElement.dataset.mode ?? '' }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] }) })
const p1 = await ctx1.newPage(); await p1.goto(`${base}/`)
const firstMode = await p1.evaluate(() => window.__firstMode ?? document.documentElement.dataset.mode)
console.log(`stage 1: first data-mode observed = ${JSON.stringify(firstMode)}`); assert(firstMode === 'developer', 'developer mode flashed simple before hydration')
// Stage 2 -- fixed viewport
const ROUTES = [ '/', `/w/${workspaceId}`, `/w/${workspaceId}/tasks`, `/w/${workspaceId}/office`, `/w/${workspaceId}/activity`, `/w/${workspaceId}/activity?view=digest`, `/w/${workspaceId}/graph`, `/w/${workspaceId}/knowledge`, `/w/${workspaceId}/settings`, '/workforce', '/workforce?tab=catalog', '/settings', '/analytics', '/sim', `/sim/${simulationAId}`, '/sim/compare' ]
for (const mode of ['simple', 'developer']) for (const [w, h] of [[1440, 900], [1024, 680]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } }); await ctx.addInitScript((m) => localStorage.setItem('mode', m), mode)
  const pg = await ctx.newPage()
  for (const route of ROUTES) { await pg.goto(`${base}${route}`); await pg.waitForSelector('[data-testid="scroll-area"]')
    const m = await pg.evaluate(() => ({ sh: document.scrollingElement.scrollHeight, ch: document.scrollingElement.clientHeight, sw: document.scrollingElement.scrollWidth, cw: document.scrollingElement.clientWidth }))
    console.log(`stage 2: ${mode} ${w}x${h} ${route} scrollHeight=${m.sh} clientHeight=${m.ch}`); assert(m.sh === m.ch && m.sw === m.cw, `${route} grows past the viewport in ${mode} at ${w}x${h}`) }
  await ctx.close() }
// Stage 3 -- the switch
const accentBefore = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
const tabsBefore = await page.$$eval('[data-testid="project-tab"]', (els) => els.map((e) => e.dataset.tab))
await page.click('[data-testid="mode-toggle"]')
const accentAfter = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
const tabsAfter = await page.$$eval('[data-testid="project-tab"]', (els) => els.map((e) => e.dataset.tab))
console.log(`stage 3: accent ${accentBefore} -> ${accentAfter}; tabs ${tabsBefore} -> ${tabsAfter}`)
assert(accentBefore !== accentAfter, 'the palette did not change'); assert(tabsBefore.length === 4 && tabsAfter.length === 6, 'the tab set did not change')
await page.keyboard.press('Control+Shift+D'); assert((await page.$$('[data-testid="project-tab"]')).length === 4, 'Mod+Shift+D did not toggle back')
await page.reload(); assert((await page.getAttribute('html', 'data-mode')) === null, 'simple mode did not survive a reload')
```
Stages 4–11 follow spec §5 literally; stage 10 is `gate-m57`'s stage 10 with the route list extended by `?view=digest` and `?section=` values, run twice (one context per mode); stage 11 shells out to `npm run gate:m26-vocabulary` and runs the two `grep`s with `execFileSync`.

- [ ] **Step 2: Wire it.** `package.json`: `"gate:m61-simple-mode": "tsc --build && node --env-file=.env scripts/gate-m61-simple-mode.mjs"` after `gate:m59-intake`; `ci.yml`: `- run: npm run gate:m61-simple-mode` after `gate:m59-intake`; README roster sentence gains `gate:m61-simple-mode` and the count line reads `35 gates.`.

- [ ] **Step 3: Run the new gate and the ten reconciled gates, one at a time**, each as `DATABASE_URL="$GATE_DATABASE_URL" SLAVEOFAI_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" SLAVEOFAI_REQUIRE_FAKE_CLI=1 CHROMIUM_PATH=$HOME/.cache/ms-playwright/chromium-*/chrome-linux64/chrome npm run gate:<name> 2>&1 | tail -30; echo "exit ${PIPESTATUS[0]}"` with `pgrep -af "next dev"` empty first: `m61-simple-mode`, `m57-ui-redesign`, `m45-project-experience`, `m44-ux-foundation`, `m49-memory`, `m47-team-formation`, `m33-adopt`, `m48-runbooks`, `m11-shell`, `m46-workforce-catalog`, `m53-evidence`, `m55-catalog`, `m58-persons`, `m59-intake`, `m18-skill-and-teeth`, `m51-breaker`, `m20-auth`. Fix selectors until each exits 0; record every exit code in the report. (`m10-org`, `m17-stability`, `m8-plan` are pre-existing red and are not run.)

- [ ] **Step 4: Docs.** Rewrite `docs/ia.md`'s four sections per spec §4 and add the "Modes" rule; write `docs/decisions/0007-two-modes.md` in the ADR shape of `0006`; append the errata to the spec's §7; update README's shell paragraph. `npm run gate:m26-vocabulary`.

- [ ] **Step 5: Commit the gate, the reconciliation and the docs** (one commit): `feat(gate): gate:m61-simple-mode, ten gates reconciled to the M61 vocabulary, ia.md and ADR 0007`.

- [ ] **Step 6: The pictures, in a commit of their own.** Rewrite `gate-m14-fidelity.mjs`'s `NUMBERS` for the new pages (header 48, rail 56, panel 340, `--radius-control` 8 on a `Button`, `--radius-surface` 12 on a `team-card`, `--radius-sheet` 16 on a `sheet`, `--row-h` 40 on a `project-row`, body font 14 in simple and 13 in developer) and its page list (`overview.png` is now the Team tab; add `home.png` for `/`), run it once in simple mode dark (`addInitScript` sets `theme=dark`), and commit the 13 (+1) PNGs: `chore(fidelity): regenerate the M14 screenshots for M61`.

---

### Task 12: Final verification and the local merge

- [ ] **Step 1:** `pgrep -af "orchestrator|vitest|next dev"` empty. `npx tsc --build && npm run --silent typecheck`; `npx vitest run 2>&1 | tail -6` — at or above Task 1's baseline; the only failures allowed are the two pre-existing `subscribe` reconnect cases, re-run alone to confirm.
- [ ] **Step 2:** `pgrep -af "next dev"` empty → `npm run web:build`; `grep -rn "from 'motion" apps/web/src` lists exactly two files; `grep -rn "transition: all\|transition-all" apps/web/src` is empty; `git status` clean.
- [ ] **Step 3:** Update `.superpowers/sdd/progress.md` with the M61 ledger summary. Merge locally: `git checkout main && git merge --no-ff feature/m61-simple-mode -m "merge: M61 simple mode into main"` with the trailers; **do not push**. Restart the user's dev server: `rm -rf apps/web/.next && (set -a; . ./.env; set +a; nohup npm run web -- > /tmp/next-dev.log 2>&1 &)`.

---

## Self-review

- **Spec coverage.** R1–R3 → Task 1. R4–R6, R14 → Task 3. R7 → Task 6. R8 → Task 5 (+E2). R9, R10, R17 → Task 7. R11 → Task 8 (+E4). R12, R13 → Task 9. R15, R16 → Task 4. R18 → Task 2. R19 → Task 10. R20 → each task's gate-edit step + §3. R21 → Task 11. R22 → Task 11. §5 stages → Task 11 Step 1. §6 → nothing added. The `?view=digest` route → Task 7; the `/organization` redirect → Task 6; the remembered Supervisor and `⌘J` → Task 3; `appearance-mode-*` → Task 1; `office-toolbar` → Task 7; `needs-you` route (new, additive) → Task 6 — **spec R11/R7 name no such route; add erratum E8: `GET /api/w/:id/needs-you` is a third additive route, so the bar can refresh without the whole Team snapshot.**
- **Placeholders.** Every code step shows the code or names the exact file:line to copy from; the gate's stages 4–11 point at spec §5's literal assertions and the M57 port.
- **Type consistency.** `TabId`/`Section` (Task 2) are what `CommandStrip` (Task 6) and `breadcrumbOf` read; `TeamLiveSnapshot` (Task 5) is what `useTeamLive`/`TeamLive` (Task 6) consume; `HappeningNowItem`/`DigestItem` both carry `type` for `title`; `RightWidth` includes `'overlay'` in `AppShell.tsx` (E6) and `useRightWidth` returns it; `Sheet`'s `testId` prop is what every caller passes (`new-project-sheet`, `hire-sheet`, `person-sheet`).
