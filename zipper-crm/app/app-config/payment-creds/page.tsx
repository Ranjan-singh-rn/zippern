'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { getPaymentCredentials, savePaymentCredentials, type PaymentCredentials } from '@/lib/appConfig'
import { Loader2, Save, AlertTriangle, CheckCircle, Eye, EyeOff, ShieldAlert, FileQuestion } from 'lucide-react'

const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500'
const labelCls = 'block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide'

/**
 * The blank form.
 *
 * This screen edits `appConfig/paymentCredentials`, which is where the real
 * account lives — superadmin-write, authenticated-read. It used to open with
 * the live IFSC, account number, holder name and Binance UID written into this
 * file as `DEFAULTS`, which put the account into every shipped bundle and made
 * an unconfigured document indistinguishable from a configured one. The form
 * starts empty and shows what it actually found.
 */
const EMPTY: Omit<PaymentCredentials, 'updatedAt'> = {
  binanceUid:  '',
  bankName:    '',
  bankIfsc:    '',
  bankAccount: '',
  bankHolder:  '',
  bankBranch:  '',
}

export default function PaymentCredsPage() {
  const { crmUser } = useAuth()
  const router = useRouter()

  const [form, setForm] = useState<Omit<PaymentCredentials, 'updatedAt'>>(EMPTY)
  const [loading, setSaving_]  = useState(true)
  const [saving,  setSaving]   = useState(false)
  const [saved,   setSaved]    = useState(false)
  const [showAccount, setShowAccount] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Did the document exist? Null until the read finishes. */
  const [configured, setConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, ['superadmin'])) { router.push('/'); return }
    getPaymentCredentials().then(data => {
      if (data) {
        const { updatedAt: _updatedAt, ...rest } = data
        setForm({ ...EMPTY, ...rest })
        setConfigured(true)
      } else {
        // No document. The fields below are blank because nothing has ever been
        // saved — not because something was lost.
        setConfigured(false)
      }
    }).catch(err => {
      setLoadError(
        err instanceof Error
          ? `The saved credentials could not be read: ${err.message}. The fields below are blank because nothing was loaded — do not save over the live account from this state.`
          : 'The saved credentials could not be read. The fields below are blank because nothing was loaded — do not save over the live account from this state.',
      )
    }).finally(() => setSaving_(false))
  }, [crmUser, router])

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSave() {
    setSaving(true); setSaved(false); setSaveError(null)
    try {
      await savePaymentCredentials(form)
      setSaved(true)
      setConfigured(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e) {
      setSaveError(
        e instanceof Error
          ? `Nothing was saved: ${e.message}`
          : 'Nothing was saved and no reason was given. The app is still using whatever was there before.',
      )
    } finally { setSaving(false) }
  }

  if (!crmUser || !canAccess(crmUser, ['superadmin'])) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-slate-400">Access denied.</p>
      </div>
    )
  }

  if (loading) return (
    <div className="flex items-center justify-center py-32">
      <Loader2 size={28} className="text-pink-500 animate-spin" />
    </div>
  )

  return (
    <div className="max-w-2xl mx-auto">
      {loadError && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 mb-4 text-sm">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <span className="leading-relaxed">{loadError}</span>
        </div>
      )}

      {configured === false && !loadError && (
        <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mb-4">
          <FileQuestion size={17} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="text-amber-200 font-medium">
              No payment credentials have been configured yet
            </p>
            <p className="text-amber-100/80 mt-0.5 leading-relaxed">
              <code className="text-amber-200">appConfig/paymentCredentials</code> does
              not exist, so the fields below are blank because nothing has been saved —
              nothing has been lost. Until this is filled in and saved, the app tells
              sellers that payment details are unavailable and no purchase can be made.
            </p>
          </div>
        </div>
      )}
      {/* Warning banner */}
      <div className="flex items-start gap-3 bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3 mb-6">
        <ShieldAlert size={18} className="text-blue-400 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="text-blue-300 font-semibold mb-0.5">Android reads these from Firestore</p>
          <p className="text-blue-400/80">Changes saved here take effect immediately in the app. Credentials are stored at <code className="text-blue-300">appConfig/paymentCredentials</code> and loaded dynamically — no APK update needed. This document is the only source: the app ships with no built-in account details, so if it is empty the buy screen tells sellers the payment details are unavailable rather than showing a partial account number.</p>
        </div>
      </div>

      <h1 className="text-2xl font-bold text-white mb-1">Payment Credentials</h1>
      <p className="text-slate-400 text-sm mb-6">Bank account and Binance UID shown to sellers when they purchase coins. Changing these takes effect immediately once the app reads from Firestore.</p>

      {/* Binance */}
      <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 mb-4">
        <h2 className="text-white font-semibold text-sm mb-4 flex items-center gap-2">
          🪙 Binance (International)
        </h2>
        <div>
          <label className={labelCls}>Binance UID</label>
          <input value={form.binanceUid} onChange={set('binanceUid')} className={inputCls}
            placeholder="Numeric Binance user id" />
        </div>
      </div>

      {/* Bank */}
      <div className="bg-slate-800 border border-slate-700 rounded-2xl p-6 mb-6">
        <h2 className="text-white font-semibold text-sm mb-4 flex items-center gap-2">
          🏦 Bank Account (India)
        </h2>
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Bank Name</label>
              <input value={form.bankName} onChange={set('bankName')} className={inputCls} placeholder="Bank name" />
            </div>
            <div>
              <label className={labelCls}>IFSC Code</label>
              <input value={form.bankIfsc} onChange={set('bankIfsc')} className={inputCls} placeholder="11-character IFSC" />
            </div>
          </div>

          <div>
            <label className={labelCls}>Account Holder Name</label>
            <input value={form.bankHolder} onChange={set('bankHolder')} className={inputCls} placeholder="Full name as on account" />
          </div>

          <div>
            <label className={labelCls}>Account Number</label>
            <div className="relative">
              <input
                type={showAccount ? 'text' : 'password'}
                value={form.bankAccount}
                onChange={set('bankAccount')}
                className={inputCls + ' pr-10'}
                placeholder="Account number"
              />
              <button
                type="button"
                onClick={() => setShowAccount(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
              >
                {showAccount ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          <div>
            <label className={labelCls}>Branch</label>
            <input value={form.bankBranch} onChange={set('bankBranch')} className={inputCls} placeholder="Branch name + city" />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-xl font-semibold text-sm transition-colors"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save Credentials
        </button>
        {saved && (
          <span className="flex items-center gap-1.5 text-green-400 text-sm font-medium">
            <CheckCircle size={14} /> Saved successfully
          </span>
        )}
      </div>

      {saveError && (
        <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 mt-4 text-sm">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <span className="leading-relaxed">{saveError}</span>
        </div>
      )}
    </div>
  )
}
