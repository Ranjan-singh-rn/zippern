'use client'

/**
 * Buying inventory — as a card, through the API.
 *
 * What this replaces: the portal used to `addDoc` into the Firestore collection
 * `coinPurchaseRequests` and stop. `/coin-purchases` reads the Mongo card board,
 * so a seller's request reached nobody at all — not a bypass of the card flow, a
 * dropped money queue.
 *
 * This raises a real card:
 *   POST /partner-ops/sellers/{id}/coin-purchases
 *   backend/app/routers/partner_ops.py:389 → services/partner_ops.py:1392
 *
 * Nothing is credited here and the dialog says so at every step. The card is
 * verified by a second person, signed by an owner, and only `POST
 * /partner-ops/coin-purchases/{card}/execute` (owner only, routers:427) makes
 * the coins exist.
 *
 * Two things are deliberately not automatic:
 *
 *   * **A USD payment is never converted.** `amount_paid_minor` is paise. The
 *     packs carry a rupee price and a dollar price; multiplying the dollar
 *     figure by 100 would file dollars as rupees. The seller states the rupee
 *     amount that left their account, or leaves the listed rupee price alone.
 *   * **The price list is not invented.** If App Config cannot be read the
 *     dialog says so and takes a coin count and an amount directly, rather than
 *     showing a stale hardcoded table as if it were live pricing.
 */

import { useEffect, useState } from 'react'
import {
  AlertCircle, AlertTriangle, Banknote, Ban, CheckCircle2, ChevronLeft,
  ChevronRight, Copy, Globe, Loader2, Send, ShieldCheck, Upload, Wallet, X,
} from 'lucide-react'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { storage } from '@/lib/firebase'
import { ApiError } from '@/lib/api'
import { inventory, coins as coinText, inr, type PartnerCard } from '@/lib/apiPartners'
import {
  getDiamondPacks, getPaymentCredentials,
  type DiamondPack, type PaymentCredentials,
} from '@/lib/appConfig'
import { getRates, type Rates } from '@/lib/rates'
import { attempt, type ReadResult } from '@/lib/readState'
import { Labelled, inputClass } from './parts'

const MIN_REASON = 3

type Method = 'bank' | 'binance'

interface ProofUpload {
  url: string
  progress: number
  uploading: boolean
  error: string
}

const emptyUpload = (): ProofUpload => ({ url: '', progress: 0, uploading: false, error: '' })

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  if (!value) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-slate-500 text-xs shrink-0">{label}</span>
        <span className="text-slate-600 text-xs">not configured</span>
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-slate-500 text-xs shrink-0">{label}</span>
      <span className="text-white text-xs font-mono text-right break-all flex items-center gap-1.5">
        {value}
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(value).then(
              () => { setCopied(true); setTimeout(() => setCopied(false), 2000) },
              () => { /* clipboard refused — the value is on screen either way */ },
            )
          }}
          className="text-slate-400 hover:text-white shrink-0"
          aria-label={`Copy ${label}`}
        >
          {copied ? <CheckCircle2 size={12} className="text-green-400" /> : <Copy size={12} />}
        </button>
      </span>
    </div>
  )
}

export default function BuyInventoryDialog({
  sellerId,
  sellerName,
  blocked,
  blockReason,
  onClose,
  onRaised,
}: {
  /** The Mongo partner id. `me` is not accepted on this route — it is a POST. */
  sellerId: string
  sellerName: string
  /** From `GET /partners/sellers/{id}/can-take-inventory`. */
  blocked: boolean
  /** The API's own sentence. Shown verbatim. */
  blockReason: string
  onClose: () => void
  onRaised: (card: PartnerCard) => void
}) {
  const [step, setStep] = useState<1 | 2>(1)
  const [method, setMethod] = useState<Method>('bank')

  const [packs, setPacks] = useState<ReadResult<DiamondPack[]> | null>(null)
  const [creds, setCreds] = useState<ReadResult<PaymentCredentials | null> | null>(null)

  const [pack, setPack] = useState<DiamondPack | null>(null)
  const [customCoins, setCustomCoins] = useState('')
  const [rupees, setRupees] = useState('')
  const [paymentRef, setPaymentRef] = useState('')
  const [reason, setReason] = useState('')
  const [rates, setRates] = useState<Rates | null>(null)
  const [proof, setProof] = useState<ProofUpload>(emptyUpload())

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<PartnerCard | null>(null)

  useEffect(() => {
    let live = true
    attempt(getDiamondPacks(), 'diamond packs').then((r) => { if (live) setPacks(r) })
    attempt(getPaymentCredentials(), 'payment credentials').then((r) => { if (live) setCreds(r) })
    // The wholesale rate, so the price is computed rather than typed.
    getRates().then((r) => { if (live) setRates(r) }).catch(() => { if (live) setRates(null) })
    return () => { live = false }
  }, [])

  const packList = packs?.ok
    ? packs.value.filter((p) => p.isActive).sort((a, b) => a.sortOrder - b.sortOrder)
    : []

  const coinsOf = (p: DiamondPack) => p.baseDiamonds + p.bonusDiamonds
  const coinsNum = pack ? coinsOf(pack) : Math.round(Number(customCoins)) || 0

  // One division by 100 in the whole flow, and it is the other way round: the
  // seller types rupees, the API is told paise.
  const minor = Math.round(Number(rupees) * 100) || 0

  /**
   * What these coins cost at the published wholesale rate.
   *
   * The seller used to type this figure from nothing, and the API accepted
   * whatever arrived — so the amount on a purchase was, in the owner's words,
   * random. It is a price list; the price should come from it.
   *
   * A chosen pack is the exact answer. Otherwise it is coins × the rate the
   * economy config publishes. Null when neither is available, and in that case
   * nothing is prefilled and nothing is claimed — an invented price is worse
   * than an empty box.
   */
  const expectedInr: number | null = pack
    // A pack is a QUANTITY, not a price.
    //
    // `pack.priceInr` is computed from the retail rate on the App Config
    // screen — including, confusingly, on the tab labelled "Seller Wholesale".
    // Quoting it here contradicted the line directly below: a seller picking
    // the 1-lakh pack was prefilled ₹2,390 while the API expected ₹2,000, and
    // the purchase was refused for a mismatch the dialog had itself created.
    //
    // The rate is the single source of a price. A pack chooses how many coins.
    ? (rates ? Math.round(coinsOf(pack) * rates.sellerWholesalePerDiamond * 100) / 100 : null)
    // The WHOLESALE rate, not the retail one. `sellerWholesalePerDiamond` is
    // already rupees per single diamond, so multiply — do not divide again.
    //
    // This used `rates.diamond`, which is what a *user* pays. A seller buying
    // at their agreed discount was therefore quoted, and checked against, the
    // price of their own customers — so a correctly-priced purchase looked
    // like a mismatch and was refused. That is the spread the seller exists
    // to earn, and it should never have been treated as an error.
    : rates && coinsNum > 0
      ? Math.round(coinsNum * rates.sellerWholesalePerDiamond * 100) / 100
      : null

  /** What the buyer will pay for the same coins, and so what the seller keeps. */
  const retailInr: number | null =
    rates && coinsNum > 0 ? Math.round(coinsNum * rates.diamond * 100) / 100 : null
  const marginInr: number | null =
    retailInr !== null && expectedInr !== null && retailInr > expectedInr
      ? Math.round((retailInr - expectedInr) * 100) / 100
      : null

  // Offer the computed price. Still editable, because what actually left their
  // bank is the fact — but a figure that disagrees now has to be explained,
  // both here and again server-side, rather than passing silently.
  useEffect(() => {
    if (expectedInr !== null) setRupees(String(expectedInr))
    // Only follows the price; a seller who then edits it keeps their own value
    // until the coins or the pack change again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expectedInr])

  const statedInr = Number(rupees) || 0
  const priceGap =
    expectedInr !== null && statedInr > 0
      ? Math.round((statedInr - expectedInr) * 100) / 100
      : 0
  const priceMismatch = Math.abs(priceGap) > 1

  useEffect(() => {
    if (!reason && coinsNum > 0) {
      setReason(`Paid for ${coinsNum.toLocaleString('en-IN')} coins of inventory.`)
    }
    // Only ever prefills an untouched box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coinsNum])

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const task = uploadBytesResumable(
      ref(storage, `coinPurchases/${sellerId}/${Date.now()}_proof`),
      file,
    )
    setProof({ url: '', progress: 0, uploading: true, error: '' })
    task.on(
      'state_changed',
      (snap) =>
        setProof((s) => ({
          ...s,
          progress: Math.round((snap.bytesTransferred / snap.totalBytes) * 100),
        })),
      (error) =>
        setProof({
          url: '',
          progress: 0,
          uploading: false,
          error: error.message || 'The upload did not complete.',
        }),
      async () => {
        try {
          const url = await getDownloadURL(task.snapshot.ref)
          setProof({ url, progress: 100, uploading: false, error: '' })
        } catch (error) {
          setProof({
            url: '',
            progress: 0,
            uploading: false,
            error:
              error instanceof Error ? error.message : 'The upload finished but could not be read back.',
          })
        }
      },
    )
  }

  const step1Valid = coinsNum > 0
  const step2Valid =
    coinsNum > 0 &&
    paymentRef.trim().length > 0 &&
    reason.trim().length >= MIN_REASON &&
    !proof.uploading &&
    !!proof.url

  async function submit() {
    if (!step2Valid) return
    setBusy(true)
    setErr('')
    try {
      const card = await inventory.requestCoinPurchase(sellerId, {
        coins: coinsNum,
        amount_paid_minor: minor,
        payment_ref: paymentRef.trim(),
        evidence_url: proof.url,
        reason: reason.trim(),
      })
      setDone(card)
      onRaised(card)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'The request was not accepted.')
      setBusy(false)
    }
  }

  // ── Blocked before anything is typed ────────────────────────────────────────
  if (blocked) {
    return (
      <Shell title="Request coin inventory" subtitle={sellerName} onClose={onClose}>
        <div className="p-5 space-y-3">
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3">
            <Ban size={16} className="text-red-400 mt-0.5 shrink-0" />
            <div>
              <p className="text-red-200 text-sm font-semibold">
                You cannot take new inventory right now.
              </p>
              <p className="text-red-100/85 text-sm mt-1">
                {blockReason || 'The API did not give a reason.'}
              </p>
            </div>
          </div>
          <p className="text-slate-500 text-sm">
            Raising a request would be refused by the same rule, so there is
            nothing to fill in here. Clear what is outstanding first — see
            Credit.
          </p>
        </div>
        <Footer>
          <button onClick={onClose} className="text-slate-300 text-sm px-4 py-2.5">
            Close
          </button>
        </Footer>
      </Shell>
    )
  }

  // ── Raised ──────────────────────────────────────────────────────────────────
  if (done) {
    return (
      <Shell title="Request raised" subtitle={sellerName} onClose={onClose}>
        <div className="p-5 space-y-4">
          <div className="flex flex-col items-center text-center gap-2 py-2">
            <ShieldCheck size={40} className="text-green-400" />
            <p className="text-white font-semibold">
              Your request for {coinText(coinsNum)} is on the money board.
            </p>
            <p className="text-slate-400 text-sm max-w-sm">
              It has to be verified by a second person and signed by a business
              owner. <strong className="text-amber-300">No coins exist yet</strong>{' '}
              — and they still will not the moment it is approved. They exist
              when an owner executes it.
            </p>
          </div>

          {done.warning && (
            <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2.5">
              <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
              <p className="text-amber-100 text-sm">{done.warning}</p>
            </div>
          )}

          <dl className="bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3 text-sm space-y-1.5">
            <Row label="Coins requested" value={coinText(coinsNum)} />
            <Row label="Amount stated" value={`${inr(minor)} (INR)`} />
            <Row label="Payment reference" value={paymentRef.trim()} mono />
            <Row label="Card" value={done.id} mono />
          </dl>

          <p className="text-slate-500 text-xs">
            Track it under <strong className="text-slate-300">Purchases</strong>.
            The stage there is the truth about whether your coins exist.
          </p>
        </div>
        <Footer>
          <button
            onClick={onClose}
            className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Done
          </button>
        </Footer>
      </Shell>
    )
  }

  // ── The form ────────────────────────────────────────────────────────────────
  return (
    <Shell
      title="Request coin inventory"
      subtitle={`${sellerName} · step ${step} of 2`}
      onClose={onClose}
    >
      <div className="p-5 space-y-4">
        <p className="text-slate-400 text-sm">
          This raises a card. It moves nothing — a second person verifies your
          payment, an owner signs it, and only then are coins credited.
        </p>

        {step === 1 && (
          <>
            <div>
              <p className="text-slate-400 text-[11px] font-medium uppercase tracking-wide mb-2">
                How you are paying
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setMethod('bank')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                    method === 'bank'
                      ? 'border-pink-500 bg-pink-500/10 text-pink-200'
                      : 'border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  <Banknote size={15} /> Bank (₹)
                </button>
                <button
                  type="button"
                  onClick={() => setMethod('binance')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                    method === 'binance'
                      ? 'border-pink-500 bg-pink-500/10 text-pink-200'
                      : 'border-slate-700 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  <Globe size={15} /> Binance ($)
                </button>
              </div>
            </div>

            {/* Where to send it */}
            {creds === null ? (
              <div className="flex items-center gap-2 text-slate-500 text-sm py-3">
                <Loader2 size={14} className="animate-spin" /> Reading the payment details…
              </div>
            ) : !creds.ok ? (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3">
                <p className="text-yellow-300 text-sm font-medium">
                  The payment details could not be read.
                </p>
                <p className="text-slate-400 text-sm mt-1">{creds.reason}</p>
                <p className="text-slate-500 text-xs mt-1">
                  Do not guess an account number. Ask us for it before you pay.
                </p>
              </div>
            ) : creds.value === null ? (
              <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3">
                <p className="text-yellow-300 text-sm font-medium">
                  No payment details are configured yet.
                </p>
                <p className="text-slate-400 text-sm mt-1">
                  Ask us where to send the money before you transfer anything.
                </p>
              </div>
            ) : method === 'bank' ? (
              <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-2">
                <p className="text-pink-300 text-[11px] font-semibold uppercase tracking-wide">
                  Our bank account
                </p>
                <CopyRow label="Bank" value={creds.value.bankName} />
                <CopyRow label="Account no." value={creds.value.bankAccount} />
                <CopyRow label="IFSC" value={creds.value.bankIfsc} />
                <CopyRow label="Account name" value={creds.value.bankHolder} />
                <CopyRow label="Branch" value={creds.value.bankBranch} />
                <p className="text-amber-300 text-xs flex items-start gap-1.5 pt-2 border-t border-slate-700">
                  <AlertCircle size={12} className="shrink-0 mt-0.5" />
                  Keep the UTR. It is how your payment is matched, and you will be
                  asked for it on the next step.
                </p>
              </div>
            ) : (
              <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-2">
                <p className="text-pink-300 text-[11px] font-semibold uppercase tracking-wide">
                  Binance Pay
                </p>
                <CopyRow label="Binance UID" value={creds.value.binanceUid} />
                <p className="text-amber-300 text-xs flex items-start gap-1.5 pt-2 border-t border-slate-700">
                  <AlertCircle size={12} className="shrink-0 mt-0.5" />
                  Keep the transaction id. The card records a{' '}
                  <strong>rupee</strong> amount — nothing here converts dollars
                  for you.
                </p>
              </div>
            )}

            {/* What you are buying */}
            <div>
              <p className="text-slate-400 text-[11px] font-medium uppercase tracking-wide mb-2">
                How many coins
              </p>
              {packs === null ? (
                <div className="flex items-center gap-2 text-slate-500 text-sm py-3">
                  <Loader2 size={14} className="animate-spin" /> Reading the price list…
                </div>
              ) : !packs.ok ? (
                <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3 mb-3">
                  <p className="text-yellow-300 text-sm font-medium">
                    The price list could not be read, so no packs are shown.
                  </p>
                  <p className="text-slate-400 text-sm mt-1">{packs.reason}</p>
                  <p className="text-slate-500 text-xs mt-1">
                    This is not &ldquo;no packs&rdquo;. Enter what you actually
                    bought below, or ask us for the current prices.
                  </p>
                </div>
              ) : packList.length === 0 ? (
                <p className="text-slate-500 text-sm mb-3">
                  No packs are on sale at the moment. Enter what you agreed with
                  us below.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
                  {packList.map((p) => {
                    const on = pack?.id === p.id
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => { setPack(p); setCustomCoins('') }}
                        className={`flex flex-col items-center gap-1 px-2 py-3 rounded-xl border text-center transition-colors ${
                          on
                            ? 'border-pink-500 bg-pink-500/10'
                            : 'border-slate-700 bg-slate-800 hover:border-slate-600'
                        }`}
                      >
                        <span className="text-[11px] text-slate-400">{p.label}</span>
                        <span className={`text-sm font-bold ${on ? 'text-pink-200' : 'text-white'}`}>
                          {coinsOf(p).toLocaleString('en-IN')}
                        </span>
                        <span className="text-[11px] text-slate-400">
                          ₹{p.priceInr.toLocaleString('en-IN')}
                          <span className="text-slate-600"> / ${p.priceUsd}</span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}

              <Labelled
                label={pack ? 'Or a different number of coins' : 'Coins'}
                hint="Coins, not rupees. The rupee amount is the next field."
              >
                <input
                  value={pack ? '' : customCoins}
                  onChange={(e) => {
                    setPack(null)
                    setCustomCoins(e.target.value.replace(/[^0-9]/g, ''))
                  }}
                  inputMode="numeric"
                  placeholder={pack ? coinsOf(pack).toLocaleString('en-IN') : '100000'}
                  className={inputClass}
                />
              </Labelled>
            </div>

            {coinsNum > 0 && (
              <p className="text-slate-300 text-sm bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2.5">
                Requesting {coinText(coinsNum)}.
              </p>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <dl className="bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3 text-sm space-y-1.5">
              <Row label="Coins" value={coinText(coinsNum)} />
              {expectedInr !== null && (
                <Row
                  label="Price for these coins"
                  value={`₹${expectedInr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`}
                />
              )}
              <Row label="Paying by" value={method === 'bank' ? 'Bank transfer' : 'Binance Pay'} />
            </dl>

            {expectedInr !== null && (
              <p className="text-slate-500 text-xs mb-3 leading-relaxed">
                This is what {coinText(coinsNum)} cost you at the wholesale
                rate. Pay this amount into the account above, then enter the
                reference below.
              </p>
            )}

            {/* The margin, stated plainly. A seller should be able to see what
                they make on a purchase before committing to it, and it is the
                reason the wholesale price exists at all. */}
            {marginInr !== null && retailInr !== null && expectedInr !== null && (
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3.5 py-3 mb-3">
                <p className="text-emerald-200 text-sm">
                  You keep{' '}
                  <strong>
                    ₹{marginInr.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </strong>{' '}
                  on these coins
                </p>
                <p className="text-emerald-100/80 text-xs mt-1 leading-relaxed">
                  You pay ₹{expectedInr.toLocaleString('en-IN')} for them and
                  buyers pay ₹{retailInr.toLocaleString('en-IN')}. You collect
                  that difference from the buyer directly — Zipper never handles
                  it, so there is nothing to claim and nothing to wait for.
                </p>
              </div>
            )}

            {priceMismatch && (
              <div className="bg-amber-500/10 border border-amber-500/40 rounded-lg px-3.5 py-3 mb-3">
                <p className="text-amber-200 text-sm font-medium">
                  {priceGap > 0 ? 'That is more' : 'That is less'} than the price
                  — by ₹{Math.abs(priceGap).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </p>
                <p className="text-amber-100/90 text-xs mt-1.5 leading-relaxed">
                  {coinText(coinsNum)} cost ₹
                  {expectedInr?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}.
                  If that is genuinely what left your account, say why in the
                  reason below — a bank fee, a part payment, an agreed rate. The
                  request is refused without it, because after an owner signs it
                  this becomes what you paid us.
                </p>
              </div>
            )}

            <Labelled
              label="Amount you paid (₹, rupees)"
              hint={
                method === 'binance' ? (
                  <span className="text-amber-300">
                    You are paying in dollars. Nothing here converts that. Enter
                    the rupee amount our account will receive, or leave the pack
                    price — do not type the dollar figure.
                  </span>
                ) : (
                  <>Recorded on the card as {inr(minor)}.</>
                )
              }
            >
              <input
                value={rupees}
                onChange={(e) => setRupees(e.target.value.replace(/[^0-9.]/g, ''))}
                inputMode="decimal"
                placeholder="2290"
                className={inputClass}
              />
            </Labelled>

            <Labelled
              label={method === 'bank' ? 'UTR / reference number' : 'Binance transaction id'}
              hint="This is how your money is matched to your request. Without it nobody can confirm you paid."
            >
              <input
                value={paymentRef}
                onChange={(e) => setPaymentRef(e.target.value)}
                placeholder={method === 'bank' ? '431234567890' : '432987654321098765'}
                className={`${inputClass} font-mono`}
              />
            </Labelled>

            <Labelled label="Payment proof">
              {proof.url ? (
                <div className="relative">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={proof.url}
                    alt="Payment proof"
                    className="w-full h-36 object-cover rounded-xl border border-slate-700"
                  />
                  <button
                    type="button"
                    onClick={() => setProof(emptyUpload())}
                    className="absolute top-2 right-2 w-6 h-6 bg-black/70 hover:bg-black rounded-full flex items-center justify-center text-white"
                    aria-label="Remove the proof"
                  >
                    <X size={12} />
                  </button>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center gap-2 w-full h-28 border-2 border-dashed border-slate-700 rounded-xl cursor-pointer hover:border-pink-500/50 transition-colors bg-slate-800/40">
                  {proof.uploading ? (
                    <>
                      <Loader2 size={20} className="animate-spin text-pink-400" />
                      <span className="text-slate-400 text-xs">Uploading {proof.progress}%…</span>
                    </>
                  ) : (
                    <>
                      <Upload size={20} className="text-slate-500" />
                      <span className="text-slate-400 text-xs">Screenshot of the transfer</span>
                    </>
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={onFile}
                    disabled={proof.uploading}
                  />
                </label>
              )}
              {proof.error && <p className="text-red-300 text-xs mt-1">{proof.error}</p>}
            </Labelled>

            <Labelled
              label="Reason"
              hint="Kept on the card and in the audit log. At least three characters."
            >
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className={`${inputClass} resize-none`}
              />
            </Labelled>
          </>
        )}

        {err && (
          <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {err}
          </p>
        )}
      </div>

      <Footer>
        {step === 1 ? (
          <>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-sm px-4 py-2.5">
              Cancel
            </button>
            <button
              onClick={() => { setErr(''); setStep(2) }}
              disabled={!step1Valid}
              className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors"
            >
              Next <ChevronRight size={15} />
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => { setErr(''); setStep(1) }}
              className="flex items-center gap-1.5 text-slate-400 hover:text-white text-sm px-3 py-2.5"
            >
              <ChevronLeft size={15} /> Back
            </button>
            <button
              onClick={submit}
              disabled={!step2Valid || busy}
              className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Raise the request
            </button>
          </>
        )}
      </Footer>
    </Shell>
  )
}

// ── Chrome ────────────────────────────────────────────────────────────────────

function Shell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string
  subtitle: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-0 sm:p-4 bg-black/70 backdrop-blur-sm overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 sm:rounded-xl w-full max-w-lg min-h-full sm:min-h-0 sm:my-8">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <div className="min-w-0">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <Wallet size={16} className="text-pink-400 shrink-0" /> {title}
            </h2>
            <p className="text-slate-500 text-xs mt-0.5 truncate">{subtitle}</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800 sticky bottom-0 bg-slate-900">
      {children}
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-slate-500 shrink-0">{label}</dt>
      <dd className={`text-slate-200 text-right break-all ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </dd>
    </div>
  )
}
