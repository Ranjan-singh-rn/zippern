'use client'

/**
 * Decision 15 (RC) — the waiting room's verification steps.
 *
 * The Owner approved this partner's role while the login did not yet hold BOTH
 * a verified phone and a verified email. The role waits, granting nothing, and
 * starts by itself once both are verified. This panel is where the person does
 * that, on their OWN login:
 *
 *   * EMAIL — a 6-digit code mailed by our server to the address already on
 *     this login (`requestLoginEmailCode` / `verifyLoginEmailCode`). A
 *     credentials or password-reset email does not count; this code does.
 *   * PHONE — an SMS code from Firebase, linked to this login
 *     (`linkWithPhoneNumber`). A number that already belongs to ANOTHER Zipper
 *     account cannot be linked: the role stays inactive, our team is told
 *     (`/me/verification/conflict`), and nothing is merged.
 *
 * After each step the API is asked to check (`/me/verification/check`). It
 * re-reads both contacts itself — nothing here starts a role — and if the role
 * started, the page reloads so the new session carries it.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { getFunctions, httpsCallable } from 'firebase/functions'
import { RecaptchaVerifier, linkWithPhoneNumber, type ConfirmationResult } from 'firebase/auth'
import { CheckCircle2, Mail, Phone, ShieldAlert, Loader2 } from 'lucide-react'
import { app, auth } from '@/lib/firebase'
import { myVerification } from '@/lib/apiPartners'
import {
  missingPhrase, phoneE164, phoneLinkOutcome, startedAny,
  type VerificationOverview,
} from '@/lib/contactVerification'

function errorText(err: unknown, fallback: string): string {
  const m = (err as { message?: unknown })?.message
  return typeof m === 'string' && m.trim() !== '' ? m : fallback
}

export default function ContactVerificationPanel() {
  const [overview, setOverview] = useState<VerificationOverview | null>(null)
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<'' | 'email-send' | 'email-verify' | 'phone-send' | 'phone-verify' | 'check'>('')

  const [emailSent, setEmailSent] = useState(false)
  const [emailCode, setEmailCode] = useState('')
  const [emailError, setEmailError] = useState('')

  const [phoneInput, setPhoneInput] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [phoneError, setPhoneError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [smsSent, setSmsSent] = useState(false)
  const confirmation = useRef<ConfirmationResult | null>(null)
  const verifier = useRef<RecaptchaVerifier | null>(null)

  const load = useCallback(async () => {
    try {
      setOverview(await myVerification.get())
      setLoadError('')
    } catch (err) {
      setLoadError(errorText(err, 'Could not read your verification just now.'))
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => () => { verifier.current?.clear(); verifier.current = null }, [])

  /** Ask the API to re-read both contacts and start what they now allow. */
  const check = useCallback(async () => {
    setBusy('check')
    try {
      // A fresh ID token, so every reader sees the Auth record as it is now.
      await auth.currentUser?.getIdToken(true).catch(() => undefined)
      const out = await myVerification.check()
      setOverview(out)
      if (startedAny(out)) {
        setNotice('Your role has started. Opening your dashboard…')
        setTimeout(() => window.location.reload(), 1200)
      }
    } catch (err) {
      setNotice(errorText(err, 'Could not check just now. Try again in a minute.'))
    } finally {
      setBusy('')
    }
  }, [])

  // ── Email ────────────────────────────────────────────────────────────────
  const sendEmailCode = async () => {
    setBusy('email-send'); setEmailError('')
    try {
      await httpsCallable(getFunctions(app, 'asia-south1'), 'requestLoginEmailCode')({})
      setEmailSent(true)
    } catch (err) {
      setEmailError(errorText(err, 'We could not send the code just now.'))
    } finally {
      setBusy('')
    }
  }
  const verifyEmailCode = async () => {
    setBusy('email-verify'); setEmailError('')
    try {
      await httpsCallable(getFunctions(app, 'asia-south1'), 'verifyLoginEmailCode')({ code: emailCode.trim() })
      setEmailSent(false); setEmailCode('')
      await check()
    } catch (err) {
      setEmailError(errorText(err, 'That code could not be checked.'))
      setBusy('')
    }
  }

  // ── Phone ────────────────────────────────────────────────────────────────
  const sendSms = async () => {
    setPhoneError(''); setConflict(false)
    const e164 = phoneE164(phoneInput)
    if (!e164) { setPhoneError('Enter your mobile number, with the country code if it is not Indian.'); return }
    const user = auth.currentUser
    if (!user) { setPhoneError('Sign in again, then retry.'); return }
    setBusy('phone-send')
    try {
      if (!verifier.current) {
        verifier.current = new RecaptchaVerifier(auth, 'cv-recaptcha', { size: 'invisible' })
      }
      confirmation.current = await linkWithPhoneNumber(user, e164, verifier.current)
      setSmsSent(true)
    } catch (err) {
      await handlePhoneError(err, e164)
    } finally {
      setBusy('')
    }
  }
  const verifySms = async () => {
    const c = confirmation.current
    if (!c) return
    setBusy('phone-verify'); setPhoneError('')
    try {
      await c.confirm(smsCode.trim())
      confirmation.current = null; setSmsSent(false); setSmsCode('')
      await check()
    } catch (err) {
      await handlePhoneError(err, phoneE164(phoneInput))
      setBusy('')
    }
  }
  async function handlePhoneError(err: unknown, e164: string) {
    const outcome = phoneLinkOutcome((err as { code?: unknown })?.code)
    if (outcome === 'conflict') {
      setConflict(true)
      confirmation.current = null
      setSmsSent(false)
      // Staff are told; the answer is the same either way, and nothing merges.
      await myVerification.conflict('phone', e164).catch(() => undefined)
      return
    }
    if (outcome === 'already_linked') { await check(); return }
    setPhoneError({
      wrong_code: 'That code is not right. Check the SMS and try again.',
      expired: 'That code has expired. Ask for a new one.',
      too_many: 'Too many attempts. Wait a while, then try again.',
      invalid_number: 'That number is not valid.',
      other: errorText(err, 'We could not send the SMS just now.'),
      conflict: '', already_linked: '',
    }[outcome])
  }

  const v = overview?.verification
  return (
    <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-4">
      <div>
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Verify your contacts</p>
        <p className="text-slate-300 text-sm leading-relaxed mt-1">
          Your role has been approved. It starts once <strong className="text-white">both</strong> your
          phone number and your email address are verified on this login.
          {v && v.missing.length > 0 && <> Still needed: {missingPhrase(v.missing)}.</>}
        </p>
      </div>

      {loadError && <p className="text-red-400 text-sm">{loadError}</p>}

      {/* Email */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          {v?.email.verified
            ? <CheckCircle2 size={15} className="text-green-400" />
            : <Mail size={15} className="text-blue-400" />}
          <span className="text-slate-200">Email {v?.email.masked ? `(${v.email.masked})` : ''}</span>
          <span className={v?.email.verified ? 'text-green-400 text-xs' : 'text-slate-400 text-xs'}>
            {v?.email.verified ? 'verified' : 'not verified yet'}
          </span>
        </div>
        {v && !v.email.verified && (
          <div className="space-y-2">
            {!emailSent ? (
              <button onClick={sendEmailCode} disabled={busy !== ''}
                className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white disabled:opacity-50">
                {busy === 'email-send' ? <Loader2 size={14} className="animate-spin inline" /> : 'Email me a 6-digit code'}
              </button>
            ) : (
              <div className="flex gap-2">
                <input value={emailCode} onChange={(e) => setEmailCode(e.target.value)} inputMode="numeric"
                  maxLength={6} placeholder="6-digit code"
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                <button onClick={verifyEmailCode} disabled={busy !== '' || emailCode.trim().length !== 6}
                  className="px-3 py-2 bg-pink-600 hover:bg-pink-500 rounded-lg text-sm text-white disabled:opacity-50">
                  {busy === 'email-verify' ? <Loader2 size={14} className="animate-spin inline" /> : 'Verify'}
                </button>
              </div>
            )}
            {emailError && <p className="text-red-400 text-xs">{emailError}</p>}
          </div>
        )}
      </div>

      {/* Phone */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm">
          {v?.phone.verified
            ? <CheckCircle2 size={15} className="text-green-400" />
            : <Phone size={15} className="text-blue-400" />}
          <span className="text-slate-200">Phone {v?.phone.masked ? `(${v.phone.masked})` : ''}</span>
          <span className={v?.phone.verified ? 'text-green-400 text-xs' : 'text-slate-400 text-xs'}>
            {v?.phone.verified ? 'verified' : 'not verified yet'}
          </span>
        </div>
        {v && !v.phone.verified && !conflict && (
          <div className="space-y-2">
            {!smsSent ? (
              <div className="flex gap-2">
                <input value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} inputMode="tel"
                  placeholder="Mobile number"
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                <button onClick={sendSms} disabled={busy !== ''}
                  className="px-3 py-2 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm text-white disabled:opacity-50">
                  {busy === 'phone-send' ? <Loader2 size={14} className="animate-spin inline" /> : 'Send SMS code'}
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input value={smsCode} onChange={(e) => setSmsCode(e.target.value)} inputMode="numeric"
                  maxLength={6} placeholder="SMS code"
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                <button onClick={verifySms} disabled={busy !== '' || smsCode.trim().length < 6}
                  className="px-3 py-2 bg-pink-600 hover:bg-pink-500 rounded-lg text-sm text-white disabled:opacity-50">
                  {busy === 'phone-verify' ? <Loader2 size={14} className="animate-spin inline" /> : 'Verify'}
                </button>
              </div>
            )}
            {phoneError && <p className="text-red-400 text-xs">{phoneError}</p>}
          </div>
        )}
        {conflict && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
            <ShieldAlert size={15} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-red-200 text-xs leading-relaxed">
              This number already belongs to another Zipper account, so it cannot be added to this login. Your
              role stays inactive for now and our team has been told — they will contact you. Nothing was merged
              or changed on either account.
            </p>
          </div>
        )}
        <div id="cv-recaptcha" />
      </div>

      {v?.complete && (overview?.waiting.length ?? 0) > 0 && (
        <button onClick={check} disabled={busy !== ''}
          className="w-full px-4 py-2.5 bg-pink-600 hover:bg-pink-500 rounded-lg text-sm font-medium text-white disabled:opacity-50">
          {busy === 'check' ? <Loader2 size={14} className="animate-spin inline" /> : 'Start my role'}
        </button>
      )}
      {notice && <p className="text-slate-300 text-sm">{notice}</p>}
    </div>
  )
}
