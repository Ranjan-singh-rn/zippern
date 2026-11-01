'use client'

/**
 * The appeals queue — the return path.
 *
 * Every other moderation screen in this CRM runs one way: somebody with
 * authority decides, and the person it happened to finds out. This is the only
 * one where the decision is questioned, and it is the only queue where the row
 * at the top is a person currently locked out of the product.
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
  AlertTriangle, ArrowLeft, Check, Clock, Loader2, Scale, ShieldCheck, X,
} from 'lucide-react'
import api, {
  ApiError,
  type Appeal, type AppealEvidenceLink, type AppealOutcome, type AppealStatus, type AppealVerdict,
} from '@/lib/api'
import {
  isActionable, isReviewerDecision, presentAppealStatus,
} from '@/lib/appealStatus'
import { Denied, Empty, ErrorState, Loading } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'

const VIEW_ROLES: CrmRole[] = [
  'superadmin', 'ops_admin', 'ops_member', 'app_admin', 'app_member', 'support_admin',
]

const MIN_REASON = 10

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
  const { crmUser, loading: authLoading } = useAuth()
  const canView = canAccess(crmUser, VIEW_ROLES)

  const [tab, setTab] = useState<Tab>('pending')
  const [appeals, setAppeals] = useState<Appeal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [target, setTarget] = useState<Appeal | null>(null)
  const [verdict, setVerdict] = useState<AppealVerdict>('upheld')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [outcome, setOutcome] = useState<AppealOutcome | null>(null)
  const [zoom, setZoom] = useState('')

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
    setVerdict('upheld')
    setReason('')
    setFailure('')
    setOutcome(null)
  }

  async function submit() {
    if (!target) return
    const why = reason.trim()
    if (why.length < MIN_REASON) {
      setFailure(
        `At least ${MIN_REASON} characters. This is shown to the person who ` +
        'appealed — it is the whole answer they get.',
      )
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
      setFailure(err instanceof ApiError ? err.message : 'That did not go through.')
    } finally {
      setBusy(false)
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
            appeal is a person still locked out.
          </p>
        </div>
      </div>

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
          {appeals.map((a) => (
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
                    // id (or name + profile id) — details others can know. The
                    // person who wrote this may not be the account's owner.
                    <span
                      className="text-xs px-2 py-1 rounded border border-amber-500/40 bg-amber-500/10 text-amber-300"
                      title="Filed on the public web page without signing in. Anybody who knows the account id can file one — the writer is not verified as the account's owner."
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
                <button
                  onClick={() => open(a)}
                  className="mt-4 flex items-center gap-1.5 bg-pink-500 hover:bg-pink-600 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
                >
                  <Scale size={14} /> Decide this
                </button>
              ) : isReviewerDecision(a.status) ? (
                <div className="mt-3 border-t border-slate-800 pt-3">
                  <p className="text-slate-400 text-sm">
                    <span className="text-slate-500">{a.decidedByName || 'A reviewer'} said:</span>{' '}
                    {a.decisionReason}
                  </p>
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
          ))}
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
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md">
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
                  At least {MIN_REASON} characters. Shown to the person who appealed,
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
