import { prisma } from '@slave-of-ai/db/client'
import { runContextManifestSchema } from '@slave-of-ai/domain'
import { requirePrincipal } from '../../../../../../../server/principal'

export const dynamic = 'force-dynamic'

/**
 * What this run was told (M37 §6): the exact prompt the model saw, and the manifest of where each
 * of its sections came from.
 *
 * A READ, so no control verb and no `runControlResponse` -- that shell exists to translate a
 * `Result` refusal, and there is nothing here to refuse. The workspace check is
 * `runControlResponse`'s own, restated in this one query: `slave -> team -> workspace`, not
 * `task -> workspace`, because a `planning` run (M8b) has no `Task` row at all.
 *
 * Two 404s, deliberately worded apart: a run in another workspace (or none at all) is "no such
 * run", and a run whose context was never recorded is its own sentence -- `buildRunContext` writes
 * the row BEFORE the spawn, so a run without one never started, which is the CLI's `show-context`
 * message and the honest thing to say to an operator opening a queued run's panel.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ workspaceId: string; runId: string }> },
): Promise<Response> {
  const gate = await requirePrincipal()
  if ('response' in gate) return gate.response
  const { workspaceId, runId } = await context.params

  const run = await prisma.slaveRun.findUnique({
    where: { id: runId },
    select: {
      slave: { select: { team: { select: { workspaceId: true } } } },
      context: { select: { prompt: true, sections: true } },
    },
  })
  if (run === null || run.slave.team.workspaceId !== workspaceId) {
    return Response.json({ error: 'no such run in this workspace' }, { status: 404 })
  }
  if (run.context === null) {
    return Response.json(
      { error: 'this run recorded no context: it never started' },
      { status: 404 },
    )
  }

  // Validated rather than cast (M37 §3, the CLI's `show-context` does the same): `sections` is a
  // `Json` column, so a hand-edited or pre-M37 row must produce a nameable error here instead of a
  // shape the panel then renders as nonsense. 500 rather than a 4xx -- the request is impeccable
  // and the stored row is the problem, so this is not something the client can fix by asking
  // differently.
  const manifest = runContextManifestSchema.safeParse(run.context.sections)
  if (!manifest.success) {
    return Response.json(
      { error: `run ${runId} has a context manifest this version cannot read` },
      { status: 500 },
    )
  }

  return Response.json({ prompt: run.context.prompt, manifest: manifest.data })
}
