'use client'

/**
 * KYC review.
 *
 * Four queues — main agencies, sub-agencies, coin sellers and hosts — because
 * they are reviewed by different people against different documents, and a
 * single mixed list buries the one that matters.
 *
 * ── WHY THIS SCREEN ONLY EVER SHOWED AGENCIES ────────────────────────────────
 *
 * Every row used to be built by iterating the API's partner list and looking a
 * Firestore profile up against it. That is correct for the two agency queues and
 * it is correct for coin sellers **as long as the business record exists** — and
 * the business record is created by a Cloud Function trigger
 * (`registerSellerPartner`, functions/src/index.ts:3813) that runs outside this
 * screen and can simply not have run. When it has not, the applicant is not
 * missing a field; they are not on the screen at all, and nothing said so.
 * `<FailedRegistrations />` only catches the subset the trigger *flagged*
 * (`partnerRecordFailed: true`); a trigger that was never deployed flags
 * nothing, and those applicants were invisible in both places.
 *
 * So each queue is now built from **both** sides and the sides are reconciled:
 *
 *   * a partner record with a Firestore profile — the normal row, decided
 *     through `partnerOps.approve` / `partnerOps.reject`;
 *   * a Firestore document with **no** partner record — shown as its own row,
 *     saying exactly that, with the one action that is available for it
 *     (`partnerOps.create`, which creates the record holding nothing and
 *     pending, so it can then be approved like any other).
 *
 * And an empty queue now says WHICH of three things it is:
 *
 *   1. nothing has been submitted,
 *   2. a source could not be read — never rendered as "nothing to review",
 *   3. records were read but none could be turned into a reviewable row.
 *
 * Those need different fixes and conflating them is how this survived.
 *
 * All of that reading now lives in `lib/reviewQueues`, unchanged, because
 * /inbox has to count the same five queues and a second implementation of
 * "pending" would drift from this one within a week. This file renders and
 * decides; it no longer defines what is waiting.
 *
 * ── HOSTS ────────────────────────────────────────────────────────────────────
 *
 * The host flow exists, and `hostApplications` has exactly one writer: the
 * Invite Host modal on /agency-dashboard (app/agency-dashboard/page.tsx:300).
 * It writes `kycStatus: 'submitted'`, `status: 'pending'`, three `kycDocUrls`,
 * and **no account uid** — the uid only arrives later, as `activatedByUid`,
 * when the applicant redeems the referral code in the Android app
 * (zipper-app/…/AuthRepository.kt:383). This screen read `raw.uid ?? raw.userId`,
 * neither of which anything writes, so every host row was permanently "no
 * account uid attached" and its Approve button permanently disabled.
 *
 * The status vocabulary had split too. A host application was decided by THREE
 * screens — the `add_host` approval queue, /hosts, and this one — and only this
 * one wrote both `status` and `kycStatus`. So the two drifted, and an
 * application approved through /approvals sat here as pending for ever.
 *
 * There is now exactly one writer of that decision, and it is on the server:
 * `POST /users/host-applications/{id}/decide`, which writes both status fields
 * together with the decider, the time and the reason, and grants or revokes the
 * host account in the same call. The other two writers are gone — /hosts no
 * longer edits `kycStatus` at all, and the `add_host` approval type is refused
 * with a message naming this screen.
 *
 * `hostDecisionOf` — now in `lib/reviewQueues` — stays, and is purely a safety
 * net: records decided before that change can still carry two fields that
 * disagree, and it reports the disagreement rather than guessing which is true.
 *
 * The applicant's own profile — name, contact, document URLs — lives in
 * Firestore because the Android app reads it there. This screen reads it and
 * writes nothing to it: every decision on this page goes through the API.
 *
 * ── THE FIFTH QUEUE: CHANGES TO AN ALREADY-APPROVED PARTNER ──────────────────
 *
 * The four queues above all key off a status, and that is exactly what an
 * approved partner used to be able to walk around. "Update your KYC and payment
 * details" on the agency dashboard wrote the new `accountNumber` straight onto
 * the live record and left `status: 'approved'` alone — so the row went on
 * reading approved, appeared in no queue, and the new bank account was live
 * immediately. A payout is a human reading that number off the record and
 * paying it. Approve once with clean documents, then swap the destination.
 *
 * A change to a payout or identity field is therefore now PROPOSED, into a
 * `pendingChanges` block, and the live field does not move. The re-approval
 * queue is what makes the proposal visible: it is built from the presence of
 * that block and **from nothing else**, so it is the one queue on this screen
 * that ignores status entirely. An approved, active, perfectly ordinary partner
 * appears in it the moment they propose something, and leaves it the moment
 * somebody decides.
 *
 * Every changed field is shown OLD → NEW side by side, because the question a
 * reviewer is actually answering is not "are these documents valid" but "did
 * this partner mean to change this, and is the new value theirs". Approving
 * applies the proposed values onto the live fields and clears the block;
 * rejecting clears the block, leaves every live field untouched, and stores the
 * reason where the partner's own dashboard shows it.
 *
 * Both go through the API, like everything else here — and here it is not a
 * convention but the only possibility. No clause in `firestore.rules` lets any
 * browser write these fields at all.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, Building2, CheckCircle2, ChevronRight, Clock,
  ExternalLink, FileText, ImageOff, Landmark, Link2Off, Loader2, Repeat,
  RefreshCw, Search, ShieldCheck, ShieldOff, ShoppingBag, Users, X, XCircle,
} from 'lucide-react'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'
import { FailedRegistrations } from '@/components/FailedRegistrations'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, hasPermission } from '@/lib/auth'
import { ApiError } from '@/lib/api'
import { STATUS_TONE, type PartnerStatus } from '@/lib/apiPartners'
import { PAYOUT_FIELDS, displayValue } from '@/lib/pendingChanges'
// One implementation of "approve this", shared with /approvals — which offers
// the same decisions on the same rows, because that queue is where this
// business decides everything else.
import { decideReviewItem, type DecisionAction } from '@/lib/reviewDecisions'
// The queues themselves are built in `lib/reviewQueues` rather than here,
// because this is no longer the only screen that asks what is waiting on a
// reviewer — /inbox counts the same five queues, and two screens deciding
// independently what "pending" means is exactly how one of them ends up saying
// 0 while the other says 3. This screen renders the rows; it does not define
// them.
import {
  CATEGORY_LABELS, CATEGORY_ORDER, EMPTY_QUEUES,
  loadReviewQueues, pendingCountOf,
  type Category, type DocRef, type Item, type Queues,
} from '@/lib/reviewQueues'

const PAGE_ROLES = ['superadmin', 'app_admin', 'ops_admin'] as const

const MIN_REASON = 3

// ── How a row is described on screen ──────────────────────────────────────────

function ageOf(iso: string): string {
  if (!iso) return 'age unknown'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (Number.isNaN(mins)) return 'age unknown'
  if (mins < 60) return `${Math.max(mins, 0)}m old`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h old`
  const days = Math.floor(hrs / 24)
  return `${days}d old`
}

function ageDays(iso: string): number {
  if (!iso) return 0
  const ms = Date.now() - new Date(iso).getTime()
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 86400000)
}

function whenOf(iso: string): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    })
  } catch {
    return '—'
  }
}

/** The tabs, in the order `lib/reviewQueues` lists them. Icons are this
 *  screen's business; the keys and the labels are not. */
const CATEGORY_ICONS: Record<Category, React.ReactNode> = {
  main_agency: <Building2 size={14} />,
  sub_agency: <Building2 size={14} />,
  coin_seller: <ShoppingBag size={14} />,
  host: <Users size={14} />,
  reapproval: <Repeat size={14} />,
}

const CATEGORIES = CATEGORY_ORDER.map((key) => ({
  key,
  label: CATEGORY_LABELS[key],
  icon: CATEGORY_ICONS[key],
}))

// ══════════════════════════════════════════════════════════════════════════════

export default function Kyc() {
  const { crmUser } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, [...PAGE_ROLES])
  /*
   * Opening the queue and DECIDING on it are different rights, and this screen
   * conflated them. `PAGE_ROLES` admits `app_admin`, who holds no
   * `CAN_APPROVE_KYC` — so they could read a host's Aadhaar, fill in a
   * mandatory reason, press Approve and receive a 403, with nothing to tell a
   * permission boundary from a broken screen.
   *
   * Reading is still theirs: reviewing a queue and acting on it are genuinely
   * different jobs. Only the buttons move.
   */
  const mayDecide = hasPermission(crmUser, 'can_approve_kyc')

  const [queues, setQueues] = useState<Queues>(EMPTY_QUEUES)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [category, setCategory] = useState<Category>('main_agency')
  const [status, setStatus] = useState<'all' | PartnerStatus>('pending')
  const [term, setTerm] = useState('')
  const [pending, setPending] = useState<{ item: Item; action: DecisionAction } | null>(null)
  const [zoom, setZoom] = useState('')

  const load = useCallback(async () => {
    setError('')
    setNotice('')
    // Six reads, built in `lib/reviewQueues` so that /inbox counts exactly what
    // this screen shows. A source that refused is carried on the queue it
    // affects rather than thrown away, and `error` is set only when nothing at
    // all could be read.
    const { queues: built, error: fatal } = await loadReviewQueues()
    setQueues(built)
    setError(fatal)
    setLoading(false)
  }, [])

  useEffect(() => { if (allowed) load() }, [allowed, load])

  // Which partners already have a business record. `<FailedRegistrations />`
  // uses these to stop showing a stale failure flag as an open problem — and the
  // ids it must NOT count are the stranded rows, which are the same applicants
  // it is there to surface.
  const knownAgencyIds = useMemo(
    () => new Set(
      [...queues.main_agency.items, ...queues.sub_agency.items]
        .filter((i) => i.linkage === 'partner')
        .map((i) => i.id),
    ),
    [queues],
  )
  const knownSellerIds = useMemo(
    () => new Set(
      queues.coin_seller.items.filter((i) => i.linkage === 'partner').map((i) => i.id),
    ),
    [queues],
  )

  const queue = queues[category]
  const list = queue.items

  const failedSources = useMemo(
    () => queue.sources.filter((s): s is { label: string; state: { ok: false; reason: string } } =>
      !s.state.ok),
    [queue],
  )
  const cappedSources = useMemo(
    () => queue.sources.filter((s) => s.state.ok && s.state.capped),
    [queue],
  )
  const rawRecordCount = useMemo(
    () => queue.sources.reduce((n, s) => (s.state.ok ? n + s.state.count : n), 0),
    [queue],
  )

  const shown = useMemo(() => {
    const q = term.trim().toLowerCase()
    return list
      // The status filter does not apply to the re-approval queue, and leaving
      // it applied would empty the queue by default: its rows are almost all
      // `approved` — an approved partner changing their bank account is the
      // exact case it exists for — and the filter defaults to `pending`. The
      // status is still printed on every row, because it tells the reviewer
      // whether this partner is currently being paid.
      .filter((i) =>
        category === 'reapproval' || status === 'all' ? true : i.status === status,
      )
      .filter((i) =>
        !q ||
        i.name.toLowerCase().includes(q) ||
        i.subtitle.toLowerCase().includes(q) ||
        i.id.toLowerCase().includes(q),
      )
      // Oldest first inside the pending queue — the point of showing an age is
      // that the thing which has waited longest is at the top.
      .sort((a, b) => {
        if (a.status !== b.status && category !== 'reapproval') {
          return a.status === 'pending' ? -1 : 1
        }
        return (new Date(a.submittedAt).getTime() || 0) - (new Date(b.submittedAt).getTime() || 0)
      })
  }, [list, status, term, category])

  /**
   * The count on a tile.
   *
   * `null` when the queue could not be read — rendered as a refusal, never as
   * "0 awaiting review". A zero on this screen is a claim that nobody is
   * waiting, and this page decides who gets to trade.
   */
  const pendingCount = useCallback(
    (key: Category): number | null => pendingCountOf(queues, key),
    [queues],
  )

  /**
   * How many records a queue holds ALTOGETHER, whatever their status.
   *
   * ── WHY A TILE NEEDS TWO NUMBERS ─────────────────────────────────────────
   *
   * The tiles count what is awaiting review, and that is the right headline —
   * it is the number a reviewer opens this page for, and `pendingCountOf` is
   * deliberately the same definition /inbox and /approvals use. But a tile is
   * also a BUTTON that selects the queue below it, so it reads as a label for
   * that list; and the list obeys the status filter, which is not "pending".
   *
   * The result was a queue tile reading 0 directly above "2 records in this
   * queue" and an approved host KYC. Both numbers were correct and the pair was
   * unreadable, which in a CRM whose whole problem is figures that disagree is
   * its own kind of failure — a reader who cannot reconcile two numbers on one
   * screen has no reason to trust either.
   *
   * So the tile now states both, and neither has to be inferred. The 0 keeps its
   * meaning: nobody is waiting. The second line says the queue is not empty.
   */
  const heldCount = useCallback(
    (key: Category): number => queues[key].items.length,
    [queues],
  )

  /**
   * Records on screen that have already been decided.
   *
   * Used only to decide whether the tiles need explaining. With the filter on
   * `pending` the list and the tiles are the same measurement and saying so
   * would be noise; the moment a decided row is listed they are not, and the
   * difference has to be stated rather than left to be worked out.
   */
  const decidedShown = shown.filter(
    (i) => category !== 'reapproval' && i.status !== 'pending',
  ).length

  /**
   * Carry out one decision. Returns anything the server said about it that the
   * canned confirmation below would not cover — today, the host cases where the
   * decision was made and there was no account to act on. An empty string means
   * the decision did exactly what the dialog said it would.
   */
  // The decision itself lives in `lib/reviewDecisions`, because /approvals
  // offers the same decisions on the same rows and two implementations of
  // "approve this host" is precisely the drift that made an application read
  // approved on one screen and pending on another.
  const decide = decideReviewItem


  if (!allowed) return <Denied what="KYC review" />

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <ShieldCheck size={26} className="text-pink-500" />
            KYC review
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Five queues, oldest first. Approving and rejecting are recorded
            against a named person, and a rejection has to say why. The last
            queue is not new applicants — it is partners who have already been
            approved and have since proposed a change to where they are paid or
            to who they are.
          </p>
        </div>
        <button
          onClick={() => { setLoading(true); load() }}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      {/* Applicants whose business record could not be created when they
          registered, as reported by the registration trigger itself. The queues
          below now also carry the ones it never got to flag — a trigger that
          never ran flags nothing — so this panel and those rows overlap
          deliberately: this one knows WHY it failed, and that is worth keeping.
          Renders nothing when there are none. */}
      <FailedRegistrations
        kind="agency"
        knownPartnerIds={knownAgencyIds}
        onRegistered={() => { setLoading(true); load() }}
      />
      <FailedRegistrations
        kind="seller"
        knownPartnerIds={knownSellerIds}
        onRegistered={() => { setLoading(true); load() }}
      />

      {cappedSources.length > 0 && (
        <Warning>
          Only the most recent records were read for:{' '}
          {cappedSources.map((s) => s.label).join(', ')}. Older entries exist and
          are <span className="font-medium">not on screen</span> — searching will
          not find them either. Review the queue regularly so nothing ages out of
          view.
        </Warning>
      )}

      {/* ── Category tiles ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        {CATEGORIES.map((c) => {
          const n = pendingCount(c.key)
          const held = heldCount(c.key)
          return (
            <button
              key={c.key}
              onClick={() => setCategory(c.key)}
              className={`text-left bg-slate-900 border rounded-xl p-4 transition-colors ${
                category === c.key
                  ? 'border-pink-500/60 bg-pink-500/5'
                  : 'border-slate-800 hover:border-slate-700'
              }`}
            >
              <span className="flex items-center gap-1.5 text-slate-400 text-xs">
                {c.icon} {c.label}
              </span>
              {n === null ? (
                <>
                  <p className="text-2xl font-bold mt-1.5 text-slate-500">—</p>
                  <p className="text-yellow-400/80 text-xs leading-snug">
                    could not be read — not zero
                  </p>
                </>
              ) : (
                <>
                  <p className={`text-2xl font-bold mt-1.5 ${n > 0 ? 'text-amber-300' : 'text-slate-600'}`}>
                    {n}
                  </p>
                  <p className="text-slate-600 text-xs">awaiting review</p>
                  {/* See `heldCount`. Without this line a tile reading 0 sits
                      above a list of two records and neither number explains
                      the other. */}
                  {held > n && (
                    <p className="text-slate-500 text-xs mt-0.5 leading-snug">
                      {held} in this queue in total, {held - n} already decided
                    </p>
                  )}
                </>
              )}
            </button>
          )
        })}
      </div>

      {/* ── Search and status ───────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search by name, phone, email or id…"
            className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-9 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
          />
          {term && (
            <button
              onClick={() => setTerm('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex gap-1.5 overflow-x-auto">
          {(['pending', 'approved', 'rejected', 'suspended', 'all'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setStatus(f)}
              className={`px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                status === f
                  ? 'bg-pink-500 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* What is on screen, and what the tiles above counted — which are two
          different things the moment the status filter is not "pending".
          This line used to read "2 records in this queue" directly under a tile
          reading 0, and left the reader to work out that one was the whole queue
          and the other only the part still waiting. */}
      <div className="mb-4 text-xs">
        {failedSources.length > 0 ? (
          <p className="text-slate-600">This queue is incomplete — see below.</p>
        ) : (
          <>
            <p className="text-slate-600">
              Showing {shown.length} {shown.length === 1 ? 'record' : 'records'}
              {category === 'reapproval'
                ? ' — every open proposal, whatever the partner’s status'
                : status === 'all'
                  ? ' at every status'
                  : ` with status “${status}”`}
              {term ? ', matching your search' : ''}.
            </p>
            {decidedShown > 0 && (
              <p className="text-slate-500 mt-0.5">
                {decidedShown === shown.length
                  ? decidedShown === 1
                    ? 'It has already been decided'
                    : 'All of them have already been decided'
                  : `${decidedShown} of these ${shown.length} ` +
                    `${decidedShown === 1 ? 'has' : 'have'} already been decided`}
                , so {decidedShown === 1 ? 'it is' : 'they are'} not counted by the
                tiles above — those count only what is still awaiting review.
              </p>
            )}
          </>
        )}
      </div>

      {/* ── The queue ───────────────────────────────────────────────────── */}
      {loading ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <Loading label="Loading the review queues…" />
        </div>
      ) : error ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <ErrorState message={error} onRetry={() => { setLoading(true); load() }} />
        </div>
      ) : (
        <>
          {/* A refused read is never allowed to reach the empty state below. */}
          {failedSources.length > 0 && (
            <div className="bg-yellow-500/5 border border-yellow-500/30 rounded-xl p-5 mb-4">
              <p className="flex items-center gap-2 text-yellow-300 text-sm font-semibold">
                <ShieldOff size={15} /> This queue could not be read in full
              </p>
              <ul className="mt-2 space-y-1.5">
                {failedSources.map((s) => (
                  <li key={s.label} className="text-slate-400 text-sm">
                    <span className="text-slate-300">{s.label}</span> — {s.state.reason}
                  </li>
                ))}
              </ul>
              <p className="text-slate-500 text-xs mt-3">
                Anything shown below is a partial list. Do not read it as the
                whole queue, and do not read a missing applicant as an absent
                one — nothing here was measured.
              </p>
              <button
                onClick={() => { setLoading(true); load() }}
                className="mt-3 flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2 text-sm transition-colors"
              >
                <RefreshCw size={14} /> Try again
              </button>
            </div>
          )}

          {shown.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl">
              <EmptyQueue
                category={category}
                filtered={!!term || status !== 'all'}
                failed={failedSources.length > 0}
                held={list.length}
                rawRecords={rawRecordCount}
              />
            </div>
          ) : (
            <div className="space-y-4">
              {shown.map((item) => (
                <ReviewCard
                  key={`${category}-${item.id}`}
                  item={item}
                  onZoom={setZoom}
                  mayDecide={mayDecide}
                  onDecide={(action) => setPending({ item, action })}
                />
              ))}
            </div>
          )}
        </>
      )}

      {zoom && <Lightbox url={zoom} onClose={() => setZoom('')} />}

      {pending && (
        <ReasonDialog
          action={pending.action}
          item={pending.item}
          onClose={() => setPending(null)}
          onConfirm={async (reason) => {
            const extra = await decide(pending.item, pending.action, reason)
            const name = pending.item.name
            setPending(null)
            const reapproval =
              pending.item.linkage === 'reapproval' ||
              pending.item.linkage === 'reapproval_host'
            const said =
              pending.action === 'register'
                ? `A business record was created for ${name}, holding nothing and pending. ` +
                  'It is now in the queue below and still has to be approved.'
                : reapproval
                  ? pending.action === 'approve'
                    ? `The change to ${name}'s details is now live on their record. ` +
                      'Your name, the time and your reason are on it and in the audit log.'
                    : `The change to ${name}'s details was refused. Nothing on their ` +
                      'record moved — they are still being paid exactly as before — ' +
                      'and your reason is shown on their own dashboard.'
                  : pending.action === 'approve'
                    ? `${name} approved. The decision is in the audit log.`
                    : `${name} rejected. The reason is stored on the record and shown on this queue.`
            // The server's own sentence wins where it has one — it knows what
            // the decision actually touched and the line above only knows what
            // was asked for.
            setNotice(extra ? `${said} ${extra}` : said)
            setLoading(true)
            load()
          }}
        />
      )}
    </div>
  )
}

// ── The three reasons a queue can be empty ────────────────────────────────────

function EmptyQueue({
  category, filtered, failed, held, rawRecords,
}: {
  category: Category
  filtered: boolean
  failed: boolean
  /** Rows this queue holds before the search and status filters. */
  held: number
  /** Records the underlying sources actually returned. */
  rawRecords: number
}) {
  if (filtered) {
    return (
      <Empty
        title="Nothing matches this filter"
        hint={
          held > 0
            ? `${held} ${held === 1 ? 'record is' : 'records are'} in this queue under other ` +
              'statuses or search terms. Clear the search, or choose "All".'
            : 'This queue holds nothing at all, so no filter will find anything.'
        }
        icon={<Search size={28} />}
      />
    )
  }

  if (failed) {
    // The banner above already said what failed and why. Do not repeat a number.
    return (
      <Empty
        title="Nothing could be shown for this queue"
        hint={
          'A source above could not be read, so this is not a statement that ' +
          'nobody is waiting. Fix the read, then look again.'
        }
        icon={<ShieldOff size={28} />}
      />
    )
  }

  if (rawRecords > 0) {
    return (
      <Empty
        title="Records were read but none could be shown here"
        hint={
          `${rawRecords} ${rawRecords === 1 ? 'record was' : 'records were'} returned by the ` +
          'sources behind this queue and none of them became a reviewable row. ' +
          'That is a defect in this screen, not an empty queue — report it rather ' +
          'than treating this category as having no applicants.'
        }
        icon={<AlertTriangle size={28} />}
      />
    )
  }

  const what: Record<Category, string> = {
    main_agency: 'No main agency has applied yet.',
    sub_agency: 'No sub-agency has been created yet.',
    coin_seller: 'No coin seller has been registered yet.',
    host: 'No host application has been filed yet.',
    reapproval: 'No partner has proposed a change to their details.',
  }
  const how: Record<Category, string> = {
    main_agency: 'They arrive from /agency-signup and from /agencies/register.',
    sub_agency: 'They arrive when a main agency creates one from its dashboard.',
    coin_seller: 'They arrive from /seller-signup and from /sellers/register.',
    host: 'They arrive when an agency uses Invite Host on its dashboard.',
    reapproval:
      'They arrive when an approved agency, seller or host asks to change a ' +
      'bank account, a KYC document or their legal identity. The change is ' +
      'held here and does not touch their record until somebody decides it.',
  }
  return (
    <Empty
      title={what[category]}
      hint={`Every source behind this queue was read and returned nothing. ${how[category]}`}
      icon={<ShieldCheck size={28} />}
    />
  )
}

// ── One record under review ───────────────────────────────────────────────────

function ReviewCard({
  item, onZoom, onDecide, mayDecide,
}: {
  item: Item
  onZoom: (url: string) => void
  onDecide: (action: DecisionAction) => void
  /** Holds `can_approve_kyc`. Without it the queue is readable, not actionable. */
  mayDecide: boolean
}) {
  const unregistered = item.linkage === 'unregistered'
  const hostUnlinked = item.linkage === 'host_unlinked'
  const reapproval =
    item.linkage === 'reapproval' || item.linkage === 'reapproval_host'
  // A re-approval row is waiting on a decision whatever its status says, so
  // age it on the proposal rather than on `status === 'pending'` — otherwise a
  // bank change on an approved partner could sit for a fortnight without ever
  // being marked as having waited.
  const stale = (reapproval || item.status === 'pending') && ageDays(item.submittedAt) >= 3
  const touchesPayout = item.changes.some((c) => PAYOUT_LOOK.has(c.field))

  return (
    <div
      className={`bg-slate-900 border rounded-xl p-5 ${
        unregistered
          ? 'border-yellow-500/40'
          : reapproval
            ? 'border-pink-500/40'
            : stale
              ? 'border-amber-500/40'
              : 'border-slate-800'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-white font-semibold truncate">{item.name}</h2>
          <p className="text-slate-500 text-sm truncate">{item.subtitle || '—'}</p>
          <p className="text-slate-600 text-xs font-mono truncate mt-0.5">{item.id}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {/* Age on every row. Work that sits unnoticed is the failure mode. */}
          <span
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
              stale ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-800 text-slate-400'
            }`}
            title={`Submitted ${whenOf(item.submittedAt)}`}
          >
            <Clock size={11} /> {ageOf(item.submittedAt)}
          </span>
          {unregistered && (
            <span className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-yellow-500/15 text-yellow-300">
              <Link2Off size={11} /> no business record
            </span>
          )}
          {reapproval && (
            <span className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-pink-500/15 text-pink-300">
              <Repeat size={11} /> proposed change
            </span>
          )}
          <span className={`text-xs px-2 py-1 rounded ${STATUS_TONE[item.status] ?? 'bg-slate-700 text-slate-300'}`}>
            {item.status}
          </span>
          {item.href && (
            <Link
              href={item.href}
              className="flex items-center gap-0.5 text-pink-400 hover:text-pink-300 text-xs"
            >
              Open <ChevronRight size={12} />
            </Link>
          )}
        </div>
      </div>

      {item.conflict && (
        <p className="flex items-start gap-1.5 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-amber-200 text-xs mb-3">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {item.conflict}
        </p>
      )}

      {item.linkageNote && (
        <p className="flex items-start gap-1.5 text-amber-300 text-xs mb-3">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {item.linkageNote}
        </p>
      )}

      {/* What is actually being decided, when it is a change rather than an
          application. Every field side by side, live value first: the reviewer
          is answering "did they mean to change this, and is the new value
          theirs", and that question cannot be asked of the new value alone. */}
      {reapproval && (
        <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 mb-3">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <p className="text-white text-sm font-semibold">
              {item.changes.length === 1
                ? '1 field would change'
                : `${item.changes.length} fields would change`}
            </p>
            {item.proposal?.submittedBy.name && (
              <p className="text-slate-500 text-xs">
                Proposed by {item.proposal.submittedBy.name}
                {item.proposal.submittedBy.role ? ` (${item.proposal.submittedBy.role})` : ''}
              </p>
            )}
          </div>

          {touchesPayout && (
            <p className="flex items-start gap-2 bg-pink-500/10 border border-pink-500/30 rounded-lg px-3 py-2 text-pink-100 text-xs mb-3">
              <Landmark size={13} className="mt-0.5 shrink-0" />
              <span>
                This changes where money is sent. Until you approve it they are
                still being paid into the account in the left-hand column —
                check the new one against the documents and against the account
                holder&rsquo;s name before you move it.
              </span>
            </p>
          )}

          <div className="space-y-2">
            {item.changes.map((c) => (
              <div
                key={c.field}
                className="grid grid-cols-1 sm:grid-cols-[9rem_1fr_auto_1fr] gap-1 sm:gap-3 items-baseline"
              >
                <p className="text-slate-500 text-xs uppercase tracking-wide">{c.label}</p>
                <p className="text-slate-300 text-sm break-all">{displayValue(c.from)}</p>
                <ArrowRight size={12} className="text-slate-600 hidden sm:block" />
                <p className="text-pink-200 text-sm font-medium break-all">
                  {displayValue(c.to)}
                </p>
              </div>
            ))}
          </div>

          {item.proposal?.note && (
            <p className="text-slate-500 text-xs mt-3">
              They said: &ldquo;{item.proposal.note}&rdquo;
            </p>
          )}
        </div>
      )}

      {item.docsCaption && (
        <p className="text-slate-500 text-xs mb-2">{item.docsCaption}</p>
      )}

      {/* Documents, inline. Verification means looking at them. */}
      {item.docs.length === 0 ? (
        <p className="text-slate-600 text-sm mb-3">
          {reapproval
            ? 'This proposal replaces no documents, so the ones already on file ' +
              'still stand. Open the record to see them — whether the new detail ' +
              'matches what was verified is the question being asked here.'
            : 'No documents were uploaded. There is nothing here to verify against — ' +
              'approving would be a decision made on no evidence.'}
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
          {item.docs.map((d, i) => (
            <DocThumb key={`${d.label}-${i}`} doc={d} onZoom={() => onZoom(d.url)} />
          ))}
        </div>
      )}

      <p className="text-slate-600 text-xs">
        {reapproval ? 'Proposed ' : 'Submitted '}
        {whenOf(item.submittedAt)}
      </p>

      {/* The application's own rejection reason is about the application, not
          about this proposal, and printing it beside a change somebody is
          waiting on reads as though the change had been refused. */}
      {!reapproval && item.status === 'rejected' && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2.5 mt-3">
          <p className="text-red-300 text-xs font-medium flex items-center gap-1">
            <XCircle size={12} /> Rejected
          </p>
          <p className="text-red-200/85 text-sm mt-0.5">
            {item.rejectionReason || 'No reason was recorded against this record.'}
          </p>
        </div>
      )}

      {!reapproval && item.status === 'approved' && (
        <p className="text-green-400 text-sm flex items-center gap-1.5 mt-3">
          <CheckCircle2 size={14} /> Approved.
        </p>
      )}

      {/* An unregistered applicant cannot be approved or rejected, because there
          is nothing to approve or reject. The one available act is creating the
          record, and it is labelled as what it is. */}
      {unregistered ? (
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <button
            onClick={() => onDecide('register')}
            className="flex items-center gap-1.5 bg-yellow-500/15 hover:bg-yellow-500/25 border border-yellow-500/30 text-yellow-200 font-medium rounded-lg px-4 py-2 text-sm transition-colors"
          >
            <Link2Off size={14} /> Create business record
          </button>
          <span className="text-slate-600 text-xs">
            Creates it holding nothing and pending. It still has to be approved.
          </span>
        </div>
      ) : (
        // A re-approval row is decidable whatever its status — the proposal is
        // what is waiting, not the partner — so it does not go through the
        // pending/suspended gate the other queues use. Gating it on status is
        // the very thing that let an approved partner change their bank
        // account unseen.
        (reapproval || item.status === 'pending' || item.status === 'suspended') && (
          <div className="flex flex-wrap items-center gap-2 mt-4">
            {!mayDecide && (
              <span className="text-slate-500 text-xs">
                You can review this queue. Approving and rejecting is Operations&apos;
                — ask an ops admin or an owner.
              </span>
            )}
            {mayDecide && <>
            <button
              onClick={() => onDecide('approve')}
              className="flex items-center gap-1.5 bg-green-600 hover:bg-green-500 disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
            >
              <CheckCircle2 size={14} /> {reapproval ? 'Apply the change' : 'Approve'}
            </button>
            <button
              onClick={() => onDecide('reject')}
              className="flex items-center gap-1.5 bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 font-medium rounded-lg px-4 py-2 text-sm transition-colors"
            >
              <XCircle size={14} /> {reapproval ? 'Refuse it' : 'Reject'}
            </button>
            </>}
            <span className="text-slate-600 text-xs">
              {reapproval
                ? 'Refusing changes nothing on the record. Both need a reason, ' +
                  'and you cannot decide a change you proposed yourself.'
                : hostUnlinked
                  ? 'Approving switches the referral code on. Rejecting cancels the invitation.'
                  : 'Rejecting requires a reason, and that reason is kept on the record.'}
            </span>
          </div>
        )
      )}
    </div>
  )
}

// ── Bits ──────────────────────────────────────────────────────────────────────

function DocThumb({ doc: d, onZoom }: { doc: DocRef; onZoom: () => void }) {
  const [broken, setBroken] = useState(false)
  const isPdf = /\.pdf(\?|$)/i.test(d.url) || d.url.toLowerCase().includes('%2fpdf')

  if (!d.url) {
    return (
      <div>
        <p className="text-slate-500 text-xs mb-1">{d.label}</p>
        <div className="flex items-center justify-center h-24 bg-slate-950 border border-dashed border-slate-700 rounded-lg text-slate-600 text-xs">
          Not uploaded
        </div>
      </div>
    )
  }

  if (isPdf || broken) {
    return (
      <div>
        <p className="text-slate-500 text-xs mb-1">{d.label}</p>
        <a
          href={d.url}
          target="_blank"
          rel="noreferrer"
          className="flex flex-col items-center justify-center gap-1.5 h-24 bg-slate-950 border border-slate-700 hover:border-pink-500/40 rounded-lg text-slate-400 hover:text-pink-300 text-xs transition-colors"
        >
          {broken ? <ImageOff size={16} /> : <FileText size={16} />}
          {broken ? 'Could not load — open directly' : 'PDF'}
          <ExternalLink size={10} />
        </a>
      </div>
    )
  }

  return (
    <div>
      <p className="text-slate-500 text-xs mb-1">{d.label}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={d.url}
        alt={d.label}
        onClick={onZoom}
        onError={() => setBroken(true)}
        className="w-full h-24 object-cover bg-slate-950 rounded-lg border border-slate-700 hover:border-pink-500/50 cursor-zoom-in transition-colors"
      />
    </div>
  )
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <button onClick={onClose} className="absolute top-4 right-4 text-slate-300 hover:text-white">
        <X size={22} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="Document"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-full object-contain rounded-lg"
      />
    </div>
  )
}

/** Payout fields, for the "this moves money" warning on a re-approval row. */
const PAYOUT_LOOK = new Set<string>(PAYOUT_FIELDS)

/** What the dialog says this act will do. Different acts, different sentences. */
function explain(action: DecisionAction, item: Item): string {
  if (item.linkage === 'reapproval' || item.linkage === 'reapproval_host') {
    if (action === 'approve') {
      const moves = item.changes.some((c) => PAYOUT_LOOK.has(c.field))
      return (
        'The proposed values are written onto the live record and the proposal ' +
        'is cleared. ' +
        (moves
          ? 'This is the write that moves where their money is sent — from now ' +
            'on a payout is made to the new account. '
          : '') +
        'Your name, the time and this reason go on the record and into the ' +
        'audit log, beside who proposed it. Nothing about their approval, ' +
        'inventory or commission changes.'
      )
    }
    return (
      'Nothing on the record moves — they keep being paid exactly as they are ' +
      'today and keep trading. The proposal is discarded and your reason is ' +
      'shown on their own dashboard, which is what stops them simply sending ' +
      'the same change again.'
    )
  }
  if (action === 'register') {
    return (
      'This creates the business record behind the application — zero coins, zero ' +
      'credit, zero commission, pending and inactive. It approves nothing and ' +
      'grants nothing; the applicant simply becomes reviewable. The reason is ' +
      'kept in the audit log.'
    )
  }
  if (action === 'approve') {
    if (item.linkage === 'host') {
      return (
        'One call does both halves: the account becomes a host attached to the ' +
        'inviting agency, and the application is marked approved on both of its ' +
        'status fields, with your name, the time and this reason. It is the only ' +
        'thing that writes either field. No money moves.'
      )
    }
    return (
      'They can start trading with us. No money moves now — that is always a ' +
      'separate card an owner signs.'
    )
  }
  if (item.linkage === 'host_unlinked') {
    return (
      'Nobody has redeemed this referral code, so there is no account to revoke ' +
      'host status from and none is touched. The application is marked rejected ' +
      'on both of its status fields and the invitation is spent — the code stops ' +
      'working. The reason is stored on it and shown here afterwards.'
    )
  }
  return (
    'The reason is stored on the record and shown on this queue afterwards, so ' +
    'the applicant is told why instead of silently reapplying.'
  )
}

/**
 * A decision, with the reason it needs.
 *
 * Not `window.prompt`: a reason typed into a browser dialog cannot be reviewed
 * before it is sent, cannot be corrected, and cannot say what it is for.
 */
function ReasonDialog({
  action, item, onClose, onConfirm,
}: {
  action: DecisionAction
  item: Item
  onClose: () => void
  onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const valid = reason.trim().length >= MIN_REASON
  const reapproval =
    item.linkage === 'reapproval' || item.linkage === 'reapproval_host'

  const title =
    action === 'register' ? 'Create the business record'
      : reapproval
        ? action === 'approve' ? 'Apply this change' : 'Refuse this change'
        : action === 'approve' ? 'Approve this application'
          : 'Reject this application'

  async function go() {
    if (!valid) return
    setBusy(true)
    setErr('')
    try {
      await onConfirm(reason.trim())
    } catch (e) {
      // Verbatim. The API's refusals are written to be read by the person who
      // hit them; paraphrasing one is how a fixable problem becomes a mystery.
      setErr(e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'That did not go through.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-white font-semibold">{title}</h2>
            <p className="text-slate-500 text-xs mt-0.5 truncate">{item.name}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <p className="text-slate-400 text-sm">{explain(action, item)}</p>

          {/* The fields themselves, one last time, inside the dialog. The card
              is behind a modal by this point, and "are you sure" about a bank
              account nobody can currently see is not a confirmation. */}
          {reapproval && item.changes.length > 0 && (
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-3 space-y-1.5">
              {item.changes.map((c) => (
                <p key={c.field} className="text-xs text-slate-400 break-all">
                  <span className="text-slate-500 uppercase tracking-wide">{c.label}</span>
                  {': '}
                  {displayValue(c.from)} <span className="text-slate-600">→</span>{' '}
                  <span className="text-pink-200 font-medium">{displayValue(c.to)}</span>
                </p>
              ))}
            </div>
          )}

          {!reapproval && action === 'approve' && item.docs.length === 0 && (
            <p className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-amber-200 text-sm">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              No documents were uploaded against this application. Say in the
              reason what you verified instead.
            </p>
          )}
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder={
              action === 'reject'
                ? 'Why is this being rejected? The applicant is told this.'
                : 'What did you check? Kept in the audit log.'
            }
            className={`w-full bg-slate-800 border rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none resize-none ${
              action === 'reject'
                ? 'border-slate-700 focus:border-red-500'
                : 'border-slate-700 focus:border-pink-500'
            }`}
          />
          {reason.trim().length > 0 && !valid && (
            <p className="text-amber-400 text-xs">At least {MIN_REASON} characters.</p>
          )}
          {err && (
            <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {err}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
          <button onClick={onClose} className="text-slate-400 hover:text-white text-sm px-4 py-2">
            Cancel
          </button>
          <button
            onClick={go}
            disabled={!valid || busy}
            className={`flex items-center gap-2 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors ${
              action === 'reject' ? 'bg-red-600 hover:bg-red-500' : 'bg-green-600 hover:bg-green-500'
            }`}
          >
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : action === 'reject' ? (
              <XCircle size={14} />
            ) : (
              <CheckCircle2 size={14} />
            )}
            {action === 'register'
              ? 'Create record'
              : reapproval
                ? action === 'approve' ? 'Apply' : 'Refuse'
                : action === 'approve' ? 'Approve' : 'Reject'}
          </button>
        </div>
      </div>
    </div>
  )
}
