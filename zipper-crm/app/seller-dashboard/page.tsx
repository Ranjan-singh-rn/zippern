'use client'

import Link from 'next/link'

/**
 * The coin seller's own portal.
 *
 * ── What was wrong with this page ─────────────────────────────────────────────
 *
 * It read and wrote Firestore directly, and two things followed:
 *
 *   1. Its purchase requests went nowhere. It wrote `coinPurchaseRequests`;
 *      `/coin-purchases` reads the Mongo card board. A seller who had already
 *      paid us reached nobody.
 *   2. A seller could not see their own position. `sellers/{id}.coinBalance` is
 *      a replica of a ledger balance and nothing on this page ever mentioned
 *      credit, a due date, or what they owed.
 *
 * Everything a figure is now taken from, with the route and the file behind it:
 *
 *   GET  /partner-ops/partners/me            routers/partner_ops.py:280
 *        → status, credit, coins on hand, can-take-inventory
 *   GET  /partners/sellers/{id}/statement    routers/partners.py:83
 *        → bought, lent, sold, on hand, cash paid, the ledger itself
 *   GET  /partners/sellers/{id}/history      routers/partners.py
 *        → the Everything tab. Every movement on this account in one
 *          time-ordered list, with a date range: purchases with the rupees, the
 *          UTR and the proof; lending; **repayments**, which move no coins and
 *          are therefore in the statement above at no limit; recoveries;
 *          write-offs; and the sales filed, with the buyer. The business owner
 *          reads the same route on /sellers/{id}, so the two views of this
 *          account cannot disagree.
 *   GET  /partners/sellers/{id}/can-take-inventory  routers/partners.py:94
 *        → the block and, more importantly, the reason for it
 *   GET  /cards                              routers/cards.py:66
 *        → this seller's own cards. `board_for` (services/cards.py) scopes an
 *          external account to the cards they raised **and the cards raised
 *          about them** — lending, repayment, recovery, write-off — so a debt
 *          being created is visible here from the moment the card exists rather
 *          than only once it is executed. Nothing anyone else's is on it, and
 *          the staff who raised, verified and signed each one are not named.
 *   POST /partner-ops/sellers/{id}/coin-purchases  routers/partner_ops.py:389
 *   POST /partner-ops/sales                  routers/partner_ops.py:534
 *   GET  /partner-ops/sales                  routers/partner_ops.py:550
 *
 * ── The one thing this page must never do ────────────────────────────────────
 *
 * Move money. It raises requests and files records; every actual movement is a
 * card, verified by a second person and signed by an owner, and the coins do
 * not exist until an owner *executes* it. `approved` is not `executed`, and the
 * portal says so wherever a stage is shown.
 *
 * ── Units ────────────────────────────────────────────────────────────────────
 *
 * Coins are coins and are never money. Cash is integer paise on the wire and is
 * divided by 100 exactly once, by `inr()` in lib/apiPartners, which also puts
 * the ₹ on it. Nothing here formats a rupee figure by hand.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, Ban, CheckCircle2, Clock, Coins, Copy, CreditCard, ExternalLink,
  FileText, Gem, Hourglass, Landmark, Package, Receipt, RefreshCw, ShieldCheck,
  ShoppingBag, ToggleLeft, ToggleRight, User, Wallet, XCircle,
} from 'lucide-react'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useAuth } from '@/components/AuthProvider'
import { SecondRoleCard } from '@/components/SecondRoleCard'
import { SellerHistoryPanel } from '@/components/SellerHistoryPanel'
import SellerBusinessPanel from '@/components/SellerBusinessPanel'
import { PendingChangesNotice } from '@/components/PendingChangesNotice'
import {
  Denied, Empty, ErrorState, Loading, Unavailable, UnavailablePanel, Warning,
} from '@/components/ui/States'
import {
  attempt, failureCode, ok, toFailure, type ReadFailure, type ReadResult,
} from '@/lib/readState'
import api, { ApiError, type Sale } from '@/lib/api'
import { IdentityBlock } from '@/components/ui/Identity'
import { useIdentities } from '@/lib/useIdentities'
import { partnerRecordId, partnerRolesOf } from '@/lib/auth'
import { getSeller, getSellerRechargeRequests, type RechargeRequest, type Seller } from '@/lib/sellers'
import { getSellerCoinPurchases, type CoinPurchaseRequest } from '@/lib/coinPurchases'
import {
  OWN_RECORD, board, num, partnerOps, proofUrl, statements, str,
  coins as coinText, daysOverdue, inr, standingOf, when,
  STANDING_LABEL, STANDING_TONE, STATUS_TONE,
  type CreditStanding, type LedgerEntry, type Partner, type PartnerCard,
  type PartnerCredit, type SellerStatement, type VirtualAccount,
} from '@/lib/apiPartners'
import BuyInventoryDialog from './BuyInventoryDialog'
import FileSaleDialog from './FileSaleDialog'
import {
  Info, Panel, Stat, StageTrack, Th, ageOf, dateInputValue, whenExact,
  STAGE_LABEL, STAGE_MEANING, STAGE_TONE,
} from './parts'

/**
 * `statements.seller()` takes no `limit`, so the server default applies
 * (routers/partners.py:86 — `limit: int = Query(default=200, le=500)`). The
 * statement is therefore the most recent 200 movements, and every figure in it
 * is derived from those. Said out loud on screen when the cap is reached.
 */
const STATEMENT_LIMIT = 200

/** How much of the board is pulled before filtering to this seller's cards. */
const BOARD_LIMIT = 200

/**
 * Every card type that touches a seller's inventory or credit.
 *
 * This must not be narrower than the server's own
 * `cards.PARTNER_SUBJECT_CARD_TYPES`, or a card the API is willing to show this
 * seller is filtered out here and they are told about their debt by nobody.
 * `commission_payout` and `subagency_payout` are on the server's list and not on
 * this one deliberately: they are agency money and a seller record never carries
 * either, so filtering them out costs a seller nothing.
 */
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
  lending_issue: 'Credit issued to you',
  lending_repay: 'Repayment',
  lending_recover: 'Recovery',
  lending_write_off: 'Write-off',
  bad_debt_write_off: 'Write-off',
}

/** Ledger actions, in the seller's words. money.py writes these verbatim. */
const ACTION_LABEL: Record<string, string> = {
  'inventory.credit': 'Coins bought',
  'inventory.debit': 'Coins sold',
  'lending.issue': 'Borrowed on credit',
  'lending.recover': 'Recovered by us',
  'lending.repay': 'Repayment',
  'lending.write_off': 'Written off',
}

type Tab = 'everything' | 'purchases' | 'statement' | 'credit' | 'sales' | 'profile'

/**
 * `everything` is first, and it is first because reconciling this account used
 * to mean reading four of the tabs behind it and doing the arithmetic by hand —
 * and one movement was in none of them. A repayment moves no coins, so
 * `Statement` cannot show one at any limit; the amount and the UTR of a purchase
 * are on the card, so they are not in `Statement` either; a sale is in `Sales`
 * and nowhere near the stock it came out of.
 *
 * The other five are kept. Each is still the best place to look at its own
 * facet up close — the stage a purchase has reached, the terms of the credit,
 * the QR code — and none of them is where you go to answer "what has happened
 * on my account".
 */
const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: 'everything', label: 'Everything', icon: Receipt },
  { key: 'purchases', label: 'Purchases', icon: Package },
  { key: 'statement', label: 'Statement', icon: FileText },
  { key: 'credit', label: 'Credit', icon: CreditCard },
  { key: 'sales', label: 'Sales', icon: Gem },
  { key: 'profile', label: 'Profile', icon: User },
]

/**
 * The Firestore seller document, plus the availability flag the Android app
 * writes and `lib/sellers.ts` does not name. Declared here rather than widening
 * a shared type this task does not own.
 */
type SellerDoc = Seller & { isOnline?: boolean }

/**
 * A figure off a legacy Firestore document, where the field may simply not be
 * there.
 *
 * `CoinPurchaseRequest.coinsRequested` and `RechargeRequest.amountPaid` are
 * typed as required `number` because that is what the current writers produce,
 * but both are read through an `as` cast over whatever is actually in a
 * collection three different clients have written to over two years. A row
 * missing its amount used to render as `0` — "you asked for no coins", "you paid
 * ₹0" — inside the one panel that exists to tell a seller an old request of
 * theirs never reached us, which is the worst possible place to put a figure
 * they might have paid against. An absent field is absent, and says so.
 *
 * This is not the refused-read case: the document was read, successfully. It is
 * the same principle one step in — a value nobody recorded is not a zero anybody
 * measured.
 */
function legacyAmount(
  value: number | undefined,
  format: (n: number) => string,
): React.ReactNode {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return <span className="text-slate-600 text-xs">not recorded</span>
  }
  return format(value)
}

/**
 * Classify a rejection with `readState`, but say what the SERVER said.
 *
 * This is the same helper `app/agency-dashboard/AgencyMoney.tsx` defines, for
 * the same reason and with the same wording — the agency owner got it first and
 * the seller was left with the generic sentence.
 *
 * `toFailure` describes every refusal in Firestore's vocabulary: "The database
 * refused this read. Your role may not cover it, or the rule for it is
 * missing." That is right for a security rule and wrong for four of the reads
 * on this page, which are HTTP calls to the partner API — and the partner API
 * refuses in whole sentences written to be shown to the partner:
 *
 *   • "This account has no approved partner record, so there is nothing to
 *     show yet."                          core/deps.py:255, a seller under review
 *   • "You can only view your own records."               core/deps.py:281
 *
 * Turning either of those into "your role may not cover it, or the rule for it
 * is missing" sends a seller to look for a Firestore rule that has nothing to
 * do with why they cannot see their own coins. The classification stays shared
 * and is already correct — `failureCode` maps HTTP 403 to `permission-denied`
 * — so only the wording is taken from the response.
 *
 * A 400 already survived `attempt()` intact (`failureCode` leaves it `unknown`,
 * and `failureReason` then returns `err.message`); it is 401/403 and 5xx that
 * were being overwritten. Anything that is not an `ApiError` — a network fault,
 * a thrown non-Error — falls through to `toFailure` unchanged.
 */
function apiFailure(err: unknown, label: string): ReadFailure {
  if (err instanceof ApiError && err.message.trim()) {
    console.error(`read failed: ${label}`, err)
    return { ok: false, code: failureCode(err), reason: err.message }
  }
  return toFailure(err, label)
}

/** `attempt`, with the server's own refusal preserved. For API reads only. */
async function readApi<T>(p: PromiseLike<T>, label: string): Promise<ReadResult<T>> {
  try {
    return ok(await p)
  } catch (err) {
    return apiFailure(err, label)
  }
}

/** Credit facts the API returns that `PartnerCredit` does not spell out. */
interface CreditEvent {
  at?: string
  event?: string
  coins?: number
  due_at?: string | null
  card_id?: string
  by?: { name?: string }
}

// ══════════════════════════════════════════════════════════════════════════════

export default function SellerDashboardPage() {
  const { crmUser, apiUser, apiError, loading: authLoading } = useAuth()

  // Two identities answer here and they answer different questions. The
  // Firestore role says which dashboard this login owns; the API identity is
  // the one every call below is actually made as.
  const holdsSellerRole = partnerRolesOf(crmUser).includes('seller')
  const crmSellerId = partnerRecordId(crmUser, 'seller')
  const isApiPartner = apiUser?.role === 'seller' || apiUser?.role === 'agency'

  const [partner, setPartner] = useState<Partner | null>(null)
  const [fatal, setFatal] = useState('')
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState<Tab>('everything')
  const [buying, setBuying] = useState(false)
  const [selling, setSelling] = useState(false)

  const [gate, setGate] = useState<ReadResult<{ allowed: boolean; reason: string }> | null>(null)
  const [statement, setStatement] = useState<ReadResult<SellerStatement> | null>(null)
  const [cards, setCards] = useState<ReadResult<PartnerCard[]> | null>(null)
  const [sales, setSales] = useState<ReadResult<Sale[]> | null>(null)
  const [profile, setProfile] = useState<ReadResult<SellerDoc | null> | null>(null)
  const [recharges, setRecharges] = useState<ReadResult<RechargeRequest[]> | null>(null)
  const [legacy, setLegacy] = useState<ReadResult<CoinPurchaseRequest[]> | null>(null)

  const load = useCallback(async () => {
    setFatal('')
    let record: Partner
    try {
      record = await resolveOwnSellerRecord(crmSellerId)
    } catch (e) {
      setFatal(
        e instanceof ApiError
          ? e.message
          : 'Your coin-seller record could not be read.',
      )
      setLoading(false)
      return
    }

    setPartner(record)
    setLoading(false)

    const id = record.id

    // Additive from here: one panel failing must never blank the record, and a
    // refused read is never rendered as a zero.
    //
    // These four are HTTP calls, so they go through `readApi` and keep the
    // server's own sentence. The three Firestore reads below stay on `attempt`,
    // where the database vocabulary is the accurate one.
    readApi(statements.seller(id), 'seller statement').then(setStatement)
    readApi(statements.canTakeInventory(id), 'inventory gate').then(setGate)
    readApi(board.list(BOARD_LIMIT), 'my cards').then((r) =>
      setCards(
        r.ok
          ? ok(
              r.value.filter(
                (c) => SELLER_CARD_TYPES.has(c.type) && c.subject?.id === id,
              ),
            )
          : r,
      ),
    )
    readApi(api.partnerOps.listSales({ limit: 100 }), 'my sales').then(setSales)

    // Firestore — contact details, QR code and the two legacy queues. Read,
    // never written. The Android app reads the same documents.
    // The document id first, and `crm_id` only as a fallback QUERY — never as
    // an id. This read was `record.crm_id || crmSellerId || id`, so a seller
    // that has a `crmId` — which is all of them — never had their real id
    // tried: `getDoc(doc(db,'sellers','3X4H3PD7'))` finds nothing, and the
    // Profile tab reported "No profile document was found for this seller id"
    // while the document sat in Firestore with their phone and email in it.
    //
    // Their own portal was the last place still doing this. The owner's view of
    // the same seller was fixed and shows the contact details, which is how the
    // two came to disagree about the same record.
    const firestoreId = crmSellerId || id
    attempt(getSeller(firestoreId, record.crm_id), 'seller profile').then(setProfile)
    attempt(getSellerRechargeRequests(firestoreId), 'recharge history').then(setRecharges)
    attempt(getSellerCoinPurchases(firestoreId), 'legacy purchase requests').then(setLegacy)
  }, [crmSellerId])

  useEffect(() => {
    if (holdsSellerRole && apiUser) load()
  }, [holdsSellerRole, apiUser, load])

  // ── Who is asking ───────────────────────────────────────────────────────────

  if (authLoading) return <Loading label="Checking your account…" />

  if (!holdsSellerRole) return <Denied what="the coin-seller portal" />

  // The API session is a separate thing from the Firebase one and arrives
  // separately. Without it every figure below is unreadable — which is a
  // different state from "you have nothing".
  if (!apiUser) {
    return (
      <div className="max-w-3xl mx-auto px-1">
        <Header />
        <div className="bg-slate-900 border border-slate-800 rounded-xl mt-4 py-14 px-6 text-center">
          <Hourglass size={26} className="text-yellow-500/80 mx-auto mb-3" />
          <p className="text-yellow-300 text-sm font-medium">
            Your session with the business API has not arrived yet.
          </p>
          <p className="text-slate-500 text-sm mt-1 max-w-md mx-auto">
            {apiError ||
              'Your inventory, credit and statement all live behind it, so nothing can be shown until it does. Nothing is wrong with your account — reload in a moment.'}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Reload
          </button>
        </div>
      </div>
    )
  }

  if (!isApiPartner && !crmSellerId) {
    return (
      <div className="max-w-3xl mx-auto px-1">
        <Header />
        <div className="bg-slate-900 border border-slate-800 rounded-xl mt-4">
          <ErrorState message="This login is not linked to a coin-seller record, so there is nothing to show you. Ask us to link it." />
        </div>
      </div>
    )
  }

  if (loading) return <Loading label="Reading your record…" />

  if (fatal || !partner) {
    return (
      <div className="max-w-3xl mx-auto px-1">
        <Header />
        <div className="bg-slate-900 border border-slate-800 rounded-xl mt-4">
          <ErrorState
            message={fatal || 'No coin-seller record came back for this login.'}
            onRetry={() => { setLoading(true); load() }}
          />
        </div>
        <p className="text-slate-600 text-sm mt-3 px-1">
          If it says no record was found, your business record has not been
          created yet — that happens when the application is still being
          processed, or when registration could not reach us. Nothing has been
          lost and nothing you have paid is affected; ask us to check it.
        </p>
      </div>
    )
  }

  // ── The position ────────────────────────────────────────────────────────────

  /**
   * Why the credit figures below default to zero and that is not the lie this
   * page exists to avoid.
   *
   * `partner` is a read that **succeeded** — the page returns a fatal
   * `ErrorState` above if it did not, so nothing past this point is standing on
   * a refusal. Inside a partner record, an absent `credit` sub-document means
   * one thing only: no credit event has ever been executed against this seller.
   * `create_partner` writes the block at zero (services/partner_ops.py:473) and
   * every later movement is a `$inc`/`$push`, which would create it; and the
   * server itself resolves the same absence the same way —
   * `int(credit.get("outstanding", 0))` in `get_partner` (:2244) is what
   * computes the `credit_standing` this page prints beside the figure.
   *
   * So `?? 0` here is agreement with the server about a measured zero, not a
   * substitute for a measurement that was never taken. The reads that *can* be
   * refused — the statement, the gate, the card board — are `ReadResult`s and
   * are rendered as refusals wherever they fail.
   */
  const credit = partner.credit
  const outstanding = credit?.outstanding ?? 0
  const dueAt = statement?.ok ? statement.value.credit_due_at : credit?.due_at ?? null
  const standing: CreditStanding =
    (statement?.ok ? statement.value.credit_standing : undefined) ??
    partner.credit_standing ??
    standingOf(credit)
  const onHand = statement?.ok ? statement.value.coins_on_hand : partner.coins_on_hand
  const late = standing === 'overdue' ? daysOverdue(dueAt) : 0

  // The gate endpoint carries the reason. If it could not be read, the partner
  // record carries the same answer from the same service call, so the fallback
  // is another successful read rather than an assumption.
  const gateAnswer = gate?.ok ? gate.value : partner.can_take_inventory ?? null
  const blocked = gateAnswer ? !gateAnswer.allowed : partner.status !== 'approved'
  const blockReason =
    gateAnswer?.reason ||
    (partner.status !== 'approved'
      ? `Your seller account is ${partner.status}.`
      : '')

  const pending = partner.status !== 'approved'
  // A refused board read gives an empty list, and every banner derived from it
  // then simply does not render — which reads as "nothing is in flight". The
  // banner at the top of the page says otherwise; see `cards && !cards.ok`.
  const myCards = cards?.ok ? cards.value : []
  const purchases = myCards.filter((c) => c.type === 'seller_coin_purchase')
  const signedNotExecuted = purchases.filter((c) => c.stage === 'approved')
  const inFlight = purchases.filter(
    (c) => c.stage !== 'executed' && c.stage !== 'rejected' && c.stage !== 'failed',
  )

  return (
    <div className="max-w-5xl mx-auto px-1 pb-16">
      <Header
        name={partner.name || crmUser?.name || ''}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => { setLoading(true); load() }}
              className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
            >
              <RefreshCw size={14} /> Refresh
            </button>
            <button
              onClick={() => setBuying(true)}
              className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
            >
              <Wallet size={15} /> Buy inventory
            </button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className={`text-xs px-2 py-1 rounded ${STATUS_TONE[partner.status]}`}>
          {partner.status}
          {partner.status === 'approved' && !partner.is_active ? ' · suspended' : ''}
        </span>
        <span className={`text-xs px-2 py-1 rounded ${STANDING_TONE[standing]}`}>
          credit: {STANDING_LABEL[standing]}
        </span>
        {late > 0 && (
          <span className="text-red-300 text-xs">{late} days late</span>
        )}
        <span className="text-slate-600 text-xs font-mono break-all">{partner.id}</span>
      </div>

      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      {/* A pending seller is told exactly what that means for them. */}
      {pending && (
        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/40 rounded-xl px-4 py-3 mb-4">
          <Clock size={16} className="text-amber-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-amber-100 text-sm font-semibold">
              Your seller account is {partner.status}.
            </p>
            <p className="text-amber-100/85 text-sm mt-0.5">
              {partner.status === 'rejected'
                ? partner.rejection_reason ||
                  'No reason was recorded against your record. Ask us before reapplying.'
                : 'Until it is approved you cannot buy or borrow inventory, and nothing here will show stock. Your record exists and holds nothing — that is a zero we have measured, not a read we could not make.'}
            </p>
          </div>
        </div>
      )}

      {blocked && !pending && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3 mb-4">
          <Ban size={16} className="text-red-400 mt-0.5 shrink-0" />
          <div>
            <p className="text-red-200 text-sm font-semibold">
              You cannot take new inventory at the moment.
            </p>
            <p className="text-red-100/85 text-sm mt-0.5">{blockReason}</p>
            <p className="text-red-100/60 text-sm mt-1">
              This is the API&rsquo;s own rule, not a screen. A purchase request
              would be refused with the same sentence.
            </p>
          </div>
        </div>
      )}

      {gate && !gate.ok && !partner.can_take_inventory && (
        <Warning>
          Whether you may take new inventory could not be read — {gate.reason}{' '}
          Treat the Buy button as unanswered rather than allowed.
        </Warning>
      )}

      {/* The two banners under this one — "in progress" and "signed but not
          executed" — are counts taken from the card board. When that read is
          refused they are both zero and both simply vanish, and a seller reads
          their absence as "nothing of mine is waiting". It is the one place on
          this page where a refusal is silent rather than merely blank, so it is
          said out loud before either of them would have appeared. */}
      {cards && !cards.ok && (
        <Warning>
          Your cards could not be read — {cards.reason} Nothing below counts what
          you have raised or what has been raised about you, so anything signed
          but not yet executed is <strong>not</strong> being shown to you. This
          is not &ldquo;you have none&rdquo;.
        </Warning>
      )}

      {signedNotExecuted.length > 0 && (
        <Warning>
          {signedNotExecuted.length} of your purchases{' '}
          {signedNotExecuted.length === 1 ? 'has' : 'have'} been signed by an
          owner but not executed. <strong>Those coins do not exist yet</strong> —
          your stock below is unchanged until they are.
        </Warning>
      )}

      {/* ── Position ───────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {/* `onHand` is undefined only when BOTH readings of it are missing: the
            statement did not answer and the partner record carried no
            `coins_on_hand`. A bare dash there reads as "nothing", so when the
            statement is the reason it is named as the reason. */}
        <Stat
          label="Coins in stock"
          value={
            onHand !== undefined ? (
              coinText(onHand)
            ) : statement && !statement.ok ? (
              <Unavailable failure={statement} what="coins in stock" />
            ) : (
              <span className="text-slate-500">—</span>
            )
          }
          hint={
            onHand !== undefined
              ? 'The ledger balance, not a copy of it.'
              : statement && !statement.ok
                ? undefined
                : 'Your balance was not attached to this record. This is not zero.'
          }
        />
        <Stat
          label="Credit outstanding"
          value={outstanding > 0 ? coinText(outstanding) : coinText(0)}
          tone={outstanding > 0 ? 'text-amber-300' : 'text-slate-400'}
          hint={outstanding > 0 ? 'Coins you owe us.' : 'Nothing on the book.'}
        />
        <Stat
          label="Due"
          value={
            outstanding > 0 ? (
              <span className={late > 0 ? 'text-red-300' : 'text-white'}>{when(dueAt)}</span>
            ) : (
              <span className="text-slate-500">—</span>
            )
          }
          hint={
            outstanding <= 0
              ? 'No credit, so no due date.'
              : late > 0
                ? `${late} days past due.`
                : dueAt
                  ? 'Clear it by this date.'
                  : 'No due date is recorded against this debt.'
          }
        />
        <Stat
          label="Paid us to date"
          value={
            statement === null ? (
              <span className="text-slate-500">…</span>
            ) : statement.ok ? (
              inr(statement.value.cash_paid_minor)
            ) : (
              <Unavailable failure={statement} what="cash paid" />
            )
          }
          hint={statement?.ok ? 'Cash for inventory, in rupees.' : undefined}
        />
      </div>

      {inFlight.length > 0 && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 mb-6">
          <p className="text-slate-300 text-sm font-medium">
            {inFlight.length} purchase{inFlight.length === 1 ? '' : 's'} in
            progress
          </p>
          <p className="text-slate-500 text-xs mt-0.5 mb-2">
            None of these has changed your stock yet.
          </p>
          <div className="space-y-2">
            {inFlight.slice(0, 3).map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-yellow-300 text-sm font-semibold">
                  {coinText(num(c.payload, 'coins') || c.amount)}
                </span>
                <StageTrack stage={c.stage} />
              </div>
            ))}
          </div>
        </div>
      )}

      <SecondRoleCard />

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 mb-4 overflow-x-auto -mx-1 px-1">
        {TABS.map(({ key, label, icon: Icon }) => (
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

      {/* The same component and the same endpoint the business owner reads on
          `/sellers/{id}`, scoped by the server to this login's own record. Two
          implementations of "what has happened on this account" would drift,
          and the seller's version disagreeing with ours is an argument neither
          side can win. It holds its own read, so a slow history never delays
          the position above. */}
      {tab === 'everything' && (
        <>
          <SellerHistoryPanel sellerId={partner.id} audience="seller" />
          {/* B9: margin, borrowing, trades with other sellers, and self-use. */}
          <SellerBusinessPanel sellerId={partner.id} audience="seller" />
        </>
      )}

      {tab === 'purchases' && (
        <PurchasesTab
          cards={cards}
          legacy={legacy}
          van={partner.virtual_account}
          onRetry={() => load()}
          onBuy={() => setBuying(true)}
          blocked={blocked}
        />
      )}

      {tab === 'statement' && (
        <StatementTab statement={statement} onRetry={() => load()} />
      )}

      {tab === 'credit' && <CreditTab partner={partner} standing={standing} late={late} />}

      {tab === 'sales' && (
        <SalesTab
          sales={sales}
          recharges={recharges}
          onFile={() => setSelling(true)}
          canFile={!pending && partner.is_active}
        />
      )}

      {tab === 'profile' && (
        <ProfileTab
          partner={partner}
          profile={profile}
          onProfileChange={(next) => setProfile(ok(next))}
        />
      )}

      {buying && (
        <BuyInventoryDialog
          sellerId={partner.id}
          sellerName={partner.name || partner.id}
          blocked={blocked}
          blockReason={blockReason}
          onClose={() => setBuying(false)}
          onRaised={() => {
            setNotice(
              'Your request is on the money board. Nothing has been credited — it is verified, then signed, then executed, and only the last of those creates coins.',
            )
            load()
          }}
        />
      )}

      {selling && (
        <FileSaleDialog
          sellerId={partner.id}
          // Not `?? 0`. Zero here printed "You hold 🪙 0 coins" in the dialog
          // header and turned every entered figure into "more than the 0 you
          // hold" — a refused statement read rendered as an empty inventory, to
          // the one person who would act on believing it. The dialog now takes
          // the absence and says what it is.
          onHand={onHand}
          onHandFailure={statement && !statement.ok ? statement : undefined}
          onClose={() => setSelling(false)}
          onFiled={() => {
            setNotice('Sale filed. Nothing has moved until an owner approves it.')
            load()
          }}
        />
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Identity
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The caller's own seller record.
 *
 * `me` is resolved by `_own_id_or_403` (routers/partner_ops.py:70) into
 * whatever the session is linked to, which is the id to trust: if the Firestore
 * document id and the session's link ever disagree, the Firestore one is a 403
 * and `me` is right.
 *
 * A login that holds both capabilities resolves to one record, and it may be
 * the agency one — in which case the seller record is asked for by its own id
 * and the API decides whether that is allowed. Its refusal is shown verbatim
 * rather than translated.
 */
async function resolveOwnSellerRecord(crmSellerId: string): Promise<Partner> {
  let own: Partner | null = null
  let firstError: unknown = null
  try {
    own = await partnerOps.get(OWN_RECORD)
  } catch (e) {
    firstError = e
  }

  if (own && own.kind === 'seller') return own
  if (crmSellerId) return partnerOps.get(crmSellerId)
  if (own) {
    throw new ApiError(
      `Your API session is linked to a ${own.kind} record, not a coin-seller one, and this login has no seller id on it. Ask us to link the two.`,
      409,
    )
  }
  throw firstError
}

// ══════════════════════════════════════════════════════════════════════════════
// Purchases
// ══════════════════════════════════════════════════════════════════════════════

function PurchasesTab({
  cards,
  legacy,
  van,
  onRetry,
  onBuy,
  blocked,
}: {
  cards: ReadResult<PartnerCard[]> | null
  legacy: ReadResult<CoinPurchaseRequest[]> | null
  /** undefined means the record did not carry one — NOT that none is issued. */
  van: VirtualAccount | undefined
  onRetry: () => void
  onBuy: () => void
  blocked: boolean
}) {
  const stale = legacy?.ok ? legacy.value.filter((r) => r.status === 'pending') : []

  return (
    <div className="space-y-4">
      <VirtualAccountPanel van={van} />

      <Panel title="Your cards" icon={<Package size={15} />}>
        {cards === null ? (
          <Loading label="Reading your cards…" />
        ) : !cards.ok ? (
          <UnavailablePanel failure={cards} what="Your cards" onRetry={onRetry} />
        ) : cards.value.length === 0 ? (
          <Empty
            title="Nothing on your account yet"
            hint="A request to buy inventory appears here the moment you raise it — and so does anything our team raises about your credit. Each one stays until an owner executes it."
            icon={<Package size={26} />}
            action={
              !blocked && (
                <button
                  onClick={onBuy}
                  className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
                >
                  <Wallet size={14} /> Buy inventory
                </button>
              )
            }
          />
        ) : (
          <div className="p-3 sm:p-4 space-y-3">
            {cards.value.map((c) => (
              <CardRow key={c.id} card={c} />
            ))}
          </div>
        )}
      </Panel>

      <p className="text-slate-600 text-xs px-1">
        Everything on your account is listed — what you raised, and what our team
        raised about you: credit issued to you, a repayment, a recovery, a
        write-off. You can see one from the moment it is raised, which matters
        most before it is executed, because until then it has not reached your
        statement at all. Nothing about any other seller is on this list, and the
        person here who raised or signed each one is not named.
      </p>

      {/* The old queue. Read-only, and honest about what happened to it. */}
      {legacy && (!legacy.ok || stale.length > 0) && (
        <Panel title="Submitted before this portal used the API" icon={<AlertTriangle size={15} />}>
          {!legacy.ok ? (
            <UnavailablePanel failure={legacy} what="Your older requests" />
          ) : (
            <div className="p-4 space-y-3">
              <p className="text-amber-200 text-sm">
                These {stale.length === 1 ? 'request was' : 'requests were'} written
                to a collection that no staff screen reads, so{' '}
                {stale.length === 1 ? 'it' : 'they'} never reached the money board
                and no coins were ever credited from{' '}
                {stale.length === 1 ? 'it' : 'them'}.
              </p>
              <p className="text-slate-500 text-sm">
                If you have paid against one of these, send us the reference — it
                can be turned into a real card from our side. Nothing here is
                deleted or rewritten.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-800">
                      <Th>Coins</Th>
                      <Th>Stated</Th>
                      <Th hideOnMobile>Reference</Th>
                      <Th align="right">Submitted</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {stale.map((r) => (
                      <tr key={r.id} className="border-b border-slate-800/60 last:border-0">
                        <td className="px-3 sm:px-5 py-3 text-sm text-yellow-300 font-semibold whitespace-nowrap">
                          {legacyAmount(r.coinsRequested, coinText)}
                        </td>
                        <td className="px-3 sm:px-5 py-3 text-sm text-slate-300 whitespace-nowrap">
                          {legacyAmount(r.amountPaid, (n) =>
                            `${r.currency === 'USD' ? '$' : '₹'}${n.toLocaleString('en-IN')}`,
                          )}
                        </td>
                        <td className="px-3 sm:px-5 py-3 text-xs text-slate-500 font-mono hidden sm:table-cell break-all">
                          {r.transactionRef || '—'}
                        </td>
                        <td className="px-3 sm:px-5 py-3 text-xs text-slate-500 text-right whitespace-nowrap">
                          {r.createdAt ? whenExact(r.createdAt.toDate().toISOString()) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Panel>
      )}
    </div>
  )
}

/**
 * The seller's own permanent virtual account number. Spec 4.3.4 / 8C.1.4 —
 * "assigned a permanent VAN on approval … it appears in their portal".
 *
 * Three states, and the second one is the live one today:
 *
 *   1. **Issued.** The number, the IFSC and the beneficiary name a payer must
 *      see, each copyable, because these get typed into a banking app and a
 *      digit dropped by hand is a payment that bounces.
 *   2. **Not issued.** The server's own sentence, verbatim. It says there is no
 *      HDFC eCMS collection account yet and that payments carry on as they do —
 *      which is true and is the whole point of showing it. A blank field or a
 *      dash here would read as "we lost your account number".
 *   3. **Not read.** The record came back without the field at all. That is a
 *      different fact from "none issued" and is never rendered as one.
 *
 * Whichever state it is in, the pay-and-send-a-reference flow underneath is
 * untouched: Buy inventory still asks for the amount, the UTR and the proof.
 */
function VirtualAccountPanel({ van }: { van: VirtualAccount | undefined }) {
  if (!van) {
    return (
      <Panel title="Your payment account" icon={<Landmark size={15} />}>
        <div className="p-4 sm:p-5">
          <p className="text-yellow-300 text-sm font-medium">
            Whether you have a virtual account number could not be read.
          </p>
          <p className="text-slate-400 text-sm mt-1">
            That is a read that did not answer, not an answer of &ldquo;none&rdquo;.
            Refresh, and ask us if it keeps saying this. Nothing about how you pay
            changes either way — keep using the Buy inventory button below.
          </p>
        </div>
      </Panel>
    )
  }

  if (!van.issued) {
    return (
      <Panel title="Your payment account" icon={<Landmark size={15} />}>
        <div className="p-4 sm:p-5">
          <p className="text-slate-300 text-sm font-medium">
            No virtual account number has been issued to you.
          </p>
          {/* The server's sentence, verbatim. It names the reason — an eCMS
              collection account needs a business current account — and it is
              the same sentence our own staff see on your record. */}
          <p className="text-slate-400 text-sm mt-1.5 leading-relaxed">{van.reason}</p>
          <p className="text-slate-500 text-sm mt-3">
            So pay us the way you do now: transfer the money, then use{' '}
            <strong className="text-slate-300">Buy inventory</strong> and give us
            the reference and a screenshot. That is the live route and it is not
            going anywhere.
          </p>
        </div>
      </Panel>
    )
  }

  return (
    <Panel title="Your payment account" icon={<Landmark size={15} />}>
      <div className="p-4 sm:p-5 space-y-4">
        <p className="text-slate-400 text-sm">
          This account is yours permanently. Money paid into it identifies you
          automatically, so you do not have to type a reference or send a
          screenshot for us to know it came from you.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <CopyableField label="Account number" value={van.number ?? ''} mono />
          <CopyableField label="IFSC" value={van.ifsc} mono />
          <CopyableField label="Account name" value={van.beneficiary_name} />
        </div>
        <p className="text-slate-600 text-xs">
          Issued {when(van.issued_at)}. Add it as a payee once and use it every
          time — NEFT, RTGS, IMPS or UPI all work.
        </p>
      </div>
    </Panel>
  )
}

/**
 * A value somebody is going to retype into a banking app.
 *
 * Copyable rather than merely selectable, and shown in full rather than
 * truncated, because a dropped digit in an account number is a payment that
 * bounces or — worse — reaches somebody else.
 */
function CopyableField({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  const [copied, setCopied] = useState(false)

  if (!value) {
    return (
      <div>
        <p className="text-slate-500 text-xs">{label}</p>
        <p className="text-slate-600 text-sm">not recorded</p>
      </div>
    )
  }

  return (
    <div className="min-w-0">
      <p className="text-slate-500 text-xs">{label}</p>
      <div className="flex items-start gap-2">
        <p className={`text-white text-sm break-all ${mono ? 'font-mono' : ''}`}>
          {value}
        </p>
        <button
          onClick={() => {
            navigator.clipboard.writeText(value).then(
              () => { setCopied(true); setTimeout(() => setCopied(false), 2000) },
              () => { /* it is on the screen either way */ },
            )
          }}
          className="text-slate-400 hover:text-white shrink-0 mt-0.5"
          aria-label={`Copy ${label}`}
        >
          {copied ? <CheckCircle2 size={13} className="text-green-400" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  )
}


function CardRow({ card }: { card: PartnerCard }) {
  const coins = num(card.payload, 'coins') || card.amount
  const minor = num(card.payload, 'amount_paid_minor')
  const ref = str(card.payload, 'payment_ref')
  const proof = proofUrl(card)

  return (
    <div className="bg-slate-950/40 border border-slate-800 rounded-xl p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-white text-sm font-medium">
            {CARD_LABEL[card.type] ?? card.type.replace(/_/g, ' ')}
            <span className="text-yellow-300 font-semibold ml-2">{coinText(coins)}</span>
          </p>
          <p className="text-slate-500 text-xs mt-0.5 break-words">{card.reason}</p>
          <p className="text-slate-600 text-xs mt-0.5">{ageOf(card.created_at)}</p>
        </div>
        <span className={`text-xs px-2 py-1 rounded shrink-0 ${STAGE_TONE[card.stage]}`}>
          {STAGE_LABEL[card.stage]}
        </span>
      </div>

      <div className="mt-3">
        <StageTrack stage={card.stage} />
      </div>

      <p
        className={`text-sm mt-2 ${
          card.stage === 'approved'
            ? 'text-amber-200'
            : card.stage === 'executed'
              ? 'text-green-300'
              : 'text-slate-400'
        }`}
      >
        {STAGE_MEANING[card.stage]}
      </p>

      {/* A purchase carries what you paid, the reference and the proof. A card
          our team raised about your credit carries none of those — showing it
          "You stated ₹0" with an em dash for a reference would be describing a
          payment that was never part of it. Each type shows its own facts. */}
      {card.type === 'seller_coin_purchase' ? (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3 pt-3 border-t border-slate-800">
          <div>
            <dt className="text-slate-500 text-xs">Stated as paid</dt>
            <dd className="text-slate-200 text-sm">{inr(minor)}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-slate-500 text-xs">Reference</dt>
            <dd className="text-slate-200 text-xs font-mono break-all">{ref || '—'}</dd>
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
                <span className="text-slate-600 text-xs">none</span>
              )}
            </dd>
          </div>
        </dl>
      ) : (
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3 pt-3 border-t border-slate-800">
          <div>
            <dt className="text-slate-500 text-xs">Raised by</dt>
            <dd className="text-slate-200 text-sm">Zipper</dd>
          </div>
          {card.type === 'lending_issue' && (
            <div>
              <dt className="text-slate-500 text-xs">Due</dt>
              <dd className="text-slate-200 text-sm">
                {when(str(card.payload, 'due_at')) || '—'}
              </dd>
            </div>
          )}
          {card.type === 'lending_recover' && num(card.payload, 'penalty_coins') > 0 && (
            <div>
              <dt className="text-slate-500 text-xs">Of which penalty</dt>
              <dd className="text-amber-300 text-sm">
                {coinText(num(card.payload, 'penalty_coins'))}
              </dd>
            </div>
          )}
          {ref && (
            <div className="min-w-0">
              <dt className="text-slate-500 text-xs">Reference</dt>
              <dd className="text-slate-200 text-xs font-mono break-all">{ref}</dd>
            </div>
          )}
        </dl>
      )}

      {card.verified_by && (
        <p className="text-slate-500 text-xs mt-2 flex items-center gap-1.5">
          <CheckCircle2 size={11} /> Verified {when(card.verified_at)}
        </p>
      )}
      {card.stage === 'approved' && (
        <p className="text-amber-200/85 text-xs mt-1 flex items-center gap-1.5">
          <ShieldCheck size={11} /> Signed {when(card.signed_at)} — not executed.
        </p>
      )}
      {card.stage === 'executed' && (
        <p className="text-green-300 text-xs mt-1 flex items-center gap-1.5">
          <CheckCircle2 size={11} /> Credited {when(card.executed_at)}.
        </p>
      )}
      {card.stage === 'rejected' && (
        <p className="text-red-300 text-xs mt-1">
          {card.rejection_reason || 'No reason was recorded on the card.'}
        </p>
      )}
      {card.warning && (
        <p className="flex items-start gap-2 mt-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-amber-100 text-xs">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {card.warning}
        </p>
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Statement
// ══════════════════════════════════════════════════════════════════════════════

type Preset = '30' | '90' | 'all' | 'custom'

const PRESETS: { key: Preset; label: string }[] = [
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
  { key: 'all', label: 'Everything read' },
  { key: 'custom', label: 'Choose dates' },
]

function StatementTab({
  statement,
  onRetry,
}: {
  statement: ReadResult<SellerStatement> | null
  onRetry: () => void
}) {
  const [preset, setPreset] = useState<Preset>('30')
  const [from, setFrom] = useState(() => dateInputValue(new Date(Date.now() - 30 * 864e5)))
  const [to, setTo] = useState(() => dateInputValue(new Date()))

  const bounds = useMemo(() => {
    if (preset === 'all') return { from: null as number | null, to: null as number | null }
    if (preset === 'custom') {
      const f = from ? new Date(`${from}T00:00:00`).getTime() : null
      const t = to ? new Date(`${to}T23:59:59.999`).getTime() : null
      return { from: Number.isNaN(f as number) ? null : f, to: Number.isNaN(t as number) ? null : t }
    }
    const days = Number(preset)
    return { from: Date.now() - days * 864e5, to: null as number | null }
  }, [preset, from, to])

  if (statement === null) return <Loading label="Reading your statement…" />

  if (!statement.ok) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl">
        <UnavailablePanel failure={statement} what="Your statement" onRetry={onRetry} />
      </div>
    )
  }

  const s = statement.value
  const entries = s.entries as LedgerEntry[]
  const truncated = entries.length >= STATEMENT_LIMIT

  const inWindow = entries.filter((e) => {
    const t = typeof e.at === 'string' ? new Date(e.at).getTime() : NaN
    if (Number.isNaN(t)) return bounds.from === null && bounds.to === null
    if (bounds.from !== null && t < bounds.from) return false
    if (bounds.to !== null && t > bounds.to) return false
    return true
  })

  const totalFor = (action: string, sign: 1 | -1) =>
    inWindow
      .filter((e) => e.action === action)
      .reduce((sum, e) => sum + (typeof e.amount === 'number' ? e.amount : 0), 0) * sign

  const bought = totalFor('inventory.credit', 1)
  const borrowed = totalFor('lending.issue', 1)
  const sold = totalFor('inventory.debit', -1)
  const recovered = totalFor('lending.recover', -1)

  return (
    <div className="space-y-4">
      <Panel
        title="Statement"
        icon={<FileText size={15} />}
        aside={
          <span className="text-slate-500 text-xs">
            {inWindow.length} of {entries.length} movements
          </span>
        }
      >
        <div className="p-4 sm:p-5 space-y-4">
          {/* Period */}
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPreset(p.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  preset === p.key
                    ? 'border-pink-500 bg-pink-500/10 text-pink-200'
                    : 'border-slate-700 text-slate-400 hover:border-slate-600'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-500 text-xs mb-1">From</label>
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
                />
              </div>
              <div>
                <label className="block text-slate-500 text-xs mb-1">To</label>
                <input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat label="Bought" value={coinText(bought)} tone="text-green-300" />
            <Stat label="Borrowed" value={coinText(borrowed)} tone="text-amber-300" />
            <Stat label="Sold" value={coinText(sold)} tone="text-slate-300" />
            <Stat
              label="Recovered by us"
              value={coinText(recovered)}
              tone={recovered > 0 ? 'text-red-300' : 'text-slate-500'}
            />
          </div>

          <p className="text-slate-500 text-sm">
            In this window. Coins only — a repayment does not appear here because
            it does not move coins; it reduces what you owe, and that is under{' '}
            <strong className="text-slate-300">Credit</strong>. Nothing here
            carries a rupee figure or a payment reference either: both live on the
            card. For all of it in one list — purchases with what you paid and the
            reference you gave, your repayments, and every sale you filed — use{' '}
            <strong className="text-slate-300">Everything</strong>. Life to date
            you hold {coinText(s.coins_on_hand)} and have paid us{' '}
            {inr(s.cash_paid_minor)} in cash for inventory.
          </p>

          {truncated && (
            <Warning>
              This statement is the most recent {STATEMENT_LIMIT} movements —
              the maximum the endpoint returns without a limit. Anything older
              than that is not in the totals above, so a long window may
              understate. Ask us for the full ledger if you need it.
            </Warning>
          )}
        </div>

        {inWindow.length === 0 ? (
          <Empty
            title="No movements in this period"
            hint="Widen the dates, or choose Everything read."
            icon={<Coins size={26} />}
          />
        ) : (
          <div className="overflow-x-auto border-t border-slate-800">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  <Th>What</Th>
                  <Th hideOnMobile>When</Th>
                  <Th align="right">Coins</Th>
                  <Th align="right" hideOnMobile>After</Th>
                </tr>
              </thead>
              <tbody>
                {inWindow.map((e, i) => {
                  const amount = typeof e.amount === 'number' ? e.amount : 0
                  const action = typeof e.action === 'string' ? e.action : ''
                  const at = typeof e.at === 'string' ? e.at : ''
                  const after = typeof e.balance_after === 'number' ? e.balance_after : null
                  return (
                    <tr key={(typeof e.id === 'string' ? e.id : '') || i} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-3 sm:px-5 py-3">
                        <p className="text-slate-200 text-sm">
                          {ACTION_LABEL[action] ?? action.replace(/[._]/g, ' ') ?? ''}
                        </p>
                        <p className="text-slate-600 text-xs break-words">
                          {typeof e.reason === 'string' ? e.reason : ''}
                        </p>
                        <p className="text-slate-700 text-xs sm:hidden">{whenExact(at)}</p>
                      </td>
                      <td className="px-3 sm:px-5 py-3 text-xs text-slate-500 hidden sm:table-cell whitespace-nowrap">
                        {whenExact(at)}
                      </td>
                      <td
                        className={`px-3 sm:px-5 py-3 text-sm font-semibold text-right whitespace-nowrap ${
                          amount >= 0 ? 'text-green-300' : 'text-slate-400'
                        }`}
                      >
                        {amount >= 0 ? '+' : ''}
                        {amount.toLocaleString('en-IN')}
                      </td>
                      <td className="px-3 sm:px-5 py-3 text-xs text-slate-500 text-right hidden sm:table-cell whitespace-nowrap">
                        {after === null ? '—' : after.toLocaleString('en-IN')}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Credit
// ══════════════════════════════════════════════════════════════════════════════

function CreditTab({
  partner,
  standing,
  late,
}: {
  partner: Partner
  standing: CreditStanding
  late: number
}) {
  // `credit.history` is written by every credit execution (services/partner_ops.py
  // — `$push credit.history` at :1596, :1700, :1855) and comes back untouched on
  // the partner record. `PartnerCredit` in lib/apiPartners does not name it, so
  // it is read through one narrow cast here rather than with `any` anywhere.
  //
  // Every default below is a measured zero, not a substituted one. `partner`
  // reached this component only because its read succeeded, and inside it an
  // absent `credit` block means no credit event has ever executed against this
  // seller: the record is created with the block at zero and every movement is
  // an `$inc` or a `$push`, either of which would materialise the field. The
  // server reads the same absence the same way. See the note at the head of
  // `SellerDashboardPage`.
  //
  // `history ?? []` is the same fact in list form, and the `Empty` it produces
  // says exactly that — "No credit has been issued to you" — which is true. It
  // is never reached by a failed read, because there is no separate read here to
  // fail.
  const credit = partner.credit as (PartnerCredit & { history?: CreditEvent[] }) | undefined
  const outstanding = credit?.outstanding ?? 0
  const history = credit?.history ?? []
  const terms = credit?.terms ?? ''

  return (
    <div className="space-y-4">
      <Panel title="What you owe" icon={<CreditCard size={15} />}>
        <div className="p-4 sm:p-5 space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Stat
              label="Outstanding"
              value={coinText(outstanding)}
              tone={outstanding > 0 ? 'text-amber-300' : 'text-slate-400'}
            />
            <Stat
              label="Due"
              value={outstanding > 0 ? when(credit?.due_at) : '—'}
              tone={late > 0 ? 'text-red-300' : 'text-white'}
              hint={late > 0 ? `${late} days past due` : STANDING_LABEL[standing]}
            />
            <Stat label="Lent to you" value={coinText(credit?.total_lent ?? 0)} tone="text-slate-300" />
            <Stat label="Repaid" value={coinText(credit?.total_repaid ?? 0)} tone="text-green-300" />
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <Stat
              label="Recovered from your stock"
              value={coinText(credit?.total_recovered ?? 0)}
              tone={(credit?.total_recovered ?? 0) > 0 ? 'text-red-300' : 'text-slate-500'}
            />
            <Stat
              label="Penalty added"
              value={coinText(credit?.total_penalty ?? 0)}
              tone={(credit?.total_penalty ?? 0) > 0 ? 'text-red-300' : 'text-slate-500'}
            />
            <Stat
              label="Written off"
              value={coinText(credit?.total_written_off ?? 0)}
              tone="text-slate-500"
            />
          </div>

          {standing === 'overdue' && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3">
              <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-red-200 text-sm font-semibold">
                  This debt is {late} days past its due date.
                </p>
                <p className="text-red-100/85 text-sm mt-0.5">
                  While it is overdue you are blocked from taking new inventory,
                  and we may recover the debt directly from the coins you hold.
                </p>
              </div>
            </div>
          )}

          {standing === 'due_soon' && (
            <Warning>
              This is due on {when(credit?.due_at)}. Past that date you are
              blocked from new inventory automatically.
            </Warning>
          )}

          <div className="bg-slate-950/40 border border-slate-800 rounded-xl p-4">
            <h3 className="text-white text-sm font-semibold">If you are late</h3>
            {terms ? (
              <p className="text-slate-300 text-sm mt-1 whitespace-pre-wrap break-words">{terms}</p>
            ) : (
              <p className="text-slate-500 text-sm mt-1">
                No specific terms are recorded against your credit.
              </p>
            )}
            <ul className="text-slate-400 text-sm mt-3 space-y-1.5 list-disc pl-5">
              <li>
                Past the due date the debt is <strong>overdue</strong> and new
                inventory is blocked until it is cleared.
              </li>
              <li>
                We can recover the debt from the coins you are holding — up to and
                including all of them.
              </li>
              <li>
                A recovery can be <strong>more</strong> than the original debt,
                because a late penalty is part of it. The split is shown on the
                card before an owner signs it.
              </li>
              <li>
                If your stock does not cover it, the shortfall stays owed. It is
                never quietly cancelled.
              </li>
            </ul>
          </div>

          <p className="text-slate-500 text-sm">
            Nothing on this page changes any of these figures. Credit is issued,
            repaid, recovered and written off by cards our team raises and an
            owner signs — talk to us to arrange one.
          </p>
        </div>
      </Panel>

      <Panel title="Credit history" icon={<Clock size={15} />}>
        {history.length === 0 ? (
          <Empty
            title="No credit has been issued to you"
            hint="Every issue, repayment, recovery and write-off is recorded here with its date."
            icon={<CreditCard size={26} />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  <Th>Event</Th>
                  <Th align="right">Coins</Th>
                  <Th hideOnMobile align="right">Due</Th>
                  <Th align="right">When</Th>
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map((h, i) => (
                  <tr key={`${h.card_id ?? ''}-${i}`} className="border-b border-slate-800/60 last:border-0">
                    <td className="px-3 sm:px-5 py-3 text-sm text-slate-200 capitalize">
                      {(h.event ?? '—').replace(/_/g, ' ')}
                    </td>
                    {/* `coins` is written on every one of the four history
                        pushes the server makes (services/partner_ops.py:2506,
                        :2610, :2763, :2856), so this default is unreachable
                        belt-and-braces rather than a stand-in for a read. */}
                    <td className="px-3 sm:px-5 py-3 text-sm text-slate-200 text-right whitespace-nowrap">
                      {coinText(h.coins ?? 0)}
                    </td>
                    <td className="px-3 sm:px-5 py-3 text-xs text-slate-500 text-right hidden sm:table-cell whitespace-nowrap">
                      {h.due_at ? when(h.due_at) : '—'}
                    </td>
                    <td className="px-3 sm:px-5 py-3 text-xs text-slate-500 text-right whitespace-nowrap">
                      {when(h.at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Sales
// ══════════════════════════════════════════════════════════════════════════════

const SALE_TONE: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-300',
  approved: 'bg-green-500/15 text-green-300',
  failed: 'bg-red-500/20 text-red-300',
}

function SalesTab({
  sales,
  recharges,
  onFile,
  canFile,
}: {
  sales: ReadResult<Sale[]> | null
  recharges: ReadResult<RechargeRequest[]> | null
  onFile: () => void
  canFile: boolean
}) {
  // B1: buyers are Firebase uids. A seller may know a buyer's NAME (the public
  // profile) but has no right to their email or phone — never shown here.
  const buyers = useIdentities({ publicPeople: sales?.ok ? sales.value.map((s) => s.buyer_uid) : [] })
  return (
    <div className="space-y-4">
      <Panel
        title="Sales you filed"
        icon={<Gem size={15} />}
        aside={
          canFile && (
            <button
              onClick={onFile}
              className="flex items-center gap-1.5 bg-yellow-500 hover:bg-yellow-400 text-black font-semibold rounded-lg px-3 py-1.5 text-xs transition-colors"
            >
              <Gem size={12} /> File a sale
            </button>
          )
        }
      >
        {sales === null ? (
          <Loading label="Reading your sales…" />
        ) : !sales.ok ? (
          <UnavailablePanel failure={sales} what="Your sales" />
        ) : sales.value.length === 0 ? (
          <Empty
            title="No sales filed yet"
            hint="Filing a sale moves nothing. An owner approves it, and that is when your inventory comes down and the buyer's diamonds go up."
            icon={<Gem size={26} />}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  <Th>Buyer</Th>
                  <Th align="right">Diamonds</Th>
                  <Th align="right" hideOnMobile>Taken</Th>
                  <Th align="right">Status</Th>
                </tr>
              </thead>
              <tbody>
                {sales.value.map((s) => (
                  <tr key={s.id} className="border-b border-slate-800/60 last:border-0">
                    <td className="px-3 sm:px-5 py-3">
                      <IdentityBlock
                        facts={buyers.publicPeople.get(s.buyer_uid)}
                        id={s.buyer_uid}
                        kind="buyer"
                        state={buyers.state}
                        className="text-xs"
                      />
                      <p className="text-slate-600 text-xs">{when(s.created_at)}</p>
                    </td>
                    <td className="px-3 sm:px-5 py-3 text-sm text-yellow-300 font-semibold text-right whitespace-nowrap">
                      {s.diamonds.toLocaleString('en-IN')}
                    </td>
                    <td className="px-3 sm:px-5 py-3 text-sm text-slate-300 text-right hidden sm:table-cell whitespace-nowrap">
                      {inr(s.amount_paid_minor)}
                    </td>
                    <td className="px-3 sm:px-5 py-3 text-right">
                      <span className={`text-xs px-2 py-1 rounded ${SALE_TONE[s.status] ?? 'bg-slate-700 text-slate-300'}`}>
                        {s.status === 'pending' ? 'awaiting approval' : s.status}
                      </span>
                      {s.failure && (
                        <p className="text-red-300 text-xs mt-1 max-w-xs ml-auto">{s.failure}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Recharge history" icon={<Clock size={15} />}>
        {recharges === null ? (
          <Loading label="Reading your recharge history…" />
        ) : !recharges.ok ? (
          <UnavailablePanel failure={recharges} what="Your recharge history" />
        ) : recharges.value.length === 0 ? (
          <Empty
            title="No recharge requests"
            hint="Recharges you sent through the old flow appear here."
            icon={<Gem size={26} />}
          />
        ) : (
          <>
            <p className="px-4 sm:px-5 py-3 text-slate-500 text-xs border-b border-slate-800">
              The old flow, kept so your history is not lost. It is read-only —
              new sales are filed through the API above, where an owner approves
              them and the movement lands in your statement.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-800">
                    <Th>Buyer</Th>
                    <Th align="right">Diamonds</Th>
                    <Th align="right" hideOnMobile>Taken</Th>
                    <Th align="right">Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {recharges.value.map((r) => (
                    <tr key={r.id} className="border-b border-slate-800/60 last:border-0">
                      <td className="px-3 sm:px-5 py-3">
                        <p className="text-slate-200 text-sm truncate">{r.buyerName || '—'}</p>
                        <p className="text-slate-600 text-xs">
                          {r.createdAt ? when(r.createdAt.toDate().toISOString()) : ''}
                        </p>
                      </td>
                      <td className="px-3 sm:px-5 py-3 text-sm text-yellow-300 font-semibold text-right whitespace-nowrap">
                        {legacyAmount(r.diamondPackage, (n) => n.toLocaleString('en-IN'))}
                      </td>
                      <td className="px-3 sm:px-5 py-3 text-sm text-slate-300 text-right hidden sm:table-cell whitespace-nowrap">
                        {legacyAmount(r.amountPaid, (n) => `₹${n.toLocaleString('en-IN')}`)}
                      </td>
                      <td className="px-3 sm:px-5 py-3 text-right">
                        <span
                          className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded ${
                            r.status === 'approved'
                              ? 'bg-green-500/15 text-green-300'
                              : r.status === 'rejected'
                                ? 'bg-red-500/15 text-red-300'
                                : 'bg-amber-500/15 text-amber-300'
                          }`}
                        >
                          {r.status === 'approved' ? (
                            <CheckCircle2 size={10} />
                          ) : r.status === 'rejected' ? (
                            <XCircle size={10} />
                          ) : (
                            <Clock size={10} />
                          )}
                          {r.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Panel>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// Profile
// ══════════════════════════════════════════════════════════════════════════════

function ProfileTab({
  partner,
  profile,
  onProfileChange,
}: {
  partner: Partner
  profile: ReadResult<SellerDoc | null> | null
  onProfileChange: (next: SellerDoc | null) => void
}) {
  const [toggling, setToggling] = useState(false)
  const [toggleError, setToggleError] = useState('')
  const [copied, setCopied] = useState(false)

  const doc_ = profile?.ok ? profile.value : null

  async function toggleOnline() {
    if (!doc_) return
    setToggling(true)
    setToggleError('')
    const next = !doc_.isOnline
    try {
      // Availability, not a balance. Nothing about money is written from here.
      await updateDoc(doc(db, 'sellers', doc_.id), { isOnline: next })
      onProfileChange({ ...doc_, isOnline: next })
    } catch (e) {
      setToggleError(e instanceof Error ? e.message : 'That did not go through.')
    } finally {
      setToggling(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* First on the tab, above the details themselves. A proposal is designed
          to leave the live record looking untouched, so somebody who came back
          to check whether their name change went through has to meet the answer
          before they meet the old value and conclude it failed. Renders nothing
          when there is nothing waiting. */}
      <PendingChangesNotice
        record={doc_ as unknown as Record<string, unknown> | null}
        kind="seller"
      />

      <Panel title="Your details" icon={<User size={15} />}>
        <div className="p-4 sm:p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Info label="Name" value={doc_?.displayName || partner.name || ''} />
            <Info label="Phone" value={doc_?.phone || partner.phone || ''} />
            <Info label="Email" value={doc_?.email || partner.email || ''} />
            <Info label="CRM id" value={partner.crm_id || doc_?.crmId || ''} mono />
          </div>

          <div>
            <p className="text-slate-500 text-xs">Seller id</p>
            <div className="flex items-center gap-2">
              <p className="text-slate-200 text-sm font-mono break-all">{partner.id}</p>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(partner.id).then(
                    () => { setCopied(true); setTimeout(() => setCopied(false), 2000) },
                    () => { /* the id is on screen either way */ },
                  )
                }}
                className="text-slate-400 hover:text-white shrink-0"
                aria-label="Copy your seller id"
              >
                {copied ? <CheckCircle2 size={13} className="text-green-400" /> : <Copy size={13} />}
              </button>
            </div>
          </div>

          {profile === null ? (
            <p className="text-slate-500 text-sm">Reading your profile…</p>
          ) : !profile.ok ? (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2">
              <p className="text-yellow-300 text-xs font-medium">
                Your profile document could not be read.
              </p>
              <p className="text-slate-400 text-xs mt-1">{profile.reason}</p>
              <p className="text-slate-500 text-xs mt-1">
                Your inventory and credit above are unaffected — they do not come
                from it.
              </p>
            </div>
          ) : profile.value === null ? (
            <p className="text-slate-500 text-sm">
              No profile document was found for this seller id, so contact details
              and your QR code are not shown.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span
                  className={`text-sm flex items-center gap-1.5 ${
                    profile.value.isOnline ? 'text-green-400' : 'text-slate-500'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      profile.value.isOnline ? 'bg-green-400' : 'bg-slate-600'
                    }`}
                  />
                  {profile.value.isOnline ? 'Online' : 'Offline'}
                </span>
                <button
                  onClick={toggleOnline}
                  disabled={toggling}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border border-slate-700 bg-slate-800 text-slate-300 hover:text-white transition-colors disabled:opacity-50"
                >
                  {profile.value.isOnline ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                  {profile.value.isOnline ? 'Go offline' : 'Go online'}
                </button>
                <span className="text-slate-600 text-xs">
                  Availability only — this writes nothing about money.
                </span>
              </div>
              {toggleError && <p className="text-red-300 text-xs">{toggleError}</p>}
            </>
          )}
        </div>
      </Panel>

      {profile?.ok && profile.value?.qrCodeUrl && (
        <Panel title="Your QR code" icon={<ShoppingBag size={15} />}>
          <div className="p-4 sm:p-5">
            <p className="text-slate-500 text-sm mb-3">
              Buyers scan this to find you in the app.
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={profile.value.qrCodeUrl}
              alt="Your QR code"
              className="w-48 h-48 object-contain bg-white rounded-xl p-2"
            />
          </div>
        </Panel>
      )}

      {/* "This portal only reads them" stopped being true once /profile could
          write them, and a tab that says a thing is unchangeable is where
          somebody stops looking for the way to change it. */}
      <p className="text-slate-600 text-xs px-1">
        This tab shows what the app holds about you. To change your name, phone
        or shop name, use{' '}
        <Link href="/profile" className="text-pink-400 hover:text-pink-300 underline underline-offset-2">
          My Profile
        </Link>
        {' '}in the sidebar — those three are the identity somebody verified, so
        a change to them is checked by a reviewer before it takes effect and the
        value here does not move until then. Everything about money comes from
        the business API.
      </p>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════

function Header({ name, right }: { name?: string; right?: React.ReactNode } = {}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-4 pt-1">
      <div className="min-w-0">
        <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
          <ShoppingBag size={24} className="text-pink-500 shrink-0" />
          <span className="truncate">{name || 'My inventory'}</span>
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          What you hold, what you owe, and where every request has got to.
        </p>
      </div>
      {right}
    </div>
  )
}
