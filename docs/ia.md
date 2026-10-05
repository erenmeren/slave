# Information architecture

What each screen of the web app is for. Rebuilt from nothing on 2026-10-05 around the lead flow; the design and
its reasons are `docs/superpowers/specs/2026-10-05-lead-ux-design.md`, and this page is its map. The previous
map (rail, seven project tabs, right panel, two modes) is in this file's git history before that date.

## The rules

1. **A screen answers one question.** One project is understood from one screen; it has no tabs.
2. **A decision is impossible to miss.** A build waiting for a person turns its sidebar row amber with a
   count, leads Home under "Waiting for you", puts the count in the browser tab's title, and opens the Project
   screen with an amber decision card that is answered in place.
3. **Plain words.** No internal term on screen: no "goal version", "conducted", "work package", "runtime role",
   raw status token. A raw value may sit in a `title` or a `data-` attribute. The words are in the design's
   section 4 and in `packages/domain/src/lead/phase.ts`.
4. **One component system.** shadcn/ui (`apps/web/components.json`, `apps/web/src/components/ui/`), its tokens
   in `apps/web/src/app/globals.css`, light and dark from the same variables.
5. **One read model per screen.** Home and the sidebar read `listProjects`, the Project screen `projectView`;
   both live in `packages/control` and are polled (3 s while something runs, 10-15 s otherwise).

## The frame

A left sidebar (`components/app/AppSidebar.tsx`): the product mark, **New project**, every project with its
state dot and an amber count when something waits, **Helpers**, **Settings**, and at the bottom the theme switch
and, with accounts on, Sign out. Below 768 px it slides in behind a menu button. Sign in has no sidebar (the
frame is the `(app)` route group's layout).

## Screens

| Route | Screen | The question it answers |
|---|---|---|
| `/` | Home | Is anything waiting for me, and how are my projects doing? |
| `/new` | New project | What do I want built, and how much may it spend? |
| `/w/:id` | Project | What is happening to this project, and does it need me? |
| `/w/:id/goals/:n` | Report | What exactly was asked, checked, decided and spent for this build? |
| `/helpers` | Helpers | Who can the lead call on? |
| `/settings` | Settings | How is this installation set up? |
| `/login` | Sign in | -- |

The Project screen's Settings sheet holds the lead flow's settings: limits, the lead's model, the helpers the
lead may call, automatic merge, how the project is built, archive and delete. A project still in the packages
flow opens on the same screen, read-only.

## Old addresses

`/workforce`, `/slaves`, `/skills` go to `/helpers`; `/analytics` and `/sim/*` go to `/`;
`/w/:id/{tasks,activity,graph,office,knowledge,organization,settings}` go to `/w/:id` (307, `next.config.ts`).
