'use client'

/**
 * BagItemThumb — renders the visual design for any bag-item category.
 * Colours taken directly from MyBagScreen.kt (TIER, bubbleGradient, cardGradient, bannerGradient).
 * Works for sizes 40 (table row) and 192 (popover preview).
 */

interface Props {
  id: string
  category: string
  name: string
  previewUrl?: string
  size?: number
  onClick?: () => void
}

// ── Frame tier palette (mirrors TIER map in MyBagScreen.kt) ──────────────────
const FRAME_TIERS: Record<string, { ring1: string; ring2: string; glow: string }> = {
  af_basic:  { ring1: '#4A4A4A', ring2: '#A8A8A8', glow: '#DCDCDC' },
  af_bronze: { ring1: '#6B3A2A', ring2: '#CD7F32', glow: '#E8A867' },
  af_silver: { ring1: '#4A4A4A', ring2: '#A8A8A8', glow: '#DCDCDC' },
  af_gold:   { ring1: '#8B6914', ring2: '#FFD700', glow: '#FFF176' },
  af_royal:  { ring1: '#7B0000', ring2: '#FFD700', glow: '#FF4500' },
  af_dragon: { ring1: '#0A3300', ring2: '#00CC44', glow: '#80FF00' },
  af_neon:   { ring1: '#006080', ring2: '#00CED1', glow: '#FF69B4' },
  af_galaxy: { ring1: '#0D0D3D', ring2: '#6A0DAD', glow: '#1E90FF' },
  af_event1: { ring1: '#4B0082', ring2: '#9400D3', glow: '#DA70D6' },
}

// ── Chat bubble gradients (mirrors bubbleGradient() in MyBagScreen.kt) ───────
const BUBBLE_GRADIENTS: Record<string, [string, string]> = {
  cb_default: ['#2C1654', '#4A1080'],
  cb_rose:    ['#AD1457', '#E91E63'],
  cb_ocean:   ['#006064', '#00ACC1'],
  cb_galaxy:  ['#0D0D3D', '#4A0080'],
  cb_event:   ['#880E4F', '#CC3300'],
}

// ── Profile card gradients (mirrors cardGradient() in MyBagScreen.kt) ────────
const CARD_GRADIENTS: Record<string, [string, string]> = {
  pc_basic:  ['#37474F', '#607D8B'],
  pc_gold:   ['#8B6914', '#B8860B'],
  pc_royal:  ['#4B0082', '#7B00C0'],
  pc_event:  ['#880E4F', '#C2185B'],
}

// ── ID frame (banner) gradients (mirrors bannerGradient() in MyBagScreen.kt) ─
const BANNER_GRADIENTS: Record<string, [string, string]> = {
  id_basic:  ['#1565C0', '#1976D2'],
  id_gold:   ['#8B6914', '#B8860B'],
  id_royal:  ['#4B0082', '#9C27B0'],
  id_event:  ['#AD1457', '#E91E63'],
}

// ── Avatar-frame ring ─────────────────────────────────────────────────────────
function FrameThumb({ id, size, onClick, name }: { id: string; size: number; onClick?: () => void; name: string }) {
  const t = FRAME_TIERS[id] ?? FRAME_TIERS['af_basic']
  const ringW = Math.max(3, Math.round(size * 0.09))
  const innerSz = Math.round(size * 0.63)
  const emojiFz = Math.round(innerSz * 0.42)
  return (
    <div
      style={{ width: size, height: size, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
      onClick={onClick}
      title={name}
      className={onClick ? 'cursor-pointer' : ''}
    >
      {/* Conic-gradient ring (outer shell) */}
      <div style={{
        position: 'absolute',
        width: size, height: size, borderRadius: '50%',
        background: `conic-gradient(${t.ring1}, ${t.ring2}, ${t.glow}, ${t.ring2}, ${t.ring1})`,
        padding: ringW,
        boxSizing: 'border-box',
      }}>
        <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: '#0f172a' }} />
      </div>
      {/* Inner ring (thin inner accent) */}
      <div style={{
        position: 'absolute',
        width: size - ringW * 2 - 2,
        height: size - ringW * 2 - 2,
        borderRadius: '50%',
        border: `${Math.max(1, Math.round(ringW * 0.35))}px solid ${t.glow}55`,
        boxSizing: 'border-box',
      }} />
      {/* Avatar placeholder */}
      <div style={{
        width: innerSz, height: innerSz, borderRadius: '50%', zIndex: 1, flexShrink: 0,
        background: 'radial-gradient(circle, #5C2090, #180040)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: emojiFz, lineHeight: 1,
      }}>👤</div>
    </div>
  )
}

// ── Chat-bubble pill ──────────────────────────────────────────────────────────
function BubbleThumb({ id, size, onClick, name }: { id: string; size: number; onClick?: () => void; name: string }) {
  const [c1, c2] = BUBBLE_GRADIENTS[id] ?? BUBBLE_GRADIENTS['cb_default']
  const fz = size >= 100 ? 15 : 11
  const text = size >= 100 ? 'Hello! 👋' : 'hi'
  const h = size >= 100 ? Math.round(size * 0.3) : Math.round(size * 0.44)
  return (
    <div
      style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
      onClick={onClick} title={name}
      className={onClick ? 'cursor-pointer' : ''}
    >
      <div style={{
        width: '88%', height: h,
        borderRadius: 999,
        background: `linear-gradient(to right, ${c1}, ${c2})`,
        border: `1.5px solid ${c2}66`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'white', fontWeight: 700, fontSize: fz,
      }}>{text}</div>
    </div>
  )
}

// ── Profile card ──────────────────────────────────────────────────────────────
function CardThumb({ id, size, onClick, name }: { id: string; size: number; onClick?: () => void; name: string }) {
  const [c1, c2] = CARD_GRADIENTS[id] ?? CARD_GRADIENTS['pc_basic']
  const cardH  = size >= 100 ? Math.round(size * 0.46) : Math.round(size * 0.64)
  const cardW  = size >= 100 ? Math.round(size * 0.88) : Math.round(size * 0.9)
  const avSz   = size >= 100 ? Math.round(cardH * 0.58) : Math.round(cardH * 0.48)
  const pad    = Math.round(size * 0.07)
  const radius = Math.round(size * 0.1)
  return (
    <div
      style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
      onClick={onClick} title={name}
      className={onClick ? 'cursor-pointer' : ''}
    >
      <div style={{
        width: cardW, height: cardH, borderRadius: radius,
        background: `linear-gradient(to right, ${c1}, ${c2})`,
        padding: pad, display: 'flex', alignItems: 'center', gap: pad,
        boxSizing: 'border-box',
      }}>
        <div style={{
          width: avSz, height: avSz, flexShrink: 0, borderRadius: '50%',
          background: 'rgba(255,255,255,0.22)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: Math.round(avSz * 0.52),
        }}>👤</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1 }}>
          <div style={{ height: size >= 100 ? 6 : 4, background: 'rgba(255,255,255,0.7)', borderRadius: 3 }} />
          <div style={{ height: size >= 100 ? 5 : 3, width: '70%', background: 'rgba(255,255,255,0.4)', borderRadius: 2 }} />
          {size >= 100 && (
            <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
              {['TOP3', 'Lv.5', '🇮🇳'].map(tag => (
                <div key={tag} style={{
                  background: 'rgba(255,255,255,0.25)', borderRadius: 4,
                  padding: '2px 5px', color: 'white', fontSize: 9, fontWeight: 600,
                }}>{tag}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── ID-frame banner pill ──────────────────────────────────────────────────────
function BannerThumb({ id, size, onClick, name }: { id: string; size: number; onClick?: () => void; name: string }) {
  const [c1, c2] = BANNER_GRADIENTS[id] ?? BANNER_GRADIENTS['id_basic']
  const h  = size >= 100 ? Math.round(size * 0.22) : Math.round(size * 0.36)
  const fz = size >= 100 ? 12 : 8
  const text = size >= 100 ? '⭐ Username joined the room' : '• joined •'
  return (
    <div
      style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
      onClick={onClick} title={name}
      className={onClick ? 'cursor-pointer' : ''}
    >
      <div style={{
        width: '88%', height: h, borderRadius: 999,
        background: `linear-gradient(to right, ${c1}, ${c2})`,
        border: `1px solid ${c2}55`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'white', fontWeight: 600, fontSize: fz, whiteSpace: 'nowrap',
        padding: '0 10px',
      }}>{text}</div>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function BagItemThumb({ id, category, name, previewUrl, size = 40, onClick }: Props) {
  // For non-design categories (or if admin set a custom previewUrl image), use the image
  if (previewUrl && category === 'entrance') {
    return (
      <div
        style={{ width: size, height: size, flexShrink: 0 }}
        className={`rounded-lg overflow-hidden bg-slate-700${onClick ? ' cursor-pointer hover:border-pink-500 border border-transparent transition-colors' : ''}`}
        onClick={onClick} title={name}
      >
        <img src={previewUrl} alt={name} className="w-full h-full object-cover"
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
      </div>
    )
  }

  switch (category) {
    case 'frame':        return <FrameThumb  id={id} size={size} onClick={onClick} name={name} />
    case 'chat_bubble':  return <BubbleThumb id={id} size={size} onClick={onClick} name={name} />
    case 'profile_card': return <CardThumb   id={id} size={size} onClick={onClick} name={name} />
    case 'id_frame':     return <BannerThumb id={id} size={size} onClick={onClick} name={name} />
    default:
      // Entrance without previewUrl, or unknown
      return (
        <div
          style={{ width: size, height: size }}
          className={`rounded-lg bg-slate-700 border border-slate-600 flex items-center justify-center shrink-0${onClick ? ' cursor-pointer hover:border-pink-500 transition-colors' : ''}`}
          onClick={onClick} title={name}
        >
          <span style={{ fontSize: Math.round(size * 0.38) }}>
            {category === 'entrance' ? '🚀' : category === 'frame' ? '🔮' : category === 'chat_bubble' ? '💬' : category === 'profile_card' ? '🃏' : '🏷️'}
          </span>
        </div>
      )
  }
}
