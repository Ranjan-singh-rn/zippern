'use client'

/**
 * Public coin-seller application.
 *
 * ── Why the login is created first ───────────────────────────────────────────
 *
 * This page used to `addDoc` the seller and THEN create the Firebase Auth
 * account, so a retry against an address that already had a login died on
 * `auth/email-already-in-use` *after* the record was committed and left an
 * orphan behind. The CRM's own seller form had the identical bug and produced
 * three orphan records in production for one address.
 *
 * The caller here is unauthenticated, and **an unauthenticated caller can read
 * neither collection**:
 *
 *     match /sellers/{sellerId} { allow read: if request.auth != null; … }
 *
 * and every read clause on `/agencies` requires `request.auth != null` too,
 * with the file ending in `match /{document=**} { allow read, write: if false }`.
 * A duplicate query bolted on before signup would be permission-denied every
 * time — a check that never fires. So:
 *
 *   1. create the **login** first. `createUserWithEmailAndPassword` is an
 *      authoritative, server-side uniqueness test on the address and writes
 *      nothing to Firestore when it refuses. That alone stops the bug.
 *   2. now signed in, run the duplicate query — which catches the case the auth
 *      account cannot: a seller record that exists with no login at all, of
 *      which there are three right now. If it finds one, the application is
 *      refused and the login created a moment ago is deleted again, because it
 *      holds nothing and leaving it would lock the address permanently.
 *   3. write the seller document.
 *   4. write the `crmUsers` document — which `firestore.rules` binds to a seller
 *      record that already names this caller's verified email, so it cannot come
 *      earlier — and link `crmUid` back.
 *
 * A failure at step 4 leaves a seller record with no `crmUid`. This page cannot
 * clean that up — `sellers` delete is `isAdmin()` and the applicant is not, and
 * the only update the rules allow them is the `crmUid` link itself — so it says
 * so, and `/sellers` badges the record "no login attached" for staff.
 *
 * ── "Continue with Google" changes step 1 and nothing else ───────────────────
 *
 * The applicant may create that same first login from a Google popup instead of
 * a password. `partnerSignUpWithGoogle` stands exactly where `createPartnerLogin`
 * stands: it proves the address, hands back one uid, and writes nothing. Steps
 * 2, 3 and 4 then run unchanged against that uid — ONE canonical account either
 * way, and the seller record is filed against the uid Firebase returned, never
 * against a uid found by looking up an address.
 *
 * It happens on step 1 rather than at submit so the address the record is filed
 * under is the one Google verified. `sellerNamesCaller()` in `firestore.rules`
 * binds the `crmUsers` create to `email == request.auth.token.email`, so a typed
 * address that differs from the Google one — by a letter, or entirely — would
 * pass every check on this page and be denied at step 4.
 */

import { useState, useRef } from 'react'
import { auth, db, storage } from '@/lib/firebase'
import { addDoc, collection, serverTimestamp, doc, updateDoc } from 'firebase/firestore'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { signupDocName } from '@/lib/signupDocName'
import {
  createPartnerLogin, createSellerAccount, discardPartnerLogin, ensurePartnerEmailVerified,
  generateCrmId, partnerSignUpWithGoogle,
} from '@/lib/auth'
import {
  Upload, CheckCircle, ArrowRight, ArrowLeft, User, Phone, Mail,
  FileText, ShoppingBag, Shield, MapPin, AlignLeft, Lock, Clock,
  AlertTriangle, XCircle,
} from 'lucide-react'
import {
  normaliseEmail, statusPhrase,
  type ExistingPartner,
} from '@/lib/partnerDuplicates'
import PhoneInput from '@/components/PhoneInput'
import { registeredMessage, useRegisteredCheck } from '@/lib/useRegisteredCheck'
import api from '@/lib/api'

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

export default function SellerSignupPage() {
  const [step, setStep]             = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [applicationId, setApplicationId] = useState('')
  const [error, setError]           = useState('')
  const [login, setLogin]           = useState<LoginOutcome | null>(null)
  // A seller record already filed under this address. Non-null means the form
  // refused; the applicant is told what exists, but not linked to it — they have
  // no permission to open a CRM record.
  const [duplicates, setDuplicates] = useState<ExistingPartner[] | null>(null)
  // Set when the duplicate query itself could not be run. The application still
  // goes through — the login uniqueness check above is the authoritative one —
  // but this is shown rather than swallowed, so the screen never claims a check
  // it did not manage to make.
  const [checkWarning, setCheckWarning] = useState('')

  // ── Signing up with Google ─────────────────────────────────────────────────
  // Non-empty means the applicant took the Google door and the popup already
  // created their canonical account. `googleUid` IS the uid this application is
  // filed against — it is read straight from the popup result and never from an
  // address — there is no password anywhere in the flow, and `form.email` below
  // was set by Google rather than typed, which is why it is read-only from that
  // point on.
  const [googleUid, setGoogleUid]     = useState('')
  const [googleBusy, setGoogleBusy]   = useState(false)
  const [googleError, setGoogleError] = useState('')

  const [form, setForm] = useState({
    displayName:     '',
    phone:           '',
    email:           '',
    city:            '',
    description:     '',
    password:        '',
    confirmPassword: '',
  })

  const [proofUrl,      setProofUrl]      = useState('')
  const [proofProgress, setProofProgress] = useState(0)
  const [proofFile,     setProofFile]     = useState<File | null>(null)
  const proofRef = useRef<HTMLInputElement>(null)

  const set = (field: string, value: string) =>
    setForm((p) => ({ ...p, [field]: value }))

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
        set('email', outcome.email)
      } else if (outcome.kind === 'account-exists') {
        // Said, not silently worked around. Taking the account over because the
        // address matches is the one thing this must never do.
        setGoogleError(
          `${outcome.email} already has a Zipper account, so nothing was created. `
          + 'Sign in at /login with that address instead. If you already sell '
          + 'coins or run an agency with us, apply for the second business from '
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
      set('email', '')
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

  function uploadFile(
    file: File, path: string,
    setProgress: (n: number) => void,
    setUrl: (s: string) => void,
    setFile: (f: File) => void,
  ) {
    setFile(file)
    setProgress(0)
    const task = uploadBytesResumable(ref(storage, path), file)
    task.on(
      'state_changed',
      (snap) => setProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
      (err) => {
        console.error('Upload error:', err)
        setProgress(0)
        setFile(null as unknown as File)
        setError('Upload failed: ' + (err.message ?? 'Please try again.'))
      },
      async () => {
        try {
          setUrl(await getDownloadURL(task.snapshot.ref))
        } catch (err: unknown) {
          console.error('getDownloadURL error:', err)
          setProgress(0)
          setFile(null as unknown as File)
          setError('Could not get file URL after upload. Please try again.')
        }
      },
    )
  }

  const inputClass =
    'bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white w-full ' +
    'focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 ' +
    'placeholder:text-slate-500 transition-colors'
  const labelClass = 'block text-sm font-medium text-slate-300 mb-1.5'

  // ── Step indicator ────────────────────────────────────────────────────────
  const STEPS = [
    { num: 1, label: 'Basic Info' },
    { num: 2, label: 'ID Proof'   },
    { num: 3, label: 'Done'       },
  ]

  // Flags an already-registered email / phone while it is being typed.
  const registered = useRegisteredCheck(form.email, form.phone)

  // ── Step 1: Basic Info + Password ─────────────────────────────────────────
  function Step1() {
    function next() {
      setError('')
      if (!form.displayName.trim() || !form.phone.trim() || !form.email.trim() || !form.city.trim()) {
        setError('Please fill in all required fields.')
        return
      }
      if (!/^\S+@\S+\.\S+$/.test(form.email)) {
        setError('Please enter a valid email address.')
        return
      }
      if (registered.email || registered.phone) {
        setError(registered.email || registered.phone)
        return
      }
      /*
       * ── THIS WAS A HARD WALL FOR EVERY NON-INDIAN SELLER ──────────────────
       *
       * It was `/^\d{10}$/` with the message "Please enter a valid 10-digit
       * phone number." A UK number is ten national digits but is written with a
       * country code; a US one is ten with a `+1`; a UAE one is nine. Each of
       * them failed, with an error telling the applicant their own phone number
       * was invalid. There was no path through this form for them at all.
       *
       * Now: digits, optionally with a leading `+` and any spacing, between
       * seven and fifteen — the E.164 bounds. A bare national number is still
       * accepted and is normalised server-side by `crm_directory.to_e164`,
       * which is the only place a default country is applied.
       */
      {
        const digits = form.phone.replace(/\D/g, '').replace(/^0+/, '')
        if (digits.length < 7 || digits.length > 15) {
          setError(
            'Please enter a valid phone number. Include your country code if ' +
            'you are outside India — for example +1 415 555 0100.',
          )
          return
        }
      }
      // A Google signup has no password to check, now or ever — the login it
      // already created is the account.
      if (!googleUid) {
        if (!form.password || form.password.length < 8) {
          setError('Password must be at least 8 characters.')
          return
        }
        if (form.password !== form.confirmPassword) {
          setError('Passwords do not match.')
          return
        }
      }
      setStep(2)
    }

    return (
      <div>
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-white mb-1">Your Details</h2>
          <p className="text-slate-400 text-sm">Tell us about yourself and choose how you will sign in.</p>
        </div>

        <div className="space-y-5">
          <div>
            <label className={labelClass}><span className="flex items-center gap-1.5"><User className="w-4 h-4 text-pink-400" />Full Name *</span></label>
            <input type="text" className={inputClass} placeholder="Your full name"
              value={form.displayName} onChange={(e) => set('displayName', e.target.value)} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className={labelClass}><span className="flex items-center gap-1.5"><Phone className="w-4 h-4 text-pink-400" />Phone Number *</span></label>
              <PhoneInput className={inputClass} placeholder="Mobile number"
                value={form.phone} onChange={(v) => set('phone', v)} />
              {registered.phone && <p className="text-xs text-red-400 mt-1">{registered.phone}</p>}
            </div>
            <div>
              <label className={labelClass}><span className="flex items-center gap-1.5"><Mail className="w-4 h-4 text-pink-400" />Email Address *</span></label>
              <input type="email"
                className={inputClass + (googleUid ? ' opacity-60 cursor-not-allowed' : '')}
                placeholder="your@email.com"
                readOnly={!!googleUid}
                value={form.email} onChange={(e) => set('email', e.target.value)} />
              {registered.email && <p className="text-xs text-red-400 mt-1">{registered.email}</p>}
              {googleUid && (
                <p className="text-xs text-slate-500 mt-1">
                  Verified by Google. Your application is filed against this address.
                </p>
              )}
            </div>
          </div>

          <div>
            <label className={labelClass}><span className="flex items-center gap-1.5"><MapPin className="w-4 h-4 text-pink-400" />City / Area *</span></label>
            <input type="text" className={inputClass} placeholder="e.g. Mumbai, Maharashtra"
              value={form.city} onChange={(e) => set('city', e.target.value)} />
          </div>

          <div>
            <label className={labelClass}><span className="flex items-center gap-1.5"><AlignLeft className="w-4 h-4 text-pink-400" />About You <span className="text-slate-500 font-normal ml-1">(optional)</span></span></label>
            <textarea rows={3} className={inputClass + ' resize-none'}
              placeholder="Brief description — how you plan to sell coins, your reach, etc."
              value={form.description} onChange={(e) => set('description', e.target.value)} />
          </div>

          {/*
            How this seller will sign in. Two doors, ONE account behind either
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
                    <span className="text-white">{form.email}</span> — no password needed.
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
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <label className={labelClass}><span className="flex items-center gap-1.5"><Lock className="w-4 h-4 text-pink-400" />Password *</span></label>
                    <input type="password" className={inputClass} placeholder="Min. 8 characters"
                      value={form.password} onChange={(e) => set('password', e.target.value)} />
                  </div>
                  <div>
                    <label className={labelClass}><span className="flex items-center gap-1.5"><Lock className="w-4 h-4 text-pink-400" />Confirm Password *</span></label>
                    <input type="password" className={inputClass} placeholder="Repeat password"
                      value={form.confirmPassword} onChange={(e) => set('confirmPassword', e.target.value)} />
                  </div>
                </div>
                <p className="text-slate-500 text-xs mt-2">You'll use your email + this password to log in after approval.</p>

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
            Next: ID Proof <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    )
  }

  // ── Step 2: ID Proof + Submit ─────────────────────────────────────────────
  function Step2() {
    const uploading = proofFile && !proofUrl && proofProgress > 0
    const done      = !!proofUrl

    async function submit() {
      setError('')
      setDuplicates(null)
      setCheckWarning('')
      if (!proofUrl) {
        setError('Please upload your ID proof before submitting.')
        return
      }

      const emailLower = normaliseEmail(form.email)
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
              kind:     'seller',
            })
          } catch (authErr: unknown) {
            setError(
              errorCode(authErr) === 'auth/email-already-in-use'
                ? `An account already exists for ${emailLower}, so nothing was `
                  + 'submitted. If you already sell coins or run an agency with us, '
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
        // P0-5 (AUTHN-2): the rules that bind this application to its login by
        // email require Firebase to have seen the address confirmed. See the
        // same step on /agency-signup.
        const verified = await ensurePartnerEmailVerified()
        if (!verified.ok) {
          setError(verified.message)
          return
        }

        // ── 2. Now signed in: has this address already applied? ─────────────
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
        const undoLoginMadeForTheCheck = async () => {
          if (reusing && googleUid === '') return
          try {
            await discardPartnerLogin(crmUid)
            setGoogleUid('')
          } catch (undoErr: unknown) {
            setCheckWarning(
              `A login was created for ${emailLower} while checking and could not `
              + `be removed again: ${errorMessage(undoErr)}. Contact support — `
              + 'nothing else was created.',
            )
          }
        }

        // ── UGP-G (I-5): ASKED OF THE API, NOT OF FIRESTORE ──────────────────
        //
        // This was `findPartnersByEmail('seller', …)`: a `sellers where email ==`
        // list query. `sellers` is listable by STAFF only (firestore.rules), so
        // for an applicant the query was refused every time, the fail-closed
        // branch below fired, the new login was discarded — and no public
        // seller signup could ever complete. The API's public availability
        // check reads the same records server-side and answers only "is there
        // already a Coin Seller on this address", nothing else.
        let existing:
          | { checked: false; reason: string }
          | { checked: true; matches: ExistingPartner[]; taken: boolean }
        try {
          const r = await api.partnerOps.registrationAvailability(emailLower, '', 'seller')
          existing = { checked: true, matches: [], taken: r.email === 'seller' }
        } catch (lookupErr: unknown) {
          existing = { checked: false, reason: errorMessage(lookupErr) }
        }

        // ── A LOOKUP THAT DID NOT RUN IS NOT A CLEAN RESULT ─────────────────
        //
        // This said "Your application was submitted — if it turns out to be a
        // second one, our team will see both", which is the same fail-open
        // `/agency-signup` had, in the same words. The note it carried —
        // "the uniqueness of the login above is the guard that actually
        // holds" — is not true of a RESUMED session: `reusing` means the
        // applicant was already signed in, so no new login was minted and no
        // uniqueness was tested. That is exactly the path a second record
        // comes in on.
        //
        // One human may hold one Coin Seller, same as one Agency, and the API
        // now refuses the second in Mongo before anything is written
        // (`backend/app/services/partner_roles.py`). Stopping here saves a
        // round trip and gives the applicant a sentence instead of a 400.
        if (!existing.checked) {
          await undoLoginMadeForTheCheck()
          setError(
            'The check for an existing coin seller under this address could not '
            + `be run, so nothing was created: ${existing.reason}. Please try `
            + 'again in a moment.',
          )
          return
        }
        if (existing.taken) {
          await undoLoginMadeForTheCheck()
          setError(registeredMessage('email', 'seller'))
          return
        }

        // ── 3. The seller record ────────────────────────────────────────────
        //
        // `ownerUid` carries this login. The create rule that applies to a
        // signed-in caller with no `crmUsers` document yet is
        // `isAppUser() && request.resource.data.ownerUid == request.auth.uid`,
        // so it cannot be blank here the way it was when this write happened
        // unauthenticated. No `crmUid` yet: if step 4 fails, the record shows on
        // /sellers as having no CRM login rather than pointing at one that does
        // not work.
        const docRef = await addDoc(collection(db, 'sellers'), {
          crmId:                generateCrmId(),
          ownerUid:             crmUid,
          displayName:          form.displayName,
          phone:                form.phone.replace(/\s/g, ''),
          email:                emailLower,
          city:                 form.city,
          description:          form.description,
          registrationProofUrl: proofUrl,
          registrationFeePaid:  false,
          isApproved:           false,
          isActive:             false,
          status:               'pending',
          coinBalance:          0,
          totalCoinsSold:       0,
          qrCodeUrl:            '',
          source:               'self_signup',
          createdAt:            serverTimestamp(),
        })
        setApplicationId(docRef.id)

        // ── 4. The CRM account, then the back-link ──────────────────────────
        try {
          await createSellerAccount({
            email:          emailLower,
            name:           form.displayName,
            phone:          form.phone,
            sellerId:       docRef.id,
            uid:            crmUid,
            linkPartnerDoc: false,
          })
          await updateDoc(doc(db, 'sellers', docRef.id), { crmUid })
          setLogin({ kind: 'attached' })
        } catch (linkErr: unknown) {
          console.error('Seller CRM account could not be attached:', linkErr)
          setLogin({ kind: 'failed', message: errorMessage(linkErr) })
        }

        setStep(3)
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
          <h2 className="text-2xl font-bold text-white mb-1">ID Proof</h2>
          <p className="text-slate-400 text-sm">Upload a government-issued photo ID (Aadhaar, PAN, Voter ID, etc.)</p>
        </div>

        {/* Upload box */}
        <div
          onClick={() => !done && proofRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
            done      ? 'border-green-500 bg-green-500/5' :
            uploading ? 'border-pink-500/50 bg-pink-500/5' :
                        'border-slate-600 hover:border-pink-500'
          }`}
        >
          <input type="file" accept="image/*,application/pdf" className="hidden" ref={proofRef}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f, `sellerDocs/signup/${signupDocName('proof')}`, setProofProgress, setProofUrl, setProofFile) }} />

          {done ? (
            <div className="space-y-3">
              {proofFile?.type.startsWith('image/') ? (
                <img src={proofUrl} alt="ID proof" className="max-h-32 mx-auto rounded object-cover" />
              ) : (
                <div className="flex items-center justify-center gap-2 text-slate-300">
                  <FileText className="w-10 h-10 text-slate-400" />
                  <span className="text-sm">{proofFile?.name}</span>
                </div>
              )}
              <div className="flex items-center justify-center gap-1.5 text-green-400 text-sm font-medium">
                <CheckCircle className="w-4 h-4" /> Uploaded successfully
              </div>
              <button onClick={(e) => { e.stopPropagation(); setProofUrl(''); setProofFile(null); setProofProgress(0); proofRef.current?.click() }}
                className="text-xs text-slate-400 hover:text-white underline">Change document</button>
            </div>
          ) : uploading ? (
            <div className="space-y-3">
              <FileText className="w-10 h-10 text-pink-400 mx-auto" />
              <p className="text-sm text-slate-300 font-medium">Uploading…</p>
              <div className="w-48 bg-slate-700 rounded-full h-2 mx-auto">
                <div className="bg-pink-500 h-2 rounded-full transition-all duration-300" style={{ width: `${proofProgress}%` }} />
              </div>
              <p className="text-xs text-pink-400">{proofProgress}%</p>
            </div>
          ) : (
            <div className="space-y-3">
              <Upload className="w-10 h-10 text-slate-500 mx-auto" />
              <div>
                <p className="text-sm font-medium text-slate-300">Click to upload your ID</p>
                <p className="text-xs text-slate-500 mt-1">Aadhaar, PAN, Voter ID, Driving Licence — JPG, PNG or PDF · Max 10 MB</p>
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 flex items-start gap-2">
          <Shield className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-slate-400">Your ID is stored securely and only reviewed by our verification team.</p>
        </div>

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
              application above was refused, reply to the email we sent you rather
              than reapplying. If you cannot get into your account, contact{' '}
              <a href="mailto:support@zipperlive.com" className="text-red-200 underline underline-offset-2 hover:text-white">
                support@zipperlive.com
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
          <button onClick={() => { setError(''); setStep(1) }} disabled={submitting}
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

  // ── Step 3: Done — Pending Approval ───────────────────────────────────────
  function Step3() {
    return (
      <div className="text-center py-12">
        <div className="flex justify-center mb-6">
          <div className="w-24 h-24 bg-yellow-500/10 rounded-full flex items-center justify-center">
            <Clock className="text-yellow-400 w-14 h-14" />
          </div>
        </div>
        <h2 className="text-3xl font-bold text-white mb-3">
          {login?.kind === 'failed'
            ? 'Registration Submitted — but your login was not finished'
            : 'Registration Submitted!'}
        </h2>
        <p className="text-slate-400 mb-2 max-w-md mx-auto">
          Your account is pending admin approval. You will receive an email at{' '}
          <span className="text-white font-medium">{form.email}</span> once approved.
        </p>

        {applicationId && (
          <p className="text-slate-500 text-xs mt-3">
            Reference <span className="font-mono text-slate-400">{applicationId}</span>
          </p>
        )}

        {/* Never a plain success when half of it failed. The record is filed and
            our team can see it, but the login made on the first screen —
            password or Google — will not open anything until support attaches
            the account by hand. */}
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
              <a href="mailto:support@zipperlive.com" className="text-red-200 underline underline-offset-2 hover:text-white">
                support@zipperlive.com
              </a>{' '}
              with the reference above and we will attach your login by hand.
            </p>
          </div>
        )}

        {checkWarning && (
          <div className="bg-amber-500/10 border border-amber-500/40 rounded-xl px-6 py-4 mt-6 max-w-md mx-auto text-left flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-300" />
            <p className="text-amber-100 text-sm">{checkWarning}</p>
          </div>
        )}

        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl px-6 py-4 mb-8 max-w-md mx-auto text-left mt-6">
          <p className="text-yellow-400 text-sm font-semibold mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4" /> What happens next?
          </p>
          <ul className="text-slate-400 text-sm space-y-2">
            <li className="flex items-start gap-2"><span className="text-pink-400 font-bold shrink-0">1.</span>Our team reviews your application and ID proof (1–2 business days)</li>
            <li className="flex items-start gap-2"><span className="text-pink-400 font-bold shrink-0">2.</span>You'll receive an <strong className="text-white">approval email</strong> at {form.email}</li>
            <li className="flex items-start gap-2"><span className="text-pink-400 font-bold shrink-0">3.</span>{googleUid
              ? 'Log in with “Continue with Google” to access your seller dashboard'
              : 'Log in with your email and the password you set to access your seller dashboard'}</li>
          </ul>
        </div>

        <p className="text-slate-500 text-sm">
          Questions? Contact us at{' '}
          <a href="mailto:support@zipperlive.com" className="text-pink-400 hover:underline">support@zipperlive.com</a>
        </p>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 py-10 px-4">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="text-center mb-10">
          <div className="flex items-center justify-center gap-3 mb-3">
            <div className="w-10 h-10 bg-pink-500/20 rounded-xl flex items-center justify-center">
              <ShoppingBag className="w-5 h-5 text-pink-400" />
            </div>
            <span className="text-4xl font-black text-pink-500">Zipper</span>
            <span className="text-4xl font-black text-white">Coins</span>
          </div>
          <p className="text-slate-400 text-sm">Become a coin seller — earn by selling Zipper coins to users in your area</p>
        </div>

        {/* How it works */}
        {step === 1 && (
          <div className="grid grid-cols-3 gap-3 mb-8">
            {[
              { step: '1', title: 'Register', desc: 'Fill this form with your details and choose how you will sign in' },
              { step: '2', title: 'Get Approved', desc: 'Our team verifies your ID and activates your account' },
              { step: '3', title: 'Sell & Earn', desc: 'Sell coins offline and earn commission on every sale' },
            ].map((item) => (
              <div key={item.step} className="bg-slate-900 border border-slate-800 rounded-xl p-4 text-center">
                <div className="w-8 h-8 bg-pink-500/20 rounded-full flex items-center justify-center mx-auto mb-2">
                  <span className="text-pink-400 font-bold text-sm">{item.step}</span>
                </div>
                <p className="text-white text-sm font-semibold mb-1">{item.title}</p>
                <p className="text-slate-500 text-xs">{item.desc}</p>
              </div>
            ))}
          </div>
        )}

        {/* Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-xl">
          {/* Step indicator */}
          {step < 3 && (
            <div className="flex items-center justify-between mb-10">
              {STEPS.map((s, idx) => {
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
                    {idx < STEPS.length - 1 && (
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
        </div>
      </div>
    </div>
  )
}
