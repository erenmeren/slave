import type React from 'react'
import { cookies } from 'next/headers'
import { listProjects } from '@slave-of-ai/control'
import { AppSidebar } from '@/components/app/AppSidebar'
import { TopBar } from '@/components/app/TopBar'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { currentPrincipal, requirePrincipal } from '../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * Lead UX design U-2: the frame every signed-in screen sits in -- the sidebar of projects on the
 * left, the screen on the right. The project list is read here, on the server, so the first paint
 * carries it; the sidebar keeps it current itself.
 *
 * Gated on a principal: a signed-out person in accounts mode gets an empty list rather than every
 * project's name (every route behind it answers 401 on its own). Below the sidebar's breakpoint it
 * slides in from the left behind the menu button in the top bar (`TopBar`).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }): Promise<React.JSX.Element> {
  const gate = await requirePrincipal()
  const [projects, principal, store] = await Promise.all(['response' in gate ? Promise.resolve([]) : listProjects(), currentPrincipal(), cookies()])
  // shadcn's own cookie: a person who collapsed the sidebar finds it collapsed on the next load.
  const open = store.get('sidebar_state')?.value !== 'false'
  return (
    <SidebarProvider defaultOpen={open}>
      <AppSidebar initial={projects} username={principal?.username ?? null} />
      {/* `min-w-0`: a row's item is never narrower than its content unless told so, and one long
          unbroken line on a screen (a feed's step, a table) would push the page wider than the window. */}
      <SidebarInset className="min-w-0">
        <TopBar />
        <main id="main" className="flex-1">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
