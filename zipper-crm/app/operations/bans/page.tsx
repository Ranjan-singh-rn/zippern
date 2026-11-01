'use client'

/**
 * Device bans.
 *
 * The device id is shown in full and is searchable. The page this replaces
 * masked every id to its last four characters and had no search, so the one
 * question this screen exists to answer — "is this device banned?" — could not
 * be answered from it.
 *
 * A ban document is keyed by the device id, because that is the path the
 * Android app reads. Lifting a ban deletes the document, because the app only
 * checks whether it exists; the UI says so before you press the button.
 *
 * ── THE SECOND QUESTION: WHY IS IT BARRED, AND WHO RELEASES IT ──────────────
 *
 * A `bannedDevices` record is created two ways, and they behave differently:
 *
 *   cascade   `ban_user` bars every handset a banned account has been seen on
 *             and names that account in `sourceAccounts`. Unbanning the account
 *             takes it off the list, and the record is deleted only once the
 *             list is empty — so a handset two banned accounts share stays
 *             barred until BOTH are unbanned.
 *   manual    Ops decided about the handset itself — a device farm, a stolen
 *             phone, a reseller's rig. `manualBan: true`, and no account's
 *             unban ever lifts it.
 *
 * Neither fact was on this screen, so a barred handset was a device id and a
 * sentence, and "unban this person and the phone comes back" was a guess. Both
 * are columns now, and every holding account links to its own record, because
 * the operator's real question is which account to unban to release the phone —
 * or whether unbanning anybody would release it at all.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Check, Loader2, PlusCircle, Search, ShieldAlert, ShieldCheck,
  UserX, X,
} from 'lucide-react'
import api, { ApiError, type BannedDevice, type DeviceType } from '@/lib/api'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { Denied, Loading } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'
import { nameOrReference, type IdentityFacts } from '@/lib/identity'
import { useIdentities } from '@/lib/useIdentities'

const VIEW_ROLES: CrmRole[] = [
  'superadmin', 'ops_admin', 'ops_member', 'app_admin', 'app_member',
]

/** The API caps this read at 500. Ask for the cap and label it when full. */
const LIMIT = 500

/**
 * A ban record, with the two fields that decide whether it can ever be lifted
 * by unbanning somebody.
 *
 * Declared here rather than in `lib/api.ts`: `BannedDevice` there predates both
 * fields. They are on the wire regardless — `list_banned_devices`
 * (`backend/app/services/users.py:2282`) returns each Firestore document as it
 * stands, and `ban_device` (:2108) writes `sourceAccounts` with every ban and
 * `manualBan` on the Ops-placed ones.
 *
 * Both optional, and that is not defensiveness for its own sake: a record
 * written before `sourceAccounts` existed genuinely has neither, and
 * `manualBan` is only ever written when true.
 */
type DeviceBanRecord = BannedDevice & {
  /** The accounts whose ban caused this record. Empty on an Ops-placed ban. */
  sourceAccounts?: string[]
  /** Ops's own decision about the handset. Never lifted by an account's unban. */
  manualBan?: boolean
}

/**
 * Which accounts are holding this ban up.
 *
 * `sourceAccounts` is the authoritative list and is what `unban_user` removes a
 * uid from. `userUids` is read as a fallback for records written before that
 * field existed — those carry one uid and no source list, and
 * `_device_bans_caused_by` (`backend/app/services/users.py:1940`) queries BOTH
 * arrays for exactly that reason, so an account named only in `userUids` does
 * still release the handset when it is unbanned. Showing only `sourceAccounts`
 * would report those legacy records as held up by nobody, which would read as
 * "unbanning will not help" about a phone where it is the only thing that will.
 */
function heldBy(d: DeviceBanRecord): string[] {
  const sources = d.sourceAccounts ?? []
  return sources.length ? sources : d.userUids ?? []
}

function fmt(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN')
}

function millis(value: string | null | undefined): number | null {
  if (!value) return null
  const d = new Date(value)
  return isNaN(d.getTime()) ? null : d.getTime()
}

type Failure = { message: string; isRule: boolean }

export default function DeviceBansPage() {
  const { crmUser, loading: authLoading } = useAuth()
  const canView = canAccess(crmUser, VIEW_ROLES)

  const [devices, setDevices] = useState<DeviceBanRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [banOpen, setBanOpen] = useState(false)
  const [deviceId, setDeviceId] = useState('')
  const [deviceType, setDeviceType] = useState<DeviceType>('android_id')
  const [reason, setReason] = useState('')
  const [userUids, setUserUids] = useState('')

  const [lifting, setLifting] = useState<DeviceBanRecord | null>(null)
  const [liftReason, setLiftReason] = useState('')

  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)

  // B1: the accounts holding a ban are Firebase uids — named from `users`
  // (staff-readable). Names only: this screen never needed their contacts.
  const holders = useIdentities({ enabled: canView, people: devices.flatMap(heldBy) })
  const names = holders.people

  const [lookup, setLookup] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setDevices(await api.users.bannedDevices(LIMIT))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the banned devices.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!canView) return
    load()
  }, [canView, load])

  function openBan() {
    setBanOpen(true)
    setDeviceId('')
    setDeviceType('android_id')
    setReason('')
    setUserUids('')
    setFailure(null)
    setSuccess('')
  }

  function openLift(device: DeviceBanRecord) {
    setLifting(device)
    setLiftReason('')
    setFailure(null)
    setSuccess('')
  }

  async function submitBan() {
    const id = deviceId.trim()
    const why = reason.trim()
    if (!id) {
      setFailure({ message: 'A device id is required — it is the key the app looks the ban up by.', isRule: true })
      return
    }
    if (why.length < 3) {
      setFailure({ message: 'A reason of at least 3 characters is required.', isRule: true })
      return
    }

    setBusy(true)
    setFailure(null)
    try {
      await api.users.banDevice({
        device_id: id,
        device_type: deviceType,
        reason: why,
        user_uids: userUids.split(',').map((s) => s.trim()).filter(Boolean),
      })
      setBanOpen(false)
      setSuccess(`Device ${id} is banned. The app checks this id on launch, so it applies now.`)
      await load()
    } catch (err) {
      setFailure(
        err instanceof ApiError
          ? { message: err.message, isRule: err.isRule }
          : { message: 'That did not work. Try again.', isRule: false },
      )
    } finally {
      setBusy(false)
    }
  }

  async function submitLift() {
    if (!lifting) return
    const why = liftReason.trim()
    if (why.length < 3) {
      setFailure({ message: 'A reason of at least 3 characters is required.', isRule: true })
      return
    }

    setBusy(true)
    setFailure(null)
    try {
      await api.users.unbanDevice(lifting.deviceId || lifting.id, why)
      const lifted = lifting.deviceId || lifting.id
      setLifting(null)
      setSuccess(`Ban lifted for ${lifted}. The record is gone; the audit log keeps the history.`)
      await load()
    } catch (err) {
      setFailure(
        err instanceof ApiError
          ? { message: err.message, isRule: err.isRule }
          : { message: 'That did not work. Try again.', isRule: false },
      )
    } finally {
      setBusy(false)
    }
  }

  const columns = useMemo<Column<DeviceBanRecord>[]>(() => [
    {
      key: 'deviceId',
      header: 'Device id',
      value: (d) => d.deviceId || d.id,
      render: (d) => (
        <span className="font-mono text-xs text-white break-all">{d.deviceId || d.id}</span>
      ),
    },
    {
      key: 'deviceType',
      header: 'Type',
      hideOnMobile: true,
      render: (d) => (
        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 whitespace-nowrap">
          {d.deviceType === 'imei' ? 'IMEI' : 'Android id'}
        </span>
      ),
    },
    {
      key: 'reason',
      header: 'Why',
      render: (d) => <span className="text-slate-300">{d.reason || '—'}</span>,
    },
    {
      key: 'manualBan',
      header: 'Placed by',
      value: (d) => (d.manualBan ? 'Ops decision' : 'Account ban'),
      render: (d) => <Origin record={d} />,
    },
    {
      // The question an operator actually arrives with: unban whom, and does
      // that even release the phone? A manual ban answers "nobody" — no account
      // decision lifts it — and saying so here is the point of the column.
      key: 'heldBy',
      header: 'Held up by',
      sortable: false,
      value: (d) => heldBy(d).join(' '),
      render: (d) => {
        const uids = heldBy(d)
        if (!uids.length) {
          return (
            <span className="text-slate-500 text-xs">
              {d.manualBan ? 'Nobody — Ops placed it' : 'No account named'}
            </span>
          )
        }
        return (
          <div className="flex flex-wrap gap-1 max-w-[220px]">
            {uids.map((uid) => (
              <Link
                key={uid}
                href={`/users/${uid}`}
                title={uid}
                className="text-[11px] text-pink-400 hover:text-pink-300 break-all"
              >
                {nameOrReference(names.get(uid), uid, 'account')}
              </Link>
            ))}
          </div>
        )
      },
    },
    {
      key: 'bannedByName',
      header: 'Banned by',
      hideOnMobile: true,
      value: (d) => d.bannedByName || d.bannedBy || '',
      render: (d) => <span className="text-slate-400">{d.bannedByName || d.bannedBy || '—'}</span>,
    },
    {
      key: 'bannedAt',
      header: 'When',
      hideOnMobile: true,
      value: (d) => millis(d.bannedAt),
      render: (d) => <span className="text-slate-400 text-xs whitespace-nowrap">{fmt(d.bannedAt)}</span>,
    },
    {
      key: 'lift',
      header: '',
      sortable: false,
      align: 'right',
      render: (d) => (
        <button
          onClick={() => openLift(d)}
          className="inline-flex items-center gap-1.5 bg-green-500/10 hover:bg-green-500/20 border border-green-500/30 text-green-300 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap"
        >
          <ShieldCheck size={13} /> Lift
        </button>
      ),
    },
  ], [names])

  // The one question this page exists to answer, answered as a yes or a no
  // rather than as an empty table the reader has to interpret.
  const term = lookup.trim().toLowerCase()
  const idOf = (d: DeviceBanRecord) => (d.deviceId || d.id)
  const exact = term ? devices.find((d) => idOf(d).toLowerCase() === term) ?? null : null
  const partial = term && !exact
    ? devices.filter((d) => idOf(d).toLowerCase().includes(term))
    : []
  const atCap = devices.length >= LIMIT

  if (authLoading) return <Loading label="Checking your access…" />
  if (!canView) return <Denied what="device bans" />

  return (
    <div className="max-w-[1400px] mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white">Device bans</h1>
          <p className="text-slate-400 text-sm mt-1">
            Search the full device id to confirm whether a specific device is banned.
          </p>
        </div>
        <button
          onClick={openBan}
          className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors"
        >
          <PlusCircle size={16} /> Ban a device
        </button>
      </div>

      {success && (
        <div className="flex items-start justify-between gap-3 bg-green-500/10 border border-green-500/30 rounded-xl px-4 py-3 mb-4">
          <div className="flex items-start gap-2">
            <Check size={15} className="text-green-400 mt-0.5 shrink-0" />
            <p className="text-green-100 text-sm">{success}</p>
          </div>
          <button onClick={() => setSuccess('')} className="text-green-400/70 hover:text-green-200">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="space-y-2 mb-4">
        <div className="flex items-start gap-2 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
          <AlertTriangle size={15} className="text-slate-500 mt-0.5 shrink-0" />
          <p className="text-slate-400 text-sm">
            Lifting a ban <strong className="text-slate-200">deletes the record</strong>. The app only
            checks whether a document exists for the device id, so keeping a lifted row would leave the
            device locked out forever. The audit log keeps who banned it, who lifted it and why.
          </p>
        </div>
        {/* The difference between the two kinds, said once, at the top. Lifting
            from this screen is a decision about the HANDSET and is
            unconditional — unlike the release inside an account's unban, which
            consults both of these fields and leaves a record standing when
            somebody else is holding it up. */}
        <div className="flex items-start gap-2 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
          <UserX size={15} className="text-slate-500 mt-0.5 shrink-0" />
          <p className="text-slate-400 text-sm">
            A ban marked <strong className="text-slate-200">Ops decision</strong> is about the
            handset itself and no account&rsquo;s unban will ever lift it. One marked{' '}
            <strong className="text-slate-200">Account ban</strong> exists because the accounts under{' '}
            <em>Held up by</em> are banned, and it disappears on its own once{' '}
            <strong className="text-slate-200">every one of them</strong> has been unbanned. Lifting
            from here overrides both.
          </p>
        </div>
      </div>

      {/* Device id lookup — a straight yes or no */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 sm:p-5 mb-4">
        <label className="block text-white text-sm font-semibold mb-1">
          Is this device banned?
        </label>
        <p className="text-slate-500 text-xs mb-3">
          Paste the full android id or IMEI. The answer is matched against the whole id, not the
          last four characters.
        </p>
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="e.g. a1b2c3d4e5f60718"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-9 pr-9 py-2.5 text-white text-sm font-mono placeholder-slate-600 focus:outline-none focus:border-pink-500"
          />
          {lookup && (
            <button
              onClick={() => setLookup('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {loading && term && (
          <p className="text-slate-500 text-sm mt-3 flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Reading the ban list…
          </p>
        )}

        {!loading && !error && term && exact && (
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mt-3 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3">
            <div className="flex items-start gap-2 min-w-0">
              <ShieldAlert size={15} className="text-red-400 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-red-200 text-sm font-semibold">
                  Yes — this device is banned.
                </p>
                <p className="text-red-100/90 text-sm mt-0.5">{exact.reason || 'No reason recorded.'}</p>
                <p className="text-slate-400 text-xs mt-1">
                  {exact.deviceType === 'imei' ? 'IMEI' : 'Android id'} · by{' '}
                  {exact.bannedByName || exact.bannedBy || 'unknown'} · {fmt(exact.bannedAt)}
                </p>
                {/* Answering "yes, it is barred" without saying what would
                    release it sends the reader back to the table to work it
                    out. It is the same two facts, in the place they are
                    actually being asked for. */}
                <div className="mt-2">
                  <Origin record={exact} />
                </div>
                <HoldNote record={exact} names={names} className="text-slate-300 text-xs mt-1.5" />
              </div>
            </div>
            <button
              onClick={() => openLift(exact)}
              className="inline-flex items-center gap-1.5 self-start bg-green-500/10 hover:bg-green-500/20 border border-green-500/30 text-green-300 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0"
            >
              <ShieldCheck size={13} /> Lift this ban
            </button>
          </div>
        )}

        {!loading && !error && term && !exact && (
          <div className="flex items-start gap-2 mt-3 bg-slate-950/60 border border-slate-800 rounded-lg px-4 py-3">
            <Check size={15} className="text-green-400 mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="text-white font-semibold">No ban recorded for that id.</p>
              <p className="text-slate-400 mt-0.5">
                The app decides purely by whether a document exists for the id, so this device is not
                blocked.
              </p>
              {partial.length > 0 && (
                <p className="text-amber-300/90 text-xs mt-1.5">
                  {partial.length} banned {partial.length === 1 ? 'id contains' : 'ids contain'} that
                  text — {partial.slice(0, 3).map(idOf).join(', ')}
                  {partial.length > 3 ? '…' : ''}. Check you pasted the whole id.
                </p>
              )}
              {atCap && (
                <p className="text-amber-300/90 text-xs mt-1.5">
                  This is checked against the {LIMIT} bans loaded below, which is the cap — if there
                  are more than {LIMIT} bans, a &ldquo;no&rdquo; here is not conclusive.
                </p>
              )}
            </div>
          </div>
        )}

        {!loading && error && term && (
          <p className="text-red-300 text-sm mt-3">
            The ban list could not be read, so this cannot be answered either way: {error}
          </p>
        )}
      </div>

      <DataTable
        rows={devices}
        columns={columns}
        rowKey={(d) => d.id}
        loading={loading}
        error={error}
        onRetry={load}
        searchPlaceholder="Search by device id, reason or account…"
        // `sourceAccounts` and `userUids` have no column of their own any more —
        // `heldBy` renders one or the other — so both are named here directly.
        // Searching a uid has to find the handsets it is holding barred
        // whichever field that record happens to name it in.
        searchKeys={['deviceId', 'reason', 'heldBy', 'sourceAccounts', 'userUids']}
        exportName="device-bans"
        truncatedAt={LIMIT}
        emptyTitle="No devices are banned"
        emptyHint="Ban a device when an account keeps coming back on the same handset."
      />

      {banOpen && (
        <Modal title="Ban a device" onClose={() => setBanOpen(false)}>
          <div className="px-6 py-5 space-y-4">
            <p className="text-slate-300 text-sm leading-relaxed">
              The ban is stored under the device id itself, which is what the app reads on launch.
              Enter the id exactly — a typo produces a ban that never applies to anybody.
            </p>

            {/* Every ban raised from this screen is an Ops decision by
                construction, and the API marks it so. Worth saying, because it
                is what makes this ban outlast the accounts on the handset —
                before the mark existed, the first unban that came near one of
                these deleted it. */}
            <p className="text-slate-400 text-sm leading-relaxed">
              It is recorded as an <strong className="text-slate-200">Ops decision</strong>: it is
              about the handset, so unbanning any account on it will not lift it. The accounts below
              are recorded as evidence of who was seen on the device, not as a cause.
            </p>

            <Field label="Device id">
              <input
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                autoFocus
                placeholder="The full android id or IMEI"
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm font-mono placeholder-slate-600 focus:outline-none focus:border-pink-500"
              />
            </Field>

            <Field label="Device type">
              <div className="flex gap-2">
                {(['android_id', 'imei'] as DeviceType[]).map((type) => (
                  <button
                    key={type}
                    onClick={() => setDeviceType(type)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                      deviceType === type
                        ? 'bg-pink-500 border-pink-400 text-white'
                        : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    {type === 'android_id' ? 'Android id' : 'IMEI'}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Reason (required)">
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Why this handset is being blocked…"
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
              />
            </Field>

            <Field label="Accounts on this device (optional, comma separated)">
              <input
                value={userUids}
                onChange={(e) => setUserUids(e.target.value)}
                placeholder="uid1, uid2"
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500"
              />
            </Field>

            <FailureNote failure={failure} />
          </div>

          <Actions
            onCancel={() => setBanOpen(false)}
            onConfirm={submitBan}
            busy={busy}
            label="Ban the device"
            icon={<ShieldAlert size={15} />}
          />
        </Modal>
      )}

      {lifting && (
        <Modal title="Lift this device ban" onClose={() => setLifting(null)}>
          <div className="px-6 py-5 space-y-4">
            <p className="text-slate-300 text-sm leading-relaxed">
              The record for{' '}
              <span className="font-mono text-white break-all">{lifting.deviceId || lifting.id}</span>{' '}
              will be <strong className="text-white">deleted</strong>, because the app decides whether
              a device is banned purely by whether that document exists. The audit log keeps the
              history.
            </p>

            {/* What this lift OVERRIDES. `unban_device` is unconditional — it
                deletes the record whatever caused it — which is right for
                somebody standing in front of this list having decided about the
                handset, and wrong to do by accident. An Ops ban and a ban still
                held up by banned accounts are both legitimate to override from
                here; neither should be overridden without being seen. */}
            {lifting.manualBan && (
              <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
                <AlertTriangle size={15} className="text-amber-400 mt-0.5 shrink-0" />
                <p className="text-amber-100 text-sm">
                  This is an <strong>Ops decision about the handset</strong>, not a side effect of
                  banning somebody. It has survived every account unban so far, and nothing but this
                  button will remove it.
                </p>
              </div>
            )}

            {heldBy(lifting).length > 0 && (
              <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
                <UserX size={15} className="text-amber-400 mt-0.5 shrink-0" />
                <div className="text-amber-100 text-sm min-w-0">
                  <p>
                    {heldBy(lifting).length === 1
                      ? 'One account is holding this ban up.'
                      : `${heldBy(lifting).length} accounts are holding this ban up.`}{' '}
                    Lifting here releases the handset{' '}
                    <strong>for all of them, whether or not they are still banned</strong> — their
                    accounts are untouched, but this phone stops blocking them.
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {heldBy(lifting).map((uid) => (
                      <Link
                        key={uid}
                        href={`/users/${uid}`}
                        className="text-[11px] text-amber-200 underline underline-offset-2 hover:text-white break-all"
                      >
                        {nameOrReference(names.get(uid), uid, 'account')}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            )}

            <Field label="Reason (required)">
              <textarea
                value={liftReason}
                onChange={(e) => setLiftReason(e.target.value)}
                rows={3}
                autoFocus
                placeholder="Why the ban is being lifted…"
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500 resize-none"
              />
            </Field>

            <FailureNote failure={failure} />
          </div>

          <Actions
            onCancel={() => setLifting(null)}
            onConfirm={submitLift}
            busy={busy}
            label="Lift the ban"
            icon={<ShieldCheck size={15} />}
          />
        </Modal>
      )}
    </div>
  )
}

function Modal({
  title, onClose, children,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-800">
          <h2 className="text-white font-semibold">{title}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * Which of the two kinds of ban this is.
 *
 * It is one word on screen and it decides everything about how the record ends:
 * an Ops ban outlives every account on the handset, a cascade ban disappears by
 * itself once the accounts that caused it are unbanned. Reading a device ban
 * without it, the only way to find out was to unban somebody and see.
 */
function Origin({ record }: { record: DeviceBanRecord }) {
  return record.manualBan ? (
    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 whitespace-nowrap">
      <ShieldAlert size={11} /> Ops decision
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 whitespace-nowrap">
      <UserX size={11} /> Account ban
    </span>
  )
}

/**
 * Who would have to be unbanned for this handset to come back on its own.
 *
 * The question an operator arrives with is almost never "is this barred" alone
 * — it is "somebody says they cannot sign in, what do I do about it". The
 * answer is one of three, and they are genuinely different: unban these
 * accounts, or unban nobody because Ops decided about the phone, or lift it
 * here because no account is named on the record at all.
 */
function HoldNote({
  record, names, className = '',
}: {
  record: DeviceBanRecord
  names?: ReadonlyMap<string, IdentityFacts>
  className?: string
}) {
  const uids = heldBy(record)
  return (
    <div className={className}>
      {record.manualBan ? (
        <p>
          Ops barred this handset on its own evidence.{' '}
          <strong className="text-white">No account&rsquo;s unban will lift it</strong> — only the
          Lift button on this screen will.
        </p>
      ) : uids.length ? (
        <p>
          It comes off on its own once{' '}
          <strong className="text-white">
            {uids.length === 1
              ? 'this account is unbanned'
              : `all ${uids.length} of these accounts are unbanned`}
          </strong>
          . Until then the handset blocks every account on it, including theirs.
        </p>
      ) : (
        <p>
          No account is named on this record, so no unban can reach it. Lift it from here.
        </p>
      )}
      {uids.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {uids.map((uid) => (
            <Link
              key={uid}
              href={`/users/${uid}`}
              className="text-[11px] text-pink-400 hover:text-pink-300 break-all"
            >
              {nameOrReference(names?.get(uid), uid, 'account')}
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-slate-400 text-xs font-medium mb-1.5">{label}</label>
      {children}
    </div>
  )
}

function FailureNote({ failure }: { failure: Failure | null }) {
  if (!failure) return null
  return (
    <div
      className={`flex items-start gap-2 rounded-lg px-4 py-3 border ${
        failure.isRule ? 'bg-amber-500/10 border-amber-500/30' : 'bg-red-500/10 border-red-500/30'
      }`}
    >
      <AlertTriangle
        size={15}
        className={`mt-0.5 shrink-0 ${failure.isRule ? 'text-amber-400' : 'text-red-400'}`}
      />
      <div className={failure.isRule ? 'text-amber-100 text-sm' : 'text-red-200 text-sm'}>
        <p className="font-medium">{failure.isRule ? 'Refused' : 'Could not complete that'}</p>
        <p className="mt-0.5">{failure.message}</p>
      </div>
    </div>
  )
}

function Actions({
  onCancel, onConfirm, busy, label, icon,
}: {
  onCancel: () => void
  onConfirm: () => void
  busy: boolean
  label: string
  icon: React.ReactNode
}) {
  return (
    <div className="flex gap-3 px-6 py-4 border-t border-slate-800">
      <button
        onClick={onCancel}
        className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
      >
        Cancel
      </button>
      <button
        onClick={onConfirm}
        disabled={busy}
        className="flex-1 flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors"
      >
        {busy ? <><Loader2 size={15} className="animate-spin" /> Working…</> : <>{icon} {label}</>}
      </button>
    </div>
  )
}
