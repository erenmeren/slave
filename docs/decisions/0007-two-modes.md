# ADR 0007 — Two Modes, One Product

**Status:** Accepted
**Date:** 2026-09-19
**Context:** `docs/superpowers/specs/2026-09-19-m61-simple-mode-design.md` (R1, R2, R19; §2
surfaces; §3 testid vocabulary; §4 `docs/ia.md`); `docs/ia.md` rules 2, 3 and 6;
`.superpowers/sdd/2026-09-19-m61-simple-mode/progress.md`.

## Decision

The operator console runs in **two modes** — `simple` for a person who runs a company and does not
read code, `developer` for the person who built it — and they are ONE product, not two.

**A mode is an attribute, a key, a script and a provider (R1).** `data-mode="developer"` on
`<html>` is developer mode; the ABSENCE of the attribute is simple, which is the default for
anybody who has never chosen. The choice lives under the `localStorage` key `mode`
(`MODE_STORAGE_KEY`, in the plain module `lib/modeStorage.ts`), the root layout's inline `<head>`
script stamps the attribute before hydration, and `components/mode/ModeProvider.tsx` mirrors
`ThemeProvider.tsx` clause for clause — flat `'simple'` on the server and on the first client
render, a `hydrated` flag before the attribute effect may run, every storage touch in `try/catch`.
It is built exactly the way the theme is, because it is exactly the same kind of thing: a
presentation preference that must survive a reload and must not flash.

**The mode never reaches the URL, and never removes a destination.** `docs/ia.md` rule 2 holds
across both modes. A developer-only route opened in simple mode does not redirect: the tab bar
renders it as an extra current tab marked `data-outside-mode="true"`, so a person can see where
they are and leave by any other tab. `lib/routes.ts` is the one place that knows which mode shows
which entry (`TABS`/`tabsFor`, `RAIL`/`railFor`); nothing else in the tree derives a route from a
mode.

**Four palettes, two files, one alias layer — and the developer palette is the one that already
existed (R2).** `app/tokens/simple.css` and `app/tokens/developer.css` each declare the twenty
palette names plus the surface tokens, for light and for dark, in M57's three-block shape; every
selector in the developer file carries one more attribute than its simple counterpart
(`:root[data-mode='developer']`, and so on), so developer wins whenever the attribute is present
and simple wins otherwise and nothing depends on source order. `developer.css` holds today's
values verbatim — cream and teal in light, graphite and mint in dark — because the user's word for
developer mode was "the colder, denser cousin" and today's sheet already is that. `simple.css`
holds the warm palette the mockups were drawn in. **The eight `--s-*` status tones are identical
in all four palettes**: one status vocabulary, one set of meanings.

**Developer mode ADDS; it never re-skins an old component (R19).** Every developer-only surface —
Graph, Analytics, Simulations, Knowledge, Skills & runbooks, Evidence, the raw river, the staffing
preferences, the KPI strip, the `technical` lines, the board's card details — renders inside the
same frame with the same primitives. The only differences are the palette, the density
(`--fs-body`, `--row-h`, the gap scale) and the SET of things on screen. The developer-only PAGES
are restyled, not redesigned: each wraps its content in a `ScrollArea` and swaps its labels and
cards for the rewritten primitives, and leaves its read model, its client and its testids alone.

## Rationale

### Why a mode rather than two apps, or a role

Two builds would double every surface and guarantee drift: the second one would be the one nobody
ran the gates against. A server-side role would make the choice an account property, which is
wrong twice over — this is a single-operator console with a loopback mode and no accounts by
default, and the same person genuinely wants both views on different days. A client attribute with
a remembered key is the smallest thing that is true: it is a preference, it belongs to the browser
that expressed it, and it can be changed in one keystroke without a round trip.

### Why absence is simple, not `data-mode="simple"`

Every `[data-mode='developer']` selector in the token sheet is written against PRESENCE. If simple
were a value rather than an absence, the two sheets would have equal specificity and the cascade
would depend on source order — which is precisely the fragility M57's alias layer was built to
avoid. Absence also makes the default correct for a person who has never chosen, on the first
paint, with no script at all.

### Why the mode must not redirect

A redirect would make rule 2 false in the only way that matters: a bookmark, a link in a report or
a URL typed from memory would stop working depending on a preference stored in a browser. Marking
the tab `data-outside-mode="true"` says the same thing honestly — "this is not one of your tabs,
and here you are on it" — and leaves every other tab as the way out.

### Why the developer palette is the OLD one

It reduces the blast radius of this milestone to one direction. Nothing a developer sees changes
colour; the new palette is the one the new default wears. If the user later wants a different
developer look — and the design session's note said they might ("ilerde renkler değişebilir
developerin") — it is one file with no component in it.

## Alternatives Rejected

- **A server-rendered mode (a cookie read in the layout).** Rejected: it would make the first paint
  correct at the cost of putting a presentation preference into the request path and into every
  cached response, and the theme already solved the flash with a pre-hydration script that costs
  nothing.
- **Redirecting a developer-only route to Home in simple mode.** Rejected above: it breaks rule 2
  for bookmarks and shared links.
- **A third "advanced" mode, or per-surface toggles.** Rejected: M57 retired the `Advanced ▾` menu
  precisely because a graveyard of per-surface disclosures is a place capabilities go to be
  forgotten. Two modes are a promise a person can hold in their head.
- **Re-skinning the existing pages for simple mode instead of choosing what to show.** Rejected:
  the user's brief was that the UI is confusing, not that it is ugly. Fewer things on screen is the
  fix; a repaint of the same density would have been a different product with the same problem.

## Consequences

- Every surface that differs by mode reads `useMode()` and nothing else; a gate that asserts a
  mode-dependent element has to say which mode it is in, and several existing gates were edited to
  do exactly that during M61's reconciliation (`m44`, `m45`, `m49`, `m53`, `m18`).
- A mode-dependent element is rendered by a CLIENT component whose first render is flat `'simple'`
  — so anything reading one must wait for hydration, not for the load event. Both the new gate and
  the reconciled ones wait on `mode-toggle`'s `aria-checked` before reading.
- `docs/ia.md` gains rule 6 and a **Modes** section; both tables' rows say what each mode shows.
- The proof is `gate:m61-simple-mode` (the 35th gate), whose stage 3 asserts the switch moves
  `--accent` and the tab set, stage 1 asserts a stored developer mode never flashes simple, and
  stage 10 walks every route `docs/ia.md` names in BOTH modes.
- A later decision to drop a mode is a `lib/routes.ts` edit and a token file, not a rewrite: no
  component knows which mode it is in except through `useMode()`, and no route knows at all.
