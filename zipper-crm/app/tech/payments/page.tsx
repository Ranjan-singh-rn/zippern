'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { getPaymentConfigs, updatePaymentConfig, PaymentConfig, PaymentMethod } from '@/lib/tech'
import { Plus, X, Loader2, CreditCard, ToggleLeft, ToggleRight } from 'lucide-react'

const ALL_METHODS: PaymentMethod['type'][] = ['offline', 'stripe', 'razorpay', 'upi', 'google_play']

const METHOD_LABELS: Record<PaymentMethod['type'], string> = {
  offline: 'Offline',
  stripe: 'Stripe',
  razorpay: 'Razorpay',
  upi: 'UPI',
  google_play: 'Google Play',
}

const METHOD_COLORS: Record<PaymentMethod['type'], string> = {
  offline: 'text-zinc-400',
  stripe: 'text-blue-400',
  razorpay: 'text-cyan-400',
  upi: 'text-green-400',
  google_play: 'text-yellow-400',
}

const PRESET_COUNTRIES = [
  { code: 'IN', name: 'India' },
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'AE', name: 'UAE' },
  { code: 'ID', name: 'Indonesia' },
  { code: 'PH', name: 'Philippines' },
  { code: 'PK', name: 'Pakistan' },
  { code: 'BD', name: 'Bangladesh' },
]

function getCountryName(code: string) {
  return PRESET_COUNTRIES.find((c) => c.code === code)?.name ?? code
}

function defaultMethods(): PaymentMethod[] {
  return ALL_METHODS.map((type) => ({ type, isActive: false }))
}

export default function PaymentsPage() {
  const { crmUser, loading: authLoading } = useAuth()
  const [configs, setConfigs] = useState<PaymentConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [showAddModal, setShowAddModal] = useState(false)
  const [newCountry, setNewCountry] = useState('')

  const load = () => {
    setLoading(true)
    getPaymentConfigs()
      .then((data) => {
        // Merge with preset countries to show all
        const existingCodes = data.map((d) => d.id)
        const presets = PRESET_COUNTRIES
          .filter((c) => !existingCodes.includes(c.code))
          .map((c) => ({
            id: c.code,
            country: c.name,
            methods: defaultMethods(),
            updatedAt: null,
          } as PaymentConfig))
        setConfigs([...data, ...presets].sort((a, b) => a.id.localeCompare(b.id)))
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, ['superadmin', 'tech_admin', 'tech_member'])) return
    load()
  }, [crmUser])

  async function handleToggle(config: PaymentConfig, methodType: PaymentMethod['type']) {
    const updated = config.methods.map((m) =>
      m.type === methodType ? { ...m, isActive: !m.isActive } : m
    )
    setSaving(config.id)
    try {
      await updatePaymentConfig(config.id, updated)
      setConfigs((prev) =>
        prev.map((c) =>
          c.id === config.id
            ? { ...c, methods: updated, country: c.country || getCountryName(c.id) }
            : c
        )
      )
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(null)
    }
  }

  async function handleAddCountry() {
    const code = newCountry.trim().toUpperCase()
    if (!code || configs.find((c) => c.id === code)) return
    setSaving(code)
    try {
      await updatePaymentConfig(code, defaultMethods())
      setShowAddModal(false)
      setNewCountry('')
      load()
    } catch (e) {
      console.error(e)
    } finally {
      setSaving(null)
    }
  }

  const getMethod = (config: PaymentConfig, type: PaymentMethod['type']) =>
    config.methods.find((m) => m.type === type) ?? { type, isActive: false }

  if (authLoading) return <div className="flex items-center justify-center min-h-screen"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" /></div>

  if (!crmUser || !canAccess(crmUser, ['superadmin', 'tech_admin', 'tech_member'])) {
    return <div className="flex items-center justify-center min-h-64"><p className="text-zinc-400">Access denied.</p></div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white">Payment Configuration</h1>
          <p className="text-zinc-400 mt-1">Manage payment methods per country</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          <Plus size={16} />Add Country
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-400 py-12 justify-center">
          <Loader2 size={20} className="animate-spin" /><span>Loading...</span>
        </div>
      ) : (
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800">
                <th className="text-left text-zinc-500 font-medium px-4 py-3">Country</th>
                {ALL_METHODS.map((m) => (
                  <th key={m} className="text-center text-zinc-500 font-medium px-3 py-3">
                    <span className={METHOD_COLORS[m]}>{METHOD_LABELS[m]}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {configs.map((config) => (
                <tr key={config.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/20 transition-colors">
                  <td className="px-4 py-3">
                    <div>
                      <span className="text-white font-medium">{getCountryName(config.id)}</span>
                      <span className="text-zinc-500 text-xs ml-2 font-mono">{config.id}</span>
                    </div>
                  </td>
                  {ALL_METHODS.map((type) => {
                    const method = getMethod(config, type)
                    return (
                      <td key={type} className="px-3 py-3 text-center">
                        <button
                          onClick={() => handleToggle(config, type)}
                          disabled={saving === config.id}
                          className="inline-flex items-center justify-center disabled:opacity-50"
                        >
                          {method.isActive
                            ? <ToggleRight size={22} className="text-green-400" />
                            : <ToggleLeft size={22} className="text-zinc-600" />
                          }
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAddModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-sm p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">Add Country</h2>
              <button onClick={() => setShowAddModal(false)} className="text-zinc-500 hover:text-white"><X size={20} /></button>
            </div>
            <div>
              <label className="text-xs text-zinc-400 mb-1 block">Country Code (ISO 2-letter)</label>
              <input
                value={newCountry}
                onChange={(e) => setNewCountry(e.target.value.toUpperCase())}
                maxLength={2}
                placeholder="e.g. SG"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500 uppercase"
              />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowAddModal(false)} className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded-lg text-sm font-medium transition-colors">Cancel</button>
              <button
                onClick={handleAddCountry}
                disabled={!newCountry.trim() || saving !== null}
                className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
