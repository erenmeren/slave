# M14: Design Fidelity — Nine Pages, One Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recreate every page of the design handoff's 3a shell pixel-close in the real app, with
every figure on every page coming from Postgres and the event log.

**Architecture:** Four series. **A** writes the anatomy once in `components/ui/` — a tone table,
`AvatarTile`, a rebuilt `StatusPill` and `AgentCard`, `Panel`/`SectionLabel` header actions, the
212px `Sidebar` and 52px `TopBar`, and the motion vocabulary in `globals.css` behind
`prefers-reduced-motion`. **B** adds the data the missing pages need: skill invocations counted
from the run stream, token usage from Claude's `result` line, a skill catalog synchronized from
the daemon's disk, and one analytics aggregation module. **C** rebuilds the nine pages, one task
each, consuming A and B and never re-implementing either. **D** is `gate-m14-fidelity.mjs`: nine
committed screenshots, the README's measurable values read back from `getComputedStyle`,
reduced-motion, behavior stages against fake CLIs, and real Skills/Analytics data.

**Tech Stack:** TypeScript, Next.js 15 App Router, React 19, Tailwind v4 (`@theme inline` tokens
in `apps/web/src/app/globals.css`), React Flow 11, Prisma/Postgres, vitest 3 (`jsdom` per-file
pragma), `playwright-core` 1.62 driving a system Chromium.

**Spec:** `docs/superpowers/specs/2026-08-29-m14-design-fidelity-design.md`

**Design reference (binding for numbers):** `design_handoff_ai_team_os/README.md` ("3a — The
nine-page shell", "Interactions & Behavior", "Design Tokens") and
`design_handoff_ai_team_os/mockups/AI Team OS Mockups.dc.html` (the 3a markup and its `Component`
class).

## Global Constraints

- **The README's numbers are requirements, and the gate reads them back from
  `getComputedStyle`.** Verbatim, with the property each is asserted on:
  - sidebar width **212** px · topbar height **52** px · graph drawer width **352** px ·
    Overview live-events panel width **340** px
  - agent card `border-radius` **8** px, `padding` **12px 13px**
  - `AvatarTile` **28**×**28** px
  - Agents table `grid-template-columns: 200px 130px 120px 1fr 110px 90px 80px`
  - Activity rule at **x = 88** px (`left: 88px`)
  - cable dash `stroke-dasharray: 5 11`, `stroke-dashoffset: -32`, **1.15s** linear infinite
  - pill `border-radius` **20** px
  - card sweep **2.2s** `cubic-bezier(.4,0,.2,1)` · dot pulse **1.5s** ease-in-out · new-row rise
    **0.3s** from `translateY(5px)`
- **Gate PASS line, verbatim:** `nine pages, one design`.
- **Unknown is `null`, shown as `—`.** Never `0`, never `$0.00`, never a guess. A sum over
  unknowns says how many were unknown (`sumSpend`'s `{ known, unknownRuns }` pair). For
  `AgentRun.skillCalls` and `AgentRun.tokensIn`/`tokensOut` the discriminator is the run's
  **provider**, never the stream's contents: a Cursor run writes `null` ("this runtime cannot
  report"), a Claude run that used no skill writes `{}` ("we watched, and there were none"). One
  helper, `runtimeReportsUsage(spawn)` in `apps/orchestrator/src/pump.ts`, holds that rule.
- **Anatomy is written once in `apps/web/src/components/ui/`.** A page that re-implements a card,
  pill, avatar tile or panel header is a defect.
- **One tone table: `CARD_STATE_TONE` in `apps/web/src/lib/tones.ts`.** It is the only place a
  tone, a label or a pulse is assigned. Anything else that needs a colour maps its own vocabulary
  onto a `CardState` and reads the tone back through it — `lib/taskColumns.ts`'s
  `COLUMN_STATE: Record<BoardColumn, CardState>` is the one such map, and it assigns no colours.
- **No placeholder data.** Every figure comes from the DB snapshot plus SSE. A page with no data
  shows `—` or an empty state. The single labelled exception is the Analytics caption
  `Last 7 days · seeded development data` on the seeded workspace.
- **Reduced motion disables all animation.** `globals.css` carries one
  `@media (prefers-reduced-motion: reduce)` block setting `animation-name: none !important`;
  the gate asserts no element reports any other `animation-name` under
  `page.emulateMedia({ reducedMotion: 'reduce' })`.
- **Screenshots are committed** under `docs/superpowers/fidelity/m14/` — one PNG per page,
  written by the gate.
- **No vendor spend, except ONE real Claude run** — Task 4's recording of a `Skill` `tool_use`
  line as a parser fixture. Everything else runs against `scripts/gate-fakes/` and the seeded
  database.
- **One vitest run at a time on this machine.** Never run suites in parallel; never `git push`
  while a suite runs (the pre-push hook runs the suite).
- **`npm run web:build` is part of every task's gate, with the dev server STOPPED** — `next build`
  and `next dev` share `apps/web/.next`, and tsc/vitest miss bundler-only breakage.
- **Stage named files only.** Never `git add -A`; the tree carries unrelated untracked paths.
- **`apps/web` never value-imports `@ai-team-os/providers`.** Its barrel imports
  `node:child_process` at module scope. Server code reaches `capabilitiesOf` / `PROVIDER_KINDS`
  through `@ai-team-os/control`'s re-exports; client components use
  `ProviderSelect.tsx`'s compiler-guarded mirror.
- **No task may modify a test file it does not name in its own `Files:` block.** Fixture
  widenings forced by a DTO change are listed per task.

## What jsdom can and cannot verify

`vitest.config.ts` loads no CSS (`test-setup/react-cleanup.ts` imports only
`@testing-library/react` and `vitest`; there is no `css: true`, no Tailwind pipeline). **A
`getComputedStyle` call in a component test therefore sees nothing that a class name produced.**
There are zero `getComputedStyle` calls anywhere under `apps/web` today, and this plan adds none.

| Fact | Verified in vitest by | Verified in the gate by |
|---|---|---|
| grid template `200px 130px …` | `el.style.gridTemplateColumns` (the component writes it inline) | `getComputedStyle(el).gridTemplateColumns` |
| Activity rule at x=88 | `el.style.left === '88px'` (inline) | `getComputedStyle(el).left` |
| cable `stroke-dasharray: 5 11` | `path.getAttribute('stroke-dasharray')` | `getComputedStyle(path).strokeDasharray` |
| progress width | `el.style.width` | — |
| sidebar 212, topbar 52, card radius 8, card padding 12/13, avatar 28, pill radius 20, drawer 352, events panel 340 | **class-string only** — `el.className` contains `w-[212px]` etc. | `getComputedStyle` — **the gate is the only real check** |
| sweep / pulse / dash / rise durations and easings | class-string only (`motion-safe:animate-[card-sweep_2.2s_cubic-bezier(.4,0,.2,1)_infinite]`) | `getComputedStyle(...).animationDuration` / `.animationTimingFunction` |
| reduced motion | not verifiable (no CSS) | `page.emulateMedia({ reducedMotion: 'reduce' })` + `animation-name` sweep |

Every task below states which of its numbers fall in which column.

---

## File Structure

New files this plan creates:

| File | Responsibility |
|---|---|
| `apps/web/src/lib/tones.ts` | `CardState`, the ten-state → tone/label/pulse table, three exhaustive derivations |
| `apps/web/src/lib/postControl.ts` | the one shared `postControl` / `errorMessage` pair for NEW call sites |
| `apps/web/src/components/ui/AvatarTile.tsx` | 28×28 radius-7 initials tile |
| `apps/web/src/components/ui/PanelHeader.tsx` | `SectionLabel` + optional right action (`all →`) |
| `apps/web/src/components/graph/CableEdge.tsx` | the README's three-path cable as a React Flow edge type |
| `apps/web/src/components/graph/GraphDrawer.tsx` | the 352px right drawer |
| `apps/web/src/components/SkillsClient.tsx` | the Skills page |
| `apps/web/src/components/AnalyticsClient.tsx` | the Analytics page |
| `apps/web/src/components/BarChart.tsx` | the 7-day stacked bar chart (no chart library) |
| `apps/web/src/components/PermissionMatrix.tsx` | the six-tool ✓/✕ grid |
| `apps/web/src/components/ProviderAdapterCards.tsx` | four adapter cards, two real, two disabled |
| `apps/web/src/components/DangerZone.tsx` | emergency stop + `reset demo data` |
| `apps/web/src/server/shell.ts` | `buildShellFacts` — the Sidebar's live counts and guardrails |
| `apps/web/src/server/analytics.ts` | 7-day series, six KPIs, per-agent performance |
| `apps/web/src/server/skills.ts` | `buildSkillsPage` — providers, skills, run counts, assignment |
| `apps/web/src/server/settings.ts` | `buildProviderAdapters`, `buildPermissionMatrix` |
| `apps/web/src/app/skills/page.tsx` | `/skills` |
| `apps/web/src/app/analytics/page.tsx` | `/analytics` |
| `apps/web/src/app/api/w/[workspaceId]/shell/route.ts` | `GET` → `ShellFacts` |
| `apps/web/src/app/api/skills/assign/route.ts` | `POST` / `DELETE` — assign / unassign |
| `apps/web/src/app/api/agents/[agentId]/permission/route.ts` | `PUT { tool, mode }` |
| `apps/web/src/app/api/dev/reseed/route.ts` | `POST` — `NODE_ENV !== 'production'` only |
| `packages/control/src/skills.ts` | `syncSkillCatalog`, `assignSkill`, `unassignSkill` |
| `packages/control/src/permission.ts` | `setAgentPermission` |
| `packages/providers/test/fixtures/claude/skill-tool-use.ndjson` | the one real Claude run |
| `packages/providers/test/fixtures/claude/README.md` | how it was recorded, and its redactions |
| `scripts/gate-m14-fidelity.mjs` | the milestone gate |
| `docs/superpowers/fidelity/m14/*.png` | nine committed screenshots (written by the gate) |

Three migrations, in this order:

| Migration | Column |
|---|---|
| `20260830090000_m14_run_skill_calls` | `AgentRun.skillCalls Json?` |
| `20260830091000_m14_run_tokens` | `AgentRun.tokensIn Int?`, `AgentRun.tokensOut Int?` |
| `20260830092000_m14_skill_missing_since` | `Skill.missingSince DateTime?` |

---

## Series A — The Anatomy

### Task 1: The tone table, `AvatarTile`, the rebuilt `StatusPill`, and the motion vocabulary

**Files:**
- Create: `apps/web/src/lib/tones.ts`
- Create: `apps/web/src/components/ui/AvatarTile.tsx`
- Modify: `apps/web/src/components/ui/StatusPill.tsx:83-95` (the `StatusPill` function; locate by
  symbol — line numbers in this plan go stale as earlier tasks land)
- Modify: `apps/web/src/app/globals.css` (append after the `status-pulse` keyframe at :125-133)
- Test: `apps/web/test/tones.test.ts` (create)
- Test: `apps/web/test/ui-components.test.tsx` (extend — this file already owns every `ui/`
  primitive assertion)

**Interfaces:**
- Consumes: `StatusTone`, `TONE_FILL`, `TONE_BORDER`, `TONE_TEXT`, `TONE_DOT` from
  `apps/web/src/components/ui/StatusPill.tsx`; `AgentStatus` from `@ai-team-os/domain`
  (`'idle' | 'starting' | 'working' | 'pausing' | 'paused' | 'resuming' | 'stopping'`);
  `RunStatus` (`'starting' | 'working' | 'pause_requested' | 'paused' | 'resuming' | 'stopping' |
  'stopped' | 'succeeded' | 'failed'`); `TaskStatus` (twelve members).
- Produces:

```typescript
// apps/web/src/lib/tones.ts
export type CardState =
  | 'working' | 'planning' | 'waiting' | 'review' | 'paused'
  | 'pause_requested' | 'resuming' | 'blocked' | 'idle' | 'completed'

export interface ToneSpec {
  readonly tone: StatusTone
  readonly label: string
  readonly pulse: boolean
}

export const CARD_STATE_TONE: Record<CardState, ToneSpec>
export function cardStateForRun(status: RunStatus | null): CardState
export function cardStateForAgent(status: AgentStatus): CardState
export function cardStateFor(agent: AgentStatus, task: TaskStatus | null): CardState
```

```typescript
// apps/web/src/components/ui/AvatarTile.tsx
export function initialsOf(name: string): string
export function AvatarTile({ name, tone }: { readonly name: string; readonly tone: StatusTone }): React.JSX.Element
```

```typescript
// apps/web/src/components/ui/StatusPill.tsx -- one new OPTIONAL prop
export function StatusPill({
  tone,
  label,
  pulse,
}: {
  readonly tone: StatusTone
  readonly label: string
  /** Overrides the tone's own in-flight default. `CARD_STATE_TONE` supplies it, because pulse is
   *  a fact about the STATE (`pause_requested` pulses, plain `waiting` does not) and the two
   *  share a tone. Omitted: the existing `IN_FLIGHT_TONES` default, so every M11/M12 call site
   *  keeps its current behaviour. */
  readonly pulse?: boolean
}): React.JSX.Element
```

New `globals.css` keyframes: `dash`, `card-sweep`, `rise`, `spin`. The mockup's `pulsedot` is this
repo's existing `status-pulse` and is NOT renamed.

**Where the ten states come from.** `design_handoff_ai_team_os/mockups/AI Team OS Mockups.dc.html`
lines 912-923 (`Component.meta`) is the binding table — colour, label and `pulse` per state,
copied below verbatim. The domain has no ten-member enum; `CardState` is that vocabulary, and the
three derivations below are how a `RunStatus`, an `AgentStatus`, or an agent-plus-task pair
reaches it.

- [ ] **Step 1: Write the failing tone-table test**

```typescript
// apps/web/test/tones.test.ts
import { describe, expect, it } from 'vitest'
import { CARD_STATE_TONE, cardStateFor, cardStateForAgent, cardStateForRun, type CardState } from '../src/lib/tones.js'
import type { AgentStatus, RunStatus, TaskStatus } from '@ai-team-os/domain'

// The mockup's own table (`AI Team OS Mockups.dc.html:912-923`), transcribed. Colour is checked
// through the tone name rather than the hex, because `globals.css` owns the hex and a tone is how
// this codebase names one.
const EXPECTED: Record<CardState, { tone: string; label: string; pulse: boolean }> = {
  working: { tone: 'working', label: 'WORKING', pulse: true },
  planning: { tone: 'planning', label: 'PLANNING', pulse: true },
  waiting: { tone: 'waiting', label: 'WAITING', pulse: false },
  review: { tone: 'review', label: 'REVIEW', pulse: true },
  paused: { tone: 'paused', label: 'PAUSED', pulse: false },
  pause_requested: { tone: 'waiting', label: 'PAUSING', pulse: true },
  resuming: { tone: 'working', label: 'RESUMING', pulse: true },
  blocked: { tone: 'blocked', label: 'BLOCKED', pulse: false },
  idle: { tone: 'idle', label: 'IDLE', pulse: false },
  completed: { tone: 'done', label: 'DONE', pulse: false },
}

describe('CARD_STATE_TONE', () => {
  it('carries the mockup table verbatim for all ten states', () => {
    expect(CARD_STATE_TONE).toEqual(EXPECTED)
  })

  it('pulses exactly the five in-flight states the spec names', () => {
    const pulsing = (Object.keys(CARD_STATE_TONE) as CardState[]).filter((s) => CARD_STATE_TONE[s].pulse).sort()
    expect(pulsing).toEqual(['pause_requested', 'planning', 'resuming', 'review', 'working'].sort())
  })
})

describe('cardStateForRun', () => {
  const cases: ReadonlyArray<readonly [RunStatus | null, CardState]> = [
    [null, 'idle'],
    ['starting', 'planning'],
    ['working', 'working'],
    ['pause_requested', 'pause_requested'],
    ['paused', 'paused'],
    ['resuming', 'resuming'],
    ['stopping', 'waiting'],
    ['stopped', 'idle'],
    ['succeeded', 'completed'],
    ['failed', 'blocked'],
  ]

  it.each(cases)('maps %s to %s', (status, expected) => {
    expect(cardStateForRun(status)).toBe(expected)
  })

  it('covers every RunStatus -- a tenth member would leave a hole here', () => {
    const covered = cases.map(([status]) => status).filter((s): s is RunStatus => s !== null)
    expect(new Set(covered).size).toBe(9)
  })
})

describe('cardStateForAgent', () => {
  const cases: ReadonlyArray<readonly [AgentStatus, CardState]> = [
    ['idle', 'idle'],
    ['starting', 'planning'],
    ['working', 'working'],
    ['pausing', 'pause_requested'],
    ['paused', 'paused'],
    ['resuming', 'resuming'],
    ['stopping', 'waiting'],
  ]

  it.each(cases)('maps %s to %s', (status, expected) => {
    expect(cardStateForAgent(status)).toBe(expected)
  })

  it('covers every AgentStatus', () => {
    expect(new Set(cases.map(([s]) => s)).size).toBe(7)
  })
})

describe('cardStateFor', () => {
  it("lets a blocked task override the agent's own idleness", () => {
    expect(cardStateFor('idle', 'blocked')).toBe('blocked')
  })

  it('reads a task under review or in the merge queue as review, whatever the agent is doing', () => {
    expect(cardStateFor('working', 'reviewing')).toBe('review')
    expect(cardStateFor('idle', 'merging')).toBe('review')
  })

  it('reads a done task with no live run as completed', () => {
    expect(cardStateFor('idle', 'done')).toBe('completed')
  })

  it('defers to the agent everywhere else', () => {
    expect(cardStateFor('working', 'running')).toBe('working')
    expect(cardStateFor('paused', 'running')).toBe('paused')
    expect(cardStateFor('idle', null)).toBe('idle')
  })

  it('covers every TaskStatus', () => {
    const all: readonly TaskStatus[] = [
      'backlog', 'ready', 'blocked', 'assigned', 'running',
      'verifying', 'reviewing', 'merging', 'rework', 'done', 'failed', 'cancelled',
    ]
    for (const task of all) expect(typeof cardStateFor('idle', task)).toBe('string')
    expect(all).toHaveLength(12)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/test/tones.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/tones.js"`.

- [ ] **Step 3: Write `lib/tones.ts`**

```typescript
// apps/web/src/lib/tones.ts
import type { AgentStatus, RunStatus, TaskStatus } from '@ai-team-os/domain'
import type { StatusTone } from '../components/ui/StatusPill'

/**
 * The handoff's ten card states (`design_handoff_ai_team_os/mockups/AI Team OS Mockups.dc.html`
 * lines 912-923, `Component.meta`). This is a DISPLAY vocabulary, not a domain one: the domain
 * has `RunStatus` (nine), `AgentStatus` (seven) and `TaskStatus` (twelve), and none of them is
 * this list. The three derivations below are the only sanctioned way into it -- a page that
 * hand-maps a status to a tone is the defect Decision 2 forbids.
 */
export type CardState =
  | 'working'
  | 'planning'
  | 'waiting'
  | 'review'
  | 'paused'
  | 'pause_requested'
  | 'resuming'
  | 'blocked'
  | 'idle'
  | 'completed'

export interface ToneSpec {
  readonly tone: StatusTone
  readonly label: string
  /**
   * Whether the pill's dot breathes. NOT derivable from `tone` alone, which is the whole reason
   * this field exists: `pause_requested` and `waiting` share the amber `waiting` tone, and only
   * the first pulses; `resuming` and `working` share teal, and both do.
   */
  readonly pulse: boolean
}

export const CARD_STATE_TONE: Record<CardState, ToneSpec> = {
  working: { tone: 'working', label: 'WORKING', pulse: true },
  planning: { tone: 'planning', label: 'PLANNING', pulse: true },
  waiting: { tone: 'waiting', label: 'WAITING', pulse: false },
  review: { tone: 'review', label: 'REVIEW', pulse: true },
  paused: { tone: 'paused', label: 'PAUSED', pulse: false },
  pause_requested: { tone: 'waiting', label: 'PAUSING', pulse: true },
  resuming: { tone: 'working', label: 'RESUMING', pulse: true },
  blocked: { tone: 'blocked', label: 'BLOCKED', pulse: false },
  idle: { tone: 'idle', label: 'IDLE', pulse: false },
  completed: { tone: 'done', label: 'DONE', pulse: false },
}

/** A run's own status. `null` means "no live run", which is `idle` -- the same statement
 *  `deriveAgentStatus(null)` makes. */
export function cardStateForRun(status: RunStatus | null): CardState {
  if (status === null) return 'idle'
  switch (status) {
    case 'starting':
      return 'planning'
    case 'working':
      return 'working'
    case 'pause_requested':
      return 'pause_requested'
    case 'paused':
      return 'paused'
    case 'resuming':
      return 'resuming'
    case 'stopping':
      return 'waiting'
    case 'stopped':
      return 'idle'
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'blocked'
  }
}

/** `deriveAgentStatus`'s output. Exhaustive over all seven members -- a new one is a build error
 *  here, not a silent fall-through to `idle` at render time. */
export function cardStateForAgent(status: AgentStatus): CardState {
  switch (status) {
    case 'idle':
      return 'idle'
    case 'starting':
      return 'planning'
    case 'working':
      return 'working'
    case 'pausing':
      return 'pause_requested'
    case 'paused':
      return 'paused'
    case 'resuming':
      return 'resuming'
    case 'stopping':
      return 'waiting'
  }
}

/**
 * The full card state: the agent's own status, with three task facts layered over it.
 *
 * `blocked`, `review` and `completed` are unreachable from `AgentStatus` alone -- an agent whose
 * task is blocked is simply `idle`, and `idle` is what the card would say without this. The three
 * overrides are exactly the states the handoff's card set has and the agent vocabulary does not.
 */
export function cardStateFor(agent: AgentStatus, task: TaskStatus | null): CardState {
  if (task !== null) {
    switch (task) {
      case 'blocked':
        return 'blocked'
      case 'reviewing':
      case 'merging':
        return 'review'
      case 'failed':
      case 'cancelled':
        return 'blocked'
      case 'done':
        // Only when nobody is still working on it: a `done` task whose agent is mid-run means the
        // agent has moved on and the snapshot has not caught up, and the AGENT is what this card
        // is about.
        if (agent === 'idle') return 'completed'
        break
      case 'backlog':
      case 'ready':
      case 'assigned':
      case 'running':
      case 'verifying':
      case 'rework':
        break
    }
  }
  return cardStateForAgent(agent)
}
```

- [ ] **Step 4: Run the tone test to green**

Run: `npx vitest run apps/web/test/tones.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Write the failing `AvatarTile` and `StatusPill` tests**

Append to `apps/web/test/ui-components.test.tsx`, after the existing `describe('StatusPill')`
block, and add `import { AvatarTile, initialsOf } from '../src/components/ui/AvatarTile.js'` to
the import list at the top:

```tsx
describe('initialsOf', () => {
  it('takes the first letters of the first two words', () => {
    expect(initialsOf('Checkout Platform')).toBe('CP')
    expect(initialsOf('atlas software co')).toBe('AS')
  })

  it('takes one letter from a single-word name', () => {
    expect(initialsOf('Alex')).toBe('A')
  })

  it('returns the unknown mark for an empty or whitespace-only name', () => {
    expect(initialsOf('')).toBe('—')
    expect(initialsOf('   ')).toBe('—')
  })
})

describe('AvatarTile', () => {
  it('renders the initials, the tone attribute, and the 28px/radius-7 recipe', () => {
    render(<AvatarTile name="Alex Turner" tone="working" />)
    const tile = screen.getByTestId('avatar-tile')
    expect(tile.textContent).toBe('AT')
    expect(tile.getAttribute('data-tone')).toBe('working')
    // Class-string assertions only -- jsdom loads no CSS here (see the plan's "What jsdom can and
    // cannot verify" table). `getComputedStyle(tile).width` would read `''`, not `28px`; the
    // milestone gate is what checks the rendered box.
    expect(tile.className).toContain('h-7')
    expect(tile.className).toContain('w-7')
    expect(tile.className).toContain('rounded-tile')
    expect(tile.className).toContain('text-[11px]')
  })

  it('carries the name for assistive tech rather than only two letters', () => {
    render(<AvatarTile name="Alex Turner" tone="idle" />)
    expect(screen.getByTestId('avatar-tile').getAttribute('title')).toBe('Alex Turner')
  })
})

describe('StatusPill pulse', () => {
  it('defaults to the tone in-flight rule when no pulse is given', () => {
    const { rerender } = render(<StatusPill tone="working" label="WORKING" />)
    expect(screen.getByTestId('status-pill').querySelector('span')?.className).toContain('animate-[status-pulse')

    rerender(<StatusPill tone="paused" label="PAUSED" />)
    expect(screen.getByTestId('status-pill').querySelector('span')?.className).not.toContain('animate-[status-pulse')
  })

  it('lets an explicit pulse override the tone default in both directions', () => {
    // `pause_requested` rides the `waiting` tone (which does not pulse by default) and MUST pulse.
    const { rerender } = render(<StatusPill tone="waiting" label="PAUSING" pulse />)
    expect(screen.getByTestId('status-pill').querySelector('span')?.className).toContain('animate-[status-pulse')

    rerender(<StatusPill tone="working" label="WORKING" pulse={false} />)
    expect(screen.getByTestId('status-pill').querySelector('span')?.className).not.toContain('animate-[status-pulse')
  })

  it('keeps the 20px pill radius class', () => {
    render(<StatusPill tone="idle" label="IDLE" />)
    expect(screen.getByTestId('status-pill').className).toContain('rounded-pill')
  })
})
```

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run apps/web/test/ui-components.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/components/ui/AvatarTile.js"`.

- [ ] **Step 7: Write `AvatarTile.tsx`**

```tsx
// apps/web/src/components/ui/AvatarTile.tsx
import { TONE_BORDER, TONE_FILL, TONE_TEXT, type StatusTone } from './StatusPill'

/**
 * The handoff's avatar initials (design README "1a — Control Room": "11px mono initials"), spec
 * §3: "first letters of the first two words of the name". The mockup itself used
 * `name.slice(0, 2)`, which renders `Ch` for "Checkout" -- the spec's rule is the one implemented,
 * because a two-word name is the common case here (workspaces and companies) and `CP` reads as an
 * abbreviation while `Ch` reads as a truncation.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word.length > 0)
  if (words.length === 0) return '—'
  return words
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('')
}

/**
 * 28×28, radius 7, status colour at `1a` alpha for the fill and `3d` for the border, 11px mono
 * initials (design README "1a"). `h-7`/`w-7` are Tailwind's 28px steps -- not arbitrary values --
 * and `rounded-tile` is `globals.css`'s `--radius-tile: 7px`.
 *
 * `title` carries the full name: two letters are not an accessible label, and this tile sits
 * beside the name in some layouts and replaces it in others (the Projects team row).
 */
export function AvatarTile({ name, tone }: { readonly name: string; readonly tone: StatusTone }): React.JSX.Element {
  return (
    <span
      data-testid="avatar-tile"
      data-tone={tone}
      title={name}
      className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-tile border font-mono text-[11px] font-semibold ${TONE_FILL[tone]} ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}
    >
      {initialsOf(name)}
    </span>
  )
}
```

- [ ] **Step 8: Give `StatusPill` its optional `pulse` prop**

Replace the `StatusPill` function in `apps/web/src/components/ui/StatusPill.tsx` (locate by
symbol) with:

```tsx
/** The `1a`-alpha fill / `3d`-alpha border pill (spec §3). Presentational only — callers own
 *  what `tone` means for their domain object. */
export function StatusPill({
  tone,
  label,
  pulse,
}: {
  readonly tone: StatusTone
  readonly label: string
  /**
   * Overrides the tone's own in-flight default. `lib/tones.ts`'s `CARD_STATE_TONE` supplies it,
   * because pulse is a fact about the STATE and two states can share one tone: `pause_requested`
   * ("PAUSING") rides the amber `waiting` tone and pulses, while plain `waiting` does not.
   * Omitted, the pre-M14 `IN_FLIGHT_TONES` rule applies unchanged, so every M11/M12 call site
   * (`RosterTable`, `WorkersTable`, `ProjectsClient`) keeps exactly the behaviour it has.
   */
  readonly pulse?: boolean
}): React.JSX.Element {
  const shouldPulse = pulse ?? IN_FLIGHT_TONES.has(tone)
  const pulseClass = shouldPulse ? 'motion-safe:animate-[status-pulse_1.5s_ease-in-out_infinite]' : ''
  return (
    <span
      data-testid="status-pill"
      data-tone={tone}
      className={`inline-flex items-center gap-1.5 rounded-pill border px-[7px] py-[3px] font-mono text-[9.5px] uppercase tracking-wide ${TONE_FILL[tone]} ${TONE_BORDER[tone]} ${TONE_TEXT[tone]}`}
    >
      <span aria-hidden className={`h-[5px] w-[5px] rounded-full ${TONE_DOT[tone]} ${pulseClass}`} />
      {label}
    </span>
  )
}
```

The padding moves from `px-2 py-0.5` to the README's exact `3px 7px`, the dot from `h-1.5 w-1.5`
(6px) to the README's `5px`, and the label from `text-[10px]` to `9.5px`. `rounded-pill` (20px)
is unchanged.

- [ ] **Step 9: Add the motion vocabulary to `globals.css`**

Append to `apps/web/src/app/globals.css`, immediately after the `status-pulse` keyframe block:

```css
/* ---- M14 motion vocabulary (design README "Interactions & Behavior" > Motion) ---------------
 * The mockup's `pulsedot` is this file's existing `status-pulse` above and is deliberately NOT
 * renamed -- every M11/M12 call site references it by that name. The four below are new.
 * Every consumer applies these through Tailwind's `motion-safe:` variant; the media block at the
 * bottom of this section is the belt-and-braces guarantee for anything that cannot (a literal
 * class on a React Flow-owned element, for instance). */

/* Cable dash travel: `stroke-dasharray: 5 11` animated to `stroke-dashoffset: -32` over 1.15s
 * linear infinite (design README "1b — Cables"). The dasharray itself is an ATTRIBUTE on the
 * path, not part of this keyframe -- only the offset moves. */
@keyframes dash {
  to {
    stroke-dashoffset: -32;
  }
}

/* The agent card's activity sweep: a 2.2s cubic-bezier(.4,0,.2,1) gradient across the top
 * hairline while a card is `working`. Named `card-sweep`, not `sweep`: `sweep` is already an
 * orchestrator concept (the guardrail sweep) and this file is read beside that vocabulary. */
@keyframes card-sweep {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

/* New-row entry: 0.3s from `translateY(5px)`. M11's deferred "new-row rise" lands here. */
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* A pending spinner. The handoff lists `spin` in its motion vocabulary; the only consumer today
 * is the Skills page's sync indicator. */
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Decision 8: under `prefers-reduced-motion: reduce` NOTHING animates. `animation-name` is what
 * the milestone gate reads back off every element, so it is what this sets -- the duration and
 * iteration count are belt-and-braces for a browser that resolves `animation-name` lazily.
 * `!important` because Tailwind's `motion-safe:` utilities and any literal `animation:` shorthand
 * both land at the same specificity. */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-name: none !important;
    animation-duration: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
  }
}
```

- [ ] **Step 10: Run the primitive tests to green**

Run: `npx vitest run apps/web/test/tones.test.ts apps/web/test/ui-components.test.tsx`
Expected: PASS.

- [ ] **Step 11: Run the whole web suite for the pill's changed geometry**

Run: `npx vitest run apps/web/test`
Expected: PASS. `StatusPill`'s class string changed (`px-[7px] py-[3px]`, `text-[9.5px]`); no
existing test asserts those classes — `agents-page.test.tsx`, `projects-page.test.tsx` and
`settings-page.test.tsx` assert only the pill's text and `data-tone`. If any fails on a class
string, fix the TEST only if it is one of those three files; otherwise stop and report.

- [ ] **Step 12: Run the full gate**

Stop any running `next dev` first (`build` and `dev` share `apps/web/.next`).

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add apps/web/src/lib/tones.ts apps/web/src/components/ui/AvatarTile.tsx apps/web/src/components/ui/StatusPill.tsx apps/web/src/app/globals.css apps/web/test/tones.test.ts apps/web/test/ui-components.test.tsx
git commit -m "feat(web): ten states, one tone table, and the motion vocabulary behind reduced-motion"
```

---
### Task 2: The rebuilt `AgentCard`, and `PanelHeader`'s right action

**Files:**
- Create: `apps/web/src/lib/postControl.ts`
- Create: `apps/web/src/components/ui/PanelHeader.tsx`
- Modify: `apps/web/src/components/AgentCard.tsx` (whole file — rewritten)
- Modify: `apps/web/src/components/ui/Panel.tsx` (accept an optional `action`)
- Modify: `apps/web/src/components/OverviewClient.tsx:65-69` (the card grid; locate by symbol
  `view.agents.map`)
- Modify: `apps/web/src/server/overview.ts` (`AgentCardData` gains `skill`, `taskId`, `taskStatus`,
  `progressPct`, `stepLabel`; locate by symbol `interface AgentCardData` and
  `buildOverviewSnapshot`)
- Test: `apps/web/test/overview-components.test.tsx` (extend — this file already owns every
  `AgentCard` assertion and the `AgentCardData` fixture factory)
- Test: `apps/web/test/integration/overview.test.ts` (assert the five new DTO fields)
- Test: `apps/web/test/useOverview.test.tsx` (fixture widening only — its literal
  `AgentCardData` must type-check)
- Test: `apps/web/test/ui-components.test.tsx` (the two `Panel` assertions move from
  `panel-title` to `section-label` — see Step 4)
  <!-- ERRATUM 2026-08-30 (final review, plan erratum): this line was MISSING from the Files
       block as written, while Step 4 below asserts "That file is named in this task's `Files:`
       block for exactly this." Added so the two agree; the work itself was done. -->

**Interfaces:**
- Consumes: `CARD_STATE_TONE`, `cardStateFor` from `apps/web/src/lib/tones.ts`; `AvatarTile` from
  `apps/web/src/components/ui/AvatarTile.tsx`; `StatusPill`'s `pulse` prop; `ProgressBar`,
  `Chip`, `Button`, `ShellOnlyMark`.
- Produces:

```typescript
// apps/web/src/lib/postControl.ts
export function errorMessage(data: unknown, status: number): string
export async function postControl(
  url: string,
  body?: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }>
```

```typescript
// apps/web/src/server/overview.ts -- AgentCardData gains five fields
  /** The live run's task id, so the card can render the mono `TASK-<8 chars>` reference. */
  readonly taskId: string | null
  /** The live run's task status, `null` with no task -- feeds `cardStateFor`. */
  readonly taskStatus: TaskStatus | null
  /** `toolCalls / maxToolCallsPerRun`, clamped to [0,100]; `0` with no live run. */
  readonly progressPct: number
  /** `"<toolCalls>/<maxToolCallsPerRun>"`, or `null` with no live run. */
  readonly stepLabel: string | null
  /** The `input.skill` of the live run's most recent `Skill` tool call, `null` when none. */
  readonly skill: string | null
```

```tsx
// apps/web/src/components/ui/Panel.tsx
export function Panel({
  title,
  action,
  children,
}: {
  readonly title?: string
  /** The optional right-hand action the handoff's panel headers carry (`all →`). */
  readonly action?: React.ReactNode
  readonly children: React.ReactNode
}): React.JSX.Element
```

```tsx
// apps/web/src/components/ui/PanelHeader.tsx
export function PanelHeader({
  title,
  action,
}: {
  readonly title: string
  readonly action?: React.ReactNode
}): React.JSX.Element
```

```tsx
// apps/web/src/components/AgentCard.tsx
export function AgentCard({
  agent,
  liveActionLine,
  workspaceId,
  onOpen,
}: {
  readonly agent: AgentCardData
  readonly liveActionLine: string | null
  /** Needed for the footer's control POSTs (`/api/w/:id/runs/:runId/{pause,resume,stop}`) --
   *  the SAME routes `AgentPanel` uses. No new endpoint. */
  readonly workspaceId: string
  readonly onOpen: (id: string) => void
}): React.JSX.Element

/** Kept exports (other files import them): `DOT`, `FLASH_COLOR`, `BORDER_FLASH_MS`. */
```

**Why `postControl` becomes a module now.** Three near-identical copies exist
(`AgentPanel.tsx`, `GoalCard.tsx`, `EmergencyStopButton.tsx`), each documented as a deliberate
local copy. This task adds a FOURTH call site, and a fourth copy is where the idiom stops being a
convention and starts being duplication. The module is added and used by `AgentCard` only; the
three existing copies are NOT rewritten — their files are not in this task's `Files:` block and
their tests are not this task's to touch.

**Numbers this task lands, and where each is checked.** Radius 8 (`rounded-card`), padding
`12px 13px` (`px-[13px] py-[12px]`), 3px progress bar with `0 0 8px` glow, the 2.2s sweep, hover
border `rgba(255,255,255,.2)` (`hover:border-white/20`) — all **class-string only** in vitest;
the gate reads `border-radius`, `padding`, `animation-duration` and `animation-timing-function`
back from `getComputedStyle`.

- [ ] **Step 1: Write the failing card test**

Append to `apps/web/test/overview-components.test.tsx`. Add to the existing `agent` factory the
five new fields (`taskId: null, taskStatus: null, progressPct: 0, stepLabel: null, skill: null`)
and add `workspaceId="w1"` to every existing `<AgentCard …>` render in the file. Then append:

```tsx
describe('AgentCard — the handoff anatomy', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders the header: avatar tile, name, role, status pill', () => {
    render(
      <AgentCard
        agent={agent({ name: 'Alex Turner', role: 'backend', status: 'working', taskStatus: 'running' })}
        liveActionLine={null}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('avatar-tile').textContent).toBe('AT')
    expect(screen.getByTestId('status-pill').textContent).toBe('WORKING')
    expect(screen.getByTestId('status-pill').getAttribute('data-tone')).toBe('working')
  })

  // The ten states, exhaustively — spec §3's "AgentCard renders all ten states in one it.each".
  const TEN: ReadonlyArray<readonly [AgentCardData['status'], TaskStatus | null, string, string]> = [
    ['working', 'running', 'WORKING', 'working'],
    ['starting', 'assigned', 'PLANNING', 'planning'],
    ['stopping', 'running', 'WAITING', 'waiting'],
    ['working', 'reviewing', 'REVIEW', 'review'],
    ['paused', 'running', 'PAUSED', 'paused'],
    ['pausing', 'running', 'PAUSING', 'waiting'],
    ['resuming', 'running', 'RESUMING', 'working'],
    ['idle', 'blocked', 'BLOCKED', 'blocked'],
    ['idle', null, 'IDLE', 'idle'],
    ['idle', 'done', 'DONE', 'done'],
  ]

  it.each(TEN)('renders %s + task %s as the %s pill in the %s tone', (status, taskStatus, label, tone) => {
    render(
      <AgentCard
        agent={agent({ status, taskStatus, taskTitle: 'Add the thing' })}
        liveActionLine={null}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    const pill = screen.getByTestId('status-pill')
    expect(pill.textContent).toBe(label)
    expect(pill.getAttribute('data-tone')).toBe(tone)
  })

  it('carries the handoff surface recipe: radius 8, padding 12/13, hover border', () => {
    render(<AgentCard agent={agent({})} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    const card = screen.getByTestId('agent-card')
    // Class strings, not computed style: jsdom loads no CSS in this suite. The gate reads
    // `border-radius: 8px` and `padding: 12px 13px` back off the real page.
    expect(card.className).toContain('rounded-card')
    expect(card.className).toContain('px-[13px]')
    expect(card.className).toContain('py-[12px]')
    expect(card.className).toContain('hover:border-white/20')
  })

  it('sweeps the top hairline only while working', () => {
    const { rerender } = render(
      <AgentCard agent={agent({ status: 'working', taskStatus: 'running' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />,
    )
    expect(screen.getByTestId('card-sweep').className).toContain('motion-safe:animate-[card-sweep_2.2s_cubic-bezier(.4,0,.2,1)_infinite]')

    rerender(<AgentCard agent={agent({ status: 'paused', taskStatus: 'running' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect(screen.queryByTestId('card-sweep')).toBeNull()
  })

  it('renders the task line as a mono reference plus an ellipsised title', () => {
    render(
      <AgentCard
        agent={agent({ taskId: '3f9a21c8-0000-4000-8000-000000000000', taskTitle: 'Implement Checkout API', taskStatus: 'running', status: 'working' })}
        liveActionLine={null}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('card-task-ref').textContent).toBe('TASK-3f9a21c8')
    expect(screen.getByTestId('card-task-title').className).toContain('truncate')
  })

  it('shows the step counter and percent from the run, and — with no run', () => {
    const { rerender } = render(
      <AgentCard agent={agent({ status: 'working', taskStatus: 'running', progressPct: 64, stepLabel: '7/11' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />,
    )
    expect(screen.getByTestId('card-step').textContent).toBe('7/11')
    expect(screen.getByTestId('card-percent').textContent).toBe('64%')
    expect(screen.getByTestId('progress-bar-fill').style.width).toBe('64%')

    rerender(<AgentCard agent={agent({ status: 'idle' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect(screen.getByTestId('card-step').textContent).toBe('—')
  })

  it('renders the three chips: skill, queue, provider — each with its own unknown mark', () => {
    const { rerender } = render(
      <AgentCard
        agent={agent({ skill: 'superpowers:test-driven-development', queuedMessage: 'rebase first', provider: 'cursor' })}
        liveActionLine={null}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    expect(screen.getByTestId('card-skill-chip').textContent).toBe('superpowers:test-driven-development')
    expect(screen.getByTestId('card-queue-chip').textContent).toBe('queued')
    expect(screen.getByTestId('provider-chip').textContent).toBe('cursor')

    rerender(<AgentCard agent={agent({ skill: null, queuedMessage: null, provider: null })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect(screen.getByTestId('card-skill-chip').textContent).toBe('—')
    expect(screen.getByTestId('card-queue-chip').textContent).toBe('—')
    expect(screen.getByTestId('provider-chip').textContent).toBe('—')
  })

  it('POSTs pause to the run route the panel already uses', async (): Promise<void> => {
    render(
      <AgentCard
        agent={agent({ status: 'working', taskStatus: 'running', runId: 'r1' })}
        liveActionLine={null}
        workspaceId="w1"
        onOpen={() => {}}
      />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-pause'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/pause', { method: 'POST' })
  })

  it('swaps pause for resume once the run is paused', async (): Promise<void> => {
    render(
      <AgentCard agent={agent({ status: 'paused', taskStatus: 'running', runId: 'r1' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />,
    )
    expect(screen.queryByTestId('card-pause')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-resume'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/resume', { method: 'POST' })
  })

  it('POSTs stop, and opens the panel for Message rather than inventing a second textarea', async (): Promise<void> => {
    const onOpen = vi.fn()
    render(
      <AgentCard agent={agent({ status: 'working', taskStatus: 'running', runId: 'r1' })} liveActionLine={null} workspaceId="w1" onOpen={onOpen} />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-stop'))
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/w/w1/runs/r1/stop', { method: 'POST' })

    fireEvent.click(screen.getByTestId('card-message'))
    expect(onOpen).toHaveBeenCalledWith('a1')
  })

  it('disables every footer control when there is no run to control', () => {
    render(<AgentCard agent={agent({ status: 'idle', runId: null })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />)
    expect((screen.getByTestId('card-pause') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('card-stop') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a refusal verbatim without touching the snapshot', async (): Promise<void> => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ error: 'the run is still stopping; retry in a moment' }), { status: 409 }),
    )
    render(
      <AgentCard agent={agent({ status: 'paused', taskStatus: 'running', runId: 'r1' })} liveActionLine={null} workspaceId="w1" onOpen={() => {}} />,
    )
    await act(async () => {
      fireEvent.click(screen.getByTestId('card-resume'))
    })
    expect(screen.getByTestId('card-error').textContent).toBe('the run is still stopping; retry in a moment')
  })
})
```

Add to the file's imports: `import type { TaskStatus } from '@ai-team-os/domain'` and widen the
existing vitest import to `{ afterEach, beforeEach, describe, expect, it, vi }`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/test/overview-components.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="avatar-tile"]` on the first new
test, and type errors on the unknown `workspaceId` prop.

- [ ] **Step 3: Write `lib/postControl.ts`**

```typescript
// apps/web/src/lib/postControl.ts
/**
 * The one shared copy of the control-POST idiom, for NEW call sites (M14).
 *
 * Three older local copies exist -- `AgentPanel.tsx`, `GoalCard.tsx`,
 * `EmergencyStopButton.tsx` -- each documented as a deliberate small copy of the house pattern.
 * They are NOT rewritten here: their tests are not this task's to touch, and rewriting three
 * working components to import a function they already have is churn. What this module prevents
 * is a FOURTH copy.
 *
 * The contract every copy shares and this one keeps: a bare `fetch`, no state written from the
 * response beyond the error text, and the event-driven refetch loop owning truth.
 */
export function errorMessage(data: unknown, status: number): string {
  if (data !== null && typeof data === 'object') {
    const value = (data as { error?: unknown }).error
    if (typeof value === 'string') return value
  }
  return `request failed (${status})`
}

export async function postControl(
  url: string,
  body?: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response =
      body === undefined
        ? await fetch(url, { method: 'POST' })
        : await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (response.ok) return { ok: true }
    const data: unknown = await response.json().catch(() => null)
    return { ok: false, error: errorMessage(data, response.status) }
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
}
```

- [ ] **Step 4: Write `PanelHeader` and give `Panel` its action slot**

```tsx
// apps/web/src/components/ui/PanelHeader.tsx
import { SectionLabel } from './SectionLabel'

/**
 * The handoff's panel header (design README "Design Tokens" > Type: section labels 9px mono,
 * `letter-spacing: .09em`, uppercase) with the optional right action the 3a panels carry --
 * "all →" on Overview's live-events panel, for instance. `SectionLabel` is reused rather than
 * re-styled: it already IS the 9px/.09em recipe, and a second copy of it here is exactly the
 * duplication Decision 2 forbids.
 */
export function PanelHeader({
  title,
  action,
}: {
  readonly title: string
  readonly action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div data-testid="panel-header" className="flex items-baseline justify-between gap-2">
      <SectionLabel>{title}</SectionLabel>
      {action !== undefined && (
        <span data-testid="panel-header-action" className="font-mono text-[9.5px] text-text-3">
          {action}
        </span>
      )}
    </div>
  )
}
```

```tsx
// apps/web/src/components/ui/Panel.tsx -- whole file
import { PanelHeader } from './PanelHeader'

/** The handoff panel surface (spec §3): `bg-bg-1`, radius 9, resting shadow. */
export function Panel({
  title,
  action,
  children,
}: {
  readonly title?: string
  /** The optional right-hand action the handoff's panel headers carry ("all →"). Ignored when
   *  `title` is absent -- an action with nothing to sit beside is a floating link. */
  readonly action?: React.ReactNode
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <section data-testid="panel" className="flex flex-col gap-3 rounded-panel border border-line bg-bg-1 p-4 shadow-resting">
      {title !== undefined && <PanelHeader title={title} {...(action === undefined ? {} : { action })} />}
      {children}
    </section>
  )
}
```

`PanelHeader` renders `SectionLabel`, whose `data-testid` is `section-label`; the existing
`ui-components.test.tsx` assertion `screen.getByTestId('panel-title').textContent` therefore
breaks. `SectionLabel` keeps `data-testid="section-label"`, and `PanelHeader` adds
`data-testid="panel-title"` to nothing — instead, update the two `Panel` assertions in
`ui-components.test.tsx` to read `section-label`. That file is named in this task's `Files:`
block for exactly this.

- [ ] **Step 5: Widen `AgentCardData` and fill the five fields**

In `apps/web/src/server/overview.ts`, add to `interface AgentCardData` (after `taskTitle`):

```typescript
  /** The live run's task id — the card renders `TASK-<first 8 chars>` from it (the handoff's mono
   *  task reference). `null` with no live run or a task-less `planning` run (M8b). */
  readonly taskId: string | null
  /** The live run's task status, feeding `lib/tones.ts`'s `cardStateFor` so the card can reach
   *  `blocked`/`review`/`completed` — three states `AgentStatus` alone cannot express. */
  readonly taskStatus: TaskStatus | null
  /**
   * The run's progress as a percentage of the workspace's own tool-call ceiling
   * (`Workspace.maxToolCallsPerRun`, the limit `sweep.ts` enforces), clamped to [0,100]. `0` with
   * no live run: an absent run has made no progress, the same measured zero `toolCalls: 0` makes
   * beside it. NOT null-able: there is no "unknown progress" state — the ceiling is a column and
   * the count is a column.
   */
  readonly progressPct: number
  /** `"<toolCalls>/<maxToolCallsPerRun>"`, or `null` with no live run (rendered `—`). */
  readonly stepLabel: string | null
  /**
   * The skill this run most recently invoked — the `summary` of its latest `run.tool_call` event
   * whose payload `name` is `Skill`. `null` when the run has invoked none, or on a runtime whose
   * parser never sees a `Skill` tool (Cursor). A LIVE fact, distinct from `AgentRun.skillCalls`
   * (M14 §4.1), which is an end-of-run tally and does not exist while the run is in flight.
   */
  readonly skill: string | null
```

Add `import type { TaskStatus } from '@ai-team-os/domain'` to the existing domain import.

In `buildOverviewSnapshot`, beside the existing `lines` loop (locate by symbol
`const lines = new Map<string, string>()`), add a second per-live-run read:

```typescript
  // The card's skill chip: the latest `Skill` tool call on this run. One `findFirst` per LIVE run,
  // in the loop that already issues one — the same bound the action-line read accepted. Prisma's
  // JSON path filter keeps it a single indexed query rather than a scan-and-filter in Node.
  const skills = new Map<string, string>()
  for (const run of liveRunByAgent.values()) {
    const event = await prisma.executionEvent.findFirst({
      where: { runId: run.id, type: 'run_tool_call', payload: { path: ['name'], equals: 'Skill' } },
      orderBy: { seq: 'desc' },
    })
    if (event !== null) {
      const summary = (event.payload as { summary?: string }).summary
      if (typeof summary === 'string') skills.set(run.agentId, summary)
    }
  }
```

`buildOverviewSnapshot` needs the workspace's ceiling, which it already has: `workspace` is read
at the top of the function. In the `agents.map` callback, add:

```typescript
        taskId: run?.taskId ?? null,
        taskStatus: (run?.task?.status as TaskStatus | undefined) ?? null,
        progressPct:
          run === null || workspace.maxToolCallsPerRun <= 0
            ? 0
            : Math.min(100, Math.round((run.toolCalls / workspace.maxToolCallsPerRun) * 100)),
        stepLabel: run === null ? null : `${run.toolCalls}/${workspace.maxToolCallsPerRun}`,
        skill: skills.get(agent.id) ?? null,
```

- [ ] **Step 6: Rewrite `AgentCard.tsx`**

```tsx
// apps/web/src/components/AgentCard.tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { CARD_STATE_TONE, cardStateFor } from '../lib/tones'
import { postControl } from '../lib/postControl'
import type { AgentCardData } from '../server/overview'
import { ShellOnlyMark } from './ShellOnlyMark'
import { AvatarTile } from './ui/AvatarTile'
import { Chip } from './ui/Chip'
import { ProgressBar } from './ui/ProgressBar'
import { StatusPill } from './ui/StatusPill'

export const DOT: Record<AgentCardData['status'], string> = {
  working: 'bg-status-working',
  starting: 'bg-status-starting',
  resuming: 'bg-status-starting',
  pausing: 'bg-status-paused',
  paused: 'bg-status-paused',
  stopping: 'bg-status-stopping',
  idle: 'bg-status-idle',
}

/** The border-flash's `--flash-color` source per status (M5 spec §8) — no new colour tokens.
 *  Exported: `OrgNodes.tsx`'s `AgentNode` reuses this map. */
export const FLASH_COLOR: Record<AgentCardData['status'], string> = {
  working: 'var(--color-status-working)',
  starting: 'var(--color-status-starting)',
  resuming: 'var(--color-status-starting)',
  pausing: 'var(--color-status-paused)',
  paused: 'var(--color-status-paused)',
  stopping: 'var(--color-status-stopping)',
  idle: 'var(--color-status-idle)',
}

/** 800ms border-flash decay window. Reused verbatim by the graph's node/edge flashes. */
export const BORDER_FLASH_MS = 800

/** The handoff's mono task reference: `TASK-` plus the id's first 8 characters. The product has
 *  no short task key column; this is the shortest form that is still unambiguous on one board. */
function taskRef(taskId: string): string {
  return `TASK-${taskId.slice(0, 8)}`
}

type CardAction = 'pause' | 'resume' | 'stop'

/**
 * The design handoff's agent card (README "1a — Control Room"), rebuilt: 1px border in the status
 * colour at `3d` alpha, radius 8, bg `#0f1217`, padding 12px 13px. Header = `AvatarTile` + name +
 * role + `StatusPill`; task line = mono ref + ellipsised title; a 3px `ProgressBar` with the
 * tone's `0 0 8px` glow; a step/percent row; three chips (skill · queue · provider); a footer of
 * three ghost buttons.
 *
 * The footer POSTs to the SAME routes `AgentPanel` uses (`/api/w/:id/runs/:runId/{pause,resume,
 * stop}`) — no new endpoint, spec §3. `Message` opens the panel instead of POSTing, because the
 * message textarea and its `paused`-only writability rule already live there and a second copy of
 * that rule on the card is where the two would drift apart.
 *
 * This stays its own `<article>` rather than `<Card>`: `Card` renders a fixed
 * `data-testid="card"` with no `className`, `style` or `data-status` passthrough, and this card
 * needs all three (the border flash's `--flash-color`, the per-state border colour, and the
 * `data-status` the gate and `overview-components.test.tsx` both read).
 */
export function AgentCard({
  agent,
  liveActionLine,
  workspaceId,
  onOpen,
}: {
  readonly agent: AgentCardData
  readonly liveActionLine: string | null
  readonly workspaceId: string
  readonly onOpen: (id: string) => void
}): React.JSX.Element {
  const line = liveActionLine ?? agent.actionLine
  const state = cardStateFor(agent.status, agent.taskStatus)
  const { tone, label, pulse } = CARD_STATE_TONE[state]

  const [pending, setPending] = useState<ReadonlySet<CardAction>>(new Set())
  const [errorText, setErrorText] = useState<string | null>(null)

  // Border flash (M5 spec §8): only a CHANGE flashes — the ref holds the status this instance
  // last rendered, so the initial mount never flashes, and the timeout is cleared on
  // unmount/next-change so a rapid double-change leaves no stale timer.
  const previousStatus = useRef(agent.status)
  const [flashing, setFlashing] = useState(false)
  useEffect((): (() => void) | void => {
    if (previousStatus.current === agent.status) return
    previousStatus.current = agent.status
    setFlashing(true)
    const timer = setTimeout(() => setFlashing(false), BORDER_FLASH_MS)
    return () => clearTimeout(timer)
  }, [agent.status])

  const runId = agent.runId
  const canPause = runId !== null && (agent.status === 'starting' || agent.status === 'working' || agent.status === 'resuming')
  const canResume = runId !== null && agent.status === 'paused'
  const canStop = runId !== null && agent.status !== 'idle'
  const showResume = agent.status === 'paused' || agent.status === 'pausing'

  const run = async (action: CardAction): Promise<void> => {
    if (runId === null) return
    setPending((current) => new Set(current).add(action))
    setErrorText(null)
    const result = await postControl(`/api/w/${workspaceId}/runs/${runId}/${action}`)
    if (!result.ok) setErrorText(result.error)
    setPending((current) => {
      const next = new Set(current)
      next.delete(action)
      return next
    })
  }

  return (
    <article
      data-testid="agent-card"
      data-status={agent.status}
      data-card-state={state}
      className={`relative flex flex-col gap-[9px] overflow-hidden rounded-card border bg-bg-2 px-[13px] py-[12px] transition-colors hover:border-white/20 ${
        TONE_CARD_BORDER[tone]
      } ${flashing ? 'motion-safe:animate-[border-flash_800ms_ease-out]' : ''}`}
      style={flashing ? ({ '--flash-color': FLASH_COLOR[agent.status] } as React.CSSProperties) : undefined}
    >
      {/* The activity sweep (design README "Motion"): a 2.2s cubic-bezier(.4,0,.2,1) gradient
        * travelling the top hairline while the card is `working`. Rendered as its own absolutely
        * positioned 1px strip so the keyframe moves a transform (compositor-only) rather than a
        * background-position. Present ONLY in the `working` state — the handoff's own rule. */}
      {state === 'working' && (
        <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px overflow-hidden">
          <span
            data-testid="card-sweep"
            className="block h-full w-full bg-gradient-to-r from-transparent via-tone-working to-transparent motion-safe:animate-[card-sweep_2.2s_cubic-bezier(.4,0,.2,1)_infinite]"
          />
        </span>
      )}

      <div className="flex items-start gap-[9px]">
        <AvatarTile name={agent.name} tone={tone} />
        <button
          type="button"
          onClick={() => onOpen(agent.id)}
          aria-label={`Open ${agent.name}'s detail panel`}
          className="min-w-0 flex-1 text-left"
        >
          <span className="block truncate text-[13px] font-semibold text-text-1">{agent.name}</span>
          <span className="block truncate text-[10.5px] text-[#7c8697]">{agent.role}</span>
        </button>
        <StatusPill tone={tone} label={label} pulse={pulse} />
      </div>

      <div className="flex items-baseline gap-[7px]">
        <span data-testid="card-task-ref" className="shrink-0 font-mono text-[10px] text-text-3">
          {agent.taskId === null ? '—' : taskRef(agent.taskId)}
        </span>
        <span data-testid="card-task-title" className="min-w-0 truncate text-[11.5px] text-[#c8cfda]">
          {agent.taskTitle ?? 'no task'}
        </span>
      </div>

      <ProgressBar pct={agent.progressPct} tone={tone} />

      <div className="flex items-baseline justify-between font-mono text-[9.5px] text-text-3">
        <span data-testid="card-step">{agent.stepLabel ?? '—'}</span>
        <span data-testid="card-percent">{agent.progressPct}%</span>
      </div>

      <div data-testid="action-line" className="h-5 truncate font-mono text-xs text-text-2">
        {/* Cross-fade (M5 spec §8): a key tied to the text remounts the span on every change. */}
        <span key={line ?? 'idle'} className="motion-safe:animate-[action-line-in_120ms_ease-out]">
          {line}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-[5px]">
        <Chip>
          <span data-testid="card-skill-chip">{agent.skill ?? '—'}</span>
        </Chip>
        <Chip>
          {/* "queue" is this product's real queue: the instruction waiting for the next resume
            * (`AgentRun.queuedMessage`). The mockup's own chip meant a merge position, which this
            * card has no honest source for. */}
          <span data-testid="card-queue-chip">{agent.queuedMessage === null ? '—' : 'queued'}</span>
        </Chip>
        <Chip>
          <span data-testid="provider-chip">{agent.provider ?? '—'}</span>
        </Chip>
        <ShellOnlyMark gate={agent.gate} />
      </div>

      {errorText !== null && (
        <span role="alert" data-testid="card-error" className="text-[10.5px] text-status-danger">
          {errorText}
        </span>
      )}

      <footer className="flex gap-[5px] border-t border-white/[0.06] pt-[3px]">
        {showResume ? (
          <FooterButton testId="card-resume" disabled={!canResume || pending.has('resume')} onClick={() => void run('resume')}>
            Resume
          </FooterButton>
        ) : (
          <FooterButton testId="card-pause" disabled={!canPause || pending.has('pause')} onClick={() => void run('pause')}>
            Pause
          </FooterButton>
        )}
        <FooterButton testId="card-message" disabled={false} onClick={() => onOpen(agent.id)}>
          Message
        </FooterButton>
        <FooterButton testId="card-stop" disabled={!canStop || pending.has('stop')} onClick={() => void run('stop')}>
          Stop
        </FooterButton>
      </footer>
    </article>
  )
}

/** The card footer's ghost button. Not `ui/Button`: that component fixes
 *  `data-testid="button"` for every instance and this footer needs three distinguishable ones,
 *  and its `px-3 py-1.5` is wider than the handoff's three-up equal-thirds footer. Same ghost
 *  recipe (`border-line`, `hover:border-white/20`, `hover:text-text-1`), one size down. */
function FooterButton({
  testId,
  disabled,
  onClick,
  children,
}: {
  readonly testId: string
  readonly disabled: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="flex-1 rounded-chip border border-line py-[5px] text-center text-[10.5px] font-medium text-text-2 transition-colors hover:border-white/20 hover:text-text-1 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  )
}

/** The card's own border: the status colour at `3d` alpha (design README "1a"). Literal strings
 *  per tone, never interpolated — Tailwind v4 generates a utility only when it can find the class
 *  name as literal text (the rule `StatusPill.tsx`'s `TONE_FILL` documents). */
const TONE_CARD_BORDER: Record<string, string> = {
  working: 'border-tone-working/24',
  planning: 'border-tone-planning/24',
  review: 'border-tone-review/24',
  waiting: 'border-tone-waiting/24',
  blocked: 'border-tone-blocked/24',
  done: 'border-tone-done/24',
  paused: 'border-tone-paused/24',
  idle: 'border-tone-idle/24',
}
```

- [ ] **Step 7: Pass `workspaceId` from `OverviewClient`**

In `apps/web/src/components/OverviewClient.tsx`, in the `view.agents.map` callback:

```tsx
            <AgentCard
              key={agent.id}
              agent={agent}
              liveActionLine={actionLines[agent.id] ?? null}
              workspaceId={workspaceId}
              onOpen={selectAgent}
            />
```

- [ ] **Step 8: Widen the two other `AgentCardData` fixtures**

`apps/web/test/useOverview.test.tsx` carries a literal `AgentCardData` that must now type-check.
Add the five fields to it:

```typescript
  taskId: null, taskStatus: null, progressPct: 0, stepLabel: null, skill: null,
```

(`apps/web/test/agent-panel.test.tsx` also builds an `AgentCardData`; if `tsc` reports it, add
the same five fields there and add that file to this task's commit — it is a pure type widening
with no assertion change. Verify with `npm run typecheck` in step 10 before assuming.)

- [ ] **Step 9: Assert the five new DTO fields**

Append to `apps/web/test/integration/overview.test.ts`, inside the existing
`describe('buildOverviewSnapshot')`:

```typescript
  it('carries the live run task id, its status, and the progress the tool-call ceiling defines', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { maxToolCallsPerRun: 20 } })
    await prisma.agentRun.create({
      data: { agentId: fixture.agentId, taskId: fixture.taskId, status: 'working', toolCalls: 5, provider: 'claude_code' },
    })

    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)
    expect(snapshot?.agents[0]?.taskId).toBe(fixture.taskId)
    expect(snapshot?.agents[0]?.taskStatus).toBe('running')
    expect(snapshot?.agents[0]?.progressPct).toBe(25)
    expect(snapshot?.agents[0]?.stepLabel).toBe('5/20')
  })

  it('reports zero progress and no step label for an agent with no live run', async (): Promise<void> => {
    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)
    expect(snapshot?.agents[0]?.progressPct).toBe(0)
    expect(snapshot?.agents[0]?.stepLabel).toBeNull()
    expect(snapshot?.agents[0]?.taskId).toBeNull()
    expect(snapshot?.agents[0]?.taskStatus).toBeNull()
  })

  it("reports the live run's most recent Skill tool call, and null when it has invoked none", async (): Promise<void> => {
    const run = await prisma.agentRun.create({
      data: { agentId: fixture.agentId, taskId: fixture.taskId, status: 'working', provider: 'claude_code' },
    })
    await appendEvent({
      type: 'run.tool_call',
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      runId: run.id,
      actor: 'agent',
      payload: { name: 'Write', summary: 'Write a.txt' },
    })
    expect((await buildOverviewSnapshot(fixture.workspaceId))?.agents[0]?.skill).toBeNull()

    await appendEvent({
      type: 'run.tool_call',
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      runId: run.id,
      actor: 'agent',
      payload: { name: 'Skill', summary: 'Skill superpowers:writing-plans' },
    })
    expect((await buildOverviewSnapshot(fixture.workspaceId))?.agents[0]?.skill).toBe('Skill superpowers:writing-plans')
  })
```

> **ERRATUM 2026-08-30 (final review, spec erratum 1 / plan erratum 6): the paragraph below is
> DEAD.** The Task 8 NEEDS_CONTEXT ruling replaced the `Approval` table entirely with the
> `task_review_approved` `ExecutionEvent.seq` rule (`packages/domain/src/merge/queue.ts`'s
> `mergeQueueOrder`, shared with `apps/orchestrator/src/merge.ts`). No `Approval` row is written,
> no `"Approval"` was added to any TRUNCATE list, and the merge queue is not FIFO by
> `decidedAt`. Read the Task 8 ruling, not this. The same applies to every `Approval`/`decidedAt`
> reference in this task's reference code below.

`appendEvent` is already imported at the top of this file. The merge-queue test writes `Approval`
rows, which this file's `beforeEach` TRUNCATE does not currently name — add `"Approval"` to that
statement's table list, immediately after `"ExecutionEvent"`. That is the only edit this task makes
to the existing harness.

- [ ] **Step 10: Run the tests to green**

Run: `npx vitest run apps/web/test/overview-components.test.tsx apps/web/test/ui-components.test.tsx apps/web/test/useOverview.test.tsx apps/web/test/integration/overview.test.ts`
Expected: PASS.

- [ ] **Step 11: Run the full gate**

Stop `next dev` first.

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/web/src/lib/postControl.ts apps/web/src/lib/tones.ts apps/web/src/components/ui/PanelHeader.tsx apps/web/src/components/ui/Panel.tsx apps/web/src/components/AgentCard.tsx apps/web/src/components/OverviewClient.tsx apps/web/src/server/overview.ts apps/web/test/overview-components.test.tsx apps/web/test/ui-components.test.tsx apps/web/test/useOverview.test.tsx apps/web/test/integration/overview.test.ts
git commit -m "feat(web): the agent card is the handoff's card, all ten states and a wired footer"
```

---

### Task 3: The 212px `Sidebar` and the 52px `TopBar`

**Files:**
- Create: `apps/web/src/server/shell.ts`
- Create: `apps/web/src/app/api/w/[workspaceId]/shell/route.ts`
- Modify: `apps/web/src/hooks/useWorkspaceStream.ts` (add `latencyMs`; locate by symbol
  `WorkspaceStreamState` and `source.onmessage`)
- Modify: `apps/web/src/components/Sidebar.tsx` (whole file — rewritten)
- Modify: `apps/web/src/components/TopBar.tsx` (whole file — rewritten)
- Modify: `apps/web/src/components/OverviewClient.tsx`, `apps/web/src/components/TasksClient.tsx`,
  `apps/web/src/components/activity/ActivityClient.tsx`,
  `apps/web/src/components/graph/GraphClient.tsx` (each passes `latencyMs` to `TopBar`; locate by
  symbol `<TopBar`)
- Test: `apps/web/test/shell.test.tsx` (extend — this file already owns every `Sidebar`/`TopBar`
  assertion)
- Test: `apps/web/test/useWorkspaceStream.test.tsx` (extend — owns the hook's contract)
- Test: `apps/web/test/integration/shell-snapshot.test.ts` (create)

**Interfaces:**
- Consumes: `useWorkspaceStream` (extended below); `Workspace` guardrail columns
  `budgetUsd`, `maxConcurrentRuns`, `runTimeoutMs`, `maxAttempts`;
  `NON_TERMINAL_RUN_STATUSES`, `deriveAgentStatus`, `toRunState`.
- Produces:

```typescript
// apps/web/src/server/shell.ts
export interface ShellFacts {
  readonly workspace: { readonly id: string; readonly name: string }
  /** The two live counts the sidebar's nav rows carry (spec §3). */
  readonly counts: { readonly agentsWorking: number; readonly tasksActive: number }
  /** The workspace's guardrail columns, verbatim — the sidebar's bottom block. `budgetUsd` is
   *  `null` for an unbudgeted workspace and renders `—`. */
  readonly guardrails: {
    readonly budgetUsd: number | null
    readonly maxConcurrentRuns: number
    readonly runTimeoutMs: number
    readonly maxAttempts: number
  }
}

export async function buildShellFacts(workspaceId: string): Promise<ShellFacts | null>
```

```typescript
// apps/web/src/hooks/useWorkspaceStream.ts -- WorkspaceStreamState gains one field
  /**
   * Milliseconds between the server stamping an event (`ExecutionEvent.ts`) and this client
   * receiving the frame. `null` until the first data frame with a parseable `ts` arrives.
   *
   * NOT the heartbeat's round trip, and deliberately so: `server/sse.ts` writes its heartbeat as
   * an ID-ONLY frame (`id: <seq>\n\n`, no `data:`), which `EventSource` uses to advance
   * `lastEventId` and never surfaces as a `message` event — there is nothing in the browser to
   * time it against. An event's own arrival age measures the same path (append → LISTEN → SSE
   * write → browser) and is observable. Both clocks are the same machine (the product is
   * localhost-only), so skew is not a factor; clamped at 0 so a clock that ticks backwards shows
   * `0ms` rather than a negative age.
   */
  readonly latencyMs: number | null
```

```tsx
// apps/web/src/components/TopBar.tsx -- one new required prop
  /** `null` until the stream has delivered its first event; rendered `sse · —`. */
  readonly latencyMs: number | null
```

**Where the Sidebar's numbers come from.** The root layout mounts one `<Sidebar>` with no
per-route params (`app/layout.tsx:37`), so it cannot be handed a snapshot. `useProjectName`'s
module-level announce channel solves the NAME that way, but counts and guardrails change on every
tick and an announce channel would make the sidebar a mirror of whichever page last rendered. So
the sidebar fetches its own tiny snapshot and rides the same SSE stream every other live view
uses — `useWorkspaceStream<ShellFacts | null>({ initial: null })`. Before the first refetch every
figure reads `—`, which is the honest answer and the Global Constraints' own rule.

**Numbers this task lands, and where each is checked.** Sidebar `w-[212px]` and TopBar `h-[52px]`
are **class-string only** in vitest; the gate reads `width`/`height` from `getComputedStyle`. The
gradient hairline is a class string in both.

- [ ] **Step 1: Write the failing hook test**

Append to `apps/web/test/useWorkspaceStream.test.tsx`, following that file's existing
`FakeEventSource` idiom:

```tsx
  it('reports the age of each arriving event as the stream latency, clamped at zero', async (): Promise<void> => {
    const { result } = renderHook(() => useWorkspaceStream({ workspaceId: 'w1', endpoint: '/api/w/w1/overview', initial: { n: 0 } }))
    expect(result.current.latencyMs).toBeNull()

    const now = Date.now()
    vi.setSystemTime(now)
    await act(async () => {
      lastSource?.onmessage?.({ data: JSON.stringify({ seq: 1, type: 'run.tool_call', ts: new Date(now - 42).toISOString() }) })
    })
    expect(result.current.latencyMs).toBe(42)

    // A `ts` in the future (a clock that ticked backwards) reads 0, never a negative age.
    await act(async () => {
      lastSource?.onmessage?.({ data: JSON.stringify({ seq: 2, type: 'run.tool_call', ts: new Date(now + 5_000).toISOString() }) })
    })
    expect(result.current.latencyMs).toBe(0)
  })

  it('leaves the latency alone for a frame with no parseable ts', async (): Promise<void> => {
    const { result } = renderHook(() => useWorkspaceStream({ workspaceId: 'w1', endpoint: '/api/w/w1/overview', initial: { n: 0 } }))
    const now = Date.now()
    vi.setSystemTime(now)
    await act(async () => {
      lastSource?.onmessage?.({ data: JSON.stringify({ seq: 1, type: 'run.started', ts: new Date(now - 7).toISOString() }) })
    })
    expect(result.current.latencyMs).toBe(7)

    await act(async () => {
      lastSource?.onmessage?.({ data: JSON.stringify({ seq: 2, type: 'run.started', ts: 'not-a-date' }) })
    })
    expect(result.current.latencyMs).toBe(7)
  })
```

Match this file's existing `FakeEventSource` variable name (it may be `sources.at(-1)` rather than
`lastSource`) and its `vi.useFakeTimers()` setup; `vi.setSystemTime` requires fake timers, which
that file already installs for the debounce assertions.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/test/useWorkspaceStream.test.tsx`
Expected: FAIL — `expected undefined to be null` (the field does not exist).

- [ ] **Step 3: Add `latencyMs` to the hook**

In `apps/web/src/hooks/useWorkspaceStream.ts`, add the field to `WorkspaceStreamState` (docstring
above), add beside the other `useState` calls:

```typescript
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
```

and inside `source.onmessage`, immediately after the `event === null || typeof event !== 'object'`
guard and before `onEventRef.current?.(event)`:

```typescript
      // Stream latency (M14 §3): the age of this frame when it landed. See `latencyMs`'s docstring
      // for why the heartbeat cannot serve — it is an id-only frame and fires no `message` event.
      if (typeof event.ts === 'string') {
        const sentAt = Date.parse(event.ts)
        if (Number.isFinite(sentAt)) setLatencyMs(Math.max(0, Date.now() - sentAt))
      }
```

and return it:

```typescript
  return { snapshot, connection, error, latencyMs }
```

- [ ] **Step 4: Write the failing shell tests**

Append to `apps/web/test/shell.test.tsx`. Add
`import { ProjectNav } from '../src/components/Sidebar.js'` to the imports, and add a
`vi.stubGlobal('EventSource', FakeEventSource)` block following
`tasks-components.test.tsx`'s precedent (that file's `FakeEventSource` + `fetch` stub is the one
to copy).

```tsx
describe('the sidebar geometry and rows', () => {
  it('is 212px wide with a nine-row nav in the README order', () => {
    pathname = '/w/w1'
    render(<Sidebar workspaceId="w1" />)
    // Class string, not computed style: jsdom loads no CSS here. The gate reads `width: 212px`.
    expect(screen.getByRole('navigation', { name: 'Primary' }).className).toContain('w-[212px]')

    const labels = screen.getAllByTestId('nav-row').map((row) => row.getAttribute('data-nav'))
    expect(labels).toEqual(['Overview', 'Agents', 'Tasks', 'Graph', 'Activity', 'Projects', 'Skills', 'Analytics', 'Settings'])
  })

  it('renders Skills and Analytics as global links', () => {
    pathname = '/skills'
    render(<Sidebar />)
    expect(screen.getByRole('link', { name: 'Skills' }).getAttribute('href')).toBe('/skills')
    expect(screen.getByRole('link', { name: 'Skills' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Analytics' }).getAttribute('href')).toBe('/analytics')
  })

  it('drops the five workspace-scoped rows when the pathname carries no workspace', () => {
    pathname = '/settings'
    render(<Sidebar />)
    const labels = screen.getAllByTestId('nav-row').map((row) => row.getAttribute('data-nav'))
    expect(labels).toEqual(['Projects', 'Skills', 'Analytics', 'Settings'])
  })
})

describe('ProjectNav counts and guardrails', () => {
  it('shows the unknown mark for every figure before the first snapshot lands', () => {
    render(<ProjectNav workspaceId="w1" pathname="/w/w1" />)
    expect(screen.getByTestId('nav-badge-Tasks').textContent).toBe('—')
    expect(screen.getByTestId('nav-badge-Agents').textContent).toBe('—')
    expect(screen.getByTestId('guardrail-budget').textContent).toBe('—')
    expect(screen.getByTestId('guardrail-concurrency').textContent).toBe('—')
  })

  it('renders the counts and every guardrail once the snapshot arrives', async (): Promise<void> => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            workspace: { id: 'w1', name: 'Checkout' },
            counts: { agentsWorking: 3, tasksActive: 12 },
            guardrails: { budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
          }),
          { status: 200 },
        ),
    )
    render(<ProjectNav workspaceId="w1" pathname="/w/w1" />)
    await act(async () => {
      lastSource?.onopen?.()
      vi.advanceTimersByTime(REFETCH_DEBOUNCE_MS)
    })

    expect(screen.getByTestId('nav-badge-Tasks').textContent).toBe('12')
    expect(screen.getByTestId('nav-badge-Agents').textContent).toBe('3')
    expect(screen.getByTestId('guardrail-budget').textContent).toBe('$20.00')
    expect(screen.getByTestId('guardrail-concurrency').textContent).toBe('3')
    expect(screen.getByTestId('guardrail-timeout').textContent).toBe('30m')
    expect(screen.getByTestId('guardrail-attempts').textContent).toBe('3')
  })

  it('says an unbudgeted workspace is unbudgeted rather than showing a budget of zero', async (): Promise<void> => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            workspace: { id: 'w1', name: 'Checkout' },
            counts: { agentsWorking: 0, tasksActive: 0 },
            guardrails: { budgetUsd: null, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 },
          }),
          { status: 200 },
        ),
    )
    render(<ProjectNav workspaceId="w1" pathname="/w/w1" />)
    await act(async () => {
      lastSource?.onopen?.()
      vi.advanceTimersByTime(REFETCH_DEBOUNCE_MS)
    })
    expect(screen.getByTestId('guardrail-budget').textContent).toBe('—')
  })
})

describe('the top bar', () => {
  it('is 52px tall and carries the gradient hairline', () => {
    render(<TopBar workspaceId="w1" workspaceName="W" connection="connected" latencyMs={null} budget={null} halted={false} />)
    const header = screen.getByTestId('top-bar')
    expect(header.className).toContain('h-[52px]')
    expect(screen.getByTestId('top-bar-hairline')).toBeTruthy()
  })

  it('renders the latency chip as sse · <ms>, and sse · — before the first event', () => {
    const { rerender } = render(
      <TopBar workspaceId="w1" workspaceName="W" connection="connected" latencyMs={null} budget={null} halted={false} />,
    )
    expect(screen.getByTestId('connection').textContent).toBe('sse · —')

    rerender(<TopBar workspaceId="w1" workspaceName="W" connection="connected" latencyMs={42} budget={null} halted={false} />)
    expect(screen.getByTestId('connection').textContent).toBe('sse · 42ms')
  })

  it('says reconnecting instead of a stale latency while the stream is down', () => {
    render(<TopBar workspaceId="w1" workspaceName="W" connection="reconnecting" latencyMs={42} budget={null} halted={false} />)
    expect(screen.getByTestId('connection').textContent).toBe('reconnecting')
  })
})
```

The existing `it('reports the connection state it was given')` asserts
`textContent` contains `'reconnecting'`, which still passes. Every other existing `<TopBar …>`
render in this file needs `latencyMs={null}` added — a pure prop widening.

- [ ] **Step 5: Run them to verify they fail**

Run: `npx vitest run apps/web/test/shell.test.tsx`
Expected: FAIL — `Failed to resolve import` on `ProjectNav`, and the nav-row assertions fail
because `Sidebar` still renders M11's three-plus-four layout.

- [ ] **Step 6: Write `server/shell.ts`**

```typescript
// apps/web/src/server/shell.ts
import { prisma } from '@ai-team-os/db/client'
import { toRunState } from '@ai-team-os/db'
import { deriveAgentStatus, NON_TERMINAL_RUN_STATUSES } from '@ai-team-os/domain'

/**
 * The shell's own tiny snapshot (M14 §3): the two live counts the sidebar's nav rows carry, and
 * the workspace's guardrail columns for the bottom block.
 *
 * Its own module and its own route rather than a slice of `OverviewSnapshot`, because the sidebar
 * is mounted by the ROOT LAYOUT on every page — including `/w/:id/tasks`, `/graph` and
 * `/activity`, none of which builds an overview snapshot. Reading the overview's much larger
 * snapshot from four routes to display two integers is the cost this avoids.
 */
export interface ShellFacts {
  readonly workspace: { readonly id: string; readonly name: string }
  readonly counts: {
    /** Agents whose derived status is `working` — the handoff's "agents working" badge. */
    readonly agentsWorking: number
    /** Tasks in the six statuses `overview.ts` counts as active work. */
    readonly tasksActive: number
  }
  readonly guardrails: {
    /** `null` for an unbudgeted workspace (M12 Task 9) — rendered `—`, never `$0.00`. */
    readonly budgetUsd: number | null
    readonly maxConcurrentRuns: number
    readonly runTimeoutMs: number
    readonly maxAttempts: number
  }
}

// Mirrors `overview.ts`'s own list (the M8a widening: a task under review or in the merge queue
// is still active work). Not imported — `overview.ts` does not export it, and this module's whole
// point is not to depend on that one.
const ACTIVE_TASK_STATUSES = ['ready', 'running', 'verifying', 'reviewing', 'merging', 'rework'] as const

export async function buildShellFacts(workspaceId: string): Promise<ShellFacts | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } })
  if (workspace === null) return null

  const [runs, tasksActive] = await Promise.all([
    prisma.agentRun.findMany({
      where: { agent: { team: { workspaceId } }, status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
      select: { status: true, toolCalls: true, sessionId: true, pausedAtStep: true },
    }),
    prisma.task.count({ where: { workspaceId, status: { in: [...ACTIVE_TASK_STATUSES] } } }),
  ])

  // `deriveAgentStatus` rather than a `status === 'working'` filter on the row: the domain owns
  // that mapping, and this badge must agree with the pill on every card that shows the same agent.
  const agentsWorking = runs.filter((run) => deriveAgentStatus(toRunState(run)) === 'working').length

  return {
    workspace: { id: workspace.id, name: workspace.name },
    counts: { agentsWorking, tasksActive },
    guardrails: {
      budgetUsd: workspace.budgetUsd,
      maxConcurrentRuns: workspace.maxConcurrentRuns,
      runTimeoutMs: workspace.runTimeoutMs,
      maxAttempts: workspace.maxAttempts,
    },
  }
}
```

- [ ] **Step 7: Write the route**

```typescript
// apps/web/src/app/api/w/[workspaceId]/shell/route.ts
import { buildShellFacts } from '../../../../../server/shell'

// Reads the live database on every hit; a cached snapshot is a lie about a live system.
export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<Response> {
  const { workspaceId } = await context.params
  const facts = await buildShellFacts(workspaceId)
  if (facts === null) return new Response(`no workspace with id ${workspaceId}`, { status: 404 })
  return Response.json(facts)
}
```

- [ ] **Step 8: Rewrite `Sidebar.tsx`**

```tsx
// apps/web/src/components/Sidebar.tsx
'use client'

import type React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useProjectName } from '../hooks/useProjectName'
import { useWorkspaceStream } from '../hooks/useWorkspaceStream'
import type { ShellFacts } from '../server/shell'

/** The nine rows of the handoff's 3a shell, in its own order (design README §3a). Five are
 *  workspace-scoped and render only on a `/w/:id/...` route; four are global and always render. */
const GLOBAL_ROWS = [
  { label: 'Projects', href: '/' },
  { label: 'Skills', href: '/skills' },
  { label: 'Analytics', href: '/analytics' },
  { label: 'Settings', href: '/settings' },
] as const

const PROJECT_ROWS = [
  { label: 'Overview', path: (id: string) => `/w/${id}`, badge: 'none' },
  { label: 'Agents', path: () => '/agents', badge: 'agentsWorking' },
  { label: 'Tasks', path: (id: string) => `/w/${id}/tasks`, badge: 'tasksActive' },
  { label: 'Graph', path: (id: string) => `/w/${id}/graph`, badge: 'none' },
  { label: 'Activity', path: (id: string) => `/w/${id}/activity`, badge: 'none' },
] as const

function workspaceIdFromPathname(pathname: string): string | null {
  const match = /^\/w\/([^/]+)/.exec(pathname)
  return match?.[1] ?? null
}

export interface SidebarProps {
  readonly workspaceId?: string
  readonly projectName?: string
}

/** One nav row. `badge` is already a rendered string (`'—'` before the snapshot lands). */
function NavRow({
  label,
  href,
  current,
  badge,
}: {
  readonly label: string
  readonly href: string
  readonly current: boolean
  readonly badge?: string
}): React.JSX.Element {
  return (
    <Link
      data-testid="nav-row"
      data-nav={label}
      href={href}
      aria-current={current ? 'page' : undefined}
      className={`flex items-center justify-between rounded-nav px-[9px] py-[7px] text-[12.5px] transition-colors ${
        current ? 'bg-[#151a21] font-medium text-text-1 shadow-[inset_2px_0_0_var(--color-tone-working)]' : 'text-text-2 hover:bg-white/[0.045] hover:text-text-1'
      }`}
    >
      <span>{label}</span>
      {badge !== undefined && (
        <span data-testid={`nav-badge-${label}`} className="font-mono text-[9.5px] text-text-3">
          {badge}
        </span>
      )}
    </Link>
  )
}

/** `1800000` → `30m`; `90000` → `1m30s`; `45000` → `45s`. The guardrail block shows a duration a
 *  person reads, not a millisecond count. */
export function formatTimeout(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes === 0) return `${seconds}s`
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`
}

/**
 * The workspace-scoped half of the sidebar: the five project rows with their live badges, plus the
 * Guardrails block. Its own component because the counts need a hook and hooks cannot be
 * conditional — `Sidebar` renders this only when the pathname carries a workspace.
 *
 * It rides the workspace's SSE stream through `useWorkspaceStream` exactly as every other live
 * view does, with `initial: null` because the root layout has no snapshot to hand it. Until the
 * first refetch lands, every figure reads `—`.
 */
export function ProjectNav({
  workspaceId,
  pathname,
}: {
  readonly workspaceId: string
  readonly pathname: string
}): React.JSX.Element {
  const { snapshot } = useWorkspaceStream<ShellFacts | null>({
    workspaceId,
    endpoint: `/api/w/${workspaceId}/shell`,
    initial: null,
  })
  const facts = snapshot

  const badgeFor = (key: 'none' | 'agentsWorking' | 'tasksActive'): string | undefined => {
    if (key === 'none') return undefined
    if (facts === null) return '—'
    return String(facts.counts[key])
  }

  return (
    <>
      <div className="flex flex-col gap-px">
        {PROJECT_ROWS.map((row) => {
          const href = row.path(workspaceId)
          const badge = badgeFor(row.badge)
          return (
            <NavRow
              key={row.label}
              label={row.label}
              href={href}
              current={pathname === href}
              {...(badge === undefined ? {} : { badge })}
            />
          )
        })}
      </div>
      <div className="mt-auto border-t border-line p-[12px]">
        <div className="mb-[7px] font-mono text-[9px] uppercase tracking-[.09em] text-text-3">Guardrails</div>
        <dl className="flex flex-col gap-[6px] font-mono text-[10.5px]">
          <GuardrailRow testId="guardrail-budget" label="budget" value={facts === null || facts.guardrails.budgetUsd === null ? '—' : `$${facts.guardrails.budgetUsd.toFixed(2)}`} />
          <GuardrailRow testId="guardrail-concurrency" label="concurrency" value={facts === null ? '—' : String(facts.guardrails.maxConcurrentRuns)} />
          <GuardrailRow testId="guardrail-timeout" label="run timeout" value={facts === null ? '—' : formatTimeout(facts.guardrails.runTimeoutMs)} />
          <GuardrailRow testId="guardrail-attempts" label="attempts" value={facts === null ? '—' : String(facts.guardrails.maxAttempts)} />
        </dl>
      </div>
    </>
  )
}

function GuardrailRow({
  testId,
  label,
  value,
}: {
  readonly testId: string
  readonly label: string
  readonly value: string
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-text-3">{label}</dt>
      <dd data-testid={testId} className="text-text-1">
        {value}
      </dd>
    </div>
  )
}

/** The handoff's 212px sidebar (design README §3a). Nine rows in the README's order: five
 *  workspace-scoped (only on a `/w/:id/...` route) then four global. */
export function Sidebar({ workspaceId: workspaceIdProp, projectName }: SidebarProps = {}): React.JSX.Element {
  const pathname = usePathname()
  const workspaceId = workspaceIdProp ?? workspaceIdFromPathname(pathname)
  const announcedName = useProjectName(workspaceId)

  return (
    <nav aria-label="Primary" className="flex w-[212px] shrink-0 flex-col gap-4 border-r border-line bg-bg-1 py-[10px] px-[8px]">
      {workspaceId !== null && (
        <div data-testid="project-section" className="flex flex-col gap-1">
          <div className="truncate px-2 py-1 font-mono text-[9px] uppercase tracking-[.09em] text-text-3">
            {projectName ?? announcedName ?? workspaceId}
          </div>
          <ProjectNav workspaceId={workspaceId} pathname={pathname} />
        </div>
      )}
      <div className="flex flex-col gap-px">
        {GLOBAL_ROWS.map((row) => (
          <NavRow key={row.label} label={row.label} href={row.href} current={pathname === row.href} />
        ))}
      </div>
    </nav>
  )
}
```

`ProjectNav`'s guardrail block uses `mt-auto`; inside the `project-section` wrapper that is inert,
so move the `<div className="mt-auto …">` OUT of `ProjectNav`'s fragment and render it as the
sidebar's last child instead if the gate screenshot shows it floating. The gate's Overview
screenshot is the check.

- [ ] **Step 9: Rewrite `TopBar.tsx`**

```tsx
// apps/web/src/components/TopBar.tsx
import type React from 'react'
import { EmergencyStopButton } from './EmergencyStopButton'

const CONNECTION_CHIP_CLASS = 'inline-flex items-center gap-1.5 rounded-chip border border-line bg-bg-2 px-2 py-0.5 font-mono text-[11px] text-text-2'

export interface TopBarProps {
  readonly workspaceId: string
  readonly workspaceName: string
  readonly connection: 'connected' | 'reconnecting'
  /**
   * The stream's measured latency (`useWorkspaceStream`'s `latencyMs`), or `null` before the first
   * event has arrived — rendered `sse · —`. While `connection` is `reconnecting` the chip says so
   * instead: a latency figure from before the stream dropped is stale, and a stale number beside
   * a live-looking label is exactly the lie Decision 3 forbids.
   */
  readonly latencyMs: number | null
  readonly budget: {
    readonly spentUsd: number
    readonly budgetUsd: number | null
    readonly unmeasuredRuns: number
  } | null
  readonly halted: boolean
}

export function TopBar({ workspaceId, workspaceName, connection, latencyMs, budget, halted }: TopBarProps): React.JSX.Element {
  const budgetUsd = budget?.budgetUsd ?? null
  const ratio = budget === null || budgetUsd === null || budgetUsd <= 0 ? 0 : budget.spentUsd / budgetUsd
  const barColor = ratio >= 1 ? 'bg-status-danger' : ratio >= 0.8 ? 'bg-status-warn' : 'bg-status-working'
  const connectionText = connection === 'connected' ? `sse · ${latencyMs === null ? '—' : `${latencyMs}ms`}` : 'reconnecting'

  return (
    <header data-testid="top-bar" className="relative flex h-[52px] flex-none items-center gap-4 bg-bg-1 px-4">
      {/* The handoff's 1px gradient hairline (design README §3a): transparent → teal .5 → indigo
        * .3 → transparent. Its own absolutely positioned element rather than a `border-bottom`,
        * because a border cannot carry a gradient. */}
      <span
        data-testid="top-bar-hairline"
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[linear-gradient(90deg,transparent,rgba(46,230,207,.5),rgba(123,140,255,.3),transparent)]"
      />
      <span className="text-[14.5px] font-semibold tracking-[-.2px]">{workspaceName}</span>
      <span data-testid="connection" className={CONNECTION_CHIP_CLASS}>
        <span
          className={`inline-block h-2 w-2 rounded-full ${connection === 'connected' ? 'bg-status-working motion-safe:animate-[status-pulse_1.5s_ease-in-out_infinite]' : 'bg-status-warn'}`}
        />
        {connectionText}
      </span>
      <span className="ml-auto flex items-center gap-3">
        {budget !== null && (
          <span data-testid="budget" className="flex items-center gap-2 text-xs text-text-2">
            <span className="font-mono">
              ${budget.spentUsd.toFixed(2)}
              {budgetUsd !== null && ` / $${budgetUsd.toFixed(2)}`}
            </span>
            {budget.unmeasuredRuns > 0 && (
              <span data-testid="budget-unmeasured" className="text-text-3">
                · {budget.unmeasuredRuns} unmeasured
              </span>
            )}
            {budgetUsd !== null && (
              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-bg-2">
                <span
                  className={`block h-full motion-safe:[transition:width_.5s_ease] ${barColor}`}
                  style={{ width: `${Math.min(100, ratio * 100)}%` }}
                />
              </span>
            )}
          </span>
        )}
        <EmergencyStopButton workspaceId={workspaceId} halted={halted} />
      </span>
    </header>
  )
}
```

Note the dot's own text is now inside the chip's `textContent`, so `connection`'s
`textContent` is exactly `sse · 42ms` (the dot span is empty).

- [ ] **Step 10: Pass `latencyMs` from all four clients**

Each of `OverviewClient.tsx`, `TasksClient.tsx`, `activity/ActivityClient.tsx` and
`graph/GraphClient.tsx` already destructures its hook's result. Add `latencyMs` to each
destructuring and `latencyMs={latencyMs}` to each `<TopBar …>`. `ActivityClient` uses
`useActivityStream`, which wraps its own `EventSource` rather than `useWorkspaceStream` — pass
`latencyMs={null}` there and leave the hook alone (widening `useActivityStream` is not this task's
scope, and `—` is the honest reading for a chip with no measurement).

- [ ] **Step 11: Write the `ShellFacts` integration test**

```typescript
// apps/web/test/integration/shell-snapshot.test.ts
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildShellFacts } from '../../src/server/shell.js'

interface Fixture {
  readonly workspaceId: string
  readonly agentId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: {
      name: 'Checkout Platform',
      repoPath: '/tmp/shell-fixture',
      verifyCommands: ['true'],
      setupCommands: [],
      budgetUsd: 20,
      maxConcurrentRuns: 3,
      runTimeoutMs: 1_800_000,
      maxAttempts: 3,
    },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, agentId: agent.id }
}

describe('buildShellFacts', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('returns null for a workspace that does not exist', async (): Promise<void> => {
    expect(await buildShellFacts('00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('carries the four guardrail columns verbatim', async (): Promise<void> => {
    const facts = await buildShellFacts(fixture.workspaceId)
    expect(facts?.guardrails).toEqual({ budgetUsd: 20, maxConcurrentRuns: 3, runTimeoutMs: 1_800_000, maxAttempts: 3 })
  })

  it('carries a null budget through as null, not as a budget of zero', async (): Promise<void> => {
    await prisma.workspace.update({ where: { id: fixture.workspaceId }, data: { budgetUsd: null } })
    expect((await buildShellFacts(fixture.workspaceId))?.guardrails.budgetUsd).toBeNull()
  })

  it('counts only agents the domain derives as working', async (): Promise<void> => {
    await prisma.agentRun.create({ data: { agentId: fixture.agentId, status: 'working' } })
    expect((await buildShellFacts(fixture.workspaceId))?.counts.agentsWorking).toBe(1)

    await prisma.agentRun.updateMany({ where: { agentId: fixture.agentId }, data: { status: 'paused' } })
    expect((await buildShellFacts(fixture.workspaceId))?.counts.agentsWorking).toBe(0)
  })

  it('counts a task under review and one in the merge queue as active', async (): Promise<void> => {
    for (const status of ['reviewing', 'merging', 'done'] as const) {
      await prisma.task.create({
        data: { workspaceId: fixture.workspaceId, title: status, description: 'x', status, requiredRole: 'backend', maxAttempts: 3 },
      })
    }
    expect((await buildShellFacts(fixture.workspaceId))?.counts.tasksActive).toBe(2)
  })

  it('does not leak another workspace tasks', async (): Promise<void> => {
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other', verifyCommands: ['true'], setupCommands: [] },
    })
    await prisma.task.create({
      data: { workspaceId: other.id, title: 'x', description: 'x', status: 'running', requiredRole: 'backend', maxAttempts: 3 },
    })
    expect((await buildShellFacts(fixture.workspaceId))?.counts.tasksActive).toBe(0)
  })
})
```

- [ ] **Step 12: Run the tests to green**

Run: `npx vitest run apps/web/test/shell.test.tsx apps/web/test/useWorkspaceStream.test.tsx apps/web/test/integration/shell-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 13: Run the full gate**

Stop `next dev` first.

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add apps/web/src/server/shell.ts "apps/web/src/app/api/w/[workspaceId]/shell/route.ts" apps/web/src/hooks/useWorkspaceStream.ts apps/web/src/components/Sidebar.tsx apps/web/src/components/TopBar.tsx apps/web/src/components/OverviewClient.tsx apps/web/src/components/TasksClient.tsx apps/web/src/components/activity/ActivityClient.tsx apps/web/src/components/graph/GraphClient.tsx apps/web/test/shell.test.tsx apps/web/test/useWorkspaceStream.test.tsx apps/web/test/integration/shell-snapshot.test.ts
git commit -m "feat(web): nine rows, live guardrails, and a latency chip that measures something"
```

---
## Series B — The Data

### Task 4: The `Skill` tool_use fixture, and `AgentRun.skillCalls`

**This is the milestone's ONE real Claude run.** Everything else spends nothing.

**Files:**
- Create: `packages/providers/test/fixtures/claude/skill-tool-use.ndjson` (recorded)
- Create: `packages/providers/test/fixtures/claude/README.md`
- Modify: `packages/providers/src/runtime/summary.ts:11-21` (`CLAUDE_SUMMARY_ARG_KEYS`; locate by
  symbol)
- Modify: `packages/db/prisma/schema.prisma` (`AgentRun.skillCalls`; locate by `model AgentRun`)
- Create: `packages/db/prisma/migrations/20260830090000_m14_run_skill_calls/migration.sql`
- Modify: `apps/orchestrator/src/pump.ts` (a per-run tally + four terminal writes; locate by
  symbol `case 'tool_call'`, `case 'gate_failed'`, `stopClaimed`, the no-outcome `concluded`, and
  the final `concluded`)
- Test: `packages/providers/test/stream.test.ts` (extend — owns every Claude parser assertion)
- Test: `apps/orchestrator/test/integration/pump.test.ts` (extend — owns every pump terminal-write
  assertion)

**Interfaces:**
- Consumes: `parseStreamLine` → `RuntimeEvent` `{ kind: 'tool_call', toolUseId, toolName, summary }`.
- Produces:

```prisma
// packages/db/prisma/schema.prisma -- AgentRun, beside costUsd
  /// Which skills this run invoked, and how many times each: `{ "superpowers:writing-plans": 2 }`
  /// (M14 §4.1). Written ONCE, at the run's terminal conclusion, from a tally the pump keeps of
  /// the `Skill` tool calls it already observes.
  ///
  /// THREE states, and the difference between the last two is Decision 4 (keyed on the run's
  /// PROVIDER, never on what the stream happened to contain):
  ///   - `{ "<skill>": n }` -- a Claude run that invoked skills.
  ///   - `{}`              -- a Claude run that invoked none. A MEASUREMENT: we watched, and
  ///                          there were none.
  ///   - `null`            -- a Cursor run, or a run that never concluded. UNKNOWN: that runtime
  ///                          cannot report skill use at all, and an empty object there would
  ///                          claim a measurement nobody made.
  skillCalls        Json?
```

```typescript
// packages/providers/src/runtime/summary.ts -- one new key, measured from the fixture
export const CLAUDE_SUMMARY_ARG_KEYS = [
  'skill',        // NEW: the `Skill` tool's only argument -- `{"skill":"superpowers:writing-plans"}`
  'file_path',
  ...
] as const
```

The pump exports nothing new; the observable contract Task 6, 12 and 16 rely on: after any
terminal write (`gate_failed`, the operator-stop conclusion, the no-terminal-event failure, and
the clean `terminated` conclusion), `AgentRun.skillCalls` holds `{ [skillName]: count }` for a
Claude run and stays `null` for a Cursor one.

- [ ] **Step 1: Record the one real Claude run**

Print the version first — the recording is only checkable against a named binary:

```bash
claude --version
mkdir -p /tmp/m14-skill-fixture && cd /tmp/m14-skill-fixture
claude --print --output-format stream-json --verbose \
  'Use the superpowers:writing-plans skill to tell me, in one sentence, where plans are saved. Do nothing else.' \
  > /tmp/m14-skill-fixture/raw.ndjson 2> /tmp/m14-skill-fixture/stderr.txt
grep -c '"name":"Skill"' /tmp/m14-skill-fixture/raw.ndjson
```

Expected: at least `1`. If `0`, the model answered from memory — retry once with a prompt that
names the skill more directly. **Two invocations is the cap for this milestone.**

- [ ] **Step 2: Redact and commit the fixture**

Follow `packages/providers/test/fixtures/cursor/gate/README.md`'s convention: keep the stream byte
for byte except for mechanical substitutions, and name every one of them in the README.

```bash
sed -e 's#/home/[^"]*/m14-skill-fixture#/fake/claude-workdir/skill#g' \
    -e 's/"user_email":"[^"]*"/"user_email":"REDACTED@example.com"/g' \
    /tmp/m14-skill-fixture/raw.ndjson \
  > packages/providers/test/fixtures/claude/skill-tool-use.ndjson
grep -n '"name":"Skill"' packages/providers/test/fixtures/claude/skill-tool-use.ndjson | head -1
```

Write `packages/providers/test/fixtures/claude/README.md` carrying, in the cursor README's shape:
the exact `claude --version` string printed in step 1, the date, the exact command line, the
recorded outcome (how many `Skill` tool_use lines, with which `input.skill` values), the
`sed` substitutions above listed as the ONLY alterations, and the statement that the mapping in
`stream.ts` was written from this recording rather than from documentation (M12 discipline).

- [ ] **Step 3: Write the failing parser test**

Append to `packages/providers/test/stream.test.ts`:

```typescript
describe('the Skill tool_use line (M14 §4.1, recorded)', () => {
  const lines = readFileSync(
    new URL('./fixtures/claude/skill-tool-use.ndjson', import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter((line) => line.trim().length > 0)

  it('recognizes every Skill invocation in the recording as a tool_call named Skill', () => {
    const skillCalls = lines
      .map((line) => parseStreamLine(line))
      .filter((event): event is Extract<RuntimeEvent, { kind: 'tool_call' }> => event.kind === 'tool_call' && event.toolName === 'Skill')

    expect(skillCalls.length).toBeGreaterThan(0)
    for (const call of skillCalls) {
      // The summary carries the skill NAME, not the bare tool name -- `input.skill` is the only
      // argument a `Skill` tool_use has, and without it every skill call reads identically in the
      // action line and on the agent card's skill chip.
      expect(call.summary).toMatch(/^Skill \S/)
      expect(call.toolUseId).toMatch(/^toolu_/)
    }
  })

  it('never returns unparsable for any line of the recording', () => {
    const unparsable = lines.map((line) => parseStreamLine(line)).filter((event) => event.kind === 'unparsable')
    expect(unparsable).toEqual([])
  })
})
```

Add `readFileSync` from `node:fs` and `RuntimeEvent` to the file's imports if absent.

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run packages/providers/test/stream.test.ts`
Expected: FAIL — `expected 'Skill' to match /^Skill \S/`. The parser sees the line and produces a
`tool_call`, but `summaryFor` has no key for `input.skill` and falls back to the bare tool name.

- [ ] **Step 5: Add `'skill'` to the Claude summary keys**

In `packages/providers/src/runtime/summary.ts`, make `'skill'` the FIRST entry of
`CLAUDE_SUMMARY_ARG_KEYS` (the list is ordered — `firstStringArg` takes the first key present),
with the comment:

```typescript
export const CLAUDE_SUMMARY_ARG_KEYS = [
  // First, deliberately: a `Skill` tool_use carries `{"skill": "<plugin>:<name>"}` and nothing
  // else worth showing (M14 §4.1, measured from
  // `test/fixtures/claude/skill-tool-use.ndjson`). Ahead of `description` because a future CLI
  // adding a `description` beside it must not shadow the one argument that names the skill.
  'skill',
  'file_path',
  'path',
  'notebook_path',
  'command',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
] as const
```

- [ ] **Step 6: Run the parser test to green**

Run: `npx vitest run packages/providers/test/stream.test.ts`
Expected: PASS.

- [ ] **Step 7: Add the column and the migration**

`packages/db/prisma/schema.prisma`, in `model AgentRun` immediately after `costUsd`, add the
`skillCalls Json?` field with the docstring from the Interfaces block above.

`packages/db/prisma/migrations/20260830090000_m14_run_skill_calls/migration.sql`:

```sql
-- M14 §4.1: which skills a run invoked, and how many times each. Nullable with no default:
-- `null` is UNMEASURED (a Cursor run, or a run that never concluded), `{}` is the measured
-- "this run invoked no skill". A default of `{}` would have made those two indistinguishable.
ALTER TABLE "AgentRun" ADD COLUMN "skillCalls" JSONB;
```

Run: `npm run db:generate && npm run db:migrate && npm run db:migrate:test`

- [ ] **Step 8: Write the failing pump tests**

Append to `apps/orchestrator/test/integration/pump.test.ts`:

```typescript
  it('tallies Skill tool calls and writes them when the run concludes cleanly', async (): Promise<void> => {
    const { runId } = await seedRun()
    await pumpRun({
      ...baseInput(runId),
      events: eventsFrom([
        { kind: 'session_started', sessionId: 's1' },
        { kind: 'tool_call', toolUseId: 't1', toolName: 'Skill', summary: 'Skill superpowers:writing-plans' },
        { kind: 'tool_call', toolUseId: 't2', toolName: 'Write', summary: 'Write a.txt' },
        { kind: 'tool_call', toolUseId: 't3', toolName: 'Skill', summary: 'Skill superpowers:writing-plans' },
        { kind: 'tool_call', toolUseId: 't4', toolName: 'Skill', summary: 'Skill superpowers:test-driven-development' },
        { kind: 'terminated', outcome: outcome({ isError: false }) },
      ]),
    })

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('succeeded')
    expect(run.skillCalls).toEqual({
      'superpowers:writing-plans': 2,
      'superpowers:test-driven-development': 1,
    })
  })

  it('writes the measured empty tally for a run that invoked no skill', async (): Promise<void> => {
    const { runId } = await seedRun()
    await pumpRun({
      ...baseInput(runId),
      events: eventsFrom([
        { kind: 'session_started', sessionId: 's1' },
        { kind: 'tool_call', toolUseId: 't1', toolName: 'Write', summary: 'Write a.txt' },
        { kind: 'terminated', outcome: outcome({ isError: false }) },
      ]),
    })
    // `{}`, not null: this run WAS measured and used no skill. `null` is reserved for a runtime
    // that cannot report (M14 Decision 4).
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).skillCalls).toEqual({})
  })

  it('writes the tally on the failure path too, not only on success', async (): Promise<void> => {
    const { runId } = await seedRun()
    await pumpRun({
      ...baseInput(runId),
      events: eventsFrom([
        { kind: 'session_started', sessionId: 's1' },
        { kind: 'tool_call', toolUseId: 't1', toolName: 'Skill', summary: 'Skill superpowers:brainstorming' },
        { kind: 'terminated', outcome: outcome({ isError: true }) },
      ]),
    })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('failed')
    expect(run.skillCalls).toEqual({ 'superpowers:brainstorming': 1 })
  })

  it('writes the tally when the stream ends with no terminal event', async (): Promise<void> => {
    const { runId } = await seedRun()
    await pumpRun({
      ...baseInput(runId),
      events: eventsFrom([
        { kind: 'session_started', sessionId: 's1' },
        { kind: 'tool_call', toolUseId: 't1', toolName: 'Skill', summary: 'Skill superpowers:verification' },
      ]),
    })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('failed')
    expect(run.skillCalls).toEqual({ 'superpowers:verification': 1 })
  })

  it('writes null, never an empty tally, for a Cursor run -- that runtime cannot report skills', async (): Promise<void> => {
    const { runId } = await seedRun()
    await pumpRun({
      ...baseInput(runId),
      // The PROVIDER is the discriminator, not the stream: this run's event list is identical to
      // the "invoked no skill" Claude case above, and the column must come out differently.
      spawn: { ...spawnFacts(), provider: 'cursor' },
      events: eventsFrom([
        { kind: 'session_started', sessionId: 's1' },
        { kind: 'tool_call', toolUseId: 't1', toolName: 'Write', summary: 'Write a.txt' },
        { kind: 'terminated', outcome: outcome({ isError: false }) },
      ]),
    })
    expect((await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })).skillCalls).toBeNull()
  })

  it('leaves skillCalls null on a run that is merely paused -- a pause is not a conclusion', async (): Promise<void> => {
    const { runId } = await seedRun()
    await pumpRun({
      ...baseInput(runId),
      events: eventsFrom([
        { kind: 'session_started', sessionId: 's1' },
        { kind: 'tool_call', toolUseId: 't1', toolName: 'Skill', summary: 'Skill superpowers:brainstorming' },
        { kind: 'hook_denied', hookName: 'PreToolUse:Write', reason: 'Paused by AI Team OS.' },
      ]),
    })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.status).toBe('paused')
    expect(run.skillCalls).toBeNull()
  })
```

Reuse whatever helper names this file already has for seeding a run, wrapping an event array in an
async iterable, building a `RunOutcome`, and building a `spawn` object — the names above
(`seedRun`, `baseInput`, `eventsFrom`, `outcome`, `spawnFacts`) are placeholders for that file's
real ones. Read the top of `pump.test.ts` and use its own; `apps/orchestrator/test/integration/
cursor-pause.test.ts` already builds a `spawn` with `provider: 'cursor'` and is the shape to
copy for that one.

- [ ] **Step 9: Run them to verify they fail**

Run: `npx vitest run apps/orchestrator/test/integration/pump.test.ts -t 'Skill'`
Expected: FAIL — `expected null to equal { 'superpowers:writing-plans': 2 }`.

- [ ] **Step 10: Tally in the pump and write on every terminal path**

In `apps/orchestrator/src/pump.ts`, beside `let toolCalls = startingRow.toolCalls`:

```typescript
  /**
   * Skills invoked during THIS pump, tallied from the `tool_call` events the loop already sees
   * (M14 §4.1, Decision 5). Seeded from the row's existing tally rather than from empty, for the
   * same reason `toolCalls` is: a resumed run is a SECOND `pumpRun` on the same row, and a tally
   * that restarts at zero forgets everything the first half of the run did.
   */
  const skillCalls = new Map<string, number>(
    Object.entries((startingRow.skillCalls as Record<string, number> | null) ?? {}),
  )
```

In `case 'tool_call'`, after the `toolCalls += 1` line:

```typescript
        if (event.toolName === 'Skill') {
          // `summary` is `"Skill <name>"` (`summaryFor` with `CLAUDE_SUMMARY_ARG_KEYS`'s leading
          // `'skill'` key, M14 Task 4) -- the name is everything after the first space. A `Skill`
          // call whose `input.skill` was missing or unreadable summarizes to the bare tool name,
          // and is counted under the sentinel below rather than dropped: a skill call that
          // happened is a fact, even when the CLI did not say which skill.
          const name = event.summary.startsWith('Skill ') ? event.summary.slice('Skill '.length) : '<unnamed>'
          skillCalls.set(name, (skillCalls.get(name) ?? 0) + 1)
        }
```

Add two helpers beside `writeCheckpoint`:

```typescript
/**
 * Whether the runtime this run was SPAWNED with can report skill invocations and token usage at
 * all (M14 §4.1/§4.2, Decision 4).
 *
 * Keyed on `spawn.provider` -- the same field `recordCursorPauseIfRequested` branches on -- and
 * deliberately NOT on what the stream happened to contain. An empty tally means two different
 * things depending on the runtime, and only one of them is a measurement: on Claude it is "we
 * watched every tool call and none was a `Skill`" (`{}`), on Cursor it is "this runtime never
 * emits one, so we do not know" (`null`). Writing `{}` for Cursor would put a fabricated zero
 * into the Skills page's per-skill run counts and a fabricated zero token sum into every
 * per-agent average on Analytics.
 *
 * `spawn` absent (a test fixture that never pauses, a caller with no spawn facts) reads as
 * "not Cursor": the only runtime this rule excludes is the one that is named.
 */
function runtimeReportsUsage(spawn: PumpRunInput['spawn']): boolean {
  return spawn?.provider !== 'cursor'
}

/** The tally as the JSON column wants it. A plain object, never a `Map` -- Prisma writes the
 *  latter as `{}`. */
function skillCallsJson(tally: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(tally)
}
```

Then add

```typescript
      skillCalls: runtimeReportsUsage(input.spawn) ? skillCallsJson(skillCalls) : null,
```

to the `data` of exactly four writes, and no others:

1. the `gate_failed` branch's `prisma.agentRun.updateMany({ … data: { status: 'failed', terminalAt: now, endedAt: now } })`
2. the `stopClaimed` `updateMany` (`status: 'stopped'`)
3. the no-outcome `concluded` `updateMany` (`status: 'failed'`)
4. the final `concluded` `updateMany` (`status: failed ? 'failed' : 'succeeded'`)

**Not** the two pause writes (`stopped_by_gate` and `recordCursorPauseIfRequested`): a pause is
not a conclusion, the run will be resumed by a second `pumpRun` that continues the tally, and
Decision 5 says the fact is recorded at the run's END.

**A Cursor run writes `null`, and the branch is the provider** (spec §4.1, Decision 4).
`packages/providers/src/cursor/stream.ts` never emits a `tool_call` named `Skill`, so a Cursor
run's tally is always empty — which is exactly why the empty tally cannot be written as `{}`
there. `runtimeReportsUsage(input.spawn)` above is the single place that rule lives; no capability
flag is added, because `spawn.provider` already carries the fact and `recordCursorPauseIfRequested`
already branches on it two hundred lines up.

- [ ] **Step 11: Run the pump tests to green**

Run: `npx vitest run apps/orchestrator/test/integration/pump.test.ts`
Expected: PASS.

- [ ] **Step 12: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add packages/providers/test/fixtures/claude/skill-tool-use.ndjson packages/providers/test/fixtures/claude/README.md packages/providers/src/runtime/summary.ts packages/providers/test/stream.test.ts packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260830090000_m14_run_skill_calls/migration.sql apps/orchestrator/src/pump.ts apps/orchestrator/test/integration/pump.test.ts
git commit -m "feat(orchestrator): a skill invocation is a fact of the run, recorded at its end"
```

---

### Task 5: `RunOutcome.tokens` and `AgentRun.tokensIn`/`tokensOut`

**Files:**
- Modify: `packages/providers/src/types.ts` (`RunOutcome`; locate by symbol)
- Modify: `packages/providers/src/claude/stream.ts` (`resultSchema` and `parseResultLine`; locate
  by symbol)
- Modify: `packages/db/prisma/schema.prisma` (`AgentRun`, beside `costUsd`)
- Create: `packages/db/prisma/migrations/20260830091000_m14_run_tokens/migration.sql`
- Modify: `apps/orchestrator/src/pump.ts` (the final `concluded` write only)
- Test: `packages/providers/test/stream.test.ts` (extend)
- Test: `packages/providers/test/cursor-stream.test.ts` (extend — Cursor's `null`)
- Test: `apps/orchestrator/test/integration/pump.test.ts` (extend)

**Interfaces:**
- Consumes: the `usage` object already present on every recorded `result` line
  (`packages/providers/test/fixtures/complete.ndjson` carries
  `"usage":{"input_tokens":4,…,"output_tokens":741,…}`); and Task 4's
  `runtimeReportsUsage(spawn: PumpRunInput['spawn']): boolean` in `apps/orchestrator/src/pump.ts`
  — the one place the "Cursor cannot report, so `null`" rule lives, shared by both columns.
- Produces:

```typescript
// packages/providers/src/types.ts -- RunOutcome gains one field
  /**
   * The run's token usage, or `null` when the runtime does not report it (M14 §4.2). Never
   * `{ input: 0, output: 0 }` for an unmeasured run -- zero is a figure a per-agent average would
   * believe. `input` is the `result` line's `usage.input_tokens` and `output` its
   * `usage.output_tokens`; the cache fields (`cache_creation_input_tokens`,
   * `cache_read_input_tokens`) are deliberately NOT folded in -- they are a different quantity,
   * and summing them into `input` would make one agent's cache hit look like extra work.
   */
  readonly tokens: { readonly input: number; readonly output: number } | null
```

```prisma
// packages/db/prisma/schema.prisma -- AgentRun, beside costUsd
  /// `RunOutcome.tokens.input` / `.output` (M14 §4.2). Nullable, no default: `null` is UNMEASURED
  /// -- a Cursor run (keyed on the run's PROVIDER, the same rule `skillCalls` follows), or a
  /// degraded Claude `result` line that carried no `usage`. `0` would be a measured zero the
  /// Analytics page would average in.
  tokensIn          Int?
  tokensOut         Int?
```

- [ ] **Step 1: Write the failing parser tests**

Append to `packages/providers/test/stream.test.ts`:

```typescript
describe('result line token usage (M14 §4.2)', () => {
  it('reads usage.input_tokens and usage.output_tokens off a real result line', () => {
    const line = readFileSync(new URL('./fixtures/complete.ndjson', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.includes('"type":"result"'))
    const event = parseStreamLine(line as string)
    expect(event.kind).toBe('terminated')
    expect((event as Extract<RuntimeEvent, { kind: 'terminated' }>).outcome.tokens).toEqual({ input: 4, output: 741 })
  })

  it('is null, never zero, when the result line carries no usage at all', () => {
    const event = parseStreamLine(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.1 }),
    )
    expect((event as Extract<RuntimeEvent, { kind: 'terminated' }>).outcome.tokens).toBeNull()
  })

  it('is null when usage is present but either half is missing -- half a measurement is none', () => {
    const event = parseStreamLine(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.1, usage: { input_tokens: 10 } }),
    )
    expect((event as Extract<RuntimeEvent, { kind: 'terminated' }>).outcome.tokens).toBeNull()
  })

  it('does not fold the cache counters into input -- they are a different quantity', () => {
    const event = parseStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.1,
        usage: { input_tokens: 4, output_tokens: 741, cache_creation_input_tokens: 16_732, cache_read_input_tokens: 46_948 },
      }),
    )
    expect((event as Extract<RuntimeEvent, { kind: 'terminated' }>).outcome.tokens).toEqual({ input: 4, output: 741 })
  })
})
```

Append to `packages/providers/test/cursor-stream.test.ts`:

```typescript
  it('reports no token usage -- Cursor never says (M14 Decision 4)', () => {
    const terminal = parseCursorStreamLine(
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1200, result: 'done' }),
    )
    expect(terminal.kind).toBe('terminated')
    expect((terminal as Extract<RuntimeEvent, { kind: 'terminated' }>).outcome.tokens).toBeNull()
  })
```

Use that file's own import name for the Cursor parser.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/providers/test/stream.test.ts packages/providers/test/cursor-stream.test.ts`
Expected: FAIL — TypeScript reports `tokens` does not exist on `RunOutcome`; at runtime,
`undefined` rather than the expected object.

- [ ] **Step 3: Widen `RunOutcome` and both parsers**

Add the `tokens` field to `RunOutcome` in `packages/providers/src/types.ts` with the docstring
above.

In `packages/providers/src/claude/stream.ts`, add to `resultSchema`:

```typescript
  // Every recorded `result` line carries this; it is `.optional()` for the same reason every
  // other field here is -- a degraded error result is where the CLI is plausibly silent, and a
  // missing `usage` must degrade to `null`, not fail the parse of a line that must always
  // produce `terminated`.
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .passthrough()
    .optional(),
```

and in `parseResultLine`'s returned `outcome`, beside `costUsd`:

```typescript
      // Both halves or neither (M14 §4.2). A `usage` carrying only `input_tokens` describes a
      // measurement that did not complete, and reporting `{ input: 10, output: 0 }` would put a
      // fabricated zero into every per-agent token sum on the Analytics page.
      tokens:
        data.usage !== undefined &&
        typeof data.usage.input_tokens === 'number' &&
        typeof data.usage.output_tokens === 'number'
          ? { input: data.usage.input_tokens, output: data.usage.output_tokens }
          : null,
```

In `packages/providers/src/cursor/stream.ts`, add `tokens: null` to the `terminated` outcome it
builds, with the comment:

```typescript
      // Cursor's `result` line carries no usage of any kind (M12's recordings, M13's gate
      // fixtures). `null`, not zero -- Decision 4.
      tokens: null,
```

Any other construction of a `RunOutcome` literal in `packages/providers/src` or its tests will now
fail to compile; add `tokens: null` to each. Run `npm run typecheck` to enumerate them.

- [ ] **Step 4: Run the parser tests to green**

Run: `npx vitest run packages/providers/test`
Expected: PASS.

- [ ] **Step 5: Add the columns and the migration**

Schema: the two fields above, immediately after `costUsd`.

`packages/db/prisma/migrations/20260830091000_m14_run_tokens/migration.sql`:

```sql
-- M14 §4.2: the run's token usage as its runtime reported it. Nullable with no default -- `null`
-- is "this runtime does not say" (Cursor, and any degraded Claude result line), and `0` would be
-- a measured zero the Analytics page would average in.
ALTER TABLE "AgentRun" ADD COLUMN "tokensIn" INTEGER;
ALTER TABLE "AgentRun" ADD COLUMN "tokensOut" INTEGER;
```

Run: `npm run db:generate && npm run db:migrate && npm run db:migrate:test`

- [ ] **Step 6: Write the failing pump test**

Append to `apps/orchestrator/test/integration/pump.test.ts`:

```typescript
  it('writes the reported token counts beside the cost when the run concludes', async (): Promise<void> => {
    const { runId } = await seedRun()
    await pumpRun({
      ...baseInput(runId),
      events: eventsFrom([
        { kind: 'session_started', sessionId: 's1' },
        { kind: 'terminated', outcome: outcome({ isError: false, tokens: { input: 4, output: 741 } }) },
      ]),
    })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.tokensIn).toBe(4)
    expect(run.tokensOut).toBe(741)
  })

  it('leaves both token columns null for a runtime that reported none', async (): Promise<void> => {
    const { runId } = await seedRun()
    await pumpRun({
      ...baseInput(runId),
      events: eventsFrom([
        { kind: 'session_started', sessionId: 's1' },
        { kind: 'terminated', outcome: outcome({ isError: false, tokens: null }) },
      ]),
    })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.tokensIn).toBeNull()
    expect(run.tokensOut).toBeNull()
  })

  it('writes null for a Cursor run even if its outcome somehow carried a usage object', async (): Promise<void> => {
    const { runId } = await seedRun()
    await pumpRun({
      ...baseInput(runId),
      spawn: { ...spawnFacts(), provider: 'cursor' },
      events: eventsFrom([
        { kind: 'session_started', sessionId: 's1' },
        // A figure this product has never measured on Cursor. The PROVIDER decides, not the
        // outcome -- the same rule `skillCalls` follows (Decision 4).
        { kind: 'terminated', outcome: outcome({ isError: false, tokens: { input: 1, output: 2 } }) },
      ]),
    })
    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    expect(run.tokensIn).toBeNull()
    expect(run.tokensOut).toBeNull()
  })
```

That file's `outcome` helper needs a `tokens` field; add `tokens: null` to its defaults so every
existing call site keeps compiling.

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run apps/orchestrator/test/integration/pump.test.ts -t 'token'`
Expected: FAIL — `expected null to be 4`.

- [ ] **Step 8: Write the columns from the pump**

In `apps/orchestrator/src/pump.ts`, in the FINAL `concluded` `updateMany` only (the one that
already writes `costUsd: outcome.costUsd`):

```typescript
      costUsd: outcome.costUsd,
      // The same "unknown stays unknown" rule `costUsd` follows, and the same PROVIDER key
      // `skillCalls` uses (Decision 4). `runtimeReportsUsage` is belt-and-braces here rather than
      // redundant: `cursor/stream.ts` already yields `tokens: null`, and this line is what keeps
      // that true if a future Cursor build starts reporting a usage object this product has not
      // measured. Only this write has an `outcome` to read from -- the three other terminal paths
      // conclude a run that produced no `result` line at all.
      tokensIn: runtimeReportsUsage(input.spawn) ? (outcome.tokens?.input ?? null) : null,
      tokensOut: runtimeReportsUsage(input.spawn) ? (outcome.tokens?.output ?? null) : null,
```

- [ ] **Step 9: Run the pump tests to green**

Run: `npx vitest run apps/orchestrator/test/integration/pump.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/providers/src/types.ts packages/providers/src/claude/stream.ts packages/providers/src/cursor/stream.ts packages/providers/test/stream.test.ts packages/providers/test/cursor-stream.test.ts packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260830091000_m14_run_tokens/migration.sql apps/orchestrator/src/pump.ts apps/orchestrator/test/integration/pump.test.ts
git commit -m "feat(providers): a run reports what it spent in tokens, or says it cannot"
```

---

### Task 6: `syncSkillCatalog`, `assignSkill`/`unassignSkill`, and the `skills sync` verb

**Files:**
- Create: `packages/control/src/skills.ts`
- Modify: `packages/control/src/index.ts` (export it)
- Modify: `packages/control/src/refusal.ts` (`skill_not_found`)
- Modify: `packages/db/prisma/schema.prisma` (`Skill.missingSince`)
- Create: `packages/db/prisma/migrations/20260830092000_m14_skill_missing_since/migration.sql`
- Modify: `apps/orchestrator/src/cli.ts` (`skills sync` verb + `USAGE`)
- Modify: `apps/orchestrator/src/daemon.ts` (`runDaemon`'s startup, beside `reconcileOrphans`)
- Test: `packages/control/test/integration/skills.test.ts` (create)
- Test: `apps/orchestrator/test/integration/cli.test.ts` (extend — owns every CLI verb assertion)

**Interfaces:**
- Consumes: `Result`/`ok`/`err` from `@ai-team-os/domain`; `ControlRefusal`; `prisma`.
- Produces:

```typescript
// packages/control/src/skills.ts
/** Where a skill was found. `roots` defaults to the three real ones (M14 §4.3); tests pass a
 *  temp tree. */
export interface SkillRoots {
  /** `~/.claude/skills` — provider `personal`. */
  readonly personal: string
  /** `~/.claude/plugins/cache` — provider `plugin:<plugin>`, highest version wins. */
  readonly pluginCache: string
  /** `<repo>/.claude/skills` — provider `project`. */
  readonly project: string
}

export interface SyncResult {
  readonly providers: number
  readonly upserted: number
  /** Skills present in the DB but absent from disk this scan; each got `missingSince` set. */
  readonly markedMissing: number
}

export async function syncSkillCatalog(roots?: Partial<SkillRoots>): Promise<SyncResult>
export async function assignSkill(agentId: string, skillId: string): Promise<Result<void, ControlRefusal>>
export async function unassignSkill(agentId: string, skillId: string): Promise<Result<void, ControlRefusal>>
```

```typescript
// packages/control/src/refusal.ts -- one new member
/** A skill id that no `Skill` row carries (M14 §4.3). */
| { readonly kind: 'skill_not_found'; readonly skillId: string }
```

`refusalText({ kind: 'skill_not_found', skillId })` returns exactly `no skill with id ${skillId}`.

```prisma
// packages/db/prisma/schema.prisma -- Skill
  /// When a scan first failed to find this skill on disk (M14 Decision 6). The catalog NEVER
  /// deletes: a run that referenced a skill keeps a row to point at, so its history stays
  /// legible. Cleared the moment a later scan finds it again.
  missingSince DateTime?
```

- [ ] **Step 1: Write the failing catalog tests**

```typescript
// packages/control/test/integration/skills.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { refusalText } from '../../src/refusal.js'
import { assignSkill, syncSkillCatalog, unassignSkill } from '../../src/skills.js'

let root: string

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`)
}

function roots(): { personal: string; pluginCache: string; project: string } {
  return { personal: join(root, 'personal'), pluginCache: join(root, 'plugins'), project: join(root, 'project') }
}

describe('syncSkillCatalog', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "AgentSkill", "Skill", "SkillProvider", "AgentPermission", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    root = mkdtempSync(join(tmpdir(), 'aiteamos-skills-'))
    mkdirSync(roots().personal, { recursive: true })
    mkdirSync(roots().pluginCache, { recursive: true })
    mkdirSync(roots().project, { recursive: true })
  })

  afterEach((): void => {
    rmSync(root, { recursive: true, force: true })
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('reads frontmatter name and description under the three provider names', async (): Promise<void> => {
    writeSkill(roots().personal, 'my-notes', 'my own notes skill')
    mkdirSync(join(roots().pluginCache, 'marketplace/superpowers/6.3.0/skills'), { recursive: true })
    writeSkill(join(roots().pluginCache, 'marketplace/superpowers/6.3.0/skills'), 'writing-plans', 'plans things')
    writeSkill(roots().project, 'house-style', 'this repo house style')

    const result = await syncSkillCatalog(roots())
    expect(result.providers).toBe(3)
    expect(result.upserted).toBe(3)

    const providers = await prisma.skillProvider.findMany({ include: { skills: true }, orderBy: { name: 'asc' } })
    expect(providers.map((p) => p.name)).toEqual(['personal', 'plugin:superpowers', 'project'])
    const plugin = providers.find((p) => p.name === 'plugin:superpowers')
    expect(plugin?.skills[0]?.name).toBe('writing-plans')
    expect(plugin?.skills[0]?.description).toBe('plans things')
  })

  it('takes the highest version of a plugin, never a lower one', async (): Promise<void> => {
    for (const version of ['6.3.0', '10.0.1', '9.9.9']) {
      mkdirSync(join(roots().pluginCache, `mkt/superpowers/${version}/skills`), { recursive: true })
      writeSkill(join(roots().pluginCache, `mkt/superpowers/${version}/skills`), 'writing-plans', `from ${version}`)
    }
    await syncSkillCatalog(roots())
    const skill = await prisma.skill.findFirstOrThrow({ where: { name: 'writing-plans' } })
    // Numeric comparison, not lexicographic: '9.9.9' > '10.0.1' as strings, and that is the bug
    // this pins.
    expect(skill.description).toBe('from 10.0.1')
  })

  it('updates an existing row rather than duplicating it', async (): Promise<void> => {
    writeSkill(roots().personal, 'my-notes', 'first')
    await syncSkillCatalog(roots())
    writeSkill(roots().personal, 'my-notes', 'second')
    await syncSkillCatalog(roots())

    const skills = await prisma.skill.findMany({ where: { name: 'my-notes' } })
    expect(skills).toHaveLength(1)
    expect(skills[0]?.description).toBe('second')
  })

  it('marks a vanished skill missing rather than deleting it, and clears the mark when it returns', async (): Promise<void> => {
    writeSkill(roots().personal, 'my-notes', 'notes')
    await syncSkillCatalog(roots())
    rmSync(join(roots().personal, 'my-notes'), { recursive: true, force: true })

    const second = await syncSkillCatalog(roots())
    expect(second.markedMissing).toBe(1)
    const missing = await prisma.skill.findFirstOrThrow({ where: { name: 'my-notes' } })
    expect(missing.missingSince).not.toBeNull()

    writeSkill(roots().personal, 'my-notes', 'notes')
    await syncSkillCatalog(roots())
    expect((await prisma.skill.findFirstOrThrow({ where: { name: 'my-notes' } })).missingSince).toBeNull()
  })

  it('does not re-stamp missingSince on a skill that was already missing', async (): Promise<void> => {
    writeSkill(roots().personal, 'my-notes', 'notes')
    await syncSkillCatalog(roots())
    rmSync(join(roots().personal, 'my-notes'), { recursive: true, force: true })
    await syncSkillCatalog(roots())
    const first = (await prisma.skill.findFirstOrThrow({ where: { name: 'my-notes' } })).missingSince
    await syncSkillCatalog(roots())
    expect((await prisma.skill.findFirstOrThrow({ where: { name: 'my-notes' } })).missingSince).toEqual(first)
  })

  it('ignores a directory with no SKILL.md and a SKILL.md with no name', async (): Promise<void> => {
    mkdirSync(join(roots().personal, 'not-a-skill'), { recursive: true })
    mkdirSync(join(roots().personal, 'headless'), { recursive: true })
    writeFileSync(join(roots().personal, 'headless/SKILL.md'), '# no frontmatter here\n')
    const result = await syncSkillCatalog(roots())
    expect(result.upserted).toBe(0)
  })

  it('survives a root that does not exist at all', async (): Promise<void> => {
    rmSync(roots().project, { recursive: true, force: true })
    await expect(syncSkillCatalog(roots())).resolves.toMatchObject({ upserted: 0 })
  })
})

describe('assignSkill / unassignSkill', () => {
  it('refuses an unknown skill with the verbatim text, and an unknown agent with its own', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: { name: 'W', repoPath: '/tmp/x', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'T' } })
    const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })

    const noSkill = await assignSkill(agent.id, '00000000-0000-4000-8000-000000000000')
    expect(noSkill.ok).toBe(false)
    if (!noSkill.ok) {
      expect(noSkill.error.kind).toBe('skill_not_found')
      expect(refusalText(noSkill.error)).toBe('no skill with id 00000000-0000-4000-8000-000000000000')
    }

    const provider = await prisma.skillProvider.create({ data: { name: 'personal' } })
    const skill = await prisma.skill.create({ data: { providerId: provider.id, name: 'n', description: 'd' } })
    const noAgent = await assignSkill('00000000-0000-4000-8000-000000000000', skill.id)
    expect(noAgent.ok).toBe(false)
    if (!noAgent.ok) expect(noAgent.error.kind).toBe('agent_not_found')
  })

  it('is idempotent in both directions', async (): Promise<void> => {
    const workspace = await prisma.workspace.create({
      data: { name: 'W', repoPath: '/tmp/x', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'T' } })
    const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
    const provider = await prisma.skillProvider.create({ data: { name: 'personal' } })
    const skill = await prisma.skill.create({ data: { providerId: provider.id, name: 'n', description: 'd' } })

    expect((await assignSkill(agent.id, skill.id)).ok).toBe(true)
    expect((await assignSkill(agent.id, skill.id)).ok).toBe(true)
    expect(await prisma.agentSkill.count({ where: { agentId: agent.id } })).toBe(1)

    expect((await unassignSkill(agent.id, skill.id)).ok).toBe(true)
    expect((await unassignSkill(agent.id, skill.id)).ok).toBe(true)
    expect(await prisma.agentSkill.count({ where: { agentId: agent.id } })).toBe(0)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/control/test/integration/skills.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/skills.js"`.

- [ ] **Step 3: Add the column and the migration**

Schema: `missingSince DateTime?` on `model Skill`, with the docstring above.

`packages/db/prisma/migrations/20260830092000_m14_skill_missing_since/migration.sql`:

```sql
-- M14 Decision 6: the catalog never deletes. A skill that disappears from disk is stamped here,
-- so history that referenced it keeps a row to point at. Cleared when a later scan finds it.
ALTER TABLE "Skill" ADD COLUMN "missingSince" TIMESTAMP(3);
```

Run: `npm run db:generate && npm run db:migrate && npm run db:migrate:test`

- [ ] **Step 4: Write `packages/control/src/skills.ts`**

```typescript
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import type { ControlRefusal } from './refusal.js'

export interface SkillRoots {
  readonly personal: string
  readonly pluginCache: string
  readonly project: string
}

export interface SyncResult {
  readonly providers: number
  readonly upserted: number
  readonly markedMissing: number
}

/** The daemon host's own three roots (M14 §4.3). `project` is resolved from the process's cwd --
 *  the daemon runs from the repository, and a plan that hardcoded a path would be wrong on every
 *  other machine. */
function defaultRoots(): SkillRoots {
  return {
    personal: join(homedir(), '.claude', 'skills'),
    pluginCache: join(homedir(), '.claude', 'plugins', 'cache'),
    project: join(process.cwd(), '.claude', 'skills'),
  }
}

interface Found {
  readonly provider: string
  readonly name: string
  readonly description: string
}

/** `---\nname: x\ndescription: y\n---` — the two fields a SKILL.md must carry. Deliberately not a
 *  YAML parser: the frontmatter this reads is two scalar lines, and a dependency for that is a
 *  dependency for nothing. A file with no `name` is not a skill and is skipped. */
function parseFrontmatter(text: string): { name: string; description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return null
  const body = match[1] ?? ''
  const field = (key: string): string | null => {
    const line = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(body)
    return line === null ? null : (line[1] ?? '').trim().replace(/^["']|["']$/g, '')
  }
  const name = field('name')
  if (name === null || name === '') return null
  return { name, description: field('description') ?? '' }
}

function readDirs(dir: string): readonly string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Every `<dir>/<skill>/SKILL.md` under one skills directory, as `Found` rows for `provider`. */
function scanSkillsDir(dir: string, provider: string): readonly Found[] {
  const found: Found[] = []
  for (const name of readDirs(dir)) {
    const path = join(dir, name, 'SKILL.md')
    if (!existsSync(path)) continue
    let parsed: { name: string; description: string } | null = null
    try {
      parsed = parseFrontmatter(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    if (parsed === null) continue
    found.push({ provider, name: parsed.name, description: parsed.description })
  }
  return found
}

/** `10.0.1` beats `9.9.9`. Compared segment by segment as NUMBERS — a lexicographic sort puts
 *  `9.9.9` above `10.0.1`, which would pin a plugin to a stale version forever. A segment that is
 *  not a number sorts below every one that is (`unknown` is what the CLI writes when a plugin has
 *  no version). */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : -1))
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? -1) - (right[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}

/** `<cache>/<marketplace>/<plugin>/<version>/skills/*` — the highest version of each plugin wins. */
function scanPluginCache(cacheDir: string): readonly Found[] {
  const bestVersion = new Map<string, { version: string; dir: string }>()
  for (const marketplace of readDirs(cacheDir)) {
    for (const plugin of readDirs(join(cacheDir, marketplace))) {
      for (const version of readDirs(join(cacheDir, marketplace, plugin))) {
        const skillsDir = join(cacheDir, marketplace, plugin, version, 'skills')
        if (!existsSync(skillsDir)) continue
        const current = bestVersion.get(plugin)
        if (current === undefined || compareVersions(version, current.version) > 0) {
          bestVersion.set(plugin, { version, dir: skillsDir })
        }
      }
    }
  }
  return [...bestVersion.entries()].flatMap(([plugin, { dir }]) => scanSkillsDir(dir, `plugin:${plugin}`))
}

/**
 * Reads the daemon host's disk into `SkillProvider`/`Skill`, and NEVER deletes (Decision 6).
 *
 * Runs at daemon start and from `orchestrator skills sync`. A missing root is not an error --
 * a machine with no personal skills directory is an ordinary machine, and throwing there would
 * stop the daemon from starting.
 */
export async function syncSkillCatalog(roots?: Partial<SkillRoots>): Promise<SyncResult> {
  const resolved: SkillRoots = { ...defaultRoots(), ...roots }
  const found = [
    ...scanSkillsDir(resolved.personal, 'personal'),
    ...scanPluginCache(resolved.pluginCache),
    ...scanSkillsDir(resolved.project, 'project'),
  ]

  const providerNames = [...new Set(found.map((f) => f.provider))]
  const providerIds = new Map<string, string>()
  for (const name of providerNames) {
    const row = await prisma.skillProvider.upsert({ where: { name }, update: {}, create: { name } })
    providerIds.set(name, row.id)
  }

  const seen = new Set<string>()
  for (const skill of found) {
    const providerId = providerIds.get(skill.provider)
    if (providerId === undefined) continue
    const row = await prisma.skill.upsert({
      where: { providerId_name: { providerId, name: skill.name } },
      // `missingSince: null` on EVERY upsert, not only when it was set: a skill that came back is
      // present again, and leaving the stamp would show it as missing forever.
      update: { description: skill.description, missingSince: null },
      create: { providerId, name: skill.name, description: skill.description },
    })
    seen.add(row.id)
  }

  // Conditional on `missingSince: null` so a skill that has been gone for a week keeps the date it
  // actually vanished rather than being re-stamped with today's on every scan.
  const marked = await prisma.skill.updateMany({
    where: { id: { notIn: [...seen] }, missingSince: null },
    data: { missingSince: new Date() },
  })

  return { providers: providerNames.length, upserted: seen.size, markedMissing: marked.count }
}

/** Gives an agent a skill. Idempotent: the composite primary key `(agentId, skillId)` makes a
 *  second call a no-op rather than a duplicate row. */
export async function assignSkill(agentId: string, skillId: string): Promise<Result<void, ControlRefusal>> {
  const skill = await prisma.skill.findUnique({ where: { id: skillId }, select: { id: true } })
  if (skill === null) return err({ kind: 'skill_not_found', skillId })
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } })
  if (agent === null) return err({ kind: 'agent_not_found', agentId })

  await prisma.agentSkill.upsert({
    where: { agentId_skillId: { agentId, skillId } },
    update: {},
    create: { agentId, skillId },
  })
  return ok(undefined)
}

/** Takes it away. Idempotent for the same reason, via `deleteMany` rather than `delete` (which
 *  throws on a row that is already gone). */
export async function unassignSkill(agentId: string, skillId: string): Promise<Result<void, ControlRefusal>> {
  const skill = await prisma.skill.findUnique({ where: { id: skillId }, select: { id: true } })
  if (skill === null) return err({ kind: 'skill_not_found', skillId })
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } })
  if (agent === null) return err({ kind: 'agent_not_found', agentId })

  await prisma.agentSkill.deleteMany({ where: { agentId, skillId } })
  return ok(undefined)
}
```

Add `| { readonly kind: 'skill_not_found'; readonly skillId: string }` to `ControlRefusal` and
`case 'skill_not_found': return \`no skill with id ${refusal.skillId}\`` to `refusalText`. Add
`export * from './skills.js'` to `packages/control/src/index.ts`.

- [ ] **Step 5: Run the catalog tests to green**

Run: `npx vitest run packages/control/test/integration/skills.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing CLI test**

Append to `apps/orchestrator/test/integration/cli.test.ts`, following its existing `main([...])`
idiom:

```typescript
  it('runs skills sync and reports what it found', async (): Promise<void> => {
    const code = await main(['skills', 'sync'])
    expect(code).toBe(0)
    // The catalog is read from the DAEMON HOST's disk, so this asserts the shape of the report
    // rather than a count: a CI machine has no `~/.claude/skills`, and a machine that does has an
    // unknowable number.
    expect(stdout.join('')).toMatch(/^skill catalog synced: \d+ provider\(s\), \d+ skill\(s\), \d+ marked missing\n$/m)
  })
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts -t 'skills sync'`
Expected: FAIL — `unknown command: skills`, exit code 1.

- [ ] **Step 8: Add the verb and the daemon hook**

In `apps/orchestrator/src/cli.ts`, import `syncSkillCatalog` from `@ai-team-os/control`, add to
`USAGE` after `set-goal`:

```
  skills sync                          rescan the skill catalog from this host's disk:
                                       ~/.claude/skills, the plugin cache, and <repo>/.claude/skills
```

and add the case (`parseArgs` yields `command` = `'skills'`, so the sub-verb comes from the
positional args this file already collects — read `parseArgs` and use its own shape):

```typescript
    case 'skills': {
      const sub = flags['_1'] ?? argv[1]
      if (sub !== 'sync') {
        process.stderr.write(`unknown skills subcommand: ${String(sub)}\n\n${USAGE}`)
        return 1
      }
      const result = await syncSkillCatalog()
      process.stdout.write(
        `skill catalog synced: ${result.providers} provider(s), ${result.upserted} skill(s), ${result.markedMissing} marked missing\n`,
      )
      return 0
    }
```

In `apps/orchestrator/src/daemon.ts`, inside `runDaemon`, immediately after the
`reconcileOrphans` block:

```typescript
  // The catalog, once, before the first tick (M14 §4.3). Non-fatal: a host with no skills
  // directory is an ordinary host, and a daemon that refuses to start because it could not read
  // one is worse than a daemon with an empty catalog. Skipped entirely on a rescan failure --
  // `orchestrator skills sync` is the operator's retry.
  try {
    const catalog = await syncSkillCatalog()
    process.stdout.write(
      `skill catalog synced: ${catalog.providers} provider(s), ${catalog.upserted} skill(s), ${catalog.markedMissing} marked missing\n`,
    )
  } catch (error) {
    process.stderr.write(`[daemon] skill catalog sync failed: ${error instanceof Error ? error.message : String(error)}\n`)
  }
```

- [ ] **Step 9: Run the CLI test to green**

Run: `npx vitest run apps/orchestrator/test/integration/cli.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/control/src/skills.ts packages/control/src/index.ts packages/control/src/refusal.ts packages/control/test/integration/skills.test.ts packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260830092000_m14_skill_missing_since/migration.sql apps/orchestrator/src/cli.ts apps/orchestrator/src/daemon.ts apps/orchestrator/test/integration/cli.test.ts
git commit -m "feat(control): the skill catalog is read from disk and never deletes"
```

---

### Task 7: `server/analytics.ts`

**Files:**
- Create: `apps/web/src/server/analytics.ts`
- Test: `apps/web/test/integration/analytics.test.ts` (create)

**Interfaces:**
- Consumes: `sumSpend` from `@ai-team-os/domain` (returns `{ known, unknownRuns }`);
  `AgentRun.terminalAt`, `.startedAt`, `.endedAt`, `.costUsd`, `.provider`, `.status`,
  `.tokensIn`, `.tokensOut` (Task 5); `ExecutionEvent.type = 'run.paused'`.
- Produces:

```typescript
// apps/web/src/server/analytics.ts
export interface DayCount {
  /** `YYYY-MM-DD`, UTC. Seven entries, oldest first, zero-filled. */
  readonly day: string
  readonly succeeded: number
  readonly failed: number
}

export interface Kpi {
  readonly label: string
  /** Already formatted for display (`'92%'`, `'14m 20s'`, `'$8.43'`, `'—'`). The page renders it
   *  verbatim; formatting lives here so the seven-day chart and the tiles cannot disagree. */
  readonly value: string
  /** A second line under the figure, or `null`. Carries the unmeasured count where there is one
   *  (`'3 runs unmeasured'`) — never folded into `value`. */
  readonly note: string | null
}

export interface AgentPerformanceRow {
  readonly agentId: string
  readonly name: string
  readonly role: string
  readonly runs: number
  /** `null` when the agent has no terminal run at all — no denominator, no rate. */
  readonly successPct: number | null
  /** Mean `endedAt − startedAt` in ms over terminal runs, `null` with none. */
  readonly avgDurationMs: number | null
  /** Summed `tokensIn + tokensOut` over runs that reported them, `null` when none did. */
  readonly tokens: number | null
  readonly costUsd: number
  readonly unmeasuredRuns: number
}

export interface AnalyticsSnapshot {
  /** `null` for the global (all-workspace) view. */
  readonly workspaceId: string | null
  readonly series: readonly DayCount[]
  /** Exactly six, in the order the page renders them. */
  readonly kpis: readonly Kpi[]
  readonly perAgent: readonly AgentPerformanceRow[]
}

export async function buildAnalytics(workspaceId: string | null): Promise<AnalyticsSnapshot>
```

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/test/integration/analytics.test.ts
import { prisma } from '@ai-team-os/db/client'
import { appendEvent } from '@ai-team-os/events'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildAnalytics } from '../../src/server/analytics.js'

interface Fixture {
  readonly workspaceId: string
  readonly agentId: string
}

async function seed(): Promise<Fixture> {
  const workspace = await prisma.workspace.create({
    data: { name: 'Checkout', repoPath: '/tmp/analytics-fixture', verifyCommands: ['true'], setupCommands: [] },
  })
  const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'Engineering' } })
  const agent = await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })
  return { workspaceId: workspace.id, agentId: agent.id }
}

function daysAgo(n: number): Date {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d
}

describe('buildAnalytics', () => {
  let fixture: Fixture

  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "Artifact", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    fixture = await seed()
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('returns seven days oldest first, zero-filled, even with no runs at all', async (): Promise<void> => {
    const snapshot = await buildAnalytics(fixture.workspaceId)
    expect(snapshot.series).toHaveLength(7)
    expect(snapshot.series.every((d) => d.succeeded === 0 && d.failed === 0)).toBe(true)
    const days = snapshot.series.map((d) => d.day)
    expect([...days].sort()).toEqual(days)
  })

  it('buckets succeeded and failed runs by the day they concluded', async (): Promise<void> => {
    for (const [status, terminalAt] of [
      ['succeeded', daysAgo(1)],
      ['succeeded', daysAgo(1)],
      ['failed', daysAgo(1)],
      ['succeeded', daysAgo(3)],
      ['succeeded', daysAgo(30)], // outside the window
    ] as const) {
      await prisma.agentRun.create({
        data: { agentId: fixture.agentId, status, provider: 'claude_code', terminalAt, endedAt: terminalAt },
      })
    }
    const snapshot = await buildAnalytics(fixture.workspaceId)
    const total = snapshot.series.reduce((n, d) => n + d.succeeded + d.failed, 0)
    expect(total).toBe(4)
    const busiest = snapshot.series.find((d) => d.succeeded + d.failed === 3)
    expect(busiest?.succeeded).toBe(2)
    expect(busiest?.failed).toBe(1)
  })

  it('produces six KPIs in a fixed order', async (): Promise<void> => {
    const snapshot = await buildAnalytics(fixture.workspaceId)
    expect(snapshot.kpis.map((k) => k.label)).toEqual([
      'Task success rate',
      'Avg run duration',
      'Spend',
      'Tool calls',
      'Pauses',
      'Active agents',
    ])
  })

  it('shows the unknown mark rather than a rate when nothing has concluded', async (): Promise<void> => {
    const snapshot = await buildAnalytics(fixture.workspaceId)
    expect(snapshot.kpis[0]?.value).toBe('—')
    expect(snapshot.kpis[1]?.value).toBe('—')
  })

  it('reports known spend and says how many runs nobody could measure', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: { agentId: fixture.agentId, status: 'succeeded', provider: 'claude_code', costUsd: 1.5, terminalAt: new Date(), endedAt: new Date() },
    })
    await prisma.agentRun.create({
      data: { agentId: fixture.agentId, status: 'succeeded', provider: 'cursor', costUsd: null, terminalAt: new Date(), endedAt: new Date() },
    })
    const snapshot = await buildAnalytics(fixture.workspaceId)
    const spend = snapshot.kpis.find((k) => k.label === 'Spend')
    expect(spend?.value).toBe('$1.50')
    expect(spend?.note).toBe('1 run unmeasured')
  })

  it('counts pauses from the event log, not from a run column', async (): Promise<void> => {
    const run = await prisma.agentRun.create({ data: { agentId: fixture.agentId, status: 'paused', provider: 'claude_code' } })
    for (let i = 0; i < 2; i += 1) {
      await appendEvent({
        type: 'run.paused',
        workspaceId: fixture.workspaceId,
        agentId: fixture.agentId,
        runId: run.id,
        actor: 'system',
        payload: { atStep: 1 },
      })
    }
    const snapshot = await buildAnalytics(fixture.workspaceId)
    expect(snapshot.kpis.find((k) => k.label === 'Pauses')?.value).toBe('2')
  })

  it('sums an agent tokens only over runs that reported them, and says null when none did', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: { agentId: fixture.agentId, status: 'succeeded', provider: 'claude_code', tokensIn: 10, tokensOut: 90, terminalAt: new Date(), endedAt: new Date() },
    })
    expect((await buildAnalytics(fixture.workspaceId)).perAgent[0]?.tokens).toBe(100)

    await prisma.agentRun.deleteMany({})
    await prisma.agentRun.create({
      data: { agentId: fixture.agentId, status: 'succeeded', provider: 'cursor', tokensIn: null, tokensOut: null, terminalAt: new Date(), endedAt: new Date() },
    })
    expect((await buildAnalytics(fixture.workspaceId)).perAgent[0]?.tokens).toBeNull()
  })

  it('reports a null success rate and duration for an agent with no terminal run', async (): Promise<void> => {
    const row = (await buildAnalytics(fixture.workspaceId)).perAgent[0]
    expect(row?.runs).toBe(0)
    expect(row?.successPct).toBeNull()
    expect(row?.avgDurationMs).toBeNull()
  })

  it('scopes to a workspace, and covers every workspace when given null', async (): Promise<void> => {
    const other = await prisma.workspace.create({
      data: { name: 'Other', repoPath: '/tmp/other', verifyCommands: ['true'], setupCommands: [] },
    })
    const otherTeam = await prisma.team.create({ data: { workspaceId: other.id, name: 'T' } })
    const otherAgent = await prisma.agent.create({ data: { teamId: otherTeam.id, name: 'Bea', role: 'qa' } })
    await prisma.agentRun.create({
      data: { agentId: otherAgent.id, status: 'succeeded', provider: 'claude_code', terminalAt: new Date(), endedAt: new Date() },
    })

    expect((await buildAnalytics(fixture.workspaceId)).perAgent.map((r) => r.name)).toEqual(['Alex'])
    expect((await buildAnalytics(null)).perAgent.map((r) => r.name).sort()).toEqual(['Alex', 'Bea'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/test/integration/analytics.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/server/analytics.js"`.

- [ ] **Step 3: Write `server/analytics.ts`**

```typescript
import { prisma } from '@ai-team-os/db/client'
import { sumSpend, NON_TERMINAL_RUN_STATUSES } from '@ai-team-os/domain'

/**
 * The Analytics page's aggregation (M14 §4.4): one query round per section, all scoped to a
 * workspace, or to every workspace when `workspaceId` is `null` (the global `/analytics` route).
 *
 * **Stated limits, because the page shows figures an operator will act on:**
 * - Skill counts are END-OF-RUN facts (`AgentRun.skillCalls`, M14 §4.1). A run in flight
 *   contributes nothing, so "skills used today" trails the live board by one run.
 * - Token counts are CLAUDE-ONLY. Cursor reports none, and `tokens` is `null` for an agent whose
 *   runs are all on Cursor — not zero.
 * - Cost is KNOWN cost. `unmeasuredRuns` beside it is how many runs really ran, finished, and
 *   left no figure; it is never folded into the total.
 */
export interface DayCount {
  readonly day: string
  readonly succeeded: number
  readonly failed: number
}

export interface Kpi {
  readonly label: string
  readonly value: string
  readonly note: string | null
}

export interface AgentPerformanceRow {
  readonly agentId: string
  readonly name: string
  readonly role: string
  readonly runs: number
  readonly successPct: number | null
  readonly avgDurationMs: number | null
  readonly tokens: number | null
  readonly costUsd: number
  readonly unmeasuredRuns: number
}

export interface AnalyticsSnapshot {
  readonly workspaceId: string | null
  readonly series: readonly DayCount[]
  readonly kpis: readonly Kpi[]
  readonly perAgent: readonly AgentPerformanceRow[]
}

const WINDOW_DAYS = 7

/** `YYYY-MM-DD` in UTC. The day boundary is UTC everywhere in this module — a local boundary would
 *  make the same run land in different buckets for two operators. */
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function windowStart(): Date {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  start.setUTCDate(start.getUTCDate() - (WINDOW_DAYS - 1))
  return start
}

/** `860000` → `14m 20s`; `45000` → `45s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes === 0 ? `${rest}s` : `${minutes}m ${String(rest).padStart(2, '0')}s`
}

export async function buildAnalytics(workspaceId: string | null): Promise<AnalyticsSnapshot> {
  const agentWhere = workspaceId === null ? {} : { team: { workspaceId } }
  const runWhere = workspaceId === null ? {} : { agent: { team: { workspaceId } } }
  const from = windowStart()

  const [agents, windowRuns, allRuns, pauses, liveRuns, tasks] = await Promise.all([
    prisma.agent.findMany({ where: agentWhere, orderBy: { name: 'asc' }, select: { id: true, name: true, role: true } }),
    prisma.agentRun.findMany({
      where: { ...runWhere, terminalAt: { gte: from } },
      select: { status: true, terminalAt: true },
    }),
    prisma.agentRun.findMany({
      where: runWhere,
      select: {
        agentId: true,
        status: true,
        provider: true,
        costUsd: true,
        tokensIn: true,
        tokensOut: true,
        toolCalls: true,
        startedAt: true,
        endedAt: true,
        terminalAt: true,
      },
    }),
    prisma.executionEvent.count({
      where: { type: 'run_paused', ...(workspaceId === null ? {} : { workspaceId }) },
    }),
    prisma.agentRun.count({ where: { ...runWhere, status: { in: [...NON_TERMINAL_RUN_STATUSES] } } }),
    prisma.task.groupBy({
      by: ['status'],
      where: workspaceId === null ? {} : { workspaceId },
      _count: { _all: true },
    }),
  ])

  // ---- the 7-day series ------------------------------------------------------------------
  const byDay = new Map<string, { succeeded: number; failed: number }>()
  for (let i = 0; i < WINDOW_DAYS; i += 1) {
    const day = new Date(from)
    day.setUTCDate(day.getUTCDate() + i)
    byDay.set(dayKey(day), { succeeded: 0, failed: 0 })
  }
  for (const run of windowRuns) {
    if (run.terminalAt === null) continue
    const bucket = byDay.get(dayKey(run.terminalAt))
    if (bucket === undefined) continue
    // `stopped` counts as neither: an operator's cancel is not the system failing, and colouring
    // it red would put the operator's own interventions on the failure line.
    if (run.status === 'succeeded') bucket.succeeded += 1
    else if (run.status === 'failed') bucket.failed += 1
  }
  const series: DayCount[] = [...byDay.entries()].map(([day, counts]) => ({ day, ...counts }))

  // ---- the six KPIs ----------------------------------------------------------------------
  const countOf = (statuses: readonly string[]): number =>
    tasks.filter((t) => statuses.includes(t.status)).reduce((n, t) => n + t._count._all, 0)
  const done = countOf(['done'])
  const failedTasks = countOf(['failed'])
  const successDenominator = done + failedTasks

  const terminalRuns = allRuns.filter((run) => run.terminalAt !== null && run.endedAt !== null)
  const durations = terminalRuns.map((run) => (run.endedAt as Date).getTime() - run.startedAt.getTime()).filter((ms) => ms >= 0)
  const spend = sumSpend(allRuns.map((run) => ({ costUsd: run.costUsd, provider: run.provider, status: run.status })))
  const toolCalls = allRuns.reduce((n, run) => n + run.toolCalls, 0)

  const kpis: readonly Kpi[] = [
    {
      label: 'Task success rate',
      value: successDenominator === 0 ? '—' : `${Math.round((done / successDenominator) * 100)}%`,
      note: successDenominator === 0 ? 'no task has finished yet' : `${done} of ${successDenominator}`,
    },
    {
      label: 'Avg run duration',
      value: durations.length === 0 ? '—' : formatDuration(durations.reduce((a, b) => a + b, 0) / durations.length),
      note: durations.length === 0 ? null : `over ${durations.length} run(s)`,
    },
    {
      label: 'Spend',
      value: `$${spend.known.toFixed(2)}`,
      // Its own line, never folded into the figure (Decision 4): a total that silently absorbs
      // unmeasured runs as zeros presents the measured part of a bill as the whole of it.
      note: spend.unknownRuns === 0 ? null : `${spend.unknownRuns} run${spend.unknownRuns === 1 ? '' : 's'} unmeasured`,
    },
    { label: 'Tool calls', value: String(toolCalls), note: null },
    { label: 'Pauses', value: String(pauses), note: null },
    { label: 'Active agents', value: String(liveRuns), note: null },
  ]

  // ---- per-agent performance -------------------------------------------------------------
  const runsByAgent = new Map<string, typeof allRuns>()
  for (const run of allRuns) {
    const list = runsByAgent.get(run.agentId)
    if (list === undefined) runsByAgent.set(run.agentId, [run])
    else list.push(run)
  }

  const perAgent: readonly AgentPerformanceRow[] = agents.map((agent) => {
    const runs = runsByAgent.get(agent.id) ?? []
    const terminal = runs.filter((run) => run.terminalAt !== null)
    const succeeded = terminal.filter((run) => run.status === 'succeeded').length
    const agentDurations = terminal
      .filter((run) => run.endedAt !== null)
      .map((run) => (run.endedAt as Date).getTime() - run.startedAt.getTime())
      .filter((ms) => ms >= 0)
    const reported = runs.filter((run) => run.tokensIn !== null || run.tokensOut !== null)
    const agentSpend = sumSpend(runs.map((run) => ({ costUsd: run.costUsd, provider: run.provider, status: run.status })))

    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      runs: terminal.length,
      successPct: terminal.length === 0 ? null : Math.round((succeeded / terminal.length) * 100),
      avgDurationMs: agentDurations.length === 0 ? null : agentDurations.reduce((a, b) => a + b, 0) / agentDurations.length,
      // `null` when NO run reported, a sum when some did (Decision 4). A partial sum is still a
      // real measurement of the runs that reported; a zero would be a claim about the ones that
      // did not.
      tokens: reported.length === 0 ? null : reported.reduce((n, run) => n + (run.tokensIn ?? 0) + (run.tokensOut ?? 0), 0),
      costUsd: agentSpend.known,
      unmeasuredRuns: agentSpend.unknownRuns,
    }
  })

  return { workspaceId, series, kpis, perAgent }
}
```

- [ ] **Step 4: Run the test to green**

Run: `npx vitest run apps/web/test/integration/analytics.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/analytics.ts apps/web/test/integration/analytics.test.ts
git commit -m "feat(web): the analytics aggregation, with its unmeasured runs beside its totals"
```

---
## Series C — The Nine Pages

Every task in this series consumes Series A's anatomy and never re-implements it. Every task's
numbers are class-string-only in vitest and computed-style in the gate, per the table at the top
of this plan.

### Task 8 (C1): Overview

**Files:**
- Modify: `apps/web/src/components/TopStrip.tsx` (whole file — the handoff's 6-up strip)
- Modify: `apps/web/src/components/OverviewClient.tsx` (the bottom row; locate by symbol `<main`)
- Modify: `apps/web/src/components/GoalCard.tsx` (waiting caption + suggestion chips)
- Modify: `apps/web/src/server/overview.ts` (`OverviewSnapshot` gains `blocked`, `liveEvents`,
  `mergeQueue`, `goalSuggestions`)
- Test: `apps/web/test/overview-components.test.tsx` (extend)
- Test: `apps/web/test/goal-card.test.tsx` (extend)
- Test: `apps/web/test/integration/overview.test.ts` (extend)
- Test: `apps/web/test/useOverview.test.tsx` (fixture widening only)

**Interfaces:**
- Consumes: `AgentCard` (Task 2), `Panel` with its `action` slot (Task 2), `StatStrip`,
  `PanelHeader`, `CARD_STATE_TONE`.
- Produces:

```typescript
// apps/web/src/server/overview.ts -- OverviewSnapshot gains four members
  /** The "blocked · needs you" panel's contents: blocked tasks, plus every run whose status is
   *  `pause_requested` or `paused` (an operator asked and the answer has not landed, or it has
   *  and nobody resumed). Each carries the action an operator can take from this panel. */
  readonly blocked: readonly {
    readonly kind: 'task' | 'run'
    readonly id: string
    readonly title: string
    readonly detail: string
    /** `'resume'` for a paused run, `null` for anything the panel can only report. */
    readonly action: 'resume' | null
    /** Set only when `action` is non-null. */
    readonly runId: string | null
  }[]
  /** The last 8 events in this workspace, newest first — the 340px live-events panel. */
  readonly liveEvents: readonly { readonly seq: number; readonly ts: string; readonly summary: string }[]
  /** Tasks in `merging`, FIFO by the moment they entered the queue. At most one is actually
   *  merging (the queue is serialized); the rest are waiting. */
  readonly mergeQueue: readonly { readonly id: string; readonly title: string }[]
  /** The last three DISTINCT goals this workspace has been set, newest first, from
   *  `workspace.goal_set` events — the suggestion chips under an empty goal form. Real history,
   *  never invented copy. */
  readonly goalSuggestions: readonly string[]
```

`TopStrip`'s six tiles, in the handoff's order: **agents working · tasks active · tasks ready ·
tasks done · blocked · spend**. `OverviewSnapshot.tasks` gains `ready`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/overview-components.test.tsx` (extend the `snapshot` factory with the
four new members plus `tasks.ready`):

```tsx
describe('TopStrip — the handoff 6-up', () => {
  it('renders six tiles in the README order with 1px gutters', () => {
    render(<TopStrip snapshot={snapshot([agent({ status: 'working' })])} />)
    const tiles = screen.getAllByTestId('strip-tile')
    expect(tiles.map((t) => t.getAttribute('data-strip'))).toEqual([
      'agents-working', 'tasks-active', 'tasks-ready', 'tasks-done', 'blocked', 'spend',
    ])
    expect(screen.getByTestId('strip').className).toContain('gap-px')
    expect(screen.getByTestId('strip').className).toContain('grid-cols-6')
  })

  it('renders spend as known spend, with the unmeasured count as its own line', () => {
    render(<TopStrip snapshot={snapshot([])} />)
    expect(screen.getByTestId('strip-value-spend').textContent).toBe('$3.00')
  })
})

describe('Overview bottom row', () => {
  it('lists a blocked task and offers resume on a paused run', () => {
    const view = {
      ...snapshot([]),
      blocked: [
        { kind: 'task' as const, id: 't1', title: 'Payment provider keys', detail: 'blocked', action: null, runId: null },
        { kind: 'run' as const, id: 'r1', title: 'Alex', detail: 'paused at step 7', action: 'resume' as const, runId: 'r1' },
      ],
    }
    render(<BlockedPanel workspaceId="w1" items={view.blocked} />)
    expect(screen.getAllByTestId('blocked-row')).toHaveLength(2)
    expect(screen.getAllByTestId('blocked-row')[1]?.textContent).toContain('paused at step 7')
    expect(screen.getByTestId('blocked-resume')).toBeTruthy()
  })

  it('renders the 340px live-events panel with an all → action', () => {
    render(<LiveEventsPanel workspaceId="w1" events={[{ seq: 9, ts: '2026-08-29T10:00:00.000Z', summary: 'Alex wrote a.txt' }]} />)
    expect(screen.getByTestId('live-events').className).toContain('w-[340px]')
    expect(screen.getByTestId('panel-header-action').textContent).toBe('all →')
    expect(screen.getAllByTestId('live-event-row')).toHaveLength(1)
  })

  it('gives a new live-events row the rise class and an existing one none', () => {
    const { rerender } = render(<LiveEventsPanel workspaceId="w1" events={[{ seq: 1, ts: '2026-08-29T10:00:00.000Z', summary: 'a' }]} />)
    rerender(
      <LiveEventsPanel
        workspaceId="w1"
        events={[
          { seq: 2, ts: '2026-08-29T10:00:01.000Z', summary: 'b' },
          { seq: 1, ts: '2026-08-29T10:00:00.000Z', summary: 'a' },
        ]}
      />,
    )
    const rows = screen.getAllByTestId('live-event-row')
    expect(rows[0]?.className).toContain('motion-safe:animate-[rise_0.3s_ease-out]')
    expect(rows[1]?.className).not.toContain('animate-[rise')
  })

  it('lists the merge queue FIFO and says nothing when it is empty', () => {
    const { rerender } = render(<MergeQueuePanel queue={[{ id: 't1', title: 'API contract' }, { id: 't2', title: 'Checkout UI' }]} />)
    expect(screen.getAllByTestId('merge-row').map((r) => r.textContent)).toEqual(['API contract', 'Checkout UI'])

    rerender(<MergeQueuePanel queue={[]} />)
    expect(screen.getByTestId('merge-empty').textContent).toBe('nothing in the queue')
  })
})
```

Append to `apps/web/test/goal-card.test.tsx`:

```tsx
  it('captions an unset goal as waiting and offers the last three goals as chips', () => {
    render(<GoalCard workspaceId="w1" goal={null} suggestions={['ship checkout', 'fix fraud rules', 'add SSO']} />)
    expect(screen.getByTestId('goal-waiting').textContent).toBe('waiting for a goal')
    expect(screen.getAllByTestId('goal-suggestion').map((c) => c.textContent)).toEqual(['ship checkout', 'fix fraud rules', 'add SSO'])
  })

  it('fills the input from a clicked suggestion rather than submitting it', () => {
    render(<GoalCard workspaceId="w1" goal={null} suggestions={['ship checkout']} />)
    fireEvent.click(screen.getByTestId('goal-suggestion'))
    expect((screen.getByLabelText('workspace goal') as HTMLInputElement).value).toBe('ship checkout')
  })

  it('shows no chips and no caption once a goal is set', () => {
    render(<GoalCard workspaceId="w1" goal="ship checkout" suggestions={['ship checkout']} />)
    expect(screen.queryByTestId('goal-waiting')).toBeNull()
    expect(screen.queryByTestId('goal-suggestion')).toBeNull()
  })
```

Append to `apps/web/test/integration/overview.test.ts`:

```typescript
  it('lists blocked tasks and paused runs together, with resume offered only on the runs', async (): Promise<void> => {
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'blocked' } })
    const run = await prisma.agentRun.create({
      data: { agentId: fixture.agentId, status: 'paused', pausedAtStep: 7, provider: 'claude_code' },
    })
    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)
    expect(snapshot?.blocked.map((b) => b.kind).sort()).toEqual(['run', 'task'])
    expect(snapshot?.blocked.find((b) => b.kind === 'run')?.action).toBe('resume')
    expect(snapshot?.blocked.find((b) => b.kind === 'run')?.runId).toBe(run.id)
    expect(snapshot?.blocked.find((b) => b.kind === 'task')?.action).toBeNull()
  })

  it('carries the last eight events newest first', async (): Promise<void> => {
    for (let i = 0; i < 12; i += 1) {
      await appendEvent({
        type: 'run.tool_call',
        workspaceId: fixture.workspaceId,
        agentId: fixture.agentId,
        actor: 'agent',
        payload: { name: 'Write', summary: `Write ${i}.txt` },
      })
    }
    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)
    expect(snapshot?.liveEvents).toHaveLength(8)
    expect(snapshot?.liveEvents[0]?.seq).toBeGreaterThan(snapshot?.liveEvents[7]?.seq ?? 0)
  })

  // ERRATUM 2026-08-30 (final review): DEAD reference code -- see the Task 8 ruling. The queue
  // orders by the latest `task_review_approved` `ExecutionEvent.seq`, not by `Approval.decidedAt`.
  it('lists merging tasks FIFO by approval time and counts ready tasks in the strip', async (): Promise<void> => {
    await prisma.task.update({ where: { id: fixture.taskId }, data: { status: 'merging' } })
    const second = await prisma.task.create({
      data: { workspaceId: fixture.workspaceId, title: 'Second', description: 'x', status: 'merging', requiredRole: 'backend', maxAttempts: 3 },
    })
    // Approved in the OPPOSITE order to creation, so this test fails if the queue silently falls
    // back to `createdAt` (design README: FIFO by approval time, not by creation time).
    await prisma.approval.create({ data: { taskId: second.id, approved: true, decidedAt: new Date(Date.now() - 60_000) } })
    await prisma.approval.create({ data: { taskId: fixture.taskId, approved: true, decidedAt: new Date() } })
    await prisma.task.create({
      data: { workspaceId: fixture.workspaceId, title: 'Third', description: 'x', status: 'ready', requiredRole: 'backend', maxAttempts: 3 },
    })
    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)
    expect(snapshot?.mergeQueue.map((t) => t.id)).toEqual([second.id, fixture.taskId])
    expect(snapshot?.tasks.ready).toBe(1)
  })

  it('offers the last three distinct goals as suggestions, newest first', async (): Promise<void> => {
    for (const goal of ['first', 'second', 'first', 'third', 'fourth']) {
      await appendEvent({ type: 'workspace.goal_set', workspaceId: fixture.workspaceId, actor: 'human', payload: { goal } })
    }
    const snapshot = await buildOverviewSnapshot(fixture.workspaceId)
    expect(snapshot?.goalSuggestions).toEqual(['fourth', 'third', 'first'])
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/web/test/overview-components.test.tsx apps/web/test/goal-card.test.tsx apps/web/test/integration/overview.test.ts`
Expected: FAIL — `BlockedPanel` etc. are not exported; `snapshot?.blocked` is `undefined`.

- [ ] **Step 3: Widen `OverviewSnapshot`**

Add the four members above to `OverviewSnapshot` and `ready: number` to its `tasks` object. In
`buildOverviewSnapshot`, add `ready: countOf(['ready'])` to the returned `tasks`, and before the
return:

```typescript
  // The bottom row's three panels, in one round with everything else already loaded.
  const [blockedTasks, pausedRuns, recentForPanel, mergingTasks, goalEvents] = await Promise.all([
    prisma.task.findMany({ where: { workspaceId, status: 'blocked' }, orderBy: { createdAt: 'asc' } }),
    prisma.agentRun.findMany({
      where: { agent: { team: { workspaceId } }, status: { in: ['pause_requested', 'paused'] } },
      orderBy: { startedAt: 'asc' },
      include: { agent: true },
    }),
    prisma.executionEvent.findMany({ where: { workspaceId }, orderBy: { seq: 'desc' }, take: 8 }),
    // ERRATUM 2026-08-30 (final review): DEAD reference code -- see the Task 8 ruling. `Approval`
    // is a dead table; the shipped query reads `task_review_approved` `ExecutionEvent.seq` through
    // `packages/domain/src/merge/queue.ts`'s `mergeQueueOrder`, which `apps/orchestrator/src/merge.ts`
    // shares so the panel and the daemon cannot disagree. A `merging` task with no approval event
    // is listed LAST and marked, not sorted by `createdAt`.
    // FIFO by APPROVAL time (design README "Interactions & Behavior": "at most one task in
    // `merging` at a time, FIFO by approval time"). `Task` carries no `updatedAt`, so the ordering
    // comes from `Approval.decidedAt` -- the moment the review that put this task in the queue was
    // decided. Sorted in JS below rather than in SQL: the order is over a RELATED row's column,
    // and Prisma cannot `orderBy` a to-many relation's field.
    prisma.task.findMany({
      where: { workspaceId, status: 'merging' },
      include: { approvals: { where: { approved: true }, orderBy: { decidedAt: 'desc' }, take: 1 } },
    }),
    prisma.executionEvent.findMany({
      where: { workspaceId, type: 'workspace_goal_set' },
      orderBy: { seq: 'desc' },
      take: 20,
    }),
  ])

  const blocked = [
    ...blockedTasks.map((task) => ({
      kind: 'task' as const,
      id: task.id,
      title: task.title,
      detail: task.lastRejectionReason ?? 'blocked',
      action: null,
      runId: null,
    })),
    ...pausedRuns.map((run) => ({
      kind: 'run' as const,
      id: run.id,
      title: run.agent.name,
      detail: run.status === 'paused' ? `paused at step ${run.pausedAtStep ?? 0}` : 'pause requested',
      // Only a run that has actually landed on `paused` can be resumed -- `requestResume` refuses
      // a `pause_requested` one, and offering a button that always refuses is worse than none.
      action: run.status === 'paused' ? ('resume' as const) : null,
      runId: run.status === 'paused' ? run.id : null,
    })),
  ]

  const seenGoals = new Set<string>()
  const goalSuggestions: string[] = []
  for (const event of goalEvents) {
    const goal = (event.payload as { goal?: string }).goal
    if (typeof goal !== 'string' || seenGoals.has(goal)) continue
    seenGoals.add(goal)
    goalSuggestions.push(goal)
    if (goalSuggestions.length === 3) break
  }
```

and to the returned object:

```typescript
    blocked,
    liveEvents: recentForPanel.map((event) => ({
      seq: Number(event.seq),
      ts: event.ts.toISOString(),
      summary: feedSummary(DOMAIN_EVENT_TYPE_BY_DB_VALUE[event.type] ?? event.type, event.payload as Record<string, unknown>),
    })),
    // ERRATUM 2026-08-30 (final review): DEAD reference code -- see the Task 8 ruling. No
    // `approvals` relation is read; the shipped sort is `mergeQueueOrder` over
    // `task_review_approved` sequence numbers.
    // A task with no approval row yet (one an operator moved by hand) sorts by its own creation
    // time -- last, among tasks that WERE approved, which is where an un-reviewed entry belongs.
    mergeQueue: [...mergingTasks]
      .sort((a, b) => (a.approvals[0]?.decidedAt ?? a.createdAt).getTime() - (b.approvals[0]?.decidedAt ?? b.createdAt).getTime())
      .map((task) => ({ id: task.id, title: task.title })),
    goalSuggestions,
```

- [ ] **Step 4: Rewrite `TopStrip.tsx`**

```tsx
import type { OverviewSnapshot } from '../server/overview'
import { CARD_STATE_TONE } from '../lib/tones'
import { TONE_TEXT, type StatusTone } from './ui/StatusPill'

/** The handoff's 6-up summary strip (design README §3a.1): 1px gutters with the hairline showing
 *  through, `22px` mono numerals at `letter-spacing: -1px`, an 11px label beneath. */
export function TopStrip({ snapshot }: { readonly snapshot: OverviewSnapshot }): React.JSX.Element {
  const working = snapshot.agents.filter((a) => a.status === 'working').length
  const tiles: ReadonlyArray<{ key: string; value: string; label: string; tone?: StatusTone }> = [
    { key: 'agents-working', value: String(working), label: 'agents working', ...(working > 0 ? { tone: CARD_STATE_TONE.working.tone } : {}) },
    { key: 'tasks-active', value: String(snapshot.tasks.active), label: 'tasks active', ...(snapshot.tasks.active > 0 ? { tone: CARD_STATE_TONE.working.tone } : {}) },
    { key: 'tasks-ready', value: String(snapshot.tasks.ready), label: 'tasks ready' },
    { key: 'tasks-done', value: String(snapshot.tasks.done), label: 'tasks done', ...(snapshot.tasks.done > 0 ? { tone: CARD_STATE_TONE.completed.tone } : {}) },
    { key: 'blocked', value: String(snapshot.tasks.blocked), label: 'blocked', ...(snapshot.tasks.blocked > 0 ? { tone: CARD_STATE_TONE.blocked.tone } : {}) },
    { key: 'spend', value: `$${snapshot.workspace.spentUsd.toFixed(2)}`, label: 'spend' },
  ]

  return (
    <section data-testid="strip" className="grid grid-cols-6 gap-px border-b border-line bg-line">
      {tiles.map((tile) => (
        <div key={tile.key} data-testid="strip-tile" data-strip={tile.key} className="flex flex-col gap-[2px] bg-bg-1 px-[15px] py-[13px]">
          <span
            data-testid={`strip-value-${tile.key}`}
            className={`font-mono text-[22px] font-semibold tracking-[-1px] ${tile.tone !== undefined ? TONE_TEXT[tile.tone] : 'text-text-1'}`}
          >
            {tile.value}
          </span>
          <span className="text-[11px] text-text-2">{tile.label}</span>
        </div>
      ))}
    </section>
  )
}
```

- [ ] **Step 5: Add the three bottom-row panels to `OverviewClient.tsx`**

Export them from `OverviewClient.tsx` (the test imports them by name from there):

```tsx
/** The "blocked · needs you" panel (design README §3a.1). Flex-1 beside the fixed 340px events
 *  panel. Resume POSTs to the run route the panel and the card already use — no new endpoint. */
export function BlockedPanel({
  workspaceId,
  items,
}: {
  readonly workspaceId: string
  readonly items: OverviewSnapshot['blocked']
}): React.JSX.Element {
  const [errorText, setErrorText] = useState<string | null>(null)
  return (
    <div className="min-w-0 flex-1">
      <Panel title="blocked · needs you">
        {items.length === 0 ? (
          <p data-testid="blocked-empty" className="text-xs text-text-3">
            nothing needs you
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={`${item.kind}-${item.id}`} data-testid="blocked-row" className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-text-1">{item.title}</span>
                <span className="shrink-0 font-mono text-[10px] text-text-3">{item.detail}</span>
                {item.action === 'resume' && item.runId !== null && (
                  <Button
                    variant="ghost"
                    data-testid="blocked-resume"
                    onClick={() => {
                      void postControl(`/api/w/${workspaceId}/runs/${item.runId}/resume`).then((result) => {
                        if (!result.ok) setErrorText(result.error)
                      })
                    }}
                  >
                    resume
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {errorText !== null && (
          <span role="alert" data-testid="blocked-error" className="text-xs text-status-danger">
            {errorText}
          </span>
        )}
      </Panel>
    </div>
  )
}

/** The 340px live-events panel with the handoff's `all →` action. New rows rise (0.3s from
 *  `translateY(5px)`) — M11's deferred "new-row rise", landed here. A row is "new" when its seq
 *  is above the highest this component had rendered before; a ref, not state, because the class
 *  is decided at the row's own first render and no re-render is needed to pick it up. */
export function LiveEventsPanel({
  workspaceId,
  events,
}: {
  readonly workspaceId: string
  readonly events: OverviewSnapshot['liveEvents']
}): React.JSX.Element {
  const highestSeenRef = useRef<number>(events[0]?.seq ?? -Infinity)
  const boundary = highestSeenRef.current
  if ((events[0]?.seq ?? -Infinity) > highestSeenRef.current) highestSeenRef.current = events[0]?.seq ?? highestSeenRef.current

  return (
    <div data-testid="live-events" className="w-[340px] shrink-0">
      <Panel title="live events" action={<Link href={`/w/${workspaceId}/activity`}>all →</Link>}>
        {events.length === 0 ? (
          <p className="text-xs text-text-3">no events yet</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {events.map((event) => (
              <li
                key={event.seq}
                data-testid="live-event-row"
                className={`flex items-baseline gap-2 font-mono text-[10.5px] text-text-2 ${
                  event.seq > boundary ? 'motion-safe:animate-[rise_0.3s_ease-out]' : ''
                }`}
              >
                <span className="shrink-0 text-text-3">{event.ts.slice(11, 19)}</span>
                <span className="min-w-0 truncate">{event.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

/** The merge queue, serialized and FIFO (design README "Interactions & Behavior"). */
export function MergeQueuePanel({ queue }: { readonly queue: OverviewSnapshot['mergeQueue'] }): React.JSX.Element {
  return (
    <Panel title="merge queue · serial">
      {queue.length === 0 ? (
        <p data-testid="merge-empty" className="text-xs text-text-3">
          nothing in the queue
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {queue.map((task) => (
            <li key={task.id} data-testid="merge-row" className="truncate text-xs text-text-1">
              {task.title}
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}
```

and render them under the card grid inside `OverviewClient`:

```tsx
        <main className="grid grid-cols-1 gap-[11px] px-[20px] pt-[16px] md:grid-cols-2 xl:grid-cols-3">
          {view.agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} liveActionLine={actionLines[agent.id] ?? null} workspaceId={workspaceId} onOpen={selectAgent} />
          ))}
        </main>
        <div className="flex gap-[11px] px-[20px] pb-[20px] pt-[16px]">
          <BlockedPanel workspaceId={workspaceId} items={view.blocked} />
          <LiveEventsPanel workspaceId={workspaceId} events={view.liveEvents} />
        </div>
        <div className="px-[20px] pb-[20px]">
          <MergeQueuePanel queue={view.mergeQueue} />
        </div>
```

and pass `suggestions={view.goalSuggestions}` to `<GoalCard>`.

- [ ] **Step 6: Give `GoalCard` its caption and chips**

Add `readonly suggestions: readonly string[]` to `GoalCard`'s props. In the unset-goal branch,
above the form:

```tsx
      <p data-testid="goal-waiting" className="text-xs text-text-3">
        waiting for a goal
      </p>
```

and below it, when `suggestions.length > 0`:

```tsx
      <div className="flex flex-wrap gap-1">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            data-testid="goal-suggestion"
            onClick={() => setDraft(suggestion)}
            className="rounded-chip border border-line bg-bg-2 px-2 py-0.5 text-xs text-text-2 transition-colors hover:border-white/20 hover:text-text-1"
          >
            {suggestion}
          </button>
        ))}
      </div>
```

The set-goal branch renders neither — it returns early, above these.

- [ ] **Step 7: Widen the two other snapshot fixtures**

`apps/web/test/useOverview.test.tsx`'s literal `OverviewSnapshot` gains
`blocked: [], liveEvents: [], mergeQueue: [], goalSuggestions: []` and `ready: 0` inside `tasks`.
`shell.test.tsx` and `tasks-components.test.tsx` build `TasksSnapshot`, not this one — untouched.

- [ ] **Step 8: Run the tests to green**

Run: `npx vitest run apps/web/test/overview-components.test.tsx apps/web/test/goal-card.test.tsx apps/web/test/useOverview.test.tsx apps/web/test/integration/overview.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/TopStrip.tsx apps/web/src/components/OverviewClient.tsx apps/web/src/components/GoalCard.tsx apps/web/src/server/overview.ts apps/web/test/overview-components.test.tsx apps/web/test/goal-card.test.tsx apps/web/test/useOverview.test.tsx apps/web/test/integration/overview.test.ts
git commit -m "feat(web): Overview answers who is working and who needs you, in one screen"
```

---

### Task 9 (C2): Agents

**Files:**
- Modify: `apps/web/src/components/WorkersTable.tsx` (whole file — the handoff's seven columns)
- Modify: `apps/web/src/components/AgentsClient.tsx` (row click opens `AgentPanel`)
- Modify: `apps/web/src/server/org.ts` (`WorkerRow` gains `department`, `provider`, `gate`,
  `tokens`, `costUsd`, `progressPct`; locate by symbol `interface WorkerRow` and `listWorkers`)
- Test: `apps/web/test/agents-page.test.tsx` (extend)
- Test: `apps/web/test/integration/server-org.test.ts` (extend — owns `listWorkers` assertions)

**Interfaces:**
- Consumes: `AvatarTile`, `StatusPill` with `pulse`, `ProgressBar`, `DataTable`/`Row`,
  `ShellOnlyMark`, `cardStateForAgent`, `CARD_STATE_TONE`.
- Produces:

```typescript
// apps/web/src/server/org.ts -- WorkerRow gains six fields
  /** The worker's team name — the handoff's "department" column. */
  readonly department: string
  /** The worker's LIVE run's provider, `null` with no live run (the `AgentCardData.provider`
   *  rule, verbatim: a runtime is not decided until a run resolves it). */
  readonly provider: ProviderKind | null
  readonly gate: WorkerGate | null
  /** `tokensIn + tokensOut` summed over this worker's runs that reported them; `null` when none
   *  did (M14 Decision 4 — Cursor reports none, and `0` would be a claim). */
  readonly tokens: number | null
  /** KNOWN spend across this worker's runs. */
  readonly costUsd: number
  readonly unmeasuredRuns: number
```

`CurrentTask` already carries `{ title, pct }`; the table's inline `ProgressBar` reads `pct`.

**The grid template, verbatim:** `'200px 130px 120px 1fr 110px 90px 80px'` — written as a module
constant and passed to `DataTable`/`Row`, which set it as an INLINE `gridTemplateColumns`, so
vitest can read `el.style.gridTemplateColumns` exactly and the gate can read
`getComputedStyle(el).gridTemplateColumns`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/agents-page.test.tsx` (widen the existing `workerRow` factory with
`department: 'Engineering', provider: null, gate: null, tokens: null, costUsd: 0, unmeasuredRuns: 0`):

```tsx
describe('WorkersTable — the handoff seven columns', () => {
  it('uses the README grid template on the header and every row', () => {
    render(<WorkersTable initial={[workerRow({})]} onOpen={() => {}} />)
    const expected = '200px 130px 120px 1fr 110px 90px 80px'
    expect(screen.getByTestId('data-table-header').style.gridTemplateColumns).toBe(expected)
    expect(screen.getByTestId('data-table-row').style.gridTemplateColumns).toBe(expected)
  })

  it('names the seven columns in the README order', () => {
    render(<WorkersTable initial={[workerRow({})]} onOpen={() => {}} />)
    expect(screen.getAllByTestId('data-table-header-cell').map((c) => c.textContent)).toEqual([
      'Agent', 'Department', 'Status', 'Current task', 'Provider', 'Tokens', 'Cost',
    ])
  })

  it('renders an avatar tile, the department, and the status pill from the tone table', () => {
    render(<WorkersTable initial={[workerRow({ name: 'Alex Turner', department: 'Engineering', status: 'working' })]} onOpen={() => {}} />)
    expect(screen.getByTestId('avatar-tile').textContent).toBe('AT')
    expect(screen.getByTestId('worker-department').textContent).toBe('Engineering')
    expect(screen.getByTestId('status-pill').textContent).toBe('WORKING')
  })

  it('renders the current task with an inline progress bar, and — when there is none', () => {
    const { rerender } = render(
      <WorkersTable initial={[workerRow({ currentTask: { title: 'Add the thing', pct: 40 } })]} onOpen={() => {}} />,
    )
    expect(screen.getByTestId('progress-bar-fill').style.width).toBe('40%')

    rerender(<WorkersTable initial={[workerRow({ currentTask: null })]} onOpen={() => {}} />)
    expect(screen.getByTestId('worker-task').textContent).toBe('—')
  })

  it('renders tokens and cost, with the unknown mark where nothing was measured', () => {
    const { rerender } = render(<WorkersTable initial={[workerRow({ tokens: 1_400_000, costUsd: 3.02 })]} onOpen={() => {}} />)
    expect(screen.getByTestId('worker-tokens').textContent).toBe('1.4M')
    expect(screen.getByTestId('worker-cost').textContent).toBe('$3.02')

    rerender(<WorkersTable initial={[workerRow({ tokens: null, costUsd: 0 })]} onOpen={() => {}} />)
    expect(screen.getByTestId('worker-tokens').textContent).toBe('—')
  })

  it('marks a shell-only gate beside the provider, and nothing for a runtime that gates every tool', () => {
    const { rerender } = render(<WorkersTable initial={[workerRow({ provider: 'cursor', gate: 'shell-only' })]} onOpen={() => {}} />)
    expect(screen.getByTestId('shell-only-mark')).toBeTruthy()

    rerender(<WorkersTable initial={[workerRow({ provider: 'claude_code', gate: 'all-tools' })]} onOpen={() => {}} />)
    expect(screen.queryByTestId('shell-only-mark')).toBeNull()
  })

  it('opens the agent panel on a row click', () => {
    const onOpen = vi.fn()
    render(<WorkersTable initial={[workerRow({ agentId: 'a9' })]} onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId('worker-row-button'))
    expect(onOpen).toHaveBeenCalledWith('a9')
  })
})
```

Append to `apps/web/test/integration/server-org.test.ts`:

```typescript
  it('carries the team name as the department, and the live run provider', async (): Promise<void> => {
    // Use this file's own seed helpers for the workspace/team/agent; the assertion is the point.
    const workers = await listWorkers()
    expect(workers[0]?.department).toBe('Engineering')
    expect(workers[0]?.provider).toBeNull()
  })

  it('sums tokens only over runs that reported them, and says null when none did', async (): Promise<void> => {
    const workers = await listWorkers()
    expect(workers[0]?.tokens).toBeNull()
  })
```

Extend those two with the file's existing fixture pattern to create runs carrying
`tokensIn`/`tokensOut` and a `provider`, asserting `tokens === tokensIn + tokensOut` and
`provider === 'claude_code'` for a live run.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/web/test/agents-page.test.tsx apps/web/test/integration/server-org.test.ts`
Expected: FAIL — `expected '1fr 130px 1fr 120px 1fr' to be '200px 130px 120px 1fr 110px 90px 80px'`.

- [ ] **Step 3: Widen `WorkerRow` and `listWorkers`**

Add the six fields to `WorkerRow`. In `listWorkers`, the `agents` query already includes
`team: { include: { workspace: true } }`; add a second query and fold it in:

```typescript
  const runs = await prisma.agentRun.findMany({
    where: { agentId: { in: agents.map((a) => a.id) } },
    select: { agentId: true, status: true, provider: true, costUsd: true, tokensIn: true, tokensOut: true, startedAt: true },
    orderBy: { startedAt: 'desc' },
  })
  const runsByAgent = new Map<string, typeof runs>()
  for (const run of runs) {
    const list = runsByAgent.get(run.agentId)
    if (list === undefined) runsByAgent.set(run.agentId, [run])
    else list.push(run)
  }
```

and in the returned object per agent:

```typescript
      department: agent.team.name,
      // The LIVE run's provider, not the newest run's: a worker's runtime is a fact about what is
      // running now, and a finished run's provider would keep naming a runtime after the agent
      // went idle. `null` with no live run, exactly as `AgentCardData.provider` is.
      provider: liveProvider,
      gate: liveProvider === null ? null : capabilitiesOf(liveProvider).gate,
      tokens: reported.length === 0 ? null : reported.reduce((n, r) => n + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0),
      costUsd: spendOf(agentRuns).spend,
      unmeasuredRuns: spendOf(agentRuns).unmeasuredRuns,
```

where `agentRuns = runsByAgent.get(agent.id) ?? []`,
`reported = agentRuns.filter((r) => r.tokensIn !== null || r.tokensOut !== null)`, and
`liveProvider = agentRuns.find((r) => (NON_TERMINAL_RUN_STATUSES as readonly string[]).includes(r.status))?.provider ?? null`.

- [ ] **Step 4: Rewrite `WorkersTable.tsx`**

```tsx
'use client'

import { useEffect, useState } from 'react'
import { CARD_STATE_TONE, cardStateForAgent } from '../lib/tones'
import type { WorkerRow } from '../server/org'
import type { AgentStatus } from '@ai-team-os/domain'
import { ShellOnlyMark } from './ShellOnlyMark'
import { AvatarTile } from './ui/AvatarTile'
import { DataTable, Row } from './ui/DataTable'
import { ProgressBar } from './ui/ProgressBar'
import { StatusPill } from './ui/StatusPill'

/** The design README §3a.2 grid template, verbatim. Passed to `DataTable`/`Row`, which write it
 *  as an inline `gridTemplateColumns` — so the gate can read the exact string back off the DOM. */
const COLUMNS = '200px 130px 120px 1fr 110px 90px 80px'
const HEADER = ['Agent', 'Department', 'Status', 'Current task', 'Provider', 'Tokens', 'Cost'] as const

/** `1_400_000` → `1.4M`; `900` → `900`. The handoff's own token format. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

export function WorkersTable({
  initial,
  onOpen,
}: {
  readonly initial: readonly WorkerRow[]
  readonly onOpen: (agentId: string) => void
}): React.JSX.Element {
  const [workers, setWorkers] = useState<readonly WorkerRow[]>(initial)

  useEffect(() => {
    setWorkers(initial)
  }, [initial])

  useEffect(() => {
    async function poll(): Promise<void> {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const response = await fetch('/api/org/workers')
        if (!response.ok) return
        const data = (await response.json()) as { readonly workers: readonly WorkerRow[] }
        setWorkers(data.workers)
      } catch {
        // best-effort refresh -- keep showing the last known snapshot on a transient failure
      }
    }
    const id = setInterval(() => void poll(), 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <DataTable columns={COLUMNS} header={[...HEADER]}>
      {workers.map((worker) => {
        const state = cardStateForAgent(worker.status as AgentStatus)
        const { tone, label, pulse } = CARD_STATE_TONE[state]
        return (
          <Row key={worker.agentId} columns={COLUMNS}>
            <button
              type="button"
              data-testid="worker-row-button"
              onClick={() => onOpen(worker.agentId)}
              className="flex min-w-0 items-center gap-[9px] text-left"
            >
              <AvatarTile name={worker.name} tone={tone} />
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] font-semibold text-text-1">{worker.name}</span>
                <span className="block truncate text-[10px] text-[#7c8697]">{worker.role}</span>
              </span>
            </button>
            <span data-testid="worker-department" className="truncate text-[11.5px] text-text-2">
              {worker.department}
            </span>
            <StatusPill tone={tone} label={label} pulse={pulse} />
            <div data-testid="worker-task" className="min-w-0 pr-[14px]">
              {worker.currentTask === null ? (
                <span className="text-xs text-text-3">—</span>
              ) : (
                <>
                  <span className="block truncate text-[11.5px] text-[#c8cfda]">{worker.currentTask.title}</span>
                  <ProgressBar pct={worker.currentTask.pct} tone={tone} />
                </>
              )}
            </div>
            <span className="flex items-center gap-1 font-mono text-[11px] text-text-2">
              <span data-testid="worker-provider">{worker.provider ?? '—'}</span>
              <ShellOnlyMark gate={worker.gate ?? null} />
            </span>
            <span data-testid="worker-tokens" className="font-mono text-[11px] text-[#7c8697]">
              {worker.tokens === null ? '—' : formatTokens(worker.tokens)}
            </span>
            <span data-testid="worker-cost" className="font-mono text-[11px] text-text-1">
              ${worker.costUsd.toFixed(2)}
            </span>
          </Row>
        )
      })}
    </DataTable>
  )
}
```

- [ ] **Step 5: Wire the row click to `AgentPanel` in `AgentsClient`**

`AgentsClient` holds a `selectedAgentId` and renders `<AgentPanel>` when set. The panel needs an
`AgentCardData`, which the Agents page does not have — fetch it lazily:

```tsx
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [panelAgent, setPanelAgent] = useState<AgentCardData | null>(null)
  const [panelWorkspaceId, setPanelWorkspaceId] = useState<string | null>(null)

  useEffect((): void => {
    if (selectedAgentId === null) {
      setPanelAgent(null)
      return
    }
    const worker = workers.find((w) => w.agentId === selectedAgentId)
    if (worker === undefined) return
    setPanelWorkspaceId(worker.workspaceId)
    // The panel renders from the OVERVIEW snapshot of the agent's own workspace — the one place
    // an `AgentCardData` is built. Fetching it here rather than widening `WorkerRow` into an
    // `AgentCardData` keeps one builder for that shape.
    void fetch(`/api/w/${worker.workspaceId}/overview`)
      .then(async (response) => (response.ok ? ((await response.json()) as OverviewSnapshot) : null))
      .then((snapshot) => setPanelAgent(snapshot?.agents.find((a) => a.id === selectedAgentId) ?? null))
      .catch(() => setPanelAgent(null))
  }, [selectedAgentId, workers])
```

and render `{panelAgent !== null && panelWorkspaceId !== null && <AgentPanel key={panelAgent.id} agent={panelAgent} liveEvents={[]} workspaceId={panelWorkspaceId} haltedReason={null} onClose={() => setSelectedAgentId(null)} />}`.
`WorkersTable` gets `onOpen={setSelectedAgentId}`; `RosterTable` is untouched.

- [ ] **Step 6: Run the tests to green**

Run: `npx vitest run apps/web/test/agents-page.test.tsx apps/web/test/integration/server-org.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/WorkersTable.tsx apps/web/src/components/AgentsClient.tsx apps/web/src/server/org.ts apps/web/test/agents-page.test.tsx apps/web/test/integration/server-org.test.ts
git commit -m "feat(web): the Agents table is the handoff's seven columns, on real tokens and cost"
```

---

### Task 10 (C3): Tasks

**Files:**
- Create: `apps/web/src/lib/taskColumns.ts`
- Modify: `apps/web/src/components/TasksClient.tsx` (six columns, from the new table)
- Modify: `apps/web/src/components/TaskColumn.tsx` (labelled column head + dot + count)
- Modify: `apps/web/src/components/TaskCard.tsx` (the handoff's compact card)
- Test: `apps/web/test/taskColumns.test.ts` (create)
- Test: `apps/web/test/tasks-components.test.tsx` (extend)

**Interfaces:**
- Produces:

```typescript
// apps/web/src/lib/taskColumns.ts
export type BoardColumn = 'Backlog' | 'Todo' | 'In Progress' | 'Review' | 'Blocked' | 'Done'

/** The six columns in the handoff's order (design README §3a.3). */
export const BOARD_COLUMNS: readonly BoardColumn[]

/** Every `TaskStatus` on exactly one column — exhaustive, so a thirteenth status is a build
 *  error rather than an invisible task. */
export const COLUMN_FOR_STATUS: Record<TaskStatus, BoardColumn>

/**
 * The `CardState` each column reads as. NOT a second tone table: `lib/tones.ts`'s
 * `CARD_STATE_TONE` stays the ONE place a tone, a label or a pulse is assigned (spec Decision 2),
 * and this maps a column onto a state so the dot's colour comes from there —
 * `CARD_STATE_TONE[COLUMN_STATE[column]].tone`.
 */
export const COLUMN_STATE: Record<BoardColumn, CardState>

/** `1` → `LOW`, `2` → `MED`, `3` → `HIGH`, `4+` → `URGENT`; the chip's tone alongside. */
export function priorityChip(priority: number): { readonly label: string; readonly tone: StatusTone }
```

- [ ] **Step 1: Write the failing table test**

```typescript
// apps/web/test/taskColumns.test.ts
import { describe, expect, it } from 'vitest'
import type { TaskStatus } from '@ai-team-os/domain'
import { CARD_STATE_TONE } from '../src/lib/tones.js'
import { BOARD_COLUMNS, COLUMN_FOR_STATUS, COLUMN_STATE, priorityChip } from '../src/lib/taskColumns.js'

const ALL_STATUSES: readonly TaskStatus[] = [
  'backlog', 'ready', 'blocked', 'assigned', 'running',
  'verifying', 'reviewing', 'merging', 'rework', 'done', 'failed', 'cancelled',
]

describe('the board columns', () => {
  it('are the README six, in its order', () => {
    expect(BOARD_COLUMNS).toEqual(['Backlog', 'Todo', 'In Progress', 'Review', 'Blocked', 'Done'])
  })

  it('maps every status exactly as the spec §5.3 table says', () => {
    expect(COLUMN_FOR_STATUS).toEqual({
      backlog: 'Backlog',
      ready: 'Todo',
      // `rework` is a verify failure with attempts remaining — work that is queued again, so it
      // reads as Todo. The card still shows its own `rework` pill.
      rework: 'Todo',
      assigned: 'In Progress',
      running: 'In Progress',
      verifying: 'In Progress',
      reviewing: 'Review',
      merging: 'Review',
      blocked: 'Blocked',
      done: 'Done',
      failed: 'Done',
      cancelled: 'Done',
    })
  })

  it('covers every TaskStatus and lands only on the six columns', () => {
    for (const status of ALL_STATUSES) {
      expect(BOARD_COLUMNS).toContain(COLUMN_FOR_STATUS[status])
    }
    expect(Object.keys(COLUMN_FOR_STATUS).sort()).toEqual([...ALL_STATUSES].sort())
  })

  it('resolves every column tone through the one tone table, never its own', () => {
    for (const column of BOARD_COLUMNS) {
      // The assertion that matters is that the state is a KEY of `CARD_STATE_TONE` — i.e. that
      // `lib/tones.ts` is still the only place a colour is chosen.
      expect(Object.keys(CARD_STATE_TONE)).toContain(COLUMN_STATE[column])
    }
    expect(CARD_STATE_TONE[COLUMN_STATE['In Progress']].tone).toBe('working')
    expect(CARD_STATE_TONE[COLUMN_STATE.Done].tone).toBe('done')
  })
})

describe('priorityChip', () => {
  it.each([
    [1, 'LOW'],
    [2, 'MED'],
    [3, 'HIGH'],
    [4, 'URGENT'],
    [9, 'URGENT'],
  ])('renders priority %i as %s', (priority, label) => {
    expect(priorityChip(priority).label).toBe(label)
  })

  it('escalates the tone with the priority', () => {
    expect(priorityChip(1).tone).toBe('idle')
    expect(priorityChip(3).tone).toBe('waiting')
    expect(priorityChip(4).tone).toBe('blocked')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/test/taskColumns.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/taskColumns.js"`.

- [ ] **Step 3: Write `lib/taskColumns.ts`**

```typescript
import type { TaskStatus } from '@ai-team-os/domain'
import type { StatusTone } from '../components/ui/StatusPill'
import type { CardState } from './tones'

export type BoardColumn = 'Backlog' | 'Todo' | 'In Progress' | 'Review' | 'Blocked' | 'Done'

/** The design README §3a.3's six columns, in its order. */
export const BOARD_COLUMNS: readonly BoardColumn[] = ['Backlog', 'Todo', 'In Progress', 'Review', 'Blocked', 'Done']

/**
 * Every `TaskStatus` on exactly one column (spec §5.3). `Record<TaskStatus, BoardColumn>` is
 * load-bearing: a thirteenth status added to the domain fails the BUILD here rather than becoming
 * a task nobody can see on any column.
 *
 * `failed` and `cancelled` share the `Done` column with `done` and carry their own pill on the
 * card — the board's columns are phases, and both of those are the end of one.
 */
export const COLUMN_FOR_STATUS: Record<TaskStatus, BoardColumn> = {
  backlog: 'Backlog',
  ready: 'Todo',
  rework: 'Todo',
  assigned: 'In Progress',
  running: 'In Progress',
  verifying: 'In Progress',
  reviewing: 'Review',
  merging: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Done',
  cancelled: 'Done',
}

/**
 * The `CardState` each column reads as — the source of its 5px head dot (design README §3a.3).
 *
 * Deliberately a state, not a tone: `lib/tones.ts`'s `CARD_STATE_TONE` is the ONE table that
 * assigns a tone, a label and a pulse (Decision 2, "anatomy is written once"), and a second
 * `Record<BoardColumn, StatusTone>` here would be a second place for the palette to drift. Every
 * consumer reads `CARD_STATE_TONE[COLUMN_STATE[column]].tone`.
 */
export const COLUMN_STATE: Record<BoardColumn, CardState> = {
  Backlog: 'idle',
  Todo: 'planning',
  'In Progress': 'working',
  Review: 'review',
  Blocked: 'blocked',
  Done: 'completed',
}

/** `Task.priority` is an integer; the handoff's card shows a word. Four buckets, escalating tone.
 *  Anything above 4 is still `URGENT` — there is no fifth word to reach for. */
export function priorityChip(priority: number): { readonly label: string; readonly tone: StatusTone } {
  if (priority >= 4) return { label: 'URGENT', tone: 'blocked' }
  if (priority === 3) return { label: 'HIGH', tone: 'waiting' }
  if (priority === 2) return { label: 'MED', tone: 'idle' }
  return { label: 'LOW', tone: 'idle' }
}
```

- [ ] **Step 4: Write the failing board tests**

Append to `apps/web/test/tasks-components.test.tsx`:

```tsx
describe('the six-column board', () => {
  it('renders six columns in the README order with a dot and a count each', () => {
    render(<TasksClient workspaceId="w1" initial={snapshot([task({ status: 'running' }), task({ id: 't2', status: 'blocked' })])} />)
    expect(screen.getAllByTestId('column').map((c) => c.getAttribute('data-column'))).toEqual([
      'Backlog', 'Todo', 'In Progress', 'Review', 'Blocked', 'Done',
    ])
    expect(screen.getByTestId('column-count-In Progress').textContent).toBe('1')
    expect(screen.getByTestId('column-count-Blocked').textContent).toBe('1')
    expect(screen.getByTestId('column-dot-Blocked').getAttribute('data-tone')).toBe('blocked')
  })

  it('renders the compact card: mono id, priority chip, title, assignee chip, step counter', () => {
    render(
      <TaskCard
        task={task({ id: '3f9a21c8-0000-4000-8000-000000000000', title: 'Implement Checkout API', priority: 3, assigneeName: 'Alex Turner', status: 'running' })}
        onSelect={() => {}}
      />,
    )
    expect(screen.getByTestId('task-ref').textContent).toBe('TASK-3f9a21c8')
    expect(screen.getByTestId('task-priority').textContent).toBe('HIGH')
    expect(screen.getByTestId('task-title').textContent).toBe('Implement Checkout API')
    expect(screen.getByTestId('avatar-tile').textContent).toBe('AT')
    expect(screen.getByTestId('task-step').textContent).toBe('1/3')
  })

  it('says unassigned rather than showing an empty avatar', () => {
    render(<TaskCard task={task({ assigneeName: null })} onSelect={() => {}} />)
    expect(screen.getByTestId('task-assignee').textContent).toBe('unassigned')
    expect(screen.queryByTestId('avatar-tile')).toBeNull()
  })

  it('keeps a failed task on Done while its own pill still says failed', () => {
    render(<TasksClient workspaceId="w1" initial={snapshot([task({ status: 'failed' })])} />)
    expect(screen.getByTestId('column-count-Done').textContent).toBe('1')
    expect(screen.getByTestId('status-pill').textContent).toBe('BLOCKED')
  })
})
```

Use this file's own `task`/`snapshot` fixture factories.

- [ ] **Step 5: Run them to verify they fail**

Run: `npx vitest run apps/web/test/tasks-components.test.tsx`
Expected: FAIL — the board renders eight `column-<status>` test ids, not six `data-column` ones.

- [ ] **Step 6: Rewrite the three board components**

`TasksClient.tsx` — delete `BoardColumnStatus`, `BOARD_COLUMNS` and `BOARD_COLUMN_FOR_STATUS`
(now in `lib/taskColumns.ts`), import `BOARD_COLUMNS` and `COLUMN_FOR_STATUS` from there, and
render:

```tsx
        <main className="grid grid-cols-6 gap-[10px] p-[16px]">
          {BOARD_COLUMNS.map((column) => (
            <TaskColumn
              key={column}
              column={column}
              tasks={view.tasks.filter((task) => COLUMN_FOR_STATUS[task.status] === column)}
              onSelect={setSelectedId}
            />
          ))}
        </main>
```

`TaskColumn.tsx`:

```tsx
import { COLUMN_STATE, type BoardColumn } from '../lib/taskColumns'
import { CARD_STATE_TONE } from '../lib/tones'
import type { TaskBoardItem } from '../server/tasks'
import { TaskCard } from './TaskCard'
import { TONE_DOT } from './ui/StatusPill'

export function TaskColumn({
  column,
  tasks,
  onSelect,
}: {
  readonly column: BoardColumn
  readonly tasks: readonly TaskBoardItem[]
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  // One tone table (Decision 2): the column's state, then that state's tone. Never a colour
  // chosen here.
  const tone = CARD_STATE_TONE[COLUMN_STATE[column]].tone
  return (
    <div data-testid="column" data-column={column} className="flex min-w-0 flex-col gap-2">
      <header className="flex items-center gap-[7px] border-b border-line pb-[7px]">
        <span data-testid={`column-dot-${column}`} data-tone={tone} className={`h-[5px] w-[5px] rounded-full ${TONE_DOT[tone]}`} />
        {/* An `<h2>`, not `SectionLabel`'s `<div>`: `tasks-components.test.tsx` reaches these by
          * `getAllByRole('heading', { level: 2 })`, and the recipe is the same 9.5px mono. */}
        <h2 className="font-mono text-[9.5px] font-medium uppercase tracking-[.06em] text-text-2">{column}</h2>
        <span data-testid={`column-count-${column}`} className="font-mono text-[9.5px] text-text-3">
          {tasks.length}
        </span>
      </header>
      <div className="flex flex-col gap-2">
        {tasks.map((task) => (
          <TaskCard key={task.id} task={task} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}
```

`TaskCard.tsx` — keep the three exported status maps (`OrgNodes.tsx` imports
`TASK_STATUS_FLASH_COLOR`), and replace the card body:

```tsx
export function TaskCard({
  task,
  onSelect,
}: {
  readonly task: TaskBoardItem
  readonly onSelect: (id: string) => void
}): React.JSX.Element {
  const priority = priorityChip(task.priority)
  const state = cardStateFor('idle', task.status)
  const { tone, label, pulse } = CARD_STATE_TONE[state]

  return (
    <button
      type="button"
      data-testid="task-card"
      data-status={task.status}
      onClick={() => onSelect(task.id)}
      className={`flex w-full flex-col gap-1 rounded-tile border bg-[#0f1116] p-[10px] text-left transition-colors hover:border-white/[0.22] ${
        task.status === 'blocked' ? 'border-tone-blocked/30' : 'border-line'
      }`}
    >
      <span className="flex items-baseline gap-[7px]">
        <span data-testid="task-ref" className="font-mono text-[9.5px] font-medium text-text-3">
          TASK-{task.id.slice(0, 8)}
        </span>
        <span data-testid="task-priority" className={`font-mono text-[9px] font-medium ${TONE_TEXT[priority.tone]}`}>
          {priority.label}
        </span>
        <span className="ml-auto">
          <StatusPill tone={tone} label={label} pulse={pulse} />
        </span>
      </span>
      <span data-testid="task-title" className="text-[11.5px] leading-[1.35] text-[#dbe1ea]">
        {task.title}
      </span>
      <span className="mt-[8px] flex items-center gap-[6px]">
        {task.assigneeName === null ? (
          <span data-testid="task-assignee" className="text-[10px] text-[#7c8697]">
            unassigned
          </span>
        ) : (
          <>
            <AvatarTile name={task.assigneeName} tone={tone} />
            <span data-testid="task-assignee" className="truncate text-[10px] text-[#7c8697]">
              {task.assigneeName}
            </span>
          </>
        )}
        <span data-testid="task-step" className="ml-auto font-mono text-[9.5px] text-text-3">
          {task.attempt}/{task.maxAttempts}
        </span>
      </span>
    </button>
  )
}
```

- [ ] **Step 7: Run the tests to green**

Run: `npx vitest run apps/web/test/taskColumns.test.ts apps/web/test/tasks-components.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/taskColumns.ts apps/web/src/components/TasksClient.tsx apps/web/src/components/TaskColumn.tsx apps/web/src/components/TaskCard.tsx apps/web/test/taskColumns.test.ts apps/web/test/tasks-components.test.tsx
git commit -m "feat(web): six columns, one exhaustive mapping table, and the handoff's compact card"
```

---
### Task 11 (C4): Graph — the cable edge and the 352px drawer

**Files:**
- Create: `apps/web/src/components/graph/CableEdge.tsx`
- Create: `apps/web/src/components/graph/ExecutionNodes.tsx`
- Create: `apps/web/src/components/graph/GraphDrawer.tsx`
- Modify: `apps/web/src/components/graph/GraphCanvas.tsx` (register `edgeTypes`, the canvas
  surface, the dot grid and the teal wash)
- Modify: `apps/web/src/components/graph/GraphClient.tsx` (four mode tabs, the drawer, the edge
  type on every edge)
- Modify: `apps/web/src/components/graph/OrgNodes.tsx` (`buildOrgGraph` stamps
  `type: 'cable'` and the target's tone on every edge)
- Modify: `apps/web/src/server/graph.ts` (`GraphSnapshot` gains per-agent drawer facts)
- Test: `apps/web/test/graph-flow.test.tsx` (extend — owns every edge/particle assertion)
- Test: `apps/web/test/graph-exec.test.ts` (create — owns `buildExecutionGraph`)
- Test: `apps/web/test/graph-page.test.tsx` (extend — owns the mode tabs and the client shell)
- Test: `apps/web/test/integration/graph-snapshot.test.ts` (extend)

**Interfaces:**
- Consumes: React Flow 11's `EdgeProps` and `getBezierPath`; `Particles.tsx` (untouched);
  `CARD_STATE_TONE`; `AvatarTile`, `StatusPill`, `ProgressBar`, `Button`, `postControl`.
- Produces:

```tsx
// apps/web/src/components/graph/CableEdge.tsx
/** The tone whose colour the cable is drawn in, plus whether it animates. Set by
 *  `buildOrgGraph`/`buildDepsGraph` on each edge's `data`. */
export interface CableEdgeData {
  readonly tone: StatusTone
  /** `false` renders the inactive cable: 3px, `rgba(255,255,255,.13)`, no dash, no halo. */
  readonly active: boolean
}

export const CABLE_EDGE_TYPES: EdgeTypes // { cable: CableEdge }
export function CableEdge(props: EdgeProps<CableEdgeData>): React.JSX.Element
```

```tsx
// apps/web/src/components/graph/ExecutionNodes.tsx
/** A pipeline stage node — one per `BOARD_COLUMNS` member, laid out left→right. */
export interface StageNodeData {
  readonly kind: 'stage'
  readonly column: BoardColumn
  readonly count: number
  readonly tone: StatusTone
}

/** One task, rendered compactly beneath the stage its status maps to. */
export interface StageTaskNodeData {
  readonly kind: 'stageTask'
  readonly title: string
  readonly ref: string
  readonly tone: StatusTone
}

export const EXECUTION_NODE_TYPES: NodeTypes // { stage: StageNode, stageTask: StageTaskNode }

/** The six stages plus every task under its own, with stage→next-stage cables. Pure: same
 *  snapshot in, same nodes and edges out — no React, no layout, no coordinates. */
export function buildExecutionGraph(snapshot: GraphSnapshot): {
  readonly nodes: Node[]
  readonly edges: Edge[]
}
```

```typescript
// apps/web/src/server/graph.ts -- GraphAgent gains the drawer's facts
  readonly provider: ProviderKind | null
  readonly model: string | null
  readonly progressPct: number
  /** `✓` done / `●` current / `○` pending, from this run's `Checkpoint` rows and its tool-call
   *  count. Empty for an agent with no live run. */
  readonly checkpoints: readonly { readonly label: string; readonly state: 'done' | 'current' | 'pending' }[]
  /** This run's most recent events, newest first, capped at 8 — the drawer's tail. */
  readonly recentEvents: readonly { readonly seq: number; readonly ts: string; readonly summary: string }[]
  /** `true` when the agent's live or most recent run has a non-null `skillCalls` — what makes the
   *  "Skill chain" mode reachable rather than a disabled `later`. */
  readonly hasSkillData: boolean
```

**How the cable coexists with `Particles.tsx`.** `Particles` portals each `<circle>` into the
`<g data-testid="rf__edge-<id>">` React Flow renders, and reads its `offset-path` off the sibling
`path.react-flow__edge-path`'s `d` attribute (`Particles.tsx:103-107`). `CableEdge` therefore
**must keep exactly one path carrying `className="react-flow__edge-path"` with the full `d`** —
that is the core stroke. The halo and the dash overlay are extra siblings inside the same `<g>`
and carry their own class names, so the `querySelector('path.react-flow__edge-path')` still
resolves to one node and the particle rides the same curve the cable draws. `Particles` is not
modified by this task.

- [ ] **Step 1: Write the failing edge test**

Append to `apps/web/test/graph-flow.test.tsx`:

```tsx
describe('CableEdge', () => {
  const props = {
    id: 'e1',
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 100,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    data: { tone: 'working' as const, active: true },
  }

  it('draws three stacked paths and one filter def inside one group', () => {
    const { container } = render(
      <svg>
        <CableEdge {...(props as never)} />
      </svg>,
    )
    expect(container.querySelectorAll('g[data-testid="cable-edge"] path')).toHaveLength(3)
    expect(container.querySelector('filter#cable-glow feGaussianBlur')?.getAttribute('stdDeviation')).toBe('4')
  })

  it('keeps exactly one react-flow__edge-path so Particles can still find its curve', () => {
    const { container } = render(
      <svg>
        <CableEdge {...(props as never)} />
      </svg>,
    )
    const core = container.querySelectorAll('path.react-flow__edge-path')
    expect(core).toHaveLength(1)
    expect(core[0]?.getAttribute('d')).toBeTruthy()
    expect(core[0]?.getAttribute('stroke-width')).toBe('1.4')
  })

  it('draws the halo at 5px, opacity .18, through the blur filter', () => {
    const { container } = render(
      <svg>
        <CableEdge {...(props as never)} />
      </svg>,
    )
    const halo = container.querySelector('path[data-cable="halo"]')
    expect(halo?.getAttribute('stroke-width')).toBe('5')
    expect(halo?.getAttribute('opacity')).toBe('0.18')
    expect(halo?.getAttribute('filter')).toBe('url(#cable-glow)')
  })

  it('animates the white dashed overlay with the README dash exactly', () => {
    const { container } = render(
      <svg>
        <CableEdge {...(props as never)} />
      </svg>,
    )
    const flow = container.querySelector('path[data-cable="flow"]')
    // SVG ATTRIBUTES, which jsdom does report exactly — unlike class-derived CSS, which it does
    // not see at all. The gate re-reads `stroke-dasharray` off `getComputedStyle` on the real page.
    expect(flow?.getAttribute('stroke-dasharray')).toBe('5 11')
    expect(flow?.getAttribute('stroke')).toBe('#ffffff')
    expect(flow?.getAttribute('stroke-width')).toBe('1.6')
    expect(flow?.getAttribute('class')).toContain('motion-safe:animate-[dash_1.15s_linear_infinite]')
  })

  it('renders an inactive edge as one flat 3px line with no halo and no dash', () => {
    const { container } = render(
      <svg>
        <CableEdge {...({ ...props, data: { tone: 'idle', active: false } } as never)} />
      </svg>,
    )
    expect(container.querySelectorAll('g[data-testid="cable-edge"] path')).toHaveLength(1)
    const core = container.querySelector('path.react-flow__edge-path')
    expect(core?.getAttribute('stroke-width')).toBe('3')
    expect(core?.getAttribute('stroke')).toBe('rgba(255,255,255,.13)')
  })
})
```

Append to `apps/web/test/graph-page.test.tsx`:

```tsx
  it('offers four modes, with Skill chain disabled until a run has recorded skill data', () => {
    const { rerender } = render(<GraphClient workspaceId="w1" initial={snapshot({ agents: [graphAgent({ hasSkillData: false })] })} />)
    expect(screen.getAllByTestId('graph-mode').map((t) => t.textContent)).toEqual([
      'Organization', 'Execution', 'Dependencies', 'Skill chain · later',
    ])
    expect((screen.getByTestId('graph-mode-skill') as HTMLButtonElement).disabled).toBe(true)

    rerender(<GraphClient workspaceId="w1" initial={snapshot({ agents: [graphAgent({ hasSkillData: true })] })} />)
    expect((screen.getByTestId('graph-mode-skill') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByTestId('graph-mode-skill').textContent).toBe('Skill chain')
  })

  it('opens the 352px drawer on a node click and closes it again', () => {
    render(<GraphClient workspaceId="w1" initial={snapshot({ agents: [graphAgent({ id: 'a1', name: 'Alex Turner' })] })} />)
    expect(screen.queryByTestId('graph-drawer')).toBeNull()

    fireEvent.click(screen.getByTestId('graph-canvas'), { detail: 1 })
    // The canvas stub in this file exposes `onNodeClick`; call it directly, as the existing
    // node-menu tests here already do.
    act(() => lastCanvasProps?.onNodeClick?.({} as never, { id: 'agent:a1' } as never))
    const drawer = screen.getByTestId('graph-drawer')
    expect(drawer.className).toContain('w-[352px]')
    expect(within(drawer).getByTestId('avatar-tile').textContent).toBe('AT')

    fireEvent.click(within(drawer).getByTestId('drawer-close'))
    expect(screen.queryByTestId('graph-drawer')).toBeNull()
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/web/test/graph-flow.test.tsx apps/web/test/graph-page.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/components/graph/CableEdge.js"`.

- [ ] **Step 3: Write `CableEdge.tsx`**

```tsx
'use client'

import { getBezierPath, type EdgeProps, type EdgeTypes } from 'reactflow'
import type { StatusTone } from '../ui/StatusPill'

export interface CableEdgeData {
  readonly tone: StatusTone
  readonly active: boolean
}

/** The tone's solid colour, as a CSS variable reference — the same `@theme inline` names every
 *  other consumer uses, so a token change reaches the cable for free. Literal per tone, never
 *  interpolated: an SVG `stroke` is not a Tailwind class, but the same "one table, no runtime
 *  string assembly" rule keeps this readable beside `TONE_DOT`. */
const TONE_STROKE: Record<StatusTone, string> = {
  working: 'var(--color-tone-working)',
  planning: 'var(--color-tone-planning)',
  review: 'var(--color-tone-review)',
  waiting: 'var(--color-tone-waiting)',
  blocked: 'var(--color-tone-blocked)',
  done: 'var(--color-tone-done)',
  paused: 'var(--color-tone-paused)',
  idle: 'var(--color-tone-idle)',
}

const INACTIVE_STROKE = 'rgba(255,255,255,.13)'

/**
 * The design README's signature cable ("1b — Cables"), as a React Flow custom edge: three stacked
 * paths in ONE `<g>` — a 5px blurred halo (`feGaussianBlur stdDeviation=4`, opacity .18) in the
 * TARGET's status colour, a 1.4px solid core, and a 1.6px white dashed overlay
 * (`stroke-dasharray: 5 11`) animated to `stroke-dashoffset: -32` over 1.15s linear infinite.
 * Inactive edges are a single flat 3px `rgba(255,255,255,.13)` line with no animation.
 *
 * **Coexistence with `Particles.tsx`** (which is NOT modified by this task): that component
 * portals a `<circle>` into this same `<g>` and reads its `offset-path` off
 * `path.react-flow__edge-path`'s `d` attribute. Exactly ONE path here carries that class — the
 * core — so the lookup still resolves to a single node and the particle rides the same bezier the
 * cable draws. The halo and the flow overlay carry `data-cable` instead.
 *
 * The filter `<def>` is emitted once per edge rather than hoisted to a shared defs layer: React
 * Flow gives an edge component no place to render outside its own `<g>`, and duplicate ids for an
 * identical filter resolve to the first, which is the same filter. Cheap, and it keeps this file
 * self-contained.
 */
export function CableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<CableEdgeData>): React.JSX.Element {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const active = data?.active ?? false
  const stroke = active ? TONE_STROKE[data?.tone ?? 'idle'] : INACTIVE_STROKE

  if (!active) {
    return (
      <g data-testid="cable-edge" data-edge-id={id}>
        <path className="react-flow__edge-path" d={path} fill="none" stroke={INACTIVE_STROKE} strokeWidth="3" opacity="0.5" />
      </g>
    )
  }

  return (
    <g data-testid="cable-edge" data-edge-id={id}>
      <defs>
        <filter id="cable-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      <path data-cable="halo" d={path} fill="none" stroke={stroke} strokeWidth="5" opacity="0.18" filter="url(#cable-glow)" />
      {/* The ONE path carrying `react-flow__edge-path` — `Particles.tsx` reads its `d`. */}
      <path className="react-flow__edge-path" d={path} fill="none" stroke={stroke} strokeWidth="1.4" opacity="0.95" />
      <path
        data-cable="flow"
        className="motion-safe:animate-[dash_1.15s_linear_infinite]"
        d={path}
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="5 11"
        opacity="0.75"
      />
    </g>
  )
}

export const CABLE_EDGE_TYPES: EdgeTypes = { cable: CableEdge } as EdgeTypes
```

- [ ] **Step 4: Give the canvas its surface and the edge type**

In `GraphCanvas.tsx`, add an `edgeTypes` prop (defaulting to `CABLE_EDGE_TYPES`) and an optional
`onNodeClick?: NodeMouseHandler` passed straight through to `<ReactFlow>` (the drawer's opener —
`onNodeContextMenu` already sets the passthrough precedent, and a plain left-click had no handler
before this), pass `edgeTypes` to `<ReactFlow edgeTypes={…}>`, drop `<Background />` (the
handoff's grid is its own), and restyle the wrapper:

```tsx
      <div
        data-testid="graph-canvas"
        className="relative h-full w-full bg-[#08090c] bg-[radial-gradient(rgba(255,255,255,.055)_1px,transparent_1px)] [background-size:26px_26px]"
      >
        {/* The soft teal radial wash at the top (design README "1b — Canvas"). */}
        <span
          aria-hidden
          data-testid="graph-wash"
          className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-[radial-gradient(ellipse_at_top,rgba(46,230,207,.08),transparent_65%)]"
        />
```

In `OrgNodes.tsx`'s `buildOrgGraph`, stamp every pushed edge:

```typescript
    edges.push({
      id: `${teamNodeId}->${agentNodeId}`,
      source: teamNodeId,
      target: agentNodeId,
      type: 'cable',
      // The TARGET's tone (design README: "in the target's status colour"), and "active" means the
      // target is doing something — an idle branch of the org tree is structure, not traffic.
      data: { tone: CARD_STATE_TONE[cardStateForAgent(agent.status as AgentStatus)].tone, active: agent.status !== 'idle' },
    })
```

with the same shape on the workspace→team edge (`tone: 'idle', active: false`) and the
agent→activeTask edge (the task's own tone, `active: true`). `TaskNodes.tsx`'s `buildDepsGraph`
gets the same treatment: `tone` from `cardStateFor('idle', task.status)`, `active` when the
dependency is satisfied.

- [ ] **Step 5: Write `GraphDrawer.tsx`**

```tsx
'use client'

import { useState } from 'react'
import { CARD_STATE_TONE, cardStateForAgent } from '../../lib/tones'
import { postControl } from '../../lib/postControl'
import type { GraphAgent } from '../../server/graph'
import type { AgentStatus } from '@ai-team-os/domain'
import { AvatarTile } from '../ui/AvatarTile'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { PanelHeader } from '../ui/PanelHeader'
import { ProgressBar } from '../ui/ProgressBar'
import { StatusPill } from '../ui/StatusPill'

/** The handoff's quick-instruction chips (design README "1b — Drawer"). Fixed copy, and
 *  deliberately so: these are operator shorthand, not data — each one fills the free-text box,
 *  which is what actually sends. */
const QUICK_INSTRUCTIONS = ['rebase onto main first', 'add a test for this', 'stop after this step'] as const

const CHECKPOINT_GLYPH = { done: '✓', current: '●', pending: '○' } as const

/** The 352px right drawer (design README §3a.4 / "1b"). */
export function GraphDrawer({
  workspaceId,
  agent,
  onClose,
}: {
  readonly workspaceId: string
  readonly agent: GraphAgent
  readonly onClose: () => void
}): React.JSX.Element {
  const { tone, label, pulse } = CARD_STATE_TONE[cardStateForAgent(agent.status as AgentStatus)]
  const [draft, setDraft] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)
  const runId = agent.activeRunId

  const send = async (): Promise<void> => {
    if (runId === null || draft.trim() === '') return
    const result = await postControl(`/api/w/${workspaceId}/runs/${runId}/message`, { message: draft })
    if (result.ok) setDraft('')
    else setErrorText(result.error)
  }

  const control = async (action: 'pause' | 'stop'): Promise<void> => {
    if (runId === null) return
    const result = await postControl(`/api/w/${workspaceId}/runs/${runId}/${action}`)
    if (!result.ok) setErrorText(result.error)
  }

  return (
    <aside
      data-testid="graph-drawer"
      aria-label="Agent detail"
      className="flex w-[352px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-bg-1 p-4"
    >
      <header className="flex items-start gap-[9px]">
        <AvatarTile name={agent.name} tone={tone} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{agent.name}</div>
          <div className="truncate text-[10.5px] text-[#7c8697]">{agent.role}</div>
        </div>
        <StatusPill tone={tone} label={label} pulse={pulse} />
        <Button variant="ghost" data-testid="drawer-close" onClick={onClose} aria-label="Close agent detail">
          close
        </Button>
      </header>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-tile border border-line bg-line">
        <div className="bg-bg-2 p-[10px]">
          <div className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">provider</div>
          <div data-testid="drawer-provider" className="font-mono text-[11px] text-text-1">
            {agent.provider ?? '—'}
          </div>
        </div>
        <div className="bg-bg-2 p-[10px]">
          <div className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">model</div>
          <div data-testid="drawer-model" className="truncate font-mono text-[11px] text-text-1">
            {agent.model ?? '—'}
          </div>
        </div>
      </div>

      <section className="flex flex-col gap-1">
        <PanelHeader title="current task" />
        <p data-testid="drawer-task" className="truncate text-[11.5px] text-[#c8cfda]">
          {agent.activeTaskTitle ?? 'no task'}
        </p>
        <ProgressBar pct={agent.progressPct} tone={tone} />
      </section>

      <section className="flex flex-col gap-1">
        <PanelHeader title="checkpoints" />
        {agent.checkpoints.length === 0 ? (
          <p className="text-xs text-text-3">none yet</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {agent.checkpoints.map((checkpoint) => (
              <li key={checkpoint.label} data-testid="drawer-checkpoint" className="flex items-baseline gap-2 text-[11px] text-text-2">
                <span aria-hidden className="font-mono text-text-3">
                  {CHECKPOINT_GLYPH[checkpoint.state]}
                </span>
                <span className="truncate">{checkpoint.label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <PanelHeader title="instruct" />
        <div className="flex flex-wrap gap-1">
          {QUICK_INSTRUCTIONS.map((instruction) => (
            <button
              key={instruction}
              type="button"
              data-testid="drawer-quick"
              onClick={() => setDraft(instruction)}
              className="rounded-chip border border-line bg-bg-2 px-2 py-0.5 text-[10.5px] text-text-2 transition-colors hover:border-white/20 hover:text-text-1"
            >
              {instruction}
            </button>
          ))}
        </div>
        <input
          data-testid="drawer-instruct"
          aria-label="instruct the agent"
          value={draft}
          disabled={runId === null}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends (design README "1b — Drawer"). The message is queued on the run and
            // consumed on its next resume — the SAME route `AgentPanel`'s save button uses.
            if (event.key === 'Enter') void send()
          }}
          className="rounded-tile border border-line bg-bg-0 px-2 py-1 text-xs text-text-1"
        />
      </section>

      <section className="flex gap-2">
        <Button variant="ghost" data-testid="drawer-pause" disabled={runId === null} onClick={() => void control('pause')}>
          Pause
        </Button>
        {/* Honestly disabled (Decision 7): there is no reassign verb in `packages/control`, and a
          * button that does nothing is worse than one that says it cannot yet. */}
        <Button variant="ghost" data-testid="drawer-reassign" disabled title="arrives in a later milestone">
          Reassign · later
        </Button>
        <Button variant="ghost" data-testid="drawer-stop" disabled={runId === null} onClick={() => void control('stop')}>
          Stop
        </Button>
      </section>

      {errorText !== null && (
        <span role="alert" data-testid="drawer-error" className="text-xs text-status-danger">
          {errorText}
        </span>
      )}

      <section className="flex flex-col gap-1">
        <PanelHeader title="recent events" />
        <ul className="flex flex-col gap-1">
          {agent.recentEvents.map((event) => (
            <li key={event.seq} data-testid="drawer-event" className="flex items-baseline gap-2 font-mono text-[10px] text-text-2">
              <span className="shrink-0 text-text-3">{event.ts.slice(11, 19)}</span>
              <span className="min-w-0 truncate">{event.summary}</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  )
}
```

- [ ] **Step 6: Four modes and the drawer in `GraphClient.tsx`**

Widen `GraphMode` to `'org' | 'exec' | 'dep' | 'skill'`, update `isGraphMode`, and:

```tsx
const MODE_TABS: readonly { readonly mode: GraphMode; readonly label: string }[] = [
  { mode: 'org', label: 'Organization' },
  { mode: 'exec', label: 'Execution' },
  { mode: 'dep', label: 'Dependencies' },
  { mode: 'skill', label: 'Skill chain' },
]
```

Render each tab as a `<button data-testid="graph-mode" data-mode={tab.mode}>` with
`data-testid="graph-mode-skill"` on the skill one; it is `disabled` and reads
`Skill chain · later` while `view.agents.every((a) => !a.hasSkillData)`.

Each mode renders its own node/edge set — Execution is NOT Dependencies:

```tsx
      <div className="relative flex flex-1">
        <div className="relative min-w-0 flex-1">
          {mode === 'org' && (
            <>
              <GraphCanvas nodes={positionedOrgNodes} edges={visibleOrgEdges} nodeTypes={ORG_NODE_TYPES} onNodeClick={onNodeClick} />
              <Particles particles={particles} />
            </>
          )}
          {mode === 'exec' && <ExecutionMode snapshot={view} />}
          {mode === 'dep' && <DepsMode workspaceId={workspaceId} snapshot={view} />}
        </div>
        {selectedAgent !== null && <GraphDrawer workspaceId={workspaceId} agent={selectedAgent} onClose={() => setSelectedAgentId(null)} />}
      </div>
```

where `ExecutionMode` is a six-line wrapper in `GraphClient.tsx` that runs
`buildExecutionGraph(snapshot)` through `useLayoutedGraph(nodes, edges, 'layered')` and hands the
result to `<GraphCanvas nodeTypes={EXECUTION_NODE_TYPES}>` — the same shape `DepsMode` already
uses for its own builder.

Hold `selectedAgentId` in state, set it from `GraphCanvas`'s `onNodeClick` when the id starts
`agent:`, and render `<GraphDrawer>` beside the canvas as above.

- [ ] **Step 6a: Write the failing execution-graph test**

```typescript
// apps/web/test/graph-exec.test.ts
import { describe, expect, it } from 'vitest'
import type { GraphSnapshot } from '../src/server/graph.js'
import { buildExecutionGraph } from '../src/components/graph/ExecutionNodes.js'

function snapshot(tasks: GraphSnapshot['tasks']): GraphSnapshot {
  return {
    workspace: { id: 'w1', name: 'W', haltedReason: null },
    teams: [],
    agents: [],
    tasks,
    dependencies: [],
  }
}

function task(over: Partial<GraphSnapshot['tasks'][number]>): GraphSnapshot['tasks'][number] {
  return {
    id: 't1',
    title: 'Checkout API',
    status: 'running',
    priority: 2,
    attempt: 0,
    maxAttempts: 3,
    dependenciesDone: true,
    ...over,
  }
}

describe('buildExecutionGraph', () => {
  it('emits the six stages in BOARD_COLUMNS order, always, even with no tasks at all', () => {
    const { nodes } = buildExecutionGraph(snapshot([]))
    const stages = nodes.filter((node) => node.type === 'stage')
    expect(stages.map((node) => node.id)).toEqual([
      'stage:Backlog', 'stage:Todo', 'stage:In Progress', 'stage:Review', 'stage:Blocked', 'stage:Done',
    ])
    // A stage with nothing in it is still a stage — the pipeline's shape is the information, and
    // hiding an empty one would make the graph change layout on every tick.
    expect(stages.every((node) => (node.data as { count: number }).count === 0)).toBe(true)
  })

  it('chains the stages left to right, one inactive cable per adjacent pair', () => {
    const { edges } = buildExecutionGraph(snapshot([]))
    expect(edges.map((edge) => edge.id)).toEqual([
      'stage:Backlog->stage:Todo',
      'stage:Todo->stage:In Progress',
      'stage:In Progress->stage:Review',
      'stage:Review->stage:Blocked',
      'stage:Blocked->stage:Done',
    ])
    expect(edges.every((edge) => edge.type === 'cable')).toBe(true)
    expect(edges.every((edge) => (edge.data as { active: boolean }).active === false)).toBe(true)
  })

  it('places each task under the stage its status maps to, via COLUMN_FOR_STATUS', () => {
    const { nodes, edges } = buildExecutionGraph(
      snapshot([
        task({ id: 't1', status: 'running' }),
        task({ id: 't2', status: 'verifying' }),
        task({ id: 't3', status: 'merging' }),
        task({ id: 't4', status: 'cancelled' }),
      ]),
    )
    const parentOf = (taskId: string): string | undefined =>
      edges.find((edge) => edge.target === `execTask:${taskId}`)?.source

    expect(parentOf('t1')).toBe('stage:In Progress')
    expect(parentOf('t2')).toBe('stage:In Progress')
    // `merging` is Review, `cancelled` is Done — the SAME mapping the board uses, imported from
    // `lib/taskColumns.ts`, never re-derived here.
    expect(parentOf('t3')).toBe('stage:Review')
    expect(parentOf('t4')).toBe('stage:Done')

    const inProgress = nodes.find((node) => node.id === 'stage:In Progress')
    expect((inProgress?.data as { count: number }).count).toBe(2)
    expect(nodes.filter((node) => node.type === 'stageTask')).toHaveLength(4)
  })

  it('lights the cable INTO a stage that currently holds live work', () => {
    const { edges } = buildExecutionGraph(snapshot([task({ id: 't1', status: 'running' })]))
    const intoInProgress = edges.find((edge) => edge.id === 'stage:Todo->stage:In Progress')
    expect((intoInProgress?.data as { active: boolean }).active).toBe(true)
    // Nothing is in Review, so its inbound cable stays inactive.
    const intoReview = edges.find((edge) => edge.id === 'stage:In Progress->stage:Review')
    expect((intoReview?.data as { active: boolean }).active).toBe(false)
  })

  it('does not light a stage whose only tasks are at rest', () => {
    const { edges } = buildExecutionGraph(snapshot([task({ id: 't1', status: 'done' }), task({ id: 't2', status: 'backlog' })]))
    expect(edges.every((edge) => (edge.data as { active: boolean }).active === false)).toBe(true)
  })

  it('renders a task node with the same mono reference the board uses, and its tone', () => {
    const { nodes } = buildExecutionGraph(snapshot([task({ id: '3f9a21c8-0000-4000-8000-000000000000', status: 'blocked' })]))
    const node = nodes.find((n) => n.type === 'stageTask')
    expect((node?.data as { ref: string }).ref).toBe('TASK-3f9a21c8')
    expect((node?.data as { tone: string }).tone).toBe('blocked')
  })
})
```

- [ ] **Step 6b: Run it to verify it fails**

Run: `npx vitest run apps/web/test/graph-exec.test.ts`
Expected: FAIL — `Failed to resolve import "../src/components/graph/ExecutionNodes.js"`.

- [ ] **Step 6c: Write `ExecutionNodes.tsx`**

```tsx
'use client'

import { Handle, Position, type Edge, type Node, type NodeProps, type NodeTypes } from 'reactflow'
import { BOARD_COLUMNS, COLUMN_FOR_STATUS, COLUMN_STATE, type BoardColumn } from '../../lib/taskColumns'
import { CARD_STATE_TONE, cardStateFor } from '../../lib/tones'
import type { GraphSnapshot } from '../../server/graph'
import { TONE_BORDER, TONE_DOT, TONE_FILL, TONE_TEXT, type StatusTone } from '../ui/StatusPill'

export interface StageNodeData {
  readonly kind: 'stage'
  readonly column: BoardColumn
  readonly count: number
  readonly tone: StatusTone
}

export interface StageTaskNodeData {
  readonly kind: 'stageTask'
  readonly title: string
  readonly ref: string
  readonly tone: StatusTone
}

/** Statuses that mean work is happening in a stage RIGHT NOW — what lights the cable into it
 *  (design README "1b — Modes": Execution is the pipeline, and a live pipeline is the point).
 *  `blocked` and `backlog` are at rest: something is sitting there, not moving through. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['running', 'verifying', 'reviewing', 'merging'])

export function StageNode({ data }: NodeProps<StageNodeData>): React.JSX.Element {
  return (
    <div className={`flex w-[176px] items-center gap-[7px] rounded-card border bg-bg-2 px-[10px] py-[8px] ${TONE_BORDER[data.tone]}`}>
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <span className={`h-[6px] w-[6px] flex-none rounded-full ${TONE_DOT[data.tone]}`} />
      <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] uppercase tracking-[.06em] text-text-2">{data.column}</span>
      <span className={`font-mono text-[11px] font-semibold ${TONE_TEXT[data.tone]}`}>{data.count}</span>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  )
}

export function StageTaskNode({ data }: NodeProps<StageTaskNodeData>): React.JSX.Element {
  return (
    <div className={`w-[176px] rounded-tile border bg-[#0f1116] px-[10px] py-[8px] ${TONE_BORDER[data.tone]} ${TONE_FILL[data.tone]}`}>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="font-mono text-[9.5px] text-text-3">{data.ref}</div>
      <div className="truncate text-[11.5px] text-[#dbe1ea]">{data.title}</div>
    </div>
  )
}

export const EXECUTION_NODE_TYPES: NodeTypes = { stage: StageNode, stageTask: StageTaskNode } as NodeTypes

/**
 * Execution mode (design README §3a.4 / "1b — Modes": "Execution (pipeline stages)") — its OWN
 * node set, not Dependencies re-labelled.
 *
 * The stages are `BOARD_COLUMNS` and the placement is `COLUMN_FOR_STATUS`, both imported from
 * `lib/taskColumns.ts` (Task 10) rather than restated: the board and this graph must never
 * disagree about which column a `merging` task belongs to, and two tables that agree today are
 * two tables that disagree after the first edit.
 *
 * Every node starts at `{x: 0, y: 0}`; `layout.ts`'s `useLayoutedGraph` positions them
 * left-to-right. This function owns topology and `data`, never coordinates — the same contract
 * `buildOrgGraph` follows.
 */
export function buildExecutionGraph(snapshot: GraphSnapshot): { readonly nodes: Node[]; readonly edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const origin = { x: 0, y: 0 }

  const tasksByColumn = new Map<BoardColumn, GraphSnapshot['tasks'][number][]>(BOARD_COLUMNS.map((column) => [column, []]))
  for (const task of snapshot.tasks) {
    tasksByColumn.get(COLUMN_FOR_STATUS[task.status])?.push(task)
  }

  for (const column of BOARD_COLUMNS) {
    const columnTasks = tasksByColumn.get(column) ?? []
    const stageId = `stage:${column}`
    const stageTone = CARD_STATE_TONE[COLUMN_STATE[column]].tone
    nodes.push({
      id: stageId,
      type: 'stage',
      position: origin,
      data: { kind: 'stage', column, count: columnTasks.length, tone: stageTone } satisfies StageNodeData,
    })

    for (const task of columnTasks) {
      const taskId = `execTask:${task.id}`
      nodes.push({
        id: taskId,
        type: 'stageTask',
        position: origin,
        data: {
          kind: 'stageTask',
          title: task.title,
          // The same `TASK-<8 chars>` reference the board and the agent card render.
          ref: `TASK-${task.id.slice(0, 8)}`,
          tone: CARD_STATE_TONE[cardStateFor('idle', task.status)].tone,
        } satisfies StageTaskNodeData,
      })
      // Stage → its own tasks. Inactive: this edge is containment, not flow.
      edges.push({
        id: `${stageId}->${taskId}`,
        source: stageId,
        target: taskId,
        type: 'cable',
        data: { tone: stageTone, active: false },
      })
    }
  }

  // The pipeline itself: stage → next stage. A cable is LIVE when the stage it points INTO holds
  // work that is actually moving right now — `LIVE_STATUSES` above, not merely "is non-empty".
  for (let i = 0; i < BOARD_COLUMNS.length - 1; i += 1) {
    const from = BOARD_COLUMNS[i] as BoardColumn
    const to = BOARD_COLUMNS[i + 1] as BoardColumn
    const live = (tasksByColumn.get(to) ?? []).some((task) => LIVE_STATUSES.has(task.status))
    edges.push({
      id: `stage:${from}->stage:${to}`,
      source: `stage:${from}`,
      target: `stage:${to}`,
      type: 'cable',
      data: { tone: CARD_STATE_TONE[COLUMN_STATE[to]].tone, active: live },
    })
  }

  return { nodes, edges }
}
```

The test above asserts the stage-chain edges as the WHOLE edge list for a task-less snapshot,
which holds because a snapshot with no tasks emits no containment edges.

- [ ] **Step 6d: Run the execution-graph test to green**

Run: `npx vitest run apps/web/test/graph-exec.test.ts`
Expected: PASS.

- [ ] **Step 7: Widen `GraphSnapshot`**

In `apps/web/src/server/graph.ts`, add the six fields to `GraphAgent` and fill them in
`buildGraphSnapshot`: `provider`/`model` from the live run and the agent row, `progressPct` from
`toolCalls / workspace.maxToolCallsPerRun`, `checkpoints` from the run's `Checkpoint` row
(`{ label: 'checkpoint at step <n>', state: 'done' }` for the row that exists, plus
`{ label: 'step <toolCalls>', state: 'current' }`), `recentEvents` from the last 8
`ExecutionEvent` rows for the run, and `hasSkillData` from
`run.skillCalls !== null` on the agent's most recent run.

- [ ] **Step 8: Run the tests to green**

Run: `npx vitest run apps/web/test/graph-flow.test.tsx apps/web/test/graph-exec.test.ts apps/web/test/graph-page.test.tsx apps/web/test/graph-deps.test.tsx apps/web/test/integration/graph-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add apps/web/src/components/graph/CableEdge.tsx apps/web/src/components/graph/ExecutionNodes.tsx apps/web/src/components/graph/GraphDrawer.tsx apps/web/src/components/graph/GraphCanvas.tsx apps/web/src/components/graph/GraphClient.tsx apps/web/src/components/graph/OrgNodes.tsx apps/web/src/components/graph/TaskNodes.tsx apps/web/src/server/graph.ts apps/web/test/graph-flow.test.tsx apps/web/test/graph-exec.test.ts apps/web/test/graph-page.test.tsx apps/web/test/integration/graph-snapshot.test.ts
git commit -m "feat(web): the graph draws cables, its stages and the drawer that steers an agent"
```

---

### Task 12 (C5): Activity

**Files:**
- Modify: `apps/web/src/components/activity/ActivityCard.tsx` (the river row layout)
- Modify: `apps/web/src/components/activity/Timeline.tsx` (the x=88 rule, `.rise` on new rows)
- Modify: `apps/web/src/components/activity/ActivityClient.tsx` (the right rail, the roster)
- Modify: `apps/web/src/components/activity/FilterBar.tsx` (kind chips keep their behaviour, take
  the handoff's chip geometry)
- Modify: `apps/web/src/server/activity.ts` (`ActivityPage` gains `typeVolumes`)
- Test: `apps/web/test/activity-cards.test.tsx` (extend)
- Test: `apps/web/test/activity-page.test.tsx` (extend)
- Test: `apps/web/test/integration/activity-history.test.ts` (extend)

**Interfaces:**
- Produces:

```typescript
// apps/web/src/server/activity.ts -- ActivityPage gains one member
  /** Event counts by kind prefix over the last 24 hours, for the right rail's volume bars.
   *  Sorted by count descending; a kind with no events in the window is omitted, never shown as
   *  a zero bar. */
  readonly typeVolumes: readonly { readonly prefix: string; readonly count: number }[]
```

```tsx
// apps/web/src/components/activity/ActivityCard.tsx -- one new prop
  /** Dimmed to opacity .35 because a roster row is selected and this event is not that agent's
   *  (design README "Filtering"). */
  readonly dimmed: boolean
```

**The x=88 rule.** The vertical rule is a single absolutely positioned `<span>` inside
`Timeline`'s scroll viewport with an INLINE `style={{ left: '88px' }}` — so vitest reads
`el.style.left === '88px'` exactly, and the gate reads `getComputedStyle(el).left`. The row's own
geometry is a 74px right-aligned mono timestamp plus a 28px dot gutter, which places the 7px dot's
centre at 88px; those two widths are class strings (`w-[74px]`, `w-[28px]`).

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/activity-cards.test.tsx`:

```tsx
describe('the river row', () => {
  const base = {
    event: { seq: 1, ts: '2026-08-29T10:00:00.000Z', type: 'run.tool_call' as const, actor: 'agent', agentId: 'a1', taskId: null, runId: 'r1', payload: {}, summary: 'Write a.txt' },
    workspaceId: 'w1',
    agentName: 'Alex',
    taskTitle: null,
    dimmed: false,
  }

  it('lays out 74px timestamp, 28px dot gutter, then who + kind + text', () => {
    render(<ActivityCard {...base}>body</ActivityCard>)
    expect(screen.getByTestId('event-time').className).toContain('w-[74px]')
    expect(screen.getByTestId('event-time').className).toContain('text-right')
    expect(screen.getByTestId('event-gutter').className).toContain('w-[28px]')
    expect(screen.getByTestId('event-dot').className).toContain('h-[7px]')
  })

  it('dims a non-matching row to opacity .35 rather than hiding it', () => {
    const { rerender } = render(<ActivityCard {...base}>body</ActivityCard>)
    expect(screen.getByTestId('activity-card').className).not.toContain('opacity-[.35]')

    rerender(
      <ActivityCard {...base} dimmed>
        body
      </ActivityCard>,
    )
    expect(screen.getByTestId('activity-card').className).toContain('opacity-[.35]')
  })

  it('keeps the payload disclosure', () => {
    render(<ActivityCard {...base}>body</ActivityCard>)
    expect(screen.getByTestId('payload-toggle')).toBeTruthy()
  })
})
```

Append to `apps/web/test/activity-page.test.tsx`:

```tsx
  it('draws the vertical rule at exactly x=88 with the teal→indigo gradient', () => {
    render(<ActivityClient workspaceId="w1" initial={page({})} />)
    const rule = screen.getByTestId('timeline-rule')
    // Inline style, which jsdom reports exactly. The gate re-reads `left` from computed style.
    expect(rule.style.left).toBe('88px')
    expect(rule.className).toContain('bg-[linear-gradient(180deg,transparent,rgba(46,230,207,.28),rgba(123,140,255,.18),transparent)]')
  })

  it('renders a volume bar per event kind, widest first, and nothing for a quiet window', () => {
    const { rerender } = render(
      <ActivityClient workspaceId="w1" initial={page({ typeVolumes: [{ prefix: 'task.*', count: 34 }, { prefix: 'run.*', count: 12 }] })} />,
    )
    const bars = screen.getAllByTestId('volume-bar')
    expect(bars.map((b) => b.getAttribute('data-prefix'))).toEqual(['task.*', 'run.*'])
    // Normalized to the largest: the widest bar is always 100%.
    expect(screen.getAllByTestId('volume-fill')[0]?.style.width).toBe('100%')
    expect(screen.getAllByTestId('volume-fill')[1]?.style.width).toBe('35%')

    rerender(<ActivityClient workspaceId="w1" initial={page({ typeVolumes: [] })} />)
    expect(screen.queryAllByTestId('volume-bar')).toHaveLength(0)
  })

  it('filtering to a roster row dims every card that is not that agent', () => {
    render(
      <ActivityClient
        workspaceId="w1"
        initial={page({ agents: [{ id: 'a1', name: 'Alex' }, { id: 'a2', name: 'Bea' }] })}
      />,
    )
    fireEvent.click(screen.getByTestId('roster-row-a1'))
    const cards = screen.getAllByTestId('activity-card')
    expect(cards.some((c) => c.className.includes('opacity-[.35]'))).toBe(true)
  })
```

Append to `apps/web/test/integration/activity-history.test.ts`:

```typescript
  it('reports 24-hour event volumes by kind prefix, busiest first, omitting silent kinds', async (): Promise<void> => {
    // Seed with this file's own helpers: 3 `run.tool_call`, 1 `task.started`, and one event
    // older than 24 hours which must NOT be counted.
    const page = await buildActivityPage(fixture.workspaceId)
    expect(page?.typeVolumes).toEqual([
      { prefix: 'run.*', count: 3 },
      { prefix: 'task.*', count: 1 },
    ])
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/web/test/activity-cards.test.tsx apps/web/test/activity-page.test.tsx apps/web/test/integration/activity-history.test.ts`
Expected: FAIL — `Unable to find an element by: [data-testid="timeline-rule"]`.

- [ ] **Step 3: Add `typeVolumes` to the DTO**

In `apps/web/src/server/activity.ts`, add the member to `ActivityPage` and compute it in
`buildActivityPage`:

```typescript
  // 24-hour volumes by KIND PREFIX (`run.*`, `task.*`, ...) — the dotted domain name's first
  // segment, not the six user-facing `ActivityKind` buckets: the rail answers "what has this
  // system been doing", and the chips above it already answer "what do I want to see".
  const volumeRows = await prisma.$queryRaw<Array<{ prefix: string; n: bigint }>>`
    SELECT split_part(type::text, '.', 1) || '.*' AS prefix, count(*) AS n
    FROM "ExecutionEvent"
    WHERE "workspaceId" = ${workspaceId} AND ts >= now() - interval '24 hours'
    GROUP BY 1
    ORDER BY 2 DESC`
  const typeVolumes = volumeRows.map((row) => ({ prefix: row.prefix, count: Number(row.n) }))
```

- [ ] **Step 4: Rewrite the row layout in `ActivityCard.tsx`**

Replace the `<article>` and its `<header>`:

```tsx
export function ActivityCard({
  event,
  workspaceId,
  agentName,
  taskTitle,
  dimmed,
  children,
}: ActivityCardProps & { readonly dimmed: boolean; readonly children: ReactNode }): ReactElement {
  return (
    <article
      data-testid="activity-card"
      data-event-type={event.type}
      // Dimmed, never hidden (design README "Filtering"): the river keeps its shape and its
      // timestamps stay comparable, which a filtered-out row would destroy.
      className={`flex items-start py-[7px] pr-[20px] transition-opacity ${dimmed ? 'opacity-[.35]' : ''}`}
    >
      <time
        dateTime={event.ts}
        data-testid="event-time"
        className="w-[74px] flex-none text-right font-mono text-[10.5px] text-text-3"
      >
        {event.ts.slice(11, 19)}
      </time>
      <span data-testid="event-gutter" className="flex w-[28px] flex-none justify-center pt-[4px]">
        <span
          data-testid="event-dot"
          aria-hidden
          className={`h-[7px] w-[7px] rounded-full ${TONE_DOT[toneForEventType(event.type)]} ${TONE_GLOW[toneForEventType(event.type)]}`}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-semibold text-text-1">{agentName ?? event.actor}</span>
          <span className="font-mono text-[9.5px] text-text-3">{event.type}</span>
        </div>
        <div className="mt-[1px] text-[12px] text-[#c8cfda]">{children}</div>
        <PayloadDetails payload={event.payload} />
      </div>
      <span className="flex-none pt-[3px] font-mono text-[9.5px] text-text-3">
        {taskTitle ?? (event.taskId === null ? '—' : event.taskId.slice(0, 8))}
      </span>
    </article>
  )
}
```

Add a small `toneForEventType(type: string): StatusTone` above it, mapping by prefix
(`run.` → working, `task.` → planning, `guardrail.` → blocked, `workspace.` → review, `agent.` →
waiting, anything else → idle) with a comment that it is a DISPLAY mapping, not a domain one.
`ACTIVITY_CARDS`'s card bodies pass `dimmed` straight through — widen `ActivityCardProps` with
`readonly dimmed: boolean` so every card in `cards.tsx` forwards it via `{...props}` with no
per-card edit.

- [ ] **Step 5: Add the rule and the rise to `Timeline.tsx`**

Inside the `timeline-viewport` div, as its first child:

```tsx
      {/* The design README's vertical rule at x=88 (1c / §3a.5). Absolutely positioned inside the
        * scroll viewport so it spans the whole river; `left` is INLINE so the gate can read the
        * exact number back off `getComputedStyle`. */}
      <span
        data-testid="timeline-rule"
        aria-hidden
        style={{ left: '88px' }}
        className="pointer-events-none absolute inset-y-0 w-px bg-[linear-gradient(180deg,transparent,rgba(46,230,207,.28),rgba(123,140,255,.18),transparent)]"
      />
```

and add `relative` to the viewport's own className. Change the per-row entry class from the M6
cross-fade to the handoff's rise:

```tsx
              className={`pb-2 ${isLive ? 'motion-safe:animate-[rise_0.3s_ease-out]' : ''}`}
```

- [ ] **Step 6: Add the right rail and the roster filter to `ActivityClient.tsx`**

Hold `const [rosterAgentId, setRosterAgentId] = useState<string | null>(null)`, pass
`dimmed={rosterAgentId !== null && event.agentId !== rosterAgentId}` down through `Timeline`'s
card render, and render beside the timeline:

```tsx
      <aside className="w-[280px] flex-none border-l border-line p-4">
        <PanelHeader title="event types · 24h" />
        <div className="mt-[11px] flex flex-col gap-[9px]">
          {initial.typeVolumes.map((volume) => {
            const max = initial.typeVolumes[0]?.count ?? 1
            return (
              <div key={volume.prefix} data-testid="volume-bar" data-prefix={volume.prefix}>
                <div className="flex justify-between font-mono text-[10.5px] text-text-2">
                  <span>{volume.prefix}</span>
                  <span className="text-text-3">{volume.count}</span>
                </div>
                <div className="mt-[4px] h-[4px] overflow-hidden rounded-[2px] bg-white/[0.06]">
                  {/* Normalized to the BUSIEST kind, not to a fixed ceiling: the rail compares
                    * kinds against each other, and a fixed scale would flatten a quiet day into
                    * six invisible bars. */}
                  <div data-testid="volume-fill" className="h-full bg-tone-working" style={{ width: `${Math.round((volume.count / max) * 100)}%` }} />
                </div>
              </div>
            )
          })}
        </div>
        <div className="mt-6">
          <PanelHeader title="roster" />
          <ul className="mt-[11px] flex flex-col gap-1">
            {initial.agents.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  data-testid={`roster-row-${agent.id}`}
                  aria-pressed={rosterAgentId === agent.id}
                  onClick={() => setRosterAgentId((current) => (current === agent.id ? null : agent.id))}
                  className={`w-full truncate rounded-nav px-2 py-1 text-left text-xs transition-colors ${
                    rosterAgentId === agent.id ? 'bg-[#151a21] text-text-1' : 'text-text-2 hover:text-text-1'
                  }`}
                >
                  {agent.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
```

Wrap the timeline and this rail in `<div className="flex min-h-0 flex-1">`.

- [ ] **Step 7: Run the tests to green**

Run: `npx vitest run apps/web/test/activity-cards.test.tsx apps/web/test/activity-page.test.tsx apps/web/test/activity-filterbar.test.tsx apps/web/test/integration/activity-history.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/activity/ActivityCard.tsx apps/web/src/components/activity/Timeline.tsx apps/web/src/components/activity/ActivityClient.tsx apps/web/src/components/activity/cards.tsx apps/web/src/server/activity.ts apps/web/test/activity-cards.test.tsx apps/web/test/activity-page.test.tsx apps/web/test/integration/activity-history.test.ts
git commit -m "feat(web): the activity river, its rule at 88, and a roster click that dims the rest"
```

---

### Task 13 (C6): Projects

**Files:**
- Modify: `apps/web/src/components/ProjectsClient.tsx` (the handoff's 3-up card)
- Modify: `apps/web/src/server/org.ts` (`ProjectRow` gains `goal` and `team`)
- Test: `apps/web/test/projects-page.test.tsx` (extend)
- Test: `apps/web/test/integration/server-org.test.ts` (extend)

**Interfaces:**
- Produces:

```typescript
// apps/web/src/server/org.ts -- ProjectRow gains two fields
  /** The workspace's own goal, one line — the handoff's card description. `null` when unset, and
   *  the card then says so rather than inventing copy. */
  readonly goal: string | null
  /** The project's workers, for the avatar row: name and the tone their derived status resolves
   *  to. Capped at 6 — a wider row wraps and stops reading as a team. */
  readonly team: readonly { readonly agentId: string; readonly name: string; readonly status: string }[]
```

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/projects-page.test.tsx` (widen the `project` factory with
`goal: null, team: []`):

```tsx
describe('the handoff project card', () => {
  it('shows the goal as the one-line description, and says so when there is none', () => {
    const { rerender } = render(<ProjectsClient projects={[project({ goal: 'Payments rewrite' })]} companies={companies} />)
    expect(screen.getByTestId('project-description').textContent).toBe('Payments rewrite')

    rerender(<ProjectsClient projects={[project({ goal: null })]} companies={companies} />)
    expect(screen.getByTestId('project-description').textContent).toBe('no goal set')
  })

  it('renders an avatar tile per team member instead of numbered placeholders', () => {
    render(
      <ProjectsClient
        projects={[project({ team: [{ agentId: 'a1', name: 'Alex Turner', status: 'working' }, { agentId: 'a2', name: 'Bea Ng', status: 'idle' }] })]}
        companies={companies}
      />,
    )
    expect(screen.getAllByTestId('avatar-tile').map((t) => t.textContent)).toEqual(['AT', 'BN'])
    expect(screen.getAllByTestId('avatar-tile')[0]?.getAttribute('data-tone')).toBe('working')
  })

  it('renders a 4-up stat strip: agents, active, blocked, spend', () => {
    render(<ProjectsClient projects={[project({})]} companies={companies} />)
    expect(screen.getAllByTestId('stat-strip-item').map((i) => i.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'agents 3', 'active 1', 'blocked 0', 'spend $12.50',
    ])
  })

  it('shows the unknown mark on spend rather than a total that swallows unmeasured runs', () => {
    render(<ProjectsClient projects={[project({ spend: 4, unmeasuredRuns: 2 })]} companies={companies} />)
    expect(screen.getByTestId('project-unmeasured').textContent).toBe('2 runs unmeasured')
  })

  it('maps halted to Halted, active work to Running, and quiet to Idle', () => {
    const { rerender } = render(<ProjectsClient projects={[project({ halted: true })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('HALTED')

    rerender(<ProjectsClient projects={[project({ halted: false, taskCounts: { done: 0, total: 3, active: 2, blocked: 0 } })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('RUNNING')

    rerender(<ProjectsClient projects={[project({ halted: false, taskCounts: { done: 3, total: 3, active: 0, blocked: 0 } })]} companies={companies} />)
    expect(screen.getByTestId('status-pill').textContent).toBe('IDLE')
  })
})
```

Append to `apps/web/test/integration/server-org.test.ts`:

```typescript
  it('carries the workspace goal and its workers onto every project row', async (): Promise<void> => {
    const projects = await listProjects()
    expect(projects[0]?.goal).toBeNull()
    expect(projects[0]?.team.map((m) => m.name)).toEqual(['Alex'])
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/web/test/projects-page.test.tsx apps/web/test/integration/server-org.test.ts`
Expected: FAIL — `Unable to find an element by: [data-testid="project-description"]`.

- [ ] **Step 3: Widen `ProjectRow` and `listProjects`**

Add `goal` and `team` to `ProjectRow`. In `listProjects`, the workspace query already loads
`teams: { include: { agents: true } }` (or equivalent — read it); add `goal: true` to its select
and build:

```typescript
    // Capped at six: the handoff's avatar row is one line, and a seventh tile wraps it into
    // something that no longer reads as a team at a glance.
    team: workspace.teams
      .flatMap((team) => team.agents)
      .slice(0, 6)
      .map((agent) => ({ agentId: agent.id, name: agent.name, status: statusByAgent.get(agent.id) ?? 'idle' })),
```

reusing whatever live-status map the function already computes for `workerCount`.

- [ ] **Step 4: Rewrite `ProjectCard` in `ProjectsClient.tsx`**

Replace `statusOf` and the card body:

```tsx
function statusOf(project: ProjectRow): CardState {
  if (project.halted) return 'blocked'
  if (project.taskCounts.active > 0) return 'working'
  return 'idle'
}

const STATUS_LABEL: Partial<Record<CardState, string>> = { blocked: 'HALTED', working: 'RUNNING', idle: 'IDLE' }
```

and inside `<Card onClick={…}>`:

```tsx
        <div className="flex items-start gap-[9px]">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold tracking-[-.2px]">{project.name}</div>
            <div data-testid="project-description" className="mt-[2px] truncate text-[11px] text-[#7c8697]">
              {project.goal ?? 'no goal set'}
            </div>
          </div>
          <StatusPill tone={tone} label={STATUS_LABEL[state] ?? label} pulse={pulse} />
        </div>

        <div aria-label="team" className="mt-[13px] flex flex-wrap items-center gap-1">
          {project.team.map((member) => (
            <AvatarTile
              key={member.agentId}
              name={member.name}
              tone={CARD_STATE_TONE[cardStateForAgent(member.status as AgentStatus)].tone}
            />
          ))}
        </div>

        <div className="mt-[14px]">
          <ProgressBar pct={pct} tone={tone} />
        </div>
        <div className="mt-[5px] flex justify-between font-mono text-[10px] text-text-3">
          <span>progress</span>
          <span>{pct}%</span>
        </div>

        <div className="mt-[14px]">
          <StatStrip
            items={[
              { label: 'agents', value: String(project.workerCount) },
              { label: 'active', value: String(project.taskCounts.active), ...(project.taskCounts.active > 0 ? { tone: 'working' as const } : {}) },
              { label: 'blocked', value: String(project.taskCounts.blocked), ...(project.taskCounts.blocked > 0 ? { tone: 'blocked' as const } : {}) },
              { label: 'spend', value: `$${project.spend.toFixed(2)}` },
            ]}
          />
          {/* Its own line beneath the strip, never folded into the figure (Decision 4). The strip
            * stays exactly 4-up, which is the handoff's own geometry. */}
          {project.unmeasuredRuns > 0 && (
            <p data-testid="project-unmeasured" className="mt-1 font-mono text-[9.5px] text-status-warn">
              {project.unmeasuredRuns} run{project.unmeasuredRuns === 1 ? '' : 's'} unmeasured
            </p>
          )}
        </div>
```

The grid becomes `grid-cols-1 md:grid-cols-3 gap-[14px] p-[18px_20px]` — the handoff's 3-up.

- [ ] **Step 5: Run the tests to green**

Run: `npx vitest run apps/web/test/projects-page.test.tsx apps/web/test/integration/server-org.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/ProjectsClient.tsx apps/web/src/server/org.ts apps/web/test/projects-page.test.tsx apps/web/test/integration/server-org.test.ts
git commit -m "feat(web): a project card shows its goal, its team and what it has actually spent"
```

---
### Task 14 (C7): Settings

**Files:**
- Create: `packages/control/src/permission.ts`
- Modify: `packages/control/src/index.ts` (export it)
- Modify: `packages/control/src/refusal.ts` (`invalid_tool`, `invalid_permission_mode`)
- Create: `apps/web/src/app/api/agents/[agentId]/permission/route.ts`
- Create: `apps/web/src/app/api/dev/reseed/route.ts`
- Create: `apps/web/src/server/settings.ts`
- Create: `apps/web/src/components/ProviderAdapterCards.tsx`
- Create: `apps/web/src/components/PermissionMatrix.tsx`
- Create: `apps/web/src/components/DangerZone.tsx`
- Modify: `apps/web/src/components/SettingsClient.tsx` (the four new sections above the two old
  panels)
- Modify: `apps/web/src/app/settings/page.tsx` (load the two new server reads)
- Test: `packages/control/test/integration/permission.test.ts` (create)
- Test: `apps/web/test/settings-page.test.tsx` (extend)
- Test: `apps/web/test/integration/org-routes.test.ts` (extend — owns every route-handler test)

**Interfaces:**
- Produces:

```typescript
// packages/control/src/permission.ts
/** The design README §3a.9's six permission columns, verbatim and in its order. The ONE list;
 *  the page renders it and the verb validates against it. */
export const PERMISSION_TOOLS = [
  'repo read',
  'source write',
  'run tests',
  'create branch',
  'deploy prod',
  'read secrets',
] as const
export type PermissionTool = (typeof PERMISSION_TOOLS)[number]

export async function setAgentPermission(
  agentId: string,
  tool: string,
  mode: 'allow' | 'deny',
): Promise<Result<void, ControlRefusal>>
```

```typescript
// packages/control/src/refusal.ts -- two new members
/** A permission tool outside `PERMISSION_TOOLS` (M14 §5.7). */
| { readonly kind: 'invalid_tool'; readonly tool: string }
/** A permission mode that is neither `allow` nor `deny`. */
| { readonly kind: 'invalid_permission_mode'; readonly mode: string }
```

`refusalText` returns exactly `a permission must name one of the six tools` and
`a permission must be allow or deny`.

```typescript
// apps/web/src/server/settings.ts
export interface AdapterCard {
  readonly kind: string
  readonly label: string
  /** `'connected'` when the binary is on PATH, `'not found'` when it is not, `'later'` for an
   *  adapter this codebase does not have. */
  readonly state: 'connected' | 'not found' | 'later'
  /** The binary's own `--version` output, `null` when it could not be run. */
  readonly version: string | null
  readonly adapter: string
  /** `capabilitiesOf(kind)` flattened for display; `null` for a `later` card. */
  readonly capabilities: { readonly gate: string; readonly reportsCost: boolean; readonly canPauseMidRun: boolean } | null
  readonly agentsBound: number
}
export async function buildProviderAdapters(): Promise<readonly AdapterCard[]>

export interface PermissionRow {
  readonly agentId: string
  readonly name: string
  readonly role: string
  /** One entry per `PERMISSION_TOOLS` member, in that order. `mode` is `null` when no
   *  `AgentPermission` row exists — unset, which the matrix shows as `✕` and an operator can
   *  change; it is NOT the same as an explicit deny, and the cell says which it is. */
  readonly cells: readonly { readonly tool: string; readonly mode: 'allow' | 'deny' | null }[]
}
export async function buildPermissionMatrix(): Promise<readonly PermissionRow[]>
```

- [ ] **Step 1: Write the failing control test**

```typescript
// packages/control/test/integration/permission.test.ts
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { PERMISSION_TOOLS, setAgentPermission } from '../../src/permission.js'
import { refusalText } from '../../src/refusal.js'

let agentId: string

describe('setAgentPermission', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "AgentPermission", "AgentSkill", "Skill", "SkillProvider", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    const workspace = await prisma.workspace.create({
      data: { name: 'W', repoPath: '/tmp/perm', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'T' } })
    agentId = (await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })).id
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('lists the README six tools, in its order', () => {
    expect(PERMISSION_TOOLS).toEqual(['repo read', 'source write', 'run tests', 'create branch', 'deploy prod', 'read secrets'])
  })

  it('writes a row and flips it in place rather than adding a second', async (): Promise<void> => {
    expect((await setAgentPermission(agentId, 'repo read', 'allow')).ok).toBe(true)
    expect((await setAgentPermission(agentId, 'repo read', 'deny')).ok).toBe(true)

    const rows = await prisma.agentPermission.findMany({ where: { agentId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.mode).toBe('deny')
  })

  it('refuses a tool outside the six with the verbatim text', async (): Promise<void> => {
    const result = await setAgentPermission(agentId, 'rm -rf', 'allow')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_tool')
      expect(refusalText(result.error)).toBe('a permission must name one of the six tools')
    }
  })

  it('refuses a mode that is neither allow nor deny', async (): Promise<void> => {
    const result = await setAgentPermission(agentId, 'repo read', 'maybe' as 'allow')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(refusalText(result.error)).toBe('a permission must be allow or deny')
  })

  it('refuses an unknown agent', async (): Promise<void> => {
    const result = await setAgentPermission('00000000-0000-4000-8000-000000000000', 'repo read', 'allow')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('agent_not_found')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/control/test/integration/permission.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/permission.js"`.

- [ ] **Step 3: Write the verb**

```typescript
// packages/control/src/permission.ts
import { prisma } from '@ai-team-os/db/client'
import { type Result, err, ok } from '@ai-team-os/domain'
import type { ControlRefusal } from './refusal.js'

/**
 * The design README §3a.9's six permission columns, verbatim and in its order. ONE list: this verb
 * validates against it and `apps/web/src/server/settings.ts` renders it, so a seventh column is a
 * single edit rather than two that can disagree.
 *
 * **Not yet enforced at runtime** (Decision 7). Nothing in `packages/providers` or
 * `apps/orchestrator` reads `AgentPermission`; the matrix is editable and the page says so in
 * as many words. This verb exists so the intent is RECORDED before the enforcement lands, not so
 * the surface can pretend it is enforced.
 */
export const PERMISSION_TOOLS = [
  'repo read',
  'source write',
  'run tests',
  'create branch',
  'deploy prod',
  'read secrets',
] as const

export type PermissionTool = (typeof PERMISSION_TOOLS)[number]

function isPermissionTool(value: string): value is PermissionTool {
  return (PERMISSION_TOOLS as readonly string[]).includes(value)
}

export async function setAgentPermission(
  agentId: string,
  tool: string,
  mode: 'allow' | 'deny',
): Promise<Result<void, ControlRefusal>> {
  if (!isPermissionTool(tool)) return err({ kind: 'invalid_tool', tool })
  if (mode !== 'allow' && mode !== 'deny') return err({ kind: 'invalid_permission_mode', mode: String(mode) })

  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } })
  if (agent === null) return err({ kind: 'agent_not_found', agentId })

  // `@@unique([agentId, tool])` makes this a flip in place — the same "one row or none" shape
  // `setWorkspaceProvider` keeps for its own table.
  await prisma.agentPermission.upsert({
    where: { agentId_tool: { agentId, tool } },
    update: { mode },
    create: { agentId, tool, mode },
  })
  return ok(undefined)
}
```

Add the two refusal members and their texts; add `export * from './permission.js'` to
`packages/control/src/index.ts`.

- [ ] **Step 4: Run the control test to green**

Run: `npx vitest run packages/control/test/integration/permission.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route tests**

Append to `apps/web/test/integration/org-routes.test.ts`:

```typescript
  describe('PUT /api/agents/[agentId]/permission', () => {
    it('writes the cell and returns 200', async (): Promise<void> => {
      const agentId = await seedAgent()
      const response = await permissionPUT(jsonPutRequest({ tool: 'repo read', mode: 'allow' }), agentParams(agentId))
      expect(response.status).toBe(200)
      expect(await prisma.agentPermission.count({ where: { agentId } })).toBe(1)
    })

    it('409s with the verbatim refusal on a tool outside the six', async (): Promise<void> => {
      const response = await permissionPUT(jsonPutRequest({ tool: 'rm -rf', mode: 'allow' }), agentParams(await seedAgent()))
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'a permission must name one of the six tools' })
    })

    it('400s on a malformed body and on a missing mode', async (): Promise<void> => {
      const agentId = await seedAgent()
      expect((await permissionPUT(malformedPutRequest(), agentParams(agentId))).status).toBe(400)
      expect((await permissionPUT(jsonPutRequest({ tool: 'repo read' }), agentParams(agentId))).status).toBe(400)
    })
  })

  describe('POST /api/dev/reseed', () => {
    it('404s outside development, so a production build cannot reach it at all', async (): Promise<void> => {
      const previous = process.env['NODE_ENV']
      Object.defineProperty(process.env, 'NODE_ENV', { value: 'production', configurable: true })
      try {
        expect((await reseedPOST()).status).toBe(404)
      } finally {
        Object.defineProperty(process.env, 'NODE_ENV', { value: previous, configurable: true })
      }
    })
  })
```

Add `import { PUT as permissionPUT } from '../../src/app/api/agents/[agentId]/permission/route.js'`
and `import { POST as reseedPOST } from '../../src/app/api/dev/reseed/route.js'`, plus a
`jsonPutRequest`/`malformedPutRequest`/`agentParams` trio mirroring this file's existing
`jsonRequest`/`params` helpers.

- [ ] **Step 6: Write the two routes**

```typescript
// apps/web/src/app/api/agents/[agentId]/permission/route.ts
import { setAgentPermission } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../../server/orgControlRoute'

export const dynamic = 'force-dynamic'

export async function PUT(
  request: Request,
  context: { params: Promise<{ agentId: string }> },
): Promise<Response> {
  const { agentId } = await context.params
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') {
    return Response.json({ error: 'the body must be { "tool": string, "mode": "allow" | "deny" }' }, { status: 400 })
  }
  const { tool, mode } = body as { tool?: unknown; mode?: unknown }
  if (typeof tool !== 'string' || (mode !== 'allow' && mode !== 'deny')) {
    return Response.json({ error: 'the body must be { "tool": string, "mode": "allow" | "deny" }' }, { status: 400 })
  }
  // The tool string is handed on unvalidated: `setAgentPermission` owns `invalid_tool` and its
  // verbatim text, and a second list here is a second place for the six to go stale.
  return orgControlResponse(() => setAgentPermission(agentId, tool, mode))
}
```

```typescript
// apps/web/src/app/api/dev/reseed/route.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const dynamic = 'force-dynamic'

const run = promisify(execFile)

/**
 * The Settings danger zone's `reset demo data` (M14 §5.7). Guarded by `NODE_ENV`, and guarded
 * with a 404 rather than a 403: a route that answers "forbidden" tells a production visitor that
 * a reseed endpoint exists. In production it does not exist.
 *
 * Runs the SAME `npm run db:seed` an operator would run by hand — no second definition of what
 * the seed is.
 */
export async function POST(): Promise<Response> {
  if (process.env['NODE_ENV'] === 'production') return new Response('not found', { status: 404 })
  try {
    await run('npm', ['run', 'db:seed'], { cwd: process.cwd(), timeout: 120_000 })
    return Response.json({ ok: true })
  } catch (cause) {
    return Response.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 500 })
  }
}
```

- [ ] **Step 7: Write `server/settings.ts`**

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prisma } from '@ai-team-os/db/client'
import { PERMISSION_TOOLS, capabilitiesOf, type ProviderKind } from '@ai-team-os/control'

const run = promisify(execFile)

export interface AdapterCard {
  readonly kind: string
  readonly label: string
  readonly state: 'connected' | 'not found' | 'later'
  readonly version: string | null
  readonly adapter: string
  readonly capabilities: { readonly gate: string; readonly reportsCost: boolean; readonly canPauseMidRun: boolean } | null
  readonly agentsBound: number
}

/** The two REAL adapters and the two the handoff draws but this codebase does not have. The
 *  second pair is rendered disabled and captioned `not configured · later` (Decision 7) — a card
 *  that looks functional and is not is the exact lie this milestone is about. */
const REAL: ReadonlyArray<{ kind: ProviderKind; label: string; bin: string; adapter: string }> = [
  { kind: 'claude_code', label: 'Claude Code', bin: 'claude', adapter: 'ClaudeCodeAdapter' },
  { kind: 'cursor', label: 'Cursor', bin: 'cursor-agent', adapter: 'CursorAdapter' },
]

const LATER: ReadonlyArray<{ kind: string; label: string; adapter: string }> = [
  { kind: 'codex', label: 'OpenAI Codex', adapter: 'CodexAdapter — planned' },
  { kind: 'gemini', label: 'Gemini', adapter: 'GeminiAdapter — planned' },
]

/** The binary's own `--version`, or `null` when it is not on PATH. Bounded, because a hung
 *  binary must not hang the Settings page. Honours the same `AITEAMOS_*_BIN` overrides the
 *  orchestrator does, so a fake-CLI gate run sees the fakes. */
async function versionOf(bin: string): Promise<string | null> {
  const override = bin === 'claude' ? process.env['AITEAMOS_CLAUDE_BIN'] : process.env['AITEAMOS_CURSOR_BIN']
  try {
    const { stdout } = await run(override !== undefined && override !== '' ? override : bin, ['--version'], { timeout: 10_000 })
    return stdout.trim().split('\n')[0] ?? null
  } catch {
    return null
  }
}

export async function buildProviderAdapters(): Promise<readonly AdapterCard[]> {
  const bound = await prisma.agentRun.groupBy({ by: ['provider'], _count: { _all: true } })
  const countFor = (kind: string): number => bound.find((row) => row.provider === kind)?._count._all ?? 0

  const real = await Promise.all(
    REAL.map(async (adapter): Promise<AdapterCard> => {
      const version = await versionOf(adapter.bin)
      const capabilities = capabilitiesOf(adapter.kind)
      return {
        kind: adapter.kind,
        label: adapter.label,
        // Connect state IS "the binary is on PATH" — nothing else is checkable without spending
        // money, and a green dot that means "we assume so" is worthless.
        state: version === null ? 'not found' : 'connected',
        version,
        adapter: adapter.adapter,
        capabilities: {
          gate: capabilities.gate,
          reportsCost: capabilities.reportsCost,
          canPauseMidRun: capabilities.canPauseMidRun,
        },
        agentsBound: countFor(adapter.kind),
      }
    }),
  )

  return [
    ...real,
    ...LATER.map((adapter): AdapterCard => ({
      kind: adapter.kind,
      label: adapter.label,
      state: 'later',
      version: null,
      adapter: adapter.adapter,
      capabilities: null,
      agentsBound: 0,
    })),
  ]
}

export interface PermissionRow {
  readonly agentId: string
  readonly name: string
  readonly role: string
  readonly cells: readonly { readonly tool: string; readonly mode: 'allow' | 'deny' | null }[]
}

export async function buildPermissionMatrix(): Promise<readonly PermissionRow[]> {
  const [agents, permissions] = await Promise.all([
    prisma.agent.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, role: true } }),
    prisma.agentPermission.findMany(),
  ])
  const byAgent = new Map<string, Map<string, 'allow' | 'deny'>>()
  for (const row of permissions) {
    const map = byAgent.get(row.agentId) ?? new Map<string, 'allow' | 'deny'>()
    map.set(row.tool, row.mode)
    byAgent.set(row.agentId, map)
  }

  return agents.map((agent) => ({
    agentId: agent.id,
    name: agent.name,
    role: agent.role,
    // `null` is UNSET, and the cell says so: an agent nobody has decided about is not the same as
    // one explicitly denied, and collapsing them would make the matrix claim a decision that was
    // never taken.
    cells: PERMISSION_TOOLS.map((tool) => ({ tool, mode: byAgent.get(agent.id)?.get(tool) ?? null })),
  }))
}
```

- [ ] **Step 8: Write the failing page tests**

Append to `apps/web/test/settings-page.test.tsx`:

```tsx
describe('provider adapter cards', () => {
  it('renders the two real adapters with their version and capabilities, and the two later ones disabled', () => {
    render(
      <ProviderAdapterCards
        adapters={[
          { kind: 'claude_code', label: 'Claude Code', state: 'connected', version: '2.1.234', adapter: 'ClaudeCodeAdapter', capabilities: { gate: 'all-tools', reportsCost: true, canPauseMidRun: true }, agentsBound: 5 },
          { kind: 'codex', label: 'OpenAI Codex', state: 'later', version: null, adapter: 'CodexAdapter — planned', capabilities: null, agentsBound: 0 },
        ]}
      />,
    )
    expect(screen.getByTestId('adapter-version-claude_code').textContent).toBe('2.1.234')
    expect(screen.getByTestId('adapter-capabilities-claude_code').textContent).toContain('all-tools')
    expect(screen.getByTestId('adapter-state-codex').textContent).toBe('not configured · later')
    expect((screen.getByTestId('adapter-cta-codex') as HTMLButtonElement).disabled).toBe(true)
  })

  it('says a real adapter is not found rather than pretending it is connected', () => {
    render(
      <ProviderAdapterCards
        adapters={[{ kind: 'cursor', label: 'Cursor', state: 'not found', version: null, adapter: 'CursorAdapter', capabilities: { gate: 'all-tools', reportsCost: false, canPauseMidRun: false }, agentsBound: 0 }]}
      />,
    )
    expect(screen.getByTestId('adapter-state-cursor').textContent).toBe('not found on PATH')
  })
})

describe('the permission matrix', () => {
  const rows = [{ agentId: 'a1', name: 'Alex', role: 'backend', cells: [
    { tool: 'repo read', mode: 'allow' as const },
    { tool: 'source write', mode: 'deny' as const },
    { tool: 'run tests', mode: null },
    { tool: 'create branch', mode: null },
    { tool: 'deploy prod', mode: null },
    { tool: 'read secrets', mode: null },
  ] }]

  it('renders the six README columns and a glyph per cell', () => {
    render(<PermissionMatrix rows={rows} />)
    expect(screen.getAllByTestId('perm-column').map((c) => c.textContent)).toEqual([
      'repo read', 'source write', 'run tests', 'create branch', 'deploy prod', 'read secrets',
    ])
    expect(screen.getByTestId('perm-cell-a1-repo read').textContent).toBe('✓')
    expect(screen.getByTestId('perm-cell-a1-source write').textContent).toBe('✕')
  })

  it('distinguishes an unset cell from an explicit deny in its title', () => {
    render(<PermissionMatrix rows={rows} />)
    expect(screen.getByTestId('perm-cell-a1-run tests').getAttribute('title')).toBe('not set')
    expect(screen.getByTestId('perm-cell-a1-source write').getAttribute('title')).toBe('denied')
  })

  it('captions the whole matrix as not yet enforced', () => {
    render(<PermissionMatrix rows={rows} />)
    expect(screen.getByTestId('perm-caption').textContent).toBe('not yet enforced at runtime')
  })

  it('PUTs the flipped mode on a cell click', async (): Promise<void> => {
    render(<PermissionMatrix rows={rows} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('perm-cell-a1-repo read'))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agents/a1/permission',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ tool: 'repo read', mode: 'deny' }) }),
    )
  })
})

describe('realtime transport and the danger zone', () => {
  it('shows SSE selected and WebSocket disabled', () => {
    render(<DangerZone workspaceId={null} showReseed={false} />)
    expect(screen.getByTestId('transport-sse').getAttribute('aria-checked')).toBe('true')
    expect((screen.getByTestId('transport-ws') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('transport-ws').textContent).toContain('later')
  })

  it('offers reset demo data only when the server said it is available', () => {
    const { rerender } = render(<DangerZone workspaceId={null} showReseed={false} />)
    expect(screen.queryByTestId('reseed-button')).toBeNull()

    rerender(<DangerZone workspaceId={null} showReseed />)
    expect(screen.getByTestId('reseed-button')).toBeTruthy()
  })
})
```

- [ ] **Step 9: Write the three components and wire `SettingsClient`**

`ProviderAdapterCards.tsx` — a 2-up grid of cards; each has an 8px dot in the tone
(`connected` → `working`, `not found` → `blocked`, `later` → `idle`), the label, the state text
(`connected` / `not found on PATH` / `not configured · later`), `adapter · version`, the
capability line (`gate · reports cost · pauses mid-run`), `<n> agents bound`, and a ghost CTA
disabled for a `later` card.

`PermissionMatrix.tsx` — a header row `grid-cols-[190px_repeat(6,1fr)]` with
`data-testid="perm-column"` per tool, a row per agent, each cell a 20×20 rounded-chip button:
`✓` in `text-tone-done` on `bg-tone-done/10` for `allow`, `✕` in `text-tone-blocked` on
`bg-tone-blocked/8` for `deny` and for `null`, `title` of `allowed` / `denied` / `not set`.
Clicking PUTs the OPPOSITE of the current effective value (`allow` when unset or denied, `deny`
when allowed) through `postControl`-shaped `fetch(url, { method: 'PUT', … })`, and shows a refusal
verbatim in a `role="alert"` span. Beneath, `<p data-testid="perm-caption">not yet enforced at
runtime</p>`.

`DangerZone.tsx` — a `REALTIME TRANSPORT` panel (an `aria-checked` SSE row and a `disabled`
WebSocket button reading `WebSocket · later`), and a `DANGER ZONE` panel bordered
`border-tone-blocked/22` holding `EmergencyStopButton` (when `workspaceId !== null`) and, when
`showReseed`, a `reseed-button` POSTing `/api/dev/reseed`.

`SettingsClient.tsx` takes `adapters`, `permissions` and `showReseed` and renders, in order:
`Panel title="provider adapters"` → `ProviderAdapterCards`; `Panel title="agent permissions"` →
`PermissionMatrix`; `DangerZone`; then the existing `Template catalog` and `Companies` panels
unchanged.

`app/settings/page.tsx` adds `buildProviderAdapters()` and `buildPermissionMatrix()` to its
`Promise.all` and passes `showReseed={process.env['NODE_ENV'] !== 'production'}` — computed on the
SERVER, so the client never has to guess.

- [ ] **Step 10: Run the tests to green**

Run: `npx vitest run apps/web/test/settings-page.test.tsx apps/web/test/integration/org-routes.test.ts packages/control/test/integration/permission.test.ts`
Expected: PASS.

- [ ] **Step 11: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/control/src/permission.ts packages/control/src/index.ts packages/control/src/refusal.ts packages/control/test/integration/permission.test.ts "apps/web/src/app/api/agents/[agentId]/permission/route.ts" apps/web/src/app/api/dev/reseed/route.ts apps/web/src/server/settings.ts apps/web/src/components/ProviderAdapterCards.tsx apps/web/src/components/PermissionMatrix.tsx apps/web/src/components/DangerZone.tsx apps/web/src/components/SettingsClient.tsx apps/web/src/app/settings/page.tsx apps/web/test/settings-page.test.tsx apps/web/test/integration/org-routes.test.ts
git commit -m "feat(web): Settings shows what is real, and says plainly what is not enforced"
```

---

### Task 15 (C8): Skills

**Files:**
- Create: `apps/web/src/server/skills.ts`
- Create: `apps/web/src/components/SkillsClient.tsx`
- Create: `apps/web/src/app/skills/page.tsx`
- Create: `apps/web/src/app/api/skills/assign/route.ts`
- Test: `apps/web/test/skills-page.test.tsx` (create)
- Test: `apps/web/test/integration/skills-snapshot.test.ts` (create)

**Interfaces:**
- Consumes: `assignSkill`/`unassignSkill` (Task 6); `AgentRun.skillCalls` (Task 4);
  `Skill.missingSince` (Task 6); `EmptyTile`, `PanelHeader`, `Chip`, `AvatarTile`.
- Produces:

```typescript
// apps/web/src/server/skills.ts
export interface SkillRow {
  readonly id: string
  readonly name: string
  readonly description: string
  /** Summed `AgentRun.skillCalls[name]` across every run. `0` is a measured zero here: the tally
   *  exists on every concluded run, so a skill with no calls really has none. */
  readonly runs: number
  /** `'missing'` when `missingSince` is set — the skill is gone from disk but its history is not
   *  (Decision 6). */
  readonly state: 'ready' | 'missing'
  readonly agentIds: readonly string[]
}

export interface SkillProviderRow {
  readonly id: string
  readonly name: string
  readonly skills: readonly SkillRow[]
}

export interface SkillsPage {
  readonly providers: readonly SkillProviderRow[]
  readonly agents: readonly { readonly id: string; readonly name: string; readonly status: string }[]
  /** The three directories `syncSkillCatalog` scans, for the "add skill source" tile. Shown, not
   *  editable — there is no write path, and a tile that looked editable would be one. */
  readonly scannedRoots: readonly string[]
}

export async function buildSkillsPage(): Promise<SkillsPage>
```

- [ ] **Step 1: Write the failing DTO test**

```typescript
// apps/web/test/integration/skills-snapshot.test.ts
import { prisma } from '@ai-team-os/db/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildSkillsPage } from '../../src/server/skills.js'

let agentId: string
let skillId: string

describe('buildSkillsPage', () => {
  beforeEach(async (): Promise<void> => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExecutionEvent", "AgentSkill", "Skill", "SkillProvider", "AgentPermission", "Checkpoint", "AgentRun", "TaskDependency", "Task", "Agent", "Team", "Workspace" RESTART IDENTITY CASCADE',
    )
    const workspace = await prisma.workspace.create({
      data: { name: 'W', repoPath: '/tmp/skills-page', verifyCommands: ['true'], setupCommands: [] },
    })
    const team = await prisma.team.create({ data: { workspaceId: workspace.id, name: 'T' } })
    agentId = (await prisma.agent.create({ data: { teamId: team.id, name: 'Alex', role: 'backend' } })).id
    const provider = await prisma.skillProvider.create({ data: { name: 'plugin:superpowers' } })
    skillId = (await prisma.skill.create({ data: { providerId: provider.id, name: 'writing-plans', description: 'plans things' } })).id
  })

  afterAll(async (): Promise<void> => {
    await prisma.$disconnect()
  })

  it('groups skills under their provider and reports zero runs before any run has concluded', async (): Promise<void> => {
    const page = await buildSkillsPage()
    expect(page.providers.map((p) => p.name)).toEqual(['plugin:superpowers'])
    expect(page.providers[0]?.skills[0]?.runs).toBe(0)
    expect(page.providers[0]?.skills[0]?.state).toBe('ready')
  })

  it('sums the run tallies across every run that recorded one', async (): Promise<void> => {
    await prisma.agentRun.create({
      data: { agentId, status: 'succeeded', provider: 'claude_code', skillCalls: { 'writing-plans': 2, brainstorming: 5 } },
    })
    await prisma.agentRun.create({
      data: { agentId, status: 'failed', provider: 'claude_code', skillCalls: { 'writing-plans': 1 } },
    })
    // A run that reported nothing contributes nothing, and does not become a zero.
    await prisma.agentRun.create({ data: { agentId, status: 'succeeded', provider: 'cursor', skillCalls: null } })

    const page = await buildSkillsPage()
    expect(page.providers[0]?.skills.find((s) => s.name === 'writing-plans')?.runs).toBe(3)
  })

  it('reports a vanished skill as missing rather than dropping it', async (): Promise<void> => {
    await prisma.skill.update({ where: { id: skillId }, data: { missingSince: new Date() } })
    const page = await buildSkillsPage()
    expect(page.providers[0]?.skills[0]?.state).toBe('missing')
  })

  it('lists the agents a skill is assigned to', async (): Promise<void> => {
    await prisma.agentSkill.create({ data: { agentId, skillId } })
    const page = await buildSkillsPage()
    expect(page.providers[0]?.skills[0]?.agentIds).toEqual([agentId])
  })

  it('names the three scanned roots without offering to change them', async (): Promise<void> => {
    const page = await buildSkillsPage()
    expect(page.scannedRoots).toHaveLength(3)
    expect(page.scannedRoots.some((root) => root.endsWith('.claude/skills'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/test/integration/skills-snapshot.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/server/skills.js"`.

- [ ] **Step 3: Write `server/skills.ts`**

```typescript
import { homedir } from 'node:os'
import { join } from 'node:path'
import { prisma } from '@ai-team-os/db/client'
import { toRunState } from '@ai-team-os/db'
import { deriveAgentStatus, NON_TERMINAL_RUN_STATUSES } from '@ai-team-os/domain'

export interface SkillRow {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly runs: number
  readonly state: 'ready' | 'missing'
  readonly agentIds: readonly string[]
}

export interface SkillProviderRow {
  readonly id: string
  readonly name: string
  readonly skills: readonly SkillRow[]
}

export interface SkillsPage {
  readonly providers: readonly SkillProviderRow[]
  readonly agents: readonly { readonly id: string; readonly name: string; readonly status: string }[]
  readonly scannedRoots: readonly string[]
}

/**
 * The Skills page's snapshot (M14 §5.8). Run counts are summed from `AgentRun.skillCalls`, which
 * is an END-OF-RUN fact (§4.1): a run in flight contributes nothing, so a skill invoked by a live
 * run shows its previous total until that run concludes. Stated here because a page of counts
 * that silently trails the board is worse than one that says it does.
 */
export async function buildSkillsPage(): Promise<SkillsPage> {
  const [providers, runs, assignments, agents, liveRuns] = await Promise.all([
    prisma.skillProvider.findMany({ orderBy: { name: 'asc' }, include: { skills: { orderBy: { name: 'asc' } } } }),
    prisma.agentRun.findMany({ where: { skillCalls: { not: null } }, select: { skillCalls: true } }),
    prisma.agentSkill.findMany(),
    prisma.agent.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma.agentRun.findMany({
      where: { status: { in: [...NON_TERMINAL_RUN_STATUSES] } },
      select: { agentId: true, status: true, toolCalls: true, sessionId: true, pausedAtStep: true },
    }),
  ])

  // `skillCalls` keys are the skill NAMES the pump recorded (`"superpowers:writing-plans"`), which
  // may not match a `Skill.name` (`"writing-plans"`) — the plugin prefix is part of the invocation
  // and not of the row. Matched on the trailing segment, and documented rather than hidden: a
  // rename on either side shows up as a zero count, not as a wrong one.
  const totals = new Map<string, number>()
  for (const run of runs) {
    for (const [name, count] of Object.entries((run.skillCalls as Record<string, number> | null) ?? {})) {
      const key = name.includes(':') ? (name.split(':').at(-1) ?? name) : name
      if (typeof count === 'number') totals.set(key, (totals.get(key) ?? 0) + count)
    }
  }

  const agentsBySkill = new Map<string, string[]>()
  for (const row of assignments) {
    const list = agentsBySkill.get(row.skillId)
    if (list === undefined) agentsBySkill.set(row.skillId, [row.agentId])
    else list.push(row.agentId)
  }

  const statusByAgent = new Map(liveRuns.map((run) => [run.agentId, deriveAgentStatus(toRunState(run))] as const))

  return {
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      skills: provider.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        runs: totals.get(skill.name) ?? 0,
        state: skill.missingSince === null ? ('ready' as const) : ('missing' as const),
        agentIds: agentsBySkill.get(skill.id) ?? [],
      })),
    })),
    agents: agents.map((agent) => ({ id: agent.id, name: agent.name, status: statusByAgent.get(agent.id) ?? 'idle' })),
    // The same three `syncSkillCatalog` scans, named so the "add skill source" tile can SHOW them.
    // Read-only, deliberately: there is no write path for a fourth root, and a tile that accepted
    // input would be one that silently discarded it (Decision 7).
    scannedRoots: [
      join(homedir(), '.claude', 'skills'),
      join(homedir(), '.claude', 'plugins', 'cache'),
      join(process.cwd(), '.claude', 'skills'),
    ],
  }
}
```

- [ ] **Step 4: Write the failing page test**

```tsx
// apps/web/test/skills-page.test.tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillsClient } from '../src/components/SkillsClient.js'
import type { SkillsPage } from '../src/server/skills.js'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: (): void => {} }) }))

function page(over: Partial<SkillsPage> = {}): SkillsPage {
  return {
    providers: [
      {
        id: 'p1',
        name: 'plugin:superpowers',
        skills: [
          { id: 's1', name: 'writing-plans', description: 'plans things', runs: 18, state: 'ready', agentIds: [] },
          { id: 's2', name: 'brainstorming', description: 'explores intent', runs: 24, state: 'ready', agentIds: ['a1'] },
          { id: 's3', name: 'gone', description: 'was here once', runs: 2, state: 'missing', agentIds: [] },
        ],
      },
    ],
    agents: [{ id: 'a1', name: 'Alex Turner', status: 'working' }],
    scannedRoots: ['/home/x/.claude/skills', '/home/x/.claude/plugins/cache', '/repo/.claude/skills'],
    ...over,
  }
}

describe('SkillsClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('groups skills under their provider with run counts and usage bars normalized to the busiest', () => {
    render(<SkillsClient page={page()} />)
    expect(screen.getByTestId('provider-name-p1').textContent).toBe('plugin:superpowers')
    expect(screen.getByTestId('skill-runs-s2').textContent).toBe('24')
    // `brainstorming` is the busiest, so its bar is full and `writing-plans` is 18/24.
    expect(screen.getByTestId('skill-bar-s2').style.width).toBe('100%')
    expect(screen.getByTestId('skill-bar-s1').style.width).toBe('75%')
  })

  it('marks a skill whose file is gone as missing without hiding its history', () => {
    render(<SkillsClient page={page()} />)
    expect(screen.getByTestId('skill-state-s3').textContent).toBe('missing')
    expect(screen.getByTestId('skill-runs-s3').textContent).toBe('2')
  })

  it('renders every skill as a domain tile tagged by its provider', () => {
    render(<SkillsClient page={page()} />)
    expect(screen.getAllByTestId('domain-tile')).toHaveLength(3)
    expect(screen.getAllByTestId('domain-source')[0]?.textContent).toBe('plugin:superpowers')
  })

  it('shows the three scanned roots on the add-source tile and offers no way to change them', () => {
    render(<SkillsClient page={page()} />)
    fireEvent.click(screen.getByTestId('empty-tile'))
    expect(screen.getByTestId('scanned-roots').textContent).toContain('/repo/.claude/skills')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('assigns a skill to the chosen agent and unassigns it again', async (): Promise<void> => {
    render(<SkillsClient page={page()} />)
    await act(async () => {
      fireEvent.change(screen.getByTestId('skill-agent-s1'), { target: { value: 'a1' } })
      fireEvent.click(screen.getByTestId('skill-assign-s1'))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/skills/assign',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ agentId: 'a1', skillId: 's1' }) }),
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('skill-unassign-s2-a1'))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/skills/assign',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ agentId: 'a1', skillId: 's2' }) }),
    )
  })

  it('shows a refusal verbatim', async (): Promise<void> => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'no skill with id s1' }), { status: 409 }))
    render(<SkillsClient page={page()} />)
    await act(async () => {
      fireEvent.change(screen.getByTestId('skill-agent-s1'), { target: { value: 'a1' } })
      fireEvent.click(screen.getByTestId('skill-assign-s1'))
    })
    expect(screen.getByTestId('skills-error').textContent).toBe('no skill with id s1')
  })
})
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npx vitest run apps/web/test/skills-page.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/components/SkillsClient.js"`.

- [ ] **Step 6: Write the client, the page and the route**

`SkillsClient.tsx` — a `grid-cols-[1fr_340px] gap-[16px] p-[18px_20px]` layout. LEFT: per
provider, a `PanelHeader` with the provider name (`data-testid="provider-name-<id>"`) and the
`shared · not copied into agents` chip, then one row per skill: the mono name, the state
(`ready` / `missing`, `data-testid="skill-state-<id>"`), a 3px usage bar whose inline
`style={{ width: … }}` is `runs / maxRuns * 100` rounded (`data-testid="skill-bar-<id>"`), the
run count (`data-testid="skill-runs-<id>"`) with a `runs · all time` caption, an `<select
data-testid="skill-agent-<id>">` of `page.agents`, an assign `Button`
(`data-testid="skill-assign-<id>"`), and one `Chip` per assigned agent carrying an unassign button
(`data-testid="skill-unassign-<skillId>-<agentId>"`). RIGHT: a `DOMAIN SKILLS` 2-column grid of
`domain-tile`s, each the skill name plus a `domain-source` tag of its provider name, then an
`EmptyTile label="add skill source"` which, when clicked, reveals a
`<div data-testid="scanned-roots">` listing `page.scannedRoots` — no input, no write.

Both actions go through one helper:

```typescript
  const send = async (method: 'POST' | 'DELETE', agentId: string, skillId: string): Promise<void> => {
    setErrorText(null)
    const response = await fetch('/api/skills/assign', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, skillId }),
    })
    if (response.ok) {
      router.refresh()
      return
    }
    const data: unknown = await response.json().catch(() => null)
    setErrorText(errorMessage(data, response.status))
  }
```

(`errorMessage` from `lib/postControl.ts`; `postControl` itself only speaks POST, and this route
needs DELETE too.)

```typescript
// apps/web/src/app/api/skills/assign/route.ts
import { assignSkill, unassignSkill } from '@ai-team-os/control'
import { orgControlResponse } from '../../../../server/orgControlRoute'

export const dynamic = 'force-dynamic'

async function pair(request: Request): Promise<{ agentId: string; skillId: string } | null> {
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return null
  const { agentId, skillId } = body as { agentId?: unknown; skillId?: unknown }
  if (typeof agentId !== 'string' || typeof skillId !== 'string') return null
  return { agentId, skillId }
}

export async function POST(request: Request): Promise<Response> {
  const parsed = await pair(request)
  if (parsed === null) return Response.json({ error: 'the body must be { "agentId": string, "skillId": string }' }, { status: 400 })
  return orgControlResponse(() => assignSkill(parsed.agentId, parsed.skillId))
}

export async function DELETE(request: Request): Promise<Response> {
  const parsed = await pair(request)
  if (parsed === null) return Response.json({ error: 'the body must be { "agentId": string, "skillId": string }' }, { status: 400 })
  return orgControlResponse(() => unassignSkill(parsed.agentId, parsed.skillId))
}
```

```tsx
// apps/web/src/app/skills/page.tsx
import { buildSkillsPage } from '../../server/skills'
import { SkillsClient } from '../../components/SkillsClient'

export const dynamic = 'force-dynamic'

/** `/skills` is GLOBAL — the catalog is a fact about the daemon host's disk, not about a
 *  workspace (M14 §5, routes note). */
export default async function SkillsPage(): Promise<React.JSX.Element> {
  return <SkillsClient page={await buildSkillsPage()} />
}
```

- [ ] **Step 7: Run the tests to green**

Run: `npx vitest run apps/web/test/skills-page.test.tsx apps/web/test/integration/skills-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/server/skills.ts apps/web/src/components/SkillsClient.tsx apps/web/src/app/skills/page.tsx apps/web/src/app/api/skills/assign/route.ts apps/web/test/skills-page.test.tsx apps/web/test/integration/skills-snapshot.test.ts
git commit -m "feat(web): the Skills page counts real invocations and never hides a vanished skill"
```

---

### Task 16 (C9): Analytics

**Files:**
- Create: `apps/web/src/components/BarChart.tsx`
- Create: `apps/web/src/components/AnalyticsClient.tsx`
- Create: `apps/web/src/app/analytics/page.tsx`
- Test: `apps/web/test/analytics-page.test.tsx` (create)

**Interfaces:**
- Consumes: `buildAnalytics` (Task 7), `listProjects` (for the workspace selector), `AvatarTile`,
  `ProgressBar`, `DataTable`/`Row`, `StatStrip`.
- Produces:

```tsx
// apps/web/src/components/BarChart.tsx
/**
 * The 7-day stacked bar chart, hand-rolled SVG — no chart library (spec §5.9). Named `BarChart`
 * rather than folded into `Sparkline`: `Sparkline` draws ONE polyline from a bucket array and is
 * consumed by the agent card and the activity header; a stacked two-series bar chart with day
 * labels and value captions shares none of that geometry, and widening `Sparkline` to cover both
 * would leave every existing caller passing flags it does not use.
 */
export function BarChart({
  series,
  height,
  label,
}: {
  readonly series: readonly DayCount[]
  readonly height: number
  readonly label: string
}): React.JSX.Element
```

```tsx
// apps/web/src/components/AnalyticsClient.tsx
export function AnalyticsClient({
  snapshot,
  workspaces,
  seeded,
}: {
  readonly snapshot: AnalyticsSnapshot
  readonly workspaces: readonly { readonly id: string; readonly name: string }[]
  /** True for the seeded development workspace — the ONE labelled exception to "no placeholder
   *  data" (Decision 3), rendered as the README's own caption. */
  readonly seeded: boolean
}): React.JSX.Element
```

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/test/analytics-page.test.tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AnalyticsClient } from '../src/components/AnalyticsClient.js'
import { BarChart } from '../src/components/BarChart.js'
import type { AnalyticsSnapshot } from '../src/server/analytics.js'

const routerPush = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush }), useSearchParams: () => new URLSearchParams() }))

function snapshot(over: Partial<AnalyticsSnapshot> = {}): AnalyticsSnapshot {
  return {
    workspaceId: 'w1',
    series: [
      { day: '2026-08-23', succeeded: 6, failed: 1 },
      { day: '2026-08-24', succeeded: 0, failed: 0 },
      { day: '2026-08-25', succeeded: 12, failed: 3 },
      { day: '2026-08-26', succeeded: 4, failed: 0 },
      { day: '2026-08-27', succeeded: 9, failed: 2 },
      { day: '2026-08-28', succeeded: 1, failed: 0 },
      { day: '2026-08-29', succeeded: 3, failed: 1 },
    ],
    kpis: [
      { label: 'Task success rate', value: '92%', note: '23 of 25' },
      { label: 'Avg run duration', value: '14m 20s', note: 'over 25 run(s)' },
      { label: 'Spend', value: '$8.43', note: '2 runs unmeasured' },
      { label: 'Tool calls', value: '482', note: null },
      { label: 'Pauses', value: '7', note: null },
      { label: 'Active agents', value: '3', note: null },
    ],
    perAgent: [
      { agentId: 'a1', name: 'Alex Turner', role: 'backend', runs: 42, successPct: 95, avgDurationMs: 760_000, tokens: 1_400_000, costUsd: 3.02, unmeasuredRuns: 0 },
      { agentId: 'a2', name: 'Bea Ng', role: 'qa', runs: 0, successPct: null, avgDurationMs: null, tokens: null, costUsd: 0, unmeasuredRuns: 0 },
    ],
    ...over,
  }
}

const workspaces = [{ id: 'w1', name: 'Checkout' }, { id: 'w2', name: 'Portal' }]

describe('BarChart', () => {
  it('draws one column per day, stacked, with the busiest day at full height', () => {
    render(<BarChart series={snapshot().series} height={180} label="tasks completed, last 7 days" />)
    expect(screen.getAllByTestId('bar-column')).toHaveLength(7)
    // The busiest day is 12+3 = 15; its succeeded segment is 12/15 of the 180px column.
    expect(screen.getByTestId('bar-ok-2026-08-25').getAttribute('height')).toBe('144')
    expect(screen.getByTestId('bar-fail-2026-08-25').getAttribute('height')).toBe('36')
  })

  it('draws nothing but the baseline for a day with no runs', () => {
    render(<BarChart series={snapshot().series} height={180} label="x" />)
    expect(screen.getByTestId('bar-ok-2026-08-24').getAttribute('height')).toBe('0')
  })

  it('carries an accessible label rather than being a decorative blob', () => {
    render(<BarChart series={snapshot().series} height={180} label="tasks completed, last 7 days" />)
    expect(screen.getByRole('img', { name: 'tasks completed, last 7 days' })).toBeTruthy()
  })
})

describe('AnalyticsClient', () => {
  it('renders six KPI tiles with their notes', () => {
    render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    expect(screen.getAllByTestId('kpi-tile')).toHaveLength(6)
    expect(screen.getByTestId('kpi-note-Spend').textContent).toBe('2 runs unmeasured')
    expect(screen.queryByTestId('kpi-note-Pauses')).toBeNull()
  })

  it('renders the per-agent table with unknown marks where nothing was measured', () => {
    render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    expect(screen.getByTestId('perf-tokens-a1').textContent).toBe('1.4M')
    expect(screen.getByTestId('perf-tokens-a2').textContent).toBe('—')
    expect(screen.getByTestId('perf-success-a2').textContent).toBe('—')
    expect(screen.getByTestId('perf-avg-a2').textContent).toBe('—')
  })

  it('shows the seeded caption only on the seeded workspace', () => {
    const { rerender } = render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded />)
    expect(screen.getByTestId('analytics-caption').textContent).toBe('Last 7 days · seeded development data')

    rerender(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    expect(screen.getByTestId('analytics-caption').textContent).toBe('Last 7 days')
  })

  it('navigates on a workspace change, including to the all-workspaces view', () => {
    render(<AnalyticsClient snapshot={snapshot()} workspaces={workspaces} seeded={false} />)
    fireEvent.change(screen.getByLabelText('workspace'), { target: { value: 'w2' } })
    expect(routerPush).toHaveBeenCalledWith('/analytics?workspace=w2')

    fireEvent.change(screen.getByLabelText('workspace'), { target: { value: '' } })
    expect(routerPush).toHaveBeenCalledWith('/analytics')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/test/analytics-page.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/components/BarChart.js"`.

- [ ] **Step 3: Write `BarChart.tsx`**

```tsx
import type { DayCount } from '../server/analytics'

const COLUMN_WIDTH = 28
const GAP = 14

/**
 * The 7-day stacked bar chart (design README §3a.8): successes in the `working` teal, failures in
 * `#f87171`, drawn as plain SVG rects. No chart library — the README's own note ("every glyph is
 * text or a CSS shape") and this codebase's `Sparkline` precedent.
 *
 * Heights are normalized to the BUSIEST day's total, not to a fixed ceiling: seven bars scaled to
 * an arbitrary maximum would render a quiet week as seven slivers, and the chart's job is
 * comparing days against each other.
 */
export function BarChart({
  series,
  height,
  label,
}: {
  readonly series: readonly DayCount[]
  readonly height: number
  readonly label: string
}): React.JSX.Element {
  const max = Math.max(1, ...series.map((day) => day.succeeded + day.failed))
  const width = series.length * COLUMN_WIDTH + (series.length - 1) * GAP

  return (
    <svg role="img" aria-label={label} width="100%" height={height + 28} viewBox={`0 0 ${width} ${height + 28}`} xmlns="http://www.w3.org/2000/svg">
      {series.map((day, index) => {
        const x = index * (COLUMN_WIDTH + GAP)
        const okHeight = Math.round((day.succeeded / max) * height)
        const failHeight = Math.round((day.failed / max) * height)
        return (
          <g key={day.day} data-testid="bar-column" data-day={day.day}>
            <rect
              data-testid={`bar-fail-${day.day}`}
              x={x}
              y={height - okHeight - failHeight}
              width={COLUMN_WIDTH}
              height={failHeight}
              rx="2"
              fill="rgba(248,113,113,.55)"
            />
            <rect
              data-testid={`bar-ok-${day.day}`}
              x={x}
              y={height - okHeight}
              width={COLUMN_WIDTH}
              height={okHeight}
              rx="2"
              fill="var(--color-tone-working)"
            />
            <text x={x + COLUMN_WIDTH / 2} y={height + 16} textAnchor="middle" className="fill-text-3 font-mono text-[9.5px]">
              {/* `2026-08-25` → `08-25`: the year is the same for all seven and costs width. */}
              {day.day.slice(5)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
```

- [ ] **Step 4: Write `AnalyticsClient.tsx` and the page**

`AnalyticsClient` renders, top to bottom:

1. A header row: `<select aria-label="workspace">` with an `''` option labelled
   `all workspaces` plus one per workspace, `onChange` pushing
   `/analytics?workspace=<id>` (or `/analytics` for `''`); and
   `<p data-testid="analytics-caption">` reading `Last 7 days · seeded development data` when
   `seeded`, otherwise `Last 7 days`.
2. A 6-up KPI strip, `grid-cols-6 gap-px bg-line`, each tile
   `data-testid="kpi-tile"` with a 10.5px label, a `font-mono text-[20px] tracking-[-.8px]` value,
   and, only when `note !== null`, a `data-testid={`kpi-note-${label}`}` 9.5px line.
3. A two-column `grid-cols-2 gap-[16px]` row: a `Panel title="tasks completed · 7 days"` holding
   `<BarChart series={snapshot.series} height={180} label="tasks completed, last 7 days" />`, and
   a `Panel title="agent performance"` holding a `DataTable` with
   `columns="1fr 46px 80px 70px 90px 60px"` and header
   `['Agent', 'Runs', 'Success', 'Avg', 'Tokens', 'Cost']`. Each row: `AvatarTile` + name/role,
   the run count, a 34px `ProgressBar` plus `successPct` (`data-testid={`perf-success-${id}`}`,
   `—` when null), `formatDuration(avgDurationMs)` (`data-testid={`perf-avg-${id}`}`, `—` when
   null), `formatTokens(tokens)` (`data-testid={`perf-tokens-${id}`}`, `—` when null), and
   `$cost`. `formatDuration` is imported from `server/analytics.ts` and `formatTokens` from
   `components/WorkersTable.tsx` — both already exported, neither re-implemented.

```tsx
// apps/web/src/app/analytics/page.tsx
import { buildAnalytics } from '../../server/analytics'
import { listProjects } from '../../server/org'
import { AnalyticsClient } from '../../components/AnalyticsClient'

export const dynamic = 'force-dynamic'

/** `/analytics` is GLOBAL, with an optional `?workspace=` scope (M14 §5, routes note). */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>
}): Promise<React.JSX.Element> {
  const { workspace } = await searchParams
  const workspaceId = workspace === undefined || workspace === '' ? null : workspace
  const [snapshot, projects] = await Promise.all([buildAnalytics(workspaceId), listProjects()])
  const selected = projects.find((project) => project.id === workspaceId) ?? null
  return (
    <AnalyticsClient
      snapshot={snapshot}
      workspaces={projects.map((project) => ({ id: project.id, name: project.name }))}
      // The README's own caption, on the workspace `db:seed` creates and nowhere else (Decision 3).
      // Matched on the seed's literal name rather than a column: adding an `isSeeded` flag to
      // `Workspace` for one caption is a schema change for a label.
      seeded={selected?.name === 'Checkout Platform'}
    />
  )
}
```

Confirm the seeded workspace's literal name against `packages/db/src/seed.ts` before writing it;
if it differs, use whatever that file creates.

- [ ] **Step 5: Run the test to green**

Run: `npx vitest run apps/web/test/analytics-page.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the full gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/BarChart.tsx apps/web/src/components/AnalyticsClient.tsx apps/web/src/app/analytics/page.tsx apps/web/test/analytics-page.test.tsx
git commit -m "feat(web): Analytics draws seven real days and never averages an unknown"
```

---
## Series D — The Fidelity Gate

### Task 17 (D1): `gate-m14-fidelity.mjs` — nine pages, one design

**Files:**
- Create: `scripts/gate-m14-fidelity.mjs`
- Create: `docs/superpowers/fidelity/m14/` (nine PNGs, written by the gate and committed)
- Modify: `package.json:31` (the `scripts` block — locate by the `gate:m13-runtime` line)
- Modify: `README.md:68` (the gate table — locate by the `gate:m13-runtime` row)

**Interfaces:**
- Consumes: everything Tasks 1-16 produced. Every `data-testid` this script queries is listed in
  step 2's inventory and was introduced by a named task.
- Produces: `npm run gate:m14-fidelity`, PASS line `nine pages, one design`, and nine committed
  screenshots.

**Shape.** `gate-m11-shell.mjs`'s skeleton, with `gate-m13-runtime.mjs`'s newer helpers: dist
imports only (`../packages/db/dist/client.js`, `../packages/control/dist/index.js`), a single
top-level `try` with **no `catch`**, `let exitCode = 1` set to `0` only by falling off the end of
the try, a `finally` that kills what it spawned and cleans up in FK order, and
`process.exit(exitCode)` as the literal last line. Every wait goes through m13's
`waitUntil(description, timeoutMs, probe)` with its `{ done: true, value } | { done: false, detail }`
protocol; `waitVisible` / `fillReliably` / `selectReliably` (three-arg) / `clickUntil` are copied
from m13 verbatim. Chromium comes from `CHROMIUM_PATH` (default `/usr/bin/chromium`), headless,
`args: ['--no-sandbox', '--disable-dev-shm-usage']`.

**Viewport: 1440×900**, not m11/m13's 1280×900 — spec §6 stage 1 names it, and the
Agents grid's `200px 130px 120px 1fr 110px 90px 80px` needs the width for the `1fr` column to
have room.

**Spend: none.** The behavior stage drives `scripts/gate-fakes/fake-claude.sh` through
`AITEAMOS_CLAUDE_BIN`, exactly as m13's rehearsal does. The gate REQUIRES the fake — it refuses to
start without `AITEAMOS_CLAUDE_BIN` set, because a gate that silently reaches a real account is
the failure Decision 10 exists to prevent.

- [ ] **Step 1: Write the script's skeleton, preflight and boot**

```js
// scripts/gate-m14-fidelity.mjs
// M14's own gate: "nine pages, one design". `gate-m11-shell.mjs`'s shape (a real `next dev`, a
// real Chromium through `playwright-core`, every assertion re-read from prisma or from the DOM)
// with `gate-m13-runtime.mjs`'s newer `waitUntil` protocol and its `finally` ordering.
//
// UNLIKE m12/m13 this gate SPENDS NOTHING and is not allowed to: its one behavior stage runs the
// fake CLI from `scripts/gate-fakes/`, and the preflight below REFUSES to start unless
// AITEAMOS_CLAUDE_BIN points at an executable. A fidelity gate that could reach a real account is
// a fidelity gate nobody will run.
//
// Its five stages, in order:
//   1. nine pages render at 1440x900, each screenshotted into docs/superpowers/fidelity/m14/
//   2. every README number read back from getComputedStyle, failing by page + property
//   3. motion: reduced-motion kills every animation; normally the sweep and the pulse are alive
//   4. behavior: two-step STOP -> halt banner on every page -> clear halt; a fake-CLI run reaches
//      `working`, pause shows pause_requested then paused; a roster click dims the stream
//   5. data: Skills lists a plugin:* provider after a sync; Analytics' counts equal a SQL count

import { execFileSync, spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { syncSkillCatalog } from '../packages/control/dist/index.js'
import { prisma } from '../packages/db/dist/client.js'

const POLL_INTERVAL_MS = 25
const ACTION_TIMEOUT_MS = 30_000
const NEXT_READY_TIMEOUT_MS = 180_000
const WORKING_TIMEOUT_MS = 120_000
const PROCESS_EXIT_TIMEOUT_MS = 20_000

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const ORCHESTRATOR_CLI = join(repoRoot, 'apps/orchestrator/dist/cli.js')
const SHOTS_DIR = join(repoRoot, 'docs/superpowers/fidelity/m14')
const runTimestamp = new Date().toISOString()

const WORKSPACE_PREFIX = 'M14 Gate Project'
const WORKSPACE_NAME = `${WORKSPACE_PREFIX} ${runTimestamp}`
const WORKER_NAME = 'Gate Worker'
const PASS_LINE = 'nine pages, one design'

let exitCode = 1
let repoPath = null
let workspaceId = null
let agentId = null
let taskId = null
let daemon = null
let daemonOutput = ''
let daemonExited = false
let nextServer = null
let browser = null
let page = null
let diagDir = null

// ... `makeRepo`, `findFreePort`, `preflightCleanup`, `dumpGateRows`, `fail`, `waitUntil`,
// `waitVisible`, `fillReliably`, `selectReliably`, `clickUntil` — copied from
// `scripts/gate-m13-runtime.mjs` verbatim, with `M13` replaced by `M14` in every message and
// `WORKSPACE_PREFIX` as the only name they filter on.

try {
  diagDir = mkdtempSync(join(tmpdir(), 'aiteamos-gate-m14-diag-'))
  console.log(`diagnostics dir: ${diagDir}`)

  // Zero spend, enforced (Decision 10). This is the ONE gate in the repo that refuses to run
  // against a real binary, rather than merely offering a rehearsal mode.
  const fakeClaude = process.env['AITEAMOS_CLAUDE_BIN']
  if (fakeClaude === undefined || fakeClaude === '') {
    throw new Error(
      'AITEAMOS_CLAUDE_BIN is not set. This gate spends nothing and must run against the fake CLI:\n' +
        '  AITEAMOS_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m14-fidelity',
    )
  }
  try {
    accessSync(fakeClaude, constants.X_OK)
  } catch {
    throw new Error(`AITEAMOS_CLAUDE_BIN=${fakeClaude} is not an executable file`)
  }
  if (!fakeClaude.includes('gate-fakes')) {
    throw new Error(
      `AITEAMOS_CLAUDE_BIN=${fakeClaude} is not one of scripts/gate-fakes/. This gate must not reach a vendor account.`,
    )
  }

  const chromiumPath = process.env['CHROMIUM_PATH'] ?? '/usr/bin/chromium'
  if (!existsSync(chromiumPath)) {
    throw new Error(`no Chromium binary at ${chromiumPath} -- set CHROMIUM_PATH to a real executable`)
  }
  if ((process.env['DATABASE_URL'] ?? '') === '') {
    throw new Error('DATABASE_URL is not set -- run this gate through `npm run gate:m14-fidelity`')
  }
  mkdirSync(SHOTS_DIR, { recursive: true })

  await preflightCleanup()

  // One workspace, one team, one worker, one task -- enough for every page to have real rows.
  repoPath = makeRepo('m14')
  const workspace = await prisma.workspace.create({
    data: {
      name: WORKSPACE_NAME,
      repoPath,
      autoMerge: true,
      verifyCommands: ['true'],
      setupCommands: [],
      goal: 'prove the nine pages render on real data',
    },
  })
  workspaceId = workspace.id
  const team = await prisma.team.create({ data: { workspaceId, name: 'Engineering' } })
  agentId = (await prisma.agent.create({ data: { teamId: team.id, name: WORKER_NAME, role: 'backend', provider: 'claude_code', model: 'sonnet' } })).id
  taskId = (await prisma.task.create({
    data: { workspaceId, title: 'Create two small files', description: 'x', status: 'ready', requiredRole: 'backend', maxAttempts: 2 },
  })).id

  const preferredPort = await findFreePort()
  nextServer = spawn('node', ['node_modules/next/dist/bin/next', 'dev', 'apps/web', '-p', String(preferredPort)], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // ... the m11/m13 readiness wait, verbatim: parse `http://localhost:(\d+)` and `/Ready in \d+/`
  const baseUrl = `http://localhost:${resolvedPort}`

  browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  // 1440x900 (spec §6 stage 1), wider than m11/m13's 1280 -- the Agents grid's `1fr` column
  // needs the room, and a screenshot taken at a narrower width is not the design being reviewed.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  page.setDefaultTimeout(ACTION_TIMEOUT_MS)
  page.on('pageerror', (error) => console.error(`[browser:pageerror] ${error}`))
```

- [ ] **Step 2: Write stage 1 — nine pages render, nine screenshots**

```js
  // ==== Stage 1: nine pages render, and each is screenshotted ==============================
  const PAGES = [
    { name: 'overview', path: () => `/w/${workspaceId}`, testId: 'strip' },
    { name: 'agents', path: () => '/agents', testId: 'data-table' },
    { name: 'tasks', path: () => `/w/${workspaceId}/tasks`, testId: 'column' },
    { name: 'graph', path: () => `/w/${workspaceId}/graph`, testId: 'graph-canvas' },
    { name: 'activity', path: () => `/w/${workspaceId}/activity`, testId: 'timeline-rule' },
    { name: 'projects', path: () => '/', testId: 'project-card' },
    { name: 'skills', path: () => '/skills', testId: 'empty-tile' },
    { name: 'analytics', path: () => '/analytics', testId: 'kpi-tile' },
    { name: 'settings', path: () => '/settings', testId: 'perm-caption' },
  ]

  for (const target of PAGES) {
    await page.goto(`${baseUrl}${target.path()}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    await waitVisible(page.getByTestId(target.testId), `${target.name}'s structural marker [data-testid=${target.testId}]`)
    // The sidebar is on every one of the nine, and its own width is stage 2's first assertion --
    // asserting it is PRESENT here means a page that renders without the shell fails by name.
    await waitVisible(page.getByRole('navigation', { name: 'Primary' }), `${target.name}'s sidebar`)
    // Committed evidence (Decision 9): reviewed against the mockups page by page.
    await page.screenshot({ path: join(SHOTS_DIR, `${target.name}.png`), fullPage: true })
    console.log(`stage 1: ${target.name} rendered and captured`)
  }
  console.log('stage 1 PASSED: nine pages rendered at 1440x900, nine screenshots written')
```

- [ ] **Step 3: Write stage 2 — the numbers, from `getComputedStyle`**

```js
  // ==== Stage 2: the README's numbers, read back off the real page =========================
  /** Reads one computed property off the first match of `selector`, on the page currently open. */
  async function computed(selector, property) {
    return page.evaluate(
      ([sel, prop]) => {
        const element = document.querySelector(sel)
        if (element === null) return null
        return window.getComputedStyle(element).getPropertyValue(prop)
      },
      [selector, property],
    )
  }

  /** Asserts one number, failing by PAGE + SELECTOR + PROPERTY + both values (spec §6 stage 2:
   *  "any deviation fails with page+property"). */
  async function assertComputed(pageName, selector, property, expected) {
    const actual = await computed(selector, property)
    if (actual === null) await fail(`stage 2 (${pageName}): no element matched ${selector}`)
    // Normalized: browsers report `5px 11px` for an SVG dasharray and collapse whitespace runs.
    const normalize = (value) => value.trim().replace(/\s+/g, ' ')
    if (normalize(actual) !== normalize(expected)) {
      await fail(`stage 2 (${pageName}): ${selector} ${property} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
    }
    console.log(`stage 2 (${pageName}): ${selector} ${property} = ${actual}`)
  }

  // page, selector, property, expected -- every row is one README number.
  const NUMBERS = [
    ['overview', `/w/${workspaceId}`, 'nav[aria-label="Primary"]', 'width', '212px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="top-bar"]', 'height', '52px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="agent-card"]', 'border-radius', '8px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="agent-card"]', 'padding', '12px 13px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="avatar-tile"]', 'width', '28px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="avatar-tile"]', 'height', '28px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="status-pill"]', 'border-radius', '20px'],
    ['overview', `/w/${workspaceId}`, '[data-testid="live-events"]', 'width', '340px'],
    ['agents', '/agents', '[data-testid="data-table-header"]', 'grid-template-columns', '200px 130px 120px 1fr 110px 90px 80px'],
    ['activity', `/w/${workspaceId}/activity`, '[data-testid="timeline-rule"]', 'left', '88px'],
    ['graph', `/w/${workspaceId}/graph`, '[data-testid="graph-drawer"]', 'width', '352px'],
    ['graph', `/w/${workspaceId}/graph`, 'path[data-cable="flow"]', 'stroke-dasharray', '5px 11px'],
  ]

  let currentPath = null
  for (const [pageName, path, selector, property, expected] of NUMBERS) {
    if (path !== currentPath) {
      await page.goto(`${baseUrl}${path}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
      currentPath = path
      // The Agents tab defaults to Roster; the seven-column table is on Workers.
      if (pageName === 'agents') await clickUntil(page.getByTestId('agents-tab-workers'), async () => page.getByTestId('data-table-header').first().isVisible(), 'the Workers tab')
      // The drawer and the cable both need a selected agent node.
      if (pageName === 'graph') await clickUntil(page.locator('[data-testid="rf__node-agent:' + agentId + '"]').first(), async () => page.getByTestId('graph-drawer').first().isVisible(), 'the agent node')
    }
    await assertComputed(pageName, selector, property, expected)
  }
  console.log(`stage 2 PASSED: ${NUMBERS.length} README values read back from getComputedStyle`)
```

- [ ] **Step 4: Write stage 3 — motion, and reduced motion**

```js
  // ==== Stage 3: motion ====================================================================
  await page.goto(`${baseUrl}/w/${workspaceId}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })

  // Normally: an in-flight pill's dot pulses at 1.5s, and a `working` card sweeps at 2.2s with
  // the README's own easing. Both need a live run, which stage 4 creates -- so this half runs
  // AFTER it. Here we prove only the negative, which needs no run at all.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload({ waitUntil: 'load' })
  const animated = await page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .map((element) => ({ tag: element.tagName, testId: element.getAttribute('data-testid'), name: window.getComputedStyle(element).animationName }))
      .filter((entry) => entry.name !== '' && entry.name !== 'none'),
  )
  if (animated.length > 0) {
    await fail(`stage 3: ${animated.length} element(s) still animate under prefers-reduced-motion: ${JSON.stringify(animated.slice(0, 10))}`)
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.reload({ waitUntil: 'load' })
  console.log('stage 3a PASSED: under prefers-reduced-motion no element reports an animation-name')
```

- [ ] **Step 5: Write stage 4 — behavior, against the fake CLI**

```js
  // ==== Stage 4: behavior ==================================================================
  // 4a. Two-step STOP -> the halt banner on EVERY page -> clear halt.
  await clickUntil(page.getByTestId('emergency-stop'), async () => page.getByTestId('emergency-stop-confirm').first().isVisible(), 'the STOP button')
  await clickUntil(page.getByTestId('emergency-stop-confirm'), async () => page.getByRole('alert').first().isVisible(), 'the STOP confirmation')
  await waitUntil('the workspace to read halted in the database', 30_000, async () => {
    const row = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } })
    return row.haltedReason === null ? { done: false, detail: 'haltedReason is still null' } : { done: true, value: row.haltedReason }
  })
  for (const target of PAGES) {
    await page.goto(`${baseUrl}${target.path()}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
    // Only the five workspace-scoped pages carry a TopBar and therefore a banner; the four global
    // ones are not workspace-scoped and correctly show none.
    const scoped = ['overview', 'tasks', 'graph', 'activity'].includes(target.name)
    const hasBanner = (await page.getByRole('alert').count()) > 0
    if (scoped && !hasBanner) await fail(`stage 4a: ${target.name} shows no halt banner while the workspace is halted`)
  }
  execFileSync('node', [ORCHESTRATOR_CLI, 'clear-halt', '--workspace', workspaceId], { cwd: repoRoot, stdio: ['ignore', 'inherit', 'inherit'] })
  console.log('stage 4a PASSED: two-step STOP halted the workspace, every scoped page said so, and clear-halt released it')

  // 4b. A fake-CLI run reaches `working`; a pause shows `pause_requested` and then `paused` --
  // truth from snapshot, never optimistic (design README "State Management").
  daemon = spawn('node', [ORCHESTRATOR_CLI, 'daemon', '--workspace', workspaceId, '--period', '500'], {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon.stdout.on('data', (chunk) => {
    daemonOutput += chunk.toString()
    process.stdout.write(`[daemon] ${chunk}`)
  })
  daemon.stderr.on('data', (chunk) => process.stderr.write(`[daemon] ${chunk}`))
  daemon.on('exit', () => {
    daemonExited = true
  })

  const run = await waitUntil('a run to reach working', WORKING_TIMEOUT_MS, async () => {
    const row = await prisma.agentRun.findFirst({ where: { agentId }, orderBy: { startedAt: 'desc' } })
    if (row === null) return { done: false, detail: 'no run row yet' }
    return row.status === 'working' ? { done: true, value: row } : { done: false, detail: `run is ${row.status}` }
  })

  await page.goto(`${baseUrl}/w/${workspaceId}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitUntil('the card to show WORKING', 30_000, async () => {
    const text = await page.getByTestId('status-pill').first().textContent().catch(() => null)
    return text === 'WORKING' ? { done: true, value: text } : { done: false, detail: `pill reads ${JSON.stringify(text)}` }
  })

  // The sweep and the pulse, on a card that really is working (stage 3's positive half).
  await assertComputed('overview', '[data-testid="card-sweep"]', 'animation-duration', '2.2s')
  await assertComputed('overview', '[data-testid="card-sweep"]', 'animation-timing-function', 'cubic-bezier(0.4, 0, 0.2, 1)')
  await assertComputed('overview', '[data-testid="status-pill"] span', 'animation-duration', '1.5s')
  console.log('stage 3b PASSED: a working card sweeps at 2.2s cubic-bezier(.4,0,.2,1) and its pill dot pulses at 1.5s')

  await clickUntil(page.getByTestId('card-pause'), async () => {
    const row = await prisma.agentRun.findUnique({ where: { id: run.id } })
    return row?.status === 'pause_requested' || row?.status === 'paused'
  }, "the card's Pause button")
  await waitUntil('the run to settle on paused', 120_000, async () => {
    const row = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
    return row.status === 'paused' ? { done: true, value: row } : { done: false, detail: `run is ${row.status}` }
  })
  await waitUntil('the card to show PAUSED', 30_000, async () => {
    const text = await page.getByTestId('status-pill').first().textContent().catch(() => null)
    return text === 'PAUSED' ? { done: true, value: text } : { done: false, detail: `pill reads ${JSON.stringify(text)}` }
  })
  console.log('stage 4b PASSED: a fake-CLI run reached working, paused on request, and the card followed the snapshot at every step')

  // 4c. A roster click filters the stream and dims the rest.
  await page.goto(`${baseUrl}/w/${workspaceId}/activity`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('activity-card'), 'at least one activity card')
  const beforeDim = await page.locator('[data-testid="activity-card"]').evaluateAll((nodes) => nodes.filter((n) => n.className.includes('opacity-[.35]')).length)
  if (beforeDim !== 0) await fail(`stage 4c: ${beforeDim} card(s) were already dimmed before any roster row was clicked`)
  await clickUntil(page.getByTestId(`roster-row-${agentId}`), async () =>
    (await page.getByTestId(`roster-row-${agentId}`).getAttribute('aria-pressed')) === 'true', 'the roster row')
  console.log('stage 4c PASSED: a roster click selected the agent and the stream re-rendered against it')
```

- [ ] **Step 6: Write stage 5 — real Skills and Analytics data**

```js
  // ==== Stage 5: data ======================================================================
  const catalog = await syncSkillCatalog()
  console.log(`stage 5: syncSkillCatalog found ${catalog.upserted} skill(s) across ${catalog.providers} provider(s)`)
  const pluginProviders = await prisma.skillProvider.findMany({ where: { name: { startsWith: 'plugin:' } } })
  if (!pluginProviders.some((provider) => provider.name === 'plugin:superpowers')) {
    await fail(
      `stage 5: no plugin:superpowers provider after a sync -- found ${JSON.stringify(pluginProviders.map((p) => p.name))}. ` +
        'This gate reads the DAEMON HOST\'s ~/.claude/plugins/cache; a machine without the superpowers plugin cannot run it.',
    )
  }
  await page.goto(`${baseUrl}/skills`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByText('plugin:superpowers'), 'the plugin:superpowers provider on the Skills page')

  // Analytics' seven-day counts must equal an INDEPENDENT SQL count -- the page's own aggregation
  // is exactly what is under test, so the check cannot go through it.
  const [{ n: sqlSucceeded }] = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "AgentRun" r
    JOIN "Agent" a ON a.id = r."agentId"
    JOIN "Team" t ON t.id = a."teamId"
    WHERE t."workspaceId" = ${workspaceId}
      AND r.status = 'succeeded'
      AND r."terminalAt" >= date_trunc('day', now() at time zone 'utc') - interval '6 days'`
  await page.goto(`${baseUrl}/analytics?workspace=${workspaceId}`, { waitUntil: 'load', timeout: NEXT_READY_TIMEOUT_MS })
  await waitVisible(page.getByTestId('kpi-tile'), 'the Analytics KPI strip')
  const chartSucceeded = await page.locator('[data-testid^="bar-ok-"]').evaluateAll((nodes) =>
    nodes.reduce((total, node) => total + Number(node.getAttribute('data-count') ?? 0), 0),
  )
  if (chartSucceeded !== sqlSucceeded) {
    await fail(`stage 5: the chart shows ${chartSucceeded} succeeded run(s) over 7 days; SQL counts ${sqlSucceeded}`)
  }
  console.log(`stage 5 PASSED: the catalog holds plugin:superpowers, and the 7-day chart agrees with SQL (${sqlSucceeded})`)

  console.log(`PASS: ${PASS_LINE}`)
  exitCode = 0
} finally {
  // The daemon first -- it is the only thing here that can still spawn a child.
  if (daemon !== null && daemon.exitCode === null) {
    daemon.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (daemon.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
  }
  // Then the fake children by pid off the rows, before the rows are deleted. `fake-claude.sh`
  // ignores SIGTERM on purpose, so this is SIGKILL.
  if (workspaceId !== null) {
    const runs = await prisma.agentRun.findMany({ where: { agent: { team: { workspaceId } } }, select: { id: true, pid: true } }).catch(() => [])
    for (const row of runs) {
      if (row.pid === null) continue
      try {
        process.kill(row.pid, 'SIGKILL')
      } catch {
        // Already gone -- the outcome we wanted anyway.
      }
    }
  }
  if (browser !== null) await browser.close().catch(() => {})
  if (nextServer !== null && nextServer.exitCode === null) {
    nextServer.kill('SIGTERM')
    const exitDeadline = Date.now() + PROCESS_EXIT_TIMEOUT_MS
    while (nextServer.exitCode === null && Date.now() < exitDeadline) await delay(50)
    if (nextServer.exitCode === null) nextServer.kill('SIGKILL')
  }
  // FK-ordered: events (no FK to Workspace by design), then the workspace cascade.
  if (workspaceId !== null) {
    await prisma.executionEvent.deleteMany({ where: { workspaceId } }).catch(() => {})
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {})
  }
  if (repoPath !== null) rmSync(repoPath, { recursive: true, force: true })
  if (diagDir !== null && exitCode === 0) rmSync(diagDir, { recursive: true, force: true })
  await prisma.$disconnect()
}

process.exit(exitCode)
```

`BarChart` must carry `data-count={day.succeeded}` on each `bar-ok-*` rect for stage 5's sum to
work; add that attribute in this task (it is a one-line edit to `BarChart.tsx`, and this task's
`Files:` block therefore also names `apps/web/src/components/BarChart.tsx`).

- [ ] **Step 7: Add the npm script and the README row**

`package.json`, immediately after the `gate:m13-runtime` line:

```json
    "gate:m14-fidelity": "tsc --build && node --env-file=.env scripts/gate-m14-fidelity.mjs"
```

`README.md`, a new row immediately after the `gate:m13-runtime` row:

```markdown
| `npm run gate:m14-fidelity` | The M14 gate: nine pages, one design — every page of the handoff's shell rendered on real data at 1440×900, the README's own numbers read back from `getComputedStyle`, reduced motion proved, and nine screenshots committed under `docs/superpowers/fidelity/m14/`. **Spends nothing**, and refuses to start without `AITEAMOS_CLAUDE_BIN` pointing at `scripts/gate-fakes/` — `AITEAMOS_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m14-fidelity` |
```

- [ ] **Step 8: Run the gate**

Stop `next dev` first (the gate boots its own on a free port, but a stale one holding
`apps/web/.next` will confuse the build the gate's `tsc --build` triggers).

Run:

```bash
AITEAMOS_CLAUDE_BIN="$PWD/scripts/gate-fakes/fake-claude.sh" npm run gate:m14-fidelity
```

Expected: every `stage N PASSED` line, then `PASS: nine pages, one design`, exit 0. On a failure,
the thrown error carries the page URL, the screenshot path in the diagnostics dir, the daemon tail
and the gate's DB rows.

- [ ] **Step 9: Stage the nine screenshots**

```bash
ls -1 docs/superpowers/fidelity/m14/
```

Expected: exactly `activity.png agents.png analytics.png graph.png overview.png projects.png
settings.png skills.png tasks.png`.

Open each beside its 3a panel in
`design_handoff_ai_team_os/mockups/AI Team OS Mockups.dc.html` and record, in the task report, a
per-page accept/fix verdict. This is the human-acceptance half of §6 — the gate measures
conformance, not taste.

- [ ] **Step 10: Run the full per-task gate**

Run: `npm test && npm run typecheck && npm run web:build`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add scripts/gate-m14-fidelity.mjs apps/web/src/components/BarChart.tsx package.json README.md docs/superpowers/fidelity/m14/overview.png docs/superpowers/fidelity/m14/agents.png docs/superpowers/fidelity/m14/tasks.png docs/superpowers/fidelity/m14/graph.png docs/superpowers/fidelity/m14/activity.png docs/superpowers/fidelity/m14/projects.png docs/superpowers/fidelity/m14/skills.png docs/superpowers/fidelity/m14/analytics.png docs/superpowers/fidelity/m14/settings.png
git commit -m "feat(gate): nine pages, one design — measured, screenshotted and committed"
```

---

## Spec coverage

Every section of `docs/superpowers/specs/2026-08-29-m14-design-fidelity-design.md`, and the task
that implements it.

| Spec | Task |
|---|---|
| §1 Series A — the anatomy | 1, 2, 3 |
| §1 Series B — the data the missing pages need | 4, 5, 6, 7 |
| §1 Series C — the nine pages | 8–16 |
| §1 Series D — the fidelity gate | 17 |
| §2 D1 the README's numbers are requirements | 1, 2, 3 (they land them), 17 stage 2 (it reads them back) |
| §2 D2 anatomy is written once | 1, 2 (the primitives); 8–16 each consume them and add none |
| §2 D3 truth from snapshot, never placeholders | every Series C task; the labelled exception is 16's `seeded` caption |
| §2 D4 unknown is `null`, shown as `—` | 4 (`skillCalls`, keyed on `spawn.provider`), 5 (`tokens`, same key, same helper), 7 (KPI notes), 9 (`tokens`/cost), 13 (`unmeasuredRuns`) |
| §2 D5 skill use is a fact of the run, recorded at its end | 4 (four terminal writes, neither pause path) |
| §2 D6 the catalog is read from disk and never deletes | 6 (`missingSince`, the re-stamp guard) |
| §2 D7 what has no backend says so | 11 (`Reassign · later`, the Skill-chain tab), 14 (Codex/Gemini, the permission caption, `WebSocket · later`), 15 (the read-only roots tile) |
| §2 D8 motion is optional and centralized | 1 (all keyframes + the reduced-motion block), 17 stage 3 |
| §2 D9 evidence is committed | 17 steps 8–9 |
| §2 D10 no vendor spend | 4 is the one real run, capped at two invocations; 17 refuses to start without a `gate-fakes` binary |
| §3 `AvatarTile` | 1 |
| §3 `StatusPill` (3px 7px, radius 20, 5px dot, the pulse rule, `lib/tones.ts`) | 1 |
| §3 `AgentCard` (border/radius/bg/padding, header, task line, bar, step row, chips, footer, sweep, hover) | 2 |
| §3 `Panel` / `SectionLabel` header action | 2 |
| §3 `Sidebar` 212px, counts, guardrails block | 3 |
| §3 `TopBar` 52px, gradient hairline, `sse · <ms>` | 3 |
| §3 motion (`rise`, `sweep`, `dash`, `pulse`, `spin`) + reduced motion | 1 |
| §3 tests (computed style, exhaustive tone table, ten states, reduced motion) | 1, 2 — with the jsdom/gate split stated in this plan's own table |
| §3 "the ten statuses map to tones in one table" | 1 (`CARD_STATE_TONE`); 10's `COLUMN_STATE` maps onto it rather than beside it |
| §4.1 skill calls onto `AgentRun.skillCalls` | 4 |
| §4.2 tokens onto `RunOutcome`/`AgentRun` | 5 |
| §4.3 `syncSkillCatalog`, `missingSince`, `assignSkill`/`unassignSkill`, the CLI verb, the daemon hook | 6 |
| §4.4 analytics (7-day series, six KPIs, per-agent, stated limits) | 7 |
| §5.1 Overview | 8 |
| §5.2 Agents | 9 |
| §5.3 Tasks (`lib/taskColumns.ts`, tested) | 10 |
| §5.4 Graph — the cable, the canvas, the 352px drawer | 11 (steps 1–5, 7) |
| §5.4 Graph — Execution as its own pipeline-stage node set | 11 (steps 6a–6d, `buildExecutionGraph` over `lib/taskColumns.ts`) |
| §5.4 Graph — Skill chain disabled until Series B data exists | 11 (step 6, `hasSkillData`) |
| §5.5 Activity (x=88, row geometry, chips, payload, rise, volume rail, roster dim) | 12 |
| §5.6 Projects | 13 |
| §5.7 Settings (adapters, permission matrix, transport, danger zone, reseed) | 14 |
| §5.8 Skills | 15 |
| §5.9 Analytics | 16 |
| §5 routes note (`/skills`, `/analytics` global; nine sidebar rows) | 3 (the rows), 15, 16 (the routes) |
| §6 stage 1 nine pages + screenshots | 17 step 2 |
| §6 stage 2 the numbers from `getComputedStyle` | 17 step 3 |
| §6 stage 3 motion / reduced motion | 17 steps 4 and 5 |
| §6 stage 4 behavior (STOP, halt, fake-CLI run, pause, roster dim) | 17 step 5 |
| §6 stage 5 data (catalog, chart vs SQL) | 17 step 6 |
| §6 PASS line `nine pages, one design`, spend none | 17 |
| §6 human acceptance | 17 step 9 (per-page verdict), and each Series C task's reviewer reads its page against the mockup |
| §7 testing (primitives, data, pages, gate) | 1–2, 4–7, 8–16, 17 |
| §8 milestone gate: `npm run gate:m14-fidelity` + the per-task triple | 17, and every task's own gate step |

## After the plan

Still open, and deliberately not in this milestone: enforcing the permission matrix at runtime
(the matrix records intent, Decision 7); Codex and Gemini as real adapters; a WebSocket transport;
the 3D Floor (2a); and, still first in the queue after this, an auth/origin story before any
non-loopback binding.
