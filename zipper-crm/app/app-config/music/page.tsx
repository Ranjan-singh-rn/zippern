'use client'

/**
 * Room music (B7, 3 Nov 2026) — Zipper's licensed catalogue for party rooms.
 *
 * A room's owner or admin can only play a track from this list (functions/src/party.ts `setPartyMusic` refuses
 * anything else), so this page is the whole of what can be played in a room. Add only music Zipper holds a licence
 * for, and say which licence in the note — the note is what answers "are we allowed to play this?" later.
 * Tech and the Owner keep it (firestore.rules `musicTracks`).
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { addDoc, collection, doc, getDocs, orderBy, query, serverTimestamp, updateDoc } from 'firebase/firestore'
import { AlertTriangle, Loader2, Music, Plus } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { db } from '@/lib/firebase'

const inputCls = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500'

interface Track { id: string; title: string; artist: string; url: string; licence: string; enabled: boolean }

/** A track the server will accept: a title, an https URL and a licence note. */
function trackProblems(t: { title: string; url: string; licence: string }): string[] {
  const out: string[] = []
  if (!t.title.trim()) out.push('Give the track a title.')
  if (!/^https:\/\//.test(t.url.trim())) out.push('The file URL must start with https:// (Firebase Storage download URL).')
  if (!t.licence.trim()) out.push('Say which licence lets Zipper play this track.')
  return out
}

export default function MusicCataloguePage() {
  const { crmUser } = useAuth()
  const router = useRouter()
  const allowed = !!crmUser && canAccess(crmUser, ['superadmin', 'tech_admin', 'tech_member'])
  const [tracks, setTracks] = useState<Track[] | null>(null)
  const [draft, setDraft] = useState({ title: '', artist: '', url: '', licence: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const rows = await getDocs(query(collection(db, 'musicTracks'), orderBy('title')))
    setTracks(rows.docs.map((d) => ({
      id: d.id, title: String(d.get('title') ?? ''), artist: String(d.get('artist') ?? ''), url: String(d.get('url') ?? ''),
      licence: String(d.get('licence') ?? ''), enabled: d.get('enabled') !== false,
    })))
  }, [])

  useEffect(() => {
    if (!crmUser) return
    if (!allowed) { router.push('/'); return }
    load().catch(() => setError('Could not load the catalogue.'))
  }, [crmUser, allowed, router, load])

  async function add() {
    const problems = trackProblems(draft)
    if (problems.length) { setError(problems.join(' ')); return }
    setBusy(true)
    try {
      await addDoc(collection(db, 'musicTracks'), {
        title: draft.title.trim().slice(0, 80), artist: draft.artist.trim().slice(0, 80), url: draft.url.trim(),
        licence: draft.licence.trim().slice(0, 200), enabled: true, addedBy: crmUser?.uid ?? '', addedAt: serverTimestamp(),
      })
      setDraft({ title: '', artist: '', url: '', licence: '' })
      setError('')
      await load()
    } catch { setError('Could not add the track — Tech and the Owner keep this list.') } finally { setBusy(false) }
  }

  async function toggle(t: Track) {
    await updateDoc(doc(db, 'musicTracks', t.id), { enabled: !t.enabled, updatedAt: serverTimestamp() }).catch(() => setError('Could not update the track.'))
    await load()
  }

  if (!allowed) return <div className="flex items-center justify-center min-h-64"><p className="text-slate-400">Access denied.</p></div>
  if (!tracks) return <div className="flex items-center justify-center py-32"><Loader2 size={28} className="text-pink-500 animate-spin" /></div>

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2"><Music size={22} /> Room music</h1>
        <p className="text-slate-400 text-sm mt-1">
          Party-room owners and admins can play only these tracks. Add only music Zipper is licensed to play in public
          rooms, and record the licence.
        </p>
      </div>
      {error && <div className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm border bg-red-500/10 border-red-500/30 text-red-300"><AlertTriangle size={14} /> {error}</div>}
      <div className="bg-slate-800 rounded-xl p-4 grid md:grid-cols-2 gap-3">
        <input className={inputCls} placeholder="Title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <input className={inputCls} placeholder="Artist" value={draft.artist} onChange={(e) => setDraft({ ...draft, artist: e.target.value })} />
        <input className={inputCls} placeholder="https://… (Storage download URL)" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
        <input className={inputCls} placeholder="Licence (who, what, until when)" value={draft.licence} onChange={(e) => setDraft({ ...draft, licence: e.target.value })} />
        <button onClick={add} disabled={busy} className="md:col-span-2 flex items-center justify-center gap-2 bg-pink-600 hover:bg-pink-500 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm">
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add track
        </button>
      </div>
      <div className="bg-slate-800 rounded-xl p-4">
        {tracks.length === 0 ? <p className="text-slate-400 text-sm">No tracks yet — rooms have no music until one is added.</p> : (
          <table className="w-full text-sm text-slate-300">
            <thead><tr className="text-slate-400 text-xs"><th className="text-left">Track</th><th className="text-left">Licence</th><th>Playable</th></tr></thead>
            <tbody>
              {tracks.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}{t.artist ? ` — ${t.artist}` : ''}</td>
                  <td className="text-xs">{t.licence || '—'}</td>
                  <td className="text-center"><input type="checkbox" checked={t.enabled} onChange={() => toggle(t)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
