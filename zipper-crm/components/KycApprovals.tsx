'use client'

/**
 * Applicants and KYC, decided from the approval queue.
 *
 * ── WHY THIS IS HERE AND NOT ONLY ON /kyc ────────────────────────────────────
 *
 * The approval queue is where this business decides things. Staff look there,
 * owners look there, and "it will come to the approval queue" is what everybody
 * says about anything that needs a yes. Hosts, agencies and coin sellers did
 * not appear there — they lived on /kyc — so the honest description of the CRM
 * was "everything is approved in one place, except people."
 *
 * The earlier attempt at fixing that was worse than the gap: inviting a host
 * also filed an `add_host` request here, a superadmin pressed Approve, and the
 * request flipped to REJECTED, because the server refuses that type. It read as
 * "this host was turned down" and meant "this queue does not decide hosts",
 * while the application itself sat untouched at pending.
 *
 * The difference now is that nothing is duplicated. These rows are not copies
 * of the applications in a second collection; they ARE the applications, read
 * through `lib/reviewQueues` — the same module /kyc renders — and decided
 * through `lib/reviewDecisions`, the same call /kyc makes. Approving here does
 * the whole decision: `status` and `kycStatus` together, the decider, the time,
 * the reason, and the host grant, all inside one server call. There is no
 * separate KYC step afterwards and no second record to keep in step.
 *
 * ── THE ONE THING THIS SCREEN CANNOT DO ──────────────────────────────────────
 *
 * Show you the documents. A KYC decision is a person looking at an Aadhaar card
 * next to a name; a list row is a name. So every row carries a link to the
 * documents, the reason box is mandatory, and approving without opening the
 * evidence is something this screen makes possible but does not pretend is
 * review. That is a deliberate trade: the alternative — hiding the decision on
 * a screen people do not open — is how applications sat for a week.
 *
 * ── IT SHOWS DECIDED ROWS TOO, AND THAT IS NOT A NEW READ ────────────────────
 *
 * This component used to render only what was waiting, and /approvals only
 * mounted it on the Pending tab. So the Approved, Rejected and All tabs had no
 * source of applicants at all: their only list was `approvalRequests`, the staff
 * permission-request collection, which has never held a host application. With
 * the Host filter on and the Approved tab open the screen said "No approved
 * requests in host" about a host whose CRM profile said "application approved"
 * and whose KYC was sitting approved on /kyc.
 *
 * `loadReviewQueues` was already reading every applicant at every status; both
 * screens were discarding the decided ones. So the fix is a selection —
 * `reviewRowsOf` in lib/reviewQueues — and this component now renders whichever
 * view it is asked for. A decided row carries no buttons: it has already been
 * decided, and re-deciding it is a thing to do on /kyc with the documents open,
 * not from a history list.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, CheckCircle2, ChevronRight, Clock, ExternalLink, Loader2,
  RefreshCw, ShieldCheck, XCircle,
} from 'lucide-react'
import { ApiError } from '@/lib/api'
import { STATUS_TONE } from '@/lib/apiPartners'
import {
  CATEGORY_LABELS, loadReviewQueues, pendingCountOf, reviewRowsOf, reviewTypeTally,
  type Category, type Item, type Queues, type ReviewRow, type ReviewStatusView,
} from '@/lib/reviewQueues'
import {
  approveEffectOf, decideReviewItem, decisionLabelOf,
} from '@/lib/reviewDecisions'

const MIN_REASON = 3

function ageOf(iso: string): string {
  if (!iso) return 'age unknown'
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (Number.isNaN(mins)) return 'age unknown'
  if (mins < 60) return `${Math.max(mins, 0)}m`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`
}

function ageDays(iso: string): number {
  if (!iso) return 0
  const ms = Date.now() - new Date(iso).getTime()
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 86400000)
}

/** The type filter /approvals offers. Only three of them can hold applicants. */
export type ApplicantTypeFilter =
  'all' | 'agency' | 'seller' | 'team' | 'host' | 'finance' | 'config'

/** How many applicant rows a view holds, per type — for the caller's filter pills. */
export interface ApplicantCounts {
  all: number
  agency: number
  seller: number
  host: number
}

const VIEW_WORD: Record<ReviewStatusView, string> = {
  pending: 'waiting on a decision',
  approved: 'approved',
  rejected: 'rejected',
  all: 'on record',
}

export default function KycApprovals({
  onDecided,
  status = 'pending',
  type = 'all',
  onCounts,
}: {
  onDecided?: () => void
  /**
   * Which rows to show. `pending` is the original behaviour and the only view
   * that offers the Approve and Reject buttons.
   */
  status?: ReviewStatusView
  /**
   * The caller's type filter, applied to these rows as well as to its own.
   * Leaving it out of the filter is how "Host + Approved" came to show nothing:
   * the pill filtered one list and not the other.
   */
  type?: ApplicantTypeFilter
  /**
   * Reported back so the caller's filter pills can count these rows. A pill
   * reading 0 above a list of two is the same disagreement as a tile reading 0
   * above a queue of two, and it is not worth fixing one and shipping the other.
   */
  onCounts?: (counts: ApplicantCounts) => void
}) {
  const [queues, setQueues] = useState<Queues | null>(null)
  const [failure, setFailure] = useState('')
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')

  const [reason, setReason] = useState<Record<string, string>>({})
  const [acting, setActing] = useState<Record<string, 'approve' | 'reject' | null>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { queues: built, error } = await loadReviewQueues()
      setQueues(built)
      setFailure(error)
    } catch (e) {
      setQueues(null)
      setFailure(e instanceof ApiError ? e.message : 'The applicant queues could not be read.')
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  /**
   * Tell the caller how many applicant rows each type holds in the current view.
   *
   * Reported for the view, not for the type, deliberately: the caller draws a
   * count beside every type pill and needs all of them, not only the selected
   * one. `onCounts` is a state setter in practice, so this settles after one
   * extra render rather than looping.
   */
  useEffect(() => {
    if (!onCounts) return
    if (!queues) { onCounts({ all: 0, agency: 0, seller: 0, host: 0 }); return }
    onCounts(reviewTypeTally(queues, status))
  }, [queues, status, onCounts])

  async function decide(item: Item, action: 'approve' | 'reject') {
    const why = (reason[item.id] ?? '').trim()
    if (why.length < MIN_REASON) {
      setRowError((e) => ({
        ...e,
        [item.id]: `Say why — at least ${MIN_REASON} characters. It goes on the record and into the audit log.`,
      }))
      return
    }
    setRowError((e) => ({ ...e, [item.id]: '' }))
    setActing((a) => ({ ...a, [item.id]: action }))
    try {
      const extra = await decideReviewItem(item, action, why)
      const did = action === 'approve'
        ? `${item.name} approved — KYC included.`
        : `${item.name} rejected. The reason is on the record.`
      // The server's own sentence wins where it has one: it knows what the
      // decision actually touched, and the line above only knows what was asked.
      setNotice(extra ? `${did} ${extra}` : did)
      setReason((r) => ({ ...r, [item.id]: '' }))
      await load()
      onDecided?.()
    } catch (e) {
      // Verbatim. The API's refusals are written to be read by whoever hit them.
      setRowError((er) => ({
        ...er,
        [item.id]: e instanceof ApiError ? e.message
          : e instanceof Error ? e.message
          : 'That did not go through.',
      }))
    } finally {
      setActing((a) => ({ ...a, [item.id]: null }))
    }
  }

  // `team`, `finance` and `config` are staff permission requests — there is no
  // such thing as a team applicant — so on those filters this section is not
  // empty, it is inapplicable, and the honest rendering of inapplicable is
  // nothing at all. Rendering "no applicant is waiting" there would be a true
  // sentence about a question nobody asked.
  const applies = type === 'all' || type === 'agency' || type === 'seller' || type === 'host'
  if (!applies) return null

  if (loading) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl flex items-center gap-3 px-5 py-6">
        <Loader2 size={16} className="animate-spin text-pink-500" />
        <p className="text-slate-500 text-sm">Reading applicants and KYC…</p>
      </div>
    )
  }

  if (failure) {
    return (
      <div className="bg-yellow-500/5 border border-yellow-500/30 rounded-xl px-5 py-4">
        <p className="flex items-center gap-2 text-yellow-300 text-sm font-semibold">
          <AlertTriangle size={15} /> Applicants and KYC could not be read
        </p>
        <p className="text-slate-400 text-sm mt-1">{failure}</p>
        <p className="text-slate-500 text-xs mt-2">
          This is not a statement that nobody is waiting — nothing here was
          measured.
        </p>
        <button
          onClick={load}
          className="mt-3 flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    )
  }

  const rows: ReviewRow[] = queues ? reviewRowsOf(queues, status, type) : []
  const decidable = status === 'pending'
  // A queue that refused is named, so an absent applicant is never read as a
  // decided one.
  const unreadable = queues
    ? (Object.keys(queues) as Category[])
        .filter((k) => pendingCountOf(queues, k) === null)
        .map((k) => CATEGORY_LABELS[k])
    : []

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <h2 className="text-white font-semibold flex items-center gap-2">
            <ShieldCheck size={16} className="text-pink-400" /> Applicants &amp; KYC
          </h2>
          <p className="text-slate-500 text-xs mt-0.5 max-w-2xl">
            {decidable
              ? 'Hosts, agencies, sub-agencies, coin sellers, and changes to the ' +
                'details of any of them. Approving here approves the KYC — it is ' +
                'the same decision, written by the same call, and there is no ' +
                'second step afterwards.'
              : `Hosts, agencies, sub-agencies and coin sellers ${VIEW_WORD[status]}. ` +
                'These are the applications themselves, not copies of them — the ' +
                'same records /kyc shows. They carry no buttons here: changing a ' +
                'decision means looking at the documents again, which is what /kyc ' +
                'is for.'}
          </p>
        </div>
        <Link
          href="/kyc"
          className="flex items-center gap-1 text-pink-400 hover:text-pink-300 text-sm shrink-0"
        >
          Review with documents <ChevronRight size={13} />
        </Link>
      </div>

      {notice && (
        <div className="mb-3 flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3">
          <p className="text-green-200 text-sm">{notice}</p>
          <button onClick={() => setNotice('')} className="text-green-300/70 hover:text-green-200 text-xs shrink-0">
            Dismiss
          </button>
        </div>
      )}

      {unreadable.length > 0 && (
        <p className="flex items-start gap-1.5 text-yellow-300/90 text-xs mb-3">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            {unreadable.join(', ')} could not be read. What is listed below is a
            partial queue, not the whole one.
          </span>
        </p>
      )}

      {rows.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-8 text-center">
          <CheckCircle2 size={22} className="text-slate-700 mx-auto mb-2" />
          <p className="text-slate-500 text-sm">
            {decidable
              ? `No ${type === 'all' ? 'applicant' : type} is waiting on a decision.`
              : `No ${type === 'all' ? 'applicant' : type} has been ${
                  status === 'all' ? 'recorded' : status
                } here.`}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map(({ item, category }) => {
            const busy = acting[item.id]
            // Only meaningful on something still waiting. An application approved
            // three weeks ago is not "stale" — it is done, and outlining it amber
            // would make a finished job look like a neglected one.
            const stale = decidable && ageDays(item.submittedAt) >= 3
            const blocked = item.linkage === 'unregistered'
            return (
              <div
                key={`${category}-${item.id}`}
                className={`bg-slate-900 border rounded-xl overflow-hidden ${
                  stale ? 'border-amber-500/40' : 'border-slate-800'
                }`}
              >
                <div className="flex flex-wrap items-center gap-3 p-4">
                  <span className="text-xs font-medium px-2 py-0.5 rounded bg-slate-800 text-slate-400 shrink-0">
                    {decisionLabelOf(item)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{item.name}</p>
                    <p className="text-slate-400 text-xs mt-0.5 truncate">
                      {item.subtitle || CATEGORY_LABELS[category]}
                    </p>
                  </div>
                  {/* On a decided view the verdict is the point of the row, so it
                      is shown rather than implied by which tab you are on: the
                      All tab mixes all four statuses in one list. */}
                  {!decidable && (
                    <span
                      className={`text-xs px-2 py-1 rounded shrink-0 ${
                        STATUS_TONE[item.status] ?? 'bg-slate-700 text-slate-300'
                      }`}
                    >
                      {item.status}
                    </span>
                  )}
                  <span
                    className={`flex items-center gap-1 text-xs px-2 py-1 rounded shrink-0 ${
                      stale ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    <Clock size={11} /> {ageOf(item.submittedAt)}
                  </span>
                  <Link
                    href="/kyc"
                    className="flex items-center gap-1 text-pink-400 hover:text-pink-300 text-xs shrink-0"
                  >
                    Documents <ExternalLink size={11} />
                  </Link>
                </div>

                <div className="border-t border-slate-800 px-4 py-3 space-y-2">
                  {/* "What approving this will do" is only worth saying while it
                      can still be approved. On a decided row it would describe an
                      action that has already happened, in the future tense. */}
                  {decidable && (
                    <p className="text-slate-500 text-xs">{approveEffectOf(item)}</p>
                  )}

                  {item.conflict && (
                    <p className="flex items-start gap-1.5 text-amber-300 text-xs">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {item.conflict}
                    </p>
                  )}

                  {/* The reason a rejection was a rejection, kept in front of
                      whoever looks next. An applicant who is told nothing simply
                      reapplies, and this is the tab somebody checks before
                      answering "why was I turned down". */}
                  {!decidable && item.status === 'rejected' && (
                    <p className="flex items-start gap-1.5 text-red-300/90 text-xs">
                      <XCircle size={12} className="mt-0.5 shrink-0" />
                      {item.rejectionReason || 'rejected — no reason on record'}
                    </p>
                  )}

                  {!decidable ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <Link
                        href="/kyc"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition-colors"
                      >
                        Review again on /kyc <ChevronRight size={12} />
                      </Link>
                      {item.href && (
                        <Link
                          href={item.href}
                          className="text-pink-400 hover:text-pink-300 text-xs"
                        >
                          Open the record
                        </Link>
                      )}
                    </div>
                  ) : blocked ? (
                    <Link
                      href="/kyc"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-yellow-600/20 border border-yellow-500/40 hover:bg-yellow-600/30 text-yellow-200 rounded-lg text-xs font-medium transition-colors"
                    >
                      Open the review screen <ChevronRight size={12} />
                    </Link>
                  ) : (
                    <>
                      <input
                        value={reason[item.id] ?? ''}
                        onChange={(e) => setReason((r) => ({ ...r, [item.id]: e.target.value }))}
                        placeholder="Why? Kept on the record and in the audit log."
                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => decide(item, 'approve')}
                          disabled={!!busy}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:bg-slate-800 disabled:text-slate-600 text-white rounded-lg text-xs font-medium transition-colors"
                        >
                          {busy === 'approve'
                            ? <Loader2 size={12} className="animate-spin" />
                            : <CheckCircle2 size={12} />}
                          Approve
                        </button>
                        <button
                          onClick={() => decide(item, 'reject')}
                          disabled={!!busy}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/15 border border-red-500/30 hover:bg-red-500/25 disabled:opacity-50 text-red-300 rounded-lg text-xs font-medium transition-colors"
                        >
                          {busy === 'reject'
                            ? <Loader2 size={12} className="animate-spin" />
                            : <XCircle size={12} />}
                          Reject
                        </button>
                      </div>
                    </>
                  )}

                  {rowError[item.id] && (
                    <p className="flex items-start gap-1.5 text-red-300 text-xs">
                      <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {rowError[item.id]}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
