'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { getProfileOptions, saveProfileOptions, DEFAULT_PROFILE_OPTIONS, type ProfileOptions } from '@/lib/appConfig'
import { Loader2, Save, CheckCircle, AlertTriangle, X, Plus, RefreshCw } from 'lucide-react'

const inputCls = 'bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500'

function TagEditor({
  label,
  tags,
  onChange,
  hint,
}: {
  label: string
  tags: string[]
  onChange: (t: string[]) => void
  hint?: string
}) {
  const [input, setInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function add() {
    const v = input.trim()
    if (!v || tags.includes(v)) { setInput(''); return }
    onChange([...tags, v])
    setInput('')
    inputRef.current?.focus()
  }

  function remove(tag: string) { onChange(tags.filter(t => t !== tag)) }

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
      <div className="flex items-center justify-between mb-1">
        <p className="text-white font-semibold text-sm">{label}</p>
        <span className="text-slate-500 text-xs">{tags.length} items</span>
      </div>
      {hint && <p className="text-slate-500 text-xs mb-3">{hint}</p>}

      <div className="flex flex-wrap gap-2 mb-3">
        {tags.map(tag => (
          <span key={tag} className="flex items-center gap-1.5 bg-slate-700 text-slate-200 text-xs px-2.5 py-1 rounded-full">
            {tag}
            <button onClick={() => remove(tag)} className="text-slate-500 hover:text-red-400 transition-colors">
              <X size={11} />
            </button>
          </span>
        ))}
        {tags.length === 0 && <p className="text-slate-600 text-xs italic">No items yet</p>}
      </div>

      <div className="flex gap-2">
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          placeholder="Add item and press Enter"
          className={inputCls + ' flex-1'}
        />
        <button onClick={add}
          className="flex items-center gap-1 px-3 py-2 bg-pink-500/20 hover:bg-pink-500/30 text-pink-300 border border-pink-500/30 rounded-lg text-xs font-medium transition-colors">
          <Plus size={12} />Add
        </button>
      </div>
    </div>
  )
}

export default function ProfileOptionsPage() {
  const { crmUser } = useAuth()
  const router = useRouter()
  const [opts, setOpts] = useState<ProfileOptions>(DEFAULT_PROFILE_OPTIONS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'ok'|'err' } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, ['superadmin'])) { router.push('/'); return }
    getProfileOptions()
      .then(data => { if (data) setOpts(data) })
      .catch(err => {
        console.error(err)
        setLoadError('Failed to load saved profile options — showing defaults.')
      })
      .finally(() => setLoading(false))
  }, [crmUser, router])

  function showToast(msg: string, type: 'ok'|'err') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function handleSave() {
    setSaving(true)
    try {
      await saveProfileOptions(opts)
      showToast('Profile options saved', 'ok')
    } catch { showToast('Save failed', 'err') }
    finally { setSaving(false) }
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
        <div className="mb-4 flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 text-sm">
          <AlertTriangle size={14} />
          {loadError}
        </div>
      )}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-xl text-sm font-medium border ${
          toast.type === 'ok'
            ? 'bg-green-500/10 border-green-500/30 text-green-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          {toast.type === 'ok' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />}
          {toast.msg}
        </div>
      )}

      <h1 className="text-2xl font-bold text-white mb-1">Profile Options</h1>
      <p className="text-slate-400 text-sm mb-6">Tags and options shown to users when setting up their profile. Changes here update the app without a new APK.</p>

      <div className="space-y-4 mb-6">
        <TagEditor
          label="Hobbies"
          tags={opts.hobbies}
          onChange={v => setOpts(o => ({ ...o, hobbies: v }))}
          hint="Shown in profile setup — users pick their hobbies"
        />
        <TagEditor
          label="Likes"
          tags={opts.likes}
          onChange={v => setOpts(o => ({ ...o, likes: v }))}
          hint="What users are interested in"
        />
        <TagEditor
          label="Live Categories"
          tags={opts.liveCategories}
          onChange={v => setOpts(o => ({ ...o, liveCategories: v }))}
          hint="Categories hosts can choose when starting a live stream"
        />
        <TagEditor
          label="Support Categories"
          tags={opts.supportCategories}
          onChange={v => setOpts(o => ({ ...o, supportCategories: v }))}
          hint="Ticket categories shown in the help/support flow"
        />

        <div className="bg-slate-800 border border-slate-700 rounded-xl p-5">
          <p className="text-white font-semibold text-sm mb-1">Max Languages</p>
          <p className="text-slate-500 text-xs mb-3">Maximum number of languages a user can select on their profile</p>
          <input
            type="number"
            min={1}
            max={10}
            value={opts.maxLanguages}
            onChange={e => setOpts(o => ({ ...o, maxLanguages: +e.target.value }))}
            className={inputCls + ' w-24'}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-xl font-semibold text-sm transition-colors">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save All Options
        </button>
        <button onClick={() => setOpts(DEFAULT_PROFILE_OPTIONS)}
          className="flex items-center gap-1.5 px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-xl text-sm transition-colors">
          <RefreshCw size={13} />Reset to Defaults
        </button>
      </div>
    </div>
  )
}
