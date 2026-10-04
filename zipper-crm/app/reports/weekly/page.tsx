'use client'

/**
 * The owner's Sunday business report, on screen.
 *
 * The report is a *record*, not a query. `scheduling.weekly()` computes five
 * sections, writes them to one immutable document keyed on the ISO week, and
 * then emails them. This page reads that document back — so what it shows is
 * what was stored on the day, not a recomputation against a ledger that has
 * moved since. That is the whole reason for keeping it.
 *
 * Three properties of the stored document are carried onto the screen rather
 * than flattened, because flattening any of them turns a fact into a guess:
 *
 *   * **A failed section says so, in its own words.** `_stored_section` keeps
 *     the report's own explanation for exactly this. It is rendered as a
 *     failure, never as an empty table and never as a zero.
 *   * **An empty period is not ₹0.** `envelope.empty` means the store was read
 *     and holds nothing. "No lucky gift was sent this week" is the backend's
 *     own sentence and it is printed instead of a total.
 *   * **The profit is an upper bound.** `totals.complete` is false whenever an
 *     expenditure line is not recorded anywhere — salaries, servers, tax. The
 *     caveat sits above the figure, not under it.
 *
 * Ineligible hosts and below-floor agencies are on the page with their reason.
 * They are the rows somebody has to act on; filtering them out would leave a
 * page of good news and no work.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, CalendarDays, ChevronLeft, ChevronRight, Download, FileWarning,
  Info, Loader2, RefreshCw, ScrollText, XCircle,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { ApiError, type ApiRole } from '@/lib/api'
import { Column, DataTable, downloadCsv } from '@/components/ui/DataTable'
import { Denied, ErrorState, Loading, Warning } from '@/components/ui/States'
import {
  WeeklyBusinessDoc, WeeklyBusinessRead, WeeklyBusinessRun, WeeklyStoredSection,
  formatCount, formatDateTime, formatInrMinor, formatPct, formatReportCell,
  isRupeeKey, isoWeekRangeLabel, lastClosedIsoWeek, provisionalNote, rateSummary,
  recentIsoWeeks, reportCellValue, shiftIsoWeek, totalBoolean, totalNumber,
  weeklyBusiness,
} from '@/lib/apiReports'

const MIN_REASON = 8

/** How many past ISO weeks the picker offers. There is no endpoint that lists
 *  which weeks have a stored report, so the labels are generated and a week
 *  with nothing stored answers 404 with the API's own explanation. */
const WEEKS_OFFERED = 52

// ── Authority ─────────────────────────────────────────────────────────────────
//
// `GET /reports/weekly-business/{week}` is `require_internal` +
// `_require_business_financials` (backend/app/routers/reports.py:571,578) —
// owners, the Observer and team admins. `POST /reports/jobs/weekly-business` is
// `team_admin_or_reporting_service` (:509), whose person fallback is
// `require_team_admin`, which admits team admins and owners but NOT the
// Observer. So the page reads for three groups and triggers for two.

function isTeamAdmin(role: ApiRole): boolean {
  return role.endsWith('_admin')
}

function canRead(role: ApiRole): boolean {
  return role === 'owner' || role === 'observer' || isTeamAdmin(role)
}

function canTrigger(role: ApiRole): boolean {
  return role === 'owner' || isTeamAdmin(role)
}

// ── Headline figures, per section ─────────────────────────────────────────────
//
// Keyed on `envelope.report`, which is the report's own name from
// `services/reports.py`. A tile whose total is absent renders "—" and says the
// figure was not published, rather than inventing a zero for it.

type TileKind = 'minor' | 'count' | 'percent' | 'text'

interface Tile {
  key: string
  label: string
  kind: TileKind
  /** Highlighted when the value is non-zero — the rows somebody must act on. */
  attention?: boolean
}

const TILES: Record<string, Tile[]> = {
  weekly_profit_and_loss: [
    { key: 'revenue_inr_minor', label: 'Revenue — money received', kind: 'minor' },
    { key: 'expenditure_inr_minor', label: 'Expenditure (recorded lines only)', kind: 'minor' },
    { key: 'profit_inr_minor', label: 'Profit', kind: 'minor' },
    { key: 'margin_pct', label: 'Margin', kind: 'percent' },
    { key: 'total_paid_out_inr_minor', label: 'Paid out — hosts and agencies', kind: 'minor' },
    { key: 'host_payouts_inr_minor', label: 'Host payouts executed', kind: 'minor' },
    { key: 'agency_commission_paid_inr_minor', label: 'Agency commission paid', kind: 'minor' },
  ],
  weekly_money_in: [
    { key: 'user_recharges_inr_minor', label: 'User recharges', kind: 'minor' },
    { key: 'user_recharges_count', label: 'Recharges approved', kind: 'count' },
    { key: 'agency_topups_inr_minor', label: 'Agency wallet top-ups (separate)', kind: 'minor' },
    { key: 'credit_advanced_coins', label: 'Seller credit advanced (coins)', kind: 'count' },
    { key: 'credit_repaid_coins', label: 'Seller credit repaid (coins)', kind: 'count' },
    { key: 'credit_written_off_coins', label: 'Written off (coins)', kind: 'count', attention: true },
    { key: 'credit_outstanding_coins', label: 'Credit outstanding now (coins)', kind: 'count' },
    { key: 'sellers_overdue', label: 'Sellers overdue', kind: 'count', attention: true },
  ],
  weekly_agencies: [
    { key: 'agencies_on_file', label: 'Agencies on file', kind: 'count' },
    { key: 'agencies_earning_commission', label: 'Earning commission', kind: 'count' },
    { key: 'agencies_below_floor', label: 'Below the floor', kind: 'count', attention: true },
    { key: 'agencies_not_computed', label: 'Not computed', kind: 'count', attention: true },
    { key: 'billing_inr_minor', label: 'Billing', kind: 'minor' },
    { key: 'commission_inr_minor', label: 'Commission', kind: 'minor' },
    { key: 'sub_agencies_without_a_parent', label: 'Sub-agencies with no parent', kind: 'count', attention: true },
    { key: 'open_subagency_legs', label: 'Open sub-agency payment legs', kind: 'count', attention: true },
  ],
  weekly_hosts: [
    { key: 'hosts_with_activity', label: 'Hosts with activity', kind: 'count' },
    { key: 'hosts_eligible', label: 'Eligible for payout', kind: 'count' },
    { key: 'hosts_below_threshold', label: 'Below the threshold', kind: 'count', attention: true },
    { key: 'payout_due_all_hosts_inr_minor', label: 'Payout due — all hosts', kind: 'minor' },
    { key: 'payout_due_eligible_only_inr_minor', label: 'Payout due — eligible only', kind: 'minor' },
    { key: 'hosts_under_a_sub_agency', label: 'Under a sub-agency', kind: 'count', attention: true },
    { key: 'hosts_with_no_agency', label: 'No agency on the movement', kind: 'count', attention: true },
    { key: 'beans_earned', label: 'Beans earned', kind: 'count' },
  ],
  weekly_leaderboards: [
    { key: 'entries_ranked', label: 'Entries ranked', kind: 'count' },
    { key: 'top_n', label: 'Board length', kind: 'count' },
  ],
}

/**
 * Flags that say a store could not be read. When one is false the columns it
 * feeds are unknown for every row — not zero — and that has to be shouted.
 */
const SOURCED_FLAGS: Record<string, { key: string; what: string }[]> = {
  weekly_hosts: [
    { key: 'gifts_sourced', what: 'Gifts received' },
    { key: 'calls_sourced', what: 'Calls and call minutes' },
  ],
  weekly_money_in: [
    { key: 'recharges_sourced', what: 'User recharges' },
    { key: 'seller_credit_sourced', what: 'Seller credit' },
    { key: 'seller_credit_named_by_seller', what: 'Seller credit broken down by seller' },
  ],
  weekly_agencies: [
    { key: 'subagency_legs_sourced', what: 'Open sub-agency payment legs' },
  ],
}

/** Which column a section is filtered on, and how each value reads. */
const SECTION_FILTER: Record<string, { key: string; label: string; labelFor: (v: string) => string }> = {
  weekly_hosts: {
    key: 'eligible',
    label: 'Eligibility',
    labelFor: (v) =>
      v === 'true' ? 'Eligible' : v === 'false' ? 'Not eligible — reason on the row' : v,
  },
  weekly_agencies: {
    key: 'earns_commission',
    label: 'Commission',
    labelFor: (v) =>
      v === 'true'
        ? 'Earns commission'
        : v === 'false'
          ? 'Below the floor — reason on the row'
          : v === '—'
            ? 'Not computed — see Why'
            : v,
  },
  weekly_leaderboards: { key: 'board', label: 'Board', labelFor: (v) => v },
  weekly_money_in: { key: 'block', label: 'Block', labelFor: (v) => v.replace(/_/g, ' ') },
  weekly_profit_and_loss: { key: 'kind', label: 'Line kind', labelFor: (v) => v },
}

// ── Presentation ──────────────────────────────────────────────────────────────

type Row = Record<string, unknown> & { __i: number }

/**
 * `reports.py` opens a capitalised clause for exactly the conditions that are
 * not routine, and `_needs_a_person` (scheduling.py:1689) reads that convention
 * with `head[:4].isupper()`. Mirrored here rather than re-invented, including
 * Python's rule that a string with no cased characters is not upper-case — so
 * a warning that opens with a number is not shouted at the reader.
 */
function isShouted(warning: string): boolean {
  const head = warning.split('.')[0].slice(0, 4)
  return /[A-Za-z]/.test(head) && head === head.toUpperCase()
}

function Figure({ tile, totals }: { tile: Tile; totals: Record<string, unknown> }) {
  const raw = totals[tile.key]
  const missing = raw === null || raw === undefined
  let text = '—'
  if (!missing) {
    if (tile.kind === 'minor') text = formatInrMinor(totalNumber(totals, tile.key))
    else if (tile.kind === 'count') text = formatCount(totalNumber(totals, tile.key))
    else if (tile.kind === 'percent') text = formatPct(totalNumber(totals, tile.key))
    else text = String(raw)
  }
  const n = totalNumber(totals, tile.key)
  const loud = tile.attention && n !== null && n > 0

  return (
    <div className="bg-slate-800/40 border border-slate-800 rounded-lg px-3.5 py-3">
      <p className="text-slate-500 text-xs leading-snug">{tile.label}</p>
      <p
        className={`text-base font-semibold tabular-nums mt-1 ${
          loud ? 'text-amber-300' : missing ? 'text-slate-600' : 'text-white'
        }`}
      >
        {text}
      </p>
      {missing && (
        <p className="text-slate-600 text-[11px] mt-1 leading-snug">
          Not published in this section&rsquo;s totals — unknown, not zero.
        </p>
      )}
    </div>
  )
}

function Banner({
  tone, title, children, icon,
}: {
  tone: 'critical' | 'warn' | 'neutral'
  title: string
  children?: React.ReactNode
  icon?: React.ReactNode
}) {
  const skin =
    tone === 'critical'
      ? 'bg-red-500/10 border-red-500/40 text-red-200'
      : tone === 'warn'
        ? 'bg-amber-500/10 border-amber-500/35 text-amber-100'
        : 'bg-slate-800/60 border-slate-700 text-slate-200'
  return (
    <div className={`border rounded-xl px-4 py-3 ${skin}`}>
      <div className="flex items-start gap-2">
        {icon ?? <AlertTriangle size={15} className="mt-0.5 shrink-0" />}
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          {children && <div className="text-sm mt-1 leading-relaxed space-y-1">{children}</div>}
        </div>
      </div>
    </div>
  )
}

// ── One stored section ────────────────────────────────────────────────────────

function SectionCard({ section, week }: { section: WeeklyStoredSection; week: string }) {
  const [filter, setFilter] = useState('all')

  const envelope = section.envelope
  const rows: Row[] = useMemo(
    () => (envelope?.rows ?? []).map((r, i) => ({ ...r, __i: i })),
    [envelope],
  )

  const spec = envelope ? SECTION_FILTER[envelope.report] : undefined

  const options = useMemo(() => {
    if (!spec) return []
    const seen = new Map<string, number>()
    rows.forEach((r) => {
      const raw = r[spec.key]
      const v = raw === null || raw === undefined ? '—' : String(raw)
      seen.set(v, (seen.get(v) ?? 0) + 1)
    })
    return Array.from(seen.entries()).map(([value, count]) => ({
      value,
      label: spec.labelFor(value),
      count,
    }))
  }, [rows, spec])

  const shown = useMemo(() => {
    if (!spec || filter === 'all') return rows
    return rows.filter((r) => {
      const raw = r[spec.key]
      return (raw === null || raw === undefined ? '—' : String(raw)) === filter
    })
  }, [rows, spec, filter])

  // The rupee twin of a paise column carries the same figure already divided.
  // Showing both invites somebody to divide the wrong one again.
  const columns = useMemo<Column<Row>[]>(() => {
    const keys = new Set((envelope?.columns ?? []).map((c) => c.key))
    return (envelope?.columns ?? [])
      .filter((c) => !(isRupeeKey(c.key) && keys.has(`${c.key}_minor`)))
      .map((c): Column<Row> => ({
        key: c.key,
        header: c.header,
        align: /(_inr_minor|_inr|_minor|_count|_percent|_coins)$/.test(c.key) ? 'right' : 'left',
        value: (r: Row) => reportCellValue(r[c.key]),
        render: (r: Row) => {
          const text = formatReportCell(c.key, r[c.key])
          const isNull = r[c.key] === null || r[c.key] === undefined
          return (
            <span
              className={
                isNull
                  ? 'text-slate-600'
                  : r[c.key] === false
                    ? 'text-amber-300'
                    : 'text-slate-300'
              }
              title={isNull ? 'Not recorded — this is not a zero.' : undefined}
            >
              {text}
            </span>
          )
        },
      }))
  }, [envelope])

  // ── A section that could not be computed ────────────────────────────────────
  if (!section.ok) {
    return (
      <section className="bg-slate-900 border border-red-500/40 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-start gap-3">
          <XCircle size={17} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <h2 className="text-white font-semibold">{section.title}</h2>
            <p className="text-red-300 text-sm mt-0.5">
              Could not be computed — this is not a zero
            </p>
          </div>
        </div>
        <div className="px-5 py-4 space-y-2">
          <p className="text-red-200 text-sm leading-relaxed">
            {section.error || 'No reason was recorded.'}
          </p>
          {section.note && (
            <p className="text-slate-500 text-xs leading-relaxed">{section.note}</p>
          )}
          <p className="text-slate-500 text-xs leading-relaxed">
            Fixing the cause and re-running this week stores a new revision beside
            this one. It never edits what is already stored.
          </p>
        </div>
      </section>
    )
  }

  if (!envelope) {
    return (
      <section className="bg-slate-900 border border-amber-500/40 rounded-xl px-5 py-4">
        <h2 className="text-white font-semibold">{section.title}</h2>
        <p className="text-amber-200 text-sm mt-1 leading-relaxed">
          The stored record marks this section as successful but carries no
          envelope, so there is nothing to show. Treat it as unknown.
        </p>
      </section>
    )
  }

  const provisional = provisionalNote(envelope)
  const rateLine = rateSummary(envelope)
  const tiles = TILES[envelope.report] ?? []
  const flags = SOURCED_FLAGS[envelope.report] ?? []
  const unsourced = flags.filter((f) => totalBoolean(envelope.totals, f.key) === false)

  // The P&L labels its own standing. `complete` is false whenever an
  // expenditure line is recorded nowhere, and the profit above it is then an
  // upper bound — the real figure is lower by whatever those came to.
  const isPnl = envelope.report === 'weekly_profit_and_loss'
  const complete = totalBoolean(envelope.totals, 'complete')
  const unknownLines = Array.isArray(envelope.totals.unknown_lines)
    ? (envelope.totals.unknown_lines as unknown[]).map(String)
    : []

  function exportSection() {
    // Every column, including the rupee twins hidden above — an export is the
    // full record, not the trimmed view.
    const header = envelope!.columns.map((c) => c.header)
    const body = shown.map((r) => envelope!.columns.map((c) => reportCellValue(r[c.key])))
    downloadCsv([header, ...body], `${week}-${envelope!.report}`)
  }

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800">
        <div className="flex items-start gap-3">
          <ScrollText size={17} className="text-slate-600 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-white font-semibold">{section.title}</h2>
            <p className="text-slate-500 text-xs mt-1 leading-relaxed">
              {envelope.title} · {formatCount(section.row_count ?? envelope.rows.length)} row
              {(section.row_count ?? envelope.rows.length) === 1 ? '' : 's'} ·{' '}
              {envelope.currency_unit}
            </p>
            {rateLine && (
              <p className="text-slate-600 text-xs mt-1 leading-relaxed">{rateLine}</p>
            )}
          </div>
        </div>
      </div>

      <div className="px-5 py-4 space-y-4">
        {isPnl && complete === false && (
          <Banner tone="warn" title="This profit is an upper bound.">
            <p>
              {unknownLines.length} expenditure line
              {unknownLines.length === 1 ? '' : 's'} are not recorded anywhere in
              this system and could not be subtracted
              {unknownLines.length > 0 && <>: {unknownLines.join(', ')}</>}. The
              real profit is lower by whatever those came to. Do not quote the
              figure below as profit without this sentence attached to it.
            </p>
          </Banner>
        )}

        {provisional && (
          <Banner tone="warn" title="Provisional — a fallback rate was used.">
            <p>{provisional}</p>
          </Banner>
        )}

        {unsourced.length > 0 && (
          <Banner tone="critical" title="A source could not be read for this section.">
            <ul className="list-disc pl-4">
              {unsourced.map((f) => (
                <li key={f.key}>
                  <span className="font-medium">{f.what}</span> is unknown for
                  every row below. It is not zero.
                </li>
              ))}
            </ul>
          </Banner>
        )}

        {envelope.empty ? (
          <Banner
            tone="neutral"
            icon={<Info size={15} className="mt-0.5 shrink-0 text-slate-400" />}
            title="Nothing in this section for this week — and that is a measured result, not ₹0."
          >
            {envelope.warnings.length > 0 ? (
              <ul className="list-disc pl-4 space-y-1">
                {envelope.warnings.map((w, i) => (
                  <li key={i} className="text-slate-300 leading-relaxed">{w}</li>
                ))}
              </ul>
            ) : (
              <p className="text-slate-400">
                The section reported no rows and recorded no explanation.
              </p>
            )}
          </Banner>
        ) : (
          <>
            {tiles.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
                {tiles.map((t) => (
                  <Figure key={t.key} tile={t} totals={envelope.totals} />
                ))}
              </div>
            )}

            {envelope.warnings.filter((w) => w !== provisional).length > 0 && (
              <div className="space-y-1.5">
                {envelope.warnings
                  .filter((w) => w !== provisional)
                  .map((w, i) => {
                    const loud = isShouted(w)
                    return (
                      <p
                        key={i}
                        className={`text-xs leading-relaxed ${
                          loud ? 'text-amber-200' : 'text-slate-500'
                        }`}
                      >
                        {loud && <AlertTriangle size={11} className="inline mr-1 -mt-0.5" />}
                        {w}
                      </p>
                    )
                  })}
              </div>
            )}
          </>
        )}

        {envelope.rows_trimmed && (
          <Banner tone="warn" title="This table was trimmed before it was stored.">
            <p>{envelope.rows_trimmed.note}</p>
            <p className="text-amber-200/70">
              The CSV button below exports the {formatCount(envelope.rows_trimmed.kept)}{' '}
              stored rows, not all {formatCount(envelope.rows_trimmed.total)}.
            </p>
          </Banner>
        )}

        {spec && options.length > 1 && filter !== 'all' && (
          <p className="text-slate-500 text-xs">
            Filtered to <span className="text-slate-300">{spec.labelFor(filter)}</span>.
            The other rows are still in this section — clear the filter to see them.
          </p>
        )}

        <DataTable<Row>
          rows={shown}
          columns={columns}
          rowKey={(r) => String(r.__i)}
          searchPlaceholder={`Search the ${envelope.rows.length} stored rows…`}
          filters={
            spec && options.length > 1
              ? [{ key: spec.key, label: spec.label, options }]
              : undefined
          }
          activeFilters={spec ? { [spec.key]: filter } : {}}
          onFilterChange={(_k, v) => setFilter(v)}
          onExport={exportSection}
          exportName={`${week}-${envelope.report}`}
          emptyTitle="No rows in this section"
          emptyHint="The section was produced and holds no rows. That is an empty period, not a failure."
        />
      </div>
    </section>
  )
}

// ── Re-run ────────────────────────────────────────────────────────────────────

function RerunModal({
  week, exists, busy, error, onClose, onRun,
}: {
  week: string
  /** Whether a report is already stored for this week. */
  exists: boolean
  busy: boolean
  error: string
  onClose: () => void
  onRun: (opts: { force: boolean; topN: number; reason: string }) => void
}) {
  const [reason, setReason] = useState('')
  // `force` is only meaningful once something is stored. On a week with nothing
  // stored it would be actively wrong: `_next_revision` counts existing
  // documents and `weekly()` takes `max(1, count)`, so forcing a never-run week
  // stores it as revision 1 with no revision 0 underneath it — a week whose
  // record starts at a re-run of nothing.
  const [force, setForce] = useState(exists)
  const [topN, setTopN] = useState(10)
  const ready = reason.trim().length >= MIN_REASON && topN >= 1 && topN <= 100

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg">
        <div className="px-6 py-4 border-b border-slate-800">
          <h3 className="text-white font-semibold">
            {exists ? `Re-run ${week}` : `Run ${week} for the first time`}
          </h3>
          <p className="text-slate-500 text-sm mt-1 leading-relaxed">
            This will be recorded as a <span className="text-slate-300">person-triggered</span>{' '}
            run against your name, and it is not the same fact as the schedule
            firing twice.
          </p>
        </div>

        <div className="px-6 py-5 space-y-4">
          {exists ? (
            <div className="space-y-2">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  checked={force}
                  onChange={() => setForce(true)}
                  className="mt-1 accent-pink-500"
                />
                <span className="text-sm">
                  <span className="text-white font-medium">
                    Recompute and store a new revision
                  </span>
                  <span className="block text-slate-500 text-xs mt-0.5 leading-relaxed">
                    For a week whose sections failed and have since been fixed. The
                    new revision sits <em>beside</em> the original — nothing already
                    stored is edited or replaced.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  checked={!force}
                  onChange={() => setForce(false)}
                  className="mt-1 accent-pink-500"
                />
                <span className="text-sm">
                  <span className="text-white font-medium">
                    Re-send the stored report, do not recompute
                  </span>
                  <span className="block text-slate-500 text-xs mt-0.5 leading-relaxed">
                    For a mail outage. The figures do not move, and every recipient
                    is de-duplicated at the mailbox, so nobody is emailed twice.
                  </span>
                </span>
              </label>
            </div>
          ) : (
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg px-3.5 py-3">
              <p className="text-slate-200 text-sm leading-relaxed">
                Nothing is stored for {week}, so this computes the week and stores
                it as <span className="font-medium">revision 0</span> — the same
                document the Monday job would have written. It is then emailed to
                the owners and the Observer.
              </p>
              <p className="text-slate-500 text-xs mt-2 leading-relaxed">
                A forced re-run is not offered here on purpose: forcing a week with
                nothing stored would file it as revision 1 with no original
                underneath it.
              </p>
            </div>
          )}

          {(force || !exists) && (
            <div>
              <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
                Leaderboard length
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={topN}
                onChange={(e) => setTopN(Number(e.target.value))}
                className="w-28 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
              />
              <p className="text-slate-600 text-xs mt-1">1 to 100. The API refuses anything else.</p>
            </div>
          )}

          <div>
            <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
              Why are you re-running this week?
              <span className="text-pink-400 ml-1 normal-case">(required)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="The hosts section failed because Firestore was unreachable; it reads now."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
            <p className="text-slate-600 text-xs mt-1 leading-relaxed">
              At least {MIN_REASON} characters. The run log records{' '}
              <span className="text-slate-500">who</span> triggered this and that a
              person did — it has no field for the reason itself, so this stays on
              this screen. Put it in the ticket as well.
            </p>
          </div>

          {error && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3.5 py-3">
              <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-red-300 text-sm leading-relaxed">{error}</p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-800 flex gap-3">
          <button
            onClick={onClose}
            disabled={busy}
            className="text-slate-400 hover:text-white text-sm px-4 py-2.5 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={() => onRun({ force, topN, reason: reason.trim() })}
            disabled={busy || !ready}
            title={ready ? undefined : `Give a reason of at least ${MIN_REASON} characters first.`}
            className="flex-1 flex items-center justify-center gap-2 bg-pink-600 hover:bg-pink-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            {busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            {!exists
              ? 'Compute, store and send this week'
              : force
                ? 'Recompute and store a revision'
                : 'Re-send the stored report'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Slot<T> =
  | { status: 'loading' }
  | { status: 'ok'; value: T }
  | { status: 'error'; message: string; notFound: boolean }

export default function WeeklyBusinessReportPage() {
  const { apiUser, apiReady, apiError, loading: authLoading } = useAuth()

  const [week, setWeek] = useState<string>(() => lastClosedIsoWeek())
  const [slot, setSlot] = useState<Slot<WeeklyBusinessRead>>({ status: 'loading' })
  const [revisionId, setRevisionId] = useState<string>('')

  const [modalOpen, setModalOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState('')
  const [runResult, setRunResult] = useState<WeeklyBusinessRun | null>(null)

  const role = apiUser?.role ?? null
  const allowed = role !== null && canRead(role)
  const mayTrigger = role !== null && canTrigger(role)

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    setSlot({ status: 'loading' })
    weeklyBusiness
      .read(week)
      .then((value) => {
        setSlot({ status: 'ok', value })
        // The latest revision is the corrected one: a re-run exists precisely
        // because the original had something wrong with it. The API calls
        // `revisions[0]` — revision 0 — `current`, so which one is on screen is
        // stated rather than assumed.
        const latest = value.revisions[value.revisions.length - 1]
        setRevisionId(latest?.id ?? '')
      })
      .catch((err: unknown) => {
        setSlot({
          status: 'error',
          message:
            err instanceof ApiError
              ? err.message
              : 'The stored weekly report could not be read.',
          notFound: err instanceof ApiError && err.status === 404,
        })
      })
  }, [allowed, apiReady, week])

  useEffect(() => { load() }, [load])

  async function rerun(opts: { force: boolean; topN: number; reason: string }) {
    setRunning(true)
    setRunError('')
    try {
      const result = await weeklyBusiness.run({
        week,
        force: opts.force,
        top_n: opts.topN,
      })
      setRunResult(result)
      setModalOpen(false)
      load()
    } catch (err) {
      setRunError(
        err instanceof ApiError
          ? err.message
          : 'The report was not produced and nothing was sent.',
      )
    } finally {
      setRunning(false)
    }
  }

  const weeks = useMemo(() => recentIsoWeeks(WEEKS_OFFERED), [])

  if (authLoading) return <Loading label="Checking your access…" />
  if (!apiReady && apiError) return <ErrorState message={apiError} />
  if (!apiReady) return <Loading label="Waiting for the API session…" />
  if (!allowed) return <Denied what="the weekly business report" />

  const doc: WeeklyBusinessDoc | null =
    slot.status === 'ok'
      ? slot.value.revisions.find((r) => r.id === revisionId) ?? slot.value.current
      : null

  return (
    <div className="max-w-[1600px] mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold text-white">
            Weekly business report
          </h1>
          <p className="text-slate-400 mt-1 text-sm max-w-3xl leading-relaxed">
            Hosts and their eligibility, agency commission, recharges and seller
            credit, the leaderboards and the P&amp;L — for one ISO week, read back
            from the document that was stored on the day. These are the figures
            that were emailed, not a recomputation.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            onClick={() => setWeek((w) => shiftIsoWeek(w, -1) ?? w)}
            title="The week before"
            className="flex items-center gap-1 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-lg px-2.5 py-2.5 text-sm transition-colors"
          >
            <ChevronLeft size={15} />
          </button>

          <div className="relative">
            <CalendarDays
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none"
            />
            <select
              value={weeks.includes(week) ? week : ''}
              onChange={(e) => e.target.value && setWeek(e.target.value)}
              className="bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
            >
              {!weeks.includes(week) && <option value="">{week}</option>}
              {weeks.map((w, i) => (
                <option key={w} value={w}>
                  {w} · {isoWeekRangeLabel(w)}
                  {i === 0 ? ' · last closed' : ''}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={() => setWeek((w) => shiftIsoWeek(w, 1) ?? w)}
            title="The week after"
            className="flex items-center gap-1 bg-slate-900 border border-slate-800 hover:border-slate-700 text-slate-300 rounded-lg px-2.5 py-2.5 text-sm transition-colors"
          >
            <ChevronRight size={15} />
          </button>

          <button
            onClick={load}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>

          {mayTrigger && (
            <button
              onClick={() => { setRunError(''); setModalOpen(true) }}
              className="flex items-center gap-2 bg-pink-600 hover:bg-pink-500 text-white font-semibold rounded-lg px-3.5 py-2.5 text-sm transition-colors"
            >
              <RefreshCw size={14} /> Run this week
            </button>
          )}
        </div>
      </div>

      {role === 'observer' && (
        <Warning>
          You are signed in as the Observer. Every figure here is readable to you;
          running the report is not — the trigger requires a team admin or an
          owner, so that button is not shown.
        </Warning>
      )}

      {/* What a run just did */}
      {runResult && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-white font-semibold text-sm">
                {runResult.regenerated
                  ? `Recomputed and stored as ${runResult.report_id}.`
                  : `Re-used the stored report ${runResult.report_id} — the figures did not move.`}
              </p>
              <p className="text-slate-500 text-xs mt-1 leading-relaxed">
                {formatCount(runResult.emails_accepted)} email
                {runResult.emails_accepted === 1 ? '' : 's'} accepted by the
                provider · recorded as a {runResult.trigger ?? 'unknown'}-triggered
                run{runResult.triggered_by?.name ? ` by ${runResult.triggered_by.name}` : ''} ·
                status {runResult.status ?? 'unknown'}
              </p>
            </div>
            <button
              onClick={() => setRunResult(null)}
              className="text-slate-500 hover:text-white text-xs shrink-0"
            >
              Dismiss
            </button>
          </div>
          {runResult.recorded === false && (
            <Banner tone="critical" title="The run happened and could NOT be written to the run log.">
              <p>{runResult.record_error ?? 'No reason was recorded.'}</p>
            </Banner>
          )}
          {(runResult.problems?.length ?? 0) > 0 && (
            <Banner tone="warn" title="This run was not clean.">
              <ul className="list-disc pl-4">
                {runResult.problems?.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </Banner>
          )}
          {runResult.reports?.map((r) => (
            r.error ? (
              <Banner key={r.report} tone="critical" title={`${r.report} reached nobody.`}>
                <p>{r.error}</p>
              </Banner>
            ) : null
          ))}
        </div>
      )}

      {/* The week itself */}
      {slot.status === 'loading' ? (
        <Loading label={`Reading the stored report for ${week}…`} />
      ) : slot.status === 'error' ? (
        slot.notFound ? (
          <div className="bg-slate-900 border border-slate-800 rounded-xl px-6 py-10 text-center">
            <FileWarning size={26} className="text-slate-600 mx-auto mb-3" />
            <p className="text-white font-semibold">No report is stored for {week}</p>
            <p className="text-slate-400 text-sm mt-2 max-w-xl mx-auto leading-relaxed">
              {slot.message}
            </p>
            {mayTrigger && (
              <button
                onClick={() => { setRunError(''); setModalOpen(true) }}
                className="mt-5 inline-flex items-center gap-2 bg-pink-600 hover:bg-pink-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
              >
                <RefreshCw size={14} /> Run {week} now
              </button>
            )}
          </div>
        ) : (
          <ErrorState message={slot.message} onRetry={load} />
        )
      ) : doc ? (
        <>
          {/* Which document is on screen */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 space-y-3">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3">
              <div className="min-w-0">
                <p className="text-white font-semibold">
                  {doc.week_label} · {isoWeekRangeLabel(doc.week_label)}
                </p>
                <p className="text-slate-500 text-xs mt-1 leading-relaxed max-w-3xl">
                  {doc.window_note}
                </p>
                <p className="text-slate-500 text-xs mt-1">
                  Generated {formatDateTime(doc.generated_at)} · document{' '}
                  <code className="text-slate-400">{doc.id}</code>
                </p>
              </div>

              {slot.value.revisions.length > 1 && (
                <div className="shrink-0">
                  <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
                    Revision
                  </label>
                  <select
                    value={revisionId}
                    onChange={(e) => setRevisionId(e.target.value)}
                    className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
                  >
                    {slot.value.revisions.map((r) => (
                      <option key={r.id} value={r.id}>
                        Revision {r.revision}
                        {r.revision === 0 ? ' — the original Sunday run' : ' — a re-run'} ·{' '}
                        {formatDateTime(r.generated_at)}
                        {r.failed_sections.length
                          ? ` · ${r.failed_sections.length} failed`
                          : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {slot.value.revisions.length > 1 && (
              <Banner
                tone="neutral"
                icon={<Info size={15} className="mt-0.5 shrink-0 text-slate-400" />}
                title={`${slot.value.revisions.length} revisions exist for ${doc.week_label}. You are reading revision ${doc.revision}.`}
              >
                <p className="text-slate-400">{slot.value.note}</p>
                <p className="text-slate-500 text-xs">
                  Note that the API names revision {slot.value.current.revision} as{' '}
                  <code>current</code> in its response; this page opens on the
                  newest revision instead, because a re-run exists to correct the
                  one before it. Both are kept and neither is edited.
                </p>
              </Banner>
            )}

            <p className="text-slate-600 text-xs leading-relaxed">{doc.immutable}</p>
          </div>

          {doc.failed_sections.length > 0 && (
            <Banner
              tone="critical"
              title={`${doc.failed_sections.length} section(s) could not be computed for this week.`}
            >
              <ul className="list-disc pl-4">
                {doc.failed_sections.map((s) => <li key={s}>{s}</li>)}
              </ul>
              <p className="text-red-200/80">
                They are shown below as failures with the reason the report gave.
                None of them is a zero.
              </p>
            </Banner>
          )}

          {doc.needs_a_person.length > 0 && (
            <Banner
              tone="warn"
              title={`${doc.needs_a_person.length} thing(s) on this week need a person.`}
            >
              <ul className="list-disc pl-4 space-y-1">
                {doc.needs_a_person.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </Banner>
          )}

          <div className="space-y-5">
            {doc.sections.map((section, i) => (
              <SectionCard key={`${doc.id}-${i}`} section={section} week={doc.week_label} />
            ))}
          </div>

          <p className="text-slate-600 text-xs leading-relaxed max-w-3xl">
            <Download size={11} className="inline mr-1 -mt-0.5" />
            Each section exports its own CSV from the rows stored in this
            document. Money is Indian rupees (₹) throughout; the API stores paise
            and this page divides by 100 exactly once.
          </p>
        </>
      ) : null}

      {modalOpen && (
        <RerunModal
          week={week}
          exists={slot.status === 'ok'}
          busy={running}
          error={runError}
          onClose={() => setModalOpen(false)}
          onRun={rerun}
        />
      )}
    </div>
  )
}
