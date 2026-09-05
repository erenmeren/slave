# Office Floor — design handoff (2026-09-05)

Copied verbatim from the Claude Design project `a707bbea-1769-4e1d-b3e4-d71f6d7c8d98`
(`https://claude.ai/design/p/a707bbea-1769-4e1d-b3e4-d71f6d7c8d98?file=Office+Floor.dc.html`).

- `Office Floor.dc.html` — the canvas: dc-runtime template (HUD, focus card) + the component
  logic that builds a `WorldF`, runs the animation loop and wires zoom/pan/focus.
- `office-engine.js` — the pixel office: `World` (simulation), `WorldD/E/F` (layouts, day/night,
  cat/roomba/boss/confetti), `renderIsoE` (the isometric renderer the design uses) plus older
  renderers the design does not use.
- `support.js` (not copied) — the dc-runtime that renders `.dc.html` templates over React; the
  web app renders the template as React components instead.

These files are input, not product code: they keep the design's own vocabulary ("agents") and
are excluded from the vocabulary gate. The product's copy lives in `apps/web/src/lib/office/`
(trimmed, module-wrapped, renamed) — see the M28 spec,
`docs/superpowers/specs/2026-09-05-m28-office-floor-design.md`.
