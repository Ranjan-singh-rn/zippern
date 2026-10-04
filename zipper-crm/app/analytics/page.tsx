'use client'

import { useState, useEffect, useCallback } from 'react'
import { db } from '@/lib/firebase'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { useRouter } from 'next/navigation'
import {
  getDocs,
  query,
  collection,
  where,
  orderBy,
  limit,
} from 'firebase/firestore'
import type { DocumentData, QuerySnapshot } from 'firebase/firestore'
import {
  countUsers,
  countHosts,
  countAgents,
  countSellers,
  countActiveLiveRooms,
  getHosts,
} from '@/lib/firestore'
import {
  getPlatformRevenueDays,
  invalidatePlatformRevenueCache,
} from '@/lib/finance'
import { getRates } from '@/lib/rates'
import {
  attempt, firstFailure, ok,
  type ReadFailure, type ReadResult,
} from '@/lib/readState'
import { Unavailable, UnavailablePanel, UnavailableInline } from '@/components/ui/States'
import {
  LineChart,
  BarChart,
  PieChart,
  Line,
  Bar,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  AreaChart,
  Area,
} from 'recharts'
import {
  Users,
  Star,
  Radio,
  ShoppingBag,
  UserCheck,
  TrendingUp,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react'

const COLORS = {
  primary: '#ec4899',
  secondary: '#8b5cf6',
  tertiary: '#22c55e',
  accent: '#3b82f6',
  warn: '#f59e0b',
}

const PIE_COLORS = ['#ec4899', '#8b5cf6', '#22c55e', '#3b82f6']

const tooltipStyle = {
  backgroundColor: '#1e293b',
  border: '1px solid #334155',
  borderRadius: '8px',
}

/**
 * `createdAt` is a Firestore Timestamp for CRM-created docs but an epoch-millis
 * number for documents written by the Android app (see its `User` model), so
 * accept both instead of dropping half the rows.
 */
function toDate(value: unknown): Date | null {
  if (!value) return null
  if (typeof value === 'number') return new Date(value)
  if (typeof value === 'string') {
    const d = new Date(value)
    return isNaN(d.getTime()) ? null : d
  }
  const ts = value as { toDate?: () => Date }
  return typeof ts.toDate === 'function' ? ts.toDate() : null
}

/**
 * Top 10 hosts by beans. The ideal query (isHost == true, orderBy beans desc)
 * needs a composite index that is not declared in firestore.indexes.json, so
 * fall back to a bounded host list sorted client-side rather than rendering an
 * empty chart.
 */
async function fetchTopHosts(): Promise<{ name: string; beans: number }[]> {
  try {
    const snap = await getDocs(
      query(
        collection(db, 'users'),
        where('isHost', '==', true),
        orderBy('beans', 'desc'),
        limit(10)
      )
    )
    if (snap.size > 0) {
      return snap.docs.map((d) => ({
        name: d.data().name || 'Unknown',
        beans: d.data().beans || 0,
      }))
    }
  } catch (err) {
    console.error('analytics: top-hosts index query failed, falling back', err)
  }
  const hosts = await getHosts()
  return hosts
    .map((h) => ({ name: h.name || 'Unknown', beans: h.beans || 0 }))
    .sort((a, b) => b.beans - a.beans)
    .slice(0, 10)
}

// ── Per-figure states ────────────────────────────────────────────────────────

interface GrowthPoint { date: string; count: number }
interface MonthPoint { month: string; amount: number }
interface HostBeans { name: string; beans: number }
interface RoleSlice { name: string; value: number }

/**
 * Every figure on this page, each one either read or refused.
 *
 * This replaces eleven `useState(0)` / `useState([])` fields that were filled
 * by a `safe(promise, fallback)` helper. `safe` caught the rejection, logged it
 * to a console nobody has open, and handed the fallback to the renderer, which
 * could not tell it from a measurement. The most consequential case:
 * `platformRevenue` is `isFinance() || isAdmin()` in the rules while the nav
 * offers this page to `app_member` and `ops_member` too, so those two roles were
 * shown "₹0" for Total Revenue and an empty Revenue by Month chart on every
 * visit. Neither was a fact about revenue; both were the database saying no.
 */
interface AnalyticsData {
  totalUsers: ReadResult<number>
  totalHosts: ReadResult<number>
  totalSellers: ReadResult<number>
  totalAgents: ReadResult<number>
  activeLive: ReadResult<number>
  totalRevenue: ReadResult<number>
  userGrowth: ReadResult<GrowthPoint[]>
  revenueByMonth: ReadResult<MonthPoint[]>
  topHosts: ReadResult<HostBeans[]>
  roleDistribution: ReadResult<RoleSlice[]>
}

const CARD = 'bg-slate-800 border rounded-xl p-5'

/** A KPI tile. Shows the number, or why there is no number. Never both, never neither. */
function Kpi({
  icon, label, result, format,
}: {
  icon: React.ReactNode
  label: string
  result: ReadResult<number>
  format?: (n: number) => string
}) {
  return (
    <div className={`${CARD} flex flex-col gap-2 ${result.ok ? 'border-slate-700' : 'border-yellow-500/30'}`}>
      <div className="flex items-center justify-between">{icon}</div>
      {result.ok ? (
        <>
          <span className="text-2xl font-bold text-white">
            {(format ?? ((n: number) => n.toLocaleString('en-IN')))(result.value)}
          </span>
          <span className="text-xs text-slate-400">{label}</span>
        </>
      ) : (
        <>
          <span className="text-xs text-slate-400">{label}</span>
          <Unavailable failure={result} />
        </>
      )}
    </div>
  )
}

/**
 * A row of the Role Breakdown list. The share column needs BOTH this count and
 * the user total, so it is withheld whenever either is missing — a percentage
 * of an unknown denominator is worse than no percentage.
 */
function BreakdownRow({
  dot, label, result, total, unit,
}: {
  dot: string
  label: string
  result: ReadResult<number>
  total?: ReadResult<number>
  unit?: string
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className={`h-3 w-3 rounded-full flex-shrink-0 ${dot}`} />
        <span className="text-sm text-slate-300">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        {result.ok ? (
          <>
            <span className="text-sm font-semibold text-white">{result.value.toLocaleString('en-IN')}</span>
            <span className="text-xs text-slate-500">
              {unit ??
                (total && total.ok && total.value > 0
                  ? `${((result.value / total.value) * 100).toFixed(1)}%`
                  : '')}
            </span>
          </>
        ) : (
          <>
            <span className="text-sm font-semibold text-slate-500">—</span>
            <UnavailableInline failure={result} />
          </>
        )}
      </div>
    </div>
  )
}

/** A chart card that either draws its chart, or explains why it cannot. */
function ChartCard<T>({
  title, result, what, onRetry, empty, children,
}: {
  title: string
  result: ReadResult<T[]>
  what: string
  onRetry?: () => void
  empty?: string
  children: (rows: T[]) => React.ReactElement
}) {
  return (
    <div className={`${CARD} ${result.ok ? 'border-slate-700' : 'border-yellow-500/30'}`}>
      <h2 className="text-base font-semibold text-white mb-4">{title}</h2>
      {!result.ok ? (
        <UnavailablePanel failure={result} what={what} onRetry={onRetry} />
      ) : result.value.length === 0 ? (
        // Genuinely nothing to plot — a real, measured absence, and said as one.
        <p className="text-slate-500 text-sm text-center py-16">
          {empty ?? 'No data recorded for this period yet.'}
        </p>
      ) : (
        children(result.value)
      )}
    </div>
  )
}

export default function AnalyticsPage() {
  const { crmUser, loading: authLoading } = useAuth()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [data, setData] = useState<AnalyticsData | null>(null)
  /** Set only if the whole fetch fell over — distinct from any one read failing. */
  const [fatal, setFatal] = useState<ReadFailure | null>(null)

  useEffect(() => {
    if (authLoading) return
    if (!canAccess(crmUser, ['superadmin', 'app_admin', 'app_member', 'finance_admin', 'finance_member', 'ops_admin', 'ops_member'])) {
      router.replace('/')
    }
  }, [authLoading, crmUser, router])

  const fetchData = useCallback(async () => {
    setLoading(true)
    setFatal(null)
    // The Refresh button must actually refresh, not re-read the memo.
    invalidatePlatformRevenueCache()
    try {
      // Each figure is fetched independently and reports for itself. Previously
      // a single failing query (e.g. the hosts-by-beans query, which needs a
      // composite index that is not declared in firestore.indexes.json) threw
      // out of Promise.all and blanked the ENTIRE page to zeros; then `safe()`
      // fixed the blanking by making every refusal print as a zero instead,
      // which is the same lie told more confidently. `attempt()` keeps the
      // independence and keeps the refusal.
      const [
        totalUsers,
        totalHosts,
        totalSellers,
        totalAgents,
        activeLive,
        revenueDays,
        recentUsers,
        topHosts,
      ] = await Promise.all([
        // Counts use Firestore's server-side count aggregation — no documents
        // are downloaded, and the numbers are no longer capped by a limit().
        attempt(countUsers(), 'analytics/countUsers'),
        attempt(countHosts(), 'analytics/countHosts'),
        attempt(countSellers(), 'analytics/countSellers'),
        attempt(countAgents(), 'analytics/countAgents'),
        attempt(countActiveLiveRooms(), 'analytics/countActiveLiveRooms'),
        // `platformRevenue` — isFinance() || isAdmin(). This is the read that
        // an app_member or ops_member is refused, and the one that used to be
        // rendered to them as ₹0.
        attempt(getPlatformRevenueDays(), 'analytics/platformRevenue'),
        attempt<QuerySnapshot<DocumentData>>(
          getDocs(query(collection(db, 'users'), orderBy('createdAt', 'desc'), limit(500))),
          'analytics/recentUsers'
        ),
        attempt(fetchTopHosts(), 'analytics/topHosts'),
      ])

      // Live rate from Economy Config, not a constant — the two disagreed, and
      // the constant was the one being used. `getRates()` resolves in every
      // case (it falls back to documented defaults and flags `isFallback`), so
      // it is not a read that can be refused and needs no result wrapper.
      const rates = await getRates()

      // Revenue — `platformRevenue` has two document shapes and neither carries
      // an `amount` field, which is why summing `data.amount` always yielded ₹0.
      // getPlatformRevenueDays() reads both shapes and returns diamonds per day;
      // we convert to ₹ with the same rate the Finance pages use.
      let totalRevenue: ReadResult<number>
      let revenueByMonth: ReadResult<MonthPoint[]>
      if (revenueDays.ok) {
        let revTotal = 0
        const monthMap: Record<string, number> = {}
        for (const day of revenueDays.value) {
          // Wholesale: revenue is what Zipper was paid for those diamonds.
          const inr = day.diamondSpend * rates.sellerWholesalePerDiamond
          revTotal += inr
          const [yr, mo] = day.date.split('-')
          const monthKey = new Date(Number(yr), Number(mo) - 1, 1)
            .toLocaleString('default', { month: 'short', year: 'numeric' })
          monthMap[monthKey] = (monthMap[monthKey] || 0) + inr
        }
        totalRevenue = ok(revTotal)
        revenueByMonth = ok(
          Object.entries(monthMap)
            .map(([month, amount]) => ({ month, amount }))
            .sort((a, b) => new Date(a.month).getTime() - new Date(b.month).getTime())
        )
      } else {
        // One refusal, reported against both figures it would have fed.
        totalRevenue = revenueDays
        revenueByMonth = revenueDays
      }

      // User growth: last 30 days. The zero-filled buckets below are honest
      // only when the read succeeded — a day with no signups really is 0. When
      // the read was refused there are no buckets at all, because a flat line
      // at zero across thirty days is a very loud claim to make about a
      // database we were not allowed to open.
      let userGrowth: ReadResult<GrowthPoint[]>
      if (recentUsers.ok) {
        const today = new Date()
        today.setHours(23, 59, 59, 999)
        const thirtyDaysAgo = new Date()
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29)
        thirtyDaysAgo.setHours(0, 0, 0, 0)

        const dailyMap: Record<string, number> = {}
        for (let i = 0; i < 30; i++) {
          const d = new Date()
          d.setDate(d.getDate() - (29 - i))
          dailyMap[d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })] = 0
        }

        for (const docSnap of recentUsers.value.docs) {
          const createdAt = toDate(docSnap.data().createdAt)
          if (createdAt && createdAt >= thirtyDaysAgo && createdAt <= today) {
            const key = createdAt.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })
            if (key in dailyMap) dailyMap[key] += 1
          }
        }
        userGrowth = ok(Object.entries(dailyMap).map(([date, count]) => ({ date, count })))
      } else {
        userGrowth = recentUsers
      }

      // Role distribution is one figure made of four reads. A pie drawn from
      // three of them would show wrong proportions and look entirely normal
      // doing it, so if any slice is missing the chart is withheld and the
      // missing ones are named.
      const roleDistribution: ReadResult<RoleSlice[]> =
        totalUsers.ok && totalHosts.ok && totalAgents.ok && totalSellers.ok
          ? ok([
              { name: 'Users', value: totalUsers.value },
              { name: 'Hosts', value: totalHosts.value },
              { name: 'Agents', value: totalAgents.value },
              { name: 'Sellers', value: totalSellers.value },
            ])
          : (firstFailure(totalUsers, totalHosts, totalAgents, totalSellers) ?? {
              ok: false,
              code: 'unknown',
              reason: 'One of the four role counts did not come back.',
            })

      setData({
        totalUsers,
        totalHosts,
        totalSellers,
        totalAgents,
        activeLive,
        totalRevenue,
        userGrowth,
        revenueByMonth,
        topHosts,
        roleDistribution,
      })
      setLastUpdated(new Date())
    } catch (error) {
      // Nothing above should reach here — every read is already captured — but
      // if the batch itself fails the page says so rather than showing a grid
      // of stale or absent figures.
      setData(null)
      setFatal({
        ok: false,
        code: 'unknown',
        reason: error instanceof Error ? error.message : 'The analytics reads could not be started.',
      })
      console.error('analytics: fetch failed outright', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 p-6 space-y-6">
        {/* Header skeleton */}
        <div className="flex items-center justify-between">
          <div className="h-8 w-40 animate-pulse bg-slate-700 rounded" />
          <div className="h-8 w-32 animate-pulse bg-slate-700 rounded" />
        </div>

        {/* KPI skeleton */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="bg-slate-800 border border-slate-700 rounded-xl p-5 flex flex-col gap-2">
              <div className="h-5 w-5 animate-pulse bg-slate-700 rounded" />
              <div className="h-8 w-16 animate-pulse bg-slate-700 rounded" />
              <div className="h-4 w-24 animate-pulse bg-slate-700 rounded" />
            </div>
          ))}
        </div>

        {/* Chart skeletons */}
        <div className="grid lg:grid-cols-2 gap-6">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="bg-slate-800 border border-slate-700 rounded-xl p-5">
              <div className="h-6 w-48 animate-pulse bg-slate-700 rounded mb-4" />
              <div className="h-64 animate-pulse bg-slate-700 rounded" />
            </div>
          ))}
        </div>

        {/* Top hosts skeleton */}
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
          <div className="h-6 w-56 animate-pulse bg-slate-700 rounded mb-4" />
          <div className="h-96 animate-pulse bg-slate-700 rounded" />
        </div>

        {/* Role distribution skeleton */}
        <div className="grid lg:grid-cols-2 gap-6">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="bg-slate-800 border border-slate-700 rounded-xl p-5">
              <div className="h-6 w-40 animate-pulse bg-slate-700 rounded mb-4" />
              <div className="h-64 animate-pulse bg-slate-700 rounded" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const header = (
    <div className="flex flex-row items-center justify-between">
      <div>
        <h1 className="text-2xl font-bold text-white">Analytics</h1>
        {lastUpdated && (
          <p className="text-sm text-slate-400 mt-1">
            Last updated: {lastUpdated.toLocaleTimeString()}
          </p>
        )}
      </div>
      <button
        onClick={fetchData}
        className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white px-4 py-2 rounded-lg transition-colors duration-200"
      >
        <RefreshCw className="h-4 w-4 text-pink-500" />
        <span className="text-sm font-medium">Refresh</span>
      </button>
    </div>
  )

  // The batch itself failed. Not one figure survived, so not one is shown.
  if (fatal || !data) {
    return (
      <div className="min-h-screen bg-slate-950 p-6 space-y-6">
        {header}
        <div className={`${CARD} border-yellow-500/30`}>
          <UnavailablePanel
            failure={fatal ?? { ok: false, code: 'unknown', reason: 'No analytics were loaded.' }}
            what="Analytics"
            onRetry={fetchData}
          />
        </div>
      </div>
    )
  }

  // Which reads were refused, so the page can lead with one honest line rather
  // than making the reader piece it together from six separate tiles.
  const refused = (
    [
      ['Total Users', data.totalUsers],
      ['Total Hosts', data.totalHosts],
      ['Active Live Rooms', data.activeLive],
      ['Coin Sellers', data.totalSellers],
      ['Agents', data.totalAgents],
      ['Total Revenue', data.totalRevenue],
      ['User Growth', data.userGrowth],
      ['Revenue by Month', data.revenueByMonth],
      ['Top Hosts', data.topHosts],
    ] as [string, ReadResult<unknown>][]
  ).filter(([, r]) => !r.ok)

  const anyDenied = refused.some(([, r]) => !r.ok && r.code === 'permission-denied')

  return (
    <div className="min-h-screen bg-slate-950 p-6 space-y-6">
      {header}

      {/* One banner naming everything that could not be read. `app_member` and
          `ops_member` reach this page from the nav but are refused
          `platformRevenue` by the rules, and used to be shown ₹0 instead. */}
      {refused.length > 0 && (
        <div className="flex items-start gap-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-5 py-4">
          <AlertTriangle size={16} className="text-yellow-400 mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="text-yellow-300 font-semibold">
              {refused.length} of these figures could not be read — they are not zero
            </p>
            <p className="text-yellow-100/70 mt-1">
              {refused.map(([label]) => label).join(' · ')}
            </p>
            {anyDenied && (
              <p className="text-slate-400 text-xs mt-1.5">
                At least one was refused by your role&rsquo;s permissions. Refreshing will not
                change that — ask an owner if you need it.
              </p>
            )}
          </div>
        </div>
      )}

      {/* KPI Cards Row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <Kpi
          icon={<Users className="h-5 w-5 text-pink-500" />}
          label="Total Users"
          result={data.totalUsers}
        />
        <Kpi
          icon={<Star className="h-5 w-5 text-purple-500" />}
          label="Total Hosts"
          result={data.totalHosts}
        />
        <Kpi
          icon={<Radio className="h-5 w-5 text-green-500" />}
          label="Active Live Rooms"
          result={data.activeLive}
        />
        <Kpi
          icon={<ShoppingBag className="h-5 w-5 text-blue-500" />}
          label="Coin Sellers"
          result={data.totalSellers}
        />
        <Kpi
          icon={<UserCheck className="h-5 w-5 text-amber-500" />}
          label="Agents"
          result={data.totalAgents}
        />
        <Kpi
          icon={<TrendingUp className="h-5 w-5 text-pink-500" />}
          label="Total Revenue"
          result={data.totalRevenue}
          format={(n) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
        />
      </div>

      {/* User Growth + Revenue by Month */}
      <div className="grid lg:grid-cols-2 gap-6">
        <ChartCard
          title="User Growth (30 Days)"
          result={data.userGrowth}
          what="User growth"
          onRetry={fetchData}
          empty="No users have signed up in the last 30 days."
        >
          {(rows) => (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <defs>
                  <linearGradient id="userGrowthGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#ec4899" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#ec4899" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  interval={4}
                />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: '#e2e8f0' }}
                  itemStyle={{ color: '#ec4899' }}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="#ec4899"
                  strokeWidth={2}
                  fill="url(#userGrowthGradient)"
                  dot={false}
                  activeDot={{ r: 4, fill: '#ec4899' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* An empty bar chart and a refused one looked identical here. They no
            longer do — this is the tile the owner was reading as "no revenue". */}
        <ChartCard
          title="Revenue by Month"
          result={data.revenueByMonth}
          what="Revenue by month"
          onRetry={fetchData}
          empty="No revenue has been recorded yet."
        >
          {(rows) => (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={rows} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                <XAxis
                  dataKey="month"
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: '#e2e8f0' }}
                  itemStyle={{ color: '#8b5cf6' }}
                />
                <Bar dataKey="amount" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </ChartCard>
      </div>

      {/* Top 10 Hosts by Beans */}
      <ChartCard
        title="Top 10 Hosts by Beans"
        result={data.topHosts}
        what="Top hosts by beans"
        onRetry={fetchData}
        empty="No hosts have earned beans yet."
      >
        {(rows) => (
          <ResponsiveContainer width="100%" height={400}>
            <BarChart
              layout="vertical"
              data={rows}
              margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" horizontal={false} />
              <XAxis
                type="number"
                dataKey="beans"
                tick={{ fill: '#64748b', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fill: '#94a3b8', fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                width={100}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: '#e2e8f0' }}
                itemStyle={{ color: '#ec4899' }}
              />
              <Bar dataKey="beans" fill="#ec4899" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </ChartCard>

      {/* Role Distribution + Stats List */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* A pie missing one of its four slices misstates all the others while
            looking perfectly normal, so it is withheld whole. */}
        <ChartCard
          title="Role Distribution"
          result={data.roleDistribution}
          what="Role distribution"
          onRetry={fetchData}
          empty="No users, hosts, agents or sellers recorded yet."
        >
          {(rows) => (
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={rows} cx="50%" cy="45%" outerRadius={90} dataKey="value" strokeWidth={0}>
                  {rows.map((entry, index) => (
                    <Cell key={`cell-${entry.name}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: '#e2e8f0' }}
                  itemStyle={{ color: '#e2e8f0' }}
                />
                <Legend
                  verticalAlign="bottom"
                  iconType="circle"
                  iconSize={8}
                  formatter={(value) => (
                    <span style={{ color: '#94a3b8', fontSize: '12px' }}>{value}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </ChartCard>

        {/* Stats List — per-row, because these five reads fail independently */}
        <div className={`${CARD} border-slate-700`}>
          <h2 className="text-base font-semibold text-white mb-4">Role Breakdown</h2>
          <div className="flex flex-col gap-4 mt-2">
            <BreakdownRow
              dot="bg-pink-500"
              label="Total Users"
              result={data.totalUsers}
              unit="users"
            />
            <BreakdownRow
              dot="bg-purple-500"
              label="Hosts"
              result={data.totalHosts}
              total={data.totalUsers}
            />
            <BreakdownRow
              dot="bg-green-500"
              label="Agents"
              result={data.totalAgents}
              total={data.totalUsers}
            />
            <BreakdownRow
              dot="bg-blue-500"
              label="Coin Sellers"
              result={data.totalSellers}
              total={data.totalUsers}
            />
            <BreakdownRow
              dot="bg-amber-500"
              label="Active Live Rooms"
              result={data.activeLive}
              unit="live now"
            />

            {/* Revenue */}
            <div className="mt-2 pt-4 border-t border-slate-700 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <TrendingUp className="h-4 w-4 text-pink-500" />
                <span className="text-sm text-slate-300">Total Revenue</span>
              </div>
              {data.totalRevenue.ok ? (
                <span className="text-sm font-bold text-pink-400">
                  ₹{data.totalRevenue.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="text-sm font-bold text-slate-500">—</span>
                  <UnavailableInline failure={data.totalRevenue} />
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
