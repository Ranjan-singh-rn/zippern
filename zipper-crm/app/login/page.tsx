'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  crmSignIn,
  crmSignOut,
  sendCrmPasswordReset,
  crmSignInWithGoogle,
  completeGoogleLink,
  cancelGoogleLink,
  isEmailNotVerified,
  sendCrmEmailVerification,
  CrmUser,
} from '@/lib/auth'
import { resetEmailProblem, resetErrorText } from '@/lib/passwordReset'
import { useAuth } from '@/components/AuthProvider'
import api, { ApiError, firestoreBindingOf, getSessionToken, type FirestoreBinding, type OwnerMfaEnrolment } from '@/lib/api'
import { OWNER_MFA_UNAVAILABLE_NOTICE, mfaUnavailable } from '@/lib/mfaAvailability'
import { CrmDoorRefusal, doorRefusalText } from '@/lib/crmDoor'
import TotpQrCode from '@/components/TotpQrCode'

/** P1-A3: wait for AuthProvider's API session exchange rather than racing it. */
async function waitForApiSession(ms = 15000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (getSessionToken()) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return !!getSessionToken()
}

/**
 * `unavailable` (audit C-3): the server answered 404 to `/auth/mfa/status` —
 * it has no two-step sign-in yet. The Owner is let in as before, after a
 * notice that says so. Not `blocked`: that stage is for a sign-in that FAILED.
 */
type MfaStage = 'loading' | 'enrol' | 'verify' | 'codes' | 'blocked' | 'unbound' | 'unavailable'

export default function LoginPage() {
  const router = useRouter()
  const { crmUser, loading } = useAuth()

  const [email, setEmail]         = useState('')
  const [password, setPassword]   = useState('')
  const [error, setError]         = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const passwordRef = useRef<HTMLInputElement>(null)

  // Set when the failure looks like someone trying to sign in here with an
  // account that has no password. The observer is the case that matters:
  // the Observer's address (NEXT_PUBLIC_OBSERVER_EMAIL) used to be a superadmin
  // with a password and is now the read-only observer, who signs in with a
  // one-time code instead. Typing the
  // old password here gets "Invalid email or password", which is true and
  // completely unhelpful — the account exists, it just does not work this way.
  const [suggestObserver, setSuggestObserver] = useState(false)

  // ── Google ────────────────────────────────────────────────────────────────
  // `linkEmail` non-empty means Firebase refused the Google credential because
  // the address already has a password account — theirs. The credential is
  // held in lib/auth and the password below is what authorises attaching it to
  // that existing uid. This is the ONE place a password appears in a Google
  // flow, and removing it would turn "same email" into "same person", which is
  // the merge this design exists to refuse.
  const [googleBusy, setGoogleBusy] = useState(false)
  const [linkEmail, setLinkEmail]       = useState('')
  const [linkPassword, setLinkPassword] = useState('')
  const [linkError, setLinkError]       = useState('')
  const [linkBusy, setLinkBusy]         = useState(false)

  // The one refusal on this screen whose answer is a button rather than another
  // go at the password. It is set only by `isEmailNotVerified`, so a wrong
  // password never offers a verification email it cannot send — sending one
  // requires the password the person has just failed to give.
  const [needsVerification, setNeedsVerification] = useState(false)
  const [verifySending, setVerifySending]         = useState(false)
  const [verifySent, setVerifySent]               = useState(false)
  const [verifyError, setVerifyError]             = useState('')

  // Forgot password
  const [showForgot, setShowForgot]           = useState(false)
  const [forgotEmail, setForgotEmail]         = useState('')
  const [forgotSending, setForgotSending]     = useState(false)
  const [forgotSent, setForgotSent]           = useState(false)
  const [forgotError, setForgotError]         = useState('')

  async function handleForgotPassword() {
    const emailTrimmed = forgotEmail.trim()
    // QA #46: one address, checked before sending — the box used to send a
    // doubled address and answer with a vague error.
    const problem = resetEmailProblem(emailTrimmed)
    if (problem) { setForgotError(problem); return }
    setForgotError('')
    setForgotSending(true)
    try {
      await sendCrmPasswordReset(emailTrimmed)
      setForgotSent(true)
    } catch (err) {
      setForgotError(resetErrorText(err))
    } finally {
      setForgotSending(false)
    }
  }

  function handleForgotBack() {
    setShowForgot(false)
    setForgotEmail('')
    setForgotSent(false)
    setForgotError('')
  }

  // ── P1-A3: Owner two-step sign-in (replaces the browser-only question gate) ──
  // The API enforces this: an Owner session that has not passed a code is
  // refused on every route but the MFA ones. This screen only drives the steps.
  const [pendingUser, setPendingUser] = useState<CrmUser | null>(null)
  const [mfaStage, setMfaStage]       = useState<MfaStage | null>(null)
  const [enrolment, setEnrolment]     = useState<OwnerMfaEnrolment | null>(null)
  const [mfaCode, setMfaCode]         = useState('')
  const [useRecovery, setUseRecovery] = useState(false)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [mfaError, setMfaError]       = useState('')
  const [mfaBusy, setMfaBusy]         = useState(false)
  // P1-A3b: whether this browser's Firebase sign-in was bound (Firestore/Storage).
  const [binding, setBinding]         = useState<FirestoreBinding | undefined>(undefined)

  /**
   * Into the CRM — unless Firestore/Storage stayed locked, which is said, not hidden.
   * Only a reported `bound` counts (CRM-FINDINGS F2): an answer with no binding
   * result is not evidence that this sign-in was unlocked, so it is shown as
   * locked too.
   */
  function enterOrExplain(b: FirestoreBinding | undefined) {
    setBinding(b)
    if (b?.state === 'bound') { setMfaStage(null); router.push('/'); return }
    setMfaStage('unbound')
  }

  async function handleRetryBind() {
    setMfaError('')
    setMfaBusy(true)
    try {
      enterOrExplain(await api.auth.mfaBind())
    } catch (e) {
      setMfaError(e instanceof ApiError ? e.message : 'Could not unlock Firestore. Try again.')
    } finally {
      setMfaBusy(false)
    }
  }

  // Handle persisted session on page load ONLY.
  // This runs exactly once when loading finishes — it does NOT fire again when
  // crmUser changes after the login form is submitted. That prevents the race
  // condition where AuthProvider's setCrmUser fires AFTER handleLogin has
  // already started the Owner's two-step sign-in, starting it a second time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (loading) return          // still resolving
    if (!crmUser) return         // not logged in — show login form
    if (mfaStage) return  // already handling two-step sign-in
    // Persisted session: user was already logged in when they visited /login
    if (crmUser.role === 'superadmin') {
      void beginMfa(crmUser)
    } else {
      router.push('/')
    }
  }, [loading]) // ← intentionally omit crmUser; only runs once on page load

  /**
   * Where every successful sign-in goes, whichever door it came through.
   *
   * Owner two-step sign-in is a property of the ACCOUNT, not of the password
   * form — so a Google sign-in passes it too. (The API enforces it whichever
   * door was used; this keeps the screen from offering a dashboard that will
   * refuse every call.)
   */
  function afterSignedIn(user: CrmUser) {
    if (user.role === 'superadmin') {
      void beginMfa(user)
    } else {
      router.push('/')
    }
  }

  /** Where does this Owner stand? Verified → in; enrolled → code; else set up. */
  async function beginMfa(user: CrmUser) {
    setPendingUser(user)
    setMfaStage('loading')
    setMfaError('')
    setMfaCode('')
    try {
      if (!(await waitForApiSession())) {
        setMfaError('Could not reach the business API to finish signing in. Try again.')
        setMfaStage('blocked')
        return
      }
      // ── Audit C-3: a backend without the MFA routes ──────────────────────
      // The revision serving production today has no `/auth/mfa/*`. A 404
      // here is "not available yet", NOT a failed sign-in: proceed exactly as
      // before two-step sign-in existed, after a notice that says so. Any
      // other failure (5xx, network, 401/403) still blocks — an outage of the
      // MFA service must not become a way around it.
      let st
      try {
        st = await api.auth.mfaStatus()
      } catch (e) {
        if (mfaUnavailable(e)) {
          setMfaError('')
          setMfaStage('unavailable')
          return
        }
        throw e
      }
      if (st.verified) { router.push('/'); return }
      if (st.configured === false) {
        setMfaError('Two-step sign-in is not configured on the server yet. Ask whoever runs the deployment to set OWNER_MFA_ENCRYPTION_KEY.')
        setMfaStage('blocked')
        return
      }
      if (st.locked_until) {
        setMfaError(`Too many wrong codes. Try again after ${new Date(st.locked_until).toLocaleTimeString()}.`)
      }
      if (st.enrolled) {
        setMfaStage('verify')
      } else {
        setEnrolment(await api.auth.mfaEnrolStart())
        setMfaStage('enrol')
      }
    } catch (e) {
      setMfaError(e instanceof Error ? e.message : 'Could not start two-step sign-in.')
      setMfaStage('blocked')
    }
  }

  async function handleGoogle() {
    setError('')
    setSuggestObserver(false)
    setGoogleBusy(true)
    try {
      const outcome = await crmSignInWithGoogle()
      if (outcome.kind === 'signed-in') {
        afterSignedIn(outcome.user)
      } else if (outcome.kind === 'needs-password') {
        // Not an error. The account exists and this is how it gets connected.
        setLinkEmail(outcome.email)
        setLinkPassword('')
        setLinkError('')
        resetVerification()
      } else if (outcome.message) {
        setError(outcome.message)
      }
      // A blank refusal message is a closed popup. Say nothing.
    } catch (err: unknown) {
      setError(err instanceof CrmDoorRefusal ? doorRefusalText(err.message) : 'Google sign-in failed. Try again.')
    } finally {
      setGoogleBusy(false)
    }
  }

  function resetVerification() {
    setNeedsVerification(false)
    setVerifySending(false)
    setVerifySent(false)
    setVerifyError('')
  }

  async function handleCompleteLink() {
    if (!linkPassword.trim()) {
      setLinkError('Enter your password to connect Google.')
      return
    }
    setLinkError('')
    resetVerification()
    setLinkBusy(true)
    try {
      const user = await completeGoogleLink(linkEmail, linkPassword)
      setLinkEmail('')
      setLinkPassword('')
      afterSignedIn(user)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      if (err instanceof CrmDoorRefusal) {
        setLinkError(doorRefusalText(err.message))
      } else if (isEmailNotVerified(err)) {
        // The password was right — this is not a second attempt at it. The
        // address has not been proved, so linking is refused and the way
        // forward is the button below rather than the field above. Shown in
        // lib/auth's own words: they explain what linking would have cost.
        setLinkError(msg)
        setNeedsVerification(true)
      } else if (
        msg.includes('invalid-credential') ||
        msg.includes('wrong-password') ||
        msg.includes('user-not-found')
      ) {
        setLinkError('That password is not right for this account.')
      } else if (msg.includes('too-many-requests')) {
        setLinkError('Too many attempts. Wait a minute and try again.')
      } else {
        setLinkError(msg || 'Could not connect Google. Try again.')
      }
    } finally {
      setLinkBusy(false)
    }
  }

  /**
   * Send the verification email for the account being connected.
   *
   * There is no session to send from — `completeGoogleLink` signed out before
   * it refused — so the password already in the box is what authorises it, and
   * `sendCrmEmailVerification` signs in only long enough to send.
   */
  async function handleSendVerification() {
    if (!linkPassword.trim()) {
      setVerifyError('Enter the account password again so the email can be sent.')
      return
    }
    setVerifyError('')
    setVerifySent(false)
    setVerifySending(true)
    try {
      await sendCrmEmailVerification({ email: linkEmail, password: linkPassword })
      setVerifySent(true)
    } catch {
      setVerifyError('Could not send the verification email. Check the password and try again.')
    } finally {
      setVerifySending(false)
    }
  }

  function handleCancelLink() {
    cancelGoogleLink()
    setLinkEmail('')
    setLinkPassword('')
    setLinkError('')
    resetVerification()
  }

  // ── Step 1: Email + Password ────────────────────────────────────────────────
  async function handleLogin() {
    if (!email.trim() || !password.trim()) {
      setError('Please enter both email and password.')
      return
    }
    setError('')
    setSuggestObserver(false)
    setSigningIn(true)
    try {
      afterSignedIn(await crmSignIn(email.trim(), password))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Login failed.'
      if (err instanceof CrmDoorRefusal) {
        // QA #49 / #44: the door's own sentence, as it is — a rejection with
        // its reason and "you may apply again", a suspension, a deactivation.
        setError(doorRefusalText(err.message))
      } else if (msg.includes('CRM account not found')) {
        // The Firebase password was right — there is simply no staff record
        // behind it. That is exactly the observer's shape, so point there
        // rather than leaving them to guess.
        setError('This account has no staff access.')
        setSuggestObserver(true)
      } else if (
        msg.includes('invalid-credential') ||
        msg.includes('wrong-password') ||
        msg.includes('user-not-found') ||
        msg.includes('INVALID_LOGIN_CREDENTIALS') ||
        msg.includes('not found')
      ) {
        setError('Invalid email or password.')
        // A wrong password is the other way the observer lands here, since
        // their old one no longer works. Offer the route without asserting
        // anything about whether this address exists.
        setSuggestObserver(true)
      } else {
        setError(msg)
      }
    } finally {
      setSigningIn(false)
    }
  }

  // ── Step 2a: First sign-in — set up an authenticator app ──────────────────
  async function handleEnrolConfirm() {
    setMfaError('')
    setMfaBusy(true)
    try {
      const { user, recoveryCodes: codes } = await api.auth.mfaEnrolConfirm(mfaCode.trim())
      setBinding(firestoreBindingOf(user))
      setRecoveryCodes(codes)
      setMfaCode('')
      setMfaStage('codes')
    } catch (e) {
      setMfaError(e instanceof ApiError ? e.message : 'Could not check the code. Try again.')
    } finally {
      setMfaBusy(false)
    }
  }

  // ── Step 2b: Every later sign-in — a code from the app, or a recovery code ─
  async function handleVerify() {
    setMfaError('')
    setMfaBusy(true)
    try {
      const user = await api.auth.mfaVerify(useRecovery ? { recoveryCode: mfaCode.trim() } : { code: mfaCode.trim() })
      enterOrExplain(firestoreBindingOf(user))
    } catch (e) {
      setMfaError(e instanceof ApiError ? e.message : 'Could not check the code. Try again.')
    } finally {
      setMfaBusy(false)
    }
  }

  async function handleCancel() {
    await api.auth.signOut().catch(() => undefined)
    await crmSignOut()
    setMfaStage(null); setPendingUser(null); setEnrolment(null)
    setMfaCode(''); setMfaError(''); setRecoveryCodes([]); setUseRecovery(false)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-400 text-sm">Loading Zipper CRM…</p>
        </div>
      </div>
    )
  }

  // ── Owner two-step sign-in (P1-A3) ─────────────────────────────────────────
  if (mfaStage) {
    const title =
      mfaStage === 'enrol' ? 'Set up two-step sign-in'
      : mfaStage === 'codes' ? 'Save your recovery codes'
      : mfaStage === 'verify' ? 'Two-step sign-in'
      : mfaStage === 'blocked' ? 'Cannot finish signing in'
      : mfaStage === 'unbound' ? 'Signed in — some screens are locked'
      : mfaStage === 'unavailable' ? 'Signed in — without a second step'
      : 'Checking…'
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-pink-500/10 border border-pink-500/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">🔐</span>
            </div>
            <h1 className="text-2xl font-black text-white">{title}</h1>
            {pendingUser?.email && <p className="text-slate-400 text-sm mt-1">{pendingUser.email}</p>}
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-5">
            {mfaStage === 'loading' && (
              <div className="flex justify-center py-4">
                <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}

            {mfaStage === 'enrol' && enrolment && (
              <>
                <p className="text-slate-300 text-sm">
                  Owner accounts need a code from an authenticator app (Google Authenticator,
                  Microsoft Authenticator, 1Password…) every time they sign in.
                </p>
                <ol className="text-slate-400 text-sm list-decimal pl-5 space-y-1">
                  <li>In the app tap <b>+</b> and choose <b>Scan a QR code</b>.</li>
                  <li>Scan the code below.</li>
                  <li>Enter the 6-digit code the app shows.</li>
                </ol>
                <TotpQrCode uri={enrolment.otpauth_uri} />
                <p className="text-slate-500 text-xs">
                  Set this up before? Delete the old Zipper entry in the app first — only this code works now.
                </p>
                <div className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-3">
                  <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Can&apos;t scan? Setup key (time-based)</p>
                  <p className="text-white font-mono text-sm select-all leading-relaxed">
                    {enrolment.secret.replace(/(.{4})/g, '$1 ').trim()}
                  </p>
                </div>
                <a href={enrolment.otpauth_uri} className="block text-pink-400 text-xs underline">
                  On this phone? Open in your authenticator app
                </a>
              </>
            )}

            {mfaStage === 'unavailable' && (
              <>
                {/* Audit C-3: said, not hidden — nobody should mistake "the
                    server has no second step" for "I passed the second step". */}
                <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
                  <p className="text-amber-200 text-sm leading-relaxed">{OWNER_MFA_UNAVAILABLE_NOTICE}</p>
                </div>
                <div className="flex gap-3 pt-1">
                  <button onClick={handleCancel}
                    className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-lg px-4 py-3 text-sm transition-colors">
                    Sign out
                  </button>
                  <button onClick={() => { setMfaStage(null); router.push('/') }}
                    className="flex-1 bg-pink-500 hover:bg-pink-600 text-white font-semibold rounded-lg px-4 py-3 text-sm transition-colors">
                    Continue to the CRM
                  </button>
                </div>
              </>
            )}

            {mfaStage === 'unbound' && (
              <>
                <p className="text-slate-300 text-sm">
                  Your code was accepted, but this browser&apos;s sign-in could not be linked to it, so
                  screens that read Firestore or stored documents directly stay locked for your Owner account.
                </p>
                {binding?.reason && <p className="text-amber-300 text-sm">{binding.reason}</p>}
                <div className="flex gap-3 pt-1">
                  <button onClick={handleRetryBind} disabled={mfaBusy}
                    className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/50 text-white font-semibold rounded-lg px-4 py-3 text-sm transition-colors">
                    {mfaBusy ? 'Trying…' : 'Retry unlock'}
                  </button>
                  <button onClick={() => { setMfaStage(null); router.push('/') }}
                    className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-lg px-4 py-3 text-sm transition-colors">
                    Continue anyway
                  </button>
                </div>
              </>
            )}

            {mfaStage === 'codes' && (
              <>
                <p className="text-slate-300 text-sm">
                  Each code signs you in once if you lose your phone. They are shown only now —
                  keep them somewhere safe, away from this computer.
                </p>
                <div className="grid grid-cols-2 gap-2 bg-slate-800 border border-slate-700 rounded-lg p-4 font-mono text-sm text-white select-all">
                  {recoveryCodes.map((c) => <span key={c}>{c}</span>)}
                </div>
                <button
                  onClick={() => { setRecoveryCodes([]); enterOrExplain(binding) }}
                  className="w-full bg-pink-500 hover:bg-pink-600 text-white font-semibold rounded-lg px-4 py-3 text-sm transition-colors"
                >
                  I have saved them — enter the CRM
                </button>
              </>
            )}

            {(mfaStage === 'enrol' || mfaStage === 'verify') && (
              <div>
                <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">
                  {useRecovery ? 'Recovery code' : 'Code from your authenticator app'}
                </label>
                <input
                  autoFocus
                  inputMode={useRecovery ? 'text' : 'numeric'}
                  autoComplete="one-time-code"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && (mfaStage === 'enrol' ? handleEnrolConfirm() : handleVerify())}
                  placeholder={useRecovery ? 'xxxxx-xxxxx' : '123456'}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
                />
                {mfaStage === 'verify' && (
                  <button
                    type="button"
                    onClick={() => { setUseRecovery((v) => !v); setMfaCode(''); setMfaError('') }}
                    className="mt-2 text-xs text-slate-400 hover:text-white underline"
                  >
                    {useRecovery ? 'Use the authenticator app instead' : 'Lost your phone? Use a recovery code'}
                  </button>
                )}
              </div>
            )}

            {mfaError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
                <p className="text-red-400 text-sm">{mfaError}</p>
              </div>
            )}

            {mfaStage !== 'codes' && mfaStage !== 'unavailable' && (
              <div className="flex gap-3 pt-1">
                <button
                  onClick={handleCancel}
                  className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-lg px-4 py-3 text-sm transition-colors"
                >
                  {mfaStage === 'blocked' ? 'Sign out' : 'Cancel'}
                </button>
                {mfaStage === 'blocked' && pendingUser && (
                  <button
                    onClick={() => beginMfa(pendingUser)}
                    className="flex-1 bg-pink-500 hover:bg-pink-600 text-white font-semibold rounded-lg px-4 py-3 text-sm transition-colors"
                  >
                    Try again
                  </button>
                )}
                {(mfaStage === 'enrol' || mfaStage === 'verify') && (
                  <button
                    onClick={mfaStage === 'enrol' ? handleEnrolConfirm : handleVerify}
                    disabled={mfaBusy || mfaCode.trim().length < 6}
                    className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/50 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-3 text-sm transition-colors"
                  >
                    {mfaBusy ? 'Checking…' : mfaStage === 'enrol' ? 'Turn on & continue' : 'Verify'}
                  </button>
                )}
              </div>
            )}

            {mfaStage === 'verify' && (
              <p className="text-slate-500 text-xs">
                Lost your phone and your recovery codes? The Observer can reset your two-step sign-in.
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Forgot Password ────────────────────────────────────────────────────────
  if (showForgot) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-pink-500/10 border border-pink-500/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">🔑</span>
            </div>
            <h1 className="text-2xl font-black text-white">Reset Password</h1>
            <p className="text-slate-400 text-sm mt-1">
              {forgotSent ? 'Check your inbox' : 'Enter your account email'}
            </p>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
            {forgotSent ? (
              <div className="space-y-5">
                <div className="bg-green-500/10 border border-green-500/30 rounded-lg px-4 py-4 text-center">
                  <p className="text-green-400 text-sm font-medium">Reset email sent!</p>
                  <p className="text-slate-400 text-xs mt-1">
                    Check <span className="text-white">{forgotEmail}</span> and follow the link to set a new password.
                  </p>
                </div>
                <button
                  onClick={handleForgotBack}
                  className="w-full bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-lg px-4 py-3 text-sm transition-colors"
                >
                  Back to Sign in
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                <div>
                  <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">
                    Email Address
                  </label>
                  <input
                    autoFocus
                    type="email"
                    value={forgotEmail}
                    // QA #46: the address carried over from the sign-in form is
                    // selected, so typing it again replaces it instead of doubling it.
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => { setForgotEmail(e.target.value); if (forgotError) setForgotError('') }}
                    onKeyDown={(e) => e.key === 'Enter' && handleForgotPassword()}
                    placeholder="your.email@gmail.com"
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
                  />
                </div>

                {forgotError && (
                  <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
                    <p className="text-red-400 text-sm">{forgotError}</p>
                  </div>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={handleForgotBack}
                    className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-lg px-4 py-3 text-sm transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleForgotPassword}
                    disabled={forgotSending || !forgotEmail.trim()}
                    className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/50 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-3 text-sm transition-colors flex items-center justify-center gap-2"
                  >
                    {forgotSending ? (
                      <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Sending…</>
                    ) : (
                      'Send Reset Link'
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── Connect Google to the account that already owns this address ──────────
  //
  // Reached only from `auth/account-exists-with-different-credential`: the
  // Google identity is genuine, the address is genuine, and they belong to a
  // CRM account that was created with a password. What is missing is proof
  // that the person at the keyboard is that account's owner rather than
  // somebody holding the Gmail — and the password is that proof.
  //
  // This is a one-time step per person. After it, the uid carries both
  // providers and Google goes straight in, here and in the Android app.
  if (linkEmail) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-10">
            <h1 className="text-5xl font-black tracking-tight">
              <span className="text-pink-500">Zipper</span>
              <span className="text-white"> CRM</span>
            </h1>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
            <h2 className="text-white text-xl font-semibold mb-2">Connect Google</h2>
            <p className="text-slate-400 text-sm leading-relaxed mb-6">
              <span className="text-slate-200">{linkEmail}</span> already has a
              Zipper CRM account. Enter its password once and Google will be
              connected to that same account — you will not be asked again.
            </p>

            <div className="mb-5">
              <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">
                Password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                autoFocus
                value={linkPassword}
                onChange={(e) => setLinkPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCompleteLink()}
                placeholder="••••••••"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
              />
            </div>

            {linkError && (
              <div
                className={`mb-5 border rounded-lg px-4 py-3 ${
                  needsVerification
                    ? 'bg-amber-500/10 border-amber-500/30'
                    : 'bg-red-500/10 border-red-500/30'
                }`}
              >
                <p className={needsVerification ? 'text-amber-200 text-sm leading-relaxed' : 'text-red-400 text-sm'}>
                  {linkError}
                </p>
              </div>
            )}

            {/* The way out of the refusal, and the only control on this screen
                that is not another attempt at the password. Pressing "Connect
                and sign in" again would be refused identically until the
                address is verified, so the thing that changes that is put
                directly under the sentence explaining it. */}
            {needsVerification && (
              <div className="mb-5">
                <button
                  type="button"
                  onClick={handleSendVerification}
                  disabled={verifySending}
                  className="w-full bg-slate-800 hover:bg-slate-700 disabled:bg-slate-800/50 disabled:cursor-not-allowed border border-slate-700 text-slate-200 font-semibold rounded-lg px-4 py-3 text-sm transition-colors flex items-center justify-center gap-2"
                >
                  {verifySending ? (
                    <>
                      <span className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                      Sending…
                    </>
                  ) : (
                    'Send verification email'
                  )}
                </button>

                {verifySent && (
                  <p className="text-green-400 text-xs mt-2.5 leading-relaxed">
                    Sent to <span className="text-green-300">{linkEmail}</span>. Open the link in
                    it, come back here, and press &ldquo;Continue with Google&rdquo; again — your
                    password still works in the meantime.
                  </p>
                )}
                {verifyError && (
                  <p className="text-red-400 text-xs mt-2.5">{verifyError}</p>
                )}
              </div>
            )}

            <button
              onClick={handleCompleteLink}
              disabled={linkBusy}
              className="w-full bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/50 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-3 text-sm transition-colors flex items-center justify-center gap-2"
            >
              {linkBusy ? (
                <>
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Connecting…
                </>
              ) : (
                'Connect and sign in'
              )}
            </button>

            <button
              type="button"
              onClick={handleCancelLink}
              className="w-full text-center text-slate-400 hover:text-pink-300 text-xs transition-colors mt-4"
            >
              Cancel — sign in with email and password instead
            </button>
          </div>

          <p className="text-center text-slate-600 text-xs mt-6">
            Your password is not sent to Google, and Google is not given access
            to it.
          </p>
        </div>
      </div>
    )
  }

  // ── Login Form ─────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-10">
          <h1 className="text-5xl font-black tracking-tight">
            <span className="text-pink-500">Zipper</span>
            <span className="text-white"> CRM</span>
          </h1>
          <p className="text-slate-500 text-sm mt-2">Internal Admin Panel</p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          <h2 className="text-white text-xl font-semibold mb-6">Sign in to your account</h2>

          <div className="mb-4">
            <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">
              Email
            </label>
            <input
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && passwordRef.current?.focus()}
              placeholder="your.email@gmail.com"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
            />
          </div>

          <div className="mb-6">
            <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">
              Password
            </label>
            <input
              ref={passwordRef}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              placeholder="••••••••"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
            />
          </div>

          <div className="flex justify-end -mt-4 mb-5">
            <button
              type="button"
              onClick={() => { setShowForgot(true); setForgotEmail(email) }}
              className="text-xs text-pink-400 hover:text-pink-300 transition-colors"
            >
              Forgot password?
            </button>
          </div>

          {error && (
            <div className="mb-5 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
              <p className="text-red-400 text-sm">{error}</p>
              {suggestObserver && (
                <p className="text-slate-400 text-xs mt-2 leading-relaxed">
                  Signing in as the observer? That account has no password — it
                  uses a one-time code sent to the registered address each time.{' '}
                  <button
                    type="button"
                    onClick={() => router.push('/observer')}
                    className="text-pink-400 hover:text-pink-300 underline underline-offset-2"
                  >
                    Sign in with a code
                  </button>
                </p>
              )}
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={signingIn}
            className="w-full bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/50 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-3 text-sm transition-colors flex items-center justify-center gap-2"
          >
            {signingIn ? (
              <>
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </button>

          {/*
            Google is a second way to prove who you are — not a second account
            and not a second tier of access. Whichever door is used, the uid
            behind it is the same one, so the role, the permissions and the
            superadmin gate are identical either way.
          */}
          <div className="flex items-center gap-3 my-5">
            <div className="flex-1 h-px bg-slate-800" />
            <span className="text-slate-600 text-xs uppercase tracking-wide">or</span>
            <div className="flex-1 h-px bg-slate-800" />
          </div>

          <button
            onClick={handleGoogle}
            disabled={googleBusy || signingIn}
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
        </div>

        {/*
          The observer route is always visible, not only after a failure. It is
          a different way of signing in, not an error state — and the observer
          should not have to fail once to discover where their door is.
        */}
        <div className="mt-5 pt-5 border-t border-slate-800">
          <button
            type="button"
            onClick={() => router.push('/observer')}
            className="w-full text-center text-slate-400 hover:text-pink-300 text-xs transition-colors"
          >
            Observer access — sign in with a one-time code
          </button>
        </div>

        {/*
          Same reasoning as the observer block above. An agency or a coin seller
          who lands here has no staff account and never will — their form is a
          different door, and they should not have to fail once to find it.
        */}
        <div className="mt-3 pt-3 border-t border-slate-800">
          <button
            type="button"
            onClick={() => router.push('/agency-signup')}
            className="w-full text-center text-slate-400 hover:text-pink-300 text-xs transition-colors"
          >
            Registering an agency — apply here
          </button>
          <button
            type="button"
            onClick={() => router.push('/seller-signup')}
            className="w-full text-center text-slate-400 hover:text-pink-300 text-xs transition-colors mt-2"
          >
            Registering as a coin seller — apply here
          </button>
        </div>

        <p className="text-center text-slate-600 text-xs mt-6">
          Zipper CRM · Internal use only · Unauthorized access is prohibited
        </p>
      </div>
    </div>
  )
}
