/**
 * QA #54 — dates and times are shown in Indian Standard Time.
 *
 * Every timestamp is STORED in UTC (Firestore Timestamps, ISO strings from the
 * API) and that does not change. What changes is how one is SHOWN: staff and
 * partners are in India, and a browser in any other zone (or a server-side
 * render) printed the same instant as a different hour. `Asia/Kolkata` has no
 * daylight saving, so IST is always UTC+05:30.
 *
 * Assembled from `formatToParts` rather than taken from `format`, so the text
 * is the same in every engine ("Thu, 5 Nov 2026, 3:51 pm IST") — ICU versions
 * differ in their commas.
 *
 * Pure: `Intl` only — `suspensionTerm.spec.ts` runs it.
 */

export const IST_ZONE = 'Asia/Kolkata'

function toDate(at: Date | number | string | null | undefined): Date | null {
  if (at === null || at === undefined || at === '') return null
  const d = at instanceof Date ? at : new Date(at)
  return isNaN(d.getTime()) ? null : d
}

function partsOf(d: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST_ZONE,
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d)
  const out: Record<string, string> = {}
  for (const p of parts) if (p.type !== 'literal') out[p.type] = p.value
  return out
}

/** "Thu, 5 Nov 2026, 3:51 pm IST" — the date and the time, in IST, for a person to read. */
export function formatIst(at: Date | number | string | null | undefined): string {
  const d = toDate(at)
  if (!d) return ''
  const p = partsOf(d)
  const ampm = String(p.dayPeriod ?? '').toLowerCase()
  return `${p.weekday}, ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${ampm} IST`.replace(/\s+IST$/, ' IST')
}

/** "5 Nov 2026" — the calendar date in IST. */
export function formatIstDate(at: Date | number | string | null | undefined): string {
  const d = toDate(at)
  if (!d) return ''
  const p = partsOf(d)
  return `${p.day} ${p.month} ${p.year}`
}
