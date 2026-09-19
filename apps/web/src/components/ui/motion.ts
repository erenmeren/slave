/**
 * The motion constants `Sheet` animates with (M61 R15/R16). This file and `Sheet.tsx` are the
 * ONLY two files in `src/` that import `motion` -- every other consumer of a spring/duration value
 * imports the plain numbers from here instead, so the dependency stays load-bearing in exactly one
 * place.
 */

/** The enter spring: a critically-damped (`bounce: 0`) spring tuned to *feel* like a 0.35s curve
 *  (`visualDuration`) rather than a literal duration -- springs settle at their own pace, and
 *  `visualDuration` is framer-motion's way of aiming one at a target feel without faking a tween. */
export const SPRING = { type: 'spring', bounce: 0, visualDuration: 0.35 } as const

/** The exit spring: the same shape, tuned faster (0.22s) -- leaving reads quicker than arriving. */
export const EXIT = { type: 'spring', bounce: 0, visualDuration: 0.22 } as const

/** Drag-to-dismiss thresholds for `Sheet`'s panel (px/ms and fraction of the panel's own size --
 *  see `Sheet.tsx`'s `onDragEnd`). */
export const DISMISS_VELOCITY = 0.11
export const DISMISS_TRAVEL = 0.4
