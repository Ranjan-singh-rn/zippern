'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useSecureThumbs } from '@/components/useSecureThumbs'
import SecureDocuments from '@/components/SecureDocuments'
import { useAuth } from '@/components/AuthProvider'
import { createSubAgencyAccount, partnerRolesOf } from '@/lib/auth'
import { SecondRoleCard } from '@/components/SecondRoleCard'
import { AgencyMoney } from './AgencyMoney'
import HostReports from './HostReports'
import { auth, db, storage } from '@/lib/firebase'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import {
  collection,
  query,
  where,
  getDocs,
  getDoc,
  doc,
  addDoc,
  setDoc,
  deleteDoc,
  updateDoc,
  serverTimestamp,
  Timestamp,
  type FirestoreError,
} from 'firebase/firestore'
import { AlertTriangle, Building2, Users, Shield, Plus, X, CheckCircle2, Clock, Banknote, Star, Hash, Copy, UserPlus, Loader2, Upload, Globe, IndianRupee, FileText, ChevronRight, ChevronLeft, Camera } from 'lucide-react'
import { getEconomyConfig } from '@/lib/economyConfig'
import { fromSettled, toFailure, type ReadFailure } from '@/lib/readState'
import { Unavailable, UnavailablePanel, Warning } from '@/components/ui/States'
import { PendingChangesNotice } from '@/components/PendingChangesNotice'
import { submitPartnerUpdate, type Proposer } from '@/lib/pendingChanges'
import { profilePhotoSrc } from '@/lib/profilePhoto'
import PhoneInput from '@/components/PhoneInput'
import {
  linkedPersonUid, personStatusOf, primaryApplication, reconcileHostRows,
} from '@/lib/hostRows'
import { duplicateSubAgencyMessage, findDuplicateSubAgency, isAddressInUse, reappliedMessage, reapplyFormFrom } from '@/lib/subAgencyCreation'
import { partnerOps } from '@/lib/apiPartners'
import { currentRosterRows, hostsFromRoster, rosterRowUid } from '@/lib/agencyDashboardHosts'
import { duplicateInvitationMessage, findOpenInvitation, isWithdrawableInvitation, runInvitationCreate } from '@/lib/hostInvitation'

// ── Types ────────────────────────────────────────────────────────────────────

interface Agency {
  id: string
  agencyName: string
  kycStatus: 'pending' | 'submitted' | 'approved' | 'rejected'
  /**
   * The decision, as opposed to the KYC claim. It was never named here and the
   * distinction is the whole point of the proposal flow below: `kycStatus`
   * moves when a partner submits, `status` moves only when a reviewer decides,
   * and whether this record may still be edited directly turns on the second
   * one — see `directWriteAllowed` in lib/pendingChanges.ts.
   */
  status?: 'pending' | 'approved' | 'rejected'
  /** A proposed change to payout or identity details, waiting on a reviewer. */
  pendingChanges?: unknown
  referralCode?: string
  // Bank / payment
  paymentType?: 'india' | 'foreign'
  bankName?: string
  bankAccount?: string
  accountNumber?: string
  accountHolderName?: string
  ifscCode?: string
  bankIfsc?: string
  branch?: string
  upiId?: string
  binanceUid?: string
  // KYC docs
  kycDocUrls?: string[]
  createdAt?: Timestamp
  type?: 'main' | 'sub'
}

interface SubAgency {
  id: string
  agencyName: string
  ownerName: string
  ownerEmail: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt?: Timestamp
}

/**
 * A row in `hostApplications` — an invited host who has not yet activated.
 *
 * Only the fields this screen actually reads are named. It was `any`, which
 * meant a typo in a field name here rendered `undefined` silently instead of
 * failing to compile.
 */
interface HostApplication {
  id: string
  hostName?: string
  applicantPhone?: string
  applicantEmail?: string
  photoUrl?: string
  callRate?: number
  referralCode?: string
  status?: 'pending' | 'approved' | 'rejected'
  isActivated?: boolean
  /** Set when the applicant redeems the code. Joins this to a live host row. */
  activatedByUid?: string
  /**
   * GOV B08: set on a SELF-application, from the moment it is filed. It joins
   * this to the host row too — an approved self-application never gets
   * `activatedByUid`, which is how one host was listed twice.
   */
  applicantUid?: string
  /** Written by the KYC review screen when it rejects. */
  rejectionReason?: string

  // ── The rest of what the agency itself submitted ──────────────────────────
  //
  // Not new data and not a new permission: the agency typed every one of these
  // into its own Invite Host form and `firestore.rules` has always returned its
  // own invitations to it. They were simply dropped on the floor by this screen
  // the moment a host activated — see `allHostApps` — so an agency could see
  // the documents for a host it was waiting on and lost sight of them for a
  // host it actually has.
  dob?: string
  country?: string
  age?: number
  paymentType?: string
  accountHolderName?: string
  accountNumber?: string
  ifscCode?: string
  bankName?: string
  upiId?: string
  binanceUid?: string
  kycDocUrls?: string[]
  kycStatus?: string
}

/**
 * A host, as the `users` document actually spells it.
 *
 * ── TWO FIELDS THAT DO NOT EXIST ─────────────────────────────────────────────
 *
 * This interface used to declare `phone` and `isActive`. Neither is ever
 * written to a user document, so both were `undefined` on every row, for every
 * agency, always — and TypeScript could not catch it because both were
 * optional. The table rendered an em dash for the phone number and, because
 * `isActive` was falsy, the word **Inactive** against every host an agency has.
 *
 * Meanwhile /hosts read `phoneNumber` and `!isBanned` and called the same
 * person **Active**. Two screens, one host, opposite answers — and the agency's
 * screen was the wrong one, which is the worse way round: an agency looking at
 * "Inactive" beside a recruit they just signed has no way to tell a broken
 * field name from a real problem with their host.
 *
 * `isActive` has no replacement because there is no such concept on a user. The
 * states a host is actually in are: banned, verified, or waiting on their face
 * capture — and that last one is what an agency most needs to see, because an
 * unverified host cannot go live and their payout is held.
 */
interface Host {
  uid: string
  name: string
  /** The app writes `phoneNumber`. There is no `phone` field on a user. */
  phoneNumber?: string
  /** The account's verified email — read only to flag an invitation (GOV B08). */
  email?: string
  /**
   * The HOST ladder (0–10, beans-based) — `users/{uid}.hostLevel`.
   *
   * This column used to read `level`, the USER/XP ladder, which nothing on the
   * platform writes. So it was always `undefined`, and the cell — testing
   * truthiness rather than nullishness — rendered an em dash for every host in
   * every agency. Two separate faults pointing the same way: the wrong field,
   * and a test that would have shown a genuine level-0 host as "—" even once
   * the right field was read.
   */
  hostLevel?: number
  beans?: number
  /** Written by `activateHost`, clamped to the economy band. */
  callRateBeans?: number
  isHost?: boolean
  /** Gates going live, their own call rate, and the weekly payout release. */
  isVerifiedHost?: boolean
  isBanned?: boolean
  photoUrl?: string
  hostActivatedAt?: { seconds: number } | string
}

/**
 * What the agency submitted about one of its hosts.
 *
 * ── WHY AN AGENCY SEES THIS AND A SUPERADMIN SEES MORE ───────────────────────
 *
 * Everything here is the agency's own submission, returned to the agency that
 * made it. `firestore.rules` has always allowed that — the clause matches on
 * `agencyId == crmUserAgencyId()` — and there is no reason an agency should be
 * able to read a host's bank account while they are pending and not after they
 * join. That was an accident of this screen throwing the redeemed invitations
 * away, not a decision anybody made.
 *
 * Three things stay staff-only, and each for its own reason rather than out of
 * general caution:
 *
 *   the live face capture   biometric data under the DPDP Act, served through
 *                           signed URLs minted per review. The agency supplied
 *                           the reference photograph; the capture is the host's
 *                           own and is seen only by the reviewer deciding it.
 *   moderation and audit    bans, warnings and balance adjustments are actions
 *                           the PLATFORM took, often about conduct in rooms the
 *                           agency has no part in. The audit log names staff.
 *   editing any of it       an agency proposes changes through re-approval; it
 *                           does not write a host's payout details directly,
 *                           which is the whole point of the four-eyes rule on
 *                           this collection.
 */
function HostApplicationPanel({
  app, applicationsUnread,
}: {
  app: HostApplication | undefined
  applicationsUnread: boolean
}) {
  const [zoom, setZoom] = useState('')

  // A refused read is not an absent invitation. The agency is told which it is,
  // because one is "nothing to see" and the other is "you are not seeing it".
  if (!app) {
    return (
      <p className="text-slate-500 text-xs mb-2">
        {applicationsUnread
          ? 'Your invitations could not be read, so the KYC for this host cannot be '
            + 'shown. This is not a statement that there is none on file.'
          : 'No invitation of yours is linked to this host — they joined through '
            + 'another agency or were added by staff directly.'}
      </p>
    )
  }

  const labels = app.paymentType === 'foreign'
    ? ['Passport', 'National ID', 'Proof of address']
    : ['Aadhaar card', 'PAN card', 'Bank passbook']
  const docs = (app.kycDocUrls ?? []).filter(Boolean)

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-4 mb-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className="text-slate-300 text-sm font-medium">
          The invitation you filed
        </p>
        <span className="text-slate-500 text-xs">
          code <span className="font-mono text-purple-300">{app.referralCode}</span>
          {app.kycStatus ? ` · KYC ${app.kycStatus}` : ''}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
        <HostFact label="Phone" value={app.applicantPhone || '—'} />
        <HostFact label="Email" value={app.applicantEmail || '—'} />
        <HostFact label="Date of birth" value={app.dob || '—'} />
        <HostFact label="Country" value={app.country || '—'} />
      </div>

      <p className="text-slate-400 text-xs font-medium mb-2">Where they are paid</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
        {app.paymentType === 'foreign' ? (
          <HostFact label="Binance UID" value={app.binanceUid || '—'} />
        ) : (
          <>
            <HostFact label="Account holder" value={app.accountHolderName || '—'} />
            <HostFact label="Account number" value={app.accountNumber || '—'} />
            <HostFact label="IFSC" value={app.ifscCode || '—'} />
            <HostFact label="Bank" value={app.bankName || '—'} />
            {app.upiId ? <HostFact label="UPI" value={app.upiId} /> : null}
          </>
        )}
      </div>

      <p className="text-slate-400 text-xs font-medium mb-2">KYC documents</p>
      {/* Through the API behind short-lived signed URLs. The agency is
          entitled to see the invitation it filed — `services/documents`
          scopes it on `partner_ids_of` — but not via the permanent bearer
          URL stored at upload. */}
      <SecureDocuments kind="host" recordId={app.id}
        emptyHint="None were uploaded with this invitation." />

      <p className="text-slate-600 text-xs mt-3">
        To change any of this, use <span className="text-slate-400">Update KYC &amp; payment details</span> —
        a change to a bank account or an identity document is reviewed before it
        takes effect, so the account already verified keeps being paid meanwhile.
      </p>

      {zoom && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85"
          onClick={() => setZoom('')}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoom}
            alt="Document"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] max-w-full object-contain rounded-lg"
          />
        </div>
      )}
    </div>
  )
}

/** One labelled fact in a host's inline panel. */
function HostFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-slate-500 text-xs uppercase tracking-wide">{label}</p>
      <p className="text-slate-200 text-sm mt-0.5">{value}</p>
    </div>
  )
}

/** A Firestore timestamp, an ISO string, or nothing — as a date a person reads. */
function whenOfTs(value: unknown): string {
  if (!value) return '—'
  try {
    const ms = typeof value === 'string'
      ? new Date(value).getTime()
      : (value as { seconds?: number }).seconds
        ? (value as { seconds: number }).seconds * 1000
        : NaN
    if (Number.isNaN(ms)) return '—'
    return new Date(ms).toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
    })
  } catch {
    return '—'
  }
}

interface SalaryRequest {
  id: string
  agencyId: string
  hostUid: string
  hostName: string
  periodStart: string
  periodEnd: string
  beansEarned: number
  amountInr: number
  notes?: string
  status: 'pending' | 'approved' | 'paid' | 'distributed'
  createdAt?: Timestamp
  approvedAt?: Timestamp
  paidAt?: Timestamp
  distributedAt?: Timestamp
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function KycBadge({ status }: { status: Agency['kycStatus'] }) {
  const map = {
    approved:  'bg-green-500/20 text-green-300 border-green-500/30',
    submitted: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    pending:   'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
    rejected:  'bg-red-500/20 text-red-300 border-red-500/30',
  }
  const labels = { approved: 'KYC Approved', submitted: 'KYC Under Review', pending: 'KYC Pending', rejected: 'KYC Rejected' }
  return (
    <span className={`inline-block text-xs font-medium px-2.5 py-1 rounded border ${map[status]}`}>
      {labels[status]}
    </span>
  )
}

function SalaryStatusBadge({ status }: { status: SalaryRequest['status'] }) {
  const map = {
    pending:     'bg-yellow-500/20 text-yellow-300',
    approved:    'bg-blue-500/20 text-blue-300',
    paid:        'bg-green-500/20 text-green-300',
    distributed: 'bg-purple-500/20 text-purple-300',
  }
  const labels = {
    pending: 'Pending', approved: 'Approved', paid: 'Paid', distributed: 'Distributed',
  }
  return (
    <span className={`inline-block text-xs font-medium px-2 py-1 rounded ${map[status]}`}>
      {labels[status]}
    </span>
  )
}

function maskAccount(acc?: string) {
  if (!acc) return '—'
  if (acc.length <= 4) return acc
  return '•'.repeat(acc.length - 4) + acc.slice(-4)
}

/**
 * A counted figure.
 *
 * `failure` is not decoration. Every number on this row is a `.length` or a
 * `.reduce` over a Firestore query result, and a query that was refused leaves
 * the array it fills at `[]` — so "0 Hosts", "0 Beans" and "0 Pending Salary
 * Requests" are exactly what a permission error looked like here, in the same
 * white bold type as a real count. When the read behind a tile did not answer,
 * the tile says so instead of counting.
 */
function StatCard({ label, value, icon: Icon, color = 'text-pink-500', failure }: {
  label: string
  value: string | number
  icon: React.ElementType
  color?: string
  failure?: ReadFailure
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex items-center gap-4">
      <div className="p-3 bg-slate-800 rounded-lg">
        <Icon size={20} className={color} />
      </div>
      <div className="min-w-0">
        <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
        {failure ? (
          <Unavailable failure={failure} what={label.toLowerCase()} />
        ) : (
          <p className="text-white text-xl font-bold">{value}</p>
        )}
      </div>
    </div>
  )
}

// ── Add Host Modal ───────────────────────────────────────────────────────────

function generateCrmUid(): string {
  return Math.random().toString(36).substring(2, 10).toUpperCase()
}

function AddHostModal({
  agencyId,
  agencyName,
  referralCode,
  onClose,
  onSuccess,
}: {
  agencyId: string
  agencyName: string
  referralCode: string
  onClose: () => void
  onSuccess?: () => void
}) {
  const { crmUser } = useAuth()
  const [step, setStep] = useState(1)

  // Economy config for call rate limits.
  //
  // 350/700 are this file's own fallbacks, not the superadmin's setting. The
  // read used to end in `.catch(() => {})`, so a refused one left both numbers
  // in place and the form went on to print "Allowed range: 350–700 beans/min
  // (set by superadmin)" and to refuse a rate with "(superadmin limit)" —
  // sentences about a value nobody read, on the field that fixes what a host is
  // paid per minute. The numbers still stand in, because a bounded input is
  // better than none, but they no longer claim to be anyone's policy.
  const [minRate, setMinRate] = useState(350)
  const [maxRate, setMaxRate] = useState(700)
  const [ratesFailure, setRatesFailure] = useState<ReadFailure | undefined>(undefined)

  // Step 1 — Identity
  const [name, setName]   = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')

  // Step 2 — Profile
  const ts = Date.now()
  const [photo, setPhoto]     = useState<UploadState>(emptyUpload())
  const [age, setAge]         = useState('')
  const [dob, setDob]         = useState('')
  const [country, setCountry] = useState('India')

  // Step 3 — Call Rate + Payment
  const [callRate, setCallRate]       = useState('')
  const [paymentType, setPaymentType] = useState<'india' | 'foreign'>('india')
  const [bank, setBank] = useState({
    accountHolderName: '', accountNumber: '', confirmAccountNumber: '',
    ifscCode: '', bankName: '', branch: '', upiId: '',
  })
  const [binanceUid, setBinanceUid] = useState('')

  // Step 4 — KYC docs
  const slugBase = `kyc/${agencyId}/applications`
  const [doc1, setDoc1] = useState<UploadState>(emptyUpload())
  const [doc2, setDoc2] = useState<UploadState>(emptyUpload())
  const [doc3, setDoc3] = useState<UploadState>(emptyUpload())

  const [saving, setSaving]       = useState(false)
  const [saveError, setSaveError] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const inputCls = "w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500 placeholder-slate-500"
  const setB = (k: keyof typeof bank) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setBank(f => ({ ...f, [k]: e.target.value }))

  // Load call rate limits from economy config
  useEffect(() => {
    getEconomyConfig().then(cfg => {
      const mn = cfg.minHostCallRate ?? 350
      const mx = cfg.maxHostCallRate ?? 700
      setMinRate(mn)
      setMaxRate(mx)
      setCallRate(String(mn))
      setRatesFailure(undefined)
    }).catch((err: unknown) => {
      setRatesFailure(toFailure(err, 'host call-rate limits'))
    })
  }, [])

  function validateStep1(): string {
    if (!name.trim())  return "Enter the host's name."
    if (!phone.trim()) return "Enter the host's phone number."
    if (!email.trim()) return "Enter the host's email address."
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Enter a valid email address.'
    return ''
  }

  function validateStep2(): string {
    if (photo.uploading)  return 'Please wait for the photo upload to finish.'
    if (!photo.url)       return 'Upload the host profile photo.'
    if (!age.trim() || isNaN(Number(age)) || Number(age) < 18 || Number(age) > 80)
      return 'Enter a valid age (18–80).'
    if (!dob.trim())      return 'Enter the date of birth.'
    if (!country.trim())  return 'Enter the country.'
    return ''
  }

  function validateStep3(): string {
    const rate = Number(callRate)
    if (!callRate.trim() || isNaN(rate)) return 'Enter a call rate.'
    // The bound is named as a bound; only a bound we actually read is attributed
    // to the superadmin. The server checks the real limit on approval either way.
    const source = ratesFailure ? '' : ' (superadmin limit)'
    if (rate < minRate) return `Call rate cannot be less than ${minRate} beans/min${source}.`
    if (rate > maxRate) return `Call rate cannot exceed ${maxRate} beans/min${source}.`
    if (paymentType === 'foreign') {
      if (!binanceUid.trim()) return 'Binance UID is required.'
    } else {
      if (!bank.accountHolderName.trim()) return 'Account holder name is required.'
      if (!bank.accountNumber.trim())     return 'Account number is required.'
      if (bank.accountNumber !== bank.confirmAccountNumber) return 'Account numbers do not match.'
      if (!bank.ifscCode.trim())          return 'IFSC code is required.'
      if (!bank.bankName.trim())          return 'Bank name is required.'
    }
    return ''
  }

  function nextStep() {
    let err = ''
    if (step === 1) err = validateStep1()
    else if (step === 2) err = validateStep2()
    else if (step === 3) err = validateStep3()
    if (err) { setSaveError(err); return }
    setSaveError('')
    setStep(s => s + 1)
  }

  async function handleCreate() {
    if (!referralCode.trim()) { setSaveError("Agency referral code is missing. Contact superadmin to set it."); return }
    if (!doc1.url || !doc2.url || !doc3.url) { setSaveError('Please upload all 3 KYC documents.'); return }
    if (doc1.uploading || doc2.uploading || doc3.uploading) { setSaveError('Please wait for uploads to finish.'); return }
    if (!crmUser) return
    setSaveError('')
    setSaving(true)
    try {
      const bankData = paymentType === 'foreign'
        ? { paymentType: 'foreign', binanceUid: binanceUid.trim(), currency: 'USD' }
        : {
            paymentType: 'india', currency: 'INR',
            accountHolderName: bank.accountHolderName.trim(),
            accountNumber:     bank.accountNumber.trim(),
            ifscCode:          bank.ifscCode.trim().toUpperCase(),
            bankName:          bank.bankName.trim(),
            branch:            bank.branch.trim(),
            upiId:             bank.upiId.trim(),
          }

      const crmUid = generateCrmUid()

      /*
       * FX-12 (RF-18): one OPEN invitation per person. First a fresh look at
       * this agency's invitations — the same phone OR the same email is the
       * same person, so a re-invite after a typo in one of them is caught —
       * then the write itself goes to an id derived from (agency, email,
       * phone) with create-only semantics: two submits at once aim at the
       * same document, and the rules refuse the second (to an agency login it
       * is an update of fields it may not change). See lib/hostInvitation.ts.
       */
      const mine = await getDocs(query(collection(db, 'hostApplications'), where('agencyId', '==', agencyId)))
      const openOne = findOpenInvitation(
        mine.docs.map((d) => ({ id: d.id, ...(d.data() as Record<string, unknown>) })),
        email.trim(), phone.trim(),
      )
      if (openOne) {
        setSaveError(duplicateInvitationMessage(openOne))
        return
      }

      const invitation = {
        // Identity
        referralCode:   referralCode.trim().toUpperCase(),
        agencyId,
        agencyName,
        hostName:       name.trim(),
        applicantPhone: phone.trim(),
        applicantEmail: email.trim().toLowerCase(),
        // Profile
        photoUrl:       photo.url,
        age:            Number(age),
        dob:            dob.trim(),
        country:        country.trim(),
        // Call rate
        callRate:       Number(callRate),
        // Payment
        ...bankData,
        // KYC
        kycDocUrls:     [doc1.url, doc2.url, doc3.url],
        kycStatus:      'submitted',
        // CRM
        crmUid,
        isActivated:    false,   // set to true by the app when host enters the code
        status:         'pending',
        createdAt:      serverTimestamp(),
        createdBy:      crmUser.uid,
        createdByName:  crmUser.name,
      }

      const isRefused = (e: unknown) => (e as FirestoreError | undefined)?.code === 'permission-denied'
      const created = await runInvitationCreate(agencyId, email.trim(), phone.trim(), {
        sha256Hex: async (key) => {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
          return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
        },
        createIfAbsent: async (id) => {
          const ref = doc(db, 'hostApplications', id)
          // An agency may read its own invitation; reading one that does not
          // exist is refused by the rules, which here means "free".
          const seen = await getDoc(ref).catch((e: unknown) => {
            if (isRefused(e)) return null
            throw e
          })
          if (seen && seen.exists()) return { created: false, existing: seen.data() as Record<string, unknown> }
          try {
            await setDoc(ref, invitation)
            return { created: true }
          } catch (e) {
            if (!isRefused(e)) throw e
            // Created by somebody else between the look and the write.
            const again = await getDoc(ref).catch(() => null)
            if (again && again.exists()) return { created: false, existing: again.data() as Record<string, unknown> }
            throw e
          }
        },
        // Only for a person with more refused invitations than there are
        // slots: invited the old way, after the duplicate check above.
        createAuto: async () => (await addDoc(collection(db, 'hostApplications'), invitation)).id,
      })
      if (!created.ok) {
        setSaveError(duplicateInvitationMessage({ id: created.id, ...created.existing }))
        return
      }

      /*
       * NO APPROVAL REQUEST IS FILED.
       *
       * Inviting a host used to write this `hostApplications` document AND an
       * `add_host` request on the approval queue. That request is now a dead
       * end: `onApprovalApproved` refuses the type outright, because approving
       * from that queue wrote only `status` and never `kycStatus`, so an
       * application could read approved there and pending on every other
       * screen — the exact drift the host decision was moved to /kyc to end.
       *
       * Filing it anyway produced something worse than nothing. A superadmin
       * saw a pending request, pressed Approve, and watched it flip to
       * REJECTED — which reads as "this host was turned down" when it means
       * "this queue does not decide hosts". Meanwhile the application itself
       * sat untouched at pending, so three screens disagreed about one host.
       *
       * The invitation is the `hostApplications` document. It appears in
       * /kyc → Hosts on its own, and the referral code works from the moment
       * it is written. There was never a second thing to create.
       */
      onSuccess?.()
      setSubmitted(true)
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Failed to create invitation.')
    } finally {
      setSaving(false)
    }
  }

  const STEPS = ['Identity', 'Profile', 'Call Rate & Pay', 'KYC Docs']

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800 shrink-0">
          <h2 className="text-white text-lg font-semibold flex items-center gap-2">
            <UserPlus size={18} className="text-pink-400" />
            {submitted ? 'Awaiting Approval' : 'Invite Host'}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        {submitted ? (
          <div className="px-6 py-8 flex flex-col items-center gap-5">
            <Clock size={44} className="text-yellow-400" />
            <div className="text-center">
              <p className="text-white font-semibold text-base mb-1">Submitted for approval</p>
              <p className="text-slate-400 text-sm">
                The host invitation for <span className="text-white">{name}</span> is awaiting superadmin approval.
              </p>
            </div>
            <div className="w-full bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-5 py-4 text-sm text-yellow-300">
              You will see <strong>{name}</strong> listed as <strong>Pending</strong> until the superadmin approves.
            </div>
            <button onClick={onClose} className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors">
              Close
            </button>
          </div>
        ) : (
          <>
            {/* Step indicator */}
            <div className="flex items-center gap-1 px-6 py-3 border-b border-slate-800 shrink-0">
              {STEPS.map((label, i) => (
                <div key={i} className="flex items-center gap-1.5 flex-1 min-w-0">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                    i + 1 < step ? 'bg-green-500 text-white' :
                    i + 1 === step ? 'bg-pink-500 text-white' : 'bg-slate-700 text-slate-400'
                  }`}>
                    {i + 1 < step ? <CheckCircle2 size={12} /> : i + 1}
                  </div>
                  <span className={`text-xs font-medium truncate hidden sm:block ${i + 1 === step ? 'text-white' : 'text-slate-500'}`}>{label}</span>
                  {i < STEPS.length - 1 && <div className="flex-1 h-px bg-slate-700 ml-1 shrink-0" />}
                </div>
              ))}
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">

              {/* Step 1 — Identity */}
              {step === 1 && (
                <>
                  {referralCode ? (
                    <div className="flex items-center justify-between bg-pink-500/10 border border-pink-500/30 rounded-xl px-4 py-3">
                      <div>
                        <p className="text-pink-300 text-xs font-semibold uppercase tracking-wide mb-0.5">Agency Referral Code</p>
                        <p className="text-white font-mono font-bold text-base">{referralCode.toUpperCase()}</p>
                      </div>
                      <p className="text-slate-400 text-xs text-right max-w-[140px]">Host enters this code in the app to activate</p>
                    </div>
                  ) : (
                    <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-4 py-3">
                      <p className="text-yellow-300 text-sm">⚠ Agency referral code not set. Ask superadmin to add it before inviting hosts.</p>
                    </div>
                  )}
                  <div>
                    <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Host Name</label>
                    <input value={name} onChange={e => setName(e.target.value)} placeholder="Full name" className={inputCls} />
                  </div>
                  <div>
                    <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Phone Number</label>
                    <PhoneInput value={phone} onChange={setPhone} placeholder="Mobile number" className={inputCls} />
                    <p className="text-slate-500 text-xs mt-1">Must match the phone used to log in to the app</p>
                  </div>
                  <div>
                    <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Email Address</label>
                    <input value={email} onChange={e => setEmail(e.target.value)} placeholder="host@example.com" type="email" className={inputCls} />
                    <p className="text-slate-500 text-xs mt-1">Must match the email used to sign up in the app</p>
                  </div>
                </>
              )}

              {/* Step 2 — Profile */}
              {step === 2 && (
                <>
                  {/* Photo upload */}
                  <div>
                    <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Profile Photo</label>
                    <p className="text-slate-500 text-xs mb-2">Clear face photo — used for identity verification</p>
                    <label className={`flex items-center gap-3 border rounded-lg px-4 py-3 cursor-pointer transition-colors ${
                      photo.url ? 'border-green-500/40 bg-green-500/5' :
                      photo.uploading ? 'border-pink-500/40 bg-pink-500/5' :
                      'border-slate-600 bg-slate-700/50 hover:border-slate-500'
                    }`}>
                      <input type="file" accept="image/*" className="sr-only"
                        onChange={e => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          setPhoto({ file, url: '', progress: 0, uploading: true })
                          const storageRef = ref(storage, `hostPhotos/${agencyId}/${ts}_photo`)
                          const task = uploadBytesResumable(storageRef, file)
                          task.on('state_changed',
                            snap => setPhoto(p => ({ ...p, progress: Math.round((snap.bytesTransferred / snap.totalBytes) * 100) })),
                            () => setPhoto(p => ({ ...p, uploading: false })),
                            async () => {
                              const url = await getDownloadURL(task.snapshot.ref)
                              setPhoto({ file, url, progress: 100, uploading: false })
                            }
                          )
                        }}
                      />
                      {photo.url ? (
                        <>
                          <img src={photo.url} alt="Profile" className="w-12 h-12 rounded-full object-cover border-2 border-green-500/50 shrink-0" />
                          <div className="flex-1">
                            <p className="text-green-300 text-sm font-medium">Photo uploaded</p>
                            <p className="text-slate-500 text-xs">Click to replace</p>
                          </div>
                          <CheckCircle2 size={18} className="text-green-400 shrink-0" />
                        </>
                      ) : photo.uploading ? (
                        <>
                          <Loader2 size={18} className="text-pink-400 animate-spin shrink-0" />
                          <div className="flex-1">
                            <div className="h-1.5 bg-slate-600 rounded-full overflow-hidden">
                              <div className="h-full bg-pink-500 transition-all" style={{ width: `${photo.progress}%` }} />
                            </div>
                            <p className="text-slate-400 text-xs mt-1">{photo.progress}%</p>
                          </div>
                        </>
                      ) : (
                        <>
                          <Camera size={18} className="text-slate-400 shrink-0" />
                          <div>
                            <p className="text-slate-300 text-sm">Click to upload photo</p>
                            <p className="text-slate-500 text-xs">JPG or PNG, clear face visible</p>
                          </div>
                        </>
                      )}
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Age</label>
                      <input value={age} onChange={e => setAge(e.target.value)} type="number" min="18" max="80" placeholder="e.g. 24" className={inputCls} />
                    </div>
                    <div>
                      <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Date of Birth</label>
                      <input value={dob} onChange={e => setDob(e.target.value)} type="date" className={`${inputCls} [color-scheme:dark]`} />
                    </div>
                  </div>

                  <div>
                    <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Country</label>
                    <input value={country} onChange={e => setCountry(e.target.value)} placeholder="e.g. India" className={inputCls} />
                  </div>
                </>
              )}

              {/* Step 3 — Call Rate + Payment */}
              {step === 3 && (
                <>
                  {/* Call rate */}
                  <div>
                    <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Call Rate (Beans/min)</label>
                    <input value={callRate} onChange={e => setCallRate(e.target.value)} type="number" min={minRate} max={maxRate} placeholder={String(minRate)} className={inputCls} />
                    {ratesFailure ? (
                      <p className="text-yellow-400/80 text-xs mt-1 leading-snug">
                        The allowed range could not be read, so {minRate}–{maxRate} beans/min
                        is this screen&rsquo;s own fallback and not the superadmin&rsquo;s
                        setting — the real limit may be wider or narrower. {ratesFailure.reason}{' '}
                        Whatever you enter is checked against the real limit when the
                        invitation is approved.
                      </p>
                    ) : (
                      <p className="text-slate-500 text-xs mt-1">Allowed range: {minRate}–{maxRate} beans/min (set by superadmin)</p>
                    )}
                  </div>

                  <div className="border-t border-slate-800 pt-3">
                    <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-3">Payment Method</p>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => setPaymentType('india')}
                        className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${paymentType === 'india' ? 'border-pink-500 bg-pink-500/10 text-pink-300' : 'border-slate-600 text-slate-400 hover:border-slate-500'}`}>
                        <IndianRupee size={15} /> Indian (₹)
                      </button>
                      <button type="button" onClick={() => setPaymentType('foreign')}
                        className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${paymentType === 'foreign' ? 'border-pink-500 bg-pink-500/10 text-pink-300' : 'border-slate-600 text-slate-400 hover:border-slate-500'}`}>
                        <Globe size={15} /> International ($)
                      </button>
                    </div>
                  </div>

                  {paymentType === 'foreign' ? (
                    <div>
                      <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Binance UID</label>
                      <input value={binanceUid} onChange={e => setBinanceUid(e.target.value)} className={inputCls} placeholder="Binance account UID" />
                      <p className="text-slate-500 text-xs mt-1">Find it in Binance App → Profile → UID</p>
                    </div>
                  ) : (
                    <>
                      <div>
                        <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Account Holder Name</label>
                        <input value={bank.accountHolderName} onChange={setB('accountHolderName')} className={inputCls} placeholder="Exactly as on bank account" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Account Number</label>
                          <input value={bank.accountNumber} onChange={setB('accountNumber')} className={inputCls} placeholder="Account number" />
                        </div>
                        <div>
                          <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Confirm Account No.</label>
                          <input value={bank.confirmAccountNumber} onChange={setB('confirmAccountNumber')} className={inputCls} placeholder="Re-enter" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">IFSC Code</label>
                          <input value={bank.ifscCode} onChange={setB('ifscCode')} className={inputCls} placeholder="e.g. HDFC0001234" />
                        </div>
                        <div>
                          <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Bank Name</label>
                          <input value={bank.bankName} onChange={setB('bankName')} className={inputCls} placeholder="e.g. HDFC Bank" />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Branch (optional)</label>
                          <input value={bank.branch} onChange={setB('branch')} className={inputCls} placeholder="Branch name" />
                        </div>
                        <div>
                          <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">UPI ID (optional)</label>
                          <input value={bank.upiId} onChange={setB('upiId')} className={inputCls} placeholder="name@upi" />
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}

              {/* Step 4 — KYC docs */}
              {step === 4 && (
                <>
                  <p className="text-slate-400 text-sm">Upload identity and bank documents for KYC verification. Superadmin will verify these before approving.</p>
                  <DocUploadField
                    label={paymentType === 'foreign' ? 'Passport' : 'Aadhaar Card'}
                    description={paymentType === 'foreign' ? 'Valid passport photo page' : 'Front side of Aadhaar card'}
                    state={doc1}
                    storagePath={`${slugBase}/${ts}_doc1`}
                    onChange={setDoc1}
                  />
                  <DocUploadField
                    label={paymentType === 'foreign' ? 'Government / National ID' : 'PAN Card'}
                    description={paymentType === 'foreign' ? "National ID or driver's license" : 'Clear photo of PAN card'}
                    state={doc2}
                    storagePath={`${slugBase}/${ts}_doc2`}
                    onChange={setDoc2}
                  />
                  <DocUploadField
                    label={paymentType === 'foreign' ? 'Proof of Address' : 'Bank Passbook / Statement'}
                    description={paymentType === 'foreign' ? 'Recent utility bill or bank statement' : 'First page of bank passbook'}
                    state={doc3}
                    storagePath={`${slugBase}/${ts}_doc3`}
                    onChange={setDoc3}
                  />
                </>
              )}

              {saveError && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
                  <p className="text-red-400 text-sm">{saveError}</p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 border-t border-slate-800 flex gap-3 shrink-0">
              {step > 1 ? (
                <button onClick={() => { setSaveError(''); setStep(s => s - 1) }}
                  className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors">
                  <ChevronLeft size={15} /> Back
                </button>
              ) : (
                <button onClick={onClose} className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors">
                  Cancel
                </button>
              )}
              {step < 4 ? (
                <button onClick={nextStep} className="flex-1 bg-pink-500 hover:bg-pink-600 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-1.5">
                  Next <ChevronRight size={15} />
                </button>
              ) : (
                <button onClick={handleCreate} disabled={saving}
                  className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/40 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-2">
                  {saving ? <><Loader2 size={14} className="animate-spin" />Submitting…</> : <><UserPlus size={15} />Submit for Approval</>}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ── Salary Request Form ──────────────────────────────────────────────────────

function SalaryRequestForm({
  hosts,
  agencyId,
  onClose,
  onSuccess,
}: {
  hosts: Host[]
  agencyId: string
  onClose: () => void
  onSuccess: () => void
}) {
  const [hostUid, setHostUid] = useState(hosts[0]?.uid ?? '')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [beansEarned, setBeansEarned] = useState('')
  const [amountInr, setAmountInr] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit() {
    setError('')
    if (!hostUid) { setError('Select a host.'); return }
    if (!periodStart || !periodEnd) { setError('Select period dates.'); return }
    if (!beansEarned || !amountInr) { setError('Enter beans earned and INR amount.'); return }

    const selectedHost = hosts.find((h) => h.uid === hostUid)

    setSubmitting(true)
    try {
      await addDoc(collection(db, 'salaryRequests'), {
        agencyId,
        hostUid,
        hostName: selectedHost?.name ?? '',
        periodStart,
        periodEnd,
        beansEarned: Number(beansEarned),
        amountInr: Number(amountInr),
        notes: notes.trim(),
        status: 'pending',
        createdAt: serverTimestamp(),
      })
      onSuccess()
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to submit request.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-800">
          <h2 className="text-white text-lg font-semibold">Request Salary</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <div className="px-6 py-6 space-y-4">
          {/* Host selector */}
          <div>
            <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Host</label>
            <select
              value={hostUid}
              onChange={(e) => setHostUid(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500"
            >
              {hosts.map((h) => (
                <option key={h.uid} value={h.uid}>{h.name}</option>
              ))}
            </select>
          </div>

          {/* Period */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Period Start</label>
              <input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500 [color-scheme:dark]"
              />
            </div>
            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Period End</label>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500 [color-scheme:dark]"
              />
            </div>
          </div>

          {/* Beans + INR */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Beans Earned</label>
              <input
                type="number"
                min="0"
                value={beansEarned}
                onChange={(e) => setBeansEarned(e.target.value)}
                placeholder="0"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500 placeholder-slate-500"
              />
            </div>
            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Amount (INR ₹)</label>
              <input
                type="number"
                min="0"
                value={amountInr}
                onChange={(e) => setAmountInr(e.target.value)}
                placeholder="0"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500 placeholder-slate-500"
              />
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Any additional notes…"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-pink-500 placeholder-slate-500 resize-none"
            />
          </div>

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-800 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/50 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-2"
          >
            {submitting ? (
              <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Submitting…</>
            ) : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── CopyField ────────────────────────────────────────────────────────────────

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  function handleCopy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-slate-500 text-xs">{label}:</span>
      <span className="font-mono text-slate-300 text-xs">{value}</span>
      <button
        onClick={handleCopy}
        className="flex items-center gap-1 text-slate-400 hover:text-white transition-colors"
        title={`Copy ${label}`}
      >
        {copied ? <CheckCircle2 size={12} className="text-green-400" /> : <Copy size={12} />}
        <span className="text-xs">{copied ? 'Copied!' : 'Copy'}</span>
      </button>
    </div>
  )
}

// ── KycSubmitSection ─────────────────────────────────────────────────────────

function KycSubmitSection({ agency, agencyId, actor, onDone }: { agency: Agency; agencyId: string; actor: Proposer; onDone: () => void }) {
  const ts = Date.now()
  /**
   * Four path segments, not five — and that is why uploads were failing.
   *
   * Every KYC rule in `storage.rules` matches exactly four segments:
   * `kyc/agencies/signup/{file}`, `kyc/agencies/temp/{file}`,
   * `kyc/sub-agencies/{ts}/{file}` and the catch-all
   * `kyc/{agencyId}/{hostUid}/{file}`. Storage rules do not match across a
   * path separator, so a five-segment path matches none of them and the write
   * is denied outright.
   *
   * This built `kyc/agencies/{agencyId}/{ts}` and the callers appended
   * `/doc1`, giving `kyc/agencies/{agencyId}/{ts}/doc1` — five. Every other
   * upload on this page gets it right: the host invite uses
   * `kyc/{agencyId}/applications/{ts}_doc1` and the sub-agency form uses
   * `kyc/sub-agencies/{ts}/doc1_aadhaar`, both four.
   *
   * So the timestamp joins the filename rather than becoming a folder of its
   * own, and the result matches `kyc/{agencyId}/{hostUid}/{file}` with
   * `agencyId = "agencies"`. Ugly, and it is what the existing rules permit —
   * changing the rules to suit one screen is the larger risk.
   */
  const slugBase = `kyc/agencies/${agencyId}`

  const [paymentType, setPaymentType] = useState<'india' | 'foreign'>(agency.paymentType ?? 'india')
  const [bank, setBank] = useState({
    accountHolderName: agency.accountHolderName ?? '',
    accountNumber:     agency.accountNumber ?? agency.bankAccount ?? '',
    confirmAccountNumber: '',
    ifscCode:          agency.ifscCode ?? agency.bankIfsc ?? '',
    bankName:          agency.bankName ?? '',
    branch:            agency.branch ?? '',
    upiId:             agency.upiId ?? '',
  })
  const [binanceUid, setBinanceUid] = useState(agency.binanceUid ?? '')

  const [doc1, setDoc1] = useState<UploadState>(emptyUpload())
  const [doc2, setDoc2] = useState<UploadState>(emptyUpload())
  const [doc3, setDoc3] = useState<UploadState>(emptyUpload())

  const [step, setStep] = useState<'payment' | 'docs'>('payment')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /** What the last submit actually did, in the partner's own words. */
  const [outcome, setOutcome] = useState('')

  const inputCls = "w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500"
  const setB = (k: keyof typeof bank) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setBank(f => ({ ...f, [k]: e.target.value }))

  function validatePayment(): string {
    if (paymentType === 'foreign') {
      if (!binanceUid.trim()) return 'Binance UID is required.'
    } else {
      if (!bank.accountHolderName.trim()) return 'Account holder name is required.'
      if (!bank.accountNumber.trim())     return 'Account number is required.'
      if (bank.accountNumber !== bank.confirmAccountNumber) return 'Account numbers do not match.'
      if (!bank.ifscCode.trim())          return 'IFSC code is required.'
      if (!bank.bankName.trim())          return 'Bank name is required.'
    }
    return ''
  }

  /**
   * Submit the bank details and the documents.
   *
   * **This used to write the new account number straight onto the live record**
   * while leaving `status: 'approved'` and `isActive: true` alone, which meant
   * an approved agency could redirect its own payouts and the record went on
   * reading "approved" to every screen that looks at it. The queue on /kyc keys
   * off `status`, so nobody ever looked again.
   *
   * Every field on this form is a payout field or a KYC document, so on a
   * decided record the whole payload is a *proposal*: it goes into
   * `pendingChanges`, the live fields do not move, and money keeps going to the
   * account somebody already verified until a reviewer applies it. A record
   * that has never been decided still writes directly — there is nothing to
   * protect yet, and `submitPartnerUpdate` decides which of the two applies from
   * the record's own `status`.
   *
   * Nothing about the agency's ability to trade, recruit or earn changes either
   * way. Replacing an expired Aadhaar is the ordinary reason to be on this form.
   */
  async function handleSubmit() {
    if (!doc1.url || !doc2.url || !doc3.url) { setError('Please upload all 3 KYC documents.'); return }
    if (doc1.uploading || doc2.uploading || doc3.uploading) { setError('Please wait for uploads to finish.'); return }
    setError('')
    setOutcome('')
    setSaving(true)
    try {
      const update: Record<string, unknown> = {
        kycStatus:      'submitted',
        kycDocUrls:     [doc1.url, doc2.url, doc3.url],
        kycSubmittedAt: serverTimestamp(),
        paymentType,
      }
      if (paymentType === 'foreign') {
        update.binanceUid = binanceUid.trim()
        update.currency   = 'USD'
      } else {
        update.accountHolderName = bank.accountHolderName.trim()
        update.accountNumber     = bank.accountNumber.trim()
        update.ifscCode          = bank.ifscCode.trim().toUpperCase()
        update.bankName          = bank.bankName.trim()
        update.branch            = bank.branch.trim()
        update.upiId             = bank.upiId.trim()
        update.currency          = 'INR'
      }
      const result = await submitPartnerUpdate({
        collection: 'agencies',
        id: agencyId,
        patch: update,
        actor,
        current: agency as unknown as Record<string, unknown>,
      })
      setOutcome(
        result.direct
          ? 'Saved. Your application is in the review queue.'
          : result.proposed.length > 0
            ? 'Sent for review. Nothing on your record has changed yet — you are ' +
              'still being paid into the account you had, and you can carry on ' +
              'as normal while somebody checks this.'
            : 'Nothing here differs from what we already hold, so there was ' +
              'nothing to send.',
      )
      onDone()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to submit KYC.')
    } finally {
      setSaving(false)
    }
  }

  /**
   * Whether this record actually has anything on file, as opposed to a status
   * saying it does.
   *
   * The section used to return null whenever `kycStatus` was `submitted` or
   * `approved`, and that is the gate that made this form invisible. It survived
   * the outer gate being removed, so the banner above pointed at a form that
   * returned null on the very record it was pointing about: an agency approved
   * with no documents reads `approved`, and approved was the one word that hid
   * the form.
   *
   * The status is a claim; the documents are the fact. A record can carry
   * `approved` with nothing behind it — a second capability granted from the
   * CRM does exactly that — and that is precisely when somebody needs this.
   */
  const hasDocuments = (agency.kycDocUrls ?? []).filter(Boolean).length > 0
  const hasBank =
    !!String(agency.accountNumber ?? agency.bankAccount ?? '').trim() ||
    !!String(agency.binanceUid ?? '').trim()
  const complete = hasDocuments && hasBank

  // Hidden only when it is genuinely with a reviewer AND there is something to
  // review. Everything else — approved-but-empty, rejected, never submitted,
  // or simply wanting to replace an expired document — renders the form.
  if (agency.kycStatus === 'submitted' && complete) return null

  return (
    <div className="bg-slate-900 border border-yellow-500/30 rounded-xl p-6 mb-6">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-full bg-yellow-500/10 flex items-center justify-center shrink-0">
          <FileText size={20} className="text-yellow-400" />
        </div>
        <div>
          <h3 className="text-white font-semibold">
            {complete ? 'Update your KYC and payment details' : 'Complete KYC Verification'}
          </h3>
          <p className="text-slate-400 text-xs mt-0.5">
            {agency.kycStatus === 'rejected'
              ? 'Your KYC was rejected. Please re-submit with correct documents.'
              : complete
                // Said before they fill it in, not after they submit. A partner
                // who expects the change to be live and finds it is not assumes
                // the form is broken and sends it again — which is how this
                // project acquired four copies of one host application.
                ? 'Changes here are checked by a reviewer before they take ' +
                  'effect. Until then you keep being paid into the account we ' +
                  'already hold, and nothing about your account changes.'
                : 'Submit your bank details and identity documents to activate your account.'}
          </p>
        </div>
      </div>

      {/* Step tabs */}
      <div className="flex gap-1 mb-5 bg-slate-800 rounded-lg p-1">
        <button
          onClick={() => { setError(''); setStep('payment') }}
          className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${step === 'payment' ? 'bg-pink-500 text-white' : 'text-slate-400 hover:text-white'}`}
        >
          1. Payment Details
        </button>
        <button
          onClick={() => {
            const err = validatePayment()
            if (err) { setError(err); return }
            setError('')
            setStep('docs')
          }}
          className={`flex-1 py-2 rounded-md text-sm font-medium transition-colors ${step === 'docs' ? 'bg-pink-500 text-white' : 'text-slate-400 hover:text-white'}`}
        >
          2. KYC Documents
        </button>
      </div>

      {step === 'payment' && (
        <div className="space-y-4">
          {/* Payment type toggle */}
          <div className="flex gap-2">
            <button type="button" onClick={() => setPaymentType('india')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${paymentType === 'india' ? 'border-pink-500 bg-pink-500/10 text-pink-300' : 'border-slate-600 text-slate-400 hover:border-slate-500'}`}>
              <IndianRupee size={15} /> Indian (₹ INR)
            </button>
            <button type="button" onClick={() => setPaymentType('foreign')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${paymentType === 'foreign' ? 'border-pink-500 bg-pink-500/10 text-pink-300' : 'border-slate-600 text-slate-400 hover:border-slate-500'}`}>
              <Globe size={15} /> International ($)
            </button>
          </div>

          {paymentType === 'foreign' ? (
            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Binance UID</label>
              <input value={binanceUid} onChange={e => setBinanceUid(e.target.value)} className={inputCls} placeholder="Binance account UID" />
              <p className="text-slate-500 text-xs mt-1">Find it in Binance App → Profile → UID</p>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Account Holder Name</label>
                <input value={bank.accountHolderName} onChange={setB('accountHolderName')} className={inputCls} placeholder="Exactly as on the bank account" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Account Number</label>
                  <input value={bank.accountNumber} onChange={setB('accountNumber')} className={inputCls} placeholder="Account number" />
                </div>
                <div>
                  <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Confirm Account No.</label>
                  <input value={bank.confirmAccountNumber} onChange={setB('confirmAccountNumber')} className={inputCls} placeholder="Re-enter number" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">IFSC Code</label>
                  <input value={bank.ifscCode} onChange={setB('ifscCode')} className={inputCls} placeholder="e.g. HDFC0001234" />
                </div>
                <div>
                  <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Bank Name</label>
                  <input value={bank.bankName} onChange={setB('bankName')} className={inputCls} placeholder="e.g. HDFC Bank" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Branch (optional)</label>
                  <input value={bank.branch} onChange={setB('branch')} className={inputCls} placeholder="Branch name" />
                </div>
                <div>
                  <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">UPI ID (optional)</label>
                  <input value={bank.upiId} onChange={setB('upiId')} className={inputCls} placeholder="name@upi" />
                </div>
              </div>
            </>
          )}

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <button
            onClick={() => {
              const err = validatePayment()
              if (err) { setError(err); return }
              setError('')
              setStep('docs')
            }}
            className="w-full bg-pink-500 hover:bg-pink-600 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-1.5"
          >
            Next: Upload Documents <ChevronRight size={15} />
          </button>
        </div>
      )}

      {step === 'docs' && (
        <div className="space-y-4">
          <DocUploadField
            label={paymentType === 'foreign' ? 'Passport' : 'Aadhaar Card'}
            description={paymentType === 'foreign' ? 'Valid passport photo page' : 'Front side of Aadhaar card'}
            state={doc1}
            storagePath={`${slugBase}/${ts}_doc1`}
            onChange={setDoc1}
          />
          <DocUploadField
            label={paymentType === 'foreign' ? 'Government / National ID' : 'PAN Card'}
            description={paymentType === 'foreign' ? "National ID or driver's license" : 'Clear photo of PAN card'}
            state={doc2}
            storagePath={`${slugBase}/${ts}_doc2`}
            onChange={setDoc2}
          />
          <DocUploadField
            label={paymentType === 'foreign' ? 'Proof of Address' : 'Bank Passbook'}
            description={paymentType === 'foreign' ? 'Recent utility bill or bank statement' : 'First page of bank passbook'}
            state={doc3}
            storagePath={`${slugBase}/${ts}_doc3`}
            onChange={setDoc3}
          />

          {error && <p className="text-red-400 text-sm">{error}</p>}
          {outcome && <p className="text-blue-300 text-sm">{outcome}</p>}

          <div className="flex gap-3">
            <button onClick={() => { setError(''); setStep('payment') }} className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors">
              <ChevronLeft size={15} /> Back
            </button>
            <button onClick={handleSubmit} disabled={saving} className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/50 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-2">
              {saving ? <><Loader2 size={14} className="animate-spin" />Submitting…</> : 'Submit KYC'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── AgencyProfileCard ────────────────────────────────────────────────────────

/**
 * What this agency still has to supply before it can actually be paid.
 *
 * An agency created for somebody — a coin seller granted the capability from
 * the CRM — arrives with no documents and, more importantly, no bank account.
 * A seller *pays* Zipper, so their existing record never had one; an agency
 * *is paid*, and a commission payout cannot be executed without it.
 *
 * Nothing told them any of that. The capability simply appeared in their
 * sidebar, approved, looking finished — and the gap would only surface weeks
 * later, at the moment somebody tried to pay them and could not.
 *
 * Deliberately not gated on `kycStatus`. A record can read "KYC Approved" and
 * still have nothing behind it, which is exactly the case this exists for.
 */
function SetupNeeded({ agency }: { agency: Agency }) {
  const noDocuments = (agency.kycDocUrls ?? []).filter(Boolean).length === 0
  const noBank =
    !String(agency.accountNumber ?? '').trim() &&
    !String(agency.binanceUid ?? '').trim()

  if (!noDocuments && !noBank) return null

  return (
    <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl px-5 py-4 mb-6">
      <div className="flex items-start gap-3">
        <AlertTriangle size={17} className="text-amber-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-amber-200 font-semibold text-sm">
            Your agency is not ready to be paid yet
          </p>
          <ul className="mt-2 space-y-1.5">
            {noBank && (
              <li className="text-amber-100/90 text-sm leading-relaxed">
                <strong>Add the bank account we should pay into.</strong> Your
                coin-seller record does not have one — you pay us there, and as
                an agency we pay you. Commission cannot be sent without it.
              </li>
            )}
            {noDocuments && (
              <li className="text-amber-100/90 text-sm leading-relaxed">
                <strong>Upload your KYC documents.</strong> The same Aadhaar and
                PAN are fine; this record needs its own copy.
              </li>
            )}
          </ul>
          <p className="text-amber-100/70 text-xs mt-2.5">
            Both are in the <strong>Complete KYC Verification</strong> form
            directly below this box. Nothing else is blocked meanwhile — you can
            add hosts and they will earn as normal.
          </p>
        </div>
      </div>
    </div>
  )
}


function AgencyProfileCard({ agency, agencyId }: { agency: Agency; agencyId: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 mb-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h2 className="text-white text-xl font-bold">{agency.agencyName}</h2>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <KycBadge status={agency.kycStatus} />
            {agency.bankName && (
              <span className="text-slate-400 text-sm">
                {agency.bankName} · ••••{maskAccount(agency.bankAccount)}
              </span>
            )}
            {agency.bankIfsc && (
              <span className="text-slate-500 text-sm">IFSC: {agency.bankIfsc}</span>
            )}
          </div>
          {/* Copyable ID and referral code row */}
          <div className="flex flex-wrap gap-4 mt-3">
            <CopyField label="Agency ID" value={agencyId} />
            {agency.referralCode && (
              <CopyField label="Referral Code" value={agency.referralCode} />
            )}
          </div>
        </div>
        {agency.referralCode && (
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-purple-500/10 border border-purple-500/30 rounded-lg">
            <Hash size={12} className="text-purple-400" />
            <span className="text-purple-300 font-mono text-sm font-semibold tracking-wider">
              {agency.referralCode}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────


// ── AddSubAgencyModal ──────────────────────────────────────────────────────────

type UploadState = { file: File | null; url: string; progress: number; uploading: boolean }
const emptyUpload = (): UploadState => ({ file: null, url: '', progress: 0, uploading: false })

function DocUploadField({
  label,
  description,
  state,
  storagePath,
  onChange,
}: {
  label: string
  description: string
  state: UploadState
  storagePath: string
  onChange: (next: UploadState) => void
}) {
  function handleFile(file: File) {
    onChange({ file, url: '', progress: 0, uploading: true })
    const storageRef = ref(storage, storagePath)
    const task = uploadBytesResumable(storageRef, file)
    task.on(
      'state_changed',
      (snap) => onChange({ file, url: '', progress: Math.round((snap.bytesTransferred / snap.totalBytes) * 100), uploading: true }),
      () => onChange({ file, url: '', progress: 0, uploading: false }),
      async () => {
        const url = await getDownloadURL(task.snapshot.ref)
        onChange({ file, url, progress: 100, uploading: false })
      }
    )
  }

  const done = !!state.url
  const isPdf = state.file?.name?.toLowerCase().endsWith('.pdf')

  return (
    <div>
      <p className="text-slate-300 text-sm font-medium mb-0.5">{label}</p>
      <p className="text-slate-500 text-xs mb-2">{description}</p>
      <label className={`flex items-center gap-3 border rounded-lg px-4 py-3 cursor-pointer transition-colors ${
        done ? 'border-green-500/40 bg-green-500/5' :
        state.uploading ? 'border-pink-500/40 bg-pink-500/5' :
        'border-slate-600 bg-slate-700/50 hover:border-slate-500'
      }`}>
        <input type="file" accept="image/*,.pdf" className="sr-only" onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} />
        {done ? (
          <>
            <CheckCircle2 size={18} className="text-green-400 shrink-0" />
            {isPdf ? (
              <span className="text-green-300 text-sm truncate flex-1">{state.file?.name}</span>
            ) : (
              <img src={state.url} alt={label} className="h-10 w-14 object-cover rounded border border-slate-600" />
            )}
            <span className="text-green-400 text-xs ml-auto">Uploaded</span>
          </>
        ) : state.uploading ? (
          <>
            <Loader2 size={18} className="text-pink-400 animate-spin shrink-0" />
            <div className="flex-1">
              <div className="h-1.5 bg-slate-600 rounded-full overflow-hidden">
                <div className="h-full bg-pink-500 transition-all" style={{ width: `${state.progress}%` }} />
              </div>
              <p className="text-slate-400 text-xs mt-1">{state.progress}%</p>
            </div>
          </>
        ) : (
          <>
            <Upload size={18} className="text-slate-400 shrink-0" />
            <div>
              <p className="text-slate-300 text-sm">Click to upload</p>
              <p className="text-slate-500 text-xs">JPG, PNG or PDF</p>
            </div>
          </>
        )}
      </label>
    </div>
  )
}

function AddSubAgencyModal({
  parentAgencyId,
  parentAgencyName,
  onClose,
  onCreated,
}: {
  parentAgencyId: string
  parentAgencyName: string
  onClose: () => void
  onCreated: () => void
}) {
  const [step, setStep] = useState(1)

  // Step 1 — basic info
  const [basic, setBasic] = useState({
    agencyName: '', ownerName: '', ownerPhone: '', ownerEmail: '', password: '',
  })

  // Step 2 — payment details
  const [paymentType, setPaymentType] = useState<'india' | 'foreign'>('india')
  const [bank, setBank] = useState({
    accountHolderName: '', accountNumber: '', confirmAccountNumber: '', ifscCode: '', bankName: '', branch: '', upiId: '',
  })
  const [binanceUid, setBinanceUid] = useState('')

  // Step 3 — KYC docs
  const ts = Date.now()
  const slugBase = `kyc/sub-agencies/${ts}`
  const [doc1, setDoc1] = useState<UploadState>(emptyUpload())
  const [doc2, setDoc2] = useState<UploadState>(emptyUpload())
  const [doc3, setDoc3] = useState<UploadState>(emptyUpload())

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  /**
   * GOV B07: set when the sub-agency and its login were BOTH created and only
   * the owner link was refused. The form then offers Close and nothing else —
   * creating again would make a second record.
   */
  const [createdUnlinked, setCreatedUnlinked] = useState(false)
  /** Decision 16 (RC): set when a FRESH application was filed for an existing login. */
  const [reapplied, setReapplied] = useState('')

  const inputCls = "w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500"
  const setB = (k: keyof typeof basic) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setBasic(f => ({ ...f, [k]: e.target.value }))
  const setBank_ = (k: keyof typeof bank) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setBank(f => ({ ...f, [k]: e.target.value }))

  function validateStep1(): string {
    if (!basic.agencyName.trim()) return 'Sub-agency name is required.'
    if (!basic.ownerName.trim())  return 'Owner name is required.'
    if (!basic.ownerPhone.trim()) return 'Owner phone is required.'
    if (!basic.ownerEmail.trim()) return 'Owner email is required.'
    if (basic.password.length < 6) return 'Password must be at least 6 characters.'
    return ''
  }

  function validateStep2(): string {
    if (paymentType === 'foreign') {
      if (!binanceUid.trim()) return 'Binance UID is required for international agencies.'
    } else {
      if (!bank.accountHolderName.trim()) return 'Account holder name is required.'
      if (!bank.accountNumber.trim())     return 'Account number is required.'
      if (bank.accountNumber !== bank.confirmAccountNumber) return 'Account numbers do not match.'
      if (!bank.ifscCode.trim())          return 'IFSC code is required.'
      if (!bank.bankName.trim())          return 'Bank name is required.'
    }
    return ''
  }

  function validateStep3(): string {
    if (!doc1.url) return 'Please upload the first KYC document.'
    if (!doc2.url) return 'Please upload the second KYC document.'
    if (!doc3.url) return 'Please upload the third KYC document.'
    if (doc1.uploading || doc2.uploading || doc3.uploading) return 'Please wait for uploads to finish.'
    return ''
  }

  function nextStep() {
    const err = step === 1 ? validateStep1() : validateStep2()
    if (err) { setError(err); return }
    setError('')
    setStep(s => s + 1)
  }

  async function handleCreate() {
    const err = validateStep3()
    if (err) { setError(err); return }
    setError('')
    setSaving(true)
    try {
      // FX-03: the same owner must not get a second sub-agency here — a second
      // click, another tab, or an orphan an earlier attempt left behind. Read
      // fresh (the dashboard's list may be stale); the parent's own
      // sub-agencies are what this login may list (firestore.rules).
      const siblings = await getDocs(query(collection(db, 'agencies'), where('parentAgencyId', '==', parentAgencyId)))
      const duplicate = findDuplicateSubAgency(
        siblings.docs.map((d) => ({
          id: d.id,
          ownerEmail: d.get('ownerEmail'),
          ownerPhone: d.get('ownerPhone'),
          status: d.get('status'),
        })),
        basic.ownerEmail,
        basic.ownerPhone,
      )
      if (duplicate) { setError(duplicateSubAgencyMessage(duplicate)); return }

      const nameSlug = basic.agencyName.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'SUB'
      const referralCode = nameSlug + Math.random().toString(36).toUpperCase().slice(2, 6)

      const agencyData: Record<string, unknown> = {
        type: 'sub',
        parentAgencyId,
        agencyName: basic.agencyName.trim(),
        ownerName:  basic.ownerName.trim(),
        ownerPhone: basic.ownerPhone.trim(),
        ownerEmail: basic.ownerEmail.trim().toLowerCase(),
        referralCode,
        paymentType,
        status:    'pending',
        isActive:  false,
        kycStatus: 'submitted',
        kycDocUrls: [doc1.url, doc2.url, doc3.url],
        kycSubmittedAt: serverTimestamp(),
        totalHosts: 0,
        totalSubAgencies: 0,
        createdAt: serverTimestamp(),
        source: 'agency_created',
        // P0-5: the sub-agency's own login is a brand-new, unverified password
        // account, so `firestore.rules` binds it to this record by WHO MADE
        // the record — a login of the parent agency — not by its address.
        createdByUid: auth.currentUser?.uid ?? '',
      }

      if (paymentType === 'foreign') {
        agencyData.binanceUid = binanceUid.trim()
        agencyData.currency   = 'USD'
      } else {
        agencyData.accountHolderName = bank.accountHolderName.trim()
        agencyData.accountNumber     = bank.accountNumber.trim()
        agencyData.ifscCode          = bank.ifscCode.trim().toUpperCase()
        agencyData.bankName          = bank.bankName.trim()
        agencyData.branch            = bank.branch.trim()
        agencyData.upiId             = bank.upiId.trim()
        agencyData.currency          = 'INR'
      }

      // FX-03: the LOGIN is created first; the record is written only once it
      // exists (`writeRecord`), and the login is removed again if the record
      // write fails — so a failed or repeated attempt leaves nothing behind.
      // GOV B07: the new login then writes the record's `crmUid` back-link, so
      // the sub-agency is not owned by nobody (see createSubAgencyAccount).
      let account: Awaited<ReturnType<typeof createSubAgencyAccount>>
      try {
        account = await createSubAgencyAccount({
          email:    basic.ownerEmail.trim().toLowerCase(),
          password: basic.password,
          name:     basic.ownerName.trim(),
          phone:    basic.ownerPhone.trim(),
          writeRecord: async () => (await addDoc(collection(db, 'agencies'), agencyData)).id,
        })
      } catch (err: unknown) {
        // Decision 16 (RC): the address already has a login — typically the
        // person's earlier Sub-agency application was rejected. Nothing was
        // written; ask the API to file a FRESH application for that login.
        // It refuses (with the reason) if the login does not qualify.
        if (!isAddressInUse(err)) throw err
        const email = basic.ownerEmail.trim().toLowerCase()
        const filed = await partnerOps.reapplySubAgency(parentAgencyId, {
          email, form: reapplyFormFrom(agencyData),
        })
        onCreated()
        setError('')
        setReapplied(reappliedMessage(email, filed.reapplication_of))
        return
      }

      onCreated()
      if (!account.linked) {
        setCreatedUnlinked(true)
        return
      }
      onClose()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create sub-agency.')
    } finally {
      setSaving(false)
    }
  }

  const STEPS = ['Basic info', 'Payment details', 'KYC documents']

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-800 border border-slate-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-700 shrink-0">
          <div>
            <h3 className="text-lg font-semibold text-white">Add Sub-Agency</h3>
            <p className="text-slate-400 text-xs mt-0.5">Under {parentAgencyName}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors"><X size={20} /></button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 px-6 py-3 border-b border-slate-700 shrink-0">
          {STEPS.map((label, i) => (
            <div key={i} className="flex items-center gap-2 flex-1">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                i + 1 < step ? 'bg-green-500 text-white' :
                i + 1 === step ? 'bg-pink-500 text-white' :
                'bg-slate-700 text-slate-400'
              }`}>
                {i + 1 < step ? <CheckCircle2 size={14} /> : i + 1}
              </div>
              <span className={`text-xs font-medium hidden sm:block ${i + 1 === step ? 'text-white' : 'text-slate-500'}`}>{label}</span>
              {i < STEPS.length - 1 && <div className="flex-1 h-px bg-slate-700 ml-1" />}
            </div>
          ))}
        </div>

        {/* Body — scrollable */}
        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">

          {/* ── Step 1: Basic info ── */}
          {step === 1 && (
            <>
              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Sub-Agency Name</label>
                <input value={basic.agencyName} onChange={setB('agencyName')} className={inputCls} placeholder="e.g. Zipper West Agency" />
              </div>
              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Owner Full Name</label>
                <input value={basic.ownerName} onChange={setB('ownerName')} className={inputCls} placeholder="Owner name" />
              </div>
              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Owner Phone</label>
                <PhoneInput value={basic.ownerPhone} onChange={v => setBasic(f => ({ ...f, ownerPhone: v }))} className={inputCls} placeholder="Mobile number" />
              </div>
              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Owner Email</label>
                <input value={basic.ownerEmail} onChange={setB('ownerEmail')} type="email" className={inputCls} placeholder="owner@email.com" />
              </div>
              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Login Password</label>
                <input value={basic.password} onChange={setB('password')} type="password" className={inputCls} placeholder="Min 6 characters" />
                <p className="text-slate-500 text-xs mt-1">This will be the sub-agency owner's CRM login password.</p>
              </div>
            </>
          )}

          {/* ── Step 2: Payment details ── */}
          {step === 2 && (
            <>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPaymentType('india')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                    paymentType === 'india' ? 'border-pink-500 bg-pink-500/10 text-pink-300' : 'border-slate-600 text-slate-400 hover:border-slate-500'
                  }`}
                >
                  <IndianRupee size={15} /> Indian (₹ INR)
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentType('foreign')}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                    paymentType === 'foreign' ? 'border-pink-500 bg-pink-500/10 text-pink-300' : 'border-slate-600 text-slate-400 hover:border-slate-500'
                  }`}
                >
                  <Globe size={15} /> International ($)
                </button>
              </div>

              <div className="bg-slate-700/40 border border-slate-600 rounded-lg px-4 py-2.5 text-xs text-slate-400">
                {paymentType === 'india'
                  ? '🇮🇳 Payouts via bank transfer — ₹1,000 per 1 lakh beans'
                  : '🌍 Payouts via Binance — $10 per 1 lakh beans'}
              </div>

              {paymentType === 'foreign' ? (
                <div>
                  <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Binance UID</label>
                  <input value={binanceUid} onChange={e => setBinanceUid(e.target.value)} className={inputCls} placeholder="Binance account UID (numbers only)" />
                  <p className="text-slate-500 text-xs mt-1">Find it in Binance App → Profile → UID</p>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Account Holder Name</label>
                    <input value={bank.accountHolderName} onChange={setBank_('accountHolderName')} className={inputCls} placeholder="Exactly as printed on the account" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Account Number</label>
                      <input value={bank.accountNumber} onChange={setBank_('accountNumber')} className={inputCls} placeholder="Account number" />
                    </div>
                    <div>
                      <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Confirm Account No.</label>
                      <input value={bank.confirmAccountNumber} onChange={setBank_('confirmAccountNumber')} className={inputCls} placeholder="Re-enter account number" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">IFSC Code</label>
                      <input value={bank.ifscCode} onChange={setBank_('ifscCode')} className={inputCls} placeholder="e.g. HDFC0001234" />
                    </div>
                    <div>
                      <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Bank Name</label>
                      <input value={bank.bankName} onChange={setBank_('bankName')} className={inputCls} placeholder="e.g. HDFC Bank" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">Branch (optional)</label>
                      <input value={bank.branch} onChange={setBank_('branch')} className={inputCls} placeholder="Branch name" />
                    </div>
                    <div>
                      <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">UPI ID (optional)</label>
                      <input value={bank.upiId} onChange={setBank_('upiId')} className={inputCls} placeholder="name@upi" />
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {/* ── Step 3: KYC documents ── */}
          {step === 3 && (
            <>
              <p className="text-slate-400 text-sm">Upload identification and bank documents for KYC verification.</p>
              <DocUploadField
                label={paymentType === 'foreign' ? 'Passport' : 'Aadhaar Card'}
                description={paymentType === 'foreign' ? 'Valid passport photo page' : 'Front side of Aadhaar card (JPG, PNG or PDF)'}
                state={doc1}
                storagePath={`${slugBase}/doc1_aadhaar`}
                onChange={setDoc1}
              />
              <DocUploadField
                label={paymentType === 'foreign' ? 'Government / National ID' : 'PAN Card'}
                description={paymentType === 'foreign' ? "National ID or driver's license" : 'Clear photo of PAN card (JPG, PNG or PDF)'}
                state={doc2}
                storagePath={`${slugBase}/doc2_pan`}
                onChange={setDoc2}
              />
              <DocUploadField
                label={paymentType === 'foreign' ? 'Proof of Address' : 'Bank Passbook'}
                description={paymentType === 'foreign' ? 'Recent utility bill or bank statement' : 'First page of bank passbook (JPG, PNG or PDF)'}
                state={doc3}
                storagePath={`${slugBase}/doc3_passbook`}
                onChange={setDoc3}
              />
              <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2.5">
                <p className="text-yellow-400 text-xs">Sub-agency will be pending until the super admin reviews and approves the KYC documents.</p>
              </div>
            </>
          )}

          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {reapplied && (
            <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3">
              <p className="text-green-200 text-sm">{reapplied}</p>
            </div>
          )}

          {createdUnlinked && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
              <p className="text-amber-200 text-sm">
                The sub-agency and its login were created, but the login could not
                be linked to the record. Do not create it again — ask the
                administrator to attach the login to the record. It is listed
                below as pending either way.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-slate-700 shrink-0">
          {createdUnlinked || reapplied ? (
            <button onClick={onClose} className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors">Close</button>
          ) : step > 1 ? (
            <button onClick={() => { setError(''); setStep(s => s - 1) }} className="flex items-center gap-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors">
              <ChevronLeft size={15} /> Back
            </button>
          ) : (
            <button onClick={onClose} className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors">Cancel</button>
          )}
          {createdUnlinked || reapplied ? null : step < 3 ? (
            <button onClick={nextStep} className="flex-1 bg-pink-500 hover:bg-pink-600 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-1.5">
              Next <ChevronRight size={15} />
            </button>
          ) : (
            <button onClick={handleCreate} disabled={saving} className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/50 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-2">
              {saving ? <><Loader2 size={14} className="animate-spin" />Creating…</> : 'Create Sub-Agency'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function ApprovedInviteRow({ app }: { app: HostApplication }) {
  const [copied, setCopied] = useState(false)
  // Typing this row turned up a real bug the `any` was hiding: an application
  // with no referral code copied the string "undefined" to the clipboard and
  // reported success. There is nothing to copy in that case, and saying so is
  // better than handing someone a code that will never activate anything.
  const code = app.referralCode ?? ''
  function handleCopy() {
    if (!code) return
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="flex items-center justify-between bg-green-500/5 border border-green-500/20 rounded-lg px-4 py-3">
      <div>
        <p className="text-white text-sm font-medium">{app.hostName}</p>
        <p className="text-slate-400 text-xs mt-0.5">
          <span className="font-medium text-slate-300">{app.applicantPhone}</span>
          {' · '}
          <span className="font-medium text-slate-300">{app.applicantEmail}</span>
        </p>
      </div>
      <div className="flex items-center gap-3">
        <span className="font-mono text-purple-300 text-lg font-bold tracking-widest">
          {code || <span className="text-slate-500 text-sm tracking-normal">no code on record</span>}
        </span>
        <button
          onClick={handleCopy}
          disabled={!code}
          title={code ? undefined : 'This application has no referral code, so there is nothing to copy.'}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            copied
              ? 'bg-green-500/20 border-green-500/30 text-green-400'
              : 'bg-purple-500/10 border-purple-500/30 text-purple-300 hover:bg-purple-500/20 hover:text-purple-200'
          }`}
        >
          {copied ? <CheckCircle2 size={14} /> : <Copy size={14} />}
          {copied ? 'Copied!' : 'Copy Code'}
        </button>
      </div>
    </div>
  )
}

export default function AgencyDashboardPage() {
  const { crmUser } = useAuth()

  const [agency, setAgency] = useState<Agency | null>(null)
  const [hosts, setHosts] = useState<Host[]>([])
  /** Which host's inline panel is open. Empty for none. */
  const [openHost, setOpenHost] = useState('')
  /** Every invitation this agency has ever filed, redeemed ones included. */
  const [allHostApps, setAllHostApps] = useState<HostApplication[]>([])
  const [pendingHostApps, setPendingHostApps] = useState<HostApplication[]>([])
  const [approvedHostApps, setApprovedHostApps] = useState<HostApplication[]>([])
  // Rejected invitations were fetched and then dropped on the floor: the two
  // buckets above are the only ones the table rendered, so an agency whose host
  // was turned down saw the row simply vanish with no reason given. Being told
  // no is the single most useful thing this screen can say.
  const [rejectedHostApps, setRejectedHostApps] = useState<HostApplication[]>([])
  const [salaryRequests, setSalaryRequests] = useState<SalaryRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [showSalaryForm, setShowSalaryForm] = useState(false)
  const [showAddHost, setShowAddHost] = useState(false)
  const [showAddSubAgency, setShowAddSubAgency] = useState(false)
  const [subAgencies, setSubAgencies] = useState<SubAgency[]>([])
  const [markingId, setMarkingId] = useState<string | null>(null)
  // FX-12: withdrawing one of our own PENDING invitations (the rules allow an
  // agency exactly that: its own, still pending, never redeemed).
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null)
  const [withdrawFailure, setWithdrawFailure] = useState<{ id: string; message: string } | null>(null)

  /**
   * Why each of the four lists above may be empty.
   *
   * They are plain arrays because almost everything on this page iterates them,
   * and turning each into a `ReadResult` would rewrite a screen this task has no
   * business rewriting. What was missing is the other half of the fact: a
   * refused query left its array at `[]` and `console.error`'d, so the only
   * record that the read had failed at all was in a console nobody has open.
   * The page then counted the empty array and printed the count.
   *
   * `undefined` here means the read succeeded — an empty list is then a genuine
   * empty and the ordinary "nothing yet" copy is the truth. A `ReadFailure`
   * means the list is empty because we were not allowed to look, or could not,
   * and every figure derived from it is withheld rather than shown as zero.
   */
  const [failures, setFailures] = useState<{
    agency?: ReadFailure
    hosts?: ReadFailure
    salary?: ReadFailure
    subAgencies?: ReadFailure
    applications?: ReadFailure
  }>({})

  const agencyId = crmUser?.agencyId

  /**
   * Who a proposal is recorded against. The agency owner proposing a change to
   * their own record, so it is this login — and the reviewer's four-eyes check
   * on the server compares the applier's uid against exactly this.
   */
  const proposer: Proposer = {
    uid: crmUser?.uid ?? '',
    name: crmUser?.name ?? '',
    role: crmUser?.role ?? '',
  }

  /**
   * FX-12 (RF-18): the "withdraw" the rules always allowed and no screen
   * offered. Without it the only way out of a wrong invitation was a second
   * one — which is how the duplicates piled up.
   */
  async function withdrawInvitation(app: HostApplication) {
    const who = app.hostName || 'this host'
    if (!window.confirm(
      `Withdraw the invitation for ${who}? They will not be able to join with your code ` +
      'unless you invite them again. The photo and documents you uploaded for it are deleted.',
    )) return
    setWithdrawingId(app.id)
    setWithdrawFailure(null)
    try {
      await deleteDoc(doc(db, 'hostApplications', app.id))
      await loadData()
    } catch (err: unknown) {
      setWithdrawFailure({
        id: app.id,
        message: err instanceof Error ? err.message : 'The invitation could not be withdrawn.',
      })
    } finally {
      setWithdrawingId(null)
    }
  }

  async function loadData() {
    if (!agencyId) { setLoading(false); return }
    setFailures({})
    try {
      // Host invitations: pending (awaiting approval) + approved (code ready to share).
      // Deliberately fire-and-forget (not awaited) — it must never block first paint.
      // The `.catch` used to be empty, which meant a refused read of this query
      // reduced the host count by however many invitations exist and said
      // nothing at all. It is still fire-and-forget; it is no longer silent.
      const allAppsQ = query(collection(db, 'hostApplications'), where('agencyId', '==', agencyId))
      getDocs(allAppsQ).then(snap => {
        const apps = snap.docs.map(
          (d) => ({ id: d.id, ...(d.data() as Omit<HostApplication, 'id'>) }),
        )
        // The whole list is kept now. It used to be split into three buckets
        // and the remainder thrown away — and the remainder is every invitation
        // that was actually redeemed, which is to say every real host. That is
        // why an agency could open the KYC of somebody it was still waiting on
        // and had no way to see the same documents once they joined.
        setAllHostApps(apps)
        setPendingHostApps(apps.filter((a) => a.status === 'pending'))
        setApprovedHostApps(apps.filter((a) => a.status === 'approved' && !a.isActivated))
        setRejectedHostApps(apps.filter((a) => a.status === 'rejected'))
      }).catch((err: unknown) => {
        setFailures((f) => ({ ...f, applications: toFailure(err, 'host applications') }))
      })

      // The remaining four reads are mutually independent — every one of them is
      // keyed off `agencyId` (which comes from crmUser), none consumes the result
      // of another, so they run as a single parallel batch instead of four serial
      // round-trips to asia-east1 (~450ms of avoidable latency per load).
      // allSettled, not all: one failing query must not blank the whole page.
      const [agencyRes, hostsRes, salaryRes, subRes] = await Promise.allSettled([
        getDoc(doc(db, 'agencies', agencyId)),
        // FX-11 (RF-16): the agency's OWN roster, which an agency login may
        // read. This used to LIST `users where agencyId == …`, and the rules
        // allow listing users to staff only — so every agency login was
        // refused its own host list. Each current row is completed from its
        // user document below, by a single GET, which the rules allow.
        getDocs(collection(db, 'agencies', agencyId, 'agencyHosts')),
        getDocs(query(collection(db, 'salaryRequests'), where('agencyId', '==', agencyId))),
        getDocs(query(collection(db, 'agencies'), where('parentAgencyId', '==', agencyId))),
      ])

      // Each of the four is recorded whichever way it lands. `fromSettled`
      // still logs the rejection to the console — it is the same
      // `console.error` these four branches used to do, moved into one place —
      // but it also hands back a sentence fit to put on screen, which is the
      // half that was missing.
      const agencyRead = fromSettled(agencyRes, 'agency record')
      const hostsRead = fromSettled(hostsRes, 'hosts')
      const salaryRead = fromSettled(salaryRes, 'salary requests')
      const subRead = fromSettled(subRes, 'sub-agencies')

      setFailures((f) => ({
        ...f,
        agency: agencyRead.ok ? undefined : agencyRead,
        hosts: hostsRead.ok ? undefined : hostsRead,
        salary: salaryRead.ok ? undefined : salaryRead,
        subAgencies: subRead.ok ? undefined : subRead,
      }))

      // Agency doc
      if (agencyRead.ok && agencyRead.value.exists()) {
        setAgency({ id: agencyRead.value.id, ...(agencyRead.value.data() as Omit<Agency, 'id'>) })
      }

      // Hosts — current roster rows (FX-10: `active: false` is history), each
      // completed from its user document. A user document that cannot be read
      // still leaves the host listed, from the roster row.
      if (hostsRead.ok) {
        const rows = currentRosterRows(
          hostsRead.value.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
        )
        const reads = await Promise.allSettled(
          rows.map((r) => {
            const uid = rosterRowUid(r)
            return getDoc(doc(db, 'users', uid))
          }),
        )
        const usersByUid = new Map<string, Record<string, unknown> | null>()
        rows.forEach((r, i) => {
          const res = reads[i]
          usersByUid.set(
            rosterRowUid(r),
            res.status === 'fulfilled' && res.value.exists() ? (res.value.data() as Record<string, unknown>) : null,
          )
        })
        setHosts(hostsFromRoster<Host>(rows, usersByUid))
      }

      // Salary requests
      if (salaryRead.ok) {
        setSalaryRequests(
          salaryRead.value.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SalaryRequest, 'id'>) }))
        )
      }

      // Sub-agencies (only for main agencies)
      if (subRead.ok) {
        setSubAgencies(subRead.value.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SubAgency, 'id'>) })))
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  // `role === 'agency'` became "holds the agency capability". Identical for a
  // login that holds one; true as well for one that is also a coin seller, whose
  // agency records are exactly the same records.
  const isAgencyUser = partnerRolesOf(crmUser).includes('agency')

  useEffect(() => {
    if (isAgencyUser) {
      loadData()
    } else {
      setLoading(false)
    }
  }, [crmUser, agencyId, isAgencyUser])

  // ── EVERY HOOK MUST SIT ABOVE EVERY `return` ──────────────────────────────
  //
  // These two lived at the bottom of the component, below three conditional
  // returns (`!isAgencyUser`, `!agencyId && !loading`, and `loading`). React
  // counts hooks positionally, so the first render — which returns the
  // spinner at `loading === true` — ran 17 hooks, and the render after
  // `setLoading(false)` ran 23. That is
  //
  //     Error: Rendered more hooks than during the previous render.
  //
  // thrown during render, which Next's built-in GlobalError turns into
  // "Application error: a client-side exception has occurred" — the whole
  // agency dashboard, blank, for every agency owner whose `crmUsers.agencyId`
  // is set. It was in the shipped bundle, not just in source.
  //
  // Moving them changes no rendering behaviour: all three dependencies are
  // `useState` values declared far above, and `useSecureThumbs` already
  // no-ops on an empty id list. It is purely about running unconditionally.
  //
  // `app.photoUrl` points at `hostPhotos/{agencyId}/` and is stored as a
  // permanent `?alt=media&token=` URL — a bearer credential Storage Rules are
  // never consulted for. The three tables below render up to a few dozen of
  // them, so they are signed in one batch rather than one request per row.
  //
  // The agency is entitled to these: `services/documents._may_see` scopes a
  // partner to its own records, so this returns photographs for the hosts
  // this agency invited and nothing for anybody else's.
  const hostPhotoIds = useMemo(
    () => [...pendingHostApps, ...approvedHostApps, ...rejectedHostApps].map((a) => a.id),
    [pendingHostApps, approvedHostApps, rejectedHostApps],
  )
  const hostPhotos = useSecureThumbs('host', hostPhotoIds, 'photo')

  // ── GOV B08: one row per PERSON (above every return, like the two above) ──
  //
  // A pending or approved application whose `activatedByUid || applicantUid`
  // is one of this agency's hosts is that host — it is not listed again as
  // "Pending Approval" / "Awaiting Activation" and not counted again. An
  // invitation nobody has redeemed that carries one of your hosts' own phone
  // or email stays listed, flagged. `panelApp` is the application each host's
  // inline panel shows: the redeemed one, else the approved, else the pending.
  const reconciledHosts = useMemo(() => {
    const rows = reconcileHostRows(hosts, [...pendingHostApps, ...approvedHostApps])
    const status = new Map(hosts.map((h) => [h.uid, personStatusOf(h.isHost)] as const))
    const panelApp = new Map<string, HostApplication>()
    for (const h of hosts) {
      const mine = allHostApps.filter((a) => linkedPersonUid(a, (uid) => status.get(uid)) === h.uid)
      const best = primaryApplication(mine)
      if (best) panelApp.set(h.uid, best)
    }
    return { rows, panelApp }
  }, [hosts, pendingHostApps, approvedHostApps, allHostApps])

  async function handleMarkDistributed(req: SalaryRequest) {
    setMarkingId(req.id)
    try {
      await updateDoc(doc(db, 'salaryRequests', req.id), {
        status: 'distributed',
        distributedAt: serverTimestamp(),
      })
      await loadData()
    } catch (err) {
      console.error(err)
    } finally {
      setMarkingId(null)
    }
  }

  // Access denied
  if (!isAgencyUser) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Shield size={48} className="text-slate-600" />
        <h1 className="text-white text-2xl font-bold">Access Denied</h1>
        <p className="text-slate-400 text-sm">This page is only available to agency accounts.</p>
      </div>
    )
  }

  // Agency account exists but no agencyId linked — admin forgot to set it
  if (!agencyId && !loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Building2 size={48} className="text-slate-600" />
        <h1 className="text-white text-xl font-bold">Agency Not Linked</h1>
        {/* This used to say "they need to use Invite Owner to CRM from the
            agency detail page". There is no such control — not on the agency
            detail page, not anywhere in this app — so it sent every affected
            owner to a button that does not exist. Registration now creates the
            login and writes both links itself, on the direct path and through
            the approval queue, so this state only arises from a registration
            that half-failed. Repairing one is a manual job, and saying so is
            the only honest thing this screen can do. */}
        <p className="text-slate-400 text-sm text-center max-w-md">
          Your CRM account is not linked to an agency yet, so there is nothing for
          this page to show. This is a broken registration, not something you can
          fix from here.
        </p>
        <p className="text-slate-500 text-sm text-center max-w-md">
          Send the administrator the account address below and ask them to link it
          to your agency record. There is no screen in the CRM that does it — the
          link is two fields, <span className="font-mono text-slate-400">agencyId</span> on
          the CRM account and <span className="font-mono text-slate-400">crmUid</span> on
          the agency, and they have to be set directly in the Firebase console.
        </p>
        <p className="text-slate-500 text-xs">Account: {crmUser?.email}</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  const pendingSalary = salaryRequests.filter((r) => r.status === 'pending').length

  /**
   * `h.beans ?? 0` is left as it is, and the reason is worth writing down.
   *
   * A `users` document that carries no `beans` field describes a host who has
   * been credited none — the field is written by the app when beans are earned,
   * so its absence is a measured nothing about a host we *did* read. Summing it
   * as zero is right.
   *
   * What was wrong was one level up: when the hosts query itself was refused,
   * `hosts` stayed `[]`, this reduce returned 0, and the tile printed "0" in the
   * same type as a real total. So the sum is only shown when the read that
   * produced the rows actually answered — see `failures.hosts` below.
   */
  const totalBeans = hosts.reduce((sum, h) => sum + (h.beans ?? 0), 0)

  // A host count is three reads added together, and two of them can fail
  // independently. If either did, the sum is not a count of anything.
  const hostCountUnread = failures.hosts ?? failures.applications
  // GOV B08: people, not rows — an application that is one of your hosts, or
  // that carries one of your hosts' own contact, is not somebody new.
  const separateRows = reconciledHosts.rows.applicationRows
  const shownPending = separateRows.filter((r) => r.app.status === 'pending')
  const shownApproved = separateRows.filter((r) => r.app.status === 'approved')
  const totalHostCount = hosts.length + reconciledHosts.rows.separateApplicants

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-8">
        <Building2 size={28} className="text-pink-500" />
        <div>
          <h1 className="text-white text-3xl font-bold">My Agency</h1>
          <p className="text-slate-400 text-sm mt-0.5">Manage your hosts and salary requests</p>
        </div>
      </div>

      {/* Agency profile card */}
      {agency && (
        <AgencyProfileCard agency={agency} agencyId={agencyId ?? ''} />
      )}

      {agency && <SetupNeeded agency={agency} />}

      {/* Directly under the banner that points at it.
          This used to sit after the whole commission block — the period
          picker, four tiles, the derivation, the slab table, the host list and
          the ledger — which is several screens of scrolling on a laptop. So the
          banner said "below" and was, strictly, telling the truth, and the
          owner scrolled and could not find it. An agency that cannot yet be
          paid has nothing more important on this page than the form that fixes
          that; a commission figure reading ₹0 because they have no hosts yet
          can wait a few hundred pixels. */}
      {/* Always available, not only while KYC is pending or rejected.
          Gating it on status made the form vanish the moment an agency was
          approved — including the case that matters most, a second capability
          approved with no documents on file at all, where the approval itself
          was what removed the only screen they could have used to supply them.
          Documents also expire and get replaced; there is no state in which
          "you may not give us a better copy of your Aadhaar" is the right
          answer. Uploading sends the record back for review either way. */}
      {/* Above the form, never below it. The whole reason this panel exists is
          that a successful proposal leaves the record looking untouched, so it
          has to be the first thing seen by somebody who came back to check
          whether their bank change went through. */}
      {agency && (
        <PendingChangesNotice
          record={agency as unknown as Record<string, unknown>}
          kind="agency"
        />
      )}

      {agency && (
        <KycSubmitSection
          agency={agency}
          agencyId={agencyId ?? ''}
          actor={proposer}
          onDone={loadData}
        />
      )}


      {/*
        The money. Everything above and below this line reads Firestore for app
        state — hosts, KYC, sub-agency records — and none of it can answer "what
        have I earned". That answer lives in the ledger behind the API, and this
        is the component that asks for it. It carries its own loading, empty,
        refused and error states, so a failure here leaves the rest of the
        dashboard exactly as it was.
      */}
      {/* What users have reported about this agency's hosts, and the way to
          contest a decision. Renders nothing when there are none. */}
      {agencyId && crmUser && (
        <HostReports
          agencyId={agencyId}
          actor={{ uid: crmUser.uid, name: crmUser.name }}
        />
      )}

      {/* The roster goes in so the earnings table can name people. An agency
          reads that table to decide who to thank and who to chase, and a
          column of Firebase uids answers neither question. */}
      {/* `failures.hosts` goes with the roster, not as an afterthought: `hosts`
          stays `[]` when that query is refused, so a panel handed the array alone
          cannot tell "no hosts" from "not allowed to look" and would print the
          reassuring one. */}
      <AgencyMoney
        rosterFailure={failures.hosts}
        roster={hosts.map((h) => ({
          uid: h.uid,
          name: h.name,
          photoUrl: h.photoUrl,
          // The HOST ladder. This used to pass `level`, the XP field nothing
          // writes, so every row in the earnings panel showed "Lv —".
          hostLevel: h.hostLevel,
          callRateBeans: h.callRateBeans,
          isVerifiedHost: h.isVerifiedHost,
          isBanned: h.isBanned,
        }))}
      />

      {/* Apply to sell coins as well. Renders nothing unless this login is an
          approved agency that is not already a coin seller. */}
      <SecondRoleCard />

      {/* KYC submission section — shown when pending or rejected */}
      {/* The agency record itself is a separate read from the four lists, and
          when it is the one that failed the page silently drops the profile
          card, the KYC prompt and the sub-agency section — all three of which
          are keyed off `agency`. Their absence is not evidence of anything. */}
      {failures.agency && (
        <Warning>
          Your agency record could not be read — {failures.agency.reason} Your
          profile, KYC status and sub-agency list are missing from this page as a
          result. Nothing about them has changed.
        </Warning>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <StatCard label="Total Hosts" value={totalHostCount} icon={Users} color="text-blue-400" failure={hostCountUnread} />
        <StatCard label="Total Beans" value={totalBeans.toLocaleString()} icon={Star} color="text-yellow-400" failure={failures.hosts} />
        <StatCard label="Pending Salary Requests" value={pendingSalary} icon={Clock} color="text-orange-400" failure={failures.salary} />
      </div>

      {/* Hosts table */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mb-8">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-white font-semibold flex items-center gap-2">
            <Users size={18} className="text-slate-400" />
            Hosts {hostCountUnread ? '' : `(${totalHostCount})`}
            {shownPending.length > 0 && (
              <span className="text-xs font-bold bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 rounded-full px-2 py-0.5">
                {shownPending.length} pending
              </span>
            )}
            {shownApproved.length > 0 && (
              <span className="text-xs font-bold bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-full px-2 py-0.5">
                {shownApproved.length} awaiting activation
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            {agency?.type !== 'sub' && (
              <button
                onClick={() => setShowAddSubAgency(true)}
                className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white font-medium rounded-lg px-3 py-2 text-sm border border-slate-600 transition-colors"
              >
                <Building2 size={15} />
                Add Sub-Agency
              </button>
            )}
            <button
              onClick={() => setShowAddHost(true)}
              className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-medium rounded-lg px-3 py-2 text-sm transition-colors"
            >
              <UserPlus size={15} />
              Add Host
            </button>
          </div>
        </div>

        {(() => {
          // "No hosts yet. Add a host to get started." is an assertion about
          // the agency's own roster, and it was what a permission-denied query
          // rendered as. Only say it when both reads behind the table answered.
          if (hostCountUnread) {
            return (
              <UnavailablePanel
                failure={hostCountUnread}
                what="Your hosts"
                onRetry={() => { setLoading(true); loadData() }}
              />
            )
          }
          if (totalHostCount === 0) {
            return <div className="text-center py-12 text-slate-500">No hosts yet. Add a host to get started.</div>
          }
          return (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-800 text-left">
                    <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Host</th>
                    <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Phone</th>
                    <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Level</th>
                    <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Beans</th>
                    <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Call Rate</th>
                    <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Pending approval — from hostApplications. GOV B08: only
                      the ones that are not already one of your hosts. */}
                  {shownPending.map(({ app, sameContactAs }) => (
                    <tr key={`app-pending-${app.id}`} className="border-b border-slate-800/50 bg-yellow-500/3">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-yellow-500/20 flex items-center justify-center flex-shrink-0">
                            {hostPhotos.url('host', app.id)
                              // eslint-disable-next-line @next/next/no-img-element
                              ? <img src={hostPhotos.url('host', app.id)} alt={app.hostName} className="w-8 h-8 rounded-full object-cover" />
                              : <span className="text-yellow-300 text-xs font-bold">{app.hostName?.[0]?.toUpperCase() ?? '?'}</span>
                            }
                          </div>
                          <div>
                            <p className="text-white text-sm font-medium">{app.hostName}</p>
                            <p className="text-slate-500 text-xs">{app.applicantEmail}</p>
                            {sameContactAs && (
                              <p className="text-amber-300 text-xs mt-0.5">
                                Same phone or email as your host {sameContactAs.name || sameContactAs.uid} — not counted again
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-slate-300 text-sm">{app.applicantPhone ?? '—'}</td>
                      <td className="px-6 py-4 text-slate-500 text-sm">—</td>
                      <td className="px-6 py-4 text-slate-500 text-sm">—</td>
                      <td className="px-6 py-4 text-slate-400 text-sm">{app.callRate ? `${app.callRate} b/min` : '—'}</td>
                      <td className="px-6 py-4">
                        <span className="text-xs bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 px-2 py-1 rounded font-medium flex items-center gap-1 w-fit">
                          <Clock size={10} />Pending Approval
                        </span>
                        {/* FX-12: withdraw a pending invitation that is wrong.
                            RC: only an invitation this agency filed — a
                            self-filed application is the applicant's, and
                            staff decide it (the rules refuse the delete). */}
                        {isWithdrawableInvitation(app as unknown as Record<string, unknown>) && (
                        <button
                          type="button"
                          onClick={() => withdrawInvitation(app)}
                          disabled={withdrawingId === app.id}
                          className="mt-2 text-xs text-slate-400 hover:text-red-300 underline disabled:opacity-50"
                        >
                          {withdrawingId === app.id ? 'Withdrawing…' : 'Withdraw'}
                        </button>
                        )}
                        {withdrawFailure?.id === app.id && (
                          <p className="text-red-300 text-xs mt-1">{withdrawFailure.message}</p>
                        )}
                      </td>
                    </tr>
                  ))}

                  {/* Rejected by KYC review. Shown with the reason: an agency
                      that cannot see why a host was turned down re-submits the
                      same application, which is how the duplicates pile up. */}
                  {rejectedHostApps.map(app => (
                    <tr key={`app-rejected-${app.id}`} className="border-b border-slate-800/50 bg-red-500/3">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0">
                            {hostPhotos.url('host', app.id)
                              // eslint-disable-next-line @next/next/no-img-element
                              ? <img src={hostPhotos.url('host', app.id)} alt={app.hostName} className="w-8 h-8 rounded-full object-cover opacity-60" />
                              : <span className="text-red-300 text-xs font-bold">{app.hostName?.[0]?.toUpperCase() ?? '?'}</span>
                            }
                          </div>
                          <div>
                            <p className="text-slate-300 text-sm font-medium">{app.hostName}</p>
                            <p className="text-slate-500 text-xs">{app.applicantEmail}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-slate-400 text-sm">{app.applicantPhone ?? '—'}</td>
                      <td className="px-6 py-4 text-slate-500 text-sm">—</td>
                      <td className="px-6 py-4 text-slate-500 text-sm">—</td>
                      <td className="px-6 py-4 text-slate-500 text-sm">{app.callRate ? `${app.callRate} b/min` : '—'}</td>
                      <td className="px-6 py-4">
                        <span className="text-xs bg-red-500/20 text-red-400 border border-red-500/30 px-2 py-1 rounded font-medium flex items-center gap-1 w-fit">
                          <X size={10} />Rejected
                        </span>
                        {app.rejectionReason ? (
                          <p className="text-slate-500 text-xs mt-1 max-w-[220px]">{app.rejectionReason}</p>
                        ) : null}
                      </td>
                    </tr>
                  ))}

                  {/* Approved, awaiting host activation. GOV B08: an approved
                      self-application of one of your hosts is that host, so it
                      is on their row, not here. */}
                  {shownApproved.map(({ app, sameContactAs }) => (
                    <tr key={`app-approved-${app.id}`} className="border-b border-slate-800/50 bg-blue-500/3">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                            {hostPhotos.url('host', app.id)
                              // eslint-disable-next-line @next/next/no-img-element
                              ? <img src={hostPhotos.url('host', app.id)} alt={app.hostName} className="w-8 h-8 rounded-full object-cover" />
                              : <span className="text-blue-300 text-xs font-bold">{app.hostName?.[0]?.toUpperCase() ?? '?'}</span>
                            }
                          </div>
                          <div>
                            <p className="text-white text-sm font-medium">{app.hostName}</p>
                            <p className="text-slate-500 text-xs">{app.applicantEmail}</p>
                            {sameContactAs && (
                              <p className="text-amber-300 text-xs mt-0.5">
                                Same phone or email as your host {sameContactAs.name || sameContactAs.uid} — not counted again
                              </p>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-slate-300 text-sm">{app.applicantPhone ?? '—'}</td>
                      <td className="px-6 py-4 text-slate-500 text-sm">—</td>
                      <td className="px-6 py-4 text-slate-500 text-sm">—</td>
                      <td className="px-6 py-4 text-slate-400 text-sm">{app.callRate ? `${app.callRate} b/min` : '—'}</td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col gap-1">
                          <span className="text-xs bg-blue-500/20 text-blue-300 border border-blue-500/30 px-2 py-1 rounded font-medium w-fit">
                            Awaiting Activation
                          </span>
                          <span className="text-xs text-purple-300 font-mono font-semibold">{app.referralCode}</span>
                        </div>
                      </td>
                    </tr>
                  ))}

                  {/* Hosts who have redeemed their code, from the users
                      collection. The name opens an inline panel rather than
                      /users/{uid}: that page admits staff roles only, so an
                      agency clicking its own host was sent to a permission
                      refusal. Everything an agency legitimately needs about its
                      host is on this row and in the panel below it. */}
                  {hosts.map((host) => (
                    <Fragment key={host.uid}>
                    <tr
                      className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors cursor-pointer"
                      onClick={() => setOpenHost((u) => (u === host.uid ? '' : host.uid))}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                            {profilePhotoSrc(host.photoUrl) ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={profilePhotoSrc(host.photoUrl)} alt={host.name} className="w-8 h-8 rounded-full object-cover" />
                            ) : (
                              <span className="text-blue-300 text-xs font-bold">{host.name?.[0]?.toUpperCase() ?? '?'}</span>
                            )}
                          </div>
                          <span className="text-white text-sm font-medium">{host.name}</span>
                          <ChevronRight
                            size={14}
                            className={`text-slate-500 transition-transform ${openHost === host.uid ? 'rotate-90' : ''}`}
                          />
                        </div>
                      </td>
                      <td className="px-6 py-4 text-slate-300 text-sm">{host.phoneNumber || '—'}</td>
                      <td className="px-6 py-4 text-slate-300 text-sm">
                        {/* `?? 0`, not a truthiness test: a host at level 0 has a
                            level, and showing them an em dash reads as missing
                            data rather than as "you have not levelled up yet". */}
                        Lv {host.hostLevel ?? 0}
                      </td>
                      <td className="px-6 py-4 text-yellow-400 text-sm font-medium">
                        {(host.beans ?? 0).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 text-slate-400 text-sm">
                        {host.callRateBeans ? `${host.callRateBeans} b/min` : '—'}
                      </td>
                      <td className="px-6 py-4">
                        {host.isBanned ? (
                          <span className="text-xs text-red-400 bg-red-500/10 px-2 py-1 rounded font-medium">Banned</span>
                        ) : host.isVerifiedHost ? (
                          <span className="text-xs text-green-400 bg-green-500/10 px-2 py-1 rounded font-medium">Verified</span>
                        ) : (
                          <span className="text-xs text-yellow-400 bg-yellow-500/10 px-2 py-1 rounded font-medium">
                            Needs face capture
                          </span>
                        )}
                      </td>
                    </tr>

                    {openHost === host.uid && (
                      <tr className="border-b border-slate-800/50 bg-slate-950/40">
                        <td colSpan={6} className="px-6 py-4">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-3">
                            <HostFact label="Call rate" value={host.callRateBeans ? `${host.callRateBeans} beans/min` : 'Not set'} />
                            <HostFact label="Host level" value={`Level ${host.hostLevel ?? 0}`} />
                            <HostFact label="Beans earned" value={(host.beans ?? 0).toLocaleString()} />
                            <HostFact label="Host since" value={whenOfTs(host.hostActivatedAt)} />
                          </div>

                          {/* The invitation this agency filed for this host —
                              contact details, where they are paid, and the
                              three documents the agency uploaded itself. */}
                          <HostApplicationPanel
                            app={reconciledHosts.panelApp.get(host.uid)}
                            applicationsUnread={!!failures.applications}
                          />
                          {!host.isVerifiedHost && !host.isBanned && (
                            <p className="flex items-start gap-2 bg-yellow-500/5 border border-yellow-500/30 rounded-lg px-3 py-2 text-yellow-200 text-xs">
                              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                              <span>
                                This host has not completed their face capture. Until
                                they do they cannot go live, they earn at the platform
                                base rate rather than the {host.callRateBeans ?? '—'} b/min
                                you agreed, and their weekly payout is held. It is one
                                minute in the app: <span className="font-medium">Me → Verify your face</span>.
                              </span>
                            </p>
                          )}
                          <p className="text-slate-600 text-xs mt-2 font-mono">{host.uid}</p>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )
        })()}
      </div>


      {/* Sub-Agencies section — visible only for main agencies */}
      {agency?.type !== 'sub' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden mb-8">
          <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <Building2 size={18} className="text-slate-400" />
              Sub-Agencies {failures.subAgencies ? '' : `(${subAgencies.length})`}
            </h2>
            <button
              onClick={() => setShowAddSubAgency(true)}
              className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white font-medium rounded-lg px-3 py-2 text-sm border border-slate-600 transition-colors"
            >
              <Plus size={15} />
              Add Sub-Agency
            </button>
          </div>
          {failures.subAgencies ? (
            <UnavailablePanel
              failure={failures.subAgencies}
              what="Your sub-agencies"
              onRetry={() => { setLoading(true); loadData() }}
            />
          ) : subAgencies.length === 0 ? (
            <div className="text-center py-10 text-slate-500 text-sm">No sub-agencies yet. Add one to expand your network.</div>
          ) : (
            <div className="divide-y divide-slate-800">
              {subAgencies.map(sub => (
                <div key={sub.id} className="px-6 py-4 flex items-center justify-between">
                  <div>
                    <p className="text-white font-medium">{sub.agencyName}</p>
                    <p className="text-slate-400 text-xs mt-0.5">{sub.ownerName} · {sub.ownerEmail}</p>
                  </div>
                  <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${
                    sub.status === 'approved' ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                    : sub.status === 'rejected' ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                    : 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30'
                  }`}>
                    {sub.status === 'approved' ? <CheckCircle2 size={11} /> : <Clock size={11} />}
                    {sub.status.charAt(0).toUpperCase() + sub.status.slice(1)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Salary section */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-white font-semibold flex items-center gap-2">
            <Banknote size={18} className="text-slate-400" />
            Salary Requests
          </h2>
          <button
            onClick={() => setShowSalaryForm(true)}
            disabled={hosts.length === 0}
            // The form needs a host to pick, so it stays disabled either way —
            // but "you have no hosts" and "we could not read your hosts" are
            // two different reasons for the same greyed-out button, and the
            // second one used to be indistinguishable from the first.
            title={
              hosts.length > 0
                ? undefined
                : failures.hosts
                  ? `Your hosts could not be read, so there is nobody to select. ${failures.hosts.reason}`
                  : 'You have no active hosts to request salary for.'
            }
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-slate-700 disabled:cursor-not-allowed text-white font-medium rounded-lg px-3 py-2 text-sm transition-colors"
          >
            <Plus size={15} />
            Request Salary
          </button>
        </div>

        {failures.salary ? (
          <UnavailablePanel
            failure={failures.salary}
            what="Your salary requests"
            onRetry={() => { setLoading(true); loadData() }}
          />
        ) : salaryRequests.length === 0 ? (
          <div className="text-center py-12 text-slate-500">No salary requests yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800 text-left">
                  <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Host</th>
                  <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Period</th>
                  <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Beans</th>
                  <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Amount (INR)</th>
                  <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Notes</th>
                  <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Status</th>
                  <th className="px-6 py-3 text-slate-400 text-xs font-medium uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody>
                {salaryRequests
                  .slice()
                  // These two zeros are sort keys and reach no screen: a row
                  // with no usable `createdAt` sorts to the bottom and is then
                  // rendered from its own fields. Nothing is being claimed
                  // about a row by giving it an epoch of 0.
                  .sort((a, b) => {
                    const aT = a.createdAt ? (a.createdAt as { toMillis?: () => number }).toMillis?.() ?? 0 : 0
                    const bT = b.createdAt ? (b.createdAt as { toMillis?: () => number }).toMillis?.() ?? 0 : 0
                    return bT - aT
                  })
                  .map((req) => (
                    <tr key={req.id} className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                      <td className="px-6 py-4 text-white text-sm font-medium">{req.hostName}</td>
                      <td className="px-6 py-4 text-slate-300 text-sm">
                        {req.periodStart} → {req.periodEnd}
                      </td>
                      <td className="px-6 py-4 text-yellow-400 text-sm">{req.beansEarned.toLocaleString()}</td>
                      <td className="px-6 py-4 text-green-400 text-sm font-medium">₹{req.amountInr.toLocaleString()}</td>
                      <td className="px-6 py-4 text-slate-400 text-sm max-w-[160px] truncate">
                        {req.notes || '—'}
                      </td>
                      <td className="px-6 py-4">
                        <SalaryStatusBadge status={req.status} />
                      </td>
                      <td className="px-6 py-4">
                        {req.status === 'paid' && (
                          <button
                            onClick={() => handleMarkDistributed(req)}
                            disabled={markingId === req.id}
                            className="text-xs bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border border-purple-500/30 rounded px-2.5 py-1.5 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                          >
                            {markingId === req.id ? (
                              <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <CheckCircle2 size={12} />
                            )}
                            Mark Distributed
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add Sub-Agency modal */}
      {showAddSubAgency && agencyId && agency && (
        <AddSubAgencyModal
          parentAgencyId={agencyId}
          parentAgencyName={agency.agencyName}
          onClose={() => setShowAddSubAgency(false)}
          onCreated={loadData}
        />
      )}

      {/* Add host modal */}
      {showAddHost && agencyId && (
        <AddHostModal
          agencyId={agencyId}
          agencyName={agency?.agencyName ?? ''}
          referralCode={agency?.referralCode ?? ''}
          onClose={() => setShowAddHost(false)}
          onSuccess={loadData}
        />
      )}

      {/* Salary request form modal */}
      {showSalaryForm && agencyId && (
        <SalaryRequestForm
          hosts={hosts}
          agencyId={agencyId}
          onClose={() => setShowSalaryForm(false)}
          onSuccess={loadData}
        />
      )}
    </div>
  )
}
