# M16 — Chrome Finishing: One Form Language, One Tone Table

**Status:** Approved (all three sections approved in conversation 2026-08-31; user waived further design questions)
**Approach:** A — shared form-control kit, four form migrations, three small chrome items, full colour-vocabulary consolidation.

## 1. Why this milestone

M14 rebuilt nine pages to the design handoff; what it left were the surfaces that predate it: the
Overview Goal/Runtime row and the Settings template/company forms still speak M11 (generic
`rounded border px-2 py-1` controls, no mono labels), the Projects card overflows its avatar row
on a large team, Analytics draws an unmeasured success rate as a zero-width bar, the permission
matrix cannot show "not set" apart from "denied", and two colour vocabularies (`--status-*`,
`--tone-*`) with near-identical values coexist across 27 component files. M16 finishes the
chrome: one form language from the handoff's tokens, one tone table, and the three small
honesty fixes.

**Non-goals:** no behaviour changes anywhere (handlers, routes, state, test ids and aria
contracts all survive); no CompanyManager file split (parked debt, stays parked); no custom
dropdown/checkbox drawings (native controls, styled shells — M14's "build what is real" rule);
no new dependencies; no DB or orchestrator changes.

## 2. The form kit — `apps/web/src/components/ui/FormControls.tsx`

One file, four exports, appearance only (no state, no fetch — behaviour stays in the callers).
Handoff tokens (README "Design Tokens"): input/tile radius **7**, chip/button radius **5**,
hover borders `rgba(255,255,255,.2–.28)`, ghost buttons brighten text to `#fff`, primary buttons
`filter: brightness(1.35)` on hover, labels IBM Plex Mono 9px uppercase `letter-spacing: .09em`.

```tsx
export function FieldLabel({ children }: { readonly children: React.ReactNode }): React.JSX.Element
// <span className="font-mono text-[9px] uppercase tracking-[.09em] text-text-3">

export function TextField(props: {
  readonly label?: string            // rendered via FieldLabel; omit for the unlabeled case
  readonly inputProps: React.InputHTMLAttributes<HTMLInputElement>  // must carry aria-label when label is omitted
}): React.JSX.Element
// input: rounded-[7px] border border-line bg-bg-0 px-2.5 py-1.5 text-sm text-text-1
//        placeholder:text-text-3 focus:border-white/25 focus:outline-none

export function SelectField(props: {
  readonly label?: string
  readonly selectProps: React.SelectHTMLAttributes<HTMLSelectElement>
  readonly children: React.ReactNode // the <option>s
}): React.JSX.Element
// same shell as TextField; native arrow kept (no custom dropdown)

export function GhostButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element
// rounded-[5px] border border-line bg-transparent px-2.5 py-1 text-xs text-text-2
// hover:border-white/25 hover:text-text-0 disabled:opacity-50 disabled:cursor-not-allowed

export function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly tone?: 'working' | 'blocked' // default 'working'
}): React.JSX.Element
// rounded-[5px] border border-tone-<t>/40 bg-tone-<t>/15 text-tone-<t> px-2.5 py-1 text-xs
// hover:brightness-[1.35] disabled:opacity-50
```

Every component prop spread (`{...inputProps}` etc.) passes the caller's existing `data-testid`,
`aria-*`, handlers and `value` untouched — the kit never invents or renames a contract.

## 3. The four form migrations

Markup-only; every existing `data-testid`, `getByLabelText` string, handler and state survives.
Each migration gates on its own test file plus `npm run web:build`.

1. **GoalCard** (`components/GoalCard.tsx`): the input + "set goal" button move to
   `TextField` (label omitted — the input keeps its existing aria-label) + `PrimaryButton`;
   "waiting for a goal" becomes a `FieldLabel`-styled line; the suggestion chips keep their
   existing `rounded-chip` idiom (already handoff-correct).
2. **RuntimeCard** (`components/RuntimeCard.tsx`): provider `SelectField`, budget `TextField`,
   both submit buttons `PrimaryButton`; the "not budgeted" native checkbox stays native, its
   label restyled `FieldLabel`-mono. The M15 `key` on the call site is untouched.
3. **TemplateCatalog** (`components/TemplateCatalog.tsx`): the row list keeps its table idiom;
   only the creation form migrates to the kit.
4. **CompanyManager** (`components/CompanyManager.tsx`): all three forms (company, team, member)
   migrate. The file is NOT split (parked M11 debt stays a separate queue item).

## 4. Three small chrome items

- **Projects avatar overflow** (`components/ProjectsClient.tsx`): render the first **6** team
  members as `AvatarTile`s; when more exist, a seventh 28px tile — `data-testid="team-overflow"`,
  mono 10px `+N` text, `bg-bg-2 border border-line text-text-2`, `title` listing every remaining
  member's name. Six or fewer members: byte-identical output to today.
- **Unmeasured success rate**: `components/ui/ProgressBar.tsx` accepts `pct: number | null` —
  `null` draws the empty rail only (no fill, no glow, no `aria-valuenow`).
  `AnalyticsClient.tsx:108` drops `?? 0` and passes `row.successPct` straight through; the `—`
  percentage cell is already correct and stays. A real 0% (all terminal runs failed) still draws
  a zero-width fill WITH `aria-valuenow={0}` — zero is a measurement, null is not.
- **Permission matrix third glyph** (`components/PermissionMatrix.tsx`): `allow` → `✓`
  (tone-working), `deny` → `✕` (tone-blocked), unset → `–` (text-text-3). Tooltips (`allowed` /
  `denied` / `not set`) and the click semantics (`flip`: unset→allow, deny→allow, allow→deny)
  are unchanged. The "not yet enforced at runtime" footnote stays.

## 5. Colour consolidation — one tone table

Target vocabulary: exactly the handoff's eight tones — `working / planning / review / waiting /
blocked / done / paused / idle`. `--tone-danger` and `--tone-warn` are NOT created: the old
`status-danger` (`#f87171`) folds into `tone-blocked`, `status-warn` (`#f5b34a`) into
`tone-waiting` — same values, one name each.

- `globals.css`: delete the `--status-*` custom properties and their `--color-status-*` `@theme`
  mappings.
- Mechanical rename across every consumer (15 files use `status-*` classes):
  `status-working→tone-working`, `status-starting→tone-planning`, `status-paused→tone-paused`,
  `status-stopping→tone-waiting`, `status-idle→tone-idle`, `status-danger→tone-blocked`,
  `status-warn→tone-waiting`.
- Old pinned class assertions (M4-era tests expecting `bg-status-*` etc.) are rewritten to the
  new names in the same task — a rename, not a behaviour change.
- Zero-pixel proof: the values are identical, so the rename task asserts it — a jsdom-side
  check that the renamed classes resolve to the same declarations, or (simpler and binding) the
  gate's computed-style reads below.
- **Graph coherence**: the Execution-mode task node's tone selection routes through
  `lib/tones.ts`'s single table so `reviewing` reads `tone-review` purple on the graph exactly
  as on the board (today it falls to a grey). Separate task; single-source rule.

## 6. Gate — `npm run gate:m16-chrome`

Zero spend, CI-runnable, `gate-m15-boundary`'s boot skeleton (real `next dev -H 127.0.0.1`,
ephemeral port, seeded dev DB, kill child in `finally`, never run beside a dev server). Checks:

1. Overview: the goal input reads `border-radius: 7px` and the set-goal button `5px` from
   `getComputedStyle`.
2. Settings: the permission matrix renders three distinct glyphs (`✓`, `✕`, `–`) when the seed
   contains all three modes — and if the seed lacks one, the gate seeds nothing: it asserts on
   whatever modes exist and requires at least `unset` ≠ `deny` glyph difference.
3. Projects: if any seeded workspace has >6 team members, `team-overflow` shows `+N` with the
   right N; otherwise the testid is absent.
4. Repo hygiene: `grep -rn -- "--status-\|status-working\|status-danger\|status-warn\|status-stopping\|status-starting\|status-idle"`
   over `apps/web/src` returns nothing (the tone table is the only vocabulary).
5. Analytics: an agent with zero terminal runs shows a progress rail with no `aria-valuenow`.

PASS line: `PASS: one tone table, the handoff's forms`. README row states zero spend.

## 7. Testing summary

- New `apps/web/test/form-controls.test.tsx`: the kit's radii, label typography, disabled
  states, prop pass-through (testid/aria reach the DOM), PrimaryButton tone variants.
- Each migration: its existing test file stays green unmodified EXCEPT where a class was pinned;
  pinned-class edits are listed per task, renames only.
- ProgressBar: null → no fill, no `aria-valuenow`; 0 → fill present, `aria-valuenow=0`.
- PermissionMatrix: three glyphs pinned; flip semantics re-asserted unchanged.
- Standing rules bind: one vitest run at a time, daemon stopped, `web:build` never beside a dev
  server, every `apps/web` task gates on `npm run web:build`.

## 8. Global constraints

- No behaviour changes: every `data-testid`, aria contract, handler, route and state shape
  survives byte-for-byte; markup and class names only.
- Radii verbatim: input/tile 7px, chip/button 5px (the kit is the single place they are written).
- The tone vocabulary is exactly the eight handoff names; `status-*` ceases to exist.
- Native form controls only — no custom-drawn dropdowns, checkboxes or overlays.
- No new dependencies; no DB migrations; no orchestrator changes.
- Comments change in the same commit as the behaviour (here: markup) they describe.
