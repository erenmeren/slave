'use client'

import { usePathname } from 'next/navigation'
import { workspaceIdOf } from '../../lib/routes'
import { useRightPanel } from './RightPanelProvider'
import type { RightWidth } from './AppShell'

/** How wide the third column is right now — read by the shell through a render prop rather than
 *  by `AppShell` itself, which is a server component and has no pathname. */
export function useRightWidth(): RightWidth {
  const pathname = usePathname()
  const { collapsed } = useRightPanel()
  if (workspaceIdOf(pathname) === null) return 'none'
  return collapsed ? 'dock' : 'panel'
}
