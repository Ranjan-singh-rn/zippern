'use client'

/**
 * The agency's own view of its money.
 *
 * Until now this dashboard showed hosts, KYC and sub-agencies and no commission
 * figure at all — an agency could not see what it had earned, what it had been
 * paid, or what it was owed. The API has served all three for a while:
 *
 *   GET /partners/agencies/{id}/statement      routers/partners.py:44
 *   GET /partners/agencies/{id}/hosts          routers/partners.py:61
 *   GET /partners/agencies/{id}/sub-agencies   routers/partners.py:73
 *
 * `_own_id_or_403` scopes each to the caller's own record, so this asks for
 * `me` and lets the server resolve which record that is. An id copied out of
 * Firestore would be a 403 the moment the two ever drifted.
 *
 * ── Four states, kept four ────────────────────────────────────────────────────
 *
 * Loading, empty, refused and failed are different facts and are drawn
 * differently. Every read goes through `attempt()` and lands as a `ReadResult`,
 * so a refusal cannot reach the screen wearing a zero. A commission of zero is
 * a real answer exactly once — when a real billing figure fell below the floor
 * — and that case has its own section that says so in words.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertTriangle,
  Building2,
  Clock,
  Coins,
  Loader2,
  RefreshCw,
  ShieldOff,
  XCircle,
} from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { UnavailablePanel } from '@/components/ui/States'
import { ApiError } from '@/lib/api'
import { failureCode, toFailure, type ReadFailure, type ReadResult } from '@/lib/readState'
import {
  OWN_RECORD,
  inrExact,
  partnerOps,
  statements,
  commission as commissionOps,
  type AgencyHostRow,
  type AgencyStatement,
  type Partner,
  type SubAgency,
} from '@/lib/apiPartners'
import { MoneyTile, PeriodPicker, defaultPeriod, periodDates, periodParams } from './MoneyUI'
import type { Period } from './MoneyUI'
import { CommissionDerivation } from './CommissionDerivation'
import { CommissionLedger } from './CommissionLedger'
import { HostEarnings, type RosterHost } from './HostEarnings'
import { SubAgencyMoney, readPayout, type SubPayout } from './SubAgencyMoney'

/**
 * The most the statement endpoint will return (`limit: int = Query(le=500)`).
 *
 * Worth asking for the maximum: the server truncates to `limit` and only then
 * narrows to the period, so a small limit quietly understates a busy window.
 * When the read comes back exactly this full, the ledger section says so.
 */
const LEDGER_LIMIT = 500

/**
 * Classify a rejection with `readState`, but say what the SERVER said.
 *
 * `toFailure` describes every refusal in Firestore's vocabulary — "the database
 * refused this read; your role may not cover it, or the rule for it is
 * missing." That is the right sentence for a security rule and the wrong one
 * for an API that refused in a whole sentence of its own. The classification is
 * shared and correct (an HTTP 403 is already mapped to `permission-denied`); it
 * is only the wording that has to come from the response, verbatim, because the
 * API writes its refusals to be shown.
 *
 * Anything that is not an `ApiError` — a network fault, a thrown non-Error —
 * falls through to `toFailure` unchanged.
 */
function apiFailure(err: unknown, label: string): ReadFailure {
  if (err instanceof ApiError && err.message.trim()) {
    console.error(`read failed: ${label}`, err)
    return { ok: false, code: failureCode(err), reason: err.message }
  }
  return toFailure(err, label)
}

/** `attempt`, with the server's own refusal preserved. */
async function read<T>(p: PromiseLike<T>, label: string): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: await p }
  } catch (err) {
    return apiFailure(err, label)
  }
}

export function AgencyMoney({
  roster = [],
  rosterFailure,
}: {
  roster?: RosterHost[]
  /**
   * Set when the caller's own roster read did not complete.
   *
   * It has to be passed in, because an empty `roster` array cannot tell the two
   * cases apart and one of them is a lie: the dashboard leaves `hosts` at `[]`
   * when the query is refused, so without this the "Active hosts" tile would
   * print 0 for an agency whose hosts it simply was not allowed to read. That is
   * the exact substitution every read on this screen goes through `ReadResult`
   * to avoid.
   */
  rosterFailure?: ReadFailure
}) {
  const { apiReady, apiError, apiUser, crmUser } = useAuth()

  const [period, setPeriod] = useState<Period>(defaultPeriod)

  const [partner, setPartner] = useState<ReadResult<Partner> | null>(null)
  const [statement, setStatement] = useState<ReadResult<AgencyStatement> | null>(null)
  const [hosts, setHosts] = useState<ReadResult<AgencyHostRow[]> | null>(null)
  const [subs, setSubs] = useState<ReadResult<SubAgency[]> | null>(null)
  const [payouts, setPayouts] = useState<ReadResult<SubPayout[]> | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // An external partner asks for `me`. A staff account that somehow lands here
  // is passed through as written, because for an internal role the server does
  // not resolve `me` into anything.
  const external = apiUser?.role === 'agency' || apiUser?.role === 'seller'
  const recordId = external ? OWN_RECORD : (crmUser?.agencyId ?? '')

  const loadRecord = useCallback(async () => {
    if (!recordId) return

    // Each read lands on its own. One panel refusing must not blank the others,
    // and each says for itself which of the four states it is in.
    //
    // Sub-agencies is an agency route, so `me` is unambiguous on it. The
    // partner record is NOT: `GET /partner-ops/partners/{id}` serves an
    // agency's record and a seller's alike and so declares no `kind`, which
    // makes `me` a 400 for the dual-role login this very dashboard invites
    // people to create. It is fetched separately, by the concrete id the
    // statement resolved.
    const [subsResult, payoutsResult] = await Promise.all([
      read(statements.subAgenciesOf(recordId), 'sub-agencies'),
      read(commissionOps.openSubAgencyPayouts(), 'open sub-agency payouts'),
    ])
    setSubs(subsResult)
    setPayouts(
      payoutsResult.ok
        ? { ok: true, value: payoutsResult.value.map(readPayout) }
        : payoutsResult,
    )
  }, [recordId])

  const loadPeriod = useCallback(async () => {
    if (!recordId) return
    setStatement(null)
    setHosts(null)

    const params = periodParams(period)
    const [statementResult, hostsResult] = await Promise.all([
      read(
        statements.agency(recordId, { ...params, limit: LEDGER_LIMIT }),
        'agency statement',
      ),
      // The hosts endpoint takes `since` only — passing `until` would be
      // ignored, and pretending otherwise is what HostEarnings refuses to do.
      read(
        statements.agencyHosts(recordId, { since: params.since, limit: LEDGER_LIMIT }),
        'agency host earnings',
      ),
    ])
    setStatement(statementResult)
    setHosts(hostsResult)

    // The statement is what turns `me` into a real id, kind-scoped to the
    // agency capability. Everything that needs a concrete id waits for it.
    if (statementResult.ok && statementResult.value.agency_id) {
      setPartner(
        await read(
          partnerOps.get(statementResult.value.agency_id),
          'agency partner record',
        ),
      )
    } else {
      setPartner(null)
    }
  }, [recordId, period])

  useEffect(() => {
    if (apiReady && recordId) loadRecord()
  }, [apiReady, recordId, loadRecord])

  useEffect(() => {
    if (apiReady && recordId) loadPeriod()
  }, [apiReady, recordId, loadPeriod])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([loadRecord(), loadPeriod()])
    setRefreshing(false)
  }, [loadRecord, loadPeriod])

  // ── The session has not arrived ─────────────────────────────────────────────
  // Rendering ₹0 here would be a lie about the balance rather than a statement
  // about the session, so nothing numeric is drawn until there is one.
  if (!apiReady) {
    return (
      <Frame>
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-8 text-center">
          {apiError ? (
            <>
              <AlertTriangle size={24} className="text-amber-400 mx-auto mb-3" />
              <p className="text-amber-100 text-sm font-semibold">
                Your money is not being shown because the session that reads it
                is not there.
              </p>
              <p className="text-slate-400 text-sm mt-1.5 max-w-lg mx-auto leading-relaxed">
                {apiError}
              </p>
              <p className="text-slate-600 text-xs mt-2">
                No figure is shown rather than a zero — nothing has been measured.
              </p>
            </>
          ) : (
            <>
              <Loader2 size={22} className="animate-spin text-pink-500 mx-auto mb-3" />
              <p className="text-slate-400 text-sm">
                Connecting to your commission record…
              </p>
            </>
          )}
        </div>
      </Frame>
    )
  }

  // ── The login is not linked to a partner record ─────────────────────────────
  if (!recordId) {
    return (
      <Frame>
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-8 text-center">
          <ShieldOff size={24} className="text-slate-600 mx-auto mb-3" />
          <p className="text-slate-300 text-sm font-medium">
            This login is not linked to an agency record.
          </p>
          <p className="text-slate-500 text-sm mt-1.5 max-w-lg mx-auto leading-relaxed">
            The commission endpoints resolve your record from your session, and
            your session names no agency. Nothing is shown here because there is
            nothing to read — not because the balance is zero.
          </p>
        </div>
      </Frame>
    )
  }

  const record = partner?.ok ? partner.value : null
  const isSub = record?.kind === 'sub_agency'
  const basisError = statement?.ok ? statement.value.commission_basis_error : null

  // ── No approved record yet ──────────────────────────────────────────────────
  // An applicant under review holds a session with no partner ids on it, and
  // `own_partner_id_or_403` refuses every scoped route with one sentence
  // written to be shown. That refusal IS the answer — there is no balance to
  // read, which is not the same as a balance of nothing — so it gets its own
  // panel rather than four refused tiles saying the same thing four times.
  if (statement && !statement.ok && statement.code === 'permission-denied') {
    return (
      <Frame>
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-8 text-center">
          <Clock size={24} className="text-amber-400 mx-auto mb-3" />
          <p className="text-slate-200 text-sm font-semibold">
            There is no commission record to show yet.
          </p>
          <p className="text-slate-400 text-sm mt-2 max-w-lg mx-auto leading-relaxed">
            {statement.reason}
          </p>
          <p className="text-slate-600 text-xs mt-3 max-w-lg mx-auto leading-relaxed">
            Nothing numeric is shown here on purpose. A balance that does not
            exist yet is not a balance of ₹0, and drawing one would be the first
            wrong number this page ever told you. Once Zipper approves your
            agency, your earned, paid and outstanding figures appear here and
            update as your hosts earn. The rest of this dashboard — your hosts,
            your KYC, your sub-agencies — is unaffected and still below.
          </p>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="mt-4 inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 rounded-lg px-4 py-2 text-sm transition-colors"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            Check again
          </button>
        </div>
      </Frame>
    )
  }

  return (
    <Frame>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-white text-xl sm:text-2xl font-bold flex items-center gap-2">
            <Coins size={20} className="text-pink-500 shrink-0" />
            Your commission
          </h2>
          <p className="text-slate-500 text-xs mt-1 leading-relaxed max-w-2xl">
            Earned, paid and outstanding — read live from the ledger Zipper
            settles against. Every figure is Indian Rupees (INR).
            {statement?.ok && statement.value.agency_id && (
              <>
                {' '}
                Record{' '}
                <span className="font-mono text-slate-400">
                  {statement.value.agency_id}
                </span>
                .
              </>
            )}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors shrink-0"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {partner && !partner.ok && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl mb-4">
          <UnavailablePanel
            failure={partner}
            what="Your agency record"
            onRetry={refresh}
          />
        </div>
      )}

      {record && <StatusBanner partner={record} />}

      <div className="mb-4">
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>

      {/* ── The three figures ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <MoneyTile
          label="Earned"
          loading={statement === null}
          failure={statement && !statement.ok ? statement : undefined}
          value={statement?.ok ? inrExact(statement.value.commission_earned) : undefined}
          hint={`Credited in ${period.mode === 'lifetime' ? 'total' : 'this period'} · ${periodDates(period)}`}
          tone="text-green-300"
        />
        <MoneyTile
          label="Paid to you"
          loading={statement === null}
          failure={statement && !statement.ok ? statement : undefined}
          value={statement?.ok ? inrExact(statement.value.commission_paid) : undefined}
          hint={`Payments out in ${period.mode === 'lifetime' ? 'total' : 'this period'}`}
          tone="text-slate-200"
        />
        <MoneyTile
          label="Outstanding"
          loading={statement === null}
          failure={statement && !statement.ok ? statement : undefined}
          value={
            statement?.ok ? inrExact(statement.value.commission_outstanding) : undefined
          }
          hint="Owed to you right now. This one is your live balance and is never scoped to the period."
          tone={
            statement?.ok && statement.value.commission_outstanding > 0
              ? 'text-amber-300'
              : 'text-slate-500'
          }
        />
        {/* The ROSTER this component was handed, not `statement.host_count`.
            `host_count` is a count of the Mongo collection `agency_hosts`
            (backend/app/services/partners.py:136), and nothing in the backend
            writes that collection — so this tile read 0 for every agency on the
            platform, including ones listing hosts in the table further up this
            same page. `roster` is the `users where agencyId == mine` read the
            dashboard already made, which is the real answer; it needs no request
            and cannot disagree with the table beside it. */}
        <MoneyTile
          label="Active hosts"
          loading={false}
          failure={rosterFailure}
          value={rosterFailure ? undefined : roster.length.toLocaleString('en-IN')}
          hint="Hosts who have redeemed their code and are linked to you. Invitations not yet redeemed are in the Hosts table below."
          tone="text-slate-200"
        />
      </div>

      {statement && !statement.ok ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl mb-6">
          <UnavailablePanel
            failure={statement}
            what="Your commission statement"
            onRetry={loadPeriod}
          />
        </div>
      ) : (
        <>
          <CommissionDerivation
            basis={statement?.ok ? statement.value.commission_basis : null}
            basisError={basisError}
            rule={statement?.ok ? statement.value.commission_rule : ''}
            period={period}
            loading={statement === null}
            roster={roster}
          />

          <CommissionLedger
            entries={statement?.ok ? statement.value.entries : []}
            truncated={
              statement?.ok ? statement.value.entries.length >= LEDGER_LIMIT : false
            }
            limit={LEDGER_LIMIT}
            period={period}
            loading={statement === null}
          />
        </>
      )}

      <HostEarnings hosts={hosts} roster={roster} period={period} onRetry={loadPeriod} />

      <SubAgencyMoney
        subs={subs}
        payouts={payouts}
        myId={statement?.ok ? statement.value.agency_id : recordId}
        isSub={!!isSub}
        onRetry={loadRecord}
      />
    </Frame>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="mb-8">{children}</div>
}

/**
 * What this account's standing means for the money below it.
 *
 * A pending agency is the case that used to be worst served: the page showed
 * nothing and explained nothing. Its record may exist with a real balance, or
 * may not exist at all — in which case the statement is honest zeroes and
 * `commission_basis_error` carries the reason, which the derivation section
 * prints. Either way the account's own standing is said here, in words.
 */
function StatusBanner({ partner }: { partner: Partner }) {
  if (partner.status === 'approved' && partner.is_active) return null

  if (partner.status === 'pending') {
    return (
      <Banner tone="amber" icon={<Clock size={16} />} title="Your agency is still under review.">
        Your record exists and anything already on it is shown below. Commission
        is credited once you are approved, and a payout cannot be raised against
        an account that is not approved — the API refuses it. If the sections
        below show no derivation at all, the reason for that is printed there
        rather than replaced with a zero.
      </Banner>
    )
  }

  if (partner.status === 'rejected') {
    return (
      <Banner tone="red" icon={<XCircle size={16} />} title="This application was rejected.">
        {partner.rejection_reason ||
          'No reason was recorded against your record. Ask Zipper for it — a rejection is required to carry one.'}
      </Banner>
    )
  }

  if (partner.status === 'suspended') {
    return (
      <Banner tone="amber" icon={<AlertTriangle size={16} />} title="Your agency is suspended.">
        Your history stays on record and commission you have already earned is
        still owed to you. The balance below is real; new commission does not
        accrue while the suspension stands.
      </Banner>
    )
  }

  return (
    <Banner tone="slate" icon={<Building2 size={16} />} title="Your agency is inactive.">
      The account is approved but not active, so nothing new accrues. Anything
      already earned is still owed and is shown below.
    </Banner>
  )
}

function Banner({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'amber' | 'red' | 'slate'
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  const skin = {
    amber: 'bg-amber-500/10 border-amber-500/40 text-amber-100',
    red: 'bg-red-500/10 border-red-500/40 text-red-100',
    slate: 'bg-slate-800/60 border-slate-700 text-slate-200',
  }[tone]

  return (
    <div className={`flex items-start gap-3 border rounded-xl px-4 py-3.5 mb-4 ${skin}`}>
      <span className="mt-0.5 shrink-0 opacity-80">{icon}</span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-sm mt-1 opacity-85 leading-relaxed">{children}</p>
      </div>
    </div>
  )
}
