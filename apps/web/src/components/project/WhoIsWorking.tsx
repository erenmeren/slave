import type { BuildView, WorkingFace } from '@slave-of-ai/control'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/** Two letters for a face: the initials of its first two words, else its first two letters. */
export function initialsOf(name: string): string {
  const words = name.split(/[\s-]+/u).filter((word) => word !== '')
  const letters = words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.slice(0, 2)
  return letters.toUpperCase()
}

/** A steady colour per name, from a small palette that reads in both themes. */
const FACE_TONES = [
  'bg-info-muted text-info-foreground',
  'bg-checking-muted text-checking-foreground',
  'bg-success-muted text-success-foreground',
  'bg-warning-muted text-warning-foreground',
  'bg-accent text-accent-foreground',
] as const

export function toneOf(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return FACE_TONES[hash % FACE_TONES.length] ?? FACE_TONES[0]
}

const KIND_WORD: Readonly<Record<WorkingFace['kind'], string>> = { lead: 'Lead', helper: 'Helper', checker: 'Checker' }

function Face({ face, paused }: { readonly face: WorkingFace; readonly paused: boolean }): React.JSX.Element {
  return (
    <li data-testid="face" data-kind={face.kind} className="flex min-w-0 items-start gap-3 rounded-lg border bg-background p-3">
      <Avatar className={cn('size-9', face.working && !paused && 'working-pulse')}>
        <AvatarFallback className={cn('text-xs font-semibold', toneOf(face.name))}>{initialsOf(face.name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">
          {face.name}
          {face.kind !== 'lead' && face.name !== KIND_WORD[face.kind] && <span className="font-normal text-muted-foreground"> · {KIND_WORD[face.kind].toLowerCase()}</span>}
        </p>
        <p data-testid="face-doing" className="truncate text-xs text-muted-foreground" title={face.doing ?? undefined}>
          {paused ? 'Paused' : (face.doing ?? 'Starting…')}
        </p>
      </div>
    </li>
  )
}

/**
 * Lead UX design section 6.3, "Who is working": the lead first, the helpers it called, then the
 * checker -- each with what it is doing now in words -- and the newest commits on the build's
 * branch. Shown while a build is being built or checked.
 */
export function WhoIsWorking({ build, paused }: { readonly build: BuildView | null; readonly paused: boolean }): React.JSX.Element {
  const faces = build?.faces ?? []
  const commits = build?.commits ?? []
  return (
    <Card data-testid="who-is-working">
      <CardHeader>
        <CardTitle className="text-base">Who is working</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {faces.length === 0 ? (
          <p className="text-sm text-muted-foreground">{paused ? 'Paused. Nothing runs until you press Continue.' : 'The lead has not started yet.'}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {faces.map((face) => (
              <Face key={face.id} face={face} paused={paused} />
            ))}
          </ul>
        )}
        {commits.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Recent commits</h3>
            <ul data-testid="commits" className="flex flex-col gap-1 text-sm">
              {commits.map((commit) => (
                <li key={commit.sha} className="flex min-w-0 gap-2">
                  <code className="shrink-0 font-mono text-xs text-muted-foreground">{commit.sha.slice(0, 7)}</code>
                  <span className="truncate">{commit.subject}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
