'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, CrmRole } from '@/lib/auth'
import { getReports, getBannedDevices, getOpsTickets, getFeedbackTickets } from '@/lib/operations'
import type { Report } from '@/lib/operations'
import { fromSettled, ok, type ReadResult } from '@/lib/readState'
import { Unavailable, UnavailablePanel } from '@/components/ui/States'
import {
  AlertTriangle,
  ShieldOff,
  MessageSquare,
  FileText,
  ChevronRight,
  Loader2,
  Flag,
  Clock,
  Scale,
} from 'lucide-react'
import { formatIstDate } from '@/lib/istTime'  // QA #54: shown in IST, stored in UTC

const OPS_ROLES: CrmRole[] = ['superadmin', 'ops_admin', 'ops_member']

function formatDate(ts: { seconds: number } | null): string {
  if (!ts) return '—'
  return formatIstDate(ts.seconds * 1000) || '—'
}

export default function OperationsDashboardPage() {
  const { crmUser, loading } = useAuth()
  const router = useRouter()

  // Each summary card owns its own read. Before this the four reads sat in one
  // `Promise.all` inside a `try { } finally { }` with NO catch at all, so any
  // rejection — a refused collection, a missing index, a dropped connection —
  // left all four `useState(0)` counters untouched and the page rendered
  // "0 Open Reports · 0 Pending Feedback · 0 Active Bans · 0 Open Tickets"
  // over an empty table reading "No reports found". Four fabricated numbers
  // and a fabricated absence, with nothing on screen to hint at any of it.
  const [openReports, setOpenReports] = useState<ReadResult<number> | null>(null)
  const [pendingFeedback, setPendingFeedback] = useState<ReadResult<number> | null>(null)
  const [activeBans, setActiveBans] = useState<ReadResult<number> | null>(null)
  const [openTickets, setOpenTickets] = useState<ReadResult<number> | null>(null)
  const [recentReports, setRecentReports] = useState<ReadResult<Report[]> | null>(null)
  const [fetching, setFetching] = useState(true)

  useEffect(() => {
    if (loading) return
    if (!crmUser || !canAccess(crmUser, OPS_ROLES)) {
      router.push('/')
      return
    }
    let cancelled = false
    async function load() {
      const [reports, devices, tickets, feedback] = await Promise.allSettled([
        getReports(),
        getBannedDevices(),
        getOpsTickets(),
        getFeedbackTickets(),
      ])
      if (cancelled) return

      const reportsRead = fromSettled(reports, 'operations/getReports')
      if (reportsRead.ok) {
        setOpenReports(ok(reportsRead.value.filter((r) => r.status === 'pending').length))
        // Most recent 10, pending first
        const sorted = [...reportsRead.value].sort((a, b) => {
          if (a.status === 'pending' && b.status !== 'pending') return -1
          if (b.status === 'pending' && a.status !== 'pending') return 1
          return (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0)
        })
        setRecentReports(ok(sorted.slice(0, 10)))
      } else {
        setOpenReports(reportsRead)
        setRecentReports(reportsRead)
      }

      const devicesRead = fromSettled(devices, 'operations/getBannedDevices')
      setActiveBans(devicesRead.ok ? ok(devicesRead.value.filter((d) => d.isActive).length) : devicesRead)

      const ticketsRead = fromSettled(tickets, 'operations/getOpsTickets')
      setOpenTickets(ticketsRead.ok ? ok(ticketsRead.value.filter((t) => t.status === 'open').length) : ticketsRead)

      const feedbackRead = fromSettled(feedback, 'operations/getFeedbackTickets')
      setPendingFeedback(feedbackRead.ok ? ok(feedbackRead.value.filter((f) => f.status === 'open').length) : feedbackRead)

      setFetching(false)
    }
    load()
    return () => { cancelled = true }
  }, [loading, crmUser, router])

  if (loading || fetching) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="animate-spin text-pink-500" size={32} />
      </div>
    )
  }

  const statusStyles: Record<string, string> = {
    pending:  'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
    reviewed: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
    actioned: 'bg-green-500/20 text-green-400 border border-green-500/30',
  }

  const targetBadge = (type: string) =>
    type === 'host'
      ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
      : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Operations</h1>
        <p className="text-slate-400 text-sm mt-1">
          Manage reports, device bans, feedback, and operational tickets
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <SummaryCard
          icon={<Flag size={22} className="text-yellow-400" />}
          label="Open Reports"
          result={openReports}
          color="yellow"
        />
        <SummaryCard
          icon={<MessageSquare size={22} className="text-blue-400" />}
          label="Pending Feedback"
          result={pendingFeedback}
          color="blue"
        />
        <SummaryCard
          icon={<ShieldOff size={22} className="text-red-400" />}
          label="Active Bans"
          result={activeBans}
          color="red"
        />
        <SummaryCard
          icon={<FileText size={22} className="text-green-400" />}
          label="Open Tickets"
          result={openTickets}
          color="green"
        />
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[
          { href: '/operations/reports',  label: 'Report Queue',     desc: 'Review user & host reports',      icon: AlertTriangle, color: 'text-yellow-400' },
          { href: '/operations/appeals',  label: 'Appeals',          desc: 'Somebody says we got it wrong',   icon: Scale,         color: 'text-pink-400'   },
          { href: '/operations/bans',     label: 'Device Bans',      desc: 'Manage banned device IDs',        icon: ShieldOff,     color: 'text-red-400'    },
          { href: '/operations/feedback', label: 'App Feedback',     desc: 'Monitor in-app feedback tickets', icon: MessageSquare, color: 'text-blue-400'   },
          { href: '/feedback',            label: 'Feedback & Support', desc: 'Answer what app users filed',   icon: FileText,      color: 'text-green-400'  },
        ].map(({ href, label, desc, icon: Icon, color }) => (
          <Link
            key={href}
            href={href}
            className="bg-zinc-800 border border-zinc-700 rounded-xl p-5 hover:border-pink-500/50 hover:bg-zinc-800/80 transition-all group flex items-start gap-4"
          >
            <Icon size={20} className={color} />
            <div className="flex-1">
              <p className="text-white font-medium text-sm">{label}</p>
              <p className="text-slate-400 text-xs mt-0.5">{desc}</p>
            </div>
            <ChevronRight size={16} className="text-slate-600 group-hover:text-slate-300 mt-0.5 transition-colors" />
          </Link>
        ))}
      </div>

      {/* Recent Reports Table */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-zinc-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-slate-400" />
            <h2 className="text-white font-semibold text-sm">Recent Reports</h2>
            <span className="text-xs text-slate-500">(last 10, pending first)</span>
          </div>
          <Link
            href="/operations/reports"
            className="text-pink-400 hover:text-pink-300 text-xs font-medium flex items-center gap-1 transition-colors"
          >
            View all <ChevronRight size={13} />
          </Link>
        </div>

        {/* "No reports found." is a claim about the report queue. It is only
            made when the queue was actually read. */}
        {recentReports && !recentReports.ok ? (
          <UnavailablePanel failure={recentReports} what="The report queue" />
        ) : !recentReports || recentReports.value.length === 0 ? (
          <div className="px-6 py-12 text-center text-slate-500 text-sm">No reports found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-700">
                  {['Reporter', 'Target', 'Reason', 'Date', 'Status'].map((h) => (
                    <th key={h} className="text-left px-5 py-3 text-xs font-medium text-slate-400 uppercase tracking-wide">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recentReports.value.map((r) => (
                  <tr key={r.id} className="border-b border-zinc-700/50 hover:bg-zinc-700/30 transition-colors">
                    <td className="px-5 py-3 text-slate-200">{r.reporterName}</td>
                    <td className="px-5 py-3">
                      <span className="text-slate-200">{r.targetName}</span>
                      <span className={`ml-2 text-xs px-1.5 py-0.5 rounded font-medium ${targetBadge(r.targetType)}`}>
                        {r.targetType}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-slate-300 max-w-[200px] truncate">{r.reason}</td>
                    <td className="px-5 py-3 text-slate-400 whitespace-nowrap">{formatDate(r.createdAt)}</td>
                    <td className="px-5 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusStyles[r.status] ?? ''}`}>
                        {r.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

function SummaryCard({
  icon,
  label,
  result,
  color,
}: {
  icon: React.ReactNode
  label: string
  /** `null` only before the read settles; the page gates on `fetching` first. */
  result: ReadResult<number> | null
  color: 'yellow' | 'blue' | 'red' | 'green'
}) {
  const borderColor = {
    yellow: 'border-yellow-500/30',
    blue:   'border-blue-500/30',
    red:    'border-red-500/30',
    green:  'border-green-500/30',
  }[color]

  const failed = result !== null && !result.ok

  return (
    <div className={`bg-zinc-800 border ${failed ? 'border-yellow-500/40' : borderColor} rounded-xl p-5 flex items-center gap-4`}>
      <div className="flex-shrink-0">{icon}</div>
      <div className="min-w-0">
        {result === null ? (
          <div className="h-7 w-16 bg-zinc-700 rounded animate-pulse" />
        ) : result.ok ? (
          <p className="text-2xl font-bold text-white">{result.value.toLocaleString('en-IN')}</p>
        ) : (
          <Unavailable failure={result} />
        )}
        <p className="text-slate-400 text-xs mt-0.5">{label}</p>
      </div>
    </div>
  )
}
