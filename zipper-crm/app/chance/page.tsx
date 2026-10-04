'use client'

/**
 * Chance mechanics — every lucky gift tier and every game, and what each one
 * actually is right now.
 *
 * The one thing this page exists to make impossible: a mechanic that is
 * stopped, unconfigured or enabled in no country looking like a running one.
 * `chance.list_mechanics` (`backend/app/services/chance.py:1367`) keeps
 * "configured", "suspended" and "live" as three separate facts precisely
 * because "signed but stopped" and "never built" are different problems, and
 * this page keeps them separate too.
 *
 * Reads `GET /api/chance/mechanics` (`backend/app/routers/chance.py:208`,
 * `require_internal` — every internal role, including the Observer).
 * Creating a mechanic is `POST /api/chance/mechanics`
 * (`backend/app/routers/chance.py:435`, `require_team_admin`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Activity, Dices, Gauge, HeartPulse, Pause, Plus, RefreshCw, Settings2, Wallet,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { attempt, type ReadResult } from '@/lib/readState'
import { Denied, Loading, Warning } from '@/components/ui/States'
import { ChanceReasonModal } from '@/components/ChanceReasonModal'
import { MechanicStateBadge, Panel, ReadPanel, Stat } from '@/components/ChanceUI'
import {
  CHANCE_MONEY_ROLES, CHANCE_READ_ROLES, CHANCE_TEAM_ADMIN_ROLES, KIND_LABELS, chance,
  count, diamonds, mechanicState, type Mechanic, type MechanicKind,
} from '@/lib/apiChance'

const KINDS: { value: MechanicKind; label: string; hint: string }[] = [
  { value: 'lucky_gift', label: 'Lucky gift', hint: 'A gift tier with an uncertain return.' },
  { value: 'game', label: 'Game', hint: 'Aviator and anything like it.' },
  { value: 'event', label: 'Event', hint: 'A limited-time mechanic (8B.12).' },
]

export default function ChanceMechanicsPage() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, CHANCE_READ_ROLES)
  const canPropose = canAccess(crmUser, CHANCE_TEAM_ADMIN_ROLES)
  // The three chance reports are business-wide money, and 8B.5.6 gives the
  // margin to Finance. The hub link is hidden rather than shown-and-refused: a
  // link to a page that will turn you away is the defect, not the refusal.
  const canSeeMoney = isObserver || canAccess(crmUser, CHANCE_MONEY_ROLES)

  const [result, setResult] = useState<ReadResult<Mechanic[]> | null>(null)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState('')

  // The new mechanic's fields live out here so the modal can be a dumb shell.
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<MechanicKind>('game')

  const load = useCallback(() => {
    if (!allowed || !apiReady) return
    setResult(null)
    attempt(chance.mechanics(), 'chance.mechanics').then(setResult)
  }, [allowed, apiReady])

  useEffect(() => { load() }, [load])

  const mechanics = result?.ok ? result.value : []

  const counts = useMemo(() => {
    const out = { live: 0, suspended: 0, unconfigured: 0, no_market: 0 }
    mechanics.forEach((m) => { out[mechanicState(m)] += 1 })
    return out
  }, [mechanics])

  const suspended = mechanics.filter((m) => m.suspended)

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="chance mechanics" />

  const idInvalid =
    newId.trim().length < 3 || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(newId.trim())
      ? 'An id is 3–64 characters, lower case, digits, underscores or hyphens. It is permanent.'
      : !newName.trim()
        ? 'A mechanic needs a name people will recognise.'
        : null

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2.5">
            <Dices size={26} className="text-pink-400" /> Chance mechanics
          </h1>
          <p className="text-slate-400 mt-1 text-sm max-w-3xl leading-relaxed">
            Every lucky gift tier and every game, live or not. A mechanic with no
            signed configuration is invisible in every market; a suspended one
            pays nothing and accepts nothing. Neither is the same as switched
            off in one country, and none of the three is shown as running.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={load}
            className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          {canPropose && (
            <button
              onClick={() => setCreating(true)}
              className="flex items-center gap-2 bg-pink-600 hover:bg-pink-500 text-white rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors"
            >
              <Plus size={14} /> New mechanic
            </button>
          )}
        </div>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      <nav className={`grid grid-cols-2 gap-3 ${canSeeMoney ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
        <HubLink
          href="/chance/exposure"
          icon={<Wallet size={15} className="text-amber-400" />}
          label="Exposure and safety"
          blurb="Live position against the reserve, the ceilings, and anything that has stopped."
        />
        <HubLink
          href="/chance/monitoring"
          icon={<Activity size={15} className="text-sky-400" />}
          label="Monitoring"
          blurb="Actual RTP against configured, the Ops exception queue and player anomalies."
        />
        <HubLink
          href="/chance/protection"
          icon={<HeartPulse size={15} className="text-emerald-400" />}
          label="Player protection"
          blurb="Flagged players, the harm pattern behind each flag, and a named decision."
        />
        {canSeeMoney && (
          <HubLink
            href="/chance/money"
            icon={<Gauge size={15} className="text-pink-400" />}
            label="The money"
            blurb="Gross gaming revenue, the bean-payout ratio and the cannibalisation verdict."
          />
        )}
      </nav>

      {suspended.length > 0 && (
        <Panel
          tone="danger"
          title={
            <span className="flex items-center gap-2">
              <Pause size={16} className="text-red-300" />
              {count(suspended.length)} mechanic{suspended.length === 1 ? ' is' : 's are'} suspended
            </span>
          }
          subtitle="A suspended mechanic pays nothing and accepts nothing, and does not restart on a timer. Only an owner can resume one, with a reason."
          right={
            <Link
              href="/chance/exposure"
              className="text-red-200 hover:text-white text-sm underline underline-offset-2"
            >
              What tripped, and resume →
            </Link>
          }
        >
          <ul className="space-y-1.5">
            {suspended.map((m) => (
              <li key={m.id} className="text-red-100 text-sm">
                <span className="font-medium">{m.name}</span>{' '}
                <span className="text-red-300/80">
                  — {m.suspended?.automatic ? 'auto-suspended' : 'stopped by hand'}:{' '}
                  {m.suspended?.reason}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat
          label="Live"
          value={count(counts.live)}
          tone={counts.live ? 'good' : 'muted'}
          hint="A player could play these right now."
        />
        <Stat
          label="Suspended"
          value={count(counts.suspended)}
          tone={counts.suspended ? 'bad' : 'muted'}
          hint="Stopped. Invisible to every player."
        />
        <Stat
          label="No market"
          value={count(counts.no_market)}
          tone="muted"
          hint="Configured, but no country enabled."
        />
        <Stat
          label="Never configured"
          value={count(counts.unconfigured)}
          tone="muted"
          hint="No configuration has ever been signed."
        />
      </section>

      <ReadPanel
        result={result}
        what="the mechanic register"
        loadingLabel="Reading the mechanic register…"
        onRetry={load}
        isEmpty={(v) => v.length === 0}
        emptyTitle="No chance mechanic exists yet"
        emptyHint="Nothing is live by default. A mechanic is created switched off, with no odds and no market, and its first configuration is a card an owner signs."
        emptyIcon={<Dices size={28} />}
      >
        {(rows) => (
          <div className="space-y-3">
            {rows.map((m) => (
              <MechanicCard key={m.id} mechanic={m} />
            ))}
          </div>
        )}
      </ReadPanel>

      {creating && (
        <ChanceReasonModal
          title="Create a chance mechanic"
          confirmLabel="Create it, switched off"
          tone="neutral"
          extraInvalid={idInvalid}
          what={
            <>
              <p>
                This creates the record and nothing else. It has no odds, no
                stake denominations, no ceilings and no country — so it is
                invisible everywhere and no player can reach it.
              </p>
              <p>
                The odds are what need an owner&apos;s signature, and they arrive
                on the first configuration card. Until that card is signed and
                activated, this mechanic cannot pay anybody anything.
              </p>
            </>
          }
          onClose={() => setCreating(false)}
          onSubmit={async (reason) => {
            const created = await chance.createMechanic({
              mechanic_id: newId.trim(),
              kind: newKind,
              name: newName.trim(),
              reason,
            })
            setCreating(false)
            setNewId('')
            setNewName('')
            setNotice(
              `${created.name} was created switched off. It has no configuration and no market until an owner signs its first version.`,
            )
            load()
          }}
        >
          <div className="space-y-3">
            <div>
              <label className="block text-slate-300 text-sm font-medium mb-1.5">
                Identifier <span className="text-red-400">*</span>
              </label>
              <input
                value={newId}
                onChange={(e) => setNewId(e.target.value.toLowerCase())}
                placeholder="aviator"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-pink-500"
              />
              <p className="text-slate-500 text-xs mt-1">
                Permanent. It appears on every round record and every report row.
              </p>
            </div>
            <div>
              <label className="block text-slate-300 text-sm font-medium mb-1.5">
                Name <span className="text-red-400">*</span>
              </label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Aviator"
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-pink-500"
              />
            </div>
            <div>
              <label className="block text-slate-300 text-sm font-medium mb-1.5">Kind</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {KINDS.map((k) => (
                  <button
                    key={k.value}
                    type="button"
                    onClick={() => setNewKind(k.value)}
                    className={`text-left rounded-lg border px-3 py-2 text-sm transition-colors ${
                      newKind === k.value
                        ? 'border-pink-500 bg-pink-500/10 text-white'
                        : 'border-slate-700 text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    <span className="font-medium">{k.label}</span>
                    <span className="block text-slate-500 text-xs mt-0.5">{k.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </ChanceReasonModal>
      )}
    </div>
  )
}

function HubLink({
  href, icon, label, blurb,
}: {
  href: string
  icon: React.ReactNode
  label: string
  blurb: string
}) {
  return (
    <Link
      href={href}
      className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl px-4 py-3.5 transition-colors"
    >
      <span className="flex items-center gap-2 text-white text-sm font-medium">
        {icon} {label}
      </span>
      <span className="block text-slate-500 text-xs mt-1 leading-snug">{blurb}</span>
    </Link>
  )
}

function MechanicCard({ mechanic }: { mechanic: Mechanic }) {
  const state = mechanicState(mechanic)
  const config = mechanic.live_config ?? null
  const countries = config?.enabled_countries ?? []

  return (
    <div
      className={`border rounded-xl p-4 sm:p-5 ${
        state === 'suspended'
          ? 'bg-red-500/5 border-red-500/40'
          : state === 'live'
            ? 'bg-slate-900 border-slate-800'
            : 'bg-slate-900/60 border-slate-800'
      }`}
    >
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={`font-semibold ${state === 'live' ? 'text-white' : 'text-slate-300'}`}>
              {mechanic.name}
            </h3>
            <MechanicStateBadge state={state} size="small" />
            <span className="text-slate-500 text-xs">
              {KIND_LABELS[mechanic.kind] ?? mechanic.kind} · {mechanic.id}
            </span>
          </div>
          <p className="text-slate-500 text-xs mt-1.5 max-w-2xl leading-relaxed">
            {state === 'suspended' && mechanic.suspended
              ? `Suspended: ${mechanic.suspended.reason}`
              : state === 'live'
                ? `Version ${mechanic.live_version} is live in ${countries.join(', ')}.`
                : state === 'no_market'
                  ? 'A configuration is live but no country is enabled, so no player can see it.'
                  : 'No configuration has ever been signed. Invisible everywhere.'}
          </p>
        </div>
        <Link
          href={`/chance/configure/?mechanic=${encodeURIComponent(mechanic.id)}`}
          className="flex items-center gap-1.5 shrink-0 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-3 py-2 text-sm transition-colors"
        >
          <Settings2 size={14} /> Configuration
        </Link>
      </div>

      <dl className="grid grid-cols-2 lg:grid-cols-5 gap-3 mt-4">
        <Cell
          label="RTP (configured)"
          value={config?.rtp_percent ? `${config.rtp_percent}%` : '—'}
          hint={config?.house_edge_percent ? `${config.house_edge_percent}% house edge` : 'No live table'}
        />
        <Cell
          label="Max single win"
          value={diamonds(config?.max_single_win ?? null)}
          hint="diamonds, one round"
        />
        <Cell
          label="Reserve"
          value={diamonds(config?.exposure?.reserve_diamonds ?? null)}
          hint={config?.exposure?.reserve_diamonds ? 'diamonds' : 'none configured'}
        />
        <Cell
          label="Markets"
          value={countries.length ? countries.join(' ') : '—'}
          hint={countries.length ? `${countries.length} enabled` : 'invisible everywhere'}
        />
        <Cell
          label="Live version"
          value={mechanic.live_version === null ? '—' : `v${mechanic.live_version}`}
          hint={config?.multiplier_basis ? `multiplier on ${config.multiplier_basis.replace('_', ' ')}` : 'never signed'}
        />
      </dl>
    </div>
  )
}

function Cell({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <dt className="text-slate-500 text-[11px] uppercase tracking-wide">{label}</dt>
      <dd className="text-slate-200 text-sm font-medium tabular-nums mt-0.5">{value}</dd>
      <dd className="text-slate-600 text-[11px]">{hint}</dd>
    </div>
  )
}
