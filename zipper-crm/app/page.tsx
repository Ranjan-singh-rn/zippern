'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import {
  Users, Star, Radio, DollarSign, Building2, ArrowRight, Loader2,
  ShoppingBag, MessageSquare, Megaphone, FileCheck, BarChart3,
  AlertTriangle, Shield, TrendingUp, Eye, Zap, Clock,
  Receipt, Bug, ShieldOff, UserCog, Gem, Sprout, Wallet2,
  ChevronDown, X, CheckCircle, XCircle,
} from 'lucide-react'
import { collection, query, where, getDocs } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getStats, getActiveLiveRooms, type StatsResult, type LiveRoom } from '@/lib/firestore'
import {
  getDiamondEconomy, getWeeklyBeansBreakdown, getCompanyRevenueSummary,
  type DiamondEconomy, type WeeklyBeansBreakdown, type CompanyRevenueSummary,
} from '@/lib/finance'
import { agencyCommissionInr, type Agency } from '@/lib/agencies'
import { type Seller, getSellerRechargeRequests } from '@/lib/sellers'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, partnerRolesOf, type CrmRole } from '@/lib/auth'
import { toFailure, type ReadFailure, type ReadResult } from '@/lib/readState'
import { Unavailable, UnavailablePanel } from '@/components/ui/States'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The three Platform Insights tiles used to sit inside one `Promise.all`, so a
 * single rejection discarded all three results and every tile fell through to
 * `?? 0`. That is how the owner came to read "Diamond Economy 0 · Beans This
 * Week 0 · Net Profit ₹0" off a brand-new project where all three reads were
 * being REFUSED. A failed read and a measured zero are different facts.
 *
 * `failureReason` and `Unavailable` used to live here, private to this file.
 * They are now in `lib/readState` and `components/ui/States` because the same
 * bug was live on /analytics, /operations, /approvals, /tech and /hosts, and
 * every one of them should refuse in this page's voice rather than its own.
 */
function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function sinceStarted(ts: { toMillis?: () => number } | null): string {
  if (!ts?.toMillis) return '—'
  const mins = Math.floor((Date.now() - ts.toMillis()) / 60000)
  if (mins < 60) return `${mins}m`
  return `${Math.floor(mins / 60)}h ${mins % 60}m`
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string
  value: string | number
  sub?: string
  icon: React.ReactNode
  bg: string
  href?: string
  urgent?: boolean
  pulse?: boolean
  /**
   * Set when the read behind `value` did not complete. It takes precedence
   * over `value` — a tile that could not be read shows the refusal, never a
   * placeholder figure standing in for one.
   */
  failure?: ReadFailure | null
}

function StatCard({ label, value, sub, icon, bg, href, urgent, pulse, failure }: StatCardProps) {
  const inner = (
    <div className={`relative bg-slate-800 border rounded-xl p-5 flex items-start gap-4 transition-all ${
      failure ? 'border-yellow-500/30' :
      urgent ? 'border-red-500/40 bg-red-500/5' : 'border-slate-700 hover:border-slate-600'
    } ${href ? 'cursor-pointer hover:bg-slate-750' : ''}`}>
      <div className={`p-2.5 rounded-lg shrink-0 ${failure ? 'bg-slate-700' : bg}`}>
        {pulse && !failure ? (
          <span className="relative flex">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40" style={{ background: 'currentColor' }} />
            {icon}
          </span>
        ) : icon}
      </div>
      <div className="min-w-0">
        <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-0.5">{label}</p>
        {failure ? (
          <Unavailable failure={failure} />
        ) : (
          <>
            <p className={`text-2xl font-bold ${urgent ? 'text-red-400' : 'text-white'}`}>{value}</p>
            {sub && <p className="text-slate-500 text-xs mt-0.5">{sub}</p>}
          </>
        )}
      </div>
      {href && !failure && <ArrowRight size={14} className="absolute top-4 right-4 text-slate-600" />}
    </div>
  )
  // A tile that could not be read is not a link to a number — the destination
  // will refuse the same read. Keep it, but do not dress it up as navigable.
  return href && !failure ? <Link href={href}>{inner}</Link> : inner
}

/** `1,234` when the count was read, and nothing at all when it was not. */
function count(r: ReadResult<number>): string {
  return r.ok ? r.value.toLocaleString('en-IN') : ''
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="bg-slate-800 rounded-xl p-5 border border-slate-700 animate-pulse">
          <div className="h-3 bg-slate-700 rounded w-28 mb-4" />
          <div className="h-8 bg-slate-700 rounded w-20" />
        </div>
      ))}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

// ── Insight Modal ─────────────────────────────────────────────────────────────

function InsightModal({ title, icon, onClose, children }: {
  title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-800">
          <div className="p-2 rounded-lg bg-slate-800">{icon}</div>
          <h2 className="text-lg font-bold text-white flex-1">{title}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors p-1">
            <X size={18} />
          </button>
        </div>
        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-5">{children}</div>
      </div>
    </div>
  )
}

function RowBar({ label, value, max, color, sub }: {
  label: string; value: number; max: number; color: string; sub?: string
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-300 font-medium">{label}</span>
        <span className="text-white font-semibold">{sub ?? value.toLocaleString('en-IN')}</span>
      </div>
      <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// ── Agency Role Dashboard ─────────────────────────────────────────────────────

function AgencyView({ uid, name }: { uid: string; name: string }) {
  const [agency, setAgency] = useState<Agency | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getDocs(query(collection(db, 'agencies'), where('crmUid', '==', uid)))
      .then(snap => {
        if (!snap.empty) setAgency({ id: snap.docs[0].id, ...snap.docs[0].data() } as Agency)
      })
      .finally(() => setLoading(false))
  }, [uid])

  if (loading) return <div className="flex justify-center py-20"><div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" /></div>

  if (!agency) return (
    <div className="text-center py-20 text-slate-400">
      <Building2 size={40} className="mx-auto mb-4 text-slate-600" />
      <p className="text-lg font-semibold text-white">No agency linked to your account.</p>
      <p className="text-sm mt-1">Contact your administrator to link this account to an agency.</p>
    </div>
  )

  const statusColor = agency.status === 'approved' ? 'text-green-400 bg-green-500/10 border-green-500/20'
    : agency.status === 'rejected' ? 'text-red-400 bg-red-500/10 border-red-500/20'
    : 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-slate-400 text-sm">{greeting()},</p>
          <h1 className="text-3xl font-bold text-white mt-0.5">{name}</h1>
        </div>
        <span className={`text-xs font-semibold px-3 py-1.5 rounded-full border capitalize ${statusColor}`}>
          {agency.status}
        </span>
      </div>

      {/* Agency Info Card */}
      <div className="bg-gradient-to-r from-pink-500/10 via-slate-800 to-slate-800 border border-pink-500/20 rounded-xl p-6 flex flex-col sm:flex-row items-start gap-5">
        <div className="p-3 rounded-xl bg-pink-500/20 shrink-0">
          <Building2 size={28} className="text-pink-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-slate-400 text-xs uppercase tracking-wide">Your Agency</p>
          <p className="text-2xl font-bold text-white mt-0.5 truncate">{agency.agencyName}</p>
          <p className="text-slate-500 text-sm mt-1">
            {agency.type === 'main' ? 'Main Agency' : 'Sub-Agency'} · {agency.ownerName} · {agency.ownerPhone}
          </p>
        </div>
        <Link
          href={`/agencies/${agency.id}`}
          className="flex items-center gap-2 px-4 py-2 bg-pink-500 hover:bg-pink-400 text-white rounded-lg text-sm font-medium transition-colors shrink-0"
        >
          View Details <ArrowRight size={14} />
        </Link>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Total Hosts', value: agency.totalHosts ?? 0, icon: <Star size={18} className="text-yellow-300" />, bg: 'bg-yellow-500/20' },
          { label: 'Sub-Agencies', value: agency.totalSubAgencies ?? 0, icon: <Building2 size={18} className="text-blue-300" />, bg: 'bg-blue-500/20' },
          {
            label: 'Commission Balance',
            // M-15: `commissionBalance` is PAISE; `agencyCommissionInr` prefers the
            // rupee mirror the API writes beside it and divides by 100 otherwise.
            value: agency.currency === 'USD' ? `$${agencyCommissionInr(agency).toFixed(2)}` : `₹${agencyCommissionInr(agency).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
            icon: <DollarSign size={18} className="text-green-300" />,
            bg: 'bg-green-500/20',
          },
          {
            label: 'Total Paid',
            value: agency.currency === 'USD' ? `$${(agency.commissionPaidINR ?? 0).toFixed(2)}` : `₹${(agency.commissionPaidINR ?? 0).toLocaleString('en-IN')}`,
            icon: <CheckCircle size={18} className="text-cyan-300" />,
            bg: 'bg-cyan-500/20',
          },
        ].map(({ label, value, icon, bg }) => (
          <div key={label} className="bg-slate-800 border border-slate-700 rounded-xl p-5 flex items-start gap-3">
            <div className={`p-2.5 rounded-lg shrink-0 ${bg}`}>{icon}</div>
            <div>
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
              <p className="text-xl font-bold text-white mt-0.5">{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* KYC Status */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex items-center gap-4">
        <div className={`p-2.5 rounded-lg ${agency.kycStatus === 'approved' ? 'bg-green-500/20' : agency.kycStatus === 'rejected' ? 'bg-red-500/20' : 'bg-yellow-500/20'}`}>
          <FileCheck size={18} className={agency.kycStatus === 'approved' ? 'text-green-400' : agency.kycStatus === 'rejected' ? 'text-red-400' : 'text-yellow-400'} />
        </div>
        <div>
          <p className="text-white font-semibold">KYC Status</p>
          <p className={`text-sm capitalize ${agency.kycStatus === 'approved' ? 'text-green-400' : agency.kycStatus === 'rejected' ? 'text-red-400' : 'text-yellow-400'}`}>
            {agency.kycStatus}
            {agency.kycStatus === 'pending' && ' — Upload your KYC documents to get verified'}
            {agency.kycStatus === 'submitted' && ' — Your KYC is under review'}
          </p>
        </div>
      </div>
    </div>
  )
}

// ── Seller Role Dashboard ─────────────────────────────────────────────────────

function SellerView({ uid, name }: { uid: string; name: string }) {
  const [seller, setSeller] = useState<Seller | null>(null)
  const [pendingReqs, setPendingReqs] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getDocs(query(collection(db, 'sellers'), where('crmUid', '==', uid)))
      .then(async snap => {
        if (!snap.empty) {
          const s = { id: snap.docs[0].id, ...snap.docs[0].data() } as Seller
          setSeller(s)
          const reqs = await getSellerRechargeRequests(s.ownerUid)
          setPendingReqs(reqs.filter(r => r.status === 'pending').length)
        }
      })
      .finally(() => setLoading(false))
  }, [uid])

  if (loading) return <div className="flex justify-center py-20"><div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" /></div>

  if (!seller) return (
    <div className="text-center py-20 text-slate-400">
      <ShoppingBag size={40} className="mx-auto mb-4 text-slate-600" />
      <p className="text-lg font-semibold text-white">No seller account linked.</p>
      <p className="text-sm mt-1">Contact your administrator to link this account to a coin shop.</p>
    </div>
  )

  const statusColor = seller.isApproved && seller.isActive ? 'text-green-400 bg-green-500/10 border-green-500/20'
    : !seller.isApproved ? 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20'
    : 'text-slate-400 bg-slate-700 border-slate-600'

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-slate-400 text-sm">{greeting()},</p>
          <h1 className="text-3xl font-bold text-white mt-0.5">{name}</h1>
        </div>
        <span className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${statusColor}`}>
          {seller.isApproved && seller.isActive ? 'Active' : !seller.isApproved ? 'Pending Approval' : 'Inactive'}
        </span>
      </div>

      {/* Shop Info */}
      <div className="bg-gradient-to-r from-pink-500/10 via-slate-800 to-slate-800 border border-pink-500/20 rounded-xl p-6 flex flex-col sm:flex-row items-start gap-5">
        <div className="p-3 rounded-xl bg-pink-500/20 shrink-0">
          <ShoppingBag size={28} className="text-pink-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-slate-400 text-xs uppercase tracking-wide">Your Coin Shop</p>
          <p className="text-2xl font-bold text-white mt-0.5 truncate">{seller.displayName}</p>
          <p className="text-slate-500 text-sm mt-1">{seller.phone} · {seller.email}</p>
        </div>
        <Link
          href={`/sellers/${seller.id}`}
          className="flex items-center gap-2 px-4 py-2 bg-pink-500 hover:bg-pink-400 text-white rounded-lg text-sm font-medium transition-colors shrink-0"
        >
          View Details <ArrowRight size={14} />
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {[
          {
            label: 'Coin Balance',
            value: (seller.coinBalance ?? 0).toLocaleString('en-IN'),
            icon: <Gem size={18} className="text-cyan-300" />,
            bg: 'bg-cyan-500/20',
            urgent: (seller.coinBalance ?? 0) < 10000,
          },
          {
            label: 'Total Sold',
            value: (seller.totalCoinsSold ?? 0).toLocaleString('en-IN'),
            icon: <DollarSign size={18} className="text-green-300" />,
            bg: 'bg-green-500/20',
          },
          {
            label: 'Pending Requests',
            value: pendingReqs,
            icon: <Clock size={18} className={pendingReqs > 0 ? 'text-yellow-300' : 'text-slate-400'} />,
            bg: pendingReqs > 0 ? 'bg-yellow-500/20' : 'bg-slate-700',
            urgent: pendingReqs > 0,
          },
        ].map(({ label, value, icon, bg, urgent }) => (
          <div key={label} className={`bg-slate-800 border rounded-xl p-5 flex items-start gap-3 ${urgent ? 'border-yellow-500/30' : 'border-slate-700'}`}>
            <div className={`p-2.5 rounded-lg shrink-0 ${bg}`}>{icon}</div>
            <div>
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
              <p className={`text-xl font-bold mt-0.5 ${urgent ? 'text-yellow-300' : 'text-white'}`}>{value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Low balance warning */}
      {(seller.coinBalance ?? 0) < 10000 && (
        <div className="flex items-start gap-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
          <AlertTriangle size={16} className="text-yellow-400 mt-0.5 shrink-0" />
          <p className="text-yellow-300 text-sm">
            Your coin balance is low. Contact your administrator to recharge your inventory.
          </p>
        </div>
      )}

      {/* Registration status */}
      {!seller.registrationFeePaid && (
        <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/30 rounded-xl p-4">
          <XCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-red-300 text-sm">
            Registration fee not yet paid. Your account may not be fully activated until payment is confirmed.
          </p>
        </div>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { crmUser } = useAuth()
  const [stats, setStats]     = useState<StatsResult | null>(null)
  const [rooms, setRooms]     = useState<LiveRoom[]>([])
  const [loading, setLoading] = useState(true)

  // `getStats()` no longer rejects — each of its ten reads reports for itself —
  // but the call can still fail outright (module/auth level), and the live-room
  // read is a separate query that fails on its own terms. Two states, because
  // there are two things that can go wrong and they are not the same news.
  const [statsFailure, setStatsFailure] = useState<ReadFailure | null>(null)
  const [roomsFailure, setRoomsFailure] = useState<ReadFailure | null>(null)

  // Insight data
  const [diamondData,  setDiamondData]  = useState<DiamondEconomy | null>(null)
  const [beansData,    setBeansData]    = useState<WeeklyBeansBreakdown | null>(null)
  const [revenueData,  setRevenueData]  = useState<CompanyRevenueSummary | null>(null)
  const [insightLoading, setInsightLoading] = useState(true)

  // One failure per tile, null when the read succeeded. Kept separate because
  // the three reads fail independently — the collection-group queries behind
  // the first two are refused by the rules on an account for which the third
  // works perfectly well.
  const [diamondError, setDiamondError] = useState<ReadFailure | null>(null)
  const [beansError,   setBeansError]   = useState<ReadFailure | null>(null)
  const [revenueError, setRevenueError] = useState<ReadFailure | null>(null)

  // Which modal is open: 'diamonds' | 'beans' | 'revenue' | null
  const [openModal, setOpenModal] = useState<'diamonds' | 'beans' | 'revenue' | null>(null)

  // `allSettled`, and the failures are kept. Under `Promise.all` + `.catch`
  // a rejected live-room query left `stats` at null, and `stats && (…)` in the
  // markup below then rendered the ENTIRE KPI grid as nothing — no skeleton, no
  // error, just an empty dashboard that looked like a platform with no data.
  useEffect(() => {
    let cancelled = false
    Promise.allSettled([getStats(), getActiveLiveRooms()]).then(([s, r]) => {
      if (cancelled) return

      if (s.status === 'fulfilled') { setStats(s.value); setStatsFailure(null) }
      else { setStats(null); setStatsFailure(toFailure(s.reason, 'dashboard/getStats')) }

      if (r.status === 'fulfilled') { setRooms(r.value.slice(0, 5)); setRoomsFailure(null) }
      else { setRooms([]); setRoomsFailure(toFailure(r.reason, 'dashboard/getActiveLiveRooms')) }

      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  // `allSettled`, not `all`.
  //
  // `getDiamondEconomy` and `getWeeklyBeansBreakdown` both issue COLLECTION-GROUP
  // queries (`diamondTransactions`, `beanTransactions`). Under `Promise.all` a
  // rejection from either one discarded `getCompanyRevenueSummary` as well —
  // the one read that would have worked — and all three tiles rendered `?? 0`.
  // Three refused reads were being presented to the owner as three measured
  // zeroes. Each read now stands or falls on its own and says which it did.
  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, ['superadmin', 'finance_admin', 'finance_member'])) return
    let cancelled = false
    Promise.allSettled([
      getDiamondEconomy(),
      getWeeklyBeansBreakdown(),
      getCompanyRevenueSummary(),
    ]).then(([d, b, r]) => {
      if (cancelled) return

      if (d.status === 'fulfilled') { setDiamondData(d.value); setDiamondError(null) }
      else { setDiamondData(null); setDiamondError(toFailure(d.reason, 'diamond economy')) }

      if (b.status === 'fulfilled') { setBeansData(b.value); setBeansError(null) }
      else { setBeansData(null); setBeansError(toFailure(b.reason, 'weekly beans')) }

      if (r.status === 'fulfilled') { setRevenueData(r.value); setRevenueError(null) }
      else { setRevenueData(null); setRevenueError(toFailure(r.reason, 'company revenue')) }

      setInsightLoading(false)
    })
    return () => { cancelled = true }
  }, [crmUser])

  // An alert is a claim that something needs attention. A refused count cannot
  // support that claim in either direction — it is not "0 pending", it is
  // unknown — so an unreadable count raises no alert and suppresses none.
  const alerts: { text: string; href: string }[] = []
  if (stats) {
    const kyc = stats.pendingKyc
    const agencies = stats.pendingAgencies
    const tickets = stats.openTickets
    if (kyc.ok && kyc.value > 0)        alerts.push({ text: `${kyc.value} KYC submission${kyc.value > 1 ? 's' : ''} awaiting review`, href: '/kyc' })
    if (agencies.ok && agencies.value > 0) alerts.push({ text: `${agencies.value} agency registration${agencies.value > 1 ? 's' : ''} pending approval`, href: '/agencies' })
    if (tickets.ok && tickets.value > 3)   alerts.push({ text: `${tickets.value} open support tickets`, href: '/feedback' })
  }

  // Typed `CrmRole[]` per entry rather than cast at the call site. The old
  // `canAccess(crmUser, a.roles as any)` meant a typo in any role string below
  // would compile and silently hide the tile from everyone. The annotation sits
  // on the literal, not on the `.filter()` result, or it does not reach it.
  const allQuickActions: {
    href: string; label: string; icon: React.ElementType; desc: string; roles: CrmRole[]
  }[] = [
    { href: '/users',              label: 'User Management',    icon: Users,       desc: 'Browse, search, ban, and manage users',       roles: ['superadmin','app_admin','app_member','ops_admin','ops_member','finance_admin','finance_member','tech_admin','tech_member','support_admin','support_member'] },
    { href: '/hosts',              label: 'Host Management',    icon: Star,        desc: 'Hosts, beans, quick ban and level actions',    roles: ['superadmin','app_admin','app_member','ops_admin','ops_member'] },
    { href: '/agencies',           label: 'Agencies',           icon: Building2,   desc: 'Approve, manage, and track agency payouts',    roles: ['superadmin','app_admin'] },
    { href: '/sellers',            label: 'Coin Sellers',       icon: ShoppingBag, desc: 'Diamond Shop sellers — online/offline status', roles: ['superadmin','app_admin','app_member','ops_admin','ops_member'] },
    { href: '/kyc',                label: 'KYC',                icon: FileCheck,   desc: 'Review submitted KYC documents',               roles: ['superadmin','app_admin'] },
    { href: '/finance',            label: 'Finance',            icon: DollarSign,  desc: 'Revenue, payouts, and profit monitoring',      roles: ['superadmin','finance_admin','finance_member'] },
    { href: '/finance/withdrawals',label: 'Withdrawals',        icon: Receipt,     desc: 'Host bean cash-out requests',                  roles: ['superadmin','finance_admin','finance_member'] },
    { href: '/live',               label: 'Live Monitor',       icon: Radio,       desc: 'Active live rooms and viewer counts',          roles: ['superadmin','app_admin','app_member','ops_admin','ops_member','tech_admin','tech_member','support_admin'] },
    { href: '/analytics',          label: 'Analytics',          icon: BarChart3,   desc: 'Growth, retention, and revenue trends',        roles: ['superadmin','finance_admin','finance_member','ops_admin','ops_member'] },
    { href: '/broadcasts',         label: 'Broadcasts',         icon: Megaphone,   desc: 'Send announcements to all app users',          roles: ['superadmin','app_admin','app_member','ops_admin','ops_member'] },
    { href: '/feedback',           label: 'Feedback & Support', icon: MessageSquare,desc: 'View and respond to user support requests',   roles: ['superadmin','support_admin','support_member','tech_admin','tech_member'] },
    { href: '/operations/bans',    label: 'Device Bans',        icon: ShieldOff,   desc: 'Manage device-level bans',                    roles: ['superadmin','app_admin','app_member','ops_admin','ops_member'] },
    { href: '/tech',               label: 'Tech',               icon: Bug,         desc: 'System health and tech issues',               roles: ['superadmin','tech_admin','tech_member'] },
    { href: '/team',               label: 'Team',               icon: UserCog,     desc: 'Manage CRM users, roles, and permissions',    roles: ['superadmin'] },
  ]
  const quickActions = allQuickActions.filter(a => canAccess(crmUser, a.roles))

  // Capability-scoped views. `partnerRolesOf` returns the login's capabilities
  // primary first, so a partner holding one sees exactly what they saw before,
  // and one holding both sees the view for the capability their account was
  // created with — the same one `resolvePartnerRedirect` lands them on. Moving
  // to the other business is the switcher's job, not this page's.
  const partnerRoles = partnerRolesOf(crmUser)
  if (partnerRoles[0] === 'agency' && crmUser) {
    return <AgencyView uid={crmUser.uid} name={crmUser.name} />
  }
  if (partnerRoles[0] === 'seller' && crmUser) {
    return <SellerView uid={crmUser.uid} name={crmUser.name} />
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <p className="text-slate-400 text-sm">{greeting()},</p>
          <h1 className="text-3xl font-bold text-white mt-0.5">
            {crmUser?.name ?? 'Admin'}
          </h1>
        </div>
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <Clock size={14} />
          {new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-5 py-4 flex flex-wrap gap-4 items-center">
          <div className="flex items-center gap-2 shrink-0">
            <AlertTriangle size={16} className="text-yellow-400" />
            <span className="text-yellow-300 text-sm font-semibold">Action needed</span>
          </div>
          <div className="flex flex-wrap gap-3">
            {alerts.map((a, i) => (
              <Link key={i} href={a.href}
                className="text-yellow-400 hover:text-yellow-300 text-sm underline underline-offset-2 transition-colors">
                {a.text}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Stats Grid — six tiles over ten reads, each tile answering for its own */}
      {loading ? <Skeleton /> : statsFailure ? (
        <div className="bg-slate-800 border border-yellow-500/30 rounded-xl">
          <UnavailablePanel failure={statsFailure} what="The dashboard KPIs" />
        </div>
      ) : stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <StatCard
            label="Total Users"
            value={count(stats.totalUsers)}
            sub={stats.bannedUsers.ok
              ? `${stats.bannedUsers.value} banned`
              : 'banned count could not be read'}
            icon={<Users size={18} className="text-blue-300" />}
            bg="bg-blue-500/20"
            href="/users"
            failure={stats.totalUsers.ok ? null : stats.totalUsers}
          />
          <StatCard
            label="Total Hosts"
            value={count(stats.totalHosts)}
            icon={<Star size={18} className="text-yellow-300" />}
            bg="bg-yellow-500/20"
            href="/hosts"
            failure={stats.totalHosts.ok ? null : stats.totalHosts}
          />
          <StatCard
            label="Live Now"
            value={count(stats.activeLives)}
            sub={stats.activeLives.ok && stats.activeLives.value > 0 ? 'rooms active' : 'no active rooms'}
            icon={<Radio size={18} className="text-green-300" />}
            bg="bg-green-500/20"
            href="/live"
            pulse={stats.activeLives.ok && stats.activeLives.value > 0}
            failure={stats.activeLives.ok ? null : stats.activeLives}
          />
          {/* Two reads, one figure: "3 / —" would be read as a ratio. If either
              half is missing the tile has no ratio to report. */}
          <StatCard
            label="Coin Sellers Online"
            value={stats.coinSellersOnline.ok && stats.totalSellers.ok
              ? `${stats.coinSellersOnline.value} / ${stats.totalSellers.value}`
              : ''}
            sub="online / total sellers"
            icon={<ShoppingBag size={18} className="text-pink-300" />}
            bg="bg-pink-500/20"
            href="/sellers"
            failure={
              !stats.coinSellersOnline.ok ? stats.coinSellersOnline
              : !stats.totalSellers.ok ? stats.totalSellers
              : null
            }
          />
          {/* `kycSubmissions` is isAdmin() || isSupport() in the rules, so this
              is the tile an app/ops/finance/tech member sees refused. It used to
              read "0 awaiting review" — a reassurance nobody had earned. */}
          <StatCard
            label="Pending KYC"
            value={count(stats.pendingKyc)}
            sub="awaiting review"
            icon={<FileCheck size={18} className={stats.pendingKyc.ok && stats.pendingKyc.value > 0 ? 'text-red-300' : 'text-slate-400'} />}
            bg={stats.pendingKyc.ok && stats.pendingKyc.value > 0 ? 'bg-red-500/20' : 'bg-slate-700'}
            href="/kyc"
            urgent={stats.pendingKyc.ok && stats.pendingKyc.value > 0}
            failure={stats.pendingKyc.ok ? null : stats.pendingKyc}
          />
          {/* `agencies` is isAdmin() — the sub-line here is the second refusal
              every *_member account gets, and it is reported separately from
              the ticket count it shares a tile with. */}
          <StatCard
            label="Open Tickets"
            value={count(stats.openTickets)}
            sub={stats.pendingAgencies.ok
              ? `${stats.pendingAgencies.value} agencies pending`
              : 'pending agencies could not be read'}
            icon={<MessageSquare size={18} className={stats.openTickets.ok && stats.openTickets.value > 3 ? 'text-red-300' : 'text-purple-300'} />}
            bg={stats.openTickets.ok && stats.openTickets.value > 3 ? 'bg-red-500/20' : 'bg-purple-500/20'}
            href="/feedback"
            urgent={stats.openTickets.ok && stats.openTickets.value > 3}
            failure={stats.openTickets.ok ? null : stats.openTickets}
          />
        </div>
      )}

      {/* Revenue Spotlight */}
      {stats && canAccess(crmUser, ['superadmin', 'finance_admin', 'finance_member']) && (
        <div className="bg-gradient-to-r from-pink-500/10 via-slate-800 to-slate-800 border border-pink-500/20 rounded-xl p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="p-3 rounded-xl bg-pink-500/20">
            <TrendingUp size={22} className="text-pink-400" />
          </div>
          <div>
            <p className="text-slate-400 text-xs uppercase tracking-wide">Estimated Platform Revenue</p>
            {!stats.estimatedRevenueINR.ok ? (
              // The original of this treatment. It now carries the reason too:
              // "refreshing will not help, your role cannot see revenue" and
              // "the database is unreachable, do refresh" are opposite advice.
              <Unavailable failure={stats.estimatedRevenueINR} />
            ) : (
              <>
                <p className="text-2xl font-bold text-white mt-0.5">
                  ₹{stats.estimatedRevenueINR.value.toLocaleString('en-IN')}
                </p>
                <p className="text-slate-500 text-xs mt-0.5">Based on diamond transactions · ₹22.90 per 1,000 diamonds</p>
              </>
            )}
          </div>
          <Link href="/finance" className="sm:ml-auto flex items-center gap-2 px-4 py-2 bg-pink-500 hover:bg-pink-400 text-white rounded-lg text-sm font-medium transition-colors shrink-0">
            <DollarSign size={14} /> Finance
          </Link>
        </div>
      )}

      {/* ── 3 Insight Boxes (superadmin / finance) ────────────────────────── */}
      {canAccess(crmUser, ['superadmin', 'finance_admin', 'finance_member']) && (
        <section>
          <h2 className="text-lg font-semibold text-white mb-3">Platform Insights</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

            {/* Box 1 — Diamond Sales */}
            <button
              onClick={() => setOpenModal('diamonds')}
              className="text-left bg-slate-800 border border-slate-700 hover:border-cyan-500/50 rounded-xl p-5 transition-all group cursor-pointer"
            >
              <div className="flex items-start justify-between">
                <div className="p-2.5 rounded-lg bg-cyan-500/20 group-hover:bg-cyan-500/30 transition">
                  <Gem size={18} className="text-cyan-400" />
                </div>
                <ChevronDown size={14} className="text-slate-600 group-hover:text-cyan-400 transition mt-1" />
              </div>
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mt-3">Diamond Economy</p>
              {insightLoading ? (
                <div className="h-7 w-28 bg-slate-700 rounded animate-pulse mt-1" />
              ) : diamondError ? (
                <Unavailable failure={diamondError} />
              ) : (
                <p className="text-2xl font-bold text-white mt-0.5">
                  {(diamondData?.totalDiamondsSold ?? 0).toLocaleString('en-IN')}
                </p>
              )}
              {!diamondError && (
                <p className="text-slate-500 text-xs mt-1">Total diamonds distributed from company</p>
              )}
            </button>

            {/* Box 2 — Weekly Beans */}
            <button
              onClick={() => setOpenModal('beans')}
              className="text-left bg-slate-800 border border-slate-700 hover:border-green-500/50 rounded-xl p-5 transition-all group cursor-pointer"
            >
              <div className="flex items-start justify-between">
                <div className="p-2.5 rounded-lg bg-green-500/20 group-hover:bg-green-500/30 transition">
                  <Sprout size={18} className="text-green-400" />
                </div>
                <ChevronDown size={14} className="text-slate-600 group-hover:text-green-400 transition mt-1" />
              </div>
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mt-3">Beans This Week</p>
              {insightLoading ? (
                <div className="h-7 w-28 bg-slate-700 rounded animate-pulse mt-1" />
              ) : beansError ? (
                <Unavailable failure={beansError} />
              ) : (
                <p className="text-2xl font-bold text-white mt-0.5">
                  {(beansData?.thisWeekTotal ?? 0).toLocaleString('en-IN')}
                </p>
              )}
              {!beansError && (
                <p className="text-slate-500 text-xs mt-1">
                  {beansData && beansData.lastWeekTotal > 0
                    ? `${beansData.thisWeekTotal >= beansData.lastWeekTotal ? '↑' : '↓'} vs ${beansData.lastWeekTotal.toLocaleString('en-IN')} last week`
                    : 'Hosts · users · agencies · rewards'
                  }
                </p>
              )}
            </button>

            {/* Box 3 — Company Revenue */}
            <button
              onClick={() => setOpenModal('revenue')}
              className="text-left bg-slate-800 border border-slate-700 hover:border-pink-500/50 rounded-xl p-5 transition-all group cursor-pointer"
            >
              <div className="flex items-start justify-between">
                <div className="p-2.5 rounded-lg bg-pink-500/20 group-hover:bg-pink-500/30 transition">
                  <Wallet2 size={18} className="text-pink-400" />
                </div>
                <ChevronDown size={14} className="text-slate-600 group-hover:text-pink-400 transition mt-1" />
              </div>
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mt-3">Net Profit</p>
              {insightLoading ? (
                <div className="h-7 w-28 bg-slate-700 rounded animate-pulse mt-1" />
              ) : revenueError ? (
                <Unavailable failure={revenueError} />
              ) : (
                <p className="text-2xl font-bold text-white mt-0.5">
                  ₹{Math.round(revenueData?.netProfit ?? 0).toLocaleString('en-IN')}
                </p>
              )}
              {!revenueError && (
                <p className="text-slate-500 text-xs mt-1">
                  {revenueData
                    ? `${revenueData.profitMargin.toFixed(1)}% margin · ₹${revenueData.totalRevenue.toLocaleString('en-IN')} revenue`
                    : 'Gifting · calling · platform cuts'
                  }
                </p>
              )}
            </button>
          </div>
        </section>
      )}

      {/* ── Diamond Economy Modal ─────────────────────────────────────────── */}
      {openModal === 'diamonds' && (
        <InsightModal
          title="Diamond Economy"
          icon={<Gem size={18} className="text-cyan-400" />}
          onClose={() => setOpenModal(null)}
        >
          {insightLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-slate-500" />
            </div>
          ) : diamondError ? (
            <p className="text-yellow-400/90 text-sm text-center py-8 px-4 leading-relaxed">
              This could not be read, so nothing is shown. It is not a zero.
              <br />
              <span className="text-slate-500">{diamondError.reason}</span>
            </p>
          ) : !diamondData || diamondData.totalDiamondsSold === 0 ? (
            <p className="text-slate-500 text-sm text-center py-8">No diamond transaction data found yet.</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Sold via Sellers', value: diamondData.totalDiamondsSold.toLocaleString('en-IN'), color: 'text-cyan-400' },
                  { label: 'Rewarded Directly', value: diamondData.totalDiamondsRewarded.toLocaleString('en-IN'), color: 'text-yellow-400' },
                  { label: 'Revenue Collected', value: `₹${diamondData.totalRevenue.toLocaleString('en-IN')}`, color: 'text-green-400' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-slate-800 rounded-xl p-3 text-center">
                    <p className={`text-xl font-bold ${color}`}>{value}</p>
                    <p className="text-slate-500 text-xs mt-0.5">{label}</p>
                  </div>
                ))}
              </div>
              {diamondData.recentWeeks.length > 0 && (
                <div>
                  <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-3">Weekly Breakdown</p>
                  <div className="space-y-3">
                    {diamondData.recentWeeks.map((w) => (
                      <div key={w.weekLabel} className="flex items-center gap-3 bg-slate-800/60 rounded-lg px-4 py-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-white text-sm font-medium">{w.weekLabel}</p>
                          <p className="text-slate-500 text-xs">{w.diamondsSold.toLocaleString('en-IN')} diamonds sold</p>
                        </div>
                        <span className="text-green-400 font-semibold text-sm shrink-0">₹{w.revenue.toLocaleString('en-IN')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex justify-end pt-1">
                <Link href="/finance" onClick={() => setOpenModal(null)}
                  className="flex items-center gap-1.5 text-cyan-400 hover:text-cyan-300 text-sm font-medium transition-colors">
                  Full Finance View <ArrowRight size={13} />
                </Link>
              </div>
            </>
          )}
        </InsightModal>
      )}

      {/* ── Weekly Beans Modal ────────────────────────────────────────────── */}
      {openModal === 'beans' && (
        <InsightModal
          title="Weekly Beans Generated"
          icon={<Sprout size={18} className="text-green-400" />}
          onClose={() => setOpenModal(null)}
        >
          {insightLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-slate-500" />
            </div>
          ) : beansError ? (
            <p className="text-yellow-400/90 text-sm text-center py-8 px-4 leading-relaxed">
              This could not be read, so nothing is shown. It is not a zero.
              <br />
              <span className="text-slate-500">{beansError.reason}</span>
            </p>
          ) : !beansData || beansData.thisWeekTotal === 0 ? (
            <p className="text-slate-500 text-sm text-center py-8">No bean transaction data found yet.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
                  <p className="text-3xl font-bold text-green-400">{beansData.thisWeekTotal.toLocaleString('en-IN')}</p>
                  <p className="text-slate-400 text-xs mt-1">This Week</p>
                </div>
                <div className="bg-slate-800 rounded-xl p-4 text-center">
                  <p className="text-3xl font-bold text-slate-300">{beansData.lastWeekTotal.toLocaleString('en-IN')}</p>
                  <p className="text-slate-500 text-xs mt-1">Last Week</p>
                  {beansData.lastWeekTotal > 0 && (
                    <p className={`text-xs mt-1 font-semibold ${beansData.thisWeekTotal >= beansData.lastWeekTotal ? 'text-green-400' : 'text-red-400'}`}>
                      {beansData.thisWeekTotal >= beansData.lastWeekTotal ? '▲' : '▼'}{' '}
                      {Math.abs(((beansData.thisWeekTotal - beansData.lastWeekTotal) / beansData.lastWeekTotal) * 100).toFixed(1)}%
                    </p>
                  )}
                </div>
              </div>
              {beansData.weeksData.length > 0 && (
                <div>
                  <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-3">Last 8 Weeks</p>
                  <div className="space-y-2">
                    {beansData.weeksData.map((w) => {
                      const maxVal = beansData.weeksData.reduce((m, x) => Math.max(m, x.total), 1)
                      return (
                        <div key={w.weekStart} className="bg-slate-800/60 rounded-lg px-4 py-3">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-white text-sm font-medium">{w.weekLabel}</p>
                            <p className="text-green-400 font-bold text-sm">{w.total.toLocaleString('en-IN')}</p>
                          </div>
                          <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                            <div className="h-full bg-green-500 rounded-full" style={{ width: `${Math.min((w.total/maxVal)*100,100)}%` }} />
                          </div>
                          <div className="flex gap-4 mt-2 text-xs text-slate-500">
                            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />Gifts: {w.fromGifts.toLocaleString('en-IN')}</span>
                            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />Calls: {w.fromCalls.toLocaleString('en-IN')}</span>
                            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-pink-400 inline-block" />Rewards: {w.fromRewards.toLocaleString('en-IN')}</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </InsightModal>
      )}

      {/* ── Company Revenue Modal ─────────────────────────────────────────── */}
      {openModal === 'revenue' && (
        <InsightModal
          title="Company Revenue & Cuts"
          icon={<Wallet2 size={18} className="text-pink-400" />}
          onClose={() => setOpenModal(null)}
        >
          {insightLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="animate-spin text-slate-500" />
            </div>
          ) : revenueError ? (
            <p className="text-yellow-400/90 text-sm text-center py-8 px-4 leading-relaxed">
              This could not be read, so nothing is shown. It is not a zero.
              <br />
              <span className="text-slate-500">{revenueError.reason}</span>
            </p>
          ) : !revenueData || revenueData.totalRevenue === 0 ? (
            <p className="text-slate-500 text-sm text-center py-8">No revenue records found yet.</p>
          ) : (
            <>
              {/* Platform cut highlight */}
              <div className="bg-gradient-to-r from-cyan-500/10 to-pink-500/10 border border-cyan-500/20 rounded-xl p-4 flex items-center gap-4">
                <div className="p-2.5 rounded-lg bg-cyan-500/20">
                  <Gem size={20} className="text-cyan-400" />
                </div>
                <div className="flex-1">
                  <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide">Platform Diamond Cut</p>
                  <p className="text-2xl font-bold text-cyan-400">{(revenueData.totalPlatformCutDiamonds ?? 0).toLocaleString('en-IN')} 💎</p>
                  <p className="text-slate-500 text-xs mt-0.5">Diamonds retained by Zipper from gifting & calls</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Gross Revenue', value: `₹${Math.round(revenueData.totalRevenue).toLocaleString('en-IN')}`, color: 'text-cyan-400', note: 'Diamonds sold × ₹2290/L' },
                  { label: 'Host Payouts', value: `₹${Math.round(revenueData.totalPayout).toLocaleString('en-IN')}`, color: 'text-orange-400', note: 'Beans earned × ₹1000/L' },
                  { label: 'Net Profit', value: `₹${Math.round(revenueData.netProfit).toLocaleString('en-IN')}`, color: 'text-green-400', note: `${revenueData.profitMargin.toFixed(1)}% margin` },
                ].map(({ label, value, color, note }) => (
                  <div key={label} className="bg-slate-800 rounded-xl p-3 text-center">
                    <p className={`text-lg font-bold ${color}`}>{value}</p>
                    <p className="text-slate-400 text-xs mt-0.5 font-medium">{label}</p>
                    <p className="text-slate-600 text-xs">{note}</p>
                  </div>
                ))}
              </div>
              <div className="bg-slate-800/60 rounded-xl p-4 space-y-2">
                <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-3">Revenue Sources</p>
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 text-slate-300"><span className="w-2 h-2 rounded-full bg-yellow-400 inline-block" />Diamond purchases (gifting)</span>
                  <span className="text-yellow-400 font-medium">Primary</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 text-slate-300"><span className="w-2 h-2 rounded-full bg-blue-400 inline-block" />Diamond purchases (calls)</span>
                  <span className="text-blue-400 font-medium">Primary</span>
                </div>
                <p className="text-slate-600 text-xs mt-2">Company sells diamonds at ₹2,290/lakh · hosts paid ₹1,000/lakh beans earned</p>
              </div>
              {revenueData.recentMonths.length > 0 && (
                <div>
                  <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-3">Monthly Breakdown</p>
                  <div className="space-y-2">
                    {revenueData.recentMonths.map((m) => {
                      const maxRev = revenueData.recentMonths.reduce((mx, x) => Math.max(mx, x.revenue), 1)
                      return (
                        <div key={m.monthKey} className="bg-slate-800/60 rounded-lg px-4 py-3">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-white text-sm font-semibold">{m.monthLabel}</p>
                            <div className="text-right">
                              <p className="text-green-400 text-sm font-bold">₹{m.profit.toLocaleString('en-IN')}</p>
                              <p className="text-slate-500 text-xs">profit</p>
                            </div>
                          </div>
                          <div className="h-1.5 bg-slate-700 rounded-full overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-pink-500 to-cyan-500 rounded-full"
                              style={{ width: `${Math.min((m.revenue/maxRev)*100,100)}%` }} />
                          </div>
                          <div className="flex justify-between text-xs text-slate-500 mt-1.5">
                            <span>Rev ₹{Math.round(m.revenue).toLocaleString('en-IN')}</span>
                            <span>Payout ₹{Math.round(m.payout).toLocaleString('en-IN')}</span>
                            <span>Cut 💎{(m.platformCutDiamonds ?? 0).toLocaleString('en-IN')}</span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
              <div className="flex justify-end pt-1">
                <Link href="/finance/profit" onClick={() => setOpenModal(null)}
                  className="flex items-center gap-1.5 text-pink-400 hover:text-pink-300 text-sm font-medium transition-colors">
                  Profit Monitoring <ArrowRight size={13} />
                </Link>
              </div>
            </>
          )}
        </InsightModal>
      )}

      {/* Active Live Rooms — placeholder while loading so the area is never blank */}
      {loading && (
        <section aria-hidden="true">
          <div className="h-6 w-40 bg-slate-800 rounded animate-pulse mb-3" />
          <div className="bg-slate-800 border border-slate-700 rounded-xl p-4 space-y-3 animate-pulse">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-4 bg-slate-700 rounded w-full" />
            ))}
          </div>
        </section>
      )}

      {/* A live-room read that was refused is not "nobody is live". Before this
          the section simply vanished, which reads as the quieter of the two. */}
      {!loading && roomsFailure && (
        <section>
          <h2 className="text-lg font-semibold text-white mb-3">Live Right Now</h2>
          <div className="bg-slate-800 border border-yellow-500/30 rounded-xl">
            <UnavailablePanel failure={roomsFailure} what="Active live rooms" />
          </div>
        </section>
      )}

      {!loading && !roomsFailure && rooms.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              Live Right Now
            </h2>
            <Link href="/live" className="text-pink-400 hover:text-pink-300 text-sm flex items-center gap-1 transition-colors">
              View all <ArrowRight size={13} />
            </Link>
          </div>
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-700 text-left">
                  <th className="px-4 py-2.5 text-slate-400 text-xs font-medium uppercase tracking-wide">Host</th>
                  <th className="px-4 py-2.5 text-slate-400 text-xs font-medium uppercase tracking-wide">Title</th>
                  <th className="px-4 py-2.5 text-slate-400 text-xs font-medium uppercase tracking-wide">
                    <Eye size={12} className="inline mr-1" />Viewers
                  </th>
                  <th className="px-4 py-2.5 text-slate-400 text-xs font-medium uppercase tracking-wide">
                    <Zap size={12} className="inline mr-1" />Gifts
                  </th>
                  <th className="px-4 py-2.5 text-slate-400 text-xs font-medium uppercase tracking-wide">Duration</th>
                </tr>
              </thead>
              <tbody>
                {rooms.map(r => (
                  <tr key={r.roomId} className="border-b border-slate-700/50 last:border-0 hover:bg-slate-700/20 transition-colors">
                    <td className="px-4 py-3">
                      <Link href={`/users/${r.hostUid}`} className="text-white hover:text-pink-400 font-medium transition-colors">
                        {r.hostName || '—'}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-400 text-xs truncate max-w-[160px]">{r.title || '—'}</td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1 text-green-300 font-medium">
                        <Eye size={12} />{r.viewerCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-yellow-300 font-medium">{r.totalGiftsReceived.toLocaleString('en-IN')}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs">{sinceStarted(r.startedAt as { toMillis?: () => number } | null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Quick Actions */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {quickActions.map(({ href, label, icon: Icon, desc }) => (
            <Link
              key={href}
              href={href}
              className="bg-slate-800 border border-slate-700 rounded-xl p-4 hover:border-pink-500/50 hover:bg-slate-750 transition-all group flex items-start gap-3"
            >
              <div className="p-2 rounded-lg bg-pink-500/10 group-hover:bg-pink-500/20 transition shrink-0">
                <Icon size={17} className="text-pink-400" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-white text-sm">{label}</p>
                <p className="text-slate-500 text-xs mt-0.5 leading-relaxed">{desc}</p>
              </div>
              <ArrowRight size={14} className="text-slate-600 group-hover:text-pink-400 transition mt-0.5 ml-auto shrink-0" />
            </Link>
          ))}
        </div>
      </section>

      {/* Platform Health Note */}
      {canAccess(crmUser, ['superadmin', 'finance_admin', 'finance_member']) && (
        <div className="flex items-start gap-3 bg-slate-800/50 border border-slate-700 rounded-xl p-4">
          <Shield size={16} className="text-slate-500 mt-0.5 shrink-0" />
          <p className="text-slate-500 text-xs leading-relaxed">
            Revenue is estimated based on diamond transactions at ₹22.90 per 1,000 diamonds.
            Coin sellers purchase wholesale at ₹2,290 per lakh diamonds.
            For accurate profit figures, view <Link href="/finance/profit" className="text-pink-400 hover:text-pink-300 transition-colors">Profit Monitoring</Link>.
          </p>
        </div>
      )}
    </div>
  )
}
