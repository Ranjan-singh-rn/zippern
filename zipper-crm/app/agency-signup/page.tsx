'use client'

/**
 * Public agency application.
 *
 * ── Why the login is created first ───────────────────────────────────────────
 *
 * This page used to `addDoc` the agency and THEN create the Firebase Auth
 * account, so a retry against an address that already had a login died on
 * `auth/email-already-in-use` *after* the record was committed and left an
 * orphan behind. The seller forms had the identical bug and produced three
 * orphan records in production for one address.
 *
 * The caller here is unauthenticated, and **an unauthenticated caller can read
 * neither collection**: every read clause on `/agencies` requires
 * `request.auth != null` (`isAdmin()`, `isAgencyCrmUser() && …`,
 * `ownerUid == request.auth.uid`, `ownerEmail == request.auth.token.email`), and
 * the rules file ends in `match /{document=**} { allow read, write: if false }`.
 * A duplicate query bolted on before signup would be permission-denied every
 * time — a check that never fires. So:
 *
 *   1. create the **login** first. `createUserWithEmailAndPassword` is an
 *      authoritative, server-side uniqueness test on the address and writes
 *      nothing to Firestore when it refuses. That alone stops the bug.
 *   2. now signed in, run the duplicate query — matched on `ownerEmail ==` this
 *      caller's own verified address, which is exactly the shape the fourth read
 *      clause is written for. It catches what the auth account cannot: an agency
 *      record that exists with no login at all. If it finds one, the application
 *      is refused and the login created a moment ago is deleted again, because
 *      it holds nothing and leaving it would lock the address permanently.
 *   3. write the agency document.
 *   4. write the `crmUsers` document — which `firestore.rules` binds to an
 *      agency record that already names this caller's verified email, so it
 *      cannot come earlier — and link `crmUid` back.
 *
 * A failure at step 4 leaves an agency record with no `crmUid`. This page cannot
 * clean that up — `agencies` delete is `isSuperAdmin()` — so it says so, and
 * `/agencies` badges the record "no login attached" for staff.
 *
 * ── "Continue with Google" changes step 1 and nothing else ───────────────────
 *
 * The applicant may create that same first login from a Google popup instead of
 * a password. `partnerSignUpWithGoogle` stands exactly where `createPartnerLogin`
 * stands: it proves the address, hands back one uid, and writes nothing. Steps
 * 2, 3 and 4 then run unchanged against that uid — ONE canonical account either
 * way, and the agency record is filed against the uid Firebase returned, never
 * against a uid found by looking up an address.
 *
 * It happens on step 1 rather than at submit so the address the record is filed
 * under is the one Google verified. `firestore.rules` binds both the `crmUsers`
 * create and the `crmUid` back-link to `ownerEmail == request.auth.token.email`,
 * so a typed address that differs from the Google one — by a letter, or
 * entirely — would pass every check on this page and be denied at step 4.
 */

import { useState, useRef } from 'react'
import { auth, db, storage } from '@/lib/firebase'
import { addDoc, collection, serverTimestamp, updateDoc, doc } from 'firebase/firestore'
import {
  createAgencyAccount, createPartnerLogin, discardPartnerLogin, ensurePartnerEmailVerified,
  generateCrmId, partnerSignUpWithGoogle,
} from '@/lib/auth'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { kycFileProblem, kycUploadErrorText } from '@/lib/kycUpload'
import { signupDocName } from '@/lib/signupDocName'
import {
  Upload,
  CheckCircle,
  ArrowRight,
  ArrowLeft,
  Building2,
  FileText,
  CreditCard,
  User,
  Phone,
  Mail,
  MapPin,
  Hash,
  Landmark,
  Wallet,
  Shield,
  Globe,
  AlertTriangle,
  XCircle,
} from 'lucide-react'
import {
  findPartnersByEmail, normaliseEmail, statusPhrase,
  type ExistingPartner,
} from '@/lib/partnerDuplicates'
import PhoneInput from '@/components/PhoneInput'
import { useRegisteredCheck } from '@/lib/useRegisteredCheck'
import { SUPPORT_EMAIL, mailtoHref } from '@/lib/contacts'  // QA #47: the official support address

/** Whether the login was finished, kept separate from "the form was filed". */
type LoginOutcome =
  | { kind: 'attached' }
  | { kind: 'failed'; message: string }

/** The firebase-js-sdk error code, when there is one. */
function errorCode(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err
    ? String((err as { code: unknown }).code)
    : ''
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function AgencySignupPage() {
  const [step, setStep]           = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [agencyId, setAgencyId]   = useState('')
  const [error, setError]         = useState('')
  const [login, setLogin]         = useState<LoginOutcome | null>(null)
  // An agency record already filed under this address. Non-null means the form
  // refused; the applicant is told what exists, but not linked to it — they have
  // no permission to open a CRM record.
  const [duplicates, setDuplicates] = useState<ExistingPartner[] | null>(null)
  // Set when the duplicate query itself could not be run. The application still
  // goes through — the login uniqueness check above is the authoritative one —
  // but this is shown rather than swallowed.
  const [checkWarning, setCheckWarning] = useState('')

  // ── Signing up with Google ─────────────────────────────────────────────────
  // Non-empty means the applicant took the Google door and the popup already
  // created their canonical account. `googleUid` IS the uid this application is
  // filed against — it is read straight from the popup result and never from an
  // address — there is no password anywhere in the flow, and `form.ownerEmail`
  // below was set by Google rather than typed, which is why it is read-only
  // from that point on.
  const [googleUid, setGoogleUid]     = useState('')
  const [googleBusy, setGoogleBusy]   = useState(false)
  const [googleError, setGoogleError] = useState('')

  const [form, setForm] = useState({
    agencyName:           '',
    ownerName:            '',
    ownerPhone:           '',
    ownerEmail:           '',
    address:              '',
    paymentType:          'india' as 'india' | 'foreign',
    country:              '',
    binanceUid:           '',
    accountName:          '',
    accountNumber:        '',
    confirmAccountNumber: '',
    ifsc:                 '',
    bankName:             '',
    branch:               '',
    upiId:                '',
    password:             '',
    confirmPassword:      '',
  })

  const [aadhaarUrl,      setAadhaarUrl]      = useState('')
  const [panUrl,          setPanUrl]          = useState('')
  const [passbookUrl,     setPassbookUrl]     = useState('')
  const [aadhaarProgress, setAadhaarProgress] = useState(0)
  const [panProgress,     setPanProgress]     = useState(0)
  const [passbookProgress,setPassbookProgress]= useState(0)
  const [aadhaarFile,     setAadhaarFile]     = useState<File | null>(null)
  const [panFile,         setPanFile]         = useState<File | null>(null)
  const [passbookFile,    setPassbookFile]    = useState<File | null>(null)

  const aadhaarRef  = useRef<HTMLInputElement>(null)
  const panRef      = useRef<HTMLInputElement>(null)
  const passbookRef = useRef<HTMLInputElement>(null)

  const set = (field: string, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }))

  async function handleGoogle() {
    setError('')
    setGoogleError('')
    setGoogleBusy(true)
    try {
      const outcome = await partnerSignUpWithGoogle()
      if (outcome.kind === 'ready') {
        setGoogleUid(outcome.uid)
        // The address Google verified, not the one in the box — see the note at
        // the top of this file about `request.auth.token.email`.
        set('ownerEmail', outcome.email)
      } else if (outcome.kind === 'account-exists') {
        // Said, not silently worked around. Taking the account over because the
        // address matches is the one thing this must never do.
        setGoogleError(
          `${outcome.email} already has a Zipper account, so nothing was created. `
          + 'Sign in at /login with that address instead. If you already run an '
          + 'agency or sell coins with us, apply for the second business from '
          + 'your dashboard — this form is only for a brand-new application.',
        )
      } else if (outcome.message) {
        setGoogleError(outcome.message)
      }
      // A blank refusal message is a closed popup. Say nothing.
    } catch {
      setGoogleError('Google sign-in failed. Try again.')
    } finally {
      setGoogleBusy(false)
    }
  }

  /** Back out of Google before anything has been filed, and set a password. */
  async function handleDropGoogle() {
    setGoogleError('')
    setGoogleBusy(true)
    try {
      await discardPartnerLogin(googleUid)
      setGoogleUid('')
      set('ownerEmail', '')
    } catch (err: unknown) {
      // Left as it was on purpose. Clearing `googleUid` here would offer the
      // password route while a live Firebase account still holds this address,
      // and that route would then refuse it as already in use.
      setGoogleError(
        `That Google login could not be removed again: ${errorMessage(err)}. `
        + 'Reload this page and start over.',
      )
    } finally {
      setGoogleBusy(false)
    }
  }

  function handleFileUpload(
    file: File,
    path: string,
    setProgress: (n: number) => void,
    setUrl: (s: string) => void,
    setFile: (f: File) => void,
  ) {
    // QA #29 / #32: clear the last attempt's error; refuse what the Storage
    // rules would refuse, saying why.
    setError('')
    const problem = kycFileProblem(file)
    if (problem) { setError(problem); return }
    setFile(file)
    setProgress(0)
    const storageRef  = ref(storage, path)
    const uploadTask  = uploadBytesResumable(storageRef, file)
    uploadTask.on(
      'state_changed',
      (snap) => setProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
      (err)  => {
        console.error('Upload error:', err)
        setProgress(0)
        setFile(null as unknown as File)
        setError(kycUploadErrorText(err))
      },
      async () => {
        try {
          const url = await getDownloadURL(uploadTask.snapshot.ref)
          setUrl(url)
          setError('')
        } catch (err) {
          console.error('getDownloadURL error:', err)
          setProgress(0)
          setFile(null as unknown as File)
          setError('Could not get file URL after upload. Please try again.')
        }
      },
    )
  }

  // ── Shared styles ──────────────────────────────────────────────────────────
  const inputClass =
    'bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white w-full ' +
    'focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 ' +
    'placeholder:text-slate-500 transition-colors'
  const labelClass = 'block text-sm font-medium text-slate-300 mb-1.5'

  // ── Step indicator ─────────────────────────────────────────────────────────
  const steps = [
    { num: 1, label: 'Basic Info',  icon: Building2  },
    { num: 2, label: 'KYC Docs',   icon: FileText    },
    { num: 3, label: 'Payment',    icon: CreditCard  },
    { num: 4, label: 'Done',       icon: CheckCircle },
  ]

  // ── Upload area component ──────────────────────────────────────────────────
  function UploadArea({
    label, description, file, url, progress, inputRef, onFileChange, icon: Icon,
  }: {
    label: string; description: string; file: File | null; url: string
    progress: number; inputRef: React.RefObject<HTMLInputElement>
    onFileChange: (f: File) => void; icon: React.ElementType
  }) {
    const uploading = file && !url && progress > 0
    const done      = !!url

    return (
      <div
        onClick={() => !done && inputRef.current?.click()}
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
          done      ? 'border-green-500 bg-green-500/5' :
          uploading ? 'border-pink-500/50 bg-pink-500/5' :
                      'border-slate-600 hover:border-pink-500'
        }`}
      >
        <input
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          ref={inputRef}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFileChange(f) }}
        />

        {done ? (
          <div className="space-y-3">
            {file?.type.startsWith('image/') ? (
              <img src={url} alt={label} className="max-h-24 mx-auto rounded object-cover" />
            ) : (
              <div className="flex items-center justify-center gap-2 text-slate-300">
                <FileText className="w-8 h-8 text-slate-400" />
                <span className="text-sm truncate max-w-[150px]">{file?.name}</span>
              </div>
            )}
            <div className="flex items-center justify-center gap-1.5 text-green-400 text-sm font-medium">
              <CheckCircle className="w-4 h-4" /> Uploaded successfully
            </div>
          </div>
        ) : uploading ? (
          <div className="space-y-3">
            <Icon className="w-8 h-8 text-pink-400 mx-auto" />
            <p className="text-sm text-slate-300 font-medium">Uploading…</p>
            <div className="w-full bg-slate-700 rounded-full h-2">
              <div className="bg-pink-500 h-2 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
            </div>
            <p className="text-xs text-pink-400">{progress}%</p>
          </div>
        ) : (
          <div className="space-y-3">
            <Icon className="w-8 h-8 text-slate-500 mx-auto" />
            <div>
              <p className="text-sm font-medium text-slate-300">Click to upload</p>
              <p className="text-xs text-slate-500 mt-1">{description}</p>
            </div>
            <Upload className="w-4 h-4 text-slate-500 mx-auto" />
          </div>
        )}
        <p className="text-xs font-semibold text-slate-400 mt-3 uppercase tracking-wider">{label}</p>
      </div>
    )
  }

  // Flags an already-registered email / phone while it is being typed.
  const registered = useRegisteredCheck(form.ownerEmail, form.ownerPhone)

  // ── Step 1: Basic Info ─────────────────────────────────────────────────────
  function Step1() {
    function next() {
      setError('')
      if (!form.agencyName.trim() || !form.ownerName.trim() ||
          !form.ownerPhone.trim() || !form.ownerEmail.trim() || !form.address.trim()) {
        setError('Please fill in all required fields.')
        return
      }
      if (!/^\S+@\S+\.\S+$/.test(form.ownerEmail)) {
        setError('Please enter a valid email address.')
        return
      }
      if (registered.email || registered.phone) {
        setError(registered.email || registered.phone)
        return
      }
      // A Google signup has no password to check, now or ever — the login it
      // already created is the account.
      if (!googleUid) {
        if (!form.password || form.password.length < 8) { setError('Password must be at least 8 characters.'); return }
        if (form.password !== form.confirmPassword) { setError('Passwords do not match.'); return }
      }
      setStep(2)
    }

    return (
      <div>
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-white mb-1">Agency Information</h2>
          <p className="text-slate-400 text-sm">Tell us about your agency.</p>
        </div>

        <div className="space-y-5">
          <div>
            <label className={labelClass}><span className="flex items-center gap-1.5"><Building2 className="w-4 h-4 text-pink-400" />Agency Name *</span></label>
            <input type="text" className={inputClass} placeholder="e.g. Star Entertainment Agency"
              value={form.agencyName} onChange={(e) => set('agencyName', e.target.value)} />
          </div>

          <div>
            <label className={labelClass}><span className="flex items-center gap-1.5"><User className="w-4 h-4 text-pink-400" />Owner Full Name *</span></label>
            <input type="text" className={inputClass} placeholder="Your full legal name"
              value={form.ownerName} onChange={(e) => set('ownerName', e.target.value)} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className={labelClass}><span className="flex items-center gap-1.5"><Phone className="w-4 h-4 text-pink-400" />Phone Number *</span></label>
              <PhoneInput className={inputClass} placeholder="Mobile number"
                value={form.ownerPhone} onChange={(v) => set('ownerPhone', v)} />
              {registered.phone && <p className="text-xs text-red-400 mt-1">{registered.phone}</p>}
            </div>
            <div>
              <label className={labelClass}><span className="flex items-center gap-1.5"><Mail className="w-4 h-4 text-pink-400" />Email Address *</span></label>
              <input type="email"
                className={inputClass + (googleUid ? ' opacity-60 cursor-not-allowed' : '')}
                placeholder="your@email.com"
                readOnly={!!googleUid}
                value={form.ownerEmail} onChange={(e) => set('ownerEmail', e.target.value)} />
              {registered.email && <p className="text-xs text-red-400 mt-1">{registered.email}</p>}
              {googleUid && (
                <p className="text-xs text-slate-500 mt-1">
                  Verified by Google. Your application is filed against this address.
                </p>
              )}
            </div>
          </div>

          <div>
            <label className={labelClass}><span className="flex items-center gap-1.5"><MapPin className="w-4 h-4 text-pink-400" />Agency Address *</span></label>
            <textarea rows={3} className={inputClass + ' resize-none'} placeholder="Full agency address including city, state, pincode"
              value={form.address} onChange={(e) => set('address', e.target.value)} />
          </div>

          <div>
            <label className={labelClass}><span className="flex items-center gap-1.5"><Globe className="w-4 h-4 text-pink-400" />Region *</span></label>
            <div className="grid grid-cols-2 gap-3">
              <button type="button"
                onClick={() => set('paymentType', 'india')}
                className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 font-semibold transition-colors text-sm ${
                  form.paymentType === 'india'
                    ? 'border-pink-500 bg-pink-500/10 text-pink-300'
                    : 'border-slate-600 bg-slate-800 text-slate-400 hover:border-slate-500'
                }`}>
                🇮🇳 India
              </button>
              <button type="button"
                onClick={() => set('paymentType', 'foreign')}
                className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 font-semibold transition-colors text-sm ${
                  form.paymentType === 'foreign'
                    ? 'border-pink-500 bg-pink-500/10 text-pink-300'
                    : 'border-slate-600 bg-slate-800 text-slate-400 hover:border-slate-500'
                }`}>
                🌍 International
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-1.5">
              {form.paymentType === 'india'
                ? 'Indian agencies receive payouts via bank transfer (₹1000 per 1 lakh beans).'
                : 'International agencies receive payouts via Binance ($10 per 1 lakh beans).'}
            </p>
          </div>

          {/*
            How this agency will sign in. Two doors, ONE account behind either
            of them — the login is created here in both cases and everything
            after this screen is identical. A Google signup simply has no
            password: there is nothing to forget, nothing to reset, and no
            second account anywhere.
          */}
          <div className="border-t border-slate-700 pt-5">
            {googleUid ? (
              <div className="flex items-start gap-3 bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-3">
                <CheckCircle className="w-4 h-4 text-green-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-green-300 text-sm font-medium">Google account connected</p>
                  <p className="text-slate-400 text-xs mt-1">
                    You will sign in with{' '}
                    <span className="text-white">{form.ownerEmail}</span> — no password needed.
                  </p>
                  <button type="button" onClick={handleDropGoogle} disabled={googleBusy}
                    className="text-xs text-slate-400 hover:text-pink-300 transition-colors mt-2 disabled:opacity-50">
                    Use an email and password instead
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-slate-400 text-xs uppercase tracking-wider font-semibold mb-4">Set Your Login Password</p>
                <div className="space-y-5">
                  <div>
                    <label className={labelClass}><span className="flex items-center gap-1.5"><Shield className="w-4 h-4 text-pink-400" />Password *</span></label>
                    <input type="password" className={inputClass} placeholder="Min 8 characters"
                      value={form.password} onChange={(e) => set('password', e.target.value)} />
                  </div>
                  <div>
                    <label className={labelClass}><span className="flex items-center gap-1.5"><Shield className="w-4 h-4 text-pink-400" />Confirm Password *</span></label>
                    <input type="password" className={inputClass} placeholder="Repeat password"
                      value={form.confirmPassword} onChange={(e) => set('confirmPassword', e.target.value)} />
                  </div>
                </div>

                <div className="flex items-center gap-3 my-5">
                  <div className="flex-1 h-px bg-slate-800" />
                  <span className="text-slate-600 text-xs uppercase tracking-wide">or</span>
                  <div className="flex-1 h-px bg-slate-800" />
                </div>

                <button
                  onClick={handleGoogle}
                  disabled={googleBusy}
                  className="w-full bg-white hover:bg-slate-100 disabled:bg-slate-300 disabled:cursor-not-allowed text-slate-800 font-semibold rounded-lg px-4 py-3 text-sm transition-colors flex items-center justify-center gap-2.5"
                >
                  {googleBusy ? (
                    <>
                      <span className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
                      Opening Google…
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" viewBox="0 0 48 48" aria-hidden="true">
                        <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z" />
                        <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.6-3.9-12.3-9.1H4.3v5.7C7.9 41 15.4 46 24 46z" />
                        <path fill="#FBBC05" d="M11.7 28.1c-.4-1.3-.7-2.7-.7-4.1s.3-2.8.7-4.1v-5.7H4.3A22 22 0 0 0 2 24c0 3.6.9 7 2.3 9.8l7.4-5.7z" />
                        <path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.2 29.9 2 24 2 15.4 2 7.9 7 4.3 14.2l7.4 5.7c1.7-5.2 6.6-9.1 12.3-9.1z" />
                      </svg>
                      Continue with Google
                    </>
                  )}
                </button>
                <p className="text-slate-500 text-xs mt-2">
                  Google fills in your email address and becomes how you sign in.
                </p>
              </>
            )}

            {googleError && (
              <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
                {googleError}
              </div>
            )}
          </div>
        </div>

        {error && <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">{error}</div>}

        <div className="mt-8 flex justify-end">
          <button onClick={next} className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors">
            Next: KYC Documents <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    )
  }

  // ── Step 2: KYC Documents ─────────────────────────────────────────────────
  function Step2() {
    function next() {
      setError('')
      if (!aadhaarUrl || !panUrl || !passbookUrl) {
        setError('Please upload all three documents before continuing.')
        return
      }
      setStep(3)
    }

    return (
      <div>
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-white mb-1">KYC Documents</h2>
          <p className="text-slate-400 text-sm">Upload your identification and bank documents for verification.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <UploadArea
            label={form.paymentType === 'foreign' ? 'Passport' : 'Aadhaar Card'}
            description={form.paymentType === 'foreign' ? 'Valid passport photo page (JPG, PNG or PDF)' : 'Front side (JPG, PNG or PDF)'}
            file={aadhaarFile} url={aadhaarUrl} progress={aadhaarProgress}
            inputRef={aadhaarRef} icon={FileText}
            onFileChange={(f) => handleFileUpload(f, `kyc/agencies/signup/${signupDocName('doc1')}`, setAadhaarProgress, setAadhaarUrl, setAadhaarFile)} />

          <UploadArea
            label={form.paymentType === 'foreign' ? 'Government / National ID' : 'PAN Card'}
            description={form.paymentType === 'foreign' ? 'National ID, driver\'s license or equivalent (JPG, PNG or PDF)' : 'Clear photo (JPG, PNG or PDF)'}
            file={panFile} url={panUrl} progress={panProgress}
            inputRef={panRef} icon={CreditCard}
            onFileChange={(f) => handleFileUpload(f, `kyc/agencies/signup/${signupDocName('doc2')}`, setPanProgress, setPanUrl, setPanFile)} />

          <UploadArea
            label={form.paymentType === 'foreign' ? 'Proof of Address' : 'Bank Passbook'}
            description={form.paymentType === 'foreign' ? 'Recent utility bill or bank statement (JPG, PNG or PDF)' : 'First page (JPG, PNG or PDF)'}
            file={passbookFile} url={passbookUrl} progress={passbookProgress}
            inputRef={passbookRef} icon={Landmark}
            onFileChange={(f) => handleFileUpload(f, `kyc/agencies/signup/${signupDocName('doc3')}`, setPassbookProgress, setPassbookUrl, setPassbookFile)} />
        </div>

        <div className="mt-4 bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 flex items-start gap-2">
          <Shield className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-slate-400">All documents are encrypted and stored securely. They will only be reviewed by our verification team.</p>
        </div>

        {error && <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">{error}</div>}

        <div className="mt-8 flex justify-between">
          <button onClick={() => { setError(''); setStep(1) }} className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <button onClick={next} className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors">
            Next: Payment Details <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    )
  }

  // ── Step 3: Payment Details ──────────────────────────────────────────────────
  function Step3() {
    const isForeign = form.paymentType === 'foreign'

    async function submit() {
      setError('')
      setDuplicates(null)
      setCheckWarning('')

      if (isForeign) {
        if (!form.country.trim())    { setError('Please enter your country.'); return }
        if (!form.binanceUid.trim()) { setError('Please enter your Binance UID.'); return }
      } else {
        if (!form.accountName.trim())  { setError('Please enter the account holder name.'); return }
        if (!form.accountNumber.trim()){ setError('Please enter the account number.'); return }
        if (form.accountNumber !== form.confirmAccountNumber) { setError('Account numbers do not match.'); return }
        if (!form.ifsc.trim())         { setError('Please enter the IFSC code.'); return }
        if (!form.bankName.trim())     { setError('Please enter the bank name.'); return }
        if (!form.branch.trim())       { setError('Please enter the branch name.'); return }
      }

      const emailLower = normaliseEmail(form.ownerEmail)
      setSubmitting(true)
      try {
        // ── 1. The login, before anything is written ────────────────────────
        //
        // A login this browser already made in an earlier attempt is reused
        // rather than remade, so a failure further down can simply be retried
        // instead of dead-ending on "email already in use" against the
        // applicant's own half-finished account.
        const resumed = auth.currentUser
        const reusing = !!resumed && normaliseEmail(resumed.email ?? '') === emailLower
        let crmUid: string
        if (googleUid) {
          // Step 1 already created it. `createPartnerLogin` must not run: there
          // is no password to create one from, and asking Firebase for a second
          // account on this address would fail against the applicant's own
          // Google login. The uid comes from the popup, not from `emailLower`.
          crmUid = googleUid
        } else if (reusing && resumed) {
          crmUid = resumed.uid
        } else {
          try {
            crmUid = await createPartnerLogin({
              email:    emailLower,
              password: form.password,
              kind:     'agency',
            })
          } catch (authErr: unknown) {
            setError(
              errorCode(authErr) === 'auth/email-already-in-use'
                ? `An account already exists for ${emailLower}, so nothing was `
                  + 'submitted. If you already run an agency or sell coins with us, '
                  + 'log in and apply for the second business from your dashboard — '
                  + 'this form is only for a brand-new application. If you have '
                  + 'forgotten your password, reset it from the login page.'
                : `Your account could not be created, so nothing was submitted: ${errorMessage(authErr)}`,
            )
            return
          }
        }

        // ── 1b. A CONFIRMED address, before anything is read or written ─────
        //
        // P0-5 (AUTHN-2): every rule that matches this application to its
        // login by email — the duplicate check below, the record, the CRM
        // account and the back-link — now requires Firebase to have seen the
        // address confirmed. A Google login already is; a new password login
        // is not, so the confirmation email goes out and nothing is filed
        // until the applicant has opened it and pressed Submit again (this
        // browser stays signed in, so the retry reuses the same login).
        const verified = await ensurePartnerEmailVerified()
        if (!verified.ok) {
          setError(verified.message)
          return
        }

        // ── 2. Now signed in: has this address already applied? ─────────────
        //
        // A lookup that could NOT be completed is NOT a clean result. This
        // read `if (existing.checked && matches.length > 0)`, so a refused or
        // dropped query fell through to the create — "could not verify" was
        // being treated as "no duplicate". `/agencies/register` has always
        // done the opposite; this is the same guard, failing the same way.
        //
        // The browser is not the enforcement point either way: the API claims
        // the role family in Mongo before any partner record is written (see
        // `backend/app/services/partner_roles.py`). This stops a pointless
        // round trip and gives the applicant a sentence instead of a 409.
        // The login was made purely to run this check and holds nothing, so
        // it goes back — otherwise this address is locked out for good: the
        // next attempt gets `auth/email-already-in-use` and the form refuses
        // it, with no way forward but support.
        //
        // A Google login goes back too, even though `reusing` is true of it:
        // `partnerSignUpWithGoogle` only ever hands back an account this form
        // created, so it is ours to undo. A resumed PASSWORD session is not —
        // it may be an account the applicant already had, and deleting that
        // would be far worse than leaving it.
        //
        // Shared by both ways out below. It was written inline in the
        // duplicate branch, and the fail-closed branch added next to it
        // returned WITHOUT it — so a failed lookup, having created nothing,
        // still burned the applicant's address. One copy cannot do that.
        const undoLoginMadeForTheCheck = async () => {
          if (reusing && googleUid === '') return
          try {
            await discardPartnerLogin(crmUid)
            setGoogleUid('')
          } catch (undoErr: unknown) {
            setCheckWarning(
              `A login was created for ${emailLower} while checking and could not `
              + `be removed again: ${errorMessage(undoErr)}. Write to ${SUPPORT_EMAIL} — `
              + 'nothing else was created.',
            )
          }
        }

        const existing = await findPartnersByEmail('agency', emailLower)
        if (!existing.checked) {
          await undoLoginMadeForTheCheck()
          setError(
            'The check for an existing agency under this address could not be '
            + `run, so nothing was created: ${existing.reason}. Please try `
            + 'again in a moment.',
          )
          return          // `finally` below clears `submitting`
        }
        if (existing.matches.length > 0) {
          await undoLoginMadeForTheCheck()
          setDuplicates(existing.matches)
          return
        }
        // ── 3. The agency record ────────────────────────────────────────────
        //
        // No `crmUid` yet: if step 4 fails, the record shows on /agencies as
        // having no login attached rather than pointing at one that does not
        // work.
        //
        // `ownerUid` IS written now, and it is a different fact from `crmUid`:
        // `crmUid` says "this login can open the CRM portal for this record",
        // `ownerUid` says "this human owns this application". The registration
        // trigger fires on create, so this is the only moment the API can
        // learn who applied — without it the one-agency-per-human rule saw an
        // unowned record and applied nothing, and the approval notice had
        // nobody to address. The create rule binds it to the signed-in uid.
        const docRef = await addDoc(collection(db, 'agencies'), {
          crmId:            generateCrmId(),
          ownerUid:         crmUid,
          agencyName:       form.agencyName,
          ownerName:        form.ownerName,
          ownerPhone:       form.ownerPhone,
          // Lower-cased deliberately. `firestore.rules` binds this agency's own
          // `crmUsers` create (`agencyNamesCaller`) and its `crmUid` back-link to
          // `ownerEmail == request.auth.token.email`, and Firebase stores that
          // token address lower-cased. An address typed with a capital letter
          // used to make both of those writes undeniable-by-rule.
          ownerEmail:       emailLower,
          address:          form.address,
          status:           'pending',
          kycStatus:        'pending',
          type:             'main',
          kycDocUrls:       [aadhaarUrl, panUrl, passbookUrl],
          paymentType:      form.paymentType,
          currency:         isForeign ? 'USD' : 'INR',
          isActive:         false,
          source:           'self_signup',
          createdAt:        serverTimestamp(),
          kycSubmittedAt:   serverTimestamp(),
          totalHosts:       0,
          totalSubAgencies: 0,
          parentAgencyId:   null,
          ...(isForeign ? {
            country:    form.country,
            binanceUid: form.binanceUid,
          } : {
            accountHolderName: form.accountName,
            accountNumber:     form.accountNumber,
            ifscCode:          form.ifsc,
            bankName:          form.bankName,
            branch:            form.branch,
            upiId:             form.upiId,
          }),
        })

        setAgencyId(docRef.id)

        // ── 4. The CRM account, then the back-link ──────────────────────────
        try {
          await createAgencyAccount({
            email:    emailLower,
            name:     form.ownerName,
            phone:    form.ownerPhone,
            agencyId: docRef.id,
            uid:      crmUid,
          })
          await updateDoc(doc(db, 'agencies', docRef.id), { crmUid })
          setLogin({ kind: 'attached' })
        } catch (linkErr: unknown) {
          console.error('Agency CRM account could not be attached:', linkErr)
          setLogin({ kind: 'failed', message: errorMessage(linkErr) })
        }

        setStep(4)
      } catch (err: unknown) {
        console.error(err)
        setError(errorMessage(err) || 'Something went wrong. Please try again.')
      } finally {
        setSubmitting(false)
      }
    }

    return (
      <div>
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-white mb-1">
            {isForeign ? 'Payment Details (International)' : 'Bank Details (India)'}
          </h2>
          <p className="text-slate-400 text-sm">
            {isForeign
              ? 'Payouts will be sent in USD ($10 per 1 lakh beans) to your Binance account.'
              : 'Payouts will be sent in INR (₹1000 per 1 lakh beans) to your bank account.'}
          </p>
        </div>

        {/* Region indicator */}
        <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg mb-5 text-sm font-medium border ${
          isForeign
            ? 'bg-blue-500/10 border-blue-500/30 text-blue-300'
            : 'bg-green-500/10 border-green-500/30 text-green-300'
        }`}>
          <Globe className="w-4 h-4" />
          {isForeign ? '🌍 International Agency — Binance payout ($10 / 1L beans)' : '🇮🇳 Indian Agency — Bank transfer payout (₹1000 / 1L beans)'}
        </div>

        {isForeign ? (
          /* ── Foreign: Binance UID + Country ──────────────────────── */
          <div className="space-y-5">
            <div>
              <label className={labelClass}><span className="flex items-center gap-1.5"><Globe className="w-4 h-4 text-pink-400" />Country *</span></label>
              <input type="text" className={inputClass} placeholder="e.g. United States, United Kingdom, UAE"
                value={form.country} onChange={(e) => set('country', e.target.value)} />
            </div>

            <div>
              <label className={labelClass}><span className="flex items-center gap-1.5"><Hash className="w-4 h-4 text-pink-400" />Binance UID *</span></label>
              <input type="text" className={inputClass} placeholder="Your Binance account UID (numbers only)"
                value={form.binanceUid} onChange={(e) => set('binanceUid', e.target.value)} />
              <p className="text-xs text-slate-500 mt-1">
                Find your Binance UID in Binance App → Profile → UID. Payouts will be sent to this account.
              </p>
            </div>

            <div className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 flex items-start gap-2">
              <Shield className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
              <p className="text-xs text-slate-400">
                Zippern sends payouts via Binance P2P. A ~2% fee applies on Binance's side.
                Make sure your Binance account accepts P2P transfers.
              </p>
            </div>
          </div>
        ) : (
          /* ── India: Bank account details ─────────────────────────── */
          <div className="space-y-5">
            <div>
              <label className={labelClass}><span className="flex items-center gap-1.5"><User className="w-4 h-4 text-pink-400" />Account Holder Name *</span></label>
              <input type="text" className={inputClass} placeholder="Exactly as printed on the account"
                value={form.accountName} onChange={(e) => set('accountName', e.target.value)} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <label className={labelClass}><span className="flex items-center gap-1.5"><Hash className="w-4 h-4 text-pink-400" />Account Number *</span></label>
                <input type="text" className={inputClass} placeholder="Enter account number"
                  value={form.accountNumber} onChange={(e) => set('accountNumber', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}><span className="flex items-center gap-1.5"><Hash className="w-4 h-4 text-pink-400" />Confirm Account Number *</span></label>
                <input type="text"
                  className={`${inputClass} ${
                    form.confirmAccountNumber && form.accountNumber !== form.confirmAccountNumber ? 'border-red-500 focus:border-red-500' :
                    form.confirmAccountNumber && form.accountNumber === form.confirmAccountNumber ? 'border-green-500 focus:border-green-500' : ''
                  }`}
                  placeholder="Re-enter account number"
                  value={form.confirmAccountNumber} onChange={(e) => set('confirmAccountNumber', e.target.value)} />
                {form.confirmAccountNumber && form.accountNumber !== form.confirmAccountNumber && (
                  <p className="text-xs text-red-400 mt-1">Numbers do not match</p>
                )}
                {form.confirmAccountNumber && form.accountNumber === form.confirmAccountNumber && (
                  <p className="text-xs text-green-400 mt-1 flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Matches</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <label className={labelClass}><span className="flex items-center gap-1.5"><Hash className="w-4 h-4 text-pink-400" />IFSC Code *</span></label>
                <input type="text" className={inputClass} placeholder="e.g. SBIN0001234"
                  value={form.ifsc} onChange={(e) => set('ifsc', e.target.value.toUpperCase())} />
              </div>
              <div>
                <label className={labelClass}><span className="flex items-center gap-1.5"><Landmark className="w-4 h-4 text-pink-400" />Bank Name *</span></label>
                <input type="text" className={inputClass} placeholder="e.g. State Bank of India"
                  value={form.bankName} onChange={(e) => set('bankName', e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <label className={labelClass}><span className="flex items-center gap-1.5"><MapPin className="w-4 h-4 text-pink-400" />Branch *</span></label>
                <input type="text" className={inputClass} placeholder="e.g. Connaught Place, Delhi"
                  value={form.branch} onChange={(e) => set('branch', e.target.value)} />
              </div>
              <div>
                <label className={labelClass}><span className="flex items-center gap-1.5"><Wallet className="w-4 h-4 text-pink-400" />UPI ID <span className="text-slate-500 font-normal ml-1">(optional)</span></span></label>
                <input type="text" className={inputClass} placeholder="e.g. name@upi"
                  value={form.upiId} onChange={(e) => set('upiId', e.target.value)} />
              </div>
            </div>
          </div>
        )}

        {duplicates && duplicates.length > 0 && (
          <div className="mt-4 bg-red-500/10 border border-red-500/40 rounded-xl px-5 py-4">
            <p className="text-red-200 text-sm font-semibold flex items-center gap-2">
              <XCircle className="w-4 h-4 flex-shrink-0" />
              An application has already been filed for this email address.
              Nothing was submitted.
            </p>
            <ul className="mt-3 space-y-2">
              {duplicates.map((m) => (
                <li key={m.id} className="border-l-2 border-red-500/40 pl-3">
                  <p className="text-white text-sm font-medium">{m.name}</p>
                  <p className="text-red-100/85 text-sm mt-0.5">It is {statusPhrase(m)}.</p>
                </li>
              ))}
            </ul>
            <p className="text-red-100/75 text-sm mt-3">
              Filing a second one does not make it move faster — it puts two of you
              in front of our team, which is what slows a decision down. If the
              application above was refused, write to us quoting the reference in the
              email we sent you, rather than reapplying (replies to that email are not
              read). If you cannot get into your account, contact{' '}
              <a href={mailtoHref(SUPPORT_EMAIL)} className="text-red-200 underline underline-offset-2 hover:text-white">
                {SUPPORT_EMAIL}
              </a>{' '}
              and quote this address.
            </p>
          </div>
        )}

        {checkWarning && (
          <div className="mt-4 flex items-start gap-2 bg-amber-500/10 border border-amber-500/40 rounded-lg px-4 py-3 text-amber-100 text-sm">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{checkWarning}</span>
          </div>
        )}

        {error && <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">{error}</div>}

        <div className="mt-8 flex justify-between">
          <button onClick={() => { setError(''); setStep(2) }} disabled={submitting}
            className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors disabled:opacity-50">
            <ArrowLeft className="w-4 h-4" /> Back
          </button>
          <button onClick={submit} disabled={submitting}
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors disabled:opacity-60">
            {submitting ? (
              <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Submitting…</>
            ) : (
              <>Submit Application <ArrowRight className="w-4 h-4" /></>
            )}
          </button>
        </div>
      </div>
    )
  }

  // ── Step 4: Done ──────────────────────────────────────────────────────────
  function Step4() {
    return (
      <div className="text-center py-12">
        <div className="flex justify-center mb-6">
          <div className="w-24 h-24 bg-green-500/10 rounded-full flex items-center justify-center">
            <CheckCircle className="text-green-500 w-14 h-14" />
          </div>
        </div>
        <h2 className="text-3xl font-bold text-white mb-3">
          {login?.kind === 'failed'
            ? 'Application Submitted — but your login was not finished'
            : 'Application Submitted!'}
        </h2>
        <p className="text-slate-400 mb-2 max-w-md mx-auto">
          Your registration has been submitted. Your account is pending admin review — you'll receive an email at <span className="text-white font-medium">{form.ownerEmail}</span> once approved. You may close this page.
        </p>

        {/* Never a plain success when half of it failed. The record is filed and
            our team can see it, but the login made on step 1 — password or
            Google — will not open anything until support attaches the account
            by hand. */}
        {login?.kind === 'failed' && (
          <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-6 py-4 mt-6 max-w-md mx-auto text-left">
            <p className="text-red-200 text-sm font-semibold flex items-center gap-2">
              <XCircle className="w-4 h-4 flex-shrink-0" />
              Your application was filed, but your login was not finished.
            </p>
            <p className="text-red-100/85 text-sm mt-1">{login.message}</p>
            <p className="text-red-100/75 text-sm mt-2">
              <strong>Do not fill this form in again</strong> — that would file a
              second application and would be refused anyway. Email{' '}
              <a href={mailtoHref(SUPPORT_EMAIL)} className="text-red-200 underline underline-offset-2 hover:text-white">
                {SUPPORT_EMAIL}
              </a>{' '}
              with the reference below and we will attach your login by hand.
            </p>
          </div>
        )}

        {checkWarning && (
          <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl px-6 py-4 mt-6 max-w-md mx-auto text-left flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-300" />
            <p className="text-amber-100 text-sm">{checkWarning}</p>
          </div>
        )}

        <div className="inline-block bg-slate-800 border border-slate-700 rounded-xl px-6 py-4 mt-4 mb-6">
          <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold mb-1">Application Reference ID</p>
          <p className="text-pink-400 font-mono font-semibold text-lg">{agencyId}</p>
          <p className="text-xs text-slate-500 mt-1">Save this ID for your records</p>
        </div>

        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-6 py-4 mb-8 max-w-md mx-auto text-left">
          <p className="text-yellow-400 text-sm font-semibold mb-2">What happens next?</p>
          <ul className="text-slate-400 text-sm space-y-2">
            <li className="flex items-start gap-2">
              <span className="text-yellow-400 font-bold mt-0.5 shrink-0">1.</span>
              Our team reviews your KYC documents (1–2 business days)
            </li>
            <li className="flex items-start gap-2">
              <span className="text-yellow-400 font-bold mt-0.5 shrink-0">2.</span>
              You'll receive an approval email at{' '}
              <span className="text-white font-medium">{form.ownerEmail}</span> once your account is approved
            </li>
            <li className="flex items-start gap-2">
              <span className="text-yellow-400 font-bold mt-0.5 shrink-0">3.</span>
              {googleUid
                ? 'Log back in with “Continue with Google” to access your Agency Dashboard'
                : 'Log back in with your email and the password you set to access your Agency Dashboard'}
            </li>
            <li className="flex items-start gap-2">
              <span className="text-yellow-400 font-bold mt-0.5 shrink-0">4.</span>
              From your dashboard you can manage hosts, view earnings, and request payouts
            </li>
          </ul>
        </div>

        <div className="bg-slate-800 border border-slate-700 rounded-xl px-6 py-4 mb-6 max-w-md mx-auto text-left">
          <p className="text-slate-300 text-sm font-semibold mb-1">🔐 Login URL</p>
          <p className="text-slate-400 text-sm">
            {googleUid ? (
              <>
                Once approved, log in at the same CRM link shared by Zippern with{' '}
                <span className="text-white font-medium">Continue with Google</span>, using{' '}
                <span className="text-white font-medium">{form.ownerEmail}</span>.
              </>
            ) : (
              <>
                Once approved, log in at the same CRM link shared by Zippern using your email{' '}
                <span className="text-white font-medium">{form.ownerEmail}</span> and the password you set during registration.
              </>
            )}
          </p>
        </div>

        <p className="text-slate-500 text-sm">
          Questions? Contact us at{' '}
          <a href={mailtoHref(SUPPORT_EMAIL)} className="text-pink-400 hover:underline">{SUPPORT_EMAIL}</a>
        </p>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 py-10 px-4">
      <div className="max-w-3xl mx-auto">

        {/* Header */}
        <div className="text-center mb-10">
          <div className="flex items-center justify-center gap-2 mb-3">
            <span className="text-4xl font-black text-pink-500">Zipper</span>
            <span className="text-4xl font-black text-white">Agency</span>
          </div>
          <p className="text-slate-400 text-sm">Register your agency to start onboarding hosts and earning commissions</p>
        </div>

        {/* Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-xl">

          {/* Step indicator */}
          {step < 4 && (
            <div className="flex items-center justify-between mb-10">
              {steps.map((s, idx) => {
                const done   = step > s.num
                const active = step === s.num
                return (
                  <div key={s.num} className="flex items-center flex-1">
                    <div className="flex flex-col items-center">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-300 ${
                        done   ? 'bg-green-500 text-white' :
                        active ? 'bg-pink-500 text-white ring-4 ring-pink-500/30' :
                                 'bg-slate-700 text-slate-400'
                      }`}>
                        {done ? <CheckCircle className="w-5 h-5" /> : s.num}
                      </div>
                      <span className={`text-xs mt-2 font-medium ${
                        active ? 'text-pink-400' : done ? 'text-green-400' : 'text-slate-500'
                      }`}>{s.label}</span>
                    </div>
                    {idx < steps.length - 1 && (
                      <div className={`flex-1 h-0.5 mx-3 mb-5 transition-all duration-300 ${step > s.num ? 'bg-green-500' : 'bg-slate-700'}`} />
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {step === 1 && Step1()}
          {step === 2 && Step2()}
          {step === 3 && Step3()}
          {step === 4 && Step4()}
        </div>

        {step < 4 && (
          <p className="text-center text-slate-600 text-xs mt-6">
            Already registered?{' '}
            <a href={mailtoHref(SUPPORT_EMAIL)} className="text-pink-500 hover:underline">Contact support</a>
          </p>
        )}
      </div>
    </div>
  )
}
