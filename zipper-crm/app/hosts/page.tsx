'use client'

import { useState, useEffect, useMemo } from 'react'
import { useSecureThumbs } from '@/components/useSecureThumbs'
import SecureDocuments from '@/components/SecureDocuments'
import Link from 'next/link'
import { Star, Loader2, Search, ShieldOff, Shield, StarOff, X, Check, AlertTriangle, Clock, Eye, ExternalLink, IndianRupee, Globe, Pencil, Save } from 'lucide-react'
import { getHosts, UserRecord } from '@/lib/firestore'
import api from '@/lib/api'
import { db } from '@/lib/firebase'
// `doc` and `updateDoc` are gone from this file. Nothing here writes a host
// application directly any more — the payout and identity fields go through
// `submitPartnerUpdate`, which is the only shape of write the rules accept.
import { collection, query, where, limit, getDocs, serverTimestamp } from 'firebase/firestore'
import type { Timestamp } from 'firebase/firestore'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { fromSettled, type ReadFailure } from '@/lib/readState'
import { UnavailablePanel, Warning } from '@/components/ui/States'
import { labelOf, submitPartnerUpdate, type Proposer } from '@/lib/pendingChanges'
import { profilePhotoSrc } from '@/lib/profilePhoto'
import { getAgencyNames } from '@/lib/agencies'
import {
  hostTabCounts, linkedApplicationLabel, reconcileHostRows, resolveAgencyName,
  type AgencyLabel,
} from '@/lib/hostRows'

// Host application record (from hostApplications collection)
interface HostApplication {
  id: string
  hostName: string
  applicantPhone: string
  applicantEmail: string
  agencyId?: string
  agencyName?: string
  photoUrl?: string
  callRate?: number
  country?: string
  age?: number
  dob?: string
  crmUid?: string
  referralCode?: string
  paymentType?: 'india' | 'foreign'
  // India bank fields
  accountHolderName?: string
  accountNumber?: string
  ifscCode?: string
  bankName?: string
  branch?: string
  upiId?: string
  // Foreign
  binanceUid?: string
  // KYC
  kycDocUrls?: string[]
  kycStatus?: string
  /**
   * A proposed change to this host's payout or identity details, waiting on a
   * second person. Read it with `readPendingChanges` — it is written by a
   * browser and the rules constrain which key it occupies, not what is in it.
   */
  pendingChanges?: unknown
  /** Why the last proposed change was refused. Written by the server only. */
  pendingChangesRejectionReason?: string
  status: 'pending' | 'approved'
  isActivated: boolean
  /** GOV B08: who redeemed the code — the account this invitation became. */
  activatedByUid?: string
  /** GOV B08: who filed it, on a SELF-application. Never on an invitation. */
  applicantUid?: string
  createdAt?: Timestamp
}

// ── Host Application Modal ────────────────────────────────────────────────────

function Field({ label, value }: { label: string; value?: string | number | null }) {
  if (!value && value !== 0) return null
  return (
    <div className="flex gap-3">
      <span className="text-slate-500 text-sm w-36 shrink-0">{label}</span>
      <span className="text-white text-sm font-medium break-all">{String(value)}</span>
    </div>
  )
}

function HostAppModal({ app, onClose, onSaved, linkedHostName, agency }: {
  app: HostApplication
  onClose: () => void
  onSaved?: (updated: HostApplication) => void
  /**
   * GOV B08: set when this application is a current Host's own (opened from
   * that Host's row). An approved one is then the application that MADE them
   * a Host, not one "awaiting activation".
   */
  linkedHostName?: string
  /** GOV B20: the agency by its current name, resolved from `agencyId`. */
  agency?: AgencyLabel
}) {
  const { crmUser } = useAuth()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving]   = useState(false)
  const [saveErr, setSaveErr] = useState('')
  /** Fields the last save sent for review instead of writing. */
  const [proposed, setProposed] = useState<string[]>([])

  /**
   * Who a proposal is recorded against — the staff member editing, not the
   * host. The four-eyes check on the server compares the applying reviewer's
   * uid against exactly this, which is what stops one person raising a change
   * to a host's bank account and then approving it themselves.
   */
  const proposer: Proposer = {
    uid: crmUser?.uid ?? '',
    name: crmUser?.name ?? '',
    role: crmUser?.role ?? '',
  }

  // Editable fields
  const [hostName, setHostName]         = useState(app.hostName)
  const [phone, setPhone]               = useState(app.applicantPhone)
  const [email, setEmail]               = useState(app.applicantEmail)
  const [age, setAge]                   = useState(String(app.age ?? ''))
  const [dob, setDob]                   = useState(app.dob ?? '')
  const [country, setCountry]           = useState(app.country ?? '')
  const [callRate, setCallRate]         = useState(String(app.callRate ?? ''))
  // Bank fields
  const [accountHolder, setAccountHolder] = useState(app.accountHolderName ?? '')
  const [accountNumber, setAccountNumber] = useState(app.accountNumber ?? '')
  const [ifsc, setIfsc]                   = useState(app.ifscCode ?? '')
  const [bankName, setBankName]           = useState(app.bankName ?? '')
  const [branch, setBranch]               = useState(app.branch ?? '')
  const [upiId, setUpiId]                 = useState(app.upiId ?? '')
  const [binanceUid, setBinanceUid]       = useState(app.binanceUid ?? '')

  const inputCls = "w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500 placeholder-slate-500"

  /**
   * Correct the facts on an application. It does NOT decide one.
   *
   * `kycStatus` used to be in this patch, set from a free-text dropdown beside
   * the call rate, with no reason, no decider and no timestamp — and without
   * `status`, which is the other half of the same decision. So a correction to
   * somebody's IFSC code sat in the same form as "approved", and picking the
   * wrong one from a select silently half-decided an application: `kycStatus`
   * said approved, `status` still said pending, and the two screens that read
   * them disagreed about the host from then on.
   *
   * There is one writer of that decision now — `POST
   * /users/host-applications/{id}/decide`, reached from /kyc — and it writes
   * both fields together against a mandatory reason. This form edits the facts
   * a reviewer is deciding *about*, which is a different job, and it must not be
   * able to do the other one by accident.
   *
   * ── AND MOST OF THOSE FACTS ARE NOW PROPOSED, NOT WRITTEN ──────────────────
   *
   * A host has no dashboard of their own, so this form is where their bank
   * account is changed — by staff, on their behalf. That makes it the host
   * equivalent of an approved agency editing its own payout details, and it is
   * the same risk: one ops_admin, working alone, could point an approved host's
   * earnings at any account they liked and nothing anywhere would show it.
   *
   * `firestore.rules` therefore makes it four-eyes. An admin may PROPOSE a
   * change to a payout or identity field; only a superadmin may write one
   * straight onto the record. `callRate`, `age` and `updatedAt` are not in
   * either set and are written directly by anybody, as they always were —
   * `submitPartnerUpdate` splits the patch and sends each half the way the
   * rules will accept it.
   *
   * A proposal lands in the re-approval queue on /kyc, where a *different*
   * person applies it against a mandatory reason. The server refuses an
   * approver who is also the proposer, so raising one and applying it yourself
   * is not a path even for a superadmin who chose to propose.
   */
  async function handleSave() {
    setSaveErr('')
    setSaving(true)
    try {
      const patch: Record<string, unknown> = {
        hostName:       hostName.trim(),
        applicantPhone: phone.trim(),
        applicantEmail: email.trim().toLowerCase(),
        age:            Number(age) || app.age,
        dob:            dob.trim(),
        country:        country.trim(),
        callRate:       Number(callRate) || app.callRate,
        updatedAt:      serverTimestamp(),
      }
      if (app.paymentType === 'foreign') {
        patch.binanceUid = binanceUid.trim()
      } else {
        patch.accountHolderName = accountHolder.trim()
        patch.accountNumber     = accountNumber.trim()
        patch.ifscCode          = ifsc.trim().toUpperCase()
        patch.bankName          = bankName.trim()
        patch.branch            = branch.trim()
        patch.upiId             = upiId.trim()
      }
      const result = await submitPartnerUpdate({
        collection: 'hostApplications',
        id: app.id,
        patch,
        actor: proposer,
        current: app as unknown as Record<string, unknown>,
        // Only a superadmin may write a host's payout or identity fields
        // straight on — `isAdmin() && (touchesNoSensitiveField() ||
        // isSuperAdmin())` in the rules. Everybody else proposes. Claiming it
        // wrongly does not grant anything: the write is simply refused.
        allowDirect: crmUser?.role === 'superadmin',
      })
      // Only what actually landed is folded into the row on screen. Showing a
      // proposed account number as though it were live would recreate, in the
      // UI, the exact thing the proposal flow exists to prevent.
      const landed = Object.fromEntries(
        result.applied.map((key) => [key, patch[key]]),
      )
      onSaved?.({ ...app, ...landed } as HostApplication)
      setProposed(result.proposed)
      setEditing(false)
    } catch (e: unknown) {
      setSaveErr(e instanceof Error ? e.message : 'Failed to save.')
    } finally {
      setSaving(false)
    }
  }

  const docLabels = app.paymentType === 'foreign'
    ? ['Passport', 'National ID', 'Proof of Address']
    : ['Aadhaar Card', 'PAN Card', 'Bank Passbook']

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800 shrink-0">
          <div className="flex items-center gap-4">
            {/* Initials, not `app.photoUrl`. That field is the host's
                reference photograph in `hostPhotos/{agencyId}/` — identity
                data about a third party, stored as a permanent
                `?alt=media&token=` URL that Storage Rules are never consulted
                for. The photograph itself is still available to a reviewer:
                it comes down labelled "Reference photo" in the signed-URL
                block below, which is the only place it should be rendered. */}
            <div className="w-12 h-12 rounded-full bg-slate-700 flex items-center justify-center text-white font-bold text-lg">
              {app.hostName?.[0]?.toUpperCase() ?? '?'}
            </div>
            <div>
              <h2 className="text-white text-lg font-semibold">{hostName}</h2>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                app.status === 'approved' ? 'bg-blue-500/20 text-blue-300' : 'bg-yellow-500/20 text-yellow-400'
              }`}>
                {app.status === 'approved'
                  ? (linkedHostName ? 'Approved · Host active' : 'Awaiting Activation')
                  : 'Pending Approval'}
              </span>
              {linkedHostName && (
                <p className="text-slate-500 text-xs mt-1">
                  {linkedHostName}&rsquo;s own application — the same person as their Host row.
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!editing ? (
              <button onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white border border-slate-600 rounded-lg text-sm font-medium transition-colors">
                <Pencil size={13} /> Edit
              </button>
            ) : (
              <>
                <button onClick={() => { setEditing(false); setSaveErr('') }}
                  className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 border border-slate-600 rounded-lg text-sm transition-colors">
                  Cancel
                </button>
                <button onClick={handleSave} disabled={saving}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors">
                  {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                  Save
                </button>
              </>
            )}
            <button onClick={onClose} className="text-slate-400 hover:text-white ml-1"><X size={20} /></button>
          </div>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">

          {saveErr && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm flex items-center gap-2">
              <AlertTriangle size={14} /> {saveErr}
            </div>
          )}

          {/* Said plainly, because the fields on screen will not have moved and
              a reviewer who believes they have will not chase the second pair
              of eyes this change is waiting on. */}
          {proposed.length > 0 && (
            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg px-4 py-3 text-blue-200 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <Clock size={14} /> Sent for a second pair of eyes
              </p>
              <p className="mt-1 text-blue-100/85">
                {proposed.map(labelOf).join(', ')}{' '}
                {proposed.length === 1 ? 'is' : 'are'} waiting on review and{' '}
                {proposed.length === 1 ? 'has' : 'have'} NOT changed on this
                record — the host is still paid exactly as before. Somebody else
                applies it from the &ldquo;Changed details&rdquo; queue on{' '}
                <Link href="/kyc" className="underline underline-offset-2 hover:text-white">
                  KYC review
                </Link>
                . You cannot apply a change you proposed yourself.
              </p>
            </div>
          )}

          {/* A change that was looked at and turned down. Written by the server
              and cleared by the next decision, so it is history the moment
              anything else is proposed — which is why it is hidden while one
              is open. */}
          {proposed.length === 0 && app.pendingChangesRejectionReason && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-200 text-sm">
              <p className="font-medium">A proposed change to this host was refused</p>
              <p className="mt-1 text-red-100/85">{app.pendingChangesRejectionReason}</p>
            </div>
          )}

          {/* Identity */}
          <div>
            <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-3">Identity</p>
            {editing ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-slate-500 text-xs block mb-1">Host Name</label>
                    <input value={hostName} onChange={e => setHostName(e.target.value)} className={inputCls} />
                  </div>
                  <div>
                    <label className="text-slate-500 text-xs block mb-1">Phone</label>
                    <input value={phone} onChange={e => setPhone(e.target.value)} className={inputCls} />
                  </div>
                </div>
                <div>
                  <label className="text-slate-500 text-xs block mb-1">Email</label>
                  <input value={email} onChange={e => setEmail(e.target.value)} type="email" className={inputCls} />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-slate-500 text-xs block mb-1">Age</label>
                    <input value={age} onChange={e => setAge(e.target.value)} type="number" className={inputCls} />
                  </div>
                  <div>
                    <label className="text-slate-500 text-xs block mb-1">Date of Birth</label>
                    <input value={dob} onChange={e => setDob(e.target.value)} type="date" className={`${inputCls} [color-scheme:dark]`} />
                  </div>
                  <div>
                    <label className="text-slate-500 text-xs block mb-1">Country</label>
                    <input value={country} onChange={e => setCountry(e.target.value)} className={inputCls} />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Field label="Phone"         value={phone} />
                <Field label="Email"         value={email} />
                <Field label="Age"           value={age} />
                <Field label="Date of Birth" value={dob} />
                <Field label="Country"       value={country} />
                <Field label="CRM UID"       value={app.crmUid} />
              </div>
            )}
          </div>

          {/* Agency & Call Rate */}
          <div>
            <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-3">Agency & Call Rate</p>
            {editing ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-slate-500 text-xs block mb-1">Call Rate (beans/min)</label>
                    <input value={callRate} onChange={e => setCallRate(e.target.value)} type="number" className={inputCls} />
                  </div>
                </div>
                {/* The KYC Status select that used to sit here is gone. It set
                    one of the two fields that record a host's decision, from a
                    dropdown, with no reason and nobody's name against it — see
                    handleSave above. Deciding an application is done on /kyc,
                    against the documents, with a reason. */}
                <p className="text-slate-500 text-xs leading-relaxed">
                  KYC is decided on{' '}
                  <Link href="/kyc" className="text-pink-400 hover:text-pink-300">the KYC review queue</Link>,
                  where the documents are shown and the decision is recorded
                  against your name with a reason. This form corrects the facts
                  on the application; it does not decide it.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {/* GOV B20: the agency document's current name; the name copied
                    onto the application is shown beside it only when it differs. */}
                <Field label="Agency"        value={agency?.label || app.agencyName} />
                <Field label="Name when filed" value={agency?.staleName} />
                <Field label="Agency ID"     value={app.agencyId} />
                <Field label="Call Rate"     value={callRate ? `${callRate} beans/min` : undefined} />
                <Field label="Referral Code" value={app.referralCode} />
                {/* Read-only, and read straight off the document rather than
                    from state this modal can change. */}
                <Field label="KYC Status"    value={app.kycStatus} />
              </div>
            )}
          </div>

          {/* Payment */}
          <div>
            <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-3 flex items-center gap-2">
              Payment
              {app.paymentType === 'foreign'
                ? <><Globe size={12} className="text-slate-400" />International</>
                : <><IndianRupee size={12} className="text-slate-400" />India (Bank)</>}
            </p>
            {editing ? (
              app.paymentType === 'foreign' ? (
                <div>
                  <label className="text-slate-500 text-xs block mb-1">Binance UID</label>
                  <input value={binanceUid} onChange={e => setBinanceUid(e.target.value)} className={inputCls} />
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="text-slate-500 text-xs block mb-1">Account Holder Name</label>
                    <input value={accountHolder} onChange={e => setAccountHolder(e.target.value)} className={inputCls} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-slate-500 text-xs block mb-1">Account Number</label>
                      <input value={accountNumber} onChange={e => setAccountNumber(e.target.value)} className={inputCls} />
                    </div>
                    <div>
                      <label className="text-slate-500 text-xs block mb-1">IFSC Code</label>
                      <input value={ifsc} onChange={e => setIfsc(e.target.value)} className={inputCls} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-slate-500 text-xs block mb-1">Bank Name</label>
                      <input value={bankName} onChange={e => setBankName(e.target.value)} className={inputCls} />
                    </div>
                    <div>
                      <label className="text-slate-500 text-xs block mb-1">Branch</label>
                      <input value={branch} onChange={e => setBranch(e.target.value)} className={inputCls} />
                    </div>
                  </div>
                  <div>
                    <label className="text-slate-500 text-xs block mb-1">UPI ID (optional)</label>
                    <input value={upiId} onChange={e => setUpiId(e.target.value)} className={inputCls} placeholder="name@upi" />
                  </div>
                </div>
              )
            ) : (
              <div className="space-y-2">
                {app.paymentType === 'foreign' ? (
                  <Field label="Binance UID" value={binanceUid} />
                ) : (
                  <>
                    <Field label="Account Holder" value={accountHolder} />
                    <Field label="Account Number" value={accountNumber} />
                    <Field label="IFSC Code"      value={ifsc} />
                    <Field label="Bank Name"      value={bankName} />
                    <Field label="Branch"         value={branch} />
                    <Field label="UPI ID"         value={upiId} />
                  </>
                )}
              </div>
            )}
          </div>

          {/* KYC Docs.

              Fetched from the API behind 15-minute signed URLs rather than
              rendered from `app.kycDocUrls`. Those stored strings are
              `?alt=media&token=` download URLs — permanent bearer credentials
              Storage Rules are never consulted for, so an <img src> here is a
              forever-link to somebody's Aadhaar in the page source. */}
          <div>
            <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-3">KYC Documents</p>
            <SecureDocuments kind="host" recordId={app.id}
              emptyHint="No documents were uploaded with this application." />
          </div>
        </div>
      </div>
    </div>
  )
}

function formatDate(ts: Timestamp | null) {
  if (!ts) return '—'
  try { return new Date(ts.toMillis()).toLocaleDateString('en-IN') } catch { return '—' }
}

type Filter = 'all' | 'active' | 'banned' | 'invited'

type MsgState = { type: 'success' | 'error'; text: string } | null

// Cap on the un-activated host-invitation fetch. hostApplications grows forever
// and is never archived, so this query needs a bound. No orderBy is attached on
// purpose: the query already carries two filters (status IN + isActivated ==),
// and adding an orderBy would demand a composite index that is not declared in
// firestore.indexes.json — the query would fail outright in production. Without
// an orderBy, Firestore returns the first N by document ID, which is
// deterministic; the banner below makes the cap visible when it is reached.
const HOST_APP_FETCH_LIMIT = 300

export default function HostsPage() {
  const { crmUser } = useAuth()
  const canAct = canAccess(crmUser, ['superadmin', 'app_admin', 'app_member', 'ops_admin', 'ops_member'])

  const [hosts, setHosts] = useState<UserRecord[]>([])
  const [hostApps, setHostApps] = useState<HostApplication[]>([])
  const [viewingApp, setViewingApp] = useState<HostApplication | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [msg, setMsg] = useState<MsgState>(null)
  const [hostAppsTruncated, setHostAppsTruncated] = useState(false)
  const [hostsFailure, setHostsFailure] = useState<ReadFailure | null>(null)
  const [hostAppsFailure, setHostAppsFailure] = useState<ReadFailure | null>(null)
  /**
   * GOV B20: agency id → the agency document's CURRENT name. A Host row used
   * to print the raw `users.agencyId`, and an application row the name copied
   * onto the application at filing — a Mongo name that never follows a
   * rename. Both are now named from the agency document, with the id / the
   * copy as the fallback when it cannot be read.
   */
  const [agencyNames, setAgencyNames] = useState<Map<string, string>>(() => new Map())
  const [agencyNamesFailure, setAgencyNamesFailure] = useState<ReadFailure | null>(null)

  // per-row loading and ban-input state
  const [actingUids, setActingUids] = useState<Set<string>>(new Set())
  const [banInputUid, setBanInputUid] = useState<string | null>(null)
  const [banReason, setBanReason] = useState('')

  // `allSettled`, and both failures kept. `.catch(console.error)` left both
  // lists at `[]`, so a refused host read rendered the same "No hosts found"
  // empty state as a platform with no hosts, and a refused application read
  // silently removed the pending-applications section altogether.
  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      getHosts(),
      getDocs(query(
        collection(db, 'hostApplications'),
        where('status', 'in', ['pending', 'approved']),
        where('isActivated', '==', false),
        limit(HOST_APP_FETCH_LIMIT),
      )),
    ]).then(([usersRes, appsRes]) => {
      if (cancelled) return

      const usersRead = fromSettled(usersRes, 'hosts/getHosts')
      if (usersRead.ok) { setHosts(usersRead.value); setHostsFailure(null) }
      else { setHosts([]); setHostsFailure(usersRead) }

      const appsRead = fromSettled(appsRes, 'hosts/hostApplications')
      if (appsRead.ok) {
        setHostApps(appsRead.value.docs.map(d => ({ id: d.id, ...d.data() } as HostApplication)))
        setHostAppsTruncated(appsRead.value.size >= HOST_APP_FETCH_LIMIT)
        setHostAppsFailure(null)
      } else {
        setHostApps([])
        setHostAppsTruncated(false)
        setHostAppsFailure(appsRead)
      }

      setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  // The agencies named on this page, as one stable key — so a ban or an edit
  // that does not move an agency does not re-read the names.
  const agencyIdKey = useMemo(
    () => Array.from(new Set([
      ...hosts.map((h) => h.agencyId),
      ...hostApps.map((a) => a.agencyId ?? ''),
    ].map((id) => String(id ?? '').trim()).filter(Boolean))).sort().join(','),
    [hosts, hostApps],
  )
  useEffect(() => {
    if (loading) return
    let cancelled = false
    // Never rejects: a refused read leaves the map empty for those ids, and
    // every cell then shows the id or the stored copy exactly as before.
    getAgencyNames(agencyIdKey ? agencyIdKey.split(',') : []).then(({ names, failure }) => {
      if (cancelled) return
      setAgencyNames(names)
      setAgencyNamesFailure(failure)
    })
    return () => { cancelled = true }
  }, [loading, agencyIdKey])

  function flash(m: MsgState) {
    setMsg(m)
    setTimeout(() => setMsg(null), 4000)
  }

  function setActing(uid: string, on: boolean) {
    setActingUids(prev => {
      const next = new Set(prev)
      on ? next.add(uid) : next.delete(uid)
      return next
    })
  }

  function updateHost(uid: string, patch: Partial<UserRecord>) {
    setHosts(prev => prev.map(h => h.uid === uid ? { ...h, ...patch } : h))
  }

  async function handleBan(uid: string) {
    if (!banReason.trim()) return
    setActing(uid, true)
    try {
      /*
       * Through the API, not a direct Firestore write.
       *
       * `banUser` in lib/firestore.ts wrote `isBanned` straight onto the
       * document — no audit entry, no actor recorded, no device ban, and no
       * reason kept on the unban. It was a second, parallel moderation system
       * reachable only from this page, and an account banned here looked
       * identical to one that had never been touched by anybody.
       *
       * `api.users.ban` is the one the user profile uses: audited to Mongo with
       * a named actor and a mandatory reason, and it bars the account's devices.
       */
      await api.users.ban(uid, banReason)
      updateHost(uid, { isBanned: true })
      setBanInputUid(null)
      setBanReason('')
      flash({ type: 'success', text: 'Host banned.' })
    } catch {
      flash({ type: 'error', text: 'Failed to ban host.' })
    } finally {
      setActing(uid, false)
    }
  }

  async function handleUnban(uid: string) {
    setActing(uid, true)
    try {
      // Same reason as the ban above. The API records who lifted it and why,
      // and releases only the device bans this account's ban created.
      await api.users.unban(uid, 'Unbanned from the hosts list.')
      updateHost(uid, { isBanned: false })
      flash({ type: 'success', text: 'Host unbanned.' })
    } catch {
      flash({ type: 'error', text: 'Failed to unban host.' })
    } finally {
      setActing(uid, false)
    }
  }

  /*
   * Phase 1A (SECURITY-004 / ROLE-001): host status is changed through the API
   * only. `makeHost` / `removeHost` wrote `users.isHost` straight from the
   * browser — no eligibility matrix, no agency roster, no audit — and the rules
   * now refuse that write for every staff role. `revoke-host` is the one path
   * that checks, writes the roster and records who did it. There is no
   * "make host" button: a host is created by an approved application.
   *
   * Success is reported only after the server answers, and the server's own
   * refusal text is shown rather than a generic "failed".
   */
  // UGP-B: there is no Remove button on this list any more. Revoking Host is
  // role-aware — refused when Host is the person's only role, offered only
  // once their roles are known — so it lives in the Roles block of the
  // person's page (`/users/[uid]`), which this list links to.

  // ── GOV B08: one row per PERSON ───────────────────────────────────────────
  //
  // The two reads used to be concatenated with no join, so an approved
  // SELF-application (it carries `applicantUid`, never `activatedByUid`, and
  // approval did not stamp `isActivated`) listed its Host twice — "Active" and
  // "Awaiting Activation" — and every tab added both. An application whose
  // `activatedByUid || applicantUid` is a current Host is now on that Host's
  // row ("via application <id>"); an invitation carrying a Host's own phone or
  // email is shown flagged and not counted again. Nothing is dropped.
  const reconciled = useMemo(() => reconcileHostRows(hosts, hostApps), [hosts, hostApps])

  const filteredHosts = useMemo(() => {
    let list = reconciled.hostRows
    if (filter === 'active') list = list.filter(r => !r.host.isBanned)
    if (filter === 'banned') list = list.filter(r => r.host.isBanned)
    if (filter === 'invited') list = []
    if (search.trim()) {
      const q = search.toLowerCase().trim()
      list = list.filter(({ host: h }) =>
        h.name.toLowerCase().includes(q) ||
        h.phoneNumber.includes(q) ||
        h.email.toLowerCase().includes(q)
      )
    }
    return list
  }, [reconciled, filter, search])

  const filteredApps = useMemo(() => {
    if (filter === 'active' || filter === 'banned') return []
    if (search.trim()) {
      const q = search.toLowerCase().trim()
      return reconciled.applicationRows.filter(({ app: a }) =>
        a.hostName.toLowerCase().includes(q) ||
        a.applicantPhone.includes(q) ||
        a.applicantEmail.toLowerCase().includes(q) ||
        (a.agencyName ?? '').toLowerCase().includes(q) ||
        (agencyNames.get(a.agencyId ?? '') ?? '').toLowerCase().includes(q)
      )
    }
    return reconciled.applicationRows
  }, [reconciled, filter, search, agencyNames])


  // ── Reference photographs, one request for the whole page ────────────────
  //
  // `app.photoUrl` is the host's reference photograph in
  // `hostPhotos/{agencyId}/` — identity data about a third party, stored as a
  // permanent `?alt=media&token=` URL that Storage Rules are never consulted
  // for. Rendering it put a forever-link to somebody's face in the page
  // source, fifty at a time.
  //
  // One batch request per page rather than one per row: the per-row cost is
  // precisely why this list was still on the insecure URL.
  const appPhotos = useSecureThumbs(
    'host',
    useMemo(() => filteredApps.map((r) => r.app.id), [filteredApps]),
    'photo',
  )

  // A tally over a list that was never read is not a tally. When either read
  // failed the tabs carry their labels alone rather than a count of nothing.
  // GOV B08: the counts are PEOPLE — `All` is Active + Banned + Invited, and a
  // flagged invitation (an existing Host's contact) is in none of them.
  const counts = hostTabCounts(reconciled, (h) => h.isBanned)
  const countsAreReal = !hostsFailure && !hostAppsFailure
  const n = (value: number) => (countsAreReal ? ` (${value})` : '')
  const tabs: { key: Filter; label: string }[] = [
    { key: 'all',     label: `All${n(counts.all)}` },
    { key: 'active',  label: `Active${n(counts.active)}` },
    { key: 'banned',  label: `Banned${n(counts.banned)}` },
    { key: 'invited', label: `Invited${n(counts.invited)}` },
  ]
  const shownPeople = filteredHosts.length + filteredApps.filter((r) => !r.sameContactAs).length
  const shownFlagged = filteredApps.length - filteredApps.filter((r) => !r.sameContactAs).length
  /** The Host row an open application belongs to, if it is a Host's own. */
  const viewingHost = viewingApp
    ? reconciled.hostRows.find((r) => r.applications.some((a) => a.id === viewingApp.id))?.host ?? null
    : null

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white">Host Management</h1>
        <p className="text-slate-400 mt-1">All verified hosts on the platform</p>
      </div>

      {/* Flash message */}
      {msg && (
        <div className={`mb-4 flex items-center justify-between gap-3 px-4 py-3 rounded-xl text-sm border ${
          msg.type === 'success'
            ? 'bg-green-500/10 border-green-500/30 text-green-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          <span className="flex items-center gap-2">
            {msg.type === 'success' ? <Check size={15} /> : <AlertTriangle size={15} />}
            {msg.text}
          </span>
          <button onClick={() => setMsg(null)}><X size={14} /></button>
        </div>
      )}

      {/* The invitation queue is a separate read from the host list. When only
          it failed, the host table below is still trustworthy — say which one
          went missing instead of colouring the whole page as broken. */}
      {hostAppsFailure && !hostsFailure && (
        <Warning>
          Pending host invitations could not be read, so none are listed below and
          the tab counts exclude them. This is not &ldquo;no pending
          invitations&rdquo;. {hostAppsFailure.reason}
        </Warning>
      )}

      {/* Truncation notice — the invitation queue came back at its cap */}
      {hostAppsTruncated && (
        <div className="mb-4 flex items-start gap-2 px-4 py-3 rounded-xl text-sm border bg-yellow-500/10 border-yellow-500/30 text-yellow-400">
          <AlertTriangle size={15} className="mt-0.5 flex-shrink-0" />
          <span>
            Showing the first {HOST_APP_FETCH_LIMIT} un-activated host invitations —{' '}
            {HOST_APP_FETCH_LIMIT}+ exist. The rest are not listed here and search will not find them.
          </span>
        </div>
      )}

      {/* Search + filter bar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, phone, or email…"
            className="w-full pl-9 pr-4 py-2.5 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 text-sm focus:outline-none focus:border-pink-500 transition"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white">
              <X size={14} />
            </button>
          )}
        </div>

        <div className="flex bg-slate-800 border border-slate-700 rounded-lg p-1 gap-1">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setFilter(t.key)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition ${
                filter === t.key
                  ? 'bg-pink-500 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-slate-400 py-12 justify-center">
          <Loader2 size={20} className="animate-spin" />
          <span>Loading hosts…</span>
        </div>
      ) : hostsFailure ? (
        // "No hosts found" over an empty table is a claim about the platform.
        // It is only made when the platform was actually read.
        <div className="bg-slate-800 border border-yellow-500/40 rounded-xl">
          <UnavailablePanel failure={hostsFailure} what="The host list" />
        </div>
      ) : (
        <>
          <div className="mb-3 text-sm text-slate-400">
            Showing {shownPeople} of {counts.all} {counts.all === 1 ? 'person' : 'people'}
            {hostAppsFailure && ' (pending invitations not included — they could not be read)'}
            {shownFlagged > 0 && (
              <span className="text-amber-300/90">
                {' '}· {shownFlagged} invitation{shownFlagged === 1 ? '' : 's'} below
                {shownFlagged === 1 ? ' carries' : ' carry'} an existing Host&rsquo;s phone or email —
                flagged, and not counted again
              </span>
            )}
            {/* Said, not silent: the cells fall back to the agency id or the
                name copied onto the application, which may be out of date. */}
            {agencyNamesFailure && (
              <span className="text-slate-500">
                {' '}· current agency names could not be read, so agencies show by id or by the name on the application
              </span>
            )}
          </div>

          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left">
                    <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Host</th>
                    <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Phone</th>
                    <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Agency</th>
                    <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Level</th>
                    <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Beans</th>
                    <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Call Rate</th>
                    <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Status</th>
                    <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Joined</th>
                    {canAct && <th className="px-4 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredHosts.length === 0 && filteredApps.length === 0 ? (
                    <tr>
                      <td colSpan={canAct ? 9 : 8} className="px-4 py-12 text-center text-slate-500">
                        No hosts found
                      </td>
                    </tr>
                  ) : null}

                  {/* Invited / pending application rows — GOV B08: only those
                      that are nobody's Host row. One carrying an existing
                      Host's own phone or email is flagged here, not hidden. */}
                  {filteredApps.map(({ app, sameContactAs }) => {
                    const ag = resolveAgencyName(app.agencyId, agencyNames, app.agencyName)
                    return (
                    <tr key={`app-${app.id}`} className="border-b border-slate-700/50 bg-yellow-500/3 hover:bg-yellow-500/5 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2.5">
                          {appPhotos.url('host', app.id) ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={appPhotos.url('host', app.id)} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-slate-600 flex items-center justify-center text-slate-300 text-xs font-bold flex-shrink-0">
                              {app.hostName?.[0]?.toUpperCase() ?? '?'}
                            </div>
                          )}
                          <div>
                            <span className="font-medium text-white">{app.hostName || '—'}</span>
                            <p className="text-slate-500 text-xs">{app.applicantEmail}</p>
                            {sameContactAs && (
                              <p className="text-amber-300 text-xs mt-0.5 flex items-center gap-1">
                                <AlertTriangle size={10} className="shrink-0" />
                                <span>
                                  Same phone or email as Host{' '}
                                  <Link href={`/users/${sameContactAs.uid}`} className="underline underline-offset-2 hover:text-amber-200">
                                    {sameContactAs.name || sameContactAs.uid}
                                  </Link>
                                  {' '}— their invitation, not counted again
                                </span>
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">{app.applicantPhone || '—'}</td>
                      <td className="px-4 py-3">
                        {ag.label ? (
                          <>
                            <span className="text-purple-300 text-xs" title={app.agencyId}>{ag.label}</span>
                            {ag.staleName && (
                              <p className="text-slate-500 text-xs">filed as {ag.staleName}</p>
                            )}
                          </>
                        ) : <span className="text-slate-500">—</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-500">—</td>
                      <td className="px-4 py-3 text-slate-500">—</td>
                      <td className="px-4 py-3 text-slate-400 text-xs">{app.callRate ? `${app.callRate} b/min` : '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-semibold flex items-center gap-1 w-fit ${
                          app.status === 'approved'
                            ? 'bg-blue-500/20 text-blue-300'
                            : 'bg-yellow-500/20 text-yellow-400'
                        }`}>
                          <Clock size={10} />
                          {app.status === 'approved' ? 'Awaiting Activation' : 'Pending Approval'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-400 text-xs">{formatDate(app.createdAt ?? null)}</td>
                      {canAct && (
                        <td className="px-4 py-3">
                          <button
                            onClick={() => setViewingApp(app)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white border border-slate-600 transition-colors"
                          >
                            <Eye size={12} /> View
                          </button>
                        </td>
                      )}
                    </tr>
                    )
                  })}

                  {/* Active / banned host rows from users collection — each
                      with the applications that are this same person. */}
                  {filteredHosts.map(({ host, applications }) => {
                    const acting = actingUids.has(host.uid)
                    const isBanInput = banInputUid === host.uid
                    // GOV B20: by `users.agencyId` — where the Host IS — under
                    // the agency document's current name, not the name copied
                    // onto whichever application they came from.
                    const ag = resolveAgencyName(host.agencyId, agencyNames)
                    return (
                      <tr key={host.uid} className="border-b border-slate-700/50 hover:bg-slate-700/20 transition-colors">
                        {/* Host name */}
                        <td className="px-4 py-3">
                          <Link href={`/users/${host.uid}`} className="flex items-center gap-2.5 hover:text-pink-400 transition-colors">
                            {profilePhotoSrc(host.photoUrl) ? (
                              <img src={profilePhotoSrc(host.photoUrl)} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-yellow-500/20 flex items-center justify-center text-yellow-400 text-xs font-bold flex-shrink-0">
                                {host.name?.[0]?.toUpperCase() ?? '?'}
                              </div>
                            )}
                            <span className="font-medium text-white">{host.name || '—'}</span>
                          </Link>
                          {applications.map((a) => (
                            <p key={a.id} className="text-slate-500 text-xs mt-1 ml-[42px] flex items-center gap-1.5">
                              <span className="font-mono">{linkedApplicationLabel(a)}</span>
                              {canAct && (
                                <button
                                  onClick={() => setViewingApp(a)}
                                  className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
                                >
                                  View
                                </button>
                              )}
                            </p>
                          ))}
                        </td>
                        <td className="px-4 py-3 text-slate-300">{host.phoneNumber || '—'}</td>
                        <td className="px-4 py-3">
                          {!host.agencyId
                            ? <span className="text-slate-500">—</span>
                            : ag.current
                              ? <span className="text-purple-300 text-xs" title={host.agencyId}>{ag.label}</span>
                              : <span className="text-purple-300 text-xs font-mono">{host.agencyId}</span>}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <Star size={11} className="text-yellow-400" />
                            {/* The HOST ladder. This read `level` — the USER/XP
                                ladder, which nothing writes — so every row in a
                                table of hosts showed the same invented number. */}
                            <span className="text-white">Lv {host.hostLevel}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-green-300 font-medium">
                          {host.beans.toLocaleString('en-IN')}
                        </td>
                        <td className="px-4 py-3 text-slate-400 text-xs">
                          {(host as UserRecord & { callRateBeans?: number }).callRateBeans
                            ? `${(host as UserRecord & { callRateBeans?: number }).callRateBeans} b/min`
                            : '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                            host.isBanned
                              ? 'bg-red-500/20 text-red-400'
                              : 'bg-green-500/20 text-green-400'
                          }`}>
                            {host.isBanned ? 'Banned' : 'Active'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-400 text-xs">{formatDate(host.createdAt)}</td>

                        {/* Actions */}
                        {canAct && (
                          <td className="px-4 py-3">
                            {isBanInput ? (
                              <div className="flex items-center gap-1.5 min-w-[200px]">
                                <input
                                  autoFocus
                                  type="text"
                                  value={banReason}
                                  onChange={e => setBanReason(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') handleBan(host.uid); if (e.key === 'Escape') setBanInputUid(null) }}
                                  placeholder="Ban reason…"
                                  className="flex-1 bg-slate-700 border border-slate-600 text-white rounded px-2 py-1 text-xs focus:outline-none focus:border-red-500"
                                />
                                <button
                                  onClick={() => handleBan(host.uid)}
                                  disabled={acting || !banReason.trim()}
                                  className="px-2 py-1 bg-red-500/20 border border-red-500/30 text-red-400 rounded text-xs hover:bg-red-500/30 disabled:opacity-40 transition"
                                >
                                  {acting ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                                </button>
                                <button
                                  onClick={() => { setBanInputUid(null); setBanReason('') }}
                                  className="text-slate-500 hover:text-white transition"
                                >
                                  <X size={13} />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5">
                                {/* Ban / Unban */}
                                {host.isBanned ? (
                                  <button
                                    onClick={() => handleUnban(host.uid)}
                                    disabled={acting}
                                    title="Unban"
                                    className="p-1.5 rounded bg-green-500/10 border border-green-500/20 text-green-400 hover:bg-green-500/20 disabled:opacity-40 transition"
                                  >
                                    {acting ? <Loader2 size={13} className="animate-spin" /> : <Shield size={13} />}
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => { setBanInputUid(host.uid); setBanReason('') }}
                                    disabled={acting}
                                    title="Ban"
                                    className="p-1.5 rounded bg-red-500/10 border border-red-500/20 text-red-400 hover:bg-red-500/20 disabled:opacity-40 transition"
                                  >
                                    <ShieldOff size={13} />
                                  </button>
                                )}

                                {/* Host role — on the person's page, where their roles are known (UGP-B) */}
                                <Link
                                  href={`/users/${host.uid}`}
                                  title="Host role and other roles"
                                  className="p-1.5 rounded bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 hover:bg-yellow-500/20 transition"
                                >
                                  <StarOff size={13} />
                                </Link>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* Host application detail modal */}
      {viewingApp && (
        <HostAppModal
          app={viewingApp}
          linkedHostName={viewingHost ? (viewingHost.name || viewingHost.uid) : undefined}
          agency={resolveAgencyName(viewingApp.agencyId, agencyNames, viewingApp.agencyName)}
          onClose={() => setViewingApp(null)}
          onSaved={updated => {
            setHostApps(prev => prev.map(a => a.id === updated.id ? updated : a))
            setViewingApp(updated)
          }}
        />
      )}
    </div>
  )
}
