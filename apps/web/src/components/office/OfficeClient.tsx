'use client'

import type { OfficeSnapshot } from '../../server/office'

/** The Office tab (M28 §5). Task 4 wires the engine, the stream and the overlays in here. */
export function OfficeClient({
  workspaceId,
  initial,
  pixelFontFamily,
}: {
  readonly workspaceId: string
  readonly initial: OfficeSnapshot
  readonly pixelFontFamily: string
}): React.JSX.Element {
  return (
    <div data-workspace-id={workspaceId} data-pixel-font={pixelFontFamily} className="relative h-[calc(100vh-52px-41px)] min-h-[360px] w-full overflow-hidden bg-[#07080b]">
      <canvas data-testid="office-canvas" className="block h-full w-full cursor-grab" />
      <span className="sr-only">{initial.workspace.name}</span>
    </div>
  )
}
