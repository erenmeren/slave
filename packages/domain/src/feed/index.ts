/**
 * What has been happening here, said in sentences (M44 R5, M61 R10/R11).
 *
 * Three pure files that lived in `apps/web/src/lib` until the Supervisor chat (F R2): a turn of
 * the conversation shows the model the last {@link CHAT_FEED_MAX} feed sentences, and the turn is
 * assembled in `packages/control`, which may not import the web app. They were always pure -- no
 * `prisma`, no React, no `node:` import -- so the move is a change of address and nothing else,
 * and `apps/web/src/lib/{happening,feedSummary,eventLabels}.ts` are one-line re-exports of these
 * so every web import and every web test keeps resolving (`docs/ia.md` rule 2: nothing is
 * removed, only moved).
 */
export * from './eventLabels.js'
export * from './feedSummary.js'
export * from './happening.js'
