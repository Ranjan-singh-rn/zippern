/**
 * IST day and week keys — one definition, used everywhere.
 *
 * Every reset in this product is Indian Standard Time: the daily reward, the
 * payout week that closes 23:59 Sunday, the host's "today". These were defined
 * twice — `istDateKey` in wallet.ts and `istWeekKey` in payouts.ts, each with
 * its own `IST_OFFSET_MIN` — and a third copy was about to appear in
 * hostStats.ts.
 *
 * Three copies of a date boundary is three chances for one of them to drift by
 * an hour, and the symptom would be a host's daily total resetting at a
 * different moment from the reward they claim beside it.
 */

const IST_OFFSET_MIN = 330

/** `2026-09-12` — the IST calendar day. */
export function istDateKey(at: Date = new Date()): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MIN * 60 * 1000)
  return ist.toISOString().slice(0, 10)
}

/**
 * `2026-W37` — the ISO week, cut in IST.
 *
 * ISO weeks start Monday, so Sunday belongs to the week that is ending. That
 * matters here: the payout period closes 23:59 Sunday IST, and a Sunday gift
 * must land in the week being closed rather than the one starting.
 */
export function istWeekKey(at: Date = new Date()): string {
  const ist = new Date(at.getTime() + IST_OFFSET_MIN * 60 * 1000)
  return isoWeekLabelUtc(ist)
}

/**
 * `2026-W53` — the ISO week of a UTC calendar date, with the ISO WEEK-YEAR.
 *
 * The year is taken from the Thursday of the week, not from the date itself.
 * That is the whole of ISO 8601's rule and the whole of FINANCE-009 / M-7:
 * the week starting Monday 28 Dec 2026 contains Thursday 31 Dec 2026, so it
 * is 2026-W53; the week starting Monday 4 Jan 2027 is 2027-W01; and Sunday
 * 3 Jan 2027 still belongs to 2026-W53. Taking `getUTCFullYear()` of the date
 * itself labels the first of those `2027-W53` — a week that does not exist,
 * which the commission API refuses and nothing accrues.
 *
 * Shared by `istWeekKey` (payout weeks, cut in IST) and the weekly report's
 * label in index.ts (cut in UTC), so the two cannot disagree on the year.
 */
export function isoWeekLabelUtc(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)          // the Thursday of this ISO week
  const isoYear = d.getUTCFullYear()               // the week-year is the Thursday's year
  const yearStart = new Date(Date.UTC(isoYear, 0, 1))
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

export { IST_OFFSET_MIN }
