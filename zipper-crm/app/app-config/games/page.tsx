'use client'

/**
 * Games (B6, 3 Nov 2026) — the Owner's switches and settings for every game, the money each game moved, and the
 * latest tables.
 *
 *   * Settings are `appConfig/games`, read by the game functions on every action. Every game is OFF until it is
 *     switched on here; the master switch turns them all off at once. Only the Owner may save (firestore.rules E4).
 *   * What is saved is what `mergeGamesConfig` makes of the form — the same clamping the server applies — and a
 *     form with problems is not saved at all.
 *   * Money: `GET /api/reports/games` — diamonds in and out per game, Zipper's fee, and every match's
 *     zero-difference check (entries = payouts + fee + refunds).
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { collection, doc, getDoc, getDocs, limit, orderBy, query, serverTimestamp, setDoc } from 'firebase/firestore'
import { AlertTriangle, CheckCircle, Gamepad2, Loader2, Save } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { reports, type AnyReport } from '@/lib/apiReports'
import {
  GAME_EXTRAS, GAME_IDS, GAME_LABELS, MAX_PLAYERS, MULTIPLAYER, type GameId, type GamesConfig,
  gamesConfigProblems, mergeGamesConfig, parseNumberList, winnerGets,
} from '@/lib/gamesConfigGuard'

const inputCls = 'w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500'

interface MatchRow { id: string; gameId: string; status: string; capacity: number; entry: number; pool: number; fee?: number }

export default function GamesConfigPage() {
  const { crmUser } = useAuth()
  const router = useRouter()
  const allowed = !!crmUser && canAccess(crmUser, ['superadmin'])
  const [cfg, setCfg] = useState<GamesConfig | null>(null)
  const [text, setText] = useState<Record<string, { entries: string; modes: string }>>({})
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; msg: string } | null>(null)
  const [money, setMoney] = useState<AnyReport | null>(null)
  const [moneyError, setMoneyError] = useState('')
  const [matches, setMatches] = useState<MatchRow[]>([])

  const load = useCallback(async () => {
    const snap = await getDoc(doc(db, 'appConfig', 'games'))
    const merged = mergeGamesConfig(snap.exists() ? snap.data() : undefined)
    setCfg(merged)
    const t: Record<string, { entries: string; modes: string }> = {}
    for (const id of GAME_IDS) t[id] = { entries: merged.games[id].entryOptions.join(', '), modes: merged.games[id].modes.join(', ') }
    setText(t)
    try {
      const q = query(collection(db, 'gameMatches'), orderBy('createdAtMs', 'desc'), limit(20))
      const rows = await getDocs(q)
      setMatches(rows.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<MatchRow, 'id'>) })))
    } catch { setMatches([]) }
    reports.games({}).then(setMoney).catch((e: unknown) => setMoneyError(e instanceof Error ? e.message : 'Could not load.'))
  }, [])

  useEffect(() => {
    if (!crmUser) return
    if (!allowed) { router.push('/'); return }
    load().catch(() => setNotice({ ok: false, msg: 'Could not load the games settings.' }))
  }, [crmUser, allowed, router, load])

  function patch(id: GameId, change: Partial<GamesConfig['games'][GameId]>) {
    setCfg((c) => (c ? { ...c, games: { ...c.games, [id]: { ...c.games[id], ...change } } } : c))
  }

  async function save() {
    if (!cfg) return
    // Read the free-text lists, then let the guard clamp everything exactly as the server will.
    const draft = { ...cfg, games: { ...cfg.games } }
    for (const id of GAME_IDS) {
      draft.games[id] = { ...draft.games[id], entryOptions: parseNumberList(text[id]?.entries ?? ''), modes: parseNumberList(text[id]?.modes ?? '') }
    }
    const clean = mergeGamesConfig(draft)
    const problems = gamesConfigProblems(clean)
    if (problems.length) { setNotice({ ok: false, msg: problems.join(' ') }); return }
    setSaving(true)
    try {
      await setDoc(doc(db, 'appConfig', 'games'), { ...clean, updatedAt: serverTimestamp(), updatedBy: crmUser?.uid ?? '' })
      setNotice({ ok: true, msg: 'Saved. Games read this on the next action.' })
      await load()
    } catch {
      setNotice({ ok: false, msg: 'Save failed — only the Owner may change games.' })
    } finally { setSaving(false) }
  }

  if (!allowed) return <div className="flex items-center justify-center min-h-64"><p className="text-slate-400">Access denied.</p></div>
  if (!cfg) return <div className="flex items-center justify-center py-32"><Loader2 size={28} className="text-pink-500 animate-spin" /></div>

  const totals = (money?.totals ?? {}) as Record<string, unknown>
  const unbalanced = Array.isArray(totals.unbalanced_matches) ? (totals.unbalanced_matches as unknown[]) : []

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2"><Gamepad2 size={22} /> Games</h1>
          <p className="text-slate-400 text-sm mt-1 max-w-3xl">
            Every game is off until you switch it on here. Switched off, a game disappears from the app; tables
            already playing still finish and pay out. Results are always decided by the server.
          </p>
        </div>
        <button onClick={save} disabled={saving}
          className="flex items-center gap-2 bg-pink-600 hover:bg-pink-500 disabled:opacity-50 text-white rounded-lg px-4 py-2 text-sm">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
        </button>
      </div>

      {notice && (
        <div className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm border ${notice.ok ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-red-500/10 border-red-500/30 text-red-300'}`}>
          {notice.ok ? <CheckCircle size={14} /> : <AlertTriangle size={14} />} {notice.msg}
        </div>
      )}

      <label className="flex items-center gap-3 bg-slate-800 rounded-xl px-4 py-3">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} />
        <span className="text-white font-medium">Games on (master switch)</span>
        <span className="text-slate-400 text-xs">Off hides every game, whatever the switches below say.</span>
      </label>

      <label className="flex items-center gap-3 bg-slate-800 rounded-xl px-4 py-3">
        <span className="text-white font-medium whitespace-nowrap">Largest entry or stake</span>
        <input className={`${inputCls} max-w-40`} type="number" value={cfg.limits.maxEntryPerRound}
          onChange={(e) => setCfg({ ...cfg, limits: { ...cfg.limits, maxEntryPerRound: Number(e.target.value) } })} />
        <span className="text-slate-400 text-xs">diamonds, in any one game — larger entries are refused by the server.</span>
      </label>

      <label className="flex items-center gap-3 bg-slate-800 rounded-xl px-4 py-3">
        <span className="text-white font-medium whitespace-nowrap">Daily loss limit</span>
        <input className={`${inputCls} max-w-40`} type="number" min={0} value={cfg.limits.dailyLossLimit}
          onChange={(e) => setCfg({ ...cfg, limits: { ...cfg.limits, dailyLossLimit: Number(e.target.value) } })} />
        <span className="text-slate-400 text-xs">diamonds a player may lose at games in one day (IST), net of wins — 0 is no limit. A new entry or stake past it is refused.</span>
      </label>

      <div className="grid md:grid-cols-2 gap-4">
        {GAME_IDS.map((id) => {
          const g = cfg.games[id]
          const multi = MULTIPLAYER.includes(id)
          const example = multi && g.entryOptions.length ? winnerGets(g.entryOptions[0], g.modes[0] ?? 2, g.platformFeePct) : null
          return (
            <div key={id} className="bg-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-white font-semibold">{GAME_LABELS[id]}</h2>
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input type="checkbox" checked={g.enabled} onChange={(e) => patch(id, { enabled: e.target.checked })} /> On
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input type="checkbox" checked={g.maintenance} onChange={(e) => patch(id, { maintenance: e.target.checked })} />
                Maintenance (no new entries)
              </label>
              <div>
                <p className="text-xs text-slate-400 mb-1">{multi ? 'Entry amounts (diamonds)' : 'Entry amounts — empty means any amount between min and max'}</p>
                <input className={inputCls} value={text[id]?.entries ?? ''} onChange={(e) => setText({ ...text, [id]: { ...text[id], entries: e.target.value } })} />
              </div>
              {!multi && (
                <div className="grid grid-cols-3 gap-2">
                  <div><p className="text-xs text-slate-400 mb-1">Min</p><input className={inputCls} type="number" value={g.minEntry} onChange={(e) => patch(id, { minEntry: Number(e.target.value) })} /></div>
                  <div><p className="text-xs text-slate-400 mb-1">Max</p><input className={inputCls} type="number" value={g.maxEntry} onChange={(e) => patch(id, { maxEntry: Number(e.target.value) })} /></div>
                  <div><p className="text-xs text-slate-400 mb-1">House edge %</p><input className={inputCls} type="number" value={g.houseEdgePct} onChange={(e) => patch(id, { houseEdgePct: Number(e.target.value) })} /></div>
                </div>
              )}
              {multi && (
                <div className="grid grid-cols-3 gap-2">
                  <div><p className="text-xs text-slate-400 mb-1">Table sizes</p><input className={inputCls} value={text[id]?.modes ?? ''} onChange={(e) => setText({ ...text, [id]: { ...text[id], modes: e.target.value } })} /></div>
                  <div><p className="text-xs text-slate-400 mb-1">Zipper fee %</p><input className={inputCls} type="number" value={g.platformFeePct} onChange={(e) => patch(id, { platformFeePct: Number(e.target.value) })} /></div>
                  <div><p className="text-xs text-slate-400 mb-1">Turn (s)</p><input className={inputCls} type="number" value={g.turnSeconds} onChange={(e) => patch(id, { turnSeconds: Number(e.target.value) })} /></div>
                </div>
              )}
              {multi && (
                <div className="grid grid-cols-3 gap-2">
                  <div><p className="text-xs text-slate-400 mb-1">Wait to fill (min)</p><input className={inputCls} type="number" value={g.waitMinutes} onChange={(e) => patch(id, { waitMinutes: Number(e.target.value) })} /></div>
                  {(GAME_EXTRAS[id] ?? []).map((x) => (
                    <div key={x.key}>
                      <p className="text-xs text-slate-400 mb-1">{x.label}</p>
                      <input className={inputCls} type="number" min={x.min} max={x.max} value={g[x.key] ?? x.def} onChange={(e) => patch(id, { [x.key]: Number(e.target.value) })} />
                    </div>
                  ))}
                </div>
              )}
              {multi && <p className="text-xs text-slate-500">Tables of 2 to {MAX_PLAYERS[id] ?? 6} players.</p>}
              {example && (
                <p className="text-xs text-slate-400">
                  Example: {g.modes[0] ?? 2} × ◆{g.entryOptions[0]} = pool ◆{example.pool} → winner ◆{example.winner}, Zipper ◆{example.fee}.
                </p>
              )}
            </div>
          )
        })}
      </div>

      <div className="bg-slate-800 rounded-xl p-4 space-y-2">
        <h2 className="text-white font-semibold">Money — last 30 days</h2>
        {moneyError && <p className="text-red-300 text-sm">{moneyError}</p>}
        {money && (
          <>
            <p className="text-sm text-slate-300">
              In ◆{String(totals.diamonds_in ?? 0)} · out ◆{String(totals.diamonds_out ?? 0)} · Zipper fees ◆{String(totals.fees ?? 0)} ·
              net retained ◆{String(totals.net_retained ?? 0)} (diamonds, not cash revenue)
            </p>
            <p className={`text-sm ${unbalanced.length ? 'text-red-300' : 'text-emerald-300'}`}>
              {unbalanced.length ? `${unbalanced.length} match(es) do not balance — investigate.` : `Every match balances (${String(totals.matches_checked ?? 0)} checked).`}
            </p>
            <table className="w-full text-sm text-slate-300">
              <thead><tr className="text-slate-400 text-xs"><th className="text-left">Game</th><th>Sessions</th><th>Players</th><th>In</th><th>Out</th><th>Fee</th></tr></thead>
              <tbody>
                {(money.rows as Array<Record<string, unknown>>).map((r) => (
                  <tr key={String(r.game)}>
                    <td>{GAME_LABELS[r.game as GameId] ?? String(r.game)}</td>
                    <td className="text-center">{String(r.sessions)}</td>
                    <td className="text-center">{String(r.unique_players)}</td>
                    <td className="text-center">{String(Number(r.entries) + Number(r.stakes))}</td>
                    <td className="text-center">{String(Number(r.payouts) + Number(r.wins) + Number(r.refunds))}</td>
                    <td className="text-center">{String(r.fees)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="bg-slate-800 rounded-xl p-4">
        <h2 className="text-white font-semibold mb-2">Latest tables</h2>
        {matches.length === 0 ? <p className="text-slate-400 text-sm">No tables yet.</p> : (
          <table className="w-full text-sm text-slate-300">
            <thead><tr className="text-slate-400 text-xs"><th className="text-left">Table</th><th>Game</th><th>Status</th><th>Players</th><th>Entry</th><th>Pool</th><th>Fee</th></tr></thead>
            <tbody>
              {matches.map((m) => (
                <tr key={m.id}>
                  <td className="font-mono text-xs">{m.id}</td>
                  <td className="text-center">{GAME_LABELS[m.gameId as GameId] ?? m.gameId}</td>
                  <td className="text-center">{m.status}</td>
                  <td className="text-center">{m.capacity}</td>
                  <td className="text-center">◆{m.entry}</td>
                  <td className="text-center">◆{m.pool}</td>
                  <td className="text-center">{m.fee != null ? `◆${m.fee}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
