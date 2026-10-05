'use client'

import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { THEME_LABEL, useTheme, type ThemeChoice } from '@/components/theme/ThemeProvider'
import { cn } from '@/lib/utils'

const ICON: Readonly<Record<ThemeChoice, typeof SunIcon>> = { light: SunIcon, dark: MoonIcon, system: MonitorIcon }
const ORDER: readonly ThemeChoice[] = ['light', 'dark', 'system']

/** Light / Dark / System (lead UX design U-8), three small buttons in one rounded group. */
export function ThemeSwitch({ className }: { readonly className?: string }): React.JSX.Element {
  const { theme, setTheme } = useTheme()
  return (
    <div role="radiogroup" aria-label="Theme" data-testid="theme-switch" className={cn('inline-flex rounded-md border bg-background p-0.5', className)}>
      {ORDER.map((choice) => {
        const Icon = ICON[choice]
        const on = theme === choice
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={THEME_LABEL[choice]}
            title={THEME_LABEL[choice]}
            data-testid={`theme-${choice}`}
            onClick={() => setTheme(choice)}
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:text-foreground',
              on && 'bg-secondary text-foreground shadow-xs',
            )}
          >
            <Icon className="size-3.5" />
            <span className="sr-only sm:not-sr-only">{THEME_LABEL[choice]}</span>
          </button>
        )
      })}
    </div>
  )
}
