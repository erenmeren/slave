/**
 * The `localStorage` key the theme choice is remembered under, and the pre-hydration script that
 * reads it.
 *
 * A PLAIN module -- no `'use client'` -- and that is why both live here rather than beside the
 * provider: `app/layout.tsx` is a server component, and a server component importing a value out
 * of a `'use client'` module gets a client reference instead of the value (M57 erratum E20).
 */
export const THEME_STORAGE_KEY = 'theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * Stamps the class `dark` on `<html>` before the first paint (lead UX design U-8: shadcn/ui's dark
 * variant reads the class): when the stored choice is Dark, or it is System (nothing stored) and
 * the operating system is dark. It cannot import anything: it runs before the bundle exists.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});var d=t==='dark'||(t!=='light'&&window.matchMedia(${JSON.stringify(DARK_QUERY)}).matches);if(d){document.documentElement.classList.add('dark')}document.documentElement.style.colorScheme=d?'dark':'light'}catch(e){}})()`
