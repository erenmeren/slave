/** The `localStorage` key the operator's Supervisor collapse choice is remembered under (M61 R14).
 *  A plain module for the same reason `modeStorage.ts`/`themeStorage.ts` are ones: nothing here
 *  crosses the RSC boundary today, but the pattern is kept so a future pre-hydration script could
 *  read it the same way those two are read, without a `'use client'` import getting in the way. */
export const SUPERVISOR_STORAGE_KEY = 'supervisor'
export type SupervisorChoice = 'open' | 'collapsed'
const CHOICES: readonly SupervisorChoice[] = ['open', 'collapsed']
export function isSupervisorChoice(value: unknown): value is SupervisorChoice {
  return typeof value === 'string' && (CHOICES as readonly string[]).includes(value)
}
