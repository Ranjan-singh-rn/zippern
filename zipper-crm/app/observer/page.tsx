'use client'

/**
 * Observer sign-in.
 *
 * No password exists for this account. Each sign-in emails a one-time code to
 * a mailbox that is deliberately not the observer's own address, so holding the
 * account is not enough to get in.
 */

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Eye, Loader2, Mail, ShieldCheck, ArrowLeft, AlertTriangle } from 'lucide-react'
import api, { ApiError } from '@/lib/api'
import { useAuth } from '@/components/AuthProvider'

type Step = 'request' | 'verify' | 'done'

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

  async function verify() {
    if (code.trim().length < 4) return
    setBusy(true)
    setError('')
    try {
      await api.auth.verifyObserverCode(code.trim())

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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify the code.')
      setCode('')
      codeInput.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  const mins = Math.floor(secondsLeft / 60)
  const secs = secondsLeft % 60

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-slate-800 border border-slate-700 mb-4">
            <Eye size={24} className="text-slate-300" />
          </div>
          <h1 className="text-2xl font-bold text-white">Observer access</h1>
          <p className="text-slate-400 text-sm mt-1">
            Read-only view of the whole business
          </p>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6">
          {step === 'request' && (
            <>
              <p className="text-slate-300 text-sm leading-relaxed">
                There is no password on this account. A one-time code is sent for
                every sign-in, to a separate mailbox.
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
                  <><ShieldCheck size={16} /> Sign in</>
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
