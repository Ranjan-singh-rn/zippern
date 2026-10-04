'use client'

/**
 * LottieThumb — plays a Lottie JSON animation imperatively.
 * Zero React state → zero re-renders that could disrupt the canvas.
 * Mirrors the lottie-test.html approach exactly (which is confirmed working).
 */

import { useEffect, useRef } from 'react'

interface Props {
  src?: string       // e.g. /lottie/entrances/en_bike.json
  size?: number      // px, default 40
  onClick?: () => void
  title?: string
}

// CDN loader — runs once per page
let lottieReady = false
let lottieLoading = false
const pendingCbs: Array<() => void> = []

function loadLottie(cb: () => void) {
  if (lottieReady) { cb(); return }
  pendingCbs.push(cb)
  if (lottieLoading) return
  lottieLoading = true
  const s = document.createElement('script')
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/bodymovin/5.12.2/lottie.min.js'
  s.onload = () => {
    lottieReady = true
    pendingCbs.splice(0).forEach(fn => fn())
  }
  s.onerror = () => { lottieLoading = false; pendingCbs.length = 0 }
  document.head.appendChild(s)
}

export default function LottieThumb({ src, size = 40, onClick, title }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const animRef = useRef<any>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap || !src) return

    // Create container imperatively so React re-renders never touch it
    const container = document.createElement('div')
    container.style.width  = size + 'px'
    container.style.height = size + 'px'
    wrap.appendChild(container)

    let cancelled = false

    fetch(src)
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then((animationData: unknown) => {
        if (cancelled || !container.isConnected) return
        loadLottie(() => {
          if (cancelled || !container.isConnected) return
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lottie = (window as any).lottie
          if (!lottie) return
          animRef.current?.destroy()
          animRef.current = null
          try {
            animRef.current = lottie.loadAnimation({
              container,
              renderer: 'canvas',
              loop: true,
              autoplay: true,
              animationData,
              rendererSettings: {
                clearCanvas: true,
                progressiveLoad: true,
                hideOnTransparent: false,
              },
            })
          } catch (e) {
            console.error('LottieThumb error', src, e)
          }
        })
      })
      .catch(e => console.error('LottieThumb fetch', src, e))

    return () => {
      cancelled = true
      animRef.current?.destroy()
      animRef.current = null
      if (wrap.contains(container)) wrap.removeChild(container)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  return (
    <div
      ref={wrapRef}
      style={{ width: size, height: size }}
      className={`rounded-lg bg-slate-800 border border-slate-700 shrink-0${onClick ? ' cursor-pointer hover:border-pink-500 transition-colors' : ''}`}
      onClick={onClick}
      title={title}
    />
  )
}
