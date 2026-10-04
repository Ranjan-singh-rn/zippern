'use client'

import { useState, useEffect, useRef } from 'react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import {
  getGifts, createGift, updateGift, toggleGift,
  getBagItems, upsertBagItem, toggleBagItem,
  Gift, BagItem,
} from '@/lib/tech'
import { computeBeanValue, CATEGORY_DEFAULT_RATES, CATEGORY_RATE_RANGES } from '@/lib/gifts'
import { getEconomyConfig, type EconomyConfig } from '@/lib/economyConfig'
import { Plus, X, Edit2, Loader2, ToggleLeft, ToggleRight, Upload, Check, AlertTriangle, Sparkles, ImageIcon } from 'lucide-react'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { storage } from '@/lib/firebase'

// ── Helpers ───────────────────────────────────────────────────────────────────

function toSafeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item'
}

// ── Gift modal helpers (mirrors Gift Economy page) ────────────────────────────

const BUNDLED_LOTTIE: { key: string; label: string }[] = [
  { key: 'gifts/g1_rose.json',    label: 'Rose' },
  { key: 'gifts/g2_heart.json',   label: 'Heart' },
  { key: 'gifts/g3_kiss.json',    label: 'Kiss' },
  { key: 'gifts/g4_teddy.json',   label: 'Teddy Bear' },
  { key: 'gifts/g5_ring.json',    label: 'Diamond Ring' },
  { key: 'gifts/g6_crown.json',   label: 'Crown' },
  { key: 'gifts/g7_car.json',     label: 'Sports Car' },
  { key: 'gifts/g8_yacht.json',   label: 'Yacht' },
  { key: 'gifts/g9_rocket.json',  label: 'Rocket' },
  { key: 'gifts/g10_castle.json', label: 'Castle' },
]

const CATEGORY_COLORS_GIFT: Record<Gift['category'], string> = {
  normal:    'bg-slate-500/20 text-slate-300 border-slate-500/30',
  exclusive: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  lucky:     'bg-pink-500/20 text-pink-300 border-pink-500/30',
}

function buildCategoryMeta(gr: EconomyConfig['giftRates'] | null) {
  const normalPct = gr?.normalReceiverPct       ?? CATEGORY_DEFAULT_RATES.normal
  const excMin    = gr?.exclusiveReceiverPctMin  ?? CATEGORY_RATE_RANGES.exclusive[0]
  const excMax    = gr?.exclusiveReceiverPctMax  ?? CATEGORY_RATE_RANGES.exclusive[1]
  const luckyPct  = gr?.luckyReceiverPct        ?? CATEGORY_DEFAULT_RATES.lucky
  return {
    normal:    { color: CATEGORY_COLORS_GIFT.normal,    label: 'Normal',    desc: `Host earns ${normalPct}%` },
    exclusive: { color: CATEGORY_COLORS_GIFT.exclusive, label: 'Exclusive', desc: `Host earns ${excMin}–${excMax}%` },
    lucky:     { color: CATEGORY_COLORS_GIFT.lucky,     label: 'Lucky',     desc: `Host earns ${luckyPct}% · lucky draw` },
  }
}

function buildRateRanges(gr: EconomyConfig['giftRates'] | null): Record<Gift['category'], [number, number]> {
  const normalPct = gr?.normalReceiverPct       ?? CATEGORY_DEFAULT_RATES.normal
  const excMin    = gr?.exclusiveReceiverPctMin  ?? CATEGORY_RATE_RANGES.exclusive[0]
  const excMax    = gr?.exclusiveReceiverPctMax  ?? CATEGORY_RATE_RANGES.exclusive[1]
  const luckyPct  = gr?.luckyReceiverPct        ?? CATEGORY_DEFAULT_RATES.lucky
  return {
    normal:    [normalPct, normalPct],
    exclusive: [excMin, excMax],
    lucky:     [luckyPct, luckyPct],
  }
}

async function uploadAsset(
  file: File,
  storagePath: string,
  onProgress: (pct: number) => void,
): Promise<string> {
  const sRef = ref(storage, storagePath)
  const task = uploadBytesResumable(sRef, file)
  await new Promise<void>((resolve, reject) =>
    task.on('state_changed',
      snap => onProgress(Math.round(snap.bytesTransferred / snap.totalBytes * 100)),
      reject,
      () => resolve(),
    ),
  )
  return getDownloadURL(sRef)
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

type Tab = 'gifts' | 'cards' | 'frames' | 'id_frames' | 'entrances' | 'chat_bubbles'

const TABS: { key: Tab; label: string }[] = [
  { key: 'gifts',        label: 'Gifts' },
  { key: 'cards',        label: 'Profile Cards' },
  { key: 'frames',       label: 'Frames' },
  { key: 'id_frames',    label: 'ID Frames' },
  { key: 'entrances',    label: 'Entrances' },
  { key: 'chat_bubbles', label: 'Chat Bubbles' },
]

const BAG_SOURCES = ['level', 'marketplace', 'event'] as const

// Map tab → BagItem category
const TAB_TO_CATEGORY: Partial<Record<Tab, BagItem['category']>> = {
  cards:        'profile_card',
  frames:       'frame',
  id_frames:    'id_frame',
  entrances:    'entrance',
  chat_bubbles: 'chat_bubble',
}

// Map BagItem category → Firebase Storage subfolder
const CAT_FOLDER: Record<BagItem['category'], string> = {
  frame:        'frames',
  id_frame:     'id_frames',
  entrance:     'entrances',
  chat_bubble:  'chat_bubbles',
  profile_card: 'profile_cards',
}

const CAT_LABEL: Record<BagItem['category'], string> = {
  frame:        'Frame',
  id_frame:     'ID Frame',
  entrance:     'Entrance',
  chat_bubble:  'Chat Bubble',
  profile_card: 'Profile Card',
}

// ── Shared upload row ─────────────────────────────────────────────────────────
// URL text input + Upload button. File goes to `storagePath`; URL auto-fills.
// Disabled (with hint) when `disabled` prop is true (e.g. name not yet entered).

function UploadRow({
  label, value, accept, disabled, disabledHint,
  uploading, progress, previewHref,
  onChange, onUpload,
}: {
  label: string
  value: string
  accept: string
  disabled?: boolean
  disabledHint?: string
  uploading: boolean
  progress: number
  previewHref?: string
  onChange: (url: string) => void
  onUpload: (file: File) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div>
      <label className="text-xs text-zinc-400 mb-1 block">{label}</label>
      <div className="flex gap-2">
        <input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="Paste URL or upload →"
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500 min-w-0"
        />
        <button type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || uploading}
          title={disabled ? disabledHint : undefined}
          className="flex items-center gap-1.5 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap">
          {uploading
            ? <><Loader2 size={13} className="animate-spin" />{progress}%</>
            : <><Upload size={13} />Upload</>}
        </button>
        <input type="file" accept={accept} className="hidden" ref={inputRef}
          onChange={e => { const f = e.target.files?.[0]; if (f) onUpload(f) }} />
      </div>
      {previewHref && value && value.startsWith('http') && (
        <a href={previewHref} target="_blank" rel="noreferrer"
          className="inline-block mt-1 text-xs text-purple-400 underline hover:text-purple-300">
          🎬 Preview ↗
        </a>
      )}
    </div>
  )
}

// ── Gift Modal ────────────────────────────────────────────────────────────────
// Full-featured modal — mirrors Gift Economy page.
// Tech handles visuals (image + Lottie); Admin sets earning rate in Gift Economy.

interface GiftFormState {
  name: string; emoji: string; imageUrl: string; lottieAsset: string
  diamondCost: string; earningRate: string; category: Gift['category']
  sortOrder: string; isActive: boolean
}

function emptyGiftForm(): GiftFormState {
  return { name: '', emoji: '🎁', imageUrl: '', lottieAsset: '', diamondCost: '', earningRate: '50', category: 'normal', sortOrder: '99', isActive: true }
}

function fromGift(g: Gift, rateRanges: Record<Gift['category'], [number, number]>): GiftFormState {
  const rate = g.category === 'exclusive' ? g.earningRate : rateRanges[g.category][0]
  return {
    name: g.name, emoji: g.emoji, imageUrl: g.imageUrl ?? '', lottieAsset: g.lottieAsset ?? '',
    diamondCost: String(g.diamondCost), earningRate: String(rate), category: g.category,
    sortOrder: String(g.sortOrder), isActive: g.isActive,
  }
}

async function uploadGiftAsset(file: File, type: 'image' | 'lottie', giftName: string, onProgress: (pct: number) => void): Promise<string> {
  const safeName = toSafeName(giftName)
  const ext      = file.name.split('.').pop()?.toLowerCase() || (type === 'lottie' ? 'json' : 'png')
  const fileName = type === 'lottie' ? 'lottie.json' : `image.${ext}`
  const path     = `contentAssets/gifts/${safeName}/${fileName}`
  const sRef     = ref(storage, path)
  const task     = uploadBytesResumable(sRef, file)
  await new Promise<void>((resolve, reject) =>
    task.on('state_changed', snap => onProgress(Math.round(snap.bytesTransferred / snap.totalBytes * 100)), reject, () => resolve()),
  )
  return getDownloadURL(sRef)
}

function GiftModal({
  mode, initial, rateRanges, categoryMeta, onClose, onSaved,
}: {
  mode: 'add' | 'edit'
  initial?: Gift
  rateRanges: Record<Gift['category'], [number, number]>
  categoryMeta: ReturnType<typeof buildCategoryMeta>
  onClose: () => void
  onSaved: () => void
}) {
  const [form, setForm] = useState<GiftFormState>(initial ? fromGift(initial, rateRanges) : emptyGiftForm())
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const [imgUploading,    setImgUploading]    = useState(false)
  const [imgProgress,     setImgProgress]     = useState(0)
  const [lottieUploading, setLottieUploading] = useState(false)
  const [lottieProgress,  setLottieProgress]  = useState(0)

  const imgInputRef    = useRef<HTMLInputElement>(null)
  const lottieInputRef = useRef<HTMLInputElement>(null)

  const [giftMode, setGiftMode] = useState<'emoji' | 'image'>(initial?.imageUrl ? 'image' : 'emoji')

  const set = <K extends keyof GiftFormState>(k: K, v: GiftFormState[K]) => setForm(f => ({ ...f, [k]: v }))

  async function handleImageUpload(file: File) {
    if (!file.type.startsWith('image/svg') && !file.type.startsWith('image/png') && !file.type.startsWith('image/webp')) {
      setErr('Only SVG, PNG, or WebP images are accepted.'); return
    }
    if (!form.name.trim()) { setErr('Enter a gift name before uploading.'); return }
    setImgUploading(true); setImgProgress(0)
    try {
      const url = await uploadGiftAsset(file, 'image', form.name, setImgProgress)
      set('imageUrl', url)
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Image upload failed.') }
    finally { setImgUploading(false) }
  }

  async function handleLottieUpload(file: File) {
    if (!file.name.endsWith('.json')) { setErr('Lottie file must be a .json file.'); return }
    if (!form.name.trim()) { setErr('Enter a gift name before uploading.'); return }
    setLottieUploading(true); setLottieProgress(0)
    try {
      await file.text().then(t => JSON.parse(t)) // validate
      const url = await uploadGiftAsset(file, 'lottie', form.name, setLottieProgress)
      set('lottieAsset', url)
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Lottie upload failed.') }
    finally { setLottieUploading(false) }
  }

  function handleCategoryChange(cat: Gift['category']) {
    set('category', cat); set('earningRate', String(rateRanges[cat][0]))
  }

  const diamondCost  = parseInt(form.diamondCost) || 0
  const earningRate  = parseInt(form.earningRate) || 0
  const beansPreview = computeBeanValue(diamondCost, earningRate)
  const [rateMin, rateMax] = rateRanges[form.category]
  const rateFixed = rateMin === rateMax

  async function submit() {
    if (!form.name.trim()) { setErr('Name is required.'); return }
    if (isNaN(diamondCost) || diamondCost < 1) { setErr('Diamond cost must be ≥ 1.'); return }
    setSaving(true); setErr('')
    try {
      const data = {
        name: form.name.trim(), emoji: form.emoji || '🎁',
        imageUrl: form.imageUrl.trim() || undefined,
        lottieAsset: form.lottieAsset.trim() || undefined,
        diamondCost, earningRate, category: form.category,
        sortOrder: parseInt(form.sortOrder) || 99, isActive: form.isActive,
      }
      if (mode === 'add') {
        await createGift({ ...data, earningRate: data.earningRate ?? CATEGORY_DEFAULT_RATES[data.category] })
      } else if (initial) {
        await updateGift(initial.id, data)
      }
      onSaved(); onClose()
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Save failed.')
    } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm overflow-y-auto">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl my-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h3 className="text-white font-semibold">{mode === 'add' ? 'Add Gift' : 'Edit Gift'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors"><X size={18} /></button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-slate-400 text-xs mb-1.5">Gift Name *</label>
            <input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Rose, Lucky Box, Super Star"
              className="w-full bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-pink-500" />
          </div>

          {/* Mode toggle */}
          <div>
            <label className="block text-slate-400 text-xs mb-1.5">Gift Visual Mode</label>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => { setGiftMode('emoji'); set('imageUrl', ''); set('lottieAsset', '') }}
                className={`py-2.5 px-3 rounded-lg text-xs font-medium border transition text-left ${
                  giftMode === 'emoji' ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-300' : 'bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-500'
                }`}>
                <p className="font-semibold">Emoji</p>
                <p className="text-[10px] opacity-70 mt-0.5">Auto-animated on screen</p>
              </button>
              <button onClick={() => setGiftMode('image')}
                className={`py-2.5 px-3 rounded-lg text-xs font-medium border transition text-left ${
                  giftMode === 'image' ? 'bg-blue-500/15 border-blue-500/40 text-blue-300' : 'bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-500'
                }`}>
                <p className="font-semibold">Custom Image</p>
                <p className="text-[10px] opacity-70 mt-0.5">SVG + Lottie animation</p>
              </button>
            </div>
          </div>

          {/* EMOJI MODE */}
          {giftMode === 'emoji' && (
            <div className="flex gap-3 items-end">
              <div>
                <label className="block text-slate-400 text-xs mb-1.5">Emoji</label>
                <input value={form.emoji} onChange={e => set('emoji', e.target.value)}
                  className="w-16 text-center text-2xl bg-slate-700 border border-slate-600 text-white rounded-lg px-2 py-2 focus:outline-none focus:border-yellow-500" />
              </div>
              <div className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2.5">
                <p className="text-yellow-400 text-xs font-medium">✨ Auto animation</p>
                <p className="text-slate-500 text-[10px] mt-0.5">Emoji bounces & pulses fullscreen when the gift is sent. No Lottie file needed.</p>
              </div>
            </div>
          )}

          {/* IMAGE MODE */}
          {giftMode === 'image' && (
            <div className="space-y-3">
              {!form.name.trim() && (
                <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-xs">
                  <AlertTriangle size={11} /> Enter a gift name above before uploading files
                </div>
              )}

              {/* Image upload */}
              <div>
                <label className="block text-slate-400 text-xs mb-1.5 flex items-center gap-1"><ImageIcon size={11} /> Gift Image (SVG/PNG) — shown in selection grid</label>
                <div className="flex gap-2 items-center">
                  {form.imageUrl ? (
                    <div className="relative w-12 h-12 rounded-lg bg-slate-700 border border-slate-600 overflow-hidden flex-shrink-0">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={form.imageUrl} alt="gift" className="w-full h-full object-contain" />
                      <button onClick={() => set('imageUrl', '')} className="absolute top-0 right-0 bg-slate-900/80 rounded-bl p-0.5 text-slate-400 hover:text-red-400"><X size={9} /></button>
                    </div>
                  ) : (
                    <button onClick={() => imgInputRef.current?.click()} disabled={imgUploading || !form.name.trim()}
                      className="w-12 h-12 flex-shrink-0 rounded-lg bg-slate-700 border border-dashed border-slate-500 flex flex-col items-center justify-center gap-0.5 text-slate-500 hover:border-blue-400 hover:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                      {imgUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                      {imgUploading && <span className="text-[8px]">{imgProgress}%</span>}
                    </button>
                  )}
                  <input ref={imgInputRef} type="file" accept="image/svg+xml,image/png,image/webp" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(f) }} />
                  <p className="text-slate-500 text-[10px]">{form.imageUrl ? '✓ Image uploaded' : 'Tap to upload SVG or PNG (max 5 MB)'}</p>
                </div>
              </div>

              {/* Lottie upload */}
              <div>
                <label className="block text-slate-400 text-xs mb-1.5 flex items-center gap-1"><Sparkles size={11} /> Lottie Animation — plays fullscreen when gift is sent</label>
                <select
                  value={BUNDLED_LOTTIE.find(b => b.key === form.lottieAsset) ? form.lottieAsset : ''}
                  onChange={e => set('lottieAsset', e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-blue-500 mb-2">
                  <option value="">— Use uploaded Lottie or none —</option>
                  {BUNDLED_LOTTIE.map(b => <option key={b.key} value={b.key}>📦 {b.label} (bundled)</option>)}
                </select>
                <div className="flex gap-2 items-center mb-2">
                  <input
                    value={BUNDLED_LOTTIE.find(b => b.key === form.lottieAsset) ? '' : form.lottieAsset}
                    onChange={e => set('lottieAsset', e.target.value)}
                    placeholder="Paste URL — e.g. zipperlive.web.app/lottie/gifts/couple.json"
                    className="flex-1 bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-1.5 text-[11px] focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
                  />
                  {form.lottieAsset && !BUNDLED_LOTTIE.find(b => b.key === form.lottieAsset) && (
                    <button onClick={() => set('lottieAsset', '')} className="text-slate-600 hover:text-red-400 flex-shrink-0"><X size={12} /></button>
                  )}
                </div>
                <div className="flex gap-2 items-center">
                  <button onClick={() => lottieInputRef.current?.click()} disabled={lottieUploading || !form.name.trim()}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 border border-dashed border-slate-500 text-slate-400 hover:border-blue-400 hover:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed text-xs transition-colors flex-shrink-0">
                    {lottieUploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                    {lottieUploading ? `${lottieProgress}%` : 'Upload .json'}
                  </button>
                  <input ref={lottieInputRef} type="file" accept=".json,application/json" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleLottieUpload(f) }} />
                  <p className="text-slate-500 text-[10px]">
                    {form.lottieAsset
                      ? form.lottieAsset.startsWith('gifts/') ? '📦 Bundled'
                        : form.lottieAsset.startsWith('http')
                          ? <a href={`/lottie-test.html?url=${encodeURIComponent(form.lottieAsset)}`} target="_blank" rel="noreferrer" className="text-purple-400 underline hover:text-purple-300">🎬 Preview ↗</a>
                          : form.lottieAsset
                      : 'or upload .json below'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Category */}
          <div>
            <label className="block text-slate-400 text-xs mb-1.5">Category</label>
            <div className="grid grid-cols-3 gap-2">
              {(['normal', 'exclusive', 'lucky'] as Gift['category'][]).map(c => (
                <button key={c} onClick={() => handleCategoryChange(c)}
                  className={`py-2 px-3 rounded-lg text-xs font-medium border transition text-left ${
                    form.category === c ? 'bg-pink-500/20 border-pink-500/50 text-pink-300' : 'bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-500'
                  }`}>
                  <p className="font-semibold capitalize">{c}</p>
                  <p className="text-[10px] opacity-70 mt-0.5">{categoryMeta[c].desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Cost + Rate */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-400 text-xs mb-1.5">💎 Diamond Cost *</label>
              <input type="number" min={1} value={form.diamondCost} onChange={e => set('diamondCost', e.target.value)}
                placeholder="e.g. 100"
                className="w-full bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-pink-500" />
            </div>
            <div>
              <label className="block text-slate-400 text-xs mb-1.5">% Earning Rate{!rateFixed && <span className="text-slate-500 ml-1">({rateMin}–{rateMax}%)</span>}</label>
              {rateFixed ? (
                <div className="w-full bg-slate-900 border border-slate-700 text-slate-400 rounded-lg px-3 py-2.5 text-sm flex items-center gap-1.5">
                  <span className="font-bold text-white">{rateMin}%</span><span className="text-xs">(fixed)</span>
                </div>
              ) : (
                <input type="number" min={rateMin} max={rateMax} value={form.earningRate} onChange={e => set('earningRate', e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-pink-500" />
              )}
            </div>
          </div>

          {/* Beans preview */}
          {diamondCost > 0 && (
            <div className="bg-slate-900 rounded-xl p-3 flex items-center justify-between">
              <div className="text-center"><p className="text-[10px] text-slate-500 mb-0.5">User pays</p><p className="text-blue-300 font-bold">💎 {diamondCost.toLocaleString('en-IN')}</p></div>
              <span className="text-slate-600 text-xl">→</span>
              <div className="text-center"><p className="text-[10px] text-slate-500 mb-0.5">Host earns</p><p className="text-green-300 font-bold">🫘 {beansPreview.toLocaleString('en-IN')}</p></div>
              <span className="text-slate-600 text-xl">→</span>
              <div className="text-center"><p className="text-[10px] text-slate-500 mb-0.5">Platform keeps</p><p className="text-pink-300 font-bold">💎 {(diamondCost - beansPreview).toLocaleString('en-IN')}</p></div>
            </div>
          )}

          {/* Sort + Active */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <label className="block text-slate-400 text-xs mb-1.5">Sort Order</label>
              <input type="number" min={1} value={form.sortOrder} onChange={e => set('sortOrder', e.target.value)}
                className="w-full bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-pink-500" />
            </div>
            <div className="flex items-center justify-between flex-1 p-3 bg-slate-700/50 rounded-lg">
              <span className="text-white text-sm">Active</span>
              <button onClick={() => set('isActive', !form.isActive)} className="transition-colors">
                {form.isActive ? <ToggleRight size={28} className="text-green-400" /> : <ToggleLeft size={28} className="text-slate-500" />}
              </button>
            </div>
          </div>

          {err && <p className="text-red-400 text-sm flex items-center gap-1.5"><AlertTriangle size={13} />{err}</p>}
        </div>

        <div className="flex gap-3 px-6 pb-5">
          <button onClick={submit} disabled={saving || imgUploading || lottieUploading}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-pink-500 hover:bg-pink-400 disabled:opacity-50 text-white rounded-lg font-medium transition-colors">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {mode === 'add' ? 'Add Gift' : 'Save Changes'}
          </button>
          <button onClick={onClose} className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg font-medium transition-colors">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Bag Item Modal ─────────────────────────────────────────────────────────────
// Shared modal for all bag item categories (frame, id_frame, entrance, chat_bubble).
// Storage paths: contentAssets/bag_items/{folder}/{safeName}/image.{ext} + lottie.json
// animationUrl = Storage URL (same URL used by Android app — one source of truth)

function BagItemModal({
  item, fixedCategory, onClose, onSave,
}: {
  item?: BagItem
  fixedCategory: BagItem['category']
  onClose: () => void
  onSave: () => void
}) {
  const category = item?.category ?? fixedCategory
  const folder   = CAT_FOLDER[category]

  const [form, setForm] = useState({
    name:           item?.name           ?? '',
    category,
    source:         item?.source         ?? 'level' as BagItem['source'],
    unlockLevel:    item?.unlockLevel    ?? 0,
    minHostLevel:   item?.minHostLevel   ?? 0,
    price:          item?.price          ?? 0,
    previewUrl:     item?.previewUrl     ?? '',
    animationAsset: item?.animationAsset ?? '',
    animationUrl:   item?.animationUrl   ?? '',
    targetGender:   (item?.targetGender  ?? 'all') as BagItem['targetGender'],
    targetRole:     (item?.targetRole    ?? 'all') as BagItem['targetRole'],
    targetUserId:   item?.targetUserId   ?? '',
    isActive:       item?.isActive       ?? true,
  })
  const [saving,         setSaving]         = useState(false)
  const [previewPct,     setPreviewPct]     = useState(0)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [lottiePct,      setLottiePct]      = useState(0)
  const [lottieLoading,  setLottieLoading]  = useState(false)

  const nameReady   = form.name.trim().length > 0
  const safe        = toSafeName(form.name)
  const isEntrance  = category === 'entrance'
  const hasLottie   = ['frame', 'id_frame', 'entrance', 'profile_card'].includes(category)

  async function handlePreviewUpload(file: File) {
    if (!nameReady) return
    setPreviewLoading(true)
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
      const url = await uploadAsset(file, `contentAssets/bag_items/${folder}/${safe}/image.${ext}`, setPreviewPct)
      setForm(f => ({ ...f, previewUrl: url }))
    } catch (e) { console.error(e) } finally { setPreviewLoading(false) }
  }

  async function handleLottieUpload(file: File) {
    if (!nameReady) return
    setLottieLoading(true)
    try {
      const url = await uploadAsset(file, `contentAssets/bag_items/${folder}/${safe}/lottie.json`, setLottiePct)
      setForm(f => ({ ...f, animationUrl: url }))
    } catch (e) { console.error(e) } finally { setLottieLoading(false) }
  }

  async function handleSave() {
    if (!nameReady) return
    setSaving(true)
    try {
      await upsertBagItem(item?.id ?? null, { ...form, category })
      onSave(); onClose()
    } catch (e) { console.error(e) } finally { setSaving(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 overflow-y-auto">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md p-6 space-y-4 my-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">
            {item ? `Edit ${CAT_LABEL[category]}` : `Add ${CAT_LABEL[category]}`}
          </h3>
          <button onClick={onClose}><X size={20} className="text-zinc-400 hover:text-white" /></button>
        </div>

        <div className="space-y-3">
          {/* Name */}
          <div>
            <label className="block text-zinc-400 text-xs mb-1">Name *</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder={`e.g. Gold Wing ${CAT_LABEL[category]}`}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500" />
          </div>

          {!nameReady && (
            <p className="text-xs text-yellow-500/80 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-2">
              ⚠️ Enter a name first — used as the Storage folder name
            </p>
          )}

          {/* Source + Unlock + Price */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-zinc-400 text-xs mb-1">Source</label>
              <select value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value as BagItem['source'] }))}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm">
                {BAG_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-zinc-400 text-xs mb-1">Unlock Lv</label>
              <input type="number" min={0} value={form.unlockLevel}
                onChange={e => setForm(f => ({ ...f, unlockLevel: Number(e.target.value) }))}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm" />
            </div>
            <div>
              <label className="block text-zinc-400 text-xs mb-1">💎 Price</label>
              <input type="number" min={0} value={form.price}
                onChange={e => setForm(f => ({ ...f, price: Number(e.target.value) }))}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-white text-sm" />
            </div>
          </div>

          {/* Preview / asset image */}
          <UploadRow
            label={isEntrance ? 'Preview Image (thumbnail in bag grid)' : 'Asset Image (shown in bag + in-app)'}
            value={form.previewUrl} accept="image/*"
            disabled={!nameReady} disabledHint="Enter name first"
            uploading={previewLoading} progress={previewPct}
            onChange={url => setForm(f => ({ ...f, previewUrl: url }))}
            onUpload={handlePreviewUpload}
          />

          {/* Lottie — required for entrance, optional for others */}
          {hasLottie && (
            <UploadRow
              label={isEntrance
                ? 'Lottie Animation .json — plays when user enters a room'
                : 'Lottie Animation .json (optional)'}
              value={form.animationUrl} accept=".json,application/json"
              disabled={!nameReady} disabledHint="Enter name first"
              uploading={lottieLoading} progress={lottiePct}
              previewHref={`/lottie-test.html?url=${encodeURIComponent(form.animationUrl)}`}
              onChange={url => setForm(f => ({ ...f, animationUrl: url }))}
              onUpload={handleLottieUpload}
            />
          )}

          {/* Legacy bundled path */}
          <div>
            <label className="block text-zinc-400 text-xs mb-1">
              Bundled Asset Path <span className="text-zinc-600">(legacy APK reference)</span>
            </label>
            <input value={form.animationAsset}
              onChange={e => setForm(f => ({ ...f, animationAsset: e.target.value }))}
              placeholder="lottie/entries/entry_gold.json"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-400 text-sm" />
          </div>

          <div className="flex items-center gap-2">
            <button onClick={() => setForm(f => ({ ...f, isActive: !f.isActive }))}>
              {form.isActive
                ? <ToggleRight size={22} className="text-pink-400" />
                : <ToggleLeft size={22} className="text-zinc-500" />}
            </button>
            <span className="text-sm text-zinc-300">Active (visible in app)</span>
          </div>
        </div>

        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-4 py-2 rounded-lg text-sm">Cancel</button>
          <button onClick={handleSave} disabled={saving || !nameReady}
            className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm flex items-center justify-center gap-2">
            {saving && <Loader2 size={14} className="animate-spin" />}Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ContentPage() {
  const { crmUser, loading: authLoading } = useAuth()
  const [tab,        setTab]        = useState<Tab>('gifts')
  const [gifts,      setGifts]      = useState<Gift[]>([])
  const [bagItems,   setBagItems]   = useState<BagItem[]>([])
  const [econConfig, setEconConfig] = useState<EconomyConfig | null>(null)
  const [loading,    setLoading]    = useState(true)

  const [giftModal, setGiftModal] = useState<{ open: boolean; gift?: Gift }>({ open: false })
  const [bagModal,  setBagModal]  = useState<{
    open: boolean; item?: BagItem; category: BagItem['category']
  }>({ open: false, category: 'frame' })

  const rateRanges   = buildRateRanges(econConfig?.giftRates ?? null)
  const categoryMeta = buildCategoryMeta(econConfig?.giftRates ?? null)

  const load = async () => {
    setLoading(true)
    try {
      const [g, b, ec] = await Promise.all([getGifts(), getBagItems(), getEconomyConfig()])
      setGifts(g); setBagItems(b); setEconConfig(ec)
    } catch (e) { console.error(e) } finally { setLoading(false) }
  }

  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, ['superadmin', 'tech_admin', 'tech_member'])) return
    load()
  }, [crmUser])

  async function handleToggleGift(gift: Gift) {
    await toggleGift(gift.id, !gift.isActive); load()
  }
  async function handleToggleBag(item: BagItem) {
    await toggleBagItem(item.id, !item.isActive); load()
  }

  if (authLoading) return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-pink-500" />
    </div>
  )
  if (!crmUser || !canAccess(crmUser, ['superadmin', 'tech_admin', 'tech_member'])) {
    return <div className="flex items-center justify-center min-h-64"><p className="text-zinc-400">Access denied.</p></div>
  }

  const tabCategory = TAB_TO_CATEGORY[tab]
  const filteredBag = tabCategory ? bagItems.filter(b => b.category === tabCategory) : []

  const TAB_SINGULAR: Partial<Record<Tab, string>> = {
    cards:        'Profile Card',
    frames:       'Frame',
    id_frames:    'ID Frame',
    entrances:    'Entrance',
    chat_bubbles: 'Chat Bubble',
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">Content Management</h1>
        <p className="text-zinc-400 mt-1">Manage gifts, bag items, and profile cards</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-zinc-800 flex-wrap">
        {TABS.map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
              tab === key
                ? 'bg-zinc-800 text-white border-b-2 border-pink-500'
                : 'text-zinc-400 hover:text-white'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-400 py-12 justify-center">
          <Loader2 size={20} className="animate-spin" /><span>Loading...</span>
        </div>
      ) : (
        <>
          {/* ── Gifts ──────────────────────────────────────────────────────── */}
          {tab === 'gifts' && (
            <div className="space-y-4">
              <div className="flex justify-end">
                <button onClick={() => setGiftModal({ open: true })}
                  className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white px-4 py-2 rounded-lg text-sm font-medium">
                  <Plus size={16} />Add Gift
                </button>
              </div>
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">Name</th>
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">Category</th>
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">💎 Cost</th>
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">Lottie</th>
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">Status</th>
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gifts.length === 0 && (
                      <tr><td colSpan={6} className="text-center text-zinc-600 py-8">No gifts — click Add Gift to create one</td></tr>
                    )}
                    {gifts.map(g => (
                      <tr key={g.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                        <td className="px-4 py-3 text-white font-medium">
                          <div className="flex items-center gap-2">
                            {g.imageUrl
                              ? <img src={g.imageUrl} alt={g.name} className="w-8 h-8 rounded object-contain flex-shrink-0 bg-slate-800" />
                              : <span className="text-xl">{g.emoji}</span>}
                            {g.name}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span className="px-2 py-0.5 rounded-full text-xs bg-purple-500/20 text-purple-300 capitalize">{g.category}</span>
                        </td>
                        <td className="px-4 py-3 text-yellow-300 font-medium">💎 {g.diamondCost.toLocaleString()}</td>
                        <td className="px-4 py-3">
                          {g.lottieAsset
                            ? <a href={`/lottie-test.html?url=${encodeURIComponent(g.lottieAsset)}`}
                                target="_blank" rel="noreferrer"
                                className="text-purple-400 text-xs underline hover:text-purple-300">🎬 Preview</a>
                            : <span className="text-zinc-600 text-xs">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <button onClick={() => handleToggleGift(g)} className="flex items-center gap-1.5 text-sm">
                            {g.isActive
                              ? <><ToggleRight size={20} className="text-green-400" /><span className="text-green-400">Active</span></>
                              : <><ToggleLeft size={20} className="text-zinc-500" /><span className="text-zinc-500">Inactive</span></>}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <button onClick={() => setGiftModal({ open: true, gift: g })}
                            className="flex items-center gap-1 text-zinc-400 hover:text-pink-400 transition-colors">
                            <Edit2 size={14} />Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Bag Item tabs: Profile Cards / Frames / ID Frames / Entrances / Chat Bubbles ── */}
          {tabCategory && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-zinc-400 text-sm">
                  {filteredBag.length} {TAB_SINGULAR[tab]?.toLowerCase()}{filteredBag.length !== 1 ? 's' : ''} configured
                </p>
                <button
                  onClick={() => setBagModal({ open: true, category: tabCategory })}
                  className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white px-4 py-2 rounded-lg text-sm font-medium">
                  <Plus size={16} />Add {TAB_SINGULAR[tab]}
                </button>
              </div>

              <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">Name</th>
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">Source</th>
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">Unlock</th>
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">Price (💎)</th>
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">Lottie</th>
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">Status</th>
                      <th className="text-left text-zinc-500 font-medium px-4 py-3">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredBag.length === 0 && (
                      <tr><td colSpan={7} className="text-center text-zinc-600 py-8">
                        No {TAB_SINGULAR[tab]?.toLowerCase()}s yet — click Add {TAB_SINGULAR[tab]} to create one
                      </td></tr>
                    )}
                    {filteredBag.map(item => (
                      <tr key={item.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
                        <td className="px-4 py-3 text-white font-medium flex items-center gap-2">
                          {item.previewUrl && (
                            <img src={item.previewUrl} alt={item.name}
                              className="w-8 h-8 rounded object-cover flex-shrink-0" />
                          )}
                          {item.name}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs capitalize ${
                            item.source === 'level'       ? 'bg-cyan-500/20 text-cyan-300' :
                            item.source === 'event'       ? 'bg-purple-500/20 text-purple-300' :
                                                            'bg-yellow-500/20 text-yellow-300'
                          }`}>{item.source}</span>
                        </td>
                        <td className="px-4 py-3 text-zinc-400">{item.unlockLevel > 0 ? `Lv ${item.unlockLevel}` : '—'}</td>
                        <td className="px-4 py-3 text-yellow-300">{item.price > 0 ? item.price.toLocaleString() : '—'}</td>
                        <td className="px-4 py-3">
                          {item.animationUrl
                            ? <a href={`/lottie-test.html?url=${encodeURIComponent(item.animationUrl)}`}
                                target="_blank" rel="noreferrer"
                                className="text-purple-400 text-xs underline hover:text-purple-300">🎬 Preview</a>
                            : <span className="text-zinc-600 text-xs">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <button onClick={() => handleToggleBag(item)} className="flex items-center gap-1.5 text-sm">
                            {item.isActive
                              ? <><ToggleRight size={20} className="text-green-400" /><span className="text-green-400">Active</span></>
                              : <><ToggleLeft size={20} className="text-zinc-500" /><span className="text-zinc-500">Inactive</span></>}
                          </button>
                        </td>
                        <td className="px-4 py-3">
                          <button onClick={() => setBagModal({ open: true, item, category: item.category })}
                            className="flex items-center gap-1 text-zinc-400 hover:text-pink-400 transition-colors">
                            <Edit2 size={14} />Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Modals */}
      {giftModal.open && (
        <GiftModal
          mode={giftModal.gift ? 'edit' : 'add'}
          initial={giftModal.gift}
          rateRanges={rateRanges}
          categoryMeta={categoryMeta}
          onClose={() => setGiftModal({ open: false })}
          onSaved={load}
        />
      )}
      {bagModal.open && (
        <BagItemModal
          item={bagModal.item}
          fixedCategory={bagModal.category}
          onClose={() => setBagModal(m => ({ ...m, open: false }))}
          onSave={load}
        />
      )}
    </div>
  )
}
