'use client'

/**
 * This person's partner-role applications — and the decision, where one is due.
 *
 * ── WHAT REPLACED WHAT ───────────────────────────────────────────────────────
 *
 * The user page used to carry "Grant host" and "Make seller": a role handed
 * out from a user row, with no application, no documents and no agency
 * relationship behind it. Those buttons are gone and the routes behind them
 * refuse. A Host, an Agency, a Sub-agency and a Coin Seller all arrive the
 * same way now — the person applies (from the app, or an agency invites a
 * host), the application is pending, a reviewer decides.
 *
 * So what this page shows instead is the applications themselves. A PENDING
 * one gets Review (the full record and its documents, on the screen that owns
 * it), Approve and Reject with a mandatory reason. Everything else is history
 * with its outcome and reason.
 *
 * ── ONE DECISION PATH ────────────────────────────────────────────────────────
 *
 * Approve and Reject here call `decideReviewItem`, the same function /kyc and
 * /approvals call, which calls the same server routes. This panel is a third
 * door onto one decision, not a third implementation of it. The reviewer still
 * cannot approve without the capability the server checks.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Building2, CheckCircle2, ChevronRight, Loader2, Star, Store, XCircle,
} from 'lucide-react'
import { partnerOps, type PartnerApplicationRow } from '@/lib/apiPartners'
import { ApiError } from '@/lib/api'
import { decideReviewItem } from '@/lib/reviewDecisions'
import type { Item } from '@/lib/reviewQueues'
import { useAuth } from '@/components/AuthProvider'
import { hasPermission } from '@/lib/auth'
import { nameOrReference, referenceOf } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'

const MIN_REASON = 3

const KIND_LABEL: Record<PartnerApplicationRow['kind'], string> = {
  agency: 'Agency',
  sub_agency: 'Sub-agency',
  seller: 'Coin Seller',
  host: 'Host',
}

const STATUS_TONE: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  approved: 'bg-green-500/15 text-green-300 border-green-500/30',
  rejected: 'bg-red-500/15 text-red-300 border-red-500/30',
  suspended: 'bg-slate-700 text-slate-300 border-slate-600',
  revoked: 'bg-red-900/30 text-red-400 border-red-900/50',
}

function reviewHref(row: PartnerApplicationRow, uid: string): string {
  switch (row.kind) {
    case 'seller': return `/sellers/${encodeURIComponent(row.id)}`
    case 'host': return `/kyc?category=host&q=${encodeURIComponent(uid)}`
    default: return `/agencies/${encodeURIComponent(row.id)}`
  }
}

/** The minimal review-queue item `decideReviewItem` needs to route the call. */
function asItem(row: PartnerApplicationRow): Item {
  const linkage = row.kind === 'host' ? 'host' : 'partner'
  return {
    id: row.id,
    category:
      row.kind === 'host' ? 'host'
        : row.kind === 'seller' ? 'coin_seller'
          : row.kind === 'sub_agency' ? 'sub_agency' : 'main_agency',
    linkage,
    name: row.name,
  } as unknown as Item
}

export default function PartnerApplications({ uid, onChanged }: { uid: string; onChanged?: () => void }) {
  const { crmUser } = useAuth()
  const [rows, setRows] = useState<PartnerApplicationRow[] | null>(null)
  const [error, setError] = useState('')
  const [deciding, setDeciding] = useState<{ row: PartnerApplicationRow; approve: boolean } | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState('')

  const canDecide =
    hasPermission(crmUser, 'can_approve_kyc') || hasPermission(crmUser, 'can_approve_seller')

  // B1: `parent_id` is the parent agency's record id — named from `agencies`.
  const parents = useIdentities({ partners: (rows ?? []).map((r) => r.parent_id ?? '') })

  const load = useCallback(async () => {
    setError('')
    try {
      setRows(await partnerOps.applicationsOf(uid))
    } catch (err) {
      setRows([])
      setError(err instanceof ApiError ? err.message : 'Applications could not be read.')
    }
  }, [uid])

  useEffect(() => { void load() }, [load])

  async function submit() {
    if (!deciding || reason.trim().length < MIN_REASON) return
    setBusy(true)
    setOutcome('')
    try {
      const note = await decideReviewItem(
        asItem(deciding.row), deciding.approve ? 'approve' : 'reject', reason.trim(),
      )
      setOutcome(
        `${KIND_LABEL[deciding.row.kind]} application ${deciding.approve ? 'approved' : 'rejected'}. ` +
        'The applicant has been told.' + (note ? ` ${note}` : ''),
      )
      setDeciding(null)
      setReason('')
      await load()
      onChanged?.()
    } catch (err) {
      setOutcome(err instanceof ApiError ? err.message : 'The decision could not be recorded.')
    } finally {
      setBusy(false)
    }
  }

  if (rows === null) {
    return (
      <div className="flex items-center gap-2 text-slate-500 text-sm py-3">
        <Loader2 className="w-4 h-4 animate-spin" /> Reading partner applications…
      </div>
    )
  }
  if (error) {
    return (
      <div className="flex items-start gap-2 text-amber-300 text-sm bg-amber-500/10 border border-amber-500/20 rounded-xl p-3">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>Partner applications could not be read: {error}</span>
      </div>
    )
  }
  if (rows.length === 0) return null

  const pending = rows.filter((r) => r.status === 'pending')
  const history = rows.filter((r) => r.status !== 'pending')

  return (
    <section className="bg-slate-900/60 border border-slate-800 rounded-2xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-white font-semibold text-sm">Partner roles</h3>
        <span className="text-slate-500 text-xs">
          {pending.length > 0 ? `${pending.length} awaiting a decision` : 'No pending applications'}
        </span>
      </div>

      {outcome && (
        <div className="text-xs text-slate-300 bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2">
          {outcome}
        </div>
      )}

      {[...pending, ...history].map((row) => {
        const Icon = row.kind === 'host' ? Star : row.kind === 'seller' ? Store : Building2
        const tone = STATUS_TONE[row.status] ?? 'bg-slate-800 text-slate-300 border-slate-700'
        return (
          <div key={`${row.kind}:${row.id}`} className="flex flex-wrap items-center gap-3 bg-slate-950/40 border border-slate-800 rounded-xl px-3 py-2.5">
            <Icon className="w-4 h-4 text-slate-400 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-white text-sm font-medium truncate">
                {KIND_LABEL[row.kind]}{row.name ? ` · ${row.name}` : ''}
              </div>
              <div className="text-slate-500 text-xs truncate">
                {row.parent_id ? `under ${nameOrReference(parents.partners.get(row.parent_id), row.parent_id, 'agency')} · ` : ''}{referenceOf('partner', row.id)}
                {row.rejection_reason ? ` · Reason: ${row.rejection_reason}` : ''}
                {row.revocation_reason ? ` · Revoked: ${row.revocation_reason}` : ''}
              </div>
            </div>
            <span className={`text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${tone}`}>
              {row.status}
            </span>
            <Link
              href={reviewHref(row, uid)}
              className="inline-flex items-center gap-1 text-xs text-slate-300 hover:text-white border border-slate-700 rounded-lg px-2.5 py-1.5"
            >
              Review <ChevronRight className="w-3.5 h-3.5" />
            </Link>
            {row.status === 'pending' && canDecide && (
              <>
                <button
                  type="button"
                  onClick={() => { setDeciding({ row, approve: true }); setReason(''); setOutcome('') }}
                  className="inline-flex items-center gap-1 text-xs text-green-300 border border-green-500/30 bg-green-500/10 hover:bg-green-500/20 rounded-lg px-2.5 py-1.5"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                </button>
                <button
                  type="button"
                  onClick={() => { setDeciding({ row, approve: false }); setReason(''); setOutcome('') }}
                  className="inline-flex items-center gap-1 text-xs text-red-300 border border-red-500/30 bg-red-500/10 hover:bg-red-500/20 rounded-lg px-2.5 py-1.5"
                >
                  <XCircle className="w-3.5 h-3.5" /> Reject
                </button>
              </>
            )}
          </div>
        )
      })}

      {deciding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-5 space-y-4">
            <h4 className="text-white font-semibold">
              {deciding.approve ? 'Approve' : 'Reject'} {KIND_LABEL[deciding.row.kind]} application
            </h4>
            <p className="text-slate-400 text-sm">
              {deciding.approve
                ? 'The role is provisioned, the applicant is told, and their session is refreshed with the new capability. Confirm you have reviewed the submitted details and documents.'
                : 'Nothing is provisioned. The applicant is told, with the reason below in their words. They may apply again.'}
            </p>
            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5">
                Reason <span className="text-pink-400">(required, shown to the applicant on rejection)</span>
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-pink-500"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDeciding(null)} disabled={busy}
                className="text-sm text-slate-300 px-3 py-2 rounded-lg border border-slate-700">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || reason.trim().length < MIN_REASON}
                className={`text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-50 ${
                  deciding.approve ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}
              >
                {busy ? 'Working…' : deciding.approve ? 'Approve' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
