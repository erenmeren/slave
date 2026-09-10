import { listCatalogImports } from '../../../../server/org'

export const dynamic = 'force-dynamic'

/** The last catalog imports (M42 §2, R5), read only -- there is no POST here on purpose: a catalog
 *  is a path on the daemon host's disk and a browser cannot reach it, so importing stays the
 *  `import-catalog` CLI verb's job and this route only reports what it did. */
export async function GET(): Promise<Response> {
  const imports = await listCatalogImports()
  return Response.json({ imports })
}
