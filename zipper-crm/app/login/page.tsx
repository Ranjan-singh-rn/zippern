'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  crmSignIn,
  crmSignOut,
  saveGateAnswers,
  sendCrmPasswordReset,
  crmSignInWithGoogle,
  completeGoogleLink,
  cancelGoogleLink,
  isEmailNotVerified,
  sendCrmEmailVerification,
  CrmUser,
} from '@/lib/auth'
import { useAuth } from '@/components/AuthProvider'

function normalize(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

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
  // 314zipper@gmail.com used to be a superadmin with a password and is now the
  // read-only observer, who signs in with a one-time code instead. Typing the
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
    if (!emailTrimmed) { setForgotError('Please enter your email address.'); return }
    setForgotError('')
    setForgotSending(true)
    try {
      await sendCrmPasswordReset(emailTrimmed)
      setForgotSent(true)
    } catch {
      setForgotError('Could not send reset email. Check the address and try again.')
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

  // The signed-in user waiting at the gate
  const [pendingUser, setPendingUser] = useState<CrmUser | null>(null)

  // Gate verification state (returning superadmin)
  const [showGate, setShowGate]         = useState(false)
  const [gateA1, setGateA1]             = useState('')
  const [gateA2, setGateA2]             = useState('')
  const [gateA3, setGateA3]             = useState('')
  const [gateError, setGateError]       = useState('')
  const [gateAttempts, setGateAttempts] = useState(0)

  // Gate setup state (first-time superadmin — no saved answers yet)
  const [showSetup, setShowSetup]     = useState(false)
  const [setupA1, setSetupA1]         = useState('')
  const [setupA2, setSetupA2]         = useState('')
  const [setupA3, setSetupA3]         = useState('')
  const [setupError, setSetupError]   = useState('')
  const [setupSaving, setSetupSaving] = useState(false)

  // Handle persisted session on page load ONLY.
  // This runs exactly once when loading finishes — it does NOT fire again when
  // crmUser changes after the login form is submitted. That prevents the race
  // condition where AuthProvider's setCrmUser (which may carry 314zipper's cached
  // gateAnswers) fires AFTER handleLogin's setShowSetup(true) is queued but
  // before React commits it, causing setShowGate(true) to fire instead.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (loading) return          // still resolving
    if (!crmUser) return         // not logged in — show login form
    if (showGate || showSetup) return  // already handling gate/setup
    // Persisted session: user was already logged in when they visited /login
    if (crmUser.role === 'superadmin') {
      setPendingUser(crmUser)
      if (crmUser.gateAnswers) {
        setShowGate(true)
      } else {
        setShowSetup(true)
      }
    } else {
      router.push('/')
    }
  }, [loading]) // ← intentionally omit crmUser; only runs once on page load

  /**
   * Where every successful sign-in goes, whichever door it came through.
   *
   * The superadmin gate is a property of the ACCOUNT, not of the password
   * form — so a Google sign-in has to pass it too. Keeping this in one
   * function is what stops "Continue with Google" quietly becoming the way
   * around it.
   */
  function afterSignedIn(user: CrmUser) {
    if (user.role === 'superadmin') {
      setPendingUser(user)
      if (user.gateAnswers) setShowGate(true)
      else setShowSetup(true)   // first login — set up their gate answers
    } else {
      router.push('/')
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
    } catch {
      setError('Google sign-in failed. Try again.')
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
      if (isEmailNotVerified(err)) {
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
      if (msg.includes('deactivated')) {
        setError('This account has been deactivated. Contact your administrator.')
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

  // ── Step 2a: First-time gate setup ─────────────────────────────────────────
  async function handleSetupSubmit() {
    setSetupError('')
    if (!setupA1.trim()) { setSetupError('Please enter your full name.'); return }
    if (!setupA2.trim()) { setSetupError('Please enter your phone number.'); return }
    if (!setupA3.trim()) { setSetupError('Please enter your called name.'); return }
    if (!pendingUser)    { setSetupError('Session error. Please log in again.'); return }

    setSetupSaving(true)
    try {
      await saveGateAnswers(pendingUser.uid, {
        q1: setupA1,
        q2: setupA2,
        q3: setupA3,
      })
      // Gate answers saved — go straight to dashboard
      setShowSetup(false)
      router.push('/')
    } catch {
      setSetupError('Failed to save. Please try again.')
    } finally {
      setSetupSaving(false)
    }
  }

  // ── Step 2b: Gate verification (returning superadmin) ──────────────────────
  async function handleGateSubmit() {
    if (!pendingUser?.gateAnswers) return
    const { q1, q2, q3 } = pendingUser.gateAnswers
    let err = ''
    if (normalize(gateA1) !== q1) err = 'Incorrect answer for Question 1.'
    else if (gateA2.trim() !== q2) err = 'Incorrect phone number.'
    else if (normalize(gateA3) !== q3) err = 'Incorrect called name.'

    if (err) {
      const attempts = gateAttempts + 1
      setGateAttempts(attempts)
      if (attempts >= 3) {
        setGateError('Too many wrong attempts. Access denied.')
        await crmSignOut()
        setTimeout(() => {
          setShowGate(false); setPendingUser(null)
          setGateA1(''); setGateA2(''); setGateA3('')
          setGateAttempts(0); setGateError('')
        }, 2500)
      } else {
        setGateError(`${err} (${3 - attempts} attempt${3 - attempts === 1 ? '' : 's'} left)`)
      }
      return
    }
    setShowGate(false)
    router.push('/')
  }

  async function handleCancel() {
    await crmSignOut()
    setShowGate(false); setShowSetup(false); setPendingUser(null)
    setGateA1(''); setGateA2(''); setGateA3(''); setGateError('')
    setSetupA1(''); setSetupA2(''); setSetupA3(''); setSetupError('')
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

  // ── First-time gate setup ──────────────────────────────────────────────────
  if (showSetup) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-yellow-500/10 border border-yellow-500/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">🛡️</span>
            </div>
            <h1 className="text-2xl font-black text-white">Set Your Security Gate</h1>
            <p className="text-slate-400 text-sm mt-1">
              You'll be asked these every time you log in as SuperAdmin.
            </p>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-5">
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg px-4 py-3">
              <p className="text-blue-300 text-xs">
                These answers are personal to you. Choose something only you know. They can't be recovered — remember them!
              </p>
            </div>

            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">
                1. Your Full Name
              </label>
              <input
                autoFocus
                type="text"
                value={setupA1}
                onChange={(e) => setSetupA1(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && document.getElementById('setupA2')?.focus()}
                placeholder="e.g. Soumya Ranjan Singh"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">
                2. Your Phone Number
              </label>
              <input
                id="setupA2"
                type="text"
                value={setupA2}
                onChange={(e) => setSetupA2(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && document.getElementById('setupA3')?.focus()}
                placeholder="e.g. 8908641811"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
              />
            </div>

            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">
                3. Your Called Name (Nickname)
              </label>
              <input
                id="setupA3"
                type="text"
                value={setupA3}
                onChange={(e) => setSetupA3(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSetupSubmit()}
                placeholder="e.g. kanha"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
              />
            </div>

            {setupError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
                <p className="text-red-400 text-sm">{setupError}</p>
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <button
                onClick={handleCancel}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-lg px-4 py-3 text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSetupSubmit}
                disabled={setupSaving || !setupA1.trim() || !setupA2.trim() || !setupA3.trim()}
                className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/50 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-3 text-sm transition-colors flex items-center justify-center gap-2"
              >
                {setupSaving ? (
                  <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving…</>
                ) : (
                  'Save & Enter CRM'
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── Security Gate (returning superadmin) ───────────────────────────────────
  if (showGate) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-pink-500/10 border border-pink-500/30 rounded-full flex items-center justify-center mx-auto mb-4">
              <span className="text-2xl">🔐</span>
            </div>
            <h1 className="text-2xl font-black text-white">Identity Verification</h1>
            <p className="text-slate-400 text-sm mt-1">Answer all three questions to continue</p>
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl space-y-5">
            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">
                1. Who are you?
              </label>
              <input
                autoFocus
                type="text"
                value={gateA1}
                onChange={(e) => setGateA1(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && document.getElementById('gateA2')?.focus()}
                placeholder="Full name"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">
                2. What is your phone number?
              </label>
              <input
                id="gateA2"
                type="text"
                value={gateA2}
                onChange={(e) => setGateA2(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && document.getElementById('gateA3')?.focus()}
                placeholder="10-digit mobile"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide">
                3. What is your called name?
              </label>
              <input
                id="gateA3"
                type="text"
                value={gateA3}
                onChange={(e) => setGateA3(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleGateSubmit()}
                placeholder="Nickname / called name"
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white placeholder-slate-500 text-sm focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 transition-colors"
              />
            </div>

            {gateError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
                <p className="text-red-400 text-sm">{gateError}</p>
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <button
                onClick={handleCancel}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-lg px-4 py-3 text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleGateSubmit}
                disabled={!gateA1.trim() || !gateA2.trim() || !gateA3.trim()}
                className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/50 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-3 text-sm transition-colors"
              >
                Verify
              </button>
            </div>
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
                    onChange={(e) => setForgotEmail(e.target.value)}
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
