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
