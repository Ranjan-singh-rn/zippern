'use client'

import UploadField from '@/components/UploadField'
import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { getBagItems, upsertBagItem, toggleBagItem, type BagItem } from '@/lib/tech'
import { doc, setDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import {
  Loader2, Save, ToggleLeft, ToggleRight, AlertTriangle,
  CheckCircle, Package, Lock, Users, Star, RefreshCw, Layers,
} from 'lucide-react'
import AnimationThumb from '@/components/AnimationThumb'
import BagItemThumb from '@/components/BagItemThumb'
import UserSearchPicker from '@/components/UserSearchPicker'
import { bagItemWrite, frameScaleOf, svgaKeyOk, FRAME_SCALE_DEFAULT } from '@/lib/decorAssets'

// ── Types ─────────────────────────────────────────────────────────────────────

type Category = BagItem['category'] | 'all'

const CATEGORIES: { key: Category; label: string; emoji: string }[] = [
  { key: 'all',          label: 'All Items',     emoji: '🎒' },
  { key: 'frame',        label: 'Avatar Frames', emoji: '🖼️' },
  { key: 'chat_bubble',  label: 'Chat Bubbles',  emoji: '💬' },
  { key: 'profile_card', label: 'Profile Cards', emoji: '🪪' },
  { key: 'id_frame',     label: 'ID Frames',     emoji: '🏷️' },
  { key: 'entrance',     label: 'Entrances',     emoji: '🚀' },
]

const SOURCE_STYLES: Record<string, string> = {
  level:       'bg-blue-500/20 text-blue-300 border-blue-500/30',
  marketplace: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  event:       'bg-pink-500/20 text-pink-300 border-pink-500/30',
}

// Default catalog — mirrors Android's DEFAULT_CATALOG in MyBagViewModel.kt
// Saved to Firestore `bagItems` collection when superadmin clicks "Seed Defaults"
const DEFAULT_CATALOG: Omit<BagItem, 'isActive'>[] = [
  // ── Avatar Frames ──────────────────────────────────────────────────────────
  { id: 'af_basic',   name: 'Silver Ring',   category: 'frame', previewUrl: '', unlockLevel: 0,  minHostLevel: 0, price: 0,    source: 'level',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'af_bronze',  name: 'Bronze Bloom',  category: 'frame', previewUrl: '', unlockLevel: 0,  minHostLevel: 0, price: 0,    source: 'level',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'af_silver',  name: 'Silver Halo',   category: 'frame', previewUrl: '', unlockLevel: 3,  minHostLevel: 0, price: 0,    source: 'level',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'af_gold',    name: 'Gold Wing',     category: 'frame', previewUrl: '', unlockLevel: 5,  minHostLevel: 0, price: 0,    source: 'level',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'af_royal',   name: 'Royal Crown',   category: 'frame', previewUrl: '', unlockLevel: 7,  minHostLevel: 0, price: 0,    source: 'level',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'af_dragon',  name: 'Dragon Scale',  category: 'frame', previewUrl: '', unlockLevel: 9,  minHostLevel: 0, price: 0,    source: 'level',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'af_neon',    name: 'Neon Glow',     category: 'frame', previewUrl: '', unlockLevel: 0,  minHostLevel: 0, price: 500,  source: 'marketplace', animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'af_galaxy',  name: 'Galaxy Ring',   category: 'frame', previewUrl: '', unlockLevel: 0,  minHostLevel: 0, price: 1200, source: 'marketplace', animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'af_event1',  name: 'Event Frame',   category: 'frame', previewUrl: '', unlockLevel: 0,  minHostLevel: 0, price: 0,    source: 'event',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  // ── Chat Bubbles ───────────────────────────────────────────────────────────
  { id: 'cb_default', name: 'Classic Dark',  category: 'chat_bubble', previewUrl: '', unlockLevel: 0, minHostLevel: 0, price: 0,   source: 'level',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'cb_rose',    name: 'Rose Bloom',    category: 'chat_bubble', previewUrl: '', unlockLevel: 0, minHostLevel: 0, price: 0,   source: 'marketplace', animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'cb_ocean',   name: 'Ocean Wave',    category: 'chat_bubble', previewUrl: '', unlockLevel: 4, minHostLevel: 0, price: 0,   source: 'level',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'cb_galaxy',  name: 'Galaxy Chat',   category: 'chat_bubble', previewUrl: '', unlockLevel: 0, minHostLevel: 0, price: 600, source: 'marketplace', animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'cb_event',   name: 'Event Bubble',  category: 'chat_bubble', previewUrl: '', unlockLevel: 0, minHostLevel: 0, price: 0,   source: 'event',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  // ── Profile Cards ──────────────────────────────────────────────────────────
  { id: 'pc_basic',   name: 'Basic Card',    category: 'profile_card', previewUrl: '', unlockLevel: 0, minHostLevel: 0, price: 0,   source: 'level',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'pc_gold',    name: 'Gold Card',     category: 'profile_card', previewUrl: '', unlockLevel: 6, minHostLevel: 0, price: 0,   source: 'level',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'pc_royal',   name: 'Royal Card',    category: 'profile_card', previewUrl: '', unlockLevel: 0, minHostLevel: 0, price: 800, source: 'marketplace', animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'pc_event',   name: 'Event Card',    category: 'profile_card', previewUrl: '', unlockLevel: 0, minHostLevel: 0, price: 0,   source: 'event',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  // ── ID Frames ──────────────────────────────────────────────────────────────
  { id: 'id_basic',   name: 'Basic Banner',  category: 'id_frame', previewUrl: '', unlockLevel: 0,  minHostLevel: 0, price: 0,   source: 'level',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'id_gold',    name: 'Gold Banner',   category: 'id_frame', previewUrl: '', unlockLevel: 5,  minHostLevel: 0, price: 0,   source: 'level',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'id_royal',   name: 'Royal Banner',  category: 'id_frame', previewUrl: '', unlockLevel: 0,  minHostLevel: 0, price: 400, source: 'marketplace', animationAsset: '', targetGender: 'all', targetRole: 'all' },
  { id: 'id_event',   name: 'Event Banner',  category: 'id_frame', previewUrl: '', unlockLevel: 0,  minHostLevel: 0, price: 0,   source: 'event',       animationAsset: '', targetGender: 'all', targetRole: 'all' },
  // ── Entrances ──────────────────────────────────────────────────────────────
  { id: 'en_bike',    name: 'Bike Entry',    category: 'entrance', previewUrl: '', unlockLevel: 6,  minHostLevel: 0,  price: 0, source: 'level', animationAsset: '/lottie/entrances/en_bike.json',   targetGender: 'all', targetRole: 'all' },
  { id: 'en_sports',  name: 'Sports Car',    category: 'entrance', previewUrl: '', unlockLevel: 8,  minHostLevel: 0,  price: 0, source: 'level', animationAsset: '/lottie/entrances/en_sports.json', targetGender: 'all', targetRole: 'all' },
  { id: 'en_lambo',   name: 'Lambo',         category: 'entrance', previewUrl: '', unlockLevel: 10, minHostLevel: 10, price: 0, source: 'level', animationAsset: '/lottie/entrances/en_lambo.json',  targetGender: 'all', targetRole: 'all' },
  { id: 'en_tiger',   name: 'Tiger',         category: 'entrance', previewUrl: '', unlockLevel: 0,  minHostLevel: 0,  price: 0, source: 'event', animationAsset: '/lottie/entrances/en_tiger.json',  targetGender: 'all', targetRole: 'all' },
  { id: 'en_king',    name: "King's Entry",  category: 'entrance', previewUrl: '', unlockLevel: 0,  minHostLevel: 0,  price: 0, source: 'event', animationAsset: '/lottie/entrances/en_king.json',   targetGender: 'all', targetRole: 'all' },
  { id: 'en_horse',   name: 'Horse Rider',   category: 'entrance', previewUrl: '', unlockLevel: 12, minHostLevel: 0,  price: 0, source: 'level', animationAsset: '/lottie/entrances/en_horse.json',  targetGender: 'all', targetRole: 'all' },
  { id: 'en_ship',    name: 'Ship',          category: 'entrance', previewUrl: '', unlockLevel: 0,  minHostLevel: 0,  price: 0, source: 'event', animationAsset: '/lottie/entrances/en_ship.json',   targetGender: 'all', targetRole: 'all' },
  { id: 'en_jet',     name: 'Fighter Jet',   category: 'entrance', previewUrl: '', unlockLevel: 14, minHostLevel: 0,  price: 0, source: 'level', animationAsset: '/lottie/entrances/en_jet.json',    targetGender: 'all', targetRole: 'all' },
  { id: 'en_rocket',  name: 'Rocket',        category: 'entrance', previewUrl: '', unlockLevel: 0,  minHostLevel: 0,  price: 0, source: 'event', animationAsset: '/lottie/entrances/en_rocket.json', targetGender: 'all', targetRole: 'all' },
  { id: 'en_yamraj',  name: 'Yamraj Special',category: 'entrance', previewUrl: '', unlockLevel: 0,  minHostLevel: 0,  price: 0, source: 'event', animationAsset: '/lottie/entrances/en_yamraj.json', targetGender: 'all', targetRole: 'all' },
  { id: 'en_vip',     name: 'VIP Plane',     category: 'entrance', previewUrl: '', unlockLevel: 15, minHostLevel: 0,  price: 0, source: 'level', animationAsset: '/lottie/entrances/en_vip.json',    targetGender: 'all', targetRole: 'all' },
]

// ── Level dropdown options ────────────────────────────────────────────────────

const USER_LEVELS  = Array.from({ length: 21 }, (_, i) => i)   // 0–20
const HOST_LEVELS  = Array.from({ length: 11 }, (_, i) => i)   // 0–10

// ── Row component ─────────────────────────────────────────────────────────────

type PatchableField = 'unlockLevel' | 'minHostLevel' | 'source' | 'previewUrl' | 'price' | 'animationUrl' | 'targetGender' | 'targetRole' | 'targetUserId'
  | 'svgaUrl' | 'videoUrl' | 'svgaAvatarKey' | 'svgaNameKey' | 'frameScale'

function ItemRow({
  item,
  isDirty,
  isSaving,
  onChange,
  onSave,
  onToggle,
}: {
  item: BagItem
  isDirty: boolean
  isSaving: boolean
  onChange: (field: PatchableField, val: number | string) => void
  onSave: () => void
  onToggle: () => void
}) {
  const [editingUrl, setEditingUrl]   = useState(false)
  const [urlDraft, setUrlDraft]       = useState(item.previewUrl)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [popoverPos, setPopoverPos]   = useState<{ top: number; left: number } | null>(null)
  const thumbBtnRef                   = useRef<HTMLDivElement>(null)
  const levelLockedUser = item.unlockLevel > 0
  const levelLockedHost = item.minHostLevel > 0

  function commitUrl() {
    onChange('previewUrl', urlDraft)
    setEditingUrl(false)
  }

  // B13: the app plays the SVGA (svgaUrl) first; animationUrl is the old Lottie, kept for rollback only.
  const animationSrc = item.svgaUrl || item.animationUrl || item.animationAsset || ''
  const hasAnimation = !!animationSrc
  const [scaleDraft, setScaleDraft] = useState(String(item.frameScale ?? FRAME_SCALE_DEFAULT))

  return (
    <tr className={`border-b border-slate-800 transition-colors ${isDirty ? 'bg-yellow-500/5' : 'hover:bg-slate-800/40'}`}>
      {/* Preview + Name */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">

          {/* Thumbnail + action buttons */}
          <div className="relative group shrink-0 flex gap-1.5">

            {/* Thumbnail — click opens design/animation preview popover */}
            <div
              ref={thumbBtnRef}
              onClick={() => {
                if (previewOpen) { setPreviewOpen(false); setPopoverPos(null); return }
                const rect = thumbBtnRef.current?.getBoundingClientRect()
                if (rect) setPopoverPos({ top: rect.bottom + 8, left: Math.min(rect.left, window.innerWidth - 220) })
                setPreviewOpen(true)
              }}
              title="Click to preview"
              className="cursor-pointer relative"
            >
              <BagItemThumb
                id={item.id}
                category={item.category}
                name={item.name}
                previewUrl={item.previewUrl}
                size={40}
              />
              {/* Small pencil icon for entrances (to edit previewUrl) — visible on hover */}
              {item.category === 'entrance' && (
                <button
                  onClick={e => { e.stopPropagation(); setUrlDraft(item.previewUrl); setEditingUrl(true) }}
                  title="Edit preview image URL"
                  className="absolute -bottom-1 -right-1 w-4 h-4 bg-slate-700 border border-slate-500 rounded-full text-slate-400 hover:text-white hover:border-pink-400 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-[9px]"
                >✏</button>
              )}
            </div>

            {/* Preview popover — design or animation, all categories */}
            {previewOpen && popoverPos && (
              <div
                style={{ position: 'fixed', top: popoverPos.top, left: popoverPos.left, zIndex: 9999 }}
                className="bg-slate-800 border border-pink-500/40 rounded-2xl shadow-2xl p-3 w-52"
              >
                <div className="flex items-center justify-between mb-2">
                  <p className="text-pink-300 text-xs font-semibold">{item.name}</p>
                  <button onClick={() => { setPreviewOpen(false); setPopoverPos(null) }} className="text-slate-400 hover:text-white text-xs">✕</button>
                </div>
                {/* Animation if available, else computed design */}
                {hasAnimation && animationSrc
                  ? <AnimationThumb src={animationSrc} size={192} />
                  : <BagItemThumb id={item.id} category={item.category} name={item.name} previewUrl={item.previewUrl} size={192} />
                }
                <p className="text-slate-500 text-xs mt-2 truncate font-mono">{item.id}</p>
                {hasAnimation && (
                  <p className="text-slate-600 text-xs truncate font-mono">
                    {animationSrc.includes('.svga') ? '📦 SVGA' : '🎬 Lottie'}
                  </p>
                )}
                {/* B13: what the app plays — SVGA for every category, MP4 for entrances */}
                <div className="mt-2 pt-2 border-t border-slate-700 space-y-2">
                  <UploadField
                    label="SVGA animation"
                    value={item.svgaUrl || ''}
                    onChange={url => onChange('svgaUrl', url)}
                    storagePath={`contentAssets/bag_items/${item.category}/${item.id}/svga`}
                    accept=".svga"
                    hint="What the app plays. Transparent, so it sits over live video."
                    maxSizeMb={5}
                  />
                  {item.category === 'entrance' && (
                    <>
                      <UploadField
                        label="MP4 (fallback)"
                        value={item.videoUrl || ''}
                        onChange={url => onChange('videoUrl', url)}
                        storagePath={`contentAssets/bag_items/${item.category}/${item.id}/video`}
                        accept="video/mp4"
                        hint="Played only when there is no SVGA."
                        maxSizeMb={15}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <label className="text-[10px] text-slate-400">Photo layer
                          <input value={item.svgaAvatarKey ?? ''} placeholder="avatar"
                            onChange={e => onChange('svgaAvatarKey', e.target.value.trim())}
                            className={`mt-0.5 w-full bg-slate-900 border rounded px-1.5 py-1 text-[11px] text-white ${svgaKeyOk(item.svgaAvatarKey ?? '') ? 'border-slate-600' : 'border-red-500'}`} />
                        </label>
                        <label className="text-[10px] text-slate-400">Name layer
                          <input value={item.svgaNameKey ?? ''} placeholder="name"
                            onChange={e => onChange('svgaNameKey', e.target.value.trim())}
                            className={`mt-0.5 w-full bg-slate-900 border rounded px-1.5 py-1 text-[11px] text-white ${svgaKeyOk(item.svgaNameKey ?? '') ? 'border-slate-600' : 'border-red-500'}`} />
                        </label>
                      </div>
                      <p className="text-[10px] text-slate-500">The layers the app swaps for the arriving user&apos;s photo and name. tools/decor/inspect.py lists them for a bought file.</p>
                    </>
                  )}
                  {item.category === 'frame' && (
                    <label className="block text-[10px] text-slate-400">Frame size × photo (1.0–2.5)
                      <input value={scaleDraft} inputMode="decimal"
                        onChange={e => setScaleDraft(e.target.value)}
                        onBlur={() => { const v = frameScaleOf(scaleDraft); if (v === null) { setScaleDraft(String(item.frameScale ?? FRAME_SCALE_DEFAULT)) } else { setScaleDraft(String(v)); onChange('frameScale', v) } }}
                        className="mt-0.5 w-full bg-slate-900 border border-slate-600 rounded px-1.5 py-1 text-[11px] text-white" />
                    </label>
                  )}
                  {item.category !== 'entrance' && (
                    <UploadField
                      label="Lottie (legacy)"
                      value={item.animationUrl || ''}
                      onChange={url => onChange('animationUrl', url)}
                      storagePath={`contentAssets/bag_items/${item.category}/${item.id}`}
                      accept=".json,application/json"
                      hint="Old format, kept for rollback — the app plays the SVGA above."
                      maxSizeMb={25}
                    />
                  )}
                </div>
              </div>
            )}

            {/* URL edit popover (entrance only) */}
            {editingUrl && (
              <div className="absolute left-0 top-12 z-50 bg-slate-800 border border-slate-600 rounded-xl shadow-xl p-3 w-72">
                <div className="mb-2">
                  <UploadField
                    label="Preview image"
                    value={urlDraft}
                    onChange={setUrlDraft}
                    storagePath={`contentAssets/bag_items/${item.category}/${item.id}/thumb`}
                    accept="image/*"
                    hint="A still, shown in the grid. Keep it small — the app decodes one per tile."
                    maxSizeMb={2}
                  />
                </div>
                <div className="flex gap-2">
                  <button onClick={commitUrl} className="flex-1 py-1.5 bg-pink-500 hover:bg-pink-600 text-white rounded-lg text-xs font-semibold transition-colors">Set</button>
                  <button onClick={() => setEditingUrl(false)} className="flex-1 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-xs transition-colors">Cancel</button>
                </div>
              </div>
            )}
          </div>

          <div>
            <p className="text-white text-sm font-medium">{item.name}</p>
            <p className="text-slate-500 text-xs font-mono">{item.id}</p>
          </div>
          {isDirty && <span className="text-yellow-400 text-xs font-semibold">unsaved</span>}
        </div>
      </td>

      {/* Source — editable dropdown */}
      <td className="px-4 py-3 whitespace-nowrap">
        <select
          value={item.source}
          onChange={e => onChange('source', e.target.value as BagItem['source'])}
          className={`border rounded-lg px-2 py-1 text-xs font-medium focus:outline-none focus:border-white ${SOURCE_STYLES[item.source]} bg-transparent`}
        >
          <option value="level"       className="bg-slate-800 text-white">🏆 level</option>
          <option value="marketplace" className="bg-slate-800 text-white">🛒 marketplace</option>
          <option value="event"       className="bg-slate-800 text-white">🎉 event</option>
        </select>
        {item.source === 'marketplace' && (
          <div className="flex items-center gap-1 mt-1">
            <span className="text-yellow-400 text-xs">💎</span>
            <input
              type="number"
              min={0}
              value={item.price}
              onChange={e => onChange('price', +e.target.value)}
              className="w-20 bg-slate-700 border border-slate-600 rounded px-2 py-0.5 text-xs text-yellow-300 focus:outline-none focus:border-yellow-500"
              placeholder="price"
            />
          </div>
        )}
      </td>

      {/* Min User Level */}
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <Users size={13} className="text-blue-400 shrink-0" />
          <select
            value={item.unlockLevel}
            onChange={e => onChange('unlockLevel', parseInt(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 min-w-[80px]"
          >
            {USER_LEVELS.map(l => (
              <option key={l} value={l}>
                {l === 0 ? 'No lock' : `Lv. ${l}`}
              </option>
            ))}
          </select>
          {levelLockedUser && <Lock size={11} className="text-blue-400" />}
        </div>
      </td>

      {/* Min Host Level */}
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <Star size={13} className="text-pink-400 shrink-0" />
          <select
            value={item.minHostLevel}
            onChange={e => onChange('minHostLevel', parseInt(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:border-pink-500 min-w-[80px]"
          >
            {HOST_LEVELS.map(l => (
              <option key={l} value={l}>
                {l === 0 ? 'No lock' : `Lv. ${l}`}
              </option>
            ))}
          </select>
          {levelLockedHost && <Lock size={11} className="text-pink-400" />}
        </div>
      </td>

      {/* Gender */}
      <td className="px-4 py-3 whitespace-nowrap">
        <select
          value={item.targetGender ?? 'all'}
          onChange={e => onChange('targetGender', e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:border-pink-500"
        >
          <option value="all">👥 All</option>
          <option value="male">♂ Male</option>
          <option value="female">♀ Female</option>
        </select>
      </td>

      {/* Role */}
      <td className="px-4 py-3 whitespace-nowrap">
        <select
          value={item.targetRole ?? 'all'}
          onChange={e => onChange('targetRole', e.target.value)}
          disabled={!!(item.targetUserId)}
          className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-white text-sm focus:outline-none focus:border-pink-500 disabled:opacity-40"
        >
          <option value="all">🔓 All</option>
          <option value="user">👤 User only</option>
          <option value="host">🎙 Host only</option>
        </select>
      </td>

      {/* Exclusive User ID — searchable picker */}
      <td className="px-4 py-3">
        <div className="flex flex-col gap-1">
          <UserSearchPicker
            value={item.targetUserId ?? ''}
            onChange={uid => onChange('targetUserId', uid)}
          />
          {item.targetUserId && (
            <span className="text-yellow-400 text-[10px] font-semibold">⭐ EXCLUSIVE</span>
          )}
        </div>
      </td>

      {/* Active toggle */}
      <td className="px-4 py-3 whitespace-nowrap">
        <button onClick={onToggle} className="transition-colors">
          {item.isActive
            ? <ToggleRight size={26} className="text-green-400 hover:text-green-300" />
            : <ToggleLeft  size={26} className="text-slate-600 hover:text-slate-400" />
          }
        </button>
      </td>

      {/* Save */}
      <td className="px-4 py-3 whitespace-nowrap">
        <button
          onClick={onSave}
          disabled={!isDirty || isSaving}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg text-xs font-semibold transition-colors"
        >
          {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          Save
        </button>
      </td>
    </tr>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function BagItemsConfigPage() {
  const { crmUser } = useAuth()
  const router = useRouter()

  const [items, setItems] = useState<BagItem[]>([])
  const [loading, setLoading] = useState(true)
  const [seeding, setSeeding] = useState(false)
  const [category, setCategory] = useState<Category>('all')
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [savingAll, setSavingAll] = useState(false)
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, ['superadmin'])) { router.push('/'); return }
    getBagItems().then(data => {
      setItems(data.sort((a, b) => {
        const catOrder = ['frame', 'chat_bubble', 'profile_card', 'id_frame', 'entrance']
        return catOrder.indexOf(a.category) - catOrder.indexOf(b.category) || a.name.localeCompare(b.name)
      }))
    }).catch(err => {
      console.error(err)
      setLoadError('Failed to load bag items. Please refresh and try again.')
    }).finally(() => setLoading(false))
  }, [crmUser, router])

  function showToast(type: 'ok' | 'err', text: string) {
    setToast({ type, text })
    setTimeout(() => setToast(null), 3500)
  }

  function patchItem(id: string, field: PatchableField, val: number | string) {
    setItems(prev => prev.map(it => it.id === id ? { ...it, [field]: val } : it))
    setDirty(prev => new Set(prev).add(id))
  }

  async function saveItem(id: string) {
    const item = items.find(it => it.id === id)
    if (!item) return
    if (!svgaKeyOk(item.svgaAvatarKey ?? '') || !svgaKeyOk(item.svgaNameKey ?? '')) {
      showToast('err', `${item.name}: a layer name may only use letters, digits, _ . -`)
      return
    }
    setSaving(s => ({ ...s, [id]: true }))
    try {
      // B13: MERGE. A plain setDoc replaced the document and deleted every field this page does not show —
      // `durations` (the timed prices purchaseBagItem sells from) and `videoUrl` (MP4 entrances from the upload script).
      await setDoc(doc(db, 'bagItems', id), bagItemWrite(item), { merge: true })
      setDirty(prev => { const s = new Set(prev); s.delete(id); return s })
    } catch { showToast('err', 'Failed to save.') } finally {
      setSaving(s => ({ ...s, [id]: false }))
    }
  }

  async function saveAll() {
    const dirtyIds = Array.from(dirty)
    if (!dirtyIds.length) return
    setSavingAll(true)
    try {
      await Promise.all(dirtyIds.map(id => saveItem(id)))
      showToast('ok', `Saved ${dirtyIds.length} item${dirtyIds.length > 1 ? 's' : ''}.`)
    } catch { showToast('err', 'Some saves failed.') } finally { setSavingAll(false) }
  }

  async function toggleItem(id: string) {
    const item = items.find(it => it.id === id)
    if (!item) return
    const next = !item.isActive
    setItems(prev => prev.map(it => it.id === id ? { ...it, isActive: next } : it))
    try {
      await toggleBagItem(id, next)
    } catch {
      setItems(prev => prev.map(it => it.id === id ? { ...it, isActive: !next } : it))
      showToast('err', 'Toggle failed.')
    }
  }

  async function seedDefaults() {
    setSeeding(true)
    try {
      await Promise.all(DEFAULT_CATALOG.map(item =>
        setDoc(doc(db, 'bagItems', item.id), { ...item, isActive: true })
      ))
      const seeded: BagItem[] = DEFAULT_CATALOG.map(item => ({ ...item, isActive: true }))
      setItems(seeded)
      showToast('ok', `Seeded ${seeded.length} default bag items.`)
    } catch { showToast('err', 'Seeding failed.') } finally { setSeeding(false) }
  }

  // Filter out en_default (no animation) and apply category filter
  const visibleItems = items.filter(it => it.id !== 'en_default')
  const filtered = category === 'all' ? visibleItems : visibleItems.filter(it => it.category === category)
  const categoryCount = (cat: Category) =>
    cat === 'all' ? visibleItems.length : visibleItems.filter(it => it.category === cat).length

  if (!crmUser || !canAccess(crmUser, ['superadmin'])) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-zinc-400">Access denied.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 size={28} className="text-pink-500 animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto">
      {/* Toast */}
      {loadError && (
        <div className="mb-4 flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 text-sm">
          <AlertTriangle size={15} />
          {loadError}
        </div>
      )}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-xl text-sm font-medium border ${
          toast.type === 'ok'
            ? 'bg-green-500/10 border-green-500/30 text-green-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          {toast.type === 'ok' ? <CheckCircle size={15} /> : <AlertTriangle size={15} />}
          {toast.text}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Package size={22} className="text-pink-500" />
            <h1 className="text-2xl font-bold text-white">Bag Items Config</h1>
          </div>
          <p className="text-slate-400 text-sm">
            Set the minimum user level and host level required to unlock each item. Items appear locked in the app until the user meets the requirement.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {dirty.size > 0 && (
            <button
              onClick={saveAll}
              disabled={savingAll}
              className="flex items-center gap-2 px-4 py-2 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-xl font-semibold text-sm transition-colors"
            >
              {savingAll ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save All ({dirty.size})
            </button>
          )}
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <p className="text-slate-400 text-xs mb-1">Total Items</p>
          <p className="text-2xl font-bold text-white">{visibleItems.length}</p>
          <p className="text-slate-500 text-xs mt-0.5">{visibleItems.filter(it => it.isActive).length} active</p>
        </div>
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-4">
          <p className="text-slate-400 text-xs mb-1">Event Items</p>
          <p className="text-2xl font-bold text-pink-300">{visibleItems.filter(it => it.source === 'event').length}</p>
          <p className="text-slate-500 text-xs mt-0.5">{visibleItems.filter(it => it.source === 'event' && it.isActive).length} active</p>
        </div>
      </div>

      {/* Empty state — seed defaults */}
      {items.length === 0 && (
        <div className="bg-slate-800 border border-slate-700 rounded-2xl p-12 text-center">
          <Package size={48} className="text-slate-600 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-white mb-2">No bag items in Firestore yet</h2>
          <p className="text-slate-400 text-sm mb-6 max-w-md mx-auto">
            The app currently uses the hardcoded DEFAULT_CATALOG. Click below to seed all{' '}
            <strong className="text-white">{DEFAULT_CATALOG.length} default items</strong> into Firestore so you can manage their levels here.
          </p>
          <button
            onClick={seedDefaults}
            disabled={seeding}
            className="inline-flex items-center gap-2 px-6 py-3 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-xl font-semibold text-sm transition-colors"
          >
            {seeding ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            {seeding ? 'Seeding…' : 'Seed Default Catalog'}
          </button>
        </div>
      )}

      {items.length > 0 && (
        <>
          {/* Category tabs */}
          <div className="flex gap-1 mb-5 bg-slate-900 border border-slate-800 rounded-xl p-1 overflow-x-auto">
            {CATEGORIES.map(cat => (
              <button
                key={cat.key}
                onClick={() => setCategory(cat.key)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors ${
                  category === cat.key
                    ? 'bg-pink-500 text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <span>{cat.emoji}</span>{cat.label}
                <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${
                  category === cat.key ? 'bg-white/20 text-white' : 'bg-slate-700 text-slate-400'
                }`}>{categoryCount(cat.key)}</span>
              </button>
            ))}
          </div>

          {/* Table */}
          <div className="bg-slate-800 border border-slate-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-700/50 text-slate-300 text-xs">
                    <th className="px-4 py-3 text-left font-semibold">Item</th>
                    <th className="px-4 py-3 text-left font-semibold">Source</th>
                    <th className="px-4 py-3 text-left font-semibold">
                      <div className="flex items-center gap-1"><Users size={12} className="text-blue-400" />Min User Level</div>
                    </th>
                    <th className="px-4 py-3 text-left font-semibold">
                      <div className="flex items-center gap-1"><Star size={12} className="text-pink-400" />Min Host Level</div>
                    </th>
                    <th className="px-4 py-3 text-left font-semibold">Gender</th>
                    <th className="px-4 py-3 text-left font-semibold">Role</th>
                    <th className="px-4 py-3 text-left font-semibold">
                      <span title="Set a User ID to make this item exclusive to one account only">⭐ Exclusive To</span>
                    </th>
                    <th className="px-4 py-3 text-left font-semibold">Active</th>
                    <th className="px-4 py-3 text-left font-semibold">Save</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr><td colSpan={9} className="text-center py-12 text-slate-500">No items in this category.</td></tr>
                  ) : filtered.map(item => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      isDirty={dirty.has(item.id)}
                      isSaving={!!saving[item.id]}
                      onChange={(field, val) => patchItem(item.id, field, val)}
                      onSave={() => saveItem(item.id)}
                      onToggle={() => toggleItem(item.id)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Info box */}
          <div className="mt-4 bg-slate-900 border border-slate-800 rounded-xl p-4 flex gap-3">
            <Layers size={16} className="text-slate-500 shrink-0 mt-0.5" />
            <div className="text-slate-400 text-xs space-y-1">
              <p><strong className="text-slate-300">How locking works in the app:</strong></p>
              <p>• A user can use an item if their <strong className="text-blue-300">wealth level ≥ Min User Level</strong> (0 = everyone can use it).</p>
              <p>• A host can additionally unlock items if their <strong className="text-pink-300">host level ≥ Min Host Level</strong> (0 = no host-level gate).</p>
              <p>• Items below the threshold show a <strong className="text-white">🔒 lock overlay</strong> in the My Bag screen. The item cannot be equipped or purchased until the level is reached.</p>
              <p>• <strong className="text-slate-300">Gender</strong> restricts the item to Male / Female / All. <strong className="text-slate-300">Role</strong> restricts to Users only, Hosts only, or All (strict exclusive — hosts are not users).</p>
              <p>• <strong className="text-yellow-300">⭐ Exclusive To</strong> — paste a User ID to lock the item to one account only. Gender & role are ignored when this is set. Leave blank for public items.</p>
              <p>• Changes here reflect in the app immediately — the Android client reads from the <code className="text-slate-300">bagItems</code> Firestore collection on every app open.</p>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
