'use client'

/**
 * Inbox — what is waiting on you, across every board.
 *
 * The point is that nobody should have to visit six pages to discover their
 * own work.
 *
 * ── WHY THIS SCREEN USED TO BE WRONG ─────────────────────────────────────────
 *
 * It read one source: the money cards. So a page titled "Waiting on you", which
 * is the page a person opens first, could show three confident zeroes and an
 * "Nothing is waiting on you" while an agency's documents had sat unreviewed
 * for a week and a staff member's permission request had sat for two. Neither
 * of those is a money card, so neither existed here.
 *
 * Three kinds of work can wait on somebody in this CRM, and they are genuinely
 * different acts decided on different screens:
 *
 *   1. MONEY   — a card to verify or sign. Decided on /board.
 *   2. PEOPLE  — is this applicant who they say they are, and may they trade?
 *                Agencies, sub-agencies, coin sellers, hosts, and changes to
 *                the details of any of them. Decided on /kyc.
 *   3. PERMISSION — a staff member wants to do something their role does not
 *                cover. Decided on /approvals.
 *
 * This screen counts all three and links to each; it decides none of them.
 * Splitting "count it" from "decide it" is deliberate — a decision needs the
 * documents in front of you, and an inbox that let you approve a person from a
 * summary row would be the worst possible place to approve a person from.
 *
 * ── AND WHY THE COUNTS ARE NOT COMPUTED HERE ─────────────────────────────────
 *
 * The KYC figures come from `lib/reviewQueues`, the same module /kyc renders
 * from. Not for tidiness: the status vocabulary behind those queues is subtle
 * enough that two implementations would disagree, and an inbox that says 0
 * where /kyc says 3 destroys trust in both. One definition, two readers.
 *
 * Nothing here turns a failed read into a zero. Every count that could not be
 * taken renders as "—" with the reason beside it.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, CheckCircle2, Clock, Inbox as InboxIcon,
  Loader2, PenLine, RefreshCw, Send, ShieldCheck, ShieldQuestion,
} from 'lucide-react'
import api, { ApiError, type Card, type Inbox as InboxCounts } from '@/lib/api'
import { useAuth } from '@/components/AuthProvider'
import { ErrorState } from '@/components/ui/States'
import type { CrmRole } from '@/lib/auth'
import { attempt, type ReadFailure } from '@/lib/readState'
import { countPendingApprovals } from '@/lib/approvals'
import { loadReviewQueues, tallyReviewQueues, type ReviewTally } from '@/lib/reviewQueues'

/**
 * Who may decide each kind of work. A queue you cannot act on is not counted
 * here — not to hide it, but because "waiting on you" has to mean you. A
 * finance member reading "4 waiting" about KYC decisions they may not make has
 * been told about somebody else's morning.
 */
const KYC_ROLES: CrmRole[] = ['superadmin', 'app_admin', 'ops_admin']
const APPROVAL_ROLES: CrmRole[] = ['superadmin']

function ageOf(iso: string) {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 60) return `${Math.max(mins, 1)}m`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`
}

function money(amount: number, currency: string) {
  if (currency === 'commission') return `₹${(amount / 100).toLocaleString('en-IN')}`
  const s = currency === 'diamonds' ? '💎' : currency === 'beans' ? '🫘' : '🪙'
  return `${s} ${amount.toLocaleString('en-IN')}`
}

export default function InboxPage() {
  // Every call on this screen is an API call, and the API session is a separate
  // POST to Cloud Run that lands seconds after the page mounts. Without the
  // `apiReady` gate the first `load()` ran against no token, `request()` threw
  // `ApiError('Not signed in', 401)`, and that 401 stuck on screen as a
  // permanent red banner — nothing re-ran when the session finally arrived.
  const { apiReady, apiError, canAccess } = useAuth()
  const [counts, setCounts] = useState<InboxCounts | null>(null)
  const [queue, setQueue] = useState<Card[]>([])
  const [role, setRole] = useState('')
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // People and permission. Both are `null` until read, and a failure is kept as
  // a failure — see the header. `mayReview` / `mayApprove` are computed from the
  // CRM role rather than the API role, because /kyc and /approvals gate on the
  // CRM role and this screen must not advertise a door that will not open.
  const [tally, setTally] = useState<ReviewTally | null>(null)
  const [tallyFailure, setTallyFailure] = useState<string>('')
  const [permissionCount, setPermissionCount] = useState<number | null>(null)
  const [permissionFailure, setPermissionFailure] = useState<ReadFailure | null>(null)

  const mayReview = canAccess(KYC_ROLES)
  const mayApprove = canAccess(APPROVAL_ROLES)

  const load = useCallback(async () => {
    if (!apiReady) return
    setLoading(true)
    setError('')

    // The money half and the people half fail independently and are reported
    // independently. A refused partner list must not blank the signature queue,
    // and an API session problem must not be reported as "no KYC work".
    const reviewRead = mayReview
      ? attempt(loadReviewQueues(), 'inbox/loadReviewQueues')
      : Promise.resolve(null)
    const permissionRead = mayApprove
      ? attempt(countPendingApprovals(), 'inbox/countPendingApprovals')
      : Promise.resolve(null)

    try {
      const me = await api.auth.me()
      setRole(me.role)
      setName(me.name || me.email)

      const [c, sign] = await Promise.all([
        api.cards.inbox(),
        me.role === 'owner' ? api.cards.awaitingSignature() : Promise.resolve([]),
      ])
      setCounts(c)
      setQueue(sign)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your inbox.')
    }

    const review = await reviewRead
    if (!review) {
      setTally(null)
      setTallyFailure('')
    } else if (review.ok) {
      // `error` is set only when NOTHING could be read. A partial failure is
      // carried inside the tally, per queue, and rendered there.
      setTally(tallyReviewQueues(review.value.queues))
      setTallyFailure(review.value.error)
    } else {
      setTally(null)
      setTallyFailure(review.reason)
    }

    const permission = await permissionRead
    if (!permission) {
      setPermissionCount(null)
      setPermissionFailure(null)
    } else if (permission.ok) {
      setPermissionCount(permission.value)
      setPermissionFailure(null)
    } else {
      setPermissionCount(null)
      setPermissionFailure(permission)
    }

    setLoading(false)
  }, [apiReady, mayReview, mayApprove])

  // `apiReady` is in `load`'s dependency list, so this re-runs the moment the
  // session lands. That re-run IS the retry — there is nothing for a person to
  // press.
  useEffect(() => { load() }, [load])

  // A session that failed to establish is a real, terminal error and says so.
  // A session that has simply not arrived yet is a loading state, not an error.
  if (!apiReady && apiError) {
    return <ErrorState message={apiError} />
  }

  if (loading || !apiReady) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-3">
        <Loader2 size={26} className="animate-spin text-pink-500" />
        <p className="text-slate-500 text-sm">
          {apiReady ? 'Reading your queues…' : 'Signing in to the business API…'}
        </p>
      </div>
    )
  }

  // "Nothing is waiting on you" is a claim about all three kinds of work, so it
  // may only be made when all three were READ and all three are zero. A queue
  // that refused is not a zero, and a queue this person cannot act on is not
  // theirs to be told about — so it is excluded from the claim rather than
  // counted as empty.
  const moneyClear = counts !== null && counts.total === 0
  const peopleClear = !mayReview || (tally !== null && tally.total === 0 && tally.unreadable.length === 0)
  const permissionClear = !mayApprove || permissionCount === 0
  const nothingWaiting = moneyClear && peopleClear && permissionClear

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <InboxIcon size={26} className="text-pink-500" />
            Waiting on you
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            {name} · {role.replace('_', ' ')}
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div className="mb-5 flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
          <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-red-300 text-sm">{error}</p>
        </div>
      )}

      {/* ── Money ───────────────────────────────────────────────────────── */}
      {/* `counts` is null when the read failed, and `?? 0` turned that into
          three confident zeroes sitting under a red banner — "nothing is
          waiting on you" is the one thing an inbox must never say by mistake.
          A count we do not have is "—". */}
      <SectionHead
        icon={<PenLine size={15} className="text-green-400" />}
        title="Money"
        blurb="Cards to check and sign. Nothing moves until an owner signs."
        href="/board"
        linkLabel="Open board"
      />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <Stat
          icon={<CheckCircle2 size={18} className="text-blue-400" />}
          label="To verify"
          value={counts?.to_verify ?? null}
          hint="Cards your team needs to check"
        />
        <Stat
          icon={<PenLine size={18} className="text-green-400" />}
          label="To sign"
          value={counts?.to_sign ?? null}
          hint="Verified, waiting on your signature"
        />
        <Stat
          icon={<Send size={18} className="text-slate-400" />}
          label="Yours pending"
          value={counts?.mine_pending ?? null}
          hint="Raised by you, still moving"
        />
      </div>

      {/* ── People ──────────────────────────────────────────────────────── */}
      {mayReview && (
        <div className="mb-8">
          <SectionHead
            icon={<ShieldCheck size={15} className="text-pink-400" />}
            title="People"
            blurb={
              'Applicants and partners waiting to be verified — and approved ' +
              'partners who have since asked to change their bank account or ' +
              'their identity. Deciding one means looking at their documents, ' +
              'so it happens on the review screen, not here.'
            }
            href="/kyc"
            linkLabel="Open KYC review"
          />

          {tallyFailure ? (
            <div className="bg-yellow-500/5 border border-yellow-500/30 rounded-xl px-5 py-4">
              <p className="text-yellow-300 text-sm font-medium">
                The review queues could not be read
              </p>
              <p className="text-slate-400 text-sm mt-1">{tallyFailure}</p>
              <p className="text-slate-500 text-xs mt-2">
                This is not a statement that nobody is waiting. Nothing here was
                measured.
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {(tally?.queues ?? []).map((q) => (
                  <Link
                    key={q.key}
                    href="/kyc"
                    className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl p-4 transition-colors"
                  >
                    <p className="text-slate-400 text-xs">{q.label}</p>
                    {q.count === null ? (
                      <>
                        <p className="text-2xl font-bold mt-1.5 text-slate-500">—</p>
                        <p className="text-yellow-400/80 text-xs leading-snug">
                          could not be read
                        </p>
                      </>
                    ) : (
                      <>
                        <p className={`text-2xl font-bold mt-1.5 ${q.count > 0 ? 'text-amber-300' : 'text-slate-600'}`}>
                          {q.count}
                        </p>
                        <p className="text-slate-600 text-xs">awaiting review</p>
                      </>
                    )}
                  </Link>
                ))}
              </div>

              {/* A total with a hole in it is a floor, and says so. Printing
                  "3 waiting" while the host queue was refused would be a
                  smaller lie than a zero, but a lie in the same direction. */}
              {tally && tally.unreadable.length > 0 && (
                <p className="flex items-start gap-1.5 text-yellow-300/90 text-xs mt-3">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span>
                    {tally.unreadable.map((u) => u.label).join(', ')} could not be
                    read, so what is shown above is a floor rather than a count.{' '}
                    {tally.unreadable[0].reason}
                  </span>
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Permission ──────────────────────────────────────────────────── */}
      {mayApprove && (
        <div className="mb-8">
          <SectionHead
            icon={<ShieldQuestion size={15} className="text-blue-400" />}
            title="Permission"
            blurb={
              'A staff member wants to do something their own role does not ' +
              'cover. The approval queue carries the People rows above as well, ' +
              'so it can be worked as one list — approving an applicant there ' +
              'approves their KYC, through the same call.'
            }
            href="/approvals"
            linkLabel="Open approvals"
          />
          {permissionFailure ? (
            <div className="bg-yellow-500/5 border border-yellow-500/30 rounded-xl px-5 py-4">
              <p className="text-yellow-300 text-sm font-medium">
                The approval queue could not be read
              </p>
              <p className="text-slate-400 text-sm mt-1">{permissionFailure.reason}</p>
            </div>
          ) : (
            <Link href="/approvals" className="block">
              <div className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl p-5 flex items-center justify-between gap-4 transition-colors">
                <div>
                  <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">
                    Requests pending
                  </p>
                  <p className={`text-3xl font-bold mt-1 ${permissionCount && permissionCount > 0 ? 'text-white' : 'text-slate-700'}`}>
                    {permissionCount ?? '—'}
                  </p>
                </div>
                <ArrowRight size={16} className="text-slate-600 shrink-0" />
              </div>
            </Link>
          )}
        </div>
      )}

      {nothingWaiting && (
        <div className="text-center py-16 bg-slate-900/50 border border-slate-800 rounded-xl mb-8">
          <CheckCircle2 size={30} className="text-slate-700 mx-auto mb-3" />
          <p className="text-slate-400 text-sm">
            Nothing is waiting on you — every queue you can act on was read, and
            every one of them is clear.
          </p>
          <Link
            href="/board"
            className="inline-flex items-center gap-1.5 text-pink-400 hover:text-pink-300 text-sm mt-3"
          >
            Open the money board <ArrowRight size={13} />
          </Link>
        </div>
      )}

      {queue.length > 0 && (
        <div>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-white font-semibold">Awaiting your signature</h2>
            <Link href="/board" className="text-pink-400 hover:text-pink-300 text-sm">
              Open board
            </Link>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            {queue.map((card, i) => (
              <Link
                key={card.id}
                href="/board"
                className={`flex items-center gap-4 px-5 py-4 hover:bg-slate-800/50 transition-colors ${
                  i > 0 ? 'border-t border-slate-800/70' : ''
                }`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-medium truncate">{card.title}</p>
                  <p className="text-slate-500 text-xs mt-0.5">
                    {card.team} · raised by {card.requested_by.name || card.requested_by.role}
                    {card.verified_by && ` · verified by ${card.verified_by.name}`}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-pink-300 text-sm font-semibold">
                    {money(card.amount, card.currency)}
                  </p>
                  <p className="flex items-center justify-end gap-1 text-slate-600 text-xs mt-0.5">
                    <Clock size={10} /> {ageOf(card.created_at)}
                  </p>
                </div>
              </Link>
            ))}
          </div>
          <p className="text-slate-600 text-xs mt-3">
            Oldest first. Cards you raised yourself are not listed — another owner
            has to sign those.
          </p>
        </div>
      )}
    </div>
  )
}

/**
 * The heading over one kind of work, and the way to the screen that decides it.
 *
 * Every section carries its own link deliberately. This page counts; it never
 * decides. An inbox that let somebody approve an agency from a summary row
 * would be approving them without their documents on screen, which is the one
 * place that decision must never be made from.
 */
function SectionHead({
  icon, title, blurb, href, linkLabel,
}: {
  icon: React.ReactNode
  title: string
  blurb: string
  href: string
  linkLabel: string
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
      <div className="min-w-0">
        <h2 className="text-white font-semibold flex items-center gap-2">
          {icon} {title}
        </h2>
        <p className="text-slate-500 text-xs mt-0.5 max-w-2xl">{blurb}</p>
      </div>
      <Link
        href={href}
        className="flex items-center gap-1 text-pink-400 hover:text-pink-300 text-sm shrink-0"
      >
        {linkLabel} <ArrowRight size={13} />
      </Link>
    </div>
  )
}

/** `value: null` means the count could not be read — shown as "—", never 0. */
function Stat({
  icon, label, value, hint,
}: {
  icon: React.ReactNode
  label: string
  value: number | null
  hint: string
}) {
  const unknown = value === null
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      </div>
      <p className={`text-3xl font-bold ${unknown ? 'text-slate-600' : value > 0 ? 'text-white' : 'text-slate-700'}`}>
        {unknown ? '—' : value}
      </p>
      <p className="text-slate-600 text-xs mt-1">
        {unknown ? 'Could not be read — this is not zero.' : hint}
      </p>
    </div>
  )
}
