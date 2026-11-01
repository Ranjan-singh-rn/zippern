'use client'

/**
 * One agency.
 *
 * The record of what this agency earned, what it was paid, and what is still
 * owed — read from the same commission ledger the business settles against,
 * not from a counter someone incremented by hand.
 *
 * Three rules shape this screen:
 *
 *   * Onboarding decisions (approve, reject, deactivate, reactivate) are team
 *     decisions. They take effect immediately and move no money. A rejection
 *     needs a reason, and that reason stays on the record — an applicant who
 *     is told nothing simply reapplies.
 *   * A commission payout **raises a card**. Nothing leaves the account here;
 *     an owner signs on /board, and executing it needs the bank reference.
 *   * A sub-agency is paid *through* its parent (4.2.4), so a payout has two
 *     legs. Leg 1 is our money leaving. Leg 2 is the parent confirming it
 *     passed the money on. Between the two, the sub-agency may not have been
 *     paid at all, and this screen says so.
 *
 * Contact details, bank details and KYC documents still live in Firestore
 * because the Android app reads them there. They are read here, never written:
 * every decision on this page goes through the API so it is attributable.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import SecureDocuments from '@/components/SecureDocuments'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, ArrowRight, Banknote, Building2, CheckCircle2,
  Clock, Coins, CornerDownRight, ExternalLink, FileText, Hash, ImageOff,
  Loader2, Mail, MapPin, Phone, Plus, RefreshCw, Send, ShieldCheck,
  User, Users, Wallet, X, XCircle,
} from 'lucide-react'
import {
  Denied, Empty, ErrorState, Loading, UnavailablePanel, Warning,
} from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { nameOrReference } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'
import api, { ApiError } from '@/lib/api'
import { roleButtons, type UserRoles } from '@/lib/userRoleActions'
import {
  getAgency, getAgencyRoster, rosterCountOf, rosterFailureOf,
  type Agency, type AgencyRoster, type RosterMember, type RosterState,
} from '@/lib/agencies'
import {
  board, commission, partnerOps, statements,
  inr, num, str, when,
  STATUS_TONE,
  type AgencyStatement, type Partner, type PartnerCard, type SubAgency,
} from '@/lib/apiPartners'
import { restoreGate, revokeTransferNote } from '@/lib/governanceRequests'
import { awaitingLabel } from '@/lib/contactVerification'
import { TransferRecommendation } from '@/components/TransferRecommendation'

const PAGE_ROLES = [
  'superadmin', 'app_admin', 'ops_admin', 'finance_admin', 'finance_member',
] as const

const MIN_REASON = 3

/** How much of the board is pulled before filtering to this agency's cards. */
const BOARD_LIMIT = 400

/**
 * Per-host EARNINGS, aggregated from the bean ledger.
 *
 * Note what it is not: a roster. `GET /partners/agencies/{id}/hosts` is
 * `agency_host_performance` (backend/app/services/partners.py:196), a `$group`
 * over positive bean movements tagged `meta.agency_id`. A host who has not
 * earned yet produces no row, so this list was empty for an agency that had two
 * hosts — and the Hosts tab, which rendered nothing but this, said "No host
 * earnings on record" under a tab labelled `Hosts (0)`.
 *
 * It is kept, and joined onto the roster below, because "what has this host
 * earned" is a real question and this is the only thing that answers it against
 * the same ledger the business settles on. It is no longer the source of who is
 * on the team.
 */
type HostRow = Awaited<ReturnType<typeof api.partners.agencyHosts>>[number]

/** How a roster row is badged. Wording matches the agency's own dashboard. */
const ROSTER_TONE: Record<RosterState, { label: string; tone: string }> = {
  active: { label: 'Joined', tone: 'bg-green-500/15 text-green-300' },
  awaiting: { label: 'Awaiting activation', tone: 'bg-blue-500/15 text-blue-300' },
  pending: { label: 'Pending KYC', tone: 'bg-yellow-500/15 text-yellow-300' },
  // Listed but not counted — `revoke_host` leaves `agencyId` behind on purpose,
  // so these rows keep matching the query. See `RosterState` in lib/agencies.ts.
  former: { label: 'Host status revoked', tone: 'bg-slate-700 text-slate-400' },
}

// ── Sub-agency payouts, as the API actually returns them ──────────────────────
// GET /partner-ops/subagency-payouts/open hands back the raw payout document.
// These readers keep the `unknown` casts in one place.

interface PayoutLeg {
  status: string
  paidAt: string
  confirmedAt: string
  paymentRef: string
  by: string
  reason: string
}

interface SubPayout {
  id: string
  cardId: string
  parentId: string
  parentName: string
  subId: string
  subName: string
  amountMinor: number
  status: string
  createdAt: string
  leg1: PayoutLeg
  leg2: PayoutLeg
}

function readLeg(raw: unknown): PayoutLeg {
  const o = (raw ?? {}) as Record<string, unknown>
  const who = (o.by ?? null) as { name?: string } | null
  return {
    status: str(o, 'status') || 'pending',
    paidAt: str(o, 'paid_at'),
    confirmedAt: str(o, 'confirmed_at'),
    paymentRef: str(o, 'payment_ref'),
    by: who?.name ?? '',
    reason: str(o, 'reason'),
  }
}

function readPayout(raw: Record<string, unknown>): SubPayout {
  return {
    id: str(raw, 'id'),
    cardId: str(raw, 'card_id'),
    parentId: str(raw, 'parent_id'),
    parentName: str(raw, 'parent_name'),
    subId: str(raw, 'sub_id'),
    subName: str(raw, 'sub_name'),
    amountMinor: num(raw, 'amount_minor'),
    status: str(raw, 'status') || 'pending',
    createdAt: str(raw, 'created_at'),
    leg1: readLeg(raw.leg1),
    leg2: readLeg(raw.leg2),
  }
}

// ── Onboarding decisions ──────────────────────────────────────────────────────

type Decision = 'approve' | 'reject' | 'deactivate' | 'reactivate' | 'revoke'

const DECISION_COPY: Record<
  Decision,
  { title: string; hint: string; verb: string; tone: string }
> = {
  approve: {
    title: 'Approve this agency',
    hint: 'They can start earning commission. No money moves now — a payout is a separate card an owner signs.',
    verb: 'Approve',
    tone: 'bg-green-600 hover:bg-green-500',
  },
  reject: {
    title: 'Reject this application',
    hint: 'The reason is stored on the record and stays visible here afterwards, so the applicant is told why instead of silently reapplying.',
    verb: 'Reject',
    tone: 'bg-red-600 hover:bg-red-500',
  },
  deactivate: {
    title: 'Suspend this agency',
    hint: 'The record is kept and their history stays attributable. Commission already earned is still owed.',
    verb: 'Suspend',
    tone: 'bg-amber-600 hover:bg-amber-500',
  },
  reactivate: {
    title: 'Restore this agency role',
    hint:
      'The SAME record is re-activated — no new application. The role table and, for a ' +
      'sub-agency, its main agency are re-checked first. They can earn commission again. ' +
      'Nothing about the existing balance changes. Sub-agencies and hosts moved away when the ' +
      'role was revoked are not moved back.',
    verb: 'Restore',
    tone: 'bg-green-600 hover:bg-green-500',
  },
  revoke: {
    title: 'Revoke this agency role',
    hint:
      'The ROLE ends; the person does not. Their account stays active, any other role they hold ' +
      '(a Coin Seller, say) stays active, and every record and every rupee of history stays. To ' +
      'get the role back they file a reinstatement request, which the Owner decides — a revoked ' +
      'role is not re-applied for. Different from Suspend, which is temporary and keeps their place. ' +
      'Sub-agencies and hosts under this agency must be moved to another live main agency — name ' +
      'it below, or the revocation is refused and nothing changes.',
    verb: 'Revoke role',
    tone: 'bg-red-700 hover:bg-red-600',
  },
}

const STAGE_LABEL: Record<string, string> = {
  requested: 'Raised — awaiting verification',
  under_review: 'Under review',
  awaiting_signoff: 'Verified — awaiting owner signature',
  approved: 'Signed — money has not left yet',
  executed: 'Paid',
  rejected: 'Rejected',
  failed: 'Failed',
}

const STAGE_TONE: Record<string, string> = {
  requested: 'bg-slate-700 text-slate-300',
  under_review: 'bg-blue-500/15 text-blue-300',
  awaiting_signoff: 'bg-amber-500/15 text-amber-300',
  approved: 'bg-green-500/15 text-green-300',
  executed: 'bg-slate-700/60 text-slate-400',
  rejected: 'bg-red-500/15 text-red-300',
  failed: 'bg-red-500/20 text-red-300',
}

function ageOf(iso: string | null | undefined) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (Number.isNaN(mins)) return ''
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

type Tab = 'statement' | 'hosts' | 'subs' | 'profile'

// ══════════════════════════════════════════════════════════════════════════════

export default function AgencyDetail() {
  // useParams() can hand back the '_' placeholder in the static-export +
  // Firebase-rewrite setup, because the shell was built for it. The browser URL
  // is always the real id.
  const params = useParams() as { id: string }
  const id =
    (typeof window !== 'undefined'
      ? window.location.pathname.split('/').filter(Boolean)[1] ?? params.id
      : params.id) || params.id

  const { crmUser, apiUser } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, [...PAGE_ROLES])
  // Both payout executions are `require_owner` — commission payouts and leg 1
  // of a sub-agency payout. Leg 2 is `require_write`, so it stays open to
  // everyone who can write and is not gated here.
  const isOwner = apiUser?.role === 'owner'

  const [partner, setPartner] = useState<Partner | null>(null)
  const [statement, setStatement] = useState<AgencyStatement | null>(null)
  const [hosts, setHosts] = useState<HostRow[]>([])
  /**
   * Who this agency actually has. Read from Firestore — the two collections the
   * agency's own dashboard reads — because neither the statement nor the ledger
   * can answer it. See the long note above `getAgencyRoster` in lib/agencies.ts.
   */
  const [roster, setRoster] = useState<AgencyRoster | null>(null)
  const [subs, setSubs] = useState<SubAgency[]>([])
  const [payouts, setPayouts] = useState<SubPayout[]>([])
  const [cards, setCards] = useState<PartnerCard[]>([])
  const [cardsTruncated, setCardsTruncated] = useState(false)
  const [profile, setProfile] = useState<Agency | null>(null)
  const [parentName, setParentName] = useState('')
  /** UGP-B: what the OWNER holds — Revoke is offered only beside a second role. */
  const [ownerRoles, setOwnerRoles] = useState<UserRoles | null>(null)
  /** The roles request failed — so no revoke is offered, and the page says why. */
  const [ownerRolesFailed, setOwnerRolesFailed] = useState(false)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState<Tab>('statement')
  const [decision, setDecision] = useState<Decision | null>(null)
  const [transferTo, setTransferTo] = useState('')
  const [raisingPayout, setRaisingPayout] = useState(false)
  const [payingSub, setPayingSub] = useState<SubAgency | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setError('')
    try {
      const p = await partnerOps.get(id)
      setPartner(p)
      setLoading(false)

      if (p.owner_crm_uid) {
        setOwnerRolesFailed(false)
        api.users.roles(p.owner_crm_uid)
          .then((r) => { setOwnerRoles(r); setOwnerRolesFailed(false) })
          .catch(() => { setOwnerRoles(null); setOwnerRolesFailed(true) })
      } else {
        setOwnerRoles(null)
        setOwnerRolesFailed(false)
      }

      // Everything below is additive: a failure in one panel must not blank the
      // record. Each lands on its own and says so if it could not be read.
      statements.agency(id).then(setStatement).catch(() => setStatement(null))
      api.partners.agencyHosts(id).then(setHosts).catch(() => setHosts([]))
      // Never rejects: it reports each of its two reads on its own, so a refused
      // half is rendered as a refusal and not as an agency with no hosts.
      getAgencyRoster(id).then(setRoster)
      statements.subAgenciesOf(id).then(setSubs).catch(() => setSubs([]))
      commission
        .openSubAgencyPayouts()
        .then((list) => setPayouts(list.map(readPayout)))
        .catch(() => setPayouts([]))
      board
        .list(BOARD_LIMIT)
        .then((list) => {
          setCardsTruncated(list.length >= BOARD_LIMIT)
          setCards(
            list.filter(
              (c) =>
                (c.type === 'commission_payout' || c.type === 'subagency_payout') &&
                (c.subject?.id === id || str(c.payload ?? {}, 'parent_id') === id),
            ),
          )
        })
        .catch(() => setCards([]))

      // Contact, bank and KYC detail — Firestore is where the Android app reads
      // them, so it is where they live. Read only.
      getAgency(id, p.crm_id)
        .then(setProfile)
        .catch(() => setProfile(null))

      if (p.parent_id) {
        partnerOps
          .get(p.parent_id)
          .then((parent) => setParentName(parent.name || parent.id))
          .catch(() => setParentName(''))
      } else {
        setParentName('')
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this agency.')
      setLoading(false)
    }
  }, [id])

  useEffect(() => { if (allowed) load() }, [allowed, load])

  const myPayouts = useMemo(
    () => payouts.filter((p) => p.parentId === id || p.subId === id),
    [payouts, id],
  )

  /** Our money is gone and the parent has not confirmed passing it on. */
  const legTwoOutstanding = myPayouts.filter(
    (p) => p.leg1.status === 'paid' && p.leg2.status !== 'confirmed',
  )

  const signedNotPaid = cards.filter((c) => c.stage === 'approved')

  /** Earnings by host uid, so the roster table can show them on the person. */
  const earningsByUid = useMemo(
    () => new Map(hosts.map((h) => [h.host_id, h])),
    [hosts],
  )

  const rosterUids = useMemo(
    () => new Set((roster?.members ?? []).map((m) => m.uid).filter(Boolean)),
    [roster],
  )

  /**
   * Ledger rows for accounts the roster does not have.
   *
   * Surfaced rather than dropped, because it is a money discrepancy and not a
   * display detail: somebody is earning beans tagged to this agency while the
   * agency's own roster does not list them. Either their `users.agencyId` was
   * changed after they earned, or commission is accruing against the wrong
   * agency. Silently showing only the roster would hide the second case, which
   * is the expensive one.
   */
  const earningsOffRoster = useMemo(
    () => hosts.filter((h) => h.host_id && !rosterUids.has(h.host_id)),
    [hosts, rosterUids],
  )

  const hostCount = rosterCountOf(roster)
  const rosterFailure = rosterFailureOf(roster)

  // B1: earners off the roster have no roster name — name them from `users` (names only).
  const offRosterNames = useIdentities({ enabled: allowed, people: earningsOffRoster.map((h) => h.host_id) })

  if (!allowed) return <Denied what="agency records" />

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto">
        <Loading label="Loading this agency…" />
      </div>
    )
  }

  if (error || !partner) {
    return (
      <div className="max-w-5xl mx-auto">
        <BackLink />
        <div className="bg-slate-900 border border-slate-800 rounded-xl mt-4">
          <ErrorState
            message={error || 'No agency record was returned for this id.'}
            onRetry={() => { setLoading(true); load() }}
          />
        </div>
      </div>
    )
  }

  const isSub = partner.kind === 'sub_agency'
  const outstanding =
    statement?.commission_outstanding ?? partner.commission_outstanding ?? 0

  return (
    <div className="max-w-5xl mx-auto">
      <BackLink />

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="mt-4 mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <Building2 size={26} className="text-pink-500 shrink-0" />
            <span className="truncate">{partner.name || partner.id}</span>
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className={`text-xs px-2 py-1 rounded ${STATUS_TONE[partner.status] ?? 'bg-slate-700 text-slate-300'}`}>
              {partner.status === 'awaiting_verification' ? 'approved · waiting for verified contacts' : partner.status}
              {partner.status === 'approved' && !partner.is_active ? ' · inactive' : ''}
            </span>
            {partner.status === 'awaiting_verification' && (
              <span className="text-sky-300 text-xs">{awaitingLabel(partner.activation?.missing ?? [])}</span>
            )}
            <span
              className={`text-xs px-2 py-1 rounded ${
                isSub ? 'bg-slate-700 text-slate-300' : 'bg-purple-500/15 text-purple-300'
              }`}
            >
              {isSub ? 'Sub-agency' : 'Main agency'}
            </span>
            <span className="text-slate-600 text-xs font-mono">{partner.id}</span>
          </div>
          {isSub && (
            <p className="flex items-center gap-1.5 text-xs mt-2 text-slate-400">
              <CornerDownRight size={11} className="shrink-0" />
              {partner.parent_id ? (
                <>
                  Paid through{' '}
                  <Link
                    href={`/agencies/${partner.parent_id}`}
                    className="text-pink-400 hover:text-pink-300"
                  >
                    {parentName || partner.parent_id}
                  </Link>
                  , never directly.
                </>
              ) : (
                <span className="text-red-300">
                  No parent on record — the API will refuse a payout until one is set.
                </span>
              )}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => { setLoading(true); load() }}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          {/* UGP-B: each decision on its own case. Approve decides an
              application (pending, or a rejected one reconsidered); Reject is
              for a PENDING application only; Restore re-activates a suspended
              or revoked record; Revoke only beside a second role. The API
              refuses every other combination by name. */}
          {/* Decision 15 (RC): approved, NOT started — the role waits for BOTH
              verified contacts on the login and starts by itself; "Check and
              start" asks the API to re-read them now. Never bypasses them. */}
          {partner.status === 'awaiting_verification' && (
            <button
              onClick={async () => {
                try {
                  const out = await partnerOps.activate(id)
                  setNotice(out.activated ? 'Both contacts are verified — the role has started.'
                    : out.already_active ? 'This role had already started.' : 'Checked.')
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : 'Could not check just now.')
                }
                load()
              }}
              className="flex items-center gap-2 bg-sky-600/80 hover:bg-sky-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
            >
              <CheckCircle2 size={15} /> Check and start
            </button>
          )}
          {(partner.status === 'pending' || partner.status === 'rejected') && (
            <button
              onClick={() => setDecision('approve')}
              className="flex items-center gap-2 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
            >
              <CheckCircle2 size={15} /> Approve
            </button>
          )}
          {partner.status === 'pending' && (
            <button
              onClick={() => setDecision('reject')}
              className="flex items-center gap-2 bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-300 rounded-lg px-4 py-2.5 text-sm transition-colors"
            >
              <XCircle size={15} /> Reject
            </button>
          )}
          {partner.status === 'approved' && partner.is_active && (
            <button
              onClick={() => setDecision('deactivate')}
              className="bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2.5 text-sm transition-colors"
            >
              Suspend
            </button>
          )}
          {/* GOV C2: restoring a REVOKED record is the Owner's decision (the
              server answers anybody else with 403). Lifting a role-level
              suspension keeps its current permission. */}
          {(partner.status === 'suspended' || partner.status === 'revoked') && (() => {
            const gate = restoreGate(partner.status, isOwner)
            return (
              <>
                <button
                  onClick={() => { if (gate.allowed) setDecision('reactivate') }}
                  disabled={!gate.allowed}
                  title={gate.hint || undefined}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2.5 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Restore
                </button>
                {!gate.allowed && (
                  <Link href="/role-appeals" className="text-slate-500 hover:text-pink-300 text-xs max-w-[16rem]">
                    {gate.hint}
                  </Link>
                )}
              </>
            )
          })()}
          {/* GOV C3: moving a Sub-agency to another main agency is a request
              the Owner decides on /transfers. Renders nothing for a role that
              may not recommend one. */}
          {isSub && partner.status === 'approved' && (
            <TransferRecommendation
              kind="sub_agency"
              subjectId={partner.id}
              currentAgencyId={partner.parent_id ?? ''}
              subjectLabel={partner.name || partner.id}
            />
          )}
          {(partner.status === 'approved' || partner.status === 'suspended') &&
            roleButtons(ownerRoles).some((b) => b.kind === 'revoke' && b.targetId === partner.id) && (
            <button
              onClick={() => { setTransferTo(''); setDecision('revoke') }}
              className="flex items-center gap-2 bg-red-900/30 hover:bg-red-900/50 border border-red-900/50 text-red-300 rounded-lg px-4 py-2.5 text-sm transition-colors"
              title="End the role. The person, their other roles and their history stay."
            >
              Revoke role
            </button>
          )}
          {(partner.status === 'approved' || partner.status === 'suspended') &&
            !roleButtons(ownerRoles).some((b) => b.kind === 'revoke' && b.targetId === partner.id) && (
            ownerRolesFailed ? (
              <span className="text-amber-400/80 text-xs" title="Revoke is offered only once the owner's roles are known (UGP-B)">
                The owner's roles could not be read, so Revoke is not offered — reload to try again
              </span>
            ) : (
              <span className="text-slate-500 text-xs" title="One role → suspend only (UGP-B)">
                Only role — suspend rather than revoke
              </span>
            )
          )}
        </div>
      </div>

      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      {/* The rejection reason, kept where the next person to open this record
          will see it — the thing that did not exist before. */}
      {partner.status === 'rejected' && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3 mb-4">
          <XCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-red-200 text-sm font-semibold">
              This application was rejected.
            </p>
            <p className="text-red-100/80 text-sm mt-0.5">
              {partner.rejection_reason || 'No reason was recorded against this record.'}
            </p>
          </div>
        </div>
      )}

      {legTwoOutstanding.length > 0 && (
        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/40 rounded-xl px-4 py-3 mb-4">
          <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-amber-100 text-sm font-semibold">
              {legTwoOutstanding.length} payout
              {legTwoOutstanding.length === 1 ? '' : 's'} left our account and{' '}
              {legTwoOutstanding.length === 1 ? 'has' : 'have'} not been confirmed
              passed on to the sub-agency.
            </p>
            <p className="text-amber-100/75 text-sm mt-0.5">
              Our money is gone. Until the parent confirms leg 2, the sub-agency
              may not have been paid at all — see the Sub-agencies tab.
            </p>
          </div>
        </div>
      )}

      {signedNotPaid.length > 0 && (
        <Warning>
          {signedNotPaid.length} payout card{signedNotPaid.length === 1 ? ' is' : 's are'}{' '}
          signed but not executed. The money has not left yet — execute it below
          with the bank reference, or it will sit here indefinitely.
        </Warning>
      )}

      {/* ── Money ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat
          label="Earned"
          value={statement ? inr(statement.commission_earned) : '—'}
          tone="text-white"
        />
        <Stat
          label="Paid"
          value={statement ? inr(statement.commission_paid) : '—'}
          tone="text-slate-300"
        />
        <Stat
          label="Outstanding"
          value={inr(outstanding)}
          tone={outstanding > 0 ? 'text-amber-300' : 'text-slate-600'}
          hint="What we owe them right now"
        />
        {/* THE ROSTER, not `statement.host_count`.
            `host_count` counts a Mongo collection (`agency_hosts`) that nothing
            in the backend writes, so it was 0 for every agency on the platform —
            including this one while its own portal listed two hosts. The
            fallback was `hosts.length`, which is the ledger earnings list and
            empty until somebody earns, so both halves of the old expression
            answered a different question from the label. */}
        <Stat
          label="Hosts"
          value={
            hostCount === null ? '—' : hostCount.toLocaleString('en-IN')
          }
          tone="text-slate-300"
          hint={
            rosterFailure
              ? `Could not be read — not zero. ${rosterFailure.reason}`
              : roster
                ? `${roster.active} joined, ${roster.awaiting + roster.pending} invited and ` +
                  `not yet redeemed${roster.former > 0 ? `, ${roster.former} former and not counted` : ''}` +
                  (roster.flagged > 0
                    ? `, ${roster.flagged} invitation${roster.flagged === 1 ? '' : 's'} for a host already listed`
                    : '')
                : 'Reading the roster…'
          }
        />
      </div>

      {/* ── Payout ──────────────────────────────────────────────────────── */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-white font-semibold flex items-center gap-2">
              <Wallet size={15} className="text-slate-500" /> Commission payout
            </h2>
            <p className="text-slate-500 text-sm mt-1 max-w-xl">
              Paying raises a card. Nothing leaves this screen — an owner signs it
              on the money board, and executing it needs the bank reference so the
              payment reconciles.
            </p>
          </div>
          <button
            onClick={() => setRaisingPayout(true)}
            disabled={outstanding <= 0 || partner.status !== 'approved'}
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            <Send size={14} /> Raise a payout
          </button>
        </div>

        {outstanding <= 0 && (
          <p className="text-slate-600 text-xs mt-3">
            Nothing is outstanding, so there is nothing to pay. The API refuses a
            payout that would overpay the agency.
          </p>
        )}
        {partner.status !== 'approved' && (
          <p className="text-amber-300 text-xs mt-3">
            This agency is {partner.status}. Approve the account before moving
            money on it — the API refuses otherwise.
          </p>
        )}

        {cardsTruncated && (
          <p className="text-amber-400/80 text-xs mt-3">
            Only the most recent {BOARD_LIMIT} cards were read. Older payout cards
            for this agency exist but are not listed here — the money board and
            the audit log hold the rest.
          </p>
        )}

        <div className="mt-4 space-y-2">
          {cards.length === 0 ? (
            <p className="text-slate-600 text-sm">No payout cards for this agency yet.</p>
          ) : (
            cards.map((card) => (
              <PayoutCardRow
                key={card.id}
                card={card}
                isOwner={isOwner}
                onDone={(message) => { setNotice(message); load() }}
              />
            ))
          )}
        </div>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 mb-4 overflow-x-auto">
        {([
          ['statement', 'Commission ledger', Coins],
          // The roster count, so the tab and the tile above it agree. It used to
          // be `hosts.length` — the ledger earnings list — which is how a tab
          // reading "Hosts (0)" sat above an agency with two of them.
          ['hosts', `Hosts (${hostCount === null ? '—' : hostCount})`, Users],
          ['subs', `Sub-agencies (${subs.length})`, CornerDownRight],
          ['profile', 'Profile & KYC', FileText],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
              tab === key ? 'bg-pink-500 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {tab === 'statement' && (
        <Panel title="Commission ledger" icon={<Coins size={15} />}>
          {!statement ? (
            <ErrorState message="The statement could not be read. The rest of this record is still accurate." />
          ) : statement.entries.length === 0 ? (
            <Empty
              title="No commission movements yet"
              hint="Accruals and payouts appear here as they happen, from the ledger the business settles against."
              icon={<Coins size={26} />}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-800 text-left">
                    <Th>What</Th>
                    <Th hideOnMobile>Action</Th>
                    <Th hideOnMobile>When</Th>
                    <Th align="right">Amount</Th>
                  </tr>
                </thead>
                <tbody>
                  {statement.entries.map((e, i) => {
                    const amount = num(e, 'amount')
                    return (
                      <tr key={str(e, 'id') || i} className="border-b border-slate-800/60 last:border-0">
                        <td className="px-4 sm:px-5 py-3 text-sm text-slate-200">
                          <p className="truncate max-w-xs">{str(e, 'reason') || '—'}</p>
                          <p className="text-slate-600 text-xs sm:hidden">{when(str(e, 'at'))}</p>
                        </td>
                        <td className="px-4 sm:px-5 py-3 text-xs text-slate-500 hidden sm:table-cell">
                          {str(e, 'action').replace(/_/g, ' ') || '—'}
                        </td>
                        <td className="px-4 sm:px-5 py-3 text-xs text-slate-500 hidden sm:table-cell whitespace-nowrap">
                          {when(str(e, 'at'))}
                        </td>
                        <td
                          className={`px-4 sm:px-5 py-3 text-sm font-semibold text-right whitespace-nowrap ${
                            amount >= 0 ? 'text-green-300' : 'text-amber-300'
                          }`}
                        >
                          {amount >= 0 ? '+' : ''}{inr(amount)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {/* ── Hosts ────────────────────────────────────────────────────────
          This tab used to render the ledger earnings aggregation and nothing
          else, so it said "No host earnings on record" for an agency with two
          hosts who had not earned yet — and it said it under a tab labelled
          "Hosts (0)". Two questions were being conflated: who is on this team,
          and what have they earned. Both are answered here now, the roster
          first, because that is what the tab is called. */}
      {tab === 'hosts' && (
        <Panel title="Hosts" icon={<Users size={15} />}>
          {rosterFailure ? (
            // Never the empty state below. "This agency has no hosts" is a claim
            // about somebody's business, and a refused read is not evidence for
            // it.
            <UnavailablePanel
              failure={rosterFailure}
              what="This agency's roster"
              onRetry={() => { setLoading(true); load() }}
            />
          ) : !roster ? (
            <Loading label="Reading the roster…" />
          ) : roster.members.length === 0 ? (
            <Empty
              title="Nobody on this agency's roster"
              hint={
                'A host joins by redeeming a referral code, which puts them on ' +
                'the users collection; an invitation that has been sent and not ' +
                'yet redeemed counts here too. This agency has neither.'
              }
              icon={<Users size={26} />}
            />
          ) : (
            <>
              {/* A capped read is a floor, and a floor has to say so. The number
                  of rows below is the deduplicated count, which is not the number
                  of records read, so no figure is quoted here on purpose. */}
              {roster.capped && (
                <p className="px-4 sm:px-5 pt-3 text-amber-400/80 text-xs">
                  This roster hit its read cap, so this agency has hosts that are
                  not listed here and the count above is a floor rather than a
                  total.
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-800 text-left">
                      <Th>Host</Th>
                      <Th hideOnMobile>Status</Th>
                      <Th align="right" hideOnMobile>Call rate</Th>
                      <Th align="right">Beans earned</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {roster.members.map((m) => (
                      <RosterRow
                        key={m.applicationId ? `app:${m.applicationId}` : m.uid}
                        member={m}
                        earnings={m.uid ? earningsByUid.get(m.uid) ?? null : null}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="px-4 sm:px-5 py-3 border-t border-slate-800 text-slate-600 text-xs">
                The roster is read from Firestore — the hosts whose account points
                at this agency, plus the invitations it has sent and nobody has
                redeemed yet. It is the same list the agency sees on its own
                dashboard. Beans earned is aggregated from the ledger, so it
                reconciles with what was paid; a host with no figure has not
                earned yet.
              </p>
            </>
          )}
        </Panel>
      )}

      {/* Accounts earning against this agency that its roster does not have.
          A money discrepancy, not a display one — see `earningsOffRoster`. */}
      {tab === 'hosts' && earningsOffRoster.length > 0 && (
        <div className="bg-amber-500/5 border border-amber-500/40 rounded-xl p-5 mt-4">
          <p className="flex items-center gap-2 text-amber-200 text-sm font-semibold">
            <AlertTriangle size={15} />
            {earningsOffRoster.length} account
            {earningsOffRoster.length === 1 ? ' has' : 's have'} earned against this
            agency but {earningsOffRoster.length === 1 ? 'is' : 'are'} not on its roster
          </p>
          <p className="text-amber-100/70 text-sm mt-1">
            The ledger has bean movements tagged to this agency for these uids, and
            no host of theirs matches. Either the account&rsquo;s{' '}
            <span className="font-mono">agencyId</span> was changed after it earned,
            or commission is accruing against the wrong agency. The earnings are
            real either way — this is about who they belong to.
          </p>
          <ul className="mt-3 space-y-1.5">
            {earningsOffRoster.map((h) => (
              <li key={h.host_id} className="flex items-center justify-between gap-3 text-xs">
                <Link
                  href={`/users/${h.host_id}`}
                  title={h.host_id}
                  className="text-amber-100 hover:text-white truncate"
                >
                  {nameOrReference(offRosterNames.people.get(h.host_id), h.host_id, 'host')}
                </Link>
                <span className="text-amber-300 shrink-0 whitespace-nowrap">
                  🫘 {h.beans_earned.toLocaleString('en-IN')} over{' '}
                  {h.movements.toLocaleString('en-IN')} movements
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === 'subs' && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="text-white font-semibold flex items-center gap-2">
                  <CornerDownRight size={15} className="text-slate-500" /> Sub-agencies
                </h2>
                <p className="text-slate-500 text-sm mt-1">
                  A sub-agency is paid through this parent, never directly. Every
                  payout has two legs, and both are shown below.
                </p>
              </div>

              {/*
                The register page has always accepted ?parentId — it flips the
                record to type 'sub' and sets parentAgencyId — but nothing in the
                CRM ever set the parameter, so the only way to reach it was to
                type the URL by hand. Which meant, in practice, that staff could
                not add a sub-agency at all.
              */}
              {!isSub && (
                <Link
                  href={`/agencies/register?parentId=${encodeURIComponent(id)}`}
                  className="shrink-0 flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-3 py-2 text-xs font-medium transition-colors"
                >
                  <Plus size={13} /> Add a sub-agency
                </Link>
              )}
            </div>

            {!isSub && (
              <p className="text-slate-600 text-xs mt-3 leading-relaxed">
                The agency can also add its own from their dashboard, which is the
                usual route — they set the owner&rsquo;s password and upload the KYC
                themselves. Use this when you are doing it on their behalf.
              </p>
            )}
          </div>

          {subs.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl">
              <Empty
                title="No sub-agencies under this agency"
                hint={
                  isSub
                    ? 'This is itself a sub-agency.'
                    : 'Sub-agencies appear here once they are registered against this parent.'
                }
                icon={<CornerDownRight size={26} />}
              />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {subs.map((s) => (
                <div key={s.id} className="bg-slate-900 border border-slate-800 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link
                        href={`/agencies/${s.id}`}
                        className="text-white font-medium hover:text-pink-400 truncate block"
                      >
                        {s.name || s.id}
                      </Link>
                      <p className="text-slate-600 text-xs font-mono truncate">{s.id}</p>
                    </div>
                    <span className={`text-xs px-2 py-1 rounded shrink-0 ${STATUS_TONE[s.status] ?? 'bg-slate-700 text-slate-300'}`}>
                      {s.status}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-3">
                    <span className="text-slate-400 text-xs uppercase tracking-wide">
                      Owed to them
                    </span>
                    <span className={s.owed_by_parent > 0 ? 'text-amber-300 font-semibold' : 'text-slate-600'}>
                      {inr(s.owed_by_parent)}
                    </span>
                  </div>
                  <button
                    onClick={() => setPayingSub(s)}
                    disabled={s.owed_by_parent <= 0 || isSub}
                    className="mt-3 w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 rounded-lg px-3 py-2 text-sm transition-colors"
                  >
                    <Send size={13} /> Raise a payout via this parent
                  </button>
                </div>
              ))}
            </div>
          )}

          <Panel title="Open payouts — both legs" icon={<Banknote size={15} />}>
            {myPayouts.length === 0 ? (
              <Empty
                title="No open sub-agency payouts"
                hint="A payout stays here until the parent confirms it passed the money on."
                icon={<Banknote size={26} />}
              />
            ) : (
              <div className="divide-y divide-slate-800/60">
                {myPayouts.map((p) => (
                  <PayoutLegs
                    key={p.id}
                    payout={p}
                    onDone={(message) => { setNotice(message); load() }}
                  />
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}

      {tab === 'profile' && <ProfilePanel partner={partner} profile={profile} />}

      {/* ── Dialogs ─────────────────────────────────────────────────────── */}
      {decision && (
        <ReasonDialog
          title={DECISION_COPY[decision].title}
          hint={DECISION_COPY[decision].hint}
          verb={DECISION_COPY[decision].verb}
          tone={DECISION_COPY[decision].tone}
          subject={partner.name || partner.id}
          onClose={() => setDecision(null)}
          extra={decision === 'revoke' ? (
            <div className="space-y-2">
              {/* GOV C3: a revocation that MOVES dependents is the Owner's
                  decision — the server answers anybody else with 403. Said
                  before the button is pressed, with where to go instead. */}
              {(() => {
                const note = revokeTransferNote(
                  { subAgencies: subs.length, hosts: roster?.active ?? 0 },
                  isOwner,
                )
                return note ? (
                  <p className="text-amber-200 text-xs bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 leading-relaxed">
                    {note}{' '}
                    <Link href="/transfers" className="underline underline-offset-2 hover:text-white">
                      Transfer requests
                    </Link>
                  </p>
                ) : null
              })()}
              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5">
                  Move sub-agencies and hosts to (main agency id)
                  <span className="text-slate-500"> — required if any are attached</span>
                </label>
                <input
                  value={transferTo}
                  onChange={(e) => setTransferTo(e.target.value)}
                  placeholder="Agency id of an approved, active main agency"
                  className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
                />
              </div>
            </div>
          ) : undefined}
          onConfirm={async (reason) => {
            if (decision === 'approve') {
              const out = await partnerOps.approve(id, reason)
              // Decision 15 (RC): the Owner's approval of a login without both
              // verified contacts leaves the role WAITING — say so plainly.
              if (out?.awaiting_verification) {
                setDecision(null)
                setNotice(awaitingLabel(out.missing ?? []))
                load()
                return
              }
            }
            else if (decision === 'reject') await partnerOps.reject(id, reason)
            else if (decision === 'deactivate') await partnerOps.deactivate(id, reason)
            else if (decision === 'revoke') {
              const out = await partnerOps.revoke(id, reason, transferTo.trim() || undefined)
              const moved = out.dependents_moved
              setDecision(null)
              setNotice(
                `Role revoked. ${out.note} ` +
                (moved && (moved.sub_agencies.length || moved.hosts.length)
                  ? `${moved.sub_agencies.length} sub-agenc${moved.sub_agencies.length === 1 ? 'y' : 'ies'} and ` +
                    `${moved.hosts.length} host${moved.hosts.length === 1 ? '' : 's'} moved to ${moved.to_name || moved.to}.`
                  : 'Nothing was attached, so nothing was moved.'),
              )
              load()
              return
            }
            else await partnerOps.reactivate(id, reason)
            setDecision(null)
            setNotice(
              decision === 'reject'
                ? 'Rejected. The reason is on the record and is shown on this page.'
                : 'Done. The reason is in the audit log.',
            )
            load()
          }}
        />
      )}

      {raisingPayout && (
        <PayoutDialog
          title="Raise a commission payout"
          subject={partner.name || partner.id}
          maxMinor={outstanding}
          onClose={() => setRaisingPayout(false)}
          onConfirm={async (amountMinor, reason) => {
            await commission.requestPayout(id, { amount_minor: amountMinor, reason })
            setRaisingPayout(false)
            setNotice(
              'Card raised. Nothing has moved — an owner signs it on the money board, ' +
                'then it is executed here with the bank reference.',
            )
            load()
          }}
        />
      )}

      {payingSub && (
        <PayoutDialog
          title="Raise a sub-agency payout"
          subject={`${payingSub.name || payingSub.id} — paid through ${partner.name || partner.id}`}
          maxMinor={payingSub.owed_by_parent}
          note="Both legs are recorded from the start. Leg 1 is our money reaching this parent. Leg 2 is the parent confirming it paid the sub-agency."
          onClose={() => setPayingSub(null)}
          onConfirm={async (amountMinor, reason) => {
            await commission.requestSubAgencyPayout({
              parent_id: id,
              sub_id: payingSub.id,
              amount_minor: amountMinor,
              reason,
            })
            setPayingSub(null)
            setNotice(
              'Sub-agency payout card raised. Nothing has moved yet, and it stays ' +
                'open until the parent confirms the sub-agency was paid.',
            )
            load()
          }}
        />
      )}
    </div>
  )
}

// ── One payout card on the board ──────────────────────────────────────────────

function PayoutCardRow({
  card,
  isOwner,
  onDone,
}: {
  card: PartnerCard
  /** Only an owner may execute a payout. The API refuses anyone else. */
  isOwner: boolean
  onDone: (message: string) => void
}) {
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const isSubPayout = card.type === 'subagency_payout'

  async function execute() {
    if (!ref.trim()) return
    setBusy(true)
    setErr('')
    try {
      // Leg 1 of a sub-agency payout lives on the generic client; the rest of
      // the commission flow lives on the partner client. Both are the same
      // endpoints under /partner-ops.
      if (isSubPayout) await api.partnerOps.executeSubAgencyPayout(card.id, ref.trim())
      else await commission.executePayout(card.id, ref.trim())
      onDone(
        isSubPayout
          ? 'Leg 1 done — the parent has been paid. The payout stays open until leg 2 is confirmed.'
          : `${inr(card.amount)} paid and recorded against ${ref.trim()}.`,
      )
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That did not go through.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-slate-800/50 border border-slate-700/60 rounded-lg p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-white text-sm font-medium">
            {inr(card.amount)}
            <span className="text-slate-500 font-normal ml-2">
              {isSubPayout ? 'sub-agency payout' : 'commission payout'}
            </span>
          </p>
          <p className="text-slate-500 text-xs mt-0.5 truncate max-w-md">{card.reason}</p>
          <p className="text-slate-600 text-xs mt-0.5">
            raised by {card.requested_by?.name || '—'} · {ageOf(card.created_at)}
          </p>
        </div>
        <span className={`text-xs px-2 py-1 rounded shrink-0 ${STAGE_TONE[card.stage] ?? 'bg-slate-700 text-slate-300'}`}>
          {STAGE_LABEL[card.stage] ?? card.stage}
        </span>
      </div>

      {card.stage === 'rejected' && (
        <p className="text-red-300 text-xs mt-2">
          Rejected by {card.rejected_by?.name ?? '—'}:{' '}
          {card.rejection_reason || 'no reason on record'}
        </p>
      )}

      {card.stage === 'executed' && (
        <p className="text-slate-500 text-xs mt-2 flex items-center gap-1.5">
          <CheckCircle2 size={11} className="text-green-400" />
          Executed {when(card.executed_at)}
          {str(card.payload ?? {}, 'payment_ref')
            ? ` · ref ${str(card.payload ?? {}, 'payment_ref')}`
            : ''}
        </p>
      )}

      {card.stage === 'awaiting_signoff' && (
        <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
          <p className="text-slate-400 text-xs">
            Verified and waiting on an owner. Nothing has moved.
          </p>
          <Link
            href="/board"
            className="flex items-center gap-1.5 text-pink-400 hover:text-pink-300 text-xs"
          >
            Sign it on the money board <ArrowRight size={11} />
          </Link>
        </div>
      )}

      {card.stage === 'approved' && (
        <div className="mt-3 bg-green-500/10 border border-green-500/30 rounded-lg p-3">
          <p className="text-green-200 text-sm font-semibold flex items-center gap-2">
            <ShieldCheck size={14} /> An owner has signed this.
          </p>
          <p className="text-green-200/75 text-xs mt-1">
            The money has not left yet. Executing it debits the commission balance
            and files the bank reference against it — that reference is how the
            payment reconciles later, so it is required.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 mt-3">
            <input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              disabled={!isOwner}
              placeholder="Payment reference (UTR / transaction id)"
              className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm font-mono placeholder-slate-600 focus:outline-none focus:border-green-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <button
              onClick={execute}
              disabled={!isOwner || !ref.trim() || busy}
              title={isOwner ? undefined : 'Only a business owner can execute a payout.'}
              className="flex items-center justify-center gap-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Banknote size={14} />}
              Execute
            </button>
          </div>
          {!isOwner ? (
            <p className="text-green-200/70 text-xs mt-1.5">
              Only a business owner can execute a payout. This one is signed and
              waiting on one — the money has not left, and{' '}
              {isSubPayout ? 'the sub-agency has not been paid' : 'the agency has not been paid'}.
            </p>
          ) : !ref.trim() ? (
            <p className="text-green-200/60 text-xs mt-1.5">
              The API refuses an execution without a reference.
            </p>
          ) : null}
        </div>
      )}

      {err && (
        <p className="mt-2 flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {err}
        </p>
      )}
    </div>
  )
}

// ── Both legs of a sub-agency payout ──────────────────────────────────────────

function PayoutLegs({
  payout,
  onDone,
}: {
  payout: SubPayout
  onDone: (message: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const legOneDone = payout.leg1.status === 'paid'
  const legTwoDone = payout.leg2.status === 'confirmed'
  const atRisk = legOneDone && !legTwoDone

  return (
    <div className={`px-5 py-4 ${atRisk ? 'bg-amber-500/[0.06]' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-white text-sm font-medium">
            {inr(payout.amountMinor)}
            <span className="text-slate-500 font-normal ml-2">
              to {payout.subName || payout.subId}
            </span>
          </p>
          <p className="text-slate-600 text-xs mt-0.5">
            via {payout.parentName || payout.parentId} · raised {when(payout.createdAt)}
          </p>
        </div>
        <span
          className={`text-xs px-2 py-1 rounded shrink-0 ${
            legTwoDone
              ? 'bg-slate-700/60 text-slate-400'
              : atRisk
                ? 'bg-amber-500/15 text-amber-300'
                : 'bg-slate-700 text-slate-300'
          }`}
        >
          {legTwoDone ? 'closed' : atRisk ? 'leg 2 outstanding' : payout.status.replace(/_/g, ' ')}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <LegBox
          n={1}
          title="Zipper pays the main agency"
          done={legOneDone}
          at={payout.leg1.paidAt}
          by={payout.leg1.by}
          detail={payout.leg1.paymentRef ? `ref ${payout.leg1.paymentRef}` : 'no reference on record'}
          pendingCopy="Our money has not left yet. Execute the signed card above."
        />
        <LegBox
          n={2}
          title="Main agency pays the sub-agency"
          done={legTwoDone}
          at={payout.leg2.confirmedAt}
          by={payout.leg2.by}
          detail={payout.leg2.reason}
          pendingCopy={
            legOneDone
              ? 'Our money is gone and this has not been confirmed. The sub-agency may not have been paid.'
              : 'Waiting on leg 1.'
          }
          danger={atRisk}
        />
      </div>

      {atRisk && (
        <div className="mt-3">
          <button
            onClick={() => setConfirming(true)}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-4 py-2 text-sm transition-colors"
          >
            <CheckCircle2 size={14} /> Confirm the parent paid the sub-agency
          </button>
        </div>
      )}

      {confirming && (
        <ReasonDialog
          title="Confirm leg 2"
          hint="This closes the payout. Only confirm it against evidence that the sub-agency actually received the money — the confirmation is what the record will say happened."
          verb="Confirm"
          tone="bg-green-600 hover:bg-green-500"
          subject={`${inr(payout.amountMinor)} to ${payout.subName || payout.subId}`}
          onClose={() => setConfirming(false)}
          onConfirm={async (reason) => {
            await commission.confirmSubAgencyLeg(payout.id, reason)
            setConfirming(false)
            onDone('Leg 2 confirmed. The payout is closed.')
          }}
        />
      )}
    </div>
  )
}

function LegBox({
  n, title, done, at, by, detail, pendingCopy, danger,
}: {
  n: number
  title: string
  done: boolean
  at: string
  by: string
  detail: string
  pendingCopy: string
  danger?: boolean
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2.5 ${
        done
          ? 'bg-green-500/10 border-green-500/30'
          : danger
            ? 'bg-red-500/10 border-red-500/40'
            : 'bg-slate-800/60 border-slate-700'
      }`}
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {done ? (
          <CheckCircle2 size={12} className="text-green-400" />
        ) : (
          <Clock size={12} className={danger ? 'text-red-400' : 'text-slate-500'} />
        )}
        Leg {n}
      </p>
      <p className="text-slate-200 text-sm mt-1">{title}</p>
      {done ? (
        <p className="text-slate-500 text-xs mt-1">
          {when(at)}{by ? ` · ${by}` : ''}{detail ? ` · ${detail}` : ''}
        </p>
      ) : (
        <p className={`text-xs mt-1 ${danger ? 'text-red-300' : 'text-slate-500'}`}>
          {pendingCopy}
        </p>
      )}
    </div>
  )
}

// ── Profile & KYC ─────────────────────────────────────────────────────────────

function ProfilePanel({ partner, profile }: { partner: Partner; profile: Agency | null }) {
  const [zoom, setZoom] = useState('')

  const foreign = profile?.paymentType === 'foreign'

  return (
    <div className="space-y-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h2 className="text-white font-semibold flex items-center gap-2 mb-4">
          <User size={15} className="text-slate-500" /> Contact
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Info icon={<User size={13} />} label="Owner" value={profile?.ownerName || '—'} />
          <Info icon={<Phone size={13} />} label="Phone" value={profile?.ownerPhone || partner.phone || '—'} />
          <Info icon={<Mail size={13} />} label="Email" value={profile?.ownerEmail || partner.email || '—'} />
          <Info icon={<Hash size={13} />} label="Referral code" value={profile?.referralCode || '—'} mono />
          <Info icon={<MapPin size={13} />} label="Address" value={profile?.address || '—'} />
          <Info icon={<Building2 size={13} />} label="CRM id" value={partner.crm_id || profile?.crmId || '—'} mono />
        </div>
        {!profile && (
          <p className="text-slate-600 text-xs mt-4">
            No matching profile document was found, so contact and bank details are
            not shown. The commission record above is unaffected.
          </p>
        )}
      </div>

      {profile && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
          <h2 className="text-white font-semibold flex items-center gap-2 mb-4">
            <Banknote size={15} className="text-slate-500" /> Where the money goes
          </h2>
          {foreign ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Info icon={<Banknote size={13} />} label="Country" value={profile.country || '—'} />
              <Info icon={<Hash size={13} />} label="Binance UID" value={profile.binanceUid || '—'} mono />
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Info icon={<Banknote size={13} />} label="Bank" value={profile.bankName || '—'} />
              <Info icon={<User size={13} />} label="Account holder" value={profile.accountHolderName || '—'} />
              <Info
                icon={<Hash size={13} />}
                label="Account number"
                value={profile.accountNumber ? `•••• ${profile.accountNumber.slice(-4)}` : '—'}
                mono
              />
              <Info icon={<Hash size={13} />} label="IFSC" value={profile.ifscCode || '—'} mono />
              <Info icon={<MapPin size={13} />} label="Branch" value={profile.branch || '—'} />
              <Info icon={<Hash size={13} />} label="UPI" value={profile.upiId || '—'} mono />
            </div>
          )}
        </div>
      )}

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h2 className="text-white font-semibold flex items-center gap-2 mb-1">
          <FileText size={15} className="text-slate-500" /> KYC documents
        </h2>
        <p className="text-slate-500 text-sm mb-4">
          Shown inline. Click one to enlarge — verification means looking at it.
        </p>
        {/* Through the API, not from `profile.kycDocUrls`. Those are
            permanent `?alt=media&token=` bearer URLs that Storage Rules are
            never consulted for — see components/SecureDocuments.tsx. */}
        <SecureDocuments
          kind="agency"
          recordId={partner.id}
          emptyHint="No documents were uploaded."
        />
      </div>

      {zoom && <Lightbox url={zoom} onClose={() => setZoom('')} />}
    </div>
  )
}

// ── Shared bits ───────────────────────────────────────────────────────────────

function BackLink() {
  return (
    <Link
      href="/agencies"
      className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors"
    >
      <ArrowLeft size={14} /> All agencies
    </Link>
  )
}

function Stat({
  label, value, tone, hint,
}: {
  label: string
  value: string
  tone: string
  hint?: string
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold mt-1 ${tone}`}>{value}</p>
      {hint && <p className="text-slate-600 text-xs mt-1">{hint}</p>}
    </div>
  )
}

function Panel({
  title, icon, children,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <h2 className="flex items-center gap-2 text-white font-semibold mb-2">
        <span className="text-slate-500">{icon}</span> {title}
      </h2>
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        {children}
      </div>
    </div>
  )
}

/**
 * One person on the roster, with what the ledger says they earned.
 *
 * A row with no uid is an invitation nobody has redeemed. It gets no link,
 * because there is no account to open — and that is not a missing field, it is
 * the normal state of a live referral code. Linking it to `/users/` would send
 * the reader to a page about nobody.
 */
function RosterRow({
  member, earnings,
}: {
  member: RosterMember
  earnings: HostRow | null
}) {
  const badge = ROSTER_TONE[member.state]
  return (
    <tr className="border-b border-slate-800/60 last:border-0">
      <td className="px-4 sm:px-5 py-3">
        <div className="min-w-0">
          {member.uid ? (
            <Link
              href={`/users/${member.uid}`}
              className="text-slate-200 hover:text-pink-400 text-sm font-medium truncate"
            >
              {member.name}
            </Link>
          ) : (
            <span className="text-slate-200 text-sm font-medium truncate">{member.name}</span>
          )}
          <p className="text-slate-600 text-xs truncate">
            {member.phone || 'no number on record'}
            {member.uid ? '' : member.referralCode ? ` · code ${member.referralCode}` : ''}
          </p>
          {/* GOV B08: shown, never hidden — but it is a host already on this
              roster, so it is not counted again. */}
          {member.sameContactAs && (
            <p className="text-amber-300/90 text-xs">
              same phone or email as{' '}
              <Link
                href={`/users/${member.sameContactAs}`}
                className="underline underline-offset-2 hover:text-amber-200"
              >
                {member.sameContactName || member.sameContactAs}
              </Link>
              {' '}— that host&rsquo;s invitation, not counted again
            </p>
          )}
          {/* The two things that stop a joined host earning at all, shown here
              because an agency asking why its commission is flat is usually
              looking at one of them. */}
          {member.state === 'active' && member.isBanned && (
            <p className="text-red-300 text-xs">banned</p>
          )}
          {member.state === 'active' && !member.isBanned && !member.isVerifiedHost && (
            <p className="text-amber-300/90 text-xs">
              face capture not done — cannot go live, payout held
            </p>
          )}
        </div>
      </td>
      <td className="px-4 sm:px-5 py-3 hidden sm:table-cell">
        <span className={`text-xs px-2 py-1 rounded whitespace-nowrap ${badge.tone}`}>
          {badge.label}
        </span>
      </td>
      <td className="px-4 sm:px-5 py-3 text-right text-slate-400 text-sm hidden sm:table-cell whitespace-nowrap">
        {member.callRateBeans === null ? '—' : `${member.callRateBeans} b/min`}
      </td>
      <td className="px-4 sm:px-5 py-3 text-right text-sm whitespace-nowrap">
        {earnings ? (
          <>
            <span className="text-white font-medium">
              🫘 {earnings.beans_earned.toLocaleString('en-IN')}
            </span>
            <p className="text-slate-600 text-xs">
              {earnings.movements.toLocaleString('en-IN')} movements
            </p>
          </>
        ) : (
          <span className="text-slate-700">—</span>
        )}
      </td>
    </tr>
  )
}

function Th({
  children, align, hideOnMobile,
}: {
  children: React.ReactNode
  align?: 'right'
  hideOnMobile?: boolean
}) {
  return (
    <th
      className={`px-4 sm:px-5 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide whitespace-nowrap ${
        align === 'right' ? 'text-right' : ''
      } ${hideOnMobile ? 'hidden sm:table-cell' : ''}`}
    >
      {children}
    </th>
  )
}

function Info({
  icon, label, value, mono,
}: {
  icon: React.ReactNode
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="text-slate-600 mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-slate-500 text-xs">{label}</p>
        <p className={`text-slate-200 text-sm break-words ${mono ? 'font-mono' : ''}`}>{value}</p>
      </div>
    </div>
  )
}

function DocThumb({
  url, label, onZoom,
}: {
  url: string
  label: string
  onZoom: () => void
}) {
  const [broken, setBroken] = useState(false)
  const isPdf = /\.pdf(\?|$)/i.test(url) || url.toLowerCase().includes('%2fpdf')

  if (!url) {
    return (
      <div>
        <p className="text-slate-500 text-xs mb-1">{label}</p>
        <div className="flex items-center justify-center h-24 bg-slate-950 border border-dashed border-slate-700 rounded-lg text-slate-600 text-xs">
          Not uploaded
        </div>
      </div>
    )
  }

  if (isPdf || broken) {
    return (
      <div>
        <p className="text-slate-500 text-xs mb-1">{label}</p>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex flex-col items-center justify-center gap-1.5 h-24 bg-slate-950 border border-slate-700 hover:border-pink-500/40 rounded-lg text-slate-400 hover:text-pink-300 text-xs transition-colors"
        >
          {broken ? <ImageOff size={16} /> : <FileText size={16} />}
          {broken ? 'Could not load — open directly' : 'PDF'}
          <ExternalLink size={10} />
        </a>
      </div>
    )
  }

  return (
    <div>
      <p className="text-slate-500 text-xs mb-1">{label}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={label}
        onClick={onZoom}
        onError={() => setBroken(true)}
        className="w-full h-24 object-cover bg-slate-950 rounded-lg border border-slate-700 hover:border-pink-500/50 cursor-zoom-in transition-colors"
      />
    </div>
  )
}

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 text-slate-300 hover:text-white"
      >
        <X size={22} />
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="Document"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] max-w-full object-contain rounded-lg"
      />
    </div>
  )
}

/** Every decision carries a reason, validated before it is sent. */
function ReasonDialog({
  title, hint, verb, tone, subject, onClose, onConfirm, extra,
}: {
  title: string
  hint: string
  verb: string
  tone: string
  subject: string
  onClose: () => void
  onConfirm: (reason: string) => Promise<void>
  /** An extra field above the reason — the revoke dialog's transfer target. */
  extra?: React.ReactNode
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
          <div className="min-w-0">
            <h2 className="text-white font-semibold">{title}</h2>
            <p className="text-slate-500 text-xs mt-0.5 truncate">{subject}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
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
            <p className="text-amber-400 text-xs">At least {MIN_REASON} characters.</p>
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

/** Amount plus reason. Raising is all this does — it moves nothing. */
function PayoutDialog({
  title, subject, maxMinor, note, onClose, onConfirm,
}: {
  title: string
  subject: string
  maxMinor: number
  note?: string
  onClose: () => void
  onConfirm: (amountMinor: number, reason: string) => Promise<void>
}) {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const amountMinor = Math.round(Number(amount) * 100) || 0
  const overpay = amountMinor > maxMinor
  const valid = amountMinor > 0 && !overpay && reason.trim().length >= MIN_REASON

  async function go() {
    if (!valid) return
    setBusy(true)
    setErr('')
    try {
      await onConfirm(amountMinor, reason.trim())
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That did not go through.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-white font-semibold">{title}</h2>
            <p className="text-slate-500 text-xs mt-0.5 truncate">{subject}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-slate-400 text-sm">
            This raises a card. No money leaves now — an owner signs it on the
            money board, and executing it needs the bank reference.
          </p>
          {note && <p className="text-slate-500 text-xs">{note}</p>}

          <div>
            <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
              Amount (₹)
            </label>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              inputMode="decimal"
              autoFocus
              placeholder={(maxMinor / 100).toFixed(2)}
              className={`w-full bg-slate-800 border rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none ${
                overpay ? 'border-red-500/60 focus:border-red-500' : 'border-slate-700 focus:border-pink-500'
              }`}
            />
            <p className={`text-xs mt-1 ${overpay ? 'text-red-300' : 'text-slate-500'}`}>
              {overpay
                ? `That is more than the ${inr(maxMinor)} outstanding. The API refuses an overpayment.`
                : `${inr(maxMinor)} outstanding.`}
            </p>
          </div>

          <div>
            <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
              Reason
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Why this is being paid — kept on the card and in the audit log."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
            />
            {reason.trim().length > 0 && reason.trim().length < MIN_REASON && (
              <p className="text-amber-400 text-xs mt-1">At least {MIN_REASON} characters.</p>
            )}
          </div>

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
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Raise the card
          </button>
        </div>
      </div>
    </div>
  )
}
