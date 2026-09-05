/** Types for the vendored engine (M28 §4.1): only what `liveOffice.ts` and the office components
 *  touch. The JS is the source of truth; these names follow the M26 rename (the noun is `slave`, not its pre-rename form). */
export interface WorldTask {
  key: string
  title: string
  color: string | null
  deptColor: string | null
  status: string
  blockedBy: WorldTask | null
}
export interface WorldPoint { x: number; y: number }
export interface WorldSlave {
  id: string
  name: string
  role: string
  color: string
  dept: number
  /** `sit | walk | grab | work | blocked | pausing | paused | resuming | coffee | arcade | deliver` */
  state: string
  next?: string
  delivering?: boolean
  task: WorldTask | null
  progress: number
  x: number
  y: number
  dir: number
  vdir?: 'front' | 'back' | 'side'
  path: WorldPoint[]
  timer: number
  deskIdx: number
  sw: number
  lookIdx?: number
}
export interface WorldDepartment { name: string; color: string; index: number; x0: number; x1: number; y0: number; y1: number; band?: number }
export interface WorldDesk { x: number; y: number; dept: number; slave?: WorldSlave }
export interface WorldView { S: number; ox: number; oy: number; w: number; h: number; levels: number[]; li: number; base?: number }
export interface WorldHit { id: string; x: number; y: number; w: number; h: number }
export interface WorldEvent { seq: number; t: number; type: string; slave: string; slaveColor: string; task: string; text: string }
export interface DepartmentInput { name: string; color: string; slaves: { name: string; role: string; color?: string }[] }
export type StatusKey = 'working' | 'planning' | 'review' | 'waiting' | 'blocked' | 'done' | 'paused' | 'idle'

export declare class World {
  constructor(cfg: { departments: DepartmentInput[] })
  t: number
  hour: number
  hourLock: number | null
  focusId: string | null
  slaves: WorldSlave[]
  departments: WorldDepartment[]
  desks: WorldDesk[]
  board: { todo: WorldTask[]; doing: WorldTask[]; review: WorldTask[]; done: WorldTask[] }
  view?: WorldView
  viewHits?: WorldHit[]
  events: WorldEvent[]
  W: number
  D: number
  tick(dt: number): void
  simulate(dt: number): void
  status(slave: WorldSlave): StatusKey
  clock(): string
  seat(slave: WorldSlave): WorldPoint
  goTo(slave: WorldSlave, target: WorldPoint, next: string): void
  boardTarget(): WorldPoint
  coffeeTarget(): WorldPoint
  arcadeTarget(): WorldPoint
  ev(type: string, slave: WorldSlave | null, task: WorldTask | null, text: string): void
  pause(id: string): void
  resume(id: string): void
  stop(id: string): void
}
export declare class WorldF extends World {}
export declare const STATUS: Record<StatusKey, string>
export declare const DEPT_COLORS: readonly string[]
export declare const SLAVE_COLORS: readonly string[]
export declare function renderIsoE(
  ctx: CanvasRenderingContext2D,
  world: World,
  opts: { viewKey?: string; tod?: boolean; fun?: boolean; autofit?: boolean; deptSigns?: 'banner' | 'pole' },
): void
export declare function tod(hour: number): { sky: string; horizon: string; ambient: string; light: number; label: string }
export declare function makeDepartments(deptCount: number, perDept: number): DepartmentInput[]
/** The family the canvas labels ask for (`next/font` serves Silkscreen under a hashed name). */
export declare function setPixelFont(family: string): void
