/**
 * RC — staff registration: the login, then the record, and the login removed
 * again when the record cannot be written.
 *
 * `/agencies/register` and `/sellers/register` create the partner's Firebase
 * Auth login FIRST (it is the authoritative uniqueness test on the address,
 * and it consumes the password at the moment it is typed), then write the
 * record — the `agencies` / `sellers` document for an Owner, an approval
 * request for anybody else. The login was created on a throwaway secondary
 * app that was signed out and discarded straight away, so when the record
 * write then failed nothing could remove the login any more: it stayed in
 * Auth with nothing behind it, the address was taken, and the retry the page
 * invited ("Something went wrong … Please try again") was refused with "a
 * login already exists … remove it in the Firebase console".
 *
 * Here the secondary session stays open until the record is written, so a
 * failure can delete the login it just made — exactly what
 * `runSubAgencyCreation` already does for an agency's own Add Sub-Agency.
 * Whether that removal worked is part of the error, so the page can tell the
 * user the truth: "try again", or "this login must be removed first".
 *
 * Pure: the four steps are injected (`lib/auth.ts::createPartnerLoginThen`
 * supplies the Firebase ones; `loginThenRecord.spec.ts` in-memory ones).
 */

export interface LoginThenRecordSteps<T> {
  /** Create the login. Throws (address in use, weak password…) → nothing exists. */
  createLogin: () => Promise<string>
  /** Write the record that names the login. Its result is handed back. */
  writeRecord: (uid: string) => Promise<T>
  /** Undo `createLogin` when `writeRecord` failed. May throw. */
  deleteLogin: (uid: string) => Promise<void>
  /** Always last: sign the secondary session out and release it. */
  finish: () => Promise<void>
}

/** The record was not written. `loginRemoved` says whether the login is gone again. */
export class RecordNotWritten extends Error {
  readonly uid: string
  readonly loginRemoved: boolean
  readonly reason: unknown

  constructor(uid: string, loginRemoved: boolean, reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason ?? 'The record could not be written.'))
    this.name = 'RecordNotWritten'
    this.uid = uid
    this.loginRemoved = loginRemoved
    this.reason = reason
  }
}

export function isRecordNotWritten(err: unknown): err is RecordNotWritten {
  return err instanceof RecordNotWritten
    || (typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'RecordNotWritten')
}

export async function runLoginThenRecord<T>(steps: LoginThenRecordSteps<T>): Promise<{ uid: string; result: T }> {
  try {
    // A failure here propagates as it is: no login exists, nothing to undo.
    const uid = await steps.createLogin()
    try {
      const result = await steps.writeRecord(uid)
      return { uid, result }
    } catch (err) {
      let removed = false
      try {
        await steps.deleteLogin(uid)
        removed = true
      } catch {
        removed = false
      }
      throw new RecordNotWritten(uid, removed, err)
    }
  } finally {
    await steps.finish().catch(() => undefined)
  }
}

/** What the page says when the record was not written. */
export function recordNotWrittenMessage(err: RecordNotWritten, email: string, what: 'agency' | 'coin seller'): string {
  const why = err.message ? ` (${err.message})` : ''
  if (err.loginRemoved) {
    return (
      `The ${what} record could not be saved${why}, so nothing was created — the login made for ` +
      `${email} a moment ago was removed again. You can try again.`
    )
  }
  return (
    `The ${what} record could not be saved${why}, and the login made for ${email} a moment ago ` +
    'could NOT be removed. It has no record behind it and holds the address: ask an Owner to ' +
    'remove it (Firebase Authentication) or to attach it to a record, before trying again.'
  )
}
