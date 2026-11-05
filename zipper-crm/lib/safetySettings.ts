/**
 * `appConfig/safety` as the CRM edits it (O13, 5 Nov 2026). The same clamping as the server's `sanitizeSafetyConfig`
 * (functions/src/safety.ts) — a form never saves a value the server would change. Pure; tested by safetySettings.spec.ts.
 */

export interface SafetySettings {
  visionEnabled: boolean
  autoEndOnAdult: boolean
  snapshotEverySeconds: number
  badWords: string[]
  useBuiltInWords: boolean
  muteAfterStrikes: number
  strikeWindowMinutes: number
}

export const SAFETY_DEFAULTS: SafetySettings = {
  visionEnabled: false,
  autoEndOnAdult: false,
  snapshotEverySeconds: 60,
  badWords: [],
  useBuiltInWords: true,
  muteAfterStrikes: 3,
  strikeWindowMinutes: 60,
}

function clamp(n: unknown, lo: number, hi: number, dflt: number): number {
  const v = Number(n)
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : dflt
}

export function sanitizeSafety(raw: Record<string, unknown> | undefined | null): SafetySettings {
  const r = raw ?? {}
  const words = Array.isArray(r.badWords) ? r.badWords : []
  return {
    visionEnabled: r.visionEnabled === true,
    autoEndOnAdult: r.autoEndOnAdult === true,
    snapshotEverySeconds: clamp(r.snapshotEverySeconds, 30, 600, SAFETY_DEFAULTS.snapshotEverySeconds),
    badWords: Array.from(new Set(words.map((w) => String(w ?? '').trim().toLowerCase())
      .filter((w) => w.length >= 2 && w.length <= 40))).slice(0, 500),
    useBuiltInWords: r.useBuiltInWords !== false,
    muteAfterStrikes: clamp(r.muteAfterStrikes, 1, 20, SAFETY_DEFAULTS.muteAfterStrikes),
    strikeWindowMinutes: clamp(r.strikeWindowMinutes, 5, 24 * 60, SAFETY_DEFAULTS.strikeWindowMinutes),
  }
}
