'use client'

/**
 * "Recommend transfer" — on a Host's page and on a Sub-agency's page (GOV C3).
 *
 * A transfer used to happen only as a side effect of revoking an agency with a
 * `transfer_to`, executed by whoever pressed Revoke, with no Owner anywhere in
 * it. Moving a Host or a Sub-agency to another agency is now a REQUEST: a KYC
 * reviewer (or the Owner) recommends it here, with a destination and a reason,
 * and only the Owner decides it on /transfers. Filing one moves nothing.
 *
 * The destination list is the server's rule, applied before it is shown
 * (`transferDestinations` in lib/governanceRequests.ts) — an approved, active
 * main agency for a sub-agency; that or a live sub-agency under a live main
 * agency for a host; never the agency they are already under. The server
 * re-validates everything on filing and again on the Owner's decision.
 *
 *   POST /api/partner-ops/transfers  {kind, subject_id, to_agency_id, note}
 */

import { useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRightLeft, Check, Loader2, X } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { hasPermission } from '@/lib/auth'
import { ApiError } from '@/lib/api'
import { partnerOps, transfers, type Partner } from '@/lib/apiPartners'
import { getAgencyNames } from '@/lib/agencies'
import {
  MIN_NOTE, canRecommendTransfer, transferDestinations, transferRequestProblem,
  type AgencyOption, type TransferKind,
} from '@/lib/governanceRequests'

export function TransferRecommendation({
  kind, subjectId, currentAgencyId, subjectLabel,
}: {
  kind: TransferKind
  /** A Host's uid, or a Sub-agency's partner id. */
  subjectId: string
  /** The agency the subject is under now — never offered as the destination. */
  currentAgencyId: string
  /** Who or what is being moved, for the dialog's heading. */
  subjectLabel: string
}) {
  const { crmUser, apiUser } = useAuth()
  const me = {
    isOwner: apiUser?.role === 'owner',
    permissions: hasPermission(crmUser, 'can_approve_kyc') ? ['can_approve_kyc'] : [],
  }

  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<AgencyOption[] | null>(null)
  const [names, setNames] = useState<Map<string, string>>(() => new Map())
  const [loadError, setLoadError] = useState('')
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const [filed, setFiled] = useState(false)

  // A reviewer who cannot recommend is shown nothing to press: the server
  // would refuse the filing, and the decision itself is the Owner's anyway.
  if (!canRecommendTransfer(me)) return null

  async function start() {
    setOpen(true)
    setFiled(false)
    setFailure('')
    setTo('')
    setNote('')
    if (options !== null) return
    setLoadError('')
    try {
      const [mains, subs] = await Promise.all([
        partnerOps.list({ kind: 'agency', status: 'approved', limit: 500 }),
        kind === 'host'
          ? partnerOps.list({ kind: 'sub_agency', status: 'approved', limit: 500 })
          : Promise.resolve([] as Partner[]),
      ])
      const all: AgencyOption[] = [...mains, ...subs].map((p) => ({
        id: p.id, kind: p.kind, status: p.status, is_active: p.is_active,
        parent_id: p.parent_id ?? null, name: p.name,
      }))
      const eligible = transferDestinations(kind, { id: subjectId, currentAgencyId }, all)
      setOptions(eligible)
      // GOV B20: by the agency document's current name where it can be read;
      // the record's own name otherwise. Never blocks the list.
      getAgencyNames(eligible.map((o) => o.id)).then(({ names: n }) => setNames(n))
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'The agencies could not be read.')
    }
  }

  async function submit() {
    const problem = transferRequestProblem({ toAgencyId: to, note, destinations: options ?? [] })
    if (problem) { setFailure(problem); return }
    setBusy(true)
    setFailure('')
    try {
      await transfers.recommend({ kind, subject_id: subjectId, to_agency_id: to, note: note.trim() })
      setFiled(true)
    } catch (err) {
      // The server's sentence, as written — it names what it refused and why.
      setFailure(err instanceof ApiError ? err.message : 'That did not go through.')
    } finally {
      setBusy(false)
    }
  }

  const label = (o: AgencyOption) => {
    const name = names.get(o.id) || o.name || o.id
    if (o.kind === 'agency') return `${name} (main agency)`
    const parent = names.get(String(o.parent_id ?? '')) || String(o.parent_id ?? '')
    return `${name} (sub-agency${parent ? ` of ${parent}` : ''})`
  }

  return (
    <>
      <button
        onClick={start}
        title="Recommend moving to another agency. The Owner decides."
        className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors"
      >
        <ArrowRightLeft size={14} /> Recommend transfer
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md">
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
              <div className="min-w-0">
                <h2 className="text-white font-semibold">Recommend a transfer</h2>
                <p className="text-slate-500 text-xs mt-0.5 truncate">
                  {kind === 'host' ? 'Host' : 'Sub-agency'} · {subjectLabel}
                </p>
              </div>
              <button onClick={() => setOpen(false)} className="text-slate-500 hover:text-white shrink-0">
                <X size={16} />
              </button>
            </div>

            {filed ? (
              <div className="p-5 space-y-3">
                <p className="flex items-start gap-2 text-green-200 text-sm">
                  <Check size={15} className="text-green-400 mt-0.5 shrink-0" />
                  Recommendation filed. Nothing has moved — the Owner decides it.
                </p>
                <Link href="/transfers" className="text-pink-400 hover:text-pink-300 text-sm underline underline-offset-2">
                  Open Transfer requests
                </Link>
              </div>
            ) : (
              <div className="p-5 space-y-3">
                <p className="text-slate-300 text-sm leading-relaxed">
                  This files a request, it does not move anything. The Owner decides it on
                  Transfer requests; no balance and no ledger entry moves either way.
                </p>

                {loadError ? (
                  <p className="text-amber-300 text-sm">{loadError}</p>
                ) : options === null ? (
                  <p className="text-slate-500 text-sm flex items-center gap-2">
                    <Loader2 size={13} className="animate-spin" /> Reading eligible agencies…
                  </p>
                ) : options.length === 0 ? (
                  <p className="text-amber-200 text-sm">
                    No agency is an eligible destination right now — it must be approved and active
                    {kind === 'host' ? ' (or a sub-agency under a live main agency)' : ' and a main agency'},
                    and not the one {kind === 'host' ? 'they are' : 'it is'} already under.
                  </p>
                ) : (
                  <div>
                    <label className="block text-slate-400 text-xs font-medium mb-1.5">Move to</label>
                    <select
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-pink-500"
                    >
                      <option value="">Choose an agency…</option>
                      {options.map((o) => (
                        <option key={o.id} value={o.id}>{label(o)}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-slate-400 text-xs font-medium mb-1.5">
                    Why <span className="text-pink-400">(required)</span>
                  </label>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                    placeholder="What was asked for, by whom, and why this agency…"
                    className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
                  />
                  <p className="text-slate-600 text-xs mt-1">
                    At least {MIN_NOTE} characters. The Owner reads it; the audit log keeps it.
                  </p>
                </div>

                {failure && (
                  <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {failure}
                  </p>
                )}

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-white text-sm px-4 py-2">
                    Cancel
                  </button>
                  <button
                    onClick={submit}
                    disabled={busy || !options || options.length === 0}
                    className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}
                    File recommendation
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
