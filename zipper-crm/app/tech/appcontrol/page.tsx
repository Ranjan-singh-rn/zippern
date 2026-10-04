'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { submitApproval } from '@/lib/approvals'
import {
  Save, Loader2, ToggleLeft, ToggleRight, AlertTriangle, CheckCircle,
  Smartphone, Shield, Zap, Info,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FeatureFlag {
  key: string
  label: string
  description: string
  enabled: boolean
}

interface AppControlConfig {
  maintenanceMode: boolean
  maintenanceMessage: string
  forceUpdate: boolean
  minVersion: string
  featureFlags: FeatureFlag[]
  updatedAt?: { seconds: number }
  updatedBy?: string
}

const DEFAULT_FLAGS: Omit<FeatureFlag, 'enabled'>[] = [
  { key: 'live_streaming',   label: 'Live Streaming',      description: 'Allow hosts to go live' },
  { key: 'voice_calls',      label: 'Voice Calls',          description: 'P2P voice call feature' },
  { key: 'gifts',            label: 'Gift Sending',          description: 'Users can send gifts to hosts' },
  { key: 'lucky_gifts',      label: 'Lucky Gifts',          description: 'Random bonus gifts pool' },
  { key: 'leaderboard',      label: 'Leaderboard',          description: 'Public ranking board' },
  { key: 'coin_shop',        label: 'Coin Shop',            description: 'In-app coin purchase' },
  { key: 'bean_withdrawal',  label: 'Bean Withdrawal',      description: 'Hosts can request payouts' },
  { key: 'referrals',        label: 'Referral Program',     description: 'Invite friends for rewards' },
  { key: 'events',           label: 'Events',               description: 'In-app event system' },
  { key: 'agency_portal',    label: 'Agency Portal',        description: 'Agency management features' },
]

const DEFAULT_CONFIG: AppControlConfig = {
  maintenanceMode: false,
  maintenanceMessage: 'The app is temporarily down for maintenance. We\'ll be back shortly.',
  forceUpdate: false,
  minVersion: '1.0.0',
  featureFlags: DEFAULT_FLAGS.map(f => ({ ...f, enabled: true })),
}

const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500'
const labelCls = 'text-slate-400 text-xs mb-1 block'

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AppControlPage() {
  const { crmUser } = useAuth()
  const router = useRouter()
  const isSA = crmUser?.role === 'superadmin'

  const [config, setConfig] = useState<AppControlConfig>(DEFAULT_CONFIG)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err' | 'pending'; text: string } | null>(null)

  useEffect(() => {
    if (!canAccess(crmUser, ['superadmin', 'tech_admin', 'tech_member'])) {
      router.push('/')
      return
    }
    getDoc(doc(db, 'appConfig', 'control')).then(snap => {
      if (snap.exists()) {
        const data = snap.data() as AppControlConfig
        // Merge any new default flags not yet in Firestore
        const storedKeys = new Set((data.featureFlags ?? []).map((f: FeatureFlag) => f.key))
        const merged = [
          ...(data.featureFlags ?? []),
          ...DEFAULT_FLAGS.filter(f => !storedKeys.has(f.key)).map(f => ({ ...f, enabled: true })),
        ]
        setConfig({ ...DEFAULT_CONFIG, ...data, featureFlags: merged })
      }
      setLoading(false)
    })
  }, [crmUser])

  function setFlag(key: string, enabled: boolean) {
    setConfig(c => ({
      ...c,
      featureFlags: c.featureFlags.map(f => f.key === key ? { ...f, enabled } : f),
    }))
  }

  async function handleSave() {
    if (!crmUser) return
    setSaving(true)
    setMsg(null)
    try {
      if (isSA) {
        await setDoc(doc(db, 'appConfig', 'control'), {
          ...config,
          updatedAt: serverTimestamp(),
          updatedBy: crmUser.name,
        })
        setMsg({ type: 'ok', text: 'App control settings saved.' })
      } else {
        await submitApproval({
          type: 'update_config',
          description: 'Update app control settings (maintenance mode, force update, feature flags)',
          targetLabel: 'App Control Config',
          targetCollection: 'appConfig',
          targetDocId: 'control',
          operation: 'update',
          payload: config as unknown as Record<string, unknown>,
          requestedBy: { uid: crmUser.uid, name: crmUser.name, role: crmUser.role },
        })
        setMsg({ type: 'pending', text: 'Change submitted — awaiting superadmin approval.' })
      }
    } catch (e: unknown) {
      setMsg({ type: 'err', text: e instanceof Error ? e.message : 'Failed to save.' })
    } finally {
      setSaving(false)
      setTimeout(() => setMsg(null), 5000)
    }
  }

  if (loading) return (
    <div className="flex justify-center py-20">
      <div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
    </div>
  )

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">App Control</h1>
        <p className="text-slate-400 text-sm mt-1">
          {isSA ? 'Changes apply immediately.' : 'Changes require superadmin approval.'}
        </p>
      </div>

      {msg && (
        <div className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm ${
          msg.type === 'ok'      ? 'bg-green-500/10 border border-green-500/20 text-green-300' :
          msg.type === 'pending' ? 'bg-yellow-500/10 border border-yellow-500/20 text-yellow-300' :
                                   'bg-red-500/10 border border-red-500/20 text-red-300'
        }`}>
          {msg.type === 'ok' ? <CheckCircle size={15} /> : <AlertTriangle size={15} />}
          {msg.text}
        </div>
      )}

      {/* ── Maintenance Mode ── */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
        <div className="flex items-center gap-3">
          <Shield size={20} className={config.maintenanceMode ? 'text-red-400' : 'text-slate-500'} />
          <div className="flex-1">
            <h2 className="text-white font-semibold">Maintenance Mode</h2>
            <p className="text-slate-500 text-xs mt-0.5">When on, all users see the maintenance screen and cannot use the app.</p>
          </div>
          <button
            onClick={() => setConfig(c => ({ ...c, maintenanceMode: !c.maintenanceMode }))}
            className="shrink-0"
          >
            {config.maintenanceMode
              ? <ToggleRight size={28} className="text-red-400" />
              : <ToggleLeft size={28} className="text-slate-600" />
            }
          </button>
        </div>
        {config.maintenanceMode && (
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 text-xs text-red-300 flex items-center gap-2">
            <AlertTriangle size={13} />
            Maintenance mode is ON — the app is inaccessible to all users right now.
          </div>
        )}
        <div>
          <label className={labelCls}>Maintenance Message (shown to users)</label>
          <textarea
            value={config.maintenanceMessage}
            onChange={e => setConfig(c => ({ ...c, maintenanceMessage: e.target.value }))}
            rows={2}
            className={inputCls}
          />
        </div>
      </div>

      {/* ── Force Update ── */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
        <div className="flex items-center gap-3">
          <Smartphone size={20} className={config.forceUpdate ? 'text-yellow-400' : 'text-slate-500'} />
          <div className="flex-1">
            <h2 className="text-white font-semibold">Force Update</h2>
            <p className="text-slate-500 text-xs mt-0.5">Users on versions below the minimum will be forced to update before they can use the app.</p>
          </div>
          <button
            onClick={() => setConfig(c => ({ ...c, forceUpdate: !c.forceUpdate }))}
            className="shrink-0"
          >
            {config.forceUpdate
              ? <ToggleRight size={28} className="text-yellow-400" />
              : <ToggleLeft size={28} className="text-slate-600" />
            }
          </button>
        </div>
        <div>
          <label className={labelCls}>Minimum Required Version</label>
          <input
            type="text"
            value={config.minVersion}
            onChange={e => setConfig(c => ({ ...c, minVersion: e.target.value }))}
            placeholder="e.g. 2.4.1"
            className={inputCls}
          />
          <p className="text-slate-600 text-xs mt-1 flex items-center gap-1">
            <Info size={11} />
            Users on this version or higher are unaffected. Use semantic versioning (major.minor.patch).
          </p>
        </div>
      </div>

      {/* ── Feature Flags ── */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Zap size={20} className="text-pink-400" />
          <div>
            <h2 className="text-white font-semibold">Feature Flags</h2>
            <p className="text-slate-500 text-xs mt-0.5">Toggle individual app features without a release. Disabled features are hidden or blocked in the app.</p>
          </div>
        </div>
        <div className="divide-y divide-slate-800">
          {config.featureFlags.map(flag => (
            <div key={flag.key} className="flex items-center gap-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-medium">{flag.label}</p>
                <p className="text-slate-500 text-xs mt-0.5">{flag.description}</p>
              </div>
              <button
                onClick={() => setFlag(flag.key, !flag.enabled)}
                className="shrink-0"
              >
                {flag.enabled
                  ? <ToggleRight size={24} className="text-green-400" />
                  : <ToggleLeft size={24} className="text-slate-600" />
                }
              </button>
              <span className={`text-xs font-medium w-14 text-right ${flag.enabled ? 'text-green-400' : 'text-slate-500'}`}>
                {flag.enabled ? 'ON' : 'OFF'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Save ── */}
      {config.updatedBy && (
        <p className="text-slate-600 text-xs text-right">
          Last updated by {config.updatedBy}
          {config.updatedAt ? ` · ${new Date(config.updatedAt.seconds * 1000).toLocaleDateString('en-IN')}` : ''}
        </p>
      )}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-6 py-2.5 bg-pink-500 hover:bg-pink-400 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-colors"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          {isSA ? 'Save Changes' : 'Submit for Approval'}
        </button>
      </div>
    </div>
  )
}
