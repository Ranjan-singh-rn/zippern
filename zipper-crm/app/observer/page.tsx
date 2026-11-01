'use client'

/**
 * Observer sign-in.
 *
 * No password exists for this account. Each sign-in emails a one-time code to
 * a mailbox that is deliberately not the observer's own address, so holding the
 * account is not enough to get in.
 *
 * ── Second step: an authenticator code (B3) ─────────────────────────────────
 *
 * After the emailed code the Observer is asked for a TOTP code, exactly as an
 * Owner is on /login — enrolment on the first sign-in (setup key + recovery
 * codes shown once), a six-digit code every time after. The API enforces it
 * on the same `/auth/mfa/*` routes the Owner uses (the identity is the
 * session's role; `services/owner_mfa.py`); this screen only drives the steps.
 *
 * The backend revision serving production today has no such routes. A 404
 * from the status call is read as "not available yet" (`lib/mfaAvailability`):
 * the Observer proceeds on the emailed code alone, as before, after a notice
 * that says so. Any other failure blocks, as it does for an Owner.
 */

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, Loader2, Mail, ShieldCheck, ArrowLeft, AlertTriangle, KeyRound } from 'lucide-react'
import api, { ApiError, type OwnerMfaEnrolment } from '@/lib/api'
import { useAuth } from '@/components/AuthProvider'
import { OBSERVER_MFA_UNAVAILABLE_NOTICE, mfaUnavailable } from '@/lib/mfaAvailability'

type Step =
  | 'request' | 'verify'
  /** Checking `/auth/observer/mfa/status` after the emailed code. */
  | 'totp_loading'
  /** First sign-in: show the setup key, take the first code. */
  | 'totp_enrol'
  /** Every later sign-in: a code from the app, or a recovery code. */
  | 'totp_verify'
  /** Recovery codes, shown once after enrolment. */
  | 'totp_codes'
  /** The server has no authenticator step yet — said, then proceed. */
  | 'totp_unavailable'
  /** The second step could not be started or passed. */
  | 'totp_blocked'
  | 'done'

export default function ObserverSignIn() {
  const router = useRouter()
  const { refreshApiUser } = useAuth()
  const [step, setStep] = useState<Step>('request')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sentTo, setSentTo] = useState('')
  const [code, setCode] = useState('')
  const [secondsLeft, setSecondsLeft] = useState(0)
  const codeInput = useRef<HTMLInputElement>(null)

  // ── The authenticator step ────────────────────────────────────────────────
  const [enrolment, setEnrolment] = useState<OwnerMfaEnrolment | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [useRecovery, setUseRecovery] = useState(false)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [lockedUntil, setLockedUntil] = useState('')

  useEffect(() => {
    if (secondsLeft <= 0) return
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [secondsLeft])

  useEffect(() => {
    if (step === 'verify') codeInput.current?.focus()
  }, [step])

  async function requestCode() {
    setBusy(true)
    setError('')
    try {
      const res = await api.auth.requestObserverCode()
      setSentTo(res.sent_to)
      setSecondsLeft(res.expires_in_minutes * 60)
      setStep('verify')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send a code.')
    } finally {
      setBusy(false)
    }
  }

  /** Into the business view. The session is already in storage. */
  async function enter() {
    // Tell the provider the session exists BEFORE navigating. It resolved the
    // identity once on mount, when there was no token yet, and the navigation
    // below is client-side — so nothing would re-read it and the observer
    // would arrive authenticated but anonymous, and be bounced to /login.
    await refreshApiUser()
    setStep('done')
    // '/' is the staff dashboard and is not one of the observer's routes —
    // landing there produced "Not available to the observer" immediately
    // after a successful sign-in. Waiting on you is their actual home.
    setTimeout(() => router.push('/inbox'), 600)
  }

  /** Where does the Observer stand on the authenticator step? */
  async function beginTotp() {
    setStep('totp_loading')
    setError('')
    setTotpCode('')
    setUseRecovery(false)
    try {
      let st
      try {
        st = await api.auth.observerMfaStatus()
      } catch (e) {
        // The backend has no `/auth/mfa/*` yet: not a failed sign-in.
        // Proceed as before, after saying so.
        if (mfaUnavailable(e)) { setStep('totp_unavailable'); return }
        throw e
      }
      if (st.verified) { await enter(); return }
      if (st.configured === false) {
        setError('The authenticator step is not configured on the server yet. Ask whoever runs the deployment.')
        setStep('totp_blocked')
        return
      }
      setLockedUntil(st.locked_until ?? '')
      if (st.enrolled) {
        setStep('totp_verify')
      } else {
        setEnrolment(await api.auth.observerMfaEnrolStart())
        setStep('totp_enrol')
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the authenticator step.')
      setStep('totp_blocked')
    }
  }

  async function verify() {
    if (code.trim().length < 4) return
    setBusy(true)
    setError('')
    try {
      await api.auth.verifyObserverCode(code.trim())
      await beginTotp()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify the code.')
      setCode('')
      codeInput.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  async function confirmEnrolment() {
    setBusy(true)
    setError('')
    try {
      const { recoveryCodes: codes } = await api.auth.observerMfaEnrolConfirm(totpCode.trim())
      setRecoveryCodes(codes)
      setTotpCode('')
      setStep('totp_codes')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check the code. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function verifyTotp() {
    setBusy(true)
    setError('')
    try {
      await api.auth.observerMfaVerify(useRecovery ? { recoveryCode: totpCode.trim() } : { code: totpCode.trim() })
      await enter()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not check the code. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function cancelTotp() {
    await api.auth.signOut().catch(() => undefined)
    setStep('request')
    setCode('')
    setTotpCode('')
    setEnrolment(null)
    setRecoveryCodes([])
    setError('')
  }

  const mins = Math.floor(secondsLeft / 60)
  const secs = secondsLeft % 60
  const inTotp = step.startsWith('totp_')

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 mb-4">
            {inTotp ? <KeyRound size={24} className="text-slate-300" /> : <Eye size={24} className="text-slate-300" />}
          </div>
          <h1 className="text-2xl font-bold text-white">
            {step === 'totp_enrol' ? 'Set up your authenticator'
              : step === 'totp_codes' ? 'Save your recovery codes'
              : step === 'totp_verify' ? 'Authenticator code'
              : step === 'totp_unavailable' ? 'Signed in — without a second step'
              : step === 'totp_blocked' ? 'Cannot finish signing in'
              : 'Observer access'}
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            {inTotp ? 'Step 2 of 2' : 'Read-only view of the whole business'}
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          {step === 'request' && (
            <>
              <p className="text-slate-300 text-sm leading-relaxed">
                There is no password on this account. A one-time code is sent for
                every sign-in, to a separate mailbox — and then a code from your
                authenticator app.
              </p>
              <button
                onClick={requestCode}
                disabled={busy}
                className="mt-6 w-full flex items-center justify-center gap-2 bg-white hover:bg-slate-100 disabled:bg-slate-700 disabled:text-slate-400 text-slate-900 font-semibold rounded-xl px-4 py-3 text-sm transition-colors"
              >
                {busy ? (
                  <><Loader2 size={16} className="animate-spin" /> Sending…</>
                ) : (
                  <><Mail size={16} /> Send me a sign-in code</>
                )}
              </button>
            </>
          )}

          {step === 'verify' && (
            <>
              <div className="flex items-start gap-3 bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3 mb-5">
                <Mail size={16} className="text-slate-400 mt-0.5 shrink-0" />
                <div className="text-sm">
                  <p className="text-slate-200">Code sent to {sentTo}</p>
                  {secondsLeft > 0 && (
                    <p className="text-slate-500 text-xs mt-0.5">
                      Expires in {mins}:{String(secs).padStart(2, '0')}
                    </p>
                  )}
                </div>
              </div>

              <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                Six-digit code
              </label>
              <input
                ref={codeInput}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => e.key === 'Enter' && verify()}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white text-center text-2xl tracking-[0.4em] font-mono placeholder-slate-600 focus:outline-none focus:border-slate-500"
              />

              <button
                onClick={verify}
                disabled={busy || code.length < 4}
                className="mt-4 w-full flex items-center justify-center gap-2 bg-white hover:bg-slate-100 disabled:bg-slate-700 disabled:text-slate-400 text-slate-900 font-semibold rounded-xl px-4 py-3 text-sm transition-colors"
              >
                {busy ? (
                  <><Loader2 size={16} className="animate-spin" /> Checking…</>
                ) : (
                  <><ShieldCheck size={16} /> Continue</>
                )}
              </button>

              <button
                onClick={() => { setStep('request'); setCode(''); setError('') }}
                className="mt-3 w-full flex items-center justify-center gap-1.5 text-slate-500 hover:text-slate-300 text-xs transition-colors"
              >
                <ArrowLeft size={13} /> Request a new code
              </button>
            </>
          )}

          {step === 'totp_loading' && (
            <div className="flex justify-center py-4">
              <Loader2 size={24} className="animate-spin text-slate-400" />
            </div>
          )}

          {step === 'totp_unavailable' && (
            <>
              <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
                <AlertTriangle size={15} className="text-amber-300 mt-0.5 shrink-0" />
                <p className="text-amber-200 text-sm leading-relaxed">{OBSERVER_MFA_UNAVAILABLE_NOTICE}</p>
              </div>
              <button
                onClick={() => { void enter() }}
                className="mt-5 w-full flex items-center justify-center gap-2 bg-white hover:bg-slate-100 text-slate-900 font-semibold rounded-xl px-4 py-3 text-sm transition-colors"
              >
                <ShieldCheck size={16} /> Continue
              </button>
            </>
          )}

          {step === 'totp_enrol' && enrolment && (
            <>
              <p className="text-slate-300 text-sm">
                From now on the Observer needs a code from an authenticator app (Google
                Authenticator, Microsoft Authenticator, 1Password…) after the emailed code.
              </p>
              <ol className="text-slate-400 text-sm list-decimal pl-5 space-y-1 mt-3">
                <li>In the app, add an account and choose <b>enter a setup key</b>.</li>
                <li>Type the key below (time-based, 6 digits).</li>
                <li>Enter the 6-digit code the app shows.</li>
              </ol>
              <div className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 mt-4">
                <p className="text-slate-500 text-xs uppercase tracking-wide mb-1">Setup key</p>
                <p className="text-white font-mono text-sm break-all select-all">
                  {enrolment.secret.replace(/(.{4})/g, '$1 ').trim()}
                </p>
              </div>
              <a href={enrolment.otpauth_uri} className="block text-slate-400 hover:text-white text-xs underline mt-2">
                On this phone? Open in your authenticator app
              </a>
            </>
          )}

          {step === 'totp_codes' && (
            <>
              <p className="text-slate-300 text-sm">
                Each code signs you in once if you lose your phone. They are shown only now —
                keep them somewhere safe, away from this computer.
              </p>
              <div className="grid grid-cols-2 gap-2 bg-slate-800 border border-slate-700 rounded-xl p-4 font-mono text-sm text-white select-all mt-4">
                {recoveryCodes.map((c) => <span key={c}>{c}</span>)}
              </div>
              <button
                onClick={() => { setRecoveryCodes([]); void enter() }}
                className="mt-5 w-full bg-white hover:bg-slate-100 text-slate-900 font-semibold rounded-xl px-4 py-3 text-sm transition-colors"
              >
                I have saved them — open the business view
              </button>
            </>
          )}

          {(step === 'totp_enrol' || step === 'totp_verify') && (
            <div className="mt-4">
              {lockedUntil && step === 'totp_verify' && (
                <p className="text-amber-300 text-xs mb-2">
                  Too many wrong codes. Try again after {new Date(lockedUntil).toLocaleTimeString()}.
                </p>
              )}
              <label className="block text-slate-400 text-xs font-medium uppercase tracking-wide mb-2">
                {useRecovery ? 'Recovery code' : 'Code from your authenticator app'}
              </label>
              <input
                autoFocus
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (step === 'totp_enrol' ? confirmEnrolment() : verifyTotp())}
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                placeholder={useRecovery ? 'xxxxx-xxxxx' : '123456'}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-4 py-3 text-white text-center text-2xl tracking-[0.4em] font-mono placeholder-slate-600 focus:outline-none focus:border-slate-500"
              />
              {step === 'totp_verify' && (
                <button
                  type="button"
                  onClick={() => { setUseRecovery((v) => !v); setTotpCode(''); setError('') }}
                  className="mt-2 text-xs text-slate-400 hover:text-white underline"
                >
                  {useRecovery ? 'Use the authenticator app instead' : 'Lost your phone? Use a recovery code'}
                </button>
              )}
              <button
                onClick={step === 'totp_enrol' ? confirmEnrolment : verifyTotp}
                disabled={busy || totpCode.trim().length < 6}
                className="mt-4 w-full flex items-center justify-center gap-2 bg-white hover:bg-slate-100 disabled:bg-slate-700 disabled:text-slate-400 text-slate-900 font-semibold rounded-xl px-4 py-3 text-sm transition-colors"
              >
                {busy ? (
                  <><Loader2 size={16} className="animate-spin" /> Checking…</>
                ) : (
                  <><ShieldCheck size={16} /> {step === 'totp_enrol' ? 'Turn on & sign in' : 'Sign in'}</>
                )}
              </button>
            </div>
          )}

          {(step === 'totp_enrol' || step === 'totp_verify' || step === 'totp_blocked') && (
            <button
              onClick={cancelTotp}
              className="mt-3 w-full flex items-center justify-center gap-1.5 text-slate-500 hover:text-slate-300 text-xs transition-colors"
            >
              <ArrowLeft size={13} /> {step === 'totp_blocked' ? 'Sign out and start again' : 'Cancel'}
            </button>
          )}

          {step === 'done' && (
            <div className="text-center py-4">
              <ShieldCheck size={32} className="text-green-400 mx-auto mb-3" />
              <p className="text-white font-medium">Signed in</p>
              <p className="text-slate-400 text-sm mt-1">Opening the business view…</p>
            </div>
          )}

          {error && (
            <div className="mt-4 flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3">
              <AlertTriangle size={15} className="text-red-400 mt-0.5 shrink-0" />
              <p className="text-red-300 text-sm">{error}</p>
            </div>
          )}
        </div>

        <p className="text-center text-slate-600 text-xs mt-6">
          Staff and owners sign in{' '}
          <button onClick={() => router.push('/login')} className="text-slate-400 hover:text-white underline underline-offset-2">
            here
          </button>
        </p>
      </div>
    </div>
  )
}
