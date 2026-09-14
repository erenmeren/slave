/**
 * The `localStorage` key the operator's theme choice is remembered under (M57 R2).
 *
 * A PLAIN module — no `'use client'` — and that is the whole reason it exists rather than living
 * beside the provider that reads it. `app/layout.tsx` is a SERVER component, and a server component
 * importing a value out of a `'use client'` module does not get the value: Next replaces that
 * module's exports with client references, so `${JSON.stringify(THEME_STORAGE_KEY)}` interpolated
 * into the pre-hydration script rendered as the literal `undefined` and the script read
 * `localStorage.getItem(undefined)` — which is never anything, so a pinned operator's choice was
 * never stamped before the first paint and the flash erratum E8 exists to kill was still there.
 * (M57 erratum E20; `gate:m57-ui-redesign` stage 1 is what caught it, and is what keeps it caught:
 * no jsdom test can see this, because in a test both sides import the same real module.)
 *
 * `ThemeProvider` re-exports this name, so every existing importer is unchanged.
 */
export const THEME_STORAGE_KEY = 'theme'
