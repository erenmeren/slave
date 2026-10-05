'use client'

import { SidebarTrigger, useSidebar } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

/**
 * The thin bar above a screen that holds the sidebar's menu button: always on a narrow screen,
 * where the sidebar slides in from the left, and on a wide one only once the sidebar was collapsed
 * (Ctrl/Cmd+B), so it can always be brought back.
 */
export function TopBar(): React.JSX.Element {
  const { state, isMobile } = useSidebar()
  return (
    <header className={cn('sticky top-0 z-10 flex h-12 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur', !isMobile && state === 'expanded' && 'hidden')}>
      <SidebarTrigger data-testid="sidebar-trigger" />
      <span className="text-sm font-semibold">Slave of AI</span>
    </header>
  )
}
