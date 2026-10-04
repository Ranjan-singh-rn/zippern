'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { getTechTickets, getGifts, getLevels, TechTicket, Gift, Level } from '@/lib/tech'
import { Bug, Layers, Gift as GiftIcon, CreditCard, ChevronRight, Loader2, AlertTriangle, Clock, CheckCircle2, GitPullRequest, Sliders } from 'lucide-react'
import { fromSettled, ok, type ReadResult } from '@/lib/readState'
import { Unavailable, UnavailablePanel } from '@/components/ui/States'

function StatCard({ label, result, color }: { label: string; result: ReadResult<number>; color: string }) {
  return (
    <div className={`bg-zinc-800 border rounded-xl p-5 ${result.ok ? 'border-zinc-700' : 'border-yellow-500/40'}`}>
      <p className="text-zinc-400 text-sm">{label}</p>
      {result.ok ? (
        <p className={`text-3xl font-bold mt-1 ${color}`}>{result.value.toLocaleString('en-IN')}</p>
      ) : (
        <Unavailable failure={result} />
      )}
    </div>
  )
}

export default function TechDashboard() {
  const { crmUser, loading: authLoading } = useAuth()
  // Lists, not counts, but the failure mode was the same: `.catch(console.error)`
  // left all three at `[]` and the six stat cards below — every one of them
  // `list.filter(…).length` — rendered a confident `0`. Three refused reads
  // presented as "no open tickets, no gifts, no levels configured".
  const [tickets, setTickets] = useState<ReadResult<TechTicket[]>>(ok([]))
  const [gifts, setGifts] = useState<ReadResult<Gift[]>>(ok([]))
  const [levels, setLevels] = useState<ReadResult<Level[]>>(ok([]))
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, ['superadmin', 'tech_admin', 'tech_member'])) return
    let cancelled = false
    Promise.allSettled([getTechTickets(), getGifts(), getLevels()]).then(([t, g, l]) => {
      if (cancelled) return
      setTickets(fromSettled(t, 'tech/getTechTickets'))
      setGifts(fromSettled(g, 'tech/getGifts'))
      setLevels(fromSettled(l, 'tech/getLevels'))
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [crmUser])

  /** Count a subset of a list, or carry the list's failure forward unchanged. */
  const tally = <T,>(r: ReadResult<T[]>, pred: (x: T) => boolean): ReadResult<number> =>
    r.ok ? ok(r.value.filter(pred).length) : r

  const open = tally(tickets, (t) => t.status === 'open')
  const inProgress = tally(tickets, (t) => t.status === 'in_progress')
  const review = tally(tickets, (t) => t.status === 'review')
  const done = tally(tickets, (t) => t.status === 'done')
  const critical = tally(tickets, (t) => t.priority === 'critical')
  const totalGifts = tally(gifts, () => true)
  const activeGifts = tally(gifts, (g) => g.isActive)
  const totalLevels = tally(levels, () => true)
  const highPriority = tickets.ok
    ? tickets.value.filter((t) => ['critical', 'high'].includes(t.priority) && t.status !== 'done')
    : []

  if (authLoading) return <div className="flex items-center justify-center min-h-screen"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" /></div>

  if (!crmUser || !canAccess(crmUser, ['superadmin', 'tech_admin', 'tech_member'])) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-zinc-400">Access denied.</p>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white">Tech Dashboard</h1>
        <p className="text-zinc-400 mt-1">Tickets, content management, and payment configuration</p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-400 py-12 justify-center">
          <Loader2 size={20} className="animate-spin" />
          <span>Loading...</span>
        </div>
      ) : (
        <>
          {/* Ticket stats */}
          <section>
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <Bug size={18} className="text-pink-400" />
              Ticket Overview
            </h2>
            {!tickets.ok ? (
              <div className="bg-zinc-800 border border-yellow-500/40 rounded-xl">
                <UnavailablePanel failure={tickets} what="The ticket board" />
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <StatCard label="Open" result={open} color="text-blue-400" />
                  <StatCard label="In Progress" result={inProgress} color="text-yellow-400" />
                  <StatCard label="In Review" result={review} color="text-purple-400" />
                  <StatCard label="Done" result={done} color="text-green-400" />
                </div>
                {/* "No critical tickets" is not something an unread board can
                    tell us, so the banner is gated on the read succeeding. */}
                {critical.ok && critical.value > 0 && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 flex items-center gap-3">
                    <AlertTriangle size={18} className="text-red-400 flex-shrink-0" />
                    <p className="text-red-300 text-sm font-medium">
                      {critical.value} critical ticket{critical.value > 1 ? 's' : ''} require immediate attention
                    </p>
                  </div>
                )}
              </>
            )}
          </section>

          {/* Content stats */}
          <section>
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <GiftIcon size={18} className="text-pink-400" />
              Content Stats
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <StatCard label="Total Gifts" result={totalGifts} color="text-pink-400" />
              <StatCard label="Active Gifts" result={activeGifts} color="text-green-400" />
              <StatCard label="Levels Configured" result={totalLevels} color="text-cyan-400" />
            </div>
          </section>

          {/* Quick links */}
          <section>
            <h2 className="text-lg font-semibold text-white mb-4">Quick Access</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {[
                { href: '/tech/tickets',    label: 'Ticket Board',   desc: 'Kanban-style ticket management', icon: Bug,     color: 'text-blue-400' },
                { href: '/tech/content',    label: 'Content Config', desc: 'Gifts, levels, profile cards',  icon: Layers,  color: 'text-purple-400' },
                { href: '/tech/payments',   label: 'Payment Config', desc: 'Per-country payment methods',   icon: CreditCard, color: 'text-green-400' },
                { href: '/tech/appcontrol', label: 'App Control',    desc: 'Maintenance, force update, feature flags', icon: Sliders, color: 'text-pink-400' },
              ].map(({ href, label, desc, icon: Icon, color }) => (
                <Link
                  key={href}
                  href={href}
                  className="bg-zinc-800 border border-zinc-700 rounded-xl p-5 hover:border-pink-500/50 hover:bg-zinc-800/80 transition-all group"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className={`mb-2 ${color}`}>
                        <Icon size={22} />
                      </div>
                      <p className="text-white font-semibold">{label}</p>
                      <p className="text-zinc-400 text-sm mt-1">{desc}</p>
                    </div>
                    <ChevronRight size={18} className="text-zinc-600 group-hover:text-pink-400 transition-colors" />
                  </div>
                </Link>
              ))}
            </div>
          </section>

          {/* Recent critical/high tickets. Absent when the board could not be
              read — the refusal is already reported above, once. */}
          {tickets.ok && highPriority.length > 0 && (
            <section>
              <h2 className="text-lg font-semibold text-white mb-4">High Priority Open Tickets</h2>
              <div className="space-y-2">
                {highPriority
                  .slice(0, 5)
                  .map((t) => (
                    <div key={t.id} className="bg-zinc-800 border border-zinc-700 rounded-lg px-4 py-3 flex items-center gap-3">
                      {t.priority === 'critical' ? (
                        <AlertTriangle size={15} className="text-red-400 flex-shrink-0" />
                      ) : (
                        <Clock size={15} className="text-orange-400 flex-shrink-0" />
                      )}
                      <span className="text-white text-sm font-medium flex-1 truncate">{t.title}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        t.priority === 'critical' ? 'bg-red-500/20 text-red-300' : 'bg-orange-500/20 text-orange-300'
                      }`}>{t.priority}</span>
                      <span className="text-xs text-zinc-500 capitalize">{t.status.replace('_', ' ')}</span>
                    </div>
                  ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
