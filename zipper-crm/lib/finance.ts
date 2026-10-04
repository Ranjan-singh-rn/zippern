import {
  collection,
  doc,
  getDocs,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp,
  getDoc,
  collectionGroup,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getRates, ratesNow, type Rates } from '@/lib/rates'

// ── Types ────────────────────────────────────────────────────────────────────

export interface WeeklyPayoutReport {
  id: string
  weekStart: string
  weekEnd: string
  agencyId: string
  agencyName: string
  agencyOwnerUid: string
  status: 'generated' | 'submitted' | 'approved' | 'rejected'
  totalHostCount: number
  totalBeansEarned: number
  totalPayout: number
  submittedAt?: Timestamp | null
  screenshotUrl?: string
  approvedBy?: string
  approvedAt?: Timestamp | null
  rejectedReason?: string
  createdAt: Timestamp | null
}

export interface HostPayout {
  id: string
  reportId: string
  agencyId: string
  hostUid: string
  hostName: string
  beansEarned: number
  payoutAmount: number
  transactionScreenshotUrl?: string
  agencyOwnerUid: string
  weekStart: string
  weekEnd: string
  status: 'pending' | 'paid'
}

export interface RevenueRecord {
  id: string
  date: string
  diamondsSold: number
  totalRevenue: number
  totalPayout: number
  profit: number
  createdAt: Timestamp | null
}

// ── Weekly Payout Reports ─────────────────────────────────────────────────────

const PAYOUT_REPORT_LIMIT = 200
const HOST_PAYOUT_LIMIT = 1000

export async function getWeeklyPayoutReports(status?: string): Promise<WeeklyPayoutReport[]> {
  const ref = collection(db, 'weeklyPayoutReports')
  const q = status
    ? query(ref, where('status', '==', status), orderBy('createdAt', 'desc'), limit(PAYOUT_REPORT_LIMIT))
    : query(ref, orderBy('createdAt', 'desc'), limit(PAYOUT_REPORT_LIMIT))
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as WeeklyPayoutReport))
}

export async function getHostPayouts(reportId: string): Promise<HostPayout[]> {
  // One report ≈ one agency's hosts for one week; the cap is a safety net only.
  const q = query(
    collection(db, 'hostPayouts'),
    where('reportId', '==', reportId),
    limit(HOST_PAYOUT_LIMIT)
  )
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as HostPayout))
}

export async function approvePayoutReport(reportId: string, approvedByUid: string): Promise<void> {
  await updateDoc(doc(db, 'weeklyPayoutReports', reportId), {
    status: 'approved',
    approvedBy: approvedByUid,
    approvedAt: serverTimestamp(),
  })
}

export async function rejectPayoutReport(
  reportId: string,
  reason: string,
  approvedByUid: string
): Promise<void> {
  await updateDoc(doc(db, 'weeklyPayoutReports', reportId), {
    status: 'rejected',
    rejectedReason: reason,
    approvedBy: approvedByUid,
    approvedAt: serverTimestamp(),
  })
}

// ── Platform Revenue ──────────────────────────────────────────────────────────
//
// SCHEMA NOTE — `platformRevenue` holds TWO different document shapes:
//
//   A) DAILY ROLLUP — written by the Cloud Function `dailyPlatformStatsAggregator`
//      (functions/src/index.ts). Document id = 'YYYY-MM-DD'.
//      Fields: date, dayStart, dayEnd, totalGifts, totalDiamondSpend,
//              totalBeanEarned, platformRevenue, platformProfit, platformPayout,
//              updatedAt.
//      It writes NO `timestamp` and NO `amount`.
//
//   B) PER-EVENT LOG — written by the Android app in real time
//      (GiftRepository / CallEconomyRepository / GamingBetRepository).
//      Document id = auto-generated.
//      Fields: type ('gift' | 'call' | 'gaming_bet'), timestamp, platformCut,
//              plus grossDiamonds + payoutBeans (gift/call)
//              or betAmount + winnings (gaming_bet).
//      It writes NO `date` and NO `amount`.
//
// `amount` exists on NEITHER shape. Every reader that did
// `orderBy('timestamp')` + `sum(d.data().amount)` therefore reported ₹0 —
// the orderBy silently dropped all shape-A docs, and shape-B docs have no
// `amount` to sum.
//
// Because no single field is present on both shapes, ONE ordered query can
// never see the whole collection. We run one query PER SHAPE, each ordered by
// a field that every document of *its own* shape is guaranteed to carry, then
// merge into a per-day series. Nothing is silently excluded.
//
// Merge rule: the two shapes are alternate measurements of the same activity,
// not additive inputs. For each calendar day we keep whichever source reports
// the larger gross diamond spend and take ALL of that day's figures from it.
// That can never double-count, and can never let an empty rollup suppress real
// event data.

const REVENUE_SCAN_LIMIT = 1000

export interface PlatformRevenueDay {
  date: string                 // 'YYYY-MM-DD'
  source: 'rollup' | 'event'
  diamondSpend: number         // gross diamonds spent by users
  beanPayout: number           // beans credited to hosts      → valued at rates.bean
  diamondPayout: number        // diamonds credited to users    → valued at rates.diamond
  platformCutDiamonds: number  // diamonds retained by the platform
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addInto(
  map: Map<string, PlatformRevenueDay>,
  date: string,
  source: 'rollup' | 'event',
  diamondSpend: number,
  beanPayout: number,
  diamondPayout: number,
  platformCutDiamonds: number
) {
  const prev = map.get(date)
  if (prev) {
    prev.diamondSpend += diamondSpend
    prev.beanPayout += beanPayout
    prev.diamondPayout += diamondPayout
    prev.platformCutDiamonds += platformCutDiamonds
  } else {
    map.set(date, { date, source, diamondSpend, beanPayout, diamondPayout, platformCutDiamonds })
  }
}

// Several widgets on the same screen ask for revenue at once (dashboard KPI,
// finance tables, analytics charts). Memoise briefly so one page load costs one
// scan instead of five.
const REVENUE_TTL_MS = 60_000
let _revenueCache: { at: number; scanLimit: number; days: PlatformRevenueDay[] } | null = null

/**
 * Reads the whole `platformRevenue` collection across both document shapes and
 * folds it into one day-keyed series, newest day first.
 *
 * Bounded at `scanLimit` documents PER SHAPE. For the per-event shape that
 * means the figure covers the most recent `scanLimit` revenue events — see the
 * note in the report about `platformStats/global`, which holds an exact
 * all-time counter and is the right long-term source once the daily aggregator
 * is fixed.
 */
export async function getPlatformRevenueDays(
  scanLimit = REVENUE_SCAN_LIMIT
): Promise<PlatformRevenueDay[]> {
  if (
    _revenueCache &&
    _revenueCache.scanLimit === scanLimit &&
    Date.now() - _revenueCache.at < REVENUE_TTL_MS
  ) {
    return _revenueCache.days
  }

  const ref = collection(db, 'platformRevenue')

  // Two independent queries — one per shape. Each is tolerated failing on its
  // own (e.g. a missing single-field index) so one shape can never zero out the
  // other.
  const [rollupSnap, eventSnap] = await Promise.all([
    getDocs(query(ref, orderBy('date', 'desc'), limit(scanLimit)))
      .catch((e) => { console.error('platformRevenue rollup scan failed:', e); return null }),
    getDocs(query(ref, orderBy('timestamp', 'desc'), limit(scanLimit)))
      .catch((e) => { console.error('platformRevenue event scan failed:', e); return null }),
  ])

  // If BOTH shapes failed we know nothing — that is an outage (denied read,
  // missing index, network), not "revenue is zero". Throwing keeps callers from
  // rendering a confident ₹0, which is the exact bug this function was written
  // to fix. A single shape failing is tolerated: the other still has real data.
  if (!rollupSnap && !eventSnap) {
    throw new Error('Unable to read platformRevenue — revenue figures unavailable.')
  }

  const rollupDays = new Map<string, PlatformRevenueDay>()
  for (const d of rollupSnap?.docs ?? []) {
    const data = d.data()
    // Doc id is the day label, so it is a safe fallback for `date`.
    const date = typeof data.date === 'string' && data.date ? data.date : d.id
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    addInto(
      rollupDays,
      date,
      'rollup',
      num(data.totalDiamondSpend ?? data.diamondsSold ?? data.grossDiamonds),
      num(data.totalBeanEarned ?? data.platformPayout ?? data.payoutBeans),
      0, // rollup docs express all payout in beans
      num(data.platformRevenue ?? data.platformProfit ?? data.platformCut)
    )
  }

  const eventDays = new Map<string, PlatformRevenueDay>()
  for (const d of eventSnap?.docs ?? []) {
    const data = d.data()
    // Normally a Firestore Timestamp; tolerate epoch-millis numbers too.
    const rawTs = data.timestamp as { toMillis?: () => number } | number | undefined
    const ms =
      typeof rawTs === 'number'
        ? rawTs
        : typeof rawTs?.toMillis === 'function'
          ? rawTs.toMillis()
          : NaN
    if (!Number.isFinite(ms) || ms <= 0) continue
    // Payout is denominated differently per event type and MUST NOT be summed
    // into one field: gift/call credit the host in BEANS (`payoutBeans`), while
    // gaming_bet credits the user in DIAMONDS (`winnings` — see
    // GamingBetRepository.settleBet, which increments users/{uid}.diamonds).
    // Valuing `winnings` at the bean rate understated gaming payout by ~2.4x
    // and so overstated profit.
    addInto(
      eventDays,
      isoDay(new Date(ms)),
      'event',
      // gift/call log gross diamonds; gaming_bet logs the stake
      num(data.grossDiamonds ?? data.betAmount ?? data.diamondCost),
      num(data.payoutBeans ?? data.beanValue),
      num(data.winnings),
      num(data.platformCut)
    )
  }

  const merged = new Map<string, PlatformRevenueDay>(Array.from(rollupDays.entries()))
  for (const ev of Array.from(eventDays.values())) {
    const roll = merged.get(ev.date)
    // Alternate measurements of the same day — never add them together.
    if (!roll || ev.diamondSpend > roll.diamondSpend) merged.set(ev.date, ev)
  }

  const days = Array.from(merged.values()).sort((a, b) => b.date.localeCompare(a.date))
  _revenueCache = { at: Date.now(), scanLimit, days }
  return days
}

/** Drop the memoised revenue scan — call after a manual "Refresh". */
export function invalidatePlatformRevenueCache(): void {
  _revenueCache = null
}

function dayToRecord(d: PlatformRevenueDay, r: Rates = ratesNow()): RevenueRecord {
  // WHOLESALE, not retail. Diamonds a user consumed were bought from a coin
  // seller, and Zipper received the wholesale price for them — the retail price
  // is what the seller's customer paid the seller, and it never reaches this
  // business. Valuing consumption at retail overstated every revenue figure in
  // this module by the seller's whole margin.
  const totalRevenue = d.diamondSpend * r.sellerWholesalePerDiamond
  // Bean-denominated and diamond-denominated payouts are valued at their own rates.
  // Beans at the bean rate; diamonds given away are stock Zipper realises
  // the wholesale price on, so that is what giving one away costs.
  const totalPayout = d.beanPayout * r.bean + d.diamondPayout * r.sellerWholesalePerDiamond
  return {
    id: d.date,
    date: d.date,
    diamondsSold: d.diamondSpend,
    totalRevenue,
    totalPayout,
    profit: totalRevenue - totalPayout,
    createdAt: null,
  }
}

export async function getPlatformRevenue(limitCount?: number): Promise<RevenueRecord[]> {
  const [days, rates] = await Promise.all([getPlatformRevenueDays(), getRates()])
  const records = days.map((d) => dayToRecord(d, rates))
  return limitCount ? records.slice(0, limitCount) : records
}

export async function getPlatformStats(): Promise<{
  totalDiamondsSold: number
  totalRevenue: number
  totalPayout: number
  totalProfit: number
}> {
  const records = await getPlatformRevenue()
  return records.reduce(
    (acc, r) => ({
      totalDiamondsSold: acc.totalDiamondsSold + (r.diamondsSold || 0),
      totalRevenue: acc.totalRevenue + (r.totalRevenue || 0),
      totalPayout: acc.totalPayout + (r.totalPayout || 0),
      totalProfit: acc.totalProfit + (r.profit || 0),
    }),
    { totalDiamondsSold: 0, totalRevenue: 0, totalPayout: 0, totalProfit: 0 }
  )
}

// ── Dashboard Insight Boxes ───────────────────────────────────────────────────

// Helper: get monday of the ISO week containing a date
function weekStart(d: Date): Date {
  const day = d.getDay() // 0 Sun … 6 Sat
  const diff = (day === 0 ? -6 : 1 - day)
  const mon = new Date(d)
  mon.setDate(d.getDate() + diff)
  mon.setHours(0, 0, 0, 0)
  return mon
}

function weekLabel(mon: Date): string {
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
  const fmt = (d: Date) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  return `${fmt(mon)} – ${fmt(sun)}`
}

// Box 1 — Diamond Economy
// Shows total diamonds the company has distributed (sold via sellers + rewarded directly)
export interface DiamondWeekSlice {
  weekLabel: string
  diamondsSold: number
  revenue: number
}

export interface DiamondEconomy {
  totalDiamondsSold: number    // via coin sellers (sum from platformRevenue)
  totalDiamondsRewarded: number  // admin-gifted directly (from user diamondTransactions)
  totalRevenue: number           // INR collected for diamonds sold
  recentWeeks: DiamondWeekSlice[]  // last 6 weeks from platformRevenue
}

export async function getDiamondEconomy(): Promise<DiamondEconomy> {
  const [revenueDays, rates, rewardSnap] = await Promise.all([
    // Whole platformRevenue collection, both document shapes, folded per day
    getPlatformRevenueDays(),
    getRates(),
    // Admin diamond rewards — any transaction with reason containing 'reward' or 'admin'
    getDocs(query(
      collectionGroup(db, 'diamondTransactions'),
      where('type', '==', 'credit'),
      limit(2000)
    )),
  ])

  // Aggregate totals from the day series
  let totalDiamondsSold = 0
  let totalRevenue = 0
  const weekMap = new Map<string, DiamondWeekSlice>()

  for (const day of revenueDays) {
    const sold = day.diamondSpend
    const rev  = sold * rates.sellerWholesalePerDiamond  // what Zipper was actually paid
    totalDiamondsSold += sold
    totalRevenue      += rev

    // Group into weeks using the day label (YYYY-MM-DD string)
    const date = new Date(day.date)
    if (!isNaN(date.getTime())) {
      const mon = weekStart(date)
      const label = weekLabel(mon)
      const existing = weekMap.get(label) ?? { weekLabel: label, diamondsSold: 0, revenue: 0 }
      weekMap.set(label, {
        ...existing,
        diamondsSold: existing.diamondsSold + sold,
        revenue:      existing.revenue      + rev,
      })
    }
  }

  // Admin-rewarded diamonds (credit transactions not from purchases)
  let totalDiamondsRewarded = 0
  for (const d of rewardSnap.docs) {
    const reason = (d.data().reason ?? '') as string
    const reasonLabel = (d.data().reasonLabel ?? '') as string
    // Count only admin rewards, not purchase/gift-receive
    if (
      reason.includes('admin') || reason.includes('reward') || reason.includes('bonus') ||
      reasonLabel.toLowerCase().includes('admin') || reasonLabel.toLowerCase().includes('reward')
    ) {
      totalDiamondsRewarded += d.data().amount ?? 0
    }
  }

  // Sort weeks newest-first, take last 6
  const recentWeeks = Array.from(weekMap.values())
    .sort((a, b) => {
      const aDate = new Date(a.weekLabel.split('–')[0].trim() + ' ' + new Date().getFullYear())
      const bDate = new Date(b.weekLabel.split('–')[0].trim() + ' ' + new Date().getFullYear())
      return bDate.getTime() - aDate.getTime()
    })
    .slice(0, 6)

  return { totalDiamondsSold, totalDiamondsRewarded, totalRevenue, recentWeeks }
}

// Box 2 — Weekly Beans Generated
// Shows beans earned by everyone (hosts/users/agencies) per week + reward beans
export interface BeanWeekSlice {
  weekLabel: string
  weekStart: number   // epoch ms — for sorting
  fromGifts: number
  fromCalls: number
  fromRewards: number  // admin-added
  total: number
}

export interface WeeklyBeansBreakdown {
  thisWeekTotal: number
  lastWeekTotal: number
  weeksData: BeanWeekSlice[]   // last 8 weeks, newest first
}

export async function getWeeklyBeansBreakdown(): Promise<WeeklyBeansBreakdown> {
  // Fetch recent bean credit transactions — limit to last 3000 (should cover 8 weeks)
  const snap = await getDocs(query(
    collectionGroup(db, 'beanTransactions'),
    where('type', '==', 'credit'),
    limit(3000)
  ))

  const now = new Date()
  const eightWeeksAgo = new Date(now)
  eightWeeksAgo.setDate(now.getDate() - 56)

  const weekMap = new Map<number, BeanWeekSlice>()

  for (const d of snap.docs) {
    const data = d.data()
    const ts: Timestamp | null = data.timestamp ?? null
    if (!ts?.toMillis) continue
    const ms = ts.toMillis()
    if (ms < eightWeeksAgo.getTime()) continue

    const date = new Date(ms)
    const mon  = weekStart(date)
    const key  = mon.getTime()

    const existing = weekMap.get(key) ?? {
      weekLabel:   weekLabel(mon),
      weekStart:   key,
      fromGifts:   0,
      fromCalls:   0,
      fromRewards: 0,
      total:       0,
    }

    const amount = data.amount ?? 0
    const reason = (data.reason ?? '') as string
    const label  = (data.reasonLabel ?? '') as string

    let fromGifts   = existing.fromGifts
    let fromCalls   = existing.fromCalls
    let fromRewards = existing.fromRewards

    if (reason.includes('gift') || label.toLowerCase().includes('gift')) {
      fromGifts += amount
    } else if (reason.includes('call') || label.toLowerCase().includes('call')) {
      fromCalls += amount
    } else if (
      reason.includes('admin') || reason.includes('reward') || reason.includes('bonus') ||
      label.toLowerCase().includes('reward') || label.toLowerCase().includes('admin')
    ) {
      fromRewards += amount
    } else {
      // Default: treat as gift/earned
      fromGifts += amount
    }

    weekMap.set(key, {
      ...existing,
      fromGifts,
      fromCalls,
      fromRewards,
      total: existing.total + amount,
    })
  }

  const weeksData = Array.from(weekMap.values())
    .sort((a, b) => b.weekStart - a.weekStart)
    .slice(0, 8)

  const thisWeekMon = weekStart(now).getTime()
  const lastWeekMon = thisWeekMon - 7 * 24 * 60 * 60 * 1000

  const thisWeekTotal = weekMap.get(thisWeekMon)?.total ?? 0
  const lastWeekTotal = weekMap.get(lastWeekMon)?.total ?? 0

  return { thisWeekTotal, lastWeekTotal, weeksData }
}

// Box 3 — Company Revenue & Cuts
// Economic flow (every rate below comes from lib/rates.ts, never from a literal
// written here — see the deletion note further down):
//   User spends X diamonds (sold by coin sellers at rates.diamondPerLakhInr)
//   Host earns Y beans (valued at rates.bean)
//   Platform cut = X - Y (in mixed units, stored as platformRevenue/platformCut in Firestore)
//   Revenue (₹) = X × rates.diamond
//   Payout (₹)  = Y × rates.bean
//   Profit (₹)  = Revenue - Payout

/* ─────────────────────────────────────────────────────────────────────────────
 * DELETED — `DIAMOND_RATE = 2390 / 100000` and `BEAN_RATE = 0.01`
 *
 * The comment above them claimed "a few synchronous render paths reference
 * them". None did — they had zero importers anywhere in app/ or lib/. What they
 * actually were was a second copy of the rate table sitting in the finance
 * module, exported and inviting, one import away from re-splitting rates into
 * two disagreeing sources. That split is exactly what cost this CRM a silent
 * 4% understatement on every revenue figure.
 *
 * Rates come from `lib/rates.ts` only: `getRates()` where you can await,
 * `ratesNow()` on a render path that cannot. Both read `appConfig/economy`,
 * and this file already uses them throughout.
 * ───────────────────────────────────────────────────────────────────────────── */

export interface RevenueMonthSlice {
  monthLabel: string
  monthKey: string  // YYYY-MM for sorting
  revenue: number       // ₹
  payout: number        // ₹
  profit: number        // ₹
  diamondsSold: number  // gross diamonds spent by users
  platformCutDiamonds: number  // company's cut in diamond units
}

export interface CompanyRevenueSummary {
  totalRevenue: number            // ₹ gross from diamond spend
  totalPayout: number             // ₹ paid to hosts (beans × rate)
  netProfit: number               // ₹ company keeps
  profitMargin: number            // percentage
  totalDiamondsSold: number       // total diamonds spent in app
  totalPlatformCutDiamonds: number // company's retained cut (in diamond units)
  recentMonths: RevenueMonthSlice[]
}

export async function getCompanyRevenueSummary(): Promise<CompanyRevenueSummary> {
  const rates = await getRates()
  // Reads BOTH platformRevenue document shapes (see the schema note above) and
  // folds them into one day series keyed 'YYYY-MM-DD'.
  const days = await getPlatformRevenueDays()

  let totalDiamondSpend  = 0
  let totalBeanEarned    = 0
  let totalDiamondPayout = 0
  let totalPlatformCut   = 0
  const monthMap = new Map<string, RevenueMonthSlice>()

  for (const day of days) {
    const diamondSpend  = day.diamondSpend
    const beanEarned    = day.beanPayout
    const diamondPayout = day.diamondPayout
    const cutUnits      = day.platformCutDiamonds

    totalDiamondSpend  += diamondSpend
    totalBeanEarned    += beanEarned
    totalDiamondPayout += diamondPayout
    totalPlatformCut   += cutUnits

    const monthKey = day.date.slice(0, 7) // 'YYYY-MM'
    const [yr, mo] = monthKey.split('-')
    const monthLabel = new Date(Number(yr), Number(mo) - 1, 1)
      .toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })

    const rev  = diamondSpend * rates.sellerWholesalePerDiamond
    const pay  = beanEarned * rates.bean + diamondPayout * rates.sellerWholesalePerDiamond
    const prof = rev - pay

    const existing = monthMap.get(monthKey) ?? {
      monthLabel, monthKey, revenue: 0, payout: 0, profit: 0,
      diamondsSold: 0, platformCutDiamonds: 0,
    }
    monthMap.set(monthKey, {
      ...existing,
      revenue:             existing.revenue             + rev,
      payout:              existing.payout              + pay,
      profit:              existing.profit              + prof,
      diamondsSold:        existing.diamondsSold        + diamondSpend,
      platformCutDiamonds: existing.platformCutDiamonds + cutUnits,
    })
  }

  // WHOLESALE, not retail. Diamonds a user consumed were bought from a coin
  // seller, and Zipper received the wholesale price for them — the retail price
  // is what the seller's customer paid the seller, and it never reaches this
  // business. Valuing consumption at retail overstated every revenue figure in
  // this module by the seller's whole margin.
  const totalRevenue = totalDiamondSpend * rates.sellerWholesalePerDiamond
  const totalPayout  = totalBeanEarned * rates.bean + totalDiamondPayout * rates.sellerWholesalePerDiamond
  const netProfit    = totalRevenue - totalPayout
  const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0

  const recentMonths = Array.from(monthMap.values())
    .sort((a, b) => b.monthKey.localeCompare(a.monthKey))
    .slice(0, 6)

  return {
    totalRevenue, totalPayout, netProfit,
    profitMargin, totalDiamondsSold: totalDiamondSpend,
    totalPlatformCutDiamonds: totalPlatformCut,
    recentMonths,
  }
}
