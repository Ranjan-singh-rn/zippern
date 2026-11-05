'use client'

/**
 * Safety (O13, Owner, 5 Nov 2026) — "keep nudity, sexual content and vulgarity out of the rooms, and keep the people who
 * spread it away". The Owner's switches for what `functions/src/safety.ts` does. Saved to `appConfig/safety`, which
 * only an MFA-bound Owner may write (firestore.rules); the server clamps every number again.
 *
 *   * The AI check (Google Cloud Vision SafeSearch) on every live still — OFF until the Owner has enabled the Cloud
 *     Vision API in the Google Cloud console (it is billed per image) and turns it on here.
 *   * Automatic ending on an ADULT verdict — OFF unless turned on here; without it staff decide from the live wall.
 *   * How often a broadcaster's phone sends a still.
 *   * The word list (the built-in list plus the Owner's own words) and how many strikes silence a person in a room.
 */

import { useCallback, useEffect, useState } from 'react'
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { AlertTriangle, CheckCircle, Loader2, Save, ShieldCheck } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { Denied, Loading } from '@/components/ui/States'
import { SAFETY_DEFAULTS, sanitizeSafety, type SafetySettings } from '@/lib/safetySettings'

const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500'

export default function SafetySettingsPage() {
  const { crmUser, loading } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, ['superadmin'])
  const [cfg, setCfg] = useState<SafetySettings | null>(null)
  const [words, setWords] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null)

  const load = useCallback(async () => {
    const snap = await getDoc(doc(db, 'appConfig', 'safety'))
    const c = sanitizeSafety(snap.exists() ? snap.data() : undefined)
    setCfg(c)
    setWords(c.badWords.join('\n'))
  }, [])

  useEffect(() => { if (allowed) void load().catch((e) => setNotice({ ok: false, msg: e instanceof Error ? e.message : 'Could not read the settings.' })) }, [allowed, load])

  if (loading) return <Loading />
  if (!allowed) return <Denied what="safety settings" />
  if (!cfg) return <Loading />

  const set = (patch: Partial<SafetySettings>) => setCfg({ ...cfg, ...patch })

  async function save() {
    if (!cfg) return
    setSaving(true)
    setNotice(null)
    try {
      const clean = sanitizeSafety({ ...cfg, badWords: words.split(/\n|,/) })
      await setDoc(doc(db, 'appConfig', 'safety'), { ...clean, updatedAt: serverTimestamp(), updatedBy: crmUser?.uid ?? '' })
      setCfg(clean)
      setWords(clean.badWords.join('\n'))
      setNotice({ ok: true, msg: 'Saved. Phones and the server pick it up within a minute.' })
    } catch (e) {
      setNotice({ ok: false, msg: e instanceof Error ? e.message : 'Could not save.' })
    } finally {
      setSaving(false)
    }
  }

  const Toggle = ({ on, label, hint, onChange }: { on: boolean; label: string; hint: string; onChange: (v: boolean) => void }) => (
    <label className="flex items-start gap-3 py-3 border-b border-slate-800 cursor-pointer">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="mt-1 accent-pink-500" />
      <span>
        <span className="text-white text-sm font-medium">{label}</span>
        <span className="block text-slate-400 text-xs mt-0.5 leading-relaxed">{hint}</span>
      </span>
    </label>
  )

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2"><ShieldCheck size={20} className="text-pink-400" /> Safety</h1>
        <p className="text-slate-400 text-sm mt-1">
          What keeps nudity, sexual content and abuse out of the rooms. The live wall (Live &amp; Comms → Live Wall) shows a
          still of every live room; the word screen masks abuse in live, party and direct chat and silences repeat offenders.
        </p>
      </div>

      <section className="bg-slate-900 border border-slate-800 rounded-xl px-5">
        <Toggle on={cfg.visionEnabled} onChange={(v) => set({ visionEnabled: v })}
          label="AI check on live stills (Google Cloud Vision SafeSearch)"
          hint="Off by default. Turn the Cloud Vision API on in the Google Cloud console first — it is billed per image. Each still is checked; an adult verdict (likely or above) flags the room on the live wall." />
        <Toggle on={cfg.autoEndOnAdult} onChange={(v) => set({ autoEndOnAdult: v })}
          label="End a live automatically on an adult verdict"
          hint="Off by default: staff decide from the live wall. On: the room ends the moment the check says adult (likely or above), with the still kept as evidence." />
        <Toggle on={cfg.useBuiltInWords} onChange={(v) => set({ useBuiltInWords: v })}
          label="Use the built-in word list"
          hint="Explicit and abusive words in English, Hinglish and Hindi. Your own words below are added to it." />
      </section>

      <section className="bg-slate-900 border border-slate-800 rounded-xl p-5 grid sm:grid-cols-3 gap-4">
        <label className="text-sm text-slate-300">A still every (seconds)
          <input className={inputCls} type="number" min={30} max={600} value={cfg.snapshotEverySeconds}
            onChange={(e) => set({ snapshotEverySeconds: Number(e.target.value) })} />
          <span className="text-slate-500 text-xs">30–600. Each still is one image for the AI check.</span>
        </label>
        <label className="text-sm text-slate-300">Strikes before a person is silenced
          <input className={inputCls} type="number" min={1} max={20} value={cfg.muteAfterStrikes}
            onChange={(e) => set({ muteAfterStrikes: Number(e.target.value) })} />
          <span className="text-slate-500 text-xs">In that room's chat; staff see a flag.</span>
        </label>
        <label className="text-sm text-slate-300">…counted over (minutes)
          <input className={inputCls} type="number" min={5} max={1440} value={cfg.strikeWindowMinutes}
            onChange={(e) => set({ strikeWindowMinutes: Number(e.target.value) })} />
        </label>
      </section>

      <section className="bg-slate-900 border border-slate-800 rounded-xl p-5">
        <label className="text-sm text-slate-300 block">Your own words — one per line
          <textarea className={`${inputCls} mt-1 h-40 font-mono`} value={words} onChange={(e) => setWords(e.target.value)}
            placeholder={'one word or phrase per line'} />
        </label>
        <p className="text-slate-500 text-xs mt-1">Matched as whole words, with spaced-out letters and look-alike characters (0 for o, @ for a) caught too.</p>
      </section>

      {notice && (
        <div className={`flex items-start gap-2 rounded-lg px-3 py-2 border ${notice.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}>
          {notice.ok ? <CheckCircle size={14} className="mt-0.5" /> : <AlertTriangle size={14} className="mt-0.5" />}
          <p className="text-sm">{notice.msg}</p>
        </div>
      )}

      <button onClick={() => void save()} disabled={saving}
        className="flex items-center gap-2 bg-pink-600 hover:bg-pink-500 disabled:opacity-60 text-white font-semibold rounded-lg px-4 py-2.5 text-sm">
        {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save
      </button>
      <p className="text-slate-600 text-xs">Defaults: AI check {SAFETY_DEFAULTS.visionEnabled ? 'on' : 'off'}, automatic ending off, a still every {SAFETY_DEFAULTS.snapshotEverySeconds} s, silenced after {SAFETY_DEFAULTS.muteAfterStrikes} strikes in {SAFETY_DEFAULTS.strikeWindowMinutes} minutes.</p>
    </div>
  )
}
