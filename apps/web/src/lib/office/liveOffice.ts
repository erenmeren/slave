import type { OverviewSnapshot, SlaveCardData } from '../../server/overview'
import { WorldF, type WorldSlave, type WorldTask } from './engine.js'

/** The overview stream's per-slave status plus the one derived value the floor needs: `blocked`
 *  (M28 §3.2, §4.2). Everything else is `SlaveStatus` as the stream sends it. */
export type LiveStatus = 'idle' | 'starting' | 'working' | 'blocked' | 'pausing' | 'paused' | 'resuming' | 'stopping'

export interface LiveSlave {
  readonly slaveId: string
  readonly status: LiveStatus
  readonly taskTitle: string | null
  readonly stepLabel: string | null
  readonly progressPct: number
  readonly runId: string | null
}

export interface LiveBoard {
  readonly todo: number
  readonly doing: number
  readonly review: number
  readonly done: number
}

export interface OfficeRosterSlave {
  readonly slaveId: string
  readonly name: string
  readonly role: string
  readonly color: string
}

export interface OfficeRosterDepartment {
  readonly teamId: string
  readonly name: string
  readonly color: string
  readonly slaves: readonly OfficeRosterSlave[]
}

/** Blocked wins over the run's own status: a slave whose task is blocked shows the red bubble
 *  whatever the run is doing. (R4: the overview's `blocked` list holds PAUSED runs under
 *  `kind: 'run'`, not blocked ones — a paused slave's own `runId` is exactly that row, so reading
 *  it here made every paused slave render as blocked. The task status is the one blocked signal.) */
export function liveStatusOf(card: SlaveCardData): LiveStatus {
  if (card.taskStatus === 'blocked') return 'blocked'
  return card.status
}

export function liveSlavesOf(overview: OverviewSnapshot): ReadonlyMap<string, LiveSlave> {
  return new Map(
    overview.slaves.map((card) => [
      card.id,
      {
        slaveId: card.id,
        status: liveStatusOf(card),
        taskTitle: card.taskTitle,
        stepLabel: card.stepLabel,
        progressPct: card.progressPct,
        runId: card.runId,
      },
    ]),
  )
}

/** The wall board's four columns from the counts the stream already carries (M28 §2): ready → todo,
 *  `active` minus `ready` (R7: `tasks.active` already includes `ready`, and `merging`, so counting
 *  both would double them onto the wall) → doing, the merge queue → review, done → done. */
export function boardFromOverview(overview: OverviewSnapshot): LiveBoard {
  return {
    todo: overview.tasks.ready,
    doing: Math.max(0, overview.tasks.active - overview.tasks.ready),
    review: overview.mergeQueue.length,
    done: overview.tasks.done,
  }
}

/** The design's board draws at most this many cards per column before they run off the wall. */
const BOARD_CAP = 6

/** Where a slave sits when its status needs no walk: the floor state per live status. */
const AT_DESK: Record<Exclude<LiveStatus, 'starting' | 'resuming' | 'stopping'>, string> = {
  working: 'work',
  blocked: 'blocked',
  pausing: 'paused',
  paused: 'paused',
  idle: 'sit',
}

/** States in which the slave is at its desk and can adopt a new status directly. */
const SEATED = new Set(['sit', 'work', 'blocked', 'paused'])

function cards(count: number): WorldTask[] {
  return Array.from({ length: Math.max(0, Math.min(BOARD_CAP, count)) }, () => ({
    key: '',
    title: '',
    color: null,
    deptColor: null,
    status: 'todo',
    blockedBy: null,
  }))
}

/**
 * The design's office with the invention removed (M28 §4.2). `WorldF` lays the pods out and draws;
 * this class replaces `simulate` so a slave's state comes from `apply()` — the stream's status per
 * slave — instead of the engine's own task board and dice. What stays from the design: the walk to
 * the board when a run starts, the walk with the finished work when it stops, the idle wander to
 * the arcade and the coffee machine, the cat, the roomba, the boss. The engine's confetti machinery
 * also stays (R6), but nothing in this adapter fires it: `progressPct` is a tool-call ratio, not a
 * finish line (a normal success ends well under 100), and the stream's `liveEvents` do not carry a
 * per-slave `run.succeeded` — there is no live signal to build a trigger from.
 */
export class LiveOffice extends WorldF {
  private live: ReadonlyMap<string, LiveSlave> = new Map()
  private wallHour = 9
  /** The status each slave last walked for, so `starting` seen on ten consecutive snapshots is one walk. */
  private readonly walkedFor = new Map<string, LiveStatus>()

  constructor(departments: readonly OfficeRosterDepartment[]) {
    super({
      departments: departments.map((d) => ({
        name: d.name,
        color: d.color,
        slaves: d.slaves.map((s) => ({ name: s.name, role: s.role, color: s.color })),
      })),
    })
    // The engine numbers its slaves `a0, a1, …` in roster order; the floor answers to real ids.
    const ids = departments.flatMap((d) => d.slaves.map((s) => s.slaveId))
    this.slaves.forEach((slave, i) => {
      slave.id = ids[i] ?? slave.id
    })
  }

  liveOf(slaveId: string): LiveSlave | null {
    return this.live.get(slaveId) ?? null
  }

  setWallClock(hour: number): void {
    this.wallHour = hour
  }

  /** One stream snapshot: the status, task and progress of every slave, and the board counts. */
  apply(live: ReadonlyMap<string, LiveSlave>, board: LiveBoard): void {
    for (const slave of this.slaves) {
      const after = live.get(slave.id)
      // R5: a task-less (goal-directed) run still has a real progress and step; the task line and
      // the progress bar follow the live entry's status, not `taskTitle` — a null title just means
      // the board shows an em dash instead of no task at all.
      if (after !== undefined && after.status !== 'idle') {
        slave.task = { key: after.stepLabel ?? '', title: after.taskTitle ?? '—', color: slave.color, deptColor: null, status: 'doing', blockedBy: null }
        slave.progress = Math.max(0, Math.min(100, after.progressPct))
      } else {
        slave.task = null
        slave.progress = 0
      }
    }
    this.live = live
    this.board = { todo: cards(board.todo), doing: cards(board.doing), review: cards(board.review), done: cards(board.done) }
  }

  private statusOf(slave: WorldSlave): LiveStatus {
    return this.live.get(slave.id)?.status ?? 'idle'
  }

  /** The engine's `tick` still runs the clock, the cat, the roomba, the boss and the confetti; this
   *  is the part that used to invent work. Walks are the design's; states come from the stream. */
  override simulate(dt: number): void {
    for (const slave of this.slaves) {
      slave.timer -= dt
      slave.sw += dt
      switch (slave.state) {
        case 'walk': {
          const p = slave.path[0]
          if (p === undefined) {
            slave.state = slave.next ?? 'sit'
            slave.timer = slave.next === 'grab' ? 1.4 : slave.next === 'coffee' ? 3.5 : slave.next === 'arcade' ? 5 : 0
            if (slave.next === 'deliver') {
              slave.state = 'grab'
              slave.timer = 1.2
              slave.delivering = true
            }
            break
          }
          const dx = p.x - slave.x
          const dy = p.y - slave.y
          const d = Math.hypot(dx, dy)
          const sp = 38 * dt
          if (d <= sp) {
            slave.x = p.x
            slave.y = p.y
            slave.path.shift()
          } else {
            slave.x += (dx / d) * sp
            slave.y += (dy / d) * sp
          }
          if (Math.abs(dx) > 0.5) slave.dir = dx > 0 ? 1 : -1
          slave.vdir = Math.abs(dy) > Math.abs(dx) ? (dy > 0 ? 'front' : 'back') : 'side'
          break
        }
        case 'grab':
          if (slave.timer <= 0) {
            if (slave.delivering === true) {
              slave.delivering = false
              this.goTo(slave, this.seat(slave), 'sit')
              slave.timer = 1.5
            } else {
              this.goTo(slave, this.seat(slave), 'work')
            }
          }
          break
        case 'coffee':
        case 'arcade':
          if (slave.timer <= 0) {
            this.goTo(slave, this.seat(slave), 'sit')
            slave.timer = 3
          }
          break
        default:
          break
      }
      this.reconcile(slave)
    }
  }

  /** A seated slave adopts the live status; a walking one finishes its walk first. */
  private reconcile(slave: WorldSlave): void {
    if (!SEATED.has(slave.state)) return
    const status = this.statusOf(slave)
    if (status === 'starting' || status === 'resuming') {
      if (this.walkedFor.get(slave.id) !== status) {
        this.walkedFor.set(slave.id, status)
        this.goTo(slave, this.boardTarget(), 'grab')
      } else {
        slave.state = 'work'
      }
      return
    }
    if (status === 'stopping') {
      if (this.walkedFor.get(slave.id) !== status) {
        this.walkedFor.set(slave.id, status)
        this.goTo(slave, this.boardTarget(), 'deliver')
      } else {
        slave.state = 'sit'
      }
      return
    }
    this.walkedFor.delete(slave.id)
    const target = AT_DESK[status]
    if (slave.state !== target) {
      slave.state = target
      slave.timer = 2 + Math.random() * 3
    }
    if (status === 'idle' && slave.timer <= 0) {
      const r = Math.random()
      if (r < 0.18) this.goTo(slave, this.arcadeTarget(), 'arcade')
      else if (r < 0.4) this.goTo(slave, this.coffeeTarget(), 'coffee')
      else slave.timer = 2 + Math.random() * 3
    }
  }

  override tick(dt: number): void {
    super.tick(dt)
    this.hour = this.hourLock ?? this.wallHour
    // Progress is the stream's number, whatever the boss did this frame (same rule as `apply()`:
    // the live entry's status decides, not its title — R5).
    for (const slave of this.slaves) {
      const l = this.live.get(slave.id)
      slave.progress = l !== undefined && l.status !== 'idle' ? Math.max(0, Math.min(100, l.progressPct)) : 0
    }
  }
}
