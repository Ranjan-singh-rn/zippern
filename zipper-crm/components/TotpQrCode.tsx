'use client'

import { useMemo } from 'react'
import { encodeQr, qrSvgPath } from '@/lib/qrCode'

/**
 * The authenticator set-up QR code (Owner on /login, Observer on /observer).
 *
 * `uri` is the otpauth:// URI the server returned with the new setup key. It carries the TOTP
 * secret, so the code is drawn here, in the browser, as inline SVG by lib/qrCode.ts — no image
 * request, no QR service, nothing leaves the page. Black on white with a 4-module quiet zone, so
 * phone cameras read it on the dark theme.
 */
export default function TotpQrCode({ uri, size = 208 }: { uri: string; size?: number }) {
  const drawing = useMemo(() => {
    try {
      const qr = encodeQr(uri, 'M')
      return { dim: qr.size + 8, path: qrSvgPath(qr, 4) }
    } catch {
      return null
    }
  }, [uri])

  if (!drawing) {
    return <p className="text-red-300 text-xs">The QR code could not be drawn. Use the setup key below.</p>
  }
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="QR code for your authenticator app"
      width={size}
      height={size}
      viewBox={`0 0 ${drawing.dim} ${drawing.dim}`}
      shapeRendering="crispEdges"
      className="mx-auto block rounded-lg"
    >
      <rect width={drawing.dim} height={drawing.dim} fill="#ffffff" />
      <path d={drawing.path} fill="#000000" />
    </svg>
  )
}
