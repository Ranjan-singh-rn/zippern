'use client'

/**
 * The appeals queue — the return path.
 *
 * Every other moderation screen in this CRM runs one way: somebody with
 * authority decides, and the person it happened to finds out. This is the only
 * one where the decision is questioned, and it is the only queue where the row
 * at the top is a person currently locked out of the product.
 *
 * ── §5: REVIEWERS RECOMMEND, THE OWNER DECIDES, FOUR EYES ALWAYS ─────────────
 *
 * A reviewer holding `can_ban_users` RECOMMENDS — uphold or overturn, with a
 * written note of at least ten characters — and nothing is lifted by it: the
 * appeal stays waiting and the Owners are told. Only the Owner DECIDES; the
 * server answers anybody else with 403 and says to recommend instead. Neither
 * may be done by whoever made the decision being appealed. Every one of those
 * refusals is a sentence written to be shown, and it is shown verbatim; the
 * controls offered are `appealReviewActions` (`lib/appealReview.ts`).
 *
 * Beside each appeal sits what the decision is about — the restriction the
 * account is under now, who decided it, when and why, a ban's category,
 * evidence and scope — and the recommendation, so whoever decides sees the
 * original decision, the evidence and the notes side by side.
 *
 * ── OLDEST FIRST, AND THAT IS NOT A PREFERENCE ───────────────────────────────
 *
 * The report queue is newest-first because a fresh report may still be in
 * progress. An appeal is the opposite: waiting costs the appellant every day it
 * sits, and a newest-first queue strands the person with the strongest
 * grievance behind everyone who complained after them. The server sorts this
 * one ascending for that reason and the page does not re-sort it.
 *
 * ── WHAT OVERTURNING ACTUALLY DOES ───────────────────────────────────────────
 *
 * Not one thing. A ban lifts immediately. A warning stays on the record marked
 * overturned, because deleting it deletes the fact that it happened. Beans that
 * have already been paid out are gone, and returning them is a new movement of
 * value that an owner has to sign.
 *
 * So the server returns two lists — `reversed` and `outstanding` — and this
 * screen shows both, every time. "Overturned" on its own would imply the second
 * list is empty, and a reviewer who believes the beans came back when they did
 * not will not raise the credit that actually returns them.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, Check, Clock, FileText, Gavel, Loader2, MessageSquareQuote, Scale, ShieldCheck, X,
} from 'lucide-react'
import api, {
  ApiError,
  type Appeal, type AppealEvidenceLink, type AppealOutcome, type AppealStatus, type AppealVerdict,
} from '@/lib/api'
import {
  isActionable, isReviewerDecision, presentAppealStatus,
} from '@/lib/appealStatus'
import {
  MIN_DECISION_REASON, MIN_RECOMMENDATION_NOTE, OUTCOME_LABEL, RECOMMENDATION_OUTCOMES,
  appealReviewActions, decidedOnRecommendationLine, decisionReasonProblem, presentRecommendation,
  presentRestriction, recommendationProblem, verdictFor,
  type RecommendationOutcome, type RecommendationView, type RestrictionView,
} from '@/lib/appealReview'
import { storageLink } from '@/lib/safeLink'
import { Denied, Empty, ErrorState, Loading } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, hasPermission, type CrmRole } from '@/lib/auth'

const VIEW_ROLES: CrmRole[] = [
  'superadmin', 'ops_admin', 'ops_member', 'app_admin', 'app_member', 'support_admin',
]

type Tab = 'pending' | AppealStatus | 'all'

/**
 * Waiting stays first and alone, because it is the only tab with work in it.
 * The other three are outcomes, and `Resolved` sits with them rather than
 * being folded into one of them — an appeal closed because an admin lifted the
 * restriction is not an appeal somebody overturned, and burying it under
 * `Overturned` would silently inflate how often reviewers agree with
 * appellants.
 */
const TABS: { key: Tab; label: string }[] = [
  { key: 'pending', label: 'Waiting' },
  { key: 'overturned', label: 'Overturned' },
  { key: 'upheld', label: 'Upheld' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'all', label: 'All' },
]

/** What `All` means per tab, when the queue comes back empty. */
const EMPTY_HINTS: Record<Tab, string> = {
  pending:
    'Every appeal raised has been decided. This is the queue reporting itself ' +
    'empty, not a read that failed.',
  overturned: 'No appeal has been overturned yet.',
  upheld: 'No appeal has been upheld yet.',
  resolved:
    'No appeal has been closed this way yet. An appeal lands here when an ' +
    'admin lifts the restriction directly while the appeal is still waiting.',
  all: 'No appeal has been raised yet.',
}

/** A Firestore timestamp or an ISO string, in milliseconds. */
function millis(value: Appeal['createdAt']): number | null {
  if (!value) return null
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isNaN(t) ? null : t
  }
  return typeof value.seconds === 'number' ? value.seconds * 1000 : null
}

function age(value: Appeal['createdAt']): string {
  const t = millis(value)
  if (t === null) return 'age unknown'
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 60) return `${Math.max(mins, 0)}m`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`
}

function when(ms: number | null): string {
  return ms === null ? 'time not recorded' : new Date(ms).toLocaleString('en-IN')
}

/** Anything waiting longer than this is somebody locked out for too long. */
const STALE_DAYS = 2

function isStale(a: Appeal): boolean {
  const t = millis(a.createdAt)
  // `isActionable`, not `status === 'pending'`: stale means somebody is still
  // waiting on us. A resolved appeal is old but nobody is waiting — the
  // restriction is already gone — so it must not be flagged amber as if it
  // were a neglected queue item.
  return (
    isActionable(a.status) &&
    t !== null &&
    Date.now() - t > STALE_DAYS * 86400000
  )
}

export default function AppealsPage() {
  const { crmUser, apiUser, loading: authLoading } = useAuth()
  const canView = canAccess(crmUser, VIEW_ROLES)
  // The server's two tiers: `can_ban_users` recommends; the Owner decides.
  const reviewer = {
    isOwner: apiUser?.role === 'owner',
    canBan: hasPermission(crmUser, 'can_ban_users'),
    uid: apiUser?.uid ?? crmUser?.uid ?? '',
  }

  const [tab, setTab] = useState<Tab>('pending')
  const [appeals, setAppeals] = useState<Appeal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [target, setTarget] = useState<Appeal | null>(null)
  const [verdict, setVerdict] = useState<AppealVerdict>('upheld')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [outcome, setOutcome] = useState<AppealOutcome | null>(null)
  const [zoom, setZoom] = useState('')

  // §5 — the reviewer's recommendation.
  const [recTarget, setRecTarget] = useState<Appeal | null>(null)
  const [recOutcome, setRecOutcome] = useState<RecommendationOutcome | ''>('')
  const [recNote, setRecNote] = useState('')
  const [recBusy, setRecBusy] = useState(false)
  const [recFailure, setRecFailure] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setAppeals(await api.users.appeals(tab === 'all' ? undefined : tab, 200))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the appeals queue.')
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    if (!canView) return
    load()
  }, [canView, load])

  function open(a: Appeal) {
    setTarget(a)
    // The Owner starts from what the reviewer argued for — and can change it.
    setVerdict(verdictFor(a.recommendation?.outcome) ?? 'upheld')
    setReason('')
    setFailure('')
    setOutcome(null)
  }

  function openRecommend(a: Appeal) {
    setRecTarget(a)
    setRecOutcome('')
    setRecNote('')
    setRecFailure('')
  }

  async function submit() {
    if (!target) return
    const why = reason.trim()
    const problem = decisionReasonProblem(why)
    if (problem) {
      setFailure(problem)
      return
    }
    setBusy(true)
    setFailure('')
    try {
      const result = await api.users.decideAppeal(target.id, verdict, why)
      setOutcome(result)
      setTarget(null)
      await load()
    } catch (err) {
      // Verbatim: the Owner-only and four-eyes refusals say what to do instead.
      setFailure(err instanceof ApiError ? err.message : 'That did not go through.')
    } finally {
      setBusy(false)
    }
  }

  async function recommend() {
    if (!recTarget) return
    const problem = recommendationProblem(recOutcome, recNote)
    if (problem || !recOutcome) {
      setRecFailure(problem || 'Choose: uphold the decision, or overturn it.')
      return
    }
    setRecBusy(true)
    setRecFailure('')
    try {
      const res = await api.users.recommendAppeal(recTarget.id, recOutcome, recNote.trim())
      const sent = res.owner_notified?.email?.sent
      setNotice(
        `Recommendation recorded: ${recOutcome}. Nothing was lifted — the appeal waits for the Owner, ` +
        (typeof sent === 'number'
          ? `who ${sent === 1 ? 'was' : 'were'} told (${sent} email${sent === 1 ? '' : 's'} sent).`
          : 'who are told.'),
      )
      setRecTarget(null)
      await load()
    } catch (err) {
      // Verbatim — the four-eyes refusal names exactly why.
      setRecFailure(err instanceof ApiError ? err.message : 'That did not go through.')
    } finally {
      setRecBusy(false)
    }
  }

  if (authLoading) return <Loading label="Checking your access…" />
  if (!canView) return <Denied what="the appeals queue" />

  return (
    <div className="max-w-5xl mx-auto">
      <Link
        href="/operations"
        className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-300 text-sm mb-4"
      >
        <ArrowLeft size={14} /> Operations
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <Scale size={26} className="text-pink-500" />
            Appeals
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Somebody says a decision about them was wrong — raised by the account
            itself, or by the agency that recruited them. Oldest first: a waiting
            appeal is a person still locked out. Reviewers recommend; only the
            Owner decides, and never the person who made the original decision.
          </p>
        </div>
      </div>

      {notice && (
        <div className="mb-4 flex items-start justify-between gap-3 bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3">
          <p className="text-blue-100 text-sm flex items-start gap-2">
            <MessageSquareQuote size={15} className="text-blue-300 mt-0.5 shrink-0" /> {notice}
          </p>
          <button onClick={() => setNotice('')} className="text-blue-300/70 hover:text-blue-100">
            <X size={14} />
          </button>
        </div>
      )}

      {outcome && (
        <div className="mb-4 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-white text-sm font-medium flex items-center gap-2">
              <Check size={15} className="text-green-400" />
              Appeal {outcome.status}.
            </p>
            <button onClick={() => setOutcome(null)} className="text-slate-500 hover:text-white">
              <X size={15} />
            </button>
          </div>
          {outcome.reversed.length > 0 && (
            <ul className="mt-2 space-y-1">
              {outcome.reversed.map((r) => (
                <li key={r} className="text-green-200 text-sm">• {r}</li>
              ))}
            </ul>
          )}
          {/* The half a verdict alone would hide. */}
          {outcome.outstanding.length > 0 && (
            <div className="mt-3 bg-amber-500/5 border border-amber-500/30 rounded-lg px-3 py-2">
              <p className="text-amber-300 text-xs font-semibold">
                Still outstanding — this was not undone by the verdict
              </p>
              <ul className="mt-1 space-y-1">
                {outcome.outstanding.map((o) => (
                  <li key={o} className="text-amber-100/90 text-sm">• {o}</li>
                ))}
              </ul>
            </div>
          )}
          {(outcome.also_resolved ?? []).length > 0 && (
            <p className="text-slate-400 text-xs mt-2">
              {outcome.also_resolved?.length} other waiting appeal(s) for this account were closed as resolved —
              the restriction they were about is gone.
            </p>
          )}
        </div>
      )}

      <div className="flex gap-1 border-b border-slate-800 mb-5">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-pink-500 text-pink-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <Loading label="Reading the appeals queue…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : appeals.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <Empty
            title={tab === 'pending' ? 'Nobody is waiting on an appeal' : 'Nothing here'}
            hint={EMPTY_HINTS[tab]}
            icon={<ShieldCheck size={26} />}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {appeals.map((a) => {
            const actions = appealReviewActions(a, reviewer)
            const restriction = presentRestriction(a.restriction)
            const rec = presentRecommendation(a.recommendation)
            return (
            <div
              key={a.id}
              className={`bg-slate-900 border rounded-xl p-5 ${
                isStale(a) ? 'border-amber-500/40' : 'border-slate-800'
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <p className="text-white font-semibold truncate">
                    {a.subjectName || a.subjectUid}
                  </p>
                  <p className="text-slate-500 text-xs mt-0.5">
                    {a.kind === 'report'
                      ? 'Contesting a report decision'
                      : 'Appealing a ban or suspension'}
                    {' · raised by '}
                    {a.raisedByRole === 'agency'
                      ? `their agency${a.raisedByName ? ` (${a.raisedByName})` : ''}`
                      : a.source === 'public_web'
                        ? `the public appeal page${a.reference ? ` · reference ${a.reference}` : ''}`
                        : 'the account itself'}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {a.source === 'public_web' && (
                    // UGP review: the public page identifies an account by its
                    // id (or name + profile id) and, since §5, the phone number
                    // or email on it — details others can know. The person who
                    // wrote this may not be the account's owner.
                    <span
                      className="text-xs px-2 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300"
                      title="Filed on the public web page without signing in. It names the account's own phone or email, but anybody who knows those can file one — the writer is not verified as the account's owner."
                    >
                      Identity not verified
                    </span>
                  )}
                  <span
                    className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
                      isStale(a) ? 'bg-amber-500/15 text-amber-300' : 'bg-slate-800 text-slate-400'
                    }`}
                  >
                    <Clock size={11} /> {age(a.createdAt)}
                  </span>
                  <span
                    className={`text-xs px-2 py-1 rounded border ${
                      presentAppealStatus(a.status).tone
                    }`}
                  >
                    {presentAppealStatus(a.status).label}
                  </span>
                  <Link
                    href={`/users/${a.subjectUid}`}
                    className="text-pink-400 hover:text-pink-300 text-xs"
                  >
                    Open the account
                  </Link>
                </div>
              </div>

              <p className="text-slate-200 text-sm bg-slate-950 border border-slate-800 rounded-lg px-3 py-2.5 whitespace-pre-wrap">
                {a.statement}
              </p>

              {(a.evidence ?? []).length > 0 && (
                <PrivateEvidence appealId={a.id} count={(a.evidence ?? []).length} onZoom={setZoom} />
              )}

              {(a.evidenceUrls ?? []).length > 0 && (
                <div className="grid grid-cols-3 gap-2 max-w-sm mt-3">
                  {(a.evidenceUrls ?? []).map((url) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={url}
                      src={url}
                      alt="Evidence"
                      onClick={() => setZoom(url)}
                      className="w-full h-20 object-cover bg-slate-950 rounded-lg border border-slate-700 hover:border-pink-500/50 cursor-zoom-in transition-colors"
                    />
                  ))}
                </div>
              )}

              {/* §5: the decision under appeal, beside the appeal. */}
              {isActionable(a.status) && (
                restriction
                  ? <RestrictionPanel r={restriction} />
                  : (
                    <p className="mt-3 text-slate-500 text-xs border border-slate-800 rounded-lg px-3 py-2">
                      The account is under no restriction now, or it could not be read — there is nothing on
                      it to show beside this appeal.
                    </p>
                  )
              )}

              {rec && <RecommendationPanel rec={rec} />}

              {/*
                Three branches, not two. This used to be
                `status === 'pending' ? decide : "A reviewer said: …"`, which
                meant every status that was not pending got presented as a
                reviewer's decision. `resolved` has no reviewer — the server
                refuses to name one — so the old `else` printed "A reviewer
                said:" above a sentence nobody had said, about an appeal nobody
                had read.
              */}
              {isActionable(a.status) ? (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {actions.decide && (
                    <button
                      onClick={() => open(a)}
                      className="flex items-center gap-1.5 bg-pink-500 hover:bg-pink-600 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
                    >
                      <Gavel size={14} /> Decide (Owner)
                    </button>
                  )}
                  {actions.recommend && (
                    <button
                      onClick={() => openRecommend(a)}
                      className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
                    >
                      <MessageSquareQuote size={14} /> {rec ? 'Replace the recommendation' : 'Recommend'}
                    </button>
                  )}
                  {actions.hint && (
                    <span className={`text-xs ${actions.ownDecision ? 'text-amber-300' : 'text-slate-500'}`}>
                      {actions.hint}
                    </span>
                  )}
                </div>
              ) : isReviewerDecision(a.status) ? (
                <div className="mt-3 border-t border-slate-800 pt-3">
                  <p className="text-slate-400 text-sm">
                    <span className="text-slate-500">{a.decidedByName || 'A reviewer'} said:</span>{' '}
                    {a.decisionReason}
                  </p>
                  {decidedOnRecommendationLine(a.decidedOnRecommendation) && (
                    <p className="text-slate-500 text-xs mt-1">{decidedOnRecommendationLine(a.decidedOnRecommendation)}</p>
                  )}
                  {(a.reversed ?? []).map((r) => (
                    <p key={r} className="text-green-300/90 text-xs mt-1">• {r}</p>
                  ))}
                  {(a.outstanding ?? []).map((o) => (
                    <p key={o} className="text-amber-300/90 text-xs mt-1">• {o}</p>
                  ))}
                </div>
              ) : (
                <div className="mt-3 border-t border-slate-800 pt-3">
                  <p className="text-slate-400 text-sm">
                    {presentAppealStatus(a.status).note}
                  </p>
                  {a.resolvedByName && (
                    <p className="text-slate-500 text-xs mt-1.5">
                      {a.resolvedTrigger === 'resume'
                        ? 'The suspension was ended early by '
                        : a.resolvedTrigger === 'unban'
                          ? 'The ban was lifted by '
                          : 'The restriction was removed by '}
                      {a.resolvedByName}.
                    </p>
                  )}
                </div>
              )}
            </div>
            )
          })}
        </div>
      )}

      {zoom && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85"
          onClick={() => setZoom('')}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoom}
            alt="Evidence"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] max-w-full object-contain rounded-lg"
          />
        </div>
      )}

      {target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
              <div className="min-w-0">
                <h2 className="text-white font-semibold">Decide this appeal</h2>
                <p className="text-slate-500 text-xs mt-0.5 truncate">
                  {target.subjectName || target.subjectUid}
                </p>
              </div>
              <button onClick={() => setTarget(null)} className="text-slate-500 hover:text-white shrink-0">
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-3">
              {presentRecommendation(target.recommendation) ? (
                <RecommendationPanel rec={presentRecommendation(target.recommendation) as RecommendationView} compact />
              ) : (
                <p className="text-slate-500 text-xs">No reviewer has recommended on this appeal. You may decide it without one.</p>
              )}

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setVerdict('upheld')}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    verdict === 'upheld'
                      ? 'bg-slate-700/40 border-slate-600 text-slate-100'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  Uphold
                </button>
                <button
                  onClick={() => setVerdict('overturned')}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    verdict === 'overturned'
                      ? 'bg-green-500/10 border-green-500/40 text-green-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  Overturn
                </button>
              </div>

              <p className="text-slate-300 text-sm leading-relaxed">
                {verdict === 'upheld'
                  ? 'The original decision stands. Nothing about the account changes, and your reason is what the person who appealed is told.'
                  : 'The original decision was wrong. A ban or suspension is lifted now; a contested report is marked dismissed. Anything that cannot be undone from here — a warning already on the record, beans already paid out — comes back in the response so you can deal with it.'}
              </p>

              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5">
                  Your reasoning <span className="text-pink-400">(required)</span>
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={4}
                  autoFocus
                  placeholder="What you checked, and why this is the right call…"
                  className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
                />
                <p className="text-slate-600 text-xs mt-1">
                  At least {MIN_DECISION_REASON} characters. Shown to the person who appealed,
                  and stored in the audit log.
                </p>
              </div>

              {failure && (
                <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {failure}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
              <button onClick={() => setTarget(null)} className="text-slate-400 hover:text-white text-sm px-4 py-2">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy}
                className={`flex items-center gap-2 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors ${
                  verdict === 'overturned'
                    ? 'bg-green-600 hover:bg-green-500'
                    : 'bg-slate-600 hover:bg-slate-500'
                }`}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Scale size={14} />}
                {verdict === 'overturned' ? 'Overturn it' : 'Uphold it'}
              </button>
            </div>
          </div>
        </div>
      )}

      {recTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md">
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
              <div className="min-w-0">
                <h2 className="text-white font-semibold">Recommend an outcome</h2>
                <p className="text-slate-500 text-xs mt-0.5 truncate">
                  {recTarget.subjectName || recTarget.subjectUid}
                </p>
              </div>
              <button onClick={() => setRecTarget(null)} className="text-slate-500 hover:text-white shrink-0">
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-3">
              <p className="text-slate-300 text-sm leading-relaxed">
                Your recommendation goes to the Owner, who decides. Nothing about the account changes
                now, and the appeal keeps waiting. A second recommendation replaces the first; both stay
                on the record.
              </p>
              <div className="grid grid-cols-1 gap-2">
                {RECOMMENDATION_OUTCOMES.map((o) => (
                  <button
                    key={o}
                    onClick={() => setRecOutcome(o)}
                    aria-pressed={recOutcome === o}
                    className={`rounded-lg border px-3 py-2 text-sm font-medium text-left transition-colors ${
                      recOutcome === o
                        ? o === 'overturn'
                          ? 'bg-green-500/10 border-green-500/40 text-green-300'
                          : 'bg-slate-700/40 border-slate-600 text-slate-100'
                        : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                    }`}
                  >
                    {OUTCOME_LABEL[o]}
                  </button>
                ))}
              </div>
              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5">
                  Your note for the Owner <span className="text-pink-400">(required)</span>
                </label>
                <textarea
                  value={recNote}
                  onChange={(e) => setRecNote(e.target.value)}
                  rows={4}
                  autoFocus
                  placeholder="What you checked — the evidence, the account, the original decision…"
                  className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
                />
                <p className="text-slate-600 text-xs mt-1">
                  At least {MIN_RECOMMENDATION_NOTE} characters. It is the record the Owner decides on.
                </p>
              </div>
              {recFailure && (
                <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {recFailure}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
              <button onClick={() => setRecTarget(null)} className="text-slate-400 hover:text-white text-sm px-4 py-2">
                Cancel
              </button>
              <button
                onClick={recommend}
                disabled={recBusy}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors"
              >
                {recBusy ? <Loader2 size={14} className="animate-spin" /> : <MessageSquareQuote size={14} />}
                Send the recommendation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * §5 — the decision under appeal, read from the account now: who decided it,
 * when, why, and a ban's category, evidence and scope. Evidence references are
 * text; only an `https://` Storage link is rendered as a link (`safeLink`).
 */
function RestrictionPanel({ r }: { r: RestrictionView }) {
  return (
    <div className="mt-3 bg-slate-950/60 border border-slate-800 rounded-lg px-3 py-2.5 text-sm space-y-1">
      <p className="text-slate-200 font-medium">
        {r.stateLabel}
        {!r.isBan && (r.untilMs !== null ? ` until ${when(r.untilMs)}` : ' — no end date')}
      </p>
      <p className="text-slate-400 text-xs">
        Decided by <span className="text-slate-300">{r.decidedBy}</span> · {when(r.decidedAtMs)}
      </p>
      <p className="text-slate-300 text-xs">
        <span className="text-slate-500">Reason:</span> {r.reason || 'none recorded'}
      </p>
      {r.isBan && (
        <p className="text-slate-300 text-xs">
          <span className="text-slate-500">Category:</span> {r.category}
        </p>
      )}
      <p className="text-slate-300 text-xs">
        <span className="text-slate-500">Scope:</span> {r.scope}
      </p>
      {r.isBan && (
        r.evidence.length === 0 ? (
          <p className="text-slate-500 text-xs">No evidence references were recorded with this ban.</p>
        ) : (
          <div className="text-xs">
            <p className="text-slate-500">Evidence:</p>
            <ul className="mt-0.5 space-y-0.5">
              {r.evidence.map((e) => {
                const link = storageLink(e)
                return (
                  <li key={e} className="flex items-start gap-1.5 text-slate-300">
                    <FileText size={11} className="mt-0.5 shrink-0 text-slate-500" />
                    {link.kind === 'link' ? (
                      <a href={link.href} target="_blank" rel="noopener noreferrer" className="text-pink-300 underline underline-offset-2 break-all">
                        {e}
                      </a>
                    ) : (
                      <span className="font-mono break-all">{e}</span>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )
      )}
    </div>
  )
}

/** §5 — the reviewer's recommendation, as the Owner reads it. */
function RecommendationPanel({ rec, compact = false }: { rec: RecommendationView; compact?: boolean }) {
  return (
    <div className={`${compact ? '' : 'mt-3 '}bg-blue-500/5 border border-blue-500/25 rounded-lg px-3 py-2.5 text-sm`}>
      <p className={`font-medium ${rec.outcome === 'overturn' ? 'text-green-300' : 'text-slate-200'}`}>
        {rec.label}
      </p>
      <p className="text-slate-400 text-xs mt-0.5">
        {rec.by} · {when(rec.atMs)}
      </p>
      {rec.note && <p className="text-slate-300 text-sm mt-1.5 whitespace-pre-wrap">{rec.note}</p>}
    </div>
  )
}

/**
 * UGP-F: a public-web appeal's attachments are PRIVATE objects. They are shown
 * through fifteen-minute signed links fetched on demand, never a stored URL —
 * images as thumbnails (click to zoom), videos in a player.
 */
function PrivateEvidence({
  appealId, count, onZoom,
}: { appealId: string; count: number; onZoom: (url: string) => void }) {
  const [links, setLinks] = useState<AppealEvidenceLink[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setBusy(true)
    setError('')
    try {
      setLinks((await api.users.appealEvidence(appealId)).evidence)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The attachments could not be opened.')
    } finally {
      setBusy(false)
    }
  }

  if (links === null) {
    return (
      <div className="mt-3">
        <button
          onClick={load}
          disabled={busy}
          className="text-pink-300 hover:text-pink-200 text-xs underline underline-offset-2 disabled:opacity-50"
        >
          {busy ? 'Opening…' : `Show ${count} attachment${count === 1 ? '' : 's'}`}
        </button>
        {error && <p className="text-amber-300 text-xs mt-1">{error}</p>}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-3 gap-2 max-w-md mt-3">
      {links.map((l, i) =>
        !l.url ? (
          <p key={i} className="text-amber-300 text-xs col-span-3">{l.error || 'This attachment could not be opened.'}</p>
        ) : l.kind === 'video' ? (
          <video key={i} src={l.url} controls className="w-full h-24 bg-black rounded-lg border border-slate-700 col-span-3" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={i}
            src={l.url}
            alt="Evidence"
            onClick={() => onZoom(l.url as string)}
            className="w-full h-20 object-cover bg-slate-950 rounded-lg border border-slate-700 hover:border-pink-500/50 cursor-zoom-in transition-colors"
          />
        ),
      )}
    </div>
  )
}
