'use client'

/**
 * Recharges — a buyer paid a Coin Seller outside the app; staff verify, the
 * API credits.
 *
 * There is no payment gateway. The buyer pays the seller by UPI, bank
 * transfer, Binance or cash, files the reference and a screenshot from the
 * app, and the request lands here `pending`. Nothing has moved. A reviewer
 * checks the payment against the seller's statement and approves; the API
 * then debits the seller's coins and credits the buyer's diamonds through the
 * ledger, with idempotency keys, so a second click moves nothing twice.
 *
 * What this replaced: the seller's own tap in the Android seller dashboard
 * approving the request and a Cloud Function minting diamonds on it, with no
 * proof, no reference, no verification and no ledger row. That path is shut
 * (`onRechargeApproved` now reverts a client approval).
 *
 * Refunds are their own review. Approving one takes back only what is still
 * in the buyer's live wallet, records the rest as spent, restores the seller's
 * coins by the same amount, and never makes a balance negative. A refund bans
 * nobody; fraud is a separate, human decision on /users.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, CheckCircle2, Coins, ExternalLink, Loader2, RefreshCw, RotateCcw,
  ShieldCheck, XCircle,
} from 'lucide-react'
import { Column, DataTable } from '@/components/ui/DataTable'
import { Denied } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, hasPermission, type CrmRole } from '@/lib/auth'
import { IdentityBlock } from '@/components/ui/Identity'
import { nameOrReference } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'
import { ApiError } from '@/lib/api'
import { recharges as rechargeApi, type Recharge, type RechargeStatus } from '@/lib/apiPartners'

const PAGE_ROLES: CrmRole[] = [
  'superadmin', 'ops_admin', 'ops_member', 'finance_admin', 'finance_member',
]

const MIN_REASON = 3

type Tab = 'pending' | 'approved' | 'refund_pending' | 'rejected' | 'closed' | 'all'

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'pending', label: 'Awaiting verification' },
  { key: 'refund_pending', label: 'Refund review' },
  { key: 'approved', label: 'Credited' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'closed', label: 'Refunded / reversed' },
  { key: 'all', label: 'All' },
]

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending — nothing has moved',
  approving: 'Approving…',
  approved: 'Credited',
  rejected: 'Rejected',
  refund_pending: 'Refund under review',
  refunding: 'Refunding…',
  refunded: 'Refunded in full',
  reversed: 'Partly reversed — rest was spent',
}

const STATUS_TONE: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-300',
  approving: 'bg-amber-500/15 text-amber-300',
  approved: 'bg-green-500/15 text-green-300',
  rejected: 'bg-red-500/15 text-red-300',
  refund_pending: 'bg-blue-500/15 text-blue-300',
  refunding: 'bg-blue-500/15 text-blue-300',
  refunded: 'bg-slate-700 text-slate-300',
  reversed: 'bg-orange-500/15 text-orange-300',
}

type Act = 'approve' | 'reject' | 'refund' | 'refund_yes' | 'refund_no'

const ACT_COPY: Record<Act, { title: string; hint: string; verb: string; tone: string }> = {
  approve: {
    title: 'Payment verified — credit the diamonds',
    hint: 'Confirm the reference or screenshot matches a credit on the seller\'s account. The seller\'s coins are debited and the buyer\'s diamonds credited through the ledger, once. Both are told.',
    verb: 'Verify and credit',
    tone: 'bg-green-600 hover:bg-green-500',
  },
  reject: {
    title: 'Reject this recharge',
    hint: 'Nothing moves. The buyer and the seller are told, with this reason in the buyer\'s words.',
    verb: 'Reject',
    tone: 'bg-red-600 hover:bg-red-500',
  },
  refund: {
    title: 'Open a refund review',
    hint: 'Nothing moves yet. The recharge goes to refund review; approving it there takes back only the diamonds still in the wallet.',
    verb: 'Open review',
    tone: 'bg-blue-600 hover:bg-blue-500',
  },
  refund_yes: {
    title: 'Approve the refund',
    hint: 'Takes back what is still in the buyer\'s live wallet, records anything already spent as unrecoverable, and restores the seller\'s coins by the same amount. The balance never goes negative. Nobody is banned by this.',
    verb: 'Approve refund',
    tone: 'bg-orange-600 hover:bg-orange-500',
  },
  refund_no: {
    title: 'Refuse the refund',
    hint: 'The recharge returns to credited. The buyer is told, with this reason.',
    verb: 'Refuse refund',
    tone: 'bg-slate-600 hover:bg-slate-500',
  },
}

function when(iso?: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function money(minor: number, currency: string): string {
  const major = (minor || 0) / 100
  return currency === 'INR'
    ? `₹${major.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
    : `${major.toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${currency}`
}

export default function RechargesPage() {
  const { crmUser, loading: authLoading } = useAuth()
  const allowed = canAccess(crmUser, PAGE_ROLES)
  const canDecide = hasPermission(crmUser, 'can_coin_operations')
  const isOwner = crmUser?.role === 'superadmin'

  const [tab, setTab] = useState<Tab>('pending')
  const [rows, setRows] = useState<Recharge[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [acting, setActing] = useState<{ act: Act; r: Recharge } | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [actErr, setActErr] = useState('')

  // B1: the buyer is a Firebase uid — named from `users` (staff-readable);
  // email/phone only for a viewer who may read user profiles.
  const showContacts = hasPermission(crmUser, 'can_view_users')
  const buyers = useIdentities({ enabled: allowed, people: rows.map((r) => r.buyer_uid) })

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const status: RechargeStatus | '' =
        tab === 'all' || tab === 'closed' ? '' : (tab as RechargeStatus)
      let data = await rechargeApi.list(status)
      if (tab === 'closed') data = data.filter((r) => r.status === 'refunded' || r.status === 'reversed')
      setRows(data)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Recharges could not be read.')
    } finally {
      setLoading(false)
    }
  }, [tab])

  useEffect(() => { if (allowed) void load() }, [allowed, load])

  async function confirm() {
    if (!acting || reason.trim().length < MIN_REASON) return
    setBusy(true)
    setActErr('')
    try {
      const { act, r } = acting
      const why = reason.trim()
      if (act === 'approve') {
        const out = await rechargeApi.approve(r.id, why)
        setNotice(`Credited ${out.credited_diamonds} diamonds to the buyer. Buyer told: ${out.notified.buyer ? 'yes' : 'no'}; seller told: ${out.notified.seller ? 'yes' : 'no'}.`)
      } else if (act === 'reject') {
        await rechargeApi.reject(r.id, why)
        setNotice('Rejected. Nothing moved; both parties were told.')
      } else if (act === 'refund') {
        await rechargeApi.requestRefund(r.id, why)
        setNotice('Refund review opened. Nothing has moved.')
      } else if (act === 'refund_yes') {
        const out = await rechargeApi.decideRefund(r.id, true, why)
        setNotice(
          out.unrecoverable > 0
            ? `Partly reversed: ${out.taken} diamonds taken back; ${out.unrecoverable} had already been spent and are recorded as unrecoverable. Balance before: ${out.available_before}.`
            : `Refunded in full: ${out.taken} diamonds taken back; the seller's coins were restored.`,
        )
      } else {
        await rechargeApi.decideRefund(r.id, false, why)
        setNotice('Refund refused. The recharge stays credited; the buyer was told.')
      }
      setActing(null)
      setReason('')
      await load()
    } catch (err) {
      setActErr(err instanceof ApiError ? err.message : 'The action could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  const columns = useMemo<Column<Recharge>[]>(() => [
    {
      key: 'created_at', header: 'Filed', sortable: true,
      value: (r) => r.created_at,
      render: (r) => <span className="text-slate-400 text-xs">{when(r.created_at)}</span>,
    },
    {
      key: 'buyer', header: 'Buyer',
      value: (r) => r.buyer_uid,
      render: (r) => (
        <IdentityBlock
          facts={buyers.people.get(r.buyer_uid)}
          id={r.buyer_uid}
          kind="buyer"
          state={buyers.state}
          showContacts={showContacts}
          href={`/users/${r.buyer_uid}`}
          className="text-xs"
        />
      ),
    },
    {
      key: 'seller', header: 'Seller',
      value: (r) => r.seller_name,
      render: (r) => (
        <Link href={`/sellers/${r.seller_id}`} className="text-slate-200 hover:underline text-sm">
          {r.seller_name || r.seller_id}
        </Link>
      ),
    },
    {
      key: 'diamonds', header: 'Diamonds', align: 'right', sortable: true,
      value: (r) => r.diamonds,
      render: (r) => <span className="text-white font-semibold">{r.diamonds.toLocaleString('en-IN')}</span>,
    },
    {
      key: 'amount', header: 'Paid', align: 'right', sortable: true,
      value: (r) => r.amount_minor,
      render: (r) => <span className="text-slate-200">{money(r.amount_minor, r.currency)}</span>,
    },
    {
      key: 'method', header: 'Method · reference', hideOnMobile: true,
      value: (r) => `${r.payment_method} ${r.reference ?? ''}`,
      render: (r) => (
        <span className="text-slate-400 text-xs">
          <span className="uppercase">{r.payment_method}</span>
          {r.reference ? <span className="font-mono"> · {r.reference}</span> : null}
          {r.proof_url ? (
            <a href={r.proof_url} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-0.5 ml-2 text-pink-300 hover:underline">
              proof <ExternalLink size={11} />
            </a>
          ) : null}
        </span>
      ),
    },
    {
      key: 'status', header: 'Status',
      value: (r) => r.status,
      render: (r) => (
        <div className="space-y-0.5">
          <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_TONE[r.status] ?? 'bg-slate-800 text-slate-300'}`}>
            {STATUS_LABEL[r.status] ?? r.status}
          </span>
          {r.status === 'approved' && r.approved_by && (
            <div className="text-slate-500 text-[11px]">by {r.approved_by.name || r.approved_by.uid} · {when(r.approved_at)}</div>
          )}
          {r.shortfall && r.status === 'pending' && (
            <div className="text-amber-300 text-[11px]">Seller held {r.shortfall.available}, needs {r.shortfall.needed}</div>
          )}
          {(r.status === 'refunded' || r.status === 'reversed') && (
            <div className="text-slate-500 text-[11px]">
              {r.refunded_diamonds} taken back{r.unrecoverable_diamonds ? ` · ${r.unrecoverable_diamonds} spent` : ''}
            </div>
          )}
          {r.rejection_reason && <div className="text-slate-500 text-[11px]">{r.rejection_reason}</div>}
        </div>
      ),
    },
    {
      key: 'actions', header: '',
      render: (r) => {
        if (!canDecide) return null
        const btn = 'inline-flex items-center gap-1 text-xs rounded-lg px-2.5 py-1.5 border transition-colors'
        return (
          <div className="flex flex-wrap gap-1.5 justify-end">
            {r.status === 'pending' && isOwner && (
              <button onClick={() => { setActing({ act: 'approve', r }); setReason(''); setActErr('') }}
                className={`${btn} text-green-300 border-green-500/30 bg-green-500/10 hover:bg-green-500/20`}>
                <CheckCircle2 size={13} /> Verify &amp; credit
              </button>
            )}
            {r.status === 'pending' && (
              <button onClick={() => { setActing({ act: 'reject', r }); setReason(''); setActErr('') }}
                className={`${btn} text-red-300 border-red-500/30 bg-red-500/10 hover:bg-red-500/20`}>
                <XCircle size={13} /> Reject
              </button>
            )}
            {r.status === 'approved' && (
              <button onClick={() => { setActing({ act: 'refund', r }); setReason(''); setActErr('') }}
                className={`${btn} text-blue-300 border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20`}>
                <RotateCcw size={13} /> Refund…
              </button>
            )}
            {r.status === 'refund_pending' && isOwner && (
              <>
                <button onClick={() => { setActing({ act: 'refund_yes', r }); setReason(''); setActErr('') }}
                  className={`${btn} text-orange-300 border-orange-500/30 bg-orange-500/10 hover:bg-orange-500/20`}>
                  Approve refund
                </button>
                <button onClick={() => { setActing({ act: 'refund_no', r }); setReason(''); setActErr('') }}
                  className={`${btn} text-slate-300 border-slate-600 bg-slate-800 hover:bg-slate-700`}>
                  Refuse
                </button>
              </>
            )}
          </div>
        )
      },
    },
  ], [canDecide, isOwner, buyers, showContacts])

  if (authLoading) return <div className="p-8 text-slate-400 flex items-center gap-2"><Loader2 className="animate-spin" size={16} /> Loading…</div>
  if (!allowed) return <Denied what="recharges" />

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2">
            <Coins size={20} className="text-pink-400" /> Recharges through Coin Sellers
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            A buyer paid a seller outside the app and filed the proof. Nothing is credited until a
            reviewer verifies the payment here. Approval moves seller coins to buyer diamonds through
            the ledger, once — a second click moves nothing.
          </p>
        </div>
        <button onClick={() => void load()} className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-3 py-2 text-sm">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {!canDecide && (
        <div className="flex items-start gap-2 text-slate-400 text-sm bg-slate-900 border border-slate-800 rounded-xl p-3">
          <ShieldCheck size={15} className="mt-0.5 shrink-0" />
          You can read this queue. Verifying, rejecting and refunding need coin-operations capability; crediting needs an owner.
        </div>
      )}

      {notice && (
        <div className="flex items-start gap-2 text-green-200 text-sm bg-green-500/10 border border-green-500/20 rounded-xl p-3">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0" /> {notice}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`text-sm rounded-lg px-3 py-1.5 border transition-colors ${
              tab === t.key ? 'bg-pink-600 border-pink-500 text-white' : 'bg-slate-900 border-slate-800 text-slate-300 hover:bg-slate-800'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <DataTable<Recharge>
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        onRetry={() => void load()}
        searchPlaceholder="Search buyer, seller, reference…"
        searchKeys={['buyer_uid', 'seller_name', 'seller_id', 'reference', 'id']}
        emptyTitle="Nothing here"
        emptyHint={tab === 'pending' ? 'No recharges are waiting for verification.' : 'No recharges match this view.'}
      />

      {acting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md bg-slate-900 border border-slate-700 rounded-2xl p-5 space-y-4">
            <h3 className="text-white font-semibold">{ACT_COPY[acting.act].title}</h3>
            <div className="text-slate-300 text-sm bg-slate-950/50 border border-slate-800 rounded-lg p-3 space-y-1">
              <div><span className="text-slate-500">Buyer</span> <span className="text-xs">{nameOrReference(buyers.people.get(acting.r.buyer_uid), acting.r.buyer_uid, 'buyer')}</span></div>
              <div><span className="text-slate-500">Seller</span> {acting.r.seller_name}</div>
              <div><span className="text-slate-500">Diamonds</span> {acting.r.diamonds.toLocaleString('en-IN')} · <span className="text-slate-500">Paid</span> {money(acting.r.amount_minor, acting.r.currency)} by <span className="uppercase">{acting.r.payment_method}</span></div>
              {acting.r.reference && <div><span className="text-slate-500">Reference</span> <span className="font-mono text-xs">{acting.r.reference}</span></div>}
              {acting.r.proof_url && (
                <a href={acting.r.proof_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-pink-300 hover:underline text-xs">
                  Open the payment proof <ExternalLink size={11} />
                </a>
              )}
            </div>
            <p className="text-slate-400 text-sm">{ACT_COPY[acting.act].hint}</p>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
              placeholder="Reason — kept on the record, in the audit log, and shown to the buyer on a refusal."
              className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-pink-500" />
            {actErr && (
              <div className="flex items-start gap-2 text-red-300 text-sm"><AlertTriangle size={14} className="mt-0.5 shrink-0" /> {actErr}</div>
            )}
            <div className="flex justify-end gap-2">
              <button onClick={() => setActing(null)} disabled={busy} className="text-sm text-slate-300 px-3 py-2 rounded-lg border border-slate-700">Cancel</button>
              <button onClick={() => void confirm()} disabled={busy || reason.trim().length < MIN_REASON}
                className={`text-sm font-semibold text-white px-4 py-2 rounded-lg disabled:opacity-50 ${ACT_COPY[acting.act].tone}`}>
                {busy ? 'Working…' : ACT_COPY[acting.act].verb}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
