'use client'

import { useState, useEffect } from 'react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import {
  getEconomyConfig, saveEconomyConfig, economyConfigForWrite, validateCallEconomy,
  type EconomyConfig, type CommissionSlab, type CommissionConfig,
  splitPct, SPLIT_GENDERS, SPLIT_GENDER_LABELS,
  type SplitGender,
} from '@/lib/economyConfig'
import { invalidateRates } from '@/lib/rates'
import { calcBinanceConversion } from '@/lib/commission'
import { submitApproval } from '@/lib/approvals'
import { Loader2, Save, Plus, Trash2, AlertTriangle, CheckCircle, Info } from 'lucide-react'

const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500'
const labelCls = 'text-slate-400 text-xs mb-1 block'

function NumberInput({
  label, value, onChange, min, max, step, unit, hint,
}: {
  label: string; value: number; onChange: (v: number) => void
  min?: number; max?: number; step?: number; unit?: string; hint?: string
}) {
  return (
    <div>
      <label className={labelCls}>{label}{unit && <span className="text-slate-500 ml-1">({unit})</span>}</label>
      <input
        type="number"
        min={min} max={max} step={step ?? 0.01}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className={inputCls}
      />
      {hint && <p className="text-slate-600 text-xs mt-1">{hint}</p>}
    </div>
  )
}

/**
 * `appConfig/economy.weeklyMinPayoutBeans` — the second host payout condition.
 *
 * The owner has described a rule of "one lakh beans in a week". It does not
 * exist anywhere in the system: not in `appConfig/economy`, not here until now,
 * not in the weekly Cloud Function. The backend already looks for it and, while
 * it is missing, says so in the weekly report rather than inventing a number
 * (backend/app/services/reports.py:3078) and applies the rupee threshold alone.
 *
 * So this control has three states and shows which one it is in:
 *
 *   * NOT CONFIGURED — the current one, and the default. The report keeps
 *     warning until an owner sets a number. Nothing here pre-fills one.
 *   * a number — the second condition, applied from the next weekly run with no
 *     code change.
 *   * a stored value that is not a whole number of beans — shown as itself,
 *     because the server ignores it and warns, and an editor that rendered that
 *     identically to "not configured" would hide the discrepancy.
 *
 * 1,00,000 is offered as a shortcut, labelled as the owner's words rather than
 * as a default, so setting it is still someone's decision.
 */
function BeanThreshold({
  value, unusable, canClear, onChange,
}: {
  value?: number
  unusable?: string
  /** Clearing needs a superadmin — an approval payload cannot delete a field. */
  canClear: boolean
  onChange: (v: number | null) => void
}) {
  const configured = typeof value === 'number'
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <label className={labelCls}>
          Weekly min beans<span className="text-slate-500 ml-1">(beans earned in the week)</span>
        </label>
        <span className={`text-xs px-2 py-0.5 rounded ${
          configured ? 'bg-green-500/15 text-green-300' : 'bg-slate-700/60 text-slate-400'
        }`}>
          {configured ? 'rule is on' : 'not configured'}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          min={0}
          step={1000}
          value={configured ? value : ''}
          placeholder="not configured — leave empty to keep the rule off"
          onChange={e => {
            const raw = e.target.value.trim()
            if (raw === '') { onChange(null); return }
            const n = Number(raw)
            onChange(Number.isFinite(n) ? Math.trunc(n) : null)
          }}
          className={`${inputCls} flex-1 min-w-[14rem]`}
        />
        {!configured && (
          <button
            type="button"
            onClick={() => onChange(100_000)}
            className="text-xs px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
          >
            Set 1,00,000 (the owner&apos;s figure)
          </button>
        )}
        {configured && canClear && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
          >
            Turn the rule off
          </button>
        )}
      </div>

      {unusable !== undefined && (
        <p className="flex items-start gap-2 mt-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-amber-200 text-xs">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-medium">appConfig/economy.weeklyMinPayoutBeans is
            {' '}&lsquo;{unusable}&rsquo;</span>, which is not a whole number of beans. The weekly
            report ignores it and applies the rupee threshold alone. Enter a whole
            number to fix it, or leave this empty and save to remove the value.
          </span>
        </p>
      )}

      <p className="text-slate-600 text-xs mt-2">
        {configured
          ? 'A host must clear BOTH this and the rupee minimum above to be eligible '
            + 'for a weekly payout. Applied from the next weekly run.'
          : 'Host eligibility currently applies the rupee minimum ONLY, and the weekly '
            + 'report says so on every run. Nothing is assumed here — the rule stays '
            + 'off until an owner sets a number.'}
        {configured && !canClear && ' Turning it off again needs a superadmin.'}
      </p>
    </div>
  )
}

const ECONOMY_CONFIG_ROLES = ['superadmin', 'finance_admin'] as const

export default function EconomyConfigPage() {
  const { crmUser } = useAuth()
  const isSuperAdmin = crmUser?.role === 'superadmin'

  const [config, setConfig]     = useState<EconomyConfig | null>(null)
  const [loading, setLoading]   = useState(true)
  const [saving, setSaving]     = useState(false)
  const [msg, setMsg]           = useState<{ type: 'ok' | 'err' | 'pending'; text: string } | null>(null)

  function setGiftRate<K extends keyof EconomyConfig['giftRates']>(k: K, v: number) {
    setConfig(c => c ? { ...c, giftRates: { ...c.giftRates, [k]: v } } : c)
  }

  /** One cell of the payer × earner table. */
  function setSplit(payer: SplitGender, earner: SplitGender, v: number) {
    setConfig(c => c ? {
      ...c,
      callSplitMatrix: {
        ...c.callSplitMatrix,
        [payer]: { ...c.callSplitMatrix[payer], [earner]: v },
      },
    } : c)
  }

  /**
   * The weekly bean threshold, which has a third state the other fields do not:
   * unset.
   *
   * `null` DELETES the key rather than setting it to `undefined` — an undefined
   * value would be refused by Firestore on the superadmin path and would be
   * carried into the approval payload on the other one. Unset is expressed as
   * the key not being there, everywhere, which is also how the server tests for
   * it (`if key not in data`, backend/app/services/reports.py:3063).
   */
  function setBeanThreshold(v: number | null) {
    setConfig(c => {
      if (!c) return c
      const next: EconomyConfig = { ...c }
      // A value that was stored unusably is superseded the moment it is edited.
      delete next.weeklyMinPayoutBeansUnusable
      if (v === null) delete next.weeklyMinPayoutBeans
      else next.weeklyMinPayoutBeans = v
      return next
    })
  }

  // ── Commission config helpers ──────────────────────────────────────────────
  function setCommField<K extends keyof CommissionConfig>(k: K, v: CommissionConfig[K]) {
    setConfig(c => c ? { ...c, commissionConfig: { ...c.commissionConfig, [k]: v } } : c)
  }

  function setSlab(type: 'main' | 'sub', idx: number, patch: Partial<CommissionSlab>) {
    setConfig(c => {
      if (!c) return c
      const key = type === 'main' ? 'mainAgencySlabs' : 'subAgencySlabs'
      const slabs = [...c.commissionConfig[key]]
      slabs[idx] = { ...slabs[idx], ...patch }
      return { ...c, commissionConfig: { ...c.commissionConfig, [key]: slabs } }
    })
  }

  function addSlab(type: 'main' | 'sub') {
    setConfig(c => {
      if (!c) return c
      const key = type === 'main' ? 'mainAgencySlabs' : 'subAgencySlabs'
      const slabs = c.commissionConfig[key]
      const last = slabs[slabs.length - 1]
      const newFrom = last ? last.to + 1 : 0
      const newSlab: CommissionSlab = { from: newFrom, to: 999_999_999, rate: last ? last.rate : 5 }
      // Previous last slab: cap its 'to' at newFrom - 1
      const updated = slabs.map((s, i) =>
        i === slabs.length - 1 && s.to >= 999_999_999
          ? { ...s, to: newFrom - 1 }
          : s
      )
      return { ...c, commissionConfig: { ...c.commissionConfig, [key]: [...updated, newSlab] } }
    })
  }

  function removeSlab(type: 'main' | 'sub', idx: number) {
    setConfig(c => {
      if (!c) return c
      const key = type === 'main' ? 'mainAgencySlabs' : 'subAgencySlabs'
      const slabs = c.commissionConfig[key].filter((_, i) => i !== idx)
      return { ...c, commissionConfig: { ...c.commissionConfig, [key]: slabs } }
    })
  }

  useEffect(() => {
    if (!crmUser || !canAccess(crmUser, [...ECONOMY_CONFIG_ROLES])) return
    getEconomyConfig()
      .then(c => { setConfig(c); setLoading(false) })
      .catch(e => { console.error(e); setMsg({ type: 'err', text: 'Failed to load economy config.' }); setLoading(false) })
  }, [crmUser])

  async function handleSave() {
    if (!config || !crmUser) return
    setSaving(true)
    setMsg(null)
    try {
      // Checked before the branch, so the approval path is held to the same rule
      // as the direct save. An approval is applied as a merge update by whoever
      // approves it, and nothing revalidates it at that point — a bad call rate
      // waved through here would be written straight into the document the app
      // and the call function read.
      validateCallEconomy(config)

      if (isSuperAdmin) {
        await saveEconomyConfig(config, crmUser.name)
        // Drop the cached rates so every finance figure recomputes at the new
        // numbers. Without this the change looks saved but nothing moves until
        // a full reload, which makes the screen feel broken.
        invalidateRates()
        setMsg({ type: 'ok', text: 'Economy config saved.' })
        setTimeout(() => setMsg(null), 4000)   // auto-clear success only
      } else {
        await submitApproval({
          type: 'update_config',
          description: 'Update economy config (gift rates, commission slabs)',
          targetLabel: 'Economy Config',
          targetCollection: 'appConfig',
          targetDocId: 'economy',
          operation: 'update',
          // Sanitised: no `undefined` (Firestore refuses it) and no read-time
          // diagnostic fields. NOTE — this path can SET the bean threshold but
          // cannot CLEAR one, because an approval payload is applied as a merge
          // update and has no way to express a field deletion. Turning the rule
          // back off is a superadmin action; the field says so on screen.
          payload: economyConfigForWrite(config),
          requestedBy: { uid: crmUser.uid, name: crmUser.name, role: crmUser.role },
        })
        setMsg({ type: 'pending', text: 'Config change submitted — awaiting superadmin approval.' })
        setTimeout(() => setMsg(null), 4000)
      }
    } catch (e: unknown) {
      console.error('[EconomyConfig] save error:', e)
      // Errors stay visible until next save attempt — no auto-clear
      setMsg({ type: 'err', text: e instanceof Error ? e.message : 'Failed to save. Check console for details.' })
    } finally {
      setSaving(false)
    }
  }

  if (!crmUser || !canAccess(crmUser, [...ECONOMY_CONFIG_ROLES])) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-slate-400">Access denied.</p>
      </div>
    )
  }

  if (loading || !config) {
    return <div className="flex justify-center py-20"><div className="w-8 h-8 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" /></div>
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Economy Config</h1>
        <p className="text-slate-400 text-sm mt-1">
          {isSuperAdmin ? 'Changes apply immediately.' : 'Changes require superadmin approval.'}
        </p>
      </div>

      {msg && (
        <div className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm ${
          msg.type === 'ok'      ? 'bg-green-500/10 border border-green-500/20 text-green-300' :
          msg.type === 'pending' ? 'bg-yellow-500/10 border border-yellow-500/20 text-yellow-300' :
                                   'bg-red-500/10 border border-red-500/20 text-red-300'
        }`}>
          {msg.type === 'ok' ? <CheckCircle size={15} /> : msg.type === 'pending' ? <AlertTriangle size={15} /> : <AlertTriangle size={15} />}
          {msg.text}
        </div>
      )}

      {/* Gift rates */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
        <h2 className="text-white font-semibold flex items-center gap-2">
          Gift Rate Settings
          <span className="text-slate-500 text-xs font-normal flex items-center gap-1"><Info size={11} /> How much of a gift's diamond value goes to the receiver</span>
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <NumberInput label="Normal gift receiver %" value={config.giftRates.normalReceiverPct}
            onChange={v => setGiftRate('normalReceiverPct', v)} min={0} max={100} unit="%"
            hint="Standard gifts e.g. Rose, Heart" />
          <NumberInput label="Exclusive min %" value={config.giftRates.exclusiveReceiverPctMin}
            onChange={v => setGiftRate('exclusiveReceiverPctMin', v)} min={0} max={100} unit="%"
            hint="Min receiver earning for exclusive tier" />
          <NumberInput label="Exclusive max %" value={config.giftRates.exclusiveReceiverPctMax}
            onChange={v => setGiftRate('exclusiveReceiverPctMax', v)} min={0} max={100} unit="%"
            hint="Max receiver earning for exclusive tier" />
          <NumberInput label="Lucky gift receiver %" value={config.giftRates.luckyReceiverPct ?? 5}
            onChange={v => setGiftRate('luckyReceiverPct', v)} min={0} max={100} unit="%"
            hint="Base receiver earning for lucky gifts (rest goes to prize pool)" />
          <NumberInput label="Lucky min return (×)" value={config.giftRates.luckyReturnMin ?? 5}
            onChange={v => setGiftRate('luckyReturnMin', v)} min={1} max={100} step={1} unit="× gift cost"
            hint="Minimum diamonds returned to a lucky winner (e.g. 5 = 5× the gift cost)" />
          <NumberInput label="Lucky max return (×)" value={config.giftRates.luckyReturnMax ?? 20}
            onChange={v => setGiftRate('luckyReturnMax', v)} min={1} max={1000} step={1} unit="× gift cost"
            hint="Maximum diamonds returned to a lucky winner (e.g. 20 = 20× the gift cost)" />
        </div>
      </div>

      {/* Diamond Pricing */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
        <h2 className="text-white font-semibold">Diamond Pricing</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <NumberInput label="Diamond pack price (INR)" value={config.diamondPackPriceInr}
            onChange={v => setConfig(c => c ? { ...c, diamondPackPriceInr: v } : c)} min={0} step={10} unit="₹ per 1,00,000 diamonds"
            hint="Determines how much users pay per diamond (Indian users)" />
          <NumberInput label="Coin seller wholesale price (INR)" value={config.sellerWholesalePriceInr}
            onChange={v => setConfig(c => c ? { ...c, sellerWholesalePriceInr: v } : c)} min={0} step={10} unit="₹ per 1,00,000 diamonds" />
          <p className="text-slate-500 text-xs -mt-2 leading-relaxed sm:col-span-2">
            What a coin seller pays us, and their whole margin: they buy at this
            price and resell at the retail price above, collecting the difference
            from the buyer directly. Zipper never handles that money, so it is
            not a payout and never appears on the money board.
            {config.sellerWholesalePriceInr > 0
              && config.sellerWholesalePriceInr < config.diamondPackPriceInr
              ? ` At these figures a seller keeps ₹${(config.diamondPackPriceInr - config.sellerWholesalePriceInr).toLocaleString('en-IN')} per lakh.`
              : ' Set it equal to the retail price to give no discount.'}
          </p>
          <NumberInput label="Diamond pack price (USD)" value={config.diamondPackPriceUsd}
            onChange={v => setConfig(c => c ? { ...c, diamondPackPriceUsd: v } : c)} min={0} step={1} unit="USD per 1,00,000 diamonds"
            hint="Price for foreign users" />
          <NumberInput label="Bean → Diamond rate" value={config.beanToDiamondRate}
            onChange={v => setConfig(c => c ? { ...c, beanToDiamondRate: v } : c)} min={1} step={1} unit="beans per diamond"
            hint="For host/user bean redemption" />
          <NumberInput label="Bean → INR rate" value={config.giftRates.beanToInrRate}
            onChange={v => setGiftRate('beanToInrRate', v)} min={0} step={0.001} unit="₹ per bean"
            hint="1 bean = X rupees, used for host salary" />
        </div>
      </div>

      {/* Call Economy */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
        <h2 className="text-white font-semibold">Call Economy</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <NumberInput label="Default call rate (beans/min)" value={config.callRateBeansPerMin}
            onChange={v => setConfig(c => c ? { ...c, callRateBeansPerMin: v } : c)} min={0} step={1} unit="beans/min"
            hint="Global default; can be overridden per host" />
          <NumberInput label="Weekly min payout" value={config.weeklyMinPayoutInr}
            onChange={v => setConfig(c => c ? { ...c, weeklyMinPayoutInr: v } : c)} min={0} step={100} unit="₹"
            hint="Minimum host earnings to qualify for weekly payout" />
        </div>

        {/* ── The second host payout condition ──────────────────────────────
            Deliberately not a plain NumberInput: this field has three states,
            and "unset" is one of them and is the current one. A number box
            defaulting to 0 would read as "no minimum" and would write a real
            threshold of zero into the document the weekly report reads. */}
        <div className="border-t border-slate-800 pt-4">
          <BeanThreshold
            value={config.weeklyMinPayoutBeans}
            unusable={config.weeklyMinPayoutBeansUnusable}
            canClear={isSuperAdmin}
            onChange={setBeanThreshold}
          />
        </div>

        {/* ── The two knobs the Cloud Functions call path reads ──────────────
            `userCallRatePerMin` and `callSplitMatrix` are read by
            functions/src/calls.ts and by the Android app, and until now there
            was no control for either — they could only be changed by editing
            Firestore by hand. Both are shown with the arithmetic they drive,
            because neither is self-explanatory from its name: the split works
            one way round for a host call and the other way round for a
            user-to-user one. */}
        <div className="border-t border-slate-800 pt-4 space-y-4">
          <div>
            <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide">
              User ↔ user calls (no host on either side)
            </p>
            <p className="text-slate-600 text-xs mt-1 leading-relaxed">
              The one call price that is <em>not</em> derived from a host&rsquo;s bean
              income. Here the price is fixed and the receiver&rsquo;s earnings come
              out of it.
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <NumberInput label="User-to-user call rate" value={config.userCallRatePerMin}
              onChange={v => setConfig(c => c ? { ...c, userCallRatePerMin: Math.trunc(v) } : c)}
              min={1} step={100} unit="diamonds/min paid by the caller"
              hint="Whole diamonds. The app reads this as an integer and falls back to 1,600 on anything else." />
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg px-4 py-3 text-xs space-y-1">
              <p className="text-slate-400 font-medium">One minute of a user-to-user call</p>
              <p className="text-slate-300">
                Caller pays{' '}
                <span className="text-white font-semibold tabular-nums">
                  {config.userCallRatePerMin.toLocaleString('en-IN')} 💎
                </span>
                {config.diamondPackPriceInr > 0 && (
                  <>
                    {' '}≈{' '}
                    <span className="text-white font-semibold tabular-nums">
                      ₹{((config.userCallRatePerMin * config.diamondPackPriceInr) / 100_000)
                        .toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                    </span>{' '}
                    at the retail diamond price above
                  </>
                )}
              </p>
              <p className="text-slate-300">
                Receiver keeps{' '}
                <span className="text-green-300 font-semibold tabular-nums">
                  {(() => {
                    const cells = SPLIT_GENDERS.flatMap(p =>
                      SPLIT_GENDERS.map(e => splitPct(config.callSplitMatrix, p, e)))
                    const lo = Math.floor((config.userCallRatePerMin * Math.min(...cells)) / 100)
                    const hi = Math.floor((config.userCallRatePerMin * Math.max(...cells)) / 100)
                    return `${lo.toLocaleString('en-IN')}–${hi.toLocaleString('en-IN')}`
                  })()}{' '}
                  beans
                </span>{' '}
                a minute, depending on the pairing below. The rest is Zipper&rsquo;s.
              </p>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-800 pt-4 space-y-4">
          <div>
            <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide">
              Earner share (% of what the payer spends)
            </p>
            <p className="text-slate-600 text-xs mt-1 leading-relaxed">
              Read on the two genders and nothing else. <strong className="text-slate-500">
              Who pays</strong> is decided separately: the user always pays, so a host and
              a user means the user pays whichever of them dialled, and two users or two
              hosts means the caller pays.
            </p>
            <p className="text-slate-600 text-xs mt-2 leading-relaxed">
              Whole percentages, and they work <strong className="text-slate-500">two
              different ways round</strong>. With a <strong className="text-slate-500">host</strong>{' '}
              involved the host&rsquo;s bean income is fixed by their call rate and the
              payer&rsquo;s price is derived from it — so a lower share here makes the call{' '}
              <em>dearer for the payer</em> and pays the host the same. With{' '}
              <strong className="text-slate-500">no host</strong>, the price is the flat
              rate above and a lower share pays the receiver <em>less</em>.
            </p>
          </div>

          {/* The table. Rows are who pays, columns are who earns — and that
              order matters on screen as much as in the code: "male pays female
              is 50, female pays male is 40" is only readable if the reader can
              see which axis is which. */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left text-slate-500 text-xs font-medium px-2 py-2">
                    Payer ↓ / Earner →
                  </th>
                  {SPLIT_GENDERS.map(g => (
                    <th key={g} className="text-left text-slate-400 text-xs font-medium px-2 py-2">
                      {SPLIT_GENDER_LABELS[g]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {SPLIT_GENDERS.map(payer => (
                  <tr key={payer} className="border-t border-slate-800">
                    <td className="text-slate-400 text-xs px-2 py-2 whitespace-nowrap">
                      {SPLIT_GENDER_LABELS[payer]} pays
                    </td>
                    {SPLIT_GENDERS.map(earner => (
                      <td key={earner} className="px-2 py-2">
                        <NumberInput
                          label=""
                          value={splitPct(config.callSplitMatrix, payer, earner)}
                          onChange={v => setSplit(payer, earner, Math.trunc(v))}
                          min={1} max={100} step={1} unit="%"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* What each share actually costs a payer, at the default host rate.
              The formula is calls.ts's own — ceil(income × 100 / pct) — so the
              figures here are the prices the platform will quote, not an
              approximation of them. */}
          <div className="bg-slate-800/60 border border-slate-700 rounded-lg px-4 py-3 text-xs space-y-2">
            <p className="text-slate-400 font-medium">
              A minute with a host at the default {config.callRateBeansPerMin.toLocaleString('en-IN')} beans/min
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {SPLIT_GENDERS.flatMap(payer =>
                SPLIT_GENDERS.map(earner => {
                  const pct = splitPct(config.callSplitMatrix, payer, earner)
                  const perMin = Math.ceil((config.callRateBeansPerMin * 100) / Math.max(pct, 1))
                  return (
                    <div key={`${payer}-${earner}`} className="bg-slate-900 rounded px-3 py-2">
                      <p className="text-slate-500">
                        {SPLIT_GENDER_LABELS[payer]} pays {SPLIT_GENDER_LABELS[earner].toLowerCase()} · {pct}%
                      </p>
                      <p className="text-white font-semibold tabular-nums mt-0.5">
                        {perMin.toLocaleString('en-IN')} 💎/min
                      </p>
                      {config.diamondPackPriceInr > 0 && (
                        <p className="text-slate-500 tabular-nums">
                          ≈ ₹{((perMin * config.diamondPackPriceInr) / 100_000)
                            .toLocaleString('en-IN', { maximumFractionDigits: 2 })} to the payer
                        </p>
                      )}
                      <p className="text-green-400/80 tabular-nums">
                        earner keeps {config.callRateBeansPerMin.toLocaleString('en-IN')} beans
                      </p>
                    </div>
                  )
                }),
              )}
            </div>
            <p className="text-slate-600">
              A host&rsquo;s own rate replaces the default here — but only once they are
              verified. An unverified host is priced at the default however high the
              agency set theirs.
            </p>
          </div>
        </div>

        <div className="border-t border-slate-800 pt-4">
          <p className="text-slate-400 text-xs font-semibold uppercase tracking-wide mb-3">Host Call Rate Limits (set by agency per host)</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <NumberInput label="Minimum call rate" value={config.minHostCallRate ?? 350}
              onChange={v => setConfig(c => c ? { ...c, minHostCallRate: v } : c)} min={1} step={1} unit="beans/min"
              hint="Lowest rate agency can assign to any host" />
            <NumberInput label="Maximum call rate for new hosts" value={config.maxHostCallRate ?? 700}
              onChange={v => setConfig(c => c ? { ...c, maxHostCallRate: v } : c)} min={1} step={1} unit="beans/min"
              hint="Agency cannot set a rate higher than this when adding a new host" />
          </div>
        </div>
      </div>

      {/* ── International FX & Binance ── */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-5">
        <div>
          <h2 className="text-white font-semibold">International FX &amp; Binance</h2>
          <p className="text-slate-500 text-xs mt-0.5">Used for USD agency payouts via Binance. Net INR = USD × rate − Binance fee − govt tax.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <NumberInput label="USD → INR rate" value={config.commissionConfig?.usdToInrRate ?? 83}
            onChange={v => setCommField('usdToInrRate', v)} min={1} step={0.5} unit="₹ per $"
            hint="Update whenever market rate changes" />
          <NumberInput label="Binance fee %" value={config.commissionConfig?.binanceFeePercent ?? 1}
            onChange={v => setCommField('binanceFeePercent', v)} min={0} max={20} step={0.1} unit="%"
            hint="Binance trading / withdrawal fee" />
          <NumberInput label="Govt / TDS tax %" value={config.commissionConfig?.govtTaxPercent ?? 1}
            onChange={v => setCommField('govtTaxPercent', v)} min={0} max={30} step={0.1} unit="%"
            hint="TDS or GST on crypto conversion" />
        </div>
        {/* Live conversion preview */}
        {(() => {
          const cc = config.commissionConfig
          if (!cc) return null
          const preview = calcBinanceConversion(100, cc.usdToInrRate, cc.binanceFeePercent, cc.govtTaxPercent)
          return (
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg px-4 py-3 text-xs space-y-1">
              <p className="text-slate-400 font-medium mb-2">Preview — what $100 USD becomes after all deductions:</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                <div className="bg-slate-900 rounded px-2 py-2">
                  <div className="text-slate-500 text-xs">Gross INR</div>
                  <div className="text-white font-semibold">₹{preview.grossInr.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                </div>
                <div className="bg-red-500/10 rounded px-2 py-2">
                  <div className="text-slate-500 text-xs">Binance fee</div>
                  <div className="text-red-400 font-semibold">−₹{preview.binanceFeeInr.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                </div>
                <div className="bg-red-500/10 rounded px-2 py-2">
                  <div className="text-slate-500 text-xs">Govt tax</div>
                  <div className="text-red-400 font-semibold">−₹{preview.govtTaxInr.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                </div>
                <div className="bg-green-500/10 rounded px-2 py-2">
                  <div className="text-slate-500 text-xs">Net INR received</div>
                  <div className="text-green-400 font-semibold">₹{preview.netInr.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                </div>
              </div>
              <p className="text-slate-600 text-xs text-right mt-1">Total deduction: {preview.totalDeductionPct.toFixed(1)}% of gross</p>
            </div>
          )
        })()}
        <NumberInput label="Weekly min payout (USD)" value={config.commissionConfig?.weeklyMinPayoutUsd ?? 0}
          onChange={v => setCommField('weeklyMinPayoutUsd', v)} min={0} step={1} unit="USD"
          hint="Minimum USD earnings for weekly payout eligibility (international agencies)" />
      </div>

      {/* ── Commission Slabs ── */}
      {(['main', 'sub'] as const).map(type => {
        const key = type === 'main' ? 'mainAgencySlabs' : 'subAgencySlabs'
        const slabs = config.commissionConfig?.[key] ?? []
        const label = type === 'main' ? 'Main Agency' : 'Sub-Agency'
        return (
          <div key={type} className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-white font-semibold">{label} Commission Slabs</h2>
                <p className="text-slate-500 text-xs mt-0.5">Progressive bracket model — like income tax. Each tier applies only to the earnings within that range.</p>
              </div>
              <button onClick={() => addSlab(type)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-pink-500/10 border border-pink-500/30 text-pink-400 rounded-lg text-xs font-medium hover:bg-pink-500/20 transition-colors">
                <Plus size={13} />Add Tier
              </button>
            </div>
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800 text-slate-400 text-xs">
                    <th className="px-3 py-2 text-left">#</th>
                    <th className="px-3 py-2">From (₹)</th>
                    <th className="px-3 py-2">To (₹)</th>
                    <th className="px-3 py-2">Rate (%)</th>
                    <th className="px-3 py-2 text-left text-slate-600">Example at midpoint</th>
                    <th className="px-3 py-2 w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {slabs.map((slab, idx) => {
                    const isCap = slab.to >= 999_999_999
                    const midpoint = isCap ? slab.from + 50_000 : (slab.from + slab.to) / 2
                    const example  = ((Math.min(midpoint, isCap ? midpoint : slab.to) - slab.from) * slab.rate / 100)
                    return (
                      <tr key={idx}>
                        <td className="px-3 py-2 text-slate-500 text-xs">{idx + 1}</td>
                        <td className="px-3 py-1">
                          <input type="number" min={0} step={1000}
                            value={slab.from}
                            onChange={e => setSlab(type, idx, { from: parseInt(e.target.value) || 0 })}
                            className="w-28 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-pink-500 text-right" />
                        </td>
                        <td className="px-3 py-1">
                          <div className="flex items-center gap-1">
                            <input type="number" min={0} step={1000}
                              value={isCap ? '' : slab.to}
                              placeholder={isCap ? '∞' : ''}
                              onChange={e => setSlab(type, idx, { to: parseInt(e.target.value) || 0 })}
                              className="w-28 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-pink-500 text-right placeholder:text-slate-400" />
                            <button
                              type="button"
                              title={isCap ? 'No cap (click to set a limit)' : 'Set to no cap (∞)'}
                              onClick={() => setSlab(type, idx, { to: isCap ? 0 : 999_999_999 })}
                              className={`text-xs px-1.5 py-1 rounded border transition-colors ${
                                isCap
                                  ? 'text-pink-400 border-pink-500/50 bg-pink-500/10'
                                  : 'text-slate-500 border-slate-700 hover:border-pink-500 hover:text-pink-400'
                              }`}
                            >∞</button>
                          </div>
                        </td>
                        <td className="px-3 py-1">
                          <input type="number" min={0} max={100} step={0.5}
                            value={slab.rate}
                            onChange={e => setSlab(type, idx, { rate: parseFloat(e.target.value) || 0 })}
                            className="w-20 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-white text-xs focus:outline-none focus:border-pink-500 text-right" />
                        </td>
                        <td className="px-3 py-2 text-slate-600 text-xs">
                          ≈ ₹{Math.round(example).toLocaleString('en-IN')} on ₹{Math.round(Math.min(midpoint, isCap ? midpoint : slab.to) - slab.from).toLocaleString('en-IN')} in-bracket
                        </td>
                        <td className="px-3 py-2">
                          <button onClick={() => removeSlab(type, idx)} disabled={slabs.length <= 1}
                            className="text-slate-600 hover:text-red-400 disabled:opacity-30 transition-colors">
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-slate-600 text-xs">Click ∞ on any tier to toggle no-cap. The last tier should usually be set to ∞.</p>
          </div>
        )
      })}

      {/* Save */}
      <div className="flex justify-end">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 px-6 py-2.5 bg-pink-500 hover:bg-pink-400 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-colors">
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
          {isSuperAdmin ? 'Save Config' : 'Submit for Approval'}
        </button>
      </div>
    </div>
  )
}
