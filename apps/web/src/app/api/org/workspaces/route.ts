import { createWorkspace, refusalText, type ProviderKind } from '@ai-team-os/control'

export const dynamic = 'force-dynamic'
const BODY_ERROR = 'the body must be { name, repoPath, verifyCommands: string[], baseBranch?, setupCommands?, budgetUsd?, provider? }'

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null
}

export async function POST(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null)
  if (body === null || typeof body !== 'object') return Response.json({ error: BODY_ERROR }, { status: 400 })
  const b = body as Record<string, unknown>
  const verifyCommands = strings(b['verifyCommands'])
  const setupCommands = b['setupCommands'] === undefined ? [] : strings(b['setupCommands'])
  if (typeof b['name'] !== 'string' || typeof b['repoPath'] !== 'string' || verifyCommands === null || setupCommands === null) {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  if (b['budgetUsd'] !== undefined && b['budgetUsd'] !== null && typeof b['budgetUsd'] !== 'number') {
    return Response.json({ error: BODY_ERROR }, { status: 400 })
  }
  // Not `orgControlResponse`: this is the one org route whose success body carries an id (spec §2 A3).
  const result = await createWorkspace({
    name: b['name'],
    repoPath: b['repoPath'],
    ...(typeof b['baseBranch'] === 'string' ? { baseBranch: b['baseBranch'] } : {}),
    verifyCommands,
    setupCommands,
    ...(b['budgetUsd'] === undefined ? {} : { budgetUsd: b['budgetUsd'] as number | null }),
    ...(b['provider'] === undefined ? {} : { provider: b['provider'] as ProviderKind | null }),
  })
  return result.ok
    ? Response.json({ ok: true, id: result.value.id }, { status: 201 })
    : Response.json({ error: refusalText(result.error) }, { status: 409 })
}
