/**
 * A read that was REFUSED and a read that returned NOTHING are different facts.
 *
 * The CRM used to erase that difference wholesale — `.catch(() => 0)`,
 * `?? 0`, a `safe(promise, 0)` helper — and the owner was shown a dashboard of
 * confident zeroes that were, every one of them, permission errors. "₹0
 * revenue" and "you are not allowed to see revenue" are not the same sentence
 * and must never render the same way.
 *
 * This module is the one place that decides how a failed read is described, so
 * every screen describes it identically. It deliberately offers no
 * `valueOr(result, 0)`: there is no correct default for a measurement that was
 * never taken.
 */

/**
 * The error codes that identify themselves, because each one calls for a
 * different response from the reader:
 *   • `permission-denied`   — ask an owner for access; refreshing will not help
 *   • `failed-precondition` — a Firestore index is missing; a developer fix
 *   • `unavailable`         — network/outage; retrying is the right move
 */
export type ReadFailureCode =
  | 'permission-denied'
  | 'failed-precondition'
  | 'unavailable'
  | 'unknown'

export interface ReadSuccess<T> {
  ok: true
  value: T
}

export interface ReadFailure {
  ok: false
  code: ReadFailureCode
  /** One sentence, already fit to put on screen. Never a bare stack trace. */
  reason: string
}

export type ReadResult<T> = ReadSuccess<T> | ReadFailure

/** Narrowing helper for `.filter()` and friends. */
export function isOk<T>(r: ReadResult<T>): r is ReadSuccess<T> {
  return r.ok
}

export function ok<T>(value: T): ReadSuccess<T> {
  return { ok: true, value }
}

interface CodedError {
  code?: unknown
  status?: unknown
  message?: unknown
}

/** Classify an unknown rejection into one of the four codes above. */
export function failureCode(err: unknown): ReadFailureCode {
  if (!err || typeof err !== 'object') return 'unknown'
  const e = err as CodedError

  // Firestore rejects a query the security rules do not allow with this code.
  // It is the most likely cause in this CRM and the least obvious from the
  // raw message, which is why every screen must name it explicitly.
  if (e.code === 'permission-denied') return 'permission-denied'
  if (e.code === 'failed-precondition') return 'failed-precondition'
  if (e.code === 'unavailable') return 'unavailable'

  // ApiError from lib/api carries an HTTP status instead of a Firestore code.
  if (typeof e.status === 'number') {
    if (e.status === 401 || e.status === 403) return 'permission-denied'
    if (e.status === 0 || e.status >= 500) return 'unavailable'
  }

  return 'unknown'
}

/**
 * Why a read did not produce a figure, in a sentence worth showing.
 *
 * The wording for the three named codes is the wording the dashboard already
 * used — kept verbatim so nothing on screen changes shape, only its reach.
 */
export function failureReason(err: unknown): string {
  switch (failureCode(err)) {
    case 'permission-denied':
      return 'The database refused this read. Your role may not cover it, or the rule for it is missing.'
    case 'failed-precondition':
      return 'The database refused this read — a required index does not exist.'
    case 'unavailable':
      return 'The database could not be reached. Check your connection.'
    default: {
      if (err && typeof err === 'object') {
        const message = (err as CodedError).message
        if (typeof message === 'string' && message.trim()) return message
      }
      return 'This read did not complete, so there is no figure to show.'
    }
  }
}

/** Turn a rejection into a describable failure, logging it for the console. */
export function toFailure(err: unknown, label?: string): ReadFailure {
  if (label) console.error(`read failed: ${label}`, err)
  return { ok: false, code: failureCode(err), reason: failureReason(err) }
}

/**
 * Run a read and capture whether it worked, instead of substituting a default.
 *
 * This is the replacement for the old `safe(p, fallback, label)`: same call
 * shape, same "one failure must not take the others down", but the caller is
 * now *told* which happened and cannot accidentally print the fallback as if
 * it were a measurement.
 */
export async function attempt<T>(p: PromiseLike<T>, label?: string): Promise<ReadResult<T>> {
  try {
    return ok(await p)
  } catch (err) {
    return toFailure(err, label)
  }
}

/** Adapt one `Promise.allSettled` slot into a `ReadResult`. */
export function fromSettled<T>(r: PromiseSettledResult<T>, label?: string): ReadResult<T> {
  return r.status === 'fulfilled' ? ok(r.value) : toFailure(r.reason, label)
}

/**
 * The first failure among several reads, or null if all of them worked.
 * For a figure computed from more than one read — a percentage, a pie chart —
 * where a single missing input makes the whole figure unsayable.
 */
export function firstFailure(...results: ReadResult<unknown>[]): ReadFailure | null {
  for (const r of results) if (!r.ok) return r
  return null
}
