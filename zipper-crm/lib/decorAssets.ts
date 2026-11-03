/**
 * B13 (4 Nov 2026) — the decoration fields the CRM writes on `gifts` and `bagItems`, and how it writes them.
 *
 * No imports and no React on purpose, so the real module compiles and runs standalone (`npm run test:decor`).
 *
 * Two bugs this exists to stop:
 *
 *  1. `updateGift` sent `imageUrl: undefined` whenever a gift had no picture (every emoji gift), and the Firestore web
 *     SDK refuses `undefined` outright ("Unsupported field value: undefined"). So an emoji gift could be created but
 *     never edited again. Clearing a URL in the editor must also CLEAR it in Firestore — dropping the key would leave
 *     the old animation playing — so a cleared asset field is written as ''.
 *
 *  2. The bag-items page saved with `setDoc` and no merge. That REPLACES the document, so saving a row deleted every
 *     field the page does not show: `videoUrl` (the MP4 entrances `scripts/upload-entrances.cjs` writes) and
 *     `durations` (the timed price list `purchaseBagItem` sells from — without it the server sells the item at the flat
 *     `price`, permanently). Editing a level lock quietly turned a 7-day rental into a lifetime purchase.
 */

/** Gift fields that hold an asset reference. Empty string means "none". */
export const GIFT_ASSET_FIELDS = ['imageUrl', 'lottieAsset', 'svgaUrl'] as const

/**
 * A gift update the Firestore SDK will accept: `undefined` asset fields become '' (cleared), any other `undefined`
 * field is left out (unchanged).
 */
export function giftPatch(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) out[k] = v
    else if ((GIFT_ASSET_FIELDS as readonly string[]).includes(k)) out[k] = ''
  }
  return out
}

/** How big an SVGA avatar frame is drawn, relative to the photo inside it. Store files differ (some have wings). */
export const FRAME_SCALE_DEFAULT = 1.3
export const FRAME_SCALE_MIN = 1.0
export const FRAME_SCALE_MAX = 2.5

/** The frame scale to store, from what was typed. Blank → the default; out of range → clamped; junk → null. */
export function frameScaleOf(input: string | number | undefined | null): number | null {
  if (input === undefined || input === null || String(input).trim() === '') return FRAME_SCALE_DEFAULT
  const n = Number(String(input).trim())
  if (!Number.isFinite(n)) return null
  const clamped = Math.min(FRAME_SCALE_MAX, Math.max(FRAME_SCALE_MIN, n))
  return Math.round(clamped * 100) / 100
}

/**
 * An SVGA image key: the name of the layer the app swaps for the user's photo or name. Bought files use their own
 * names ("head", "nickname", "img_12"…), so the CRM lets the owner type them — but only plain identifiers, because the
 * value is handed straight to the player.
 */
export function svgaKeyOk(key: string): boolean {
  return key === '' || /^[A-Za-z0-9_.\-]{1,64}$/.test(key)
}

export type AssetKind = 'svga' | 'mp4' | 'lottie' | 'image'

/** What a file is, from its name — decides which field an upload fills. */
export function assetKindOf(fileName: string): AssetKind | null {
  const ext = fileName.toLowerCase().split('?')[0].split('.').pop() ?? ''
  if (ext === 'svga') return 'svga'
  if (ext === 'mp4') return 'mp4'
  if (ext === 'json') return 'lottie'
  if (['png', 'webp', 'jpg', 'jpeg', 'svg', 'gif'].includes(ext)) return 'image'
  return null
}

/**
 * The content type to upload a file with, or undefined to let the SDK use the browser's. Browsers know no MIME type
 * for .svga (File.type is ''), and storage.rules admits octet-stream ONLY for a name ending in .svga — so an SVGA is
 * labelled explicitly, and nothing else is.
 */
export function uploadContentType(fileName: string): string | undefined {
  return assetKindOf(fileName) === 'svga' ? 'application/octet-stream' : undefined
}

/** The bag item fields this page owns. Everything else on the document (durations, videoUrl from scripts…) is kept. */
export interface BagItemEditable {
  name: string
  category: string
  previewUrl: string
  unlockLevel: number
  minHostLevel: number
  price: number
  source: string
  animationAsset: string
  animationUrl?: string
  svgaUrl?: string
  videoUrl?: string
  svgaAvatarKey?: string
  svgaNameKey?: string
  frameScale?: number
  targetGender?: string
  targetRole?: string
  targetUserId?: string
  isActive: boolean
}

/** What the bag-items page writes — always with `{ merge: true }`. */
export function bagItemWrite(item: BagItemEditable): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: item.name,
    category: item.category,
    previewUrl: item.previewUrl ?? '',
    unlockLevel: item.unlockLevel,
    minHostLevel: item.minHostLevel,
    price: item.price,
    source: item.source,
    animationAsset: item.animationAsset ?? '',
    animationUrl: item.animationUrl ?? '',
    svgaUrl: item.svgaUrl ?? '',
    targetGender: item.targetGender ?? 'all',
    targetRole: item.targetRole ?? 'all',
    targetUserId: item.targetUserId ?? '',
    isActive: item.isActive,
  }
  // Only written when the page holds a value: an MP4 that a script uploaded must survive a save from a page that was
  // opened before the upload.
  if (item.videoUrl !== undefined) out.videoUrl = item.videoUrl
  if (item.category === 'entrance') {
    out.svgaAvatarKey = item.svgaAvatarKey ?? ''
    out.svgaNameKey = item.svgaNameKey ?? ''
  }
  if (item.category === 'frame' && item.frameScale !== undefined) out.frameScale = item.frameScale
  return out
}
