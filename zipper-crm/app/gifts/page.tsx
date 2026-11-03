'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import {
  Loader2, Plus, Pencil, Trash2, X, Check, AlertTriangle,
  ToggleLeft, ToggleRight, Gift, Sparkles, Search, Info, Upload, ImageIcon,
} from 'lucide-react'
import {
  getGifts, createGift, updateGift, deleteGift, toggleGiftActive,
  computeBeanValue, CATEGORY_DEFAULT_RATES, CATEGORY_RATE_RANGES,
  type Gift as GiftType,
} from '@/lib/gifts'
import { getEconomyConfig, type EconomyConfig } from '@/lib/economyConfig'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { ref as storageRef, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { uploadContentType } from '@/lib/decorAssets'
import { storage } from '@/lib/firebase'

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORIES: GiftType['category'][] = ['normal', 'exclusive', 'lucky']

/** Lottie JSON files bundled in the Android app under assets/gifts/ */
const BUNDLED_LOTTIE: { key: string; label: string }[] = [
  { key: 'gifts/g1_rose.json',   label: 'Rose' },
  { key: 'gifts/g2_heart.json',  label: 'Heart' },
  { key: 'gifts/g3_kiss.json',   label: 'Kiss' },
  { key: 'gifts/g4_teddy.json',  label: 'Teddy Bear' },
  { key: 'gifts/g5_ring.json',   label: 'Diamond Ring' },
  { key: 'gifts/g6_crown.json',  label: 'Crown' },
  { key: 'gifts/g7_car.json',    label: 'Sports Car' },
  { key: 'gifts/g8_yacht.json',  label: 'Yacht' },
  { key: 'gifts/g9_rocket.json', label: 'Rocket' },
  { key: 'gifts/g10_castle.json',label: 'Castle' },
]

const CATEGORY_COLORS: Record<GiftType['category'], string> = {
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
    normal:    { color: CATEGORY_COLORS.normal,    label: 'Normal',    desc: `Host earns ${normalPct}%`, normalPct },
    exclusive: { color: CATEGORY_COLORS.exclusive, label: 'Exclusive', desc: `Host earns ${excMin}–${excMax}%`, excMin, excMax },
    lucky:     { color: CATEGORY_COLORS.lucky,     label: 'Lucky',     desc: `Host earns ${luckyPct}% · lucky draw`, luckyPct },
  }
}

function buildRateRanges(gr: EconomyConfig['giftRates'] | null): Record<GiftType['category'], [number, number]> {
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

const DEFAULT_GIFTS: Omit<GiftType, 'id' | 'createdAt'>[] = [
  { name: 'Rose',       emoji: '🌹', diamondCost: 1,     earningRate: 50, category: 'normal',    isActive: true, sortOrder: 1 },
  { name: 'Heart',      emoji: '❤️', diamondCost: 10,    earningRate: 50, category: 'normal',    isActive: true, sortOrder: 2 },
  { name: 'Teddy Bear', emoji: '🧸', diamondCost: 50,    earningRate: 50, category: 'normal',    isActive: true, sortOrder: 3 },
  { name: 'Crown',      emoji: '👑', diamondCost: 100,   earningRate: 52, category: 'exclusive', isActive: true, sortOrder: 4 },
  { name: 'Sports Car', emoji: '🏎️', diamondCost: 500,   earningRate: 54, category: 'exclusive', isActive: true, sortOrder: 5 },
  { name: 'Rocket',     emoji: '🚀', diamondCost: 1000,  earningRate: 55, category: 'exclusive', isActive: true, sortOrder: 6 },
  { name: 'Lucky Box',  emoji: '🎲', diamondCost: 50,    earningRate: 5,  category: 'lucky',     isActive: true, sortOrder: 7 },
  { name: 'Super Star', emoji: '⭐', diamondCost: 5000,  earningRate: 55, category: 'exclusive', isActive: true, sortOrder: 8 },
]

// Effective earning rate for a gift — fixed categories use economy config, exclusive uses per-gift value
function effectiveRate(gift: GiftType, rateRanges: Record<GiftType['category'], [number, number]>): number {
  if (gift.category === 'exclusive') return gift.earningRate   // per-gift rate, within the range
  return rateRanges[gift.category][0]                          // normal/lucky: always use config rate
}

type MsgState = { type: 'success' | 'error'; text: string } | null

// ── Gift Form Modal ────────────────────────────────────────────────────────────

interface FormState {
  name: string
  emoji: string
  imageUrl: string       // Firebase Storage URL for the gift thumbnail shown in app grid
  lottieAsset: string    // Bundled asset key (e.g. "gifts/g1_rose.json") or remote URL
  svgaUrl: string        // B13: SVGA animation URL — preferred over Lottie when both are set
  diamondCost: string
  earningRate: string
  category: GiftType['category']
  sortOrder: string
  isActive: boolean
}

function emptyForm(): FormState {
  return { name: '', emoji: '🎁', imageUrl: '', lottieAsset: '', svgaUrl: '', diamondCost: '', earningRate: '50', category: 'normal', sortOrder: '99', isActive: true }
}

function fromGift(g: GiftType, rateRanges: Record<GiftType['category'], [number, number]>): FormState {
  // For fixed-rate categories, always use the config rate (not the stale stored value)
  const rate = g.category === 'exclusive' ? g.earningRate : rateRanges[g.category][0]
  return {
    name: g.name, emoji: g.emoji, imageUrl: g.imageUrl ?? '', lottieAsset: g.lottieAsset ?? '', svgaUrl: g.svgaUrl ?? '',
    diamondCost: String(g.diamondCost), earningRate: String(rate), category: g.category,
    sortOrder: String(g.sortOrder), isActive: g.isActive,
  }
}

// Upload a gift asset to contentAssets/gifts/{giftName}/{type}
// Mirrors the entrance structure: contentAssets/bag_items/entrances/{name}/lottie.json + thumbnail.jpg
// Fixed filenames per gift so re-uploads overwrite the old file cleanly.
async function uploadGiftAsset(
  file: File,
  type: 'image' | 'lottie' | 'svga',
  giftName: string,
  onProgress: (pct: number) => void,
): Promise<string> {
  const safeName = giftName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'gift'
  const ext      = file.name.split('.').pop()?.toLowerCase() || (type === 'lottie' ? 'json' : 'png')
  const fileName = type === 'lottie' ? 'lottie.json' : type === 'svga' ? 'animation.svga' : `image.${ext}`
  const path     = `contentAssets/gifts/${safeName}/${fileName}`
  const sRef     = storageRef(storage, path)
  const ct       = uploadContentType(file.name)  // B13: label an .svga (storage.rules admits octet-stream only for .svga)
  const task     = ct ? uploadBytesResumable(sRef, file, { contentType: ct }) : uploadBytesResumable(sRef, file)
  await new Promise<void>((resolve, reject) =>
    task.on('state_changed',
      snap => onProgress(Math.round(snap.bytesTransferred / snap.totalBytes * 100)),
      reject,
      () => resolve(),
    ),
  )
  return getDownloadURL(sRef)
}

function GiftModal({
  mode, initial, rateRanges, categoryMeta, onClose, onSaved,
}: {
  mode: 'add' | 'edit'
  initial?: GiftType
  rateRanges: Record<GiftType['category'], [number, number]>
  categoryMeta: ReturnType<typeof buildCategoryMeta>
  onClose: () => void
  onSaved: (gift: GiftType) => void
}) {
  const [form, setForm] = useState<FormState>(initial ? fromGift(initial, rateRanges) : emptyForm())
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  // Two upload slots — image thumbnail + lottie JSON
  const [imgUploading,    setImgUploading]    = useState(false)
  const [imgProgress,     setImgProgress]     = useState(0)
  const [lottieUploading, setLottieUploading] = useState(false)
  const [lottieProgress,  setLottieProgress]  = useState(0)

  const imgInputRef    = useRef<HTMLInputElement>(null)
  const lottieInputRef = useRef<HTMLInputElement>(null)

  // giftMode: emoji = auto-animated emoji, image = custom SVG + lottie
  const [giftMode, setGiftMode] = useState<'emoji' | 'image'>(
    initial?.imageUrl ? 'image' : 'emoji',
  )

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(f => ({ ...f, [k]: v }))

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
      const jsonText = await file.text()
      JSON.parse(jsonText) // validate early
      // Upload to contentAssets/gifts/{safeName}/lottie.json — same URL used by Android app
      const url = await uploadGiftAsset(file, 'lottie', form.name, setLottieProgress)
      set('lottieAsset', url)
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Lottie upload failed.') }
    finally { setLottieUploading(false) }
  }

  // B13: an SVGA file (tools/decor builds them). 2.x files are zlib, 1.x are zip — the player reads both.
  const [svgaUploading, setSvgaUploading] = useState(false)
  const [svgaProgress, setSvgaProgress] = useState(0)
  const svgaInputRef = useRef<HTMLInputElement>(null)
  async function handleSvgaUpload(file: File) {
    if (!file.name.toLowerCase().endsWith('.svga')) { setErr('The animation must be an .svga file.'); return }
    if (file.size > 5 * 1024 * 1024) { setErr('That SVGA is over 5 MB — too heavy for phones. Re-export it smaller.'); return }
    if (!form.name.trim()) { setErr('Enter a gift name before uploading.'); return }
    setSvgaUploading(true); setSvgaProgress(0)
    try {
      const url = await uploadGiftAsset(file, 'svga', form.name, setSvgaProgress)
      set('svgaUrl', url)
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : 'SVGA upload failed.') }
    finally { setSvgaUploading(false) }
  }

  // When category changes, reset earningRate to default for that category
  function handleCategoryChange(cat: GiftType['category']) {
    set('category', cat)
    set('earningRate', String(rateRanges[cat][0]))
  }

  const diamondCost  = parseInt(form.diamondCost) || 0
  const earningRate  = parseInt(form.earningRate) || 0
  const beansPreview = computeBeanValue(diamondCost, earningRate)
  const [rateMin, rateMax] = rateRanges[form.category]
  const rateFixed = rateMin === rateMax

  async function submit() {
    if (!form.name.trim()) { setErr('Name is required.'); return }
    if (isNaN(diamondCost) || diamondCost < 1) { setErr('Diamond cost must be ≥ 1.'); return }
    if (isNaN(earningRate) || earningRate < rateMin || earningRate > rateMax) {
      setErr(`Earning rate for ${form.category} must be ${rateMin === rateMax ? rateMin : `${rateMin}–${rateMax}`}%.`)
      return
    }
    setSaving(true); setErr('')
    try {
      const data: Omit<GiftType, 'id' | 'createdAt'> = {
        name: form.name.trim(), emoji: form.emoji || '🎁',
        imageUrl: form.imageUrl.trim() || undefined,
        lottieAsset: form.lottieAsset.trim() || undefined,
        svgaUrl: form.svgaUrl.trim() || undefined,
        diamondCost, earningRate, category: form.category,
        sortOrder: parseInt(form.sortOrder) || 99, isActive: form.isActive,
      }
      if (mode === 'add') {
        const id = await createGift(data)
        onSaved({ id, createdAt: null, ...data })
      } else if (initial) {
        await updateGift(initial.id, data)
        onSaved({ ...initial, ...data })
      }
      onClose()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Save failed.')
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

          {/* Name row */}
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
                  giftMode === 'emoji'
                    ? 'bg-yellow-500/15 border-yellow-500/40 text-yellow-300'
                    : 'bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-500'
                }`}>
                <p className="font-semibold">Emoji</p>
                <p className="text-[10px] opacity-70 mt-0.5">Auto-animated on screen</p>
              </button>
              <button onClick={() => setGiftMode('image')}
                className={`py-2.5 px-3 rounded-lg text-xs font-medium border transition text-left ${
                  giftMode === 'image'
                    ? 'bg-blue-500/15 border-blue-500/40 text-blue-300'
                    : 'bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-500'
                }`}>
                <p className="font-semibold">Custom Image</p>
                <p className="text-[10px] opacity-70 mt-0.5">SVG + Lottie animation</p>
              </button>
            </div>
          </div>

          {/* ── EMOJI MODE ─────────────────────────────────────────────────── */}
          {giftMode === 'emoji' && (
            <div className="flex gap-3 items-end">
              <div>
                <label className="block text-slate-400 text-xs mb-1.5">Emoji</label>
                <input value={form.emoji} onChange={e => set('emoji', e.target.value)}
                  className="w-16 text-center text-2xl bg-slate-700 border border-slate-600 text-white rounded-lg px-2 py-2 focus:outline-none focus:border-yellow-500" />
              </div>
              <div className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2.5">
                <p className="text-yellow-400 text-xs font-medium">✨ Auto animation</p>
                <p className="text-slate-500 text-[10px] mt-0.5">The emoji bounces & pulses fullscreen when the gift is sent. No Lottie file needed.</p>
              </div>
            </div>
          )}

          {/* ── IMAGE MODE ─────────────────────────────────────────────────── */}
          {giftMode === 'image' && (
            <div className="space-y-3">
              {/* Name-required hint */}
              {!form.name.trim() && (
                <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-xs">
                  <AlertTriangle size={11} /> Enter a gift name above before uploading files
                </div>
              )}

              {/* SVG image upload */}
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
                      title={!form.name.trim() ? 'Enter gift name first' : undefined}
                      className="w-12 h-12 flex-shrink-0 rounded-lg bg-slate-700 border border-dashed border-slate-500 flex flex-col items-center justify-center gap-0.5 text-slate-500 hover:border-blue-400 hover:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-slate-500 disabled:hover:text-slate-500 transition-colors">
                      {imgUploading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                      {imgUploading && <span className="text-[8px]">{imgProgress}%</span>}
                    </button>
                  )}
                  <input ref={imgInputRef} type="file" accept="image/svg+xml,image/png,image/webp" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleImageUpload(f) }} />
                  <p className="text-slate-500 text-[10px]">{form.imageUrl ? '✓ Image uploaded' : 'Tap to upload SVG or PNG (max 5 MB)'}</p>
                </div>
              </div>

              {/* Lottie animation upload */}
              <div>
                <label className="block text-slate-400 text-xs mb-1.5 flex items-center gap-1"><Sparkles size={11} /> Lottie Animation — plays fullscreen when gift is sent</label>

                {/* Bundled presets */}
                <select
                  value={BUNDLED_LOTTIE.find(b => b.key === form.lottieAsset) ? form.lottieAsset : ''}
                  onChange={e => set('lottieAsset', e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-blue-500 mb-2">
                  <option value="">— Use uploaded Lottie or none —</option>
                  {BUNDLED_LOTTIE.map(b => (
                    <option key={b.key} value={b.key}>📦 {b.label} (bundled)</option>
                  ))}
                </select>

                {/* URL paste (CRM public or Firebase Storage) */}
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

                {/* Upload new Lottie JSON */}
                <div className="flex gap-2 items-center">
                  <button onClick={() => lottieInputRef.current?.click()} disabled={lottieUploading || !form.name.trim()}
                    title={!form.name.trim() ? 'Enter gift name first' : undefined}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 border border-dashed border-slate-500 text-slate-400 hover:border-blue-400 hover:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-slate-500 disabled:hover:text-blue-400 text-xs transition-colors flex-shrink-0">
                    {lottieUploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                    {lottieUploading ? `${lottieProgress}%` : 'Upload .json'}
                  </button>
                  <input ref={lottieInputRef} type="file" accept=".json,application/json" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleLottieUpload(f) }} />
                  <p className="text-slate-500 text-[10px]">
                    {form.lottieAsset
                      ? form.lottieAsset.startsWith('gifts/') ? '📦 Bundled'
                        : form.lottieAsset.startsWith('http') ? (
                            // Preview link — lottie-test.html fetches directly from Storage URL
                            // (works once Firebase Storage CORS is configured on the bucket)
                            <a href={`/lottie-test.html?url=${encodeURIComponent(form.lottieAsset)}`}
                              target="_blank" rel="noreferrer"
                              className="text-purple-400 underline hover:text-purple-300">
                              🎬 Preview ↗
                            </a>
                          )
                        : form.lottieAsset
                      : 'or upload .json below'}
                  </p>
                </div>
              </div>

              {/* B13: SVGA animation — preferred over Lottie in the app when both are set */}
              <div>
                <label className="block text-slate-400 text-xs mb-1.5 flex items-center gap-1"><Sparkles size={11} /> SVGA Animation — plays full screen when sent (preferred over Lottie)</label>
                <div className="flex gap-2 items-center">
                  <button onClick={() => svgaInputRef.current?.click()} disabled={svgaUploading || !form.name.trim()}
                    title={!form.name.trim() ? 'Enter gift name first' : undefined}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-700 border border-dashed border-slate-500 text-slate-400 hover:border-blue-400 hover:text-blue-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-slate-500 text-xs transition-colors flex-shrink-0">
                    {svgaUploading ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
                    {svgaUploading ? `${svgaProgress}%` : 'Upload .svga'}
                  </button>
                  <input ref={svgaInputRef} type="file" accept=".svga" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleSvgaUpload(f) }} />
                  <p className="text-slate-500 text-[10px] truncate flex-1">{form.svgaUrl ? '✓ SVGA uploaded' : 'Optional — max 5 MB'}</p>
                  {form.svgaUrl && (
                    <button onClick={() => set('svgaUrl', '')} className="text-slate-600 hover:text-red-400 flex-shrink-0" title="Remove the SVGA"><X size={12} /></button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Category */}
          <div>
            <label className="block text-slate-400 text-xs mb-1.5">Category</label>
            <div className="grid grid-cols-3 gap-2">
              {CATEGORIES.map(c => (
                <button key={c} onClick={() => handleCategoryChange(c)}
                  className={`py-2 px-3 rounded-lg text-xs font-medium border transition text-left ${
                    form.category === c
                      ? 'bg-pink-500/20 border-pink-500/50 text-pink-300'
                      : 'bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-500'
                  }`}>
                  <p className="font-semibold capitalize">{c}</p>
                  <p className="text-[10px] opacity-70 mt-0.5">{categoryMeta[c].desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Diamond Cost + Earning Rate */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-400 text-xs mb-1.5">💎 Diamond Cost *</label>
              <input type="number" min={1} value={form.diamondCost} onChange={e => set('diamondCost', e.target.value)}
                placeholder="e.g. 100"
                className="w-full bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-pink-500" />
            </div>
            <div>
              <label className="block text-slate-400 text-xs mb-1.5">
                % Earning Rate
                {!rateFixed && <span className="text-slate-500 ml-1">({rateMin}–{rateMax}%)</span>}
              </label>
              {rateFixed ? (
                <div className="w-full bg-slate-900 border border-slate-700 text-slate-400 rounded-lg px-3 py-2.5 text-sm flex items-center gap-1.5">
                  <span className="font-bold text-white">{rateMin}%</span>
                  <span className="text-xs">(fixed for {form.category})</span>
                </div>
              ) : (
                <input type="number" min={rateMin} max={rateMax} value={form.earningRate}
                  onChange={e => set('earningRate', e.target.value)}
                  className="w-full bg-slate-700 border border-slate-600 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-pink-500" />
              )}
            </div>
          </div>

          {/* Preview */}
          {diamondCost > 0 && (
            <div className="bg-slate-900 rounded-xl p-3 flex items-center justify-between">
              <div className="text-center">
                <p className="text-[10px] text-slate-500 mb-0.5">User pays</p>
                <p className="text-blue-300 font-bold">💎 {diamondCost.toLocaleString('en-IN')}</p>
              </div>
              <span className="text-slate-600 text-xl">→</span>
              <div className="text-center">
                <p className="text-[10px] text-slate-500 mb-0.5">Host earns</p>
                <p className="text-green-300 font-bold">🫘 {beansPreview.toLocaleString('en-IN')}</p>
              </div>
              <span className="text-slate-600 text-xl">→</span>
              <div className="text-center">
                <p className="text-[10px] text-slate-500 mb-0.5">Platform keeps</p>
                <p className="text-pink-300 font-bold">💎 {(diamondCost - beansPreview).toLocaleString('en-IN')}</p>
              </div>
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
                {form.isActive
                  ? <ToggleRight size={28} className="text-green-400" />
                  : <ToggleLeft size={28} className="text-slate-500" />}
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

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function GiftsPage() {
  const { crmUser } = useAuth()
  const canEdit = canAccess(crmUser, ['superadmin', 'app_admin', 'ops_admin', 'ops_member'])

  const [gifts, setGifts]           = useState<GiftType[]>([])
  const [loading, setLoading]       = useState(true)
  const [econConfig, setEconConfig] = useState<EconomyConfig | null>(null)
  const [search, setSearch]         = useState('')
  const [catFilter, setCatFilter]   = useState<GiftType['category'] | 'all'>('all')
  const [msg, setMsg]               = useState<MsgState>(null)
  const [addModal, setAddModal]     = useState(false)
  const [editGift, setEditGift]     = useState<GiftType | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<GiftType | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [seeding, setSeeding]       = useState(false)

  useEffect(() => {
    getGifts().then(setGifts).catch(console.error).finally(() => setLoading(false))
    getEconomyConfig().then(setEconConfig).catch(console.error)
  }, [])

  const gr         = econConfig?.giftRates ?? null
  const catMeta    = buildCategoryMeta(gr)
  const rateRanges = buildRateRanges(gr)

  function flash(m: MsgState) { setMsg(m); setTimeout(() => setMsg(null), 4000) }

  async function handleToggle(gift: GiftType) {
    setTogglingId(gift.id)
    try {
      await toggleGiftActive(gift.id, !gift.isActive)
      setGifts(prev => prev.map(g => g.id === gift.id ? { ...g, isActive: !g.isActive } : g))
      flash({ type: 'success', text: `${gift.name} ${!gift.isActive ? 'activated' : 'deactivated'}.` })
    } catch { flash({ type: 'error', text: 'Toggle failed.' }) }
    finally { setTogglingId(null) }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeletingId(deleteTarget.id)
    try {
      await deleteGift(deleteTarget.id)
      setGifts(prev => prev.filter(g => g.id !== deleteTarget.id))
      flash({ type: 'success', text: `${deleteTarget.name} deleted.` })
      setDeleteTarget(null)
    } catch { flash({ type: 'error', text: 'Delete failed.' }) }
    finally { setDeletingId(null) }
  }

  async function seedDefaultGifts() {
    setSeeding(true)
    try {
      const created: GiftType[] = []
      for (const g of DEFAULT_GIFTS) {
        const id = await createGift(g)
        created.push({ id, createdAt: null, ...g })
      }
      setGifts(prev => [...prev, ...created].sort((a, b) => a.sortOrder - b.sortOrder))
      flash({ type: 'success', text: `${created.length} default gifts added.` })
    } catch { flash({ type: 'error', text: 'Seeding failed.' }) }
    finally { setSeeding(false) }
  }

  const filtered = useMemo(() => {
    let list = gifts
    if (catFilter !== 'all') list = list.filter(g => g.category === catFilter)
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(g => g.name.toLowerCase().includes(q))
    }
    return list
  }, [gifts, catFilter, search])

  const byCategory = (c: GiftType['category']) => gifts.filter(g => g.category === c)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white flex items-center gap-3">
            <Gift size={26} className="text-pink-400" />Gift Economy
          </h1>
          <p className="text-slate-400 mt-1 text-sm">
            {gifts.filter(g => g.isActive).length} active gifts · users spend diamonds → hosts earn beans
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2">
            {gifts.length === 0 && (
              <button onClick={seedDefaultGifts} disabled={seeding}
                className="flex items-center gap-2 px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
                {seeding ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}Seed Defaults
              </button>
            )}
            <button onClick={() => setAddModal(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-pink-500 hover:bg-pink-400 text-white rounded-lg text-sm font-medium transition-colors">
              <Plus size={15} />Add Gift
            </button>
          </div>
        )}
      </div>

      {/* Flash */}
      {msg && (
        <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl text-sm border ${
          msg.type === 'success' ? 'bg-green-500/10 border-green-500/30 text-green-400' : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          <span className="flex items-center gap-2">
            {msg.type === 'success' ? <Check size={14} /> : <AlertTriangle size={14} />}{msg.text}
          </span>
          <button onClick={() => setMsg(null)}><X size={13} /></button>
        </div>
      )}

      {/* Earning rate info banner — live from economy config */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-4">
        <div className="flex items-start gap-2 mb-3">
          <Info size={14} className="text-blue-400 mt-0.5 shrink-0" />
          <p className="text-slate-300 text-sm font-medium">Earning Rates — how much of each diamond goes to the host as beans</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {CATEGORIES.map(c => (
            <div key={c} className={`rounded-lg px-3 py-2.5 border text-sm ${catMeta[c].color}`}>
              <p className="font-semibold capitalize">{c}</p>
              <p className="text-xs opacity-80 mt-0.5">{catMeta[c].desc}</p>
              <p className="text-xs mt-1 opacity-60">{byCategory(c).length} gifts</p>
            </div>
          ))}
        </div>
      </div>

      {/* Flow diagram — simplified */}
      <div className="bg-slate-800/50 border border-slate-700 rounded-xl px-5 py-4 flex flex-wrap gap-4 text-sm items-center">
        <div className="flex items-center gap-2">
          <span className="text-2xl">👤</span>
          <div>
            <p className="text-slate-400 text-xs">User sends</p>
            <p className="text-white font-medium text-xs">Gift (diamonds)</p>
          </div>
        </div>
        <span className="text-slate-600 text-xl">→</span>
        <div className="flex items-center gap-2">
          <span className="text-2xl">🌟</span>
          <div>
            <p className="text-slate-400 text-xs">Host earns</p>
            <p className="text-white font-medium text-xs">
              Beans ({catMeta.normal.normalPct}% / {catMeta.exclusive.excMin}–{catMeta.exclusive.excMax}% / {catMeta.lucky.luckyPct}%)
            </p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search gifts…"
            className="w-full pl-8 pr-3 py-2 bg-slate-800 border border-slate-700 text-white rounded-lg text-sm focus:outline-none focus:border-pink-500 transition" />
        </div>
        <div className="flex bg-slate-800 border border-slate-700 rounded-lg p-1 gap-1">
          {(['all', ...CATEGORIES] as const).map(c => (
            <button key={c} onClick={() => setCatFilter(c)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition capitalize ${
                catFilter === c ? 'bg-pink-500 text-white' : 'text-slate-400 hover:text-white'
              }`}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="flex items-center gap-2 text-slate-400 py-12 justify-center">
          <Loader2 size={20} className="animate-spin" /><span>Loading gifts…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-slate-800 border border-slate-700 rounded-xl p-16 text-center">
          <Gift size={40} className="text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400 text-sm">No gifts yet</p>
          {gifts.length === 0 && canEdit && (
            <button onClick={seedDefaultGifts} disabled={seeding}
              className="mt-3 inline-flex items-center gap-2 px-4 py-2 bg-pink-500 hover:bg-pink-400 text-white rounded-lg text-sm font-medium transition-colors">
              <Sparkles size={14} />Seed default gifts
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(gift => {
            const rate   = effectiveRate(gift, rateRanges)
            const beans  = computeBeanValue(gift.diamondCost, rate)
            const margin = gift.diamondCost - beans
            const meta   = catMeta[gift.category]
            return (
              <div key={gift.id}
                className={`bg-slate-800 border rounded-xl p-4 transition-all ${
                  gift.isActive ? 'border-slate-700 hover:border-slate-600' : 'border-slate-800 opacity-60'
                }`}>
                {/* Top row */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    {gift.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={gift.imageUrl} alt={gift.name} className="w-10 h-10 object-contain rounded" />
                    ) : (
                      <span className="text-3xl">{gift.emoji}</span>
                    )}
                    <div>
                      <p className="text-white font-semibold text-sm">{gift.name}</p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${meta.color}`}>
                          {meta.label}
                        </span>
                        {gift.lottieAsset && (
                          <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border border-purple-500/40 text-purple-300 bg-purple-500/10">✨ Lottie</span>
                        )}
                      </div>
                    </div>
                  </div>
                  {canEdit && (
                    <button onClick={() => handleToggle(gift)} disabled={togglingId === gift.id}>
                      {togglingId === gift.id
                        ? <Loader2 size={18} className="animate-spin text-slate-500" />
                        : gift.isActive
                          ? <ToggleRight size={22} className="text-green-400" />
                          : <ToggleLeft size={22} className="text-slate-600" />}
                    </button>
                  )}
                </div>

                {/* Economy row */}
                <div className="grid grid-cols-3 gap-1.5 mb-3">
                  <div className="bg-slate-900 rounded-lg p-2 text-center">
                    <p className="text-[10px] text-slate-500 mb-0.5">Pays</p>
                    <p className="text-blue-300 font-bold text-sm">💎 {gift.diamondCost.toLocaleString('en-IN')}</p>
                  </div>
                  <div className="bg-slate-900 rounded-lg p-2 text-center">
                    <p className="text-[10px] text-slate-500 mb-0.5">Host earns</p>
                    <p className="text-green-300 font-bold text-sm">🫘 {beans.toLocaleString('en-IN')}</p>
                    <p className="text-[10px] text-slate-600">{rate}%</p>
                  </div>
                  <div className="bg-slate-900 rounded-lg p-2 text-center">
                    <p className="text-[10px] text-slate-500 mb-0.5">Platform</p>
                    <p className="text-pink-300 font-bold text-sm">💎 {margin.toLocaleString('en-IN')}</p>
                    <p className="text-[10px] text-slate-600">{100 - rate}%</p>
                  </div>
                </div>

                {gift.category === 'lucky' && (
                  <p className="text-[10px] text-pink-400/70 text-center mb-2">🎲 Lucky draw pool — host earns 5%, rest to prizes</p>
                )}

                {(gift.totalSent ?? 0) > 0 && (
                  <p className="text-xs text-slate-500 text-center mb-2">
                    Sent {gift.totalSent?.toLocaleString('en-IN')} times
                  </p>
                )}

                {canEdit && (
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => setEditGift(gift)}
                      className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded text-xs font-medium transition-colors">
                      <Pencil size={11} />Edit
                    </button>
                    <button onClick={() => setDeleteTarget(gift)}
                      className="flex items-center justify-center gap-1 px-2 py-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 rounded text-xs transition-colors">
                      <Trash2 size={11} />
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Modals */}
      {addModal && (
        <GiftModal mode="add" rateRanges={rateRanges} categoryMeta={catMeta}
          onClose={() => setAddModal(false)}
          onSaved={gift => setGifts(prev => [...prev, gift].sort((a, b) => a.sortOrder - b.sortOrder))} />
      )}
      {editGift && (
        <GiftModal mode="edit" initial={editGift} rateRanges={rateRanges} categoryMeta={catMeta}
          onClose={() => setEditGift(null)}
          onSaved={updated => setGifts(prev => prev.map(g => g.id === updated.id ? updated : g))} />
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <div className="text-center mb-5">
              <span className="text-4xl">{deleteTarget.emoji}</span>
              <h3 className="text-white font-semibold mt-2">Delete {deleteTarget.name}?</h3>
              <p className="text-slate-400 text-sm mt-1">Cannot be undone. Historical gift data is not affected.</p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setDeleteTarget(null)}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-lg px-4 py-2.5 text-sm transition-colors">Cancel</button>
              <button onClick={handleDelete} disabled={!!deletingId}
                className="flex-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-medium rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-2">
                {deletingId ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
