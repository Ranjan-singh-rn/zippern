import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import { getFirestore, connectFirestoreEmulator, type Firestore } from 'firebase/firestore'
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth'
import { getStorage, connectStorageEmulator, type FirebaseStorage } from 'firebase/storage'
import { getFunctions, connectFunctionsEmulator, type Functions } from 'firebase/functions'

export const firebaseConfig = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

/**
 * The LOCAL test copy only: `~/zipper-release/qa/local-stack.command` starts the
 * dev server with NEXT_PUBLIC_USE_FIREBASE_EMULATORS=true and a demo- project id,
 * and every Firebase SDK instance the CRM creates is then pointed at the Firebase
 * emulators on this machine. The variable is never in .env.local and never set
 * by deploy-crm.command, so the deployed site is untouched: unset means off.
 */
export const usesEmulators = process.env.NEXT_PUBLIC_USE_FIREBASE_EMULATORS === 'true'
const EMULATOR_HOST = process.env.NEXT_PUBLIC_FIREBASE_EMULATOR_HOST || '127.0.0.1'

/**
 * Same-origin mode (local copy only): next.config.js — in `next dev` with the
 * emulators on — proxies every emulator and the API under the dev server's own
 * origin and sets this flag, so a browser that refuses cross-port requests to
 * 127.0.0.1 (an embedded test browser, for one) still reaches them. Each SDK is
 * then pointed at the page's own host and port instead of the emulator ports.
 */
const SAME_ORIGIN = process.env.NEXT_PUBLIC_FIREBASE_EMULATORS_SAME_ORIGIN === 'true'
function endpoint(port: number): { host: string; port: number } {
  if (SAME_ORIGIN && typeof window !== 'undefined') {
    const { hostname, port: own, protocol } = window.location
    return { host: hostname, port: Number(own || (protocol === 'https:' ? 443 : 80)) }
  }
  return { host: EMULATOR_HOST, port }
}

// An SDK instance may be handed to a connect* call once only; the dev server
// re-evaluates modules on every edit, so remember which instances are done.
const connected = new WeakSet<object>()
function once(target: object, connect: () => void) {
  if (!usesEmulators || connected.has(target)) return
  connected.add(target)
  try {
    connect()
  } catch {
    // Already connected by an earlier evaluation of this module: nothing to do.
  }
}

/** Point these SDK instances at the local emulators — a no-op unless the local copy is running. */
export function connectEmulators(parts: { auth?: Auth; db?: Firestore; storage?: FirebaseStorage; functions?: Functions }) {
  const { auth: a, db: d, storage: s, functions: f } = parts
  if (a) once(a, () => { const e = endpoint(9099); connectAuthEmulator(a, `http://${e.host}:${e.port}`, { disableWarnings: true }) })
  if (d) once(d, () => { const e = endpoint(8080); connectFirestoreEmulator(d, e.host, e.port) })
  if (s) once(s, () => { const e = endpoint(9199); connectStorageEmulator(s, e.host, e.port) })
  if (f) once(f, () => { const e = endpoint(5001); connectFunctionsEmulator(f, e.host, e.port) })
}

const app: FirebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0]
/** The initialised app itself, for SDKs the CRM reaches for rarely — reach Cloud
 *  Functions through [crmFunctions] so the local copy can redirect them too. */
export { app }

export const db = getFirestore(app)
export const auth = getAuth(app)
export const storage = getStorage(app)
connectEmulators({ auth, db, storage })

/** Cloud Functions in Mumbai — every callable the CRM uses is deployed there. */
export function crmFunctions(): Functions {
  const functions = getFunctions(app, 'asia-south1')
  connectEmulators({ functions })
  return functions
}
