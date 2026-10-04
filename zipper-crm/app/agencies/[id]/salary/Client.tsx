'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  ArrowLeft, Loader2, CheckCircle2, XCircle, DollarSign, Clock, Banknote,
  ChevronDown, Users, Shield,
} from 'lucide-react'
import {
  collection, query, where, getDocs, doc, updateDoc, serverTimestamp, orderBy, getDoc,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { Timestamp } from 'firebase/firestore'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SalaryRequest {
  id: string
  agencyId: string
  hostUid: string
  hostName: string
  periodStart: string
  periodEnd: string
  beansEarned: number
  amountInr: number
  notes?: string
  status: 'pending' | 'approved' | 'paid' | 'distributed' | 'rejected'
  createdAt?: Timestamp
  approvedAt?: Timestamp
  paidAt?: Timestamp
  distributedAt?: Timestamp
  utrNumber?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(ts?: Timestamp | null) {
  if (!ts) return '—'
  try { return ts.toDate().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) }
  catch { return '—' }
}

function fmtInr(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

function StatusBadge({ status }: { status: SalaryRequest['status'] }) {
  const map = {
    pending:     'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
    approved:    'bg-blue-500/20 text-blue-400 border border-blue-500/30',
    paid:        'bg-green-500/20 text-green-400 border border-green-500/30',
    distributed: 'bg-purple-500/20 text-purple-400 border border-purple-500/30',
    // Its own colour, and not a green or a purple one. A refused request used
    // to be written as `distributed` and therefore rendered as a success.
    rejected:    'bg-red-500/20 text-red-400 border border-red-500/30',
  }
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${map[status]}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function SalaryManagementClient() {
  const rawParams = useParams() as { id: string }
  const agencyId = (typeof window !== 'undefined'
    ? window.location.pathname.split('/').filter(Boolean)[1] ?? rawParams.id
    : rawParams.id) || rawParams.id

  const { crmUser } = useAuth()
  const isAdminOrAbove = crmUser ? canAccess(crmUser, ['finance_admin', 'superadmin']) : false
  const hasPageAccess = crmUser ? canAccess(crmUser, ['superadmin', 'app_admin']) : false

  const [agencyName, setAgencyName] = useState('')
  const [requests, setRequests] = useState<SalaryRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | SalaryRequest['status']>('all')
  const [actionId, setActionId] = useState<string | null>(null)
  const [showPayModal, setShowPayModal] = useState<SalaryRequest | null>(null)
  const [utr, setUtr] = useState('')
  const [payErr, setPayErr] = useState('')
  const [paySaving, setPaySaving] = useState(false)
  const [loadError, setLoadError] = useState('')

  async function loadData() {
    if (!agencyId || agencyId === '_') return
    if (!crmUser || !canAccess(crmUser, ['superadmin', 'app_admin'])) return
    try {
      const agSnap = await getDoc(doc(db, 'agencies', agencyId))
      if (agSnap.exists()) setAgencyName(agSnap.data().agencyName ?? '')

      const q = query(
        collection(db, 'salaryRequests'),
        where('agencyId', '==', agencyId),
        orderBy('createdAt', 'desc'),
      )
      const snap = await getDocs(q)
      setRequests(snap.docs.map(d => ({ id: d.id, ...d.data() } as SalaryRequest)))
    } catch (e) {
      console.error(e)
      setLoadError('Failed to load salary requests. Please try again.')
    }
    finally { setLoading(false) }
  }

  useEffect(() => { loadData() }, [agencyId, crmUser])

  async function handleApprove(req: SalaryRequest) {
    setActionId(req.id)
    try {
      await updateDoc(doc(db, 'salaryRequests', req.id), {
        status: 'approved', approvedAt: serverTimestamp(),
      })
      setRequests(prev => prev.map(r => r.id === req.id ? { ...r, status: 'approved' } : r))
    } catch (e) { console.error(e) }
    finally { setActionId(null) }
  }

  async function handleMarkPaid() {
    if (!showPayModal) return
    if (!utr.trim()) { setPayErr('Enter UTR / transaction reference.'); return }
    setPaySaving(true); setPayErr('')
    try {
      await updateDoc(doc(db, 'salaryRequests', showPayModal.id), {
        status: 'paid', paidAt: serverTimestamp(), utrNumber: utr.trim(),
      })
      setRequests(prev => prev.map(r =>
        r.id === showPayModal.id ? { ...r, status: 'paid', utrNumber: utr.trim() } : r
      ))
      setShowPayModal(null); setUtr('')
    } catch (e: any) { setPayErr(e.message ?? 'Failed.') }
    finally { setPaySaving(false) }
  }

  async function handleReject(req: SalaryRequest) {
    setActionId(req.id + '-reject')
    try {
      /*
       * `rejected`, not `distributed`.
       *
       * This wrote `distributed` — the same value a SUCCESSFULLY PAID AND
       * PASSED-ON request ends at — so a refusal was indistinguishable from a
       * completed payment on every screen and in every count. An agency chasing
       * "why was my host not paid" saw the request sitting in the same state as
       * the ones that were.
       *
       * The value is already in the type union (`AgencySalaryRequest.status`),
       * and the filter tabs below count it; nothing needed widening.
       */
      await updateDoc(doc(db, 'salaryRequests', req.id), { status: 'rejected' })
      setRequests(prev => prev.map(r => r.id === req.id ? { ...r, status: 'rejected' } : r))
    } catch (e) { console.error(e) }
    finally { setActionId(null) }
  }

  const filtered = filter === 'all' ? requests : requests.filter(r => r.status === filter)
  const counts = {
    all: requests.length,
    pending: requests.filter(r => r.status === 'pending').length,
    approved: requests.filter(r => r.status === 'approved').length,
    paid: requests.filter(r => r.status === 'paid').length,
    distributed: requests.filter(r => r.status === 'distributed').length,
  }

  const totalPending = requests.filter(r => r.status === 'pending').reduce((s, r) => s + r.amountInr, 0)
  const totalApproved = requests.filter(r => r.status === 'approved').reduce((s, r) => s + r.amountInr, 0)
  const totalPaid = requests.filter(r => r.status === 'paid' || r.status === 'distributed').reduce((s, r) => s + r.amountInr, 0)

  if (!hasPageAccess) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Shield size={48} className="text-slate-600" />
        <h1 className="text-white text-2xl font-bold">Access Denied</h1>
        <p className="text-slate-400 text-sm">You do not have permission to view this page.</p>
      </div>
    )
  }

  if (loading) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Loader2 size={32} className="animate-spin text-pink-500" />
    </div>
  )

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm mb-6">
        <Link href="/agencies" className="text-slate-400 hover:text-white transition-colors">Agencies</Link>
        <span className="text-slate-600">/</span>
        <Link href={`/agencies/${agencyId}`} className="text-slate-400 hover:text-white transition-colors">
          {agencyName || agencyId}
        </Link>
        <span className="text-slate-600">/</span>
        <span className="text-white font-medium">Salary Management</span>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <Link href={`/agencies/${agencyId}`}
          className="inline-flex items-center gap-2 text-slate-400 hover:text-white transition-colors">
          <ArrowLeft size={16} />Back
        </Link>
        <div>
          <h1 className="text-white text-2xl font-bold">Salary Management</h1>
          <p className="text-slate-400 text-sm">{agencyName}</p>
        </div>
      </div>

      {loadError && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
          {loadError}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Pending', value: fmtInr(totalPending), color: 'text-yellow-400', icon: Clock },
          { label: 'Approved (unpaid)', value: fmtInr(totalApproved), color: 'text-blue-400', icon: CheckCircle2 },
          { label: 'Total Paid', value: fmtInr(totalPaid), color: 'text-green-400', icon: Banknote },
        ].map(({ label, value, color, icon: Icon }) => (
          <div key={label} className="bg-slate-800 border border-slate-700 rounded-xl p-4 flex items-center gap-3">
            <Icon size={20} className={color} />
            <div>
              <p className="text-slate-400 text-xs">{label}</p>
              <p className={`font-bold text-lg ${color}`}>{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {(['all', 'pending', 'approved', 'paid', 'distributed'] as const).map(tab => (
          <button key={tab} onClick={() => setFilter(tab)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              filter === tab
                ? 'bg-pink-500 text-white'
                : 'bg-slate-800 text-slate-400 hover:bg-slate-700 border border-slate-700'
            }`}>
            {tab.charAt(0).toUpperCase() + tab.slice(1)} ({counts[tab]})
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
        {filtered.length === 0 ? (
          <div className="text-center py-16 text-slate-500">
            <Users size={32} className="mx-auto mb-3 text-slate-700" />
            No salary requests {filter !== 'all' && `with status "${filter}"`}.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-left">
                  {['Host', 'Period', 'Beans', 'Amount', 'Notes', 'Status', 'Submitted', 'Actions'].map(h => (
                    <th key={h} className="px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wide">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {filtered.map(req => (
                  <tr key={req.id} className="hover:bg-slate-700/30 transition-colors">
                    <td className="px-4 py-3 text-white font-medium whitespace-nowrap">{req.hostName || '—'}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">
                      {req.periodStart} → {req.periodEnd}
                    </td>
                    <td className="px-4 py-3 text-yellow-300 font-semibold whitespace-nowrap">
                      🫘 {req.beansEarned?.toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3 text-green-300 font-semibold whitespace-nowrap">
                      {fmtInr(req.amountInr)}
                    </td>
                    <td className="px-4 py-3 text-slate-400 max-w-[140px] truncate text-xs">
                      {req.notes || '—'}
                      {req.utrNumber && <span className="block text-blue-400 font-mono">UTR: {req.utrNumber}</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap"><StatusBadge status={req.status} /></td>
                    <td className="px-4 py-3 text-slate-500 text-xs whitespace-nowrap">{fmtDate(req.createdAt)}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {isAdminOrAbove && (
                        <div className="flex items-center gap-1.5">
                          {req.status === 'pending' && (
                            <button
                              onClick={() => handleApprove(req)}
                              disabled={actionId === req.id}
                              className="flex items-center gap-1 px-2.5 py-1.5 bg-green-500/20 hover:bg-green-500/30 text-green-400 border border-green-500/30 rounded text-xs font-medium transition-colors disabled:opacity-50"
                            >
                              {actionId === req.id ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                              Approve
                            </button>
                          )}
                          {req.status === 'approved' && (
                            <button
                              onClick={() => { setShowPayModal(req); setUtr('') }}
                              className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 border border-blue-500/30 rounded text-xs font-medium transition-colors"
                            >
                              <Banknote size={11} />Mark Paid
                            </button>
                          )}
                          {req.status === 'paid' && (
                            <button
                              onClick={() => handleReject(req)}
                              disabled={actionId === req.id + '-reject'}
                              className="flex items-center gap-1 px-2.5 py-1.5 bg-purple-500/20 hover:bg-purple-500/30 text-purple-400 border border-purple-500/30 rounded text-xs font-medium transition-colors disabled:opacity-50"
                            >
                              {actionId === req.id + '-reject' ? <Loader2 size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
                              Distributed
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pay Modal */}
      {showPayModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-6 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-semibold text-lg">Mark as Paid</h3>
              <button onClick={() => setShowPayModal(null)} className="text-slate-400 hover:text-white">
                <XCircle size={18} />
              </button>
            </div>
            <div className="bg-slate-900 rounded-lg p-3 mb-4 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-400">Host</span>
                <span className="text-white font-medium">{showPayModal.hostName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Amount</span>
                <span className="text-green-400 font-bold">{fmtInr(showPayModal.amountInr)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Period</span>
                <span className="text-slate-300">{showPayModal.periodStart} → {showPayModal.periodEnd}</span>
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-slate-400 text-xs mb-1.5 font-medium uppercase tracking-wide">
                UTR / Transaction Reference *
              </label>
              <input
                value={utr}
                onChange={e => setUtr(e.target.value)}
                placeholder="e.g. HDFC1234567890 or UPI ref"
                className="w-full px-3 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm font-mono placeholder-slate-500 focus:outline-none focus:border-pink-500"
              />
            </div>
            {payErr && <p className="text-red-400 text-sm mb-3">⚠ {payErr}</p>}
            <div className="flex gap-3">
              <button onClick={handleMarkPaid} disabled={paySaving}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white rounded-lg font-medium transition-colors">
                {paySaving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                Confirm Payment
              </button>
              <button onClick={() => setShowPayModal(null)}
                className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg font-medium transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
