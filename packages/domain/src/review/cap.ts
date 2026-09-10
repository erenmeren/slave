/**
 * How many review runs one implementation may spend before the task is parked for a human (M35).
 *
 * In the domain rather than beside its enforcement point, because since M42 t1 there are two and
 * they are in different packages: `apps/orchestrator`'s `dispatchReview` parks the task when this
 * many review runs since the latest implementation run have produced no usable verdict, and
 * `packages/control`'s `unblockTask` reads it to decide whether returning that task to `reviewing`
 * would accomplish anything -- a control package may not import an application, and two copies of
 * the number would make an unblock that undoes itself possible again.
 */
export const REVIEW_RETRY_CAP = 2
