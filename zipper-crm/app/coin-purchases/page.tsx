'use client'

/**
 * Coin purchases — where money genuinely enters the business.
 *
 * A seller pays us for inventory and sends a payment reference and a
 * screenshot. Until now that was a person eyeballing the screenshot and
 * pressing Approve, with two holes in it:
 *
 *   1. the same UTR could be submitted again and again, and nothing noticed;
 *   2. approving credited coins immediately, with no second pair of eyes.
 *
 * Both are closed here. Every purchase is a card: raised on this screen,
 * verified here, signed by an owner on /board, and only then executed — and
 * executing is the moment real inventory appears.
 *
 * The duplicate check is live. Opening a purchase runs
 * `api.partnerOps.checkPaymentRef` against the reference *now*, rather than
 * trusting the snapshot taken when the card was raised — a reference that was
 * clean an hour ago can have been used since. Anything it finds is the loudest
 * thing on the card, with the date and amount of every earlier use.
 *
 * ── The seller queue ──────────────────────────────────────────────────────────
 *
 * The seller portal writes its purchase requests to the Firestore collection
 * `coinPurchaseRequests` (`app/seller-dashboard/page.tsx:208`). This screen read
 * only the Mongo card board, so those requests reached nobody at all: not a
 * bypass of the card flow, a dropped money queue. A seller submitted a payment
 * and their request sat in a collection no staff screen opened.
 *
 * They are surfaced below, in their own clearly-labelled section, and a request
 * is turned into a real card through the API — with the UTR duplicate check run
 * first. Nothing in Firestore is migrated, rewritten or deleted: a request that
 * has been carded is recognised by its payment reference matching a card, and
 * says so.
 */

import UploadField from '@/components/UploadField'
import SecureDocLink from '@/components/SecureDocLink'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, ArrowRight, CheckCircle2, Coins, ExternalLink, FileInput,
  ImageOff, Inbox, Loader2, Package, PenLine, RefreshCw, Search, ShieldCheck,
  X, XCircle,
} from 'lucide-react'
import { Denied, Empty, ErrorState, Loading, Warning } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { referenceOf } from '@/lib/identity'
import {
  getDiamondPacks, DEFAULT_DIAMOND_PACKS, type DiamondPack,
} from '@/lib/appConfig'
import {
  COIN_PURCHASE_LIST_LIMIT, getCoinPurchaseRequests, type CoinPurchaseRequest,
} from '@/lib/coinPurchases'
import { getRates, type Rates } from '@/lib/rates'
import api, { ApiError } from '@/lib/api'
import {
  board, inventory, partnerOps,
  coins as coinText, duplicatesOf, inr, num, proofUrl, str, when,
  type CardStage, type DuplicateRef, type Partner, type PartnerCard,
} from '@/lib/apiPartners'

const PAGE_ROLES = ['superadmin', 'finance_admin', 'finance_member'] as const

const CARD_TYPE = 'seller_coin_purchase'

/** How much of the board is pulled before filtering to purchases. */
const BOARD_LIMIT = 400

const MIN_REASON = 3

/**
 * Every card already carrying this payment reference.
 *
 * `api.partnerOps.checkPaymentRef` is the named entry point for the check. The
 * endpoint answers with a plain list of the earlier cards; older clients typed
 * it as an envelope with a `matches` array, so both shapes are accepted here
 * rather than silently returning nothing and showing a reference as clean.
 */
async function checkPaymentRef(ref: string): Promise<DuplicateRef[]> {
  const trimmed = ref.trim()
  if (!trimmed) return []
  const raw = (await api.partnerOps.checkPaymentRef(trimmed)) as unknown
  if (Array.isArray(raw)) return raw as DuplicateRef[]
  const matches = (raw as { matches?: unknown } | null)?.matches
  return Array.isArray(matches) ? (matches as DuplicateRef[]) : []
}

const STAGE_LABEL: Record<CardStage, string> = {
  requested: 'Raised — awaiting verification',
  under_review: 'Under review',
  awaiting_signoff: 'Verified — awaiting owner signature',
  approved: 'Signed — inventory not credited yet',
  executed: 'Signed, money moved — inventory credited',
  rejected: 'Rejected',
  failed: 'Failed',
}

const STAGE_TONE: Record<CardStage, string> = {
  requested: 'bg-slate-700 text-slate-300',
  under_review: 'bg-blue-500/15 text-blue-300',
  awaiting_signoff: 'bg-amber-500/15 text-amber-300',
  approved: 'bg-green-500/15 text-green-300',
  executed: 'bg-slate-700/60 text-slate-400',
  rejected: 'bg-red-500/15 text-red-300',
  failed: 'bg-red-500/20 text-red-300',
}

/** Status tabs. Grouped the way the work actually flows, not by enum order. */
const TABS: { value: string; label: string; stages: CardStage[] }[] = [
  { value: 'open', label: 'Needs verifying', stages: ['requested', 'under_review'] },
  { value: 'awaiting_signoff', label: 'Awaiting signature', stages: ['awaiting_signoff'] },
  { value: 'approved', label: 'Signed, not credited', stages: ['approved'] },
  { value: 'executed', label: 'Credited', stages: ['executed'] },
  { value: 'rejected', label: 'Rejected', stages: ['rejected', 'failed'] },
  { value: 'all', label: 'Everything', stages: [] },
]

function ageOf(iso: string) {
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (Number.isNaN(mins)) return ''
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m old`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h old`
  return `${Math.floor(hrs / 24)}d old`
}

/** The pack whose total coins match what was bought, if there is one. */
function packFor(packs: DiamondPack[], coins: number): DiamondPack | null {
  return packs.find((p) => p.baseDiamonds + p.bonusDiamonds === coins) ?? null
}

/**
 * A Firestore timestamp, read without trusting its shape.
 *
 * These documents are written by two different code paths, one of which stores
 * a plain `{seconds}` object rather than a real `Timestamp`. Calling `.toDate()`
 * on that throws and would take the whole section down.
 */
function submittedAt(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'object' || value === null) return null

  const record = value as Record<string, unknown>
  if (typeof record.toDate === 'function') {
    const asDate: unknown = (record.toDate as () => unknown)()
    if (asDate instanceof Date && !Number.isNaN(asDate.getTime())) return asDate
  }
  if (typeof record.seconds === 'number') return new Date(record.seconds * 1000)
  return null
}

function whenSubmitted(value: unknown): string {
  const d = submittedAt(value)
  return d
    ? d.toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : 'date not recorded'
}

/** The reference a seller gave, normalised for matching against card payloads. */
function refKey(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export default function CoinPurchases() {
  const { crmUser, apiUser } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, [...PAGE_ROLES])
  // `POST /partner-ops/coin-purchases/{id}/execute` is `require_owner`. The
  // Firestore role says nothing about that — only the API identity does — so
  // the credit button is driven by the API's answer, exactly as /board does.
  const isOwner = apiUser?.role === 'owner'

  const [cards, setCards] = useState<PartnerCard[]>([])
  const [truncated, setTruncated] = useState(false)
  const [sellers, setSellers] = useState<Partner[]>([])
  const [packs, setPacks] = useState<DiamondPack[]>([])
  const [rates, setRates] = useState<Rates | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const [term, setTerm] = useState('')
  const [tab, setTab] = useState('open')
  const [showRaise, setShowRaise] = useState(false)

  /** Live duplicate-check results, by card id. Reported up by each card. */
  const [refHits, setRefHits] = useState<Record<string, DuplicateRef[]>>({})

  // The seller-submitted queue, read straight from Firestore. Kept separate
  // from the board state on purpose: this collection failing must not blank the
  // cards, and the cards failing must not hide a seller's request.
  const [requests, setRequests] = useState<CoinPurchaseRequest[]>([])
  const [requestsState, setRequestsState] =
    useState<'loading' | 'ready' | 'failed'>('loading')
  const [requestsError, setRequestsError] = useState('')
  const [converting, setConverting] = useState<CoinPurchaseRequest | null>(null)

  const loadRequests = useCallback(async () => {
    setRequestsState('loading')
    setRequestsError('')
    try {
      setRequests(await getCoinPurchaseRequests('pending'))
      setRequestsState('ready')
    } catch (err) {
      // Never fall through to an empty list here. "No seller has asked for
      // anything" and "we could not read the queue" must not look the same on
      // a screen whose job is to make sure nobody's payment is dropped.
      setRequests([])
      setRequestsError(
        err instanceof Error ? err.message : 'The seller request queue could not be read.',
      )
      setRequestsState('failed')
    }
  }, [])

  const load = useCallback(async () => {
    setError('')
    try {
      const [list, people] = await Promise.all([
        board.list(BOARD_LIMIT),
        partnerOps.list({ kind: 'seller', limit: 500 }).catch(() => [] as Partner[]),
      ])
      setCards(list.filter((c) => c.type === CARD_TYPE))
      setTruncated(list.length >= BOARD_LIMIT)
      setSellers(people)
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Could not load coin purchases.',
      )
    } finally {
      setLoading(false)
    }
    await loadRequests()
  }, [loadRequests])

  useEffect(() => {
    if (!allowed) return
    load()

    // Packs come from App Config → Packages, merged over the defaults exactly
    // as the Packages screen does, so "expected amount" means the same thing
    // in both places.
    getDiamondPacks()
      .then((data) => {
        const defaults = DEFAULT_DIAMOND_PACKS.map((p, i) => ({ ...p, id: `dp_${i + 1}` }))
        const fsMap = new Map(data.map((p) => [p.id, p]))
        const merged = defaults.map((d) => fsMap.get(d.id) ?? d)
        const extras = data.filter((p) => !defaults.some((d) => d.id === p.id))
        setPacks([...merged, ...extras].sort((a, b) => a.sortOrder - b.sortOrder))
      })
      .catch(() =>
        setPacks(DEFAULT_DIAMOND_PACKS.map((p, i) => ({ ...p, id: `dp_${i + 1}` }))),
      )

    // The configured rate, for purchases that match no pack — otherwise there is
    // nothing to check the claimed amount against at all.
    getRates().then(setRates).catch(() => setRates(null))
  }, [allowed, load])

  const nameOf = useCallback(
    (id: string) => sellers.find((s) => s.id === id)?.name || id,
    [sellers],
  )

  const onRefChecked = useCallback((cardId: string, hits: DuplicateRef[]) => {
    setRefHits((prev) => (prev[cardId] === hits ? prev : { ...prev, [cardId]: hits }))
  }, [])

  const countFor = useCallback(
    (stages: CardStage[]) =>
      stages.length === 0
        ? cards.length
        : cards.filter((c) => stages.includes(c.stage)).length,
    [cards],
  )

  const shown = useMemo(() => {
    const q = term.trim().toLowerCase()
    const stages = TABS.find((t) => t.value === tab)?.stages ?? []
    return cards.filter((c) => {
      if (stages.length > 0 && !stages.includes(c.stage)) return false
      if (!q) return true
      const sellerId = c.subject?.id ?? ''
      return (
        sellerId.toLowerCase().includes(q) ||
        nameOf(sellerId).toLowerCase().includes(q) ||
        str(c.payload, 'payment_ref').toLowerCase().includes(q)
      )
    })
  }, [cards, term, tab, nameOf])

  /** A card is flagged if the snapshot *or* the live check found earlier uses. */
  const flagged = cards.filter((c) => {
    if (c.stage === 'rejected' || c.stage === 'executed') return false
    const live = refHits[c.id]
    return (live ? live.length : duplicatesOf(c).length) > 0
  }).length

  const awaitingSignature = countFor(['awaiting_signoff'])
  const signedNotCredited = countFor(['approved'])

  /**
   * Every payment reference that already carries a card, newest first.
   *
   * This is how a seller's request is recognised as already handled without
   * writing anything back to Firestore. The reference is the only field the two
   * records genuinely share — the seller typed it, and the card carries it.
   */
  const cardByRef = useMemo(() => {
    const map = new Map<string, PartnerCard>()
    for (const c of cards) {
      const key = refKey(str(c.payload, 'payment_ref'))
      if (key && !map.has(key)) map.set(key, c)
    }
    return map
  }, [cards])

  const uncarded = requests.filter((r) => {
    const key = refKey(r.transactionRef)
    return !key || !cardByRef.has(key)
  })

  if (!allowed) return <Denied what="coin purchases" />

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <Package size={26} className="text-pink-500" />
            Coin purchases
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Sellers paying for inventory. This is the only point where money
            genuinely enters the business — every request is a card, and{' '}
            <span className="text-white font-medium">
              an owner signs before anything moves
            </span>
            .
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setLoading(true); load() }}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            onClick={() => setShowRaise(true)}
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            <Coins size={15} /> Record a payment
          </button>
        </div>
      </div>

      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      {truncated && (
        <Warning>
          The most recent {BOARD_LIMIT} cards were read, and older ones are not
          shown here — a search will not find them either. Nothing is missing from
          the record: use the money board or the audit log to reach the rest.
        </Warning>
      )}

      {flagged > 0 && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3 mb-4">
          <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-red-200 text-sm">
            <span className="font-semibold">
              {flagged} open request{flagged === 1 ? '' : 's'} reuse a payment
              reference that has been seen before.
            </span>{' '}
            The same UTR used to be accepted indefinitely. Confirm each one is a
            separate payment before it is signed.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Requests" value={String(cards.length)} tone="text-white" />
        <Stat
          label="Awaiting signature"
          value={String(awaitingSignature)}
          tone={awaitingSignature > 0 ? 'text-amber-300' : 'text-slate-600'}
        />
        <Stat
          label="Signed, not credited"
          value={String(signedNotCredited)}
          tone={signedNotCredited > 0 ? 'text-green-300' : 'text-slate-600'}
        />
        <Stat
          label="Duplicate references"
          value={String(flagged)}
          tone={flagged > 0 ? 'text-red-300' : 'text-slate-600'}
        />
      </div>

      <SellerRequestQueue
        requests={requests}
        state={requestsState}
        error={requestsError}
        cardByRef={cardByRef}
        uncardedCount={uncarded.length}
        nameOf={nameOf}
        onRetry={loadRequests}
        onConvert={setConverting}
        onShowCard={(paymentRef) => { setTab('all'); setTerm(paymentRef) }}
      />

      {/* ── Status tabs ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 mb-3 overflow-x-auto pb-1">
        {TABS.map((t) => {
          const n = countFor(t.stages)
          return (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                tab === t.value
                  ? 'bg-pink-500 text-white'
                  : 'bg-slate-800 text-slate-400 hover:text-white'
              }`}
            >
              {t.label}
              <span
                className={`text-xs px-1.5 py-0.5 rounded-full ${
                  tab === t.value ? 'bg-white/20 text-white' : 'bg-slate-700 text-slate-400'
                }`}
              >
                {n}
              </span>
            </button>
          )
        })}
      </div>

      <div className="relative mb-4">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search by seller name, seller id or payment reference…"
          className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-9 pr-9 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
        />
        {term && (
          <button
            onClick={() => setTerm('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {loading ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <Loading label="Loading coin purchases…" />
        </div>
      ) : error ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <ErrorState message={error} onRetry={() => { setLoading(true); load() }} />
        </div>
      ) : shown.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl">
          <Empty
            title={term || tab !== 'all' ? 'Nothing matches' : 'No coin purchases yet'}
            hint={
              term || tab !== 'all'
                ? 'Try a different search, or another status tab.'
                : 'When a seller pays for inventory, record the payment here and it becomes a card.'
            }
            icon={<Package size={28} />}
          />
        </div>
      ) : (
        <div className="space-y-4">
          {shown.map((card) => (
            <PurchaseCard
              key={card.id}
              card={card}
              sellerName={nameOf(card.subject?.id ?? '')}
              sellerNameOf={(id) => {
                const n = nameOf(id)
                return n && n !== id ? `${n} (${referenceOf('seller', id)})` : referenceOf('seller', id)
              }}
              pack={packFor(packs, num(card.payload, 'coins') || card.amount)}
              rates={rates}
              isOwner={isOwner}
              onRefChecked={onRefChecked}
              onDone={(message) => { setNotice(message); load() }}
            />
          ))}
        </div>
      )}

      {showRaise && (
        <RaiseDialog
          sellers={sellers}
          packs={packs}
          onClose={() => setShowRaise(false)}
          onRaised={(message) => { setShowRaise(false); setNotice(message); load() }}
        />
      )}

      {converting && (
        <ConvertDialog
          request={converting}
          sellers={sellers}
          onClose={() => setConverting(null)}
          onRaised={(message) => { setConverting(null); setNotice(message); load() }}
        />
      )}
    </div>
  )
}

// ── The seller-submitted queue ────────────────────────────────────────────────

function SellerRequestQueue({
  requests,
  state,
  error,
  cardByRef,
  uncardedCount,
  nameOf,
  onRetry,
  onConvert,
  onShowCard,
}: {
  requests: CoinPurchaseRequest[]
  state: 'loading' | 'ready' | 'failed'
  error: string
  cardByRef: Map<string, PartnerCard>
  uncardedCount: number
  nameOf: (id: string) => string
  onRetry: () => void
  onConvert: (request: CoinPurchaseRequest) => void
  onShowCard: (paymentRef: string) => void
}) {
  return (
    <div className="mb-6 border border-slate-800 rounded-xl overflow-hidden">
      <div className="bg-slate-900/80 border-b border-slate-800 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <Inbox size={16} className="text-cyan-400" />
              Submitted by sellers
              {state === 'ready' && uncardedCount > 0 && (
                <span className="bg-cyan-500/20 text-cyan-200 text-xs px-2 py-0.5 rounded-full">
                  {uncardedCount} not carded
                </span>
              )}
            </h2>
            <p className="text-slate-400 text-sm mt-1 max-w-2xl">
              Requests the sellers filed themselves from their own portal. These
              are <span className="text-white font-medium">not cards</span> and
              nothing on this list has been verified, signed or credited —
              raising a card from one is what puts it into the money flow.
            </p>
          </div>
          <button
            onClick={onRetry}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors shrink-0"
          >
            <RefreshCw size={13} /> Reload
          </button>
        </div>
      </div>

      {state === 'loading' ? (
        <Loading label="Reading the seller request queue…" />
      ) : state === 'failed' ? (
        <div className="px-5 py-4">
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/40 rounded-lg px-4 py-3">
            <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-red-200 text-sm font-semibold">
                The seller request queue could not be read.
              </p>
              <p className="text-red-200/85 text-sm mt-0.5">{error}</p>
              <p className="text-red-200/70 text-sm mt-1">
                This is not the same as there being none. A seller may be waiting
                on a payment nobody can see right now — do not treat this section
                as empty.
              </p>
              <button
                onClick={onRetry}
                className="mt-2 flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-1.5 text-xs transition-colors"
              >
                <RefreshCw size={12} /> Try again
              </button>
            </div>
          </div>
        </div>
      ) : requests.length === 0 ? (
        <Empty
          title="No seller has a request open"
          hint="When a seller submits a payment from their own portal it appears here, and stays here until someone raises a card from it."
          icon={<Inbox size={26} />}
        />
      ) : (
        <div className="divide-y divide-slate-800">
          {/* Audit C-15: the read is capped; say so rather than let the cap
              read as "that is all of them". */}
          {requests.length >= COIN_PURCHASE_LIST_LIMIT && (
            <p className="px-4 py-2 text-amber-300/90 text-xs bg-amber-500/5">
              Showing the first {COIN_PURCHASE_LIST_LIMIT} open requests, newest first — more exist beyond this list.
            </p>
          )}
          {requests.map((r) => (
            <SellerRequestRow
              key={r.id}
              request={r}
              card={cardByRef.get(refKey(r.transactionRef)) ?? null}
              sellerName={nameOf(r.sellerUid)}
              onConvert={() => onConvert(r)}
              onShowCard={() => onShowCard((r.transactionRef ?? '').trim())}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SellerRequestRow({
  request,
  card,
  sellerName,
  onConvert,
  onShowCard,
}: {
  request: CoinPurchaseRequest
  card: PartnerCard | null
  sellerName: string
  onConvert: () => void
  /** Reveal the matching card in the list below, whatever tab is selected. */
  onShowCard: () => void
}) {
  const ref = (request.transactionRef ?? '').trim()
  const isUsd = request.currency === 'USD'

  return (
    <div className="px-5 py-4 bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-white font-medium">
            {request.sellerName || sellerName || request.sellerUid}
          </p>
          <p className="text-slate-600 text-xs font-mono truncate">{request.sellerUid}</p>
          <p className="text-slate-500 text-xs mt-0.5">
            {whenSubmitted(request.createdAt)}
            {request.sellerEmail ? ` · ${request.sellerEmail}` : ''}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-yellow-300 font-semibold">
            {coinText(request.coinsRequested)}
          </p>
          <p className="text-slate-300 text-sm">
            {isUsd
              ? `$${request.amountPaid.toLocaleString('en-US')}`
              : `₹${request.amountPaid.toLocaleString('en-IN')}`}
            <span className="text-slate-600 text-xs ml-1.5">
              via {request.paymentMethod}
            </span>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2">
        <p className="text-slate-400 text-xs">
          Reference:{' '}
          <span className="font-mono text-slate-200">{ref || '— none given —'}</span>
        </p>
        {/* Through the API behind a 15-minute signed URL.
            `request.paymentProofUrl` is the `getDownloadURL()` result stored
            when the seller uploaded their bank screenshot — a permanent
            bearer credential Storage Rules are never consulted for. */}
        {request.paymentProofUrl && (
          <SecureDocLink
            kind="coin_purchase" recordId={request.id} slot="proof"
            label="Payment proof"
          />
        )}
      </div>

      {card ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 bg-green-500/10 border border-green-500/30 rounded-lg px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-green-200 text-sm font-medium flex items-center gap-1.5">
              <CheckCircle2 size={13} /> Already carded
            </p>
            <p className="text-green-100/75 text-xs mt-0.5">
              A card carries this reference — {STAGE_LABEL[card.stage].toLowerCase()}.
              The Firestore request is left exactly as the seller wrote it.
            </p>
            <p className="text-green-100/50 text-xs font-mono mt-0.5">{card.id}</p>
          </div>
          <button
            onClick={onShowCard}
            className="text-green-200 hover:text-white text-xs underline underline-offset-2 shrink-0"
          >
            Show the card
          </button>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-amber-300 text-xs max-w-lg">
            No card carries this reference. Nothing has been verified and no coins
            exist — this request has reached nobody until a card is raised from it.
            {!ref && ' It also has no payment reference, so it cannot be matched to a bank entry.'}
          </p>
          <button
            onClick={onConvert}
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors shrink-0"
          >
            <FileInput size={14} /> Raise a card
          </button>
        </div>
      )}
    </div>
  )
}

// ── Turning a seller's request into a card ────────────────────────────────────

/**
 * The seller's request, carried over onto a real card.
 *
 * Three things are deliberately not automatic:
 *
 *   * **The duplicate check runs before anything is raised**, not after. It is
 *     the whole reason this screen exists, and a seller-submitted reference is
 *     exactly the kind that gets re-used.
 *   * **A USD request is never converted for you.** `amountPaid` is whole
 *     dollars on those, and `amount_paid_minor` is paise. Multiplying by 100
 *     would file a dollar figure as rupees and understate what we received by
 *     the whole exchange rate. The operator types what actually landed.
 *   * **The seller is confirmed, not assumed.** `sellerUid` is a Firestore
 *     document id, which is normally the partner id too — but if there is no
 *     partner record behind it the API will refuse, and it is better to see
 *     that here than as a failed request.
 */
function ConvertDialog({
  request,
  sellers,
  onClose,
  onRaised,
}: {
  request: CoinPurchaseRequest
  sellers: Partner[]
  onClose: () => void
  onRaised: (message: string) => void
}) {
  const known = sellers.some((s) => s.id === request.sellerUid)
  const isUsd = request.currency === 'USD'

  const [sellerId, setSellerId] = useState(known ? request.sellerUid : '')
  const [coins, setCoins] = useState(String(request.coinsRequested || ''))
  const [amount, setAmount] = useState(
    isUsd ? '' : String(request.amountPaid || ''),
  )
  const [paymentRef, setPaymentRef] = useState((request.transactionRef ?? '').trim())
  const [reason, setReason] = useState(
    `Raised from the seller's own request of ${whenSubmitted(request.createdAt)}`,
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const [hits, setHits] = useState<DuplicateRef[]>([])
  const [checkState, setCheckState] =
    useState<'idle' | 'checking' | 'done' | 'failed'>('idle')

  const runCheck = useCallback(async (ref: string) => {
    const trimmed = ref.trim()
    if (!trimmed) { setHits([]); setCheckState('idle'); return }
    setCheckState('checking')
    try {
      setHits(await checkPaymentRef(trimmed))
      setCheckState('done')
    } catch {
      setHits([])
      setCheckState('failed')
    }
  }, [])

  // Run it on open, against the reference the seller supplied.
  useEffect(() => {
    runCheck((request.transactionRef ?? '').trim())
  }, [request.transactionRef, runCheck])

  const coinsNum = Math.round(Number(coins)) || 0
  const claimedMinor = Math.round(Number(amount) * 100) || 0

  const valid =
    sellerId.trim().length > 0 &&
    coinsNum > 0 &&
    paymentRef.trim().length > 0 &&
    reason.trim().length >= MIN_REASON

  async function submit() {
    if (!valid) return
    setBusy(true)
    setErr('')
    try {
      const card = await inventory.requestCoinPurchase(sellerId.trim(), {
        coins: coinsNum,
        amount_paid_minor: claimedMinor,
        payment_ref: paymentRef.trim(),
        evidence_url: request.paymentProofUrl ?? '',
        reason: reason.trim(),
      })
      onRaised(
        (card.warning ? `${card.warning} ` : '')
        + 'Card raised from the seller’s request. Nothing has moved — it still has '
        + 'to be verified and signed before any coins exist. The seller’s original '
        + 'request has been left untouched in Firestore.',
      )
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'The request was not accepted.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 bg-black/70 backdrop-blur-sm overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-lg my-8">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div className="min-w-0">
            <h2 className="text-white font-semibold">Raise a card from this request</h2>
            <p className="text-slate-500 text-xs mt-0.5 truncate">
              {request.sellerName || request.sellerUid} ·{' '}
              {whenSubmitted(request.createdAt)}
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* The duplicate check, before anything is raised. */}
          {checkState === 'checking' && (
            <p className="text-slate-400 text-xs flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" />
              Checking whether this reference has been used before…
            </p>
          )}
          {checkState === 'failed' && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5">
              <p className="text-amber-200 text-sm">
                The duplicate check could not be run. Treat this reference as
                unverified — do not assume it is clean. The card itself will run
                the check again when it is raised.
              </p>
            </div>
          )}
          {checkState === 'done' && hits.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2.5">
              <p className="text-red-200 text-sm font-semibold">
                This reference has been used before.
              </p>
              <ul className="mt-1 space-y-0.5">
                {hits.map((d) => (
                  <li key={d.card_id} className="text-red-200/80 text-xs">
                    {coinText(Number(d.amount ?? 0))} · {when(d.created_at)} · {d.stage} ·
                    seller {sellerRef(sellers, d.subject_id)}
                  </li>
                ))}
              </ul>
              <p className="text-red-200/70 text-xs mt-1.5">
                A seller can submit the same UTR twice as easily as anyone else.
                Confirm this is a separate payment — the card will be flagged for
                the owner either way.
              </p>
            </div>
          )}
          {checkState === 'done' && hits.length === 0 && (
            <p className="text-green-300 text-xs flex items-center gap-1.5">
              <CheckCircle2 size={11} /> This reference has not been used on any
              other card.
            </p>
          )}

          <Labelled label="Seller">
            <select
              value={sellerId}
              onChange={(e) => setSellerId(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
            >
              <option value="">Choose a seller…</option>
              {sellers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id}{s.status !== 'approved' ? ` — ${s.status}` : ''}
                </option>
              ))}
            </select>
            {!known && (
              <p className="text-amber-300 text-xs mt-1">
                The request names <span className="font-mono">{request.sellerUid}</span>,
                which is not in the partner list. Pick the seller this payment
                belongs to — raising it against the wrong account credits the
                wrong inventory.
              </p>
            )}
          </Labelled>

          <div className="grid grid-cols-2 gap-3">
            <Labelled label="Coins">
              <input
                value={coins}
                onChange={(e) => setCoins(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
              />
              <p className="text-slate-600 text-xs mt-1">
                Requested: {request.coinsRequested.toLocaleString('en-IN')}
              </p>
            </Labelled>
            <Labelled label="Amount received (₹)">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal"
                placeholder={isUsd ? 'rupees actually received' : ''}
                className={`w-full bg-slate-800 border rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none ${
                  isUsd && !amount
                    ? 'border-amber-500/60 focus:border-amber-500'
                    : 'border-slate-700 focus:border-pink-500'
                }`}
              />
              <p className="text-slate-600 text-xs mt-1">
                Filed as {inr(claimedMinor)}.
              </p>
            </Labelled>
          </div>

          {isUsd && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5">
              <p className="text-amber-100 text-sm font-semibold">
                This request is in US dollars.
              </p>
              <p className="text-amber-100/80 text-xs mt-1">
                The seller recorded{' '}
                <span className="font-semibold">
                  ${request.amountPaid.toLocaleString('en-US')}
                </span>{' '}
                paid via {request.paymentMethod}. Cards are filed in rupees, and
                there is no exchange rate here to convert it with — enter what
                actually reached the account in ₹. It has deliberately not been
                pre-filled, because carrying the dollar figure across as rupees
                would understate the payment.
              </p>
            </div>
          )}

          <Labelled label="Payment reference (UTR / transaction id)">
            <input
              value={paymentRef}
              onChange={(e) => setPaymentRef(e.target.value)}
              onBlur={() => runCheck(paymentRef)}
              placeholder="UTR from the bank"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
            <p className="text-slate-600 text-xs mt-1">
              Carried over from the seller. This is also what links the request to
              the card afterwards, so changing it means the request will not show
              as carded.
            </p>
          </Labelled>

          {request.paymentProofUrl ? (
            <p className="text-slate-500 text-xs">
              The seller&rsquo;s proof image is attached to the card as evidence.{' '}
              <SecureDocLink
                kind="coin_purchase" recordId={request.id} slot="proof"
                label="Open it first"
                className="text-pink-400 hover:text-pink-300 underline underline-offset-2 inline-flex items-center gap-1"
              />
              .
            </p>
          ) : (
            <p className="text-amber-300 text-xs">
              This request carries no payment proof, so the card will have no
              evidence attached to verify against.
            </p>
          )}

          <Labelled label="Reason">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500 resize-none"
            />
            {reason.trim().length > 0 && reason.trim().length < MIN_REASON && (
              <p className="text-amber-400 text-xs mt-1">
                At least {MIN_REASON} characters.
              </p>
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
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Coins size={15} />}
            Raise the card
          </button>
        </div>
      </div>
    </div>
  )
}

// ── One purchase request ──────────────────────────────────────────────────────

/**
 * B1: a duplicate-reference hit names the seller record it belongs to. The
 * name comes from the sellers list this page already loaded; the labelled
 * Seller ID stays beside it so two records are never confused.
 */
function sellerRef(sellers: ReadonlyArray<{ id: string; name?: string }>, id: string): string {
  const name = (sellers.find((s) => s.id === id)?.name ?? '').trim()
  return name ? `${name} (${referenceOf('seller', id)})` : referenceOf('seller', id)
}

function PurchaseCard({
  card,
  sellerName,
  sellerNameOf,
  pack,
  rates,
  isOwner,
  onRefChecked,
  onDone,
}: {
  card: PartnerCard
  sellerName: string
  /** B1: names the seller record of each duplicate-reference hit. */
  sellerNameOf?: (id: string) => string
  pack: DiamondPack | null
  rates: Rates | null
  /** Only an owner may execute. The API refuses everyone else with a 403. */
  isOwner: boolean
  onRefChecked: (cardId: string, hits: DuplicateRef[]) => void
  onDone: (message: string) => void
}) {
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [confirmCredit, setConfirmCredit] = useState(false)
  const [proofBroken, setProofBroken] = useState(false)

  const coinsBought = num(card.payload, 'coins') || card.amount
  const claimedMinor = num(card.payload, 'amount_paid_minor')
  const ref = str(card.payload, 'payment_ref')
  const proof = proofUrl(card)

  // What this should have cost — at the WHOLESALE rate, which is what a coin
  // seller pays, and what the API checks their payment against.
  //
  // This computed the retail price, and it is the screen on which an owner
  // approves the money. So a seller who paid exactly the right wholesale amount
  // — accepted by the API — would have been shown a red "underpaid by ₹390"
  // banner here, on the one screen where somebody decides whether a payment is
  // honest. The two halves of the same check disagreeing is worse than neither
  // existing: it trains the reviewer to click past the warning.
  //
  // The pack branch is gone for the same reason it went from the seller's own
  // dialog: `pack.priceInr` is derived from the retail rate, so it disagreed
  // with the API too. A pack chooses a quantity; the rate decides the price.
  const expectedMinor = rates
    ? Math.round(coinsBought * rates.sellerWholesalePerDiamond * 100)
    : null
  const expectedSource = rates
    ? `at ₹${rates.sellerWholesalePerLakhInr.toLocaleString('en-IN')} per lakh wholesale`
    : ''
  const difference = expectedMinor === null ? 0 : claimedMinor - expectedMinor
  // A rate-derived expectation carries rounding, so only a real gap is a
  // mismatch — the same ₹1 the API allows, so the two never disagree.
  const tolerance = 100
  const mismatch =
    expectedMinor !== null && claimedMinor > 0 && Math.abs(difference) > tolerance

  // ── The live duplicate check ───────────────────────────────────────────────
  // The snapshot on the payload was taken when the card was raised. This asks
  // again, now, because a reference that was clean then may not be clean today.
  const [refState, setRefState] = useState<'idle' | 'checking' | 'done' | 'failed'>('idle')
  const [liveHits, setLiveHits] = useState<DuplicateRef[]>([])

  // A closed card cannot be acted on, so it keeps the snapshot the API took
  // when it was raised. Running the check only on the live queue is also what
  // keeps a long list from firing one request per row.
  const actionable = !['executed', 'rejected', 'failed'].includes(card.stage)

  useEffect(() => {
    if (!actionable) {
      setRefState('idle')
      return
    }
    if (!ref) {
      setRefState('done')
      onRefChecked(card.id, [])
      return
    }
    let cancelled = false
    setRefState('checking')
    checkPaymentRef(ref)
      .then((rows) => {
        if (cancelled) return
        const earlier = rows.filter((r) => r.card_id !== card.id)
        setLiveHits(earlier)
        setRefState('done')
        onRefChecked(card.id, earlier)
      })
      .catch(() => { if (!cancelled) setRefState('failed') })
    return () => { cancelled = true }
  }, [ref, card.id, actionable, onRefChecked])

  // The snapshot the API attached at raise time, merged in so nothing is lost
  // if the live check cannot run.
  const snapshot = duplicatesOf(card).filter((d) => d.card_id !== card.id)
  const seen = new Set(liveHits.map((d) => d.card_id))
  const duplicates = [...liveHits, ...snapshot.filter((d) => !seen.has(d.card_id))]

  async function run(label: string, fn: () => Promise<unknown>, done: string) {
    setBusy(label)
    setErr('')
    try {
      await fn()
      onDone(done)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'That did not go through.')
    } finally {
      setBusy('')
    }
  }

  return (
    <div
      className={`bg-slate-900 border rounded-xl overflow-hidden ${
        duplicates.length > 0 ? 'border-red-500/50' : 'border-slate-800'
      }`}
    >
      {/* Duplicate payment reference — the loudest thing on the card. */}
      {duplicates.length > 0 && (
        <div className="bg-red-500/15 border-b border-red-500/40 px-5 py-4">
          <div className="flex items-start gap-2">
            <AlertTriangle size={18} className="text-red-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-red-200 font-semibold text-sm">
                This reference has been used before.
              </p>
              <p className="text-red-200/80 text-sm mt-0.5">
                <span className="font-mono">{ref || '—'}</span> already appears on{' '}
                {duplicates.length} other card{duplicates.length === 1 ? '' : 's'}.
                Confirm this is a separate payment before anyone signs it — the
                same reference credited twice is money we never received.
              </p>
              <ul className="mt-2 space-y-1.5">
                {duplicates.map((d) => (
                  <li
                    key={d.card_id}
                    className="text-xs text-red-100/90 bg-red-500/10 rounded px-2 py-1.5"
                  >
                    <span className="font-semibold">{coinText(Number(d.amount ?? 0))}</span>
                    {' · '}
                    {when(d.created_at)}
                    {' · '}
                    <span className="text-red-200/70">
                      {String(d.type ?? '').replace(/_/g, ' ')} · {d.stage} · seller{' '}
                      {sellerNameOf ? sellerNameOf(d.subject_id) : referenceOf('seller', d.subject_id)}
                    </span>
                    <span className="block text-red-200/50 font-mono">{d.card_id}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {duplicates.length === 0 && refState === 'done' && ref && (
        <div className="bg-green-500/10 border-b border-green-500/25 px-5 py-2.5">
          <p className="text-green-300 text-xs flex items-center gap-1.5">
            <CheckCircle2 size={12} />
            <span className="font-mono">{ref}</span> has not been used on any other
            card. Checked just now, not when this was raised.
          </p>
        </div>
      )}

      {refState === 'checking' && (
        <div className="bg-slate-800/60 border-b border-slate-700 px-5 py-2.5">
          <p className="text-slate-400 text-xs flex items-center gap-1.5">
            <Loader2 size={12} className="animate-spin" />
            Checking whether this reference has been used before…
          </p>
        </div>
      )}

      {refState === 'failed' && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-5 py-2.5">
          <p className="text-amber-200 text-xs flex items-center gap-1.5">
            <AlertTriangle size={12} />
            The duplicate check could not be run. Treat this reference as
            unverified — do not assume it is clean.
          </p>
        </div>
      )}

      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div className="min-w-0">
            <p className="text-white font-semibold">{sellerName}</p>
            <p className="text-slate-500 text-xs font-mono truncate">
              {card.subject?.id}
            </p>
          </div>
          <div className="text-right">
            <span className={`inline-block text-xs px-2 py-1 rounded ${STAGE_TONE[card.stage]}`}>
              {STAGE_LABEL[card.stage]}
            </span>
            <p className="text-slate-600 text-xs mt-1">
              raised by {card.requested_by?.name || '—'} · {ageOf(card.created_at)}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Facts */}
          <div className="space-y-3">
            <Field label="Coins requested">
              <span className="text-yellow-300 font-semibold">{coinText(coinsBought)}</span>
              {pack && <span className="text-slate-500 text-xs ml-2">{pack.label} pack</span>}
            </Field>

            <Field label="Payment reference">
              <span className="font-mono text-slate-200 text-sm break-all">
                {ref || '— none given —'}
              </span>
            </Field>

            <div
              className={`rounded-lg px-3 py-2.5 border ${
                mismatch
                  ? 'bg-red-500/10 border-red-500/40'
                  : 'bg-slate-800/60 border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400 text-xs uppercase tracking-wide">Claimed</span>
                <span className={`font-semibold ${mismatch ? 'text-red-300' : 'text-white'}`}>
                  {inr(claimedMinor)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3 mt-1">
                <span className="text-slate-400 text-xs uppercase tracking-wide">
                  Expected {expectedSource && `(${expectedSource})`}
                </span>
                <span className="text-slate-300">
                  {expectedMinor === null ? 'no pack or rate to check against' : inr(expectedMinor)}
                </span>
              </div>
              {mismatch && (
                <p className="text-red-300 text-xs mt-2 font-medium">
                  {difference < 0
                    ? `${inr(-difference)} short of what this should cost.`
                    : `${inr(difference)} more than this should cost.`}{' '}
                  Do not verify until the difference is explained.
                </p>
              )}
              {!mismatch && expectedMinor !== null && claimedMinor > 0 && (
                <p className="text-slate-500 text-xs mt-2">
                  The claimed amount matches what was expected.
                </p>
              )}
              {expectedMinor === null && (
                <p className="text-slate-500 text-xs mt-2">
                  No configured pack matches {coinsBought.toLocaleString('en-IN')}{' '}
                  coins and the rate could not be read, so there is nothing to
                  check the amount against.
                </p>
              )}
              {!pack && rates?.isFallback && (
                <p className="text-amber-400/80 text-xs mt-1.5">
                  The rate above is a fallback — appConfig/economy is not set, so
                  the expected amount may be wrong.
                </p>
              )}
            </div>

            <Field label="Stated reason">
              <span className="text-slate-300 text-sm">{card.reason || '—'}</span>
            </Field>

            {card.verified_by && (
              <p className="text-slate-500 text-xs">
                Verified by {card.verified_by.name} · {when(card.verified_at)}
                {card.verification_note ? ` — ${card.verification_note}` : ''}
              </p>
            )}
            {card.stage === 'rejected' && (
              <p className="text-red-300 text-xs">
                Rejected by {card.rejected_by?.name ?? '—'}:{' '}
                {card.rejection_reason || 'no reason on record'}
              </p>
            )}
            {card.stage === 'executed' && (
              <p className="text-green-300 text-xs flex items-center gap-1">
                <CheckCircle2 size={12} />
                {coinText(coinsBought)} credited to this seller on{' '}
                {when(card.executed_at)}.
              </p>
            )}
          </div>

          {/* Proof, inline — the decision should not need another tab. */}
          <div>
            <p className="text-slate-400 text-xs font-medium uppercase tracking-wide mb-1.5">
              Payment proof
            </p>
            {proof && !proofBroken ? (
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={proof}
                  alt="Payment proof"
                  onError={() => setProofBroken(true)}
                  className="w-full max-h-80 object-contain bg-slate-950 rounded-lg border border-slate-700"
                />
                <a
                  href={proof}
                  target="_blank"
                  rel="noreferrer"
                  className="absolute bottom-2 right-2 flex items-center gap-1 bg-slate-900/90 hover:bg-slate-800 text-slate-300 text-xs rounded px-2 py-1"
                >
                  <ExternalLink size={11} /> Full size
                </a>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 h-40 bg-slate-950 border border-dashed border-slate-700 rounded-lg text-slate-600">
                <ImageOff size={22} />
                <p className="text-xs">
                  {proof ? 'The proof image could not be loaded.' : 'No proof attached.'}
                </p>
                {proof && (
                  <a
                    href={proof}
                    target="_blank"
                    rel="noreferrer"
                    className="text-pink-400 hover:text-pink-300 text-xs underline underline-offset-2"
                  >
                    Try opening it directly
                  </a>
                )}
              </div>
            )}
          </div>
        </div>

        {err && (
          <p className="mt-4 flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {err}
          </p>
        )}

        {/* Actions */}
        <div className="mt-4 pt-4 border-t border-slate-800">
          {card.stage === 'approved' ? (
            <div className="bg-green-500/10 border border-green-500/40 rounded-lg p-4">
              <p className="text-green-200 text-sm font-semibold flex items-center gap-2">
                <ShieldCheck size={15} /> An owner has signed this. Money has not
                moved yet.
              </p>
              <p className="text-green-200/80 text-sm mt-1">
                Crediting now puts{' '}
                <span className="font-semibold">{coinText(coinsBought)}</span> of
                real, spendable inventory into {sellerName}&rsquo;s account. It
                cannot be undone from this screen — a correction would be another
                card.
              </p>
              {duplicates.length > 0 && (
                <p className="text-red-300 text-sm mt-2 font-medium">
                  This reference is a duplicate. Crediting it may be paying
                  ourselves with money we never received.
                </p>
              )}
              {!isOwner ? (
                <>
                  <button
                    type="button"
                    disabled
                    title="Only a business owner can credit inventory."
                    className="mt-3 flex items-center gap-2 bg-slate-800 text-slate-500 font-semibold rounded-lg px-4 py-2 text-sm cursor-not-allowed"
                  >
                    <Coins size={14} /> Credit the inventory
                  </button>
                  <p className="text-green-200/70 text-xs mt-1.5">
                    Only a business owner can credit inventory. This card is signed
                    and waiting for one — until they do it, {sellerName} has nothing
                    to spend.
                  </p>
                </>
              ) : confirmCredit ? (
                <div className="flex flex-wrap items-center gap-2 mt-3">
                  <button
                    onClick={() =>
                      run(
                        'execute',
                        () => inventory.executeCoinPurchase(card.id),
                        `${coinText(coinsBought)} credited to ${sellerName}.`,
                      )
                    }
                    disabled={!!busy}
                    className="flex items-center gap-2 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
                  >
                    {busy === 'execute' ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Coins size={14} />
                    )}
                    Yes — credit {coinText(coinsBought)}
                  </button>
                  <button
                    onClick={() => setConfirmCredit(false)}
                    className="text-slate-400 hover:text-white text-sm px-3 py-2"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmCredit(true)}
                  className="mt-3 flex items-center gap-2 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
                >
                  <Coins size={14} /> Credit the inventory
                </button>
              )}
            </div>
          ) : card.stage === 'awaiting_signoff' ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-slate-400 text-sm">
                Raised and verified — waiting on an owner. Nothing has moved.
              </p>
              <Link
                href="/board"
                className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-4 py-2 text-sm transition-colors"
              >
                Sign it on the money board <ArrowRight size={14} />
              </Link>
            </div>
          ) : card.stage === 'requested' || card.stage === 'under_review' ? (
            <div className="space-y-3">
              <p className="text-slate-500 text-xs">
                Verifying confirms the facts — it is not approval. An owner signs
                on the money board, and only then is inventory credited.
              </p>

              {rejecting ? (
                <div>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={2}
                    placeholder="Why is this being rejected? The seller is told this."
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-red-500 resize-none"
                  />
                  <div className="flex items-center gap-2 mt-2">
                    <button
                      onClick={() =>
                        run(
                          'reject',
                          () => board.reject(card.id, reason.trim()),
                          'Request rejected. The reason is on the record.',
                        )
                      }
                      disabled={reason.trim().length < MIN_REASON || !!busy}
                      className="flex items-center gap-2 bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                    >
                      {busy === 'reject' ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <XCircle size={14} />
                      )}
                      Reject
                    </button>
                    <button
                      onClick={() => { setRejecting(false); setReason('') }}
                      className="text-slate-400 hover:text-white text-sm px-3 py-2"
                    >
                      Cancel
                    </button>
                    {reason.trim().length > 0 && reason.trim().length < MIN_REASON && (
                      <span className="text-amber-400 text-xs">
                        At least {MIN_REASON} characters.
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="What did you check? (bank statement, amount, reference)"
                    className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
                  />
                  <button
                    onClick={() =>
                      run(
                        'verify',
                        () => board.verify(card.id, note.trim()),
                        'Verified. It is now waiting on an owner signature.',
                      )
                    }
                    disabled={note.trim().length < MIN_REASON || !!busy}
                    className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2 text-sm transition-colors"
                  >
                    {busy === 'verify' ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <PenLine size={14} />
                    )}
                    Verify
                  </button>
                  <button
                    onClick={() => setRejecting(true)}
                    className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-red-300 rounded-lg px-4 py-2 text-sm transition-colors"
                  >
                    <XCircle size={14} /> Reject
                  </button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-slate-600 text-sm">
              Closed — no action left on this request.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Recording a new payment ───────────────────────────────────────────────────

function RaiseDialog({
  sellers,
  packs,
  onClose,
  onRaised,
}: {
  sellers: Partner[]
  packs: DiamondPack[]
  onClose: () => void
  onRaised: (message: string) => void
}) {
  const [sellerId, setSellerId] = useState('')
  const [packId, setPackId] = useState('')
  const [coins, setCoins] = useState('')
  const [amount, setAmount] = useState('')
  const [paymentRef, setPaymentRef] = useState('')
  const [evidenceUrl, setEvidenceUrl] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [refHits, setRefHits] = useState<DuplicateRef[] | null>(null)
  const [checkingRef, setCheckingRef] = useState(false)

  const pack = packs.find((p) => p.id === packId) ?? null
  const expectedMinor = pack ? Math.round(pack.priceInr * 100) : null
  const claimedMinor = Math.round(Number(amount) * 100) || 0
  const mismatch =
    expectedMinor !== null && claimedMinor > 0 && claimedMinor !== expectedMinor

  function choosePack(id: string) {
    setPackId(id)
    const p = packs.find((x) => x.id === id)
    if (!p) return
    setCoins(String(p.baseDiamonds + p.bonusDiamonds))
    setAmount(String(p.priceInr))
  }

  async function runCheck() {
    const ref = paymentRef.trim()
    if (!ref) { setRefHits(null); return }
    setCheckingRef(true)
    try {
      setRefHits(await checkPaymentRef(ref))
    } catch {
      // The check is a courtesy here — the card carries the authoritative flag,
      // and the card view re-runs it.
      setRefHits(null)
    } finally {
      setCheckingRef(false)
    }
  }

  const valid =
    sellerId.trim().length > 0 &&
    Number(coins) > 0 &&
    paymentRef.trim().length > 0 &&
    reason.trim().length >= MIN_REASON

  async function submit() {
    if (!valid) return
    setBusy(true)
    setErr('')
    try {
      const card = await inventory.requestCoinPurchase(sellerId.trim(), {
        coins: Math.round(Number(coins)),
        amount_paid_minor: claimedMinor,
        payment_ref: paymentRef.trim(),
        evidence_url: evidenceUrl.trim(),
        reason: reason.trim(),
      })
      onRaised(
        card.warning
          ? `${card.warning} The card is raised and flagged — nothing has moved.`
          : 'Card raised. Nothing has moved: an owner signs before inventory is credited.',
      )
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'The request was not accepted.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 bg-black/70 backdrop-blur-sm overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-xl w-full max-w-lg my-8">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-white font-semibold">Record a seller payment</h2>
            <p className="text-slate-500 text-xs mt-0.5">
              This raises a card. No coins are credited until an owner signs.
            </p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white">
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <Labelled label="Seller">
            <select
              value={sellerId}
              onChange={(e) => setSellerId(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
            >
              <option value="">Choose a seller…</option>
              {sellers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id}{s.status !== 'approved' ? ` — ${s.status}` : ''}
                </option>
              ))}
            </select>
          </Labelled>

          <Labelled label="Pack">
            <select
              value={packId}
              onChange={(e) => choosePack(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
            >
              <option value="">No pack — enter the numbers by hand</option>
              {packs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {(p.baseDiamonds + p.bonusDiamonds).toLocaleString('en-IN')} coins
                  {' '}for ₹{p.priceInr.toLocaleString('en-IN')}
                </option>
              ))}
            </select>
          </Labelled>

          <div className="grid grid-cols-2 gap-3">
            <Labelled label="Coins">
              <input
                value={coins}
                onChange={(e) => setCoins(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                placeholder="100000"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
              />
            </Labelled>
            <Labelled label="Amount paid (₹)">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal"
                placeholder="2290"
                className={`w-full bg-slate-800 border rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none ${
                  mismatch ? 'border-red-500/60 focus:border-red-500' : 'border-slate-700 focus:border-pink-500'
                }`}
              />
            </Labelled>
          </div>

          {mismatch && expectedMinor !== null && (
            <p className="text-red-300 text-xs">
              {pack?.label} costs {inr(expectedMinor)}. This claims {inr(claimedMinor)} —
              the card will carry the difference for the owner to see.
            </p>
          )}

          <Labelled label="Payment reference (UTR / transaction id)">
            <input
              value={paymentRef}
              onChange={(e) => { setPaymentRef(e.target.value); setRefHits(null) }}
              onBlur={runCheck}
              placeholder="UTR from the bank"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm font-mono placeholder-slate-600 focus:outline-none focus:border-pink-500"
            />
          </Labelled>

          {checkingRef && (
            <p className="text-slate-500 text-xs flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" /> Checking whether this
              reference has been used before…
            </p>
          )}
          {refHits !== null && refHits.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-3 py-2.5">
              <p className="text-red-200 text-sm font-semibold">
                This reference has been used before.
              </p>
              <ul className="mt-1 space-y-0.5">
                {refHits.map((d) => (
                  <li key={d.card_id} className="text-red-200/80 text-xs">
                    {coinText(Number(d.amount ?? 0))} · {when(d.created_at)} ·{' '}
                    {d.stage} · seller {sellerRef(sellers, d.subject_id)}
                  </li>
                ))}
              </ul>
              <p className="text-red-200/70 text-xs mt-1.5">
                You can still raise this if it is genuinely a separate payment —
                the card will be flagged for the owner.
              </p>
            </div>
          )}
          {refHits !== null && refHits.length === 0 && (
            <p className="text-green-300 text-xs flex items-center gap-1.5">
              <CheckCircle2 size={11} /> This reference has not been used before.
            </p>
          )}

          <UploadField
            label="Payment proof"
            value={evidenceUrl}
            onChange={setEvidenceUrl}
            storagePath="evidence/coinPurchases"
            accept="image/*,application/pdf"
            hint="Shown inline on the card, so whoever verifies it can look at it without leaving the screen."
          />

          <Labelled label="Reason">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="Why this is being recorded — kept on the card and in the audit log."
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
            />
            {reason.trim().length > 0 && reason.trim().length < MIN_REASON && (
              <p className="text-amber-400 text-xs mt-1">
                At least {MIN_REASON} characters.
              </p>
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
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Coins size={15} />}
            Raise the card
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Bits ──────────────────────────────────────────────────────────────────────

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${tone}`}>{value}</p>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      <div className="mt-0.5">{children}</div>
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
