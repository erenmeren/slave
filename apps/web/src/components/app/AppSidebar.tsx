'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { LogOutIcon, PlusIcon, SettingsIcon, UsersIcon } from 'lucide-react'
import { PROJECT_PHASE_LABEL } from '@slave-of-ai/domain'
import type { ProjectListItem } from '@slave-of-ai/control'
import { PhaseDot } from '@/components/app/phase'
import { ThemeSwitch } from '@/components/app/ThemeSwitch'
import { Button } from '@/components/ui/button'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { usePoll } from '@/hooks/usePoll'
import { PROJECTS_CHANGED, api } from '@/lib/api'

/** How often the sidebar re-reads the projects (lead UX design U-9). */
export const SIDEBAR_POLL_MS = 10_000

/** The number in the browser tab's title (U-3): every build waiting for a person, across projects. */
export function waitingTotal(projects: readonly ProjectListItem[]): number {
  return projects.filter((project) => !project.archived).reduce((total, project) => total + project.waiting, 0)
}

/** The tab's title with the count in front when something waits: `(2) Slave of AI`. */
export function titleWithCount(title: string, waiting: number): string {
  const bare = title.replace(/^\(\d+\) /u, '')
  return waiting > 0 ? `(${String(waiting)}) ${bare}` : bare
}

/**
 * Lead UX design U-2: the one frame. The product mark, New project, every project with its state
 * dot and -- when a build waits for the person -- an amber count; then Helpers and Settings; at the
 * bottom the theme switch and, with accounts on, who is signed in. Re-read every ten seconds, and
 * the count also leads the browser tab's title so a waiting build is seen from another tab.
 */
export function AppSidebar({ initial, username }: { readonly initial: readonly ProjectListItem[]; readonly username: string | null }): React.JSX.Element {
  const pathname = usePathname()
  const router = useRouter()
  const { data, refresh } = usePoll<{ readonly projects: readonly ProjectListItem[] }>('/api/projects', { projects: initial }, () => SIDEBAR_POLL_MS)
  const projects = data.projects.filter((project) => !project.archived)
  const waiting = waitingTotal(data.projects)

  useEffect((): (() => void) => {
    const onChange = (): void => void refresh()
    window.addEventListener(PROJECTS_CHANGED, onChange)
    return (): void => window.removeEventListener(PROJECTS_CHANGED, onChange)
  }, [refresh])

  useEffect((): void => {
    document.title = titleWithCount(document.title, waiting)
  }, [waiting, pathname])

  const signOut = async (): Promise<void> => {
    await api('/api/auth/logout', { method: 'POST' })
    router.push('/login')
  }

  return (
    <Sidebar data-testid="app-sidebar">
      <SidebarHeader className="gap-3 px-3 pt-4">
        <Link href="/" className="flex items-center gap-2 px-1" data-testid="home-link">
          <span aria-hidden className="grid size-7 place-items-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
            S
          </span>
          <span className="text-sm font-semibold tracking-tight">Slave of AI</span>
        </Link>
        <Button asChild size="sm" className="w-full justify-start" data-testid="new-project">
          <Link href="/new">
            <PlusIcon />
            New project
          </Link>
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {projects.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No projects yet.</p>}
              {projects.map((project) => (
                <SidebarMenuItem key={project.id} data-testid="sidebar-project" data-phase={project.phase} data-waiting={project.waiting}>
                  <SidebarMenuButton asChild isActive={pathname.startsWith(`/w/${project.id}`)} tooltip={PROJECT_PHASE_LABEL[project.phase]}>
                    <Link href={`/w/${project.id}`}>
                      <PhaseDot phase={project.phase} />
                      <span className="truncate">{project.name}</span>
                    </Link>
                  </SidebarMenuButton>
                  {project.waiting > 0 ? (
                    <SidebarMenuBadge data-testid="sidebar-waiting" className="rounded-full bg-warning px-1.5 text-[11px] font-semibold text-black/80" aria-label={`${String(project.waiting)} waiting for you`}>
                      {project.waiting}
                    </SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname.startsWith('/helpers')}>
                  <Link href="/helpers" data-testid="nav-helpers">
                    <UsersIcon />
                    Helpers
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={pathname.startsWith('/settings')}>
                  <Link href="/settings" data-testid="nav-settings">
                    <SettingsIcon />
                    Settings
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="gap-2 px-3 pb-4">
        <ThemeSwitch className="w-full justify-between" />
        {username !== null && (
          <div className="flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
            <span className="truncate" data-testid="signed-in-as">
              Signed in as {username}
            </span>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => void signOut()} data-testid="sign-out">
              <LogOutIcon />
              Sign out
            </Button>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  )
}
