'use client'

/**
 * Configuration — the screen that decides the margin.
 *
 * Everything on it hangs off one rule: **the server computes RTP, and it does
 * it while you type.** Nobody sets odds without seeing the margin (8B.2.4), and
 * a margin the browser worked out is a margin that can disagree with the one
 * the server will enforce. So every keystroke in the outcome table re-posts the
 * whole draft to `POST /api/chance/configs/preview`
 * (`backend/app/routers/chance.py:418`, `require_team_admin`) and every figure
 * shown — RTP, house edge, per-tier effective RTP, the reserve guidance — is a
 * string that came back from `chance.evaluate_draft`
 * (`backend/app/services/chance.py:984`). That is the *same function* that gates
 * `propose_config`, so what is previewed is what will be enforced.
 *
 * The reads:
 *   • `GET /api/chance/mechanics`                     `chance.py:208`  require_internal
 *   • `GET /api/chance/mechanics/{id}`                `chance.py:221`  require_internal
 *       — the mechanic plus its last twenty versions, each with its stored
 *         evaluation, which is how a member or the Observer sees the live
 *         margin without being able to call the preview.
 *   • `GET /api/cards`                                — to find where a pending
 *         change has got to. A chance configuration card is raised on the **App**
 *         team's board (`chance.propose_config`), and `cards.board_for` scopes
 *         that read, so a Finance or Ops admin will not find it. The screen says
 *         so rather than showing an empty stage.
 *
 * The writes, and who the API lets do them:
 *   • preview            `require_team_admin`  `chance.py:418`
 *   • propose (stage 1)  `require_team_admin`  `chance.py:457`
 *   • activate (stage 5) `require_owner`       `chance.py:479`
 *   • withdraw a market  `require_owner`       `chance.py:492`
 *
 * Verify and sign are deliberately **not** here. A configuration card is
 * verified at `POST /cards/{id}/verify` and signed at `POST /cards/{id}/sign`
 * like every other card on the money board, which is where separation of duties
 * is enforced. This screen links there and does not reimplement it.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowLeft, CheckCircle2, ChevronRight, Globe, Loader2, Plus, RefreshCw,
  Settings2, ShieldCheck, Trash2,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { attempt, type ReadResult } from '@/lib/readState'
import { Denied, Empty, Loading, Warning } from '@/components/ui/States'
import { ChanceReasonModal } from '@/components/ChanceReasonModal'
import { MechanicStateBadge, Panel, ReadPanel, ReadOnlyNote } from '@/components/ChanceUI'
import {
  BlockedPanel, EvaluationHeadline, ExposureView, FlagsPanel, OutcomeTableView,
  RoundingNote, SubSection, TierTable,
} from '@/components/ChanceEvaluation'
import type { Card } from '@/lib/api'
import {
  CARD_STAGES, CHANCE_OWNER_ROLES, CHANCE_READ_ROLES, CHANCE_TEAM_ADMIN_ROLES,
  KIND_LABELS, MULTIPLIER_ONE, PROBABILITY_TOTAL, board, chance, count, dateTime,
  diamonds, mechanicState, ppmPercent, stageIndex,
  type ConfigDraft, type ConfigVersion, type DraftEvaluation, type Mechanic,
  type MultiplierBasis,
} from '@/lib/apiChance'

// ══════════════════════════════════════════════════════════════════════════════
//  The form
// ══════════════════════════════════════════════════════════════════════════════
//
// Every numeric field is held as a **string**, so a box can be empty while it is
// being retyped and an absent ceiling stays absent instead of collapsing to
// zero. `_exposure_rules` treats `None` and `0` as opposite things — absent
// means "no ceiling of this kind", zero would stop the mechanic paying anything
// — and a form that cannot express "empty" cannot express that difference.

interface FormOutcome {
  multiplier_bp: string
  probability_ppm: string
}

interface ConfigForm {
  outcomes: FormOutcome[]
  min_stake: string
  max_stake: string
  step: string
  max_single_win: string
  enabled_countries: string
  quantity_tiers: string
  multiplier_basis: MultiplierBasis
  band_min_ppm: string
  band_max_ppm: string
  deliberate: boolean
  lower_return_statement: string
  override_allowed: boolean
  override_reason: string
  provider_name: string
  provider_key_id: string
  reserve_diamonds: string
  reserve_basis: string
  max_payout_per_round: string
  max_payout_per_player_per_day: string
  max_payout_platform_per_day: string
}

/**
 * A starting table that evaluates cleanly — 90% RTP inside the default
 * 85–96% band, 49% of rolls returning nothing so it stays the right side of
 * 8B.11.4, and no market enabled, because nothing is live by default.
 */
const BLANK: ConfigForm = {
  outcomes: [
    { multiplier_bp: '0', probability_ppm: '490000' },
    { multiplier_bp: '10000', probability_ppm: '300000' },
    { multiplier_bp: '20000', probability_ppm: '150000' },
    { multiplier_bp: '40000', probability_ppm: '50000' },
    { multiplier_bp: '100000', probability_ppm: '10000' },
  ],
  min_stake: '10',
  max_stake: '1000',
  step: '10',
  max_single_win: '10000',
  enabled_countries: '',
  quantity_tiers: '1',
  multiplier_basis: 'total_stake',
  band_min_ppm: '850000',
  band_max_ppm: '960000',
  deliberate: false,
  lower_return_statement: '',
  override_allowed: false,
  override_reason: '',
  provider_name: '',
  provider_key_id: '',
  reserve_diamonds: '',
  reserve_basis: '',
  max_payout_per_round: '',
  max_payout_per_player_per_day: '',
  max_payout_platform_per_day: '',
}

const digits = (raw: string) => raw.replace(/[^0-9]/g, '')

function intOf(raw: string): number {
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : 0
}

function optionalInt(raw: string): number | null {
  return raw.trim() === '' ? null : intOf(raw)
}

function listOfInts(raw: string): number[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => intOf(s))
}

function listOfCountries(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
}

/** The form as the API's `ConfigDraft`. Parsing, and nothing else. */
function toDraft(form: ConfigForm): ConfigDraft {
  const providerNamed = form.provider_name.trim() !== '' || form.provider_key_id.trim() !== ''
  return {
    outcomes: form.outcomes.map((o) => ({
      multiplier_bp: intOf(o.multiplier_bp),
      probability_ppm: intOf(o.probability_ppm),
    })),
    stake: {
      min_stake: intOf(form.min_stake),
      max_stake: intOf(form.max_stake),
      step: intOf(form.step),
    },
    max_single_win: intOf(form.max_single_win),
    enabled_countries: listOfCountries(form.enabled_countries),
    quantity_tiers: listOfInts(form.quantity_tiers),
    multiplier_basis: form.multiplier_basis,
    rtp_band: { min_ppm: intOf(form.band_min_ppm), max_ppm: intOf(form.band_max_ppm) },
    deliberate_lower_return_on_larger_plays: form.deliberate,
    lower_return_statement: form.lower_return_statement,
    regression_override: form.override_allowed
      ? { allowed: true, reason: form.override_reason }
      : null,
    provider: providerNamed
      ? { name: form.provider_name.trim(), signing_key_id: form.provider_key_id.trim() }
      : null,
    exposure: {
      reserve_diamonds: optionalInt(form.reserve_diamonds),
      reserve_basis: form.reserve_basis,
      max_payout_per_round: optionalInt(form.max_payout_per_round),
      max_payout_per_player_per_day: optionalInt(form.max_payout_per_player_per_day),
      max_payout_platform_per_day: optionalInt(form.max_payout_platform_per_day),
    },
  }
}

/** A signed version, back into the form, so a change starts from what is live. */
function formOf(evaluation: DraftEvaluation): ConfigForm {
  const e = evaluation.exposure
  return {
    outcomes: evaluation.outcomes.map((o) => ({
      multiplier_bp: String(o.multiplier_bp),
      probability_ppm: String(o.probability_ppm),
    })),
    min_stake: String(evaluation.stake.min_stake),
    max_stake: String(evaluation.stake.max_stake),
    step: String(evaluation.stake.step),
    max_single_win: String(evaluation.max_single_win),
    enabled_countries: evaluation.enabled_countries.join(', '),
    quantity_tiers: evaluation.quantity_tiers.join(', '),
    multiplier_basis: evaluation.multiplier_basis,
    band_min_ppm: String(evaluation.rtp_band.min_ppm),
    band_max_ppm: String(evaluation.rtp_band.max_ppm),
    deliberate: evaluation.deliberate_lower_return_on_larger_plays,
    lower_return_statement: evaluation.lower_return_statement ?? '',
    override_allowed: Boolean(evaluation.regression_override?.allowed),
    override_reason: evaluation.regression_override?.reason ?? '',
    provider_name: evaluation.provider?.name ?? '',
    provider_key_id: evaluation.provider?.signing_key_id ?? '',
    reserve_diamonds: e.reserve_diamonds === null ? '' : String(e.reserve_diamonds),
    reserve_basis: e.reserve_basis ?? '',
    // A per-round ceiling the server *defaulted* was never configured, and
    // copying the default back in would silently turn it into a configured one.
    max_payout_per_round:
      e.max_payout_per_round_source === 'configured' ? String(e.max_payout_per_round) : '',
    max_payout_per_player_per_day:
      e.max_payout_per_player_per_day === null ? '' : String(e.max_payout_per_player_per_day),
    max_payout_platform_per_day:
      e.max_payout_platform_per_day === null ? '' : String(e.max_payout_platform_per_day),
  }
}

// ══════════════════════════════════════════════════════════════════════════════

function ConfigurationScreen() {
  const { crmUser, apiUser, loading: authLoading, apiReady, apiError } = useAuth()
  const isObserver = apiUser?.role === 'observer'
  const allowed = isObserver || canAccess(crmUser, CHANCE_READ_ROLES)
  const canEdit = canAccess(crmUser, CHANCE_TEAM_ADMIN_ROLES)
  const canOwn = canAccess(crmUser, CHANCE_OWNER_ROLES)

  const params = useSearchParams()
  const router = useRouter()
  const mechanicId = params.get('mechanic') ?? ''

  const [list, setList] = useState<ReadResult<Mechanic[]> | null>(null)
  const [detail, setDetail] = useState<ReadResult<Mechanic> | null>(null)
  const [cards, setCards] = useState<ReadResult<Card[]> | null>(null)
  const [notice, setNotice] = useState('')

  const [form, setForm] = useState<ConfigForm>(BLANK)
  const [editing, setEditing] = useState(false)
  const [seeded, setSeeded] = useState('')

  const [preview, setPreview] = useState<ReadResult<DraftEvaluation> | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const [proposing, setProposing] = useState(false)
  const [activating, setActivating] = useState<ConfigVersion | null>(null)
  const [withdrawing, setWithdrawing] = useState<string | null>(null)

  const loadList = useCallback(() => {
    if (!allowed || !apiReady) return
    setList(null)
    attempt(chance.mechanics(), 'chance.mechanics').then(setList)
  }, [allowed, apiReady])

  const loadDetail = useCallback(() => {
    if (!allowed || !apiReady || !mechanicId) return
    setDetail(null)
    setCards(null)
    attempt(chance.mechanic(mechanicId), 'chance.mechanic').then(setDetail)
    attempt(board.cards(200), 'cards.board').then(setCards)
  }, [allowed, apiReady, mechanicId])

  useEffect(() => { loadList() }, [loadList])
  useEffect(() => { loadDetail() }, [loadDetail])

  const mechanic = detail?.ok ? detail.value : null
  const versions = useMemo(() => mechanic?.configs ?? [], [mechanic])
  const live = useMemo(
    () => versions.find((v) => v.status === 'live' && v.version === mechanic?.live_version) ?? null,
    [versions, mechanic],
  )
  const pending = useMemo(() => versions.filter((v) => v.status === 'draft'), [versions])

  // Seed the editor from whatever is live, once per mechanic. A change starts
  // from the version in force, because most changes are one row of the table.
  useEffect(() => {
    if (!mechanic || seeded === mechanic.id) return
    setForm(live ? formOf(live.evaluation) : BLANK)
    setSeeded(mechanic.id)
    setEditing(false)
    setPreview(null)
  }, [mechanic, live, seeded])

  // ── The live preview ───────────────────────────────────────────────────────
  //
  // Debounced, sequenced, and the only source of a margin on this page. A stale
  // response must never overwrite a newer one, or the figure on screen belongs
  // to a table that is no longer in the boxes.
  const draft = useMemo(() => toDraft(form), [form])
  const draftKey = useMemo(() => JSON.stringify(draft), [draft])
  const sequence = useRef(0)

  useEffect(() => {
    if (!canEdit || !editing || !apiReady) return
    const mine = ++sequence.current
    setPreviewing(true)
    const timer = setTimeout(() => {
      attempt(chance.preview(JSON.parse(draftKey) as ConfigDraft), 'chance.preview').then((r) => {
        if (sequence.current !== mine) return
        setPreview(r)
        setPreviewing(false)
      })
    }, 450)
    return () => clearTimeout(timer)
  }, [draftKey, canEdit, editing, apiReady])

  const evaluation = preview?.ok ? preview.value : null
  const blocked = Boolean(evaluation?.blocked)

  // Typing aid only. Not a margin, not a verdict: `parse_outcomes`
  // (`services/chance.py`) is what decides whether this column is a
  // distribution, and its refusal is quoted verbatim below the table.
  const columnTotal = draft.outcomes.reduce((sum, o) => sum + o.probability_ppm, 0)

  if (authLoading) return <Loading label="Checking your access…" />
  if (!allowed) return <Denied what="chance mechanic configuration" />

  const cardFor = (version: ConfigVersion): Card | null => {
    if (!cards?.ok) return null
    return cards.value.find((c) => c.id === version.card_id) ?? null
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <Link
            href="/chance"
            className="inline-flex items-center gap-1.5 text-slate-500 hover:text-slate-300 text-sm mb-1.5"
          >
            <ArrowLeft size={14} /> All mechanics
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2.5">
            <Settings2 size={24} className="text-pink-400" /> Configuration
          </h1>
          <p className="text-slate-400 mt-1 text-sm max-w-3xl leading-relaxed">
            The odds, the denominations, the ceilings and the markets. RTP is
            computed by the server from the table as you edit it — there is no
            field to type it into, and there will not be one, because a figure a
            person can type is a figure that can disagree with the odds it
            claims to describe.
          </p>
        </div>
        <button
          onClick={() => { loadList(); loadDetail() }}
          className="flex items-center gap-2 shrink-0 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3.5 py-2.5 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {apiReady && apiError && <Warning>{apiError}</Warning>}
      {notice && <Warning onDismiss={() => setNotice('')}>{notice}</Warning>}

      <Panel
        title="Which mechanic"
        subtitle="Every mechanic in the register, whatever state it is in. A stopped or unconfigured one is not hidden here — it is named as what it is."
      >
        <ReadPanel
          result={list}
          what="the mechanic register"
          onRetry={loadList}
          isEmpty={(v) => v.length === 0}
          emptyTitle="No mechanic exists yet"
          emptyHint="Create one from the mechanics page. It starts with no odds and no market."
        >
          {(rows) => (
            <div className="flex flex-wrap gap-2">
              {rows.map((m) => (
                <button
                  key={m.id}
                  onClick={() => router.push(`/chance/configure/?mechanic=${encodeURIComponent(m.id)}`)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    m.id === mechanicId
                      ? 'border-pink-500 bg-pink-500/10 text-white'
                      : 'border-slate-700 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  {m.name}
                  <MechanicStateBadge state={mechanicState(m)} size="small" />
                </button>
              ))}
            </div>
          )}
        </ReadPanel>
      </Panel>

      {!mechanicId ? (
        <Panel>
          <Empty
            title="Pick a mechanic"
            hint="Its configuration history, the version in force and the editor all belong to one mechanic at a time."
            icon={<Settings2 size={28} />}
          />
        </Panel>
      ) : (
        <ReadPanel result={detail} what="this mechanic" onRetry={loadDetail}>
          {(m) => (
            <div className="space-y-6">
              {/* ── What is live right now ───────────────────────────────── */}
              <Panel
                tone={m.suspended ? 'danger' : 'plain'}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {m.name}
                    <MechanicStateBadge state={mechanicState(m)} />
                    <span className="text-slate-500 text-xs font-normal">
                      {KIND_LABELS[m.kind] ?? m.kind} · {m.id}
                    </span>
                  </span>
                }
                subtitle={
                  m.suspended
                    ? `Suspended ${dateTime(m.suspended.at)} by ${m.suspended.by.name} — ${m.suspended.reason}. A suspended mechanic pays nothing and accepts nothing whatever its configuration says. Changing the configuration does not resume it.`
                    : live
                      ? `Version ${live.version} is the configuration every new round is drawn from. It stays live until a replacement is signed and activated — proposing one changes nothing.`
                      : 'No configuration has ever been signed, so this mechanic is invisible in every market.'
                }
              >
                {live ? (
                  <div className="space-y-5">
                    <EvaluationHeadline evaluation={live.evaluation} />
                    <SubSection
                      title="Markets"
                      hint="The regulatory switch (8B.0.4). Switching one off is immediate and needs no app release; adding one back is a full card."
                    >
                      {live.evaluation.enabled_countries.length === 0 ? (
                        <p className="text-amber-300 text-sm">
                          No country is enabled, so no player can see this. A valid
                          configuration, and the default.
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {live.evaluation.enabled_countries.map((c) => (
                            <span
                              key={c}
                              className="flex items-center gap-2 bg-slate-950 border border-slate-700 rounded-lg pl-3 pr-2 py-1.5 text-sm text-slate-200"
                            >
                              <Globe size={13} className="text-slate-500" /> {c}
                              {canOwn && (
                                <button
                                  onClick={() => setWithdrawing(c)}
                                  title={`Withdraw ${c} now`}
                                  className="text-slate-500 hover:text-red-300"
                                >
                                  <Trash2 size={13} />
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      )}
                    </SubSection>
                    <SubSection title="The table in force">
                      <OutcomeTableView outcomes={live.evaluation.outcomes} />
                    </SubSection>
                    <SubSection
                      title="Effective RTP per quantity tier"
                      hint="8B.3.2. What a player buying seventeen actually gets back, which is not always what a player buying one gets back."
                    >
                      <TierTable
                        tiers={live.evaluation.tiers}
                        basis={live.evaluation.multiplier_basis}
                      />
                    </SubSection>
                    <SubSection
                      title="Stake denominations and the cap"
                      hint="8B.2.5 and 8B.2.6. Whole diamonds throughout."
                    >
                      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                        <Small label="Minimum stake" value={diamonds(live.evaluation.stake.min_stake)} />
                        <Small label="Maximum stake" value={diamonds(live.evaluation.stake.max_stake)} />
                        <Small label="Step" value={diamonds(live.evaluation.stake.step)} />
                        <Small
                          label="Maximum single win"
                          value={diamonds(live.evaluation.max_single_win)}
                        />
                      </div>
                    </SubSection>
                    <SubSection
                      title="Reserve, its basis and the ceilings"
                      hint="8B.4.3 / 8B.4.4. These live inside the configuration version, so they move on the same card, with the same signature, as the odds."
                    >
                      <ExposureView exposure={live.evaluation.exposure} />
                    </SubSection>
                    {live.evaluation.flags.length > 0 && (
                      <FlagsPanel flags={live.evaluation.flags} />
                    )}
                    <RoundingNote note={live.evaluation.rounding_note} />
                    <p className="text-slate-500 text-xs">
                      Signed by {live.signed_by?.name ?? '—'}{' '}
                      {live.signed_at ? `on ${dateTime(live.signed_at)}` : ''} · live from{' '}
                      {dateTime(live.effective_from)} · card{' '}
                      <span className="font-mono">{live.card_id}</span>
                    </p>
                  </div>
                ) : (
                  <ReadOnlyNote>
                    Nothing is live. This mechanic has no odds, no denominations and
                    no market, and no player in any country can reach it. That is not
                    the same as being switched off — there is nothing to switch.
                  </ReadOnlyNote>
                )}
              </Panel>

              {/* ── Where a pending change has got to ────────────────────── */}
              {pending.length > 0 && (
                <Panel
                  tone="caution"
                  title={`${count(pending.length)} change${pending.length === 1 ? '' : 's'} raised and not yet live`}
                  subtitle={
                    live
                      ? `Version ${live.version} is still the configuration every round is drawn from, and stays so until one of these is signed and activated. A raised change pays nobody anything.`
                      : 'This mechanic has never had a live configuration, so nothing is being drawn from anything while these sit here.'
                  }
                >
                  <div className="space-y-4">
                    {pending.map((v) => (
                      <PendingChange
                        key={v.id}
                        version={v}
                        card={cardFor(v)}
                        boardResult={cards}
                        canActivate={canOwn}
                        onActivate={() => setActivating(v)}
                      />
                    ))}
                  </div>
                </Panel>
              )}

              {/* ── The editor ───────────────────────────────────────────── */}
              {canEdit ? (
                <Panel
                  title="Propose a change"
                  subtitle="Edit the table and the server re-evaluates it on every keystroke. Nothing here is written anywhere until you raise the card, and raising it changes nothing that is live."
                  right={
                    editing ? (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => { setForm(live ? formOf(live.evaluation) : BLANK); }}
                          className="bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-sm"
                        >
                          Reset to {live ? `v${live.version}` : 'a blank table'}
                        </button>
                        <button
                          onClick={() => setProposing(true)}
                          disabled={blocked || !evaluation}
                          title={
                            blocked
                              ? 'The server has already refused this draft. The reasons are below.'
                              : undefined
                          }
                          className="flex items-center gap-2 bg-pink-600 hover:bg-pink-500 disabled:bg-slate-800 disabled:text-slate-500 disabled:cursor-not-allowed text-white rounded-lg px-3.5 py-2 text-sm font-medium"
                        >
                          <ShieldCheck size={14} /> Raise the card
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setEditing(true)}
                        className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-3.5 py-2 text-sm"
                      >
                        <Settings2 size={14} /> Edit the table
                      </button>
                    )
                  }
                >
                  {!editing ? (
                    <ReadOnlyNote>
                      The editor is closed. Opening it changes nothing — it starts
                      from {live ? `version ${live.version}` : 'a blank table'} and
                      asks the server what it would do.
                    </ReadOnlyNote>
                  ) : (
                    <div className="space-y-6">
                      <Editor
                        form={form}
                        setForm={setForm}
                        columnTotal={columnTotal}
                      />

                      {/* The margin, live, from the server. */}
                      <div className="border-t border-slate-800 pt-5 space-y-5">
                        <div className="flex items-center gap-2">
                          <h3 className="text-white font-semibold text-sm">
                            What the server says this table does
                          </h3>
                          {previewing && (
                            <span className="flex items-center gap-1.5 text-slate-500 text-xs">
                              <Loader2 size={12} className="animate-spin" /> re-evaluating
                            </span>
                          )}
                        </div>

                        {preview === null ? (
                          <p className="text-slate-500 text-sm">
                            Waiting for the first evaluation…
                          </p>
                        ) : !preview.ok ? (
                          <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3.5">
                            <p className="text-red-200 font-semibold text-sm">
                              {preview.code === 'permission-denied'
                                ? 'The preview is not available to your role'
                                : 'The server cannot read this table'}
                            </p>
                            <p className="text-red-100 text-sm mt-1.5 whitespace-pre-wrap leading-relaxed">
                              {preview.reason}
                            </p>
                            <p className="text-red-300/70 text-xs mt-2">
                              No RTP is shown, because none was computed. This is not a
                              margin of zero.
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-5">
                            {evaluation && (
                              <>
                                <BlockedPanel reasons={evaluation.blocked_reasons} />
                                <EvaluationHeadline evaluation={evaluation} />
                                <SubSection
                                  title="The table, as the server read it"
                                  hint="Sorted and labelled by the server. Contribution is that row's share of the RTP above."
                                >
                                  <OutcomeTableView outcomes={evaluation.outcomes} />
                                </SubSection>
                                <SubSection
                                  title="Effective RTP per quantity tier"
                                  hint="8B.3.2. Every tier must sit inside the band, and a tier that does not is what blocks the proposal."
                                >
                                  <TierTable
                                    tiers={evaluation.tiers}
                                    basis={evaluation.multiplier_basis}
                                  />
                                </SubSection>
                                <SubSection
                                  title="Reserve, its basis and the ceilings"
                                  hint="Resolved by the server from the figures above and priced against this table's own variance."
                                >
                                  <ExposureView exposure={evaluation.exposure} />
                                </SubSection>
                                <SubSection title="Markets">
                                  <p className="text-slate-300 text-sm">
                                    {evaluation.enabled_countries.length
                                      ? evaluation.enabled_countries.join(', ')
                                      : 'None. This mechanic would be invisible everywhere.'}
                                  </p>
                                </SubSection>
                                <FlagsPanel flags={evaluation.flags} />
                                <RoundingNote note={evaluation.rounding_note} />
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </Panel>
              ) : (
                <Panel title="Proposing a change">
                  <ReadOnlyNote>
                    Editing a configuration and previewing a table are
                    `require_team_admin` on this API. Your role can read every
                    figure on this page — the odds, the margin, the reserve and the
                    markets are business record — but the editor is not shown,
                    because a form that cannot be submitted is a form that wastes
                    somebody&apos;s afternoon.
                  </ReadOnlyNote>
                </Panel>
              )}

              {/* ── History ──────────────────────────────────────────────── */}
              <Panel
                title="Every version ever written"
                subtitle="The answer to “when did this become available in that market, and who signed it”, from the record rather than from anybody's memory. Versions are immutable; a change is a new one."
              >
                {versions.length === 0 ? (
                  <p className="text-slate-500 text-sm">
                    No version has ever been written for this mechanic.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[760px]">
                      <thead>
                        <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
                          <th className="text-left font-medium py-2 pr-3">Version</th>
                          <th className="text-left font-medium py-2 px-3">Status</th>
                          <th className="text-right font-medium py-2 px-3">RTP</th>
                          <th className="text-right font-medium py-2 px-3">Max single win</th>
                          <th className="text-left font-medium py-2 px-3">Markets</th>
                          <th className="text-left font-medium py-2 px-3">Raised by</th>
                          <th className="text-left font-medium py-2 pl-3">Signed by</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {versions.map((v) => (
                          <tr key={v.id} className={v.status === 'live' ? 'bg-emerald-500/5' : ''}>
                            <td className="py-2 pr-3 text-slate-200 tabular-nums">v{v.version}</td>
                            <td className="py-2 px-3">
                              <StatusPill status={v.status} />
                            </td>
                            <td className="py-2 px-3 text-right text-slate-200 tabular-nums">
                              {v.evaluation.rtp_percent}%
                            </td>
                            <td className="py-2 px-3 text-right text-slate-300 tabular-nums">
                              {diamonds(v.evaluation.max_single_win)}
                            </td>
                            <td className="py-2 px-3 text-slate-400">
                              {v.evaluation.enabled_countries.join(' ') || '—'}
                            </td>
                            <td className="py-2 px-3 text-slate-400">
                              {v.proposed_by.name}
                              <span className="block text-slate-600 text-xs">
                                {dateTime(v.proposed_at)}
                              </span>
                            </td>
                            <td className="py-2 pl-3 text-slate-400">
                              {v.signed_by?.name ?? '—'}
                              <span className="block text-slate-600 text-xs">
                                {v.signed_at ? dateTime(v.signed_at) : 'not signed'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </div>
          )}
        </ReadPanel>
      )}

      {/* ── Mutations ───────────────────────────────────────────────────── */}

      {proposing && mechanic && (
        <ChanceReasonModal
          title={`Raise the card that changes ${mechanic.name}`}
          confirmLabel="Raise it — stage 1 of 5"
          tone="caution"
          what={
            <>
              <p>
                This writes a new configuration <strong>version</strong> and raises
                a card on the App team&apos;s board. It does not change the odds any
                player sees.{' '}
                {live
                  ? `Version ${live.version} stays live until this one is verified, signed by an owner and activated.`
                  : 'Nothing is live and nothing becomes live by raising this.'}
              </p>
              <p>
                The reason you write is the reason on the card, and it is what the
                person verifying it will read first.
              </p>
            </>
          }
          onClose={() => setProposing(false)}
          onSubmit={async (reason) => {
            const result = await chance.propose(mechanic.id, draft, reason)
            setProposing(false)
            setEditing(false)
            setNotice(
              `Version ${result.config.version} was raised as card ${result.card.id}. It is at “${
                CARD_STAGES[Math.max(0, stageIndex(result.card.stage))]?.label ?? result.card.stage
              }”. Nothing is live until an owner signs it and it is activated.`,
            )
            loadDetail()
          }}
        />
      )}

      {activating && mechanic && (
        <ChanceReasonModal
          title={`Make version ${activating.version} of ${mechanic.name} live`}
          confirmLabel="Activate — stage 5 of 5"
          tone="danger"
          reasonMode="none"
          reasonNote={`This route takes no reason of its own. The reason is the one on card ${activating.card_id}, written when it was raised, and the authority is the signature already on it — the server refuses anything that is not signed.`}
          what={
            <>
              <p>
                From the moment this returns, every <strong>new</strong> round on{' '}
                {mechanic.name} is drawn from version {activating.version}. Rounds
                already committed keep the version they were committed against.
              </p>
              <p>
                RTP {activating.evaluation.rtp_percent}%, maximum single win{' '}
                {diamonds(activating.evaluation.max_single_win)} diamonds,{' '}
                {activating.evaluation.enabled_countries.length} market
                {activating.evaluation.enabled_countries.length === 1 ? '' : 's'}
                {activating.evaluation.enabled_countries.length
                  ? ` (${activating.evaluation.enabled_countries.join(', ')})`
                  : ' — invisible everywhere'}
                .
              </p>
            </>
          }
          onClose={() => setActivating(null)}
          onSubmit={async () => {
            const v = await chance.activate(activating.card_id)
            setActivating(null)
            setNotice(`Version ${v.version} is live. Every new round is drawn from it.`)
            loadDetail()
          }}
        />
      )}

      {withdrawing && mechanic && (
        <ChanceReasonModal
          title={`Withdraw ${mechanic.name} from ${withdrawing}`}
          confirmLabel={`Withdraw ${withdrawing} now`}
          tone="danger"
          what={
            <>
              <p>
                Effective immediately and without an app release. From the moment
                this returns, a player in {withdrawing} sees exactly what a player
                in a country where this was never built sees — it is{' '}
                <strong>absent</strong>, not marked unavailable.
              </p>
              <p>
                Putting the market back is a full configuration card. The asymmetry
                is deliberate: switching a market off is a regulatory stop and
                switching one on is a decision about money.
              </p>
            </>
          }
          onClose={() => setWithdrawing(null)}
          onSubmit={async (reason) => {
            await chance.withdrawCountry(mechanic.id, withdrawing, reason)
            setWithdrawing(null)
            setNotice(`${withdrawing} was withdrawn. A new version was written recording it.`)
            loadDetail()
          }}
        />
      )}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
//  Pieces
// ══════════════════════════════════════════════════════════════════════════════

function Small({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-xl px-3.5 py-3">
      <p className="text-slate-500 text-[11px] uppercase tracking-wide">{label}</p>
      <p className="text-white text-lg font-semibold tabular-nums mt-0.5">
        {value}
        <span className="text-slate-600 text-[11px] font-normal ml-1">diamonds</span>
      </p>
    </div>
  )
}

function StatusPill({ status }: { status: string }) {
  const style: Record<string, string> = {
    live: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
    draft: 'bg-amber-500/15 text-amber-200 border-amber-500/40',
    superseded: 'bg-slate-800 text-slate-400 border-slate-700',
    withdrawn: 'bg-slate-800 text-slate-500 border-slate-700',
  }
  const label: Record<string, string> = {
    live: 'Live',
    draft: 'Raised, not live',
    superseded: 'Superseded',
    withdrawn: 'Withdrawn',
  }
  return (
    <span
      className={`inline-block border rounded-full px-2 py-0.5 text-[11px] font-medium ${
        style[status] ?? style.superseded
      }`}
    >
      {label[status] ?? status}
    </span>
  )
}

/**
 * Where one raised change sits in the five stages, and what that means.
 *
 * The board read is scoped by `cards.board_for`, so a caller who cannot see the
 * App team's board gets told that rather than shown an empty sequence. An
 * unknown stage and a stage of "raised" are different facts.
 */
function PendingChange({
  version, card, boardResult, canActivate, onActivate,
}: {
  version: ConfigVersion
  card: Card | null
  boardResult: ReadResult<Card[]> | null
  canActivate: boolean
  onActivate: () => void
}) {
  const index = stageIndex(card?.stage)
  const rejected = card?.stage === 'rejected' || card?.stage === 'failed'
  const unknown = !card

  return (
    <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <p className="text-white font-medium text-sm">
            Version {version.version} — RTP {version.evaluation.rtp_percent}%, max single win{' '}
            {diamonds(version.evaluation.max_single_win)} diamonds
          </p>
          <p className="text-slate-500 text-xs mt-1">
            Raised by {version.proposed_by.name} on {dateTime(version.proposed_at)} ·{' '}
            {version.reason}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Link
            href="/board"
            className="text-slate-400 hover:text-white text-sm underline underline-offset-2"
          >
            Card {version.card_id.slice(0, 10)}… →
          </Link>
          {canActivate && (
            <button
              onClick={onActivate}
              className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg px-3 py-2 text-sm font-medium"
            >
              <CheckCircle2 size={14} /> Activate
            </button>
          )}
        </div>
      </div>

      {version.changes.length > 0 && (
        <ul className="mt-3 space-y-1">
          {version.changes.map((c, i) => (
            <li key={i} className="text-slate-400 text-xs">
              · <span className="text-slate-300">{c.label ?? c.field}</span>: {String(c.before)}{' '}
              → <span className="text-slate-200">{String(c.after)}</span>
              {c.note ? ` — ${c.note}` : ''}
            </li>
          ))}
        </ul>
      )}

      <ol className="flex flex-wrap items-center gap-1.5 mt-4">
        {CARD_STAGES.map((s, i) => {
          const done = !unknown && !rejected && i <= index
          const here = !unknown && !rejected && i === index
          return (
            <li key={s.stage} className="flex items-center gap-1.5">
              <span
                title={s.blurb}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                  here
                    ? 'border-amber-400 bg-amber-500/15 text-amber-100'
                    : done
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                      : 'border-slate-700 bg-slate-900 text-slate-500'
                }`}
              >
                {s.label}
              </span>
              {i < CARD_STAGES.length - 1 && <ChevronRight size={12} className="text-slate-700" />}
            </li>
          )
        })}
      </ol>

      <p className="text-slate-500 text-xs mt-2.5 leading-relaxed">
        {unknown ? (
          boardResult && !boardResult.ok ? (
            <>
              The board could not be read, so where this card has got to is unknown.{' '}
              {boardResult.reason}
            </>
          ) : (
            <>
              This card is not on the board you can read. A chance configuration card
              is raised on the <strong>App</strong> team&apos;s board, and{' '}
              <code className="text-slate-400">cards.board_for</code> scopes that read
              to your own team unless you are an owner or the Observer. The stage is
              unknown to this screen — it is not “raised”, and it is not stuck.
            </>
          )
        ) : rejected ? (
          <>
            This card was {card?.stage === 'rejected' ? 'rejected' : 'not executed'}.{' '}
            {card?.rejection_reason ?? ''} The version stays on the record; nothing
            about it is live.
          </>
        ) : (
          <>
            {CARD_STAGES[index]?.blurb}{' '}
            {index >= 3
              ? 'It has been signed. An owner still has to activate it before a single round is drawn from it.'
              : 'Until an owner signs it, the version in force is unchanged and no player sees anything different.'}
          </>
        )}
      </p>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
//  The editor
// ══════════════════════════════════════════════════════════════════════════════

function Editor({
  form, setForm, columnTotal,
}: {
  form: ConfigForm
  setForm: (next: ConfigForm) => void
  columnTotal: number
}) {
  const set = <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) =>
    setForm({ ...form, [key]: value })

  const setOutcome = (i: number, key: keyof FormOutcome, value: string) => {
    const outcomes = form.outcomes.map((o, j) => (j === i ? { ...o, [key]: digits(value) } : o))
    setForm({ ...form, outcomes })
  }

  return (
    <div className="space-y-6">
      <SubSection
        title="The outcome table"
        hint="One row per outcome. The multiplier is basis points of the stake — 10,000 is 1×, 170,000 is 17×. The probability is parts per million and the column must sum to exactly 1,000,000."
        right={
          <span
            className={`text-xs tabular-nums ${
              columnTotal === PROBABILITY_TOTAL ? 'text-emerald-400/80' : 'text-amber-300'
            }`}
          >
            column total {count(columnTotal)} / {count(PROBABILITY_TOTAL)} ppm
            <span className="text-slate-600 ml-1.5">typing aid — the server decides</span>
          </span>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr className="text-slate-500 text-[11px] uppercase tracking-wide border-b border-slate-800">
                <th className="text-left font-medium py-2 pr-3">Multiplier (bp)</th>
                <th className="text-left font-medium py-2 px-3">Probability (ppm)</th>
                <th className="text-left font-medium py-2 px-3">Reads as</th>
                <th className="py-2 pl-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {form.outcomes.map((o, i) => (
                <tr key={i}>
                  <td className="py-1.5 pr-3">
                    <input
                      value={o.multiplier_bp}
                      onChange={(e) => setOutcome(i, 'multiplier_bp', e.target.value)}
                      inputMode="numeric"
                      className="w-32 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm text-white tabular-nums focus:outline-none focus:border-pink-500"
                    />
                  </td>
                  <td className="py-1.5 px-3">
                    <input
                      value={o.probability_ppm}
                      onChange={(e) => setOutcome(i, 'probability_ppm', e.target.value)}
                      inputMode="numeric"
                      className="w-32 bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm text-white tabular-nums focus:outline-none focus:border-pink-500"
                    />
                  </td>
                  <td className="py-1.5 px-3 text-slate-500 text-xs">
                    {intOf(o.multiplier_bp) / MULTIPLIER_ONE}× on{' '}
                    {ppmPercent(intOf(o.probability_ppm), 4)} of rolls
                  </td>
                  <td className="py-1.5 pl-3 text-right">
                    <button
                      onClick={() =>
                        setForm({ ...form, outcomes: form.outcomes.filter((_, j) => j !== i) })
                      }
                      disabled={form.outcomes.length <= 1}
                      className="text-slate-600 hover:text-red-300 disabled:opacity-30 disabled:cursor-not-allowed"
                      title="Remove this row"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          onClick={() =>
            setForm({
              ...form,
              outcomes: [...form.outcomes, { multiplier_bp: '0', probability_ppm: '0' }],
            })
          }
          className="flex items-center gap-1.5 mt-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-1.5 text-xs"
        >
          <Plus size={12} /> Add a row
        </button>
      </SubSection>

      <SubSection
        title="Stake denominations"
        hint="8B.2.5. Whole diamonds. A step that never reaches the maximum makes the top denomination unplayable, and the server refuses that table."
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Text label="Minimum stake" value={form.min_stake} onChange={(v) => set('min_stake', digits(v))} unit="diamonds" />
          <Text label="Maximum stake" value={form.max_stake} onChange={(v) => set('max_stake', digits(v))} unit="diamonds" />
          <Text label="Step" value={form.step} onChange={(v) => set('step', digits(v))} unit="diamonds" />
        </div>
      </SubSection>

      <SubSection
        title="Maximum single win"
        hint="8B.2.6. Mandatory, and the only thing bounding the worst case on one round. It also becomes the per-round payout ceiling unless a tighter one is set below."
      >
        <Text
          label="Maximum single win"
          value={form.max_single_win}
          onChange={(v) => set('max_single_win', digits(v))}
          unit="diamonds"
        />
      </SubSection>

      <SubSection
        title="Quantity tiers and what the multiplier multiplies"
        hint="8B.3.1 / 8B.3.2. On the total stake, a player buying seventeen wins seventeen times as much. On the unit stake they do not, which 8B.3.1 permits only where it is deliberate and stated."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Text
            label="Quantity tiers"
            value={form.quantity_tiers}
            onChange={(v) => set('quantity_tiers', v)}
            hint="Whole numbers, comma separated. e.g. 1, 10, 17"
          />
          <div>
            <label className="block text-slate-400 text-xs uppercase tracking-wide mb-1.5">
              Multiplier basis
            </label>
            <div className="grid grid-cols-2 gap-2">
              {(['total_stake', 'unit_stake'] as MultiplierBasis[]).map((b) => (
                <button
                  key={b}
                  onClick={() => set('multiplier_basis', b)}
                  className={`rounded-lg border px-3 py-2 text-sm ${
                    form.multiplier_basis === b
                      ? 'border-pink-500 bg-pink-500/10 text-white'
                      : 'border-slate-700 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  {b.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>
        </div>
        {form.multiplier_basis === 'unit_stake' && (
          <div className="space-y-2 mt-1">
            <Check
              label="This lower return on larger plays is deliberate"
              checked={form.deliberate}
              onChange={(v) => set('deliberate', v)}
            />
            <Text
              label="What players will be told"
              value={form.lower_return_statement}
              onChange={(v) => set('lower_return_statement', v)}
              hint="At least eight characters, or the server blocks the draft."
            />
          </div>
        )}
      </SubSection>

      <SubSection
        title="The agreed RTP band"
        hint="8B.3.4. Every quantity tier's effective RTP must sit inside it. Moving the band is a change to the margin and moves on this same signed card."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Text
            label="Band minimum (ppm)"
            value={form.band_min_ppm}
            onChange={(v) => set('band_min_ppm', digits(v))}
            hint={`reads as ${ppmPercent(intOf(form.band_min_ppm))}`}
          />
          <Text
            label="Band maximum (ppm)"
            value={form.band_max_ppm}
            onChange={(v) => set('band_max_ppm', digits(v))}
            hint={`reads as ${ppmPercent(intOf(form.band_max_ppm))}`}
          />
        </div>
        <div className="space-y-2 mt-1">
          <Check
            label="An owner accepts an effective RTP that falls as stake rises (8B.10.4)"
            checked={form.override_allowed}
            onChange={(v) => set('override_allowed', v)}
          />
          {form.override_allowed && (
            <Text
              label="Why"
              value={form.override_reason}
              onChange={(v) => set('override_reason', v)}
              hint="At least eight characters. Whales generate most of the revenue; this gives them the worst odds in the product."
            />
          )}
        </div>
      </SubSection>

      <SubSection
        title="Enabled countries"
        hint="8B.0.4. The regulatory switch. Leave it empty and the mechanic is invisible everywhere, which is a valid configuration and the default."
      >
        <Text
          label="ISO 3166-1 alpha-2 codes"
          value={form.enabled_countries}
          onChange={(v) => set('enabled_countries', v.toUpperCase())}
          hint="Comma separated. e.g. IN, AE"
        />
      </SubSection>

      <SubSection
        title="Reserve and ceilings"
        hint="8B.4.3 / 8B.4.4. Leave a ceiling empty to mean “no ceiling of this kind” — the evaluation states that as a flag rather than reading it as zero, because a ceiling of zero would stop the mechanic paying anything at all."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Text
            label="Reserve"
            value={form.reserve_diamonds}
            onChange={(v) => set('reserve_diamonds', digits(v))}
            unit="diamonds"
            hint="Empty means no reserve is enforced."
          />
          <Text
            label="Per-round payout ceiling"
            value={form.max_payout_per_round}
            onChange={(v) => set('max_payout_per_round', digits(v))}
            unit="diamonds"
            hint="Empty defaults to the maximum single win. It can only tighten it."
          />
          <Text
            label="Per player, per day"
            value={form.max_payout_per_player_per_day}
            onChange={(v) => set('max_payout_per_player_per_day', digits(v))}
            unit="diamonds"
          />
          <Text
            label="Platform, per day"
            value={form.max_payout_platform_per_day}
            onChange={(v) => set('max_payout_platform_per_day', digits(v))}
            unit="diamonds"
            hint="Crossing this auto-suspends the mechanic."
          />
        </div>
        <Text
          label="Reserve basis"
          value={form.reserve_basis}
          onChange={(v) => set('reserve_basis', v)}
          hint="How the figure was arrived at, in a sentence an owner can disagree with. The bad-run guidance below the preview prices a three-sigma run; quoting it is a perfectly good basis."
        />
      </SubSection>

      <SubSection
        title="Third-party provider"
        hint="8B.1.4. Optional. Never a URL and never a secret — the name selects the shared signing key, and the key id is what a rotation moves."
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Text
            label="Provider name"
            value={form.provider_name}
            onChange={(v) => set('provider_name', v.toLowerCase())}
            hint="Lower case letters, digits and underscores."
          />
          <Text
            label="Signing key id"
            value={form.provider_key_id}
            onChange={(v) => set('provider_key_id', v)}
          />
        </div>
      </SubSection>
    </div>
  )
}

function Text({
  label, value, onChange, unit, hint,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  unit?: string
  hint?: string
}) {
  return (
    <div>
      <label className="block text-slate-400 text-xs uppercase tracking-wide mb-1.5">
        {label}
        {unit && <span className="text-slate-600 normal-case ml-1.5">({unit})</span>}
      </label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white tabular-nums focus:outline-none focus:border-pink-500"
      />
      {hint && <p className="text-slate-600 text-[11px] mt-1 leading-snug">{hint}</p>}
    </div>
  )
}

function Check({
  label, checked, onChange,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-pink-500"
      />
      <span className="text-slate-300 text-sm leading-snug">{label}</span>
    </label>
  )
}

/** `useSearchParams` needs a Suspense boundary under `output: 'export'`. */
export default function ConfigurationPage() {
  return (
    <Suspense fallback={<Loading label="Reading the configuration…" />}>
      <ConfigurationScreen />
    </Suspense>
  )
}
