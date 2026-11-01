'use client'

/**
 * Transfer requests — moving a Host or a Sub-agency to another agency
 * (GOV C3 / B10).
 *
 * A transfer used to happen only as a side effect of revoking an agency with a
 * `transfer_to`, executed by whoever pressed Revoke: no Owner approval, no
 * Owner notice, no transfer on its own and no way back. Now a KYC reviewer (or
 * the Owner) RECOMMENDS one — from the Host's page or the Sub-agency's page —
 * and only the Owner DECIDES it here. Approving re-validates both ends and runs
 * the existing move; no balance and no ledger row moves.
 *
 *   GET  /api/partner-ops/transfers?status=open|all
 *   POST /api/partner-ops/transfers/{id}/decide   {approve, note} — Owner only
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, ArrowRightLeft, Check, Clock, Gavel, Loader2, ShieldCheck, X,
} from 'lucide-react'
import { ApiError } from '@/lib/api'
import { transfers, type TransferRequest } from '@/lib/apiPartners'
import { getAgencyNames } from '@/lib/agencies'
import {
  MIN_NOTE, OWNER_DECIDES_TRANSFER,
  noteProblem, presentTransferStatus, transferIsOpen,
} from '@/lib/governanceRequests'
import { Denied, Empty, ErrorState, Loading } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, hasPermission, type CrmRole } from '@/lib/auth'
import { IdentityInline } from '@/components/ui/Identity'
import { nameOrReference, referenceOf } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'

/** `can_approve_kyc` holders and the Owner — the server's audience for the list. */
const VIEW_ROLES: CrmRole[] = ['superadmin', 'ops_admin']

type Tab = 'open' | 'all'

function age(iso: string | null | undefined): string {
  if (!iso) return 'age unknown'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'age unknown'
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 60) return `${Math.max(mins, 0)}m`
  const hrs = Math.floor(mins / 60)
  return hrs < 24 ? `${hrs}h` : `${Math.floor(hrs / 24)}d`
}

export default function TransfersPage() {
  const { crmUser, apiUser, loading: authLoading } = useAuth()
  const isOwner = apiUser?.role === 'owner'
  const canView = canAccess(crmUser, VIEW_ROLES) || isOwner

  const [tab, setTab] = useState<Tab>('open')
  const [rows, setRows] = useState<TransferRequest[]>([])
  const [names, setNames] = useState<Map<string, string>>(() => new Map())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [target, setTarget] = useState<TransferRequest | null>(null)
  const [approve, setApprove] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const list = await transfers.list(tab)
      setRows(list)
      // GOV B20: agencies by their current name, where it can be read. The ids
      // stay on screen either way.
      const ids = list.flatMap((t) => [t.from_agency_id, t.to_agency_id, t.kind === 'sub_agency' ? t.subject_id : ''])
      getAgencyNames(ids.filter((x): x is string => typeof x === 'string' && x !== ''))
        .then(({ names: n }) => setNames(n))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the transfer requests.')
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => {
    if (!canView) return
    load()
  }, [canView, load])

  function open(t: TransferRequest) {
    setTarget(t)
    setApprove(true)
    setNote('')
    setFailure('')
  }

  async function submit() {
    if (!target) return
    const problem = noteProblem(note)
    if (problem) { setFailure(problem); return }
    setBusy(true)
    setFailure('')
    try {
      await transfers.decide(target.id, approve, note.trim())
      setNotice(approve
        ? 'Approved: the move has been carried out. No balance or ledger entry moved.'
        : 'Rejected: nothing was moved.')
      setTarget(null)
      await load()
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : 'That did not go through.')
    } finally {
      setBusy(false)
    }
  }

  const agencyCell = (id: string | null | undefined) => {
    const v = (id ?? '').trim()
    if (!v) return <span className="text-slate-600">—</span>
    return (
      <Link href={`/agencies/${v}`} className="text-slate-200 hover:text-pink-400" title={v}>
        {names.get(v) || <span className="font-mono">{v}</span>}
      </Link>
    )
  }

  // B1: a Host subject is a Firebase uid — named from `users` (staff-readable);
  // contacts only for a viewer who may read user profiles.
  const showContacts = hasPermission(crmUser, 'can_view_users')
  const hosts = useIdentities({
    enabled: canView && !loading,
    people: rows.filter((t) => t.kind === 'host').map((t) => t.subject_id),
  })

  if (authLoading) return <Loading label="Checking your access…" />
  if (!canView) return <Denied what="transfer requests" />

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <ArrowRightLeft size={26} className="text-pink-500" />
            Transfer requests
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Moving a Host or a Sub-agency to another agency. Reviewers recommend one
            from the Host&rsquo;s or the Sub-agency&rsquo;s page; only the Owner decides.
            Approving moves the role — never a balance or a ledger entry.
          </p>
        </div>
      </div>

      {notice && (
        <div className="mb-4 flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3">
          <p className="text-green-100 text-sm flex items-start gap-2">
            <Check size={15} className="text-green-400 mt-0.5 shrink-0" /> {notice}
          </p>
          <button onClick={() => setNotice('')} className="text-green-400/70 hover:text-green-200">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex gap-1 border-b border-slate-800 mb-5">
        {([['open', 'Open'], ['all', 'All']] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === key ? 'border-pink-500 text-pink-400' : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <Loading label="Reading the transfer requests…" />
      ) : error ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <ErrorState message={error} onRetry={load} />
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <Empty
            title={tab === 'open' ? 'No transfer is waiting' : 'No transfer request yet'}
            hint={
              tab === 'open'
                ? 'Every recommended transfer has been decided. This is the queue reporting itself empty, not a read that failed.'
                : 'Recommend one with "Recommend transfer" on a Host\'s page or a Sub-agency\'s page.'
            }
            icon={<ShieldCheck size={26} />}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((t) => {
            const status = presentTransferStatus(t.status)
            const openNow = transferIsOpen(t.status)
            return (
              <div key={t.id || `${t.kind}:${t.subject_id}`} className="bg-slate-900 border border-slate-800 rounded-xl p-5">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                  <div className="min-w-0">
                    <p className="text-white font-semibold">
                      {t.kind === 'host' ? 'Host' : 'Sub-agency'} ·{' '}
                      {t.kind === 'host' ? (
                        <IdentityInline
                          facts={hosts.people.get(t.subject_id)}
                          id={t.subject_id}
                          kind="host"
                          state={hosts.state}
                          showContacts={showContacts}
                          href={`/users/${t.subject_id}`}
                        />
                      ) : (
                        <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
                          <Link href={`/agencies/${t.subject_id}`} className="text-pink-400 hover:text-pink-300">
                            {names.get(t.subject_id) || <span className="italic text-slate-400">Name unavailable</span>}
                          </Link>
                          <span className="text-slate-500 text-xs font-mono">{referenceOf('partner', t.subject_id)}</span>
                        </span>
                      )}
                    </p>
                    <p className="text-slate-400 text-sm mt-1 flex flex-wrap items-center gap-1.5">
                      {agencyCell(t.from_agency_id)}
                      <ArrowRight size={13} className="text-slate-500" />
                      {agencyCell(t.to_agency_id)}
                    </p>
                    <p className="text-slate-500 text-xs mt-1">
                      Recommended by {t.requested_by?.name || t.requested_by?.role || 'staff'}
                      {t.requested_by?.uid ? <> · <span className="font-mono">{t.requested_by.uid}</span></> : null}
                      {t.id ? <> · request <span className="font-mono">{t.id}</span></> : null}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <span className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-slate-800 text-slate-400">
                      <Clock size={11} /> {age(t.requested_at)}
                    </span>
                    <span className={`text-xs px-2 py-1 rounded border ${status.tone}`}>{status.label}</span>
                  </div>
                </div>

                <p className="text-slate-200 text-sm bg-slate-950 border border-slate-800 rounded-lg px-3 py-2.5 whitespace-pre-wrap">
                  {t.note || 'No reason was given.'}
                </p>

                {t.decision && (
                  <p className="text-slate-400 text-sm mt-3 border-t border-slate-800 pt-3">
                    <span className="text-slate-500">The Owner decided:</span>{' '}
                    {t.decision.note || '—'}
                  </p>
                )}

                {openNow && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {isOwner ? (
                      <button
                        onClick={() => open(t)}
                        className="flex items-center gap-1.5 bg-pink-500 hover:bg-pink-600 text-white font-medium rounded-lg px-4 py-2 text-sm transition-colors"
                      >
                        <Gavel size={14} /> Decide
                      </button>
                    ) : (
                      <span className="text-slate-500 text-xs">{OWNER_DECIDES_TRANSFER}</span>
                    )}
                  </div>
                )}
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
                <h2 className="text-white font-semibold">Decide this transfer</h2>
                <p className="text-slate-500 text-xs mt-0.5 truncate">
                  {target.kind === 'host'
                    ? `Host · ${nameOrReference(hosts.people.get(target.subject_id), target.subject_id, 'host')}`
                    : `Sub-agency · ${names.get(target.subject_id) ? `${names.get(target.subject_id)} (${referenceOf('partner', target.subject_id)})` : referenceOf('partner', target.subject_id)}`}
                </p>
              </div>
              <button onClick={() => setTarget(null)} className="text-slate-500 hover:text-white shrink-0">
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setApprove(true)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    approve
                      ? 'bg-green-500/10 border-green-500/40 text-green-300'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  Approve the move
                </button>
                <button
                  onClick={() => setApprove(false)}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    !approve
                      ? 'bg-slate-700/40 border-slate-600 text-slate-100'
                      : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  Reject
                </button>
              </div>

              <p className="text-slate-300 text-sm leading-relaxed">
                {approve
                  ? 'Both ends are re-checked, then the move is carried out with the existing helper and the partner is told. No balance and no ledger entry moves.'
                  : 'Nothing moves. The request is kept, with your note.'}
              </p>

              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5">
                  Note <span className="text-pink-400">(required)</span>
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={4}
                  autoFocus
                  placeholder="Why this move is (or is not) right…"
                  className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
                />
                <p className="text-slate-600 text-xs mt-1">At least {MIN_NOTE} characters. Stored in the audit log.</p>
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
                  approve ? 'bg-green-600 hover:bg-green-500' : 'bg-slate-600 hover:bg-slate-500'
                }`}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Gavel size={14} />}
                {approve ? 'Approve' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
