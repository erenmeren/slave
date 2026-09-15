#!/usr/bin/env bash
# The image's one entrypoint. First argument is a verb:
#   web      migrate, seed ONLY if the database holds no workspace at all, then `next start`
#   daemon   migrate, then the orchestrator daemon (extra args pass through)
#   seed     migrate, then re-seed NOW -- the seed is truncate-and-reseed, so this wipes demo data
#   migrate  migrate and exit
#   <other>  any orchestrator CLI verb, e.g. `create-user --name you`
# Two containers (web, daemon) may run `migrate deploy` at the same moment; Prisma serialises
# that with an advisory lock, so both are safe and only `web` seeds. The seed is guarded by a
# COUNT, not by a first-run marker: the database is usually the same one the host flow already
# filled, and the seed truncates before it inserts -- a marker would have wiped real workspaces on
# the container's first start.
set -euo pipefail
cd /app

verb="${1:-web}"
shift || true

export SLAVEOFAI_STATE_DIR="${SLAVEOFAI_STATE_DIR:-/state}"
mkdir -p "$SLAVEOFAI_STATE_DIR"

migrate() {
  npx prisma migrate deploy \
    --schema packages/db/prisma/schema.prisma \
    --config packages/db/prisma.config.ts
}

seed() {
  node packages/db/dist/seed.js
}

workspace_count() {
  node --input-type=module -e "
    const { prisma } = await import('/app/packages/db/dist/client.js')
    const n = await prisma.workspace.count()
    await prisma.\$disconnect()
    console.log(n)
  "
}

case "$verb" in
  web)
    migrate
    if [ "$(workspace_count)" = "0" ]; then
      echo "entrypoint: empty database -- seeding the demo company"
      seed
    else
      echo "entrypoint: database already has workspaces -- not seeding (run the seed verb to wipe and re-seed)"
    fi
    exec node node_modules/next/dist/bin/next start apps/web -H 0.0.0.0 -p "${PORT:-3000}"
    ;;
  daemon)
    migrate
    exec node apps/orchestrator/dist/cli.js daemon "$@"
    ;;
  seed)
    migrate
    seed
    ;;
  migrate)
    migrate
    ;;
  *)
    exec node apps/orchestrator/dist/cli.js "$verb" "$@"
    ;;
esac
