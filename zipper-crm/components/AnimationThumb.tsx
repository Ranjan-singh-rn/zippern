'use client'

/**
 * AnimationThumb — plays Lottie JSON or SVGA animations.
 * Detects format from the URL extension.
 * Fully imperative (zero React state) to avoid re-render/canvas conflicts.
 */

import { useEffect, useRef } from 'react'

interface Props {
  src: string       // URL ending in .json or .svga
  size?: number
}

// ── Lottie CDN loader ─────────────────────────────────────────────────────────
let lottieReady = false, lottieLoading = false
const lottieCbs: Array<() => void> = []
function loadLottie(cb: () => void) {
  if (lottieReady) { cb(); return }
  lottieCbs.push(cb)
  if (lottieLoading) return
  lottieLoading = true
  const s = document.createElement('script')
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js'
  s.onload = () => { lottieReady = true; lottieCbs.splice(0).forEach(fn => fn()) }
  s.onerror = () => { lottieLoading = false }
  document.head.appendChild(s)
}

// ── SVGA CDN loader (SVGAPlayer-Web) ─────────────────────────────────────────
let svgaReady = false, svgaLoading = false
const svgaCbs: Array<() => void> = []
function loadSvga(cb: () => void) {
  if (svgaReady) { cb(); return }
  svgaCbs.push(cb)
  if (svgaLoading) return
  svgaLoading = true
  const s = document.createElement('script')
  // SVGAPlayer-Web-Lite — handles .svga (ZIP+protobuf) in canvas
  s.src = 'https://cdn.jsdelivr.net/npm/svgaplayerkit@1.0.5/dist/index.min.js'
  s.onload = () => { svgaReady = true; svgaCbs.splice(0).forEach(fn => fn()) }
  s.onerror = () => {
    // Fallback: try alternate CDN
    svgaLoading = false
    const s2 = document.createElement('script')
    s2.src = 'https://unpkg.com/svgaplayerkit@1.0.5/dist/index.min.js'
    s2.onload = () => { svgaReady = true; svgaCbs.splice(0).forEach(fn => fn()) }
    s2.onerror = () => { svgaLoading = false }
    document.head.appendChild(s2)
  }
  document.head.appendChild(s)
}

export default function AnimationThumb({ src, size = 192 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playerRef = useRef<any>(null)
  const isLottie = src.toLowerCase().includes('.json')

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || !src) return

    const container = document.createElement('div')
    container.style.width  = size + 'px'
    container.style.height = size + 'px'
    wrap.appendChild(container)
    let cancelled = false

    if (isLottie) {
      // ── Lottie ──────────────────────────────────────────────────────────────
      fetch(src)
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
        .then((animationData: unknown) => {
          if (cancelled || !container.isConnected) return
          loadLottie(() => {
            if (cancelled || !container.isConnected) return
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const lottie = (window as any).lottie
            if (!lottie) return
            playerRef.current?.destroy()
            playerRef.current = null
            try {
              playerRef.current = lottie.loadAnimation({
                container,
                renderer: 'canvas',
                loop: true,
                autoplay: true,
                animationData,
                rendererSettings: { clearCanvas: true, progressiveLoad: true, hideOnTransparent: false },
              })
            } catch (e) { console.error('AnimationThumb lottie error', e) }
          })
        })
        .catch(e => console.error('AnimationThumb fetch error', src, e))

    } else {
      // ── SVGA ────────────────────────────────────────────────────────────────
      // Create a <canvas> element — SVGAPlayer needs a canvas, not a div
      const canvas = document.createElement('canvas')
      canvas.width  = size
      canvas.height = size
      canvas.style.width  = size + 'px'
      canvas.style.height = size + 'px'
      container.appendChild(canvas)

      loadSvga(() => {
        if (cancelled || !canvas.isConnected) return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const SVGAKit = (window as any).SVGAPlayerKit || (window as any).Svga || (window as any).SVGA
        if (!SVGAKit) { console.warn('SVGA player not loaded'); return }
        try {
          // SVGAPlayerKit API: new Player(canvas) → player.load(url) → player.start()
          const player = new SVGAKit.Player(canvas)
          playerRef.current = player
          player.load(src).then(() => {
            if (!cancelled) player.start()
          }).catch((e: unknown) => console.error('SVGA load error', e))
        } catch (e) { console.error('AnimationThumb svga error', e) }
      })
    }

    return () => {
      cancelled = true
      try { playerRef.current?.destroy?.() } catch { /* ignore */ }
      try { playerRef.current?.stop?.()    } catch { /* ignore */ }
      playerRef.current = null
      if (wrap.contains(container)) wrap.removeChild(container)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  return (
    <div
      ref={wrapRef}
      style={{ width: size, height: size, flexShrink: 0 }}
      className="rounded-xl bg-slate-800"
    />
  )
}
