'use client'

/**
 * UserSearchPicker — searchable popover to pick a user by name, email, or UID.
 *
 * Search runs on the SERVER (lib/firestore#searchUsers): exact UID / email /
 * phone lookups plus case-sensitive name-prefix ranges. It used to cache an
 * arbitrary 500 users module-globally and filter them in JavaScript, which
 * meant any user outside that 500 was simply unpickable.
 *
 * Usage:
 *   <UserSearchPicker
 *     value={userId}          // currently selected UID (empty = none)
 *     onChange={uid => ...}   // called with UID on select, '' on clear
 *   />
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { getUsersPage, searchUsers, getUser, type UserRecord as FullUserRecord } from '@/lib/firestore'
import { X, Search, Loader2, User, AlertTriangle } from 'lucide-react'
import { failureReason } from '@/lib/readState'
import { profilePhotoSrc } from '@/lib/profilePhoto'

interface UserRecord {
  uid: string
  name: string
  email: string
  photoUrl: string
  isHost: boolean
}

interface Props {
  value: string           // selected UID, '' = none
  onChange: (uid: string) => void
}

const BROWSE_SIZE = 30

function slim(u: FullUserRecord): UserRecord {
  return { uid: u.uid, name: u.name, email: u.email, photoUrl: u.photoUrl, isHost: u.isHost }
}

// Module-level cache of the FIRST PAGE only (the idle "browse" list), plus
// resolved labels for already-selected UIDs. Deliberately not a full mirror of
// the users collection — searching goes to Firestore.
let _firstPage: UserRecord[] | null = null
let _firstPagePromise: Promise<UserRecord[]> | null = null
const _labelCache = new Map<string, UserRecord>()

/**
 * The browse list. It used to end in `.catch(() => [])`, and because the
 * REJECTED promise stayed in `_firstPagePromise`, a single failed read made
 * every picker in the session show "No users found" forever — a refusal cached
 * as a fact about the database. The failure now propagates (so the caller can
 * say what happened) and the memo is cleared (so reopening retries).
 */
async function fetchFirstPage(): Promise<UserRecord[]> {
  if (_firstPage) return _firstPage
  if (_firstPagePromise) return _firstPagePromise
  _firstPagePromise = getUsersPage(BROWSE_SIZE)
    .then(res => {
      _firstPage = res.users.map(slim)
      for (const u of _firstPage) _labelCache.set(u.uid, u)
      return _firstPage
    })
    .catch(err => {
      _firstPagePromise = null
      throw err
    })
  return _firstPagePromise
}

export default function UserSearchPicker({ value, onChange }: Props) {
  const [open, setOpen]           = useState(false)
  const [query2, setQuery]        = useState('')
  const [users, setUsers]         = useState<UserRecord[]>([])
  const [loading, setLoading]     = useState(false)
  const [selected, setSelected]   = useState<UserRecord | null>(null)
  const inputRef                  = useRef<HTMLInputElement>(null)
  const wrapRef                   = useRef<HTMLDivElement>(null)
  const [pos, setPos]             = useState<{ top: number; left: number; width: number } | null>(null)
  /** Why the list is empty, when it is empty because a read failed. */
  const [listError, setListError] = useState('')

  // Open with the browse list (first page); typing switches to a server search.
  const openPicker = useCallback(async () => {
    setOpen(true)
    setQuery('')
    const rect = wrapRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 280) })
    if (_firstPage) { setUsers(_firstPage); setListError(''); return }
    setLoading(true)
    try { setUsers(await fetchFirstPage()); setListError('') }
    catch (err) { setUsers([]); setListError(failureReason(err)) }
    finally { setLoading(false) }
  }, [])

  // Debounced server-side search
  useEffect(() => {
    if (!open) return
    const term = query2.trim()
    let cancelled = false

    if (!term) {
      fetchFirstPage()
        .then(list => { if (!cancelled) { setUsers(list); setListError('') } })
        .catch(err => { if (!cancelled) { setUsers([]); setListError(failureReason(err)) } })
      return () => { cancelled = true }
    }

    setLoading(true)
    const handle = setTimeout(async () => {
      try {
        const found = await searchUsers(term, BROWSE_SIZE)
        if (cancelled) return
        const list = found.map(slim)
        for (const u of list) _labelCache.set(u.uid, u)
        setUsers(list)
        setListError('')
      } catch (err) {
        // A search that could not run has found nothing to report, which is
        // not the same as having searched and found nothing.
        if (!cancelled) { setUsers([]); setListError(failureReason(err)) }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 300)

    return () => { cancelled = true; clearTimeout(handle) }
  }, [query2, open])

  // Resolve the selected user's label — one direct document read, not a scan.
  useEffect(() => {
    if (!value) { setSelected(null); return }
    const cached = _labelCache.get(value)
    if (cached) { setSelected(cached); return }
    let cancelled = false
    getUser(value)
      .then(u => {
        if (cancelled || !u) return
        const s = slim(u)
        _labelCache.set(s.uid, s)
        setSelected(s)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [value])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Focus input when opened
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 50) }, [open])

  // `users` already holds the server's answer for the current term.
  const filtered = users.slice(0, BROWSE_SIZE)

  function select(u: UserRecord) {
    _labelCache.set(u.uid, u)
    setSelected(u)
    onChange(u.uid)
    setOpen(false)
  }

  function clear(e: React.MouseEvent) {
    e.stopPropagation()
    setSelected(null)
    onChange('')
  }

  return (
    <div ref={wrapRef} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={openPicker}
        className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-xs font-mono transition-colors text-left w-44 ${
          value
            ? 'border-yellow-500/60 bg-yellow-500/5 text-yellow-300'
            : 'border-slate-700 bg-slate-800 text-slate-500 hover:border-slate-500'
        }`}
      >
        {selected ? (
          <>
            {profilePhotoSrc(selected.photoUrl)
              ? <img src={profilePhotoSrc(selected.photoUrl)} alt="" className="w-4 h-4 rounded-full shrink-0 object-cover" />
              : <User size={12} className="shrink-0 text-slate-400" />
            }
            <span className="truncate flex-1 text-yellow-200">{selected.name || selected.uid.slice(0, 10)}</span>
            <span
              role="button"
              onClick={clear}
              className="shrink-0 text-yellow-500 hover:text-red-400 transition-colors cursor-pointer"
            ><X size={11} /></span>
          </>
        ) : value ? (
          <>
            <User size={12} className="shrink-0 text-slate-400" />
            <span className="truncate flex-1">{value.slice(0, 14)}…</span>
            <span role="button" onClick={clear} className="shrink-0 cursor-pointer"><X size={11} /></span>
          </>
        ) : (
          <>
            <Search size={11} className="shrink-0" />
            <span>Search user…</span>
          </>
        )}
      </button>

      {/* Dropdown portal */}
      {open && pos && (
        <div
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden"
        >
          {/* Search input */}
          <div className="p-2 border-b border-slate-800">
            <div className="flex items-center gap-2 bg-slate-800 rounded-lg px-2.5 py-1.5">
              <Search size={13} className="text-slate-500 shrink-0" />
              <input
                ref={inputRef}
                value={query2}
                onChange={e => setQuery(e.target.value)}
                placeholder="Name, email or UID…"
                className="bg-transparent text-white text-xs flex-1 outline-none placeholder:text-slate-600"
              />
              {query2 && (
                <button onClick={() => setQuery('')} className="text-slate-500 hover:text-white">
                  <X size={11} />
                </button>
              )}
            </div>
          </div>

          {/* Results */}
          <div className="max-h-60 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8 gap-2 text-slate-500 text-xs">
                <Loader2 size={14} className="animate-spin" /> Loading users…
              </div>
            ) : listError ? (
              <div className="flex items-start gap-2 px-3 py-5 text-xs">
                <AlertTriangle size={13} className="text-yellow-400 mt-0.5 shrink-0" />
                <p className="text-yellow-200/90 leading-relaxed">
                  This list could not be read — it is not empty.
                  <span className="block text-slate-500 mt-0.5">{listError}</span>
                </p>
              </div>
            ) : filtered.length === 0 ? (
              <p className="text-center py-6 text-slate-600 text-xs">
                {query2.trim()
                  ? 'No match. Try the full UID, exact email/phone, or the start of the name.'
                  : 'No users found'}
              </p>
            ) : filtered.map(u => (
              <button
                key={u.uid}
                type="button"
                onClick={() => select(u)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 hover:bg-slate-800 transition-colors text-left ${
                  u.uid === value ? 'bg-yellow-500/10' : ''
                }`}
              >
                {profilePhotoSrc(u.photoUrl)
                  ? <img src={profilePhotoSrc(u.photoUrl)} alt="" className="w-7 h-7 rounded-full shrink-0 object-cover border border-slate-700" />
                  : <div className="w-7 h-7 rounded-full shrink-0 bg-slate-700 flex items-center justify-center">
                      <User size={13} className="text-slate-400" />
                    </div>
                }
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-white text-xs font-medium truncate">{u.name || '—'}</span>
                    {u.isHost && (
                      <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-pink-500/20 text-pink-300 border border-pink-500/30 shrink-0">HOST</span>
                    )}
                    {u.uid === value && (
                      <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-yellow-500/20 text-yellow-300 border border-yellow-500/30 shrink-0">SELECTED</span>
                    )}
                  </div>
                  <p className="text-slate-500 text-[10px] truncate">{u.email || u.uid}</p>
                </div>
              </button>
            ))}
          </div>

          {/* Footer */}
          <div className="px-3 py-1.5 border-t border-slate-800 text-slate-600 text-[10px]">
            {loading
              ? 'Searching…'
              : query2.trim()
                ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'} · UID/email/phone exact, name by prefix`
                : `First ${filtered.length} users — type to search all`}
          </div>
        </div>
      )}
    </div>
  )
}
