'use client'

/**
 * "Also run an agency" / "Also sell coins" — the application, on the dashboard
 * of the business they already have.
 *
 * Renders nothing unless this login could actually file one: an approved
 * partner holding exactly one capability, with no application outstanding. So a
 * partner who holds both, or is still waiting on their first approval, sees no
 * trace of it.
 *
 * Filing changes nothing about the business they already run. It creates a
 * second, empty partner record and puts it in the queue staff already use.
 * Nothing is granted, no balance is opened and no money moves until a reviewer
 * approves it against a mandatory reason — and an opening coin load is a
 * separate signed card after that.
 *
 * The reviewer needs to know why, so the reason is a required field on the form.
 * No `window.prompt`: this asks for three things, has to be validated, and has
 * to be able to show a refusal.
 */

import { useEffect, useState } from 'react'
import { Building2, ShoppingBag, Clock, ArrowRight, X, Loader2, AlertTriangle } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import {
  availableSecondRole,
  heldPartnerRecords,
  requestSecondRole,
  type HeldPartnerRecords,
  secondRoleRefusal,
  SecondRoleError,
} from '@/lib/partnerRoles'
import {
  PARTNER_ROLE_LABEL,
  partnerRoleStatus,
  partnerRolesOf,
  primaryPartnerRole,
  type PartnerRole,
} from '@/lib/auth'

const ICON: Record<PartnerRole, React.ElementType> = {
  agency: Building2,
  seller: ShoppingBag,
}

const PITCH: Record<PartnerRole, string> = {
  agency:
    'Run an agency on this same login — sign hosts, raise their salary requests and earn commission.',
  seller:
    'Sell coins on this same login — hold your own inventory and fulfil recharge requests.',
}

const NAME_LABEL: Record<PartnerRole, string> = {
  agency: 'Agency name',
  seller: 'Coin shop name',
}

export function SecondRoleCard() {
  const { crmUser } = useAuth()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [filed, setFiled] = useState('')
  const [refusal, setRefusal] = useState('')

  // What the partner RECORDS say this login holds, rather than the
  // denormalised `crmUsers.agencyId` copy of it. Undefined until the query
  // comes back, which is what the first render uses — and on that render
  // `availableSecondRole` falls back to the old field, so the card can appear
  // and then withdraw. That is the right way round: offering and retracting
  // costs a flicker, while the reverse offers an application the API will
  // refuse.
  const [held, setHeld] = useState<HeldPartnerRecords | undefined>(undefined)

  useEffect(() => {
    if (!crmUser) return
    let live = true
    heldPartnerRecords(crmUser)
      .then((h) => { if (live) setHeld(h) })
      .catch(() => {
        // Not silently "nothing held". `availableSecondRole` makes no offer
        // on an unchecked result, which is the fail-closed answer.
        if (live) setHeld({ checked: false, reason: 'The lookup failed.' })
      })
    return () => { live = false }
  }, [crmUser])

  const available = availableSecondRole(crmUser, held)
  const primary = primaryPartnerRole(crmUser)
  const other: PartnerRole | null =
    primary === 'agency' ? 'seller' : primary === 'seller' ? 'agency' : null
  const otherStatus = other ? partnerRoleStatus(crmUser, other) : 'pending'
  const outstanding =
    !!other && !available && partnerRolesOf(crmUser).includes(other) && otherStatus === 'pending'
  const wasRefused = !!other && !available && otherStatus === 'rejected'

  // The refusal reason lives on the partner document the reviewer rejected, not
  // on the login — one place, written once, by the API.
  useEffect(() => {
    if (!wasRefused || !other) return
    let live = true
    secondRoleRefusal(crmUser, other)
      .then((text) => { if (live) setRefusal(text) })
      .catch(() => { /* the banner reads fine without it */ })
    return () => { live = false }
  }, [crmUser, other, wasRefused])

  useEffect(() => {
    if (crmUser && !phone) setPhone(crmUser.phone ?? '')
  }, [crmUser, phone])

  if (!crmUser || !other) return null
  if (!available && !outstanding && !wasRefused && !filed) return null

  const Icon = ICON[other]
  const label = PARTNER_ROLE_LABEL[other]

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!crmUser) return
    setError('')
    setSubmitting(true)
    try {
      const result = await requestSecondRole(crmUser, { name, phone, reason })
      setFiled(result.partnerId)
      setOpen(false)
    } catch (err) {
      setError(
        err instanceof SecondRoleError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'The application could not be filed. Nothing was changed.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  // ── Already filed, waiting on a reviewer ──────────────────────────────────
  if (outstanding || filed) {
    return (
      <div className="bg-slate-900 border border-yellow-500/30 rounded-xl p-5 mb-6 flex items-start gap-4">
        <div className="w-10 h-10 rounded-full bg-yellow-500/15 border border-yellow-500/30 flex items-center justify-center flex-shrink-0">
          <Clock size={18} className="text-yellow-400" />
        </div>
        <div className="min-w-0">
          <p className="text-white font-semibold">
            {label} application under review
          </p>
          <p className="text-slate-400 text-sm mt-1 leading-relaxed">
            Our team is reviewing it. Nothing about your existing business has
            changed, and the new account holds nothing until it is approved.
          </p>
        </div>
      </div>
    )
  }

  // ── Refused ───────────────────────────────────────────────────────────────
  if (wasRefused) {
    return (
      <div className="bg-slate-900 border border-red-500/30 rounded-xl p-5 mb-6 flex items-start gap-4">
        <div className="w-10 h-10 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center flex-shrink-0">
          <AlertTriangle size={18} className="text-red-400" />
        </div>
        <div className="min-w-0">
          <p className="text-white font-semibold">
            {label} application was not approved
          </p>
          {refusal && (
            <p className="text-slate-300 text-sm mt-1 leading-relaxed">{refusal}</p>
          )}
          <p className="text-slate-500 text-xs mt-2">
            Your existing business is unaffected. Contact us if you would like to
            reapply.
          </p>
        </div>
      </div>
    )
  }

  // ── The offer, and the form ───────────────────────────────────────────────
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-6">
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-full bg-pink-500/15 border border-pink-500/30 flex items-center justify-center flex-shrink-0">
          <Icon size={18} className="text-pink-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white font-semibold">Also become a {label}</p>
          <p className="text-slate-400 text-sm mt-1 leading-relaxed">
            {PITCH[other]} It is a separate account with its own balance — your
            commission and your coin inventory never mix — and it needs the same
            approval as a new application.
          </p>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-pink-500 hover:bg-pink-600 text-white rounded-lg text-sm font-semibold transition-colors flex-shrink-0"
          >
            Apply <ArrowRight size={15} />
          </button>
        )}
        {open && (
          <button
            type="button"
            onClick={() => { setOpen(false); setError('') }}
            className="text-slate-500 hover:text-white transition-colors flex-shrink-0"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {open && (
        <form onSubmit={submit} className="mt-5 space-y-4 border-t border-slate-800 pt-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block">
              <span className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                {NAME_LABEL[other]}
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
                className="mt-1.5 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:border-pink-500 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
                Contact phone
              </span>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                required
                maxLength={24}
                className="mt-1.5 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:border-pink-500 focus:outline-none"
              />
            </label>
          </div>

          <label className="block">
            <span className="text-slate-400 text-xs font-semibold uppercase tracking-wider">
              Why do you want this?
            </span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              minLength={3}
              maxLength={1000}
              rows={3}
              placeholder="The reviewer reads this. Every partner decision is recorded with a reason."
              className="mt-1.5 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:border-pink-500 focus:outline-none resize-none"
            />
          </label>

          {error && (
            <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 px-5 py-2.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-lg text-sm font-semibold transition-colors"
            >
              {submitting && <Loader2 size={15} className="animate-spin" />}
              Submit application
            </button>
            <p className="text-slate-500 text-xs">
              Nothing is granted and no balance is opened until a reviewer approves it.
            </p>
          </div>
        </form>
      )}
    </div>
  )
}

export default SecondRoleCard
