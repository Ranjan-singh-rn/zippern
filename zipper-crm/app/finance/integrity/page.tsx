'use client'

/**
 * /finance/integrity — B1 money integrity, for Finance and the Owners.
 *
 *   HELD ITEMS     GET  /partner-ops/held-items                       can_process_payout
 *                  POST /partner-ops/held-items/{type}/{id}/release   + Finance admin or Owner
 *   REPLICA DRIFT  GET  /partner-ops/money/replica-drift              can_process_payout
 *                  POST /partner-ops/money/replica-drift/repair       can_process_payout
 *   OWNER NOTICES  GET  /partner-ops/owner-notices                    Owner
 *                  POST /partner-ops/owner-notices/retry              Owner
 *
 * Three things that are each "money that is not where it should be, and a
 * person has to look":
 *
 *   * a revoked partner's pending card, recharge, sale or sub-agency payout is
 *     HELD — nothing approves, cancels or executes it by itself. Releasing the
 *     hold lets it be decided through its ordinary screen; the marker stays on
 *     the item as history;
 *   * a balance whose Firestore copy is behind the ledger (the ledger is right;
 *     the app shows an old figure until the delta is replayed — once, keyed on
 *     its ledger id, so a repair can never double-credit);
 *   * a §8 money notice that has not reached every other Owner.
 *
 * Each section is offered by the server's own gate (`moneyIntegrityAccess` in
 * `lib/moneyIntegrity.ts`); the server enforces it whatever this page shows,
 * and a refusal is printed as the server wrote it.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, Bell, CheckCircle2, Database, Loader2, Lock, RefreshCw, ShieldCheck, Unlock, X,
} from 'lucide-react'
import api, { ApiError, type HeldItemType } from '@/lib/api'
import { useAuth } from '@/components/AuthProvider'
import { hasPermission } from '@/lib/auth'
import { Denied, Empty, ErrorState, Loading } from '@/components/ui/States'
import {
  HELD_TYPE_LABEL, MIN_RELEASE_REASON, NOTICES_OWNER_ONLY, RELEASE_NEEDS,
  driftRowsFrom, groupIndian, heldRowsFrom, moneyIntegrityAccess, noticeRowsFrom, releaseReasonProblem,
  repairSummaryLine, retrySummaryLine,
  type DriftRow, type HeldRow, type NoticeRow,
} from '@/lib/moneyIntegrity'

function when(ms: number | null): string {
  return ms === null ? 'time not recorded' : new Date(ms).toLocaleString('en-IN')
}

function said(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback
}

/** Where a held item is decided once its hold is lifted. */
const DECIDED_ON: Record<HeldItemType, { href: string; label: string }> = {
  card: { href: '/board', label: 'the money board' },
  recharge: { href: '/recharges', label: 'Recharges' },
  sale: { href: '/sales', label: 'Seller Sales' },
  subagency_payout: { href: '/agencies', label: 'the agency’s payouts' },
}

function partnerHref(kind: string, id: string): string {
  if (!id) return ''
  if (kind === 'host') return `/users/${encodeURIComponent(id)}`
  if (kind === 'seller') return `/sellers/${encodeURIComponent(id)}`
  if (kind === 'agency' || kind === 'sub_agency') return `/agencies/${encodeURIComponent(id)}`
  return ''
}

export default function MoneyIntegrityPage() {
  const { crmUser, apiUser, apiReady, apiError, loading: authLoading } = useAuth()
  const access = moneyIntegrityAccess({
    isOwner: apiUser?.role === 'owner',
    role: apiUser?.role ?? '',
    canProcessPayout: hasPermission(crmUser, 'can_process_payout'),
  })

  if (authLoading) return <Loading label="Checking your access…" />
  if (!access.any) return <Denied what="money integrity (Finance and the Owners)" />
  if (!apiReady && apiError) return <ErrorState message={apiError} />
  if (!apiReady) return <Loading label="Signing in to the business API…" />

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      <div>
        <Link href="/finance" className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-300 text-sm mb-2">
          <ArrowLeft size={14} /> Finance
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-3">
          <ShieldCheck className="text-pink-500" size={26} /> Money integrity
        </h1>
        <p className="text-slate-400 text-sm mt-1 max-w-3xl">
          Money that is not where it should be, and needs a person: items held after a role was revoked,
          balances whose app copy is behind the ledger, and money notices that have not reached every Owner.
          Nothing here moves money by itself.
        </p>
      </div>

      {access.viewHeld && <HeldSection canRelease={access.releaseHeld} />}
      {access.viewDrift && <DriftSection canRepair={access.repairDrift} />}
      {access.viewNotices ? (
        <NoticesSection canRetry={access.retryNotices} />
      ) : (
        <p className="text-slate-600 text-xs">{NOTICES_OWNER_ONLY}</p>
      )}
    </div>
  )
}

// ── Held items ───────────────────────────────────────────────────────────────

function HeldSection({ canRelease }: { canRelease: boolean }) {
  const [rows, setRows] = useState<HeldRow[] | null>(null)
  const [error, setError] = useState('')
  const [includeReleased, setIncludeReleased] = useState(false)
  const [target, setTarget] = useState<HeldRow | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      setRows(heldRowsFrom(await api.moneyIntegrity.heldItems({ includeReleased })))
    } catch (err) {
      setRows(null)
      setError(said(err, 'The held items could not be read.'))
    }
  }, [includeReleased])

  useEffect(() => { void load() }, [load])

  async function release() {
    if (!target) return
    const problem = releaseReasonProblem(reason)
    if (problem) { setFailure(problem); return }
    setBusy(true)
    setFailure('')
    try {
      await api.moneyIntegrity.releaseHeld(target.type, target.id, reason.trim())
      setNotice(
        `Hold released on ${HELD_TYPE_LABEL[target.type].toLowerCase()} “${target.title}”. Nothing was approved, ` +
        `cancelled or executed — decide it on ${DECIDED_ON[target.type].label} now.`,
      )
      setTarget(null)
      await load()
    } catch (err) {
      setFailure(said(err, 'The hold could not be released.'))
    } finally {
      setBusy(false)
    }
  }

  const live = (rows ?? []).filter((r) => !r.released)

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-white font-semibold flex items-center gap-2">
            <Lock size={16} className="text-amber-400" /> Held for review
            {rows && <span className="text-xs font-normal text-slate-500">{live.length} waiting</span>}
          </h2>
          <p className="text-slate-500 text-xs mt-0.5 max-w-2xl">
            When a partner&rsquo;s role is revoked, every pending item of theirs is held here. It is not
            approved, cancelled or executed by anything — Finance or an Owner releases the hold, and the item
            is then decided through its own screen.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-400">
            <input type="checkbox" checked={includeReleased} onChange={(e) => setIncludeReleased(e.target.checked)} />
            Include released
          </label>
          <button onClick={() => void load()} className="text-slate-400 hover:text-white" title="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {notice && (
        <div className="mx-5 mt-4 flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2">
          <p className="text-green-100 text-sm flex items-start gap-2"><CheckCircle2 size={14} className="text-green-400 mt-0.5 shrink-0" /> {notice}</p>
          <button onClick={() => setNotice('')} className="text-green-400/70 hover:text-green-200"><X size={13} /></button>
        </div>
      )}

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <Loading label="Reading the held items…" />
      ) : rows.length === 0 ? (
        <Empty
          title="Nothing is held"
          hint="No revoked partner has a pending item waiting for review. This is the list reporting itself empty, not a read that failed."
          icon={<Lock size={24} />}
        />
      ) : (
        <div className="divide-y divide-slate-800">
          {rows.map((r) => {
            const partner = partnerHref(r.partnerKind, r.partnerId)
            return (
              <div key={`${r.type}:${r.id}`} className={`px-5 py-4 ${r.released ? 'opacity-60' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-white text-sm font-medium">
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 mr-2">{HELD_TYPE_LABEL[r.type]}</span>
                      {r.title}
                    </p>
                    <p className="text-slate-400 text-xs mt-1">{r.detail}</p>
                    <p className="text-slate-500 text-xs mt-1">
                      {r.reason}
                      {r.partnerId && (
                        <>
                          {' — '}{r.partnerKind.replace(/_/g, ' ') || 'partner'}{' '}
                          {partner
                            ? <Link href={partner} className="font-mono text-pink-400 hover:text-pink-300">{r.partnerId}</Link>
                            : <span className="font-mono">{r.partnerId}</span>}
                        </>
                      )}
                      {' · held '}{when(r.heldAtMs)}{r.heldBy ? ` by ${r.heldBy}` : ''}
                    </p>
                    {r.note && <p className="text-slate-400 text-xs mt-0.5">“{r.note}”</p>}
                    {r.released && (
                      <p className="text-green-300/80 text-xs mt-1">
                        Released {when(r.releasedAtMs)}{r.releasedBy ? ` by ${r.releasedBy}` : ''}: {r.releaseReason || 'no reason recorded'}
                      </p>
                    )}
                    <p className="text-slate-600 text-[11px] mt-1 font-mono">{r.type} · {r.id}</p>
                  </div>
                  {!r.released && (
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <button
                        onClick={() => { if (canRelease) { setTarget(r); setReason(''); setFailure('') } }}
                        disabled={!canRelease}
                        title={canRelease ? undefined : RELEASE_NEEDS}
                        className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 rounded-lg px-3 py-1.5 text-xs font-medium"
                      >
                        <Unlock size={12} /> Release the hold…
                      </button>
                      {!canRelease && <span className="text-slate-500 text-[11px] max-w-[14rem] text-right">{RELEASE_NEEDS}</span>}
                      <Link href={DECIDED_ON[r.type].href} className="text-pink-400 hover:text-pink-300 text-[11px]">
                        Decided on {DECIDED_ON[r.type].label}
                      </Link>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {target && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md">
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
              <div className="min-w-0">
                <h3 className="text-white font-semibold">Release this hold</h3>
                <p className="text-slate-500 text-xs mt-0.5 truncate">{HELD_TYPE_LABEL[target.type]} · {target.title}</p>
              </div>
              <button onClick={() => setTarget(null)} className="text-slate-500 hover:text-white shrink-0"><X size={16} /></button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-slate-300 text-sm">
                The item can then be decided through {DECIDED_ON[target.type].label}. Releasing approves nothing,
                cancels nothing and moves no money — and if the partner&rsquo;s money is frozen, the freeze still
                stops it until the Owner releases that too.
              </p>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Why this item may now be decided on its own…"
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
              />
              <p className="text-slate-600 text-xs">At least {MIN_RELEASE_REASON} characters — the note is the record of this decision.</p>
              {failure && (
                <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {failure}
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
              <button onClick={() => setTarget(null)} className="text-slate-400 hover:text-white text-sm px-4 py-2">Cancel</button>
              <button
                onClick={release}
                disabled={busy}
                className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white font-semibold rounded-lg px-5 py-2.5 text-sm"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Unlock size={14} />} Release the hold
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

// ── Replica drift ────────────────────────────────────────────────────────────

function DriftSection({ canRepair }: { canRepair: boolean }) {
  const [rows, setRows] = useState<DriftRow[] | null>(null)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [failure, setFailure] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      setRows(driftRowsFrom(await api.moneyIntegrity.replicaDrift()))
    } catch (err) {
      setRows(null)
      setError(said(err, 'The replica drift could not be read.'))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function repair() {
    setBusy(true)
    setFailure('')
    try {
      setResult(repairSummaryLine(await api.moneyIntegrity.repairReplicaDrift()))
      setConfirming(false)
      await load()
    } catch (err) {
      setFailure(said(err, 'The repair did not run.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-white font-semibold flex items-center gap-2">
            <Database size={16} className="text-sky-400" /> Replica drift
            {rows && <span className="text-xs font-normal text-slate-500">{rows.length} balance{rows.length === 1 ? '' : 's'}</span>}
          </h2>
          <p className="text-slate-500 text-xs mt-0.5 max-w-2xl">
            Balances whose last sync to the app failed. The ledger is right; the app shows an old figure until the
            missing change is replayed. A repair replays each change once, keyed on its ledger entry, so it can never
            credit twice. The sweep tries every 15 minutes; this is the button for &ldquo;the app database is back now&rdquo;.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void load()} className="text-slate-400 hover:text-white" title="Refresh"><RefreshCw size={14} /></button>
          {canRepair && (
            <button
              onClick={() => { setConfirming(true); setFailure('') }}
              disabled={busy || !rows || rows.length === 0}
              className="flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg px-3 py-1.5 text-xs font-semibold"
            >
              <RefreshCw size={12} /> Repair now…
            </button>
          )}
        </div>
      </div>

      {result && (
        <div className="mx-5 mt-4 flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2">
          <p className="text-green-100 text-sm flex items-start gap-2"><CheckCircle2 size={14} className="text-green-400 mt-0.5 shrink-0" /> {result}</p>
          <button onClick={() => setResult('')} className="text-green-400/70 hover:text-green-200"><X size={13} /></button>
        </div>
      )}

      {confirming && (
        <div className="mx-5 mt-4 bg-slate-950/60 border border-slate-700 rounded-lg px-4 py-3 space-y-2">
          <p className="text-slate-200 text-sm">
            Replay every pending change to the app&rsquo;s copy of these balances? Changes that already landed are
            recognised and skipped. The ledger itself is not touched.
          </p>
          {failure && (
            <p className="flex items-start gap-2 text-red-300 text-sm"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> {failure}</p>
          )}
          <div className="flex gap-2">
            <button onClick={() => setConfirming(false)} disabled={busy} className="bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-1.5 text-sm">Cancel</button>
            <button onClick={repair} disabled={busy} className="flex items-center gap-1.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-lg px-3 py-1.5 text-sm font-semibold">
              {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Repair
            </button>
          </div>
        </div>
      )}

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <Loading label="Reading the replica drift…" />
      ) : rows.length === 0 ? (
        <Empty
          title="Every balance is in step"
          hint="No balance's app copy is behind the ledger. This is the list reporting itself empty, not a read that failed."
          icon={<Database size={24} />}
        />
      ) : (
        <div className="divide-y divide-slate-800">
          {rows.map((r) => (
            <div key={r.id} className="px-5 py-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-white text-sm font-mono">{r.holder}</p>
                <p className="text-slate-400 text-xs mt-0.5">
                  Ledger balance {r.ledgerBalance === null ? 'not recorded' : groupIndian(r.ledgerBalance)} {r.currency} ·{' '}
                  {r.pendingCount} change{r.pendingCount === 1 ? '' : 's'} not yet in the app
                  ({r.pendingDelta >= 0 ? '+' : ''}{groupIndian(r.pendingDelta)})
                </p>
                <p className="text-slate-500 text-xs mt-0.5">
                  Out of step since {when(r.staleSinceMs)}
                  {r.lastRepairAtMs !== null ? ` · last repair ${when(r.lastRepairAtMs)}` : ''}
                </p>
                {r.lastError && <p className="text-amber-300 text-xs mt-0.5">Last repair error: {r.lastError}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// ── Owner notices ────────────────────────────────────────────────────────────

function NoticesSection({ canRetry }: { canRetry: boolean }) {
  const [rows, setRows] = useState<NoticeRow[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [failure, setFailure] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      setRows(noticeRowsFrom(await api.moneyIntegrity.ownerNotices()))
    } catch (err) {
      setRows(null)
      setError(said(err, 'The Owner notices could not be read.'))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function retry() {
    setBusy(true)
    setFailure('')
    try {
      setResult(retrySummaryLine(await api.moneyIntegrity.retryOwnerNotices()))
      await load()
    } catch (err) {
      setFailure(said(err, 'The retry did not run.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-white font-semibold flex items-center gap-2">
            <Bell size={16} className="text-pink-400" /> Owner notices not yet delivered
            {rows && <span className="text-xs font-normal text-slate-500">{rows.length} pending</span>}
          </h2>
          <p className="text-slate-500 text-xs mt-0.5 max-w-2xl">
            One Owner may sign and execute money alone (§8) — and every other Owner is then told, in-app and by
            email. These are the notices that have not reached everybody yet. The action itself stands either way;
            the sweep retries every 15 minutes.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void load()} className="text-slate-400 hover:text-white" title="Refresh"><RefreshCw size={14} /></button>
          {canRetry && (
            <button
              onClick={() => void retry()}
              disabled={busy || !rows || rows.length === 0}
              className="flex items-center gap-1.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg px-3 py-1.5 text-xs font-semibold"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Retry now
            </button>
          )}
        </div>
      </div>

      {(result || failure) && (
        <div className={`mx-5 mt-4 flex items-start justify-between gap-3 rounded-lg px-3 py-2 border ${
          failure ? 'bg-red-500/10 border-red-500/30' : 'bg-green-500/10 border-green-500/30'}`}>
          <p className={`text-sm ${failure ? 'text-red-300' : 'text-green-100'}`}>{failure || result}</p>
          <button onClick={() => { setResult(''); setFailure('') }} className="text-slate-400 hover:text-white"><X size={13} /></button>
        </div>
      )}

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows === null ? (
        <Loading label="Reading the Owner notices…" />
      ) : rows.length === 0 ? (
        <Empty
          title="Every Owner has been told"
          hint="No money notice is waiting on a delivery. This is the list reporting itself empty, not a read that failed."
          icon={<Bell size={24} />}
        />
      ) : (
        <div className="divide-y divide-slate-800">
          {rows.map((n) => (
            <div key={n.id} className="px-5 py-3">
              <p className="text-white text-sm font-medium">
                {n.action}
                {n.amount && <span className="text-pink-300 ml-2">{n.amount}</span>}
              </p>
              <p className="text-slate-400 text-xs mt-0.5">
                {n.actor ? `By ${n.actor}` : 'Actor not recorded'} · {when(n.createdAtMs)} · {n.attempts} attempt{n.attempts === 1 ? '' : 's'}
                {n.reference && (
                  <>
                    {' · '}
                    {n.referenceType === 'card'
                      ? <Link href="/board" className="font-mono text-pink-400 hover:text-pink-300">card {n.reference}</Link>
                      : <span className="font-mono">{n.referenceType || 'ref'} {n.reference}</span>}
                  </>
                )}
              </p>
              {n.told.length > 0 && <p className="text-green-300/80 text-xs mt-0.5">Told: {n.told.join(', ')}</p>}
              {n.untold.length > 0 && <p className="text-amber-300 text-xs mt-0.5">Not yet: {n.untold.join(', ')}</p>}
              {n.lastError && <p className="text-red-300/80 text-xs mt-0.5">Last error: {n.lastError}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
