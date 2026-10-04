'use client'

/**
 * "Your change is with a reviewer" — on the partner's own dashboard.
 *
 * Renders nothing unless this record carries a `pendingChanges` block, so it is
 * invisible to everybody who has not proposed anything.
 *
 * It exists because of what happens when a partner cannot see the state of
 * their own submission. This project already has four duplicate host
 * applications for one host, filed by somebody who pressed the button, saw
 * nothing change, and reasonably concluded it had not worked. A proposal is
 * worse in that respect than an application, because the whole design is that
 * the live record does NOT move — so the screen looks exactly as it did before,
 * and looking unchanged is precisely what a successful proposal is meant to
 * look like.
 *
 * So this says three things, and all three are load-bearing:
 *
 *   1. it is with a reviewer, and nothing further is needed from you;
 *   2. what is STILL IN FORCE — for a payout field, this is the account money
 *      is actually going to, which is the single most useful fact on the page
 *      for anyone wondering whether their change "took";
 *   3. what was proposed, so they can see whether they typed it correctly
 *      before a reviewer wastes a round trip telling them they did not.
 *
 * Nothing here can approve, cancel or amend a proposal. Amending one is simply
 * proposing again, which the form below this panel already does.
 */

import { Clock, Landmark, XCircle } from 'lucide-react'
import {
  PAYOUT_FIELDS,
  changesOf,
  displayValue,
  readPendingChanges,
  type PendingChanges,
} from '@/lib/pendingChanges'

function whenOf(value: unknown): string {
  if (!value) return ''
  const ts = value as { toMillis?: () => number; seconds?: number }
  let ms = NaN
  try {
    if (typeof ts.toMillis === 'function') ms = ts.toMillis()
    else if (typeof ts.seconds === 'number') ms = ts.seconds * 1000
    else if (typeof value === 'string') ms = new Date(value).getTime()
  } catch {
    /* unusable timestamp — the panel is useful without a date on it */
  }
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

export function PendingChangesNotice({
  record,
  /** What this partner is called in the sentence about being paid. */
  kind = 'partner',
}: {
  /** The live Firestore document, whatever shape the dashboard holds it in. */
  record: Record<string, unknown> | null | undefined
  kind?: 'agency' | 'seller' | 'partner'
}) {
  const pending: PendingChanges | null = readPendingChanges(
    (record ?? {}).pendingChanges,
  )
  const changes = record && pending ? changesOf(pending, record) : []

  /**
   * A change that was looked at and refused.
   *
   * Shown only when no proposal is open, because the two cannot both be the
   * current state and a refusal printed above a fresh submission reads as a
   * refusal OF it. The field is written by the server and the security rules
   * give the partner no way to clear it themselves — proposing again may only
   * touch `pendingChanges`, `kycStatus` and `kycSubmittedAt` — so it lingers on
   * the document until the next decision, and this ordering is what keeps that
   * from being misleading.
   */
  const refusal = (record ?? {}).pendingChangesRejectionReason
  if (!record || !pending || changes.length === 0) {
    if (typeof refusal !== 'string' || !refusal.trim()) return null
    return (
      <div className="bg-slate-900 border border-red-500/30 rounded-xl p-5 mb-6">
        <p className="flex items-center gap-2 text-red-300 text-sm font-semibold">
          <XCircle size={15} /> Your last change was not applied
        </p>
        <p className="text-slate-300 text-sm mt-1.5">{refusal}</p>
        <p className="text-slate-500 text-xs mt-2">
          Nothing on your record changed, so your details are exactly as they
          were. You can submit a corrected version below.
        </p>
      </div>
    )
  }

  const touchesPayout = changes.some((c) =>
    (PAYOUT_FIELDS as readonly string[]).includes(c.field),
  )
  const submitted = whenOf(pending.submittedAt)

  return (
    <div className="bg-slate-900 border border-blue-500/30 rounded-xl p-6 mb-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-full bg-blue-500/10 flex items-center justify-center shrink-0">
          <Clock size={20} className="text-blue-300" />
        </div>
        <div>
          <h3 className="text-white font-semibold">
            Your change is with a reviewer
          </h3>
          <p className="text-slate-400 text-xs mt-0.5">
            {submitted ? `Submitted ${submitted}. ` : ''}
            Nothing more is needed from you — sending it again just puts a second
            copy of the same request in the queue.
          </p>
        </div>
      </div>

      {touchesPayout && (
        <p className="flex items-start gap-2 bg-blue-500/10 border border-blue-500/25 rounded-lg px-3 py-2.5 text-blue-100 text-sm mb-4">
          <Landmark size={15} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium">You are still being paid into the
            account marked &ldquo;in force&rdquo; below.</span>{' '}
            A change to where money goes only takes effect once somebody has
            checked it, so your earnings are not held up while it waits.
          </span>
        </p>
      )}

      <div className="space-y-2.5">
        {changes.map((c) => (
          <div
            key={c.field}
            className="grid grid-cols-1 sm:grid-cols-[9rem_1fr_1fr] gap-1 sm:gap-3 items-baseline"
          >
            <p className="text-slate-400 text-xs uppercase tracking-wide">{c.label}</p>
            <p className="text-slate-300 text-sm">
              <span className="text-slate-600 text-xs mr-1.5">in force</span>
              {displayValue(c.from)}
            </p>
            <p className="text-blue-200 text-sm">
              <span className="text-slate-600 text-xs mr-1.5">proposed</span>
              {displayValue(c.to)}
            </p>
          </div>
        ))}
      </div>

      {pending.note && (
        <p className="text-slate-500 text-xs mt-4">
          You said: &ldquo;{pending.note}&rdquo;
        </p>
      )}

      <p className="text-slate-600 text-xs mt-4">
        {kind === 'seller'
          ? 'Your account keeps working exactly as it did while this is reviewed.'
          : 'Your account keeps working exactly as it did — you can carry on ' +
            'trading, recruiting and earning while this is reviewed.'}
      </p>
    </div>
  )
}
