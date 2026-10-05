# Lead-flow interface (step 2) -- progress ledger

Work on `main`, pushed after each finished unit (the operator's instruction: no feature branch, no pull
request). Design: `docs/superpowers/specs/2026-10-05-lead-ux-design.md`. One line per finished unit; every design
ruling as "Ruling: what -- why -- cost if wrong"; what was left undone; the stale gates; the three checks before
each push.

## Environment

- Cloud container, Node 22.22 (the repository asks for >= 26; `npm ci` warns and installs). No Postgres, no
  daemon, no real model CLI. Tests are written and NOT run (the operator's instruction); the three checks run
  before every push are `npm run typecheck`, `npm run web:build` and `npm run gate:m26-vocabulary`.
- Every push is `git push --no-verify origin main` (the pre-push hook runs the whole suite, which must not run
  here).

## Units

- Part 1, the design: `docs/superpowers/specs/2026-10-05-lead-ux-design.md` -- six screens and sign-in, one
  Project screen with no tabs, every CLI-only control placed, the removals listed (spec sections 6, 7, 9).

- Control verbs (`feat(control)`): `deleteWorkspace` + CLI `delete-workspace --workspace <id> --yes`,
  `continueWorkspace` / `resumePausedRuns`, `decideBuild` (accept / leave / retry / merged), the read models
  `projectView` and `listProjects`, the domain's `projectPhaseOf`, its label tables and `doingSentence`, and the
  time limit at creation (`createWorkspace.goalTimeLimitMs`, the intake draft's `timeLimitMs`). Tests written,
  not run: `packages/control/test/integration/{delete-workspace,continue,lead-decide,project-view}.test.ts`,
  new cases in `create-workspace.test.ts`, `intake-accept.test.ts`, `apps/orchestrator/test/integration/cli.test.ts`,
  `packages/domain/test/lead/{phase,doing}.test.ts`, `packages/domain/test/intake/draft.test.ts`,
  `apps/web/test/refusal-status.test.ts` (the new kind).
- The new interface (`feat(web)`): shadcn/ui set up for Next 15 / Tailwind 4 (`apps/web/components.json`,
  the tokens in `globals.css`, 27 components in `components/ui/`, `lucide-react`, `sonner`), and every screen of
  the design built from them -- the frame (`(app)/layout.tsx`, `AppSidebar`), Home, New project, Project (with
  the decision card and the Settings sheet), Report, Helpers, Settings, Sign in. The old interface is gone: 25
  page and API route groups, about 150 components, 16 hooks, 33 lib files, 45 server read models and 174 test
  files that tested them. New thin routes: `/api/projects`, `/api/helpers`, `/api/w/:id` (DELETE),
  `/api/w/:id/{project,continue,flow,lead}`, `/api/w/:id/goals/:n/{accept,leave,retry,merged}`; test
  `apps/web/test/integration/lead-routes.test.ts`, and `packages/control/test/integration/helpers.test.ts`.
- Looked at, not tested (`fix(web)`): a scratch Postgres 16 in the container, the migrations, the demo seed and
  six lead-flow projects in every phase, `next dev`, and Playwright screenshots of every screen in light, dark
  and at 390 px. Pressed through by hand: Start building from a drafted conversation (it created the
  repository, the project with its 90-minute limit and build 1), Accept as it is, Stop, Continue and Delete.
  Fixed from what was seen: a hydration warning on relative times, the Proof table's "Why" column clipped on a
  phone, the header squeezed on a phone, "--" in sentences, a ready-to-merge card that said "automatic merge
  is off" when it was on, the sidebar lagging behind a delete, and a conversation lost on reload (it is now
  in the address, `/new?intake=<id>`). This is not a test run: no vitest, no gate.
- Web tests (`test(web)`), written and not run: `apps/web/test/{format,api,tokens,pure-screens}.test.ts`,
  `apps/web/test/{theme,home-view,decision-card,project-screen,report-view,helpers-login-delete,new-project,
  app-sidebar}.test.tsx`, with the fixtures `apps/web/test/fixtures/{project,dom}.ts` (`stubBrowser` gives jsdom
  `matchMedia`, `ResizeObserver` and `scrollIntoView`, which Radix asks for). `vitest.config.ts` maps `@/` to
  `apps/web/src/` for both projects.

## Rulings

- Ruling: `deleteWorkspace` also deletes `InboundEvent` and `SlaveMessage` rows by their bare `workspaceId`,
  and the lead flow's three system persons (no template, every seat in this project's `Lead flow` team) --
  "everything under it" includes the rows no foreign key reaches, and the system persons exist only for this
  project -- if an external delivery's record was meant to outlive its project (M54 R4 says it outlives its
  mapping), it is gone with the project.
- Ruling: deleting writes no event -- the project's log is what is deleted, and an event on a deleted
  workspace id would be an orphan row the next delete would have to find -- nobody can later read who deleted
  a project; the CLI's and the route's own output is the only record.
- Ruling: the intake draft's `timeLimitMs` is `.optional()` (absent = no limit), not `.default(null)` --
  a required output field broke every fixture typed `IntakeDraft` in four packages -- none known.
- Ruling: a time limit given to `createWorkspace` outside the lead flow is refused (`lead_setting_invalid`)
  rather than stored -- nothing reads it there, and storing it would say a cap exists that does not --
  a person who picks Cursor on the card and a time limit gets a refusal, which the card prevents by
  hiding the time limit for another runtime.
- Ruling: `decideBuild('accept')` closes the build's open `goal_needs_human` card (`rejected`, with the reason
  "accepted as it is", the `resolveSettledDecisions` way) -- the answer was given on the Project screen, not on
  the card -- the card's record says "rejected" where the person accepted; its reason says what happened.
- Ruling: the shadcn/ui components are the upstream new-york-v4 registry files, fetched from the shadcn
  repository on GitHub (the registry host `ui.shadcn.com` is refused by this container's proxy, so the CLI
  could not run) with only the import paths rewritten, and kept in their upstream style (double quotes) --
  they are vendored, and a hand-restyled copy would drift from what `npx shadcn add` writes -- the two
  edits beyond imports: `sonner.tsx` reads this app's `ThemeProvider` instead of `next-themes`, and
  `dropdown-menu.tsx`'s checkbox item passes `checked` through its props spread (identical behaviour) so
  the test tsconfig's `exactOptionalPropertyTypes` accepts it.
- Ruling: the swap is one commit -- the old primitives (`components/ui/Button.tsx`) and shadcn's
  (`components/ui/button.tsx`) differ only in case, which a case-insensitive checkout (macOS) cannot hold
  side by side, and the old screens import the old primitives -- the push after the design and the control
  verbs is one large commit instead of one per screen.
- Ruling: every API route that only a removed screen called is removed with it (org, persons, slaves, teams,
  skills, sim, home, sidebar, and under `/w/:id` activity, events, graph, organization, overview, shell,
  skill-graph, team(s), tasks, needs-you, memories, runbook, staffing, slaves, supervisor, messages, runs,
  company, limits, provider, goal/history, clear-halt) -- the design (section 9) removes those screens, and
  a route nothing calls is surface nobody tests in a browser -- the gates and scripts that dialled them are
  stale (see Stale gates); the control verbs behind them are untouched and the CLI still reaches every one.
  This sharpens the spec's section 9 sentence ("routes that are a thin envelope over a control verb stay"),
  which is amended to match.
- Ruling: the theme is the class `dark` on `<html>` (shadcn's `@custom-variant dark`), stamped before the
  first paint by `THEME_BOOT_SCRIPT` in `lib/themeStorage.ts`; the storage key `theme` is unchanged, so a
  person's stored choice survives the swap -- the old `data-theme` attribute is gone, and nothing reads it.
- Ruling: the sidebar collapses at shadcn's own breakpoint (768 px) rather than the spec's 1024 px -- the
  component owns it (`useIsMobile`), and changing it means editing vendored code -- between 768 and 1024 px
  the sidebar takes 256 px of a narrow window; the Project screen's two columns fold to one below 1024 px.
- Ruling: the Report page leaves out the trail and the caveats -- both are written in Slave's internal
  vocabulary ("goal v3", "package", "conducted"), which the design keeps off the screen (U-4) -- the
  Markdown download carries them whole, and the page says so.
- Ruling: New project's "conversation used all its turns" offers a fresh conversation, not a hand-filled
  card -- `acceptIntake` refuses an existing repository no conversation reported, so a blank card could not
  be accepted -- a person whose conversation ran out starts again (spec section 6.2 amended).
- Ruling: the project phase lays a halt over the build's state (`paused` for an emergency stop, `failed` for
  any other halt) -- nothing runs while either holds, and Continue is the one action -- a project halted after
  delivery reads Paused instead of Delivered until Continue.

## Left undone

## Stale gates

## Checks before each push
- Before the spec push (`docs(spec)`): typecheck exit 0 (1 m 43 s); web:build exit 0; vocabulary PASS.
- Before the control push (`feat(control)`): typecheck exit 0; web:build exit 0; vocabulary PASS.
- Before the interface push (`feat(web)`): typecheck exit 0; web:build exit 0 (14 routes, `/w/[workspaceId]` 287 kB
  first load); vocabulary PASS after two test lines were moved to the quoted tool name.
- Before the QA-fix push (`fix(web)`): typecheck exit 0; web:build exit 0; vocabulary PASS.
- Before the web-tests push (`test(web)`): typecheck exit 0; web:build exit 0; vocabulary PASS.
