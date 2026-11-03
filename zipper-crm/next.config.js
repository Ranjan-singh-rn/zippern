const { PHASE_DEVELOPMENT_SERVER } = require('next/constants')

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
}

/*
 * LOCAL TEST COPY ONLY — `next dev` with NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true,
 * which only ~/zipper-release/qa/local-stack.command sets. `next build` (and so
 * every deploy) never takes this branch: the config above is returned unchanged.
 *
 * Serves the Firebase emulators and the local API under the dev server's OWN
 * origin, exactly as Hosting serves /api/** in production, so the CRM works in a
 * browser that refuses cross-port requests to 127.0.0.1. lib/firebase.ts reads
 * NEXT_PUBLIC_FIREBASE_EMULATORS_SAME_ORIGIN and connects each SDK to the page's
 * own host; NEXT_PUBLIC_API_BASE = the dev server's origin sends the API clients'
 * /api calls to the same place.
 * `output: 'export'` is dropped here because static export has no rewrites, and
 * it only matters to `next build` anyway.
 */
function localEmulatorConfig() {
  const host = process.env.NEXT_PUBLIC_FIREBASE_EMULATOR_HOST || '127.0.0.1'
  const api = 'http://127.0.0.1:8000'
  const { output, ...rest } = nextConfig
  return {
    ...rest,
    // trailingSlash would 308 every proxied call (".../accounts:signInWithPassword"
    // → ".../accounts:signInWithPassword/") before the rewrite runs.
    skipTrailingSlashRedirect: true,
    env: {
      // The PAGE's own origin, whichever host it was opened on (127.0.0.1:3001 or
      // localhost:3001 — two origins, so an Owner and a partner can stay signed in
      // side by side). An empty value would be ignored by Next's env inlining, so
      // this is ONE SPACE: the API clients build `${API_BASE}/api/...`, and the URL
      // parser strips leading spaces, leaving the relative "/api/..." — which
      // /api/** below forwards to the local backend.
      NEXT_PUBLIC_API_BASE: ' ',
      NEXT_PUBLIC_FIREBASE_EMULATORS_SAME_ORIGIN: 'true',
    },
    async rewrites() {
      return [
        { source: '/api/:path*', destination: `${api}/api/:path*` },
        // Auth emulator
        { source: '/identitytoolkit.googleapis.com/:path*', destination: `http://${host}:9099/identitytoolkit.googleapis.com/:path*` },
        { source: '/securetoken.googleapis.com/:path*', destination: `http://${host}:9099/securetoken.googleapis.com/:path*` },
        { source: '/emulator/:path*', destination: `http://${host}:9099/emulator/:path*` },
        // Firestore emulator (WebChannel and REST)
        { source: '/google.firestore.v1.Firestore/:path*', destination: `http://${host}:8080/google.firestore.v1.Firestore/:path*` },
        { source: '/v1/projects/:path*', destination: `http://${host}:8080/v1/projects/:path*` },
        // Storage emulator
        { source: '/v0/:path*', destination: `http://${host}:9199/v0/:path*` },
        // Functions emulator (project demo-zipper)
        { source: '/demo-zipper/:path*', destination: `http://${host}:5001/demo-zipper/:path*` },
      ]
    },
  }
}

module.exports = (phase) =>
  phase === PHASE_DEVELOPMENT_SERVER && process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === 'true'
    ? localEmulatorConfig()
    : nextConfig
