'use client'

/**
 * Agencies.
 *
 * The list answers the two questions an owner actually asks: how many hosts is
 * this agency running, and what do we still owe them.
 *
 * Sub-agencies are shown with their parent attached, because that is not
 * decoration — a sub-agency is paid *through* its parent (spec 4.2.4). Paying
 * one directly is how money leaves the business against a relationship nobody
 * has on record.
 *
 * Approve, reject and deactivate are team decisions and move no money. A
 * commission payout is a card, and an owner signs it on /board.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, Building2, Check, CheckCircle2, ClipboardCopy, Clock,
  CornerDownRight, Loader2, Plus, RefreshCw, Users, X, XCircle,
} from 'lucide-react'
import { Column, DataTable } from '@/components/ui/DataTable'
import { Denied, UnavailableInline, Warning } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { SecondRoleApplications } from '@/components/SecondRoleApplications'
import { FailedRegistrations } from '@/components/FailedRegistrations'
import { canAccess, hasPermission } from '@/lib/auth'
import { resendPartnerEmail } from '@/lib/partnerEmails'
import { ApiError } from '@/lib/api'
import {
  getAgencies, getAgencyRoster, rosterCountOf, rosterFailureOf,
  AGENCY_LIST_LIMIT, type Agency, type AgencyRoster,
} from '@/lib/agencies'
import { loginStateOf, type LoginState } from '@/lib/partnerDuplicates'
import { ok, toFailure, type ReadFailure, type ReadResult } from '@/lib/readState'
import {
  commission, inBatches, partnerOps, statements,
  inr, STATUS_TONE,
  type AgencyStatement, type Partner, type PartnerStatus,
} from '@/lib/apiPartners'

const PAGE_ROLES = [
  'superadmin', 'app_admin', 'ops_admin', 'finance_admin', 'finance_member',
] as const

const MIN_REASON = 3

interface Row {
  id: string
  name: string
  /** Owner, email and referral code come from the profile — see `profiles`. */
  owner: string
  email: string
  referralCode: string
  status: PartnerStatus
  /** Stored on the record by the API, and shown here so it is not lost. */
  rejectionReason: string
  isActive: boolean
  isSub: boolean
  parentId: string | null
  parentName: string | null
  statement: AgencyStatement | null
  /**
   * Who this agency actually has, from Firestore. `null` while the read is
   * still in flight.
   *
   * It is NOT `statement.host_count`, which is what this column used to show
   * and which is zero for every agency that has ever existed — see the long
   * note above `getAgencyRoster` in lib/agencies.ts. A commission statement
   * answers what an agency earned; it cannot answer who works for them.
   */
  roster: AgencyRoster | null
  /** `null` when the roster could not be read — never rendered as 0. */
  hostCount: number | null
  /**
   * What can sign in as this agency, from the Firestore record.
   *
   * `null` means the Firestore document was not read — not that there is no
   * login. The list is capped at AGENCY_LIST_LIMIT, so older agencies genuinely
   * arrive without one, and badging those "no login attached" would be a lie in
   * the same shape as the one this whole change exists to remove.
   */
  login: LoginState | null
  partner: Partner
}

type Action = 'approve' | 'reject' | 'deactivate'

const ACTION_COPY: Record<Action, { title: string; hint: string; verb: string; tone: string }> = {
  approve: {
    title: 'Approve this agency',
    hint: 'They can start earning commission. No money moves now — a payout is a separate card an owner signs.',
    verb: 'Approve',
    tone: 'bg-green-600 hover:bg-green-500',
  },
  reject: {
    title: 'Reject this application',
    hint: 'The reason is stored on the record and shown to the applicant, so they are told why instead of silently reapplying.',
    verb: 'Reject',
    tone: 'bg-red-600 hover:bg-red-500',
  },
  deactivate: {
    title: 'Deactivate this agency',
    hint: 'The record is kept and their history stays attributable. Commission already earned is still owed.',
    verb: 'Deactivate',
    tone: 'bg-amber-600 hover:bg-amber-500',
  },
}

export default function Agencies() {
  const { crmUser } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, [...PAGE_ROLES])

  /*
   * The decide buttons, gated on the PERMISSION rather than on who may open the
   * page — and those are deliberately different lists.
   *
   * Viewing a partner is reasonable for finance, who have to reconcile against
   * them; approving one is `can_approve_kyc` / `can_approve_seller`, which only
   * `superadmin` and `ops_admin` hold. The page gate admitted the wider list and
   * then rendered live Approve and Reject buttons to all of them, so four roles
   * could fill in a mandatory reason, press a button and receive a 403 — with
   * no way to tell a permission boundary from a broken screen.
   *
   * The server was already right. This only stops the UI offering what it will
   * refuse. Nobody gains a permission here.
   */
  const mayDecide = hasPermission(crmUser, 'can_approve_kyc')

  const [partners, setPartners] = useState<Partner[]>([])
  const [books, setBooks] = useState<Record<string, AgencyStatement>>({})
  // The roster per agency, read from Firestore rather than derived from the
  // commission ledger. See `Row.roster`.
  const [rosters, setRosters] = useState<Record<string, AgencyRoster>>({})
  // Owner name, contact email and referral code are profile fields the Android
  // app reads from Firestore; the API record does not carry them. Read here so
  // the three things people actually search by are searchable.
  const [profiles, setProfiles] = useState<Record<string, Agency>>({})
  const [profilesCapped, setProfilesCapped] = useState(false)
  // `null` while unread, a `ReadFailure` when the read did not complete. It was
  // `useState(0)` with `.catch(() => setOpenLegs(0))`, which turned "we could
  // not check for unconfirmed sub-agency payouts" into the silent all-clear of
  // an unrendered warning banner — the reassuring outcome, produced by failure.
  const [openLegs, setOpenLegs] = useState<ReadResult<number> | null>(null)
  const [loading, setLoading] = useState(true)
  const [enriching, setEnriching] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [status, setStatus] = useState('all')
  const [type, setType] = useState('all')
  const [pending, setPending] = useState<{ row: Row; action: Action } | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const [main, subs] = await Promise.all([
        partnerOps.list({ kind: 'agency', limit: 500 }),
        partnerOps.list({ kind: 'sub_agency', limit: 500 }),
      ])
      const all = [...main, ...subs]
      setPartners(all)
      setLoading(false)

      commission
        .openSubAgencyPayouts()
        .then((list) => setOpenLegs(ok(list.length)))
        .catch((err) => setOpenLegs(toFailure(err, 'agencies/openSubAgencyPayouts')))

      getAgencies()
        .then((docs) => {
          setProfilesCapped(docs.length >= AGENCY_LIST_LIMIT)
          const byId: Record<string, Agency> = {}
          docs.forEach((d) => { byId[d.id] = d })
          setProfiles(byId)
        })
        .catch(() => setProfiles({}))

      // Commission and the roster are one round trip each per agency, so the
      // table shows first and fills in. Per-agency rather than one collection
      // scan, because the roster is two filtered queries and there is no way to
      // ask Firestore for "hosts grouped by agency" — and because the shape is
      // already the one this page uses for the statements, so the concurrency
      // cap and the progressive fill behave the same way.
      //
      // Both are asked inside one `inBatches` pass to keep the concurrency cap
      // meaningful, but each carries its OWN catch. `inBatches` collapses a
      // rejected worker to `null`, so a single shared catch would mean a refused
      // commission statement also blanked the host count — one unreadable figure
      // taking an unrelated one down with it, which is the shape of bug this
      // page keeps producing. `getAgencyRoster` never rejects; it reports each
      // of its two reads separately.
      setEnriching(true)
      const foundBooks: Record<string, AgencyStatement> = {}
      const foundRosters: Record<string, AgencyRoster> = {}
      await inBatches(all, async (p) => {
        const [st, roster] = await Promise.all([
          statements.agency(p.id).catch(() => null),
          getAgencyRoster(p.id),
        ])
        if (st) foundBooks[p.id] = st
        foundRosters[p.id] = roster
        return null
      })
      setBooks(foundBooks)
      setRosters(foundRosters)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load agencies.')
      setLoading(false)
    } finally {
      setEnriching(false)
    }
  }, [])

  useEffect(() => { if (allowed) load() }, [allowed, load])

  const rows = useMemo<Row[]>(() => {
    const nameById = new Map(partners.map((p) => [p.id, p.name || p.id]))
    return partners
      .map((p) => {
        const profile = profiles[p.crm_id || p.id] ?? profiles[p.id] ?? null
        const roster = rosters[p.id] ?? null
        return {
          id: p.id,
          name: p.name || profile?.agencyName || p.id,
          owner: profile?.ownerName ?? '',
          email: profile?.ownerEmail ?? p.email ?? '',
          referralCode: profile?.referralCode ?? '',
          status: p.status,
          rejectionReason: p.rejection_reason ?? '',
          isActive: p.is_active,
          isSub: p.kind === 'sub_agency',
          parentId: p.parent_id ?? null,
          parentName: p.parent_id ? (nameById.get(p.parent_id) ?? null) : null,
          statement: books[p.id] ?? null,
          roster,
          hostCount: rosterCountOf(roster),
          login: profile ? loginStateOf(profile) : null,
          partner: p,
        }
      })
      .sort((a, b) => {
        const owed =
          (b.statement?.commission_outstanding ?? 0) -
          (a.statement?.commission_outstanding ?? 0)
        return owed !== 0 ? owed : a.name.localeCompare(b.name)
      })
  }, [partners, books, profiles, rosters])

  const filtered = useMemo(
    () =>
      rows.filter(
        (r) =>
          (status === 'all' || r.status === status) &&
          (type === 'all' || (type === 'sub' ? r.isSub : !r.isSub)),
      ),
    [rows, status, type],
  )

  // Which agencies already have a business record. A second-capability
  // application that is in here needs no bridging — it is already in the queue.
  const knownPartnerIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows])

  const totalOwed = rows.reduce(
    (sum, r) => sum + (r.statement?.commission_outstanding ?? 0),
    0,
  )
  /**
   * Agencies whose commission statement did not come back. Their outstanding
   * balance is missing from the total above, so it is a FLOOR and the tile says
   * so — `inBatches` turns a rejected call into `null`, and `?? 0` above would
   * otherwise fold a refused read into a confident figure.
   */
  const booksMissing = enriching
    ? 0
    : rows.filter((r) => r.statement === null).length

  /**
   * Hosts, across every agency — from the rosters, not from the ledger.
   *
   * This used to be `sum of statement.host_count`, which is a Mongo collection
   * nothing writes, so the tile read 0 for a platform with hosts on it. See
   * `getAgencyRoster` in lib/agencies.ts.
   *
   * Summed only over the rosters that were actually read. If any was refused the
   * number is a floor and the tile is labelled as one; while the reads are still
   * in flight it shows what has arrived so far rather than a zero that will
   * change under the reader.
   */
  const totalHosts = rows.reduce((sum, r) => sum + (r.hostCount ?? 0), 0)
  const rosterFailures = rows
    .map((r) => rosterFailureOf(r.roster))
    .filter((f): f is ReadFailure => f !== null)
  const rostersRead = rows.filter((r) => r.hostCount !== null).length
  const hostsPartial = rostersRead < rows.length
  const orphanSubs = rows.filter((r) => r.isSub && !r.parentId).length
  // Agencies nobody can sign in as. Counted only from records actually read —
  // `login: null` means the Firestore document was not seen, not that it is fine.
  const noLoginRows = rows.filter((r) => r.login === 'none')

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Agency',
      value: (r) => r.name,
      render: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Link
              href={`/agencies/${r.id}`}
              className="text-white font-medium truncate hover:text-pink-400 transition-colors"
            >
              {r.name}
            </Link>
            {r.isSub && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 shrink-0">
                sub
              </span>
            )}
            {/* A coin seller applying to also run an agency. Approving this row
                grants that capability on their existing login and creates this
                record at zero — it is not a new partner walking in off the
                street, and the reviewer should not have to guess which. */}
            {r.partner.second_role_of && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 shrink-0"
                title={`Second capability for coin seller ${r.partner.second_role_of}`}
              >
                also a coin seller
              </span>
            )}
            {/* Nobody can sign in as this agency. It is what a registration that
                half-failed leaves behind: the record was written, the login was
                not. The four registration forms now create the login first, so
                anything badged here predates that or failed at a later step. */}
            {r.login === 'none' && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-300 shrink-0"
                title="Neither crmUid nor ownerUid is set on the Firestore record — nobody can ever sign in as this agency."
              >
                no login attached
              </span>
            )}
            {r.login === 'app_only' && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 shrink-0"
                title="No crmUid on the Firestore record — an app account owns it, but nobody can sign into the CRM as this agency."
              >
                no CRM login
              </span>
            )}
          </div>
          <p className="text-slate-600 text-xs font-mono truncate">{r.id}</p>
          {(r.owner || r.referralCode) && (
            <p className="text-slate-500 text-xs truncate">
              {r.owner}
              {r.owner && r.referralCode ? ' · ' : ''}
              {r.referralCode && <span className="font-mono">{r.referralCode}</span>}
            </p>
          )}
          {r.isSub && (
            <p className="flex items-center gap-1 text-xs mt-0.5 text-slate-400">
              <CornerDownRight size={10} className="shrink-0" />
              {r.parentId ? (
                <>paid via {r.parentName ?? r.parentId}</>
              ) : (
                <span className="text-red-300">no parent on record</span>
              )}
            </p>
          )}
          {/* The rejection reason, kept in front of whoever looks next. An
              applicant who is told nothing simply reapplies. */}
          {r.status === 'rejected' && (
            <p className="flex items-start gap-1 text-xs mt-1 text-red-300/90">
              <XCircle size={10} className="mt-0.5 shrink-0" />
              <span className="truncate max-w-xs" title={r.rejectionReason}>
                {r.rejectionReason || 'rejected — no reason on record'}
              </span>
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Type',
      hideOnMobile: true,
      value: (r) => (r.isSub ? 'sub' : 'main'),
      render: (r) => (
        <span
          className={`text-xs px-2 py-1 rounded ${
            r.isSub ? 'bg-slate-700 text-slate-300' : 'bg-purple-500/15 text-purple-300'
          }`}
        >
          {r.isSub ? 'Sub-agency' : 'Main'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      value: (r) => r.status,
      render: (r) => (
        <span className={`text-xs px-2 py-1 rounded ${STATUS_TONE[r.status] ?? 'bg-slate-700 text-slate-300'}`}>
          {r.status}{r.status === 'approved' && !r.isActive ? ' · inactive' : ''}
        </span>
      ),
    },
    {
      key: 'outstanding',
      header: 'Commission owed',
      align: 'right',
      value: (r) => r.statement?.commission_outstanding ?? null,
      render: (r) =>
        r.statement ? (
          <span
            className={
              r.statement.commission_outstanding > 0
                ? 'text-amber-300 font-semibold'
                : 'text-slate-600'
            }
          >
            {r.statement.commission_outstanding > 0
              ? inr(r.statement.commission_outstanding)
              : '—'}
          </span>
        ) : enriching ? (
          <Loader2 size={11} className="animate-spin text-slate-700 inline" />
        ) : (
          <span className="text-slate-700">—</span>
        ),
    },
    {
      key: 'earned',
      header: 'Earned',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.statement?.commission_earned ?? null,
      render: (r) => (
        <span className="text-slate-400">
          {r.statement ? inr(r.statement.commission_earned) : '—'}
        </span>
      ),
    },
    {
      key: 'hosts',
      header: 'Hosts',
      align: 'right',
      hideOnMobile: true,
      value: (r) => r.hostCount,
      /**
       * The ROSTER, which is what the header says. It used to be
       * `statement.host_count` — a count of a Mongo collection with no writer,
       * so this column read 0 for an agency that was listing two hosts in its
       * own portal at the same moment. See `getAgencyRoster`.
       *
       * The second line breaks the number down when part of it is not yet an
       * app account, because "2 hosts" beside an agency that has one person
       * actually live is a question somebody will ask, and the answer is on the
       * row rather than two screens away.
       */
      render: (r) => {
        if (!r.roster) {
          return enriching
            ? <Loader2 size={11} className="animate-spin text-slate-700 inline" />
            : <span className="text-slate-700">—</span>
        }
        const failure = rosterFailureOf(r.roster)
        if (failure) {
          return <UnavailableInline failure={failure} label="not read" />
        }
        const waiting = r.roster.awaiting + r.roster.pending
        return (
          <div>
            <span className={r.roster.total > 0 ? 'text-white' : 'text-slate-600'}>
              {r.roster.total.toLocaleString('en-IN')}
            </span>
            {waiting > 0 && (
              <p className="text-slate-500 text-xs whitespace-nowrap">
                {r.roster.active} active · {waiting} not joined yet
              </p>
            )}
            {/* Not in the number above, and worth saying anyway: their earnings
                are still in this agency's ledger, so a commission figure that
                looks large for the head count is explained here. */}
            {r.roster.former > 0 && (
              <p className="text-slate-600 text-xs whitespace-nowrap">
                {r.roster.former} former, not counted
              </p>
            )}
            {r.roster.capped && (
              <p className="text-amber-400/80 text-xs whitespace-nowrap">at the read cap</p>
            )}
          </div>
        )
      },
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      value: () => '',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          {mayDecide && r.status !== 'approved' && (
            <RowButton tone="green" onClick={() => setPending({ row: r, action: 'approve' })}>
              <CheckCircle2 size={11} /> Approve
            </RowButton>
          )}
          {mayDecide && r.status !== 'rejected' && (
            <RowButton tone="red" onClick={() => setPending({ row: r, action: 'reject' })}>
              <XCircle size={11} /> Reject
            </RowButton>
          )}
          {mayDecide && (
            <RowButton
              tone="slate"
              onClick={async () => {
                /*
                 * Re-sends the standard email — no credential in it, and no
                 * account created. Optimistic and quiet: the trigger deletes the
                 * field once it has sent, so there is no state to reconcile and
                 * a failure costs nothing but a second press.
                 */
                try {
                  await resendPartnerEmail(
                    'agency', r.id,
                    r.status === 'approved' ? 'approval' : 'registration',
                  )
                  setNotice(`Email queued again for ${r.name || r.id}.`)
                } catch {
                  setNotice('Could not queue that email. Try again.')
                }
              }}
            >
              Resend email
            </RowButton>
          )}
          {mayDecide && r.isActive && (
            <RowButton tone="slate" onClick={() => setPending({ row: r, action: 'deactivate' })}>
              Deactivate
            </RowButton>
          )}
        </div>
      ),
    },
  ]

  if (!allowed) return <Denied what="agencies" />

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <Building2 size={26} className="text-pink-500" />
            Agencies
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Who is running hosts for us, and what we still owe them.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/agencies/register"
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            <Plus size={14} /> Add agency
          </Link>
          <button
            onClick={() => { setLoading(true); load() }}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {/* An agency can also apply without us. That link was in the codebase and
          nowhere else, so it is here to be copied and sent. */}
      <PublicSignupLink
        path="/agency-signup"
        lead="An agency can apply themselves at"
      />

      {/* Existing coin sellers asking to also run an agency. Renders nothing
          when there are none. Filing one creates a separate agency record
          holding no commission and puts it in the table below. */}
      <SecondRoleApplications
        kind="agency"
        knownPartnerIds={knownPartnerIds}
        onFiled={() => { setLoading(true); load() }}
      />

      {/* Agencies whose business record could not be created when they
          registered. They are not in the table below and nobody can approve
          them — see components/FailedRegistrations.tsx. Renders nothing when
          every registration went through, which is the normal case. */}
      <FailedRegistrations
        kind="agency"
        knownPartnerIds={knownPartnerIds}
        onRegistered={() => { setLoading(true); load() }}
      />

      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      {openLegs !== null && !openLegs.ok && (
        <div className="flex items-start gap-2 bg-yellow-500/10 border border-yellow-500/40 rounded-xl px-4 py-3 mb-4">
          <AlertTriangle size={16} className="text-yellow-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-yellow-200 text-sm font-semibold">
              Unconfirmed sub-agency payouts could not be checked — this is not
              &ldquo;none outstanding&rdquo;.
            </p>
            <p className="text-yellow-100/75 text-sm mt-0.5">{openLegs.reason}</p>
          </div>
        </div>
      )}

      {openLegs?.ok && openLegs.value > 0 && (
        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/40 rounded-xl px-4 py-3 mb-4">
          <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-amber-100 text-sm font-semibold">
              {openLegs.value} sub-agency payout{openLegs.value === 1 ? '' : 's'} left our
              account and {openLegs.value === 1 ? 'has' : 'have'} not been confirmed
              passed on.
            </p>
            <p className="text-amber-100/75 text-sm mt-0.5">
              A sub-agency is paid through its parent. Until the parent confirms
              it forwarded the money, the payout stays open and the sub-agency
              may not have been paid at all.
            </p>
          </div>
        </div>
      )}

      {profilesCapped && (
        <Warning>
          Owner, email and referral code were matched against the newest{' '}
          {AGENCY_LIST_LIMIT} profile records. Agencies older than that still
          appear in this list, but searching by owner or referral code will not
          find them — search by agency name or id instead.
        </Warning>
      )}

      {/* Agencies with no login. These are the residue of the registration bug:
          the record was written before the Firebase Auth account, so every retry
          against an address that already had a login left one behind. Nothing
          here deletes anything — reject the duplicates with the ordinary Reject
          button, which records a reason and stays auditable. */}
      {noLoginRows.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3.5 mb-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-red-200 text-sm font-semibold">
                {noLoginRows.length} agency record
                {noLoginRows.length === 1 ? ' has' : 's have'} no login attached.
              </p>
              <p className="text-red-200/75 text-sm mt-0.5">
                Neither <span className="font-mono">crmUid</span> nor{' '}
                <span className="font-mono">ownerUid</span> is set, so nobody can
                ever sign in as them — they are what a registration that
                half-failed leaves behind. Approving one does nothing useful.
                Reject the duplicates below; the reason goes on the record.
              </p>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                {noLoginRows.slice(0, 8).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 text-xs">
                    <Link href={`/agencies/${r.id}`} className="text-red-100 truncate hover:text-white">
                      {r.name}
                    </Link>
                    <span className="text-red-300 shrink-0">{r.email || r.id}</span>
                  </li>
                ))}
              </ul>
              {noLoginRows.length > 8 && (
                <p className="text-red-200/60 text-xs mt-1">
                  and {noLoginRows.length - 8} more.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {orphanSubs > 0 && (
        <Warning>
          {orphanSubs} sub-agenc{orphanSubs === 1 ? 'y has' : 'ies have'} no parent
          on record. Money cannot be routed to them correctly until a parent is
          set — the API will refuse a payout.
        </Warning>
      )}

      {/* Four tiles, and each one now counts what its label says.
          "Agencies" used to be `rows.length`, which is main agencies AND
          sub-agencies together, sitting immediately left of a "Sub-agencies"
          tile counting a subset of it. With one agency and no subs it reads 1
          and 0 and looks right; with three and two it reads 5 and 2, and
          everybody adds them up to seven. Two tiles that partition the same set
          are worth more than one that overlaps another. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat
          label="Main agencies"
          value={String(rows.filter((r) => !r.isSub).length)}
          tone="text-white"
        />
        <Stat
          label="Sub-agencies"
          value={String(rows.filter((r) => r.isSub).length)}
          tone="text-slate-300"
        />
        <Stat
          label="Hosts"
          value={totalHosts.toLocaleString('en-IN')}
          tone="text-slate-300"
          note={
            enriching && hostsPartial
              ? `counting — ${rostersRead} of ${rows.length} agencies read`
              : rosterFailures.length > 0
                ? `at least — ${rosterFailures.length} roster${
                    rosterFailures.length === 1 ? '' : 's'
                  } could not be read`
                : 'on the roster, including invitations not yet redeemed'
          }
          noteTone={
            rosterFailures.length > 0 ? 'text-yellow-400/80' : 'text-slate-600'
          }
        />
        <Stat
          label="Commission owed"
          value={inr(totalOwed)}
          tone={totalOwed > 0 ? 'text-amber-300' : 'text-slate-600'}
          note={
            booksMissing > 0
              ? `at least — ${booksMissing} statement${
                  booksMissing === 1 ? '' : 's'
                } could not be read`
              : undefined
          }
          noteTone="text-yellow-400/80"
        />
      </div>

      <DataTable<Row>
        rows={filtered}
        columns={columns}
        rowKey={(r) => r.id}
        loading={loading}
        error={error}
        onRetry={() => { setLoading(true); load() }}
        searchPlaceholder="Search by agency name, owner, email, referral code or id…"
        searchKeys={['name', 'owner', 'email', 'referralCode', 'id']}
        filters={[
          {
            key: 'status',
            label: 'Status',
            options: [
              { value: 'pending', label: 'Pending' },
              { value: 'approved', label: 'Approved' },
              { value: 'rejected', label: 'Rejected' },
              { value: 'suspended', label: 'Suspended' },
            ],
          },
          {
            key: 'type',
            label: 'Type',
            options: [
              { value: 'main', label: 'Main' },
              { value: 'sub', label: 'Sub-agency' },
            ],
          },
        ]}
        activeFilters={{ status, type }}
        onFilterChange={(key, value) => {
          if (key === 'status') setStatus(value)
          else setType(value)
        }}
        exportName="agencies"
        emptyTitle="No agencies yet"
        emptyHint="Agencies appear here once they apply."
        truncatedAt={500}
      />

      {/* This footnote used to say host counts came from the ledger too, and
          that was the whole bug in one sentence: the ledger cannot answer who
          works for an agency, only who has earned. The two figures on this table
          come from two places on purpose and it is worth saying which. */}
      <p className="flex flex-wrap items-center gap-1.5 text-slate-600 text-xs mt-3">
        <Users size={12} />
        Commission comes from the ledger, so it reconciles with what was actually
        paid. The host count is the agency&rsquo;s roster — the hosts who have
        redeemed their referral code plus the invitations still waiting to be —
        which is the same count the agency sees on its own dashboard.{' '}
        <Link href="/partners" className="text-pink-400 hover:text-pink-300 inline-flex items-center gap-1">
          Full statements <ArrowRight size={11} />
        </Link>
      </p>

      {pending && (
        <ReasonDialog
          title={ACTION_COPY[pending.action].title}
          hint={ACTION_COPY[pending.action].hint}
          verb={ACTION_COPY[pending.action].verb}
          tone={ACTION_COPY[pending.action].tone}
          subject={pending.row.name}
          extra={
            pending.row.isSub ? (
              <p className="text-slate-400 text-xs">
                This is a sub-agency
                {pending.row.parentName ? ` under ${pending.row.parentName}` : ''}.
                Its money flows through the parent, never directly to it.
              </p>
            ) : null
          }
          onClose={() => setPending(null)}
          onConfirm={async (reason) => {
            const { row, action } = pending
            if (action === 'approve') await partnerOps.approve(row.id, reason)
            else if (action === 'reject') await partnerOps.reject(row.id, reason)
            else await partnerOps.deactivate(row.id, reason)
            setPending(null)
            setNotice(`${row.name}: ${action}d. The reason is on the record.`)
            load()
          }}
        />
      )}
    </div>
  )
}

// ── Bits ──────────────────────────────────────────────────────────────────────

/**
 * The public signup URL, in full, copyable, without leaving this page.
 *
 * The host is read from the browser rather than hardcoded — the CRM and the
 * public forms are served from the same origin — with
 * `NEXT_PUBLIC_PUBLIC_SITE_URL` overriding it when the CRM is being run
 * locally but the link to hand out is the deployed one.
 *
 * `navigator.clipboard` does not exist on an http origin, so there is a
 * fallback, and when even that fails the text is selected and the page says so.
 */
function PublicSignupLink({ path, lead }: { path: string; lead: string }) {
  const [origin, setOrigin] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [manual, setManual] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const configured = process.env.NEXT_PUBLIC_PUBLIC_SITE_URL
    setOrigin(
      configured && configured.trim()
        ? configured.trim().replace(/\/+$/, '')
        : typeof window !== 'undefined'
          ? window.location.origin
          : '',
    )
  }, [])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2500)
    return () => clearTimeout(t)
  }, [copied])

  if (origin === null) {
    return <p className="text-slate-600 text-xs mb-4">Working out the public signup address…</p>
  }
  if (origin === '') {
    return (
      <p className="text-slate-500 text-xs mb-4">
        {lead} <span className="font-mono text-slate-400">{path}</span> — this
        site’s address could not be read, so the full link cannot be shown.
      </p>
    )
  }

  const url = `${origin}${path}`

  async function copy() {
    setManual(false)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        return
      }
    } catch {
      // Fall through to the selection below.
    }
    const el = inputRef.current
    if (el) {
      el.focus()
      el.select()
      try {
        if (document.execCommand('copy')) { setCopied(true); return }
      } catch {
        // Same again.
      }
    }
    setManual(true)
  }

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-slate-500">{lead}</span>
        <input
          ref={inputRef}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Public signup link"
          size={Math.min(url.length + 1, 48)}
          className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-slate-300 font-mono focus:outline-none focus:border-pink-500"
        />
        <button
          type="button"
          onClick={copy}
          className={`inline-flex items-center gap-1 rounded px-2 py-1 transition-colors ${
            copied ? 'bg-green-600/90 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
          }`}
        >
          {copied ? <><Check size={11} /> Copied</> : <><ClipboardCopy size={11} /> Copy</>}
        </button>
        <Link href="/onboarding" className="text-pink-400 hover:text-pink-300">
          How partners join
        </Link>
      </div>
      {manual && (
        <p className="text-amber-300/90 text-xs mt-1">
          This browser would not let the page write to the clipboard. The link is
          selected — press Ctrl+C, or ⌘C on a Mac.
        </p>
      )}
    </div>
  )
}

/**
 * One tile. `note` is where a figure says what it covers.
 *
 * It exists because two of these four are sums over per-agency reads that can
 * each fail on their own, and a total built over a partial set is a floor rather
 * than a measurement. Printing it in the same type as a complete one, with
 * nothing beside it, is how this page came to state several confident zeroes.
 */
function Stat({
  label, value, tone, note, noteTone = 'text-slate-600',
}: {
  label: string
  value: string
  tone: string
  note?: string
  noteTone?: string
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-1 ${tone}`}>{value}</p>
      {note && <p className={`text-xs mt-0.5 leading-snug ${noteTone}`}>{note}</p>}
    </div>
  )
}

function RowButton({
  children,
  onClick,
  tone,
}: {
  children: React.ReactNode
  onClick: () => void
  tone: 'green' | 'red' | 'slate'
}) {
  const tones = {
    green: 'bg-green-600/90 hover:bg-green-500 text-white',
    red: 'bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/30',
    slate: 'bg-slate-800 hover:bg-slate-700 text-slate-300',
  }
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${tones[tone]}`}
    >
      {children}
    </button>
  )
}

/** Every partner decision carries a reason, validated before it is sent. */
function ReasonDialog({
  title,
  hint,
  verb,
  tone,
  subject,
  extra,
  onClose,
  onConfirm,
}: {
  title: string
  hint: string
  verb: string
  tone: string
  subject: string
  extra?: React.ReactNode
  onClose: () => void
  onConfirm: (reason: string) => Promise<void>
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const valid = reason.trim().length >= MIN_REASON

  async function go() {
    if (!valid) return
    setBusy(true)
    setErr('')
    try {
      await onConfirm(reason.trim())
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That did not go through.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-white font-semibold">{title}</h2>
            <p className="text-slate-500 text-xs mt-0.5">{subject}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          <p className="text-slate-400 text-sm">{hint}</p>
          {extra}
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Reason — kept on the record and in the audit log."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
          />
          {reason.trim().length > 0 && !valid && (
            <p className="text-amber-400 text-xs flex items-center gap-1.5">
              <Clock size={11} /> At least {MIN_REASON} characters.
            </p>
          )}
          {err && (
            <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {err}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800">
          <button onClick={onClose} className="text-slate-400 hover:text-white text-sm px-4 py-2">
            Cancel
          </button>
          <button
            onClick={go}
            disabled={!valid || busy}
            className={`flex items-center gap-2 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors ${tone}`}
          >
            {busy && <Loader2 size={14} className="animate-spin" />}
            {verb}
          </button>
        </div>
      </div>
    </div>
  )
}
