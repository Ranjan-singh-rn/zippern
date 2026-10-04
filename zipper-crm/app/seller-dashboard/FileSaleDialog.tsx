'use client'

/**
 * Filing a sale — through the API, where it can be approved by an owner.
 *
 * What this replaces: the portal used to `addDoc` into the Firestore collection
 * `rechargeRequests`. When staff flipped that document to `approved`, the Cloud
 * Function `onRechargeApproved` (functions/src/index.ts § 2) deducted
 * `sellers/{id}.coinBalance` and credited the buyer's diamonds — a balance
 * moving on a trigger, with no card, no ledger entry, no owner signature and no
 * audit trail. A browser write started that.
 *
 * This files a sale instead:
 *   POST /partner-ops/sales — backend/app/routers/partner_ops.py:535
 *                           → services/partner_ops.py:1988
 *
 * Filing moves nothing; the sale sits at `pending`. Approval is owner-only
 * (routers/partner_ops.py:563) and debits the seller's coin inventory FIRST,
 * then credits the buyer — so a seller short of stock stops the sale before any
 * diamonds exist (services/partner_ops.py:2049).
 *
 * The buyer is a **user**: `approve_sale` credits `HolderType.USER` in
 * diamonds. There is no path in the API that credits an agency, so this picker
 * lists app users only.
 */

import { useEffect, useMemo, useState } from 'react'
import { collection, getDocs, limit as fsLimit, orderBy, query } from 'firebase/firestore'
import {
  AlertTriangle, CheckCircle2, Gem, Loader2, Search, Send, X,
} from 'lucide-react'
import { db } from '@/lib/firebase'
import api, { ApiError, type Sale } from '@/lib/api'
import { inr } from '@/lib/apiPartners'
import { attempt, type ReadFailure, type ReadResult } from '@/lib/readState'
import { Labelled, inputClass } from './parts'

const MIN_REASON = 3

interface Buyer {
  uid: string
  name: string
  phone: string
  email: string
}

async function loadBuyers(): Promise<Buyer[]> {
  const snap = await getDocs(
    query(collection(db, 'users'), orderBy('name'), fsLimit(100)),
  )
  return snap.docs.map((d) => {
    const data = d.data() as { name?: string; displayName?: string; phone?: string; email?: string }
    return {
      uid: d.id,
      name: data.name || data.displayName || 'Unnamed',
      phone: data.phone ?? '',
      email: data.email ?? '',
    }
  })
}

export default function FileSaleDialog({
  sellerId,
  onHand,
  onHandFailure,
  onClose,
  onFiled,
}: {
  sellerId: string
  /**
   * Coins actually held, from the ledger. Approval debits against this.
   *
   * `undefined` means the balance was **not read** — not that it is zero. It
   * used to arrive here as `?? 0`, which put "You hold 🪙 0 coins" at the top of
   * this dialog and flagged every figure the seller typed as more than they
   * hold. Both sentences were a refused read wearing the clothes of a
   * measurement. Nothing about what may be filed depends on this number: the
   * stock check that matters happens at approval, on the server
   * (services/partner_ops.py:2049), against the ledger rather than against
   * anything this screen believes.
   */
  onHand: number | undefined
  /** Why it was not read, when there is a reason worth putting on screen. */
  onHandFailure?: ReadFailure
  onClose: () => void
  onFiled: (sale: Sale) => void
}) {
  const [buyers, setBuyers] = useState<ReadResult<Buyer[]> | null>(null)
  const [term, setTerm] = useState('')
  const [buyer, setBuyer] = useState<Buyer | null>(null)
  const [manualUid, setManualUid] = useState('')
  const [diamonds, setDiamonds] = useState('')
  const [rupees, setRupees] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState<Sale | null>(null)

  useEffect(() => {
    let live = true
    attempt(loadBuyers(), 'buyers').then((r) => { if (live) setBuyers(r) })
    return () => { live = false }
  }, [])

  const visible = useMemo(() => {
    if (!buyers?.ok) return []
    const t = term.trim().toLowerCase()
    const list = buyers.value
    if (!t) return list.slice(0, 25)
    return list
      .filter(
        (b) =>
          b.name.toLowerCase().includes(t) ||
          b.email.toLowerCase().includes(t) ||
          b.phone.includes(t) ||
          b.uid.toLowerCase().includes(t),
      )
      .slice(0, 25)
  }, [buyers, term])

  const buyerUid = buyer?.uid ?? manualUid.trim()
  const diamondsNum = Math.round(Number(diamonds)) || 0
  const minor = Math.round(Number(rupees) * 100) || 0
  const valid =
    buyerUid.length > 0 && diamondsNum > 0 && reason.trim().length >= MIN_REASON

  async function submit() {
    if (!valid) return
    setBusy(true)
    setErr('')
    try {
      const sale = await api.partnerOps.recordSale({
        seller_id: sellerId,
        buyer_uid: buyerUid,
        diamonds: diamondsNum,
        amount_paid_minor: minor,
        reason: reason.trim(),
      })
      setDone(sale)
      onFiled(sale)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'The sale was not accepted.')
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-0 sm:p-4 bg-black/70 backdrop-blur-sm overflow-y-auto">
      <div className="bg-slate-900 border border-slate-800 sm:rounded-xl w-full max-w-lg min-h-full sm:min-h-0 sm:my-8">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-800 sticky top-0 bg-slate-900 z-10">
          <div className="min-w-0">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <Gem size={16} className="text-yellow-400 shrink-0" />
              {done ? 'Sale filed' : 'File a sale'}
            </h2>
            {onHand === undefined ? (
              <p className="text-yellow-400/80 text-xs mt-0.5">
                How many coins you hold could not be read — this is not zero.
                {onHandFailure ? ` ${onHandFailure.reason}` : ''} You can still
                file the sale; the stock check happens at approval either way.
              </p>
            ) : (
              <p className="text-slate-500 text-xs mt-0.5">
                You hold 🪙 {onHand.toLocaleString('en-IN')} coins
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white shrink-0" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {done ? (
          <>
            <div className="p-5 space-y-4">
              <div className="flex flex-col items-center text-center gap-2 py-2">
                <CheckCircle2 size={40} className="text-green-400" />
                <p className="text-white font-semibold">
                  Filed — 💎 {diamondsNum.toLocaleString('en-IN')} diamonds
                </p>
                <p className="text-slate-400 text-sm max-w-sm">
                  Nothing has moved. A business owner approves it, and that is
                  the moment your coins come down and the buyer&rsquo;s diamonds
                  go up. If you are short of stock at that moment the sale stops
                  before any diamonds exist.
                </p>
              </div>
              <p className="text-slate-600 text-xs font-mono break-all">Sale {done.id}</p>
            </div>
            <div className="px-5 py-4 border-t border-slate-800">
              <button
                onClick={onClose}
                className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="p-5 space-y-4">
              <p className="text-slate-400 text-sm">
                Filing a sale moves nothing. An owner approves it, and only then
                does your inventory come down.
              </p>

              <Labelled label="Buyer">
                {buyer ? (
                  <div className="flex items-center gap-3 px-3 py-2.5 bg-slate-800 border border-slate-700 rounded-xl">
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{buyer.name}</p>
                      <p className="text-slate-500 text-xs truncate">
                        {buyer.email || buyer.phone || buyer.uid}
                      </p>
                    </div>
                    <button
                      onClick={() => setBuyer(null)}
                      className="text-slate-400 hover:text-white text-xs underline underline-offset-2 shrink-0"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="relative">
                      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                      <input
                        value={term}
                        onChange={(e) => setTerm(e.target.value)}
                        placeholder="Search by name, email, phone or uid"
                        className={`${inputClass} pl-9`}
                      />
                    </div>

                    {buyers === null ? (
                      <p className="flex items-center gap-2 text-slate-500 text-xs mt-2">
                        <Loader2 size={12} className="animate-spin" /> Loading buyers…
                      </p>
                    ) : !buyers.ok ? (
                      <div className="mt-2 bg-yellow-500/10 border border-yellow-500/30 rounded-lg px-3 py-2">
                        <p className="text-yellow-300 text-xs font-medium">
                          The buyer list could not be read. This is not
                          &ldquo;no buyers&rdquo;.
                        </p>
                        <p className="text-slate-400 text-xs mt-1">{buyers.reason}</p>
                        <p className="text-slate-500 text-xs mt-1">
                          Enter the buyer&rsquo;s uid directly below.
                        </p>
                      </div>
                    ) : visible.length === 0 ? (
                      <p className="text-slate-500 text-xs mt-2">
                        {term ? 'No buyer matches that.' : 'No buyers were returned.'}
                      </p>
                    ) : (
                      <div className="mt-2 space-y-1.5 max-h-52 overflow-y-auto">
                        {visible.map((b) => (
                          <button
                            key={b.uid}
                            onClick={() => { setBuyer(b); setManualUid('') }}
                            className="w-full text-left px-3 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg"
                          >
                            <p className="text-white text-sm truncate">{b.name}</p>
                            <p className="text-slate-500 text-xs truncate">
                              {b.email || b.phone || b.uid}
                            </p>
                          </button>
                        ))}
                      </div>
                    )}

                    <input
                      value={manualUid}
                      onChange={(e) => setManualUid(e.target.value)}
                      placeholder="…or paste the buyer's uid"
                      className={`${inputClass} font-mono mt-2`}
                    />
                  </>
                )}
              </Labelled>

              <Labelled
                label="Diamonds sold"
                hint={
                  onHand === undefined ? (
                    // No balance was read, so there is nothing to compare
                    // against. Saying "more than you hold" from a zero we never
                    // measured would be inventing the comparison.
                    'The same number comes off your coin inventory when it is approved. Whether you hold enough could not be checked here — approval checks it against the ledger.'
                  ) : diamondsNum > onHand ? (
                    <span className="text-amber-300">
                      More than the 🪙 {onHand.toLocaleString('en-IN')} you hold.
                      You can still file it, but approval will stop if you are
                      still short then.
                    </span>
                  ) : (
                    'The same number comes off your coin inventory when it is approved.'
                  )
                }
              >
                <input
                  value={diamonds}
                  onChange={(e) => setDiamonds(e.target.value.replace(/[^0-9]/g, ''))}
                  inputMode="numeric"
                  placeholder="1000"
                  className={inputClass}
                />
              </Labelled>

              <Labelled
                label="Amount you took (₹, rupees)"
                hint={`Recorded as ${inr(minor)}.`}
              >
                <input
                  value={rupees}
                  onChange={(e) => setRupees(e.target.value.replace(/[^0-9.]/g, ''))}
                  inputMode="decimal"
                  placeholder="499"
                  className={inputClass}
                />
              </Labelled>

              <Labelled label="Reason" hint="Kept on the sale and in the audit log.">
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                  placeholder="Diamonds sold to a customer, paid by UPI."
                  className={`${inputClass} resize-none`}
                />
              </Labelled>

              {err && (
                <p className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-red-300 text-sm">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {err}
                </p>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800 sticky bottom-0 bg-slate-900">
              <button onClick={onClose} className="text-slate-400 hover:text-white text-sm px-4 py-2.5">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={!valid || busy}
                className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-yellow-500 hover:bg-yellow-400 disabled:bg-slate-800 disabled:text-slate-600 text-black font-semibold rounded-lg px-5 py-2.5 text-sm transition-colors"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                File the sale
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
