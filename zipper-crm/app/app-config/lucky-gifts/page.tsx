'use client'

/**
 * Lucky gifts — `appConfig/luckyGifts`. Owner and Tech.
 *
 * The combos a sender may pick, the receiver's share, and the odds table the
 * server rolls over. Every number here is money: the sender pays
 * `unit × combo`, the receiver earns `receiverPct` of it in beans, and the
 * sender's reward is `multiplier × unit` drawn over the weights — so a table
 * that pays out more than it takes in loses the business money on every send.
 *
 * ── THE OWNER'S SWITCH: OFF UNTIL LEGAL CLEARANCE ────────────────────────────
 *
 * A lucky gift lets a user spend diamonds on a random reward — a chance
 * mechanic, deliberately left unshipped pending a legal opinion under India's
 * Online Gaming Act 2025. `enabled` is OFF by default (an absent document is
 * off) and the server refuses every lucky send while it is. Only the Owner
 * may turn it on, after legal clearance, through a confirmation that repeats
 * the warning; Tech may edit the table but not the switch, and a Tech save
 * leaves it exactly as it is (`enabledToWrite`, firestore.rules D15).
 *
 * ── THE SAME GUARD AS THE SERVER, BEFORE THE SAVE ────────────────────────────
 *
 * `functions/src/luckyGifts.ts` refuses a table whose expected multiplier
 * `E = Σ(m×w)/Σw` exceeds `minCombo × (1 − receiverPct/100) × 0.9`, and a
 * refused table is never rolled on. `lib/luckyGiftsGuard.ts` is that guard,
 * line for line; this page runs it as you type and again before the write, so
 * a table the server would refuse is never saved. The version is bumped past
 * the server's current one on every save — the switch included — and the
 * write names you.
 */

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  AlertTriangle, ArrowLeft, CheckCircle, Loader2, Plus, RefreshCw, Save, Sparkles, ToggleLeft, ToggleRight, Trash2,
} from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'
import { getLuckyGiftsConfig, saveLuckyGiftsConfig, type LuckyGiftsDoc } from '@/lib/appConfig'
import {
  LUCKY_DEFAULTS, LUCKY_ENABLE_WARNING, LUCKY_LIMITS, comboMargins, enabledToWrite, luckyEnabledOf,
  mayToggleLuckyGifts, nextVersion, oddsShares, validateLuckyConfig,
} from '@/lib/luckyGiftsGuard'

/** Who may edit: the Owner and Tech (what `firestore.rules` allows on `appConfig/*`). The switch is the Owner's alone. */
const PAGE_ROLES: CrmRole[] = ['superadmin', 'tech_admin', 'tech_member']

const inputCls = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500'

/** The form holds strings so a half-typed number is not coerced under the cursor. */
interface Draft {
  /** The Owner's switch as the form holds it; written only when the Owner flips it. */
  enabled: boolean
  combos: string[]
  receiverPct: string
  odds: Array<{ multiplier: string; weight: string }>
}

function toDraft(cfg: { enabled?: boolean; combos: number[]; receiverPct: number; odds: Array<{ multiplier: number; weight: number }> }): Draft {
  return {
    enabled: luckyEnabledOf(cfg),
    combos: cfg.combos.map(String),
    receiverPct: String(cfg.receiverPct),
    odds: cfg.odds.map((o) => ({ multiplier: String(o.multiplier), weight: String(o.weight) })),
  }
}

/** A string → number as the guard will see it: '' and junk become NaN, which the guard refuses by name. */
function num(s: string): number {
  const t = s.trim()
  return t === '' ? Number.NaN : Number(t)
}

function fromDraft(d: Draft) {
  return {
    combos: d.combos.map(num),
    receiverPct: num(d.receiverPct),
    odds: d.odds.map((o) => ({ multiplier: num(o.multiplier), weight: num(o.weight) })),
  }
}

function whenOf(ts: LuckyGiftsDoc['updatedAt']): string {
  const d = ts && typeof (ts as { toDate?: () => Date }).toDate === 'function' ? (ts as { toDate: () => Date }).toDate() : null
  return d ? d.toLocaleString('en-IN') : '—'
}

export default function LuckyGiftsPage() {
  const { crmUser } = useAuth()
  const router = useRouter()
  const allowed = !!crmUser && canAccess(crmUser, PAGE_ROLES)

  const [server, setServer] = useState<LuckyGiftsDoc | null>(null)
  const [draft, setDraft] = useState<Draft>(toDraft(LUCKY_DEFAULTS))
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  /** Turning lucky gifts ON needs the Owner to tick the legal-clearance box in the confirmation. */
  const [legalOk, setLegalOk] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null)

  async function load() {
    setLoading(true)
    setLoadError('')
    try {
      const cfg = await getLuckyGiftsConfig()
      setServer(cfg)
      // Fields the document lacks show as the defaults — what the server runs on for them.
      setDraft(toDraft(cfg ? { ...LUCKY_DEFAULTS, ...cfg } : LUCKY_DEFAULTS))
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not read appConfig/luckyGifts.')
      setServer(null)
      setDraft(toDraft(LUCKY_DEFAULTS))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!crmUser) return
    if (!allowed) { router.push('/'); return }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crmUser, allowed])

  // The guard, as you type. `version` is what the save would write.
  const serverVersion = server?.version ?? 0
  const verdict = useMemo(
    () => validateLuckyConfig({ ...fromDraft(draft), version: nextVersion(serverVersion) }),
    [draft, serverVersion],
  )
  const margins = useMemo(() => (verdict.ok ? comboMargins(verdict.config) : []), [verdict])
  const shares = useMemo(() => {
    const odds = fromDraft(draft).odds.filter((o) => Number.isFinite(o.weight) && o.weight > 0 && Number.isFinite(o.multiplier))
    return oddsShares(odds)
  }, [draft])

  // The switch: what the server says now, who may flip it, and what this save would write.
  const serverEnabled = luckyEnabledOf(server)
  const isOwner = mayToggleLuckyGifts(crmUser?.role)
  const enabledWrite = enabledToWrite(crmUser?.role, serverEnabled, draft.enabled)
  const turningOn = enabledWrite === true
  const turningOff = enabledWrite === false
  // What lucky gifts will be after this save: the Owner's flip, or the server's state as it stands.
  const enabledAfterSave = enabledWrite ?? serverEnabled

  function showToast(msg: string, type: 'ok' | 'err') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  async function handleSave() {
    if (!verdict.ok || !crmUser) return
    if (turningOn && !legalOk) return
    setSaving(true)
    try {
      const out = await saveLuckyGiftsConfig(
        { combos: verdict.config.combos, receiverPct: verdict.config.receiverPct, odds: verdict.config.odds },
        { uid: crmUser.uid, role: crmUser.role },
        { loaded: serverEnabled, requested: draft.enabled },
      )
      showToast(
        `Saved as version ${out.version} — lucky gifts ${out.enabled ? 'ON' : 'OFF'}; expected multiplier ` +
        `${out.expectedMultiplier.toFixed(3)} against a ceiling of ${out.ceiling.toFixed(3)}.`,
        'ok',
      )
      setConfirming(false)
      await load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Save failed.', 'err')
    } finally {
      setSaving(false)
    }
  }

  if (!crmUser || !allowed) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-slate-400">Access denied.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 size={28} className="text-pink-500 animate-spin" />
      </div>
    )
  }

  const e = verdict.ok ? verdict.expectedMultiplier : Number.NaN
  const ceiling = verdict.ok ? verdict.ceiling : Number.NaN

  return (
    <div className="max-w-3xl mx-auto">
      <Link href="/app-config" className="inline-flex items-center gap-1.5 text-slate-400 hover:text-white text-sm mb-4">
        <ArrowLeft size={14} /> App Config
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3 mb-6">
        <div className="flex items-center gap-3">
          <Sparkles size={26} className="text-pink-500" />
          <div>
            <h1 className="text-2xl font-bold text-white">Lucky Gifts</h1>
            <p className="text-slate-400 text-sm mt-0.5">
              The Owner&rsquo;s on/off switch, the combos, the receiver&rsquo;s share and the odds table the server rolls over.
            </p>
            <p className="text-slate-600 text-xs mt-1 font-mono">appConfig/luckyGifts</p>
          </div>
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Reload
        </button>
      </div>

      {loadError && (
        <div className="mb-4 flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 text-sm">
          <AlertTriangle size={14} /> {loadError}
        </div>
      )}
      {toast && (
        <div className={`mb-4 flex items-center gap-2 rounded-xl px-4 py-3 text-sm border ${
          toast.type === 'ok' ? 'bg-green-500/10 border-green-500/30 text-green-300' : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
          {toast.type === 'ok' ? <CheckCircle size={14} /> : <AlertTriangle size={14} />} {toast.msg}
        </div>
      )}

      {/* The Owner's switch — off until legal clearance. Shows the server's state as it is now. */}
      <section className={`mb-6 border rounded-xl p-5 ${serverEnabled ? 'bg-green-500/5 border-green-500/30' : 'bg-slate-800 border-slate-700'}`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-white font-semibold">Enabled</h2>
            <p className="text-slate-400 text-xs mt-0.5">
              Off by default. While off, the server refuses every lucky send and the app shows lucky gifts as unavailable.
              Normal gifts are not affected.
            </p>
            <p className="text-sm mt-2">
              <span className="text-slate-400">On the server now: </span>
              <span className={`font-semibold ${serverEnabled ? 'text-green-300' : 'text-slate-200'}`}>
                {serverEnabled ? 'ON — users can send lucky gifts' : 'OFF — lucky sends are refused'}
              </span>
              {!server && <span className="text-slate-500"> (document absent)</span>}
            </p>
            {enabledWrite !== undefined && (
              <p className="text-amber-300 text-xs mt-1">
                Not saved yet: saving turns lucky gifts {turningOn ? 'ON' : 'OFF'}.
              </p>
            )}
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={draft.enabled}
            aria-label="Lucky gifts enabled"
            disabled={!isOwner || saving}
            title={isOwner ? (draft.enabled ? 'Turn lucky gifts off' : 'Turn lucky gifts on') : 'Only the Owner can turn lucky gifts on or off.'}
            onClick={() => setDraft((d) => ({ ...d, enabled: !d.enabled }))}
            className="shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {draft.enabled
              ? <ToggleRight size={34} className="text-green-400" />
              : <ToggleLeft size={34} className="text-slate-500" />}
          </button>
        </div>
        <div className="mt-3 flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 text-amber-200 rounded-lg px-3 py-2 text-xs">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <p>{LUCKY_ENABLE_WARNING}</p>
        </div>
        {!isOwner && (
          <p className="text-slate-500 text-xs mt-2">
            Only the Owner can turn lucky gifts on or off. You can edit the table below; your save leaves the switch as it is.
          </p>
        )}
      </section>

      {/* The server's current version — the one lucky sends run on while the switch is on. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <Stat label="Server version" value={server ? String(server.version ?? 0) : '0 (defaults)'}
          sub={server ? `saved ${whenOf(server.updatedAt)}` : 'document absent — lucky gifts off'} />
        <Stat label="Next save writes" value={`v${nextVersion(serverVersion)}`} sub={server?.updatedBy ? `last by ${server.updatedBy.slice(0, 8)}…` : ''} />
        <Stat label="Expected multiplier" value={Number.isFinite(e) ? `×${e.toFixed(3)}` : '—'} sub="E = Σ(m×w) / Σw" tone={verdict.ok ? 'green' : 'red'} />
        <Stat label="Ceiling" value={Number.isFinite(ceiling) ? `×${ceiling.toFixed(3)}` : '—'} sub="min combo × (1 − pct/100) × 0.9" />
      </div>

      {!verdict.ok && (
        <div className="mb-4 flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-300 rounded-xl px-4 py-3 text-sm">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <p><span className="font-mono text-xs text-red-400 mr-2">{verdict.code}</span>{verdict.reason}</p>
        </div>
      )}

      <div className="space-y-5">
        {/* Combos */}
        <section className="bg-slate-800 border border-slate-700 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-white font-semibold">Combos</h2>
              <p className="text-slate-400 text-xs mt-0.5">Whole numbers of at least {LUCKY_LIMITS.comboMin}, each listed once. The sender pays unit × combo.</p>
            </div>
            <button
              onClick={() => setDraft((d) => ({ ...d, combos: [...d.combos, ''] }))}
              className="flex items-center gap-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg px-2.5 py-1.5"
            >
              <Plus size={12} /> Add combo
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {draft.combos.map((c, i) => (
              <div key={i} className="flex items-center gap-1">
                <input
                  value={c}
                  inputMode="numeric"
                  onChange={(ev) => setDraft((d) => ({ ...d, combos: d.combos.map((x, j) => (j === i ? ev.target.value : x)) }))}
                  className={`${inputCls} w-24`}
                />
                <button
                  onClick={() => setDraft((d) => ({ ...d, combos: d.combos.filter((_, j) => j !== i) }))}
                  disabled={draft.combos.length <= 1}
                  title="Remove"
                  className="text-slate-500 hover:text-red-400 disabled:opacity-30"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Receiver share */}
        <section className="bg-slate-800 border border-slate-700 rounded-xl p-5">
          <h2 className="text-white font-semibold">Receiver share</h2>
          <p className="text-slate-400 text-xs mt-0.5 mb-3">
            Percent of the charge the receiver earns as beans (0–100). The rest, less the sender&rsquo;s reward, is the platform&rsquo;s line.
          </p>
          <div className="flex items-center gap-2">
            <input
              value={draft.receiverPct}
              inputMode="decimal"
              onChange={(ev) => setDraft((d) => ({ ...d, receiverPct: ev.target.value }))}
              className={`${inputCls} w-28`}
            />
            <span className="text-slate-400 text-sm">%</span>
          </div>
        </section>

        {/* Odds */}
        <section className="bg-slate-800 border border-slate-700 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-white font-semibold">Odds table</h2>
              <p className="text-slate-400 text-xs mt-0.5">
                Multipliers are whole numbers from {LUCKY_LIMITS.multiplierMin} to {LUCKY_LIMITS.multiplierMax}; weights are positive (0.001 is the smallest the roll can see).
              </p>
            </div>
            <button
              onClick={() => setDraft((d) => ({ ...d, odds: [...d.odds, { multiplier: '', weight: '' }] }))}
              className="flex items-center gap-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-200 rounded-lg px-2.5 py-1.5"
            >
              <Plus size={12} /> Add row
            </button>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-500 text-xs uppercase tracking-wide">
                <th className="text-left font-medium pb-2">Multiplier</th>
                <th className="text-left font-medium pb-2">Weight</th>
                <th className="text-right font-medium pb-2">Share of rolls</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {draft.odds.map((o, i) => (
                <tr key={i} className="border-t border-slate-700/60">
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1">
                      <span className="text-slate-500">×</span>
                      <input
                        value={o.multiplier}
                        inputMode="numeric"
                        onChange={(ev) => setDraft((d) => ({ ...d, odds: d.odds.map((x, j) => (j === i ? { ...x, multiplier: ev.target.value } : x)) }))}
                        className={`${inputCls} w-24`}
                      />
                    </div>
                  </td>
                  <td className="py-2 pr-2">
                    <input
                      value={o.weight}
                      inputMode="decimal"
                      onChange={(ev) => setDraft((d) => ({ ...d, odds: d.odds.map((x, j) => (j === i ? { ...x, weight: ev.target.value } : x)) }))}
                      className={`${inputCls} w-28`}
                    />
                  </td>
                  <td className="py-2 text-right text-slate-300 font-mono text-xs">
                    {(() => {
                      const s = shares.find((x) => x.multiplier === num(o.multiplier) && x.weight === num(o.weight))
                      return s ? `${s.pct.toFixed(3)}%` : '—'
                    })()}
                  </td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => setDraft((d) => ({ ...d, odds: d.odds.filter((_, j) => j !== i) }))}
                      disabled={draft.odds.length <= 1}
                      title="Remove"
                      className="text-slate-500 hover:text-red-400 disabled:opacity-30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Platform margin per combo — in units of the gift price, so it holds for every lucky gift. */}
        <section className="bg-slate-800 border border-slate-700 rounded-xl p-5">
          <h2 className="text-white font-semibold">Expected platform margin per combo</h2>
          <p className="text-slate-400 text-xs mt-0.5 mb-3">
            In units of the gift&rsquo;s diamond price. Per send: charge = combo; receiver = combo × pct/100;
            expected reward = E; platform = the rest. A single ×100 roll is a loss on every combo below 100 — the table is tuned on the aggregate.
          </p>
          {verdict.ok ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-500 text-xs uppercase tracking-wide">
                  <th className="text-left font-medium pb-2">Combo</th>
                  <th className="text-right font-medium pb-2">Receiver</th>
                  <th className="text-right font-medium pb-2">Expected reward</th>
                  <th className="text-right font-medium pb-2">Platform</th>
                  <th className="text-right font-medium pb-2">Margin</th>
                </tr>
              </thead>
              <tbody>
                {margins.map((m) => (
                  <tr key={m.combo} className="border-t border-slate-700/60 font-mono text-xs">
                    <td className="py-2 text-white">{m.combo}</td>
                    <td className="py-2 text-right text-slate-300">{m.receiverUnits.toFixed(2)}</td>
                    <td className="py-2 text-right text-slate-300">{m.expectedRewardUnits.toFixed(3)}</td>
                    <td className={`py-2 text-right ${m.expectedPlatformUnits < 0 ? 'text-red-400' : 'text-green-300'}`}>
                      {m.expectedPlatformUnits.toFixed(3)}
                    </td>
                    <td className={`py-2 text-right ${m.expectedMarginPct < 0 ? 'text-red-400' : 'text-green-300'}`}>
                      {m.expectedMarginPct.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-slate-500 text-sm">Fix the table above to see the margins.</p>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mt-6">
        <button
          // The table only: the switch stays where it is in the form.
          onClick={() => { setDraft((d) => ({ ...toDraft(LUCKY_DEFAULTS), enabled: d.enabled })); showToast('Loaded the documented defaults (not saved yet).', 'ok') }}
          className="text-slate-400 hover:text-white text-sm"
        >
          Load defaults
        </button>
        <button
          onClick={() => { setLegalOk(false); setConfirming(true) }}
          disabled={!verdict.ok || saving}
          className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors"
        >
          <Save size={15} /> Save as version {nextVersion(serverVersion)}
        </button>
      </div>

      {/* Money-adjacent: a confirmation with the numbers, and the write names the actor. Turning lucky gifts ON also asks for the legal clearance. */}
      {confirming && verdict.ok && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !saving && setConfirming(false)} />
          <div className="relative w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 space-y-4">
            <h2 className="text-white font-semibold">
              {turningOn
                ? `Turn lucky gifts ON and save v${nextVersion(serverVersion)}?`
                : turningOff
                  ? `Turn lucky gifts OFF and save v${nextVersion(serverVersion)}?`
                  : `Save lucky-gift table v${nextVersion(serverVersion)}?`}
            </h2>
            <ul className="text-slate-300 text-sm space-y-1">
              <li>
                Lucky gifts: <span className={`font-semibold ${enabledAfterSave ? 'text-green-300' : 'text-slate-200'}`}>{enabledAfterSave ? 'ON' : 'OFF'}</span>
                {enabledWrite === undefined && <span className="text-slate-500"> (unchanged)</span>}
              </li>
              <li>Combos: <span className="font-mono">{verdict.config.combos.join(', ')}</span></li>
              <li>Receiver share: <span className="font-mono">{verdict.config.receiverPct}%</span></li>
              <li>Odds: <span className="font-mono">{verdict.config.odds.map((o) => `×${o.multiplier}:${o.weight}`).join('  ')}</span></li>
              <li>Expected multiplier <span className="font-mono">×{verdict.expectedMultiplier.toFixed(3)}</span> against a ceiling of <span className="font-mono">×{verdict.ceiling.toFixed(3)}</span></li>
            </ul>
            {turningOn && (
              <div className="space-y-3">
                <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 text-amber-200 rounded-lg px-3 py-2 text-sm">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <p>{LUCKY_ENABLE_WARNING}</p>
                </div>
                <label className="flex items-start gap-2 text-slate-200 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={legalOk}
                    onChange={(ev) => setLegalOk(ev.target.checked)}
                    disabled={saving}
                    className="mt-0.5 accent-pink-500"
                  />
                  <span>I confirm legal clearance (Online Gaming Act 2025) has been obtained for lucky gifts.</span>
                </label>
              </div>
            )}
            {turningOff && (
              <p className="text-slate-400 text-sm">
                From the next settlement every lucky send is refused (&ldquo;Lucky gifts are not available right now.&rdquo;). Normal gifts are not affected.
              </p>
            )}
            <p className="text-slate-500 text-xs">
              {enabledAfterSave
                ? 'Every lucky send from the next settlement onwards rolls on this table.'
                : 'Lucky gifts stay off: no send rolls on this table until the Owner turns them on.'}
              {' '}The write is recorded against your account.
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setConfirming(false)} disabled={saving}
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold rounded-lg px-4 py-2.5 text-sm">
                Cancel
              </button>
              <button onClick={() => void handleSave()} disabled={saving || (turningOn && !legalOk)}
                className="flex-1 bg-pink-500 hover:bg-pink-600 disabled:bg-pink-500/40 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2.5 text-sm flex items-center justify-center gap-2">
                {saving ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : turningOn ? 'Enable and save' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'green' | 'red' }) {
  return (
    <div className="bg-slate-800 border border-slate-700 rounded-xl px-4 py-3">
      <p className="text-slate-500 text-[11px] uppercase tracking-wide">{label}</p>
      <p className={`text-lg font-semibold mt-0.5 ${tone === 'green' ? 'text-green-300' : tone === 'red' ? 'text-red-400' : 'text-white'}`}>{value}</p>
      {sub && <p className="text-slate-500 text-xs mt-0.5 truncate">{sub}</p>}
    </div>
  )
}
