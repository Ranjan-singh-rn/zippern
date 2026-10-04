'use client'

/**
 * Reports filed against this agency's hosts, and the way to contest one.
 *
 * ── WHY AN AGENCY GETS THIS AT ALL ───────────────────────────────────────────
 *
 * An agency is the most likely source of a correction to a bad report. It
 * knows the context the reviewer does not — that the "scam" was a gift the
 * viewer regretted afterwards, that the person described is a different host
 * with a similar name, that the account was with someone else that evening.
 * It is also the one party with both an interest in the host being treated
 * fairly and the standing to say so.
 *
 * It could see none of this before. A host would be warned, suspended or
 * banned, their earnings would stop, and their agency would find out by
 * noticing the beans had gone quiet.
 *
 * ── WHAT IT CANNOT DO ────────────────────────────────────────────────────────
 *
 * Decide anything. Raising an appeal writes a `pendingChanges`-shaped document
 * that only the server can move — `firestore.rules` refuses every update to an
 * appeal from a browser. The agency states its case; staff decide it; the
 * reviewer who made the original decision is barred from deciding the appeal
 * against it.
 *
 * And it sees reports about ITS OWN hosts only. That is enforced on the server
 * (`own_partner_id_or_403`), not here — this screen could ask for another
 * agency's id and would be refused.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Flag, Loader2, RefreshCw, Scale, X,
} from 'lucide-react'
import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { ApiError, type UserReport } from '@/lib/api'
import { statements } from '@/lib/apiPartners'
import { UnavailablePanel } from '@/components/ui/States'
import { attempt, type ReadResult } from '@/lib/readState'

const MIN_STATEMENT = 20

/** A report as the agency reads it — the outcome matters more than the claim. */
function outcomeOf(r: UserReport): string {
  switch (r.actionTaken) {
    case 'ban': return 'Banned'
    case 'suspend': return 'Suspended'
    case 'warn': return 'Warned'
    case 'deduct': return 'Beans deducted'
    case 'dismiss': return 'Dismissed — nothing happened'
    default: return r.status === 'pending' ? 'Waiting on a reviewer' : 'Decided'
  }
}

function toneOf(r: UserReport): string {
  if (r.status === 'pending') return 'bg-yellow-500/10 text-yellow-300 border-yellow-500/30'
  if (r.actionTaken === 'dismiss') return 'bg-slate-700 text-slate-300 border-slate-600'
  return 'bg-red-500/10 text-red-300 border-red-500/30'
}

function whenOf(value: unknown): string {
  if (!value) return '—'
  const ms =
    typeof value === 'string'
      ? Date.parse(value)
      : (value as { seconds?: number }).seconds
        ? (value as { seconds: number }).seconds * 1000
        : NaN
  return Number.isNaN(ms) ? '—' : new Date(ms).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

export default function HostReports({
  agencyId,
  actor,
}: {
  /** This agency's record id. `me` for an external partner session. */
  agencyId: string
  /** Who is raising the appeal — the signed-in agency CRM user. */
  actor: { uid: string; name: string }
}) {
  const [reports, setReports] = useState<ReadResult<UserReport[]> | null>(null)
  const [contesting, setContesting] = useState<UserReport | null>(null)
  const [statement, setStatement] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState('')

  const load = useCallback(async () => {
    if (!agencyId) return
    setReports(await attempt(statements.agencyHostReports(agencyId), 'agency host reports'))
  }, [agencyId])

  useEffect(() => { load() }, [load])

  async function raiseAppeal() {
    if (!contesting) return
    const text = statement.trim()
    if (text.length < MIN_STATEMENT) {
      setError(
        `Say what actually happened, in at least ${MIN_STATEMENT} characters. ` +
        'A reviewer reads this beside the original report.',
      )
      return
    }
    setBusy(true)
    setError('')
    try {
      // The key set must match `appealFields()` in firestore.rules exactly —
      // the rule uses `hasOnly`, so one extra key refuses the whole write.
      await addDoc(collection(db, 'appeals'), {
        subjectUid: contesting.targetUid ?? '',
        subjectName: contesting.targetName ?? '',
        raisedByUid: actor.uid,
        raisedByName: actor.name,
        raisedByRole: 'agency',
        agencyId,
        kind: 'report',
        reportId: contesting.id,
        statement: text,
        evidenceUrls: [],
        status: 'pending',
        createdAt: serverTimestamp(),
        // So the server can stop the reviewer who decided this report from
        // also deciding the appeal against it.
        originalDecidedBy: contesting.reviewedBy ?? '',
      })
      setSent(contesting.targetName || contesting.targetUid || 'that host')
      setContesting(null)
      setStatement('')
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'The appeal could not be sent.',
      )
    } finally {
      setBusy(false)
    }
  }

  // Nothing to show and nothing failed — say nothing rather than render an
  // empty panel headed "Reports" on a dashboard that has none.
  if (reports?.ok && reports.value.length === 0) return null

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mb-8">
      <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
        <div>
          <h2 className="text-white font-semibold flex items-center gap-2">
            <Flag size={17} className="text-amber-400" /> Reports about your hosts
          </h2>
          <p className="text-slate-500 text-xs mt-0.5 max-w-xl">
            What users have reported, and what was decided. If a decision is
            wrong, say so — you usually know the context the reviewer does not.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {sent && (
        <div className="mx-6 mt-4 flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3">
          <p className="text-green-200 text-sm flex items-start gap-2">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
            Your appeal about {sent} has been sent. A reviewer who was not
            involved in the original decision will look at it.
          </p>
          <button onClick={() => setSent('')} className="text-green-400/70 hover:text-green-200 shrink-0">
            <X size={15} />
          </button>
        </div>
      )}

      {reports === null ? (
        <div className="px-6 py-8 flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 size={15} className="animate-spin" /> Reading reports…
        </div>
      ) : !reports.ok ? (
        <UnavailablePanel failure={reports} what="Reports about your hosts" onRetry={load} />
      ) : (
        <div className="divide-y divide-slate-800/60">
          {reports.value.map((r) => (
            <div key={r.id} className="px-6 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium truncate">
                    {r.targetName || r.targetUid}
                  </p>
                  <p className="text-slate-400 text-xs mt-0.5">
                    Reported {whenOf(r.createdAt)}
                    {r.reason ? ` · “${r.reason}”` : ''}
                  </p>
                  {r.reviewReason && (
                    <p className="text-slate-500 text-xs mt-1">
                      Reviewer said: {r.reviewReason}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs px-2 py-1 rounded border ${toneOf(r)}`}>
                    {outcomeOf(r)}
                  </span>
                  {/* A pending report has no decision to contest yet, and a
                      dismissed one has nothing to correct. */}
                  {r.status !== 'pending' && r.actionTaken !== 'dismiss' && (
                    <button
                      onClick={() => { setContesting(r); setStatement(''); setError('') }}
                      className="flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
                    >
                      <Scale size={12} /> Contest this
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {contesting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md">
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
              <div className="min-w-0">
                <h3 className="text-white font-semibold">Contest this decision</h3>
                <p className="text-slate-500 text-xs mt-0.5 truncate">
                  {contesting.targetName || contesting.targetUid} · {outcomeOf(contesting)}
                </p>
              </div>
              <button onClick={() => setContesting(null)} className="text-slate-500 hover:text-white shrink-0">
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-3">
              <p className="text-slate-400 text-sm">
                A reviewer who had no part in the original decision will read
                this next to the report. Say what actually happened — dates,
                who was involved, anything that contradicts the claim.
              </p>
              <textarea
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
                rows={5}
                autoFocus
                placeholder="What actually happened…"
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
              />
              {error && (
                <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
                </p>
              )}
              <p className="text-slate-600 text-xs">
                Contesting does not undo anything by itself, and it does not put
                your host back online while it is looked at.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
              <button onClick={() => setContesting(null)} className="text-slate-400 hover:text-white text-sm px-4 py-2">
                Cancel
              </button>
              <button
                onClick={raiseAppeal}
                disabled={busy}
                className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Scale size={14} />}
                Send appeal
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
