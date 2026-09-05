import { Silkscreen } from 'next/font/google'
import { buildOfficeSnapshot } from '../../../../server/office'
import { OfficeClient } from '../../../../components/office/OfficeClient'

export const dynamic = 'force-dynamic'

// The design's pixel font, self-hosted by next/font. Its family name is hashed, so the client gets
// it as a prop and hands it to the engine's canvas labels (`setPixelFont`) and to the HUD.
const pixel = Silkscreen({ weight: '400', subsets: ['latin'], variable: '--font-pixel', display: 'swap' })

// Named like `GraphPageRoute`: the snapshot types live in `server/office.ts`.
export default async function OfficePageRoute({
  params,
}: {
  params: Promise<{ workspaceId: string }>
}): Promise<React.JSX.Element> {
  const { workspaceId } = await params
  const snapshot = await buildOfficeSnapshot(workspaceId)
  if (snapshot === null) {
    return <main className="p-6 text-tone-blocked">no workspace with id {workspaceId}</main>
  }
  // Keyed so a client-side project-to-project navigation remounts the office instead of animating
  // the old roster under the new URL.
  return (
    <div className={pixel.variable}>
      <OfficeClient key={workspaceId} workspaceId={workspaceId} initial={snapshot} pixelFontFamily={pixel.style.fontFamily} />
    </div>
  )
}
