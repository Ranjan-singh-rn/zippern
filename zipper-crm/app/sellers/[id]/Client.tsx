'use client'

/**
 * One coin seller.
 *
 * A seller is inventory on credit walking around. This screen puts the two
 * things that were never on one page together: what they hold, and what they
 * owe — reconciled from the ledger rather than added up by hand.
 *
 * And, on the first tab, the third thing: **what has actually passed between
 * the business and this person, between two dates, in rupees.** That question
 * had no source here at all. The inventory ledger below is coins with no dates
 * and no amounts; the cards are requests rather than movements; and
 * `cash_paid_minor` is a single lifetime counter that says the same number
 * whatever period you have in mind. The Transactions tab reads
 * `GET /partners/sellers/{id}/history`, which is the same route the seller's own
 * portal reads about themselves — so what we tell them and what we tell
 * ourselves cannot drift apart.
 *
 * The rules this screen enforces in the interface, so nobody meets them as a
 * failed request:
 *
 *   * An overdue seller cannot take new inventory (4.3.12). The API refuses it;
 *     here the button is blocked up front and says exactly why, in the API's
 *     own words.
 *   * Lending, repayment, recovery and write-off all **raise cards**. Nothing
 *     moves on this page — an owner signs on /board, and only executing the
 *     signed card changes a balance.
 *   * Recovery can legitimately exceed the original debt, because a penalty is
 *     part of it (4.3.14), and whatever the balance cannot cover stays an open
 *     receivable (4.3.16). Both are said out loud before the card is raised.
 *
 * Contact details and KYC documents still live in Firestore because the Android
 * app reads them there. They are read here, never written.
 */

import { useCallback, useEffect, useState } from 'react'
import SecureDocuments from '@/components/SecureDocuments'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, ArrowRight, Ban, CheckCircle2, Coins, ExternalLink,
  FileText, Hash, ImageOff, Landmark, Loader2, Mail, Package, Phone, Receipt,
  RefreshCw, ShieldCheck, ShoppingBag, User, Wallet, X, XCircle,
  Building2,
} from 'lucide-react'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { SellerHistoryPanel } from '@/components/SellerHistoryPanel'
import SellerBusinessPanel from '@/components/SellerBusinessPanel'
import { canAccess } from '@/lib/auth'
import api, { ApiError } from '@/lib/api'
import { raisedSentence } from '@/lib/ownerFastPath'
import { roleButtons, type UserRoles } from '@/lib/userRoleActions'
import { restoreGate } from '@/lib/governanceRequests'
import { awaitingLabel } from '@/lib/contactVerification'
import { getSeller, type Seller } from '@/lib/sellers'
import {
  board, inventory, lending, partnerOps, statements,
  coins as coinText, inr, inrExact, num, proofUrl, str, when,
  daysOverdue, standingOf,
  STANDING_LABEL, STANDING_TONE, STATUS_TONE,
  type CreditStanding, type Partner, type PartnerCard, type SellerStatement,
} from '@/lib/apiPartners'

const PAGE_ROLES = [
  'superadmin', 'app_admin', 'ops_admin', 'ops_member',
  'finance_admin', 'finance_member',
] as const

const MIN_REASON = 3

/** How much of the board is pulled before filtering to this seller's cards. */
const BOARD_LIMIT = 400

/** Every card type that touches a seller's inventory or credit. */
const SELLER_CARD_TYPES = new Set([
  'seller_coin_purchase',
  'lending_issue',
  'lending_repay',
  'lending_recover',
  'lending_write_off',
  'bad_debt_write_off',
])

const CARD_LABEL: Record<string, string> = {
  seller_coin_purchase: 'Coin purchase',
  lending_issue: 'Lending',
  lending_repay: 'Repayment',
  lending_recover: 'Recovery',
  lending_write_off: 'Write-off',
  bad_debt_write_off: 'Write-off',
}

const STAGE_LABEL: Record<string, string> = {
  requested: 'Raised — awaiting verification',
  under_review: 'Under review',
  awaiting_signoff: 'Verified — awaiting owner signature',
  approved: 'Signed — nothing has moved yet',
  executed: 'Executed',
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

/**
 * Spec §4 — the CRM is an approval system, not a role-grant tool. `grant_agency`
 * ("Also an agency": staff filing a second-role record for a seller who never
 * asked for one) is gone. A second role begins with the PARTNER applying from
 * their own dashboard (`components/SecondRoleCard`), and is then reviewed on
 * /kyc like any other application.
 */
type Decision = 'approve' | 'reject' | 'deactivate' | 'reactivate' | 'revoke'

const DECISION_COPY: Record<
  Decision,
  { title: string; hint: string; verb: string; tone: string }
> = {
  approve: {
    title: 'Approve this seller',
    hint: 'They become able to buy and borrow inventory. No money moves now.',
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
    title: 'Suspend this seller',
    hint: 'The record is kept and their history stays attributable. Any outstanding credit remains owed.',
    verb: 'Suspend',
    tone: 'bg-amber-600 hover:bg-amber-500',
  },
  reactivate: {
    title: 'Restore this Coin Seller role',
    hint:
      'The SAME record is re-activated — no new application — after the role table is ' +
      're-checked. They can trade again. Nothing about the outstanding credit changes.',
    verb: 'Restore',
    tone: 'bg-green-600 hover:bg-green-500',
  },
  revoke: {
    title: 'Revoke this Coin Seller role',
    hint:
      'The ROLE ends; the person does not. Their account stays active, any Agency or Sub-agency ' +
      'they hold stays active, every transaction and every rupee of history stays, and they may ' +
      'apply again later. They stop appearing to buyers at once. Different from Suspend, which ' +
      'is temporary and keeps their place.',
    verb: 'Revoke role',
    tone: 'bg-red-700 hover:bg-red-600',
  },
}

type Money = 'lend' | 'repay' | 'recover' | 'write_off'

/**
 * `history` is first, and it is first because it is the only tab that answers
 * the question this page is opened to answer: *how much business have I done
 * with this person, and when*.
 *
 * The other three are each one facet and none of them can be added up.
 * `ledger` is coins with no dates, no rupees and no repayments — a repayment
 * moves no coins, so it is in that ledger at no limit. `cards` is requests, not
 * movements. `profile` is contact details. Everything money lives on the first
 * tab now; the rest are kept because each is still the right place to look at
 * its own facet up close.
 */
type Tab = 'history' | 'ledger' | 'cards' | 'profile'

// ══════════════════════════════════════════════════════════════════════════════

export default function SellerDetail() {
  // useParams() can hand back the '_' placeholder in the static-export +
  // Firebase-rewrite setup. The browser URL is always the real id.
  const params = useParams() as { id: string }
  const id =
    (typeof window !== 'undefined'
      ? window.location.pathname.split('/').filter(Boolean)[1] ?? params.id
      : params.id) || params.id

  const { crmUser, apiUser } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, [...PAGE_ROLES])
  // Every `/execute` route reached from this screen is `require_owner` in
  // backend/app/core/deps.py. The Firestore role does not answer that question;
  // the API identity does.
  const isOwner = apiUser?.role === 'owner'

  const [partner, setPartner] = useState<Partner | null>(null)
  const [statement, setStatement] = useState<SellerStatement | null>(null)
  const [gate, setGate] = useState<{ allowed: boolean; reason: string } | null>(null)
  const [cards, setCards] = useState<PartnerCard[]>([])
  const [cardsTruncated, setCardsTruncated] = useState(false)
  const [profile, setProfile] = useState<Seller | null>(null)
  /** UGP-B: what the OWNER holds — Revoke is offered only beside a second role. */
  const [ownerRoles, setOwnerRoles] = useState<UserRoles | null>(null)
  /** The roles request failed — so no revoke is offered, and the page says why. */
  const [ownerRolesFailed, setOwnerRolesFailed] = useState(false)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState<Tab>('history')
  const [decision, setDecision] = useState<Decision | null>(null)
  const [money, setMoney] = useState<Money | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    setError('')
    try {
      const p = await partnerOps.get(id)
      setPartner(p)
      setGate(p.can_take_inventory ?? null)
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

      // Additive: one panel failing must not blank the record.
      statements.seller(id).then(setStatement).catch(() => setStatement(null))
      board
        .list(BOARD_LIMIT)
        .then((list) => {
          setCardsTruncated(list.length >= BOARD_LIMIT)
          setCards(
            list.filter(
              (c) => SELLER_CARD_TYPES.has(c.type) && c.subject?.id === id,
            ),
          )
        })
        .catch(() => setCards([]))

      // The list endpoint does not carry the block reason; this one does, and
      // it is the exact sentence the API would refuse with.
      statements
        .canTakeInventory(id)
        .then(setGate)
        .catch(() => { /* keep whatever the partner record carried */ })

      getSeller(id, p.crm_id)
        .then(setProfile)
        .catch(() => setProfile(null))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this seller.')
      setLoading(false)
    }
  }, [id])

  useEffect(() => { if (allowed) load() }, [allowed, load])

  if (!allowed) return <Denied what="coin seller records" />

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto">
        <Loading label="Loading this seller…" />
      </div>
    )
  }

  if (error || !partner) {
    return (
      <div className="max-w-5xl mx-auto">
        <BackLink />
        <div className="bg-slate-900 border border-slate-800 rounded-xl mt-4">
          <ErrorState
            message={error || 'No seller record was returned for this id.'}
            onRetry={() => { setLoading(true); load() }}
          />
        </div>
      </div>
    )
  }

  const standing: CreditStanding =
    statement?.credit_standing ?? partner.credit_standing ?? standingOf(partner.credit)
  const outstanding = statement?.credit_outstanding ?? partner.credit?.outstanding ?? 0
  const dueAt = statement?.credit_due_at ?? partner.credit?.due_at ?? null
  const onHand = statement?.coins_on_hand ?? partner.coins_on_hand ?? 0

  const blocked = gate ? !gate.allowed : standing === 'overdue'
  const blockReason =
    gate?.reason ||
    (standing === 'overdue'
      ? 'This seller has credit past its due date, which blocks new inventory.'
      : '')

  const signedNotExecuted = cards.filter((c) => c.stage === 'approved')

  return (
    <div className="max-w-5xl mx-auto">
      <BackLink />

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="mt-4 mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <ShoppingBag size={26} className="text-pink-500 shrink-0" />
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
            <span className={`text-xs px-2 py-1 rounded ${STANDING_TONE[standing]}`}>
              credit: {STANDING_LABEL[standing]}
            </span>
            {standing === 'overdue' && dueAt && (
              <span className="text-red-300 text-xs">
                {daysOverdue(dueAt)} days late
              </span>
            )}
            <span className="text-slate-600 text-xs font-mono">{partner.id}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => { setLoading(true); load() }}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          {/* UGP-B: Approve decides an application; Reject only a PENDING one;
              Restore re-activates a suspended or revoked record; Revoke only
              beside a second role. The API refuses every other combination. */}
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
          {/* Spec §4: no "Also an agency" here. A second role is applied for by
              the partner from their dashboard and reviewed on /kyc — this only
              points at where such an application would be seen. */}
          {partner.status === 'approved' && !partner.linked_partner_id && (
            <Link
              href="/kyc"
              title="A second role (Agency) is applied for by the partner from their dashboard; applications are reviewed on /kyc."
              className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg px-4 py-2.5 text-sm transition-colors"
            >
              <Building2 size={15} /> View applications
            </Link>
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
          {(partner.status === 'approved' || partner.status === 'suspended') &&
            roleButtons(ownerRoles).some((b) => b.kind === 'revoke' && b.targetId === partner.id) && (
            <button
              onClick={() => setDecision('revoke')}
              className="bg-red-900/30 hover:bg-red-900/50 border border-red-900/50 text-red-300 rounded-lg px-4 py-2.5 text-sm transition-colors"
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

      {/* The block, said before it is met as a failed request. */}
      {blocked && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3 mb-4">
          <Ban size={16} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-red-200 text-sm font-semibold">
              This seller cannot take new inventory.
            </p>
            <p className="text-red-100/80 text-sm mt-0.5">{blockReason}</p>
            <p className="text-red-100/60 text-sm mt-1">
              Recording a purchase or lending more would be refused. Clear the
              debt with a repayment, or recover it, before giving them more stock.
            </p>
          </div>
        </div>
      )}

      {signedNotExecuted.length > 0 && (
        <Warning>
          {signedNotExecuted.length} card{signedNotExecuted.length === 1 ? ' is' : 's are'}{' '}
          signed but not executed. Nothing has moved on them yet — execute them in
          the Cards tab, or they will sit there indefinitely.
        </Warning>
      )}

      {/* ── The reconciled position ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
        <Stat label="On hand" value={coinText(onHand)} tone="text-white" />
        <Stat
          label="Bought"
          value={statement ? statement.coins_purchased.toLocaleString('en-IN') : '—'}
          tone="text-slate-300"
        />
        <Stat
          label="Lent"
          value={statement ? statement.coins_lent.toLocaleString('en-IN') : '—'}
          tone="text-slate-300"
        />
        <Stat
          label="Sold"
          value={statement ? statement.coins_sold.toLocaleString('en-IN') : '—'}
          tone="text-slate-300"
        />
        <Stat
          label="Outstanding"
          value={outstanding > 0 ? coinText(outstanding) : '—'}
          tone={outstanding > 0 ? 'text-amber-300' : 'text-slate-600'}
          hint={dueAt ? `due ${when(dueAt)}` : 'no credit on the book'}
        />
      </div>

      {statement && (
        <p className="text-slate-600 text-xs mb-5">
          Paid us {inr(statement.cash_paid_minor)} in cash for inventory{' '}
          <strong className="text-slate-500">since the account opened</strong> —
          one running total, the same number whatever period you have in mind. For
          what they paid between two dates, and against which reference, use the{' '}
          <button
            onClick={() => setTab('history')}
            className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
          >
            Transactions
          </button>{' '}
          tab. Bought, lent, sold and on hand all come from the same ledger, so
          they reconcile against each other rather than against four separate
          counters.
        </p>
      )}

      {/* ── Credit actions ──────────────────────────────────────────────── */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-5">
        <h2 className="text-white font-semibold flex items-center gap-2">
          <Wallet size={15} className="text-slate-500" /> Credit
        </h2>
        <p className="text-slate-500 text-sm mt-1 max-w-2xl">
          Each of these raises a card. Nothing moves here — an owner signs on the
          money board, and only executing the signed card changes a balance.
        </p>

        <div className="flex flex-wrap gap-2 mt-4">
          <ActionButton
            onClick={() => setMoney('lend')}
            disabled={blocked || partner.status !== 'approved'}
            tone="pink"
          >
            <Coins size={14} /> Lend inventory
          </ActionButton>
          <ActionButton
            onClick={() => setMoney('repay')}
            disabled={outstanding <= 0}
            tone="slate"
          >
            <CheckCircle2 size={14} /> Record a repayment
          </ActionButton>
          <ActionButton
            onClick={() => setMoney('recover')}
            disabled={outstanding <= 0}
            tone="amber"
          >
            <AlertTriangle size={14} /> Recover the debt
          </ActionButton>
          <ActionButton
            onClick={() => setMoney('write_off')}
            disabled={outstanding <= 0}
            tone="slate"
          >
            <XCircle size={14} /> Write it off
          </ActionButton>
          <Link
            href="/coin-purchases"
            className="inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2 text-sm transition-colors"
          >
            <Package size={14} /> Record a payment <ArrowRight size={12} />
          </Link>
          {/* "Sold" above only moves when a sale is filed and approved. Until
              this screen existed, that number could only ever stay still. */}
          <Link
            href="/sales"
            className="inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2 text-sm transition-colors"
          >
            <ShoppingBag size={14} /> File a sale <ArrowRight size={12} />
          </Link>
        </div>

        {blocked && (
          <p className="text-red-300 text-xs mt-3">
            Lending is blocked: {blockReason}
          </p>
        )}
        {!blocked && partner.status !== 'approved' && (
          <p className="text-amber-300 text-xs mt-3">
            This seller is {partner.status}. Approve the account before moving
            money on it — the API refuses otherwise.
          </p>
        )}
        {outstanding <= 0 && (
          <p className="text-slate-600 text-xs mt-3">
            Nothing is outstanding, so there is nothing to repay, recover or write
            off.
          </p>
        )}
      </div>

      <VirtualAccountRow
        partner={partner}
        canIssue={apiUser?.role === 'owner' || (apiUser?.role ?? '').endsWith('_admin')}
        onIssued={(text) => { setNotice(text); load() }}
      />

      {/* ── Tabs ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 mb-4 overflow-x-auto">
        {([
          ['history', 'Transactions', Receipt],
          ['ledger', 'Inventory ledger', Coins],
          ['cards', `Cards (${cards.length})`, FileText],
          ['profile', 'Profile & KYC', User],
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

      {/* The one tab that can be scoped to a period and counted in rupees. It
          holds its own read and its own date range, so switching tabs does not
          re-fetch the record and a slow history never blocks the page. */}
      {tab === 'history' && (
        <>
          <SellerHistoryPanel
            sellerId={id}
            audience="owner"
            sellerName={partner.name || partner.id}
          />
          {/* B9: margin, tier, credit limit, borrowing and trades. */}
          <SellerBusinessPanel sellerId={id} audience="staff" />
        </>
      )}

      {tab === 'ledger' && (
        <Panel title="Inventory ledger" icon={<Coins size={15} />}>
          {/* Said at the top of the tab rather than discovered at the bottom of
              it: this is the coin ledger, and a repayment moves no coins, so a
              repayment is not in it at any limit. */}
          <p className="px-4 sm:px-5 py-3 text-slate-500 text-xs border-b border-slate-800">
            Coins only, most recent first. A <strong>repayment does not appear
            here</strong> — it moves no coins, it reduces what the seller owes,
            and there is no ledger row to show. Nothing carries a rupee figure or
            a reference either: both live on the card. The{' '}
            <button
              onClick={() => setTab('history')}
              className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
            >
              Transactions
            </button>{' '}
            tab has all of it in one list, with dates.
          </p>
          {!statement ? (
            <ErrorState message="The statement could not be read. The rest of this record is still accurate." />
          ) : statement.entries.length === 0 ? (
            <Empty
              title="No inventory movements yet"
              hint="Purchases, lending, recoveries and sales appear here as they happen. Repayments never do — they move no coins."
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
                    <Th align="right">Coins</Th>
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
                            amount >= 0 ? 'text-green-300' : 'text-slate-400'
                          }`}
                        >
                          {amount >= 0 ? '+' : ''}{amount.toLocaleString('en-IN')}
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

      {tab === 'cards' && (
        <div className="space-y-3">
          {cardsTruncated && (
            <Warning>
              Only the most recent {BOARD_LIMIT} cards were read, so older cards for
              this seller are not listed here. Nothing is missing from the record —
              the money board and the audit log hold the rest.
            </Warning>
          )}
          {cards.length === 0 ? (
            <div className="bg-slate-900 border border-slate-800 rounded-xl">
              <Empty
                title="No cards for this seller"
                hint="Purchases, lending, repayments and recoveries appear here from the moment they are raised."
                icon={<FileText size={26} />}
              />
            </div>
          ) : (
            cards.map((card) => (
              <SellerCardRow
                key={card.id}
                card={card}
                isOwner={isOwner}
                onDone={(message) => { setNotice(message); load() }}
              />
            ))
          )}
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
          extra={
            decision === 'deactivate' && outstanding > 0 ? (
              <p className="text-amber-300 text-xs">
                This seller still owes {coinText(outstanding)}. Suspending them
                does not cancel the debt.
              </p>
            ) : null
          }
          onClose={() => setDecision(null)}
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
            else if (decision === 'revoke') await partnerOps.revoke(id, reason)
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

      {money && (
        <CreditDialog
          kind={money}
          sellerId={id}
          sellerName={partner.name || partner.id}
          outstanding={outstanding}
          onHand={onHand}
          onClose={() => setMoney(null)}
          onRaised={(message) => { setMoney(null); setNotice(message); load() }}
        />
      )}
    </div>
  )
}

// ── One card ──────────────────────────────────────────────────────────────────

/**
 * The seller's permanent virtual account number, or the reason there is none.
 * Spec 4.3.4 / 8C.1.4.
 *
 * A staff member looking at a seller record has to be able to answer "what
 * account does this person pay into". Today the answer is "none, and here is
 * why", and that is a real answer — the server's own sentence, the same one the
 * seller sees in their portal, so the two cannot drift into disagreeing about
 * whose fault a missing number is.
 *
 * The Issue button is here for the day the bank account opens: sellers approved
 * before then never pass back through approval, so without it they would stay
 * without a number forever. It is **not hidden while the bank is absent** — the
 * API's refusal names the reason (an eCMS collection account needs a business
 * current account, 8C.8.7) and that sentence is more useful than a control
 * silently missing from the screen. It is shown verbatim.
 */
function VirtualAccountRow({
  partner,
  canIssue,
  onIssued,
}: {
  partner: Partner
  canIssue: boolean
  onIssued: (notice: string) => void
}) {
  const [asking, setAsking] = useState(false)
  const van = partner.virtual_account

  return (
    <>
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-5">
        <h2 className="text-white font-semibold flex items-center gap-2">
          <Landmark size={15} className="text-slate-500" /> Virtual account
        </h2>

        {!van ? (
          <p className="text-yellow-300 text-sm mt-2">
            This record came back without a virtual-account field, so whether one
            exists could not be read. That is not the same as &ldquo;none
            issued&rdquo; — refresh before concluding anything from it.
          </p>
        ) : van.issued ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-3">
              <Info
                icon={<Hash size={14} />}
                label="Account number"
                value={van.number ?? ''}
                mono
              />
              <Info icon={<Landmark size={14} />} label="IFSC" value={van.ifsc} mono />
              <Info
                icon={<User size={14} />}
                label="Account name"
                value={van.beneficiary_name}
              />
            </div>
            <p className="text-slate-600 text-xs mt-3">
              Issued {when(van.issued_at)} by {van.provider || 'the bank'}, mapped
              onto {van.collection_account || 'the collection account'}. Permanent
              — it is never reissued, because the seller has given this number to
              the people who pay them. Payments into it identify the payer, so
              this seller needs no UTR and no screenshot.
            </p>
          </>
        ) : (
          <>
            <p className="text-slate-300 text-sm mt-2">
              No virtual account number is issued to this seller.
            </p>
            {/* Verbatim, and the same sentence the seller reads in their portal. */}
            <p className="text-slate-500 text-sm mt-1.5 leading-relaxed max-w-3xl">
              {van.reason}
            </p>
            {canIssue && (
              <button
                onClick={() => setAsking(true)}
                className="mt-3 inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2 text-sm transition-colors"
              >
                <Landmark size={14} /> Issue one
              </button>
            )}
          </>
        )}
      </div>

      {asking && (
        <ReasonDialog
          title="Issue a virtual account number"
          subject={partner.name || partner.id}
          hint={
            'The number is allocated by the bank, never generated here — with no eCMS collection account this is refused, and the refusal says so. It is permanent once issued and can never be changed, so the reason should say why this seller needs one now.'
          }
          verb="Issue"
          tone="bg-slate-700 hover:bg-slate-600"
          onClose={() => setAsking(false)}
          onConfirm={async (reason) => {
            const result = await partnerOps.issueVirtualAccount(partner.id, reason)
            setAsking(false)
            onIssued(
              `Virtual account ${result.number} issued. It is permanent and is now shown in this seller's portal.`,
            )
          }}
        />
      )}
    </>
  )
}

function SellerCardRow({
  card,
  isOwner,
  onDone,
}: {
  card: PartnerCard
  /**
   * Only an owner may execute. All five endpoints behind `execute()` below —
   * coin purchase, lending, repayment, recovery and write-off — are
   * `require_owner`, so anyone else gets a 403 from the button.
   */
  isOwner: boolean
  onDone: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirming, setConfirming] = useState(false)

  const coins = num(card.payload, 'coins') || card.amount
  const penalty = num(card.payload, 'penalty_coins')

  // The three facts an owner is about to sign a card on, and the three this row
  // never showed. The seller's own portal has rendered them since it was built
  // (app/seller-dashboard/page.tsx — `CardRow`), so until now the person who
  // paid could see the amount, the UTR and the screenshot and the person
  // approving it could not. `payment_ref` is what reconciles the card against a
  // bank line, and the proof is the only evidence that the payment happened at
  // all.
  const paidMinor = num(card.payload, 'amount_paid_minor')
  const ref = str(card.payload, 'payment_ref')
  const proof = proofUrl(card)
  const carriesMoney = card.type === 'seller_coin_purchase' || !!ref || !!proof

  async function execute() {
    setBusy(true)
    setErr('')
    try {
      switch (card.type) {
        case 'seller_coin_purchase':
          await inventory.executeCoinPurchase(card.id)
          break
        case 'lending_issue':
          await lending.execute(card.id)
          break
        case 'lending_repay':
          await lending.executeRepayment(card.id)
          break
        case 'lending_recover':
          await lending.executeRecovery(card.id)
          break
        case 'bad_debt_write_off':
          await lending.executeWriteOff(card.id)
          break
        default:
          throw new ApiError('This card type cannot be executed from here.', 400)
      }
      onDone(`${CARD_LABEL[card.type] ?? 'Card'} executed. The ledger has moved.`)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That did not go through.')
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-white text-sm font-medium">
            {CARD_LABEL[card.type] ?? card.type.replace(/_/g, ' ')}
            <span className="text-yellow-300 font-semibold ml-2">{coinText(coins)}</span>
            {penalty > 0 && (
              <span className="text-amber-300 text-xs ml-2">
                incl. {coinText(penalty)} penalty
              </span>
            )}
          </p>
          <p className="text-slate-500 text-xs mt-0.5 break-words max-w-xl">{card.reason}</p>
          <p className="text-slate-600 text-xs mt-0.5">
            raised by {card.requested_by?.name || '—'} · {ageOf(card.created_at)}
          </p>
        </div>
        <span className={`text-xs px-2 py-1 rounded shrink-0 ${STAGE_TONE[card.stage] ?? 'bg-slate-700 text-slate-300'}`}>
          {STAGE_LABEL[card.stage] ?? card.stage}
        </span>
      </div>

      {/* Money, reference and evidence — on a coin purchase always, and on any
          other card that carries a reference (a repayment does). A lending or a
          write-off carries none of the three, and an empty row saying "₹0" and
          "—" would be describing a payment that was never part of it. */}
      {carriesMoney && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3 pt-3 border-t border-slate-800">
          {card.type === 'seller_coin_purchase' && (
            <div>
              <dt className="text-slate-500 text-xs">Stated as paid</dt>
              {/* Paise → rupees, once, to the paisa: this is reconciled against
                  a bank line, where a dropped trailing zero is a different
                  number. */}
              <dd className="text-slate-200 text-sm">{inrExact(paidMinor)}</dd>
            </div>
          )}
          <div className="min-w-0">
            <dt className="text-slate-500 text-xs">Payment reference</dt>
            <dd className="text-slate-200 text-xs font-mono break-all">
              {ref || <span className="text-slate-600 font-sans">none given</span>}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500 text-xs">Proof</dt>
            <dd>
              {proof ? (
                <a
                  href={proof}
                  target="_blank"
                  rel="noreferrer"
                  className="text-pink-400 hover:text-pink-300 text-xs inline-flex items-center gap-1"
                >
                  Open <ExternalLink size={10} />
                </a>
              ) : (
                <span className="text-slate-600 text-xs">none uploaded</span>
              )}
            </dd>
          </div>
        </dl>
      )}

      {card.warning && (
        <p className="flex items-start gap-2 mt-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-amber-100 text-xs">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {card.warning}
        </p>
      )}

      {card.verified_by && (
        <p className="text-slate-500 text-xs mt-2">
          Verified by {card.verified_by.name} · {when(card.verified_at)}
          {card.verification_note ? ` — ${card.verification_note}` : ''}
        </p>
      )}

      {card.stage === 'rejected' && (
        <p className="text-red-300 text-xs mt-2">
          Rejected by {card.rejected_by?.name ?? '—'}:{' '}
          {card.rejection_reason || 'no reason on record'}
        </p>
      )}

      {card.stage === 'executed' && (
        <p className="text-green-300 text-xs mt-2 flex items-center gap-1.5">
          <CheckCircle2 size={11} /> Executed {when(card.executed_at)}.
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
            Nothing has moved yet. Executing it is the moment the balance changes,
            and it cannot be undone from this screen — a correction would be
            another card.
          </p>
          {!isOwner ? (
            <>
              <button
                type="button"
                disabled
                title="Only a business owner can execute a signed card."
                className="mt-3 flex items-center gap-2 bg-slate-800 text-slate-500 font-semibold rounded-lg px-4 py-2 text-sm cursor-not-allowed"
              >
                <Coins size={14} /> Execute
              </button>
              <p className="text-green-200/70 text-xs mt-1.5">
                Only a business owner can execute this. It is signed and waiting on
                one — until then the balance is unchanged.
              </p>
            </>
          ) : confirming ? (
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button
                onClick={execute}
                disabled={busy}
                className="flex items-center gap-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Coins size={14} />}
                Yes — execute {coinText(coins)}
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="text-slate-400 hover:text-white text-sm px-3 py-2"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="mt-3 flex items-center gap-2 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
            >
              <Coins size={14} /> Execute
            </button>
          )}
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

// ── Profile & KYC ─────────────────────────────────────────────────────────────

function ProfilePanel({ partner, profile }: { partner: Partner; profile: Seller | null }) {
  const [zoom, setZoom] = useState('')

  return (
    <div className="space-y-4">
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h2 className="text-white font-semibold flex items-center gap-2 mb-4">
          <User size={15} className="text-slate-500" /> Contact
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Info icon={<User size={13} />} label="Name" value={profile?.displayName || partner.name || '—'} />
          <Info icon={<Phone size={13} />} label="Phone" value={profile?.phone || partner.phone || '—'} />
          <Info icon={<Mail size={13} />} label="Email" value={profile?.email || partner.email || '—'} />
          <Info icon={<Hash size={13} />} label="CRM id" value={partner.crm_id || profile?.crmId || '—'} mono />
        </div>
        {!profile && (
          <p className="text-slate-600 text-xs mt-4">
            No matching profile document was found, so contact details and KYC
            documents are not shown. The inventory record above is unaffected.
          </p>
        )}
      </div>

      {/* Where buyers pay this seller. Reviewed here, behind the page's role
          gate, like the identity documents below. Only the UPI id, the UPI
          QR and the Binance UID reach the public directory the app reads;
          the bank account never does. */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h2 className="text-white font-semibold flex items-center gap-2 mb-4">
          <Landmark size={15} className="text-slate-500" /> Where buyers pay them
        </h2>
        {profile?.payment && Object.values(profile.payment).some(Boolean) ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {profile.payment.upiId && <Info icon={<Hash size={13} />} label="UPI id" value={profile.payment.upiId} mono />}
            {profile.payment.binanceUid && <Info icon={<Hash size={13} />} label="Binance UID" value={profile.payment.binanceUid} mono />}
            {profile.payment.accountHolderName && <Info icon={<User size={13} />} label="Account holder" value={profile.payment.accountHolderName} />}
            {profile.payment.accountNumber && (
              <Info icon={<Landmark size={13} />} label="Account number"
                value={`•••• ${profile.payment.accountNumber.slice(-4)}`} mono />
            )}
            {profile.payment.ifscCode && <Info icon={<Hash size={13} />} label="IFSC" value={profile.payment.ifscCode} mono />}
            {profile.payment.bankName && <Info icon={<Landmark size={13} />} label="Bank" value={`${profile.payment.bankName}${profile.payment.branch ? ` · ${profile.payment.branch}` : ''}`} />}
            {profile.payment.internationalMethod && (
              <Info icon={<Hash size={13} />} label="International"
                value={`${profile.payment.internationalMethod}${profile.payment.internationalDetails ? ` · ${profile.payment.internationalDetails}` : ''}`} />
            )}
            {(profile.payment.upiQrUrl || profile.qrCodeUrl) && (
              <div className="sm:col-span-2">
                <p className="text-slate-500 text-xs mb-1.5">UPI QR</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={profile.payment.upiQrUrl || profile.qrCodeUrl} alt="UPI QR"
                  className="w-32 h-32 rounded-lg border border-slate-700 object-contain bg-white cursor-zoom-in"
                  onClick={() => setZoom(profile.payment?.upiQrUrl || profile.qrCodeUrl)} />
              </div>
            )}
          </div>
        ) : (
          <p className="text-slate-500 text-sm">
            No settlement details on file. A seller who applied before this field existed can add
            them from their dashboard; buyers see only a QR until then.
          </p>
        )}
      </div>

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <h2 className="text-white font-semibold flex items-center gap-2 mb-1">
          <FileText size={15} className="text-slate-500" /> Documents
        </h2>
        <p className="text-slate-500 text-sm mb-4">
          Shown inline. Click one to enlarge — verification means looking at it.
        </p>
        {/* Through the API — see the note on the agency screen and
            components/SecureDocuments.tsx. The server collects `idDocUrls`
            and `registrationProofUrl` into one list, so the two shapes this
            screen used to join by hand are joined once, server-side. */}
        <SecureDocuments
          kind="seller"
          recordId={partner.id}
          emptyHint="No documents were uploaded."
        />
      </div>

      {zoom && <Lightbox url={zoom} onClose={() => setZoom('')} />}
    </div>
  )
}

// ── Raising a credit card ─────────────────────────────────────────────────────

const CREDIT_COPY: Record<
  Money,
  { title: string; hint: string; verb: string; needsDue: boolean; needsPenalty: boolean; needsRef: boolean }
> = {
  lend: {
    title: 'Lend inventory on credit',
    hint: 'A due date is required — credit without one is a gift. Nothing is credited until an owner signs the card.',
    verb: 'Raise the lending card',
    needsDue: true,
    needsPenalty: false,
    needsRef: false,
  },
  repay: {
    title: 'Record a repayment',
    hint: 'This reduces what the seller owes once the card is signed and executed. The payment reference is how it reconciles against the bank.',
    verb: 'Raise the repayment card',
    needsDue: false,
    needsPenalty: false,
    needsRef: true,
  },
  recover: {
    title: 'Recover the debt',
    hint: 'Recovery takes coins back out of the seller balance.',
    verb: 'Raise the recovery card',
    needsDue: false,
    needsPenalty: true,
    needsRef: false,
  },
  write_off: {
    title: 'Write the debt off',
    hint: 'A write-off is a loss, not an adjustment. It appears in the audit log as one, and an owner signs it.',
    verb: 'Raise the write-off card',
    needsDue: false,
    needsPenalty: false,
    needsRef: false,
  },
}

function CreditDialog({
  kind, sellerId, sellerName, outstanding, onHand, onClose, onRaised,
}: {
  kind: Money
  sellerId: string
  sellerName: string
  outstanding: number
  onHand: number
  onClose: () => void
  onRaised: (message: string) => void
}) {
  const copy = CREDIT_COPY[kind]

  const [coins, setCoins] = useState('')
  const [penalty, setPenalty] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [paymentRef, setPaymentRef] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const coinsNum = Math.round(Number(coins)) || 0
  const penaltyNum = Math.round(Number(penalty)) || 0
  const total = coinsNum + penaltyNum

  const valid =
    coinsNum > 0 &&
    reason.trim().length >= MIN_REASON &&
    (!copy.needsDue || dueAt.length > 0)

  async function submit() {
    if (!valid) return
    setBusy(true)
    setErr('')
    try {
      if (kind === 'lend') {
        const card = await lending.request(sellerId, {
          coins: coinsNum,
          due_at: new Date(dueAt).toISOString(),
          reason: reason.trim(),
        })
        onRaised(raisedSentence('Lending card', card))
      } else if (kind === 'repay') {
        const card = await lending.requestRepayment(sellerId, {
          coins: coinsNum,
          payment_ref: paymentRef.trim(),
          reason: reason.trim(),
        })
        onRaised(raisedSentence('Repayment card', card))
      } else if (kind === 'recover') {
        const card = await lending.requestRecovery(sellerId, {
          coins: coinsNum,
          penalty_coins: penaltyNum,
          reason: reason.trim(),
        })
        onRaised(raisedSentence('Recovery card', card))
      } else {
        const card = await lending.requestWriteOff(sellerId, {
          coins: coinsNum,
          reason: reason.trim(),
        })
        onRaised(raisedSentence('Write-off card', card))
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'The request was not accepted.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 bg-black/70 backdrop-blur-sm overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-md my-8">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-white font-semibold">{copy.title}</h2>
            <p className="text-slate-500 text-xs mt-0.5 truncate">{sellerName}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-slate-400 text-sm">{copy.hint}</p>

          {/* Recovery is the one that surprises people. Say it plainly. */}
          {kind === 'recover' && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5">
              <p className="text-amber-100 text-sm font-semibold">
                Recovery can legitimately exceed the original debt.
              </p>
              <p className="text-amber-100/80 text-xs mt-1">
                A penalty is part of recovery, so the total taken back may be more
                than the {coinText(outstanding)} owed. Whatever the seller&rsquo;s
                balance cannot cover stays an open receivable against them — it
                does not disappear.
              </p>
              <p className="text-amber-100/60 text-xs mt-1">
                They hold {coinText(onHand)} right now.
              </p>
            </div>
          )}

          <Labelled label={kind === 'recover' ? 'Coins to recover' : 'Coins'}>
            <input
              value={coins}
              onChange={(e) => setCoins(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric"
              autoFocus
              placeholder={outstanding > 0 ? String(outstanding) : '100000'}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
            {outstanding > 0 && kind !== 'lend' && (
              <p className="text-slate-500 text-xs mt-1">
                {coinText(outstanding)} outstanding.
              </p>
            )}
          </Labelled>

          {copy.needsPenalty && (
            <Labelled label="Penalty (coins)">
              <input
                value={penalty}
                onChange={(e) => setPenalty(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                placeholder="0"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
              />
              <p className="text-slate-500 text-xs mt-1">
                Total to recover: {coinText(total)}
                {total > outstanding && outstanding > 0 && (
                  <span className="text-amber-300">
                    {' '}— {coinText(total - outstanding)} more than the debt.
                  </span>
                )}
              </p>
            </Labelled>
          )}

          {copy.needsDue && (
            <Labelled label="Due date">
              <input
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
              />
              {!dueAt && (
                <p className="text-amber-400 text-xs mt-1">
                  Required. Credit with no due date can never be overdue, so it can
                  never be chased.
                </p>
              )}
            </Labelled>
          )}

          {copy.needsRef && (
            <Labelled label="Payment reference (optional)">
              <input
                value={paymentRef}
                onChange={(e) => setPaymentRef(e.target.value)}
                placeholder="UTR from the bank"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-slate-600 focus:outline-none focus:border-pink-500"
              />
            </Labelled>
          )}

          <Labelled label="Reason">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Why this is being done — kept on the card and in the audit log."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
            />
            {reason.trim().length > 0 && reason.trim().length < MIN_REASON && (
              <p className="text-amber-400 text-xs mt-1">At least {MIN_REASON} characters.</p>
            )}
          </Labelled>

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
            onClick={submit}
            disabled={!valid || busy}
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Coins size={14} />}
            {copy.verb}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Shared bits ───────────────────────────────────────────────────────────────

function BackLink() {
  return (
    <Link
      href="/sellers"
      className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm transition-colors"
    >
      <ArrowLeft size={14} /> All coin sellers
    </Link>
  )
}

function ActionButton({
  children, onClick, disabled, tone,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  tone: 'pink' | 'amber' | 'slate'
}) {
  const tones = {
    pink: 'bg-pink-500 hover:bg-pink-600 text-white',
    amber: 'bg-amber-600/90 hover:bg-amber-500 text-white',
    slate: 'bg-slate-800 hover:bg-slate-700 text-slate-300',
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:bg-slate-800 disabled:text-slate-600 disabled:cursor-not-allowed ${tones[tone]}`}
    >
      {children}
    </button>
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
      <p className={`text-lg font-bold mt-1 ${tone}`}>{value}</p>
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

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
        {label}
      </label>
      {children}
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
  title, hint, verb, tone, subject, extra, onClose, onConfirm,
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
